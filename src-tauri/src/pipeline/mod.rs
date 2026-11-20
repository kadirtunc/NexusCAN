//! Managed Tauri application state wrapping `nexus_hal::pipeline::PipelineEngine`.

pub mod state_table;
pub mod ui_bridge;

pub use nexus_hal::pipeline::{
    tx_scheduler, PipelineEngine, FRAME_RING_CAPACITY, SNAPSHOT_INTERVAL_US,
};
use nexus_hal::registry::DriverRegistry;
use nexus_hal::storage::DataRoot;
use nexus_mcp::McpServerHandle;
use std::sync::{Arc, Mutex, MutexGuard};

/// In-app read-only MCP server slot (`cmd_mcp_*`). Default: stopped; never auto-started.
#[derive(Default)]
pub struct McpSlot {
    pub handle: Option<McpServerHandle>,
    /// Last start / runtime error, reported by `cmd_mcp_status` until the next successful start.
    pub last_error: Option<String>,
    /// `total_calls` of the most recent server instance (kept after stop).
    pub last_total_calls: u64,
}

/// Thread-safe Tauri managed state holding the shared 60Hz [`PipelineEngine`].
#[derive(Clone)]
pub struct AppState {
    pub engine: Arc<PipelineEngine>,
    /// Optional MCP server (off the RX / aggregator hot path; only reads engine state).
    pub mcp: Arc<Mutex<McpSlot>>,
    /// MCP UI Bridge (co-pilot) to the attached frontend window.
    pub ui_bridge: ui_bridge::TauriUiBridge,
}

impl AppState {
    /// WP-8: builds the engine with all built-in HAL drivers (`mock0` + platform-native drivers)
    /// storing projects/traces under `data_root` (resolved in `lib.rs` setup; release builds use
    /// `app_local_data_dir()`).
    pub fn with_data_root(data_root: DataRoot) -> Self {
        Self {
            engine: Arc::new(PipelineEngine::with_data_root(
                DriverRegistry::with_builtin_drivers(),
                data_root,
            )),
            mcp: Arc::new(Mutex::new(McpSlot::default())),
            ui_bridge: ui_bridge::TauriUiBridge::default(),
        }
    }

    /// Locks the MCP slot (a poisoned lock is recovered: the slot holds no invariants that a
    /// panic could break).
    pub fn mcp_slot(&self) -> MutexGuard<'_, McpSlot> {
        self.mcp.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Non-blocking MCP stop used on main-window close / app exit.
    pub fn stop_mcp(&self) {
        let handle = {
            let mut slot = self.mcp_slot();
            if let Some(h) = &slot.handle {
                slot.last_total_calls = h.status().total_calls;
            }
            slot.handle.take()
        };
        if let Some(h) = handle {
            h.stop();
        }
    }
}
