//! Raw bytes with a neutral file name -> `parse_trace_entries_from_bytes` (BLF sniffing + text
//! content-based format detection) -> invariants -> DTO roundtrip.
#![no_main]
use libfuzzer_sys::fuzz_target;
use nexus_hal::pipeline::replay::parse_trace_entries_from_bytes;

#[path = "common.rs"]
mod common;

fuzz_target!(|data: &[u8]| {
    // ".trc" is the default extension, i.e. pure content sniffing decides the format.
    let Ok(entries) = parse_trace_entries_from_bytes("fuzz.trc", data) else {
        return;
    };
    common::check_entries(&entries);
    common::exercise_dto_roundtrip(&entries);
});
