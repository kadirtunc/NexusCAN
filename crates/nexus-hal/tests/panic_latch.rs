//! WP-4 (CRIT-05.2 / CRIT-05.3) Panic Stop integrity on `mock0` (no hardware, every OS).
//!
//! * Arming never clears the Panic latch; `cmd_clear_panic_latch` does (buses stay disarmed).
//! * `cmd_reset_session` leaves nothing that can transmit and does not latch.
//! * Race: a periodic job registered concurrently with Panic Stop never survives it, and no
//!   frame of that job reaches the bus after the panic, not even after clear + re-arm.

use nexus_hal::{ChannelConfigDto, PipelineEngine, MOCK0_DEVICE_ID, MOCK1_DEVICE_ID};
use nexus_protocols::uds::port::{DiagCanPort, DiagTapFilter};
use std::thread;
use std::time::{Duration, Instant};

/// Arbitration id not produced by the mock traffic generator.
const RACE_ID: u32 = 0x6AB;

fn connect(engine: &PipelineEngine, device: &str, bus_id: u8) {
    let cfg = ChannelConfigDto {
        bus_id,
        listen_only: false,
        mock_fps_preset: Some(1_000),
        ..ChannelConfigDto::default()
    };
    engine
        .cmd_connect_bus(device.to_string(), cfg)
        .expect("connect mock bus");
}

fn tx_count(engine: &PipelineEngine, arb_id: u32) -> u64 {
    let snap = engine.flush_snapshot_now().expect("flush snapshot");
    snap.frames
        .iter()
        .filter(|f| f.bus_id == 0 && f.arb_id == arb_id && !f.is_extended)
        .map(|f| f.rx_count)
        .sum()
}

#[test]
fn arming_while_latched_errors_and_explicit_clear_then_arm_works() {
    let engine = PipelineEngine::new();
    connect(&engine, MOCK0_DEVICE_ID, 0);
    engine.cmd_arm_active_bus(0, true).expect("arm");

    let res = engine.cmd_panic_stop_tx();
    assert_eq!(res.disarmed_buses, 1);
    assert!(engine.is_panic_latched());

    // Both arming entry points refuse while latched, with the HMI-parsable prefix.
    let err = engine.cmd_arm_active_bus(0, true).expect_err("arm while latched");
    assert!(err.to_string().starts_with("PANIC_LATCHED:"), "{err}");
    let err = engine.cmd_set_bus_mode(0, false, true).expect_err("set_bus_mode arm while latched");
    assert!(err.to_string().starts_with("PANIC_LATCHED:"), "{err}");
    // Mode change (listen-only toggle) with arm is refused too, and nothing is reopened armed.
    let err = engine.cmd_set_bus_mode(0, true, true);
    assert!(err.is_ok(), "listen-only request never arms, must succeed: {err:?}");
    let err = engine.cmd_set_bus_mode(0, false, true).expect_err("mode change + arm while latched");
    assert!(err.to_string().starts_with("PANIC_LATCHED:"), "{err}");
    assert!(engine.is_panic_latched(), "a failed arm must not clear the latch");

    // TX paths report the same prefix.
    let err = engine
        .cmd_transmit_raw_frame(0, RACE_ID, false, false, false, vec![1, 2], None, None)
        .expect_err("tx while latched");
    assert!(err.to_string().starts_with("PANIC_LATCHED:"), "{err}");

    // Disarming is always allowed while latched.
    engine.cmd_set_bus_mode(0, false, false).expect("back to active, disarmed");
    engine.cmd_arm_active_bus(0, false).expect("disarm while latched");

    // Clearing the latch does not arm anything.
    engine.cmd_clear_panic_latch();
    assert!(!engine.is_panic_latched());
    let snap = engine.flush_snapshot_now().expect("flush");
    assert!(!snap.tx_panic_latched);
    assert!(snap.buses.iter().all(|b| !b.tx_armed), "clear latch must not arm buses");

    let h = engine.cmd_arm_active_bus(0, true).expect("arm after clear");
    assert!(h.tx_armed);
    engine
        .cmd_transmit_raw_frame(0, RACE_ID, false, false, false, vec![1, 2], None, None)
        .expect("tx after clear + arm");
}

#[test]
fn reset_session_leaves_nothing_able_to_transmit_and_does_not_latch() {
    let engine = PipelineEngine::new();
    connect(&engine, MOCK0_DEVICE_ID, 0);
    connect(&engine, MOCK1_DEVICE_ID, 1);
    engine.cmd_arm_active_bus(0, true).expect("arm 0");
    engine.cmd_arm_active_bus(1, true).expect("arm 1");
    for bus in [0u8, 1] {
        engine
            .cmd_transmit_raw_frame(bus, 0x6A0, false, false, false, vec![0xAA], Some(10), None)
            .expect("periodic job");
    }
    let tap = engine
        .open_diag_tap(0, &[DiagTapFilter::exact_std(0x7EA)], 64)
        .expect("diag tap");
    assert_eq!(engine.cmd_list_periodic_tx().len(), 2);

    let res = engine.cmd_reset_session();
    assert_eq!(res.stopped_periodic_jobs, 2);
    assert_eq!(res.disarmed_buses, 2);
    assert_eq!(res.disconnected_buses, 2);
    assert!(engine.cmd_list_periodic_tx().is_empty());
    assert!(tap.is_closed(), "diag taps must be closed by reset_session");
    assert!(!engine.is_panic_latched());
    let snap = engine.flush_snapshot_now().expect("flush");
    assert!(!snap.tx_panic_latched);
    assert!(snap.buses.is_empty(), "no bus may stay connected: {:?}", snap.buses);

    // Reset after a Panic Stop clears the latch; reset on an idle engine is a no-op.
    connect(&engine, MOCK0_DEVICE_ID, 0);
    engine.cmd_arm_active_bus(0, true).expect("arm");
    let _ = engine.cmd_panic_stop_tx();
    assert!(engine.is_panic_latched());
    let res = engine.cmd_reset_session();
    assert_eq!(res.disarmed_buses, 0, "panic already disarmed");
    assert_eq!(res.disconnected_buses, 1);
    assert!(!engine.is_panic_latched());
    let res = engine.cmd_reset_session();
    assert_eq!((res.stopped_periodic_jobs, res.disarmed_buses, res.disconnected_buses), (0, 0, 0));
}

#[test]
fn periodic_job_racing_panic_never_survives_and_never_transmits_after_rearm() {
    const ITERATIONS: usize = 500;
    let engine = PipelineEngine::new();
    connect(&engine, MOCK0_DEVICE_ID, 0);

    let mut registered_then_removed = 0usize;
    for i in 0..ITERATIONS {
        if engine.is_panic_latched() {
            engine.cmd_clear_panic_latch();
        }
        engine.cmd_arm_active_bus(0, true).expect("arm");

        let tx_result = thread::scope(|s| {
            let h = s.spawn(|| {
                engine.cmd_transmit_raw_frame(
                    0,
                    RACE_ID,
                    false,
                    false,
                    false,
                    vec![0xDE, 0xAD, (i & 0xFF) as u8],
                    Some(10),
                    Some("race".to_string()),
                )
            });
            // Vary where the panic lands relative to the TX ack / job registration window.
            let spin_until = Instant::now() + Duration::from_micros(((i % 13) * 150) as u64);
            while Instant::now() < spin_until {
                std::hint::spin_loop();
            }
            let _ = engine.cmd_panic_stop_tx();
            h.join().expect("tx thread")
        });
        if matches!(tx_result, Ok(ref r) if r.job_id.is_some()) {
            registered_then_removed += 1;
        }
        assert!(
            engine.cmd_list_periodic_tx().is_empty(),
            "zombie periodic job survived Panic Stop at iteration {i}: {:?}",
            engine.cmd_list_periodic_tx()
        );
    }
    eprintln!("race: {registered_then_removed}/{ITERATIONS} jobs registered before the panic");

    // After the last panic: no frame of the job reaches the bus.
    thread::sleep(Duration::from_millis(20));
    let after_panic = tx_count(&engine, RACE_ID);
    thread::sleep(Duration::from_millis(60));
    assert_eq!(tx_count(&engine, RACE_ID), after_panic, "TX after Panic Stop");

    // After clear + re-arm: still nothing (no zombie job, no stale queued frame).
    engine.cmd_clear_panic_latch();
    engine.cmd_arm_active_bus(0, true).expect("re-arm");
    thread::sleep(Duration::from_millis(80));
    assert!(engine.cmd_list_periodic_tx().is_empty());
    assert_eq!(tx_count(&engine, RACE_ID), after_panic, "TX after clear + re-arm");
}
