//! L2b: fuzz-derived frames → `encode_hdlc` (never panics on raw/invalid frames) → normalised
//! valid frames are packed into ≤ 1400 B HDLCs → split at fuzz-chosen points → `Decoder` returns
//! exactly the transmitted frames (TX_ACK never encoded), no CRC errors.
#![no_main]

use cansub::proto::{dlc_to_len, encode_hdlc, CanFrame, Decoder, Event, FrameFlags, MAX_WIRE_HDLC};
use libfuzzer_sys::fuzz_target;

const BITS: [FrameFlags; 6] = [
    FrameFlags::EXTENDED,
    FrameFlags::RTR,
    FrameFlags::FD,
    FrameFlags::BRS,
    FrameFlags::ESI,
    FrameFlags::TX_ACK,
];

fn flags_from(b: u8) -> FrameFlags {
    BITS.iter()
        .enumerate()
        .filter(|(i, _)| b & (1 << i) != 0)
        .fold(FrameFlags::default(), |a, (_, &f)| a.union(f))
}

struct Rd<'a>(&'a [u8]);
impl Rd<'_> {
    fn u8(&mut self) -> Option<u8> {
        let (&b, t) = self.0.split_first()?;
        self.0 = t;
        Some(b)
    }
    fn n<const N: usize>(&mut self) -> Option<[u8; N]> {
        if self.0.len() < N {
            return None;
        }
        let (h, t) = self.0.split_at(N);
        self.0 = t;
        h.try_into().ok()
    }
}

/// Raw (possibly invalid) frame straight from fuzz bytes.
fn raw(r: &mut Rd) -> Option<CanFrame> {
    let ts = u64::from_le_bytes(r.n::<8>()?);
    let id = u32::from_le_bytes(r.n::<4>()?);
    let flags = flags_from(r.u8()?);
    let dlc = r.u8()?;
    let mut data = [0u8; 64];
    let seed = r.u8()?;
    for (i, d) in data.iter_mut().enumerate() {
        *d = seed.wrapping_mul(i as u8 + 1) ^ (i as u8).rotate_left(3);
    }
    Some(CanFrame {
        timestamp_us: ts,
        id,
        flags,
        dlc,
        data,
    })
}

/// Same frame forced into the representable domain (`is_valid_tx`).
fn normalise(f: &CanFrame) -> CanFrame {
    let has = |b| f.flags.contains(b);
    let ext = has(FrameFlags::EXTENDED);
    let fd = has(FrameFlags::FD);
    let mut flags = FrameFlags::default();
    for (b, keep) in [
        (FrameFlags::EXTENDED, ext),
        (FrameFlags::FD, fd),
        (FrameFlags::RTR, !fd && has(FrameFlags::RTR)),
        (FrameFlags::BRS, fd && has(FrameFlags::BRS)),
        (FrameFlags::ESI, fd && has(FrameFlags::ESI)),
    ] {
        if keep {
            flags = flags.union(b);
        }
    }
    let mut g = CanFrame {
        timestamp_us: f.timestamp_us & ((1 << 48) - 1),
        id: if ext {
            f.id & 0x1FFF_FFFF
        } else {
            f.id & 0x7FF
        },
        flags,
        dlc: if fd {
            f.dlc & 0x0F
        } else {
            (f.dlc & 0x0F).min(8)
        },
        data: [0u8; 64],
    };
    let n = g.len();
    g.data[..n].copy_from_slice(&f.data[..n]);
    let _ = dlc_to_len(fd, g.dlc);
    g
}

fuzz_target!(|data: &[u8]| {
    let mut r = Rd(data);
    let Some(cap_b) = r.u8() else { return };
    let Some(split_seed) = r.u8() else { return };
    // Output buffer 0..=1600 B: below MAX_WIRE_HDLC exercises BufferTooSmall + packing limits.
    let cap = (cap_b as usize) * 7;
    let mut raws = Vec::new();
    while raws.len() < 128 {
        let Some(f) = raw(&mut r) else { break };
        raws.push(f);
    }
    let mut out = vec![0u8; cap.max(1)];
    // Raw frames: must never panic; Ok only with a well-formed HDLC.
    if let Ok((n, c)) = encode_hdlc(&raws, &mut out) {
        if raws.is_empty() {
            assert_eq!((n, c), (0, 0), "empty input must write nothing");
            return;
        }
        assert!(c >= 1 && n <= out.len() && n <= MAX_WIRE_HDLC);
        assert_eq!((out[0], out[n - 1]), (0x7E, 0x7E));
    }

    let frames: Vec<CanFrame> = raws.iter().map(normalise).collect();
    let mut wire = Vec::new();
    let mut rest = &frames[..];
    let mut buf = vec![0u8; 2048];
    while !rest.is_empty() {
        let (n, c) = match encode_hdlc(rest, &mut buf) {
            Ok(v) => v,
            Err(e) => panic!("valid frame rejected: {e:?} {:?}", rest[0]),
        };
        assert!(c >= 1 && n <= MAX_WIRE_HDLC);
        assert!(!buf[1..n - 1].contains(&0x7E), "flag inside body");
        wire.extend_from_slice(&buf[..n]);
        rest = &rest[c..];
    }

    let mut d = Decoder::new();
    let mut got = Vec::new();
    let mut pos = 0usize;
    let mut s = split_seed as usize | 1;
    while pos < wire.len() {
        s = s.wrapping_mul(1103515245).wrapping_add(12345);
        let n = ((s >> 8) % 97 + 1).min(wire.len() - pos);
        d.push(&wire[pos..pos + n], &mut |e| got.push(e));
        pos += n;
    }
    let st = d.stats();
    assert_eq!(st.crc_errors, 0);
    assert_eq!(st.overflows, 0);
    assert_eq!(st.truncated_frames, 0);
    assert_eq!(st.garbage_bytes, 0);
    let got: Vec<CanFrame> = got
        .into_iter()
        .map(|e| match e {
            Event::Frame(f) => f,
            other => panic!("unexpected event {other:?}"),
        })
        .collect();
    assert_eq!(got.len(), frames.len());
    for (a, b) in got.iter().zip(&frames) {
        assert_eq!(
            (a.timestamp_us, a.id, a.flags, a.dlc),
            (b.timestamp_us, b.id, b.flags, b.dlc)
        );
        assert_eq!(a.payload(), b.payload());
    }
});
