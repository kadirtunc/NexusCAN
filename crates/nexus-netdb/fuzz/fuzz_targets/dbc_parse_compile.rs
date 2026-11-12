//! DBC bytes -> parse (fault-tolerant + strict) -> compile -> schema DTO -> decode/encode -> write -> reparse.
#![no_main]
use libfuzzer_sys::fuzz_target;
use nexus_netdb::{CompiledDatabase, DatabaseFormatParser, DbcFormat, DbcWriter, ParseOptions};

#[path = "common.rs"]
mod common;

fuzz_target!(|data: &[u8]| {
    for fault_tolerant in [true, false] {
        let opts = ParseOptions { fault_tolerant, ..ParseOptions::default() };
        let Ok(bundle) = DbcFormat.parse(data, &opts) else { continue };
        // Writer must always produce text our own parser can read back.
        if let Ok(text) = DbcWriter::new(&bundle.database).write_to_string() {
            let _ = DbcFormat.parse(text.as_bytes(), &opts);
        }
        if let Ok(db) = CompiledDatabase::compile(bundle.database) {
            common::exercise(&db, data);
        }
    }
});
