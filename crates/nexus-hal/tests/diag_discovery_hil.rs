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

use std::time::Duration;

use common::{hil_env, serial, EcuSim, Ids, CLASSIC};
use nexus_hal::{ChannelConfigDto, PipelineEngine};
use nexus_protocols::uds::dto::{DiagSessionConfigDto, EcuDiscoveryRequestDto};

const ECU_B: Ids = Ids { req: 0x7E6, resp: 0x7EE, func: 0x7DE };
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

    let res = engine.cmd_diag_discover_ecus(request(true)).expect("discovery");
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
    assert_eq!(engine.diag_tap_count(0), 0, "discovery + temporary identify taps released");
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
    };
    engine.cmd_diag_open_session(user.clone()).expect("user session");
    assert_eq!(engine.diag_tap_count(0), 1);

    let res = engine.cmd_diag_discover_ecus(request(true)).expect("discovery");
    assert_eq!(res.ecus.len(), 2);
    assert!(res.ecus.iter().all(|e| e.vin.as_deref() == Some(VIN)), "{res:?}");

    // The user's session was used (and its conversation shows the identify DIDs), not replaced.
    let info = engine.cmd_diag_session_info(user.clone()).expect("info");
    assert!(info.open, "user session must stay open");
    let conv = engine.cmd_diag_get_conversation(user.clone(), 0, None).expect("conversation");
    assert!(
        conv.events.iter().any(|e| e.bytes.starts_with(&[0x22, 0xF1, 0x90])),
        "identify of ECU A went through the user session"
    );
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(engine.diag_tap_count(0), 1, "only the user session tap remains");
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
    assert_eq!(err.code, nexus_protocols::uds::dto::DiagErrorCode::InvalidInput);
    let _ = engine.cmd_disconnect_bus(0);
}
