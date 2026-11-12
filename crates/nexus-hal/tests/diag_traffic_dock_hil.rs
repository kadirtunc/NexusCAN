//! Diagnostics Traffic Dock backend on vcan0 through the real HAL path: exact transaction
//! tagging of captured ISO-TP frames (`IsoTpFrameDto::request_seq`) and request origin tags
//! (`ConversationEventDto::origin`). Uses `tests/hil/ecusim` on the CLASSIC test ids
//! 0x7E2 / 0x7EA / 0x7DE only (never the user's 0x7E0 / 0x7E8 / 0x7DF). SKIPs without vcan0.
//!
//! Run: `cargo test -p nexus-hal --test diag_traffic_dock_hil -- --test-threads=1 --nocapture`
#![cfg(target_os = "linux")]

#[path = "../../nexus-protocols/tests/common/mod.rs"]
mod common;

use std::collections::HashMap;
use std::time::Duration;

use common::{config, hil_env, serial, EcuSim, CLASSIC};
use nexus_hal::{ChannelConfigDto, PipelineEngine};
use nexus_protocols::uds::dto::{
    ConversationEventDto, ConversationEventKind, DiagOrigin, DiagSessionConfigDto, IsoTpDirection,
    IsoTpFrameDto, IsoTpFrameKind, UdsRequestOptionsDto,
};

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

struct Rig {
    engine: PipelineEngine,
    cfg: DiagSessionConfigDto,
    _ecu: EcuSim,
}

impl Rig {
    fn start(tag: &str) -> Option<Rig> {
        hil_env(false)?;
        let ecu = EcuSim::start(tag, CLASSIC, false);
        Some(Rig {
            engine: engine_on_vcan0(),
            cfg: config(CLASSIC, false, false),
            _ecu: ecu,
        })
    }

    fn frames(&self) -> Vec<IsoTpFrameDto> {
        let p = self
            .engine
            .cmd_diag_get_isotp_frames(self.cfg.clone(), 0, Some(2_000))
            .expect("frames");
        assert!(!p.truncated && p.dropped == 0);
        p.frames
    }

    fn events(&self) -> Vec<ConversationEventDto> {
        self.engine
            .cmd_diag_get_conversation(self.cfg.clone(), 0, Some(10_000))
            .expect("conversation")
            .events
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = self.engine.cmd_diag_close_session(self.cfg.clone());
        let _ = self.engine.cmd_disconnect_bus(0);
    }
}

fn request_event(events: &[ConversationEventDto], seq: u64) -> &ConversationEventDto {
    events.iter().find(|e| e.seq == seq).expect("request event")
}

fn final_event_of(events: &[ConversationEventDto], req_seq: u64) -> &ConversationEventDto {
    events
        .iter()
        .find(|e| e.request_seq == Some(req_seq) && e.kind == ConversationEventKind::Response)
        .expect("response event")
}

fn shape(frames: &[&IsoTpFrameDto]) -> Vec<(IsoTpDirection, IsoTpFrameKind)> {
    frames.iter().map(|f| (f.direction, f.kind)).collect()
}

/// (a) multi-frame DID read: SF, FF, FC and every CF carry the Request event's seq; default
/// origin of `cmd_diag_read_did` is `did` on request and response.
#[test]
fn multi_frame_read_tags_every_frame_with_request_seq() {
    let _g = serial();
    let Some(rig) = Rig::start("dock_multi") else {
        return;
    };

    let did = rig
        .engine
        .cmd_diag_read_did(rig.cfg.clone(), 0xF1F1, None)
        .expect("read F1F1");
    let total = 3 + did.raw.len();
    assert!(total > 7, "multi-frame response expected");
    let expected_cf = (total - 6).div_ceil(7);

    let events = rig.events();
    let req = request_event(&events, did.transaction_seq);
    assert_eq!(req.kind, ConversationEventKind::Request);
    assert_eq!(req.origin, DiagOrigin::Did);
    let resp = final_event_of(&events, req.seq);
    assert_eq!(resp.origin, DiagOrigin::Did);

    let frames = rig.frames();
    let tagged: Vec<&IsoTpFrameDto> = frames.iter().collect();
    let mut expected = vec![
        (IsoTpDirection::Tx, IsoTpFrameKind::Single),
        (IsoTpDirection::Rx, IsoTpFrameKind::First),
        (IsoTpDirection::Tx, IsoTpFrameKind::FlowControl),
    ];
    expected.extend(std::iter::repeat_n(
        (IsoTpDirection::Rx, IsoTpFrameKind::Consecutive),
        expected_cf,
    ));
    assert_eq!(shape(&tagged), expected);
    for f in &frames {
        assert_eq!(
            f.request_seq,
            Some(req.seq),
            "frame {} ({:?})",
            f.seq,
            f.kind
        );
    }
}

/// (b) back-to-back requests (multi-frame, single-frame, multi-frame): every frame is tagged
/// with the request whose PDU it carries, never with a neighbour's seq.
#[test]
fn back_to_back_requests_never_mix_tags() {
    let _g = serial();
    let Some(rig) = Rig::start("dock_b2b") else {
        return;
    };

    let dids = [0xF1F1u16, 0xF186, 0xF190, 0xF1F1];
    let mut seq_to_did: HashMap<u64, u16> = HashMap::new();
    for did in dids {
        let r = rig
            .engine
            .cmd_diag_read_did(rig.cfg.clone(), did, None)
            .expect("read");
        seq_to_did.insert(r.transaction_seq, did);
    }
    assert_eq!(seq_to_did.len(), dids.len());

    let frames = rig.frames();
    let mut per_seq: HashMap<u64, Vec<&IsoTpFrameDto>> = HashMap::new();
    for f in &frames {
        let s = f
            .request_seq
            .unwrap_or_else(|| panic!("frame {} untagged", f.seq));
        assert!(
            seq_to_did.contains_key(&s),
            "frame {} tagged with unknown seq {s}",
            f.seq
        );
        per_seq.entry(s).or_default().push(f);
    }
    assert_eq!(per_seq.len(), dids.len());
    // Tags form contiguous runs in bus order (one exchange at a time).
    let runs = frames
        .windows(2)
        .filter(|w| w[0].request_seq != w[1].request_seq)
        .count();
    assert_eq!(runs + 1, dids.len());
    for (seq, fs) in &per_seq {
        let did = seq_to_did[seq].to_be_bytes();
        let sf = fs[0];
        assert_eq!(
            (sf.direction, sf.kind),
            (IsoTpDirection::Tx, IsoTpFrameKind::Single)
        );
        assert_eq!(
            &sf.data[1..4],
            &[0x22, did[0], did[1]],
            "request SF of seq {seq}"
        );
        let first_rx = fs
            .iter()
            .find(|f| f.direction == IsoTpDirection::Rx)
            .expect("response frame");
        let off = if first_rx.kind == IsoTpFrameKind::First {
            2
        } else {
            1
        };
        assert_eq!(
            &first_rx.data[off..off + 3],
            &[0x62, did[0], did[1]],
            "response of seq {seq}"
        );
    }
}

/// (c) background TesterPresent at a short interval: every `3E 80` frame is tagged with its
/// `keepaliveSent` event, whose origin is `keepalive`.
#[test]
fn tester_present_frames_tagged_with_keepalive_seq() {
    let _g = serial();
    let Some(rig) = Rig::start("dock_tp") else {
        return;
    };

    rig.engine
        .cmd_diag_set_tester_present(rig.cfg.clone(), true, Some(100))
        .expect("TP on");
    std::thread::sleep(Duration::from_millis(650));
    rig.engine
        .cmd_diag_set_tester_present(rig.cfg.clone(), false, None)
        .expect("TP off");
    // Let an in-flight keepalive finish its (suppressed) P2 wait.
    std::thread::sleep(Duration::from_millis(400));

    let events = rig.events();
    let ka: HashMap<u64, &ConversationEventDto> = events
        .iter()
        .filter(|e| e.kind == ConversationEventKind::KeepaliveSent)
        .map(|e| (e.seq, e))
        .collect();
    assert!(
        ka.len() >= 3,
        "expected several keepalives, got {}",
        ka.len()
    );
    for e in ka.values() {
        assert_eq!(e.origin, DiagOrigin::Keepalive);
        assert_eq!(e.bytes, vec![0x3E, 0x80]);
    }
    for e in events
        .iter()
        .filter(|e| e.request_seq.is_some_and(|s| ka.contains_key(&s)))
    {
        assert_eq!(
            e.origin,
            DiagOrigin::Keepalive,
            "event {} of a keepalive",
            e.seq
        );
    }

    let frames = rig.frames();
    let tp: Vec<&IsoTpFrameDto> = frames
        .iter()
        .filter(|f| {
            f.direction == IsoTpDirection::Tx && f.data.get(..3) == Some(&[0x02, 0x3E, 0x80])
        })
        .collect();
    assert_eq!(
        tp.len(),
        ka.len(),
        "one 3E 80 frame per keepaliveSent event"
    );
    let mut seen = std::collections::HashSet::new();
    for f in tp {
        let s = f
            .request_seq
            .unwrap_or_else(|| panic!("3E 80 frame {} untagged", f.seq));
        assert!(
            ka.contains_key(&s),
            "3E 80 frame {} tagged with non-keepalive seq {s}",
            f.seq
        );
        assert!(seen.insert(s), "two frames tagged with keepalive {s}");
    }
}

/// (d) origin passed explicitly (send_uds options, read_did / read_stored_dtcs arg) lands on the
/// request and response events; defaults are `did` / `dtc` / `other`.
#[test]
fn explicit_origin_on_request_and_response() {
    let _g = serial();
    let Some(rig) = Rig::start("dock_origin") else {
        return;
    };

    let opts = UdsRequestOptionsDto {
        origin: Some(DiagOrigin::Pids),
        ..Default::default()
    };
    let pids = rig
        .engine
        .cmd_diag_send_uds(rig.cfg.clone(), 0x22, None, vec![0xF1, 0x90], Some(opts))
        .expect("send_uds pids");
    let plain = rig
        .engine
        .cmd_diag_send_uds(rig.cfg.clone(), 0x22, None, vec![0xF1, 0x86], None)
        .expect("send_uds default");
    let panel = rig
        .engine
        .cmd_diag_read_did(rig.cfg.clone(), 0xF186, Some(DiagOrigin::Panel))
        .expect("read_did panel");
    rig.engine
        .cmd_diag_read_stored_dtcs(rig.cfg.clone(), None, None)
        .expect("dtcs default");
    rig.engine
        .cmd_diag_read_stored_dtcs(rig.cfg.clone(), Some(0xFF), Some(DiagOrigin::Flow))
        .expect("dtcs flow");

    let events = rig.events();
    let check = |seq: u64, want: DiagOrigin| {
        let req = request_event(&events, seq);
        assert_eq!(req.kind, ConversationEventKind::Request);
        assert_eq!(req.origin, want, "request {seq}");
        assert_eq!(
            final_event_of(&events, seq).origin,
            want,
            "response of {seq}"
        );
    };
    check(pids.transaction_seq, DiagOrigin::Pids);
    check(plain.transaction_seq, DiagOrigin::Other);
    check(panel.transaction_seq, DiagOrigin::Panel);
    let dtc_reqs: Vec<&ConversationEventDto> = events
        .iter()
        .filter(|e| e.kind == ConversationEventKind::Request && e.sid == Some(0x19))
        .collect();
    assert_eq!(dtc_reqs.len(), 2);
    check(dtc_reqs[0].seq, DiagOrigin::Dtc);
    check(dtc_reqs[1].seq, DiagOrigin::Flow);

    // Each request's frames carry its own seq.
    let frames = rig.frames();
    for e in events
        .iter()
        .filter(|e| e.kind == ConversationEventKind::Request)
    {
        let n = frames
            .iter()
            .filter(|f| f.request_seq == Some(e.seq))
            .count();
        assert!(n >= 2, "request {} has {n} tagged frames", e.seq);
    }
    assert!(frames.iter().all(|f| f.request_seq.is_some()));
}
