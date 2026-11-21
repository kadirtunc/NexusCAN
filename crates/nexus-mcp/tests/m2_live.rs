//! MCP M2 backend-A: live-data tools. Happy paths run against the real `PipelineEngine` with
//! `mock0` (no snapshot test hook needed: the aggregator publishes 60 Hz snapshots on its own);
//! offline paths use a fresh engine without a bus (`live: false`) or invalid arguments.

use nexus_hal::dto::DriverProbeReportDto;
use nexus_hal::pipeline::PipelineEngine;
use nexus_hal::registry::DriverRegistry;
use nexus_hal::storage::DataRoot;
use nexus_hal::{ChannelConfigDto, MOCK0_DEVICE_ID};
use nexus_mcp::dbsel::DbSet;
use nexus_mcp::tools_live::{self as tl, LiveMessageTableArgs, LiveTraceWindowArgs, McpFacts};
use nexus_mcp::McpConfig;
use rmcp::model::{CallToolRequestParams, ClientConfig};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn engine(tag: &str) -> Arc<PipelineEngine> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let root = DataRoot::under(std::env::temp_dir().join(format!(
        "nexus-mcp-m2live-{tag}-{}-{nanos}",
        std::process::id()
    )));
    root.ensure_dirs().unwrap();
    Arc::new(PipelineEngine::with_data_root(
        DriverRegistry::with_builtin_drivers(),
        root,
    ))
}

/// Engine with the preset DB and mock0 on bus 0 (nominal ECU schedule), warmed up.
fn live_engine(tag: &str, listen_only: bool) -> Arc<PipelineEngine> {
    let e = engine(tag);
    e.cmd_load_preset_databases().expect("preset db");
    e.cmd_connect_bus(
        MOCK0_DEVICE_ID.to_string(),
        ChannelConfigDto {
            bus_id: 0,
            listen_only,
            mock_fps_preset: Some(475),
            ..ChannelConfigDto::default()
        },
    )
    .expect("connect mock0");
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(3) {
        if e.latest_snapshot().is_some_and(|s| {
            s.frames
                .iter()
                .any(|f| f.arb_id == 0x101 && !f.signals.is_empty())
        }) {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    e
}

fn names(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn assert_offline(v: &Value) {
    assert_eq!(v["live"], json!(false), "{v}");
    assert!(v["message"].as_str().unwrap().contains("no bus"), "{v}");
}

fn wait_fresh(e: &PipelineEngine) {
    // Snapshot of a fresh engine exists after the first 60 Hz tick.
    let t = Instant::now();
    while e.latest_snapshot().is_none() && t.elapsed() < Duration::from_secs(1) {
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn app_status_live_and_offline() {
    let e = live_engine("app", true);
    let v = tl::app_status(
        &e,
        McpFacts {
            total_calls: 3,
            ui_attached: false,
        },
    )
    .unwrap();
    assert_eq!(v["live"], json!(true), "{v}");
    assert_eq!(v["buses"][0]["mode"], json!("listen_only"));
    assert_eq!(v["buses"][0]["database"]["scope"], json!("global"));
    assert_eq!(v["mcp"]["total_calls"], json!(3));
    assert!(v["telemetry"]["total_frames_rx"].as_u64().unwrap() > 0);
    assert_eq!(v["tx_panic_latched"], json!(false));

    let off = engine("app-off");
    let v = tl::app_status(&off, McpFacts::default()).unwrap();
    assert_eq!(v["live"], json!(false));
    assert_eq!(v["databases"]["global"], Value::Null);
}

#[test]
fn device_list_and_bad_filter() {
    let e = engine("dev");
    let v = tl::device_list(&e, None).unwrap();
    assert!(v["devices"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["device_id"] == json!(MOCK0_DEVICE_ID)));
    let v = tl::device_list(&e, Some("MOCK")).unwrap();
    assert!(v["devices"]
        .as_array()
        .unwrap()
        .iter()
        .all(|d| d["driver_id"] == json!("mock")));
    let err = tl::device_list(&e, Some(&"x/".repeat(200))).unwrap_err().0;
    assert!(
        err.contains("invalid driver_id") && err.chars().count() < 200,
        "{err}"
    );
}

#[test]
fn driver_probe_compact_and_unknown_family() {
    let mut report = DriverProbeReportDto {
        host_os: "linux".into(),
        ..Default::default()
    };
    report.families.push(nexus_hal::dto::DriverFamilyStatusDto {
        family_id: "socketcan".into(),
        installed: true,
        setup_steps: vec![nexus_hal::dto::OsSetupStepDto {
            title: "modprobe".into(),
            ..Default::default()
        }],
        ..Default::default()
    });
    let v = tl::driver_probe_from(&report, Some("socketcan")).unwrap();
    assert_eq!(v["families"][0]["installed"], json!(true));
    assert_eq!(
        v["families"][0]["setup_steps"][0]["title"],
        json!("modprobe")
    );
    let all = tl::driver_probe_from(&report, None).unwrap();
    assert!(all["families"][0].get("setup_steps").is_none());
    let err = tl::driver_probe_from(&report, Some("nope")).unwrap_err().0;
    assert!(err.contains("available: socketcan"), "{err}");
    // Real probe on this host stays under the cap.
    let e = engine("probe");
    let v = tl::driver_probe(&e, None).unwrap();
    assert!(serde_json::to_string(&v).unwrap().len() <= 16 * 1024);
    assert!(tl::driver_probe(&e, Some("bad family!")).is_err());
}

#[test]
fn bus_status_live_offline_and_unknown_bus() {
    let e = live_engine("bus", true);
    let v = tl::bus_status(&e, None).unwrap();
    assert_eq!(v["live"], json!(true));
    let b = &v["buses"][0];
    assert_eq!(b["mode"], json!("listen_only"));
    assert_eq!(b["listen_only_enforcement"], json!("virtual"));
    assert!(b["rx_message_ids"].as_u64().unwrap() > 0);
    let err = tl::bus_status(&e, Some(7)).unwrap_err().0;
    assert!(err.contains("bus 7 is not connected"), "{err}");

    let off = engine("bus-off");
    wait_fresh(&off);
    assert_offline(&tl::bus_status(&off, None).unwrap());
}

#[test]
fn live_message_table_live_offline_and_bad_ids() {
    let e = live_engine("tbl", true);
    let a = LiveMessageTableArgs {
        ids: Some(names(&["0x101", "0x000001A0"])),
        sort: Some(tl::TableSort::Id),
        ..Default::default()
    };
    let v = tl::live_message_table(&e, &a).unwrap();
    let rows = v["messages"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{v}");
    assert_eq!(rows[0]["id"], json!("0x101"));
    assert_eq!(rows[0]["name"], json!("INV_MotorStatus"));
    assert!(rows[0]["count"].as_u64().unwrap() > 0);
    let all = tl::live_message_table(
        &e,
        &LiveMessageTableArgs {
            limit: Some(1000),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(all["returned"].as_u64().unwrap() <= 100);
    let bad = LiveMessageTableArgs {
        ids: Some(names(&["zz"])),
        ..Default::default()
    };
    assert!(tl::live_message_table(&e, &bad).is_err());

    let off = engine("tbl-off");
    wait_fresh(&off);
    assert_offline(&tl::live_message_table(&off, &LiveMessageTableArgs::default()).unwrap());
}

#[test]
fn live_signal_values_live_offline_and_errors() {
    let e = live_engine("sig", true);
    let v = tl::live_signal_values(&e, &names(&["MotorSpeedRpm", "NoSuchSignal"]), None).unwrap();
    assert_eq!(v["live"], json!(true));
    assert_eq!(v["values"][0]["name"], json!("MotorSpeedRpm"));
    assert_eq!(v["values"][0]["unit"], json!("rpm"));
    assert!(v["values"][0]["physical"].is_number());
    assert_eq!(v["unavailable"][0]["name"], json!("NoSuchSignal"));
    assert!(tl::live_signal_values(&e, &[], None).is_err());
    assert!(tl::live_signal_values(&e, &vec!["a".to_string(); 33], None).is_err());

    // Offline: database present but no bus -> live:false (not an error).
    let off = engine("sig-off");
    off.cmd_load_preset_databases().unwrap();
    wait_fresh(&off);
    let set = DbSet::from_engine(&off);
    let snap = off.latest_snapshot();
    assert_offline(
        &tl::live_signal_values_from(snap.as_ref(), &set, &names(&["MotorSpeedRpm"]), None)
            .unwrap(),
    );
    // No database at all -> explicit error.
    let nodb = engine("sig-nodb");
    assert!(tl::live_signal_values(&nodb, &names(&["X"]), None).is_err());
}

#[test]
fn periodic_tx_list_with_job_and_empty() {
    let e = live_engine("ptx", false);
    e.cmd_arm_active_bus(0, true).expect("arm");
    e.cmd_transmit_raw_frame(
        0,
        0x6AB,
        false,
        false,
        false,
        vec![1, 2],
        Some(50),
        Some("job".into()),
    )
    .expect("periodic job");
    let v = tl::periodic_tx_list(&e, None).unwrap();
    assert_eq!(v["count"], json!(1), "{v}");
    assert_eq!(v["jobs"][0]["id"], json!("0x6AB"));
    assert_eq!(v["jobs"][0]["interval_ms"], json!(50));
    assert_eq!(
        tl::periodic_tx_list(&e, Some(3)).unwrap()["count"],
        json!(0)
    );
    e.cmd_panic_stop_tx();

    let off = engine("ptx-off");
    let v = tl::periodic_tx_list(&off, None).unwrap();
    assert_eq!(v["count"], json!(0));
    assert_eq!(v["jobs"], json!([]));
}

#[test]
fn signal_stats_bounded_window_offline_and_errors() {
    let e = live_engine("stats", true);
    let t = Instant::now();
    let v = tl::signal_stats(&e, &names(&["MotorSpeedRpm"]), Some(300), None).unwrap();
    assert!(t.elapsed() < nexus_core::testing::scaled(Duration::from_secs(2)));
    assert_eq!(v["live"], json!(true), "{v}");
    let s = &v["signals"][0];
    assert!(s["samples"].as_u64().unwrap() >= 2, "{v}");
    assert!(s["min"].as_f64().unwrap() <= s["max"].as_f64().unwrap());
    assert!(v["snapshots_seen"].as_u64().unwrap() >= 5);
    // Window is clamped (validated without sleeping 10 s: invalid names fail first).
    assert!(tl::signal_stats(&e, &names(&["Nope"]), Some(60_000), None).is_err());
    assert!(tl::signal_stats(&e, &vec!["a".to_string(); 9], None, None).is_err());

    let off = engine("stats-off");
    off.cmd_load_preset_databases().unwrap();
    wait_fresh(&off);
    let t = Instant::now();
    assert_offline(&tl::signal_stats(&off, &names(&["MotorSpeedRpm"]), Some(5_000), None).unwrap());
    assert!(
        t.elapsed() < nexus_core::testing::scaled(Duration::from_millis(500)),
        "offline returns immediately"
    );
}

#[test]
fn live_trace_window_live_offline_and_bad_ids() {
    let e = live_engine("trc", true);
    let v = tl::live_trace_window(
        &e,
        &LiveTraceWindowArgs {
            last_ms: Some(500),
            ids: Some(names(&["0x101"])),
            limit: Some(5),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(v["live"], json!(true));
    let rows = v["frames"].as_array().unwrap();
    assert!(!rows.is_empty() && rows.len() <= 5, "{v}");
    assert!(rows.iter().all(|r| r[2] == json!("0x101")));
    assert_eq!(rows[0][0], json!(0));
    assert_eq!(rows[0][6], json!("INV_MotorStatus"));
    let bad = LiveTraceWindowArgs {
        ids: Some(names(&["0x2000_0000"])),
        ..Default::default()
    };
    assert!(tl::live_trace_window(&e, &bad).is_err());

    let off = engine("trc-off");
    wait_fresh(&off);
    assert_offline(&tl::live_trace_window(&off, &LiveTraceWindowArgs::default()).unwrap());
}

/// End-to-end: all 9 tools registered read-only; live:false and argument errors over HTTP.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn e2e_live_tools_over_mcp() {
    let e = engine("e2e");
    let handle = nexus_mcp::start(
        Arc::clone(&e),
        McpConfig { port: 0 },
        &tokio::runtime::Handle::current(),
    )
    .unwrap();
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(handle.endpoint_url())
            .auth_header(handle.token().to_string()),
    );
    let client = ClientConfig::default().serve(transport).await.unwrap();
    let tools = client.list_all_tools().await.unwrap();
    for name in [
        "app_status",
        "device_list",
        "driver_probe",
        "bus_status",
        "live_message_table",
        "live_signal_values",
        "periodic_tx_list",
        "signal_stats",
        "live_trace_window",
    ] {
        let t = tools
            .iter()
            .find(|t| t.name == name)
            .unwrap_or_else(|| panic!("{name} missing"));
        assert_eq!(
            t.annotations.as_ref().and_then(|a| a.read_only_hint),
            Some(true),
            "{name}"
        );
    }
    let call = |name: &'static str, args: Value| {
        let client = &client;
        async move {
            let mut p = CallToolRequestParams::new(name);
            if let Value::Object(m) = args {
                p = p.with_arguments(m);
            }
            let r = client.call_tool(p).await.unwrap();
            let text = &r.content[0].as_text().unwrap().text;
            assert!(text.len() <= 16 * 1024);
            (
                r.is_error == Some(true),
                serde_json::from_str::<Value>(text).unwrap(),
            )
        }
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    let (err, v) = call("bus_status", json!({})).await;
    assert!(!err);
    assert_eq!(v["live"], json!(false));
    let (err, v) = call("app_status", json!({})).await;
    assert!(!err && v["live"] == json!(false));
    let (err, v) = call("periodic_tx_list", json!({ "bus_id": "x".repeat(5000) })).await;
    assert!(err, "{v}");
    assert!(v["error"].as_str().unwrap().chars().count() <= 513);
    let (err, _) = call("signal_stats", json!({ "names": [] })).await;
    assert!(err);
    handle.shutdown().await;
}

/// MCP-QA stop: stopping the server while `signal_stats` samples releases the engine `Arc`
/// within 500 ms (sampler loops poll the stop flag).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_during_signal_stats_releases_engine() {
    let e = live_engine("stop-stats", true);
    let base = Arc::strong_count(&e);
    let handle = nexus_mcp::start(
        Arc::clone(&e),
        McpConfig { port: 0 },
        &tokio::runtime::Handle::current(),
    )
    .unwrap();
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(handle.endpoint_url())
            .auth_header(handle.token().to_string()),
    );
    let client = ClientConfig::default().serve(transport).await.unwrap();
    let mut p = CallToolRequestParams::new("signal_stats");
    if let Value::Object(m) = json!({ "names": ["MotorSpeedRpm"], "window_ms": 10000 }) {
        p = p.with_arguments(m);
    }
    let call = tokio::spawn(async move {
        let _ = client.call_tool(p).await;
        client
    });
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        Arc::strong_count(&e) > base,
        "sampler should hold the engine"
    );
    handle.stop();
    let t = Instant::now();
    while Arc::strong_count(&e) > base && t.elapsed() < Duration::from_millis(500) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        Arc::strong_count(&e),
        base,
        "engine Arc not released <=500ms"
    );
    call.abort();
}

#[test]
fn scan_cache_single_flight_and_ttl() {
    let e = engine("scan-cache");
    let cache = tl::ScanCache::default();
    let a = tl::device_list_cached(&e, None, &cache).unwrap();
    assert_eq!(a["cached"], json!(false));
    let b = tl::device_list_cached(&e, None, &cache).unwrap();
    assert_eq!(b["cached"], json!(true));
    let p1 = tl::driver_probe_cached(&e, None, &cache).unwrap();
    assert_eq!(p1["cached"], json!(false));
    assert_eq!(
        tl::driver_probe_cached(&e, None, &cache).unwrap()["cached"],
        json!(true)
    );
    std::thread::sleep(tl::SCAN_TTL + Duration::from_millis(100));
    assert_eq!(
        tl::device_list_cached(&e, None, &cache).unwrap()["cached"],
        json!(false)
    );
}
