//! D-003 diag tap integration tests on `mock0` (no hardware, every OS).
//!
//! * TX verdicts (`TxConfirmed` / `TxRejected`) reach the sending tap only; other taps see the
//!   echo as ordinary RX; the StateTable still sees the diag TX echo.
//! * Gate: not connected / Listen-Only / disarmed / Panic latched refuse to open a tap.
//! * Panic Stop, disarm, mode change and disconnect close taps; queued sends get `Closed`.
//! * Every accepted `send` produces exactly one verdict.

use nexus_core::{CanIdKey, RawCanFrame, FLAG_TX};
use nexus_hal::{ChannelConfigDto, PipelineEngine, MOCK0_DEVICE_ID};
use nexus_protocols::uds::dto::{DiagErrorCode, DiagSessionConfigDto};
use nexus_protocols::uds::port::{DiagCanPort, DiagPortEvent, DiagTapFilter, DiagTxReject};
use std::time::{Duration, Instant};

const REQ: u32 = 0x7E4;
const RESP: u32 = 0x7EC;

fn engine() -> PipelineEngine {
    PipelineEngine::new()
}

fn connect(engine: &PipelineEngine, listen_only: bool, arm: bool) {
    let cfg = ChannelConfigDto {
        bus_id: 0,
        listen_only,
        mock_fps_preset: Some(1_000),
        ..ChannelConfigDto::default()
    };
    engine
        .cmd_connect_bus(MOCK0_DEVICE_ID.to_string(), cfg)
        .expect("connect mock0");
    if arm {
        engine.cmd_arm_active_bus(0, true).expect("arm");
    }
}

fn frame(id: u32, b0: u8) -> RawCanFrame {
    let key = CanIdKey::new_standard(id as u16).expect("std id");
    RawCanFrame::new_classical(0, key, &[0x02, 0x3E, b0, 0, 0, 0, 0, 0], 0).expect("frame")
}

/// Collects events until `pred` returns true or `timeout` passes.
fn collect_until(
    port: &impl DiagCanPort,
    timeout: Duration,
    mut pred: impl FnMut(&[DiagPortEvent]) -> bool,
) -> Vec<DiagPortEvent> {
    let deadline = Instant::now() + timeout;
    let mut out = Vec::new();
    while !pred(&out) {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        if let Some(ev) = port.recv_timeout(deadline - now) {
            out.push(ev);
        }
    }
    out
}

fn is_verdict(ev: &DiagPortEvent) -> bool {
    matches!(
        ev,
        DiagPortEvent::TxConfirmed(_) | DiagPortEvent::TxRejected(..)
    )
}

#[test]
fn tx_verdict_goes_only_to_origin_and_echo_reaches_others_and_state_table() {
    let engine = engine();
    connect(&engine, false, true);

    let a = engine
        .open_diag_tap(
            0,
            &[
                DiagTapFilter::exact_std(REQ),
                DiagTapFilter::exact_std(RESP),
            ],
            256,
        )
        .expect("tap a");
    let b = engine
        .open_diag_tap(0, &[DiagTapFilter::exact_std(REQ)], 256)
        .expect("tap b");
    assert_eq!(engine.diag_tap_count(0), 2);
    assert!(a.gate_check().is_ok());

    a.send(frame(REQ, 0x00)).expect("queued");

    let ev_a = collect_until(&a, Duration::from_millis(500), |evs| {
        evs.iter().any(is_verdict)
    });
    let confirmed = ev_a
        .iter()
        .find_map(|e| match e {
            DiagPortEvent::TxConfirmed(f) => Some(*f),
            _ => None,
        })
        .expect("origin must get TxConfirmed");
    assert_eq!(confirmed.arb_id, REQ);
    assert!(confirmed.flags & FLAG_TX != 0);
    assert!(
        confirmed.timestamp_us > 0,
        "HAL monotonic timestamp of the send"
    );
    // The origin never sees its own frame as RX.
    std::thread::sleep(Duration::from_millis(30));
    while let Some(ev) = a.try_recv() {
        assert!(
            !matches!(ev, DiagPortEvent::Rx(f) if f.arb_id == REQ),
            "origin tap must not receive its own frame as Rx"
        );
    }

    let ev_b = collect_until(&b, Duration::from_millis(500), |evs| !evs.is_empty());
    match ev_b.first() {
        Some(DiagPortEvent::Rx(f)) => assert_eq!(f.arb_id, REQ),
        other => panic!("tap b expected Rx echo, got {other:?}"),
    }
    assert!(
        b.try_recv().is_none_or(|e| !is_verdict(&e)),
        "verdicts are origin-only"
    );

    // StateTable / Trace still sees the diag TX.
    std::thread::sleep(Duration::from_millis(40));
    let snap = engine.flush_snapshot_now().expect("snapshot");
    assert!(
        snap.frames.iter().any(|f| f.arb_id == REQ && f.is_tx),
        "diag TX echo must reach the StateTable"
    );

    drop(a);
    drop(b);
    std::thread::sleep(Duration::from_millis(20));
    assert_eq!(
        engine.diag_tap_count(0),
        0,
        "dropping a port frees its slot"
    );
}

#[test]
fn gate_refuses_to_open_taps() {
    let engine = engine();
    let filters = [DiagTapFilter::exact_std(RESP)];

    let err = engine
        .open_diag_tap(0, &filters, 64)
        .err()
        .expect("not connected");
    assert_eq!(err.code, DiagErrorCode::BusNotConnected);

    connect(&engine, true, false);
    let err = engine
        .open_diag_tap(0, &filters, 64)
        .err()
        .expect("listen-only");
    assert_eq!(err.code, DiagErrorCode::ListenOnly);
    engine.cmd_disconnect_bus(0).expect("disc");

    connect(&engine, false, false);
    let err = engine
        .open_diag_tap(0, &filters, 64)
        .err()
        .expect("disarmed");
    assert_eq!(err.code, DiagErrorCode::Disarmed);

    engine.cmd_arm_active_bus(0, true).expect("arm");
    let _ = engine.cmd_panic_stop_tx();
    let err = engine.open_diag_tap(0, &filters, 64).err().expect("panic");
    assert_eq!(err.code, DiagErrorCode::PanicLatched);

    // WP-4: arming no longer clears the latch; it must be cleared explicitly.
    let err = engine
        .cmd_arm_active_bus(0, true)
        .expect_err("arm while latched");
    assert!(err.to_string().starts_with("PANIC_LATCHED:"), "{err}");
    engine.cmd_clear_panic_latch();
    engine
        .cmd_arm_active_bus(0, true)
        .expect("re-arm after clearing the latch");
    assert!(engine.open_diag_tap(0, &filters, 64).is_ok());

    let err = engine.open_diag_tap(0, &[], 64).err().expect("no filters");
    assert_eq!(err.code, DiagErrorCode::InvalidInput);
}

#[test]
fn panic_stop_closes_taps_and_every_send_gets_exactly_one_verdict() {
    let engine = engine();
    connect(&engine, false, true);
    let port = engine
        .open_diag_tap(0, &[DiagTapFilter::exact_std(RESP)], 16_384)
        .expect("tap");

    let mut accepted = 0usize;
    for i in 0..3_000u32 {
        match port.send(frame(REQ, (i & 0xFF) as u8)) {
            Ok(()) => accepted += 1,
            Err(DiagTxReject::QueueFull) => {}
            Err(other) => panic!("unexpected early reject {other:?}"),
        }
    }
    let _ = engine.cmd_panic_stop_tx();
    assert!(port.is_closed(), "Panic Stop must close diag taps");
    assert_eq!(port.send(frame(REQ, 0)), Err(DiagTxReject::Closed));
    assert_eq!(port.gate_check(), Err(DiagTxReject::Closed));

    let mut confirmed = 0usize;
    let mut rejected = 0usize;
    let deadline = Instant::now() + Duration::from_secs(3);
    while confirmed + rejected < accepted && Instant::now() < deadline {
        match port.recv_timeout(Duration::from_millis(50)) {
            Some(DiagPortEvent::TxConfirmed(_)) => confirmed += 1,
            Some(DiagPortEvent::TxRejected(_, r)) => {
                assert!(
                    matches!(r, DiagTxReject::Closed | DiagTxReject::PanicLatched),
                    "unexpected reject reason {r:?}"
                );
                rejected += 1;
            }
            Some(DiagPortEvent::Rx(_)) | None => {}
        }
    }
    assert_eq!(
        confirmed + rejected,
        accepted,
        "each accepted send yields exactly one verdict (confirmed {confirmed}, rejected {rejected})"
    );
    // Nothing else afterwards (no duplicate verdicts).
    std::thread::sleep(Duration::from_millis(30));
    assert!(port.try_recv().is_none_or(|e| !is_verdict(&e)));

    // A closed tap must not spin: recv_timeout blocks (bounded) and returns None.
    let t0 = Instant::now();
    let mut nones = 0;
    while t0.elapsed() < Duration::from_millis(100) {
        if port.recv_timeout(Duration::from_millis(20)).is_none() {
            nones += 1;
        }
    }
    assert!(
        nones <= 10,
        "closed tap returned {nones} times in 100 ms (spinning)"
    );
}

#[test]
fn disarm_mode_change_and_disconnect_close_taps() {
    let engine = engine();
    connect(&engine, false, true);
    let f = [DiagTapFilter::exact_std(RESP)];

    let p1 = engine.open_diag_tap(0, &f, 64).expect("tap");
    engine.cmd_arm_active_bus(0, false).expect("disarm");
    assert!(p1.is_closed(), "disarm closes taps");
    assert_eq!(p1.send(frame(REQ, 1)), Err(DiagTxReject::Closed));

    engine.cmd_arm_active_bus(0, true).expect("arm");
    let p2 = engine.open_diag_tap(0, &f, 64).expect("tap after re-arm");
    engine
        .cmd_set_bus_mode(0, false, false)
        .expect("same-mode disarm");
    assert!(p2.is_closed(), "set_bus_mode disarm closes taps");

    engine
        .cmd_set_bus_mode(0, false, true)
        .expect("arm via set_bus_mode");
    let p3 = engine.open_diag_tap(0, &f, 64).expect("tap");
    engine
        .cmd_set_bus_mode(0, true, false)
        .expect("switch to Listen-Only");
    assert!(p3.is_closed(), "mode change closes taps");
    let err = engine
        .open_diag_tap(0, &f, 64)
        .err()
        .expect("listen-only now");
    assert_eq!(err.code, DiagErrorCode::ListenOnly);

    engine
        .cmd_set_bus_mode(0, false, true)
        .expect("back to active+armed");
    let p4 = engine.open_diag_tap(0, &f, 64).expect("tap");
    let t0 = Instant::now();
    engine.cmd_disconnect_bus(0).expect("disconnect");
    assert!(
        t0.elapsed() < Duration::from_millis(25),
        "bus shutdown < 25 ms with a tap open"
    );
    assert!(p4.is_closed(), "disconnect closes taps");
    assert_eq!(p4.recv_timeout(Duration::from_millis(5)).map(|_| ()), None);
}

#[test]
fn diag_commands_respect_gate_and_manage_sessions() {
    let engine = engine();
    let cfg: DiagSessionConfigDto = serde_json::from_str(
        r#"{"busId":0,"requestId":2020,"responseId":2028,"isExtendedId":false,"protocol":"uds"}"#,
    )
    .expect("cfg");

    let e = engine.cmd_diag_open_session(cfg.clone()).unwrap_err();
    assert_eq!(e.code, DiagErrorCode::BusNotConnected);
    assert!(e.to_ipc_string().starts_with("[diag:bus_not_connected] "));

    connect(&engine, true, false);
    assert_eq!(
        engine
            .cmd_diag_send_uds(cfg.clone(), 0x3E, Some(0x00), vec![], None)
            .unwrap_err()
            .code,
        DiagErrorCode::ListenOnly
    );
    engine.cmd_disconnect_bus(0).expect("disc");

    connect(&engine, false, false);
    assert_eq!(
        engine
            .cmd_diag_read_did(cfg.clone(), 0xF190, None)
            .unwrap_err()
            .code,
        DiagErrorCode::Disarmed
    );
    // Read-only commands never open a session and never fail on the gate.
    let info = engine.cmd_diag_session_info(cfg.clone()).expect("info");
    assert!(!info.open);
    let page = engine
        .cmd_diag_get_conversation(cfg.clone(), 0, None)
        .expect("page");
    assert!(page.events.is_empty());
    assert_eq!(engine.diag_tap_count(0), 0);

    engine.cmd_arm_active_bus(0, true).expect("arm");
    engine
        .cmd_diag_open_session(cfg.clone())
        .expect("open session");
    assert_eq!(engine.diag_tap_count(0), 1);
    // Idempotent open.
    engine.cmd_diag_open_session(cfg.clone()).expect("reopen");
    assert_eq!(engine.diag_tap_count(0), 1);

    // Same addressing, different settings: the old session is replaced (no double FC).
    let mut cfg2 = cfg.clone();
    cfg2.padding = None;
    engine
        .cmd_diag_open_session(cfg2.clone())
        .expect("open with other padding");
    std::thread::sleep(Duration::from_millis(20));
    assert_eq!(
        engine.diag_tap_count(0),
        1,
        "old session on the same ids must be closed"
    );

    // Produce some conversation (no ECU on mock0 -> request + timeout events).
    let opts = nexus_protocols::uds::dto::UdsRequestOptionsDto {
        addressing: None,
        timeout_ms: Some(50),
        origin: None,
        ..Default::default()
    };
    let _ = engine.cmd_diag_send_uds(cfg2.clone(), 0x3E, Some(0x00), vec![], Some(opts));
    let before = engine
        .cmd_diag_get_conversation(cfg2.clone(), 0, None)
        .expect("page")
        .events
        .len();
    assert!(before > 0, "request must be logged");

    // Panic invalidates; next call reports the gate; re-arm reopens.
    let _ = engine.cmd_panic_stop_tx();
    assert!(
        !engine
            .cmd_diag_session_info(cfg2.clone())
            .expect("info")
            .open
    );
    assert_eq!(
        engine.cmd_diag_open_session(cfg2.clone()).unwrap_err().code,
        DiagErrorCode::PanicLatched
    );
    assert_eq!(
        engine
            .cmd_diag_read_did(cfg2.clone(), 0xF190, None)
            .unwrap_err()
            .code,
        DiagErrorCode::PanicLatched
    );
    // A refused reopen must not discard the closed session and its log.
    let after = engine
        .cmd_diag_get_conversation(cfg2.clone(), 0, None)
        .expect("page")
        .events
        .len();
    assert!(
        after >= before,
        "conversation lost after gate refusal ({before} -> {after})"
    );
    engine.cmd_clear_panic_latch();
    engine.cmd_arm_active_bus(0, true).expect("re-arm");
    engine
        .cmd_diag_open_session(cfg2.clone())
        .expect("reopen after re-arm");

    // useFd on an FD-capable mock bus is accepted; out-of-range ids are invalid_input.
    let mut bad = cfg.clone();
    bad.request_id = 0x900;
    assert_eq!(
        engine.cmd_diag_open_session(bad).unwrap_err().code,
        DiagErrorCode::InvalidInput
    );

    engine.cmd_diag_close_session(cfg2.clone()).expect("close");
    engine
        .cmd_diag_close_session(cfg2)
        .expect("close is idempotent");
    std::thread::sleep(Duration::from_millis(20));
    assert_eq!(engine.diag_tap_count(0), 0);
}

/// HIGH-07.4: TX verdicts must survive an RX burst that fills the tap's event queue.
#[test]
fn tx_verdicts_are_not_lost_when_rx_queue_is_full() {
    let engine = engine();
    let cfg = ChannelConfigDto {
        bus_id: 0,
        listen_only: false,
        mock_fps_preset: Some(10_000),
        ..ChannelConfigDto::default()
    };
    engine
        .cmd_connect_bus(MOCK0_DEVICE_ID.to_string(), cfg)
        .expect("connect mock0");
    engine.cmd_arm_active_bus(0, true).expect("arm");

    // Accept-all filter + minimum depth: the mock traffic floods the queue immediately.
    let accept_all = DiagTapFilter {
        id: 0,
        mask: 0,
        extended: None,
    };
    let tap = engine.open_diag_tap(0, &[accept_all], 16).expect("tap");
    std::thread::sleep(Duration::from_millis(40));
    assert!(
        tap.status().rx_dropped() > 0,
        "RX queue must be saturated for this test"
    );

    const SENDS: usize = 8;
    for i in 0..SENDS {
        tap.send(frame(REQ, i as u8)).expect("queued");
    }
    std::thread::sleep(Duration::from_millis(40));

    let mut confirmed = 0usize;
    let deadline = Instant::now() + Duration::from_millis(500);
    while confirmed < SENDS && Instant::now() < deadline {
        match tap.recv_timeout(Duration::from_millis(5)) {
            Some(DiagPortEvent::TxConfirmed(f)) if f.arb_id == REQ => confirmed += 1,
            Some(DiagPortEvent::TxRejected(_, why)) => panic!("unexpected reject {why:?}"),
            _ => {}
        }
    }
    assert_eq!(
        confirmed, SENDS,
        "every TxConfirmed must reach the origin tap under RX flood"
    );
}
