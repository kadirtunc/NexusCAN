//! QA E2E gate for RE Toolkit R2c "Value Scan" → R2b "Save signal" → DBC
//! (planning/contracts/re-toolkit-v1.md §8.4 "Save signal (R2b draft dialog prefilled incl. preset
//! scale)", §8.5, §8.6; R2b §7.4 / §7.5a).
//!
//! Chain under test (pure Rust, scripted traffic — no vcan needed):
//!   planted 16-bit Motorola `15|16` vehicle speed, factor 0.01 (raw 5000 → 6500 → 8000 = 80 km/h),
//!   amid a counter, an XOR checksum, random bytes and noise rows →
//!   `ReShared::scan_first(unknown)` → `scan_next(increased)` ×2 → `scan_next(exact physical 80,
//!   standard 66-preset grid)` → result row of the planted candidate (preset kept = 0.01 / 0) →
//!   `ReSignalDraft` prefilled exactly like the Save-signal dialog (candidate geometry + kept preset) →
//!   `re_dbc_generate` → `nexus_netdb::parse_and_compile` → `decode_payload_into` on golden payloads →
//!   decoded physical == planted physical within factor/2 (incl. edge raws 0 / 0x7FFF / 0x8000 / 0xFFFF).
//!
//! Run: `cargo test -p nexus-hal --test re_r2c_e2e`

use nexus_core::{CanIdKey, RawCanFrame};
use nexus_hal::pipeline::re_analyzer::{re_dbc_generate, ReScanFirstSpec, ReScanNextOp, ReShared};
use nexus_netdb::compiler::bit_plan::NormalizedBitSpan;
use nexus_netdb::re_export::{
    ReByteOrder, ReDbcSeverity, ReProvenance, ReSignalDraft, ReSignalValueType,
};
use nexus_netdb::{parse_and_compile, ByteOrder, DecodedSignalSample, ParseOptions};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

const T_ID: u16 = 0x1A0;
const NOISE_IDS: [u16; 2] = [0x2B0, 0x3D0];
const CONST_ID: u16 = 0x3C0;
const START: u16 = 15;
const LEN: u8 = 16;
const FACTOR: f64 = 0.01;
const RAWS: [u64; 3] = [5000, 6500, 8000];
const FINAL_KMH: f64 = 80.0;
const TICKS: u64 = 80;

fn from<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("must deserialize {v}: {e}"))
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
}

fn span() -> NormalizedBitSpan {
    NormalizedBitSpan::compile(START, LEN, ByteOrder::BigEndian).expect("planted span")
}

/// byte0 = counter, planted span packed via the oracle, other bytes random, byte7 = XOR8 checksum.
fn payload(raw: u64, counter: u8, rng: &mut Lcg) -> [u8; 8] {
    let mut d = [0u8; 64];
    d[0] = counter;
    for b in d.iter_mut().take(7).skip(1) {
        *b = rng.next_u8();
    }
    span().pack_raw_u64(raw, &mut d);
    d[7] = d[..7].iter().fold(0, |a, b| a ^ b);
    let mut out = [0u8; 8];
    out.copy_from_slice(&d[..8]);
    out
}

/// Phase 0 ends at RAWS[0] (wiggling before), phases 1/2 ramp to RAWS[1] / RAWS[2], phase 3 holds
/// RAWS[2] (vehicle cruising at 80 km/h) while every other byte keeps moving.
fn phases() -> [Vec<RawCanFrame>; 4] {
    let mut rng = Lcg(1);
    let mut counter = 0u8;
    let wiggle: [i64; 8] = [0, 1, 2, 1, 0, -1, -2, -1];
    let mut out: [Vec<RawCanFrame>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    for (p, phase) in out.iter_mut().enumerate() {
        for i in 0..TICKS {
            let ts = (p as u64 * TICKS + i) * 20_000;
            let raw = if p == 0 {
                if i == TICKS - 1 {
                    RAWS[0]
                } else {
                    (RAWS[0] as i64 + wiggle[(i % 8) as usize]) as u64
                }
            } else if p == 3 {
                RAWS[2]
            } else {
                RAWS[p - 1] + (RAWS[p] - RAWS[p - 1]) * (i + 1) / TICKS
            };
            phase.push(std_frame(T_ID, &payload(raw, counter, &mut rng), ts));
            counter = counter.wrapping_add(1);
            for (n, &id) in NOISE_IDS.iter().enumerate() {
                let x: [u8; 8] = std::array::from_fn(|_| rng.next_u8());
                phase.push(std_frame(id, &x, ts + 1_000 * (n as u64 + 1)));
            }
            phase.push(std_frame(
                CONST_ID,
                &[0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88],
                ts + 4_000,
            ));
        }
    }
    out
}

fn feed(sh: &ReShared, frames: &[RawCanFrame]) {
    let mut g = sh.lock();
    for f in frames {
        g.ingest(f);
    }
}

fn candidates(st: &impl serde::Serialize) -> u64 {
    serde_json::to_value(st).unwrap()["candidates"]
        .as_u64()
        .expect("candidates")
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

#[test]
fn r2c_e2e_value_scan_to_dbc_planted_motorola16_speed() {
    let sh = ReShared::new();
    {
        let mut g = sh.lock();
        let _ = g.start(None);
        sh.sync_enabled(&g);
    }
    let ph = phases();

    // ── Value scan: Unknown → Increased → Increased → Exact physical 80 (standard preset grid).
    feed(&sh, &ph[0]);
    let s1 = sh
        .scan_first(&from::<ReScanFirstSpec>(json!({ "kind": "unknown" })))
        .unwrap_or_else(|e| panic!("scan_first: {e}"));
    feed(&sh, &ph[1]);
    let s2 = sh
        .scan_next(&from::<ReScanNextOp>(json!({ "op": "increased" })))
        .unwrap_or_else(|e| panic!("increased #1: {e}"));
    feed(&sh, &ph[2]);
    let s3 = sh
        .scan_next(&from::<ReScanNextOp>(json!({ "op": "increased" })))
        .unwrap_or_else(|e| panic!("increased #2: {e}"));
    let s4 = sh
        .scan_next(&from::<ReScanNextOp>(
            json!({ "op": "exact", "value": FINAL_KMH, "physical": true }),
        ))
        .unwrap_or_else(|e| panic!("exact physical: {e}"));
    // The full 66-preset grid lets random noise fields hit 80 under some preset; the operator then
    // holds the speed (cruise) and scans "Unchanged" (toggle mask, §8.6-5).
    feed(&sh, &ph[3]);
    let s5 = sh
        .scan_next(&from::<ReScanNextOp>(json!({ "op": "unchanged" })))
        .unwrap_or_else(|e| panic!("unchanged: {e}"));
    let hist = [s1, s2, s3, s4, s5].map(|s| candidates(&s));
    eprintln!("scan history {hist:?}");
    assert!(
        hist.windows(2).all(|w| w[1] <= w[0]) && hist[4] < hist[3],
        "next scans only filter: {hist:?}"
    );
    assert!(
        hist[4] >= 1 && hist[4] <= 8,
        "narrowed to a handful: {hist:?}"
    );

    // ── Result row of the planted candidate (+ its preset).
    let res = serde_json::to_value(
        sh.scan_results(0, 500, from(json!("id")))
            .unwrap_or_else(|e| panic!("scan_results: {e}")),
    )
    .unwrap();
    let rows = res["rows"].as_array().expect("rows").clone();
    let is_planted = |c: &Value| {
        c["arbId"] == json!(T_ID)
            && c["startBit"] == json!(START)
            && c["bitLength"] == json!(LEN)
            && c["byteOrder"] == "motorola"
            && c["valueType"] == "unsigned"
    };
    let row = rows
        .iter()
        .find(|r| is_planted(&r["candidate"]))
        .unwrap_or_else(|| panic!("planted 15|16 Motorola unsigned not a representative: {res}"));
    for r in &rows {
        let c = &r["candidate"];
        assert_eq!(
            c["arbId"],
            json!(T_ID),
            "only the planted row survives: {r}"
        );
    }
    assert_eq!(
        row["preset"],
        json!({ "factor": FACTOR, "offset": 0.0 }),
        "kept preset"
    );
    assert_eq!(row["currentRaw"].as_f64(), Some(RAWS[2] as f64));
    let cur_phys = row["currentPhysical"].as_f64().expect("currentPhysical");
    assert!(
        (cur_phys - FINAL_KMH).abs() < 1e-9,
        "currentPhysical {cur_phys}"
    );

    // ── Save signal: draft prefilled from the scan row (geometry + kept preset).
    let c = &row["candidate"];
    let preset = &row["preset"];
    let draft = ReSignalDraft {
        id: "r2c-e2e-1".into(),
        bus: c["bus"].as_u64().unwrap() as u8,
        arb_id: c["arbId"].as_u64().unwrap() as u32,
        is_extended: c["isExtended"].as_bool().unwrap(),
        message_name: None,
        dlc_bytes: 8,
        name: "VehSpeed_RE".into(),
        start_bit: c["startBit"].as_u64().unwrap() as u16,
        bit_length: c["bitLength"].as_u64().unwrap() as u8,
        byte_order: from(c["byteOrder"].clone()),
        value_type: from(c["valueType"].clone()),
        factor: preset["factor"].as_f64().unwrap(),
        offset: preset["offset"].as_f64().unwrap(),
        min: 0.0,
        max: 655.35,
        unit: "km/h".into(),
        comment: "R2c value scan".into(),
        provenance: ReProvenance {
            r: None,
            lag_ms: None,
            reference: Some("value scan 80 km/h".into()),
            samples: None,
            created_at_ms: 1_763_500_000_000.0,
        },
        value_table: vec![],
    };
    assert_eq!(draft.byte_order, ReByteOrder::Motorola);
    assert_eq!(draft.value_type, ReSignalValueType::Unsigned);

    let gen = re_dbc_generate(std::slice::from_ref(&draft), None)
        .unwrap_or_else(|e| panic!("re_dbc_generate: {e}"));
    let errs: Vec<_> = gen
        .diagnostics
        .iter()
        .filter(|d| d.severity == ReDbcSeverity::Error)
        .collect();
    assert!(errs.is_empty(), "generator errors: {:?}", gen.diagnostics);
    assert_eq!((gen.messages, gen.signals), (1, 1));
    assert!(
        gen.dbc_text.contains("SG_ VehSpeed_RE : 15|16@0+ (0.01,0)"),
        "signal line:\n{}",
        gen.dbc_text
    );

    let (db, _schema) = parse_and_compile(
        gen.dbc_text.as_bytes(),
        Some("RE_scan.dbc"),
        &ParseOptions::default(),
    )
    .unwrap_or_else(|e| panic!("generated DBC must compile: {e}\n{}", gen.dbc_text));

    // ── Golden decode: scan endpoints + ramp samples + edge raws.
    let id = CanIdKey::new_standard(T_ID).unwrap();
    let mut rng = Lcg(99);
    let mut raws: Vec<u64> = RAWS.to_vec();
    raws.extend((0..20).map(|i| 5000 + i * 157));
    raws.extend([0, 1, 0x7FFF, 0x8000, 0xFFFE, 0xFFFF]);
    for (i, raw) in raws.into_iter().enumerate() {
        let p = payload(raw, i as u8, &mut rng);
        let mut out = [blank(); 16];
        let mut sw = [(0u32, 0i64); 4];
        let s = db
            .decode_payload_into(id, &p, &mut out, &mut sw)
            .expect("message decodes");
        let d = out[..s.decoded_count]
            .iter()
            .find(|d| db.get_signal(d.signal_id).unwrap().name == "VehSpeed_RE")
            .expect("VehSpeed_RE decoded");
        let want = raw as f64 * FACTOR;
        assert_eq!(d.raw_bits, raw, "raw bits for {p:02X?}");
        assert!(
            (d.physical_value - want).abs() <= FACTOR / 2.0,
            "raw {raw}: decoded {} vs planted {want}",
            d.physical_value
        );
    }
}
