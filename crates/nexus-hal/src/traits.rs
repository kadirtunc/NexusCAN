//! Two-layer Hardware Abstraction Layer traits separating device discovery (`AdapterDriver`)
//! from zero-allocation hot-path frame I/O (`CanChannel`).

use crate::dto::{AdapterCapabilitiesDto, ChannelConfigDto, DeviceDescriptorDto};
use crate::error::AdapterError;
use nexus_core::RawCanFrame;
use serde::{Deserialize, Serialize};

/// Type alias for [`AdapterCapabilitiesDto`] on HAL traits.
pub type AdapterCapabilities = AdapterCapabilitiesDto;

/// Type alias for [`DeviceDescriptorDto`] on HAL traits.
pub type DeviceDescriptor = DeviceDescriptorDto;

/// Type alias for [`ChannelConfigDto`] on HAL traits.
pub type ChannelConfig = ChannelConfigDto;

/// Hardware acceptance filter rule (`(arb_id & mask) == (id & mask)`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanFilter {
    pub id: u32,
    pub mask: u32,
    /// `Some(true)` matches Extended-only, `Some(false)` matches Standard-only, `None` matches either.
    pub extended: Option<bool>,
}

/// ISO 11898-1 CAN controller error confinement state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BusState {
    Active,
    Warning,
    Passive,
    BusOff,
    Disconnected,
}

impl BusState {
    /// Returns the exact camelCase string expected by [`crate::dto::BusHealthDto`].
    #[inline]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Warning => "warning",
            Self::Passive => "passive",
            Self::BusOff => "busOff",
            Self::Disconnected => "disconnected",
        }
    }

    /// Encodes as `u8` for lock-free atomic sharing between bus I/O thread and 60Hz aggregator.
    #[inline]
    pub const fn to_u8(self) -> u8 {
        match self {
            Self::Active => 0,
            Self::Warning => 1,
            Self::Passive => 2,
            Self::BusOff => 3,
            Self::Disconnected => 4,
        }
    }

    /// Decodes from `u8` atomic representation.
    #[inline]
    pub const fn from_u8(val: u8) -> Self {
        match val {
            0 => Self::Active,
            1 => Self::Warning,
            2 => Self::Passive,
            3 => Self::BusOff,
            _ => Self::Disconnected,
        }
    }
}

/// Low-overhead snapshot of CAN controller health counters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BusHealthSnapshot {
    pub state: BusState,
    pub tx_error_count: u32,
    pub rx_error_count: u32,
}

impl Default for BusHealthSnapshot {
    fn default() -> Self {
        Self {
            state: BusState::Active,
            tx_error_count: 0,
            rx_error_count: 0,
        }
    }
}

/// Layer 1 HAL Trait: Driver-level device enumeration and channel factory.
pub trait AdapterDriver: Send + Sync {
    /// Unique machine identifier (`"mock"`, `"socketcan"`, `"gs_usb"`, `"slcan"`, `"pcan"`).
    fn driver_id(&self) -> &'static str;

    /// Human-readable driver backend title.
    fn display_name(&self) -> &'static str;

    /// Discovers all currently attached or virtual CAN channels managed by this driver.
    fn discover_devices(&self) -> Result<Vec<DeviceDescriptor>, AdapterError>;

    /// Opens a configured CAN / CAN-FD channel ready for `recv_batch` / `send_frame`.
    fn open_channel(
        &self,
        device: &DeviceDescriptor,
        config: &ChannelConfig,
    ) -> Result<Box<dyn CanChannel>, AdapterError>;
}

/// Layer 2 HAL Trait: Dedicated hot-path channel I/O owned by a single bus reader/writer thread.
pub trait CanChannel: Send {
    /// Returns the static descriptor for this open channel.
    fn descriptor(&self) -> &DeviceDescriptor;

    /// Returns hardware capabilities for this channel.
    fn capabilities(&self) -> &AdapterCapabilities;

    /// Cleanly closes the underlying adapter handle.
    fn close(&mut self) -> Result<(), AdapterError>;

    /// Reads up to `out_batch.len()` frames into a pre-allocated slice without heap allocations.
    ///
    /// Waits up to `timeout_ms` for the first frame so idle channels consume ~0% CPU and shut down
    /// cleanly within `< 25 ms`, then drains remaining queued frames non-blockingly.
    fn recv_batch(
        &mut self,
        out_batch: &mut [RawCanFrame],
        timeout_ms: u32,
    ) -> Result<usize, AdapterError>;

    /// Transmits a single CAN / CAN-FD frame onto the bus.
    ///
    /// Must return [`AdapterError::ListenOnlyMode`] if the channel was opened with `listen_only = true`.
    fn send_frame(&mut self, frame: &RawCanFrame) -> Result<(), AdapterError>;

    /// Applies hardware/kernel acceptance filters (`empty` = accept all frames).
    fn set_filters(&mut self, filters: &[CanFilter]) -> Result<(), AdapterError>;

    /// Queries the current controller error state and TEC/REC counters.
    fn health(&self) -> BusHealthSnapshot;
}
