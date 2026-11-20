//! MCP M2 live-data tools (`app_status`, `device_list`, `driver_probe`, `bus_status`,
//! `live_message_table`, `live_signal_values`, `periodic_tx_list`, `signal_stats`,
//! `live_trace_window`). See planning/contracts/mcp-v1.md §8.
//!
//! Data sources are strictly read-only and off the hot path:
//! * one-shot tools clone [`PipelineEngine::latest_snapshot`] (the 60 Hz snapshot the aggregator
//!   already produces for the UI);
//! * the two sampling tools (`signal_stats`, `live_trace_window`) additionally hold a
//!   [`PipelineEngine::subscribe`] receiver of that same 60 Hz snapshot broadcast for a bounded
//!   time (≤ 10 s / ≤ 5 s). The aggregator does no extra work for it (the broadcast stores one
//!   value per tick regardless of receivers; a lagging receiver never blocks the sender);
//! * device / driver / periodic-TX listings use the same read-only engine calls as the UI.
//!
//! The snapshot-based cores take `Option<&TelemetrySnapshotDto>` + a [`DbSet`] so they can be
//! unit-tested with a hand-made snapshot.

use crate::dbsel::{describe, DbSet};
use crate::tools_db::find_signal;
use crate::util::{
    clip, echo, fit_array, fmt_id, hex_upper, parse_id, round, ToolError, ToolResult,
    TRIM_BUDGET_BYTES,
};
use nexus_core::CanIdKey;
use nexus_hal::dto::{
    BusHealthDto, DriverProbeReportDto, FrameTelemetryDto, LiveSignalDto, TelemetrySnapshotDto,
};
use nexus_hal::pipeline::PipelineEngine;
use nexus_netdb::{CompiledDatabase, CompiledMessage, CompiledSignal};
use parking_lot::Mutex;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::broadcast::error::TryRecvError;

// ─── Limits ─────────────────────────────────────────────────────────────────

/// Max rows of `live_message_table`.
pub const MAX_TABLE_ROWS: u32 = 100;
/// Max signal names of `live_signal_values`.
pub const MAX_LIVE_SIGNALS: usize = 32;
/// Max signal names of `signal_stats`.
pub const MAX_STATS_SIGNALS: usize = 8;
/// Upper bound of the `signal_stats` sampling window.
pub const MAX_STATS_WINDOW_MS: u32 = 10_000;
/// Upper bound of the `live_trace_window` capture window.
pub const MAX_TRACE_WINDOW_MS: u32 = 5_000;
/// Max rows of `live_trace_window`.
pub const MAX_TRACE_ROWS: u32 = 200;
/// Max CAN ID filter entries.
pub const MAX_ID_FILTERS: usize = 32;
/// Concurrent sampling calls (`signal_stats` + `live_trace_window`) allowed per engine.
pub const MAX_CONCURRENT_SAMPLERS: u32 = 2;
/// Poll interval while waiting for the next 60 Hz snapshot.
const SAMPLE_POLL: Duration = Duration::from_millis(4);
/// Size of the snapshot chronological ring (`CHRONOLOGICAL_RING_CAP` in nexus-hal).
const CHRONO_RING_CAP: usize = 2_048;

// ─── Tool input schemas ─────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct DeviceListArgs {
    /// Optional driver filter (case-insensitive), e.g. "socketcan", "mock", "gs_usb", "slcan",
    /// "pcan", "kvaser".
    #[serde(default)]
    pub driver_id: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct DriverProbeArgs {
    /// Optional driver family id (case-insensitive), e.g. "socketcan", "gs_usb", "slcan",
    /// "pcan", "kvaser", "vector_xl", "mock". With a family, its setup steps are included.
    #[serde(default)]
    pub family: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct BusStatusArgs {
    /// Optional logical bus (0 = Bus 1). Omit for every connected bus.
    #[serde(default)]
    pub bus_id: Option<u8>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TableSort {
    /// Highest message rate first (default).
    #[default]
    Rate,
    /// Ascending by bus, then standard before extended, then arbitration ID.
    Id,
    /// Most recently received first.
    Age,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct LiveMessageTableArgs {
    /// Optional logical bus (0 = Bus 1). Omit for all buses.
    #[serde(default)]
    pub bus_id: Option<u8>,
    /// Optional arbitration ID filter (max 32): "0x1A0", "416", "0x18FF50E5". IDs <= 0x7FF
    /// match standard frames only; write 8 hex digits ("0x000001A0") for a small extended ID.
    #[serde(default)]
    pub ids: Option<Vec<String>>,
    /// Sort order: "rate" (default), "id" or "age".
    #[serde(default)]
    pub sort: Option<TableSort>,
    /// Maximum rows (default 50, max 100).
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct LiveSignalValuesArgs {
    /// Signal names (max 32); use "Message.Signal" when a name exists in several messages.
    pub names: Vec<String>,
    /// Optional logical bus (0 = Bus 1): use that bus's database and frames only. Omit to use
    /// the global database (or the only bus database) and any bus decoded with it.
    #[serde(default)]
    pub bus_id: Option<u8>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct PeriodicTxListArgs {
    /// Optional logical bus (0 = Bus 1) filter.
    #[serde(default)]
    pub bus_id: Option<u8>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct SignalStatsArgs {
    /// Signal names (max 8); use "Message.Signal" when a name exists in several messages.
    pub names: Vec<String>,
    /// Sampling window in milliseconds (default 2000, min 50, max 10000). The call blocks for
    /// this long.
    #[serde(default)]
    pub window_ms: Option<u32>,
    /// Optional logical bus (0 = Bus 1), same meaning as in live_signal_values.
    #[serde(default)]
    pub bus_id: Option<u8>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct LiveTraceWindowArgs {
    /// Capture window in milliseconds (default 1000, max 5000; 0 = only the frames of the
    /// latest 60 Hz snapshot, i.e. the last ~17 ms).
    #[serde(default)]
    pub last_ms: Option<u32>,
    /// Optional arbitration ID filter (max 32), same rules as live_message_table.
    #[serde(default)]
    pub ids: Option<Vec<String>>,
    /// Optional logical bus (0 = Bus 1) filter.
    #[serde(default)]
    pub bus_id: Option<u8>,
    /// Maximum frames (default 100, max 200); capture stops early when reached.
    #[serde(default)]
    pub limit: Option<u32>,
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

/// `{ "live": false, "message": ... }` when there is no live telemetry, else `None`.
pub fn offline_reason(snap: Option<&TelemetrySnapshotDto>) -> Option<Value> {
    let msg = match snap {
        None => "no live telemetry snapshot exists yet (the NexusCAN pipeline has not produced one)",
        Some(s) if !is_live(s) => {
            "no bus is connected and no replay is running; connect a bus (or start a replay) in the NexusCAN UI first"
        }
        Some(_) => return None,
    };
    Some(json!({ "live": false, "message": msg }))
}

fn is_live(s: &TelemetrySnapshotDto) -> bool {
    !s.buses.is_empty()
        || !s.frames.is_empty()
        || matches!(s.replay.state.as_str(), "playing" | "paused")
}

fn bus_mode(b: &BusHealthDto) -> &'static str {
    if b.listen_only {
        "listen_only"
    } else if b.tx_armed {
        "armed"
    } else {
        "active_disarmed"
    }
}

/// Parses an ID filter list (MCP-QA-04 extended rule).
fn parse_id_filter(ids: Option<&[String]>) -> Result<Option<Vec<CanIdKey>>, ToolError> {
    let Some(ids) = ids else { return Ok(None) };
    if ids.is_empty() {
        return Ok(None);
    }
    if ids.len() > MAX_ID_FILTERS {
        return Err(ToolError::new(format!(
            "ids has {} entries; at most {MAX_ID_FILTERS} are allowed",
            ids.len()
        )));
    }
    ids.iter()
        .map(|s| parse_id(s).and_then(|p| p.key(None)))
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

fn id_matches(filter: Option<&[CanIdKey]>, arb_id: u32, is_extended: bool) -> bool {
    filter.is_none_or(|keys| {
        keys.iter()
            .any(|k| k.raw_id() == arb_id && k.is_extended() == is_extended)
    })
}

fn message_for(set: &DbSet, bus: u8, arb_id: u32, is_extended: bool) -> Option<&CompiledMessage> {
    set.for_frame_bus(bus).and_then(|sel| {
        sel.db
            .get_message(&CanIdKey::new_masked(arb_id, is_extended))
    })
}

fn changed_bytes(f: &FrameTelemetryDto) -> Vec<u32> {
    let mut out = Vec::new();
    for i in 0..32u32 {
        if f.changed_bytes_lo & (1 << i) != 0 {
            out.push(i);
        }
    }
    for i in 0..32u32 {
        if f.changed_bytes_hi & (1 << i) != 0 {
            out.push(32 + i);
        }
    }
    out
}

/// Age of a frame relative to the snapshot clock; `None` with hardware timestamps (other clock).
fn frame_age_ms(s: &TelemetrySnapshotDto, f: &FrameTelemetryDto) -> Option<u64> {
    (!f.has_hw_timestamp).then(|| s.timestamp_us.saturating_sub(f.last_timestamp_us) / 1_000)
}

fn validate_names(names: &[String], max: usize) -> Result<(), ToolError> {
    if names.is_empty() {
        return Err(ToolError::new(
            "names must contain at least one signal name",
        ));
    }
    if names.len() > max {
        return Err(ToolError::new(format!(
            "names has {} entries; at most {max} are allowed",
            names.len()
        )));
    }
    Ok(())
}

/// A signal name resolved against one database.
struct ResolvedSignal<'a> {
    requested: String,
    db: &'a CompiledDatabase,
    msg: &'a CompiledMessage,
    sig: &'a CompiledSignal,
}

/// Resolves `names` against the database chosen by `bus_id` (§4 rule). Unknown names become
/// per-name error entries; the call fails only if the database cannot be resolved.
fn resolve_signals<'a>(
    set: &'a DbSet,
    names: &[String],
    bus_id: Option<u8>,
) -> Result<(Vec<ResolvedSignal<'a>>, Vec<Value>, Value), ToolError> {
    let sel = set.resolve(bus_id)?;
    let mut ok = Vec::new();
    let mut errors = Vec::new();
    for n in names {
        match find_signal(sel.db, n) {
            Ok((msg, sig)) => ok.push(ResolvedSignal {
                requested: echo(n),
                db: sel.db,
                msg,
                sig,
            }),
            Err(e) => errors.push(json!({ "name": echo(n), "error": e.0 })),
        }
    }
    Ok((ok, errors, sel.describe()))
}

/// The live sample of `r` in `s`: `(frame, signal)`. Only frames decoded with the same database
/// (and on `bus_id` when given); the most recently received frame wins.
fn find_live<'s>(
    s: &'s TelemetrySnapshotDto,
    set: &DbSet,
    r: &ResolvedSignal<'_>,
    bus_id: Option<u8>,
) -> Option<(&'s FrameTelemetryDto, &'s LiveSignalDto)> {
    s.frames
        .iter()
        .filter(|f| bus_id.is_none_or(|b| f.bus_id == b))
        .filter(|f| {
            set.for_frame_bus(f.bus_id)
                .is_some_and(|sel| std::ptr::eq(sel.db, r.db))
        })
        .filter_map(|f| {
            f.signals
                .iter()
                .find(|ls| ls.signal_id == r.sig.id)
                .map(|ls| (f, ls))
        })
        .max_by_key(|(f, _)| f.last_timestamp_us)
}

fn enum_label(sig: &CompiledSignal, raw: i64) -> Value {
    sig.enum_values
        .get(&raw)
        .map_or(Value::Null, |l| json!(clip(l, 64)))
}

/// Per-engine counter of running sampling calls (keyed by engine address). The slot is released
/// by `Drop` (panic-safe); entries are removed at zero, so the map never grows unbounded.
static SAMPLERS: Mutex<Vec<(usize, u32)>> = Mutex::new(Vec::new());

struct SamplerSlot(usize);

impl SamplerSlot {
    fn acquire(engine: &PipelineEngine) -> Result<Self, ToolError> {
        let key = std::ptr::from_ref(engine) as usize;
        let mut g = SAMPLERS.lock();
        match g.iter_mut().find(|(k, _)| *k == key) {
            Some((_, n)) if *n >= MAX_CONCURRENT_SAMPLERS => Err(ToolError::new(format!(
                "too many concurrent sampling calls (signal_stats / live_trace_window, max {MAX_CONCURRENT_SAMPLERS}); wait for the running ones to finish"
            ))),
            Some((_, n)) => {
                *n += 1;
                Ok(Self(key))
            }
            None => {
                g.push((key, 1));
                Ok(Self(key))
            }
        }
    }
}

impl Drop for SamplerSlot {
    fn drop(&mut self) {
        let mut g = SAMPLERS.lock();
        if let Some(i) = g.iter().position(|(k, _)| *k == self.0) {
            g[i].1 = g[i].1.saturating_sub(1);
            if g[i].1 == 0 {
                g.swap_remove(i);
            }
        }
    }
}

// ─── app_status ─────────────────────────────────────────────────────────────

/// MCP server facts passed in by the server (the engine knows nothing about MCP).
#[derive(Clone, Copy, Debug, Default)]
pub struct McpFacts {
    pub total_calls: u64,
    pub ui_attached: bool,
}

pub fn app_status(engine: &PipelineEngine, mcp: McpFacts) -> ToolResult {
    let snap = engine.latest_snapshot();
    let set = DbSet::from_engine(engine);
    Ok(app_status_from(
        snap.as_ref(),
        &set,
        engine.is_panic_latched(),
        mcp,
    ))
}

pub fn app_status_from(
    snap: Option<&TelemetrySnapshotDto>,
    set: &DbSet,
    panic_latched: bool,
    mcp: McpFacts,
) -> Value {
    let offline = offline_reason(snap);
    let databases = json!({
        "global": set.global.as_ref().map(|(_, i)| i.name.clone()),
        "buses": set.buses.iter().map(|(b, _, i)| json!({ "bus_id": b, "name": i.name })).collect::<Vec<_>>(),
    });
    let mut o = Map::new();
    o.insert("live".into(), json!(offline.is_none()));
    if let Some(off) = &offline {
        o.insert("message".into(), off["message"].clone());
    }
    o.insert("read_only".into(), json!(true));
    o.insert(
        "mcp".into(),
        json!({ "total_calls": mcp.total_calls, "ui_attached": mcp.ui_attached }),
    );
    o.insert(
        "tx_panic_latched".into(),
        json!(panic_latched || snap.is_some_and(|s| s.tx_panic_latched)),
    );
    o.insert("databases".into(), databases);
    match snap {
        Some(s) => {
            o.insert(
                "telemetry".into(),
                json!({
                    "fps_rx": round(s.fps_rx, 1),
                    "fps_tx": round(s.fps_tx, 1),
                    "bus_load_pct": round(s.estimated_bus_load_pct, 2),
                    "total_frames_rx": s.total_frames_rx,
                    "total_frames_tx": s.total_frames_tx,
                    "total_frames_err": s.total_frames_err,
                    "dropped_frames": s.dropped_frames,
                    "active_ids": s.active_ids_count,
                    "decoded_signals": s.decoded_signals_count,
                }),
            );
            let buses: Vec<Value> = s
                .buses
                .iter()
                .map(|b| {
                    let db = set
                        .for_frame_bus(b.bus_id)
                        .map(|sel| describe(sel.scope, sel.info));
                    json!({
                        "bus_id": b.bus_id,
                        "channel_name": clip(&b.channel_name, 64),
                        "device_id": clip(&b.device_id, 96),
                        "connected": b.connected,
                        "mode": bus_mode(b),
                        "bus_state": b.bus_state,
                        "database": db,
                    })
                })
                .collect();
            o.insert("buses".into(), json!(buses));
            let r = &s.replay;
            let progress = if r.total_frames > 0 {
                round(100.0 * r.current_index as f64 / r.total_frames as f64, 1)
            } else {
                Value::Null
            };
            o.insert(
                "replay".into(),
                json!({
                    "state": r.state,
                    "source_name": clip(&r.source_name, 96),
                    "progress_pct": progress,
                    "speed_factor": round(r.speed_factor, 3),
                    "loop": r.loop_playback,
                    "transmit_to_hardware": r.transmit_to_hardware,
                }),
            );
        }
        None => {
            o.insert("telemetry".into(), Value::Null);
            o.insert("buses".into(), json!([]));
            o.insert("replay".into(), Value::Null);
        }
    }
    let mut v = Value::Object(o);
    fit_array(&mut v, "/buses", TRIM_BUDGET_BYTES);
    v
}

// ─── device_list / driver_probe ─────────────────────────────────────────────

fn validate_ident(field: &str, s: &str) -> Result<String, ToolError> {
    let t = s.trim();
    if t.is_empty()
        || t.len() > 32
        || !t
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(ToolError::new(format!(
            "invalid {field} '{}': expected a short identifier like \"socketcan\"",
            echo(s)
        )));
    }
    Ok(t.to_ascii_lowercase())
}

/// TTL of the shared device / driver scan cache.
pub const SCAN_TTL: Duration = Duration::from_secs(2);

type Cached<T> = Mutex<Option<(Instant, T)>>;

/// Single-flight + TTL cache for the expensive USB / serial scans. The lock is held during the
/// scan, so concurrent callers wait for it and then reuse the fresh result.
#[derive(Default)]
pub struct ScanCache {
    devices: Cached<Vec<nexus_hal::dto::DeviceDescriptorDto>>,
    probe: Cached<DriverProbeReportDto>,
}

fn cached_scan<T: Clone>(slot: &Cached<T>, scan: impl FnOnce() -> T) -> (T, bool) {
    let mut g = slot.lock();
    if let Some((at, v)) = g.as_ref() {
        if at.elapsed() < SCAN_TTL {
            return (v.clone(), true);
        }
    }
    let v = scan();
    *g = Some((Instant::now(), v.clone()));
    (v, false)
}

pub fn device_list(engine: &PipelineEngine, driver_id: Option<&str>) -> ToolResult {
    device_list_cached(engine, driver_id, &ScanCache::default())
}

/// `device_list` through the shared [`ScanCache`] (`cached: true` when served from it).
pub fn device_list_cached(
    engine: &PipelineEngine,
    driver_id: Option<&str>,
    cache: &ScanCache,
) -> ToolResult {
    let filter = driver_id
        .map(|d| validate_ident("driver_id", d))
        .transpose()?;
    let (all, cached) = cached_scan(&cache.devices, || engine.discover_devices());
    let mut available: Vec<String> = all.iter().map(|d| d.driver_id.clone()).collect();
    available.sort();
    available.dedup();
    let devices: Vec<Value> = all
        .iter()
        .filter(|d| {
            filter
                .as_deref()
                .is_none_or(|f| d.driver_id.eq_ignore_ascii_case(f))
        })
        .map(|d| {
            json!({
                "device_id": clip(&d.device_id, 96),
                "driver_id": d.driver_id,
                "channel_name": clip(&d.channel_name, 64),
                "display_name": clip(&d.display_name, 96),
                "supports_fd": d.capabilities.supports_fd,
                "supports_listen_only": d.capabilities.supports_listen_only,
                "hw_timestamps": d.capabilities.supports_hw_timestamps,
                "is_virtual": d.capabilities.is_virtual,
                "max_bitrate": d.capabilities.max_bitrate,
            })
        })
        .collect();
    let mut v = json!({
        "count": devices.len(),
        "devices": devices,
        "available_driver_ids": available,
        "cached": cached,
        "note": "Listing only: this tool does NOT open, connect or configure any channel.",
    });
    fit_array(&mut v, "/devices", TRIM_BUDGET_BYTES);
    Ok(v)
}

pub fn driver_probe(engine: &PipelineEngine, family: Option<&str>) -> ToolResult {
    driver_probe_cached(engine, family, &ScanCache::default())
}

/// `driver_probe` through the shared [`ScanCache`] (`cached: true` when served from it).
pub fn driver_probe_cached(
    engine: &PipelineEngine,
    family: Option<&str>,
    cache: &ScanCache,
) -> ToolResult {
    // Validate before the (comparatively slow) OS probe.
    let filter = family.map(|f| validate_ident("family", f)).transpose()?;
    // Same probe the UI runs (`cmd_probe_drivers`) minus its dead-bus reaping side effect.
    let _ = engine;
    let (report, cached) = cached_scan(&cache.probe, nexus_hal::probe_all_drivers);
    let mut v = driver_probe_from(&report, filter.as_deref())?;
    v["cached"] = json!(cached);
    Ok(v)
}

/// Compact driver-probe report. `family` must already be lower-case (see `validate_ident`).
pub fn driver_probe_from(report: &DriverProbeReportDto, family: Option<&str>) -> ToolResult {
    let ids: Vec<&str> = report
        .families
        .iter()
        .map(|f| f.family_id.as_str())
        .collect();
    if let Some(f) = family {
        if !report
            .families
            .iter()
            .any(|x| x.family_id.eq_ignore_ascii_case(f))
        {
            return Err(ToolError::new(format!(
                "unknown driver family '{}'; available: {}",
                echo(f),
                ids.join(", ")
            )));
        }
    }
    let families: Vec<Value> = report
        .families
        .iter()
        .filter(|x| family.is_none_or(|f| x.family_id.eq_ignore_ascii_case(f)))
        .map(|x| {
            let mut o = json!({
                "family_id": x.family_id,
                "display_name": clip(&x.display_name, 64),
                "installed": x.installed,
                "os_supported": x.os_supported,
                "hardware_present": x.hardware_present,
                "status": clip(&x.status_label, 96),
                "library_or_module": x.detected_library_or_module.as_deref().map(|s| clip(s, 96)),
                "architecture_note": x.architecture_note.as_deref().map(|s| clip(s, 160)),
                "detected_channels": x.detected_channels.iter().take(16).map(|c| clip(c, 64)).collect::<Vec<_>>(),
                "install_hint": clip(&x.install_hint, 200),
            });
            if family.is_some() {
                o["setup_steps"] = json!(x
                    .setup_steps
                    .iter()
                    .take(8)
                    .map(|st| json!({
                        "title": clip(&st.title, 96),
                        "description": clip(&st.description, 240),
                        "command_or_action": st.command_or_action.as_deref().map(|c| clip(c, 160)),
                        "doc_url": st.doc_url.as_deref().map(|u| clip(u, 160)),
                    }))
                    .collect::<Vec<_>>());
            }
            o
        })
        .collect();
    let h = &report.host_env;
    let mut v = json!({
        "host_os": report.host_os,
        "host": {
            "os": h.os, "arch": h.arch, "os_release": clip(&h.os_release, 96), "is_wsl": h.is_wsl,
            "udev_rules_present": h.udev_rules_present,
            "serial_permission_hint": h.serial_permission_hint.as_deref().map(|s| clip(s, 200)),
            "native_stacks": h.native_stacks.iter().take(8).map(|s| clip(s, 48)).collect::<Vec<_>>(),
        },
        "families": families,
        "usb_devices": report.usb_devices.iter().take(32).map(|u| json!({
            "vid_pid": u.vid_pid, "vendor": clip(&u.vendor_name, 64), "product": clip(&u.product_name, 64),
            "matched_family": u.matched_family, "driver_bound": u.driver_bound,
            "access_status": clip(&u.access_status, 64), "suggested_channel": u.suggested_channel,
        })).collect::<Vec<_>>(),
        "serial_ports": report.serial_ports.iter().take(32).map(|p| json!({
            "port_name": clip(&p.port_name, 64), "port_type": clip(&p.port_type, 32), "vid_pid": p.vid_pid,
            "product": p.product.as_deref().map(|s| clip(s, 64)),
        })).collect::<Vec<_>>(),
        "note": "Diagnostic probe only: this tool does NOT install drivers, load kernel modules, open channels or change any setting.",
    });
    fit_array(&mut v, "/usb_devices", TRIM_BUDGET_BYTES);
    fit_array(&mut v, "/serial_ports", TRIM_BUDGET_BYTES);
    fit_array(&mut v, "/families", TRIM_BUDGET_BYTES);
    Ok(v)
}

// ─── bus_status ─────────────────────────────────────────────────────────────

pub fn bus_status(engine: &PipelineEngine, bus_id: Option<u8>) -> ToolResult {
    bus_status_from(engine.latest_snapshot().as_ref(), bus_id)
}

pub fn bus_status_from(snap: Option<&TelemetrySnapshotDto>, bus_id: Option<u8>) -> ToolResult {
    if let Some(off) = offline_reason(snap) {
        return Ok(off);
    }
    let s = snap.expect("live snapshot");
    if let Some(b) = bus_id {
        if !s.buses.iter().any(|x| x.bus_id == b) {
            return Err(ToolError::new(format!(
                "bus {b} is not connected; connected buses: {:?}",
                s.buses.iter().map(|x| x.bus_id).collect::<Vec<_>>()
            )));
        }
    }
    let buses: Vec<Value> = s
        .buses
        .iter()
        .filter(|b| bus_id.is_none_or(|id| b.bus_id == id))
        .map(|b| {
            let rx = s.frames.iter().filter(|f| f.bus_id == b.bus_id && !f.is_tx);
            let (msgs, fps) = rx.fold((0usize, 0.0f64), |(n, hz), f| (n + 1, hz + f.frequency_hz));
            let warning = (b.listen_only_enforcement.as_deref() == Some("softwareOnly")).then_some(
                "Listen-Only is enforced in software only: TX is blocked, but the physical controller may still ACK frames",
            );
            json!({
                "bus_id": b.bus_id,
                "channel_name": clip(&b.channel_name, 64),
                "device_id": clip(&b.device_id, 96),
                "connected": b.connected,
                "mode": bus_mode(b),
                "listen_only": b.listen_only,
                "tx_armed": b.tx_armed,
                "listen_only_enforcement": b.listen_only_enforcement,
                "bus_state": b.bus_state,
                "tec": b.tx_error_count,
                "rec": b.rx_error_count,
                "rx_message_ids": msgs,
                "rx_fps_estimate": round(fps, 1),
                "warning": warning,
            })
        })
        .collect();
    let mut v = json!({
        "live": true,
        "buses": buses,
        "bus_load_pct_all_buses": round(s.estimated_bus_load_pct, 2),
        "total_frames_err": s.total_frames_err,
        "dropped_frames": s.dropped_frames,
        "tx_panic_latched": s.tx_panic_latched,
        "note": "Read-only: this tool does NOT arm, disarm or change any bus mode.",
    });
    fit_array(&mut v, "/buses", TRIM_BUDGET_BYTES);
    Ok(v)
}

// ─── live_message_table ─────────────────────────────────────────────────────

pub fn live_message_table(engine: &PipelineEngine, a: &LiveMessageTableArgs) -> ToolResult {
    let snap = engine.latest_snapshot();
    live_message_table_from(snap.as_ref(), &DbSet::from_engine(engine), a)
}

pub fn live_message_table_from(
    snap: Option<&TelemetrySnapshotDto>,
    set: &DbSet,
    a: &LiveMessageTableArgs,
) -> ToolResult {
    let filter = parse_id_filter(a.ids.as_deref())?;
    if let Some(off) = offline_reason(snap) {
        return Ok(off);
    }
    let s = snap.expect("live snapshot");
    let limit = a.limit.unwrap_or(50).clamp(1, MAX_TABLE_ROWS) as usize;
    let sort = a.sort.unwrap_or_default();
    let mut rows: Vec<&FrameTelemetryDto> = s
        .frames
        .iter()
        .filter(|f| a.bus_id.is_none_or(|b| f.bus_id == b))
        .filter(|f| id_matches(filter.as_deref(), f.arb_id, f.is_extended))
        .collect();
    let matched = rows.len();
    match sort {
        TableSort::Rate => rows.sort_by(|x, y| y.frequency_hz.total_cmp(&x.frequency_hz)),
        TableSort::Id => rows.sort_by_key(|f| (f.bus_id, f.is_extended, f.arb_id, f.is_tx)),
        TableSort::Age => rows.sort_by_key(|f| std::cmp::Reverse(f.last_timestamp_us)),
    }
    let messages: Vec<Value> = rows
        .iter()
        .take(limit)
        .map(|f| {
            let name = if f.is_error {
                None
            } else {
                message_for(set, f.bus_id, f.arb_id, f.is_extended).map(|m| m.name.clone())
            };
            json!({
                "bus_id": f.bus_id,
                "id": fmt_id(f.arb_id, f.is_extended),
                "name": name,
                "dir": if f.is_tx { "tx" } else { "rx" },
                "fd": f.is_fd,
                "error": f.error_summary.as_deref().map(|e| clip(e, 96)),
                "count": f.rx_count,
                "rate_hz": round(f.frequency_hz, 2),
                "cycle_ms": round(f.cycle_ms, 2),
                "cycle_health": f.cycle_health,
                "dlc": f.dlc,
                "data_hex": hex_upper(&f.raw_bytes),
                "changed_bytes": changed_bytes(f),
                "age_ms": frame_age_ms(s, f),
            })
        })
        .collect();
    let mut v = json!({
        "live": true,
        "sort": match sort { TableSort::Rate => "rate", TableSort::Id => "id", TableSort::Age => "age" },
        "matched_total": matched,
        "returned": messages.len(),
        "messages": messages,
    });
    let kept = fit_array(&mut v, "/messages", TRIM_BUDGET_BYTES);
    v["returned"] = json!(kept);
    Ok(v)
}

// ─── live_signal_values ─────────────────────────────────────────────────────

pub fn live_signal_values(
    engine: &PipelineEngine,
    names: &[String],
    bus_id: Option<u8>,
) -> ToolResult {
    let snap = engine.latest_snapshot();
    live_signal_values_from(snap.as_ref(), &DbSet::from_engine(engine), names, bus_id)
}

pub fn live_signal_values_from(
    snap: Option<&TelemetrySnapshotDto>,
    set: &DbSet,
    names: &[String],
    bus_id: Option<u8>,
) -> ToolResult {
    validate_names(names, MAX_LIVE_SIGNALS)?;
    let (resolved, mut errors, database) = resolve_signals(set, names, bus_id)?;
    if let Some(off) = offline_reason(snap) {
        return Ok(off);
    }
    let s = snap.expect("live snapshot");
    let mut values = Vec::with_capacity(resolved.len());
    for r in &resolved {
        match find_live(s, set, r, bus_id) {
            Some((f, ls)) => values.push(json!({
                "name": r.sig.name,
                "message": r.msg.name,
                "bus_id": f.bus_id,
                "physical": round(ls.physical_value, 6),
                "unit": r.sig.unit,
                "raw": ls.raw_int,
                "enum_label": enum_label(r.sig, ls.raw_int),
                "age_ms": ls.age_ms,
                "out_of_range": ls.out_of_range,
                "active_in_last_frame": ls.active_in_last_frame,
            })),
            None => errors.push(json!({
                "name": r.requested,
                "error": format!(
                    "no live value yet: message {} ({}) has not been received{}",
                    r.msg.name,
                    fmt_id(r.msg.can_id.raw_id(), r.msg.can_id.is_extended()),
                    bus_id.map(|b| format!(" on bus {b}")).unwrap_or_default()
                ),
            })),
        }
    }
    let mut v = json!({
        "live": true,
        "database": database,
        "values": values,
        "unavailable": errors,
    });
    fit_array(&mut v, "/values", TRIM_BUDGET_BYTES);
    fit_array(&mut v, "/unavailable", TRIM_BUDGET_BYTES);
    Ok(v)
}

// ─── periodic_tx_list ───────────────────────────────────────────────────────

pub fn periodic_tx_list(engine: &PipelineEngine, bus_id: Option<u8>) -> ToolResult {
    let set = DbSet::from_engine(engine);
    let jobs: Vec<Value> = engine
        .cmd_list_periodic_tx()
        .iter()
        .filter(|j| bus_id.is_none_or(|b| j.bus_id == b))
        .map(|j| {
            json!({
                "job_id": j.job_id,
                "label": clip(&j.label, 64),
                "bus_id": j.bus_id,
                "id": fmt_id(j.arb_id, j.is_extended),
                "name": message_for(&set, j.bus_id, j.arb_id, j.is_extended).map(|m| m.name.clone()),
                "fd": j.is_fd,
                "dlc": j.dlc,
                "data_hex": hex_upper(&j.raw_bytes),
                "interval_ms": j.interval_ms,
                "sent_count": j.sent_count,
            })
        })
        .collect();
    let mut v = json!({
        "count": jobs.len(),
        "jobs": jobs,
        "tx_panic_latched": engine.is_panic_latched(),
        "note": "Read-only listing: this tool does NOT start, stop or modify periodic TX jobs.",
    });
    fit_array(&mut v, "/jobs", TRIM_BUDGET_BYTES);
    Ok(v)
}

// ─── signal_stats ───────────────────────────────────────────────────────────

#[derive(Default)]
struct Acc {
    bus: Option<u8>,
    last_rx_count: u64,
    samples: u64,
    min: f64,
    max: f64,
    sum: f64,
    last: f64,
    last_raw: i64,
    out_of_range_seen: bool,
}

impl Acc {
    fn push(&mut self, v: f64, raw: i64, oor: bool) {
        if self.samples == 0 {
            self.min = v;
            self.max = v;
        } else {
            self.min = self.min.min(v);
            self.max = self.max.max(v);
        }
        self.samples += 1;
        self.sum += v;
        self.last = v;
        self.last_raw = raw;
        self.out_of_range_seen |= oor;
    }
}

/// One sample per snapshot in which the signal's frame was received again (≤ 60 Hz).
fn sample_into(
    s: &TelemetrySnapshotDto,
    set: &DbSet,
    resolved: &[ResolvedSignal<'_>],
    accs: &mut [Acc],
    bus_id: Option<u8>,
    first: bool,
) {
    for (r, acc) in resolved.iter().zip(accs.iter_mut()) {
        let Some((f, ls)) = find_live(s, set, r, acc.bus.or(bus_id)) else {
            continue;
        };
        let fresh = first
            || (f.rx_count > acc.last_rx_count && (ls.active_in_last_frame || ls.age_ms <= 20));
        acc.bus.get_or_insert(f.bus_id);
        acc.last_rx_count = acc.last_rx_count.max(f.rx_count);
        if fresh {
            acc.push(ls.physical_value, ls.raw_int, ls.out_of_range);
        }
    }
}

pub fn signal_stats(
    engine: &PipelineEngine,
    names: &[String],
    window_ms: Option<u32>,
    bus_id: Option<u8>,
) -> ToolResult {
    signal_stats_cancellable(engine, names, window_ms, bus_id, &AtomicBool::new(false))
}

/// [`signal_stats`] that ends its sampling loop early once `stop` is set (server shutdown).
pub fn signal_stats_cancellable(
    engine: &PipelineEngine,
    names: &[String],
    window_ms: Option<u32>,
    bus_id: Option<u8>,
    stop: &AtomicBool,
) -> ToolResult {
    validate_names(names, MAX_STATS_SIGNALS)?;
    let requested = window_ms.unwrap_or(2_000);
    let window = requested.clamp(50, MAX_STATS_WINDOW_MS);
    let set = DbSet::from_engine(engine);
    let (resolved, errors, database) = resolve_signals(&set, names, bus_id)?;
    if resolved.is_empty() {
        return Err(ToolError::new(format!(
            "none of the requested signals exist in the database: {}",
            errors
                .iter()
                .filter_map(|e| e["name"].as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    // Subscribe before reading the latest snapshot so no tick is missed in between.
    let mut rx = engine.subscribe();
    let latest = engine.latest_snapshot();
    if let Some(off) = offline_reason(latest.as_ref()) {
        return Ok(off);
    }
    let _slot = SamplerSlot::acquire(engine)?;
    let start = Instant::now();
    let deadline = start + Duration::from_millis(u64::from(window));
    let mut accs: Vec<Acc> = resolved.iter().map(|_| Acc::default()).collect();
    let mut last_seq = 0u64;
    let mut snapshots = 0u64;
    let mut gaps = 0u64;
    if let Some(s) = &latest {
        sample_into(s, &set, &resolved, &mut accs, bus_id, true);
        last_seq = s.seq;
        snapshots += 1;
    }
    while Instant::now() < deadline && !stop.load(Ordering::Relaxed) {
        match rx.try_recv() {
            Ok(s) if s.seq > last_seq => {
                sample_into(&s, &set, &resolved, &mut accs, bus_id, false);
                last_seq = s.seq;
                snapshots += 1;
            }
            Ok(_) => {}
            Err(TryRecvError::Empty) => std::thread::sleep(SAMPLE_POLL),
            Err(TryRecvError::Lagged(n)) => gaps += n,
            Err(TryRecvError::Closed) => break,
        }
    }
    drop(rx);
    let signals: Vec<Value> = resolved
        .iter()
        .zip(&accs)
        .map(|(r, a)| {
            if a.samples == 0 {
                return json!({
                    "name": r.sig.name, "message": r.msg.name, "unit": r.sig.unit, "samples": 0,
                    "note": "message not received during the window",
                });
            }
            json!({
                "name": r.sig.name,
                "message": r.msg.name,
                "bus_id": a.bus,
                "unit": r.sig.unit,
                "samples": a.samples,
                "min": round(a.min, 6),
                "max": round(a.max, 6),
                "mean": round(a.sum / a.samples as f64, 6),
                "last": round(a.last, 6),
                "last_raw": a.last_raw,
                "last_enum_label": enum_label(r.sig, a.last_raw),
                "out_of_range_seen": a.out_of_range_seen,
            })
        })
        .collect();
    Ok(json!({
        "live": true,
        "database": database,
        "window_ms": window,
        "window_clamped": window != requested,
        "elapsed_ms": start.elapsed().as_millis() as u64,
        "snapshots_seen": snapshots,
        "snapshot_gaps": gaps,
        "sampling": "one sample per 60 Hz snapshot in which the message was received again; changes between two snapshots are not seen",
        "signals": signals,
        "unavailable": errors,
    }))
}

// ─── live_trace_window ──────────────────────────────────────────────────────

fn flags(f: &nexus_hal::dto::ChronologicalFrameDto) -> String {
    let mut v: Vec<&str> = Vec::new();
    if f.is_fd {
        v.push("FD");
    }
    if f.is_brs {
        v.push("BRS");
    }
    if f.is_tx {
        v.push("TX");
    }
    if f.is_error {
        v.push("ERR");
    }
    v.join(",")
}

pub fn live_trace_window(engine: &PipelineEngine, a: &LiveTraceWindowArgs) -> ToolResult {
    live_trace_window_cancellable(engine, a, &AtomicBool::new(false))
}

/// [`live_trace_window`] that ends its capture loop early once `stop` is set (server shutdown).
pub fn live_trace_window_cancellable(
    engine: &PipelineEngine,
    a: &LiveTraceWindowArgs,
    stop: &AtomicBool,
) -> ToolResult {
    let filter = parse_id_filter(a.ids.as_deref())?;
    let window = a.last_ms.unwrap_or(1_000).min(MAX_TRACE_WINDOW_MS);
    let limit = a.limit.unwrap_or(100).clamp(1, MAX_TRACE_ROWS) as usize;
    let mut rx = engine.subscribe();
    let latest = engine.latest_snapshot();
    if let Some(off) = offline_reason(latest.as_ref()) {
        return Ok(off);
    }
    let _slot = SamplerSlot::acquire(engine)?;
    let set = DbSet::from_engine(engine);
    let mut names: HashMap<(u8, bool, u32), Option<String>> = HashMap::new();
    let mut rows: Vec<Value> = Vec::new();
    let mut t0: Option<u64> = None;
    let mut may_be_incomplete = false;
    let mut matched = 0u64;
    let mut collect = |s: &TelemetrySnapshotDto, rows: &mut Vec<Value>| {
        if s.recent_chronological.len() >= CHRONO_RING_CAP {
            may_be_incomplete = true;
        }
        for f in &s.recent_chronological {
            if a.bus_id.is_some_and(|b| f.bus_id != b)
                || !id_matches(filter.as_deref(), f.arb_id, f.is_extended)
            {
                continue;
            }
            matched += 1;
            if rows.len() >= limit {
                continue;
            }
            let base = *t0.get_or_insert(f.timestamp_us);
            let name = names
                .entry((f.bus_id, f.is_extended, f.arb_id))
                .or_insert_with(|| {
                    (!f.is_error)
                        .then(|| message_for(&set, f.bus_id, f.arb_id, f.is_extended))
                        .flatten()
                        .map(|m| m.name.clone())
                })
                .clone();
            rows.push(json!([
                f.timestamp_us.saturating_sub(base),
                f.bus_id,
                fmt_id(f.arb_id, f.is_extended),
                f.dlc,
                hex_upper(&f.raw_bytes),
                flags(f),
                name,
            ]));
        }
    };
    let start = Instant::now();
    let deadline = start + Duration::from_millis(u64::from(window));
    let mut last_seq = 0u64;
    let mut gaps = 0u64;
    if let Some(s) = &latest {
        collect(s, &mut rows);
        last_seq = s.seq;
    }
    while rows.len() < limit && Instant::now() < deadline && !stop.load(Ordering::Relaxed) {
        match rx.try_recv() {
            Ok(s) if s.seq > last_seq => {
                collect(&s, &mut rows);
                last_seq = s.seq;
            }
            Ok(_) => {}
            Err(TryRecvError::Empty) => std::thread::sleep(SAMPLE_POLL),
            Err(TryRecvError::Lagged(n)) => gaps += n,
            Err(TryRecvError::Closed) => break,
        }
    }
    drop(rx);
    let returned = rows.len();
    let mut v = json!({
        "live": true,
        "columns": ["t_us", "bus", "id", "dlc", "data_hex", "flags", "name"],
        "capture": "starts with the latest 60 Hz snapshot (~17 ms back) and listens forward for up to last_ms; stops early at limit",
        "last_ms": window,
        "elapsed_ms": start.elapsed().as_millis() as u64,
        "matched_frames": matched,
        "returned": returned,
        "limit_reached": returned >= limit,
        "capture_may_be_incomplete": may_be_incomplete || gaps > 0,
        "frames": rows,
    });
    let kept = fit_array(&mut v, "/frames", TRIM_BUDGET_BYTES);
    v["returned"] = json!(kept);
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sampler_slots_are_bounded_and_released() {
        let engine = PipelineEngine::with_registry(nexus_hal::registry::DriverRegistry::new());
        let a = SamplerSlot::acquire(&engine).expect("1");
        let b = SamplerSlot::acquire(&engine).expect("2");
        assert!(SamplerSlot::acquire(&engine).is_err(), "third is refused");
        drop(a);
        let c = SamplerSlot::acquire(&engine).expect("released slot reusable");
        drop((b, c));
        let key = std::ptr::from_ref(&engine) as usize;
        assert!(
            SAMPLERS.lock().iter().all(|(k, _)| *k != key),
            "entry removed"
        );
    }

    #[test]
    fn id_filter_respects_extended_rule() {
        let f = parse_id_filter(Some(&["0x1A0".into(), "0x000001A0".into()]))
            .unwrap()
            .unwrap();
        assert!(id_matches(Some(&f[..1]), 0x1A0, false));
        assert!(!id_matches(Some(&f[..1]), 0x1A0, true));
        assert!(id_matches(Some(&f[1..]), 0x1A0, true));
        assert!(parse_id_filter(Some(&vec!["1".to_string(); 33])).is_err());
        assert!(parse_id_filter(Some(&["zz".into()])).is_err());
        assert_eq!(parse_id_filter(Some(&[])).unwrap(), None);
    }
}
