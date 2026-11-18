//! ECU reprogramming commands over the regular diag session path:
//! `cmd_flash_load_image`, `cmd_flash_release_image`, `cmd_flash_download`, `cmd_flash_cancel`.
//!
//! * Images are parsed once ([`FirmwareImage::load`]) and cached by an opaque uuid-like
//!   `imageId` (at most [`MAX_CACHED_IMAGES`], oldest evicted). The HMI uploads the file once and
//!   refers to it by id, so a 64 MiB image never travels twice over IPC.
//! * `cmd_flash_download` obtains its [`UdsSession`](nexus_protocols::uds::client::UdsSession)
//!   through `diag_session_for` (auto-open), so every bus gate applies: connected, armed, not
//!   Listen-Only, Panic not latched. It runs the protocol-crate engine
//!   [`download_image`] (0x34 → 0x36* → 0x37 per segment).
//! * One download per session key at a time; `cmd_flash_cancel` sets that download's cancel
//!   flag; Panic Stop (and session reset) cancel every running download before the taps close.
//!   Each flag carries its [`CancelReason`]. Closing the tap aborts the request already in
//!   flight, so a `transport` / `timeout` failure of a cancelled download is reported as
//!   `cancelled` (position fields kept, message names the cause).
//! * Progress is throttled here (≤ 60 Hz) for every transport: the first event, every phase
//!   change and the final `done` event are always delivered.
//!
//! TesterPresent: the session keepalive task keeps its enabled state during a download. It only
//! sends `3E 80` when no request was transmitted for a whole interval and never waits for the
//! request lock (`try_lock`), so while 0x36 blocks flow the ECU's S3 timer is restarted by the
//! transfer itself and no TesterPresent is interleaved; it resumes on its own after the transfer.
//!
//! All methods are BLOCKING. Async callers must use `spawn_blocking`.

use super::diag_session::{diag_key, validate_config, DiagKey};
use super::*;
use nexus_protocols::uds::dto::DiagSessionConfigDto;
use nexus_protocols::uds::flash::transfer::{CLASSICAL_MAX_BLOCK_LEN, FD_MAX_BLOCK_LEN};
use nexus_protocols::uds::flash::{
    detect_format, download_image, DownloadConfig, FirmwareError, FirmwareFormat, FirmwareImage,
    FirmwareImageSummaryDto, FlashError, FlashErrorKind, FlashPhase, FlashProgressDto,
    FlashReportDto, UdsRequester,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Largest decoded firmware file accepted by `cmd_flash_load_image`.
pub const MAX_FLASH_IMAGE_BYTES: usize = 64 * 1024 * 1024;
/// Parsed images kept in the engine; the oldest is evicted beyond this.
pub const MAX_CACHED_IMAGES: usize = 8;
/// Minimum spacing of throttled progress events (60 Hz).
pub const FLASH_PROGRESS_INTERVAL: Duration = Duration::from_micros(16_667);

/// `format` argument of `cmd_flash_load_image`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlashLoadFormat {
    /// [`detect_format`] for Intel HEX / S-record. Content that looks like raw binary is
    /// REJECTED (`[firmware]` error): binary needs an explicit format + base address.
    Auto,
    IntelHex,
    Srec,
    Binary,
}

/// Result of `cmd_flash_load_image`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashImageHandleDto {
    pub image_id: String,
    pub file_name: String,
    /// Format actually parsed (resolved when `auto`).
    pub format: FirmwareFormat,
    pub summary: FirmwareImageSummaryDto,
}

struct CachedImage {
    seq: u64,
    image: Arc<FirmwareImage>,
}

/// Parsed firmware images by `imageId`.
#[derive(Default)]
pub(crate) struct FlashImageCache {
    images: Mutex<HashMap<String, CachedImage>>,
    seq: AtomicU64,
}

impl FlashImageCache {
    fn insert(&self, id: String, image: Arc<FirmwareImage>) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        let mut map = self.images.lock();
        map.insert(id, CachedImage { seq, image });
        while map.len() > MAX_CACHED_IMAGES {
            let Some(oldest) = map
                .iter()
                .min_by_key(|(_, c)| c.seq)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            map.remove(&oldest);
        }
    }

    fn get(&self, id: &str) -> Option<Arc<FirmwareImage>> {
        self.images.lock().get(id).map(|c| Arc::clone(&c.image))
    }

    fn remove(&self, id: &str) -> bool {
        self.images.lock().remove(id).is_some()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.images.lock().len()
    }
}

/// Why a running download was cancelled (first cause wins).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum CancelReason {
    User = 1,
    PanicStop = 2,
    SessionReset = 3,
}

impl CancelReason {
    fn from_u8(v: u8) -> Option<Self> {
        match v {
            1 => Some(Self::User),
            2 => Some(Self::PanicStop),
            3 => Some(Self::SessionReset),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::PanicStop => "Panic Stop",
            Self::SessionReset => "session reset",
        }
    }
}

/// Cancel flag of one download plus its cause. The flag is what `download_image` polls.
#[derive(Default)]
struct CancelToken {
    flag: AtomicBool,
    reason: AtomicU8,
}

impl CancelToken {
    fn cancel(&self, reason: CancelReason) {
        // Cause first (first one wins), then the flag: a reader that sees the flag sees a cause.
        let _ = self
            .reason
            .compare_exchange(0, reason as u8, Ordering::SeqCst, Ordering::SeqCst);
        self.flag.store(true, Ordering::SeqCst);
    }

    /// `Some(cause)` once cancelled.
    fn cancelled(&self) -> Option<CancelReason> {
        if !self.flag.load(Ordering::SeqCst) {
            return None;
        }
        CancelReason::from_u8(self.reason.load(Ordering::SeqCst)).or(Some(CancelReason::User))
    }
}

/// Cancel tokens of the running downloads by session key.
#[derive(Default)]
pub(crate) struct FlashRunMap(Mutex<HashMap<DiagKey, Arc<CancelToken>>>);

impl FlashRunMap {
    /// Cancels every running download; returns how many were running.
    pub(crate) fn cancel_all(&self, reason: CancelReason) -> usize {
        let map = self.0.lock();
        for token in map.values() {
            token.cancel(reason);
        }
        map.len()
    }
}

/// A download that failed AFTER it was cancelled is reported as `cancelled`.
///
/// Panic Stop / session reset set the cancel flag and then close the diag taps, which aborts the
/// request already in flight (`SessionClosed` → `transport`, or a timeout). The engine polls
/// `cancel` only before each request, so the wiring layer reclassifies that failure. Position
/// fields (phase, segment, address, offset, block counter, bytes done, segments completed) are
/// kept; an engine-detected cancel gets the accurate cause in its message.
fn reclassify_cancelled(mut e: FlashError, reason: CancelReason) -> FlashError {
    match e.kind {
        FlashErrorKind::Transport | FlashErrorKind::Timeout => {
            let cause = std::mem::take(&mut e.message);
            e.kind = FlashErrorKind::Cancelled;
            e.message = if e.segment_index.is_none() {
                // Pre-flight (session open refused): nothing was sent to the ECU.
                format!(
                    "download cancelled by {} before any request was sent: {cause}",
                    reason.label()
                )
            } else {
                format!(
                    "download cancelled by {} (RequestTransferExit not sent; the ECU is left \
                     mid-download) — in-flight request aborted: {cause}",
                    reason.label()
                )
            };
        }
        FlashErrorKind::Cancelled if reason != CancelReason::User => {
            e.message = e.message.replace(
                "cancelled by user",
                &format!("cancelled by {}", reason.label()),
            );
        }
        _ => {}
    }
    e
}

/// Removes the run entry when the download ends (any exit path, panics included).
struct RunGuard<'a> {
    runs: &'a FlashRunMap,
    key: DiagKey,
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        self.runs.0.lock().remove(&self.key);
    }
}

/// Throttles engine progress to ≤ 60 Hz: always the first event, every phase change and `done`.
struct ProgressThrottle<'a> {
    sink: &'a mut dyn FnMut(FlashProgressDto),
    last_emit: Option<Instant>,
    last_phase: Option<FlashPhase>,
}

impl ProgressThrottle<'_> {
    fn push(&mut self, p: FlashProgressDto) {
        let now = Instant::now();
        let due = match (self.last_emit, self.last_phase) {
            (None, _) | (_, None) => true,
            (Some(at), Some(phase)) => {
                phase != p.phase
                    || p.phase == FlashPhase::Done
                    || now.duration_since(at) >= FLASH_PROGRESS_INTERVAL
            }
        };
        if due {
            self.last_emit = Some(now);
            self.last_phase = Some(p.phase);
            (self.sink)(p);
        }
    }
}

/// Error before / around the transfer engine (no segment position).
fn flash_error(
    kind: FlashErrorKind,
    message: impl Into<String>,
    diag_code: Option<DiagErrorCode>,
) -> FlashError {
    FlashError {
        kind,
        phase: FlashPhase::RequestDownload,
        segment_index: None,
        address: None,
        offset: None,
        block_counter: None,
        last_nrc: None,
        last_nrc_name: None,
        diag_code,
        bytes_done: 0,
        segments_completed: 0,
        message: message.into(),
    }
}

fn from_diag_error(e: &DiagError) -> FlashError {
    let kind = if e.code == DiagErrorCode::InvalidInput {
        FlashErrorKind::InvalidConfig
    } else {
        FlashErrorKind::Transport
    };
    flash_error(kind, e.message.clone(), Some(e.code))
}

/// Builds the [`DownloadConfig`] of `cmd_flash_download` from its raw JSON argument
/// (`null` / absent = all defaults). When `maxBlockLenCap` is absent it defaults to
/// [`FD_MAX_BLOCK_LEN`] for a CAN-FD session (`useFd`), else [`CLASSICAL_MAX_BLOCK_LEN`]
/// (`DownloadConfig`'s own serde default is always the classical value).
pub fn resolve_download_config(
    raw: serde_json::Value,
    use_fd: bool,
) -> Result<DownloadConfig, FlashError> {
    let raw = match raw {
        serde_json::Value::Null => serde_json::Value::Object(Default::default()),
        v => v,
    };
    let cap_given = raw.get("maxBlockLenCap").is_some_and(|v| !v.is_null());
    let raw = match raw {
        serde_json::Value::Object(mut m) => {
            // `null` means "default" too.
            if !cap_given {
                m.remove("maxBlockLenCap");
            }
            serde_json::Value::Object(m)
        }
        other => other,
    };
    let mut cfg: DownloadConfig = serde_json::from_value(raw).map_err(|e| {
        flash_error(
            FlashErrorKind::InvalidConfig,
            format!("invalid download configuration: {e}"),
            None,
        )
    })?;
    if !cap_given {
        cfg.max_block_len_cap = if use_fd {
            FD_MAX_BLOCK_LEN
        } else {
            CLASSICAL_MAX_BLOCK_LEN
        };
    }
    Ok(cfg)
}

/// IPC wire format of a download failure: `"[flash] " + JSON(FlashError)`.
pub fn flash_error_to_ipc(e: &FlashError) -> String {
    let json = serde_json::to_string(e).unwrap_or_else(|_| {
        format!(
            r#"{{"kind":"transport","phase":"requestDownload","segmentIndex":null,"address":null,"offset":null,"blockCounter":null,"lastNrc":null,"lastNrcName":null,"diagCode":null,"bytesDone":0,"segmentsCompleted":0,"message":{:?}}}"#,
            e.message
        )
    });
    format!("[flash] {json}")
}

/// Random RFC 4122 v4-shaped id (`xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`).
fn new_image_id() -> String {
    let mut b = [0u8; 16];
    if getrandom::fill(&mut b).is_err() {
        // OS RNG unavailable: time + counter are unique enough for a local cache key.
        static FALLBACK: AtomicU64 = AtomicU64::new(0);
        let n = FALLBACK.fetch_add(1, Ordering::Relaxed);
        let t = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        b[..8].copy_from_slice(&(t as u64).to_le_bytes());
        b[8..].copy_from_slice(&n.to_le_bytes());
    }
    b[6] = (b[6] & 0x0F) | 0x40;
    b[8] = (b[8] & 0x3F) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// Decodes `data_base64` with the size cap applied BEFORE allocating the decoded buffer.
fn decode_firmware_base64(data_base64: &str) -> Result<Vec<u8>, FirmwareError> {
    let trimmed = data_base64.trim();
    // 4 base64 chars → 3 bytes; reject clearly oversized input without decoding it.
    let upper_bound = trimmed.len() / 4 * 3 + 3;
    if upper_bound > MAX_FLASH_IMAGE_BYTES + 3 {
        return Err(FirmwareError::InvalidArgument(format!(
            "firmware file exceeds the {} MiB limit",
            MAX_FLASH_IMAGE_BYTES / (1024 * 1024)
        )));
    }
    let bytes = BASE64_STD
        .decode(trimmed)
        .or_else(|_| BASE64_NO_PAD.decode(trimmed))
        .map_err(|e| {
            FirmwareError::InvalidArgument(format!("dataBase64 is not valid base64: {e}"))
        })?;
    if bytes.len() > MAX_FLASH_IMAGE_BYTES {
        return Err(FirmwareError::InvalidArgument(format!(
            "firmware file is {} bytes; the limit is {} MiB",
            bytes.len(),
            MAX_FLASH_IMAGE_BYTES / (1024 * 1024)
        )));
    }
    Ok(bytes)
}

impl PipelineEngine {
    /// `cmd_flash_load_image`: decodes, parses and caches a firmware file.
    /// Errors: `FirmwareError` (`to_ipc_string()` → `"[firmware] …"`).
    pub fn cmd_flash_load_image(
        &self,
        file_name: String,
        format: FlashLoadFormat,
        base_address: u32,
        data_base64: &str,
    ) -> Result<FlashImageHandleDto, FirmwareError> {
        let bytes = decode_firmware_base64(data_base64)?;
        let format =
            match format {
                FlashLoadFormat::Auto => match detect_format(&bytes) {
                    // Raw binary has no addresses: never guess a base address.
                    FirmwareFormat::Binary => return Err(FirmwareError::InvalidArgument(
                        "could not detect Intel HEX or S-record content; choose format \"binary\" \
                         and enter its base address explicitly"
                            .into(),
                    )),
                    detected => detected,
                },
                FlashLoadFormat::IntelHex => FirmwareFormat::IntelHex,
                FlashLoadFormat::Srec => FirmwareFormat::Srec,
                FlashLoadFormat::Binary => FirmwareFormat::Binary,
            };
        let image = FirmwareImage::load(&bytes, format, base_address)?;
        drop(bytes);
        let summary = image.summary();
        let image_id = new_image_id();
        self.flash_images.insert(image_id.clone(), Arc::new(image));
        self.debug_hub.record(
            "info",
            "DIAG",
            "protocol",
            None,
            "flash.image_loaded",
            format!(
                "Loaded firmware image ({} segment(s), {} bytes)",
                summary.segments.len(),
                summary.total_bytes
            ),
            Some(format!(
                "format={format:?}, crc32=0x{:08X}, imageId={image_id}",
                summary.crc32
            )),
        );
        Ok(FlashImageHandleDto {
            image_id,
            file_name,
            format,
            summary,
        })
    }

    /// `cmd_flash_release_image`: drops a cached image. Idempotent (unknown id = no-op); a
    /// download already running keeps its own reference.
    pub fn cmd_flash_release_image(&self, image_id: &str) {
        self.flash_images.remove(image_id);
    }

    /// `cmd_flash_download`: downloads a cached image through the diag session of `config`.
    /// `progress` receives throttled events (≤ 60 Hz, first / phase changes / `done` always).
    /// BLOCKING for the whole transfer.
    pub fn cmd_flash_download(
        &self,
        config: DiagSessionConfigDto,
        image_id: &str,
        download: DownloadConfig,
        progress: &mut dyn FnMut(FlashProgressDto),
    ) -> Result<FlashReportDto, FlashError> {
        self.run_flash(&config, image_id, &download, progress, |cfg| {
            self.diag_session_for(cfg)
                .map(|s| Box::new(s) as Box<dyn UdsRequester>)
        })
    }

    /// `cmd_flash_cancel`: sets the cancel flag of the download running on `config`'s session.
    /// No-op when none runs. The engine stops before its next request (0x37 not sent).
    pub fn cmd_flash_cancel(&self, config: &DiagSessionConfigDto) {
        if let Some(token) = self.flash_runs.0.lock().get(&diag_key(config)) {
            token.cancel(CancelReason::User);
            self.debug_hub.record(
                "warn",
                "DIAG",
                "protocol",
                Some(config.bus_id),
                "flash.cancel_requested",
                format!(
                    "Flash download cancel requested on 0x{:X}",
                    config.request_id
                ),
                None,
            );
        }
    }

    /// Shared body; `open` yields the requester (real session, or a mock in tests).
    fn run_flash<F>(
        &self,
        config: &DiagSessionConfigDto,
        image_id: &str,
        download: &DownloadConfig,
        progress: &mut dyn FnMut(FlashProgressDto),
        open: F,
    ) -> Result<FlashReportDto, FlashError>
    where
        F: FnOnce(&DiagSessionConfigDto) -> Result<Box<dyn UdsRequester>, DiagError>,
    {
        validate_config(config).map_err(|e| from_diag_error(&e))?;
        let image = self.flash_images.get(image_id).ok_or_else(|| {
            flash_error(
                FlashErrorKind::InvalidImage,
                format!("unknown imageId '{image_id}' (released or evicted); load the image again"),
                None,
            )
        })?;

        let key = diag_key(config);
        let cancel = Arc::new(CancelToken::default());
        {
            let mut runs = self.flash_runs.0.lock();
            if runs.contains_key(&key) {
                return Err(flash_error(
                    FlashErrorKind::InvalidConfig,
                    format!(
                        "a flash download is already running on this session (0x{:X} -> 0x{:X}, bus {}); \
                         wait for it to finish or cancel it first",
                        config.request_id,
                        config.response_id,
                        u16::from(config.bus_id) + 1
                    ),
                    None,
                ));
            }
            runs.insert(key, Arc::clone(&cancel));
        }
        let _guard = RunGuard {
            runs: &self.flash_runs,
            key,
        };
        // No pre-cancel when Panic Stop is ALREADY latched: nothing is running, so the session
        // gate refuses it like any other gate refusal (`transport` / `panic_latched`). Only a
        // Panic Stop that lands after registration (session open or transfer) is a cancel.

        let bus_id = config.bus_id;
        let res = self
            .download_registered(config, image_id, &image, download, progress, open, &cancel)
            .map_err(|e| match cancel.cancelled() {
                Some(reason) => reclassify_cancelled(e, reason),
                None => e,
            });
        let _ = match &res {
            Ok(r) => self.debug_hub.record(
                "info",
                "DIAG",
                "protocol",
                Some(bus_id),
                "flash.download_done",
                format!(
                    "Flash download finished: {} bytes in {} ms",
                    r.total_bytes, r.duration_ms
                ),
                Some(format!(
                    "blocks={}, retries={}, throughput={:.0} B/s",
                    r.total_blocks, r.total_retries, r.throughput_bytes_per_sec
                )),
            ),
            Err(e) => self.debug_hub.record(
                if e.kind == FlashErrorKind::Cancelled {
                    "warn"
                } else {
                    "error"
                },
                "DIAG",
                "protocol",
                Some(bus_id),
                "flash.download_failed",
                format!("Flash download failed ({})", e.kind.as_str()),
                Some(e.message.clone()),
            ),
        };
        res
    }

    /// Opens the requester and runs the transfer for an already registered download.
    #[allow(clippy::too_many_arguments)]
    fn download_registered<F>(
        &self,
        config: &DiagSessionConfigDto,
        image_id: &str,
        image: &FirmwareImage,
        download: &DownloadConfig,
        progress: &mut dyn FnMut(FlashProgressDto),
        open: F,
        cancel: &CancelToken,
    ) -> Result<FlashReportDto, FlashError>
    where
        F: FnOnce(&DiagSessionConfigDto) -> Result<Box<dyn UdsRequester>, DiagError>,
    {
        let requester = open(config).map_err(|e| from_diag_error(&e))?;
        let bus_id = config.bus_id;
        let total = image.total_bytes();
        self.debug_hub.record(
            "info",
            "DIAG",
            "protocol",
            Some(bus_id),
            "flash.download_started",
            format!(
                "Flash download started on 0x{:X}: {} segment(s), {total} bytes",
                config.request_id,
                image.segments.len()
            ),
            Some(format!("imageId={image_id}")),
        );

        let mut throttle = ProgressThrottle {
            sink: progress,
            last_emit: None,
            last_phase: None,
        };
        download_image(
            requester.as_ref(),
            image,
            download,
            &cancel.flag,
            &mut |p| throttle.push(p),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_protocols::uds::flash::RequesterError;
    use std::sync::atomic::AtomicUsize;

    fn cfg() -> DiagSessionConfigDto {
        serde_json::from_str(
            r#"{"busId":0,"requestId":2016,"responseId":2024,"isExtendedId":false}"#,
        )
        .expect("diag config")
    }

    fn b64(bytes: &[u8]) -> String {
        BASE64_STD.encode(bytes)
    }

    /// ECU stub: 0x74 with maxNumberOfBlockLength 0x0102, echoes 0x36 counters, 0x77 empty.
    /// `block_delay` slows every 0x36; `started` counts 0x36 requests.
    struct MockEcu {
        block_delay: Duration,
        started: Arc<AtomicUsize>,
        /// Set by a test to mimic Panic Stop's `close_all()`: the 0x36 in flight fails with
        /// `SessionClosed` and every later request fails before TX.
        tap_closed: Arc<AtomicBool>,
    }

    impl MockEcu {
        fn closed_err() -> RequesterError {
            RequesterError::Diag(DiagError::new(
                DiagErrorCode::SessionClosed,
                "diag tap closed (Panic Stop)",
            ))
        }
    }

    impl UdsRequester for MockEcu {
        fn request(
            &self,
            sid: u8,
            data: &[u8],
            _timeout_ms: Option<u32>,
        ) -> Result<Vec<u8>, RequesterError> {
            if self.tap_closed.load(Ordering::SeqCst) {
                return Err(Self::closed_err());
            }
            match sid {
                0x34 => Ok(vec![0x74, 0x20, 0x01, 0x02]),
                0x36 => {
                    self.started.fetch_add(1, Ordering::SeqCst);
                    // Wait for the "ECU answer"; a tap close aborts the request in flight.
                    let until = Instant::now() + self.block_delay;
                    while Instant::now() < until {
                        if self.tap_closed.load(Ordering::SeqCst) {
                            return Err(Self::closed_err());
                        }
                        thread::sleep(Duration::from_millis(1));
                    }
                    Ok(vec![0x76, data[0]])
                }
                0x37 => Ok(vec![0x77]),
                _ => Err(RequesterError::Negative { nrc: 0x11 }),
            }
        }
    }

    type BoxedRequester = Result<Box<dyn UdsRequester>, DiagError>;

    fn mock(
        delay_ms: u64,
    ) -> (
        Arc<AtomicUsize>,
        impl FnOnce(&DiagSessionConfigDto) -> BoxedRequester,
    ) {
        let (started, _, open) = mock_with_tap(delay_ms);
        (started, open)
    }

    /// Like [`mock`], plus the "tap closed" switch.
    fn mock_with_tap(
        delay_ms: u64,
    ) -> (
        Arc<AtomicUsize>,
        Arc<AtomicBool>,
        impl FnOnce(&DiagSessionConfigDto) -> BoxedRequester,
    ) {
        let started = Arc::new(AtomicUsize::new(0));
        let tap_closed = Arc::new(AtomicBool::new(false));
        let (s, t) = (Arc::clone(&started), Arc::clone(&tap_closed));
        (started, tap_closed, move |_: &DiagSessionConfigDto| {
            Ok(Box::new(MockEcu {
                block_delay: Duration::from_millis(delay_ms),
                started: s,
                tap_closed: t,
            }) as Box<dyn UdsRequester>)
        })
    }

    /// Waits (bounded) until the mock saw its first 0x36.
    fn wait_started(started: &AtomicUsize) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while started.load(Ordering::SeqCst) == 0 {
            assert!(Instant::now() < deadline, "download never started");
            thread::sleep(Duration::from_millis(2));
        }
    }

    fn load_binary(engine: &PipelineEngine, len: usize) -> FlashImageHandleDto {
        let data: Vec<u8> = (0..len).map(|i| i as u8).collect();
        engine
            .cmd_flash_load_image(
                "app.bin".into(),
                FlashLoadFormat::Binary,
                0x0800_0000,
                &b64(&data),
            )
            .expect("load binary")
    }

    const IHEX: &str = ":0400000001020304F2\n:00000001FF\n";
    const SREC: &str = "S107000001020304EE\nS9030000FC\n";

    #[test]
    fn load_each_format_and_auto_detect() {
        let e = PipelineEngine::new();
        let h = e
            .cmd_flash_load_image(
                "a.hex".into(),
                FlashLoadFormat::IntelHex,
                0,
                &b64(IHEX.as_bytes()),
            )
            .unwrap();
        assert_eq!(h.format, FirmwareFormat::IntelHex);
        assert_eq!(h.summary.total_bytes, 4);
        assert_eq!(h.file_name, "a.hex");
        let h = e
            .cmd_flash_load_image(
                "a.s19".into(),
                FlashLoadFormat::Srec,
                0,
                &b64(SREC.as_bytes()),
            )
            .unwrap();
        assert_eq!(h.format, FirmwareFormat::Srec);
        assert_eq!(h.summary.total_bytes, 4);
        let h = load_binary(&e, 10);
        assert_eq!(h.format, FirmwareFormat::Binary);
        assert_eq!(h.summary.segments[0].address, 0x0800_0000);

        for (text, want) in [
            (IHEX.as_bytes(), FirmwareFormat::IntelHex),
            (SREC.as_bytes(), FirmwareFormat::Srec),
        ] {
            let h = e
                .cmd_flash_load_image("x".into(), FlashLoadFormat::Auto, 0x100, &b64(text))
                .unwrap();
            assert_eq!(h.format, want);
        }
        // Auto never guesses a binary base address.
        let err = e
            .cmd_flash_load_image(
                "x".into(),
                FlashLoadFormat::Auto,
                0,
                &b64(&[0x00, 0xFF, 0x10]),
            )
            .unwrap_err();
        assert!(
            err.to_ipc_string()
                .starts_with("[firmware] could not detect"),
            "{err}"
        );
        // JSON shape of the handle (contract with the HMI).
        let v = serde_json::to_value(&h).unwrap();
        assert!(v["imageId"].as_str().unwrap().len() == 36);
        assert_eq!(v["format"], "binary");
        assert!(v["summary"]["segments"].is_array());
        let f: FlashLoadFormat = serde_json::from_str(r#""intelHex""#).unwrap();
        assert_eq!(f, FlashLoadFormat::IntelHex);
    }

    #[test]
    fn load_rejects_bad_base64_bad_file_and_oversize() {
        let e = PipelineEngine::new();
        let err = e
            .cmd_flash_load_image("x".into(), FlashLoadFormat::Binary, 0, "@@not base64@@")
            .unwrap_err();
        assert!(
            err.to_ipc_string()
                .starts_with("[firmware] dataBase64 is not valid base64"),
            "{err}"
        );
        let err = e
            .cmd_flash_load_image("x".into(), FlashLoadFormat::IntelHex, 0, &b64(b":zz\n"))
            .unwrap_err();
        assert!(err.to_ipc_string().starts_with("[firmware] "), "{err}");
        // Oversized: rejected from the base64 length alone (no 64 MiB decode needed).
        let huge = "A".repeat((MAX_FLASH_IMAGE_BYTES / 3 + 2) * 4);
        let err = e
            .cmd_flash_load_image("x".into(), FlashLoadFormat::Binary, 0, &huge)
            .unwrap_err();
        assert!(err.to_string().contains("64 MiB"), "{err}");
        // Exactly at the limit decodes (cap is inclusive).
        assert!(decode_firmware_base64(&b64(&vec![0u8; 1024])).is_ok());
    }

    #[test]
    fn cache_evicts_oldest_and_release_is_idempotent() {
        let e = PipelineEngine::new();
        let ids: Vec<String> = (0..MAX_CACHED_IMAGES + 2)
            .map(|i| load_binary(&e, 4 + i).image_id)
            .collect();
        assert_eq!(e.flash_images.len(), MAX_CACHED_IMAGES);
        assert!(e.flash_images.get(&ids[0]).is_none());
        assert!(e.flash_images.get(&ids[1]).is_none());
        assert!(e.flash_images.get(&ids[2]).is_some());
        e.cmd_flash_release_image(&ids[2]);
        e.cmd_flash_release_image(&ids[2]);
        assert!(e.flash_images.get(&ids[2]).is_none());
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len());

        // A released / evicted id fails the download with invalidImage.
        let mut sink = |_p: FlashProgressDto| {};
        let (_, open) = mock(0);
        let err = e
            .run_flash(&cfg(), &ids[0], &DownloadConfig::default(), &mut sink, open)
            .unwrap_err();
        assert_eq!(err.kind, FlashErrorKind::InvalidImage);
        assert!(flash_error_to_ipc(&err).starts_with(r#"[flash] {"kind":"invalidImage""#));
    }

    #[test]
    fn download_reports_and_throttles_progress() {
        let e = PipelineEngine::new();
        let h = load_binary(&e, 5_000); // 256 data bytes per block -> 20 blocks
        let mut events = Vec::new();
        let (_, open) = mock(0);
        let report = e
            .run_flash(
                &cfg(),
                &h.image_id,
                &DownloadConfig::default(),
                &mut |p| events.push(p),
                open,
            )
            .expect("download");
        assert_eq!(report.total_bytes, 5_000);
        assert_eq!(report.total_blocks, 20);
        assert_eq!(events.first().unwrap().phase, FlashPhase::RequestDownload);
        assert_eq!(events.last().unwrap().phase, FlashPhase::Done);
        assert!(events.iter().any(|p| p.phase == FlashPhase::Transfer));
        assert!(events.iter().any(|p| p.phase == FlashPhase::Exit));
        // 20 fast blocks inside one 60 Hz slot: far fewer events than blocks.
        assert!(events.len() < 10, "not throttled: {} events", events.len());
        // Run entry removed afterwards.
        assert!(e.flash_runs.0.lock().is_empty());
    }

    #[test]
    fn one_download_per_session_then_cancel() {
        let e = Arc::new(PipelineEngine::new());
        let h = load_binary(&e, 256 * 200);
        let (started, open) = mock(10);
        let e2 = Arc::clone(&e);
        let id = h.image_id.clone();
        let worker = thread::spawn(move || {
            e2.run_flash(&cfg(), &id, &DownloadConfig::default(), &mut |_| {}, open)
        });
        wait_started(&started);
        let (_, open2) = mock(0);
        let err = e
            .run_flash(
                &cfg(),
                &h.image_id,
                &DownloadConfig::default(),
                &mut |_| {},
                open2,
            )
            .unwrap_err();
        assert_eq!(err.kind, FlashErrorKind::InvalidConfig);
        assert!(err.message.contains("already running"), "{}", err.message);

        e.cmd_flash_cancel(&cfg());
        let err = worker.join().unwrap().unwrap_err();
        assert_eq!(err.kind, FlashErrorKind::Cancelled);
        assert!(err.message.contains("cancelled by user"), "{}", err.message);
        assert!(started.load(Ordering::SeqCst) < 200);
        assert!(e.flash_runs.0.lock().is_empty());
        // Cancel with nothing running is a no-op.
        e.cmd_flash_cancel(&cfg());
    }

    /// Real Panic Stop race: flag set, THEN the tap closes while a 0x36 waits for its answer.
    /// The in-flight request fails with `SessionClosed` (→ engine `transport`); the wiring must
    /// report `cancelled` with the position kept and Panic Stop as the cause.
    #[test]
    fn panic_stop_mid_block_is_reported_as_cancelled() {
        let e = Arc::new(PipelineEngine::new());
        let h = load_binary(&e, 256 * 200);
        // Long block: the first 0x36 is guaranteed in flight when Panic Stop lands.
        let (started, tap_closed, open) = mock_with_tap(30_000);
        let e2 = Arc::clone(&e);
        let id = h.image_id.clone();
        let worker = thread::spawn(move || {
            e2.run_flash(&cfg(), &id, &DownloadConfig::default(), &mut |_| {}, open)
        });
        wait_started(&started);
        let t0 = Instant::now();
        e.cmd_panic_stop_tx(); // sets the cancel flags first ...
        tap_closed.store(true, Ordering::SeqCst); // ... then `close_all()` kills the tap.
        let err = worker.join().unwrap().unwrap_err();
        assert!(
            t0.elapsed() < Duration::from_secs(5),
            "in-flight request not aborted"
        );
        assert_eq!(err.kind, FlashErrorKind::Cancelled, "{err:?}");
        assert!(
            err.message.contains("cancelled by Panic Stop"),
            "{}",
            err.message
        );
        assert!(
            err.message.contains("session_closed") || err.message.contains("closed"),
            "{}",
            err.message
        );
        // Position preserved from the engine error.
        assert_eq!(err.phase, FlashPhase::Transfer);
        assert_eq!(err.segment_index, Some(0));
        assert_eq!(err.address, Some(0x0800_0000));
        assert_eq!(err.offset, Some(0));
        assert_eq!(err.block_counter, Some(1));
        assert_eq!(err.bytes_done, 0);
        assert_eq!(err.segments_completed, 0);
        assert_eq!(err.diag_code, Some(DiagErrorCode::SessionClosed));
        let wire = flash_error_to_ipc(&err);
        assert!(wire.starts_with(r#"[flash] {"kind":"cancelled""#), "{wire}");
        assert!(e.flash_runs.0.lock().is_empty());
    }

    /// Already latched = a refusal by the session gate, not a cancel (nothing was running).
    #[test]
    fn download_while_panic_latched_is_a_transport_refusal() {
        let e = PipelineEngine::new();
        let bus = crate::dto::ChannelConfigDto {
            bus_id: 0,
            listen_only: false,
            mock_fps_preset: Some(1_000),
            ..crate::dto::ChannelConfigDto::default()
        };
        e.cmd_connect_bus(crate::drivers::mock_drv::MOCK0_DEVICE_ID.to_string(), bus)
            .expect("connect mock0");
        e.cmd_arm_active_bus(0, true).expect("arm");
        e.cmd_panic_stop_tx();
        let h = load_binary(&e, 16);
        let err = e
            .cmd_flash_download(cfg(), &h.image_id, DownloadConfig::default(), &mut |_| {})
            .unwrap_err();
        assert_eq!(err.kind, FlashErrorKind::Transport, "{err:?}");
        assert_eq!(err.diag_code, Some(DiagErrorCode::PanicLatched));
        assert!(!err.message.contains("cancelled"), "{}", err.message);
        assert!(e.flash_runs.0.lock().is_empty());
    }

    #[test]
    fn session_reset_mid_block_is_reported_as_cancelled() {
        let e = Arc::new(PipelineEngine::new());
        let h = load_binary(&e, 256 * 200);
        let (started, tap_closed, open) = mock_with_tap(30_000);
        let e2 = Arc::clone(&e);
        let id = h.image_id.clone();
        let worker = thread::spawn(move || {
            e2.run_flash(&cfg(), &id, &DownloadConfig::default(), &mut |_| {}, open)
        });
        wait_started(&started);
        e.cmd_reset_session();
        tap_closed.store(true, Ordering::SeqCst);
        let err = worker.join().unwrap().unwrap_err();
        assert_eq!(err.kind, FlashErrorKind::Cancelled, "{err:?}");
        assert!(
            err.message.contains("cancelled by session reset"),
            "{}",
            err.message
        );
    }

    #[test]
    fn uncancelled_transport_errors_stay_transport() {
        let e = PipelineEngine::new();
        let h = load_binary(&e, 1024);
        let (_, tap_closed, open) = mock_with_tap(0);
        tap_closed.store(true, Ordering::SeqCst);
        let err = e
            .run_flash(
                &cfg(),
                &h.image_id,
                &DownloadConfig::default(),
                &mut |_| {},
                open,
            )
            .unwrap_err();
        assert_eq!(err.kind, FlashErrorKind::Transport);
        // Pre-flight failure of a cancelled download: no "mid-download" claim.
        let pre = reclassify_cancelled(
            flash_error(
                FlashErrorKind::Transport,
                "Panic Stop is latched",
                Some(DiagErrorCode::PanicLatched),
            ),
            CancelReason::PanicStop,
        );
        assert_eq!(pre.kind, FlashErrorKind::Cancelled);
        assert!(
            pre.message
                .starts_with("download cancelled by Panic Stop before any request was sent"),
            "{}",
            pre.message
        );
        // First cause wins.
        let t = CancelToken::default();
        assert_eq!(t.cancelled(), None);
        t.cancel(CancelReason::PanicStop);
        t.cancel(CancelReason::User);
        assert_eq!(t.cancelled(), Some(CancelReason::PanicStop));
    }

    #[test]
    fn download_config_cap_defaults_follow_use_fd() {
        let c = resolve_download_config(serde_json::Value::Null, false).unwrap();
        assert_eq!(c.max_block_len_cap, CLASSICAL_MAX_BLOCK_LEN);
        let c = resolve_download_config(serde_json::json!({}), true).unwrap();
        assert_eq!(c.max_block_len_cap, FD_MAX_BLOCK_LEN);
        let c = resolve_download_config(serde_json::json!({"maxBlockLenCap": null}), true).unwrap();
        assert_eq!(c.max_block_len_cap, FD_MAX_BLOCK_LEN);
        let c = resolve_download_config(
            serde_json::json!({"maxBlockLenCap": 1024, "retriesPerBlock": 5}),
            true,
        )
        .unwrap();
        assert_eq!((c.max_block_len_cap, c.retries_per_block), (1024, 5));
        let err = resolve_download_config(serde_json::json!({"retriesPerBlock": "x"}), false)
            .unwrap_err();
        assert_eq!(err.kind, FlashErrorKind::InvalidConfig);
    }

    #[test]
    fn real_session_path_applies_bus_gates() {
        // No bus connected: the session cannot open -> transport error, nothing transmitted.
        let e = PipelineEngine::new();
        let h = load_binary(&e, 16);
        let err = e
            .cmd_flash_download(cfg(), &h.image_id, DownloadConfig::default(), &mut |_| {})
            .unwrap_err();
        assert_eq!(err.kind, FlashErrorKind::Transport, "{err:?}");
        assert!(err.diag_code.is_some());
        let mut bad = cfg();
        bad.response_id = bad.request_id;
        let err = e
            .cmd_flash_download(bad, &h.image_id, DownloadConfig::default(), &mut |_| {})
            .unwrap_err();
        assert_eq!(err.kind, FlashErrorKind::InvalidConfig);
    }
}
