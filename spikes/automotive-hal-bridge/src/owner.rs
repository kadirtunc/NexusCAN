//! Single-owner bus I/O thread with zero-allocation RX fan-out ("taps") and an authoritative
//! TX safety gate.
//!
//! This mirrors `nexus_hal::pipeline::run_bus_io_loop` (one thread owns the `Box<dyn CanChannel>`,
//! TX arrives over a bounded crossbeam queue, RX goes to the StateTable over a bounded queue)
//! and adds the two things D-003 needs and the product loop does not have yet:
//!
//! 1. **Taps:** up to [`MAX_TAPS`] diagnostic subscribers, each with up to [`TAP_FILTERS`]
//!    acceptance filters and a pre-allocated bounded queue. Per RX frame the owner does
//!    `filter match -> try_send(Copy)`; nothing is allocated (proved by `alloc` scenario).
//! 2. **TX origin + confirmation:** each TX request carries its origin. After `send_frame`
//!    the owner reports `TxConfirmed` (or `TxRejected`) to the originating tap only, which the
//!    `automotive` worker needs as its transmit echo.
//!
//! The safety gate (Listen-Only / Arm Active Bus / Panic Stop latch) is checked **here,
//! immediately before `send_frame`**, so no upper layer (UDS, ISO-TP, scripts) can bypass it.

use crossbeam_channel::{bounded, Receiver, Sender, TryRecvError, TrySendError};
use nexus_core::{now_monotonic_us, BusId, RawCanFrame, FLAG_TX};
use nexus_hal::{AdapterError, CanChannel};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

pub const MAX_TAPS: usize = 4;
pub const TAP_FILTERS: usize = 4;
pub const TX_QUEUE_DEPTH: usize = 4_096;
pub const RX_BATCH: usize = 256;

/// Acceptance filter for a tap: `(arb_id & mask) == (id & mask)` + optional IDE match.
#[derive(Clone, Copy, Debug)]
pub struct TapFilter {
    pub id: u32,
    pub mask: u32,
    pub extended: Option<bool>,
}

impl TapFilter {
    pub const fn exact_std(id: u32) -> Self {
        Self { id, mask: 0x7FF, extended: Some(false) }
    }
    pub const fn exact_ext(id: u32) -> Self {
        Self { id, mask: 0x1FFF_FFFF, extended: Some(true) }
    }
    pub const fn all() -> Self {
        Self { id: 0, mask: 0, extended: None }
    }
    #[inline]
    fn matches(&self, f: &RawCanFrame) -> bool {
        (f.arb_id & self.mask) == (self.id & self.mask)
            && self.extended.is_none_or(|e| e == f.is_extended())
    }
}

/// Why the owner refused to put a frame on the bus.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateReject {
    ListenOnly,
    Disarmed,
    PanicLatched,
    DriverError,
}

/// Per-bus TX interlock. Same semantics as `ConnectedBusHandle::{listen_only, tx_armed}` +
/// `PipelineEngine::tx_panic_latched` in the product.
#[derive(Debug)]
pub struct SafetyGate {
    listen_only: bool,
    armed: AtomicBool,
    panic_latched: AtomicBool,
}

impl SafetyGate {
    pub fn new(listen_only: bool, armed: bool) -> Self {
        Self {
            listen_only,
            armed: AtomicBool::new(armed && !listen_only),
            panic_latched: AtomicBool::new(false),
        }
    }
    #[inline]
    pub fn check(&self) -> Result<(), GateReject> {
        if self.listen_only {
            Err(GateReject::ListenOnly)
        } else if self.panic_latched.load(Ordering::Acquire) {
            Err(GateReject::PanicLatched)
        } else if !self.armed.load(Ordering::Acquire) {
            Err(GateReject::Disarmed)
        } else {
            Ok(())
        }
    }
    pub fn is_listen_only(&self) -> bool {
        self.listen_only
    }
    /// "Arm Active Bus": clears the panic latch (product behaviour of `cmd_arm_active_bus`).
    pub fn arm(&self) -> bool {
        if self.listen_only {
            return false;
        }
        self.armed.store(true, Ordering::Release);
        self.panic_latched.store(false, Ordering::Release);
        true
    }
    /// "Panic Stop (Stop All TX)": latch + disarm.
    pub fn panic_stop(&self) {
        self.panic_latched.store(true, Ordering::Release);
        self.armed.store(false, Ordering::Release);
    }
}

/// Events delivered to a tap. All variants are `Copy` (no heap).
#[derive(Clone, Copy, Debug)]
pub enum TapEvent {
    /// A frame seen on the bus (from another node, or TX by another origin on this host).
    Rx(RawCanFrame),
    /// The owner handed this tap's frame to the driver successfully (timestamp = after send).
    TxConfirmed(RawCanFrame),
    /// The owner refused this tap's frame (gate) or the driver failed.
    TxRejected(RawCanFrame, GateReject),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    /// UI raw/signal TX, periodic scheduler, replay — anything that is not a tap.
    Other,
    Tap(u8),
}

#[derive(Clone, Copy, Debug)]
pub struct TxReq {
    pub frame: RawCanFrame,
    pub origin: Origin,
}

enum Ctl {
    AddTap { slot: u8, filters: [Option<TapFilter>; TAP_FILTERS], tx: Sender<TapEvent> },
    RemoveTap(u8),
}

#[derive(Default, Debug)]
pub struct OwnerStats {
    pub rx_frames: AtomicU64,
    pub telemetry_dropped: AtomicU64,
    pub tap_delivered: AtomicU64,
    pub tap_dropped: AtomicU64,
    pub tx_sent: AtomicU64,
    pub tx_rejected: AtomicU64,
    pub loop_iterations: AtomicU64,
}

impl OwnerStats {
    pub fn snapshot(&self) -> [u64; 7] {
        [
            self.rx_frames.load(Ordering::Relaxed),
            self.telemetry_dropped.load(Ordering::Relaxed),
            self.tap_delivered.load(Ordering::Relaxed),
            self.tap_dropped.load(Ordering::Relaxed),
            self.tx_sent.load(Ordering::Relaxed),
            self.tx_rejected.load(Ordering::Relaxed),
            self.loop_iterations.load(Ordering::Relaxed),
        ]
    }
}

/// Handle given to a diagnostic client: its private RX queue + the shared TX queue.
pub struct Tap {
    pub slot: u8,
    pub bus_id: BusId,
    pub rx: Receiver<TapEvent>,
    pub tx: Sender<TxReq>,
    pub gate: Arc<SafetyGate>,
    pub supports_fd: bool,
    pub fd_enabled: bool,
    ctl: Sender<Ctl>,
    slots: Arc<Mutex<[bool; MAX_TAPS]>>,
}

impl Drop for Tap {
    fn drop(&mut self) {
        let _ = self.ctl.send(Ctl::RemoveTap(self.slot));
        if let Ok(mut s) = self.slots.lock() {
            s[usize::from(self.slot)] = false;
        }
    }
}

#[derive(Debug)]
pub enum TapOpenError {
    NoFreeSlot,
    ListenOnly,
}

pub struct BusOwner {
    pub bus_id: BusId,
    pub gate: Arc<SafetyGate>,
    pub stats: Arc<OwnerStats>,
    tx: Sender<TxReq>,
    ctl: Sender<Ctl>,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    slots: Arc<Mutex<[bool; MAX_TAPS]>>,
    supports_fd: bool,
    fd_enabled: bool,
}

impl BusOwner {
    /// Spawns the owner thread. `telemetry` is the bounded queue into the StateTable aggregator.
    /// `thread_init` runs once on the owner thread (used by the allocation-counting scenario).
    pub fn spawn(
        bus_id: BusId,
        channel: Box<dyn CanChannel>,
        listen_only: bool,
        armed: bool,
        fd_enabled: bool,
        telemetry: Sender<RawCanFrame>,
        thread_init: Option<fn()>,
    ) -> Self {
        let gate = Arc::new(SafetyGate::new(listen_only, armed));
        let stats = Arc::new(OwnerStats::default());
        let (tx, tx_rx) = bounded::<TxReq>(TX_QUEUE_DEPTH);
        let (ctl, ctl_rx) = bounded::<Ctl>(16);
        let stop = Arc::new(AtomicBool::new(false));
        let supports_fd = channel.capabilities().supports_fd;
        let self_loopback = channel.descriptor().driver_id == "mock";

        let (g, s, st) = (Arc::clone(&gate), Arc::clone(&stats), Arc::clone(&stop));
        let join = std::thread::Builder::new()
            .name(format!("bus-owner-{bus_id}"))
            .spawn(move || {
                if let Some(f) = thread_init {
                    f();
                }
                owner_loop(bus_id, channel, self_loopback, tx_rx, ctl_rx, telemetry, g, s, st);
            })
            .expect("spawn owner");

        Self {
            bus_id,
            gate,
            stats,
            tx,
            ctl,
            stop,
            join: Some(join),
            slots: Arc::new(Mutex::new([false; MAX_TAPS])),
            supports_fd,
            fd_enabled,
        }
    }

    /// Registers a diagnostic tap. `active = true` refuses Listen-Only buses up front
    /// (the authoritative check still happens per frame in the owner thread).
    pub fn open_tap(&self, filters: &[TapFilter], depth: usize, active: bool) -> Result<Tap, TapOpenError> {
        if active && self.gate.is_listen_only() {
            return Err(TapOpenError::ListenOnly);
        }
        let slot = {
            let mut s = self.slots.lock().expect("slots");
            let idx = s.iter().position(|used| !used).ok_or(TapOpenError::NoFreeSlot)?;
            s[idx] = true;
            idx as u8
        };
        let mut fs = [None; TAP_FILTERS];
        for (dst, src) in fs.iter_mut().zip(filters.iter()) {
            *dst = Some(*src);
        }
        let (etx, erx) = bounded::<TapEvent>(depth);
        let _ = self.ctl.send(Ctl::AddTap { slot, filters: fs, tx: etx });
        Ok(Tap {
            slot,
            bus_id: self.bus_id,
            rx: erx,
            tx: self.tx.clone(),
            gate: Arc::clone(&self.gate),
            supports_fd: self.supports_fd,
            fd_enabled: self.fd_enabled,
            ctl: self.ctl.clone(),
            slots: Arc::clone(&self.slots),
        })
    }

    /// TX from a non-diagnostic origin (UI / scheduler) — still goes through the same gate.
    pub fn transmit_other(&self, frame: RawCanFrame) {
        let _ = self.tx.try_send(TxReq { frame, origin: Origin::Other });
    }

    pub fn shutdown(mut self) -> Duration {
        let t0 = std::time::Instant::now();
        self.stop.store(true, Ordering::Release);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
        t0.elapsed()
    }
}

impl Drop for BusOwner {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

type TapSlot = Option<([Option<TapFilter>; TAP_FILTERS], Sender<TapEvent>)>;

#[inline]
fn tap_matches(filters: &[Option<TapFilter>; TAP_FILTERS], f: &RawCanFrame) -> bool {
    filters.iter().flatten().any(|flt| flt.matches(f))
}

#[allow(clippy::too_many_arguments)]
fn owner_loop(
    bus_id: BusId,
    mut channel: Box<dyn CanChannel>,
    self_loopback: bool,
    tx_rx: Receiver<TxReq>,
    ctl_rx: Receiver<Ctl>,
    telemetry: Sender<RawCanFrame>,
    gate: Arc<SafetyGate>,
    stats: Arc<OwnerStats>,
    stop: Arc<AtomicBool>,
) {
    let mut rx_batch = [RawCanFrame::zeroed(); RX_BATCH];
    let mut taps: [TapSlot; MAX_TAPS] = Default::default();

    let deliver = |taps: &mut [TapSlot; MAX_TAPS], f: &RawCanFrame, skip: Option<u8>| {
        for (i, slot) in taps.iter_mut().enumerate() {
            if skip == Some(i as u8) {
                continue;
            }
            let Some((filters, tx)) = slot else { continue };
            if !tap_matches(filters, f) {
                continue;
            }
            match tx.try_send(TapEvent::Rx(*f)) {
                Ok(()) => {
                    stats.tap_delivered.fetch_add(1, Ordering::Relaxed);
                }
                Err(TrySendError::Full(_)) => {
                    stats.tap_dropped.fetch_add(1, Ordering::Relaxed);
                }
                Err(TrySendError::Disconnected(_)) => *slot = None,
            }
        }
    };

    while !stop.load(Ordering::Acquire) {
        stats.loop_iterations.fetch_add(1, Ordering::Relaxed);

        // 0. Cold-path control (tap add/remove). Senders were allocated by the requester.
        loop {
            match ctl_rx.try_recv() {
                Ok(Ctl::AddTap { slot, filters, tx }) => taps[usize::from(slot)] = Some((filters, tx)),
                Ok(Ctl::RemoveTap(slot)) => taps[usize::from(slot)] = None,
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
            }
        }

        // 1. TX: authoritative safety gate immediately before the driver call.
        while let Ok(req) = tx_rx.try_recv() {
            let res = gate
                .check()
                .and_then(|()| channel.send_frame(&req.frame).map_err(|e| match e {
                    AdapterError::ListenOnlyMode => GateReject::ListenOnly,
                    _ => GateReject::DriverError,
                }));
            match res {
                Ok(()) => {
                    stats.tx_sent.fetch_add(1, Ordering::Relaxed);
                    let mut echo = req.frame.with_flags(FLAG_TX);
                    echo.bus_id = bus_id;
                    echo.timestamp_us = now_monotonic_us().max(1);
                    if !self_loopback {
                        // Product behaviour: synthesized TX echo for trace/StateTable.
                        if let Err(TrySendError::Full(_)) = telemetry.try_send(echo) {
                            stats.telemetry_dropped.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    let skip = match req.origin {
                        Origin::Tap(s) => {
                            if let Some((_, tx)) = &taps[usize::from(s)] {
                                let _ = tx.try_send(TapEvent::TxConfirmed(echo));
                            }
                            Some(s)
                        }
                        Origin::Other => None,
                    };
                    // Other taps see this frame as ordinary bus traffic (as a second
                    // tester on the wire would).
                    deliver(&mut taps, &echo, skip);
                }
                Err(reason) => {
                    stats.tx_rejected.fetch_add(1, Ordering::Relaxed);
                    if let Origin::Tap(s) = req.origin {
                        if let Some((_, tx)) = &taps[usize::from(s)] {
                            let _ = tx.try_send(TapEvent::TxRejected(req.frame, reason));
                        }
                    }
                }
            }
        }

        // 2. RX burst + fan-out (StateTable queue + matching taps). Zero allocation.
        match channel.recv_batch(&mut rx_batch, 1) {
            Ok(n) => {
                for f in &mut rx_batch[..n] {
                    f.bus_id = bus_id;
                    stats.rx_frames.fetch_add(1, Ordering::Relaxed);
                    if let Err(TrySendError::Full(_)) = telemetry.try_send(*f) {
                        stats.telemetry_dropped.fetch_add(1, Ordering::Relaxed);
                    }
                    if self_loopback && f.is_tx() {
                        continue; // mock0 driver echo of our own TX: already confirmed above
                    }
                    deliver(&mut taps, f, None);
                }
            }
            Err(AdapterError::ChannelClosed) => break,
            Err(_) => {}
        }
    }
    let _ = channel.close();
    // Dropping `taps` disconnects every tap -> adapters return Error::Disconnected.
}
