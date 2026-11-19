//! QA probes (written BEFORE implementation) for RE Toolkit R2b "Save found signals to DBC".
//! Contract: planning/contracts/re-toolkit-v1.md §7 (7.1 DTO, 7.2 generator, 7.5 gate).
//!
//! Expected status when written: does NOT compile (module `nexus_netdb::re_export` missing).
//!
//! ============================================================================================
//! ASSUMPTION BLOCK (authoritative Rust API for `crates/nexus-netdb/src/re_export.rs`)
//! ============================================================================================
//! ```ignore
//! // lib.rs: `pub mod re_export;` (types reached as `nexus_netdb::re_export::*`)
//! use serde::{Deserialize, Serialize};
//!
//! #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
//! #[serde(rename_all = "camelCase")]
//! pub enum ReByteOrder { Intel, Motorola }                 // "intel" | "motorola" (NOT nexus_netdb::ByteOrder,
//!                                                          //  whose serde form is "littleEndian"/"bigEndian")
//! #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
//! #[serde(rename_all = "camelCase")]
//! pub enum ReSignalValueType { Unsigned, Signed, Float32, Float64 }   // "unsigned" | "signed" | "float32" | "float64"
//!
//! #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
//! #[serde(rename_all = "camelCase")]
//! pub struct ReProvenance {
//!     pub r: Option<f64>,
//!     pub lag_ms: Option<f64>,
//!     pub reference: Option<String>,
//!     pub samples: Option<u64>,
//!     pub created_at_ms: f64,
//! }
//!
//! #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
//! #[serde(rename_all = "camelCase")]
//! pub struct ReValueTableEntry { pub value: i64, pub label: String }
//!
//! #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
//! #[serde(rename_all = "camelCase")]
//! pub struct ReSignalDraft {
//!     pub id: String,
//!     pub bus: u8,
//!     pub arb_id: u32,
//!     pub is_extended: bool,
//!     pub message_name: Option<String>,
//!     pub dlc_bytes: u8,
//!     pub name: String,
//!     pub start_bit: u16,                // DBC convention: Intel = LSB, Motorola = MSB (sawtooth)
//!     pub bit_length: u8,
//!     pub byte_order: ReByteOrder,
//!     pub value_type: ReSignalValueType,
//!     pub factor: f64,
//!     pub offset: f64,
//!     pub min: f64,
//!     pub max: f64,
//!     pub unit: String,
//!     pub comment: String,
//!     pub provenance: ReProvenance,
//!     pub value_table: Vec<ReValueTableEntry>,
//! }
//!
//! #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
//! #[serde(rename_all = "camelCase")]
//! pub enum ReDbcSeverity { Error, Warning }                // "error" | "warning"
//!
//! #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
//! #[serde(rename_all = "camelCase")]
//! pub struct ReDbcDiagnostic {
//!     pub severity: ReDbcSeverity,
//!     pub draft_id: Option<String>,
//!     pub code: String,                  // "bad_name" | "duplicate_name" | "out_of_range" | "overlap" | "bad_scale"
//!                                        // | "float_len" | "name_long" | "base_lossy" | "id_conflict_dlc" | "roundtrip"
//!     pub message: String,
//! }
//!
//! #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
//! #[serde(rename_all = "camelCase")]
//! pub struct ReDbcGenerateResult {
//!     pub dbc_text: String,              // "" when any diagnostic has severity Error
//!     pub diagnostics: Vec<ReDbcDiagnostic>,
//!     pub messages: usize,               // distinct messages that received >= 1 draft (0 on error)
//!     pub signals: usize,                // draft signals written (0 on error); base signals NOT counted
//! }
//!
//! pub fn generate_re_dbc(drafts: &[ReSignalDraft], base: Option<&NetworkDatabase>) -> ReDbcGenerateResult;
//! ```
//!
//! Defaults resolved by QA (to be frozen as contract amendments):
//!  D1  New-message name when `messageName == null` and no base message: standard `RE_{:03X}` (e.g. 0x1A3 ->
//!      `RE_1A3`, 0x00A -> `RE_00A`), extended `RE_{:08X}` (e.g. 0x1CFFA0B1 -> `RE_1CFFA0B1`, 0x1A3 ext ->
//!      `RE_000001A3`). Uppercase hex, no `0x`; the padding makes std/ext with equal numeric id never collide.
//!  D2  If the base DB has the message (id + extended), the base name always wins (draft `messageName` ignored,
//!      base messages are never renamed). Otherwise a non-null `messageName` names the new message.
//!  D3  Grouping is bus-agnostic (same id + extended from different buses -> one message).
//!      New message DLC = max `dlcBytes` of its drafts. Existing base message keeps its DLC.
//!  D4  Provenance line `RE: r=<r:.3> lag=<lag rounded, explicit sign, e.g. +120 / -30 / +0>ms ref=<reference> n=<samples>`;
//!      a null field omits its token; all null -> `RE: manual`. CM_ SG_ text = user comment + "\n" + line, or just
//!      the line when the user comment is empty.
//!  D5  `out_of_range` also covers: start bit >= 512, span past bit 512, bitLength 0 or > 64 (non-float),
//!      dlcBytes > 64.
//!  D6  Name: > 64 chars -> `bad_name` (error); 33..=64 chars -> `name_long` (warning); exactly 32 -> no warning.
//!  D7  `overlap` against a multiplexed base signal (any branch) is an error (drafts are always static).
//!  D8  Empty draft list (no base) -> no diagnostics, valid parseable DBC text, messages = signals = 0.
//!  D9  DBC numbers (factor/offset/min/max) are written losslessly (re-parsed f64 bit-identical).
//! ============================================================================================

use nexus_core::CanIdKey;
use nexus_netdb::re_export::{
    generate_re_dbc, ReByteOrder, ReDbcDiagnostic, ReDbcGenerateResult, ReDbcSeverity,
    ReProvenance, ReSignalDraft, ReSignalValueType, ReValueTableEntry,
};
use nexus_netdb::{
    parse_and_compile, ByteOrder, CompiledDatabase, DatabaseSchemaDto, DecodedSignalSample,
    FormatRegistry, NetworkDatabase, NormalizedBitSpan, ParseOptions,
};
use std::collections::BTreeMap;

const SAMPLE_VEHICLE_DBC: &[u8] = include_bytes!("../../../scripts/sample_vehicle.dbc");

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────

fn prov_none() -> ReProvenance {
    ReProvenance {
        r: None,
        lag_ms: None,
        reference: None,
        samples: None,
        created_at_ms: 1_763_500_000_000.0,
    }
}

#[allow(clippy::too_many_arguments)]
fn draft(
    id: &str,
    arb_id: u32,
    is_extended: bool,
    dlc_bytes: u8,
    name: &str,
    start_bit: u16,
    bit_length: u8,
    byte_order: ReByteOrder,
    value_type: ReSignalValueType,
    factor: f64,
    offset: f64,
) -> ReSignalDraft {
    ReSignalDraft {
        id: id.to_string(),
        bus: 0,
        arb_id,
        is_extended,
        message_name: None,
        dlc_bytes,
        name: name.to_string(),
        start_bit,
        bit_length,
        byte_order,
        value_type,
        factor,
        offset,
        min: 0.0,
        max: 0.0,
        unit: String::new(),
        comment: String::new(),
        provenance: prov_none(),
        value_table: Vec::new(),
    }
}

fn simple(id: &str, arb: u32, name: &str, start: u16, len: u8) -> ReSignalDraft {
    draft(
        id,
        arb,
        false,
        8,
        name,
        start,
        len,
        ReByteOrder::Intel,
        ReSignalValueType::Unsigned,
        1.0,
        0.0,
    )
}

fn errors(res: &ReDbcGenerateResult) -> Vec<&ReDbcDiagnostic> {
    res.diagnostics
        .iter()
        .filter(|d| d.severity == ReDbcSeverity::Error)
        .collect()
}

fn has_diag(
    res: &ReDbcGenerateResult,
    sev: ReDbcSeverity,
    code: &str,
    draft_id: Option<&str>,
) -> bool {
    res.diagnostics.iter().any(|d| {
        d.severity == sev
            && d.code == code
            && match draft_id {
                None => true,
                Some(id) => d.draft_id.as_deref() == Some(id),
            }
    })
}

fn assert_clean(res: &ReDbcGenerateResult, ctx: &str) {
    let errs = errors(res);
    assert!(
        errs.is_empty(),
        "{ctx}: unexpected error diagnostics: {errs:#?}"
    );
    assert!(
        !res.dbc_text.is_empty(),
        "{ctx}: dbc_text must be non-empty without errors"
    );
}

fn assert_blocked(res: &ReDbcGenerateResult, code: &str, draft_id: Option<&str>, ctx: &str) {
    assert!(
        has_diag(res, ReDbcSeverity::Error, code, draft_id),
        "{ctx}: expected error `{code}` (draft {draft_id:?}); got {:#?}",
        res.diagnostics
    );
    assert_eq!(res.dbc_text, "", "{ctx}: any error must blank dbc_text");
    assert_eq!(
        (res.messages, res.signals),
        (0, 0),
        "{ctx}: counts must be 0 on error"
    );
}

fn compile_text(text: &str, ctx: &str) -> (CompiledDatabase, DatabaseSchemaDto) {
    parse_and_compile(
        text.as_bytes(),
        Some("RE_found.dbc"),
        &ParseOptions::default(),
    )
    .unwrap_or_else(|e| {
        panic!("{ctx}: generated DBC failed to re-parse/compile: {e:?}\n---\n{text}")
    })
}

fn gen_ok(
    drafts: &[ReSignalDraft],
    base: Option<&NetworkDatabase>,
    ctx: &str,
) -> (ReDbcGenerateResult, CompiledDatabase, DatabaseSchemaDto) {
    let res = generate_re_dbc(drafts, base);
    assert_clean(&res, ctx);
    let (c, s) = compile_text(&res.dbc_text, ctx);
    (res, c, s)
}

fn sig_id(schema: &DatabaseSchemaDto, arb: u32, ext: bool, name: &str) -> u32 {
    let msg = schema
        .messages
        .iter()
        .find(|m| m.arb_id == arb && m.is_extended == ext)
        .unwrap_or_else(|| panic!("message 0x{arb:X} ext={ext} missing in schema"));
    msg.signal_ids
        .iter()
        .copied()
        .find(|id| {
            schema
                .signals
                .iter()
                .any(|s| s.signal_id == *id && s.name == name)
        })
        .unwrap_or_else(|| panic!("signal {name} missing in message 0x{arb:X}"))
}

fn decode_all(c: &CompiledDatabase, key: CanIdKey, payload: &[u8]) -> Vec<DecodedSignalSample> {
    let mut buf = [DecodedSignalSample {
        signal_id: 0,
        raw_bits: 0,
        raw_int: 0,
        physical_value: 0.0,
        out_of_range: false,
        is_mux_switch: false,
    }; 256];
    let mut sw = [(0u32, 0i64); 16];
    let sum = c
        .decode_payload_into(key, payload, &mut buf, &mut sw)
        .unwrap_or_else(|| panic!("message {key:?} not decodable"));
    buf[..sum.decoded_count].to_vec()
}

fn decode_named(
    c: &CompiledDatabase,
    s: &DatabaseSchemaDto,
    arb: u32,
    ext: bool,
    payload: &[u8],
    name: &str,
) -> DecodedSignalSample {
    let id = sig_id(s, arb, ext, name);
    decode_all(c, CanIdKey::new_masked(arb, ext), payload)
        .into_iter()
        .find(|x| x.signal_id == id)
        .unwrap_or_else(|| panic!("{name} not decoded"))
}

fn to_netdb_order(o: ReByteOrder) -> ByteOrder {
    match o {
        ReByteOrder::Intel => ByteOrder::LittleEndian,
        ReByteOrder::Motorola => ByteOrder::BigEndian,
    }
}

/// "RE series decode" reference: NormalizedBitSpan extraction + type interpretation × factor + offset,
/// re-implemented here (NOT via CompiledSignal::decode_physical).
fn span_physical(d: &ReSignalDraft, payload: &[u8]) -> f64 {
    let span = NormalizedBitSpan::compile(d.start_bit, d.bit_length, to_netdb_order(d.byte_order))
        .unwrap();
    let raw = span.extract_raw_u64(payload);
    let v = match d.value_type {
        ReSignalValueType::Unsigned => raw as f64,
        ReSignalValueType::Signed => {
            let n = d.bit_length as u32;
            let sign = 1u64 << (n - 1);
            if n == 64 {
                raw as i64 as f64
            } else if raw & sign != 0 {
                (raw as i64 - (1i64 << n)) as f64
            } else {
                raw as f64
            }
        }
        ReSignalValueType::Float32 => f32::from_bits(raw as u32) as f64,
        ReSignalValueType::Float64 => f64::from_bits(raw),
    };
    v * d.factor + d.offset
}

fn pack(d: &ReSignalDraft, raw: u64, payload: &mut [u8; 64]) {
    NormalizedBitSpan::compile(d.start_bit, d.bit_length, to_netdb_order(d.byte_order))
        .unwrap()
        .pack_raw_u64(raw, payload);
}

fn assert_bits_eq(actual: f64, expected: f64, ctx: &str) {
    assert!(
        actual.to_bits() == expected.to_bits(),
        "{ctx}: decoded {actual:?} != reference {expected:?}"
    );
}

/// Round-trip one draft through generate -> parse_and_compile -> decode and compare with the span reference
/// and an independent hand-computed constant.
fn roundtrip_value(d: &ReSignalDraft, payload: &[u8], hand_expected: f64, ctx: &str) {
    let (_res, c, s) = gen_ok(std::slice::from_ref(d), None, ctx);
    let dlc = d.dlc_bytes as usize;
    let got = decode_named(&c, &s, d.arb_id, d.is_extended, &payload[..dlc], &d.name);
    let reference = span_physical(d, &payload[..dlc]);
    assert_bits_eq(got.physical_value, reference, ctx);
    assert!(
        (got.physical_value - hand_expected).abs() <= 1e-9 * hand_expected.abs().max(1.0),
        "{ctx}: decoded {} != hand-computed {hand_expected}",
        got.physical_value
    );
}

fn base_db(bytes: &[u8], hint: &str) -> NetworkDatabase {
    FormatRegistry::new()
        .parse_bytes(bytes, Some(hint), &ParseOptions::default())
        .expect("base parses")
        .database
}

// ─── 1. Serde contract (Rust <-> TS camelCase) ───────────────────────────────────────────

#[test]
fn serde_draft_deserializes_from_ts_shaped_json() {
    let json = r#"{
      "id": "6f1c2c1e-0000-4000-8000-000000000001",
      "bus": 1, "arbId": 419, "isExtended": false, "messageName": null, "dlcBytes": 8,
      "name": "VehSpeed", "startBit": 11, "bitLength": 12, "byteOrder": "motorola", "valueType": "signed",
      "factor": 0.25, "offset": -40, "min": -100, "max": 300, "unit": "km/h", "comment": "found",
      "provenance": { "r": 0.998, "lagMs": 120, "reference": "OBD 0x0D", "samples": 812, "createdAtMs": 1763500000000 },
      "valueTable": [ { "value": 0, "label": "Off" } ]
    }"#;
    let d: ReSignalDraft = serde_json::from_str(json).expect("TS-shaped draft must deserialize");
    assert_eq!(d.arb_id, 419);
    assert_eq!(d.byte_order, ReByteOrder::Motorola);
    assert_eq!(d.value_type, ReSignalValueType::Signed);
    assert_eq!(d.message_name, None);
    assert_eq!(d.provenance.lag_ms, Some(120.0));
    assert_eq!(d.provenance.samples, Some(812));
    assert_eq!(
        d.value_table,
        vec![ReValueTableEntry {
            value: 0,
            label: "Off".into()
        }]
    );

    for (s, want) in [
        ("\"unsigned\"", ReSignalValueType::Unsigned),
        ("\"float32\"", ReSignalValueType::Float32),
        ("\"float64\"", ReSignalValueType::Float64),
    ] {
        assert_eq!(serde_json::from_str::<ReSignalValueType>(s).unwrap(), want);
    }
    assert_eq!(
        serde_json::from_str::<ReByteOrder>("\"intel\"").unwrap(),
        ReByteOrder::Intel
    );
}

#[test]
fn serde_result_serializes_camelcase() {
    let mut d = simple("a", 0x100, "Bad Name", 0, 8);
    d.name = "1bad".into();
    let res = generate_re_dbc(&[d], None);
    let v = serde_json::to_value(&res).unwrap();
    assert!(v.get("dbcText").is_some(), "dbcText key: {v}");
    assert!(
        v.get("messages").is_some() && v.get("signals").is_some(),
        "{v}"
    );
    let diag = &v["diagnostics"][0];
    assert_eq!(diag["severity"], "error", "{v}");
    assert_eq!(diag["draftId"], "a", "{v}");
    assert_eq!(diag["code"], "bad_name", "{v}");
    assert!(diag["message"].is_string());
}

// ─── 2. Standalone structure ─────────────────────────────────────────────────────────────

#[test]
fn standalone_header_node_names_and_counts() {
    let a = simple("a", 0x1A3, "SigA", 0, 8);
    let b = simple("b", 0x1A3, "SigB", 8, 8);
    let c = simple("c", 0x00A, "SigC", 0, 4);
    let mut e = simple("e", 0x1CFF_A0B1, "SigE", 0, 16);
    e.is_extended = true;
    let mut named = simple("n", 0x2B0, "SigN", 0, 8);
    named.message_name = Some("BodyStatus".into());

    let (res, _c, s) = gen_ok(&[a, b, c, e, named], None, "standalone");
    let t = &res.dbc_text;
    assert!(t.contains("VERSION \"NexusCAN RE\""), "VERSION line:\n{t}");
    assert!(
        t.lines()
            .any(|l| l.starts_with("BU_:") && l.split_whitespace().any(|w| w == "RE_FOUND")),
        "BU_ RE_FOUND:\n{t}"
    );
    assert!(
        t.contains("Vector__XXX"),
        "transmitter/receiver Vector__XXX:\n{t}"
    );
    assert_eq!((res.messages, res.signals), (4, 5));

    let name_of = |arb: u32, ext: bool| -> String {
        s.messages
            .iter()
            .find(|m| m.arb_id == arb && m.is_extended == ext)
            .unwrap()
            .name
            .clone()
    };
    assert_eq!(name_of(0x1A3, false), "RE_1A3");
    assert_eq!(name_of(0x00A, false), "RE_00A");
    assert_eq!(name_of(0x1CFF_A0B1, true), "RE_1CFFA0B1");
    assert_eq!(name_of(0x2B0, false), "BodyStatus");
    let m = s.messages.iter().find(|m| m.arb_id == 0x1A3).unwrap();
    assert_eq!(m.dlc, 8);
    // Amendment 13 (§7.5a): the DBC parser maps `Vector__XXX` to "no node" by design, so the schema lists are empty;
    // the text itself must carry Vector__XXX on the BO_ and SG_ lines.
    assert!(m.transmitters.is_empty(), "{:?}", m.transmitters);
    let sa = s.signals.iter().find(|x| x.name == "SigA").unwrap();
    assert!(sa.receivers.is_empty(), "{:?}", sa.receivers);
    assert!(
        t.lines()
            .any(|l| l.starts_with("BO_ 419 RE_1A3:") && l.trim_end().ends_with("Vector__XXX")),
        "BO_ transmitter Vector__XXX:\n{t}"
    );
    assert!(
        t.lines()
            .any(|l| l.trim_start().starts_with("SG_ SigA ")
                && l.trim_end().ends_with("Vector__XXX")),
        "SG_ receiver Vector__XXX:\n{t}"
    );
}

#[test]
fn empty_drafts_produce_valid_dbc() {
    let res = generate_re_dbc(&[], None);
    assert!(errors(&res).is_empty(), "{:#?}", res.diagnostics);
    assert!(!res.dbc_text.is_empty());
    compile_text(&res.dbc_text, "empty");
    assert_eq!((res.messages, res.signals), (0, 0));
}

#[test]
fn grouping_is_bus_agnostic_and_dlc_is_max_of_drafts() {
    let mut a = simple("a", 0x300, "OnBus0", 0, 8);
    a.bus = 0;
    a.dlc_bytes = 8;
    let mut b = simple("b", 0x300, "OnBus1", 8, 8);
    b.bus = 1;
    b.dlc_bytes = 12;
    let (res, _c, s) = gen_ok(&[a, b], None, "bus-agnostic");
    assert_eq!(res.messages, 1);
    let msgs: Vec<_> = s.messages.iter().filter(|m| m.arb_id == 0x300).collect();
    assert_eq!(msgs.len(), 1, "one message per id regardless of bus");
    assert_eq!(msgs[0].dlc, 12, "D3: new message DLC = max dlcBytes");
}

#[test]
fn std_and_ext_with_same_numeric_id_are_distinct_messages() {
    let a = simple("a", 0x1A3, "StdSig", 0, 8);
    let mut b = simple("b", 0x1A3, "ExtSig", 0, 8);
    b.is_extended = true;
    let (_res, c, s) = gen_ok(&[a, b], None, "std/ext");
    let std_m = s
        .messages
        .iter()
        .find(|m| m.arb_id == 0x1A3 && !m.is_extended)
        .unwrap();
    let ext_m = s
        .messages
        .iter()
        .find(|m| m.arb_id == 0x1A3 && m.is_extended)
        .unwrap();
    assert_eq!(std_m.name, "RE_1A3");
    assert_eq!(ext_m.name, "RE_000001A3");
    let p = [0x5Au8, 0, 0, 0, 0, 0, 0, 0];
    assert_eq!(
        decode_named(&c, &s, 0x1A3, false, &p, "StdSig").physical_value,
        90.0
    );
    assert_eq!(
        decode_named(&c, &s, 0x1A3, true, &p, "ExtSig").physical_value,
        90.0
    );
}

#[test]
fn generator_is_deterministic() {
    let drafts = [
        simple("a", 0x1A3, "SigA", 0, 8),
        simple("b", 0x0F0, "SigB", 8, 8),
    ];
    let r1 = generate_re_dbc(&drafts, None);
    let r2 = generate_re_dbc(&drafts, None);
    assert_eq!(r1, r2);
}

// ─── 3. Decode equivalence (generated DBC vs NormalizedBitSpan reference) ────────────────

#[test]
fn roundtrip_intel_12bit_signed_crossing_byte() {
    let d = draft(
        "i12",
        0x123,
        false,
        8,
        "Intel12s",
        4,
        12,
        ReByteOrder::Intel,
        ReSignalValueType::Signed,
        0.001,
        0.0,
    );
    // raw -12 = 0xFF4 at LSB bit 4: byte0 = 0x40, byte1 = 0xFF (hand-built golden)
    let mut neg = [0u8; 64];
    neg[0] = 0x40;
    neg[1] = 0xFF;
    roundtrip_value(&d, &neg, -0.012, "Intel 12s -12");
    // raw +12 = 0x00C: byte0 = 0xC0, byte1 = 0x00
    let mut pos = [0u8; 64];
    pos[0] = 0xC0;
    roundtrip_value(&d, &pos, 0.012, "Intel 12s +12");
    let mut min = [0u8; 64];
    pack(&d, 0x800, &mut min);
    roundtrip_value(&d, &min, -2.048, "Intel 12s min");
}

#[test]
fn roundtrip_motorola_12bit_signed_sawtooth() {
    let d = draft(
        "m12",
        0x124,
        false,
        8,
        "Moto12s",
        11,
        12,
        ReByteOrder::Motorola,
        ReSignalValueType::Signed,
        0.001,
        0.0,
    );
    // MSB at byte1 bit3: byte1[3..0] = raw[11..8], byte2 = raw[7..0]. raw 0xFF4 -> byte1 = 0x0F, byte2 = 0xF4.
    let mut neg = [0u8; 64];
    neg[1] = 0x0F;
    neg[2] = 0xF4;
    roundtrip_value(&d, &neg, -0.012, "Moto 12s -12");
    let mut pos = [0u8; 64];
    pos[2] = 0x0C;
    roundtrip_value(&d, &pos, 0.012, "Moto 12s +12");
    let mut packed = [0u8; 64];
    pack(&d, 0x7FF, &mut packed);
    assert_eq!(
        (packed[1], packed[2]),
        (0x07, 0xFF),
        "sawtooth layout sanity"
    );
    roundtrip_value(&d, &packed, 2.047, "Moto 12s max");
}

#[test]
fn roundtrip_unsigned_16bit() {
    let d = draft(
        "u16",
        0x125,
        false,
        8,
        "U16",
        16,
        16,
        ReByteOrder::Intel,
        ReSignalValueType::Unsigned,
        0.25,
        -40.0,
    );
    let mut p = [0u8; 64];
    p[2] = 0x34;
    p[3] = 0x12;
    roundtrip_value(&d, &p, 0x1234 as f64 * 0.25 - 40.0, "U16 Intel");
    let m = draft(
        "u16m",
        0x126,
        false,
        8,
        "U16m",
        7,
        16,
        ReByteOrder::Motorola,
        ReSignalValueType::Unsigned,
        0.25,
        -40.0,
    );
    let mut q = [0u8; 64];
    q[0] = 0x12;
    q[1] = 0x34;
    roundtrip_value(&m, &q, 0x1234 as f64 * 0.25 - 40.0, "U16 Motorola");
}

#[test]
fn roundtrip_float32_and_float64_with_sig_valtype() {
    let f = draft(
        "f32",
        0x127,
        false,
        8,
        "F32",
        32,
        32,
        ReByteOrder::Intel,
        ReSignalValueType::Float32,
        1.0,
        0.0,
    );
    let val = 2.718_5_f32;
    let mut p = [0u8; 64];
    p[4..8].copy_from_slice(&val.to_le_bytes());
    roundtrip_value(&f, &p, val as f64, "float32");
    let res = generate_re_dbc(std::slice::from_ref(&f), None);
    assert!(
        res.dbc_text
            .lines()
            .any(|l| l.starts_with("SIG_VALTYPE_ 295 F32") && l.contains(": 1")),
        "SIG_VALTYPE_ 295 F32 : 1 missing:\n{}",
        res.dbc_text
    );

    let g = draft(
        "f64",
        0x128,
        false,
        8,
        "F64",
        0,
        64,
        ReByteOrder::Intel,
        ReSignalValueType::Float64,
        2.0,
        1.0,
    );
    let v64 = -12_345.678_f64;
    let mut q = [0u8; 64];
    q[..8].copy_from_slice(&v64.to_le_bytes());
    roundtrip_value(&g, &q, v64 * 2.0 + 1.0, "float64");
    let res = generate_re_dbc(std::slice::from_ref(&g), None);
    assert!(
        res.dbc_text
            .lines()
            .any(|l| l.starts_with("SIG_VALTYPE_ 296 F64") && l.contains(": 2")),
        "SIG_VALTYPE_ 296 F64 : 2 missing:\n{}",
        res.dbc_text
    );
}

#[test]
fn roundtrip_canfd_64byte_signal_at_startbit_300() {
    let i = draft(
        "fdI",
        0x3F0,
        false,
        64,
        "FdIntel300",
        300,
        16,
        ReByteOrder::Intel,
        ReSignalValueType::Unsigned,
        0.1,
        0.0,
    );
    // Intel LSB bit 300 = byte37 bit4: 0xBEEF -> byte37 = 0xF0, byte38 = 0xEE, byte39 = 0x0B
    let mut p = [0u8; 64];
    p[37] = 0xF0;
    p[38] = 0xEE;
    p[39] = 0x0B;
    roundtrip_value(&i, &p, 0xBEEF as f64 * 0.1, "FD Intel @300");

    let m = draft(
        "fdM",
        0x3F1,
        false,
        64,
        "FdMoto300",
        300,
        14,
        ReByteOrder::Motorola,
        ReSignalValueType::Signed,
        0.5,
        10.0,
    );
    let mut q = [0u8; 64];
    pack(&m, (-1000i64 as u64) & 0x3FFF, &mut q);
    roundtrip_value(&m, &q, -1000.0 * 0.5 + 10.0, "FD Motorola @300");

    let (_r, _c, s) = gen_ok(&[i, m], None, "fd dlc");
    for arb in [0x3F0, 0x3F1] {
        assert_eq!(s.messages.iter().find(|x| x.arb_id == arb).unwrap().dlc, 64);
    }
}

#[test]
fn extended_29bit_id_roundtrip() {
    let mut d = draft(
        "x",
        0x1CFF_A0B1,
        true,
        8,
        "ExtSpeed",
        8,
        16,
        ReByteOrder::Intel,
        ReSignalValueType::Unsigned,
        0.01,
        0.0,
    );
    d.message_name = None;
    let (res, c, s) = gen_ok(std::slice::from_ref(&d), None, "ext");
    assert!(
        res.dbc_text
            .contains(&format!("BO_ {} ", 0x1CFF_A0B1u32 | 0x8000_0000)),
        "extended BO_ id must carry bit 31:\n{}",
        res.dbc_text
    );
    assert!(c.get_message(&CanIdKey::Extended(0x1CFF_A0B1)).is_some());
    assert!(
        c.get_message(&CanIdKey::Standard(0x0B1)).is_none(),
        "29-bit id must not leak into the 11-bit space"
    );
    let mut p = [0u8; 64];
    p[1] = 0x10;
    p[2] = 0x27;
    roundtrip_value(&d, &p, 100.0, "ext decode");
    let _ = s;
}

#[test]
fn signal_attributes_roundtrip_losslessly() {
    let mut d = draft(
        "attr",
        0x200,
        false,
        8,
        "Awkward",
        7,
        16,
        ReByteOrder::Motorola,
        ReSignalValueType::Signed,
        0.249_998_713_1,
        -40.000_12,
    );
    d.min = -8_231.123_456_789;
    d.max = 8_150.987_654_321;
    d.unit = "km/h".into();
    let (_res, c, s) = gen_ok(std::slice::from_ref(&d), None, "attrs");
    let sig = s.signals.iter().find(|x| x.name == "Awkward").unwrap();
    assert_eq!(sig.start_bit, 7);
    assert_eq!(sig.bit_length, 16);
    assert_eq!(
        sig.factor.to_bits(),
        d.factor.to_bits(),
        "factor lossless (D9): {}",
        sig.factor
    );
    assert_eq!(
        sig.offset.to_bits(),
        d.offset.to_bits(),
        "offset lossless (D9): {}",
        sig.offset
    );
    assert_eq!(sig.min.to_bits(), d.min.to_bits(), "min lossless (D9)");
    assert_eq!(sig.max.to_bits(), d.max.to_bits(), "max lossless (D9)");
    assert_eq!(sig.unit, "km/h");
    let cs = c.get_signal(sig.signal_id).unwrap();
    assert_eq!(cs.byte_order, ByteOrder::BigEndian);
    assert!(cs.value_type.is_signed());
}

// ─── 4. Error / warning diagnostics ──────────────────────────────────────────────────────

#[test]
fn err_overlap_between_drafts() {
    let a = simple("a", 0x400, "A", 0, 12);
    let b = simple("b", 0x400, "B", 8, 8);
    let res = generate_re_dbc(&[a, b], None);
    assert!(
        res.diagnostics
            .iter()
            .any(|d| d.severity == ReDbcSeverity::Error
                && d.code == "overlap"
                && matches!(d.draft_id.as_deref(), Some("a") | Some("b"))),
        "{:#?}",
        res.diagnostics
    );
    assert_blocked(&res, "overlap", None, "draft/draft overlap");

    // Intel vs Motorola overlap on the same physical bits
    let i = simple("i", 0x401, "I", 8, 8); // byte1
    let m = draft(
        "m",
        0x401,
        false,
        8,
        "M",
        15,
        4,
        ReByteOrder::Motorola,
        ReSignalValueType::Unsigned,
        1.0,
        0.0,
    ); // byte1 bits 7..4
    assert_blocked(
        &generate_re_dbc(&[i, m], None),
        "overlap",
        None,
        "intel/motorola overlap",
    );

    // Adjacent, non-overlapping: fine; same bits in DIFFERENT messages: fine
    let x = simple("x", 0x402, "X", 0, 8);
    let y = simple("y", 0x402, "Y", 8, 8);
    let z = simple("z", 0x403, "Z", 0, 8);
    gen_ok(&[x, y, z], None, "adjacent ok");
}

#[test]
fn err_overlap_with_base_static_and_mux_branch_signals() {
    let base = base_db(SAMPLE_VEHICLE_DBC, "sample_vehicle.dbc");
    // 513 INV_FastTelemetryFD: E2E_Crc16 = 0|16@1+
    let mut a = simple("a", 513, "ReCrcClash", 0, 8);
    a.dlc_bytes = 64;
    assert_blocked(
        &generate_re_dbc(&[a], Some(&base)),
        "overlap",
        Some("a"),
        "base static overlap",
    );
    // 261 BMS_MuxDiagnostics: CellBank0MinMv m0 : 16|16 (branch signal) -> still overlap (D7)
    let b = simple("b", 261, "ReMuxClash", 16, 8);
    assert_blocked(
        &generate_re_dbc(&[b], Some(&base)),
        "overlap",
        Some("b"),
        "base mux-branch overlap",
    );
}

#[test]
fn err_bad_name() {
    for (i, bad) in [
        "",
        "1abc",
        "has space",
        "a-b",
        "çay",
        "x\"y",
        &"A".repeat(65),
    ]
    .iter()
    .enumerate()
    {
        let mut d = simple("d", 0x410 + i as u32, "ok", 0, 8);
        d.name = bad.to_string();
        assert_blocked(
            &generate_re_dbc(&[d], None),
            "bad_name",
            Some("d"),
            &format!("name {bad:?}"),
        );
    }
    for good in ["_x", "a", "Sig_9", "ABC_def_123"] {
        let mut d = simple("d", 0x420, "ok", 0, 8);
        d.name = good.to_string();
        gen_ok(&[d], None, &format!("name {good:?}"));
    }
}

#[test]
fn warn_name_long_between_33_and_64() {
    let mut d32 = simple("d32", 0x430, "x", 0, 8);
    d32.name = "N".repeat(32);
    let (r32, _, _) = gen_ok(&[d32], None, "32 chars");
    assert!(
        !has_diag(&r32, ReDbcSeverity::Warning, "name_long", None),
        "32 chars: no warning"
    );

    for n in [33usize, 64] {
        let mut d = simple("dl", 0x431, "x", 0, 8);
        d.name = "L".repeat(n);
        let (r, c, s) = gen_ok(std::slice::from_ref(&d), None, &format!("{n} chars"));
        assert!(
            has_diag(&r, ReDbcSeverity::Warning, "name_long", Some("dl")),
            "{n}: {:#?}",
            r.diagnostics
        );
        assert!(errors(&r).is_empty());
        // name survives unchanged (not truncated / sanitized)
        decode_named(&c, &s, 0x431, false, &[0u8; 8], &d.name);
    }
}

#[test]
fn err_out_of_range() {
    // Intel bits 60..67 in an 8-byte message
    assert_blocked(
        &generate_re_dbc(&[simple("a", 0x440, "A", 60, 8)], None),
        "out_of_range",
        Some("a"),
        "intel past dlc",
    );
    // Motorola 16 bits from byte0 bit7 into byte1 with dlcBytes = 1
    let mut m = draft(
        "m",
        0x441,
        false,
        1,
        "M",
        7,
        16,
        ReByteOrder::Motorola,
        ReSignalValueType::Unsigned,
        1.0,
        0.0,
    );
    assert_blocked(
        &generate_re_dbc(std::slice::from_ref(&m), None),
        "out_of_range",
        Some("m"),
        "motorola past dlc",
    );
    m.dlc_bytes = 2;
    gen_ok(&[m], None, "motorola fits in 2 bytes");
    // Motorola running off byte 63 (start byte63 bit3, 8 bits -> needs byte 64)
    let mm = draft(
        "mm",
        0x442,
        false,
        64,
        "MM",
        507,
        8,
        ReByteOrder::Motorola,
        ReSignalValueType::Unsigned,
        1.0,
        0.0,
    );
    assert_blocked(
        &generate_re_dbc(&[mm], None),
        "out_of_range",
        Some("mm"),
        "motorola past 512",
    );
    // start >= 512, span past 512, length 0, length > 64, dlcBytes > 64 (D5)
    let mut s512 = simple("s", 0x443, "S", 512, 1);
    s512.dlc_bytes = 64;
    assert_blocked(
        &generate_re_dbc(&[s512], None),
        "out_of_range",
        Some("s"),
        "start 512",
    );
    let mut past = simple("p", 0x444, "P", 500, 16);
    past.dlc_bytes = 64;
    assert_blocked(
        &generate_re_dbc(&[past], None),
        "out_of_range",
        Some("p"),
        "intel past 512",
    );
    assert_blocked(
        &generate_re_dbc(&[simple("z", 0x445, "Z", 0, 0)], None),
        "out_of_range",
        Some("z"),
        "len 0",
    );
    let mut big = simple("b", 0x446, "B", 0, 65);
    big.dlc_bytes = 64;
    assert_blocked(
        &generate_re_dbc(&[big], None),
        "out_of_range",
        Some("b"),
        "len 65",
    );
    let mut dlc65 = simple("d", 0x447, "D", 0, 8);
    dlc65.dlc_bytes = 65;
    assert_blocked(
        &generate_re_dbc(&[dlc65], None),
        "out_of_range",
        Some("d"),
        "dlcBytes 65",
    );
    // dlcBytes = 0 -> no bit fits
    let mut dlc0 = simple("e", 0x448, "E", 0, 1);
    dlc0.dlc_bytes = 0;
    assert_blocked(
        &generate_re_dbc(&[dlc0], None),
        "out_of_range",
        Some("e"),
        "dlcBytes 0",
    );
    // last bit exactly fits
    gen_ok(&[simple("ok", 0x449, "Ok", 56, 8)], None, "exact fit");
}

#[test]
fn err_duplicate_name_same_message_only() {
    let a = simple("a", 0x450, "Same", 0, 8);
    let b = simple("b", 0x450, "Same", 8, 8);
    let res = generate_re_dbc(&[a, b], None);
    assert!(
        res.diagnostics
            .iter()
            .any(|d| d.severity == ReDbcSeverity::Error
                && d.code == "duplicate_name"
                && matches!(d.draft_id.as_deref(), Some("a") | Some("b"))),
        "{:#?}",
        res.diagnostics
    );
    assert_blocked(&res, "duplicate_name", None, "dup same message");

    // same name in different messages is legal DBC
    gen_ok(
        &[
            simple("c", 0x451, "Same", 0, 8),
            simple("d", 0x452, "Same", 0, 8),
        ],
        None,
        "dup across messages",
    );

    // duplicate of a base signal name in the same base message
    let base = base_db(SAMPLE_VEHICLE_DBC, "sample_vehicle.dbc");
    let mut e = simple("e", 513, "TailIntegrityMarker", 300, 8);
    e.dlc_bytes = 64;
    assert_blocked(
        &generate_re_dbc(&[e], Some(&base)),
        "duplicate_name",
        Some("e"),
        "dup with base",
    );
}

#[test]
fn err_bad_scale() {
    type Mutator = fn(&mut ReSignalDraft);
    let cases: [(&str, Mutator); 7] = [
        ("factor 0", |d| d.factor = 0.0),
        ("factor NaN", |d| d.factor = f64::NAN),
        ("factor inf", |d| d.factor = f64::INFINITY),
        ("offset NaN", |d| d.offset = f64::NAN),
        ("min -inf", |d| d.min = f64::NEG_INFINITY),
        ("max NaN", |d| d.max = f64::NAN),
        ("min > max", |d| {
            d.min = 10.0;
            d.max = 5.0
        }),
    ];
    for (ctx, mutate) in cases {
        let mut d = simple("d", 0x460, "S", 0, 8);
        mutate(&mut d);
        assert_blocked(&generate_re_dbc(&[d], None), "bad_scale", Some("d"), ctx);
    }
    // negative factor and min == max are legal
    let mut ok = simple("ok", 0x461, "Neg", 0, 8);
    ok.factor = -0.5;
    ok.min = 3.0;
    ok.max = 3.0;
    gen_ok(&[ok], None, "negative factor");
}

#[test]
fn err_float_len() {
    for (vt, len) in [
        (ReSignalValueType::Float32, 16u8),
        (ReSignalValueType::Float32, 64),
        (ReSignalValueType::Float64, 32),
    ] {
        let d = draft(
            "f",
            0x470,
            false,
            8,
            "F",
            0,
            len,
            ReByteOrder::Intel,
            vt,
            1.0,
            0.0,
        );
        assert_blocked(
            &generate_re_dbc(&[d], None),
            "float_len",
            Some("f"),
            &format!("{vt:?} len {len}"),
        );
    }
}

#[test]
fn any_error_blanks_text_even_with_valid_drafts() {
    let good1 = simple("g1", 0x480, "Good1", 0, 8);
    let good2 = simple("g2", 0x481, "Good2", 0, 8);
    let mut bad = simple("bad", 0x482, "Bad", 0, 8);
    bad.factor = 0.0;
    let res = generate_re_dbc(&[good1, bad, good2], None);
    assert_blocked(&res, "bad_scale", Some("bad"), "mixed");
    assert!(
        res.diagnostics
            .iter()
            .all(|d| d.severity == ReDbcSeverity::Warning || d.draft_id.as_deref() == Some("bad")),
        "valid drafts must not get error diagnostics: {:#?}",
        res.diagnostics
    );
}

#[test]
fn warn_id_conflict_dlc_with_base() {
    let base = base_db(SAMPLE_VEHICLE_DBC, "sample_vehicle.dbc");
    // DCFC_ChargerStatus 0x18FF50E5 (ext), DLC 8; bits 38..39 are free.
    let mut d = simple("d", 0x18FF_50E5, "ReFreeBits", 38, 2);
    d.is_extended = true;
    d.dlc_bytes = 16;
    let (res, c, s) = gen_ok(std::slice::from_ref(&d), Some(&base), "id_conflict_dlc");
    assert!(
        has_diag(&res, ReDbcSeverity::Warning, "id_conflict_dlc", Some("d")),
        "{:#?}",
        res.diagnostics
    );
    let msg = s
        .messages
        .iter()
        .find(|m| m.arb_id == 0x18FF_50E5 && m.is_extended)
        .unwrap();
    assert_eq!(msg.dlc, 8, "D3: base message keeps its DLC");
    assert_eq!(msg.name, "DCFC_ChargerStatus");
    let mut p = [0u8; 8];
    p[4] = 0b1100_0000;
    assert_eq!(
        decode_named(&c, &s, 0x18FF_50E5, true, &p, "ReFreeBits").physical_value,
        3.0
    );

    // same DLC -> no warning
    let mut same = d.clone();
    same.dlc_bytes = 8;
    let (r2, _, _) = gen_ok(&[same], Some(&base), "same dlc");
    assert!(!has_diag(
        &r2,
        ReDbcSeverity::Warning,
        "id_conflict_dlc",
        None
    ));
}

// ─── 5. Merge with base ──────────────────────────────────────────────────────────────────

fn lcg(seed: &mut u64) -> u8 {
    *seed = seed
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    (*seed >> 33) as u8
}

type SigMap = BTreeMap<String, (u64, u64)>;

fn decode_map(
    c: &CompiledDatabase,
    s: &DatabaseSchemaDto,
    key: CanIdKey,
    payload: &[u8],
) -> SigMap {
    decode_all(c, key, payload)
        .into_iter()
        .map(|x| {
            let name = s
                .signals
                .iter()
                .find(|z| z.signal_id == x.signal_id)
                .unwrap()
                .name
                .clone();
            (name, (x.raw_bits, x.physical_value.to_bits()))
        })
        .collect()
}

#[test]
fn merge_with_base_keeps_every_base_signal_bit_identical() {
    let base = base_db(SAMPLE_VEHICLE_DBC, "sample_vehicle.dbc");
    let (bc, bs) = parse_and_compile(
        SAMPLE_VEHICLE_DBC,
        Some("sample_vehicle.dbc"),
        &ParseOptions::default(),
    )
    .unwrap();

    // into existing FD message 513 (free bytes 36..60) with messageName null -> base name kept
    let mut into513 = draft(
        "e513",
        513,
        false,
        64,
        "ReFdFree300",
        300,
        16,
        ReByteOrder::Intel,
        ReSignalValueType::Unsigned,
        0.1,
        0.0,
    );
    into513.message_name = Some("IgnoredRename".into()); // D2: base name wins
                                                         // brand-new message
    let fresh = simple("new", 0x3A0, "ReNewSig", 0, 16);
    let (res, mc, ms) = gen_ok(&[into513.clone(), fresh], Some(&base), "merge");
    assert_eq!(
        (res.messages, res.signals),
        (2, 2),
        "counts = draft-touched messages / draft signals"
    );
    assert!(
        res.diagnostics
            .iter()
            .all(|d| d.severity == ReDbcSeverity::Warning),
        "merge must not error: {:#?}",
        res.diagnostics
    );
    assert_eq!(
        ms.signals.len(),
        bs.signals.len() + 2,
        "every base signal kept + 2 drafts"
    );
    assert_eq!(
        ms.messages.iter().find(|m| m.arb_id == 513).unwrap().name,
        "INV_FastTelemetryFD"
    );
    assert_eq!(
        ms.messages.iter().find(|m| m.arb_id == 0x3A0).unwrap().name,
        "RE_3A0"
    );

    // enum tables survive
    for name in ["InverterState", "ContactorState", "ChargerOperatingState"] {
        let b = &bs
            .signals
            .iter()
            .find(|x| x.name == name)
            .unwrap()
            .enum_table;
        let m = &ms
            .signals
            .iter()
            .find(|x| x.name == name)
            .unwrap()
            .enum_table;
        assert_eq!(b, m, "VAL_ of base {name} preserved");
    }

    // golden frames: every base message, LCG payloads + forced mux domains
    let mut seed = 0x5EED_u64;
    let mut frames_checked = 0usize;
    for bm in &bs.messages {
        let key = CanIdKey::new_masked(bm.arb_id, bm.is_extended);
        if bc.get_message(&key).is_none() {
            continue;
        }
        let dlc = bm.dlc as usize;
        for f in 0..48 {
            let mut p = vec![0u8; dlc];
            for b in p.iter_mut() {
                *b = lcg(&mut seed);
            }
            if bm.arb_id == 261 && dlc > 0 {
                let dom = [0u8, 1, 2, 3, 10, 11, 12, 5][f % 8];
                p[0] = (p[0] & 0xF0) | dom;
            }
            let want = decode_map(&bc, &bs, key, &p);
            let got = decode_map(&mc, &ms, key, &p);
            for (name, v) in &want {
                assert_eq!(
                    got.get(name),
                    Some(v),
                    "base signal {name} in 0x{:X} differs on frame {p:02X?}",
                    bm.arb_id
                );
            }
            frames_checked += 1;
        }
    }
    assert!(
        frames_checked >= 4 * 48,
        "golden frames covered all base messages ({frames_checked})"
    );

    // the draft inside 513 decodes like the span reference
    let mut p = [0u8; 64];
    pack(&into513, 0xBEEF, &mut p);
    let got = decode_named(&mc, &ms, 513, false, &p, "ReFdFree300");
    assert_bits_eq(
        got.physical_value,
        span_physical(&into513, &p),
        "draft in base FD message",
    );
}

#[test]
fn merge_with_base_kcd_input() {
    let kcd = br#"<?xml version="1.0" encoding="UTF-8"?>
<NetworkDefinition xmlns="http://kayak.2codeornot2code.org/1.0">
  <Document name="ReBaseKcd" version="1.0"/>
  <Node id="1" name="ECU"/>
  <Bus name="Main">
    <Message id="0x120" name="KcdStatus" length="8">
      <Producer><NodeRef id="1"/></Producer>
      <Signal name="KcdSpeed" offset="0" length="16">
        <Value type="unsigned" slope="0.01" intercept="0" min="0" max="655.35" unit="km/h"/>
      </Signal>
    </Message>
  </Bus>
</NetworkDefinition>"#;
    let base = base_db(kcd, "base.kcd");
    let (bc, bs) = parse_and_compile(kcd, Some("base.kcd"), &ParseOptions::default()).unwrap();
    let d = simple("k", 0x120, "ReKcdAdd", 16, 8);
    let (_res, mc, ms) = gen_ok(&[d], Some(&base), "kcd base");
    let p = [0x10u8, 0x27, 0x07, 0, 0, 0, 0, 0];
    let key = CanIdKey::Standard(0x120);
    assert_eq!(
        decode_map(&bc, &bs, key, &p)["KcdSpeed"],
        decode_map(&mc, &ms, key, &p)["KcdSpeed"]
    );
    assert_eq!(
        decode_named(&mc, &ms, 0x120, false, &p, "ReKcdAdd").physical_value,
        7.0
    );
    assert_eq!(
        ms.messages.iter().find(|m| m.arb_id == 0x120).unwrap().name,
        "KcdStatus"
    );
}

// ─── 6. Text fidelity: escaping, VAL_, provenance ───────────────────────────────────────

#[test]
fn escaping_quote_and_backslash_in_unit_comment_and_val_labels() {
    let mut d = simple("esc", 0x500, "Esc", 0, 8);
    d.unit = r#"deg"C\x"#.into();
    d.comment = "say \"hi\" \\ C:\\tmp\nsecond line".into();
    d.value_table = vec![
        ReValueTableEntry {
            value: 0,
            label: r#"on "1""#.into(),
        },
        ReValueTableEntry {
            value: 1,
            label: r"back\slash".into(),
        },
        ReValueTableEntry {
            value: 2,
            label: r#"\"both\""#.into(),
        },
    ];
    let (_res, _c, s) = gen_ok(std::slice::from_ref(&d), None, "escaping");
    let sig = s.signals.iter().find(|x| x.name == "Esc").unwrap();
    assert_eq!(sig.unit, d.unit, "unit round-trip");
    let cm = sig.comment.clone().unwrap_or_default();
    assert!(cm.starts_with(&d.comment), "comment round-trip: got {cm:?}");
    for e in &d.value_table {
        assert_eq!(
            sig.enum_table.get(&e.value),
            Some(&e.label),
            "VAL_ label {} round-trip",
            e.value
        );
    }
}

#[test]
fn val_table_roundtrip_including_negative_values_on_signed() {
    let mut d = draft(
        "vt",
        0x510,
        false,
        8,
        "Gear",
        0,
        4,
        ReByteOrder::Intel,
        ReSignalValueType::Signed,
        1.0,
        0.0,
    );
    d.value_table = vec![
        ReValueTableEntry {
            value: -1,
            label: "Reverse".into(),
        },
        ReValueTableEntry {
            value: 0,
            label: "Neutral".into(),
        },
        ReValueTableEntry {
            value: 1,
            label: "Drive".into(),
        },
        ReValueTableEntry {
            value: 7,
            label: "SNA".into(),
        },
    ];
    let (res, _c, s) = gen_ok(std::slice::from_ref(&d), None, "VAL_");
    assert!(
        res.dbc_text
            .lines()
            .any(|l| l.starts_with("VAL_ 1296 Gear")),
        "VAL_ line:\n{}",
        res.dbc_text
    );
    let sig = s.signals.iter().find(|x| x.name == "Gear").unwrap();
    assert_eq!(sig.enum_table.len(), 4);
    for e in &d.value_table {
        assert_eq!(sig.enum_table.get(&e.value), Some(&e.label));
    }
    // empty valueTable -> no VAL_ line for that signal
    let plain = simple("p", 0x511, "Plain", 0, 8);
    let (r2, _, _) = gen_ok(&[plain], None, "no VAL_");
    assert!(
        !r2.dbc_text.lines().any(|l| l.starts_with("VAL_ 1297")),
        "{}",
        r2.dbc_text
    );
}

fn comment_of(s: &DatabaseSchemaDto, name: &str) -> String {
    s.signals
        .iter()
        .find(|x| x.name == name)
        .unwrap()
        .comment
        .clone()
        .unwrap_or_default()
}

#[test]
fn provenance_cm_line_format() {
    let mut d = simple("p", 0x520, "VehSpeed", 0, 16);
    d.comment = "Vehicle speed".into();
    d.provenance = ReProvenance {
        r: Some(0.998_2),
        lag_ms: Some(120.0),
        reference: Some("OBD 0x0D".into()),
        samples: Some(812),
        created_at_ms: 1_763_500_000_000.0,
    };
    let (res, _c, s) = gen_ok(std::slice::from_ref(&d), None, "prov full");
    assert_eq!(
        comment_of(&s, "VehSpeed"),
        "Vehicle speed\nRE: r=0.998 lag=+120ms ref=OBD 0x0D n=812"
    );
    assert!(
        res.dbc_text.contains("CM_ SG_ 1312 VehSpeed"),
        "{}",
        res.dbc_text
    );

    // empty user comment, negative r and lag
    let mut e = simple("q", 0x521, "Neg", 0, 8);
    e.provenance = ReProvenance {
        r: Some(-0.951_49),
        lag_ms: Some(-30.0),
        reference: Some("markers".into()),
        samples: Some(40),
        created_at_ms: 0.0,
    };
    let (_r, _c, s2) = gen_ok(&[e], None, "prov negative");
    assert_eq!(
        comment_of(&s2, "Neg"),
        "RE: r=-0.951 lag=-30ms ref=markers n=40"
    );

    // zero lag + null tokens omitted (D4)
    let mut z = simple("z", 0x522, "Zero", 0, 8);
    z.provenance = ReProvenance {
        r: Some(0.5),
        lag_ms: Some(0.0),
        reference: None,
        samples: None,
        created_at_ms: 0.0,
    };
    let (_r, _c, s3) = gen_ok(&[z], None, "prov zero lag");
    assert_eq!(comment_of(&s3, "Zero"), "RE: r=0.500 lag=+0ms");

    // all null -> "RE: manual"
    let mut n = simple("n", 0x523, "Manual", 0, 8);
    n.comment = "hand made".into();
    let (_r, _c, s4) = gen_ok(&[n], None, "prov manual");
    assert_eq!(comment_of(&s4, "Manual"), "hand made\nRE: manual");
}
