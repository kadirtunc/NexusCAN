//! Madde 1: VIN (çok çerçeveli), 0x10 oturum geçişleri, 0x3E (bastırma biti), 0x11.
use automotive::protocols::uds::{DataIdentifier, ResetType, SessionType, UDSClient};
use automotive::transports::isotp::IsoTP;
use automotive_eval::*;
use std::time::Duration;

#[tokio::test]
async fn t01_vin_multiframe_response() {
    assert_user_ecu_alive();
    let ecu = EcuSim::start("t01_vin", "default", CLASSIC, false);
    let dump = Candump::start("t01_vin", &[CLASSIC.req, CLASSIC.resp]);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);

    let vin = uds.read_data_by_identifier(DataIdentifier::Vin).await.unwrap();
    let frames = dump.stop();
    print_capture(&frames, 20);
    assert_eq!(vin, b"WNX0ECUSIM0000017");
    // FF + FC + 2 CF on the bus: response really was multi-frame.
    assert!(frames.iter().any(|f| f.id == CLASSIC.resp && f.data[0] == 0x10));
    assert!(frames.iter().any(|f| f.id == CLASSIC.req && f.data[0] == 0x30));
    assert_eq!(ecu.rx_data(), vec!["22F190"]);
}

#[tokio::test]
async fn t01_session_transitions_and_timing_record() {
    let ecu = EcuSim::start("t01_session", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);
    let active = || async { uds.read_data_by_identifier(0xF186u16).await.unwrap()[0] };

    // 1 -> 3: typed result carries P2/P2* reported by the ECU.
    let rec = uds
        .diagnostic_session_control(SessionType::ExtendedDiagnostic)
        .await
        .unwrap()
        .expect("timing record");
    println!("0x10 03 -> {rec:?}");
    assert_eq!(rec.p2_server_max, Duration::from_millis(50));
    assert_eq!(rec.p2_star_server_max, Duration::from_millis(2000));
    assert_eq!(active().await, 0x03);

    // 3 -> 2 (allowed only from 2/3)
    uds.diagnostic_session_control(SessionType::Programming).await.unwrap();
    assert_eq!(active().await, 0x02);

    // 2 -> 1
    uds.diagnostic_session_control(SessionType::Default).await.unwrap();
    assert_eq!(active().await, 0x01);

    // 1 -> 2 is forbidden by config -> NRC 0x22 surfaces as typed error.
    let err = uds
        .diagnostic_session_control(SessionType::Programming)
        .await
        .unwrap_err();
    println!("0x10 02 from default -> {err}");
    assert_eq!(nrc_of(&err), Some(0x22));

    // Unknown session 0x04 -> 0x12. Raw u8 accepted.
    let err = uds.diagnostic_session_control(0x04u8).await.unwrap_err();
    println!("0x10 04 -> {err}");
    assert_eq!(nrc_of(&err), Some(0x12));

    let sessions: Vec<_> = ecu
        .events_of("session")
        .iter()
        .map(|e| format!("{}->{}", e["from"], e["to"]))
        .collect();
    println!("ECU session events: {sessions:?}");
    assert_eq!(sessions.len(), 3);
}

#[tokio::test]
async fn t01_tester_present_with_and_without_suppress() {
    let ecu = EcuSim::start("t01_tp", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);

    uds.tester_present().await.unwrap();
    let t = std::time::Instant::now();
    uds.suppress_positive_responses().tester_present().await.unwrap();
    let waited = t.elapsed();
    println!("suppressed 3E 80 returned after {waited:?} (client waits the P2 window)");
    assert!(waited >= Duration::from_millis(45));

    // Raw API: RequestOutcome distinguishes silence.
    let out = uds.request(0x3Eu8, Some(0x80), None).await.unwrap();
    println!("raw 3E 80 -> {out:?}");
    assert_eq!(out, automotive::protocols::uds::RequestOutcome::Suppressed);

    std::thread::sleep(Duration::from_millis(50));
    let rx = ecu.rx_data();
    let tx: Vec<_> = ecu.events_of("tx").iter().map(|e| e["data"].to_string()).collect();
    println!("ECU rx={rx:?} tx={tx:?}");
    assert_eq!(rx, vec!["3E00", "3E80", "3E80"]);
    assert_eq!(tx.len(), 1, "only the non-suppressed 3E 00 is answered");
}

#[tokio::test]
async fn t01_ecu_reset() {
    let ecu = EcuSim::start("t01_reset", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);

    uds.diagnostic_session_control(SessionType::ExtendedDiagnostic).await.unwrap();
    let r = uds.ecu_reset(ResetType::HardReset).await.unwrap();
    assert_eq!(r, None);
    // Requests during the 100 ms power-down window are dropped by the ECU.
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(uds.read_data_by_identifier(0xF186u16).await.unwrap(), vec![0x01]);

    // Suppressed soft reset
    // Soft reset (0x03). The crate enum spells this variant `ResetType::SoftRest`.
    let r = uds.suppress_positive_responses().ecu_reset(0x03u8).await.unwrap();
    assert_eq!(r, None);
    tokio::time::sleep(Duration::from_millis(250)).await;
    let resets = ecu.events_of("ecu_reset");
    println!("ECU reset events: {resets:?}");
    assert_eq!(resets.len(), 2);
    // Unsupported reset type 0x05 -> 0x12
    let err = uds.ecu_reset(0x05u8).await.unwrap_err();
    assert_eq!(nrc_of(&err), Some(0x12));
}
