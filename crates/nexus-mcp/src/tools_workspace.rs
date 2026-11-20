//! Read-only workspace tools (MCP M2, `workspace_router`): saved project summaries, trace-vs-trace
//! comparison and Debug Console event queries. Nothing here writes files, loads a project into
//! the UI or touches the RX / aggregator hot path.

use crate::dbsel::DbSet;
use crate::tools_db::decode_samples;
use crate::tools_trace::LoadedTrace;
use crate::util::{
    clip, echo, fit_array, fmt_key, round, ToolError, ToolResult, TRIM_BUDGET_BYTES,
};
use nexus_core::CanIdKey;
use nexus_hal::pipeline::PipelineEngine;
use nexus_hal::storage::{read_regular_file, resolve_in_existing_dir, MAX_PROJECT_FILE_BYTES};
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};
use std::time::{SystemTime, UNIX_EPOCH};

/// Max items listed per array inside a project summary (connection profiles, DB files, ...).
pub const PROJECT_LIST_ITEMS_MAX: usize = 32;
/// Max entries in each `trace_compare` result list.
pub const COMPARE_TOP_N_MAX: u32 = 50;
/// Upper bound on distinct (id, signal) ranges tracked per trace.
pub const COMPARE_SIGNALS_MAX: usize = 2048;
/// Max frames decoded per trace for the signal min/max comparison (bounded CPU per call).
pub const COMPARE_DECODE_MAX_FRAMES: usize = 1_000_000;
/// Max `debug_events_query` rows.
pub const DEBUG_EVENTS_LIMIT_MAX: u32 = 100;

fn hal_err(what: &str, e: impl std::fmt::Display) -> ToolError {
    ToolError::new(format!("{what}: {e}"))
}

// ─── project_list / project_get ─────────────────────────────────────────────

/// Project listing that never creates the projects directory (missing dir -> empty list).
fn list_projects_readonly(
    engine: &PipelineEngine,
) -> Result<Vec<nexus_hal::dto::ProjectSummaryDto>, ToolError> {
    if !engine.data_root().projects_dir().is_dir() {
        return Ok(Vec::new());
    }
    engine
        .cmd_list_projects()
        .map_err(|e| hal_err("cannot list projects", e))
}

/// `project_list`
pub fn project_list(engine: &PipelineEngine) -> ToolResult {
    let list = list_projects_readonly(engine)?;
    let rows: Vec<Value> = list
        .iter()
        .map(|p| {
            json!({
                "name": clip(&p.name, 120),
                "file_stem": p.file_stem,
                "updated_at": clip(&p.updated_at, 40),
                "size_bytes": p.size_bytes,
            })
        })
        .collect();
    let mut v = json!({
        "count": rows.len(),
        "projects": rows,
        "note": "Saved NexusCAN projects, newest first. Pass file_stem (or name) to project_get. Listing does NOT open or load a project.",
    });
    fit_array(&mut v, "/projects", TRIM_BUDGET_BYTES);
    Ok(v)
}

fn s(v: &Value, ptr: &str, max: usize) -> Value {
    v.pointer(ptr)
        .and_then(Value::as_str)
        .map_or(Value::Null, |x| Value::String(clip(x, max)))
}

fn arr_len(v: &Value, ptr: &str) -> usize {
    v.pointer(ptr).and_then(Value::as_array).map_or(0, Vec::len)
}

fn arr<'a>(v: &'a Value, ptr: &str) -> &'a [Value] {
    v.pointer(ptr)
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
}

fn str_list(v: &Value, max_items: usize) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .take(max_items)
                .map(|x| clip(x, 80))
                .collect()
        })
        .unwrap_or_default()
}

/// Builds the bounded project summary (never the raw file, never base64 DB contents).
pub fn project_summary(file_stem: &str, size_bytes: u64, p: &Value) -> Value {
    let profiles: Vec<Value> = arr(p, "/connections/profiles")
        .iter()
        .take(PROJECT_LIST_ITEMS_MAX)
        .map(|c| {
            json!({
                "name": s(c, "/name", 80),
                "bus_id": c.get("busId").and_then(Value::as_u64),
                "driver": s(c, "/driverFamily", 40),
                "device_id": s(c, "/deviceId", 80),
                "bitrate": c.get("bitrate").and_then(Value::as_u64),
                "fd": c.get("enableFd").and_then(Value::as_bool),
                "data_bitrate": c.get("dataBitrate").and_then(Value::as_u64),
                "listen_only": c.get("listenOnly").and_then(Value::as_bool),
                "database_ids": c.get("databaseIds").map(|d| str_list(d, 8)),
            })
        })
        .collect();
    let db_files: Vec<Value> = arr(p, "/databases/customFiles")
        .iter()
        .take(PROJECT_LIST_ITEMS_MAX)
        .map(|f| {
            json!({
                "file_name": s(f, "/fileName", 120),
                "size_bytes": f.get("sizeBytes").and_then(Value::as_u64),
            })
        })
        .collect();
    let mut buses: BTreeSet<u64> = BTreeSet::new();
    for c in arr(p, "/connections/profiles") {
        if let Some(b) = c.get("busId").and_then(Value::as_u64) {
            buses.insert(b);
        }
    }
    json!({
        "file_stem": file_stem,
        "size_bytes": size_bytes,
        "name": s(p, "/name", 120),
        "version": p.get("version").cloned().unwrap_or(Value::Null),
        "project_id": s(p, "/projectId", 64),
        "created_at": s(p, "/createdAt", 40),
        "updated_at": s(p, "/updatedAt", 40),
        "notes": s(p, "/notes", 300),
        "buses": buses.into_iter().collect::<Vec<_>>(),
        "connection_profiles_total": arr_len(p, "/connections/profiles"),
        "connection_profiles": profiles,
        "active_connected_profiles": arr_len(p, "/connections/activeConnectedProfileIds"),
        "databases": {
            "use_preset_db": p.pointer("/databases/usePresetDb").and_then(Value::as_bool),
            "custom_files_total": arr_len(p, "/databases/customFiles"),
            "custom_files": db_files,
        },
        "counts": {
            "transmit_list_entries": arr_len(p, "/transmitList/entries"),
            "plotter_watched_signals": arr_len(p, "/plotter/watchedSignals"),
            "simulation_panels": arr_len(p, "/simulationPanels"),
            "diagnostic_panels": arr_len(p, "/diagnosticPanels"),
            "re_signal_drafts": arr_len(p, "/reSignals"),
        },
        "workspace": {
            "active_doc_tab": s(p, "/workspace/activeDocTab", 40),
            "theme": s(p, "/workspace/theme", 40),
            "enabled_toolpacks": p.pointer("/workspace/enabledToolpacks").map(|t| str_list(t, 16)),
        },
        "note": "Summary of the saved project file only; this does NOT open or load the project in NexusCAN and never returns database contents.",
    })
}

/// `project_get`: resolves `name` only via the engine listing (exact file stem, else unique
/// case-insensitive project name), then reads that listed file (bounded, regular file only).
pub fn project_get(engine: &PipelineEngine, name: &str) -> ToolResult {
    let wanted = name.trim();
    if wanted.is_empty() {
        return Err(ToolError::new("name must not be empty"));
    }
    let list = list_projects_readonly(engine)?;
    let found = list.iter().find(|p| p.file_stem == wanted).or_else(|| {
        let lw = wanted.to_lowercase();
        let hits: Vec<_> = list
            .iter()
            .filter(|p| p.name.to_lowercase() == lw || p.file_stem.to_lowercase() == lw)
            .collect();
        (hits.len() == 1).then(|| hits[0])
    });
    let Some(entry) = found else {
        let names: Vec<&str> = list.iter().take(20).map(|p| p.file_stem.as_str()).collect();
        return Err(ToolError::new(format!(
            "project '{}' not found (or ambiguous). Use project_list. Available: [{}]",
            echo(wanted),
            clip(&names.join(", "), 300)
        )));
    };
    if entry.size_bytes > MAX_PROJECT_FILE_BYTES {
        return Err(ToolError::new(format!(
            "project '{}' is too large to summarise ({} bytes)",
            entry.file_stem, entry.size_bytes
        )));
    }
    let path = resolve_in_existing_dir(
        engine.data_root().projects_dir(),
        &format!("{}.nexusproj.json", entry.file_stem),
    )
    .map_err(|e| hal_err("cannot resolve project", e))?;
    let raw = read_regular_file(&path, MAX_PROJECT_FILE_BYTES)
        .map_err(|e| hal_err("cannot read project", e))?;
    let parsed: Value = serde_json::from_slice(&raw)
        .map_err(|_| ToolError::new(format!("project '{}' is not valid JSON", entry.file_stem)))?;
    if !parsed.is_object() {
        return Err(ToolError::new(format!(
            "project '{}' root is not a JSON object",
            entry.file_stem
        )));
    }
    let mut v = project_summary(&entry.file_stem, raw.len() as u64, &parsed);
    fit_array(&mut v, "/connection_profiles", TRIM_BUDGET_BYTES);
    fit_array(&mut v, "/databases/custom_files", TRIM_BUDGET_BYTES);
    Ok(v)
}

// ─── trace_compare ──────────────────────────────────────────────────────────

type IdKey = (u8, CanIdKey);

#[derive(Default)]
struct IdAgg {
    count: u64,
    min_dlc: u8,
    max_dlc: u8,
}

#[derive(Clone, Copy)]
struct Range {
    min: f64,
    max: f64,
}

struct TraceAgg {
    ids: HashMap<IdKey, IdAgg>,
    signals: HashMap<(IdKey, u32), Range>,
    duration_s: f64,
    decoded_frames: usize,
    decode_capped: bool,
    signals_capped: bool,
}

fn aggregate(trace: &LoadedTrace, set: &DbSet) -> TraceAgg {
    let mut ids: HashMap<IdKey, IdAgg> = HashMap::new();
    let mut signals: HashMap<(IdKey, u32), Range> = HashMap::new();
    let mut decoded_frames = 0usize;
    let mut decode_capped = false;
    let mut signals_capped = false;
    for f in &trace.frames {
        if f.is_error {
            continue;
        }
        let key = (f.bus_id, CanIdKey::new_masked(f.arb_id, f.is_extended));
        let a = ids.entry(key).or_insert(IdAgg {
            min_dlc: u8::MAX,
            ..Default::default()
        });
        a.count += 1;
        a.min_dlc = a.min_dlc.min(f.dlc);
        a.max_dlc = a.max_dlc.max(f.dlc);
        if set.is_empty() {
            continue;
        }
        if decoded_frames >= COMPARE_DECODE_MAX_FRAMES {
            decode_capped = true;
            continue;
        }
        let Some(sel) = set.for_frame_bus(f.bus_id) else {
            continue;
        };
        let Some(msg) = sel.db.get_message(&key.1) else {
            continue;
        };
        decoded_frames += 1;
        let (decoded, _) = decode_samples(sel.db, msg, &f.raw_bytes);
        for smp in decoded.iter().filter(|x| x.physical_value.is_finite()) {
            let x = smp.physical_value;
            let sk = (key, smp.signal_id);
            if signals.len() >= COMPARE_SIGNALS_MAX && !signals.contains_key(&sk) {
                signals_capped = true;
                continue;
            }
            signals
                .entry(sk)
                .and_modify(|r| {
                    r.min = r.min.min(x);
                    r.max = r.max.max(x);
                })
                .or_insert(Range { min: x, max: x });
        }
    }
    TraceAgg {
        ids,
        signals,
        duration_s: trace.duration_us() as f64 / 1e6,
        decoded_frames,
        decode_capped,
        signals_capped,
    }
}

fn dlc_val(a: &IdAgg) -> Value {
    if a.min_dlc == a.max_dlc {
        json!(a.max_dlc)
    } else {
        json!(format!("{}-{}", a.min_dlc, a.max_dlc))
    }
}

fn rate(count: u64, duration_s: f64) -> Option<f64> {
    (duration_s > 0.0).then(|| count as f64 / duration_s)
}

fn message_name(set: &DbSet, key: &IdKey) -> Option<String> {
    set.for_frame_bus(key.0)
        .and_then(|s| s.db.get_message(&key.1).map(|m| m.name.clone()))
}

fn signal_meta(set: &DbSet, key: &IdKey, sig_id: u32) -> Option<(String, String, String)> {
    let sel = set.for_frame_bus(key.0)?;
    let msg = sel.db.get_message(&key.1)?;
    let sig = msg.all_signals.iter().find(|s| s.id == sig_id)?;
    Some((msg.name.clone(), sig.name.clone(), sig.unit.clone()))
}

fn trace_head(t: &LoadedTrace, agg: &TraceAgg) -> Value {
    json!({
        "file_name": t.file_name,
        "total_frames": t.frames.len(),
        "duration_s": round(agg.duration_s, 6),
        "distinct_ids": agg.ids.len(),
    })
}

fn only_in(set: &DbSet, x: &TraceAgg, other: &TraceAgg, top_n: usize) -> (usize, Vec<Value>) {
    let mut v: Vec<(&IdKey, &IdAgg)> = x
        .ids
        .iter()
        .filter(|(k, _)| !other.ids.contains_key(k))
        .collect();
    let total = v.len();
    v.sort_by(|a, b| b.1.count.cmp(&a.1.count).then(a.0.cmp(b.0)));
    let rows = v
        .into_iter()
        .take(top_n)
        .map(|(k, a)| {
            json!({
                "bus": k.0,
                "arb_id": fmt_key(k.1),
                "is_extended": k.1.is_extended(),
                "message": message_name(set, k),
                "count": a.count,
                "rate_hz": rate(a.count, x.duration_s).map_or(Value::Null, |r| round(r, 3)),
                "dlc": dlc_val(a),
            })
        })
        .collect();
    (total, rows)
}

/// `trace_compare`: differences between two loaded traces (IDs only in A / only in B, rate
/// change %, DLC change, per-signal min/max change when a database applies to the frame's bus).
pub fn trace_compare(a: &LoadedTrace, b: &LoadedTrace, set: &DbSet, top_n: u32) -> ToolResult {
    let top_n = top_n.clamp(1, COMPARE_TOP_N_MAX) as usize;
    let aa = aggregate(a, set);
    let ab = aggregate(b, set);

    let (only_a_total, only_a) = only_in(set, &aa, &ab, top_n);
    let (only_b_total, only_b) = only_in(set, &ab, &aa, top_n);

    let mut common: Vec<(&IdKey, &IdAgg, &IdAgg)> = aa
        .ids
        .iter()
        .filter_map(|(k, x)| ab.ids.get(k).map(|y| (k, x, y)))
        .collect();
    common.sort_by(|p, q| p.0.cmp(q.0));
    let common_total = common.len();

    // Rate changes (only when both traces have a non-zero duration).
    let mut rates: Vec<(f64, Value)> = common
        .iter()
        .filter_map(|(k, x, y)| {
            let ra = rate(x.count, aa.duration_s)?;
            let rb = rate(y.count, ab.duration_s)?;
            if ra <= 0.0 {
                return None;
            }
            let pct = (rb - ra) / ra * 100.0;
            Some((
                pct.abs(),
                json!({
                    "bus": k.0,
                    "arb_id": fmt_key(k.1),
                    "is_extended": k.1.is_extended(),
                    "message": message_name(set, k),
                    "rate_a_hz": round(ra, 3),
                    "rate_b_hz": round(rb, 3),
                    "change_pct": round(pct, 2),
                }),
            ))
        })
        .collect();
    rates.sort_by(|p, q| q.0.total_cmp(&p.0));
    let rate_rows: Vec<Value> = rates.into_iter().take(top_n).map(|r| r.1).collect();

    let dlc_all: Vec<Value> = common
        .iter()
        .filter(|(_, x, y)| x.min_dlc != y.min_dlc || x.max_dlc != y.max_dlc)
        .map(|(k, x, y)| {
            json!({
                "bus": k.0,
                "arb_id": fmt_key(k.1),
                "is_extended": k.1.is_extended(),
                "message": message_name(set, k),
                "dlc_a": dlc_val(x),
                "dlc_b": dlc_val(y),
            })
        })
        .collect();
    let dlc_total = dlc_all.len();
    let dlc_rows: Vec<Value> = dlc_all.into_iter().take(top_n).collect();

    // Signal range changes, ranked by the largest bound shift relative to the combined span.
    let mut sig_changes: Vec<(f64, Value)> = Vec::new();
    for (sk, ra) in &aa.signals {
        let Some(rb) = ab.signals.get(sk) else {
            continue;
        };
        let shift = (rb.min - ra.min).abs().max((rb.max - ra.max).abs());
        let span = ra.max.max(rb.max) - ra.min.min(rb.min);
        if shift <= 1e-9 * span.abs().max(1.0) {
            continue;
        }
        let score = if span > 0.0 { shift / span } else { shift };
        let (msg, sig, unit) = signal_meta(set, &sk.0, sk.1).unwrap_or_default();
        sig_changes.push((
            score,
            json!({
                "bus": sk.0 .0,
                "arb_id": fmt_key(sk.0 .1),
                "message": msg,
                "signal": sig,
                "unit": unit,
                "min_a": round(ra.min, 6),
                "max_a": round(ra.max, 6),
                "min_b": round(rb.min, 6),
                "max_b": round(rb.max, 6),
            }),
        ));
    }
    sig_changes.sort_by(|p, q| q.0.total_cmp(&p.0));
    let sig_total = sig_changes.len();
    let sig_rows: Vec<Value> = sig_changes.into_iter().take(top_n).map(|r| r.1).collect();

    let db_loaded = !set.is_empty();
    let mut v = json!({
        "a": trace_head(a, &aa),
        "b": trace_head(b, &ab),
        "common_ids": common_total,
        "only_in_a_total": only_a_total,
        "only_in_b_total": only_b_total,
        "dlc_changes_total": dlc_total,
        "signal_changes_total": sig_total,
        "database_loaded": db_loaded,
        "rate_basis": "rate_hz = frame count / trace duration; change_pct = (rate_b - rate_a) / rate_a * 100",
        "only_in_a": only_a,
        "only_in_b": only_b,
        "rate_changes": rate_rows,
        "dlc_changes": dlc_rows,
        "signal_changes": sig_rows,
    });
    if db_loaded {
        v["signal_decode"] = json!({
            "frames_decoded_a": aa.decoded_frames,
            "frames_decoded_b": ab.decoded_frames,
            "capped": aa.decode_capped || ab.decode_capped,
        });
        v["signals_capped"] = json!(aa.signals_capped || ab.signals_capped);
    } else {
        v["note"] = json!("No signal database loaded: signal_changes is empty.");
    }
    // Trim the largest lists first so the whole response fits the cap.
    for ptr in [
        "/signal_changes",
        "/rate_changes",
        "/only_in_b",
        "/only_in_a",
        "/dlc_changes",
    ] {
        fit_array(&mut v, ptr, TRIM_BUDGET_BYTES);
    }
    Ok(v)
}

// ─── debug_events_query ─────────────────────────────────────────────────────

/// Arguments of `debug_events_query` after deserialisation.
#[derive(Debug, Default, Clone)]
pub struct DebugQuery {
    pub level: Option<String>,
    pub category: Option<String>,
    pub since_ms: Option<u64>,
    pub text: Option<String>,
    pub limit: Option<u32>,
    pub include_mcp: Option<bool>,
}

const SEVERITIES: [&str; 5] = ["info", "success", "warn", "error", "safety"];

fn norm_level(raw: &str) -> Result<String, ToolError> {
    let l = raw.trim().to_lowercase();
    let l = match l.as_str() {
        "warning" => "warn".to_string(),
        _ => l,
    };
    if SEVERITIES.contains(&l.as_str()) {
        Ok(l)
    } else {
        Err(ToolError::new(format!(
            "invalid level '{}': expected one of info, success, warn, error, safety",
            echo(raw)
        )))
    }
}

/// `debug_events_query`: filters the buffered Debug Console events (newest first).
pub fn debug_events_query(engine: &PipelineEngine, q: &DebugQuery) -> ToolResult {
    let level = q.level.as_deref().map(norm_level).transpose()?;
    let category = q
        .category
        .as_deref()
        .map(|c| c.trim().to_uppercase())
        .filter(|c| !c.is_empty());
    if let Some(c) = &category {
        if c.chars().count() > 32 {
            return Err(ToolError::new(format!(
                "category '{}' is too long",
                echo(c)
            )));
        }
    }
    let text = q
        .text
        .as_deref()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty());
    if let Some(t) = &text {
        if t.chars().count() > 128 {
            return Err(ToolError::new(
                "text filter is too long (max 128 characters)",
            ));
        }
    }
    let limit = q.limit.unwrap_or(50).clamp(1, DEBUG_EVENTS_LIMIT_MAX) as usize;
    let include_mcp = q.include_mcp.unwrap_or(false) || category.as_deref() == Some("MCP");
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let cutoff = q.since_ms.map(|w| now_ms.saturating_sub(w));

    let batch = engine.snapshot_debug_events();
    let mut matched_total = 0usize;
    let mut rows: Vec<Value> = Vec::new();
    for e in batch.events.iter().rev() {
        if !include_mcp && e.source == "mcp" {
            continue;
        }
        if level.as_deref().is_some_and(|l| e.severity != l) {
            continue;
        }
        if category
            .as_deref()
            .is_some_and(|c| !e.category.eq_ignore_ascii_case(c))
        {
            continue;
        }
        if cutoff.is_some_and(|c| e.timestamp_ms < c) {
            continue;
        }
        if let Some(t) = &text {
            let hit = e.title.to_lowercase().contains(t)
                || e.action.to_lowercase().contains(t)
                || e.details
                    .as_deref()
                    .is_some_and(|d| d.to_lowercase().contains(t));
            if !hit {
                continue;
            }
        }
        matched_total += 1;
        if rows.len() < limit {
            let mut m = Map::new();
            m.insert("seq".into(), json!(e.seq));
            m.insert("timestamp_ms".into(), json!(e.timestamp_ms));
            m.insert(
                "age_ms".into(),
                json!(now_ms.saturating_sub(e.timestamp_ms)),
            );
            m.insert("severity".into(), json!(e.severity));
            m.insert("category".into(), json!(e.category));
            m.insert("source".into(), json!(e.source));
            m.insert("bus_id".into(), json!(e.bus_id));
            m.insert("action".into(), json!(clip(&e.action, 80)));
            m.insert("title".into(), json!(clip(&e.title, 200)));
            m.insert(
                "details".into(),
                e.details
                    .as_deref()
                    .map_or(Value::Null, |d| json!(clip(d, 300))),
            );
            if e.repeat_count > 1 {
                m.insert("repeat_count".into(), json!(e.repeat_count));
            }
            rows.push(Value::Object(m));
        }
    }
    let mut v = json!({
        "total_buffered": batch.total_buffered,
        "matched_total": matched_total,
        "returned": rows.len(),
        "order": "newest first",
        "mcp_audit_included": include_mcp,
        "events": rows,
    });
    let kept = fit_array(&mut v, "/events", TRIM_BUDGET_BYTES);
    v["returned"] = json!(kept);
    Ok(v)
}
