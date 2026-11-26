//! Tauri v2 IPC command handlers delegating to `nexus_hal::pipeline::PipelineEngine`.
//!
//! Strictly avoids per-frame `app.emit()` calls: 60Hz telemetry snapshots stream exclusively
//! over `tauri::ipc::Channel<TelemetrySnapshotDto>`.

use crate::pipeline::AppState;
use nexus_hal::flowlib::{FlowLibEntryDto, FlowLibError, FlowLibRevisionDto};
use nexus_hal::pipeline::diag_flash::{
    flash_error_to_ipc, resolve_download_config, FlashImageHandleDto, FlashLoadFormat,
};
use nexus_hal::pipeline::re_analyzer::{re_dbc_generate, ReDbcBaseDto};
use nexus_hal::pipeline::re_analyzer::{
    ReCandidateDto, ReClassificationDto, ReCorrelateRequest, ReCorrelationResultDto,
    ReFocusStatusDto, ReMarkerDto, RePhase, ReReferenceDto, ReRowDetailDto, ReSearchDto,
    ReSeriesRequest, ReStatusDto, ReTargetDto,
};
use nexus_hal::pipeline::re_analyzer::{
    ReScanFirstSpec, ReScanNextOp, ReScanResultsDto, ReScanSort, ReScanStatusDto,
};
use nexus_hal::pipeline::{validate_cansub_probe_args, PipelineEngine};
use nexus_hal::runstore::{RunQueryFilterDto, RunRecordV1, RunStoreError};
use nexus_hal::seedkey::SeedKeyPolicy;
use nexus_hal::{
    dto::{
        AppendDebugEventInputDto, BusHealthDto, ChannelConfigDto, ChronologicalFrameDto,
        DbFileInputDto, DebugEventBatchDto, DebugEventDto, DebugWindowStateDto,
        DeviceDescriptorDto, DriverProbeReportDto, DtcReportResultDto, HardwareWatchEventDto,
        LoadedTraceFileDto, PanicStopResultDto, PassiveDiscoverySnapshotDto, PeriodicTxJobDto,
        PhysicalSweepRequestDto, PhysicalSweepResultDto, ProjectSummaryDto, ResetSessionResultDto,
        StartTraceReplayArgsDto, TelemetrySnapshotDto, TraceFileSummaryDto,
        TraceReplayControlArgsDto, TraceReplayStatusDto, TraceStorageInfoDto, TxTransmitResultDto,
    },
    error::HalError,
};
use nexus_mcp::UiBridge as _;
use nexus_netdb::re_export::{ReDbcGenerateResult, ReSignalDraft};
use nexus_netdb::DatabaseSchemaDto;
use nexus_protocols::uds::dto::{
    ConversationPageDto, DiagError, DiagErrorCode, DiagOrigin, DiagSessionConfigDto,
    DiagSessionInfoDto, DidReadResultDto, DtcEntryDto, EcuDiscoveryRequestDto,
    EcuDiscoveryResultDto, IsoTpFramePageDto, UdsRequestOptionsDto, UdsResponseDto,
};
use nexus_protocols::uds::flash::{
    FirmwareError, FlashError, FlashErrorKind, FlashPhase, FlashProgressDto, FlashReportDto,
};
use nexus_protocols::uds::security::{
    ComputeKeyResultDto, KeyProviderSpecDto, SeedKeyCapabilitiesDto, SeedKeyError,
    SeedKeyLibraryInfoDto,
};
use serde::Serialize;
use std::sync::Arc;
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    Manager, State,
};
use thiserror::Error;
use tokio::sync::broadcast::error::RecvError;

/// Serializable IPC error returned by all Tauri commands.
#[derive(Debug, Error)]
pub enum AppError {
    #[error(transparent)]
    Hal(#[from] HalError),

    #[error("IPC channel error: {0}")]
    Ipc(String),

    #[error("MCP server error: {0}")]
    Mcp(String),

    #[error(transparent)]
    Update(#[from] crate::update_check::UpdateCheckError),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

// ─── Threading policy (WP-8 / HIGH-10) ──────────────────────────────────────
// Every command is `async` and every command that touches the engine runs its body on the
// Tokio blocking pool via `run_blocking` / `run_diag` / `spawn_blocking`. Engine calls take
// locks, open adapters, parse/compile databases and traces or do file I/O; none of that may
// run on the async runtime workers (which also service the IPC channel). The single
// exception is `cmd_subscribe_telemetry`: it only registers a broadcast receiver and spawns
// the 60 Hz forwarding task (hot path untouched).

/// Runs `f` against the engine on the blocking pool and maps errors to [`AppError`].
async fn run_blocking<T, F>(
    state: State<'_, AppState>,
    what: &'static str,
    f: F,
) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(&PipelineEngine) -> Result<T, HalError> + Send + 'static,
{
    let engine = Arc::clone(&state.engine);
    match tauri::async_runtime::spawn_blocking(move || f(&engine)).await {
        Ok(res) => res.map_err(AppError::from),
        Err(join_err) => Err(AppError::Ipc(format!("{what} worker failed: {join_err}"))),
    }
}

#[tauri::command]
pub async fn cmd_list_devices(
    state: State<'_, AppState>,
) -> Result<Vec<DeviceDescriptorDto>, AppError> {
    run_blocking(state, "cmd_list_devices", move |e| Ok(e.cmd_list_devices())).await
}

#[tauri::command]
pub async fn cmd_probe_drivers(
    state: State<'_, AppState>,
) -> Result<DriverProbeReportDto, AppError> {
    run_blocking(state, "cmd_probe_drivers", move |e| {
        Ok(e.cmd_probe_drivers())
    })
    .await
}

/// Verifies a manually entered CSS Electronics CANsub host (`deviceId` / `acceptAny` select the
/// TLS rule, contract cansub-v1 §2.6) and lists its channels. Arguments are validated before any
/// network I/O; the connect runs on the blocking pool. SDK / driver messages pass through verbatim.
#[tauri::command]
pub async fn cmd_cansub_probe_host(
    state: State<'_, AppState>,
    host: String,
    device_id: Option<String>,
    accept_any: bool,
) -> Result<Vec<DeviceDescriptorDto>, AppError> {
    let (host, device_id) = validate_cansub_probe_args(&host, device_id)?;
    run_blocking(state, "cmd_cansub_probe_host", move |e| {
        e.cmd_cansub_probe_host(host, device_id, accept_any)
    })
    .await
}

#[tauri::command]
pub async fn cmd_subscribe_hardware_changes(
    state: State<'_, AppState>,
    on_event: Channel<HardwareWatchEventDto>,
) -> Result<(), AppError> {
    let engine = Arc::clone(&state.engine);
    let (mut rx, initial) = tauri::async_runtime::spawn_blocking(move || {
        let rx = engine.subscribe_hardware_changes();
        let initial = engine.snapshot_hardware_state("initial");
        (rx, initial)
    })
    .await
    .map_err(|e| AppError::Ipc(format!("cmd_subscribe_hardware_changes worker failed: {e}")))?;

    let _ = on_event.send(initial);

    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(evt) => {
                    if on_event.send(evt).is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn cmd_connect_bus(
    state: State<'_, AppState>,
    device_id: String,
    config: ChannelConfigDto,
) -> Result<BusHealthDto, AppError> {
    run_blocking(state, "cmd_connect_bus", move |e| {
        e.cmd_connect_bus(device_id, config)
    })
    .await
}

#[tauri::command]
pub async fn cmd_disconnect_bus(state: State<'_, AppState>, bus_id: u8) -> Result<(), AppError> {
    run_blocking(state, "cmd_disconnect_bus", move |e| {
        e.cmd_disconnect_bus(bus_id)
    })
    .await
}

#[tauri::command]
pub async fn cmd_disconnect_all_buses(state: State<'_, AppState>) -> Result<usize, AppError> {
    run_blocking(state, "cmd_disconnect_all_buses", move |e| {
        Ok(e.cmd_disconnect_all_buses())
    })
    .await
}

#[tauri::command]
pub async fn cmd_arm_active_bus(
    state: State<'_, AppState>,
    bus_id: u8,
    armed: bool,
) -> Result<BusHealthDto, AppError> {
    run_blocking(state, "cmd_arm_active_bus", move |e| {
        e.cmd_arm_active_bus(bus_id, armed)
    })
    .await
}

#[tauri::command]
pub async fn cmd_set_bus_mode(
    state: State<'_, AppState>,
    bus_id: u8,
    listen_only: bool,
    arm_tx: bool,
) -> Result<BusHealthDto, AppError> {
    run_blocking(state, "cmd_set_bus_mode", move |e| {
        e.cmd_set_bus_mode(bus_id, listen_only, arm_tx)
    })
    .await
}

#[tauri::command]
pub async fn cmd_panic_stop_tx(state: State<'_, AppState>) -> Result<PanicStopResultDto, AppError> {
    run_blocking(state, "cmd_panic_stop_tx", move |e| {
        Ok(e.cmd_panic_stop_tx())
    })
    .await
}

/// WP-4: clears the Panic Stop latch only (buses stay disarmed).
#[tauri::command]
pub async fn cmd_clear_panic_latch(state: State<'_, AppState>) -> Result<(), AppError> {
    run_blocking(state, "cmd_clear_panic_latch", move |e| {
        e.cmd_clear_panic_latch();
        Ok(())
    })
    .await
}

/// WP-4: cold-start reset (stops TX jobs, closes diag, disarms + disconnects all buses,
/// clears the latch). Never latches Panic Stop.
#[tauri::command]
pub async fn cmd_reset_session(
    state: State<'_, AppState>,
) -> Result<ResetSessionResultDto, AppError> {
    run_blocking(state, "cmd_reset_session", move |e| {
        Ok(e.cmd_reset_session())
    })
    .await
}

// ─── WP-2 seed/key (contract planning/contracts/seedkey-v1.md) ──────────────
// Errors are `"[seedkey:<code>] <message>"` strings (`SeedKeyError::to_ipc_string`).

/// Desktop webview: native providers are allowed (contract §4). Reports which native kinds
/// exist and whether the 32/64-bit `library` helper binaries were found.
#[tauri::command]
pub async fn cmd_seedkey_capabilities(
    state: State<'_, AppState>,
) -> Result<SeedKeyCapabilitiesDto, String> {
    let engine = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking(move || {
        engine.cmd_seedkey_capabilities(SeedKeyPolicy::desktop())
    })
    .await
    .map_err(|join_err| {
        SeedKeyError::Script(format!("seed/key worker failed: {join_err}")).to_ipc_string()
    })
}

/// Computes a key with an unsaved provider. Portable kinds (`builtin` / `table` / `script`)
/// run in-process; native kinds run out-of-process: `library` in the isolated
/// `nexus-seedkey-host32/64` helper (vendor DLLs are never loaded into the app),
/// `external_process` as a shell-less child. `http` answers `[seedkey:unsupported]`.
/// Runs on the blocking pool (providers run up to their timeout).
#[tauri::command]
pub async fn cmd_seedkey_compute_adhoc(
    state: State<'_, AppState>,
    provider: KeyProviderSpecDto,
    level: u8,
    seed_hex: String,
) -> Result<ComputeKeyResultDto, String> {
    let engine = Arc::clone(&state.engine);
    match tauri::async_runtime::spawn_blocking(move || {
        engine.cmd_seedkey_compute_adhoc(SeedKeyPolicy::desktop(), &provider, level, &seed_hex)
    })
    .await
    {
        Ok(res) => res.map_err(|e| e.to_ipc_string()),
        Err(join_err) => {
            Err(SeedKeyError::Script(format!("seed/key worker failed: {join_err}")).to_ipc_string())
        }
    }
}

/// Inspects a seed/key library: header (format / arch) parsed without loading it, exports
/// detected in the isolated helper process. Blocking pool.
#[tauri::command]
pub async fn cmd_seedkey_probe_library(
    state: State<'_, AppState>,
    path: String,
) -> Result<SeedKeyLibraryInfoDto, String> {
    let engine = Arc::clone(&state.engine);
    match tauri::async_runtime::spawn_blocking(move || {
        engine.cmd_seedkey_probe_library(SeedKeyPolicy::desktop(), &path)
    })
    .await
    {
        Ok(res) => res.map_err(|e| e.to_ipc_string()),
        Err(join_err) => {
            Err(SeedKeyError::Script(format!("seed/key worker failed: {join_err}")).to_ipc_string())
        }
    }
}

#[tauri::command]
pub async fn cmd_load_preset_databases(
    state: State<'_, AppState>,
) -> Result<DatabaseSchemaDto, AppError> {
    run_blocking(state, "cmd_load_preset_databases", move |e| {
        e.cmd_load_preset_databases()
    })
    .await
}

#[tauri::command]
pub async fn cmd_get_current_schema(
    state: State<'_, AppState>,
) -> Result<Option<DatabaseSchemaDto>, AppError> {
    run_blocking(state, "cmd_get_current_schema", move |e| {
        Ok(e.cmd_get_current_schema())
    })
    .await
}

#[tauri::command]
pub async fn cmd_clear_database(state: State<'_, AppState>) -> Result<(), AppError> {
    run_blocking(state, "cmd_clear_database", move |e| e.cmd_clear_database()).await
}

#[tauri::command]
pub async fn cmd_reset_telemetry(state: State<'_, AppState>) -> Result<(), AppError> {
    run_blocking(state, "cmd_reset_telemetry", move |e| {
        e.cmd_reset_telemetry()
    })
    .await
}

#[tauri::command]
pub async fn cmd_load_database_content(
    state: State<'_, AppState>,
    file_name: String,
    content_base64: String,
    append_to_existing: bool,
) -> Result<DatabaseSchemaDto, AppError> {
    run_blocking(state, "cmd_load_database_content", move |e| {
        e.cmd_load_database_content(file_name, content_base64, append_to_existing)
    })
    .await
}

#[tauri::command]
pub async fn cmd_parse_database_schema(
    state: State<'_, AppState>,
    file_name: String,
    content_base64: String,
) -> Result<DatabaseSchemaDto, AppError> {
    run_blocking(state, "cmd_parse_database_schema", move |e| {
        e.cmd_parse_database_schema(file_name, content_base64)
    })
    .await
}

#[tauri::command]
pub async fn cmd_get_preset_database_files(
    state: State<'_, AppState>,
) -> Result<Vec<DbFileInputDto>, AppError> {
    run_blocking(state, "cmd_get_preset_database_files", move |e| {
        e.cmd_get_preset_database_files()
    })
    .await
}

#[tauri::command]
pub async fn cmd_set_bus_databases(
    state: State<'_, AppState>,
    bus_id: u8,
    files: Vec<DbFileInputDto>,
) -> Result<Option<DatabaseSchemaDto>, AppError> {
    run_blocking(state, "cmd_set_bus_databases", move |e| {
        e.cmd_set_bus_databases(bus_id, files)
    })
    .await
}

/// Hot path: registers the 60 Hz snapshot forwarder only (no blocking work, see policy above).
#[tauri::command]
pub async fn cmd_subscribe_telemetry(
    state: State<'_, AppState>,
    on_snapshot: Channel<TelemetrySnapshotDto>,
) -> Result<(), AppError> {
    if let Some(initial) = state.engine.latest_snapshot() {
        let _ = on_snapshot.send(initial);
    }

    let mut rx = state.engine.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(snapshot) => {
                    if on_snapshot.send(snapshot).is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn cmd_transmit_signal_frame(
    state: State<'_, AppState>,
    bus_id: u8,
    arb_id: u32,
    is_extended: bool,
    signal_values: Vec<(u32, f64)>,
    periodic_ms: Option<u32>,
    job_label: Option<String>,
) -> Result<TxTransmitResultDto, AppError> {
    run_blocking(state, "cmd_transmit_signal_frame", move |e| {
        e.cmd_transmit_signal_frame(
            bus_id,
            arb_id,
            is_extended,
            signal_values,
            periodic_ms,
            job_label,
        )
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn cmd_transmit_raw_frame(
    state: State<'_, AppState>,
    bus_id: u8,
    arb_id: u32,
    is_extended: bool,
    is_fd: bool,
    is_brs: bool,
    data: Vec<u8>,
    periodic_ms: Option<u32>,
    job_label: Option<String>,
) -> Result<TxTransmitResultDto, AppError> {
    run_blocking(state, "cmd_transmit_raw_frame", move |e| {
        e.cmd_transmit_raw_frame(
            bus_id,
            arb_id,
            is_extended,
            is_fd,
            is_brs,
            data,
            periodic_ms,
            job_label,
        )
    })
    .await
}

#[tauri::command]
pub async fn cmd_stop_periodic_tx(state: State<'_, AppState>, job_id: u64) -> Result<(), AppError> {
    run_blocking(state, "cmd_stop_periodic_tx", move |e| {
        e.cmd_stop_periodic_tx(job_id)
    })
    .await
}

#[tauri::command]
pub async fn cmd_list_periodic_tx(
    state: State<'_, AppState>,
) -> Result<Vec<PeriodicTxJobDto>, AppError> {
    run_blocking(state, "cmd_list_periodic_tx", move |e| {
        Ok(e.cmd_list_periodic_tx())
    })
    .await
}

#[tauri::command]
pub async fn cmd_list_projects(
    state: State<'_, AppState>,
) -> Result<Vec<ProjectSummaryDto>, AppError> {
    run_blocking(state, "cmd_list_projects", move |e| e.cmd_list_projects()).await
}

#[tauri::command]
pub async fn cmd_save_project(
    state: State<'_, AppState>,
    file_stem: String,
    project_json: String,
) -> Result<ProjectSummaryDto, AppError> {
    run_blocking(state, "cmd_save_project", move |e| {
        e.cmd_save_project(file_stem, project_json)
    })
    .await
}

#[tauri::command]
pub async fn cmd_load_project(
    state: State<'_, AppState>,
    file_stem: String,
) -> Result<String, AppError> {
    run_blocking(state, "cmd_load_project", move |e| {
        e.cmd_load_project(file_stem)
    })
    .await
}

#[tauri::command]
pub async fn cmd_delete_project(
    state: State<'_, AppState>,
    file_stem: String,
) -> Result<(), AppError> {
    run_blocking(state, "cmd_delete_project", move |e| {
        e.cmd_delete_project(file_stem)
    })
    .await
}

/// Metadata only; `statsKnown == false` entries carry placeholder `frameCount` / `durationUs`.
#[tauri::command]
pub async fn cmd_list_traces(state: State<'_, AppState>) -> Result<TraceStorageInfoDto, AppError> {
    run_blocking(state, "cmd_list_traces", move |e| e.cmd_list_traces()).await
}

#[tauri::command]
pub async fn cmd_save_trace_file(
    state: State<'_, AppState>,
    file_name: String,
    content: Option<String>,
    content_base64: Option<String>,
) -> Result<TraceFileSummaryDto, AppError> {
    run_blocking(state, "cmd_save_trace_file", move |e| {
        e.cmd_save_trace_file(file_name, content, content_base64)
    })
    .await
}

/// Reads + parses a stored trace; never writes to disk.
#[tauri::command]
pub async fn cmd_load_trace_file(
    state: State<'_, AppState>,
    file_name: String,
) -> Result<LoadedTraceFileDto, AppError> {
    run_blocking(state, "cmd_load_trace_file", move |e| {
        e.cmd_load_trace_file(file_name)
    })
    .await
}

#[tauri::command]
pub async fn cmd_delete_trace_file(
    state: State<'_, AppState>,
    file_name: String,
) -> Result<(), AppError> {
    run_blocking(state, "cmd_delete_trace_file", move |e| {
        e.cmd_delete_trace_file(file_name)
    })
    .await
}

/// Stateless in-memory parse of an imported trace; never writes to disk.
#[tauri::command]
pub async fn cmd_parse_trace_content(
    state: State<'_, AppState>,
    file_name: String,
    content: Option<String>,
    content_base64: Option<String>,
) -> Result<LoadedTraceFileDto, AppError> {
    run_blocking(state, "cmd_parse_trace_content", move |e| {
        e.cmd_parse_trace_content(file_name, content, content_base64)
    })
    .await
}

#[tauri::command]
pub async fn cmd_export_trace_blf(
    state: State<'_, AppState>,
    file_name: String,
    frames: Vec<ChronologicalFrameDto>,
) -> Result<String, AppError> {
    run_blocking(state, "cmd_export_trace_blf", move |e| {
        e.cmd_export_trace_blf(file_name, frames)
    })
    .await
}

#[tauri::command]
pub async fn cmd_start_trace_replay(
    state: State<'_, AppState>,
    args: StartTraceReplayArgsDto,
) -> Result<TraceReplayStatusDto, AppError> {
    run_blocking(state, "cmd_start_trace_replay", move |e| {
        e.cmd_start_trace_replay(args)
    })
    .await
}

#[tauri::command]
pub async fn cmd_control_trace_replay(
    state: State<'_, AppState>,
    args: TraceReplayControlArgsDto,
) -> Result<TraceReplayStatusDto, AppError> {
    run_blocking(state, "cmd_control_trace_replay", move |e| {
        e.cmd_control_trace_replay(args)
    })
    .await
}

// ─── D-003 UDS client (`cmd_diag_*`) ────────────────────────────────────────
// Same names/arguments as `nexus_bridge` and `DiagCommandMap` (src/types/udsClient.ts).
// UDS calls block (ISO-TP round trips, P2/P2*), so every command runs on the blocking pool.
// Errors are `"[diag:<code>] <message>"` strings (`DiagError::to_ipc_string`), parsed by
// `parseDiagError` in the HMI.

async fn run_diag<T, F>(state: State<'_, AppState>, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&PipelineEngine) -> Result<T, DiagError> + Send + 'static,
{
    let engine = Arc::clone(&state.engine);
    match tauri::async_runtime::spawn_blocking(move || f(&engine)).await {
        Ok(res) => res.map_err(|e| e.to_ipc_string()),
        Err(join_err) => Err(DiagError::new(
            DiagErrorCode::Internal,
            format!("diag worker failed: {join_err}"),
        )
        .to_ipc_string()),
    }
}

#[tauri::command]
pub async fn cmd_diag_open_session(
    state: State<'_, AppState>,
    config: DiagSessionConfigDto,
) -> Result<DiagSessionInfoDto, String> {
    run_diag(state, move |e| e.cmd_diag_open_session(config)).await
}

#[tauri::command]
pub async fn cmd_diag_close_session(
    state: State<'_, AppState>,
    config: DiagSessionConfigDto,
) -> Result<(), String> {
    run_diag(state, move |e| e.cmd_diag_close_session(config)).await
}

#[tauri::command]
pub async fn cmd_diag_session_info(
    state: State<'_, AppState>,
    config: DiagSessionConfigDto,
) -> Result<DiagSessionInfoDto, String> {
    run_diag(state, move |e| e.cmd_diag_session_info(config)).await
}

#[tauri::command]
pub async fn cmd_diag_send_uds(
    state: State<'_, AppState>,
    config: DiagSessionConfigDto,
    sid: u8,
    sub_function: Option<u8>,
    data: Vec<u8>,
    options: Option<UdsRequestOptionsDto>,
) -> Result<UdsResponseDto, String> {
    run_diag(state, move |e| {
        e.cmd_diag_send_uds(config, sid, sub_function, data, options)
    })
    .await
}

#[tauri::command]
pub async fn cmd_diag_read_did(
    state: State<'_, AppState>,
    config: DiagSessionConfigDto,
    did: u16,
    origin: Option<DiagOrigin>,
) -> Result<DidReadResultDto, String> {
    run_diag(state, move |e| e.cmd_diag_read_did(config, did, origin)).await
}

#[tauri::command]
pub async fn cmd_diag_read_stored_dtcs(
    state: State<'_, AppState>,
    config: DiagSessionConfigDto,
    status_mask: Option<u8>,
    origin: Option<DiagOrigin>,
) -> Result<Vec<DtcEntryDto>, String> {
    run_diag(state, move |e| {
        e.cmd_diag_read_stored_dtcs(config, status_mask, origin)
    })
    .await
}

#[tauri::command]
pub async fn cmd_diag_set_tester_present(
    state: State<'_, AppState>,
    config: DiagSessionConfigDto,
    enabled: bool,
    interval_ms: Option<u32>,
) -> Result<DiagSessionInfoDto, String> {
    run_diag(state, move |e| {
        e.cmd_diag_set_tester_present(config, enabled, interval_ms)
    })
    .await
}

#[tauri::command]
pub async fn cmd_diag_get_conversation(
    state: State<'_, AppState>,
    config: DiagSessionConfigDto,
    since_seq: u64,
    max: Option<u32>,
) -> Result<ConversationPageDto, String> {
    run_diag(state, move |e| {
        e.cmd_diag_get_conversation(config, since_seq, max)
    })
    .await
}

/// Functional-addressing ECU discovery (blocking: fixed window + optional DID identify).
#[tauri::command]
pub async fn cmd_diag_discover_ecus(
    state: State<'_, AppState>,
    request: EcuDiscoveryRequestDto,
) -> Result<EcuDiscoveryResultDto, String> {
    run_diag(state, move |e| e.cmd_diag_discover_ecus(request)).await
}

/// ISO-TP Monitor page (never opens a session).
#[tauri::command]
pub async fn cmd_diag_get_isotp_frames(
    state: State<'_, AppState>,
    config: DiagSessionConfigDto,
    since_seq: u64,
    max: Option<u32>,
) -> Result<IsoTpFramePageDto, String> {
    run_diag(state, move |e| {
        e.cmd_diag_get_isotp_frames(config, since_seq, max)
    })
    .await
}

/// ReadDTCInformation (0x19) with any supported reportType; `params` default empty.
/// Returns the raw response plus the parsed report (`report = null` + `reportError` when the
/// answer is negative or unparsable).
#[tauri::command]
pub async fn cmd_diag_read_dtc_report(
    state: State<'_, AppState>,
    config: DiagSessionConfigDto,
    sub_function: u8,
    params: Option<Vec<u8>>,
    options: Option<UdsRequestOptionsDto>,
) -> Result<DtcReportResultDto, String> {
    run_diag(state, move |e| {
        e.cmd_diag_read_dtc_report(config, sub_function, params.unwrap_or_default(), options)
    })
    .await
}

// ─── ECU flash (nexus_protocols::uds::flash over the diag session path) ──────
// Load / release errors: `"[firmware] <message>"` (`FirmwareError::to_ipc_string`).
// Download errors: `"[flash] " + JSON(FlashError)` (`flash_error_to_ipc`).

/// Decodes (base64, ≤ 64 MiB), parses and caches a firmware file; returns its `imageId`.
/// `format`: `"auto" | "intelHex" | "srec" | "binary"` (`baseAddress` used for binary only).
#[tauri::command]
pub async fn cmd_flash_load_image(
    state: State<'_, AppState>,
    file_name: String,
    format: FlashLoadFormat,
    base_address: u32,
    data_base64: String,
) -> Result<FlashImageHandleDto, String> {
    let engine = Arc::clone(&state.engine);
    match tauri::async_runtime::spawn_blocking(move || {
        engine.cmd_flash_load_image(file_name, format, base_address, &data_base64)
    })
    .await
    {
        Ok(res) => res.map_err(|e| e.to_ipc_string()),
        Err(join_err) => Err(FirmwareError::InvalidArgument(format!(
            "firmware worker failed: {join_err}"
        ))
        .to_ipc_string()),
    }
}

/// Drops a cached firmware image. Idempotent.
#[tauri::command]
pub async fn cmd_flash_release_image(
    state: State<'_, AppState>,
    image_id: String,
) -> Result<(), String> {
    state.engine.cmd_flash_release_image(&image_id);
    Ok(())
}

/// Downloads a cached image (0x34 → 0x36* → 0x37 per segment) through the diag session of
/// `config` (auto-open; connected + armed + not Listen-Only + no Panic latch required).
/// Progress on `on_progress` at ≤ 60 Hz (first event, phase changes and `done` always).
/// One download per session at a time. Runs on the blocking pool for the whole transfer.
#[tauri::command]
pub async fn cmd_flash_download(
    state: State<'_, AppState>,
    config: DiagSessionConfigDto,
    image_id: String,
    download: Option<serde_json::Value>,
    on_progress: Channel<FlashProgressDto>,
) -> Result<FlashReportDto, String> {
    // Raw JSON: an absent `maxBlockLenCap` defaults to 65535 on CAN-FD sessions, else 4095.
    let download = resolve_download_config(download.unwrap_or_default(), config.use_fd)
        .map_err(|e| flash_error_to_ipc(&e))?;
    let engine = Arc::clone(&state.engine);
    match tauri::async_runtime::spawn_blocking(move || {
        engine.cmd_flash_download(config, &image_id, download, &mut |p| {
            // A closed webview channel must not abort the transfer.
            let _ = on_progress.send(p);
        })
    })
    .await
    {
        Ok(res) => res.map_err(|e| flash_error_to_ipc(&e)),
        Err(join_err) => Err(flash_error_to_ipc(&FlashError {
            kind: FlashErrorKind::Transport,
            phase: FlashPhase::RequestDownload,
            segment_index: None,
            address: None,
            offset: None,
            block_counter: None,
            last_nrc: None,
            last_nrc_name: None,
            diag_code: Some(DiagErrorCode::Internal),
            bytes_done: 0,
            segments_completed: 0,
            message: format!("flash worker failed: {join_err}"),
        })),
    }
}

/// Requests cancellation of the download running on `config`'s session (no-op when none).
#[tauri::command]
pub async fn cmd_flash_cancel(
    state: State<'_, AppState>,
    config: DiagSessionConfigDto,
) -> Result<(), String> {
    state.engine.cmd_flash_cancel(&config);
    Ok(())
}

/// Passive (TX-free, Listen-Only safe) ECU discovery: starts watching `busId`. Idempotent.
#[tauri::command]
pub async fn cmd_diag_passive_discovery_start(
    state: State<'_, AppState>,
    bus_id: u8,
) -> Result<PassiveDiscoverySnapshotDto, String> {
    run_diag(state, move |e| e.cmd_diag_passive_discovery_start(bus_id)).await
}

/// Passive ECU discovery: current pairs (also after stop).
#[tauri::command]
pub async fn cmd_diag_passive_discovery_snapshot(
    state: State<'_, AppState>,
    bus_id: u8,
) -> Result<PassiveDiscoverySnapshotDto, String> {
    run_diag(state, move |e| {
        e.cmd_diag_passive_discovery_snapshot(bus_id)
    })
    .await
}

/// Passive ECU discovery: stops the scan and returns the final snapshot.
#[tauri::command]
pub async fn cmd_diag_passive_discovery_stop(
    state: State<'_, AppState>,
    bus_id: u8,
) -> Result<PassiveDiscoverySnapshotDto, String> {
    run_diag(state, move |e| e.cmd_diag_passive_discovery_stop(bus_id)).await
}

/// Active physical sweep: one single-frame request per id, strictly sequential (`gapMs`).
/// Armed, non-Listen-Only bus required; Panic Stop / disarm / disconnect abort it and return
/// the partial result (`completed = false`, `abortCode`). Blocking (`ids x gapMs + tailMs`).
#[tauri::command]
pub async fn cmd_diag_physical_sweep(
    state: State<'_, AppState>,
    request: PhysicalSweepRequestDto,
) -> Result<PhysicalSweepResultDto, String> {
    run_diag(state, move |e| e.cmd_diag_physical_sweep(request)).await
}

// ─── Global & Multi-Window Tear-Off Debug & System Audit Console ────────────

#[tauri::command]
pub async fn cmd_subscribe_debug_events(
    state: State<'_, AppState>,
    on_batch: Channel<DebugEventBatchDto>,
) -> Result<(), AppError> {
    let engine = Arc::clone(&state.engine);
    let engine_for_lag = Arc::clone(&state.engine);
    let (mut rx, initial) = tauri::async_runtime::spawn_blocking(move || {
        let rx = engine.subscribe_debug_events();
        let initial = engine.snapshot_debug_events();
        (rx, initial)
    })
    .await
    .map_err(|e| AppError::Ipc(format!("cmd_subscribe_debug_events worker failed: {e}")))?;

    let _ = on_batch.send(initial);

    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(batch) => {
                    if on_batch.send(batch).is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => {
                    let snap = engine_for_lag.snapshot_debug_events();
                    if on_batch.send(snap).is_err() {
                        break;
                    }
                }
                Err(RecvError::Closed) => break,
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn cmd_append_debug_event(
    state: State<'_, AppState>,
    input: AppendDebugEventInputDto,
) -> Result<DebugEventDto, AppError> {
    run_blocking(state, "cmd_append_debug_event", move |e| {
        Ok(e.cmd_append_debug_event(input))
    })
    .await
}

#[tauri::command]
pub async fn cmd_clear_debug_events(state: State<'_, AppState>) -> Result<(), AppError> {
    run_blocking(state, "cmd_clear_debug_events", move |e| {
        e.cmd_clear_debug_events();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn cmd_export_debug_events(
    state: State<'_, AppState>,
    format: String,
) -> Result<String, AppError> {
    run_blocking(state, "cmd_export_debug_events", move |e| {
        e.cmd_export_debug_events(format)
    })
    .await
}

#[tauri::command]
pub async fn cmd_set_debug_window_open(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    open: bool,
    always_on_top: Option<bool>,
    redock: Option<bool>,
) -> Result<DebugWindowStateDto, AppError> {
    if open {
        if let Some(win) = app.get_webview_window("debug-console") {
            if let Some(aot) = always_on_top {
                let _ = win.set_always_on_top(aot);
            }
            let effective_aot = always_on_top
                .unwrap_or_else(|| state.engine.debug_hub().window_state().always_on_top);
            let _ = win.show();
            let _ = win.set_focus();
            return Ok(state
                .engine
                .set_debug_window_state(true, effective_aot, false));
        }

        let aot = always_on_top.unwrap_or(false);
        let win = tauri::WebviewWindowBuilder::new(
            &app,
            "debug-console",
            tauri::WebviewUrl::App("index.html?window=debug-console".into()),
        )
        .title("NexusCAN — Debug & System Audit Console")
        .inner_size(1140.0, 640.0)
        .min_inner_size(720.0, 360.0)
        .resizable(true)
        .always_on_top(aot)
        .build()
        .map_err(|e| AppError::Ipc(e.to_string()))?;

        let hub = Arc::clone(state.engine.debug_hub());
        win.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let _ = hub.notify_external_window_destroyed();
            }
        });

        Ok(state.engine.set_debug_window_state(true, aot, false))
    } else {
        let ws = state
            .engine
            .set_debug_window_state(false, false, redock.unwrap_or(false));
        if let Some(win) = app.get_webview_window("debug-console") {
            let _ = win.close();
        }
        Ok(ws)
    }
}

/// Manages one local Trace viewer. Only the main analyzer can open or close it.
#[tauri::command]
pub async fn cmd_trace_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    channel_id: String,
    action: String,
) -> Result<bool, AppError> {
    if window.label() != "main"
        || channel_id.len() != 32
        || !channel_id.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(AppError::Ipc("Invalid Trace window request".into()));
    }
    let label = format!("trace-view-{channel_id}");
    let existing = app.get_webview_window(&label);
    match action.as_str() {
        "exists" => Ok(existing.is_some()),
        "focus" | "close" => {
            let Some(view) = existing else { return Ok(false) };
            let result = if action == "focus" { view.set_focus() } else { view.close() };
            result.map_err(|error| AppError::Ipc(error.to_string()))?;
            Ok(true)
        }
        "open" => {
            if let Some(view) = existing {
                view.set_focus().map_err(|error| AppError::Ipc(error.to_string()))?;
                return Ok(true);
            }
            tauri::WebviewWindowBuilder::new(
                &app,
                label,
                tauri::WebviewUrl::App(format!("index.html?window=trace&key={channel_id}").into()),
            )
            .title("NexusCAN — Trace")
            .inner_size(1200.0, 700.0)
            .min_inner_size(720.0, 360.0)
            .build()
            .map_err(|error| AppError::Ipc(error.to_string()))?;
            Ok(true)
        }
        _ => Err(AppError::Ipc("Unknown Trace window action".into())),
    }
}

// ─── Diagnostics Workspace: flow library + run store (diag-workspace-v1 §9 / §10) ───
// Same names/arguments as `nexus_bridge`, `FlowLibCommandMap` (src/types/flowLibrary.ts) and
// `RunStoreCommandMap` (src/types/runRecord.ts). File I/O → blocking pool. Errors are
// `"[flowlib:<code>] <message>"` / `"[runstore:<code>] <message>"` strings
// (`FlowLibError::to_ipc_string` / `RunStoreError::to_ipc_string`), parsed by
// `parseFlowLibError` / `parseRunStoreError` in the HMI.

async fn run_flowlib<T, F>(state: State<'_, AppState>, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&PipelineEngine) -> Result<T, FlowLibError> + Send + 'static,
{
    let engine = Arc::clone(&state.engine);
    match tauri::async_runtime::spawn_blocking(move || f(&engine)).await {
        Ok(res) => res.map_err(|e| e.to_ipc_string()),
        Err(join_err) => {
            Err(FlowLibError::Io(format!("flow library worker failed: {join_err}")).to_ipc_string())
        }
    }
}

async fn run_runstore<T, F>(state: State<'_, AppState>, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&PipelineEngine) -> Result<T, RunStoreError> + Send + 'static,
{
    let engine = Arc::clone(&state.engine);
    match tauri::async_runtime::spawn_blocking(move || f(&engine)).await {
        Ok(res) => res.map_err(|e| e.to_ipc_string()),
        Err(join_err) => {
            Err(RunStoreError::Io(format!("run store worker failed: {join_err}")).to_ipc_string())
        }
    }
}

/// Library entries (soft-deleted ones only with `includeDeleted`).
#[tauri::command]
pub async fn cmd_flowlib_list(
    state: State<'_, AppState>,
    include_deleted: bool,
) -> Result<Vec<FlowLibEntryDto>, String> {
    run_flowlib(state, move |e| e.cmd_flowlib_list(include_deleted)).await
}

/// All revisions of one id, ascending.
#[tauri::command]
pub async fn cmd_flowlib_revisions(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<FlowLibRevisionDto>, String> {
    run_flowlib(state, move |e| e.cmd_flowlib_revisions(&id)).await
}

/// Raw `.nxflow.json` of a revision (`revision: null` = latest).
#[tauri::command]
pub async fn cmd_flowlib_load(
    state: State<'_, AppState>,
    id: String,
    revision: Option<u32>,
) -> Result<String, String> {
    run_flowlib(state, move |e| e.cmd_flowlib_load(&id, revision)).await
}

/// Saves a new immutable revision (`flow.revision` must be latest + 1).
#[tauri::command]
pub async fn cmd_flowlib_save(
    state: State<'_, AppState>,
    file_json: String,
) -> Result<FlowLibEntryDto, String> {
    run_flowlib(state, move |e| e.cmd_flowlib_save(&file_json)).await
}

/// Soft delete; revisions stay loadable for pinned references.
#[tauri::command]
pub async fn cmd_flowlib_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    run_flowlib(state, move |e| e.cmd_flowlib_delete(&id)).await
}

/// Appends one immutable run record (append + flush + fsync).
#[tauri::command]
pub async fn cmd_run_append(state: State<'_, AppState>, record: RunRecordV1) -> Result<(), String> {
    run_runstore(state, move |e| e.cmd_run_append(&record)).await
}

/// Filtered run records, newest first (`limit` 1..=5000).
#[tauri::command]
pub async fn cmd_run_query(
    state: State<'_, AppState>,
    project_id: String,
    filter: RunQueryFilterDto,
    limit: i64,
) -> Result<Vec<RunRecordV1>, String> {
    run_runstore(state, move |e| e.cmd_run_query(&project_id, &filter, limit)).await
}

/// Latest top-level record per (ecuId, flowId), newest first.
#[tauri::command]
pub async fn cmd_run_latest(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<RunRecordV1>, String> {
    run_runstore(state, move |e| e.cmd_run_latest(&project_id)).await
}

// ─── RE Toolkit R1 (planning/contracts/re-toolkit-v1.md §2.1) — passive only ─────────────────
// RE ingest runs in the aggregator thread; these commands only toggle / read the shared
// analyzer. `cmd_re_subscribe` streams 10 Hz binary snapshots (§2.2) as raw `ArrayBuffer`
// (`InvokeResponseBody::Raw`) until `cmd_re_stop` or a newer subscription.

#[tauri::command]
pub async fn cmd_re_start(
    state: State<'_, AppState>,
    buses: Option<Vec<u8>>,
) -> Result<ReStatusDto, AppError> {
    run_blocking(state, "cmd_re_start", move |e| Ok(e.cmd_re_start(buses))).await
}

#[tauri::command]
pub async fn cmd_re_stop(state: State<'_, AppState>) -> Result<ReStatusDto, AppError> {
    run_blocking(state, "cmd_re_stop", move |e| Ok(e.cmd_re_stop())).await
}

#[tauri::command]
pub async fn cmd_re_reset(state: State<'_, AppState>) -> Result<ReStatusDto, AppError> {
    run_blocking(state, "cmd_re_reset", move |e| Ok(e.cmd_re_reset())).await
}

#[tauri::command]
pub async fn cmd_re_set_phase(
    state: State<'_, AppState>,
    phase: RePhase,
) -> Result<ReStatusDto, AppError> {
    run_blocking(state, "cmd_re_set_phase", move |e| {
        e.cmd_re_set_phase(phase)
    })
    .await
}

#[tauri::command]
pub async fn cmd_re_mark(
    state: State<'_, AppState>,
    label: String,
) -> Result<ReMarkerDto, AppError> {
    run_blocking(state, "cmd_re_mark", move |e| Ok(e.cmd_re_mark(&label))).await
}

#[tauri::command]
pub async fn cmd_re_markers(state: State<'_, AppState>) -> Result<Vec<ReMarkerDto>, AppError> {
    run_blocking(state, "cmd_re_markers", move |e| Ok(e.cmd_re_markers())).await
}

#[tauri::command]
pub async fn cmd_re_subscribe(
    state: State<'_, AppState>,
    on_snapshot: Channel<InvokeResponseBody>,
) -> Result<(), AppError> {
    run_blocking(state, "cmd_re_subscribe", move |e| {
        // One copy per 10 Hz tick at the IPC hand-off (Tauri takes ownership of the body);
        // the encoder itself writes into a buffer reserved once by the snapshot thread.
        e.cmd_re_subscribe(Box::new(move |bytes: &[u8]| {
            on_snapshot
                .send(InvokeResponseBody::Raw(bytes.to_vec()))
                .is_ok()
        }))
    })
    .await
}

#[tauri::command]
pub async fn cmd_re_row_detail(
    state: State<'_, AppState>,
    bus: u8,
    arb_id: u32,
    is_extended: bool,
) -> Result<ReRowDetailDto, AppError> {
    run_blocking(state, "cmd_re_row_detail", move |e| {
        e.cmd_re_row_detail(bus, arb_id, is_extended)
    })
    .await
}

#[tauri::command]
pub async fn cmd_re_classify(
    state: State<'_, AppState>,
    bus: u8,
    arb_id: u32,
    is_extended: bool,
) -> Result<ReClassificationDto, AppError> {
    run_blocking(state, "cmd_re_classify", move |e| {
        e.cmd_re_classify(bus, arb_id, is_extended)
    })
    .await
}

// ─── RE Toolkit R2a — Signal Inspector (re-toolkit-v1 §6), passive only ──────────────────────
// Errors keep the `"[re:<code>] message"` text (invalid | focus_full | no_reference | not_started).

#[tauri::command]
pub async fn cmd_re_focus_set(
    state: State<'_, AppState>,
    targets: Vec<ReTargetDto>,
) -> Result<ReFocusStatusDto, AppError> {
    run_blocking(state, "cmd_re_focus_set", move |e| {
        e.cmd_re_focus_set(targets)
    })
    .await
}

#[tauri::command]
pub async fn cmd_re_focus_status(state: State<'_, AppState>) -> Result<ReFocusStatusDto, AppError> {
    run_blocking(state, "cmd_re_focus_status", move |e| {
        Ok(e.cmd_re_focus_status())
    })
    .await
}

/// §6.3 series as a raw binary body (`ArrayBuffer` on the JS side, decoded by `reSeriesCodec.ts`).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn cmd_re_series(
    state: State<'_, AppState>,
    target: ReTargetDto,
    candidates: Vec<ReCandidateDto>,
    reference: Option<ReReferenceDto>,
    from_us: Option<u64>,
    to_us: Option<u64>,
    max_points: u16,
) -> Result<tauri::ipc::Response, AppError> {
    let req = ReSeriesRequest {
        target,
        candidates,
        reference,
        from_us,
        to_us,
        max_points,
    };
    run_blocking(state, "cmd_re_series", move |e| e.cmd_re_series(req))
        .await
        .map(tauri::ipc::Response::new)
}

/// Runs on a Tauri blocking worker (never the aggregator); the analyzer lock is held only for
/// the bounded window copy, the ≤ 2 s sweep runs without it; a newer call cancels an older one.
#[tauri::command]
pub async fn cmd_re_correlate(
    state: State<'_, AppState>,
    target: ReTargetDto,
    reference: ReReferenceDto,
    from_us: Option<u64>,
    to_us: Option<u64>,
    search: ReSearchDto,
    top_n: u8,
) -> Result<ReCorrelationResultDto, AppError> {
    let req = ReCorrelateRequest {
        target,
        reference,
        from_us,
        to_us,
        search,
        top_n,
    };
    run_blocking(state, "cmd_re_correlate", move |e| e.cmd_re_correlate(req)).await
}

// ─── RE Toolkit R2c — Value Scan (re-toolkit-v1 §8.3) ──────────────────────────────────
// Every scan command runs on a Tauri blocking worker (never the aggregator, never the async
// runtime): first / next / results are CPU-bound (≤ 2 s budget, analyzer lock only for the row
// copy). Errors keep the "[re:<code>] …" text.

#[tauri::command]
pub async fn cmd_re_scan_first(
    state: State<'_, AppState>,
    spec: ReScanFirstSpec,
) -> Result<ReScanStatusDto, AppError> {
    run_blocking(state, "cmd_re_scan_first", move |e| {
        e.cmd_re_scan_first(spec)
    })
    .await
}

#[tauri::command]
pub async fn cmd_re_scan_next(
    state: State<'_, AppState>,
    op: ReScanNextOp,
) -> Result<ReScanStatusDto, AppError> {
    run_blocking(state, "cmd_re_scan_next", move |e| e.cmd_re_scan_next(op)).await
}

#[tauri::command]
pub async fn cmd_re_scan_undo(state: State<'_, AppState>) -> Result<ReScanStatusDto, AppError> {
    run_blocking(state, "cmd_re_scan_undo", |e| e.cmd_re_scan_undo()).await
}

#[tauri::command]
pub async fn cmd_re_scan_reset(state: State<'_, AppState>) -> Result<ReScanStatusDto, AppError> {
    run_blocking(state, "cmd_re_scan_reset", |e| Ok(e.cmd_re_scan_reset())).await
}

#[tauri::command]
pub async fn cmd_re_scan_status(state: State<'_, AppState>) -> Result<ReScanStatusDto, AppError> {
    run_blocking(state, "cmd_re_scan_status", |e| Ok(e.cmd_re_scan_status())).await
}

#[tauri::command]
pub async fn cmd_re_scan_results(
    state: State<'_, AppState>,
    offset: u32,
    limit: u32,
    sort: ReScanSort,
) -> Result<ReScanResultsDto, AppError> {
    run_blocking(state, "cmd_re_scan_results", move |e| {
        e.cmd_re_scan_results(offset, limit, sort)
    })
    .await
}

/// R2b (§7.3): DBC text for RE signal drafts, standalone or merged into `base` (`.dbc` / `.kcd`,
/// base64). Pure generator on a Tauri blocking worker: no engine state, no file system writes
/// (saving stays on the frontend's save / download path). Input / base errors are
/// `"[re:invalid] …"`; generator findings are diagnostics in the result. `drafts: []` with
/// `base: null` is the frontend's reachability probe.
#[tauri::command]
pub async fn cmd_re_dbc_generate(
    drafts: Vec<ReSignalDraft>,
    base: Option<ReDbcBaseDto>,
) -> Result<ReDbcGenerateResult, AppError> {
    match tauri::async_runtime::spawn_blocking(move || re_dbc_generate(&drafts, base.as_ref()))
        .await
    {
        Ok(res) => res.map_err(|e| AppError::Hal(HalError::InvalidInput(e.to_string()))),
        Err(join_err) => Err(AppError::Ipc(format!(
            "cmd_re_dbc_generate worker failed: {join_err}"
        ))),
    }
}

// ─── In-app read-only MCP server (MCP M1) ───────────────────────────────────
// Streamable HTTP on 127.0.0.1 only, bearer-token protected, off by default. The server only
// calls read-only engine APIs on the blocking pool (no TX / arm / bus mode / UDS / flash /
// replay), so it never touches the RX / aggregator hot path.

/// Status of the in-app MCP server (frontend contract, camelCase).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatusDto {
    pub running: bool,
    pub port: Option<u16>,
    /// `"http://127.0.0.1:17800/mcp"`
    pub endpoint_url: Option<String>,
    /// Bearer token; only while running.
    pub token: Option<String>,
    pub connected_clients: u32,
    pub total_calls: u64,
    /// M1: always `true`.
    pub read_only: bool,
    pub last_error: Option<String>,
    /// `true` while a frontend is attached to the MCP UI bridge (`cmd_mcp_ui_attach`).
    pub ui_attached: bool,
}

fn mcp_status_dto(slot: &crate::pipeline::McpSlot, ui_attached: bool) -> McpServerStatusDto {
    match slot.handle.as_ref().map(|h| h.status()) {
        Some(st) if st.running => McpServerStatusDto {
            running: true,
            port: Some(st.port),
            endpoint_url: Some(st.endpoint_url),
            token: Some(st.token),
            connected_clients: st.connected_clients,
            total_calls: st.total_calls,
            read_only: true,
            last_error: slot.last_error.clone(),
            ui_attached,
        },
        // Stopped, or the HTTP task died (its error is surfaced via `last_error`).
        other => McpServerStatusDto {
            running: false,
            port: None,
            endpoint_url: None,
            token: None,
            connected_clients: 0,
            total_calls: other
                .as_ref()
                .map_or(slot.last_total_calls, |st| st.total_calls),
            read_only: true,
            last_error: other
                .and_then(|st| st.last_error)
                .or_else(|| slot.last_error.clone()),
            ui_attached,
        },
    }
}

#[tauri::command]
pub async fn cmd_mcp_start(
    state: State<'_, AppState>,
    port: Option<u16>,
) -> Result<McpServerStatusDto, AppError> {
    let port = port.unwrap_or(nexus_mcp::DEFAULT_PORT);
    let mut slot = state.mcp_slot();
    if port == 0 {
        let msg = "MCP port must be between 1 and 65535".to_string();
        slot.last_error = Some(msg.clone());
        return Err(AppError::Mcp(msg));
    }
    if let Some(st) = slot.handle.as_ref().map(|h| h.status()) {
        if st.running {
            if st.port == port {
                return Ok(mcp_status_dto(&slot, state.ui_bridge.attached()));
            }
            return Err(AppError::Mcp(format!(
                "MCP server is already running on port {}; stop it before starting on port {port}",
                st.port
            )));
        }
        // Dead instance (HTTP task ended): keep its error/counters, then replace it.
        slot.last_total_calls = st.total_calls;
        if st.last_error.is_some() {
            slot.last_error = st.last_error;
        }
        if let Some(old) = slot.handle.take() {
            old.stop();
        }
    }
    let rt = tauri::async_runtime::handle();
    let ui: Arc<dyn nexus_mcp::UiBridge> = Arc::new(state.ui_bridge.clone());
    match nexus_mcp::start_with_ui(
        Arc::clone(&state.engine),
        nexus_mcp::McpConfig { port },
        Some(ui),
        rt.inner(),
    ) {
        Ok(handle) => {
            slot.handle = Some(handle);
            slot.last_error = None;
            Ok(mcp_status_dto(&slot, state.ui_bridge.attached()))
        }
        Err(e) => {
            let msg = e.to_string();
            slot.last_error = Some(msg.clone());
            Err(AppError::Mcp(msg))
        }
    }
}

#[tauri::command]
pub async fn cmd_mcp_stop(state: State<'_, AppState>) -> Result<McpServerStatusDto, AppError> {
    let handle = {
        let mut slot = state.mcp_slot();
        if let Some(h) = &slot.handle {
            slot.last_total_calls = h.status().total_calls;
        }
        slot.handle.take()
    };
    if let Some(h) = handle {
        // Waits until the listener is closed so an immediate restart can reuse the port.
        h.shutdown().await;
    }
    Ok(mcp_status_dto(
        &state.mcp_slot(),
        state.ui_bridge.attached(),
    ))
}

#[tauri::command]
pub async fn cmd_mcp_status(state: State<'_, AppState>) -> Result<McpServerStatusDto, AppError> {
    Ok(mcp_status_dto(
        &state.mcp_slot(),
        state.ui_bridge.attached(),
    ))
}

/// Attaches the frontend to the MCP UI bridge; a new attach replaces the previous one.
#[tauri::command]
pub async fn cmd_mcp_ui_attach(
    state: State<'_, AppState>,
    on_request: Channel<crate::pipeline::ui_bridge::UiRequestDto>,
) -> Result<(), AppError> {
    state
        .ui_bridge
        .attach_sink(Box::new(move |req| on_request.send(req).is_ok()));
    Ok(())
}

/// Frontend answer to a UI bridge request. Unknown or late `request_id`s are ignored.
#[tauri::command]
pub async fn cmd_mcp_ui_respond(
    state: State<'_, AppState>,
    request_id: u64,
    ok: bool,
    result: Option<serde_json::Value>,
    error: Option<String>,
) -> Result<(), AppError> {
    let res = if ok {
        Ok(result.unwrap_or(serde_json::Value::Null))
    } else {
        Err(error.unwrap_or_else(|| "NexusCAN UI reported an error".to_string()))
    };
    let _ = state.ui_bridge.respond(request_id, res);
    Ok(())
}

// ─── GitHub release update check (update-check-v1) ─────────────────────────
// Check + notify only. Logic lives in `crate::update_check`; no `EngineState`, no hot path.

/// Installed version + embedded CI build number (no network); feeds the status-bar label.
#[tauri::command]
pub fn cmd_get_app_version() -> crate::update_check::AppVersionDto {
    crate::update_check::app_version()
}

/// Queries the GitHub Releases API (8 s timeout) on the blocking pool.
#[tauri::command]
pub async fn cmd_check_for_update() -> Result<crate::update_check::UpdateCheckDto, AppError> {
    match tauri::async_runtime::spawn_blocking(crate::update_check::check_for_update_blocking).await
    {
        Ok(res) => res.map_err(AppError::from),
        Err(join_err) => Err(AppError::Ipc(format!(
            "cmd_check_for_update worker failed: {join_err}"
        ))),
    }
}

/// Opens the GitHub Releases page (or a whitelisted URL below it) in the system browser.
#[tauri::command]
pub async fn cmd_open_release_page(
    app: tauri::AppHandle,
    url: Option<String>,
) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt as _;
    let target = crate::update_check::resolve_release_url(url)?;
    match tauri::async_runtime::spawn_blocking(move || app.opener().open_url(target, None::<&str>))
        .await
    {
        Ok(res) => res.map_err(|e| AppError::Ipc(format!("failed to open browser: {e}"))),
        Err(join_err) => Err(AppError::Ipc(format!(
            "cmd_open_release_page worker failed: {join_err}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `cmd_cansub_probe_host` argument validation runs before any network I/O.
    #[test]
    fn cansub_probe_host_rejects_invalid_arguments() {
        for host in ["", "   "] {
            let err = AppError::from(validate_cansub_probe_args(host, None).unwrap_err());
            assert!(err.to_string().contains("must not be empty"), "{err}");
        }
        let long = "a".repeat(254);
        assert!(validate_cansub_probe_args(&long, None).is_err());
        assert!(validate_cansub_probe_args(&"a".repeat(253), None).is_ok());

        for bad in ["1234567", "123456789", "1a2b3c4g", "12 34 56", "0x1a2b3c"] {
            let err = validate_cansub_probe_args("10.0.0.1", Some(bad.into())).unwrap_err();
            assert!(err.to_string().contains("8 hex digits"), "{bad}: {err}");
        }
    }

    #[test]
    fn cansub_probe_host_normalizes_arguments() {
        let (host, id) =
            validate_cansub_probe_args(" 1a2b3c4d-usb.local ", Some(" 1A2B3C4D ".into())).unwrap();
        assert_eq!(host, "1a2b3c4d-usb.local");
        assert_eq!(id.as_deref(), Some("1a2b3c4d"));
        let (_, id) = validate_cansub_probe_args("10.123.45.1", Some("  ".into())).unwrap();
        assert_eq!(id, None);
        assert!(crate::app_commands::APP_COMMANDS.contains(&"cmd_cansub_probe_host"));
    }
}
