//! `cmd_diag_discover_ecus` end-to-end on vcan0 against two `tests/hil/ecusim` instances
//! (HAL SocketCAN driver → bus-io thread → discovery tap → functional request → collection).
//!
//! Run: `cargo test -p nexus-hal --test diag_discovery_hil -- --test-threads=1 --nocapture`
//!
//! IDs: ECU A = 0x7E2/0x7EA, ECU B = 0x7E6/0x7EE, shared functional id 0x7DE. The response
//! filter 0x7EA/0x7FB accepts exactly 0x7EA and 0x7EE, so the user's manual ECU
//! (0x7E0/0x7E8/0x7DF) is neither addressed nor collected. Without vcan0 / ecusim the tests
//! print `SKIP (HIL)` and return.
#![cfg(target_os = "linux")]

#[path = "../../nexus-protocols/tests/common/mod.rs"]
mod common;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{hil_env, serial, EcuSim, Ids, CLASSIC};
use nexus_hal::pipeline::diag_discovery::IDENTIFY_EXTENDED_SKIPPED;
use nexus_hal::{ChannelConfigDto, PipelineEngine};
use nexus_protocols::uds::dto::{
    AddressFormatDto, DiagSessionConfigDto, EcuDiscoveryRequestDto, IdFilterDto, RequestIdRuleDto,
};
use socketcan::{CanFilter, CanFrame, CanSocket, EmbeddedFrame, Frame, Socket, SocketOptions};

const ECU_B: Ids = Ids {
    req: 0x7E6,
    resp: 0x7EE,
    func: 0x7DE,
};
const FILTER_ID: u32 = 0x7EA;
const FILTER_MASK: u32 = 0x7FB;
const VIN: &str = "WNX0ECUSIM0000017";
const SERIAL: &str = "SN0000000042";
const PART: &str = "NXC-ECUSIM-0001";

fn engine_on_vcan0() -> PipelineEngine {
    let engine = PipelineEngine::new();
    let cfg = ChannelConfigDto {
        bus_id: 0,
        listen_only: false,
        enable_fd: true,
        ..ChannelConfigDto::default()
    };
    engine
        .cmd_connect_bus(format!("socketcan:{}", common::IFACE), cfg)
        .expect("connect vcan0");
    engine.cmd_arm_active_bus(0, true).expect("arm");
    engine
}

fn request(identify: bool) -> EcuDiscoveryRequestDto {
    assert_eq!(CLASSIC.func, ECU_B.func);
    EcuDiscoveryRequestDto {
        bus_id: 0,
        is_extended_id: false,
        functional_id: CLASSIC.func,
        request_pdu: None,
        window_ms: Some(300),
        response_id: Some(FILTER_ID),
        response_mask: Some(FILTER_MASK),
        padding: Some(0xAA),
        use_fd: false,
        identify,
        response_id_filters: None,
        request_id_rule: None,
        address_format: Default::default(),
        target_address: None,
        response_address: None,
    }
}

#[test]
fn discovers_two_ecus_on_one_functional_id_and_identifies_them() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let a = EcuSim::start("disc_a", CLASSIC, false);
    let b = EcuSim::start("disc_b", ECU_B, false);
    let engine = engine_on_vcan0();

    let res = engine
        .cmd_diag_discover_ecus(request(true))
        .expect("discovery");
    eprintln!("{}", serde_json::to_string_pretty(&res).unwrap_or_default());

    assert_eq!(res.request_bytes, vec![0x3E, 0x00]);
    assert_eq!(res.functional_id, 0x7DE);
    assert_eq!(res.window_ms, 300);
    assert!(res.tx_timestamp_us > 0);
    let ids: Vec<u32> = res.ecus.iter().map(|e| e.response_id).collect();
    assert_eq!(ids, vec![0x7EA, 0x7EE], "both ECUs, sorted, one entry each");
    for (ecu, req_id) in res.ecus.iter().zip([CLASSIC.req, ECU_B.req]) {
        assert_eq!(ecu.request_id, Some(req_id));
        assert!(ecu.positive, "{ecu:?}");
        assert_eq!(ecu.raw, vec![0x7E, 0x00]);
        assert_eq!(ecu.response_count, 1);
        assert!(!ecu.pending && !ecu.multi_frame && ecu.nrc.is_none());
        assert!(ecu.first_response_us < 300_000);
        assert_eq!(ecu.vin.as_deref(), Some(VIN));
        assert_eq!(ecu.serial_number.as_deref(), Some(SERIAL));
        assert_eq!(ecu.part_number.as_deref(), Some(PART));
        assert_eq!(ecu.identify_error, None);
    }
    // Both ECUs saw ONE functional request.
    assert!(a.count("\"func\"") >= 1, "ECU A log: {}", a.log_text());
    assert!(b.count("\"func\"") >= 1, "ECU B log: {}", b.log_text());

    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(
        engine.diag_tap_count(0),
        0,
        "discovery + temporary identify taps released"
    );
    let _ = engine.cmd_disconnect_bus(0);
}

#[test]
fn identify_reuses_open_user_session_and_keeps_it_open() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let _a = EcuSim::start("disc_reuse_a", CLASSIC, false);
    let _b = EcuSim::start("disc_reuse_b", ECU_B, false);
    let engine = engine_on_vcan0();

    let user = DiagSessionConfigDto {
        bus_id: 0,
        request_id: CLASSIC.req,
        response_id: CLASSIC.resp,
        is_extended_id: false,
        protocol: Some("uds".into()),
        functional_id: None,
        use_fd: false,
        padding: Some(0xAA),
        p2_margin_ms: 250, // different settings than identify's temporary session
        address_format: Default::default(),
        target_address: None,
        response_address: None,
    };
    engine
        .cmd_diag_open_session(user.clone())
        .expect("user session");
    assert_eq!(engine.diag_tap_count(0), 1);

    let res = engine
        .cmd_diag_discover_ecus(request(true))
        .expect("discovery");
    assert_eq!(res.ecus.len(), 2);
    assert!(
        res.ecus.iter().all(|e| e.vin.as_deref() == Some(VIN)),
        "{res:?}"
    );

    // The user's session was used (and its conversation shows the identify DIDs), not replaced.
    let info = engine.cmd_diag_session_info(user.clone()).expect("info");
    assert!(info.open, "user session must stay open");
    let conv = engine
        .cmd_diag_get_conversation(user.clone(), 0, None)
        .expect("conversation");
    assert!(
        conv.events
            .iter()
            .any(|e| e.bytes.starts_with(&[0x22, 0xF1, 0x90])),
        "identify of ECU A went through the user session"
    );
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(
        engine.diag_tap_count(0),
        1,
        "only the user session tap remains"
    );
    engine.cmd_diag_close_session(user).expect("close");
    let _ = engine.cmd_disconnect_bus(0);
}

#[test]
fn custom_pdu_negative_and_multi_frame_answers() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let _a = EcuSim::start("disc_pdu_a", CLASSIC, false);
    let _b = EcuSim::start("disc_pdu_b", ECU_B, false);
    let engine = engine_on_vcan0();

    // Unsupported DID → 7F 22 31 from both (ISO 14229: NRC 0x31 is suppressed for functional
    // requests, so the ECUs may also stay silent; both outcomes are valid but never positive).
    let mut r = request(false);
    r.request_pdu = Some(vec![0x22, 0x12, 0x34]);
    let res = engine.cmd_diag_discover_ecus(r).expect("discovery 22 1234");
    assert_eq!(res.request_bytes, vec![0x22, 0x12, 0x34]);
    assert!(res.ecus.iter().all(|e| !e.positive), "{res:?}");

    // VIN (17 bytes) needs a multi-frame answer: recorded from the First Frame, no Flow Control.
    let mut r = request(false);
    r.request_pdu = Some(vec![0x22, 0xF1, 0x90]);
    let res = engine.cmd_diag_discover_ecus(r).expect("discovery 22 F190");
    assert_eq!(res.ecus.len(), 2, "{res:?}");
    for e in &res.ecus {
        assert!(e.positive && e.multi_frame, "{e:?}");
        assert_eq!(&e.raw[..3], &[0x62, 0xF1, 0x90]);
    }

    // Suppressed positive response is refused up front.
    let mut r = request(false);
    r.request_pdu = Some(vec![0x3E, 0x80]);
    let err = engine.cmd_diag_discover_ecus(r).unwrap_err();
    assert_eq!(
        err.code,
        nexus_protocols::uds::dto::DiagErrorCode::InvalidInput
    );
    let _ = engine.cmd_disconnect_bus(0);
}

// ─── configurable discovery (OEM ranges, filters, request-id rules, addressing) ───

/// OEM functional id of the tests below (never the user's 0x7DF).
const OEM_FUNC: u32 = 0x5DF;

fn oem(req: u32, resp: u32) -> Ids {
    Ids {
        req,
        resp,
        func: OEM_FUNC,
    }
}

fn exact(id: u32) -> IdFilterDto {
    IdFilterDto { id, mask: 0x7FF }
}

#[test]
fn oem_range_responders_with_filter_list_and_offset_rule() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    // Three responders outside 0x7E8..0x7EF + one decoy that answers the same functional id
    // but is not in the filter list (it IS inside the covering superset of the tap).
    let _a = EcuSim::start("disc_oem_a", oem(0x5A0, 0x5A8), false);
    let _b = EcuSim::start("disc_oem_b", oem(0x5B0, 0x5B8), false);
    let _c = EcuSim::start("disc_oem_c", oem(0x640, 0x648), false);
    let decoy = EcuSim::start("disc_oem_decoy", oem(0x6E0, 0x6E8), false);
    let engine = engine_on_vcan0();

    let req = EcuDiscoveryRequestDto {
        functional_id: OEM_FUNC,
        response_id: None,
        response_mask: None,
        // 4 filters + the functional id do not fit the 4 tap slots: covering filter is used.
        response_id_filters: Some(vec![exact(0x5A8), exact(0x5B8), exact(0x648), exact(0x658)]),
        request_id_rule: Some(RequestIdRuleDto::Offset { delta: -8 }),
        ..request(true)
    };
    let res = engine.cmd_diag_discover_ecus(req).expect("discovery");
    eprintln!("{}", serde_json::to_string_pretty(&res).unwrap_or_default());

    let ids: Vec<(u32, Option<u32>)> = res
        .ecus
        .iter()
        .map(|e| (e.response_id, e.request_id))
        .collect();
    assert_eq!(
        ids,
        vec![
            (0x5A8, Some(0x5A0)),
            (0x5B8, Some(0x5B0)),
            (0x648, Some(0x640))
        ],
        "exact filter list applied, decoy 0x6E8 not listed"
    );
    assert!(decoy.count("\"func\"") >= 1, "decoy did answer");
    assert!(res.ignored_frames >= 1, "decoy answer counted as ignored");
    assert!(!res.truncated && res.dropped_ecus == 0);
    for e in &res.ecus {
        assert!(e.positive && e.raw == vec![0x7E, 0x00], "{e:?}");
        assert_eq!(e.vin.as_deref(), Some(VIN), "identify via the offset rule");
        assert_eq!(e.identify_error, None);
    }
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(engine.diag_tap_count(0), 0);
    let _ = engine.cmd_disconnect_bus(0);
}

/// Raw vcan0 socket accepting exactly the 11-bit `ids`.
fn raw_socket(ids: &[u32]) -> CanSocket {
    let s = CanSocket::open(common::IFACE).expect("raw socket");
    let f: Vec<CanFilter> = ids
        .iter()
        .map(|id| CanFilter::new(*id, 0x7FF | 0x8000_0000 | 0x4000_0000))
        .collect();
    s.set_filters(&f).expect("filters");
    s.set_read_timeout(Duration::from_millis(20))
        .expect("timeout");
    s
}

fn frame(id: u32, data: &[u8]) -> CanFrame {
    CanFrame::new(socketcan::StandardId::new(id as u16).expect("id"), data).expect("frame")
}

#[test]
fn legacy_request_is_byte_identical_on_the_wire() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let _a = EcuSim::start("disc_legacy_a", CLASSIC, false);
    let _b = EcuSim::start("disc_legacy_b", ECU_B, false);
    let sniff = raw_socket(&[CLASSIC.func]);
    let engine = engine_on_vcan0();

    // Old HMI JSON: none of the new fields.
    let legacy: EcuDiscoveryRequestDto = serde_json::from_str(
        r#"{"busId":0,"isExtendedId":false,"functionalId":2014,"windowMs":300,
            "responseId":2026,"responseMask":2043,"padding":170,"useFd":false,"identify":false}"#,
    )
    .expect("legacy json");
    assert_eq!(legacy, request(false));
    let res = engine.cmd_diag_discover_ecus(legacy).expect("discovery");

    let mut seen = Vec::new();
    while let Ok(f) = sniff.read_frame() {
        seen.push((f.raw_id(), f.data().to_vec()));
    }
    assert_eq!(
        seen,
        vec![(0x7DE, vec![0x02, 0x3E, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA])],
        "exactly one classic SF, unchanged bytes"
    );
    let ids: Vec<(u32, Option<u32>)> = res
        .ecus
        .iter()
        .map(|e| (e.response_id, e.request_id))
        .collect();
    assert_eq!(ids, vec![(0x7EA, Some(0x7E2)), (0x7EE, Some(0x7E6))]);
    assert!(!res.truncated && res.dropped_ecus == 0);
    let v = serde_json::to_value(&res).expect("json");
    assert_eq!(v["truncated"], false);
    assert_eq!(v["droppedEcus"], 0);
    let _ = engine.cmd_disconnect_bus(0);
}

/// Scripted extended-addressing ECU: answers `TA 02 3E 00` on `func` with
/// `F1 02 7E 00` on `resp`; counts every frame seen on its physical request id.
struct ExtAddrResponder {
    stop: Arc<AtomicBool>,
    physical_frames: Arc<AtomicUsize>,
    answered: Arc<Mutex<usize>>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl ExtAddrResponder {
    fn start(func: u32, req: u32, resp: u32, ta: u8) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let physical_frames = Arc::new(AtomicUsize::new(0));
        let answered = Arc::new(Mutex::new(0));
        let rx = raw_socket(&[func, req]);
        let tx = CanSocket::open(common::IFACE).expect("tx socket");
        let (st, pf, an) = (stop.clone(), physical_frames.clone(), answered.clone());
        let join = std::thread::spawn(move || {
            while !st.load(Ordering::Acquire) {
                let Ok(f) = rx.read_frame() else { continue };
                if f.raw_id() == req {
                    pf.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                if f.data().get(..4) == Some(&[ta, 0x02, 0x3E, 0x00][..]) {
                    let _ = tx.write_frame(&frame(
                        resp,
                        &[0xF1, 0x02, 0x7E, 0x00, 0xCC, 0xCC, 0xCC, 0xCC],
                    ));
                    *an.lock().unwrap_or_else(|e| e.into_inner()) += 1;
                }
            }
        });
        Self {
            stop,
            physical_frames,
            answered,
            join: Some(join),
        }
    }
}

impl Drop for ExtAddrResponder {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

#[test]
fn extended_addressing_lists_ecu_but_never_guesses_identify_target() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let ecu = ExtAddrResponder::start(0x5DE, 0x5E1, 0x5E9, 0x33);
    let engine = engine_on_vcan0();
    let req = EcuDiscoveryRequestDto {
        functional_id: 0x5DE,
        response_id: None,
        response_mask: None,
        response_id_filters: Some(vec![exact(0x5E9)]),
        request_id_rule: Some(RequestIdRuleDto::Offset { delta: -8 }),
        address_format: AddressFormatDto::Extended,
        target_address: Some(0x33),
        response_address: Some(0xF1),
        ..request(true)
    };
    let res = engine.cmd_diag_discover_ecus(req).expect("discovery");
    assert_eq!(*ecu.answered.lock().unwrap_or_else(|e| e.into_inner()), 1);
    assert_eq!(res.ecus.len(), 1, "{res:?}");
    let e = &res.ecus[0];
    assert_eq!((e.response_id, e.request_id), (0x5E9, Some(0x5E1)));
    assert!(e.positive && e.raw == vec![0x7E, 0x00], "{e:?}");
    assert_eq!(e.identify_error.as_deref(), Some(IDENTIFY_EXTENDED_SKIPPED));
    assert!(e.vin.is_none());
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(
        ecu.physical_frames.load(Ordering::Relaxed),
        0,
        "no physical request with a guessed target byte"
    );
    let _ = engine.cmd_disconnect_bus(0);
}
