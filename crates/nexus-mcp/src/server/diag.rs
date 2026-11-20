//! MCP M3 tools — `diag_router` (see planning/contracts/mcp-v1.md §9). Child module of `server`
//! so tools can use the private `run` helper and `Ctx`. Combined in `NexusMcpServer::new`.
//! Logic lives in [`crate::tools_diag`]; every tool is read-only and audited via `run`.

use super::*;
use crate::tools_diag::{
    self, DiagConversationArgs, DiagIsoTpFramesArgs, DiagPassiveDiscoveryArgs, DiagSessionInfoArgs,
};

#[tool_router(router = diag_router, vis = "pub(super)")]
impl NexusMcpServer {
    #[tool(
        name = "diag_session_info",
        description = "Diagnostic (UDS) sessions known to NexusCAN. Without request_id / response_id: lists up to 32 sessions (bus, request/response IDs, addressing, open flag, active session, unlocked security level, TesterPresent, P2 timings, last_seq). With an ID selector: the current state of that one session; unknown or ambiguous selectors return an error listing candidates. Read-only: does NOT open or close sessions, send UDS requests or change TesterPresent.",
        annotations(
            title = "Diag session info",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn diag_session_info(
        &self,
        Parameters(a): Parameters<DiagSessionInfoArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = a.selector.summary();
        self.run("diag_session_info", summary, move |ctx| {
            tools_diag::diag_session_info(&ctx.engine, &a)
        })
        .await
    }

    #[tool(
        name = "diag_conversation",
        description = "UDS conversation log of one existing diagnostic session (requests, responses, response-pending, timeouts, NRCs, TesterPresent) with seq > since_seq; limit <= 100 (default 50); page with next_since_seq. Select the session with bus_id / request_id / response_id (may be omitted when exactly one session exists). SecurityAccess (0x27/0x67) and Authentication (0x29/0x69) data bytes beyond SID+subFunction are shown as <redacted>. Read-only: does NOT open sessions, send UDS requests or replay anything.",
        annotations(
            title = "Diag conversation",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn diag_conversation(
        &self,
        Parameters(a): Parameters<DiagConversationArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "{} since={} limit={}",
            a.selector.summary(),
            opt(&a.since_seq),
            opt(&a.limit)
        );
        self.run("diag_conversation", summary, move |ctx| {
            tools_diag::diag_conversation(&ctx.engine, &a)
        })
        .await
    }

    #[tool(
        name = "diag_isotp_frames",
        description = "Raw ISO-TP CAN frames (Single/First/Consecutive/Flow Control, TX confirmed + RX, CAN-FD up to 64 bytes, hex) captured by one existing diagnostic session, with seq > since_seq; limit <= 200 (default 100); page with next_since_seq. Frames of SecurityAccess (0x27/0x67) / Authentication (0x29/0x69) exchanges have their data bytes shown as <redacted>. Read-only: does NOT open sessions or transmit frames.",
        annotations(
            title = "Diag ISO-TP frames",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn diag_isotp_frames(
        &self,
        Parameters(a): Parameters<DiagIsoTpFramesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "{} since={} limit={}",
            a.selector.summary(),
            opt(&a.since_seq),
            opt(&a.limit)
        );
        self.run("diag_isotp_frames", summary, move |ctx| {
            tools_diag::diag_isotp_frames(&ctx.engine, &a)
        })
        .await
    }

    #[tool(
        name = "diag_passive_discovery",
        description = "Snapshot of the passive (Listen-Only, TX-free) ECU discovery: per scanned bus running flag / frames analyzed, and the observed diagnostic request->response ID pairs with evidence count, confidence, SIDs seen and Flow Control evidence. bus_id omitted = every bus that has a scan. Read-only: does NOT start or stop discovery and never transmits.",
        annotations(
            title = "Passive ECU discovery",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn diag_passive_discovery(
        &self,
        Parameters(a): Parameters<DiagPassiveDiscoveryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!("bus={}", opt(&a.bus_id));
        self.run("diag_passive_discovery", summary, move |ctx| {
            tools_diag::diag_passive_discovery(&ctx.engine, &a)
        })
        .await
    }
}
