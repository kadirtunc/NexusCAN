//! Zero-allocation CAN 2.0A/2.0B and ISO 11898-1 CAN-FD frame primitives.

use core::fmt;
use core::mem::{align_of, offset_of, size_of};
use core::ops::{BitAnd, BitAndAssign, BitOr, BitOrAssign, Not};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Logical bus / channel identifier (`0..=255`) supporting simultaneous multi-adapter capture.
pub type BusId = u8;

/// Maximum payload length in bytes for Classical CAN (CAN 2.0A / 2.0B).
pub const MAX_CLASSICAL_CAN_DLC: usize = 8;

/// Maximum payload length in bytes for ISO 11898-1 CAN-FD.
pub const MAX_CAN_FD_DLC: usize = 64;

/// Maximum payload bit span (`64 * 8`) for CAN-FD signal codecs.
pub const MAX_CAN_FD_BITS: u16 = 512;

/// 11-bit Standard CAN arbitration ID bitmask (`0x000..=0x7FF`).
pub const STD_CAN_ID_MASK: u32 = 0x0000_07FF;

/// 29-bit Extended CAN arbitration ID bitmask (`0x0000_0000..=0x1FFF_FFFF`).
pub const EXT_CAN_ID_MASK: u32 = 0x1FFF_FFFF;

/// Vector `.dbc` bit-31 marker flag indicating a 29-bit Extended CAN ID.
pub const DBC_EXT_ID_FLAG: u32 = 0x8000_0000;

/// Vector `.dbc` pseudo-message ID (`3221225472` / `0xC000_0000`) holding orphan signals
/// (`VECTOR__INDEPENDENT_SIG_MSG`), which must never be indexed as a real CAN frame ID.
pub const VECTOR_INDEPENDENT_SIG_MSG_ID: u32 = 0xC000_0000;

/// Bitmask constants stored in [`RawCanFrame::flags`] and [`FrameFlags`].
pub mod flags {
    /// 29-bit Extended arbitration identifier (`IDE = 1`).
    pub const FLAG_EXTENDED: u8 = 1 << 0;
    /// Classical CAN Remote Transmission Request frame (`RTR = 1`).
    pub const FLAG_RTR: u8 = 1 << 1;
    /// ISO 11898-1 CAN-FD frame (`FDF = 1`).
    pub const FLAG_FD: u8 = 1 << 2;
    /// CAN-FD Bit Rate Switch (`BRS = 1`, accelerated data phase).
    pub const FLAG_BRS: u8 = 1 << 3;
    /// CAN-FD Error State Indicator (`ESI = 1`, transmitter is error-passive).
    pub const FLAG_ESI: u8 = 1 << 4;
    /// Controller/transceiver bus error frame (`CAN_ERR_FLAG`).
    pub const FLAG_ERROR: u8 = 1 << 5;
    /// Self-transmitted or loopback echo frame marker.
    pub const FLAG_TX: u8 = 1 << 6;
    /// Indicates [`super::RawCanFrame::timestamp_us`] originated from adapter hardware clock.
    pub const FLAG_HW_TIMESTAMP: u8 = 1 << 7;

    /// Alias for [`FLAG_EXTENDED`].
    pub const EXTENDED: u8 = FLAG_EXTENDED;
    /// Alias for [`FLAG_RTR`].
    pub const RTR: u8 = FLAG_RTR;
    /// Alias for [`FLAG_FD`].
    pub const FD: u8 = FLAG_FD;
    /// Alias for [`FLAG_BRS`].
    pub const BRS: u8 = FLAG_BRS;
    /// Alias for [`FLAG_ESI`].
    pub const ESI: u8 = FLAG_ESI;
    /// Alias for [`FLAG_ERROR`].
    pub const ERROR: u8 = FLAG_ERROR;
    /// Alias for [`FLAG_TX`].
    pub const TX: u8 = FLAG_TX;
    /// Alias for [`FLAG_HW_TIMESTAMP`].
    pub const HW_TIMESTAMP: u8 = FLAG_HW_TIMESTAMP;
}

pub use flags::{
    FLAG_BRS, FLAG_ERROR, FLAG_ESI, FLAG_EXTENDED, FLAG_FD, FLAG_HW_TIMESTAMP, FLAG_RTR, FLAG_TX,
};

/// Type-safe wrapper over the 8-bit [`RawCanFrame::flags`] bitfield.
#[repr(transparent)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FrameFlags(pub u8);

impl FrameFlags {
    /// Empty flag set (`0x00`).
    pub const NONE: Self = Self(0);
    /// 29-bit Extended arbitration identifier (`0x01`).
    pub const EXTENDED: Self = Self(FLAG_EXTENDED);
    /// Classical CAN Remote Transmission Request (`0x02`).
    pub const RTR: Self = Self(FLAG_RTR);
    /// ISO 11898-1 CAN-FD frame (`0x04`).
    pub const FD: Self = Self(FLAG_FD);
    /// CAN-FD Bit Rate Switch (`0x08`).
    pub const BRS: Self = Self(FLAG_BRS);
    /// CAN-FD Error State Indicator (`0x10`).
    pub const ESI: Self = Self(FLAG_ESI);
    /// Bus error frame (`0x20`).
    pub const ERROR: Self = Self(FLAG_ERROR);
    /// Self-transmitted / loopback echo marker (`0x40`).
    pub const TX: Self = Self(FLAG_TX);
    /// Hardware-sourced timestamp marker (`0x80`).
    pub const HW_TIMESTAMP: Self = Self(FLAG_HW_TIMESTAMP);

    /// Returns an empty [`FrameFlags`] set (`0x00`).
    #[inline]
    pub const fn empty() -> Self {
        Self(0)
    }

    /// Wraps raw bit flags without stripping any bits.
    #[inline]
    pub const fn from_bits_retain(bits: u8) -> Self {
        Self(bits)
    }

    /// Returns the underlying `u8` bitmask.
    #[inline]
    pub const fn bits(self) -> u8 {
        self.0
    }

    /// Returns `true` if all bits in `other` are set in `self`.
    #[inline]
    pub const fn contains(self, other: Self) -> bool {
        (self.0 & other.0) == other.0
    }

    /// Sets all bits from `other` in `self`.
    #[inline]
    pub fn insert(&mut self, other: Self) {
        self.0 |= other.0;
    }

    /// Clears all bits from `other` in `self`.
    #[inline]
    pub fn remove(&mut self, other: Self) {
        self.0 &= !other.0;
    }

    /// Const-compatible union of two flag sets.
    #[inline]
    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }
}

impl From<u8> for FrameFlags {
    #[inline]
    fn from(value: u8) -> Self {
        Self(value)
    }
}

impl From<FrameFlags> for u8 {
    #[inline]
    fn from(flags: FrameFlags) -> Self {
        flags.0
    }
}

impl BitOr for FrameFlags {
    type Output = Self;

    #[inline]
    fn bitor(self, rhs: Self) -> Self::Output {
        Self(self.0 | rhs.0)
    }
}

impl BitOrAssign for FrameFlags {
    #[inline]
    fn bitor_assign(&mut self, rhs: Self) {
        self.0 |= rhs.0;
    }
}

impl BitAnd for FrameFlags {
    type Output = Self;

    #[inline]
    fn bitand(self, rhs: Self) -> Self::Output {
        Self(self.0 & rhs.0)
    }
}

impl BitAndAssign for FrameFlags {
    #[inline]
    fn bitand_assign(&mut self, rhs: Self) {
        self.0 &= rhs.0;
    }
}

impl Not for FrameFlags {
    type Output = Self;

    #[inline]
    fn not(self) -> Self::Output {
        Self(!self.0)
    }
}

/// Format-explicit CAN arbitration identifier preventing collisions between
/// 11-bit Standard (`0x100`) and 29-bit Extended (`0x0000_0100`) IDs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id")]
pub enum CanIdKey {
    /// 11-bit Classical/FD Standard Identifier (`0x000..=0x7FF`).
    Standard(u16),
    /// 29-bit Classical/FD Extended Identifier (`0x0000_0000..=0x1FFF_FFFF`).
    Extended(u32),
}

/// Ergonomic alias for [`CanIdKey`].
pub type CanId = CanIdKey;

impl CanIdKey {
    /// Constructs a validated 11-bit Standard CAN ID (`id <= 0x7FF`).
    #[inline]
    pub const fn new_standard(id: u16) -> Option<Self> {
        if (id as u32) <= STD_CAN_ID_MASK {
            Some(Self::Standard(id))
        } else {
            None
        }
    }

    /// Constructs a validated 29-bit Extended CAN ID (`id <= 0x1FFF_FFFF`).
    #[inline]
    pub const fn new_extended(id: u32) -> Option<Self> {
        if id <= EXT_CAN_ID_MASK {
            Some(Self::Extended(id))
        } else {
            None
        }
    }

    /// Masks `arb_id` to 29 bits when `is_extended` is `true`, or 11 bits when `false`.
    #[inline]
    pub const fn new_masked(arb_id: u32, is_extended: bool) -> Self {
        if is_extended {
            Self::Extended(arb_id & EXT_CAN_ID_MASK)
        } else {
            Self::Standard((arb_id & STD_CAN_ID_MASK) as u16)
        }
    }

    /// Parses a raw message ID from a Vector `.dbc` `BO_` header.
    ///
    /// Returns `None` for `VECTOR__INDEPENDENT_SIG_MSG` (`0xC000_0000` / `3221225472`)
    /// or out-of-range unflagged IDs (`> 0x7FF` without [`DBC_EXT_ID_FLAG`]).
    #[inline]
    pub const fn from_dbc_raw_id(raw_id: u32) -> Option<Self> {
        if raw_id == VECTOR_INDEPENDENT_SIG_MSG_ID {
            None
        } else if (raw_id & DBC_EXT_ID_FLAG) != 0 {
            Some(Self::Extended(raw_id & EXT_CAN_ID_MASK))
        } else if raw_id <= STD_CAN_ID_MASK {
            Some(Self::Standard(raw_id as u16))
        } else {
            None
        }
    }

    /// Returns the clean numeric arbitration ID (`0..=0x7FF` or `0..=0x1FFF_FFFF`).
    #[inline]
    pub const fn raw_id(self) -> u32 {
        match self {
            Self::Standard(id) => (id as u32) & STD_CAN_ID_MASK,
            Self::Extended(id) => id & EXT_CAN_ID_MASK,
        }
    }

    /// Returns `true` if this is a 29-bit Extended CAN ID.
    #[inline]
    pub const fn is_extended(self) -> bool {
        matches!(self, Self::Extended(_))
    }

    /// Encodes this ID into Vector `.dbc` raw `BO_` format (setting bit 31 for Extended IDs).
    #[inline]
    pub const fn to_dbc_raw_id(self) -> u32 {
        match self {
            Self::Standard(id) => (id as u32) & STD_CAN_ID_MASK,
            Self::Extended(id) => DBC_EXT_ID_FLAG | (id & EXT_CAN_ID_MASK),
        }
    }

    /// Formats a canonical, collision-free UI/schema dictionary key
    /// (`"STD:0x100"` or `"EXT:0x18FEEE00"`).
    pub fn schema_key(self) -> String {
        match self {
            Self::Standard(id) => format!("STD:0x{:03X}", id & (STD_CAN_ID_MASK as u16)),
            Self::Extended(id) => format!("EXT:0x{:08X}", id & EXT_CAN_ID_MASK),
        }
    }

    /// Extracts the 18-bit SAE J1939 Parameter Group Number (PGN) from a 29-bit Extended ID.
    ///
    /// - For PDU1 (`PF < 240`), PDU Specific (`PS`, destination address) is masked to `0`.
    /// - For PDU2 (`PF >= 240`), `PS` (group extension) is preserved as the low byte of the PGN.
    /// - Returns `None` for 11-bit [`CanIdKey::Standard`] identifiers.
    #[inline]
    pub const fn extract_j1939_pgn(self) -> Option<u32> {
        match self {
            Self::Standard(_) => None,
            Self::Extended(raw) => {
                let id = raw & EXT_CAN_ID_MASK;
                let dp = (id >> 24) & 1;
                let edp = (id >> 25) & 1;
                let pf = (id >> 16) & 0xFF;
                let ps = (id >> 8) & 0xFF;
                if pf < 240 {
                    Some((edp << 17) | (dp << 16) | (pf << 8))
                } else {
                    Some((edp << 17) | (dp << 16) | (pf << 8) | ps)
                }
            }
        }
    }
}

impl fmt::Display for CanIdKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            Self::Standard(id) => write!(f, "STD:0x{:03X}", id & (STD_CAN_ID_MASK as u16)),
            Self::Extended(id) => write!(f, "EXT:0x{:08X}", id & EXT_CAN_ID_MASK),
        }
    }
}

/// Validation errors returned when constructing CAN / CAN-FD frames.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Error)]
pub enum FrameError {
    /// Classical CAN frame payload exceeded 8 bytes.
    #[error("classical CAN payload length {actual} exceeds maximum {max} bytes")]
    ClassicalPayloadTooLarge {
        /// Provided payload slice length.
        actual: usize,
        /// Maximum allowed bytes (`8`).
        max: usize,
    },
    /// CAN-FD frame payload exceeded 64 bytes.
    #[error("CAN-FD payload length {actual} exceeds maximum {max} bytes")]
    CanFdPayloadTooLarge {
        /// Provided payload slice length.
        actual: usize,
        /// Maximum allowed bytes (`64`).
        max: usize,
    },
    /// Standard 11-bit CAN ID exceeded `0x7FF`.
    #[error("standard 11-bit CAN ID 0x{0:X} exceeds 0x7FF")]
    InvalidStandardId(u32),
    /// Extended 29-bit CAN ID exceeded `0x1FFF_FFFF`.
    #[error("extended 29-bit CAN ID 0x{0:X} exceeds 0x1FFF_FFFF")]
    InvalidExtendedId(u32),
}

/// Fixed 80-byte, cache-friendly, zero-allocation CAN / CAN-FD frame representation.
///
/// ### Memory Layout (`#[repr(C, align(8))]`)
/// - `0..8`:   `timestamp_us: u64` (8 bytes)
/// - `8..12`:  `arb_id: u32` (4 bytes)
/// - `12..13`: `bus_id: u8` (1 byte)
/// - `13..14`: `dlc: u8` (1 byte, payload byte length `0..=8` or `0..=64`)
/// - `14..15`: `flags: u8` (1 byte, [`flags`] bitmask)
/// - `15..16`: `_reserved: u8` (1 byte explicit padding -> 16-byte header)
/// - `16..80`: `data: [u8; 64]` (64-byte inline payload buffer)
#[repr(C, align(8))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawCanFrame {
    /// Monotonic or hardware timestamp in microseconds.
    pub timestamp_us: u64,
    /// Clean 11-bit (`0..=0x7FF`) or 29-bit (`0..=0x1FFF_FFFF`) arbitration ID.
    pub arb_id: u32,
    /// Logical bus / channel index (`0..=255`).
    pub bus_id: BusId,
    /// Payload byte length (`0..=8` for Classical CAN, quantized `0..=64` for CAN-FD).
    pub dlc: u8,
    /// Frame attribute flags (see [`flags`] and [`FrameFlags`]).
    pub flags: u8,
    /// Explicit alignment padding byte ensuring deterministic 16-byte header across ABIs.
    pub _reserved: u8,
    /// Fixed stack-allocated payload buffer (zero heap allocations on hot path).
    #[serde(with = "serde_bytes_64")]
    pub data: [u8; 64],
}

// Compile-time ABI, size, alignment, offset, and concurrency trait assertions.
const _: () = {
    assert!(size_of::<RawCanFrame>() == 80);
    assert!(align_of::<RawCanFrame>() == 8);
    assert!(offset_of!(RawCanFrame, timestamp_us) == 0);
    assert!(offset_of!(RawCanFrame, arb_id) == 8);
    assert!(offset_of!(RawCanFrame, bus_id) == 12);
    assert!(offset_of!(RawCanFrame, dlc) == 13);
    assert!(offset_of!(RawCanFrame, flags) == 14);
    assert!(offset_of!(RawCanFrame, _reserved) == 15);
    assert!(offset_of!(RawCanFrame, data) == 16);
};

const fn _assert_raw_can_frame_traits<T: Copy + Clone + Send + Sync + Sized>() {}
const _: () = _assert_raw_can_frame_traits::<RawCanFrame>();

impl Default for RawCanFrame {
    #[inline]
    fn default() -> Self {
        Self::zeroed()
    }
}

impl RawCanFrame {
    /// Returns an all-zero 80-byte [`RawCanFrame`].
    #[inline]
    pub const fn zeroed() -> Self {
        Self {
            timestamp_us: 0,
            arb_id: 0,
            bus_id: 0,
            dlc: 0,
            flags: 0,
            _reserved: 0,
            data: [0u8; MAX_CAN_FD_DLC],
        }
    }

    /// Validates that `id` fits within 11-bit Standard or 29-bit Extended CAN bounds.
    #[inline]
    const fn validate_id(id: CanIdKey) -> Result<(), FrameError> {
        match id {
            CanIdKey::Standard(raw) if (raw as u32) > STD_CAN_ID_MASK => {
                Err(FrameError::InvalidStandardId(raw as u32))
            }
            CanIdKey::Extended(raw) if raw > EXT_CAN_ID_MASK => {
                Err(FrameError::InvalidExtendedId(raw))
            }
            _ => Ok(()),
        }
    }

    /// Constructs a Classical CAN (2.0A / 2.0B) data frame (`payload.len() <= 8`).
    #[inline]
    pub fn new_classical(
        bus_id: BusId,
        id: CanIdKey,
        payload: &[u8],
        timestamp_us: u64,
    ) -> Result<Self, FrameError> {
        Self::validate_id(id)?;
        if payload.len() > MAX_CLASSICAL_CAN_DLC {
            return Err(FrameError::ClassicalPayloadTooLarge {
                actual: payload.len(),
                max: MAX_CLASSICAL_CAN_DLC,
            });
        }

        let mut data = [0u8; MAX_CAN_FD_DLC];
        data[..payload.len()].copy_from_slice(payload);

        let flags = if id.is_extended() { FLAG_EXTENDED } else { 0 };

        Ok(Self {
            timestamp_us,
            arb_id: id.raw_id(),
            bus_id,
            dlc: payload.len() as u8,
            flags,
            _reserved: 0,
            data,
        })
    }

    /// Constructs an ISO 11898-1 CAN-FD data frame (`payload.len() <= 64`), zero-padding
    /// `dlc` up to the next valid CAN-FD payload length via [`quantize_canfd_payload_len`].
    #[inline]
    pub fn new_fd(
        bus_id: BusId,
        id: CanIdKey,
        payload: &[u8],
        brs: bool,
        timestamp_us: u64,
    ) -> Result<Self, FrameError> {
        Self::validate_id(id)?;
        if payload.len() > MAX_CAN_FD_DLC {
            return Err(FrameError::CanFdPayloadTooLarge {
                actual: payload.len(),
                max: MAX_CAN_FD_DLC,
            });
        }

        let mut data = [0u8; MAX_CAN_FD_DLC];
        data[..payload.len()].copy_from_slice(payload);

        let mut flags = FLAG_FD;
        if id.is_extended() {
            flags |= FLAG_EXTENDED;
        }
        if brs {
            flags |= FLAG_BRS;
        }

        Ok(Self {
            timestamp_us,
            arb_id: id.raw_id(),
            bus_id,
            dlc: quantize_canfd_payload_len(payload.len()),
            flags,
            _reserved: 0,
            data,
        })
    }

    /// Constructs a Classical CAN Remote Transmission Request (RTR) frame (`dlc <= 8`).
    #[inline]
    pub fn new_rtr(
        bus_id: BusId,
        id: CanIdKey,
        dlc: u8,
        timestamp_us: u64,
    ) -> Result<Self, FrameError> {
        Self::validate_id(id)?;
        if usize::from(dlc) > MAX_CLASSICAL_CAN_DLC {
            return Err(FrameError::ClassicalPayloadTooLarge {
                actual: usize::from(dlc),
                max: MAX_CLASSICAL_CAN_DLC,
            });
        }

        let mut flags = FLAG_RTR;
        if id.is_extended() {
            flags |= FLAG_EXTENDED;
        }

        Ok(Self {
            timestamp_us,
            arb_id: id.raw_id(),
            bus_id,
            dlc,
            flags,
            _reserved: 0,
            data: [0u8; MAX_CAN_FD_DLC],
        })
    }

    /// Returns a copy of this frame with additional flag bits OR-ed in.
    #[inline]
    pub const fn with_flags(mut self, extra_flags: u8) -> Self {
        self.flags |= extra_flags;
        self
    }

    /// Returns [`FrameFlags`] wrapping `self.flags`.
    #[inline]
    pub const fn frame_flags(&self) -> FrameFlags {
        FrameFlags(self.flags)
    }

    /// Returns the collision-free [`CanIdKey`] (`Standard` vs `Extended`) for this frame.
    #[inline]
    pub const fn can_id_key(&self) -> CanIdKey {
        CanIdKey::new_masked(self.arb_id, self.is_extended())
    }

    /// Returns the active payload byte slice (`0..=64` bytes, clamped safely).
    #[inline]
    pub fn payload(&self) -> &[u8] {
        &self.data[..usize::from(self.dlc.min(MAX_CAN_FD_DLC as u8))]
    }

    /// Returns a mutable slice over the active payload bytes (`0..=64` bytes, clamped safely).
    #[inline]
    pub fn payload_mut(&mut self) -> &mut [u8] {
        let len = usize::from(self.dlc.min(MAX_CAN_FD_DLC as u8));
        &mut self.data[..len]
    }

    /// Returns `true` if `FLAG_EXTENDED` (29-bit arbitration ID) is set.
    #[inline]
    pub const fn is_extended(&self) -> bool {
        (self.flags & FLAG_EXTENDED) != 0
    }

    /// Returns `true` if `FLAG_RTR` (Remote Transmission Request) is set.
    #[inline]
    pub const fn is_rtr(&self) -> bool {
        (self.flags & FLAG_RTR) != 0
    }

    /// Returns `true` if `FLAG_FD` (CAN-FD frame) is set.
    #[inline]
    pub const fn is_fd(&self) -> bool {
        (self.flags & FLAG_FD) != 0
    }

    /// Returns `true` if `FLAG_BRS` (CAN-FD Bit Rate Switch) is set.
    #[inline]
    pub const fn is_brs(&self) -> bool {
        (self.flags & FLAG_BRS) != 0
    }

    /// Returns `true` if `FLAG_ESI` (CAN-FD Error State Indicator) is set.
    #[inline]
    pub const fn is_esi(&self) -> bool {
        (self.flags & FLAG_ESI) != 0
    }

    /// Returns `true` if `FLAG_ERROR` (bus error frame) is set.
    #[inline]
    pub const fn is_error(&self) -> bool {
        (self.flags & FLAG_ERROR) != 0
    }

    /// Returns `true` if `FLAG_TX` (self-transmitted / loopback echo) is set.
    #[inline]
    pub const fn is_tx(&self) -> bool {
        (self.flags & FLAG_TX) != 0
    }

    /// Returns `true` if `FLAG_HW_TIMESTAMP` (adapter hardware clock) is set.
    #[inline]
    pub const fn has_hw_timestamp(&self) -> bool {
        (self.flags & FLAG_HW_TIMESTAMP) != 0
    }
}

/// Converts a 4-bit ISO 11898-1 wire DLC code (`0..=15`) into payload byte length.
///
/// - Classical CAN (`is_fd == false`): codes `9..=15` clamp to `8` bytes.
/// - CAN-FD (`is_fd == true`): maps `9..=15` -> `12, 16, 20, 24, 32, 48, 64` bytes.
#[inline]
pub const fn dlc_code_to_len(dlc_code: u8, is_fd: bool) -> u8 {
    if !is_fd {
        if dlc_code <= 8 {
            dlc_code
        } else {
            8
        }
    } else {
        match dlc_code {
            0..=8 => dlc_code,
            9 => 12,
            10 => 16,
            11 => 20,
            12 => 24,
            13 => 32,
            14 => 48,
            _ => 64,
        }
    }
}

/// Maps a CAN-FD payload byte length (`0..=64`) to the smallest ISO 11898-1 4-bit DLC code (`0..=15`).
#[inline]
pub const fn len_to_canfd_dlc_code(len: u8) -> u8 {
    match len {
        0..=8 => len,
        9..=12 => 9,
        13..=16 => 10,
        17..=20 => 11,
        21..=24 => 12,
        25..=32 => 13,
        33..=48 => 14,
        _ => 15,
    }
}

/// Rounds an arbitrary payload length (`0..=64`) up to the next valid ISO 11898-1 CAN-FD
/// payload byte count (`0..=8, 12, 16, 20, 24, 32, 48, 64`).
#[inline]
pub const fn quantize_canfd_payload_len(len: usize) -> u8 {
    match len {
        0..=8 => len as u8,
        9..=12 => 12,
        13..=16 => 16,
        17..=20 => 20,
        21..=24 => 24,
        25..=32 => 32,
        33..=48 => 48,
        _ => 64,
    }
}

/// Estimates total on-wire bits for a frame (including SOF, arbitration, control, payload,
/// CRC, ACK, EOF, 3-bit interframe space, and ISO 11898-1 bit-stuffing overhead) for
/// real-time Bus Load % calculation.
#[inline]
pub const fn estimate_frame_wire_bits(dlc: u8, is_extended: bool, is_fd: bool) -> u32 {
    if !is_fd {
        let payload_bytes = if dlc > 8 { 8 } else { dlc } as u32;
        let data_bits = payload_bytes * 8;
        // Classical CAN:
        // Standard 11-bit: 19 header + data + 15 CRC = (34 + data) stuffed bits, + 13 unstuffed trailer/IFS = 47 + data
        // Extended 29-bit: 39 header + data + 15 CRC = (54 + data) stuffed bits, + 13 unstuffed trailer/IFS = 67 + data
        let (unstuffed_total, stuffed_region) = if is_extended {
            (67 + data_bits, 54 + data_bits)
        } else {
            (47 + data_bits, 34 + data_bits)
        };
        unstuffed_total + (stuffed_region / 5)
    } else {
        let payload_bytes = quantize_canfd_payload_len(dlc as usize) as u32;
        let data_bits = payload_bytes * 8;
        let header_bits = if is_extended { 41 } else { 22 };
        // ISO 11898-1:2015 CAN-FD CRC field (including 4-bit Stuff Bit Count + fixed stuff bits):
        // <= 16 bytes: CRC17 + SBC(4) + 5 fixed stuff bits = 26 bits
        // >  16 bytes: CRC21 + SBC(4) + 6 fixed stuff bits = 31 bits
        let crc_field_bits = if payload_bytes <= 16 { 26 } else { 31 };
        let trailer_and_ifs_bits = 13; // CRC delim(1) + ACK(2) + EOF(7) + IFS(3)
        let dynamic_stuff_bits = (header_bits + data_bits) / 5;
        header_bits + data_bits + crc_field_bits + trailer_and_ifs_bits + dynamic_stuff_bits
    }
}

/// Zero-dependency fixed `[u8; 64]` serializer/deserializer for [`RawCanFrame::data`].
mod serde_bytes_64 {
    use core::fmt;
    use serde::de::{self, SeqAccess, Visitor};
    use serde::ser::SerializeTuple;
    use serde::{Deserializer, Serializer};

    pub fn serialize<S>(bytes: &[u8; 64], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut seq = serializer.serialize_tuple(64)?;
        for byte in bytes {
            seq.serialize_element(byte)?;
        }
        seq.end()
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<[u8; 64], D::Error>
    where
        D: Deserializer<'de>,
    {
        struct Bytes64Visitor;

        impl<'de> Visitor<'de> for Bytes64Visitor {
            type Value = [u8; 64];

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a byte array of length 64")
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut out = [0u8; 64];
                for (idx, slot) in out.iter_mut().enumerate() {
                    *slot = seq
                        .next_element()?
                        .ok_or_else(|| de::Error::invalid_length(idx, &self))?;
                }
                Ok(out)
            }

            fn visit_bytes<E>(self, v: &[u8]) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                if v.len() != 64 {
                    return Err(E::invalid_length(v.len(), &self));
                }
                let mut out = [0u8; 64];
                out.copy_from_slice(v);
                Ok(out)
            }
        }

        deserializer.deserialize_tuple(64, Bytes64Visitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn raw_can_frame_exact_80_byte_c_layout() {
        assert_eq!(size_of::<RawCanFrame>(), 80);
        assert_eq!(align_of::<RawCanFrame>(), 8);
        assert_eq!(offset_of!(RawCanFrame, timestamp_us), 0);
        assert_eq!(offset_of!(RawCanFrame, arb_id), 8);
        assert_eq!(offset_of!(RawCanFrame, bus_id), 12);
        assert_eq!(offset_of!(RawCanFrame, dlc), 13);
        assert_eq!(offset_of!(RawCanFrame, flags), 14);
        assert_eq!(offset_of!(RawCanFrame, _reserved), 15);
        assert_eq!(offset_of!(RawCanFrame, data), 16);

        let default_frame = RawCanFrame::default();
        assert_eq!(default_frame, RawCanFrame::zeroed());
        assert_eq!(default_frame.payload().len(), 0);
    }

    #[test]
    fn standard_and_extended_ids_never_collide_in_hashmap() {
        let std_id = CanIdKey::new_standard(0x100).expect("valid 11-bit ID");
        let ext_id = CanIdKey::new_extended(0x100).expect("valid 29-bit ID");

        assert_ne!(std_id, ext_id);
        assert!(!std_id.is_extended());
        assert!(ext_id.is_extended());
        assert_eq!(std_id.raw_id(), 0x100);
        assert_eq!(ext_id.raw_id(), 0x100);
        assert_eq!(std_id.schema_key(), "STD:0x100");
        assert_eq!(ext_id.schema_key(), "EXT:0x00000100");

        let mut map = HashMap::new();
        map.insert(std_id, "BMS_Std_100");
        map.insert(ext_id, "J1939_Ext_100");

        assert_eq!(map.len(), 2);
        assert_eq!(map.get(&std_id), Some(&"BMS_Std_100"));
        assert_eq!(map.get(&ext_id), Some(&"J1939_Ext_100"));

        assert_eq!(CanIdKey::new_standard(0x7FF), Some(CanIdKey::Standard(0x7FF)));
        assert_eq!(CanIdKey::new_standard(0x800), None);
        assert_eq!(
            CanIdKey::new_extended(0x1FFF_FFFF),
            Some(CanIdKey::Extended(0x1FFF_FFFF))
        );
        assert_eq!(CanIdKey::new_extended(0x2000_0000), None);
    }

    #[test]
    fn dbc_raw_id_parsing_and_roundtrip() {
        // 11-bit Standard ID
        let std_key = CanIdKey::from_dbc_raw_id(0x123);
        assert_eq!(std_key, Some(CanIdKey::Standard(0x123)));
        assert_eq!(CanIdKey::Standard(0x123).to_dbc_raw_id(), 0x123);

        // 29-bit Extended ID with bit-31 DBC flag (0x8000_0000 | 0x18FEEE00)
        let raw_ext = DBC_EXT_ID_FLAG | 0x18FE_EE00;
        let ext_key = CanIdKey::from_dbc_raw_id(raw_ext);
        assert_eq!(ext_key, Some(CanIdKey::Extended(0x18FE_EE00)));
        assert_eq!(CanIdKey::Extended(0x18FE_EE00).to_dbc_raw_id(), raw_ext);

        // VECTOR__INDEPENDENT_SIG_MSG (3221225472 == 0xC000_0000) -> None
        assert_eq!(VECTOR_INDEPENDENT_SIG_MSG_ID, 3_221_225_472);
        assert_eq!(CanIdKey::from_dbc_raw_id(3_221_225_472), None);

        // Unflagged ID > 0x7FF is invalid in DBC
        assert_eq!(CanIdKey::from_dbc_raw_id(0x800), None);
    }

    #[test]
    fn j1939_pgn_extraction_pdu1_and_pdu2() {
        // Standard 11-bit frames do not carry a 29-bit J1939 PGN
        assert_eq!(CanIdKey::Standard(0x123).extract_j1939_pgn(), None);

        // PDU1 (PF = 0xEF = 239 < 240): Destination Address (PS) & SA must be masked out!
        // 0x0CEF0021 -> Priority=3, EDP=0, DP=0, PF=0xEF, DA=0x00, SA=0x21 => PGN 0x00EF00 (61184)
        let pdu1_zero_da = CanIdKey::Extended(0x0CEF_0021);
        assert_eq!(pdu1_zero_da.extract_j1939_pgn(), Some(0x00EF00));
        assert_eq!(pdu1_zero_da.extract_j1939_pgn(), Some(61_184));

        // Same PDU1 with non-zero Destination Address (DA = 0xF9, SA = 0x21) still yields PGN 0x00EF00
        let pdu1_with_da = CanIdKey::Extended(0x0CEF_F921);
        assert_eq!(pdu1_with_da.extract_j1939_pgn(), Some(61_184));

        // PDU2 (PF = 0xFE = 254 >= 240): PS (0xEE) is Group Extension and MUST be retained,
        // while Priority (6 -> 0x18) and Source Address (0x00 / 0x27) are masked out!
        // 0x18FEEE00 -> PGN 0x00FEEE (65262, Engine Temperature 1)
        let pdu2_et1 = CanIdKey::Extended(0x18FE_EE00);
        assert_eq!(pdu2_et1.extract_j1939_pgn(), Some(0x00FEEE));
        assert_eq!(pdu2_et1.extract_j1939_pgn(), Some(65_262));

        let pdu2_diff_prio_sa = CanIdKey::Extended(0x0CFE_EE27);
        assert_eq!(pdu2_diff_prio_sa.extract_j1939_pgn(), Some(65_262));

        // Data Page (DP = 1) preservation check: 0x19F11234 -> DP=1, PF=0xF1, PS=0x12 => 0x01F112
        let dp1_key = CanIdKey::Extended(0x19F1_1234);
        assert_eq!(dp1_key.extract_j1939_pgn(), Some(0x01F112));
    }

    #[test]
    fn canfd_dlc_quantization_and_codec_tables() {
        for len in 0usize..=8 {
            assert_eq!(quantize_canfd_payload_len(len), len as u8);
            assert_eq!(len_to_canfd_dlc_code(len as u8), len as u8);
            assert_eq!(dlc_code_to_len(len as u8, false), len as u8);
            assert_eq!(dlc_code_to_len(len as u8, true), len as u8);
        }

        let bands: &[(core::ops::RangeInclusive<usize>, u8, u8)] = &[
            (9..=12, 12, 9),
            (13..=16, 16, 10),
            (17..=20, 20, 11),
            (21..=24, 24, 12),
            (25..=32, 32, 13),
            (33..=48, 48, 14),
            (49..=64, 64, 15),
        ];

        for (range, expected_len, expected_code) in bands {
            for len in range.clone() {
                assert_eq!(quantize_canfd_payload_len(len), *expected_len);
                assert_eq!(len_to_canfd_dlc_code(len as u8), *expected_code);
            }
            assert_eq!(dlc_code_to_len(*expected_code, true), *expected_len);
            assert_eq!(dlc_code_to_len(*expected_code, false), 8);
        }

        // Wire-bit estimation sanity checks
        let std_8 = estimate_frame_wire_bits(8, false, false);
        let ext_8 = estimate_frame_wire_bits(8, true, false);
        let fd_64 = estimate_frame_wire_bits(64, true, true);
        assert_eq!(std_8, 130);
        assert!(ext_8 > std_8);
        assert!(fd_64 > ext_8);
    }

    #[test]
    fn frame_constructors_flags_and_serde_json_64b_roundtrip() {
        // Classical frame validation
        let too_long_classical =
            RawCanFrame::new_classical(0, CanIdKey::Standard(0x100), &[0u8; 9], 1_000);
        assert_eq!(
            too_long_classical,
            Err(FrameError::ClassicalPayloadTooLarge { actual: 9, max: 8 })
        );

        let classical =
            RawCanFrame::new_classical(2, CanIdKey::Standard(0x123), &[0xAA, 0x55], 42_000)
                .expect("valid classical frame");
        assert_eq!(classical.bus_id, 2);
        assert_eq!(classical.can_id_key(), CanIdKey::Standard(0x123));
        assert_eq!(classical.payload(), &[0xAA, 0x55]);
        assert!(!classical.is_fd());
        assert!(!classical.is_extended());

        // CAN-FD padding quantization (10 bytes -> quantized 12-byte DLC)
        let fd_padded =
            RawCanFrame::new_fd(1, CanIdKey::Extended(0x18FF_50E5), &[0x11; 10], true, 99_999)
                .expect("valid 10->12B CAN-FD frame");
        assert_eq!(fd_padded.dlc, 12);
        assert!(fd_padded.is_fd());
        assert!(fd_padded.is_brs());
        assert!(fd_padded.is_extended());
        assert_eq!(&fd_padded.payload()[..10], &[0x11; 10]);
        assert_eq!(&fd_padded.payload()[10..12], &[0x00, 0x00]);

        // Full 64-byte CAN-FD serde_json roundtrip
        let mut full_payload = [0u8; 64];
        for (i, b) in full_payload.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(3).wrapping_add(7);
        }

        let mut fd_64 = RawCanFrame::new_fd(
            3,
            CanIdKey::Extended(0x1ABC_DEF0),
            &full_payload,
            true,
            1_234_567_890,
        )
        .expect("valid 64B CAN-FD frame")
        .with_flags(FLAG_HW_TIMESTAMP | FLAG_TX | FLAG_ESI);

        fd_64.payload_mut()[63] = 0xFE;
        assert!(fd_64.has_hw_timestamp());
        assert!(fd_64.is_tx());
        assert!(fd_64.is_esi());
        assert!(!fd_64.is_rtr());
        assert!(!fd_64.is_error());

        let mut fflags = fd_64.frame_flags();
        assert!(fflags.contains(FrameFlags::FD | FrameFlags::BRS | FrameFlags::HW_TIMESTAMP));
        fflags.remove(FrameFlags::ESI);
        assert!(!fflags.contains(FrameFlags::ESI));
        fflags.insert(FrameFlags::ERROR);
        assert!(fflags.contains(FrameFlags::ERROR));

        let json = serde_json::to_string(&fd_64).expect("serialize 64B RawCanFrame");
        let decoded: RawCanFrame =
            serde_json::from_str(&json).expect("deserialize 64B RawCanFrame");
        assert_eq!(decoded, fd_64);
        assert_eq!(decoded.payload()[63], 0xFE);

        // CanIdKey tagged serde check
        let key_json = serde_json::to_string(&CanIdKey::Standard(0x100)).expect("serialize CanIdKey");
        assert_eq!(key_json, r#"{"kind":"Standard","id":256}"#);
        let key_back: CanIdKey = serde_json::from_str(&key_json).expect("deserialize CanIdKey");
        assert_eq!(key_back, CanIdKey::Standard(0x100));

        // Negative validation cases: >64B FD payload, out-of-range IDs, RTR frame, malformed JSON data length
        assert_eq!(
            RawCanFrame::new_fd(0, CanIdKey::Standard(0x100), &[0u8; 65], false, 0),
            Err(FrameError::CanFdPayloadTooLarge {
                actual: 65,
                max: 64
            })
        );
        assert_eq!(
            RawCanFrame::new_classical(0, CanIdKey::Standard(0x800), &[], 0),
            Err(FrameError::InvalidStandardId(0x800))
        );
        assert_eq!(
            RawCanFrame::new_fd(0, CanIdKey::Extended(0x2000_0000), &[], false, 0),
            Err(FrameError::InvalidExtendedId(0x2000_0000))
        );

        let rtr = RawCanFrame::new_rtr(0, CanIdKey::Standard(0x7DF), 8, 500)
            .expect("valid Classical RTR frame");
        assert!(rtr.is_rtr());
        assert_eq!(rtr.dlc, 8);

        let short_json = r#"{"timestamp_us":1,"arb_id":1,"bus_id":0,"dlc":0,"flags":0,"_reserved":0,"data":[0,1,2]}"#;
        assert!(serde_json::from_str::<RawCanFrame>(short_json).is_err());
    }
}
