//! Async core of [`super::UdsSession`]: ISO-TP stack lifecycle, the request/response state
//! machine (P2 / P2* / 0x78, stale filtering), conversation logging, ECU state tracking and the
//! background TesterPresent task.
//!
//! Why our own request state machine instead of `automotive::protocols::uds::UDSClient`:
//! the crate client (=0.6.0) returns NRCs as errors without the raw PDU, hides each 0x78 and its
//! timing, reports a single `Timeout` for P2, P2* and transport stages, applies P2 to the whole
//! reception (P6) instead of the response start, subscribes per request (late PDUs of an earlier
//! request are taken as the answer to the next one), and panics in some helpers
//! (`security_access(level, None)` on an empty seed, `RwLock::read().unwrap()`). We keep the
//! crate's ISO-TP transport (segmentation, flow control, N_As/N_Bs/N_Cr, CAN-FD) and own the UDS
//! timing layer, which is exactly where NexusCAN needs evidence for the interpretation layer.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use automotive::can::AsyncCanAdapter;
use automotive::transports::isotp::{IsoTP, IsoTPConfig};
use automotive::{Stream, StreamExt, Transport};
use crossbeam_channel::{Receiver, Sender};
use nexus_core::now_monotonic_us;
use parking_lot::Mutex;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use super::bridge::{BridgeShared, PduMark, PortAdapter, PortMsg, ISOTP_MAX_WFT, MAX_RESPONSE_PDU};
use super::capture::TxnTag;
use super::conversation::{Conversation, NewEvent};
use super::format::{negative_code, parse_session_timing, request_sid_of_response, request_suppresses_positive, response_matches};
use super::nrc::NRC_RESPONSE_PENDING;
use crate::uds::dto::{
    ConversationEventKind, DiagError, DiagErrorCode, DiagOrigin, DiagSessionConfigDto, UdsAddressing,
};
use crate::uds::port::{DiagCanPort, DiagTxReject};

/// Default P2server when the ECU did not report one (ISO 14229-2 default).
pub const DEFAULT_P2_MS: u32 = 50;
/// Default P2*server when the ECU did not report one (ISO 14229-2 default).
pub const DEFAULT_P2_STAR_MS: u32 = 5000;
/// Default TesterPresent interval.
pub const DEFAULT_TP_INTERVAL_MS: u32 = 2000;
/// Accepted TesterPresent interval range.
pub const TP_INTERVAL_RANGE_MS: std::ops::RangeInclusive<u32> = 100..=60_000;
/// ISO-TP N_As / N_Bs / N_Cr (crate default).
pub const ISOTP_TIMEOUT: Duration = Duration::from_millis(1000);
/// While a multi-frame response that started in time is still being received, the response
/// deadline is extended in these steps (ISO-TP N_Cr still bounds each gap).
const RX_EXTENSION: Duration = Duration::from_millis(100);
/// Absolute upper bound for one exchange (safety net only).
const MAX_EXCHANGE: Duration = Duration::from_secs(600);
/// Largest request PDU accepted (`automotive` would segment up to 4 GiB over CAN-FD).
pub const MAX_REQUEST_PDU: usize = 64 * 1024;
/// Largest STmin an ECU can demand (0x7F); used to size the send deadline of long requests.
const MAX_STMIN: Duration = Duration::from_millis(127);
/// Best-effort S3 loss heuristic: NRC 0x7F / 0x33 in a believed non-default session after the
/// tester was silent at least this long (and TesterPresent off) → assume the ECU fell back to
/// the default session. 2 s is the usual S3client; S3server is 5 s (ecusim: 3 s).
const S3_LOSS_GAP: Duration = Duration::from_millis(2000);

pub fn err(code: DiagErrorCode, msg: impl Into<String>) -> DiagError {
    DiagError::new(code, msg)
}

pub fn reject_code(r: DiagTxReject) -> (DiagErrorCode, &'static str) {
    match r {
        DiagTxReject::ListenOnly => (DiagErrorCode::ListenOnly, "listen_only"),
        DiagTxReject::Disarmed => (DiagErrorCode::Disarmed, "disarmed"),
        DiagTxReject::PanicLatched => (DiagErrorCode::PanicLatched, "panic_latched"),
        DiagTxReject::Closed => (DiagErrorCode::SessionClosed, "closed"),
        DiagTxReject::QueueFull => (DiagErrorCode::Busy, "queue_full"),
        DiagTxReject::DriverError => (DiagErrorCode::Internal, "driver_error"),
    }
}

fn reject_message(r: DiagTxReject) -> &'static str {
    match r {
        DiagTxReject::ListenOnly => "bus is in Listen-Only mode",
        DiagTxReject::Disarmed => "bus is not armed for active TX (Arm Active Bus first)",
        DiagTxReject::PanicLatched => "Panic Stop is latched",
        DiagTxReject::Closed => "diagnostic tap was closed",
        DiagTxReject::QueueFull => "tap TX queue is full",
        DiagTxReject::DriverError => "CAN driver reported a write error",
    }
}

fn us(d: Duration) -> u64 {
    u64::try_from(d.as_micros()).unwrap_or(u64::MAX)
}

/// Mutable ECU-side view for `DiagSessionInfoDto`.
#[derive(Debug, Clone)]
pub struct EcuState {
    pub active_session: u8,
    pub unlocked_level: Option<u8>,
    pub p2_server_ms: Option<u32>,
    pub p2_star_server_ms: Option<u32>,
    pub tester_present_enabled: bool,
    pub tester_present_interval_ms: u32,
    /// TX confirmation time of the last request (any, incl. keepalive).
    pub last_tx_at: Option<Instant>,
}

impl Default for EcuState {
    fn default() -> Self {
        Self {
            active_session: 1,
            unlocked_level: None,
            p2_server_ms: None,
            p2_star_server_ms: None,
            tester_present_enabled: false,
            tester_present_interval_ms: DEFAULT_TP_INTERVAL_MS,
            last_tx_at: None,
        }
    }
}

/// Last request of this session (for attributing late responses).
#[derive(Debug, Clone)]
struct ReqInfo {
    seq: u64,
    bytes: Vec<u8>,
    addressing: UdsAddressing,
    origin: DiagOrigin,
    ts: u64,
    hw: bool,
    at: Instant,
}

impl ReqInfo {
    /// `(event timestamp, elapsed since request)` for a PDU, preferring HAL timestamps when both
    /// sides come from the same clock.
    fn timing(&self, mark: Option<&PduMark>) -> (u64, u64) {
        match mark {
            Some(m) if m.end_hw == self.hw && m.end_ts >= self.ts => (m.end_ts, m.end_ts - self.ts),
            Some(m) => (m.end_ts, us(m.end_at.saturating_duration_since(self.at))),
            None => {
                let e = us(self.at.elapsed());
                (self.ts.saturating_add(e), e)
            }
        }
    }
}

pub enum RxItem {
    Pdu { pdu: Vec<u8>, mark: Option<PduMark> },
    Error(automotive::Error),
    /// The ISO-TP receive stream ended (worker stopped: TX refused, port closed).
    Ended,
}

struct Stack {
    adapter: Arc<AsyncCanAdapter>,
    phys: IsoTP<'static>,
    func: Option<IsoTP<'static>>,
    rx_task: JoinHandle<()>,
}

/// Guarded by the request lock: one outstanding request per ECU (incl. keepalive).
#[derive(Default)]
pub struct Engine {
    stack: Option<Stack>,
}

/// Result of one exchange.
pub struct Exchange {
    pub raw: Vec<u8>,
    pub suppressed: bool,
    pub pending_count: u32,
    pub elapsed_us: u64,
    pub seq: u64,
}

pub struct Inner {
    pub config: DiagSessionConfigDto,
    /// Released on `close()` so the HAL tap is freed even while `Arc<UdsSession>` lives on.
    port: Mutex<Option<Arc<dyn DiagCanPort>>>,
    pub bridge: Arc<BridgeShared>,
    pub kick: Sender<PortMsg>,
    port_rx: Receiver<PortMsg>,
    phys_cfg: IsoTPConfig,
    func_cfg: Option<IsoTPConfig>,
    pub log: Mutex<Conversation>,
    pub state: Mutex<EcuState>,
    slot: Mutex<Option<mpsc::Sender<RxItem>>>,
    last_request: Mutex<Option<ReqInfo>>,
    pub engine: tokio::sync::Mutex<Engine>,
    /// Current `automotive` adapter, for deterministic shutdown outside the runtime.
    pub adapter_handle: Mutex<Option<Arc<AsyncCanAdapter>>>,
    /// Closed by the client (`close()` / drop).
    pub client_closed: AtomicBool,
    closed_logged: AtomicBool,
    pub tp_cfg: watch::Sender<(bool, u32)>,
}

impl Inner {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        config: DiagSessionConfigDto,
        port: Arc<dyn DiagCanPort>,
        bridge: Arc<BridgeShared>,
        kick: Sender<PortMsg>,
        port_rx: Receiver<PortMsg>,
        phys_cfg: IsoTPConfig,
        func_cfg: Option<IsoTPConfig>,
    ) -> Self {
        let (tp_cfg, _) = watch::channel((false, DEFAULT_TP_INTERVAL_MS));
        Self {
            config,
            port: Mutex::new(Some(port)),
            bridge,
            kick,
            port_rx,
            phys_cfg,
            func_cfg,
            log: Mutex::new(Conversation::default()),
            state: Mutex::new(EcuState::default()),
            slot: Mutex::new(None),
            last_request: Mutex::new(None),
            engine: tokio::sync::Mutex::new(Engine::default()),
            adapter_handle: Mutex::new(None),
            client_closed: AtomicBool::new(false),
            closed_logged: AtomicBool::new(false),
            tp_cfg,
        }
    }

    pub fn port(&self) -> Option<Arc<dyn DiagCanPort>> {
        self.port.lock().clone()
    }

    pub fn release_port(&self) {
        self.port.lock().take();
    }

    pub fn hal_closed(&self) -> bool {
        self.bridge.hal_closed.load(Ordering::Acquire) || self.port().is_none_or(|p| p.is_closed())
    }

    pub fn is_closed(&self) -> bool {
        self.client_closed.load(Ordering::Acquire) || self.hal_closed()
    }

    pub fn push(&self, ev: NewEvent) -> u64 {
        self.log.lock().push(ev)
    }

    /// Logs `session_closed` once.
    pub fn log_closed(&self, detail: &str) {
        if !self.closed_logged.swap(true, Ordering::AcqRel) {
            self.push(
                NewEvent::new(ConversationEventKind::SessionClosed, UdsAddressing::Physical, now_monotonic_us())
                    .detail(detail),
            );
        }
    }

    fn closed_error(&self) -> DiagError {
        if self.client_closed.load(Ordering::Acquire) {
            err(DiagErrorCode::SessionClosed, "UDS session was closed")
        } else {
            self.log_closed("tap_closed");
            err(DiagErrorCode::SessionClosed, "diagnostic tap was closed by the bus (disconnect, panic, disarm or mode change)")
        }
    }

    /// `(P2client, P2*client)`: ECU-reported (or default) + configured margin.
    pub fn timings(&self) -> (Duration, Duration) {
        let st = self.state.lock();
        let margin = u64::from(self.config.p2_margin_ms);
        let p2 = u64::from(st.p2_server_ms.unwrap_or(DEFAULT_P2_MS)) + margin;
        let p2s = u64::from(st.p2_star_server_ms.unwrap_or(DEFAULT_P2_STAR_MS)) + margin;
        (Duration::from_millis(p2), Duration::from_millis(p2s))
    }

    fn max_sf_len(&self) -> usize {
        if self.config.use_fd {
            62
        } else {
            7
        }
    }

    /// Total time allowed for sending one request: `max(P2*client, N_Bs × (N_WFTmax + 1))` plus the
    /// worst-case STmin for every consecutive frame of a multi-frame request.
    fn send_budget(&self, len: usize) -> Duration {
        let (_, p2s) = self.timings();
        let base = p2s.max(ISOTP_TIMEOUT * (ISOTP_MAX_WFT + 1));
        let cf_payload = if self.config.use_fd { 63 } else { 7 };
        let cfs = len.saturating_sub(self.max_sf_len()).div_ceil(cf_payload);
        base + MAX_STMIN * u32::try_from(cfs).unwrap_or(u32::MAX).min(100_000)
    }

    /// Tears the ISO-TP stack down after an aborted send; [`Self::ensure_stack`] rebuilds it.
    /// The old worker is joined (off the runtime thread) before a new one may share the port queue.
    async fn reset_stack(&self, eng: &mut Engine) {
        let Some(old) = eng.stack.take() else { return };
        old.rx_task.abort();
        let adapter = old.adapter.clone();
        drop(old);
        let kick = self.kick.clone();
        let _ = tokio::task::spawn_blocking(move || {
            // `close` signals shutdown and joins; the worker notices on its next wake-up.
            let waker = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1));
                let _ = kick.try_send(PortMsg::Kick);
            });
            adapter.close();
            let _ = waker.join();
        })
        .await;
    }

    // ─── stack lifecycle ────────────────────────────────────────────────────

    fn ensure_stack(self: &Arc<Self>, eng: &mut Engine) -> Result<(), DiagError> {
        if self.is_closed() {
            return Err(self.closed_error());
        }
        if eng.stack.as_ref().is_some_and(|s| !s.rx_task.is_finished()) {
            return Ok(());
        }
        if let Some(old) = eng.stack.take() {
            old.rx_task.abort();
            // Worker already stopped (that is why the stream ended); this only joins it.
            old.adapter.close();
        }
        // Events queued for the stopped worker are stale.
        while self.port_rx.try_recv().is_ok() {}
        let Some(port) = self.port() else {
            return Err(self.closed_error());
        };
        let adapter = Arc::new(AsyncCanAdapter::new(PortAdapter::new(
            self.port_rx.clone(),
            port,
            self.bridge.clone(),
        )));
        let phys = IsoTP::new_owned(adapter.clone(), self.phys_cfg);
        let func = self.func_cfg.map(|c| IsoTP::new_owned(adapter.clone(), c));
        // Persistent receiver: subscribes now and keeps reassembling / sending FC even while
        // no request is waiting, so late multi-frame answers never desynchronise ISO-TP.
        let stream = phys.clone().into_recv();
        let rx_task = tokio::spawn(rx_loop(self.clone(), stream));
        *self.adapter_handle.lock() = Some(adapter.clone());
        eng.stack = Some(Stack { adapter, phys, func, rx_task });
        Ok(())
    }

    fn deliver(&self, item: RxItem) {
        let sender = self.slot.lock().clone();
        let undelivered = match sender {
            Some(tx) => tx.try_send(item).err().map(|e| match e {
                mpsc::error::TrySendError::Full(i) | mpsc::error::TrySendError::Closed(i) => i,
            }),
            None => Some(item),
        };
        match undelivered {
            Some(RxItem::Pdu { pdu, mark }) => self.log_stale(&pdu, mark.as_ref(), None),
            Some(RxItem::Error(e)) => {
                self.push(
                    NewEvent::new(ConversationEventKind::TransportError, UdsAddressing::Physical, now_monotonic_us())
                        .detail(isotp_detail(&e)),
                );
            }
            Some(RxItem::Ended) | None => {}
        }
    }

    fn log_stale(&self, pdu: &[u8], mark: Option<&PduMark>, current: Option<&ReqInfo>) {
        let previous = self.last_request.lock().clone();
        let owner = previous
            .as_ref()
            .filter(|r| response_matches(&r.bytes, pdu))
            .or(current.filter(|r| response_matches(&r.bytes, pdu)));
        let (ts, elapsed) = match owner {
            Some(r) => {
                let (ts, e) = r.timing(mark);
                (ts, Some(e))
            }
            None => (mark.map_or_else(now_monotonic_us, |m| m.end_ts), None),
        };
        self.push(
            NewEvent::new(
                ConversationEventKind::StaleResponseDropped,
                owner.map_or(UdsAddressing::Physical, |r| r.addressing),
                ts,
            )
            .sid(request_sid_of_response(pdu))
            .bytes(pdu)
            .request(owner.map(|r| r.seq), elapsed)
            .nrc(negative_code(pdu))
            .detail(if owner.is_some() { "late" } else { "unsolicited" })
            .origin(owner.map_or(DiagOrigin::Other, |r| r.origin)),
        );
    }

    /// Pushes the event that ends a transaction which never fully reached the bus and binds the
    /// frames already sent (if any) to it.
    fn push_failure(&self, ev: NewEvent, tag: Option<&TxnTag<'_>>) {
        let seq = self.push(ev);
        if let Some(t) = tag {
            t.bind(seq);
        }
    }

    fn log_blocked(
        &self,
        req: &[u8],
        addressing: UdsAddressing,
        origin: DiagOrigin,
        r: DiagTxReject,
        tag: Option<&TxnTag<'_>>,
    ) -> DiagError {
        let (code, detail) = reject_code(r);
        self.push_failure(
            NewEvent::new(ConversationEventKind::TxBlocked, addressing, now_monotonic_us())
                .sid(req.first().copied())
                .bytes(req)
                .detail(detail)
                .origin(origin),
            tag,
        );
        if r == DiagTxReject::Closed {
            return self.closed_error();
        }
        err(code, reject_message(r))
    }

    /// Error for a stopped ISO-TP worker: typed TX rejection, closed tap, or internal.
    fn stopped_error(
        &self,
        req: &[u8],
        addressing: UdsAddressing,
        origin: DiagOrigin,
        tag: Option<&TxnTag<'_>>,
    ) -> DiagError {
        if let Some(r) = self.bridge.last_reject() {
            return self.log_blocked(req, addressing, origin, r, tag);
        }
        if self.is_closed() {
            return self.closed_error();
        }
        err(DiagErrorCode::Internal, "ISO-TP worker stopped unexpectedly")
    }

    fn send_error(
        &self,
        e: automotive::Error,
        req: &[u8],
        addressing: UdsAddressing,
        origin: DiagOrigin,
        tag: &TxnTag<'_>,
    ) -> DiagError {
        use automotive::transports::isotp::Error as TpError;
        match e {
            automotive::Error::IoError(_) | automotive::Error::Disconnected | automotive::Error::Cancelled => {
                self.stopped_error(req, addressing, origin, Some(tag))
            }
            automotive::Error::Timeout => {
                self.push_failure(
                    NewEvent::new(ConversationEventKind::Timeout, addressing, now_monotonic_us())
                        .sid(req.first().copied())
                        .bytes(req)
                        .detail("isotp")
                        .origin(origin),
                    Some(tag),
                );
                err(
                    DiagErrorCode::TimeoutIsotp,
                    format!("request not sent: no TX confirmation / flow control within {} ms (N_As/N_Bs)", ISOTP_TIMEOUT.as_millis()),
                )
            }
            automotive::Error::NotSupported => {
                err(DiagErrorCode::InvalidInput, "CAN-FD frame requested on a channel without CAN-FD")
            }
            automotive::Error::IsoTPError(TpError::DataTooLarge) => {
                err(DiagErrorCode::InvalidInput, "request PDU too large for ISO-TP")
            }
            other => {
                let detail = isotp_detail(&other);
                self.push_failure(
                    NewEvent::new(ConversationEventKind::TransportError, addressing, now_monotonic_us())
                        .sid(req.first().copied())
                        .bytes(req)
                        .detail(detail.clone())
                        .origin(origin),
                    Some(tag),
                );
                err(DiagErrorCode::IsotpError, format!("ISO-TP send failed: {detail}"))
            }
        }
    }

    // ─── request / response ─────────────────────────────────────────────────

    /// One request/response exchange. Caller holds the request lock (`eng`).
    /// `keepalive` logs `keepalive_sent` instead of `request` and forces origin `keepalive`.
    pub async fn exchange(
        self: &Arc<Self>,
        eng: &mut Engine,
        req: &[u8],
        addressing: UdsAddressing,
        total: Option<Duration>,
        origin: DiagOrigin,
        keepalive: bool,
    ) -> Result<Exchange, DiagError> {
        let origin = if keepalive { DiagOrigin::Keepalive } else { origin };
        let Some(&sid) = req.first() else {
            return Err(err(DiagErrorCode::InvalidInput, "empty request"));
        };
        if self.is_closed() {
            return Err(self.closed_error());
        }
        if req.len() > MAX_REQUEST_PDU {
            return Err(err(
                DiagErrorCode::InvalidInput,
                format!("request PDU of {} bytes exceeds the {MAX_REQUEST_PDU}-byte limit", req.len()),
            ));
        }
        if addressing == UdsAddressing::Functional {
            if self.func_cfg.is_none() {
                return Err(err(DiagErrorCode::InvalidInput, "functional addressing requested but no functionalId configured"));
            }
            if req.len() > self.max_sf_len() {
                return Err(err(
                    DiagErrorCode::InvalidInput,
                    format!("functional requests must fit one single frame ({} bytes max)", self.max_sf_len()),
                ));
            }
        }
        let Some(port) = self.port() else {
            return Err(self.closed_error());
        };
        if let Err(r) = port.gate_check() {
            return Err(self.log_blocked(req, addressing, origin, r, None));
        }
        self.ensure_stack(eng)?;
        let Some(stack) = eng.stack.as_ref() else {
            return Err(err(DiagErrorCode::Internal, "ISO-TP stack unavailable"));
        };
        let transport = match addressing {
            UdsAddressing::Physical => &stack.phys,
            UdsAddressing::Functional => match stack.func.as_ref() {
                Some(f) => f,
                None => return Err(err(DiagErrorCode::InvalidInput, "no functionalId configured")),
            },
        };

        let (tx, mut rx) = mpsc::channel::<RxItem>(32);
        *self.slot.lock() = Some(tx);
        self.bridge.clear_reject();
        // Accept response First Frames from now on (idle FFs are dropped, HIGH-07.3).
        self.bridge.open_rx();
        self.bridge.arm_tx();
        let arm_seq = self.bridge.seq_now();
        // Traffic Dock: every frame captured from here until `tag` drops belongs to this
        // exchange. Set before the first request frame can reach the port (the ISO-TP send
        // below queues it), so the request's own SF / FF confirmation is tagged too.
        let tag = self.bridge.capture.begin_txn();
        let _ = self.kick.try_send(PortMsg::Kick);

        // HIGH-07.2: `automotive` restarts N_Bs on every FC.WAIT, so a misbehaving ECU could hold
        // the send (and the session lock) forever. Bound it by a WAIT count (sender-side N_WFTmax)
        // and a total send deadline; on abort the ISO-TP stack is rebuilt for the next request.
        let budget = self.send_budget(req.len());
        let sent = tokio::select! {
            r = Transport::send(transport, req) => Ok(r),
            () = self.bridge.wait_fc_limit() => Err("isotp_fc_wait"),
            () = tokio::time::sleep(budget) => Err("isotp_send_deadline"),
        };
        let confirm = self.bridge.disarm_tx();
        let sent = match sent {
            Ok(r) => r,
            Err(detail) => {
                self.finish_slot(&mut rx, None);
                self.push_failure(
                    NewEvent::new(ConversationEventKind::Timeout, addressing, now_monotonic_us())
                        .sid(Some(sid))
                        .bytes(req)
                        .detail(detail)
                        .origin(origin),
                    Some(&tag),
                );
                drop(tag);
                self.reset_stack(eng).await;
                let msg = if detail == "isotp_fc_wait" {
                    format!("request not sent: ECU answered with more than {ISOTP_MAX_WFT} Flow Control WAIT frames")
                } else {
                    format!("request not sent within {} ms (flow control / TX confirmation stalled)", budget.as_millis())
                };
                return Err(err(DiagErrorCode::TimeoutIsotp, msg));
            }
        };
        if let Err(e) = sent {
            self.finish_slot(&mut rx, None);
            return Err(self.send_error(e, req, addressing, origin, &tag));
        }

        let (sent_at, req_ts, req_hw) = match confirm {
            Some(c) => (c.at, c.ts, c.hw),
            None => (Instant::now(), now_monotonic_us(), false),
        };
        let kind = if keepalive { ConversationEventKind::KeepaliveSent } else { ConversationEventKind::Request };
        let seq = self.push(NewEvent::new(kind, addressing, req_ts).sid(Some(sid)).bytes(req).origin(origin));
        tag.bind(seq);
        let current = ReqInfo { seq, bytes: req.to_vec(), addressing, origin, ts: req_ts, hw: req_hw, at: sent_at };
        let gap = {
            let mut st = self.state.lock();
            let gap = st.last_tx_at.map(|t| sent_at.saturating_duration_since(t));
            st.last_tx_at = Some(sent_at);
            gap
        };

        let result = self.await_response(&mut rx, &current, arm_seq, total, gap).await;
        // Final event (response / timeout / error) is logged: the last RX CF is already tagged.
        drop(tag);
        self.finish_slot(&mut rx, Some(&current));
        *self.last_request.lock() = Some(current);
        result
    }

    async fn await_response(
        &self,
        rx: &mut mpsc::Receiver<RxItem>,
        req: &ReqInfo,
        arm_seq: u64,
        total: Option<Duration>,
        gap: Option<Duration>,
    ) -> Result<Exchange, DiagError> {
        let suppress = request_suppresses_positive(&req.bytes);
        let (p2c, p2sc) = self.timings();
        let sid = req.bytes.first().copied();
        let hard = req.at + total.unwrap_or(MAX_EXCHANGE).min(MAX_EXCHANGE);
        let mut deadline = req.at + total.map_or(p2c, |t| t.min(MAX_EXCHANGE));
        let mut pending: u32 = 0;
        loop {
            let item = tokio::select! {
                r = tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), rx.recv()) => r,
                len = self.bridge.wait_oversize(arm_seq) => {
                    // HIGH-07.1: the FF was dropped before `automotive` (no FC.CTS, nothing buffered).
                    let elapsed = us(req.at.elapsed());
                    self.push(
                        NewEvent::new(ConversationEventKind::TransportError, req.addressing, req.ts.saturating_add(elapsed))
                            .sid(sid)
                            .request(Some(req.seq), Some(elapsed))
                            .detail("isotp_pdu_too_large")
                            .origin(req.origin),
                    );
                    return Err(err(
                        DiagErrorCode::IsotpError,
                        format!("response too large: First Frame announces {len} bytes (limit {MAX_RESPONSE_PDU})"),
                    ));
                }
            };
            let item = match item {
                Ok(Some(i)) => i,
                Ok(None) => RxItem::Ended,
                Err(_) => {
                    if suppress && pending == 0 {
                        return Ok(Exchange {
                            raw: Vec::new(),
                            suppressed: true,
                            pending_count: 0,
                            elapsed_us: us(req.at.elapsed()),
                            seq: req.seq,
                        });
                    }
                    let now = Instant::now();
                    if now < hard && self.bridge.rx_in_progress_after(arm_seq) {
                        deadline = (now + RX_EXTENSION).min(hard);
                        continue;
                    }
                    let elapsed = us(req.at.elapsed());
                    let (code, phase, budget) = if pending > 0 {
                        (DiagErrorCode::TimeoutP2Star, "p2_star", p2sc)
                    } else {
                        (DiagErrorCode::TimeoutP2, "p2", total.unwrap_or(p2c))
                    };
                    self.push(
                        NewEvent::new(ConversationEventKind::Timeout, req.addressing, req.ts.saturating_add(elapsed))
                            .sid(sid)
                            .request(Some(req.seq), Some(elapsed))
                            .detail(phase)
                            .origin(req.origin),
                    );
                    let what = if pending > 0 {
                        format!("no final response within P2* {} ms after {pending} x 0x78", budget.as_millis())
                    } else {
                        format!("no response within {} ms (P2 client)", budget.as_millis())
                    };
                    return Err(err(code, what));
                }
            };
            match item {
                RxItem::Ended => {
                    return Err(self.stopped_error(&req.bytes, req.addressing, req.origin, None));
                }
                RxItem::Error(automotive::Error::IsoTPError(automotive::transports::isotp::Error::UnexpectedPdu)) => {
                    // A new SF/FF replaced an unfinished reception; the replacement follows.
                    self.push(
                        NewEvent::new(ConversationEventKind::TransportError, req.addressing, now_monotonic_us())
                            .sid(sid)
                            .request(Some(req.seq), Some(us(req.at.elapsed())))
                            .detail("isotp_unexpected_pdu")
                            .origin(req.origin),
                    );
                }
                RxItem::Error(automotive::Error::Timeout) => {
                    let elapsed = us(req.at.elapsed());
                    self.push(
                        NewEvent::new(ConversationEventKind::Timeout, req.addressing, req.ts.saturating_add(elapsed))
                            .sid(sid)
                            .request(Some(req.seq), Some(elapsed))
                            .detail("isotp")
                            .origin(req.origin),
                    );
                    return Err(err(
                        DiagErrorCode::TimeoutIsotp,
                        format!("response reassembly stalled: no consecutive frame within {} ms (N_Cr)", ISOTP_TIMEOUT.as_millis()),
                    ));
                }
                RxItem::Error(e) => {
                    let detail = isotp_detail(&e);
                    self.push(
                        NewEvent::new(ConversationEventKind::TransportError, req.addressing, now_monotonic_us())
                            .sid(sid)
                            .request(Some(req.seq), Some(us(req.at.elapsed())))
                            .detail(detail.clone())
                            .origin(req.origin),
                    );
                    return Err(err(DiagErrorCode::IsotpError, format!("ISO-TP receive failed: {detail}")));
                }
                RxItem::Pdu { pdu, mark } => {
                    let fresh = mark.as_ref().is_none_or(|m| m.start_seq > arm_seq);
                    if !fresh || !response_matches(&req.bytes, &pdu) {
                        self.log_stale(&pdu, mark.as_ref(), Some(req));
                        continue;
                    }
                    let (ts, elapsed) = req.timing(mark.as_ref());
                    let nrc = negative_code(&pdu);
                    if nrc == Some(NRC_RESPONSE_PENDING) {
                        pending = pending.saturating_add(1);
                        self.push(
                            NewEvent::new(ConversationEventKind::ResponsePending, req.addressing, ts)
                                .sid(sid)
                                .bytes(&pdu)
                                .request(Some(req.seq), Some(elapsed))
                                .nrc(nrc)
                                .origin(req.origin),
                        );
                        deadline = (Instant::now() + p2sc).min(hard);
                        continue;
                    }
                    self.push(
                        NewEvent::new(ConversationEventKind::Response, req.addressing, ts)
                            .sid(sid)
                            .bytes(&pdu)
                            .request(Some(req.seq), Some(elapsed))
                            .nrc(nrc)
                            .origin(req.origin),
                    );
                    self.apply_state(&req.bytes, &pdu, gap);
                    return Ok(Exchange { raw: pdu, suppressed: false, pending_count: pending, elapsed_us: elapsed, seq: req.seq });
                }
            }
        }
    }

    /// Ends an exchange: stop routing PDUs to it and log whatever is still queued as stale.
    fn finish_slot(&self, rx: &mut mpsc::Receiver<RxItem>, current: Option<&ReqInfo>) {
        self.bridge.close_rx();
        *self.slot.lock() = None;
        rx.close();
        while let Ok(item) = rx.try_recv() {
            if let RxItem::Pdu { pdu, mark } = item {
                self.log_stale(&pdu, mark.as_ref(), current);
            }
        }
    }

    /// Session / security bookkeeping from a final response (see `DiagSessionInfoDto`).
    fn apply_state(&self, req: &[u8], pdu: &[u8], gap: Option<Duration>) {
        let (Some(&sid), Some(&rsid)) = (req.first(), pdu.first()) else { return };
        let mut st = self.state.lock();
        match (sid, rsid) {
            (0x10, 0x50) => {
                if let Some(&session) = pdu.get(1) {
                    st.active_session = session;
                }
                // Any session transition re-locks security (ISO 14229-1 SecurityAccess rules).
                st.unlocked_level = None;
                if let Some((p2, p2s)) = parse_session_timing(pdu) {
                    st.p2_server_ms = Some(p2);
                    st.p2_star_server_ms = Some(p2s);
                }
            }
            (0x27, 0x67) => {
                let sub = req.get(1).map_or(0, |b| b & 0x7F);
                if sub != 0 && sub & 1 == 0 {
                    st.unlocked_level = Some(sub - 1);
                } else if sub & 1 == 1 && pdu.len() > 2 && pdu[2..].iter().all(|&b| b == 0) {
                    // All-zero seed: this level is already unlocked.
                    st.unlocked_level = Some(sub);
                }
            }
            (0x11, 0x51) => {
                st.active_session = 1;
                st.unlocked_level = None;
                st.p2_server_ms = None;
                st.p2_star_server_ms = None;
            }
            (_, 0x7F) => {
                let nrc = pdu.get(2).copied();
                let silent_long = gap.is_none_or(|g| g >= S3_LOSS_GAP);
                if matches!(nrc, Some(0x7F) | Some(0x33))
                    && st.active_session != 1
                    && !st.tester_present_enabled
                    && silent_long
                {
                    st.active_session = 1;
                    st.unlocked_level = None;
                }
            }
            _ => {}
        }
    }
}

pub fn isotp_detail(e: &automotive::Error) -> String {
    use automotive::transports::isotp::Error as TpError;
    match e {
        automotive::Error::IsoTPError(TpError::OutOfOrder) => "isotp_out_of_order".into(),
        automotive::Error::IsoTPError(TpError::Overflow) => "isotp_fc_overflow".into(),
        automotive::Error::IsoTPError(TpError::UnexpectedPdu) => "isotp_unexpected_pdu".into(),
        automotive::Error::IsoTPError(TpError::MalformedFrame) => "isotp_malformed_frame".into(),
        automotive::Error::Timeout => "isotp_timeout".into(),
        other => format!("isotp: {other}"),
    }
}

async fn rx_loop(inner: Arc<Inner>, stream: impl Stream<Item = automotive::Result<Vec<u8>>> + Unpin) {
    let mut stream = stream;
    while let Some(item) = stream.next().await {
        let item = match item {
            Ok(pdu) => {
                let mark = inner.bridge.take_mark(pdu.len());
                RxItem::Pdu { pdu, mark }
            }
            Err(automotive::Error::IdleTimeout) => continue,
            Err(automotive::Error::Disconnected) => break,
            Err(e) => RxItem::Error(e),
        };
        inner.deliver(item);
    }
    inner.deliver(RxItem::Ended);
}

/// Background TesterPresent (`3E 80`, physical) under the request lock. Sends only when the
/// tester was silent for one interval (any request restarts S3 on the ECU), skips while a
/// request is in flight, and never retries faster than the interval after a failure.
pub async fn keepalive_loop(inner: Arc<Inner>, mut cfg: watch::Receiver<(bool, u32)>) {
    let mut last_attempt: Option<Instant> = None;
    loop {
        if inner.is_closed() {
            return;
        }
        let (enabled, interval_ms) = *cfg.borrow_and_update();
        if !enabled {
            if cfg.changed().await.is_err() {
                return;
            }
            continue;
        }
        let interval = Duration::from_millis(u64::from(interval_ms));
        let last = {
            let st = inner.state.lock();
            match (st.last_tx_at, last_attempt) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            }
        };
        let wait = last.map_or(Duration::ZERO, |t| interval.saturating_sub(t.elapsed()));
        if !wait.is_zero() {
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                r = cfg.changed() => { if r.is_err() { return; } }
            }
            continue;
        }
        let Ok(mut eng) = inner.engine.try_lock() else {
            // A request is in flight (it restarts S3 itself); look again shortly.
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        };
        last_attempt = Some(Instant::now());
        let _ = inner
            .exchange(&mut eng, &[0x3E, 0x80], UdsAddressing::Physical, None, DiagOrigin::Keepalive, true)
            .await;
    }
}
