//! Madde 5: NRC 0x78 responsePending, P2/P2* ayarları ve varsayılanlar.
use automotive::protocols::uds::{SessionType, UDSClient, UDSConfig};
use automotive::transports::isotp::IsoTP;
use automotive_eval::*;
use std::time::{Duration, Instant};

#[tokio::test]
async fn t05_defaults() {
    let c = UDSConfig::default();
    println!("UDSConfig::default() = {c:?}");
    assert_eq!(c.p2_timeout, Duration::from_millis(50));
    assert_eq!(c.p2_star_timeout, Duration::from_secs(5));
    assert!(c.request_timeout.is_none());
    assert!(c.use_server_timing && c.strict);
}

#[tokio::test]
async fn t05_pending_x2_and_x5_waits_through_p2_star() {
    let ecu = EcuSim::start("t05_pending", "eval.json", CLASSIC, false);
    let adapter = adapter();
    let isotp = LoggingTransport::new(IsoTP::new(&adapter, isotp_config(CLASSIC, false)));
    let uds = UDSClient::new(&isotp);

    let t = Instant::now();
    assert_eq!(uds.read_data_by_identifier(0xFA02u16).await.unwrap(), [0xC0, 0xDE]);
    println!("FA02 (2x 0x78) done in {:?}", t.elapsed());
    print_pdu_log(&isotp.take());

    // Server reports P2*=2000 ms in the 0x10 response; client adopts it.
    uds.diagnostic_session_control(SessionType::ExtendedDiagnostic).await.unwrap();
    isotp.take();
    let t = Instant::now();
    assert_eq!(uds.read_data_by_identifier(0xFA07u16).await.unwrap(), [0x07]);
    let took = t.elapsed();
    println!("FA07 (5x 0x78, 600 ms apart) done in {took:?}");
    let log = isotp.take();
    print_pdu_log(&log);
    let pendings = log.iter().filter(|e| e.data == [0x7F, 0x22, 0x78]).count();
    assert_eq!(pendings, 5);
    assert!(took > Duration::from_millis(2350), "5 pendings = 4 x 600 ms gaps");
    assert_eq!(ecu.events_of("fault").len(), 2);
}

#[tokio::test]
async fn t05_p2_star_expiry_and_overall_request_timeout() {
    let _ecu = EcuSim::start("t05_p2star", "eval.json", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));

    // P2* shorter than the ECU's 600 ms pending interval -> Timeout after first 0x78.
    let cfg = UDSConfig::builder()
        .p2_star_timeout(Duration::from_millis(300))
        .use_server_timing(false)
        .build();
    let uds = UDSClient::with_config(&isotp, cfg);
    let t = Instant::now();
    let err = uds.read_data_by_identifier(0xFA07u16).await.unwrap_err();
    println!("P2*=300ms on FA07 -> {err:?} after {:?}", t.elapsed());
    assert!(matches!(err, automotive::Error::Timeout));
    assert!(t.elapsed() < Duration::from_millis(500));
    tokio::time::sleep(Duration::from_secs(4)).await; // let the ECU finish its chain

    // 12x 0x78 (~7 s) bounded by request_timeout(3 s).
    let cfg = UDSConfig::builder().request_timeout(Duration::from_secs(3)).build();
    let uds = UDSClient::with_config(&isotp, cfg);
    let t = Instant::now();
    let err = uds.read_data_by_identifier(0xFA08u16).await.unwrap_err();
    println!("request_timeout=3s on FA08 (12x 0x78) -> {err:?} after {:?}", t.elapsed());
    assert!(matches!(err, automotive::Error::Timeout));
    let e = t.elapsed();
    assert!(e >= Duration::from_secs(3) && e < Duration::from_millis(3300));
}

#[tokio::test]
async fn t05_slow_ecu_needs_larger_p2_and_server_timing_overrides_it() {
    let _ecu = EcuSim::start("t05_p2", "eval.json", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));

    // FA03: 400 ms delay, no 0x78. Default P2 = 50 ms -> Timeout.
    let uds = UDSClient::new(&isotp);
    let err = uds.read_data_by_identifier(0xFA03u16).await.unwrap_err();
    println!("default P2 on FA03 -> {err:?}");
    assert!(matches!(err, automotive::Error::Timeout));
    tokio::time::sleep(Duration::from_millis(500)).await;

    let cfg = UDSConfig::builder().p2_timeout(Duration::from_millis(600)).build();
    let uds = UDSClient::with_config(&isotp, cfg);
    assert_eq!(uds.read_data_by_identifier(0xFA03u16).await.unwrap(), [0x03]);
    // After 0x10 the ECU-reported P2 (50 ms) replaces our 600 ms (use_server_timing=true).
    uds.diagnostic_session_control(SessionType::ExtendedDiagnostic).await.unwrap();
    let err = uds.read_data_by_identifier(0xFA03u16).await.unwrap_err();
    println!("after 0x10 (server P2=50ms adopted) FA03 -> {err:?}");
    assert!(matches!(err, automotive::Error::Timeout));
}

#[tokio::test]
async fn t05_pending_forces_final_response_for_suppressed_request() {
    let _ecu = EcuSim::start("t05_spr", "eval.json", CLASSIC, false);
    let adapter = adapter();
    let isotp = LoggingTransport::new(IsoTP::new(&adapter, isotp_config(CLASSIC, false)));
    let uds = UDSClient::new(&isotp);
    uds.diagnostic_session_control(SessionType::ExtendedDiagnostic).await.unwrap();
    isotp.take();
    // 31 81 FA06 (suppress bit) + 1x 0x78 -> final positive response is mandatory.
    let r = uds
        .suppress_positive_responses()
        .routine_control(1u8, 0xFA06u16, None)
        .await
        .unwrap();
    print_pdu_log(&isotp.take());
    println!("suppressed 0x31 with 0x78 -> {r:02X?}");
    assert_eq!(r, Some(vec![0x00]));
}
