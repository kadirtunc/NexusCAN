//! UDS client (`UdsSession`) end-to-end against `tests/hil/ecusim` on vcan0.
//!
//! Run: `cargo test -p nexus-protocols --test uds_client_hil -- --test-threads=1 --nocapture`
//! Each test starts its own ecusim on test-only ids (0x7E2/0x7EA/0x7DE classic,
//! 0x7E3/0x7EB/0x7D8 CAN-FD) and stops it. Without vcan0 / ecusim the tests print `SKIP (HIL)`
//! and return early (environment check, not `#[ignore]`).
#![cfg(target_os = "linux")]

mod common;

use std::time::{Duration, Instant};

use common::{config, hil_env, serial, EcuSim, SocketCanPort, CLASSIC, FD};
use nexus_protocols::uds::client::UdsSession;
use nexus_protocols::uds::dto::{ConversationEventKind, DiagErrorCode, UdsAddressing, UdsRequestOptionsDto};
use nexus_protocols::uds::port::DiagTxReject;
use nexus_protocols::uds::security::{build_portable_provider, BuiltinAlgorithm, KeyProviderSpecDto, SeedKeyRequest};

fn opts() -> UdsRequestOptionsDto {
    UdsRequestOptionsDto::default()
}

fn open_classic(functional: bool) -> (UdsSession, common::Probe) {
    let (port, probe) = SocketCanPort::open(CLASSIC, false);
    let s = UdsSession::open(port, config(CLASSIC, false, functional)).expect("open session");
    (s, probe)
}

fn kinds(s: &UdsSession) -> Vec<ConversationEventKind> {
    s.conversation_since(0, 10_000).events.iter().map(|e| e.kind).collect()
}

fn xor_const_key(seed: &[u8]) -> Vec<u8> {
    let spec = KeyProviderSpecDto::Builtin { algorithm: BuiltinAlgorithm::XorConst, constant_hex: Some("A5A5A5A5".into()) };
    build_portable_provider(&spec).expect("provider").compute_key(&SeedKeyRequest { seed, level: 1 }).expect("key")
}

#[test]
fn session_transitions_and_reported_timing() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let _ecu = EcuSim::start("session", CLASSIC, false);
    let (s, _) = open_classic(false);

    let r = s.request(0x10, &[0x03], &opts()).expect("10 03");
    assert!(r.positive, "{r:?}");
    assert_eq!(&r.raw[..2], &[0x50, 0x03]);
    let info = s.info();
    assert_eq!(info.active_session, 3);
    assert_eq!(info.p2_server_ms, Some(50));
    assert_eq!(info.p2_star_server_ms, Some(2000));
    assert!(info.open);

    assert_eq!(s.read_did(0xF186).expect("F186").raw, vec![0x03]);
    assert!(s.request(0x10, &[0x02], &opts()).expect("10 02").positive);
    assert_eq!(s.info().active_session, 2);
    assert!(s.request(0x10, &[0x01], &opts()).expect("10 01").positive);
    assert_eq!(s.info().active_session, 1);

    // Programming only from extended: negative response is Ok(positive=false).
    let r = s.request(0x10, &[0x02], &opts()).expect("10 02 from default");
    assert!(!r.positive);
    assert_eq!(r.nrc, Some(0x22));
    assert_eq!(r.nrc_name.as_deref(), Some("conditionsNotMet"));
    assert_eq!(s.info().active_session, 1);

    // Suppressed positive response: silence within P2 is success.
    let r = s.request(0x3E, &[0x80], &opts()).expect("3E 80");
    assert!(r.suppressed && r.positive && r.raw.is_empty());

    // 0x11 positive resets the tracked state.
    assert!(s.request(0x10, &[0x03], &opts()).expect("10 03").positive);
    assert!(s.request(0x11, &[0x01], &opts()).expect("11 01").positive);
    let info = s.info();
    assert_eq!((info.active_session, info.unlocked_level, info.p2_server_ms), (1, None, None));

    let page = s.conversation_since(0, 1000);
    assert!(page.events.iter().all(|e| e.timestamp_us > 0));
    let resp = page.events.iter().find(|e| e.kind == ConversationEventKind::Response).expect("response event");
    assert!(resp.request_seq.is_some() && resp.elapsed_us.is_some());
    s.close();
}

#[test]
fn security_access_unlock_and_lockout() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let _ecu = EcuSim::start("security", CLASSIC, false);
    let (s, _) = open_classic(false);
    assert!(s.request(0x10, &[0x03], &opts()).expect("10 03").positive);

    let seed = s.request(0x27, &[0x01], &opts()).expect("seed");
    assert_eq!(seed.raw, vec![0x67, 0x01, 0x11, 0x22, 0x33, 0x44]);
    let key = xor_const_key(&seed.raw[2..]);
    assert_eq!(key, vec![0xB4, 0x87, 0x96, 0xE1]);
    let mut send_key = vec![0x02];
    send_key.extend(&key);
    let r = s.request(0x27, &send_key, &opts()).expect("key");
    assert!(r.positive, "{r:?}");
    assert_eq!(s.info().unlocked_level, Some(1));
    assert_eq!(s.read_did(0x0101).expect("secured DID").decoded, "CAFEBABE");

    // Session change re-locks.
    assert!(s.request(0x10, &[0x03], &opts()).expect("10 03").positive);
    assert_eq!(s.info().unlocked_level, None);

    // Wrong key: 0x35, 0x35, then 0x36; requestSeed during lockout → 0x37.
    let mut nrcs = Vec::new();
    for _ in 0..3 {
        assert!(s.request(0x27, &[0x01], &opts()).expect("seed").positive);
        let r = s.request(0x27, &[0x02, 0, 0, 0, 0], &opts()).expect("bad key");
        nrcs.push(r.nrc);
    }
    assert_eq!(nrcs, vec![Some(0x35), Some(0x35), Some(0x36)]);
    let r = s.request(0x27, &[0x01], &opts()).expect("seed in lockout");
    assert_eq!((r.nrc, r.nrc_name.as_deref()), (Some(0x37), Some("keyDelayActive")));
    assert_eq!(s.info().unlocked_level, None);

    std::thread::sleep(Duration::from_millis(1700));
    let seed = s.request(0x27, &[0x01], &opts()).expect("seed after lockout");
    assert!(seed.positive);
    let mut send_key = vec![0x02];
    send_key.extend(xor_const_key(&seed.raw[2..]));
    assert!(s.request(0x27, &send_key, &opts()).expect("key").positive);
    assert_eq!(s.info().unlocked_level, Some(1));
}

#[test]
fn read_did_multiframe_and_negative() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let _ecu = EcuSim::start("did", CLASSIC, false);
    let (s, _) = open_classic(false);

    let vin = s.read_did(0xF190).expect("VIN");
    assert_eq!(vin.decoded, "WNX0ECUSIM0000017");
    assert_eq!(vin.raw.len(), 17);
    assert!(vin.transaction_seq > 0);

    let long = s.read_did(0xF1F1).expect("long DID");
    assert!(long.raw.len() > 150, "{}", long.raw.len());
    assert!(long.decoded.starts_with("The quick brown fox"));
    assert_eq!(s.read_did(0xF18B).expect("hex DID").decoded, "261110");

    let e = s.read_did(0xFA01).expect_err("NRC");
    assert_eq!(e.code, DiagErrorCode::NegativeResponse);
    assert_eq!(e.message, "nrc=0x22 conditionsNotMet");
    let e = s.read_did(0x7777).expect_err("unknown DID");
    assert_eq!(e.message, "nrc=0x31 requestOutOfRange");

    let r = s.request(0x22, &[0xFA, 0x01], &opts()).expect("raw");
    assert!(!r.positive);
    assert_eq!(r.raw, vec![0x7F, 0x22, 0x22]);
}

#[test]
fn dtc_read_and_clear() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let _ecu = EcuSim::start("dtc", CLASSIC, false);
    let (s, _) = open_classic(false);
    let dtcs = s.read_dtcs_by_status(0xFF).expect("19 02");
    let codes: Vec<&str> = dtcs.iter().map(|d| d.code.as_str()).collect();
    assert_eq!(codes, vec!["P0123-45", "B1A0B-00"]);
    assert!(dtcs[0].is_confirmed && dtcs[0].is_pending && !dtcs[0].is_mil_on);
    assert_eq!(dtcs[0].status_byte, 0x2F);
    assert!(dtcs[1].is_confirmed && !dtcs[1].is_pending);
    assert_eq!(dtcs[1].raw, 0x9A0B00);
    // Mask filters on the ECU side.
    assert_eq!(s.read_dtcs_by_status(0x04).expect("pending only").len(), 1);

    assert!(s.request(0x14, &[0xFF, 0xFF, 0xFF], &opts()).expect("14").positive);
    assert!(s.read_dtcs_by_status(0xFF).expect("after clear").is_empty());
}

#[test]
fn response_pending_and_p2_timeout() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let _ecu = EcuSim::start("pending", CLASSIC, false);
    let (s, _) = open_classic(false);

    let t0 = Instant::now();
    let r = s.request(0x22, &[0xFA, 0x02], &opts()).expect("FA02 with 2 x 0x78");
    assert!(r.positive);
    assert_eq!(r.response_pending_count, 2);
    assert_eq!(r.raw, vec![0x62, 0xFA, 0x02, 0xC0, 0xDE]);
    // ecusim: first 0x78 at once, next after 0.3 * P2* (600 ms), then the final response.
    assert!(r.elapsed_us > 500_000, "two 0x78: {} us", r.elapsed_us);
    let ev = s.conversation_since(0, 100).events;
    let pend: Vec<_> = ev.iter().filter(|e| e.kind == ConversationEventKind::ResponsePending).collect();
    assert_eq!(pend.len(), 2);
    assert!(pend.iter().all(|e| e.request_seq == Some(r.transaction_seq) && e.nrc == Some(0x78)));
    println!("FA02: {} ms total, elapsed_us {}", t0.elapsed().as_millis(), r.elapsed_us);

    let t0 = Instant::now();
    let e = s.request(0x22, &[0xFA, 0x04], &opts()).expect_err("no response");
    let took = t0.elapsed();
    assert_eq!(e.code, DiagErrorCode::TimeoutP2, "{e:?}");
    assert!(took >= Duration::from_millis(150) && took < Duration::from_millis(600), "{took:?}");
    let last = s.conversation_since(0, 100).events.into_iter().rev().find(|e| e.kind == ConversationEventKind::Timeout);
    assert_eq!(last.and_then(|e| e.detail).as_deref(), Some("p2"));

    // timeout_ms override replaces P2.
    let t0 = Instant::now();
    let o = UdsRequestOptionsDto { timeout_ms: Some(400), ..Default::default() };
    assert_eq!(s.request(0x22, &[0xFA, 0x04], &o).expect_err("override").code, DiagErrorCode::TimeoutP2);
    assert!(t0.elapsed() >= Duration::from_millis(400));
}

#[test]
fn late_response_is_dropped_and_next_request_is_clean() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let _ecu = EcuSim::start("late", CLASSIC, false);
    let (s, _) = open_classic(false);

    // FA03 answers after 400 ms; P2client = 50 + 100 ms.
    let e = s.request(0x22, &[0xFA, 0x03], &opts()).expect_err("late");
    assert_eq!(e.code, DiagErrorCode::TimeoutP2);
    let late_seq = s.conversation_since(0, 100).events.iter().find(|e| e.kind == ConversationEventKind::Request).map(|e| e.seq);
    std::thread::sleep(Duration::from_millis(500));
    let vin = s.read_did(0xF190).expect("next request");
    assert_eq!(vin.decoded, "WNX0ECUSIM0000017");
    let stale = s
        .conversation_since(0, 100)
        .events
        .into_iter()
        .find(|e| e.kind == ConversationEventKind::StaleResponseDropped)
        .expect("stale event");
    assert_eq!(stale.bytes, vec![0x62, 0xFA, 0x03, 0x03]);
    assert_eq!(stale.detail.as_deref(), Some("late"));
    assert_eq!(stale.request_seq, late_seq);
    assert!(stale.elapsed_us.unwrap_or(0) >= 350_000, "{stale:?}");

    // Immediate follow-up while the late answer is still coming: never returns FA03's data.
    let _ = s.request(0x22, &[0xFA, 0x03], &opts()).expect_err("late again");
    let o = UdsRequestOptionsDto { timeout_ms: Some(2000), ..Default::default() };
    match s.request(0x22, &[0xF1, 0x90], &o) {
        Ok(r) => assert_eq!(&r.raw[..3], &[0x62, 0xF1, 0x90]),
        Err(e) => assert!(matches!(e.code, DiagErrorCode::TimeoutP2), "{e:?}"),
    }
    assert_eq!(s.read_did(0xF190).expect("still in sync").decoded, "WNX0ECUSIM0000017");
}

#[test]
fn tester_present_keeps_s3_alive() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let ecu = EcuSim::start("s3", CLASSIC, false);
    let (s, _) = open_classic(false);
    assert!(s.request(0x10, &[0x03], &opts()).expect("10 03").positive);
    s.set_tester_present(true, None).expect("tp on");
    assert!(s.info().tester_present_enabled);
    assert_eq!(s.info().tester_present_interval_ms, 2000);
    std::thread::sleep(Duration::from_millis(3500));
    assert_eq!(s.read_did(0xF186).expect("F186").raw, vec![0x03], "session kept by 3E 80");
    assert_eq!(ecu.count("\"ev\":\"s3_timeout\""), 0);
    assert!(kinds(&s).contains(&ConversationEventKind::KeepaliveSent));

    // Negative control: without TesterPresent the ECU falls back after S3 (3 s).
    s.set_tester_present(false, None).expect("tp off");
    std::thread::sleep(Duration::from_millis(3500));
    assert_eq!(s.read_did(0xF186).expect("F186").raw, vec![0x01]);
    assert_eq!(ecu.count("\"ev\":\"s3_timeout\""), 1);

    assert_eq!(s.set_tester_present(true, Some(10)).expect_err("range").code, DiagErrorCode::InvalidInput);
}

#[test]
fn functional_request_with_physical_flow_control() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let ecu = EcuSim::start("functional", CLASSIC, false);
    let (s, probe) = open_classic(true);
    let o = UdsRequestOptionsDto { addressing: Some(UdsAddressing::Functional), ..Default::default() };
    let r = s.request(0x22, &[0xF1, 0x90], &o).expect("functional VIN");
    assert_eq!(&r.raw[3..], b"WNX0ECUSIM0000017");
    let sent = probe.sent();
    let sf = sent.iter().find(|f| f.payload().get(1) == Some(&0x22)).expect("request SF");
    assert_eq!(sf.arb_id, CLASSIC.func);
    let fc = sent.iter().find(|f| f.payload().first().map(|b| b >> 4) == Some(3)).expect("FC");
    assert_eq!(fc.arb_id, CLASSIC.req, "flow control must use the physical request id");
    assert!(ecu.count("\"ta\":\"func\"") >= 1);
    let ev = s.conversation_since(0, 10).events;
    assert_eq!(ev[0].addressing, UdsAddressing::Functional);

    let r = s.request(0x3E, &[0x80], &o).expect("functional 3E 80");
    assert!(r.suppressed);
    let e = s.request(0x2E, &[0xF1, 0x90, 1, 2, 3, 4, 5, 6, 7], &o).expect_err("too long for SF");
    assert_eq!(e.code, DiagErrorCode::InvalidInput);
}

#[test]
fn canfd_session() {
    let _g = serial();
    if hil_env(true).is_none() {
        return;
    }
    let _ecu = EcuSim::start("canfd", FD, true);
    let (port, probe) = SocketCanPort::open(FD, true);
    let s = UdsSession::open(port, config(FD, true, true)).expect("open fd");
    assert!(s.request(0x10, &[0x03], &opts()).expect("10 03").positive);
    assert_eq!(s.read_did(0xF190).expect("VIN").decoded, "WNX0ECUSIM0000017");
    let long = s.read_did(0xF1F1).expect("long DID over FD");
    assert!(long.raw.len() > 150);
    let o = UdsRequestOptionsDto { addressing: Some(UdsAddressing::Functional), ..Default::default() };
    assert_eq!(s.read_did(0xF18A).expect("F18A").decoded, "NEXUSCAN-TEST");
    assert!(s.request(0x22, &[0xF1, 0x90], &o).expect("functional FD").positive);
    assert!(probe.sent().iter().all(|f| f.is_fd()));
}

#[test]
fn gate_rejection_and_closed_tap() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let _ecu = EcuSim::start("gate", CLASSIC, false);
    let (s, probe) = open_classic(false);
    probe.set_gate(Some(DiagTxReject::Disarmed));
    let e = s.request(0x3E, &[0x00], &opts()).expect_err("disarmed");
    assert_eq!(e.code, DiagErrorCode::Disarmed);
    probe.set_gate(Some(DiagTxReject::ListenOnly));
    assert_eq!(s.read_did(0xF190).expect_err("listen only").code, DiagErrorCode::ListenOnly);
    assert!(probe.sent().is_empty());
    let blocked: Vec<_> = s.conversation_since(0, 10).events.into_iter().filter(|e| e.kind == ConversationEventKind::TxBlocked).collect();
    assert_eq!(blocked.len(), 2);
    assert_eq!(blocked[0].detail.as_deref(), Some("disarmed"));

    probe.set_gate(None);
    assert!(s.request(0x3E, &[0x00], &opts()).expect("armed").positive);

    probe.close();
    std::thread::sleep(Duration::from_millis(150));
    assert!(!s.info().open);
    assert_eq!(s.request(0x3E, &[0x00], &opts()).expect_err("closed").code, DiagErrorCode::SessionClosed);
    assert!(kinds(&s).contains(&ConversationEventKind::SessionClosed));

    s.close();
    s.close(); // idempotent
    assert_eq!(s.read_did(0xF190).expect_err("after close").code, DiagErrorCode::SessionClosed);
    assert_eq!(s.set_tester_present(true, None).expect_err("after close").code, DiagErrorCode::SessionClosed);
}

#[test]
fn concurrent_callers_are_serialized() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let _ecu = EcuSim::start("concurrent", CLASSIC, false);
    let (s, _) = open_classic(false);
    let s = std::sync::Arc::new(s);
    s.set_tester_present(true, Some(100)).expect("tp");
    let handles: Vec<_> = (0..4)
        .map(|i| {
            let s = s.clone();
            std::thread::spawn(move || {
                (0..5)
                    .map(|_| {
                        let did = if i % 2 == 0 { 0xF190u16 } else { 0xF18A };
                        s.read_did(did).map(|r| (did, r.decoded))
                    })
                    .collect::<Vec<_>>()
            })
        })
        .collect();
    for h in handles {
        for r in h.join().expect("thread") {
            let (did, text) = r.expect("read");
            assert_eq!(text, if did == 0xF190 { "WNX0ECUSIM0000017" } else { "NEXUSCAN-TEST" });
        }
    }
    assert!(kinds(&s).iter().all(|k| !matches!(k, ConversationEventKind::StaleResponseDropped)));
}

#[test]
fn idle_cpu_and_thread_cleanup() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let _ecu = EcuSim::start("idle", CLASSIC, false);
    let threads_before = common::thread_count();
    let (s, _) = open_classic(false);
    assert!(s.request(0x3E, &[0x00], &opts()).expect("warm up").positive);
    let ticks_per_s = 100.0; // USER_HZ on Linux
    let measure = |label: &str| {
        let t0 = Instant::now();
        let c0 = common::cpu_ticks();
        let th0 = common::thread_sched();
        std::thread::sleep(Duration::from_secs(5));
        for (name, ns, slices) in common::thread_sched() {
            let (ns0, sl0) = th0.iter().find(|(n, _, _)| *n == name).map_or((0, 0), |(_, a, b)| (*a, *b));
            println!(
                "  thread {name}: {:.3} ms CPU/s, {:.0} wake-ups/s",
                (ns - ns0) as f64 / 5e6,
                (slices - sl0) as f64 / 5.0
            );
        }
        let pct = (common::cpu_ticks() - c0) as f64 / ticks_per_s / t0.elapsed().as_secs_f64() * 100.0;
        println!("idle CPU ({label}): {pct:.2} % of one core");
        pct
    };
    let idle = measure("session open, TesterPresent off");
    s.set_tester_present(true, None).expect("tp");
    let idle_tp = measure("TesterPresent every 2 s");
    assert!(idle < 5.0 && idle_tp < 5.0, "idle {idle:.2} %, with TP {idle_tp:.2} %");
    println!("threads: before open {threads_before}, open {}", common::thread_count());
    s.close();
    drop(s);
    std::thread::sleep(Duration::from_millis(300));
    let after = common::thread_count();
    println!("threads after close: {after}");
    assert!(after <= threads_before, "threads left behind: before {threads_before}, after {after}");
}
