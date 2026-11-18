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
    /// Fail-closed: when `listen_only` is requested on a physical channel and the controller
    /// cannot be put into hardware listen-only mode, refuse to open the channel instead of
    /// falling back to the software TX lock. Virtual channels are unaffected.
    #[serde(default)]
    pub require_hardware_listen_only: bool,
}

impl ChannelConfigDto {
    /// `true` when this config asks for Listen-Only AND forbids the software-only fallback
    /// (see [`Self::require_hardware_listen_only`]).
    #[inline]
    pub const fn requires_hardware_listen_only(&self) -> bool {
        self.listen_only && self.require_hardware_listen_only
    }
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
            require_hardware_listen_only: false,
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
    /// D-005 / WP-5: how Listen-Only is enforced; `null` while the bus is not listen-only.
    /// `"hardware"` (controller silent mode), `"softwareOnly"` (TX blocked in software, the
    /// physical controller may still ACK frames: HMI must warn), `"virtual"` (vcan/mock).
    #[serde(default)]
    pub listen_only_enforcement: Option<String>,
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
    #[serde(default)]
    pub is_error: bool,
    #[serde(default)]
    pub error_summary: Option<String>,
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
    #[serde(alias = "timestamp_us")]
    pub timestamp_us: u64,
    #[serde(default, alias = "bus_id")]
    pub bus_id: u8,
    #[serde(default, alias = "message_key")]
    pub message_key: String,
    #[serde(alias = "arb_id")]
    pub arb_id: u32,
    #[serde(default, alias = "is_extended")]
    pub is_extended: bool,
    #[serde(default, alias = "is_fd")]
    pub is_fd: bool,
    #[serde(default, alias = "is_brs")]
    pub is_brs: bool,
    #[serde(default, alias = "is_tx")]
    pub is_tx: bool,
    #[serde(default, alias = "is_error")]
    pub is_error: bool,
    #[serde(default, alias = "error_summary")]
    pub error_summary: Option<String>,
    pub dlc: u8,
    #[serde(default, alias = "raw_bytes")]
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
    #[serde(default)]
    pub total_frames_err: u64,
    pub dropped_frames: u64,
    pub active_ids_count: usize,
    pub decoded_signals_count: usize,
    pub tx_panic_latched: bool,
    pub buses: Vec<BusHealthDto>,
    pub frames: Vec<FrameTelemetryDto>,
    pub recent_chronological: Vec<ChronologicalFrameDto>,
    #[serde(default)]
    pub replay: TraceReplayStatusDto,
}

/// Result returned when engaging Panic Stop (halt all TX & disarm all buses).
///
/// When this is returned, no driver write that passed the bus-io safety gate before the Panic
/// is still running on any bus listed as quiesced, and no later write can pass the gate.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanicStopResultDto {
    pub stopped_periodic_jobs: usize,
    pub disarmed_buses: usize,
    pub timestamp_us: u64,
    /// Buses whose in-flight driver write did not finish within
    /// [`crate::pipeline::TX_QUIESCE_TIMEOUT`] (blocking driver). The latch is engaged anyway
    /// and nothing new can pass the gate, but that ONE write may still reach the wire.
    /// Empty in the normal case.
    #[serde(default)]
    pub in_flight_timeout_buses: Vec<u8>,
}

/// WP-4: result of `cmd_reset_session` (cold-start reset that never latches Panic Stop).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetSessionResultDto {
    pub stopped_periodic_jobs: usize,
    pub disarmed_buses: usize,
    pub disconnected_buses: usize,
    /// Same meaning as [`PanicStopResultDto::in_flight_timeout_buses`].
    #[serde(default)]
    pub in_flight_timeout_buses: Vec<u8>,
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

fn default_true_bool() -> bool {
    true
}

/// Discovered host serial / USB-CDC port metadata for SLCAN adapters.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfoDto {
    pub port_name: String,
    pub port_type: String,
    pub vid_pid: Option<String>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    #[serde(default)]
    pub serial_number: Option<String>,
    #[serde(default)]
    pub os_hint: Option<String>,
}

/// Host operating system, kernel/WSL2, permission, and native CAN stack summary.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEnvironmentDto {
    pub os: String,
    pub arch: String,
    pub os_release: String,
    pub is_wsl: bool,
    pub udev_rules_present: bool,
    pub serial_permission_hint: Option<String>,
    pub native_stacks: Vec<String>,
    pub os_notes: Vec<String>,
}

/// Enumerated physical USB CAN / USB-CDC / DFU device discovered on the host USB bus.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbCanDeviceDto {
    pub vid_pid: String,
    pub vendor_name: String,
    pub product_name: String,
    pub serial_number: Option<String>,
    pub bus_number: u8,
    pub device_address: u8,
    #[serde(default)]
    pub location_info: Option<String>,
    /// `"gs_usb"` | `"pcan"` | `"kvaser"` | `"vector_xl"` | `"slcan"` | `"dfu_bootloader"`
    pub matched_family: String,
    pub driver_bound: bool,
    pub access_status: String,
    pub suggested_channel: Option<String>,
}

/// Rich per-channel hardware state, MTU, kernel/USB driver binding, and bring-up hint.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedChannelDetailDto {
    pub channel_id: String,
    pub device_id: String,
    pub label: String,
    /// `"up"` | `"down"` | `"ready"` | `"busy"` | `"needs_driver"` | `"virtual"`
    pub state: String,
    pub supports_fd: bool,
    pub mtu: Option<u32>,
    pub kernel_or_usb_driver: Option<String>,
    pub source_path: String,
    pub hardware_id: Option<String>,
    pub hint_command: Option<String>,
}

/// Actionable OS-specific installation or bring-up step for a CAN driver family.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsSetupStepDto {
    pub title: String,
    pub description: String,
    pub command_or_action: Option<String>,
    pub doc_url: Option<String>,
}

/// Installation & hardware readiness status for a CAN driver family
/// (`socketcan`, `gs_usb`, `slcan`, `pcan`, `kvaser`, `vector_xl`, `mock`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverFamilyStatusDto {
    pub family_id: String,
    pub display_name: String,
    pub installed: bool,
    #[serde(default = "default_true_bool")]
    pub os_supported: bool,
    #[serde(default)]
    pub hardware_present: bool,
    pub status_label: String,
    pub detected_library_or_module: Option<String>,
    #[serde(default)]
    pub architecture_note: Option<String>,
    pub searched_paths: Vec<String>,
    #[serde(default)]
    pub os_source_locations: Vec<String>,
    pub detected_channels: Vec<String>,
    #[serde(default)]
    pub channel_details: Vec<DetectedChannelDetailDto>,
    #[serde(default)]
    pub setup_steps: Vec<OsSetupStepDto>,
    pub install_hint: String,
}

/// Complete cross-OS driver, USB bus, and serial port diagnostic probe report returned by `cmd_probe_drivers`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverProbeReportDto {
    pub host_os: String,
    pub checked_at_ms: u64,
    #[serde(default)]
    pub host_env: HostEnvironmentDto,
    #[serde(default)]
    pub usb_devices: Vec<UsbCanDeviceDto>,
    pub families: Vec<DriverFamilyStatusDto>,
    pub serial_ports: Vec<SerialPortInfoDto>,
}

/// Real-time OS USB hotplug and hardware topology event streamed via `cmd_subscribe_hardware_changes`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareWatchEventDto {
    /// `"initial"` | `"usb_hotplug"` | `"topology_poll"`
    pub reason: String,
    pub timestamp_ms: u64,
    pub devices: Vec<DeviceDescriptorDto>,
    pub report: DriverProbeReportDto,
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

/// Summary metadata for a persistent trace capture file inside `./traces/`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceFileSummaryDto {
    pub file_name: String,
    pub file_path: String,
    /// `"trc"` | `"asc"` | `"log"` | `"csv"` | `"blf"`
    pub format: String,
    pub size_bytes: u64,
    /// WP-8: `0` with `stats_known == false` in `cmd_list_traces` for files this engine has not
    /// parsed yet (listing never reads file bodies).
    pub frame_count: usize,
    /// Same semantics as `frame_count`.
    pub duration_us: u64,
    pub updated_at: String,
    /// WP-8: `true` when `frame_count` / `duration_us` are exact (always `true` for save /
    /// load / parse results; `false` in `cmd_list_traces` until the file is opened).
    #[serde(default = "default_true")]
    pub stats_known: bool,
}

fn default_true() -> bool {
    true
}

/// Persistent `./traces/` storage directory path and discovered trace file summaries.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceStorageInfoDto {
    pub traces_dir: String,
    pub files: Vec<TraceFileSummaryDto>,
}

/// Parsed trace file summary + full normalized chronological frame sequence for `TraceView`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedTraceFileDto {
    pub summary: TraceFileSummaryDto,
    pub frames: Vec<ChronologicalFrameDto>,
}

/// Real-time status of the deterministic zero-allocation trace replay worker streamed at 60Hz.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceReplayStatusDto {
    /// `"idle"` | `"playing"` | `"paused"` | `"completed"`
    pub state: String,
    pub source_name: String,
    pub current_index: usize,
    pub total_frames: usize,
    pub elapsed_us: u64,
    pub duration_us: u64,
    pub speed_factor: f64,
    pub loop_playback: bool,
    pub bus_override: Option<u8>,
    pub transmit_to_hardware: bool,
    /// `"all"` | `"include"` | `"exclude"`
    #[serde(default = "default_filter_mode")]
    pub filter_mode: String,
    #[serde(default)]
    pub filter_keys: Vec<String>,
    /// `"all"` | `"rx"` | `"tx"`
    #[serde(default = "default_direction_filter")]
    pub direction_filter: String,
    #[serde(default)]
    pub dispatched_frames: u64,
    #[serde(default)]
    pub filtered_out_frames: u64,
    #[serde(default)]
    pub hw_tx_frames: u64,
}

impl Default for TraceReplayStatusDto {
    fn default() -> Self {
        Self {
            state: "idle".to_string(),
            source_name: String::new(),
            current_index: 0,
            total_frames: 0,
            elapsed_us: 0,
            duration_us: 0,
            speed_factor: 1.0,
            loop_playback: false,
            bus_override: None,
            transmit_to_hardware: false,
            filter_mode: default_filter_mode(),
            filter_keys: Vec::new(),
            direction_filter: default_direction_filter(),
            dispatched_frames: 0,
            filtered_out_frames: 0,
            hw_tx_frames: 0,
        }
    }
}

fn default_replay_speed() -> f64 {
    1.0
}

fn default_filter_mode() -> String {
    "all".to_string()
}

fn default_direction_filter() -> String {
    "all".to_string()
}

/// Arguments for starting a deterministic trace replay session (`cmd_start_trace_replay`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTraceReplayArgsDto {
    #[serde(default, alias = "source_name")]
    pub source_name: String,
    #[serde(default, alias = "file_name")]
    pub file_name: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default, alias = "content_base64")]
    pub content_base64: Option<String>,
    #[serde(default)]
    pub frames: Option<Vec<ChronologicalFrameDto>>,
    #[serde(default = "default_replay_speed", alias = "speed_factor")]
    pub speed_factor: f64,
    #[serde(default, alias = "loop_playback")]
    pub loop_playback: bool,
    #[serde(default, alias = "bus_override")]
    pub bus_override: Option<u8>,
    #[serde(default, alias = "transmit_to_hardware")]
    pub transmit_to_hardware: bool,
    #[serde(default, alias = "reset_telemetry_first")]
    pub reset_telemetry_first: bool,
    #[serde(default = "default_filter_mode", alias = "filter_mode")]
    pub filter_mode: String,
    #[serde(default, alias = "filter_keys")]
    pub filter_keys: Vec<String>,
    #[serde(default = "default_direction_filter", alias = "direction_filter")]
    pub direction_filter: String,
}

impl Default for StartTraceReplayArgsDto {
    fn default() -> Self {
        Self {
            source_name: String::new(),
            file_name: None,
            content: None,
            content_base64: None,
            frames: None,
            speed_factor: 1.0,
            loop_playback: false,
            bus_override: None,
            transmit_to_hardware: false,
            reset_telemetry_first: false,
            filter_mode: default_filter_mode(),
            filter_keys: Vec::new(),
            direction_filter: default_direction_filter(),
        }
    }
}

/// Runtime playback control parameters (`cmd_control_trace_replay`).
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceReplayControlArgsDto {
    /// `"pause"` | `"resume"` | `"stop"` | `"seek"` | `"configure"`
    pub action: String,
    #[serde(default, alias = "seek_us")]
    pub seek_us: Option<u64>,
    #[serde(default, alias = "speed_factor")]
    pub speed_factor: Option<f64>,
    #[serde(default, alias = "loop_playback")]
    pub loop_playback: Option<bool>,
    #[serde(default, alias = "update_bus_override")]
    pub update_bus_override: bool,
    #[serde(default, alias = "bus_override")]
    pub bus_override: Option<u8>,
    #[serde(default, alias = "transmit_to_hardware")]
    pub transmit_to_hardware: Option<bool>,
    #[serde(default, alias = "filter_mode")]
    pub filter_mode: Option<String>,
    #[serde(default, alias = "update_filter_keys")]
    pub update_filter_keys: bool,
    #[serde(default, alias = "filter_keys")]
    pub filter_keys: Option<Vec<String>>,
    #[serde(default, alias = "direction_filter")]
    pub direction_filter: Option<String>,
}

// ─── Diagnostics: HAL-owned DTOs (0x19 reports, passive discovery, physical sweep) ─────
// The UDS session / discovery contracts live in `nexus_protocols::uds::dto`; these wrap them
// for HAL commands. All camelCase, control plane only (one value per user action / poll).

/// `cmd_diag_read_dtc_report` result: the raw UDS response plus the parsed 0x19 report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DtcReportResultDto {
    /// The ECU's answer (negative responses are results, not errors).
    pub response: nexus_protocols::uds::dto::UdsResponseDto,
    /// Parsed report; `None` when the response is negative, empty or unparsable.
    pub report: Option<nexus_protocols::uds::dto::ReadDtcReportDto>,
    /// Why `report` is `None` (`None` whenever `report` is present).
    pub report_error: Option<String>,
}

/// Evidence level of a passively observed tester ↔ ECU pair.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PassiveConfidenceDto {
    /// 1..=2 request → response matches.
    Low,
    /// 3..=9 matches.
    Medium,
    /// 10+ matches, or an ISO-TP Flow Control answered a First Frame between the two ids.
    High,
}

/// One diagnostic `(request id, response id)` pair observed on the bus (no TX involved).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassiveEcuPairDto {
    pub bus_id: u8,
    /// Tester → ECU id (may be a functional id such as 0x7DF / 0x18DB33F1).
    pub request_id: u32,
    /// ECU → tester id.
    pub response_id: u32,
    pub is_extended_id: bool,
    /// Matched transactions (one per request and responder) plus Flow Control matches.
    pub evidence_count: u32,
    /// HAL timestamps (µs, monotonic) of the first / last evidence.
    pub first_seen_us: u64,
    pub last_seen_us: u64,
    /// Request SIDs seen on this pair, ascending.
    pub sids_seen: Vec<u8>,
    pub confidence: PassiveConfidenceDto,
    /// An FC on one id answered an FF on the other.
    pub flow_control_seen: bool,
    /// `requestId` is a functional id (11-bit 0x7DF, 29-bit 0x18DB_xx_xx): open a physical
    /// session with the ECU's physical request id instead.
    pub functional_request: bool,
}

/// State of the passive (Listen-Only safe, TX-free) ECU discovery of one bus.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassiveDiscoverySnapshotDto {
    pub bus_id: u8,
    pub running: bool,
    /// Why the scan ended (`None` while running or never started).
    pub stop_reason: Option<String>,
    /// HAL timestamp (µs) of the start; 0 = never started.
    pub started_at_us: u64,
    /// Frames fed to the analyzer.
    pub frames_analyzed: u64,
    /// Frames lost because the analyzer queue was full (bus faster than the analyzer).
    pub frames_dropped: u64,
    /// Sorted by `(requestId, responseId)`.
    pub pairs: Vec<PassiveEcuPairDto>,
    /// The pair table is full (`maxPairs`): new pairs are counted in `droppedPairs`.
    pub truncated: bool,
    pub dropped_pairs: u32,
    pub max_pairs: u32,
    /// Outstanding requests evicted before their response window ended (pending table full).
    pub evicted_requests: u64,
}

/// Inclusive CAN id range.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdRangeDto {
    pub start: u32,
    pub end: u32,
}

fn default_sweep_padding() -> Option<u8> {
    Some(0xAA)
}

/// `cmd_diag_physical_sweep` request: one single-frame request per physical id, strictly
/// sequential (one request in flight, `gapMs` between transmissions). Active bus required.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalSweepRequestDto {
    pub bus_id: u8,
    pub is_extended_id: bool,
    /// Explicit physical request ids (1..=256, no duplicates). Exactly one of `requestIds` /
    /// `requestIdRange` must be set.
    #[serde(default)]
    pub request_ids: Option<Vec<u32>>,
    /// Inclusive id range (1..=256 ids).
    #[serde(default)]
    pub request_id_range: Option<IdRangeDto>,
    /// UDS PDU sent to every id (single frame). Default `[0x3E, 0x00]`.
    #[serde(default)]
    pub request_pdu: Option<Vec<u8>>,
    /// Gap between two transmissions (ms). Default 20, clamped to 5..=1000.
    #[serde(default)]
    pub gap_ms: Option<u32>,
    /// Collection time after the last request (ms). Default 200, clamped to 0..=5000.
    #[serde(default)]
    pub tail_ms: Option<u32>,
    /// Response filters, same rules as `cmd_diag_discover_ecus` (`responseIdFilters` replaces
    /// `responseId` / `responseMask`; defaults 0x7E8/0x7F8, 29-bit 0x18DAF100/0x1FFFFF00).
    #[serde(default)]
    pub response_id: Option<u32>,
    #[serde(default)]
    pub response_mask: Option<u32>,
    #[serde(default)]
    pub response_id_filters: Option<Vec<nexus_protocols::uds::dto::IdFilterDto>>,
    /// Request id derivation for the listed ECUs (same DTO as discovery).
    #[serde(default)]
    pub request_id_rule: Option<nexus_protocols::uds::dto::RequestIdRuleDto>,
    #[serde(default = "default_sweep_padding")]
    pub padding: Option<u8>,
    #[serde(default)]
    pub use_fd: bool,
    /// `normal` (default), `normalFixed` or `mixed` (N_AE = `targetAddress`). `extended` is
    /// refused: a per-ECU N_TA sweep is not supported yet.
    #[serde(default)]
    pub address_format: nexus_protocols::uds::dto::AddressFormatDto,
    #[serde(default)]
    pub target_address: Option<u8>,
    #[serde(default)]
    pub response_address: Option<u8>,
}

/// Which swept request was in flight when a responder answered for the first time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepResponderDto {
    pub response_id: u32,
    /// Last swept id whose TX confirmation precedes the first answer of `responseId` (HAL
    /// timestamps; exact when the ECU answers within `gapMs`).
    pub in_flight_request_id: u32,
    /// TX confirmation of that request → first answer (µs).
    pub latency_us: u64,
}

/// `cmd_diag_physical_sweep` result (also the partial result of an aborted sweep).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalSweepResultDto {
    pub bus_id: u8,
    pub is_extended_id: bool,
    /// UDS PDU sent to every id (without PCI).
    pub request_bytes: Vec<u8>,
    /// Effective (clamped) gap / tail.
    pub gap_ms: u32,
    pub tail_ms: u32,
    /// Ids to sweep / requests confirmed on the bus.
    pub total: u32,
    pub sent: u32,
    /// Last id confirmed on the bus (`None` = nothing sent).
    pub last_request_id: Option<u32>,
    /// Every id was sent and the tail window elapsed.
    pub completed: bool,
    /// Why the sweep stopped early (`panic_latched`, `disarmed`, `listen_only`,
    /// `bus_not_connected`, `session_closed`, ...). `None` when `completed`.
    pub abort_code: Option<nexus_protocols::uds::dto::DiagErrorCode>,
    pub abort_reason: Option<String>,
    /// HAL timestamp of the first request's TX confirmation (0 = nothing sent).
    pub tx_timestamp_us: u64,
    /// One entry per response id (same DTO as discovery; `firstResponseUs` is relative to
    /// `txTimestampUs`, identify fields are always empty).
    pub ecus: Vec<nexus_protocols::uds::dto::DiscoveredEcuDto>,
    /// Sorted by `responseId`.
    pub responders: Vec<SweepResponderDto>,
    pub ignored_frames: u32,
    pub truncated: bool,
    pub dropped_ecus: u32,
}

// ─── Global & Multi-Window Tear-Off Debug & System Audit Console DTOs ────────

/// Single structured audit / debug event stored in the 5,000-entry `DebugEventHub` ring.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugEventDto {
    pub seq: u64,
    pub timestamp_ms: u64,
    pub monotonic_us: u64,
    /// `"info"` | `"success"` | `"warn"` | `"error"` | `"safety"`
    pub severity: String,
    /// `"CONN"` | `"SAFETY"` | `"TX"` | `"NETDB"` | `"TRACE"` | `"BUS_ERR"` | `"DIAG"` | `"WORKBENCH"`
    pub category: String,
    /// `"backend"` | `"ui"` | `"os"` | `"protocol"`
    pub source: String,
    pub bus_id: Option<u8>,
    pub action: String,
    pub title: String,
    pub details: Option<String>,
    pub repeat_count: u32,
}

/// Frontend / external caller input for appending a structured audit event (`cmd_append_debug_event`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendDebugEventInputDto {
    pub severity: String,
    pub category: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub bus_id: Option<u8>,
    pub action: String,
    pub title: String,
    #[serde(default)]
    pub details: Option<String>,
}

/// Tear-off multi-window state synchronized across `"main"` and `"debug-console"` windows.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugWindowStateDto {
    pub detached_open: bool,
    pub always_on_top: bool,
    pub re_dock_requested: bool,
    pub session_log_path: Option<String>,
}

/// Batched event / state update streamed over `cmd_subscribe_debug_events` (and `/ws/debug`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugEventBatchDto {
    /// `"snapshot"` | `"append"` | `"cleared"` | `"windowState"`
    pub kind: String,
    pub events: Vec<DebugEventDto>,
    pub total_buffered: usize,
    pub window_state: DebugWindowStateDto,
}
