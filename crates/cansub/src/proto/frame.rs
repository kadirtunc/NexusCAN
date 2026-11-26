//! CAN / error frame (de)serialisation inside an HDLC payload (contract §2.3). C1.
//!
//! Wire layout of one serialized frame:
//!
//! ```text
//! byte 0..5 : TIMESTAMP  u48 big-endian, µs since 2025-01-01T00:00:00Z
//! byte 6    : FLAGS
//!   (FLAGS & 0xE0) == 0x20 → error frame (7 bytes total), err = FLAGS & 0x1F
//!   else  bit7 FDF · bit6 RTR (FDF=0) / BRS (FDF=1) · bit5 ESI (FDF=1) · bit4 TX · bit3..0 DLC
//! byte 7..8 : u16 BE, bit15 = IDE; IDE=1 → two more ID bytes (29-bit ID)
//! data      : absent for RTR, else dlc_to_len(FDF, DLC) bytes
//! ```
//!
//! [`FrameFlags`] is an abstract bitset; it is **not** the wire FLAGS byte. The mapping lives
//! exclusively in this module.

use super::{DecoderStats, DEVICE_EPOCH_UNIX_US};

/// Abstract per-frame flag set (independent of the wire FLAGS byte layout).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct FrameFlags(u8);

impl FrameFlags {
    /// 29-bit extended identifier (IDE).
    pub const EXTENDED: Self = Self(1 << 0);
    /// Remote transmission request (classical CAN only; no data bytes on the wire).
    pub const RTR: Self = Self(1 << 1);
    /// CAN-FD frame format (FDF).
    pub const FD: Self = Self(1 << 2);
    /// CAN-FD bit-rate switch (only meaningful with [`FrameFlags::FD`]).
    pub const BRS: Self = Self(1 << 3);
    /// CAN-FD error state indicator (only meaningful with [`FrameFlags::FD`]).
    pub const ESI: Self = Self(1 << 4);
    /// RX only: the device confirms that it transmitted this frame. Always encoded as 0 on TX.
    pub const TX_ACK: Self = Self(1 << 5);

    /// `true` if every flag in `other` is set in `self`.
    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    /// Set union of `self` and `other`.
    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    /// Raw bit representation of this abstract set (not the wire FLAGS byte).
    pub const fn bits(self) -> u8 {
        self.0
    }
}

/// One CAN / CAN-FD frame as carried by the CANsub WebSocket protocol.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CanFrame {
    /// Device-epoch timestamp (µs since 2025-01-01T00:00:00Z); see [`CanFrame::unix_us`].
    pub timestamp_us: u64,
    /// 11-bit (standard) or 29-bit ([`FrameFlags::EXTENDED`]) identifier.
    pub id: u32,
    /// Frame flags.
    pub flags: FrameFlags,
    /// Raw DLC `0..=15`.
    pub dlc: u8,
    /// Payload storage; only the first [`CanFrame::len`] bytes are meaningful.
    pub data: [u8; 64],
}

impl CanFrame {
    /// Number of payload bytes: 0 for classical RTR frames, else `dlc_to_len(FD, dlc)`.
    pub const fn len(&self) -> usize {
        let fd = self.flags.contains(FrameFlags::FD);
        if !fd && self.flags.contains(FrameFlags::RTR) {
            0
        } else {
            dlc_to_len(fd, self.dlc)
        }
    }

    /// `true` if [`CanFrame::len`] is 0.
    pub const fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Valid payload bytes (`&data[..len()]`).
    pub fn payload(&self) -> &[u8] {
        self.data.get(..self.len()).unwrap_or(&self.data)
    }

    /// Timestamp in Unix microseconds (`timestamp_us + DEVICE_EPOCH_UNIX_US`, saturating).
    pub const fn unix_us(&self) -> u64 {
        self.timestamp_us.saturating_add(DEVICE_EPOCH_UNIX_US)
    }
}

/// CAN error frame type reported by the device.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    /// Bit error (wire code 0).
    Bit,
    /// Acknowledgement error (wire code 1).
    Ack,
    /// Form error (wire code 2).
    Form,
    /// Stuff error (wire code 3).
    Stuff,
    /// CRC error (wire code 4).
    Crc,
    /// Any other wire code `5..=31` (raw value). Delivered like the C reference SDK does
    /// (`CANSUB_ERROR_FRAME_TYPE_OTHER_ERROR`) and additionally counted in
    /// [`DecoderStats::unknown_errors`].
    Other(u8),
}

/// Decoder output.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    /// A received CAN / CAN-FD frame (or TX acknowledgement, see [`FrameFlags::TX_ACK`]).
    Frame(CanFrame),
    /// A CAN bus error frame.
    Error {
        /// Device-epoch timestamp (µs since 2025-01-01T00:00:00Z).
        timestamp_us: u64,
        /// Error type.
        kind: ErrorKind,
    },
}

/// DLC → payload length. Classical: `0..=8` identity, `9..=15` → 8. FD: `9..=15` →
/// 12, 16, 20, 24, 32, 48, 64. Values above 15 are treated as 15.
pub const fn dlc_to_len(fd: bool, dlc: u8) -> usize {
    match dlc {
        0..=8 => dlc as usize,
        _ if !fd => 8,
        9 => 12,
        10 => 16,
        11 => 20,
        12 => 24,
        13 => 32,
        14 => 48,
        _ => 64,
    }
}

/// Exact payload length → DLC; `None` if `len` is not representable (classical: > 8;
/// FD: not one of 0..=8, 12, 16, 20, 24, 32, 48, 64).
pub const fn len_to_dlc(fd: bool, len: usize) -> Option<u8> {
    match len {
        0..=8 => Some(len as u8),
        _ if !fd => None,
        12 => Some(9),
        16 => Some(10),
        20 => Some(11),
        24 => Some(12),
        32 => Some(13),
        48 => Some(14),
        64 => Some(15),
        _ => None,
    }
}

/// Largest serialized frame: 6 timestamp + 1 flags + 4 id + 64 data.
pub(crate) const MAX_SERIALIZED: usize = 75;

const WIRE_FDF: u8 = 0x80;
const WIRE_RTR_BRS: u8 = 0x40;
const WIRE_ESI: u8 = 0x20;
const WIRE_TX: u8 = 0x10;
const WIRE_ERROR_MASK: u8 = 0xE0;
const WIRE_ERROR_TAG: u8 = 0x20;
const TS_MAX: u64 = (1 << 48) - 1;

/// TX validity: DLC ≤ 15, classical DLC ≤ 8, no RTR on FD, no BRS/ESI on classical, timestamp
/// fits u48, id within 11/29 bits. `TX_ACK` is ignored (always encoded as 0).
pub(crate) const fn is_valid_tx(f: &CanFrame) -> bool {
    let fd = f.flags.contains(FrameFlags::FD);
    let id_max = if f.flags.contains(FrameFlags::EXTENDED) {
        0x1FFF_FFFF
    } else {
        0x7FF
    };
    if f.dlc > 15 || f.id > id_max || f.timestamp_us > TS_MAX {
        return false;
    }
    if fd {
        !f.flags.contains(FrameFlags::RTR)
    } else {
        f.dlc <= 8 && !f.flags.contains(FrameFlags::BRS) && !f.flags.contains(FrameFlags::ESI)
    }
}

/// Serializes a frame already accepted by [`is_valid_tx`]; returns the byte count.
pub(crate) fn serialize(f: &CanFrame, out: &mut [u8; MAX_SERIALIZED]) -> usize {
    let ts = f.timestamp_us.to_be_bytes();
    let fd = f.flags.contains(FrameFlags::FD);
    let mut flags = f.dlc & 0x0F;
    if fd {
        flags |= WIRE_FDF;
        if f.flags.contains(FrameFlags::BRS) {
            flags |= WIRE_RTR_BRS;
        }
        if f.flags.contains(FrameFlags::ESI) {
            flags |= WIRE_ESI;
        }
    } else if f.flags.contains(FrameFlags::RTR) {
        flags |= WIRE_RTR_BRS;
    }
    // TX_ACK is never encoded (contract §3.2).
    let mut n = 0usize;
    let mut put = |b: u8| {
        if let Some(slot) = out.get_mut(n) {
            *slot = b;
            n += 1;
        }
    };
    for &b in ts.get(2..).unwrap_or(&[]) {
        put(b);
    }
    put(flags);
    if f.flags.contains(FrameFlags::EXTENDED) {
        for b in (0x8000_0000 | (f.id & 0x1FFF_FFFF)).to_be_bytes() {
            put(b);
        }
    } else {
        for b in ((f.id & 0x7FF) as u16).to_be_bytes() {
            put(b);
        }
    }
    for &b in f.payload() {
        put(b);
    }
    n
}

#[inline]
fn be(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0u64, |acc, &b| (acc << 8) | u64::from(b))
}

/// Parses all frames of a CRC-valid HDLC payload, delivering each to `sink` in order.
///
/// A trailing incomplete frame increments `truncated_frames` and is dropped; frames before it
/// are still delivered (TV-18). Unknown error codes are delivered as [`ErrorKind::Other`] and
/// counted in `unknown_errors`.
pub(crate) fn parse_payload(
    payload: &[u8],
    stats: &mut DecoderStats,
    sink: &mut impl FnMut(Event),
) {
    let mut rest = payload;
    while !rest.is_empty() {
        let Some((head, after)) = rest.split_at_checked(7) else {
            stats.truncated_frames += 1;
            return;
        };
        let timestamp_us = be(head.get(..6).unwrap_or(&[]));
        let wire = head.get(6).copied().unwrap_or(0);

        if wire & WIRE_ERROR_MASK == WIRE_ERROR_TAG {
            let code = wire & 0x1F;
            let kind = match code {
                0 => ErrorKind::Bit,
                1 => ErrorKind::Ack,
                2 => ErrorKind::Form,
                3 => ErrorKind::Stuff,
                4 => ErrorKind::Crc,
                other => {
                    stats.unknown_errors += 1;
                    ErrorKind::Other(other)
                }
            };
            sink(Event::Error { timestamp_us, kind });
            rest = after;
            continue;
        }

        let fd = wire & WIRE_FDF != 0;
        let mut flags = FrameFlags::default();
        if fd {
            flags = flags.union(FrameFlags::FD);
            if wire & WIRE_RTR_BRS != 0 {
                flags = flags.union(FrameFlags::BRS);
            }
            if wire & WIRE_ESI != 0 {
                flags = flags.union(FrameFlags::ESI);
            }
        } else if wire & WIRE_RTR_BRS != 0 {
            flags = flags.union(FrameFlags::RTR);
        }
        if wire & WIRE_TX != 0 {
            flags = flags.union(FrameFlags::TX_ACK);
        }
        let dlc = wire & 0x0F;

        let Some((id_hi, mut after)) = after.split_at_checked(2) else {
            stats.truncated_frames += 1;
            return;
        };
        let mut id = be(id_hi) as u32;
        if id & 0x8000 == 0 {
            id &= 0x7FF;
        } else {
            let Some((id_lo, a)) = after.split_at_checked(2) else {
                stats.truncated_frames += 1;
                return;
            };
            after = a;
            flags = flags.union(FrameFlags::EXTENDED);
            id = ((id << 16) | be(id_lo) as u32) & 0x1FFF_FFFF;
        }

        let mut frame = CanFrame {
            timestamp_us,
            id,
            flags,
            dlc,
            data: [0u8; 64],
        };
        let len = frame.len();
        let Some((data, a)) = after.split_at_checked(len) else {
            stats.truncated_frames += 1;
            return;
        };
        if let Some(dst) = frame.data.get_mut(..len) {
            dst.copy_from_slice(data);
        }
        rest = a;
        sink(Event::Frame(frame));
    }
}
