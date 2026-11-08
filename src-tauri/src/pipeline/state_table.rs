//! Re-exports the zero-allocation 60Hz `StateTable` implementation from `nexus-hal`.

pub use nexus_hal::pipeline::state_table::{
    RetainedSignalSlot, StateTable, BYTE_HIGHLIGHT_WINDOW_US,
};
