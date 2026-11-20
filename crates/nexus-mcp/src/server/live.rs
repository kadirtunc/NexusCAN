//! MCP M2 tools — `live_router` (see planning/contracts/mcp-v1.md §8). Child module of `server`
//! so tools can use the private `run` helper and `Ctx`. Combined in `NexusMcpServer::new`.
//! Logic lives in [`crate::tools_live`]; every tool is read-only and audited via `run`.

use super::*;
use crate::tools_live::{
    self, BusStatusArgs, DeviceListArgs, DriverProbeArgs, LiveMessageTableArgs,
    LiveSignalValuesArgs, LiveTraceWindowArgs, McpFacts, PeriodicTxListArgs, SignalStatsArgs,
};

fn names_summary(names: &[String]) -> String {
    let joined: Vec<String> = names.iter().take(8).map(|n| s64(n)).collect();
    clip(&format!("n={} [{}]", names.len(), joined.join(",")), 200)
}

#[tool_router(router = live_router, vis = "pub(super)")]
impl NexusMcpServer {
    #[tool(
        name = "app_status",
        description = "Overall NexusCAN state: live flag, connected buses (mode Listen-Only/Armed, bus state, database used), loaded databases (global + per bus), replay status, Panic Stop latch, fps / bus load / dropped / error counters, MCP call count and whether the UI is attached. Read-only: does NOT change anything. When no bus is connected, live=false with a message.",
        annotations(title = "App status", read_only_hint = true, open_world_hint = false)
    )]
    async fn app_status(&self) -> Result<CallToolResult, ErrorData> {
        self.run("app_status", String::new(), |ctx| {
            let facts = McpFacts {
                total_calls: ctx.total_calls.load(Ordering::Relaxed),
                ui_attached: ctx.ui_attached(),
            };
            tools_live::app_status(&ctx.engine, facts)
        })
        .await
    }

    #[tool(
        name = "device_list",
        description = "List CAN / CAN-FD channels NexusCAN can see (SocketCAN, mock, gs_usb, SLCAN, PCAN, Kvaser, ...): device_id, driver, channel, FD / listen-only / hardware-timestamp support. Optional driver_id filter. Does NOT open, connect or configure any channel.",
        annotations(title = "List devices", read_only_hint = true, open_world_hint = false)
    )]
    async fn device_list(
        &self,
        Parameters(a): Parameters<DeviceListArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!("driver_id={}", opt(&a.driver_id.as_deref().map(s64)));
        self.run("device_list", summary, move |ctx| {
            tools_live::device_list_cached(&ctx.engine, a.driver_id.as_deref(), &ctx.scans)
        })
        .await
    }

    #[tool(
        name = "driver_probe",
        description = "Driver readiness report: host OS/WSL info, per driver family installed / hardware present / status / detected channels / install hint, USB CAN adapters and serial ports. Pass family for that family's setup steps. Does NOT install drivers, load modules, open channels or change settings.",
        annotations(
            title = "Probe drivers",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn driver_probe(
        &self,
        Parameters(a): Parameters<DriverProbeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!("family={}", opt(&a.family.as_deref().map(s64)));
        self.run("driver_probe", summary, move |ctx| {
            tools_live::driver_probe_cached(&ctx.engine, a.family.as_deref(), &ctx.scans)
        })
        .await
    }

    #[tool(
        name = "bus_status",
        description = "Live health of connected buses (optionally one bus_id): mode (listen_only / armed / active_disarmed), Listen-Only enforcement (hardware / softwareOnly / virtual), bus state (active/warning/passive/busOff), TEC/REC, received IDs and fps estimate, aggregate bus load, dropped frames, Panic Stop latch. Does NOT arm, disarm or change bus modes. live=false when no bus is connected.",
        annotations(title = "Bus status", read_only_hint = true, open_world_hint = false)
    )]
    async fn bus_status(
        &self,
        Parameters(a): Parameters<BusStatusArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!("bus={}", opt(&a.bus_id));
        self.run("bus_status", summary, move |ctx| {
            tools_live::bus_status(&ctx.engine, a.bus_id)
        })
        .await
    }

    #[tool(
        name = "live_message_table",
        description = "Current live message table from the latest 60 Hz snapshot: per (bus, ID) name, direction, count, rate Hz, cycle ms/health, last data hex, changed byte indices (last 300 ms) and age ms. Filters: bus_id, ids (<=0x7FF = standard; 8 hex digits = extended); sort rate|id|age; limit <= 100. Read-only; does NOT transmit. live=false when no bus is connected.",
        annotations(
            title = "Live message table",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn live_message_table(
        &self,
        Parameters(a): Parameters<LiveMessageTableArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "bus={} ids={} sort={:?} limit={}",
            opt(&a.bus_id),
            a.ids.as_ref().map_or(0, Vec::len),
            a.sort,
            opt(&a.limit)
        );
        self.run("live_message_table", summary, move |ctx| {
            tools_live::live_message_table(&ctx.engine, &a)
        })
        .await
    }

    #[tool(
        name = "live_signal_values",
        description = "Latest decoded values of up to 32 signals from the 60 Hz snapshot: physical value, unit, raw, enum label, age ms, out_of_range and whether its multiplexer page was in the last frame (retained mux values are kept). Names resolved in the database chosen by bus_id (global by default). Read-only. live=false when no bus is connected.",
        annotations(
            title = "Live signal values",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn live_signal_values(
        &self,
        Parameters(a): Parameters<LiveSignalValuesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!("{} bus={}", names_summary(&a.names), opt(&a.bus_id));
        self.run("live_signal_values", summary, move |ctx| {
            tools_live::live_signal_values(&ctx.engine, &a.names, a.bus_id)
        })
        .await
    }

    #[tool(
        name = "periodic_tx_list",
        description = "List the periodic TX jobs the user has started (label, bus, ID, message name, data, interval, sent count) plus the Panic Stop latch. Read-only: does NOT start, stop or modify any job and never transmits.",
        annotations(
            title = "Periodic TX jobs",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn periodic_tx_list(
        &self,
        Parameters(a): Parameters<PeriodicTxListArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!("bus={}", opt(&a.bus_id));
        self.run("periodic_tx_list", summary, move |ctx| {
            tools_live::periodic_tx_list(&ctx.engine, a.bus_id)
        })
        .await
    }

    #[tool(
        name = "signal_stats",
        description = "Min / max / mean / last of up to 8 signals over a short live window (window_ms default 2000, max 10000; the call blocks that long). Sampled from the 60 Hz snapshots (one sample per snapshot in which the message was received), so changes between snapshots are not seen. Read-only. live=false when no bus is connected.",
        annotations(
            title = "Signal statistics",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn signal_stats(
        &self,
        Parameters(a): Parameters<SignalStatsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "{} window_ms={} bus={}",
            names_summary(&a.names),
            opt(&a.window_ms),
            opt(&a.bus_id)
        );
        self.run("signal_stats", summary, move |ctx| {
            tools_live::signal_stats_cancellable(
                &ctx.engine,
                &a.names,
                a.window_ms,
                a.bus_id,
                &ctx.stop,
            )
        })
        .await
    }

    #[tool(
        name = "live_trace_window",
        description = "Short chronological capture of live frames: starts with the latest 60 Hz snapshot (~17 ms back) and listens forward for up to last_ms (max 5000), stopping at limit (max 200). Rows [t_us relative to first row, bus, id, dlc, data_hex, flags, name]. Filters ids / bus_id. Read-only; does NOT record to disk or transmit. live=false when no bus is connected.",
        annotations(
            title = "Live trace window",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn live_trace_window(
        &self,
        Parameters(a): Parameters<LiveTraceWindowArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let summary = format!(
            "last_ms={} ids={} bus={} limit={}",
            opt(&a.last_ms),
            a.ids.as_ref().map_or(0, Vec::len),
            opt(&a.bus_id),
            opt(&a.limit)
        );
        self.run("live_trace_window", summary, move |ctx| {
            tools_live::live_trace_window_cancellable(&ctx.engine, &a, &ctx.stop)
        })
        .await
    }
}
