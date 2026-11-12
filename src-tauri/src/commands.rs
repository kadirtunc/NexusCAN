//! Tauri v2 IPC command handlers delegating to `nexus_hal::pipeline::PipelineEngine`.
//!
//! Strictly avoids per-frame `app.emit()` calls: 60Hz telemetry snapshots stream exclusively
//! over `tauri::ipc::Channel<TelemetrySnapshotDto>`.

use crate::pipeline::AppState;
use nexus_hal::{
    dto::{
        BusHealthDto, ChannelConfigDto, ChronologicalFrameDto, DbFileInputDto, DeviceDescriptorDto,
        DriverProbeReportDto, LoadedTraceFileDto, PanicStopResultDto, PeriodicTxJobDto,
        ProjectSummaryDto, ResetSessionResultDto, StartTraceReplayArgsDto, TelemetrySnapshotDto,
        TraceFileSummaryDto,
        TraceReplayControlArgsDto, TraceReplayStatusDto, TraceStorageInfoDto, TxTransmitResultDto,
    },
    error::HalError,
};
use nexus_hal::pipeline::PipelineEngine;
use nexus_netdb::DatabaseSchemaDto;
use nexus_protocols::uds::dto::{
    ConversationPageDto, DiagError, DiagErrorCode, DiagOrigin, DiagSessionConfigDto, DiagSessionInfoDto,
    DidReadResultDto, DtcEntryDto, EcuDiscoveryRequestDto, EcuDiscoveryResultDto, IsoTpFramePageDto,
    UdsRequestOptionsDto, UdsResponseDto,
};
use nexus_protocols::uds::security::{
    ComputeKeyResultDto, KeyProviderSpecDto, SeedKeyCapabilitiesDto, SeedKeyError,
};
use std::sync::Arc;
use serde::Serialize;
use tauri::{ipc::Channel, State};
use thiserror::Error;
use tokio::sync::broadcast::error::RecvError;

/// Serializable IPC error returned by all Tauri commands.
#[derive(Debug, Error)]
pub enum AppError {
    #[error(transparent)]
    Hal(#[from] HalError),

    #[error("IPC channel error: {0}")]
    Ipc(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[tauri::command]
pub async fn cmd_list_devices(
    state: State<'_, AppState>,
) -> Result<Vec<DeviceDescriptorDto>, AppError> {
    Ok(state.engine.cmd_list_devices())
}

#[tauri::command]
pub async fn cmd_probe_drivers(
    state: State<'_, AppState>,
) -> Result<DriverProbeReportDto, AppError> {
    Ok(state.engine.cmd_probe_drivers())
}

#[tauri::command]
pub async fn cmd_connect_bus(
    state: State<'_, AppState>,
    device_id: String,
    config: ChannelConfigDto,
) -> Result<BusHealthDto, AppError> {
    Ok(state.engine.cmd_connect_bus(device_id, config)?)
}

#[tauri::command]
pub async fn cmd_disconnect_bus(
    state: State<'_, AppState>,
    bus_id: u8,
) -> Result<(), AppError> {
    Ok(state.engine.cmd_disconnect_bus(bus_id)?)
}

#[tauri::command]
pub async fn cmd_disconnect_all_buses(
    state: State<'_, AppState>,
) -> Result<usize, AppError> {
    Ok(state.engine.cmd_disconnect_all_buses())
}

#[tauri::command]
pub async fn cmd_arm_active_bus(
    state: State<'_, AppState>,
    bus_id: u8,
    armed: bool,
) -> Result<BusHealthDto, AppError> {
    Ok(state.engine.cmd_arm_active_bus(bus_id, armed)?)
}

#[tauri::command]
pub async fn cmd_set_bus_mode(
    state: State<'_, AppState>,
    bus_id: u8,
    listen_only: bool,
    arm_tx: bool,
) -> Result<BusHealthDto, AppError> {
    Ok(state
        .engine
        .cmd_set_bus_mode(bus_id, listen_only, arm_tx)?)
}

#[tauri::command]
pub async fn cmd_panic_stop_tx(
    state: State<'_, AppState>,
) -> Result<PanicStopResultDto, AppError> {
    Ok(state.engine.cmd_panic_stop_tx())
}

/// WP-4: clears the Panic Stop latch only (buses stay disarmed).
#[tauri::command]
pub async fn cmd_clear_panic_latch(state: State<'_, AppState>) -> Result<(), AppError> {
    state.engine.cmd_clear_panic_latch();
    Ok(())
}

/// WP-4: cold-start reset (stops TX jobs, closes diag, disarms + disconnects all buses,
/// clears the latch). Never latches Panic Stop.
#[tauri::command]
pub async fn cmd_reset_session(
    state: State<'_, AppState>,
) -> Result<ResetSessionResultDto, AppError> {
    let engine = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking(move || engine.cmd_reset_session())
        .await
        .map_err(|e| AppError::Ipc(format!("reset session worker failed: {e}")))
}

// ─── WP-2 seed/key (contract planning/contracts/seedkey-v1.md) ──────────────
// Errors are `"[seedkey:<code>] <message>"` strings (`SeedKeyError::to_ipc_string`).

#[tauri::command]
pub async fn cmd_seedkey_capabilities(
    state: State<'_, AppState>,
) -> Result<SeedKeyCapabilitiesDto, String> {
    Ok(state.engine.cmd_seedkey_capabilities())
}

/// Computes a key with an unsaved provider (`builtin` / `table` / `script`). Native kinds are
/// refused in v0.1. Runs on the blocking pool (Rhai scripts run up to their timeout).
#[tauri::command]
pub async fn cmd_seedkey_compute_adhoc(
    state: State<'_, AppState>,
    provider: KeyProviderSpecDto,
    level: u8,
    seed_hex: String,
) -> Result<ComputeKeyResultDto, String> {
    let engine = Arc::clone(&state.engine);
    match tauri::async_runtime::spawn_blocking(move || {
        engine.cmd_seedkey_compute_adhoc(&provider, level, &seed_hex)
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
    Ok(state.engine.cmd_load_preset_databases()?)
}

#[tauri::command]
pub async fn cmd_get_current_schema(
    state: State<'_, AppState>,
) -> Result<Option<DatabaseSchemaDto>, AppError> {
    Ok(state.engine.cmd_get_current_schema())
}

#[tauri::command]
pub async fn cmd_clear_database(
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    Ok(state.engine.cmd_clear_database()?)
}

#[tauri::command]
pub async fn cmd_reset_telemetry(
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    Ok(state.engine.cmd_reset_telemetry()?)
}

#[tauri::command]
pub async fn cmd_load_database_content(
    state: State<'_, AppState>,
    file_name: String,
    content_base64: String,
    append_to_existing: bool,
) -> Result<DatabaseSchemaDto, AppError> {
    Ok(state
        .engine
        .cmd_load_database_content(file_name, content_base64, append_to_existing)?)
}

#[tauri::command]
pub async fn cmd_parse_database_schema(
    state: State<'_, AppState>,
    file_name: String,
    content_base64: String,
) -> Result<DatabaseSchemaDto, AppError> {
    Ok(state
        .engine
        .cmd_parse_database_schema(file_name, content_base64)?)
}

#[tauri::command]
pub async fn cmd_get_preset_database_files(
    state: State<'_, AppState>,
) -> Result<Vec<DbFileInputDto>, AppError> {
    Ok(state.engine.cmd_get_preset_database_files()?)
}

#[tauri::command]
pub async fn cmd_set_bus_databases(
    state: State<'_, AppState>,
    bus_id: u8,
    files: Vec<DbFileInputDto>,
) -> Result<Option<DatabaseSchemaDto>, AppError> {
    Ok(state.engine.cmd_set_bus_databases(bus_id, files)?)
}

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
    Ok(state.engine.cmd_transmit_signal_frame(
        bus_id,
        arb_id,
        is_extended,
        signal_values,
        periodic_ms,
        job_label,
    )?)
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
    Ok(state.engine.cmd_transmit_raw_frame(
        bus_id,
        arb_id,
        is_extended,
        is_fd,
        is_brs,
        data,
        periodic_ms,
        job_label,
    )?)
}

#[tauri::command]
pub async fn cmd_stop_periodic_tx(
    state: State<'_, AppState>,
    job_id: u64,
) -> Result<(), AppError> {
    Ok(state.engine.cmd_stop_periodic_tx(job_id)?)
}

#[tauri::command]
pub async fn cmd_list_periodic_tx(
    state: State<'_, AppState>,
    ) -> Result<Vec<PeriodicTxJobDto>, AppError> {
    Ok(state.engine.cmd_list_periodic_tx())
}

#[tauri::command]
pub async fn cmd_list_projects(
    state: State<'_, AppState>,
) -> Result<Vec<ProjectSummaryDto>, AppError> {
    Ok(state.engine.cmd_list_projects()?)
}

#[tauri::command]
pub async fn cmd_save_project(
    state: State<'_, AppState>,
    file_stem: String,
    project_json: String,
) -> Result<ProjectSummaryDto, AppError> {
    Ok(state.engine.cmd_save_project(file_stem, project_json)?)
}

#[tauri::command]
pub async fn cmd_load_project(
    state: State<'_, AppState>,
    file_stem: String,
) -> Result<String, AppError> {
    Ok(state.engine.cmd_load_project(file_stem)?)
}

#[tauri::command]
pub async fn cmd_delete_project(
    state: State<'_, AppState>,
    file_stem: String,
) -> Result<(), AppError> {
    Ok(state.engine.cmd_delete_project(file_stem)?)
}

#[tauri::command]
pub async fn cmd_list_traces(
    state: State<'_, AppState>,
) -> Result<TraceStorageInfoDto, AppError> {
    Ok(state.engine.cmd_list_traces()?)
}

#[tauri::command]
pub async fn cmd_save_trace_file(
    state: State<'_, AppState>,
    file_name: String,
    content: Option<String>,
    content_base64: Option<String>,
) -> Result<TraceFileSummaryDto, AppError> {
    Ok(state
        .engine
        .cmd_save_trace_file(file_name, content, content_base64)?)
}

#[tauri::command]
pub async fn cmd_load_trace_file(
    state: State<'_, AppState>,
    file_name: String,
) -> Result<LoadedTraceFileDto, AppError> {
    Ok(state.engine.cmd_load_trace_file(file_name)?)
}

#[tauri::command]
pub async fn cmd_delete_trace_file(
    state: State<'_, AppState>,
    file_name: String,
) -> Result<(), AppError> {
    Ok(state.engine.cmd_delete_trace_file(file_name)?)
}

#[tauri::command]
pub async fn cmd_parse_trace_content(
    state: State<'_, AppState>,
    file_name: String,
    content: Option<String>,
    content_base64: Option<String>,
) -> Result<LoadedTraceFileDto, AppError> {
    Ok(state
        .engine
        .cmd_parse_trace_content(file_name, content, content_base64)?)
}

#[tauri::command]
pub async fn cmd_export_trace_blf(
    state: State<'_, AppState>,
    file_name: String,
    frames: Vec<ChronologicalFrameDto>,
) -> Result<String, AppError> {
    Ok(state.engine.cmd_export_trace_blf(file_name, frames)?)
}

#[tauri::command]
pub async fn cmd_start_trace_replay(
    state: State<'_, AppState>,
    args: StartTraceReplayArgsDto,
) -> Result<TraceReplayStatusDto, AppError> {
    Ok(state.engine.cmd_start_trace_replay(args)?)
}

#[tauri::command]
pub async fn cmd_control_trace_replay(
    state: State<'_, AppState>,
    args: TraceReplayControlArgsDto,
) -> Result<TraceReplayStatusDto, AppError> {
    Ok(state.engine.cmd_control_trace_replay(args)?)
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
    run_diag(state, move |e| e.cmd_diag_get_conversation(config, since_seq, max)).await
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
    run_diag(state, move |e| e.cmd_diag_get_isotp_frames(config, since_seq, max)).await
}
