//! C4a: `CansubDriver` against the in-process `cansub-sim` (real TLS 1.2 + REST + WSS).
//! Contract cansub-v1 §3.4, §5 scenarios 1, 2, 3, 4, 7.

use std::sync::Arc;
use std::time::{Duration, Instant};

use cansub::sim::{SimChaos, SimConfig, SimHandle, SimLog, SimSource};
use cansub::Device;
use nexus_core::{RawCanFrame, FLAG_HW_TIMESTAMP, FLAG_TX};
use nexus_hal::traits::{AdapterDriver, BusState, CanChannel, ListenOnlyEnforcement};
use nexus_hal::{AdapterError, CansubDriver, ChannelConfigDto, DriverRegistry};

const ID: &str = "aabbccdd";

fn sim(channels: u8, source: SimSource) -> SimHandle {
    SimHandle::start(SimConfig {
        channels,
        source,
        chaos: SimChaos::default(),
        ..SimConfig::default()
    })
    .expect("sim start")
}

fn host(sim: &SimHandle) -> String {
    format!("127.0.0.1:{}", sim.addr().port())
}

/// Driver trusting the sim's run-time root (SDK test-only path) instead of the CSS root.
fn driver(sim: &SimHandle) -> Arc<CansubDriver> {
    let root = sim.root_ca_der().to_vec();
    Arc::new(CansubDriver::with_connector(Arc::new(move |o| {
        Device::connect_with_root(o, &root)
    })))
}

fn wait_log(sim: &SimHandle, pred: impl Fn(&SimLog) -> bool) -> SimLog {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let log = sim.log();
        if pred(&log) || Instant::now() > deadline {
            return log;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn phy_puts(log: &SimLog, ch: u8) -> Vec<String> {
    let path = format!("/api/can/{ch}/phy");
    log.requests
        .iter()
        .filter(|r| r.method == "PUT" && r.path == path)
        .map(|r| r.body.replace(' ', ""))
        .collect()
}

fn assert_full_phy(body: &str, listen_only: bool) {
    for k in [
        "\"auto_reset\"",
        "\"error_frames\":true",
        "\"tx_ack_frames\":true",
        "\"timing\"",
        "\"timing_data\"",
    ] {
        assert!(body.contains(k), "missing {k} in {body}");
    }
    assert!(
        body.contains(&format!("\"listen_only\":{listen_only}")),
        "{body}"
    );
}

fn open(drv: &CansubDriver, sim: &SimHandle, ch: u8, cfg: ChannelConfigDto) -> Box<dyn CanChannel> {
    let descs = drv
        .add_known_host(&host(sim), Some(ID.into()), false)
        .unwrap();
    let d = descs
        .iter()
        .find(|d| d.device_id == format!("cansub:{ID}@{ch}"))
        .unwrap();
    drv.open_channel(d, &cfg).expect("open")
}

fn tx_frame(id: u32, data: &[u8]) -> RawCanFrame {
    let mut f = RawCanFrame::zeroed();
    f.arb_id = id;
    f.dlc = data.len() as u8;
    f.data[..data.len()].copy_from_slice(data);
    f
}

#[test]
fn t1_known_host_lists_all_channels() {
    let s = sim(4, SimSource::Silent);
    let drv = driver(&s);
    let descs = drv
        .add_known_host(&host(&s), Some(ID.into()), false)
        .unwrap();
    assert_eq!(descs.len(), 4);
    for (i, d) in descs.iter().enumerate() {
        let ch = i + 1;
        assert_eq!(d.device_id, format!("cansub:{ID}@{ch}"));
        assert_eq!(d.driver_id, "cansub");
        assert_eq!(d.channel_name, format!("{}@{ch}", host(&s)));
        assert_eq!(d.display_name, format!("CANsub.4 {ID} CH{ch}"));
        assert!(d.capabilities.supports_fd);
        assert!(d.capabilities.supports_hw_timestamps);
        assert!(d.capabilities.supports_listen_only);
        assert!(!d.capabilities.is_virtual);
    }
    // Discovery (mDNS disabled for the test driver) returns the remembered host.
    assert_eq!(drv.discover_devices().unwrap(), descs);
    // 2-channel variant.
    let s2 = sim(2, SimSource::Silent);
    let d2 = driver(&s2)
        .add_known_host(&host(&s2), Some(ID.into()), false)
        .unwrap();
    assert_eq!(d2.len(), 2);
    assert_eq!(d2[0].display_name, format!("CANsub.2 {ID} CH1"));
    // Wrong Device ID -> readable TLS error.
    let err = driver(&s2)
        .add_known_host(&host(&s2), Some("11223344".into()), false)
        .unwrap_err()
        .to_string();
    assert!(err.contains("TLS"), "{err}");
}

#[test]
fn t2_default_open_is_hardware_listen_only() {
    let s = sim(2, SimSource::Silent);
    let drv = driver(&s);
    let mut ch = open(&drv, &s, 1, ChannelConfigDto::default());
    let log = wait_log(&s, |l| !phy_puts(l, 1).is_empty());
    let puts = phy_puts(&log, 1);
    assert_eq!(puts.len(), 1, "{puts:?}");
    assert_full_phy(&puts[0], true);
    assert!(matches!(
        ch.send_frame(&tx_frame(0x123, &[1])),
        Err(AdapterError::ListenOnlyMode)
    ));
    assert_eq!(
        ch.listen_only_enforcement(),
        ListenOnlyEnforcement::Hardware
    );
    assert_eq!(s.log().received_tx[0] + s.log().dropped_tx[0], 0);
    ch.close().unwrap();
}

#[test]
fn t3_armed_tx_returns_tx_ack_with_hw_timestamp() {
    let s = sim(2, SimSource::Silent);
    let drv = driver(&s);
    let cfg = ChannelConfigDto {
        listen_only: false,
        ..ChannelConfigDto::default()
    };
    let mut ch = open(&drv, &s, 1, cfg);
    assert_full_phy(&phy_puts(&s.log(), 1)[0], false);
    ch.send_frame(&tx_frame(0x7AB, &[1, 2, 3])).unwrap();
    let mut buf = [RawCanFrame::zeroed(); 64];
    let deadline = Instant::now() + Duration::from_secs(2);
    let ack = loop {
        let n = ch.recv_batch(&mut buf, 10).unwrap();
        if let Some(f) = buf[..n].iter().find(|f| f.is_tx()) {
            break *f;
        }
        assert!(Instant::now() < deadline, "no TX-ack");
    };
    assert_eq!(
        ack.flags & (FLAG_TX | FLAG_HW_TIMESTAMP),
        FLAG_TX | FLAG_HW_TIMESTAMP
    );
    assert_eq!((ack.arb_id, ack.payload()), (0x7AB, &[1u8, 2, 3][..]));
    // Host clock was written at open -> unix-µs timestamps near now.
    let now_us = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as u64;
    assert!(
        ack.timestamp_us.abs_diff(now_us) < 10_000_000,
        "{}",
        ack.timestamp_us
    );
    ch.close().unwrap();
}

#[test]
fn t4_abort_pending_tx_under_100ms() {
    let s = sim(2, SimSource::Mock { fps: 1000 });
    let drv = driver(&s);
    let cfg = ChannelConfigDto {
        listen_only: false,
        ..ChannelConfigDto::default()
    };
    let mut ch = open(&drv, &s, 1, cfg);
    // Two device-resident transmit jobs (as another tool / future feature would create).
    let job = r#"{"limit":10,"period_ms":1000,"spacing_ms":1,"frames":[{"is_extended":false,"is_fd":false,"is_rtr_brs":false,"id":1,"data":"01020304"}]}"#;
    let side = Device::connect_with_root(
        cansub::ConnectOptions {
            host: host(&s),
            device_id: Some(ID.into()),
            ..cansub::ConnectOptions::default()
        },
        s.root_ca_der(),
    )
    .unwrap();
    for _ in 0..2 {
        assert_eq!(
            side.raw_request("POST", "/api/can/1/transmit", Some(job))
                .unwrap()
                .0,
            201
        );
    }
    let mut buf = [RawCanFrame::zeroed(); 64];
    ch.recv_batch(&mut buf, 50).unwrap();
    let before = s.log().requests.len();

    let t0 = Instant::now();
    ch.abort_pending_tx().unwrap();
    let took = t0.elapsed();
    assert!(took < Duration::from_millis(100), "abort took {took:?}");

    let log = s.log();
    let new = &log.requests[before..];
    let pos = |pred: &dyn Fn(&cansub::sim::SimRequest) -> bool| new.iter().position(pred);
    let del_ws = pos(&|r| r.method == "DELETE" && r.path == "/api/can/1/ws").expect("DELETE /ws");
    let del_tx = new
        .iter()
        .filter(|r| r.method == "DELETE" && r.path.starts_with("/api/can/1/transmit/"))
        .count();
    assert_eq!(del_tx, 2, "{new:?}");
    let phy = pos(&|r| r.method == "PUT" && r.path == "/api/can/1/phy").expect("PUT /phy");
    assert!(del_ws < phy);
    assert_full_phy(&new[phy].body.replace(' ', ""), true);

    // TX is refused afterwards; RX resumes on a fresh WebSocket (listen-only).
    assert!(ch.send_frame(&tx_frame(0x10, &[0])).is_err());
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut got = 0;
    while got == 0 && Instant::now() < deadline {
        got += ch.recv_batch(&mut buf, 10).unwrap();
    }
    assert!(got > 0, "RX did not resume after Panic Stop");
    ch.close().unwrap();
}

#[test]
fn t5_mock_5000fps_no_loss_then_disconnect() {
    let s = sim(2, SimSource::Mock { fps: 5000 });
    let drv = driver(&s);
    let mut ch = open(&drv, &s, 1, ChannelConfigDto::default());
    let mut buf = [RawCanFrame::zeroed(); 64];
    let mut total = 0usize;
    let mut last_ts = 0u64;
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(1) {
        let n = ch.recv_batch(&mut buf, 5).unwrap();
        for f in &buf[..n] {
            assert!(f.has_hw_timestamp());
            assert!(f.timestamp_us >= last_ts, "timestamps regress");
            last_ts = f.timestamp_us;
        }
        total += n;
    }
    assert!(total >= 4000, "only {total} frames in 1 s");

    s.stop();
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        let _ = ch.recv_batch(&mut buf, 5);
        if ch.health().state == BusState::Disconnected {
            break;
        }
        assert!(Instant::now() < deadline, "never Disconnected");
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = ch.close();
}

#[test]
fn t6_registry_routes_cansub_and_ignores_adapter_channel() {
    let s = sim(2, SimSource::Silent);
    let drv = driver(&s);
    drv.add_known_host(&host(&s), Some(ID.into()), false)
        .unwrap();
    let mut reg = DriverRegistry::new();
    reg.register_cansub(Arc::clone(&drv));
    assert!(reg.cansub().is_some());
    // Frontend sends the descriptor id in `adapterChannel` and `networkHost = null` (mDNS pick).
    let id = format!("cansub:{ID}@2");
    let cfg = ChannelConfigDto {
        adapter_channel: Some(id.clone()),
        network_host: None,
        require_hardware_listen_only: true,
        ..ChannelConfigDto::default()
    };
    let (desc, mut ch) = reg.open_by_device_id(&id, &cfg).expect("open via registry");
    assert_eq!(desc.device_id, id);
    assert_eq!(desc.channel_name, format!("{}@2", host(&s)));
    ch.close().unwrap();
    // Explicit `networkHost` wins over known hosts.
    let cfg = ChannelConfigDto {
        adapter_channel: Some("garbage".into()),
        network_host: Some(host(&s)),
        ..ChannelConfigDto::default()
    };
    let fresh = driver(&s);
    let mut reg2 = DriverRegistry::new();
    reg2.register_cansub(fresh);
    let (_, mut ch) = reg2
        .open_by_device_id(&id, &cfg)
        .expect("open via networkHost");
    ch.close().unwrap();
}

#[test]
fn t7_default_registry_discovery_offline_no_panic() {
    let reg = DriverRegistry::with_defaults();
    assert!(reg.cansub().is_some());
    let t0 = Instant::now();
    let devs = reg.discover_all();
    assert!(devs.iter().any(|d| d.device_id == "mock:mock0"));
    assert!(t0.elapsed() < Duration::from_secs(10));
}
