//! Lossless-as-possible conversion between `nexus_core::RawCanFrame` (80 B, Copy, `[u8;64]`)
//! and `automotive::can::Frame` (enum content + `ArrayVec<u8,64>`, no timestamp field).
//!
//! What is lost going RawCanFrame -> Frame: `timestamp_us`, `FLAG_HW_TIMESTAMP`, `FLAG_TX`
//! (mapped to `loopback` only by the caller), `FLAG_ERROR` payload (error frames are not
//! forwarded to ISO-TP at all).

use automotive::can::{Frame, FrameContent, Identifier};
use nexus_core::{BusId, CanIdKey, RawCanFrame, FLAG_ESI};

/// Converts a HAL frame to an `automotive` frame. Returns `None` for error frames.
pub fn raw_to_frame(raw: &RawCanFrame, bus: u8, loopback: bool) -> Option<Frame> {
    if raw.is_error() {
        return None;
    }
    let id = if raw.is_extended() {
        Identifier::extended(raw.arb_id).ok()?
    } else {
        Identifier::standard(raw.arb_id).ok()?
    };
    if raw.is_rtr() {
        let mut f = Frame::remote(bus, id, raw.dlc.min(15)).ok()?;
        f.loopback = loopback;
        return Some(f);
    }
    let len = usize::from(raw.dlc).min(64);
    Frame::builder(id)
        .bus(bus)
        .loopback(loopback)
        .fd(raw.is_fd())
        .brs(raw.is_fd() && raw.is_brs())
        .esi(raw.is_fd() && raw.is_esi())
        .data(&raw.data[..len])
        .build()
        .ok()
}

/// Error for frames that cannot be represented on the HAL TX path.
#[derive(Debug)]
pub struct Unrepresentable(pub &'static str);

/// Converts an `automotive` frame into a HAL TX frame for `bus_id`.
pub fn frame_to_raw(frame: &Frame, bus_id: BusId, ts_us: u64) -> Result<RawCanFrame, Unrepresentable> {
    let key = |id: Identifier| -> Result<CanIdKey, Unrepresentable> {
        match id {
            Identifier::Standard(s) => u16::try_from(s.as_raw())
                .ok()
                .and_then(CanIdKey::new_standard)
                .ok_or(Unrepresentable("std id")),
            Identifier::Extended(e) => {
                CanIdKey::new_extended(e.as_raw()).ok_or(Unrepresentable("ext id"))
            }
        }
    };
    match frame.content() {
        FrameContent::Classic { id, data } => RawCanFrame::new_classical(bus_id, key(*id)?, data, ts_us)
            .map_err(|_| Unrepresentable("classic payload")),
        FrameContent::Fd { id, data, brs, esi } => {
            let mut raw = RawCanFrame::new_fd(bus_id, key(*id)?, data, *brs, ts_us)
                .map_err(|_| Unrepresentable("fd payload"))?;
            if *esi {
                raw.flags |= FLAG_ESI;
            }
            Ok(raw)
        }
        FrameContent::Remote { id, dlc } => RawCanFrame::new_rtr(bus_id, key(*id)?, (*dlc).min(8), ts_us)
            .map_err(|_| Unrepresentable("rtr dlc")),
        FrameContent::Error(_) => Err(Unrepresentable("error frames cannot be transmitted")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt(raw: RawCanFrame) {
        let f = raw_to_frame(&raw, 3, false).expect("convertible");
        let back = frame_to_raw(&f, raw.bus_id, raw.timestamp_us).expect("back");
        assert_eq!(back.arb_id, raw.arb_id);
        assert_eq!(back.dlc, raw.dlc);
        assert_eq!(back.flags, raw.flags);
        assert_eq!(back.payload(), raw.payload());
    }

    #[test]
    fn classical_std_roundtrip() {
        rt(RawCanFrame::new_classical(0, CanIdKey::new_standard(0x7E4).unwrap(), &[2, 0x3E, 0, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC], 1).unwrap());
    }

    #[test]
    fn classical_ext_roundtrip_keeps_29bit_even_if_small() {
        let raw = RawCanFrame::new_classical(0, CanIdKey::new_extended(0x100).unwrap(), &[1, 2, 3], 1).unwrap();
        let f = raw_to_frame(&raw, 0, false).unwrap();
        assert!(matches!(f.id(), Some(Identifier::Extended(_))));
        rt(raw);
    }

    #[test]
    fn fd_64_brs_esi_roundtrip() {
        let payload: Vec<u8> = (0..64u8).collect();
        let mut raw = RawCanFrame::new_fd(1, CanIdKey::new_standard(0x7ED).unwrap(), &payload, true, 5).unwrap();
        raw.flags |= FLAG_ESI;
        let f = raw_to_frame(&raw, 1, false).unwrap();
        match f.content() {
            FrameContent::Fd { data, brs, esi, .. } => {
                assert_eq!(data.len(), 64);
                assert!(*brs && *esi);
            }
            _ => panic!("not FD"),
        }
        rt(raw);
    }

    #[test]
    fn fd_short_without_brs_stays_fd() {
        rt(RawCanFrame::new_fd(0, CanIdKey::new_standard(0x7E5).unwrap(), &[0x02, 0x10, 0x03, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC], false, 1).unwrap());
    }

    #[test]
    fn rtr_roundtrip() {
        rt(RawCanFrame::new_rtr(0, CanIdKey::new_standard(0x123).unwrap(), 8, 1).unwrap());
    }

    #[test]
    fn error_frames_are_not_forwarded() {
        let raw = RawCanFrame::zeroed().with_flags(nexus_core::FLAG_ERROR);
        assert!(raw_to_frame(&raw, 0, false).is_none());
    }
}
