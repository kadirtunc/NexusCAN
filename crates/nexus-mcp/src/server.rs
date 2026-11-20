//! rmcp `ServerHandler` exposing the M1 read-only tool set. Every tool:
//! * increments `total_calls`,
//! * runs its engine work on the Tokio blocking pool (`spawn_blocking`),
//! * writes one audit event (`category = "MCP"`, `source = "mcp"`) to the engine debug hub,
//! * returns a JSON text block capped at ~16 KB (`"truncated": true` when trimmed).

use crate::audit::{AuditLimiter, SuppressedSummary};
use crate::dbsel::DbSet;
use crate::tools_db;
use crate::tools_trace::{self, QueryArgs, TraceCache};
use crate::ui::{
    self, ConfirmArgs, NavigateArgs, NotifyArgs, PlotSignalsArgs, SelectMessageArgs,
    TraceFilterArgs, UiBridge, UiRateLimiter, UiRequest, UI_MAX_CALLS_PER_SEC, UI_NOT_ATTACHED,
    UI_TIMEOUT,
};
use crate::util::{clip, enforce_cap, ToolError, ToolResult, ERROR_CLIP_CHARS, MAX_RESPONSE_BYTES};
use nexus_hal::pipeline::PipelineEngine;
use parking_lot::Mutex;
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResponse, CallToolResult, ContentBlock, Implementation, ServerCapabilities,
        ServerConfig,
    },
    tool, tool_handler, tool_router, ErrorData, ServerHandler,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Shared state of one running MCP server (all sessions).
pub struct Ctx {
    pub engine: Arc<PipelineEngine>,
    pub total_calls: AtomicU64,
    /// Set on server stop; long-running samplers poll it and return early.
    pub stop: AtomicBool,
    /// Single-flight + TTL cache for `device_list` / `driver_probe`.
    pub scans: crate::tools_live::ScanCache,
    /// Held while a `trace_compare` runs (at most one at a time).
    pub compare_busy: AtomicBool,
    pub traces: TraceCache,
    audit_limiter: Mutex<AuditLimiter>,
    /// Optional frontend bridge for the `ui_*` co-pilot tools.
    pub ui: Option<Arc<dyn UiBridge>>,
    ui_limiter: Mutex<UiRateLimiter>,
}

impl Ctx {
    pub fn new(engine: Arc<PipelineEngine>) -> Self {
        Self::with_ui(engine, None)
    }

    pub fn with_ui(engine: Arc<PipelineEngine>, ui: Option<Arc<dyn UiBridge>>) -> Self {
        Self {
            engine,
            total_calls: AtomicU64::new(0),
            stop: AtomicBool::new(false),
            scans: crate::tools_live::ScanCache::default(),
            compare_busy: AtomicBool::new(false),
            traces: TraceCache::default(),
            audit_limiter: Mutex::new(AuditLimiter::new(Instant::now())),
            ui,
            ui_limiter: Mutex::new(UiRateLimiter::new(Instant::now())),
        }
    }

    pub fn ui_attached(&self) -> bool {
        self.ui.as_ref().is_some_and(|u| u.attached())
    }

    fn record_summary(&self, s: &SuppressedSummary) {
        self.engine.debug_hub().record(
            if s.errors > 0 { "warn" } else { "info" },
            "MCP",
            "mcp",
            None,
            "mcp.tool_calls_suppressed",
            s.title(),
            Some(s.details()),
        );
    }

    /// Writes the pending "not individually logged" summary: when the rate-limit window is
    /// over (`force == false`, periodic task) or unconditionally (`force == true`, server stop).
    pub fn flush_audit(&self, force: bool) {
        let now = Instant::now();
        let summary = {
            let mut l = self.audit_limiter.lock();
            if force {
                l.take_summary(now)
            } else {
                l.flush_due(now)
            }
        };
        if let Some(s) = summary {
            self.record_summary(&s);
        }
    }

    /// Rate-limited audit (MCP-QA-03). `call_no` keeps every logged call a distinct event
    /// (the hub coalesces identical titles).
    fn audit(&self, call_no: u64, tool: &'static str, args: &str, outcome: Result<(), &str>) {
        let admission = self
            .audit_limiter
            .lock()
            .admit(Instant::now(), tool, outcome.is_err());
        if let Some(s) = &admission.summary {
            self.record_summary(s);
        }
        if !admission.log_individual {
            return;
        }
        let (severity, details) = match outcome {
            Ok(()) => ("info", format!("args: {args}")),
            Err(e) => ("warn", format!("args: {args}; error: {}", clip(e, 160))),
        };
        self.engine.debug_hub().record(
            severity,
            "MCP",
            "mcp",
            None,
            "mcp.tool_call",
            format!("MCP tool call #{call_no}: {tool}"),
            Some(details),
        );
    }
}

const SERVER_INSTRUCTIONS: &str = "NexusCAN CAN/CAN-FD analyzer MCP server. \
ANALYSIS (read-only, offline): db_list / db_info show the loaded signal databases (global and \
per-bus; pass bus_id to pick a bus-bound database). db_search_signals, db_get_message, db_get_ecu, \
db_diagnostics and db_decode_frame inspect them; db_encode_frame computes a payload from physical \
values but does NOT transmit. trace_list / trace_summary / trace_query / trace_signal_series analyse \
recorded trace files: start with trace_summary, then narrow down with trace_query (paginate with \
next_cursor) or trace_signal_series. Trace times (t_us, from_us, to_us) are microseconds relative to \
the first frame; trace_compare diffs two recordings. LIVE (read-only, from the 60 Hz snapshot): app_status \
gives the overall picture (buses, databases, replay, panic latch); bus_status, device_list, driver_probe, \
live_message_table, live_signal_values, signal_stats (short sampling window), live_trace_window and \
periodic_tx_list read live state; they return live=false when no bus is streaming. WORKSPACE: \
project_list / project_get and debug_events_query (Debug Console events); run_query / run_latest \
(diagnostic flow run history) and flowlib_list / flowlib_get (saved flows, secrets redacted). \
DIAGNOSTICS (read-only, observes sessions the user opened): diag_session_info lists them; \
diag_conversation and diag_isotp_frames page their UDS / ISO-TP logs (SecurityAccess and \
Authentication data redacted); diag_passive_discovery shows passive ECU discovery results. \
REVERSE ENGINEERING (read-only, needs RE running in the app): re_status, re_scan_results, \
re_row_detail, re_series and re_correlate (targets must already be focused by the user), and \
re_dbc_generate (returns DBC text, saves nothing). UI CO-PILOT (needs the desktop window open): ui_get_state reads what the user sees; \
ui_navigate, ui_select_message, ui_trace_filter and ui_plot_signals change only what is displayed; \
ui_notify shows a short message; ui_confirm asks the user a yes/no question - use it before any \
multi-step UI change the user did not explicitly request. SAFETY: no tool can transmit frames, arm a \
bus, change bus modes, run UDS/diagnostic requests, flash ECUs, start replays or load databases. \
Responses are capped at ~16 KB; when \"truncated\" is true, narrow the request.";

// ─── Tool input schemas ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SearchSignalsArgs {
    /// Case-insensitive text matched against signal names, long names, message names and
    /// signal comments (substring match). Example: "soc", "cell_volt", "BMS_Status".
    pub query: String,
    /// Maximum number of results (default 20, max 50).
    #[serde(default)]
    pub limit: Option<u32>,
    /// Optional logical bus (0 = Bus 1) whose bus-bound database to use. Omit to use the
    /// global database (or the only bus database when there is no global one).
    #[serde(default)]
    pub bus_id: Option<u8>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetMessageArgs {
    /// CAN arbitration ID: hex with 0x prefix ("0x1A0", "0x18FEF100") or decimal ("416").
    /// IDs up to 0x7FF try the standard message first; 8 hex digits ("0x000001A0") or values
    /// above 0x7FF look up extended messages only. Takes precedence over `name`.
    #[serde(default)]
    pub id: Option<String>,
    /// Message name (case-insensitive; a unique substring is also accepted).
    #[serde(default)]
    pub name: Option<String>,
    /// Optional logical bus (0 = Bus 1) whose bus-bound database to use. Omit to use the
    /// global database (or the only bus database when there is no global one).
    #[serde(default)]
    pub bus_id: Option<u8>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DecodeFrameArgs {
    /// CAN arbitration ID: hex with 0x prefix ("0x1A0", "0x18FEF100"; "0x000001A0" = 29-bit)
    /// or decimal ("416").
    pub arb_id: String,
    /// true for a 29-bit extended ID. Default: true when the ID is above 0x7FF or written with
    /// all 8 hex digits ("0x000001A0"), otherwise false (11-bit standard).
    #[serde(default)]
    pub is_extended: Option<bool>,
    /// Payload bytes as hex, 0..64 bytes (CAN-FD supported). Separators are allowed:
    /// "11223344", "11 22 33 44", "11:22:33:44".
    pub data_hex: String,
    /// Optional logical bus (0 = Bus 1) whose bus-bound database to use. Omit to use the
    /// global database (or the only bus database when there is no global one).
    #[serde(default)]
    pub bus_id: Option<u8>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TraceSummaryArgs {
    /// Trace file name exactly as returned by trace_list (e.g. "drive_cycle.asc").
    pub file_name: String,
    /// Number of most frequent IDs to include in the per-ID table (default 30, max 100).
    #[serde(default)]
    pub top_n: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TraceQueryArgs {
    /// Trace file name exactly as returned by trace_list.
    pub file_name: String,
    /// Window start in microseconds relative to the first frame (inclusive). Default 0.
    #[serde(default)]
    pub from_us: Option<u64>,
    /// Window end in microseconds relative to the first frame (inclusive). Default: end of trace.
    #[serde(default)]
    pub to_us: Option<u64>,
    /// Only return frames with these arbitration IDs; max 64. IDs above 0x7FF match 29-bit
    /// extended frames; IDs up to 0x7FF match 11-bit standard frames only. Write all 8 hex
    /// digits to select an extended frame with a small ID ("0x000001A0"). Examples: "0x1A0",
    /// "416", "0x18FEF100".
    #[serde(default)]
    pub arb_ids: Option<Vec<String>>,
    /// Maximum rows per page (default 100, max 200). Large CAN-FD payloads may return fewer
    /// rows to stay under the size cap.
    #[serde(default)]
    pub limit: Option<u32>,
    /// Pagination cursor: pass the `next_cursor` value from the previous response. Omit for
    /// the first page.
    #[serde(default)]
    pub cursor: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TraceSignalSeriesArgs {
    /// Trace file name exactly as returned by trace_list.
    pub file_name: String,
    /// Signal name from the loaded database; use "Message.Signal" when the name exists in
    /// several messages. Find names with db_search_signals.
    pub signal: String,
    /// Window start in microseconds relative to the first frame (inclusive).
    #[serde(default)]
    pub from_us: Option<u64>,
    /// Window end in microseconds relative to the first frame (inclusive).
    #[serde(default)]
    pub to_us: Option<u64>,
    /// Maximum number of points in the returned series (default 200, max 500); longer series
    /// are downsampled with min/max buckets so peaks are preserved.
    #[serde(default)]
    pub max_points: Option<u32>,
    /// Optional bus filter: only frames recorded on this bus, decoded with that bus's database.
    /// Omit to decode every frame with its own bus's database, falling back to the global one.
    #[serde(default)]
    pub bus_id: Option<u8>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetEcuArgs {
    /// ECU / node name as defined in the database (case-insensitive), e.g. "BMS".
    pub name: String,
    /// Optional logical bus (0 = Bus 1) whose bus-bound database to use. Omit to use the
    /// global database (or the only bus database when there is no global one).
    #[serde(default)]
    pub bus_id: Option<u8>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DiagSeverityArg {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DiagnosticsArgs {
    /// Only return diagnostics of this severity.
    #[serde(default)]
    pub severity: Option<DiagSeverityArg>,
    /// Maximum number of diagnostics (default 20, max 50).
    #[serde(default)]
    pub limit: Option<u32>,
    /// Optional logical bus (0 = Bus 1) whose bus-bound database to use. Omit to use the
    /// global database (or the only bus database when there is no global one).
    #[serde(default)]
    pub bus_id: Option<u8>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EncodeFrameArgs {
    /// Target message: arbitration ID ("0x1A0", "416", "0x000001A0" = 29-bit) or message name.
    pub message: String,
    /// Physical (engineering-unit) values by signal name, e.g. {"Speed": 72.5, "Gear": 3}.
    /// Values outside a signal's [min,max] are clamped and reported. Signals not listed use
    /// their initial value (GenSigStartValue) or 0; multiplexer selectors required by the given
    /// signals are filled in automatically. Max 64 entries.
    #[serde(default)]
    pub signals: std::collections::BTreeMap<String, f64>,
    /// Optional logical bus (0 = Bus 1) whose bus-bound database to use. Omit to use the
    /// global database (or the only bus database when there is no global one).
    #[serde(default)]
    pub bus_id: Option<u8>,
}

fn opt<T: std::fmt::Display>(v: &Option<T>) -> String {
    v.as_ref()
        .map_or_else(|| "-".to_string(), |x| x.to_string())
}

fn s64(s: &str) -> String {
    clip(s, 64)
}

mod diag;
mod live;
mod re;
mod runs;
mod workspace;

// ─── Server ─────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct NexusMcpServer {
    ctx: Arc<Ctx>,
    tool_router: ToolRouter<Self>,
}

impl NexusMcpServer {
    pub fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            tool_router: Self::tool_router()
                + Self::live_router()
                + Self::workspace_router()
                + Self::diag_router()
                + Self::re_router()
                + Self::runs_router(),
        }
    }

    async fn run<F>(
        &self,
        tool: &'static str,
        args_summary: String,
        f: F,
    ) -> Result<CallToolResult, ErrorData>
    where
        F: FnOnce(&Ctx) -> ToolResult + Send + 'static,
    {
        let ctx = Arc::clone(&self.ctx);
        let call_no = ctx.total_calls.fetch_add(1, Ordering::Relaxed) + 1;
        let joined = tokio::task::spawn_blocking(move || {
            let res = f(&ctx);
            ctx.audit(
                call_no,
                tool,
                &args_summary,
                res.as_ref().map(|_| ()).map_err(|e| e.0.as_str()),
            );
            res
        })
        .await;
        match joined {
            Ok(outcome) => Ok(to_call_result(outcome)),
            Err(join) => Err(ErrorData::internal_error(
                format!("{tool} worker failed: {join}"),
                None,
            )),
        }
    }

    /// Runs one `ui_*` tool: validation result -> rate limit -> attached check -> bridge call
    /// (with a hard timeout) -> audit. Never touches the engine except for the audit record.
    async fn run_ui(
        &self,
        tool: &'static str,
        args_summary: String,
        request: Result<UiRequest, ToolError>,
    ) -> Result<CallToolResult, ErrorData> {
        let ctx = Arc::clone(&self.ctx);
        let call_no = ctx.total_calls.fetch_add(1, Ordering::Relaxed) + 1;
        let outcome = ui_outcome(&ctx, request).await;
        let err_text = outcome.as_ref().err().map(|e| e.0.clone());
        let audit_ctx = Arc::clone(&ctx);
        let _ = tokio::task::spawn_blocking(move || {
            audit_ctx.audit(
                call_no,
                tool,
                &args_summary,
                err_text.as_deref().map_or(Ok(()), Err),
            );
        })
        .await;
        Ok(to_call_result(outcome))
    }
}

async fn ui_outcome(ctx: &Ctx, request: Result<UiRequest, ToolError>) -> ToolResult {
    let r = request?;
    let allowed = ctx.ui_limiter.lock().try_acquire(Instant::now());
    if !allowed {
        return Err(ToolError::new(format!(
            "ui_* rate limit exceeded (max {UI_MAX_CALLS_PER_SEC} calls per second); slow down"
        )));
    }
    let Some(ui) = ctx.ui.as_ref().filter(|u| u.attached()).cloned() else {
        return Err(ToolError::new(UI_NOT_ATTACHED));
    };
    let is_confirm = r.kind == "confirm";
    let fut = ui.call(r.kind, r.args, r.timeout);
    // Hard upper bound in case a bridge ignores its timeout.
    let res = match tokio::time::timeout(r.timeout + Duration::from_secs(1), fut).await {
        Ok(res) => res,
        Err(_) => Err(UI_TIMEOUT.to_string()),
    };
    match res {
        Ok(v) if v.is_object() => Ok(v),
        Ok(v) => Ok(json!({ "result": v })),
        Err(e) if is_confirm && e == UI_TIMEOUT => {
            Ok(json!({ "confirmed": false, "timedOut": true }))
        }
        Err(e) => Err(ToolError::new(e)),
    }
}

/// JSON text result; errors as `{ "error": ... }` tool errors. Both paths are size-capped.
fn to_call_result(outcome: ToolResult) -> CallToolResult {
    match outcome {
        Ok(value) => CallToolResult::success(vec![ContentBlock::text(enforce_cap(value))]),
        // Error messages are already clipped (`ToolError::new`); the cap is enforced here too
        // so no error path can exceed the response limit (MCP-QA-01).
        Err(e) => CallToolResult::error(vec![ContentBlock::text(enforce_cap(
            json!({ "error": e.0 }),
        ))]),
    }
}

#[tool_router]
impl NexusMcpServer {
    #[tool(
        name = "db_info",
        description = "Summary of the signal databases (.dbc/.kcd) loaded in NexusCAN: {loaded, global: summary|null, buses: [{bus_id, ...summary}]}. Each summary has name, format, ECU/message/signal counts, CAN-FD / extended / multiplexed message counts, ECU names and parse diagnostics. Returns loaded=false with an explanation when no database is loaded. Call this first before other db_* tools.",
        annotations(
            title = "Database info",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn db_info(&self) -> Result<CallToolResult, ErrorData> {
        self.run("db_info", String::new(), |ctx| {
            Ok(tools_db::db_info_all(&DbSet::from_engine(&ctx.engine)))
        })
        .await
    }

    #[tool(
        name = "db_search_signals",
        description = "Search signals in the loaded database by case-insensitive substring over signal name, long name, message name and comment. Each result has: signal name, message name and arb_id (hex), unit, factor, offset, min, max, start_bit, length, byte_order (intel/motorola), value_type (signed/float), multiplexing info, whether a value table (enum) exists, and a shortened comment. Best matches (exact name, then prefix) come first.",
        annotations(
            title = "Search signals",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn db_search_signals(
        &self,
        Parameters(a): Parameters<SearchSignalsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "query={} limit={} bus={}",
            s64(&a.query),
            opt(&a.limit),
            opt(&a.bus_id)
        );
        self.run("db_search_signals", summary, move |ctx| {
            let set = DbSet::from_engine(&ctx.engine);
            let sel = set.resolve(a.bus_id)?;
            tools_db::db_search_signals(Some(sel.db), &a.query, a.limit.unwrap_or(20))
                .map(|v| tools_db::with_database(v, &sel))
        })
        .await
    }

    #[tool(
        name = "db_get_message",
        description = "Full definition of one message from the loaded database, looked up by arbitration ID (\"0x1A0\" or decimal) or by name: DLC, protocol (classical/CAN-FD/J1939), transmitters, cycle time, comment, multiplexer structure summary (switch, branches and their signals) and every signal's bit layout and scaling.",
        annotations(title = "Get message", read_only_hint = true, open_world_hint = false)
    )]
    async fn db_get_message(
        &self,
        Parameters(a): Parameters<GetMessageArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "id={} name={} bus={}",
            opt(&a.id.as_deref().map(s64)),
            opt(&a.name.as_deref().map(s64)),
            opt(&a.bus_id)
        );
        self.run("db_get_message", summary, move |ctx| {
            let set = DbSet::from_engine(&ctx.engine);
            let sel = set.resolve(a.bus_id)?;
            tools_db::db_get_message(Some(sel.db), a.id.as_deref(), a.name.as_deref())
                .map(|v| tools_db::with_database(v, &sel))
        })
        .await
    }

    #[tool(
        name = "db_decode_frame",
        description = "Decode one raw CAN / CAN-FD frame (up to 64 data bytes) with the loaded database. Returns the message name, active multiplexer values and per signal: physical value, unit, raw integer, value-table label (enum_label) when defined, and out_of_range against the signal's [min,max]. Returns matched=false when the ID is not in the database.",
        annotations(title = "Decode frame", read_only_hint = true, open_world_hint = false)
    )]
    async fn db_decode_frame(
        &self,
        Parameters(a): Parameters<DecodeFrameArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "arb_id={} ext={} bytes~{} bus={}",
            s64(&a.arb_id),
            opt(&a.is_extended),
            a.data_hex.chars().filter(char::is_ascii_hexdigit).count() / 2,
            opt(&a.bus_id)
        );
        self.run("db_decode_frame", summary, move |ctx| {
            let set = DbSet::from_engine(&ctx.engine);
            let sel = set.resolve(a.bus_id)?;
            tools_db::db_decode_frame(Some(sel.db), &a.arb_id, a.is_extended, &a.data_hex)
                .map(|v| tools_db::with_database(v, &sel))
        })
        .await
    }

    #[tool(
        name = "trace_list",
        description = "List recorded trace files stored by NexusCAN (.trc, .asc, .blf, .log, .csv): file name, format, size, and frame count / duration when already known (null until the file has been opened once). Use the exact file_name with the other trace_* tools.",
        annotations(title = "List traces", read_only_hint = true, open_world_hint = false)
    )]
    async fn trace_list(&self) -> Result<CallToolResult, ErrorData> {
        self.run("trace_list", String::new(), |ctx| {
            tools_trace::trace_list(&ctx.engine)
        })
        .await
    }

    #[tool(
        name = "trace_summary",
        description = "Statistical overview of one trace file: duration, total frames, average frame rate, bus ids, error/TX/CAN-FD frame counts, the 5 longest silent gaps, and for the most frequent IDs: count, average/min/max period (ms), jitter (standard deviation of the period, ms), DLC, CAN-FD flag and the database message name when a database is loaded. Best first step for analysing a trace.",
        annotations(
            title = "Trace summary",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn trace_summary(
        &self,
        Parameters(a): Parameters<TraceSummaryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!("file={} top_n={}", s64(&a.file_name), opt(&a.top_n));
        self.run("trace_summary", summary, move |ctx| {
            let trace = ctx.traces.load(&ctx.engine, &a.file_name)?;
            let set = DbSet::from_engine(&ctx.engine);
            let sel = set.resolve(None).ok();
            tools_trace::trace_summary(&trace, sel.as_ref().map(|s| s.db), a.top_n.unwrap_or(30))
        })
        .await
    }

    #[tool(
        name = "trace_query",
        description = "Page through raw frames of a trace file, optionally filtered by time window (from_us/to_us, microseconds relative to the first frame) and arbitration IDs (IDs <= 0x7FF match standard frames only; use 8 hex digits like 0x000001A0 for a small extended ID). Returns compact rows [t_us, bus, id_hex, dlc, data_hex], matched_total, and next_cursor; call again with cursor=next_cursor to get the next page (next_cursor is null at the end). Never returns the whole trace at once.",
        annotations(
            title = "Query trace frames",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn trace_query(
        &self,
        Parameters(a): Parameters<TraceQueryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "file={} from_us={} to_us={} ids={} limit={} cursor={}",
            s64(&a.file_name),
            opt(&a.from_us),
            opt(&a.to_us),
            a.arb_ids.as_ref().map_or(0, Vec::len),
            opt(&a.limit),
            opt(&a.cursor)
        );
        self.run("trace_query", summary, move |ctx| {
            let trace = ctx.traces.load(&ctx.engine, &a.file_name)?;
            tools_trace::trace_query(
                &trace,
                &QueryArgs {
                    from_us: a.from_us,
                    to_us: a.to_us,
                    arb_ids: a.arb_ids,
                    limit: a.limit.unwrap_or(100),
                    cursor: a.cursor,
                },
            )
        })
        .await
    }

    #[tool(
        name = "trace_signal_series",
        description = "Decode one database signal across a trace file using the loaded database and return min/max/mean, sample count and a time series [[t_us, value], ...] downsampled with min/max buckets (peaks preserved) to at most max_points. Times are microseconds relative to the first frame. Requires a loaded database.",
        annotations(
            title = "Signal time series",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn trace_signal_series(
        &self,
        Parameters(a): Parameters<TraceSignalSeriesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "file={} signal={} from_us={} to_us={} max_points={} bus={}",
            s64(&a.file_name),
            s64(&a.signal),
            opt(&a.from_us),
            opt(&a.to_us),
            opt(&a.max_points),
            opt(&a.bus_id)
        );
        self.run("trace_signal_series", summary, move |ctx| {
            let trace = ctx.traces.load(&ctx.engine, &a.file_name)?;
            let set = DbSet::from_engine(&ctx.engine);
            tools_trace::trace_signal_series_multi(
                &trace,
                &set,
                a.bus_id,
                &a.signal,
                a.from_us,
                a.to_us,
                a.max_points.unwrap_or(200),
            )
        })
        .await
    }

    #[tool(
        name = "db_list",
        description = "List every signal database loaded in NexusCAN: the global database and each bus-bound database (scope, bus_id, name, format, message/signal/ECU counts, diagnostic count), plus the names of the built-in preset database files. MCP cannot load databases; the user loads them in the NexusCAN UI.",
        annotations(
            title = "List databases",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn db_list(&self) -> Result<CallToolResult, ErrorData> {
        self.run("db_list", String::new(), |ctx| {
            let set = DbSet::from_engine(&ctx.engine);
            let presets: Vec<String> = ctx
                .engine
                .cmd_get_preset_database_files()
                .map(|v| v.into_iter().map(|f| f.file_name).collect())
                .unwrap_or_default();
            Ok(tools_db::db_list(&set, &presets))
        })
        .await
    }

    #[tool(
        name = "db_get_ecu",
        description = "Describe one ECU (network node) from the database: its comment, the messages it transmits (TX) and the messages it receives signals from (RX), each with name, arbitration ID (hex) and signal count.",
        annotations(title = "Get ECU", read_only_hint = true, open_world_hint = false)
    )]
    async fn db_get_ecu(
        &self,
        Parameters(a): Parameters<GetEcuArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!("name={} bus={}", s64(&a.name), opt(&a.bus_id));
        self.run("db_get_ecu", summary, move |ctx| {
            let set = DbSet::from_engine(&ctx.engine);
            let sel = set.resolve(a.bus_id)?;
            tools_db::db_get_ecu(&sel, &a.name)
        })
        .await
    }

    #[tool(
        name = "db_diagnostics",
        description = "Parse/compile diagnostics of a loaded database (.dbc/.kcd): severity, code, message, line/column and context, plus counts per severity. Use it to explain why signals look wrong or were skipped. Optional severity filter (error|warning|info).",
        annotations(
            title = "Database diagnostics",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn db_diagnostics(
        &self,
        Parameters(a): Parameters<DiagnosticsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sev = a.severity.as_ref().map(|s| match s {
            DiagSeverityArg::Error => "error",
            DiagSeverityArg::Warning => "warning",
            DiagSeverityArg::Info => "info",
        });
        let summary = format!(
            "severity={} limit={} bus={}",
            opt(&sev),
            opt(&a.limit),
            opt(&a.bus_id)
        );
        self.run("db_diagnostics", summary, move |ctx| {
            let set = DbSet::from_engine(&ctx.engine);
            let sel = set.resolve(a.bus_id)?;
            tools_db::db_diagnostics(&sel, sev, a.limit.unwrap_or(20))
        })
        .await
    }

    #[tool(
        name = "db_encode_frame",
        description = "Compute the CAN/CAN-FD payload for a message from physical signal values using the NexusCAN TX encoder (offline calculation). This tool does NOT transmit anything to any bus. Values are clamped to each signal's [min,max] and clamped signals are reported; unspecified signals use their initial value or 0 (reported per signal as source); required multiplexer selectors are set automatically. Unknown signal names are an error. Returns data_hex, dlc and the decoded value of every signal.",
        annotations(
            title = "Encode frame (no transmit)",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn db_encode_frame(
        &self,
        Parameters(a): Parameters<EncodeFrameArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "message={} signals={} bus={}",
            s64(&a.message),
            a.signals.len(),
            opt(&a.bus_id)
        );
        self.run("db_encode_frame", summary, move |ctx| {
            let set = DbSet::from_engine(&ctx.engine);
            let sel = set.resolve(a.bus_id)?;
            tools_db::db_encode_frame(&sel, &a.message, &a.signals)
        })
        .await
    }

    // ─── UI co-pilot (view / navigation only; no bus access) ────────────────

    #[tool(
        name = "ui_get_state",
        description = "Read what the user currently sees in the NexusCAN window: active view and sub-tab, selected message (busId, arbId, name), plotted signals, Trace view ID filter, active trace session and theme. Requires the desktop window to be open.",
        annotations(
            title = "UI: get state",
            read_only_hint = true,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    async fn ui_get_state(&self) -> Result<CallToolResult, ErrorData> {
        self.run_ui("ui_get_state", String::new(), Ok(ui::get_state()))
            .await
    }

    #[tool(
        name = "ui_navigate",
        description = "Switch the NexusCAN window to a view: start, connections, rxtx, trace, plotter, symbols, panels, diagnostics, re. Optional subTab for diagnostics (ecu_registry, workbench, session, ecu_graph, dtc, live_pids, uds_console, did_inspector, flow, uds_panel) and symbols (messages, ecus, diagnostics). Changes only what is displayed; never touches a bus.",
        annotations(
            title = "UI: navigate",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn ui_navigate(
        &self,
        Parameters(a): Parameters<NavigateArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "view={} subTab={}",
            a.view.as_str(),
            opt(&a.sub_tab.map(|t| t.as_str()))
        );
        self.run_ui("ui_navigate", summary, ui::navigate(&a)).await
    }

    #[tool(
        name = "ui_select_message",
        description = "Select (highlight) a message in the NexusCAN window by arbitration ID so the user sees its signals. Returns {found, name}. Display only; nothing is transmitted.",
        annotations(
            title = "UI: select message",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn ui_select_message(
        &self,
        Parameters(a): Parameters<SelectMessageArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "arbId={} ext={} bus={}",
            s64(&a.arb_id),
            opt(&a.is_extended),
            opt(&a.bus_id)
        );
        self.run_ui("ui_select_message", summary, ui::select_message(&a))
            .await
    }

    #[tool(
        name = "ui_trace_filter",
        description = "Set the Trace view ID filter to the given arbitration IDs (max 64), or clear it with ids=null. Display only.",
        annotations(
            title = "UI: trace filter",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn ui_trace_filter(
        &self,
        Parameters(a): Parameters<TraceFilterArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!("ids={}", a.ids.as_ref().map_or(-1, |v| v.len() as i64));
        self.run_ui("ui_trace_filter", summary, ui::trace_filter(&a))
            .await
    }

    #[tool(
        name = "ui_plot_signals",
        description = "Add and/or remove signals in the NexusCAN plotter (max 16 names each; clear=true removes all first). Returns {plotSignals, unknown} where unknown lists names the UI could not find. Display only.",
        annotations(
            title = "UI: plot signals",
            read_only_hint = false,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    async fn ui_plot_signals(
        &self,
        Parameters(a): Parameters<PlotSignalsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "add={} remove={} clear={}",
            a.add.as_ref().map_or(0, Vec::len),
            a.remove.as_ref().map_or(0, Vec::len),
            opt(&a.clear)
        );
        self.run_ui("ui_plot_signals", summary, ui::plot_signals(&a))
            .await
    }

    #[tool(
        name = "ui_notify",
        description = "Show a short notification labelled \"Claude\" in the NexusCAN window (level info|warn|success, text up to 200 characters). Use sparingly to tell the user what you found or changed.",
        annotations(
            title = "UI: notify",
            read_only_hint = false,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    async fn ui_notify(
        &self,
        Parameters(a): Parameters<NotifyArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!("level={:?} chars={}", a.level, a.text.chars().count());
        self.run_ui("ui_notify", summary, ui::notify(&a)).await
    }

    #[tool(
        name = "ui_confirm",
        description = "Ask the user a yes/no question in the NexusCAN window; use before any multi-step UI change the user did not explicitly request. Returns {confirmed: bool}; if the user does not answer within 60 s, returns {confirmed: false, timedOut: true}.",
        annotations(
            title = "UI: confirm",
            read_only_hint = false,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    async fn ui_confirm(
        &self,
        Parameters(a): Parameters<ConfirmArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!("title={}", s64(&a.title));
        self.run_ui("ui_confirm", summary, ui::confirm(&a)).await
    }
}

/// Clips text produced by rmcp itself before our handlers run (MCP-QA-05): argument
/// deserialization errors (`failed to deserialize parameters: <serde error>`) quote the
/// offending value verbatim and never pass through `run()` / `enforce_cap`.
fn sanitize_call_response(
    res: Result<CallToolResponse, ErrorData>,
) -> Result<CallToolResponse, ErrorData> {
    match res {
        Ok(CallToolResponse::Complete(mut r)) => {
            for block in &mut r.content {
                if let ContentBlock::Text(t) = block {
                    if t.text.starts_with(RMCP_ARG_ERROR_PREFIX) {
                        // Re-shape into our `{ "error": ... }` format, clipped.
                        t.text = json!({ "error": clip(&t.text, ERROR_CLIP_CHARS) }).to_string();
                    } else if t.text.len() > MAX_RESPONSE_BYTES {
                        t.text = enforce_cap(json!({ "error": clip(&t.text, ERROR_CLIP_CHARS) }));
                    }
                }
            }
            Ok(CallToolResponse::Complete(r))
        }
        Ok(other) => Ok(other),
        Err(mut e) => {
            if e.message.chars().count() > ERROR_CLIP_CHARS {
                e.message = clip(&e.message, ERROR_CLIP_CHARS).into();
            }
            if e.data
                .as_ref()
                .is_some_and(|d| crate::util::json_len(d) > ERROR_CLIP_CHARS)
            {
                e.data = None;
            }
            Err(e)
        }
    }
}

const RMCP_ARG_ERROR_PREFIX: &str = "failed to deserialize parameters:";

#[tool_handler(router = self.tool_router)]
impl ServerHandler for NexusMcpServer {
    /// Same as the `#[tool_handler]`-generated dispatcher, plus [`sanitize_call_response`].
    async fn call_tool(
        &self,
        request: rmcp::model::CallToolRequestParams,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let tcc = rmcp::handler::server::tool::ToolCallContext::new(self, request, context);
        sanitize_call_response(self.tool_router.call(tcc).await)
    }

    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("nexuscan", env!("CARGO_PKG_VERSION")))
            .with_instructions(SERVER_INSTRUCTIONS)
    }
}
