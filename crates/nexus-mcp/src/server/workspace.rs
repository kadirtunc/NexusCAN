//! MCP M2 tools — `workspace_router` (see planning/contracts/mcp-v1.md §8). Child module of `server`
//! so tools can use the private `run` helper and `Ctx`. Combined in `NexusMcpServer::new`.
//! Logic lives in [`crate::tools_workspace`]; every tool is read-only.

use super::*;
use crate::tools_workspace::{self, DebugQuery};

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ProjectGetArgs {
    /// Project file_stem exactly as returned by project_list (preferred), or the project's
    /// display name (case-insensitive, must be unique).
    pub name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TraceCompareArgs {
    /// Baseline trace file name exactly as returned by trace_list.
    pub a: String,
    /// Trace file name to compare against the baseline (as returned by trace_list).
    pub b: String,
    /// Maximum entries per result list (default 20, max 50).
    #[serde(default)]
    pub top_n: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugEventsQueryArgs {
    /// Only events of exactly this severity: "info", "success", "warn" (alias "warning"),
    /// "error" or "safety".
    #[serde(default)]
    pub level: Option<String>,
    /// Only events of this category (case-insensitive), e.g. "CONN", "SAFETY", "TX", "NETDB",
    /// "TRACE", "BUS_ERR", "DIAG", "WORKBENCH", "MCP".
    #[serde(default)]
    pub category: Option<String>,
    /// Only events from the last N milliseconds (relative to now).
    #[serde(default)]
    pub since_ms: Option<u64>,
    /// Case-insensitive substring matched against title, action and details (max 128 chars).
    #[serde(default)]
    pub text: Option<String>,
    /// Maximum events returned, newest first (default 50, max 100).
    #[serde(default)]
    pub limit: Option<u32>,
    /// Include the MCP server's own tool-call audit events (default false; implied when
    /// category is "MCP").
    #[serde(default)]
    pub include_mcp: Option<bool>,
}

#[tool_router(router = workspace_router, vis = "pub(super)")]
impl NexusMcpServer {
    #[tool(
        name = "project_list",
        description = "List saved NexusCAN project files (newest first): name, file_stem, updated_at, size_bytes. Read-only: does NOT open, load, modify or delete any project. Use project_get with a file_stem for details.",
        annotations(
            title = "List projects",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn project_list(&self) -> Result<CallToolResult, ErrorData> {
        self.run("project_list", String::new(), |ctx| {
            tools_workspace::project_list(&ctx.engine)
        })
        .await
    }

    #[tool(
        name = "project_get",
        description = "Bounded summary of one saved project: name, notes, buses, connection profiles (driver, device, bitrate, FD, listen-only, bound database ids), database file names, and counts of transmit-list entries, plotter signals, simulation/diagnostic panels. Never returns the raw project file or database contents. Read-only: does NOT load the project into the app, connect, or transmit.",
        annotations(
            title = "Get project summary",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn project_get(
        &self,
        Parameters(a): Parameters<ProjectGetArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!("name={}", s64(&a.name));
        self.run("project_get", summary, move |ctx| {
            tools_workspace::project_get(&ctx.engine, &a.name)
        })
        .await
    }

    #[tool(
        name = "trace_compare",
        description = "Compare two recorded trace files (a = baseline, b = other): IDs present only in A / only in B, per-ID frame rate change in percent, DLC changes, and per-signal min/max range changes when a signal database applies (frames decoded with their bus database, else the global one). IDs are matched per bus with the 11/29-bit flag. Lists are ranked and limited to top_n. Read-only: does NOT modify or replay the traces.",
        annotations(
            title = "Compare traces",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn trace_compare(
        &self,
        Parameters(a): Parameters<TraceCompareArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!("a={} b={} top_n={}", s64(&a.a), s64(&a.b), opt(&a.top_n));
        self.run("trace_compare", summary, move |ctx| {
            // At most one compare at a time (CPU / memory heavy).
            struct Busy<'a>(&'a std::sync::atomic::AtomicBool);
            impl Drop for Busy<'_> {
                fn drop(&mut self) {
                    self.0.store(false, std::sync::atomic::Ordering::Release);
                }
            }
            if ctx
                .compare_busy
                .compare_exchange(
                    false,
                    true,
                    std::sync::atomic::Ordering::Acquire,
                    std::sync::atomic::Ordering::Relaxed,
                )
                .is_err()
            {
                return Err(crate::util::ToolError::new(
                    "another trace_compare is already running; retry when it has finished",
                ));
            }
            let _busy = Busy(&ctx.compare_busy);
            let ta = ctx.traces.load(&ctx.engine, &a.a)?;
            let tb = ctx.traces.load(&ctx.engine, &a.b)?;
            let set = DbSet::from_engine(&ctx.engine);
            tools_workspace::trace_compare(&ta, &tb, &set, a.top_n.unwrap_or(20))
        })
        .await
    }

    #[tool(
        name = "debug_events_query",
        description = "Query the NexusCAN Debug Console event buffer (connections, safety, TX, database, trace, bus errors, diagnostics): filter by level, category, last N ms (since_ms) and text; newest first, max 100. The MCP server's own audit events are excluded unless include_mcp=true or category=\"MCP\". Read-only: does NOT clear, export or append events.",
        annotations(
            title = "Query debug events",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn debug_events_query(
        &self,
        Parameters(a): Parameters<DebugEventsQueryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "level={} category={} since_ms={} text={} limit={} include_mcp={}",
            opt(&a.level.as_deref().map(s64)),
            opt(&a.category.as_deref().map(s64)),
            opt(&a.since_ms),
            opt(&a.text.as_deref().map(s64)),
            opt(&a.limit),
            opt(&a.include_mcp)
        );
        self.run("debug_events_query", summary, move |ctx| {
            tools_workspace::debug_events_query(
                &ctx.engine,
                &DebugQuery {
                    level: a.level,
                    category: a.category,
                    since_ms: a.since_ms,
                    text: a.text,
                    limit: a.limit,
                    include_mcp: a.include_mcp,
                },
            )
        })
        .await
    }
}
