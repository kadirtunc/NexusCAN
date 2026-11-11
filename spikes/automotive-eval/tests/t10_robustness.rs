//! Madde 10: Yanıtsız ECU, bozuk/beklenmeyen yanıtlar, panik, "ECU başına tek bekleyen istek".
use automotive::protocols::uds::{RequestOutcome, UDSClient, UDSConfig};
use automotive::transports::isotp::{IsoTP, IsoTPConfig};
use automotive_eval::*;
use std::time::{Duration, Instant};

#[tokio::test]
async fn t10_no_response_and_absent_ecu() {
    let ecu = EcuSim::start("t10_noresp", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);
    let t = Instant::now();
    let err = uds.read_data_by_identifier(0xFA04u16).await.unwrap_err();
    println!("FA04 (ECU drops answer) -> {err:?} after {:?}", t.elapsed());
    assert!(matches!(err, automotive::Error::Timeout));
    assert!(t.elapsed() < Duration::from_millis(120));
    assert_eq!(ecu.events_of("tx_drop").len(), 1);

    let ghost = IsoTP::new(
        &adapter,
        IsoTPConfig::builder(id(0x6D0)).rx_id(id(0x6D8)).build().unwrap(),
    );
    let t = Instant::now();
    let err = UDSClient::new(&ghost).tester_present().await.unwrap_err();
    println!("absent ECU, single frame -> {err:?} after {:?}", t.elapsed());
    assert!(matches!(err, automotive::Error::Timeout));
}

#[tokio::test]
async fn t10_late_response_after_timeout_poisons_next_request() {
    let ecu = EcuSim::start("t10_late", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let tp = LoggingTransport::new(isotp);
    let uds = UDSClient::new(&tp);
    let e1 = uds.read_data_by_identifier(0xFA03u16).await.unwrap_err(); // 400 ms late
    tokio::time::sleep(Duration::from_millis(300)).await; // < 400 ms
    let r2 = uds.read_data_by_identifier(0xF190u16).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let r3 = uds.read_data_by_identifier(0xF190u16).await;
    print_pdu_log(&tp.take());
    println!("1st (FA03, P2 50 ms) -> {e1:?}");
    println!("2nd (F190 at +350 ms) -> {r2:?}");
    println!("3rd (F190 at +600 ms) -> {r3:?}");
    println!("ECU rx: {:?}", ecu.rx_data());
    // Observed with ecusim (sequential server): the late 62FA0303 arrives inside
    // the 2nd request's window -> strict mode fails with InvalidDataIdentifier
    // instead of skipping it. The client then drops its stream, so the ECU's
    // multi-frame F190 answer gets no FC; the ECU sender blocks for N_Bs and the
    // 3rd request also fails (ecusim: isotp_error errno 70).
    assert!(matches!(
        r2,
        Err(automotive::Error::UDSError(automotive::protocols::uds::Error::ProtocolDeviation { .. }))
    ));
    assert!(r3.is_err());
    assert_eq!(ecu.events_of("isotp_error").len(), 0, "error is logged later, at N_Bs expiry");
}

/// Same scenario through the PersistentTransport work-around.
#[test]
fn t10_late_response_with_persistent_transport() {
    let ecu = EcuSim::start("t10_late_persistent", "default", CLASSIC, false);
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let local = tokio::task::LocalSet::new();
    local.block_on(&rt, async {
        let adapter = std::sync::Arc::new(adapter());
        let isotp = std::sync::Arc::new(IsoTP::new_owned(adapter, isotp_config(CLASSIC, false)));
        let tp = PersistentTransport::spawn_local(isotp);
        let uds = UDSClient::new(&tp);
        let e1 = uds.read_data_by_identifier(0xFA03u16).await.unwrap_err();
        tokio::time::sleep(Duration::from_millis(300)).await;
        let r2 = uds.read_data_by_identifier(0xF190u16).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        let r3 = uds.read_data_by_identifier(0xF190u16).await;
        let stale: Vec<String> = tp.stale.lock().unwrap().iter().map(hex::encode_upper).collect();
        println!("1st -> {e1:?}\n2nd -> {r2:?}\n3rd -> {r3:?}\nstale PDUs dropped: {stale:?}");
        assert!(matches!(e1, automotive::Error::Timeout));
        // ecusim serves requests sequentially: the 2nd one is answered only after
        // the delayed FA03, ~50-65 ms after we sent it (right at P2). So it is
        // either a P2 timeout or the correct VIN -- never a deviation/wrong data.
        match &r2 {
            Ok(v) => assert_eq!(v, b"WNX0ECUSIM0000017"),
            Err(e) => assert!(matches!(e, automotive::Error::Timeout), "{e:?}"),
        }
        // ...but the cascade is gone: the late F190 answer was still reassembled
        // (FC sent) by the persistent receiver, so the ECU is not blocked.
        assert_eq!(r3.unwrap(), b"WNX0ECUSIM0000017");
        assert_eq!(stale, vec!["62FA0303"]);
    });
    assert!(ecu.events_of("isotp_error").is_empty());
}

#[tokio::test]
async fn t10_two_concurrent_requests_cross_talk() {
    let _ecu = EcuSim::start("t10_concurrent", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    for strict in [true, false] {
        let uds = UDSClient::with_config(
            &isotp,
            UDSConfig::builder()
                .strict(strict)
                .p2_timeout(Duration::from_millis(300))
                .build(),
        );
        let (a, b) = tokio::join!(
            uds.read_data_by_identifier(0xF190u16),
            uds.read_data_by_identifier(0xF18Cu16)
        );
        let show = |r: &automotive::Result<Vec<u8>>| match r {
            Ok(v) => format!("Ok({:?})", String::from_utf8_lossy(v)),
            Err(e) => format!("Err({e})"),
        };
        println!("strict={strict}: F190 -> {}   F18C -> {}", show(&a), show(&b));
        let a_ok = a.as_ref().is_ok_and(|v| v == b"WNX0ECUSIM0000017");
        let b_ok = b.as_ref().is_ok_and(|v| v == b"SN0000000042");
        if !strict {
            // non-strict: one of them silently returns the OTHER DID's data.
            assert!(!(a_ok && b_ok), "expected cross-talk");
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

fn short(e: &automotive::Error) -> String {
    let s = e.to_string();
    s.split("; response").next().unwrap_or(&s).to_string()
}

struct Case {
    name: &'static str,
    frames: Vec<(u64, Vec<u8>)>,
}

fn pad(mut v: Vec<u8>) -> Vec<u8> {
    v.resize(8, 0xAA);
    v
}

#[tokio::test]
async fn t10_malformed_responses_never_panic() {
    let adapter = adapter();
    let ecu_side = automotive_eval::adapter();
    let cfg = IsoTPConfig::builder(id(0x6E0))
        .rx_id(id(0x6E8))
        .timeout(Duration::from_millis(300))
        .build()
        .unwrap();
    let isotp = IsoTP::new(&adapter, cfg);
    let uds = UDSClient::with_config(
        &isotp,
        UDSConfig::builder()
            .p2_timeout(Duration::from_millis(300))
            .p2_star_timeout(Duration::from_millis(400))
            .build(),
    );
    let cases = vec![
        Case { name: "RDBI too short (62 F1)", frames: vec![(1, pad(vec![0x02, 0x62, 0xF1]))] },
        Case { name: "NRC 2 bytes (7F 22)", frames: vec![(1, pad(vec![0x02, 0x7F, 0x22]))] },
        Case { name: "NRC for other SID (7F 2E 31)", frames: vec![(1, pad(vec![0x03, 0x7F, 0x2E, 0x31]))] },
        Case { name: "wrong DID echo (62 F191)", frames: vec![(1, pad(vec![0x05, 0x62, 0xF1, 0x91, 0x41, 0x41]))] },
        Case { name: "wrong positive SID (50 ..)", frames: vec![(1, pad(vec![0x03, 0x50, 0x01, 0x02]))] },
        Case { name: "SF length nibble 0 (classic)", frames: vec![(1, vec![0x00, 0x62, 0xF1, 0x90, 0x41, 0x41, 0x41, 0x41])] },
        Case { name: "SF_DL 7 but DLC 3", frames: vec![(1, vec![0x07, 0x62, 0xF1])] },
        Case { name: "CF without FF", frames: vec![(1, pad(vec![0x21, 0x41]))] },
        Case {
            name: "CF wrong SN",
            frames: vec![
                (1, vec![0x10, 0x14, 0x62, 0xF1, 0x90, 0x41, 0x41, 0x41]),
                (1, vec![0x22, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41]),
            ],
        },
        Case { name: "FF 4095 B then silence", frames: vec![(1, vec![0x1F, 0xFF, 0x62, 0xF1, 0x90, 0x41, 0x41, 0x41])] },
        Case { name: "FF length < 8 (invalid)", frames: vec![(1, vec![0x10, 0x05, 0x62, 0xF1, 0x90, 0x41, 0x41, 0x41])] },
        Case {
            name: "0x78 then NRC 0x31",
            frames: vec![(1, pad(vec![0x03, 0x7F, 0x22, 0x78])), (50, pad(vec![0x03, 0x7F, 0x22, 0x31]))],
        },
        Case {
            name: "0x78 then silence (> P2*)",
            frames: vec![(1, pad(vec![0x03, 0x7F, 0x22, 0x78]))],
        },
        Case { name: "empty frame (DLC 0)", frames: vec![(1, vec![])] },
        Case {
            name: "unknown NRC 0x93",
            frames: vec![(1, pad(vec![0x03, 0x7F, 0x22, 0x93]))],
        },
    ];
    println!("{:<32} | result", "case");
    for c in cases {
        let t = Instant::now();
        let (res, _) = tokio::join!(
            async {
                let r = uds.read_data_by_identifier(0xF190u16).await;
                (r, t.elapsed())
            },
            fake_ecu(&ecu_side, 0x6E0, 0x6E8, c.frames, Duration::from_millis(50))
        );
        let (r, took) = res;
        println!("{:<32} | {:?} ({} ms)", c.name, r, took.as_millis());
        assert!(r.is_err(), "{}: malformed answer must not succeed", c.name);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // Positive response to a suppressed request
    let suppressed = uds.suppress_positive_responses();
    let (r, _) = tokio::join!(
        suppressed.tester_present(),
        fake_ecu(&ecu_side, 0x6E0, 0x6E8, vec![(1, pad(vec![0x02, 0x7E, 0x00]))], Duration::from_millis(50))
    );
    println!("{:<32} | {:?}", "positive answer to 3E 80", r);
    assert!(r.is_err());
}

#[tokio::test]
async fn t10_sender_flow_control_wait_overflow_invalid_reserved() {
    let adapter = adapter();
    let ecu_side = automotive_eval::adapter();
    let cfg = IsoTPConfig::builder(id(0x6E0))
        .rx_id(id(0x6E8))
        .timeout(Duration::from_millis(300))
        .build()
        .unwrap();
    let isotp = IsoTP::new(&adapter, cfg);
    let payload = vec![0x2E; 20]; // FF + 2 CF
    let cases: Vec<(&str, Vec<(u64, Vec<u8>)>)> = vec![
        ("FC WAIT x3 (200 ms apart) then CTS", vec![
            (1, pad(vec![0x31, 0, 0])), (200, pad(vec![0x31, 0, 0])),
            (200, pad(vec![0x31, 0, 0])), (200, pad(vec![0x30, 0, 0]))]),
        ("FC OVERFLOW", vec![(1, pad(vec![0x32, 0, 0]))]),
        ("FC invalid flow status 3", vec![(1, pad(vec![0x33, 0, 0]))]),
        ("FC reserved STmin 0xFA", vec![(1, pad(vec![0x30, 0, 0xFA]))]),
    ];
    for (name, frames) in cases {
        let t = Instant::now();
        let (r, seen) = tokio::join!(
            async {
                let r = isotp.send(&payload).await;
                (r, t.elapsed())
            },
            fake_ecu(&ecu_side, 0x6E0, 0x6E8, frames, Duration::from_millis(400))
        );
        let cfs = seen.iter().filter(|d| d[0] >> 4 == 2).count();
        println!("{name:<36} | {:?} after {} ms; CFs sent = {cfs}", r.0, r.1.as_millis());
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Naive background TesterPresent WITHOUT serialization: shares the client
/// with a foreground multi-frame transfer -> responses are mixed up.
#[tokio::test]
async fn t10_naive_concurrent_keepalive_breaks_foreground() {
    let ecu = EcuSim::start("t10_naive_tp", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::with_config(&isotp, UDSConfig::builder().p2_timeout(Duration::from_millis(200)).build());
    let mut fg_err = 0;
    let mut tp_err = 0;
    for _ in 0..20 {
        let (a, b) = tokio::join!(
            uds.read_data_by_identifier(0xF1F1u16),
            async {
                tokio::time::sleep(Duration::from_micros(500)).await;
                uds.tester_present().await
            }
        );
        if a.is_err() { fg_err += 1; }
        if b.is_err() { tp_err += 1; }
        if let Err(e) = &a { println!("foreground: {}", short(e)); }
        if let Err(e) = &b { println!("tester_present: {}", short(e)); }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    println!("20 rounds: foreground errors = {fg_err}, tester_present errors = {tp_err}");
    println!("ECU isotp errors: {}", ecu.events_of("isotp_error").len());
    assert!(fg_err + tp_err > 0, "expected interference");
}

#[tokio::test]
async fn t10_raw_request_suppressed_outcome() {
    let _ecu = EcuSim::start("t10_raw", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);
    // A service without sub-function never yields Suppressed.
    let r = uds.request(0x22u8, None, Some(&[0xF1, 0x86])).await.unwrap();
    assert_eq!(r, RequestOutcome::PositiveResponse(vec![0xF1, 0x86, 0x01]));
}

/// Each `IsoTP::recv()` stream reassembles on its own and sends its own FC.
/// A second live receiver on the same rx id (e.g. an observer) => duplicate FCs.
#[tokio::test]
async fn t10_second_receiver_duplicates_flow_control() {
    use automotive::StreamExt;
    let _ecu = EcuSim::start("t10_dupfc", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);
    let dump = Candump::start("t10_dupfc", &[CLASSIC.req, CLASSIC.resp]);
    let observer = isotp.recv();
    let mut observer = std::pin::pin!(observer);
    let (vin, seen) = tokio::join!(
        uds.read_data_by_identifier(0xF190u16),
        tokio::time::timeout(Duration::from_millis(200), observer.next())
    );
    let f = dump.stop();
    print_capture(&f, 10);
    let fcs = f.iter().filter(|l| l.id == CLASSIC.req && l.data[0] == 0x30).count();
    println!("VIN={:?} observer got {:?}; FCs on bus = {fcs}", vin.is_ok(), seen.map(|s| s.map(|r| r.map(|v| v.len()))));
    assert_eq!(fcs, 2, "one FC per live receive stream");
}

/// Compile-time probe: are the crate futures Send (needed for tokio::spawn on
/// Tauri's multi-threaded runtime)?
#[allow(dead_code)]
fn send_probe(uds: &'static UDSClient<'static, IsoTP<'static>>) {
    fn assert_send<T: Send>(_: &T) {}
    let f = uds.read_data_by_identifier(0xF190u16);
    assert_send(&f);
    let g = uds.request(0x22u8, None, Some(&[0xF1, 0x90]));
    assert_send(&g);
}
