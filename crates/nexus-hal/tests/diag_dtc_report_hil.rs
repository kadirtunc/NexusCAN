//! `cmd_diag_read_dtc_report` (0x19) end-to-end on vcan0 against `tests/hil/ecusim` (CLASSIC
//! test ids 0x7E2 / 0x7EA, never the user's 0x7E0 / 0x7E8 / 0x7DF). ecusim's default config
//! stores DTCs 0x012345 (status 0x2F), 0x9A0B00 (0x08) and 0x400100 (0x00) and implements
//! reportTypes 01, 02, 04, 06 and 0A (others answer NRC 0x12).
//!
//! Run: `cargo test -p nexus-hal --test diag_dtc_report_hil -- --test-threads=1 --nocapture`
#![cfg(target_os = "linux")]

#[path = "../../nexus-protocols/tests/common/mod.rs"]
mod common;

use common::{config, hil_env, serial, EcuSim, CLASSIC};
use nexus_hal::{ChannelConfigDto, PipelineEngine};
use nexus_protocols::uds::dto::{
    ConversationEventKind, DiagErrorCode, DiagOrigin, ReadDtcReportDto, UdsRequestOptionsDto,
};

fn engine_on_vcan0(listen_only: bool) -> PipelineEngine {
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
fn read_dtc_reports_against_ecusim() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let _ecu = EcuSim::start("dtc_report", CLASSIC, false);
    let engine = engine_on_vcan0(false);
    let cfg = config(CLASSIC, false, false);

    // 19 02 FF: two DTCs match (0x400100 has status 0).
    let r = engine
        .cmd_diag_read_dtc_report(cfg.clone(), 0x02, vec![0xFF], None)
        .expect("19 02");
    eprintln!("{}", serde_json::to_string_pretty(&r).unwrap_or_default());
    assert!(r.response.positive && r.report_error.is_none());
    let Some(ReadDtcReportDto::List(list)) = &r.report else {
        panic!("list expected: {r:?}");
    };
    assert_eq!(list.sub_function, 0x02);
    assert_eq!(list.availability_mask, 0xFF);
    let dtcs: Vec<(u32, u8)> = list.dtcs.iter().map(|d| (d.raw, d.status_byte)).collect();
    assert_eq!(dtcs, vec![(0x012345, 0x2F), (0x9A0B00, 0x08)]);
    assert_eq!(list.dtcs[0].code, "P0123-45");
    let v = serde_json::to_value(&r).expect("json");
    assert_eq!(v["report"]["kind"], "list");
    assert!(v.get("reportError").is_some_and(|e| e.is_null()));

    // 19 01 FF: count.
    let r = engine
        .cmd_diag_read_dtc_report(cfg.clone(), 0x01, vec![0xFF], None)
        .expect("19 01");
    let Some(ReadDtcReportDto::Count(c)) = &r.report else {
        panic!("count expected: {r:?}");
    };
    assert_eq!(c.count, 2);

    // 19 0A: every supported DTC (no params).
    let r = engine
        .cmd_diag_read_dtc_report(cfg.clone(), 0x0A, vec![], None)
        .expect("19 0A");
    let Some(ReadDtcReportDto::List(list)) = &r.report else {
        panic!("list expected: {r:?}");
    };
    assert_eq!(list.dtcs.len(), 3);

    // 19 04 012345 01: snapshot record 1 (two DIDs, so no single-DID decode).
    let r = engine
        .cmd_diag_read_dtc_report(cfg.clone(), 0x04, vec![0x01, 0x23, 0x45, 0x01], None)
        .expect("19 04");
    let Some(ReadDtcReportDto::SnapshotRecord(s)) = &r.report else {
        panic!("snapshot expected: {r:?}");
    };
    assert_eq!(s.dtc.raw, 0x012345);
    let rec = s.record.as_ref().expect("record 1 stored");
    assert_eq!(
        (rec.record_number, rec.number_of_identifiers, rec.first_did),
        (1, 2, Some(0x1001))
    );

    // 19 06 012345 01: extended data record.
    let r = engine
        .cmd_diag_read_dtc_report(cfg.clone(), 0x06, vec![0x01, 0x23, 0x45, 0x01], None)
        .expect("19 06");
    let Some(ReadDtcReportDto::ExtData(x)) = &r.report else {
        panic!("ext data expected: {r:?}");
    };
    assert_eq!(x.first_record_number, Some(1));

    // 19 03 is not implemented by ecusim: negative response is a RESULT, report None + reason.
    let r = engine
        .cmd_diag_read_dtc_report(cfg.clone(), 0x03, vec![], None)
        .expect("19 03");
    assert!(!r.response.positive);
    assert_eq!(r.response.raw, vec![0x7F, 0x19, 0x12]);
    assert!(r.report.is_none());
    assert!(r.report_error.as_deref().unwrap_or("").contains("0x12"));

    // Explicit origin override is kept; default origin is `dtc`.
    let opts = UdsRequestOptionsDto {
        origin: Some(DiagOrigin::Console),
        ..Default::default()
    };
    engine
        .cmd_diag_read_dtc_report(cfg.clone(), 0x02, vec![0x08], Some(opts))
        .expect("19 02 08");
    let conv = engine
        .cmd_diag_get_conversation(cfg.clone(), 0, None)
        .expect("conversation");
    let origins: Vec<DiagOrigin> = conv
        .events
        .iter()
        .filter(|e| e.kind == ConversationEventKind::Request && e.sid == Some(0x19))
        .map(|e| e.origin)
        .collect();
    assert_eq!(
        origins,
        vec![
            DiagOrigin::Dtc,
            DiagOrigin::Dtc,
            DiagOrigin::Dtc,
            DiagOrigin::Dtc,
            DiagOrigin::Dtc,
            DiagOrigin::Dtc,
            DiagOrigin::Console
        ]
    );
    let _ = engine.cmd_disconnect_bus(0);
}

#[test]
fn read_dtc_report_is_refused_on_listen_only_and_invalid_input_sends_nothing() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let engine = engine_on_vcan0(true);
    let cfg = config(CLASSIC, false, false);
    let e = engine
        .cmd_diag_read_dtc_report(cfg.clone(), 0x02, vec![0xFF], None)
        .unwrap_err();
    assert_eq!(e.code, DiagErrorCode::ListenOnly);
    assert_eq!(engine.diag_tap_count(0), 0);
    let e = engine
        .cmd_diag_read_dtc_report(cfg, 0x04, vec![0x01, 0x23, 0x45], None)
        .unwrap_err();
    assert_eq!(e.code, DiagErrorCode::InvalidInput);
    let _ = engine.cmd_disconnect_bus(0);
}
