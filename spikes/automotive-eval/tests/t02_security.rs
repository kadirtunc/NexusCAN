//! Madde 2: 0x27 seviye 1 ve 0x11, anahtar nexus-protocols sağlayıcısıyla.
//! 0x35 / 0x36 / 0x37 NRC'lerinin istemcide nasıl yüzeye çıktığı.
use automotive::protocols::uds::{self, NegativeResponseCode, SessionType, UDSClient};
use automotive::transports::isotp::IsoTP;
use automotive_eval::*;
use std::time::Duration;

#[tokio::test]
async fn t02_level1_xor_const_via_nexus_provider() {
    let ecu = EcuSim::start("t02_l1", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);

    uds.diagnostic_session_control(SessionType::ExtendedDiagnostic).await.unwrap();
    let (seed, key) = unlock(&uds, 0x01, &spec_xor_const("A5A5A5A5")).await.unwrap();
    println!("seed={} key={}", hex::encode_upper(&seed), hex::encode_upper(&key));
    assert_eq!(seed, [0x11, 0x22, 0x33, 0x44]);
    assert_eq!(key, [0xB4, 0x87, 0x96, 0xE1]);
    assert_eq!(ecu.events_of("security_unlocked").len(), 1);
    // Protected DID 0x0101 now readable.
    assert_eq!(uds.read_data_by_identifier(0x0101u16).await.unwrap(), [0xCA, 0xFE, 0xBA, 0xBE]);
}

#[tokio::test]
async fn t02_level_0x11_xor_ff_counter_seed() {
    let ecu = EcuSim::start("t02_l11", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);

    uds.diagnostic_session_control(SessionType::ExtendedDiagnostic).await.unwrap();
    uds.diagnostic_session_control(SessionType::Programming).await.unwrap();
    let (seed, key) = unlock(&uds, 0x11, &spec_xor_ff()).await.unwrap();
    println!("seed={} key={}", hex::encode_upper(&seed), hex::encode_upper(&key));
    assert_eq!(seed.len(), 4);
    assert_eq!(ecu.events_of("security_unlocked").len(), 1);
    // Already unlocked: ECU returns a zero seed; the client just returns it.
    let again = uds.security_access(0x11u8, None).await.unwrap().unwrap();
    println!("requestSeed while unlocked -> {}", hex::encode_upper(&again));
    assert!(again.iter().all(|&b| b == 0));
}

#[tokio::test]
async fn t02_invalid_key_attempt_limit_and_delay() {
    let ecu = EcuSim::start("t02_nrc", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);
    uds.diagnostic_session_control(SessionType::ExtendedDiagnostic).await.unwrap();

    let mut seen = Vec::new();
    for attempt in 1..=3 {
        uds.security_access(0x01u8, None).await.unwrap();
        let err = uds.security_access(0x02u8, Some(&[0, 0, 0, 0])).await.unwrap_err();
        println!("attempt {attempt}: Display=`{err}` Debug={err:?}");
        // Typed error: automotive::Error::UDSError(uds::Error::NegativeResponse(code))
        match &err {
            automotive::Error::UDSError(uds::Error::NegativeResponse(code)) => seen.push(*code),
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!(
        seen,
        [
            NegativeResponseCode::InvalidKey,
            NegativeResponseCode::InvalidKey,
            NegativeResponseCode::ExeedNumberOfAttempts
        ]
    );
    // During lockout_ms (1500) -> 0x37
    let err = uds.security_access(0x01u8, None).await.unwrap_err();
    println!("during lockout: {err}");
    assert_eq!(nrc_of(&err), Some(0x37));
    assert!(matches!(
        err,
        automotive::Error::UDSError(uds::Error::NegativeResponse(
            NegativeResponseCode::RequiredTimeDelayNotExpired
        ))
    ));
    // After lockout the correct key works again.
    tokio::time::sleep(Duration::from_millis(1600)).await;
    unlock(&uds, 0x01, &spec_xor_const("A5A5A5A5")).await.unwrap();
    println!(
        "ECU events: invalid={} lockout={} lockout_end={} unlocked={}",
        ecu.events_of("security_invalid_key").len(),
        ecu.events_of("security_lockout").len(),
        ecu.events_of("security_lockout_end").len(),
        ecu.events_of("security_unlocked").len()
    );
    // Unknown NRCs are preserved: NonStandard(x). Show the enum API.
    assert_eq!(NegativeResponseCode::from_raw(0x93).as_raw(), 0x93);
    println!("NonStandard example: {:?}", NegativeResponseCode::from_raw(0x93));
}

#[tokio::test]
async fn t02_wrong_session_gives_0x7f_typed() {
    let _ecu = EcuSim::start("t02_sess", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);
    let err = uds.security_access(0x01u8, None).await.unwrap_err();
    println!("0x27 in default session -> {err}");
    assert_eq!(nrc_of(&err), Some(0x7F));
}

/// The typed helper panics (instead of returning an error) when sendKey has no data.
#[tokio::test]
#[should_panic(expected = "Missing data parameter when sending key")]
async fn t02_send_key_without_data_panics() {
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);
    let _ = uds.security_access(0x02u8, None).await;
}
