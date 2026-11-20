//! MCP M3 backend-B: read-only Reverse-Engineering tools. Frames are fed straight into the RE
//! analyzer (`re_shared().lock().ingest`) so results are deterministic; the test (not MCP)
//! starts RE and focuses targets through the engine API, the way the user would in the RE view.

use nexus_core::{CanIdKey, RawCanFrame};
use nexus_hal::pipeline::re_analyzer::{ReScanFirstSpec, ReSeriesRequest, ReTargetDto};
use nexus_hal::pipeline::PipelineEngine;
use nexus_hal::registry::DriverRegistry;
use nexus_hal::storage::DataRoot;
use nexus_mcp::tools_re::{
    self as tr, decode_nrs1, ReCorrelateArgs, ReDbcGenerateArgs, ReRowDetailArgs,
    ReScanResultsArgs, ReSeriesArgs, MAX_SCAN_RESULTS,
};
use nexus_mcp::util::MAX_RESPONSE_BYTES;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

fn engine(tag: &str) -> Arc<PipelineEngine> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let root = DataRoot::under(std::env::temp_dir().join(format!(
        "nexus-mcp-m3re-{tag}-{}-{nanos}",
        std::process::id()
    )));
    root.ensure_dirs().unwrap();
    Arc::new(PipelineEngine::with_data_root(
        DriverRegistry::with_builtin_drivers(),
        root,
    ))
}

fn frame(id: u16, data: &[u8], ts: u64) -> RawCanFrame {
    RawCanFrame::new_classical(0, CanIdKey::new_standard(id).unwrap(), data, ts).unwrap()
}

const T0: u64 = 1_000_000;

/// RE started, 0x123 focused, 200 frames (10 ms) with byte0 = counter, bytes 2..3 = ramp.
fn re_engine(tag: &str) -> Arc<PipelineEngine> {
    let e = engine(tag);
    e.cmd_re_start(None);
    e.cmd_re_focus_set(vec![ReTargetDto {
        bus: 0,
        arb_id: 0x123,
        is_extended: false,
    }])
    .expect("focus");
    {
        let re = e.re_shared();
        let mut a = re.lock();
        for i in 0..200u64 {
            let ramp = (i * 10) as u16;
            let r = ramp.to_le_bytes();
            a.ingest(&frame(
                0x123,
                &[i as u8, 0xAA, r[0], r[1], 0, 0, 0, 0],
                T0 + i * 10_000,
            ));
            a.ingest(&frame(0x200, &[0x11, (i % 3) as u8], T0 + i * 10_000 + 5));
        }
    }
    e
}

fn json_size(v: &Value) -> usize {
    serde_json::to_string(v).unwrap().len()
}

fn series_args(v: Value) -> ReSeriesArgs {
    serde_json::from_value(v).unwrap()
}

// ─── Status ─────────────────────────────────────────────────────────────────

#[test]
fn status_with_re_disabled_is_not_an_error() {
    let e = engine("status-off");
    let v = tr::re_status(&e).unwrap();
    assert_eq!(v["enabled"], json!(false), "{v}");
    assert!(v["message"].as_str().unwrap().contains("not running"));
    assert_eq!(v["markers"], json!([]));
    assert_eq!(v["scan"]["active"], json!(false));
    // Series / correlate / scan answer enabled=false instead of failing.
    let s = tr::re_series(
        &e,
        &series_args(json!({ "bus_id": 0, "id": "0x123", "candidates": [{ "start_bit": 0, "bit_length": 8 }] })),
    )
    .unwrap();
    assert_eq!(s["enabled"], json!(false), "{s}");
    let c: ReCorrelateArgs = serde_json::from_value(json!({
        "bus_id": 0, "id": "0x123", "reference": { "kind": "markers", "points": [] }
    }))
    .unwrap();
    assert_eq!(tr::re_correlate(&e, &c).unwrap()["enabled"], json!(false));
    let r = tr::re_scan_results(&e, &ReScanResultsArgs::default()).unwrap();
    assert_eq!(r["enabled"], json!(false));
    let d = tr::re_row_detail(
        &e,
        &serde_json::from_value::<ReRowDetailArgs>(json!({ "bus_id": 0, "id": "0x1" })).unwrap(),
    )
    .unwrap();
    assert_eq!(d["enabled"], json!(false));
    // The tool itself never started RE.
    assert!(!e.re_status().enabled);
}

#[test]
fn status_running_lists_focus_and_markers_newest_first_capped() {
    let e = re_engine("status-on");
    for i in 0..60 {
        e.cmd_re_mark(&format!("m{i}"));
    }
    let v = tr::re_status(&e).unwrap();
    assert_eq!(v["enabled"], json!(true));
    assert_eq!(v["rows"], json!(2));
    assert_eq!(v["markers_total"], json!(60));
    let m = v["markers"].as_array().unwrap();
    assert_eq!(m.len(), tr::MAX_STATUS_MARKERS);
    assert_eq!(m[0]["label"], json!("m59"));
    assert_eq!(v["focus"][0]["id"], json!("0x123"));
    assert_eq!(v["focus"][0]["samples"], json!(200));
    assert!(json_size(&v) <= MAX_RESPONSE_BYTES);
}

// ─── NRS1 decoder ───────────────────────────────────────────────────────────

fn nrs1_valid() -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(b"NRS1");
    b.push(2);
    b.push(0);
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(&5_000u64.to_le_bytes());
    // candidate 0: 2 points
    b.extend_from_slice(&[0, 0, 0, 0]);
    b.extend_from_slice(&2u32.to_le_bytes());
    for (t, lo, hi) in [(0u32, 1.5f64, 1.5f64), (100, -2.0, 3.0)] {
        b.extend_from_slice(&t.to_le_bytes());
        b.extend_from_slice(&lo.to_le_bytes());
        b.extend_from_slice(&hi.to_le_bytes());
    }
    // reference: 1 point
    b.extend_from_slice(&[1, 0, 0, 0]);
    b.extend_from_slice(&1u32.to_le_bytes());
    b.extend_from_slice(&7u32.to_le_bytes());
    b.extend_from_slice(&9.0f64.to_le_bytes());
    b.extend_from_slice(&9.0f64.to_le_bytes());
    b
}

#[test]
fn nrs1_decodes_valid_buffer() {
    let d = decode_nrs1(&nrs1_valid()).unwrap();
    assert_eq!(d.from_us, 5_000);
    assert_eq!(d.max_points, 16);
    assert_eq!(d.series.len(), 2);
    assert_eq!(d.series[0].points, vec![(0, 1.5, 1.5), (100, -2.0, 3.0)]);
    assert_eq!(d.series[1].kind, 1);
    assert_eq!(d.series[1].points, vec![(7, 9.0, 9.0)]);
}

#[test]
fn nrs1_rejects_truncated_and_corrupt_buffers_without_panicking() {
    let good = nrs1_valid();
    for n in 0..good.len() {
        assert!(decode_nrs1(&good[..n]).is_err(), "prefix {n} accepted");
    }
    let mut bad_magic = good.clone();
    bad_magic[0] = b'X';
    assert!(decode_nrs1(&bad_magic).unwrap_err().0.contains("magic"));
    let mut trailing = good.clone();
    trailing.push(0);
    assert!(decode_nrs1(&trailing).unwrap_err().0.contains("trailing"));
    let mut bad_kind = good.clone();
    bad_kind[16] = 9;
    assert!(decode_nrs1(&bad_kind).is_err());
    let mut huge_count = good.clone();
    huge_count[20..24].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(decode_nrs1(&huge_count).is_err());
    let mut many_series = good.clone();
    many_series[4] = 200;
    assert!(decode_nrs1(&many_series).is_err());
    // Pseudo-random garbage behind a valid magic.
    let mut seed = 0x9E37_79B9u32;
    for len in [16usize, 17, 24, 60, 300] {
        let mut g = b"NRS1".to_vec();
        while g.len() < len {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            g.push((seed >> 24) as u8);
        }
        let _ = decode_nrs1(&g); // must not panic
    }
}

#[test]
fn nrs1_decodes_real_engine_output() {
    let e = re_engine("nrs1-engine");
    let buf = e
        .cmd_re_series(
            serde_json::from_value::<ReSeriesRequest>(json!({
                "target": { "bus": 0, "arbId": 0x123, "isExtended": false },
                "candidates": [{ "startBit": 16, "bitLength": 16, "byteOrder": "intel",
                                 "valueType": "unsigned", "factor": 1.0, "offset": 0.0 }],
                "reference": null, "fromUs": null, "toUs": null, "maxPoints": 4096
            }))
            .unwrap(),
        )
        .unwrap();
    let d = decode_nrs1(&buf).unwrap();
    assert_eq!(d.from_us, T0);
    assert_eq!(d.series[0].points.len(), 200);
    assert_eq!(d.series[0].points[199], (1_990_000, 1990.0, 1990.0));
}

// ─── re_series / re_correlate ───────────────────────────────────────────────

#[test]
fn series_returns_json_points_within_cap() {
    let e = re_engine("series");
    let v = tr::re_series(
        &e,
        &series_args(json!({
            "bus_id": 0, "id": "0x123",
            "candidates": [
                { "start_bit": 16, "bit_length": 16, "label": "ramp" },
                { "start_bit": 0, "bit_length": 8 },
                { "start_bit": 8, "bit_length": 8, "byte_order": "motorola" },
                { "start_bit": 16, "bit_length": 16, "value_type": "signed", "factor": 0.1 }
            ],
            "max_points": 100000
        })),
    )
    .unwrap();
    assert_eq!(v["enabled"], json!(true), "{v}");
    assert_eq!(v["max_points_requested"], json!(500));
    let s = v["series"].as_array().unwrap();
    assert_eq!(s.len(), 4);
    assert_eq!(s[0]["label"], json!("ramp"));
    let pts = s[0]["points"].as_array().unwrap();
    assert!(!pts.is_empty());
    assert_eq!(pts[0][0], json!(0));
    assert!(json_size(&v) <= MAX_RESPONSE_BYTES, "{}", json_size(&v));
    assert!(v.get("raw").is_none());
}

#[test]
fn series_unfocused_target_explains_how_to_focus() {
    let e = re_engine("series-nofocus");
    let err = tr::re_series(
        &e,
        &series_args(json!({ "bus_id": 0, "id": "0x200", "candidates": [{ "start_bit": 0, "bit_length": 8 }] })),
    )
    .unwrap_err();
    assert!(err.0.contains("focus it in the RE view"), "{err}");
    // Reference on an unfocused frame is refused (no auto-focus from MCP).
    let err = tr::re_series(
        &e,
        &series_args(json!({
            "bus_id": 0, "id": "0x123", "candidates": [],
            "reference": { "kind": "candidate", "bus_id": 0, "id": "0x200",
                           "candidate": { "start_bit": 8, "bit_length": 8 } }
        })),
    )
    .unwrap_err();
    assert!(err.0.contains("focus it in the RE view"), "{err}");
    let err = tr::re_series(
        &e,
        &series_args(json!({
            "bus_id": 0, "id": "0x123", "candidates": [],
            "reference": { "kind": "obd_pid", "pid": 13 }
        })),
    )
    .unwrap_err();
    assert!(err.0.contains("focus"), "{err}");
    assert_eq!(
        e.cmd_re_focus_status().targets.len(),
        1,
        "focus set changed"
    );
    // Too many candidates.
    let five: Vec<Value> = (0..5)
        .map(|i| json!({ "start_bit": i * 8, "bit_length": 8 }))
        .collect();
    assert!(tr::re_series(
        &e,
        &series_args(json!({ "bus_id": 0, "id": "0x123", "candidates": five }))
    )
    .is_err());
}

#[test]
fn correlate_with_focused_candidate_reference_finds_the_ramp() {
    let e = re_engine("correlate");
    let c: ReCorrelateArgs = serde_json::from_value(json!({
        "bus_id": 0, "id": "0x123",
        "reference": { "kind": "candidate", "bus_id": 0, "id": "0x123",
                       "candidate": { "start_bit": 16, "bit_length": 16, "factor": 2.0 } },
        "bit_from": 0, "bit_to": 31, "min_length": 8, "max_length": 16,
        "top_n": 500
    }))
    .unwrap();
    let v = tr::re_correlate(&e, &c).unwrap();
    assert_eq!(v["enabled"], json!(true), "{v}");
    let rows = v["rows"].as_array().unwrap();
    assert!(!rows.is_empty() && rows.len() <= 20, "{v}");
    assert!(rows[0]["r"].as_f64().unwrap().abs() > 0.99, "{v}");
    assert!(json_size(&v) <= MAX_RESPONSE_BYTES);
}

// ─── re_scan_results ────────────────────────────────────────────────────────

#[test]
fn scan_results_limit_is_clamped() {
    let p = |v: Value| tr::scan_params(&serde_json::from_value(v).unwrap());
    assert_eq!(p(json!({ "limit": 0 })).1, 1);
    assert_eq!(p(json!({ "limit": 100000 })).1, MAX_SCAN_RESULTS);
    assert_eq!(p(json!({})).1, tr::DEFAULT_SCAN_RESULTS);

    let e = re_engine("scan");
    // No scan yet: explicit inactive answer, never starts one.
    let v = tr::re_scan_results(&e, &ReScanResultsArgs::default()).unwrap();
    assert_eq!(v["active"], json!(false), "{v}");
    assert!(!e.cmd_re_scan_status().active);
    // The user runs a first scan in the RE view (here: the engine API).
    e.cmd_re_scan_first(
        serde_json::from_value::<ReScanFirstSpec>(json!({ "kind": "unknown" })).unwrap(),
    )
    .expect("scan first");
    let v = tr::re_scan_results(
        &e,
        &serde_json::from_value(json!({ "limit": 100000, "sort": "width" })).unwrap(),
    )
    .unwrap();
    assert_eq!(v["active"], json!(true), "{v}");
    assert_eq!(v["limit"], json!(MAX_SCAN_RESULTS));
    assert!(v["rows"].as_array().unwrap().len() <= MAX_SCAN_RESULTS as usize);
    assert!(json_size(&v) <= MAX_RESPONSE_BYTES, "{}", json_size(&v));
    let step = e.cmd_re_scan_status().step;
    assert_eq!(step, v["step"].as_u64().unwrap() as u32, "scan stepped");
}

// ─── re_row_detail ──────────────────────────────────────────────────────────

#[test]
fn row_detail_includes_masks_and_classification() {
    let e = re_engine("row");
    let v = tr::re_row_detail(
        &e,
        &serde_json::from_value(json!({ "bus_id": 0, "id": "0x123" })).unwrap(),
    )
    .unwrap();
    assert_eq!(v["rx_count"], json!(200), "{v}");
    assert_eq!(v["dlc_bytes"], json!(8));
    assert_eq!(v["toggles"].as_array().unwrap().len(), 64);
    assert!(v["classification"]["fields"].is_array());
    assert!(json_size(&v) <= MAX_RESPONSE_BYTES);
    let err = tr::re_row_detail(
        &e,
        &serde_json::from_value(json!({ "bus_id": 0, "id": "0x7FF" })).unwrap(),
    )
    .unwrap_err();
    assert!(err.0.contains("not found"), "{err}");
}

// ─── re_dbc_generate ────────────────────────────────────────────────────────

#[test]
fn dbc_generate_small_draft_list() {
    let a: ReDbcGenerateArgs = serde_json::from_value(json!({ "drafts": [
        { "name": "VehSpeed", "id": "0x123", "start_bit": 16, "bit_length": 16,
          "factor": 0.01, "max": 655.35, "unit": "km/h" },
        { "name": "Gear", "id": "0x18FF50E5", "start_bit": 0, "bit_length": 4,
          "value_table": [{ "value": 0, "label": "P" }, { "value": 1, "label": "D" }] }
    ]}))
    .unwrap();
    let v = tr::re_dbc_generate(&a).unwrap();
    assert_eq!(v["ok"], json!(true), "{v}");
    let text = v["dbc_text"].as_str().unwrap();
    assert!(text.contains("BO_ "), "{text}");
    assert!(text.contains("SG_ VehSpeed"), "{text}");
    assert!(text.contains("SG_ Gear"), "{text}");
    assert_eq!(v["signals"], json!(2));
    assert_eq!(v["truncated"], json!(false));

    let with_base: ReDbcGenerateArgs = serde_json::from_value(json!({
        "drafts": [{ "name": "X", "id": "0x1", "start_bit": 0, "bit_length": 1 }],
        "base_db_id": "global"
    }))
    .unwrap();
    assert!(tr::re_dbc_generate(&with_base).is_err());
    let empty: ReDbcGenerateArgs = serde_json::from_value(json!({ "drafts": [] })).unwrap();
    assert!(tr::re_dbc_generate(&empty).is_err());
}

#[test]
fn dbc_generate_large_output_is_clipped_to_cap() {
    let drafts: Vec<Value> = (0..256)
        .map(|i| {
            json!({
                "name": format!("Signal_{i:03}"),
                "id": format!("0x{:03X}", 0x100 + i / 8),
                "start_bit": (i % 8) * 8, "bit_length": 8,
                "comment": "a fairly long \"quoted\" comment line to inflate the generated DBC text ".repeat(4),
            })
        })
        .collect();
    let a: ReDbcGenerateArgs = serde_json::from_value(json!({ "drafts": drafts })).unwrap();
    let v = tr::re_dbc_generate(&a).unwrap();
    assert_eq!(v["ok"], json!(true), "{}", v["diagnostics"]);
    assert_eq!(v["truncated"], json!(true));
    assert!(v["dbc_bytes"].as_u64().unwrap() as usize > MAX_RESPONSE_BYTES);
    assert!(json_size(&v) <= MAX_RESPONSE_BYTES, "{}", json_size(&v));
    assert!(v["dbc_text"].as_str().unwrap().ends_with('\n'));
    let too_many: Vec<Value> = (0..300)
        .map(|i| json!({ "name": format!("S{i}"), "id": "0x1", "start_bit": 0, "bit_length": 1 }))
        .collect();
    let a: ReDbcGenerateArgs = serde_json::from_value(json!({ "drafts": too_many })).unwrap();
    assert!(tr::re_dbc_generate(&a).is_err());
}
