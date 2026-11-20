//! MCP M1.1: per-bus database resolution, multi-database `db_info`, the new `db_list` /
//! `db_get_ecu` / `db_diagnostics` / `db_encode_frame` tools and multi-bus
//! `trace_signal_series`.

use base64::Engine as _;
use nexus_hal::dto::DbFileInputDto;
use nexus_hal::pipeline::PipelineEngine;
use nexus_hal::registry::DriverRegistry;
use nexus_hal::storage::DataRoot;
use nexus_mcp::dbsel::{DbScope, DbSet};
use nexus_mcp::tools_db;
use nexus_mcp::tools_trace::{self, TraceCache};
use nexus_mcp::McpConfig;
use rmcp::model::{CallToolRequestParams, ClientConfig};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const DBC_A: &str = r#"VERSION "A"

BU_: VCU BMS DASH

BO_ 416 VehicleStatus: 8 VCU
 SG_ Speed : 0|16@1+ (0.01,0) [0|300] "km/h" BMS,DASH
 SG_ Gear : 16|4@1+ (1,0) [0|7] "" DASH
 SG_ MotorTorque : 39|16@0- (0.1,0) [-3000|3000] "Nm" BMS

BO_ 2566848512 BmsCells: 64 BMS
 SG_ CellMux M : 0|8@1+ (1,0) [0|23] "" VCU
 SG_ CellV_0 m0 : 8|16@1+ (0.001,0) [0|5] "V" VCU
 SG_ CellV_1 m1 : 8|16@1+ (0.001,0) [0|5] "V" VCU

BO_ 300 Short: 2 VCU
 SG_ TooWide : 8|16@1+ (1,0) [10|0] "" BMS

CM_ BU_ BMS "Battery management system";
VAL_ 416 Gear 0 "P" 1 "R" 2 "N" 3 "D" ;
"#;

const DBC_B: &str = r#"VERSION "B"

BU_: MCU VCU

BO_ 688 MotorStatus: 8 MCU
 SG_ Speed : 0|16@1+ (0.1,0) [0|6000] "km/h" VCU
 SG_ Rpm : 16|16@1+ (1,0) [0|20000] "rpm" VCU
"#;

fn engine(tag: &str) -> Arc<PipelineEngine> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let root = DataRoot::under(std::env::temp_dir().join(format!(
        "nexus-mcp-m11-{tag}-{}-{nanos}",
        std::process::id()
    )));
    root.ensure_dirs().unwrap();
    Arc::new(PipelineEngine::with_data_root(DriverRegistry::new(), root))
}

fn file(name: &str, content: &str) -> DbFileInputDto {
    DbFileInputDto {
        file_name: name.to_string(),
        content_base64: base64::engine::general_purpose::STANDARD.encode(content),
    }
}

fn bind(engine: &PipelineEngine, bus: u8, name: &str, content: &str) {
    engine
        .cmd_set_bus_databases(bus, vec![file(name, content)])
        .expect("bind bus db");
}

fn load_global(engine: &PipelineEngine, name: &str, content: &str) {
    engine
        .cmd_load_database_content(
            name.to_string(),
            base64::engine::general_purpose::STANDARD.encode(content),
            false,
        )
        .expect("load global db");
}

fn find<'a>(arr: &'a Value, key: &str, name: &str) -> &'a Value {
    arr.as_array()
        .and_then(|a| a.iter().find(|v| v[key] == json!(name)))
        .unwrap_or_else(|| panic!("no {key}={name} in {arr}"))
}

fn approx(v: &Value, e: f64) {
    let x = v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"));
    assert!((x - e).abs() < 1e-6, "{x} != {e}");
}

// ─── Resolution rule ────────────────────────────────────────────────────────

#[test]
fn bus_only_database_is_used_without_bus_id() {
    let engine = engine("busonly");
    bind(&engine, 0, "a.dbc", DBC_A);
    assert!(engine.current_compiled_database().is_none(), "no global db");
    assert_eq!(engine.bus_databases().len(), 1);
    let set = DbSet::from_engine(&engine);

    let info = tools_db::db_info_all(&set);
    assert_eq!(info["loaded"], json!(true));
    assert_eq!(info["global"], Value::Null);
    assert_eq!(info["buses"][0]["bus_id"], json!(0));
    assert_eq!(info["buses"][0]["message_count"], json!(3));

    let sel = set.resolve(None).expect("single bus db is chosen");
    assert_eq!(sel.scope, DbScope::Bus(0));
    let s = tools_db::db_search_signals(Some(sel.db), "speed", 10)
        .map(|v| tools_db::with_database(v, &sel))
        .unwrap();
    assert_eq!(s["results"][0]["message"], json!("VehicleStatus"));
    assert_eq!(s["database"]["scope"], json!("bus"));
    assert_eq!(s["database"]["bus_id"], json!(0));
    assert!(set
        .resolve(Some(3))
        .err()
        .unwrap()
        .0
        .contains("bus 3 has no database"));
}

#[test]
fn two_bus_databases_require_bus_id() {
    let engine = engine("twobus");
    bind(&engine, 0, "a.dbc", DBC_A);
    bind(&engine, 1, "b.dbc", DBC_B);
    let set = DbSet::from_engine(&engine);
    let err = set.resolve(None).err().expect("ambiguous").0;
    assert!(err.contains("specify bus_id"), "{err}");
    assert!(err.contains("[0, 1]"), "{err}");
    let b1 = set.resolve(Some(1)).unwrap();
    let m = tools_db::db_get_message(Some(b1.db), None, Some("MotorStatus")).unwrap();
    assert_eq!(m["arb_id"], json!("0x2B0"));
    // Global wins over bus databases when present.
    load_global(&engine, "a.dbc", DBC_A);
    let set = DbSet::from_engine(&engine);
    assert_eq!(set.resolve(None).unwrap().scope, DbScope::Global);
    let info = tools_db::db_info_all(&set);
    assert_eq!(info["global"]["message_count"], json!(3));
    assert_eq!(info["buses"].as_array().unwrap().len(), 2);
}

#[test]
fn no_database_anywhere() {
    let engine = engine("nodb");
    let set = DbSet::from_engine(&engine);
    assert_eq!(tools_db::db_info_all(&set)["loaded"], json!(false));
    assert!(set
        .resolve(None)
        .err()
        .unwrap()
        .0
        .contains("No signal database"));
    assert_eq!(tools_db::db_list(&set, &[])["loaded_count"], json!(0));
}

// ─── New tools ──────────────────────────────────────────────────────────────

#[test]
fn db_list_get_ecu_and_diagnostics() {
    let engine = engine("newtools");
    load_global(&engine, "a.dbc", DBC_A);
    bind(&engine, 2, "b.dbc", DBC_B);
    let set = DbSet::from_engine(&engine);

    let l = tools_db::db_list(&set, &["preset.dbc".to_string()]);
    assert_eq!(l["loaded_count"], json!(2));
    assert_eq!(l["loaded"][0]["scope"], json!("global"));
    assert_eq!(l["loaded"][1]["bus_id"], json!(2));
    assert_eq!(l["loaded"][1]["signal_count"], json!(2));
    assert_eq!(l["preset_files"], json!(["preset.dbc"]));
    assert!(l["note"].as_str().unwrap().contains("cannot load"));

    let g = set.resolve(None).unwrap();
    let e = tools_db::db_get_ecu(&g, "bms").unwrap();
    assert_eq!(e["name"], json!("BMS"));
    assert_eq!(e["comment"], json!("Battery management system"));
    assert_eq!(e["tx_messages"][0]["name"], json!("BmsCells"));
    assert_eq!(e["tx_messages"][0]["arb_id"], json!("0x18FF0000"));
    let rx: Vec<&str> = e["rx_messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["name"].as_str().unwrap())
        .collect();
    assert_eq!(rx, ["VehicleStatus", "Short"]);
    assert_eq!(e["database"]["scope"], json!("global"));
    assert!(tools_db::db_get_ecu(&g, "Nope")
        .unwrap_err()
        .0
        .contains("ECUs: ["));
    let b2 = set.resolve(Some(2)).unwrap();
    assert_eq!(
        tools_db::db_get_ecu(&b2, "MCU").unwrap()["tx_messages"][0]["name"],
        json!("MotorStatus")
    );

    let d = tools_db::db_diagnostics(&g, None, 20).unwrap();
    let total = d["total"].as_u64().unwrap();
    assert!(
        total > 0,
        "Short.TooWide (bit span beyond DLC, inverted bounds) must produce diagnostics: {d}"
    );
    assert_eq!(d["matching"].as_u64().unwrap(), total);
    assert!(d["returned"].as_u64().unwrap() <= 20);
    let w = tools_db::db_diagnostics(&g, Some("warning"), 50).unwrap();
    assert!(w["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .all(|x| x["severity"] == json!("warning")));
    assert!(tools_db::db_diagnostics(&g, Some("fatal"), 5).is_err());
}

#[test]
fn encode_decode_round_trip_intel_motorola_clamp_and_mux() {
    let engine = engine("encode");
    load_global(&engine, "a.dbc", DBC_A);
    let set = DbSet::from_engine(&engine);
    let sel = set.resolve(None).unwrap();
    let sig = |pairs: &[(&str, f64)]| -> BTreeMap<String, f64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    };

    let e = tools_db::db_encode_frame(
        &sel,
        "0x1A0",
        &sig(&[("Speed", 100.0), ("MotorTorque", -123.4), ("Gear", 3.0)]),
    )
    .unwrap();
    assert_eq!(e["transmitted"], json!(false));
    assert_eq!(e["data_hex"], json!("10270300FB2E0000"));
    assert_eq!(e["dlc"], json!(8));
    assert_eq!(e["clamped_signals"], json!([]));
    // Round trip through the decoder tool.
    let d = tools_db::db_decode_frame(Some(sel.db), "0x1A0", None, e["data_hex"].as_str().unwrap())
        .unwrap();
    approx(&find(&d["signals"], "name", "Speed")["value"], 100.0);
    approx(&find(&d["signals"], "name", "MotorTorque")["value"], -123.4);
    assert_eq!(
        find(&d["signals"], "name", "Gear")["enum_label"],
        json!("D")
    );

    // Clamp: Speed above max 300 and torque below -3000; Gear not given -> default 0.
    let c = tools_db::db_encode_frame(
        &sel,
        "VehicleStatus",
        &sig(&[("speed", 999.0), ("MotorTorque", -5000.0)]),
    )
    .unwrap();
    assert_eq!(c["clamped_signals"], json!(["Speed", "MotorTorque"]));
    let speed = find(&c["signals"], "name", "Speed");
    approx(&speed["value"], 300.0);
    approx(&speed["requested"], 999.0);
    assert_eq!(speed["clamped"], json!(true));
    approx(
        &find(&c["signals"], "name", "MotorTorque")["value"],
        -3000.0,
    );
    assert_eq!(
        find(&c["signals"], "name", "Gear")["source"],
        json!("default_zero")
    );

    // Multiplexed CAN-FD message: selector filled automatically.
    let m = tools_db::db_encode_frame(&sel, "BmsCells", &sig(&[("CellV_1", 3.7)])).unwrap();
    assert_eq!(m["fd"], json!(true));
    assert_eq!(m["dlc"], json!(64));
    assert_eq!(
        m["active_mux"][0],
        json!({ "switch": "CellMux", "value": 1 })
    );
    assert_eq!(
        find(&m["signals"], "name", "CellMux")["source"],
        json!("mux_selector_auto")
    );
    assert!(m["data_hex"].as_str().unwrap().starts_with("01740E"));
    assert!(m["signals"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["name"] != json!("CellV_0")));
    // Conflicting selector is an encoder error.
    assert!(tools_db::db_encode_frame(
        &sel,
        "BmsCells",
        &sig(&[("CellV_1", 3.7), ("CellMux", 0.0)])
    )
    .is_err());

    // Errors: unknown signal, unknown message.
    let u = tools_db::db_encode_frame(&sel, "0x1A0", &sig(&[("Nope", 1.0)])).unwrap_err();
    assert!(
        u.0.contains("unknown signal") && u.0.contains("Speed"),
        "{}",
        u.0
    );
    assert!(tools_db::db_encode_frame(&sel, "0x7AB", &sig(&[])).is_err());
    assert!(tools_db::db_encode_frame(&sel, "NoSuchMessage", &sig(&[])).is_err());
}

// ─── Multi-bus trace_signal_series ──────────────────────────────────────────

fn multibus_trace() -> String {
    let mut out = String::new();
    for i in 0..50u64 {
        let t = 1_000_000 + i * 10_000;
        // bus 0: VehicleStatus Speed raw i*100 (0.01) -> i km/h
        let raw = (i * 100) as u16;
        let [a, b] = raw.to_le_bytes();
        out.push_str(&format!(
            "({}.{:06}) can0 1A0#{a:02X}{b:02X}000000000000\n",
            t / 1_000_000,
            t % 1_000_000
        ));
        // bus 1: MotorStatus Speed raw 1000 (0.1) -> 100 km/h, Rpm 3000
        let t1 = t + 5_000;
        out.push_str(&format!(
            "({}.{:06}) can1 2B0#E803B80B00000000\n",
            t1 / 1_000_000,
            t1 % 1_000_000
        ));
    }
    out
}

#[test]
fn trace_signal_series_decodes_each_bus_with_its_database() {
    let engine = engine("series");
    bind(&engine, 0, "a.dbc", DBC_A);
    bind(&engine, 1, "b.dbc", DBC_B);
    engine
        .cmd_save_trace_file("multi.log".into(), Some(multibus_trace()), None)
        .unwrap();
    let trace = TraceCache::default().load(&engine, "multi.log").unwrap();
    let set = DbSet::from_engine(&engine);

    // No bus_id: bus 0 frames via DBC A (0x1A0), bus 1 frames via DBC B (0x2B0).
    let all = tools_trace::trace_signal_series_multi(&trace, &set, None, "Speed", None, None, 500)
        .unwrap();
    assert_eq!(all["sample_count"], json!(100));
    assert_eq!(all["databases_used"].as_array().unwrap().len(), 2);
    approx(&all["min"], 0.0);
    approx(&all["max"], 100.0);

    let b1 =
        tools_trace::trace_signal_series_multi(&trace, &set, Some(1), "Speed", None, None, 500)
            .unwrap();
    assert_eq!(b1["sample_count"], json!(50));
    assert_eq!(b1["message"], json!("MotorStatus"));
    approx(&b1["mean"], 100.0);
    assert_eq!(b1["databases_used"][0]["database"]["bus_id"], json!(1));

    let rpm =
        tools_trace::trace_signal_series_multi(&trace, &set, None, "Rpm", None, None, 50).unwrap();
    assert_eq!(rpm["sample_count"], json!(50));
    approx(&rpm["mean"], 3000.0);

    assert!(
        tools_trace::trace_signal_series_multi(&trace, &set, Some(7), "Speed", None, None, 50)
            .is_err()
    );
    assert!(
        tools_trace::trace_signal_series_multi(&trace, &set, None, "Nope", None, None, 50).is_err()
    );
    assert!(tools_trace::trace_signal_series_multi(
        &trace,
        &DbSet::default(),
        None,
        "Speed",
        None,
        None,
        50
    )
    .is_err());
}

// ─── End to end: per-bus DB over MCP ────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn e2e_bus_bound_database_over_mcp() {
    let engine = engine("e2e");
    bind(&engine, 0, "a.dbc", DBC_A);
    let handle = nexus_mcp::start(
        Arc::clone(&engine),
        McpConfig { port: 0 },
        &tokio::runtime::Handle::current(),
    )
    .unwrap();
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(handle.endpoint_url())
            .auth_header(handle.token().to_string()),
    );
    let client = ClientConfig::default().serve(transport).await.unwrap();
    let call = |name: &'static str, args: Value| {
        let client = &client;
        async move {
            let mut p = CallToolRequestParams::new(name);
            if let Value::Object(m) = args {
                p = p.with_arguments(m);
            }
            let r = client.call_tool(p).await.unwrap();
            let v: Value = serde_json::from_str(&r.content[0].as_text().unwrap().text).unwrap();
            (r.is_error == Some(true), v)
        }
    };
    let (err, v) = call("db_info", json!({})).await;
    assert!(!err);
    assert_eq!(
        v["loaded"],
        json!(true),
        "bus-only database must be visible"
    );
    let (_, v) = call("db_search_signals", json!({ "query": "torque" })).await;
    assert_eq!(v["database"]["scope"], json!("bus"));
    let (_, v) = call(
        "db_encode_frame",
        json!({ "message": "0x1A0", "signals": { "Speed": 100, "MotorTorque": -123.4, "Gear": 3 } }),
    )
    .await;
    assert_eq!(v["data_hex"], json!("10270300FB2E0000"));
    let (err, v) = call("db_get_ecu", json!({ "name": "BMS", "bus_id": 5 })).await;
    assert!(err);
    assert!(v["error"].as_str().unwrap().contains("bus 5"));
    let (_, v) = call("db_list", json!({})).await;
    assert_eq!(v["loaded"][0]["bus_id"], json!(0));
    assert!(!v["preset_files"].as_array().unwrap().is_empty());
    let (_, v) = call("db_diagnostics", json!({ "severity": "warning" })).await;
    assert!(v.get("total").is_some());
    let _ = client.cancel().await;
    handle.shutdown().await;
}
