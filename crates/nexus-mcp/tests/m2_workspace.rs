//! MCP M2 workspace tools (`project_list`, `project_get`, `trace_compare`,
//! `debug_events_query`): happy + error paths, direct and over Streamable HTTP.

use base64::Engine as _;
use nexus_hal::pipeline::PipelineEngine;
use nexus_hal::registry::DriverRegistry;
use nexus_hal::storage::DataRoot;
use nexus_mcp::dbsel::DbSet;
use nexus_mcp::tools_trace::TraceCache;
use nexus_mcp::tools_workspace::{self, DebugQuery};
use nexus_mcp::util::MAX_RESPONSE_BYTES;
use nexus_mcp::McpConfig;
use rmcp::model::{CallToolRequestParams, ClientConfig};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const DBC: &str = r#"VERSION "1"

BU_: VCU BMS

BO_ 416 VehicleStatus: 8 VCU
 SG_ Speed : 0|16@1+ (0.1,0) [0|300] "km/h" BMS

BO_ 2566848512 BmsFd: 64 BMS
 SG_ PackTemp : 496|8@1+ (0.1,0) [0|100] "degC" VCU
"#;

const TRACE_A: &str = "base.log";
const TRACE_B: &str = "other.log";

fn engine(tag: &str) -> Arc<PipelineEngine> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let root = DataRoot::under(std::env::temp_dir().join(format!(
        "nexus-mcp-m2ws-{tag}-{}-{nanos}",
        std::process::id()
    )));
    root.ensure_dirs().unwrap();
    Arc::new(PipelineEngine::with_data_root(DriverRegistry::new(), root))
}

fn load_db(e: &PipelineEngine) {
    let b64 = base64::engine::general_purpose::STANDARD.encode(DBC);
    e.cmd_load_database_content("ws.dbc".into(), b64, false)
        .expect("load dbc");
}

/// candump log: `(sec.usec) can0 ID#DATA` / `ID##<flags><DATA>` for CAN-FD.
fn candump(lines: &[(u64, String)]) -> String {
    let base = 1_700_000_000u64 * 1_000_000;
    lines
        .iter()
        .map(|(t, body)| {
            let abs = base + t;
            format!("({}.{:06}) can0 {body}\n", abs / 1_000_000, abs % 1_000_000)
        })
        .collect()
}

fn fd_body(temp_raw: u8) -> String {
    let mut d = [0u8; 64];
    d[62] = temp_raw;
    let hex: String = d.iter().map(|b| format!("{b:02X}")).collect();
    format!("18FF0000##1{hex}")
}

/// A: 0x1A0 @100 Hz (speed 0..9.9), 0x100 standard, 0x18FF0000 FD (temp 20.0), 1 s.
/// B: 0x1A0 @50 Hz (speed up to 19.8), DLC 4 on 0x7DF, extended 0x00000100 (NOT std 0x100),
///    0x18FF0000 FD (temp 30.0), 1 s.
fn save_traces(e: &PipelineEngine) {
    let mut a = Vec::new();
    let mut b = Vec::new();
    for i in 0..100u64 {
        let raw = i as u16;
        let [s0, s1] = raw.to_le_bytes();
        a.push((i * 10_000, format!("1A0#{s0:02X}{s1:02X}000000000000")));
        a.push((i * 10_000 + 1, "7DF#0201000000000000".to_string()));
    }
    for i in 0..10u64 {
        a.push((i * 100_000 + 2, "100#11".to_string()));
        a.push((i * 100_000 + 3, fd_body(200)));
    }
    a.push((990_000, "1A0#0000000000000000".to_string()));
    a.sort_by_key(|x| x.0);
    for i in 0..50u64 {
        let raw = (i * 4) as u16;
        let [s0, s1] = raw.to_le_bytes();
        b.push((i * 20_000, format!("1A0#{s0:02X}{s1:02X}000000000000")));
        b.push((i * 20_000 + 1, "7DF#02010000".to_string()));
    }
    for i in 0..10u64 {
        b.push((i * 100_000 + 2, "00000100#11".to_string()));
        b.push((i * 100_000 + 3, fd_body(44)));
    }
    b.push((990_000, "1A0#0000000000000000".to_string()));
    b.sort_by_key(|x| x.0);
    e.cmd_save_trace_file(TRACE_A.into(), Some(candump(&a)), None)
        .expect("save a");
    e.cmd_save_trace_file(TRACE_B.into(), Some(candump(&b)), None)
        .expect("save b");
}

fn save_project(e: &PipelineEngine) {
    let blob = "QUFB".repeat(5_000); // must never be echoed
    let p = json!({
        "version": 1,
        "name": "Bench EV",
        "fileStem": "bench-ev",
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-02-01T00:00:00Z",
        "notes": "x".repeat(2_000),
        "databases": { "usePresetDb": false, "customFiles": [
            { "fileName": "ev.dbc", "contentBase64": blob, "sizeBytes": 15000 }
        ]},
        "connections": { "profiles": [
            { "id": "p1", "name": "Main", "busId": 0, "driverFamily": "socketcan",
              "deviceId": "vcan0", "bitrate": 500000, "enableFd": true, "dataBitrate": 2000000,
              "listenOnly": true, "databaseIds": ["db:ev.dbc"] },
            { "id": "p2", "name": "Mock", "busId": 1, "driverFamily": "mock",
              "deviceId": "mock0", "bitrate": 500000, "enableFd": false, "dataBitrate": 0,
              "listenOnly": true, "databaseIds": [] }
        ], "activeConnectedProfileIds": ["p1"], "quickBarState": {} },
        "transmitList": { "entries": [{}, {}, {}] },
        "plotter": { "watchedSignals": [{}, {}] },
        "simulationPanels": [{}],
        "workspace": { "activeDocTab": "trace", "theme": "dark", "expandedRxKeys": [] }
    });
    e.cmd_save_project("bench-ev".into(), p.to_string())
        .expect("save project");
}

fn cap_ok(v: &Value) {
    assert!(serde_json::to_string(v).unwrap().len() <= MAX_RESPONSE_BYTES);
}

#[test]
fn project_list_and_get() {
    let e = engine("proj");
    let empty = tools_workspace::project_list(&e).unwrap();
    assert_eq!(empty["count"], 0);
    save_project(&e);
    let l = tools_workspace::project_list(&e).unwrap();
    assert_eq!(l["count"], 1);
    assert_eq!(l["projects"][0]["file_stem"], "bench-ev");
    assert_eq!(l["projects"][0]["name"], "Bench EV");

    for key in ["bench-ev", "bench ev", "BENCH EV"] {
        let g = tools_workspace::project_get(&e, key).unwrap();
        cap_ok(&g);
        assert_eq!(g["file_stem"], "bench-ev");
        assert_eq!(g["buses"], json!([0, 1]));
        assert_eq!(g["connection_profiles_total"], 2);
        assert_eq!(g["connection_profiles"][0]["listen_only"], true);
        assert_eq!(
            g["connection_profiles"][0]["database_ids"],
            json!(["db:ev.dbc"])
        );
        assert_eq!(g["databases"]["custom_files"][0]["file_name"], "ev.dbc");
        assert_eq!(g["counts"]["transmit_list_entries"], 3);
        assert_eq!(g["counts"]["simulation_panels"], 1);
        assert!(g["notes"].as_str().unwrap().chars().count() <= 301); // 300 + "…"
        assert!(!g.to_string().contains("QUFB"), "no raw DB content");
    }
}

#[test]
fn project_get_errors() {
    let e = engine("projerr");
    save_project(&e);
    let err = tools_workspace::project_get(&e, "  ").unwrap_err();
    assert!(err.0.contains("empty"));
    let long = format!("../{}", "a".repeat(5_000));
    let err = tools_workspace::project_get(&e, &long).unwrap_err();
    assert!(
        err.0.contains("not found") && err.0.len() <= 512,
        "{}",
        err.0
    );
    assert!(err.0.contains("bench-ev"), "lists available projects");
    let err = tools_workspace::project_get(&e, "../../etc/passwd").unwrap_err();
    assert!(err.0.contains("not found"));
}

#[test]
fn trace_compare_reports_differences() {
    let e = engine("cmp");
    save_traces(&e);
    load_db(&e);
    let cache = TraceCache::default();
    let a = cache.load(&e, TRACE_A).unwrap();
    let b = cache.load(&e, TRACE_B).unwrap();
    let set = DbSet::from_engine(&e);
    let v = tools_workspace::trace_compare(&a, &b, &set, 20).unwrap();
    cap_ok(&v);
    assert_eq!(v["database_loaded"], true);
    // Standard 0x100 only in A, extended 0x00000100 only in B (extended flag respected).
    assert_eq!(v["only_in_a_total"], 1);
    assert_eq!(v["only_in_a"][0]["arb_id"], "0x100");
    assert_eq!(v["only_in_a"][0]["is_extended"], false);
    assert_eq!(v["only_in_b_total"], 1);
    assert_eq!(v["only_in_b"][0]["arb_id"], "0x00000100");
    assert_eq!(v["only_in_b"][0]["is_extended"], true);
    // 0x7DF and 0x1A0 rates halve (~-50 %).
    let rates = v["rate_changes"].as_array().unwrap();
    let r1a0 = rates.iter().find(|r| r["arb_id"] == "0x1A0").unwrap();
    assert_eq!(r1a0["message"], "VehicleStatus");
    let pct = r1a0["change_pct"].as_f64().unwrap();
    assert!((-52.0..=-48.0).contains(&pct), "{pct}");
    // DLC 8 -> 4 on 0x7DF.
    let dlc = v["dlc_changes"].as_array().unwrap();
    assert_eq!(dlc.len(), 1);
    assert_eq!(dlc[0]["arb_id"], "0x7DF");
    assert_eq!(
        (dlc[0]["dlc_a"].as_u64(), dlc[0]["dlc_b"].as_u64()),
        (Some(8), Some(4))
    );
    // Signal ranges: Speed max 9.9 -> 19.6, CAN-FD PackTemp (byte 62) 20.0 -> 4.4.
    let sigs = v["signal_changes"].as_array().unwrap();
    let speed = sigs.iter().find(|s| s["signal"] == "Speed").unwrap();
    assert!((speed["max_a"].as_f64().unwrap() - 9.9).abs() < 1e-6);
    assert!((speed["max_b"].as_f64().unwrap() - 19.6).abs() < 1e-6);
    let temp = sigs.iter().find(|s| s["signal"] == "PackTemp").unwrap();
    assert!((temp["min_a"].as_f64().unwrap() - 20.0).abs() < 1e-6);
    assert!((temp["min_b"].as_f64().unwrap() - 4.4).abs() < 1e-6);

    // top_n clamps (1) and no-DB mode.
    let e2 = engine("cmp-nodb");
    let set2 = DbSet::from_engine(&e2);
    let v2 = tools_workspace::trace_compare(&a, &b, &set2, 0).unwrap();
    assert_eq!(v2["database_loaded"], false);
    assert_eq!(v2["rate_changes"].as_array().unwrap().len(), 1);
    assert!(v2["signal_changes"].as_array().unwrap().is_empty());
    let v3 = tools_workspace::trace_compare(&a, &b, &set, 10_000).unwrap();
    assert!(v3["rate_changes"].as_array().unwrap().len() <= 50);
    // Identical traces: nothing differs.
    let same = tools_workspace::trace_compare(&a, &a, &set, 20).unwrap();
    assert_eq!(same["only_in_a_total"], 0);
    assert_eq!(same["signal_changes_total"], 0);
    assert_eq!(same["dlc_changes_total"], 0);
}

#[test]
fn debug_events_query_filters() {
    let e = engine("dbg");
    let hub = e.debug_hub();
    hub.record(
        "info",
        "CONN",
        "backend",
        Some(0),
        "conn.open",
        "Opened vcan0",
        None,
    );
    hub.record(
        "error",
        "BUS_ERR",
        "backend",
        Some(1),
        "bus.off",
        "Bus 2 BUS-OFF",
        Some("TEC=255".into()),
    );
    hub.record(
        "warn",
        "MCP",
        "mcp",
        None,
        "mcp.tool_call",
        "MCP tool call #1",
        None,
    );
    hub.record(
        "warn",
        "TX",
        "backend",
        Some(0),
        "tx.rate",
        "TX rate limited",
        None,
    );

    let all = tools_workspace::debug_events_query(&e, &DebugQuery::default()).unwrap();
    let evs = all["events"].as_array().unwrap();
    assert!(
        evs.iter().all(|x| x["source"] != "mcp"),
        "MCP audit excluded"
    );
    assert_eq!(evs[0]["title"], "TX rate limited", "newest first");

    let q = |q: DebugQuery| tools_workspace::debug_events_query(&e, &q).unwrap();
    let errs = q(DebugQuery {
        level: Some("ERROR".into()),
        ..Default::default()
    });
    assert_eq!(errs["matched_total"], 1);
    assert_eq!(errs["events"][0]["details"], "TEC=255");
    let warn = q(DebugQuery {
        level: Some("warning".into()),
        ..Default::default()
    });
    assert_eq!(warn["matched_total"], 1);
    let mcp = q(DebugQuery {
        category: Some("mcp".into()),
        ..Default::default()
    });
    assert_eq!(mcp["matched_total"], 1);
    let txt = q(DebugQuery {
        text: Some("tec=".into()),
        since_ms: Some(60_000),
        ..Default::default()
    });
    assert_eq!(txt["matched_total"], 1);
    let lim = q(DebugQuery {
        limit: Some(1),
        include_mcp: Some(true),
        ..Default::default()
    });
    assert_eq!(lim["returned"], 1);
    assert!(lim["matched_total"].as_u64().unwrap() >= 4);

    let err = tools_workspace::debug_events_query(
        &e,
        &DebugQuery {
            level: Some("x".repeat(5_000)),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(err.0.contains("invalid level") && err.0.len() <= 512);
    let err = tools_workspace::debug_events_query(
        &e,
        &DebugQuery {
            text: Some("y".repeat(500)),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(err.0.contains("too long"));
}

#[test]
fn debug_events_query_respects_cap() {
    let e = engine("dbgcap");
    for i in 0..300 {
        e.debug_hub().record(
            "info",
            "TRACE",
            "backend",
            None,
            "t",
            format!("event {i} {}", "z".repeat(150)),
            Some("d".repeat(1_000)),
        );
    }
    let v = tools_workspace::debug_events_query(
        &e,
        &DebugQuery {
            limit: Some(1_000),
            ..Default::default()
        },
    )
    .unwrap();
    cap_ok(&v);
    assert!(v["returned"].as_u64().unwrap() <= 100);
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
    let text = &r.content[0].as_text().expect("text").text;
    assert!(text.len() <= MAX_RESPONSE_BYTES);
    (
        r.is_error == Some(true),
        serde_json::from_str(text).expect("json"),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn e2e_workspace_tools() {
    let e = engine("e2e");
    save_traces(&e);
    load_db(&e);
    save_project(&e);
    let handle = nexus_mcp::start(
        Arc::clone(&e),
        McpConfig { port: 0 },
        &tokio::runtime::Handle::current(),
    )
    .expect("start");
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(handle.endpoint_url())
            .auth_header(handle.token().to_string()),
    );
    let client = ClientConfig::default()
        .serve(transport)
        .await
        .expect("init");
    let tools = client.list_all_tools().await.expect("tools/list");
    for n in [
        "project_list",
        "project_get",
        "trace_compare",
        "debug_events_query",
    ] {
        let t = tools.iter().find(|t| t.name == n).expect(n);
        assert_eq!(
            t.annotations.as_ref().and_then(|a| a.read_only_hint),
            Some(true),
            "{n}"
        );
        assert!(t
            .description
            .as_ref()
            .is_some_and(|d| d.contains("does NOT")));
    }

    let (err, v) = call(&client, "project_list", json!({})).await;
    assert!(!err && v["count"] == 1);
    let (err, v) = call(&client, "project_get", json!({ "name": "bench-ev" })).await;
    assert!(!err && v["buses"] == json!([0, 1]));
    let (err, v) = call(&client, "project_get", json!({ "name": "nope" })).await;
    assert!(err && v["error"].as_str().unwrap().contains("not found"));

    let (err, v) = call(
        &client,
        "trace_compare",
        json!({ "a": TRACE_A, "b": TRACE_B, "top_n": 5 }),
    )
    .await;
    assert!(!err, "{v}");
    assert_eq!(v["only_in_b"][0]["arb_id"], "0x00000100");
    let (err, v) = call(
        &client,
        "trace_compare",
        json!({ "a": TRACE_A, "b": "../../etc/passwd" }),
    )
    .await;
    assert!(err && v["error"].as_str().unwrap().contains("not found"));

    let (err, v) = call(
        &client,
        "debug_events_query",
        json!({ "category": "MCP", "limit": 100 }),
    )
    .await;
    assert!(!err);
    assert!(v["matched_total"].as_u64().unwrap() >= 1, "audit recorded");
    let (err, _) = call(&client, "debug_events_query", json!({ "level": "loud" })).await;
    assert!(err);

    client.cancel().await.ok();
    handle.shutdown().await;
}
