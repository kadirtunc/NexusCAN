//! 50 kfps mock0 burst: zero dropped frames, 60 Hz snapshot pacing (never per-frame), fast
//! shutdown.
//!
//! Kept in its own test binary on purpose: cargo runs test binaries one after another, so this
//! throughput/timing test never competes for CPU with the ~60 parallel unit tests of the
//! `nexus-hal` lib binary (that contention starved the mock generator and made it flaky).

use nexus_hal::{ChannelConfigDto, PipelineEngine, MOCK0_DEVICE_ID};
use std::thread;
use std::time::{Duration, Instant};

#[test]
fn pipeline_50kfps_burst_zero_drops_and_60hz_pacing() {
    let engine = PipelineEngine::new();
    engine
        .cmd_load_preset_databases()
        .expect("load preset databases");

    let mut sub = engine.subscribe();

    engine
        .cmd_connect_bus(
            MOCK0_DEVICE_ID.to_string(),
            ChannelConfigDto {
                bus_id: 0,
                bitrate: 500_000,
                data_bitrate: 5_000_000,
                enable_fd: true,
                listen_only: true,
                mock_fps_preset: Some(50_000),
                ..ChannelConfigDto::default()
            },
        )
        .expect("connect 50kfps mock0");

    let start = Instant::now();
    let mut received_snapshots = Vec::new();
    while start.elapsed() < Duration::from_millis(220) {
        if let Ok(snap) = sub.try_recv() {
            received_snapshots.push(snap);
        } else {
            thread::sleep(Duration::from_millis(2));
        }
    }
    // Drain any queued right at boundary
    while let Ok(snap) = sub.try_recv() {
        received_snapshots.push(snap);
    }

    // In ~220ms at 60Hz (16.67ms period) expect ~13 snapshots. The invariants are the upper
    // bound (NOT per-frame: ~11,000 frames arrive in the window) and the pacing (never faster
    // than 60 Hz). The lower bound only proves periodic emission: under CPU starvation (parallel
    // test binaries, 2-core CI runners) the OS may legitimately schedule the ticker less often.
    assert!(
        (2..=18).contains(&received_snapshots.len()),
        "Expected ~13 snapshots at 60Hz over 220ms, got {}",
        received_snapshots.len()
    );
    let first_ts = received_snapshots.first().expect("snapshots").timestamp_us;
    let last_ts = received_snapshots.last().expect("snapshots").timestamp_us;
    let intervals = (received_snapshots.len() - 1) as u64;
    let mean_interval_us = last_ts.saturating_sub(first_ts) / intervals;
    assert!(
        mean_interval_us >= 14_000,
        "60 Hz pacing violated: mean snapshot interval {mean_interval_us} us (< 14 ms)"
    );

    let last = received_snapshots.last().expect("at least one snapshot");
    assert_eq!(
        last.dropped_frames, 0,
        "50,000 fps burst must sustain zero dropped_frames"
    );
    assert!(
        last.total_frames_rx >= 7_500,
        "Expected high-throughput 50kfps RX (~11,000 frames in 220ms), got {}",
        last.total_frames_rx
    );
    assert_eq!(last.active_ids_count, 8);
    assert!(last.decoded_signals_count >= 40);

    let t_stop = Instant::now();
    engine.cmd_disconnect_bus(0).expect("disconnect 50kfps bus");
    assert!(
        t_stop.elapsed() < nexus_core::testing::scaled(Duration::from_millis(25)),
        "50kfps bus shutdown must complete in < 25ms, took {:?}",
        t_stop.elapsed()
    );
}
