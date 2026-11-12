//! Tauri v2 IPC command handlers delegating to `nexus_hal::pipeline::PipelineEngine`.
//!
//! Strictly avoids per-frame `app.emit()` calls: 60Hz telemetry snapshots stream exclusively
//! over `tauri::ipc::Channel<TelemetrySnapshotDto>`.

use crate::pipeline::AppState;
use nexus_hal::pipeline::PipelineEngine;
use nexus_hal::{
    dto::{
        BusHealthDto, ChannelConfigDto, ChronologicalFrameDto, DbFileInputDto, DeviceDescriptorDto,
        DriverProbeReportDto, LoadedTraceFileDto, PanicStopResultDto, PeriodicTxJobDto,
        ProjectSummaryDto, ResetSessionResultDto, StartTraceReplayArgsDto, TelemetrySnapshotDto,
        TraceFileSummaryDto, TraceReplayControlArgsDto, TraceReplayStatusDto, TraceStorageInfoDto,
        TxTransmitResultDto,
    },
    error::HalError,
};
use nexus_netdb::DatabaseSchemaDto;
use nexus_protocols::uds::dto::{
    ConversationPageDto, DiagError, DiagErrorCode, DiagOrigin, DiagSessionConfigDto,
    DiagSessionInfoDto, DidReadResultDto, DtcEntryDto, EcuDiscoveryRequestDto,
    EcuDiscoveryResultDto, IsoTpFramePageDto, UdsRequestOptionsDto, UdsResponseDto,
};
use nexus_protocols::uds::security::{
    ComputeKeyResultDto, KeyProviderSpecDto, SeedKeyCapabilitiesDto, SeedKeyError,
};
use serde::Serialize;
use std::sync::Arc;
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

#[tauri::command]
pub async fn cmd_seedkey_capabilities(
    state: State<'_, AppState>,
) -> Result<SeedKeyCapabilitiesDto, String> {
    let engine = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking(move || engine.cmd_seedkey_capabilities())
        .await
        .map_err(|join_err| {
            SeedKeyError::Script(format!("seed/key worker failed: {join_err}")).to_ipc_string()
        })
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
