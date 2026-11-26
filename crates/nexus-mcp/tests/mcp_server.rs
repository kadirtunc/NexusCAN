//! nexus-mcp integration tests: auth / DNS-rebinding guard, every M1 tool (pure functions and
//! over MCP Streamable HTTP with the official rmcp client), decode correctness (Intel, Motorola,
//! CAN-FD), response-size truncation, `trace_query` cursor pagination and lifecycle.

use base64::Engine as _;
use nexus_hal::pipeline::PipelineEngine;
use nexus_hal::registry::DriverRegistry;
use nexus_hal::storage::DataRoot;
use nexus_mcp::tools_trace::{QueryArgs, TraceCache};
use nexus_mcp::util::MAX_RESPONSE_BYTES;
use nexus_mcp::{tools_db, tools_trace, McpConfig, McpError};
use rmcp::model::{CallToolRequestParams, CallToolResult, ClientConfig};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const TEST_DBC: &str = r#"VERSION "1.0"

BU_: VCU BMS

BO_ 416 VehicleStatus: 8 VCU
 SG_ Speed : 0|16@1+ (0.01,0) [0|300] "km/h" BMS
 SG_ Gear : 16|4@1+ (1,0) [0|7] "" BMS
 SG_ MotorTorque : 39|16@0- (0.1,0) [-3000|3000] "Nm" BMS

BO_ 2566848512 BmsCells: 64 BMS
 SG_ CellMux M : 0|8@1+ (1,0) [0|23] "" VCU
 SG_ CellV_0 m0 : 8|16@1+ (0.001,0) [0|5] "V" VCU
 SG_ CellV_1 m1 : 8|16@1+ (0.001,0) [0|5] "V" VCU
 SG_ PackTemp : 496|16@1- (0.1,0) [-40|125] "degC" VCU

CM_ SG_ 416 Speed "Vehicle speed from wheel sensors";
VAL_ 416 Gear 0 "P" 1 "R" 2 "N" 3 "D" ;
"#;

const VS_FRAMES: u64 = 300; // 0x1A0 every 10 ms, t = 0 .. 2.99 s
const FD_FRAMES: u64 = 250; // 0x18FF0000 CAN-FD every 20 ms from t = 3.5 s
const FD_START_US: u64 = 3_500_000;
const TRACE_NAME: &str = "synthetic_drive.log";

fn temp_root(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "nexus-mcp-test-{tag}-{}-{nanos}",
        std::process::id()
    ))
}

fn synthetic_trace() -> String {
    let base = 1_700_000_000u64 * 1_000_000;
    let mut out = String::new();
    let mut push = |t_us: u64, body: String| {
        let abs = base + t_us;
        out.push_str(&format!(
            "({}.{:06}) can0 {body}\n",
            abs / 1_000_000,
            abs % 1_000_000
        ));
    };
    for i in 0..VS_FRAMES {
        let speed_raw = (i * 10) as u16; // 0.1 km/h per frame
        let [s0, s1] = speed_raw.to_le_bytes();
        push(i * 10_000, format!("1A0#{s0:02X}{s1:02X}0300FB2E0000"));
    }
    for j in 0..FD_FRAMES {
        let mut data = [0u8; 64];
        data[0] = (j % 2) as u8;
        let cell = (3_700 + j) as u16;
        data[1..3].copy_from_slice(&cell.to_le_bytes());
        data[62] = 0xFF; // PackTemp raw 255 -> 25.5 degC
        let hex: String = data.iter().map(|b| format!("{b:02X}")).collect();
        push(FD_START_US + j * 20_000, format!("18FF0000##1{hex}"));
    }
    out
}

fn engine_with_fixtures(tag: &str) -> Arc<PipelineEngine> {
    let root = DataRoot::under(temp_root(tag));
    root.ensure_dirs().expect("create temp data root");
    let engine = Arc::new(PipelineEngine::with_data_root(DriverRegistry::new(), root));
    let b64 = base64::engine::general_purpose::STANDARD.encode(TEST_DBC);
    engine
        .cmd_load_database_content("mcp_test.dbc".to_string(), b64, false)
        .expect("load test dbc");
    engine
        .cmd_save_trace_file(TRACE_NAME.to_string(), Some(synthetic_trace()), None)
        .expect("save synthetic trace");
    engine
}

fn find<'a>(arr: &'a Value, key: &str, name: &str) -> &'a Value {
    arr.as_array()
        .and_then(|a| a.iter().find(|v| v[key] == json!(name)))
        .unwrap_or_else(|| panic!("no element with {key}={name} in {arr}"))
}

fn approx(v: &Value, expected: f64) {
    let x = v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"));
    assert!((x - expected).abs() < 1e-6, "{x} != {expected}");
}

// ─── Pure tool functions ────────────────────────────────────────────────────

#[test]
fn db_tools_happy_paths() {
    let engine = engine_with_fixtures("db");
    let db = engine.current_compiled_database().expect("db loaded");
    let info = engine.current_database_info();

    let v = tools_db::db_info(Some(&db), info.as_ref());
    assert_eq!(v["loaded"], json!(true));
    assert_eq!(v["message_count"], json!(2));
    assert_eq!(v["signal_count"], json!(7));
    assert_eq!(v["ecu_count"], json!(2));
    assert_eq!(v["multiplexed_message_count"], json!(1));
    assert_eq!(tools_db::db_info(None, None)["loaded"], json!(false));

    let s = tools_db::db_search_signals(Some(&db), "SPEED", 20).unwrap();
    let first = &s["results"][0];
    assert_eq!(first["name"], json!("Speed"));
    assert_eq!(first["message"], json!("VehicleStatus"));
    assert_eq!(first["arb_id"], json!("0x1A0"));
    assert_eq!(first["unit"], json!("km/h"));
    assert_eq!(first["byte_order"], json!("intel"));
    assert_eq!(first["comment"], json!("Vehicle speed from wheel sensors"));
    // Comment hit: "wheel" only appears in the Speed comment.
    let c = tools_db::db_search_signals(Some(&db), "wheel", 20).unwrap();
    assert_eq!(c["total_matches"], json!(1));
    let cells = tools_db::db_search_signals(Some(&db), "cellv", 1).unwrap();
    assert_eq!(cells["returned"], json!(1));
    assert_eq!(cells["total_matches"], json!(2));
    assert_eq!(cells["truncated"], json!(true));
    assert_eq!(cells["results"][0]["mux"]["role"], json!("multiplexed"));
    assert!(tools_db::db_search_signals(Some(&db), "  ", 5).is_err());

    let m = tools_db::db_get_message(Some(&db), Some("0x18FF0000"), None).unwrap();
    assert_eq!(m["name"], json!("BmsCells"));
    assert_eq!(m["is_extended"], json!(true));
    assert_eq!(m["dlc"], json!(64));
    assert_eq!(m["multiplexing"]["master_switch"], json!("CellMux"));
    assert_eq!(m["signal_count"], json!(4));
    let by_name = tools_db::db_get_message(Some(&db), None, Some("vehiclestatus")).unwrap();
    assert_eq!(by_name["arb_id"], json!("0x1A0"));
    assert_eq!(by_name["transmitters"], json!(["VCU"]));
    let by_dec = tools_db::db_get_message(Some(&db), Some("416"), None).unwrap();
    assert_eq!(by_dec["name"], json!("VehicleStatus"));
    assert!(tools_db::db_get_message(Some(&db), Some("0x123"), None).is_err());
}

#[test]
fn db_decode_frame_intel_motorola_and_fd() {
    let engine = engine_with_fixtures("decode");
    let db = engine.current_compiled_database().unwrap();

    // Speed (Intel) raw 0x2710 = 10000 * 0.01 = 100 km/h; Gear raw 3 = "D";
    // MotorTorque (Motorola, MSB at bit 39 = byte 4) raw 0xFB2E = -1234 * 0.1 = -123.4 Nm.
    let v = tools_db::db_decode_frame(Some(&db), "0x1A0", None, "10 27 03 00 FB 2E 00 00").unwrap();
    assert_eq!(v["matched"], json!(true));
    assert_eq!(v["message"], json!("VehicleStatus"));
    let sigs = &v["signals"];
    approx(&find(sigs, "name", "Speed")["value"], 100.0);
    assert_eq!(find(sigs, "name", "Speed")["raw"], json!(10000));
    let gear = find(sigs, "name", "Gear");
    assert_eq!(gear["enum_label"], json!("D"));
    let tq = find(sigs, "name", "MotorTorque");
    approx(&tq["value"], -123.4);
    assert_eq!(tq["raw"], json!(-1234));
    assert_eq!(tq["unit"], json!("Nm"));
    assert_eq!(tq["out_of_range"], json!(false));

    // Out of range: Speed raw 0xFFFF = 655.35 km/h > 300.
    let o = tools_db::db_decode_frame(Some(&db), "416", Some(false), "FFFF000000000000").unwrap();
    assert_eq!(
        find(&o["signals"], "name", "Speed")["out_of_range"],
        json!(true)
    );

    // CAN-FD 64 bytes, mux page 1, PackTemp in bytes 62..63.
    let mut fd = [0u8; 64];
    fd[0] = 1;
    fd[1..3].copy_from_slice(&3_700u16.to_le_bytes());
    fd[62] = 0xFF;
    let hex: String = fd.iter().map(|b| format!("{b:02x}")).collect();
    let f = tools_db::db_decode_frame(Some(&db), "0x18FF0000", Some(true), &hex).unwrap();
    assert_eq!(f["message"], json!("BmsCells"));
    approx(&find(&f["signals"], "name", "CellV_1")["value"], 3.7);
    approx(&find(&f["signals"], "name", "PackTemp")["value"], 25.5);
    assert!(f["signals"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["name"] != json!("CellV_0")));
    assert_eq!(f["active_mux"][0]["switch"], json!("CellMux"));
    assert_eq!(f["active_mux"][0]["value"], json!(1));

    // Validation + unknown ID.
    assert!(tools_db::db_decode_frame(Some(&db), "0x1A0", None, "123").is_err());
    assert!(tools_db::db_decode_frame(Some(&db), "0x1A0", None, "zz").is_err());
    assert!(tools_db::db_decode_frame(Some(&db), "0x1A0", None, &"00".repeat(65)).is_err());
    let u = tools_db::db_decode_frame(Some(&db), "0x555", None, "00").unwrap();
    assert_eq!(u["matched"], json!(false));
    assert!(tools_db::db_decode_frame(None, "0x1A0", None, "00").is_err());
}

#[test]
fn trace_list_and_summary() {
    let engine = engine_with_fixtures("summary");
    let db = engine.current_compiled_database();
    let list = tools_trace::trace_list(&engine).unwrap();
    assert_eq!(list["count"], json!(1));
    assert_eq!(list["files"][0]["file_name"], json!(TRACE_NAME));
    assert_eq!(list["files"][0]["format"], json!("log"));

    let cache = TraceCache::default();
    let trace = cache.load(&engine, TRACE_NAME).unwrap();
    // Path traversal / unknown names never reach the filesystem.
    assert!(cache.load(&engine, "../etc/passwd").is_err());
    assert!(cache.load(&engine, "missing.log").is_err());
    // Cache hit returns the same parsed trace.
    assert!(Arc::ptr_eq(
        &trace,
        &cache.load(&engine, TRACE_NAME).unwrap()
    ));

    let s = tools_trace::trace_summary(&trace, db.as_deref(), 30).unwrap();
    assert_eq!(s["total_frames"], json!(VS_FRAMES + FD_FRAMES));
    assert_eq!(
        s["duration_us"],
        json!(FD_START_US + (FD_FRAMES - 1) * 20_000)
    );
    assert_eq!(s["bus_ids"], json!([0]));
    assert_eq!(s["distinct_ids"], json!(2));
    assert_eq!(s["fd_frames"], json!(FD_FRAMES));
    let ids = &s["ids"];
    let vs = find(ids, "arb_id", "0x1A0");
    assert_eq!(vs["count"], json!(VS_FRAMES));
    assert_eq!(vs["message"], json!("VehicleStatus"));
    approx(&vs["avg_period_ms"], 10.0);
    approx(&vs["min_period_ms"], 10.0);
    approx(&vs["max_period_ms"], 10.0);
    approx(&vs["jitter_std_ms"], 0.0);
    assert_eq!(vs["dlc"], json!(8));
    assert_eq!(vs["fd"], json!(false));
    let fd = find(ids, "arb_id", "0x18FF0000");
    assert_eq!(fd["message"], json!("BmsCells"));
    assert_eq!(fd["fd"], json!(true));
    assert_eq!(fd["dlc"], json!(64));
    approx(&fd["avg_period_ms"], 20.0);
    // Longest gap: last 0x1A0 at 2.99 s -> first FD frame at 3.5 s.
    let gap = &s["longest_gaps"][0];
    assert_eq!(gap["start_us"], json!((VS_FRAMES - 1) * 10_000));
    assert_eq!(gap["end_us"], json!(FD_START_US));
    approx(&gap["duration_ms"], 510.0);
    // top_n limits the per-ID table.
    let top1 = tools_trace::trace_summary(&trace, db.as_deref(), 1).unwrap();
    assert_eq!(top1["ids_shown"], json!(1));
    assert_eq!(top1["ids"][0]["arb_id"], json!("0x1A0"));
}

#[test]
fn trace_query_cursor_pagination() {
    let engine = engine_with_fixtures("query");
    let trace = TraceCache::default().load(&engine, TRACE_NAME).unwrap();
    let args = |cursor: Option<u64>| QueryArgs {
        from_us: None,
        to_us: Some(VS_FRAMES * 10_000),
        arb_ids: Some(vec!["0x1A0".to_string()]),
        limit: 120,
        cursor,
    };
    let mut cursor = None;
    let mut rows: Vec<Value> = Vec::new();
    let mut pages = 0;
    loop {
        let page = tools_trace::trace_query(&trace, &args(cursor)).unwrap();
        assert_eq!(page["matched_total"], json!(VS_FRAMES));
        rows.extend(page["rows"].as_array().unwrap().iter().cloned());
        pages += 1;
        match page["next_cursor"].as_u64() {
            Some(c) => {
                assert_eq!(page["truncated"], json!(true));
                cursor = Some(c);
            }
            None => break,
        }
        assert!(pages < 10, "pagination did not terminate");
    }
    assert_eq!(pages, 3); // 120 + 120 + 60
    assert_eq!(rows.len() as u64, VS_FRAMES);
    for (i, r) in rows.iter().enumerate() {
        assert_eq!(
            r[0],
            json!(i as u64 * 10_000),
            "chronological, no gaps/duplicates"
        );
        assert_eq!(r[1], json!(0));
        assert_eq!(r[2], json!("0x1A0"));
        assert_eq!(r[3], json!(8));
    }
    assert_eq!(rows[1][4], json!("0A000300FB2E0000"));

    // Time-window filter.
    let w = tools_trace::trace_query(
        &trace,
        &QueryArgs {
            from_us: Some(FD_START_US),
            to_us: Some(FD_START_US + 40_000),
            arb_ids: None,
            limit: 100,
            cursor: None,
        },
    )
    .unwrap();
    assert_eq!(w["matched_total"], json!(3));
    assert_eq!(w["rows"][0][2], json!("0x18FF0000"));
    assert_eq!(w["next_cursor"], Value::Null);
    assert!(tools_trace::trace_query(
        &trace,
        &QueryArgs {
            from_us: Some(10),
            to_us: Some(5),
            arb_ids: None,
            limit: 10,
            cursor: None
        }
    )
    .is_err());
}

#[test]
fn responses_are_truncated_to_the_size_cap() {
    let engine = engine_with_fixtures("trunc");
    let trace = TraceCache::default().load(&engine, TRACE_NAME).unwrap();
    // 200 CAN-FD rows (128 hex chars each) are far above 16 KB.
    let page = tools_trace::trace_query(
        &trace,
        &QueryArgs {
            from_us: Some(FD_START_US),
            to_us: None,
            arb_ids: None,
            limit: 200,
            cursor: None,
        },
    )
    .unwrap();
    let text = serde_json::to_string(&page).unwrap();
    assert!(text.len() <= MAX_RESPONSE_BYTES, "{} bytes", text.len());
    assert_eq!(page["truncated"], json!(true));
    let returned = page["returned"].as_u64().unwrap();
    assert!(returned > 0 && returned < 200);
    assert!(page["omitted_items"].as_u64().unwrap() > 0);
    // The cursor resumes exactly after the last returned row.
    let next = page["next_cursor"].as_u64().unwrap();
    assert_eq!(next, VS_FRAMES + returned);
    let page2 = tools_trace::trace_query(
        &trace,
        &QueryArgs {
            from_us: Some(FD_START_US),
            to_us: None,
            arb_ids: None,
            limit: 1,
            cursor: Some(next),
        },
    )
    .unwrap();
    assert_eq!(page2["rows"][0][0], json!(FD_START_US + returned * 20_000));
}

#[test]
fn trace_signal_series_decodes_and_downsamples() {
    let engine = engine_with_fixtures("series");
    let db = engine.current_compiled_database();
    let trace = TraceCache::default().load(&engine, TRACE_NAME).unwrap();

    let s =
        tools_trace::trace_signal_series(&trace, db.as_deref(), "Speed", None, None, 50).unwrap();
    assert_eq!(s["message"], json!("VehicleStatus"));
    assert_eq!(s["sample_count"], json!(VS_FRAMES));
    approx(&s["min"], 0.0);
    approx(&s["max"], (VS_FRAMES - 1) as f64 * 0.1);
    approx(&s["mean"], (VS_FRAMES - 1) as f64 * 0.1 / 2.0);
    assert_eq!(s["downsampled"], json!(true));
    let pts = s["points"].as_array().unwrap();
    assert!(pts.len() <= 50 && pts.len() >= 25);
    approx(&pts[0][1], 0.0);
    approx(&pts[pts.len() - 1][1], (VS_FRAMES - 1) as f64 * 0.1);

    // Multiplexed signal: only active on odd FD frames; Message.Signal syntax.
    let c = tools_trace::trace_signal_series(
        &trace,
        db.as_deref(),
        "BmsCells.CellV_1",
        None,
        None,
        500,
    )
    .unwrap();
    assert_eq!(c["frames_matched"], json!(FD_FRAMES));
    assert_eq!(c["sample_count"], json!(FD_FRAMES / 2));
    assert_eq!(c["downsampled"], json!(false));
    approx(&c["min"], 3.701);

    // Window + errors.
    let w = tools_trace::trace_signal_series(
        &trace,
        db.as_deref(),
        "speed",
        Some(0),
        Some(90_000),
        200,
    )
    .unwrap();
    assert_eq!(w["sample_count"], json!(10));
    assert!(
        tools_trace::trace_signal_series(&trace, db.as_deref(), "Nope", None, None, 10).is_err()
    );
    assert!(tools_trace::trace_signal_series(&trace, None, "Speed", None, None, 10).is_err());
}

// ─── HTTP guard ─────────────────────────────────────────────────────────────

/// Sends one raw HTTP/1.1 POST and returns the status code.
fn raw_post(port: u16, headers: &[(&str, &str)]) -> u16 {
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"raw","version":"0"}}}"#;
    let mut req = String::from("POST /mcp HTTP/1.1\r\n");
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) {
        req.push_str(&format!("Host: 127.0.0.1:{port}\r\n"));
    }
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str(
        "Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n",
    );
    req.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    ));
    let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    s.set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .ok();
    s.write_all(req.as_bytes()).expect("write");
    let mut buf = [0u8; 64];
    let mut got = Vec::new();
    while !got.windows(2).any(|w| w == b"\r\n") {
        let n = s.read(&mut buf).expect("read status line");
        if n == 0 {
            break;
        }
        got.extend_from_slice(&buf[..n]);
    }
    let line = String::from_utf8_lossy(&got);
    line.split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or_else(|| panic!("bad status line: {line}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn auth_and_dns_rebinding_guard() {
    let engine = engine_with_fixtures("auth");
    let handle = nexus_mcp::start(
        engine,
        McpConfig { port: 0 },
        &tokio::runtime::Handle::current(),
    )
    .expect("start");
    let port = handle.port();
    let token = handle.token().to_string();
    assert_eq!(token.len(), 64);
    assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    let bearer = format!("Bearer {token}");

    let statuses = tokio::task::spawn_blocking(move || {
        let wrong = format!("Bearer {}", "0".repeat(64));
        let host = format!("127.0.0.1:{port}");
        vec![
            raw_post(port, &[]),                               // no token
            raw_post(port, &[("Authorization", &wrong)]),      // wrong token
            raw_post(port, &[("Authorization", "Basic abc")]), // wrong scheme
            raw_post(
                port,
                &[
                    ("Authorization", &bearer),
                    ("Origin", "https://evil.example"),
                ],
            ),
            raw_post(
                port,
                &[
                    ("Authorization", &bearer),
                    ("Origin", "http://localhost.evil.example"),
                ],
            ),
            raw_post(
                port,
                &[("Authorization", &bearer), ("Host", "evil.example")],
            ),
            raw_post(
                port,
                &[
                    ("Authorization", &bearer),
                    ("Host", &host),
                    ("Origin", "http://localhost:5173"),
                ],
            ),
            raw_post(port, &[("Authorization", &bearer)]),
        ]
    })
    .await
    .unwrap();
    assert_eq!(&statuses[..3], &[401, 401, 401], "{statuses:?}");
    assert_eq!(&statuses[3..6], &[403, 403, 403], "{statuses:?}");
    assert_eq!(&statuses[6..], &[200, 200], "{statuses:?}");
    handle.shutdown().await;
}

// ─── End-to-end over MCP (rmcp client) ──────────────────────────────────────

fn result_json(r: &CallToolResult) -> Value {
    let text = &r.content[0].as_text().expect("text content").text;
    assert!(text.len() <= MAX_RESPONSE_BYTES);
    serde_json::from_str(text).expect("tool output is JSON")
}

async fn call(
    client: &rmcp::service::RunningService<rmcp::RoleClient, ClientConfig>,
    name: &'static str,
    args: Value,
) -> (bool, Value) {
    let mut p = CallToolRequestParams::new(name);
    if let Value::Object(m) = args {
        p = p.with_arguments(m);
    }
    let r = client.call_tool(p).await.expect("call_tool");
    (r.is_error == Some(true), result_json(&r))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn e2e_tools_list_and_call_over_streamable_http() {
    let engine = engine_with_fixtures("e2e");
    let handle = nexus_mcp::start(
        Arc::clone(&engine),
        McpConfig { port: 0 },
        &tokio::runtime::Handle::current(),
    )
    .expect("start");
    let st = handle.status();
    assert!(st.running && st.read_only);
    assert_eq!(st.total_calls, 0);
    assert_eq!(
        st.endpoint_url,
        format!("http://127.0.0.1:{}/mcp", handle.port())
    );

    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(handle.endpoint_url())
            .auth_header(handle.token().to_string()),
    );
    let client = ClientConfig::default()
        .serve(transport)
        .await
        .expect("mcp initialize");

    let tools = client.list_all_tools().await.expect("tools/list");
    let mut names: Vec<String> = tools.iter().map(|t| t.name.to_string()).collect();
    names.sort();
    // M2 tools (planning/contracts/mcp-v1.md §8) are covered by their own test files.
    const M2_TOOLS: [&str; 12] = [
        "app_status",
        "device_list",
        "driver_probe",
        "bus_status",
        "live_message_table",
        "live_signal_values",
        "periodic_tx_list",
        "signal_stats",
        "live_trace_window",
        "project_list",
        "project_get",
        "trace_compare",
    ];
    // M3 tools (§9) are covered by tests/m3_*.rs.
    const M3_TOOLS: [&str; 14] = [
        "diag_session_info",
        "diag_conversation",
        "diag_isotp_frames",
        "diag_passive_discovery",
        "re_status",
        "re_series",
        "re_correlate",
        "re_scan_results",
        "re_row_detail",
        "re_dbc_generate",
        "run_query",
        "run_latest",
        "flowlib_list",
        "flowlib_get",
    ];
    names.retain(|n| {
        !M2_TOOLS.contains(&n.as_str())
            && !M3_TOOLS.contains(&n.as_str())
            && n != "debug_events_query"
    });
    assert_eq!(names.len(), 20, "M1 + M1.1 db tools + 8 ui tools");
    names.retain(|n| {
        !n.starts_with("ui_")
            && !["db_list", "db_get_ecu", "db_diagnostics", "db_encode_frame"].contains(&n.as_str())
    });
    assert_eq!(
        names,
        [
            "db_decode_frame",
            "db_get_message",
            "db_info",
            "db_search_signals",
            "trace_list",
            "trace_query",
            "trace_signal_series",
            "trace_summary"
        ]
    );
    for t in tools.iter().filter(|t| !t.name.starts_with("ui_")) {
        assert!(
            t.description.as_ref().is_some_and(|d| d.len() > 40),
            "{}",
            t.name
        );
        assert_eq!(
            t.annotations.as_ref().and_then(|a| a.read_only_hint),
            Some(true),
            "{} must be annotated read-only",
            t.name
        );
    }
    let decode_schema = serde_json::to_value(
        &tools
            .iter()
            .find(|t| t.name == "db_decode_frame")
            .unwrap()
            .input_schema,
    )
    .unwrap();
    assert_eq!(decode_schema["required"], json!(["arb_id", "data_hex"]));

    let (err, v) = call(&client, "db_info", json!({})).await;
    assert!(!err);
    assert_eq!(v["loaded"], json!(true));

    let (_, v) = call(&client, "db_search_signals", json!({ "query": "torque" })).await;
    assert_eq!(v["results"][0]["byte_order"], json!("motorola"));

    let (_, v) = call(&client, "db_get_message", json!({ "name": "BmsCells" })).await;
    assert_eq!(v["arb_id"], json!("0x18FF0000"));

    let (_, v) = call(
        &client,
        "db_decode_frame",
        json!({ "arb_id": "0x1A0", "data_hex": "10270300FB2E0000" }),
    )
    .await;
    approx(&find(&v["signals"], "name", "MotorTorque")["value"], -123.4);

    let (err, v) = call(
        &client,
        "db_decode_frame",
        json!({ "arb_id": "0x1A0", "data_hex": "xyz" }),
    )
    .await;
    assert!(err, "invalid hex must be a tool-level error");
    assert!(v["error"].as_str().unwrap().contains("non-hex"));

    let (_, v) = call(&client, "trace_list", json!({})).await;
    assert_eq!(v["files"][0]["file_name"], json!(TRACE_NAME));

    let (_, v) = call(
        &client,
        "trace_summary",
        json!({ "file_name": TRACE_NAME, "top_n": 5 }),
    )
    .await;
    assert_eq!(v["total_frames"], json!(VS_FRAMES + FD_FRAMES));

    let (_, v) = call(
        &client,
        "trace_query",
        json!({ "file_name": TRACE_NAME, "arb_ids": ["0x1A0"], "limit": 100 }),
    )
    .await;
    assert_eq!(v["returned"], json!(100));
    let cur = v["next_cursor"].as_u64().unwrap();
    let (_, v2) = call(
        &client,
        "trace_query",
        json!({ "file_name": TRACE_NAME, "arb_ids": ["0x1A0"], "limit": 100, "cursor": cur }),
    )
    .await;
    assert_eq!(v2["rows"][0][0], json!(100 * 10_000));

    let (_, v) = call(
        &client,
        "trace_signal_series",
        json!({ "file_name": TRACE_NAME, "signal": "PackTemp", "max_points": 20 }),
    )
    .await;
    approx(&v["mean"], 25.5);
    assert!(v["points"].as_array().unwrap().len() <= 20);

    let (err, _) = call(
        &client,
        "trace_summary",
        json!({ "file_name": "../../etc/passwd" }),
    )
    .await;
    assert!(err);

    let st = handle.status();
    assert_eq!(st.total_calls, 11);
    assert!(st.connected_clients >= 1, "{st:?}");

    // Every tool call is audited in the engine debug hub (category MCP, source mcp).
    let events = engine.snapshot_debug_events();
    let audits: Vec<_> = events
        .events
        .iter()
        .filter(|e| e.category == "MCP" && e.action == "mcp.tool_call")
        .collect();
    assert!(!audits.is_empty());
    assert!(audits.iter().all(|e| e.source == "mcp"));
    assert!(audits.iter().any(|e| e
        .details
        .as_deref()
        .is_some_and(|d| d.contains("query=torque"))));

    let _ = client.cancel().await;
    handle.shutdown().await;
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn busy_port_is_an_explicit_error_and_stop_releases_the_port() {
    let engine = engine_with_fixtures("life");
    let rt = tokio::runtime::Handle::current();
    let first = nexus_mcp::start(Arc::clone(&engine), McpConfig { port: 0 }, &rt).unwrap();
    let port = first.port();

    match nexus_mcp::start(Arc::clone(&engine), McpConfig { port }, &rt) {
        Err(McpError::PortInUse { port: p }) => assert_eq!(p, port),
        Err(e) => panic!("unexpected error: {e}"),
        Ok(_) => panic!("second server on a busy port must fail"),
    }

    first.shutdown().await;
    let again = nexus_mcp::start(Arc::clone(&engine), McpConfig { port }, &rt)
        .expect("port is free again after shutdown");
    assert_eq!(again.port(), port);
    assert_ne!(again.status().token, "");
    again.stop();
}
