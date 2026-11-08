//! Managed Tauri application state wrapping `nexus_hal::pipeline::PipelineEngine`.

pub mod state_table;

pub use nexus_hal::pipeline::{tx_scheduler, PipelineEngine, FRAME_RING_CAPACITY, SNAPSHOT_INTERVAL_US};
use std::sync::Arc;

/// Thread-safe Tauri managed state holding the shared 60Hz [`PipelineEngine`].
#[derive(Clone)]
pub struct AppState {
    pub engine: Arc<PipelineEngine>,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    /// Initializes a new [`AppState`] with all built-in HAL drivers (`mock0` + platform-native drivers).
    pub fn new() -> Self {
        Self {
            engine: Arc::new(PipelineEngine::new()),
        }
    }
}
