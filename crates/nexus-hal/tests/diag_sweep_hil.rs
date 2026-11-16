//! `cmd_diag_physical_sweep` end-to-end on vcan0 against two `tests/hil/ecusim` instances on
//! OEM ids outside 0x7E0..0x7EF (never the user's 0x7E0 / 0x7E8 / 0x7DF): ECU A 0x5A3 → 0x5C3,
//! ECU B 0x5AA → 0x5CA (functional 0x59F, unused). SKIPs without vcan0 / ecusim.
//!
//! Run: `cargo test -p nexus-hal --test diag_sweep_hil -- --test-threads=1 --nocapture`
#![cfg(target_os = "linux")]

#[path = "../../nexus-protocols/tests/common/mod.rs"]
mod common;

use std::time::Duration;

use common::{hil_env, serial, EcuSim, Ids};
use nexus_hal::{ChannelConfigDto, IdRangeDto, PhysicalSweepRequestDto, PipelineEngine};
use nexus_protocols::uds::dto::{DiagErrorCode, IdFilterDto, RequestIdRuleDto};

const ECU_A: Ids = Ids {
    req: 0x5A3,
    resp: 0x5C3,
    func: 0x59F,
};
const ECU_B: Ids = Ids {
    req: 0x5AA,
    resp: 0x5CA,
    func: 0x59F,
};

fn engine(listen_only: bool) -> PipelineEngine {
    let engine = PipelineEngine::new();
    let cfg = ChannelConfigDto {
        bus_id: 0,
        listen_only,
        enable_fd: true,
        ..ChannelConfigDto::default()
    };
    engine
        .cmd_connect_bus(format!("socketcan:{}", common::IFACE), cfg)
        .expect("connect vcan0");
    if !listen_only {
        engine.cmd_arm_active_bus(0, true).expect("arm");
    }
    engine
}

fn sweep() -> PhysicalSweepRequestDto {
    PhysicalSweepRequestDto {
        bus_id: 0,
        is_extended_id: false,
        request_ids: None,
        request_id_range: Some(IdRangeDto {
            start: 0x5A0,
            end: 0x5AF,
        }),
        request_pdu: None,
        // Wide gap: ecusim on a loaded machine may answer late; attribution is by timestamp.
        gap_ms: Some(50),
        tail_ms: Some(100),
        response_id: None,
        response_mask: None,
        response_id_filters: Some(vec![IdFilterDto {
            id: 0x5C0,
            mask: 0x7E0,
        }]),
        request_id_rule: Some(RequestIdRuleDto::Offset { delta: -0x20 }),
        padding: Some(0xAA),
        use_fd: false,
        address_format: Default::default(),
        target_address: None,
        response_address: None,
    }
}

#[test]
fn sweep_finds_ecus_that_only_answer_physically() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let a = EcuSim::start("sweep_a", ECU_A, false);
    let b = EcuSim::start("sweep_b", ECU_B, false);
    let engine = engine(false);

    let res = engine.cmd_diag_physical_sweep(sweep()).expect("sweep");
    eprintln!("{}", serde_json::to_string_pretty(&res).unwrap_or_default());
    assert!(res.completed && res.abort_code.is_none(), "{res:?}");
    assert_eq!((res.total, res.sent), (16, 16));
    assert_eq!(res.request_bytes, vec![0x3E, 0x00]);
    let ids: Vec<(u32, Option<u32>)> = res
        .ecus
        .iter()
        .map(|e| (e.response_id, e.request_id))
        .collect();
    assert_eq!(ids, vec![(0x5C3, Some(0x5A3)), (0x5CA, Some(0x5AA))]);
    assert!(res
        .ecus
        .iter()
        .all(|e| e.positive && e.raw == vec![0x7E, 0x00]));
    let resp: Vec<(u32, u32)> = res
        .responders
        .iter()
        .map(|r| (r.response_id, r.in_flight_request_id))
        .collect();
    assert_eq!(resp, vec![(0x5C3, 0x5A3), (0x5CA, 0x5AA)]);
    assert!(res.responders.iter().all(|r| r.latency_us < 50_000));
    // Each ECU saw exactly one physical request (no burst, no repeats).
    assert_eq!(a.count("\"phys\""), 1, "{}", a.log_text());
    assert_eq!(b.count("\"phys\""), 1, "{}", b.log_text());
    let v = serde_json::to_value(&res).expect("json");
    assert_eq!(v["responders"][0]["inFlightRequestId"], 0x5A3);
    assert!(v["abortCode"].is_null());
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(engine.diag_tap_count(0), 0);
    let _ = engine.cmd_disconnect_bus(0);
}

#[test]
fn sweep_is_refused_on_listen_only() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let engine = engine(true);
    let e = engine.cmd_diag_physical_sweep(sweep()).unwrap_err();
    assert_eq!(e.code, DiagErrorCode::ListenOnly);
    assert_eq!(engine.diag_tap_count(0), 0);
    let _ = engine.cmd_disconnect_bus(0);
}
