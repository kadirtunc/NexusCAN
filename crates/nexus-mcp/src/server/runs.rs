//! MCP M3 tools — `runs_router` (see planning/contracts/mcp-v1.md §9). Child module of `server`
//! so tools can use the private `run` helper and `Ctx`. Combined in `NexusMcpServer::new`.
//! Logic lives in [`crate::tools_runs`]; every tool is read-only and audited via `run`.

use super::*;
use crate::tools_runs::{self, RunQuery};

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RunQueryArgs {
    /// Project id ([A-Za-z0-9-], 1..64 chars) whose run history to query.
    pub project_id: String,
    /// Only runs on this ECU id (exact match).
    #[serde(default)]
    pub ecu_id: Option<String>,
    /// Only runs of this flow id (exact match, as returned by flowlib_list).
    #[serde(default)]
    pub flow_id: Option<String>,
    /// Only runs with this outcome: "ok", "fail", "error", "aborted" or "panic_stop".
    #[serde(default)]
    pub status: Option<String>,
    /// Only runs started at or after this RFC 3339 timestamp (inclusive), e.g.
    /// "2026-11-18T10:00:00Z".
    #[serde(default)]
    pub from: Option<String>,
    /// Only runs started before this RFC 3339 timestamp (exclusive).
    #[serde(default)]
    pub to: Option<String>,
    /// Maximum runs returned, newest first (default 20, max 50).
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RunLatestArgs {
    /// Project id ([A-Za-z0-9-], 1..64 chars).
    pub project_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct FlowlibListArgs {
    /// Also list soft-deleted flows (default false).
    #[serde(default)]
    pub include_deleted: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct FlowlibGetArgs {
    /// Flow id exactly as returned by flowlib_list ([A-Za-z0-9_-], 1..64 chars).
    pub id: String,
    /// Revision to inspect (default: latest).
    #[serde(default)]
    pub revision: Option<u32>,
}

#[tool_router(router = runs_router, vis = "pub(super)")]
impl NexusMcpServer {
    #[tool(
        name = "run_query",
        description = "Query the diagnostic flow run history of a project (newest first, max 50): filter by ecu_id, flow_id, status (ok|fail|error|aborted|panic_stop) and a started-at window (from inclusive, to exclusive, RFC 3339). Returns bounded summaries: run id, times, duration, status, ECU, flow + revision, NRC, error message, and counts of params/outputs/files/log lines. Never returns param/output values, file refs or log lines. Read-only: does NOT append, edit or delete run records and does NOT re-run flows or send anything on the bus.",
        annotations(
            title = "Query run history",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn run_query(
        &self,
        Parameters(a): Parameters<RunQueryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "project_id={} ecu_id={} flow_id={} status={} from={} to={} limit={}",
            s64(&a.project_id),
            opt(&a.ecu_id.as_deref().map(s64)),
            opt(&a.flow_id.as_deref().map(s64)),
            opt(&a.status.as_deref().map(s64)),
            opt(&a.from.as_deref().map(s64)),
            opt(&a.to.as_deref().map(s64)),
            opt(&a.limit)
        );
        self.run("run_query", summary, move |ctx| {
            tools_runs::run_query(
                &ctx.engine,
                &RunQuery {
                    project_id: a.project_id,
                    ecu_id: a.ecu_id,
                    flow_id: a.flow_id,
                    status: a.status,
                    from: a.from,
                    to: a.to,
                    limit: a.limit,
                },
            )
        })
        .await
    }

    #[tool(
        name = "run_latest",
        description = "Latest top-level run per (ECU, flow) of a project, newest first (max 50), as bounded summaries (same fields as run_query). Read-only: does NOT append, edit or delete run records and does NOT re-run flows or send anything on the bus.",
        annotations(
            title = "Latest runs per ECU/flow",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn run_latest(
        &self,
        Parameters(a): Parameters<RunLatestArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!("project_id={}", s64(&a.project_id));
        self.run("run_latest", summary, move |ctx| {
            tools_runs::run_latest(&ctx.engine, &a.project_id)
        })
        .await
    }

    #[tool(
        name = "flowlib_list",
        description = "List the flow library (diagnostic flows and custom blocks), sorted by name, max 200: id, kind, name, latest revision, revision count, updated_at, origin, ai_reviewed, tags, deleted. Soft-deleted entries only with include_deleted=true. Read-only: does NOT save, delete, import, run or open a flow.",
        annotations(
            title = "List flow library",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn flowlib_list(
        &self,
        Parameters(a): Parameters<FlowlibListArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!("include_deleted={}", opt(&a.include_deleted));
        self.run("flowlib_list", summary, move |ctx| {
            tools_runs::flowlib_list(&ctx.engine, a.include_deleted.unwrap_or(false))
        })
        .await
    }

    #[tool(
        name = "flowlib_get",
        description = "One flow library entry by id (from flowlib_list; deleted ids too): metadata, revisions (newest first), and a structural summary of the chosen revision (kind, block/connection/variable counts, block types, referenced UDS services, DIDs, routine ids, library calls). The raw flow JSON is included only if it fits the ~16 KB cap; otherwise raw_json is null and truncated=true. Read-only: does NOT save, delete, run or load the flow into the editor and sends nothing on the bus.",
        annotations(
            title = "Get flow library entry",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn flowlib_get(
        &self,
        Parameters(a): Parameters<FlowlibGetArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!("id={} revision={}", s64(&a.id), opt(&a.revision));
        self.run("flowlib_get", summary, move |ctx| {
            tools_runs::flowlib_get(&ctx.engine, &a.id, a.revision)
        })
        .await
    }
}
