//! QA gate "MCP M1" — hot-path isolation. mock0 @ 50 kfps through the real `PipelineEngine`
//! (RX reader -> aggregator -> StateTable -> 60 Hz snapshots), measured twice:
//!   A) MCP server off,
//!   B) MCP server on and hammered by 4 concurrent MCP clients (db_* + trace_* incl. cold
//!      100k-frame trace parses that bust the 2-entry trace cache).
//! Invariants in both phases: `dropped_frames == 0`, snapshot pacing never faster than 60 Hz,
//! RX throughput in B within 15 % of A.
//!
//! Own test binary on purpose (no CPU competition with other test binaries). Ignored by default
//! because it is a timing benchmark; run with:
//!   cargo test --release -p nexus-mcp --test qa_hotpath_mcp -- --ignored --nocapture

use nexus_hal::pipeline::PipelineEngine;
use nexus_hal::registry::DriverRegistry;
use nexus_hal::storage::DataRoot;
use nexus_hal::{ChannelConfigDto, MOCK0_DEVICE_ID};
use nexus_mcp::McpConfig;
use rmcp::model::{CallToolRequestParams, ClientConfig};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const WINDOW: Duration = Duration::from_millis(2_000);
const TRACES: [&str; 3] = ["hot_a.log", "hot_b.log", "hot_c.log"];

fn temp_root(tag: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "nexus-mcp-qa-hot-{tag}-{}-{nanos}",
        std::process::id()
    ))
}

fn trace_100k(seed: u64) -> String {
    let base = 1_700_000_000u64 * 1_000_000 + seed;
    let mut out = String::with_capacity(100_000 * 44);
    for i in 0..100_000u64 {
        let abs = base + i * 100;
        let id = 0x100 + (i % 64) as u32;
        out.push_str(&format!(
            "({}.{:06}) can0 {id:03X}#{:016X}\n",
            abs / 1_000_000,
            abs % 1_000_000,
            i.wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ));
    }
    out
}

fn engine(tag: &str) -> Arc<PipelineEngine> {
    let root = DataRoot::under(temp_root(tag));
    root.ensure_dirs().expect("data root");
    for (i, name) in TRACES.iter().enumerate() {
        std::fs::write(root.traces_dir().join(name), trace_100k(i as u64)).expect("trace");
    }
    let e = Arc::new(PipelineEngine::with_data_root(
        DriverRegistry::with_builtin_drivers(),
        root,
    ));
    e.cmd_load_preset_databases().expect("preset dbs");
    e
}

/// Fields are reported through `Debug` in the benchmark output.
#[derive(Debug)]
#[allow(dead_code)]
struct Phase {
    snapshots: usize,
    mean_interval_ms: f64,
    min_interval_ms: f64,
    max_interval_ms: f64,
    within_2ms_pct: f64,
    rx_frames: u64,
    rx_fps: f64,
    dropped: u64,
}

fn run_phase(engine: &PipelineEngine) -> Phase {
    let mut sub = engine.subscribe();
    engine
        .cmd_connect_bus(
            MOCK0_DEVICE_ID.to_string(),
            ChannelConfigDto {
                bus_id: 0,
                bitrate: 500_000,
                data_bitrate: 5_000_000,
                enable_fd: true,
                listen_only: true,
                mock_fps_preset: Some(50_000),
                ..ChannelConfigDto::default()
            },
        )
        .expect("connect mock0 50k");
    // Warm-up, then measure.
    std::thread::sleep(Duration::from_millis(200));
    while sub.try_recv().is_ok() {}
    let start = Instant::now();
    let mut snaps = Vec::new();
    while start.elapsed() < WINDOW {
        match sub.try_recv() {
            Ok(s) => snaps.push(s),
            Err(_) => std::thread::sleep(Duration::from_millis(1)),
        }
    }
    while let Ok(s) = sub.try_recv() {
        snaps.push(s);
    }
    engine.cmd_disconnect_bus(0).expect("disconnect");

    let ts: Vec<u64> = snaps.iter().map(|s| s.timestamp_us).collect();
    let iv: Vec<f64> = ts
        .windows(2)
        .map(|w| w[1].saturating_sub(w[0]) as f64 / 1e3)
        .collect();
    let first = snaps.first().expect("snapshots");
    let last = snaps.last().expect("snapshots");
    let rx = last.total_frames_rx.saturating_sub(first.total_frames_rx);
    let span_s = last.timestamp_us.saturating_sub(first.timestamp_us) as f64 / 1e6;
    Phase {
        snapshots: snaps.len(),
        mean_interval_ms: iv.iter().sum::<f64>() / iv.len().max(1) as f64,
        min_interval_ms: iv.iter().cloned().fold(f64::INFINITY, f64::min),
        max_interval_ms: iv.iter().cloned().fold(0.0, f64::max),
        within_2ms_pct: 100.0 * iv.iter().filter(|x| (**x - 16.667).abs() <= 2.0).count() as f64
            / iv.len().max(1) as f64,
        rx_frames: rx,
        rx_fps: rx as f64 / span_s.max(1e-9),
        dropped: last.dropped_frames,
    }
}

async fn hammer(
    url: String,
    token: String,
    worker: usize,
    stop: Arc<AtomicBool>,
    calls: Arc<AtomicU64>,
    max_ms: Arc<AtomicU64>,
) {
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url).auth_header(token),
    );
    let client = ClientConfig::default()
        .serve(transport)
        .await
        .expect("init");
    let mut i = 0usize;
    while !stop.load(Ordering::Relaxed) {
        let (name, args): (&str, Value) = match (worker, i % 4) {
            // worker 0: cache-busting cold trace parses (3 files, cache holds 2)
            (0, _) => (
                "trace_summary",
                json!({"file_name": TRACES[i % 3], "top_n": 100}),
            ),
            (_, 0) => ("db_search_signals", json!({"query": "a", "limit": 50})),
            (_, 1) => ("db_info", json!({})),
            (_, 2) => (
                "trace_query",
                json!({"file_name": TRACES[worker % 3], "limit": 200, "cursor": (i * 997) % 99_000}),
            ),
            _ => (
                "db_decode_frame",
                json!({"arb_id": "0x101", "data_hex": "0102030405060708"}),
            ),
        };
        let mut p = CallToolRequestParams::new(name);
        if let Value::Object(m) = args {
            p = p.with_arguments(m);
        }
        let t0 = Instant::now();
        let _ = client.call_tool(p).await.expect("call");
        max_ms.fetch_max(t0.elapsed().as_millis() as u64, Ordering::Relaxed);
        calls.fetch_add(1, Ordering::Relaxed);
        i += 1;
    }
    let _ = client.cancel().await;
}

#[test]
#[ignore = "timing benchmark: run with --release --ignored --nocapture"]
fn qa_mcp_on_off_does_not_disturb_50kfps_hot_path() {
    // A) MCP off
    let e_off = engine("off");
    let off = run_phase(&e_off);
    drop(e_off);

    // B) MCP on + 4 concurrent hammering clients
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let e_on = engine("on");
    let handle =
        nexus_mcp::start(Arc::clone(&e_on), McpConfig { port: 0 }, rt.handle()).expect("start");
    let stop = Arc::new(AtomicBool::new(false));
    let calls = Arc::new(AtomicU64::new(0));
    let max_ms = Arc::new(AtomicU64::new(0));
    let workers: Vec<_> = (0..4)
        .map(|w| {
            rt.spawn(hammer(
                handle.endpoint_url(),
                handle.token().to_string(),
                w,
                Arc::clone(&stop),
                Arc::clone(&calls),
                Arc::clone(&max_ms),
            ))
        })
        .collect();
    std::thread::sleep(Duration::from_millis(300)); // let clients initialize
    let c0 = calls.load(Ordering::Relaxed);
    let t0 = Instant::now();
    let on = run_phase(&e_on);
    let served = calls.load(Ordering::Relaxed) - c0;
    let served_s = t0.elapsed().as_secs_f64();
    stop.store(true, Ordering::Relaxed);
    rt.block_on(async {
        for w in workers {
            let _ = w.await;
        }
    });
    let total = handle.status().total_calls;
    rt.block_on(handle.shutdown());

    println!("[hot-path] MCP OFF: {off:?}");
    println!("[hot-path] MCP ON : {on:?}");
    println!(
        "[hot-path] MCP calls during measured window: {served} ({:.0}/s), total {total}, worst call {} ms",
        served as f64 / served_s,
        max_ms.load(Ordering::Relaxed)
    );
    let ratio = on.rx_fps / off.rx_fps;
    println!("[hot-path] RX fps ratio ON/OFF = {ratio:.3}");

    for (tag, p) in [("off", &off), ("on", &on)] {
        assert_eq!(p.dropped, 0, "{tag}: dropped_frames must be 0");
        assert!(
            p.mean_interval_ms >= 14.0,
            "{tag}: snapshots faster than 60 Hz ({:.2} ms)",
            p.mean_interval_ms
        );
        assert!(
            p.rx_fps > 35_000.0,
            "{tag}: RX throughput too low {:.0} fps",
            p.rx_fps
        );
    }
    assert!(served > 20, "MCP load generator too weak: {served} calls");
    assert!(
        ratio > 0.85,
        "MCP load reduced RX throughput by more than 15 % ({ratio:.3})"
    );
}
