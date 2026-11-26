//! L2 — property tests (contract §4): encode → arbitrary re-chunking → decode is the identity;
//! garbage / bit-flipped input never panics and keeps the counters consistent.

use cansub::proto::{
    encode_hdlc, CanFrame, Decoder, DecoderStats, ErrorKind, Event, FrameFlags, MAX_WIRE_HDLC,
};
use proptest::prelude::*;

fn arb_frame() -> impl Strategy<Value = CanFrame> {
    (
        0u64..(1 << 48),
        any::<bool>(), // extended
        any::<u32>(),
        any::<bool>(), // fd
        any::<bool>(), // rtr (classical) / brs (fd)
        any::<bool>(), // esi (fd)
        any::<bool>(), // tx_ack (must be dropped by the encoder)
        any::<u8>(),
        prop::array::uniform32(any::<u8>()),
        prop::array::uniform32(any::<u8>()),
    )
        .prop_map(|(ts, ext, id, fd, b6, esi, tx, dlc, lo, hi)| {
            let mut flags = FrameFlags::default();
            let id = if ext {
                flags = flags.union(FrameFlags::EXTENDED);
                id & 0x1FFF_FFFF
            } else {
                id & 0x7FF
            };
            let dlc = if fd {
                flags = flags.union(FrameFlags::FD);
                if b6 {
                    flags = flags.union(FrameFlags::BRS);
                }
                if esi {
                    flags = flags.union(FrameFlags::ESI);
                }
                dlc % 16
            } else {
                if b6 {
                    flags = flags.union(FrameFlags::RTR);
                }
                dlc % 9
            };
            if tx {
                flags = flags.union(FrameFlags::TX_ACK);
            }
            let mut f = CanFrame {
                timestamp_us: ts,
                id,
                flags,
                dlc,
                data: [0u8; 64],
            };
            let len = f.len();
            let src: Vec<u8> = lo.iter().chain(hi.iter()).copied().collect();
            f.data[..len].copy_from_slice(&src[..len]);
            f
        })
}

/// Expected decode result of a transmitted frame: identical except TX_ACK (never encoded).
fn tx_view(f: &CanFrame) -> CanFrame {
    let mut g = *f;
    let bits = [
        FrameFlags::EXTENDED,
        FrameFlags::RTR,
        FrameFlags::FD,
        FrameFlags::BRS,
        FrameFlags::ESI,
    ];
    g.flags = bits
        .into_iter()
        .filter(|&b| f.flags.contains(b))
        .fold(FrameFlags::default(), FrameFlags::union);
    g
}

/// Encodes `frames` into consecutive HDLC frames of at most `cap` bytes each.
fn encode_all(frames: &[CanFrame], cap: usize) -> (Vec<u8>, u64) {
    let mut out = vec![0u8; cap];
    let mut wire = Vec::new();
    let mut rest = frames;
    let mut hdlcs = 0;
    while !rest.is_empty() {
        let (n, c) = encode_hdlc(rest, &mut out).expect("valid frames, cap >= 160");
        assert!(c >= 1 && n <= cap && n <= MAX_WIRE_HDLC);
        assert_eq!((out[0], out[n - 1]), (0x7E, 0x7E));
        assert!(!out[1..n - 1].contains(&0x7E), "flag inside body");
        wire.extend_from_slice(&out[..n]);
        rest = &rest[c..];
        hdlcs += 1;
    }
    (wire, hdlcs)
}

/// Feeds `bytes` split at the given chunk sizes (cycled), collecting events.
fn decode_chunked(bytes: &[u8], chunks: &[usize]) -> (Vec<Event>, DecoderStats) {
    let mut d = Decoder::new();
    let mut ev = Vec::new();
    let mut rest = bytes;
    let mut i = 0;
    while !rest.is_empty() {
        let n = chunks
            .get(i % chunks.len().max(1))
            .copied()
            .unwrap_or(1)
            .clamp(1, rest.len());
        d.push(&rest[..n], &mut |e| ev.push(e));
        rest = &rest[n..];
        i += 1;
    }
    (ev, d.stats())
}

fn check_invariants(input: &[u8], ev: &[Event], st: DecoderStats) {
    let flags = input.iter().filter(|&&b| b == 0x7E).count() as u64;
    assert!(st.hdlc_ok + st.crc_errors + st.overflows <= flags, "{st:?}");
    assert!(st.garbage_bytes <= input.len() as u64);
    assert!(st.truncated_frames <= st.hdlc_ok);
    let other = ev
        .iter()
        .filter(|e| {
            matches!(
                e,
                Event::Error {
                    kind: ErrorKind::Other(_),
                    ..
                }
            )
        })
        .count() as u64;
    assert_eq!(st.unknown_errors, other);
    for e in ev {
        match e {
            Event::Frame(f) => {
                assert!(f.dlc <= 15 && f.len() <= 64);
                assert!(f.timestamp_us < 1 << 48);
                assert!(f.data[f.len()..].iter().all(|&b| b == 0), "tail zeroed");
            }
            Event::Error { timestamp_us, kind } => {
                assert!(*timestamp_us < 1 << 48);
                if let ErrorKind::Other(c) = kind {
                    assert!((5..32).contains(c));
                }
            }
        }
    }
}

/// Byte strategy biased towards the HDLC control bytes.
fn noisy_byte() -> impl Strategy<Value = u8> {
    prop_oneof![6 => any::<u8>(), 2 => Just(0x7E), 1 => Just(0x7D), 1 => Just(0x20)]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10_000))]

    #[test]
    fn roundtrip_any_chunking(
        frames in prop::collection::vec(arb_frame(), 0..48),
        cap in 160usize..=2000,
        chunks in prop::collection::vec(1usize..64, 1..16),
    ) {
        let (wire, hdlcs) = encode_all(&frames, cap);
        let (ev, st) = decode_chunked(&wire, &chunks);
        let expected: Vec<Event> = frames.iter().map(|f| Event::Frame(tx_view(f))).collect();
        prop_assert_eq!(ev, expected);
        prop_assert_eq!(st, DecoderStats { hdlc_ok: hdlcs, ..DecoderStats::default() });
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(4_000))]

    #[test]
    fn garbage_never_panics_and_is_chunk_invariant(
        input in prop::collection::vec(noisy_byte(), 0..3000),
        chunks in prop::collection::vec(1usize..200, 1..8),
    ) {
        let (ev_whole, st_whole) = decode_chunked(&input, &[input.len().max(1)]);
        let (ev, st) = decode_chunked(&input, &chunks);
        prop_assert_eq!(&ev, &ev_whole);
        prop_assert_eq!(st, st_whole);
        check_invariants(&input, &ev, st);
    }

    #[test]
    fn bit_flips_never_panic(
        frames in prop::collection::vec(arb_frame(), 1..24),
        cap in 160usize..=1400,
        flips in prop::collection::vec((any::<prop::sample::Index>(), 0u8..8), 0..8),
        chunks in prop::collection::vec(1usize..64, 1..8),
    ) {
        let (mut wire, hdlcs) = encode_all(&frames, cap);
        for (idx, bit) in &flips {
            let i = idx.index(wire.len());
            wire[i] ^= 1 << bit;
        }
        let (ev, st) = decode_chunked(&wire, &chunks);
        check_invariants(&wire, &ev, st);
        if flips.is_empty() {
            prop_assert_eq!(st.hdlc_ok, hdlcs);
        }
    }

    #[test]
    fn leading_garbage_is_skipped(
        garbage in prop::collection::vec(any::<u8>().prop_filter("no flag", |b| *b != 0x7E), 0..300),
        frames in prop::collection::vec(arb_frame(), 1..16),
        chunks in prop::collection::vec(1usize..64, 1..8),
    ) {
        let (wire, hdlcs) = encode_all(&frames, MAX_WIRE_HDLC);
        let mut input = garbage.clone();
        input.extend_from_slice(&wire);
        let (ev, st) = decode_chunked(&input, &chunks);
        let expected: Vec<Event> = frames.iter().map(|f| Event::Frame(tx_view(f))).collect();
        prop_assert_eq!(ev, expected);
        prop_assert_eq!(
            st,
            DecoderStats { hdlc_ok: hdlcs, garbage_bytes: garbage.len() as u64, ..DecoderStats::default() }
        );
    }
}
