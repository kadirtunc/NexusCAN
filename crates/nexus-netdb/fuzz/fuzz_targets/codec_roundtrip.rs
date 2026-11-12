//! Decode/encode round trip against a fixed reference database covering Intel / Motorola cross-byte,
//! signed, f32 / f64, CAN-FD offsets > 8 bytes, standard + cascaded + range multiplexing.
//!
//! Property: for any payload `p1`, `p2 = enc(dec(p1))` and `p3 = enc(dec(p2))` must be identical
//! (the codec reaches a fixed point after one pass), and nothing may panic.
#![no_main]
use libfuzzer_sys::fuzz_target;
use nexus_core::CanIdKey;
use nexus_netdb::{parse_and_compile, CompiledDatabase, ParseOptions};
use std::sync::OnceLock;

#[path = "common.rs"]
mod common;

const REF_DBC: &str = r#"VERSION "fuzz"
BU_: ECU VCU
BO_ 256 Engine: 8 ECU
 SG_ Rpm : 7|16@0+ (0.25,0) [0|16000] "rpm" VCU
 SG_ Temp : 19|12@0- (0.1,-40) [-200|200] "degC" VCU
 SG_ Mux M : 24|4@1+ (1,0) [0|15] "" VCU
 SG_ CellA m0 : 32|16@1+ (0.001,0) [0|5] "V" VCU
 SG_ Sub m1M : 32|8@1+ (1,0) [0|255] "" VCU
 SG_ Deep m3 : 40|16@1- (1,0) [0|0] "" VCU
BO_ 2566844926 FdFrame: 64 ECU
 SG_ F32 : 64|32@1- (1,0) [0|0] "" VCU
 SG_ F64 : 128|64@1- (1,0) [0|0] "" VCU
 SG_ Wide : 263|64@0+ (1,0) [0|0] "" VCU
 SG_ Tail : 500|12@1- (0.5,10) [-1000|1000] "" VCU
SIG_VALTYPE_ 2566844926 F32 : 1;
SIG_VALTYPE_ 2566844926 F64 : 2;
SG_MUL_VAL_ 256 Deep Sub 3-3, 10-15;
"#;

fn db() -> &'static CompiledDatabase {
    static DB: OnceLock<CompiledDatabase> = OnceLock::new();
    DB.get_or_init(|| {
        parse_and_compile(REF_DBC.as_bytes(), Some("ref.dbc"), &ParseOptions::default())
            .expect("reference DB compiles")
            .0
    })
}

fn decode_values(db: &CompiledDatabase, id: CanIdKey, p: &[u8]) -> Vec<(u32, f64)> {
    let mut out = [common::sample(); 64];
    let mut sw = [(0u32, 0i64); 16];
    let Some(s) = db.decode_payload_into(id, p, &mut out, &mut sw) else { return Vec::new() };
    out[..s.decoded_count]
        .iter()
        .map(|x| (x.signal_id, x.physical_value))
        .collect()
}

fuzz_target!(|data: &[u8]| {
    let db = db();
    if data.is_empty() {
        return;
    }
    let ids = [CanIdKey::Standard(0x100), CanIdKey::Extended(0x18FF_FEFE)];
    let id = ids[(data[0] & 1) as usize];
    let p1 = &data[1..];
    common::exercise(db, p1);

    let v1 = decode_values(db, id, p1);
    let mut p2 = [0u8; 64];
    if db.encode_payload_into(id, &v1, &mut p2).is_err() {
        return; // e.g. NaN float bit patterns are refused for TX
    }
    let v2 = decode_values(db, id, &p2);
    let mut p3 = [0u8; 64];
    db.encode_payload_into(id, &v2, &mut p3)
        .expect("re-encoding a decoded, previously encodable frame must succeed");
    assert_eq!(p2, p3, "codec must reach a fixed point after one decode/encode pass");
});
