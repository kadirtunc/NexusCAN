//! Pure UDS helpers used by the client: response matching, sub-function / suppression rules,
//! DTC display formatting, DID record decoding and DiagnosticSessionControl timing parsing.
//! No I/O, fully unit-tested.

use crate::uds::dto::DtcEntryDto;
use crate::uds::security::to_hex;

/// Negative response SID.
pub const NEGATIVE_RESPONSE_SID: u8 = 0x7F;

/// Services whose first data byte is a sub-function with a suppressPosRspMsgIndicationBit.
/// (0x19 ReadDTCInformation has a sub-function but no suppression support.)
pub fn sid_supports_suppression(sid: u8) -> bool {
    matches!(
        sid,
        0x10 | 0x11 | 0x27 | 0x28 | 0x29 | 0x2C | 0x31 | 0x3E | 0x83 | 0x84 | 0x85 | 0x86 | 0x87
    )
}

/// `true` when the request PDU asks the ECU to suppress the positive response.
pub fn request_suppresses_positive(req: &[u8]) -> bool {
    match (req.first(), req.get(1)) {
        (Some(&sid), Some(&sub)) => sid_supports_suppression(sid) && sub & 0x80 != 0,
        _ => false,
    }
}

/// Does `pdu` answer `req`?
///
/// Positive: SID + 0x40 and, for the common services, the echoed sub-function (without the
/// suppression bit) / identifier. Negative: `7F <request SID> <nrc>`. Anything else is a stale
/// or foreign PDU (for example the late answer to a previous request that already timed out).
pub fn response_matches(req: &[u8], pdu: &[u8]) -> bool {
    let (Some(&sid), Some(&rsid)) = (req.first(), pdu.first()) else {
        return false;
    };
    if rsid == NEGATIVE_RESPONSE_SID {
        return pdu.len() >= 3 && pdu[1] == sid;
    }
    if rsid != sid.wrapping_add(0x40) {
        return false;
    }
    let sub_echo = || match (req.get(1), pdu.get(1)) {
        (Some(r), Some(p)) => r & 0x7F == *p,
        (None, _) => true,
        (Some(_), None) => false,
    };
    match sid {
        // Echoed 2-byte identifier (first DID for multi-DID 0x22).
        0x22 | 0x2E | 0x2F | 0x24 => req.get(1..3).is_none() || pdu.get(1..3) == req.get(1..3),
        // Routine control: echoed control type + routine id.
        0x31 => sub_echo() && (req.get(2..4).is_none() || pdu.get(2..4) == req.get(2..4)),
        // TransferData echoes the block sequence counter.
        0x36 => req.get(1).is_none() || pdu.get(1) == req.get(1),
        // Services echoing their sub-function.
        0x10 | 0x11 | 0x19 | 0x27 | 0x28 | 0x29 | 0x2C | 0x3E | 0x83 | 0x84 | 0x85 | 0x86
        | 0x87 => sub_echo(),
        _ => true,
    }
}

/// SID of the request a (possibly stale) response PDU belongs to.
pub fn request_sid_of_response(pdu: &[u8]) -> Option<u8> {
    match pdu.first() {
        Some(&NEGATIVE_RESPONSE_SID) => pdu.get(1).copied(),
        Some(&rsid) if rsid >= 0x40 => Some(rsid - 0x40),
        _ => None,
    }
}

/// `(nrc)` of a negative response PDU.
pub fn negative_code(pdu: &[u8]) -> Option<u8> {
    if pdu.first() == Some(&NEGATIVE_RESPONSE_SID) && pdu.len() >= 3 {
        Some(pdu[2])
    } else {
        None
    }
}

/// ECU timings from a positive 0x50 response: `(P2server ms, P2*server ms)`.
/// Layout: `50 <session> <P2 hi> <P2 lo> <P2*/10 hi> <P2*/10 lo>` (P2* in 10 ms units).
pub fn parse_session_timing(pdu: &[u8]) -> Option<(u32, u32)> {
    if pdu.first() != Some(&0x50) || pdu.len() < 6 {
        return None;
    }
    let p2 = u32::from(u16::from_be_bytes([pdu[2], pdu[3]]));
    let p2_star = u32::from(u16::from_be_bytes([pdu[4], pdu[5]])) * 10;
    Some((p2, p2_star))
}

/// DTC display code: letter from bits 15-14 of the first two DTC bytes (P/C/B/U), then the
/// remaining 14 bits as 4 hex digits (first digit 0-3), then `-` and the failure type byte.
/// Example: `0x012345` → `"P0123-45"`.
pub fn format_dtc_code(dtc: u32) -> String {
    let hi = ((dtc >> 16) & 0xFF) as u8;
    let mid = ((dtc >> 8) & 0xFF) as u8;
    let ftb = (dtc & 0xFF) as u8;
    let letter = match hi >> 6 {
        0 => 'P',
        1 => 'C',
        2 => 'B',
        _ => 'U',
    };
    format!(
        "{letter}{:01X}{:01X}{mid:02X}-{ftb:02X}",
        (hi >> 4) & 0x03,
        hi & 0x0F
    )
}

/// One DTC record (3 DTC bytes + status) → DTO.
pub fn dtc_entry(dtc: u32, status: u8) -> DtcEntryDto {
    DtcEntryDto {
        code: format_dtc_code(dtc),
        raw: dtc & 0x00FF_FFFF,
        status_byte: status,
        is_confirmed: status & 0x08 != 0,
        is_pending: status & 0x04 != 0,
        is_mil_on: status & 0x80 != 0,
        description: None,
    }
}

/// Parses the record list of a positive `59 02 <availabilityMask> (DTC3 status)*` response.
/// Returns `None` when the header is wrong or a record is truncated.
pub fn parse_dtcs_by_status(pdu: &[u8]) -> Option<Vec<DtcEntryDto>> {
    if pdu.len() < 3 || pdu[0] != 0x59 || pdu[1] != 0x02 {
        return None;
    }
    let records = &pdu[3..];
    if records.len() & 3 != 0 {
        return None;
    }
    Some(
        (0..records.len() / 4)
            .map(|i| {
                let r = &records[i * 4..i * 4 + 4];
                let dtc = (u32::from(r[0]) << 16) | (u32::from(r[1]) << 8) | u32::from(r[2]);
                dtc_entry(dtc, r[3])
            })
            .collect(),
    )
}

/// `decoded` rule for DID data records: printable ASCII text when every byte (after trimming
/// trailing 0x00 / 0xFF / 0x20) is in `0x20..=0x7E`, otherwise uppercase hex without separators
/// of the complete record.
pub fn decode_did_record(raw: &[u8]) -> String {
    let end = raw
        .iter()
        .rposition(|b| !matches!(b, 0x00 | 0xFF | 0x20))
        .map_or(0, |i| i + 1);
    let text = &raw[..end];
    if !text.is_empty() && text.iter().all(|b| (0x20..=0x7E).contains(b)) {
        text.iter().map(|&b| char::from(b)).collect()
    } else {
        to_hex(raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dtc_code_letters_and_digits() {
        assert_eq!(format_dtc_code(0x012345), "P0123-45");
        assert_eq!(format_dtc_code(0x9A0B00), "B1A0B-00");
        assert_eq!(format_dtc_code(0x400100), "C0001-00");
        assert_eq!(format_dtc_code(0xC15500), "U0155-00");
        assert_eq!(format_dtc_code(0xFFFFFF), "U3FFF-FF");
        assert_eq!(format_dtc_code(0x000000), "P0000-00");
        // Bits above 24 are ignored.
        assert_eq!(format_dtc_code(0xAB01_2345), "P0123-45");
    }

    #[test]
    fn dtc_status_bits() {
        let e = dtc_entry(0x012345, 0x2F);
        assert!(e.is_confirmed && e.is_pending && !e.is_mil_on);
        assert_eq!(e.raw, 0x012345);
        let e = dtc_entry(0x9A0B00, 0x88);
        assert!(e.is_confirmed && !e.is_pending && e.is_mil_on);
        let e = dtc_entry(0x9A0B00, 0x04);
        assert!(!e.is_confirmed && e.is_pending && !e.is_mil_on);
        assert_eq!(e.description, None);
    }

    #[test]
    fn dtc_response_parsing() {
        let pdu = [
            0x59, 0x02, 0xFF, 0x01, 0x23, 0x45, 0x2F, 0x9A, 0x0B, 0x00, 0x08,
        ];
        let list = parse_dtcs_by_status(&pdu).unwrap_or_default();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].code, "P0123-45");
        assert_eq!(list[1].code, "B1A0B-00");
        assert_eq!(list[1].status_byte, 0x08);
        assert_eq!(
            parse_dtcs_by_status(&[0x59, 0x02, 0xFF]).map(|v| v.len()),
            Some(0)
        );
        assert!(parse_dtcs_by_status(&[0x59, 0x02, 0xFF, 1, 2, 3]).is_none());
        assert!(parse_dtcs_by_status(&[0x59, 0x01, 0xFF]).is_none());
        assert!(parse_dtcs_by_status(&[0x59]).is_none());
    }

    #[test]
    fn decoded_rule() {
        assert_eq!(decode_did_record(b"WNX0ECUSIM0000017"), "WNX0ECUSIM0000017");
        assert_eq!(decode_did_record(b"SW-0001\0\0\0"), "SW-0001");
        assert_eq!(decode_did_record(b"AB  \xFF\xFF"), "AB");
        assert_eq!(decode_did_record(&[0xCA, 0xFE, 0xBA, 0xBE]), "CAFEBABE");
        assert_eq!(decode_did_record(&[0x26, 0x11, 0x10]), "261110");
        // Inner NUL is not printable → hex of the whole record (untrimmed).
        assert_eq!(decode_did_record(b"A\0B\0"), "41004200");
        // All padding → hex.
        assert_eq!(decode_did_record(&[0x00, 0x00]), "0000");
        assert_eq!(decode_did_record(&[0x20]), "20");
        assert_eq!(decode_did_record(&[]), "");
        assert_eq!(decode_did_record(&[0x03]), "03");
    }

    #[test]
    fn matching_positive_and_negative() {
        let rdbi = [0x22, 0xF1, 0x90];
        assert!(response_matches(&rdbi, &[0x62, 0xF1, 0x90, b'W']));
        assert!(!response_matches(&rdbi, &[0x62, 0xFA, 0x03, 0x03]));
        assert!(response_matches(&rdbi, &[0x7F, 0x22, 0x31]));
        assert!(!response_matches(&rdbi, &[0x7F, 0x10, 0x31]));
        assert!(!response_matches(&rdbi, &[0x7F, 0x22]));
        assert!(!response_matches(&rdbi, &[0x50, 0x03]));
        assert!(!response_matches(&rdbi, &[]));
        assert!(!response_matches(&[], &[0x62]));

        // Sub-function echo without the suppression bit.
        assert!(response_matches(
            &[0x10, 0x03],
            &[0x50, 0x03, 0x00, 0x32, 0x00, 0xC8]
        ));
        assert!(!response_matches(
            &[0x10, 0x03],
            &[0x50, 0x01, 0x00, 0x32, 0x00, 0xC8]
        ));
        assert!(response_matches(&[0x3E, 0x80], &[0x7E, 0x00]));
        assert!(response_matches(
            &[0x27, 0x01],
            &[0x67, 0x01, 0x11, 0x22, 0x33, 0x44]
        ));
        assert!(!response_matches(&[0x27, 0x02, 0xB4], &[0x67, 0x01, 0x11]));
        assert!(response_matches(&[0x19, 0x02, 0xFF], &[0x59, 0x02, 0xFF]));

        // Routine control echoes type + RID.
        assert!(response_matches(
            &[0x31, 0x01, 0x02, 0x03],
            &[0x71, 0x01, 0x02, 0x03, 0x00]
        ));
        assert!(!response_matches(
            &[0x31, 0x01, 0x02, 0x03],
            &[0x71, 0x01, 0xFA, 0x05, 0x00]
        ));

        // TransferData echoes the block sequence counter.
        assert!(response_matches(&[0x36, 0x05, 0xAA], &[0x76, 0x05]));
        assert!(!response_matches(&[0x36, 0x05, 0xAA], &[0x76, 0x04]));

        // Services without an echo match on the SID only.
        assert!(response_matches(&[0x14, 0xFF, 0xFF, 0xFF], &[0x54]));
    }

    #[test]
    fn suppression_rules() {
        assert!(request_suppresses_positive(&[0x3E, 0x80]));
        assert!(request_suppresses_positive(&[0x10, 0x83]));
        assert!(!request_suppresses_positive(&[0x3E, 0x00]));
        assert!(!request_suppresses_positive(&[0x22, 0xF1, 0x90]));
        assert!(!request_suppresses_positive(&[0x19, 0x82]));
        assert!(!request_suppresses_positive(&[0x3E]));
    }

    #[test]
    fn session_timing_parse() {
        assert_eq!(
            parse_session_timing(&[0x50, 0x03, 0x00, 0x32, 0x00, 0xC8]),
            Some((50, 2000))
        );
        assert_eq!(parse_session_timing(&[0x50, 0x03]), None);
        assert_eq!(parse_session_timing(&[0x51, 0x03, 0, 0, 0, 0]), None);
    }

    #[test]
    fn response_sid_helpers() {
        assert_eq!(request_sid_of_response(&[0x62, 0xF1]), Some(0x22));
        assert_eq!(request_sid_of_response(&[0x7F, 0x27, 0x35]), Some(0x27));
        assert_eq!(request_sid_of_response(&[0x01]), None);
        assert_eq!(negative_code(&[0x7F, 0x22, 0x78]), Some(0x78));
        assert_eq!(negative_code(&[0x62, 0x22, 0x78]), None);
    }
}
