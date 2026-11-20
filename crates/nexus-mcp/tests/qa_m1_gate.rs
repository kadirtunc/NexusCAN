//! QA gate "MCP M1" (qa-hil-verifier): adversarial checks on top of `mcp_server.rs`.
//!
//! * Host / Origin guard bypass matrix and bearer-token edge cases over raw HTTP/1.1.
//! * Loopback-only bind (connect to a non-loopback local address must be refused).
//! * Malformed tool input over MCP (invalid hex, 65-byte payload, huge `limit`, inverted /
//!   negative time windows, path traversal file names, unknown / write-like tool names):
//!   no panic, explicit tool error, server still alive, every response <= 16 KB.
//! * Size + latency discipline on a synthetic 100k-frame trace and an oversized database.
//! * Raw JSON-RPC smoke via `curl` (`initialize` -> `notifications/initialized` ->
//!   `tools/list` -> `tools/call db_info`, plus the 401 proof). Run with `--nocapture` to see
//!   the exact commands and (shortened) responses.

use base64::Engine as _;
use nexus_hal::pipeline::PipelineEngine;
use nexus_hal::registry::DriverRegistry;
use nexus_hal::storage::DataRoot;
use nexus_mcp::util::MAX_RESPONSE_BYTES;
use nexus_mcp::McpConfig;
use rmcp::model::{CallToolRequestParams, ClientConfig};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{IpAddr, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const QA_DBC: &str = r#"VERSION "1.0"

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
"#;

const BIG_TRACE: &str = "qa_big_100k.log";
const BIG_FRAMES: usize = 100_000;

fn temp_root(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("nexus-mcp-qa-{tag}-{}-{nanos}", std::process::id()))
}

/// 512 one-bit signals in a 64-byte FD message + the QA vehicle DBC.
fn oversized_dbc() -> String {
    let mut s = String::from(QA_DBC);
    s.push_str("\nBO_ 2566848513 Huge512: 64 BMS\n");
    for i in 0..512 {
        s.push_str(&format!(
            " SG_ Flag_{i:03}_with_a_long_descriptive_name : {i}|1@1+ (1,0) [0|1] \"\" VCU\n"
        ));
    }
    s
}

/// 100k-frame candump log: 0x1A0 @ 1 kHz-ish interleaved with 300 distinct classic IDs and a
/// 64-byte CAN-FD stream, all chronological.
fn big_trace() -> String {
    let base = 1_700_000_000u64 * 1_000_000;
    let mut out = String::with_capacity(BIG_FRAMES * 48);
    for i in 0..BIG_FRAMES as u64 {
        let abs = base + i * 100; // 10 kfps => 10 s trace
        let ts = format!("({}.{:06}) can0 ", abs / 1_000_000, abs % 1_000_000);
        out.push_str(&ts);
        match i % 10 {
            0..=3 => {
                let raw = (i % 30_000) as u16;
                let [a, b] = raw.to_le_bytes();
                out.push_str(&format!("1A0#{a:02X}{b:02X}0300FB2E0000\n"));
            }
            4 => {
                let mut d = [0u8; 64];
                d[0] = (i % 2) as u8;
                d[1..3].copy_from_slice(&((3_000 + (i % 1_000)) as u16).to_le_bytes());
                d[62] = 0xFF;
                let hex: String = d.iter().map(|b| format!("{b:02X}")).collect();
                out.push_str(&format!("18FF0000##1{hex}\n"));
            }
            _ => {
                let id = 0x200 + (i % 300) as u32;
                out.push_str(&format!("{id:03X}#0102030405060708\n"));
            }
        }
    }
    out
}

fn engine_qa(tag: &str, dbc: &str) -> Arc<PipelineEngine> {
    let root = DataRoot::under(temp_root(tag));
    root.ensure_dirs().expect("create temp data root");
    std::fs::write(root.traces_dir().join(BIG_TRACE), big_trace()).expect("write big trace");
    // A second, small trace so the traversal tests have a legit sibling.
    std::fs::write(
        root.traces_dir().join("small.log"),
        "(1700000000.000000) can0 1A0#1027030000000000\n(1700000000.010000) can0 1A0#1027030000000000\n",
    )
    .expect("write small trace");
    let engine = Arc::new(PipelineEngine::with_data_root(DriverRegistry::new(), root));
    let b64 = base64::engine::general_purpose::STANDARD.encode(dbc);
    engine
        .cmd_load_database_content("qa.dbc".to_string(), b64, false)
        .expect("load qa dbc");
    engine
}

// ─── Raw HTTP helpers ───────────────────────────────────────────────────────

/// One raw HTTP/1.1 request; returns (status, full response text). `host = None` omits Host.
fn raw_http(
    port: u16,
    method: &str,
    host: Option<&str>,
    headers: &[(&str, &str)],
    body: &str,
) -> (u16, String) {
    let mut req = format!("{method} /mcp HTTP/1.1\r\n");
    if let Some(h) = host {
        req.push_str(&format!("Host: {h}\r\n"));
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
    s.set_read_timeout(Some(Duration::from_secs(3))).ok();
    s.write_all(req.as_bytes()).expect("write");
    let mut got = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match s.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                got.extend_from_slice(&buf[..n]);
                // SSE responses may keep the connection open; the status line is enough.
                if got.len() > 64 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&got).to_string();
    let code = text
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    (code, text)
}

const INIT_BODY: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"qa","version":"0"}}}"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn qa_guard_bypass_matrix_and_token_edges() {
    let engine = engine_qa("guard", QA_DBC);
    let handle = nexus_mcp::start(
        engine,
        McpConfig { port: 0 },
        &tokio::runtime::Handle::current(),
    )
    .expect("start");
    let port = handle.port();
    let token = handle.token().to_string();

    let results = tokio::task::spawn_blocking(move || {
        let ok_host = format!("127.0.0.1:{port}");
        let bearer = format!("Bearer {token}");
        let mut rows: Vec<(String, u16, u16)> = Vec::new(); // (case, expected, actual)
        let mut case = |name: &str, expected: u16, host: Option<&str>, extra: &[(&str, &str)]| {
            let (code, _) = raw_http(port, "POST", host, extra, INIT_BODY);
            rows.push((name.to_string(), expected, code));
        };
        let auth = [("Authorization", bearer.as_str())];

        // Host header attacks (all carry a valid token: only the Host check may reject).
        for (name, h) in [
            ("host 127.0.0.1.evil.com", "127.0.0.1.evil.com"),
            ("host 127.0.0.1.evil.com:port", "127.0.0.1.evil.com:47800"),
            ("host localhost:80@evil", "localhost:80@evil"),
            ("host localhost@evil.com", "localhost@evil.com"),
            ("host evil.com#localhost", "evil.com#localhost"),
            ("host localhost.", "localhost."),
            ("host 127.0.0.1.", "127.0.0.1."),
            ("host [::1]:port (deny, v4-only bind)", "[::1]:47800"),
            ("host [::ffff:127.0.0.1]", "[::ffff:127.0.0.1]:47800"),
            ("host 0x7f.0.0.1", "0x7f.0.0.1"),
            ("host 2130706433", "2130706433"),
            ("host 127.1", "127.1"),
            ("host 0.0.0.0", "0.0.0.0"),
            ("host localhost.localdomain", "localhost.localdomain"),
            ("host evil.com", "evil.com"),
        ] {
            case(name, 403, Some(h), &auth);
        }
        // Allowed host spellings.
        case(
            "host LOCALHOST:port (case-insens.)",
            200,
            Some(&format!("LOCALHOST:{port}")),
            &auth,
        );
        case("host localhost (no port)", 200, Some("localhost"), &auth);
        case("host 127.0.0.1:port", 200, Some(&ok_host), &auth);

        // Origin attacks.
        for (name, o) in [
            (
                "origin http://127.0.0.1.evil.com",
                "http://127.0.0.1.evil.com",
            ),
            (
                "origin http://localhost:80@evil.com",
                "http://localhost:80@evil.com",
            ),
            (
                "origin http://localhost@evil.com",
                "http://localhost@evil.com",
            ),
            ("origin https://localhost (scheme)", "https://localhost"),
            ("origin http://[::1]:5173", "http://[::1]:5173"),
            ("origin null", "null"),
            ("origin file://", "file://"),
            ("origin http://localhost:", "http://localhost:"),
            (
                "origin http://localhost:5173/path",
                "http://localhost:5173/path",
            ),
            ("origin tauri://localhost", "tauri://localhost"),
            ("origin http://tauri.localhost", "http://tauri.localhost"),
        ] {
            case(name, 403, Some(&ok_host), &[auth[0], ("Origin", o)]);
        }
        case(
            "origin HTTP://LOCALHOST:5173 (case)",
            200,
            Some(&ok_host),
            &[auth[0], ("Origin", "HTTP://LOCALHOST:5173")],
        );
        case(
            "origin http://127.0.0.1",
            200,
            Some(&ok_host),
            &[auth[0], ("Origin", "http://127.0.0.1")],
        );

        // Host check runs before auth: foreign host without token is 403 (not 401).
        case(
            "evil host, no token -> 403 first",
            403,
            Some("evil.com"),
            &[],
        );

        // Token edges.
        let t = token.clone();
        let upper = format!("Bearer {}", t.to_ascii_uppercase());
        let prefix = format!("Bearer {}", &t[..63]);
        let longer = format!("Bearer {t}0");
        let lower_scheme = format!("bearer {t}");
        let double_space = format!("Bearer  {t}");
        let trailing = format!("Bearer {t} ");
        let two_tokens = format!("Bearer {t} {t}");
        for (name, v, exp) in [
            ("token uppercase hex", upper.as_str(), 401),
            ("token 63-char prefix", prefix.as_str(), 401),
            ("token + extra char", longer.as_str(), 401),
            ("token twice", two_tokens.as_str(), 401),
            ("scheme only", "Bearer", 401),
            ("scheme + space", "Bearer ", 401),
            ("empty header", "", 401),
            ("scheme lowercase (RFC 7235 ok)", lower_scheme.as_str(), 200),
            ("double space after scheme", double_space.as_str(), 200),
            (
                "trailing whitespace (trimmed by HTTP)",
                trailing.as_str(),
                200,
            ),
        ] {
            case(name, exp, Some(&ok_host), &[("Authorization", v)]);
        }
        // GET (SSE stream) without token must also be 401.
        let (code, _) = raw_http(port, "GET", Some(&ok_host), &[], "");
        rows.push(("GET /mcp no token".into(), 401, code));
        let (code, _) = raw_http(port, "DELETE", Some(&ok_host), &[], "");
        rows.push(("DELETE /mcp no token".into(), 401, code));
        rows
    })
    .await
    .unwrap();

    let mut failures = Vec::new();
    for (name, exp, got) in &results {
        println!("[guard] {name:<45} expected {exp} got {got}");
        if exp != got {
            failures.push(format!("{name}: expected {exp}, got {got}"));
        }
    }
    handle.shutdown().await;
    assert!(
        failures.is_empty(),
        "guard matrix failures:\n{}",
        failures.join("\n")
    );
}

/// The listener must not be reachable via a non-loopback local address.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn qa_bind_is_loopback_only() {
    let engine = engine_qa("bind", QA_DBC);
    let handle = nexus_mcp::start(
        engine,
        McpConfig { port: 0 },
        &tokio::runtime::Handle::current(),
    )
    .expect("start");
    let port = handle.port();
    // Discover the primary non-loopback IPv4 (no packet is sent for a UDP "connect").
    let local_ip = UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| s.connect("192.0.2.1:9").map(|_| s))
        .and_then(|s| s.local_addr())
        .map(|a| a.ip())
        .ok()
        .filter(|ip| !ip.is_loopback() && !ip.is_unspecified());
    let loop_ok =
        TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(1)).is_ok();
    assert!(loop_ok, "loopback must accept");
    let v6 = TcpStream::connect_timeout(
        &("::1".parse::<IpAddr>().unwrap(), port).into(),
        Duration::from_millis(500),
    );
    println!(
        "[bind] port {port}: 127.0.0.1 ok, [::1] -> {:?}",
        v6.as_ref().map(|_| "CONNECTED")
    );
    assert!(v6.is_err(), "IPv6 loopback must not be bound (v4-only)");
    match local_ip {
        Some(ip) => {
            let r = TcpStream::connect_timeout(&(ip, port).into(), Duration::from_millis(500));
            println!(
                "[bind] {ip}:{port} -> {:?}",
                r.as_ref().map(|_| "CONNECTED")
            );
            assert!(r.is_err(), "non-loopback {ip} must be refused");
        }
        None => println!("[bind] no non-loopback IPv4 found; skipped external-address probe"),
    }
    handle.shutdown().await;
}

// ─── MCP client helpers ─────────────────────────────────────────────────────

type Client = rmcp::service::RunningService<rmcp::RoleClient, ClientConfig>;

async fn connect(handle: &nexus_mcp::McpServerHandle) -> Client {
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(handle.endpoint_url())
            .auth_header(handle.token().to_string()),
    );
    ClientConfig::default()
        .serve(transport)
        .await
        .expect("mcp initialize")
}

/// Returns (is_error, text, bytes, elapsed). `Err(msg)` for protocol-level (JSON-RPC) errors.
async fn call_raw(
    client: &Client,
    name: &str,
    args: Value,
) -> Result<(bool, String, Duration), String> {
    let mut p = CallToolRequestParams::new(name.to_string());
    if let Value::Object(m) = args {
        p = p.with_arguments(m);
    }
    let t0 = Instant::now();
    let r = client.call_tool(p).await.map_err(|e| e.to_string())?;
    let el = t0.elapsed();
    let text = r
        .content
        .first()
        .and_then(|c| c.as_text())
        .map(|t| t.text.clone())
        .unwrap_or_default();
    Ok((r.is_error == Some(true), text, el))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn qa_bad_inputs_are_explicit_errors_and_never_panic() {
    let engine = engine_qa("bad", QA_DBC);
    let handle = nexus_mcp::start(
        Arc::clone(&engine),
        McpConfig { port: 0 },
        &tokio::runtime::Handle::current(),
    )
    .expect("start");
    let client = connect(&handle).await;

    let hex65 = "00".repeat(65);
    let hex64 = "00".repeat(64);
    // (case, tool, args, expectation) expectation: "err" tool-level error (rmcp also reports
    // schema / deserialization failures this way), "ok" success, "proto" JSON-RPC error
    // (unknown tool), "any" no panic only.
    let cases: Vec<(&str, &str, Value, &str)> = vec![
        (
            "decode invalid hex",
            "db_decode_frame",
            json!({"arb_id":"0x1A0","data_hex":"zz"}),
            "err",
        ),
        (
            "decode odd digits",
            "db_decode_frame",
            json!({"arb_id":"0x1A0","data_hex":"ABC"}),
            "err",
        ),
        (
            "decode 65 bytes",
            "db_decode_frame",
            json!({"arb_id":"0x18FF0000","data_hex":hex65}),
            "err",
        ),
        (
            "decode 64 bytes ok",
            "db_decode_frame",
            json!({"arb_id":"0x18FF0000","data_hex":hex64}),
            "ok",
        ),
        (
            "decode 0 bytes",
            "db_decode_frame",
            json!({"arb_id":"0x1A0","data_hex":""}),
            "ok",
        ),
        (
            "decode id > 29 bit",
            "db_decode_frame",
            json!({"arb_id":"0x20000000","data_hex":"00"}),
            "err",
        ),
        (
            "decode id -1",
            "db_decode_frame",
            json!({"arb_id":"-1","data_hex":"00"}),
            "err",
        ),
        (
            "decode std flag on 29-bit id",
            "db_decode_frame",
            json!({"arb_id":"0x800","is_extended":false,"data_hex":"00"}),
            "err",
        ),
        (
            "decode unicode hex",
            "db_decode_frame",
            json!({"arb_id":"0x1A0","data_hex":"ＡＢ"}),
            "err",
        ),
        (
            "decode missing data_hex",
            "db_decode_frame",
            json!({"arb_id":"0x1A0"}),
            "err",
        ),
        (
            "search limit u32::MAX",
            "db_search_signals",
            json!({"query":"e","limit":4294967295u64}),
            "ok",
        ),
        (
            "search limit 0",
            "db_search_signals",
            json!({"query":"e","limit":0}),
            "ok",
        ),
        (
            "search limit negative",
            "db_search_signals",
            json!({"query":"e","limit":-5}),
            "err",
        ),
        (
            "search empty query",
            "db_search_signals",
            json!({"query":"   "}),
            "err",
        ),
        ("get_message nothing", "db_get_message", json!({}), "err"),
        (
            "get_message bad id",
            "db_get_message",
            json!({"id":"0xZZ"}),
            "err",
        ),
        (
            "query limit u32::MAX",
            "trace_query",
            json!({"file_name":BIG_TRACE,"limit":4294967295u64}),
            "ok",
        ),
        (
            "query from>to",
            "trace_query",
            json!({"file_name":BIG_TRACE,"from_us":10,"to_us":5}),
            "err",
        ),
        (
            "query negative from_us",
            "trace_query",
            json!({"file_name":BIG_TRACE,"from_us":-1}),
            "err",
        ),
        (
            "query cursor u64::MAX",
            "trace_query",
            json!({"file_name":BIG_TRACE,"cursor":u64::MAX}),
            "err",
        ),
        (
            "query 65 ids",
            "trace_query",
            json!({"file_name":BIG_TRACE,"arb_ids":(0..65).map(|i| format!("0x{i:X}")).collect::<Vec<_>>()}),
            "err",
        ),
        (
            "query bad id in list",
            "trace_query",
            json!({"file_name":BIG_TRACE,"arb_ids":["nope"]}),
            "err",
        ),
        (
            "series max_points 0",
            "trace_signal_series",
            json!({"file_name":BIG_TRACE,"signal":"Speed","max_points":0}),
            "ok",
        ),
        (
            "series max_points u32::MAX",
            "trace_signal_series",
            json!({"file_name":BIG_TRACE,"signal":"Speed","max_points":4294967295u64}),
            "ok",
        ),
        (
            "series from>to",
            "trace_signal_series",
            json!({"file_name":BIG_TRACE,"signal":"Speed","from_us":9,"to_us":1}),
            "err",
        ),
        (
            "series unknown signal",
            "trace_signal_series",
            json!({"file_name":BIG_TRACE,"signal":"Nope"}),
            "err",
        ),
        (
            "summary top_n 0",
            "trace_summary",
            json!({"file_name":"small.log","top_n":0}),
            "ok",
        ),
        // Path traversal / absolute / encoded names.
        (
            "trav ../",
            "trace_summary",
            json!({"file_name":"../small.log"}),
            "err",
        ),
        (
            "trav ../../etc/passwd",
            "trace_summary",
            json!({"file_name":"../../etc/passwd"}),
            "err",
        ),
        (
            "trav absolute",
            "trace_summary",
            json!({"file_name":"/etc/passwd"}),
            "err",
        ),
        (
            "trav windows ..\\",
            "trace_summary",
            json!({"file_name":"..\\..\\small.log"}),
            "err",
        ),
        (
            "trav C:\\",
            "trace_summary",
            json!({"file_name":"C:\\Windows\\win.ini"}),
            "err",
        ),
        (
            "trav dir/../file",
            "trace_summary",
            json!({"file_name":"x/../small.log"}),
            "err",
        ),
        (
            "trav url-encoded",
            "trace_summary",
            json!({"file_name":"%2e%2e%2fsmall.log"}),
            "err",
        ),
        (
            "trav NUL",
            "trace_summary",
            json!({"file_name":"small.log\u{0}.txt"}),
            "err",
        ),
        (
            "trav case variant",
            "trace_query",
            json!({"file_name":"SMALL.LOG"}),
            "err",
        ),
        // Tools that must not exist.
        (
            "tool cmd_transmit_frame",
            "cmd_transmit_frame",
            json!({}),
            "proto",
        ),
        ("tool tx_send", "tx_send", json!({}), "proto"),
        ("tool replay_start", "replay_start", json!({}), "proto"),
        ("tool cmd_arm_bus", "cmd_arm_bus", json!({}), "proto"),
        ("tool trace_delete", "trace_delete", json!({}), "proto"),
    ];

    let mut failures = Vec::new();
    for (name, tool, args, exp) in cases {
        let res = call_raw(&client, tool, args).await;
        let (kind, bytes, preview) = match &res {
            Ok((true, text, _)) => (
                "err",
                text.len(),
                text.chars().take(110).collect::<String>(),
            ),
            Ok((false, text, _)) => ("ok", text.len(), text.chars().take(110).collect::<String>()),
            Err(e) => ("proto", 0, e.chars().take(110).collect::<String>()),
        };
        println!("[bad-input] {name:<30} -> {kind:<5} {bytes:>7} B  {preview}");
        if exp != "any" && kind != exp {
            failures.push(format!("{name}: expected {exp}, got {kind} ({preview})"));
        }
        if bytes > MAX_RESPONSE_BYTES {
            failures.push(format!(
                "{name}: response {bytes} B exceeds {MAX_RESPONSE_BYTES} B cap"
            ));
        }
        if let Ok((false, text, _)) = &res {
            let v: Value = serde_json::from_str(text).unwrap();
            if let Some(rows) = v.get("rows").and_then(Value::as_array) {
                if rows.len() > 200 {
                    failures.push(format!("{name}: {} rows > 200", rows.len()));
                }
            }
            if let Some(pts) = v.get("points").and_then(Value::as_array) {
                if pts.len() > 500 {
                    failures.push(format!("{name}: {} points > 500", pts.len()));
                }
            }
            if let Some(r) = v.get("results").and_then(Value::as_array) {
                if r.len() > 50 {
                    failures.push(format!("{name}: {} results > 50", r.len()));
                }
            }
        }
    }
    // Still alive after all of that.
    let (err, text, _) = call_raw(&client, "db_info", json!({}))
        .await
        .expect("db_info after abuse");
    assert!(!err && text.contains("\"loaded\":true"));
    let _ = client.cancel().await;
    handle.shutdown().await;
    assert!(
        failures.is_empty(),
        "bad-input failures:\n{}",
        failures.join("\n")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn qa_size_and_latency_on_100k_trace_and_512_signal_message() {
    let engine = engine_qa("size", &oversized_dbc());
    // Many trace files for trace_list.
    let dir = engine.cmd_list_traces().unwrap();
    let _ = dir;
    let handle = nexus_mcp::start(
        Arc::clone(&engine),
        McpConfig { port: 0 },
        &tokio::runtime::Handle::current(),
    )
    .expect("start");
    let client = connect(&handle).await;

    let cases: Vec<(&str, &str, Value)> = vec![
        (
            "trace_summary cold (parse 100k)",
            "trace_summary",
            json!({"file_name":BIG_TRACE,"top_n":100}),
        ),
        (
            "trace_summary warm",
            "trace_summary",
            json!({"file_name":BIG_TRACE,"top_n":100}),
        ),
        (
            "trace_signal_series Speed 500pts",
            "trace_signal_series",
            json!({"file_name":BIG_TRACE,"signal":"Speed","max_points":500}),
        ),
        (
            "trace_signal_series PackTemp 500",
            "trace_signal_series",
            json!({"file_name":BIG_TRACE,"signal":"PackTemp","max_points":500}),
        ),
        (
            "trace_signal_series CellV_0 mux",
            "trace_signal_series",
            json!({"file_name":BIG_TRACE,"signal":"CellV_0","max_points":500}),
        ),
        (
            "trace_query 200 FD rows",
            "trace_query",
            json!({"file_name":BIG_TRACE,"arb_ids":["0x18FF0000"],"limit":200}),
        ),
        (
            "trace_query 200 all rows",
            "trace_query",
            json!({"file_name":BIG_TRACE,"limit":200}),
        ),
        (
            "trace_query last page window",
            "trace_query",
            json!({"file_name":BIG_TRACE,"from_us":9_990_000,"limit":200}),
        ),
        ("trace_list", "trace_list", json!({})),
        ("db_info", "db_info", json!({})),
        (
            "db_search_signals 'flag' 50",
            "db_search_signals",
            json!({"query":"flag","limit":50}),
        ),
        (
            "db_get_message Huge512",
            "db_get_message",
            json!({"name":"Huge512"}),
        ),
        (
            "db_decode_frame Huge512 64B FF",
            "db_decode_frame",
            json!({"arb_id":"0x18FF0001","data_hex":"FF".repeat(64)}),
        ),
    ];
    let mut failures = Vec::new();
    for (name, tool, args) in cases {
        let (err, text, el) = call_raw(&client, tool, args).await.expect(name);
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let trunc = v.get("truncated").cloned().unwrap_or(Value::Null);
        println!(
            "[size] {name:<36} err={err:<5} {:>6} B  {:>8.2} ms  truncated={trunc}",
            text.len(),
            el.as_secs_f64() * 1e3
        );
        if err {
            failures.push(format!("{name}: unexpected tool error {text}"));
        }
        if text.len() > MAX_RESPONSE_BYTES {
            failures.push(format!("{name}: {} B > cap", text.len()));
        }
        if name.starts_with("db_get_message Huge") || name.starts_with("db_decode_frame Huge") {
            if trunc != json!(true) {
                failures.push(format!("{name}: 512 signals must be truncated"));
            }
            // A truncated answer must still carry signals (not the opaque 'dropped' stub).
            if v.get("signals")
                .and_then(Value::as_array)
                .is_none_or(|a| a.is_empty())
            {
                failures.push(format!("{name}: truncated answer has no signals"));
            }
        }
    }
    let _ = client.cancel().await;
    handle.shutdown().await;
    assert!(
        failures.is_empty(),
        "size failures:\n{}",
        failures.join("\n")
    );
}

// ─── curl raw JSON-RPC smoke ────────────────────────────────────────────────

fn curl(args: &[String]) -> (String, String) {
    println!(
        "$ curl {}",
        args.iter()
            .map(|a| if a.contains(' ') || a.contains('{') {
                format!("'{a}'")
            } else {
                a.clone()
            })
            .collect::<Vec<_>>()
            .join(" ")
    );
    let out = Command::new("curl")
        .args(args)
        .output()
        .expect("curl available");
    (
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    )
}

fn short(s: &str, n: usize) -> String {
    let one: String = s.replace("\r\n", " | ").replace('\n', " | ");
    if one.chars().count() > n {
        format!("{}...", one.chars().take(n).collect::<String>())
    } else {
        one
    }
}

/// Extracts the JSON-RPC body from a JSON or SSE (`data: {...}`) HTTP response body.
fn rpc_body(body: &str) -> Value {
    if let Ok(v) = serde_json::from_str::<Value>(body.trim()) {
        return v;
    }
    body.lines()
        .filter_map(|l| l.strip_prefix("data:"))
        .filter_map(|d| serde_json::from_str::<Value>(d.trim()).ok())
        .find(|v| v.get("id").is_some())
        .unwrap_or(Value::Null)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn qa_curl_raw_jsonrpc_smoke() {
    if Command::new("curl").arg("--version").output().is_err() {
        println!("curl not installed; skipping");
        return;
    }
    let engine = engine_qa("curl", QA_DBC);
    let handle = nexus_mcp::start(
        engine,
        McpConfig { port: 0 },
        &tokio::runtime::Handle::current(),
    )
    .expect("start");
    let url = handle.endpoint_url();
    let token = handle.token().to_string();

    let checks = tokio::task::spawn_blocking(move || {
        let tok_masked = format!("{}…", &token[..8]);
        println!("endpoint {url}  token {tok_masked} (64 hex)");
        let base = |extra: Vec<String>| -> Vec<String> {
            let mut v: Vec<String> = vec![
                "-sS".into(), "-i".into(), "--max-time".into(), "5".into(), url.clone(),
                "-H".into(), "Content-Type: application/json".into(),
                "-H".into(), "Accept: application/json, text/event-stream".into(),
            ];
            v.extend(extra);
            v
        };
        let auth = format!("Authorization: Bearer {token}");
        let split = |resp: &str| -> (u16, String, String) {
            let (head, body) = resp.split_once("\r\n\r\n").unwrap_or((resp, ""));
            let code = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
            (code, head.to_string(), body.to_string())
        };

        // 0) no token -> 401
        let (o, _) = curl(&base(vec!["-d".into(), INIT_BODY.into()]));
        let (c401, h401, b401) = split(&o);
        println!("  -> {c401} {} | body: {}", short(h401.lines().find(|l| l.to_ascii_lowercase().starts_with("www-authenticate")).unwrap_or(""), 80), short(&b401, 80));

        // 1) initialize
        let (o, _) = curl(&base(vec!["-H".into(), auth.clone(), "-d".into(), INIT_BODY.into()]));
        let (c1, h1, b1) = split(&o);
        let sid = h1.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim().eq_ignore_ascii_case("mcp-session-id").then(|| v.trim().to_string())
        });
        let init = rpc_body(&b1);
        println!("  -> {c1} session={sid:?} result.serverInfo={} protocolVersion={}", init["result"]["serverInfo"], init["result"]["protocolVersion"]);
        let mut sess = vec![];
        if let Some(s) = &sid {
            sess = vec!["-H".to_string(), format!("Mcp-Session-Id: {s}")];
        }
        let pv = init["result"]["protocolVersion"].as_str().unwrap_or("2025-06-18").to_string();
        let pvh = vec!["-H".to_string(), format!("MCP-Protocol-Version: {pv}")];

        // 2) notifications/initialized
        let mut a = vec!["-H".into(), auth.clone()];
        a.extend(sess.clone());
        a.extend(pvh.clone());
        a.extend(["-d".into(), r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.into()]);
        let (o, _) = curl(&base(a));
        let (c2, _, _) = split(&o);
        println!("  -> {c2}");

        // 3) tools/list
        let mut a = vec!["-H".into(), auth.clone()];
        a.extend(sess.clone());
        a.extend(pvh.clone());
        a.extend(["-d".into(), r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#.into()]);
        let (o, _) = curl(&base(a));
        let (c3, _, b3) = split(&o);
        let list = rpc_body(&b3);
        let mut names: Vec<String> = list["result"]["tools"].as_array().map(|a| a.iter().filter_map(|t| t["name"].as_str().map(String::from)).collect()).unwrap_or_default();
        names.sort();
        let ro: Vec<(String, bool, bool)> = list["result"]["tools"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|t| {
                        (
                            t["name"].as_str().unwrap_or("").to_string(),
                            t["annotations"]["readOnlyHint"] == json!(true),
                            t["annotations"]["destructiveHint"] == json!(false),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        println!("  -> {c3} {} tools: {names:?} readOnlyHints={ro:?}", names.len());

        // 4) tools/call db_info
        let mut a = vec!["-H".into(), auth.clone()];
        a.extend(sess.clone());
        a.extend(pvh.clone());
        a.extend(["-d".into(), r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"db_info","arguments":{}}}"#.into()]);
        let (o, _) = curl(&base(a));
        let (c4, _, b4) = split(&o);
        let call = rpc_body(&b4);
        let text = call["result"]["content"][0]["text"].as_str().unwrap_or("").to_string();
        println!("  -> {c4} isError={} text: {}", call["result"]["isError"], short(&text, 200));

        // 5) tools/call with a write-like tool name -> JSON-RPC error
        let mut a = vec!["-H".into(), auth.clone()];
        a.extend(sess.clone());
        a.extend(pvh.clone());
        a.extend(["-d".into(), r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"cmd_transmit_frame","arguments":{}}}"#.into()]);
        let (o, _) = curl(&base(a));
        let (c5, _, b5) = split(&o);
        let bad = rpc_body(&b5);
        println!("  -> {c5} error={}", short(&bad["error"].to_string(), 160));

        (c401, c1, c2, c3, names, ro, c4, text, bad)
    })
    .await
    .unwrap();
    handle.shutdown().await;

    let (c401, c1, c2, c3, names, ro, c4, text, bad) = checks;
    assert_eq!(c401, 401);
    assert_eq!(c1, 200);
    assert!(c2 == 202 || c2 == 200, "initialized notification -> {c2}");
    assert_eq!(c3, 200);
    assert_eq!(
        names,
        [
            "app_status",
            "bus_status",
            "db_decode_frame",
            "db_diagnostics",
            "db_encode_frame",
            "db_get_ecu",
            "db_get_message",
            "db_info",
            "db_list",
            "db_search_signals",
            "debug_events_query",
            "device_list",
            "diag_conversation",
            "diag_isotp_frames",
            "diag_passive_discovery",
            "diag_session_info",
            "driver_probe",
            "flowlib_get",
            "flowlib_list",
            "live_message_table",
            "live_signal_values",
            "live_trace_window",
            "periodic_tx_list",
            "project_get",
            "project_list",
            "re_correlate",
            "re_dbc_generate",
            "re_row_detail",
            "re_scan_results",
            "re_series",
            "re_status",
            "run_latest",
            "run_query",
            "signal_stats",
            "trace_compare",
            "trace_list",
            "trace_query",
            "trace_signal_series",
            "trace_summary",
            "ui_confirm",
            "ui_get_state",
            "ui_navigate",
            "ui_notify",
            "ui_plot_signals",
            "ui_select_message",
            "ui_trace_filter",
        ]
    );
    assert_eq!(names.len(), 46);
    for (n, read_only, not_destructive) in &ro {
        if n.starts_with("ui_") && n != "ui_get_state" {
            assert!(!read_only, "{n}: readOnlyHint must be false");
            assert!(*not_destructive, "{n}: destructiveHint must be false");
        } else {
            assert!(read_only, "{n}: readOnlyHint must be true");
        }
    }
    assert_eq!(c4, 200);
    assert!(text.contains("\"loaded\":true"), "{text}");
    assert!(
        bad.get("error").is_some() || bad["result"]["isError"] == json!(true),
        "{bad}"
    );
}

/// BUG MCP-QA-01 reproduction: tool *error* responses are not passed through `enforce_cap`, and
/// several error messages echo the caller's input verbatim, so a 200 KB argument yields a
/// 200 KB error response (cap is 16 KB). Fixed: errors are clipped and capped.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn qa_bug_error_responses_respect_the_16kb_cap() {
    let engine = engine_qa("errcap", QA_DBC);
    let handle = nexus_mcp::start(
        Arc::clone(&engine),
        McpConfig { port: 0 },
        &tokio::runtime::Handle::current(),
    )
    .expect("start");
    let client = connect(&handle).await;
    let huge_id = "1".repeat(200_000);
    let huge_name = format!("{}.log", "a".repeat(200_000));
    let huge_sig = "S".repeat(200_000);
    let cases: Vec<(&str, &str, Value)> = vec![
        (
            "db_decode_frame 200KB arb_id",
            "db_decode_frame",
            json!({"arb_id":huge_id,"data_hex":"00"}),
        ),
        (
            "db_get_message 200KB id",
            "db_get_message",
            json!({"id":huge_id}),
        ),
        (
            "db_get_message 200KB name",
            "db_get_message",
            json!({"name":huge_sig}),
        ),
        (
            "trace_query 200KB file_name",
            "trace_query",
            json!({"file_name":huge_name}),
        ),
        (
            "trace_signal_series 200KB signal",
            "trace_signal_series",
            json!({"file_name":BIG_TRACE,"signal":huge_sig}),
        ),
    ];
    let mut failures = Vec::new();
    for (name, tool, args) in cases {
        let (err, text, _) = call_raw(&client, tool, args).await.expect(name);
        println!("[errcap] {name:<34} err={err} {} B", text.len());
        if text.len() > MAX_RESPONSE_BYTES {
            failures.push(format!("{name}: {} B > {MAX_RESPONSE_BYTES} B", text.len()));
        }
    }
    let _ = client.cancel().await;
    handle.shutdown().await;
    assert!(
        failures.is_empty(),
        "error responses over cap:\n{}",
        failures.join("\n")
    );
}

fn rss_kib() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmRSS:"))
                .and_then(|l| l.split_whitespace().nth(1)?.parse().ok())
        })
        .unwrap_or(0)
}

/// Measurement (Linux): resident memory retained by the MCP trace cache for a 100k-frame trace.
#[test]
#[ignore = "measurement: run with --release --ignored --nocapture"]
fn qa_measure_trace_cache_memory_100k() {
    let engine = engine_qa("rss", QA_DBC);
    let cache = nexus_mcp::tools_trace::TraceCache::default();
    let before = rss_kib();
    let t0 = Instant::now();
    let trace = cache.load(&engine, BIG_TRACE).expect("load");
    let el = t0.elapsed();
    let after = rss_kib();
    println!(
        "[rss] {} frames parsed+cached in {:.1} ms; RSS +{} KiB (~{} B/frame), struct size {} B",
        trace.frames.len(),
        el.as_secs_f64() * 1e3,
        after.saturating_sub(before),
        after.saturating_sub(before) * 1024 / trace.frames.len().max(1) as u64,
        std::mem::size_of::<nexus_hal::dto::ChronologicalFrameDto>()
    );
}

// ─── Re-gate after MCP-QA-01..04 fixes (independent reproductions) ─────────

/// QA-01 follow-up: argument *type* errors are produced by rmcp/serde before our handler runs
/// (`failed to deserialize parameters: invalid type: string "..."`). They must not echo a
/// 200 KB argument either.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn qa_regate_schema_errors_do_not_echo_huge_arguments() {
    let engine = engine_qa("schemaecho", QA_DBC);
    let handle = nexus_mcp::start(
        Arc::clone(&engine),
        McpConfig { port: 0 },
        &tokio::runtime::Handle::current(),
    )
    .expect("start");
    let client = connect(&handle).await;
    let huge = "A".repeat(200_000);
    let cases: Vec<(&str, &str, Value)> = vec![
        (
            "search limit=200KB string",
            "db_search_signals",
            json!({"query":"e","limit":huge}),
        ),
        (
            "decode is_extended=200KB string",
            "db_decode_frame",
            json!({"arb_id":"0x1A0","is_extended":huge,"data_hex":"00"}),
        ),
        (
            "query cursor=200KB string",
            "trace_query",
            json!({"file_name":BIG_TRACE,"cursor":huge}),
        ),
        (
            "query arb_ids=[200KB]",
            "trace_query",
            json!({"file_name":BIG_TRACE,"arb_ids":[huge]}),
        ),
        (
            "decode data_hex=200KB",
            "db_decode_frame",
            json!({"arb_id":"0x1A0","data_hex":huge}),
        ),
        (
            "search query=200KB",
            "db_search_signals",
            json!({"query":huge}),
        ),
    ];
    let mut failures = Vec::new();
    for (name, tool, args) in cases {
        let (bytes, kind) = match call_raw(&client, tool, args).await {
            Ok((e, t, _)) => (t.len(), if e { "err" } else { "ok" }),
            Err(e) => (e.len(), "proto"),
        };
        println!("[schema-echo] {name:<34} {kind:<5} {bytes} B");
        if bytes > MAX_RESPONSE_BYTES {
            failures.push(format!("{name}: {bytes} B > cap"));
        }
    }
    let unknown = "x".repeat(200_000);
    let r = call_raw(&client, &unknown, json!({})).await;
    let n = match &r {
        Ok((_, t, _)) => t.len(),
        Err(e) => e.len(),
    };
    println!("[schema-echo] unknown 200KB tool name -> {n} B");
    if n > MAX_RESPONSE_BYTES {
        failures.push(format!("unknown tool name echo: {n} B"));
    }
    let _ = client.cancel().await;
    handle.shutdown().await;
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// QA-03 follow-up: the periodic flush task writes the summary without a stop; after stop,
/// neither the flush task nor sessions keep the engine alive (no leak).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn qa_regate_periodic_flush_and_no_leak_after_stop() {
    let engine = engine_qa("flushleak", QA_DBC);
    let handle = nexus_mcp::start(
        Arc::clone(&engine),
        McpConfig { port: 0 },
        &tokio::runtime::Handle::current(),
    )
    .expect("start");
    let client = connect(&handle).await;
    for _ in 0..40 {
        let _ = call_raw(
            &client,
            "db_decode_frame",
            json!({"arb_id":"0x1A0","data_hex":"zz"}),
        )
        .await
        .unwrap();
    }
    // Window (1 s) + flush interval (2 s) + slack, server still running.
    tokio::time::sleep(Duration::from_millis(4_300)).await;
    let summaries: Vec<_> = engine
        .snapshot_debug_events()
        .events
        .into_iter()
        .filter(|e| e.action == "mcp.tool_calls_suppressed")
        .collect();
    println!(
        "[flush] summaries before stop: {:?}",
        summaries
            .iter()
            .map(|e| (&e.severity, &e.title, &e.details))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        summaries.len(),
        1,
        "periodic flush must emit exactly one summary"
    );
    assert!(summaries[0].title.starts_with("MCP: 30 tool calls"));
    assert_eq!(
        summaries[0].severity, "warn",
        "suppressed errors must raise severity"
    );
    assert!(summaries[0]
        .details
        .as_deref()
        .is_some_and(|d| d.contains("errors=30")));

    let _ = client.cancel().await;
    handle.shutdown().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let strong = Arc::strong_count(&engine);
    println!("[leak] Arc<PipelineEngine> strong_count after shutdown = {strong}");
    assert_eq!(
        strong, 1,
        "flush task / sessions still hold the engine after stop"
    );
    // Nothing is recorded after stop.
    let n_before = engine.snapshot_debug_events().events.len();
    tokio::time::sleep(Duration::from_millis(2_300)).await;
    assert_eq!(engine.snapshot_debug_events().events.len(), n_before);
}

/// QA-02 follow-up with real sizes: 1.2M-frame trace is served but not retained; two 600k
/// traces never exceed the 1M budget together. Release only (parses ~2.4M frames).
#[test]
#[ignore = "measurement: run with --release --ignored --nocapture"]
fn qa_regate_one_million_frame_budget_real_traces() {
    let root = DataRoot::under(temp_root("budget1m"));
    root.ensure_dirs().unwrap();
    let mk = |name: &str, n: u64| {
        let mut s = String::with_capacity(n as usize * 40);
        for i in 0..n {
            let us = 1_000_000 + i * 50;
            s.push_str(&format!(
                "({}.{:06}) can0 1A0#0102030405060708\n",
                us / 1_000_000,
                us % 1_000_000
            ));
        }
        std::fs::write(root.traces_dir().join(name), s).unwrap();
    };
    mk("over_1200k.log", 1_200_000);
    mk("a_600k.log", 600_000);
    mk("b_600k.log", 600_000);
    let engine = PipelineEngine::with_data_root(DriverRegistry::new(), root);
    let cache = nexus_mcp::tools_trace::TraceCache::default();
    let r0 = rss_kib();
    let t = Instant::now();
    let over = cache.load(&engine, "over_1200k.log").unwrap();
    println!(
        "[1M] over: {} frames in {:.0} ms, stats {:?}",
        over.frames.len(),
        t.elapsed().as_secs_f64() * 1e3,
        cache.stats()
    );
    assert_eq!(cache.stats().cached_frames, 0);
    drop(over);
    let r1 = rss_kib();
    cache.load(&engine, "a_600k.log").unwrap();
    assert_eq!(cache.stats().cached_frames, 600_000);
    cache.load(&engine, "b_600k.log").unwrap();
    let st = cache.stats();
    println!(
        "[1M] after a+b: {st:?}; RSS start {r0} KiB, after over dropped {r1} KiB, now {} KiB",
        rss_kib()
    );
    assert_eq!(
        (st.entries, st.cached_frames),
        (1, 600_000),
        "a must be evicted"
    );
    let p = st.parses;
    cache.load(&engine, "b_600k.log").unwrap();
    assert_eq!(cache.stats().parses, p, "b cached");
    cache.load(&engine, "over_1200k.log").unwrap();
    assert_eq!(cache.stats().parses, p + 1, "over-budget re-parsed");
    assert_eq!(
        cache.stats().cached_frames,
        600_000,
        "over-budget did not evict b"
    );
}
