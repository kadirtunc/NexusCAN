//! `automotive::can::CanAdapter` implemented on top of a NexusCAN bus-owner [`Tap`].
//!
//! `automotive` ISO-TP is hard-wired to the concrete `AsyncCanAdapter` struct, which spawns its
//! own std thread that owns a blocking `CanAdapter` and busy-polls `recv()` / `send()`.
//! So the only plug-in point below ISO-TP is this blocking trait. Our implementation never
//! touches the CAN channel: it only talks to the owner thread through crossbeam queues.

use crate::convert::{frame_to_raw, raw_to_frame};
use crate::owner::{GateReject, Origin, Tap, TapEvent, TxReq};
use automotive::can::{CanAdapter, Frame};
use crossbeam_channel::{RecvTimeoutError, TryRecvError, TrySendError};
use nexus_core::{now_monotonic_us, RawCanFrame};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Direction/kind of a conversation-log entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogKind {
    Rx,
    TxConfirmed,
    TxRejected(GateReject),
}

/// One CAN-level conversation entry with the **HAL** timestamp (`RawCanFrame::timestamp_us`,
/// which carries `hw_timestamp` when the driver provides one). `automotive::can::Frame` has no
/// timestamp field, so this log is the only place timing survives.
#[derive(Clone, Copy, Debug)]
pub struct LogEntry {
    pub kind: LogKind,
    pub frame: RawCanFrame,
}

#[derive(Default)]
pub struct ConversationLog {
    entries: Mutex<Vec<LogEntry>>,
}

impl ConversationLog {
    fn push(&self, kind: LogKind, frame: RawCanFrame) {
        if let Ok(mut v) = self.entries.lock() {
            v.push(LogEntry { kind, frame });
        }
    }
    pub fn take(&self) -> Vec<LogEntry> {
        self.entries.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default()
    }
}

/// Error surfaced to `automotive` when the owner/gate refuses TX. The worker thread of
/// `AsyncCanAdapter` terminates on any adapter error and every pending/future send on that
/// `AsyncCanAdapter` returns a clone of this error (variant preserved: `Error::IoError`).
pub fn gate_error(r: GateReject) -> automotive::Error {
    let kind = match r {
        GateReject::DriverError => std::io::ErrorKind::Other,
        _ => std::io::ErrorKind::PermissionDenied,
    };
    std::io::Error::new(kind, format!("NexusCAN TX gate: {r:?}")).into()
}

pub struct HalCanAdapter {
    tap: Tap,
    idle_wait: Duration,
    default_brs: bool,
    log: Arc<ConversationLog>,
    early_gate: bool,
}

impl HalCanAdapter {
    /// Spike-only: disable the advisory gate check in `send()` so the test can prove that the
    /// owner thread's authoritative check alone stops TX and that the rejection reaches
    /// `automotive` through `recv()`.
    pub fn without_early_gate(mut self) -> Self {
        self.early_gate = false;
        self
    }

    /// `idle_wait`: how long `recv()` may block when nothing is queued. `automotive`'s worker
    /// only calls `send()` after `recv()` returns, so this bounds added TX latency; zero means
    /// the worker spins with `sleep(1µs)` (high idle CPU, see README measurements).
    pub fn new(tap: Tap, idle_wait: Duration, default_brs: bool, log: Arc<ConversationLog>) -> Self {
        Self { tap, idle_wait, default_brs, log, early_gate: true }
    }

    fn handle(&self, ev: TapEvent, out: &mut Vec<Frame>) -> automotive::Result<()> {
        let bus = self.tap.bus_id;
        match ev {
            TapEvent::Rx(raw) => {
                self.log.push(LogKind::Rx, raw);
                if let Some(f) = raw_to_frame(&raw, bus, false) {
                    out.push(f);
                }
            }
            TapEvent::TxConfirmed(raw) => {
                self.log.push(LogKind::TxConfirmed, raw);
                if let Some(f) = raw_to_frame(&raw, bus, true) {
                    out.push(f);
                }
            }
            TapEvent::TxRejected(raw, why) => {
                self.log.push(LogKind::TxRejected(why), raw);
                return Err(gate_error(why));
            }
        }
        Ok(())
    }
}

impl CanAdapter for HalCanAdapter {
    fn send(&mut self, frames: &mut VecDeque<Frame>) -> automotive::Result<()> {
        // Early (advisory) gate check; the owner re-checks right before send_frame.
        if let (true, Err(why)) = (self.early_gate, self.tap.gate.check()) {
            if let Some(f) = frames.front() {
                if let Ok(raw) = frame_to_raw(f, self.tap.bus_id, now_monotonic_us()) {
                    self.log.push(LogKind::TxRejected(why), raw);
                }
            }
            return Err(gate_error(why));
        }
        while let Some(f) = frames.front() {
            if f.is_fd() && !(self.tap.supports_fd && self.tap.fd_enabled) {
                return Err(automotive::Error::NotSupported);
            }
            let raw = frame_to_raw(f, self.tap.bus_id, now_monotonic_us())
                .map_err(|_| automotive::Error::MalformedFrame)?;
            match self.tap.tx.try_send(TxReq { frame: raw, origin: Origin::Tap(self.tap.slot) }) {
                Ok(()) => {
                    frames.pop_front();
                }
                // Leave the rest queued; the worker retries (documented CanAdapter contract).
                Err(TrySendError::Full(_)) => break,
                Err(TrySendError::Disconnected(_)) => return Err(automotive::Error::Disconnected),
            }
        }
        Ok(())
    }

    fn recv(&mut self) -> automotive::Result<Vec<Frame>> {
        let mut out = Vec::new();
        let first = if self.idle_wait.is_zero() {
            match self.tap.rx.try_recv() {
                Ok(ev) => Some(ev),
                Err(TryRecvError::Empty) => None,
                Err(TryRecvError::Disconnected) => return Err(automotive::Error::Disconnected),
            }
        } else {
            match self.tap.rx.recv_timeout(self.idle_wait) {
                Ok(ev) => Some(ev),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return Err(automotive::Error::Disconnected),
            }
        };
        let Some(first) = first else { return Ok(out) };
        self.handle(first, &mut out)?;
        for _ in 0..255 {
            match self.tap.rx.try_recv() {
                Ok(ev) => self.handle(ev, &mut out)?,
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return Err(automotive::Error::Disconnected),
            }
        }
        Ok(out)
    }

    fn default_brs(&self) -> bool {
        self.default_brs
    }
}

/// Passive variant: never forwards TX to the owner (cannot touch the bus), and
/// confirms locally so `automotive` ISO-TP keeps reassembling. Only used to evaluate whether
/// `automotive` ISO-TP can be abused as a passive (Listen-Only) reassembler.
pub struct PassiveCanAdapter {
    tap: Tap,
    pending_local_echo: VecDeque<Frame>,
    pub swallowed_tx: Arc<std::sync::atomic::AtomicU64>,
}

impl PassiveCanAdapter {
    pub fn new(tap: Tap) -> Self {
        Self { tap, pending_local_echo: VecDeque::new(), swallowed_tx: Arc::default() }
    }
}

impl CanAdapter for PassiveCanAdapter {
    fn send(&mut self, frames: &mut VecDeque<Frame>) -> automotive::Result<()> {
        while let Some(mut f) = frames.pop_front() {
            self.swallowed_tx.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            f.loopback = true;
            self.pending_local_echo.push_back(f);
        }
        Ok(())
    }

    fn recv(&mut self) -> automotive::Result<Vec<Frame>> {
        let mut out: Vec<Frame> = self.pending_local_echo.drain(..).collect();
        match self.tap.rx.recv_timeout(Duration::from_millis(1)) {
            Ok(TapEvent::Rx(raw)) => out.extend(raw_to_frame(&raw, self.tap.bus_id, false)),
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Err(automotive::Error::Disconnected),
        }
        while let Ok(ev) = self.tap.rx.try_recv() {
            if let TapEvent::Rx(raw) = ev {
                out.extend(raw_to_frame(&raw, self.tap.bus_id, false));
            }
        }
        Ok(out)
    }
}
