use crate::error::DbError;
use crate::ir::{
    attrs::{AttributeTargetType, AttributeValue, AttributeValueType},
    mux::{MuxRange, MuxRole},
    ByteOrder, NetworkDatabase, SignalValueType,
};
use nexus_core::VECTOR_INDEPENDENT_SIG_MSG_ID;
use std::borrow::Cow;
use std::fmt::Write;

/// Canonical Vector .dbc text exporter.
pub struct DbcWriter<'a> {
    db: &'a NetworkDatabase,
    out: String,
}

impl<'a> DbcWriter<'a> {
    pub fn new(db: &'a NetworkDatabase) -> Self {
        Self {
            db,
            out: String::with_capacity(8192),
        }
    }

    pub fn write_to_string(mut self) -> Result<String, DbError> {
        // 1. VERSION
        let ver = self.db.version.as_deref().unwrap_or("");
        writeln!(self.out, "VERSION \"{}\"", esc(ver)).map_err(|e| DbError::Generic(e.to_string()))?;
        self.out.push('\n');

        // 2. NS_ (New Symbols)
        self.out.push_str("NS_ :\n");
        self.out.push_str("\tNS_DESC_\n");
        self.out.push_str("\tCM_\n");
        self.out.push_str("\tBA_DEF_\n");
        self.out.push_str("\tBA_\n");
        self.out.push_str("\tVAL_\n");
        self.out.push_str("\tCAT_DEF_\n");
        self.out.push_str("\tCAT_\n");
        self.out.push_str("\tFILTER\n");
        self.out.push_str("\tBA_DEF_DEF_\n");
        self.out.push_str("\tEV_DATA_\n");
        self.out.push_str("\tENVVAR_DATA_\n");
        self.out.push_str("\tSGTYPE_\n");
        self.out.push_str("\tSGTYPE_VAL_\n");
        self.out.push_str("\tBA_DEF_SGTYPE_\n");
        self.out.push_str("\tBA_SGTYPE_\n");
        self.out.push_str("\tSIG_TYPE_REF_\n");
        self.out.push_str("\tVAL_TABLE_\n");
        self.out.push_str("\tSIG_GROUP_\n");
        self.out.push_str("\tSIG_VALTYPE_\n");
        self.out.push_str("\tSIGTYPE_VALTYPE_\n");
        self.out.push_str("\tBO_TX_BU_\n");
        self.out.push_str("\tBA_DEF_REL_\n");
        self.out.push_str("\tBA_REL_\n");
        self.out.push_str("\tBA_DEF_DEF_REL_\n");
        self.out.push_str("\tBU_SG_REL_\n");
        self.out.push_str("\tBU_EV_REL_\n");
        self.out.push_str("\tBU_BO_REL_\n");
        self.out.push_str("\tSG_MUL_VAL_\n");
        self.out.push('\n');

        // 3. BS_
        self.out.push_str("BS_:\n\n");

        // 4. BU_
        self.out.push_str("BU_:");
        for node_name in self.db.nodes.keys() {
            write!(self.out, " {}", ident(node_name)).map_err(|e| DbError::Generic(e.to_string()))?;
        }
        self.out.push_str("\n\n");

        // 5. VAL_TABLE_
        for vt in self.db.value_tables.values() {
            write!(self.out, "VAL_TABLE_ {}", ident(&vt.name))
                .map_err(|e| DbError::Generic(e.to_string()))?;
            for (val, desc) in &vt.entries {
                write!(self.out, " {} \"{}\"", val, esc(desc))
                    .map_err(|e| DbError::Generic(e.to_string()))?;
            }
            self.out.push_str(" ;\n");
        }
        if !self.db.value_tables.is_empty() {
            self.out.push('\n');
        }

        // 6. BO_ & SG_
        for msg in self.db.messages.values() {
            let raw_id = msg.can_id.to_dbc_raw_id();
            let transmitter = msg
                .transmitters
                .first()
                .map(|s| ident(s))
                .unwrap_or(Cow::Borrowed("Vector__XXX"));
            writeln!(
                self.out,
                "BO_ {} {}: {} {}",
                raw_id,
                ident(&msg.name),
                msg.dlc,
                transmitter
            )
            .map_err(|e| DbError::Generic(e.to_string()))?;

            for sig in &msg.signals {
                let mux_str = match &sig.mux_role {
                    MuxRole::Static => "".to_string(),
                    MuxRole::MasterSwitch => " M".to_string(),
                    MuxRole::Multiplexed {
                        ranges,
                        is_sub_switch,
                        ..
                    } => {
                        let primary_val = ranges.first().map(|r| r.start).unwrap_or(0);
                        if *is_sub_switch {
                            format!(" m{}M", primary_val)
                        } else {
                            format!(" m{}", primary_val)
                        }
                    }
                };

                let bo_char = if sig.byte_order == ByteOrder::LittleEndian {
                    '1'
                } else {
                    '0'
                };
                let vt_char = if sig.value_type == SignalValueType::Signed {
                    '-'
                } else {
                    '+'
                };
                let receivers = if sig.receivers.is_empty() {
                    "Vector__XXX".to_string()
                } else {
                    sig.receivers
                        .iter()
                        .map(|r| ident(r))
                        .collect::<Vec<_>>()
                        .join(",")
                };

                writeln!(
                    self.out,
                    " SG_ {}{} : {}|{}@{}{} ({},{}) [{}|{}] \"{}\" {}",
                    ident(&sig.name),
                    mux_str,
                    sig.start_bit,
                    sig.bit_len,
                    bo_char,
                    vt_char,
                    sig.factor,
                    sig.offset,
                    sig.min,
                    sig.max,
                    esc(&sig.unit),
                    receivers
                )
                .map_err(|e| DbError::Generic(e.to_string()))?;
            }
            self.out.push('\n');
        }

        // Independent signals if any
        if !self.db.independent_signals.is_empty() {
            writeln!(
                self.out,
                "BO_ {} VECTOR__INDEPENDENT_SIG_MSG: 0 Vector__XXX",
                VECTOR_INDEPENDENT_SIG_MSG_ID
            )
            .map_err(|e| DbError::Generic(e.to_string()))?;

            for sig in &self.db.independent_signals {
                let bo_char = if sig.byte_order == ByteOrder::LittleEndian {
                    '1'
                } else {
                    '0'
                };
                let vt_char = if sig.value_type == SignalValueType::Signed {
                    '-'
                } else {
                    '+'
                };
                let receivers = if sig.receivers.is_empty() {
                    "Vector__XXX".to_string()
                } else {
                    sig.receivers
                        .iter()
                        .map(|r| ident(r))
                        .collect::<Vec<_>>()
                        .join(",")
                };

                writeln!(
                    self.out,
                    " SG_ {} : {}|{}@{}{} ({},{}) [{}|{}] \"{}\" {}",
                    ident(&sig.name),
                    sig.start_bit,
                    sig.bit_len,
                    bo_char,
                    vt_char,
                    sig.factor,
                    sig.offset,
                    sig.min,
                    sig.max,
                    esc(&sig.unit),
                    receivers
                )
                .map_err(|e| DbError::Generic(e.to_string()))?;
            }
            self.out.push('\n');
        }

        // 7. BO_TX_BU_
        for msg in self.db.messages.values() {
            if msg.transmitters.len() > 1 {
                let raw_id = msg.can_id.to_dbc_raw_id();
                write!(self.out, "BO_TX_BU_ {} :", raw_id)
                    .map_err(|e| DbError::Generic(e.to_string()))?;
                for tx in &msg.transmitters {
                    write!(self.out, " {}", ident(tx)).map_err(|e| DbError::Generic(e.to_string()))?;
                }
                self.out.push_str(" ;\n");
            }
        }
        self.out.push('\n');

        // 8. CM_ Comments
        if let Some(ref c) = self.db.comment {
            writeln!(self.out, "CM_ \"{}\" ;", esc(c))
                .map_err(|e| DbError::Generic(e.to_string()))?;
        }
        for (node_name, node) in &self.db.nodes {
            if let Some(ref c) = node.comment {
                writeln!(self.out, "CM_ BU_ {} \"{}\" ;", ident(node_name), esc(c))
                    .map_err(|e| DbError::Generic(e.to_string()))?;
            }
        }
        for msg in self.db.messages.values() {
            let raw_id = msg.can_id.to_dbc_raw_id();
            if let Some(ref c) = msg.comment {
                writeln!(self.out, "CM_ BO_ {} \"{}\" ;", raw_id, esc(c))
                    .map_err(|e| DbError::Generic(e.to_string()))?;
            }
            for sig in &msg.signals {
                if let Some(ref c) = sig.comment {
                    writeln!(
                        self.out,
                        "CM_ SG_ {} {} \"{}\" ;",
                        raw_id,
                        ident(&sig.name),
                        esc(c)
                    )
                    .map_err(|e| DbError::Generic(e.to_string()))?;
                }
            }
        }
        self.out.push('\n');

        // 9. BA_DEF_
        for def in self.db.attribute_defs.values() {
            let target_str = match def.target_type {
                AttributeTargetType::Network => "",
                AttributeTargetType::Node => "BU_ ",
                AttributeTargetType::Message => "BO_ ",
                AttributeTargetType::Signal => "SG_ ",
                AttributeTargetType::EnvVar => "EV_ ",
            };

            let type_str = match &def.value_type {
                AttributeValueType::Int { min, max } => format!("INT {} {}", min, max),
                AttributeValueType::Hex { min, max } => format!("HEX {} {}", min, max),
                AttributeValueType::Float { min, max } => format!("FLOAT {} {}", min, max),
                AttributeValueType::String => "STRING".to_string(),
                AttributeValueType::Enum { values } => {
                    let formatted = values
                        .iter()
                        .map(|v| format!("\"{}\"", esc(v)))
                        .collect::<Vec<_>>()
                        .join(",");
                    format!("ENUM {}", formatted)
                }
            };

            writeln!(
                self.out,
                "BA_DEF_ {}\"{}\" {} ;",
                target_str, esc(&def.name), type_str
            )
            .map_err(|e| DbError::Generic(e.to_string()))?;
        }

        // 10. BA_DEF_DEF_
        for def in self.db.attribute_defs.values() {
            if let Some(ref val) = def.default_value {
                let val_str = format_attr_value(val);
                writeln!(self.out, "BA_DEF_DEF_ \"{}\" {} ;", esc(&def.name), val_str)
                    .map_err(|e| DbError::Generic(e.to_string()))?;
            }
        }

        // 11. BA_
        for (name, val) in &self.db.network_attributes {
            writeln!(
                self.out,
                "BA_ \"{}\" {} ;",
                esc(name),
                format_attr_value(val)
            )
            .map_err(|e| DbError::Generic(e.to_string()))?;
        }
        for (node_name, node) in &self.db.nodes {
            for (name, val) in &node.attributes {
                writeln!(
                    self.out,
                    "BA_ \"{}\" BU_ {} {} ;",
                    esc(name),
                    ident(node_name),
                    format_attr_value(val)
                )
                .map_err(|e| DbError::Generic(e.to_string()))?;
            }
        }
        for msg in self.db.messages.values() {
            let raw_id = msg.can_id.to_dbc_raw_id();
            for (name, val) in &msg.attributes {
                writeln!(
                    self.out,
                    "BA_ \"{}\" BO_ {} {} ;",
                    esc(name),
                    raw_id,
                    format_attr_value(val)
                )
                .map_err(|e| DbError::Generic(e.to_string()))?;
            }
            for sig in &msg.signals {
                for (name, val) in &sig.attributes {
                    writeln!(
                        self.out,
                        "BA_ \"{}\" SG_ {} {} {} ;",
                        esc(name),
                        raw_id,
                        ident(&sig.name),
                        format_attr_value(val)
                    )
                    .map_err(|e| DbError::Generic(e.to_string()))?;
                }
            }
        }
        self.out.push('\n');

        // 12. VAL_
        for msg in self.db.messages.values() {
            let raw_id = msg.can_id.to_dbc_raw_id();
            for sig in &msg.signals {
                if !sig.enum_values.is_empty() {
                    write!(self.out, "VAL_ {} {}", raw_id, ident(&sig.name))
                        .map_err(|e| DbError::Generic(e.to_string()))?;
                    for (val, label) in &sig.enum_values {
                        write!(self.out, " {} \"{}\"", val, esc(label))
                            .map_err(|e| DbError::Generic(e.to_string()))?;
                    }
                    self.out.push_str(" ;\n");
                }
            }
        }
        self.out.push('\n');

        // 13. SIG_VALTYPE_
        for msg in self.db.messages.values() {
            let raw_id = msg.can_id.to_dbc_raw_id();
            for sig in &msg.signals {
                match sig.value_type {
                    SignalValueType::Float32 => {
                        writeln!(self.out, "SIG_VALTYPE_ {} {} : 1 ;", raw_id, ident(&sig.name))
                            .map_err(|e| DbError::Generic(e.to_string()))?;
                    }
                    SignalValueType::Float64 => {
                        writeln!(self.out, "SIG_VALTYPE_ {} {} : 2 ;", raw_id, ident(&sig.name))
                            .map_err(|e| DbError::Generic(e.to_string()))?;
                    }
                    _ => {}
                }
            }
        }
        self.out.push('\n');

        // 14. SG_MUL_VAL_ (multi-range or extended multiplexers)
        for msg in self.db.messages.values() {
            let raw_id = msg.can_id.to_dbc_raw_id();
            for sig in &msg.signals {
                if let MuxRole::Multiplexed {
                    ref switch_signal_name,
                    ref ranges,
                    ..
                } = sig.mux_role
                {
                    if ranges.len() > 1 || (ranges.len() == 1 && ranges[0].start != ranges[0].end) {
                        let range_strs = ranges
                            .iter()
                            .map(|r: &MuxRange| format!("{}-{}", r.start, r.end))
                            .collect::<Vec<_>>()
                            .join(", ");
                        writeln!(
                            self.out,
                            "SG_MUL_VAL_ {} {} {} {} ;",
                            raw_id,
                            ident(&sig.name),
                            ident(switch_signal_name),
                            range_strs
                        )
                        .map_err(|e| DbError::Generic(e.to_string()))?;
                    }
                }
            }
        }
        self.out.push('\n');

        // 15. SIG_GROUP_
        for msg in self.db.messages.values() {
            let raw_id = msg.can_id.to_dbc_raw_id();
            for grp in &msg.signal_groups {
                write!(
                    self.out,
                    "SIG_GROUP_ {} {} {} :",
                    raw_id,
                    ident(&grp.name),
                    grp.group_id
                )
                .map_err(|e| DbError::Generic(e.to_string()))?;
                for s in &grp.signals {
                    write!(self.out, " {}", ident(s)).map_err(|e| DbError::Generic(e.to_string()))?;
                }
                self.out.push_str(" ;\n");
            }
        }

        Ok(self.out)
    }
}

/// Escapes a value for use inside a DBC `"..."` string so untrusted text (e.g. from a `.kcd` comment)
/// cannot terminate the string and inject statements. Mirrors the lexer's `\\`, `\"`, `\n`, `\r`.
fn esc(s: &str) -> Cow<'_, str> {
    if !s.contains(['"', '\\', '\n', '\r']) {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            other => out.push(other),
        }
    }
    Cow::Owned(out)
}

/// Sanitizes a DBC identifier (message / signal / node / table / group name). DBC identifiers are
/// C identifiers; any other character (space, `;`, `"`, `:`, newline, ...) from a foreign format is
/// replaced by `_` so it cannot alter statement structure. An empty name becomes `_`.
fn ident(s: &str) -> Cow<'_, str> {
    let valid_first = s
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
    if valid_first && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Cow::Borrowed(s);
    }
    let mut out: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' })
        .collect();
    if !out.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
        out.insert(0, '_');
    }
    Cow::Owned(out)
}

fn format_attr_value(val: &AttributeValue) -> String {
    match val {
        AttributeValue::Int(i) => i.to_string(),
        AttributeValue::Float(f) => f.to_string(),
        AttributeValue::String(s) => format!("\"{}\"", esc(s)),
        AttributeValue::Enum { index, .. } => index.to_string(),
    }
}
