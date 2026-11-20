//! UI Bridge (co-pilot) tools over MCP with a fake `UiBridge`: forwarding, validation and
//! clipping, not-attached, timeouts (incl. `ui_confirm` -> timedOut), rate limit, audit and
//! tool annotations.

use nexus_hal::pipeline::PipelineEngine;
use nexus_hal::registry::DriverRegistry;
use nexus_hal::storage::DataRoot;
use nexus_mcp::{McpConfig, UiBridge, UiFuture, UI_NOT_ATTACHED, UI_TIMEOUT};
use parking_lot::Mutex;
use rmcp::model::{CallToolRequestParams, ClientConfig};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type Responder = dyn Fn(&str, &Value, Duration) -> Result<Value, String> + Send + Sync;

struct FakeUi {
    attached: AtomicBool,
    calls: Mutex<Vec<(String, Value, Duration)>>,
    respond: Box<Responder>,
}

impl FakeUi {
    fn new(
        respond: impl Fn(&str, &Value, Duration) -> Result<Value, String> + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            attached: AtomicBool::new(true),
            calls: Mutex::new(Vec::new()),
            respond: Box::new(respond),
        })
    }

    fn calls(&self) -> Vec<(String, Value, Duration)> {
        self.calls.lock().clone()
    }
}

impl UiBridge for FakeUi {
    fn call(&self, kind: &str, args: Value, timeout: Duration) -> UiFuture {
        self.calls
            .lock()
            .push((kind.to_string(), args.clone(), timeout));
        let r = (self.respond)(kind, &args, timeout);
        Box::pin(async move { r })
    }

    fn attached(&self) -> bool {
        self.attached.load(Ordering::Relaxed)
    }
}

fn engine(tag: &str) -> Arc<PipelineEngine> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let root = DataRoot::under(
        std::env::temp_dir().join(format!("nexus-mcp-ui-{tag}-{}-{nanos}", std::process::id())),
    );
    root.ensure_dirs().unwrap();
    Arc::new(PipelineEngine::with_data_root(DriverRegistry::new(), root))
}

type Client = rmcp::service::RunningService<rmcp::RoleClient, ClientConfig>;

async fn setup(
    tag: &str,
    ui: Option<Arc<FakeUi>>,
) -> (Arc<PipelineEngine>, nexus_mcp::McpServerHandle, Client) {
    let engine = engine(tag);
    let handle = nexus_mcp::start_with_ui(
        Arc::clone(&engine),
        McpConfig { port: 0 },
        ui.map(|u| u as Arc<dyn UiBridge>),
        &tokio::runtime::Handle::current(),
    )
    .unwrap();
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(handle.endpoint_url())
            .auth_header(handle.token().to_string()),
    );
    let client = ClientConfig::default().serve(transport).await.unwrap();
    (engine, handle, client)
}

async fn call(client: &Client, name: &str, args: Value) -> (bool, Value) {
    let mut p = CallToolRequestParams::new(name.to_string());
    if let Value::Object(m) = args {
        p = p.with_arguments(m);
    }
    let r = client.call_tool(p).await.expect("call_tool");
    let v = serde_json::from_str(&r.content[0].as_text().unwrap().text).unwrap();
    (r.is_error == Some(true), v)
}

fn default_responder(kind: &str, args: &Value, _t: Duration) -> Result<Value, String> {
    Ok(match kind {
        "get_state" => json!({
            "activeView": "trace", "subTab": null,
            "selectedMessage": { "busId": 0, "arbId": "0x1A0", "name": "VehicleStatus" },
            "plotSignals": ["Speed"], "traceFilterIds": null,
            "activeTraceSession": "drive.log", "theme": "dark"
        }),
        "select_message" => json!({ "found": true, "name": "VehicleStatus" }),
        "plot_signals" => json!({ "plotSignals": args["add"], "unknown": [] }),
        "confirm" => json!({ "confirmed": true }),
        _ => json!({ "ok": true }),
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ui_tools_forward_validated_args() {
    let ui = FakeUi::new(default_responder);
    let (_e, handle, client) = setup("fwd", Some(Arc::clone(&ui))).await;
    assert!(handle.status().ui_attached);

    let (err, v) = call(&client, "ui_get_state", json!({})).await;
    assert!(!err);
    assert_eq!(v["activeView"], json!("trace"));

    let (err, _) = call(
        &client,
        "ui_navigate",
        json!({ "view": "diagnostics", "subTab": "uds_console" }),
    )
    .await;
    assert!(!err);
    let (err, v) = call(
        &client,
        "ui_select_message",
        json!({ "arbId": "416", "busId": 0 }),
    )
    .await;
    assert!(!err);
    assert_eq!(v, json!({ "found": true, "name": "VehicleStatus" }));
    let (err, _) = call(&client, "ui_trace_filter", json!({ "ids": null })).await;
    assert!(!err);
    let (_, v) = call(
        &client,
        "ui_plot_signals",
        json!({ "add": ["Speed", "Rpm"] }),
    )
    .await;
    assert_eq!(v["plotSignals"], json!(["Speed", "Rpm"]));
    let (err, _) = call(
        &client,
        "ui_notify",
        json!({ "level": "success", "text": "x".repeat(300) }),
    )
    .await;
    assert!(!err);
    let (_, v) = call(
        &client,
        "ui_confirm",
        json!({ "title": "Open trace?", "message": "Switch to the Trace view?" }),
    )
    .await;
    assert_eq!(v, json!({ "confirmed": true }));

    let calls = ui.calls();
    let kinds: Vec<&str> = calls.iter().map(|c| c.0.as_str()).collect();
    assert_eq!(
        kinds,
        [
            "get_state",
            "navigate",
            "select_message",
            "trace_filter",
            "plot_signals",
            "notify",
            "confirm"
        ]
    );
    assert_eq!(calls[0].1, json!({}));
    assert_eq!(
        calls[1].1,
        json!({ "view": "diagnostics", "subTab": "uds_console" })
    );
    assert_eq!(
        calls[2].1,
        json!({ "arbId": "0x1A0", "isExtended": false, "busId": 0 })
    );
    assert_eq!(calls[3].1, json!({ "ids": null }));
    assert_eq!(calls[5].1["text"].as_str().unwrap().chars().count(), 201);
    assert_eq!(calls[0].2, Duration::from_secs(5));
    assert_eq!(calls[6].2, Duration::from_secs(60));
    assert_eq!(handle.status().total_calls, 7);
    let _ = client.cancel().await;
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_args_are_rejected_before_reaching_the_ui() {
    let ui = FakeUi::new(default_responder);
    let (_e, handle, client) = setup("invalid", Some(Arc::clone(&ui))).await;
    let cases = [
        ("ui_navigate", json!({ "view": "symbols", "subTab": "dtc" })),
        (
            "ui_navigate",
            json!({ "view": "trace", "subTab": "messages" }),
        ),
        ("ui_navigate", json!({ "view": "settings" })),
        ("ui_select_message", json!({ "arbId": "zz" })),
        ("ui_trace_filter", json!({ "ids": vec!["0x1"; 65] })),
        ("ui_plot_signals", json!({})),
        ("ui_plot_signals", json!({ "add": vec!["s"; 17] })),
        ("ui_notify", json!({ "level": "error", "text": "x" })),
        ("ui_confirm", json!({ "title": "", "message": "m" })),
    ];
    for (tool, args) in cases {
        let (err, v) = call(&client, tool, args.clone()).await;
        assert!(err, "{tool} {args} must fail: {v}");
        assert!(v["error"].is_string(), "{v}");
    }
    assert!(ui.calls().is_empty(), "nothing invalid reaches the UI");
    let _ = client.cancel().await;
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn not_attached_and_no_bridge() {
    let ui = FakeUi::new(default_responder);
    ui.attached.store(false, Ordering::Relaxed);
    let (_e, handle, client) = setup("detached", Some(Arc::clone(&ui))).await;
    assert!(!handle.status().ui_attached);
    let (err, v) = call(&client, "ui_get_state", json!({})).await;
    assert!(err);
    assert_eq!(v, json!({ "error": UI_NOT_ATTACHED }));
    assert!(ui.calls().is_empty());
    let _ = client.cancel().await;
    handle.shutdown().await;

    let (_e, handle, client) = setup("nobridge", None).await;
    let (err, v) = call(
        &client,
        "ui_notify",
        json!({ "level": "info", "text": "hi" }),
    )
    .await;
    assert!(err);
    assert_eq!(v["error"], json!(UI_NOT_ATTACHED));
    let _ = client.cancel().await;
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn timeouts_and_ui_errors() {
    let ui = FakeUi::new(|kind, _, _| match kind {
        "confirm" | "get_state" => Err(UI_TIMEOUT.to_string()),
        _ => Err(format!("frontend failed: {}", "y".repeat(5000))),
    });
    let (_e, handle, client) = setup("timeout", Some(Arc::clone(&ui))).await;
    let (err, v) = call(
        &client,
        "ui_confirm",
        json!({ "title": "t", "message": "m", "confirmLabel": "Go" }),
    )
    .await;
    assert!(!err);
    assert_eq!(v, json!({ "confirmed": false, "timedOut": true }));
    let (err, v) = call(&client, "ui_get_state", json!({})).await;
    assert!(err);
    assert_eq!(v["error"], json!(UI_TIMEOUT));
    let (err, v) = call(&client, "ui_navigate", json!({ "view": "plotter" })).await;
    assert!(err);
    assert!(
        v["error"].as_str().unwrap().chars().count() <= 513,
        "UI errors are clipped"
    );
    let _ = client.cancel().await;
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ui_calls_are_rate_limited_and_audited() {
    let ui = FakeUi::new(default_responder);
    let (engine, handle, client) = setup("rate", Some(Arc::clone(&ui))).await;
    let mut limited = 0;
    for _ in 0..15 {
        let (err, v) = call(&client, "ui_get_state", json!({})).await;
        if err && v["error"].as_str().unwrap().contains("rate limit") {
            limited += 1;
        }
    }
    assert!(
        limited >= 4,
        "at most ~10 ui calls per second ({limited} limited)"
    );
    assert!(ui.calls().len() <= 11);
    assert_eq!(handle.status().total_calls, 15);
    let _ = client.cancel().await;
    handle.shutdown().await;
    let audited = engine
        .snapshot_debug_events()
        .events
        .iter()
        .filter(|e| {
            e.category == "MCP"
                && (e.title.contains("ui_get_state") || e.action == "mcp.tool_calls_suppressed")
        })
        .count();
    assert!(audited >= 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_list_annotations_and_schemas() {
    let (_e, handle, client) = setup("list", None).await;
    let tools = client.list_all_tools().await.unwrap();
    assert_eq!(tools.len(), 46);
    let get = |n: &str| tools.iter().find(|t| t.name == n).unwrap();
    let ann = |n: &str| get(n).annotations.clone().unwrap();
    assert_eq!(ann("ui_get_state").read_only_hint, Some(true));
    for n in [
        "ui_navigate",
        "ui_select_message",
        "ui_trace_filter",
        "ui_plot_signals",
        "ui_notify",
        "ui_confirm",
    ] {
        assert_eq!(ann(n).read_only_hint, Some(false), "{n}");
        assert_eq!(ann(n).destructive_hint, Some(false), "{n}");
    }
    for t in tools.iter().filter(|t| !t.name.starts_with("ui_")) {
        assert_eq!(
            t.annotations.as_ref().unwrap().read_only_hint,
            Some(true),
            "{}",
            t.name
        );
    }
    let schema = serde_json::to_string(&get("ui_navigate").input_schema).unwrap();
    for v in ["\"diagnostics\"", "\"rxtx\"", "\"uds_console\"", "\"ecus\""] {
        assert!(schema.contains(v), "ui_navigate schema lists {v}: {schema}");
    }
    assert!(get("db_encode_frame")
        .description
        .as_deref()
        .unwrap()
        .contains("does NOT transmit"));
    let _ = client.cancel().await;
    handle.shutdown().await;
}
