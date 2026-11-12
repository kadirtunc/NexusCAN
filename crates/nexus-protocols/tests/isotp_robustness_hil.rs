//! WP-7 / HIGH-07 ISO-TP robustness against a misbehaving ECU on vcan0.
//!
//! Run: `cargo test -p nexus-protocols --test isotp_robustness_hil -- --test-threads=1 --nocapture`
//!
//! No ecusim here: each test runs a scripted *fake* ECU on raw SocketCAN sockets on ids used by
//! nothing else in the repository (classic 0x6C2/0x6CA/0x6CE, CAN-FD 0x6C3/0x6CB/0x6CF), so a
//! concurrently running ecusim (`uds_client_hil`, nexus-hal diag HIL tests on 0x7E2/0x7EA…) can
//! never answer our requests. The user's manual ECUs (0x7E0/0x7E1/0x7E5/0x7E7, functional 0x7DF)
//! are never touched. Without vcan0 the tests print `SKIP (HIL)` and return.
//!
//! Isolation: every [`FakeEcu`] is stopped and joined on drop (before the test returns), each test
//! waits for its ids to be quiet before opening the session, and multi-frame bursts are paced at a
//! bus-realistic rate (see [`CF_GAP`]).
#![cfg(target_os = "linux")]

mod common;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{config, serial, Ids, SocketCanPort, IFACE};
use nexus_protocols::uds::client::{UdsSession, MAX_RESPONSE_PDU};
use nexus_protocols::uds::dto::{ConversationEventKind, DiagErrorCode, UdsRequestOptionsDto};
use socketcan::frame::FdFlags;
use socketcan::{
    CanAnyFrame, CanDataFrame, CanFdFrame, CanFdSocket, CanFilter, EmbeddedFrame, Socket,
    SocketOptions, StandardId,
};

/// Test-only ids of this suite (not used by any other test, tool or ecusim config).
const CLASSIC: Ids = Ids {
    req: 0x6C2,
    resp: 0x6CA,
    func: 0x6CE,
};
const FD: Ids = Ids {
    req: 0x6C3,
    resp: 0x6CB,
    func: 0x6CF,
};
const FORBIDDEN: [u32; 5] = [0x7E0, 0x7E1, 0x7E5, 0x7E7, 0x7DF];

/// Gap between consecutive frames the fake ECU sends in a burst (≈ a full classic frame at
/// 500 kbit/s). An unpaced burst on vcan runs at tens of thousands of frames/s, far beyond any real
/// bus, and overflows the test port's kernel receive buffer (`rmem_max` ≈ 212 KB ≈ 250 CAN skbs)
/// whenever its reader thread is descheduled → lost CF → `isotp_out_of_order`. That is a harness
/// artefact, not client behaviour.
const CF_GAP: Duration = Duration::from_micros(250);

/// Waits until no frame was seen on `ids` for `quiet` (max 2 s): nothing left in flight from an
/// earlier test before this one opens its session.
fn wait_bus_quiet(ids: Ids, quiet: Duration) {
    let sock = CanFdSocket::open(IFACE).expect("open quiet probe");
    let f = |id| CanFilter::new(id, 0x7FF | 0x8000_0000 | 0x4000_0000);
    sock.set_filters(&[f(ids.req), f(ids.resp), f(ids.func)])
        .expect("filter");
    sock.set_read_timeout(Duration::from_millis(5))
        .expect("timeout");
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut last = Instant::now();
    while Instant::now() < deadline && last.elapsed() < quiet {
        if sock.read_frame().is_ok() {
            last = Instant::now();
        }
    }
    assert!(last.elapsed() >= quiet, "ids {ids:?} never went quiet");
}

fn vcan(need_fd: bool) -> bool {
    let net = std::path::Path::new("/sys/class/net").join(IFACE);
    if !net.exists() {
        eprintln!("SKIP (HIL): {IFACE} not present");
        return false;
    }
    if need_fd
        && std::fs::read_to_string(net.join("mtu"))
            .unwrap_or_default()
            .trim()
            != "72"
    {
        eprintln!("SKIP (HIL): {IFACE} is not CAN-FD capable (MTU != 72)");
        return false;
    }
    true
}

/// What the fake ECU does when it sees a tester frame.
type Script = dyn FnMut(&[u8], &Bus) + Send;

/// Raw TX handle of the fake ECU (writes on the response id).
#[derive(Clone)]
struct Bus {
    sock: Arc<CanFdSocket>,
    resp: u32,
    fd: bool,
}

impl Bus {
    fn send(&self, data: &[u8]) {
        let id = StandardId::new(self.resp as u16).expect("std id");
        loop {
            let r = if self.fd {
                let mut d = data.to_vec();
                let len = [8usize, 12, 16, 20, 24, 32, 48, 64]
                    .into_iter()
                    .find(|&l| l >= d.len())
                    .unwrap_or(64);
                d.resize(len, 0xAA);
                self.sock
                    .write_frame(&CanFdFrame::with_flags(id, &d, FdFlags::BRS).expect("fd frame"))
            } else {
                let mut d = data.to_vec();
                d.resize(8, 0xAA);
                self.sock
                    .write_frame(&CanDataFrame::new(id, &d).expect("frame"))
            };
            match r {
                Ok(()) => return,
                // ENOBUFS under a burst: back off briefly and retry.
                Err(_) => std::thread::sleep(Duration::from_micros(200)),
            }
        }
    }
}

/// Scripted fake ECU: reads tester frames on `ids.req` and runs `script` for each.
struct FakeEcu {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    bus: Bus,
}

impl FakeEcu {
    fn start(ids: Ids, fd: bool, mut script: Box<Script>) -> FakeEcu {
        for id in [ids.req, ids.resp, ids.func] {
            assert!(
                !FORBIDDEN.contains(&id),
                "ID {id:#x} belongs to the user's manual session"
            );
        }
        let rx = CanFdSocket::open(IFACE).expect("open fake ECU rx");
        rx.set_filters(&[CanFilter::new(ids.req, 0x7FF | 0x8000_0000 | 0x4000_0000)])
            .expect("filter");
        rx.set_read_timeout(Duration::from_millis(20))
            .expect("timeout");
        let tx = CanFdSocket::open(IFACE).expect("open fake ECU tx");
        tx.set_filter_drop_all().expect("drop all");
        let bus = Bus {
            sock: Arc::new(tx),
            resp: ids.resp,
            fd,
        };
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (stop, bus) = (stop.clone(), bus.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    let Ok(f) = rx.read_frame() else { continue };
                    let data = match &f {
                        CanAnyFrame::Normal(d) => d.data().to_vec(),
                        CanAnyFrame::Fd(d) => d.data().to_vec(),
                        _ => continue,
                    };
                    script(&data, &bus);
                }
            })
        };
        FakeEcu {
            stop,
            thread: Some(thread),
            bus,
        }
    }
}

impl Drop for FakeEcu {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn vm_rss_kib() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .unwrap_or_default()
        .lines()
        .find_map(|l| {
            l.strip_prefix("VmRSS:")
                .and_then(|v| v.split_whitespace().next()?.parse().ok())
        })
        .unwrap_or(0)
}

fn fc_frames(sent: &[nexus_core::RawCanFrame]) -> usize {
    sent.iter()
        .filter(|f| f.payload().first().is_some_and(|b| b >> 4 == 3))
        .count()
}

/// Runs `f` on a helper thread and waits at most `limit` (a hang must fail the test, not block it).
fn bounded<T: Send + 'static>(
    limit: Duration,
    f: impl FnOnce() -> T + Send + 'static,
) -> Option<(T, Duration)> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let t0 = Instant::now();
        let r = f();
        let _ = tx.send((r, t0.elapsed()));
    });
    rx.recv_timeout(limit).ok()
}

/// Answers `3E 00` with `7E 00` (single frame) — the "next request works" probe.
fn answer_tester_present(data: &[u8], bus: &Bus, fd: bool) -> bool {
    let off = usize::from(fd && data.first() == Some(&0x00));
    if data.get(off..off + 3) == Some(&[0x02, 0x3E, 0x00][..])
        || data.get(..3) == Some(&[0x02, 0x3E, 0x00][..])
    {
        bus.send(&[0x02, 0x7E, 0x00]);
        return true;
    }
    false
}

// ─── HIGH-07.1: First Frame announcing a huge length ────────────────────────────────────────

fn huge_escape_ff(ids: Ids, fd: bool) {
    let fc_seen = Arc::new(AtomicUsize::new(0));
    let cfs_sent = Arc::new(AtomicUsize::new(0));
    let _ecu = {
        let (fc_seen, cfs_sent) = (fc_seen.clone(), cfs_sent.clone());
        FakeEcu::start(
            ids,
            fd,
            Box::new(move |data, bus| {
                if answer_tester_present(data, bus, fd) {
                    return;
                }
                match data.first().map(|b| b >> 4) {
                    // Request SF `22 F1 90` → escape FF announcing 0xFFFF_FFF0 bytes.
                    Some(0) => {
                        let mut ff = vec![0x10, 0x00, 0xFF, 0xFF, 0xFF, 0xF0, 0x62, 0xF1];
                        if fd {
                            ff.resize(64, 0x55);
                        }
                        bus.send(&ff);
                    }
                    // Tester accepted with FC.CTS → stream CFs as fast as possible for 1.5 s.
                    Some(3) if data[0] & 0x0F == 0 => {
                        fc_seen.fetch_add(1, Ordering::AcqRel);
                        let t0 = Instant::now();
                        let mut sn = 1u8;
                        let mut cf = vec![0u8; if fd { 64 } else { 8 }];
                        while t0.elapsed() < Duration::from_millis(1500) {
                            cf[0] = 0x20 | sn;
                            bus.send(&cf);
                            std::thread::sleep(CF_GAP);
                            sn = (sn + 1) & 0x0F;
                            cfs_sent.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    _ => {}
                }
            }),
        )
    };

    wait_bus_quiet(ids, Duration::from_millis(50));
    let (port, probe) = SocketCanPort::open(ids, fd);
    let s = Arc::new(UdsSession::open(port, config(ids, fd, false)).expect("open"));
    let rss0 = vm_rss_kib();
    let s2 = s.clone();
    let (res, took) = bounded(Duration::from_secs(20), move || {
        let opts = UdsRequestOptionsDto {
            timeout_ms: Some(5_000),
            ..Default::default()
        };
        s2.request(0x22, &[0xF1, 0x90], &opts)
    })
    .expect("request must not hang");
    let rss1 = vm_rss_kib();
    eprintln!(
        "huge FF (fd={fd}): result={:?} took={took:?} tester_fc={} ecu_cfs={} rss_delta={} KiB",
        res.as_ref().map(|r| r.raw.len()).map_err(|e| e.code),
        fc_frames(&probe.sent()),
        cfs_sent.load(Ordering::Relaxed),
        rss1.saturating_sub(rss0)
    );
    let e = res.expect_err("a 4 GiB response must be refused");
    assert_eq!(e.code, DiagErrorCode::IsotpError, "{e}");
    assert!(e.message.contains("too large"), "{e}");
    assert!(
        took < Duration::from_secs(2),
        "refusal must be immediate, took {took:?}"
    );
    assert_eq!(
        fc_seen.load(Ordering::Acquire),
        0,
        "tester must not send FC.CTS for an oversized FF"
    );
    assert_eq!(fc_frames(&probe.sent()), 0);
    let log = s.conversation_since(0, 100);
    assert!(log
        .events
        .iter()
        .any(|e| e.detail.as_deref() == Some("isotp_pdu_too_large")));

    // Session still usable.
    let r = s
        .request(0x3E, &[0x00], &UdsRequestOptionsDto::default())
        .expect("next request works");
    assert_eq!(r.raw, vec![0x7E, 0x00]);
    s.close();
}

#[test]
fn high07_1_classic_escape_first_frame_with_4gib_length_is_refused_without_fc() {
    let _g = serial();
    if !vcan(false) {
        return;
    }
    huge_escape_ff(CLASSIC, false);
}

#[test]
fn high07_1_fd_escape_first_frame_with_4gib_length_is_refused_without_fc() {
    let _g = serial();
    if !vcan(true) {
        return;
    }
    huge_escape_ff(FD, true);
}

/// A legitimate multi-frame response of `len` bytes (classic FF up to 4095, escape FF above).
fn legit_long_response(ids: Ids, fd: bool, len: usize) {
    let payload: Vec<u8> = {
        let mut p = vec![0x62, 0xF1, 0x90];
        p.extend((0..len - 3).map(|i| (i % 251) as u8));
        p
    };
    let _ecu = {
        let payload = payload.clone();
        FakeEcu::start(
            ids,
            fd,
            Box::new(move |data, bus| match data.first().map(|b| b >> 4) {
                Some(0) => {
                    let mut ff = if len <= 4095 {
                        vec![0x10 | (len >> 8) as u8, (len & 0xFF) as u8]
                    } else {
                        let mut v = vec![0x10, 0x00];
                        v.extend((len as u32).to_be_bytes());
                        v
                    };
                    let room = if fd { 64 } else { 8 } - ff.len();
                    ff.extend(&payload[..room]);
                    bus.send(&ff);
                }
                Some(3) => {
                    let first = if fd { 64 } else { 8 } - if len <= 4095 { 2 } else { 6 };
                    let step = if fd { 63 } else { 7 };
                    for (i, chunk) in payload[first..].chunks(step).enumerate() {
                        let mut cf = vec![0x20 | ((i + 1) & 0x0F) as u8];
                        cf.extend(chunk);
                        bus.send(&cf);
                        std::thread::sleep(CF_GAP);
                    }
                }
                _ => {}
            }),
        )
    };
    wait_bus_quiet(ids, Duration::from_millis(50));
    let (port, _probe) = SocketCanPort::open(ids, fd);
    let s = UdsSession::open(port, config(ids, fd, false)).expect("open");
    let opts = UdsRequestOptionsDto {
        timeout_ms: Some(10_000),
        ..Default::default()
    };
    let r = s
        .request(0x22, &[0xF1, 0x90], &opts)
        .expect("legit long response");
    assert_eq!(r.raw.len(), len);
    assert_eq!(r.raw, payload);
    s.close();
}

#[test]
fn high07_1_classic_max_first_frame_4095_bytes_still_reassembles() {
    let _g = serial();
    if !vcan(false) {
        return;
    }
    legit_long_response(CLASSIC, false, 4095);
}

#[test]
fn high07_1_fd_escape_first_frame_below_cap_still_reassembles() {
    let _g = serial();
    if !vcan(true) {
        return;
    }
    const { assert!(MAX_RESPONSE_PDU >= 8_000) };
    legit_long_response(FD, true, 8_000);
}

// ─── HIGH-07.2: FC.WAIT forever ─────────────────────────────────────────────────────────────

#[test]
fn high07_2_ecu_answering_every_fc_with_wait_forever_times_out_and_releases_session() {
    let _g = serial();
    if !vcan(false) {
        return;
    }
    let waits = Arc::new(AtomicUsize::new(0));
    let stalling = Arc::new(AtomicBool::new(true));
    let _ecu = {
        let (waits, stalling) = (waits.clone(), stalling.clone());
        FakeEcu::start(
            CLASSIC,
            false,
            Box::new(move |data, bus| {
                if answer_tester_present(data, bus, false) {
                    return;
                }
                // First Frame of the request → FC.WAIT every 500 ms, forever (until released).
                if data.first().map(|b| b >> 4) == Some(1) {
                    while stalling.load(Ordering::Acquire) {
                        bus.send(&[0x31, 0x00, 0x00]);
                        waits.fetch_add(1, Ordering::AcqRel);
                        std::thread::sleep(Duration::from_millis(500));
                    }
                }
            }),
        )
    };

    wait_bus_quiet(CLASSIC, Duration::from_millis(50));
    let (port, _probe) = SocketCanPort::open(CLASSIC, false);
    let s = Arc::new(UdsSession::open(port, config(CLASSIC, false, false)).expect("open"));
    let s2 = s.clone();
    // 2E F1 90 + 17 bytes → multi-frame request (FF + CFs).
    let req: Vec<u8> = [0xF1, 0x90].into_iter().chain(0..17u8).collect();
    let outcome = bounded(Duration::from_secs(30), move || {
        s2.request(0x2E, &req, &UdsRequestOptionsDto::default())
    });
    // Release the stalled ECU thread so the fake ECU can answer the follow-up probe.
    stalling.store(false, Ordering::Release);
    let (res, took) =
        outcome.expect("request blocked > 30 s: FC.WAIT stall is not bounded (HIGH-07.2)");
    eprintln!(
        "FC.WAIT stall: {:?} after {took:?}, {} WAIT frames",
        res.as_ref().err(),
        waits.load(Ordering::Acquire)
    );
    let e = res.expect_err("must time out");
    assert_eq!(e.code, DiagErrorCode::TimeoutIsotp, "{e}");
    assert!(took < Duration::from_secs(15), "took {took:?}");
    let ev = s.conversation_since(0, 100);
    assert!(ev
        .events
        .iter()
        .any(|e| e.kind == ConversationEventKind::Timeout));

    // Session mutex released, stack rebuilt: the next request works.
    std::thread::sleep(Duration::from_millis(600));
    let r = s
        .request(0x3E, &[0x00], &UdsRequestOptionsDto::default())
        .expect("next request works");
    assert_eq!(r.raw, vec![0x7E, 0x00]);
    s.close();
}

// ─── HIGH-07.3: idle session must not answer someone else's First Frame ─────────────────────

#[test]
fn high07_3_idle_session_does_not_send_flow_control_for_foreign_first_frame() {
    let _g = serial();
    if !vcan(false) {
        return;
    }
    let ecu = FakeEcu::start(
        CLASSIC,
        false,
        Box::new(|data, bus| {
            let _ = answer_tester_present(data, bus, false);
        }),
    );
    wait_bus_quiet(CLASSIC, Duration::from_millis(50));
    let (port, probe) = SocketCanPort::open(CLASSIC, false);
    let s = UdsSession::open(port, config(CLASSIC, false, false)).expect("open");
    // One exchange so the ISO-TP stack (and its persistent receiver) exists; bus stays armed.
    assert_eq!(
        s.request(0x3E, &[0x00], &UdsRequestOptionsDto::default())
            .expect("3E")
            .raw,
        vec![0x7E, 0x00]
    );
    std::thread::sleep(Duration::from_millis(200));
    let before = probe.sent().len();

    // Another tester's ECU answer (FF) shows up on our response id while we are idle.
    ecu.bus
        .send(&[0x10, 0x14, 0x62, 0xF1, 0x90, b'W', b'N', b'X']);
    std::thread::sleep(Duration::from_millis(400));
    let after = probe.sent();
    eprintln!(
        "idle FF: tester frames sent after injection = {:?}",
        after[before..]
            .iter()
            .map(|f| f.payload().to_vec())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        after.len(),
        before,
        "idle session transmitted {} frame(s) (FC.CTS)",
        after.len() - before
    );

    // And the session still works afterwards.
    assert_eq!(
        s.request(0x3E, &[0x00], &UdsRequestOptionsDto::default())
            .expect("3E")
            .raw,
        vec![0x7E, 0x00]
    );
    s.close();
}
