//! Bridge between a HAL [`DiagCanPort`] and `automotive`'s ISO-TP stack.
//!
//! ```text
//!  DiagCanPort ──recv_timeout(50 ms)──► pump thread ──observe()──► RxTracker / TX confirmation
//!                                          │                      (HAL timestamps, PDU marks)
//!                                          ▼ crossbeam (bounded)
//!  ISO-TP ◄── AsyncCanAdapter worker ◄── PortAdapter::recv()  (automotive::can::CanAdapter)
//!                         └──────────────► PortAdapter::send() ──► DiagCanPort::send
//! ```
//!
//! Why a pump thread: `automotive`'s `AsyncCanAdapter` worker only submits queued TX frames
//! after `CanAdapter::recv()` returns. Blocking `recv()` on the port alone would delay every
//! request by the idle wait; spinning would burn CPU (the crate's own SocketCAN adapter used
//! ~24 % of a core in the spike). The pump lets the client inject a `Kick` into the same
//! queue right before a request, so the worker wakes immediately, while the idle worker blocks
//! in `recv_timeout` (no spin).
//!
//! The pump also observes every event in bus order to keep the information `automotive`
//! drops: HAL timestamps (`automotive::can::Frame` has no timestamp), the request's TX
//! confirmation time, and where each received ISO-TP PDU started (stale detection).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use automotive::can::{CanAdapter, Frame, FrameContent, Identifier};
use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, TryRecvError};
use nexus_core::{now_monotonic_us, CanIdKey, RawCanFrame};
use parking_lot::Mutex;

use super::capture::IsoTpCapture;
use crate::uds::addressing::AddressBytes;
use crate::uds::port::{DiagCanPort, DiagPortEvent, DiagTxReject};

/// Pump → adapter queue depth. Overflow drops frames (counted) instead of growing unbounded
/// while no ISO-TP worker is consuming (e.g. after the worker stopped on a TX rejection).
pub const PORT_QUEUE_DEPTH: usize = 4096;
/// Pump blocking wait on the port; bounds shutdown latency of the pump thread.
const PUMP_WAIT: Duration = Duration::from_millis(100);
/// Longest worker wait while idle. Every request / keepalive / close kicks the worker, so this
/// only bounds how late a TX that was queued WITHOUT a kick can be picked up after long silence.
const IDLE_WAIT: Duration = Duration::from_millis(250);
/// Shortest worker wait right after activity. ISO-TP queues follow-up frames without a kick
/// (FC after a received FF, CFs after FC / STmin), so the wait backs off from this value at a
/// quarter of the time since the last event: added latency stays below ~25 % of the gap
/// (e.g. ≤ 2.5 ms on a 10 ms STmin) while idle wake-ups stay few.
const MIN_WAIT: Duration = Duration::from_micros(200);
/// Bus id used inside `automotive` (one port = one bus).
pub const CRATE_BUS: u8 = 0;
/// Largest ISO-TP response PDU the client reassembles (HIGH-07.1). A First Frame announcing more
/// (e.g. the 32-bit escape `10 00 FF FF FF F0`) is refused before `automotive` sees it: nothing is
/// buffered and the pump answers with one FC.OVFLW (ISO 15765-2) instead of FC.CTS. Classic CAN
/// FFs are ≤ 4095 by encoding; this caps the escape form.
pub const MAX_RESPONSE_PDU: usize = 64 * 1024;
/// Flow Control, FlowStatus = Overflow (`0x32`), BS = 0, STmin = 0 (normal addressing).
const FC_OVFLW: [u8; 3] = [0x32, 0x00, 0x00];
/// BRS for frames the bridge builds itself on CAN-FD; same value `automotive` uses for its FC
/// (`IsoTPConfig::brs` unset → [`PortAdapter::default_brs`]).
const FD_BRS: bool = true;
/// Most Flow Control WAIT frames accepted while sending one request (sender-side N_WFTmax,
/// HIGH-07.2). `automotive` restarts N_Bs on every WAIT and would otherwise wait forever.
pub const ISOTP_MAX_WFT: u32 = 10;
/// A multi-frame reception whose last frame is older than this is no longer "in progress"
/// (ISO-TP N_Cr is 1000 ms); keeps a stalled / refused FF from extending the response deadline.
const TRACKER_STALE: Duration = Duration::from_millis(1100);

/// Announced PDU length of a First Frame (`None` if `payload` is not a well-formed FF).
/// `off` = address bytes before the PCI (0 or 1); an FF always fills at least 8 CAN bytes.
fn first_frame_len(payload: &[u8], off: usize) -> Option<usize> {
    if payload.len() < 8 {
        return None;
    }
    let data = payload.get(off..)?;
    let b0 = *data.first()?;
    if b0 >> 4 != 1 {
        return None;
    }
    let short = (usize::from(b0 & 0x0F) << 8) | usize::from(*data.get(1)?);
    if short != 0 {
        return Some(short);
    }
    let b = data.get(2..6)?;
    Some(u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize)
}

/// Message from the pump (or the client) to the adapter running in the ISO-TP worker.
#[derive(Debug, Clone, Copy)]
pub enum PortMsg {
    Event(DiagPortEvent),
    /// Wake the worker: a TX is about to be queued.
    Kick,
    /// The port was closed by the HAL.
    Closed,
}

/// What the pump does with an observed event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    /// Pass to `automotive`.
    Forward,
    /// Keep away from `automotive` (still in the ISO-TP Monitor capture).
    Drop,
    /// Oversized First Frame (announced length): answer FC.OVFLW, keep away from `automotive`.
    RefuseOversize(usize),
}

/// Fate of the FC.OVFLW answering a refused oversized First Frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OvflwFc {
    /// Queued on the port (`DiagCanPort::send` returned `Ok`).
    Sent,
    /// Refused by a TX gate / the port; not retried.
    Blocked(DiagTxReject),
}

/// Most recent oversized First Frame refused while an exchange was open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OversizeRefusal {
    /// Pump sequence of the First Frame.
    pub seq: u64,
    /// Announced PDU length.
    pub len: usize,
    pub fc: OvflwFc,
}

/// Static addressing used by the pump to classify frames.
#[derive(Debug, Clone, Copy)]
pub struct Addressing {
    pub request_id: u32,
    pub response_id: u32,
    pub functional_id: Option<u32>,
    pub extended: bool,
    pub fd: bool,
    /// ISO-TP padding byte of the session (`None` = no padding), for frames built by the bridge.
    pub padding: Option<u8>,
    /// N_TA / N_AE byte before the PCI (extended / mixed addressing).
    pub addr: AddressBytes,
}

impl Addressing {
    /// Data frame on the response id (any address byte).
    fn is_response(&self, f: &RawCanFrame) -> bool {
        f.arb_id == self.response_id
            && f.is_extended() == self.extended
            && !f.is_error()
            && !f.is_rtr()
    }
    fn is_own_tx(&self, f: &RawCanFrame) -> bool {
        f.is_extended() == self.extended
            && (f.arb_id == self.request_id || Some(f.arb_id) == self.functional_id)
    }
}

/// Where and when one received ISO-TP PDU started / completed (pump view, HAL timestamps).
#[derive(Debug, Clone, Copy)]
pub struct PduMark {
    /// Pump event sequence number of the first frame (SF or FF).
    pub start_seq: u64,
    /// HAL timestamp of the completing frame (SF or last CF).
    pub end_ts: u64,
    pub end_hw: bool,
    pub end_at: Instant,
    pub len: usize,
}

#[derive(Debug, Clone, Copy)]
struct Partial {
    start_seq: u64,
    total: usize,
    received: usize,
    next_sn: u8,
    last_at: Instant,
}

/// Minimal passive ISO-TP length tracker for frames on the response id. It mirrors the
/// receiver closely enough to timestamp PDUs; the reassembled bytes still come from
/// `automotive`. Marks are matched to PDUs by length; mismatches are discarded.
#[derive(Debug, Default)]
pub struct RxTracker {
    partial: Option<Partial>,
    marks: VecDeque<PduMark>,
    /// Address bytes before the PCI (0 or 1); frames are pre-filtered on the address byte.
    off: usize,
}

const MAX_MARKS: usize = 64;

impl RxTracker {
    pub fn with_offset(off: usize) -> Self {
        Self {
            off,
            ..Self::default()
        }
    }

    pub fn feed(&mut self, f: &RawCanFrame, seq: u64, at: Instant) {
        let off = self.off;
        let dlc = f.payload().len();
        let Some(data) = f.payload().get(off..) else {
            return;
        };
        let Some(&b0) = data.first() else { return };
        match b0 >> 4 {
            0 => {
                let len = if dlc <= 8 {
                    let len = usize::from(b0 & 0x0F);
                    if len == 0 || off + len + 1 > dlc {
                        return;
                    }
                    len
                } else {
                    if b0 & 0x0F != 0 || data.len() < 2 {
                        return;
                    }
                    let len = usize::from(data[1]);
                    if len == 0 || off + len + 2 > dlc {
                        return;
                    }
                    len
                };
                self.partial = None;
                self.push(PduMark {
                    start_seq: seq,
                    end_ts: f.timestamp_us,
                    end_hw: f.has_hw_timestamp(),
                    end_at: at,
                    len,
                });
            }
            1 => {
                if dlc < 8 {
                    return;
                }
                let short = (usize::from(b0 & 0x0F) << 8) | usize::from(data[1]);
                let (total, hdr) = if short == 0 {
                    if data.len() < 6 {
                        return;
                    }
                    (
                        u32::from_be_bytes([data[2], data[3], data[4], data[5]]) as usize,
                        6,
                    )
                } else {
                    (short, 2)
                };
                let received = dlc - off - hdr;
                if received >= total {
                    return;
                }
                self.partial = Some(Partial {
                    start_seq: seq,
                    total,
                    received,
                    next_sn: 1,
                    last_at: at,
                });
            }
            2 => {
                let Some(mut p) = self.partial else { return };
                if b0 & 0x0F != p.next_sn {
                    self.partial = None;
                    return;
                }
                p.received += dlc.saturating_sub(off + 1);
                p.next_sn = (p.next_sn + 1) & 0x0F;
                p.last_at = at;
                if p.received >= p.total {
                    self.partial = None;
                    self.push(PduMark {
                        start_seq: p.start_seq,
                        end_ts: f.timestamp_us,
                        end_hw: f.has_hw_timestamp(),
                        end_at: at,
                        len: p.total,
                    });
                } else {
                    self.partial = Some(p);
                }
            }
            _ => {}
        }
    }

    fn push(&mut self, m: PduMark) {
        if self.marks.len() == MAX_MARKS {
            self.marks.pop_front();
        }
        self.marks.push_back(m);
    }

    /// Mark for a PDU of `len` bytes just produced by the ISO-TP receiver.
    pub fn take(&mut self, len: usize) -> Option<PduMark> {
        while let Some(m) = self.marks.pop_front() {
            if m.len == len {
                return Some(m);
            }
        }
        None
    }

    /// Start sequence of a multi-frame reception in progress, if any.
    pub fn in_progress_since(&self) -> Option<u64> {
        self.partial
            .filter(|p| p.last_at.elapsed() <= TRACKER_STALE)
            .map(|p| p.start_seq)
    }

    /// Forget a reception in progress (its First Frame was superseded by a refused one).
    fn reset_partial(&mut self) {
        self.partial = None;
    }
}

/// TX confirmation of the request currently being sent (last non-FC frame).
#[derive(Debug, Clone, Copy)]
pub struct TxConfirm {
    pub ts: u64,
    pub hw: bool,
    pub at: Instant,
}

#[derive(Debug, Default)]
struct TxArm {
    armed: bool,
    confirm: Option<TxConfirm>,
}

/// State shared by the pump, the adapter and the client engine.
pub struct BridgeShared {
    pub addressing: Addressing,
    /// Pump event sequence (incremented before each event is observed).
    seq: AtomicU64,
    tracker: Mutex<RxTracker>,
    tx_arm: Mutex<TxArm>,
    last_reject: Mutex<Option<DiagTxReject>>,
    /// Port closed by the HAL.
    pub hal_closed: AtomicBool,
    /// Frames dropped because the adapter queue was full.
    pub dropped: AtomicU64,
    /// Preallocated ring of every Rx / TxConfirmed frame (ISO-TP Monitor).
    pub capture: IsoTpCapture,
    /// An exchange is waiting for a response. While `false` the session is idle and a First
    /// Frame on the response id (another tester's ECU answer) is NOT passed to `automotive`, whose
    /// persistent receiver would otherwise transmit FC.CTS on our behalf (HIGH-07.3).
    rx_open: AtomicBool,
    /// FC.WAIT frames received since [`Self::arm_tx`].
    fc_waits: AtomicU32,
    /// Most recent oversized First Frame refused while an exchange was open.
    oversize: Mutex<Option<OversizeRefusal>>,
    /// FC.OVFLW queued on the port and not yet confirmed / rejected (its verdict is not
    /// `automotive`'s: an unmatched rejection would stop the crate's worker).
    ovflw_in_flight: Mutex<Option<RawCanFrame>>,
    /// Announced length above which a First Frame is refused ([`MAX_RESPONSE_PDU`]).
    max_response_pdu: usize,
    /// Wakes the engine for [`Self::wait_fc_limit`] / [`Self::wait_oversize`].
    alert: tokio::sync::Notify,
    /// First Frames refused because the announced length exceeds [`MAX_RESPONSE_PDU`].
    pub refused_oversize_ff: AtomicU64,
    /// First Frames dropped while idle (no FC sent for someone else's transfer).
    pub dropped_idle_ff: AtomicU64,
}

impl BridgeShared {
    pub fn new(addressing: Addressing) -> Self {
        Self {
            addressing,
            seq: AtomicU64::new(0),
            tracker: Mutex::new(RxTracker::with_offset(addressing.addr.rx_offset())),
            tx_arm: Mutex::new(TxArm::default()),
            last_reject: Mutex::new(None),
            hal_closed: AtomicBool::new(false),
            dropped: AtomicU64::new(0),
            capture: IsoTpCapture::default()
                .with_address_offsets(addressing.addr.tx_offset(), addressing.addr.rx_offset()),
            rx_open: AtomicBool::new(false),
            fc_waits: AtomicU32::new(0),
            oversize: Mutex::new(None),
            ovflw_in_flight: Mutex::new(None),
            max_response_pdu: MAX_RESPONSE_PDU,
            alert: tokio::sync::Notify::new(),
            refused_oversize_ff: AtomicU64::new(0),
            dropped_idle_ff: AtomicU64::new(0),
        }
    }

    /// An exchange starts waiting for its response (call before the request can reach the bus).
    pub fn open_rx(&self) {
        self.rx_open.store(true, Ordering::Release);
    }

    /// The exchange ended: the session is idle again.
    pub fn close_rx(&self) {
        self.rx_open.store(false, Ordering::Release);
    }

    /// Resolves once more than [`ISOTP_MAX_WFT`] FC.WAIT frames arrived since [`Self::arm_tx`].
    pub async fn wait_fc_limit(&self) {
        loop {
            // Register before checking so a notification between check and await is not lost.
            let notified = self.alert.notified();
            if self.fc_waits.load(Ordering::Acquire) > ISOTP_MAX_WFT {
                return;
            }
            notified.await;
        }
    }

    /// Resolves with the oversized First Frame refused after `after_seq` (FC.OVFLW already
    /// attempted).
    pub async fn wait_oversize(&self, after_seq: u64) -> OversizeRefusal {
        loop {
            let notified = self.alert.notified();
            if let Some(r) = *self.oversize.lock() {
                if r.seq > after_seq {
                    return r;
                }
            }
            notified.await;
        }
    }

    /// Current pump sequence: frames observed later have a larger sequence number.
    pub fn seq_now(&self) -> u64 {
        self.seq.load(Ordering::Acquire)
    }

    /// Starts recording the TX confirmation of the next request.
    pub fn arm_tx(&self) {
        let mut a = self.tx_arm.lock();
        a.armed = true;
        a.confirm = None;
        self.fc_waits.store(0, Ordering::Release);
    }

    /// Stops recording and returns the last confirmation seen since [`Self::arm_tx`].
    pub fn disarm_tx(&self) -> Option<TxConfirm> {
        let mut a = self.tx_arm.lock();
        a.armed = false;
        a.confirm.take()
    }

    pub fn take_mark(&self, len: usize) -> Option<PduMark> {
        self.tracker.lock().take(len)
    }

    /// `true` when a multi-frame response that started after `after_seq` is being received.
    pub fn rx_in_progress_after(&self, after_seq: u64) -> bool {
        self.tracker
            .lock()
            .in_progress_since()
            .is_some_and(|s| s > after_seq)
    }

    pub fn clear_reject(&self) {
        *self.last_reject.lock() = None;
    }

    pub fn last_reject(&self) -> Option<DiagTxReject> {
        *self.last_reject.lock()
    }

    fn record_reject(&self, r: DiagTxReject) {
        *self.last_reject.lock() = Some(r);
    }

    /// Pump step after capture: observes `ev`, answers a refused oversized First Frame with
    /// FC.OVFLW, and returns whether `ev` is forwarded to `automotive`.
    fn process(&self, port: &dyn DiagCanPort, ev: &DiagPortEvent, seq: u64, at: Instant) -> bool {
        match self.observe(ev, seq, at) {
            Verdict::Forward => true,
            Verdict::Drop => false,
            Verdict::RefuseOversize(len) => {
                self.refuse_oversize(port, seq, len);
                false
            }
        }
    }

    /// FC.OVFLW on the physical request id (where `automotive` sends its FC), with the N_TA /
    /// N_AE prefix if any, padded like the crate pads FC: 8 bytes with the padding byte, else
    /// address + 3 bytes. Same length on CAN-FD (FD frame, BRS as `automotive`). `None` only
    /// for an invalid id (rejected at session open).
    fn ovflw_frame(&self, bus_id: u8) -> Option<RawCanFrame> {
        let a = &self.addressing;
        let key = if a.extended {
            CanIdKey::new_extended(a.request_id)
        } else {
            u16::try_from(a.request_id)
                .ok()
                .and_then(CanIdKey::new_standard)
        }?;
        let mut buf = [0u8; 8];
        let off = a.addr.tx_offset();
        if let Some(ta) = a.addr.tx {
            buf[0] = ta;
        }
        let end = off + FC_OVFLW.len();
        buf[off..end].copy_from_slice(&FC_OVFLW);
        let len = match a.padding {
            Some(p) => {
                buf[end..].fill(p);
                buf.len()
            }
            None => end,
        };
        let ts = now_monotonic_us();
        if a.fd {
            RawCanFrame::new_fd(bus_id, key, &buf[..len], FD_BRS, ts).ok()
        } else {
            RawCanFrame::new_classical(bus_id, key, &buf[..len], ts).ok()
        }
    }

    /// Sends one FC.OVFLW through the gated port (no retry, no blocking), then records the
    /// refusal and wakes the engine. Nothing of the PDU is buffered.
    fn refuse_oversize(&self, port: &dyn DiagCanPort, seq: u64, len: usize) {
        let fc = match self.ovflw_frame(port.bus_id()) {
            Some(frame) => match port.send(frame) {
                Ok(()) => {
                    *self.ovflw_in_flight.lock() = Some(frame);
                    OvflwFc::Sent
                }
                Err(why) => OvflwFc::Blocked(why),
            },
            None => OvflwFc::Blocked(DiagTxReject::DriverError),
        };
        *self.oversize.lock() = Some(OversizeRefusal { seq, len, fc });
        self.alert.notify_waiters();
    }

    /// `true` (and forgets it) when `f` is the FC.OVFLW in flight.
    fn take_ovflw(&self, f: &RawCanFrame) -> bool {
        let mut g = self.ovflw_in_flight.lock();
        if g.as_ref().is_some_and(|o| same_frame(o, f)) {
            *g = None;
            true
        } else {
            false
        }
    }

    /// Observes one port event in bus order and decides whether it is forwarded to `automotive`
    /// (anything but [`Verdict::Forward`] stays out of the ISO-TP stack; it is still in the
    /// ISO-TP Monitor capture).
    fn observe(&self, ev: &DiagPortEvent, seq: u64, at: Instant) -> Verdict {
        match ev {
            DiagPortEvent::Rx(f) => {
                if self.addressing.is_response(f) && f.is_fd() == self.addressing.fd {
                    let Some(data) = self.addressing.addr.rx_pdu(f.payload()) else {
                        // Address byte of another node: never ours to reassemble.
                        return Verdict::Drop;
                    };
                    if let Some(len) =
                        first_frame_len(f.payload(), self.addressing.addr.rx_offset())
                    {
                        if !self.rx_open.load(Ordering::Acquire) {
                            // Idle: not our transfer. Without the FF, `automotive` ignores the CFs too.
                            self.dropped_idle_ff.fetch_add(1, Ordering::Relaxed);
                            self.tracker.lock().reset_partial();
                            return Verdict::Drop;
                        }
                        if len > self.max_response_pdu {
                            self.refused_oversize_ff.fetch_add(1, Ordering::Relaxed);
                            self.tracker.lock().reset_partial();
                            return Verdict::RefuseOversize(len);
                        }
                    } else if data.first().is_some_and(|b| *b == 0x31) && self.tx_arm.lock().armed {
                        // FC.WAIT for the request being sent.
                        let n = self.fc_waits.fetch_add(1, Ordering::AcqRel) + 1;
                        if n > ISOTP_MAX_WFT {
                            self.alert.notify_waiters();
                        }
                    }
                    self.tracker.lock().feed(f, seq, at);
                }
            }
            DiagPortEvent::TxConfirmed(f) => {
                if self.take_ovflw(f) {
                    return Verdict::Drop;
                }
                // Request frames (SF / FF / CF), not our own flow control (PCI 3).
                let pci = f
                    .payload()
                    .get(self.addressing.addr.tx_offset())
                    .map(|b| b >> 4);
                if self.addressing.is_own_tx(f) && matches!(pci, Some(0..=2)) {
                    let mut a = self.tx_arm.lock();
                    if a.armed {
                        a.confirm = Some(TxConfirm {
                            ts: f.timestamp_us,
                            hw: f.has_hw_timestamp(),
                            at,
                        });
                    }
                }
            }
            DiagPortEvent::TxRejected(f, why) => {
                if self.take_ovflw(f) {
                    // Late gate verdict on the FC.OVFLW: not a request failure.
                    if let Some(r) = self.oversize.lock().as_mut() {
                        r.fc = OvflwFc::Blocked(*why);
                    }
                    return Verdict::Drop;
                }
                self.record_reject(*why);
            }
        }
        Verdict::Forward
    }
}

/// Pump thread body. Exits when `stop` is set or the port reports closed.
pub fn pump_loop(
    port: Arc<dyn DiagCanPort>,
    shared: Arc<BridgeShared>,
    tx: Sender<PortMsg>,
    stop: Arc<AtomicBool>,
) {
    loop {
        if stop.load(Ordering::Acquire) {
            break;
        }
        if port.is_closed() {
            shared.hal_closed.store(true, Ordering::Release);
            let _ = tx.try_send(PortMsg::Closed);
            break;
        }
        let Some(ev) = port.recv_timeout(PUMP_WAIT) else {
            continue;
        };
        let seq = shared.seq.fetch_add(1, Ordering::AcqRel) + 1;
        // ISO-TP Monitor: bus frames only (a rejected TX never reached the wire). No heap.
        match &ev {
            DiagPortEvent::Rx(f) => {
                shared.capture.record(f, false);
            }
            DiagPortEvent::TxConfirmed(f) => {
                shared.capture.record(f, true);
            }
            DiagPortEvent::TxRejected(..) => {}
        }
        if !shared.process(port.as_ref(), &ev, seq, Instant::now()) {
            continue;
        }
        if tx.try_send(PortMsg::Event(ev)).is_err() {
            shared.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

// ─── Frame conversion ───────────────────────────────────────────────────────

/// HAL frame → `automotive` frame (bus [`CRATE_BUS`]). `None` for error frames / bad ids.
pub fn raw_to_frame(raw: &RawCanFrame, loopback: bool) -> Option<Frame> {
    if raw.is_error() {
        return None;
    }
    let id = if raw.is_extended() {
        Identifier::extended(raw.arb_id).ok()?
    } else {
        Identifier::standard(raw.arb_id).ok()?
    };
    if raw.is_rtr() {
        let mut f = Frame::remote(CRATE_BUS, id, raw.dlc.min(15)).ok()?;
        f.loopback = loopback;
        return Some(f);
    }
    Frame::builder(id)
        .bus(CRATE_BUS)
        .loopback(loopback)
        .fd(raw.is_fd())
        .brs(raw.is_fd() && raw.is_brs())
        .esi(raw.is_fd() && raw.is_esi())
        .data(raw.payload())
        .build()
        .ok()
}

/// `automotive` frame → HAL TX frame. `None` for unrepresentable frames (error frames).
pub fn frame_to_raw(frame: &Frame, bus_id: u8, ts_us: u64) -> Option<RawCanFrame> {
    let key = |id: &Identifier| match id {
        Identifier::Standard(s) => u16::try_from(s.as_raw())
            .ok()
            .and_then(CanIdKey::new_standard),
        Identifier::Extended(e) => CanIdKey::new_extended(e.as_raw()),
    };
    match frame.content() {
        FrameContent::Classic { id, data } => {
            RawCanFrame::new_classical(bus_id, key(id)?, data, ts_us).ok()
        }
        FrameContent::Fd { id, data, brs, esi } => {
            let mut raw = RawCanFrame::new_fd(bus_id, key(id)?, data, *brs, ts_us).ok()?;
            if *esi {
                raw.flags |= nexus_core::FLAG_ESI;
            }
            Some(raw)
        }
        FrameContent::Remote { id, dlc } => {
            RawCanFrame::new_rtr(bus_id, key(id)?, (*dlc).min(8), ts_us).ok()
        }
        FrameContent::Error(_) => None,
    }
}

fn same_frame(a: &RawCanFrame, b: &RawCanFrame) -> bool {
    a.arb_id == b.arb_id && a.is_extended() == b.is_extended() && a.payload() == b.payload()
}

/// Error surfaced to `automotive` for a refused TX. The crate stops its worker on any adapter
/// error and fails every pending send with a clone of it; the client maps it back to a typed
/// [`DiagTxReject`] via [`BridgeShared::last_reject`] and rebuilds the stack on the next call.
fn reject_error(r: DiagTxReject) -> automotive::Error {
    std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        format!("NexusCAN TX refused: {r:?}"),
    )
    .into()
}

// ─── automotive::can::CanAdapter over the pump queue ────────────────────────

/// Runs inside `automotive`'s worker thread.
pub struct PortAdapter {
    rx: Receiver<PortMsg>,
    port: Arc<dyn DiagCanPort>,
    shared: Arc<BridgeShared>,
    bus_id: u8,
    fd_enabled: bool,
    /// Frames handed to the port and not yet confirmed (echo matching for `automotive`).
    in_flight: VecDeque<RawCanFrame>,
    last_activity: Instant,
}

impl PortAdapter {
    pub fn new(
        rx: Receiver<PortMsg>,
        port: Arc<dyn DiagCanPort>,
        shared: Arc<BridgeShared>,
    ) -> Self {
        let bus_id = port.bus_id();
        let fd_enabled = port.fd_enabled();
        Self {
            rx,
            port,
            shared,
            bus_id,
            fd_enabled,
            in_flight: VecDeque::new(),
            last_activity: Instant::now(),
        }
    }

    fn touch(&mut self) {
        self.last_activity = Instant::now();
    }

    fn handle(&mut self, msg: PortMsg, out: &mut Vec<Frame>) -> automotive::Result<()> {
        match msg {
            PortMsg::Kick => self.touch(),
            PortMsg::Closed => return Err(automotive::Error::Disconnected),
            PortMsg::Event(DiagPortEvent::Rx(raw)) => {
                self.touch();
                out.extend(raw_to_frame(&raw, false));
            }
            PortMsg::Event(DiagPortEvent::TxConfirmed(raw)) => {
                self.touch();
                // Forward the echo only for a frame THIS adapter instance sent, rebuilt from
                // our own copy so `automotive`'s payload match is exact. An unmatched echo after
                // the first confirmation would trip an `assert!` inside the crate's worker.
                if let Some(pos) = self.in_flight.iter().position(|f| same_frame(f, &raw)) {
                    let mine = self.in_flight.remove(pos);
                    if let Some(f) = mine.and_then(|m| raw_to_frame(&m, true)) {
                        out.push(f);
                    }
                }
            }
            PortMsg::Event(DiagPortEvent::TxRejected(_, why)) => {
                self.shared.record_reject(why);
                return Err(reject_error(why));
            }
        }
        Ok(())
    }
}

impl CanAdapter for PortAdapter {
    fn send(&mut self, frames: &mut VecDeque<Frame>) -> automotive::Result<()> {
        while let Some(f) = frames.front() {
            if f.is_fd() && !self.fd_enabled {
                return Err(automotive::Error::NotSupported);
            }
            let raw = frame_to_raw(f, self.bus_id, now_monotonic_us())
                .ok_or(automotive::Error::MalformedFrame)?;
            match self.port.send(raw) {
                Ok(()) => {
                    frames.pop_front();
                    self.in_flight.push_back(raw);
                    self.touch();
                }
                // Back-pressure: leave the rest queued, the worker retries (CanAdapter contract).
                Err(DiagTxReject::QueueFull) => break,
                Err(why) => {
                    self.shared.record_reject(why);
                    return Err(reject_error(why));
                }
            }
        }
        Ok(())
    }

    fn recv(&mut self) -> automotive::Result<Vec<Frame>> {
        let wait = (self.last_activity.elapsed() / 4).clamp(MIN_WAIT, IDLE_WAIT);
        let mut out = Vec::new();
        let first = match self.rx.recv_timeout(wait) {
            Ok(m) => m,
            Err(RecvTimeoutError::Timeout) => return Ok(out),
            Err(RecvTimeoutError::Disconnected) => return Err(automotive::Error::Disconnected),
        };
        self.handle(first, &mut out)?;
        for _ in 0..255 {
            match self.rx.try_recv() {
                Ok(m) => self.handle(m, &mut out)?,
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return Err(automotive::Error::Disconnected),
            }
        }
        Ok(out)
    }

    fn default_brs(&self) -> bool {
        FD_BRS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rx(id: u32, data: &[u8], ts: u64) -> RawCanFrame {
        let key = CanIdKey::new_standard(id as u16).unwrap_or(CanIdKey::Standard(0));
        RawCanFrame::new_classical(0, key, data, ts).unwrap_or_default()
    }

    /// Scripted port: hands out queued events, then reports closed.
    struct ScriptPort(Mutex<VecDeque<DiagPortEvent>>);

    impl DiagCanPort for ScriptPort {
        fn bus_id(&self) -> u8 {
            0
        }
        fn fd_enabled(&self) -> bool {
            false
        }
        fn gate_check(&self) -> Result<(), DiagTxReject> {
            Ok(())
        }
        fn send(&self, _frame: RawCanFrame) -> Result<(), DiagTxReject> {
            Ok(())
        }
        fn recv_timeout(&self, _timeout: Duration) -> Option<DiagPortEvent> {
            self.0.lock().pop_front()
        }
        fn try_recv(&self) -> Option<DiagPortEvent> {
            self.0.lock().pop_front()
        }
        fn is_closed(&self) -> bool {
            self.0.lock().is_empty()
        }
    }

    #[test]
    fn pump_captures_rx_and_tx_confirmed_but_not_rejected() {
        use crate::uds::dto::{IsoTpDirection, IsoTpFrameKind};
        let events = VecDeque::from(vec![
            DiagPortEvent::TxConfirmed(rx(
                0x7E2,
                &[0x03, 0x22, 0xF1, 0xF1, 0xAA, 0xAA, 0xAA, 0xAA],
                10,
            )),
            DiagPortEvent::TxRejected(rx(0x7E2, &[0x02, 0x3E, 0x80], 11), DiagTxReject::Disarmed),
            DiagPortEvent::Rx(rx(
                0x7EA,
                &[0x10, 0x14, 0x62, 0xF1, 0xF1, 0x41, 0x42, 0x43],
                12,
            )),
            DiagPortEvent::TxConfirmed(rx(
                0x7E2,
                &[0x30, 0x00, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA],
                13,
            )),
            DiagPortEvent::Rx(rx(0x7EA, &[0x21, 1, 2, 3, 4, 5, 6, 7], 14)),
        ]);
        let port: Arc<dyn DiagCanPort> = Arc::new(ScriptPort(Mutex::new(events)));
        let shared = Arc::new(BridgeShared::new(Addressing {
            request_id: 0x7E2,
            response_id: 0x7EA,
            functional_id: None,
            extended: false,
            fd: false,
            padding: Some(0xAA),
            addr: AddressBytes::default(),
        }));
        let (tx, _rx) = crossbeam_channel::bounded(64);
        pump_loop(port, shared.clone(), tx, Arc::new(AtomicBool::new(false)));
        let p = shared.capture.since(0, 100);
        let got: Vec<(u64, IsoTpDirection, IsoTpFrameKind, u64)> = p
            .frames
            .iter()
            .map(|f| (f.seq, f.direction, f.kind, f.timestamp_us))
            .collect();
        assert_eq!(
            got,
            vec![
                (1, IsoTpDirection::Tx, IsoTpFrameKind::Single, 10),
                (2, IsoTpDirection::Rx, IsoTpFrameKind::First, 12),
                (3, IsoTpDirection::Tx, IsoTpFrameKind::FlowControl, 13),
                (4, IsoTpDirection::Rx, IsoTpFrameKind::Consecutive, 14),
            ]
        );
    }

    fn shared() -> BridgeShared {
        shared_with(false, Some(0xAA))
    }

    fn shared_with(fd: bool, padding: Option<u8>) -> BridgeShared {
        BridgeShared::new(Addressing {
            request_id: 0x7E2,
            response_id: 0x7EA,
            functional_id: Some(0x7DF),
            extended: false,
            fd,
            padding,
            addr: AddressBytes::default(),
        })
    }

    /// Port recording every accepted `send`; `gate` mimics the HAL TX gates.
    #[derive(Default)]
    struct RecPort {
        fd: bool,
        gate: Mutex<Option<DiagTxReject>>,
        sent: Mutex<Vec<RawCanFrame>>,
    }

    impl DiagCanPort for RecPort {
        fn bus_id(&self) -> u8 {
            4
        }
        fn fd_enabled(&self) -> bool {
            self.fd
        }
        fn gate_check(&self) -> Result<(), DiagTxReject> {
            self.gate.lock().map_or(Ok(()), Err)
        }
        fn send(&self, frame: RawCanFrame) -> Result<(), DiagTxReject> {
            self.gate_check()?;
            self.sent.lock().push(frame);
            Ok(())
        }
        fn recv_timeout(&self, _timeout: Duration) -> Option<DiagPortEvent> {
            None
        }
        fn try_recv(&self) -> Option<DiagPortEvent> {
            None
        }
        fn is_closed(&self) -> bool {
            false
        }
    }

    fn fd_rx(id: u32, data: &[u8]) -> RawCanFrame {
        let key = CanIdKey::new_standard(id as u16).unwrap_or(CanIdKey::Standard(0));
        RawCanFrame::new_fd(0, key, data, true, 1).unwrap_or_default()
    }

    /// Escape-form FF (`10 00 <u32 len>`) padded to `dlc`.
    fn escape_ff(len: u32, dlc: usize) -> Vec<u8> {
        let mut d = vec![0x10, 0x00];
        d.extend(len.to_be_bytes());
        d.extend([0x62, 0xF1]);
        d.resize(dlc, 0x55);
        d
    }

    fn sent_payloads(p: &RecPort) -> Vec<Vec<u8>> {
        p.sent.lock().iter().map(|f| f.payload().to_vec()).collect()
    }

    fn has_cts(p: &RecPort) -> bool {
        p.sent
            .lock()
            .iter()
            .any(|f| f.payload().first() == Some(&0x30))
    }

    #[test]
    fn first_frame_len_parses_short_and_escape_forms() {
        assert_eq!(
            first_frame_len(&[0x1F, 0xFF, 0, 0, 0, 0, 0, 0], 0),
            Some(4095)
        );
        assert_eq!(
            first_frame_len(&[0x10, 0x00, 0xFF, 0xFF, 0xFF, 0xF0, 0, 0], 0),
            Some(0xFFFF_FFF0)
        );
        assert_eq!(
            first_frame_len(&[0x10, 0x14, 0, 0, 0], 0),
            None,
            "short DLC"
        );
        assert_eq!(first_frame_len(&[0x21, 0, 0, 0, 0, 0, 0, 0], 0), None, "CF");
        // Address byte first: the PCI is at index 1.
        assert_eq!(
            first_frame_len(&[0xF1, 0x10, 0x14, 0, 0, 0, 0, 0], 1),
            Some(20)
        );
        assert_eq!(
            first_frame_len(&[0xF1, 0x10, 0x00, 0x00, 0x01, 0x00, 0x01, 0], 1),
            Some(0x1_0001)
        );
        assert_eq!(
            first_frame_len(&[0xF1, 0x10, 0x14, 0, 0, 0, 0], 1),
            None,
            "DLC 7"
        );
    }

    #[test]
    fn idle_first_frame_is_not_forwarded_to_isotp() {
        let s = shared();
        let ff = DiagPortEvent::Rx(rx(0x7EA, &[0x10, 0x14, 0x62, 0xF1, 0x90, 1, 2, 3], 1));
        assert_eq!(
            s.observe(&ff, 1, Instant::now()),
            Verdict::Drop,
            "idle FF must be dropped (no FC.CTS)"
        );
        assert_eq!(s.dropped_idle_ff.load(Ordering::Relaxed), 1);
        let sf = DiagPortEvent::Rx(rx(0x7EA, &[0x03, 0x7F, 0x22, 0x31, 0, 0, 0, 0], 2));
        assert_eq!(
            s.observe(&sf, 2, Instant::now()),
            Verdict::Forward,
            "SFs are still forwarded (logged as stale)"
        );
        s.open_rx();
        assert_eq!(
            s.observe(&ff, 3, Instant::now()),
            Verdict::Forward,
            "FF during an exchange is forwarded"
        );
        s.close_rx();
        assert_eq!(s.observe(&ff, 4, Instant::now()), Verdict::Drop);
    }

    #[test]
    fn oversized_first_frame_is_refused_and_signalled() {
        let s = shared();
        let port = RecPort::default();
        s.open_rx();
        let huge = DiagPortEvent::Rx(rx(
            0x7EA,
            &[0x10, 0x00, 0xFF, 0xFF, 0xFF, 0xF0, 0x62, 0xF1],
            1,
        ));
        assert!(!s.process(&port, &huge, 7, Instant::now()));
        assert_eq!(
            *s.oversize.lock(),
            Some(OversizeRefusal {
                seq: 7,
                len: 0xFFFF_FFF0,
                fc: OvflwFc::Sent
            })
        );
        assert!(
            !s.rx_in_progress_after(0),
            "a refused FF must not extend the response deadline"
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap_or_else(|e| panic!("{e}"));
        let len = rt.block_on(async {
            tokio::time::timeout(Duration::from_millis(100), s.wait_oversize(6)).await
        });
        assert_eq!(len.ok().map(|r| r.len), Some(0xFFFF_FFF0));
        // An older refusal does not fail a newer exchange.
        let stale = rt.block_on(async {
            tokio::time::timeout(Duration::from_millis(20), s.wait_oversize(7)).await
        });
        assert!(stale.is_err());
        let limit = DiagPortEvent::Rx(rx(
            0x7EA,
            &[0x10, 0x00, 0x00, 0x01, 0x00, 0x00, 0x62, 0xF1],
            2,
        ));
        assert!(
            s.process(&port, &limit, 8, Instant::now()),
            "exactly MAX_RESPONSE_PDU is accepted"
        );
        assert_eq!(
            port.sent.lock().len(),
            1,
            "only the FC.OVFLW of the refusal"
        );
    }

    #[test]
    fn oversize_escape_ff_answers_one_padded_fc_ovflw_on_request_id() {
        let s = shared();
        let port = RecPort::default();
        s.open_rx();
        let ff = DiagPortEvent::Rx(rx(0x7EA, &escape_ff(0xFFFF_FFF0, 8), 1));
        assert!(
            !s.process(&port, &ff, 3, Instant::now()),
            "FF never reaches automotive"
        );
        assert_eq!(
            sent_payloads(&port),
            vec![vec![0x32, 0x00, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA]]
        );
        let f = port.sent.lock()[0];
        assert_eq!(
            f.arb_id, 0x7E2,
            "physical request id, not functional / response"
        );
        assert!(!f.is_extended() && !f.is_fd());
        assert_eq!(f.bus_id, 4);
        assert!(!has_cts(&port));
        assert_eq!(s.refused_oversize_ff.load(Ordering::Relaxed), 1);
        assert!(s.tracker.lock().partial.is_none(), "nothing buffered");
    }

    #[test]
    fn oversize_12bit_ff_answers_fc_ovflw() {
        // A 12-bit FF is at most 4095 (< MAX_RESPONSE_PDU); lower the cap to reach this path.
        let mut s = shared();
        s.max_response_pdu = 100;
        let port = RecPort::default();
        s.open_rx();
        let ff = DiagPortEvent::Rx(rx(0x7EA, &[0x10, 0x65, 0x62, 0xF1, 0x90, 1, 2, 3], 1));
        assert!(!s.process(&port, &ff, 2, Instant::now()));
        assert_eq!(
            sent_payloads(&port),
            vec![vec![0x32, 0x00, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA]]
        );
        assert_eq!(s.oversize.lock().map(|r| r.len), Some(101));
        let at_cap = DiagPortEvent::Rx(rx(0x7EA, &[0x10, 0x64, 0x62, 0xF1, 0x90, 1, 2, 3], 2));
        assert!(s.process(&port, &at_cap, 3, Instant::now()));
        assert_eq!(port.sent.lock().len(), 1);
    }

    #[test]
    fn oversize_ff_without_padding_answers_dlc3_fc_ovflw() {
        let s = shared_with(false, None);
        let port = RecPort::default();
        s.open_rx();
        let ff = DiagPortEvent::Rx(rx(0x7EA, &escape_ff(0x0001_0001, 8), 1));
        assert!(!s.process(&port, &ff, 1, Instant::now()));
        assert_eq!(sent_payloads(&port), vec![vec![0x32, 0x00, 0x00]]);
        assert_eq!(port.sent.lock()[0].dlc, 3);
    }

    #[test]
    fn oversize_fd_ff_answers_short_fd_fc_ovflw() {
        for (padding, want) in [
            (
                Some(0xCC),
                vec![0x32, 0x00, 0x00, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC],
            ),
            (None, vec![0x32, 0x00, 0x00]),
        ] {
            let s = shared_with(true, padding);
            let port = RecPort {
                fd: true,
                ..Default::default()
            };
            s.open_rx();
            let ff = DiagPortEvent::Rx(fd_rx(0x7EA, &escape_ff(0xFFFF_FFF0, 64)));
            assert!(!s.process(&port, &ff, 1, Instant::now()));
            assert_eq!(sent_payloads(&port), vec![want]);
            let f = port.sent.lock()[0];
            assert!(f.is_fd() && f.is_brs(), "FD FC like automotive's (BRS)");
            assert_eq!(f.arb_id, 0x7E2);
        }
    }

    #[test]
    fn oversize_ff_with_tx_gate_closed_sends_nothing_but_reports() {
        for gate in [
            DiagTxReject::ListenOnly,
            DiagTxReject::Disarmed,
            DiagTxReject::PanicLatched,
        ] {
            let s = shared();
            let port = RecPort {
                gate: Mutex::new(Some(gate)),
                ..Default::default()
            };
            s.open_rx();
            let ff = DiagPortEvent::Rx(rx(0x7EA, &escape_ff(0xFFFF_FFF0, 8), 1));
            assert!(!s.process(&port, &ff, 5, Instant::now()));
            assert!(port.sent.lock().is_empty(), "{gate:?}: no frame written");
            assert_eq!(
                *s.oversize.lock(),
                Some(OversizeRefusal {
                    seq: 5,
                    len: 0xFFFF_FFF0,
                    fc: OvflwFc::Blocked(gate)
                })
            );
            assert_eq!(s.refused_oversize_ff.load(Ordering::Relaxed), 1);
            assert_eq!(s.last_reject(), None, "not a request failure");
            assert!(s.ovflw_in_flight.lock().is_none(), "no retry pending");
        }
    }

    #[test]
    fn late_verdict_on_fc_ovflw_is_kept_from_automotive() {
        let s = shared();
        let port = RecPort::default();
        s.open_rx();
        let ff = DiagPortEvent::Rx(rx(0x7EA, &escape_ff(0xFFFF_FFF0, 8), 1));
        assert!(!s.process(&port, &ff, 1, Instant::now()));
        let fc = port.sent.lock()[0];
        // Bus-io re-check refuses it (e.g. Panic Stop raced the send).
        let late = DiagPortEvent::TxRejected(fc, DiagTxReject::PanicLatched);
        assert!(!s.process(&port, &late, 2, Instant::now()));
        assert_eq!(s.last_reject(), None);
        assert_eq!(
            s.oversize.lock().map(|r| r.fc),
            Some(OvflwFc::Blocked(DiagTxReject::PanicLatched))
        );
        // A confirmation of the next one is dropped too; automotive's own FCs still pass.
        assert!(!s.process(&port, &ff, 3, Instant::now()));
        let fc2 = port.sent.lock()[1];
        assert!(!s.process(&port, &DiagPortEvent::TxConfirmed(fc2), 4, Instant::now()));
        let cts = rx(0x7E2, &[0x30, 0, 0, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA], 5);
        assert!(s.process(&port, &DiagPortEvent::TxConfirmed(cts), 5, Instant::now()));
    }

    fn shared_addr(fd: bool, padding: Option<u8>, tx: u8, rx: u8) -> BridgeShared {
        BridgeShared::new(Addressing {
            request_id: 0x6F1,
            response_id: 0x6F9,
            functional_id: None,
            extended: false,
            fd,
            padding,
            addr: AddressBytes {
                tx: Some(tx),
                rx: Some(rx),
            },
        })
    }

    #[test]
    fn extended_addressing_fc_ovflw_carries_target_address() {
        for (padding, want) in [
            (
                Some(0xAA),
                vec![0x10, 0x32, 0x00, 0x00, 0xAA, 0xAA, 0xAA, 0xAA],
            ),
            (None, vec![0x10, 0x32, 0x00, 0x00]),
        ] {
            let s = shared_addr(false, padding, 0x10, 0xF1);
            let port = RecPort::default();
            s.open_rx();
            let mut ff = vec![0xF1];
            ff.extend(escape_ff(0xFFFF_FFF0, 7));
            assert!(!s.process(
                &port,
                &DiagPortEvent::Rx(rx(0x6F9, &ff, 1)),
                1,
                Instant::now()
            ));
            assert_eq!(sent_payloads(&port), vec![want]);
            assert_eq!(port.sent.lock()[0].arb_id, 0x6F1);
        }
        // CAN-FD: same short FC, FD frame.
        let s = shared_addr(true, Some(0xCC), 0x55, 0x55);
        let port = RecPort {
            fd: true,
            ..Default::default()
        };
        s.open_rx();
        let mut ff = vec![0x55];
        ff.extend(escape_ff(0xFFFF_FFF0, 63));
        assert!(!s.process(
            &port,
            &DiagPortEvent::Rx(fd_rx(0x6F9, &ff)),
            1,
            Instant::now()
        ));
        assert_eq!(
            sent_payloads(&port),
            vec![vec![0x55, 0x32, 0x00, 0x00, 0xCC, 0xCC, 0xCC, 0xCC]]
        );
        assert!(port.sent.lock()[0].is_fd());
    }

    #[test]
    fn foreign_address_byte_is_dropped_and_not_tracked() {
        let s = shared_addr(false, Some(0xAA), 0x10, 0xF1);
        let port = RecPort::default();
        s.open_rx();
        // FF for another tester (0xF2): not ours, no FC, no tracking, no oversize logic.
        let other = rx(0x6F9, &[0xF2, 0x10, 0x14, 0x62, 0xF1, 0x90, 1, 2], 1);
        assert!(!s.process(&port, &DiagPortEvent::Rx(other), 1, Instant::now()));
        assert!(!s.rx_in_progress_after(0));
        let huge = rx(0x6F9, &[0xF2, 0x10, 0x00, 0xFF, 0xFF, 0xFF, 0xF0, 0], 2);
        assert!(!s.process(&port, &DiagPortEvent::Rx(huge), 2, Instant::now()));
        assert!(port.sent.lock().is_empty());
        assert!(s.oversize.lock().is_none());
        // Our own address byte: forwarded and tracked.
        let ours = rx(0x6F9, &[0xF1, 0x10, 0x14, 0x62, 0xF1, 0x90, 1, 2], 3);
        assert!(s.process(&port, &DiagPortEvent::Rx(ours), 3, Instant::now()));
        assert!(s.rx_in_progress_after(0));
    }

    #[test]
    fn tracker_with_address_byte_classic_and_fd() {
        let mut t = RxTracker::with_offset(1);
        let now = Instant::now();
        // SF [RA, 03, 62 F1 86] padded.
        t.feed(
            &rx(0x6F9, &[0xF1, 0x03, 0x62, 0xF1, 0x86, 0xAA, 0xAA, 0xAA], 1),
            1,
            now,
        );
        assert_eq!(t.take(3).map(|m| m.start_seq), Some(1));
        // Length beyond DLC once the address byte is counted.
        t.feed(&rx(0x6F9, &[0xF1, 0x03, 0x62, 0xF1], 1), 2, now);
        assert!(t.take(3).is_none());
        // 20-byte PDU: FF carries 5 bytes, CFs 6 each → FF + 3 CF.
        t.feed(
            &rx(0x6F9, &[0xF1, 0x10, 0x14, 0x62, 0xF1, 0x90, b'W', b'N'], 2),
            3,
            now,
        );
        t.feed(&rx(0x6F9, &[0xF1, 0x21, 1, 2, 3, 4, 5, 6], 3), 4, now);
        t.feed(&rx(0x6F9, &[0xF1, 0x22, 1, 2, 3, 4, 5, 6], 4), 5, now);
        assert_eq!(t.in_progress_since(), Some(3), "17 of 20 bytes");
        t.feed(
            &rx(0x6F9, &[0xF1, 0x23, 1, 2, 3, 0xAA, 0xAA, 0xAA], 5),
            6,
            now,
        );
        assert_eq!(t.take(20).map(|m| (m.start_seq, m.end_ts)), Some((3, 5)));
        // CAN-FD escape SF: [RA, 00, len, ...].
        let mut d = vec![0xF1, 0x00, 20, 0x62, 0xF1, 0x90];
        d.resize(24, 0xAA);
        t.feed(&fd_rx(0x6F9, &d), 9, now);
        assert_eq!(t.take(20).map(|m| m.start_seq), Some(9));
    }

    #[test]
    fn ff_at_max_response_pdu_is_forwarded_without_fc_ovflw() {
        let s = shared();
        let port = RecPort::default();
        s.open_rx();
        let ff = DiagPortEvent::Rx(rx(0x7EA, &escape_ff(MAX_RESPONSE_PDU as u32, 8), 1));
        assert!(
            s.process(&port, &ff, 1, Instant::now()),
            "automotive answers FC.CTS"
        );
        assert!(port.sent.lock().is_empty());
        assert!(s.oversize.lock().is_none());
    }

    #[test]
    fn fc_wait_frames_are_counted_only_while_sending() {
        let s = shared();
        let wait = DiagPortEvent::Rx(rx(0x7EA, &[0x31, 0, 0, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA], 1));
        s.observe(&wait, 1, Instant::now());
        assert_eq!(s.fc_waits.load(Ordering::Acquire), 0);
        s.arm_tx();
        for i in 0..=ISOTP_MAX_WFT {
            s.observe(&wait, 2 + u64::from(i), Instant::now());
        }
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap_or_else(|e| panic!("{e}"));
        let hit = rt.block_on(async {
            tokio::time::timeout(Duration::from_millis(100), s.wait_fc_limit()).await
        });
        assert!(hit.is_ok());
        s.arm_tx();
        let reset = rt.block_on(async {
            tokio::time::timeout(Duration::from_millis(20), s.wait_fc_limit()).await
        });
        assert!(reset.is_err(), "arm_tx resets the WAIT count");
    }

    #[test]
    fn tracker_partial_goes_stale_after_n_cr() {
        let mut t = RxTracker::default();
        let old = Instant::now()
            .checked_sub(Duration::from_secs(2))
            .unwrap_or_else(Instant::now);
        t.feed(
            &rx(0x7EA, &[0x10, 0x14, 0x62, 0xF1, 0x90, 1, 2, 3], 1),
            5,
            old,
        );
        assert_eq!(
            t.in_progress_since(),
            None,
            "FF without CFs for > N_Cr is not in progress"
        );
    }

    #[test]
    fn tracker_single_and_multi_frame() {
        let mut t = RxTracker::default();
        let now = Instant::now();
        t.feed(
            &rx(
                0x7EA,
                &[0x03, 0x62, 0xF1, 0x86, 0xAA, 0xAA, 0xAA, 0xAA],
                100,
            ),
            1,
            now,
        );
        // VIN: 20-byte PDU, FF + 2 CF.
        t.feed(
            &rx(
                0x7EA,
                &[0x10, 0x14, 0x62, 0xF1, 0x90, b'W', b'N', b'X'],
                200,
            ),
            2,
            now,
        );
        assert_eq!(t.in_progress_since(), Some(2));
        t.feed(&rx(0x7EA, &[0x21, 1, 2, 3, 4, 5, 6, 7], 210), 3, now);
        t.feed(&rx(0x7EA, &[0x22, 1, 2, 3, 4, 5, 6, 7], 220), 4, now);
        assert_eq!(t.in_progress_since(), None);
        let m = t.take(20).map(|m| (m.start_seq, m.end_ts));
        // The SF mark (len 3) is skipped when asking for 20.
        assert_eq!(m, Some((2, 220)));
        assert!(t.take(3).is_none());
    }

    #[test]
    fn tracker_rejects_bad_sequence_and_sf() {
        let mut t = RxTracker::default();
        let now = Instant::now();
        t.feed(&rx(0x7EA, &[0x00, 1, 2], 1), 1, now); // zero-length SF
        t.feed(&rx(0x7EA, &[0x07, 1, 2], 1), 2, now); // length beyond DLC
        assert!(t.take(7).is_none());
        t.feed(&rx(0x7EA, &[0x10, 0x10, 1, 2, 3, 4, 5, 6], 1), 3, now);
        t.feed(&rx(0x7EA, &[0x22, 1, 2, 3, 4, 5, 6, 7], 1), 4, now); // wrong SN
        assert_eq!(t.in_progress_since(), None);
        t.feed(&rx(0x7EA, &[0x21, 1, 2, 3, 4, 5, 6, 7], 1), 5, now);
        assert!(t.take(16).is_none());
    }

    #[test]
    fn tracker_fd_escape_sf() {
        let mut t = RxTracker::default();
        let mut data = vec![0x00, 20, 0x62, 0xF1, 0x90];
        data.resize(24, 0xAA);
        let key = CanIdKey::new_standard(0x7EB).unwrap_or(CanIdKey::Standard(0));
        let f = RawCanFrame::new_fd(0, key, &data, true, 5).unwrap_or_default();
        t.feed(&f, 9, Instant::now());
        assert_eq!(t.take(20).map(|m| m.start_seq), Some(9));
    }

    #[test]
    fn frame_conversion_roundtrip() {
        let raw = rx(0x7E2, &[0x02, 0x3E, 0x80, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA], 7);
        let f = raw_to_frame(&raw, false).map(|f| frame_to_raw(&f, 3, 7));
        let back = f.flatten().unwrap_or_default();
        assert_eq!(back.arb_id, 0x7E2);
        assert_eq!(back.bus_id, 3);
        assert_eq!(back.payload(), raw.payload());
        let ext = RawCanFrame::new_classical(
            0,
            CanIdKey::new_extended(0x18DA10F1).unwrap_or(CanIdKey::Extended(0)),
            &[1],
            1,
        )
        .unwrap_or_default();
        let back = raw_to_frame(&ext, true)
            .and_then(|f| frame_to_raw(&f, 0, 1))
            .unwrap_or_default();
        assert!(back.is_extended());
        assert_eq!(back.arb_id, 0x18DA10F1);
    }
}
