//! Shared structural invariants for every parser output (`CompiledReplayEntry` streams).
#![allow(dead_code)]

use nexus_core::{EXT_CAN_ID_MASK, MAX_CAN_FD_DLC, MAX_CLASSICAL_CAN_DLC, STD_CAN_ID_MASK};
use nexus_hal::pipeline::replay::{
    compile_chronological_frames, entries_to_chronological_dtos, CompiledReplayEntry,
    SYNTHETIC_TRACE_ORIGIN_US,
};

/// Every parser must return origin-normalized, chronologically sorted, well-formed frames.
pub fn check_entries(entries: &[CompiledReplayEntry]) {
    if let Some(first) = entries.first() {
        assert_eq!(first.rel_us, 0, "first entry must be origin-normalized");
    }
    let mut prev = 0u64;
    for e in entries {
        assert!(e.rel_us >= prev, "entries must be sorted by rel_us");
        prev = e.rel_us;
        assert_eq!(
            e.frame.timestamp_us,
            SYNTHETIC_TRACE_ORIGIN_US.saturating_add(e.rel_us),
            "timestamp_us must be anchored at SYNTHETIC_TRACE_ORIGIN_US"
        );
        let f = &e.frame;
        assert!(usize::from(f.dlc) <= MAX_CAN_FD_DLC, "dlc > 64");
        if !f.is_fd() {
            assert!(
                usize::from(f.dlc) <= MAX_CLASSICAL_CAN_DLC,
                "classical dlc > 8"
            );
        }
        let mask = if f.is_extended() {
            EXT_CAN_ID_MASK
        } else {
            STD_CAN_ID_MASK
        };
        assert_eq!(
            f.arb_id & !mask,
            0,
            "arb_id carries bits outside the 11/29-bit mask"
        );
        let _ = f.payload();
    }
}

/// DTO projection (what `TraceView` receives) -> recompile (what replay consumes) must be lossless
/// for count, ID, extended/FD flags, DLC and payload, and must preserve relative timing.
pub fn exercise_dto_roundtrip(entries: &[CompiledReplayEntry]) {
    let dtos = entries_to_chronological_dtos(entries);
    assert_eq!(dtos.len(), entries.len());
    let recompiled = compile_chronological_frames(&dtos);
    assert_eq!(
        recompiled.len(),
        entries.len(),
        "compile_chronological_frames dropped frames"
    );
    for (a, b) in entries.iter().zip(&recompiled) {
        assert_eq!(a.frame.arb_id, b.frame.arb_id);
        assert_eq!(a.frame.is_extended(), b.frame.is_extended());
        assert_eq!(a.frame.dlc, b.frame.dlc);
        assert_eq!(a.frame.payload(), b.frame.payload());
        assert_eq!(a.frame.bus_id, b.frame.bus_id);
        // `rel_us` survives unless the 1 s synthetic origin saturates the u64 timestamp.
        if a.rel_us <= u64::MAX - SYNTHETIC_TRACE_ORIGIN_US {
            assert_eq!(
                a.rel_us, b.rel_us,
                "relative timing changed through the DTO plane"
            );
        }
    }
    check_entries(&recompiled);
}
