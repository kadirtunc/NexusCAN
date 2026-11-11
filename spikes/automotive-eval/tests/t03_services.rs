//! Madde 3: 0x22 çoklu DID, 0x2E, 0x2F, 0x31, 0x28, 0x85, 0x14, 0x19 (01/02/04/06/0A), 0x23.
//! Tipli yardımcısı olmayan servisler `UDSClient::request(sid, sub, data)` ile gönderilir.
use automotive::protocols::uds::{RequestOutcome, RoutineControlType, SessionType, UDSClient};
use automotive::transports::isotp::IsoTP;
use automotive_eval::*;

fn positive(out: RequestOutcome<Vec<u8>>) -> Vec<u8> {
    match out {
        RequestOutcome::PositiveResponse(d) => d,
        RequestOutcome::Suppressed => panic!("unexpected suppression"),
    }
}

#[tokio::test]
async fn t03_rdbi_multi_did_raw() {
    let ecu = EcuSim::start("t03_multi", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);

    // Typed helper takes exactly one DID (documented: multi-DID not supported).
    // Raw request: 22 F190 F18C 1234(unsupported) F186
    let data = positive(
        uds.request(0x22u8, None, Some(&[0xF1, 0x90, 0xF1, 0x8C, 0x12, 0x34, 0xF1, 0x86]))
            .await
            .unwrap(),
    );
    println!("raw 0x22 multi -> {}", hex::encode_upper(&data));
    // Caller must split records itself (needs DID length knowledge).
    let mut expected = vec![0xF1, 0x90];
    expected.extend(b"WNX0ECUSIM0000017");
    expected.extend([0xF1, 0x8C]);
    expected.extend(b"SN0000000042");
    expected.extend([0xF1, 0x86, 0x01]);
    assert_eq!(data, expected);
    assert_eq!(ecu.rx_data(), vec!["22F190F18C1234F186"]);
}

#[tokio::test]
async fn t03_wdbi_and_io_control() {
    let ecu = EcuSim::start("t03_write", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);

    uds.diagnostic_session_control(SessionType::ExtendedDiagnostic).await.unwrap();
    // 0x2E typed
    uds.write_data_by_identifier(0xF1A0u16, &[1, 2, 3, 4]).await.unwrap();
    assert_eq!(uds.read_data_by_identifier(0xF1A0u16).await.unwrap(), [1, 2, 3, 4]);
    // wrong length -> 0x13
    let err = uds.write_data_by_identifier(0xF1A0u16, &[1]).await.unwrap_err();
    assert_eq!(nrc_of(&err), Some(0x13));
    // VIN needs security level 1 -> 0x33
    let err = uds.write_data_by_identifier(0xF190u16, b"XXXXXXXXXXXXXXXXX").await.unwrap_err();
    assert_eq!(nrc_of(&err), Some(0x33));

    // 0x2F: no typed helper. 2F 0100 03(shortTermAdjustment) 55
    let r = positive(uds.request(0x2Fu8, None, Some(&[0x01, 0x00, 0x03, 0x55])).await.unwrap());
    println!("0x2F short term adjust -> {}", hex::encode_upper(&r));
    assert_eq!(&r[..3], &[0x01, 0x00, 0x03]);
    // 2F 0100 00 (returnControlToECU)
    let r = positive(uds.request(0x2Fu8, None, Some(&[0x01, 0x00, 0x00])).await.unwrap());
    println!("0x2F return control -> {}", hex::encode_upper(&r));
    println!("ECU io_control events: {:?}", ecu.events_of("io_control"));
    assert_eq!(ecu.events_of("did_written").len(), 1);
    assert_eq!(ecu.events_of("io_control").len(), 2);
}

#[tokio::test]
async fn t03_routine_control_start_stop_results() {
    let ecu = EcuSim::start("t03_rc", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);

    uds.diagnostic_session_control(SessionType::ExtendedDiagnostic).await.unwrap();
    let s = uds.routine_control(RoutineControlType::Start, 0x0203u16, None).await.unwrap();
    let p = uds.routine_control(RoutineControlType::Stop, 0x0203u16, None).await.unwrap();
    let r = uds
        .routine_control(RoutineControlType::RequestResults, 0x0203u16, None)
        .await
        .unwrap();
    println!("0x31 0203 start={s:02X?} stop={p:02X?} results={r:02X?}");
    assert_eq!(s, Some(vec![0x00]));
    assert_eq!(p, Some(vec![0x01]));
    assert_eq!(r, Some(vec![0xAA, 0x55]));
    // Routine needs security 1 -> 0x33
    let err = uds.routine_control(1u8, 0x0204u16, None).await.unwrap_err();
    assert_eq!(nrc_of(&err), Some(0x33));
    // FA05 returns 0x21 busyRepeatRequest twice: client does NOT retry, caller must.
    let e1 = uds.routine_control(1u8, 0xFA05u16, None).await.unwrap_err();
    let e2 = uds.routine_control(1u8, 0xFA05u16, None).await.unwrap_err();
    let ok = uds.routine_control(1u8, 0xFA05u16, None).await.unwrap();
    println!("FA05: {e1} / {e2} / {ok:02X?}");
    assert_eq!((nrc_of(&e1), nrc_of(&e2)), (Some(0x21), Some(0x21)));
    println!("ECU routine events: {}", ecu.events_of("routine").len());
}

#[tokio::test]
async fn t03_comm_control_dtc_setting_clear() {
    let ecu = EcuSim::start("t03_ctl", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);
    uds.diagnostic_session_control(SessionType::ExtendedDiagnostic).await.unwrap();

    // 0x28 03 01: disableRxAndTx, normal messages (no typed helper)
    let r = positive(uds.request(0x28u8, Some(0x03), Some(&[0x01])).await.unwrap());
    println!("0x28 03 01 -> {r:02X?}");
    // 0x28 with suppress bit
    let out = uds.request(0x28u8, Some(0x80), Some(&[0x01])).await.unwrap();
    assert_eq!(out, RequestOutcome::Suppressed);
    // 0x85 02 (DTC setting off), then 01
    positive(uds.request(0x85u8, Some(0x02), None).await.unwrap());
    positive(uds.request(0x85u8, Some(0x01), None).await.unwrap());
    // 0x14 FFFFFF: no sub-function, groupOfDTC 3 bytes
    let r = positive(uds.request(0x14u8, None, Some(&[0xFF, 0xFF, 0xFF])).await.unwrap());
    assert!(r.is_empty());
    // Afterwards: 19 02 FF reports all status 00 -> no DTC with status bits set
    let r = positive(uds.request(0x19u8, Some(0x02), Some(&[0xFF])).await.unwrap());
    println!("0x19 02 FF after clear -> {}", hex::encode_upper(&r));
    assert_eq!(r, vec![0xFF], "only the availability mask remains");
    println!(
        "ECU: comm_ctrl={} dtc_setting={} dtc_cleared={}",
        ecu.events_of("comm_ctrl").len(),
        ecu.events_of("dtc_setting").len(),
        ecu.events_of("dtc_cleared").len()
    );
    assert_eq!(ecu.events_of("comm_ctrl").len(), 2);
}

#[tokio::test]
async fn t03_read_dtc_information_subfunctions() {
    let _ecu = EcuSim::start("t03_dtc", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);

    // 0x01: the only typed 0x19 helper
    let n = uds.read_dtc_information_number_of_dtc_by_status_mask(0xFF).await.unwrap();
    println!("19 01 FF -> {n:?}");
    assert_eq!(n.dtc_count, 2, "DTCs with status != 0 matching FF");

    // 0x02: raw; caller parses [mask, (DTC3 status)*]
    let r = positive(uds.request(0x19u8, Some(0x02), Some(&[0xFF])).await.unwrap());
    println!("19 02 FF -> {}", hex::encode_upper(&r));
    let dtcs: Vec<(u32, u8)> = r[1..]
        .chunks(4)
        .map(|c| (u32::from_be_bytes([0, c[0], c[1], c[2]]), c[3]))
        .collect();
    println!("   parsed {dtcs:06X?}");
    assert_eq!(dtcs, vec![(0x012345, 0x2F), (0x9A0B00, 0x08)]);

    // 0x04: snapshot record 01 of 0x012345
    let r = positive(uds.request(0x19u8, Some(0x04), Some(&[0x01, 0x23, 0x45, 0x01])).await.unwrap());
    println!("19 04 012345 01 -> {}", hex::encode_upper(&r));
    assert_eq!(hex::encode_upper(&r), "0123452F0102100112341002" .to_string() + "56");

    // 0x06: extended data record FF (all)
    let r = positive(uds.request(0x19u8, Some(0x06), Some(&[0x01, 0x23, 0x45, 0xFF])).await.unwrap());
    println!("19 06 012345 FF -> {}", hex::encode_upper(&r));
    assert_eq!(hex::encode_upper(&r), "0123452F01050210");

    // 0x0A: supported DTCs
    let r = positive(uds.request(0x19u8, Some(0x0A), None).await.unwrap());
    println!("19 0A -> {}", hex::encode_upper(&r));
    assert_eq!(hex::encode_upper(&r), "FF0123452F9A0B0008400100" .to_string() + "00");

    // unsupported 0x19 sub-function -> 0x12
    let err = uds.request(0x19u8, Some(0x14), None).await.unwrap_err();
    assert_eq!(nrc_of(&err), Some(0x12));
}

#[tokio::test]
async fn t03_read_memory_by_address() {
    let _ecu = EcuSim::start("t03_rmba", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);

    // Typed helper with numeric address/size and explicit widths (ALFID 0x14).
    let r = uds.read_memory_by_address_alfid(0x0001_0000, 16, 4, 1).await.unwrap();
    println!("23 14 00010000 10 -> {}", hex::encode_upper(&r));
    assert_eq!(hex::encode_upper(&r), "00112233445566778899AABBCCDDEEFF");
    // Out of region -> 0x31
    let err = uds.read_memory_by_address_alfid(0x0002_0000, 4, 4, 1).await.unwrap_err();
    assert_eq!(nrc_of(&err), Some(0x31));
    // Value does not fit -> error before sending (no panic)
    let err = uds.read_memory_by_address_alfid(0x1_0000_0000, 4, 4, 1).await.unwrap_err();
    println!("overflow -> {err}");
}

/// The byte-slice variant asserts (panics) on an empty or >15-byte address.
#[tokio::test]
#[should_panic]
async fn t03_read_memory_by_address_empty_address_panics() {
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);
    let _ = uds.read_memory_by_address(&[], &[1]).await;
}
