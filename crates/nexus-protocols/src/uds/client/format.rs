//! Pure UDS helpers used by the client: response matching, sub-function / suppression rules,
//! DTC display formatting, DID record decoding and DiagnosticSessionControl timing parsing.
//! No I/O, fully unit-tested.

use crate::uds::dto::{
    DtcCountDto, DtcEntryDto, DtcExtDataReportDto, DtcListDto, DtcSnapshotIdDto,
    DtcSnapshotRecordDto, DtcSnapshotReportDto, ReadDtcReportDto,
};
use crate::uds::security::to_hex;

/// Negative response SID.
pub const NEGATIVE_RESPONSE_SID: u8 = 0x7F;

/// Services whose first data byte is a sub-function with a suppressPosRspMsgIndicationBit.
/// (0x19 ReadDTCInformation has a sub-function but no suppression support. 0x84
/// SecuredDataTransmission has no sub-function. 0x83 AccessTimingParameter was withdrawn in
/// ISO 14229-1:2020; kept for 2013-edition ECUs.)
pub fn sid_supports_suppression(sid: u8) -> bool {
    matches!(
        sid,
        0x10 | 0x11 | 0x27 | 0x28 | 0x29 | 0x2C | 0x31 | 0x3E | 0x83 | 0x85 | 0x86 | 0x87
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
        // Services echoing their sub-function (0x84 has none; 0x83 is 2013-edition only).
        0x10 | 0x11 | 0x19 | 0x27 | 0x28 | 0x29 | 0x2C | 0x3E | 0x83 | 0x85 | 0x86 | 0x87 => {
            sub_echo()
        }
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

// ─── ReadDTCInformation (0x19) ──────────────────────────────────────────────
// All parsers take the full positive response PDU (`59 <subFunction> ...`), return `None` on a
// wrong header, wrong length or truncation, and never panic (slices are bounds-checked).

const RDTCI_POSITIVE: u8 = 0x59;

/// Name of a DTCFormatIdentifier (ISO 14229-1, reportNumberOf… responses).
pub fn dtc_format_name(id: u8) -> Option<&'static str> {
    match id {
        0x00 => Some("ISO15031-6"),
        0x01 => Some("ISO14229-1"),
        0x02 => Some("SAE J1939-73"),
        0x03 => Some("ISO11992-4"),
        0x04 => Some("SAE J2012-DA WWH-OBD"),
        _ => None,
    }
}

fn dtc3(b: &[u8]) -> u32 {
    (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2])
}

/// `59 01|07|11|12 <availMask> <formatId> <count hi> <count lo>` (exactly 6 bytes).
pub fn parse_dtc_count(pdu: &[u8]) -> Option<DtcCountDto> {
    match pdu {
        [RDTCI_POSITIVE, sf @ (0x01 | 0x07 | 0x11 | 0x12), mask, fmt, hi, lo] => {
            Some(DtcCountDto {
                sub_function: *sf,
                availability_mask: *mask,
                format_identifier: *fmt,
                format_name: dtc_format_name(*fmt).map(str::to_owned),
                count: u16::from_be_bytes([*hi, *lo]),
            })
        }
        _ => None,
    }
}

/// `59 02|0A|0F|13|15 <availMask> (DTC3 status)*` (same record layout as 0x02).
pub fn parse_dtc_list(pdu: &[u8]) -> Option<DtcListDto> {
    let (&sf, &mask, records) = match pdu {
        [RDTCI_POSITIVE, sf @ (0x02 | 0x0A | 0x0F | 0x13 | 0x15), mask, rest @ ..] => {
            (sf, mask, rest)
        }
        _ => return None,
    };
    let (chunks, rem) = records.as_chunks::<4>();
    if !rem.is_empty() {
        return None;
    }
    Some(DtcListDto {
        sub_function: sf,
        availability_mask: mask,
        dtcs: chunks.iter().map(|r| dtc_entry(dtc3(r), r[3])).collect(),
    })
}

/// `59 03 (DTC3 recordNumber)*` reportDTCSnapshotIdentification.
pub fn parse_dtc_snapshot_identification(pdu: &[u8]) -> Option<Vec<DtcSnapshotIdDto>> {
    let [RDTCI_POSITIVE, 0x03, records @ ..] = pdu else {
        return None;
    };
    let (chunks, rem) = records.as_chunks::<4>();
    if !rem.is_empty() {
        return None;
    }
    Some(
        chunks
            .iter()
            .map(|r| {
                let dtc = dtc3(r);
                DtcSnapshotIdDto {
                    dtc,
                    code: format_dtc_code(dtc),
                    record_number: r[3],
                }
            })
            .collect(),
    )
}

/// `59 <sf> DTC3 status rest..` → (DTC entry, rest).
fn dtc_and_rest(pdu: &[u8], sf: u8) -> Option<(DtcEntryDto, &[u8])> {
    match pdu {
        [RDTCI_POSITIVE, s, d0, d1, d2, status, rest @ ..] if *s == sf => {
            Some((dtc_entry(dtc3(&[*d0, *d1, *d2]), *status), rest))
        }
        _ => None,
    }
}

/// `59 04 DTC3 status [recordNumber numberOfIdentifiers DID2 data… …]`.
///
/// Limitation: DID data lengths are not encoded in the response (ODX / CDD knowledge), so
/// record boundaries after the first DID are unknown. Decoded: the first record's number,
/// identifier count and first DID; `singleDidData` only when `requested_record` is a single
/// record (not 0xFF) holding exactly one DID. Everything else stays in `raw`.
pub fn parse_dtc_snapshot_record(
    pdu: &[u8],
    requested_record: Option<u8>,
) -> Option<DtcSnapshotReportDto> {
    let (dtc, rest) = dtc_and_rest(pdu, 0x04)?;
    let record = match rest {
        [] => None,
        [_] => return None, // recordNumber without numberOfIdentifiers
        [rec, n, body @ ..] => {
            let first_did = match (*n, body) {
                (0, _) => None,
                (_, [hi, lo, ..]) => Some(u16::from_be_bytes([*hi, *lo])),
                _ => return None, // DID truncated
            };
            let single = requested_record.is_some_and(|r| r != 0xFF && r == *rec) && *n == 1;
            Some(DtcSnapshotRecordDto {
                record_number: *rec,
                number_of_identifiers: *n,
                first_did,
                single_did_data: single.then(|| body.get(2..).unwrap_or_default().to_vec()),
                raw: rest.to_vec(),
            })
        }
    };
    Some(DtcSnapshotReportDto { dtc, record })
}

/// `59 06 DTC3 status [recordNumber data… …]`. Record data lengths are ECU specific, so
/// everything after the status byte is returned raw (with the first record number).
pub fn parse_dtc_ext_data_record(pdu: &[u8]) -> Option<DtcExtDataReportDto> {
    let (dtc, rest) = dtc_and_rest(pdu, 0x06)?;
    Some(DtcExtDataReportDto {
        dtc,
        first_record_number: rest.first().copied(),
        raw: rest.to_vec(),
    })
}

/// Any supported positive 0x19 response by sub-function (`requested_record`: see
/// [`parse_dtc_snapshot_record`]). `None` for other sub-functions or malformed PDUs.
pub fn parse_read_dtc_report(pdu: &[u8], requested_record: Option<u8>) -> Option<ReadDtcReportDto> {
    match pdu.get(..2)? {
        [RDTCI_POSITIVE, 0x01 | 0x07 | 0x11 | 0x12] => {
            parse_dtc_count(pdu).map(ReadDtcReportDto::Count)
        }
        [RDTCI_POSITIVE, 0x02 | 0x0A | 0x0F | 0x13 | 0x15] => {
            parse_dtc_list(pdu).map(ReadDtcReportDto::List)
        }
        [RDTCI_POSITIVE, 0x03] => parse_dtc_snapshot_identification(pdu)
            .map(|records| ReadDtcReportDto::SnapshotIdentification { records }),
        [RDTCI_POSITIVE, 0x04] => {
            parse_dtc_snapshot_record(pdu, requested_record).map(ReadDtcReportDto::SnapshotRecord)
        }
        [RDTCI_POSITIVE, 0x06] => parse_dtc_ext_data_record(pdu).map(ReadDtcReportDto::ExtData),
        _ => None,
    }
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
    fn rdtci_count_reports() {
        for sf in [0x01u8, 0x07, 0x11, 0x12] {
            let c = parse_dtc_count(&[0x59, sf, 0xFF, 0x01, 0x01, 0x02]);
            assert_eq!(
                c,
                Some(DtcCountDto {
                    sub_function: sf,
                    availability_mask: 0xFF,
                    format_identifier: 0x01,
                    format_name: Some("ISO14229-1".into()),
                    count: 0x0102,
                })
            );
        }
        let names: Vec<Option<&str>> = (0..=5).map(dtc_format_name).collect();
        assert_eq!(
            names,
            vec![
                Some("ISO15031-6"),
                Some("ISO14229-1"),
                Some("SAE J1939-73"),
                Some("ISO11992-4"),
                Some("SAE J2012-DA WWH-OBD"),
                None
            ]
        );
        assert_eq!(
            parse_dtc_count(&[0x59, 0x01, 0xFF, 0x7F, 0, 0]).map(|c| c.format_name),
            Some(None)
        );
        assert!(
            parse_dtc_count(&[0x59, 0x01, 0xFF, 0x01, 0x00]).is_none(),
            "truncated"
        );
        assert!(
            parse_dtc_count(&[0x59, 0x01, 0xFF, 0x01, 0, 1, 9]).is_none(),
            "trailing"
        );
        assert!(
            parse_dtc_count(&[0x59, 0x02, 0xFF, 0x01, 0, 1]).is_none(),
            "wrong sf"
        );
        assert!(parse_dtc_count(&[0x7F, 0x19, 0x31]).is_none());
    }

    #[test]
    fn rdtci_lists_reuse_the_0x02_record_layout() {
        let body = [0xFF, 0x01, 0x23, 0x45, 0x2F, 0x9A, 0x0B, 0x00, 0x08];
        for sf in [0x02u8, 0x0A, 0x0F, 0x13, 0x15] {
            let mut pdu = vec![0x59, sf];
            pdu.extend(body);
            let l = parse_dtc_list(&pdu).unwrap_or_else(|| panic!("{sf:#04X}"));
            assert_eq!((l.sub_function, l.availability_mask), (sf, 0xFF));
            assert_eq!(l.dtcs.len(), 2);
            assert_eq!(l.dtcs[0].code, "P0123-45");
            assert_eq!(l.dtcs[1].status_byte, 0x08);
        }
        // Same records as the unchanged 0x02 parser.
        let mut pdu = vec![0x59, 0x02];
        pdu.extend(body);
        assert_eq!(
            parse_dtc_list(&pdu).map(|l| l.dtcs),
            parse_dtcs_by_status(&pdu)
        );
        assert_eq!(
            parse_dtc_list(&[0x59, 0x0A, 0x7F]).map(|l| l.dtcs.len()),
            Some(0)
        );
        assert!(
            parse_dtc_list(&[0x59, 0x0A, 0x7F, 1, 2, 3]).is_none(),
            "partial record"
        );
        assert!(parse_dtc_list(&[0x59, 0x0A]).is_none(), "no mask");
        assert!(parse_dtc_list(&[0x59, 0x04, 0x7F]).is_none());
    }

    #[test]
    fn rdtci_snapshot_identification() {
        let r = parse_dtc_snapshot_identification(&[
            0x59, 0x03, 0x01, 0x23, 0x45, 0x01, 0x9A, 0x0B, 0x00, 0x02,
        ]);
        let r = r.unwrap_or_default();
        assert_eq!(r.len(), 2);
        assert_eq!(
            (r[0].dtc, r[0].code.as_str(), r[0].record_number),
            (0x012345, "P0123-45", 1)
        );
        assert_eq!(r[1].record_number, 2);
        assert_eq!(
            parse_dtc_snapshot_identification(&[0x59, 0x03]),
            Some(vec![])
        );
        assert!(parse_dtc_snapshot_identification(&[0x59, 0x03, 1, 2, 3]).is_none());
        assert!(parse_dtc_snapshot_identification(&[0x59, 0x02]).is_none());
    }

    #[test]
    fn rdtci_snapshot_record_keeps_ambiguous_data_raw() {
        // DTC 0x012345 status 0x2F, record 01 with 1 DID F190 + 3 data bytes.
        let pdu = [
            0x59, 0x04, 0x01, 0x23, 0x45, 0x2F, 0x01, 0x01, 0xF1, 0x90, 0xA, 0xB, 0xC,
        ];
        let r = parse_dtc_snapshot_record(&pdu, Some(0x01)).unwrap_or_else(|| panic!("parse"));
        assert_eq!(r.dtc.code, "P0123-45");
        assert_eq!(r.dtc.status_byte, 0x2F);
        let rec = r.record.unwrap_or_else(|| panic!("record"));
        assert_eq!((rec.record_number, rec.number_of_identifiers), (1, 1));
        assert_eq!(rec.first_did, Some(0xF190));
        assert_eq!(rec.single_did_data, Some(vec![0xA, 0xB, 0xC]));
        assert_eq!(rec.raw, pdu[6..].to_vec());
        // All records (0xFF) or several DIDs: data boundaries unknown → raw only.
        let all = parse_dtc_snapshot_record(&pdu, Some(0xFF)).and_then(|r| r.record);
        assert_eq!(all.as_ref().map(|r| r.single_did_data.clone()), Some(None));
        assert_eq!(all.map(|r| r.first_did), Some(Some(0xF190)));
        let two = [
            0x59, 0x04, 0x01, 0x23, 0x45, 0x2F, 0x01, 0x02, 0xF1, 0x90, 0xA, 0xF1, 0x8C, 0xB,
        ];
        let rec = parse_dtc_snapshot_record(&two, Some(0x01)).and_then(|r| r.record);
        assert_eq!(
            rec.map(|r| (r.single_did_data, r.raw.len())),
            Some((None, 8))
        );
        // No snapshot stored.
        let none = parse_dtc_snapshot_record(&[0x59, 0x04, 0x01, 0x23, 0x45, 0x2F], None);
        assert_eq!(none.map(|r| r.record), Some(None));
        // numberOfIdentifiers 0 → no DID.
        let z = parse_dtc_snapshot_record(&[0x59, 0x04, 0, 0, 0, 0, 0x01, 0x00], Some(1));
        assert_eq!(z.and_then(|r| r.record).map(|r| r.first_did), Some(None));
        // Truncations.
        assert!(parse_dtc_snapshot_record(&[0x59, 0x04, 0x01, 0x23, 0x45], None).is_none());
        assert!(
            parse_dtc_snapshot_record(&[0x59, 0x04, 0x01, 0x23, 0x45, 0x2F, 0x01], None).is_none()
        );
        assert!(parse_dtc_snapshot_record(
            &[0x59, 0x04, 0x01, 0x23, 0x45, 0x2F, 0x01, 0x01, 0xF1],
            None
        )
        .is_none());
        assert!(parse_dtc_snapshot_record(&[0x59, 0x06, 0x01, 0x23, 0x45, 0x2F], None).is_none());
    }

    #[test]
    fn rdtci_ext_data_record_is_raw() {
        let pdu = [0x59, 0x06, 0x01, 0x23, 0x45, 0x2F, 0x01, 0x05, 0x10, 0x00];
        let r = parse_dtc_ext_data_record(&pdu).unwrap_or_else(|| panic!("parse"));
        assert_eq!(r.dtc.raw, 0x012345);
        assert_eq!(r.first_record_number, Some(0x01));
        assert_eq!(r.raw, vec![0x01, 0x05, 0x10, 0x00]);
        let empty = parse_dtc_ext_data_record(&[0x59, 0x06, 0x01, 0x23, 0x45, 0x2F]);
        assert_eq!(
            empty.map(|r| (r.first_record_number, r.raw.len())),
            Some((None, 0))
        );
        assert!(parse_dtc_ext_data_record(&[0x59, 0x06, 0x01, 0x23]).is_none());
    }

    #[test]
    fn rdtci_dispatcher() {
        use crate::uds::dto::ReadDtcReportDto as R;
        assert!(
            matches!(parse_read_dtc_report(&[0x59, 0x01, 0xFF, 1, 0, 3], None), Some(R::Count(c)) if c.count == 3)
        );
        assert!(matches!(
            parse_read_dtc_report(&[0x59, 0x15, 0xFF], None),
            Some(R::List(_))
        ));
        assert!(matches!(
            parse_read_dtc_report(&[0x59, 0x03], None),
            Some(R::SnapshotIdentification { .. })
        ));
        assert!(matches!(
            parse_read_dtc_report(&[0x59, 0x04, 0, 0, 1, 8], None),
            Some(R::SnapshotRecord(_))
        ));
        assert!(matches!(
            parse_read_dtc_report(&[0x59, 0x06, 0, 0, 1, 8], None),
            Some(R::ExtData(_))
        ));
        assert!(
            parse_read_dtc_report(&[0x59, 0x05], None).is_none(),
            "unsupported sf"
        );
        assert!(parse_read_dtc_report(&[0x59], None).is_none());
        assert!(parse_read_dtc_report(&[], None).is_none());
        let v = serde_json::to_value(parse_read_dtc_report(&[0x59, 0x01, 0xFF, 1, 0, 3], None))
            .unwrap_or_default();
        assert_eq!(v["kind"], "count");
        assert_eq!(v["formatName"], "ISO14229-1");
        assert_eq!(v["subFunction"], 1);
        let v =
            serde_json::to_value(parse_read_dtc_report(&[0x59, 0x03], None)).unwrap_or_default();
        assert_eq!(v["kind"], "snapshotIdentification");
        assert!(v["records"].is_array());
        // Every report kind round-trips through JSON.
        for pdu in [
            vec![0x59, 0x01, 0xFF, 1, 0, 3],
            vec![0x59, 0x02, 0xFF, 0x01, 0x23, 0x45, 0x2F],
            vec![0x59, 0x03, 0x01, 0x23, 0x45, 0x01],
            vec![
                0x59, 0x04, 0x01, 0x23, 0x45, 0x2F, 0x01, 0x01, 0xF1, 0x90, 0x0A,
            ],
            vec![0x59, 0x06, 0x01, 0x23, 0x45, 0x2F, 0x01, 0x05],
        ] {
            let r = parse_read_dtc_report(&pdu, Some(1));
            let back = serde_json::to_value(&r)
                .ok()
                .and_then(|v| serde_json::from_value::<Option<R>>(v).ok());
            assert_eq!(back, Some(r));
        }
    }

    #[test]
    fn rdtci_parsers_never_panic_on_hostile_input() {
        // xorshift64: deterministic, no extra dependency (the crate has no proptest).
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        let sfs = [
            0x01u8, 0x02, 0x03, 0x04, 0x06, 0x07, 0x0A, 0x0F, 0x11, 0x12, 0x13, 0x15, 0x05, 0xFF,
        ];
        for i in 0..20_000 {
            let len = (next() % 80) as usize;
            let mut pdu: Vec<u8> = (0..len).map(|_| next() as u8).collect();
            // Mostly well-formed headers so the bodies are exercised.
            if len >= 2 && i % 4 != 0 {
                pdu[0] = 0x59;
                pdu[1] = sfs[(next() % sfs.len() as u64) as usize];
            }
            let rec = Some(next() as u8);
            let _ = parse_read_dtc_report(&pdu, rec);
            let _ = parse_dtc_count(&pdu);
            let _ = parse_dtc_list(&pdu);
            let _ = parse_dtc_snapshot_identification(&pdu);
            let _ = parse_dtc_snapshot_record(&pdu, rec);
            let _ = parse_dtc_ext_data_record(&pdu);
            let _ = parse_dtcs_by_status(&pdu);
        }
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
        // 0x83 AccessTimingParameter (2013 edition) keeps its sub-function rule.
        assert!(request_suppresses_positive(&[0x83, 0x81]));
    }

    #[test]
    fn secured_data_transmission_has_no_sub_function() {
        // ISO 14229-1: 0x84 data starts with the security sub-layer header, not a sub-function.
        assert!(!sid_supports_suppression(0x84));
        assert!(!request_suppresses_positive(&[0x84, 0x80, 0x00, 0x01]));
        assert!(!request_suppresses_positive(&[0x84, 0xFF]));
        for first in [0x00u8, 0x01, 0x7F, 0x80, 0xC4, 0xFF] {
            let req = [0x84, first, 0x12, 0x34];
            assert!(
                response_matches(&req, &[0xC4, 0x00, 0x99]),
                "0xC4 must match 0x84 regardless of data byte {first:#04X}"
            );
            assert!(response_matches(&req, &[0xC4]));
            assert!(response_matches(&req, &[0x7F, 0x84, 0x24]));
        }
        assert!(!response_matches(&[0x84, 0x80], &[0xC5, 0x80]));
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
