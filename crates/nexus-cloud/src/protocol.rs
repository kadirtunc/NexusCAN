//! Two-Plane WebSocket Wire Protocol & Compile-Time Read-Only Cloud Safety Guards.
//!
//! ### Safety Invariant (`Read-Only Cloud`)
//! [`InboundCloudMessage`] intentionally has **zero** CAN `TX`, periodic frame,
//! or `Arm Active Bus` variants, and [`parse_inbound_cloud_message`] explicitly
//! rejects any actuation command (`ForbiddenRemoteActuationCommand`).

use std::collections::BTreeMap;

use serde::de::Error as DeError;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;

const FORBIDDEN_CLOUD_ACTUATION_TYPES: &[&str] = &[
    "TX",
    "CAN_TX",
    "SEND_FRAME",
    "TRANSMIT_FRAME",
    "PERIODIC_TX",
    "ARM_ACTIVE_BUS",
    "CMD_ARM_ACTIVE_BUS",
    "UNLOCK_TX",
];

#[derive(Debug, Error)]
pub enum CloudProtocolError {
    #[error("Malformed cloud JSON frame: {0}")]
    MalformedJson(#[from] serde_json::Error),

    #[error("Missing 'type' discriminator field in cloud wire message")]
    MissingMessageType,

    #[error(
        "READ-ONLY CLOUD SAFETY VIOLATION: Remote actuation command '{0}' is strictly forbidden"
    )]
    ForbiddenRemoteActuationCommand(String),

    #[error("Unrecognized inbound cloud message type '{0}'")]
    UnknownInboundCommand(String),
}

/// Allowed bridge telemetry cadences (`2 | 10 | 15 | 20 | 30 | 60` Hz).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BridgeTargetHz {
    /// Idle heartbeat rate (`2 Hz`) when `viewerCount == 0 && !isCapturing`.
    Hz2,
    /// Low-bandwidth cellular WAN rate (`10 Hz`).
    Hz10,
    /// Moderate WAN rate (`15 Hz`).
    Hz15,
    /// Default WAN streaming rate (`20 Hz`).
    Hz20,
    /// High-speed WAN / Wi-Fi rate (`30 Hz`).
    Hz30,
    /// Full unthrottled LAN test-bench rate (`60 Hz`).
    Hz60,
}

impl BridgeTargetHz {
    pub const fn as_u8(self) -> u8 {
        match self {
            Self::Hz2 => 2,
            Self::Hz10 => 10,
            Self::Hz15 => 15,
            Self::Hz20 => 20,
            Self::Hz30 => 30,
            Self::Hz60 => 60,
        }
    }

    pub const fn from_u64(val: u64) -> Option<Self> {
        match val {
            2 => Some(Self::Hz2),
            10 => Some(Self::Hz10),
            15 => Some(Self::Hz15),
            20 => Some(Self::Hz20),
            30 => Some(Self::Hz30),
            60 => Some(Self::Hz60),
            _ => None,
        }
    }

    /// Target inter-snapshot interval in microseconds (`1_000_000 / Hz`).
    pub const fn period_us(self) -> u64 {
        1_000_000 / (self.as_u8() as u64)
    }
}

impl Serialize for BridgeTargetHz {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u8(self.as_u8())
    }
}

impl<'de> Deserialize<'de> for BridgeTargetHz {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = u64::deserialize(deserializer)?;
        Self::from_u64(raw).ok_or_else(|| {
            D::Error::custom(format!(
                "Invalid BridgeTargetHz {raw}; expected one of 2, 10, 15, 20, 30, 60"
            ))
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BridgeStreamStateKind {
    #[serde(rename = "IDLE_STREAMING")]
    IdleStreaming,
    #[serde(rename = "CAPTURING")]
    Capturing,
    #[serde(rename = "OFFLINE")]
    Offline,
}

/// Plane 1 outbound handshake frame sent once on WebSocket connect or DB switch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeHelloFrame {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub device_id: String,
    pub project_id: String,
    pub app_version: String,
    pub host_os: String,
    pub target_hz: BridgeTargetHz,
    pub schema_sha256: Option<String>,
    pub active_db_name: Option<String>,
}

impl BridgeHelloFrame {
    pub fn new(
        device_id: impl Into<String>,
        project_id: impl Into<String>,
        app_version: impl Into<String>,
        host_os: impl Into<String>,
        target_hz: BridgeTargetHz,
        schema_sha256: Option<String>,
        active_db_name: Option<String>,
    ) -> Self {
        Self {
            msg_type: "BRIDGE_HELLO".to_string(),
            device_id: device_id.into(),
            project_id: project_id.into(),
            app_version: app_version.into(),
            host_os: host_os.into(),
            target_hz,
            schema_sha256,
            active_db_name,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SchemaAckStatus {
    Known,
    UploadRequired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaAckFrame {
    pub status: SchemaAckStatus,
    pub dbc_version_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateControlFrame {
    pub target_hz: BridgeTargetHz,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatusFrame {
    pub stream_id: String,
    pub state: BridgeStreamStateKind,
    pub capturing: bool,
    pub active_session_id: Option<String>,
    pub active_session_name: Option<String>,
    pub started_at_iso: Option<String>,
    pub started_by_name: Option<String>,
    pub captured_frames_count: u64,
    pub captured_bytes_estimate: u64,
}

/// Strictly Read-Only enum of inbound wire messages accepted from `NexusCANCloud`.
///
/// Compile-time guarantee: Zero CAN `TX` or bus-arming variants exist here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InboundCloudMessage {
    SchemaAck(SchemaAckFrame),
    RateControl(RateControlFrame),
    CaptureStatus(CaptureStatusFrame),
    Ping { timestamp_ms: u64 },
    Pong { timestamp_ms: u64 },
    BridgeError { code: String, message: String },
}

/// Parses and validates an inbound JSON frame from `NexusCANCloud`, strictly rejecting
/// any forbidden CAN `TX` / `Arm Active Bus` or unknown command types.
pub fn parse_inbound_cloud_message(
    raw_json: &str,
) -> Result<InboundCloudMessage, CloudProtocolError> {
    let val: serde_json::Value = serde_json::from_str(raw_json)?;
    let msg_type = val
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or(CloudProtocolError::MissingMessageType)?;

    let upper = msg_type.trim().to_ascii_uppercase();
    if FORBIDDEN_CLOUD_ACTUATION_TYPES.contains(&upper.as_str()) {
        return Err(CloudProtocolError::ForbiddenRemoteActuationCommand(upper));
    }

    match msg_type {
        "SCHEMA_ACK" => {
            let ack: SchemaAckFrame = serde_json::from_value(val)?;
            Ok(InboundCloudMessage::SchemaAck(ack))
        }
        "RATE_CONTROL" => {
            let rc: RateControlFrame = serde_json::from_value(val)?;
            Ok(InboundCloudMessage::RateControl(rc))
        }
        "CAPTURE_STATUS" => {
            let cs: CaptureStatusFrame = serde_json::from_value(val)?;
            Ok(InboundCloudMessage::CaptureStatus(cs))
        }
        "PING" => {
            let ts = val.get("timestampMs").and_then(|v| v.as_u64()).unwrap_or(0);
            Ok(InboundCloudMessage::Ping { timestamp_ms: ts })
        }
        "PONG" => {
            let ts = val.get("timestampMs").and_then(|v| v.as_u64()).unwrap_or(0);
            Ok(InboundCloudMessage::Pong { timestamp_ms: ts })
        }
        "BRIDGE_ERROR" => {
            let code = val
                .get("code")
                .and_then(|v| v.as_str())
                .unwrap_or("UNKNOWN_BRIDGE_ERROR")
                .to_string();
            let message = val
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Ok(InboundCloudMessage::BridgeError { code, message })
        }
        other => Err(CloudProtocolError::UnknownInboundCommand(other.to_string())),
    }
}

/// Plane 2 Wire DTOs mirroring `TelemetrySnapshotDto` (`NexusCAN` <-> `NexusCANCloud`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BusStateKind {
    Active,
    Warning,
    Passive,
    BusOff,
    Disconnected,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusHealthWireDto {
    pub bus_id: u8,
    pub device_id: String,
    pub channel_name: String,
    pub connected: bool,
    pub listen_only: bool,
    pub tx_armed: bool,
    pub bus_state: BusStateKind,
    pub tx_error_count: u32,
    pub rx_error_count: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CycleHealthKind {
    Nominal,
    JitterWarning,
    Timeout,
    Unconfigured,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSignalWireDto {
    pub signal_id: u32,
    pub raw_int: i64,
    pub physical_value: f64,
    pub active_in_last_frame: bool,
    pub out_of_range: bool,
    pub age_ms: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameTelemetryWireDto {
    pub bus_id: u8,
    pub message_key: String,
    pub arb_id: u32,
    pub is_extended: bool,
    pub is_fd: bool,
    pub is_brs: bool,
    pub is_tx: bool,
    pub has_hw_timestamp: bool,
    pub dlc: u8,
    pub raw_bytes: Vec<u8>,
    pub changed_bytes_lo: u32,
    pub changed_bytes_hi: u32,
    pub last_timestamp_us: u64,
    pub cycle_ms: f64,
    pub frequency_hz: f64,
    pub cycle_health: CycleHealthKind,
    pub rx_count: u64,
    pub active_mux_switches: BTreeMap<String, i64>,
    pub signals: Vec<LiveSignalWireDto>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronologicalFrameWireDto {
    pub timestamp_us: u64,
    pub bus_id: u8,
    pub message_key: String,
    pub arb_id: u32,
    pub is_extended: bool,
    pub is_fd: bool,
    pub is_tx: bool,
    pub dlc: u8,
    pub raw_bytes: Vec<u8>,
}

/// Plane 2 Telemetry Snapshot consumed via `tokio::sync::broadcast::Receiver<BridgeTelemetryFrame>`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTelemetryFrame {
    pub seq: u64,
    pub timestamp_us: u64,
    pub fps_rx: f64,
    pub fps_tx: f64,
    pub estimated_bus_load_pct: f64,
    pub total_frames_rx: u64,
    pub total_frames_tx: u64,
    pub dropped_frames: u64,
    pub active_ids_count: u32,
    pub decoded_signals_count: u32,
    pub tx_panic_latched: bool,
    pub buses: Vec<BusHealthWireDto>,
    pub frames: Vec<FrameTelemetryWireDto>,
    pub recent_chronological: Vec<ChronologicalFrameWireDto>,
}

impl BridgeTelemetryFrame {
    pub fn empty_heartbeat(seq: u64, timestamp_us: u64) -> Self {
        Self {
            seq,
            timestamp_us,
            fps_rx: 0.0,
            fps_tx: 0.0,
            estimated_bus_load_pct: 0.0,
            total_frames_rx: 0,
            total_frames_tx: 0,
            dropped_frames: 0,
            active_ids_count: 0,
            decoded_signals_count: 0,
            tx_panic_latched: false,
            buses: Vec::new(),
            frames: Vec::new(),
            recent_chronological: Vec::new(),
        }
    }
}
