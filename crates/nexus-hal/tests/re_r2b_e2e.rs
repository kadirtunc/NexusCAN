//! QA E2E gate for RE Toolkit R2b (planning/contracts/re-toolkit-v1.md §7.5 "E2E", §7.5a).
//!
//! Chain under test (pure Rust, mock traffic — no vcan needed):
//!   scripted frames (planted 16-bit Motorola signal, factor 0.25 / offset −40) + scripted OBD-II
//!   0x7E8 Mode-01 responses (PID 0x0C engine RPM) → `ReAnalyzer::correlate` → top row →
//!   `ReSignalDraft` → `re_dbc_generate` (the shared Tauri/bridge command fn) →
//!   `nexus_netdb::parse_and_compile(dbcText)` → `decode_payload_into` on golden payloads →
//!   decoded physical == planted physical within factor/2.
//!
//! Variant 2 merges the same draft into `scripts/sample_vehicle.dbc` (base passed exactly as the
//! frontend does: base64 + file name) and asserts every base signal decodes bit-identically on
//! golden frames (raw bits + f64 bit pattern), including every mux branch of 0x105.
//!
//! Reference choice: PID 0x0C (RPM = (256A+B)/4) has a 0.25 resolution, so the planted signal is an
//! exact affine image of the reference over the full 16-bit range (raw = obd_raw + 160). PID 0x05
//! (coolant, 1 °C, 8-bit) would leave the upper/lower raw bits constant, and the |r|-tie rule
//! ("prefer shorter bitLength") would then legitimately pick a shorter sub-span instead of 16 bits.
//!
//! Run: `cargo test -p nexus-hal --test re_r2b_e2e`

use base64::engine::general_purpose::STANDARD as BASE64_STD;
use base64::Engine as _;
use nexus_core::{CanIdKey, RawCanFrame};
use nexus_hal::pipeline::re_analyzer::{
    re_dbc_generate, ReAnalyzer, ReCorrelateRequest, ReDbcBaseDto, ReReferenceDto, ReSearchDto,
    ReTargetDto,
};
use nexus_netdb::re_export::{
    ReByteOrder, ReDbcGenerateResult, ReDbcSeverity, ReProvenance, ReSignalDraft, ReSignalValueType,
};
use nexus_netdb::{parse_and_compile, CompiledDatabase, DecodedSignalSample, ParseOptions};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const VEHICLE_DBC: &[u8] = include_bytes!("../../../scripts/sample_vehicle.dbc");

const T_ID: u16 = 0x3A0;
const OBD_RESP: u16 = 0x7E8;
const OBD_REQ: u16 = 0x7DF;
const PLANT_FACTOR: f64 = 0.25;
const PLANT_OFFSET: f64 = -40.0;
/// raw * 0.25 − 40 == obd_raw / 4  ⇔  raw = obd_raw + 160.
const RAW_SHIFT: u16 = 160;
const N: usize = 600;

// ─── helpers ──────────────────────────────────────────────────────────────────────────────────

fn from<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v.clone())
        .unwrap_or_else(|e| panic!("DTO must deserialize from {v}: {e}"))
}

fn std_frame(id: u16, data: &[u8], ts: u64) -> RawCanFrame {
    RawCanFrame::new_classical(0, CanIdKey::new_standard(id).expect("std id"), data, ts)
        .expect("classic frame")
}

struct Lcg(u32);
impl Lcg {
    fn next_u8(&mut self) -> u8 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (self.0 >> 24) as u8
    }
    fn fill(&mut self, d: &mut [u8]) {
        for b in d {
            *b = self.next_u8();
        }
    }
}

/// Planted raw: full-range 16-bit waveform (all 16 bits toggle), always ≥ RAW_SHIFT.
fn planted_raw(i: usize) -> u16 {
    let x = i as f64;
    (32_768.0 + 26_000.0 * (x * 0.037).sin() + 4_000.0 * (x * 0.21 + 1.0).sin()).round() as u16
}

fn planted_phys(raw: u16) -> f64 {
    f64::from(raw) * PLANT_FACTOR + PLANT_OFFSET
}

/// Target payload: byte0 = counter (high nibble), bytes1..2 = planted Motorola MSB 15 len 16
/// (= big-endian bytes 1..2), bytes3..6 noise, byte7 XOR checksum.
fn target_payload(raw: u16, i: usize, rng: &mut Lcg) -> [u8; 8] {
    let mut p = [0u8; 8];
    p[0] = ((i % 16) as u8) << 4;
    p[1..3].copy_from_slice(&raw.to_be_bytes());
    rng.fill(&mut p[3..7]);
    p[7] = p[..7].iter().fold(0, |x, y| x ^ y);
    p
}

/// Ingest scripted traffic; returns the planted physical values in order.
fn script(a: &mut ReAnalyzer) -> Vec<f64> {
    let mut rng = Lcg(0x5EED);
    let mut planted = Vec::with_capacity(N);
    for i in 0..N {
        let t = 1_000_000 + i as u64 * 10_000;
        let raw = planted_raw(i);
        assert!(raw >= RAW_SHIFT);
        a.ingest(&std_frame(T_ID, &target_payload(raw, i, &mut rng), t));
        // Tester request (distractor) then the ECU's Mode-01 PID 0x0C single-frame response.
        a.ingest(&std_frame(
            OBD_REQ,
            &[0x02, 0x01, 0x0C, 0, 0, 0, 0, 0],
            t + 500,
        ));
        let obd = raw - RAW_SHIFT;
        let [oa, ob] = obd.to_be_bytes();
        a.ingest(&std_frame(
            OBD_RESP,
            &[0x04, 0x41, 0x0C, oa, ob, 0x55, 0x55, 0x55],
            t + 1_000,
        ));
        // Sanity: the reference value equals the planted physical value exactly.
        assert_eq!(f64::from(obd) / 4.0, planted_phys(raw));
        planted.push(planted_phys(raw));
    }
    planted
}

fn correlate_top_row() -> (Value, Vec<f64>) {
    let mut a = ReAnalyzer::new();
    let _ = a.start(None);
    let targets: Vec<ReTargetDto> = vec![
        from(json!({ "bus": 0, "arbId": T_ID, "isExtended": false })),
        from(json!({ "bus": 0, "arbId": OBD_RESP, "isExtended": false })),
    ];
    a.focus_set(&targets)
        .unwrap_or_else(|e| panic!("focus_set: {e}"));
    let planted = script(&mut a);
    let reference: ReReferenceDto = from(json!({ "kind": "obd_pid", "pid": 0x0C, "bus": 0 }));
    let search: ReSearchDto = from(json!({ "bitFrom": 0, "bitTo": 31, "lengths": [8, 20],
        "byteOrders": ["intel", "motorola"], "signed": [false, true] }));
    let req = ReCorrelateRequest {
        target: from(json!({ "bus": 0, "arbId": T_ID, "isExtended": false })),
        reference,
        from_us: None,
        to_us: None,
        search,
        top_n: 10,
    };
    let res = a
        .correlate(&req)
        .unwrap_or_else(|e| panic!("correlate: {e}"));
    let v = serde_json::to_value(&res).expect("serialize");
    let top = v["rows"]
        .as_array()
        .and_then(|r| r.first())
        .cloned()
        .unwrap_or_else(|| panic!("no rows: {v}"));
    (top, planted)
}

fn f(v: &Value, k: &str) -> f64 {
    v[k].as_f64()
        .unwrap_or_else(|| panic!("missing number `{k}` in {v}"))
}

/// Build the draft exactly as the Save-signal dialog prefill does (§7.4 / §7.5a-11).
fn draft_from_row(top: &Value, planted: &[f64]) -> ReSignalDraft {
    let c = &top["candidate"];
    let lo = planted
        .iter()
        .copied()
        .fold(f64::INFINITY, f64::min)
        .floor();
    let hi = planted
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, f64::max)
        .ceil();
    ReSignalDraft {
        id: "e2e-1".into(),
        bus: 0,
        arb_id: u32::from(T_ID),
        is_extended: false,
        message_name: None,
        dlc_bytes: 8,
        name: format!("RE_{:03X}_sig{}", T_ID, c["startBit"]),
        start_bit: c["startBit"].as_u64().expect("startBit") as u16,
        bit_length: c["bitLength"].as_u64().expect("bitLength") as u8,
        byte_order: from(c["byteOrder"].clone()),
        value_type: from(c["valueType"].clone()),
        factor: f(c, "factor"),
        offset: f(c, "offset"),
        min: lo,
        max: hi,
        unit: "rpm".into(),
        comment: "E2E planted \"signal\" \\ OBD".into(),
        provenance: ReProvenance {
            r: Some(f(top, "r")),
            lag_ms: Some(f(top, "lagMs")),
            reference: Some("OBD 0x0C".into()),
            samples: top["samples"].as_u64(),
            created_at_ms: 1_763_500_000_000.0,
        },
        value_table: vec![],
    }
}

fn errors(r: &ReDbcGenerateResult) -> Vec<String> {
    r.diagnostics
        .iter()
        .filter(|d| d.severity == ReDbcSeverity::Error)
        .map(|d| format!("{}: {}", d.code, d.message))
        .collect()
}

fn blank() -> DecodedSignalSample {
    DecodedSignalSample {
        signal_id: 0,
        raw_bits: 0,
        raw_int: 0,
        physical_value: 0.0,
        out_of_range: false,
        is_mux_switch: false,
    }
}

/// name → (raw_bits, physical f64 bits) of every signal decoded from `payload`.
fn decode_named(
    db: &CompiledDatabase,
    id: CanIdKey,
    payload: &[u8],
) -> BTreeMap<String, (u64, u64)> {
    let mut out = [blank(); 256];
    let mut sw = [(0u32, 0i64); 16];
    let s = db
        .decode_payload_into(id, payload, &mut out, &mut sw)
        .unwrap_or_else(|| panic!("no message for {id:?}"));
    out[..s.decoded_count]
        .iter()
        .map(|d| {
            let name = db.get_signal(d.signal_id).expect("signal id").name.clone();
            (name, (d.raw_bits, d.physical_value.to_bits()))
        })
        .collect()
}

/// Golden check: planted signal decodes to the planted value within factor/2 through the full
/// compiled-DB path, for observed raws and edge raws (min / max / sign-bit boundary).
fn assert_planted_decodes(db: &CompiledDatabase, sig_name: &str, factor: f64) {
    let id = CanIdKey::new_standard(T_ID).expect("id");
    let mut rng = Lcg(77);
    let mut raws: Vec<u16> = (0..N).step_by(37).map(planted_raw).collect();
    raws.extend([0x0000, 0x0001, 0x7FFF, 0x8000, 0xFFFE, 0xFFFF, RAW_SHIFT]);
    for (i, raw) in raws.into_iter().enumerate() {
        let p = target_payload(raw, i, &mut rng);
        let got = decode_named(db, id, &p);
        let (rb, phys_bits) = *got
            .get(sig_name)
            .unwrap_or_else(|| panic!("{sig_name} not decoded: {got:?}"));
        let phys = f64::from_bits(phys_bits);
        let want = planted_phys(raw);
        assert_eq!(rb, u64::from(raw), "raw bits for payload {p:02X?}");
        assert!(
            (phys - want).abs() <= factor / 2.0,
            "raw 0x{raw:04X}: decoded {phys} vs planted {want} (tol {})",
            factor / 2.0
        );
    }
}

// ─── tests ────────────────────────────────────────────────────────────────────────────────────

#[test]
fn r2b_e2e_planted_motorola16_obd_reference_standalone() {
    let (top, planted) = correlate_top_row();
    eprintln!("top row: {top}");
    let c = &top["candidate"];
    assert_eq!(c["startBit"], 15, "top row startBit: {top}");
    assert_eq!(c["bitLength"], 16, "top row bitLength: {top}");
    assert_eq!(c["byteOrder"], "motorola", "top row order: {top}");
    assert_eq!(c["valueType"], "unsigned", "top row valueType: {top}");
    assert!(f(&top, "r") > 0.999, "r = {}", f(&top, "r"));
    assert!(
        (f(c, "factor") - PLANT_FACTOR).abs() < 1e-6,
        "fit factor {}",
        f(c, "factor")
    );
    assert!(
        (f(c, "offset") - PLANT_OFFSET).abs() < 1e-3,
        "fit offset {}",
        f(c, "offset")
    );

    let d = draft_from_row(&top, &planted);
    assert_eq!(d.byte_order, ReByteOrder::Motorola);
    assert_eq!(d.value_type, ReSignalValueType::Unsigned);
    let r = re_dbc_generate(std::slice::from_ref(&d), None).unwrap_or_else(|e| panic!("cmd: {e}"));
    assert!(errors(&r).is_empty(), "diagnostics: {:?}", r.diagnostics);
    assert_eq!((r.messages, r.signals), (1, 1));
    assert!(!r.dbc_text.is_empty());
    assert!(
        r.dbc_text.contains("BO_ 928 RE_3A0: 8"),
        "auto message name / DLC:\n{}",
        r.dbc_text
    );
    assert!(
        r.dbc_text.contains("ref=OBD 0x0C"),
        "provenance line:\n{}",
        r.dbc_text
    );

    let (db, schema) = parse_and_compile(
        r.dbc_text.as_bytes(),
        Some("RE_found.dbc"),
        &ParseOptions::default(),
    )
    .unwrap_or_else(|e| panic!("generated text must compile: {e}\n{}", r.dbc_text));
    assert_eq!(schema.info.message_count, 1);
    // Factor / offset written losslessly (§7.5a-9).
    let sig = db
        .messages
        .iter()
        .flat_map(|m| m.all_signals.iter())
        .find(|s| s.name == d.name)
        .expect("draft signal in compiled DB");
    assert_eq!(
        sig.factor.to_bits(),
        d.factor.to_bits(),
        "factor not lossless: {} vs {}",
        sig.factor,
        d.factor
    );
    assert_eq!(
        sig.offset.to_bits(),
        d.offset.to_bits(),
        "offset not lossless: {} vs {}",
        sig.offset,
        d.offset
    );
    assert_eq!(sig.min.to_bits(), d.min.to_bits(), "min not lossless");
    assert_eq!(sig.max.to_bits(), d.max.to_bits(), "max not lossless");
    assert_planted_decodes(&db, &d.name, d.factor);
}

/// Golden payload patterns per base message (truncated to the DLC).
fn golden_payloads(dlc: usize) -> Vec<Vec<u8>> {
    let mut v: Vec<Vec<u8>> = vec![
        vec![0x00; dlc],
        vec![0xFF; dlc],
        vec![0xA5; dlc],
        vec![0x5A; dlc],
    ];
    v.push((0..dlc).map(|i| i as u8).collect());
    v.push(
        (0..dlc)
            .map(|i| (i as u8).wrapping_mul(37) ^ 0xC3)
            .collect(),
    );
    let mut rng = Lcg(4242);
    for _ in 0..4 {
        let mut p = vec![0u8; dlc];
        rng.fill(&mut p);
        v.push(p);
    }
    v
}

#[test]
fn r2b_e2e_merge_into_sample_vehicle_base_signals_bit_identical() {
    let (top, planted) = correlate_top_row();
    let d = draft_from_row(&top, &planted);
    let base = ReDbcBaseDto {
        file_name: "sample_vehicle.dbc".into(),
        content_base64: BASE64_STD.encode(VEHICLE_DBC),
    };
    let r = re_dbc_generate(std::slice::from_ref(&d), Some(&base))
        .unwrap_or_else(|e| panic!("cmd: {e}"));
    assert!(errors(&r).is_empty(), "diagnostics: {:?}", r.diagnostics);
    for w in &r.diagnostics {
        eprintln!("merge warning: {} — {}", w.code, w.message);
    }
    assert_eq!(
        (r.messages, r.signals),
        (1, 1),
        "counts are draft-touched only (§7.5a-10)"
    );

    let (base_db, base_schema) = parse_and_compile(
        VEHICLE_DBC,
        Some("sample_vehicle.dbc"),
        &ParseOptions::default(),
    )
    .expect("base compiles");
    let (merged, merged_schema) = parse_and_compile(
        r.dbc_text.as_bytes(),
        Some("sample_vehicle_re.dbc"),
        &ParseOptions::default(),
    )
    .unwrap_or_else(|e| panic!("merged text must compile: {e}"));
    assert_eq!(
        merged_schema.info.message_count,
        base_schema.info.message_count + 1
    );
    assert_eq!(
        merged_schema.info.signal_count,
        base_schema.info.signal_count + 1
    );

    let mut frames = 0usize;
    for bm in &base_db.messages {
        let mm = merged.get_message(&bm.can_id).unwrap_or_else(|| {
            panic!(
                "base message {} ({:?}) missing after merge",
                bm.name, bm.can_id
            )
        });
        assert_eq!(mm.name, bm.name, "base message renamed");
        assert_eq!(mm.dlc, bm.dlc, "base message DLC changed: {}", bm.name);
        let dlc = usize::from(bm.dlc).max(1);
        let mut payloads = golden_payloads(dlc);
        // Drive every mux branch of the multiplexed message (0x105: switch 0|4, sub-switch 4|4).
        if bm.mux_tree.is_some() {
            for m in 0..16u8 {
                for s in [0u8, 1, 2, 15] {
                    let mut p = golden_payloads(dlc)[9].clone();
                    p[0] = (s << 4) | m;
                    payloads.push(p);
                }
            }
        }
        for p in payloads {
            let a = decode_named(&base_db, bm.can_id, &p);
            let b = decode_named(&merged, bm.can_id, &p);
            assert_eq!(
                a, b,
                "base message {} decodes differently after merge on {p:02X?}",
                bm.name
            );
            frames += 1;
        }
    }
    eprintln!(
        "merge: {} base messages, {frames} golden frames bit-identical",
        base_db.messages.len()
    );
    assert!(frames > 50);
    assert_planted_decodes(&merged, &d.name, d.factor);
}
