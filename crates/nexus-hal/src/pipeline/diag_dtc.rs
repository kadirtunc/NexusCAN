//! `cmd_diag_read_dtc_report`: ReadDTCInformation (0x19) with any supported reportType,
//! sent through the regular [`UdsSession`](nexus_protocols::uds::client::UdsSession) path
//! (same Listen-Only / Arm Active Bus / Panic Stop gates, same conversation log).
//!
//! Supported sub-functions and their request parameters (ISO 14229-1:2013 §11.3):
//!
//! | sub | reportType                                     | params                          |
//! |-----|------------------------------------------------|---------------------------------|
//! | 01  | reportNumberOfDTCByStatusMask                  | DTCStatusMask (1)               |
//! | 02  | reportDTCByStatusMask                          | DTCStatusMask (1)               |
//! | 03  | reportDTCSnapshotIdentification                | none                            |
//! | 04  | reportDTCSnapshotRecordByDTCNumber             | DTC (3) + SnapshotRecordNumber  |
//! | 06  | reportDTCExtDataRecordByDTCNumber              | DTC (3) + ExtDataRecordNumber   |
//! | 07  | reportNumberOfDTCBySeverityMaskRecord          | DTCSeverityMask + DTCStatusMask |
//! | 0A  | reportSupportedDTC                             | none                            |
//! | 0F  | reportMirrorMemoryDTCByStatusMask              | DTCStatusMask (1)               |
//! | 11  | reportNumberOfMirrorMemoryDTCByStatusMask      | DTCStatusMask (1)               |
//! | 12  | reportNumberOfEmissionsOBDDTCByStatusMask      | DTCStatusMask (1)               |
//! | 13  | reportEmissionsOBDDTCByStatusMask              | DTCStatusMask (1)               |
//! | 15  | reportDTCWithPermanentStatus                   | none                            |
//!
//! 0x15 carries NO DTCStatusMask in ISO 14229-1 (the request is `19 15`); sending a mask
//! would make a compliant ECU answer NRC 0x13 incorrectMessageLength.

use super::diag_session::invalid;
use super::*;
use crate::dto::DtcReportResultDto;
use nexus_protocols::uds::client::{nrc_name, parse_read_dtc_report};
use nexus_protocols::uds::dto::{
    DiagOrigin, DiagSessionConfigDto, UdsRequestOptionsDto, UdsResponseDto,
};

/// ReadDTCInformation service id.
pub const SID_READ_DTC_INFORMATION: u8 = 0x19;

/// Supported reportTypes (see the module table).
pub const SUPPORTED_DTC_REPORT_TYPES: [u8; 12] = [
    0x01, 0x02, 0x03, 0x04, 0x06, 0x07, 0x0A, 0x0F, 0x11, 0x12, 0x13, 0x15,
];

/// Request parameter length of reportType `sub` (`None` = unsupported).
pub fn dtc_report_param_len(sub: u8) -> Option<usize> {
    match sub {
        0x01 | 0x02 | 0x0F | 0x11 | 0x12 | 0x13 => Some(1),
        0x07 => Some(2),
        0x04 | 0x06 => Some(4),
        0x03 | 0x0A | 0x15 => Some(0),
        _ => None,
    }
}

/// Validates `sub` / `params` (exact parameter length per reportType).
pub fn validate_dtc_report_request(sub: u8, params: &[u8]) -> Result<(), DiagError> {
    let Some(len) = dtc_report_param_len(sub) else {
        return Err(invalid(format!(
            "subFunction 0x{sub:02X} is not a supported ReadDTCInformation reportType (supported: 01 02 03 04 06 07 0A 0F 11 12 13 15)"
        )));
    };
    if params.len() != len {
        let what = match sub {
            0x07 => "DTCSeverityMask + DTCStatusMask (2 bytes)",
            0x04 => "DTC (3 bytes) + DTCSnapshotRecordNumber (1 byte)",
            0x06 => "DTC (3 bytes) + DTCExtDataRecordNumber (1 byte)",
            0x03 | 0x0A | 0x15 => "no parameters",
            _ => "DTCStatusMask (1 byte)",
        };
        return Err(invalid(format!(
            "reportType 0x{sub:02X} takes {what}, got {} byte(s)",
            params.len()
        )));
    }
    Ok(())
}

/// Parses `response` of the request `19 sub params…`. Never fails: an unusable response gives
/// `(None, Some(reason))`.
pub fn dtc_report_from_response(
    sub: u8,
    params: &[u8],
    response: &UdsResponseDto,
) -> (
    Option<nexus_protocols::uds::dto::ReadDtcReportDto>,
    Option<String>,
) {
    let raw = &response.raw;
    if !response.positive {
        let reason = match response.nrc {
            Some(nrc) => format!("negative response NRC 0x{nrc:02X} ({})", nrc_name(nrc)),
            None => "negative response".to_string(),
        };
        return (None, Some(reason));
    }
    if raw.is_empty() {
        return (None, Some("no response PDU (suppressed)".to_string()));
    }
    if raw.get(1) != Some(&sub) {
        return (
            None,
            Some(format!(
                "positive response echoes reportType {}, requested 0x{sub:02X}",
                raw.get(1)
                    .map_or_else(|| "none".to_string(), |s| format!("0x{s:02X}"))
            )),
        );
    }
    let record = (sub == 0x04).then(|| params[3]);
    match parse_read_dtc_report(raw, record) {
        Some(r) => (Some(r), None),
        None => (
            None,
            Some(format!(
                "positive response of {} byte(s) could not be parsed as reportType 0x{sub:02X}",
                raw.len()
            )),
        ),
    }
}

impl PipelineEngine {
    /// `cmd_diag_read_dtc_report` → `19 <subFunction> <params…>` on the session of `config`
    /// (opened on demand like every `cmd_diag_*`). `options.origin` defaults to
    /// [`DiagOrigin::Dtc`]. BLOCKING (one UDS round trip).
    pub fn cmd_diag_read_dtc_report(
        &self,
        config: DiagSessionConfigDto,
        sub_function: u8,
        params: Vec<u8>,
        options: Option<UdsRequestOptionsDto>,
    ) -> Result<DtcReportResultDto, DiagError> {
        validate_dtc_report_request(sub_function, &params)?;
        let mut opts = options.unwrap_or_default();
        opts.origin.get_or_insert(DiagOrigin::Dtc);
        let mut payload = Vec::with_capacity(1 + params.len());
        payload.push(sub_function);
        payload.extend_from_slice(&params);
        let response =
            self.diag_session_for(&config)?
                .request(SID_READ_DTC_INFORMATION, &payload, &opts)?;
        let (report, report_error) = dtc_report_from_response(sub_function, &params, &response);
        Ok(DtcReportResultDto {
            response,
            report,
            report_error,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resp(raw: &[u8], positive: bool, nrc: Option<u8>) -> UdsResponseDto {
        UdsResponseDto {
            raw: raw.to_vec(),
            positive,
            suppressed: false,
            nrc,
            nrc_name: None,
            response_pending_count: 0,
            elapsed_us: 1,
            transaction_seq: 1,
            busy_retry_count: 0,
        }
    }

    #[test]
    fn sub_function_and_param_lengths() {
        for sub in SUPPORTED_DTC_REPORT_TYPES {
            let n = dtc_report_param_len(sub).expect("supported");
            assert!(
                validate_dtc_report_request(sub, &vec![0xFF; n]).is_ok(),
                "{sub:02X}"
            );
            assert!(validate_dtc_report_request(sub, &vec![0xFF; n + 1]).is_err());
            if n > 0 {
                assert!(validate_dtc_report_request(sub, &vec![0xFF; n - 1]).is_err());
            }
        }
        assert_eq!(dtc_report_param_len(0x07), Some(2));
        assert_eq!(dtc_report_param_len(0x04), Some(4));
        assert_eq!(dtc_report_param_len(0x15), Some(0));
        for bad in [0x00u8, 0x05, 0x08, 0x09, 0x0B, 0x14, 0x16, 0x42, 0x82] {
            let e = validate_dtc_report_request(bad, &[]).unwrap_err();
            assert_eq!(e.code, DiagErrorCode::InvalidInput, "{bad:02X}");
        }
    }

    #[test]
    fn parsing_never_errors() {
        // Positive list.
        let ok = resp(&[0x59, 0x02, 0xFF, 0x01, 0x23, 0x45, 0x2F], true, None);
        let (r, e) = dtc_report_from_response(0x02, &[0xFF], &ok);
        assert!(r.is_some() && e.is_none());
        // Negative.
        let neg = resp(&[0x7F, 0x19, 0x12], false, Some(0x12));
        let (r, e) = dtc_report_from_response(0x02, &[0xFF], &neg);
        assert!(r.is_none());
        assert!(e.unwrap().contains("0x12"));
        // Positive but truncated / malformed: report None + reason, no error.
        let bad = resp(&[0x59, 0x01, 0xFF], true, None);
        let (r, e) = dtc_report_from_response(0x01, &[0xFF], &bad);
        assert!(r.is_none());
        assert!(e.unwrap().contains("could not be parsed"));
        // Wrong reportType echo.
        let other = resp(&[0x59, 0x0A, 0xFF], true, None);
        let (r, e) = dtc_report_from_response(0x02, &[0xFF], &other);
        assert!(r.is_none() && e.unwrap().contains("echoes"));
        // Suppressed (empty).
        let (r, e) = dtc_report_from_response(0x02, &[0xFF], &resp(&[], true, None));
        assert!(r.is_none() && e.is_some());
    }

    #[test]
    fn invalid_input_precedes_any_bus_access() {
        let engine = PipelineEngine::new();
        let cfg: DiagSessionConfigDto = serde_json::from_str(
            r#"{"busId":0,"requestId":2018,"responseId":2026,"isExtendedId":false}"#,
        )
        .expect("cfg");
        let e = engine
            .cmd_diag_read_dtc_report(cfg.clone(), 0x05, vec![], None)
            .unwrap_err();
        assert_eq!(e.code, DiagErrorCode::InvalidInput);
        let e = engine
            .cmd_diag_read_dtc_report(cfg.clone(), 0x02, vec![], None)
            .unwrap_err();
        assert_eq!(e.code, DiagErrorCode::InvalidInput);
        let e = engine
            .cmd_diag_read_dtc_report(cfg, 0x02, vec![0xFF], None)
            .unwrap_err();
        assert_eq!(e.code, DiagErrorCode::BusNotConnected);
    }
}
