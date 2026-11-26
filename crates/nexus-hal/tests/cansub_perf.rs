//! C7 QA gate, contract cansub-v1 §4 L4: cansub-sim → CANsub driver, 50 000 fps CAN-FD 64 B,
//! loopback, `--release`. Ignored by default (60 s each):
//!
//! `CANSUB_PERF_SECS=60 cargo test --release -p nexus-hal --test cansub_perf -- --ignored --nocapture --test-threads=1`
//!
//! Traffic: a feeder thread injects sequence-numbered FD 64 B frames (BRS, alternating std/ext id)
//! into the sim at a paced 50 kfps (`SimSource::Silent` + `SimHandle::inject`), so "sent" is
//! counted exactly on the sim side and every gap is visible on the receive side.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use cansub::sim::{SimChaos, SimConfig, SimFrame, SimHandle, SimSource};
use cansub::{ConnectOptions, Device};
use nexus_core::RawCanFrame;
use nexus_hal::traits::AdapterDriver;
use nexus_hal::{CansubDriver, ChannelConfigDto, DriverRegistry, PipelineEngine};

const ID: &str = "aabbccdd";
const FPS: u64 = 50_000;

fn secs() -> u64 {
    std::env::var("CANSUB_PERF_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60)
}

fn vm_rss_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmRSS:"))
                .and_then(|l| l.split_whitespace().nth(1).and_then(|v| v.parse().ok()))
        })
        .unwrap_or(0)
}

fn sim() -> SimHandle {
    SimHandle::start(SimConfig {
        channels: 2,
        source: SimSource::Silent,
        chaos: SimChaos::default(),
        ..SimConfig::default()
    })
    .expect("sim start")
}

fn host(s: &SimHandle) -> String {
    format!("127.0.0.1:{}", s.addr().port())
}

fn driver(s: &SimHandle) -> Arc<CansubDriver> {
    let root = s.root_ca_der().to_vec();
    Arc::new(CansubDriver::with_connector(Arc::new(move |o| {
        Device::connect_with_root(o, &root)
    })))
}

fn fd64(seq: u64) -> SimFrame {
    let mut f = SimFrame {
        id: if seq.is_multiple_of(2) {
            0x1A0
        } else {
            0x18DA_F110
        },
        extended: !seq.is_multiple_of(2),
        fd: true,
        brs: true,
        dlc: 15,
        ..SimFrame::default()
    };
    f.data[..8].copy_from_slice(&seq.to_le_bytes());
    for (i, b) in f.data.iter_mut().enumerate().skip(8) {
        *b = (seq as u8).wrapping_add(i as u8 * 3); // includes 0x7E / 0x7D → stuffing exercised
    }
    f
}

/// Paced 50 kfps feeder; returns (stop flag, injected counter, join handle).
fn feeder(s: Arc<SimHandle>, dur: Duration) -> (Arc<AtomicU64>, thread::JoinHandle<()>) {
    let sent = Arc::new(AtomicU64::new(0));
    let sent2 = Arc::clone(&sent);
    let h = thread::spawn(move || {
        let mut batch: Vec<SimFrame> = Vec::with_capacity(4096);
        let t0 = Instant::now();
        let mut seq = 0u64;
        while t0.elapsed() < dur {
            let due = (t0.elapsed().as_micros() as u64 * FPS / 1_000_000).min(FPS * dur.as_secs());
            batch.clear();
            while seq < due && batch.len() < 4096 {
                batch.push(fd64(seq));
                seq += 1;
            }
            if !batch.is_empty() {
                s.inject(1, &batch);
                sent2.store(seq, Ordering::Release);
            }
            thread::sleep(Duration::from_micros(500));
        }
    });
    (sent, h)
}

#[derive(Default, Debug)]
struct Rx {
    received: u64,
    next: u64,
    missing: u64,
    dup_or_reorder: u64,
    bad_shape: u64,
}

impl Rx {
    fn feed(&mut self, f: &RawCanFrame) {
        self.received += 1;
        if !(f.is_fd() && f.dlc == 64 && f.is_brs()) {
            self.bad_shape += 1;
            return;
        }
        let n = u64::from_le_bytes(f.data[..8].try_into().unwrap());
        if f.data[8] != (n as u8).wrapping_add(24) {
            self.bad_shape += 1;
        }
        match n.cmp(&self.next) {
            std::cmp::Ordering::Equal => {}
            std::cmp::Ordering::Greater => self.missing += n - self.next,
            std::cmp::Ordering::Less => self.dup_or_reorder += 1,
        }
        self.next = n + 1;
    }
}

#[test]
#[ignore = "L4 60 s throughput; run in --release"]
fn l4_driver_recv_batch_50kfps_fd64_zero_drop_rss() {
    let dur = Duration::from_secs(secs());
    let s = Arc::new(sim());
    let drv = driver(&s);
    let descs = drv
        .add_known_host(&host(&s), Some(ID.into()), false)
        .unwrap();
    let cfg = ChannelConfigDto {
        enable_fd: true,
        bitrate: 500_000,
        data_bitrate: 2_000_000,
        ..ChannelConfigDto::default()
    };
    let mut ch = drv.open_channel(&descs[0], &cfg).expect("open");
    // Wait until the sim registered the WebSocket (inject is ignored before).
    thread::sleep(Duration::from_millis(200));

    let (sent, feed) = feeder(Arc::clone(&s), dur);
    let mut buf = [RawCanFrame::zeroed(); 256];
    let mut rx = Rx::default();
    let t0 = Instant::now();
    let mut rss_5s = 0u64;
    let mut max_batch = 0usize;
    let feeding = Arc::new(AtomicBool::new(true));
    while t0.elapsed() < dur + Duration::from_millis(1500) {
        if rss_5s == 0 && t0.elapsed() >= Duration::from_secs(5) {
            rss_5s = vm_rss_kb();
        }
        if feeding.load(Ordering::Relaxed) && t0.elapsed() >= dur {
            feeding.store(false, Ordering::Relaxed);
        }
        let n = ch.recv_batch(&mut buf, 5).unwrap();
        max_batch = max_batch.max(n);
        for f in &buf[..n] {
            rx.feed(f);
        }
        if !feeding.load(Ordering::Relaxed) && rx.received >= sent.load(Ordering::Acquire) {
            break;
        }
    }
    feed.join().unwrap();
    // Final drain.
    let end = Instant::now() + Duration::from_millis(500);
    while Instant::now() < end && rx.received < sent.load(Ordering::Acquire) {
        let n = ch.recv_batch(&mut buf, 5).unwrap();
        for f in &buf[..n] {
            rx.feed(f);
        }
    }
    let rss_end = vm_rss_kb();
    let sent = sent.load(Ordering::Acquire);
    let elapsed = t0.elapsed().as_secs_f64();
    eprintln!(
        "L4 driver: sent {sent} received {} missing {} dup {} bad {} | {:.0} fps avg | RSS 5s {} kB end {} kB Δ {} kB | max batch {max_batch}",
        rx.received,
        rx.missing,
        rx.dup_or_reorder,
        rx.bad_shape,
        rx.received as f64 / elapsed.min(dur.as_secs_f64()),
        rss_5s,
        rss_end,
        rss_end as i64 - rss_5s as i64
    );
    ch.close().unwrap();
    assert!(
        sent >= FPS * dur.as_secs() * 99 / 100,
        "feeder under-ran: {sent}"
    );
    assert_eq!(
        sent,
        rx.received,
        "dropped_frames = {}",
        sent as i64 - rx.received as i64
    );
    assert_eq!(
        (rx.missing, rx.dup_or_reorder, rx.bad_shape),
        (0, 0, 0),
        "{rx:?}"
    );
    assert!(
        (rss_end as i64 - rss_5s as i64).abs() < 5 * 1024,
        "RSS drift {} kB",
        rss_end as i64 - rss_5s as i64
    );
}

/// Same load at SDK level so the decoder's `crc_errors` (not exposed by `CanChannel`) is visible.
#[test]
#[ignore = "L4 60 s throughput; run in --release"]
fn l4_sdk_poll_50kfps_fd64_crc_zero() {
    let dur = Duration::from_secs(secs());
    let s = Arc::new(sim());
    let dev = Device::connect_with_root(
        ConnectOptions {
            host: host(&s),
            device_id: Some(ID.into()),
            ..ConnectOptions::default()
        },
        s.root_ca_der(),
    )
    .unwrap();
    let mut ch = dev.open(1).unwrap();
    thread::sleep(Duration::from_millis(200));
    let (sent, feed) = feeder(Arc::clone(&s), dur);
    let mut got = 0u64;
    let t0 = Instant::now();
    while t0.elapsed() < dur + Duration::from_secs(2) {
        ch.poll(Duration::from_millis(5), &mut |_| got += 1)
            .unwrap();
        if t0.elapsed() > dur && got >= sent.load(Ordering::Acquire) {
            break;
        }
    }
    feed.join().unwrap();
    let st = ch.stats();
    let sent = sent.load(Ordering::Acquire);
    eprintln!("L4 sdk: sent {sent} received {got} stats {st:?}");
    ch.close(&dev).unwrap();
    assert_eq!(sent, got);
    assert_eq!(
        (
            st.crc_errors,
            st.overflows,
            st.truncated_frames,
            st.garbage_bytes
        ),
        (0, 0, 0, 0)
    );
}

/// Pipeline end to end: PipelineEngine bus on the CANsub driver, snapshot `dropped_frames == 0`
/// and `total_frames_rx == sent`.
#[test]
#[ignore = "L4 pipeline throughput; run in --release"]
fn l4_pipeline_50kfps_fd64_zero_dropped_frames() {
    let dur = Duration::from_secs(secs());
    let s = Arc::new(sim());
    let mut reg = DriverRegistry::new();
    reg.register_cansub(driver(&s));
    let engine = PipelineEngine::with_registry(reg);
    let mut sub = engine.subscribe();
    engine
        .cmd_connect_bus(
            format!("cansub:{ID}@1"),
            ChannelConfigDto {
                bus_id: 0,
                enable_fd: true,
                bitrate: 500_000,
                data_bitrate: 2_000_000,
                listen_only: true,
                network_host: Some(host(&s)),
                ..ChannelConfigDto::default()
            },
        )
        .expect("connect");
    thread::sleep(Duration::from_millis(200));
    let rss0 = vm_rss_kb();
    let (sent, feed) = feeder(Arc::clone(&s), dur);
    let mut last = None;
    let mut rss_5s = 0;
    let t0 = Instant::now();
    loop {
        while let Ok(snap) = sub.try_recv() {
            last = Some(snap);
        }
        if rss_5s == 0 && t0.elapsed() >= Duration::from_secs(5) {
            rss_5s = vm_rss_kb();
        }
        let done = feed.is_finished();
        if done {
            if let Some(l) = &last {
                if l.total_frames_rx >= sent.load(Ordering::Acquire) {
                    break;
                }
            }
            if t0.elapsed() > dur + Duration::from_secs(3) {
                break;
            }
        }
        thread::sleep(Duration::from_millis(10));
    }
    feed.join().unwrap();
    thread::sleep(Duration::from_millis(100));
    while let Ok(snap) = sub.try_recv() {
        last = Some(snap);
    }
    let rss_end = vm_rss_kb();
    let last = last.expect("snapshots");
    let sent = sent.load(Ordering::Acquire);
    eprintln!(
        "L4 pipeline: sent {sent} total_frames_rx {} dropped_frames {} | RSS start {rss0} 5s {rss_5s} end {rss_end} kB Δ {} kB",
        last.total_frames_rx,
        last.dropped_frames,
        rss_end as i64 - rss_5s as i64
    );
    engine.cmd_disconnect_bus(0).unwrap();
    assert_eq!(last.dropped_frames, 0);
    assert_eq!(last.total_frames_rx, sent);
}
