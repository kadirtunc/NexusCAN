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
use super::diag_tap::{HalDiagPort, DEFAULT_TAP_DEPTH};
use super::*;
use nexus_core::{FLAG_RTR, FLAG_TX};
use nexus_protocols::uds::client::UdsSession;
use nexus_protocols::uds::discovery::{
    build_single_frame, default_response_filter, validate_request_pdu, DiscoveryCollector,
    DEFAULT_DISCOVERY_PDU,
};
use nexus_protocols::uds::dto::{
    DiagOrigin, DiagSessionConfigDto, DiscoveredEcuDto, EcuDiscoveryRequestDto, EcuDiscoveryResultDto,
};
use nexus_protocols::uds::port::DiagCanPort;

/// Default / allowed collection window (ms).
pub const DEFAULT_DISCOVERY_WINDOW_MS: u32 = 300;
pub const MIN_DISCOVERY_WINDOW_MS: u32 = 50;
pub const MAX_DISCOVERY_WINDOW_MS: u32 = 5_000;
/// Upper bound for the TX verdict of the functional request (ISO-TP N_As analogue).
const TX_CONFIRM_TIMEOUT: Duration = Duration::from_millis(1_000);
/// P2 client margin of the temporary identify sessions.
const IDENTIFY_P2_MARGIN_MS: u32 = 100;
/// Identification DIDs: VIN, ECU serial number, spare part number.
const DID_VIN: u16 = 0xF190;
const DID_SERIAL: u16 = 0xF18C;
const DID_PART: u16 = 0xF187;

/// Validated request parameters.
struct Plan {
    pdu: Vec<u8>,
    window_ms: u32,
    resp_id: u32,
    resp_mask: u32,
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
    let pdu = req
        .request_pdu
        .clone()
        .unwrap_or_else(|| DEFAULT_DISCOVERY_PDU.to_vec());
    validate_request_pdu(&pdu, req.use_fd).map_err(invalid)?;

    let full = if ext { 0x1FFF_FFFF } else { 0x7FF };
    let (def_id, def_mask) = default_response_filter(ext);
    let (resp_id, resp_mask) = match (req.response_id, req.response_mask) {
        (None, None) => (def_id, def_mask),
        // An explicit id alone means exactly that id.
        (Some(id), None) => (id, full),
        (None, Some(m)) => (def_id, m),
        (Some(id), Some(m)) => (id, m),
    };
    check_id("responseId", resp_id, ext)?;
    if resp_mask == 0 || resp_mask > full {
        return Err(invalid(format!(
            "responseMask 0x{resp_mask:X} must be within 0x1..=0x{full:X}"
        )));
    }
    if (req.functional_id & resp_mask) == (resp_id & resp_mask) {
        return Err(invalid(format!(
            "functionalId 0x{:X} must not match the response filter 0x{resp_id:X}/0x{resp_mask:X}",
            req.functional_id
        )));
    }
    Ok(Plan {
        pdu,
        window_ms,
        resp_id,
        resp_mask,
    })
}

fn request_frame(req: &EcuDiscoveryRequestDto, pdu: &[u8]) -> Result<RawCanFrame, DiagError> {
    let key = if req.is_extended_id {
        CanIdKey::new_extended(req.functional_id)
    } else {
        u16::try_from(req.functional_id)
            .ok()
            .and_then(CanIdKey::new_standard)
    }
    .ok_or_else(|| invalid(format!("functionalId 0x{:X} is not a valid CAN id", req.functional_id)))?;
    let payload = build_single_frame(pdu, req.padding);
    let built = if req.use_fd {
        RawCanFrame::new_fd(req.bus_id, key, &payload, false, 0)
    } else {
        RawCanFrame::new_classical(req.bus_id, key, &payload, 0)
    };
    built.map_err(|e| invalid(format!("cannot build the functional request frame: {e}")))
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
        let frame = request_frame(&req, &plan.pdu)?;

        let mut result = {
            let ext = Some(req.is_extended_id);
            let filters = [
                DiagTapFilter {
                    id: plan.resp_id,
                    mask: plan.resp_mask,
                    extended: ext,
                },
                DiagTapFilter {
                    id: req.functional_id,
                    mask: if req.is_extended_id { 0x1FFF_FFFF } else { 0x7FF },
                    extended: ext,
                },
            ];
            // Gate (not connected / Listen-Only / disarmed / Panic latched) is enforced here.
            let port = self.open_diag_tap(req.bus_id, &filters, DEFAULT_TAP_DEPTH)?;
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
        let mut collector =
            DiscoveryCollector::new(plan.pdu[0], req.functional_id, req.is_extended_id, tx_ts);
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
        let Some(request_id) = ecu.request_id else {
            ecu.identify_error = Some(format!(
                "no physical request id can be derived from response id 0x{:X}",
                ecu.response_id
            ));
            return;
        };
        let existing = self.diag_sessions.valid_for_addressing(
            req.bus_id,
            request_id,
            ecu.response_id,
            req.is_extended_id,
        );
        let (session, temporary) = match existing {
            Some(s) => (s, false),
            None => {
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
                };
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
        serde_json::from_str(r#"{"busId":0,"isExtendedId":false,"functionalId":2014}"#).expect("req")
    }

    #[test]
    fn plan_defaults() {
        let p = plan(&req()).expect("plan");
        assert_eq!(p.pdu, vec![0x3E, 0x00]);
        assert_eq!(p.window_ms, 300);
        assert_eq!((p.resp_id, p.resp_mask), (0x7E8, 0x7F8));
        let mut r = req();
        r.is_extended_id = true;
        r.functional_id = 0x18DB_33F1;
        let p = plan(&r).expect("plan ext");
        assert_eq!((p.resp_id, p.resp_mask), (0x18DA_F100, 0x1FFF_FF00));
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
        assert_eq!(plan(&r).map(|p| p.resp_mask).ok(), Some(0x7FF));
    }

    #[test]
    fn request_frame_padding_and_fd() {
        let mut r = req();
        let f = request_frame(&r, &[0x3E, 0x00]).expect("frame");
        assert_eq!(f.payload(), &[0x02, 0x3E, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA]);
        assert_eq!(f.arb_id, 0x7DE);
        assert!(!f.is_extended() && f.flags & nexus_core::FLAG_FD == 0);
        r.padding = None;
        let f = request_frame(&r, &[0x3E, 0x00]).expect("frame");
        assert_eq!(f.payload(), &[0x02, 0x3E, 0x00]);
        r.use_fd = true;
        r.is_extended_id = true;
        r.functional_id = 0x18DB_33F1;
        r.padding = Some(0xCC);
        let f = request_frame(&r, &[0x22; 10]).expect("fd frame");
        assert!(f.is_extended() && f.flags & nexus_core::FLAG_FD != 0);
        assert_eq!(&f.payload()[..2], &[0x00, 0x0A]);
        assert_eq!(f.payload().len(), 12);
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
        assert_eq!(engine.diag_tap_count(0), 0, "no tap leaked by a refused discovery");

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
        let res = engine.cmd_diag_discover_ecus(r).expect("discovery on mock0");
        assert!(t0.elapsed() >= Duration::from_millis(60), "window is fixed");
        assert_eq!(res.request_bytes, vec![0x3E, 0x00]);
        assert_eq!(res.window_ms, 60);
        assert!(res.tx_timestamp_us > 0);
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(engine.diag_tap_count(0), 0, "discovery tap closed after the window");

        // Panic Stop latches → refused.
        let _ = engine.cmd_panic_stop_tx();
        let code = engine.cmd_diag_discover_ecus(req()).unwrap_err().code;
        assert!(
            matches!(code, DiagErrorCode::PanicLatched | DiagErrorCode::Disarmed),
            "{code:?}"
        );
    }
}
