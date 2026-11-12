//! Managed Tauri application state wrapping `nexus_hal::pipeline::PipelineEngine`.

pub mod state_table;

pub use nexus_hal::pipeline::{
    tx_scheduler, PipelineEngine, FRAME_RING_CAPACITY, SNAPSHOT_INTERVAL_US,
};
use nexus_hal::registry::DriverRegistry;
use nexus_hal::storage::DataRoot;
use std::sync::Arc;

/// Thread-safe Tauri managed state holding the shared 60Hz [`PipelineEngine`].
#[derive(Clone)]
pub struct AppState {
    pub engine: Arc<PipelineEngine>,
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
        }
    }
}
