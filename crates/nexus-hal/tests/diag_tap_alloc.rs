//! Proof: the bus-io hot path (RX fan-out to StateTable + diag taps, diag TX with origin
//! confirmation) performs ZERO heap allocations on the bus-io thread.
//!
//! A counting global allocator counts allocations only on threads marked through
//! `BUS_IO_THREAD_START_HOOK` (= every `nexus-bus-io-*` thread). After a warm-up (first
//! frames, tap registration, mock0 internal map growth) the counter is reset and the bus runs
//! at ~25 kfps with two taps (one catching everything) while a diag client keeps sending.

use nexus_core::{CanIdKey, RawCanFrame};
use nexus_hal::pipeline::BUS_IO_THREAD_START_HOOK;
use nexus_hal::{ChannelConfigDto, PipelineEngine, MOCK0_DEVICE_ID};
use nexus_protocols::uds::port::{DiagCanPort, DiagPortEvent, DiagTapFilter};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

struct CountingAlloc;

static BUS_IO_ALLOCS: AtomicU64 = AtomicU64::new(0);
static COUNTING: AtomicBool = AtomicBool::new(false);

thread_local! {
    static IS_BUS_IO: Cell<bool> = const { Cell::new(false) };
}

#[inline]
fn record() {
    if COUNTING.load(Ordering::Relaxed) && IS_BUS_IO.try_with(Cell::get).unwrap_or(false) {
        BUS_IO_ALLOCS.fetch_add(1, Ordering::Relaxed);
    }
}

// SAFETY: forwards every call unchanged to the system allocator; only counts.
unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record();
        // SAFETY: same contract as the caller's.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record();
        // SAFETY: same contract as the caller's.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record();
        // SAFETY: same contract as the caller's.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: same contract as the caller's.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

static HOOK_RAN: AtomicBool = AtomicBool::new(false);

fn mark_bus_io_thread() {
    IS_BUS_IO.with(|c| c.set(true));
    HOOK_RAN.store(true, Ordering::SeqCst);
}

/// Negative control: the counter really counts on a marked thread.
fn counter_self_check() {
    std::thread::spawn(|| {
        mark_bus_io_thread();
        BUS_IO_ALLOCS.store(0, Ordering::SeqCst);
        COUNTING.store(true, Ordering::SeqCst);
        let v: Vec<u8> = std::hint::black_box(Vec::with_capacity(64));
        COUNTING.store(false, Ordering::SeqCst);
        drop(v);
        assert!(BUS_IO_ALLOCS.load(Ordering::SeqCst) >= 1, "counting allocator is not counting");
        BUS_IO_ALLOCS.store(0, Ordering::SeqCst);
    })
    .join()
    .expect("self check");
    HOOK_RAN.store(false, Ordering::SeqCst);
}

#[test]
fn bus_io_hot_path_with_diag_taps_does_not_allocate() {
    counter_self_check();
    *BUS_IO_THREAD_START_HOOK.lock() = Some(mark_bus_io_thread);

    let engine = PipelineEngine::new();
    let cfg = ChannelConfigDto {
        bus_id: 0,
        listen_only: false,
        mock_fps_preset: Some(25_000),
        ..ChannelConfigDto::default()
    };
    engine
        .cmd_connect_bus(MOCK0_DEVICE_ID.to_string(), cfg)
        .expect("connect mock0");
    engine.cmd_arm_active_bus(0, true).expect("arm");
    let t0 = Instant::now();
    while !HOOK_RAN.load(Ordering::SeqCst) && t0.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(HOOK_RAN.load(Ordering::SeqCst), "bus-io thread start hook did not run");

    // Tap 1: catch-all (every mock0 frame is copied into it). Tap 2: diag ids, sends.
    let all = DiagTapFilter { id: 0, mask: 0, extended: None };
    let sniffer = engine.open_diag_tap(0, &[all], 65_536).expect("sniffer tap");
    let client = engine
        .open_diag_tap(
            0,
            &[DiagTapFilter::exact_std(0x7EC), DiagTapFilter::exact_std(0x7E4)],
            4_096,
        )
        .expect("client tap");

    let stop = Arc::new(AtomicBool::new(false));
    let sniffed = Arc::new(AtomicU64::new(0));
    let drain = {
        let stop = Arc::clone(&stop);
        let sniffed = Arc::clone(&sniffed);
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                if let Some(DiagPortEvent::Rx(_)) = sniffer.recv_timeout(Duration::from_millis(5)) {
                    sniffed.fetch_add(1, Ordering::Relaxed);
                }
            }
            sniffer
        })
    };

    let key = CanIdKey::new_standard(0x7E4).expect("id");
    let tx_frame = RawCanFrame::new_classical(0, key, &[0x02, 0x3E, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA], 0)
        .expect("frame");
    let mut confirmed = 0u64;
    let pump = |dur: Duration, confirmed: &mut u64| {
        let end = Instant::now() + dur;
        while Instant::now() < end {
            let _ = client.send(tx_frame);
            // ~500 diag frames/s: drain verdicts
            let until = Instant::now() + Duration::from_millis(2);
            while let Some(ev) = client.recv_timeout(until.saturating_duration_since(Instant::now())) {
                if matches!(ev, DiagPortEvent::TxConfirmed(_)) {
                    *confirmed += 1;
                }
            }
        }
    };

    // Warm-up: first-use allocations (mock0 TX-override map entry, lazy statics, ...).
    pump(Duration::from_millis(500), &mut confirmed);

    BUS_IO_ALLOCS.store(0, Ordering::SeqCst);
    let sniffed_before = sniffed.load(Ordering::Relaxed);
    let confirmed_before = confirmed;
    COUNTING.store(true, Ordering::SeqCst);
    pump(Duration::from_secs(2), &mut confirmed);
    COUNTING.store(false, Ordering::SeqCst);

    let allocs = BUS_IO_ALLOCS.load(Ordering::SeqCst);
    let sniffed_n = sniffed.load(Ordering::Relaxed) - sniffed_before;
    let confirmed_n = confirmed - confirmed_before;

    stop.store(true, Ordering::Relaxed);
    let sniffer = drain.join().expect("drain thread");
    drop(sniffer);
    drop(client);
    engine.cmd_disconnect_bus(0).expect("disconnect");
    *BUS_IO_THREAD_START_HOOK.lock() = None;

    println!(
        "bus-io allocations during measurement: {allocs}; tap RX frames: {sniffed_n}; diag TX confirmed: {confirmed_n}"
    );
    assert!(sniffed_n > 10_000, "catch-all tap must see mock0 traffic ({sniffed_n})");
    assert!(confirmed_n > 100, "diag TX must be confirmed ({confirmed_n})");
    assert_eq!(allocs, 0, "bus-io hot path allocated {allocs} times");
}
