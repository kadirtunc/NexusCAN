//! Non-blocking background Cloud Bridge runtime consuming
//! `tokio::sync::broadcast::Receiver<BridgeTelemetryFrame>`.
//!
//! ### Zero Local Backpressure Guarantee
//! If the WAN connection stalls, drops, or backs up, [`BridgeClient`] absorbs
//! `broadcast::error::RecvError::Lagged(skipped)` by incrementing
//! `lagged_dropped_snapshots` and continuing from the freshest snapshot —
//! the local 60 FPS `NexusCAN` CAN/CAN-FD analyzer is never blocked for a single microsecond.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64_STD;
use base64::Engine;
use parking_lot::RwLock;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, mpsc, watch};

use crate::cadence::{CadenceDecimator, ExponentialBackoff};
use crate::pairing::DeviceApiToken;
use crate::protocol::{
    parse_inbound_cloud_message, BridgeHelloFrame, BridgeTargetHz, BridgeTelemetryFrame,
    CloudProtocolError, InboundCloudMessage, SchemaAckStatus,
};
use crate::sha256::sha256_hex;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Error)]
pub enum BridgeClientError {
    #[error("Transport I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Invalid WebSocket endpoint URL '{0}'")]
    InvalidEndpointUrl(String),

    #[error("WebSocket HTTP upgrade rejected with status {status}: {detail}")]
    UpgradeRejected { status: u16, detail: String },

    #[error("WebSocket connection closed by peer (code {code:?})")]
    ConnectionClosed { code: Option<u16> },

    #[error("Protocol error: {0}")]
    Protocol(#[from] CloudProtocolError),

    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("Schema upload callback failed: {0}")]
    SchemaUploadFailed(String),

    /// WP-10: plaintext transport to a non-loopback host (the URL is redacted).
    #[error("{msg} (refusing '{0}')", msg = crate::url_safety::TLS_NOT_SUPPORTED_MSG)]
    InsecureTransport(String),

    /// HIGH-04: inbound WebSocket frame larger than [`MAX_WS_FRAME_PAYLOAD`].
    #[error("WebSocket frame of {len} bytes exceeds the {max} byte limit", max = MAX_WS_FRAME_PAYLOAD)]
    FrameTooLarge { len: u64 },
}

/// HIGH-04: maximum accepted inbound WebSocket frame payload (checked before allocating).
pub const MAX_WS_FRAME_PAYLOAD: u64 = 1024 * 1024;

#[derive(Clone, Debug)]
pub struct BridgeClientConfig {
    pub endpoint_url: String,
    pub device_id: String,
    pub project_id: String,
    pub app_version: String,
    pub host_os: String,
    pub token: DeviceApiToken,
    pub preferred_active_hz: BridgeTargetHz,
    pub active_db_name: Option<String>,
    pub raw_database_bytes: Option<Vec<u8>>,
    pub backoff_base_ms: u64,
    pub backoff_max_ms: u64,
}

impl BridgeClientConfig {
    pub fn computed_schema_sha256(&self) -> Option<String> {
        self.raw_database_bytes.as_deref().map(sha256_hex)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BridgeClientMetrics {
    pub connected: bool,
    pub snapshots_received: u64,
    pub snapshots_forwarded: u64,
    pub snapshots_decimated: u64,
    pub lagged_dropped_snapshots: u64,
    pub reconnect_attempts: u64,
    pub schema_known_hits: u64,
    pub schema_uploads_triggered: u64,
    pub security_violations_rejected: u64,
    pub current_target_hz: BridgeTargetHz,
    pub capturing: bool,
    pub active_session_id: Option<String>,
    pub last_dbc_version_id: Option<String>,
}

impl Default for BridgeClientMetrics {
    fn default() -> Self {
        Self {
            connected: false,
            snapshots_received: 0,
            snapshots_forwarded: 0,
            snapshots_decimated: 0,
            lagged_dropped_snapshots: 0,
            reconnect_attempts: 0,
            schema_known_hits: 0,
            schema_uploads_triggered: 0,
            security_violations_rejected: 0,
            current_target_hz: BridgeTargetHz::Hz20,
            capturing: false,
            active_session_id: None,
            last_dbc_version_id: None,
        }
    }
}

/// Abstract duplex WebSocket frame transport (`NexusCAN` <-> `NexusCANCloud`).
pub trait BridgeTransport: Send {
    fn send_text<'a>(
        &'a mut self,
        payload: &'a str,
    ) -> BoxFuture<'a, Result<(), BridgeClientError>>;
    fn recv_text<'a>(&'a mut self) -> BoxFuture<'a, Result<Option<String>, BridgeClientError>>;
    fn close<'a>(&'a mut self) -> BoxFuture<'a, Result<(), BridgeClientError>>;
}

/// Factory establishing authenticated WebSocket sessions to `/api/bridge/ws`.
pub trait BridgeConnector: Send + Sync {
    fn connect<'a>(
        &'a self,
        config: &'a BridgeClientConfig,
    ) -> BoxFuture<'a, Result<Box<dyn BridgeTransport>, BridgeClientError>>;
}

/// Optional Plane-1 callback invoked when `SchemaAck` reports `upload_required`.
pub trait SchemaUploader: Send + Sync {
    fn upload_schema<'a>(
        &'a self,
        project_id: &'a str,
        db_name: &'a str,
        sha256_hex: &'a str,
        raw_bytes: &'a [u8],
    ) -> BoxFuture<'a, Result<String, String>>;
}

/// Handle controlling a spawned background [`BridgeClient`] task.
pub struct BridgeClientHandle {
    shutdown_tx: watch::Sender<bool>,
    metrics: Arc<RwLock<BridgeClientMetrics>>,
    join_handle: tokio::task::JoinHandle<()>,
}

impl BridgeClientHandle {
    pub fn metrics_snapshot(&self) -> BridgeClientMetrics {
        self.metrics.read().clone()
    }

    pub async fn shutdown(self) {
        let _ = self.shutdown_tx.send(true);
        let _ = self.join_handle.await;
    }
}

/// Spawns a non-blocking background bridge loop subscribed to `telemetry_rx`.
pub fn spawn_bridge_client(
    config: BridgeClientConfig,
    telemetry_rx: broadcast::Receiver<BridgeTelemetryFrame>,
    connector: Arc<dyn BridgeConnector>,
    schema_uploader: Option<Arc<dyn SchemaUploader>>,
) -> BridgeClientHandle {
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let initial_metrics = BridgeClientMetrics {
        current_target_hz: config.preferred_active_hz,
        ..BridgeClientMetrics::default()
    };
    let metrics = Arc::new(RwLock::new(initial_metrics));
    let metrics_clone = Arc::clone(&metrics);

    let join_handle = tokio::spawn(async move {
        run_bridge_supervisor_loop(
            config,
            telemetry_rx,
            connector,
            schema_uploader,
            metrics_clone,
            shutdown_rx,
        )
        .await;
    });

    BridgeClientHandle {
        shutdown_tx,
        metrics,
        join_handle,
    }
}

async fn run_bridge_supervisor_loop(
    config: BridgeClientConfig,
    mut telemetry_rx: broadcast::Receiver<BridgeTelemetryFrame>,
    connector: Arc<dyn BridgeConnector>,
    schema_uploader: Option<Arc<dyn SchemaUploader>>,
    metrics: Arc<RwLock<BridgeClientMetrics>>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let mut backoff = ExponentialBackoff::new(config.backoff_base_ms, config.backoff_max_ms);

    loop {
        if *shutdown_rx.borrow() {
            break;
        }

        match connector.connect(&config).await {
            Ok(mut transport) => {
                backoff.reset();
                {
                    let mut m = metrics.write();
                    m.connected = true;
                    m.current_target_hz = config.preferred_active_hz;
                }

                let session_outcome = run_single_connected_session(
                    &config,
                    &mut *transport,
                    &mut telemetry_rx,
                    schema_uploader.as_deref(),
                    &metrics,
                    &mut shutdown_rx,
                )
                .await;

                let _ = transport.close().await;
                {
                    let mut m = metrics.write();
                    m.connected = false;
                    m.capturing = false;
                    m.active_session_id = None;
                }

                if *shutdown_rx.borrow() || matches!(session_outcome, Ok(SessionExit::LocalClosed))
                {
                    break;
                }
                if matches!(session_outcome, Ok(SessionExit::RevokedStop)) {
                    // Device token revoked (4003) — stop reconnecting until re-paired!
                    break;
                }
            }
            Err(_) => {
                // Fall through to non-blocking drain + exponential backoff sleep
            }
        }

        {
            let mut m = metrics.write();
            m.reconnect_attempts += 1;
        }

        let wait_dur = backoff.next_delay();
        let sleep_fut = tokio::time::sleep(wait_dur);
        tokio::pin!(sleep_fut);

        // Drain broadcast channel during backoff so local sender never sees stale reader buildup
        loop {
            tokio::select! {
                _ = &mut sleep_fut => break,
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        return;
                    }
                }
                recv_res = telemetry_rx.recv() => {
                    match recv_res {
                        Ok(_) => {
                            let mut m = metrics.write();
                            m.snapshots_received += 1;
                            m.snapshots_decimated += 1;
                        }
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            let mut m = metrics.write();
                            m.lagged_dropped_snapshots += skipped;
                        }
                        Err(broadcast::error::RecvError::Closed) => return,
                    }
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SessionExit {
    Disconnected,
    RevokedStop,
    LocalClosed,
}

async fn run_single_connected_session(
    config: &BridgeClientConfig,
    transport: &mut dyn BridgeTransport,
    telemetry_rx: &mut broadcast::Receiver<BridgeTelemetryFrame>,
    schema_uploader: Option<&dyn SchemaUploader>,
    metrics: &Arc<RwLock<BridgeClientMetrics>>,
    shutdown_rx: &mut watch::Receiver<bool>,
) -> Result<SessionExit, BridgeClientError> {
    // Plane 1: Send BRIDGE_HELLO with SHA-256 schema fingerprint
    let schema_sha = config.computed_schema_sha256();
    let hello = BridgeHelloFrame::new(
        &config.device_id,
        &config.project_id,
        &config.app_version,
        &config.host_os,
        config.preferred_active_hz,
        schema_sha.clone(),
        config.active_db_name.clone(),
    );
    let hello_json = serde_json::to_string(&hello)?;
    transport.send_text(&hello_json).await?;

    let mut decimator = CadenceDecimator::new(config.preferred_active_hz);

    loop {
        tokio::select! {
            biased;

            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() {
                    return Ok(SessionExit::LocalClosed);
                }
            }

            inbound = transport.recv_text() => {
                match inbound {
                    Ok(Some(raw_text)) => {
                        match parse_inbound_cloud_message(&raw_text) {
                            Ok(InboundCloudMessage::SchemaAck(ack)) => {
                                match ack.status {
                                    SchemaAckStatus::Known => {
                                        let mut m = metrics.write();
                                        m.schema_known_hits += 1;
                                        m.last_dbc_version_id = ack.dbc_version_id;
                                    }
                                    SchemaAckStatus::UploadRequired => {
                                        if let (Some(uploader), Some(raw_bytes), Some(sha)) = (
                                            schema_uploader,
                                            config.raw_database_bytes.as_deref(),
                                            schema_sha.as_deref(),
                                        ) {
                                            let db_name = config
                                                .active_db_name
                                                .as_deref()
                                                .unwrap_or("active_database.dbc");
                                            let uploaded_id = uploader
                                                .upload_schema(
                                                    &config.project_id,
                                                    db_name,
                                                    sha,
                                                    raw_bytes,
                                                )
                                                .await
                                                .map_err(BridgeClientError::SchemaUploadFailed)?;
                                            let mut m = metrics.write();
                                            m.schema_uploads_triggered += 1;
                                            m.last_dbc_version_id = Some(uploaded_id);
                                        } else {
                                            let mut m = metrics.write();
                                            m.schema_uploads_triggered += 1;
                                        }
                                    }
                                }
                            }
                            Ok(InboundCloudMessage::RateControl(rc)) => {
                                decimator.set_target_hz(rc.target_hz);
                                let mut m = metrics.write();
                                m.current_target_hz = rc.target_hz;
                            }
                            Ok(InboundCloudMessage::CaptureStatus(cs)) => {
                                let mut m = metrics.write();
                                m.capturing = cs.capturing;
                                m.active_session_id = cs.active_session_id;
                            }
                            Ok(InboundCloudMessage::Ping { timestamp_ms }) => {
                                let pong = format!(r#"{{"type":"PONG","timestampMs":{timestamp_ms}}}"#);
                                transport.send_text(&pong).await?;
                            }
                            Ok(InboundCloudMessage::Pong { .. }) => {}
                            Ok(InboundCloudMessage::BridgeError { .. }) => {}
                            Err(CloudProtocolError::ForbiddenRemoteActuationCommand(_)) => {
                                // STRICT READ-ONLY CLOUD GUARD: Never execute, count violation!
                                let mut m = metrics.write();
                                m.security_violations_rejected += 1;
                            }
                            Err(_) => {
                                // Ignore unrecognized or malformed cloud control payloads safely
                            }
                        }
                    }
                    Ok(None) => return Ok(SessionExit::Disconnected),
                    Err(BridgeClientError::ConnectionClosed { code: Some(4003) }) => {
                        return Ok(SessionExit::RevokedStop);
                    }
                    Err(e) => return Err(e),
                }
            }

            frame_res = telemetry_rx.recv() => {
                match frame_res {
                    Ok(snapshot) => {
                        {
                            let mut m = metrics.write();
                            m.snapshots_received += 1;
                        }
                        if decimator.should_emit(snapshot.timestamp_us) {
                            let serialized = serde_json::to_string(&snapshot)?;
                            transport.send_text(&serialized).await?;
                            let mut m = metrics.write();
                            m.snapshots_forwarded += 1;
                        } else {
                            let mut m = metrics.write();
                            m.snapshots_decimated += 1;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        // Zero local blocking: drop stale WAN frames and resume immediately
                        let mut m = metrics.write();
                        m.lagged_dropped_snapshots += skipped;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        return Ok(SessionExit::LocalClosed);
                    }
                }
            }
        }
    }
}

/// Lightweight in-memory duplex channel transport for deterministic unit testing.
pub struct ChannelBridgeTransport {
    outbound_tx: mpsc::Sender<String>,
    inbound_rx: mpsc::Receiver<String>,
}

impl ChannelBridgeTransport {
    pub fn new(outbound_tx: mpsc::Sender<String>, inbound_rx: mpsc::Receiver<String>) -> Self {
        Self {
            outbound_tx,
            inbound_rx,
        }
    }
}

impl BridgeTransport for ChannelBridgeTransport {
    fn send_text<'a>(
        &'a mut self,
        payload: &'a str,
    ) -> BoxFuture<'a, Result<(), BridgeClientError>> {
        Box::pin(async move {
            self.outbound_tx
                .send(payload.to_string())
                .await
                .map_err(|_| BridgeClientError::ConnectionClosed { code: None })
        })
    }

    fn recv_text<'a>(&'a mut self) -> BoxFuture<'a, Result<Option<String>, BridgeClientError>> {
        Box::pin(async move { Ok(self.inbound_rx.recv().await) })
    }

    fn close<'a>(&'a mut self) -> BoxFuture<'a, Result<(), BridgeClientError>> {
        Box::pin(async move { Ok(()) })
    }
}

/// Built-in RFC 6455 `ws://` TCP WebSocket connector with `Authorization: Bearer nxc_tok_...`.
#[derive(Clone, Debug, Default)]
pub struct TcpWsConnector;

impl BridgeConnector for TcpWsConnector {
    fn connect<'a>(
        &'a self,
        config: &'a BridgeClientConfig,
    ) -> BoxFuture<'a, Result<Box<dyn BridgeTransport>, BridgeClientError>> {
        Box::pin(async move {
            let parsed = parse_ws_url(&config.endpoint_url)?;
            let mut stream = TcpStream::connect((parsed.host.as_str(), parsed.port)).await?;
            stream.set_nodelay(true)?;

            let ws_key = BASE64_STD.encode(*b"NexusCANCloudR1!");
            let req = format!(
                "GET {} HTTP/1.1\r\n\
                 Host: {}:{}\r\n\
                 Upgrade: websocket\r\n\
                 Connection: Upgrade\r\n\
                 Sec-WebSocket-Key: {}\r\n\
                 Sec-WebSocket-Version: 13\r\n\
                 Authorization: {}\r\n\r\n",
                parsed.path_and_query,
                parsed.host,
                parsed.port,
                ws_key,
                config.token.bearer_header_value()
            );
            stream.write_all(req.as_bytes()).await?;

            // Read HTTP Upgrade response headers up to \r\n\r\n
            let mut header_buf = Vec::with_capacity(512);
            let mut byte = [0u8; 1];
            while header_buf.len() < 8192 {
                let n = stream.read(&mut byte).await?;
                if n == 0 {
                    return Err(BridgeClientError::UpgradeRejected {
                        status: 0,
                        detail: "EOF during HTTP Upgrade".to_string(),
                    });
                }
                header_buf.push(byte[0]);
                if header_buf.ends_with(b"\r\n\r\n") {
                    break;
                }
            }

            let resp_text = String::from_utf8_lossy(&header_buf);
            let first_line = resp_text.lines().next().unwrap_or("");
            let status_code = first_line
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(500);

            if status_code != 101 {
                return Err(BridgeClientError::UpgradeRejected {
                    status: status_code,
                    detail: first_line.to_string(),
                });
            }

            let transport: Box<dyn BridgeTransport> = Box::new(TcpWsTransport {
                stream,
                mask_counter: 0x5A3C_9E17,
            });
            Ok(transport)
        })
    }
}

struct ParsedWsUrl {
    host: String,
    port: u16,
    path_and_query: String,
}

fn parse_ws_url(url: &str) -> Result<ParsedWsUrl, BridgeClientError> {
    let invalid = || BridgeClientError::InvalidEndpointUrl(crate::url_safety::redact_url(url));
    if url.starts_with("wss://") {
        return Err(BridgeClientError::InsecureTransport(
            crate::url_safety::redact_url(url),
        ));
    }
    let rest = url.strip_prefix("ws://").ok_or_else(invalid)?;
    let (authority, path_part) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/api/bridge/ws"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => {
            let parsed_port = p.parse::<u16>().map_err(|_| invalid())?;
            (h.to_string(), parsed_port)
        }
        None => (authority.to_string(), 80),
    };
    if host.is_empty() || authority.contains('@') {
        return Err(invalid());
    }
    // WP-10: no TLS yet -> plaintext only towards a loopback test server.
    if !crate::url_safety::is_loopback_host(&host) {
        return Err(BridgeClientError::InsecureTransport(
            crate::url_safety::redact_url(url),
        ));
    }
    Ok(ParsedWsUrl {
        host,
        port,
        path_and_query: path_part.to_string(),
    })
}

struct TcpWsTransport {
    stream: TcpStream,
    mask_counter: u32,
}

impl TcpWsTransport {
    fn next_mask(&mut self) -> [u8; 4] {
        self.mask_counter = self
            .mask_counter
            .wrapping_mul(1_664_525)
            .wrapping_add(1_013_904_223);
        self.mask_counter.to_le_bytes()
    }

    async fn write_masked_frame(
        &mut self,
        opcode: u8,
        payload: &[u8],
    ) -> Result<(), BridgeClientError> {
        let mask = self.next_mask();
        let len = payload.len();
        let mut header = Vec::with_capacity(14);
        header.push(0x80 | (opcode & 0x0f)); // FIN = 1

        if len <= 125 {
            header.push(0x80 | (len as u8));
        } else if len <= 65_535 {
            header.push(0x80 | 126);
            header.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            header.push(0x80 | 127);
            header.extend_from_slice(&(len as u64).to_be_bytes());
        }
        header.extend_from_slice(&mask);

        let mut masked_payload = Vec::with_capacity(len);
        for (i, &b) in payload.iter().enumerate() {
            masked_payload.push(b ^ mask[i & 3]);
        }

        self.stream.write_all(&header).await?;
        self.stream.write_all(&masked_payload).await?;
        Ok(())
    }
}

impl BridgeTransport for TcpWsTransport {
    fn send_text<'a>(
        &'a mut self,
        payload: &'a str,
    ) -> BoxFuture<'a, Result<(), BridgeClientError>> {
        Box::pin(async move { self.write_masked_frame(0x01, payload.as_bytes()).await })
    }

    fn recv_text<'a>(&'a mut self) -> BoxFuture<'a, Result<Option<String>, BridgeClientError>> {
        Box::pin(async move {
            loop {
                let mut hdr = [0u8; 2];
                match self.stream.read_exact(&mut hdr).await {
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
                    Err(e) => return Err(BridgeClientError::Io(e)),
                }

                let opcode = hdr[0] & 0x0f;
                let is_masked = (hdr[1] & 0x80) != 0;
                let len_code = u64::from(hdr[1] & 0x7f);

                let payload_len_u64 = if len_code <= 125 {
                    len_code
                } else if len_code == 126 {
                    let mut ext = [0u8; 2];
                    self.stream.read_exact(&mut ext).await?;
                    u64::from(u16::from_be_bytes(ext))
                } else {
                    let mut ext = [0u8; 8];
                    self.stream.read_exact(&mut ext).await?;
                    u64::from_be_bytes(ext)
                };
                // HIGH-04: reject oversized frames BEFORE allocating; close with 1009.
                if payload_len_u64 > MAX_WS_FRAME_PAYLOAD {
                    let _ = self.write_masked_frame(0x08, &1009u16.to_be_bytes()).await;
                    let _ = self.stream.shutdown().await;
                    return Err(BridgeClientError::FrameTooLarge {
                        len: payload_len_u64,
                    });
                }
                let payload_len = payload_len_u64 as usize;

                let mut mask = [0u8; 4];
                if is_masked {
                    self.stream.read_exact(&mut mask).await?;
                }

                let mut data = vec![0u8; payload_len];
                if payload_len > 0 {
                    self.stream.read_exact(&mut data).await?;
                }
                if is_masked {
                    for (i, slot) in data.iter_mut().enumerate() {
                        *slot ^= mask[i & 3];
                    }
                }

                match opcode {
                    0x01 => {
                        let s = String::from_utf8_lossy(&data).into_owned();
                        return Ok(Some(s));
                    }
                    0x08 => {
                        let close_code = if data.len() >= 2 {
                            Some(u16::from_be_bytes([data[0], data[1]]))
                        } else {
                            None
                        };
                        return Err(BridgeClientError::ConnectionClosed { code: close_code });
                    }
                    0x09 => {
                        // WS Ping -> reply WS Pong
                        self.write_masked_frame(0x0A, &data).await?;
                    }
                    _ => {
                        // Ignore Pong / continuation frames
                    }
                }
            }
        })
    }

    fn close<'a>(&'a mut self) -> BoxFuture<'a, Result<(), BridgeClientError>> {
        Box::pin(async move {
            let _ = self.write_masked_frame(0x08, &1000u16.to_be_bytes()).await;
            let _ = self.stream.shutdown().await;
            Ok(())
        })
    }
}

#[cfg(test)]
mod wp10_tests {
    use super::*;

    #[test]
    fn plaintext_ws_only_to_loopback_and_errors_are_redacted() {
        for ok in [
            "ws://127.0.0.1:3000/api/bridge/ws",
            "ws://localhost:3000/api/bridge/ws?token=nxc_tok_secret",
        ] {
            assert!(parse_ws_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "ws://cloud.nexuscan.io/api/bridge/ws?token=nxc_tok_secret",
            "ws://10.0.0.5:3000/x?token=nxc_tok_secret",
            "wss://cloud.nexuscan.io/api/bridge/ws?token=nxc_tok_secret",
        ] {
            let err = parse_ws_url(bad).err().expect("must be refused");
            let msg = err.to_string();
            assert!(
                matches!(err, BridgeClientError::InsecureTransport(_)),
                "{msg}"
            );
            assert!(msg.contains("TLS not yet supported"), "{msg}");
            assert!(!msg.contains("nxc_tok_secret"), "token leaked: {msg}");
        }
        let err = parse_ws_url("http://x?token=nxc_tok_secret")
            .err()
            .expect("bad scheme");
        assert!(!err.to_string().contains("nxc_tok_secret"));
        let err = parse_ws_url("ws://user:pw@127.0.0.1:1/")
            .err()
            .expect("credentials");
        assert!(!err.to_string().contains("pw@"), "{err}");
    }

    #[tokio::test]
    async fn oversized_inbound_frame_is_rejected_before_allocation() {
        use tokio::io::AsyncWriteExt as _;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.expect("accept");
            // Text frame claiming a 1 TiB payload (64-bit length), no payload follows.
            let mut hdr = vec![0x81u8, 127];
            hdr.extend_from_slice(&(1u64 << 40).to_be_bytes());
            sock.write_all(&hdr).await.expect("write");
            let mut buf = [0u8; 64];
            let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await;
            buf
        });
        let stream = TcpStream::connect(addr).await.expect("connect");
        let mut transport = TcpWsTransport {
            stream,
            mask_counter: 1,
        };
        let err = transport.recv_text().await.expect_err("must fail");
        assert!(
            matches!(err, BridgeClientError::FrameTooLarge { len } if len == 1 << 40),
            "{err}"
        );
        let close = server.await.expect("server");
        assert_eq!(close[0], 0x88, "client must send a Close frame");
    }
}
