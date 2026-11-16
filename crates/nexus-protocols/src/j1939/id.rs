//! SAE J1939-21 29-bit identifier codec — pure logic, no I/O.
//!
//! Bit layout of the 29-bit CAN identifier (bit 28 = MSB):
//!
//! | bits   | field | meaning                                              |
//! |--------|-------|------------------------------------------------------|
//! | 28..26 | P     | priority (0 = highest, 7 = lowest)                   |
//! | 25     | EDP   | extended data page                                   |
//! | 24     | DP    | data page                                            |
//! | 23..16 | PF    | PDU format                                           |
//! | 15..8  | PS    | PDU specific: DA (PDU1, PF < 240) or GE (PDU2)       |
//! | 7..0   | SA    | source address                                       |
//!
//! * PDU1 (`PF < 240`): PS is the destination address; the PGN low byte is always 0.
//! * PDU2 (`PF >= 240`): PS is the group extension and is part of the PGN; always broadcast.
//! * `EDP = 1, DP = 1` is the ISO 15765-3 range and is NOT J1939 ([`J1939IdError::Iso15765Range`]).
//!   `EDP = 1, DP = 0` is reserved by J1939 for future use; it is decoded (18-bit PGN) but callers
//!   can check [`J1939Id::edp`].

use serde::{Deserialize, Serialize};

/// Largest 29-bit identifier.
pub const MAX_EXTENDED_ID: u32 = 0x1FFF_FFFF;
/// Largest 18-bit PGN (EDP | DP | PF | PS).
pub const MAX_PGN: u32 = 0x3_FFFF;
/// Global (broadcast) destination address.
pub const ADDRESS_GLOBAL: u8 = 0xFF;
/// "NULL" address used by an ECU that cannot claim an address (J1939-81).
pub const ADDRESS_NULL: u8 = 0xFE;
/// First PF value of the PDU2 (broadcast, group-extension) format.
pub const PDU2_THRESHOLD: u8 = 240;

/// Why an identifier is not a J1939 identifier, or why an id cannot be built.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum J1939IdError {
    #[error(
        "not J1939: 11-bit standard identifier 0x{0:03X} (J1939 uses 29-bit identifiers only)"
    )]
    NotExtended(u32),
    #[error("identifier 0x{0:08X} exceeds 29 bits")]
    OutOfRange(u32),
    #[error("not J1939: EDP=1/DP=1 is the ISO 15765-3 range (identifier 0x{0:08X})")]
    Iso15765Range(u32),
    #[error("priority {0} out of range 0..=7")]
    InvalidPriority(u8),
    #[error("PGN 0x{0:05X} exceeds 18 bits")]
    InvalidPgn(u32),
    #[error("PGN 0x{0:05X} uses EDP=1/DP=1 (ISO 15765-3 range, not J1939)")]
    PgnInIso15765Range(u32),
    #[error("PDU1 PGN 0x{0:05X} must have a zero low byte (the PS byte carries the destination address)")]
    Pdu1PgnLowByteNonZero(u32),
}

/// A decoded J1939 29-bit identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct J1939Id {
    /// 0..=7.
    pub priority: u8,
    pub edp: bool,
    pub dp: bool,
    /// PDU format.
    pub pf: u8,
    /// PDU specific: destination address (PDU1) or group extension (PDU2).
    pub ps: u8,
    /// Source address.
    pub sa: u8,
}

impl J1939Id {
    /// Decodes a raw CAN identifier. `extended` is the frame's IDE flag; 11-bit identifiers and
    /// the ISO 15765-3 range (EDP=1, DP=1) are rejected with a reason.
    pub fn decode(raw_id: u32, extended: bool) -> Result<Self, J1939IdError> {
        if !extended {
            return Err(J1939IdError::NotExtended(raw_id));
        }
        if raw_id > MAX_EXTENDED_ID {
            return Err(J1939IdError::OutOfRange(raw_id));
        }
        let edp = (raw_id >> 25) & 1 == 1;
        let dp = (raw_id >> 24) & 1 == 1;
        if edp && dp {
            return Err(J1939IdError::Iso15765Range(raw_id));
        }
        Ok(Self {
            priority: ((raw_id >> 26) & 0x07) as u8,
            edp,
            dp,
            pf: ((raw_id >> 16) & 0xFF) as u8,
            ps: ((raw_id >> 8) & 0xFF) as u8,
            sa: (raw_id & 0xFF) as u8,
        })
    }

    /// Builds an identifier from a PGN. For a PDU1 PGN `da` becomes the PS byte (the PGN low
    /// byte must be zero); for a PDU2 PGN `da` is ignored (PDU2 is always broadcast).
    pub fn from_pgn(priority: u8, pgn: u32, da: u8, sa: u8) -> Result<Self, J1939IdError> {
        if priority > 7 {
            return Err(J1939IdError::InvalidPriority(priority));
        }
        if pgn > MAX_PGN {
            return Err(J1939IdError::InvalidPgn(pgn));
        }
        let edp = (pgn >> 17) & 1 == 1;
        let dp = (pgn >> 16) & 1 == 1;
        if edp && dp {
            return Err(J1939IdError::PgnInIso15765Range(pgn));
        }
        let pf = ((pgn >> 8) & 0xFF) as u8;
        let ge = (pgn & 0xFF) as u8;
        let ps = if pf < PDU2_THRESHOLD {
            if ge != 0 {
                return Err(J1939IdError::Pdu1PgnLowByteNonZero(pgn));
            }
            da
        } else {
            ge
        };
        Ok(Self {
            priority,
            edp,
            dp,
            pf,
            ps,
            sa,
        })
    }

    /// Encodes back to the raw 29-bit identifier (masks every field to its width).
    pub fn encode(&self) -> u32 {
        (u32::from(self.priority & 0x07) << 26)
            | (u32::from(self.edp) << 25)
            | (u32::from(self.dp) << 24)
            | (u32::from(self.pf) << 16)
            | (u32::from(self.ps) << 8)
            | u32::from(self.sa)
    }

    /// `true` for PDU1 (PF < 240, destination-specific).
    pub fn is_pdu1(&self) -> bool {
        self.pf < PDU2_THRESHOLD
    }

    /// 18-bit Parameter Group Number. PDU1: `(EDP, DP, PF) << 8` with a zero low byte;
    /// PDU2: the group extension (PS) is included.
    pub fn pgn(&self) -> u32 {
        let base =
            (u32::from(self.edp) << 17) | (u32::from(self.dp) << 16) | (u32::from(self.pf) << 8);
        if self.is_pdu1() {
            base
        } else {
            base | u32::from(self.ps)
        }
    }

    /// Destination address: PS for PDU1, [`ADDRESS_GLOBAL`] for PDU2.
    pub fn destination(&self) -> u8 {
        if self.is_pdu1() {
            self.ps
        } else {
            ADDRESS_GLOBAL
        }
    }
}

/// A J1939 frame to transmit: always a 29-bit (extended) identifier, classic CAN, `len <= 8`.
///
/// Builders in this module tree only produce these values; they never send anything. The HAL
/// must route them through the gated TX path (Listen-Only lock, Arm Active Bus, Panic Stop).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct J1939Frame {
    /// Raw 29-bit identifier (send with the IDE/extended flag set).
    pub id: u32,
    /// Payload; only the first `len` bytes are meaningful (the rest is 0xFF fill).
    pub data: [u8; 8],
    /// DLC, 0..=8.
    pub len: u8,
}

impl J1939Frame {
    /// The meaningful payload bytes.
    pub fn payload(&self) -> &[u8] {
        let n = usize::from(self.len).min(self.data.len());
        &self.data[..n]
    }
}

/// Encodes a 3-byte little-endian PGN (Request payload, TP.CM bytes 6..8).
pub(crate) fn pgn_to_le3(pgn: u32) -> [u8; 3] {
    [
        (pgn & 0xFF) as u8,
        ((pgn >> 8) & 0xFF) as u8,
        ((pgn >> 16) & 0xFF) as u8,
    ]
}

/// Decodes a 3-byte little-endian PGN.
pub(crate) fn pgn_from_le3(b: [u8; 3]) -> u32 {
    u32::from(b[0]) | (u32::from(b[1]) << 8) | (u32::from(b[2]) << 16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_pdu2_dm1_vector() {
        // 0x18FECA00 = DM1 (PGN 65226 = 0xFECA) from SA 0x00, priority 6.
        let id = J1939Id::decode(0x18FE_CA00, true).unwrap();
        assert_eq!(id.priority, 6);
        assert!(!id.edp && !id.dp);
        assert_eq!(id.pf, 0xFE);
        assert_eq!(id.ps, 0xCA);
        assert_eq!(id.sa, 0x00);
        assert!(!id.is_pdu1());
        assert_eq!(id.pgn(), 65226);
        assert_eq!(id.destination(), ADDRESS_GLOBAL);
        assert_eq!(id.encode(), 0x18FE_CA00);
    }

    #[test]
    fn id_pdu2_eec1_vector() {
        // 0x0CF00400 = EEC1 (PGN 61444 = 0xF004) from the engine (SA 0x00), priority 3.
        let id = J1939Id::decode(0x0CF0_0400, true).unwrap();
        assert_eq!(id.priority, 3);
        assert_eq!(id.pgn(), 61444);
        assert_eq!(id.sa, 0x00);
    }

    #[test]
    fn id_pdu1_request_vector() {
        // 0x18EA00F9 = Request (PGN 59904 = 0xEA00) from SA 0xF9 to DA 0x00, priority 6.
        let id = J1939Id::decode(0x18EA_00F9, true).unwrap();
        assert!(id.is_pdu1());
        assert_eq!(id.pgn(), 59904);
        assert_eq!(id.destination(), 0x00);
        assert_eq!(id.sa, 0xF9);
        assert_eq!(
            J1939Id::from_pgn(6, 59904, 0x00, 0xF9).unwrap().encode(),
            0x18EA_00F9
        );
    }

    #[test]
    fn id_pdu1_tp_cm_vector() {
        // 0x1CECFF00 = TP.CM (PGN 60416 = 0xEC00) BAM to global from SA 0x00, priority 7.
        let id = J1939Id::decode(0x1CEC_FF00, true).unwrap();
        assert_eq!(id.priority, 7);
        assert_eq!(id.pgn(), 60416);
        assert_eq!(id.destination(), 0xFF);
    }

    #[test]
    fn id_data_page_bit_in_pgn() {
        // DP = 1, PF = 0xFE, PS = 0x10 → PGN 0x1FE10 (constructed from the bit layout).
        let raw = (6 << 26) | (1 << 24) | (0xFE << 16) | (0x10 << 8) | 0x21;
        let id = J1939Id::decode(raw, true).unwrap();
        assert!(id.dp);
        assert_eq!(id.pgn(), 0x1_FE10);
        assert_eq!(
            J1939Id::from_pgn(6, 0x1_FE10, 0x00, 0x21).unwrap().encode(),
            raw
        );
    }

    #[test]
    fn id_rejects_non_j1939() {
        assert_eq!(
            J1939Id::decode(0x7DF, false),
            Err(J1939IdError::NotExtended(0x7DF))
        );
        assert_eq!(
            J1939Id::decode(0x2000_0000, true),
            Err(J1939IdError::OutOfRange(0x2000_0000))
        );
        // EDP=1/DP=1 → ISO 15765-3.
        let raw = 0x1B00_0000 | 0x00DA_F100;
        assert!(matches!(
            J1939Id::decode(raw, true),
            Err(J1939IdError::Iso15765Range(_))
        ));
    }

    #[test]
    fn id_from_pgn_validation() {
        assert_eq!(
            J1939Id::from_pgn(8, 0xFECA, 0xFF, 0),
            Err(J1939IdError::InvalidPriority(8))
        );
        assert_eq!(
            J1939Id::from_pgn(6, 0x4_0000, 0xFF, 0),
            Err(J1939IdError::InvalidPgn(0x4_0000))
        );
        assert_eq!(
            J1939Id::from_pgn(6, 0xEA01, 0xFF, 0),
            Err(J1939IdError::Pdu1PgnLowByteNonZero(0xEA01))
        );
        assert_eq!(
            J1939Id::from_pgn(6, 0x3_0000, 0xFF, 0),
            Err(J1939IdError::PgnInIso15765Range(0x3_0000))
        );
        // PDU2: DA ignored.
        assert_eq!(
            J1939Id::from_pgn(6, 0xFECA, 0x12, 0x00).unwrap().encode(),
            0x18FE_CA00
        );
    }

    #[test]
    fn id_roundtrip_all_fields() {
        let mut x: u32 = 0x1234_5678;
        for _ in 0..5000 {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            let raw = x & MAX_EXTENDED_ID;
            match J1939Id::decode(raw, true) {
                Ok(id) => assert_eq!(id.encode(), raw),
                Err(e) => assert!(matches!(e, J1939IdError::Iso15765Range(_))),
            }
        }
    }

    #[test]
    fn pgn_le3_roundtrip() {
        assert_eq!(pgn_to_le3(0xFECA), [0xCA, 0xFE, 0x00]);
        assert_eq!(pgn_from_le3([0x00, 0xEE, 0x00]), 60928);
    }
}
