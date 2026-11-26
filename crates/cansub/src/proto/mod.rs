//! `no_std`, allocation-free CANsub wire protocol (contract §2.2–§2.3, public API §3.2).
//!
//! Owned by work package C1 (protocol-specialist).
//!
//! Entry points: [`Decoder`] (streaming RX), [`encode_hdlc`] (TX), [`CanFrame`] / [`Event`].
//!
//! Decisions recorded here (contract §2.3 vs. C reference SDK): error frames with an unknown
//! wire code (`5..=31`) are **delivered** as [`ErrorKind::Other`] — like the C SDK, which maps
//! them to `CANSUB_ERROR_FRAME_TYPE_OTHER_ERROR` — and additionally counted in
//! [`DecoderStats::unknown_errors`]. Classical frames with DLC `9..=15` are accepted on RX
//! (8 data bytes) but rejected by [`encode_hdlc`] (`InvalidFrame`).

pub mod crc;
pub mod frame;
pub mod hdlc;

pub use frame::{dlc_to_len, len_to_dlc, CanFrame, ErrorKind, Event, FrameFlags};
pub use hdlc::{encode_hdlc, Decoder, DecoderStats, EncodeError};

/// Device timestamp epoch (2025-01-01T00:00:00Z) expressed in Unix microseconds.
pub const DEVICE_EPOCH_UNIX_US: u64 = 1_735_689_600_000_000;
/// Upper bound for a single transmitted HDLC frame, in bytes (stuffed, including flags).
pub const MAX_WIRE_HDLC: usize = 1400;
/// Decoder internal buffer size; longer frames count as overflow and trigger a resync.
pub const MAX_RX_HDLC: usize = 4096;
