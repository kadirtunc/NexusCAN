//! Rock-solid RFC 6455 `ws://` Cloud Bridge Client, Multiplexed Frame Coalescer,
//! Chronological Trace Decimation Accumulator (`<= 320` frames), 2s RTT Heartbeat,
//! and Runtime Read-Only Cloud Safety Guard.

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STD;
use base64::Engine as _;
use nexus_cloud::{
    parse_inbound_cloud_message, sha256_hex, BridgeHelloFrame, BridgeTargetHz,
    BridgeTelemetryFrame, BusHealthWireDto, BusStateKind, CadenceDecimator,
    ChronologicalFrameWireDto, CloudProtocolError, CycleHealthKind, ExponentialBackoff,
    FrameTelemetryWireDto, InboundCloudMessage, LiveSignalWireDto, SchemaAckStatus,
};
use nexus_hal::{BusHealthDto, ChronologicalFrameDto, FrameTelemetryDto, TelemetrySnapshotDto};
use nexus_netdb::DatabaseSchemaDto;
use serde::Serialize;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, watch};
use tokio::time::MissedTickBehavior;

use crate::cli::CLI_VERSION;
use crate::config::{detect_host_os_label, EffectiveAgentConfig};
use crate::web_status::SharedAgentState;

pub const MAX_CHRONOLOGICAL_ACCUM: usize = 320;
pub const DEFAULT_BACKOFF_BASE_MS: u64 = 1_000;
pub const DEFAULT_BACKOFF_MAX_MS: u64 = 15_000;
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_WS_UPGRADE_HEADER_BYTES: usize = 16 * 1024;
const MAX_WS_FRAME_PAYLOAD_BYTES: usize = 8 * 1024 * 1024; // 8 MiB safety cap

#[derive(Clone, Debug)]
pub struct LoadedEdgeDatabase {
    pub db_name: String,
    pub schema: DatabaseSchemaDto,
    pub schema_sha256: String,
}

impl LoadedEdgeDatabase {
    pub fn new(db_name: String, schema: DatabaseSchemaDto, raw_bytes: &[u8]) -> Self {
        Self {
            db_name,
            schema,
            schema_sha256: sha256_hex(raw_bytes),
        }
    }
}

#[derive(Debug, Error)]
pub enum WsBridgeError {
    /// The URL is always redacted (`nexus_cloud::redact_url`): no token / credentials.
    #[error("Unsupported or invalid WebSocket URL '{0}' (expected ws://host[:port]/path)")]
    InvalidWsUrl(String),

    /// WP-10: plaintext WebSocket to a non-loopback host (URL redacted).
    #[error("{msg} (refusing '{0}')", msg = nexus_cloud::TLS_NOT_SUPPORTED_MSG)]
    InsecureTransport(String),

    #[error("WebSocket TCP connect/upgrade timed out")]
    ConnectTimeout,

    #[error("WebSocket I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("WebSocket HTTP Upgrade rejected with status {status}: {detail}")]
    UpgradeRejected { status: u16, detail: String },

    #[error("WebSocket frame exceeded 8 MiB safety cap")]
    FrameTooLarge,

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutboundSchemaUpdateEnvelope<'a> {
    #[serde(rename = "type")]
    msg_type: &'static str,
    active_db_name: &'a str,
    schema: &'a DatabaseSchemaDto,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutboundTelemetrySnapshotEnvelope<'a> {
    #[serde(rename = "type")]
    msg_type: &'static str,
    snapshot: &'a BridgeTelemetryFrame,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutboundPingEnvelope {
    #[serde(rename = "type")]
    msg_type: &'static str,
    timestamp_ms: u64,
    latency_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutboundPongEnvelope {
    #[serde(rename = "type")]
    msg_type: &'static str,
    timestamp_ms: u64,
}

#[derive(Debug)]
enum WsRecvEvent {
    Text(String),
    Closed { code: Option<u16>, reason: String },
    Eof,
}

/// Buffered RFC 6455 WebSocket client preserving any post-`\r\n\r\n` bytes arriving
/// in the HTTP `101 Switching Protocols` TCP segment and supporting fragmented text frames,
/// `Ping` -> `Pong` auto-replies, and 2-byte big-endian `Close` code extraction.
struct BufferedWsClient {
    stream: TcpStream,
    read_buf: Vec<u8>,
    read_pos: usize,
    fragment_buf: Vec<u8>,
    in_text_fragment: bool,
    mask_state: u32,
}

struct ParsedWsEndpoint {
    connect_host: String,
    host_header: String,
    port: u16,
    path_and_query: String,
}

fn parse_ws_endpoint(url: &str) -> Result<ParsedWsEndpoint, WsBridgeError> {
    if url.trim().starts_with("wss://") {
        return Err(WsBridgeError::InsecureTransport(nexus_cloud::redact_url(
            url,
        )));
    }
    let rest = url
        .trim()
        .strip_prefix("ws://")
        .ok_or_else(|| WsBridgeError::InvalidWsUrl(nexus_cloud::redact_url(url)))?;

    let (authority, path_part) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/api/bridge/ws"),
    };

    if authority.is_empty() {
        return Err(WsBridgeError::InvalidWsUrl(nexus_cloud::redact_url(url)));
    }

    let (connect_host, port) = if authority.starts_with('[') {
        let end_bracket = authority
            .find(']')
            .ok_or_else(|| WsBridgeError::InvalidWsUrl(nexus_cloud::redact_url(url)))?;
        let ipv6_host = &authority[1..end_bracket];
        let after = &authority[end_bracket + 1..];
        let p = if let Some(port_str) = after.strip_prefix(':') {
            port_str
                .parse::<u16>()
                .map_err(|_| WsBridgeError::InvalidWsUrl(nexus_cloud::redact_url(url)))?
        } else if after.is_empty() {
            80
        } else {
            return Err(WsBridgeError::InvalidWsUrl(nexus_cloud::redact_url(url)));
        };
        (ipv6_host.to_string(), p)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p_str)) => {
                let p = p_str
                    .parse::<u16>()
                    .map_err(|_| WsBridgeError::InvalidWsUrl(nexus_cloud::redact_url(url)))?;
                (h.to_string(), p)
            }
            None => (authority.to_string(), 80),
        }
    };

    if connect_host.is_empty() || authority.contains('@') {
        return Err(WsBridgeError::InvalidWsUrl(nexus_cloud::redact_url(url)));
    }
    // WP-10: no TLS yet -> plaintext only towards a loopback test server.
    if !nexus_cloud::is_loopback_host(&connect_host) {
        return Err(WsBridgeError::InsecureTransport(nexus_cloud::redact_url(
            url,
        )));
    }

    Ok(ParsedWsEndpoint {
        connect_host,
        host_header: authority.to_string(),
        port,
        path_and_query: path_part.to_string(),
    })
}

impl BufferedWsClient {
    async fn connect(ws_url: &str, bearer_header: &str) -> Result<Self, WsBridgeError> {
        let parsed = parse_ws_endpoint(ws_url)?;
        tokio::time::timeout(WS_CONNECT_TIMEOUT, async move {
            let mut stream =
                TcpStream::connect((parsed.connect_host.as_str(), parsed.port)).await?;
            stream.set_nodelay(true)?;

            let nonce_seed = unix_now_ms();
            let mut nonce_bytes = [0u8; 16];
            nonce_bytes[..8].copy_from_slice(&nonce_seed.to_le_bytes());
            nonce_bytes[8..].copy_from_slice(b"NexusCLI");
            let ws_key = BASE64_STD.encode(nonce_bytes);

            let upgrade_req = format!(
                "GET {} HTTP/1.1\r\n\
                 Host: {}\r\n\
                 Upgrade: websocket\r\n\
                 Connection: Upgrade\r\n\
                 Sec-WebSocket-Key: {}\r\n\
                 Sec-WebSocket-Version: 13\r\n\
                 User-Agent: nexuscan-cli/{}\r\n\
                 Authorization: {}\r\n\r\n",
                parsed.path_and_query, parsed.host_header, ws_key, CLI_VERSION, bearer_header,
            );
            stream.write_all(upgrade_req.as_bytes()).await?;

            // Read HTTP Upgrade response into `read_buf` while preserving any trailing WS frame bytes!
            let mut read_buf = Vec::with_capacity(1024);
            let mut scratch = [0u8; 1024];
            let header_end = loop {
                if let Some(pos) = read_buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break pos;
                }
                if read_buf.len() >= MAX_WS_UPGRADE_HEADER_BYTES {
                    return Err(WsBridgeError::UpgradeRejected {
                        status: 0,
                        detail: "HTTP Upgrade headers exceeded 16 KiB".to_string(),
                    });
                }
                let n = stream.read(&mut scratch).await?;
                if n == 0 {
                    return Err(WsBridgeError::UpgradeRejected {
                        status: 0,
                        detail: "EOF while reading HTTP Upgrade response".to_string(),
                    });
                }
                read_buf.extend_from_slice(&scratch[..n]);
            };

            let header_text = String::from_utf8_lossy(&read_buf[..header_end]);
            let first_line = header_text.lines().next().unwrap_or("");
            let status = first_line
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(500);

            if status != 101 {
                return Err(WsBridgeError::UpgradeRejected {
                    status,
                    detail: first_line.to_string(),
                });
            }

            let read_pos = header_end + 4;
            let mask_seed = (nonce_seed as u32) ^ 0xA5C3_6E29;

            Ok(Self {
                stream,
                read_buf,
                read_pos,
                fragment_buf: Vec::new(),
                in_text_fragment: false,
                mask_state: if mask_seed == 0 {
                    0x5A3C_9E17
                } else {
                    mask_seed
                },
            })
        })
        .await
        .map_err(|_| WsBridgeError::ConnectTimeout)?
    }

    fn next_mask(&mut self) -> [u8; 4] {
        self.mask_state = self
            .mask_state
            .wrapping_mul(1_664_525)
            .wrapping_add(1_013_904_223);
        self.mask_state.to_le_bytes()
    }

    async fn read_exact_buffered(&mut self, dst: &mut [u8]) -> Result<bool, std::io::Error> {
        let mut written = 0usize;

        while written < dst.len() {
            let buffered_avail = self.read_buf.len().saturating_sub(self.read_pos);
            if buffered_avail > 0 {
                let to_copy = buffered_avail.min(dst.len() - written);
                dst[written..written + to_copy]
                    .copy_from_slice(&self.read_buf[self.read_pos..self.read_pos + to_copy]);
                self.read_pos += to_copy;
                written += to_copy;

                if self.read_pos == self.read_buf.len() {
                    self.read_buf.clear();
                    self.read_pos = 0;
                }
                continue;
            }

            let mut chunk = [0u8; 4096];
            let n = self.stream.read(&mut chunk).await?;
            if n == 0 {
                if written == 0 {
                    return Ok(false);
                }
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "EOF mid WebSocket frame",
                ));
            }
            self.read_buf.extend_from_slice(&chunk[..n]);
        }

        Ok(true)
    }

    async fn send_masked_frame(&mut self, opcode: u8, payload: &[u8]) -> Result<(), WsBridgeError> {
        let mask = self.next_mask();
        let len = payload.len();
        let mut frame = Vec::with_capacity(14 + len);
        frame.push(0x80 | (opcode & 0x0F)); // FIN = 1

        if len <= 125 {
            frame.push(0x80 | (len as u8));
        } else if len <= 65_535 {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(len as u64).to_be_bytes());
        }

        frame.extend_from_slice(&mask);
        for (i, &b) in payload.iter().enumerate() {
            frame.push(b ^ mask[i & 3]);
        }

        self.stream.write_all(&frame).await?;
        Ok(())
    }

    async fn send_text(&mut self, text: &str) -> Result<(), WsBridgeError> {
        self.send_masked_frame(0x01, text.as_bytes()).await
    }

    async fn recv_event(&mut self) -> Result<WsRecvEvent, WsBridgeError> {
        loop {
            let mut hdr = [0u8; 2];
            if !self.read_exact_buffered(&mut hdr).await? {
                return Ok(WsRecvEvent::Eof);
            }

            let fin = (hdr[0] & 0x80) != 0;
            let opcode = hdr[0] & 0x0F;
            let is_masked = (hdr[1] & 0x80) != 0;
            let len_code = u64::from(hdr[1] & 0x7F);

            let payload_len: usize = if len_code <= 125 {
                len_code as usize
            } else if len_code == 126 {
                let mut ext = [0u8; 2];
                if !self.read_exact_buffered(&mut ext).await? {
                    return Ok(WsRecvEvent::Eof);
                }
                u16::from_be_bytes(ext) as usize
            } else {
                let mut ext = [0u8; 8];
                if !self.read_exact_buffered(&mut ext).await? {
                    return Ok(WsRecvEvent::Eof);
                }
                let raw_u64 = u64::from_be_bytes(ext);
                if raw_u64 > MAX_WS_FRAME_PAYLOAD_BYTES as u64 {
                    return Err(WsBridgeError::FrameTooLarge);
                }
                raw_u64 as usize
            };

            if payload_len > MAX_WS_FRAME_PAYLOAD_BYTES {
                return Err(WsBridgeError::FrameTooLarge);
            }

            let mut mask = [0u8; 4];
            if is_masked && !self.read_exact_buffered(&mut mask).await? {
                return Ok(WsRecvEvent::Eof);
            }

            let mut payload = vec![0u8; payload_len];
            if payload_len > 0 && !self.read_exact_buffered(&mut payload).await? {
                return Ok(WsRecvEvent::Eof);
            }

            if is_masked {
                for (i, slot) in payload.iter_mut().enumerate() {
                    *slot ^= mask[i & 3];
                }
            }

            match opcode {
                0x01 => {
                    if fin {
                        self.fragment_buf.clear();
                        self.in_text_fragment = false;
                        return Ok(WsRecvEvent::Text(
                            String::from_utf8_lossy(&payload).into_owned(),
                        ));
                    } else {
                        self.fragment_buf.clear();
                        self.fragment_buf.extend_from_slice(&payload);
                        self.in_text_fragment = true;
                    }
                }
                0x00 => {
                    if self.in_text_fragment {
                        if self.fragment_buf.len().saturating_add(payload.len())
                            > MAX_WS_FRAME_PAYLOAD_BYTES
                        {
                            self.fragment_buf.clear();
                            self.in_text_fragment = false;
                            return Err(WsBridgeError::FrameTooLarge);
                        }
                        self.fragment_buf.extend_from_slice(&payload);
                        if fin {
                            self.in_text_fragment = false;
                            let text = String::from_utf8_lossy(&self.fragment_buf).into_owned();
                            self.fragment_buf.clear();
                            return Ok(WsRecvEvent::Text(text));
                        }
                    }
                }
                0x08 => {
                    let (code, reason) = if payload.len() >= 2 {
                        let c = u16::from_be_bytes([payload[0], payload[1]]);
                        let r = String::from_utf8_lossy(&payload[2..]).into_owned();
                        (Some(c), r)
                    } else {
                        (None, String::new())
                    };
                    let echo_code = code.unwrap_or(1000).to_be_bytes();
                    let _ = self.send_masked_frame(0x08, &echo_code).await;
                    return Ok(WsRecvEvent::Closed { code, reason });
                }
                0x09 => {
                    // RFC 6455 Ping -> immediate Pong with identical application data
                    self.send_masked_frame(0x0A, &payload).await?;
                }
                0x0A | 0x02 => {
                    // Ignore WS-level Pong or Binary frames
                }
                _ => {}
            }
        }
    }

    async fn close_gracefully(&mut self, code: u16) {
        let _ = self.send_masked_frame(0x08, &code.to_be_bytes()).await;
        let _ = self.stream.shutdown().await;
    }
}

/// Converts and coalesces `nexus_hal::TelemetrySnapshotDto` frames so multiplexed branches
/// sharing `(bus_id, message_key)` merge signals oldest -> newest by `last_timestamp_us` into a
/// single authoritative `FrameTelemetryWireDto` per `(bus_id, message_key)`.
pub fn coalesce_and_convert_snapshot(
    snap: &TelemetrySnapshotDto,
    chronological_frames: Vec<ChronologicalFrameWireDto>,
) -> BridgeTelemetryFrame {
    let buses: Vec<BusHealthWireDto> = snap.buses.iter().map(convert_bus_health).collect();

    // Preserve deterministic order of first appearance while grouping by (bus_id, message_key)
    let mut group_order: Vec<(u8, String)> = Vec::with_capacity(snap.frames.len());
    let mut grouped: BTreeMap<(u8, String), Vec<&FrameTelemetryDto>> = BTreeMap::new();

    for frame in &snap.frames {
        let key = (frame.bus_id, frame.message_key.clone());
        grouped
            .entry(key.clone())
            .or_insert_with(|| {
                group_order.push(key);
                Vec::with_capacity(1)
            })
            .push(frame);
    }

    let mut coalesced_frames = Vec::with_capacity(group_order.len());
    let mut total_decoded_signals = 0u32;

    for key in group_order {
        let Some(mut entries) = grouped.remove(&key) else {
            continue;
        };

        let wire_frame = if entries.len() == 1 {
            convert_single_frame_telemetry(entries[0])
        } else {
            // Sort oldest -> newest by last_timestamp_us
            entries.sort_by_key(|e| e.last_timestamp_us);
            let newest = *entries.last().expect("non-empty mux group");
            let newest_ts = newest.last_timestamp_us;

            let mut merged_signals: BTreeMap<u32, LiveSignalWireDto> = BTreeMap::new();
            let mut total_rx_count = 0u64;
            let mut combined_changed_lo = 0u32;
            let mut combined_changed_hi = 0u32;

            for (idx, branch) in entries.iter().enumerate() {
                let is_newest_branch =
                    idx + 1 == entries.len() && branch.last_timestamp_us == newest_ts;
                total_rx_count = total_rx_count.saturating_add(branch.rx_count);
                combined_changed_lo |= branch.changed_bytes_lo;
                combined_changed_hi |= branch.changed_bytes_hi;

                for sig in &branch.signals {
                    merged_signals.insert(
                        sig.signal_id,
                        LiveSignalWireDto {
                            signal_id: sig.signal_id,
                            raw_int: sig.raw_int,
                            physical_value: sanitize_f64(sig.physical_value),
                            active_in_last_frame: is_newest_branch && sig.active_in_last_frame,
                            out_of_range: sig.out_of_range,
                            age_ms: f64::from(sig.age_ms),
                        },
                    );
                }
            }

            let active_mux_switches: BTreeMap<String, i64> = newest
                .active_mux_switches
                .iter()
                .map(|(k, &v)| (k.clone(), v))
                .collect();

            FrameTelemetryWireDto {
                bus_id: newest.bus_id,
                message_key: newest.message_key.clone(),
                arb_id: newest.arb_id,
                is_extended: newest.is_extended,
                is_fd: newest.is_fd,
                is_brs: newest.is_brs,
                is_tx: false, // Read-Only Listen-Only invariant
                has_hw_timestamp: newest.has_hw_timestamp,
                dlc: newest.dlc.min(64),
                raw_bytes: newest.raw_bytes.clone(),
                changed_bytes_lo: combined_changed_lo,
                changed_bytes_hi: combined_changed_hi,
                last_timestamp_us: newest.last_timestamp_us,
                cycle_ms: sanitize_nonneg_f64(newest.cycle_ms),
                frequency_hz: sanitize_nonneg_f64(newest.frequency_hz),
                cycle_health: map_cycle_health(&newest.cycle_health),
                rx_count: total_rx_count,
                active_mux_switches,
                signals: merged_signals.into_values().collect(),
            }
        };

        total_decoded_signals =
            total_decoded_signals.saturating_add(wire_frame.signals.len() as u32);
        coalesced_frames.push(wire_frame);
    }

    BridgeTelemetryFrame {
        seq: snap.seq,
        timestamp_us: snap.timestamp_us,
        fps_rx: sanitize_nonneg_f64(snap.fps_rx),
        fps_tx: 0.0,
        estimated_bus_load_pct: sanitize_nonneg_f64(snap.estimated_bus_load_pct).min(100.0),
        total_frames_rx: snap.total_frames_rx,
        total_frames_tx: 0,
        dropped_frames: snap.dropped_frames,
        active_ids_count: coalesced_frames.len() as u32,
        decoded_signals_count: total_decoded_signals,
        tx_panic_latched: snap.tx_panic_latched,
        buses,
        frames: coalesced_frames,
        recent_chronological: chronological_frames,
    }
}

fn convert_bus_health(b: &BusHealthDto) -> BusHealthWireDto {
    assert!(
        b.listen_only && !b.tx_armed,
        "SAFETY INVARIANT VIOLATION: headless agent bus {} must always have listen_only=true and tx_armed=false",
        b.bus_id
    );
    BusHealthWireDto {
        bus_id: b.bus_id,
        device_id: b.device_id.clone(),
        channel_name: b.channel_name.clone(),
        connected: b.connected,
        listen_only: true,
        tx_armed: false,
        bus_state: map_bus_state(&b.bus_state),
        tx_error_count: b.tx_error_count,
        rx_error_count: b.rx_error_count,
    }
}

fn convert_single_frame_telemetry(f: &FrameTelemetryDto) -> FrameTelemetryWireDto {
    let active_mux_switches: BTreeMap<String, i64> = f
        .active_mux_switches
        .iter()
        .map(|(k, &v)| (k.clone(), v))
        .collect();

    let signals = f
        .signals
        .iter()
        .map(|s| LiveSignalWireDto {
            signal_id: s.signal_id,
            raw_int: s.raw_int,
            physical_value: sanitize_f64(s.physical_value),
            active_in_last_frame: s.active_in_last_frame,
            out_of_range: s.out_of_range,
            age_ms: f64::from(s.age_ms),
        })
        .collect();

    FrameTelemetryWireDto {
        bus_id: f.bus_id,
        message_key: f.message_key.clone(),
        arb_id: f.arb_id,
        is_extended: f.is_extended,
        is_fd: f.is_fd,
        is_brs: f.is_brs,
        is_tx: false,
        has_hw_timestamp: f.has_hw_timestamp,
        dlc: f.dlc.min(64),
        raw_bytes: f.raw_bytes.clone(),
        changed_bytes_lo: f.changed_bytes_lo,
        changed_bytes_hi: f.changed_bytes_hi,
        last_timestamp_us: f.last_timestamp_us,
        cycle_ms: sanitize_nonneg_f64(f.cycle_ms),
        frequency_hz: sanitize_nonneg_f64(f.frequency_hz),
        cycle_health: map_cycle_health(&f.cycle_health),
        rx_count: f.rx_count,
        active_mux_switches,
        signals,
    }
}

fn push_chronological_capped(
    ring: &mut VecDeque<ChronologicalFrameWireDto>,
    incoming: &[ChronologicalFrameDto],
) {
    for c in incoming {
        if ring.len() >= MAX_CHRONOLOGICAL_ACCUM {
            ring.pop_front();
        }
        ring.push_back(ChronologicalFrameWireDto {
            timestamp_us: c.timestamp_us,
            bus_id: c.bus_id,
            message_key: c.message_key.clone(),
            arb_id: c.arb_id,
            is_extended: c.is_extended,
            is_fd: c.is_fd,
            is_tx: false,
            dlc: c.dlc.min(64),
            raw_bytes: c.raw_bytes.clone(),
        });
    }
}

fn update_local_can_metrics(state: &SharedAgentState, snap: &TelemetrySnapshotDto) {
    let coalesced = coalesce_and_convert_snapshot(snap, Vec::new());
    state.update_live_telemetry(coalesced);
}

fn map_bus_state(raw: &str) -> BusStateKind {
    match raw {
        "active" => BusStateKind::Active,
        "warning" => BusStateKind::Warning,
        "passive" => BusStateKind::Passive,
        "busOff" => BusStateKind::BusOff,
        _ => BusStateKind::Disconnected,
    }
}

fn map_cycle_health(raw: &str) -> CycleHealthKind {
    match raw {
        "nominal" => CycleHealthKind::Nominal,
        "jitterWarning" => CycleHealthKind::JitterWarning,
        "timeout" => CycleHealthKind::Timeout,
        _ => CycleHealthKind::Unconfigured,
    }
}

#[inline]
fn sanitize_f64(v: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

#[inline]
fn sanitize_nonneg_f64(v: f64) -> f64 {
    if v.is_finite() && v > 0.0 {
        v
    } else {
        0.0
    }
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

/// Terminal outcome of [`run_ws_bridge_supervisor`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WsSupervisorOutcome {
    /// Clean local shutdown requested via `shutdown_rx` or closed pipeline channel.
    Shutdown,
    /// Permanent token rejection/revocation (`4003` / `4001` WS close or HTTP `401` / `403` upgrade).
    RevokedForbidden4003,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SessionExitReason {
    ShutdownRequested,
    RevokedForbidden4003,
    DisconnectedRetry,
}

/// Runs the supervised WebSocket bridge loop with `ExponentialBackoff::new(1_000, 15_000)`
/// until `shutdown_rx` signals `true` (`WsSupervisorOutcome::Shutdown`) or the device token
/// is permanently rejected/revoked (`WsSupervisorOutcome::RevokedForbidden4003`).
pub async fn run_ws_bridge_supervisor(
    config: EffectiveAgentConfig,
    loaded_db: Option<LoadedEdgeDatabase>,
    mut snapshot_rx: broadcast::Receiver<TelemetrySnapshotDto>,
    shared_state: Arc<SharedAgentState>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> WsSupervisorOutcome {
    let mut backoff = ExponentialBackoff::new(DEFAULT_BACKOFF_BASE_MS, DEFAULT_BACKOFF_MAX_MS);
    let connect_url = config.authenticated_ws_url();
    let bearer_header = config.token.bearer_header_value();

    loop {
        if *shutdown_rx.borrow() {
            return WsSupervisorOutcome::Shutdown;
        }

        match BufferedWsClient::connect(&connect_url, &bearer_header).await {
            Ok(mut ws) => {
                let connected_at = Instant::now();
                shared_state.write_metrics(|m| {
                    m.cloud_connected = true;
                    m.target_hz = BridgeTargetHz::Hz20.as_u8();
                });

                let outcome = run_single_ws_session(
                    &config,
                    loaded_db.as_ref(),
                    &mut ws,
                    &mut snapshot_rx,
                    &shared_state,
                    &mut shutdown_rx,
                )
                .await;

                let stayed_healthy = connected_at.elapsed() >= Duration::from_secs(2);
                shared_state.write_metrics(|m| {
                    m.cloud_connected = false;
                    m.capturing = false;
                    m.active_session_id = None;
                });

                match outcome {
                    Ok(SessionExitReason::ShutdownRequested) => {
                        ws.close_gracefully(1000).await;
                        return WsSupervisorOutcome::Shutdown;
                    }
                    Ok(SessionExitReason::RevokedForbidden4003) => {
                        eprintln!(
                            "[ERROR] Cloud bridge closed connection with 4003/4001 (revoked or forbidden device token). Stopping reconnects."
                        );
                        shared_state.write_metrics(|m| {
                            m.revoked_stopped = true;
                        });
                        return WsSupervisorOutcome::RevokedForbidden4003;
                    }
                    Ok(SessionExitReason::DisconnectedRetry) | Err(_) => {
                        if let Err(err) = &outcome {
                            eprintln!("[WARN] Cloud bridge session ended: {err}");
                        }
                        ws.close_gracefully(1000).await;
                        if stayed_healthy {
                            backoff.reset();
                        }
                    }
                }
            }
            Err(WsBridgeError::UpgradeRejected {
                status: status @ (401 | 403),
                detail,
            }) => {
                eprintln!(
                    "[ERROR] Cloud bridge rejected HTTP Upgrade with {status} ({detail}). Device token is invalid or revoked; stopping reconnects."
                );
                shared_state.write_metrics(|m| {
                    m.revoked_stopped = true;
                });
                return WsSupervisorOutcome::RevokedForbidden4003;
            }
            Err(err) => {
                eprintln!("[WARN] Cloud bridge connect attempt failed: {err}");
            }
        }

        if *shutdown_rx.borrow() {
            return WsSupervisorOutcome::Shutdown;
        }

        shared_state.write_metrics(|m| {
            m.reconnect_attempts = m.reconnect_attempts.saturating_add(1);
        });

        let wait_delay = backoff.next_delay();
        let sleep_fut = tokio::time::sleep(wait_delay);
        tokio::pin!(sleep_fut);

        // Keep draining local 60Hz snapshots during backoff so `/api/live` & `/api/status` stay live
        loop {
            tokio::select! {
                _ = &mut sleep_fut => break,
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        return WsSupervisorOutcome::Shutdown;
                    }
                }
                snap_res = snapshot_rx.recv() => {
                    match snap_res {
                        Ok(snap) => update_local_can_metrics(&shared_state, &snap),
                        Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => {
                            return WsSupervisorOutcome::Shutdown;
                        }
                    }
                }
            }
        }
    }
}

async fn run_single_ws_session(
    config: &EffectiveAgentConfig,
    loaded_db: Option<&LoadedEdgeDatabase>,
    ws: &mut BufferedWsClient,
    snapshot_rx: &mut broadcast::Receiver<TelemetrySnapshotDto>,
    shared_state: &Arc<SharedAgentState>,
    shutdown_rx: &mut watch::Receiver<bool>,
) -> Result<SessionExitReason, WsBridgeError> {
    // 1. Conditional Plane-1 BRIDGE_HELLO:
    // ONLY send BRIDGE_HELLO when an explicit `device_id` (non-empty and != "auto") is configured!
    if let Some(explicit_dev_id) = config.explicit_device_id() {
        let hello = BridgeHelloFrame::new(
            explicit_dev_id,
            &config.project_id,
            CLI_VERSION,
            detect_host_os_label(),
            BridgeTargetHz::Hz20,
            loaded_db.map(|d| d.schema_sha256.clone()),
            loaded_db.map(|d| d.db_name.clone()),
        );
        let hello_json = serde_json::to_string(&hello)?;
        ws.send_text(&hello_json).await?;
    }

    // 2. Immediate Plane-1 Schema Push (`BRIDGE_SCHEMA_UPDATE`) if a DBC/KCD is active
    if let Some(db) = loaded_db {
        let schema_msg = OutboundSchemaUpdateEnvelope {
            msg_type: "BRIDGE_SCHEMA_UPDATE",
            active_db_name: &db.db_name,
            schema: &db.schema,
        };
        let schema_json = serde_json::to_string(&schema_msg)?;
        ws.send_text(&schema_json).await?;
    }

    let mut decimator = CadenceDecimator::new(BridgeTargetHz::Hz20);
    let mut chrono_accum: VecDeque<ChronologicalFrameWireDto> =
        VecDeque::with_capacity(MAX_CHRONOLOGICAL_ACCUM);
    let mut last_rtt_ms: u64 = 0;

    let mut ping_interval = tokio::time::interval(Duration::from_secs(2));
    ping_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // Consume initial tick at t=0 so first periodic PING fires at +2s
    ping_interval.tick().await;

    loop {
        tokio::select! {
            biased;

            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() {
                    return Ok(SessionExitReason::ShutdownRequested);
                }
            }

            ws_ev = ws.recv_event() => {
                match ws_ev? {
                    WsRecvEvent::Text(raw_text) => {
                        handle_inbound_text_frame(
                            &raw_text,
                            ws,
                            &mut decimator,
                            &mut last_rtt_ms,
                            shared_state,
                        )
                        .await?;
                    }
                    WsRecvEvent::Closed {
                        code: Some(code @ (4001 | 4003)),
                        reason,
                    } => {
                        if !reason.is_empty() {
                            eprintln!("[ERROR] Cloud bridge {code} close reason: {reason}");
                        }
                        return Ok(SessionExitReason::RevokedForbidden4003);
                    }
                    WsRecvEvent::Closed { code, reason } => {
                        if code.is_some() || !reason.is_empty() {
                            eprintln!(
                                "[INFO] Cloud bridge WebSocket closed (code={code:?}, reason='{reason}')"
                            );
                        }
                        return Ok(SessionExitReason::DisconnectedRetry);
                    }
                    WsRecvEvent::Eof => {
                        return Ok(SessionExitReason::DisconnectedRetry);
                    }
                }
            }

            _ = ping_interval.tick() => {
                let ping_msg = OutboundPingEnvelope {
                    msg_type: "PING",
                    timestamp_ms: unix_now_ms(),
                    latency_ms: last_rtt_ms,
                };
                let ping_json = serde_json::to_string(&ping_msg)?;
                ws.send_text(&ping_json).await?;
            }

            snap_res = snapshot_rx.recv() => {
                match snap_res {
                    Ok(snap) => {
                        push_chronological_capped(&mut chrono_accum, &snap.recent_chronological);

                        if decimator.should_emit(snap.timestamp_us) {
                            let drained_chrono: Vec<ChronologicalFrameWireDto> =
                                chrono_accum.drain(..).collect();
                            let bridge_frame = coalesce_and_convert_snapshot(&snap, drained_chrono);

                            let env = OutboundTelemetrySnapshotEnvelope {
                                msg_type: "TELEMETRY_SNAPSHOT",
                                snapshot: &bridge_frame,
                            };
                            let payload = serde_json::to_string(&env)?;
                            let send_res = ws.send_text(&payload).await;

                            shared_state.update_live_telemetry(bridge_frame);
                            send_res?;

                            shared_state.write_metrics(|m| {
                                m.snapshots_forwarded = m.snapshots_forwarded.saturating_add(1);
                            });
                        } else {
                            update_local_can_metrics(shared_state, &snap);
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_skipped)) => {
                        // Zero local hot-path backpressure: resume from freshest snapshot!
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        return Ok(SessionExitReason::ShutdownRequested);
                    }
                }
            }
        }
    }
}

async fn handle_inbound_text_frame(
    raw_text: &str,
    ws: &mut BufferedWsClient,
    decimator: &mut CadenceDecimator,
    last_rtt_ms: &mut u64,
    shared_state: &Arc<SharedAgentState>,
) -> Result<(), WsBridgeError> {
    match parse_inbound_cloud_message(raw_text) {
        Ok(InboundCloudMessage::RateControl(rc)) => {
            decimator.set_target_hz(rc.target_hz);
            shared_state.write_metrics(|m| {
                m.target_hz = rc.target_hz.as_u8();
            });
        }
        Ok(InboundCloudMessage::CaptureStatus(cs)) => {
            shared_state.write_metrics(|m| {
                m.capturing = cs.capturing;
                m.active_session_id = cs.active_session_id;
                m.captured_frames_count = cs.captured_frames_count;
            });
        }
        Ok(InboundCloudMessage::Ping { timestamp_ms }) => {
            let pong = OutboundPongEnvelope {
                msg_type: "PONG",
                timestamp_ms,
            };
            let pong_json = serde_json::to_string(&pong)?;
            ws.send_text(&pong_json).await?;
        }
        Ok(InboundCloudMessage::Pong { timestamp_ms }) => {
            let rtt = unix_now_ms().saturating_sub(timestamp_ms);
            *last_rtt_ms = rtt;
            shared_state.write_metrics(|m| {
                m.latency_ms = rtt;
            });
        }
        Ok(InboundCloudMessage::SchemaAck(ack)) => {
            let label = match ack.status {
                SchemaAckStatus::Known => "known",
                SchemaAckStatus::UploadRequired => "upload_required",
            };
            shared_state.write_metrics(|m| {
                m.last_schema_ack_status = Some(label.to_string());
            });
        }
        Ok(InboundCloudMessage::BridgeError { code, message }) => {
            eprintln!("[WARN] Cloud bridge error [{code}]: {message}");
        }
        Err(CloudProtocolError::ForbiddenRemoteActuationCommand(cmd)) => {
            shared_state.write_metrics(|m| {
                m.security_violations_rejected = m.security_violations_rejected.saturating_add(1);
            });
            eprintln!(
                "[SECURITY] Blocked forbidden remote actuation command '{cmd}' — Read-Only Listen-Only invariant enforced!"
            );
        }
        Err(other_err) => {
            eprintln!("[WARN] Ignored unrecognized/malformed cloud frame: {other_err}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod wp10_url_tests {
    use super::*;

    #[test]
    fn ws_endpoint_is_loopback_only_and_errors_never_contain_the_token() {
        assert!(
            parse_ws_endpoint("ws://127.0.0.1:3000/api/bridge/ws?token=nxc_tok_secret").is_ok()
        );
        assert!(parse_ws_endpoint("ws://[::1]:3000/api/bridge/ws").is_ok());
        assert!(parse_ws_endpoint("ws://localhost/api/bridge/ws").is_ok());
        for bad in [
            "ws://cloud.nexuscan.io/api/bridge/ws?token=nxc_tok_secret",
            "wss://cloud.nexuscan.io/api/bridge/ws?token=nxc_tok_secret",
            "ws://192.168.0.10:3000/api/bridge/ws?token=nxc_tok_secret",
        ] {
            let err = parse_ws_endpoint(bad).err().expect("refused");
            let msg = err.to_string();
            assert!(matches!(err, WsBridgeError::InsecureTransport(_)), "{msg}");
            assert!(msg.contains("TLS not yet supported"), "{msg}");
            assert!(!msg.contains("nxc_tok_secret"), "token leaked: {msg}");
        }
        for invalid in [
            "http://127.0.0.1:3000/?token=nxc_tok_secret",
            "ws://127.0.0.1:notaport/?token=nxc_tok_secret",
            "ws://:3000/?token=nxc_tok_secret",
            "ws://u:nxc_tok_secret@127.0.0.1:3000/",
        ] {
            let err = parse_ws_endpoint(invalid).err().expect("invalid");
            let msg = err.to_string();
            assert!(matches!(err, WsBridgeError::InvalidWsUrl(_)), "{msg}");
            assert!(!msg.contains("nxc_tok_secret"), "token leaked: {msg}");
        }
    }
}
