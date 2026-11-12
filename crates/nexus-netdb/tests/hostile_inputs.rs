//! Deterministic "hostile input" regression tests (WP-6 / HIGH-05, HIGH-06, LOW-02).
//!
//! Every test here feeds an untrusted / adversarial database file or TX request into the public API and
//! asserts a bounded, non-panicking outcome (an `Err`, a diagnostic, or a clamped value). None of these may
//! hang, abort on stack overflow, or panic on arithmetic overflow — they run in the normal `cargo test`.

use nexus_core::CanIdKey;
use nexus_netdb::ir::mux::MuxRole;
use nexus_netdb::{
    parse_and_compile, ByteOrder, CompiledDatabase, DatabaseFormatParser, DbError, DbcFormat,
    DbcParser, DbcWriter, DecodedSignalSample, EncodeError, KcdFormat, MessageDef, NetworkDatabase,
    ParseOptions, SignalDef, SignalValueType, MAX_MUX_DEPTH,
};
use std::time::{Duration, Instant};

fn empty_sample() -> DecodedSignalSample {
    DecodedSignalSample {
        signal_id: 0,
        raw_bits: 0,
        raw_int: 0,
        physical_value: 0.0,
        out_of_range: false,
        is_mux_switch: false,
    }
}

fn parse_dbc(text: &str) -> NetworkDatabase {
    DbcFormat
        .parse(text.as_bytes(), &ParseOptions::default())
        .expect("fault-tolerant DBC parse never fails")
        .database
}

/// Runs `f` and fails the test if it took longer than `limit` (guards against "freeze" regressions).
fn within<T>(limit: Duration, what: &str, f: impl FnOnce() -> T) -> T {
    let t0 = Instant::now();
    let out = f();
    let el = t0.elapsed();
    assert!(el < limit, "{what} took {el:?} (limit {limit:?})");
    out
}

// ---------------------------------------------------------------------------------------------
// HIGH-05: KCD LabelGroup range arithmetic must not overflow / iterate 2^64 values.
// ---------------------------------------------------------------------------------------------

#[test]
fn high05_kcd_label_group_extreme_i64_range_does_not_overflow_or_hang() {
    let kcd = r#"<?xml version="1.0" encoding="UTF-8"?>
<NetworkDefinition xmlns="http://kayak.2codeornot2code.org/1.0">
  <Document name="Hostile" version="1"/>
  <Bus name="B">
    <Message id="0x100" name="M" length="8">
      <Signal name="S" offset="0" length="8">
        <LabelSet>
          <LabelGroup from="-9223372036854775808" to="10" name="Evil"/>
          <LabelGroup from="9223372036854775807" to="-9223372036854775808" name="Evil2"/>
          <LabelGroup from="0" to="3" name="Ok"/>
        </LabelSet>
      </Signal>
    </Message>
  </Bus>
</NetworkDefinition>"#;
    let (compiled, _schema) = within(Duration::from_secs(5), "KCD extreme LabelGroup", || {
        parse_and_compile(kcd.as_bytes(), Some("evil.kcd"), &ParseOptions::default())
            .expect("parse must succeed (oversized groups are skipped)")
    });
    let sig = &compiled.signals[0];
    // The two oversized groups are skipped; the sane 0..=3 group is still expanded.
    assert_eq!(sig.enum_values.len(), 4);
    assert_eq!(sig.enum_values.get(&0).map(String::as_str), Some("Ok"));
    assert!(!sig.enum_values.contains_key(&i64::MIN));
}

// ---------------------------------------------------------------------------------------------
// HIGH-06: cascaded multiplexer depth must be bounded (parse / compile / runtime / encode).
// ---------------------------------------------------------------------------------------------

/// DBC with one master switch and `n` chained cascaded switches `S1 <- S2 <- ... <- Sn` via SG_MUL_VAL_.
fn chained_mux_dbc(n: usize) -> String {
    let mut s = String::from(
        "VERSION \"\"\nBU_: ECU\nBO_ 256 Deep: 64 ECU\n SG_ S0 M : 0|8@1+ (1,0) [0|0] \"\" ECU\n",
    );
    for i in 1..=n {
        s.push_str(&format!(" SG_ S{i} m1M : 8|8@1+ (1,0) [0|0] \"\" ECU\n"));
    }
    for i in 1..=n {
        s.push_str(&format!("SG_MUL_VAL_ 256 S{i} S{} 1-1;\n", i - 1));
    }
    s
}

#[test]
fn high06_dbc_ten_thousand_chained_sg_mul_val_is_a_compile_error_not_a_stack_overflow() {
    let text = chained_mux_dbc(10_000);
    let res = within(Duration::from_secs(60), "10k chained SG_MUL_VAL_", || {
        parse_and_compile(text.as_bytes(), Some("deep.dbc"), &ParseOptions::default())
    });
    match res {
        Err(DbError::MuxTooDeep { max, .. }) => assert_eq!(max, MAX_MUX_DEPTH),
        Err(other) => panic!("expected MuxTooDeep, got {other}"),
        Ok(_) => panic!("10k-deep cascaded multiplexer must be rejected"),
    }
}

#[test]
fn high06_dbc_mux_depth_exactly_at_limit_still_compiles_and_round_trips() {
    // Master (depth 1) + (MAX_MUX_DEPTH - 1) cascaded sub-switches = MAX_MUX_DEPTH tree levels.
    let n = MAX_MUX_DEPTH - 1;
    let mut s = String::from(
        "VERSION \"\"\nBU_: ECU\nBO_ 256 Deep: 64 ECU\n SG_ S0 M : 0|8@1+ (1,0) [0|0] \"\" ECU\n",
    );
    for i in 1..=n {
        s.push_str(&format!(
            " SG_ S{i} m1M : {}|8@1+ (1,0) [0|0] \"\" ECU\n",
            i * 8
        ));
    }
    s.push_str(&format!(
        " SG_ Leaf m7 : {}|8@1+ (1,0) [0|0] \"\" ECU\n",
        (n + 1) * 8
    ));
    for i in 1..=n {
        s.push_str(&format!("SG_MUL_VAL_ 256 S{i} S{} 1-1;\n", i - 1));
    }
    s.push_str(&format!("SG_MUL_VAL_ 256 Leaf S{n} 7-7;\n"));

    let (db, schema) = parse_and_compile(s.as_bytes(), Some("limit.dbc"), &ParseOptions::default())
        .expect("depth == MAX_MUX_DEPTH must compile");
    let leaf = schema
        .signals
        .iter()
        .find(|x| x.name == "Leaf")
        .unwrap()
        .signal_id;
    let frame = db
        .encode_raw_frame(0, CanIdKey::Standard(0x100), &[(leaf, 42.0)], 0)
        .expect("encode at depth limit");
    let mut out = [empty_sample(); 64];
    let mut sw = [(0u32, 0i64); 64];
    let sum = db.decode_frame_into(&frame, &mut out, &mut sw).unwrap();
    assert_eq!(sum.active_switch_count, MAX_MUX_DEPTH);
    let v = out[..sum.decoded_count]
        .iter()
        .find(|x| x.signal_id == leaf)
        .unwrap();
    assert_eq!(v.physical_value, 42.0);
}

#[test]
fn high06_dbc_mux_depth_one_over_limit_is_rejected() {
    let text = chained_mux_dbc(MAX_MUX_DEPTH); // master + 16 sub-switches = 17 levels
    assert!(matches!(
        parse_and_compile(text.as_bytes(), Some("d.dbc"), &ParseOptions::default()),
        Err(DbError::MuxTooDeep { .. })
    ));
}

#[test]
fn high06_kcd_deeply_nested_multiplex_is_a_parse_error_not_a_crash() {
    let depth = 20_000;
    let mut s = String::from(
        "<?xml version=\"1.0\"?>\n<NetworkDefinition xmlns=\"http://kayak.2codeornot2code.org/1.0\">\n<Bus name=\"B\">\n<Message id=\"0x100\" name=\"M\" length=\"64\">\n",
    );
    for i in 0..depth {
        s.push_str(&format!(
            "<Multiplex name=\"X{i}\" offset=\"0\" length=\"8\"><MuxGroup count=\"1\">"
        ));
    }
    s.push_str("<Signal name=\"Leaf\" offset=\"8\" length=\"8\"/>");
    for _ in 0..depth {
        s.push_str("</MuxGroup></Multiplex>");
    }
    s.push_str("\n</Message>\n</Bus>\n</NetworkDefinition>\n");

    for fault_tolerant in [true, false] {
        let opts = ParseOptions {
            fault_tolerant,
            ..ParseOptions::default()
        };
        let res = within(Duration::from_secs(30), "deep KCD", || {
            KcdFormat.parse(s.as_bytes(), &opts)
        });
        let err = match res {
            Err(e) => e.to_string(),
            Ok(_) => panic!("deep KCD nesting must be rejected (fault_tolerant={fault_tolerant})"),
        };
        assert!(err.contains("nesting depth"), "unexpected error: {err}");
    }
}

#[test]
fn high06_runtime_and_encoder_never_recurse_past_limit_on_hand_built_cycle() {
    // A multiplexer cycle with no master switch is never compiled into a tree, but the encoder's
    // ancestor walk must still terminate with an error instead of silently truncating.
    let mut db = NetworkDatabase::new("cyc");
    let mk = |name: &str, sw: &str, start: u16| SignalDef {
        id: 0,
        name: name.into(),
        long_name: None,
        start_bit: start,
        bit_len: 8,
        byte_order: ByteOrder::LittleEndian,
        value_type: SignalValueType::Unsigned,
        factor: 1.0,
        offset: 0.0,
        min: 0.0,
        max: 0.0,
        unit: String::new(),
        receivers: vec![],
        mux_role: MuxRole::Multiplexed {
            switch_signal_name: sw.into(),
            switch_signal: 0,
            ranges: smallvec::smallvec![nexus_netdb::MuxRange::single(1)],
            is_sub_switch: true,
        },
        comment: None,
        enum_values: Default::default(),
        initial_value: None,
        attributes: Default::default(),
    };
    let msg = MessageDef {
        can_id: CanIdKey::Standard(0x10),
        name: "Cyc".into(),
        dlc: 8,
        transmitters: vec![],
        signals: vec![mk("A", "B", 0), mk("B", "A", 8)],
        comment: None,
        protocol: nexus_netdb::FrameProtocol::ClassicalCan,
        expected_cycle_ms: None,
        attributes: Default::default(),
        signal_groups: vec![],
    };
    db.messages.insert(msg.can_id, msg);
    let compiled = CompiledDatabase::compile(db).expect("cycle without master compiles (no tree)");
    let mut p = [0u8; 64];
    let r = compiled.encode_payload_into(CanIdKey::Standard(0x10), &[(0, 1.0)], &mut p);
    assert!(
        matches!(r, Err(EncodeError::MuxTooDeep { .. })),
        "cyclic ancestor walk must error, got {r:?}"
    );
}

// ---------------------------------------------------------------------------------------------
// LOW-02: DBC i64::MIN, writer escaping, NaN/Inf TX, factor == 0, inverted [min|max].
// ---------------------------------------------------------------------------------------------

#[test]
fn low02_dbc_i64_min_and_u64_max_numbers_do_not_overflow() {
    let text = "VERSION \"\"\nBU_: ECU\nBO_ 256 M: 8 ECU\n SG_ Sw M : 0|8@1+ (1,0) [0|0] \"\" ECU\n SG_ A m1 : 8|8@1+ (1,0) [0|0] \"\" ECU\n\
VAL_ 256 Sw -9223372036854775808 \"min\" 18446744073709551615 \"huge\" 9223372036854775807 \"max\" ;\n\
SG_MUL_VAL_ 256 A Sw -9223372036854775808-9223372036854775807;\n\
BA_DEF_ BO_ \"GenMsgCycleTime\" INT -9223372036854775808 9223372036854775807;\n\
BA_ \"GenMsgCycleTime\" BO_ 256 -9223372036854775808;\n";
    let db = parse_dbc(text);
    let msg = db.messages.values().next().unwrap();
    let sw = msg.signals.iter().find(|s| s.name == "Sw").unwrap();
    assert_eq!(
        sw.enum_values.get(&i64::MIN).map(String::as_str),
        Some("min")
    );
    assert_eq!(
        sw.enum_values.get(&i64::MAX).map(String::as_str),
        Some("max")
    );
    // u64::MAX does not fit i64: it must not wrap to -1.
    assert!(!sw.enum_values.contains_key(&-1));
    let a = msg.signals.iter().find(|s| s.name == "A").unwrap();
    if let MuxRole::Multiplexed { ranges, .. } = &a.mux_role {
        assert_eq!(ranges[0].start, i64::MIN);
        assert_eq!(ranges[0].end, i64::MAX);
    } else {
        panic!("A must be multiplexed");
    }
    assert_eq!(msg.expected_cycle_ms, None);
    CompiledDatabase::compile(db).expect("compiles");
}

#[test]
fn low02_writer_escapes_quotes_backslashes_and_newlines_and_round_trips() {
    let evil = "a\"b\\c\nBO_ 999 Injected: 8 X\r\n\"";
    let mut db = parse_dbc(
        "VERSION \"\"\nBU_: ECU\nBO_ 256 M: 8 ECU\n SG_ S : 0|8@1+ (1,0) [0|0] \"u\" ECU\n",
    );
    db.version = Some(evil.to_string());
    db.comment = Some(evil.to_string());
    {
        let msg = db.messages.values_mut().next().unwrap();
        msg.comment = Some(evil.to_string());
        let s = &mut msg.signals[0];
        s.unit = evil.to_string();
        s.comment = Some(evil.to_string());
        s.enum_values.insert(1, evil.to_string());
    }
    let text = DbcWriter::new(&db).write_to_string().unwrap();
    assert!(
        !text.contains("Injected: 8 X\n"),
        "newline in string must be escaped"
    );
    let (back, _) = DbcParser::new(&text, true).parse();
    assert_eq!(
        back.messages.len(),
        1,
        "no message may be injected through a string"
    );
    assert_eq!(back.version.as_deref(), Some(evil));
    assert_eq!(back.comment.as_deref(), Some(evil));
    let msg = back.messages.values().next().unwrap();
    assert_eq!(msg.comment.as_deref(), Some(evil));
    assert_eq!(msg.signals[0].unit, evil);
    assert_eq!(msg.signals[0].comment.as_deref(), Some(evil));
    assert_eq!(
        msg.signals[0].enum_values.get(&1).map(String::as_str),
        Some(evil)
    );
}

#[test]
fn low02_writer_sanitizes_identifiers_that_would_break_dbc_syntax() {
    // KCD allows arbitrary names; written to DBC they must not inject statements.
    let kcd = r#"<NetworkDefinition xmlns="http://kayak.2codeornot2code.org/1.0">
<Node id="1" name="Bad Node;"/>
<Bus name="B"><Message id="0x100" name="Msg ; BO_ 1 X: 8 Y" length="8">
<Producer><NodeRef id="1"/></Producer>
<Signal name="Sig &quot;q&quot; name" offset="0" length="8"/></Message></Bus></NetworkDefinition>"#;
    let db = KcdFormat
        .parse(kcd.as_bytes(), &ParseOptions::default())
        .unwrap()
        .database;
    let text = DbcWriter::new(&db).write_to_string().unwrap();
    let (back, _) = DbcParser::new(&text, true).parse();
    assert_eq!(back.messages.len(), 1);
    let m = back.messages.values().next().unwrap();
    assert_eq!(m.signals.len(), 1);
    assert!(m
        .name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_'));
    assert!(m.signals[0]
        .name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_'));
}

fn simple_db(min: f64, max: f64, factor: f64, vt: &str) -> CompiledDatabase {
    let text = format!(
        "VERSION \"\"\nBU_: ECU\nBO_ 256 M: 8 ECU\n SG_ S : 0|16@1{vt} ({factor},0) [{min}|{max}] \"\" ECU\n"
    );
    CompiledDatabase::compile(parse_dbc(&text)).unwrap()
}

#[test]
fn low02_encoder_rejects_nan_and_infinite_physical_values() {
    let db = simple_db(0.0, 100.0, 1.0, "+");
    let mut p = [0u8; 64];
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let r = db.encode_payload_into(CanIdKey::Standard(0x100), &[(0, bad)], &mut p);
        assert!(
            matches!(r, Err(EncodeError::NonFiniteValue { .. })),
            "{bad}: {r:?}"
        );
    }
    // Float signal too (no bounds): NaN must be refused rather than packed as a NaN bit pattern.
    let fdb = CompiledDatabase::compile(parse_dbc(
        "VERSION \"\"\nBU_: E\nBO_ 256 M: 8 E\n SG_ F : 0|32@1- (1,0) [0|0] \"\" E\nSIG_VALTYPE_ 256 F : 1;\n",
    ))
    .unwrap();
    let r = fdb.encode_payload_into(CanIdKey::Standard(0x100), &[(0, f64::NAN)], &mut p);
    assert!(matches!(r, Err(EncodeError::NonFiniteValue { .. })));
}

#[test]
fn low02_encoder_factor_zero_is_an_error_not_a_garbage_frame() {
    let db = simple_db(0.0, 0.0, 0.0, "+");
    let mut p = [0u8; 64];
    let r = db.encode_payload_into(CanIdKey::Standard(0x100), &[(0, 5.0)], &mut p);
    assert!(
        matches!(r, Err(EncodeError::InvalidScaling { .. })),
        "{r:?}"
    );
    // Decode stays defined (phys == offset).
    let mut out = [empty_sample(); 4];
    let mut sw = [(0u32, 0i64); 1];
    let s = db
        .decode_payload_into(CanIdKey::Standard(0x100), &[0xFF; 8], &mut out, &mut sw)
        .unwrap();
    assert_eq!(s.decoded_count, 1);
    assert_eq!(out[0].physical_value, 0.0);
}

#[test]
fn low02_inverted_min_max_is_normalized_so_clamping_stays_active() {
    // Decision: an inverted range [max|min] is normalized (swapped) at compile time and the DBC parser
    // emits an INVERTED_BOUNDS warning. Clamping must never be silently disabled.
    let db = simple_db(100.0, 10.0, 1.0, "+");
    let s = &db.signals[0];
    assert!(s.has_bounds);
    assert_eq!((s.min, s.max), (10.0, 100.0));
    let mut p = [0u8; 64];
    db.encode_payload_into(CanIdKey::Standard(0x100), &[(0, 60_000.0)], &mut p)
        .unwrap();
    assert_eq!(u16::from_le_bytes([p[0], p[1]]), 100);
    db.encode_payload_into(CanIdKey::Standard(0x100), &[(0, -5.0)], &mut p)
        .unwrap();
    assert_eq!(u16::from_le_bytes([p[0], p[1]]), 10);

    let bundle = DbcFormat
        .parse(
            b"VERSION \"\"\nBU_: E\nBO_ 256 M: 8 E\n SG_ S : 0|16@1+ (1,0) [100|10] \"\" E\n",
            &ParseOptions::default(),
        )
        .unwrap();
    assert!(bundle
        .diagnostics
        .iter()
        .any(|d| d.code == "INVERTED_BOUNDS"));
}

#[test]
fn low02_nan_bounds_from_file_never_panic_in_clamp() {
    // "NaN"/"inf" parse as f64 words; f64::clamp would panic on NaN bounds.
    let db = CompiledDatabase::compile(parse_dbc(
        "VERSION \"\"\nBU_: E\nBO_ 256 M: 8 E\n SG_ A : 0|16@1+ (1,0) [NaN|100] \"\" E\n SG_ B : 16|16@1+ (1,0) [0|NaN] \"\" E\n SG_ C : 32|16@1+ (1,0) [-inf|inf] \"\" E\n",
    ))
    .unwrap();
    let mut p = [0u8; 64];
    db.encode_payload_into(
        CanIdKey::Standard(0x100),
        &[(0, 500.0), (1, 7.0), (2, 9.0)],
        &mut p,
    )
    .unwrap();
    assert_eq!(u16::from_le_bytes([p[0], p[1]]), 100);
    assert_eq!(u16::from_le_bytes([p[2], p[3]]), 7);
    assert_eq!(u16::from_le_bytes([p[4], p[5]]), 9);
}

// ---------------------------------------------------------------------------------------------
// Generic hostile inputs: truncation, huge numbers, giant DLC / start bits.
// ---------------------------------------------------------------------------------------------

const GOOD_DBC: &str = r#"VERSION "1.0"
NS_ :
BS_:
BU_: ECU VCU
VAL_TABLE_ Gear 0 "P" 1 "R" 2 "N" 3 "D" ;
BO_ 256 Engine: 8 ECU
 SG_ Rpm : 7|16@0+ (0.25,0) [0|16000] "rpm" VCU
 SG_ Temp : 16|8@1- (1,-40) [-40|215] "degC" VCU
 SG_ Mux M : 24|4@1+ (1,0) [0|15] "" VCU
 SG_ CellA m0 : 32|16@1+ (0.001,0) [0|5] "V" VCU
 SG_ CellB m1M : 32|8@1+ (1,0) [0|255] "" VCU
 SG_ Deep m3 : 40|16@1+ (1,0) [0|0] "" VCU
BO_ 2566844926 Fd: 64 ECU
 SG_ F32 : 480|32@1- (1,0) [0|0] "" VCU
CM_ BO_ 256 "Engine \"status\"";
BA_DEF_ BO_ "GenMsgCycleTime" INT 0 10000;
BA_ "GenMsgCycleTime" BO_ 256 100;
VAL_ 256 Mux 0 "Bank0" 1 "Bank1" ;
SIG_VALTYPE_ 2566844926 F32 : 1;
SG_MUL_VAL_ 256 Deep CellB 3-3, 10-15;
"#;

#[test]
fn hostile_truncated_dbc_at_every_byte_never_panics() {
    let bytes = GOOD_DBC.as_bytes();
    for cut in 0..=bytes.len() {
        if let Ok(bundle) = DbcFormat.parse(&bytes[..cut], &ParseOptions::default()) {
            if let Ok(db) = CompiledDatabase::compile(bundle.database) {
                let mut out = [empty_sample(); 32];
                let mut sw = [(0u32, 0i64); 8];
                for m in &db.messages {
                    let _ = db.decode_payload_into(m.can_id, &[0xA5; 64], &mut out, &mut sw);
                    let _ = db.decode_payload_into(m.can_id, &[], &mut out, &mut sw);
                    let vals: Vec<_> = m.all_signal_ids.iter().map(|&i| (i, 1e300)).collect();
                    let mut p = [0u8; 64];
                    let _ = db.encode_payload_into(m.can_id, &vals, &mut p);
                }
            }
        }
    }
}

#[test]
fn hostile_truncated_kcd_at_every_byte_never_panics() {
    let kcd = r#"<?xml version="1.0"?><NetworkDefinition xmlns="http://kayak.2codeornot2code.org/1.0">
<Document name="T" version="1"/><Node id="1" name="ECU"/><Bus name="B">
<Message id="0x1FFFFFFF" format="extended" name="M" length="64" interval="10">
<Producer><NodeRef id="1"/></Producer>
<Multiplex name="Mx" offset="0" length="8"><MuxGroup count="1">
<Signal name="A" offset="8" length="16" endianess="big"><Value type="signed" slope="0" intercept="1" min="10" max="-10"/>
<LabelSet><Label name="x" value="1"/><LabelGroup from="0" to="64" name="g"/></LabelSet></Signal>
</MuxGroup></Multiplex></Message></Bus></NetworkDefinition>"#;
    let bytes = kcd.as_bytes();
    for cut in 0..=bytes.len() {
        for ft in [true, false] {
            let opts = ParseOptions {
                fault_tolerant: ft,
                ..ParseOptions::default()
            };
            if let Ok(bundle) = KcdFormat.parse(&bytes[..cut], &opts) {
                if let Ok(db) = CompiledDatabase::compile(bundle.database) {
                    let _ = db.to_schema_dto(nexus_netdb::DatabaseInfoDto {
                        name: String::new(),
                        version: None,
                        format: "kcd".into(),
                        source_encoding: "utf-8".into(),
                        message_count: 0,
                        signal_count: 0,
                        diagnostics: vec![],
                    });
                }
            }
        }
    }
}

#[test]
fn hostile_huge_numbers_giant_dlc_and_start_bits_are_rejected_or_clamped() {
    let text = "VERSION \"\"\nBU_: E\n\
BO_ 4294967295 Max: 255 E\n SG_ B : 65541|8@1+ (1,0) [0|0] \"\" E\n SG_ C : 511|64@0- (1,0) [0|0] \"\" E\n\
BO_ 4294967296 Wide: 8 E\n SG_ W : 0|8@1+ (1,0) [0|0] \"\" E\n\
BO_ 257 Ok: 8 E\n SG_ D : 0|300@1+ (1e308,1e308) [-1e309|1e309] \"\" E\n SG_ E : 504|64@1+ (1,0) [0|0] \"\" E\n\
BO_ 99999999999999999999999 Huge: 99999 E\n SG_ A : 99999|99999@1+ (1,0) [0|0] \"\" E\n";
    let bundle = DbcFormat
        .parse(text.as_bytes(), &ParseOptions::default())
        .unwrap();
    assert!(bundle.diagnostics.iter().any(|d| d.code == "MALFORMED_BO"));
    let db = bundle.database;
    // A 33-bit ID is rejected, not truncated onto 0x0 (which would alias a real message).
    assert!(!db.messages.contains_key(&CanIdKey::Standard(0)));
    let max = db
        .messages
        .get(&CanIdKey::Extended(0x1FFF_FFFF))
        .expect("0xFFFFFFFF parses");
    assert_eq!(max.dlc, 255);
    assert_eq!(
        max.signals
            .iter()
            .find(|s| s.name == "B")
            .unwrap()
            .start_bit,
        u16::MAX
    );
    let ok = db.messages.get(&CanIdKey::Standard(257)).unwrap();
    assert_eq!(
        ok.signals.iter().find(|s| s.name == "D").unwrap().bit_len,
        u8::MAX
    );
    for m in db.messages.values() {
        for s in &m.signals {
            // Values that do not fit the IR integer widths must saturate (and then fail compile),
            // never wrap around into a plausible-looking in-range value.
            assert!(
                !(s.name == "B" && s.start_bit == 5),
                "65541 must not wrap to 5"
            );
            assert!(
                !(s.name == "D" && s.bit_len == 44),
                "300 must not wrap to 44"
            );
        }
    }
    // Over-range spans are a compile error, never a panic or out-of-bounds write.
    assert!(CompiledDatabase::compile(db).is_err());
}

#[test]
fn hostile_kcd_huge_attributes_do_not_panic() {
    let kcd = r#"<NetworkDefinition xmlns="http://kayak.2codeornot2code.org/1.0"><Bus name="B">
<Message id="0xFFFFFFFFFFFF" name="M" length="300">
<Signal name="A" offset="70000" length="300"/>
<Multiplex name="Mx" offset="511" length="64" endianess="big"><MuxGroup count="-9223372036854775808">
<Signal name="B" offset="0" length="8"><Value slope="NaN" intercept="inf" min="NaN" max="-inf"/></Signal>
</MuxGroup></Multiplex></Message></Bus></NetworkDefinition>"#;
    let bundle = KcdFormat
        .parse(kcd.as_bytes(), &ParseOptions::default())
        .unwrap();
    let _ = CompiledDatabase::compile(bundle.database);
}

#[test]
fn hostile_many_messages_schema_generation_is_not_quadratic() {
    // 4_000 messages x 8 signals: schema DTO generation used to search every message per signal.
    let mut s = String::from("VERSION \"\"\nBU_: E\n");
    for m in 0..4_000u32 {
        s.push_str(&format!("BO_ {} M{m}: 8 E\n", 0x8000_0000u32 | m));
        for k in 0..8 {
            s.push_str(&format!(
                " SG_ S{m}_{k} : {}|8@1+ (1,0) [0|0] \"\" E\n",
                k * 8
            ));
        }
    }
    let (_db, schema) = within(Duration::from_secs(20), "32k-signal schema", || {
        parse_and_compile(s.as_bytes(), Some("big.dbc"), &ParseOptions::default()).unwrap()
    });
    assert_eq!(schema.signals.len(), 32_000);
    assert_eq!(
        schema.signals[31_999].message_key,
        schema.messages[3_999].message_key
    );
}
