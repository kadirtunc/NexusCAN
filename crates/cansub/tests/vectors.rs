//! L1 — official CSS Electronics WebSocket test vectors TV-01..TV-20 (contract §4).
//!
//! Source: <https://canlogger.csselectronics.com/cansub-docs/cansub4/api/api_ws.html>
//! (hex copied verbatim). For each TV: the expected `Event` list and `DecoderStats`, decoded
//! message-by-message AND byte-by-byte; for every single, valid HDLC frame `encode_hdlc` must
//! reproduce the wire bytes exactly.

use cansub::proto::{
    encode_hdlc, CanFrame, Decoder, DecoderStats, EncodeError, ErrorKind, Event, FrameFlags,
    DEVICE_EPOCH_UNIX_US, MAX_RX_HDLC, MAX_WIRE_HDLC,
};

fn h(s: &str) -> Vec<u8> {
    hex::decode(s.replace(' ', "")).expect("valid hex")
}

fn none() -> FrameFlags {
    FrameFlags::default()
}

fn frame(ts: u64, id: u32, flags: FrameFlags, dlc: u8, data: &[u8]) -> CanFrame {
    let mut d = [0u8; 64];
    d[..data.len()].copy_from_slice(data);
    CanFrame {
        timestamp_us: ts,
        id,
        flags,
        dlc,
        data: d,
    }
}

fn std1(id: u32, b: u8) -> CanFrame {
    frame(0, id, none(), 1, &[b])
}

fn ok(hdlc_ok: u64) -> DecoderStats {
    DecoderStats {
        hdlc_ok,
        ..DecoderStats::default()
    }
}

fn decode_msgs(msgs: &[Vec<u8>]) -> (Vec<Event>, DecoderStats) {
    let mut d = Decoder::new();
    let mut ev = Vec::new();
    for m in msgs {
        d.push(m, &mut |e| ev.push(e));
    }
    (ev, d.stats())
}

fn decode_bytewise(msgs: &[Vec<u8>]) -> (Vec<Event>, DecoderStats) {
    let mut d = Decoder::new();
    let mut ev = Vec::new();
    for b in msgs.iter().flatten() {
        d.push(core::slice::from_ref(b), &mut |e| ev.push(e));
    }
    (ev, d.stats())
}

fn check(msgs: &[&str], expected: &[Event], stats: DecoderStats) {
    let msgs: Vec<Vec<u8>> = msgs.iter().map(|m| h(m)).collect();
    let (ev, st) = decode_msgs(&msgs);
    assert_eq!(ev, expected, "events (per message)");
    assert_eq!(st, stats, "stats (per message)");
    let (ev, st) = decode_bytewise(&msgs);
    assert_eq!(ev, expected, "events (byte-wise)");
    assert_eq!(st, stats, "stats (byte-wise)");
}

fn frames(evs: &[Event]) -> Vec<CanFrame> {
    evs.iter()
        .map(|e| match e {
            Event::Frame(f) => *f,
            Event::Error { .. } => panic!("error frames are not encodable"),
        })
        .collect()
}

/// `encode_hdlc(frames)` must produce exactly ONE HDLC equal to `wire`.
fn check_encode(frames: &[CanFrame], wire: &str) {
    let wire = h(wire);
    let mut out = [0u8; MAX_WIRE_HDLC];
    let (n, c) = encode_hdlc(frames, &mut out).expect("encodable");
    assert_eq!(c, frames.len(), "all frames in one HDLC");
    assert_eq!(&out[..n], &wire[..], "encode byte-equal");
    // Exact-size buffer must also work; one byte less must not.
    let mut exact = vec![0u8; wire.len()];
    assert_eq!(
        encode_hdlc(frames, &mut exact),
        Ok((wire.len(), frames.len()))
    );
    let mut short = vec![0u8; wire.len() - 1];
    if frames.len() == 1 {
        assert_eq!(
            encode_hdlc(frames, &mut short),
            Err(EncodeError::BufferTooSmall)
        );
    } else {
        let (_, c) = encode_hdlc(frames, &mut short).expect("prefix fits");
        assert!(c < frames.len());
    }
}

const TV09: &str = "7E 00 00 00 00 00 00 01 00 01 00 42 2D 3E 52 7E";
const H1: &str = "7E 00 00 00 00 00 00 01 00 01 01 35 2A 0E C4 7E";
const H2: &str = "7E 00 00 00 00 00 00 01 00 02 02 87 0E 0C BD 7E";
const H3: &str = "7E 00 00 00 00 00 00 01 00 03 03 E9 12 0D 6A 7E";
const H4: &str = "7E 00 00 00 00 00 00 01 00 04 04 38 37 0E 0E 7E";

#[test]
fn tv01_standard_id() {
    let w = "7E 1C AE 8C 13 E0 00 01 07 FF 00 98 4F D1 B8 7E";
    // 2026-01-01T00:00:00Z = 365 days after the device epoch.
    let f = frame(365 * 86_400 * 1_000_000, 0x7FF, none(), 1, &[0]);
    assert_eq!(f.unix_us(), 1_767_225_600_000_000);
    check(&[w], &[Event::Frame(f)], ok(1));
    check_encode(&[f], w);
}

#[test]
fn tv02_extended_id() {
    let w = "7E 39 5D 18 27 C0 00 01 9F FF FF FF 00 82 83 9F 92 7E";
    let f = frame(
        730 * 86_400 * 1_000_000,
        0x1FFF_FFFF,
        FrameFlags::EXTENDED,
        1,
        &[0],
    );
    assert_eq!(f.unix_us(), 1_798_761_600_000_000);
    check(&[w], &[Event::Frame(f)], ok(1));
    check_encode(&[f], w);
}

#[test]
fn tv03_remote_frame() {
    let w = "7E 00 00 00 00 00 00 48 00 01 EF 87 F8 40 7E";
    let f = frame(0, 1, FrameFlags::RTR, 8, &[]);
    assert_eq!(f.len(), 0, "RTR carries no data, DLC preserved");
    check(&[w], &[Event::Frame(f)], ok(1));
    check_encode(&[f], w);
}

#[test]
fn tv04_fd() {
    let w = "7E 00 00 00 00 00 00 81 00 01 00 AF 74 88 69 7E";
    let f = frame(0, 1, FrameFlags::FD, 1, &[0]);
    check(&[w], &[Event::Frame(f)], ok(1));
    check_encode(&[f], w);
}

#[test]
fn tv05_fd_brs() {
    let w = "7E 00 00 00 00 00 00 C1 00 01 00 34 60 D0 54 7E";
    let f = frame(0, 1, FrameFlags::FD.union(FrameFlags::BRS), 1, &[0]);
    check(&[w], &[Event::Frame(f)], ok(1));
    check_encode(&[f], w);
}

#[test]
fn tv06_fd_esi() {
    let w = "7E 00 00 00 00 00 00 A1 00 01 00 0F 46 27 57 7E";
    let f = frame(0, 1, FrameFlags::FD.union(FrameFlags::ESI), 1, &[0]);
    check(&[w], &[Event::Frame(f)], ok(1));
    check_encode(&[f], w);
}

#[test]
fn tv07_fd_64_bytes() {
    let w = "7E 00 00 00 00 00 00 8F 00 01 00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F \
             10 11 12 13 14 15 16 17 18 19 1A 1B 1C 1D 1E 1F 20 21 22 23 24 25 26 27 28 29 2A \
             2B 2C 2D 2E 2F 30 31 32 33 34 35 36 37 38 39 3A 3B 3C 3D 3E 3F DE 43 31 51 7E";
    let data: Vec<u8> = (0u8..64).collect();
    let f = frame(0, 1, FrameFlags::FD, 15, &data);
    assert_eq!(f.payload(), &data[..]);
    check(&[w], &[Event::Frame(f)], ok(1));
    check_encode(&[f], w);
}

#[test]
fn tv08_tx_ack() {
    let w = "7E 00 00 00 00 00 00 11 00 01 00 12 34 69 CD 7E";
    let f = frame(0, 1, FrameFlags::TX_ACK, 1, &[0]);
    check(&[w], &[Event::Frame(f)], ok(1));
    // TX_ACK is always encoded as 0 (contract §3.2): the result is TV-09, not TV-08.
    check_encode(&[f], TV09);
}

#[test]
fn tv09_basic() {
    let f = std1(1, 0);
    check(&[TV09], &[Event::Frame(f)], ok(1));
    check_encode(&[f], TV09);
}

#[test]
fn tv10_split_over_seven_messages() {
    let msgs = [
        "7E",
        "00 00 00 00 00 00",
        "01",
        "00 01",
        "00",
        "42 2D 3E 52",
        "7E",
    ];
    let f = std1(1, 0);
    check(&msgs, &[Event::Frame(f)], ok(1));
    assert_eq!(h(&msgs.concat()), h(TV09));
    check_encode(&[f], TV09);
}

#[test]
fn tv11_four_frames_one_hdlc() {
    let w = "7E 00 00 00 00 00 00 01 00 01 01 00 00 00 00 00 00 01 00 02 02 00 00 00 00 00 00 \
             01 00 03 03 00 00 00 00 00 00 01 00 04 04 D1 2C 1F D9 7E";
    let ev: Vec<Event> = (1..=4).map(|i| Event::Frame(std1(i, i as u8))).collect();
    check(&[w], &ev, ok(1));
    check_encode(&frames(&ev), w);
}

#[test]
fn tv12_four_hdlc_one_message() {
    let w = [H1, H2, H3, H4].join(" ");
    let ev: Vec<Event> = (1..=4).map(|i| Event::Frame(std1(i, i as u8))).collect();
    check(&[&w], &ev, ok(4));
    for (f, hw) in frames(&ev).iter().zip([H1, H2, H3, H4]) {
        check_encode(core::slice::from_ref(f), hw);
    }
}

#[test]
fn tv13_garbage_before() {
    let w = format!("01 02 03 04 05 {TV09}");
    let f = std1(1, 0);
    check(
        &[&w],
        &[Event::Frame(f)],
        DecoderStats {
            garbage_bytes: 5,
            ..ok(1)
        },
    );
    check_encode(&[f], TV09);
}

#[test]
fn tv14_garbage_between() {
    let w = format!("{H1} 01 02 03 04 05 {H2}");
    let ev = [Event::Frame(std1(1, 1)), Event::Frame(std1(2, 2))];
    check(
        &[&w],
        &ev,
        DecoderStats {
            garbage_bytes: 5,
            ..ok(2)
        },
    );
    check_encode(&[std1(1, 1)], H1);
    check_encode(&[std1(2, 2)], H2);
}

#[test]
fn tv15_bad_crc_in_middle() {
    let bad = "7E 00 00 00 00 00 00 01 00 02 02 00 00 00 00 7E";
    let w = format!("{H1} {bad} {H3}");
    let ev = [Event::Frame(std1(1, 1)), Event::Frame(std1(3, 3))];
    check(
        &[&w],
        &ev,
        DecoderStats {
            crc_errors: 1,
            ..ok(2)
        },
    );
    check_encode(&[std1(1, 1)], H1);
    check_encode(&[std1(3, 3)], H3);
}

#[test]
fn tv16_stuffed_data() {
    let w = "7E 00 00 00 00 00 00 08 00 01 7D 5E 7D 5E 7D 5E 7D 5E 7D 5D 7D 5D 7D 5D 7D 5D \
             67 49 97 08 7E";
    let f = frame(
        0,
        1,
        none(),
        8,
        &[0x7E, 0x7E, 0x7E, 0x7E, 0x7D, 0x7D, 0x7D, 0x7D],
    );
    check(&[w], &[Event::Frame(f)], ok(1));
    check_encode(&[f], w);
}

#[test]
fn tv17_stuffed_crc() {
    let w = "7E 00 00 00 00 2A D1 01 00 01 01 27 88 7D 5E 7D 5D 7E";
    // Doc table shows second resolution only; the wire timestamp is 0x2AD1 = 10 961 µs.
    let f = frame(0x2AD1, 1, none(), 1, &[1]);
    check(&[w], &[Event::Frame(f)], ok(1));
    check_encode(&[f], w);
}

#[test]
fn tv18_truncated_frame() {
    let first = "7E 00 00 00 00 00 00 01 00 01 01 00 00 00 00 00 00 02 00 02 02 BE C0 22 71 7E";
    let w = format!("{first} {H3}");
    let ev = [Event::Frame(std1(1, 1)), Event::Frame(std1(3, 3))];
    check(
        &[&w],
        &ev,
        DecoderStats {
            truncated_frames: 1,
            ..ok(2)
        },
    );
    check_encode(&[std1(3, 3)], H3);
}

#[test]
fn tv19_error_then_frame() {
    let msgs = ["7E 00 00 00 00 00 00 20 A6 02 FF B6 7E", TV09];
    let ev = [
        Event::Error {
            timestamp_us: 0,
            kind: ErrorKind::Bit,
        },
        Event::Frame(std1(1, 0)),
    ];
    check(&msgs, &ev, ok(2));
    check_encode(&[std1(1, 0)], TV09);
}

#[test]
fn tv20_error_and_frame_one_hdlc() {
    let w = "7E 00 00 00 00 00 00 20 00 00 00 00 00 00 01 00 01 00 EE D4 28 4E 7E";
    let ev = [
        Event::Error {
            timestamp_us: 0,
            kind: ErrorKind::Bit,
        },
        Event::Frame(std1(1, 0)),
    ];
    check(&[w], &ev, ok(1));
    // Not encodable: `encode_hdlc` takes `CanFrame`s only (clients never send error frames).
}

// ---------------------------------------------------------------------------------------------
// Additional deterministic edge cases (beyond the official vectors).
// ---------------------------------------------------------------------------------------------

/// Builds a valid HDLC frame around an arbitrary raw payload (test-local reference encoder).
fn hdlc_raw(payload: &[u8]) -> Vec<u8> {
    let crc = cansub::proto::crc::crc32(payload).to_be_bytes();
    let mut v = vec![0x7E];
    for &b in payload.iter().chain(crc.iter()) {
        if b == 0x7E || b == 0x7D {
            v.extend([0x7D, b ^ 0x20]);
        } else {
            v.push(b);
        }
    }
    v.push(0x7E);
    v
}

#[test]
fn all_error_codes_unknown_delivered_as_other() {
    let mut payload = Vec::new();
    for code in 0u8..32 {
        payload.extend([0, 0, 0, 0, 0, code, 0x20 | code]);
    }
    let (ev, st) = decode_msgs(&[hdlc_raw(&payload)]);
    assert_eq!(ev.len(), 32);
    let kinds = [
        ErrorKind::Bit,
        ErrorKind::Ack,
        ErrorKind::Form,
        ErrorKind::Stuff,
        ErrorKind::Crc,
    ];
    for (code, e) in ev.iter().enumerate() {
        let kind = kinds
            .get(code)
            .copied()
            .unwrap_or(ErrorKind::Other(code as u8));
        assert_eq!(
            *e,
            Event::Error {
                timestamp_us: code as u64,
                kind
            }
        );
    }
    assert_eq!(
        st,
        DecoderStats {
            unknown_errors: 27,
            ..ok(1)
        }
    );
}

#[test]
fn classical_dlc_above_8_decodes_8_bytes_but_is_not_encodable() {
    let payload = [0, 0, 0, 0, 0, 0, 0x0F, 0x01, 0x23, 1, 2, 3, 4, 5, 6, 7, 8];
    let (ev, st) = decode_msgs(&[hdlc_raw(&payload)]);
    let f = frame(0, 0x123, none(), 15, &[1, 2, 3, 4, 5, 6, 7, 8]);
    assert_eq!(ev, [Event::Frame(f)]);
    assert_eq!(st, ok(1));
    assert_eq!(
        encode_hdlc(&[f], &mut [0u8; 64]),
        Err(EncodeError::InvalidFrame)
    );
}

#[test]
fn invalid_frames_rejected() {
    let mut out = [0u8; 256];
    let bad = [
        frame(0, 0x800, none(), 0, &[]),
        frame(0, 0x2000_0000, FrameFlags::EXTENDED, 0, &[]),
        frame(0, 1, FrameFlags::FD.union(FrameFlags::RTR), 0, &[]),
        frame(0, 1, FrameFlags::BRS, 0, &[]),
        frame(0, 1, FrameFlags::ESI, 0, &[]),
        frame(0, 1, FrameFlags::FD, 16, &[]),
        frame(1 << 48, 1, none(), 0, &[]),
    ];
    for f in bad {
        assert_eq!(
            encode_hdlc(&[f], &mut out),
            Err(EncodeError::InvalidFrame),
            "{f:?}"
        );
        // A valid prefix is encoded, encoding stops right before the invalid frame.
        assert_eq!(encode_hdlc(&[std1(1, 0), f], &mut out).map(|r| r.1), Ok(1));
    }
    assert_eq!(encode_hdlc(&[], &mut out), Ok((0, 0)));
    assert_eq!(
        encode_hdlc(&[std1(1, 0)], &mut []),
        Err(EncodeError::BufferTooSmall)
    );
}

#[test]
fn big_batch_splits_into_hdlc_frames_at_most_1400_bytes() {
    let f = frame(0, 0x7E, FrameFlags::FD, 15, &[0x7E; 64]); // worst-case stuffing
    let batch = vec![f; 100];
    let mut out = vec![0u8; 8192];
    let mut rest = &batch[..];
    let mut wire = Vec::new();
    let mut hdlcs = 0;
    while !rest.is_empty() {
        let (n, c) = encode_hdlc(rest, &mut out).expect("fits");
        assert!(n <= MAX_WIRE_HDLC && c > 0);
        wire.extend_from_slice(&out[..n]);
        rest = &rest[c..];
        hdlcs += 1;
    }
    assert!(hdlcs > 1);
    let (ev, st) = decode_msgs(&[wire]);
    assert_eq!(frames(&ev), batch);
    assert_eq!(st, ok(hdlcs));
}

#[test]
fn overflow_resyncs() {
    let mut w = vec![0x7E];
    w.extend(std::iter::repeat_n(0x11, MAX_RX_HDLC + 10));
    w.push(0x7E); // closing flag of the oversize frame
    w.extend(h(TV09));
    let (ev, st) = decode_msgs(&[w]);
    assert_eq!(ev, [Event::Frame(std1(1, 0))]);
    assert_eq!(
        st,
        DecoderStats {
            overflows: 1,
            garbage_bytes: 9,
            ..ok(1)
        }
    );
}

#[test]
fn dangling_escape_and_short_bodies_are_crc_errors() {
    let w = format!("7E 01 7D 7E 7E 01 02 03 7E {TV09}");
    let (ev, st) = decode_msgs(&[h(&w)]);
    assert_eq!(ev, [Event::Frame(std1(1, 0))]);
    assert_eq!(
        st,
        DecoderStats {
            crc_errors: 2,
            ..ok(1)
        }
    );
}

#[test]
fn empty_payload_and_double_flags() {
    // `7E 7E 7E` + empty payload HDLC (CRC of nothing = 0) + TV-09.
    let w = format!("7E 7E 7E 00 00 00 00 7E {TV09}");
    let (ev, st) = decode_msgs(&[h(&w)]);
    assert_eq!(ev, [Event::Frame(std1(1, 0))]);
    assert_eq!(st, ok(2));
}

#[test]
fn reset_clears_state_and_stats() {
    let mut d = Decoder::new();
    let w = h(TV09);
    d.push(&w[..8], &mut |_| panic!("partial"));
    d.push(&[1, 2, 3], &mut |_| {});
    d.reset();
    assert_eq!(d.stats(), DecoderStats::default());
    let mut n = 0;
    d.push(&w, &mut |_| n += 1);
    assert_eq!((n, d.stats()), (1, ok(1)));
    assert_eq!(DEVICE_EPOCH_UNIX_US, 1_735_689_600_000_000);
}
