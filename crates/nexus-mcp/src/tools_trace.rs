//! Read-only offline trace tools (`trace_*`). Traces are loaded through the engine
//! (`cmd_list_traces` / `cmd_load_trace_file`, which sanitize names) and cached here so repeated
//! queries on the same file do not re-parse it. Raw frame lists are never dumped wholesale.

use crate::dbsel::DbSet;
use crate::tools_db::{decode_samples, find_signal, NO_DB_MESSAGE};
use crate::util::{
    echo, fit_array, fmt_id, fmt_key, hex_upper, parse_id, round, ToolError, ToolResult,
    TRIM_BUDGET_BYTES,
};
use nexus_core::CanIdKey;
use nexus_hal::dto::{ChronologicalFrameDto, TraceFileSummaryDto};
use nexus_hal::pipeline::PipelineEngine;
use nexus_netdb::CompiledDatabase;
use parking_lot::{Condvar, Mutex};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// A parsed trace with timestamps rebased so the first frame is `t_us = 0`.
pub struct LoadedTrace {
    pub file_name: String,
    pub format: String,
    pub size_bytes: u64,
    pub frames: Vec<ChronologicalFrameDto>,
    pub base_ts: u64,
}

impl LoadedTrace {
    pub fn new(summary: &TraceFileSummaryDto, frames: Vec<ChronologicalFrameDto>) -> Self {
        let base_ts = frames.iter().map(|f| f.timestamp_us).min().unwrap_or(0);
        Self {
            file_name: summary.file_name.clone(),
            format: summary.format.clone(),
            size_bytes: summary.size_bytes,
            frames,
            base_ts,
        }
    }

    #[inline]
    pub fn rel(&self, f: &ChronologicalFrameDto) -> u64 {
        f.timestamp_us.saturating_sub(self.base_ts)
    }

    pub fn duration_us(&self) -> u64 {
        self.frames.last().map(|f| self.rel(f)).unwrap_or(0)
    }
}

type CacheKey = (String, u64, String);

/// Total number of frames the trace cache may retain across all entries (MCP-QA-02).
///
/// A parsed frame costs ~300 B resident (`ChronologicalFrameDto` with its `message_key` and
/// `raw_bytes` heap buffers; QA measured ~314 B/frame), so 1,000,000 frames bound the cache at
/// roughly 300 MB. That comfortably holds the typical 10k–500k frame bench / drive-cycle traces
/// (fast repeated queries) while a 256 MB trace file (~6M frames, ~1.8 GB parsed) is still
/// analysed but never kept resident after the call.
pub const TRACE_CACHE_MAX_FRAMES: usize = 1_000_000;

/// Maximum number of distinct files kept (in addition to the frame budget).
const TRACE_CACHE_MAX_ENTRIES: usize = 4;

type LoadOutcome = Result<Arc<LoadedTrace>, ToolError>;

/// One in-progress parse that concurrent callers for the same file wait on (single-flight).
#[derive(Default)]
struct Flight {
    result: Mutex<Option<LoadOutcome>>,
    done: Condvar,
}

impl Flight {
    fn wait(&self) -> LoadOutcome {
        let mut r = self.result.lock();
        while r.is_none() {
            self.done.wait(&mut r);
        }
        r.clone()
            .unwrap_or_else(|| Err(ToolError::new("trace load failed")))
    }

    fn finish(&self, outcome: LoadOutcome) {
        let mut r = self.result.lock();
        if r.is_none() {
            *r = Some(outcome);
        }
        self.done.notify_all();
    }
}

#[derive(Default)]
struct CacheState {
    /// Most recently used first.
    entries: Vec<(CacheKey, Arc<LoadedTrace>)>,
    in_flight: HashMap<CacheKey, Arc<Flight>>,
}

impl CacheState {
    fn cached_frames(&self) -> usize {
        self.entries.iter().map(|(_, t)| t.frames.len()).sum()
    }
}

/// Point-in-time cache statistics (diagnostics / tests).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TraceCacheStats {
    pub entries: usize,
    pub cached_frames: usize,
    /// Number of trace parses performed by this cache since creation.
    pub parses: u64,
}

/// Small MRU cache keyed by `(file name, size, mtime)` from the trace listing, bounded by
/// [`TRACE_CACHE_MAX_FRAMES`] total frames. Concurrent cold loads of the same file are
/// single-flight: one caller parses, the others wait for and share its result.
pub struct TraceCache {
    state: Mutex<CacheState>,
    frame_budget: usize,
    parses: AtomicU64,
}

impl Default for TraceCache {
    fn default() -> Self {
        Self::with_frame_budget(TRACE_CACHE_MAX_FRAMES)
    }
}

/// Completes the flight even if the parser panics, so waiters never block forever.
/// Disarmed on the normal path (MCP-QA-06); when it does fire it only removes the `in_flight`
/// entry if that entry is still *its own* flight, never a newer flight for the same key.
struct FlightGuard<'a> {
    cache: &'a TraceCache,
    key: CacheKey,
    flight: Arc<Flight>,
    armed: bool,
}

impl FlightGuard<'_> {
    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for FlightGuard<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.cache
            .remove_own_flight(&mut self.cache.state.lock(), &self.key, &self.flight);
        self.flight.finish(Err(ToolError::new(
            "trace load was interrupted; retry the call",
        )));
    }
}

impl TraceCache {
    /// Cache with a custom total frame budget (tests use small budgets).
    pub fn with_frame_budget(frame_budget: usize) -> Self {
        Self {
            state: Mutex::new(CacheState::default()),
            frame_budget,
            parses: AtomicU64::new(0),
        }
    }

    pub fn stats(&self) -> TraceCacheStats {
        let st = self.state.lock();
        TraceCacheStats {
            entries: st.entries.len(),
            cached_frames: st.cached_frames(),
            parses: self.parses.load(Ordering::Relaxed),
        }
    }

    /// Drops every cached trace (called when the MCP server stops).
    pub fn clear(&self) {
        self.state.lock().entries.clear();
    }

    /// Resolves `file_name` against the engine's trace listing (exact match only, so no path
    /// ever reaches the filesystem that the engine has not listed) and returns the parsed trace.
    pub fn load(
        &self,
        engine: &PipelineEngine,
        file_name: &str,
    ) -> Result<Arc<LoadedTrace>, ToolError> {
        let name = file_name.trim();
        if name.is_empty() {
            return Err(ToolError::new("file_name must not be empty"));
        }
        let listing = engine
            .cmd_list_traces()
            .map_err(|e| ToolError::new(format!("cannot list traces: {e}")))?;
        let Some(summary) = listing.files.iter().find(|f| f.file_name == name) else {
            let available: Vec<&str> = listing
                .files
                .iter()
                .take(20)
                .map(|f| f.file_name.as_str())
                .collect();
            return Err(ToolError::new(format!(
                "trace '{}' not found. Use trace_list. Available: [{}]",
                echo(name),
                clip_list(&available)
            )));
        };
        let key: CacheKey = (
            summary.file_name.clone(),
            summary.size_bytes,
            summary.updated_at.clone(),
        );

        self.load_keyed(key, || {
            engine
                .cmd_load_trace_file(summary.file_name.clone())
                .map(|loaded| Arc::new(LoadedTrace::new(&loaded.summary, loaded.frames)))
                .map_err(|e| ToolError::new(format!("cannot load trace '{}': {e}", echo(name))))
        })
    }

    /// Removes `key` from `in_flight` only if it still maps to `flight` (MCP-QA-06).
    fn remove_own_flight(&self, st: &mut CacheState, key: &CacheKey, flight: &Arc<Flight>) {
        if st
            .in_flight
            .get(key)
            .is_some_and(|f| Arc::ptr_eq(f, flight))
        {
            st.in_flight.remove(key);
        }
    }

    /// Cache lookup + single-flight around `parse` (one parse per key at a time; concurrent
    /// callers wait for and share its result, including errors).
    fn load_keyed(&self, key: CacheKey, parse: impl FnOnce() -> LoadOutcome) -> LoadOutcome {
        let flight = {
            let mut st = self.state.lock();
            if let Some(pos) = st.entries.iter().position(|(k, _)| *k == key) {
                let hit = st.entries.remove(pos);
                let trace = Arc::clone(&hit.1);
                st.entries.insert(0, hit);
                return Ok(trace);
            }
            if let Some(f) = st.in_flight.get(&key) {
                let f = Arc::clone(f);
                drop(st);
                return f.wait();
            }
            let f = Arc::new(Flight::default());
            st.in_flight.insert(key.clone(), Arc::clone(&f));
            f
        };
        let guard = FlightGuard {
            cache: self,
            key: key.clone(),
            flight: Arc::clone(&flight),
            armed: true,
        };

        self.parses.fetch_add(1, Ordering::Relaxed);
        let outcome = parse();

        {
            let mut st = self.state.lock();
            self.remove_own_flight(&mut st, &key, &flight);
            if let Ok(trace) = &outcome {
                st.entries.retain(|(k, _)| k.0 != key.0);
                // Over-budget files are served but never retained.
                if trace.frames.len() <= self.frame_budget {
                    st.entries.insert(0, (key, Arc::clone(trace)));
                    while st.entries.len() > TRACE_CACHE_MAX_ENTRIES
                        || st.cached_frames() > self.frame_budget
                    {
                        st.entries.pop();
                    }
                }
            }
        }
        flight.finish(outcome.clone());
        guard.disarm();
        outcome
    }
}

fn clip_list(names: &[&str]) -> String {
    crate::util::clip(&names.join(", "), 300)
}

/// `trace_list`
pub fn trace_list(engine: &PipelineEngine) -> ToolResult {
    let listing = engine
        .cmd_list_traces()
        .map_err(|e| ToolError::new(format!("cannot list traces: {e}")))?;
    let files: Vec<Value> = listing
        .files
        .iter()
        .map(|f| {
            json!({
                "file_name": f.file_name,
                "format": f.format,
                "size_bytes": f.size_bytes,
                "frame_count": f.stats_known.then_some(f.frame_count),
                "duration_us": f.stats_known.then_some(f.duration_us),
                "updated_at": f.updated_at,
            })
        })
        .collect();
    let mut v = json!({
        "count": files.len(),
        "files": files,
        "note": "frame_count/duration_us are null until a file has been opened once (e.g. by trace_summary).",
    });
    fit_array(&mut v, "/files", TRIM_BUDGET_BYTES);
    Ok(v)
}

#[derive(Default)]
struct IdStats {
    bus: u8,
    key: Option<CanIdKey>,
    count: u64,
    last_ts: Option<u64>,
    n_periods: u64,
    sum: f64,
    sum_sq: f64,
    min_p: f64,
    max_p: f64,
    min_dlc: u8,
    max_dlc: u8,
    fd: bool,
}

/// `trace_summary`
pub fn trace_summary(trace: &LoadedTrace, db: Option<&CompiledDatabase>, top_n: u32) -> ToolResult {
    let top_n = top_n.clamp(1, 100) as usize;
    let mut ids: HashMap<(u8, bool, u32), IdStats> = HashMap::new();
    let mut buses: BTreeSet<u8> = BTreeSet::new();
    let mut error_frames = 0u64;
    let mut tx_frames = 0u64;
    let mut fd_frames = 0u64;
    // Top-5 longest silences between consecutive frames (any ID): (gap_us, start_us).
    let mut gaps: Vec<(u64, u64)> = Vec::new();
    let mut prev_t: Option<u64> = None;

    for f in &trace.frames {
        let t = trace.rel(f);
        buses.insert(f.bus_id);
        if let Some(p) = prev_t {
            let g = t.saturating_sub(p);
            if gaps.len() < 5 || g > gaps.last().map(|x| x.0).unwrap_or(0) {
                gaps.push((g, p));
                gaps.sort_by_key(|g| std::cmp::Reverse(g.0));
                gaps.truncate(5);
            }
        }
        prev_t = Some(t);
        if f.is_tx {
            tx_frames += 1;
        }
        if f.is_fd {
            fd_frames += 1;
        }
        if f.is_error {
            error_frames += 1;
            continue;
        }
        let st = ids
            .entry((f.bus_id, f.is_extended, f.arb_id))
            .or_insert_with(|| IdStats {
                bus: f.bus_id,
                key: Some(CanIdKey::new_masked(f.arb_id, f.is_extended)),
                min_p: f64::INFINITY,
                min_dlc: u8::MAX,
                ..Default::default()
            });
        st.count += 1;
        st.min_dlc = st.min_dlc.min(f.dlc);
        st.max_dlc = st.max_dlc.max(f.dlc);
        st.fd |= f.is_fd;
        if let Some(lt) = st.last_ts {
            let p = t.saturating_sub(lt) as f64 / 1000.0;
            st.n_periods += 1;
            st.sum += p;
            st.sum_sq += p * p;
            st.min_p = st.min_p.min(p);
            st.max_p = st.max_p.max(p);
        }
        st.last_ts = Some(t);
    }

    let distinct = ids.len();
    let mut list: Vec<IdStats> = ids.into_values().collect();
    list.sort_by(|a, b| b.count.cmp(&a.count).then(a.key.cmp(&b.key)));
    let rows: Vec<Value> = list
        .iter()
        .take(top_n)
        .map(|s| {
            let key = s.key.unwrap_or(CanIdKey::Standard(0));
            let (mean, std) = if s.n_periods > 0 {
                let n = s.n_periods as f64;
                let mean = s.sum / n;
                let var = (s.sum_sq / n - mean * mean).max(0.0);
                (Some(mean), Some(var.sqrt()))
            } else {
                (None, None)
            };
            let dlc = if s.min_dlc == s.max_dlc {
                json!(s.max_dlc)
            } else {
                json!(format!("{}-{}", s.min_dlc, s.max_dlc))
            };
            json!({
                "bus": s.bus,
                "arb_id": fmt_key(key),
                "is_extended": key.is_extended(),
                "message": db.and_then(|d| d.get_message(&key)).map(|m| m.name.clone()),
                "count": s.count,
                "avg_period_ms": mean.map_or(Value::Null, |m| round(m, 3)),
                "min_period_ms": (s.n_periods > 0).then(|| round(s.min_p, 3)),
                "max_period_ms": (s.n_periods > 0).then(|| round(s.max_p, 3)),
                "jitter_std_ms": std.map_or(Value::Null, |x| round(x, 3)),
                "dlc": dlc,
                "fd": s.fd,
            })
        })
        .collect();
    let duration_us = trace.duration_us();
    let total = trace.frames.len();
    let mut v = json!({
        "file_name": trace.file_name,
        "format": trace.format,
        "size_bytes": trace.size_bytes,
        "total_frames": total,
        "duration_us": duration_us,
        "duration_s": round(duration_us as f64 / 1e6, 6),
        "avg_frames_per_s": if duration_us > 0 { round(total as f64 * 1e6 / duration_us as f64, 1) } else { Value::Null },
        "bus_ids": buses.into_iter().collect::<Vec<_>>(),
        "distinct_ids": distinct,
        "error_frames": error_frames,
        "tx_frames": tx_frames,
        "fd_frames": fd_frames,
        "database_loaded": db.is_some(),
        "longest_gaps": gaps.iter().map(|(g, s)| json!({
            "start_us": s,
            "end_us": s + g,
            "duration_ms": round(*g as f64 / 1000.0, 3),
        })).collect::<Vec<_>>(),
        "time_base": "t_us values are microseconds relative to the first frame of the trace",
        "ids_shown": rows.len(),
        "ids": rows,
    });
    let kept = fit_array(&mut v, "/ids", TRIM_BUDGET_BYTES);
    v["ids_shown"] = json!(kept);
    if distinct > kept && v.get("truncated").is_none() {
        v["note"] = json!(format!(
            "showing the {kept} most frequent of {distinct} IDs; raise top_n (max 100) for more"
        ));
    }
    Ok(v)
}

/// Parameters of `trace_query` after defaulting.
pub struct QueryArgs {
    pub from_us: Option<u64>,
    pub to_us: Option<u64>,
    pub arb_ids: Option<Vec<String>>,
    pub limit: u32,
    pub cursor: Option<u64>,
}

/// Parses the `arb_ids` filter into exact keys (MCP-QA-04): values above `0x7FF` or written
/// with 8 hex digits (`0x000001A0`) match extended frames only; other values match standard
/// frames only. Same rule as `db_decode_frame`'s default for `is_extended`.
fn id_filter(arb_ids: &Option<Vec<String>>) -> Result<Option<Vec<CanIdKey>>, ToolError> {
    match arb_ids {
        None => Ok(None),
        Some(list) if list.is_empty() => Ok(None),
        Some(list) => {
            if list.len() > 64 {
                return Err(ToolError::new("arb_ids accepts at most 64 IDs"));
            }
            list.iter()
                .map(|s| parse_id(s).and_then(|p| p.key(None)))
                .collect::<Result<Vec<_>, _>>()
                .map(Some)
        }
    }
}

fn check_window(from: Option<u64>, to: Option<u64>) -> Result<(u64, u64), ToolError> {
    let from = from.unwrap_or(0);
    let to = to.unwrap_or(u64::MAX);
    if from > to {
        return Err(ToolError::new("from_us must be <= to_us"));
    }
    Ok((from, to))
}

/// `trace_query`: compact rows `[t_us, bus, id_hex, dlc, data_hex]`, resumable via `cursor`
/// (the frame index to continue scanning from).
pub fn trace_query(trace: &LoadedTrace, args: &QueryArgs) -> ToolResult {
    let limit = args.limit.clamp(1, 200) as usize;
    let ids = id_filter(&args.arb_ids)?;
    let (from, to) = check_window(args.from_us, args.to_us)?;
    let start = usize::try_from(args.cursor.unwrap_or(0)).unwrap_or(usize::MAX);
    let n = trace.frames.len();
    if start > n {
        return Err(ToolError::new(format!(
            "cursor {start} is past the end of the trace ({n} frames)"
        )));
    }
    let matches = |f: &ChronologicalFrameDto| {
        let t = trace.rel(f);
        t >= from
            && t <= to
            && ids.as_ref().is_none_or(|l| {
                !f.is_error && l.contains(&CanIdKey::new_masked(f.arb_id, f.is_extended))
            })
    };

    let mut rows: Vec<Value> = Vec::with_capacity(limit);
    let mut row_idx: Vec<usize> = Vec::with_capacity(limit);
    let mut more_after: Option<usize> = None;
    for (i, f) in trace.frames.iter().enumerate().skip(start) {
        if trace.rel(f) > to {
            break; // frames are chronological
        }
        if !matches(f) {
            continue;
        }
        if rows.len() == limit {
            more_after = Some(i);
            break;
        }
        let id = if f.is_error {
            "ERR".to_string()
        } else {
            fmt_id(f.arb_id, f.is_extended)
        };
        rows.push(json!([
            trace.rel(f),
            f.bus_id,
            id,
            f.dlc,
            hex_upper(&f.raw_bytes)
        ]));
        row_idx.push(i);
    }
    let matched_total = trace.frames.iter().filter(|f| matches(f)).count();
    let mut v = json!({
        "file_name": trace.file_name,
        "columns": ["t_us", "bus", "id", "dlc", "data_hex"],
        "time_base": "t_us = microseconds relative to the first frame of the trace",
        "matched_total": matched_total,
        "returned": rows.len(),
        "rows": rows,
        "truncated": false,
        "next_cursor": Value::Null,
    });
    let kept = fit_array(&mut v, "/rows", TRIM_BUDGET_BYTES);
    let next = if kept < row_idx.len() {
        Some(row_idx[kept])
    } else {
        more_after
    };
    v["returned"] = json!(kept);
    v["next_cursor"] = json!(next.map(|x| x as u64));
    if next.is_some() {
        v["truncated"] = json!(true);
    }
    Ok(v)
}

/// `trace_signal_series`: decodes one signal over the trace with the active database and returns
/// stats plus a min/max-bucket downsampled series `[[t_us, value], ...]`.
pub fn trace_signal_series(
    trace: &LoadedTrace,
    db: Option<&CompiledDatabase>,
    signal: &str,
    from_us: Option<u64>,
    to_us: Option<u64>,
    max_points: u32,
) -> ToolResult {
    let db = db.ok_or_else(|| ToolError::new(NO_DB_MESSAGE))?;
    // Single database applied to every frame.
    series_core(
        trace,
        &|_bus| Some((db, Value::Null)),
        None,
        signal,
        from_us,
        to_us,
        max_points,
    )
}

/// Multi-database variant (M1.1): each frame is decoded with its own bus's database, else the
/// global one. With `bus_id`, only that bus's frames are used, decoded with that bus's database
/// (explicit error if the bus has none).
pub fn trace_signal_series_multi(
    trace: &LoadedTrace,
    set: &DbSet,
    bus_id: Option<u8>,
    signal: &str,
    from_us: Option<u64>,
    to_us: Option<u64>,
    max_points: u32,
) -> ToolResult {
    if set.is_empty() {
        return Err(ToolError::new(NO_DB_MESSAGE));
    }
    if let Some(b) = bus_id {
        let sel = set.resolve(Some(b))?;
        let desc = sel.describe();
        let db = sel.db;
        return series_core(
            trace,
            &|bus| (bus == b).then(|| (db, desc.clone())),
            Some(b),
            signal,
            from_us,
            to_us,
            max_points,
        );
    }
    series_core(
        trace,
        &|bus| set.for_frame_bus(bus).map(|s| (s.db, s.describe())),
        None,
        signal,
        from_us,
        to_us,
        max_points,
    )
}

type FrameDbResolver<'a> = dyn Fn(u8) -> Option<(&'a CompiledDatabase, Value)> + 'a;

struct BusPlan<'a> {
    db: &'a CompiledDatabase,
    msg: &'a nexus_netdb::CompiledMessage,
    sig: &'a nexus_netdb::CompiledSignal,
    desc: Value,
}

#[allow(clippy::too_many_arguments)]
fn series_core<'a>(
    trace: &LoadedTrace,
    resolve: &FrameDbResolver<'a>,
    bus_filter: Option<u8>,
    signal: &str,
    from_us: Option<u64>,
    to_us: Option<u64>,
    max_points: u32,
) -> ToolResult {
    let (from, to) = check_window(from_us, to_us)?;
    let max_points = max_points.clamp(2, 500) as usize;

    // Per-bus resolution of (database, message, signal), computed once per bus id.
    let mut plans: HashMap<u8, Option<BusPlan<'a>>> = HashMap::new();
    let mut lookup_err: Option<ToolError> = None;
    let mut plan_for = |bus: u8| -> bool {
        plans
            .entry(bus)
            .or_insert_with(|| {
                resolve(bus).and_then(|(db, desc)| match find_signal(db, signal) {
                    Ok((msg, sig)) => Some(BusPlan { db, msg, sig, desc }),
                    Err(e) => {
                        // "exists in several messages" must surface; "not found" skips the bus.
                        if e.0.contains("several messages") {
                            lookup_err.get_or_insert(e);
                        }
                        None
                    }
                })
            })
            .is_some()
    };

    let mut samples: Vec<(u64, f64)> = Vec::new();
    let mut frames_matched = 0u64;
    let mut out_of_range = 0u64;
    let mut buses_with_signal: BTreeSet<u8> = BTreeSet::new();
    let mut bus_frames: Vec<(usize, u8)> = Vec::new();
    for (i, f) in trace.frames.iter().enumerate() {
        if f.is_error || bus_filter.is_some_and(|b| b != f.bus_id) {
            continue;
        }
        let t = trace.rel(f);
        if t < from {
            continue;
        }
        if t > to {
            break;
        }
        if plan_for(f.bus_id) {
            bus_frames.push((i, f.bus_id));
        }
    }
    if let Some(e) = lookup_err {
        return Err(e);
    }
    for (i, bus) in bus_frames {
        let f = &trace.frames[i];
        let Some(Some(p)) = plans.get(&bus) else {
            continue;
        };
        if CanIdKey::new_masked(f.arb_id, f.is_extended) != p.msg.can_id {
            continue;
        }
        frames_matched += 1;
        buses_with_signal.insert(bus);
        let (decoded, _) = decode_samples(p.db, p.msg, &f.raw_bytes);
        if let Some(s) = decoded.iter().find(|s| s.signal_id == p.sig.id) {
            if s.physical_value.is_finite() {
                samples.push((trace.rel(f), s.physical_value));
                out_of_range += u64::from(s.out_of_range);
            }
        }
    }
    let first_plan = buses_with_signal
        .iter()
        .find_map(|b| plans.get(b).and_then(Option::as_ref))
        .or_else(|| plans.values().find_map(Option::as_ref));
    let Some(plan) = first_plan else {
        return Err(ToolError::new(format!(
            "signal '{}' not found in the database(s) applicable to this trace{}; use db_search_signals to find the exact name",
            echo(signal),
            bus_filter.map(|b| format!(" (bus {b})")).unwrap_or_default()
        )));
    };
    let (msg, sig) = (plan.msg, plan.sig);
    let key = msg.can_id;
    let databases: Vec<Value> = buses_with_signal
        .iter()
        .filter_map(|b| {
            plans
                .get(b)
                .and_then(Option::as_ref)
                .map(|p| json!({ "frame_bus": b, "database": p.desc }))
        })
        .filter(|v| !v["database"].is_null())
        .collect();

    let count = samples.len();
    let (mut min, mut max, mut sum) = (f64::INFINITY, f64::NEG_INFINITY, 0.0);
    for &(_, x) in &samples {
        min = min.min(x);
        max = max.max(x);
        sum += x;
    }
    let points = downsample_min_max(&samples, max_points);
    let downsampled = points.len() < count;
    let mut v = json!({
        "file_name": trace.file_name,
        "signal": sig.name,
        "message": msg.name,
        "arb_id": fmt_key(key),
        "unit": sig.unit,
        "bus_filter": bus_filter,
        "databases_used": databases,
        "frames_matched": frames_matched,
        "sample_count": count,
        "min": if count > 0 { round(min, 9) } else { Value::Null },
        "max": if count > 0 { round(max, 9) } else { Value::Null },
        "mean": if count > 0 { round(sum / count as f64, 9) } else { Value::Null },
        "out_of_range_samples": out_of_range,
        "first_t_us": samples.first().map(|s| s.0),
        "last_t_us": samples.last().map(|s| s.0),
        "downsampled": downsampled,
        "downsample_method": if downsampled { Value::from("min_max_buckets") } else { Value::Null },
        "time_base": "t_us = microseconds relative to the first frame of the trace",
        "point_count": points.len(),
        "points": points.iter().map(|&(t, x)| json!([t, round(x, 6)])).collect::<Vec<_>>(),
    });
    if sig.has_enum_table {
        let labels: serde_json::Map<String, Value> = sig
            .enum_values
            .iter()
            .take(32)
            .map(|(k, l)| (k.to_string(), json!(l)))
            .collect();
        v["enum_labels"] = Value::Object(labels);
    }
    if frames_matched > 0 && count == 0 {
        v["note"] = json!(
            "the message occurs but this (multiplexed) signal was never active in the window"
        );
    }
    let kept = fit_array(&mut v, "/points", TRIM_BUDGET_BYTES);
    v["point_count"] = json!(kept);
    Ok(v)
}

/// Min/max bucket downsampling: splits the sample index range into `max_points / 2` buckets and
/// keeps each bucket's min and max sample (in time order). Returns the input if it already fits.
pub fn downsample_min_max(samples: &[(u64, f64)], max_points: usize) -> Vec<(u64, f64)> {
    if samples.len() <= max_points {
        return samples.to_vec();
    }
    let buckets = (max_points / 2).max(1);
    let n = samples.len();
    let mut out = Vec::with_capacity(buckets * 2);
    for b in 0..buckets {
        let lo = b * n / buckets;
        let hi = ((b + 1) * n / buckets).max(lo + 1).min(n);
        let chunk = &samples[lo..hi];
        let (mut imin, mut imax) = (0usize, 0usize);
        for (i, s) in chunk.iter().enumerate() {
            if s.1 < chunk[imin].1 {
                imin = i;
            }
            if s.1 > chunk[imax].1 {
                imax = i;
            }
        }
        match imin.cmp(&imax) {
            std::cmp::Ordering::Equal => out.push(chunk[imin]),
            std::cmp::Ordering::Less => {
                out.push(chunk[imin]);
                out.push(chunk[imax]);
            }
            std::cmp::Ordering::Greater => {
                out.push(chunk[imax]);
                out.push(chunk[imin]);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn key(name: &str) -> CacheKey {
        (name.to_string(), 1, "t".to_string())
    }

    fn wait_for_waiters(cache: &TraceCache, k: &CacheKey, waiters: usize) {
        // Flight refs: map entry + loader (+ guard) + one per waiter.
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let n = cache
                .state
                .lock()
                .in_flight
                .get(k)
                .map_or(0, Arc::strong_count);
            if n >= 3 + waiters {
                return;
            }
            assert!(Instant::now() < deadline, "waiters did not join the flight");
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    /// MCP-QA-06: a (late-firing) guard must not remove a newer flight for the same key.
    #[test]
    fn guard_only_removes_its_own_flight() {
        let cache = TraceCache::default();
        let k = key("a.log");
        let old = Arc::new(Flight::default());
        let newer = Arc::new(Flight::default());
        cache
            .state
            .lock()
            .in_flight
            .insert(k.clone(), Arc::clone(&newer));
        drop(FlightGuard {
            cache: &cache,
            key: k.clone(),
            flight: Arc::clone(&old),
            armed: true,
        });
        let st = cache.state.lock();
        assert!(Arc::ptr_eq(
            st.in_flight.get(&k).expect("newer flight kept"),
            &newer
        ));
        drop(st);
        // The fired guard still completed its own flight (waiters are released).
        assert!(old.wait().is_err());
        // Its own entry is removed.
        drop(FlightGuard {
            cache: &cache,
            key: k.clone(),
            flight: Arc::clone(&newer),
            armed: true,
        });
        assert!(cache.state.lock().in_flight.is_empty());
    }

    /// QA note on MCP-QA-02: concurrent callers share ONE parse and the SAME error.
    #[test]
    fn concurrent_loads_share_one_error() {
        let cache = TraceCache::default();
        let k = key("bad.blf");
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let results: Vec<LoadOutcome> = std::thread::scope(|s| {
            let (c, kk) = (&cache, k.clone());
            let loader = s.spawn(move || {
                c.load_keyed(kk, move || {
                    release_rx.recv().unwrap();
                    Err(ToolError::new(
                        "cannot load trace 'bad.blf': corrupt header",
                    ))
                })
            });
            wait_for_waiters(&cache, &k, 0);
            let waiters: Vec<_> = (0..4)
                .map(|_| {
                    s.spawn(|| cache.load_keyed(k.clone(), || panic!("waiter must not parse")))
                })
                .collect();
            wait_for_waiters(&cache, &k, 4);
            release_tx.send(()).unwrap();
            let mut out = vec![loader.join().unwrap()];
            out.extend(waiters.into_iter().map(|h| h.join().unwrap()));
            out
        });
        assert_eq!(cache.stats().parses, 1);
        assert_eq!(results.len(), 5);
        for r in &results {
            assert_eq!(
                r.as_ref().err().map(|e| e.0.as_str()),
                Some("cannot load trace 'bad.blf': corrupt header")
            );
        }
        assert!(cache.state.lock().in_flight.is_empty());
        assert_eq!(cache.stats().entries, 0, "errors are not cached");
    }

    /// MCP-QA-06 scenario: an uncached (over-budget) load completes while a new flight for the
    /// same key starts; the finished loader must not delete it, so a third caller joins the new
    /// flight instead of parsing again.
    #[test]
    fn finished_loader_does_not_break_a_newer_flight() {
        let cache = TraceCache::with_frame_budget(0); // nothing is ever retained
        let k = key("big.log");
        let trace = |n: usize| {
            Arc::new(LoadedTrace {
                file_name: "big.log".into(),
                format: "log".into(),
                size_bytes: 1,
                frames: vec![ChronologicalFrameDto {
                    timestamp_us: 0,
                    bus_id: 0,
                    message_key: String::new(),
                    arb_id: n as u32,
                    is_extended: false,
                    is_fd: false,
                    is_brs: false,
                    is_tx: false,
                    is_error: false,
                    error_summary: None,
                    dlc: 0,
                    raw_bytes: Vec::new(),
                }],
                base_ts: 0,
            })
        };
        assert!(cache.load_keyed(k.clone(), || Ok(trace(1))).is_ok());
        let (release_tx, release_rx) = mpsc::channel::<()>();
        std::thread::scope(|s| {
            let (c, kk) = (&cache, k.clone());
            let second = s.spawn(move || {
                c.load_keyed(kk, move || {
                    release_rx.recv().unwrap();
                    Ok(trace(2))
                })
            });
            wait_for_waiters(&cache, &k, 0);
            let third = s.spawn(|| cache.load_keyed(k.clone(), || panic!("must join flight")));
            wait_for_waiters(&cache, &k, 1);
            release_tx.send(()).unwrap();
            let a = second.join().unwrap().unwrap();
            let b = third.join().unwrap().unwrap();
            assert!(Arc::ptr_eq(&a, &b));
        });
        assert_eq!(cache.stats().parses, 2);
    }

    #[test]
    fn downsample_keeps_extremes_and_cap() {
        let samples: Vec<(u64, f64)> = (0..10_000u64)
            .map(|i| (i * 10, ((i as f64) / 100.0).sin()))
            .collect();
        let pts = downsample_min_max(&samples, 200);
        assert!(pts.len() <= 200);
        let max = pts.iter().map(|p| p.1).fold(f64::MIN, f64::max);
        let min = pts.iter().map(|p| p.1).fold(f64::MAX, f64::min);
        assert!(max > 0.999 && min < -0.999);
        assert!(pts.windows(2).all(|w| w[0].0 <= w[1].0));
        assert_eq!(downsample_min_max(&samples[..50], 200).len(), 50);
    }
}
