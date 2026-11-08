//! Error types for the NexusCAN Hardware Abstraction Layer and 60Hz Telemetry Pipeline.

use nexus_core::BusId;
use nexus_netdb::{DbError, DbParseError, EncodeError};
use serde::Serialize;
use thiserror::Error;

/// Hardware driver and channel I/O errors.
#[derive(Debug, Error)]
pub enum AdapterError {
    /// Requested device identifier was not found during discovery.
    #[error("CAN device '{0}' not found")]
    DeviceNotFound(String),

    /// Requested driver backend is not registered on this platform.
    #[error("CAN driver '{0}' is not available on this platform")]
    DriverNotAvailable(String),

    /// Attempted frame transmission while the channel is hardware/software locked in Listen-Only mode.
    #[error("Transmission rejected: channel is locked in Listen-Only (passive) mode")]
    ListenOnlyMode,

    /// Channel has already been closed or disconnected.
    #[error("CAN channel is closed")]
    ChannelClosed,

    /// Frame configuration or payload violates channel capabilities (e.g., CAN-FD frame on Classical-only interface).
    #[error("Unsupported frame or channel configuration: {0}")]
    UnsupportedCapability(String),

    /// Underlying OS / USB / SocketCAN I/O failure.
    #[error("Adapter I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// Driver-specific error message.
    #[error("Driver error: {0}")]
    Driver(String),
}

/// Top-level pipeline, safety-gate, database, and command execution errors.
#[derive(Debug, Error)]
pub enum HalError {
    /// Underlying hardware adapter failure.
    #[error(transparent)]
    Adapter(#[from] AdapterError),

    /// Network signal database parsing, compilation, or TX encoding error.
    #[error(transparent)]
    Database(#[from] DbError),

    /// Logical bus slot is already connected.
    #[error("Bus {0} is already connected; disconnect it before opening a new channel")]
    BusAlreadyConnected(BusId),

    /// Logical bus slot is not currently connected.
    #[error("Bus {0} is not connected")]
    BusNotConnected(BusId),

    /// Safety gate prevented arming TX or transmitting frames.
    #[error("{0}")]
    SafetyLock(String),

    /// Requested periodic TX job ID does not exist.
    #[error("Periodic TX job {0} not found")]
    PeriodicJobNotFound(u64),

    /// Invalid input payload (e.g., base64 decode or preset file lookup failure).
    #[error("{0}")]
    InvalidInput(String),
}

impl From<DbParseError> for HalError {
    fn from(err: DbParseError) -> Self {
        Self::Database(DbError::Parse(err))
    }
}

impl From<EncodeError> for HalError {
    fn from(err: EncodeError) -> Self {
        Self::Database(DbError::Encode(err))
    }
}

impl Serialize for HalError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
