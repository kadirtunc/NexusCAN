//! MCP M3 tool logic — see planning/contracts/mcp-v1.md §9 (backend-C): read-only run history
//! (`run_query`, `run_latest`) and flow library browsing (`flowlib_list`, `flowlib_get`).
//!
//! Nothing here appends run records, saves / deletes flows or writes any file: only
//! `cmd_run_query`, `cmd_run_latest`, `cmd_flowlib_list`, `cmd_flowlib_revisions` and
//! `cmd_flowlib_load` are called. Flow ids are validated syntactically and then resolved only via
//! `cmd_flowlib_list(true)` (no path traversal); run records are summarised, never dumped.

use crate::util::{clip, echo, fit_array, json_len, ToolError, ToolResult, TRIM_BUDGET_BYTES};
use nexus_hal::flowlib::{is_valid_flow_id, FlowLibEntryDto, FlowLibError, MAX_FLOW_ID_LEN};
use nexus_hal::pipeline::PipelineEngine;
use nexus_hal::runstore::{
    is_uuid_safe, RunOutcome, RunQueryFilterDto, RunRecordV1, RunStoreError, MAX_RUN_ID_LEN,
};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

/// Default / max `run_query` records.
pub const RUN_QUERY_LIMIT_DEFAULT: u32 = 20;
pub const RUN_QUERY_LIMIT_MAX: u32 = 50;
/// Max `run_latest` records.
pub const RUN_LATEST_MAX: usize = 50;
/// Max `flowlib_list` entries.
pub const FLOWLIB_LIST_MAX: usize = 200;
/// Max revisions listed by `flowlib_get` (newest first).
pub const FLOWLIB_REVISIONS_MAX: usize = 50;
/// Max distinct items per structural-summary list (block types, DIDs, routines, calls).
pub const FLOW_SUMMARY_ITEMS_MAX: usize = 32;
/// Max output keys listed per run record summary.
const RUN_OUTPUT_KEYS_MAX: usize = 8;
/// Max ids named in "unknown id" errors.
const ERROR_IDS_MAX: usize = 8;

const VALID_STATUSES: &str = "ok, fail, error, aborted, panic_stop";

/// Replaces every caller input echoed (via `escape_debug`) inside an engine error by its clipped
/// form, so engine messages never echo more than 64 chars of caller input (MCP-QA-01).
fn scrub(msg: String, inputs: &[&str]) -> String {
    let mut out = msg;
    for raw in inputs {
        if raw.chars().count() <= crate::util::ECHO_CLIP_CHARS {
            continue;
        }
        let escaped = raw.escape_debug().to_string();
        out = out.replace(&escaped, &echo(raw));
        out = out.replace(raw, &echo(raw));
    }
    out
}

fn run_err(e: RunStoreError, inputs: &[&str]) -> ToolError {
    ToolError::new(scrub(e.to_ipc_string(), inputs))
}

fn flow_err(e: FlowLibError, inputs: &[&str]) -> ToolError {
    ToolError::new(scrub(e.to_ipc_string(), inputs))
}

/// Same rule and wire format as the engine's `check_uuid_safe("projectId", ..)`, with the echoed
/// input clipped.
fn check_project_id(project_id: &str) -> Result<(), ToolError> {
    if is_uuid_safe(project_id) {
        Ok(())
    } else {
        Err(ToolError::new(format!(
            "[runstore:invalid] invalid projectId '{}': expected [A-Za-z0-9-]{{1,{MAX_RUN_ID_LEN}}}",
            echo(project_id).escape_debug()
        )))
    }
}

fn parse_status(raw: &str) -> Result<RunOutcome, ToolError> {
    let norm = raw.trim().to_ascii_lowercase().replace('-', "_");
    serde_json::from_value::<RunOutcome>(Value::String(norm)).map_err(|_| {
        ToolError::new(format!(
            "invalid status '{}': expected one of {VALID_STATUSES}",
            echo(raw)
        ))
    })
}

fn outcome_str(o: RunOutcome) -> &'static str {
    match o {
        RunOutcome::Ok => "ok",
        RunOutcome::Fail => "fail",
        RunOutcome::Error => "error",
        RunOutcome::Aborted => "aborted",
        RunOutcome::PanicStop => "panic_stop",
    }
}

fn opt_clip(v: Option<&str>, max: usize) -> Value {
    v.map_or(Value::Null, |s| Value::String(clip(s, max)))
}

/// Bounded summary of one run record: identity, timing, ECU, flow, status and counts. Never the
/// params / outputs values, file refs or log excerpt lines.
pub fn run_summary(r: &RunRecordV1) -> Value {
    let output_keys: Vec<String> = r
        .outputs
        .keys()
        .take(RUN_OUTPUT_KEYS_MAX)
        .map(|k| clip(k, 40))
        .collect();
    json!({
        "run_id": clip(&r.run_id, 64),
        "parent_run_id": opt_clip(r.parent_run_id.as_deref(), 64),
        "queue_id": opt_clip(r.queue_id.as_deref(), 64),
        "started_at": clip(&r.started_at, 40),
        "ended_at": clip(&r.ended_at, 40),
        "duration_ms": r.duration_ms,
        "status": outcome_str(r.outcome),
        "ecu_id": opt_clip(r.ecu_id.as_deref(), 64),
        "ecu_name": opt_clip(r.ecu_name.as_deref(), 80),
        "flow_id": clip(&r.flow_id, 64),
        "flow_revision": r.flow_revision,
        "flow_name": clip(&r.flow_name, 120),
        "output_name": opt_clip(r.output_name.as_deref(), 64),
        "nrc": r.nrc.map(|n| format!("0x{n:02X}")),
        "error_message": opt_clip(r.error_message.as_deref(), 160),
        "counts": {
            "params": r.params.len(),
            "outputs": r.outputs.len(),
            "files": r.files.len(),
            "log_lines": r.log_excerpt.len(),
        },
        "output_keys": output_keys,
    })
}

// ─── run_query / run_latest ─────────────────────────────────────────────────

/// `run_query` arguments (already deserialized by the server).
#[derive(Debug, Clone, Default)]
pub struct RunQuery {
    pub project_id: String,
    pub ecu_id: Option<String>,
    pub flow_id: Option<String>,
    pub status: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub limit: Option<u32>,
}

/// `run_query`: newest first, filtered, at most [`RUN_QUERY_LIMIT_MAX`] summarised records.
pub fn run_query(engine: &PipelineEngine, q: &RunQuery) -> ToolResult {
    check_project_id(&q.project_id)?;
    let outcome = q.status.as_deref().map(parse_status).transpose()?;
    fn non_empty(v: &Option<String>) -> Option<&str> {
        v.as_deref().filter(|s| !s.trim().is_empty())
    }
    let filter = RunQueryFilterDto {
        ecu_id: non_empty(&q.ecu_id).map(str::to_string),
        flow_id: non_empty(&q.flow_id).map(str::to_string),
        queue_id: None,
        outcome,
        since: non_empty(&q.from).map(|s| s.trim().to_string()),
        until: non_empty(&q.to).map(|s| s.trim().to_string()),
        top_level_only: None,
    };
    let limit = q
        .limit
        .unwrap_or(RUN_QUERY_LIMIT_DEFAULT)
        .clamp(1, RUN_QUERY_LIMIT_MAX);
    let inputs: Vec<&str> = [&q.ecu_id, &q.flow_id, &q.from, &q.to]
        .into_iter()
        .filter_map(|v| v.as_deref())
        .collect();
    let records = engine
        .cmd_run_query(&q.project_id, &filter, i64::from(limit))
        .map_err(|e| run_err(e, &inputs))?;
    let rows: Vec<Value> = records.iter().map(run_summary).collect();
    let mut v = json!({
        "project_id": q.project_id,
        "filter": {
            "ecu_id": filter.ecu_id.as_deref().map(echo),
            "flow_id": filter.flow_id.as_deref().map(echo),
            "status": outcome.map(outcome_str),
            "from": filter.since.as_deref().map(echo),
            "to": filter.until.as_deref().map(echo),
        },
        "limit": limit,
        "count": rows.len(),
        "more_may_exist": rows.len() == limit as usize,
        "runs": rows,
        "note": "Run history, newest first (from inclusive, to exclusive, RFC 3339). Summaries only: no params/outputs values, file refs or log lines. Read-only: does NOT append, edit or re-run anything.",
    });
    fit_array(&mut v, "/runs", TRIM_BUDGET_BYTES);
    Ok(v)
}

/// `run_latest`: latest top-level run per (ECU, flow), newest first, at most [`RUN_LATEST_MAX`].
pub fn run_latest(engine: &PipelineEngine, project_id: &str) -> ToolResult {
    check_project_id(project_id)?;
    let records = engine
        .cmd_run_latest(project_id)
        .map_err(|e| run_err(e, &[]))?;
    let total = records.len();
    let rows: Vec<Value> = records
        .iter()
        .take(RUN_LATEST_MAX)
        .map(run_summary)
        .collect();
    let mut v = json!({
        "project_id": project_id,
        "total": total,
        "count": rows.len(),
        "runs": rows,
        "note": "Latest top-level run per (ecu_id, flow_id), newest first. Summaries only. Read-only: does NOT append, edit or re-run anything.",
    });
    if total > RUN_LATEST_MAX {
        if let Some(o) = v.as_object_mut() {
            o.insert("truncated".into(), Value::Bool(true));
            o.insert("omitted_items".into(), json!(total - RUN_LATEST_MAX));
        }
    }
    fit_array(&mut v, "/runs", TRIM_BUDGET_BYTES);
    Ok(v)
}

// ─── flowlib_list / flowlib_get ─────────────────────────────────────────────

/// Listing that never creates the flow library directory (missing dir -> empty list).
fn list_flows(
    engine: &PipelineEngine,
    include_deleted: bool,
) -> Result<Vec<FlowLibEntryDto>, ToolError> {
    if !engine.data_root().flowlib_dir().is_dir() {
        return Ok(Vec::new());
    }
    engine
        .cmd_flowlib_list(include_deleted)
        .map_err(|e| flow_err(e, &[]))
}

fn tags(e: &FlowLibEntryDto) -> Vec<String> {
    e.tags.iter().take(8).map(|t| clip(t, 40)).collect()
}

/// `flowlib_list`: entries (name order) with revision counts, at most [`FLOWLIB_LIST_MAX`].
pub fn flowlib_list(engine: &PipelineEngine, include_deleted: bool) -> ToolResult {
    let list = list_flows(engine, include_deleted)?;
    let total = list.len();
    let rows: Vec<Value> = list
        .iter()
        .take(FLOWLIB_LIST_MAX)
        .map(|e| {
            let revision_count = engine
                .cmd_flowlib_revisions(&e.id)
                .map_or(Value::Null, |r| json!(r.len()));
            json!({
                "id": e.id,
                "kind": e.kind.as_str(),
                "name": clip(&e.name, 120),
                "latest_revision": e.latest_revision,
                "revision_count": revision_count,
                "updated_at": clip(&e.updated_at, 40),
                "origin": e.origin,
                "ai_reviewed": e.ai_reviewed,
                "tags": tags(e),
                "deleted": e.deleted,
            })
        })
        .collect();
    let mut v = json!({
        "include_deleted": include_deleted,
        "total": total,
        "count": rows.len(),
        "flows": rows,
        "note": "Flow library (flows and custom blocks), sorted by name. Pass an id to flowlib_get. Read-only: does NOT save, delete, run or load a flow into the editor.",
    });
    if total > FLOWLIB_LIST_MAX {
        if let Some(o) = v.as_object_mut() {
            o.insert("truncated".into(), Value::Bool(true));
            o.insert("omitted_items".into(), json!(total - FLOWLIB_LIST_MAX));
        }
    }
    fit_array(&mut v, "/flows", TRIM_BUDGET_BYTES);
    Ok(v)
}

/// UDS service(s) a flow block type issues (`(sid, name)`); empty for non-UDS blocks.
fn uds_services(block_type: &str) -> &'static [(u8, &'static str)] {
    match block_type {
        "uds_session" => &[(0x10, "DiagnosticSessionControl")],
        "uds_ecu_reset" => &[(0x11, "ECUReset")],
        "uds_clear_dtc" => &[(0x14, "ClearDiagnosticInformation")],
        "uds_read_dtc" => &[(0x19, "ReadDTCInformation")],
        "uds_read_did" => &[(0x22, "ReadDataByIdentifier")],
        "uds_read_memory" => &[(0x23, "ReadMemoryByAddress")],
        "uds_security_access" => &[(0x27, "SecurityAccess")],
        "uds_comm_control" => &[(0x28, "CommunicationControl")],
        "uds_write_did" => &[(0x2E, "WriteDataByIdentifier")],
        "uds_io_control" => &[(0x2F, "InputOutputControlByIdentifier")],
        "uds_routine_ctrl" => &[(0x31, "RoutineControl")],
        "uds_req_download" => &[(0x34, "RequestDownload")],
        "uds_req_upload" => &[(0x35, "RequestUpload")],
        "uds_transfer_data" => &[(0x36, "TransferData")],
        "uds_flash_image" => &[
            (0x34, "RequestDownload"),
            (0x36, "TransferData"),
            (0x37, "RequestTransferExit"),
        ],
        "uds_transfer_exit" => &[(0x37, "RequestTransferExit")],
        "uds_write_memory" => &[(0x3D, "WriteMemoryByAddress")],
        "uds_tester_present" | "uds_tester_present_keepalive" => &[(0x3E, "TesterPresent")],
        "uds_dtc_setting" => &[(0x85, "ControlDTCSetting")],
        "uds_link_control" => &[(0x87, "LinkControl")],
        _ => &[],
    }
}

/// Normalises a DID / routine id config value (`"F190"`, `"0xf190"`, `61840`) to `0xF190`;
/// other values (bindings such as `{did}`) are clipped verbatim.
fn norm_id16(v: &Value) -> Option<String> {
    match v {
        Value::Number(n) => n
            .as_u64()
            .filter(|n| *n <= 0xFFFF)
            .map(|n| format!("0x{n:04X}")),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                return None;
            }
            let h = t
                .strip_prefix("0x")
                .or_else(|| t.strip_prefix("0X"))
                .unwrap_or(t);
            if (1..=4).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_hexdigit()) {
                u16::from_str_radix(h, 16)
                    .ok()
                    .map(|n| format!("0x{n:04X}"))
            } else {
                Some(clip(t, 24))
            }
        }
        _ => None,
    }
}

fn capped(set: BTreeSet<String>) -> Value {
    let total = set.len();
    let items: Vec<String> = set.into_iter().take(FLOW_SUMMARY_ITEMS_MAX).collect();
    json!({ "total": total, "items": items })
}

/// Structural summary of an `NxFlowFileV1` envelope: kind, block / connection / variable counts,
/// block type histogram, referenced UDS services, DIDs, routine ids and library calls.
pub fn flow_structure(file: &Value) -> Value {
    let flow = file.get("flow").unwrap_or(&Value::Null);
    let blocks = flow
        .get("blocks")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let len_of = |k: &str| flow.get(k).and_then(Value::as_array).map_or(0, Vec::len);

    let mut types: BTreeMap<String, usize> = BTreeMap::new();
    let mut services: BTreeMap<u8, (&'static str, usize)> = BTreeMap::new();
    let mut dids = BTreeSet::new();
    let mut routines = BTreeSet::new();
    let mut calls = BTreeSet::new();
    let mut ai_flagged = 0usize;
    for b in blocks {
        let ty = b.get("type").and_then(Value::as_str).unwrap_or("");
        *types.entry(clip(ty, 48)).or_default() += 1;
        for (sid, name) in uds_services(ty) {
            services.entry(*sid).or_insert((name, 0)).1 += 1;
        }
        let cfg = b.get("config").unwrap_or(&Value::Null);
        if ty.starts_with("uds_") {
            if let Some(d) = cfg.get("did").and_then(norm_id16) {
                dids.insert(d);
            }
            if let Some(r) = cfg.get("routine_id").and_then(norm_id16) {
                routines.insert(r);
            }
        }
        if let Some(target) = ty.strip_prefix("call:") {
            calls.insert(clip(target, MAX_FLOW_ID_LEN));
        } else if let Some(target) = cfg
            .get("ref")
            .and_then(|r| r.get("flowId").or_else(|| r.get("id")))
            .and_then(Value::as_str)
        {
            calls.insert(clip(target, MAX_FLOW_ID_LEN));
        }
        if matches!(
            b.pointer("/ai/warningLevel").and_then(Value::as_str),
            Some("high" | "critical")
        ) {
            ai_flagged += 1;
        }
    }
    let mut hist: Vec<(String, usize)> = types.into_iter().collect();
    hist.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let distinct_types = hist.len();
    let block_types: Vec<Value> = hist
        .into_iter()
        .take(FLOW_SUMMARY_ITEMS_MAX)
        .map(|(t, n)| json!({ "type": t, "count": n }))
        .collect();
    let uds: Vec<Value> = services
        .into_iter()
        .map(|(sid, (name, n))| json!({ "sid": format!("0x{sid:02X}"), "name": name, "blocks": n }))
        .collect();
    let s = |k: &str, max: usize| {
        flow.get(k)
            .and_then(Value::as_str)
            .map_or(Value::Null, |x| Value::String(clip(x, max)))
    };
    json!({
        "kind": file.get("kind").and_then(Value::as_str).map(|k| clip(k, 40)),
        "schema_version": file.get("schemaVersion"),
        "name": s("name", 120),
        "description": s("description", 240),
        "block_count": blocks.len(),
        "connection_count": len_of("connections"),
        "variable_count": len_of("variables"),
        "distinct_block_types": distinct_types,
        "block_types": block_types,
        "uds_services": uds,
        "dids": capped(dids),
        "routine_ids": capped(routines),
        "library_calls": capped(calls),
        "ai_flagged_blocks": ai_flagged,
    })
}

/// Max redacted field paths listed in a `flowlib_get` response.
const REDACTED_PATHS_MAX: usize = 16;
/// Replacement for redacted secret values.
pub const REDACTED: &str = "<redacted>";

/// `true` for object keys that may hold secrets (seed/key material, credentials, masks).
/// Conservative (fails toward hiding): the name is lower-cased with `_`/`-` removed, so
/// camelCase / snake_case variants (`privateKey`, `key_bytes`, `expected_key`) all match.
pub fn is_secret_key(name: &str) -> bool {
    let k: String = name
        .chars()
        .filter(|c| *c != '_' && *c != '-')
        .map(|c| c.to_ascii_lowercase())
        .collect();
    matches!(
        k.as_str(),
        "mask" | "algorithmparams" | "constant" | "script"
    ) || [
        "key",
        "seed",
        "secret",
        "passw",
        "token",
        "private",
        "credential",
    ]
    .iter()
    .any(|w| k.contains(w))
}

/// Flow blocks whose whole `config` is seed-key / authentication material (block `type`
/// contains one of these words). Only [`SECURITY_CONFIG_VISIBLE`] fields stay visible.
const SECURITY_BLOCK_WORDS: [&str; 4] = ["security", "seed", "auth", "key"];
/// Structural, non-secret config fields of security blocks.
const SECURITY_CONFIG_VISIBLE: [&str; 6] = [
    "access_level",
    "level",
    "algorithm",
    "max_attempts",
    "lockout_ms",
    "timeout_ms",
];

fn is_security_block(map: &serde_json::Map<String, Value>) -> bool {
    map.get("type")
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase)
        .is_some_and(|t| SECURITY_BLOCK_WORDS.iter().any(|w| t.contains(w)))
}

fn push_redacted(child: &mut Value, path: &str, out: &mut Vec<String>) {
    if !child.is_null() {
        *child = Value::String(REDACTED.to_string());
        out.push(clip(path, 120));
    }
}

/// Recursively replaces secret values by [`REDACTED`], collecting JSON-pointer paths.
fn redact_secrets(v: &mut Value, path: &mut String, out: &mut Vec<String>) {
    let base = path.len();
    match v {
        Value::Object(map) => {
            let security = is_security_block(map);
            for (k, child) in map.iter_mut() {
                path.push('/');
                path.push_str(&clip(k, 48));
                if is_secret_key(k) {
                    push_redacted(child, path, out);
                } else if security && k == "config" && child.is_object() {
                    // Allowlist: every config field of a security block is hidden unless it
                    // is a known structural field.
                    if let Value::Object(cfg) = child {
                        let cbase = path.len();
                        for (ck, cv) in cfg.iter_mut() {
                            if SECURITY_CONFIG_VISIBLE.contains(&ck.as_str()) {
                                continue;
                            }
                            path.push('/');
                            path.push_str(&clip(ck, 48));
                            push_redacted(cv, path, out);
                            path.truncate(cbase);
                        }
                    }
                } else {
                    redact_secrets(child, path, out);
                }
                path.truncate(base);
            }
        }
        Value::Array(items) => {
            for (i, child) in items.iter_mut().enumerate() {
                path.push('/');
                path.push_str(&i.to_string());
                redact_secrets(child, path, out);
                path.truncate(base);
            }
        }
        _ => {}
    }
}

/// `flowlib_get`: metadata + revisions + structural summary, and the raw flow JSON only if the
/// whole response still fits the cap (else `truncated: true`, `raw_json` omitted).
pub fn flowlib_get(engine: &PipelineEngine, id: &str, revision: Option<u32>) -> ToolResult {
    if !is_valid_flow_id(id) {
        return Err(ToolError::new(format!(
            "[flowlib:invalid] invalid flow id '{}': expected [A-Za-z0-9_-]{{1,{MAX_FLOW_ID_LEN}}} as returned by flowlib_list",
            echo(id).escape_debug()
        )));
    }
    // Resolve only via the engine listing (deleted ids included); never via a caller path.
    let list = list_flows(engine, true)?;
    let Some(entry) = list.iter().find(|e| e.id == id) else {
        let known: Vec<&str> = list
            .iter()
            .take(ERROR_IDS_MAX)
            .map(|e| e.id.as_str())
            .collect();
        return Err(ToolError::new(format!(
            "[flowlib:not_found] unknown flow id '{}'; {} flow(s) in the library{}{}",
            echo(id),
            list.len(),
            if known.is_empty() { "" } else { ", e.g. " },
            known.join(", ")
        )));
    };
    let revisions = engine
        .cmd_flowlib_revisions(&entry.id)
        .map_err(|e| flow_err(e, &[]))?;
    if let Some(r) = revision {
        if !revisions.iter().any(|x| x.revision == r) {
            let avail: Vec<String> = revisions
                .iter()
                .rev()
                .take(ERROR_IDS_MAX)
                .map(|x| x.revision.to_string())
                .collect();
            return Err(ToolError::new(format!(
                "[flowlib:not_found] flow '{}' has no revision {r}; available (newest first): {}",
                entry.id,
                avail.join(", ")
            )));
        }
    }
    let effective = revision.unwrap_or(entry.latest_revision);
    let raw = engine
        .cmd_flowlib_load(&entry.id, Some(effective))
        .map_err(|e| flow_err(e, &[]))?;

    // Secrets are redacted BEFORE the summary is built and before any size check. An unparsable
    // file cannot be redacted, so its raw text is never returned.
    let mut redacted_paths: Vec<String> = Vec::new();
    let (structure, raw) = match serde_json::from_str::<Value>(&raw) {
        Ok(mut file) => {
            redact_secrets(&mut file, &mut String::new(), &mut redacted_paths);
            let structure = flow_structure(&file);
            let raw = if redacted_paths.is_empty() {
                Some(raw)
            } else {
                serde_json::to_string(&file).ok()
            };
            (structure, raw)
        }
        Err(e) => (json!({ "parse_error": clip(&e.to_string(), 160) }), None),
    };
    let rev_total = revisions.len();
    let rev_rows: Vec<Value> = revisions
        .iter()
        .rev()
        .take(FLOWLIB_REVISIONS_MAX)
        .map(|r| {
            json!({
                "revision": r.revision,
                "updated_at": clip(&r.updated_at, 40),
                "content_hash": clip(&r.content_hash, 64),
            })
        })
        .collect();
    let mut obj = Map::new();
    obj.insert("id".into(), json!(entry.id));
    obj.insert(
        "metadata".into(),
        json!({
            "kind": entry.kind.as_str(),
            "name": clip(&entry.name, 120),
            "latest_revision": entry.latest_revision,
            "updated_at": clip(&entry.updated_at, 40),
            "origin": entry.origin,
            "ai_reviewed": entry.ai_reviewed,
            "content_hash": clip(&entry.content_hash, 64),
            "tags": tags(entry),
            "deleted": entry.deleted,
        }),
    );
    obj.insert("revision".into(), json!(effective));
    obj.insert("revision_count".into(), json!(rev_total));
    obj.insert("revisions".into(), Value::Array(rev_rows));
    obj.insert("structure".into(), structure);
    obj.insert(
        "raw_json_bytes".into(),
        json!(raw.as_ref().map_or(0, String::len)),
    );
    obj.insert(
        "note".into(),
        json!("Flow library entry. raw_json is the stored file (secret fields such as keys/seeds replaced by \"<redacted>\") only when it fits the response cap. Read-only: does NOT save, delete, run, or load the flow into the editor, and sends nothing on the bus."),
    );
    let mut v = Value::Object(obj);
    if rev_total > FLOWLIB_REVISIONS_MAX {
        if let Some(o) = v.as_object_mut() {
            o.insert("truncated".into(), Value::Bool(true));
            o.insert(
                "omitted_revisions".into(),
                json!(rev_total - FLOWLIB_REVISIONS_MAX),
            );
        }
    }
    fit_array(&mut v, "/revisions", TRIM_BUDGET_BYTES);

    // Raw JSON only if the whole response (incl. escaping) still fits.
    if !redacted_paths.is_empty() {
        if let Some(o) = v.as_object_mut() {
            o.insert("redacted".into(), Value::Bool(true));
            o.insert("redactedCount".into(), json!(redacted_paths.len()));
            redacted_paths.truncate(REDACTED_PATHS_MAX);
            o.insert("redactedFields".into(), json!(redacted_paths));
        }
    }
    let raw = raw.filter(|raw| {
        raw.len() < TRIM_BUDGET_BYTES && {
            let mut probe = v.clone();
            if let Some(o) = probe.as_object_mut() {
                o.insert("raw_json".into(), Value::String(raw.clone()));
            }
            json_len(&probe) <= TRIM_BUDGET_BYTES
        }
    });
    if let Some(o) = v.as_object_mut() {
        if let Some(raw) = raw {
            o.insert("raw_json".into(), Value::String(raw));
        } else {
            o.insert("raw_json".into(), Value::Null);
            o.insert("raw_json_omitted".into(), Value::Bool(true));
            o.insert("truncated".into(), Value::Bool(true));
        }
    }
    Ok(v)
}
