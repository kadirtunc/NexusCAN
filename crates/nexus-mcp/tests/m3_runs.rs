//! MCP M3 backend-C tools (`run_query`, `run_latest`, `flowlib_list`, `flowlib_get`): filters,
//! clamping, id validation (no traversal), truncation and the 16 KB cap; direct and over HTTP.
//! Records / flows are seeded through the engine write commands IN THE TEST ONLY.

use nexus_hal::pipeline::PipelineEngine;
use nexus_hal::registry::DriverRegistry;
use nexus_hal::runstore::{RunOutcome, RunRecordV1};
use nexus_hal::storage::DataRoot;
use nexus_mcp::tools_runs::{self, RunQuery};
use nexus_mcp::util::{ToolError, MAX_RESPONSE_BYTES};
use nexus_mcp::McpConfig;
use rmcp::model::{CallToolRequestParams, ClientConfig};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const PROJECT: &str = "proj-1";

fn engine(tag: &str) -> Arc<PipelineEngine> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let root = DataRoot::under(std::env::temp_dir().join(format!(
        "nexus-mcp-m3runs-{tag}-{}-{nanos}",
        std::process::id()
    )));
    root.ensure_dirs().unwrap();
    Arc::new(PipelineEngine::with_data_root(DriverRegistry::new(), root))
}

fn record(
    run_id: &str,
    ecu: Option<&str>,
    flow: &str,
    at: &str,
    outcome: RunOutcome,
) -> RunRecordV1 {
    let mut outputs = BTreeMap::new();
    outputs.insert("vin".to_string(), json!("WVWZZZ1JZXW000001"));
    RunRecordV1 {
        schema_version: 1,
        run_id: run_id.to_string(),
        parent_run_id: None,
        queue_id: None,
        project_id: PROJECT.to_string(),
        vehicle_id: None,
        ecu_id: ecu.map(str::to_string),
        ecu_name: ecu.map(|e| format!("ECU {e}")),
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
        nrc: (outcome == RunOutcome::Fail).then_some(0x31),
        error_message: None,
        log_excerpt: vec!["SECRET-LOG-LINE".to_string(); 3],
        operator: None,
        device_id: "dev-1".to_string(),
        app_version: "0.1.0".to_string(),
    }
}

fn seed_runs(e: &PipelineEngine) {
    let rows = [
        (
            "r1",
            Some("ecu-a"),
            "read_vin",
            "2026-10-01T10:00:00.000Z",
            RunOutcome::Ok,
        ),
        (
            "r2",
            Some("ecu-a"),
            "read_vin",
            "2026-11-01T10:00:00.000Z",
            RunOutcome::Fail,
        ),
        (
            "r3",
            Some("ecu-b"),
            "read_vin",
            "2026-11-02T10:00:00.000Z",
            RunOutcome::Ok,
        ),
        (
            "r4",
            Some("ecu-a"),
            "flash",
            "2026-11-03T10:00:00.000Z",
            RunOutcome::Error,
        ),
        (
            "r5",
            None,
            "read_vin",
            "2026-11-04T10:00:00.000Z",
            RunOutcome::Ok,
        ),
    ];
    for (id, ecu, flow, at, o) in rows {
        e.cmd_run_append(&record(id, ecu, flow, at, o))
            .expect("append");
    }
}

fn flow_file(id: &str, revision: u64, blocks: Vec<Value>) -> String {
    json!({
        "schemaVersion": 1,
        "kind": "nexuscan.flow",
        "flow": {
            "id": id,
            "revision": revision,
            "name": format!("Flow {id}"),
            "description": "test flow",
            "createdAt": "2026-11-18T10:00:00.000Z",
            "updatedAt": format!("2026-11-18T10:00:{:02}.000Z", revision % 60),
            "author": null,
            "origin": "user",
            "aiReviewed": false,
            "tags": ["uds"],
            "variables": [{ "name": "x", "type": "number", "initial": "0" }],
            "blocks": blocks,
            "connections": [{ "id": "c1", "fromBlockId": "b1", "fromPortId": "exec_out", "toBlockId": "b2", "toPortId": "exec_in" }],
        },
        "contentHash": format!("{:x}", revision % 16).repeat(64),
    })
    .to_string()
}

fn uds_blocks() -> Vec<Value> {
    vec![
        json!({ "id": "b1", "type": "uds_session", "label": "Ext", "config": { "session_type": "extended" } }),
        json!({ "id": "b2", "type": "uds_read_did", "label": "VIN", "config": { "did": "F190" } }),
        json!({ "id": "b3", "type": "uds_read_did", "label": "SW", "config": { "did": "0xf188" } }),
        json!({ "id": "b4", "type": "uds_routine_ctrl", "label": "Erase", "config": { "control_type": "01", "routine_id": "FF00" } }),
        json!({ "id": "b5", "type": "call:helper", "label": "Helper", "config": {} }),
    ]
}

fn seed_flows(e: &PipelineEngine) {
    e.cmd_flowlib_save(&flow_file("read_vin", 1, uds_blocks()))
        .expect("save r1");
    e.cmd_flowlib_save(&flow_file("read_vin", 2, uds_blocks()))
        .expect("save r2");
    e.cmd_flowlib_save(&flow_file("old_flow", 1, vec![]))
        .expect("save old");
    e.cmd_flowlib_delete("old_flow").expect("delete");
    // ~60 KB flow: never fits the response cap.
    let big: Vec<Value> = (0..300)
        .map(|i| json!({ "id": format!("b{i}"), "type": "log", "label": "L".repeat(200), "config": { "message": "m" } }))
        .collect();
    e.cmd_flowlib_save(&flow_file("big_flow", 1, big))
        .expect("save big");
}

fn cap_ok(v: &Value) {
    assert!(serde_json::to_string(v).unwrap().len() <= MAX_RESPONSE_BYTES);
}

fn ids(v: &Value) -> Vec<String> {
    v["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["run_id"].as_str().unwrap().to_string())
        .collect()
}

fn q(f: impl FnOnce(&mut RunQuery)) -> RunQuery {
    let mut q = RunQuery {
        project_id: PROJECT.to_string(),
        ..RunQuery::default()
    };
    f(&mut q);
    q
}

#[test]
fn run_query_filters_and_clamps() {
    let e = engine("query");
    seed_runs(&e);
    let v = tools_runs::run_query(&e, &q(|_| {})).unwrap();
    cap_ok(&v);
    assert_eq!(ids(&v), ["r5", "r4", "r3", "r2", "r1"]);
    let s = serde_json::to_string(&v).unwrap();
    assert!(
        !s.contains("SECRET-LOG-LINE") && !s.contains("WVWZZZ"),
        "no raw dumps"
    );
    assert_eq!(v["runs"][0]["counts"]["log_lines"], 3);
    assert_eq!(v["runs"][0]["output_keys"], json!(["vin"]));

    let v = tools_runs::run_query(&e, &q(|q| q.ecu_id = Some("ecu-a".into()))).unwrap();
    assert_eq!(ids(&v), ["r4", "r2", "r1"]);
    let v = tools_runs::run_query(&e, &q(|q| q.flow_id = Some("flash".into()))).unwrap();
    assert_eq!(ids(&v), ["r4"]);
    let v = tools_runs::run_query(&e, &q(|q| q.status = Some("FAIL".into()))).unwrap();
    assert_eq!(ids(&v), ["r2"]);
    assert_eq!(v["runs"][0]["nrc"], "0x31");
    let v = tools_runs::run_query(
        &e,
        &q(|q| {
            q.from = Some("2026-11-01T10:00:00Z".into());
            q.to = Some("2026-11-03T10:00:00Z".into());
        }),
    )
    .unwrap();
    assert_eq!(ids(&v), ["r3", "r2"], "from inclusive, to exclusive");

    let v = tools_runs::run_query(&e, &q(|q| q.limit = Some(0))).unwrap();
    assert_eq!(v["limit"], 1);
    assert_eq!(ids(&v), ["r5"]);
    let v = tools_runs::run_query(&e, &q(|q| q.limit = Some(1_000_000))).unwrap();
    assert_eq!(v["limit"], 50);

    // Unknown project: empty, and no directory is created by the query.
    let v = tools_runs::run_query(&e, &q(|q| q.project_id = "nobody".into())).unwrap();
    assert_eq!(v["count"], 0);
    assert!(!e.data_root().runs_dir().join("nobody").exists());
}

#[test]
fn run_query_rejects_bad_input_with_clipped_echo() {
    let e = engine("bad");
    seed_runs(&e);
    let long = "x/".repeat(5000);
    for pid in ["../etc", "a b", "", long.as_str()] {
        let ToolError(msg) =
            tools_runs::run_query(&e, &q(|q| q.project_id = pid.to_string())).unwrap_err();
        assert!(
            msg.starts_with("[runstore:invalid] invalid projectId"),
            "{msg}"
        );
        assert!(msg.chars().count() < 200, "{msg}");
    }
    let ToolError(msg) =
        tools_runs::run_query(&e, &q(|q| q.status = Some("loud".into()))).unwrap_err();
    assert!(msg.contains("panic_stop"));
    let long_ts = "9".repeat(10_000);
    let ToolError(msg) =
        tools_runs::run_query(&e, &q(|q| q.from = Some(long_ts.clone()))).unwrap_err();
    assert!(msg.starts_with("[runstore:invalid]"), "{msg}");
    assert!(msg.chars().count() < 200, "{msg}");
    let ToolError(msg) = tools_runs::run_latest(&e, &long).unwrap_err();
    assert!(msg.chars().count() < 200);
}

#[test]
fn run_latest_per_ecu_and_flow() {
    let e = engine("latest");
    seed_runs(&e);
    let v = tools_runs::run_latest(&e, PROJECT).unwrap();
    cap_ok(&v);
    // (ecu-a, read_vin) -> r2 (newer than r1); null ECU is its own key.
    assert_eq!(ids(&v), ["r5", "r4", "r3", "r2"]);
    assert_eq!(v["total"], 4);
}

#[test]
fn flowlib_list_and_get() {
    let e = engine("flowlib");
    // Empty library: no directory is created.
    let v = tools_runs::flowlib_list(&e, true).unwrap();
    assert_eq!(v["count"], 0);
    assert!(!e.data_root().flowlib_dir().exists());

    seed_flows(&e);
    let v = tools_runs::flowlib_list(&e, false).unwrap();
    cap_ok(&v);
    let names: Vec<&str> = v["flows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"read_vin") && !names.contains(&"old_flow"));
    let v = tools_runs::flowlib_list(&e, true).unwrap();
    let rows = v["flows"].as_array().unwrap();
    let old = rows
        .iter()
        .find(|f| f["id"] == "old_flow")
        .expect("deleted listed");
    assert_eq!(old["deleted"], true);
    let rv = rows.iter().find(|f| f["id"] == "read_vin").unwrap();
    assert_eq!(rv["revision_count"], 2);
    assert_eq!(rv["latest_revision"], 2);

    // Latest revision: structure + raw JSON (fits).
    let v = tools_runs::flowlib_get(&e, "read_vin", None).unwrap();
    cap_ok(&v);
    assert_eq!(v["revision"], 2);
    assert_eq!(v["revisions"][0]["revision"], 2, "newest first");
    assert_eq!(v["revision_count"], 2);
    let st = &v["structure"];
    assert_eq!(st["kind"], "nexuscan.flow");
    assert_eq!(st["block_count"], 5);
    assert_eq!(st["connection_count"], 1);
    assert_eq!(st["variable_count"], 1);
    assert_eq!(st["dids"]["items"], json!(["0xF188", "0xF190"]));
    assert_eq!(st["routine_ids"]["items"], json!(["0xFF00"]));
    assert_eq!(st["library_calls"]["items"], json!(["helper"]));
    let sids: Vec<&str> = st["uds_services"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["sid"].as_str().unwrap())
        .collect();
    assert_eq!(sids, ["0x10", "0x22", "0x31"]);
    assert!(v["raw_json"].as_str().unwrap().contains("\"revision\":2"));
    assert!(v.get("truncated").is_none());

    // Explicit older revision.
    let v = tools_runs::flowlib_get(&e, "read_vin", Some(1)).unwrap();
    assert_eq!(v["revision"], 1);
    assert!(v["raw_json"].as_str().unwrap().contains("\"revision\":1"));
    let ToolError(msg) = tools_runs::flowlib_get(&e, "read_vin", Some(9)).unwrap_err();
    assert!(msg.contains("no revision 9"), "{msg}");

    // Deleted ids still resolve.
    let v = tools_runs::flowlib_get(&e, "old_flow", None).unwrap();
    assert_eq!(v["metadata"]["deleted"], true);

    // Oversized flow: summary present, raw omitted, truncated.
    let v = tools_runs::flowlib_get(&e, "big_flow", None).unwrap();
    cap_ok(&v);
    assert_eq!(v["truncated"], true);
    assert!(v["raw_json"].is_null());
    assert_eq!(v["structure"]["block_count"], 300);
    assert!(v["raw_json_bytes"].as_u64().unwrap() > MAX_RESPONSE_BYTES as u64);
}

#[test]
fn flowlib_get_rejects_unknown_and_traversal_ids() {
    let e = engine("ids");
    seed_flows(&e);
    let ToolError(msg) = tools_runs::flowlib_get(&e, "nope", None).unwrap_err();
    assert!(
        msg.starts_with("[flowlib:not_found] unknown flow id 'nope'"),
        "{msg}"
    );
    let long = "../".repeat(5000);
    for bad in [
        "../x",
        "read_vin/../../etc",
        "a.b",
        "",
        "/etc/passwd",
        long.as_str(),
    ] {
        let ToolError(msg) = tools_runs::flowlib_get(&e, bad, None).unwrap_err();
        assert!(
            msg.starts_with("[flowlib:invalid] invalid flow id"),
            "{msg}"
        );
        assert!(msg.chars().count() < 260, "{msg}");
    }
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
async fn e2e_runs_tools() {
    let e = engine("e2e");
    seed_runs(&e);
    seed_flows(&e);
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
    for n in ["run_query", "run_latest", "flowlib_list", "flowlib_get"] {
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

    let (err, v) = call(
        &client,
        "run_query",
        json!({ "project_id": PROJECT, "limit": 2 }),
    )
    .await;
    assert!(!err && v["count"] == 2, "{v}");
    let (err, v) = call(&client, "run_latest", json!({ "project_id": PROJECT })).await;
    assert!(!err && v["count"] == 4, "{v}");
    let (err, v) = call(&client, "flowlib_list", json!({ "include_deleted": true })).await;
    assert!(!err && v["count"] == 3, "{v}");
    let (err, v) = call(&client, "flowlib_get", json!({ "id": "big_flow" })).await;
    assert!(!err && v["truncated"] == true);
    let (err, v) = call(&client, "flowlib_get", json!({ "id": "../x" })).await;
    assert!(err && v["error"].as_str().unwrap().contains("invalid flow id"));
    let (err, _) = call(&client, "run_query", json!({ "project_id": "../../etc" })).await;
    assert!(err);

    client.cancel().await.ok();
    handle.shutdown().await;
}

#[test]
fn flowlib_get_redacts_secrets() {
    let e = engine("redact");
    let blocks = vec![
        json!({ "id": "b1", "type": "uds_security_access", "label": "SA", "config": { "level": "01" } }),
        json!({ "id": "b2", "type": "uds_seed_validator", "label": "Key", "config": { "expected_key": "C9A8BEEF", "algorithm": "xor_ff" } }),
    ];
    e.cmd_flowlib_save(&flow_file("sa_flow", 1, blocks))
        .expect("save");
    let v = tools_runs::flowlib_get(&e, "sa_flow", None).unwrap();
    cap_ok(&v);
    let s = serde_json::to_string(&v).unwrap();
    assert!(!s.contains("C9A8BEEF"), "key bytes leaked: {s}");
    assert!(v["raw_json"].as_str().unwrap().contains("<redacted>"));
    assert_eq!(v["redacted"], true);
    assert_eq!(
        v["redactedFields"],
        json!(["/flow/blocks/1/config/expected_key"])
    );
    assert_eq!(v["structure"]["uds_services"][0]["sid"], "0x27");
}
