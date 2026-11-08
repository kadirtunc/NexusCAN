//! Tauri v2 application entry point registering `AppState` and all 20 IPC commands.

#![forbid(unsafe_code)]

pub mod commands;
pub mod pipeline;

use pipeline::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new();

    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::cmd_list_devices,
            commands::cmd_probe_drivers,
            commands::cmd_connect_bus,
            commands::cmd_disconnect_bus,
            commands::cmd_disconnect_all_buses,
            commands::cmd_arm_active_bus,
            commands::cmd_set_bus_mode,
            commands::cmd_panic_stop_tx,
            commands::cmd_load_preset_databases,
            commands::cmd_get_preset_database_files,
            commands::cmd_parse_database_schema,
            commands::cmd_set_bus_databases,
            commands::cmd_get_current_schema,
            commands::cmd_clear_database,
            commands::cmd_reset_telemetry,
            commands::cmd_load_database_content,
            commands::cmd_subscribe_telemetry,
            commands::cmd_transmit_signal_frame,
            commands::cmd_transmit_raw_frame,
            commands::cmd_stop_periodic_tx,
            commands::cmd_list_periodic_tx,
            commands::cmd_list_projects,
            commands::cmd_save_project,
            commands::cmd_load_project,
            commands::cmd_delete_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NexusCAN Tauri application");
}
