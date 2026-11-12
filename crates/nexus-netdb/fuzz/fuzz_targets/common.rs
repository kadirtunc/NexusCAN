//! Shared helpers for the nexus-netdb fuzz targets (included with `#[path]`).
use nexus_netdb::{CompiledDatabase, DatabaseInfoDto, DecodedSignalSample};

pub fn sample() -> DecodedSignalSample {
    DecodedSignalSample {
        signal_id: 0,
        raw_bits: 0,
        raw_int: 0,
        physical_value: 0.0,
        out_of_range: false,
        is_mux_switch: false,
    }
}

pub fn info() -> DatabaseInfoDto {
    DatabaseInfoDto {
        name: String::new(),
        version: None,
        format: String::new(),
        source_encoding: String::new(),
        message_count: 0,
        signal_count: 0,
        diagnostics: Vec::new(),
    }
}

/// Exercises every runtime entry point of a compiled database with `payload`.
/// Must never panic, whatever database the parser accepted.
pub fn exercise(db: &CompiledDatabase, payload: &[u8]) {
    let _ = db.to_schema_dto(info());
    let mut out = [sample(); 128];
    let mut sw = [(0u32, 0i64); 32];
    for (i, m) in db.messages.iter().enumerate().take(64) {
        let _ = db.decode_payload_into(m.can_id, payload, &mut out, &mut sw);
        // Encode every signal with a value taken from the payload (finite or not).
        let vals: Vec<(u32, f64)> = m
            .all_signal_ids
            .iter()
            .take(32)
            .enumerate()
            .map(|(k, &id)| {
                let off = (i + k * 8) % payload.len().max(1);
                let mut b = [0u8; 8];
                for (j, x) in b.iter_mut().enumerate() {
                    *x = payload.get(off + j).copied().unwrap_or(0);
                }
                (id, f64::from_le_bytes(b))
            })
            .collect();
        let mut p = [0u8; 64];
        let _ = db.encode_payload_into(m.can_id, &vals, &mut p);
        let _ = db.encode_raw_frame(0, m.can_id, &vals, 0);
    }
}
