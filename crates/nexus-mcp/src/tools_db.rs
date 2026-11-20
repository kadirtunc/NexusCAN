//! Read-only signal database tools (`db_*`). Pure functions over a [`CompiledDatabase`] so they
//! can be unit-tested without an HTTP server.

use crate::util::{
    can_key, clip, echo, fit_array, fmt_key, hex_upper, parse_data_hex, parse_id, round, ToolError,
    ToolResult, COMMENT_CLIP_CHARS, TRIM_BUDGET_BYTES,
};
use nexus_netdb::{
    ByteOrder, CompiledDatabase, CompiledMessage, CompiledSignal, DatabaseInfoDto,
    DecodedSignalSample, FrameProtocol, MuxRange, MuxRole, SignalValueType,
};
use serde_json::{json, Map, Value};

pub const NO_DB_MESSAGE: &str =
    "No signal database is loaded in NexusCAN. Ask the user to load a .dbc or .kcd file in the app (Database panel) first.";

fn no_db() -> ToolError {
    ToolError::new(NO_DB_MESSAGE)
}

fn byte_order_str(b: &ByteOrder) -> &'static str {
    match b {
        ByteOrder::LittleEndian => "intel",
        ByteOrder::BigEndian => "motorola",
    }
}

fn value_type_str(t: &SignalValueType) -> &'static str {
    match t {
        SignalValueType::Unsigned => "unsigned",
        SignalValueType::Signed => "signed",
        SignalValueType::Float32 => "float32",
        SignalValueType::Float64 => "float64",
    }
}

fn protocol_str(p: &FrameProtocol) -> &'static str {
    match p {
        FrameProtocol::ClassicalCan => "classical_can",
        FrameProtocol::CanFd => "can_fd",
        FrameProtocol::J1939Pg => "j1939",
    }
}

fn ranges_str(ranges: &[MuxRange]) -> String {
    ranges
        .iter()
        .map(|r| {
            if r.start == r.end {
                r.start.to_string()
            } else {
                format!("{}-{}", r.start, r.end)
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn mux_json(role: &MuxRole) -> Value {
    match role {
        MuxRole::Static => json!({ "role": "static" }),
        MuxRole::MasterSwitch => json!({ "role": "switch" }),
        MuxRole::Multiplexed {
            switch_signal_name,
            ranges,
            is_sub_switch,
            ..
        } => json!({
            "role": "multiplexed",
            "switch": switch_signal_name,
            "switch_values": ranges_str(ranges),
            "is_sub_switch": is_sub_switch,
        }),
    }
}

/// Compact signal descriptor. `msg` adds the parent message name + ID (search results).
pub fn signal_json(sig: &CompiledSignal, msg: Option<&CompiledMessage>) -> Value {
    let mut o = Map::new();
    o.insert("name".into(), json!(sig.name));
    if let Some(m) = msg {
        o.insert("message".into(), json!(m.name));
        o.insert("arb_id".into(), json!(fmt_key(m.can_id)));
        o.insert("is_extended".into(), json!(m.can_id.is_extended()));
    }
    if let Some(ln) = &sig.long_name {
        o.insert("long_name".into(), json!(ln));
    }
    o.insert("unit".into(), json!(sig.unit));
    o.insert("factor".into(), json!(sig.factor));
    o.insert("offset".into(), json!(sig.offset));
    o.insert("min".into(), json!(sig.min));
    o.insert("max".into(), json!(sig.max));
    o.insert("has_bounds".into(), json!(sig.has_bounds));
    o.insert("start_bit".into(), json!(sig.start_bit));
    o.insert("length".into(), json!(sig.bit_len));
    o.insert("byte_order".into(), json!(byte_order_str(&sig.byte_order)));
    o.insert("value_type".into(), json!(value_type_str(&sig.value_type)));
    o.insert("signed".into(), json!(sig.value_type.is_signed()));
    o.insert("float".into(), json!(sig.value_type.is_float()));
    o.insert("mux".into(), mux_json(&sig.mux_role));
    o.insert("has_enum".into(), json!(sig.has_enum_table));
    if sig.has_enum_table {
        o.insert("enum_count".into(), json!(sig.enum_values.len()));
    }
    if let Some(c) = sig.comment.as_deref().filter(|c| !c.trim().is_empty()) {
        o.insert("comment".into(), json!(clip(c.trim(), COMMENT_CLIP_CHARS)));
    }
    Value::Object(o)
}

/// `db_info`
pub fn db_info(db: Option<&CompiledDatabase>, info: Option<&DatabaseInfoDto>) -> Value {
    let Some(db) = db else {
        return json!({ "loaded": false, "message": NO_DB_MESSAGE });
    };
    let raw = &db.raw_database;
    let fd = db
        .messages
        .iter()
        .filter(|m| m.protocol.is_can_fd() || m.dlc > 8)
        .count();
    let ext = db
        .messages
        .iter()
        .filter(|m| m.can_id.is_extended())
        .count();
    let muxed = db.messages.iter().filter(|m| m.mux_tree.is_some()).count();
    let enums = db.signals.iter().filter(|s| s.has_enum_table).count();
    let ecus: Vec<&str> = raw.nodes.keys().map(String::as_str).take(64).collect();
    let mut v = json!({
        "loaded": true,
        "name": info.map(|i| i.name.clone()).unwrap_or_else(|| raw.name.clone()),
        "version": info.and_then(|i| i.version.clone()).or_else(|| raw.version.clone()),
        "format": info.map(|i| i.format.clone()),
        "source_encoding": info.map(|i| i.source_encoding.clone()),
        "ecu_count": raw.nodes.len(),
        "message_count": db.messages.len(),
        "signal_count": db.total_signals,
        "can_fd_message_count": fd,
        "extended_id_message_count": ext,
        "multiplexed_message_count": muxed,
        "enum_signal_count": enums,
        "ecus": ecus,
    });
    if let Some(i) = info {
        let warnings: Vec<Value> = i
            .diagnostics
            .iter()
            .take(10)
            .map(|d| {
                json!(clip(
                    &format!("{:?} {}: {}", d.severity, d.code, d.message),
                    200
                ))
            })
            .collect();
        v["diagnostic_count"] = json!(i.diagnostics.len());
        v["diagnostics_sample"] = json!(warnings);
    }
    if let Some(c) = raw.comment.as_deref().filter(|c| !c.trim().is_empty()) {
        v["comment"] = json!(clip(c.trim(), COMMENT_CLIP_CHARS));
    }
    v
}

/// `db_search_signals`
pub fn db_search_signals(db: Option<&CompiledDatabase>, query: &str, limit: u32) -> ToolResult {
    let db = db.ok_or_else(no_db)?;
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Err(ToolError::new("query must not be empty"));
    }
    let limit = limit.clamp(1, 50) as usize;
    // (rank, message index, signal index): lower rank = better match.
    let mut hits: Vec<(u8, usize, usize)> = Vec::new();
    for (mi, msg) in db.messages.iter().enumerate() {
        let msg_hit = msg.name.to_lowercase().contains(&q);
        for (si, sig) in msg.all_signals.iter().enumerate() {
            let name = sig.name.to_lowercase();
            let rank = if name == q {
                0
            } else if name.starts_with(&q) {
                1
            } else if name.contains(&q) {
                2
            } else if sig
                .long_name
                .as_deref()
                .is_some_and(|l| l.to_lowercase().contains(&q))
            {
                3
            } else if msg_hit {
                4
            } else if sig
                .comment
                .as_deref()
                .is_some_and(|c| c.to_lowercase().contains(&q))
            {
                5
            } else {
                continue;
            };
            hits.push((rank, mi, si));
        }
    }
    hits.sort_by_key(|h| h.0);
    let total = hits.len();
    let results: Vec<Value> = hits
        .iter()
        .take(limit)
        .map(|&(_, mi, si)| {
            let m = &db.messages[mi];
            signal_json(&m.all_signals[si], Some(m))
        })
        .collect();
    let returned = results.len();
    let mut v = json!({
        "query": echo(query),
        "total_matches": total,
        "returned": returned,
        "results": results,
        "truncated": total > returned,
    });
    fit_array(&mut v, "/results", TRIM_BUDGET_BYTES);
    Ok(v)
}

/// Finds a message by ID (tries standard first for IDs `<= 0x7FF`, then extended) or by name.
pub fn find_message<'a>(
    db: &'a CompiledDatabase,
    id: Option<&str>,
    name: Option<&str>,
) -> Result<&'a CompiledMessage, ToolError> {
    if let Some(id_s) = id.filter(|s| !s.trim().is_empty()) {
        let parsed = parse_id(id_s)?;
        let id = parsed.id;
        // Same extended rule as db_decode_frame / trace_query: > 0x7FF or 8 hex digits =>
        // extended only; otherwise standard first, then the extended twin.
        let candidates = if parsed.is_extended(None) {
            vec![can_key(id, Some(true))?]
        } else {
            vec![can_key(id, Some(false))?, can_key(id, Some(true))?]
        };
        for key in candidates {
            if let Some(m) = db.message_index.get(&key).map(|&i| &db.messages[i]) {
                return Ok(m);
            }
        }
        return Err(ToolError::new(format!(
            "no message with ID {} in the loaded database",
            echo(id_s)
        )));
    }
    let Some(name) = name.map(str::trim).filter(|s| !s.is_empty()) else {
        return Err(ToolError::new("provide either 'id' or 'name'"));
    };
    if let Some(m) = db.messages.iter().find(|m| m.name == name) {
        return Ok(m);
    }
    let lname = name.to_lowercase();
    if let Some(m) = db.messages.iter().find(|m| m.name.to_lowercase() == lname) {
        return Ok(m);
    }
    let partial: Vec<&CompiledMessage> = db
        .messages
        .iter()
        .filter(|m| m.name.to_lowercase().contains(&lname))
        .collect();
    match partial.as_slice() {
        [one] => Ok(one),
        [] => Err(ToolError::new(format!(
            "no message named '{}' in the loaded database",
            echo(name)
        ))),
        many => Err(ToolError::new(format!(
            "message name '{}' is ambiguous; candidates: {}",
            echo(name),
            many.iter()
                .take(15)
                .map(|m| format!("{} ({})", m.name, fmt_key(m.can_id)))
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

fn mux_summary(db: &CompiledDatabase, msg: &CompiledMessage) -> Value {
    let Some(tree) = &msg.mux_tree else {
        return Value::Null;
    };
    let switch_name = db
        .get_signal(tree.switch_signal_id)
        .map(|s| s.name.clone())
        .unwrap_or_default();
    // Flat summary over all multiplexed signals of this message, grouped by (switch, values).
    let mut groups: Vec<(String, String, Vec<String>)> = Vec::new();
    for sig in &msg.all_signals {
        if let MuxRole::Multiplexed {
            switch_signal_name,
            ranges,
            ..
        } = &sig.mux_role
        {
            let vals = ranges_str(ranges);
            match groups
                .iter_mut()
                .find(|g| g.0 == *switch_signal_name && g.1 == vals)
            {
                Some(g) => g.2.push(sig.name.clone()),
                None => groups.push((switch_signal_name.clone(), vals, vec![sig.name.clone()])),
            }
        }
    }
    let branch_count = groups.len();
    json!({
        "master_switch": switch_name,
        "depth": tree.depth(),
        "branch_count": branch_count,
        "branches": groups
            .into_iter()
            .take(64)
            .map(|(sw, vals, sigs)| json!({ "switch": sw, "values": vals, "signals": sigs }))
            .collect::<Vec<_>>(),
    })
}

/// `db_get_message`
pub fn db_get_message(
    db: Option<&CompiledDatabase>,
    id: Option<&str>,
    name: Option<&str>,
) -> ToolResult {
    let db = db.ok_or_else(no_db)?;
    let msg = find_message(db, id, name)?;
    let signals: Vec<Value> = msg
        .all_signals
        .iter()
        .map(|s| signal_json(s, None))
        .collect();
    let mut v = json!({
        "name": msg.name,
        "arb_id": fmt_key(msg.can_id),
        "is_extended": msg.can_id.is_extended(),
        "dlc": msg.dlc,
        "protocol": protocol_str(&msg.protocol),
        "transmitters": msg.transmitters,
        "cycle_time_ms": msg.expected_cycle_ms,
        "comment": msg.comment.as_deref().map(|c| clip(c.trim(), COMMENT_CLIP_CHARS)),
        "signal_count": msg.all_signals.len(),
        "multiplexing": mux_summary(db, msg),
        "signals": signals,
    });
    fit_array(&mut v, "/signals", TRIM_BUDGET_BYTES);
    if v.get("truncated").is_some() {
        // Branch lists can be large too; drop them before giving up on signals.
        fit_array(&mut v, "/multiplexing/branches", TRIM_BUDGET_BYTES);
    }
    Ok(v)
}

fn empty_sample() -> DecodedSignalSample {
    DecodedSignalSample {
        signal_id: 0,
        raw_bits: 0,
        raw_int: 0,
        physical_value: 0.0,
        out_of_range: false,
        is_mux_switch: false,
    }
}

/// Decodes `payload` for `msg` (`decode_payload_into`) and returns the samples.
pub fn decode_samples(
    db: &CompiledDatabase,
    msg: &CompiledMessage,
    payload: &[u8],
) -> (Vec<DecodedSignalSample>, Vec<(u32, i64)>) {
    let mut out = vec![empty_sample(); msg.all_signals.len().max(1)];
    let mut sw = vec![(0u32, 0i64); 16];
    match db.decode_payload_into(msg.can_id, payload, &mut out, &mut sw) {
        Some(s) => {
            out.truncate(s.decoded_count);
            sw.truncate(s.active_switch_count);
            (out, sw)
        }
        None => (Vec::new(), Vec::new()),
    }
}

/// `db_decode_frame`
pub fn db_decode_frame(
    db: Option<&CompiledDatabase>,
    arb_id: &str,
    is_extended: Option<bool>,
    data_hex: &str,
) -> ToolResult {
    let db = db.ok_or_else(no_db)?;
    let key = parse_id(arb_id)?.key(is_extended)?;
    let payload = parse_data_hex(data_hex)?;
    let Some(msg) = db.get_message(&key) else {
        return Ok(json!({
            "matched": false,
            "arb_id": fmt_key(key),
            "is_extended": key.is_extended(),
            "message": format!("ID {} is not defined in the loaded database", fmt_key(key)),
        }));
    };
    let (samples, switches) = decode_samples(db, msg, &payload);
    let mut warnings: Vec<String> = Vec::new();
    if payload.len() < msg.dlc as usize {
        warnings.push(format!(
            "payload has {} bytes but the message DLC is {}; missing bytes are read as 0",
            payload.len(),
            msg.dlc
        ));
    }
    if payload.len() > 8 && ![12, 16, 20, 24, 32, 48, 64].contains(&payload.len()) {
        warnings.push(format!(
            "{} bytes is not a valid CAN-FD frame length (12/16/20/24/32/48/64)",
            payload.len()
        ));
    }
    let signals: Vec<Value> = samples
        .iter()
        .filter_map(|s| {
            let sig = db.get_signal(s.signal_id)?;
            let mut o = Map::new();
            o.insert("name".into(), json!(sig.name));
            o.insert("value".into(), round(s.physical_value, 9));
            o.insert("unit".into(), json!(sig.unit));
            o.insert("raw".into(), json!(s.raw_int));
            if let Some(label) = sig.enum_values.get(&s.raw_int) {
                o.insert("enum_label".into(), json!(label));
            }
            o.insert("out_of_range".into(), json!(s.out_of_range));
            if s.is_mux_switch {
                o.insert("is_mux_switch".into(), json!(true));
            }
            if sig.bit_span.max_byte as usize >= payload.len() {
                o.insert("beyond_payload".into(), json!(true));
            }
            Some(Value::Object(o))
        })
        .collect();
    let active: Vec<Value> = switches
        .iter()
        .filter_map(|(sid, v)| {
            db.get_signal(*sid)
                .map(|s| json!({ "switch": s.name, "value": v }))
        })
        .collect();
    let mut v = json!({
        "matched": true,
        "message": msg.name,
        "arb_id": fmt_key(msg.can_id),
        "is_extended": msg.can_id.is_extended(),
        "dlc": msg.dlc,
        "data_hex": hex_upper(&payload),
        "active_mux": active,
        "signal_count": signals.len(),
        "signals": signals,
    });
    if !warnings.is_empty() {
        v["warnings"] = json!(warnings);
    }
    fit_array(&mut v, "/signals", TRIM_BUDGET_BYTES);
    Ok(v)
}

/// Resolves `signal` as `Signal` or `Message.Signal` (case-insensitive). Errors on ambiguity.
pub fn find_signal<'a>(
    db: &'a CompiledDatabase,
    signal: &str,
) -> Result<(&'a CompiledMessage, &'a CompiledSignal), ToolError> {
    let s = signal.trim();
    if s.is_empty() {
        return Err(ToolError::new("signal must not be empty"));
    }
    let (msg_filter, sig_name) = match s.split_once('.') {
        Some((m, sname)) if !m.is_empty() && !sname.is_empty() => (Some(m.to_lowercase()), sname),
        _ => (None, s),
    };
    let lsig = sig_name.to_lowercase();
    let mut found: Vec<(&CompiledMessage, &CompiledSignal)> = Vec::new();
    for m in &db.messages {
        if let Some(mf) = &msg_filter {
            if m.name.to_lowercase() != *mf {
                continue;
            }
        }
        for sig in &m.all_signals {
            if sig.name.to_lowercase() == lsig {
                found.push((m, sig));
            }
        }
    }
    match found.as_slice() {
        [one] => Ok(*one),
        [] => Err(ToolError::new(format!(
            "signal '{}' not found in the loaded database; use db_search_signals to find the exact name",
            echo(s)
        ))),
        many => {
            // Prefer an exact-case match if it is unique.
            let exact: Vec<_> = many.iter().filter(|(_, sg)| sg.name == sig_name).collect();
            if exact.len() == 1 {
                return Ok(*exact[0]);
            }
            Err(ToolError::new(format!(
                "signal '{}' exists in several messages; use 'Message.Signal'. Candidates: {}",
                echo(s),
                many.iter()
                    .take(15)
                    .map(|(m, sg)| format!("{}.{}", m.name, sg.name))
                    .collect::<Vec<_>>()
                    .join(", ")
            )))
        }
    }
}

// ─── M1.1: multi-database aware tools ───────────────────────────────────────

use crate::dbsel::{describe, DbScope, DbSet, SelectedDb};
use crate::util::MAX_RESPONSE_BYTES;
use nexus_netdb::DiagnosticSeverity;
use std::collections::BTreeMap;

/// Adds `"database": {scope, bus_id, name}` to an object response.
pub fn with_database(mut v: Value, sel: &SelectedDb<'_>) -> Value {
    if let Some(o) = v.as_object_mut() {
        o.insert("database".into(), sel.describe());
    }
    v
}

fn summary_without_loaded(db: &CompiledDatabase, info: &DatabaseInfoDto) -> Value {
    let mut v = db_info(Some(db), Some(info));
    if let Some(o) = v.as_object_mut() {
        o.remove("loaded");
    }
    v
}

/// `db_info` (M1.1): global database summary plus one summary per bus-bound database.
pub fn db_info_all(set: &DbSet) -> Value {
    if set.is_empty() {
        return json!({ "loaded": false, "message": NO_DB_MESSAGE });
    }
    let buses: Vec<Value> = set
        .buses
        .iter()
        .map(|(b, db, info)| {
            let mut s = summary_without_loaded(db, info);
            s["bus_id"] = json!(b);
            s
        })
        .collect();
    let mut v = json!({
        "loaded": true,
        "global": set.global.as_ref().map(|(db, info)| summary_without_loaded(db, info)),
        "buses": buses,
        "note": "db_* tools use the global database by default; pass bus_id to use a bus-bound database.",
    });
    fit_array(&mut v, "/buses", TRIM_BUDGET_BYTES);
    v
}

fn short_summary(scope: DbScope, db: &CompiledDatabase, info: &DatabaseInfoDto) -> Value {
    let mut d = describe(scope, info);
    d["format"] = json!(info.format);
    d["version"] = json!(info.version);
    d["message_count"] = json!(db.messages.len());
    d["signal_count"] = json!(db.total_signals);
    d["ecu_count"] = json!(db.raw_database.nodes.len());
    d["diagnostic_count"] = json!(info.diagnostics.len());
    d
}

/// `db_list`
pub fn db_list(set: &DbSet, preset_files: &[String]) -> Value {
    let mut loaded: Vec<Value> = Vec::new();
    if let Some((db, info)) = &set.global {
        loaded.push(short_summary(DbScope::Global, db, info));
    }
    for (b, db, info) in &set.buses {
        loaded.push(short_summary(DbScope::Bus(*b), db, info));
    }
    let mut v = json!({
        "loaded_count": loaded.len(),
        "loaded": loaded,
        "preset_files": preset_files,
        "note": "MCP cannot load databases; load them in the NexusCAN UI (Database panel / Connections).",
    });
    fit_array(&mut v, "/loaded", TRIM_BUDGET_BYTES);
    v
}

fn msg_brief(m: &CompiledMessage) -> Value {
    json!({ "name": m.name, "arb_id": fmt_key(m.can_id), "signal_count": m.all_signals.len() })
}

/// `db_get_ecu`
pub fn db_get_ecu(sel: &SelectedDb<'_>, name: &str) -> ToolResult {
    let db = sel.db;
    let lname = name.trim().to_lowercase();
    if lname.is_empty() {
        return Err(ToolError::new("name must not be empty"));
    }
    let Some((ecu_name, node)) = db
        .raw_database
        .nodes
        .iter()
        .find(|(n, _)| n.to_lowercase() == lname)
    else {
        let known: Vec<&str> = db
            .raw_database
            .nodes
            .keys()
            .map(String::as_str)
            .take(30)
            .collect();
        return Err(ToolError::new(format!(
            "no ECU named '{}' in the database; ECUs: [{}]",
            echo(name),
            clip(&known.join(", "), 300)
        )));
    };
    let tx: Vec<Value> = db
        .messages
        .iter()
        .filter(|m| m.transmitters.iter().any(|t| t == ecu_name))
        .map(msg_brief)
        .collect();
    let rx: Vec<Value> = db
        .messages
        .iter()
        .filter(|m| {
            !m.transmitters.iter().any(|t| t == ecu_name)
                && m.all_signals
                    .iter()
                    .any(|s| s.receivers.iter().any(|r| r == ecu_name))
        })
        .map(msg_brief)
        .collect();
    let mut v = json!({
        "name": ecu_name,
        "comment": node.comment.as_deref().map(|c| clip(c.trim(), COMMENT_CLIP_CHARS)),
        "tx_message_count": tx.len(),
        "rx_message_count": rx.len(),
        "tx_messages": tx,
        "rx_messages": rx,
    });
    fit_array(&mut v, "/rx_messages", TRIM_BUDGET_BYTES);
    fit_array(&mut v, "/tx_messages", TRIM_BUDGET_BYTES);
    Ok(with_database(v, sel))
}

fn severity_str(s: &DiagnosticSeverity) -> &'static str {
    match s {
        DiagnosticSeverity::Error => "error",
        DiagnosticSeverity::Warning => "warning",
        DiagnosticSeverity::Info => "info",
    }
}

/// `db_diagnostics`
pub fn db_diagnostics(sel: &SelectedDb<'_>, severity: Option<&str>, limit: u32) -> ToolResult {
    let filter = match severity.map(|s| s.trim().to_ascii_lowercase()) {
        None => None,
        Some(s) if s.is_empty() => None,
        Some(s) if ["error", "warning", "info"].contains(&s.as_str()) => Some(s),
        Some(s) => {
            return Err(ToolError::new(format!(
                "severity must be \"error\", \"warning\" or \"info\" (got '{}')",
                echo(&s)
            )))
        }
    };
    let limit = limit.clamp(1, 50) as usize;
    let all = &sel.info.diagnostics;
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for d in all {
        *counts.entry(severity_str(&d.severity)).or_insert(0) += 1;
    }
    let matching: Vec<_> = all
        .iter()
        .filter(|d| {
            filter
                .as_deref()
                .is_none_or(|f| f == severity_str(&d.severity))
        })
        .collect();
    let items: Vec<Value> = matching
        .iter()
        .take(limit)
        .map(|d| {
            json!({
                "severity": severity_str(&d.severity),
                "code": d.code,
                "message": clip(&d.message, 200),
                "line": d.line,
                "column": d.column,
                "context": d.context.as_deref().map(|c| clip(c, 120)),
            })
        })
        .collect();
    let mut v = json!({
        "total": all.len(),
        "counts": counts,
        "matching": matching.len(),
        "returned": items.len(),
        "truncated": matching.len() > items.len(),
        "diagnostics": items,
    });
    fit_array(&mut v, "/diagnostics", TRIM_BUDGET_BYTES);
    Ok(with_database(v, sel))
}

/// Looks a message up by ID ("0x1A0", "416", "0x000001A0") or by name.
fn find_message_any<'a>(
    db: &'a CompiledDatabase,
    message: &str,
) -> Result<&'a CompiledMessage, ToolError> {
    let m = message.trim();
    let looks_like_id = m.starts_with("0x")
        || m.starts_with("0X")
        || (!m.is_empty() && m.chars().all(|c| c.is_ascii_digit()));
    if looks_like_id {
        find_message(db, Some(m), None)
    } else {
        find_message(db, None, Some(m))
    }
}

/// `db_encode_frame`: packs physical signal values into a payload with the netdb TX encoder.
/// Never transmits.
pub fn db_encode_frame(
    sel: &SelectedDb<'_>,
    message: &str,
    signals: &BTreeMap<String, f64>,
) -> ToolResult {
    let db = sel.db;
    if signals.len() > 64 {
        return Err(ToolError::new("signals accepts at most 64 entries"));
    }
    let msg = find_message_any(db, message)?;
    let mut values: Vec<(u32, f64)> = Vec::with_capacity(signals.len());
    let mut unknown: Vec<String> = Vec::new();
    for (name, &val) in signals {
        let lname = name.to_lowercase();
        match msg
            .all_signals
            .iter()
            .find(|s| s.name == *name)
            .or_else(|| {
                msg.all_signals
                    .iter()
                    .find(|s| s.name.to_lowercase() == lname)
            }) {
            Some(s) => {
                if !val.is_finite() {
                    return Err(ToolError::new(format!(
                        "value for '{}' is not a finite number",
                        s.name
                    )));
                }
                values.push((s.id, val));
            }
            None => unknown.push(echo(name)),
        }
    }
    if !unknown.is_empty() {
        let known: Vec<&str> = msg.all_signals.iter().map(|s| s.name.as_str()).collect();
        return Err(ToolError::new(format!(
            "unknown signal(s) for message {}: [{}]; signals of this message: [{}]",
            msg.name,
            clip(&unknown.join(", "), 200),
            clip(&known.join(", "), 200)
        )));
    }
    let mut buf = [0u8; 64];
    let dlc = db
        .encode_payload_into(msg.can_id, &values, &mut buf)
        .map_err(|e| ToolError::new(format!("cannot encode {}: {e}", msg.name)))?;
    let payload = &buf[..dlc];
    let (samples, switches) = decode_samples(db, msg, payload);

    let mut clamped_names: Vec<String> = Vec::new();
    let rows: Vec<Value> = samples
        .iter()
        .filter_map(|s| {
            let sig = db.get_signal(s.signal_id)?;
            let mut o = Map::new();
            o.insert("name".into(), json!(sig.name));
            o.insert("value".into(), round(s.physical_value, 9));
            o.insert("unit".into(), json!(sig.unit));
            o.insert("raw".into(), json!(s.raw_int));
            if let Some(label) = sig.enum_values.get(&s.raw_int) {
                o.insert("enum_label".into(), json!(label));
            }
            if let Some(&(_, req)) = values.iter().find(|(id, _)| *id == sig.id) {
                o.insert("source".into(), json!("requested"));
                o.insert("requested".into(), json!(req));
                let out_of_range = sig.has_bounds && (req < sig.min - 1e-9 || req > sig.max + 1e-9);
                let tol = if sig.value_type.is_float() {
                    1e-6 * req.abs().max(1.0)
                } else {
                    sig.factor.abs() * 0.5 + 1e-9
                };
                let saturated = (s.physical_value - req).abs() > tol;
                if out_of_range || saturated {
                    o.insert("clamped".into(), json!(true));
                    o.insert(
                        "clamp_reason".into(),
                        json!(if out_of_range {
                            format!("outside [{}, {}]", sig.min, sig.max)
                        } else {
                            "raw bit range / resolution limit".to_string()
                        }),
                    );
                    clamped_names.push(sig.name.clone());
                }
            } else if switches.iter().any(|(id, _)| *id == sig.id) {
                o.insert("source".into(), json!("mux_selector_auto"));
            } else if sig.initial_value.is_some() {
                o.insert("source".into(), json!("initial_value"));
            } else {
                o.insert("source".into(), json!("default_zero"));
            }
            Some(Value::Object(o))
        })
        .collect();
    let active: Vec<Value> = switches
        .iter()
        .filter_map(|(sid, v)| {
            db.get_signal(*sid)
                .map(|s| json!({ "switch": s.name, "value": v }))
        })
        .collect();
    let mut v = json!({
        "transmitted": false,
        "note": "Encoded only. This tool does NOT transmit; nothing was sent to any bus.",
        "message": msg.name,
        "arb_id": fmt_key(msg.can_id),
        "is_extended": msg.can_id.is_extended(),
        "fd": msg.protocol.is_can_fd() || dlc > 8,
        "dlc": dlc,
        "data_hex": hex_upper(payload),
        "active_mux": active,
        "clamped_signals": clamped_names,
        "signals": rows,
    });
    fit_array(&mut v, "/signals", TRIM_BUDGET_BYTES);
    debug_assert!(crate::util::json_len(&v) <= MAX_RESPONSE_BYTES);
    Ok(with_database(v, sel))
}
