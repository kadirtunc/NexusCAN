//! `cmd_diag_discover_ecus`: UDS ECU discovery via functional addressing.
//!
//! A regular [`UdsSession`] tap is filtered to ONE response id and its ISO-TP stack expects one
//! rx id, so it cannot collect answers from several ECUs. Discovery therefore opens its OWN
//! short-lived diag tap (response filter with mask + functional id), sends a single-frame
//! functional request, collects every answer for a FIXED window and closes the tap.
//!
//! Safety: the tap is opened through [`PipelineEngine::open_diag_tap`] and the request goes
//! through [`DiagCanPort::send`], i.e. the same Listen-Only / Arm Active Bus / Panic Stop gate
//! (re-checked in the bus-io thread right before the driver write) as every other TX.
//!
//! Control plane (user-triggered, blocking): heap use is fine here; the bus-io thread only
//! copies `RawCanFrame`s into the tap queue. Async callers must use `spawn_blocking`.

use super::diag_session::{check_id, invalid, reject_to_diag_error, tap_filters};
use super::diag_tap::{HalDiagPort, DEFAULT_TAP_DEPTH, MAX_TAP_FILTERS};
use super::*;
use nexus_core::{FLAG_RTR, FLAG_TX};
use nexus_protocols::uds::client::UdsSession;
use nexus_protocols::uds::discovery::{
    build_single_frame_addressed, discovery_spec, validate_request_pdu_addressed,
    DiscoveryCollector, DiscoverySpec, DEFAULT_DISCOVERY_PDU,
};
use nexus_protocols::uds::dto::{
    AddressFormatDto, DiagOrigin, DiagSessionConfigDto, DiscoveredEcuDto, EcuDiscoveryRequestDto,
    EcuDiscoveryResultDto, IdFilterDto,
};
use nexus_protocols::uds::port::DiagCanPort;

/// Default / allowed collection window (ms).
pub const DEFAULT_DISCOVERY_WINDOW_MS: u32 = 300;
pub const MIN_DISCOVERY_WINDOW_MS: u32 = 50;
pub const MAX_DISCOVERY_WINDOW_MS: u32 = 5_000;
/// Upper bound for the TX verdict of the functional request (ISO-TP N_As analogue).
pub(super) const TX_CONFIRM_TIMEOUT: Duration = Duration::from_millis(1_000);
/// Tap depth when the response filters are widened to one covering filter: the tap may then
/// see much more traffic than the responses (the collector applies the exact list).
pub(super) const WIDE_TAP_DEPTH: usize = 16_384;
/// P2 client margin of the temporary identify sessions.
const IDENTIFY_P2_MARGIN_MS: u32 = 100;
/// Identification DIDs: VIN, ECU serial number, spare part number.
const DID_VIN: u16 = 0xF190;
const DID_SERIAL: u16 = 0xF18C;
const DID_PART: u16 = 0xF187;
/// `identifyError` of every ECU found with `addressFormat = extended`.
pub const IDENTIFY_EXTENDED_SKIPPED: &str =
    "identify skipped: target address unknown under extended addressing (the ECU's N_TA cannot be derived from its response; open a physical session with its targetAddress)";

/// Validated request parameters.
struct Plan {
    pdu: Vec<u8>,
    window_ms: u32,
    spec: DiscoverySpec,
}

fn plan(req: &EcuDiscoveryRequestDto) -> Result<Plan, DiagError> {
    let ext = req.is_extended_id;
    check_id("functionalId", req.functional_id, ext)?;
    let window_ms = req.window_ms.unwrap_or(DEFAULT_DISCOVERY_WINDOW_MS);
    if !(MIN_DISCOVERY_WINDOW_MS..=MAX_DISCOVERY_WINDOW_MS).contains(&window_ms) {
        return Err(invalid(format!(
            "windowMs must be within {MIN_DISCOVERY_WINDOW_MS}..={MAX_DISCOVERY_WINDOW_MS}"
        )));
    }
    // Filters (legacy responseId/responseMask or responseIdFilters), request-id rule and
    // address format; legacy requests yield exactly the old single filter.
    let spec = discovery_spec(req).map_err(invalid)?;
    let pdu = req
        .request_pdu
        .clone()
        .unwrap_or_else(|| DEFAULT_DISCOVERY_PDU.to_vec());
    validate_request_pdu_addressed(&pdu, req.use_fd, spec.addr.tx).map_err(invalid)?;
    Ok(Plan {
        pdu,
        window_ms,
        spec,
    })
}

/// Tap acceptance filters for `response_filters` plus the exact `extra` ids (functional /
/// request ids whose traffic must be seen). The exact list is used when it fits into
/// [`MAX_TAP_FILTERS`]; otherwise the responses share ONE covering superset filter and the
/// collector applies the exact list. Returns `(filters, count, widened)`.
pub(super) fn response_tap_filters(
    response_filters: &[IdFilterDto],
    extra: &[u32],
    extended: bool,
) -> ([DiagTapFilter; MAX_TAP_FILTERS], usize, bool) {
    let ext = Some(extended);
    let full = if extended { 0x1FFF_FFFF } else { 0x7FF };
    let mk = |f: IdFilterDto| DiagTapFilter {
        id: f.id,
        mask: f.mask,
        extended: ext,
    };
    let mut out = [mk(IdFilterDto { id: 0, mask: full }); MAX_TAP_FILTERS];
    let room = MAX_TAP_FILTERS - extra.len().min(MAX_TAP_FILTERS - 1);
    let mut n = 0;
    let widened = response_filters.len() > room;
    if widened {
        out[0] = mk(nexus_protocols::uds::discovery::covering_filter(
            response_filters,
        ));
        n = 1;
    } else {
        for f in response_filters {
            out[n] = mk(*f);
            n += 1;
        }
    }
    for id in extra.iter().take(MAX_TAP_FILTERS - n) {
        out[n] = mk(IdFilterDto {
            id: *id,
            mask: full,
        });
        n += 1;
    }
    (out, n, widened)
}

fn request_frame(
    req: &EcuDiscoveryRequestDto,
    pdu: &[u8],
    addr_tx: Option<u8>,
) -> Result<RawCanFrame, DiagError> {
    single_frame(
        req.bus_id,
        req.functional_id,
        req.is_extended_id,
        req.use_fd,
        &build_single_frame_addressed(pdu, req.padding, addr_tx),
    )
    .map_err(|e| invalid(format!("cannot build the functional request frame: {e}")))
}

/// One classic / CAN-FD frame carrying `payload` on `id`.
pub(super) fn single_frame(
    bus_id: u8,
    id: u32,
    extended: bool,
    use_fd: bool,
    payload: &[u8],
) -> Result<RawCanFrame, String> {
    let key = if extended {
        CanIdKey::new_extended(id)
    } else {
        u16::try_from(id).ok().and_then(CanIdKey::new_standard)
    }
    .ok_or_else(|| format!("0x{id:X} is not a valid CAN id"))?;
    let built = if use_fd {
        RawCanFrame::new_fd(bus_id, key, payload, false, 0)
    } else {
        RawCanFrame::new_classical(bus_id, key, payload, 0)
    };
    built.map_err(|e| e.to_string())
}

fn tap_closed_error(bus_id: u8) -> DiagError {
    DiagError::new(
        DiagErrorCode::SessionClosed,
        format!(
            "discovery tap on bus {bus_id} was closed (Panic Stop, disarm, mode change or disconnect)"
        ),
    )
}

impl PipelineEngine {
    /// `cmd_diag_discover_ecus` → functional single-frame request + fixed collection window,
    /// optionally followed by physical DID identification of every responder. BLOCKING
    /// (window + identify round trips).
    pub fn cmd_diag_discover_ecus(
        &self,
        req: EcuDiscoveryRequestDto,
    ) -> Result<EcuDiscoveryResultDto, DiagError> {
        let plan = plan(&req)?;
        if req.use_fd && self.bus_fd_enabled(req.bus_id) == Some(false) {
            return Err(invalid(format!(
                "useFd requires bus {} to be connected with CAN-FD enabled",
                req.bus_id
            )));
        }
        let frame = request_frame(&req, &plan.pdu, plan.spec.addr.tx)?;

        let mut result = {
            let (filters, n, widened) =
                response_tap_filters(&plan.spec.filters, &[req.functional_id], req.is_extended_id);
            let depth = if widened {
                WIDE_TAP_DEPTH
            } else {
                DEFAULT_TAP_DEPTH
            };
            // Gate (not connected / Listen-Only / disarmed / Panic latched) is enforced here.
            let port = self.open_diag_tap(req.bus_id, &filters[..n], depth)?;
            let r = Self::run_discovery_window(&port, &req, &plan, frame);
            // The tap is closed on every path (Drop unregisters it) BEFORE identify opens
            // physical sessions.
            drop(port);
            r?
        };

        if req.identify {
            for ecu in &mut result.ecus {
                self.identify_ecu(&req, ecu);
            }
        }
        Ok(result)
    }

    fn run_discovery_window(
        port: &HalDiagPort,
        req: &EcuDiscoveryRequestDto,
        plan: &Plan,
        frame: RawCanFrame,
    ) -> Result<EcuDiscoveryResultDto, DiagError> {
        port.send(frame)
            .map_err(|r| reject_to_diag_error(req.bus_id, r))?;

        // 1. Wait for the TX verdict of OUR frame (delivered to this port only).
        let mut pre_tx_ignored = 0u32;
        let confirm_deadline = Instant::now() + TX_CONFIRM_TIMEOUT;
        let tx_ts = loop {
            let left = confirm_deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(DiagError::new(
                    DiagErrorCode::TimeoutIsotp,
                    format!(
                        "functional request on bus {} was not confirmed within {} ms",
                        req.bus_id,
                        TX_CONFIRM_TIMEOUT.as_millis()
                    ),
                ));
            }
            match port.recv_timeout(left) {
                Some(DiagPortEvent::TxConfirmed(f)) => break f.timestamp_us,
                Some(DiagPortEvent::TxRejected(_, reason)) => {
                    return Err(reject_to_diag_error(req.bus_id, reason));
                }
                // Traffic that precedes our request cannot be an answer to it.
                Some(DiagPortEvent::Rx(f)) => {
                    if !(f.is_extended() == req.is_extended_id && f.arb_id == req.functional_id) {
                        pre_tx_ignored = pre_tx_ignored.saturating_add(1);
                    }
                }
                None if port.is_closed() => return Err(tap_closed_error(req.bus_id)),
                None => {}
            }
        };

        // 2. Fixed window: never stop at the first answer (all ECUs must be collected).
        let mut collector = DiscoveryCollector::with_spec(
            plan.pdu[0],
            req.functional_id,
            req.is_extended_id,
            tx_ts,
            &plan.spec,
        );
        for _ in 0..pre_tx_ignored {
            collector.note_ignored();
        }
        let window_end = Instant::now() + Duration::from_millis(u64::from(plan.window_ms));
        loop {
            let left = window_end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            match port.recv_timeout(left) {
                Some(DiagPortEvent::Rx(f)) => {
                    if f.flags & (FLAG_RTR | FLAG_TX) != 0 && f.arb_id != req.functional_id {
                        // RTR or a TX echo of another origin on a response id: not an ECU answer.
                        collector.note_ignored();
                        continue;
                    }
                    collector.on_frame(f.arb_id, f.is_extended(), f.timestamp_us, f.payload());
                }
                Some(_) => {}
                None if port.is_closed() => return Err(tap_closed_error(req.bus_id)),
                None => {}
            }
        }
        Ok(collector.finish(plan.pdu.clone(), plan.window_ms))
    }

    /// Reads F190 / F18C / F187 physically. Never fails the discovery: problems go to
    /// `identify_error`. Re-uses an open user session on the same physical addressing
    /// (a second client there would answer with a second Flow Control); otherwise a temporary
    /// session is opened and closed again without being registered in the session map.
    fn identify_ecu(&self, req: &EcuDiscoveryRequestDto, ecu: &mut DiscoveredEcuDto) {
        if req.address_format == AddressFormatDto::Extended {
            // Never guess the ECU's N_TA: the functional target byte is not its physical one.
            ecu.identify_error = Some(IDENTIFY_EXTENDED_SKIPPED.to_string());
            return;
        }
        let Some(request_id) = ecu.request_id else {
            ecu.identify_error = Some(format!(
                "no physical request id can be derived from response id 0x{:X}",
                ecu.response_id
            ));
            return;
        };
        // Mixed: N_AE is the same for every ECU of the network (taken from the request);
        // normal / normalFixed: no address byte.
        let cfg = DiagSessionConfigDto {
            bus_id: req.bus_id,
            request_id,
            response_id: ecu.response_id,
            is_extended_id: req.is_extended_id,
            protocol: Some("uds".into()),
            functional_id: None,
            use_fd: req.use_fd,
            padding: req.padding,
            p2_margin_ms: IDENTIFY_P2_MARGIN_MS,
            address_format: req.address_format,
            target_address: req.target_address,
            response_address: req.response_address,
        };
        let existing = self.diag_sessions.valid_for_addressing(&cfg);
        let (session, temporary) = match existing {
            Some(s) => (s, false),
            None => {
                let opened = (|| {
                    let (filters, n) = tap_filters(&cfg);
                    let port = self.open_diag_tap(cfg.bus_id, &filters[..n], DEFAULT_TAP_DEPTH)?;
                    UdsSession::open(Box::new(port), cfg)
                })();
                match opened {
                    Ok(s) => (Arc::new(s), true),
                    Err(e) => {
                        ecu.identify_error = Some(format!("cannot open a physical session: {e}"));
                        return;
                    }
                }
            }
        };

        let mut errors: Vec<String> = Vec::new();
        for (did, slot) in [
            (DID_VIN, &mut ecu.vin),
            (DID_SERIAL, &mut ecu.serial_number),
            (DID_PART, &mut ecu.part_number),
        ] {
            match session.read_did_with(did, DiagOrigin::Other) {
                Ok(r) => *slot = Some(r.decoded),
                Err(e) => {
                    let fatal = matches!(
                        e.code,
                        DiagErrorCode::ListenOnly
                            | DiagErrorCode::Disarmed
                            | DiagErrorCode::PanicLatched
                            | DiagErrorCode::SessionClosed
                            | DiagErrorCode::BusNotConnected
                    );
                    errors.push(format!("{did:04X}: [{}] {}", e.code.as_str(), e.message));
                    if fatal {
                        break;
                    }
                }
            }
        }
        if temporary {
            session.close();
        }
        if !errors.is_empty() {
            ecu.identify_error = Some(errors.join("; "));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> EcuDiscoveryRequestDto {
        serde_json::from_str(r#"{"busId":0,"isExtendedId":false,"functionalId":2014}"#)
            .expect("req")
    }

    #[test]
    fn plan_defaults() {
        let p = plan(&req()).expect("plan");
        assert_eq!(p.pdu, vec![0x3E, 0x00]);
        assert_eq!(p.window_ms, 300);
        assert_eq!(
            p.spec.filters,
            vec![IdFilterDto {
                id: 0x7E8,
                mask: 0x7F8
            }]
        );
        let mut r = req();
        r.is_extended_id = true;
        r.functional_id = 0x18DB_33F1;
        let p = plan(&r).expect("plan ext");
        assert_eq!(
            p.spec.filters,
            vec![IdFilterDto {
                id: 0x18DA_F100,
                mask: 0x1FFF_FF00
            }]
        );
    }

    #[test]
    fn plan_validation() {
        let bad = |f: &dyn Fn(&mut EcuDiscoveryRequestDto)| {
            let mut r = req();
            f(&mut r);
            plan(&r).err().map(|e| e.code)
        };
        let inv = Some(DiagErrorCode::InvalidInput);
        assert_eq!(bad(&|r| r.functional_id = 0x800), inv);
        assert_eq!(bad(&|r| r.window_ms = Some(49)), inv);
        assert_eq!(bad(&|r| r.window_ms = Some(5_001)), inv);
        assert_eq!(bad(&|r| r.window_ms = Some(50)), None);
        assert_eq!(bad(&|r| r.window_ms = Some(5_000)), None);
        assert_eq!(bad(&|r| r.request_pdu = Some(vec![])), inv);
        assert_eq!(bad(&|r| r.request_pdu = Some(vec![0; 8])), inv);
        assert_eq!(bad(&|r| r.request_pdu = Some(vec![0x3E, 0x80])), inv);
        assert_eq!(bad(&|r| r.request_pdu = Some(vec![0x10, 0x81])), inv);
        assert_eq!(bad(&|r| r.request_pdu = Some(vec![0x22, 0xF1, 0x90])), None);
        assert_eq!(
            bad(&|r| {
                r.use_fd = true;
                r.request_pdu = Some(vec![0x22; 62]);
            }),
            None
        );
        assert_eq!(bad(&|r| r.response_mask = Some(0)), inv);
        assert_eq!(bad(&|r| r.response_mask = Some(0x800)), inv);
        assert_eq!(bad(&|r| r.response_id = Some(0x800)), inv);
        // functional id inside the response filter
        assert_eq!(
            bad(&|r| {
                r.response_id = Some(0x7D8);
                r.response_mask = Some(0x7F8);
            }),
            inv
        );
        let mut r = req();
        r.response_id = Some(0x7EA);
        assert_eq!(plan(&r).map(|p| p.spec.filters[0].mask).ok(), Some(0x7FF));
    }

    #[test]
    fn request_frame_padding_and_fd() {
        let mut r = req();
        let f = request_frame(&r, &[0x3E, 0x00], None).expect("frame");
        assert_eq!(
            f.payload(),
            &[0x02, 0x3E, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA]
        );
        assert_eq!(f.arb_id, 0x7DE);
        assert!(!f.is_extended() && f.flags & nexus_core::FLAG_FD == 0);
        r.padding = None;
        let f = request_frame(&r, &[0x3E, 0x00], None).expect("frame");
        assert_eq!(f.payload(), &[0x02, 0x3E, 0x00]);
        r.use_fd = true;
        r.is_extended_id = true;
        r.functional_id = 0x18DB_33F1;
        r.padding = Some(0xCC);
        let f = request_frame(&r, &[0x22; 10], None).expect("fd frame");
        assert!(f.is_extended() && f.flags & nexus_core::FLAG_FD != 0);
        assert_eq!(&f.payload()[..2], &[0x00, 0x0A]);
        assert_eq!(f.payload().len(), 12);
    }

    #[test]
    fn legacy_request_keeps_old_tap_filters_and_frame() {
        // Old construction: [response id/mask, exact functional id], DEFAULT_TAP_DEPTH.
        let p = plan(&req()).expect("plan");
        let (f, n, widened) = response_tap_filters(&p.spec.filters, &[0x7DE], false);
        assert_eq!((n, widened), (2, false));
        assert_eq!(
            f[0],
            DiagTapFilter {
                id: 0x7E8,
                mask: 0x7F8,
                extended: Some(false)
            }
        );
        assert_eq!(
            f[1],
            DiagTapFilter {
                id: 0x7DE,
                mask: 0x7FF,
                extended: Some(false)
            }
        );
        let mut r = req();
        r.response_id = Some(0x7EA);
        r.response_mask = Some(0x7FB);
        let p = plan(&r).expect("plan");
        let (f, n, _) = response_tap_filters(&p.spec.filters, &[0x7DE], false);
        assert_eq!(n, 2);
        // (arb & mask) == (id & mask): same acceptance as the old unmasked id.
        assert_eq!((f[0].id & f[0].mask, f[0].mask), (0x7EA & 0x7FB, 0x7FB));
        assert_eq!(
            request_frame(&req(), &p.pdu, p.spec.addr.tx)
                .expect("frame")
                .payload(),
            &[0x02, 0x3E, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA]
        );
    }

    #[test]
    fn many_filters_are_widened_to_one_covering_filter() {
        let mut r = req();
        r.functional_id = 0x5DF;
        r.response_id_filters = Some(
            [0x5A8, 0x5B8, 0x648, 0x658]
                .into_iter()
                .map(|id| IdFilterDto { id, mask: 0x7FF })
                .collect(),
        );
        r.request_id_rule = Some(nexus_protocols::uds::dto::RequestIdRuleDto::Offset { delta: -8 });
        let p = plan(&r).expect("plan");
        let (f, n, widened) = response_tap_filters(&p.spec.filters, &[0x5DF], false);
        assert!(widened);
        assert_eq!(n, 2, "covering filter + functional id");
        for id in [0x5A8u32, 0x5B8, 0x648, 0x658] {
            assert_eq!(id & f[0].mask, f[0].id & f[0].mask, "{id:#X} covered");
        }
        assert_eq!(f[1].id, 0x5DF);
        // Three filters still fit next to the functional id: exact list, no widening.
        let (f, n, widened) = response_tap_filters(&p.spec.filters[..3], &[0x5DF], false);
        assert_eq!((n, widened), (4, false));
        assert_eq!(f[2].id, 0x648);
    }

    #[test]
    fn addressed_request_frame_and_pdu_room() {
        let mut r = req();
        r.address_format = AddressFormatDto::Extended;
        r.target_address = Some(0x33);
        r.response_address = Some(0xF1);
        let p = plan(&r).expect("plan");
        assert_eq!(p.spec.addr.tx, Some(0x33));
        let f = request_frame(&r, &p.pdu, p.spec.addr.tx).expect("frame");
        assert_eq!(
            f.payload(),
            &[0x33, 0x02, 0x3E, 0x00, 0xAA, 0xAA, 0xAA, 0xAA]
        );
        // One byte less single-frame room with an address byte.
        r.request_pdu = Some(vec![0x22; 7]);
        assert_eq!(
            plan(&r).err().map(|e| e.code),
            Some(DiagErrorCode::InvalidInput)
        );
        r.request_pdu = Some(vec![0x22; 6]);
        assert!(plan(&r).is_ok());
        // Extended addressing needs both bytes.
        r.response_address = None;
        assert_eq!(
            plan(&r).err().map(|e| e.code),
            Some(DiagErrorCode::InvalidInput)
        );
    }

    #[test]
    fn discovery_respects_gate_on_mock0() {
        use crate::{ChannelConfigDto, MOCK0_DEVICE_ID};
        let engine = PipelineEngine::new();
        // Not connected.
        assert_eq!(
            engine.cmd_diag_discover_ecus(req()).unwrap_err().code,
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
            .expect("connect mock0");
        assert_eq!(
            engine.cmd_diag_discover_ecus(req()).unwrap_err().code,
            DiagErrorCode::ListenOnly
        );
        assert_eq!(
            engine.diag_tap_count(0),
            0,
            "no tap leaked by a refused discovery"
        );

        // Active but disarmed.
        let cfg = ChannelConfigDto {
            bus_id: 0,
            listen_only: false,
            mock_fps_preset: Some(1_000),
            ..ChannelConfigDto::default()
        };
        engine.cmd_disconnect_bus(0).ok();
        engine
            .cmd_connect_bus(MOCK0_DEVICE_ID.to_string(), cfg)
            .expect("connect mock0 active");
        assert_eq!(
            engine.cmd_diag_discover_ecus(req()).unwrap_err().code,
            DiagErrorCode::Disarmed
        );

        // Armed: the request is confirmed, the fixed window elapses, the tap is released.
        engine.cmd_arm_active_bus(0, true).expect("arm");
        let mut r = req();
        r.window_ms = Some(60);
        let t0 = Instant::now();
        let res = engine
            .cmd_diag_discover_ecus(r)
            .expect("discovery on mock0");
        assert!(t0.elapsed() >= Duration::from_millis(60), "window is fixed");
        assert_eq!(res.request_bytes, vec![0x3E, 0x00]);
        assert_eq!(res.window_ms, 60);
        assert!(res.tx_timestamp_us > 0);
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(
            engine.diag_tap_count(0),
            0,
            "discovery tap closed after the window"
        );

        // Panic Stop latches → refused.
        let _ = engine.cmd_panic_stop_tx();
        let code = engine.cmd_diag_discover_ecus(req()).unwrap_err().code;
        assert!(
            matches!(code, DiagErrorCode::PanicLatched | DiagErrorCode::Disarmed),
            "{code:?}"
        );
    }
}
