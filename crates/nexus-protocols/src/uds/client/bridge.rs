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
/// (e.g. the 32-bit escape `10 00 FF FF FF F0`) is refused before `automotive` sees it: no FC.CTS is
/// sent and nothing is buffered. Classic CAN FFs are ≤ 4095 by encoding; this caps the escape form.
pub const MAX_RESPONSE_PDU: usize = 64 * 1024;
/// Most Flow Control WAIT frames accepted while sending one request (sender-side N_WFTmax,
/// HIGH-07.2). `automotive` restarts N_Bs on every WAIT and would otherwise wait forever.
pub const ISOTP_MAX_WFT: u32 = 10;
/// A multi-frame reception whose last frame is older than this is no longer "in progress"
/// (ISO-TP N_Cr is 1000 ms); keeps a stalled / refused FF from extending the response deadline.
const TRACKER_STALE: Duration = Duration::from_millis(1100);

/// Announced PDU length of a First Frame (`None` if `data` is not a well-formed FF).
fn first_frame_len(data: &[u8]) -> Option<usize> {
    let b0 = *data.first()?;
    if b0 >> 4 != 1 || data.len() < 8 {
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

/// Static addressing used by the pump to classify frames.
#[derive(Debug, Clone, Copy)]
pub struct Addressing {
    pub request_id: u32,
    pub response_id: u32,
    pub functional_id: Option<u32>,
    pub extended: bool,
    pub fd: bool,
}

impl Addressing {
    fn is_response(&self, f: &RawCanFrame) -> bool {
        f.arb_id == self.response_id && f.is_extended() == self.extended && !f.is_error() && !f.is_rtr()
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
}

const MAX_MARKS: usize = 64;

impl RxTracker {
    pub fn feed(&mut self, f: &RawCanFrame, seq: u64, at: Instant) {
        let data = f.payload();
        let dlc = data.len();
        let Some(&b0) = data.first() else { return };
        match b0 >> 4 {
            0 => {
                let len = if dlc <= 8 {
                    let len = usize::from(b0 & 0x0F);
                    if len == 0 || len + 1 > dlc {
                        return;
                    }
                    len
                } else {
                    if b0 & 0x0F != 0 || dlc < 2 {
                        return;
                    }
                    let len = usize::from(data[1]);
                    if len == 0 || len + 2 > dlc {
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
                    if dlc < 6 {
                        return;
                    }
                    (u32::from_be_bytes([data[2], data[3], data[4], data[5]]) as usize, 6)
                } else {
                    (short, 2)
                };
                let received = dlc - hdr;
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
                p.received += dlc.saturating_sub(1);
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
        self.partial.filter(|p| p.last_at.elapsed() <= TRACKER_STALE).map(|p| p.start_seq)
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
    /// Most recent oversized First Frame refused while an exchange was open: `(pump seq, length)`.
    oversize: Mutex<Option<(u64, usize)>>,
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
            tracker: Mutex::new(RxTracker::default()),
            tx_arm: Mutex::new(TxArm::default()),
            last_reject: Mutex::new(None),
            hal_closed: AtomicBool::new(false),
            dropped: AtomicU64::new(0),
            capture: IsoTpCapture::default(),
            rx_open: AtomicBool::new(false),
            fc_waits: AtomicU32::new(0),
            oversize: Mutex::new(None),
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

    /// Resolves with the announced length of an oversized First Frame refused after `after_seq`.
    pub async fn wait_oversize(&self, after_seq: u64) -> usize {
        loop {
            let notified = self.alert.notified();
            if let Some((seq, len)) = *self.oversize.lock() {
                if seq > after_seq {
                    return len;
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
        self.tracker.lock().in_progress_since().is_some_and(|s| s > after_seq)
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

    /// Observes one port event in bus order and decides whether it is forwarded to `automotive`
    /// (`false` = dropped before the ISO-TP stack; it is still in the ISO-TP Monitor capture).
    fn observe(&self, ev: &DiagPortEvent, seq: u64, at: Instant) -> bool {
        match ev {
            DiagPortEvent::Rx(f) => {
                if self.addressing.is_response(f) && f.is_fd() == self.addressing.fd {
                    let data = f.payload();
                    if let Some(len) = first_frame_len(data) {
                        if !self.rx_open.load(Ordering::Acquire) {
                            // Idle: not our transfer. Without the FF, `automotive` ignores the CFs too.
                            self.dropped_idle_ff.fetch_add(1, Ordering::Relaxed);
                            self.tracker.lock().reset_partial();
                            return false;
                        }
                        if len > MAX_RESPONSE_PDU {
                            self.refused_oversize_ff.fetch_add(1, Ordering::Relaxed);
                            self.tracker.lock().reset_partial();
                            *self.oversize.lock() = Some((seq, len));
                            self.alert.notify_waiters();
                            return false;
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
                // Request frames (SF / FF / CF), not our own flow control (PCI 3).
                let pci = f.payload().first().map(|b| b >> 4);
                if self.addressing.is_own_tx(f) && matches!(pci, Some(0..=2)) {
                    let mut a = self.tx_arm.lock();
                    if a.armed {
                        a.confirm = Some(TxConfirm { ts: f.timestamp_us, hw: f.has_hw_timestamp(), at });
                    }
                }
            }
            DiagPortEvent::TxRejected(_, why) => self.record_reject(*why),
        }
        true
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
        let Some(ev) = port.recv_timeout(PUMP_WAIT) else { continue };
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
        if !shared.observe(&ev, seq, Instant::now()) {
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
        Identifier::Standard(s) => u16::try_from(s.as_raw()).ok().and_then(CanIdKey::new_standard),
        Identifier::Extended(e) => CanIdKey::new_extended(e.as_raw()),
    };
    match frame.content() {
        FrameContent::Classic { id, data } => RawCanFrame::new_classical(bus_id, key(id)?, data, ts_us).ok(),
        FrameContent::Fd { id, data, brs, esi } => {
            let mut raw = RawCanFrame::new_fd(bus_id, key(id)?, data, *brs, ts_us).ok()?;
            if *esi {
                raw.flags |= nexus_core::FLAG_ESI;
            }
            Some(raw)
        }
        FrameContent::Remote { id, dlc } => RawCanFrame::new_rtr(bus_id, key(id)?, (*dlc).min(8), ts_us).ok(),
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
    std::io::Error::new(std::io::ErrorKind::PermissionDenied, format!("NexusCAN TX refused: {r:?}")).into()
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
    pub fn new(rx: Receiver<PortMsg>, port: Arc<dyn DiagCanPort>, shared: Arc<BridgeShared>) -> Self {
        let bus_id = port.bus_id();
        let fd_enabled = port.fd_enabled();
        Self { rx, port, shared, bus_id, fd_enabled, in_flight: VecDeque::new(), last_activity: Instant::now() }
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
            let raw = frame_to_raw(f, self.bus_id, now_monotonic_us()).ok_or(automotive::Error::MalformedFrame)?;
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
        true
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
            DiagPortEvent::TxConfirmed(rx(0x7E2, &[0x03, 0x22, 0xF1, 0xF1, 0xAA, 0xAA, 0xAA, 0xAA], 10)),
            DiagPortEvent::TxRejected(rx(0x7E2, &[0x02, 0x3E, 0x80], 11), DiagTxReject::Disarmed),
            DiagPortEvent::Rx(rx(0x7EA, &[0x10, 0x14, 0x62, 0xF1, 0xF1, 0x41, 0x42, 0x43], 12)),
            DiagPortEvent::TxConfirmed(rx(0x7E2, &[0x30, 0x00, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA], 13)),
            DiagPortEvent::Rx(rx(0x7EA, &[0x21, 1, 2, 3, 4, 5, 6, 7], 14)),
        ]);
        let port: Arc<dyn DiagCanPort> = Arc::new(ScriptPort(Mutex::new(events)));
        let shared = Arc::new(BridgeShared::new(Addressing {
            request_id: 0x7E2,
            response_id: 0x7EA,
            functional_id: None,
            extended: false,
            fd: false,
        }));
        let (tx, _rx) = crossbeam_channel::bounded(64);
        pump_loop(port, shared.clone(), tx, Arc::new(AtomicBool::new(false)));
        let p = shared.capture.since(0, 100);
        let got: Vec<(u64, IsoTpDirection, IsoTpFrameKind, u64)> =
            p.frames.iter().map(|f| (f.seq, f.direction, f.kind, f.timestamp_us)).collect();
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
        BridgeShared::new(Addressing { request_id: 0x7E2, response_id: 0x7EA, functional_id: None, extended: false, fd: false })
    }

    #[test]
    fn first_frame_len_parses_short_and_escape_forms() {
        assert_eq!(first_frame_len(&[0x1F, 0xFF, 0, 0, 0, 0, 0, 0]), Some(4095));
        assert_eq!(first_frame_len(&[0x10, 0x00, 0xFF, 0xFF, 0xFF, 0xF0, 0, 0]), Some(0xFFFF_FFF0));
        assert_eq!(first_frame_len(&[0x10, 0x14, 0, 0, 0]), None, "short DLC");
        assert_eq!(first_frame_len(&[0x21, 0, 0, 0, 0, 0, 0, 0]), None, "CF");
    }

    #[test]
    fn idle_first_frame_is_not_forwarded_to_isotp() {
        let s = shared();
        let ff = DiagPortEvent::Rx(rx(0x7EA, &[0x10, 0x14, 0x62, 0xF1, 0x90, 1, 2, 3], 1));
        assert!(!s.observe(&ff, 1, Instant::now()), "idle FF must be dropped (no FC.CTS)");
        assert_eq!(s.dropped_idle_ff.load(Ordering::Relaxed), 1);
        let sf = DiagPortEvent::Rx(rx(0x7EA, &[0x03, 0x7F, 0x22, 0x31, 0, 0, 0, 0], 2));
        assert!(s.observe(&sf, 2, Instant::now()), "SFs are still forwarded (logged as stale)");
        s.open_rx();
        assert!(s.observe(&ff, 3, Instant::now()), "FF during an exchange is forwarded");
        s.close_rx();
        assert!(!s.observe(&ff, 4, Instant::now()));
    }

    #[test]
    fn oversized_first_frame_is_refused_and_signalled() {
        let s = shared();
        s.open_rx();
        let huge = DiagPortEvent::Rx(rx(0x7EA, &[0x10, 0x00, 0xFF, 0xFF, 0xFF, 0xF0, 0x62, 0xF1], 1));
        assert!(!s.observe(&huge, 7, Instant::now()));
        assert_eq!(*s.oversize.lock(), Some((7, 0xFFFF_FFF0)));
        assert!(!s.rx_in_progress_after(0), "a refused FF must not extend the response deadline");
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap_or_else(|e| panic!("{e}"));
        let len = rt.block_on(async { tokio::time::timeout(Duration::from_millis(100), s.wait_oversize(6)).await });
        assert_eq!(len.ok(), Some(0xFFFF_FFF0));
        // An older refusal does not fail a newer exchange.
        let stale = rt.block_on(async { tokio::time::timeout(Duration::from_millis(20), s.wait_oversize(7)).await });
        assert!(stale.is_err());
        let limit = DiagPortEvent::Rx(rx(0x7EA, &[0x10, 0x00, 0x00, 0x01, 0x00, 0x00, 0x62, 0xF1], 2));
        assert!(s.observe(&limit, 8, Instant::now()), "exactly MAX_RESPONSE_PDU is accepted");
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
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap_or_else(|e| panic!("{e}"));
        let hit = rt.block_on(async { tokio::time::timeout(Duration::from_millis(100), s.wait_fc_limit()).await });
        assert!(hit.is_ok());
        s.arm_tx();
        let reset = rt.block_on(async { tokio::time::timeout(Duration::from_millis(20), s.wait_fc_limit()).await });
        assert!(reset.is_err(), "arm_tx resets the WAIT count");
    }

    #[test]
    fn tracker_partial_goes_stale_after_n_cr() {
        let mut t = RxTracker::default();
        let old = Instant::now().checked_sub(Duration::from_secs(2)).unwrap_or_else(Instant::now);
        t.feed(&rx(0x7EA, &[0x10, 0x14, 0x62, 0xF1, 0x90, 1, 2, 3], 1), 5, old);
        assert_eq!(t.in_progress_since(), None, "FF without CFs for > N_Cr is not in progress");
    }

    #[test]
    fn tracker_single_and_multi_frame() {
        let mut t = RxTracker::default();
        let now = Instant::now();
        t.feed(&rx(0x7EA, &[0x03, 0x62, 0xF1, 0x86, 0xAA, 0xAA, 0xAA, 0xAA], 100), 1, now);
        // VIN: 20-byte PDU, FF + 2 CF.
        t.feed(&rx(0x7EA, &[0x10, 0x14, 0x62, 0xF1, 0x90, b'W', b'N', b'X'], 200), 2, now);
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
        let ext = RawCanFrame::new_classical(0, CanIdKey::new_extended(0x18DA10F1).unwrap_or(CanIdKey::Extended(0)), &[1], 1)
            .unwrap_or_default();
        let back = raw_to_frame(&ext, true).and_then(|f| frame_to_raw(&f, 0, 1)).unwrap_or_default();
        assert!(back.is_extended());
        assert_eq!(back.arb_id, 0x18DA10F1);
    }
}
