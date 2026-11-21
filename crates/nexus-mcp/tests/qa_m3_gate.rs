//! QA gate "MCP M3" (qa-hil-verifier): adversarial checks for the 14 M3 tools
//! (diag_*, re_*, run_*, flowlib_*), contract `planning/contracts/mcp-v1.md` §2 / §5 / §9.
//!
//! * Registry: 14 tools, `read_only_hint = true`, "does NOT" wording, server instructions cover
//!   every M3 family and stay consistent with SAFETY.
//! * Attack matrix over real MCP/HTTP: oversized / garbage args on every tool -> response
//!   <= 16 KB, echoed input <= 64 chars, error text <= 512 chars, server alive afterwards, and the
//!   data root is byte-for-byte unchanged (no fs write).
//! * Limit clamps, path traversal ids, diag redaction (mock0 armed session, multi-frame 0x27 / 0x29
//!   with ISO-TP FF+CF, paging with limit = 1), RE disabled / unfocused behaviour, observer
//!   correlation vs a concurrent user correlation, concurrent calls without deadlock.

use nexus_core::{CanIdKey, RawCanFrame};
use nexus_hal::pipeline::re_analyzer::{ReCorrelateRequest, ReScanFirstSpec, ReTargetDto};
use nexus_hal::pipeline::PipelineEngine;
use nexus_hal::registry::DriverRegistry;
use nexus_hal::runstore::{RunOutcome, RunRecordV1};
use nexus_hal::storage::DataRoot;
use nexus_hal::{ChannelConfigDto, MOCK0_DEVICE_ID};
use nexus_mcp::tools_diag::{self as td, DiagConversationArgs, DiagIsoTpFramesArgs};
use nexus_mcp::util::MAX_RESPONSE_BYTES;
use nexus_mcp::McpConfig;
use rmcp::model::{CallToolRequestParams, ClientConfig};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CAP: usize = MAX_RESPONSE_BYTES;
const PROJECT: &str = "proj-1";

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

// ─── Engine fixtures ────────────────────────────────────────────────────────

fn root_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "nexus-mcp-qam3-{tag}-{}-{nanos}",
        std::process::id()
    ))
}

fn engine_at(dir: &Path) -> Arc<PipelineEngine> {
    let root = DataRoot::under(dir);
    root.ensure_dirs().unwrap();
    Arc::new(PipelineEngine::with_data_root(
        DriverRegistry::with_builtin_drivers(),
        root,
    ))
}

fn frame(id: u16, data: &[u8], ts: u64) -> RawCanFrame {
    RawCanFrame::new_classical(0, CanIdKey::new_standard(id).unwrap(), data, ts).unwrap()
}

fn start_re(e: &PipelineEngine, frames: u64) {
    e.cmd_re_start(None);
    e.cmd_re_focus_set(vec![ReTargetDto {
        bus: 0,
        arb_id: 0x123,
        is_extended: false,
    }])
    .expect("focus");
    let re = e.re_shared();
    let mut a = re.lock();
    for i in 0..frames {
        let r = ((i * 10) as u16).to_le_bytes();
        let t = 1_000_000 + i * 10_000;
        a.ingest(&frame(0x123, &[i as u8, 0xAA, r[0], r[1], 0, 0, 0, 0], t));
        a.ingest(&frame(0x200, &[0x11, (i % 3) as u8], t + 5));
    }
}

fn run_record(id: &str, flow: &str, at: &str, outcome: RunOutcome) -> RunRecordV1 {
    let mut outputs = BTreeMap::new();
    outputs.insert("vin".to_string(), json!("WVWZZZ1JZXW000001"));
    RunRecordV1 {
        schema_version: 1,
        run_id: id.to_string(),
        parent_run_id: None,
        queue_id: None,
        project_id: PROJECT.to_string(),
        vehicle_id: None,
        ecu_id: Some("ecu-a".to_string()),
        ecu_name: Some("ECU a".to_string()),
        ecu_snapshot_hash: None,
        flow_id: flow.to_string(),
        flow_revision: 1,
        flow_content_hash: "a".repeat(64),
        flow_name: format!("Flow {flow}"),
        params: BTreeMap::new(),
        files: Vec::new(),
        started_at: at.to_string(),
        ended_at: at.to_string(),
        duration_ms: 42,
        outcome,
        output_name: Some("ok".to_string()),
        outputs,
        nrc: None,
        error_message: None,
        log_excerpt: vec!["seed=11223344 key=SECRETLOGKEY".to_string(); 3],
        operator: None,
        device_id: "dev-1".to_string(),
        app_version: "0.1.0".to_string(),
    }
}

fn flow_file(id: &str, revision: u64, blocks: Vec<Value>) -> String {
    json!({
        "schemaVersion": 1,
        "kind": "nexuscan.flow",
        "flow": {
            "id": id, "revision": revision, "name": format!("Flow {id}"),
            "description": "qa", "createdAt": "2026-11-18T10:00:00.000Z",
            "updatedAt": "2026-11-18T10:00:01.000Z", "author": null, "origin": "user",
            "aiReviewed": false, "tags": ["uds"], "variables": [],
            "blocks": blocks, "connections": [],
        },
        "contentHash": "a".repeat(64),
    })
    .to_string()
}

fn seed_runs_and_flows(e: &PipelineEngine) {
    for (i, st) in [RunOutcome::Ok, RunOutcome::Fail, RunOutcome::Error]
        .into_iter()
        .enumerate()
    {
        e.cmd_run_append(&run_record(
            &format!("r{i}"),
            "read_vin",
            &format!("2026-11-0{}T10:00:00.000Z", i + 1),
            st,
        ))
        .unwrap();
    }
    e.cmd_flowlib_save(&flow_file(
        "read_vin",
        1,
        vec![json!({ "id": "b1", "type": "uds_read_did", "label": "VIN", "config": { "did": "F190" } })],
    ))
    .unwrap();
}

fn connect_mock0(e: &PipelineEngine) {
    e.cmd_connect_bus(
        MOCK0_DEVICE_ID.to_string(),
        ChannelConfigDto {
            bus_id: 0,
            listen_only: false,
            ..ChannelConfigDto::default()
        },
    )
    .expect("connect mock0");
    e.cmd_arm_active_bus(0, true).expect("arm");
}

fn open_session(e: &PipelineEngine, req: u32, resp: u32) {
    let cfg = serde_json::from_value(json!({
        "busId": 0, "requestId": req, "responseId": resp, "isExtendedId": false
    }))
    .unwrap();
    e.cmd_diag_open_session(cfg).expect("open session");
}

macro_rules! cfg7e0 {
    () => {
        serde_json::from_value(json!({
            "busId": 0, "requestId": 0x7E0, "responseId": 0x7E8, "isExtendedId": false
        }))
        .unwrap()
    };
}

// ─── MCP / HTTP helpers ─────────────────────────────────────────────────────

type Client = rmcp::service::RunningService<rmcp::RoleClient, ClientConfig>;

async fn start(e: &Arc<PipelineEngine>) -> (nexus_mcp::McpServerHandle, Client) {
    let handle = nexus_mcp::start(
        Arc::clone(e),
        McpConfig { port: 0 },
        &tokio::runtime::Handle::current(),
    )
    .expect("start mcp");
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(handle.endpoint_url())
            .auth_header(handle.token().to_string()),
    );
    let client = ClientConfig::default()
        .serve(transport)
        .await
        .expect("init");
    (handle, client)
}

/// `Ok((is_error, text))` or `Err(protocol error text)`.
async fn call(client: &Client, name: &str, args: Value) -> Result<(bool, String), String> {
    let mut p = CallToolRequestParams::new(name.to_string());
    if let Value::Object(m) = args {
        p = p.with_arguments(m);
    }
    let r = client.call_tool(p).await.map_err(|e| e.to_string())?;
    let text = r
        .content
        .first()
        .and_then(|c| c.as_text())
        .map(|t| t.text.clone())
        .unwrap_or_default();
    Ok((r.is_error == Some(true), text))
}

fn longest_run(s: &str, c: char) -> usize {
    let (mut best, mut cur) = (0, 0);
    for ch in s.chars() {
        if ch == c {
            cur += 1;
            best = best.max(cur);
        } else {
            cur = 0;
        }
    }
    best
}

/// Snapshot of every file under `dir` (relative path -> (len, mtime)).
fn fs_snapshot(dir: &Path) -> BTreeMap<String, (u64, SystemTime)> {
    fn walk(base: &Path, p: &Path, out: &mut BTreeMap<String, (u64, SystemTime)>) {
        let Ok(rd) = std::fs::read_dir(p) else { return };
        for ent in rd.flatten() {
            let path = ent.path();
            let rel = path.strip_prefix(base).unwrap().display().to_string();
            let md = ent.metadata().unwrap();
            // Directories: presence only. NTFS updates a directory's LastWriteTime lazily after
            // files inside were written (seed step), which showed up as a false "write" on
            // Windows CI. Every file is still compared by size + mtime, and added / removed
            // entries (files or directories) are still detected.
            let meta = if md.is_dir() {
                (0, SystemTime::UNIX_EPOCH)
            } else {
                (md.len(), md.modified().unwrap_or(SystemTime::UNIX_EPOCH))
            };
            out.insert(rel, meta);
            if md.is_dir() {
                walk(base, &path, out);
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

// ─── 1. Registry + instructions ─────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn qa_m3_registry_read_only_and_instructions() {
    let e = engine_at(&root_dir("reg"));
    let (handle, client) = start(&e).await;
    let tools = client.list_all_tools().await.unwrap();
    for name in M3_TOOLS {
        let t = tools
            .iter()
            .find(|t| t.name == name)
            .unwrap_or_else(|| panic!("{name} missing"));
        let a = t
            .annotations
            .as_ref()
            .unwrap_or_else(|| panic!("{name}: no annotations"));
        assert_eq!(a.read_only_hint, Some(true), "{name} read_only_hint");
        assert_ne!(a.destructive_hint, Some(true), "{name} destructive");
        let d = t.description.as_deref().unwrap_or("").to_ascii_lowercase();
        assert!(
            d.contains("does not") || d.contains("never") || d.contains("saves nothing"),
            "{name}: description must say what it does NOT do: {d}"
        );
    }
    // Every tool of the whole server read-only (nothing write-like slipped in).
    for t in &tools {
        let ro = t.annotations.as_ref().and_then(|a| a.read_only_hint);
        let ui = t.name.starts_with("ui_");
        assert!(ro == Some(true) || ui, "{} not read-only", t.name);
    }
    let info = client.peer_info().expect("peer info");
    let ins = info.instructions.clone().unwrap_or_default();
    for name in M3_TOOLS {
        assert!(ins.contains(name), "instructions miss {name}");
    }
    assert!(ins.contains("SAFETY"));
    assert!(ins.contains("no tool can transmit frames"));
    assert!(ins.contains("run UDS/diagnostic requests"));
    assert!(ins.to_ascii_lowercase().contains("redacted"));
    assert!(ins.contains("already be focused") || ins.contains("must already be focused"));
    assert!(ins.contains("saves nothing"));
    println!("tools={} instructions_len={}", tools.len(), ins.len());
    client.cancel().await.ok();
    handle.shutdown().await;
}

// ─── 2. Attack matrix ───────────────────────────────────────────────────────

fn attack_matrix() -> Vec<(&'static str, Value)> {
    let big = "x".repeat(50_000);
    let cands: Vec<Value> = (0..20_000)
        .map(|i| json!({ "start_bit": i % 512, "bit_length": 8 }))
        .collect();
    let drafts: Vec<Value> = (0..3_000)
        .map(|i| {
            json!({
                "name": format!("Sig_{i}_{}", "n".repeat(200)), "id": format!("0x{:X}", 0x100 + i % 0x600),
                "start_bit": 0, "bit_length": 8, "unit": "u".repeat(500),
                "comment": "c".repeat(2_000), "message_name": "m".repeat(300)
            })
        })
        .collect();
    let vt: Vec<Value> = (0..20_000)
        .map(|i| json!({ "value": i, "label": "l".repeat(100) }))
        .collect();
    let sel_garbage = vec![
        json!({}),
        json!({ "request_id": big, "response_id": big, "bus_id": 0 }),
        json!({ "request_id": "0x7E0", "response_id": big }),
        json!({ "bus_id": 300 }),
        json!({ "bus_id": -1 }),
        json!({ "bus_id": big }),
        json!({ "request_id": { "a": [1, 2, { "b": big }] } }),
        json!({ "request_id": null, "is_extended": "yes" }),
        json!({ "request_id": "0x1FFFFFFFF" }),
        json!({ "request_id": "\u{0}\u{0}\u{1b}[31m" }),
        json!({ "request_id": "0x7E0", "since_seq": u64::MAX, "limit": u32::MAX }),
        json!({ "since_seq": -1, "limit": -1 }),
        json!({ "since_seq": 1e30, "limit": 4294967296u64 }),
        json!({ "limit": 1.5 }),
        json!({ "limit": "9" }),
        json!({ "limit": 0 }),
    ];
    let mut m: Vec<(&'static str, Value)> = Vec::new();
    for name in [
        "diag_session_info",
        "diag_conversation",
        "diag_isotp_frames",
    ] {
        for a in &sel_garbage {
            m.push((name, a.clone()));
        }
    }
    for a in [
        json!({}),
        json!({ "bus_id": 256 }),
        json!({ "bus_id": -1 }),
        json!({ "bus_id": big }),
        json!({ "bus_id": 0, "junk": big }),
    ] {
        m.push(("diag_passive_discovery", a));
    }
    m.push(("re_status", json!({})));
    m.push(("re_status", json!({ "junk": big })));
    m.push(("re_status", json!([big])));
    let cand = json!({ "start_bit": 0, "bit_length": 8 });
    let series_args = vec![
        json!({}),
        json!({ "bus_id": 0, "id": big }),
        json!({ "bus_id": 0, "id": "0x123", "candidates": cands }),
        json!({ "bus_id": 0, "id": "0x123", "candidates": [cand.clone()], "max_points": u32::MAX }),
        json!({ "bus_id": 0, "id": "0x123", "candidates": [cand.clone()], "max_points": 0 }),
        json!({ "bus_id": 0, "id": "0x123", "candidates": [cand.clone()], "from_us": u64::MAX, "to_us": 0 }),
        json!({ "bus_id": 0, "id": "0x123", "candidates": [{ "start_bit": 65535, "bit_length": 0 }] }),
        json!({ "bus_id": 0, "id": "0x123", "candidates": [{ "start_bit": 0, "bit_length": 65535, "label": big }] }),
        json!({ "bus_id": 0, "id": "0x123", "candidates": [{ "start_bit": 0, "bit_length": 8, "factor": 1e308, "offset": -1e308 }] }),
        json!({ "bus_id": 0, "id": "0x123", "candidates": [cand.clone()],
                "reference": { "kind": "markers", "points": (0..20_000).map(|i| json!({ "marker_id": i, "value": 1.0 })).collect::<Vec<_>>() } }),
        json!({ "bus_id": 0, "id": "0x123", "candidates": [],
                "reference": { "kind": "candidate", "bus_id": 0, "id": big, "candidate": cand.clone() } }),
        json!({ "bus_id": 0, "id": "0x123", "reference": { "kind": big } }),
        json!({ "bus_id": 0, "id": "0x123", "reference": { "kind": "obd_pid", "pid": 999 } }),
    ];
    for a in series_args {
        m.push(("re_series", a));
    }
    for a in [
        json!({}),
        json!({ "bus_id": 0, "id": big, "reference": { "kind": "obd_pid", "pid": 13 } }),
        json!({ "bus_id": 0, "id": "0x123", "reference": { "kind": "obd_pid", "pid": 13 }, "top_n": u32::MAX }),
        json!({ "bus_id": 0, "id": "0x123", "reference": { "kind": "obd_pid", "pid": 13 }, "bit_from": 65535, "bit_to": 0 }),
        json!({ "bus_id": 0, "id": "0x123", "reference": { "kind": "obd_pid", "pid": 13 }, "min_length": 65535, "max_length": 0 }),
        json!({ "bus_id": 0, "id": "0x123", "reference": { "kind": "obd_pid", "pid": 13 }, "byte_orders": (0..10_000).map(|_| "intel").collect::<Vec<_>>() }),
        json!({ "bus_id": 0, "id": "0x123", "reference": { "kind": "markers", "points": [] } }),
        json!({ "bus_id": 0, "id": "0x123", "reference": big }),
    ] {
        m.push(("re_correlate", a));
    }
    for a in [
        json!({}),
        json!({ "offset": u32::MAX, "limit": u32::MAX }),
        json!({ "offset": -1, "limit": -1 }),
        json!({ "sort": big }),
        json!({ "sort": "bogus" }),
        json!({ "limit": 0 }),
        json!({ "limit": 4294967296u64 }),
    ] {
        m.push(("re_scan_results", a));
    }
    for a in [
        json!({}),
        json!({ "bus_id": 0, "id": big }),
        json!({ "bus_id": 0, "id": "0x1FFFFFFFF" }),
        json!({ "bus_id": 0, "id": "" }),
        json!({ "bus_id": 999, "id": "0x123" }),
        json!({ "bus_id": 0, "id": "0x123", "is_extended": "x" }),
    ] {
        m.push(("re_row_detail", a));
    }
    for a in [
        json!({}),
        json!({ "drafts": [] }),
        json!({ "drafts": drafts }),
        json!({ "drafts": [{ "name": big, "id": "0x100", "start_bit": 0, "bit_length": 8 }] }),
        json!({ "drafts": [{ "name": "a", "id": big, "start_bit": 0, "bit_length": 8 }] }),
        json!({ "drafts": [{ "name": "a", "id": "0x100", "start_bit": 65535, "bit_length": 255 }] }),
        json!({ "drafts": [{ "name": "a", "id": "0x100", "start_bit": 0, "bit_length": 0 }] }),
        json!({ "drafts": [{ "name": "a", "id": "0x100", "start_bit": 0, "bit_length": 8, "value_table": vt }] }),
        json!({ "drafts": [{ "name": "a\"\n BO_ 1 X: 8 Y\n", "id": "0x100", "start_bit": 0, "bit_length": 8, "comment": "\"; BU_ evil" }] }),
        json!({ "drafts": [{ "name": "a", "id": "0x100", "start_bit": 0, "bit_length": 8, "factor": 0.0 }] }),
        json!({ "drafts": [{ "name": "a", "id": "0x100", "start_bit": 0, "bit_length": 8 }], "base_db_id": big }),
        json!({ "drafts": big }),
    ] {
        m.push(("re_dbc_generate", a));
    }
    for a in [
        json!({}),
        json!({ "project_id": big }),
        json!({ "project_id": PROJECT, "ecu_id": big, "flow_id": big, "status": big, "from": big, "to": big }),
        json!({ "project_id": PROJECT, "limit": u32::MAX }),
        json!({ "project_id": PROJECT, "limit": 0 }),
        json!({ "project_id": PROJECT, "limit": -1 }),
        json!({ "project_id": PROJECT, "from": "9999-99-99", "to": "0000" }),
        json!({ "project_id": PROJECT, "status": "ok\u{0}" }),
        json!({ "project_id": "../../etc" }),
    ] {
        m.push(("run_query", a));
    }
    for a in [
        json!({}),
        json!({ "project_id": big }),
        json!({ "project_id": "" }),
        json!({ "project_id": "..\\..\\x" }),
    ] {
        m.push(("run_latest", a));
    }
    for a in [
        json!({}),
        json!({ "include_deleted": "x" }),
        json!({ "include_deleted": big }),
    ] {
        m.push(("flowlib_list", a));
    }
    for a in [
        json!({}),
        json!({ "id": big }),
        json!({ "id": "read_vin", "revision": u32::MAX }),
        json!({ "id": "read_vin", "revision": -1 }),
        json!({ "id": "read_vin", "revision": 4294967296u64 }),
        json!({ "id": 5 }),
    ] {
        m.push(("flowlib_get", a));
    }
    m
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn qa_m3_attack_matrix_caps_echo_and_no_fs_write() {
    let dir = root_dir("matrix");
    let e = engine_at(&dir);
    seed_runs_and_flows(&e);
    start_re(&e, 300);
    connect_mock0(&e);
    open_session(&e, 0x7E0, 0x7E8);
    let (handle, client) = start(&e).await;
    let before = fs_snapshot(&dir);

    let matrix = attack_matrix();
    let mut viol: Vec<String> = Vec::new();
    let (mut n_ok, mut n_tool_err, mut n_proto_err) = (0, 0, 0);
    let mut max_len = 0usize;
    let mut serde_echo_max = 0usize;
    let t0 = Instant::now();
    for (i, (tool, args)) in matrix.iter().enumerate() {
        let tag = format!(
            "#{i} {tool} {}",
            args.to_string().chars().take(70).collect::<String>()
        );
        match call(&client, tool, args.clone()).await {
            Ok((is_err, text)) => {
                max_len = max_len.max(text.len());
                if text.len() > CAP {
                    viol.push(format!("{tag}: response {} B > cap", text.len()));
                }
                // rmcp-level serde errors are clipped as a whole to 512 chars (server.rs:909, M1
                // design); the tool-level `echo()` rule (<= 64) applies to everything else.
                let serde_err = text.contains("failed to deserialize parameters");
                if !serde_err
                    && (longest_run(&text, 'x') > 64
                        || longest_run(&text, 'n') > 64
                        || longest_run(&text, 'c') > 64
                        || longest_run(&text, 'l') > 64)
                {
                    viol.push(format!(
                        "{tag}: echoes >64 repeated chars (is_err={is_err}, resp {} B, run {}): {}",
                        text.len(),
                        longest_run(&text, 'x'),
                        text.chars().take(160).collect::<String>()
                    ));
                }
                if is_err {
                    n_tool_err += 1;
                    let msg = serde_json::from_str::<Value>(&text)
                        .ok()
                        .and_then(|v| v["error"].as_str().map(str::to_string))
                        .unwrap_or_else(|| text.clone());
                    if serde_err {
                        serde_echo_max = serde_echo_max.max(longest_run(&text, 'x'));
                    }
                    if msg.chars().count() > 513 {
                        viol.push(format!("{tag}: error {} chars > 512", msg.chars().count()));
                    }
                } else {
                    n_ok += 1;
                }
            }
            Err(p) => {
                n_proto_err += 1;
                if p.len() > CAP || longest_run(&p, 'x') > 64 {
                    viol.push(format!("{tag}: protocol error {} B / long echo", p.len()));
                }
            }
        }
    }
    println!(
        "matrix: {} calls in {:?}: ok={n_ok} tool_err={n_tool_err} proto_err={n_proto_err} max_resp={max_len} B serde_err_max_echo={serde_echo_max} chars violations={}",
        matrix.len(),
        t0.elapsed(),
        viol.len()
    );
    for v in &viol {
        println!("VIOLATION {v}");
    }
    // Server still alive.
    let (err, _) = call(&client, "app_status", json!({})).await.unwrap();
    assert!(!err, "server unhealthy after matrix");
    // Read-only proof at the filesystem level.
    let after = fs_snapshot(&dir);
    let changed: Vec<&String> = after
        .keys()
        .filter(|k| !k.starts_with("logs") && before.get(*k) != after.get(*k))
        .chain(
            before
                .keys()
                .filter(|k| !k.starts_with("logs") && !after.contains_key(*k)),
        )
        .collect();
    println!("fs changes during matrix: {changed:?}");
    assert!(
        changed.is_empty(),
        "M3 tools wrote to the data root: {changed:?}"
    );
    assert!(viol.is_empty(), "{viol:#?}");
    // Nothing started by MCP.
    assert_eq!(e.diag_session_list().len(), 1, "session count changed");
    assert!(e.diag_passive_bus_ids().is_empty());
    assert_eq!(e.cmd_re_focus_status().targets.len(), 1, "focus changed");
    client.cancel().await.ok();
    handle.shutdown().await;
}

// ─── 3. Limit clamps ────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn qa_m3_limits_are_clamped() {
    let e = engine_at(&root_dir("limits"));
    seed_runs_and_flows(&e);
    start_re(&e, 300);
    connect_mock0(&e);
    open_session(&e, 0x7E0, 0x7E8);
    let (handle, client) = start(&e).await;
    for tool in ["diag_conversation", "diag_isotp_frames"] {
        let max = if tool == "diag_conversation" {
            100
        } else {
            200
        };
        for (lim, want) in [(json!(0), 1), (json!(u32::MAX), max)] {
            let (err, t) = call(&client, tool, json!({ "limit": lim })).await.unwrap();
            assert!(!err && t.len() <= CAP, "{tool} {t}");
            let v: Value = serde_json::from_str(&t).unwrap();
            assert_eq!(v["limit"], json!(want), "{tool} limit {lim}: {v}");
        }
    }
    // re_scan_results: user starts a scan, MCP only reads.
    e.cmd_re_scan_first(
        serde_json::from_value::<ReScanFirstSpec>(json!({ "kind": "unknown" })).unwrap(),
    )
    .unwrap();
    for lim in [json!(0), json!(u32::MAX)] {
        let (err, t) = call(
            &client,
            "re_scan_results",
            json!({ "limit": lim, "offset": u32::MAX }),
        )
        .await
        .unwrap();
        assert!(!err && t.len() <= CAP, "{t}");
        let v: Value = serde_json::from_str(&t).unwrap();
        let rows = v["rows"].as_array().map_or(0, Vec::len);
        println!(
            "re_scan_results limit={lim}: keys={:?} rows={rows}",
            v.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>())
        );
        assert!(rows <= 100);
    }
    for lim in [json!(0), json!(u32::MAX)] {
        let (err, t) = call(
            &client,
            "run_query",
            json!({ "project_id": PROJECT, "limit": lim }),
        )
        .await
        .unwrap();
        assert!(!err && t.len() <= CAP, "{t}");
        let v: Value = serde_json::from_str(&t).unwrap();
        let n = v["runs"]
            .as_array()
            .or(v["records"].as_array())
            .map_or(usize::MAX, Vec::len);
        assert!(n <= 50, "run_query returned {n}: {v}");
    }
    client.cancel().await.ok();
    handle.shutdown().await;
}

// ─── 4. Traversal ───────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn qa_m3_flowlib_and_project_traversal_rejected() {
    let dir = root_dir("trav");
    let e = engine_at(&dir);
    seed_runs_and_flows(&e);
    // Sentinel outside the flow dir that a traversal would expose.
    std::fs::write(dir.join("sentinel.json"), "{\"flow\":\"TRAVERSAL-HIT\"}").unwrap();
    let (handle, client) = start(&e).await;
    let bad = [
        "../../etc/passwd",
        "%2e%2e",
        "%2e%2e%2fsentinel",
        "/etc/passwd",
        "..",
        "../sentinel",
        "..\\..\\windows\\win.ini",
        "C:\\Windows\\win.ini",
        "read_vin/../read_vin",
        "read_vin\u{0}",
        "a\u{0}b",
        "\u{0}",
        "read_vin.json",
        "./read_vin",
        "",
        " read_vin",
        "READ_VIN/",
        "..%c0%af..",
    ];
    for id in bad {
        let (err, t) = call(&client, "flowlib_get", json!({ "id": id }))
            .await
            .unwrap();
        assert!(err, "flowlib_get accepted {id:?}: {t}");
        assert!(!t.contains("TRAVERSAL-HIT") && !t.contains("root:"), "{t}");
    }
    let (err, _) = call(&client, "flowlib_get", json!({ "id": "read_vin" }))
        .await
        .unwrap();
    assert!(!err, "legit id rejected");
    for tool in ["run_query", "run_latest"] {
        for pid in bad
            .iter()
            .chain(["../proj-1", "proj-1/..", "proj-1\u{0}", "%2e%2e"].iter())
        {
            let (err, t) = call(&client, tool, json!({ "project_id": pid }))
                .await
                .unwrap();
            assert!(err, "{tool} accepted project_id {pid:?}: {t}");
        }
    }
    let (err, _) = call(&client, "run_query", json!({ "project_id": PROJECT }))
        .await
        .unwrap();
    assert!(!err, "legit project rejected");
    client.cancel().await.ok();
    handle.shutdown().await;
}

// ─── 5. Flow library secrets ────────────────────────────────────────────────

#[test]
fn qa_m3_flowlib_expected_key_never_leaks() {
    let e = engine_at(&root_dir("flowsec"));
    let blocks = vec![
        json!({ "id": "b1", "type": "uds_seed_validator", "label": "Key", "config": { "expected_key": "C9A8BEEF", "algorithm": "xor_ff" } }),
        json!({ "id": "b2", "type": "uds_seed_validator", "label": "Key2", "config": { "nested": { "seed": "11223344", "KEY": "55667788", "secret_blob": "99AABBCC", "api_token": "TOK12345" } } }),
    ];
    e.cmd_flowlib_save(&flow_file("sec_flow", 1, blocks))
        .unwrap();
    let v = nexus_mcp::tools_runs::flowlib_get(&e, "sec_flow", None).unwrap();
    let s = v.to_string();
    for secret in ["C9A8BEEF", "11223344", "55667788", "99AABBCC", "TOK12345"] {
        assert!(!s.contains(secret), "{secret} leaked: {s}");
    }
    // run_query / run_latest never expose log lines or output values.
    e.cmd_run_append(&run_record(
        "rx",
        "sec_flow",
        "2026-11-05T10:00:00.000Z",
        RunOutcome::Ok,
    ))
    .unwrap();
    for v in [
        nexus_mcp::tools_runs::run_latest(&e, PROJECT).unwrap(),
        nexus_mcp::tools_runs::run_query(
            &e,
            &nexus_mcp::tools_runs::RunQuery {
                project_id: PROJECT.into(),
                ..Default::default()
            },
        )
        .unwrap(),
    ] {
        let s = v.to_string();
        assert!(
            !s.contains("SECRETLOGKEY") && !s.contains("11223344") && !s.contains("WVWZZZ"),
            "{s}"
        );
    }
}

/// Seed-key derivation material of the `uds_security_access` block (`config.constant`,
/// `config.script`, FlowEngine.ts:955-956 / blockDefs.ts:716-722) is the real secret of the
/// 0x27 exchange. `is_secret_key` (tools_runs.rs:437) does not know these names.
#[test]
fn qa_m3_flowlib_seedkey_constant_and_script_not_leaked() {
    let e = engine_at(&root_dir("flowsec2"));
    let blocks = vec![json!({
        "id": "b1", "type": "uds_security_access", "label": "SA",
        "config": { "access_level": "01", "algorithm": "custom",
                    "constant": "DEADC0DE5A3C", "script": "return seed ^ 0x1234ABCD;" }
    })];
    e.cmd_flowlib_save(&flow_file("sa2", 1, blocks)).unwrap();
    let v = nexus_mcp::tools_runs::flowlib_get(&e, "sa2", None).unwrap();
    let s = v.to_string();
    assert!(!s.contains("DEADC0DE5A3C"), "seed-key constant leaked");
    assert!(!s.contains("0x1234ABCD"), "seed-key script leaked");
}

// ─── 6. Diag redaction (mock0, armed, multi-frame) ──────────────────────────

/// Concatenated STRING values of a JSON page (bytes always travel as hex strings). Numeric
/// fields are skipped on purpose: a secret whose hex is all digits (e.g. `94 95 96` ->
/// "949596") would otherwise "match" a timestamp such as `"t_us":949596` (macOS CI flake).
fn string_values(page: &str) -> String {
    fn walk(v: &Value, out: &mut String) {
        match v {
            Value::String(s) => {
                out.push_str(s);
                out.push('\u{1}');
            }
            Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
            Value::Object(o) => o.iter().for_each(|(k, x)| {
                out.push_str(k);
                out.push('\u{1}');
                walk(x, out);
            }),
            _ => {}
        }
    }
    match serde_json::from_str::<Value>(page) {
        Ok(v) => {
            let mut out = String::new();
            walk(&v, &mut out);
            out
        }
        // Not JSON: keep the strict whole-text check.
        Err(_) => page.to_string(),
    }
}

fn windows_of(key: &[u8], n: usize) -> Vec<String> {
    key.windows(n)
        .map(|w| w.iter().map(|b| format!("{b:02X}")).collect::<String>())
        .collect()
}

/// Pages a tool with limit = 1 (conversation or isotp) and returns every page's JSON text.
fn page_all(e: &PipelineEngine, isotp: bool) -> Vec<String> {
    let sel = td::SessionSelector {
        bus_id: Some(0),
        request_id: Some("0x7E0".into()),
        response_id: Some("0x7E8".into()),
        is_extended: None,
    };
    let mut since = 0u64;
    let mut pages = Vec::new();
    for _ in 0..400 {
        let v = if isotp {
            td::diag_isotp_frames(
                e,
                &DiagIsoTpFramesArgs {
                    selector: sel.clone(),
                    since_seq: Some(since),
                    limit: Some(1),
                },
            )
        } else {
            td::diag_conversation(
                e,
                &DiagConversationArgs {
                    selector: sel.clone(),
                    since_seq: Some(since),
                    limit: Some(1),
                },
            )
        }
        .unwrap();
        let arr = v[if isotp { "frames" } else { "events" }]
            .as_array()
            .unwrap();
        if arr.is_empty() {
            break;
        }
        pages.push(v.to_string());
        since = v["next_since_seq"].as_u64().unwrap();
    }
    pages
}

#[test]
fn qa_m3_diag_security_access_and_auth_never_leak_across_pages() {
    let e = engine_at(&root_dir("diagred"));
    connect_mock0(&e);
    open_session(&e, 0x7E0, 0x7E8);

    // Distinctive 24-byte key (0x27 sendKey, level 2) -> FF + 3 CF; 20-byte 0x29 data.
    let key: Vec<u8> = (0..24u8).map(|i| 0xC0 + i).collect();
    let auth: Vec<u8> = (0..20u8).map(|i| 0x90 + i).collect();
    let stop = Arc::new(AtomicBool::new(false));
    // "ECU" role: spam Flow Control CTS on 0x7E8 so the tester's FF is answered (mock0 loops TX back).
    let spam = {
        let (e2, stop2) = (Arc::clone(&e), Arc::clone(&stop));
        std::thread::spawn(move || {
            while !stop2.load(Ordering::Relaxed) {
                let _ = e2.cmd_transmit_raw_frame(
                    0,
                    0x7E8,
                    false,
                    false,
                    false,
                    vec![0x30, 0x00, 0x00, 0x55, 0x55, 0x55, 0x55, 0x55],
                    None,
                    None,
                );
                std::thread::sleep(Duration::from_millis(2));
            }
        })
    };
    let opts = || serde_json::from_value(json!({ "timeoutMs": 300 })).ok();
    let _ = e.cmd_diag_send_uds(cfg7e0!(), 0x27, Some(0x02), key.clone(), opts());
    let _ = e.cmd_diag_send_uds(cfg7e0!(), 0x29, Some(0x01), auth.clone(), opts());
    let _ = e.cmd_diag_send_uds(cfg7e0!(), 0x22, None, vec![0xF1, 0x90], opts());
    stop.store(true, Ordering::Relaxed);
    spam.join().unwrap();

    // ECU -> tester multi-frame 0x67 seed response + 0x69 emulated with raw TX (loops back as RX):
    // FF carries 6 PDU bytes, CFs the rest; some CFs land on separate pages.
    let seed: Vec<u8> = (0..20u8).map(|i| 0xE0 + i).collect();
    let mut pdu = vec![0x67, 0x01];
    pdu.extend(&seed);
    let mut ff = vec![0x10, pdu.len() as u8];
    ff.extend(&pdu[..6]);
    let tx = |data: Vec<u8>| {
        e.cmd_transmit_raw_frame(0, 0x7E8, false, false, false, data, None, None)
            .unwrap()
    };
    tx(ff);
    for (n, chunk) in pdu[6..].chunks(7).enumerate() {
        let mut cf = vec![0x21 + n as u8];
        cf.extend(chunk);
        tx(cf);
    }
    std::thread::sleep(Duration::from_millis(150));

    // Raw engine truth: CFs of the TX key really exist (otherwise the test proves nothing).
    let raw = e
        .cmd_diag_get_isotp_frames(cfg7e0!(), 0, Some(2000))
        .unwrap();
    let cf_tx = raw
        .frames
        .iter()
        .filter(|f| f.data.first().is_some_and(|b| b >> 4 == 2))
        .count();
    let hex = |d: &[u8]| d.iter().map(|b| format!("{b:02X}")).collect::<String>();
    let raw_has_key = raw
        .frames
        .iter()
        .any(|f| hex(&f.data).contains(&windows_of(&key, 3)[5]));
    let raw_has_seed = raw
        .frames
        .iter()
        .any(|f| hex(&f.data).contains(&windows_of(&seed, 3)[5]));
    println!(
        "raw isotp frames={} CF={} raw_has_key_cf={raw_has_key} raw_has_seed_cf={raw_has_seed}",
        raw.frames.len(),
        cf_tx
    );
    assert!(
        cf_tx >= 3 && raw_has_key && raw_has_seed,
        "could not synthesize multi-frame traffic"
    );

    for (isotp, label) in [(true, "isotp"), (false, "conversation")] {
        let pages = page_all(&e, isotp);
        assert!(pages.len() > 4, "{label}: only {} pages", pages.len());
        for secret in [&key, &auth, &seed] {
            for w in windows_of(secret, 3) {
                for (i, p) in pages.iter().enumerate() {
                    let text = string_values(p);
                    assert!(
                        !text.contains(&w) && !text.contains(&w.to_ascii_lowercase()),
                        "{label} page {i} leaks secret window {w}: {p}"
                    );
                }
            }
        }
        // Also in one big page (limit max) and the non-secret DID read is still visible.
        let all = pages.join("\n");
        assert!(all.contains("<redacted>"), "{label}: nothing redacted?");
        println!("{label}: {} pages, no secret window found", pages.len());
    }
    // One big page.
    let big = td::diag_isotp_frames(
        &e,
        &DiagIsoTpFramesArgs {
            selector: td::SessionSelector {
                bus_id: Some(0),
                request_id: Some("0x7E0".into()),
                ..Default::default()
            },
            since_seq: None,
            limit: Some(200),
        },
    )
    .unwrap()
    .to_string();
    for w in windows_of(&key, 3)
        .into_iter()
        .chain(windows_of(&seed, 3))
        .chain(windows_of(&auth, 3))
    {
        assert!(!string_values(&big).contains(&w), "big page leaks {w}");
    }
    // Starting mid-stream (since_seq inside the CF run) must still fail closed.
    let first_cf_seq = raw
        .frames
        .iter()
        .find(|f| f.data.first().is_some_and(|b| b >> 4 == 2))
        .unwrap()
        .seq;
    let mid = td::diag_isotp_frames(
        &e,
        &DiagIsoTpFramesArgs {
            selector: td::SessionSelector {
                bus_id: Some(0),
                request_id: Some("0x7E0".into()),
                ..Default::default()
            },
            since_seq: Some(first_cf_seq - 1),
            limit: Some(200),
        },
    )
    .unwrap()
    .to_string();
    for w in windows_of(&key, 3).into_iter().chain(windows_of(&seed, 3)) {
        assert!(
            !string_values(&mid).contains(&w),
            "mid-stream page leaks {w}"
        );
    }
}

// ─── 7. RE disabled / unfocused ─────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn qa_m3_re_disabled_and_unfocused_are_explicit() {
    let e = engine_at(&root_dir("redis"));
    let (handle, client) = start(&e).await;
    let series =
        json!({ "bus_id": 0, "id": "0x123", "candidates": [{ "start_bit": 0, "bit_length": 8 }] });
    let corr = json!({ "bus_id": 0, "id": "0x123", "reference": { "kind": "obd_pid", "pid": 13 } });
    // RE disabled: documented as { enabled: false }, not an error, never a panic.
    for (tool, args) in [
        ("re_status", json!({})),
        ("re_series", series.clone()),
        ("re_correlate", corr.clone()),
        ("re_scan_results", json!({})),
        ("re_row_detail", json!({ "bus_id": 0, "id": "0x123" })),
    ] {
        let (err, t) = call(&client, tool, args)
            .await
            .unwrap_or_else(|p| panic!("{tool}: protocol error {p}"));
        let v: Value = serde_json::from_str(&t).unwrap_or_else(|_| panic!("{tool} not JSON: {t}"));
        println!(
            "RE disabled {tool}: is_error={err} {}",
            t.chars().take(110).collect::<String>()
        );
        assert!(t.len() <= CAP);
        assert!(
            !err && v["enabled"] == json!(false)
                || err && v["error"].as_str().is_some_and(|s| !s.is_empty()),
            "{tool}: {t}"
        );
    }
    assert!(!e.re_status().enabled, "MCP enabled RE");
    // RE running but nothing focused.
    e.cmd_re_start(None);
    for (tool, args) in [("re_series", series), ("re_correlate", corr)] {
        let (err, t) = call(&client, tool, args).await.unwrap();
        assert!(
            err && t.to_ascii_lowercase().contains("focus"),
            "{tool}: {t}"
        );
        assert!(
            t.contains("RE view"),
            "{tool} must tell the user to focus in the RE view: {t}"
        );
    }
    assert!(
        e.cmd_re_focus_status().targets.is_empty(),
        "MCP set a focus"
    );
    client.cancel().await.ok();
    handle.shutdown().await;
}

// ─── 8. Observer correlation never cancels the user's ───────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn qa_m3_observer_correlate_does_not_cancel_user_correlation() {
    let e = engine_at(&root_dir("obs"));
    start_re(&e, 6_000);
    let user_req: ReCorrelateRequest = serde_json::from_value(json!({
        "target": { "bus": 0, "arbId": 0x123, "isExtended": false },
        "reference": { "kind": "candidate",
            "target": { "bus": 0, "arbId": 0x123, "isExtended": false },
            "candidate": { "startBit": 16, "bitLength": 16, "byteOrder": "intel", "valueType": "unsigned", "factor": 1.0, "offset": 0.0 } },
        "fromUs": null, "toUs": null,
        "search": { "bitFrom": 0, "bitTo": 31, "lengths": [1, 12],
                    "byteOrders": ["intel"], "signed": [false] },
        "topN": 10
    }))
    .unwrap();
    let (handle, client) = start(&e).await;
    let e2 = Arc::clone(&e);
    let t_user = Instant::now();
    let user = std::thread::spawn(move || e2.cmd_re_correlate(user_req).unwrap());
    std::thread::sleep(Duration::from_millis(40));
    let mut observer_runs = 0;
    while !user.is_finished() && observer_runs < 6 {
        let (err, t) = call(
            &client,
            "re_correlate",
            json!({ "bus_id": 0, "id": "0x123", "bit_from": 0, "bit_to": 15, "min_length": 8, "max_length": 8,
                    "reference": { "kind": "candidate", "bus_id": 0, "id": "0x123",
                                   "candidate": { "start_bit": 16, "bit_length": 16 } } }),
        )
        .await
        .unwrap();
        assert!(!err, "{t}");
        observer_runs += 1;
    }
    let res = user.join().unwrap();
    let user_ms = t_user.elapsed().as_millis();
    println!(
        "user correlate: elapsed_ms={:.0} (wall {user_ms}) truncated={} rows={}; observer calls during={observer_runs}",
        res.elapsed_ms, res.truncated, res.rows.len()
    );
    assert!(
        observer_runs >= 1,
        "user sweep finished before any observer call: inconclusive"
    );
    // Only the 2 s wall budget may truncate the user's sweep, never an observer call.
    if res.elapsed_ms < 1_900.0 {
        assert!(
            !res.truncated,
            "observer call cancelled the user's correlation"
        );
    }
    client.cancel().await.ok();
    handle.shutdown().await;
}

// ─── 9. Concurrency ─────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn qa_m3_concurrent_calls_do_not_deadlock() {
    let e = engine_at(&root_dir("conc"));
    seed_runs_and_flows(&e);
    start_re(&e, 2_000);
    e.cmd_re_scan_first(
        serde_json::from_value::<ReScanFirstSpec>(json!({ "kind": "unknown" })).unwrap(),
    )
    .unwrap();
    connect_mock0(&e);
    open_session(&e, 0x7E0, 0x7E8);
    let (handle, client) = start(&e).await;
    let client = Arc::new(client);
    // Background pressure: the RE analyzer lock is hammered by ingestion while tools read it.
    let stop = Arc::new(AtomicBool::new(false));
    let bg = {
        let (e2, stop2) = (Arc::clone(&e), Arc::clone(&stop));
        std::thread::spawn(move || {
            let mut t = 100_000_000u64;
            while !stop2.load(Ordering::Relaxed) {
                {
                    let re = e2.re_shared();
                    let mut a = re.lock();
                    for _ in 0..200 {
                        t += 1_000;
                        a.ingest(&frame(0x123, &[1, 2, 3, 4, 5, 6, 7, 8], t));
                    }
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        })
    };
    let t0 = Instant::now();
    let mut set = tokio::task::JoinSet::new();
    for i in 0..8 {
        for (tool, args) in [
            ("re_scan_results", json!({ "limit": 100 })),
            ("diag_conversation", json!({ "limit": 100 })),
            ("diag_isotp_frames", json!({})),
            ("re_status", json!({})),
            ("run_query", json!({ "project_id": PROJECT })),
            ("flowlib_get", json!({ "id": "read_vin" })),
            ("re_row_detail", json!({ "bus_id": 0, "id": "0x123" })),
        ] {
            let c = Arc::clone(&client);
            set.spawn(async move {
                let r = call(&c, tool, args).await;
                (i, tool, r)
            });
        }
    }
    let mut done = 0;
    while let Some(r) = tokio::time::timeout(Duration::from_secs(5), set.join_next())
        .await
        .expect("deadlock: concurrent M3 calls did not finish within 5 s")
    {
        let (i, tool, r) = r.unwrap();
        let (err, t) = r.unwrap_or_else(|p| panic!("{tool}#{i}: {p}"));
        assert!(!err && t.len() <= CAP, "{tool}#{i}: {t}");
        done += 1;
    }
    let el = t0.elapsed();
    stop.store(true, Ordering::Relaxed);
    bg.join().unwrap();
    println!("{done} concurrent M3 calls finished in {el:?}");
    assert_eq!(done, 56);
    assert!(el < Duration::from_secs(5), "{el:?}");
    let _: BTreeSet<u8> = BTreeSet::new();
    handle.shutdown().await;
}
