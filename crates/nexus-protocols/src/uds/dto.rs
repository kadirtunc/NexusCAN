//! `cmd_diag_*` IPC DTOs (D-003 contract v1, FROZEN). TS mirror: `src/types/udsClient.ts`.
//! Not a hot path: one request per user action / poll tick.

use serde::{Deserialize, Serialize};

/// Identifies one diagnostic target (tester ↔ ECU addressing on one bus).
/// Field names are a superset of the existing HMI `DiagSessionConfig`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagSessionConfigDto {
    pub bus_id: u8,
    /// Tester → ECU (physical request) CAN id.
    pub request_id: u32,
    /// ECU → tester CAN id.
    pub response_id: u32,
    pub is_extended_id: bool,
    /// HMI field, informational (`"uds"` today).
    #[serde(default)]
    pub protocol: Option<String>,
    /// Functional request id (e.g. 0x7DF). Flow Control for functional requests still uses `request_id`.
    #[serde(default)]
    pub functional_id: Option<u32>,
    /// Send ISO-TP frames as CAN-FD (requires an FD-enabled channel).
    #[serde(default)]
    pub use_fd: bool,
    /// ISO-TP padding byte; `None` = no padding (DLC = payload length).
    #[serde(default = "default_padding")]
    pub padding: Option<u8>,
    /// P2 client margin added on top of the ECU-reported P2 (ms). Default 100.
    #[serde(default = "default_p2_margin")]
    pub p2_margin_ms: u32,
}

fn default_padding() -> Option<u8> {
    Some(0xAA)
}
fn default_p2_margin() -> u32 {
    100
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UdsAddressing {
    Physical,
    Functional,
}

/// Which HMI feature issued a request (Diagnostics Traffic Dock grouping / filtering).
/// Copied from the `request` event onto every event of the same transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagOrigin {
    Console,
    Did,
    Dtc,
    Pids,
    Panel,
    Flow,
    Session,
    Keepalive,
    #[default]
    Other,
}

/// Request options for `cmd_diag_send_uds`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UdsRequestOptionsDto {
    #[serde(default)]
    pub addressing: Option<UdsAddressing>,
    /// Override total request timeout (ms). Default: P2 + margin, extended by 0x78 up to P2*.
    #[serde(default)]
    pub timeout_ms: Option<u32>,
    /// Request origin tag; `None` → [`DiagOrigin::Other`].
    #[serde(default)]
    pub origin: Option<DiagOrigin>,
}

/// Result of one UDS request. A negative response (0x7F) is a SUCCESSFUL transport
/// result with `positive = false`; only transport-level failures are errors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UdsResponseDto {
    /// Full response PDU, e.g. `[0x62, 0xF1, 0x90, ...]` or `[0x7F, 0x22, 0x31]`.
    /// Empty when the request had the suppress-positive-response bit and the ECU stayed silent.
    pub raw: Vec<u8>,
    pub positive: bool,
    pub suppressed: bool,
    pub nrc: Option<u8>,
    /// Our own short NRC identifier (e.g. `"requestOutOfRange"`), `None` for positive.
    pub nrc_name: Option<String>,
    /// Number of 0x78 responsePending received before the final response.
    pub response_pending_count: u32,
    /// Request TX confirmation → final response, microseconds.
    pub elapsed_us: u64,
    /// Conversation log sequence number of the request event.
    pub transaction_seq: u64,
}

/// `cmd_diag_read_did` result (kept compatible with the existing HMI shape).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DidReadResultDto {
    pub did: u16,
    /// Data record ONLY (without `0x62` and the 2 DID bytes).
    pub raw: Vec<u8>,
    /// Printable ASCII when all bytes are printable (trailing 0x00/0xFF/0x20 trimmed), else uppercase hex.
    pub decoded: String,
    pub transaction_seq: u64,
}

/// One DTC from 0x19 0x02 (kept compatible with the existing HMI `DtcEntryDto`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DtcEntryDto {
    /// ISO 15031-6 / SAE J2012 style display code + failure type byte, e.g. `"P0123-45"`.
    pub code: String,
    /// 24-bit DTC number.
    pub raw: u32,
    pub status_byte: u8,
    /// status bit 3
    pub is_confirmed: bool,
    /// status bit 2
    pub is_pending: bool,
    /// status bit 7 (warningIndicatorRequested)
    pub is_mil_on: bool,
    /// Only from user-provided sources (license policy). Backend leaves `None`.
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationEventKind {
    Request,
    Response,
    ResponsePending,
    Timeout,
    TxBlocked,
    TransportError,
    StaleResponseDropped,
    KeepaliveSent,
    SessionClosed,
}

/// Conversation log entry. Basis of the interpretation layer
/// (`planning/contracts/uds-interpretation-v1.md`). Timestamps are HAL timestamps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationEventDto {
    /// Monotonic per session, starts at 1.
    pub seq: u64,
    pub timestamp_us: u64,
    pub kind: ConversationEventKind,
    pub addressing: UdsAddressing,
    /// Request SID this event belongs to (for responses: the original request SID).
    pub sid: Option<u8>,
    /// PDU bytes (request, response, pending) — empty for timeouts etc.
    pub bytes: Vec<u8>,
    /// `seq` of the request this event answers, if any.
    pub request_seq: Option<u64>,
    pub elapsed_us: Option<u64>,
    pub nrc: Option<u8>,
    /// Short machine-readable detail (e.g. reject reason, timeout phase `"p2"`/`"p2_star"`/`"isotp"`).
    pub detail: Option<String>,
    /// Origin of the transaction (from the request; `keepalive` for TesterPresent events,
    /// `other` for session / unsolicited events).
    pub origin: DiagOrigin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPageDto {
    pub events: Vec<ConversationEventDto>,
    /// Pass as `sinceSeq` next time.
    pub last_seq: u64,
    /// `true` when the ring buffer overwrote events older than `sinceSeq`.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagSessionInfoDto {
    pub config: DiagSessionConfigDto,
    pub open: bool,
    /// Last diagnostic session confirmed by a positive 0x50 response (1 = default).
    pub active_session: u8,
    /// Odd requestSeed level unlocked by a positive 0x67 sendKey, `None` = locked.
    pub unlocked_level: Option<u8>,
    pub tester_present_enabled: bool,
    pub tester_present_interval_ms: u32,
    /// ECU-reported timings from the last 0x50 (ms), if any.
    pub p2_server_ms: Option<u32>,
    pub p2_star_server_ms: Option<u32>,
    pub last_seq: u64,
}

// ─── ISO-TP frame capture (Diagnostics ISO-TP Monitor) ───────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IsoTpFrameKind {
    Single,
    First,
    Consecutive,
    FlowControl,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IsoTpDirection {
    Tx,
    Rx,
}

/// One CAN frame seen by a session's tap (`Rx`) or confirmed on the bus (`TxConfirmed`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsoTpFrameDto {
    /// Per session, starts at 1.
    pub seq: u64,
    /// HAL timestamp.
    pub timestamp_us: u64,
    pub can_id: u32,
    pub is_extended: bool,
    pub direction: IsoTpDirection,
    pub fd: bool,
    /// Payload bytes per DLC.
    pub data: Vec<u8>,
    pub kind: IsoTpFrameKind,
    /// Conversation `seq` of the transaction in flight when the frame was recorded: the
    /// `request` event (`keepaliveSent` for TesterPresent). When the request never got onto the
    /// bus completely, the `txBlocked` / `timeout` / `transportError` event that ended it.
    /// `None` for frames outside any exchange (late / unsolicited frames, another tester).
    pub request_seq: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsoTpFramePageDto {
    pub frames: Vec<IsoTpFrameDto>,
    /// Pass as `sinceSeq` next time.
    pub last_seq: u64,
    /// `sinceSeq` was older than the oldest retained frame (or from a previous session).
    pub truncated: bool,
    /// Frames overwritten before any reader fetched them (session total).
    pub dropped: u64,
}

// ─── ECU discovery (functional addressing) ──────────────────────────────────

/// `cmd_diag_discover_ecus` request: one functional single-frame request, then a fixed
/// collection window. Discovery never sends Flow Control.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EcuDiscoveryRequestDto {
    pub bus_id: u8,
    pub is_extended_id: bool,
    /// Functional request id, e.g. 0x7DF or 0x18DB33F1.
    pub functional_id: u32,
    /// UDS request PDU (single frame: classic 1..=7, CAN-FD 1..=62 bytes). Default `[0x3E, 0x00]`.
    #[serde(default)]
    pub request_pdu: Option<Vec<u8>>,
    /// Collection window in ms. Default 300, valid 50..=5000.
    #[serde(default)]
    pub window_ms: Option<u32>,
    /// Response filter id; `None` → default (11-bit 0x7E8 / 29-bit 0x18DAF100).
    #[serde(default)]
    pub response_id: Option<u32>,
    /// Response filter mask; `None` → default (11-bit 0x7F8 / 29-bit 0x1FFFFF00),
    /// or an exact mask when only `responseId` is given.
    #[serde(default)]
    pub response_mask: Option<u32>,
    #[serde(default = "default_padding")]
    pub padding: Option<u8>,
    #[serde(default)]
    pub use_fd: bool,
    /// `true` → read DIDs F190 / F18C / F187 physically from every responder.
    #[serde(default)]
    pub identify: bool,
}

/// One responding ECU (one entry per response id).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredEcuDto {
    pub response_id: u32,
    /// Derived physical request id (11-bit 0x7E8..0x7EF → -8, 29-bit 0x18DA_TA_SA → swap).
    pub request_id: Option<u32>,
    pub is_extended_id: bool,
    pub positive: bool,
    pub nrc: Option<u8>,
    pub nrc_name: Option<String>,
    /// At least one `7F sid 78` was seen.
    pub pending: bool,
    /// Last meaningful response PDU (SF payload) or the first-frame data bytes.
    pub raw: Vec<u8>,
    /// A First Frame arrived (discovery sends no Flow Control).
    pub multi_frame: bool,
    /// Request TX confirmation → first response (HAL timestamps), microseconds.
    pub first_response_us: u64,
    pub response_count: u32,
    pub vin: Option<String>,
    pub serial_number: Option<String>,
    pub part_number: Option<String>,
    /// Errors / NRCs collected while identifying (`identify = true`).
    pub identify_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EcuDiscoveryResultDto {
    /// UDS PDU actually sent (without ISO-TP PCI).
    pub request_bytes: Vec<u8>,
    pub functional_id: u32,
    pub is_extended_id: bool,
    pub window_ms: u32,
    pub tx_timestamp_us: u64,
    /// Sorted by `responseId`, one entry per response id.
    pub ecus: Vec<DiscoveredEcuDto>,
    /// Frames that matched the filter but were unclassifiable / not a response to the request.
    pub ignored_frames: u32,
}

// ─── Errors ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagErrorCode {
    InvalidInput,
    BusNotConnected,
    ListenOnly,
    Disarmed,
    PanicLatched,
    TimeoutP2,
    TimeoutP2Star,
    TimeoutIsotp,
    IsotpError,
    Busy,
    SessionClosed,
    UnexpectedResponse,
    /// Helper methods only (`read_did`, `read_dtcs_by_status`): ECU answered 0x7F.
    NegativeResponse,
    Internal,
}

impl DiagErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid_input",
            Self::BusNotConnected => "bus_not_connected",
            Self::ListenOnly => "listen_only",
            Self::Disarmed => "disarmed",
            Self::PanicLatched => "panic_latched",
            Self::TimeoutP2 => "timeout_p2",
            Self::TimeoutP2Star => "timeout_p2_star",
            Self::TimeoutIsotp => "timeout_isotp",
            Self::IsotpError => "isotp_error",
            Self::Busy => "busy",
            Self::SessionClosed => "session_closed",
            Self::UnexpectedResponse => "unexpected_response",
            Self::NegativeResponse => "negative_response",
            Self::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct DiagError {
    pub code: DiagErrorCode,
    pub message: String,
}

impl DiagError {
    pub fn new(code: DiagErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// Wire format for IPC errors (Tauri `Err(String)` and bridge 400 body):
    /// `"[diag:<code>] <message>"`. Parsed by the HMI.
    pub fn to_ipc_string(&self) -> String {
        format!("[diag:{}] {}", self.code.as_str(), self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_accepts_existing_hmi_shape() {
        let cfg: DiagSessionConfigDto = serde_json::from_str(
            r#"{"requestId":2016,"responseId":2024,"busId":0,"isExtendedId":false,"protocol":"uds"}"#,
        )
        .unwrap();
        assert_eq!(cfg.padding, Some(0xAA));
        assert_eq!(cfg.p2_margin_ms, 100);
        assert!(!cfg.use_fd);
        assert_eq!(cfg.functional_id, None);
    }

    #[test]
    fn discovery_request_defaults_and_casing() {
        let r: EcuDiscoveryRequestDto =
            serde_json::from_str(r#"{"busId":0,"isExtendedId":false,"functionalId":2015}"#)
                .unwrap();
        assert_eq!(r.padding, Some(0xAA));
        assert_eq!(r.request_pdu, None);
        assert_eq!(r.window_ms, None);
        assert!(!r.use_fd && !r.identify);
        let r: EcuDiscoveryRequestDto = serde_json::from_str(
            r#"{"busId":1,"isExtendedId":true,"functionalId":416035825,"requestPdu":[16,1],"windowMs":500,
                "responseId":416346368,"responseMask":536870656,"padding":null,"useFd":true,"identify":true}"#,
        )
        .unwrap();
        assert_eq!(r.request_pdu, Some(vec![0x10, 0x01]));
        assert_eq!(r.padding, None);
        assert_eq!(r.response_mask, Some(0x1FFF_FF00));
        let v = serde_json::to_value(EcuDiscoveryResultDto {
            request_bytes: vec![0x3E, 0x00],
            functional_id: 0x7DF,
            is_extended_id: false,
            window_ms: 300,
            tx_timestamp_us: 1,
            ecus: vec![],
            ignored_frames: 0,
        })
        .unwrap();
        for k in [
            "requestBytes",
            "functionalId",
            "isExtendedId",
            "windowMs",
            "txTimestampUs",
            "ecus",
            "ignoredFrames",
        ] {
            assert!(v.get(k).is_some(), "{k}");
        }
    }

    #[test]
    fn isotp_frame_casing() {
        let v = serde_json::to_value(IsoTpFramePageDto {
            frames: vec![IsoTpFrameDto {
                seq: 1,
                timestamp_us: 2,
                can_id: 0x7EA,
                is_extended: false,
                direction: IsoTpDirection::Rx,
                fd: false,
                data: vec![0x30, 0, 0],
                kind: IsoTpFrameKind::FlowControl,
                request_seq: Some(7),
            }],
            last_seq: 1,
            truncated: false,
            dropped: 0,
        })
        .unwrap();
        let f = &v["frames"][0];
        assert_eq!(f["direction"], "rx");
        assert_eq!(f["kind"], "flowControl");
        for k in ["seq", "timestampUs", "canId", "isExtended", "fd", "data"] {
            assert!(f.get(k).is_some(), "{k}");
        }
        assert_eq!(f["requestSeq"], 7);
        for k in ["lastSeq", "truncated", "dropped"] {
            assert!(v.get(k).is_some(), "{k}");
        }
        assert_eq!(serde_json::to_value(IsoTpDirection::Tx).unwrap(), "tx");
        for (k, s) in [
            (IsoTpFrameKind::Single, "single"),
            (IsoTpFrameKind::First, "first"),
            (IsoTpFrameKind::Consecutive, "consecutive"),
            (IsoTpFrameKind::Unknown, "unknown"),
        ] {
            assert_eq!(serde_json::to_value(k).unwrap(), s);
        }
    }

    #[test]
    fn isotp_frame_without_transaction_serializes_null() {
        let v = serde_json::to_value(IsoTpFrameDto {
            seq: 1,
            timestamp_us: 2,
            can_id: 0x7EA,
            is_extended: false,
            direction: IsoTpDirection::Rx,
            fd: false,
            data: vec![],
            kind: IsoTpFrameKind::Unknown,
            request_seq: None,
        })
        .unwrap();
        assert!(v.get("requestSeq").is_some_and(|x| x.is_null()));
    }

    #[test]
    fn origin_values_and_options_casing() {
        for (o, s) in [
            (DiagOrigin::Console, "console"),
            (DiagOrigin::Did, "did"),
            (DiagOrigin::Dtc, "dtc"),
            (DiagOrigin::Pids, "pids"),
            (DiagOrigin::Panel, "panel"),
            (DiagOrigin::Flow, "flow"),
            (DiagOrigin::Session, "session"),
            (DiagOrigin::Keepalive, "keepalive"),
            (DiagOrigin::Other, "other"),
        ] {
            assert_eq!(serde_json::to_value(o).unwrap(), s);
            assert_eq!(serde_json::from_value::<DiagOrigin>(s.into()).unwrap(), o);
        }
        assert_eq!(DiagOrigin::default(), DiagOrigin::Other);
        let o: UdsRequestOptionsDto = serde_json::from_str(r#"{"timeoutMs":500}"#).unwrap();
        assert_eq!(o.origin, None);
        let o: UdsRequestOptionsDto =
            serde_json::from_str(r#"{"addressing":"physical","origin":"pids"}"#).unwrap();
        assert_eq!(o.origin, Some(DiagOrigin::Pids));
        assert!(serde_json::from_str::<UdsRequestOptionsDto>(r#"{"origin":"Console"}"#).is_err());
        let v = serde_json::to_value(ConversationEventDto {
            seq: 3,
            timestamp_us: 4,
            kind: ConversationEventKind::Response,
            addressing: UdsAddressing::Physical,
            sid: Some(0x22),
            bytes: vec![0x62],
            request_seq: Some(2),
            elapsed_us: Some(5),
            nrc: None,
            detail: None,
            origin: DiagOrigin::Flow,
        })
        .unwrap();
        assert_eq!(v["origin"], "flow");
        assert_eq!(v["requestSeq"], 2);
        assert_eq!(v["kind"], "response");
    }

    #[test]
    fn ipc_error_prefix() {
        let e = DiagError::new(DiagErrorCode::Disarmed, "arm the bus first");
        assert_eq!(e.to_ipc_string(), "[diag:disarmed] arm the bus first");
    }
}
