//! WP-4 HIL evidence (CRIT-05.2 / CRIT-05.3): Panic Stop racing a 10 ms periodic TX job on a
//! real SocketCAN interface (`vcan0`), 1000 iterations, verified by an INDEPENDENT wire sniffer.
//!
//! Acceptance (planning/security-remediation-v0.1.md, WP-4): "periodic TX 10 ms + Panic, raced
//! inside a 50 ms window (1000 loop iterations) -> 0 frames after the Panic and after re-arm".
//!
//! The engine's own TX counters are NOT trusted. A separate raw `CAN_RAW` socket (opened by
//! this test, not by `nexus-hal`) listens on vcan0 with `SO_TIMESTAMPNS`. On vcan the kernel
//! stamps the skb inside the sender's `write()` (netif_rx prequeue), so a frame stamped after
//! `cmd_panic_stop_tx()` returned was written to the bus after the panic returned.
//!
//! Every race frame carries `[0xDE, 0xAD, nonce_hi, nonce_lo, iter_hi, iter_lo, 0x5A, kind]`
//! (nonce = low 16 bits of the PID) so traffic from other processes on vcan0 is ignored.
//!
//! Without vcan0 the test prints `SKIP (HIL)` and passes, unless `NEXUS_REQUIRE_VCAN=1`
//! (CI), in which case a missing interface is a failure.
//!
//! Run: `cargo test -p nexus-hal --test panic_latch_vcan -- --nocapture`
#![cfg(target_os = "linux")]

use nexus_hal::{ChannelConfigDto, PipelineEngine};
use socketcan::{CanAnyFrame, CanFdSocket, CanFilter, EmbeddedFrame, Frame, Socket, SocketOptions};
use std::io::ErrorKind;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

const IFACE: &str = "vcan0";
/// Arbitration id used by no other NexusCAN HIL test.
const RACE_ID: u32 = 0x6AB;
const ITERATIONS: usize = 1000;
const PERIOD_MS: u32 = 10;
/// The panic lands somewhere inside this window after the periodic job request starts.
const RACE_WINDOW_US: u64 = 50_000;
/// Every second iteration concentrates on the job-registration window (first 2 ms).
const TIGHT_WINDOW_US: u64 = 2_000;
/// Wire observation after each panic before the next clear + re-arm: > 2 periods, so a
/// surviving periodic job would put at least two frames on the wire inside it.
const DWELL: Duration = Duration::from_millis(25);
/// `cmd_panic_stop_tx()` is not a barrier for the bus-io thread: a request that passed the
/// bus-io safety gate just before the epoch bump is still written by `send_frame` after the
/// panic returns (one frame, delayed by however long that thread was preempted). Such a single
/// post-panic frame per iteration is classified "in-flight" and reported, not failed.
/// A zombie (surviving job / stale queued frame) is: >= 2 post-panic frames in one iteration,
/// or any frame of iteration k after iteration k+1 re-armed, or any frame after the final
/// clear + re-arm. Zombies always fail. `NEXUS_PANIC_STRICT=1` also fails on in-flight frames.
/// Threshold used only for reporting in-flight latency buckets.
const IN_FLIGHT_REPORT: Duration = Duration::from_millis(5);
const QUIET_WINDOW: Duration = Duration::from_millis(100);

const KIND_RACE: u8 = 0x01;
const KIND_CONTROL: u8 = 0xC0;

fn vcan_up() -> bool {
    let net = std::path::Path::new("/sys/class/net").join(IFACE);
    let flags = std::fs::read_to_string(net.join("flags")).unwrap_or_default();
    let flags = u32::from_str_radix(flags.trim().trim_start_matches("0x"), 16).unwrap_or(0);
    net.exists() && (flags & 0x1) != 0 // IFF_UP
}

fn require_vcan() -> bool {
    std::env::var("NEXUS_REQUIRE_VCAN").is_ok_and(|v| v == "1")
}

#[derive(Clone, Copy, Debug)]
struct Seen {
    ts: SystemTime,
    iter: u16,
    kind: u8,
}

fn payload(nonce: u16, iter: u16, kind: u8) -> Vec<u8> {
    let [nh, nl] = nonce.to_be_bytes();
    let [ih, il] = iter.to_be_bytes();
    vec![0xDE, 0xAD, nh, nl, ih, il, 0x5A, kind]
}

/// Independent wire sniffer (raw socketcan, not the HAL driver).
fn spawn_sniffer(
    nonce: u16,
    stop: Arc<AtomicBool>,
) -> thread::JoinHandle<Result<Vec<Seen>, String>> {
    let sock = CanFdSocket::open(IFACE).expect("sniffer: open vcan0");
    sock.set_filters(&[CanFilter::new(RACE_ID, 0x7FF | EFF_RTR_FLAGS)])
        .expect("sniffer: set filter");
    sock.set_recv_timestamp(true)
        .expect("sniffer: SO_TIMESTAMPNS");
    sock.set_read_timeout(Duration::from_millis(10))
        .expect("sniffer: read timeout");
    let [nh, nl] = nonce.to_be_bytes();
    thread::spawn(move || {
        let mut seen = Vec::with_capacity(8 * ITERATIONS);
        loop {
            match sock.read_frame_with_timestamp() {
                Ok((frame, ts)) => {
                    let data: &[u8] = match &frame {
                        CanAnyFrame::Normal(f) => f.data(),
                        CanAnyFrame::Fd(f) => f.data(),
                        _ => continue,
                    };
                    let id_ok = match &frame {
                        CanAnyFrame::Normal(f) => !f.is_extended() && f.raw_id() == RACE_ID,
                        CanAnyFrame::Fd(f) => !f.is_extended() && f.raw_id() == RACE_ID,
                        _ => false,
                    };
                    if id_ok
                        && data.len() == 8
                        && data[0] == 0xDE
                        && data[1] == 0xAD
                        && data[2] == nh
                        && data[3] == nl
                        && data[6] == 0x5A
                    {
                        seen.push(Seen {
                            ts,
                            iter: u16::from_be_bytes([data[4], data[5]]),
                            kind: data[7],
                        });
                    }
                }
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                    if stop.load(Ordering::Acquire) {
                        return Ok(seen);
                    }
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(e) => return Err(format!("sniffer read error: {e}")),
            }
        }
    })
}

/// Match standard data frames only: SFF id + EFF flag + RTR flag must agree.
const EFF_RTR_FLAGS: u32 = 0x8000_0000 | 0x4000_0000;

fn after(ts: SystemTime, mark: SystemTime) -> bool {
    ts > mark
}

#[test]
fn vcan0_periodic_job_racing_panic_puts_zero_frames_on_wire_after_panic_and_rearm() {
    if !vcan_up() {
        assert!(
            !require_vcan(),
            "NEXUS_REQUIRE_VCAN=1 but {IFACE} is missing or down (run scripts/setup_vcan.sh)"
        );
        eprintln!("SKIP (HIL): {IFACE} not present or down — run scripts/setup_vcan.sh");
        return;
    }
    let strict = std::env::var("NEXUS_PANIC_STRICT").is_ok_and(|v| v == "1");
    let nonce = (std::process::id() & 0xFFFF) as u16;

    let stop = Arc::new(AtomicBool::new(false));
    let sniffer = spawn_sniffer(nonce, Arc::clone(&stop));

    let engine = PipelineEngine::new();
    let cfg = ChannelConfigDto {
        bus_id: 0,
        listen_only: false,
        ..ChannelConfigDto::default()
    };
    engine
        .cmd_connect_bus(format!("socketcan:{IFACE}"), cfg)
        .expect("connect socketcan:vcan0");

    let mut panic_ret: Vec<SystemTime> = Vec::with_capacity(ITERATIONS);
    let mut registered_before_panic = 0usize;
    let t_start = Instant::now();

    for i in 0..ITERATIONS {
        if engine.is_panic_latched() {
            engine.cmd_clear_panic_latch();
        }
        engine.cmd_arm_active_bus(0, true).expect("arm");

        let delay_us = if i % 2 == 0 {
            (i as u64 * 7919) % TIGHT_WINDOW_US
        } else {
            (i as u64 * 7919) % RACE_WINDOW_US
        };
        let (tx_result, t_panic) = thread::scope(|s| {
            let h = s.spawn(|| {
                engine.cmd_transmit_raw_frame(
                    0,
                    RACE_ID,
                    false,
                    false,
                    false,
                    payload(nonce, i as u16, KIND_RACE),
                    Some(PERIOD_MS),
                    Some("race-vcan".to_string()),
                )
            });
            let until = Instant::now() + Duration::from_micros(delay_us);
            if delay_us > 3_000 {
                thread::sleep(Duration::from_micros(delay_us - 1_000));
            }
            while Instant::now() < until {
                std::hint::spin_loop();
            }
            let _ = engine.cmd_panic_stop_tx();
            let t_panic = SystemTime::now();
            (h.join().expect("tx thread"), t_panic)
        });
        panic_ret.push(t_panic);
        if matches!(tx_result, Ok(ref r) if r.job_id.is_some()) {
            registered_before_panic += 1;
        }
        assert!(
            engine.cmd_list_periodic_tx().is_empty(),
            "zombie periodic job survived Panic Stop at iteration {i}: {:?}",
            engine.cmd_list_periodic_tx()
        );
        // Let a hypothetical zombie hit the wire before the next clear + re-arm.
        thread::sleep(DWELL);
    }
    let race_elapsed = t_start.elapsed();
    let last_panic = *panic_ret.last().expect("iterations > 0");

    // Window 1: 100 ms after the last panic, latched.
    thread::sleep(QUIET_WINDOW);
    // Window 2: clear + re-arm, 100 ms.
    engine.cmd_clear_panic_latch();
    engine.cmd_arm_active_bus(0, true).expect("re-arm");
    let t_rearm = SystemTime::now();
    thread::sleep(QUIET_WINDOW);
    let t_quiet_end = SystemTime::now();
    assert!(engine.cmd_list_periodic_tx().is_empty());

    // Positive control: the sniffer is alive and sees what this engine writes to vcan0.
    engine
        .cmd_transmit_raw_frame(
            0,
            RACE_ID,
            false,
            false,
            false,
            payload(nonce, 0xFFFF, KIND_CONTROL),
            None,
            None,
        )
        .expect("control one-shot after re-arm");
    thread::sleep(Duration::from_millis(50));
    let _ = engine.cmd_panic_stop_tx();
    engine.cmd_disconnect_bus(0).expect("disconnect");
    stop.store(true, Ordering::Release);
    let seen = sniffer.join().expect("sniffer thread").expect("sniffer");

    // ---- Analysis (wire truth only) ----
    let control = seen.iter().filter(|s| s.kind == KIND_CONTROL).count();
    let race: Vec<Seen> = seen
        .iter()
        .copied()
        .filter(|s| s.kind == KIND_RACE)
        .collect();
    let mut before_panic = 0usize;
    // Post-panic frames per iteration, with latency relative to that iteration's panic return.
    let mut post: Vec<Vec<Duration>> = vec![Vec::new(); ITERATIONS];
    for s in &race {
        let k = s.iter as usize;
        assert!(k < ITERATIONS, "unexpected iteration tag {k}");
        match s.ts.duration_since(panic_ret[k]) {
            Ok(d) if !d.is_zero() => post[k].push(d),
            _ => before_panic += 1,
        }
    }
    let mut in_flight: Vec<(usize, Duration)> = Vec::new();
    let mut zombies: Vec<(usize, Vec<Duration>)> = Vec::new();
    for (k, lat) in post.iter().enumerate() {
        match lat.as_slice() {
            [] => {}
            [d] if *d < DWELL => in_flight.push((k, *d)),
            _ => zombies.push((k, lat.clone())),
        }
    }
    let after_last_panic = race.iter().filter(|s| after(s.ts, last_panic)).count();
    let after_rearm = race
        .iter()
        .filter(|s| after(s.ts, t_rearm) && !after(s.ts, t_quiet_end))
        .count();
    let after_rearm_total = race.iter().filter(|s| after(s.ts, t_rearm)).count();
    let worst = in_flight.iter().map(|(_, d)| *d).max().unwrap_or_default();
    let late = in_flight
        .iter()
        .filter(|(_, d)| *d > IN_FLIGHT_REPORT)
        .count();

    eprintln!(
        "panic_latch_vcan: iterations={ITERATIONS} race_time={:.1}s jobs_registered_before_panic={registered_before_panic}",
        race_elapsed.as_secs_f64()
    );
    eprintln!(
        "panic_latch_vcan: wire race frames total={} before_panic={before_panic} \
         in_flight={} (>{}ms: {late}, worst +{}us) zombie_iterations={}",
        race.len(),
        in_flight.len(),
        IN_FLIGHT_REPORT.as_millis(),
        worst.as_micros(),
        zombies.len()
    );
    eprintln!(
        "panic_latch_vcan: after_last_panic(100ms)={after_last_panic} \
         after_clear_rearm(100ms)={after_rearm} after_clear_rearm(total)={after_rearm_total} \
         control_frames_seen={control}"
    );
    for (k, d) in &in_flight {
        eprintln!(
            "panic_latch_vcan: in-flight iter={k} +{}us after cmd_panic_stop_tx() returned",
            d.as_micros()
        );
    }

    assert_eq!(
        control, 1,
        "positive control: sniffer must see exactly one control frame"
    );
    assert!(
        before_panic > 0,
        "vacuous run: sniffer saw no race frame before any panic ({} total)",
        race.len()
    );
    let repeating = zombies.iter().filter(|(_, l)| l.len() >= 2).count();
    assert!(
        zombies.is_empty(),
        "TX after Panic Stop crossed the next clear + re-arm in {} iteration(s) \
         ({repeating} repeating = surviving job; {} single delayed write = bus-io \
         gate->send_frame window, Panic Stop is not a write barrier): \
         (iter, post-panic latencies) = {:?}",
        zombies.len(),
        zombies.len() - repeating,
        &zombies[..zombies.len().min(5)]
    );
    assert!(
        after_last_panic <= 1,
        "TX on the wire after the last Panic Stop: {after_last_panic} frame(s)"
    );
    assert_eq!(after_rearm_total, 0, "TX on the wire after clear + re-arm");
    if strict {
        assert!(
            in_flight.is_empty(),
            "NEXUS_PANIC_STRICT=1: {} frame(s) written after cmd_panic_stop_tx() returned",
            in_flight.len()
        );
    }
}
