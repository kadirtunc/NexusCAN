//! MCP M3 tools — `re_router` (see planning/contracts/mcp-v1.md §9). Child module of `server`
//! so tools can use the private `run` helper and `Ctx`. Combined in `NexusMcpServer::new`.
//! Logic lives in [`crate::tools_re`]; every tool is read-only and audited via `run`.

use super::*;
use crate::tools_re::{
    self, ReCorrelateArgs, ReDbcGenerateArgs, ReRowDetailArgs, ReScanResultsArgs, ReSeriesArgs,
};

#[tool_router(router = re_router, vis = "pub(super)")]
impl NexusMcpServer {
    #[tool(
        name = "re_status",
        description = "Reverse-Engineering (RE) sniffer state in one object: enabled, phase (free/baseline/action), rows, frames ingested, focused targets (bus, id, samples, first_us/last_us), value-scan status and the newest 50 event markers. enabled=false with a message when RE is not running (not an error). Read-only: does NOT start, stop, reset RE, change the phase, add markers or change the focus set.",
        annotations(title = "RE status", read_only_hint = true, open_world_hint = false)
    )]
    async fn re_status(&self) -> Result<CallToolResult, ErrorData> {
        self.run("re_status", String::new(), |ctx| {
            tools_re::re_status(&ctx.engine)
        })
        .await
    }

    #[tool(
        name = "re_series",
        description = "Time series of up to 4 candidate bit fields of a FOCUSED RE target (+ optional reference: obd_pid, markers or another focused candidate), min/max-decimated to max_points (<=500, lowered to fit 16 KB). Returns [{label, kind, points:[[t_us, value] | [t_us, min, max]]}] with t_us relative to from_us; never raw bytes. The target must already be focused by the user in the RE view: this tool does NOT focus targets, start RE or transmit. enabled=false when RE is not running.",
        annotations(title = "RE series", read_only_hint = true, open_world_hint = false)
    )]
    async fn re_series(
        &self,
        Parameters(a): Parameters<ReSeriesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "bus={} id={} cands={} ref={} pts={}",
            a.bus_id,
            s64(&a.id),
            a.candidates.len(),
            a.reference.is_some(),
            opt(&a.max_points)
        );
        self.run("re_series", summary, move |ctx| {
            tools_re::re_series(&ctx.engine, &a)
        })
        .await
    }

    #[tool(
        name = "re_correlate",
        description = "Correlates every bit field of a FOCUSED RE target (bit range, length range 1..32, byte orders, signed) against a reference (obd_pid, markers or another focused candidate) and returns the top_n (<=20) best fields: start_bit, bit_length, byte order, r / r2, rmse, least-squares factor/offset and lag_ms. Bounded to 2 s; never cancels a correlation the user started in the UI (a newer UI request cancels this one instead). Does NOT focus targets, start RE, add markers or transmit. enabled=false when RE is not running.",
        annotations(title = "RE correlate", read_only_hint = true, open_world_hint = false)
    )]
    async fn re_correlate(
        &self,
        Parameters(a): Parameters<ReCorrelateArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!("bus={} id={} top_n={}", a.bus_id, s64(&a.id), opt(&a.top_n));
        self.run("re_correlate", summary, move |ctx| {
            tools_re::re_correlate(&ctx.engine, &a)
        })
        .await
    }

    #[tool(
        name = "re_scan_results",
        description = "Rows of the active RE value scan (the user's first/next scan in the RE view): candidate field (bus, id, start_bit, bit_length, byte order, value type), current / previous raw, physical value, change count, kind hint, contained candidates. offset + limit (<=100) pagination, sort id|changes|width; next_offset is null at the end. active=false when no scan exists. Does NOT start, step, undo or reset a scan.",
        annotations(
            title = "RE scan results",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn re_scan_results(
        &self,
        Parameters(a): Parameters<ReScanResultsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "offset={} limit={} sort={:?}",
            opt(&a.offset),
            opt(&a.limit),
            a.sort
        );
        self.run("re_scan_results", summary, move |ctx| {
            tools_re::re_scan_results(&ctx.engine, &a)
        })
        .await
    }

    #[tool(
        name = "re_row_detail",
        description = "Details of one RE row (bus, id): DLC, rx count, per-bit toggle counts, constant / baseline / action / diff / noisy bit masks (hex, DBC Intel bit numbering) plus the field classifier result (counters, checksums, flags, physical fields with confidence, bit entropy, period / jitter). Read-only: does NOT change RE state or transmit.",
        annotations(
            title = "RE row detail",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn re_row_detail(
        &self,
        Parameters(a): Parameters<ReRowDetailArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!("bus={} id={}", a.bus_id, s64(&a.id));
        self.run("re_row_detail", summary, move |ctx| {
            tools_re::re_row_detail(&ctx.engine, &a)
        })
        .await
    }

    #[tool(
        name = "re_dbc_generate",
        description = "Turns found signals (drafts: name, id, start_bit, bit_length, byte order, value type, factor/offset, min/max, unit, comment, VAL_ table; <=256) into round-trip-verified Vector DBC text (BO_/SG_/CM_/VAL_) plus generator diagnostics. Text is clipped with truncated=true when it exceeds the response cap. Pure computation: does NOT save a file, load the database into NexusCAN or merge into a loaded database (base_db_id is rejected).",
        annotations(
            title = "RE generate DBC",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn re_dbc_generate(
        &self,
        Parameters(a): Parameters<ReDbcGenerateArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "drafts={} base={}",
            a.drafts.len(),
            opt(&a.base_db_id.as_deref().map(s64))
        );
        self.run("re_dbc_generate", summary, move |_ctx| {
            tools_re::re_dbc_generate(&a)
        })
        .await
    }
}
