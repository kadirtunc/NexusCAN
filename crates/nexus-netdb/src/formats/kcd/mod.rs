use crate::error::{DbError, DbParseError, ParseDiagnostic};
use crate::formats::encoding::decode_text_lossless;
use crate::formats::{
    DatabaseFormatExporter, DatabaseFormatParser, ParseOptions, ParsedDatabaseBundle,
};
use crate::ir::{
    attrs::FrameProtocol,
    mux::{MuxRange, MuxRole},
    ByteOrder, EcuNode, MessageDef, NetworkDatabase, SignalDef, SignalValueType,
};
use indexmap::IndexMap;
use nexus_core::CanIdKey;
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use smallvec::SmallVec;

#[derive(Default, Clone, Copy, Debug)]
pub struct KcdFormat;

impl DatabaseFormatParser for KcdFormat {
    fn format_id(&self) -> &'static str {
        "kcd"
    }

    fn supported_extensions(&self) -> &'static [&'static str] {
        &["kcd", "xml"]
    }

    fn sniff(&self, header_bytes: &[u8]) -> bool {
        let sample = decode_text_lossless(if header_bytes.len() > 1024 {
            &header_bytes[..1024]
        } else {
            header_bytes
        });
        sample.text.contains("<NetworkDefinition") || sample.text.contains("<NetworkDefinition xmlns")
    }

    fn parse(
        &self,
        bytes: &[u8],
        opts: &ParseOptions,
    ) -> Result<ParsedDatabaseBundle, DbParseError> {
        let transcode = decode_text_lossless(bytes);
        let parser = KcdParser::new(&transcode.text, opts.fault_tolerant);
        let (database, mut diagnostics) = parser.parse()?;

        if let Some(diag) = transcode.diagnostic {
            diagnostics.insert(0, diag);
        }

        Ok(ParsedDatabaseBundle {
            database,
            diagnostics,
            format_name: "kcd",
            source_encoding: transcode.encoding_name,
        })
    }
}

impl DatabaseFormatExporter for KcdFormat {
    fn format_id(&self) -> &'static str {
        "kcd"
    }

    fn export(&self, _db: &NetworkDatabase) -> Result<Vec<u8>, DbError> {
        Err(DbError::Generic(
            "Exporting to Kayak .kcd XML format is not yet supported; use .dbc export".to_string(),
        ))
    }
}

struct KcdMuxLevel {
    switch_name: String,
    active_count: Option<i64>,
    pending_switch_sig: Option<SignalDef>,
}

pub struct KcdParser<'a> {
    xml_text: &'a str,
    fault_tolerant: bool,
    db: NetworkDatabase,
    diagnostics: Vec<ParseDiagnostic>,
}

impl<'a> KcdParser<'a> {
    pub fn new(xml_text: &'a str, fault_tolerant: bool) -> Self {
        Self {
            xml_text,
            fault_tolerant,
            db: NetworkDatabase::new("KcdDatabase"),
            diagnostics: Vec::new(),
        }
    }

    pub fn parse(mut self) -> Result<(NetworkDatabase, Vec<ParseDiagnostic>), DbParseError> {
        let mut reader = Reader::from_str(self.xml_text);
        reader.config_mut().trim_text(true);

        let mut node_id_map: IndexMap<String, String> = IndexMap::new();
        let mut current_msg: Option<MessageDef> = None;
        let mut current_signal: Option<SignalDef> = None;
        let mut mux_stack: Vec<KcdMuxLevel> = Vec::new();
        let mut container_state = ContainerState::None;
        let mut text_target: Option<TextTarget> = None;

        let mut buf = Vec::new();

        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(ref e)) => {
                    let tag_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                    match tag_name.as_str() {
                        "NetworkDefinition" => {}
                        "Document" => {
                            for attr in e.attributes().flatten() {
                                let key = String::from_utf8_lossy(attr.key.as_ref());
                                let val = String::from_utf8_lossy(&attr.value);
                                if key == "name" {
                                    self.db.name = val.to_string();
                                } else if key == "version" {
                                    self.db.version = Some(val.to_string());
                                }
                            }
                        }
                        "Node" => {
                            let mut node_id = String::new();
                            let mut node_name = String::new();
                            for attr in e.attributes().flatten() {
                                let key = String::from_utf8_lossy(attr.key.as_ref());
                                let val = String::from_utf8_lossy(&attr.value);
                                if key == "id" {
                                    node_id = val.to_string();
                                } else if key == "name" {
                                    node_name = val.to_string();
                                }
                            }
                            if !node_name.is_empty() {
                                if !node_id.is_empty() {
                                    node_id_map.insert(node_id, node_name.clone());
                                }
                                self.db.nodes.insert(
                                    node_name.clone(),
                                    EcuNode {
                                        name: node_name,
                                        comment: None,
                                        attributes: IndexMap::new(),
                                    },
                                );
                            }
                        }
                        "Message" => {
                            mux_stack.clear();
                            current_msg = self.parse_message_start(e);
                        }
                        "Producer" => {
                            container_state = ContainerState::InProducer;
                        }
                        "Consumer" => {
                            container_state = ContainerState::InConsumer;
                        }
                        "Multiplex" => {
                            let mut m_name = "Mux".to_string();
                            let mut offset: u16 = 0;
                            let mut length: u8 = 8;
                            let mut byte_order = ByteOrder::LittleEndian;
                            for attr in e.attributes().flatten() {
                                let key = String::from_utf8_lossy(attr.key.as_ref());
                                let val = String::from_utf8_lossy(&attr.value);
                                if key == "name" {
                                    m_name = val.to_string();
                                } else if key == "offset" {
                                    offset = val.parse().unwrap_or(0);
                                } else if key == "length" {
                                    length = val.parse().unwrap_or(8);
                                } else if key == "endianess" && val.eq_ignore_ascii_case("big") {
                                    byte_order = ByteOrder::BigEndian;
                                }
                            }

                            let mux_role = if let Some(parent) = mux_stack.last_mut() {
                                if let Some(parent_sw) = parent.pending_switch_sig.take() {
                                    if let Some(ref mut msg) = current_msg {
                                        msg.signals.push(parent_sw);
                                    }
                                }
                                if let Some(parent_count) = parent.active_count {
                                    MuxRole::Multiplexed {
                                        switch_signal_name: parent.switch_name.clone(),
                                        switch_signal: 0,
                                        ranges: smallvec::smallvec![MuxRange::new(
                                            parent_count,
                                            parent_count
                                        )],
                                        is_sub_switch: true,
                                    }
                                } else {
                                    MuxRole::MasterSwitch
                                }
                            } else {
                                MuxRole::MasterSwitch
                            };

                            let switch_sig = SignalDef {
                                id: 0,
                                name: m_name.clone(),
                                long_name: None,
                                start_bit: offset,
                                bit_len: length,
                                byte_order,
                                value_type: SignalValueType::Unsigned,
                                factor: 1.0,
                                offset: 0.0,
                                min: 0.0,
                                max: (1u64.checked_shl(length as u32).unwrap_or(0) as f64).max(1.0)
                                    - 1.0,
                                unit: String::new(),
                                receivers: Vec::new(),
                                mux_role,
                                comment: None,
                                enum_values: IndexMap::new(),
                                initial_value: None,
                                attributes: IndexMap::new(),
                            };

                            mux_stack.push(KcdMuxLevel {
                                switch_name: m_name,
                                active_count: None,
                                pending_switch_sig: Some(switch_sig),
                            });
                        }
                        "MuxGroup" => {
                            if let Some(top) = mux_stack.last_mut() {
                                if let Some(sw_sig) = top.pending_switch_sig.take() {
                                    if let Some(ref mut msg) = current_msg {
                                        msg.signals.push(sw_sig);
                                    }
                                }
                                for attr in e.attributes().flatten() {
                                    let key = String::from_utf8_lossy(attr.key.as_ref());
                                    let val = String::from_utf8_lossy(&attr.value);
                                    if key == "count" {
                                        top.active_count = val.parse().ok();
                                    }
                                }
                            }
                        }
                        "Signal" => {
                            if let Some(top) = mux_stack.last_mut() {
                                if let Some(sw_sig) = top.pending_switch_sig.take() {
                                    if let Some(ref mut msg) = current_msg {
                                        msg.signals.push(sw_sig);
                                    }
                                }
                            }
                            let active_mux_name =
                                mux_stack.last().map(|lvl| lvl.switch_name.as_str());
                            let active_mux_count =
                                mux_stack.last().and_then(|lvl| lvl.active_count);
                            current_signal =
                                self.parse_signal_start(e, active_mux_name, active_mux_count);
                        }
                        "Value" => {
                            if let Some(ref mut sig) = current_signal {
                                Self::apply_value_attrs(sig, e);
                            } else if let Some(sw) = mux_stack
                                .last_mut()
                                .and_then(|lvl| lvl.pending_switch_sig.as_mut())
                            {
                                Self::apply_value_attrs(sw, e);
                            }
                        }
                        "Label" => {
                            if let Some(ref mut sig) = current_signal {
                                Self::apply_label_attrs(sig, e);
                            } else if let Some(sw) = mux_stack
                                .last_mut()
                                .and_then(|lvl| lvl.pending_switch_sig.as_mut())
                            {
                                Self::apply_label_attrs(sw, e);
                            }
                        }
                        "LabelGroup" => {
                            if let Some(ref mut sig) = current_signal {
                                Self::apply_label_group_attrs(sig, e);
                            } else if let Some(sw) = mux_stack
                                .last_mut()
                                .and_then(|lvl| lvl.pending_switch_sig.as_mut())
                            {
                                Self::apply_label_group_attrs(sw, e);
                            }
                        }
                        "NodeRef" => {
                            let pending_sw = mux_stack
                                .last_mut()
                                .and_then(|lvl| lvl.pending_switch_sig.as_mut());
                            Self::handle_noderef(
                                e,
                                &node_id_map,
                                container_state,
                                &mut current_msg,
                                &mut current_signal,
                                pending_sw,
                            );
                        }
                        "Notes" => {
                            text_target = Some(if current_signal.is_some() {
                                TextTarget::Signal
                            } else if mux_stack
                                .last()
                                .and_then(|lvl| lvl.pending_switch_sig.as_ref())
                                .is_some()
                            {
                                TextTarget::MuxSwitch
                            } else {
                                TextTarget::Message
                            });
                        }
                        _ => {}
                    }
                }
                Ok(Event::Empty(ref e)) => {
                    let tag_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                    match tag_name.as_str() {
                        "Node" => {
                            let mut node_id = String::new();
                            let mut node_name = String::new();
                            for attr in e.attributes().flatten() {
                                let key = String::from_utf8_lossy(attr.key.as_ref());
                                let val = String::from_utf8_lossy(&attr.value);
                                if key == "id" {
                                    node_id = val.to_string();
                                } else if key == "name" {
                                    node_name = val.to_string();
                                }
                            }
                            if !node_name.is_empty() {
                                if !node_id.is_empty() {
                                    node_id_map.insert(node_id, node_name.clone());
                                }
                                self.db.nodes.insert(
                                    node_name.clone(),
                                    EcuNode {
                                        name: node_name,
                                        comment: None,
                                        attributes: IndexMap::new(),
                                    },
                                );
                            }
                        }
                        "Signal" => {
                            if let Some(top) = mux_stack.last_mut() {
                                if let Some(sw_sig) = top.pending_switch_sig.take() {
                                    if let Some(ref mut msg) = current_msg {
                                        msg.signals.push(sw_sig);
                                    }
                                }
                            }
                            let active_mux_name =
                                mux_stack.last().map(|lvl| lvl.switch_name.as_str());
                            let active_mux_count =
                                mux_stack.last().and_then(|lvl| lvl.active_count);
                            if let Some(sig) =
                                self.parse_signal_start(e, active_mux_name, active_mux_count)
                            {
                                if let Some(ref mut msg) = current_msg {
                                    msg.signals.push(sig);
                                }
                            }
                        }
                        "Value" => {
                            if let Some(ref mut sig) = current_signal {
                                Self::apply_value_attrs(sig, e);
                            } else if let Some(sw) = mux_stack
                                .last_mut()
                                .and_then(|lvl| lvl.pending_switch_sig.as_mut())
                            {
                                Self::apply_value_attrs(sw, e);
                            }
                        }
                        "Label" => {
                            if let Some(ref mut sig) = current_signal {
                                Self::apply_label_attrs(sig, e);
                            } else if let Some(sw) = mux_stack
                                .last_mut()
                                .and_then(|lvl| lvl.pending_switch_sig.as_mut())
                            {
                                Self::apply_label_attrs(sw, e);
                            }
                        }
                        "LabelGroup" => {
                            if let Some(ref mut sig) = current_signal {
                                Self::apply_label_group_attrs(sig, e);
                            } else if let Some(sw) = mux_stack
                                .last_mut()
                                .and_then(|lvl| lvl.pending_switch_sig.as_mut())
                            {
                                Self::apply_label_group_attrs(sw, e);
                            }
                        }
                        "NodeRef" => {
                            let pending_sw = mux_stack
                                .last_mut()
                                .and_then(|lvl| lvl.pending_switch_sig.as_mut());
                            Self::handle_noderef(
                                e,
                                &node_id_map,
                                container_state,
                                &mut current_msg,
                                &mut current_signal,
                                pending_sw,
                            );
                        }
                        _ => {}
                    }
                }
                Ok(Event::Text(ref e)) => {
                    if let Some(target) = text_target {
                        let text = e.unescape().unwrap_or_default().to_string();
                        match target {
                            TextTarget::Message => {
                                if let Some(ref mut msg) = current_msg {
                                    msg.comment = Some(text);
                                }
                            }
                            TextTarget::MuxSwitch => {
                                if let Some(sw) = mux_stack
                                    .last_mut()
                                    .and_then(|lvl| lvl.pending_switch_sig.as_mut())
                                {
                                    sw.comment = Some(text);
                                }
                            }
                            TextTarget::Signal => {
                                if let Some(ref mut sig) = current_signal {
                                    sig.comment = Some(text);
                                }
                            }
                        }
                    }
                }
                Ok(Event::End(ref e)) => {
                    let tag_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                    match tag_name.as_str() {
                        "Message" => {
                            for mut lvl in mux_stack.drain(..) {
                                if let Some(sw_sig) = lvl.pending_switch_sig.take() {
                                    if let Some(ref mut msg) = current_msg {
                                        msg.signals.push(sw_sig);
                                    }
                                }
                            }
                            if let Some(msg) = current_msg.take() {
                                self.db.messages.insert(msg.can_id, msg);
                            }
                        }
                        "Producer" => {
                            container_state = ContainerState::None;
                        }
                        "Consumer" => {
                            container_state = ContainerState::None;
                        }
                        "Multiplex" => {
                            if let Some(mut popped) = mux_stack.pop() {
                                if let Some(sw_sig) = popped.pending_switch_sig.take() {
                                    if let Some(ref mut msg) = current_msg {
                                        msg.signals.push(sw_sig);
                                    }
                                }
                            }
                        }
                        "MuxGroup" => {
                            if let Some(top) = mux_stack.last_mut() {
                                top.active_count = None;
                            }
                        }
                        "Signal" => {
                            if let Some(sig) = current_signal.take() {
                                if let Some(ref mut msg) = current_msg {
                                    msg.signals.push(sig);
                                }
                            }
                        }
                        "Notes" => {
                            text_target = None;
                        }
                        _ => {}
                    }
                }
                Ok(Event::Eof) => break,
                Err(e) => {
                    if self.fault_tolerant {
                        self.diagnostics.push(ParseDiagnostic::warning(
                            "XML_ERROR",
                            format!("XML syntax warning: {}", e),
                            None,
                            None,
                            None,
                        ));
                        break;
                    } else {
                        return Err(DbParseError::Xml(e.to_string()));
                    }
                }
                _ => {}
            }
            buf.clear();
        }

        Ok((self.db, self.diagnostics))
    }

    fn parse_message_start(&mut self, e: &quick_xml::events::BytesStart) -> Option<MessageDef> {
        let mut id_val: u32 = 0;
        let mut is_extended = false;
        let mut name = "UnknownMessage".to_string();
        let mut length: u8 = 8;
        let mut cycle_time: Option<u32> = None;

        for attr in e.attributes().flatten() {
            let key = String::from_utf8_lossy(attr.key.as_ref());
            let val = String::from_utf8_lossy(&attr.value);
            match key.as_ref() {
                "id" => {
                    if val.starts_with("0x") || val.starts_with("0X") {
                        id_val = u32::from_str_radix(&val[2..], 16).unwrap_or(0);
                    } else {
                        id_val = val.parse().unwrap_or(0);
                    }
                }
                "format" => {
                    if val.eq_ignore_ascii_case("extended") {
                        is_extended = true;
                    }
                }
                "name" => {
                    name = val.to_string();
                }
                "length" => {
                    length = val.parse().unwrap_or(8);
                }
                "interval" => {
                    cycle_time = val.parse().ok();
                }
                _ => {}
            }
        }

        let can_id = if is_extended || id_val > 0x7FF {
            CanIdKey::Extended(id_val & 0x1FFF_FFFF)
        } else {
            CanIdKey::Standard((id_val & 0x7FF) as u16)
        };

        let protocol = if length > 8 {
            FrameProtocol::CanFd
        } else {
            FrameProtocol::ClassicalCan
        };

        Some(MessageDef {
            can_id,
            name,
            dlc: length,
            transmitters: Vec::new(),
            signals: Vec::new(),
            comment: None,
            protocol,
            expected_cycle_ms: cycle_time,
            attributes: IndexMap::new(),
            signal_groups: Vec::new(),
        })
    }

    fn parse_signal_start(
        &self,
        e: &quick_xml::events::BytesStart,
        active_mux_name: Option<&str>,
        active_mux_count: Option<i64>,
    ) -> Option<SignalDef> {
        let mut name = String::new();
        let mut offset: u16 = 0;
        let mut length: u8 = 1;
        let mut byte_order = ByteOrder::LittleEndian;

        for attr in e.attributes().flatten() {
            let key = String::from_utf8_lossy(attr.key.as_ref());
            let val = String::from_utf8_lossy(&attr.value);
            match key.as_ref() {
                "name" => name = val.to_string(),
                "offset" => offset = val.parse().unwrap_or(0),
                "length" => length = val.parse().unwrap_or(1),
                "endianess" if val.eq_ignore_ascii_case("big") => {
                    byte_order = ByteOrder::BigEndian;
                }
                _ => {}
            }
        }

        if name.is_empty() {
            return None;
        }

        let mux_role = if let (Some(m_name), Some(count)) = (active_mux_name, active_mux_count) {
            let mut ranges = SmallVec::new();
            ranges.push(MuxRange::single(count));
            MuxRole::Multiplexed {
                switch_signal_name: m_name.to_string(),
                switch_signal: 0,
                ranges,
                is_sub_switch: false,
            }
        } else {
            MuxRole::Static
        };

        Some(SignalDef {
            id: 0,
            name,
            long_name: None,
            start_bit: offset,
            bit_len: length,
            byte_order,
            value_type: SignalValueType::Unsigned,
            factor: 1.0,
            offset: 0.0,
            min: 0.0,
            max: 0.0,
            unit: String::new(),
            receivers: Vec::new(),
            mux_role,
            comment: None,
            enum_values: IndexMap::new(),
            initial_value: None,
            attributes: IndexMap::new(),
        })
    }

    fn apply_value_attrs(sig: &mut SignalDef, e: &quick_xml::events::BytesStart) {
        for attr in e.attributes().flatten() {
            let key = String::from_utf8_lossy(attr.key.as_ref());
            let val = String::from_utf8_lossy(&attr.value);
            match key.as_ref() {
                "type" => match val.as_ref() {
                    "signed" => sig.value_type = SignalValueType::Signed,
                    "single" => sig.value_type = SignalValueType::Float32,
                    "double" => sig.value_type = SignalValueType::Float64,
                    _ => sig.value_type = SignalValueType::Unsigned,
                },
                "slope" => sig.factor = val.parse().unwrap_or(1.0),
                "intercept" => sig.offset = val.parse().unwrap_or(0.0),
                "unit" => sig.unit = val.to_string(),
                "min" => sig.min = val.parse().unwrap_or(0.0),
                "max" => sig.max = val.parse().unwrap_or(0.0),
                _ => {}
            }
        }
    }

    fn apply_label_attrs(sig: &mut SignalDef, e: &quick_xml::events::BytesStart) {
        let mut name = String::new();
        let mut val: Option<i64> = None;
        for attr in e.attributes().flatten() {
            let key = String::from_utf8_lossy(attr.key.as_ref());
            let v = String::from_utf8_lossy(&attr.value);
            if key == "name" {
                name = v.to_string();
            } else if key == "value" {
                val = v.parse().ok();
            }
        }
        if let (Some(val_num), false) = (val, name.is_empty()) {
            sig.enum_values.insert(val_num, name);
        }
    }

    fn apply_label_group_attrs(sig: &mut SignalDef, e: &quick_xml::events::BytesStart) {
        let mut name = String::new();
        let mut from: Option<i64> = None;
        let mut to: Option<i64> = None;
        for attr in e.attributes().flatten() {
            let key = String::from_utf8_lossy(attr.key.as_ref());
            let v = String::from_utf8_lossy(&attr.value);
            if key == "name" {
                name = v.to_string();
            } else if key == "from" {
                from = v.parse().ok();
            } else if key == "to" {
                to = v.parse().ok();
            }
        }
        if let (Some(f), Some(t)) = (from, to) {
            let (min_val, max_val) = if f <= t { (f, t) } else { (t, f) };
            if (max_val - min_val) <= 64 && !name.is_empty() {
                for val in min_val..=max_val {
                    sig.enum_values.entry(val).or_insert_with(|| name.clone());
                }
            }
        }
    }

    fn handle_noderef(
        e: &quick_xml::events::BytesStart,
        node_id_map: &IndexMap<String, String>,
        container_state: ContainerState,
        current_msg: &mut Option<MessageDef>,
        current_signal: &mut Option<SignalDef>,
        pending_mux_switch: Option<&mut SignalDef>,
    ) {
        let mut node_ref_id = String::new();
        for attr in e.attributes().flatten() {
            if attr.key.as_ref() == b"id" {
                node_ref_id = String::from_utf8_lossy(&attr.value).to_string();
            }
        }
        let node_name = node_id_map
            .get(&node_ref_id)
            .cloned()
            .unwrap_or(node_ref_id);

        match container_state {
            ContainerState::InProducer => {
                if let Some(ref mut msg) = current_msg {
                    if !msg.transmitters.contains(&node_name) {
                        msg.transmitters.push(node_name);
                    }
                }
            }
            ContainerState::InConsumer => {
                if let Some(ref mut sig) = current_signal {
                    if !sig.receivers.contains(&node_name) {
                        sig.receivers.push(node_name);
                    }
                } else if let Some(sw) = pending_mux_switch {
                    if !sw.receivers.contains(&node_name) {
                        sw.receivers.push(node_name);
                    }
                }
            }
            ContainerState::None => {}
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ContainerState {
    None,
    InProducer,
    InConsumer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TextTarget {
    Message,
    MuxSwitch,
    Signal,
}
