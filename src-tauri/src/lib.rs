//! Tauri v2 application entry point: resolves the persistent data directory, registers
//! `AppState` and every IPC command listed in [`app_commands::APP_COMMANDS`].

#![forbid(unsafe_code)]

pub mod app_commands;
pub mod commands;
pub mod pipeline;

use nexus_hal::storage::DataRoot;
use pipeline::AppState;
use tauri::{Manager, WebviewWindowBuilder};

/// WP-8 / HIGH-09: persistent `projects/` + `traces/` location.
///
/// * Release builds: always `app_local_data_dir()` (e.g. `~/.local/share/io.nexuscan.analyzer`,
///   `%LOCALAPPDATA%\io.nexuscan.analyzer`, `~/Library/Application Support/io.nexuscan.analyzer`).
///   No environment override and no dependence on the build machine's source checkout.
/// * Debug builds: `NEXUS_DATA_DIR` if set, else the repo-relative dev layout
///   (`<repo>/projects`, `<repo>/traces`) so `cargo tauri dev` keeps using the checkout.
fn resolve_data_root<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<DataRoot, Box<dyn std::error::Error>> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        Ok(DataRoot::resolve_default())
    }
    #[cfg(not(debug_assertions))]
    {
        Ok(DataRoot::under(app.path().app_local_data_dir()?))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_root = resolve_data_root(app.handle())?;
            data_root.ensure_dirs()?;
            app.manage(AppState::with_data_root(data_root));
            // The main window is declared with `"create": false` and built only after
            // `AppState` is managed, so no IPC call can observe a missing state.
            for window_config in app.config().app.windows.clone() {
                let is_main = window_config.label == "main";
                let win =
                    WebviewWindowBuilder::from_config(app.handle(), &window_config)?.build()?;
                if is_main {
                    let app_handle = app.handle().clone();
                    win.on_window_event(move |event| {
                        if matches!(event, tauri::WindowEvent::Destroyed) {
                            // The MCP server never outlives the main window.
                            if let Some(state) = app_handle.try_state::<AppState>() {
                                state.stop_mcp();
                                state.ui_bridge.detach();
                            }
                            if let Some(dbg_win) = app_handle.get_webview_window("debug-console") {
                                let _ = dbg_win.close();
                            }
                        }
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::cmd_list_devices,
            commands::cmd_probe_drivers,
            commands::cmd_subscribe_hardware_changes,
            commands::cmd_connect_bus,
            commands::cmd_disconnect_bus,
            commands::cmd_disconnect_all_buses,
            commands::cmd_arm_active_bus,
            commands::cmd_set_bus_mode,
            commands::cmd_panic_stop_tx,
            commands::cmd_clear_panic_latch,
            commands::cmd_reset_session,
            commands::cmd_seedkey_capabilities,
            commands::cmd_seedkey_compute_adhoc,
            commands::cmd_seedkey_probe_library,
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
            commands::cmd_list_traces,
            commands::cmd_save_trace_file,
            commands::cmd_load_trace_file,
            commands::cmd_delete_trace_file,
            commands::cmd_parse_trace_content,
            commands::cmd_export_trace_blf,
            commands::cmd_start_trace_replay,
            commands::cmd_control_trace_replay,
            commands::cmd_diag_open_session,
            commands::cmd_diag_close_session,
            commands::cmd_diag_session_info,
            commands::cmd_diag_send_uds,
            commands::cmd_diag_read_did,
            commands::cmd_diag_read_stored_dtcs,
            commands::cmd_diag_set_tester_present,
            commands::cmd_diag_get_conversation,
            commands::cmd_diag_discover_ecus,
            commands::cmd_diag_get_isotp_frames,
            commands::cmd_diag_read_dtc_report,
            commands::cmd_flash_load_image,
            commands::cmd_flash_release_image,
            commands::cmd_flash_download,
            commands::cmd_flash_cancel,
            commands::cmd_diag_passive_discovery_start,
            commands::cmd_diag_passive_discovery_snapshot,
            commands::cmd_diag_passive_discovery_stop,
            commands::cmd_diag_physical_sweep,
            commands::cmd_subscribe_debug_events,
            commands::cmd_append_debug_event,
            commands::cmd_clear_debug_events,
            commands::cmd_export_debug_events,
            commands::cmd_set_debug_window_open,
            commands::cmd_flowlib_list,
            commands::cmd_flowlib_revisions,
            commands::cmd_flowlib_load,
            commands::cmd_flowlib_save,
            commands::cmd_flowlib_delete,
            commands::cmd_run_append,
            commands::cmd_run_query,
            commands::cmd_run_latest,
            commands::cmd_re_start,
            commands::cmd_re_stop,
            commands::cmd_re_reset,
            commands::cmd_re_set_phase,
            commands::cmd_re_mark,
            commands::cmd_re_markers,
            commands::cmd_re_subscribe,
            commands::cmd_re_row_detail,
            commands::cmd_re_classify,
            commands::cmd_re_focus_set,
            commands::cmd_re_focus_status,
            commands::cmd_re_series,
            commands::cmd_re_correlate,
            commands::cmd_re_dbc_generate,
            commands::cmd_re_scan_first,
            commands::cmd_re_scan_next,
            commands::cmd_re_scan_undo,
            commands::cmd_re_scan_reset,
            commands::cmd_re_scan_status,
            commands::cmd_re_scan_results,
            commands::cmd_mcp_start,
            commands::cmd_mcp_stop,
            commands::cmd_mcp_status,
            commands::cmd_mcp_ui_attach,
            commands::cmd_mcp_ui_respond,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NexusCAN Tauri application");
}
