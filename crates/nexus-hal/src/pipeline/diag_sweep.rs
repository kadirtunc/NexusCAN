//! `cmd_diag_physical_sweep`: active per-id scan for ECUs that ignore functional requests.
//!
//! One single-frame request per physical id, STRICTLY sequential: send → wait for the TX
//! verdict of that frame → wait `gapMs` (collecting answers) → next id. There is never more
//! than one request in flight and never a burst. Every frame goes through the regular diag tap
//! TX path ([`HalDiagPort::send`] + the authoritative bus-io gate), so Listen-Only / Arm Active
//! Bus / Panic Stop / TX epoch apply per frame.
//!
//! Abort (partial result + `abortCode` / `abortReason`, never an error once the first frame
//! was attempted): Panic Stop (tap closed, epoch bumped), TX epoch change, disarm, mode change,
//! disconnect, or a rejected frame. Listen-Only / disarmed / Panic latched / not connected are
//! refused UP FRONT (error, nothing sent).
//!
//! Answers are collected with [`DiscoveryCollector::with_spec`] (same filters / request-id rule
//! as discovery); `responders` additionally records which swept id was in flight when each
//! responder answered first. There is no progress stream for long diag operations in the HAL
//! today, so the command blocks until the result (256 ids × 20 ms ≈ 5 s).

use super::diag_discovery::{
    response_tap_filters, single_frame, TX_CONFIRM_TIMEOUT, WIDE_TAP_DEPTH,
};
use super::diag_session::{check_id, invalid, reject_to_diag_error};
use super::diag_tap::{HalDiagPort, DEFAULT_TAP_DEPTH};
use super::*;
use crate::dto::{PhysicalSweepRequestDto, PhysicalSweepResultDto, SweepResponderDto};
use nexus_core::{FLAG_RTR, FLAG_TX};
use nexus_protocols::uds::addressing::{check_id_forms, resolve_address_bytes};
use nexus_protocols::uds::discovery::{
    build_single_frame_addressed, discovery_spec, validate_request_pdu_addressed,
    DiscoveryCollector, DiscoverySpec, DEFAULT_DISCOVERY_PDU,
};
use nexus_protocols::uds::dto::{AddressFormatDto, EcuDiscoveryRequestDto, IdFilterDto};
use nexus_protocols::uds::port::DiagCanPort;
use std::collections::{BTreeMap, BTreeSet};

/// Max ids per sweep.
pub const MAX_SWEEP_IDS: usize = 256;
/// Default / clamp range of the inter-request gap (ms).
pub const DEFAULT_SWEEP_GAP_MS: u32 = 20;
pub const MIN_SWEEP_GAP_MS: u32 = 5;
pub const MAX_SWEEP_GAP_MS: u32 = 1_000;
/// Default / max collection time after the last request (ms).
pub const DEFAULT_SWEEP_TAIL_MS: u32 = 200;
pub const MAX_SWEEP_TAIL_MS: u32 = 5_000;

/// Buses with a sweep in progress (one sweep per bus).
#[derive(Default)]
pub(crate) struct SweepGuardSet(Mutex<BTreeSet<u8>>);

struct SweepGuard<'a>(&'a SweepGuardSet, u8);

impl Drop for SweepGuard<'_> {
    fn drop(&mut self) {
        self.0 .0.lock().remove(&self.1);
    }
}

/// Validated sweep.
struct SweepPlan {
    ids: Vec<u32>,
    pdu: Vec<u8>,
    gap_ms: u32,
    tail_ms: u32,
    spec: DiscoverySpec,
}

fn sweep_ids(req: &PhysicalSweepRequestDto) -> Result<Vec<u32>, DiagError> {
    let ids: Vec<u32> = match (&req.request_ids, req.request_id_range) {
        (Some(list), None) => list.clone(),
        (None, Some(r)) => {
            if r.end < r.start {
                return Err(invalid(format!(
                    "requestIdRange end 0x{:X} is below start 0x{:X}",
                    r.end, r.start
                )));
            }
            let n = u64::from(r.end - r.start) + 1;
            if n > MAX_SWEEP_IDS as u64 {
                return Err(invalid(format!(
                    "requestIdRange covers {n} ids; at most {MAX_SWEEP_IDS} per sweep"
                )));
            }
            (r.start..=r.end).collect()
        }
        _ => return Err(invalid("set exactly one of requestIds / requestIdRange")),
    };
    if ids.is_empty() || ids.len() > MAX_SWEEP_IDS {
        return Err(invalid(format!(
            "a sweep needs 1..={MAX_SWEEP_IDS} request ids (got {})",
            ids.len()
        )));
    }
    let mut seen = BTreeSet::new();
    for id in &ids {
        check_id("requestIds", *id, req.is_extended_id)?;
        if !seen.insert(*id) {
            return Err(invalid(format!("request id 0x{id:X} is listed twice")));
        }
    }
    Ok(ids)
}

fn plan(req: &PhysicalSweepRequestDto) -> Result<SweepPlan, DiagError> {
    let ext = req.is_extended_id;
    let ids = sweep_ids(req)?;
    if req.address_format == AddressFormatDto::Extended {
        return Err(invalid(
            "addressFormat extended is not supported by the physical sweep (the N_TA would vary per ECU); use normal, normalFixed or mixed",
        ));
    }
    let addr = resolve_address_bytes(req.address_format, req.target_address, req.response_address)
        .map_err(invalid)?;
    let named: Vec<(&str, u32)> = ids.iter().map(|id| ("requestIds[]", *id)).collect();
    check_id_forms(req.address_format, ext, &named, None).map_err(invalid)?;

    // Filters + request-id rule exactly as for discovery (validated by `discovery_spec` with
    // plain normal addressing and the first swept id in the functional slot).
    let mut spec = discovery_spec(&EcuDiscoveryRequestDto {
        bus_id: req.bus_id,
        is_extended_id: ext,
        functional_id: ids[0],
        request_pdu: None,
        window_ms: None,
        response_id: req.response_id,
        response_mask: req.response_mask,
        padding: req.padding,
        use_fd: req.use_fd,
        identify: false,
        response_id_filters: req.response_id_filters.clone(),
        request_id_rule: req.request_id_rule,
        address_format: AddressFormatDto::Normal,
        target_address: None,
        response_address: None,
    })
    .map_err(invalid)?;
    if ext
        && req.address_format == AddressFormatDto::Mixed
        && req.response_id_filters.is_none()
        && req.response_id.is_none()
        && req.response_mask.is_none()
    {
        // 29-bit mixed addressing answers on 0x18CE_TA_SA (discovery's default for mixed).
        spec.filters = vec![IdFilterDto {
            id: 0x18CE_F100,
            mask: 0x1FFF_FF00,
        }];
    }
    spec.addr = addr;
    if let Some(id) = ids
        .iter()
        .find(|id| spec.filters.iter().any(|f| (**id & f.mask) == f.id))
    {
        return Err(invalid(format!(
            "request id 0x{id:X} matches a response filter; requests and responses must use distinct ids"
        )));
    }

    let pdu = req
        .request_pdu
        .clone()
        .unwrap_or_else(|| DEFAULT_DISCOVERY_PDU.to_vec());
    validate_request_pdu_addressed(&pdu, req.use_fd, addr.tx).map_err(invalid)?;
    Ok(SweepPlan {
        ids,
        pdu,
        gap_ms: req
            .gap_ms
            .unwrap_or(DEFAULT_SWEEP_GAP_MS)
            .clamp(MIN_SWEEP_GAP_MS, MAX_SWEEP_GAP_MS),
        tail_ms: req
            .tail_ms
            .unwrap_or(DEFAULT_SWEEP_TAIL_MS)
            .min(MAX_SWEEP_TAIL_MS),
        spec,
    })
}

/// Collection state of a running sweep.
struct Sweep {
    collector: Option<DiscoveryCollector>,
    pre_tx_ignored: u32,
    /// (request id, TX confirmation timestamp) of every request sent so far, in order.
    sent_log: Vec<(u32, u64)>,
    responders: BTreeMap<u32, SweepResponderDto>,
}

impl Sweep {
    fn on_rx(&mut self, f: RawCanFrame) {
        let Some(c) = self.collector.as_mut() else {
            self.pre_tx_ignored = self.pre_tx_ignored.saturating_add(1);
            return;
        };
        if f.flags & (FLAG_RTR | FLAG_TX) != 0 {
            c.note_ignored();
            return;
        }
        let verdict = c.on_frame(f.arb_id, f.is_extended(), f.timestamp_us, f.payload());
        use nexus_protocols::uds::discovery::FrameVerdict;
        if matches!(verdict, FrameVerdict::Response | FrameVerdict::Pending) {
            // Attribute by HAL timestamps (last request confirmed at or before the answer),
            // so processing delays on our side never shift the attribution.
            let n = self
                .sent_log
                .partition_point(|(_, ts)| *ts <= f.timestamp_us);
            if let Some(&(req_id, tx_ts)) = self.sent_log.get(n.saturating_sub(1)) {
                self.responders
                    .entry(f.arb_id)
                    .or_insert(SweepResponderDto {
                        response_id: f.arb_id,
                        in_flight_request_id: req_id,
                        latency_us: f.timestamp_us.saturating_sub(tx_ts),
                    });
            }
        }
    }
}

impl PipelineEngine {
    /// Why a sweep tap stopped: the most specific gate state, else `session_closed`.
    fn sweep_abort_cause(&self, bus_id: u8, start_epoch: u64) -> DiagError {
        if self.tx_panic_latched.load(Ordering::SeqCst) {
            return reject_to_diag_error(bus_id, DiagTxReject::PanicLatched);
        }
        if self.tx_epoch.load(Ordering::SeqCst) != start_epoch {
            return DiagError::new(
                DiagErrorCode::PanicLatched,
                "TX epoch changed (Panic Stop or session reset) during the sweep",
            );
        }
        let guard = self.buses.lock();
        match guard.get(&bus_id).filter(|b| b.is_connected()) {
            None => DiagError::new(
                DiagErrorCode::BusNotConnected,
                format!("bus {bus_id} was disconnected during the sweep"),
            ),
            Some(b) if b.listen_only => reject_to_diag_error(bus_id, DiagTxReject::ListenOnly),
            Some(b) if !b.tx_armed.load(Ordering::SeqCst) => {
                reject_to_diag_error(bus_id, DiagTxReject::Disarmed)
            }
            Some(_) => DiagError::new(
                DiagErrorCode::SessionClosed,
                format!("sweep tap on bus {bus_id} was closed (mode change or reconnect)"),
            ),
        }
    }

    /// `cmd_diag_physical_sweep` → sequential physical single-frame requests. BLOCKING
    /// (`ids × gapMs + tailMs`). Gate failures before the first frame are errors; anything
    /// after that ends the sweep with a partial result (`completed = false`, `abortCode`).
    pub fn cmd_diag_physical_sweep(
        &self,
        req: PhysicalSweepRequestDto,
    ) -> Result<PhysicalSweepResultDto, DiagError> {
        let plan = plan(&req)?;
        if req.use_fd && self.bus_fd_enabled(req.bus_id) == Some(false) {
            return Err(invalid(format!(
                "useFd requires bus {} to be connected with CAN-FD enabled",
                req.bus_id
            )));
        }
        let frames: Vec<RawCanFrame> = {
            let payload = build_single_frame_addressed(&plan.pdu, req.padding, plan.spec.addr.tx);
            plan.ids
                .iter()
                .map(|id| {
                    single_frame(req.bus_id, *id, req.is_extended_id, req.use_fd, &payload)
                        .map_err(|e| invalid(format!("cannot build the request frame: {e}")))
                })
                .collect::<Result<_, _>>()?
        };

        {
            let mut busy = self.diag_sweeps.0.lock();
            if !busy.insert(req.bus_id) {
                return Err(DiagError::new(
                    DiagErrorCode::Busy,
                    format!("a physical sweep is already running on bus {}", req.bus_id),
                ));
            }
        }
        let _guard = SweepGuard(&self.diag_sweeps, req.bus_id);

        let (filters, n, widened) =
            response_tap_filters(&plan.spec.filters, &[], req.is_extended_id);
        let depth = if widened {
            WIDE_TAP_DEPTH
        } else {
            DEFAULT_TAP_DEPTH
        };
        // Up-front gate: not connected / Listen-Only / disarmed / Panic latched → error.
        let start_epoch = self.tx_epoch.load(Ordering::SeqCst);
        let port = self.open_diag_tap(req.bus_id, &filters[..n], depth)?;
        let mut sweep = Sweep {
            collector: None,
            pre_tx_ignored: 0,
            sent_log: Vec::with_capacity(plan.ids.len()),
            responders: BTreeMap::new(),
        };
        let mut sent = 0u32;
        let mut tx_ts0 = 0u64;
        let mut abort: Option<DiagError> = None;

        'ids: for (id, frame) in plan.ids.iter().zip(frames) {
            if port.is_closed() || self.tx_epoch.load(Ordering::SeqCst) != start_epoch {
                abort = Some(self.sweep_abort_cause(req.bus_id, start_epoch));
                break;
            }
            if let Err(r) = port.send(frame) {
                abort = Some(match r {
                    DiagTxReject::Closed => self.sweep_abort_cause(req.bus_id, start_epoch),
                    r => reject_to_diag_error(req.bus_id, r),
                });
                break;
            }
            // 1. TX verdict of THIS frame (one request in flight).
            let deadline = Instant::now() + TX_CONFIRM_TIMEOUT;
            let confirm_ts = loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    abort = Some(DiagError::new(
                        DiagErrorCode::TimeoutIsotp,
                        format!(
                            "request on 0x{id:X} was not confirmed within {} ms",
                            TX_CONFIRM_TIMEOUT.as_millis()
                        ),
                    ));
                    break 'ids;
                }
                match port.recv_timeout(left) {
                    Some(DiagPortEvent::TxConfirmed(f)) => break f.timestamp_us,
                    Some(DiagPortEvent::TxRejected(_, r)) => {
                        abort = Some(match r {
                            DiagTxReject::Closed => self.sweep_abort_cause(req.bus_id, start_epoch),
                            r => reject_to_diag_error(req.bus_id, r),
                        });
                        break 'ids;
                    }
                    Some(DiagPortEvent::Rx(f)) => sweep.on_rx(f),
                    None if port.is_closed() => {
                        abort = Some(self.sweep_abort_cause(req.bus_id, start_epoch));
                        break 'ids;
                    }
                    None => {}
                }
            };
            sent += 1;
            if sweep.collector.is_none() {
                tx_ts0 = confirm_ts;
                let mut c = DiscoveryCollector::with_spec(
                    plan.pdu[0],
                    u32::MAX, // no functional id: never an echo
                    req.is_extended_id,
                    confirm_ts,
                    &plan.spec,
                );
                for _ in 0..sweep.pre_tx_ignored {
                    c.note_ignored();
                }
                sweep.collector = Some(c);
            }
            sweep.sent_log.push((*id, confirm_ts));
            // 2. Gap (from the confirmation) while collecting answers.
            let gap_end = Instant::now() + Duration::from_millis(u64::from(plan.gap_ms));
            if !Self::collect_until(&port, &mut sweep, gap_end) {
                abort = Some(self.sweep_abort_cause(req.bus_id, start_epoch));
                break;
            }
        }
        // 3. Tail: late answers to the last request (also after an abort nothing is SENT).
        if abort.is_none() && sent > 0 {
            let tail_end = Instant::now() + Duration::from_millis(u64::from(plan.tail_ms));
            if !Self::collect_until(&port, &mut sweep, tail_end) {
                abort = Some(self.sweep_abort_cause(req.bus_id, start_epoch));
            }
        }
        drop(port);
        if sent == 0 {
            if let Some(e) = abort {
                // Nothing reached the bus: report like any refused diag command.
                return Err(e);
            }
        }

        let completed = abort.is_none() && sent as usize == plan.ids.len();
        let collector = sweep.collector.take().unwrap_or_else(|| {
            DiscoveryCollector::with_spec(plan.pdu[0], u32::MAX, req.is_extended_id, 0, &plan.spec)
        });
        let disc = collector.finish(plan.pdu.clone(), plan.tail_ms);
        Ok(PhysicalSweepResultDto {
            bus_id: req.bus_id,
            is_extended_id: req.is_extended_id,
            request_bytes: plan.pdu.clone(),
            gap_ms: plan.gap_ms,
            tail_ms: plan.tail_ms,
            total: plan.ids.len() as u32,
            sent,
            last_request_id: sweep.sent_log.last().map(|(id, _)| *id),
            completed,
            abort_code: abort.as_ref().map(|e| e.code),
            abort_reason: abort.map(|e| e.message),
            tx_timestamp_us: tx_ts0,
            ecus: disc.ecus,
            responders: sweep.responders.into_values().collect(),
            ignored_frames: disc.ignored_frames,
            truncated: disc.truncated,
            dropped_ecus: disc.dropped_ecus,
        })
    }

    /// Feeds RX until `until`; `false` when the tap closed first.
    fn collect_until(port: &HalDiagPort, sweep: &mut Sweep, until: Instant) -> bool {
        loop {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return true;
            }
            match port.recv_timeout(left) {
                Some(DiagPortEvent::Rx(f)) => sweep.on_rx(f),
                Some(_) => {}
                None if port.is_closed() => return false,
                None => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::IdRangeDto;
    use crate::traits::{AdapterCapabilities, BusHealthSnapshot, CanFilter};
    use crate::{ChannelConfigDto, MOCK0_DEVICE_ID};

    fn req() -> PhysicalSweepRequestDto {
        serde_json::from_str(
            r#"{"busId":0,"isExtendedId":false,"requestIdRange":{"start":1536,"end":1551},
                "responseIdFilters":[{"id":1600,"mask":1984}]}"#,
        )
        .expect("req")
    }

    #[test]
    fn plan_validation_and_defaults() {
        let p = plan(&req()).expect("plan");
        assert_eq!(p.ids.len(), 16);
        assert_eq!((p.gap_ms, p.tail_ms), (20, 200));
        assert_eq!(p.pdu, vec![0x3E, 0x00]);
        let bad = |f: &dyn Fn(&mut PhysicalSweepRequestDto)| {
            let mut r = req();
            f(&mut r);
            plan(&r).err().map(|e| e.code)
        };
        let inv = Some(DiagErrorCode::InvalidInput);
        assert_eq!(bad(&|r| r.request_ids = Some(vec![0x600])), inv, "both set");
        assert_eq!(
            bad(&|r| r.request_id_range = Some(IdRangeDto {
                start: 0x500,
                end: 0x600
            })),
            inv,
            "257 ids"
        );
        assert_eq!(
            bad(&|r| r.request_id_range = Some(IdRangeDto {
                start: 0x500,
                end: 0x5FF
            })),
            None,
            "256 ids"
        );
        assert_eq!(
            bad(&|r| {
                r.request_id_range = None;
                r.request_ids = Some(vec![0x600, 0x601, 0x600]);
            }),
            inv,
            "duplicates"
        );
        assert_eq!(
            bad(&|r| {
                r.request_id_range = None;
                r.request_ids = Some(vec![0x800]);
            }),
            inv
        );
        assert_eq!(bad(&|r| r.request_id_range = None), inv, "none set");
        assert_eq!(
            bad(&|r| r.response_id_filters = Some(vec![IdFilterDto {
                id: 0x600,
                mask: 0x7F0
            }])),
            inv,
            "request ids inside the response filter"
        );
        assert_eq!(bad(&|r| r.request_pdu = Some(vec![0x3E, 0x80])), inv);
        assert_eq!(
            bad(&|r| {
                r.address_format = AddressFormatDto::Extended;
                r.target_address = Some(0x10);
                r.response_address = Some(0xF1);
            }),
            inv
        );
        // Gap / tail are clamped, not rejected.
        let mut r = req();
        r.gap_ms = Some(1);
        r.tail_ms = Some(60_000);
        let p = plan(&r).expect("clamped");
        assert_eq!((p.gap_ms, p.tail_ms), (5, 5_000));
        r.gap_ms = Some(5_000);
        assert_eq!(plan(&r).expect("clamped").gap_ms, 1_000);
    }

    /// Driver writes: (instant, CAN id).
    type Writes = Arc<Mutex<Vec<(Instant, u32)>>>;

    /// mock0 wrapper recording the instant + CAN id of every driver write.
    struct RecordingChannel {
        inner: Box<dyn CanChannel>,
        writes: Writes,
    }

    impl CanChannel for RecordingChannel {
        fn descriptor(&self) -> &DeviceDescriptor {
            self.inner.descriptor()
        }
        fn capabilities(&self) -> &AdapterCapabilities {
            self.inner.capabilities()
        }
        fn close(&mut self) -> Result<(), AdapterError> {
            self.inner.close()
        }
        fn recv_batch(&mut self, out: &mut [RawCanFrame], t: u32) -> Result<usize, AdapterError> {
            self.inner.recv_batch(out, t)
        }
        fn send_frame(&mut self, frame: &RawCanFrame) -> Result<(), AdapterError> {
            self.writes.lock().push((Instant::now(), frame.arb_id));
            self.inner.send_frame(frame)
        }
        fn set_filters(&mut self, filters: &[CanFilter]) -> Result<(), AdapterError> {
            self.inner.set_filters(filters)
        }
        fn health(&self) -> BusHealthSnapshot {
            self.inner.health()
        }
    }

    fn rig() -> (PipelineEngine, Writes) {
        let engine = PipelineEngine::new();
        let cfg = ChannelConfigDto {
            bus_id: 0,
            listen_only: false,
            mock_fps_preset: Some(1_000),
            ..ChannelConfigDto::default()
        };
        let (descriptor, inner) = engine
            .registry
            .open_by_device_id(MOCK0_DEVICE_ID, &cfg)
            .expect("open mock0");
        let writes = Arc::new(Mutex::new(Vec::new()));
        let chan = RecordingChannel {
            inner,
            writes: Arc::clone(&writes),
        };
        let handle = engine
            .spawn_connected_bus_handle(0, descriptor, cfg, Box::new(chan), true)
            .expect("spawn bus");
        engine.buses.lock().insert(0, handle);
        (engine, writes)
    }

    #[test]
    fn gap_is_respected_one_request_at_a_time() {
        let (engine, writes) = rig();
        let mut r = req();
        r.gap_ms = Some(15);
        r.tail_ms = Some(0);
        let t0 = Instant::now();
        let res = engine.cmd_diag_physical_sweep(r).expect("sweep");
        assert!(res.completed, "{res:?}");
        assert_eq!((res.total, res.sent), (16, 16));
        assert_eq!(res.last_request_id, Some(0x60F));
        assert!(res.abort_code.is_none());
        assert!(t0.elapsed() >= Duration::from_millis(15 * 16));
        let w = writes.lock().clone();
        let ids: Vec<u32> = w.iter().map(|(_, id)| *id).collect();
        assert_eq!(
            ids,
            (0x600..=0x60F).collect::<Vec<u32>>(),
            "sequential, in order"
        );
        for pair in w.windows(2) {
            let d = pair[1].0.duration_since(pair[0].0);
            assert!(
                d >= Duration::from_millis(15),
                "driver writes {d:?} apart (< gap)"
            );
        }
        assert_eq!(engine.diag_tap_count(0), 0, "tap released");
    }

    #[test]
    fn panic_mid_sweep_stops_tx_and_returns_partial_result() {
        let (engine, writes) = rig();
        let engine = Arc::new(engine);
        let mut r = req();
        r.gap_ms = Some(20);
        let e2 = Arc::clone(&engine);
        let sweeper = thread::spawn(move || e2.cmd_diag_physical_sweep(r));
        // Let a few requests out, then Panic.
        let deadline = Instant::now() + Duration::from_secs(3);
        while writes.lock().len() < 4 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        let _ = engine.cmd_panic_stop_tx();
        let panic_done = Instant::now();
        let n_at_panic = writes.lock().len();
        let res = sweeper.join().expect("join").expect("partial result");
        thread::sleep(Duration::from_millis(60));
        let w = writes.lock().clone();
        assert_eq!(
            w.len(),
            n_at_panic,
            "no driver write after Panic Stop returned"
        );
        assert!(w.iter().all(|(t, _)| *t <= panic_done));
        assert!(!res.completed);
        assert_eq!(res.abort_code, Some(DiagErrorCode::PanicLatched), "{res:?}");
        assert!(res.sent >= 4 && (res.sent as usize) < 16, "{res:?}");
        assert_eq!(res.sent as usize, n_at_panic);
        assert_eq!(engine.diag_tap_count(0), 0);
    }

    #[test]
    fn listen_only_disarmed_and_busy_are_refused_up_front() {
        let engine = PipelineEngine::new();
        assert_eq!(
            engine.cmd_diag_physical_sweep(req()).unwrap_err().code,
            DiagErrorCode::BusNotConnected
        );
        let cfg = ChannelConfigDto {
            bus_id: 0,
            listen_only: true,
            mock_fps_preset: Some(1_000),
            ..ChannelConfigDto::default()
        };
        engine
            .cmd_connect_bus(MOCK0_DEVICE_ID.to_string(), cfg)
            .expect("connect");
        assert_eq!(
            engine.cmd_diag_physical_sweep(req()).unwrap_err().code,
            DiagErrorCode::ListenOnly
        );
        assert_eq!(engine.diag_tap_count(0), 0);
        engine.cmd_disconnect_bus(0).expect("disc");
        let cfg = ChannelConfigDto {
            bus_id: 0,
            listen_only: false,
            mock_fps_preset: Some(1_000),
            ..ChannelConfigDto::default()
        };
        engine
            .cmd_connect_bus(MOCK0_DEVICE_ID.to_string(), cfg)
            .expect("connect active");
        assert_eq!(
            engine.cmd_diag_physical_sweep(req()).unwrap_err().code,
            DiagErrorCode::Disarmed
        );
        // Busy: a second sweep on the same bus while one runs.
        engine.cmd_arm_active_bus(0, true).expect("arm");
        let engine = Arc::new(engine);
        let e2 = Arc::clone(&engine);
        let mut slow = req();
        slow.gap_ms = Some(50);
        let h = thread::spawn(move || e2.cmd_diag_physical_sweep(slow));
        thread::sleep(Duration::from_millis(100));
        assert_eq!(
            engine.cmd_diag_physical_sweep(req()).unwrap_err().code,
            DiagErrorCode::Busy
        );
        // Disarm mid-sweep: partial result with the reason.
        engine.cmd_arm_active_bus(0, false).expect("disarm");
        let res = h.join().expect("join").expect("partial");
        assert!(!res.completed);
        assert_eq!(res.abort_code, Some(DiagErrorCode::Disarmed), "{res:?}");
    }
}
