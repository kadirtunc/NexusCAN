//! RE Toolkit R1 §4: `ReAnalyzer::ingest` performs ZERO heap allocations once a row exists
//! (all phases, CAN-FD rows, overflow frames beyond `MAX_RE_ROWS`), and `encode_snapshot`
//! performs zero allocations into a buffer reserved with `RE_SNAPSHOT_MAX_BYTES`.
//! Separate test binary because it installs a counting global allocator.

use nexus_core::{CanIdKey, RawCanFrame};
use nexus_hal::pipeline::re_analyzer::{ReAnalyzer, RePhase, MAX_RE_ROWS, RE_SNAPSHOT_MAX_BYTES};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

struct CountingAlloc;

thread_local! {
    static ON: Cell<bool> = const { Cell::new(false) };
    static N: Cell<u64> = const { Cell::new(0) };
}

fn record() {
    if ON.try_with(Cell::get).unwrap_or(false) {
        let _ = N.try_with(|c| c.set(c.get() + 1));
    }
}

// SAFETY: forwards every call unchanged to the system allocator; only counts.
unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        record();
        // SAFETY: same contract as the caller's.
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        record();
        // SAFETY: same contract as the caller's.
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        record();
        // SAFETY: same contract as the caller's.
        unsafe { System.realloc(p, l, n) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        // SAFETY: same contract as the caller's.
        unsafe { System.dealloc(p, l) }
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

fn counted(f: impl FnOnce()) -> u64 {
    N.with(|c| c.set(0));
    ON.with(|o| o.set(true));
    f();
    ON.with(|o| o.set(false));
    N.with(Cell::get)
}

#[test]
fn re_ingest_and_encode_do_not_allocate_after_row_creation() {
    let mut a = ReAnalyzer::new();
    let _ = a.start(None);
    let ext = |id: u32, d: &[u8], ts: u64| {
        RawCanFrame::new_fd(0, CanIdKey::new_extended(id).unwrap(), d, false, ts).unwrap()
    };
    // Warm-up: fill every row slot (allocation allowed at row creation).
    for id in 0..MAX_RE_ROWS as u32 {
        a.ingest(&ext(id, &[0; 64], 0));
    }
    let mut seed = 0x1234_5678u32;
    let frames: Vec<RawCanFrame> = (0..60_000u64)
        .map(|i| {
            let mut d = [0u8; 64];
            for x in d.iter_mut() {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *x = (seed >> 24) as u8;
            }
            // Every 7th frame targets an overflow ID (no row): counted, never allocated.
            let id = if i % 7 == 0 {
                0x1000_0000 + i as u32
            } else {
                (i % MAX_RE_ROWS as u64) as u32
            };
            // Timestamps span several seconds so heat-window decay runs inside the count.
            ext(id, &d, i * 100)
        })
        .collect();
    let mut buf: Vec<u8> = Vec::with_capacity(RE_SNAPSHOT_MAX_BYTES);

    for (k, phase) in [RePhase::Free, RePhase::Baseline, RePhase::Action]
        .into_iter()
        .enumerate()
    {
        let _ = a.set_phase(phase);
        let chunk = &frames[k * 20_000..(k + 1) * 20_000];
        let n = counted(|| {
            for f in chunk {
                a.ingest(f);
            }
        });
        assert_eq!(n, 0, "ingest allocated {n} times in phase {phase:?}");
        let n = counted(|| a.encode_snapshot(&mut buf, k == 0));
        assert_eq!(
            n,
            0,
            "encode_snapshot allocated {n} times (full={})",
            k == 0
        );
    }
    assert!(a.status().overflow_rows > 0);
}
