//! QA regression probe for the R2b `DbcWriter` changes (re-toolkit-v1 §7.2 / §7.5a-9):
//! cascaded / extended-mux `SG_MUL_VAL_` emission and lossless `num()` formatting.
//!
//! 1. Every repo DBC/KCD fixture: parse → `DbcWriter` → re-parse → compile; every message / signal
//!    survives and decodes bit-identically (raw bits + f64 bit pattern) on golden payloads, with every
//!    mux selector value 0..=255 driven on byte 0 (and nibble combos) for multiplexed messages.
//! 2. A simple single-master mux DBC (`M` + single-value `mN`) writes NO `SG_MUL_VAL_` (unchanged output).
//! 3. Writing is idempotent: write(parse(write(db))) == write(db).
//!
//! Run: `cargo test -p nexus-netdb --test re_r2b_writer_regression -- --nocapture`

use nexus_netdb::{
    CompiledDatabase, DbcWriter, DecodedSignalSample, FormatRegistry, NetworkDatabase, ParseOptions,
};
use std::collections::BTreeMap;
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

const FIXTURES: &[&str] = &[
    "scripts/sample_vehicle.dbc",
    "scripts/sample_bms.kcd",
    "test/databases/ev_powertrain_full_test.dbc",
    "test/databases/cascaded_mux_stress.dbc",
    "test/databases/industrial_charger_station.kcd",
    ".claude/skills/cansub-reverse-engineering/assets/obd2-dbc/OBD-v4.4.dbc",
    ".claude/skills/cansub-reverse-engineering/assets/gps-dbc/canmod-gnss.dbc",
    ".claude/skills/cansub-reverse-engineering/assets/gps-dbc/canedge-internal-can9.dbc",
];

fn parse(bytes: &[u8], hint: &str) -> NetworkDatabase {
    FormatRegistry::new()
        .parse_bytes(bytes, Some(hint), &ParseOptions::default())
        .unwrap_or_else(|e| panic!("{hint}: parse failed: {e}"))
        .database
}

fn write(db: &NetworkDatabase) -> String {
    DbcWriter::new(db).write_to_string().expect("writer")
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

type Decoded = BTreeMap<String, (u64, u64, bool)>;

fn decode_named(db: &CompiledDatabase, id: nexus_core::CanIdKey, payload: &[u8]) -> Decoded {
    let mut out = vec![blank(); 1024];
    let mut sw = [(0u32, 0i64); 32];
    let s = db
        .decode_payload_into(id, payload, &mut out, &mut sw)
        .expect("message present");
    out[..s.decoded_count]
        .iter()
        .map(|d| {
            let name = db.get_signal(d.signal_id).expect("sig").name.clone();
            (
                name,
                (d.raw_bits, d.physical_value.to_bits(), d.is_mux_switch),
            )
        })
        .collect()
}

struct Lcg(u32);
impl Lcg {
    fn fill(&mut self, d: &mut [u8]) {
        for b in d {
            self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *b = (self.0 >> 24) as u8;
        }
    }
}

fn payloads(dlc: usize, muxed: bool) -> Vec<Vec<u8>> {
    let mut v = vec![
        vec![0u8; dlc],
        vec![0xFF; dlc],
        vec![0xA5; dlc],
        (0..dlc).map(|i| i as u8).collect(),
    ];
    let mut rng = Lcg(99);
    for _ in 0..6 {
        let mut p = vec![0u8; dlc];
        rng.fill(&mut p);
        v.push(p);
    }
    if muxed {
        // Drive selectors in byte 0..=2 (covers 0|4 + 4|4 cascades, 8-bit selectors, OBD service/PID).
        for b in 0..=255u8 {
            for lane in 0..dlc.min(3) {
                let mut p = v[5].clone();
                p[lane] = b;
                v.push(p);
            }
        }
    }
    v
}

#[test]
fn writer_roundtrip_all_repo_fixtures_decode_bit_identical() {
    let mut total_frames = 0usize;
    for rel in FIXTURES {
        let path = repo().join(rel);
        let Ok(bytes) = std::fs::read(&path) else {
            eprintln!("skip (missing): {rel}");
            continue;
        };
        let db0 = parse(&bytes, rel);
        let text = write(&db0);
        let db1 = parse(text.as_bytes(), "roundtrip.dbc");
        // Idempotence: a second write of the re-parsed DB is byte-identical.
        let text2 = write(&db1);
        assert_eq!(text, text2, "{rel}: writer output not idempotent");

        let c0 =
            CompiledDatabase::compile(db0).unwrap_or_else(|e| panic!("{rel}: compile orig: {e}"));
        let c1 = CompiledDatabase::compile(db1)
            .unwrap_or_else(|e| panic!("{rel}: compile roundtrip: {e}\n{text}"));
        assert_eq!(c0.messages.len(), c1.messages.len(), "{rel}: message count");
        assert_eq!(c0.signals.len(), c1.signals.len(), "{rel}: signal count");
        let mut frames = 0usize;
        for m0 in &c0.messages {
            let m1 = c1
                .get_message(&m0.can_id)
                .unwrap_or_else(|| panic!("{rel}: {} lost", m0.name));
            assert_eq!(m1.name, m0.name, "{rel}: renamed");
            assert_eq!(m1.dlc, m0.dlc, "{rel}: {} DLC", m0.name);
            assert_eq!(
                m1.mux_tree.is_some(),
                m0.mux_tree.is_some(),
                "{rel}: {} mux tree presence",
                m0.name
            );
            for s0 in &m0.all_signals {
                let s1 = m1
                    .all_signals
                    .iter()
                    .find(|s| s.name == s0.name)
                    .unwrap_or_else(|| panic!("{rel}: {}.{} lost", m0.name, s0.name));
                assert_eq!(
                    (
                        s1.start_bit,
                        s1.bit_len,
                        s1.byte_order,
                        s1.value_type,
                        s1.factor.to_bits(),
                        s1.offset.to_bits(),
                        s1.min.to_bits(),
                        s1.max.to_bits(),
                        &s1.mux_role
                    ),
                    (
                        s0.start_bit,
                        s0.bit_len,
                        s0.byte_order,
                        s0.value_type,
                        s0.factor.to_bits(),
                        s0.offset.to_bits(),
                        s0.min.to_bits(),
                        s0.max.to_bits(),
                        &s0.mux_role
                    ),
                    "{rel}: {}.{} definition changed on round-trip",
                    m0.name,
                    s0.name
                );
            }
            let dlc = usize::from(m0.dlc).clamp(1, 64);
            for p in payloads(dlc, m0.mux_tree.is_some()) {
                let a = decode_named(&c0, m0.can_id, &p);
                let b = decode_named(&c1, m0.can_id, &p);
                assert_eq!(
                    a, b,
                    "{rel}: {} decodes differently after write/re-parse on {p:02X?}",
                    m0.name
                );
                frames += 1;
            }
        }
        eprintln!(
            "{rel}: {} msgs / {} sigs, {frames} golden frames bit-identical",
            c0.messages.len(),
            c0.signals.len()
        );
        total_frames += frames;
    }
    assert!(
        total_frames > 1_000,
        "too few frames checked: {total_frames}"
    );
}

const SIMPLE_MUX: &str = r#"VERSION ""

NS_ :

BS_:

BU_: ECU

BO_ 1280 SimpleMux: 8 ECU
 SG_ Sel M : 0|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ PlainA : 8|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ Page0 m0 : 16|16@1+ (0.1,0) [0|6553.5] "V" Vector__XXX
 SG_ Page1 m1 : 16|16@1- (0.01,-5) [-100|100] "A" Vector__XXX
 SG_ Page7 m7 : 32|8@0+ (1,0) [0|255] "" Vector__XXX

"#;

#[test]
fn simple_single_master_mux_writes_no_sg_mul_val() {
    let db = parse(SIMPLE_MUX.as_bytes(), "simple.dbc");
    let text = write(&db);
    // (`NS_` legitimately lists the keyword; only statements count.)
    assert!(
        !text
            .lines()
            .any(|l| l.trim_start().starts_with("SG_MUL_VAL_ ")),
        "simple mux must not emit SG_MUL_VAL_ statements:\n{text}"
    );
    for needle in [
        " Sel M :",
        " Page0 m0 :",
        " Page1 m1 :",
        " Page7 m7 :",
        "(0.01,-5)",
        "[-100|100]",
        "(0.1,0) [0|6553.5]",
    ] {
        assert!(text.contains(needle), "missing `{needle}`:\n{text}");
    }
    // Re-parsed tree selects the same pages.
    let c = CompiledDatabase::compile(parse(text.as_bytes(), "rt.dbc")).expect("compile");
    let id = c.messages[0].can_id;
    for (sel, want) in [(0u8, "Page0"), (1, "Page1"), (7, "Page7")] {
        let d = decode_named(&c, id, &[sel, 0, 0x10, 0x27, 0, 0, 0, 0]);
        assert!(d.contains_key(want), "sel {sel}: {want} not decoded: {d:?}");
        let others = ["Page0", "Page1", "Page7"]
            .into_iter()
            .filter(|n| *n != want && d.contains_key(*n))
            .count();
        assert_eq!(others, 0, "sel {sel}: foreign page decoded: {d:?}");
    }
}

#[test]
fn cascaded_sample_vehicle_emits_explicit_sg_mul_val_for_every_muxed_signal() {
    let bytes = std::fs::read(repo().join("scripts/sample_vehicle.dbc")).expect("fixture");
    let text = write(&parse(&bytes, "sample_vehicle.dbc"));
    let lines: Vec<&str> = text
        .lines()
        .filter(|l| l.starts_with("SG_MUL_VAL_ 261 "))
        .collect();
    // 0x105 has 13 multiplexed signals (incl. the sub-switch); each needs an explicit line.
    for sig in [
        "SubBankSwitch MuxDomainSwitch 0-1",
        "CellBank0MinMv SubBankSwitch 0-0",
        "CellBank1TempDegC SubBankSwitch 1-1",
        "ContactorState MuxDomainSwitch 2-2",
        "HvInterlockClosed MuxDomainSwitch 2-3, 10-12",
    ] {
        assert!(
            lines.iter().any(|l| l.contains(sig)),
            "missing SG_MUL_VAL_ `{sig}`; got {lines:#?}"
        );
    }
    assert_eq!(
        lines.len(),
        12,
        "every muxed 0x105 signal gets exactly one SG_MUL_VAL_: {lines:#?}"
    );
}
