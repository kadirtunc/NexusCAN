//! R2b `cmd_re_dbc_generate` shared backend function (re-toolkit-v1 §7.3 / §7.5a): bounds,
//! base decode / format detection (.dbc / .kcd) and generator wiring. The Tauri command and the
//! bridge route both call `re_dbc_generate`; the bridge route itself is covered in
//! `src/bin/nexus_bridge.rs` tests.

use base64::engine::general_purpose::STANDARD as BASE64_STD;
use base64::Engine as _;
use nexus_hal::pipeline::re_analyzer::{re_dbc_generate, ReDbcBaseDto, ReDbcGenerateRequest};
use nexus_netdb::re_export::{
    ReByteOrder, ReDbcSeverity, ReProvenance, ReSignalDraft, ReSignalValueType,
};
use nexus_netdb::{parse_and_compile, ParseOptions};

const VEHICLE_DBC: &[u8] = include_bytes!("../../../scripts/sample_vehicle.dbc");
const BMS_KCD: &[u8] = include_bytes!("../../../scripts/sample_bms.kcd");

fn draft(name: &str, arb_id: u32, start_bit: u16) -> ReSignalDraft {
    ReSignalDraft {
        id: format!("id-{name}"),
        bus: 0,
        arb_id,
        is_extended: false,
        message_name: None,
        dlc_bytes: 8,
        name: name.into(),
        start_bit,
        bit_length: 16,
        byte_order: ReByteOrder::Motorola,
        value_type: ReSignalValueType::Unsigned,
        factor: 0.25,
        offset: -40.0,
        min: -40.0,
        max: 16343.75,
        unit: "km/h".into(),
        comment: "found by RE".into(),
        provenance: ReProvenance {
            r: Some(0.998),
            lag_ms: Some(120.0),
            reference: Some("OBD 0x0D".into()),
            samples: Some(812),
            created_at_ms: 1_700_000_000_000.0,
        },
        value_table: vec![],
    }
}

fn base(file_name: &str, bytes: &[u8]) -> ReDbcBaseDto {
    ReDbcBaseDto {
        file_name: file_name.into(),
        content_base64: BASE64_STD.encode(bytes),
    }
}

fn errors(r: &nexus_netdb::re_export::ReDbcGenerateResult) -> Vec<&str> {
    r.diagnostics
        .iter()
        .filter(|d| d.severity == ReDbcSeverity::Error)
        .map(|d| d.code.as_str())
        .collect()
}

#[test]
fn empty_probe_call_is_ok_with_zero_counts() {
    // The frontend reachability probe: `{ drafts: [], base: null }`.
    let req: ReDbcGenerateRequest =
        serde_json::from_str(r#"{"drafts":[],"base":null}"#).expect("args");
    let r = re_dbc_generate(&req.drafts, req.base.as_ref()).expect("ok");
    assert_eq!((r.messages, r.signals), (0, 0));
    assert!(r.diagnostics.is_empty(), "{:?}", r.diagnostics);
    // Missing `base` is accepted as null too.
    let req: ReDbcGenerateRequest = serde_json::from_str(r#"{"drafts":[]}"#).expect("args");
    assert!(req.base.is_none());
}

#[test]
fn standalone_draft_round_trips_through_the_parser() {
    let d = draft("VehSpeed", 0x6A0, 7);
    let r = re_dbc_generate(&[d], None).expect("ok");
    assert!(errors(&r).is_empty(), "{:?}", r.diagnostics);
    assert_eq!((r.messages, r.signals), (1, 1));
    assert!(r.dbc_text.contains("RE_6A0"), "{}", r.dbc_text);
    assert!(r.dbc_text.contains("SG_ VehSpeed"), "{}", r.dbc_text);
    assert!(r
        .dbc_text
        .contains("RE: r=0.998 lag=+120ms ref=OBD 0x0D n=812"));

    let (compiled, schema) = parse_and_compile(
        r.dbc_text.as_bytes(),
        Some("RE_found.dbc"),
        &ParseOptions::default(),
    )
    .expect("generated text re-parses");
    assert_eq!(schema.info.message_count, 1);
    // Motorola 16-bit @ MSB 7 → bytes 0..1 big-endian: raw 0x0100 = 256 → 256 * 0.25 - 40 = 24.
    let msg = compiled
        .messages
        .iter()
        .find(|m| m.name == "RE_6A0")
        .expect("message");
    let sig = msg
        .all_signals
        .iter()
        .find(|s| s.name == "VehSpeed")
        .expect("signal");
    let (_, v, _) = sig.decode_physical(sig.extract_raw(&[0x01, 0x00, 0, 0, 0, 0, 0, 0]));
    assert!((v - 24.0).abs() < 1e-9, "decoded {v}");

    // Same through the camelCase bridge / Tauri argument shape.
    let json = serde_json::json!({ "drafts": [draft("VehSpeed", 0x6A0, 7)], "base": null });
    let req: ReDbcGenerateRequest = serde_json::from_value(json).expect("args");
    let r2 = re_dbc_generate(&req.drafts, req.base.as_ref()).expect("ok");
    assert_eq!(r2, r);
}

#[test]
fn base_dbc_is_merged_and_kept() {
    let b = base("sample_vehicle.dbc", VEHICLE_DBC);
    let r = re_dbc_generate(&[draft("ReNew", 0x6A0, 7)], Some(&b)).expect("ok");
    assert!(errors(&r).is_empty(), "{:?}", r.diagnostics);
    assert_eq!(
        (r.messages, r.signals),
        (1, 1),
        "only draft-touched messages count"
    );
    for name in [
        "INV_MotorStatus",
        "BMS_MuxDiagnostics",
        "INV_FastTelemetryFD",
        "RE_6A0",
    ] {
        assert!(r.dbc_text.contains(name), "{name} missing");
    }

    // The base is really used: a draft on top of an existing base signal is an overlap error
    // (generator diagnostic, not a command error).
    let r = re_dbc_generate(&[draft("Clash", 257, 7)], Some(&b)).expect("ok");
    assert!(errors(&r).contains(&"overlap"), "{:?}", r.diagnostics);
    assert!(r.dbc_text.is_empty());
    assert_eq!((r.messages, r.signals), (0, 0));
}

#[test]
fn base_kcd_is_detected_and_merged() {
    // Content sniffing finds KCD even with a misleading hint; the hint path is exercised too.
    for hint in ["sample_bms.kcd", "whatever.bin", ""] {
        let b = base(hint, BMS_KCD);
        let r = re_dbc_generate(&[draft("ReNew", 0x6A0, 7)], Some(&b)).expect("ok");
        assert!(errors(&r).is_empty(), "{hint}: {:?}", r.diagnostics);
        assert_eq!((r.messages, r.signals), (1, 1));
        for name in ["CMC_CellVoltagesMux", "BMS_PackPowerAndLimits", "RE_6A0"] {
            assert!(r.dbc_text.contains(name), "{hint}: {name} missing");
        }
    }
}

#[test]
fn bad_base64_is_re_invalid() {
    let b = ReDbcBaseDto {
        file_name: "x.dbc".into(),
        content_base64: "@@@ not base64 !!!".into(),
    };
    let e = re_dbc_generate(&[], Some(&b)).unwrap_err();
    assert!(e.to_string().starts_with("[re:invalid] "), "{e}");
    assert!(e.to_string().contains("base64"), "{e}");
}

#[test]
fn garbage_base_is_re_invalid() {
    for (hint, bytes) in [
        (
            "x.dbc",
            &b"hello world, definitely not a database \x00\xff"[..],
        ),
        ("x.kcd", &b"<<<not xml at all"[..]),
        ("x.bin", &[0u8, 1, 2, 3, 0xFF, 0xFE][..]),
    ] {
        let e = re_dbc_generate(&[draft("A", 0x6A0, 7)], Some(&base(hint, bytes))).unwrap_err();
        assert!(e.to_string().starts_with("[re:invalid] "), "{hint}: {e}");
    }
}
