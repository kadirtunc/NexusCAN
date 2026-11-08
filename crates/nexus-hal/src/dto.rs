//! IPC Data Transfer Objects (DTOs) shared identically between Tauri v2 commands and `nexus_bridge`.
//!
//! All structs use `#[serde(rename_all = "camelCase")]` to match the TypeScript frontend contract verbatim.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// Hardware capability flags advertised by a CAN / CAN-FD channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCapabilitiesDto {
    pub supports_fd: bool,
    pub supports_listen_only: bool,
    pub supports_hw_timestamps: bool,
    pub max_bitrate: u32,
    pub is_virtual: bool,
}

/// Discovered physical or virtual CAN adapter channel descriptor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDescriptorDto {
    pub device_id: String,
    pub driver_id: String,
    pub channel_name: String,
    pub display_name: String,
    pub capabilities: AdapterCapabilitiesDto,
}

/// User-requested bus connection parameters.
///
/// Defaults to `listen_only = true` in accordance with NexusCAN field safety invariants.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelConfigDto {
    pub bus_id: u8,
    pub bitrate: u32,
    pub data_bitrate: u32,
    pub enable_fd: bool,
    pub listen_only: bool,
    #[serde(default)]
    pub mock_fps_preset: Option<u32>,
    #[serde(default)]
    pub driver_family: Option<String>,
    #[serde(default)]
    pub serial_port: Option<String>,
    #[serde(default)]
    pub serial_baud_rate: Option<u32>,
    #[serde(default)]
    pub serial_dtr_rts: Option<bool>,
    #[serde(default)]
    pub adapter_channel: Option<String>,
}

impl Default for ChannelConfigDto {
    fn default() -> Self {
        Self {
            bus_id: 0,
            bitrate: 500_000,
            data_bitrate: 2_000_000,
            enable_fd: true,
            listen_only: true,
            mock_fps_preset: None,
            driver_family: None,
            serial_port: None,
            serial_baud_rate: None,
            serial_dtr_rts: None,
            adapter_channel: None,
        }
    }
}

/// Live bus controller health & safety lock status exported in every 60Hz snapshot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusHealthDto {
    pub bus_id: u8,
    pub device_id: String,
    pub channel_name: String,
    pub connected: bool,
    pub listen_only: bool,
    pub tx_armed: bool,
    /// One of `"active"`, `"warning"`, `"passive"`, `"busOff"`, `"disconnected"`.
    pub bus_state: String,
    pub tx_error_count: u32,
    pub rx_error_count: u32,
}

/// Decoded live signal sample keyed by dense `signal_id` (Plane 2 telemetry).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSignalDto {
    pub signal_id: u32,
    pub raw_int: i64,
    pub physical_value: f64,
    pub active_in_last_frame: bool,
    pub out_of_range: bool,
    pub age_ms: u32,
}

/// Aggregated per-`(bus_id, CanIdKey)` live frame telemetry row (Overwrite Trace + Retained Mux).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameTelemetryDto {
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
    /// Bitmask of bytes `0..31` modified within the last `300 ms`.
    pub changed_bytes_lo: u32,
    /// Bitmask of bytes `32..63` modified within the last `300 ms`.
    pub changed_bytes_hi: u32,
    pub last_timestamp_us: u64,
    pub cycle_ms: f64,
    pub frequency_hz: f64,
    /// One of `"nominal"`, `"jitterWarning"`, `"timeout"`, `"unconfigured"`.
    pub cycle_health: String,
    pub rx_count: u64,
    pub active_mux_switches: IndexMap<String, i64>,
    pub signals: Vec<LiveSignalDto>,
}

/// Compact raw frame entry for the scrolling Chronological Trace view.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronologicalFrameDto {
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

/// Complete 60Hz Plane 2 telemetry snapshot streamed to the frontend.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySnapshotDto {
    pub seq: u64,
    pub timestamp_us: u64,
    pub fps_rx: f64,
    pub fps_tx: f64,
    pub estimated_bus_load_pct: f64,
    pub total_frames_rx: u64,
    pub total_frames_tx: u64,
    pub dropped_frames: u64,
    pub active_ids_count: usize,
    pub decoded_signals_count: usize,
    pub tx_panic_latched: bool,
    pub buses: Vec<BusHealthDto>,
    pub frames: Vec<FrameTelemetryDto>,
    pub recent_chronological: Vec<ChronologicalFrameDto>,
}

/// Result returned when engaging Panic Stop (halt all TX & disarm all buses).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanicStopResultDto {
    pub stopped_periodic_jobs: usize,
    pub disarmed_buses: usize,
    pub timestamp_us: u64,
}

/// Result returned by `cmd_transmit_signal_frame` and `cmd_transmit_raw_frame`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxTransmitResultDto {
    pub job_id: Option<u64>,
    pub encoded_dlc: usize,
    pub encoded_bytes: Vec<u8>,
    pub clamped_signals: Vec<u32>,
}

/// Active periodic TX job summary (supports both Symbol/Signal and Raw Transmit rows).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodicTxJobDto {
    pub job_id: u64,
    pub label: String,
    pub bus_id: u8,
    pub message_key: String,
    pub arb_id: u32,
    pub is_extended: bool,
    pub is_fd: bool,
    pub dlc: u8,
    pub raw_bytes: Vec<u8>,
    pub interval_ms: u32,
    pub sent_count: u64,
}

/// Summary metadata for a persistent `.nexusproj.json` project file inside `./projects/`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummaryDto {
    pub file_stem: String,
    pub name: String,
    pub updated_at: String,
    pub size_bytes: u64,
}

/// Discovered host serial / USB-CDC port metadata for SLCAN adapters.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfoDto {
    pub port_name: String,
    pub port_type: String,
    pub vid_pid: Option<String>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
}

/// Installation & hardware readiness status for a CAN driver family (`mock`, `socketcan`, `slcan`, `pcan`, `kvaser`, `gs_usb`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverFamilyStatusDto {
    pub family_id: String,
    pub display_name: String,
    pub installed: bool,
    pub status_label: String,
    pub detected_library_or_module: Option<String>,
    pub searched_paths: Vec<String>,
    pub detected_channels: Vec<String>,
    pub install_hint: String,
}

/// Complete cross-OS driver & serial port diagnostic probe report returned by `cmd_probe_drivers`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverProbeReportDto {
    pub host_os: String,
    pub checked_at_ms: u64,
    pub families: Vec<DriverFamilyStatusDto>,
    pub serial_ports: Vec<SerialPortInfoDto>,
}

/// Raw `.dbc` or `.kcd` file input for stateless compilation or per-bus binding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbFileInputDto {
    #[serde(alias = "file_name")]
    pub file_name: String,
    #[serde(alias = "content_base64")]
    pub content_base64: String,
}


