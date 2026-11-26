//! L3 acceptance tests: SDK client (`cansub::client`) against `cansub-sim` over real TLS 1.2 +
//! HTTP/1.1 + WSS. Contract cansub-v1 §3.3 / §5 (scenarios 1, 2, 3, 6, 7, 8), work package C3a.
#![cfg(feature = "sim")]

use std::time::{Duration, Instant};

use cansub::proto::{CanFrame, Event, FrameFlags};
use cansub::sim::{SimChaos, SimCloseKind, SimConfig, SimHandle, SimLog, SimSource};
use cansub::{ConnectOptions, Device, Error, PhyConfig};

const ID: &str = "aabbccdd";

fn sim(channels: u8, source: SimSource, chaos: SimChaos) -> SimHandle {
    SimHandle::start(SimConfig {
        channels,
        source,
        chaos,
        ..SimConfig::default()
    })
    .expect("sim start")
}

fn opts(sim: &SimHandle, device_id: Option<&str>, accept_any: bool) -> ConnectOptions {
    ConnectOptions {
        host: format!("127.0.0.1:{}", sim.addr().port()),
        device_id: device_id.map(str::to_string),
        accept_any_device: accept_any,
        ..ConnectOptions::default()
    }
}

fn connect(sim: &SimHandle) -> Device {
    Device::connect_with_root(opts(sim, Some(ID), false), sim.root_ca_der()).expect("connect")
}

/// Polls the sim log until `pred` holds (≤ 2 s).
fn wait_log(sim: &SimHandle, pred: impl Fn(&SimLog) -> bool) -> SimLog {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let log = sim.log();
        if pred(&log) || Instant::now() > deadline {
            return log;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn frame(id: u32, data: &[u8]) -> CanFrame {
    let mut f = CanFrame {
        timestamp_us: 0,
        id,
        flags: FrameFlags::default(),
        dlc: data.len() as u8,
        data: [0; 64],
    };
    f.data[..data.len()].copy_from_slice(data);
    f
}

#[test]
fn s1_connect_lists_channels() {
    for n in [2u8, 4] {
        let sim = sim(n, SimSource::Silent, SimChaos::default());
        let dev = connect(&sim);
        let info = dev.info();
        assert_eq!(info.channels, n);
        assert_eq!(info.id, ID);
        assert_eq!(info.variant, format!("CANsub.{n}"));
        assert!(info.api.starts_with("05."), "{}", info.api);
        assert!(!info.hw.is_empty() && !info.fw.is_empty());
        let st = dev.channel_status(1).unwrap();
        assert_eq!(st.state, cansub::client::CanState::Stopped);
        assert!(matches!(dev.channel_status(n + 1), Err(Error::Protocol(_))));
        dev.set_time_now().unwrap();
        let log = sim.log();
        assert!(log
            .requests
            .iter()
            .any(|r| r.method == "PUT" && r.path == "/api/time" && r.body.contains("\"utc\"")));
        // PTP is "disabled" after a manual set -> second call writes again (not tracking).
        dev.set_time_now().unwrap();
    }
}

#[test]
fn s2_listen_only_default_then_armed_tx_ack() {
    let sim = sim(2, SimSource::Silent, SimChaos::default());
    let dev = connect(&sim);
    dev.configure(1, &PhyConfig::default()).unwrap();
    let log = sim.log();
    let put = log
        .requests
        .iter()
        .find(|r| r.method == "PUT" && r.path == "/api/can/1/phy")
        .expect("PUT /phy logged");
    let body: serde_json::Value = serde_json::from_str(&put.body).unwrap();
    assert_eq!(body["listen_only"], true);
    for k in [
        "auto_reset",
        "error_frames",
        "tx_ack_frames",
        "timing",
        "timing_data",
    ] {
        assert!(body.get(k).is_some(), "full PhyConfig: missing {k}");
    }

    let mut ch = dev.open(1).unwrap();
    let tx: Vec<CanFrame> = (0..5).map(|i| frame(0x100 + i, &[i as u8; 8])).collect();
    ch.send(&tx).unwrap();
    let log = wait_log(&sim, |l| l.dropped_tx[0] >= 5);
    assert_eq!(log.dropped_tx[0], 5, "listen-only TX must be dropped");
    assert_eq!(log.received_tx[0], 0);

    let armed = PhyConfig {
        listen_only: false,
        tx_ack_frames: true,
        ..PhyConfig::default()
    };
    dev.configure(1, &armed).unwrap();
    ch.send(&[frame(0x7AB, &[1, 2, 3])]).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut ack = None;
    while ack.is_none() && Instant::now() < deadline {
        ch.poll(Duration::from_millis(20), &mut |e| {
            if let Event::Frame(f) = e {
                if f.flags.contains(FrameFlags::TX_ACK) {
                    ack = Some(f);
                }
            }
        })
        .unwrap();
    }
    let ack = ack.expect("TX ack frame");
    assert_eq!((ack.id, ack.payload()), (0x7AB, &[1u8, 2, 3][..]));
    assert_eq!(sim.log().received_tx[0], 1);
    ch.close(&dev).unwrap();
}

#[test]
fn s3_panic_stop_under_100ms() {
    let sim = sim(2, SimSource::Mock { fps: 1000 }, SimChaos::default());
    let dev = connect(&sim);
    let job = r#"{"limit":10,"period_ms":1000,"spacing_ms":1,"frames":[{"is_extended":false,"is_fd":false,"is_rtr_brs":false,"id":1,"data":"01020304"}]}"#;
    for _ in 0..2 {
        let (status, _) = dev
            .raw_request("POST", "/api/can/1/transmit", Some(job))
            .unwrap();
        assert_eq!(status, 201);
    }
    let armed = PhyConfig {
        listen_only: false,
        ..PhyConfig::default()
    };
    dev.configure(1, &armed).unwrap();
    let mut ch = dev.open(1).unwrap();
    ch.poll(Duration::from_millis(50), &mut |_| {}).unwrap();

    let t0 = Instant::now();
    dev.abort_ws(1).unwrap();
    let deleted = dev.delete_transmit_jobs(1).unwrap();
    dev.configure(1, &PhyConfig::default()).unwrap();
    let took = t0.elapsed();
    assert_eq!(deleted, 2);
    assert!(
        took < Duration::from_millis(100),
        "panic stop took {took:?}"
    );

    let log = wait_log(&sim, |l| l.ws_closes.contains(&(1, SimCloseKind::Delete)));
    assert!(log.ws_closes.contains(&(1, SimCloseKind::Delete)));
    assert!(log
        .requests
        .iter()
        .any(|r| r.method == "DELETE" && r.path == "/api/can/1/ws"));
    assert_eq!(
        log.requests
            .iter()
            .filter(|r| r.method == "DELETE" && r.path.starts_with("/api/can/1/transmit/"))
            .count(),
        2
    );
    let last_phy = log
        .requests
        .iter()
        .rev()
        .find(|r| r.path == "/api/can/1/phy")
        .unwrap();
    assert!(last_phy.body.contains("\"listen_only\":true"));
    assert_eq!(
        dev.raw_request("GET", "/api/can/1/transmit", None)
            .unwrap()
            .1,
        "[]"
    );
    // The aborted session now reports an error instead of data.
    let mut ended = false;
    for _ in 0..50 {
        if ch.poll(Duration::from_millis(20), &mut |_| {}).is_err() {
            ended = true;
            break;
        }
    }
    assert!(ended, "poll after DELETE /ws must fail");
}

#[test]
fn s6_tls_identity_rules() {
    let sim = sim(2, SimSource::Silent, SimChaos::default());
    match Device::connect_with_root(opts(&sim, Some("11223344"), false), sim.root_ca_der()) {
        Err(Error::Tls(m)) => assert!(m.contains("11223344"), "{m}"),
        other => panic!("wrong device id: {other:?}"),
    }
    match Device::connect_with_root(opts(&sim, None, false), sim.root_ca_der()) {
        Err(Error::Tls(m)) => assert!(m.contains("Device ID"), "{m}"),
        other => panic!("IP without identity: {other:?}"),
    }
    let dev = Device::connect_with_root(opts(&sim, None, true), sim.root_ca_der())
        .expect("accept_any_device");
    assert_eq!(dev.info().id, ID);
    // Production root (CSS) does not trust the sim's run-time CA.
    assert!(matches!(
        Device::connect(opts(&sim, Some(ID), false)),
        Err(Error::Tls(_))
    ));
    // Hostname rule (§2.6 rule 3): a DNS name the certificate carries, resolved to the sim.
    let o = ConnectOptions {
        host: format!("localhost:{}", sim.addr().port()),
        ..opts(&sim, None, false)
    };
    // `localhost` is not in the SAN list -> handshake fails with a TLS error (not a panic / IO).
    assert!(matches!(
        Device::connect_with_root(o, sim.root_ca_der()),
        Err(Error::Tls(_)) | Err(Error::Io(_))
    ));
}

#[test]
fn s7_busy_and_sim_stop() {
    let sim = sim(2, SimSource::Mock { fps: 500 }, SimChaos::default());
    let dev = connect(&sim);
    let mut ch = dev.open(2).unwrap();
    assert!(matches!(dev.open(2), Err(Error::Busy)));
    let mut got = 0;
    let deadline = Instant::now() + Duration::from_secs(2);
    while got == 0 && Instant::now() < deadline {
        got += ch.poll(Duration::from_millis(20), &mut |_| {}).unwrap();
    }
    assert!(got > 0);
    sim.stop();
    let mut failed = false;
    for _ in 0..100 {
        if ch.poll(Duration::from_millis(20), &mut |_| {}).is_err() {
            failed = true;
            break;
        }
    }
    assert!(failed, "poll after sim stop must fail");
    assert!(ch.send(&[frame(1, &[])]).is_err());
    assert!(dev.channel_status(1).is_err());
    drop(ch); // best-effort close against a dead device: no panic, bounded
}

#[test]
fn s8_close_sequence() {
    let sim1 = sim(2, SimSource::Mock { fps: 1000 }, SimChaos::default());
    let dev = connect(&sim1);
    let ch = dev.open(1).unwrap();
    let t0 = Instant::now();
    ch.close(&dev).unwrap();
    assert!(
        t0.elapsed() < Duration::from_millis(400),
        "{:?}",
        t0.elapsed()
    );
    let log = wait_log(&sim1, |l| !l.ws_closes.is_empty());
    assert_eq!(log.ws_closes, vec![(1, SimCloseKind::WsClose)]);
    assert!(!log.requests.iter().any(|r| r.method == "DELETE"));
    // The channel is free again.
    dev.open(1).unwrap().close(&dev).unwrap();

    let sim2 = sim(
        2,
        SimSource::Mock { fps: 1000 },
        SimChaos {
            close_ack_delay: Some(Duration::from_millis(800)),
            ..SimChaos::default()
        },
    );
    let dev = connect(&sim2);
    let ch = dev.open(2).unwrap();
    let t0 = Instant::now();
    ch.close(&dev).unwrap();
    let took = t0.elapsed();
    assert!(
        (Duration::from_millis(500)..Duration::from_millis(1500)).contains(&took),
        "{took:?}"
    );
    let log = wait_log(&sim2, |l| !l.ws_closes.is_empty());
    assert_eq!(log.ws_closes, vec![(2, SimCloseKind::Delete)]);
    assert!(log
        .requests
        .iter()
        .any(|r| r.method == "DELETE" && r.path == "/api/can/2/ws"));
}

fn drain(ch: &mut cansub::Channel, dur: Duration) -> (usize, usize) {
    let (mut frames, mut errors) = (0, 0);
    let deadline = Instant::now() + dur;
    while Instant::now() < deadline {
        ch.poll(Duration::from_millis(10), &mut |e| match e {
            Event::Frame(_) => frames += 1,
            Event::Error { .. } => errors += 1,
        })
        .unwrap();
    }
    (frames, errors)
}

#[test]
fn s5_throughput_and_chaos() {
    let sim1 = sim(2, SimSource::Mock { fps: 5000 }, SimChaos::default());
    let dev = connect(&sim1);
    let mut ch = dev.open(1).unwrap();
    let (frames, _) = drain(&mut ch, Duration::from_secs(1));
    let st = ch.stats();
    assert!(frames >= 4000, "only {frames} frames in 1 s");
    assert_eq!(st.crc_errors, 0);
    assert_eq!(st.garbage_bytes, 0);
    ch.close(&dev).unwrap();

    let sim2 = sim(
        2,
        SimSource::Mock { fps: 5000 },
        SimChaos {
            split_ws: true,
            corrupt_crc: 0.01,
            garbage: 0.01,
            seed: 7,
            ..SimChaos::default()
        },
    );
    let dev = connect(&sim2);
    let mut ch = dev.open(1).unwrap();
    let (frames, errors) = drain(&mut ch, Duration::from_secs(1));
    let st = ch.stats();
    assert_eq!(errors, 0);
    // Every good HDLC carries ≥ 1 frame; loss is bounded by the corrupted HDLCs (≤ 1400 B each,
    // i.e. < 100 frames of the mock mix). ~125 HDLCs/s at 5 kfps, so crc_errors may be 0 here.
    assert!(
        st.hdlc_ok > 0 && frames as u64 >= st.hdlc_ok,
        "{frames} vs {st:?}"
    );
    assert!(
        frames as u64 + 100 * st.crc_errors >= 4000,
        "loss beyond corrupted HDLCs: {frames} frames, {st:?}"
    );
    assert_eq!((st.overflows, st.truncated_frames), (0, 0), "{st:?}");
    ch.close(&dev).unwrap();
}
