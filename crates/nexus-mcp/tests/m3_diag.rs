//! MCP M3 backend-A: read-only diagnostics tools (`diag_session_info`, `diag_conversation`,
//! `diag_isotp_frames`, `diag_passive_discovery`). Redaction / selector / clamping cores are
//! unit-tested directly; the end-to-end test opens a session on mock0 through the ENGINE API
//! (as the user would from the HMI) and checks the MCP view of it (redacted, ≤16 KB).

use nexus_hal::pipeline::PipelineEngine;
use nexus_hal::registry::DriverRegistry;
use nexus_hal::storage::DataRoot;
use nexus_hal::{ChannelConfigDto, MOCK0_DEVICE_ID};
use nexus_mcp::tools_diag::{
    self as td, DiagConversationArgs, DiagIsoTpFramesArgs, DiagPassiveDiscoveryArgs,
    DiagSessionInfoArgs, FrameView, SessionSelector,
};
use nexus_mcp::McpConfig;
use rmcp::model::{CallToolRequestParams, ClientConfig};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const CAP: usize = 16 * 1024;

fn engine(tag: &str) -> Arc<PipelineEngine> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let root = DataRoot::under(std::env::temp_dir().join(format!(
        "nexus-mcp-m3diag-{tag}-{}-{nanos}",
        std::process::id()
    )));
    root.ensure_dirs().unwrap();
    Arc::new(PipelineEngine::with_data_root(
        DriverRegistry::with_builtin_drivers(),
        root,
    ))
}

fn len(v: &Value) -> usize {
    serde_json::to_string(v).unwrap().len()
}

fn sel(bus: Option<u8>, req: Option<&str>, resp: Option<&str>) -> SessionSelector {
    SessionSelector {
        bus_id: bus,
        request_id: req.map(str::to_string),
        response_id: resp.map(str::to_string),
        is_extended: None,
    }
}

// ─── Redaction cores ────────────────────────────────────────────────────────

#[test]
fn redact_pdu_hides_security_access_and_authentication_data() {
    // sendKey request / positive response / authentication: keep SID + subFunction only.
    assert_eq!(
        td::redact_pdu(Some(0x27), &[0x27, 0x02, 0xDE, 0xAD, 0xBE, 0xEF]),
        2
    );
    assert_eq!(
        td::redact_pdu(Some(0x27), &[0x67, 0x01, 0x11, 0x22, 0x33]),
        2
    );
    assert_eq!(td::redact_pdu(Some(0x29), &[0x29, 0x03, 0x01, 0x02]), 2);
    assert_eq!(td::redact_pdu(None, &[0x69, 0x03, 0xAA]), 2);
    // SID known from the request even when the byte layout is odd.
    assert_eq!(td::redact_pdu(Some(0x29), &[0x00, 0x01, 0x02]), 2);
    // Negative responses carry no secret; other services untouched.
    assert_eq!(td::redact_pdu(Some(0x27), &[0x7F, 0x27, 0x35]), 3);
    assert_eq!(td::redact_pdu(Some(0x22), &[0x62, 0xF1, 0x90, 0x41]), 4);
    assert_eq!(td::redact_pdu(Some(0x27), &[]), 0);
    let (hex, red) = td::redacted_hex(&[0x27, 0x02, 0xDE, 0xAD], 2);
    assert_eq!(hex, "2702<redacted>");
    assert!(red);
    let (hex, red) = td::redacted_hex(&[0x22, 0xF1], 2);
    assert_eq!(hex, "22F1");
    assert!(!red);
}

fn fv(data: &[u8], tx: bool, rs: Option<u64>) -> FrameView<'_> {
    FrameView {
        can_id: if tx { 0x7E0 } else { 0x7E8 },
        is_extended: false,
        tx,
        fd: false,
        data,
        request_seq: rs,
    }
}

#[test]
fn redact_isotp_frames_by_sid_seq_and_stream() {
    let sf_key = [0x06, 0x27, 0x02, 0xDE, 0xAD, 0xBE, 0xEF, 0xAA];
    let sf_did = [0x03, 0x22, 0xF1, 0x90, 0xAA, 0xAA, 0xAA, 0xAA];
    let neg = [0x03, 0x7F, 0x27, 0x35, 0xAA, 0xAA, 0xAA, 0xAA];
    // Multi-frame seed response 67 01 + 10 seed bytes: FF + CF, no request_seq on the CF.
    let ff = [0x10, 0x0C, 0x67, 0x01, 0x01, 0x02, 0x03, 0x04];
    let fc = [0x30, 0x00, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA];
    let cf = [0x21, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0xAA];
    // Frame of a transaction known sensitive only from the conversation log.
    let cf_seq = [0x22, 0x0B, 0x0C, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA];
    let frames = [
        fv(&sf_key, true, Some(1)),
        fv(&sf_did, true, Some(3)),
        fv(&neg, false, Some(1)),
        fv(&ff, false, None),
        fv(&fc, true, None),
        fv(&cf, false, None),
        fv(&cf_seq, false, Some(9)),
    ];
    let known: HashSet<u64> = [9].into_iter().collect();
    let vis = td::redact_isotp_frames(&frames, 0, &known);
    assert_eq!(vis, vec![3, 8, 8, 4, 8, 1, 1]);

    // Extended addressing: address byte before the PCI shifts everything by one.
    let ext = [0xF1, 0x06, 0x27, 0x02, 0xDE, 0xAD, 0xBE, 0xEF];
    let vis = td::redact_isotp_frames(&[fv(&ext, true, None)], 1, &HashSet::new());
    assert_eq!(vis, vec![4]);

    // CAN-FD single frame with escape length (PCI 0x00, len byte) and 64-byte payload.
    let mut fd = vec![0x00, 0x3E, 0x29, 0x05];
    fd.extend(std::iter::repeat_n(0x55, 60));
    let mut f = fv(&fd, true, Some(4));
    f.fd = true;
    let vis = td::redact_isotp_frames(&[f], 0, &HashSet::new());
    assert_eq!(vis, vec![4]);

    // A CF sharing request_seq with a sensitive SF on the same page is redacted too.
    let cf2 = [0x21, 0x99, 0x98, 0x97, 0x96, 0x95, 0x94, 0x93];
    let ff_req = [0x10, 0x10, 0x29, 0x01, 0x01, 0x02, 0x03, 0x04];
    let vis = td::redact_isotp_frames(
        &[fv(&ff_req, true, Some(7)), fv(&cf2, true, Some(7))],
        0,
        &HashSet::new(),
    );
    assert_eq!(vis, vec![4, 1]);
}

// ─── Selector ───────────────────────────────────────────────────────────────

#[test]
fn selector_ambiguity_none_and_candidate_cap() {
    let addr = vec![
        (0u8, 0x7E0u32, 0x7E8u32, false),
        (0, 0x7E1, 0x7E9, false),
        (1, 0x7E0, 0x7E8, false),
        (0, 0x18DA_10F1, 0x18DA_F110, true),
    ];
    assert_eq!(
        td::select_one(&addr, &sel(Some(0), Some("0x7E0"), None)).unwrap(),
        0
    );
    assert_eq!(
        td::select_one(&addr, &sel(None, None, Some("0x7E9"))).unwrap(),
        1
    );
    assert_eq!(
        td::select_one(&addr, &sel(None, Some("0x18DA10F1"), None)).unwrap(),
        3
    );
    // 8-hex-digit spelling = extended: does not match the 11-bit 0x7E0 sessions.
    let e = td::select_one(&addr, &sel(None, Some("0x000007E0"), None)).unwrap_err();
    assert!(e.0.contains("no diagnostic session matches"), "{}", e.0);
    // Ambiguous: 0x7E0 on bus 0 and bus 1.
    let e = td::select_one(&addr, &sel(None, Some("0x7E0"), None)).unwrap_err();
    assert!(e.0.contains("2 diagnostic sessions match"), "{}", e.0);
    assert!(e.0.contains("bus 1 0x7E0->0x7E8"), "{}", e.0);
    // None: lists known sessions.
    let e = td::select_one(&addr, &sel(Some(5), None, None)).unwrap_err();
    assert!(
        e.0.contains("known sessions") && e.0.contains("0x7E1"),
        "{}",
        e.0
    );
    // Empty engine list.
    let e = td::select_one(&[], &sel(None, None, None)).unwrap_err();
    assert!(e.0.contains("never opens"), "{}", e.0);
    // Candidate list capped at 8 (+N more), error clipped.
    let many: Vec<_> = (0..20u32)
        .map(|i| (0u8, 0x700 + i, 0x780 + i, false))
        .collect();
    let e = td::select_one(&many, &sel(Some(0), None, None)).unwrap_err();
    assert!(e.0.contains("(+12 more)"), "{}", e.0);
    assert!(e.0.chars().count() <= 513);
    // Huge / invalid id input: clipped error.
    let e = td::select_one(&addr, &sel(None, Some(&"z".repeat(10_000)), None)).unwrap_err();
    assert!(e.0.chars().count() <= 513);
}

// ─── Engine-backed (no session) ─────────────────────────────────────────────

#[test]
fn empty_engine_responses() {
    let e = engine("empty");
    let v = td::diag_session_info(&e, &DiagSessionInfoArgs::default()).unwrap();
    assert_eq!(v["count"], json!(0));
    assert_eq!(v["sessions"], json!([]));
    assert!(v["message"].as_str().unwrap().contains("Diagnostics view"));
    let err = td::diag_session_info(
        &e,
        &DiagSessionInfoArgs {
            selector: sel(None, Some("0x7E0"), None),
        },
    )
    .unwrap_err();
    assert!(err.0.contains("never opens"));
    assert!(td::diag_conversation(&e, &DiagConversationArgs::default()).is_err());
    assert!(td::diag_isotp_frames(&e, &DiagIsoTpFramesArgs::default()).is_err());
    let v = td::diag_passive_discovery(&e, &DiagPassiveDiscoveryArgs::default()).unwrap();
    assert_eq!(v["scans"], json!([]));
    assert!(v["message"].is_string());
    let v = td::diag_passive_discovery(&e, &DiagPassiveDiscoveryArgs { bus_id: Some(3) }).unwrap();
    assert_eq!(v["scans"][0]["running"], json!(false));
    assert!(
        e.diag_passive_bus_ids().is_empty(),
        "snapshot must not start a scan"
    );
    assert!(
        e.diag_session_list().is_empty(),
        "no tool may open a session"
    );
}

// ─── End-to-end on mock0 ────────────────────────────────────────────────────

fn open_sessions(e: &PipelineEngine) {
    e.cmd_connect_bus(
        MOCK0_DEVICE_ID.to_string(),
        ChannelConfigDto {
            bus_id: 0,
            listen_only: false,
            ..ChannelConfigDto::default()
        },
    )
    .expect("connect mock0");
    e.cmd_arm_active_bus(0, true).expect("arm");
    for (req, resp) in [(0x7E0u32, 0x7E8u32), (0x7E1, 0x7E9)] {
        let cfg = serde_json::from_value(json!({
            "busId": 0, "requestId": req, "responseId": resp, "isExtendedId": false
        }))
        .unwrap();
        e.cmd_diag_open_session(cfg).expect("open session");
    }
    let cfg = || {
        serde_json::from_value(json!({
            "busId": 0, "requestId": 0x7E0, "responseId": 0x7E8, "isExtendedId": false
        }))
        .unwrap()
    };
    let opts = || serde_json::from_value(json!({ "timeoutMs": 60 })).ok();
    // No ECU on mock0: each request logs request + timeout (user actions, not MCP).
    let _ = e.cmd_diag_send_uds(
        cfg(),
        0x27,
        Some(0x02),
        vec![0xDE, 0xAD, 0xBE, 0xEF],
        opts(),
    );
    let _ = e.cmd_diag_send_uds(cfg(), 0x22, None, vec![0xF1, 0x90], opts());
}

#[test]
fn e2e_session_conversation_isotp_redacted_and_clamped() {
    let e = engine("e2e");
    open_sessions(&e);
    let before = e.diag_session_list();
    assert_eq!(before.len(), 2);

    let v = td::diag_session_info(&e, &DiagSessionInfoArgs::default()).unwrap();
    assert_eq!(v["count"], json!(2));
    assert_eq!(v["sessions"][0]["request_id"], json!("0x7E0"));
    let v = td::diag_session_info(
        &e,
        &DiagSessionInfoArgs {
            selector: sel(Some(0), Some("0x7E1"), None),
        },
    )
    .unwrap();
    assert_eq!(v["session"]["response_id"], json!("0x7E9"));

    // Two sessions: an empty selector is ambiguous.
    let err = td::diag_conversation(&e, &DiagConversationArgs::default()).unwrap_err();
    assert!(err.0.contains("2 diagnostic sessions match"), "{}", err.0);

    let args = DiagConversationArgs {
        selector: sel(None, Some("0x7E0"), None),
        since_seq: None,
        limit: Some(10_000),
    };
    let v = td::diag_conversation(&e, &args).unwrap();
    assert_eq!(v["limit"], json!(td::MAX_CONVERSATION_LIMIT));
    assert_eq!(v["limit_clamped"], json!(true));
    assert!(len(&v) <= CAP);
    let text = v.to_string();
    assert!(!text.contains("DEADBEEF"), "{text}");
    let events = v["events"].as_array().unwrap();
    let req27 = events
        .iter()
        .find(|ev| ev["kind"] == "request" && ev["sid"] == "0x27")
        .expect("0x27 request logged");
    assert_eq!(req27["bytes_hex"], json!("2702<redacted>"));
    assert_eq!(req27["redacted"], json!(true));
    let req22 = events
        .iter()
        .find(|ev| ev["kind"] == "request" && ev["sid"] == "0x22")
        .expect("0x22 request logged");
    assert_eq!(req22["bytes_hex"], json!("22F190"));
    assert_eq!(v["redacted"], json!(true));

    // Paging: limit 1 → next_since_seq advances gap-free.
    let mut since = 0;
    let mut seen = Vec::new();
    for _ in 0..50 {
        let p = td::diag_conversation(
            &e,
            &DiagConversationArgs {
                selector: sel(None, Some("0x7E0"), None),
                since_seq: Some(since),
                limit: Some(1),
            },
        )
        .unwrap();
        let evs = p["events"].as_array().unwrap();
        if evs.is_empty() {
            break;
        }
        seen.push(evs[0]["seq"].as_u64().unwrap());
        since = p["next_since_seq"].as_u64().unwrap();
    }
    let all: Vec<u64> = events
        .iter()
        .map(|ev| ev["seq"].as_u64().unwrap())
        .collect();
    assert_eq!(seen, all);

    let v = td::diag_isotp_frames(
        &e,
        &DiagIsoTpFramesArgs {
            selector: sel(Some(0), Some("0x7E0"), Some("0x7E8")),
            since_seq: None,
            limit: Some(0),
        },
    )
    .unwrap();
    assert_eq!(v["limit"], json!(1));
    let v = td::diag_isotp_frames(
        &e,
        &DiagIsoTpFramesArgs {
            selector: sel(Some(0), Some("0x7E0"), None),
            since_seq: None,
            limit: Some(500),
        },
    )
    .unwrap();
    assert_eq!(v["limit"], json!(td::MAX_ISOTP_LIMIT));
    assert!(len(&v) <= CAP);
    let text = v.to_string();
    assert!(!text.contains("DEADBEEF"), "{text}");
    let f = v["frames"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["data_hex"].as_str().unwrap_or("").starts_with("062702"))
        .unwrap_or_else(|| panic!("0x27 TX frame captured: {text}"));
    assert_eq!(f["data_hex"], json!("062702<redacted>"));
    assert_eq!(f["redacted"], json!(true));

    // Read-only: nothing opened / closed by the tools.
    let after = e.diag_session_list();
    assert_eq!(after.len(), 2);
    assert!(e.diag_passive_bus_ids().is_empty());
}

/// All four tools registered read-only; responses ≤ 16 KB incl. error paths over HTTP.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn e2e_diag_tools_over_mcp() {
    let e = engine("http");
    let handle = nexus_mcp::start(
        Arc::clone(&e),
        McpConfig { port: 0 },
        &tokio::runtime::Handle::current(),
    )
    .unwrap();
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(handle.endpoint_url())
            .auth_header(handle.token().to_string()),
    );
    let client = ClientConfig::default().serve(transport).await.unwrap();
    let tools = client.list_all_tools().await.unwrap();
    for name in [
        "diag_session_info",
        "diag_conversation",
        "diag_isotp_frames",
        "diag_passive_discovery",
    ] {
        let t = tools
            .iter()
            .find(|t| t.name == name)
            .unwrap_or_else(|| panic!("{name} missing"));
        assert_eq!(
            t.annotations.as_ref().and_then(|a| a.read_only_hint),
            Some(true),
            "{name}"
        );
        assert!(
            t.description.as_deref().unwrap_or("").contains("does NOT"),
            "{name} must say what it does NOT do"
        );
    }
    let call = |name: &'static str, args: Value| {
        let client = &client;
        async move {
            let mut p = CallToolRequestParams::new(name);
            if let Value::Object(m) = args {
                p = p.with_arguments(m);
            }
            let r = client.call_tool(p).await.unwrap();
            let text = &r.content[0].as_text().unwrap().text;
            assert!(text.len() <= CAP);
            (
                r.is_error == Some(true),
                serde_json::from_str::<Value>(text).unwrap(),
            )
        }
    };
    let (err, v) = call("diag_session_info", json!({})).await;
    assert!(!err && v["count"] == json!(0), "{v}");
    let (err, v) = call(
        "diag_conversation",
        json!({ "request_id": "x".repeat(50_000) }),
    )
    .await;
    assert!(err, "{v}");
    assert!(v["error"].as_str().unwrap().chars().count() <= 513);
    let (err, _) = call("diag_isotp_frames", json!({ "limit": -5 })).await;
    assert!(err);
    let (err, v) = call("diag_passive_discovery", json!({})).await;
    assert!(!err && v["scans"] == json!([]), "{v}");
    handle.shutdown().await;
}

/// A Consecutive Frame whose First Frame fell on an earlier page is hidden (fail closed).
#[test]
fn orphan_consecutive_frame_is_redacted() {
    use nexus_mcp::tools_diag::{redact_isotp_frames, FrameView};
    use std::collections::HashSet;
    let cf = [0x21u8, 0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03];
    let frames = [FrameView {
        can_id: 0x7E0,
        is_extended: false,
        tx: true,
        fd: false,
        data: &cf,
        request_seq: None,
    }];
    let vis = redact_isotp_frames(&frames, 0, &HashSet::new());
    assert_eq!(vis, vec![1], "orphan CF must keep only its PCI byte");
}
