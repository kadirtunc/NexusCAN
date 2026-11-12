//! D-003 diagnostic taps on the single bus-io owner thread.
//!
//! The bus-io thread (`run_bus_io_loop`) keeps SOLE ownership of the `Box<dyn CanChannel>`.
//! A *tap* is a filtered, bounded side-queue of that thread:
//!
//! * **RX fan-out:** every received frame still goes to the StateTable ring first; frames that
//!   match a tap's acceptance filters are additionally copied (`RawCanFrame: Copy`, no heap) into
//!   the tap's pre-allocated crossbeam queue.
//! * **TX with origin:** frames sent through a tap enter the normal bus TX queue tagged with
//!   [`TxOrigin::Tap`]. After the driver write the bus-io thread reports `TxConfirmed` /
//!   `TxRejected` to the ORIGIN tap only; every other tap sees the echo as ordinary bus traffic.
//! * **Gate:** Listen-Only / Arm Active Bus / Panic Stop latch are checked early in
//!   [`HalDiagPort::send`] (fast failure) and authoritatively inside the bus-io thread
//!   immediately before `send_frame` (see `pipeline::run_bus_io_loop`).
//! * **Close:** Panic Stop, disarm, Listen-Only/Active mode change and disconnect close every
//!   tap of the affected bus (`is_closed() == true`); queued sends are rejected with
//!   [`DiagTxReject::Closed`].
//!
//! Control messages (add/remove tap) are cold path; the `Sender`s they carry are allocated by
//! the requesting (command) thread, never by the bus-io thread.

use crossbeam_channel::{bounded, Receiver, RecvTimeoutError, Sender, TryRecvError, TrySendError};
use nexus_core::{BusId, RawCanFrame};
use nexus_protocols::uds::port::{DiagCanPort, DiagPortEvent, DiagTapFilter, DiagTxReject};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::TxDispatchRequest;

/// Maximum simultaneous diag taps per bus (one per `UdsSession`).
pub const MAX_DIAG_TAPS: usize = 8;
/// Maximum acceptance filters per tap (request id, response id, functional id, spare).
pub const MAX_TAP_FILTERS: usize = 4;
/// Default per-tap event queue depth.
pub const DEFAULT_TAP_DEPTH: usize = 1_024;
const MIN_TAP_DEPTH: usize = 16;
const MAX_TAP_DEPTH: usize = 65_536;
const TAP_CTL_DEPTH: usize = 64;
/// HIGH-07.4: depth of the per-tap priority queue that carries `TxConfirmed` / `TxRejected`
/// verdicts which did not fit into the (RX-congested) main event queue. Verdicts are never
/// dropped because of RX bursts; they are only lost if the consumer stops reading entirely
/// and more than this many verdicts pile up.
pub const TAP_VERDICT_DEPTH: usize = 512;
/// Upper bound for the defensive sleep of `recv_timeout` on a closed, drained tap.
const CLOSED_RECV_BACKOFF: Duration = Duration::from_millis(10);

/// Who asked for a TX frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TxOrigin {
    /// UI raw/signal TX, periodic scheduler, replay restbus.
    Other,
    /// A diag tap; `gen` guards against slot reuse.
    Tap { slot: u8, gen: u32 },
}

/// State shared between a [`HalDiagPort`], the bus registry and the bus-io thread.
#[derive(Debug, Default)]
pub(crate) struct TapShared {
    closed: AtomicBool,
    /// RX events dropped because the tap queue was full.
    rx_dropped: AtomicU64,
}

impl TapShared {
    #[inline]
    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    #[inline]
    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Release);
    }
}

/// Cheap, cloneable view of a tap's liveness (kept by the diag session manager).
#[derive(Clone, Debug)]
pub struct DiagTapStatus(Arc<TapShared>);

impl DiagTapStatus {
    /// `true` once the HAL closed the tap (or the port was dropped).
    pub fn is_closed(&self) -> bool {
        self.0.is_closed()
    }

    /// Forces the tap closed (pending sends will be rejected with `Closed`).
    pub fn close(&self) {
        self.0.close();
    }

    /// RX frames dropped because the tap queue was full.
    pub fn rx_dropped(&self) -> u64 {
        self.0.rx_dropped.load(Ordering::Relaxed)
    }
}

pub(crate) enum TapCtl {
    Add {
        slot: u8,
        gen: u32,
        filters: [Option<DiagTapFilter>; MAX_TAP_FILTERS],
        events: Sender<DiagPortEvent>,
        verdicts: Sender<DiagPortEvent>,
        shared: Arc<TapShared>,
    },
    Remove {
        slot: u8,
        gen: u32,
    },
}

type RegistrySlots = [Option<(u32, Arc<TapShared>)>; MAX_DIAG_TAPS];

/// Per-bus tap registry (command-thread side). Owned by `ConnectedBusHandle`.
pub(crate) struct DiagBusShared {
    ctl_tx: Sender<TapCtl>,
    slots: Mutex<RegistrySlots>,
    next_gen: AtomicU32,
}

impl DiagBusShared {
    /// Creates the registry and the control queue consumed by the bus-io thread.
    pub(crate) fn new() -> (Arc<Self>, Receiver<TapCtl>) {
        let (ctl_tx, ctl_rx) = bounded(TAP_CTL_DEPTH);
        (
            Arc::new(Self {
                ctl_tx,
                slots: Mutex::new(Default::default()),
                next_gen: AtomicU32::new(1),
            }),
            ctl_rx,
        )
    }

    /// Closes every open tap of this bus. Returns how many were open.
    pub(crate) fn close_all(&self) -> usize {
        let guard = self.slots.lock();
        let mut n = 0;
        for (_, shared) in guard.iter().flatten() {
            if !shared.closed.swap(true, Ordering::AcqRel) {
                n += 1;
            }
        }
        n
    }

    /// Number of registered (open or closed-but-not-dropped) taps.
    pub(crate) fn registered(&self) -> usize {
        self.slots.lock().iter().flatten().count()
    }

    pub(crate) fn register(
        self: &Arc<Self>,
        filters: &[DiagTapFilter],
        depth: usize,
    ) -> Result<RegisteredTap, TapRegisterError> {
        if filters.is_empty() || filters.len() > MAX_TAP_FILTERS {
            return Err(TapRegisterError::BadFilters);
        }
        let mut fs = [None; MAX_TAP_FILTERS];
        for (dst, src) in fs.iter_mut().zip(filters) {
            *dst = Some(*src);
        }
        let depth = depth.clamp(MIN_TAP_DEPTH, MAX_TAP_DEPTH);
        let shared = Arc::new(TapShared::default());
        let gen = self.next_gen.fetch_add(1, Ordering::Relaxed).max(1);
        let (events_tx, events_rx) = bounded::<DiagPortEvent>(depth);
        let (verdicts_tx, verdicts_rx) = bounded::<DiagPortEvent>(TAP_VERDICT_DEPTH);

        let slot = {
            let mut guard = self.slots.lock();
            let idx = guard
                .iter()
                .position(Option::is_none)
                .ok_or(TapRegisterError::NoFreeSlot)?;
            guard[idx] = Some((gen, Arc::clone(&shared)));
            idx as u8
        };
        let add = TapCtl::Add {
            slot,
            gen,
            filters: fs,
            events: events_tx,
            verdicts: verdicts_tx,
            shared: Arc::clone(&shared),
        };
        if self.ctl_tx.send(add).is_err() {
            self.release(slot, gen);
            return Err(TapRegisterError::BusGone);
        }
        Ok(RegisteredTap {
            slot,
            gen,
            shared,
            events: events_rx,
            verdicts: verdicts_rx,
        })
    }

    fn release(&self, slot: u8, gen: u32) {
        let mut guard = self.slots.lock();
        if let Some(entry) = guard.get_mut(usize::from(slot)) {
            if entry.as_ref().is_some_and(|(g, _)| *g == gen) {
                *entry = None;
            }
        }
    }
}

pub(crate) struct RegisteredTap {
    pub(crate) slot: u8,
    pub(crate) gen: u32,
    pub(crate) shared: Arc<TapShared>,
    pub(crate) events: Receiver<DiagPortEvent>,
    pub(crate) verdicts: Receiver<DiagPortEvent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TapRegisterError {
    NoFreeSlot,
    BadFilters,
    BusGone,
}

/// TX gate references shared with the bus handle / engine (same atomics the UI TX path uses).
#[derive(Clone)]
pub(crate) struct GateRefs {
    pub(crate) listen_only: bool,
    pub(crate) tx_armed: Arc<AtomicBool>,
    pub(crate) panic_latched: Arc<AtomicBool>,
    /// WP-4: engine TX epoch (bumped by Panic Stop / reset session).
    pub(crate) tx_epoch: Arc<AtomicU64>,
}

impl GateRefs {
    /// Order matters for error reporting: Listen-Only > Panic latch > Disarmed.
    #[inline]
    pub(crate) fn verdict(&self) -> Result<(), DiagTxReject> {
        if self.listen_only {
            Err(DiagTxReject::ListenOnly)
        } else if self.panic_latched.load(Ordering::Acquire) {
            Err(DiagTxReject::PanicLatched)
        } else if !self.tx_armed.load(Ordering::Acquire) {
            Err(DiagTxReject::Disarmed)
        } else {
            Ok(())
        }
    }

    /// Current TX epoch, captured when a request is enqueued.
    #[inline]
    pub(crate) fn epoch(&self) -> u64 {
        self.tx_epoch.load(Ordering::Acquire)
    }

    /// Authoritative dispatch-time verdict: [`Self::verdict`] plus "queued before the last
    /// Panic Stop / reset session" (reported as `PanicLatched`).
    #[inline]
    pub(crate) fn verdict_for_epoch(&self, req_epoch: u64) -> Result<(), DiagTxReject> {
        self.verdict()?;
        if req_epoch != self.epoch() {
            return Err(DiagTxReject::PanicLatched);
        }
        Ok(())
    }
}

/// [`DiagCanPort`] implementation over a bus-io tap. Dropping it closes and unregisters the tap.
pub struct HalDiagPort {
    bus_id: BusId,
    fd_enabled: bool,
    slot: u8,
    gen: u32,
    shared: Arc<TapShared>,
    events: Receiver<DiagPortEvent>,
    /// HIGH-07.4 priority path for TX verdicts that overflowed `events`.
    verdicts: Receiver<DiagPortEvent>,
    tx: Sender<TxDispatchRequest>,
    gate: GateRefs,
    registry: Arc<DiagBusShared>,
}

impl HalDiagPort {
    pub(crate) fn new(
        bus_id: BusId,
        fd_enabled: bool,
        reg: RegisteredTap,
        tx: Sender<TxDispatchRequest>,
        gate: GateRefs,
        registry: Arc<DiagBusShared>,
    ) -> Self {
        Self {
            bus_id,
            fd_enabled,
            slot: reg.slot,
            gen: reg.gen,
            shared: reg.shared,
            events: reg.events,
            verdicts: reg.verdicts,
            tx,
            gate,
            registry,
        }
    }

    /// Liveness handle for the session manager.
    pub fn status(&self) -> DiagTapStatus {
        DiagTapStatus(Arc::clone(&self.shared))
    }

    /// Tap slot index on its bus (diagnostics / tests).
    pub fn slot(&self) -> u8 {
        self.slot
    }

    fn recv_main_timeout(&self, timeout: Duration) -> Option<DiagPortEvent> {
        match self.events.recv_timeout(timeout) {
            Ok(ev) => Some(ev),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => self.on_main_disconnected(timeout),
        }
    }

    /// Bus-io thread gone (disconnect / mode change): queues drained, tap closed.
    fn on_main_disconnected(&self, timeout: Duration) -> Option<DiagPortEvent> {
        if let Ok(ev) = self.verdicts.try_recv() {
            return Some(ev);
        }
        self.shared.close();
        self.closed_backoff(timeout);
        None
    }

    fn closed_backoff(&self, timeout: Duration) {
        // A closed tap never produces events again. Sleep (bounded) instead of returning
        // instantly so a caller that loops on `recv_timeout` without checking `is_closed()`
        // cannot turn into a busy spin.
        let nap = timeout.min(CLOSED_RECV_BACKOFF);
        if !nap.is_zero() {
            std::thread::sleep(nap);
        }
    }
}

impl DiagCanPort for HalDiagPort {
    fn bus_id(&self) -> u8 {
        self.bus_id
    }

    fn fd_enabled(&self) -> bool {
        self.fd_enabled
    }

    fn gate_check(&self) -> Result<(), DiagTxReject> {
        if self.shared.is_closed() {
            return Err(DiagTxReject::Closed);
        }
        self.gate.verdict()
    }

    fn send(&self, mut frame: RawCanFrame) -> Result<(), DiagTxReject> {
        // Capture the epoch BEFORE the gate check: a Panic Stop racing with this call either
        // fails the gate here or invalidates the epoch for the bus-io dispatch gate.
        let epoch = self.gate.epoch();
        self.gate_check()?;
        frame.bus_id = self.bus_id;
        frame.flags &= !nexus_core::FLAG_TX;
        let req = TxDispatchRequest {
            frame,
            ack: None,
            suppress_echo: false,
            hw_tx_counter: None,
            origin: TxOrigin::Tap {
                slot: self.slot,
                gen: self.gen,
            },
            epoch,
        };
        match self.tx.try_send(req) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(DiagTxReject::QueueFull),
            Err(TrySendError::Disconnected(_)) => {
                self.shared.close();
                Err(DiagTxReject::Closed)
            }
        }
    }

    fn recv_timeout(&self, timeout: Duration) -> Option<DiagPortEvent> {
        // Priority path first: overflowed TX verdicts (normally empty).
        if let Ok(ev) = self.verdicts.try_recv() {
            return Some(ev);
        }
        crossbeam_channel::select_biased! {
            recv(self.verdicts) -> r => match r {
                Ok(ev) => Some(ev),
                // Bus-io side gone; fall back to the main queue (drains, then disconnects).
                Err(_) => self.recv_main_timeout(timeout),
            },
            recv(self.events) -> r => match r {
                Ok(ev) => Some(ev),
                Err(_) => self.on_main_disconnected(timeout),
            },
            default(timeout) => None,
        }
    }

    fn try_recv(&self) -> Option<DiagPortEvent> {
        if let Ok(ev) = self.verdicts.try_recv() {
            return Some(ev);
        }
        match self.events.try_recv() {
            Ok(ev) => Some(ev),
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => {
                self.shared.close();
                None
            }
        }
    }

    fn is_closed(&self) -> bool {
        self.shared.is_closed()
    }
}

impl Drop for HalDiagPort {
    fn drop(&mut self) {
        self.shared.close();
        self.registry.release(self.slot, self.gen);
        // Bus-io thread may already be gone: ignore errors. `try_send` so a stalled bus-io
        // thread can never block the dropping (command) thread; a missed Remove is harmless
        // because the bus-io side also drops slots whose receiver disconnected.
        let _ = self.registry.ctl_tx.try_send(TapCtl::Remove {
            slot: self.slot,
            gen: self.gen,
        });
    }
}

// ─── bus-io thread side ─────────────────────────────────────────────────────

#[inline]
fn filter_matches(flt: &DiagTapFilter, f: &RawCanFrame) -> bool {
    (f.arb_id & flt.mask) == (flt.id & flt.mask)
        && flt.extended.is_none_or(|e| e == f.is_extended())
}

struct TapSlot {
    gen: u32,
    filters: [Option<DiagTapFilter>; MAX_TAP_FILTERS],
    events: Sender<DiagPortEvent>,
    verdicts: Sender<DiagPortEvent>,
    shared: Arc<TapShared>,
}

impl TapSlot {
    #[inline]
    fn matches(&self, f: &RawCanFrame) -> bool {
        self.filters.iter().flatten().any(|flt| filter_matches(flt, f))
    }
}

/// Fixed-size tap table owned by the bus-io thread. No allocation after construction.
pub(crate) struct TapTable {
    slots: [Option<TapSlot>; MAX_DIAG_TAPS],
    active: usize,
}

impl TapTable {
    pub(crate) fn new() -> Self {
        Self {
            slots: Default::default(),
            active: 0,
        }
    }

    #[inline]
    pub(crate) fn is_empty(&self) -> bool {
        self.active == 0
    }

    fn recount(&mut self) {
        self.active = self.slots.iter().flatten().count();
    }

    /// Applies pending add/remove requests (cold path, non-blocking).
    pub(crate) fn apply_ctl(&mut self, ctl_rx: &Receiver<TapCtl>) {
        let mut changed = false;
        loop {
            match ctl_rx.try_recv() {
                Ok(TapCtl::Add {
                    slot,
                    gen,
                    filters,
                    events,
                    verdicts,
                    shared,
                }) => {
                    if let Some(entry) = self.slots.get_mut(usize::from(slot)) {
                        *entry = Some(TapSlot {
                            gen,
                            filters,
                            events,
                            verdicts,
                            shared,
                        });
                        changed = true;
                    }
                }
                Ok(TapCtl::Remove { slot, gen }) => {
                    if let Some(entry) = self.slots.get_mut(usize::from(slot)) {
                        if entry.as_ref().is_some_and(|s| s.gen == gen) {
                            *entry = None;
                            changed = true;
                        }
                    }
                }
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
            }
        }
        if changed {
            self.recount();
        }
    }

    /// Resolves a TX origin to a live slot index (`None` = stale / unknown tap).
    #[inline]
    pub(crate) fn lookup(&self, slot: u8, gen: u32) -> Option<usize> {
        let idx = usize::from(slot);
        self.slots
            .get(idx)
            .and_then(Option::as_ref)
            .filter(|s| s.gen == gen)
            .map(|_| idx)
    }

    #[inline]
    pub(crate) fn is_slot_closed(&self, idx: usize) -> bool {
        self.slots[idx].as_ref().is_none_or(|s| s.shared.is_closed())
    }

    /// Sends a TX verdict to the origin tap only.
    ///
    /// HIGH-07.4: the verdict normally travels in the main event queue (keeps bus order with
    /// RX). If an RX burst filled that queue, it goes to the tap's dedicated verdict queue
    /// instead, which the port drains first, so `TxConfirmed` / `TxRejected` are never lost
    /// to RX congestion.
    #[inline]
    pub(crate) fn notify(&mut self, idx: usize, ev: DiagPortEvent) {
        if let Some(s) = &self.slots[idx] {
            let disconnected = match s.events.try_send(ev) {
                Ok(()) => false,
                Err(TrySendError::Full(ev)) => {
                    matches!(s.verdicts.try_send(ev), Err(TrySendError::Disconnected(_)))
                }
                Err(TrySendError::Disconnected(_)) => true,
            };
            if disconnected {
                self.slots[idx] = None;
                self.recount();
            }
        }
    }

    /// Copies `f` into every open tap whose filters match (except `skip`). Zero allocation.
    #[inline]
    pub(crate) fn deliver(&mut self, f: &RawCanFrame, skip: Option<usize>) {
        if self.active == 0 || f.is_error() {
            return;
        }
        let mut disconnected = false;
        for (i, entry) in self.slots.iter_mut().enumerate() {
            if skip == Some(i) {
                continue;
            }
            let Some(s) = entry else { continue };
            if s.shared.is_closed() || !s.matches(f) {
                continue;
            }
            match s.events.try_send(DiagPortEvent::Rx(*f)) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => {
                    s.shared.rx_dropped.fetch_add(1, Ordering::Relaxed);
                }
                Err(TrySendError::Disconnected(_)) => {
                    *entry = None;
                    disconnected = true;
                }
            }
        }
        if disconnected {
            self.recount();
        }
    }

    /// Bus-io thread exit: reject every queued tap TX with `Closed`, close all taps.
    pub(crate) fn shutdown(&mut self, tx_rx: &Receiver<TxDispatchRequest>, ctl_rx: &Receiver<TapCtl>) {
        self.apply_ctl(ctl_rx);
        for s in self.slots.iter().flatten() {
            s.shared.close();
        }
        while let Ok(req) = tx_rx.try_recv() {
            match req.origin {
                TxOrigin::Tap { slot, gen } => {
                    if let Some(idx) = self.lookup(slot, gen) {
                        self.notify(idx, DiagPortEvent::TxRejected(req.frame, DiagTxReject::Closed));
                    }
                }
                TxOrigin::Other => {
                    if let Some(ack) = req.ack {
                        let _ = ack.send(Err(crate::error::AdapterError::ChannelClosed));
                    }
                }
            }
        }
        // Dropping the slots disconnects every tap receiver.
        self.slots = Default::default();
        self.active = 0;
    }
}
