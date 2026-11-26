//! C7 QA gate, contract cansub-v1 §9 "hot path without per-frame Vec/String": counts heap
//! allocations made on the calling thread inside `CansubChannel::recv_batch` (→ SDK
//! `Channel::poll`) and `send_frame` (→ SDK `Channel::send`) after warm-up.
//!
//! Own test binary on purpose (global allocator). Thread-local gate: only the test thread counts,
//! the in-process sim threads do not.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cansub::sim::{SimChaos, SimConfig, SimHandle, SimSource};
use cansub::Device;
use nexus_core::RawCanFrame;
use nexus_hal::traits::AdapterDriver;
use nexus_hal::{CansubDriver, ChannelConfigDto};

struct CountingAlloc;
static ALLOCS: AtomicU64 = AtomicU64::new(0);
thread_local! {
    static COUNT_ME: Cell<bool> = const { Cell::new(false) };
}

#[inline]
fn record() {
    if COUNT_ME.try_with(Cell::get).unwrap_or(false) {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
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

fn counted<T>(f: impl FnOnce() -> T) -> (T, u64) {
    let before = ALLOCS.load(Ordering::Relaxed);
    COUNT_ME.with(|c| c.set(true));
    let r = f();
    COUNT_ME.with(|c| c.set(false));
    (r, ALLOCS.load(Ordering::Relaxed) - before)
}

#[test]
fn hot_path_allocations_per_frame() {
    let s = SimHandle::start(SimConfig {
        channels: 2,
        source: SimSource::Mock { fps: 20_000 },
        chaos: SimChaos::default(),
        ..SimConfig::default()
    })
    .unwrap();
    let root = s.root_ca_der().to_vec();
    let drv = Arc::new(CansubDriver::with_connector(Arc::new(move |o| {
        Device::connect_with_root(o, &root)
    })));
    let host = format!("127.0.0.1:{}", s.addr().port());
    let descs = drv
        .add_known_host(&host, Some("aabbccdd".into()), false)
        .unwrap();
    let cfg = ChannelConfigDto {
        listen_only: false,
        ..ChannelConfigDto::default()
    };
    let mut ch = drv.open_channel(&descs[0], &cfg).unwrap();
    let mut buf = [RawCanFrame::zeroed(); 256];
    // Warm-up.
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_millis(500) {
        ch.recv_batch(&mut buf, 5).unwrap();
    }

    // RX: count allocations over 2 s of traffic.
    let ((frames, calls), rx_allocs) = counted(|| {
        let (mut frames, mut calls) = (0u64, 0u64);
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(2) {
            frames += ch.recv_batch(&mut buf, 5).unwrap() as u64;
            calls += 1;
        }
        (frames, calls)
    });

    // TX: 2 000 single-frame send_frame calls.
    let mut f = RawCanFrame::zeroed();
    f.arb_id = 0x123;
    f.dlc = 8;
    let (sent, tx_allocs) = counted(|| {
        let mut ok = 0u64;
        for i in 0..2_000u32 {
            f.data[0] = i as u8;
            if ch.send_frame(&f).is_ok() {
                ok += 1;
            }
        }
        ok
    });
    eprintln!(
        "ALLOC RX: {rx_allocs} allocs / {frames} frames / {calls} recv_batch calls ({:.4} per frame) | \
         TX: {tx_allocs} allocs / {sent} send_frame ({:.2} per frame)",
        rx_allocs as f64 / frames.max(1) as f64,
        tx_allocs as f64 / sent.max(1) as f64
    );
    ch.close().unwrap();
    assert!(frames > 30_000);
    // RX: allocations are per WebSocket message (tungstenite), never per frame.
    assert!(
        rx_allocs < frames / 4,
        "RX allocates per frame: {rx_allocs} / {frames}"
    );
}
