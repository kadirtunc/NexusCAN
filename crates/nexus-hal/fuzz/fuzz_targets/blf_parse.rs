//! BLF bytes -> parse -> structural invariants -> DTO roundtrip -> encode -> reparse (roundtrip assert).
#![no_main]
use libfuzzer_sys::fuzz_target;
use nexus_hal::pipeline::blf::{encode_blf_bytes, parse_blf_bytes};

#[path = "common.rs"]
mod common;

fuzz_target!(|data: &[u8]| {
    let Ok(entries) = parse_blf_bytes(data) else {
        return;
    };
    common::check_entries(&entries);
    common::exercise_dto_roundtrip(&entries);

    let encoded = encode_blf_bytes(&entries).expect("encoding parsed entries must not fail");
    let reparsed = parse_blf_bytes(&encoded).expect("our own BLF output must parse");
    common::check_entries(&reparsed);
    assert_eq!(reparsed.len(), entries.len(), "BLF roundtrip frame count");
    for (a, b) in entries.iter().zip(&reparsed) {
        assert_eq!(a.frame.arb_id, b.frame.arb_id, "BLF roundtrip arb_id");
        assert_eq!(
            a.frame.is_extended(),
            b.frame.is_extended(),
            "BLF roundtrip IDE"
        );
        assert_eq!(a.frame.is_fd(), b.frame.is_fd(), "BLF roundtrip FD flag");
        assert_eq!(a.frame.dlc, b.frame.dlc, "BLF roundtrip DLC");
        assert_eq!(
            a.frame.payload(),
            b.frame.payload(),
            "BLF roundtrip payload"
        );
        assert_eq!(
            a.frame.is_tx(),
            b.frame.is_tx(),
            "BLF roundtrip TX direction"
        );
        // Encoder stores ns; exact only while `rel_us * 1000` does not saturate.
        if a.rel_us <= u64::MAX / 1_000 {
            assert_eq!(a.rel_us, b.rel_us, "BLF roundtrip rel_us");
        }
        // Bus 255 (channel 256) is written as CAN_FD_MESSAGE (type 100, u16 channel) for FD
        // frames, so every bus survives the roundtrip.
        assert_eq!(a.frame.bus_id, b.frame.bus_id, "BLF roundtrip bus_id");
    }
});
