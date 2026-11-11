//! Negative response code (NRC) short identifiers.
//!
//! License policy (`planning/contracts/uds-interpretation-v1.md` §1): the NRC **byte values**
//! are interoperability facts from ISO 14229-1; the identifiers below are NexusCAN's own
//! wording and are not copied from the standard's tables. Human-readable explanations live in
//! the HMI i18n catalog, keyed by these identifiers.

/// `0x78` — the ECU accepted the request and asks the tester to keep waiting (P2* applies).
pub const NRC_RESPONSE_PENDING: u8 = 0x78;

/// Our own short identifier for `nrc`, `None` when we do not name this code.
pub fn known_nrc_name(nrc: u8) -> Option<&'static str> {
    Some(match nrc {
        0x10 => "generalRejection",
        0x11 => "serviceUnsupported",
        0x12 => "subFunctionUnsupported",
        0x13 => "invalidLengthOrFormat",
        0x14 => "responseTooLarge",
        0x21 => "busyTryAgain",
        0x22 => "conditionsNotMet",
        0x24 => "wrongRequestOrder",
        0x25 => "subnetNoResponse",
        0x26 => "failureBlocksAction",
        0x31 => "requestOutOfRange",
        0x33 => "securityLocked",
        0x34 => "authenticationNeeded",
        0x35 => "wrongKey",
        0x36 => "tooManyKeyAttempts",
        0x37 => "keyDelayActive",
        0x70 => "transferRejected",
        0x71 => "transferSuspended",
        0x72 => "programmingFailure",
        0x73 => "wrongBlockCounter",
        0x78 => "responsePending",
        0x7E => "subFunctionNotInSession",
        0x7F => "serviceNotInSession",
        0x81 => "rpmTooHigh",
        0x82 => "rpmTooLow",
        0x83 => "engineRunning",
        0x84 => "engineNotRunning",
        0x85 => "engineRunTimeTooShort",
        0x86 => "temperatureTooHigh",
        0x87 => "temperatureTooLow",
        0x88 => "speedTooHigh",
        0x89 => "speedTooLow",
        0x8A => "throttleTooHigh",
        0x8B => "throttleTooLow",
        0x8C => "transmissionNotInNeutral",
        0x8D => "transmissionNotInGear",
        0x8F => "brakeNotApplied",
        0x90 => "shifterNotInPark",
        0x91 => "converterClutchLocked",
        0x92 => "voltageTooHigh",
        0x93 => "voltageTooLow",
        _ => return None,
    })
}

/// Short identifier for any NRC: our own name, or `"nrc_0xXX"` (uppercase hex) when unknown.
pub fn nrc_name(nrc: u8) -> String {
    match known_nrc_name(nrc) {
        Some(name) => name.to_string(),
        None => format!("nrc_0x{nrc:02X}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_codes_are_named() {
        for code in [
            0x10u8, 0x11, 0x12, 0x13, 0x14, 0x21, 0x22, 0x24, 0x25, 0x26, 0x31, 0x33, 0x35, 0x36,
            0x37, 0x70, 0x71, 0x72, 0x73, 0x78, 0x7E, 0x7F, 0x92, 0x93,
        ] {
            let name = known_nrc_name(code);
            assert!(name.is_some(), "NRC {code:#04x} must be named");
            let name = name.unwrap_or_default();
            assert!(!name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric()));
        }
    }

    #[test]
    fn names_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for code in 0..=255u8 {
            if let Some(name) = known_nrc_name(code) {
                assert!(seen.insert(name), "duplicate name {name}");
            }
        }
    }

    #[test]
    fn unknown_code_format() {
        assert_eq!(nrc_name(0x5A), "nrc_0x5A");
        assert_eq!(nrc_name(0x00), "nrc_0x00");
        assert_eq!(nrc_name(0xFE), "nrc_0xFE");
        assert_eq!(nrc_name(0x31), "requestOutOfRange");
        assert_eq!(nrc_name(0x78), "responsePending");
    }
}
