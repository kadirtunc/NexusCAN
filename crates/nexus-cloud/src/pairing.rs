//! Desktop Device Pairing (`NXC-XXXX-XXXX`) validator, redacted `nxc_tok_...`
//! API token credential wrapper, and pairing workflow state machine.

use core::fmt;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const PAIRING_PREFIX: &str = "NXC-";
pub const DEVICE_TOKEN_PREFIX: &str = "nxc_tok_";

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PairingError {
    #[error("Pairing code '{0}' must match exact format NXC-XXXX-XXXX (uppercase A-Z, 0-9)")]
    InvalidPairingCodeFormat(String),

    #[error("Device API token must start with 'nxc_tok_' and have at least 16 characters")]
    InvalidDeviceTokenFormat,

    #[error("Invalid pairing state transition from {from} via {event}")]
    InvalidTransition {
        from: &'static str,
        event: &'static str,
    },
}

/// Validated `NXC-XXXX-XXXX` 8-character short-lived device pairing code.
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PairingCode(String);

impl PairingCode {
    /// Validates and normalizes a pairing code string (e.g. `"nxc-9f3a-7b2c"` -> `"NXC-9F3A-7B2C"`).
    pub fn parse(raw: &str) -> Result<Self, PairingError> {
        let normalized = raw.trim().to_ascii_uppercase();
        let bytes = normalized.as_bytes();
        // Exact length: "NXC-" (4) + 4 chars + "-" (1) + 4 chars = 13 bytes
        if bytes.len() != 13 || !normalized.starts_with(PAIRING_PREFIX) || bytes[8] != b'-' {
            return Err(PairingError::InvalidPairingCodeFormat(raw.to_string()));
        }

        let group_a_valid = bytes[4..8]
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
        let group_b_valid = bytes[9..13]
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());

        if !group_a_valid || !group_b_valid {
            return Err(PairingError::InvalidPairingCodeFormat(raw.to_string()));
        }

        Ok(Self(normalized))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for PairingCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PairingCode({})", self.0)
    }
}

impl fmt::Display for PairingCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Revocable device API token (`nxc_tok_...`) with redacted `Debug` & `Display`
/// implementations so raw bearer secrets never leak into terminal or file logs.
#[derive(Clone, PartialEq, Eq)]
pub struct DeviceApiToken {
    raw: String,
}

impl DeviceApiToken {
    pub fn parse(raw: impl Into<String>) -> Result<Self, PairingError> {
        let s = raw.into().trim().to_string();
        if !s.starts_with(DEVICE_TOKEN_PREFIX) || s.len() < 16 {
            return Err(PairingError::InvalidDeviceTokenFormat);
        }
        if !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(PairingError::InvalidDeviceTokenFormat);
        }
        Ok(Self { raw: s })
    }

    /// Returns the non-sensitive token prefix (e.g. `"nxc_tok_9f3a..."`) for UI display.
    pub fn redacted_prefix(&self) -> String {
        let visible_len = self.raw.len().min(12);
        format!("{}...", &self.raw[..visible_len])
    }

    /// Formats the HTTP `Authorization` header value (`"Bearer nxc_tok_..."`).
    pub fn bearer_header_value(&self) -> String {
        format!("Bearer {}", self.raw)
    }

    /// Exposes the raw token solely for authenticated TLS/WS transport handshakes.
    pub fn expose_secret(&self) -> &str {
        &self.raw
    }
}

impl fmt::Debug for DeviceApiToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DeviceApiToken({}[REDACTED])", self.redacted_prefix())
    }
}

impl fmt::Display for DeviceApiToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}[REDACTED]", self.redacted_prefix())
    }
}

/// Lifecycle state of the desktop device pairing workflow.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DevicePairingState {
    Unpaired,
    PendingApproval {
        pairing_code: PairingCode,
        poll_token: String,
        expires_in_sec: u32,
    },
    Paired {
        device_id: String,
        project_id: String,
        token: DeviceApiToken,
    },
    Expired,
    Revoked {
        reason: String,
    },
}

impl DevicePairingState {
    pub fn begin_pairing(
        &mut self,
        raw_code: &str,
        poll_token: impl Into<String>,
        expires_in_sec: u32,
    ) -> Result<PairingCode, PairingError> {
        let code = PairingCode::parse(raw_code)?;
        *self = Self::PendingApproval {
            pairing_code: code.clone(),
            poll_token: poll_token.into(),
            expires_in_sec,
        };
        Ok(code)
    }

    pub fn complete_approval(
        &mut self,
        device_id: impl Into<String>,
        project_id: impl Into<String>,
        raw_token: impl Into<String>,
    ) -> Result<(), PairingError> {
        if !matches!(self, Self::PendingApproval { .. } | Self::Unpaired) {
            return Err(PairingError::InvalidTransition {
                from: self.state_name(),
                event: "complete_approval",
            });
        }
        let token = DeviceApiToken::parse(raw_token)?;
        *self = Self::Paired {
            device_id: device_id.into(),
            project_id: project_id.into(),
            token,
        };
        Ok(())
    }

    pub fn mark_expired(&mut self) {
        *self = Self::Expired;
    }

    pub fn mark_revoked(&mut self, reason: impl Into<String>) {
        *self = Self::Revoked {
            reason: reason.into(),
        };
    }

    pub fn state_name(&self) -> &'static str {
        match self {
            Self::Unpaired => "Unpaired",
            Self::PendingApproval { .. } => "PendingApproval",
            Self::Paired { .. } => "Paired",
            Self::Expired => "Expired",
            Self::Revoked { .. } => "Revoked",
        }
    }
}
