//! BLF encode -> parse roundtrip across the full `bus_id` range (0, 254, 255), classical and
//! CAN-FD (8 / 12 / 64 bytes). Bus 255 maps to 1-based BLF channel 256, which does not fit the
//! `u8` channel of `CAN_FD_MESSAGE_64` (type 101); the encoder must fall back to
//! `CAN_FD_MESSAGE` (type 100, `u16` channel) for those frames and keep type 101 otherwise.

use flate2::read::ZlibDecoder;
use nexus_core::{CanIdKey, RawCanFrame, FLAG_ESI, FLAG_TX};
use nexus_hal::pipeline::blf::{encode_blf_bytes, parse_blf_bytes, BLF_FILE_HEADER_SIZE};
use nexus_hal::pipeline::replay::{CompiledReplayEntry, SYNTHETIC_TRACE_ORIGIN_US};
use std::io::Read;

fn entry(rel_us: u64, mut frame: RawCanFrame, tx: bool) -> CompiledReplayEntry {
    frame.timestamp_us = SYNTHETIC_TRACE_ORIGIN_US + rel_us;
    if tx {
        frame.flags |= FLAG_TX;
    }
    CompiledReplayEntry { rel_us, frame }
}

fn payload(len: usize, seed: u8) -> Vec<u8> {
    (0..len)
        .map(|i| seed.wrapping_add((i as u8).wrapping_mul(7)))
        .collect()
}

fn build_entries() -> Vec<CompiledReplayEntry> {
    let mut out = Vec::new();
    let mut rel_us = 0u64;
    for (bi, bus) in [0u8, 254, 255].into_iter().enumerate() {
        let seed = (bi as u8).wrapping_mul(0x31);
        let tx = bi % 2 == 1;

        // Classical 8 B, standard ID.
        let f = RawCanFrame::new_classical(bus, CanIdKey::Standard(0x123), &payload(8, seed), 0)
            .unwrap();
        out.push(entry(rel_us, f, tx));
        rel_us += 137;

        // Classical 3 B, extended ID, opposite direction.
        let f = RawCanFrame::new_classical(
            bus,
            CanIdKey::Extended(0x18FF_50E5),
            &payload(3, seed ^ 0x55),
            0,
        )
        .unwrap();
        out.push(entry(rel_us, f, !tx));
        rel_us += 1;

        // Classical RTR, DLC 5.
        let f = RawCanFrame::new_rtr(bus, CanIdKey::Standard(0x7FF), 5, 0).unwrap();
        out.push(entry(rel_us, f, tx));
        rel_us += 999;

        // CAN-FD 8 B, no BRS.
        let f = RawCanFrame::new_fd(
            bus,
            CanIdKey::Standard(0x201),
            &payload(8, seed ^ 1),
            false,
            0,
        )
        .unwrap();
        out.push(entry(rel_us, f, tx));
        rel_us += 250;

        // CAN-FD 12 B, BRS, extended, ESI.
        let mut f = RawCanFrame::new_fd(
            bus,
            CanIdKey::Extended(0x1ABC_DEF0),
            &payload(12, seed ^ 2),
            true,
            0,
        )
        .unwrap();
        f.flags |= FLAG_ESI;
        out.push(entry(rel_us, f, !tx));
        rel_us += 12_345;

        // CAN-FD 64 B, BRS.
        let f = RawCanFrame::new_fd(
            bus,
            CanIdKey::Standard(0x0),
            &payload(64, seed ^ 3),
            true,
            0,
        )
        .unwrap();
        out.push(entry(rel_us, f, tx));
        rel_us += 3;
    }
    out
}

/// Decompresses every `LOG_CONTAINER` of our own (zlib, header v1) output and returns the inner
/// object type sequence.
fn inner_object_types(blf: &[u8]) -> Vec<u32> {
    let mut inner = Vec::new();
    let mut pos = BLF_FILE_HEADER_SIZE;
    while pos + 32 <= blf.len() {
        assert_eq!(&blf[pos..pos + 4], b"LOBJ");
        let size = u32::from_le_bytes(blf[pos + 8..pos + 12].try_into().unwrap()) as usize;
        let mut dec = ZlibDecoder::new(&blf[pos + 32..pos + size]);
        dec.read_to_end(&mut inner).unwrap();
        pos += size + (4 - size % 4) % 4;
    }
    let mut types = Vec::new();
    let mut p = 0usize;
    while p + 32 <= inner.len() {
        assert_eq!(&inner[p..p + 4], b"LOBJ");
        let size = u32::from_le_bytes(inner[p + 8..p + 12].try_into().unwrap()) as usize;
        types.push(u32::from_le_bytes(
            inner[p + 12..p + 16].try_into().unwrap(),
        ));
        p += size + (4 - size % 4) % 4;
    }
    types
}

#[test]
fn blf_roundtrip_preserves_bus_0_254_255_classical_and_fd() {
    let entries = build_entries();
    let bytes = encode_blf_bytes(&entries).expect("encode");
    let parsed = parse_blf_bytes(&bytes).expect("reparse own output");
    assert_eq!(parsed.len(), entries.len());

    for (i, (a, b)) in entries.iter().zip(&parsed).enumerate() {
        assert_eq!(a.frame.bus_id, b.frame.bus_id, "#{i} bus_id");
        assert_eq!(a.frame.arb_id, b.frame.arb_id, "#{i} arb_id");
        assert_eq!(a.frame.is_extended(), b.frame.is_extended(), "#{i} ext");
        assert_eq!(a.frame.is_fd(), b.frame.is_fd(), "#{i} fd");
        assert_eq!(a.frame.is_brs(), b.frame.is_brs(), "#{i} brs");
        assert_eq!(a.frame.is_esi(), b.frame.is_esi(), "#{i} esi");
        assert_eq!(a.frame.is_rtr(), b.frame.is_rtr(), "#{i} rtr");
        assert_eq!(a.frame.dlc, b.frame.dlc, "#{i} dlc");
        assert_eq!(a.frame.payload(), b.frame.payload(), "#{i} payload");
        assert_eq!(a.frame.is_tx(), b.frame.is_tx(), "#{i} tx");
        assert_eq!(a.rel_us, b.rel_us, "#{i} rel_us");
    }
    // Full structural equality (flags byte, timestamp, data padding) as well.
    assert_eq!(parsed, entries);
}

#[test]
fn blf_encoder_uses_type_100_only_for_fd_frames_on_bus_255() {
    let entries = build_entries();
    let types = inner_object_types(&encode_blf_bytes(&entries).unwrap());
    assert_eq!(types.len(), entries.len());
    for (e, ty) in entries.iter().zip(&types) {
        let expected = match (e.frame.is_fd(), e.frame.bus_id) {
            (false, _) => 1,    // CAN_MESSAGE (u16 channel for every bus)
            (true, 255) => 100, // CAN_FD_MESSAGE (u16 channel)
            (true, _) => 101,   // CAN_FD_MESSAGE_64 (u8 channel), unchanged default
        };
        assert_eq!(
            *ty,
            expected,
            "bus {} fd {}",
            e.frame.bus_id,
            e.frame.is_fd()
        );
    }
}
