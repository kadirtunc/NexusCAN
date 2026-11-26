//! C7 QA gate: contract cansub-v1 §5 L3 scenarios not (fully) covered by `cansub_sim.rs`
//! (S5 exact loss accounting, S6, S7, S8 at driver level) + pipeline-level Panic Stop budget
//! (`cmd_panic_stop_tx` → `abort_pending_tx` exactly once per panic, ≤ 100 ms).

use std::sync::Arc;
use std::time::{Duration, Instant};

use cansub::proto::{DecoderStats, Event};
use cansub::sim::{SimChaos, SimCloseKind, SimConfig, SimHandle, SimLog, SimSource};
use cansub::{ConnectOptions, Device};
use nexus_core::RawCanFrame;
use nexus_hal::traits::{AdapterDriver, BusState, CanChannel};
use nexus_hal::{CansubDriver, ChannelConfigDto, DriverRegistry, PipelineEngine};

const ID: &str = "aabbccdd";

fn sim_with(channels: u8, source: SimSource, chaos: SimChaos) -> SimHandle {
    SimHandle::start(SimConfig {
        channels,
        source,
        chaos,
        ..SimConfig::default()
    })
    .expect("sim start")
}

fn host(sim: &SimHandle) -> String {
    format!("127.0.0.1:{}", sim.addr().port())
}

fn driver(sim: &SimHandle) -> Arc<CansubDriver> {
    let root = sim.root_ca_der().to_vec();
    Arc::new(CansubDriver::with_connector(Arc::new(move |o| {
        Device::connect_with_root(o, &root)
    })))
}

fn open(
    drv: &CansubDriver,
    sim: &SimHandle,
    ch: u8,
    cfg: &ChannelConfigDto,
) -> Box<dyn CanChannel> {
    let descs = drv
        .add_known_host(&host(sim), Some(ID.into()), false)
        .unwrap();
    let d = descs
        .iter()
        .find(|d| d.device_id == format!("cansub:{ID}@{ch}"))
        .unwrap();
    drv.open_channel(d, cfg).expect("open")
}

fn wait_log(sim: &SimHandle, within: Duration, pred: impl Fn(&SimLog) -> bool) -> (SimLog, bool) {
    let deadline = Instant::now() + within;
    loop {
        let log = sim.log();
        if pred(&log) {
            return (log, true);
        }
        if Instant::now() > deadline {
            return (log, false);
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

/// Mock-sequence gap tracker. `mock_frame(ch, n)` puts `n` (u64 LE) into `data[0..8]` for every
/// non-RTR frame with ≥ 8 payload bytes (n % 10 ∈ {0,1,2,3,5,7,8}); the others (n % 10 ∈ {4,6,9})
/// sit at most 2 positions between two numbered frames.
#[derive(Default, Debug)]
struct Gaps {
    prev: Option<u64>,
    between: u64,
    received: u64,
    missing: u64,
    runs: Vec<u64>,
}

impl Gaps {
    fn feed(&mut self, len: usize, rtr: bool, data: &[u8]) {
        self.received += 1;
        if rtr || len < 8 {
            self.between += 1;
            return;
        }
        let n = u64::from_le_bytes(data[..8].try_into().unwrap());
        if let Some(p) = self.prev {
            assert!(n > p, "sequence regressed: {p} -> {n}");
            let expected = n - p - 1;
            assert!(
                self.between <= expected,
                "duplicate frames between {p} and {n}"
            );
            if self.between < expected {
                let m = expected - self.between;
                self.missing += m;
                self.runs.push(m);
            }
        }
        self.prev = Some(n);
        self.between = 0;
    }
}

/// Upper bound of mock frames inside one ≤ 1400 B HDLC (smallest serialized mock frame ≥ 9 B).
const MAX_FRAMES_PER_HDLC: u64 = 1400 / 9;

fn chaos_s5(seed: u64) -> SimChaos {
    SimChaos {
        split_ws: true,
        corrupt_crc: 0.01,
        garbage: 0.01,
        seed,
        ..SimChaos::default()
    }
}

fn sdk_drain(sim: &SimHandle, dur: Duration) -> (Gaps, DecoderStats, u64) {
    let dev = Device::connect_with_root(
        ConnectOptions {
            host: host(sim),
            device_id: Some(ID.into()),
            ..ConnectOptions::default()
        },
        sim.root_ca_der(),
    )
    .unwrap();
    let mut ch = dev.open(1).unwrap();
    let mut g = Gaps::default();
    let mut errors = 0u64;
    let deadline = Instant::now() + dur;
    while Instant::now() < deadline {
        ch.poll(Duration::from_millis(10), &mut |e| match e {
            Event::Frame(f) => g.feed(
                f.len(),
                f.flags.contains(cansub::proto::FrameFlags::RTR),
                &f.data,
            ),
            Event::Error { .. } => errors += 1,
        })
        .unwrap();
    }
    let st = ch.stats();
    ch.close(&dev).unwrap();
    (g, st, errors)
}

/// S5 (exact accounting, SDK decoder stats visible): split + garbage alone lose NOTHING; with 1 %
/// corrupted CRCs every loss run is bounded by whole corrupted HDLCs (runs ≤ crc_errors,
/// missing ≤ crc_errors × frames/HDLC); no overflow / truncation / panic.
#[test]
fn s5_chaos_loss_equals_corrupted_hdlcs_sdk() {
    // (a) split_ws + garbage, no CRC corruption: zero loss, garbage counted.
    let s = sim_with(
        2,
        SimSource::Mock { fps: 20_000 },
        SimChaos {
            split_ws: true,
            garbage: 0.05,
            seed: 11,
            ..SimChaos::default()
        },
    );
    let (g, st, errors) = sdk_drain(&s, Duration::from_secs(2));
    assert!(g.received > 20_000, "{g:?}");
    assert_eq!((g.missing, st.crc_errors), (0, 0), "{g:?} {st:?}");
    assert!(st.garbage_bytes > 0, "{st:?}");
    assert_eq!(
        (st.overflows, st.truncated_frames, errors),
        (0, 0, 0),
        "{st:?}"
    );
    drop(s);

    // (b) full S5 chaos.
    let mut total_crc = 0;
    for seed in [7u64, 99, 12345] {
        let s = sim_with(2, SimSource::Mock { fps: 20_000 }, chaos_s5(seed));
        let (g, st, errors) = sdk_drain(&s, Duration::from_secs(3));
        eprintln!(
            "S5 seed {seed}: received {} missing {} runs {} crc_errors {} hdlc_ok {} garbage {}",
            g.received,
            g.missing,
            g.runs.len(),
            st.crc_errors,
            st.hdlc_ok,
            st.garbage_bytes
        );
        assert!(g.received > 30_000, "{g:?}");
        assert_eq!(
            (st.overflows, st.truncated_frames, errors),
            (0, 0, 0),
            "{st:?}"
        );
        assert!(
            g.runs.len() as u64 <= st.crc_errors,
            "loss runs without CRC errors: {g:?} {st:?}"
        );
        assert!(
            g.missing <= st.crc_errors * MAX_FRAMES_PER_HDLC,
            "loss beyond corrupted HDLCs: {g:?} {st:?}"
        );
        if st.crc_errors > 0 {
            assert!(g.missing > 0, "CRC errors but nothing lost? {g:?} {st:?}");
        }
        total_crc += st.crc_errors;
    }
    assert!(
        total_crc > 0,
        "chaos never corrupted a CRC (test not exercising S5)"
    );
}

/// S5 at driver level (`recv_batch`): same chaos, the driver never panics, delivers every frame of
/// every intact HDLC (loss bounded as above, `crc_errors` not observable through `CanChannel`).
#[test]
fn s5_chaos_driver_recv_batch_no_panic_bounded_loss() {
    let s = sim_with(2, SimSource::Mock { fps: 20_000 }, chaos_s5(7));
    let drv = driver(&s);
    let mut ch = open(&drv, &s, 1, &ChannelConfigDto::default());
    let mut buf = [RawCanFrame::zeroed(); 256];
    let mut g = Gaps::default();
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(3) {
        let n = ch.recv_batch(&mut buf, 5).unwrap();
        for f in &buf[..n] {
            assert!(!f.is_error(), "unexpected error frame");
            g.feed(usize::from(f.dlc), f.is_rtr(), &f.data);
        }
    }
    eprintln!(
        "S5 driver: received {} missing {} runs {}",
        g.received,
        g.missing,
        g.runs.len()
    );
    assert!(g.received > 40_000, "{g:?}");
    // ~1 % of ~1.4 k HDLC/s over 3 s → expected ~40 corrupted HDLCs; allow generous bound.
    assert!(g.runs.len() < 200, "{g:?}");
    assert!(
        g.runs.iter().all(|&r| r <= 4 * MAX_FRAMES_PER_HDLC),
        "{:?}",
        g.runs
    );
    ch.close().unwrap();
}

/// S6: wrong Device ID → TLS error naming the IDs; IP + no Device ID + no accept-any → "Device ID"
/// prompt before any handshake; also through `open_channel` with `network_host`.
#[test]
fn s6_wrong_device_id_and_ip_without_id() {
    let s = sim_with(2, SimSource::Silent, SimChaos::default());
    let drv = driver(&s);
    let err = drv
        .add_known_host(&host(&s), Some("11223344".into()), false)
        .unwrap_err()
        .to_string();
    assert!(err.contains("TLS"), "{err}");
    eprintln!("S6 wrong id: {err}");

    let before = s.log().requests.len();
    let err = drv
        .add_known_host(&host(&s), None, false)
        .unwrap_err()
        .to_string();
    eprintln!("S6 ip without id: {err}");
    assert!(err.contains("Device ID"), "{err}");
    assert_eq!(
        s.log().requests.len(),
        before,
        "a request was made without identity"
    );

    // Malformed Device ID → readable, no connect.
    let err = drv
        .add_known_host(&host(&s), Some("zz".into()), false)
        .unwrap_err()
        .to_string();
    assert!(err.contains("8 hex"), "{err}");

    // open_channel path: network_host + wrong network_device_id.
    let desc = nexus_hal::drivers::cansub_drv::cansub_descriptor(ID, &host(&s), 2, 1);
    let cfg = ChannelConfigDto {
        network_host: Some(host(&s)),
        network_device_id: Some("deadbeef".into()),
        ..ChannelConfigDto::default()
    };
    let err = drv
        .open_channel(&desc, &cfg)
        .err()
        .expect("must fail")
        .to_string();
    assert!(err.contains("TLS"), "{err}");

    // accept_any with IP works (warned mode).
    let ok = drv
        .add_known_host(&host(&s), None, true)
        .expect("accept-any");
    assert_eq!(ok.len(), 2);
}

/// S7: second client on the same channel → Busy (readable); sim stop → first channel goes
/// Disconnected, `recv_batch` / `send_frame` / `close` never panic.
#[test]
fn s7_second_client_busy_then_sim_gone() {
    let s = sim_with(2, SimSource::Mock { fps: 1000 }, SimChaos::default());
    let a = driver(&s);
    let b = driver(&s);
    let cfg = ChannelConfigDto {
        listen_only: false,
        ..ChannelConfigDto::default()
    };
    let mut ch1 = open(&a, &s, 1, &cfg);
    let descs = b.add_known_host(&host(&s), Some(ID.into()), false).unwrap();
    let err = b
        .open_channel(&descs[0], &ChannelConfigDto::default())
        .err()
        .expect("second client must be refused")
        .to_string();
    eprintln!("S7 busy: {err}");
    assert!(
        err.to_ascii_lowercase().contains("busy") || err.contains("in use"),
        "{err}"
    );
    // Channel 2 is still free for the second client.
    let mut ch2 = b
        .open_channel(&descs[1], &ChannelConfigDto::default())
        .expect("ch2");

    let mut buf = [RawCanFrame::zeroed(); 64];
    assert!(ch1.recv_batch(&mut buf, 50).unwrap() > 0);
    s.stop();
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        let _ = ch1.recv_batch(&mut buf, 5);
        let _ = ch2.recv_batch(&mut buf, 5);
        if ch1.health().state == BusState::Disconnected
            && ch2.health().state == BusState::Disconnected
        {
            break;
        }
        assert!(Instant::now() < deadline, "never Disconnected");
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut f = RawCanFrame::zeroed();
    f.arb_id = 0x10;
    f.dlc = 1;
    assert!(ch1.send_frame(&f).is_err());
    let _ = ch1.close();
    let _ = ch2.close();
}

/// S8: close order §2.7 — normal: WS close confirmed, no DELETE; with `close_ack_delay = 800 ms`:
/// close → ~500 ms → `DELETE /ws` (session logged as `Delete`), total < ~1.2 s.
#[test]
fn s8_close_sequence_driver_level() {
    let s = sim_with(2, SimSource::Mock { fps: 1000 }, SimChaos::default());
    let drv = driver(&s);
    let mut ch = open(&drv, &s, 1, &ChannelConfigDto::default());
    let t0 = Instant::now();
    ch.close().unwrap();
    let took = t0.elapsed();
    let (log, ok) = wait_log(&s, Duration::from_secs(2), |l| !l.ws_closes.is_empty());
    assert!(ok, "{log:?}");
    assert_eq!(log.ws_closes, vec![(1, SimCloseKind::WsClose)]);
    assert!(!log
        .requests
        .iter()
        .any(|r| r.method == "DELETE" && r.path == "/api/can/1/ws"));
    assert!(
        took < nexus_core::testing::scaled(Duration::from_millis(400)),
        "normal close took {took:?}"
    );

    let s = sim_with(
        2,
        SimSource::Mock { fps: 1000 },
        SimChaos {
            close_ack_delay: Some(Duration::from_millis(800)),
            ..SimChaos::default()
        },
    );
    let drv = driver(&s);
    let mut ch = open(&drv, &s, 1, &ChannelConfigDto::default());
    let t0 = Instant::now();
    ch.close().unwrap();
    let took = t0.elapsed();
    let (log, ok) = wait_log(&s, Duration::from_secs(2), |l| !l.ws_closes.is_empty());
    assert!(ok, "{log:?}");
    eprintln!("S8 delayed-ack close took {took:?}");
    assert_eq!(log.ws_closes, vec![(1, SimCloseKind::Delete)]);
    assert!(log
        .requests
        .iter()
        .any(|r| r.method == "DELETE" && r.path == "/api/can/1/ws"));
    assert!(
        took >= Duration::from_millis(480)
            && took < nexus_core::testing::scaled(Duration::from_millis(1200)),
        "§2.7 timing: {took:?}"
    );
}

fn pipeline_with(sim: &SimHandle) -> PipelineEngine {
    let mut reg = DriverRegistry::new();
    reg.register_cansub(driver(sim));
    PipelineEngine::with_registry(reg)
}

fn count(log: &SimLog, method: &str, path_prefix: &str) -> usize {
    log.requests
        .iter()
        .filter(|r| r.method == method && r.path.starts_with(path_prefix))
        .count()
}

fn listen_only_puts(log: &SimLog) -> usize {
    log.requests
        .iter()
        .filter(|r| {
            r.method == "PUT"
                && r.path == "/api/can/1/phy"
                && r.body.replace(' ', "").contains("\"listen_only\":true")
        })
        .count()
}

/// Item 5: pipeline `cmd_panic_stop_tx` → sim sees `DELETE /ws`, transmit DELETEs and a
/// `listen_only: true` PHY within 100 ms; `abort_pending_tx` fires exactly once per panic (a
/// second Panic Stop without Clear fires once more; idle polling never re-fires).
#[test]
fn panic_stop_pipeline_budget_and_exactly_once() {
    let s = sim_with(2, SimSource::Mock { fps: 1000 }, SimChaos::default());
    let engine = pipeline_with(&s);
    engine
        .cmd_connect_bus(
            format!("cansub:{ID}@1"),
            ChannelConfigDto {
                bus_id: 0,
                listen_only: false,
                network_host: Some(host(&s)),
                ..ChannelConfigDto::default()
            },
        )
        .expect("connect cansub bus");
    engine.cmd_arm_active_bus(0, true).expect("arm");
    // Real TX through the pipeline (TX-ack loop).
    engine
        .cmd_transmit_raw_frame(0, 0x321, false, false, false, vec![1, 2, 3], None, None)
        .expect("tx");
    let side = Device::connect_with_root(
        ConnectOptions {
            host: host(&s),
            device_id: Some(ID.into()),
            ..ConnectOptions::default()
        },
        s.root_ca_der(),
    )
    .unwrap();
    let job = r#"{"limit":10,"period_ms":1000,"spacing_ms":1,"frames":[{"is_extended":false,"is_fd":false,"is_rtr_brs":false,"id":1,"data":"01020304"}]}"#;
    for _ in 0..2 {
        assert_eq!(
            side.raw_request("POST", "/api/can/1/transmit", Some(job))
                .unwrap()
                .0,
            201
        );
    }
    let (_, ok) = wait_log(&s, Duration::from_secs(2), |l| l.received_tx[0] >= 1);
    assert!(ok, "TX never reached the sim");
    let base = s.log();
    let (ws0, lo0) = (
        count(&base, "DELETE", "/api/can/1/ws"),
        listen_only_puts(&base),
    );

    let t0 = Instant::now();
    let r = engine.cmd_panic_stop_tx();
    let (log, ok) = wait_log(&s, Duration::from_millis(500), |l| {
        count(l, "DELETE", "/api/can/1/ws") > ws0
            && count(l, "DELETE", "/api/can/1/transmit/") >= 2
            && listen_only_puts(l) > lo0
    });
    let took = t0.elapsed();
    eprintln!("Panic Stop pipeline → sim evidence in {took:?} ({r:?})");
    assert!(
        ok,
        "panic evidence incomplete: {:?}",
        &log.requests[base.requests.len()..]
    );
    assert!(
        took <= nexus_core::testing::scaled(Duration::from_millis(100)),
        "Panic Stop budget: {took:?}"
    );

    // Exactly once: idle for 1 s (bus-io polls ~1 kHz), no further abort.
    std::thread::sleep(Duration::from_secs(1));
    let log = s.log();
    assert_eq!(
        count(&log, "DELETE", "/api/can/1/ws") - ws0,
        1,
        "abort fired more than once"
    );
    assert_eq!(listen_only_puts(&log) - lo0, 1);

    // Second Panic Stop without Clear → exactly one more abort.
    engine.cmd_panic_stop_tx();
    std::thread::sleep(Duration::from_millis(800));
    let log = s.log();
    assert_eq!(
        count(&log, "DELETE", "/api/can/1/ws") - ws0,
        2,
        "second panic must abort once"
    );
    // Clear latch → no abort.
    engine.cmd_clear_panic_latch();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(count(&s.log(), "DELETE", "/api/can/1/ws") - ws0, 2);
    // TX after panic is refused (latch cleared but bus disarmed / channel panic-listen-only).
    assert!(engine
        .cmd_transmit_raw_frame(0, 0x321, false, false, false, vec![1], None, None)
        .is_err());
    engine.cmd_disconnect_bus(0).unwrap();
}

/// UI bitrate matrix (`connectionStore.ts` BITRATES × DATA_BITRATES_FD) vs the driver's fixed
/// 80 % sample point (`cansub_drv.rs` SAMPLE_POINT_PERMILLE). Prints unsupported combos; only the
/// automotive defaults are asserted (findings reported, not enforced here).
#[test]
fn ui_bitrate_matrix_vs_driver_timing() {
    let nominal = [
        50_000u32, 100_000, 125_000, 250_000, 500_000, 800_000, 1_000_000,
    ];
    let data = [1_000_000u32, 2_000_000, 4_000_000, 5_000_000, 8_000_000];
    let mut bad = Vec::new();
    for n in nominal {
        if cansub::timing::nominal_timing(n, 800).is_none() {
            bad.push(format!("classic {n}"));
        }
        for d in data {
            if d > n && cansub::timing::fd_timing(n, d, 800).is_none() {
                let alt = [812u16, 750, 875]
                    .iter()
                    .find(|&&sp| cansub::timing::fd_timing(n, d, sp).is_some());
                bad.push(format!("fd {n}/{d} (alt SP {alt:?})"));
            }
        }
    }
    eprintln!("UI combos rejected by driver @80% SP: {bad:?}");
    assert!(cansub::timing::fd_timing(500_000, 2_000_000, 800).is_some());
    assert!(cansub::timing::nominal_timing(500_000, 800).is_some());
}
