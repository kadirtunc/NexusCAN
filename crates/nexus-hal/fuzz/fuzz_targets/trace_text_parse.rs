//! 1 selector byte (format hint via file extension) + text trace body ->
//! `parse_trace_text` and `parse_trace_bytes` -> invariants -> DTO -> `compile_chronological_frames`.
#![no_main]
use libfuzzer_sys::fuzz_target;
use nexus_hal::pipeline::replay::{
    compile_chronological_frames, entries_to_chronological_dtos, parse_trace_bytes,
    parse_trace_text,
};

#[path = "common.rs"]
mod common;

const NAMES: [&str; 4] = ["fuzz.asc", "fuzz.trc", "fuzz.log", "fuzz.csv"];

fuzz_target!(|data: &[u8]| {
    let Some((&sel, body)) = data.split_first() else {
        return;
    };
    let name = NAMES[usize::from(sel) % NAMES.len()];
    let content = String::from_utf8_lossy(body);

    if let Ok(entries) = parse_trace_text(name, &content) {
        common::check_entries(&entries);
        let dtos = entries_to_chronological_dtos(&entries);
        let recompiled = compile_chronological_frames(&dtos);
        assert_eq!(recompiled.len(), entries.len());
        common::exercise_dto_roundtrip(&entries);
    }

    // Stateless IPC import path (`import_trace_bytes`): text formats never touch the BLF decoder
    // unless the body itself carries a LOGG header.
    if let Ok(loaded) = parse_trace_bytes(name, body) {
        assert_eq!(loaded.summary.frame_count, loaded.frames.len());
        let recompiled = compile_chronological_frames(&loaded.frames);
        assert_eq!(recompiled.len(), loaded.frames.len());
        common::check_entries(&recompiled);
    }
});
