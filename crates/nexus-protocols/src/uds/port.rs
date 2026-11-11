//! HAL ↔ UDS client frame port (D-003 contract v1, FROZEN).
//!
//! `nexus-hal` implements [`DiagCanPort`] on top of a filtered *diag tap* of the
//! single bus-io owner thread (see spike `spikes/automotive-hal-bridge`).
//! `nexus-protocols::uds::client` consumes it (adapter to `automotive::can::CanAdapter`).
//! This keeps `nexus-protocols` independent of `nexus-hal` (dependency direction:
//! `nexus-hal → nexus-protocols → nexus-core`).
//!
//! Safety invariants (CLAUDE.md §3.4) are enforced by the IMPLEMENTOR (HAL side):
//! every frame passed to [`DiagCanPort::send`] goes through the same
//! Listen-Only / Arm Active Bus / Panic Stop gate as any other TX, and the final
//! verdict is re-evaluated inside the bus-io thread right before the driver write.

use std::time::Duration;

use nexus_core::RawCanFrame;

/// Why a frame did not reach the bus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagTxReject {
    /// Bus is in Listen-Only mode.
    ListenOnly,
    /// Bus is connected but not armed for active TX ("Arm Active Bus").
    Disarmed,
    /// Panic Stop is latched.
    PanicLatched,
    /// Driver reported a write error.
    DriverError,
    /// The tap / bus was closed (disconnect, panic, disarm, mode change).
    Closed,
    /// The tap's TX queue is full (back-pressure).
    QueueFull,
}

/// Events delivered to a diag port. All variants are `Copy` (no heap on the bus-io thread).
#[derive(Debug, Clone, Copy)]
pub enum DiagPortEvent {
    /// A frame received from the bus that matched the tap filters
    /// (`timestamp_us` = HAL timestamp, hardware timestamp when available).
    Rx(RawCanFrame),
    /// This port's frame was handed to the driver (`timestamp_us` = time of send).
    /// Delivered ONLY to the port that sent it.
    TxConfirmed(RawCanFrame),
    /// This port's frame was refused or failed. Delivered ONLY to the port that sent it.
    TxRejected(RawCanFrame, DiagTxReject),
}

/// Acceptance filter: `(arb_id & mask) == (id & mask)` and optional IDE match.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiagTapFilter {
    pub id: u32,
    pub mask: u32,
    /// `Some(true)` = 29-bit only, `Some(false)` = 11-bit only, `None` = both.
    pub extended: Option<bool>,
}

impl DiagTapFilter {
    pub const fn exact_std(id: u32) -> Self {
        Self { id, mask: 0x7FF, extended: Some(false) }
    }
    pub const fn exact_ext(id: u32) -> Self {
        Self { id, mask: 0x1FFF_FFFF, extended: Some(true) }
    }
}

/// A per-client handle onto one bus. Dropping it closes the tap.
pub trait DiagCanPort: Send + Sync + 'static {
    /// Logical bus id of the underlying channel.
    fn bus_id(&self) -> u8;
    /// Channel was opened with CAN-FD enabled.
    fn fd_enabled(&self) -> bool;
    /// Early (advisory) gate check; the authoritative check happens in the bus-io thread.
    fn gate_check(&self) -> Result<(), DiagTxReject>;
    /// Enqueue one frame for TX. Non-blocking. `Ok` only means "queued"; the verdict
    /// arrives later as `TxConfirmed` / `TxRejected` on this port.
    fn send(&self, frame: RawCanFrame) -> Result<(), DiagTxReject>;
    /// Block up to `timeout` for the next event. `None` on timeout.
    /// Returns `Some(TxRejected(_, Closed))`-style events or `None` forever once closed;
    /// implementors must not spin.
    fn recv_timeout(&self, timeout: Duration) -> Option<DiagPortEvent>;
    /// Non-blocking variant of [`Self::recv_timeout`].
    fn try_recv(&self) -> Option<DiagPortEvent>;
    /// `true` once the tap was closed by the HAL (disconnect, panic, disarm, mode change).
    fn is_closed(&self) -> bool;
}
