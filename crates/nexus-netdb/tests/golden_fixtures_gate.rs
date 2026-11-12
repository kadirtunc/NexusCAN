use std::mem::{align_of, size_of};
use std::path::PathBuf;
use std::time::Instant;

use nexus_core::{CanIdKey, RawCanFrame, VECTOR_INDEPENDENT_SIG_MSG_ID};
use nexus_netdb::{
    merge_databases, CompiledDatabase, DatabaseInfoDto, DatabaseSchemaDto, DecodedSignalSample,
    EncodeError, FormatRegistry, ParseOptions, SignalId,
};

fn scripts_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates/")
        .parent()
        .expect("workspace root")
        .join("scripts")
}

fn load_merged_golden_databases() -> (CompiledDatabase, DatabaseSchemaDto) {
    let registry = FormatRegistry::new();
    let opts = ParseOptions::default();

    let dbc_path = scripts_dir().join("sample_vehicle.dbc");
    let kcd_path = scripts_dir().join("sample_bms.kcd");

    let dbc_bytes = std::fs::read(&dbc_path).expect("failed to read scripts/sample_vehicle.dbc");
    let kcd_bytes = std::fs::read(&kcd_path).expect("failed to read scripts/sample_bms.kcd");

    let dbc_bundle = registry
        .parse_bytes(&dbc_bytes, Some("sample_vehicle.dbc"), &opts)
        .expect("sample_vehicle.dbc must parse cleanly");
    let kcd_bundle = registry
        .parse_bytes(&kcd_bytes, Some("sample_bms.kcd"), &opts)
        .expect("sample_bms.kcd must parse cleanly");

    assert_eq!(dbc_bundle.format_name, "dbc");
    assert_eq!(kcd_bundle.format_name, "kcd");
    assert!(
        dbc_bundle.diagnostics.is_empty(),
        "Golden DBC should emit zero diagnostics, got: {:?}",
        dbc_bundle.diagnostics
    );
    assert!(
        kcd_bundle.diagnostics.is_empty(),
        "Golden KCD should emit zero diagnostics, got: {:?}",
        kcd_bundle.diagnostics
    );

    assert_eq!(dbc_bundle.database.independent_signals.len(), 2);
    assert_eq!(dbc_bundle.database.messages.len(), 4);
    assert_eq!(kcd_bundle.database.messages.len(), 4);

    let (merged_ir, merge_diags) = merge_databases(vec![dbc_bundle.database, kcd_bundle.database]);
    assert!(
        merge_diags.is_empty(),
        "Non-colliding golden DBC + KCD merge should emit zero warnings, got: {:?}",
        merge_diags
    );

    let info = DatabaseInfoDto {
        name: "NexusCAN_Golden_Merged".to_string(),
        version: merged_ir.version.clone(),
        format: "dbc+kcd".to_string(),
        source_encoding: "UTF-8".to_string(),
        message_count: merged_ir.messages.len(),
        signal_count: merged_ir.messages.values().map(|m| m.signals.len()).sum(),
        diagnostics: merge_diags,
    };

    let compiled = CompiledDatabase::compile(merged_ir).expect("merged golden DB must compile");
    let schema_dto = compiled.to_schema_dto(info);
    (compiled, schema_dto)
}

fn parse_hex_bytes<const N: usize>(hex: &str) -> [u8; N] {
    let bytes: Vec<u8> = hex
        .split_whitespace()
        .map(|b| u8::from_str_radix(b, 16).expect("valid hex byte"))
        .collect();
    assert_eq!(bytes.len(), N, "expected {} bytes, got {}", N, bytes.len());
    let mut arr = [0u8; N];
    arr.copy_from_slice(&bytes);
    arr
}

fn find_sig_id(db: &CompiledDatabase, msg_id: CanIdKey, sig_name: &str) -> SignalId {
    let msg = db
        .get_message(&msg_id)
        .unwrap_or_else(|| panic!("message {:?} not found", msg_id));
    msg.all_signals
        .iter()
        .find(|s| s.name == sig_name)
        .unwrap_or_else(|| panic!("signal '{}' not found in {:?}", sig_name, msg_id))
        .id
}

fn decoded_map<'a>(
    db: &'a CompiledDatabase,
    samples: &[DecodedSignalSample],
) -> Vec<(&'a str, DecodedSignalSample)> {
    samples
        .iter()
        .map(|s| {
            let name = db
                .get_signal(s.signal_id)
                .expect("valid signal_id")
                .name
                .as_str();
            (name, *s)
        })
        .collect()
}

fn assert_phys(decoded: &[(&str, DecodedSignalSample)], sig_name: &str, expected: f64, tol: f64) {
    let sample = decoded
        .iter()
        .find(|(n, _)| *n == sig_name)
        .unwrap_or_else(|| {
            let present: Vec<&str> = decoded.iter().map(|(n, _)| *n).collect();
            panic!(
                "expected active signal '{}' in decoded output, present: {:?}",
                sig_name, present
            )
        })
        .1;
    assert!(
        (sample.physical_value - expected).abs() <= tol,
        "signal '{}' physical mismatch: expected {}, got {} (raw_bits=0x{:X}, raw_int={})",
        sig_name,
        expected,
        sample.physical_value,
        sample.raw_bits,
        sample.raw_int
    );
}

#[test]
fn gate1_raw_can_frame_abi_and_concurrency_invariants() {
    fn assert_traits<T: Copy + Clone + Send + Sync + Sized>() {}
    assert_traits::<RawCanFrame>();
    assert_eq!(size_of::<RawCanFrame>(), 80);
    assert_eq!(align_of::<RawCanFrame>(), 8);
}

#[test]
fn gate2_schema_dense_ids_protocols_and_orphan_isolation() {
    let (compiled, schema) = load_merged_golden_databases();

    assert_eq!(schema.messages.len(), 8);
    assert_eq!(schema.ecus.len(), 9);
    for (idx, sig_dto) in schema.signals.iter().enumerate() {
        assert_eq!(sig_dto.signal_id, idx as u32);
    }

    assert_eq!(compiled.raw_database.independent_signals.len(), 2);
    assert!(compiled
        .get_message(&CanIdKey::Extended(
            VECTOR_INDEPENDENT_SIG_MSG_ID & 0x1FFF_FFFF
        ))
        .is_none());

    let m101 = schema
        .messages
        .iter()
        .find(|m| m.name == "INV_MotorStatus")
        .unwrap();
    assert_eq!(m101.protocol, "CAN");
    assert_eq!(m101.expected_cycle_ms, Some(10));
    assert_eq!(
        m101.transmitters,
        vec!["INV".to_string(), "VCU".to_string()]
    );

    let m201 = schema
        .messages
        .iter()
        .find(|m| m.name == "INV_FastTelemetryFD")
        .unwrap();
    assert_eq!(m201.protocol, "CAN_FD");
    assert_eq!(m201.dlc, 64);
    assert_eq!(m201.expected_cycle_ms, Some(5));

    let mj1939 = schema
        .messages
        .iter()
        .find(|m| m.name == "DCFC_ChargerStatus")
        .unwrap();
    assert_eq!(mj1939.protocol, "J1939");
    assert_eq!(mj1939.expected_cycle_ms, Some(100));
}

#[test]
fn gate2_vector1_dbc_0x101_motorola_sawtooth_and_signed_cross_byte() {
    let (db, _) = load_merged_golden_databases();
    let mut out_sigs = [DecodedSignalSample {
        signal_id: 0,
        raw_bits: 0,
        raw_int: 0,
        physical_value: 0.0,
        out_of_range: false,
        is_mux_switch: false,
    }; 16];
    let mut out_sw = [(0u32, 0i64); 4];

    let v1_bytes = parse_hex_bytes::<8>("F4 1A 3F B2 3C 6E D3 68");
    let s1 = db
        .decode_payload_into(
            CanIdKey::Standard(0x101),
            &v1_bytes,
            &mut out_sigs,
            &mut out_sw,
        )
        .expect("0x101 decode");
    assert_eq!(s1.decoded_count, 7);
    let d1 = decoded_map(&db, &out_sigs[..s1.decoded_count]);
    assert_phys(&d1, "MotorSpeedRpm", 3450.0, 1e-6);
    assert_phys(&d1, "InverterState", 3.0, 1e-6);
    assert_phys(&d1, "MotorTorqueNm", -124.5, 1e-6);
    assert_phys(&d1, "DcBusVoltage", 795.5, 1e-6);
    assert_phys(&d1, "DriveGearState", 3.0, 1e-6);
    assert_phys(&d1, "PhaseCurrentAmp", -185.5, 1e-6);
    assert_phys(&d1, "ActiveFaultFlag", 0.0, 1e-6);

    // Sign-extension verification ritual: -0.1 Nm vs +0.1 Nm
    let id_101 = CanIdKey::Standard(0x101);
    let torque_id = find_sig_id(&db, id_101, "MotorTorqueNm");
    for target in [-0.1, 0.1] {
        let f = db
            .encode_raw_frame(0, id_101, &[(torque_id, target)], 100)
            .unwrap();
        let sum = db
            .decode_frame_into(&f, &mut out_sigs, &mut out_sw)
            .unwrap();
        let dm = decoded_map(&db, &out_sigs[..sum.decoded_count]);
        assert_phys(&dm, "MotorTorqueNm", target, 1e-6);
    }
}

#[test]
fn gate2_vector2_and_3_dbc_0x105_cascaded_and_multirange_sg_mul_val() {
    let (db, _) = load_merged_golden_databases();
    let mut out_sigs = [DecodedSignalSample {
        signal_id: 0,
        raw_bits: 0,
        raw_int: 0,
        physical_value: 0.0,
        out_of_range: false,
        is_mux_switch: false,
    }; 32];
    let mut out_sw = [(0u32, 0i64); 8];

    // Vector 2: Cascaded MuxDomainSwitch=1 -> SubBankSwitch=1
    let v2_bytes = parse_hex_bytes::<8>("11 A5 F7 8F 00 91 57 FE");
    let s2 = db
        .decode_payload_into(
            CanIdKey::Standard(0x105),
            &v2_bytes,
            &mut out_sigs,
            &mut out_sw,
        )
        .expect("0x105 cascaded branch decode");
    assert_eq!(s2.decoded_count, 6);
    assert_eq!(s2.active_switch_count, 2);
    let d2 = decoded_map(&db, &out_sigs[..s2.decoded_count]);
    assert_phys(&d2, "MuxDomainSwitch", 1.0, 1e-6);
    assert_phys(&d2, "SubBankSwitch", 1.0, 1e-6);
    assert_phys(&d2, "PackSocPct", 82.5, 1e-6);
    assert_phys(&d2, "CellBank1MinMv", 3685.5, 1e-6);
    assert_phys(&d2, "CellBank1MaxMv", 3712.0, 1e-6);
    assert_phys(&d2, "CellBank1TempDegC", -4.25, 1e-6);
    assert!(!d2
        .iter()
        .any(|(n, _)| n.starts_with("CellBank0") || *n == "IsoResistanceKOhm"));

    // Vector 3: Domain 2 (2-2) + Overlapping Multi-Range HvInterlockClosed (2-3, 10-12)
    let v3_bytes = parse_hex_bytes::<8>("22 A5 25 13 38 3E 00 01");
    let s3 = db
        .decode_payload_into(
            CanIdKey::Standard(0x105),
            &v3_bytes,
            &mut out_sigs,
            &mut out_sw,
        )
        .expect("0x105 domain 2 decode");
    let d3 = decoded_map(&db, &out_sigs[..s3.decoded_count]);
    assert_phys(&d3, "MuxDomainSwitch", 2.0, 1e-6);
    assert_phys(&d3, "ContactorState", 2.0, 1e-6);
    assert_phys(&d3, "PackSocPct", 82.5, 1e-6);
    assert_phys(&d3, "IsoResistanceKOhm", 2450.5, 1e-6);
    assert_phys(&d3, "HvPackVoltageV", 796.4, 1e-6);
    assert_phys(&d3, "BmsFaultCode", 0.0, 1e-6);
    assert_phys(&d3, "HvInterlockClosed", 1.0, 1e-6);
    assert_eq!(s3.decoded_count, 7);
}

#[test]
fn gate2_vector4_dbc_0x201_canfd_64b_floats_sawtooth_and_bit511() {
    let (db, _) = load_merged_golden_databases();
    let mut out_sigs = [DecodedSignalSample {
        signal_id: 0,
        raw_bits: 0,
        raw_int: 0,
        physical_value: 0.0,
        out_of_range: false,
        is_mux_switch: false,
    }; 32];
    let mut out_sw = [(0u32, 0i64); 4];

    let v4_bytes = parse_hex_bytes::<64>(
        "EF BE A7 00 D0 12 13 00 00 00 40 3E 00 00 00 00 \
         00 00 00 00 80 52 96 40 00 00 00 00 00 00 00 00 \
         5F 8A DF 8C 00 00 00 00 00 00 00 00 00 00 00 00 \
         00 00 00 00 00 00 00 00 00 00 00 00 00 A5 1E A5",
    );
    let s4 = db
        .decode_payload_into(
            CanIdKey::Standard(0x201),
            &v4_bytes,
            &mut out_sigs,
            &mut out_sw,
        )
        .expect("0x201 64B CAN-FD decode");
    assert_eq!(s4.decoded_count, 11);
    let d4 = decoded_map(&db, &out_sigs[..s4.decoded_count]);
    assert_phys(&d4, "E2E_Crc16", 48879.0, 1e-6);
    assert_phys(&d4, "E2E_AliveCounter", 7.0, 1e-6);
    assert_phys(&d4, "E2E_DataId", 10.0, 1e-6);
    assert_phys(&d4, "ControlLoopTickUs", 1_250_000.0, 1e-6);
    assert_phys(&d4, "FluxLinkageWb", 0.1875, 1e-7);
    assert_phys(&d4, "TotalEnergyKwh", 1428.625, 1e-9);
    assert_phys(&d4, "SubFrameSlotId", 5.0, 1e-6);
    assert_phys(&d4, "ShaftTorqueFineNm", -18.75, 1e-6);
    assert_phys(&d4, "ResolverQualityPct", 99.5, 1e-6);
    assert_phys(&d4, "SiCBridgeTempMaxDegC", 78.45, 1e-6);
    assert_phys(&d4, "TailIntegrityMarker", 165.0, 1e-6);
}

#[test]
fn gate2_vector5_j1939_pgn_mask_vs_non_j1939_extended_isolation() {
    let (db, _) = load_merged_golden_databases();
    let mut out_sigs = [DecodedSignalSample {
        signal_id: 0,
        raw_bits: 0,
        raw_int: 0,
        physical_value: 0.0,
        out_of_range: false,
        is_mux_switch: false,
    }; 16];
    let mut out_sw = [(0u32, 0i64); 4];

    let v5_bytes = parse_hex_bytes::<8>("59 1F BC 34 13 52 AC 0D");
    for j1939_id in [
        CanIdKey::Extended(0x18FF50E5),
        CanIdKey::Extended(0x18FF50FE),
        CanIdKey::Extended(0x0CFF5021),
    ] {
        let s5 = db
            .decode_payload_into(j1939_id, &v5_bytes, &mut out_sigs, &mut out_sw)
            .expect("J1939 PGN 0xFF50 decode");
        assert_eq!(s5.decoded_count, 6);
        let d5 = decoded_map(&db, &out_sigs[..s5.decoded_count]);
        assert_phys(&d5, "ChargerOutputVoltageV", 802.5, 1e-6);
        assert_phys(&d5, "ChargerOutputCurrentA", 350.0, 1e-6);
        assert_phys(&d5, "ChargerOperatingState", 3.0, 1e-6);
        assert_phys(&d5, "CableLockEngaged", 1.0, 1e-6);
        assert_phys(&d5, "ConnectorTempDegC", 42.0, 1e-6);
        assert_phys(&d5, "AvailablePowerKw", 350.0, 1e-6);
    }

    // Non-J1939 extended KCD message 0x18F00900 (ClassicalCan, NOT J1939Pg) must NOT wildcard-match SA 0xFE!
    assert!(
        db.decode_payload_into(
            CanIdKey::Extended(0x18F009FE),
            &[0u8; 8],
            &mut out_sigs,
            &mut out_sw
        )
        .is_none(),
        "Non-J1939 extended CAN message 0x18F00900 must not wildcard-match SA 0xFE via j1939_pgn_index"
    );
}

#[test]
fn gate2_vector6_kcd_mux_banks_big_endian_sawtooth_and_floats() {
    let (db, _) = load_merged_golden_databases();
    let mut out_sigs = [DecodedSignalSample {
        signal_id: 0,
        raw_bits: 0,
        raw_int: 0,
        physical_value: 0.0,
        out_of_range: false,
        is_mux_switch: false,
    }; 16];
    let mut out_sw = [(0u32, 0i64); 4];

    let v6a_bytes = parse_hex_bytes::<8>("D2 38 C9 94 60 49 97 F2");
    let s6a = db
        .decode_payload_into(
            CanIdKey::Standard(0x301),
            &v6a_bytes,
            &mut out_sigs,
            &mut out_sw,
        )
        .expect("KCD 0x301 decode");
    assert_eq!(s6a.decoded_count, 8);
    let d6a = decoded_map(&db, &out_sigs[..s6a.decoded_count]);
    assert_phys(&d6a, "CellBankSelector", 2.0, 1e-6);
    assert_phys(&d6a, "CmcBalanceActiveFlag", 1.0, 1e-6);
    assert_phys(&d6a, "CmcRollingCounter", 6.0, 1e-6);
    assert_phys(&d6a, "Cell09VoltageV", 3.680, 1e-6);
    assert_phys(&d6a, "Cell10VoltageV", 3.690, 1e-6);
    assert_phys(&d6a, "Cell11VoltageV", 3.700, 1e-6);
    assert_phys(&d6a, "Cell12VoltageV", 3.710, 1e-6);
    assert_phys(&d6a, "Bank2NtcTempDegC", 18.0, 1e-6);
    assert!(!d6a
        .iter()
        .any(|(n, _)| n.starts_with("Cell01") || n.starts_with("Cell13")));

    let v6b_bytes = parse_hex_bytes::<8>("F6 6E 96 04 B0 02 91 00");
    let s6b = db
        .decode_payload_into(
            CanIdKey::Standard(0x302),
            &v6b_bytes,
            &mut out_sigs,
            &mut out_sw,
        )
        .expect("KCD 0x302 decode");
    assert_eq!(s6b.decoded_count, 6);
    let d6b = decoded_map(&db, &out_sigs[..s6b.decoded_count]);
    assert_phys(&d6b, "PackCurrentAmp", -245.0, 1e-6);
    assert_phys(&d6b, "MaxDischargeCurrentLimA", 600.0, 1e-6);
    assert_phys(&d6b, "MaxRegenCurrentLimA", 300.0, 1e-6);
    assert_phys(&d6b, "BmsThermalState", 2.0, 1e-6);
    assert_phys(&d6b, "PackHealthStatus", 0.0, 1e-6);
    assert_phys(&d6b, "CellVoltageSpreadMv", 14.5, 1e-6);

    let v6c_bytes = parse_hex_bytes::<8>("00 00 48 41 00 00 50 40");
    let s6c = db
        .decode_payload_into(
            CanIdKey::Standard(0x303),
            &v6c_bytes,
            &mut out_sigs,
            &mut out_sw,
        )
        .expect("KCD 0x303 decode");
    let d6c = decoded_map(&db, &out_sigs[..s6c.decoded_count]);
    assert_phys(&d6c, "CoolantFlowRateLpm", 12.5, 1e-6);
    assert_phys(&d6c, "ChillerCompressorPowerKw", 3.25, 1e-6);

    let v6d_bytes = parse_hex_bytes::<8>("00 00 00 00 1C 90 E7 40");
    let s6d = db
        .decode_payload_into(
            CanIdKey::Extended(0x18F00900),
            &v6d_bytes,
            &mut out_sigs,
            &mut out_sw,
        )
        .expect("KCD 0x18F00900 decode");
    let d6d = decoded_map(&db, &out_sigs[..s6d.decoded_count]);
    assert_phys(&d6d, "LifetimeDischargedEnergyKwh", 48_256.875, 1e-9);
}

#[test]
fn gate2_dbc_gensigstartvalue_raw_to_physical_scaling() {
    let (_, schema) = load_merged_golden_databases();

    let sig_dc_bus = schema
        .signals
        .iter()
        .find(|s| s.name == "DcBusVoltage")
        .unwrap();
    assert_eq!(
        sig_dc_bus.initial_value,
        Some(400.0),
        "DBC GenSigStartValue=1600 (raw) * 0.25 + 0 must yield physical 400.0 V"
    );

    let sig_soc = schema
        .signals
        .iter()
        .find(|s| s.name == "PackSocPct")
        .unwrap();
    assert_eq!(
        sig_soc.initial_value,
        Some(80.0),
        "DBC GenSigStartValue=160 (raw) * 0.5 + 0 must yield physical 80.0 %"
    );

    let sig_chg_curr = schema
        .signals
        .iter()
        .find(|s| s.name == "ChargerOutputCurrentA")
        .unwrap();
    assert_eq!(
        sig_chg_curr.initial_value,
        Some(0.0),
        "DBC GenSigStartValue=10000 (raw) * 0.1 - 1000 must yield physical 0.0 A"
    );
}

#[test]
fn gate2_kcd_producer_consumer_and_multiplex_metadata() {
    let (_, schema) = load_merged_golden_databases();

    let m301 = schema
        .messages
        .iter()
        .find(|m| m.name == "CMC_CellVoltagesMux")
        .unwrap();
    assert_eq!(
        m301.transmitters,
        vec!["CMC_Front".to_string()],
        "KCD <Consumer><NodeRef/> must populate signal receivers, NOT message transmitters"
    );
    assert!(
        m301.comment
            .as_deref()
            .unwrap_or_default()
            .contains("4-bank multiplexed cell monitor frame"),
        "KCD <Message><Notes> must not be overwritten by <Multiplex><Notes>, got: {:?}",
        m301.comment
    );

    let sig_cell01 = schema
        .signals
        .iter()
        .find(|s| s.name == "Cell01VoltageV")
        .unwrap();
    assert_eq!(sig_cell01.receivers, vec!["BMS_Master".to_string()]);

    let sig_mux_sel = schema
        .signals
        .iter()
        .find(|s| s.name == "CellBankSelector")
        .unwrap();
    assert_eq!(
        sig_mux_sel.enum_table.get(&2).map(String::as_str),
        Some("Bank2_Cells09_12"),
        "KCD <Multiplex><LabelSet> enum labels must be preserved"
    );
}

#[test]
fn gate2_tx_encode_roundtrip_clamping_and_cascaded_mux_conflict() {
    let (db, _) = load_merged_golden_databases();
    let mut out_sigs = [DecodedSignalSample {
        signal_id: 0,
        raw_bits: 0,
        raw_int: 0,
        physical_value: 0.0,
        out_of_range: false,
        is_mux_switch: false,
    }; 32];
    let mut out_sw = [(0u32, 0i64); 8];

    // 1. 0x101 TX clamping verification: out-of-bounds values must clamp to [min, max], never wrap!
    let id_101 = CanIdKey::Standard(0x101);
    let torque_id = find_sig_id(&db, id_101, "MotorTorqueNm"); // [-500|500]
    let speed_id = find_sig_id(&db, id_101, "MotorSpeedRpm"); // [-16000|16000]
    let phase_id = find_sig_id(&db, id_101, "PhaseCurrentAmp"); // [-500|500]

    let clamped_hi = db
        .encode_raw_frame(
            0,
            id_101,
            &[
                (torque_id, 950.0),
                (speed_id, -25_000.0),
                (phase_id, -999.0),
            ],
            100,
        )
        .expect("encode 0x101 clamped");
    let sum_hi = db
        .decode_frame_into(&clamped_hi, &mut out_sigs, &mut out_sw)
        .unwrap();
    let d_hi = decoded_map(&db, &out_sigs[..sum_hi.decoded_count]);
    assert_phys(&d_hi, "MotorTorqueNm", 500.0, 1e-6);
    assert_phys(&d_hi, "MotorSpeedRpm", -16_000.0, 1e-6);
    assert_phys(&d_hi, "PhaseCurrentAmp", -500.0, 1e-6);

    // 2. 0x201 64-byte CAN-FD TX -> RX roundtrip
    let id_201 = CanIdKey::Standard(0x201);
    let flux_id = find_sig_id(&db, id_201, "FluxLinkageWb");
    let energy_id = find_sig_id(&db, id_201, "TotalEnergyKwh");
    let shaft_id = find_sig_id(&db, id_201, "ShaftTorqueFineNm");
    let tail_id = find_sig_id(&db, id_201, "TailIntegrityMarker");

    let fd_frame = db
        .encode_raw_frame(
            1,
            id_201,
            &[
                (flux_id, -0.3125),
                (energy_id, 98_765.125),
                (shaft_id, -215.45),
                (tail_id, 255.0),
            ],
            400,
        )
        .expect("encode 0x201 CAN-FD");
    assert!(fd_frame.is_fd());
    assert_eq!(fd_frame.dlc, 64);

    let sum_fd = db
        .decode_frame_into(&fd_frame, &mut out_sigs, &mut out_sw)
        .unwrap();
    let d_fd = decoded_map(&db, &out_sigs[..sum_fd.decoded_count]);
    assert_phys(&d_fd, "FluxLinkageWb", -0.3125, 1e-7);
    assert_phys(&d_fd, "TotalEnergyKwh", 98_765.125, 1e-9);
    assert_phys(&d_fd, "ShaftTorqueFineNm", -215.45, 1e-6);
    assert_phys(&d_fd, "TailIntegrityMarker", 255.0, 1e-6);

    // 3. 0x105 Sibling & Cascaded Ancestor Mux Conflict Detection
    let id_105 = CanIdKey::Standard(0x105);
    let dom_sw = find_sig_id(&db, id_105, "MuxDomainSwitch");
    let bank0_min = find_sig_id(&db, id_105, "CellBank0MinMv");
    let bank1_min = find_sig_id(&db, id_105, "CellBank1MinMv");

    let sibling_conflict =
        db.encode_raw_frame(0, id_105, &[(bank0_min, 3600.0), (bank1_min, 3700.0)], 301);
    assert!(matches!(
        sibling_conflict,
        Err(EncodeError::ConflictingMuxBranches { .. })
    ));

    let ancestor_conflict =
        db.encode_raw_frame(0, id_105, &[(dom_sw, 2.0), (bank1_min, 3700.0)], 302);
    assert!(
        matches!(
            ancestor_conflict,
            Err(EncodeError::ConflictingMuxBranches { .. })
        ),
        "Expected ConflictingMuxBranches when MuxDomainSwitch=2 conflicts with CellBank1MinMv (requires MuxDomainSwitch in 0..=1), got: {:?}",
        ancestor_conflict
    );
}

#[test]
fn gate3_zero_alloc_100k_mixed_frames_throughput_benchmark() {
    let (db, _) = load_merged_golden_databases();

    let f_101 = RawCanFrame::new_classical(
        0,
        CanIdKey::Standard(0x101),
        &parse_hex_bytes::<8>("F4 1A 3F B2 3C 6E D3 68"),
        1_000,
    )
    .unwrap();
    let f_105 = RawCanFrame::new_classical(
        0,
        CanIdKey::Standard(0x105),
        &parse_hex_bytes::<8>("11 A5 F7 8F 00 91 57 FE"),
        1_020,
    )
    .unwrap();
    let f_201 = RawCanFrame::new_fd(
        0,
        CanIdKey::Standard(0x201),
        &parse_hex_bytes::<64>(
            "EF BE A7 00 D0 12 13 00 00 00 40 3E 00 00 00 00 \
             00 00 00 00 80 52 96 40 00 00 00 00 00 00 00 00 \
             5F 8A DF 8C 00 00 00 00 00 00 00 00 00 00 00 00 \
             00 00 00 00 00 00 00 00 00 00 00 00 00 A5 1E A5",
        ),
        true,
        1_025,
    )
    .unwrap();
    let f_j1939 = RawCanFrame::new_classical(
        0,
        CanIdKey::Extended(0x18FF50FE),
        &parse_hex_bytes::<8>("59 1F BC 34 13 52 AC 0D"),
        1_100,
    )
    .unwrap();
    let f_301 = RawCanFrame::new_classical(
        1,
        CanIdKey::Standard(0x301),
        &parse_hex_bytes::<8>("D2 38 C9 94 60 49 97 F2"),
        1_125,
    )
    .unwrap();

    let ring = [f_101, f_105, f_201, f_j1939, f_301];
    let expected_counts = [7usize, 6, 11, 6, 8];

    let mut out_sigs = [DecodedSignalSample {
        signal_id: 0,
        raw_bits: 0,
        raw_int: 0,
        physical_value: 0.0,
        out_of_range: false,
        is_mux_switch: false,
    }; 32];
    let mut out_sw = [(0u32, 0i64); 8];

    const TOTAL_FRAMES: usize = 100_000;
    let mut total_decoded_signals = 0usize;

    let start = Instant::now();
    for i in 0..TOTAL_FRAMES {
        let slot = i % ring.len();
        let summary = db
            .decode_frame_into(&ring[slot], &mut out_sigs, &mut out_sw)
            .expect("frame must decode");
        assert_eq!(summary.decoded_count, expected_counts[slot]);
        total_decoded_signals += summary.decoded_count;
    }
    let elapsed = start.elapsed();

    assert_eq!(
        total_decoded_signals,
        (7 + 6 + 11 + 6 + 8) * (TOTAL_FRAMES / 5)
    );

    let secs = elapsed.as_secs_f64().max(1e-9);
    let fps = (TOTAL_FRAMES as f64) / secs;
    println!(
        "[QA BENCHMARK] Decoded {} mixed CAN/CAN-FD/J1939/Mux frames ({} signals) in {:.3} ms ({:.0} frames/sec)",
        TOTAL_FRAMES,
        total_decoded_signals,
        elapsed.as_secs_f64() * 1000.0,
        fps
    );

    assert!(
        fps > 50_000.0,
        "Throughput {:.0} fps fell below 50,000 fps minimum gate!",
        fps
    );

    #[cfg(not(debug_assertions))]
    assert!(
        elapsed.as_millis() < 25,
        "Release decode of 100,000 frames took {:?} (>= 25 ms gate)",
        elapsed
    );
}
