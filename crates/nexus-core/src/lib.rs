//! Core zero-allocation CAN / CAN-FD primitives, frame layout, IDs, and monotonic timing
//! for the NexusCAN industrial bus analyzer.
//!
//! All hot-path types in this crate are 100% OS-independent and heap-free.

#![forbid(unsafe_code)]

pub mod frame;
#[doc(hidden)]
pub mod testing;
pub mod time;

pub use frame::flags;
pub use frame::{
    dlc_code_to_len, estimate_frame_wire_bits, len_to_canfd_dlc_code, quantize_canfd_payload_len,
    BusId, CanId, CanIdKey, FrameError, FrameFlags, RawCanFrame, DBC_EXT_ID_FLAG, EXT_CAN_ID_MASK,
    FLAG_BRS, FLAG_ERROR, FLAG_ESI, FLAG_EXTENDED, FLAG_FD, FLAG_HW_TIMESTAMP, FLAG_RTR, FLAG_TX,
    MAX_CAN_FD_BITS, MAX_CAN_FD_DLC, MAX_CLASSICAL_CAN_DLC, STD_CAN_ID_MASK,
    VECTOR_INDEPENDENT_SIG_MSG_ID,
};
pub use time::{now_monotonic_us, resolve_frame_timestamp_us, MonotonicClock};
