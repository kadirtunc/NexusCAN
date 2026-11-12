//! WP-6 regression tests: hostile / malformed trace inputs found by (or written for) the
//! `crates/nexus-hal/fuzz` cargo-fuzz targets. They run in the normal stable `cargo test`.
//!
//! Every input here must be handled without panicking; the parsers return `Ok` (possibly with
//! fewer frames) or a typed `HalError`, never abort the process.

use nexus_hal::pipeline::blf::{encode_blf_bytes, parse_blf_bytes};
use nexus_hal::pipeline::replay::{
    compile_chronological_frames, entries_to_chronological_dtos, parse_trace_bytes,
    parse_trace_entries_from_bytes, parse_trace_text, CompiledReplayEntry,
};

fn assert_sorted_and_normalized(entries: &[CompiledReplayEntry]) {
    if let Some(first) = entries.first() {
        assert_eq!(first.rel_us, 0);
    }
    assert!(entries.windows(2).all(|w| w[0].rel_us <= w[1].rel_us));
}

/// candump compact CAN-FD `<id>##<flags><hex>` where the odd-length right-hand side starts with a
/// multi-byte UTF-8 char: `&rhs[..1]` used to slice inside the char and panic.
#[test]
fn candump_fd_flags_nibble_multibyte_char_does_not_panic() {
    for content in [
        "(1.000000) can0 123##\u{e9}a\n",
        "(1.000000) can0 123##\u{20ac}\n",
        "(1.000000) can0 123##\u{1F600}abc\n",
    ] {
        let entries = parse_trace_text("x.log", content).expect("text parser returns Ok");
        assert!(
            entries.is_empty(),
            "non-hex flags nibble must skip the line"
        );
    }
    // A valid compact FD line on either side of the hostile one still parses.
    let mixed = "(1.0) can0 123##1AABB\n(1.1) can0 123##\u{e9}a\n(1.2) can0 124##0CC\n";
    let entries = parse_trace_text("x.log", mixed).unwrap();
    assert_eq!(entries.len(), 2);
}

/// fuzz `trace_text_parse` crash-ef5dc143…: candump interface name whose last non-digit char is
/// multi-byte (`vcan\u{FFFD}0`); `rfind(..) + 1` landed inside the char and the slice panicked.
#[test]
fn candump_iface_with_multibyte_char_before_digits_does_not_panic() {
    for content in [
        "(1762634400.000000) vcan\u{FFFD}0 101#081F9600A8014400\n",
        "(1.0) ab\u{e9}1 123#00\n",
        "(1.0) \u{1F600}7 123#00\n",
        "(1.0) \u{e9} 123#00\n",
    ] {
        let entries = parse_trace_text("x.log", content).expect("text parser returns Ok");
        assert_eq!(
            entries.len(),
            1,
            "frame on an oddly named interface still parses"
        );
    }
    let e = parse_trace_text("x.log", "(1.0) ab\u{e9}7 123#00\n").unwrap();
    assert_eq!(e[0].frame.bus_id, 7);
}

/// Finite but huge timestamps saturate `f64 as i128` to `i128::MAX` / `i128::MIN`; the origin
/// normalization `ts - origin` used to overflow (panic in debug, silent wrap in release).
#[test]
fn extreme_finite_timestamps_do_not_overflow_origin_normalization() {
    let cases: [(&str, &str); 4] = [
        ("x.log", "(1e300) can0 123#00\n(-1e300) can0 124#01\n"),
        (
            "x.asc",
            "date Thu Jan 1\n1e300 1 123 Rx d 1 00\n-1e300 1 124 Rx d 1 01\n",
        ),
        ("x.log", "1e300 can0 123#00\n-1e300 can0 124#01\n"),
        (
            "x.csv",
            "Index,Time_s,Bus,Protocol,ID_Hex,Direction,DLC,Symbol,Data_Hex,Decoded_Signals\n\
             1,1e300,1,CC,0x123,Rx,1,\"\",\"00\",\"\"\n\
             2,-1e300,1,CC,0x124,Rx,1,\"\",\"01\",\"\"\n",
        ),
    ];
    for (name, content) in cases {
        let entries = parse_trace_text(name, content).expect("text parser returns Ok");
        assert_sorted_and_normalized(&entries);
        if entries.len() == 2 {
            // The earliest (-1e300) frame is the origin; the other one saturates at u64::MAX.
            assert_eq!(entries[0].frame.arb_id, 0x124);
            assert_eq!(entries[1].rel_us, u64::MAX);
        }
        let dtos = entries_to_chronological_dtos(&entries);
        assert_eq!(compile_chronological_frames(&dtos).len(), entries.len());
    }
}

/// Every header-only / truncated BLF prefix of a real encoder output must be rejected or parsed,
/// never panic; the full buffer must roundtrip.
#[test]
fn blf_truncated_prefixes_never_panic() {
    let content = "(1.0) can0 123#0011\n(1.5) can0 18FF50E5#AABBCCDD\n(2.0) can0 205##1DEADBEEF00112233445566778899\n";
    let entries = parse_trace_text("x.log", content).unwrap();
    assert_eq!(entries.len(), 3);
    let blf = encode_blf_bytes(&entries).unwrap();
    for cut in 0..blf.len() {
        let _ = parse_blf_bytes(&blf[..cut]);
        let _ = parse_trace_entries_from_bytes("x.blf", &blf[..cut]);
    }
    let back = parse_blf_bytes(&blf).unwrap();
    assert_eq!(back.len(), entries.len());
    for (a, b) in entries.iter().zip(&back) {
        assert_eq!(a.frame.arb_id, b.frame.arb_id);
        assert_eq!(a.frame.dlc, b.frame.dlc);
        assert_eq!(a.frame.payload(), b.frame.payload());
        assert_eq!(a.rel_us, b.rel_us);
    }
}

/// Binary garbage routed through the IPC import path with each supported extension.
#[test]
fn binary_garbage_through_every_extension_does_not_panic() {
    let mut garbage = Vec::with_capacity(4096);
    let mut x = 0x1234_5678u32;
    for _ in 0..4096 {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        garbage.push((x & 0xFF) as u8);
    }
    for name in ["g.trc", "g.asc", "g.log", "g.csv", "g.blf"] {
        let _ = parse_trace_bytes(name, &garbage);
    }
    let mut logg = garbage.clone();
    logg[..4].copy_from_slice(b"LOGG");
    let _ = parse_trace_bytes("g.trc", &logg);
}
