//! Read-Only Local Edge Web HMI (`GET /`, `GET /index.html`) and JSON telemetry/status
//! endpoints (`GET /api/live`, `GET /api/status`, `GET /api/health`) built on `axum`
//! with zero CAN TX or mutation routes.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use nexus_cloud::{BridgeTargetHz, BridgeTelemetryFrame, BusHealthWireDto, FrameTelemetryWireDto};
use nexus_netdb::DatabaseSchemaDto;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::cli::CLI_VERSION;
use crate::config::EffectiveAgentConfig;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalMetaBriefDto {
    pub name: String,
    pub unit: String,
}

#[derive(Clone, Debug, Default)]
pub struct MutableRuntimeMetrics {
    pub active_db_name: Option<String>,
    pub fps_rx: f64,
    pub estimated_bus_load_pct: f64,
    pub total_frames_rx: u64,
    pub dropped_frames: u64,
    pub decoded_signals_count: u32,
    pub cloud_connected: bool,
    pub target_hz: u8,
    pub latency_ms: u64,
    pub capturing: bool,
    pub active_session_id: Option<String>,
    pub captured_frames_count: u64,
    pub snapshots_forwarded: u64,
    pub security_violations_rejected: u64,
    pub reconnect_attempts: u64,
    pub last_schema_ack_status: Option<String>,
    pub revoked_stopped: bool,
    pub buses: Vec<BusHealthWireDto>,
    pub frames: Vec<FrameTelemetryWireDto>,
}

/// Thread-safe read-only status & live telemetry store shared between `runner`, `ws_bridge`, and `web_status`.
pub struct SharedAgentState {
    started_at: Instant,
    agent_name: String,
    hostname: String,
    interface: String,
    resolved_device_id: String,
    bitrate: u32,
    enable_fd: bool,
    data_bitrate: u32,
    message_names: BTreeMap<String, String>,
    signal_catalog: BTreeMap<u32, SignalMetaBriefDto>,
    metrics: RwLock<MutableRuntimeMetrics>,
}

impl SharedAgentState {
    pub fn new(
        config: &EffectiveAgentConfig,
        active_db_name: Option<String>,
        schema_opt: Option<&DatabaseSchemaDto>,
    ) -> Self {
        let mut init_metrics = MutableRuntimeMetrics::default();
        init_metrics.active_db_name = active_db_name;
        init_metrics.target_hz = BridgeTargetHz::Hz20.as_u8();

        let mut message_names = BTreeMap::new();
        let mut signal_catalog = BTreeMap::new();
        if let Some(schema) = schema_opt {
            for msg in &schema.messages {
                message_names.insert(msg.message_key.clone(), msg.name.clone());
            }
            for sig in &schema.signals {
                signal_catalog.insert(
                    sig.signal_id,
                    SignalMetaBriefDto {
                        name: sig.name.clone(),
                        unit: sig.unit.clone(),
                    },
                );
            }
        }

        Self {
            started_at: Instant::now(),
            agent_name: config.agent_name.clone(),
            hostname: config.hostname.clone(),
            interface: config.interface.clone(),
            resolved_device_id: config.resolved_device_id.clone(),
            bitrate: config.bitrate,
            enable_fd: config.enable_fd,
            data_bitrate: config.data_bitrate,
            message_names,
            signal_catalog,
            metrics: RwLock::new(init_metrics),
        }
    }

    pub fn write_metrics<F>(&self, f: F)
    where
        F: FnOnce(&mut MutableRuntimeMetrics),
    {
        let mut guard = self.metrics.write();
        f(&mut guard);
    }

    /// Atomically updates local CAN bus telemetry & coalesced overwrite frames so `/api/status`
    /// and `/api/live` remain live at 60Hz even when Cloud WS is offline or reconnecting.
    pub fn update_live_telemetry(&self, frame: BridgeTelemetryFrame) {
        let mut guard = self.metrics.write();
        guard.fps_rx = frame.fps_rx;
        guard.estimated_bus_load_pct = frame.estimated_bus_load_pct;
        guard.total_frames_rx = frame.total_frames_rx;
        guard.dropped_frames = frame.dropped_frames;
        guard.decoded_signals_count = frame.decoded_signals_count;
        guard.buses = frame.buses;
        guard.frames = frame.frames;
    }

    pub fn snapshot(&self) -> AgentStatusDto {
        let m = self.metrics.read();
        self.build_status_dto(&m)
    }

    pub fn live_snapshot(&self) -> AgentLiveSnapshotDto {
        let m = self.metrics.read();
        let status = self.build_status_dto(&m);
        AgentLiveSnapshotDto {
            status,
            buses: m.buses.clone(),
            frames: m.frames.clone(),
            message_names: self.message_names.clone(),
            signal_catalog: self.signal_catalog.clone(),
        }
    }

    fn build_status_dto(&self, m: &MutableRuntimeMetrics) -> AgentStatusDto {
        AgentStatusDto {
            status: "ok".to_string(),
            version: CLI_VERSION.to_string(),
            agent_name: self.agent_name.clone(),
            hostname: self.hostname.clone(),
            listen_only: true,
            tx_armed: false,
            interface: self.interface.clone(),
            resolved_device_id: self.resolved_device_id.clone(),
            bitrate: self.bitrate,
            enable_fd: self.enable_fd,
            data_bitrate: self.data_bitrate,
            active_db_name: m.active_db_name.clone(),
            fps_rx: m.fps_rx,
            estimated_bus_load_pct: m.estimated_bus_load_pct,
            total_frames_rx: m.total_frames_rx,
            dropped_frames: m.dropped_frames,
            decoded_signals_count: m.decoded_signals_count,
            cloud_connected: m.cloud_connected,
            token_revoked: m.revoked_stopped,
            target_hz: m.target_hz,
            latency_ms: m.latency_ms,
            capturing: m.capturing,
            active_session_id: m.active_session_id.clone(),
            captured_frames_count: m.captured_frames_count,
            snapshots_forwarded: m.snapshots_forwarded,
            security_violations_rejected: m.security_violations_rejected,
            reconnect_attempts: m.reconnect_attempts,
            uptime_secs: self.started_at.elapsed().as_secs(),
        }
    }
}

/// Strictly Read-Only JSON payload served by `GET /api/status` and `GET /api/health`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusDto {
    pub status: String,
    pub version: String,
    pub agent_name: String,
    pub hostname: String,
    pub listen_only: bool,
    pub tx_armed: bool,
    pub interface: String,
    pub resolved_device_id: String,
    pub bitrate: u32,
    pub enable_fd: bool,
    pub data_bitrate: u32,
    pub active_db_name: Option<String>,
    pub fps_rx: f64,
    pub estimated_bus_load_pct: f64,
    pub total_frames_rx: u64,
    pub dropped_frames: u64,
    pub decoded_signals_count: u32,
    pub cloud_connected: bool,
    #[serde(default)]
    pub token_revoked: bool,
    pub target_hz: u8,
    pub latency_ms: u64,
    pub capturing: bool,
    pub active_session_id: Option<String>,
    pub captured_frames_count: u64,
    pub snapshots_forwarded: u64,
    pub security_violations_rejected: u64,
    pub reconnect_attempts: u64,
    pub uptime_secs: u64,
}

/// Read-Only Live Edge Telemetry JSON payload served by `GET /api/live`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLiveSnapshotDto {
    pub status: AgentStatusDto,
    pub buses: Vec<BusHealthWireDto>,
    pub frames: Vec<FrameTelemetryWireDto>,
    #[serde(default)]
    pub message_names: BTreeMap<String, String>,
    #[serde(default)]
    pub signal_catalog: BTreeMap<u32, SignalMetaBriefDto>,
}

async fn handle_get_index() -> Html<&'static str> {
    Html(EDGE_HMI_INDEX_HTML)
}

async fn handle_get_live(State(state): State<Arc<SharedAgentState>>) -> Json<AgentLiveSnapshotDto> {
    Json(state.live_snapshot())
}

async fn handle_get_status(State(state): State<Arc<SharedAgentState>>) -> Json<AgentStatusDto> {
    Json(state.snapshot())
}

async fn handle_get_health(State(state): State<Arc<SharedAgentState>>) -> Json<AgentStatusDto> {
    Json(state.snapshot())
}

/// Lower-cased host name of a `Host` header (`name[:port]` / `[v6][:port]`); `None` if malformed.
fn host_name_without_port(host: &str) -> Option<String> {
    let h = host.trim().to_ascii_lowercase();
    if h.is_empty() {
        return None;
    }
    let port_ok = |p: &str| !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit());
    if h.starts_with('[') {
        let end = h.find(']')?;
        let (name, rest) = h.split_at(end + 1);
        return match rest.strip_prefix(':') {
            None if rest.is_empty() => Some(name.to_string()),
            Some(p) if port_ok(p) => Some(name.to_string()),
            _ => None,
        };
    }
    match h.split_once(':') {
        None => Some(h),
        Some((name, p)) if !name.is_empty() && port_ok(p) => Some(name.to_string()),
        _ => None,
    }
}

/// WP-1: `Host` allowlist (DNS-rebinding protection): `localhost`, `127.0.0.1`, `[::1]` (any
/// port) or the configured non-wildcard bind host.
fn web_host_allowed(host: &str, bind_host: Option<&str>) -> bool {
    match host_name_without_port(host) {
        Some(name) => {
            matches!(name.as_str(), "localhost" | "127.0.0.1" | "[::1]")
                || bind_host.is_some_and(|b| b == name)
        }
        None => false,
    }
}

/// Accepted extra `Host` name for a bind address (`None` for loopback / wildcard binds).
fn bind_host_name(addr: &SocketAddr) -> Option<String> {
    let ip = addr.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then(|| match ip {
        std::net::IpAddr::V4(v4) => v4.to_string(),
        std::net::IpAddr::V6(v6) => format!("[{v6}]"),
    })
}

async fn host_guard(State(bind_host): State<Option<Arc<str>>>, req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(str::to_string)
        .or_else(|| req.uri().authority().map(|a| a.as_str().to_string()));
    match host {
        Some(h) if web_host_allowed(&h, bind_host.as_deref()) => next.run(req).await,
        _ => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "forbidden host" })),
        )
            .into_response(),
    }
}

/// Builds the strictly Read-Only `axum` router exposing `GET /`, `GET /index.html`,
/// `GET /api/live`, `GET /api/status`, and `GET /api/health`. Only loopback `Host` headers are
/// accepted (see [`build_status_router_for_bind`] for non-loopback binds).
pub fn build_status_router(state: Arc<SharedAgentState>) -> Router {
    build_status_router_with_host(state, None)
}

/// Same as [`build_status_router`], additionally accepting the bind address as `Host`.
pub fn build_status_router_for_bind(state: Arc<SharedAgentState>, bind_addr: &SocketAddr) -> Router {
    build_status_router_with_host(state, bind_host_name(bind_addr))
}

fn build_status_router_with_host(state: Arc<SharedAgentState>, bind_host: Option<String>) -> Router {
    let bind_host: Option<Arc<str>> = bind_host.map(Arc::from);
    Router::new()
        .route("/", get(handle_get_index))
        .route("/index.html", get(handle_get_index))
        .route("/api/live", get(handle_get_live))
        .route("/api/status", get(handle_get_status))
        .route("/api/health", get(handle_get_health))
        .with_state(state)
        .layer(middleware::from_fn_with_state(bind_host, host_guard))
}

/// Binds a `TcpListener` on `bind_addr` and spawns the read-only `axum` server with clean graceful shutdown.
pub async fn spawn_web_status_server(
    bind_addr: &str,
    state: Arc<SharedAgentState>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> Result<(SocketAddr, JoinHandle<()>), std::io::Error> {
    let listener = TcpListener::bind(bind_addr).await?;
    let local_addr = listener.local_addr()?;
    let router = build_status_router_for_bind(state, &local_addr);

    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                if !*shutdown_rx.borrow() {
                    let _ = shutdown_rx.changed().await;
                }
            })
            .await;
    });

    Ok((local_addr, handle))
}

/// Self-contained, 100% offline industrial dark-mode HTML5 Edge HMI (`GET /` & `GET /index.html`).
/// Strictly Read-Only: zero external CDN/font dependencies, zero `backdrop-blur`, crisp 1px borders,
/// `tabular-nums` monospace typography, byte-change bitmask highlights, and `PASSIVE LISTEN-ONLY LOCK` badge.
pub const EDGE_HMI_INDEX_HTML: &str = r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NexusCAN — Local Read-Only Edge HMI</title>
<style>
  :root {
    --bg-base: #090d12;
    --bg-panel: #111822;
    --bg-panel-alt: #0d131c;
    --bg-row-hover: #16202e;
    --border: #1e2a3a;
    --border-strong: #2a3a50;
    --text-primary: #e6edf5;
    --text-secondary: #93a4b8;
    --text-muted: #617388;
    --emerald: #10b981;
    --emerald-bg: #08291f;
    --emerald-border: #13684a;
    --amber: #f59e0b;
    --amber-bg: #2b1d06;
    --amber-border: #784f0e;
    --red: #ef4444;
    --red-bg: #2c0b0e;
    --red-border: #7f1d1d;
    --cyan: #38bdf8;
    --cyan-bg: #082436;
    --cyan-border: #0e5880;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    background: var(--bg-base);
    color: var(--text-primary);
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.4;
    min-height: 100vh;
  }
  .tabular {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
  }
  /* Top Industrial Header */
  .topbar {
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
    padding: 10px 16px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .brand-group {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .brand-title {
    font-family: var(--mono);
    font-weight: 700;
    font-size: 14px;
    letter-spacing: 0.04em;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .brand-dot {
    width: 8px;
    height: 8px;
    background: var(--emerald);
    display: inline-block;
  }
  .meta-pill {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    padding: 3px 8px;
    background: var(--bg-panel-alt);
    border: 1px solid var(--border);
    color: var(--text-secondary);
  }
  .badge {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
    padding: 3px 8px;
    border: 1px solid var(--border);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .badge-safety {
    background: var(--emerald-bg);
    border-color: var(--emerald-border);
    color: var(--emerald);
  }
  .badge-online {
    background: var(--emerald-bg);
    border-color: var(--emerald-border);
    color: var(--emerald);
  }
  .badge-warn {
    background: var(--amber-bg);
    border-color: var(--amber-border);
    color: var(--amber);
  }
  .badge-danger {
    background: var(--red-bg);
    border-color: var(--red-border);
    color: var(--red);
  }
  .badge-info {
    background: var(--cyan-bg);
    border-color: var(--cyan-border);
    color: var(--cyan);
  }
  .status-cluster {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  /* Main Container */
  .container {
    padding: 14px 16px 28px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  /* 8-Card KPI Strip */
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(185px, 1fr));
    gap: 10px;
  }
  .kpi-card {
    background: var(--bg-panel);
    border: 1px solid var(--border);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .kpi-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .kpi-value {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 18px;
    font-weight: 700;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .kpi-sub {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .load-track {
    width: 100%;
    height: 5px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    margin-top: 3px;
  }
  .load-fill {
    height: 100%;
    width: 0%;
    background: var(--emerald);
  }
  /* Trace Panel */
  .panel {
    background: var(--bg-panel);
    border: 1px solid var(--border);
  }
  .panel-header {
    padding: 9px 12px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    background: var(--bg-panel-alt);
  }
  .panel-title {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-primary);
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .search-input {
    background: var(--bg-base);
    border: 1px solid var(--border-strong);
    color: var(--text-primary);
    font-family: var(--mono);
    font-size: 12px;
    padding: 5px 9px;
    width: 240px;
    outline: none;
  }
  .search-input:focus {
    border-color: var(--cyan);
  }
  .btn {
    background: var(--bg-panel);
    border: 1px solid var(--border-strong);
    color: var(--text-primary);
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 700;
    padding: 5px 10px;
    cursor: pointer;
  }
  .btn:hover {
    border-color: var(--cyan);
  }
  .btn-paused {
    background: var(--amber-bg);
    border-color: var(--amber-border);
    color: var(--amber);
  }
  .table-wrap {
    width: 100%;
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 12px;
  }
  thead th {
    text-align: left;
    padding: 7px 10px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    background: var(--bg-panel-alt);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  tbody tr {
    border-bottom: 1px solid var(--border);
  }
  tbody tr:hover {
    background: var(--bg-row-hover);
  }
  tbody td {
    padding: 6px 10px;
    vertical-align: top;
  }
  .col-nowrap {
    white-space: nowrap;
  }
  .tag {
    display: inline-block;
    font-size: 10px;
    padding: 1px 4px;
    margin-left: 4px;
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
  }
  .tag-fd {
    border-color: var(--cyan-border);
    color: var(--cyan);
    background: var(--cyan-bg);
  }
  .tag-ext {
    border-color: var(--amber-border);
    color: var(--amber);
  }
  .msg-name {
    color: var(--text-secondary);
    font-size: 11px;
    margin-left: 6px;
  }
  .health-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-right: 5px;
    background: var(--text-muted);
  }
  .health-nominal { background: var(--emerald); }
  .health-jitterWarning { background: var(--amber); }
  .health-timeout { background: var(--red); }
  .hex-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    max-width: 480px;
  }
  .hex-byte {
    padding: 1px 4px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    color: var(--text-primary);
  }
  .hex-changed {
    background: var(--cyan-bg);
    border-color: var(--cyan-border);
    color: var(--cyan);
    font-weight: 700;
  }
  .sig-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
  }
  .sig-chip {
    padding: 1px 6px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-primary);
  }
  .sig-retained {
    opacity: 0.62;
  }
  .sig-oor {
    border-color: var(--red-border);
    color: var(--red);
  }
  .sig-id {
    color: var(--text-muted);
    margin-right: 3px;
  }
  .sig-val {
    color: var(--emerald);
    font-weight: 700;
  }
  .empty-state {
    padding: 24px 12px;
    text-align: center;
    color: var(--text-muted);
    font-family: var(--mono);
  }
  details.raw-json {
    background: var(--bg-panel);
    border: 1px solid var(--border);
  }
  details.raw-json summary {
    padding: 9px 12px;
    cursor: pointer;
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 700;
    color: var(--text-secondary);
    background: var(--bg-panel-alt);
    user-select: none;
  }
  details.raw-json pre {
    padding: 12px;
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    color: var(--text-secondary);
    overflow-x: auto;
    border-top: 1px solid var(--border);
  }
</style>
</head>
<body>
  <header class="topbar">
    <div class="brand-group">
      <div class="brand-title">
        <span class="brand-dot"></span>
        <span>NexusCAN EDGE HMI</span>
      </div>
      <span class="badge badge-safety" title="Hardware CAN channel is locked to passive Listen-Only observation; TX is disabled at compile &amp; runtime">
        PASSIVE LISTEN-ONLY LOCK &middot; LISTEN-ONLY (TX LOCKED)
      </span>
      <span class="meta-pill" id="hdr-agent">Agent: --</span>
      <span class="meta-pill" id="hdr-host">Host: --</span>
      <span class="meta-pill" id="hdr-ver">v0.1.0-cli</span>
    </div>
    <div class="status-cluster">
      <span class="badge badge-warn" id="hdr-cloud">CLOUD: CONNECTING</span>
      <span class="meta-pill" id="hdr-hz">Target: -- Hz</span>
      <span class="meta-pill" id="hdr-rtt">RTT: -- ms</span>
      <span class="badge" id="hdr-capture">CAPTURE: IDLE</span>
      <span class="meta-pill" id="hdr-uptime">Up: 0s</span>
    </div>
  </header>

  <main class="container">
    <section class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">RX Frame Rate</div>
        <div class="kpi-value" id="kpi-fps">0 fps</div>
        <div class="kpi-sub" id="kpi-iface">can0 &middot; 500 kbps</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Bus Load (%)</div>
        <div class="kpi-value" id="kpi-load">0.0%</div>
        <div class="load-track"><div class="load-fill" id="kpi-load-bar"></div></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Total RX Frames</div>
        <div class="kpi-value" id="kpi-total-rx">0</div>
        <div class="kpi-sub" id="kpi-fwd">Forwarded: 0 snaps</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Active CAN IDs</div>
        <div class="kpi-value" id="kpi-active-ids">0</div>
        <div class="kpi-sub" id="kpi-bus-state">Bus: --</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Decoded Signals</div>
        <div class="kpi-value" id="kpi-signals">0</div>
        <div class="kpi-sub">Coalesced + Retained Mux</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Dropped Frames</div>
        <div class="kpi-value" id="kpi-dropped">0</div>
        <div class="kpi-sub" id="kpi-err-cnt">TEC: 0 / REC: 0</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Active Database</div>
        <div class="kpi-value" id="kpi-db" style="font-size:14px">Raw Hex Mode</div>
        <div class="kpi-sub" id="kpi-fd-mode">CAN-FD: --</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Blocked Actuation Attempts</div>
        <div class="kpi-value" id="kpi-sec">0</div>
        <div class="kpi-sub" id="kpi-reconn">Reconnects: 0</div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div class="panel-title">Live Overwrite CAN / CAN-FD Trace Table (<span id="row-count">0</span> IDs)</div>
        <div class="controls">
          <span class="meta-pill" id="poll-state">Polling 250ms</span>
          <input type="text" id="filter-input" class="search-input" placeholder="Filter ID (0x101), Hex, Msg, Signal...">
          <button type="button" id="pause-btn" class="btn">Pause UI</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Bus</th>
              <th>CAN ID</th>
              <th>DLC / Count</th>
              <th>Cycle (ms) / Hz</th>
              <th>Payload (Hex &middot; 300ms Delta Highlight)</th>
              <th>Decoded Signals (Read-Only)</th>
            </tr>
          </thead>
          <tbody id="trace-tbody">
            <tr><td colspan="6" class="empty-state">Waiting for live telemetry from /api/live...</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <details class="raw-json">
      <summary>Raw /api/status Diagnostic JSON</summary>
      <pre id="raw-status-pre">{}</pre>
    </details>
  </main>

<script>
(function() {
  "use strict";
  var uiPaused = false;
  var inFlight = false;
  var lastData = null;

  var pauseBtn = document.getElementById("pause-btn");
  var filterInput = document.getElementById("filter-input");
  var pollStateEl = document.getElementById("poll-state");

  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtUptime(secs) {
    var s = Math.max(0, Number(secs) || 0);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = Math.floor(s % 60);
    if (h > 0) return h + "h " + m + "m " + r + "s";
    if (m > 0) return m + "m " + r + "s";
    return r + "s";
  }

  function fmtHexId(arbId, isExt) {
    var hex = (Number(arbId) >>> 0).toString(16).toUpperCase();
    var pad = isExt ? 8 : 3;
    while (hex.length < pad) hex = "0" + hex;
    return "0x" + hex;
  }

  function fmtByte(b) {
    var s = (Number(b) & 0xFF).toString(16).toUpperCase();
    return s.length < 2 ? "0" + s : s;
  }

  function isByteChanged(idx, lo, hi) {
    if (idx < 32) {
      return (((lo >>> 0) >>> idx) & 1) === 1;
    }
    if (idx < 64) {
      return (((hi >>> 0) >>> (idx - 32)) & 1) === 1;
    }
    return false;
  }

  function fmtNum(v) {
    var n = Number(v);
    if (!isFinite(n)) return "0";
    if (Math.abs(n - Math.round(n)) < 1e-6) return String(Math.round(n));
    return n.toFixed(3).replace(/\.?0+$/, "");
  }

  pauseBtn.addEventListener("click", function() {
    uiPaused = !uiPaused;
    pauseBtn.textContent = uiPaused ? "Resume UI" : "Pause UI";
    pauseBtn.className = uiPaused ? "btn btn-paused" : "btn";
    pollStateEl.textContent = uiPaused ? "UI Paused" : "Polling 250ms";
    if (!uiPaused && lastData) {
      renderAll(lastData);
    }
  });

  filterInput.addEventListener("input", function() {
    if (lastData) renderTable(lastData);
  });

  function renderAll(payload) {
    var st = payload.status || {};
    var buses = payload.buses || [];
    var frames = payload.frames || [];

    document.getElementById("hdr-agent").textContent = "Agent: " + (st.agentName || "--");
    document.getElementById("hdr-host").textContent = "Host: " + (st.hostname || "--");
    document.getElementById("hdr-ver").textContent = st.version || "0.1.0-cli";

    var cloudEl = document.getElementById("hdr-cloud");
    if (st.tokenRevoked) {
      cloudEl.textContent = "CLOUD: TOKEN REVOKED";
      cloudEl.className = "badge badge-danger";
    } else if (st.cloudConnected) {
      cloudEl.textContent = "CLOUD: CONNECTED";
      cloudEl.className = "badge badge-online";
    } else {
      cloudEl.textContent = "CLOUD: RECONNECTING";
      cloudEl.className = "badge badge-warn";
    }

    document.getElementById("hdr-hz").textContent = "Target: " + (st.targetHz || 0) + " Hz";
    document.getElementById("hdr-rtt").textContent = "RTT: " + (st.latencyMs || 0) + " ms";

    var capEl = document.getElementById("hdr-capture");
    if (st.capturing) {
      var sid = st.activeSessionId ? " (" + st.activeSessionId.slice(0, 8) + ")" : "";
      capEl.textContent = "CAPTURE: ACTIVE" + sid + " [" + (st.capturedFramesCount || 0) + "]";
      capEl.className = "badge badge-info";
    } else {
      capEl.textContent = "CAPTURE: IDLE";
      capEl.className = "badge";
    }

    document.getElementById("hdr-uptime").textContent = "Up: " + fmtUptime(st.uptimeSecs);

    document.getElementById("kpi-fps").textContent = Math.round(st.fpsRx || 0).toLocaleString() + " fps";
    document.getElementById("kpi-iface").textContent =
      (st.interface || "--") + " \u00b7 " + Math.round((st.bitrate || 0) / 1000) + " kbps";

    var loadPct = Math.min(100, Math.max(0, Number(st.estimatedBusLoadPct) || 0));
    document.getElementById("kpi-load").textContent = loadPct.toFixed(1) + "%";
    var loadBar = document.getElementById("kpi-load-bar");
    loadBar.style.width = loadPct.toFixed(1) + "%";
    loadBar.style.background = loadPct > 80 ? "var(--red)" : (loadPct > 50 ? "var(--amber)" : "var(--emerald)");

    document.getElementById("kpi-total-rx").textContent = Number(st.totalFramesRx || 0).toLocaleString();
    document.getElementById("kpi-fwd").textContent =
      "Forwarded: " + Number(st.snapshotsForwarded || 0).toLocaleString() + " snaps";

    document.getElementById("kpi-active-ids").textContent = String(frames.length);
    var b0 = buses[0];
    document.getElementById("kpi-bus-state").textContent = b0
      ? ("Bus 0: " + String(b0.busState || "active").toUpperCase() + " (RO)")
      : "Bus 0: LISTEN-ONLY";

    document.getElementById("kpi-signals").textContent = Number(st.decodedSignalsCount || 0).toLocaleString();
    document.getElementById("kpi-dropped").textContent = Number(st.droppedFrames || 0).toLocaleString();
    document.getElementById("kpi-err-cnt").textContent = b0
      ? ("TEC: " + (b0.txErrorCount || 0) + " / REC: " + (b0.rxErrorCount || 0))
      : "TEC: 0 / REC: 0";

    document.getElementById("kpi-db").textContent = st.activeDbName || "Raw Hex Mode";
    document.getElementById("kpi-fd-mode").textContent = st.enableFd
      ? ("CAN-FD @ " + Math.round((st.dataBitrate || 0) / 1000) + " kbps")
      : "Classical CAN 2.0";

    var secVal = Number(st.securityViolationsRejected || 0);
    var secEl = document.getElementById("kpi-sec");
    secEl.textContent = String(secVal);
    secEl.style.color = secVal > 0 ? "var(--amber)" : "var(--text-primary)";
    document.getElementById("kpi-reconn").textContent =
      "Reconnects: " + Number(st.reconnectAttempts || 0).toLocaleString();

    document.getElementById("raw-status-pre").textContent = JSON.stringify(st, null, 2);

    renderTable(payload);
  }

  function renderTable(payload) {
    var frames = payload.frames || [];
    var buses = payload.buses || [];
    var msgNames = payload.messageNames || {};
    var sigCatalog = payload.signalCatalog || {};
    var q = (filterInput.value || "").trim().toLowerCase();

    var busChannelMap = {};
    for (var b = 0; b < buses.length; b++) {
      busChannelMap[buses[b].busId] = buses[b].channelName || ("bus" + buses[b].busId);
    }

    var filtered = [];
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      var hexId = fmtHexId(f.arbId, f.isExtended);
      var mName = msgNames[f.messageKey] || "";
      var rawHexStr = "";
      var rb = f.rawBytes || [];
      for (var k = 0; k < rb.length; k++) {
        rawHexStr += (k > 0 ? " " : "") + fmtByte(rb[k]);
      }
      if (q) {
        var match = hexId.toLowerCase().indexOf(q) !== -1 ||
          String(f.arbId).indexOf(q) !== -1 ||
          mName.toLowerCase().indexOf(q) !== -1 ||
          rawHexStr.toLowerCase().indexOf(q) !== -1;
        if (!match && f.signals) {
          for (var sIdx = 0; sIdx < f.signals.length; sIdx++) {
            var sid = f.signals[sIdx].signalId;
            var meta = sigCatalog[sid];
            if (String(sid).indexOf(q) !== -1 || (meta && meta.name.toLowerCase().indexOf(q) !== -1)) {
              match = true;
              break;
            }
          }
        }
        if (!match) continue;
      }
      filtered.push({ frame: f, hexId: hexId, msgName: mName });
    }

    document.getElementById("row-count").textContent = String(filtered.length);
    var tbody = document.getElementById("trace-tbody");

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">' +
        (frames.length === 0 ? "No CAN / CAN-FD frames received yet on passive bus." : "No frames match current filter.") +
        "</td></tr>";
      return;
    }

    var html = "";
    for (var r = 0; r < filtered.length; r++) {
      var item = filtered[r];
      var fr = item.frame;
      var chLabel = busChannelMap[fr.busId] || ("B" + fr.busId);

      var tags = fr.isExtended ? '<span class="tag tag-ext">EXT</span>' : '<span class="tag">STD</span>';
      if (fr.isFd) tags += '<span class="tag tag-fd">' + (fr.isBrs ? "FD+BRS" : "FD") + "</span>";
      var nameSpan = item.msgName ? '<span class="msg-name">' + esc(item.msgName) + "</span>" : "";

      var healthCls = "health-dot health-" + esc(fr.cycleHealth || "unconfigured");
      var cycText = (Number(fr.cycleMs) || 0).toFixed(1) + " ms / " + (Number(fr.frequencyHz) || 0).toFixed(1) + " Hz";

      var bytesHtml = '<div class="hex-grid">';
      var bytesArr = fr.rawBytes || [];
      for (var bi = 0; bi < bytesArr.length; bi++) {
        var changed = isByteChanged(bi, fr.changedBytesLo || 0, fr.changedBytesHi || 0);
        bytesHtml += '<span class="hex-byte' + (changed ? " hex-changed" : "") + '">' + fmtByte(bytesArr[bi]) + "</span>";
      }
      if (bytesArr.length === 0) bytesHtml += '<span class="sig-id">--</span>';
      bytesHtml += "</div>";

      var sigsHtml = "";
      var sigs = fr.signals || [];
      if (sigs.length === 0) {
        sigsHtml = '<span class="sig-id">--</span>';
      } else {
        sigsHtml = '<div class="sig-list">';
        for (var si = 0; si < sigs.length; si++) {
          var sg = sigs[si];
          var sm = sigCatalog[sg.signalId];
          var cls = "sig-chip" + (!sg.activeInLastFrame ? " sig-retained" : "") + (sg.outOfRange ? " sig-oor" : "");
          var label = sm ? ("#" + sg.signalId + " " + esc(sm.name)) : ("#" + sg.signalId);
          var unit = (sm && sm.unit) ? (" " + esc(sm.unit)) : "";
          sigsHtml += '<span class="' + cls + '"><span class="sig-id">' + label + ':</span><span class="sig-val">' +
            fmtNum(sg.physicalValue) + unit + '</span> <span class="sig-id">(raw=' + sg.rawInt + ")</span></span>";
        }
        sigsHtml += "</div>";
      }

      html += "<tr>" +
        '<td class="col-nowrap">' + esc(chLabel) + "</td>" +
        '<td class="col-nowrap"><strong>' + esc(item.hexId) + "</strong>" + tags + nameSpan + "</td>" +
        '<td class="col-nowrap">' + (fr.dlc || 0) + ' B <span class="sig-id">(' + Number(fr.rxCount || 0).toLocaleString() + ")</span></td>" +
        '<td class="col-nowrap"><span class="' + healthCls + '"></span>' + cycText + "</td>" +
        "<td>" + bytesHtml + "</td>" +
        "<td>" + sigsHtml + "</td>" +
        "</tr>";
    }
    tbody.innerHTML = html;
  }

  async function pollLive() {
    if (inFlight) return;
    inFlight = true;
    try {
      var res = await fetch("/api/live", { cache: "no-store" });
      if (res.ok) {
        var json = await res.json();
        lastData = json;
        if (!uiPaused) {
          renderAll(json);
          pollStateEl.textContent = "Live (250ms)";
        }
      } else {
        pollStateEl.textContent = "HTTP " + res.status;
      }
    } catch (_e) {
      pollStateEl.textContent = "Agent Offline";
    } finally {
      inFlight = false;
    }
  }

  pollLive();
  setInterval(pollLive, 250);
})();
</script>
</body>
</html>
"##;

#[cfg(test)]
mod host_guard_tests {
    use super::*;

    #[test]
    fn host_allowlist_blocks_dns_rebinding() {
        for ok in ["localhost", "localhost:8080", "127.0.0.1:9", "[::1]", "[::1]:80"] {
            assert!(web_host_allowed(ok, None), "{ok}");
        }
        for bad in ["evil.example", "evil.example:8080", "localhost.evil.example", "", "127.0.0.1:x", "::1"] {
            assert!(!web_host_allowed(bad, None), "{bad}");
        }
        let lan: SocketAddr = "10.0.0.7:8080".parse().unwrap();
        let bind = bind_host_name(&lan);
        assert!(web_host_allowed("10.0.0.7:8080", bind.as_deref()));
        assert!(!web_host_allowed("10.0.0.8:8080", bind.as_deref()));
        assert_eq!(bind_host_name(&"0.0.0.0:1".parse().unwrap()), None);
    }
}
