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
    dto::{
        ChannelConfigDto, ChronologicalFrameDto, DbFileInputDto, StartTraceReplayArgsDto,
        TraceReplayControlArgsDto,
    },
    pipeline::PipelineEngine,
};
use nexus_protocols::uds::dto::{
    DiagError, DiagErrorCode, DiagOrigin, DiagSessionConfigDto, EcuDiscoveryRequestDto,
    UdsRequestOptionsDto,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraceFileNameArgs {
    #[serde(alias = "file_name")]
    file_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraceFileContentArgs {
    #[serde(alias = "file_name")]
    file_name: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default, alias = "content_base64")]
    content_base64: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportTraceBlfArgs {
    #[serde(default, alias = "file_name")]
    file_name: String,
    frames: Vec<ChronologicalFrameDto>,
}

// ─── D-003 `cmd_diag_*` arguments (mirror of `DiagCommandMap` in src/types/udsClient.ts) ───

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagConfigArgs {
    config: DiagSessionConfigDto,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagSendUdsArgs {
    config: DiagSessionConfigDto,
    sid: u8,
    #[serde(default, alias = "sub_function")]
    sub_function: Option<u8>,
    #[serde(default)]
    data: Vec<u8>,
    #[serde(default)]
    options: Option<UdsRequestOptionsDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagReadDidArgs {
    config: DiagSessionConfigDto,
    did: u16,
    /// Conversation origin tag; default `did`.
    #[serde(default)]
    origin: Option<DiagOrigin>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagReadDtcsArgs {
    config: DiagSessionConfigDto,
    #[serde(default, alias = "status_mask")]
    status_mask: Option<u8>,
    /// Conversation origin tag; default `dtc`.
    #[serde(default)]
    origin: Option<DiagOrigin>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagTesterPresentArgs {
    config: DiagSessionConfigDto,
    enabled: bool,
    #[serde(default, alias = "interval_ms")]
    interval_ms: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagConversationArgs {
    config: DiagSessionConfigDto,
    #[serde(default, alias = "since_seq")]
    since_seq: u64,
    #[serde(default)]
    max: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagDiscoverEcusArgs {
    request: EcuDiscoveryRequestDto,
}

fn diag_bad_args(cmd: &str, e: serde_json::Error) -> Response {
    bad_request(
        DiagError::new(
            DiagErrorCode::InvalidInput,
            format!("invalid arguments for {cmd}: {e}"),
        )
        .to_ipc_string(),
    )
}

/// Runs a blocking UDS call on the tokio blocking pool; errors use the `"[diag:<code>] msg"`
/// wire format through the regular 400 `bad_request` path.
async fn run_diag<T, F>(engine: Arc<PipelineEngine>, f: F) -> Response
where
    T: serde::Serialize + Send + 'static,
    F: FnOnce(&PipelineEngine) -> Result<T, DiagError> + Send + 'static,
{
    match tokio::task::spawn_blocking(move || f(&engine)).await {
        Ok(Ok(v)) => ok_json(v),
        Ok(Err(e)) => bad_request(e.to_ipc_string()),
        Err(join_err) => bad_request(
            DiagError::new(DiagErrorCode::Internal, format!("diag worker failed: {join_err}"))
                .to_ipc_string(),
        ),
    }
}

/// D-003 router. `None` = not a diag command.
async fn handle_diag_invoke(cmd: &str, payload: Value, engine: &Arc<PipelineEngine>) -> Option<Response> {
    macro_rules! args {
        ($ty:ty) => {
            match serde_json::from_value::<$ty>(payload) {
                Ok(a) => a,
                Err(e) => return Some(diag_bad_args(cmd, e)),
            }
        };
    }
    let engine = Arc::clone(engine);
    let resp = match cmd {
        "cmd_diag_open_session" => {
            let a = args!(DiagConfigArgs);
            run_diag(engine, move |e| e.cmd_diag_open_session(a.config)).await
        }
        "cmd_diag_close_session" => {
            let a = args!(DiagConfigArgs);
            run_diag(engine, move |e| e.cmd_diag_close_session(a.config).map(|()| Value::Null)).await
        }
        "cmd_diag_session_info" => {
            let a = args!(DiagConfigArgs);
            run_diag(engine, move |e| e.cmd_diag_session_info(a.config)).await
        }
        "cmd_diag_send_uds" => {
            let a = args!(DiagSendUdsArgs);
            run_diag(engine, move |e| {
                e.cmd_diag_send_uds(a.config, a.sid, a.sub_function, a.data, a.options)
            })
            .await
        }
        "cmd_diag_read_did" => {
            let a = args!(DiagReadDidArgs);
            run_diag(engine, move |e| e.cmd_diag_read_did(a.config, a.did, a.origin)).await
        }
        "cmd_diag_read_stored_dtcs" => {
            let a = args!(DiagReadDtcsArgs);
            run_diag(engine, move |e| {
                e.cmd_diag_read_stored_dtcs(a.config, a.status_mask, a.origin)
            })
            .await
        }
        "cmd_diag_set_tester_present" => {
            let a = args!(DiagTesterPresentArgs);
            run_diag(engine, move |e| {
                e.cmd_diag_set_tester_present(a.config, a.enabled, a.interval_ms)
            })
            .await
        }
        "cmd_diag_get_conversation" => {
            let a = args!(DiagConversationArgs);
            run_diag(engine, move |e| e.cmd_diag_get_conversation(a.config, a.since_seq, a.max)).await
        }
        "cmd_diag_get_isotp_frames" => {
            let a = args!(DiagConversationArgs);
            run_diag(engine, move |e| e.cmd_diag_get_isotp_frames(a.config, a.since_seq, a.max)).await
        }
        "cmd_diag_discover_ecus" => {
            let a = args!(DiagDiscoverEcusArgs);
            run_diag(engine, move |e| e.cmd_diag_discover_ecus(a.request)).await
        }
        _ => return None,
    };
    Some(resp)
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

    if cmd.starts_with("cmd_diag_") {
        if let Some(resp) = handle_diag_invoke(&cmd, payload.clone(), &engine).await {
            return resp;
        }
    }

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
        "cmd_list_traces" => match engine.cmd_list_traces() {
            Ok(info) => ok_json(info),
            Err(e) => bad_request(e.to_string()),
        },
        "cmd_save_trace_file" => {
            let args: TraceFileContentArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_save_trace_file: {e}"))
                }
            };
            match engine.cmd_save_trace_file(args.file_name, args.content, args.content_base64) {
                Ok(summary) => ok_json(summary),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_load_trace_file" => {
            let args: TraceFileNameArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_load_trace_file: {e}"))
                }
            };
            match engine.cmd_load_trace_file(args.file_name) {
                Ok(loaded) => ok_json(loaded),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_delete_trace_file" => {
            let args: TraceFileNameArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_delete_trace_file: {e}"))
                }
            };
            match engine.cmd_delete_trace_file(args.file_name) {
                Ok(()) => ok_json(Value::Null),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_parse_trace_content" => {
            let args: TraceFileContentArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!(
                        "Invalid arguments for cmd_parse_trace_content: {e}"
                    ))
                }
            };
            match engine.cmd_parse_trace_content(args.file_name, args.content, args.content_base64)
            {
                Ok(loaded) => ok_json(loaded),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_export_trace_blf" => {
            let args: ExportTraceBlfArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_export_trace_blf: {e}"))
                }
            };
            match engine.cmd_export_trace_blf(args.file_name, args.frames) {
                Ok(b64) => ok_json(b64),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_start_trace_replay" => {
            let raw_args = payload.get("args").cloned().unwrap_or(payload);
            let args: StartTraceReplayArgsDto = match serde_json::from_value(raw_args) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!(
                        "Invalid arguments for cmd_start_trace_replay: {e}"
                    ))
                }
            };
            match engine.cmd_start_trace_replay(args) {
                Ok(status) => ok_json(status),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_control_trace_replay" => {
            let raw_args = payload.get("args").cloned().unwrap_or(payload);
            let args: TraceReplayControlArgsDto = match serde_json::from_value(raw_args) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!(
                        "Invalid arguments for cmd_control_trace_replay: {e}"
                    ))
                }
            };
            match engine.cmd_control_trace_replay(args) {
                Ok(status) => ok_json(status),
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bridge_diag_routes_use_diag_error_wire_format() {
        let engine = Arc::new(PipelineEngine::new());
        let cfg = r#"{"busId":0,"requestId":2020,"responseId":2028,"isExtendedId":false}"#;

        let (st, v) = call_invoke(&engine, "cmd_diag_open_session", &format!(r#"{{"config":{cfg}}}"#)).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"].as_str().unwrap().starts_with("[diag:bus_not_connected] "));

        let (st, v) = call_invoke(&engine, "cmd_diag_read_did", r#"{"config":{"busId":0}}"#).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"].as_str().unwrap().starts_with("[diag:invalid_input] "));

        let (st, _) = call_invoke(
            &engine,
            "cmd_connect_bus",
            r#"{"deviceId":"mock:mock0","config":{"busId":0,"bitrate":500000,"dataBitrate":2000000,"enableFd":true,"listenOnly":false,"mockFpsPreset":1000}}"#,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_send_uds",
            &format!(r#"{{"config":{cfg},"sid":62,"subFunction":0,"data":[]}}"#),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"].as_str().unwrap().starts_with("[diag:disarmed] "));

        // ISO-TP Monitor: unknown session → empty page (never opens one); bad config → invalid_input.
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_get_isotp_frames",
            &format!(r#"{{"config":{cfg},"sinceSeq":0,"max":100}}"#),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["frames"].as_array().map(Vec::len), Some(0));
        assert_eq!(v["lastSeq"], 0);
        assert_eq!(v["truncated"], false);
        assert_eq!(v["dropped"], 0);
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_get_isotp_frames",
            r#"{"config":{"busId":0,"requestId":2020,"responseId":2020,"isExtendedId":false},"sinceSeq":0}"#,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"].as_str().unwrap().starts_with("[diag:invalid_input] "));

        // ECU discovery: `{ request: {...} }`, same gate and wire format.
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_discover_ecus",
            r#"{"request":{"busId":0,"isExtendedId":false,"functionalId":2014,"windowMs":100}}"#,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"].as_str().unwrap().starts_with("[diag:disarmed] "));
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_discover_ecus",
            r#"{"request":{"busId":0,"isExtendedId":false,"functionalId":2014,"requestPdu":[62,128]}}"#,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"].as_str().unwrap().starts_with("[diag:invalid_input] "));

        // Read-only commands answer without a session.
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_get_conversation",
            &format!(r#"{{"config":{cfg},"sinceSeq":0,"max":null}}"#),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["lastSeq"], 0);
        let (st, v) = call_invoke(&engine, "cmd_diag_session_info", &format!(r#"{{"config":{cfg}}}"#)).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["open"], false);
        let (st, v) = call_invoke(&engine, "cmd_diag_close_session", &format!(r#"{{"config":{cfg}}}"#)).await;
        assert_eq!(st, StatusCode::OK);
        assert!(v.is_null());
    }

    #[tokio::test]
    async fn bridge_http_endpoints_and_400_error_contract() {
        let tmp_projects = std::env::temp_dir().join(format!(
            "nexuscan-bridge-projects-{}",
            std::process::id()
        ));
        let tmp_traces = std::env::temp_dir().join(format!(
            "nexuscan-bridge-traces-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_projects);
        let _ = std::fs::remove_dir_all(&tmp_traces);

        let engine = Arc::new(PipelineEngine::with_storage_dirs(
            DriverRegistry::with_builtin_drivers(),
            tmp_projects.clone(),
            tmp_traces.clone(),
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

        // 7. Trace persistent CRUD + parse + replay start/control via HTTP invoke (both wrapped {args} & flat)
        let sample_trc = ";$FILEVERSION=2.1\n1 0.000 DT 1 0101 Rx 8 10 20 30 40 50 60 70 80\n2 40.000 DT 1 0101 Rx 8 11 22 33 44 55 66 77 88\n";
        let (st_t_save, saved_trace) = call_invoke(
            &engine,
            "cmd_save_trace_file",
            &serde_json::to_string(&json!({
                "fileName": "bridge_run.trc",
                "content": sample_trc,
            }))
            .unwrap(),
        )
        .await;
        assert_eq!(st_t_save, StatusCode::OK);
        assert_eq!(saved_trace["fileName"], "bridge_run.trc");
        assert_eq!(saved_trace["frameCount"], 2);
        assert_eq!(saved_trace["durationUs"], 40_000);

        let (st_t_list, listed_traces) = call_invoke(&engine, "cmd_list_traces", "").await;
        assert_eq!(st_t_list, StatusCode::OK);
        assert_eq!(listed_traces["files"].as_array().unwrap().len(), 1);

        let (st_t_load, loaded_trace) = call_invoke(
            &engine,
            "cmd_load_trace_file",
            r#"{"fileName":"bridge_run.trc"}"#,
        )
        .await;
        assert_eq!(st_t_load, StatusCode::OK);
        assert_eq!(loaded_trace["frames"].as_array().unwrap().len(), 2);

        let (st_t_parse, parsed_trace) = call_invoke(
            &engine,
            "cmd_parse_trace_content",
            &serde_json::to_string(&json!({
                "file_name": "inline.log",
                "content": "(1700000000.000000) vcan0 123#AABBCCDD\n",
            }))
            .unwrap(),
        )
        .await;
        assert_eq!(st_t_parse, StatusCode::OK);
        assert_eq!(parsed_trace["summary"]["frameCount"], 1);

        let (st_rep_start, rep_status) = call_invoke(
            &engine,
            "cmd_start_trace_replay",
            r#"{"args":{"sourceName":"bridge_run.trc","fileName":"bridge_run.trc","speedFactor":0.5,"filterMode":"exclude","filterKeys":["std:0x102"],"directionFilter":"rx"}}"#,
        )
        .await;
        assert_eq!(st_rep_start, StatusCode::OK);
        assert_eq!(rep_status["state"], "playing");
        assert_eq!(rep_status["filterMode"], "exclude");
        assert_eq!(rep_status["filterKeys"], json!(["STD:0x102"]));
        assert_eq!(rep_status["directionFilter"], "rx");

        let (st_rep_cfg, rep_cfg) = call_invoke(
            &engine,
            "cmd_control_trace_replay",
            r#"{"action":"configure","filterMode":"include","updateFilterKeys":true,"filterKeys":["STD:0x101"],"directionFilter":"all"}"#,
        )
        .await;
        assert_eq!(st_rep_cfg, StatusCode::OK);
        assert_eq!(rep_cfg["filterMode"], "include");
        assert_eq!(rep_cfg["filterKeys"], json!(["STD:0x101"]));
        assert_eq!(rep_cfg["directionFilter"], "all");

        let (st_rep_stop, rep_stopped) = call_invoke(
            &engine,
            "cmd_control_trace_replay",
            r#"{"action":"stop"}"#,
        )
        .await;
        assert_eq!(st_rep_stop, StatusCode::OK);
        assert_eq!(rep_stopped["state"], "idle");

        // 8. Binary Vector `.blf` export + `contentBase64` save & stateless parse via HTTP invoke
        let (st_blf_exp, blf_b64_val) = call_invoke(
            &engine,
            "cmd_export_trace_blf",
            &serde_json::to_string(&json!({
                "fileName": "bridge_export.blf",
                "frames": loaded_trace["frames"],
            }))
            .unwrap(),
        )
        .await;
        assert_eq!(st_blf_exp, StatusCode::OK);
        let blf_b64 = blf_b64_val.as_str().expect("base64 string");
        assert!(!blf_b64.is_empty());

        let (st_blf_save, saved_blf) = call_invoke(
            &engine,
            "cmd_save_trace_file",
            &serde_json::to_string(&json!({
                "fileName": "bridge_export.blf",
                "contentBase64": blf_b64,
            }))
            .unwrap(),
        )
        .await;
        assert_eq!(st_blf_save, StatusCode::OK);
        assert_eq!(saved_blf["format"], "blf");
        assert_eq!(saved_blf["frameCount"], 2);

        let (st_blf_parse, parsed_blf) = call_invoke(
            &engine,
            "cmd_parse_trace_content",
            &serde_json::to_string(&json!({
                "fileName": "bridge_export.blf",
                "contentBase64": blf_b64,
            }))
            .unwrap(),
        )
        .await;
        assert_eq!(st_blf_parse, StatusCode::OK);
        assert_eq!(parsed_blf["summary"]["format"], "blf");
        assert_eq!(parsed_blf["frames"].as_array().unwrap().len(), 2);

        let (st_t_del, _) = call_invoke(
            &engine,
            "cmd_delete_trace_file",
            r#"{"fileName":"bridge_run.trc"}"#,
        )
        .await;
        assert_eq!(st_t_del, StatusCode::OK);

        let _ = std::fs::remove_dir_all(&tmp_projects);
        let _ = std::fs::remove_dir_all(&tmp_traces);
    }
}

