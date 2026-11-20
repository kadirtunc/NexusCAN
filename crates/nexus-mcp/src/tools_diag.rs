//! MCP M3 diagnostics tools (`diag_session_info`, `diag_conversation`, `diag_isotp_frames`,
//! `diag_passive_discovery`) — see planning/contracts/mcp-v1.md §9.
//!
//! Strictly read-only: only the engine's read accessors are used
//! ([`PipelineEngine::diag_session_list`], `cmd_diag_session_info`, `cmd_diag_get_conversation`,
//! `cmd_diag_get_isotp_frames`, `cmd_diag_passive_discovery_snapshot`,
//! [`PipelineEngine::diag_passive_bus_ids`]). None of them opens or closes a session, sends a UDS
//! request or starts / stops a passive scan.
//!
//! SecurityAccess (0x27 / 0x67) and Authentication (0x29 / 0x69) payload bytes beyond
//! SID + subFunction are replaced by `"<redacted>"` (`redacted: true`) in conversation and ISO-TP
//! frame outputs. The redaction cores ([`redact_pdu`], [`redact_isotp_frames`]) work on plain
//! bytes so they can be unit-tested without a live session.

use crate::util::{
    clip, echo, fit_array, fmt_id, hex_upper, parse_id, ToolError, ToolResult, TRIM_BUDGET_BYTES,
};
use nexus_hal::pipeline::diag_session::MAX_DIAG_SESSION_LIST;
use nexus_hal::pipeline::PipelineEngine;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

// ─── Limits ─────────────────────────────────────────────────────────────────

/// Default / max events of `diag_conversation`.
pub const DEFAULT_CONVERSATION_LIMIT: u32 = 50;
pub const MAX_CONVERSATION_LIMIT: u32 = 100;
/// Default / max frames of `diag_isotp_frames`.
pub const DEFAULT_ISOTP_LIMIT: u32 = 100;
pub const MAX_ISOTP_LIMIT: u32 = 200;
/// Max candidate sessions listed in a selector error.
pub const MAX_SELECTOR_CANDIDATES: usize = 8;
/// Max PDU bytes rendered per conversation event (a 4095 / 65535-byte PDU is clipped).
pub const MAX_EVENT_BYTES: usize = 256;
/// Max conversation events fetched to resolve which ISO-TP frames belong to a
/// SecurityAccess / Authentication exchange.
const MAX_REDACTION_LOOKUP: u64 = 2_000;
/// Replacement text for redacted payload bytes.
pub const REDACTED: &str = "<redacted>";

// ─── Tool input schemas ─────────────────────────────────────────────────────

/// Selects one diagnostic session known to the engine. All fields optional; a partial selector
/// that matches exactly one session is accepted.
#[derive(Debug, Default, Clone, Deserialize, JsonSchema)]
pub struct SessionSelector {
    /// Logical bus (0 = Bus 1).
    #[serde(default)]
    pub bus_id: Option<u8>,
    /// Tester -> ECU request CAN ID, e.g. "0x7E0" or "0x18DA10F1".
    #[serde(default)]
    pub request_id: Option<String>,
    /// ECU -> tester response CAN ID, e.g. "0x7E8".
    #[serde(default)]
    pub response_id: Option<String>,
    /// Force 29-bit (true) or 11-bit (false) IDs. Default: IDs above 0x7FF or written with
    /// 8 hex digits are extended; otherwise both kinds match.
    #[serde(default)]
    pub is_extended: Option<bool>,
}

impl SessionSelector {
    pub fn has_addressing(&self) -> bool {
        self.request_id.is_some() || self.response_id.is_some()
    }

    pub fn summary(&self) -> String {
        let o = |v: &Option<String>| v.as_deref().map_or_else(|| "-".to_string(), echo);
        format!(
            "bus={} req={} resp={} ext={}",
            self.bus_id
                .map_or_else(|| "-".to_string(), |b| b.to_string()),
            o(&self.request_id),
            o(&self.response_id),
            self.is_extended
                .map_or_else(|| "-".to_string(), |b| b.to_string())
        )
    }
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct DiagSessionInfoArgs {
    #[serde(flatten)]
    pub selector: SessionSelector,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct DiagConversationArgs {
    #[serde(flatten)]
    pub selector: SessionSelector,
    /// Return events with seq > since_seq (default 0 = from the oldest retained). Pass the
    /// previous response's next_since_seq to page forward.
    #[serde(default)]
    pub since_seq: Option<u64>,
    /// Max events (default 50, max 100).
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct DiagIsoTpFramesArgs {
    #[serde(flatten)]
    pub selector: SessionSelector,
    /// Return frames with seq > since_seq (default 0). Pass next_since_seq to page forward.
    #[serde(default)]
    pub since_seq: Option<u64>,
    /// Max frames (default 100, max 200).
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct DiagPassiveDiscoveryArgs {
    /// Logical bus (0 = Bus 1). Omit for every bus that has a passive scan.
    #[serde(default)]
    pub bus_id: Option<u8>,
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Serde name of a DTO enum (`"request"`, `"tx"`, `"high"`, ...).
fn enum_str<T: Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(_) => "unknown".to_string(),
    }
}

fn hex8(b: u8) -> String {
    format!("0x{b:02X}")
}

fn diag_err(e: impl std::fmt::Display) -> ToolError {
    ToolError::new(format!("diagnostics engine error: {e}"))
}

/// SID bytes whose payload must never leave the app through MCP.
pub fn is_sensitive_sid(b: u8) -> bool {
    matches!(b, 0x27 | 0x67 | 0x29 | 0x69)
}

/// Request SIDs of the protected services.
fn is_sensitive_request_sid(b: u8) -> bool {
    matches!(b, 0x27 | 0x29)
}

/// Number of PDU bytes that may be shown for a conversation event. `sid` is the request SID the
/// event belongs to (responses carry the original request SID). Protected services keep only
/// SID + subFunction; negative responses (`7F sid NRC`) carry no secret and are kept whole.
/// Returns `bytes.len()` when nothing is redacted.
pub fn redact_pdu(sid: Option<u8>, bytes: &[u8]) -> usize {
    let Some(&first) = bytes.first() else {
        return 0;
    };
    if first == 0x7F {
        return bytes.len();
    }
    let sensitive = is_sensitive_sid(first) || sid.is_some_and(is_sensitive_request_sid);
    if sensitive {
        bytes.len().min(2)
    } else {
        bytes.len()
    }
}

/// Plain view of one captured ISO-TP frame (input of [`redact_isotp_frames`]).
#[derive(Debug, Clone, Copy)]
pub struct FrameView<'a> {
    pub can_id: u32,
    pub is_extended: bool,
    pub tx: bool,
    pub fd: bool,
    pub data: &'a [u8],
    pub request_seq: Option<u64>,
}

/// Offset of the first PDU byte of a Single / First Frame, or `None` for other frame types.
fn pdu_start(data: &[u8], off: usize, fd: bool) -> Option<usize> {
    let pci = *data.get(off)?;
    match pci >> 4 {
        0 => Some(if pci & 0x0F == 0 && fd {
            off + 2
        } else {
            off + 1
        }),
        1 => {
            let len12 = (usize::from(pci & 0x0F) << 8) | usize::from(*data.get(off + 1)?);
            Some(if len12 == 0 { off + 6 } else { off + 2 })
        }
        _ => None,
    }
}

/// Returns, per frame, how many leading data bytes may be shown (`data.len()` = not redacted).
///
/// `addr_offset` is 1 for extended / mixed ISO-TP addressing (address byte before the PCI).
/// A frame is protected when its transaction (`request_seq`) is in `sensitive_requests` (from
/// the conversation log), when it is a Single / First Frame whose first PDU byte is a protected
/// SID, or when it is a Consecutive Frame of such a First Frame (same `request_seq` or the same
/// `(id, direction)` stream); a Consecutive Frame whose First Frame is not on this page is
/// treated as protected (fail closed). Single / First Frames keep PCI + SID + subFunction; Consecutive
/// Frames keep only their PCI byte. Flow Control frames carry no payload and are never redacted.
pub fn redact_isotp_frames(
    frames: &[FrameView<'_>],
    addr_offset: usize,
    sensitive_requests: &HashSet<u64>,
) -> Vec<usize> {
    let starts_sensitive = |f: &FrameView<'_>| -> bool {
        pdu_start(f.data, addr_offset, f.fd)
            .and_then(|s| f.data.get(s))
            .is_some_and(|&b| is_sensitive_sid(b))
    };
    // Pass 1: transactions proven sensitive by a frame of this page.
    let mut sensitive: HashSet<u64> = sensitive_requests.clone();
    for f in frames {
        if let Some(rs) = f.request_seq {
            if starts_sensitive(f) {
                sensitive.insert(rs);
            }
        }
    }
    // Pass 2: per-frame visible length.
    let mut stream: HashMap<(u32, bool, bool), bool> = HashMap::new();
    frames
        .iter()
        .map(|f| {
            let len = f.data.len();
            let Some(&pci) = f.data.get(addr_offset) else {
                return len;
            };
            let by_seq = f.request_seq.is_some_and(|s| sensitive.contains(&s));
            let key = (f.can_id, f.is_extended, f.tx);
            match pci >> 4 {
                0 | 1 => {
                    let start = pdu_start(f.data, addr_offset, f.fd).unwrap_or(addr_offset + 1);
                    let first = f.data.get(start).copied();
                    let negative = first == Some(0x7F);
                    let sens = !negative && (by_seq || first.is_some_and(is_sensitive_sid));
                    if pci >> 4 == 1 {
                        stream.insert(key, sens);
                    }
                    if sens {
                        len.min(start + 2)
                    } else {
                        len
                    }
                }
                2 => {
                    // Fail closed: a CF whose First Frame is not on this page (earlier page,
                    // evicted log) cannot be proven harmless, so its payload is hidden.
                    let sens = by_seq || stream.get(&key).copied().unwrap_or(true);
                    if sens {
                        len.min(addr_offset + 1)
                    } else {
                        len
                    }
                }
                3 => len,
                _ => {
                    if by_seq {
                        len.min(addr_offset + 1)
                    } else {
                        len
                    }
                }
            }
        })
        .collect()
}

/// Hex of `bytes[..visible]` followed by [`REDACTED`] when bytes were hidden.
pub fn redacted_hex(bytes: &[u8], visible: usize) -> (String, bool) {
    let visible = visible.min(bytes.len());
    if visible < bytes.len() {
        (format!("{}{REDACTED}", hex_upper(&bytes[..visible])), true)
    } else {
        (hex_upper(bytes), false)
    }
}

fn clamp_limit(limit: Option<u32>, default: u32, max: u32) -> (u32, bool) {
    let want = limit.unwrap_or(default);
    let eff = want.clamp(1, max);
    (eff, eff != want)
}

// ─── Session selection ──────────────────────────────────────────────────────

/// Compact JSON of one session (no secrets: only state and addressing).
fn session_json<I: Serialize>(info: &I) -> Value {
    // Work on the serialized DTO so this crate stays independent of the protocol crate.
    let v = serde_json::to_value(info).unwrap_or(Value::Null);
    let c = &v["config"];
    let ext = c["isExtendedId"].as_bool().unwrap_or(false);
    let id = |k: &str| {
        c[k].as_u64()
            .and_then(|x| u32::try_from(x).ok())
            .map(|x| fmt_id(x, ext))
    };
    json!({
        "bus_id": c["busId"],
        "request_id": id("requestId"),
        "response_id": id("responseId"),
        "is_extended": ext,
        "functional_id": id("functionalId"),
        "address_format": c["addressFormat"],
        "target_address": c["targetAddress"],
        "response_address": c["responseAddress"],
        "use_fd": c["useFd"],
        "padding": c["padding"],
        "open": v["open"],
        "active_session": v["activeSession"].as_u64().map(|s| format!("0x{s:02X}")),
        "unlocked_level": v["unlockedLevel"],
        "tester_present_enabled": v["testerPresentEnabled"],
        "tester_present_interval_ms": v["testerPresentIntervalMs"],
        "p2_server_ms": v["p2ServerMs"],
        "p2_star_server_ms": v["p2StarServerMs"],
        "last_seq": v["lastSeq"],
    })
}

/// Which list entries `sel` matches (indices into `sessions`). Pure: unit-testable.
/// `addr` = `(bus_id, request_id, response_id, is_extended)` per session.
pub fn match_sessions(
    addr: &[(u8, u32, u32, bool)],
    sel: &SessionSelector,
) -> Result<Vec<usize>, ToolError> {
    let parse = |raw: &Option<String>| -> Result<Option<(u32, Option<bool>)>, ToolError> {
        raw.as_deref()
            .map(|s| {
                let p = parse_id(s)?;
                let ext = sel.is_extended.or(if p.is_extended(None) {
                    Some(true)
                } else {
                    None
                });
                Ok((p.id, ext))
            })
            .transpose()
    };
    let req = parse(&sel.request_id)?;
    let resp = parse(&sel.response_id)?;
    let id_ok = |want: Option<(u32, Option<bool>)>, id: u32, ext: bool| {
        want.is_none_or(|(w, wext)| w == id && wext.is_none_or(|e| e == ext))
    };
    Ok(addr
        .iter()
        .enumerate()
        .filter(|(_, &(bus, rq, rs, ext))| {
            sel.bus_id.is_none_or(|b| b == bus)
                && id_ok(req, rq, ext)
                && id_ok(resp, rs, ext)
                && sel.is_extended.is_none_or(|e| e == ext)
        })
        .map(|(i, _)| i)
        .collect())
}

fn candidates_text(addr: &[(u8, u32, u32, bool)], idx: &[usize]) -> String {
    let shown: Vec<String> = idx
        .iter()
        .take(MAX_SELECTOR_CANDIDATES)
        .map(|&i| {
            let (bus, rq, rs, ext) = addr[i];
            format!("bus {bus} {}->{}", fmt_id(rq, ext), fmt_id(rs, ext))
        })
        .collect();
    let more = idx.len().saturating_sub(MAX_SELECTOR_CANDIDATES);
    if more > 0 {
        format!("{} (+{more} more)", shown.join(", "))
    } else {
        shown.join(", ")
    }
}

/// Resolves `sel` against `addr` to exactly one index, else an explicit error listing
/// candidates (≤ [`MAX_SELECTOR_CANDIDATES`]).
pub fn select_one(
    addr: &[(u8, u32, u32, bool)],
    sel: &SessionSelector,
) -> Result<usize, ToolError> {
    const NONE_OPEN: &str = "no diagnostic session is known to the engine; the user must open one in the Diagnostics view (MCP never opens sessions)";
    if addr.is_empty() {
        return Err(ToolError::new(NONE_OPEN));
    }
    let hits = match_sessions(addr, sel)?;
    match hits.len() {
        1 => Ok(hits[0]),
        0 => {
            let all: Vec<usize> = (0..addr.len()).collect();
            Err(ToolError::new(format!(
                "no diagnostic session matches ({}); known sessions: {}",
                sel.summary(),
                candidates_text(addr, &all)
            )))
        }
        _ => Err(ToolError::new(format!(
            "{} diagnostic sessions match ({}); add bus_id / request_id / response_id to pick one: {}",
            hits.len(),
            sel.summary(),
            candidates_text(addr, &hits)
        ))),
    }
}

/// `(bus_id, request_id, response_id, is_extended)` of every listed session.
macro_rules! session_addr {
    ($list:expr) => {
        $list
            .iter()
            .map(|i| {
                (
                    i.config.bus_id,
                    i.config.request_id,
                    i.config.response_id,
                    i.config.is_extended_id,
                )
            })
            .collect::<Vec<(u8, u32, u32, bool)>>()
    };
}

// ─── Tools ──────────────────────────────────────────────────────────────────

/// `diag_session_info`: list all sessions (no addressing) or the state of one.
pub fn diag_session_info(engine: &PipelineEngine, args: &DiagSessionInfoArgs) -> ToolResult {
    let list = engine.diag_session_list();
    let sel = &args.selector;
    if !sel.has_addressing() {
        let sessions: Vec<Value> = list
            .iter()
            .filter(|i| sel.bus_id.is_none_or(|b| b == i.config.bus_id))
            .filter(|i| sel.is_extended.is_none_or(|e| e == i.config.is_extended_id))
            .map(session_json)
            .collect();
        let mut out = json!({
            "count": sessions.len(),
            "max_listed": MAX_DIAG_SESSION_LIST,
            "sessions": sessions,
            "note": "Read-only listing. MCP never opens or closes sessions or sends UDS requests.",
        });
        if list.is_empty() {
            out["message"] = json!(
                "No diagnostic session is known to the engine. The user can open one in the Diagnostics view."
            );
        }
        fit_array(&mut out, "/sessions", TRIM_BUDGET_BYTES);
        return Ok(out);
    }
    let addr = session_addr!(list);
    let idx = select_one(&addr, sel)?;
    // Fresh state of exactly that session (`cmd_diag_session_info` never opens one).
    let info = engine
        .cmd_diag_session_info(list[idx].config.clone())
        .map_err(|e| diag_err(e.message))?;
    let mut out = json!({ "session": session_json(&info) });
    out["note"] = json!("Read-only. MCP never opens or closes sessions or sends UDS requests.");
    Ok(out)
}

/// `diag_conversation`: one page of the UDS conversation log of the selected session.
pub fn diag_conversation(engine: &PipelineEngine, args: &DiagConversationArgs) -> ToolResult {
    let list = engine.diag_session_list();
    let idx = select_one(&session_addr!(list), &args.selector)?;
    let config = list[idx].config.clone();
    let (limit, clamped) = clamp_limit(
        args.limit,
        DEFAULT_CONVERSATION_LIMIT,
        MAX_CONVERSATION_LIMIT,
    );
    let since = args.since_seq.unwrap_or(0);
    let page = engine
        .cmd_diag_get_conversation(config, since, Some(limit))
        .map_err(|e| diag_err(e.message))?;
    let mut any_redacted = false;
    let events: Vec<Value> = page
        .events
        .iter()
        .map(|e| {
            let visible = redact_pdu(e.sid, &e.bytes);
            let redacted = visible < e.bytes.len();
            any_redacted |= redacted;
            let clipped = !redacted && e.bytes.len() > MAX_EVENT_BYTES;
            let hex = if redacted {
                format!("{}{REDACTED}", hex_upper(&e.bytes[..visible]))
            } else {
                hex_upper(&e.bytes[..e.bytes.len().min(MAX_EVENT_BYTES)])
            };
            let mut ev = json!({
                "seq": e.seq,
                "t_us": e.timestamp_us,
                "kind": enum_str(&e.kind),
                "addressing": enum_str(&e.addressing),
                "sid": e.sid.map(hex8),
                "bytes_hex": hex,
                "len": e.bytes.len(),
                "request_seq": e.request_seq,
                "elapsed_us": e.elapsed_us,
                "nrc": e.nrc.map(hex8),
                "detail": e.detail.as_deref().map(|d| clip(d, 64)),
                "origin": enum_str(&e.origin),
                "retry_index": e.retry_index,
            });
            if redacted {
                ev["redacted"] = json!(true);
            } else if clipped {
                ev["bytes_clipped"] = json!(true);
            }
            ev
        })
        .collect();
    let returned = events.len();
    let mut out = json!({
        "session": session_json(&list[idx]),
        "since_seq": since,
        "limit": limit,
        "limit_clamped": clamped,
        "log_truncated": page.truncated,
        "redacted": any_redacted,
        "events": events,
    });
    let kept = fit_array(&mut out, "/events", TRIM_BUDGET_BYTES - 128);
    let next = if kept > 0 {
        page.events[kept - 1].seq
    } else if returned == 0 {
        page.last_seq
    } else {
        since
    };
    out["next_since_seq"] = json!(next);
    out["has_more"] = json!(kept < returned || returned as u32 == limit);
    Ok(out)
}

/// `diag_isotp_frames`: one page of the CAN frames captured by the selected session's tap.
pub fn diag_isotp_frames(engine: &PipelineEngine, args: &DiagIsoTpFramesArgs) -> ToolResult {
    let list = engine.diag_session_list();
    let idx = select_one(&session_addr!(list), &args.selector)?;
    let config = list[idx].config.clone();
    let addr_offset = match enum_str(&config.address_format).as_str() {
        "extended" | "mixed" => 1,
        _ => 0,
    };
    let (limit, clamped) = clamp_limit(args.limit, DEFAULT_ISOTP_LIMIT, MAX_ISOTP_LIMIT);
    let since = args.since_seq.unwrap_or(0);
    let page = engine
        .cmd_diag_get_isotp_frames(config.clone(), since, Some(limit))
        .map_err(|e| diag_err(e.message))?;

    // Transactions of protected services, from the conversation log (bounded lookup).
    let mut sensitive: HashSet<u64> = HashSet::new();
    let seqs = page.frames.iter().filter_map(|f| f.request_seq);
    if let (Some(lo), Some(hi)) = (seqs.clone().min(), seqs.max()) {
        let span = hi - lo + 1;
        if span <= MAX_REDACTION_LOOKUP {
            if let Ok(conv) =
                engine.cmd_diag_get_conversation(config, lo.saturating_sub(1), Some(span as u32))
            {
                for e in &conv.events {
                    let first = e.bytes.first().copied();
                    if enum_str(&e.kind) == "request"
                        && (e.sid.is_some_and(is_sensitive_request_sid)
                            || first.is_some_and(is_sensitive_request_sid))
                    {
                        sensitive.insert(e.seq);
                    }
                }
            }
        }
    }
    let views: Vec<FrameView<'_>> = page
        .frames
        .iter()
        .map(|f| FrameView {
            can_id: f.can_id,
            is_extended: f.is_extended,
            tx: enum_str(&f.direction) == "tx",
            fd: f.fd,
            data: &f.data,
            request_seq: f.request_seq,
        })
        .collect();
    let visible = redact_isotp_frames(&views, addr_offset, &sensitive);
    let mut any_redacted = false;
    let frames: Vec<Value> = page
        .frames
        .iter()
        .zip(&visible)
        .map(|(f, &vis)| {
            let (hex, redacted) = redacted_hex(&f.data, vis);
            any_redacted |= redacted;
            let mut v = json!({
                "seq": f.seq,
                "t_us": f.timestamp_us,
                "id": fmt_id(f.can_id, f.is_extended),
                "dir": enum_str(&f.direction),
                "fd": f.fd,
                "dlc_bytes": f.data.len(),
                "kind": enum_str(&f.kind),
                "data_hex": hex,
                "request_seq": f.request_seq,
            });
            if redacted {
                v["redacted"] = json!(true);
            }
            v
        })
        .collect();
    let returned = frames.len();
    let mut out = json!({
        "session": session_json(&list[idx]),
        "since_seq": since,
        "limit": limit,
        "limit_clamped": clamped,
        "log_truncated": page.truncated,
        "frames_dropped": page.dropped,
        "redacted": any_redacted,
        "frames": frames,
    });
    let kept = fit_array(&mut out, "/frames", TRIM_BUDGET_BYTES - 128);
    let next = if kept > 0 {
        page.frames[kept - 1].seq
    } else if returned == 0 {
        page.last_seq
    } else {
        since
    };
    out["next_since_seq"] = json!(next);
    out["has_more"] = json!(kept < returned || returned as u32 == limit);
    Ok(out)
}

/// `diag_passive_discovery`: snapshot(s) of the passive ECU discovery; never starts / stops it.
pub fn diag_passive_discovery(
    engine: &PipelineEngine,
    args: &DiagPassiveDiscoveryArgs,
) -> ToolResult {
    let buses: Vec<u8> = match args.bus_id {
        Some(b) => vec![b],
        None => engine.diag_passive_bus_ids(),
    };
    let mut scans = Vec::with_capacity(buses.len());
    let mut pairs = Vec::new();
    for bus in buses {
        let s = engine
            .cmd_diag_passive_discovery_snapshot(bus)
            .map_err(|e| diag_err(e.message))?;
        scans.push(json!({
            "bus_id": s.bus_id,
            "running": s.running,
            "stop_reason": s.stop_reason.as_deref().map(|r| clip(r, 64)),
            "started_at_us": s.started_at_us,
            "frames_analyzed": s.frames_analyzed,
            "frames_dropped": s.frames_dropped,
            "pair_count": s.pairs.len(),
            "pair_table_full": s.truncated,
            "dropped_pairs": s.dropped_pairs,
            "max_pairs": s.max_pairs,
            "evicted_requests": s.evicted_requests,
        }));
        for p in &s.pairs {
            let sids: Vec<String> = p.sids_seen.iter().take(32).map(|&b| hex8(b)).collect();
            pairs.push(json!({
                "bus_id": p.bus_id,
                "request_id": fmt_id(p.request_id, p.is_extended_id),
                "response_id": fmt_id(p.response_id, p.is_extended_id),
                "is_extended": p.is_extended_id,
                "evidence": p.evidence_count,
                "confidence": enum_str(&p.confidence),
                "flow_control_seen": p.flow_control_seen,
                "functional_request": p.functional_request,
                "sids_seen": sids,
                "first_seen_us": p.first_seen_us,
                "last_seen_us": p.last_seen_us,
            }));
        }
    }
    let mut out = json!({
        "scans": scans,
        "pairs": pairs,
        "note": "Snapshot only. MCP never starts or stops passive discovery and sends nothing.",
    });
    if scans_empty(&out) {
        out["message"] = json!(
            "No passive discovery scan exists. The user can start one in the Diagnostics view (it is Listen-Only safe)."
        );
    }
    fit_array(&mut out, "/pairs", TRIM_BUDGET_BYTES);
    Ok(out)
}

fn scans_empty(v: &Value) -> bool {
    v["scans"].as_array().is_none_or(|a| {
        a.iter()
            .all(|s| s["started_at_us"].as_u64().unwrap_or(0) == 0)
    })
}
