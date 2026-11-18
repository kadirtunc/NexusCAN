//! Data transfer engine: RequestDownload (0x34) → TransferData (0x36)* → RequestTransferExit
//! (0x37), once per [`FirmwareSegment`].
//!
//! Deliberately NOT included (orchestrated as separate Flow blocks, never hardcoded here):
//! session change (0x10 02), SecurityAccess (0x27), erase / check routines (0x31), reset (0x11).
//!
//! Standards references (ISO 14229-1:2020 — byte values and rules are interoperability facts;
//! wording is our own):
//! * §14.2 RequestDownload: request `[0x34, dataFormatIdentifier, addressAndLengthFormatIdentifier
//!   (high nibble = memorySize byte count, low nibble = memoryAddress byte count), address…,
//!   size…]`; positive response `[0x74, lengthFormatIdentifier (high nibble = byte count of
//!   maxNumberOfBlockLength), maxNumberOfBlockLength…]`. maxNumberOfBlockLength is the length of
//!   the complete 0x36 request **including** the SID and blockSequenceCounter bytes.
//! * §14.5 TransferData: blockSequenceCounter starts at 0x01 after each 0x34 and wraps
//!   0xFF → 0x00; the positive response `[0x76, bsc, …]` echoes the counter. A server that
//!   receives the block it already accepted last (same counter) answers positively again
//!   without re-writing it — this makes "resend the same block with the same counter" the safe
//!   retry after a lost response or NRC 0x73.
//! * §14.6 RequestTransferExit: `[0x37, transferRequestParameterRecord…]` → `[0x77, …]`.
//! * Annex A NRCs: 0x21 busy, 0x24 requestSequenceError, 0x31 requestOutOfRange, 0x70
//!   uploadDownloadNotAccepted, 0x71 transferDataSuspended, 0x72 generalProgrammingFailure,
//!   0x73 wrongBlockSequenceCounter, 0x92/0x93 voltage too high/low. NRC 0x78 is consumed by the
//!   UDS client (P2* handling) and never reaches this engine.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::firmware::FirmwareImage;
use crate::uds::client::{nrc_name, UdsSession};
use crate::uds::dto::{DiagError, DiagErrorCode, DiagOrigin, UdsRequestOptionsDto, UdsResponseDto};

pub const SID_REQUEST_DOWNLOAD: u8 = 0x34;
pub const SID_REQUEST_UPLOAD: u8 = 0x35;
pub const SID_TRANSFER_DATA: u8 = 0x36;
pub const SID_REQUEST_TRANSFER_EXIT: u8 = 0x37;
const POSITIVE_OFFSET: u8 = 0x40;
const NEGATIVE_RESPONSE_SID: u8 = 0x7F;

/// Largest classical ISO-TP PDU (12-bit FirstFrame length) → default 0x36 length cap.
pub const CLASSICAL_MAX_BLOCK_LEN: u32 = 4095;
/// Largest PDU the NexusCAN UDS client sends over CAN-FD ISO-TP.
pub const FD_MAX_BLOCK_LEN: u32 = 65535;
/// Smallest usable 0x36 PDU: SID + counter + 1 data byte.
pub const MIN_BLOCK_LEN: u32 = 3;
/// Upper bound for `retriesPerBlock`.
pub const MAX_RETRIES_PER_BLOCK: u8 = 10;

pub const NRC_BUSY_REPEAT_REQUEST: u8 = 0x21;
pub const NRC_WRONG_BLOCK_SEQUENCE_COUNTER: u8 = 0x73;

// ─── Requester abstraction ──────────────────────────────────────────────────

/// Error of one [`UdsRequester::request`].
///
/// The NRC is a typed field taken from the response itself (never parsed from text), so the
/// engine can branch on 0x73 / 0x71 / 0x72 / 0x24 … without string matching.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RequesterError {
    /// The ECU answered `[0x7F, sid, nrc]` (final answer; 0x78 is consumed by the client).
    #[error("negative response nrc=0x{nrc:02X} {}", nrc_name(*nrc))]
    Negative { nrc: u8 },
    /// Transport / timeout / TX gate / session failure, classified by [`DiagErrorCode`].
    #[error("{0}")]
    Diag(DiagError),
}

impl RequesterError {
    /// NRC of a negative response, `None` for transport errors.
    pub fn nrc(&self) -> Option<u8> {
        match self {
            Self::Negative { nrc } => Some(*nrc),
            Self::Diag(_) => None,
        }
    }

    /// UDS client error code of a transport error, `None` for negative responses.
    pub fn diag_code(&self) -> Option<DiagErrorCode> {
        match self {
            Self::Negative { .. } => None,
            Self::Diag(d) => Some(d.code),
        }
    }
}

impl From<DiagError> for RequesterError {
    fn from(e: DiagError) -> Self {
        Self::Diag(e)
    }
}

/// Minimal UDS request interface so the engine runs against a real [`UdsSession`] or a mock.
///
/// Contract:
/// * `data` excludes the SID.
/// * `Ok` = the **positive** response PDU including the response SID (`sid + 0x40`).
/// * A negative response = `Err(RequesterError::Negative { nrc })`.
/// * Timeouts and transport failures = `Err(RequesterError::Diag(_))`.
/// * `timeout_ms` = `None` → the session default (P2 / P2* with 0x78 extension).
pub trait UdsRequester {
    fn request(
        &self,
        sid: u8,
        data: &[u8],
        timeout_ms: Option<u32>,
    ) -> Result<Vec<u8>, RequesterError>;
}

impl<T: UdsRequester + ?Sized> UdsRequester for &T {
    fn request(
        &self,
        sid: u8,
        data: &[u8],
        timeout_ms: Option<u32>,
    ) -> Result<Vec<u8>, RequesterError> {
        (**self).request(sid, data, timeout_ms)
    }
}

impl<T: UdsRequester + ?Sized> UdsRequester for std::sync::Arc<T> {
    fn request(
        &self,
        sid: u8,
        data: &[u8],
        timeout_ms: Option<u32>,
    ) -> Result<Vec<u8>, RequesterError> {
        (**self).request(sid, data, timeout_ms)
    }
}

/// Busy (0x21) retries delegated to the UDS client for flash requests: a 0x21 means the ECU
/// did not process the request, so a resend is always safe.
const SESSION_BUSY_RETRIES: u8 = 3;

impl UdsRequester for UdsSession {
    fn request(
        &self,
        sid: u8,
        data: &[u8],
        timeout_ms: Option<u32>,
    ) -> Result<Vec<u8>, RequesterError> {
        let opts = UdsRequestOptionsDto {
            timeout_ms,
            origin: Some(DiagOrigin::Flow),
            busy_retry_max: Some(SESSION_BUSY_RETRIES),
            ..Default::default()
        };
        response_to_result(UdsSession::request(self, sid, data, &opts)?)
    }
}

/// Maps a client response onto the [`UdsRequester`] contract: `nrc: Some(_)` →
/// [`RequesterError::Negative`] straight from the DTO field; an empty (suppressed) response →
/// `Diag(UnexpectedResponse)`.
pub fn response_to_result(r: UdsResponseDto) -> Result<Vec<u8>, RequesterError> {
    if let Some(nrc) = r.nrc {
        return Err(RequesterError::Negative { nrc });
    }
    if r.raw.is_empty() {
        return Err(RequesterError::Diag(DiagError::new(
            DiagErrorCode::UnexpectedResponse,
            "no response (suppressed positive response)",
        )));
    }
    Ok(r.raw)
}

fn is_timeout(code: DiagErrorCode) -> bool {
    matches!(
        code,
        DiagErrorCode::TimeoutP2 | DiagErrorCode::TimeoutP2Star | DiagErrorCode::TimeoutIsotp
    )
}

// ─── Configuration ──────────────────────────────────────────────────────────

/// Transfer direction. Only `Download` is implemented.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferMode {
    /// RequestDownload 0x34 (tester → ECU).
    #[default]
    Download,
    /// RequestUpload 0x35 (ECU → tester). Reserved; rejected by [`DownloadConfig::validate`].
    Upload,
}

/// Parameters of one download. Deserializable from the Flow block JSON (all fields optional).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DownloadConfig {
    /// 0x34 dataFormatIdentifier (high nibble compression, low nibble encryption). Default 0x00.
    pub data_format_identifier: u8,
    /// 0x34 addressAndLengthFormatIdentifier. Both nibbles must be 1..=4. Default 0x44.
    pub address_and_length_format_identifier: u8,
    /// Replaces the ECU-reported maxNumberOfBlockLength (SID + counter + data). Still capped by
    /// `max_block_len_cap`.
    pub max_block_len_override: Option<u32>,
    /// Transport limit for one 0x36 PDU: [`CLASSICAL_MAX_BLOCK_LEN`] (default) or
    /// [`FD_MAX_BLOCK_LEN`]. Valid range `MIN_BLOCK_LEN..=FD_MAX_BLOCK_LEN`.
    pub max_block_len_cap: u32,
    /// Timeout per 0x36 request; `None` = session default (P2/P2*).
    pub transfer_timeout_ms: Option<u32>,
    /// Timeout for 0x34 / 0x37; `None` = session default.
    pub request_timeout_ms: Option<u32>,
    /// Resends of one 0x36 block after a timeout, NRC 0x73 or NRC 0x21. Default 2, max 10.
    pub retries_per_block: u8,
    pub mode: TransferMode,
    /// 0x37 transferRequestParameterRecord (usually empty).
    pub transfer_exit_parameter: Vec<u8>,
}

impl Default for DownloadConfig {
    fn default() -> Self {
        Self {
            data_format_identifier: 0x00,
            address_and_length_format_identifier: 0x44,
            max_block_len_override: None,
            max_block_len_cap: CLASSICAL_MAX_BLOCK_LEN,
            transfer_timeout_ms: None,
            request_timeout_ms: None,
            retries_per_block: 2,
            mode: TransferMode::Download,
            transfer_exit_parameter: Vec::new(),
        }
    }
}

impl DownloadConfig {
    /// memoryAddress byte count (low nibble of the ALFID).
    pub fn address_bytes(&self) -> usize {
        usize::from(self.address_and_length_format_identifier & 0x0F)
    }

    /// memorySize byte count (high nibble of the ALFID).
    pub fn size_bytes(&self) -> usize {
        usize::from(self.address_and_length_format_identifier >> 4)
    }

    /// Image-independent checks.
    pub fn validate(&self) -> Result<(), String> {
        if self.mode == TransferMode::Upload {
            return Err("upload (0x35) is not implemented".into());
        }
        let alfid = self.address_and_length_format_identifier;
        if !(1..=4).contains(&self.address_bytes()) || !(1..=4).contains(&self.size_bytes()) {
            return Err(format!(
                "addressAndLengthFormatIdentifier 0x{alfid:02X}: both nibbles must be 1..=4"
            ));
        }
        if !(MIN_BLOCK_LEN..=FD_MAX_BLOCK_LEN).contains(&self.max_block_len_cap) {
            return Err(format!(
                "maxBlockLenCap {} must be {MIN_BLOCK_LEN}..={FD_MAX_BLOCK_LEN}",
                self.max_block_len_cap
            ));
        }
        if let Some(o) = self.max_block_len_override {
            if o < MIN_BLOCK_LEN {
                return Err(format!(
                    "maxBlockLenOverride {o} must be >= {MIN_BLOCK_LEN}"
                ));
            }
        }
        if self.retries_per_block > MAX_RETRIES_PER_BLOCK {
            return Err(format!(
                "retriesPerBlock {} must be <= {MAX_RETRIES_PER_BLOCK}",
                self.retries_per_block
            ));
        }
        if matches!(self.transfer_timeout_ms, Some(0)) || matches!(self.request_timeout_ms, Some(0))
        {
            return Err("timeouts must be > 0 ms".into());
        }
        Ok(())
    }

    /// 0x34 request data (without SID) for one segment; checks that address and length fit
    /// the ALFID byte counts.
    pub fn request_download_data(&self, address: u32, length: u64) -> Result<Vec<u8>, String> {
        let (a, s) = (self.address_bytes(), self.size_bytes());
        if !fits(u64::from(address), a) {
            return Err(format!(
                "address 0x{address:08X} does not fit in {a} memoryAddress byte(s) \
                 (ALFID 0x{:02X})",
                self.address_and_length_format_identifier
            ));
        }
        if length == 0 || !fits(length, s) {
            return Err(format!(
                "length {length} does not fit in {s} memorySize byte(s) (ALFID 0x{:02X})",
                self.address_and_length_format_identifier
            ));
        }
        let mut v = Vec::with_capacity(2 + a + s);
        v.push(self.data_format_identifier);
        v.push(self.address_and_length_format_identifier);
        v.extend_from_slice(&u64::from(address).to_be_bytes()[8 - a..]);
        v.extend_from_slice(&length.to_be_bytes()[8 - s..]);
        Ok(v)
    }
}

fn fits(value: u64, bytes: usize) -> bool {
    bytes >= 8 || value >> (8 * bytes) == 0
}

/// Parses a 0x74 positive response → maxNumberOfBlockLength (incl. SID + counter).
/// Rejects a wrong SID, lengthFormatIdentifier byte count 0 or > 4, truncated or over-long
/// responses.
pub fn parse_request_download_response(raw: &[u8]) -> Result<u32, String> {
    let expected = SID_REQUEST_DOWNLOAD + POSITIVE_OFFSET;
    match raw.first() {
        Some(&s) if s == expected => {}
        Some(&s) => return Err(format!("expected 0x{expected:02X}, got 0x{s:02X}")),
        None => return Err("empty response".into()),
    }
    let lfid = *raw
        .get(1)
        .ok_or("0x74 response without lengthFormatIdentifier")?;
    let n = usize::from(lfid >> 4);
    if !(1..=4).contains(&n) {
        return Err(format!(
            "lengthFormatIdentifier 0x{lfid:02X}: maxNumberOfBlockLength byte count {n} not in 1..=4"
        ));
    }
    if raw.len() != 2 + n {
        return Err(format!(
            "0x74 response has {} maxNumberOfBlockLength byte(s), lengthFormatIdentifier says {n}",
            raw.len() - 2
        ));
    }
    Ok(raw[2..].iter().fold(0u32, |a, &b| (a << 8) | u32::from(b)))
}

// ─── DTOs ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlashPhase {
    RequestDownload,
    Transfer,
    Exit,
    Done,
}

/// Progress event. Emitted at every 0x34, after **every** accepted 0x36 block, at every 0x37
/// and once at the end (`Done`). With small blocks this can be thousands of events per second:
/// callers forwarding to the HMI must throttle (e.g. keep the latest and push at ≤ 60 Hz; always
/// forward phase changes).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashProgressDto {
    pub segment_index: u32,
    pub segment_count: u32,
    pub segment_address: u32,
    /// Bytes acknowledged by the ECU, whole image.
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// blockSequenceCounter of the last accepted block (0 before the first block).
    pub block_counter: u8,
    /// Block resends so far, whole image.
    pub retries: u32,
    pub phase: FlashPhase,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentReportDto {
    pub index: u32,
    pub address: u32,
    pub bytes: u64,
    pub blocks: u32,
    pub retries: u32,
    /// maxNumberOfBlockLength reported by the ECU in 0x74.
    pub ecu_max_block_len: u32,
    /// 0x36 PDU length actually used (SID + counter + data) after override / cap.
    pub block_len: u32,
    /// 0x34 → 0x77, milliseconds.
    pub duration_ms: u64,
    pub throughput_bytes_per_sec: f64,
    /// 0x77 transferResponseParameterRecord (e.g. an ECU-computed checksum), often empty.
    pub exit_response: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashReportDto {
    pub segments: Vec<SegmentReportDto>,
    pub total_bytes: u64,
    pub total_blocks: u32,
    pub total_retries: u32,
    pub duration_ms: u64,
    pub throughput_bytes_per_sec: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlashErrorKind {
    /// Bad [`DownloadConfig`] or an address / length that does not fit the ALFID.
    InvalidConfig,
    /// Empty image.
    InvalidImage,
    /// ECU answered 0x7F (after retries for 0x73 / 0x21).
    NegativeResponse,
    /// No response within the timeout (after retries for 0x36).
    Timeout,
    /// TX gate / session / ISO-TP failure (Listen-Only, Disarmed, Panic, closed …).
    Transport,
    /// 0x76 echoed a different blockSequenceCounter.
    CounterMismatch,
    /// Positive response with a wrong SID, length or content.
    MalformedResponse,
    /// `cancel` was set; 0x37 was NOT sent (the ECU is left mid-download).
    Cancelled,
}

impl FlashErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidConfig => "invalid_config",
            Self::InvalidImage => "invalid_image",
            Self::NegativeResponse => "negative_response",
            Self::Timeout => "timeout",
            Self::Transport => "transport",
            Self::CounterMismatch => "counter_mismatch",
            Self::MalformedResponse => "malformed_response",
            Self::Cancelled => "cancelled",
        }
    }
}

/// Download failure with the position at which it happened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct FlashError {
    pub kind: FlashErrorKind,
    pub phase: FlashPhase,
    /// Segment in progress (`None` for pre-flight errors).
    pub segment_index: Option<u32>,
    /// Start address of that segment.
    pub address: Option<u32>,
    /// Byte offset inside the segment of the block in flight (= bytes of that segment
    /// acknowledged so far).
    pub offset: Option<u64>,
    /// blockSequenceCounter of the block in flight (Transfer phase only).
    pub block_counter: Option<u8>,
    pub last_nrc: Option<u8>,
    pub last_nrc_name: Option<String>,
    /// Underlying UDS client error code, if any.
    pub diag_code: Option<DiagErrorCode>,
    /// Bytes acknowledged by the ECU, whole image.
    pub bytes_done: u64,
    pub segments_completed: u32,
    pub message: String,
}

impl FlashError {
    /// IPC wire format: `"[flash:<kind>] <message>"` (same shape as `[diag:<code>]`).
    pub fn to_ipc_string(&self) -> String {
        format!("[flash:{}] {}", self.kind.as_str(), self.message)
    }

    fn preflight(kind: FlashErrorKind, message: String) -> Self {
        Self {
            kind,
            phase: FlashPhase::RequestDownload,
            segment_index: None,
            address: None,
            offset: None,
            block_counter: None,
            last_nrc: None,
            last_nrc_name: None,
            diag_code: None,
            bytes_done: 0,
            segments_completed: 0,
            message,
        }
    }
}

// ─── Engine ─────────────────────────────────────────────────────────────────

/// Position bookkeeping for error construction.
struct Cursor {
    segment_index: u32,
    segment_count: u32,
    address: u32,
    offset: u64,
    block_counter: u8,
    bytes_done: u64,
    bytes_total: u64,
    retries: u32,
    phase: FlashPhase,
}

impl Cursor {
    fn progress(&self, block_counter: u8) -> FlashProgressDto {
        FlashProgressDto {
            segment_index: self.segment_index,
            segment_count: self.segment_count,
            segment_address: self.address,
            bytes_done: self.bytes_done,
            bytes_total: self.bytes_total,
            block_counter,
            retries: self.retries,
            phase: self.phase,
        }
    }

    fn fail(
        &self,
        kind: FlashErrorKind,
        cause: Option<&RequesterError>,
        what: String,
    ) -> FlashError {
        let last_nrc = cause.and_then(RequesterError::nrc);
        let pos = match self.phase {
            FlashPhase::Transfer => format!(
                "segment {}/{} @0x{:08X}, offset {} (block 0x{:02X})",
                self.segment_index + 1,
                self.segment_count,
                self.address,
                self.offset,
                self.block_counter
            ),
            _ => format!(
                "segment {}/{} @0x{:08X}",
                self.segment_index + 1,
                self.segment_count,
                self.address
            ),
        };
        FlashError {
            kind,
            phase: self.phase,
            segment_index: Some(self.segment_index),
            address: Some(self.address),
            offset: Some(self.offset),
            block_counter: (self.phase == FlashPhase::Transfer).then_some(self.block_counter),
            last_nrc,
            last_nrc_name: last_nrc.map(nrc_name),
            diag_code: cause.and_then(RequesterError::diag_code),
            bytes_done: self.bytes_done,
            segments_completed: self.segment_index,
            message: format!("{what} — {pos}"),
        }
    }

    fn fail_req(&self, service: &str, e: &RequesterError) -> FlashError {
        let kind = match e {
            RequesterError::Negative { .. } => FlashErrorKind::NegativeResponse,
            RequesterError::Diag(d) if is_timeout(d.code) => FlashErrorKind::Timeout,
            RequesterError::Diag(d) if d.code == DiagErrorCode::UnexpectedResponse => {
                FlashErrorKind::MalformedResponse
            }
            RequesterError::Diag(_) => FlashErrorKind::Transport,
        };
        self.fail(kind, Some(e), format!("{service} failed: {e}"))
    }

    fn cancelled(&self) -> FlashError {
        self.fail(
            FlashErrorKind::Cancelled,
            None,
            "download cancelled by user (RequestTransferExit not sent)".into(),
        )
    }
}

/// A positive response that is actually a 0x7F (defensive: a requester that breaks the
/// contract) → the equivalent negative-response error.
fn smuggled_nrc(resp: &[u8]) -> Option<RequesterError> {
    match resp {
        [NEGATIVE_RESPONSE_SID, _, nrc, ..] => Some(RequesterError::Negative { nrc: *nrc }),
        _ => None,
    }
}

fn throughput(bytes: u64, started: Instant) -> (u64, f64) {
    let el = started.elapsed();
    let ms = u64::try_from(el.as_millis()).unwrap_or(u64::MAX);
    (ms, bytes as f64 / el.as_secs_f64().max(1e-6))
}

/// Downloads every segment of `image`: `0x34 → 0x36* → 0x37` per segment.
///
/// * Pre-flight (before any request): config validation, empty image, every segment's address
///   and length checked against the ALFID.
/// * `cancel` is checked before every request; when set the engine returns
///   [`FlashErrorKind::Cancelled`] **without** sending 0x37.
/// * 0x36 retries (`retriesPerBlock`): on timeout, NRC 0x73 or NRC 0x21 the SAME block is resent
///   with the SAME counter. Any other NRC (0x24, 0x31, 0x70, 0x71, 0x72, 0x92, 0x93 …), a
///   transport error (TX gate, closed session) or a counter echo mismatch aborts at once.
/// * 0x34 and 0x37 are not retried by the engine (a repeated 0x34/0x37 is a sequence error on a
///   server that processed the first one); 0x21 on them is retried by the UDS client.
/// * Blocking: run on a worker thread (`spawn_blocking`) in async contexts.
pub fn download_image(
    req: &dyn UdsRequester,
    image: &FirmwareImage,
    cfg: &DownloadConfig,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(FlashProgressDto),
) -> Result<FlashReportDto, FlashError> {
    cfg.validate()
        .map_err(|m| FlashError::preflight(FlashErrorKind::InvalidConfig, m))?;
    if image.segments.is_empty() || image.segments.iter().any(|s| s.data.is_empty()) {
        return Err(FlashError::preflight(
            FlashErrorKind::InvalidImage,
            "firmware image has no data (or an empty segment)".into(),
        ));
    }
    let segment_count = u32::try_from(image.segments.len()).map_err(|_| {
        FlashError::preflight(FlashErrorKind::InvalidImage, "too many segments".into())
    })?;
    let mut requests = Vec::with_capacity(image.segments.len());
    for (i, s) in image.segments.iter().enumerate() {
        let r = cfg
            .request_download_data(s.address, s.data.len() as u64)
            .map_err(|m| {
                let mut e = FlashError::preflight(
                    FlashErrorKind::InvalidConfig,
                    format!("segment {}: {m}", i + 1),
                );
                e.segment_index = Some(i as u32);
                e.address = Some(s.address);
                e
            })?;
        requests.push(r);
    }

    let started = Instant::now();
    let mut cur = Cursor {
        segment_index: 0,
        segment_count,
        address: 0,
        offset: 0,
        block_counter: 0,
        bytes_done: 0,
        bytes_total: image.total_bytes(),
        retries: 0,
        phase: FlashPhase::RequestDownload,
    };
    let mut reports = Vec::with_capacity(image.segments.len());
    // One reusable 0x36 data buffer (counter + payload) for the whole image.
    let mut block = Vec::new();

    for (i, (seg, req_data)) in image.segments.iter().zip(&requests).enumerate() {
        cur.segment_index = i as u32;
        cur.address = seg.address;
        cur.offset = 0;
        cur.block_counter = 0;
        cur.phase = FlashPhase::RequestDownload;
        let seg_started = Instant::now();

        // ── 0x34 RequestDownload ──
        if cancel.load(Ordering::Acquire) {
            return Err(cur.cancelled());
        }
        progress(cur.progress(0));
        let resp = req
            .request(SID_REQUEST_DOWNLOAD, req_data, cfg.request_timeout_ms)
            .map_err(|e| cur.fail_req("RequestDownload (0x34)", &e))?;
        if let Some(e) = smuggled_nrc(&resp) {
            return Err(cur.fail_req("RequestDownload (0x34)", &e));
        }
        let ecu_max = parse_request_download_response(&resp).map_err(|m| {
            cur.fail(
                FlashErrorKind::MalformedResponse,
                None,
                format!("RequestDownload (0x34): {m}"),
            )
        })?;
        let block_len = cfg
            .max_block_len_override
            .unwrap_or(ecu_max)
            .min(cfg.max_block_len_cap);
        if block_len < MIN_BLOCK_LEN {
            return Err(cur.fail(
                FlashErrorKind::MalformedResponse,
                None,
                format!(
                    "maxNumberOfBlockLength {block_len} leaves no room for data \
                     (needs >= {MIN_BLOCK_LEN}: SID + counter + 1 byte)"
                ),
            ));
        }
        let payload = (block_len - 2) as usize;

        // ── 0x36 TransferData ──
        cur.phase = FlashPhase::Transfer;
        let mut bsc: u8 = 0x01;
        let mut blocks: u32 = 0;
        let mut seg_retries: u32 = 0;
        block.reserve(payload + 1);
        for chunk in seg.data.chunks(payload) {
            cur.block_counter = bsc;
            let mut attempt: u8 = 0;
            loop {
                if cancel.load(Ordering::Acquire) {
                    return Err(cur.cancelled());
                }
                block.clear();
                block.push(bsc);
                block.extend_from_slice(chunk);
                let outcome = req
                    .request(SID_TRANSFER_DATA, &block, cfg.transfer_timeout_ms)
                    .and_then(|r| match smuggled_nrc(&r) {
                        Some(e) => Err(e),
                        None => Ok(r),
                    });
                match outcome {
                    Ok(r) => {
                        match r.as_slice() {
                            [0x76, echo, ..] if *echo == bsc => {}
                            [0x76, echo, ..] => {
                                return Err(cur.fail(
                                    FlashErrorKind::CounterMismatch,
                                    None,
                                    format!(
                                        "TransferData (0x36): ECU echoed block counter \
                                         0x{echo:02X}, sent 0x{bsc:02X}"
                                    ),
                                ))
                            }
                            _ => {
                                return Err(cur.fail(
                                    FlashErrorKind::MalformedResponse,
                                    None,
                                    format!(
                                        "TransferData (0x36): malformed positive response {:02X?}",
                                        &r[..r.len().min(8)]
                                    ),
                                ))
                            }
                        }
                        break;
                    }
                    Err(e) => {
                        let retryable = match &e {
                            RequesterError::Negative { nrc } => matches!(
                                *nrc,
                                NRC_WRONG_BLOCK_SEQUENCE_COUNTER | NRC_BUSY_REPEAT_REQUEST
                            ),
                            RequesterError::Diag(d) => is_timeout(d.code),
                        };
                        if retryable && attempt < cfg.retries_per_block {
                            attempt += 1;
                            seg_retries += 1;
                            cur.retries += 1;
                            continue;
                        }
                        let mut err = cur.fail_req("TransferData (0x36)", &e);
                        if retryable {
                            err.message = format!(
                                "{} (after {} retr{})",
                                err.message,
                                attempt,
                                if attempt == 1 { "y" } else { "ies" }
                            );
                        }
                        return Err(err);
                    }
                }
            }
            blocks += 1;
            cur.offset += chunk.len() as u64;
            cur.bytes_done += chunk.len() as u64;
            progress(cur.progress(bsc));
            bsc = bsc.wrapping_add(1);
        }

        // ── 0x37 RequestTransferExit ──
        cur.phase = FlashPhase::Exit;
        if cancel.load(Ordering::Acquire) {
            return Err(cur.cancelled());
        }
        progress(cur.progress(cur.block_counter));
        let resp = req
            .request(
                SID_REQUEST_TRANSFER_EXIT,
                &cfg.transfer_exit_parameter,
                cfg.request_timeout_ms,
            )
            .map_err(|e| cur.fail_req("RequestTransferExit (0x37)", &e))?;
        if let Some(e) = smuggled_nrc(&resp) {
            return Err(cur.fail_req("RequestTransferExit (0x37)", &e));
        }
        if resp.first() != Some(&(SID_REQUEST_TRANSFER_EXIT + POSITIVE_OFFSET)) {
            return Err(cur.fail(
                FlashErrorKind::MalformedResponse,
                None,
                format!(
                    "RequestTransferExit (0x37): unexpected response {:02X?}",
                    &resp[..resp.len().min(8)]
                ),
            ));
        }
        let bytes = seg.data.len() as u64;
        let (duration_ms, tput) = throughput(bytes, seg_started);
        reports.push(SegmentReportDto {
            index: i as u32,
            address: seg.address,
            bytes,
            blocks,
            retries: seg_retries,
            ecu_max_block_len: ecu_max,
            block_len,
            duration_ms,
            throughput_bytes_per_sec: tput,
            exit_response: resp[1..].to_vec(),
        });
    }

    cur.phase = FlashPhase::Done;
    progress(cur.progress(cur.block_counter));
    let (duration_ms, tput) = throughput(cur.bytes_done, started);
    Ok(FlashReportDto {
        total_bytes: cur.bytes_done,
        total_blocks: reports.iter().map(|r| r.blocks).sum(),
        total_retries: cur.retries,
        segments: reports,
        duration_ms,
        throughput_bytes_per_sec: tput,
    })
}

#[cfg(test)]
#[path = "transfer_tests.rs"]
mod tests;
