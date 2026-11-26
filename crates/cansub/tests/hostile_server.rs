//! C7 QA gate (contract cansub-v1 §2.6 / §3.3, attack matrix): hostile, non-sim servers.
//! TLS policy (TLS 1.3 / other suite / wrong CA → rejected), REST reader limits (huge
//! Content-Length, endless chunked body, chunk-size overflow, endless 1xx) and a 10 MB WebSocket
//! message (decoder overflow counted, no panic / OOM).
#![cfg(feature = "sim")]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use cansub::proto::Event;
use cansub::{ConnectOptions, Device, Error};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    Issuer, KeyPair, KeyUsagePurpose,
};
use rustls::crypto::{ring, CryptoProvider};
use rustls::SupportedCipherSuite;
use rustls::{ServerConfig, ServerConnection, StreamOwned, SupportedProtocolVersion};
use rustls_pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

const ID: &str = "aabbccdd";

struct Pki {
    root_der: Vec<u8>,
    chain: Vec<CertificateDer<'static>>,
    key: Vec<u8>,
}

fn pki() -> Pki {
    let ca_key = KeyPair::generate().unwrap();
    let mut ca = CertificateParams::new(Vec::<String>::new()).unwrap();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "hostile test CA");
    ca.distinguished_name = dn;
    ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let ca_cert = ca.self_signed(&ca_key).unwrap();
    let root_der = ca_cert.der().to_vec();
    let issuer = Issuer::new(ca, ca_key);
    let dev_key = KeyPair::generate().unwrap();
    let mut dev =
        CertificateParams::new(vec![format!("{ID}-usb.local"), format!("{ID}-eth.local")]).unwrap();
    dev.is_ca = IsCa::ExplicitNoCa;
    dev.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    dev.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let dev_cert = dev.signed_by(&dev_key, &issuer).unwrap();
    Pki {
        root_der,
        chain: vec![CertificateDer::from(dev_cert.der().to_vec())],
        key: dev_key.serialize_der(),
    }
}

fn server_cfg(
    p: &Pki,
    suites: Vec<SupportedCipherSuite>,
    versions: &[&'static SupportedProtocolVersion],
) -> Arc<ServerConfig> {
    let provider = CryptoProvider {
        cipher_suites: suites,
        ..ring::default_provider()
    };
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(p.key.clone()));
    Arc::new(
        ServerConfig::builder_with_provider(Arc::new(provider))
            .with_protocol_versions(versions)
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(p.chain.clone(), key)
            .unwrap(),
    )
}

fn device_cfg(p: &Pki) -> Arc<ServerConfig> {
    server_cfg(
        p,
        vec![ring::cipher_suite::TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256],
        &[&rustls::version::TLS12],
    )
}

type Tls = StreamOwned<ServerConnection, TcpStream>;

/// Accept loop; each connection runs `handler` on its own thread.
fn serve(cfg: Arc<ServerConfig>, handler: fn(&mut Tls)) -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap();
    thread::spawn(move || {
        for s in l.incoming().flatten() {
            let cfg = Arc::clone(&cfg);
            thread::spawn(move || {
                let _ = s.set_read_timeout(Some(Duration::from_secs(10)));
                let conn = ServerConnection::new(cfg).unwrap();
                let mut tls = StreamOwned::new(conn, s);
                handler(&mut tls);
            });
        }
    });
    format!("127.0.0.1:{}", addr.port())
}

/// Reads one request head; returns (method, path, raw head).
fn read_head(s: &mut Tls) -> Option<(String, String, String)> {
    let mut buf = Vec::new();
    let mut b = [0u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        match s.read(&mut b) {
            Ok(1) => buf.push(b[0]),
            _ => return None,
        }
        if buf.len() > 16 * 1024 {
            return None;
        }
    }
    let head = String::from_utf8_lossy(&buf).into_owned();
    if let Some(cl) = head.lines().find_map(|l| {
        l.to_ascii_lowercase()
            .strip_prefix("content-length:")
            .map(|v| v.trim().to_string())
    }) {
        let n: usize = cl.parse().unwrap_or(0);
        let mut body = vec![0u8; n];
        s.read_exact(&mut body).ok()?;
    }
    let mut it = head.split_whitespace();
    Some((it.next()?.to_string(), it.next()?.to_string(), head))
}

fn reply(s: &mut Tls, status: &str, ctype: &str, body: &str) {
    let r = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let _ = s.write_all(r.as_bytes());
    let _ = s.flush();
}

/// Answers the connect handshake (`/api/version`, `/api/info`, `/api/can`) like a device.
fn good_rest(s: &mut Tls, method: &str, path: &str) -> bool {
    match (method, path) {
        ("GET", "/api/version") => reply(s, "200 OK", "text/plain", "05.00"),
        ("GET", "/api/info") => reply(
            s,
            "200 OK",
            "application/json",
            &format!(r#"{{"id":"{ID}","hw_ver":"01.00","fw_ver":"01.00"}}"#),
        ),
        ("GET", "/api/can") => reply(s, "200 OK", "application/json", "[1,2]"),
        _ => return false,
    }
    true
}

fn opts(host: &str) -> ConnectOptions {
    ConnectOptions {
        host: host.to_string(),
        device_id: Some(ID.into()),
        timeout: Duration::from_secs(2),
        ..ConnectOptions::default()
    }
}

/// Runs `f` on a thread; `None` if it did not finish within `limit` (hang), `Some(Err)` on panic.
fn bounded<T: Send + 'static>(
    limit: Duration,
    f: impl FnOnce() -> T + Send + 'static,
) -> Option<thread::Result<T>> {
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        let _ = tx.send(r);
    });
    rx.recv_timeout(limit).ok()
}

fn expect_err(host: String, root: Vec<u8>, what: &str) -> Error {
    let t0 = Instant::now();
    let r = bounded(Duration::from_secs(8), move || {
        Device::connect_with_root(opts(&host), &root).map(|_| ())
    });
    let r = r.unwrap_or_else(|| panic!("{what}: client hung"));
    let r = r.unwrap_or_else(|_| panic!("{what}: client PANICKED"));
    let e = r.expect_err(what);
    eprintln!("{what}: rejected in {:?}: {e}", t0.elapsed());
    e
}

#[test]
fn tls13_only_server_is_rejected() {
    let p = pki();
    let cfg = server_cfg(
        &p,
        vec![ring::cipher_suite::TLS13_AES_128_GCM_SHA256],
        &[&rustls::version::TLS13],
    );
    let host = serve(cfg, |s| {
        let _ = read_head(s);
    });
    expect_err(host, p.root_der.clone(), "TLS 1.3-only server");
}

#[test]
fn other_tls12_suite_is_rejected() {
    let p = pki();
    let cfg = server_cfg(
        &p,
        vec![ring::cipher_suite::TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384],
        &[&rustls::version::TLS12],
    );
    let host = serve(cfg, |s| {
        let _ = read_head(s);
    });
    expect_err(host, p.root_der.clone(), "TLS 1.2 AES-256 suite server");
}

#[test]
fn wrong_ca_is_rejected() {
    let p = pki();
    let other = pki();
    let host = serve(device_cfg(&p), |s| {
        if let Some((m, path, _)) = read_head(s) {
            good_rest(s, &m, &path);
        }
    });
    let e = expect_err(host, other.root_der.clone(), "wrong CA");
    assert!(matches!(e, Error::Tls(_)), "{e:?}");
}

#[test]
fn control_good_server_connects() {
    let p = pki();
    let host = serve(device_cfg(&p), |s| {
        while let Some((m, path, _)) = read_head(s) {
            if !good_rest(s, &m, &path) {
                reply(s, "404 Not Found", "text/plain", "");
            }
        }
    });
    let d = Device::connect_with_root(opts(&host), &p.root_der).expect("control");
    assert_eq!(d.info().channels, 2);
}

#[test]
fn huge_content_length_is_refused_without_allocating() {
    let p = pki();
    let host = serve(device_cfg(&p), |s| {
        if read_head(s).is_some() {
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10000000000\r\n\r\n05.00");
            let _ = s.flush();
            thread::sleep(Duration::from_secs(3));
        }
    });
    expect_err(host, p.root_der.clone(), "Content-Length 10 GB");
}

#[test]
fn endless_chunked_body_is_bounded() {
    let p = pki();
    let host = serve(device_cfg(&p), |s| {
        if read_head(s).is_some() {
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
            let chunk = format!("1000\r\n{}\r\n", "a".repeat(0x1000));
            let t0 = Instant::now();
            while t0.elapsed() < Duration::from_secs(20) {
                if s.write_all(chunk.as_bytes()).is_err() {
                    break;
                }
            }
        }
    });
    expect_err(host, p.root_der.clone(), "endless chunked");
}

#[test]
fn chunk_size_overflow_does_not_panic() {
    let p = pki();
    let host = serve(device_cfg(&p), |s| {
        if read_head(s).is_some() {
            let _ = s.write_all(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\nFFFFFFFFFFFFFFFF\r\nxx\r\n0\r\n\r\n",
            );
            let _ = s.flush();
            thread::sleep(Duration::from_secs(3));
        }
    });
    expect_err(
        host,
        p.root_der.clone(),
        "chunk size usize::MAX after 5 bytes",
    );
}

#[test]
fn endless_interim_1xx_does_not_hang_forever() {
    let p = pki();
    let host = serve(device_cfg(&p), |s| {
        if read_head(s).is_some() {
            let t0 = Instant::now();
            while t0.elapsed() < Duration::from_secs(20) {
                if s.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(1));
            }
        }
    });
    expect_err(host, p.root_der.clone(), "endless 100 Continue");
}

/// Slowloris: every byte arrives well within the per-read timeout, but the response never ends.
/// The whole response is bounded by `ConnectOptions.timeout` (2 s here), C7.
#[test]
fn slow_drip_response_hits_total_deadline() {
    let p = pki();
    let host = serve(device_cfg(&p), |s| {
        if read_head(s).is_some() {
            let t0 = Instant::now();
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\n");
            while t0.elapsed() < Duration::from_secs(20) {
                if s.write_all(b"X: y\r\n").and_then(|()| s.flush()).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
    });
    let t0 = Instant::now();
    let e = expect_err(host, p.root_der.clone(), "slow drip head");
    assert!(
        t0.elapsed() < Duration::from_secs(4),
        "deadline not enforced: {:?}",
        t0.elapsed()
    );
    assert!(
        matches!(&e, Error::Io(io) if io.kind() == std::io::ErrorKind::TimedOut)
            || matches!(e, Error::Protocol(_)),
        "{e}"
    );
}

fn ws_server(s: &mut Tls, payload_len: usize) {
    while let Some((m, path, head)) = read_head(s) {
        if good_rest(s, &m, &path) {
            continue;
        }
        if path.ends_with("/ws") {
            let key = head
                .lines()
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.eq_ignore_ascii_case("sec-websocket-key")
                        .then(|| v.trim().to_string())
                })
                .unwrap_or_default();
            let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
            let _ = s.write_all(
                format!(
                    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
                )
                .as_bytes(),
            );
            let _ = s.flush();
            // WebSocket frame written by hand (server frames are unmasked).
            let mut msg = vec![0x55u8; payload_len];
            msg[0] = 0x7E; // opens an HDLC body that never closes within MAX_RX_HDLC
            let mut hdr = vec![0x82u8, 127];
            hdr.extend_from_slice(&(payload_len as u64).to_be_bytes());
            let _ = s.write_all(&hdr);
            let _ = s.write_all(&msg);
            // Then one valid tiny HDLC so we can prove the decoder recovered.
            let good = [0x7Eu8];
            let _ = s.write_all(&[0x82, good.len() as u8]);
            let _ = s.write_all(&good);
            let _ = s.flush();
            thread::sleep(Duration::from_secs(5));
            return;
        }
        reply(s, "404 Not Found", "text/plain", "");
    }
}

/// 512 KiB message (below the SDK's 1 MiB WebSocket limit) holding one unterminated HDLC body:
/// the decoder counts overflows and keeps hunting, no panic.
#[test]
fn ws_512kib_single_message_counts_overflow_no_panic() {
    let p = pki();
    let host = serve(device_cfg(&p), |s| ws_server(s, 512 * 1024));
    let root = p.root_der.clone();
    let r = bounded(Duration::from_secs(20), move || {
        let d = Device::connect_with_root(opts(&host), &root).unwrap();
        let mut ch = d.open(1).unwrap();
        let mut frames = 0;
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(3) {
            match ch.poll(Duration::from_millis(50), &mut |e| {
                if let Event::Frame(_) = e {
                    frames += 1
                }
            }) {
                Ok(_) => {}
                Err(e) => {
                    eprintln!("poll error: {e}");
                    break;
                }
            }
        }
        (frames, ch.stats())
    });
    let (frames, st) = r.expect("hung").expect("client PANICKED");
    eprintln!("512 KiB WS message: frames {frames} stats {st:?}");
    assert!(st.overflows >= 1, "{st:?}");
    // 512 KiB of 0x55 after one flag: one overflow per 4096 stored bytes, then hunting (garbage).
    assert_eq!(frames, 0);
}

/// 10 MB message: above the SDK's 1 MiB `max_message_size` / `max_frame_size` (C7) → error
/// from the frame header, before the payload is buffered; no panic.
#[test]
fn ws_10mb_message_is_refused_by_1mib_limit() {
    let p = pki();
    let host = serve(device_cfg(&p), |s| ws_server(s, 10 * 1024 * 1024));
    let root = p.root_der.clone();
    let r = bounded(Duration::from_secs(20), move || {
        let d = Device::connect_with_root(opts(&host), &root).unwrap();
        let mut ch = d.open(1).unwrap();
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(5) {
            if let Err(e) = ch.poll(Duration::from_millis(50), &mut |_| {}) {
                return Some(e.to_string());
            }
        }
        None
    });
    let r = r.expect("hung").expect("client PANICKED");
    eprintln!("10 MB WS message: {r:?}");
    assert!(r.is_some(), "10 MB message accepted (limit is 1 MiB)");
}

/// 80 MB message: far above the 1 MiB message limit → error, not OOM.
#[test]
fn ws_80mb_message_is_refused_by_size_limit() {
    let p = pki();
    let host = serve(device_cfg(&p), |s| ws_server(s, 80 * 1024 * 1024));
    let root = p.root_der.clone();
    let r = bounded(Duration::from_secs(30), move || {
        let d = Device::connect_with_root(opts(&host), &root).unwrap();
        let mut ch = d.open(1).unwrap();
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(5) {
            if let Err(e) = ch.poll(Duration::from_millis(50), &mut |_| {}) {
                return Some(e.to_string());
            }
        }
        None
    });
    let r = r.expect("hung").expect("client PANICKED");
    eprintln!("80 MB WS message: {r:?}");
    assert!(r.is_some(), "80 MB message accepted (limit is 1 MiB)");
}
