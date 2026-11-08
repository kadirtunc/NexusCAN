//! Tauri v2 IPC command handlers delegating to `nexus_hal::pipeline::PipelineEngine`.
//!
//! Strictly avoids per-frame `app.emit()` calls: 60Hz telemetry snapshots stream exclusively
//! over `tauri::ipc::Channel<TelemetrySnapshotDto>`.

use crate::pipeline::AppState;
use nexus_hal::{
    dto::{
        BusHealthDto, ChannelConfigDto, DbFileInputDto, DeviceDescriptorDto, DriverProbeReportDto,
        PanicStopResultDto, PeriodicTxJobDto, ProjectSummaryDto, TelemetrySnapshotDto,
        TxTransmitResultDto,
    },
    error::HalError,
};
use nexus_netdb::DatabaseSchemaDto;
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
