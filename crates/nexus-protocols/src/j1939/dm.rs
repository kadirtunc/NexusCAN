//! SAE J1939-73 diagnostic messages DM1 / DM2 (parsing) and DM1 / DM2 / DM3 / DM11 request
//! builders — pure logic, no I/O.
//!
//! Payload layout (single frame or a TP-reassembled payload):
//!
//! * byte 0: lamp status, two bits each: MIL (bits 8-7), RSL (6-5), AWL (4-3), PL (2-1)
//! * byte 1: lamp flash, same bit positions
//! * bytes 2.. : 4-byte DTCs (SPN 19 bits, FMI 5 bits, CM 1 bit, OC 7 bits), then 0xFF fill
//!
//! SPN conversion method (J1939-73 §5.7.1.11): CM = 0 → Version 4 (Intel, 19 bits, the standard
//! layout). CM = 1 → one of the pre-1996-fix Versions 1, 2 or 3; the bit alone does NOT say
//! which, so the caller picks it via [`DmParseOptions::legacy_spn_conversion`] and every DTC
//! reports the method actually used plus its raw 4 bytes for re-decoding.
//!
//! SPN names are NOT resolved here (that is a later DBC / database lookup); only FMI names
//! (a closed 0..=31 table) are provided by [`fmi_name`].
//!
//! The request builders are TX actions. DM3 / DM11 requests CLEAR diagnostic information on the
//! target ECU: the HAL must route them through the gated TX path (Listen-Only lock, explicit
//! Arm Active Bus, Panic Stop) and should require operator confirmation.

use serde::{Deserialize, Serialize};

use super::address_claim::{build_request, DEFAULT_REQUEST_PRIORITY};
use super::id::{J1939Frame, J1939IdError};

/// DM1 active DTCs (0xFECA).
pub const PGN_DM1: u32 = 65226;
/// DM2 previously active DTCs (0xFECB).
pub const PGN_DM2: u32 = 65227;
/// DM3 diagnostic data clear/reset of previously active DTCs (0xFECC).
pub const PGN_DM3: u32 = 65228;
/// DM11 diagnostic data clear/reset for active DTCs (0xFED3).
pub const PGN_DM11: u32 = 65235;

/// Occurrence count value meaning "not available".
pub const OC_NOT_AVAILABLE: u8 = 127;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DmError {
    #[error("DM payload needs at least 2 lamp bytes, got {0}")]
    TooShort(usize),
    #[error("PGN {0} is not DM1 (65226) or DM2 (65227)")]
    NotDmPgn(u32),
}

/// Which DTC list a payload carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DmKind {
    /// Active DTCs.
    Dm1,
    /// Previously active DTCs.
    Dm2,
}

impl DmKind {
    pub fn pgn(self) -> u32 {
        match self {
            Self::Dm1 => PGN_DM1,
            Self::Dm2 => PGN_DM2,
        }
    }

    pub fn from_pgn(pgn: u32) -> Option<Self> {
        match pgn {
            PGN_DM1 => Some(Self::Dm1),
            PGN_DM2 => Some(Self::Dm2),
            _ => None,
        }
    }
}

/// Two-bit lamp status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LampState {
    Off,
    On,
    /// `10b` — reserved / error.
    Error,
    NotAvailable,
}

impl LampState {
    fn from_bits(b: u8) -> Self {
        match b & 0x03 {
            0 => Self::Off,
            1 => Self::On,
            2 => Self::Error,
            _ => Self::NotAvailable,
        }
    }
}

/// Two-bit lamp flash status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LampFlash {
    /// `00b` — slow flash (1 Hz).
    Slow,
    /// `01b` — fast flash (2 Hz or faster).
    Fast,
    /// `10b` — reserved.
    Reserved,
    /// `11b` — unavailable / do not flash.
    NotFlashing,
}

impl LampFlash {
    fn from_bits(b: u8) -> Self {
        match b & 0x03 {
            0 => Self::Slow,
            1 => Self::Fast,
            2 => Self::Reserved,
            _ => Self::NotFlashing,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LampDto {
    pub status: LampState,
    pub flash: LampFlash,
}

/// The four J1939-73 lamps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LampStatusDto {
    /// Malfunction Indicator Lamp.
    pub mil: LampDto,
    /// Red Stop Lamp.
    pub red_stop: LampDto,
    /// Amber Warning Lamp.
    pub amber_warning: LampDto,
    /// Protect Lamp.
    pub protect: LampDto,
}

impl LampStatusDto {
    /// Decodes lamp byte (`status`) and flash byte (`flash`).
    pub fn from_bytes(status: u8, flash: u8) -> Self {
        let lamp = |shift: u8| LampDto {
            status: LampState::from_bits(status >> shift),
            flash: LampFlash::from_bits(flash >> shift),
        };
        Self {
            mil: lamp(6),
            red_stop: lamp(4),
            amber_warning: lamp(2),
            protect: lamp(0),
        }
    }
}

/// SPN conversion method (J1939-73 §5.7.1.11). Worked example from the standard for
/// SPN 1208 / FMI 3 / OC 10 (bytes 3..6):
///
/// * V1 `00 97 03 8A` — SPN sent most significant bit first.
/// * V2 `97 00 03 8A` — upper 16 SPN bits Intel, 3 LSBs with the FMI.
/// * V3 `B8 04 03 8A` — all 19 bits Intel (CM = 1).
/// * V4 `B8 04 03 0A` — all 19 bits Intel, CM = 0 (recommended).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpnConversion {
    Version1,
    Version2,
    Version3,
    Version4,
}

/// The legacy methods a CM = 1 DTC can use. The CM bit does not tell them apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LegacySpnConversion {
    Version1,
    Version2,
    /// Default: bit-identical to Version 4, so a modern ECU that wrongly sets CM = 1 still
    /// decodes correctly. Override per ECU when a true pre-1996 device is known.
    #[default]
    Version3,
}

impl From<LegacySpnConversion> for SpnConversion {
    fn from(v: LegacySpnConversion) -> Self {
        match v {
            LegacySpnConversion::Version1 => Self::Version1,
            LegacySpnConversion::Version2 => Self::Version2,
            LegacySpnConversion::Version3 => Self::Version3,
        }
    }
}

/// Decodes the 19-bit SPN of a 4-byte DTC with an explicit method (ignores the CM bit).
pub fn decode_spn(dtc: [u8; 4], method: SpnConversion) -> u32 {
    let [b3, b4, b5, _] = dtc.map(u32::from);
    let spn_low3_or_high3 = b5 >> 5;
    match method {
        // byte3 = SPN bits 18..11, byte4 = bits 10..3, byte5[7:5] = bits 2..0.
        SpnConversion::Version1 => (b3 << 11) | (b4 << 3) | spn_low3_or_high3,
        // Upper 16 bits Intel (byte3 = low byte, byte4 = high byte), byte5[7:5] = bits 2..0.
        SpnConversion::Version2 => (((b4 << 8) | b3) << 3) | spn_low3_or_high3,
        // byte3 = bits 7..0, byte4 = bits 15..8, byte5[7:5] = bits 18..16.
        SpnConversion::Version3 | SpnConversion::Version4 => {
            b3 | (b4 << 8) | (spn_low3_or_high3 << 16)
        }
    }
}

/// One decoded DTC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DtcDto {
    /// 19-bit Suspect Parameter Number (no name lookup here).
    pub spn: u32,
    /// 5-bit Failure Mode Identifier; see [`fmi_name`].
    pub fmi: u8,
    /// Raw CM bit.
    pub cm: bool,
    /// Method actually used to decode `spn`.
    pub conversion: SpnConversion,
    /// 0..=126; `None` when the raw value is 127 (not available).
    pub occurrence_count: Option<u8>,
    /// The 4 raw DTC bytes, so a UI can re-decode with another legacy method.
    pub raw: [u8; 4],
}

impl DtcDto {
    /// Decodes a 4-byte DTC: CM = 0 → Version 4, CM = 1 → `legacy`.
    pub fn decode(raw: [u8; 4], legacy: LegacySpnConversion) -> Self {
        let cm = raw[3] & 0x80 != 0;
        let conversion = if cm {
            legacy.into()
        } else {
            SpnConversion::Version4
        };
        let oc = raw[3] & 0x7F;
        Self {
            spn: decode_spn(raw, conversion),
            fmi: raw[2] & 0x1F,
            cm,
            conversion,
            occurrence_count: (oc != OC_NOT_AVAILABLE).then_some(oc),
            raw,
        }
    }

    /// Encodes with method Version 4 (CM = 0). `spn` is masked to 19 bits, `fmi` to 5 bits,
    /// a `None` / > 126 occurrence count becomes 127 (not available).
    pub fn encode_v4(spn: u32, fmi: u8, occurrence_count: Option<u8>) -> [u8; 4] {
        let spn = spn & 0x7_FFFF;
        let oc = occurrence_count
            .filter(|&c| c < OC_NOT_AVAILABLE)
            .unwrap_or(OC_NOT_AVAILABLE);
        [
            (spn & 0xFF) as u8,
            ((spn >> 8) & 0xFF) as u8,
            (((spn >> 16) as u8 & 0x07) << 5) | (fmi & 0x1F),
            oc,
        ]
    }
}

/// Parse options for DM1 / DM2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DmParseOptions {
    /// Method applied to DTCs with CM = 1.
    #[serde(default)]
    pub legacy_spn_conversion: LegacySpnConversion,
}

/// A decoded DM1 / DM2 payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DmMessageDto {
    pub kind: DmKind,
    pub lamps: LampStatusDto,
    /// Real DTCs only: "no DTC" placeholders (SPN 0 / FMI 0) and 0xFF fill groups are removed.
    pub dtcs: Vec<DtcDto>,
    /// `true` when the message carries no real DTC (e.g. `00 00 00 00` placeholder).
    pub no_active_dtcs: bool,
    /// Number of SPN 0 / FMI 0 placeholder entries that were skipped.
    pub placeholder_count: u16,
    /// Number of all-0xFF 4-byte fill groups skipped.
    pub fill_groups: u16,
    /// Trailing bytes (len - 2) % 4 that were NOT pure 0xFF fill (0 for a clean payload).
    pub malformed_trailing_bytes: u16,
}

/// Parses a DM1 or DM2 payload (8-byte single frame or a TP-reassembled payload).
/// Never panics; only payloads shorter than the 2 lamp bytes are an error.
pub fn parse_dm(
    kind: DmKind,
    payload: &[u8],
    opts: DmParseOptions,
) -> Result<DmMessageDto, DmError> {
    let (lamp_bytes, rest) = match payload {
        [s, f, rest @ ..] => ((*s, *f), rest),
        _ => return Err(DmError::TooShort(payload.len())),
    };
    let lamps = LampStatusDto::from_bytes(lamp_bytes.0, lamp_bytes.1);
    let mut dtcs = Vec::with_capacity(rest.len() / 4);
    let mut placeholder_count: u16 = 0;
    let mut fill_groups: u16 = 0;
    // Plain index walk (no `as_chunks`: keeps the workspace MSRV 1.80).
    let mut rest = rest;
    while let [a, b, c, d, more @ ..] = rest {
        rest = more;
        let raw = [*a, *b, *c, *d];
        if raw == [0xFF; 4] {
            fill_groups = fill_groups.saturating_add(1);
            continue;
        }
        let dtc = DtcDto::decode(raw, opts.legacy_spn_conversion);
        if dtc.spn == 0 && dtc.fmi == 0 {
            placeholder_count = placeholder_count.saturating_add(1);
            continue;
        }
        dtcs.push(dtc);
    }
    let tail = rest;
    let malformed_trailing_bytes = if tail.iter().all(|&b| b == 0xFF) {
        0
    } else {
        tail.len() as u16
    };
    Ok(DmMessageDto {
        kind,
        lamps,
        no_active_dtcs: dtcs.is_empty(),
        dtcs,
        placeholder_count,
        fill_groups,
        malformed_trailing_bytes,
    })
}

/// Parses by PGN (65226 → DM1, 65227 → DM2).
pub fn parse_dm_by_pgn(
    pgn: u32,
    payload: &[u8],
    opts: DmParseOptions,
) -> Result<DmMessageDto, DmError> {
    let kind = DmKind::from_pgn(pgn).ok_or(DmError::NotDmPgn(pgn))?;
    parse_dm(kind, payload, opts)
}

/// J1939-73 FMI names (0..=31). 22..=30 are reserved → `None`.
pub fn fmi_name(fmi: u8) -> Option<&'static str> {
    Some(match fmi {
        0 => "Data valid but above normal operational range - most severe level",
        1 => "Data valid but below normal operational range - most severe level",
        2 => "Data erratic, intermittent or incorrect",
        3 => "Voltage above normal, or shorted to high source",
        4 => "Voltage below normal, or shorted to low source",
        5 => "Current below normal or open circuit",
        6 => "Current above normal or grounded circuit",
        7 => "Mechanical system not responding or out of adjustment",
        8 => "Abnormal frequency or pulse width or period",
        9 => "Abnormal update rate",
        10 => "Abnormal rate of change",
        11 => "Root cause not known",
        12 => "Bad intelligent device or component",
        13 => "Out of calibration",
        14 => "Special instructions",
        15 => "Data valid but above normal operating range - least severe level",
        16 => "Data valid but above normal operating range - moderately severe level",
        17 => "Data valid but below normal operating range - least severe level",
        18 => "Data valid but below normal operating range - moderately severe level",
        19 => "Received network data in error",
        20 => "Data drifted high",
        21 => "Data drifted low",
        31 => "Condition exists",
        _ => return None,
    })
}

/// Request DM1 (active DTCs) via Request PGN 59904. `da` = 0xFF for all ECUs.
/// TX action: gate through Listen-Only / Arm Active Bus / Panic Stop in the HAL.
pub fn build_request_dm1(sa: u8, da: u8) -> Result<J1939Frame, J1939IdError> {
    build_request(PGN_DM1, sa, da, DEFAULT_REQUEST_PRIORITY)
}

/// Request DM2 (previously active DTCs) via Request PGN 59904.
/// TX action: gate through Listen-Only / Arm Active Bus / Panic Stop in the HAL.
pub fn build_request_dm2(sa: u8, da: u8) -> Result<J1939Frame, J1939IdError> {
    build_request(PGN_DM2, sa, da, DEFAULT_REQUEST_PRIORITY)
}

/// Request DM3: CLEARS previously active DTCs on the target(s) (Request PGN 59904 for 65228).
///
/// DESTRUCTIVE TX action on the ECU's diagnostic memory: the HAL must route it through the
/// gated TX path (Listen-Only lock, explicit Arm Active Bus, Panic Stop) and require operator
/// confirmation. Building the frame here sends nothing.
pub fn build_request_dm3_clear_previously_active(
    sa: u8,
    da: u8,
) -> Result<J1939Frame, J1939IdError> {
    build_request(PGN_DM3, sa, da, DEFAULT_REQUEST_PRIORITY)
}

/// Request DM11: CLEARS active DTCs on the target(s) (Request PGN 59904 for 65235).
///
/// DESTRUCTIVE TX action on the ECU's diagnostic memory: the HAL must route it through the
/// gated TX path (Listen-Only lock, explicit Arm Active Bus, Panic Stop) and require operator
/// confirmation. Building the frame here sends nothing.
pub fn build_request_dm11_clear_active(sa: u8, da: u8) -> Result<J1939Frame, J1939IdError> {
    build_request(PGN_DM11, sa, da, DEFAULT_REQUEST_PRIORITY)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dm1(payload: &[u8]) -> DmMessageDto {
        parse_dm(DmKind::Dm1, payload, DmParseOptions::default()).unwrap()
    }

    #[test]
    fn dm_spn_conversion_versions_standard_example() {
        // J1939-73 (JUL2013) §5.7.1.11 worked example: SPN 1208, FMI 3, OC 10.
        let v1 = [0x00, 0x97, 0x03, 0x8A];
        let v2 = [0x97, 0x00, 0x03, 0x8A];
        let v3 = [0xB8, 0x04, 0x03, 0x8A];
        let v4 = [0xB8, 0x04, 0x03, 0x0A];
        assert_eq!(decode_spn(v1, SpnConversion::Version1), 1208);
        assert_eq!(decode_spn(v2, SpnConversion::Version2), 1208);
        assert_eq!(decode_spn(v3, SpnConversion::Version3), 1208);
        assert_eq!(decode_spn(v4, SpnConversion::Version4), 1208);

        let d4 = DtcDto::decode(v4, LegacySpnConversion::Version1);
        assert!(!d4.cm);
        assert_eq!(d4.conversion, SpnConversion::Version4);
        assert_eq!((d4.spn, d4.fmi, d4.occurrence_count), (1208, 3, Some(10)));

        for (bytes, legacy) in [
            (v1, LegacySpnConversion::Version1),
            (v2, LegacySpnConversion::Version2),
            (v3, LegacySpnConversion::Version3),
        ] {
            let d = DtcDto::decode(bytes, legacy);
            assert!(d.cm);
            assert_eq!(d.conversion, SpnConversion::from(legacy));
            assert_eq!((d.spn, d.fmi, d.occurrence_count), (1208, 3, Some(10)));
        }
        // Same CM = 1 bytes decoded with the wrong legacy method give a different SPN.
        assert_ne!(DtcDto::decode(v1, LegacySpnConversion::Version3).spn, 1208);
        assert_eq!(DtcDto::encode_v4(1208, 3, Some(10)), v4);
    }

    #[test]
    fn dm_cm0_vs_cm1_in_payload() {
        // Constructed: one CM=0 DTC and one CM=1 (V1) DTC, legacy option set to Version 1.
        let p = [0x00, 0xFF, 0xB8, 0x04, 0x03, 0x0A, 0x00, 0x97, 0x03, 0x8A];
        let m = parse_dm(
            DmKind::Dm1,
            &p,
            DmParseOptions {
                legacy_spn_conversion: LegacySpnConversion::Version1,
            },
        )
        .unwrap();
        assert_eq!(m.dtcs.len(), 2);
        assert_eq!(m.dtcs[0].conversion, SpnConversion::Version4);
        assert_eq!(m.dtcs[1].conversion, SpnConversion::Version1);
        assert!(m.dtcs.iter().all(|d| d.spn == 1208 && d.fmi == 3));
    }

    #[test]
    fn dm1_zero_dtcs_placeholder() {
        // Typical "no active DTC" single frame: lamps off, flash N/A, 00 00 00 00, FF FF fill.
        let m = dm1(&[0x00, 0xFF, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF]);
        assert!(m.no_active_dtcs);
        assert!(m.dtcs.is_empty());
        assert_eq!(m.placeholder_count, 1);
        assert_eq!(m.malformed_trailing_bytes, 0);
        // SPN 0 / FMI 0 with a non-zero OC is also a placeholder.
        let m = dm1(&[0x00, 0xFF, 0x00, 0x00, 0x00, 0x7F, 0xFF, 0xFF]);
        assert!(m.no_active_dtcs);
        // Lamp bytes only.
        assert!(dm1(&[0x00, 0x00]).no_active_dtcs);
    }

    #[test]
    fn dm1_one_dtc_single_frame() {
        // Constructed V4: SPN 100 (0x64), FMI 1, OC 2, AWL on.
        let dtc = DtcDto::encode_v4(100, 1, Some(2));
        let mut p = vec![0b0000_0100, 0xFF];
        p.extend_from_slice(&dtc);
        p.extend_from_slice(&[0xFF, 0xFF]);
        let m = dm1(&p);
        assert!(!m.no_active_dtcs);
        assert_eq!(m.dtcs.len(), 1);
        assert_eq!(m.dtcs[0].spn, 100);
        assert_eq!(m.dtcs[0].fmi, 1);
        assert_eq!(m.dtcs[0].occurrence_count, Some(2));
        assert_eq!(m.lamps.amber_warning.status, LampState::On);
        assert_eq!(m.lamps.mil.status, LampState::Off);
    }

    #[test]
    fn dm1_three_dtcs_tp_payload() {
        // Constructed V4: 2 + 3*4 = 14 bytes (would arrive via TP BAM), max SPN, OC N/A.
        let mut p = vec![0x40, 0xFF];
        p.extend_from_slice(&DtcDto::encode_v4(1208, 3, Some(10)));
        p.extend_from_slice(&DtcDto::encode_v4(0x7_FFFF, 31, None));
        p.extend_from_slice(&DtcDto::encode_v4(523_000, 14, Some(126)));
        let m = dm1(&p);
        assert_eq!(m.dtcs.len(), 3);
        assert_eq!(m.dtcs[0].spn, 1208);
        assert_eq!(m.dtcs[1].spn, 0x7_FFFF);
        assert_eq!(m.dtcs[1].fmi, 31);
        assert_eq!(m.dtcs[1].occurrence_count, None);
        assert_eq!(m.dtcs[2].spn, 523_000);
        assert_eq!(m.dtcs[2].occurrence_count, Some(126));
        assert_eq!(m.lamps.mil.status, LampState::On);
        // Same with TP fill to a 7-byte boundary (14 → 14, add a full FF group + 1 FF).
        p.extend_from_slice(&[0xFF; 5]);
        let m2 = dm1(&p);
        assert_eq!(m2.dtcs, m.dtcs);
        assert_eq!(m2.fill_groups, 1);
        assert_eq!(m2.malformed_trailing_bytes, 0);
        // Non-FF trailing garbage is counted, not fatal.
        p.push(0x12);
        assert_eq!(dm1(&p).malformed_trailing_bytes, 2);
    }

    #[test]
    fn dm_lamp_bits() {
        // status: MIL=01 RSL=10 AWL=11 PL=00 → 0b01_10_11_00; flash: MIL=00 RSL=01 AWL=10 PL=11.
        let l = LampStatusDto::from_bytes(0b0110_1100, 0b0001_1011);
        assert_eq!(l.mil.status, LampState::On);
        assert_eq!(l.red_stop.status, LampState::Error);
        assert_eq!(l.amber_warning.status, LampState::NotAvailable);
        assert_eq!(l.protect.status, LampState::Off);
        assert_eq!(l.mil.flash, LampFlash::Slow);
        assert_eq!(l.red_stop.flash, LampFlash::Fast);
        assert_eq!(l.amber_warning.flash, LampFlash::Reserved);
        assert_eq!(l.protect.flash, LampFlash::NotFlashing);
    }

    #[test]
    fn dm_errors_and_pgn_dispatch() {
        assert_eq!(
            parse_dm(DmKind::Dm1, &[0x00], DmParseOptions::default()),
            Err(DmError::TooShort(1))
        );
        assert_eq!(
            parse_dm_by_pgn(61444, &[0; 8], DmParseOptions::default()),
            Err(DmError::NotDmPgn(61444))
        );
        let m = parse_dm_by_pgn(PGN_DM2, &[0; 8], DmParseOptions::default()).unwrap();
        assert_eq!(m.kind, DmKind::Dm2);
    }

    #[test]
    fn dm_fmi_names() {
        assert_eq!(
            fmi_name(3),
            Some("Voltage above normal, or shorted to high source")
        );
        assert_eq!(fmi_name(31), Some("Condition exists"));
        assert_eq!(fmi_name(25), None);
        assert_eq!(fmi_name(200), None);
    }

    #[test]
    fn dm_request_builders() {
        let f = build_request_dm1(0xF9, 0xFF).unwrap();
        assert_eq!(f.id, 0x18EA_FFF9);
        assert_eq!(f.payload(), &[0xCA, 0xFE, 0x00]);
        assert_eq!(
            build_request_dm2(0xF9, 0x00).unwrap().payload(),
            &[0xCB, 0xFE, 0x00]
        );
        let f = build_request_dm3_clear_previously_active(0xF9, 0x00).unwrap();
        assert_eq!(f.id, 0x18EA_00F9);
        assert_eq!(f.payload(), &[0xCC, 0xFE, 0x00]);
        let f = build_request_dm11_clear_active(0xF9, 0x00).unwrap();
        assert_eq!(f.payload(), &[0xD3, 0xFE, 0x00]);
    }

    #[test]
    fn dm_fuzz_never_panics() {
        // Simple xorshift64 fuzz loop: 20k random payloads of 0..=64 bytes.
        let mut x: u64 = 0xDEAD_BEEF_CAFE_F00D;
        let mut next = || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        let mut buf = [0u8; 64];
        for i in 0..20_000u32 {
            let len = (next() % 65) as usize;
            for b in buf.iter_mut().take(len) {
                *b = next() as u8;
            }
            let legacy = match i % 3 {
                0 => LegacySpnConversion::Version1,
                1 => LegacySpnConversion::Version2,
                _ => LegacySpnConversion::Version3,
            };
            let opts = DmParseOptions {
                legacy_spn_conversion: legacy,
            };
            match parse_dm(DmKind::Dm1, &buf[..len], opts) {
                Ok(m) => {
                    assert!(m.dtcs.iter().all(|d| d.spn <= 0x7_FFFF && d.fmi <= 31));
                    assert_eq!(m.no_active_dtcs, m.dtcs.is_empty());
                }
                Err(e) => assert!(len < 2, "unexpected error {e} for len {len}"),
            }
        }
    }
}
