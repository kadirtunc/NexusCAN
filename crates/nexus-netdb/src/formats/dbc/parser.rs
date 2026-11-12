use crate::error::{DiagnosticSeverity, ParseDiagnostic};
use crate::formats::dbc::lexer::{DbcLexer, SpannedToken, Token};
use crate::ir::{
    attrs::{
        AttributeDef, AttributeTargetType, AttributeValue, AttributeValueType, FrameProtocol,
        ValueTable,
    },
    mux::{MuxRange, MuxRole},
    ByteOrder, EcuNode, MessageDef, NetworkDatabase, SignalDef, SignalGroupDef, SignalValueType,
};
use indexmap::IndexMap;
use nexus_core::{CanIdKey, DBC_EXT_ID_FLAG, VECTOR_INDEPENDENT_SIG_MSG_ID};
use smallvec::SmallVec;

pub struct DbcParser<'a> {
    tokens: Vec<SpannedToken>,
    pos: usize,
    db: NetworkDatabase,
    diagnostics: Vec<ParseDiagnostic>,
    fault_tolerant: bool,
    current_master_switch: Option<String>,
    current_sub_switch: Option<String>,
    _phantom: std::marker::PhantomData<&'a ()>,
}

impl<'a> DbcParser<'a> {
    pub fn new(input: &'a str, fault_tolerant: bool) -> Self {
        let mut lexer = DbcLexer::new(input);
        let tokens = lexer.tokenize();
        Self {
            tokens,
            pos: 0,
            db: NetworkDatabase::new("DbcDatabase"),
            diagnostics: Vec::new(),
            fault_tolerant,
            current_master_switch: None,
            current_sub_switch: None,
            _phantom: std::marker::PhantomData,
        }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos).map(|st| &st.token)
    }

    fn peek_spanned(&self) -> Option<&SpannedToken> {
        self.tokens.get(self.pos)
    }

    fn next(&mut self) -> Option<SpannedToken> {
        if self.pos < self.tokens.len() {
            let tok = self.tokens[self.pos].clone();
            self.pos += 1;
            Some(tok)
        } else {
            None
        }
    }

    fn current_line(&self) -> usize {
        self.tokens.get(self.pos).map(|st| st.line).unwrap_or(1)
    }

    fn current_col(&self) -> usize {
        self.tokens.get(self.pos).map(|st| st.col).unwrap_or(1)
    }

    fn add_diag(
        &mut self,
        severity: DiagnosticSeverity,
        code: impl Into<String>,
        msg: impl Into<String>,
    ) {
        let line = self.current_line();
        let col = self.current_col();
        self.diagnostics.push(ParseDiagnostic::new(
            severity,
            code,
            msg,
            Some(line),
            Some(col),
            None,
        ));
    }

    pub fn parse(mut self) -> (NetworkDatabase, Vec<ParseDiagnostic>) {
        let mut current_msg_raw_id: Option<u32> = None;

        while self.pos < self.tokens.len() {
            let tok = match self.peek() {
                Some(t) => t.clone(),
                None => break,
            };

            match tok {
                Token::Word(ref w) => {
                    match w.as_str() {
                        "VERSION" => {
                            self.next();
                            self.parse_version();
                        }
                        "NS_" => {
                            self.next();
                            self.skip_ns_section();
                        }
                        "BS_" => {
                            self.next();
                            self.skip_bs_section();
                        }
                        "BU_" => {
                            self.next();
                            self.parse_bu_section();
                        }
                        "VAL_TABLE_" => {
                            self.next();
                            self.parse_val_table();
                        }
                        "BO_" => {
                            self.next();
                            current_msg_raw_id = self.parse_bo();
                        }
                        "SG_" => {
                            self.next();
                            self.parse_sg(current_msg_raw_id);
                        }
                        "BO_TX_BU_" => {
                            self.next();
                            self.parse_bo_tx_bu();
                        }
                        "CM_" => {
                            self.next();
                            self.parse_cm();
                        }
                        "BA_DEF_" => {
                            self.next();
                            self.parse_ba_def();
                        }
                        "BA_DEF_DEF_" => {
                            self.next();
                            self.parse_ba_def_def();
                        }
                        "BA_" => {
                            self.next();
                            self.parse_ba();
                        }
                        "VAL_" => {
                            self.next();
                            self.parse_val();
                        }
                        "SIG_VALTYPE_" => {
                            self.next();
                            self.parse_sig_valtype();
                        }
                        "SG_MUL_VAL_" => {
                            self.next();
                            self.parse_sg_mul_val();
                        }
                        "SIG_GROUP_" => {
                            self.next();
                            self.parse_sig_group();
                        }
                        "EV_" => {
                            self.next();
                            self.skip_statement();
                        }
                        "BA_DEF_REL_" | "BA_DEF_DEF_REL_" | "BA_REL_" => {
                            self.next();
                            self.skip_statement();
                        }
                        _ => {
                            // Non-fatal unhandled word token
                            self.add_diag(
                                DiagnosticSeverity::Warning,
                                "UNKNOWN_STATEMENT",
                                format!("Unrecognized DBC keyword: {}", w),
                            );
                            self.next();
                            self.skip_statement();
                        }
                    }
                }
                _ => {
                    self.next();
                }
            }
        }

        // Post-parsing pass:
        // 1. Resolve multiplexer switch signals (match switch_signal_name or auto-detect MasterSwitch)
        // 2. Resolve VFrameFormat, GenMsgCycleTime, GenSigStartValue, SystemSignalLongSymbol
        self.post_process();

        (self.db, self.diagnostics)
    }

    fn skip_statement(&mut self) {
        while let Some(tok) = self.next() {
            if tok.token == Token::Semicolon {
                break;
            }
        }
    }

    fn parse_version(&mut self) {
        if let Some(SpannedToken {
            token: Token::QuotedString(v),
            ..
        }) = self.peek_spanned()
        {
            let ver = v.clone();
            self.next();
            self.db.version = Some(ver);
        }
    }

    fn skip_ns_section(&mut self) {
        if matches!(self.peek(), Some(Token::Colon)) {
            self.next();
        }
        while let Some(tok) = self.peek() {
            if let Token::Word(w) = tok {
                if w == "BS_" || w == "BU_" || w == "BO_" || w == "VERSION" {
                    break;
                }
            }
            self.next();
        }
    }

    fn skip_bs_section(&mut self) {
        if matches!(self.peek(), Some(Token::Colon)) {
            self.next();
        }
        while let Some(tok) = self.peek() {
            if let Token::Word(w) = tok {
                if w == "BU_" || w == "BO_" || w == "VERSION" {
                    break;
                }
            }
            self.next();
        }
    }

    fn parse_bu_section(&mut self) {
        if matches!(self.peek(), Some(Token::Colon)) {
            self.next();
        }
        while let Some(tok) = self.peek() {
            match tok {
                Token::Word(w) => {
                    if is_known_dbc_keyword(w) {
                        break;
                    }
                    let node_name = w.clone();
                    self.next();
                    self.db.nodes.entry(node_name.clone()).or_insert(EcuNode {
                        name: node_name,
                        comment: None,
                        attributes: IndexMap::new(),
                    });
                }
                _ => break,
            }
        }
    }

    fn parse_val_table(&mut self) {
        let name = match self.next() {
            Some(SpannedToken {
                token: Token::Word(w),
                ..
            }) => w,
            _ => {
                self.skip_statement();
                return;
            }
        };

        let mut vt = ValueTable::new(name.clone());
        while let Some(tok) = self.peek() {
            if *tok == Token::Semicolon {
                self.next();
                break;
            }
            if let Some(val) = self.parse_signed_int() {
                if let Some(SpannedToken {
                    token: Token::QuotedString(desc),
                    ..
                }) = self.next()
                {
                    vt.insert(val, desc);
                } else {
                    break;
                }
            } else {
                self.next();
            }
        }
        self.db.value_tables.insert(name, vt);
    }

    fn parse_bo(&mut self) -> Option<u32> {
        let bo_line = self
            .tokens
            .get(self.pos.saturating_sub(1))
            .map(|st| st.line)
            .unwrap_or(1);
        let raw_id = match self.parse_raw_id() {
            Some(id) => id,
            None => {
                self.add_diag(
                    DiagnosticSeverity::Error,
                    "MALFORMED_BO",
                    "Expected CAN message ID (<= 32 bits) in BO_ statement",
                );
                // Recover at the next line: BO_ has no terminating ';', so the generic
                // skip-to-semicolon recovery would swallow every following message.
                while self.peek_spanned().is_some_and(|st| st.line == bo_line) {
                    self.next();
                }
                return None;
            }
        };

        let name = match self.next() {
            Some(SpannedToken {
                token: Token::Word(w),
                ..
            }) => w,
            _ => "UnknownMessage".to_string(),
        };

        if matches!(self.peek(), Some(Token::Colon)) {
            self.next();
        }

        // Saturate instead of wrapping: DLC 264 must not silently become 8.
        let dlc = self.parse_u64().map_or(8, sat_u8);

        let transmitter = match self.next() {
            Some(SpannedToken {
                token: Token::Word(w),
                ..
            }) => w,
            _ => "Vector__XXX".to_string(),
        };

        self.current_master_switch = None;
        self.current_sub_switch = None;

        if raw_id == VECTOR_INDEPENDENT_SIG_MSG_ID {
            return Some(raw_id);
        }

        let can_id = if (raw_id & DBC_EXT_ID_FLAG) != 0 {
            CanIdKey::Extended(raw_id & 0x1FFF_FFFF)
        } else {
            CanIdKey::Standard((raw_id & 0x7FF) as u16)
        };

        let protocol = if dlc > 8 {
            FrameProtocol::CanFd
        } else {
            FrameProtocol::ClassicalCan
        };

        let msg = MessageDef {
            can_id,
            name,
            dlc,
            transmitters: if transmitter == "Vector__XXX" {
                Vec::new()
            } else {
                vec![transmitter]
            },
            signals: Vec::new(),
            comment: None,
            protocol,
            expected_cycle_ms: None,
            attributes: IndexMap::new(),
            signal_groups: Vec::new(),
        };

        self.db.messages.insert(can_id, msg);
        Some(raw_id)
    }

    fn parse_sg(&mut self, current_msg_raw_id: Option<u32>) {
        let raw_id = match current_msg_raw_id {
            Some(id) => id,
            None => {
                self.add_diag(
                    DiagnosticSeverity::Warning,
                    "ORPHAN_SG",
                    "Found SG_ statement before any BO_ message definition",
                );
                // SG_ has no terminating ';': drop the rest of this line only.
                let sg_line = self
                    .tokens
                    .get(self.pos.saturating_sub(1))
                    .map(|st| st.line)
                    .unwrap_or(1);
                while self.peek_spanned().is_some_and(|st| st.line == sg_line) {
                    self.next();
                }
                return;
            }
        };

        let sig_name = match self.next() {
            Some(SpannedToken {
                token: Token::Word(w),
                ..
            }) => w,
            _ => {
                self.add_diag(
                    DiagnosticSeverity::Error,
                    "MALFORMED_SG",
                    "Expected signal name in SG_ statement",
                );
                return;
            }
        };

        // Parse optional mux indicator before ':'
        let mut mux_role = MuxRole::Static;
        if let Some(tok) = self.peek() {
            if *tok != Token::Colon {
                if let Some(SpannedToken {
                    token: Token::Word(w),
                    ..
                }) = self.next()
                {
                    if w == "M" {
                        mux_role = MuxRole::MasterSwitch;
                    } else if let Some(stripped) = w.strip_prefix('m') {
                        let is_sub_switch = stripped.ends_with('M');
                        let digits = if is_sub_switch {
                            &stripped[..stripped.len() - 1]
                        } else {
                            stripped
                        };
                        let mux_val = digits.parse::<i64>().unwrap_or(0);
                        let mut ranges = SmallVec::new();
                        ranges.push(MuxRange::single(mux_val));
                        mux_role = MuxRole::Multiplexed {
                            switch_signal_name: String::new(),
                            switch_signal: 0,
                            ranges,
                            is_sub_switch,
                        };
                    }
                }
            }
        }

        match &mut mux_role {
            MuxRole::MasterSwitch => {
                self.current_master_switch = Some(sig_name.clone());
                self.current_sub_switch = None;
            }
            MuxRole::Multiplexed {
                switch_signal_name,
                is_sub_switch: true,
                ..
            } => {
                if switch_signal_name.is_empty() {
                    if let Some(ref m) = self.current_master_switch {
                        *switch_signal_name = m.clone();
                    }
                }
                self.current_sub_switch = Some(sig_name.clone());
            }
            MuxRole::Multiplexed {
                switch_signal_name,
                is_sub_switch: false,
                ..
            } => {
                if switch_signal_name.is_empty() {
                    if let Some(ref sub) = self.current_sub_switch {
                        *switch_signal_name = sub.clone();
                    } else if let Some(ref m) = self.current_master_switch {
                        *switch_signal_name = m.clone();
                    }
                }
            }
            MuxRole::Static => {}
        }

        if matches!(self.peek(), Some(Token::Colon)) {
            self.next();
        }

        // start_bit | bit_len @ byte_order value_type
        // Saturating narrowing: an over-range value must fail bit-plan compilation, never wrap into a
        // plausible in-range coordinate (65541 -> 5).
        let start_bit = self.parse_u64().map_or(0, |v| u16::try_from(v).unwrap_or(u16::MAX));

        if matches!(self.peek(), Some(Token::Pipe)) {
            self.next();
        }

        let bit_len = self.parse_u64().map_or(1, sat_u8);

        if matches!(self.peek(), Some(Token::At)) {
            self.next();
        }

        let byte_order = match self.parse_u64().unwrap_or(1) {
            0 => ByteOrder::BigEndian,
            _ => ByteOrder::LittleEndian,
        };

        let value_type = match self.next() {
            Some(SpannedToken {
                token: Token::Minus,
                ..
            }) => SignalValueType::Signed,
            _ => SignalValueType::Unsigned,
        };

        // (factor, offset)
        if matches!(self.peek(), Some(Token::LParen)) {
            self.next();
        }
        let factor = self.parse_signed_float().unwrap_or(1.0);
        if matches!(self.peek(), Some(Token::Comma)) {
            self.next();
        }
        let offset = self.parse_signed_float().unwrap_or(0.0);
        if matches!(self.peek(), Some(Token::RParen)) {
            self.next();
        }

        // [min|max]
        if matches!(self.peek(), Some(Token::LBracket)) {
            self.next();
        }
        let min = self.parse_signed_float().unwrap_or(0.0);
        if matches!(self.peek(), Some(Token::Pipe)) {
            self.next();
        }
        let max = self.parse_signed_float().unwrap_or(0.0);
        if matches!(self.peek(), Some(Token::RBracket)) {
            self.next();
        }
        if min > max {
            self.add_diag(
                DiagnosticSeverity::Warning,
                "INVERTED_BOUNDS",
                format!(
                    "Signal '{}' has inverted range [{}|{}]; it is normalized to [{}|{}] for TX clamping",
                    sig_name, min, max, max, min
                ),
            );
        }
        if factor == 0.0 || !factor.is_finite() || !offset.is_finite() {
            self.add_diag(
                DiagnosticSeverity::Warning,
                "INVALID_SCALING",
                format!(
                    "Signal '{}' has unusable scaling ({},{}); TX encoding of this signal is refused",
                    sig_name, factor, offset
                ),
            );
        }

        // "unit"
        let unit = match self.next() {
            Some(SpannedToken {
                token: Token::QuotedString(u),
                ..
            }) => u,
            _ => String::new(),
        };

        // Receivers on the same line
        let sg_line = self
            .tokens
            .get(self.pos.saturating_sub(1))
            .map(|st| st.line)
            .unwrap_or(self.current_line());
        let mut receivers = Vec::new();
        while let Some(st) = self.peek_spanned() {
            if st.line != sg_line {
                break;
            }
            match &st.token {
                Token::Word(w) => {
                    if is_known_dbc_keyword(w) {
                        break;
                    }
                    let rec = w.clone();
                    self.next();
                    if rec != "Vector__XXX" {
                        receivers.push(rec);
                    }
                }
                Token::Comma => {
                    self.next();
                }
                _ => break,
            }
        }

        let signal = SignalDef {
            id: 0,
            name: sig_name,
            long_name: None,
            start_bit,
            bit_len,
            byte_order,
            value_type,
            factor,
            offset,
            min,
            max,
            unit,
            receivers,
            mux_role,
            comment: None,
            enum_values: IndexMap::new(),
            initial_value: None,
            attributes: IndexMap::new(),
        };

        if raw_id == VECTOR_INDEPENDENT_SIG_MSG_ID {
            self.db.independent_signals.push(signal);
        } else {
            let can_id = if (raw_id & DBC_EXT_ID_FLAG) != 0 {
                CanIdKey::Extended(raw_id & 0x1FFF_FFFF)
            } else {
                CanIdKey::Standard((raw_id & 0x7FF) as u16)
            };

            let mut warning_diag = None;
            if let Some(msg) = self.db.messages.get_mut(&can_id) {
                // Check if signal bit span exceeds dlc * 8
                let max_payload_bits = (msg.dlc as u16) * 8;
                if start_bit >= max_payload_bits && max_payload_bits > 0 {
                    warning_diag = Some(format!(
                        "Signal '{}' start_bit {} exceeds declared message DLC {} ({} bits)",
                        signal.name, start_bit, msg.dlc, max_payload_bits
                    ));
                }
                msg.signals.push(signal);
            }
            if let Some(w) = warning_diag {
                self.add_diag(
                    DiagnosticSeverity::Warning,
                    "BIT_SPAN_EXCEEDS_DLC",
                    w,
                );
            }
        }
    }

    fn parse_bo_tx_bu(&mut self) {
        let raw_id = match self.parse_raw_id() {
            Some(id) => id,
            None => {
                self.skip_statement();
                return;
            }
        };

        if matches!(self.peek(), Some(Token::Colon)) {
            self.next();
        }

        let can_id = if (raw_id & DBC_EXT_ID_FLAG) != 0 {
            CanIdKey::Extended(raw_id & 0x1FFF_FFFF)
        } else {
            CanIdKey::Standard((raw_id & 0x7FF) as u16)
        };

        let mut transmitters = Vec::new();
        while let Some(tok) = self.peek() {
            if *tok == Token::Semicolon {
                self.next();
                break;
            }
            match tok {
                Token::Word(w) => {
                    let node = w.clone();
                    self.next();
                    if node != "Vector__XXX" {
                        transmitters.push(node);
                    }
                }
                Token::Comma => {
                    self.next();
                }
                _ => {
                    self.next();
                }
            }
        }

        if let Some(msg) = self.db.messages.get_mut(&can_id) {
            for node in transmitters {
                if !msg.transmitters.contains(&node) {
                    msg.transmitters.push(node);
                }
            }
        }
    }

    fn parse_cm(&mut self) {
        let tok = match self.peek() {
            Some(t) => t.clone(),
            None => return,
        };

        match tok {
            Token::QuotedString(comment) => {
                self.next();
                self.db.comment = Some(comment);
                if matches!(self.peek(), Some(Token::Semicolon)) {
                    self.next();
                }
            }
            Token::Word(ref w) => {
                match w.as_str() {
                    "BU_" => {
                        self.next();
                        if let Some(SpannedToken {
                            token: Token::Word(node),
                            ..
                        }) = self.next()
                        {
                            if let Some(SpannedToken {
                                token: Token::QuotedString(comment),
                                ..
                            }) = self.next()
                            {
                                if let Some(n) = self.db.nodes.get_mut(&node) {
                                    n.comment = Some(comment);
                                }
                            }
                        }
                    }
                    "BO_" => {
                        self.next();
                        if let Some(raw_id) = self.parse_raw_id() {
                            if let Some(SpannedToken {
                                token: Token::QuotedString(comment),
                                ..
                            }) = self.next()
                            {
                                let can_id = if (raw_id & DBC_EXT_ID_FLAG) != 0 {
                                    CanIdKey::Extended(raw_id & 0x1FFF_FFFF)
                                } else {
                                    CanIdKey::Standard((raw_id & 0x7FF) as u16)
                                };
                                if let Some(msg) = self.db.messages.get_mut(&can_id) {
                                    msg.comment = Some(comment);
                                }
                            }
                        }
                    }
                    "SG_" => {
                        self.next();
                        if let Some(raw_id) = self.parse_raw_id() {
                            if let Some(SpannedToken {
                                token: Token::Word(sig_name),
                                ..
                            }) = self.next()
                            {
                                if let Some(SpannedToken {
                                    token: Token::QuotedString(comment),
                                    ..
                                }) = self.next()
                                {
                                    if raw_id == VECTOR_INDEPENDENT_SIG_MSG_ID {
                                        if let Some(sig) = self
                                            .db
                                            .independent_signals
                                            .iter_mut()
                                            .find(|s| s.name == sig_name)
                                        {
                                            sig.comment = Some(comment);
                                        }
                                    } else {
                                        let can_id = if (raw_id & DBC_EXT_ID_FLAG) != 0 {
                                            CanIdKey::Extended(raw_id & 0x1FFF_FFFF)
                                        } else {
                                            CanIdKey::Standard((raw_id & 0x7FF) as u16)
                                        };
                                        if let Some(msg) = self.db.messages.get_mut(&can_id) {
                                            if let Some(sig) =
                                                msg.signals.iter_mut().find(|s| s.name == sig_name)
                                            {
                                                sig.comment = Some(comment);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    _ => {
                        self.skip_statement();
                        return;
                    }
                }
                if matches!(self.peek(), Some(Token::Semicolon)) {
                    self.next();
                }
            }
            _ => {
                self.skip_statement();
            }
        }
    }

    fn parse_ba_def(&mut self) {
        let mut target_type = AttributeTargetType::Network;
        if let Some(Token::Word(w)) = self.peek() {
            match w.as_str() {
                "BU_" => {
                    target_type = AttributeTargetType::Node;
                    self.next();
                }
                "BO_" => {
                    target_type = AttributeTargetType::Message;
                    self.next();
                }
                "SG_" => {
                    target_type = AttributeTargetType::Signal;
                    self.next();
                }
                "EV_" => {
                    target_type = AttributeTargetType::EnvVar;
                    self.next();
                }
                _ => {}
            }
        }

        let attr_name = match self.next() {
            Some(SpannedToken {
                token: Token::QuotedString(s),
                ..
            }) => s,
            _ => {
                self.skip_statement();
                return;
            }
        };

        let type_name = match self.next() {
            Some(SpannedToken {
                token: Token::Word(w),
                ..
            }) => w,
            _ => {
                self.skip_statement();
                return;
            }
        };

        let val_type = match type_name.as_str() {
            "INT" => {
                let min = self.parse_signed_int().unwrap_or(0);
                let max = self.parse_signed_int().unwrap_or(0);
                AttributeValueType::Int { min, max }
            }
            "HEX" => {
                let min = self.parse_signed_int().unwrap_or(0);
                let max = self.parse_signed_int().unwrap_or(0);
                AttributeValueType::Hex { min, max }
            }
            "FLOAT" => {
                let min = self.parse_signed_float().unwrap_or(0.0);
                let max = self.parse_signed_float().unwrap_or(0.0);
                AttributeValueType::Float { min, max }
            }
            "STRING" => AttributeValueType::String,
            "ENUM" => {
                let mut values = Vec::new();
                while let Some(tok) = self.peek() {
                    if *tok == Token::Semicolon {
                        break;
                    }
                    match tok {
                        Token::QuotedString(s) => {
                            values.push(s.clone());
                            self.next();
                        }
                        Token::Comma => {
                            self.next();
                        }
                        _ => {
                            self.next();
                        }
                    }
                }
                AttributeValueType::Enum { values }
            }
            _ => AttributeValueType::String,
        };

        if matches!(self.peek(), Some(Token::Semicolon)) {
            self.next();
        }

        self.db.attribute_defs.insert(
            attr_name.clone(),
            AttributeDef {
                name: attr_name,
                target_type,
                value_type: val_type,
                default_value: None,
            },
        );
    }

    fn parse_ba_def_def(&mut self) {
        let attr_name = match self.next() {
            Some(SpannedToken {
                token: Token::QuotedString(s),
                ..
            }) => s,
            _ => {
                self.skip_statement();
                return;
            }
        };

        let default_val = self.parse_attribute_value(&attr_name);
        if let Some(def) = self.db.attribute_defs.get_mut(&attr_name) {
            def.default_value = default_val;
        }

        if matches!(self.peek(), Some(Token::Semicolon)) {
            self.next();
        }
    }

    fn parse_ba(&mut self) {
        let attr_name = match self.next() {
            Some(SpannedToken {
                token: Token::QuotedString(s),
                ..
            }) => s,
            _ => {
                self.skip_statement();
                return;
            }
        };

        let tok = match self.peek() {
            Some(t) => t.clone(),
            None => return,
        };

        match tok {
            Token::Word(ref w) => {
                match w.as_str() {
                    "BU_" => {
                        self.next();
                        let node_name = match self.next() {
                            Some(SpannedToken {
                                token: Token::Word(n),
                                ..
                            }) => n,
                            _ => {
                                self.skip_statement();
                                return;
                            }
                        };
                        if let Some(val) = self.parse_attribute_value(&attr_name) {
                            if let Some(node) = self.db.nodes.get_mut(&node_name) {
                                node.attributes.insert(attr_name, val);
                            }
                        }
                    }
                    "BO_" => {
                        self.next();
                        let raw_id = match self.parse_raw_id() {
                            Some(id) => id,
                            None => {
                                self.skip_statement();
                                return;
                            }
                        };
                        if let Some(val) = self.parse_attribute_value(&attr_name) {
                            let can_id = if (raw_id & DBC_EXT_ID_FLAG) != 0 {
                                CanIdKey::Extended(raw_id & 0x1FFF_FFFF)
                            } else {
                                CanIdKey::Standard((raw_id & 0x7FF) as u16)
                            };
                            if let Some(msg) = self.db.messages.get_mut(&can_id) {
                                msg.attributes.insert(attr_name, val);
                            }
                        }
                    }
                    "SG_" => {
                        self.next();
                        let raw_id = match self.parse_raw_id() {
                            Some(id) => id,
                            None => {
                                self.skip_statement();
                                return;
                            }
                        };
                        let sig_name = match self.next() {
                            Some(SpannedToken {
                                token: Token::Word(s),
                                ..
                            }) => s,
                            _ => {
                                self.skip_statement();
                                return;
                            }
                        };
                        if let Some(val) = self.parse_attribute_value(&attr_name) {
                            if raw_id == VECTOR_INDEPENDENT_SIG_MSG_ID {
                                if let Some(sig) = self
                                    .db
                                    .independent_signals
                                    .iter_mut()
                                    .find(|s| s.name == sig_name)
                                {
                                    sig.attributes.insert(attr_name, val);
                                }
                            } else {
                                let can_id = if (raw_id & DBC_EXT_ID_FLAG) != 0 {
                                    CanIdKey::Extended(raw_id & 0x1FFF_FFFF)
                                } else {
                                    CanIdKey::Standard((raw_id & 0x7FF) as u16)
                                };
                                if let Some(msg) = self.db.messages.get_mut(&can_id) {
                                    if let Some(sig) =
                                        msg.signals.iter_mut().find(|s| s.name == sig_name)
                                    {
                                        sig.attributes.insert(attr_name, val);
                                    }
                                }
                            }
                        }
                    }
                    _ => {
                        // Network attribute
                        if let Some(val) = self.parse_attribute_value(&attr_name) {
                            self.db.network_attributes.insert(attr_name, val);
                        }
                    }
                }
            }
            _ => {
                // Network attribute value
                if let Some(val) = self.parse_attribute_value(&attr_name) {
                    self.db.network_attributes.insert(attr_name, val);
                }
            }
        }

        if matches!(self.peek(), Some(Token::Semicolon)) {
            self.next();
        }
    }

    fn parse_attribute_value(&mut self, attr_name: &str) -> Option<AttributeValue> {
        let def = self.db.attribute_defs.get(attr_name);
        let enum_values = def.and_then(|d| match &d.value_type {
            AttributeValueType::Enum { values } => Some(values.clone()),
            _ => None,
        });

        if let Some(tok) = self.peek() {
            match tok {
                Token::QuotedString(s) => {
                    let s = s.clone();
                    self.next();
                    Some(AttributeValue::String(s))
                }
                Token::Float(_) | Token::Int(_) | Token::Minus | Token::Plus => {
                    if let Some(f) = self.parse_signed_float() {
                        if let Some(enum_vals) = enum_values {
                            let idx = f as usize;
                            let label = enum_vals.get(idx).cloned().unwrap_or_default();
                            Some(AttributeValue::Enum { index: idx, label })
                        } else if f.fract() == 0.0 {
                            Some(AttributeValue::Int(f as i64))
                        } else {
                            Some(AttributeValue::Float(f))
                        }
                    } else {
                        None
                    }
                }
                Token::Word(w) => {
                    let w = w.clone();
                    self.next();
                    Some(AttributeValue::String(w))
                }
                _ => None,
            }
        } else {
            None
        }
    }

    fn parse_val(&mut self) {
        let raw_id = match self.parse_raw_id() {
            Some(id) => id,
            None => {
                self.skip_statement();
                return;
            }
        };

        let sig_name = match self.next() {
            Some(SpannedToken {
                token: Token::Word(w),
                ..
            }) => w,
            _ => {
                self.skip_statement();
                return;
            }
        };

        let mut entries = IndexMap::new();
        while let Some(tok) = self.peek() {
            if *tok == Token::Semicolon {
                self.next();
                break;
            }
            if let Some(val) = self.parse_signed_int() {
                if let Some(SpannedToken {
                    token: Token::QuotedString(desc),
                    ..
                }) = self.next()
                {
                    entries.insert(val, desc);
                } else {
                    break;
                }
            } else {
                self.next();
            }
        }

        if raw_id == VECTOR_INDEPENDENT_SIG_MSG_ID {
            if let Some(sig) = self
                .db
                .independent_signals
                .iter_mut()
                .find(|s| s.name == sig_name)
            {
                sig.enum_values = entries;
            }
        } else {
            let can_id = if (raw_id & DBC_EXT_ID_FLAG) != 0 {
                CanIdKey::Extended(raw_id & 0x1FFF_FFFF)
            } else {
                CanIdKey::Standard((raw_id & 0x7FF) as u16)
            };

            let mut warning_diag = None;
            if let Some(msg) = self.db.messages.get_mut(&can_id) {
                if let Some(sig) = msg.signals.iter_mut().find(|s| s.name == sig_name) {
                    sig.enum_values = entries;
                } else if self.fault_tolerant {
                    warning_diag = Some(format!(
                        "VAL_ statement referenced unknown signal '{}' in message {:?}",
                        sig_name, can_id
                    ));
                }
            }
            if let Some(w) = warning_diag {
                self.add_diag(
                    DiagnosticSeverity::Warning,
                    "VAL_SIGNAL_NOT_FOUND",
                    w,
                );
            }
        }
    }

    fn parse_sig_valtype(&mut self) {
        let raw_id = match self.parse_raw_id() {
            Some(id) => id,
            None => {
                self.skip_statement();
                return;
            }
        };

        let sig_name = match self.next() {
            Some(SpannedToken {
                token: Token::Word(w),
                ..
            }) => w,
            _ => {
                self.skip_statement();
                return;
            }
        };

        if matches!(self.peek(), Some(Token::Colon)) {
            self.next();
        }

        let type_code = self.parse_u64().unwrap_or(0);
        if matches!(self.peek(), Some(Token::Semicolon)) {
            self.next();
        }

        let val_type = match type_code {
            1 => SignalValueType::Float32,
            2 => SignalValueType::Float64,
            _ => return,
        };

        if raw_id == VECTOR_INDEPENDENT_SIG_MSG_ID {
            if let Some(sig) = self
                .db
                .independent_signals
                .iter_mut()
                .find(|s| s.name == sig_name)
            {
                sig.value_type = val_type;
            }
        } else {
            let can_id = if (raw_id & DBC_EXT_ID_FLAG) != 0 {
                CanIdKey::Extended(raw_id & 0x1FFF_FFFF)
            } else {
                CanIdKey::Standard((raw_id & 0x7FF) as u16)
            };

            if let Some(msg) = self.db.messages.get_mut(&can_id) {
                if let Some(sig) = msg.signals.iter_mut().find(|s| s.name == sig_name) {
                    sig.value_type = val_type;
                }
            }
        }
    }

    fn parse_sg_mul_val(&mut self) {
        // SG_MUL_VAL_ <raw_id> <muxed_sig> <switch_sig> <range_list> ;
        let raw_id = match self.parse_raw_id() {
            Some(id) => id,
            None => {
                self.skip_statement();
                return;
            }
        };

        let muxed_sig = match self.next() {
            Some(SpannedToken {
                token: Token::Word(w),
                ..
            }) => w,
            _ => {
                self.skip_statement();
                return;
            }
        };

        let switch_sig = match self.next() {
            Some(SpannedToken {
                token: Token::Word(w),
                ..
            }) => w,
            _ => {
                self.skip_statement();
                return;
            }
        };

        let mut ranges: SmallVec<[MuxRange; 2]> = SmallVec::new();
        while let Some(tok) = self.peek() {
            if *tok == Token::Semicolon {
                self.next();
                break;
            }

            if let Some(start) = self.parse_signed_int() {
                let end = if matches!(self.peek(), Some(Token::Minus)) {
                    self.next();
                    self.parse_signed_int().unwrap_or(start)
                } else {
                    start
                };
                ranges.push(MuxRange::new(start, end));
            } else {
                self.next();
            }
        }

        let can_id = if (raw_id & DBC_EXT_ID_FLAG) != 0 {
            CanIdKey::Extended(raw_id & 0x1FFF_FFFF)
        } else {
            CanIdKey::Standard((raw_id & 0x7FF) as u16)
        };

        if let Some(msg) = self.db.messages.get_mut(&can_id) {
            if let Some(sig) = msg.signals.iter_mut().find(|s| s.name == muxed_sig) {
                let is_sub_switch = sig.mux_role.is_switch();
                sig.mux_role = MuxRole::Multiplexed {
                    switch_signal_name: switch_sig,
                    switch_signal: 0,
                    ranges,
                    is_sub_switch,
                };
            }
        }
    }

    fn parse_sig_group(&mut self) {
        let raw_id = match self.parse_raw_id() {
            Some(id) => id,
            None => {
                self.skip_statement();
                return;
            }
        };

        let group_name = match self.next() {
            Some(SpannedToken {
                token: Token::Word(w),
                ..
            }) => w,
            _ => {
                self.skip_statement();
                return;
            }
        };

        let rep = self.parse_u64().map_or(1, |v| u32::try_from(v).unwrap_or(u32::MAX));

        if matches!(self.peek(), Some(Token::Colon)) {
            self.next();
        }

        let mut sigs = Vec::new();
        while let Some(tok) = self.peek() {
            if *tok == Token::Semicolon {
                self.next();
                break;
            }
            if let Some(SpannedToken {
                token: Token::Word(w),
                ..
            }) = self.next()
            {
                sigs.push(w);
            }
        }

        let grp = SignalGroupDef {
            name: group_name,
            group_id: rep,
            signals: sigs,
        };

        let can_id = if (raw_id & DBC_EXT_ID_FLAG) != 0 {
            CanIdKey::Extended(raw_id & 0x1FFF_FFFF)
        } else {
            CanIdKey::Standard((raw_id & 0x7FF) as u16)
        };

        if let Some(msg) = self.db.messages.get_mut(&can_id) {
            msg.signal_groups.push(grp);
        } else {
            self.db.signal_groups.push(grp);
        }
    }

    fn parse_u64(&mut self) -> Option<u64> {
        if let Some(tok) = self.peek() {
            match tok {
                Token::Int(i) => {
                    let v = *i;
                    self.next();
                    Some(v)
                }
                Token::Word(w) => {
                    if let Ok(v) = w.parse::<u64>() {
                        self.next();
                        Some(v)
                    } else {
                        None
                    }
                }
                _ => None,
            }
        } else {
            None
        }
    }

    /// Parses a DBC raw message ID. IDs that do not fit 32 bits are rejected (None) rather than truncated,
    /// which would alias them onto an unrelated message.
    fn parse_raw_id(&mut self) -> Option<u32> {
        let v = self.parse_u64()?;
        u32::try_from(v).ok()
    }

    fn parse_signed_int(&mut self) -> Option<i64> {
        let mut sign = 1i64;
        if let Some(tok) = self.peek() {
            if *tok == Token::Minus {
                sign = -1;
                self.next();
            } else if *tok == Token::Plus {
                self.next();
            }
        }

        if let Some(tok) = self.peek() {
            match tok {
                // Widen to i128 before applying the sign: `-9223372036854775808` arrives as
                // `Minus, Int(9223372036854775808)` and `(2^63 as i64) * -1` overflows (LOW-02).
                // Values outside i64 are rejected (None) instead of wrapping (u64::MAX must not become -1).
                Token::Int(i) => {
                    let v = i64::try_from(i128::from(*i) * i128::from(sign)).ok();
                    self.next();
                    v
                }
                Token::Float(f) => {
                    let v = if f.is_finite() && f.abs() < 9.3e18 {
                        i64::try_from((*f as i128) * i128::from(sign)).ok()
                    } else {
                        None
                    };
                    self.next();
                    v
                }
                Token::Word(w) => {
                    if let Ok(v) = w.parse::<i64>() {
                        self.next();
                        v.checked_mul(sign)
                    } else {
                        None
                    }
                }
                _ => None,
            }
        } else {
            None
        }
    }

    fn parse_signed_float(&mut self) -> Option<f64> {
        let mut sign = 1.0f64;
        if let Some(tok) = self.peek() {
            if *tok == Token::Minus {
                sign = -1.0;
                self.next();
            } else if *tok == Token::Plus {
                self.next();
            }
        }

        if let Some(tok) = self.peek() {
            match tok {
                Token::Float(f) => {
                    let v = *f * sign;
                    self.next();
                    Some(v)
                }
                Token::Int(i) => {
                    let v = (*i as f64) * sign;
                    self.next();
                    Some(v)
                }
                Token::Word(w) => {
                    if let Ok(v) = w.parse::<f64>() {
                        self.next();
                        Some(v * sign)
                    } else {
                        None
                    }
                }
                _ => None,
            }
        } else {
            None
        }
    }

    fn post_process(&mut self) {
        for msg in self.db.messages.values_mut() {
            // Find master switch signal name if any
            let master_switch_name = msg
                .signals
                .iter()
                .find(|s| s.mux_role == MuxRole::MasterSwitch)
                .map(|s| s.name.clone());

            // If multiplexed signals do not specify switch_signal_name, link to master switch
            if let Some(ref m_name) = master_switch_name {
                for sig in msg.signals.iter_mut() {
                    if let MuxRole::Multiplexed {
                        ref mut switch_signal_name,
                        ..
                    } = sig.mux_role
                    {
                        if switch_signal_name.is_empty() {
                            *switch_signal_name = m_name.clone();
                        }
                    }
                }
            }

            // Extract GenMsgCycleTime
            if let Some(attr) = msg.attributes.get("GenMsgCycleTime") {
                if let Some(cycle) = attr.as_i64() {
                    if cycle > 0 {
                        msg.expected_cycle_ms = u32::try_from(cycle).ok();
                    }
                }
            }

            // Extract VFrameFormat
            if let Some(attr) = msg.attributes.get("VFrameFormat") {
                let fmt_str = attr.as_str().unwrap_or_default();
                if fmt_str.contains("CAN_FD") || fmt_str.contains("CANFD") {
                    msg.protocol = FrameProtocol::CanFd;
                } else if fmt_str.contains("J1939") || fmt_str == "FEFF" {
                    msg.protocol = FrameProtocol::J1939Pg;
                }
            }

            // If DLC > 8, protocol is definitely CanFd
            if msg.dlc > 8 {
                msg.protocol = FrameProtocol::CanFd;
            }

            // Extract signal-level attributes (GenSigStartValue, SystemSignalLongSymbol)
            for sig in msg.signals.iter_mut() {
                if let Some(attr) = sig.attributes.get("GenSigStartValue") {
                    if let Some(v) = attr.as_f64() {
                        sig.initial_value = Some(v * sig.factor + sig.offset);
                    }
                }
                if let Some(attr) = sig.attributes.get("SystemSignalLongSymbol") {
                    if let Some(s) = attr.as_str() {
                        sig.long_name = Some(s.to_string());
                    }
                }
            }
        }

        // Also scale independent signals
        for sig in self.db.independent_signals.iter_mut() {
            if let Some(attr) = sig.attributes.get("GenSigStartValue") {
                if let Some(v) = attr.as_f64() {
                    sig.initial_value = Some(v * sig.factor + sig.offset);
                }
            }
            if let Some(attr) = sig.attributes.get("SystemSignalLongSymbol") {
                if let Some(s) = attr.as_str() {
                    sig.long_name = Some(s.to_string());
                }
            }
        }
    }
}

#[inline]
fn sat_u8(v: u64) -> u8 {
    u8::try_from(v).unwrap_or(u8::MAX)
}

fn is_known_dbc_keyword(w: &str) -> bool {
    matches!(
        w,
        "VERSION"
            | "NS_"
            | "BS_"
            | "BU_"
            | "VAL_TABLE_"
            | "BO_"
            | "SG_"
            | "BO_TX_BU_"
            | "CM_"
            | "BA_DEF_"
            | "BA_DEF_DEF_"
            | "BA_"
            | "VAL_"
            | "SIG_VALTYPE_"
            | "SG_MUL_VAL_"
            | "SIG_GROUP_"
            | "EV_"
            | "BA_DEF_REL_"
            | "BA_DEF_DEF_REL_"
            | "BA_REL_"
    )
}
