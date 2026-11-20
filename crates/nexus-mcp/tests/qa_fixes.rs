//! Regression tests for the MCP M1 QA-gate findings MCP-QA-02 (trace cache budget +
//! single-flight), MCP-QA-03 (audit rate limiting) and MCP-QA-04 (extended-aware `arb_ids`).
//! MCP-QA-01 is covered by `qa_m1_gate.rs::qa_bug_error_responses_respect_the_16kb_cap` and the
//! `util` unit tests.

use nexus_hal::pipeline::PipelineEngine;
use nexus_hal::registry::DriverRegistry;
use nexus_hal::storage::DataRoot;
use nexus_mcp::audit::AUDIT_MAX_PER_WINDOW;
use nexus_mcp::tools_trace::{self, QueryArgs, TraceCache, TRACE_CACHE_MAX_FRAMES};
use nexus_mcp::McpConfig;
use rmcp::model::{CallToolRequestParams, ClientConfig};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;
use serde_json::{json, Value};
use std::sync::{Arc, Barrier};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

fn engine(tag: &str) -> Arc<PipelineEngine> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let root = DataRoot::under(std::env::temp_dir().join(format!(
        "nexus-mcp-qafix-{tag}-{}-{nanos}",
        std::process::id()
    )));
    root.ensure_dirs().unwrap();
    Arc::new(PipelineEngine::with_data_root(DriverRegistry::new(), root))
}

/// candump log with `n` frames of `body` every 1 ms.
fn log_trace(n: u64, bodies: &[&str]) -> String {
    let mut out = String::new();
    for i in 0..n {
        let us = 1_000_000 + i * 1_000;
        let body = bodies[(i as usize) % bodies.len()];
        out.push_str(&format!(
            "({}.{:06}) can0 {body}\n",
            us / 1_000_000,
            us % 1_000_000
        ));
    }
    out
}

fn save(engine: &PipelineEngine, name: &str, content: String) {
    engine
        .cmd_save_trace_file(name.to_string(), Some(content), None)
        .expect("save trace");
}

// ─── MCP-QA-02 ──────────────────────────────────────────────────────────────

#[test]
fn qa02_budget_constant_is_one_million_frames() {
    assert_eq!(TRACE_CACHE_MAX_FRAMES, 1_000_000);
}

#[test]
fn qa02_concurrent_cold_loads_are_single_flight() {
    let engine = engine("flight");
    save(
        &engine,
        "big.log",
        log_trace(20_000, &["1A0#0102030405060708"]),
    );
    let cache = TraceCache::default();
    let threads = 8;
    let barrier = Barrier::new(threads);
    let traces: Vec<_> = std::thread::scope(|s| {
        let hs: Vec<_> = (0..threads)
            .map(|_| {
                s.spawn(|| {
                    barrier.wait();
                    cache.load(&engine, "big.log").expect("load")
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let st = cache.stats();
    assert_eq!(
        st.parses, 1,
        "one parse for {threads} concurrent cold loads"
    );
    assert!(traces.iter().all(|t| Arc::ptr_eq(t, &traces[0])));
    assert_eq!(traces[0].frames.len(), 20_000);
    assert_eq!(st.entries, 1);
    assert_eq!(st.cached_frames, 20_000);
}

/// Corrupt trace (garbage `.blf` written straight into the traces dir, so it is listed but
/// fails to parse): every concurrent caller gets the same explicit error, nothing is cached,
/// and the in-flight slot is cleaned up (a later call parses again). The "exactly one parse
/// shared by all waiters" part is asserted deterministically by the unit test
/// `tools_trace::tests::concurrent_loads_share_one_error` (a real parse of a corrupt file is
/// too fast to guarantee overlap here).
#[test]
fn qa02_concurrent_loads_of_a_corrupt_trace_all_get_the_same_error() {
    let engine = engine("corrupt");
    let path = engine.data_root().traces_dir().join("bad.blf");
    std::fs::write(&path, vec![0xA5u8; 64 * 1024]).unwrap();
    let cache = TraceCache::default();
    let barrier = Barrier::new(6);
    let errs: Vec<String> = std::thread::scope(|s| {
        let hs: Vec<_> = (0..6)
            .map(|_| {
                s.spawn(|| {
                    barrier.wait();
                    cache
                        .load(&engine, "bad.blf")
                        .err()
                        .expect("corrupt trace must fail")
                        .0
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert!(
        errs[0].starts_with("cannot load trace 'bad.blf'"),
        "{}",
        errs[0]
    );
    assert!(errs.iter().all(|e| *e == errs[0]), "{errs:?}");
    let st = cache.stats();
    assert!(st.parses >= 1 && st.parses <= 6);
    assert_eq!((st.entries, st.cached_frames), (0, 0));
    let before = st.parses;
    assert!(cache.load(&engine, "bad.blf").is_err());
    assert_eq!(cache.stats().parses, before + 1, "errors are not cached");
}

#[test]
fn qa02_concurrent_loads_share_uncached_results() {
    let engine = engine("flight-nc");
    save(&engine, "over.log", log_trace(5_000, &["1A0#00"]));
    // Budget below the file size: the trace is served but never retained.
    let cache = TraceCache::with_frame_budget(1_000);
    let barrier = Barrier::new(4);
    let lens: Vec<usize> = std::thread::scope(|s| {
        let hs: Vec<_> = (0..4)
            .map(|_| {
                s.spawn(|| {
                    barrier.wait();
                    cache.load(&engine, "over.log").unwrap().frames.len()
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert!(lens.iter().all(|&n| n == 5_000));
    let st = cache.stats();
    assert_eq!(st.entries, 0, "over-budget trace must not be cached");
    assert_eq!(st.cached_frames, 0);
    // Concurrent callers may share one parse; a later call parses again (not cached).
    let before = st.parses;
    cache.load(&engine, "over.log").unwrap();
    assert_eq!(cache.stats().parses, before + 1);
}

#[test]
fn qa02_total_frame_budget_evicts_least_recently_used() {
    let engine = engine("budget");
    save(&engine, "a.log", log_trace(300, &["100#00"]));
    save(&engine, "b.log", log_trace(300, &["200#00"]));
    save(&engine, "c.log", log_trace(300, &["300#00"]));
    let cache = TraceCache::with_frame_budget(700);
    let a = cache.load(&engine, "a.log").unwrap();
    cache.load(&engine, "b.log").unwrap();
    assert_eq!(cache.stats().cached_frames, 600);
    // Touch a (MRU), then c: b is the LRU and must go to stay <= 700 frames.
    assert!(Arc::ptr_eq(&a, &cache.load(&engine, "a.log").unwrap()));
    cache.load(&engine, "c.log").unwrap();
    let st = cache.stats();
    assert_eq!(st.entries, 2);
    assert_eq!(st.cached_frames, 600);
    let parses = st.parses;
    cache.load(&engine, "a.log").unwrap();
    cache.load(&engine, "c.log").unwrap();
    assert_eq!(cache.stats().parses, parses, "a and c are cached");
    cache.load(&engine, "b.log").unwrap();
    assert_eq!(cache.stats().parses, parses + 1, "b was evicted");
    cache.clear();
    assert_eq!(cache.stats().cached_frames, 0);
}

async fn client_for(
    handle: &nexus_mcp::McpServerHandle,
) -> rmcp::service::RunningService<rmcp::RoleClient, ClientConfig> {
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(handle.endpoint_url())
            .auth_header(handle.token().to_string()),
    );
    ClientConfig::default()
        .serve(transport)
        .await
        .expect("init")
}

async fn call(
    client: &rmcp::service::RunningService<rmcp::RoleClient, ClientConfig>,
    name: &'static str,
    args: Value,
) -> Value {
    let mut p = CallToolRequestParams::new(name);
    if let Value::Object(m) = args {
        p = p.with_arguments(m);
    }
    let r = client.call_tool(p).await.expect("call");
    serde_json::from_str(&r.content[0].as_text().unwrap().text).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn qa02_server_cache_is_populated_by_tools_and_released_on_stop() {
    let engine = engine("srvcache");
    save(&engine, "t.log", log_trace(1_000, &["1A0#00"]));
    let handle = nexus_mcp::start(
        Arc::clone(&engine),
        McpConfig { port: 0 },
        &tokio::runtime::Handle::current(),
    )
    .unwrap();
    let client = client_for(&handle).await;
    let v = call(&client, "trace_summary", json!({ "file_name": "t.log" })).await;
    assert_eq!(v["total_frames"], json!(1_000));
    call(
        &client,
        "trace_query",
        json!({ "file_name": "t.log", "limit": 5 }),
    )
    .await;
    let st = handle.trace_cache_stats();
    assert_eq!((st.entries, st.cached_frames, st.parses), (1, 1_000, 1));
    let _ = client.cancel().await;
    // Release on stop is verified deterministically by the `lib.rs` unit test
    // `stop_releases_trace_cache`; here we check shutdown completes with a populated cache.
    handle.shutdown().await;
}

// ─── MCP-QA-03 ──────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn qa03_audit_is_rate_limited_and_summarised() {
    let engine = engine("audit");
    let handle = nexus_mcp::start(
        Arc::clone(&engine),
        McpConfig { port: 0 },
        &tokio::runtime::Handle::current(),
    )
    .unwrap();
    let client = client_for(&handle).await;
    let calls = 120u64;
    let t0 = Instant::now();
    for i in 0..calls {
        let tool = if i % 3 == 0 { "db_info" } else { "trace_list" };
        call(&client, tool, json!({})).await;
    }
    let elapsed_s = t0.elapsed().as_secs_f64();
    assert_eq!(
        handle.status().total_calls,
        calls,
        "total_calls is not rate limited"
    );
    let _ = client.cancel().await;
    handle.shutdown().await; // flushes the pending summary

    let events = engine.snapshot_debug_events().events;
    let individual = events
        .iter()
        .filter(|e| e.category == "MCP" && e.action == "mcp.tool_call")
        .count() as u64;
    let summaries: Vec<_> = events
        .iter()
        .filter(|e| e.category == "MCP" && e.action == "mcp.tool_calls_suppressed")
        .collect();
    let max_individual = u64::from(AUDIT_MAX_PER_WINDOW) * (elapsed_s.ceil() as u64 + 1);
    assert!(
        individual <= max_individual,
        "{individual} individual audit events in {elapsed_s:.2}s (max {max_individual})"
    );
    assert!(!summaries.is_empty(), "suppressed calls must be summarised");
    let suppressed: u64 = summaries
        .iter()
        .map(|e| {
            e.title
                .strip_prefix("MCP: ")
                .and_then(|t| t.split_whitespace().next())
                .and_then(|n| n.parse::<u64>().ok())
                .unwrap_or_else(|| panic!("bad summary title {}", e.title))
        })
        .sum();
    assert_eq!(
        individual + suppressed,
        calls,
        "every call is accounted for"
    );
    assert!(summaries.iter().all(|e| e.source == "mcp"
        && e.title.contains("tool calls not individually logged")
        && e.details
            .as_deref()
            .is_some_and(|d| d.contains("trace_list="))));
}

// ─── MCP-QA-04 ──────────────────────────────────────────────────────────────

#[test]
fn qa04_arb_ids_filter_respects_extended_flag() {
    let engine = engine("extid");
    // Standard 0x1A0, extended 0x000001A0 and extended 0x18FF0000, interleaved.
    save(
        &engine,
        "mixed.log",
        log_trace(300, &["1A0#11", "000001A0#22", "18FF0000#33"]),
    );
    let trace = TraceCache::default().load(&engine, "mixed.log").unwrap();
    let q = |ids: &[&str]| {
        tools_trace::trace_query(
            &trace,
            &QueryArgs {
                from_us: None,
                to_us: None,
                arb_ids: Some(ids.iter().map(|s| s.to_string()).collect()),
                limit: 200,
                cursor: None,
            },
        )
        .unwrap()
    };
    let std_only = q(&["0x1A0"]);
    assert_eq!(std_only["matched_total"], json!(100));
    assert!(std_only["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r[2] == json!("0x1A0") && r[4] == json!("11")));
    let dec = q(&["416"]);
    assert_eq!(
        dec["matched_total"],
        json!(100),
        "decimal <= 0x7FF is standard"
    );

    let ext_explicit = q(&["0x000001A0"]);
    assert_eq!(ext_explicit["matched_total"], json!(100));
    assert!(ext_explicit["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r[2] == json!("0x000001A0") && r[4] == json!("22")));

    let ext_high = q(&["0x18FF0000"]);
    assert_eq!(ext_high["matched_total"], json!(100));
    let both = q(&["0x1A0", "0x000001A0"]);
    assert_eq!(both["matched_total"], json!(200));
}
