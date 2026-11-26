//! C6: `nexuscan cansub-selftest` against the in-process `cansub-sim` (real TLS 1.2 + REST + WSS).
//! Contract cansub-v1 §6. The emulator does not bridge channels onto one bus, so the loopback
//! test verifies the TX-ack path only (RX side receives nothing -> loopback "fail", exit 1).

use cansub::sim::{SimConfig, SimHandle, SimLog, SimSource};
use cansub::{ConnectOptions, Device};
use nexus_cli::cansub_selftest::{
    run_cansub_selftest, CansubSelftestArgs, LOOPBACK_FRAMES, SELFTEST_EXIT_CONNECT,
    SELFTEST_EXIT_FAIL, SELFTEST_EXIT_PASS,
};
use nexus_cli::{parse_cli_args, CliCommand};

const ID: &str = "aabbccdd";

fn sim() -> SimHandle {
    SimHandle::start(SimConfig {
        channels: 4,
        source: SimSource::Mock { fps: 1000 },
        ..SimConfig::default()
    })
    .expect("sim start")
}

fn args(sim: &SimHandle) -> CansubSelftestArgs {
    CansubSelftestArgs {
        host: format!("127.0.0.1:{}", sim.addr().port()),
        device_id: Some(ID.into()),
        duration_s: 1,
        ..CansubSelftestArgs::default()
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

#[test]
fn listen_only_rx_report() {
    let sim = sim();
    let root = sim.root_ca_der().to_vec();
    let connect = move |o: ConnectOptions| Device::connect_with_root(o, &root);
    let mut stderr = Vec::new();
    let out = run_cansub_selftest(&args(&sim), &connect, &mut stderr);
    let r = &out.report;
    assert_eq!(out.exit_code, SELFTEST_EXIT_PASS, "{:?}", r.errors);
    assert_eq!(r.result, "pass");
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert!(r.loopback.is_none());
    let info = r.info.as_ref().expect("info");
    assert_eq!((info.id.as_str(), info.channels), (ID, 4));
    assert!(r
        .version
        .device_api
        .as_deref()
        .unwrap_or("")
        .starts_with("05."));

    let phy = r.phy.as_ref().expect("phy");
    assert!(phy.listen_only && phy.error_frames && phy.tx_ack_frames);
    let rx = r.rx_stats.as_ref().expect("rx_stats");
    // Mock 1000 fps for ~1 s.
    assert!(rx.frames > 500, "frames {}", rx.frames);
    assert_eq!(rx.frames, rx.classic + rx.fd);
    assert!(rx.duration_s >= 0.9);
    let dec = r.decoder_stats.expect("decoder_stats");
    assert!(dec.hdlc_ok > 0);
    assert_eq!(dec.crc_errors, 0);
    let time = r.time.as_ref().expect("time");
    assert!(time.set_time_ok);
    assert!(
        time.timestamps_monotonic,
        "{} regressions",
        time.timestamp_regressions
    );
    // Device clock was set from the host: offset stays small (transport latency only).
    let off = time.host_offset_ms.expect("offset");
    assert!(
        off.max.abs() < 2_000.0 && off.min.abs() < 2_000.0,
        "{off:?}"
    );

    let json = serde_json::to_value(r).expect("json");
    for key in [
        "version",
        "info",
        "time",
        "phy",
        "rx_stats",
        "decoder_stats",
        "errors",
    ] {
        assert!(json.get(key).is_some(), "missing {key}");
    }
    let log = sim.log();
    let puts = phy_puts(&log, 1);
    assert!(
        !puts.is_empty() && puts.iter().all(|b| b.contains("\"listen_only\":true")),
        "{puts:?}"
    );
    assert!(stderr.is_empty());
}

#[test]
fn tx_loopback_acks_and_restores_listen_only() {
    let sim = sim();
    let root = sim.root_ca_der().to_vec();
    let connect = move |o: ConnectOptions| Device::connect_with_root(o, &root);
    let mut a = args(&sim);
    a.tx_loopback = Some(2);
    let mut stderr = Vec::new();
    let out = run_cansub_selftest(&a, &connect, &mut stderr);
    let r = &out.report;
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    let lb = r.loopback.as_ref().expect("loopback");
    assert_eq!((lb.tx_channel, lb.rx_channel), (1, 2));
    assert_eq!(lb.sent, LOOPBACK_FRAMES as u64);
    assert_eq!(lb.tx_acked, LOOPBACK_FRAMES as u64, "TX-acks");
    assert!(lb.restored_listen_only);
    // Sim limitation: channels are independent (no shared bus) -> nothing arrives on CH2.
    assert_eq!(lb.rx_received, 0);
    assert!(!lb.passed);
    assert_eq!(out.exit_code, SELFTEST_EXIT_FAIL);
    assert_eq!(r.result, "fail");
    let warn = String::from_utf8_lossy(&stderr);
    assert!(
        warn.contains("WARNING") && warn.contains("ACTIVE"),
        "{warn}"
    );

    let log = sim.log();
    assert_eq!(log.received_tx[0], LOOPBACK_FRAMES as u64);
    assert_eq!(log.dropped_tx[0], 0);
    let puts = phy_puts(&log, 1);
    // listen-only (RX phase) -> active (loopback) -> listen-only (restore, last).
    assert!(
        puts.iter().any(|b| b.contains("\"listen_only\":false")),
        "{puts:?}"
    );
    assert!(
        puts.last()
            .is_some_and(|b| b.contains("\"listen_only\":true")),
        "{puts:?}"
    );
    assert!(phy_puts(&log, 2)
        .iter()
        .all(|b| b.contains("\"listen_only\":true")));
}

#[test]
fn connect_failure_exit_code_2() {
    let sim = sim();
    let root = sim.root_ca_der().to_vec();
    let connect = move |o: ConnectOptions| Device::connect_with_root(o, &root);
    let mut a = args(&sim);
    a.device_id = Some("11223344".into()); // wrong Device ID -> TLS failure
    let out = run_cansub_selftest(&a, &connect, &mut Vec::new());
    assert_eq!(out.exit_code, SELFTEST_EXIT_CONNECT);
    assert_eq!(out.report.result, "connect_failed");
    assert!(out.report.info.is_none());
    assert_eq!(out.report.errors.len(), 1);
}

#[test]
fn cli_parses_selftest_flags() {
    let cmd = parse_cli_args([
        "cansub-selftest",
        "10.123.45.1",
        "--device-id",
        "1A2B3C4D",
        "--ch",
        "3",
        "--duration-s=5",
        "--bitrate",
        "250000",
        "--data-bitrate",
        "5000000",
        "--fd",
        "--tx-loopback",
        "4",
    ])
    .expect("parse");
    let CliCommand::CansubSelftest(a) = cmd else {
        panic!("wrong command: {cmd:?}");
    };
    assert_eq!(a.host, "10.123.45.1");
    assert_eq!(a.device_id.as_deref(), Some("1a2b3c4d"));
    assert_eq!(
        (a.channel, a.duration_s, a.bitrate, a.data_bitrate),
        (3, 5, 250_000, 5_000_000)
    );
    assert!(a.fd && !a.accept_any);
    assert_eq!(a.tx_loopback, Some(4));

    for bad in [
        vec!["cansub-selftest"],
        vec!["cansub-selftest", "h", "--device-id", "xyz"],
        vec!["cansub-selftest", "h", "--ch", "0"],
        vec!["cansub-selftest", "h", "--ch", "2", "--tx-loopback", "2"],
        vec!["cansub-selftest", "h", "--duration-s", "0"],
        vec!["cansub-selftest", "h", "extra"],
        vec!["cansub-selftest", "h", "--bogus"],
    ] {
        assert!(parse_cli_args(&bad).is_err(), "{bad:?}");
    }
}
