//! UDS ECU discovery via functional addressing — pure logic, no I/O.
//!
//! The HAL (`PipelineEngine::cmd_diag_discover_ecus`) opens a short-lived diag tap, sends ONE
//! single-frame functional request (any UDS PDU, default `3E 00`; see [`validate_request_pdu`])
//! and feeds every received frame of a
//! fixed collection window into a [`DiscoveryCollector`]. Discovery never sends Flow Control:
//! multi-frame answers are only recorded (`multiFrame = true`, `raw` = first-frame bytes).
//!
//! Not a hot path (user-triggered control plane): heap use is fine here.

use std::collections::BTreeMap;

use super::client::nrc_name;
use super::dto::{DiscoveredEcuDto, EcuDiscoveryResultDto};

/// Default functional request PDU when `requestPdu` is omitted: TesterPresent `3E 00`.
pub const DEFAULT_DISCOVERY_PDU: [u8; 2] = [0x3E, 0x00];
/// Max UDS payload of a classic CAN single frame (`0x0N`, N = 1..=7).
pub const MAX_CLASSIC_SF_PDU: usize = 7;
/// Max UDS payload of a CAN-FD escape single frame (`00 len`, 64 - 2).
pub const MAX_FD_SF_PDU: usize = 62;

/// Services whose first data byte is a sub-function carrying the suppressPosRspMsgIndicationBit
/// (ISO 14229-1; same set as the UDS client's suppression rule, superset of
/// 0x10/0x11/0x27/0x28/0x31/0x3E/0x85/0x87).
fn sid_supports_suppression(sid: u8) -> bool {
    matches!(
        sid,
        0x10 | 0x11 | 0x27 | 0x28 | 0x29 | 0x2C | 0x31 | 0x3E | 0x83 | 0x84 | 0x85 | 0x86 | 0x87
    )
}

/// Validates a functional discovery request PDU. ISO 15765-2: functional requests are
/// single-frame only (classic 1..=7 bytes, CAN-FD 1..=62 bytes). A request with the
/// suppressPosRspMsgIndicationBit set is rejected (healthy ECUs would stay silent).
pub fn validate_request_pdu(pdu: &[u8], use_fd: bool) -> Result<(), String> {
    let max = if use_fd {
        MAX_FD_SF_PDU
    } else {
        MAX_CLASSIC_SF_PDU
    };
    if pdu.is_empty() || pdu.len() > max {
        return Err(format!(
            "requestPdu must be 1..={max} bytes: functional requests are ISO-TP single frames only ({} CAN, got {} bytes)",
            if use_fd { "CAN-FD" } else { "classic" },
            pdu.len()
        ));
    }
    if let [sid, sub, ..] = pdu {
        if sid_supports_suppression(*sid) && sub & 0x80 != 0 {
            return Err(format!(
                "requestPdu {sid:02X} {sub:02X} sets the suppressPosRspMsgIndicationBit: ECUs would not answer positively, discovery needs a response (clear bit 0x80 of the sub-function)"
            ));
        }
    }
    Ok(())
}

/// Builds the single-frame CAN payload for `pdu` (already validated with
/// [`validate_request_pdu`]): classic `0x0N` PCI for 1..=7 bytes, CAN-FD escape `00 len` above.
/// With `padding` the frame is filled to 8 bytes (classic PCI) or to the next valid CAN-FD
/// length (escape PCI); without padding the frame length is exactly PCI + PDU.
pub fn build_single_frame(pdu: &[u8], padding: Option<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    if pdu.len() <= MAX_CLASSIC_SF_PDU {
        out.push(pdu.len() as u8);
    } else {
        out.push(0x00);
        out.push(pdu.len() as u8);
    }
    out.extend_from_slice(pdu);
    if let Some(p) = padding {
        let target = if out.len() <= 8 {
            8
        } else {
            fd_len_at_least(out.len())
        };
        out.resize(target, p);
    }
    out
}

/// Smallest valid CAN-FD payload length >= `n` (n <= 64).
fn fd_len_at_least(n: usize) -> usize {
    const LENS: [usize; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
    LENS.into_iter().find(|&l| l >= n).unwrap_or(64)
}

/// Physical request id belonging to a response id.
///
/// * 11-bit: OBD/UDS legislated range `0x7E8..=0x7EF` → `response - 8`.
/// * 29-bit normal-fixed `0x18DA_TA_SA` (any priority bits above 0x1FFF_0000 masked off is NOT
///   applied: `(resp & 0x1FFF_0000) == 0x18DA_0000`) → `0x18DA_{SA}_{TA}`.
/// * Anything else → `None`.
pub fn derive_physical_request_id(response_id: u32, extended: bool) -> Option<u32> {
    if extended {
        if response_id > 0x1FFF_FFFF || (response_id & 0x1FFF_0000) != 0x18DA_0000 {
            return None;
        }
        let ta = (response_id >> 8) & 0xFF;
        let sa = response_id & 0xFF;
        Some(0x18DA_0000 | (sa << 8) | ta)
    } else if (0x7E8..=0x7EF).contains(&response_id) {
        Some(response_id - 8)
    } else {
        None
    }
}

/// Default response acceptance filter `(id, mask)`:
/// 11-bit → `0x7E8 / 0x7F8` (0x7E8..=0x7EF); 29-bit → `0x18DAF100 / 0x1FFFFF00` (any SA → tester 0xF1).
pub fn default_response_filter(extended: bool) -> (u32, u32) {
    if extended {
        (0x18DA_F100, 0x1FFF_FF00)
    } else {
        (0x7E8, 0x7F8)
    }
}

/// ISO-TP PCI class of ONE CAN frame payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PciClass<'a> {
    /// Single Frame (classic `0x0N` or CAN-FD escape `0x00 len`): the UDS payload.
    Single(&'a [u8]),
    /// First Frame of a multi-frame message: announced length + data bytes in this frame.
    FirstFrame { total_len: u32, first: &'a [u8] },
    /// Consecutive / Flow Control / malformed / empty.
    Ignore,
}

/// Classifies `data` (the CAN payload, DLC bytes) by its ISO-TP PCI.
pub fn classify_pci(data: &[u8]) -> PciClass<'_> {
    let Some(&b0) = data.first() else {
        return PciClass::Ignore;
    };
    match b0 >> 4 {
        0x0 => {
            let n = usize::from(b0 & 0x0F);
            if n != 0 {
                // Classic SF: 1..=7 bytes (also valid inside an FD frame).
                if n <= 7 && data.len() > n {
                    PciClass::Single(&data[1..=n])
                } else {
                    PciClass::Ignore
                }
            } else {
                // CAN-FD escape SF: `00 len`, len 1..=62.
                match data.get(1) {
                    Some(&len) if len != 0 && data.len() >= 2 + usize::from(len) => {
                        PciClass::Single(&data[2..2 + usize::from(len)])
                    }
                    _ => PciClass::Ignore,
                }
            }
        }
        0x1 => {
            if data.len() < 2 {
                return PciClass::Ignore;
            }
            let short = (u32::from(b0 & 0x0F) << 8) | u32::from(data[1]);
            if short != 0 {
                PciClass::FirstFrame {
                    total_len: short,
                    first: &data[2..],
                }
            } else {
                // Escape FF (> 4095 bytes): 32-bit length in bytes 2..6.
                if data.len() < 6 {
                    return PciClass::Ignore;
                }
                let total = u32::from_be_bytes([data[2], data[3], data[4], data[5]]);
                if total == 0 {
                    PciClass::Ignore
                } else {
                    PciClass::FirstFrame {
                        total_len: total,
                        first: &data[6..],
                    }
                }
            }
        }
        _ => PciClass::Ignore,
    }
}

/// What a frame meant to the collector (tests / diagnostics).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameVerdict {
    /// Our own request (or another tester) on the functional id — silently skipped.
    FunctionalEcho,
    /// Counted in `ignored_frames`.
    Ignored,
    /// Final positive / negative response (SF or FF).
    Response,
    /// `7F sid 78` responsePending.
    Pending,
}

const NRC_RESPONSE_PENDING: u8 = 0x78;

struct Slot {
    dto: DiscoveredEcuDto,
    final_seen: bool,
}

/// Aggregates the responses of one functional discovery window (one entry per response id).
pub struct DiscoveryCollector {
    sid: u8,
    functional_id: u32,
    extended: bool,
    tx_timestamp_us: u64,
    ecus: BTreeMap<u32, Slot>,
    ignored: u32,
}

impl DiscoveryCollector {
    /// `sid` = first byte of the request PDU; `tx_timestamp_us` = HAL timestamp of the
    /// confirmed functional request.
    pub fn new(sid: u8, functional_id: u32, extended: bool, tx_timestamp_us: u64) -> Self {
        Self {
            sid,
            functional_id,
            extended,
            tx_timestamp_us,
            ecus: BTreeMap::new(),
            ignored: 0,
        }
    }

    /// Frames counted as ignored so far.
    pub fn ignored_frames(&self) -> u32 {
        self.ignored
    }

    /// Counts a frame that could not even be handed to [`Self::on_frame`] (e.g. seen before
    /// the request was confirmed).
    pub fn note_ignored(&mut self) {
        self.ignored = self.ignored.saturating_add(1);
    }

    /// Feeds one received frame (`data` = CAN payload, `rtr` frames must be passed as ignored
    /// by the caller or with empty data).
    pub fn on_frame(
        &mut self,
        arb_id: u32,
        extended: bool,
        timestamp_us: u64,
        data: &[u8],
    ) -> FrameVerdict {
        if extended == self.extended && arb_id == self.functional_id {
            return FrameVerdict::FunctionalEcho;
        }
        if extended != self.extended {
            self.note_ignored();
            return FrameVerdict::Ignored;
        }
        let pos_sid = self.sid.wrapping_add(0x40);
        let (pdu, multi) = match classify_pci(data) {
            PciClass::Single(p) => (p, false),
            PciClass::FirstFrame { first, .. } => (first, true),
            PciClass::Ignore => {
                self.note_ignored();
                return FrameVerdict::Ignored;
            }
        };
        let (positive, nrc) = match pdu {
            [s, ..] if *s == pos_sid => (true, None),
            [0x7F, s, nrc, ..] if *s == self.sid => (false, Some(*nrc)),
            _ => {
                self.note_ignored();
                return FrameVerdict::Ignored;
            }
        };
        let is_pending = nrc == Some(NRC_RESPONSE_PENDING) && !multi;

        let tx_ts = self.tx_timestamp_us;
        let slot = self.ecus.entry(arb_id).or_insert_with(|| Slot {
            dto: DiscoveredEcuDto {
                response_id: arb_id,
                request_id: derive_physical_request_id(arb_id, extended),
                is_extended_id: extended,
                positive: false,
                nrc: None,
                nrc_name: None,
                pending: false,
                raw: Vec::new(),
                multi_frame: false,
                first_response_us: timestamp_us.saturating_sub(tx_ts),
                response_count: 0,
                vin: None,
                serial_number: None,
                part_number: None,
                identify_error: None,
            },
            final_seen: false,
        });
        let d = &mut slot.dto;
        d.response_count = d.response_count.saturating_add(1);
        if is_pending {
            d.pending = true;
            if !slot.final_seen {
                // Interim state until (if ever) the final response arrives in the window.
                d.positive = false;
                d.nrc = nrc;
                d.nrc_name = nrc.map(nrc_name);
                d.raw = pdu.to_vec();
            }
            return FrameVerdict::Pending;
        }
        slot.final_seen = true;
        d.positive = positive;
        d.nrc = nrc;
        d.nrc_name = nrc.map(nrc_name);
        d.raw = pdu.to_vec();
        d.multi_frame = multi;
        FrameVerdict::Response
    }

    /// Builds the result (ECUs sorted by response id).
    pub fn finish(self, request_bytes: Vec<u8>, window_ms: u32) -> EcuDiscoveryResultDto {
        EcuDiscoveryResultDto {
            request_bytes,
            functional_id: self.functional_id,
            is_extended_id: self.extended,
            window_ms,
            tx_timestamp_us: self.tx_timestamp_us,
            ecus: self.ecus.into_values().map(|s| s.dto).collect(),
            ignored_frames: self.ignored,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_pdu_validation() {
        assert!(validate_request_pdu(&DEFAULT_DISCOVERY_PDU, false).is_ok());
        assert!(validate_request_pdu(&[0x22, 0xF1, 0x90], false).is_ok());
        assert!(validate_request_pdu(&[0x01, 0x00], false).is_ok());
        assert!(validate_request_pdu(&[1, 2, 3, 4, 5, 6, 7], false).is_ok());
        assert!(validate_request_pdu(&[], false).is_err());
        assert!(validate_request_pdu(&[1, 2, 3, 4, 5, 6, 7, 8], false).is_err());
        assert!(validate_request_pdu(&[0x22; 62], true).is_ok());
        assert!(validate_request_pdu(&[0x22; 63], true).is_err());
        // suppressPosRspMsgIndicationBit on sub-function services
        for sid in [0x10u8, 0x11, 0x27, 0x28, 0x31, 0x3E, 0x85, 0x87] {
            let e = validate_request_pdu(&[sid, 0x80], false).unwrap_err();
            assert!(e.contains("suppressPosRspMsgIndicationBit"), "{e}");
        }
        // 0x22 / 0x19 have no suppression bit semantics
        assert!(validate_request_pdu(&[0x22, 0xF1, 0x90], false).is_ok());
        assert!(validate_request_pdu(&[0x19, 0x82, 0xFF], false).is_ok());
    }

    #[test]
    fn single_frame_building() {
        assert_eq!(
            build_single_frame(&[0x3E, 0x00], Some(0xAA)),
            vec![0x02, 0x3E, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA]
        );
        assert_eq!(
            build_single_frame(&[0x3E, 0x00], None),
            vec![0x02, 0x3E, 0x00]
        );
        let f = build_single_frame(&[0x22; 10], Some(0xCC));
        assert_eq!(&f[..2], &[0x00, 0x0A]);
        assert_eq!(f.len(), 12);
        assert_eq!(f[11], 0x22);
        let f = build_single_frame(&[0x22; 11], Some(0xCC));
        assert_eq!(f.len(), 16);
        assert_eq!(f[15], 0xCC);
        assert_eq!(build_single_frame(&[0x22; 10], None).len(), 12);
        assert_eq!(
            classify_pci(build_single_frame(&[0x22; 62], Some(0)).as_slice()),
            PciClass::Single(&[0x22; 62])
        );
    }

    #[test]
    fn derive_std_bounds() {
        assert_eq!(derive_physical_request_id(0x7E8, false), Some(0x7E0));
        assert_eq!(derive_physical_request_id(0x7EF, false), Some(0x7E7));
        assert_eq!(derive_physical_request_id(0x7E7, false), None);
        assert_eq!(derive_physical_request_id(0x7F0, false), None);
        assert_eq!(derive_physical_request_id(0x18DA_F110, false), None);
    }

    #[test]
    fn derive_ext_normal_fixed() {
        assert_eq!(
            derive_physical_request_id(0x18DA_F110, true),
            Some(0x18DA_10F1)
        );
        assert_eq!(
            derive_physical_request_id(0x18DA_F1FF, true),
            Some(0x18DA_FFF1)
        );
        assert_eq!(
            derive_physical_request_id(0x18DA_0000, true),
            Some(0x18DA_0000)
        );
        // functional (0x18DB) and other PGNs are not physical responses
        assert_eq!(derive_physical_request_id(0x18DB_33F1, true), None);
        assert_eq!(derive_physical_request_id(0x1CDA_F110, true), None);
        // 11-bit range never matches in 29-bit mode, out-of-range id rejected
        assert_eq!(derive_physical_request_id(0x7E8, true), None);
        assert_eq!(derive_physical_request_id(0x38DA_F110, true), None);
    }

    #[test]
    fn default_filters() {
        assert_eq!(default_response_filter(false), (0x7E8, 0x7F8));
        assert_eq!(default_response_filter(true), (0x18DA_F100, 0x1FFF_FF00));
        let (id, mask) = default_response_filter(false);
        for r in 0x7E8..=0x7EF {
            assert_eq!(r & mask, id & mask);
        }
        assert_ne!(0x7E7 & mask, id & mask);
        assert_ne!(0x7F0 & mask, id & mask);
    }

    #[test]
    fn classify_single_frames() {
        assert_eq!(
            classify_pci(&[0x02, 0x7E, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA]),
            PciClass::Single(&[0x7E, 0x00])
        );
        assert_eq!(
            classify_pci(&[0x07, 1, 2, 3, 4, 5, 6, 7]),
            PciClass::Single(&[1, 2, 3, 4, 5, 6, 7])
        );
        // unpadded, exact length
        assert_eq!(
            classify_pci(&[0x03, 0x7F, 0x3E, 0x12]),
            PciClass::Single(&[0x7F, 0x3E, 0x12])
        );
        // length larger than the frame
        assert_eq!(classify_pci(&[0x05, 0x7E, 0x00]), PciClass::Ignore);
        // classic SF length > 7 is invalid
        assert_eq!(
            classify_pci(&[0x08, 1, 2, 3, 4, 5, 6, 7, 8]),
            PciClass::Ignore
        );
    }

    #[test]
    fn classify_fd_escape() {
        let mut f = [0xCCu8; 12];
        f[0] = 0x00;
        f[1] = 0x0A;
        assert_eq!(classify_pci(&f), PciClass::Single(&f[2..12]));
        // escape with length 0 or exceeding the frame
        assert_eq!(classify_pci(&[0x00, 0x00, 1, 2]), PciClass::Ignore);
        assert_eq!(classify_pci(&[0x00, 0x05, 1, 2]), PciClass::Ignore);
        assert_eq!(classify_pci(&[0x00]), PciClass::Ignore);
    }

    #[test]
    fn classify_first_frames_and_others() {
        assert_eq!(
            classify_pci(&[0x10, 0x14, 0x62, 0xF1, 0x90, 0x57, 0x4E, 0x58]),
            PciClass::FirstFrame {
                total_len: 0x14,
                first: &[0x62, 0xF1, 0x90, 0x57, 0x4E, 0x58]
            }
        );
        assert_eq!(
            classify_pci(&[0x1F, 0xFF, 1, 2]),
            PciClass::FirstFrame {
                total_len: 0xFFF,
                first: &[1, 2]
            }
        );
        assert_eq!(
            classify_pci(&[0x10, 0x00, 0x00, 0x01, 0x00, 0x00, 0x62, 0x01]),
            PciClass::FirstFrame {
                total_len: 0x1_0000,
                first: &[0x62, 0x01]
            }
        );
        assert_eq!(classify_pci(&[0x10, 0x00, 0x00, 0x00]), PciClass::Ignore);
        assert_eq!(
            classify_pci(&[0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x62]),
            PciClass::Ignore
        );
        assert_eq!(classify_pci(&[0x10]), PciClass::Ignore);
        assert_eq!(classify_pci(&[0x21, 1, 2, 3]), PciClass::Ignore); // CF
        assert_eq!(classify_pci(&[0x30, 0x00, 0x00]), PciClass::Ignore); // FC
        assert_eq!(classify_pci(&[]), PciClass::Ignore);
    }

    fn sf(pdu: &[u8]) -> [u8; 8] {
        let mut f = [0xAAu8; 8];
        f[0] = pdu.len() as u8;
        f[1..=pdu.len()].copy_from_slice(pdu);
        f
    }

    #[test]
    fn collector_aggregates_multiple_ecus_sorted() {
        let mut c = DiscoveryCollector::new(0x3E, 0x7DE, false, 1_000);
        assert_eq!(
            c.on_frame(0x7DE, false, 1_001, &sf(&[0x3E, 0x00])),
            FrameVerdict::FunctionalEcho
        );
        assert_eq!(
            c.on_frame(0x7EE, false, 1_900, &sf(&[0x7E, 0x00])),
            FrameVerdict::Response
        );
        assert_eq!(
            c.on_frame(0x7EA, false, 1_500, &sf(&[0x7E, 0x00])),
            FrameVerdict::Response
        );
        assert_eq!(
            c.on_frame(0x7EA, false, 1_700, &sf(&[0x7E, 0x00])),
            FrameVerdict::Response
        );
        assert_eq!(
            c.on_frame(0x7EC, false, 1_600, &sf(&[0x62, 0xF1])),
            FrameVerdict::Ignored
        );
        assert_eq!(
            c.on_frame(0x7EC, false, 1_600, &[0x21, 1, 2]),
            FrameVerdict::Ignored
        );
        assert_eq!(
            c.on_frame(0x7EC, true, 1_600, &sf(&[0x7E, 0x00])),
            FrameVerdict::Ignored
        );
        let r = c.finish(vec![0x02, 0x3E, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA], 300);
        assert_eq!(r.ignored_frames, 3);
        assert_eq!(r.ecus.len(), 2);
        assert_eq!(r.ecus[0].response_id, 0x7EA);
        assert_eq!(r.ecus[0].request_id, Some(0x7E2));
        assert_eq!(r.ecus[0].response_count, 2);
        assert_eq!(r.ecus[0].first_response_us, 500);
        assert!(r.ecus[0].positive);
        assert_eq!(r.ecus[0].raw, vec![0x7E, 0x00]);
        assert_eq!(r.ecus[1].response_id, 0x7EE);
        assert_eq!(r.ecus[1].request_id, Some(0x7E6));
        assert_eq!(r.ecus[1].first_response_us, 900);
    }

    #[test]
    fn collector_pending_then_final_and_negative() {
        let mut c = DiscoveryCollector::new(0x10, 0x18DB_33F1, true, 10);
        assert_eq!(
            c.on_frame(0x18DA_F110, true, 20, &sf(&[0x7F, 0x10, 0x78])),
            FrameVerdict::Pending
        );
        assert_eq!(
            c.on_frame(
                0x18DA_F110,
                true,
                90,
                &sf(&[0x50, 0x01, 0x00, 0x32, 0x01, 0xF4])
            ),
            FrameVerdict::Response
        );
        assert_eq!(
            c.on_frame(0x18DA_F120, true, 30, &sf(&[0x7F, 0x10, 0x22])),
            FrameVerdict::Response
        );
        assert_eq!(
            c.on_frame(0x18DA_F130, true, 40, &sf(&[0x7F, 0x10, 0x78])),
            FrameVerdict::Pending
        );
        // wrong SID in a negative response
        assert_eq!(
            c.on_frame(0x18DA_F140, true, 40, &sf(&[0x7F, 0x22, 0x31])),
            FrameVerdict::Ignored
        );
        let r = c.finish(vec![], 300);
        assert_eq!(r.ecus.len(), 3);
        let a = &r.ecus[0];
        assert!(a.positive && a.pending && a.nrc.is_none() && a.nrc_name.is_none());
        assert_eq!(a.response_count, 2);
        assert_eq!(a.first_response_us, 10);
        assert_eq!(a.request_id, Some(0x18DA_10F1));
        let b = &r.ecus[1];
        assert!(!b.positive && !b.pending);
        assert_eq!(b.nrc, Some(0x22));
        assert!(b.nrc_name.is_some());
        let p = &r.ecus[2];
        assert!(!p.positive && p.pending);
        assert_eq!(p.nrc, Some(0x78));
        assert_eq!(p.raw, vec![0x7F, 0x10, 0x78]);
        assert_eq!(r.ignored_frames, 1);
    }

    #[test]
    fn collector_records_first_frame_and_fd_escape() {
        let mut c = DiscoveryCollector::new(0x01, 0x7DF, false, 0);
        assert_eq!(
            c.on_frame(
                0x7E8,
                false,
                5,
                &[0x10, 0x0A, 0x41, 0x00, 0xBE, 0x3E, 0xB8, 0x11]
            ),
            FrameVerdict::Response
        );
        let mut fd = [0xAAu8; 12];
        fd[..8].copy_from_slice(&[0x00, 0x06, 0x41, 0x00, 0x98, 0x18, 0x80, 0x13]);
        assert_eq!(c.on_frame(0x7E9, false, 7, &fd), FrameVerdict::Response);
        // empty / short frames
        assert_eq!(c.on_frame(0x7EA, false, 7, &[]), FrameVerdict::Ignored);
        assert_eq!(c.on_frame(0x7EA, false, 7, &[0x01]), FrameVerdict::Ignored);
        assert_eq!(
            c.on_frame(0x7EA, false, 7, &[0x01, 0x7F]),
            FrameVerdict::Ignored
        );
        let r = c.finish(vec![], 50);
        assert_eq!(r.ecus.len(), 2);
        assert!(r.ecus[0].multi_frame && r.ecus[0].positive);
        assert_eq!(r.ecus[0].raw, vec![0x41, 0x00, 0xBE, 0x3E, 0xB8, 0x11]);
        assert!(!r.ecus[1].multi_frame && r.ecus[1].positive);
        assert_eq!(r.ecus[1].raw, vec![0x41, 0x00, 0x98, 0x18, 0x80, 0x13]);
        assert_eq!(r.ignored_frames, 3);
    }
}
