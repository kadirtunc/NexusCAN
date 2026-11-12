//! KCD (XML) bytes -> parse (fault-tolerant + strict) -> compile -> schema DTO -> decode/encode -> DBC export.
#![no_main]
use libfuzzer_sys::fuzz_target;
use nexus_netdb::{CompiledDatabase, DatabaseFormatParser, DbcWriter, KcdFormat, ParseOptions};

#[path = "common.rs"]
mod common;

fuzz_target!(|data: &[u8]| {
    for fault_tolerant in [true, false] {
        let opts = ParseOptions { fault_tolerant, ..ParseOptions::default() };
        let Ok(bundle) = KcdFormat.parse(data, &opts) else { continue };
        let _ = DbcWriter::new(&bundle.database).write_to_string();
        if let Ok(db) = CompiledDatabase::compile(bundle.database) {
            common::exercise(&db, data);
        }
    }
});
