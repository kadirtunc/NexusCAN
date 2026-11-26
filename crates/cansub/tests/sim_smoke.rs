//! `cansub-sim` smoke tests over real TLS + HTTP/1.1 + WebSocket using raw rustls / tungstenite clients
//! (independent of the SDK client in `src/client`). Contract cansub-v1 §5, work package C2.
#![cfg(feature = "sim")]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cansub::sim::{Decoder, SimCloseKind, SimConfig, SimFrame, SimHandle, SimLog, SimSource};
use rustls::{
    ClientConfig, ClientConnection, RootCertStore, StreamOwned, SupportedProtocolVersion,
};
use rustls_pki_types::{CertificateDer, ServerName};
use tungstenite::{Bytes, Message, WebSocket};

type Tls = StreamOwned<ClientConnection, TcpStream>;

fn start(source: SimSource) -> SimHandle {
    SimHandle::start(SimConfig {
        source,
        ..SimConfig::default()
    })
    .expect("sim start")
}

fn client_cfg(root: &[u8], versions: &[&'static SupportedProtocolVersion]) -> Arc<ClientConfig> {
    let mut roots = RootCertStore::empty();
    roots.add(CertificateDer::from(root.to_vec())).unwrap();
    let cfg =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_protocol_versions(versions)
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
    Arc::new(cfg)
}

fn connect_with(
    sim: &SimHandle,
    versions: &[&'static SupportedProtocolVersion],
) -> std::io::Result<Tls> {
    let tcp = TcpStream::connect(sim.addr())?;
    tcp.set_read_timeout(Some(Duration::from_secs(5)))?;
    let name = ServerName::try_from("aabbccdd-usb.local").unwrap();
    let conn = ClientConnection::new(client_cfg(sim.root_ca_der(), versions), name)
        .map_err(std::io::Error::other)?;
    let mut s = StreamOwned::new(conn, tcp);
    while s.conn.is_handshaking() {
        s.conn.complete_io(&mut s.sock)?;
    }
    Ok(s)
}

fn connect(sim: &SimHandle) -> Tls {
    connect_with(sim, &[&rustls::version::TLS12]).expect("TLS 1.2 handshake")
}

fn http(sim: &SimHandle, method: &str, path: &str, body: &str) -> (u16, String) {
    let mut s = connect(sim);
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: aabbccdd-usb.local\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).unwrap();
    s.flush().unwrap();
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).unwrap();
    let text = String::from_utf8(raw).unwrap();
    let status = text[9..12].parse().unwrap();
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default();
    (status, body)
}

#[allow(clippy::result_large_err)] // tungstenite handshake error type
fn open_ws(
    sim: &SimHandle,
    ch: u8,
) -> Result<WebSocket<Tls>, tungstenite::HandshakeError<tungstenite::ClientHandshake<Tls>>> {
    let tls = connect(sim);
    tungstenite::client::client(format!("wss://aabbccdd-usb.local/api/can/{ch}/ws"), tls)
        .map(|(ws, _)| ws)
}

fn wait_for(mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    false
}

/// Reads binary messages for `dur`, decoding with the sim's own decoder.
fn collect(ws: &mut WebSocket<Tls>, dec: &mut Decoder, dur: Duration, out: &mut Vec<SimFrame>) {
    ws.get_ref()
        .sock
        .set_read_timeout(Some(Duration::from_millis(20)))
        .unwrap();
    let end = Instant::now() + dur;
    while Instant::now() < end {
        match ws.read() {
            Ok(Message::Binary(b)) => dec.push(&b, |f| out.push(*f)),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => panic!("ws read: {e}"),
        }
    }
}

#[test]
fn a_rest_version_over_tls12_with_sni() {
    let sim = start(SimSource::Silent);
    assert_eq!(http(&sim, "GET", "/api/version", ""), (200, "05.00".into()));
    let (st, body) = http(&sim, "GET", "/api/can", "");
    assert_eq!((st, body.as_str()), (200, "[1,2,3,4]"));
    let (st, body) = http(&sim, "GET", "/api/can/1", "");
    assert_eq!(st, 200);
    assert!(body.contains("\"state\":\"stopped\""), "{body}");
    assert_eq!(http(&sim, "GET", "/api/can/5", "").0, 404);
    let (st, body) = http(&sim, "GET", "/sim/log", "");
    assert_eq!(st, 200);
    let log: SimLog = serde_json::from_str(&body).unwrap();
    assert_eq!(log.requests.len(), 4, "/sim/log itself is not logged");
    assert_eq!(log.requests[0].path, "/api/version");
}

#[test]
fn b_tls13_only_client_is_rejected() {
    let sim = start(SimSource::Silent);
    assert!(connect_with(&sim, &[&rustls::version::TLS13]).is_err());
}

#[test]
fn c_d_e_websocket_rx_busy_and_listen_only_tx() {
    let sim = start(SimSource::Mock { fps: 1000 });
    let mut ws = open_ws(&sim, 1).expect("first WS");

    // (c) ≥ 300 frames in 0.5 s at 1000 fps, decoded by the sim's own decoder.
    let mut dec = Decoder::new();
    let mut frames = Vec::new();
    collect(&mut ws, &mut dec, Duration::from_millis(500), &mut frames);
    assert!(
        frames.len() >= 300,
        "got {} frames, stats {:?}",
        frames.len(),
        dec.stats
    );
    assert_eq!(dec.stats.crc_errors, 0);
    assert!(frames.iter().any(|f| f.fd) && frames.iter().any(|f| f.extended));
    // Clock not set via REST: timestamps start near 0.
    assert!(
        frames[0].timestamp < 5_000_000,
        "ts {}",
        frames[0].timestamp
    );

    // (d) second client on the same channel is rejected with 409 Conflict.
    match open_ws(&sim, 1) {
        Err(tungstenite::HandshakeError::Failure(tungstenite::Error::Http(resp))) => {
            assert_eq!(resp.status(), 409)
        }
        Err(e) => panic!("unexpected error {e}"),
        Ok(_) => panic!("second WS must be rejected"),
    }

    // (e) listen-only (default): TX is dropped and counted.
    let mut wire = Vec::new();
    cansub::sim::wire::encode_frames(&[SimFrame::classic(0x123, false, &[1, 2, 3])], &mut wire);
    ws.send(Message::Binary(Bytes::from(wire))).unwrap();
    assert!(wait_for(|| sim.log().dropped_tx[0] == 1), "{:?}", sim.log());
    assert_eq!(sim.log().received_tx, [0; 4]);

    // Graceful close is recorded as WsClose.
    ws.close(None).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        match ws.read() {
            Err(tungstenite::Error::ConnectionClosed) => break,
            Err(tungstenite::Error::Io(_)) | Ok(_) => {}
            Err(_) => break,
        }
    }
    assert!(
        wait_for(|| sim.log().ws_closes.contains(&(1, SimCloseKind::WsClose))),
        "{:?}",
        sim.log().ws_closes
    );
    let log = sim.log();
    assert!(log
        .requests
        .iter()
        .any(|r| r.method == "GET" && r.path == "/api/can/1/ws"));
}

#[test]
fn tx_ack_after_arm_and_delete_aborts() {
    let sim = start(SimSource::Silent);
    let phy = r#"{"listen_only":false,"auto_reset":true,"error_frames":false,"tx_ack_frames":true,
        "timing":{"brp":2,"seg1":63,"seg2":16,"sjw":16},"timing_data":{"brp":2,"seg1":15,"seg2":4,"sjw":4}}"#;
    assert_eq!(http(&sim, "PUT", "/api/can/2/phy", phy).0, 200);
    assert_eq!(
        http(&sim, "PUT", "/api/can/2/phy", r#"{"listen_only":true}"#).0,
        400,
        "all phy fields required"
    );
    assert_eq!(
        http(
            &sim,
            "PUT",
            "/api/time",
            r#"{"utc":"2026-01-01T00:00:00.000Z","rate_ppb":0}"#
        )
        .0,
        200
    );
    let mut ws = open_ws(&sim, 2).expect("WS");
    let mut wire = Vec::new();
    let tx = SimFrame::fd(0x1ABCDE, true, true, &[0x7E; 20]);
    cansub::sim::wire::encode_frames(&[tx], &mut wire);
    ws.send(Message::Binary(Bytes::from(wire))).unwrap();
    let mut dec = Decoder::new();
    let mut frames = Vec::new();
    collect(&mut ws, &mut dec, Duration::from_millis(200), &mut frames);
    assert_eq!(frames.len(), 1, "{frames:?}");
    let ack = frames[0];
    assert!(ack.tx_ack && ack.fd && ack.brs && ack.extended && ack.id == 0x1ABCDE);
    assert_eq!(ack.payload()[..20], [0x7E; 20]);
    assert!(
        ack.timestamp >= 365 * 86_400 * 1_000_000,
        "clock re-based by PUT /api/time"
    );
    assert_eq!(sim.log().received_tx[1], 1);

    assert_eq!(http(&sim, "DELETE", "/api/can/2/ws", "").0, 200);
    assert!(wait_for(|| sim
        .log()
        .ws_closes
        .contains(&(2, SimCloseKind::Delete))));
    assert_eq!(http(&sim, "DELETE", "/api/can/2/ws", "").0, 404);
    drop(ws);
    sim.stop();
}

/// Throughput probe (`cargo test --release --features sim --test sim_smoke -- --ignored`).
#[test]
#[ignore = "throughput probe; run in release"]
fn perf_mock_50k_fps_with_chaos_split() {
    let sim = SimHandle::start(SimConfig {
        source: SimSource::Mock { fps: 50_000 },
        chaos: cansub::sim::SimChaos {
            split_ws: true,
            ..Default::default()
        },
        ..SimConfig::default()
    })
    .unwrap();
    let mut ws = open_ws(&sim, 3).expect("WS");
    let mut dec = Decoder::new();
    let mut frames = Vec::with_capacity(200_000);
    collect(&mut ws, &mut dec, Duration::from_secs(2), &mut frames);
    assert!(
        frames.len() >= 90_000,
        "got {} frames in 2 s, stats {:?}",
        frames.len(),
        dec.stats
    );
    assert_eq!(dec.stats.crc_errors, 0);
}
