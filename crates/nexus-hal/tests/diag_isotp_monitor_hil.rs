//! ISO-TP Monitor capture (`cmd_diag_get_isotp_frames`) end-to-end on vcan0 against
//! `tests/hil/ecusim` (CLASSIC test ids 0x7E2 / 0x7EA / 0x7DE; never the user's 0x7E0/0x7E8/0x7DF).
//!
//! Run: `cargo test -p nexus-hal --test diag_isotp_monitor_hil -- --test-threads=1 --nocapture`
#![cfg(target_os = "linux")]

#[path = "../../nexus-protocols/tests/common/mod.rs"]
mod common;

use common::{config, hil_env, serial, EcuSim, CLASSIC};
use nexus_hal::{ChannelConfigDto, PipelineEngine};
use nexus_protocols::uds::dto::{IsoTpDirection, IsoTpFrameKind};

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

#[test]
fn multi_frame_did_read_is_captured_in_bus_order() {
    let _g = serial();
    if hil_env(false).is_none() {
        return;
    }
    let _ecu = EcuSim::start("isotp_monitor", CLASSIC, false);
    let engine = engine_on_vcan0();
    let cfg = config(CLASSIC, false, false);

    // Unknown session: empty page, nothing opened.
    let p = engine
        .cmd_diag_get_isotp_frames(cfg.clone(), 0, None)
        .expect("page");
    assert!(p.frames.is_empty() && p.last_seq == 0 && !p.truncated);
    assert_eq!(
        engine.diag_tap_count(0),
        0,
        "reading the monitor never opens a session"
    );

    let did = engine
        .cmd_diag_read_did(cfg.clone(), 0xF1F1, None)
        .expect("read F1F1");
    let total = 3 + did.raw.len(); // 62 F1 F1 + record
    assert!(total > 7, "multi-frame response expected");
    let expected_cf = (total - 6).div_ceil(7);

    let page = engine
        .cmd_diag_get_isotp_frames(cfg.clone(), 0, Some(2_000))
        .expect("page");
    assert!(!page.truncated);
    assert_eq!(page.dropped, 0);
    let seqs: Vec<u64> = page.frames.iter().map(|f| f.seq).collect();
    assert!(
        seqs.windows(2).all(|w| w[1] == w[0] + 1),
        "contiguous seq: {seqs:?}"
    );
    assert_eq!(seqs.first(), Some(&1));
    assert_eq!(page.last_seq, *seqs.last().expect("frames"));
    assert!(
        page.frames
            .windows(2)
            .all(|w| w[1].timestamp_us >= w[0].timestamp_us),
        "monotonic timestamps: {:?}",
        page.frames
            .iter()
            .map(|f| f.timestamp_us)
            .collect::<Vec<_>>()
    );

    let pattern: Vec<(IsoTpDirection, u32, IsoTpFrameKind)> = page
        .frames
        .iter()
        .map(|f| (f.direction, f.can_id, f.kind))
        .collect();
    let mut expected = vec![
        (IsoTpDirection::Tx, CLASSIC.req, IsoTpFrameKind::Single),
        (IsoTpDirection::Rx, CLASSIC.resp, IsoTpFrameKind::First),
        (IsoTpDirection::Tx, CLASSIC.req, IsoTpFrameKind::FlowControl),
    ];
    expected.extend(std::iter::repeat_n(
        (
            IsoTpDirection::Rx,
            CLASSIC.resp,
            IsoTpFrameKind::Consecutive,
        ),
        expected_cf,
    ));
    assert_eq!(pattern, expected);

    let sf = &page.frames[0];
    assert_eq!(&sf.data[..4], &[0x03, 0x22, 0xF1, 0xF1]);
    assert_eq!(sf.data.len(), 8, "padded classic SF");
    assert!(!sf.fd && !sf.is_extended);
    let ff = &page.frames[1];
    assert_eq!(&ff.data[2..5], &[0x62, 0xF1, 0xF1]);
    assert_eq!(
        usize::from(ff.data[0] & 0x0F) << 8 | usize::from(ff.data[1]),
        total
    );
    assert_eq!(page.frames[2].data[0], 0x30, "FC CTS");
    for (i, cf) in page.frames[3..].iter().enumerate() {
        assert_eq!(
            cf.data[0],
            0x20 | (((i + 1) & 0x0F) as u8),
            "CF sequence number"
        );
    }

    // Incremental paging from the last cursor: nothing new.
    let p = engine
        .cmd_diag_get_isotp_frames(cfg.clone(), page.last_seq, None)
        .expect("page");
    assert!(p.frames.is_empty() && p.last_seq == page.last_seq && !p.truncated);
    // Small pages walk the same frames.
    let p = engine
        .cmd_diag_get_isotp_frames(cfg.clone(), 0, Some(2))
        .expect("page");
    assert_eq!(p.frames.len(), 2);
    assert_eq!(p.last_seq, 2);

    engine.cmd_diag_close_session(cfg).expect("close");
    let _ = engine.cmd_disconnect_bus(0);
}
