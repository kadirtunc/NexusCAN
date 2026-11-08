use indexmap::IndexMap;
use nexus_core::{CanIdKey, VECTOR_INDEPENDENT_SIG_MSG_ID};
use nexus_netdb::{
    merge_databases, parse_and_compile, BitCellDto, ByteOrder, CompiledDatabase, DbError,
    DecodedSignalSample, EncodeError, FormatRegistry, FrameProtocol, MessageDef, NetworkDatabase,
    NormalizedBitSpan, ParseOptions, SignalValueType,
};

#[test]
fn test_intel_and_motorola_bit_plans() {
    // 1. Intel (@1) 16-bit signal at start_bit 8 (byte 1..2)
    let intel_span = NormalizedBitSpan::compile(8, 16, ByteOrder::LittleEndian).unwrap();
    let mut payload = [0u8; 64];
    intel_span.pack_raw_u64(0xABCD, &mut payload);
    assert_eq!(payload[1], 0xCD); // LSB
    assert_eq!(payload[2], 0xAB); // MSB
    assert_eq!(intel_span.extract_raw_u64(&payload), 0xABCD);

    // 2. Motorola (@0 Sawtooth) 16-bit signal at start_bit 7 (MSB at byte 0 bit 7 down to byte 1 bit 0)
    let moto_span = NormalizedBitSpan::compile(7, 16, ByteOrder::BigEndian).unwrap();
    let mut payload2 = [0u8; 64];
    moto_span.pack_raw_u64(0x1234, &mut payload2);
    assert_eq!(payload2[0], 0x12); // MSB byte
    assert_eq!(payload2[1], 0x34); // LSB byte
    assert_eq!(moto_span.extract_raw_u64(&payload2), 0x1234);

    // 3. Motorola 12-bit signal crossing byte boundaries (start_bit 11)
    // MSB at byte 1 bit 3 down to bit 0, then byte 2 bit 7 down to bit 0
    let moto_12 = NormalizedBitSpan::compile(11, 12, ByteOrder::BigEndian).unwrap();
    let mut payload3 = [0u8; 64];
    moto_12.pack_raw_u64(0x0A5C, &mut payload3);
    assert_eq!(moto_12.extract_raw_u64(&payload3), 0x0A5C);

    // 4. 1-bit signal
    let bit_intel = NormalizedBitSpan::compile(0, 1, ByteOrder::LittleEndian).unwrap();
    let bit_moto = NormalizedBitSpan::compile(7, 1, ByteOrder::BigEndian).unwrap();
    let mut p_bits = [0u8; 64];
    bit_intel.pack_raw_u64(1, &mut p_bits);
    bit_moto.pack_raw_u64(1, &mut p_bits);
    assert_eq!(bit_intel.extract_raw_u64(&p_bits), 1);
    assert_eq!(bit_moto.extract_raw_u64(&p_bits), 1);

    // 5. 64-bit signal full payload
    let full_intel = NormalizedBitSpan::compile(0, 64, ByteOrder::LittleEndian).unwrap();
    let mut p_full = [0u8; 64];
    let val_64 = 0xFEDCBA9876543210u64;
    full_intel.pack_raw_u64(val_64, &mut p_full);
    assert_eq!(full_intel.extract_raw_u64(&p_full), val_64);
}

#[test]
fn test_can_fd_64_byte_spans() {
    // Signal located beyond classical 8-byte boundary (e.g. byte 12..16, start_bit 96, length 32)
    let fd_span = NormalizedBitSpan::compile(96, 32, ByteOrder::LittleEndian).unwrap();
    let mut payload = [0u8; 64];
    fd_span.pack_raw_u64(0xCAFEBABE, &mut payload);
    assert_eq!(fd_span.extract_raw_u64(&payload), 0xCAFEBABE);

    // Signal in the very last byte of CAN-FD 64-byte frame (start_bit 504..512)
    let end_span = NormalizedBitSpan::compile(504, 8, ByteOrder::LittleEndian).unwrap();
    end_span.pack_raw_u64(0x55, &mut payload);
    assert_eq!(payload[63], 0x55);
    assert_eq!(end_span.extract_raw_u64(&payload), 0x55);

    // Bit 511 single bit
    let bit_511 = NormalizedBitSpan::compile(511, 1, ByteOrder::LittleEndian).unwrap();
    bit_511.pack_raw_u64(1, &mut payload);
    assert_eq!(payload[63] & 0x80, 0x80);
    assert_eq!(bit_511.extract_raw_u64(&payload), 1);

    // Span exceeding 512 bits must fail
    assert!(NormalizedBitSpan::compile(510, 4, ByteOrder::LittleEndian).is_err());
}

#[test]
fn test_signed_and_floating_point() {
    let dbc = r#"
VERSION ""
NS_ :
BS_:
BU_: Motor
BO_ 256 MotorStatus: 8 Motor
 SG_ NegativeTemp : 0|16@1- (0.1,-40) [-40|125] "degC" Vector__XXX
 SG_ MotoSigned : 23|16@0- (1,0) [-32768|32767] "rpm" Vector__XXX
 SG_ SingleFloat : 32|32@1+ (1,0) [-1000|1000] "V" Vector__XXX
SIG_VALTYPE_ 256 SingleFloat : 1 ;
"#;

    let registry = FormatRegistry::new();
    let bundle = registry
        .parse_bytes(dbc.as_bytes(), Some("test.dbc"), &ParseOptions::default())
        .unwrap();
    let compiled = CompiledDatabase::compile(bundle.database).unwrap();

    let can_id = CanIdKey::Standard(256);
    let mut out_signals = [DecodedSignalSample {
        signal_id: 0,
        raw_bits: 0,
        raw_int: 0,
        physical_value: 0.0,
        out_of_range: false,
        is_mux_switch: false,
    }; 16];
    let mut out_switches = [(0u32, 0i64); 4];

    // Encode physical values
    // NegativeTemp = -10.0 degC -> raw = (-10 - (-40)) / 0.1 = 300
    // MotoSigned = -500 rpm -> raw = -500 (two's complement in 16 bits: 0xFE0C)
    // SingleFloat = 380.5 V
    let mut payload = [0u8; 64];
    compiled
        .encode_payload_into(
            can_id,
            &[(0, -10.0), (1, -500.0), (2, 380.5)],
            &mut payload,
        )
        .unwrap();

    let summary = compiled
        .decode_payload_into(can_id, &payload, &mut out_signals, &mut out_switches)
        .unwrap();
    assert_eq!(summary.decoded_count, 3);

    // NegativeTemp
    assert_eq!(out_signals[0].signal_id, 0);
    assert!((out_signals[0].physical_value - (-10.0)).abs() < 1e-4);

    // MotoSigned
    assert_eq!(out_signals[1].signal_id, 1);
    assert_eq!(out_signals[1].raw_int, -500);
    assert!((out_signals[1].physical_value - (-500.0)).abs() < 1e-4);

    // SingleFloat
    assert_eq!(out_signals[2].signal_id, 2);
    assert!((out_signals[2].physical_value - 380.5).abs() < 1e-4);
}

#[test]
fn test_multiplexing_standard_and_cascaded() {
    let dbc = r#"
VERSION ""
NS_ :
BS_:
BU_: BMS
BO_ 260 BMS_Cells: 8 BMS
 SG_ MasterMux M : 0|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ Cell0_Volt m0 : 8|16@1+ (0.001,0) [0|5] "V" Vector__XXX
 SG_ Cell1_Volt m1 : 8|16@1+ (0.001,0) [0|5] "V" Vector__XXX
 SG_ SubMux m2M : 8|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ SubCellA m0 : 16|16@1+ (0.001,0) [0|5] "V" Vector__XXX
 SG_ MultiRange m1 : 16|16@1+ (1,0) [0|100] "%" Vector__XXX
SG_MUL_VAL_ 260 MultiRange MasterMux 5-8, 10-12 ;
"#;

    let registry = FormatRegistry::new();
    let bundle = registry
        .parse_bytes(dbc.as_bytes(), Some("bms.dbc"), &ParseOptions::default())
        .unwrap();
    let compiled = CompiledDatabase::compile(bundle.database).unwrap();

    let can_id = CanIdKey::Standard(260);
    let mut out_signals = [DecodedSignalSample {
        signal_id: 0,
        raw_bits: 0,
        raw_int: 0,
        physical_value: 0.0,
        out_of_range: false,
        is_mux_switch: false,
    }; 16];
    let mut out_switches = [(0u32, 0i64); 4];

    // Case 1: MasterMux = 0 -> Cell0_Volt should decode
    let mut payload = [0u8; 64];
    compiled
        .encode_payload_into(can_id, &[(1, 3.65)], &mut payload)
        .unwrap();
    // Verify auto-populated MasterMux = 0
    let summary = compiled
        .decode_payload_into(can_id, &payload, &mut out_signals, &mut out_switches)
        .unwrap();
    assert_eq!(out_switches[0].1, 0); // MasterMux was set to 0
    assert_eq!(summary.decoded_count, 2); // MasterMux + Cell0_Volt
    assert!((out_signals[1].physical_value - 3.65).abs() < 1e-4);

    // Case 2: MasterMux = 1 -> Cell1_Volt should decode
    compiled
        .encode_payload_into(can_id, &[(2, 4.12)], &mut payload)
        .unwrap();
    let _summary2 = compiled
        .decode_payload_into(can_id, &payload, &mut out_signals, &mut out_switches)
        .unwrap();
    assert_eq!(out_switches[0].1, 1);
    assert!((out_signals[1].physical_value - 4.12).abs() < 1e-4);

    // Case 3: Conflicting branches in single TX (Cell0_Volt from mux 0 and Cell1_Volt from mux 1)
    let conflict = compiled.encode_payload_into(can_id, &[(1, 3.65), (2, 4.12)], &mut payload);
    assert!(matches!(conflict, Err(EncodeError::ConflictingMuxBranches { .. })));

    // Case 4: Multi-range SG_MUL_VAL_ (matches 5-8, 10-12)
    let multi_sig = compiled.signals.iter().find(|s| s.name == "MultiRange").unwrap();
    assert!(multi_sig.mux_role.matches_value(6));
    assert!(multi_sig.mux_role.matches_value(11));
    assert!(!multi_sig.mux_role.matches_value(9));
}

#[test]
fn test_j1939_pgn_masked_lookup() {
    let dbc = r#"
VERSION ""
NS_ :
BS_:
BU_: Inverter
BO_ 2364539904 EEC1: 8 Inverter
 SG_ EngineSpeed : 24|16@1+ (0.125,0) [0|8031.875] "rpm" Vector__XXX
BA_DEF_ BO_ "VFrameFormat" ENUM "StandardCAN","ExtendedCAN","StandardCAN_FD","ExtendedCAN_FD","J1939PG";
BA_ "VFrameFormat" BO_ 2364539904 4;
"#;

    let registry = FormatRegistry::new();
    let bundle = registry
        .parse_bytes(dbc.as_bytes(), Some("j1939.dbc"), &ParseOptions::default())
        .unwrap();
    let compiled = CompiledDatabase::compile(bundle.database).unwrap();

    // 2364539904 raw with bit 31 set -> Extended CAN ID
    // EEC1 PGN is 0xF004 (61444)
    // Frame from Node 0x00 with Priority 3: 0x0CF00400
    // Frame from Node 0x2A with Priority 6: 0x18F0042A
    let frame1_id = CanIdKey::Extended(0x0CF00400);
    let frame2_id = CanIdKey::Extended(0x18F0042A);

    assert_eq!(frame1_id.extract_j1939_pgn(), Some(0xF004));
    assert_eq!(frame2_id.extract_j1939_pgn(), Some(0xF004));

    let msg1 = compiled.get_message(&frame1_id);
    let msg2 = compiled.get_message(&frame2_id);

    assert!(msg1.is_some());
    assert!(msg2.is_some());
    assert_eq!(msg1.unwrap().name, "EEC1");
    assert_eq!(msg2.unwrap().name, "EEC1");
}

#[test]
fn test_independent_signals_isolation() {
    let dbc = r#"
VERSION ""
NS_ :
BS_:
BU_: NodeA
BO_ 3221225472 VECTOR__INDEPENDENT_SIG_MSG: 0 Vector__XXX
 SG_ OrphanSig : 0|8@1+ (1,0) [0|255] "" Vector__XXX
BO_ 100 NormalMsg: 8 NodeA
 SG_ NormalSig : 0|8@1+ (1,0) [0|255] "" Vector__XXX
"#;

    let registry = FormatRegistry::new();
    let bundle = registry
        .parse_bytes(dbc.as_bytes(), Some("ind.dbc"), &ParseOptions::default())
        .unwrap();

    assert_eq!(bundle.database.independent_signals.len(), 1);
    assert_eq!(bundle.database.independent_signals[0].name, "OrphanSig");

    // Must NOT exist in active messages table
    assert_eq!(bundle.database.messages.len(), 1);
    let compiled = CompiledDatabase::compile(bundle.database).unwrap();
    assert_eq!(compiled.messages.len(), 1);
    assert!(compiled.get_message(&CanIdKey::Extended(VECTOR_INDEPENDENT_SIG_MSG_ID)).is_none());
}

#[test]
fn test_windows_1252_special_characters() {
    // Generate text in Windows-1252 containing degree symbol ° (0xB0), micro µ (0xB5), ohm Ω
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"VERSION \"\"\nNS_ :\nBS_:\nBU_: ECU\nBO_ 100 Sensor: 8 ECU\n SG_ Temp : 0|16@1+ (1,0) [0|100] \"");
    bytes.push(0xB0); // ° in Windows-1252
    bytes.extend_from_slice(b"C\" Vector__XXX\n");

    let registry = FormatRegistry::new();
    let bundle = registry
        .parse_bytes(&bytes, Some("sensor.dbc"), &ParseOptions::default())
        .unwrap();

    let sig = &bundle.database.messages[&CanIdKey::Standard(100)].signals[0];
    assert_eq!(sig.unit, "°C");
    assert_eq!(bundle.source_encoding, "Windows-1252");
    assert!(bundle.diagnostics.iter().any(|d| d.code == "ENCODING_TRANSCODED"));
}

#[test]
fn test_fault_tolerant_recovery() {
    let dbc_quirks = r#"
VERSION ""
NS_ :
BS_:
BU_: NodeA
BO_ 200 QuirkyMsg: 2 NodeA
 SG_ ValidSig : 0|8@1+ (1,0) [0|100] "" Vector__XXX
 SG_ OversizedSig : 24|8@1+ (1,0) [0|100] "" Vector__XXX
UNKNOWN_KEYWORD 123 456 ;
"#;

    let registry = FormatRegistry::new();
    let bundle = registry
        .parse_bytes(dbc_quirks.as_bytes(), Some("quirks.dbc"), &ParseOptions::default())
        .unwrap();

    assert_eq!(bundle.database.messages.len(), 1);
    assert_eq!(bundle.database.messages[&CanIdKey::Standard(200)].signals.len(), 2);
    // Verified diagnostic emission
    assert!(bundle.diagnostics.iter().any(|d| d.code == "BIT_SPAN_EXCEEDS_DLC"));
    assert!(bundle.diagnostics.iter().any(|d| d.code == "UNKNOWN_STATEMENT"));
}

#[test]
fn test_kcd_parsing_and_dbc_roundtrip() {
    let kcd_xml = r#"<NetworkDefinition xmlns="http://kayak.2codeornot2code.org/1.0">
  <Document name="BMS Network" version="1.0"/>
  <Node id="1" name="BMS_Master"/>
  <Bus name="BatteryBus">
    <Message id="0x1A0" length="8" name="PackStatus" format="standard" interval="50">
      <Producer>
        <NodeRef id="1"/>
      </Producer>
      <Notes>Main battery pack telemetry</Notes>
      <Signal name="PackVoltage" offset="0" length="16" endianess="little">
        <Value type="unsigned" slope="0.1" intercept="0" unit="V" min="0" max="800"/>
        <LabelSet>
          <Label name="Zero" value="0"/>
        </LabelSet>
      </Signal>
      <Signal name="PackCurrent" offset="16" length="16" endianess="little">
        <Value type="signed" slope="0.1" intercept="0" unit="A" min="-500" max="500"/>
      </Signal>
    </Message>
  </Bus>
</NetworkDefinition>"#;

    let registry = FormatRegistry::new();
    let bundle = registry
        .parse_bytes(kcd_xml.as_bytes(), Some("sample.kcd"), &ParseOptions::default())
        .unwrap();

    assert_eq!(bundle.format_name, "kcd");
    assert_eq!(bundle.database.messages.len(), 1);

    let msg = &bundle.database.messages[&CanIdKey::Standard(0x1A0)];
    assert_eq!(msg.name, "PackStatus");
    assert_eq!(msg.expected_cycle_ms, Some(50));
    assert_eq!(msg.signals.len(), 2);

    // Export to DBC and re-parse to verify roundtrip fidelity
    let dbc_bytes = registry.export_database("dbc", &bundle.database).unwrap();
    let re_bundle = registry
        .parse_bytes(&dbc_bytes, Some("exported.dbc"), &ParseOptions::default())
        .unwrap();

    let re_msg = &re_bundle.database.messages[&CanIdKey::Standard(0x1A0)];
    assert_eq!(re_msg.name, "PackStatus");
    assert_eq!(re_msg.signals.len(), 2);
    assert_eq!(re_msg.signals[0].name, "PackVoltage");
    assert_eq!(re_msg.signals[1].name, "PackCurrent");
}

#[test]
fn test_schema_dto_dense_invariants_and_bit_matrix() {
    let dbc = r#"
VERSION ""
NS_ :
BS_:
BU_: ECU
BO_ 500 TestMsg: 8 ECU
 SG_ SigA : 0|12@1+ (1,0) [0|4095] "" Vector__XXX
 SG_ SigB : 12|4@1+ (1,0) [0|15] "" Vector__XXX
"#;

    let (_compiled, schema_dto) = parse_and_compile(
        dbc.as_bytes(),
        Some("test.dbc"),
        &ParseOptions::default(),
    )
    .unwrap();

    // Invariant: signals[i].signal_id == i as u32
    for (i, sig) in schema_dto.signals.iter().enumerate() {
        assert_eq!(sig.signal_id, i as u32);
    }

    // Verify BitCellDto for SigA (12 bits from 0 to 11)
    let msg_dto = &schema_dto.messages[0];
    let sig_a_cells: Vec<&BitCellDto> = msg_dto.bit_layout.iter().filter(|c| c.signal_id == 0).collect();
    assert_eq!(sig_a_cells.len(), 12);
    assert!(sig_a_cells[0].is_lsb);
    assert!(sig_a_cells[11].is_msb);
}

#[test]
fn test_multi_database_merge() {
    let mut db1 = NetworkDatabase::new("DB1");
    let mut db2 = NetworkDatabase::new("DB2");

    let msg1 = MessageDef {
        can_id: CanIdKey::Standard(100),
        name: "MsgA".to_string(),
        dlc: 8,
        transmitters: vec!["ECU1".to_string()],
        signals: Vec::new(),
        comment: None,
        protocol: FrameProtocol::ClassicalCan,
        expected_cycle_ms: None,
        attributes: IndexMap::new(),
        signal_groups: Vec::new(),
    };

    let msg2 = MessageDef {
        can_id: CanIdKey::Standard(100),
        name: "MsgA_Overwritten".to_string(),
        dlc: 8,
        transmitters: vec!["ECU2".to_string()],
        signals: Vec::new(),
        comment: None,
        protocol: FrameProtocol::ClassicalCan,
        expected_cycle_ms: None,
        attributes: IndexMap::new(),
        signal_groups: Vec::new(),
    };

    db1.messages.insert(CanIdKey::Standard(100), msg1);
    db2.messages.insert(CanIdKey::Standard(100), msg2);

    let (merged, diags) = merge_databases(vec![db1, db2]);
    assert_eq!(merged.messages[&CanIdKey::Standard(100)].name, "MsgA_Overwritten");
    assert!(diags.iter().any(|d| d.code == "DUPLICATE_CAN_ID"));
}

#[test]
fn test_tx_safety_clamping_and_raw_frame_roundtrip() {
    let dbc = r#"
VERSION ""
NS_ :
BS_:
BU_: Actuator
BO_ 400 TorqueCmd: 8 Actuator
 SG_ TargetTorque : 0|16@1- (0.1,0) [-200|200] "Nm" Vector__XXX
"#;

    let (compiled, _) = parse_and_compile(
        dbc.as_bytes(),
        Some("torque.dbc"),
        &ParseOptions::default(),
    )
    .unwrap();

    let can_id = CanIdKey::Standard(400);

    // Physical value 350.0 Nm exceeds maximum 200.0 Nm -> must be clamped to 200.0 Nm!
    let frame = compiled
        .encode_raw_frame(0, can_id, &[(0, 350.0)], 1_000_000)
        .unwrap();

    assert_eq!(frame.can_id_key(), can_id);
    assert_eq!(frame.dlc, 8);

    // Decode frame back
    let mut out_signals = [DecodedSignalSample {
        signal_id: 0,
        raw_bits: 0,
        raw_int: 0,
        physical_value: 0.0,
        out_of_range: false,
        is_mux_switch: false,
    }; 4];
    let mut out_switches = [(0u32, 0i64); 2];

    let summary = compiled
        .decode_frame_into(&frame, &mut out_signals, &mut out_switches)
        .unwrap();
    assert_eq!(summary.decoded_count, 1);
    // Value was clamped to 200.0 Nm!
    assert!((out_signals[0].physical_value - 200.0).abs() < 1e-4);
    assert!(!out_signals[0].out_of_range);
}

#[test]
fn test_float64_double_precision() {
    let dbc = r#"
VERSION ""
NS_ :
BS_:
BU_: PrecisionNode
BO_ 700 HighPrecision: 8 PrecisionNode
 SG_ GpsLatitude : 0|64@1+ (1,0) [-90|90] "deg" Vector__XXX
SIG_VALTYPE_ 700 GpsLatitude : 2 ;
"#;

    let (compiled, _) = parse_and_compile(
        dbc.as_bytes(),
        Some("gps.dbc"),
        &ParseOptions::default(),
    )
    .unwrap();

    let can_id = CanIdKey::Standard(700);
    let mut payload = [0u8; 64];
    let lat_val = 41.0082376;
    compiled
        .encode_payload_into(can_id, &[(0, lat_val)], &mut payload)
        .unwrap();

    let mut out_signals = [DecodedSignalSample {
        signal_id: 0,
        raw_bits: 0,
        raw_int: 0,
        physical_value: 0.0,
        out_of_range: false,
        is_mux_switch: false,
    }; 4];
    let mut out_switches = [(0u32, 0i64); 2];

    let summary = compiled
        .decode_payload_into(can_id, &payload, &mut out_signals, &mut out_switches)
        .unwrap();

    assert_eq!(summary.decoded_count, 1);
    assert!((out_signals[0].physical_value - lat_val).abs() < 1e-9);
}

#[test]
fn test_cyclic_mux_detection() {
    use rustc_hash::FxHashSet;
    use smallvec::SmallVec;
    use nexus_netdb::compiler::CompiledSignal;
    use nexus_netdb::ir::mux::{MuxRange, MuxRole};
    use nexus_netdb::MuxDecisionTree;

    let span_a = NormalizedBitSpan::compile(0, 8, ByteOrder::LittleEndian).unwrap();
    let span_b = NormalizedBitSpan::compile(8, 8, ByteOrder::LittleEndian).unwrap();

    // Signal 0 is switch A, multiplexed on switch B
    let mut range_b = SmallVec::new();
    range_b.push(MuxRange::single(1));
    let sig_a = CompiledSignal {
        id: 0,
        name: "SigA".to_string(),
        long_name: None,
        start_bit: 0,
        bit_len: 8,
        byte_order: ByteOrder::LittleEndian,
        value_type: SignalValueType::Unsigned,
        factor: 1.0,
        offset: 0.0,
        min: 0.0,
        max: 255.0,
        unit: "".to_string(),
        receivers: Vec::new(),
        mux_role: MuxRole::Multiplexed {
            switch_signal_name: "SigB".to_string(),
            switch_signal: 1,
            ranges: range_b,
            is_sub_switch: true,
        },
        bit_span: span_a,
        initial_value: None,
        has_bounds: false,
        has_enum_table: false,
        enum_values: IndexMap::new(),
        comment: None,
    };

    // Signal 1 is switch B, multiplexed on switch A -> Cycle A -> B -> A!
    let mut range_a = SmallVec::new();
    range_a.push(MuxRange::single(1));
    let sig_b = CompiledSignal {
        id: 1,
        name: "SigB".to_string(),
        long_name: None,
        start_bit: 8,
        bit_len: 8,
        byte_order: ByteOrder::LittleEndian,
        value_type: SignalValueType::Unsigned,
        factor: 1.0,
        offset: 0.0,
        min: 0.0,
        max: 255.0,
        unit: "".to_string(),
        receivers: Vec::new(),
        mux_role: MuxRole::Multiplexed {
            switch_signal_name: "SigA".to_string(),
            switch_signal: 0,
            ranges: range_a,
            is_sub_switch: true,
        },
        bit_span: span_b,
        initial_value: None,
        has_bounds: false,
        has_enum_table: false,
        enum_values: IndexMap::new(),
        comment: None,
    };

    let signals = vec![sig_a, sig_b];
    let mut visited = FxHashSet::default();
    let result = MuxDecisionTree::build(0, &signals, &mut visited);

    assert!(result.is_err());
    assert!(matches!(result, Err(DbError::CyclicMux(_))));
}
