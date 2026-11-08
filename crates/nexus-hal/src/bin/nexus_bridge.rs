//! Standalone local HTTP + 60Hz WebSocket Telemetry Bridge (`0.0.0.0:14210`).
//!
//! Enables zero-WebKit browser / Vite development (`http://localhost:5173`) against the exact
//! real Rust `PipelineEngine`, `StateTable`, `SocketCAN`, and `mock0` drivers.

use axum::{
    body::Bytes,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use nexus_hal::{
    dto::{ChannelConfigDto, DbFileInputDto},
    pipeline::PipelineEngine,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{net::SocketAddr, sync::Arc};
use tokio::sync::broadcast::error::RecvError;
use tower_http::cors::CorsLayer;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectBusArgs {
    #[serde(alias = "device_id")]
    device_id: String,
    config: ChannelConfigDto,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DisconnectBusArgs {
    #[serde(alias = "bus_id")]
    bus_id: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArmBusArgs {
    #[serde(alias = "bus_id")]
    bus_id: u8,
    armed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetBusModeArgs {
    #[serde(alias = "bus_id")]
    bus_id: u8,
    #[serde(alias = "listen_only")]
    listen_only: bool,
    #[serde(alias = "arm_tx")]
    arm_tx: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadDatabaseContentArgs {
    #[serde(alias = "file_name")]
    file_name: String,
    #[serde(alias = "content_base64")]
    content_base64: String,
    #[serde(default, alias = "append_to_existing")]
    append_to_existing: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParseDatabaseSchemaArgs {
    #[serde(alias = "file_name")]
    file_name: String,
    #[serde(alias = "content_base64")]
    content_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetBusDatabasesArgs {
    #[serde(alias = "bus_id")]
    bus_id: u8,
    files: Vec<DbFileInputDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransmitSignalFrameArgs {
    #[serde(alias = "bus_id")]
    bus_id: u8,
    #[serde(alias = "arb_id")]
    arb_id: u32,
    #[serde(alias = "is_extended")]
    is_extended: bool,
    #[serde(alias = "signal_values")]
    signal_values: Vec<(u32, f64)>,
    #[serde(default, alias = "periodic_ms")]
    periodic_ms: Option<u32>,
    #[serde(default, alias = "job_label")]
    job_label: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransmitRawFrameArgs {
    #[serde(alias = "bus_id")]
    bus_id: u8,
    #[serde(alias = "arb_id")]
    arb_id: u32,
    #[serde(alias = "is_extended")]
    is_extended: bool,
    #[serde(default, alias = "is_fd")]
    is_fd: bool,
    #[serde(default, alias = "is_brs")]
    is_brs: bool,
    data: Vec<u8>,
    #[serde(default, alias = "periodic_ms")]
    periodic_ms: Option<u32>,
    #[serde(default, alias = "job_label")]
    job_label: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopPeriodicTxArgs {
    #[serde(alias = "job_id")]
    job_id: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveProjectArgs {
    #[serde(alias = "file_stem")]
    file_stem: String,
    #[serde(alias = "project_json")]
    project_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectStemArgs {
    #[serde(alias = "file_stem")]
    file_stem: String,
}

fn build_router(engine: Arc<PipelineEngine>) -> Router {
    Router::new()
        .route("/api/health", get(handle_health))
        .route("/ws/telemetry", get(handle_ws_upgrade))
        .route("/api/invoke/{cmd}", post(handle_invoke))
        .layer(CorsLayer::permissive())
        .with_state(engine)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bind_addr: SocketAddr = std::env::var("NEXUS_BRIDGE_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:14210".to_string())
        .parse()?;

    let engine = Arc::new(PipelineEngine::new());
    let app = build_router(Arc::clone(&engine));

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    println!("NexusCAN Bridge listening on http://{bind_addr} (WS: ws://{bind_addr}/ws/telemetry)");

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;

    Ok(())
}

async fn handle_health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "engine": "nexus-hal"
    }))
}

async fn handle_ws_upgrade(
    ws: WebSocketUpgrade,
    State(engine): State<Arc<PipelineEngine>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| stream_telemetry_ws(socket, engine))
}

async fn stream_telemetry_ws(mut socket: WebSocket, engine: Arc<PipelineEngine>) {
    let mut rx = engine.subscribe();

    if let Some(initial) = engine.latest_snapshot() {
        if let Ok(json_str) = serde_json::to_string(&initial) {
            if socket.send(Message::Text(json_str.into())).await.is_err() {
                return;
            }
        }
    }

    loop {
        tokio::select! {
            snap_res = rx.recv() => {
                match snap_res {
                    Ok(snapshot) => {
                        if let Ok(json_str) = serde_json::to_string(&snapshot) {
                            if socket.send(Message::Text(json_str.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                }
            }
            client_msg = socket.recv() => {
                match client_msg {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

fn bad_request(msg: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": msg.into() })),
    )
        .into_response()
}

fn ok_json<T: serde::Serialize>(val: T) -> Response {
    match serde_json::to_value(val) {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => bad_request(format!("Response serialization error: {e}")),
    }
}

async fn handle_invoke(
    Path(cmd): Path<String>,
    State(engine): State<Arc<PipelineEngine>>,
    body: Bytes,
) -> Response {
    let payload: Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => return bad_request(format!("Invalid JSON request body: {e}")),
        }
    };

    match cmd.as_str() {
        "cmd_list_devices" => ok_json(engine.cmd_list_devices()),
        "cmd_probe_drivers" => ok_json(engine.cmd_probe_drivers()),
        "cmd_connect_bus" => {
            let args: ConnectBusArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => return bad_request(format!("Invalid arguments for cmd_connect_bus: {e}")),
            };
            match engine.cmd_connect_bus(args.device_id, args.config) {
                Ok(res) => ok_json(res),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_disconnect_bus" => {
            let args: DisconnectBusArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_disconnect_bus: {e}"))
                }
            };
            match engine.cmd_disconnect_bus(args.bus_id) {
                Ok(()) => ok_json(Value::Null),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_disconnect_all_buses" => ok_json(engine.cmd_disconnect_all_buses()),
        "cmd_arm_active_bus" => {
            let args: ArmBusArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_arm_active_bus: {e}"))
                }
            };
            match engine.cmd_arm_active_bus(args.bus_id, args.armed) {
                Ok(res) => ok_json(res),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_set_bus_mode" => {
            let args: SetBusModeArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_set_bus_mode: {e}"))
                }
            };
            match engine.cmd_set_bus_mode(args.bus_id, args.listen_only, args.arm_tx) {
                Ok(res) => ok_json(res),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_panic_stop_tx" => ok_json(engine.cmd_panic_stop_tx()),
        "cmd_load_preset_databases" => match engine.cmd_load_preset_databases() {
            Ok(schema) => ok_json(schema),
            Err(e) => bad_request(e.to_string()),
        },
        "cmd_get_preset_database_files" => match engine.cmd_get_preset_database_files() {
            Ok(files) => ok_json(files),
            Err(e) => bad_request(e.to_string()),
        },
        "cmd_parse_database_schema" => {
            let args: ParseDatabaseSchemaArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!(
                        "Invalid arguments for cmd_parse_database_schema: {e}"
                    ))
                }
            };
            match engine.cmd_parse_database_schema(args.file_name, args.content_base64) {
                Ok(schema) => ok_json(schema),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_set_bus_databases" => {
            let args: SetBusDatabasesArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!(
                        "Invalid arguments for cmd_set_bus_databases: {e}"
                    ))
                }
            };
            match engine.cmd_set_bus_databases(args.bus_id, args.files) {
                Ok(schema_opt) => ok_json(schema_opt),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_get_current_schema" => ok_json(engine.cmd_get_current_schema()),
        "cmd_clear_database" => match engine.cmd_clear_database() {
            Ok(()) => ok_json(Value::Null),
            Err(e) => bad_request(e.to_string()),
        },
        "cmd_reset_telemetry" => match engine.cmd_reset_telemetry() {
            Ok(()) => ok_json(Value::Null),
            Err(e) => bad_request(e.to_string()),
        },
        "cmd_load_database_content" => {
            let args: LoadDatabaseContentArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!(
                        "Invalid arguments for cmd_load_database_content: {e}"
                    ))
                }
            };
            match engine.cmd_load_database_content(
                args.file_name,
                args.content_base64,
                args.append_to_existing,
            ) {
                Ok(schema) => ok_json(schema),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_subscribe_telemetry" => ok_json(json!({
            "subscribed": true,
            "wsPath": "/ws/telemetry"
        })),
        "cmd_transmit_signal_frame" => {
            let args: TransmitSignalFrameArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!(
                        "Invalid arguments for cmd_transmit_signal_frame: {e}"
                    ))
                }
            };
            match engine.cmd_transmit_signal_frame(
                args.bus_id,
                args.arb_id,
                args.is_extended,
                args.signal_values,
                args.periodic_ms,
                args.job_label,
            ) {
                Ok(res) => ok_json(res),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_transmit_raw_frame" => {
            let args: TransmitRawFrameArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!(
                        "Invalid arguments for cmd_transmit_raw_frame: {e}"
                    ))
                }
            };
            match engine.cmd_transmit_raw_frame(
                args.bus_id,
                args.arb_id,
                args.is_extended,
                args.is_fd,
                args.is_brs,
                args.data,
                args.periodic_ms,
                args.job_label,
            ) {
                Ok(res) => ok_json(res),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_stop_periodic_tx" => {
            let args: StopPeriodicTxArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_stop_periodic_tx: {e}"))
                }
            };
            match engine.cmd_stop_periodic_tx(args.job_id) {
                Ok(()) => ok_json(Value::Null),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_list_periodic_tx" => ok_json(engine.cmd_list_periodic_tx()),
        "cmd_list_projects" => match engine.cmd_list_projects() {
            Ok(list) => ok_json(list),
            Err(e) => bad_request(e.to_string()),
        },
        "cmd_save_project" => {
            let args: SaveProjectArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_save_project: {e}"))
                }
            };
            match engine.cmd_save_project(args.file_stem, args.project_json) {
                Ok(summary) => ok_json(summary),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_load_project" => {
            let args: ProjectStemArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_load_project: {e}"))
                }
            };
            match engine.cmd_load_project(args.file_stem) {
                Ok(raw_json) => ok_json(raw_json),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_delete_project" => {
            let args: ProjectStemArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_delete_project: {e}"))
                }
            };
            match engine.cmd_delete_project(args.file_stem) {
                Ok(()) => ok_json(Value::Null),
                Err(e) => bad_request(e.to_string()),
            }
        }
        unknown => bad_request(format!("Unknown NexusCAN IPC command: '{unknown}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use nexus_hal::DriverRegistry;

    async fn call_invoke(engine: &Arc<PipelineEngine>, cmd: &str, body_str: &str) -> (StatusCode, Value) {
        let resp = handle_invoke(
            Path(cmd.to_string()),
            State(Arc::clone(engine)),
            Bytes::from(body_str.to_string()),
        )
        .await;
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .expect("read response body");
        let val: Value = serde_json::from_slice(&bytes).expect("parse response json");
        (status, val)
    }

    #[tokio::test]
    async fn bridge_http_endpoints_and_400_error_contract() {
        let tmp_projects = std::env::temp_dir().join(format!(
            "nexuscan-bridge-projects-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_projects);

        let engine = Arc::new(PipelineEngine::with_projects_dir(
            DriverRegistry::with_builtin_drivers(),
            tmp_projects.clone(),
        ));
        let _router = build_router(Arc::clone(&engine));

        // 1. Health endpoint
        let Json(health) = handle_health().await;
        assert_eq!(health["status"], "ok");
        assert_eq!(health["engine"], "nexus-hal");

        // 2. cmd_list_devices exposes both mock:mock0 and mock:mock1
        let (st_dev, devs) = call_invoke(&engine, "cmd_list_devices", "").await;
        assert_eq!(st_dev, StatusCode::OK);
        let dev_arr = devs.as_array().expect("array");
        assert!(dev_arr
            .iter()
            .any(|d| d["deviceId"] == "mock:mock0"
                && d["displayName"] == "mock0 — Virtual EV Powertrain + BMS Bus"));
        assert!(dev_arr
            .iter()
            .any(|d| d["deviceId"] == "mock:mock1"
                && d["displayName"] == "mock1 — Virtual Auxiliary / Charger Bus"));

        // 2b. cmd_probe_drivers returns all 6 driver families
        let (st_probe, probe_val) = call_invoke(&engine, "cmd_probe_drivers", "").await;
        assert_eq!(st_probe, StatusCode::OK);
        let fams = probe_val["families"].as_array().expect("families array");
        assert_eq!(fams.len(), 6);
        assert!(fams.iter().any(|f| f["familyId"] == "slcan" && f["installed"] == true));
        assert!(fams.iter().any(|f| f["familyId"] == "pcan"));
        assert!(fams.iter().any(|f| f["familyId"] == "kvaser"));

        // 3. cmd_connect_bus in Listen-Only mode + verify 400 {"error": ...} on arming Listen-Only
        let (st_conn, bus_dto) = call_invoke(
            &engine,
            "cmd_connect_bus",
            r#"{"deviceId":"mock:mock0","config":{"busId":0,"bitrate":500000,"dataBitrate":2000000,"enableFd":true,"listenOnly":true,"mockFpsPreset":null}}"#,
        )
        .await;
        assert_eq!(st_conn, StatusCode::OK);
        assert_eq!(bus_dto["listenOnly"], true);

        let (st_err, err_json) =
            call_invoke(&engine, "cmd_arm_active_bus", r#"{"busId":0,"armed":true}"#).await;
        assert_eq!(st_err, StatusCode::BAD_REQUEST);
        assert!(err_json["error"]
            .as_str()
            .expect("error string")
            .contains("Listen-Only"));

        let (st_disc, _) = call_invoke(&engine, "cmd_disconnect_bus", r#"{"busId":0}"#).await;
        assert_eq!(st_disc, StatusCode::OK);

        // 4. Active mode + dual bus (mock0 + mock1) + cmd_transmit_raw_frame + cmd_disconnect_all_buses
        let (st_rw, _) = call_invoke(
            &engine,
            "cmd_connect_bus",
            r#"{"deviceId":"mock:mock0","config":{"busId":0,"bitrate":500000,"dataBitrate":2000000,"enableFd":true,"listenOnly":false,"mockFpsPreset":null}}"#,
        )
        .await;
        assert_eq!(st_rw, StatusCode::OK);

        let (st_b1, _) = call_invoke(
            &engine,
            "cmd_connect_bus",
            r#"{"deviceId":"mock:mock1","config":{"busId":1,"bitrate":500000,"dataBitrate":2000000,"enableFd":true,"listenOnly":true,"mockFpsPreset":null}}"#,
        )
        .await;
        assert_eq!(st_b1, StatusCode::OK);

        // Verify cmd_set_bus_mode rejects unconnected busId 7 and atomically upgrades mock:mock1 on busId 1
        let (st_unconn_mode, err_unconn_mode) = call_invoke(
            &engine,
            "cmd_set_bus_mode",
            r#"{"busId":7,"listenOnly":false,"armTx":true}"#,
        )
        .await;
        assert_eq!(st_unconn_mode, StatusCode::BAD_REQUEST);
        assert!(err_unconn_mode["error"]
            .as_str()
            .expect("error string")
            .contains("Bus 7 is not connected"));

        let (st_b1_mode, b1_mode_dto) = call_invoke(
            &engine,
            "cmd_set_bus_mode",
            r#"{"busId":1,"listenOnly":false,"armTx":true}"#,
        )
        .await;
        assert_eq!(st_b1_mode, StatusCode::OK);
        assert_eq!(b1_mode_dto["deviceId"], "mock:mock1");
        assert_eq!(b1_mode_dto["listenOnly"], false);
        assert_eq!(b1_mode_dto["txArmed"], true);

        let (st_arm, _) =
            call_invoke(&engine, "cmd_arm_active_bus", r#"{"busId":0,"armed":true}"#).await;
        assert_eq!(st_arm, StatusCode::OK);

        let (st_raw_tx, raw_tx_val) = call_invoke(
            &engine,
            "cmd_transmit_raw_frame",
            r#"{"busId":0,"arbId":1919,"isExtended":false,"isFd":false,"isBrs":false,"data":[2,1,12,0,0,0,0,0],"periodicMs":50,"jobLabel":"UDS_TesterPresent"}"#,
        )
        .await;
        assert_eq!(st_raw_tx, StatusCode::OK);
        assert_eq!(raw_tx_val["encodedDlc"], 8);

        let (st_jobs, jobs_val) = call_invoke(&engine, "cmd_list_periodic_tx", "").await;
        assert_eq!(st_jobs, StatusCode::OK);
        let jobs_arr = jobs_val.as_array().expect("jobs array");
        assert_eq!(jobs_arr.len(), 1);
        assert_eq!(jobs_arr[0]["arbId"], 1919);

        let (st_disc_all, disc_count) =
            call_invoke(&engine, "cmd_disconnect_all_buses", "").await;
        assert_eq!(st_disc_all, StatusCode::OK);
        assert_eq!(disc_count, 2);

        // 5. Project CRUD + database clear via HTTP invoke
        let (st_save, saved_proj) = call_invoke(
            &engine,
            "cmd_save_project",
            r#"{"fileStem":"ev_dyno_bench","projectJson":"{\"name\":\"EV Dyno Bench\",\"updatedAt\":\"2026-11-06T03:00:00Z\"}"}"#,
        )
        .await;
        assert_eq!(st_save, StatusCode::OK);
        assert_eq!(saved_proj["fileStem"], "ev_dyno_bench");
        assert_eq!(saved_proj["name"], "EV Dyno Bench");

        let (st_list_p, listed_p) = call_invoke(&engine, "cmd_list_projects", "").await;
        assert_eq!(st_list_p, StatusCode::OK);
        assert_eq!(listed_p.as_array().expect("projects array").len(), 1);

        let (st_load_p, loaded_p) = call_invoke(
            &engine,
            "cmd_load_project",
            r#"{"fileStem":"ev_dyno_bench"}"#,
        )
        .await;
        assert_eq!(st_load_p, StatusCode::OK);
        assert!(loaded_p.as_str().expect("project json str").contains("EV Dyno Bench"));

        let (st_del_p, _) = call_invoke(
            &engine,
            "cmd_delete_project",
            r#"{"fileStem":"ev_dyno_bench"}"#,
        )
        .await;
        assert_eq!(st_del_p, StatusCode::OK);

        let (st_reset_tel, _) = call_invoke(&engine, "cmd_reset_telemetry", "").await;
        assert_eq!(st_reset_tel, StatusCode::OK);

        // 6. Stateless catalog parsing + preset files + per-bus DB binding
        let (st_presets, preset_files) =
            call_invoke(&engine, "cmd_get_preset_database_files", "{}").await;
        assert_eq!(st_presets, StatusCode::OK);
        let preset_arr = preset_files.as_array().expect("preset files array");
        assert_eq!(preset_arr.len(), 2);
        let first_file_name = preset_arr[0]["fileName"].as_str().expect("fileName");
        let first_b64 = preset_arr[0]["contentBase64"]
            .as_str()
            .expect("contentBase64");

        let (st_parse, parsed_schema) = call_invoke(
            &engine,
            "cmd_parse_database_schema",
            &serde_json::to_string(&json!({
                "fileName": first_file_name,
                "contentBase64": first_b64,
            }))
            .unwrap(),
        )
        .await;
        assert_eq!(st_parse, StatusCode::OK);
        assert!(parsed_schema["messages"].as_array().unwrap().len() >= 4);
        assert!(
            engine.cmd_get_current_schema().is_none(),
            "cmd_parse_database_schema must remain strictly stateless"
        );

        let (st_bind_some, bound_schema) = call_invoke(
            &engine,
            "cmd_set_bus_databases",
            &serde_json::to_string(&json!({
                "busId": 0,
                "files": preset_arr,
            }))
            .unwrap(),
        )
        .await;
        assert_eq!(st_bind_some, StatusCode::OK);
        assert_eq!(bound_schema["messages"].as_array().unwrap().len(), 8);

        let (st_bind_none, unbound_res) = call_invoke(
            &engine,
            "cmd_set_bus_databases",
            r#"{"busId":1,"files":[]}"#,
        )
        .await;
        assert_eq!(st_bind_none, StatusCode::OK);
        assert!(unbound_res.is_null());

        let (st_clear_db, _) = call_invoke(&engine, "cmd_clear_database", "").await;
        assert_eq!(st_clear_db, StatusCode::OK);

        let _ = std::fs::remove_dir_all(&tmp_projects);
    }
}

