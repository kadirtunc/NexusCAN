//! C7 gate (contract cansub-v1 §9): heap allocations made by `Channel::send` in steady state.
//!
//! Own test binary on purpose (`#[global_allocator]`). Thread-local gate: only the test thread
//! counts, the in-process sim threads do not.
//!
//! Budget: the SDK itself allocates nothing per send (reused `BytesMut` message buffer, reused
//! tungstenite write buffer). rustls' buffered API still allocates one TLS record buffer per
//! flushed write, i.e. one per `send` call → ≤ 1 per WebSocket message; a 32-frame batch is one
//! HDLC / one message → ≤ 1/32 per frame.
#![cfg(feature = "sim")]

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use cansub::proto::{CanFrame, FrameFlags};
use cansub::sim::{SimChaos, SimConfig, SimHandle, SimSource};
use cansub::{Channel, ConnectOptions, Device};

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

fn frame(i: u32) -> CanFrame {
    let mut f = CanFrame {
        timestamp_us: 0,
        id: 0x100 + (i & 0x3FF),
        flags: FrameFlags::default(),
        dlc: 8,
        data: [0; 64],
    };
    f.data[..4].copy_from_slice(&i.to_le_bytes());
    f
}

/// Drains whatever the sim sent back (outside the counted region).
fn drain(ch: &mut Channel) {
    ch.poll(Duration::from_millis(1), &mut |_| {}).unwrap();
}

#[test]
fn send_allocations_per_frame() {
    let s = SimHandle::start(SimConfig {
        channels: 2,
        source: SimSource::Silent,
        chaos: SimChaos::default(),
        ..SimConfig::default()
    })
    .unwrap();
    let opts = ConnectOptions {
        host: format!("127.0.0.1:{}", s.addr().port()),
        device_id: Some("aabbccdd".into()),
        ..ConnectOptions::default()
    };
    let d = Device::connect_with_root(opts, s.root_ca_der()).unwrap();
    let mut ch = d.open(1).unwrap();

    let mut batch = [frame(0); 32];
    // Warm-up: grow every reused buffer to its steady-state size.
    for i in 0..1_000u32 {
        ch.send(&[frame(i)]).unwrap();
        batch[0] = frame(i);
        ch.send(&batch).unwrap();
        if i % 100 == 0 {
            drain(&mut ch);
        }
    }

    // 10 000 single-frame sends.
    let mut single = 0u64;
    for round in 0..10u32 {
        let (_, a) = counted(|| {
            for i in 0..1_000u32 {
                ch.send(&[frame(round * 1_000 + i)]).unwrap();
            }
        });
        single += a;
        drain(&mut ch);
    }
    // 1 000 × 32-frame batch sends.
    let mut batched = 0u64;
    for round in 0..10u32 {
        let (_, a) = counted(|| {
            for i in 0..100u32 {
                batch[0] = frame(round * 100 + i);
                ch.send(&batch).unwrap();
            }
        });
        batched += a;
        drain(&mut ch);
    }
    ch.close(&d).unwrap();

    let per_single = single as f64 / 10_000.0;
    let per_batched = batched as f64 / 32_000.0;
    eprintln!(
        "ALLOC TX single: {single} allocs / 10000 frames ({per_single:.3} per frame) | \
         batch32: {batched} allocs / 32000 frames ({per_batched:.4} per frame)"
    );
    // ≤ 1 allocation per WebSocket message (rustls record), none from the SDK.
    assert!(
        single <= 10_000,
        "single-frame send: {single} allocs / 10000"
    );
    assert!(per_batched < 0.1, "batched send: {batched} allocs / 32000");
}
