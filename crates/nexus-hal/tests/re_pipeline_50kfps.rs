//! RE Toolkit R1 §4: mock0 at 50 kHz with RE ON -> `dropped_frames == 0`, RE ingests in the
//! aggregator, the 10 Hz binary subscription starts with a full resync and is paced (never
//! per-frame), `cmd_re_stop` delivers one final snapshot and ends the subscription.
//! Own test binary (timing sensitive; see perf_50kfps.rs).

use nexus_hal::pipeline::re_analyzer::RePhase;
use nexus_hal::{ChannelConfigDto, PipelineEngine, MOCK0_DEVICE_ID};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

type Snaps = Mutex<Vec<(Instant, Vec<u8>)>>;

#[test]
fn re_mock0_50kfps_zero_drops_and_10hz_binary_snapshots() {
    let engine = PipelineEngine::new();
    let snaps: Arc<Snaps> = Arc::new(Mutex::new(Vec::new()));
    let sink_snaps = Arc::clone(&snaps);
    let snaps_handle = Arc::clone(&snaps);
    engine
        .cmd_re_subscribe(Box::new(move |b: &[u8]| {
            sink_snaps
                .lock()
                .unwrap()
                .push((Instant::now(), b.to_vec()));
            true
        }))
        .expect("subscribe");
    let st = engine.cmd_re_start(None);
    assert!(st.enabled);
    assert_eq!(st.phase, RePhase::Free);

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
        .expect("connect mock0 50k");

    thread::sleep(Duration::from_millis(250));
    engine
        .cmd_re_set_phase(RePhase::Baseline)
        .expect("baseline");
    thread::sleep(Duration::from_millis(250));
    let m = engine.cmd_re_mark("press");
    assert_eq!(m.phase, RePhase::Baseline);
    engine.cmd_re_set_phase(RePhase::Action).expect("action");
    thread::sleep(Duration::from_millis(250));
    assert!(
        engine.cmd_re_set_phase(RePhase::Idle).is_err(),
        "idle is not settable via IPC"
    );

    let mut last = None;
    while let Ok(s) = sub.try_recv() {
        last = Some(s);
    }
    let snap = engine.flush_snapshot_now().expect("flush");
    let last = last.unwrap_or(snap);
    let status = engine.re_status();
    engine.cmd_disconnect_bus(0).expect("disconnect");
    let final_status = engine.cmd_re_stop();
    assert!(!final_status.enabled);

    assert_eq!(
        last.dropped_frames, 0,
        "RE on must not cause drops at 50 kfps"
    );
    assert!(
        status.frames_ingested >= 15_000,
        "RE ingested only {}",
        status.frames_ingested
    );
    assert!(status.rows >= 1);

    let snaps = snaps.lock().unwrap();
    // ~750 ms at 10 Hz -> ~8 snapshots (+1 final). Never per-frame (~37k frames).
    assert!(
        (3..=12).contains(&snaps.len()),
        "got {} RE snapshots",
        snaps.len()
    );
    assert_eq!(&snaps[0].1[0..4], b"NRE2");
    assert_eq!(
        snaps[0].1[17], 1,
        "first snapshot after subscribe is a full resync"
    );
    assert!(
        snaps[1..].iter().all(|(_, b)| b[17] == 0),
        "later snapshots are dirty-only"
    );
    let seqs: Vec<u32> = snaps
        .iter()
        .map(|(_, b)| u32::from_le_bytes([b[4], b[5], b[6], b[7]]))
        .collect();
    assert!(
        seqs.windows(2).all(|w| w[1] == w[0] + 1),
        "seq strictly +1: {seqs:?}"
    );
    let span = snaps.last().unwrap().0 - snaps[0].0;
    let mean = span / (snaps.len() as u32 - 1).max(1);
    assert!(
        mean >= Duration::from_millis(60),
        "RE snapshot pacing too fast: {mean:?}"
    );

    // Subscription ended with the stop: no further snapshots arrive.
    let n = snaps.len();
    drop(snaps);
    let _ = engine.cmd_re_start(None);
    thread::sleep(Duration::from_millis(250));
    assert_eq!(
        snaps_len(&snaps_handle),
        n,
        "snapshots continued after cmd_re_stop"
    );
    let _ = engine.cmd_re_stop();
}

fn snaps_len(s: &Snaps) -> usize {
    s.lock().unwrap().len()
}
