//! Passive ECU discovery end-to-end on vcan0: engine A watches in Listen-Only mode while
//! engine B (a separate tester, armed) talks to `tests/hil/ecusim` on the CLASSIC test ids
//! 0x7E2 / 0x7EA (never the user's 0x7E0 / 0x7E8 / 0x7DF). SKIPs without vcan0 / ecusim.
//!
//! Run: `cargo test -p nexus-hal --test diag_passive_hil -- --test-threads=1 --nocapture`
#![cfg(target_os = "linux")]

#[path = "../../nexus-protocols/tests/common/mod.rs"]
mod common;

use std::time::{Duration, Instant};

use common::{config, hil_env, serial, EcuSim, CLASSIC};
use nexus_hal::{ChannelConfigDto, PassiveConfidenceDto, PipelineEngine};

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

#[test]
fn listen_only_engine_learns_tester_ecu_pair_from_foreign_traffic() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let _ecu = EcuSim::start("passive", CLASSIC, false);
    let watcher = engine(true);
    let tester = engine(false);

    let s = watcher
        .cmd_diag_passive_discovery_start(0)
        .expect("passive start on a Listen-Only bus");
    assert!(s.running);

    let cfg = config(CLASSIC, false, false);
    tester
        .cmd_diag_read_did(cfg.clone(), 0xF190, None)
        .expect("VIN (multi-frame, tester sends FC)");
    tester
        .cmd_diag_read_did(cfg.clone(), 0xF18C, None)
        .expect("serial");
    let _ = tester.cmd_diag_send_uds(cfg.clone(), 0x10, Some(0x01), vec![], None);

    let deadline = Instant::now() + Duration::from_secs(3);
    let pair = loop {
        let snap = watcher
            .cmd_diag_passive_discovery_snapshot(0)
            .expect("snap");
        if let Some(p) = snap
            .pairs
            .iter()
            .find(|p| p.request_id == CLASSIC.req && p.response_id == CLASSIC.resp)
        {
            if p.evidence_count >= 4 {
                break p.clone();
            }
        }
        assert!(Instant::now() < deadline, "pair not learned: {snap:?}");
        std::thread::sleep(Duration::from_millis(20));
    };
    eprintln!(
        "{}",
        serde_json::to_string_pretty(&pair).unwrap_or_default()
    );
    assert!(
        pair.flow_control_seen,
        "tester FC answered the VIN First Frame"
    );
    assert_eq!(pair.confidence, PassiveConfidenceDto::High);
    assert_eq!(pair.sids_seen, vec![0x10, 0x22]);
    assert!(!pair.is_extended_id && !pair.functional_request);

    let fin = watcher.cmd_diag_passive_discovery_stop(0).expect("stop");
    assert!(!fin.running);
    assert_eq!(fin.pairs.len(), 1, "only the real pair: {:?}", fin.pairs);
    let v = serde_json::to_value(&fin).expect("json");
    for k in [
        "busId",
        "running",
        "stopReason",
        "startedAtUs",
        "framesAnalyzed",
        "framesDropped",
        "pairs",
        "truncated",
        "droppedPairs",
        "maxPairs",
        "evictedRequests",
    ] {
        assert!(v.get(k).is_some(), "{k}");
    }
    assert_eq!(v["pairs"][0]["confidence"], "high");
    let _ = tester.cmd_disconnect_bus(0);
    let _ = watcher.cmd_disconnect_bus(0);
}
