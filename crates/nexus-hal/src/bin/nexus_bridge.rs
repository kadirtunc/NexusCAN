//! Standalone local HTTP + 60Hz WebSocket Telemetry Bridge (`127.0.0.1:14210`).
//!
//! Enables zero-WebKit browser / Vite development (`http://localhost:5173`) against the exact
//! real Rust `PipelineEngine`, `StateTable`, `SocketCAN`, and `mock0` drivers.
//!
//! # Security (WP-1 / CRIT-01)
//! The bridge can transmit on real CAN buses, so it is locked down even though it is a
//! development tool:
//! * Binds `127.0.0.1:14210` by default (`NEXUS_BRIDGE_ADDR` overrides; a non-loopback bind
//!   prints a warning).
//! * Random per-start bearer token (`NEXUS_BRIDGE_TOKEN` env, >= 32 chars, overrides), written
//!   to a user-private token file (path printed, token never printed). See [`token_file_path`].
//! * Every `/api/*` request needs `Authorization: Bearer <token>` (401 otherwise).
//! * `Host` must be loopback or the bind host (403, DNS rebinding). A present `Origin` must be
//!   in the allowlist (403). CORS is allowlist-only.
//! * `/ws/telemetry`: Host/Origin checked at upgrade; the first client message must be
//!   `{"type":"auth","token":"<token>"}` within 3 s, else the socket is closed with code 4401.
//! * `/ws/re` (re-toolkit-v1 amendment 14): same Host/Origin + first-message auth, then the
//!   10 Hz RE binary snapshots (`"NRE2"`) as one binary message each; closed with 1000 when
//!   the backend ends the subscription (`cmd_re_stop` or a newer subscriber).
//! * Native seed/key providers (`library`, `external_process`) run only for loopback TCP peers
//!   AND `NEXUS_BRIDGE_ALLOW_NATIVE_SEEDKEY=1`; otherwise `[seedkey:native_not_allowed]`.

use axum::{
    body::Bytes,
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, DefaultBodyLimit, FromRef, Path, Request, State,
    },
    http::{header, Extensions, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use nexus_hal::{
    dto::{
        AppendDebugEventInputDto, ChannelConfigDto, ChronologicalFrameDto, DbFileInputDto,
        PhysicalSweepRequestDto, StartTraceReplayArgsDto, TraceReplayControlArgsDto,
    },
    flowlib::FlowLibError,
    pipeline::diag_flash::{flash_error_to_ipc, resolve_download_config, FlashLoadFormat},
    pipeline::re_analyzer::{
        re_dbc_generate, ReCorrelateRequest, ReDbcGenerateRequest, ReError, RePhase,
        ReScanFirstSpec, ReScanNextOp, ReScanSort, ReSeriesRequest, ReTargetDto,
    },
    pipeline::PipelineEngine,
    runstore::{RunQueryFilterDto, RunRecordV1, RunStoreError},
    seedkey::SeedKeyPolicy,
    HalError,
};
use nexus_protocols::uds::dto::{
    DiagError, DiagErrorCode, DiagOrigin, DiagSessionConfigDto, EcuDiscoveryRequestDto,
    UdsRequestOptionsDto,
};
use nexus_protocols::uds::flash::{FirmwareError, FlashError, FlashErrorKind, FlashPhase};
use nexus_protocols::uds::security::{KeyProviderSpecDto, SeedKeyError};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;
use tower_http::cors::{AllowOrigin, CorsLayer};

// ─── WP-1 security configuration ────────────────────────────────────────────

/// Default bind address (loopback only).
const DEFAULT_BIND_ADDR: &str = "127.0.0.1:14210";
/// Minimum accepted length of `NEXUS_BRIDGE_TOKEN`.
const MIN_TOKEN_LEN: usize = 32;
/// Origins always allowed (Vite dev server).
const DEFAULT_ALLOWED_ORIGINS: [&str; 2] = ["http://localhost:5173", "http://127.0.0.1:5173"];
/// WebSocket: deadline for the first `{"type":"auth"}` message.
const WS_AUTH_TIMEOUT: Duration = Duration::from_secs(3);
/// WebSocket close code for missing / invalid auth.
const WS_CLOSE_UNAUTHORIZED: u16 = 4401;
/// Client -> bridge WebSocket messages are tiny (auth, ping): cap them.
const WS_MAX_CLIENT_MESSAGE: usize = 64 * 1024;

/// Immutable per-process security settings shared by every request.
#[derive(Debug)]
struct BridgeSecurity {
    token: String,
    allowed_origins: Vec<String>,
    /// Extra accepted `Host` name (the configured non-loopback, non-wildcard bind host).
    bind_host: Option<String>,
}

impl BridgeSecurity {
    fn new(token: String, extra_origins: &str, bind_addr: SocketAddr) -> Self {
        let mut allowed_origins: Vec<String> = DEFAULT_ALLOWED_ORIGINS
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        for o in extra_origins
            .split(',')
            .map(str::trim)
            .filter(|o| !o.is_empty())
        {
            let o = o.trim_end_matches('/').to_string();
            if HeaderValue::from_str(&o).is_ok() && o != "null" && !allowed_origins.contains(&o) {
                allowed_origins.push(o);
            }
        }
        let ip = bind_addr.ip();
        let bind_host = (!ip.is_loopback() && !ip.is_unspecified()).then(|| match ip {
            std::net::IpAddr::V4(v4) => v4.to_string(),
            std::net::IpAddr::V6(v6) => format!("[{v6}]"),
        });
        Self {
            token,
            allowed_origins,
            bind_host,
        }
    }

    fn host_allowed(&self, host: &str) -> bool {
        let Some(name) = host_name_without_port(host) else {
            return false;
        };
        matches!(name.as_str(), "localhost" | "127.0.0.1" | "[::1]")
            || self.bind_host.as_deref() == Some(name.as_str())
    }

    fn origin_allowed(&self, origin: &str) -> bool {
        self.allowed_origins.iter().any(|o| o == origin)
    }

    fn token_matches(&self, candidate: &str) -> bool {
        constant_time_eq(self.token.as_bytes(), candidate.as_bytes())
    }

    fn cors_layer(&self) -> CorsLayer {
        let origins: Vec<HeaderValue> = self
            .allowed_origins
            .iter()
            .filter_map(|o| HeaderValue::from_str(o).ok())
            .collect();
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(origins))
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
    }
}

/// Lower-cased host name of a `Host` header value (`name[:port]` / `[v6][:port]`), or `None`
/// when malformed.
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

/// Length-revealing but content-constant-time byte comparison (token length is not secret).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let diff = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(diff) == 0
}

/// Token from `NEXUS_BRIDGE_TOKEN` (validated) or 32 random bytes from the OS CSPRNG, hex.
fn resolve_token(env_token: Option<String>) -> Result<String, String> {
    if let Some(t) = env_token {
        let t = t.trim().to_string();
        if t.len() < MIN_TOKEN_LEN {
            return Err(format!(
                "NEXUS_BRIDGE_TOKEN must be at least {MIN_TOKEN_LEN} characters"
            ));
        }
        if !t.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("NEXUS_BRIDGE_TOKEN must be printable ASCII without spaces".to_string());
        }
        return Ok(t);
    }
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("OS random generator failed: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Token file location (WP-1 contract, mirrored by the Vite dev setup):
/// * `NEXUS_BRIDGE_TOKEN_FILE` if set;
/// * unix: `$XDG_RUNTIME_DIR/nexuscan/bridge.token`, else
///   `<temp_dir>/nexuscan-<username>/bridge.token`;
/// * windows: `%LOCALAPPDATA%\NexusCAN\bridge.token`.
fn token_file_path() -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("NEXUS_BRIDGE_TOKEN_FILE").filter(|p| !p.is_empty()) {
        return Ok(PathBuf::from(p));
    }
    #[cfg(windows)]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .filter(|p| !p.is_empty())
            .ok_or("LOCALAPPDATA is not set; set NEXUS_BRIDGE_TOKEN_FILE")?;
        Ok(PathBuf::from(base).join("NexusCAN").join("bridge.token"))
    }
    #[cfg(not(windows))]
    {
        if let Some(xdg) = std::env::var_os("XDG_RUNTIME_DIR").filter(|p| !p.is_empty()) {
            return Ok(PathBuf::from(xdg).join("nexuscan").join("bridge.token"));
        }
        let user: String = std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .unwrap_or_default()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
            .take(64)
            .collect();
        let user = if user.is_empty() || user.starts_with('.') {
            "user".to_string()
        } else {
            user
        };
        Ok(std::env::temp_dir()
            .join(format!("nexuscan-{user}"))
            .join("bridge.token"))
    }
}

/// Writes `token` to `path` atomically (temp file + rename). Unix: parent dir 0700 (must be a
/// real directory owned by us, not a symlink), file 0600.
fn write_token_file(path: &FsPath, token: &str) -> Result<(), String> {
    use std::io::Write as _;
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .ok_or_else(|| format!("token file '{}' has no parent directory", path.display()))?;
    let tmp = dir.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("bridge.token"),
        std::process::id()
    ));

    #[cfg(unix)]
    {
        use std::os::unix::fs::{
            DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _,
        };
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| format!("cannot create '{}': {e}", dir.display()))?;
        let meta = std::fs::symlink_metadata(dir)
            .map_err(|e| format!("cannot stat '{}': {e}", dir.display()))?;
        if !meta.is_dir() {
            return Err(format!("'{}' is not a directory (symlink?)", dir.display()));
        }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| {
            format!(
                "cannot chmod 0700 '{}' (not owned by us?): {e}",
                dir.display()
            )
        })?;
        let _ = std::fs::remove_file(&tmp);
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("cannot create '{}': {e}", tmp.display()))?;
        // The directory must belong to the same user that just created the temp file
        // (protects the shared temp-dir fallback against a pre-created foreign directory).
        let file_uid = f.metadata().map(|m| m.uid()).map_err(|e| e.to_string())?;
        if meta.uid() != file_uid {
            drop(f);
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("'{}' is owned by another user", dir.display()));
        }
        f.write_all(token.as_bytes())
            .and_then(|()| f.sync_all())
            .map_err(|e| format!("cannot write '{}': {e}", tmp.display()))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("cannot create '{}': {e}", dir.display()))?;
        let _ = std::fs::remove_file(&tmp);
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("cannot create '{}': {e}", tmp.display()))?;
        f.write_all(token.as_bytes())
            .and_then(|()| f.sync_all())
            .map_err(|e| format!("cannot write '{}': {e}", tmp.display()))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot move token file into '{}': {e}", path.display())
    })
}

/// Router state: the engine plus the security settings.
#[derive(Clone)]
struct BridgeState {
    engine: Arc<PipelineEngine>,
    security: Arc<BridgeSecurity>,
}

impl FromRef<BridgeState> for Arc<PipelineEngine> {
    fn from_ref(state: &BridgeState) -> Self {
        Arc::clone(&state.engine)
    }
}

fn forbidden(reason: &str) -> Response {
    (StatusCode::FORBIDDEN, Json(json!({ "error": reason }))).into_response()
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "unauthorized" })),
    )
        .into_response()
}

/// Outermost guard (every request incl. CORS preflight and WS upgrade): Host + Origin.
async fn host_origin_guard(State(state): State<BridgeState>, req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(str::to_string)
        .or_else(|| req.uri().authority().map(|a| a.as_str().to_string()));
    match host {
        Some(h) if state.security.host_allowed(&h) => {}
        _ => return forbidden("forbidden host"),
    }
    if let Some(origin) = req.headers().get(header::ORIGIN) {
        let ok = origin
            .to_str()
            .is_ok_and(|o| state.security.origin_allowed(o));
        if !ok {
            return forbidden("forbidden origin");
        }
    }
    next.run(req).await
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?.trim();
    let (scheme, token) = value.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
}

/// Inner guard (inside CORS, so allowed origins can read the 401): bearer token on `/api/*`.
async fn api_token_guard(State(state): State<BridgeState>, req: Request, next: Next) -> Response {
    let needs_token = req.method() != Method::OPTIONS && req.uri().path().starts_with("/api/");
    if needs_token {
        let ok = bearer_token(req.headers()).is_some_and(|t| state.security.token_matches(t));
        if !ok {
            return unauthorized();
        }
    }
    next.run(req).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectBusArgs {
    #[serde(alias = "device_id")]
    device_id: String,
    config: ChannelConfigDto,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DisconnectBusArgs {
    #[serde(alias = "bus_id")]
    bus_id: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArmBusArgs {
    #[serde(alias = "bus_id")]
    bus_id: u8,
    armed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetBusModeArgs {
    #[serde(alias = "bus_id")]
    bus_id: u8,
    #[serde(alias = "listen_only")]
    listen_only: bool,
    #[serde(alias = "arm_tx")]
    arm_tx: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadDatabaseContentArgs {
    #[serde(alias = "file_name")]
    file_name: String,
    #[serde(alias = "content_base64")]
    content_base64: String,
    #[serde(default, alias = "append_to_existing")]
    append_to_existing: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParseDatabaseSchemaArgs {
    #[serde(alias = "file_name")]
    file_name: String,
    #[serde(alias = "content_base64")]
    content_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetBusDatabasesArgs {
    #[serde(alias = "bus_id")]
    bus_id: u8,
    files: Vec<DbFileInputDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransmitSignalFrameArgs {
    #[serde(alias = "bus_id")]
    bus_id: u8,
    #[serde(alias = "arb_id")]
    arb_id: u32,
    #[serde(alias = "is_extended")]
    is_extended: bool,
    #[serde(alias = "signal_values")]
    signal_values: Vec<(u32, f64)>,
    #[serde(default, alias = "periodic_ms")]
    periodic_ms: Option<u32>,
    #[serde(default, alias = "job_label")]
    job_label: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransmitRawFrameArgs {
    #[serde(alias = "bus_id")]
    bus_id: u8,
    #[serde(alias = "arb_id")]
    arb_id: u32,
    #[serde(alias = "is_extended")]
    is_extended: bool,
    #[serde(default, alias = "is_fd")]
    is_fd: bool,
    #[serde(default, alias = "is_brs")]
    is_brs: bool,
    data: Vec<u8>,
    #[serde(default, alias = "periodic_ms")]
    periodic_ms: Option<u32>,
    #[serde(default, alias = "job_label")]
    job_label: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopPeriodicTxArgs {
    #[serde(alias = "job_id")]
    job_id: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveProjectArgs {
    #[serde(alias = "file_stem")]
    file_stem: String,
    #[serde(alias = "project_json")]
    project_json: String,
}

// ─── Diagnostics Workspace (diag-workspace-v1 §9 / §10) args: FlowLibCommandMap /
// RunStoreCommandMap in src/types/flowLibrary.ts / src/types/runRecord.ts.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlowLibListArgs {
    include_deleted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlowLibIdArgs {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlowLibLoadArgs {
    id: String,
    #[serde(default)]
    revision: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlowLibSaveArgs {
    file_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunAppendArgs {
    record: RunRecordV1,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunQueryArgs {
    project_id: String,
    filter: RunQueryFilterDto,
    limit: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunProjectArgs {
    project_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectStemArgs {
    #[serde(alias = "file_stem")]
    file_stem: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraceFileNameArgs {
    #[serde(alias = "file_name")]
    file_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraceFileContentArgs {
    #[serde(alias = "file_name")]
    file_name: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default, alias = "content_base64")]
    content_base64: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportTraceBlfArgs {
    #[serde(default, alias = "file_name")]
    file_name: String,
    frames: Vec<ChronologicalFrameDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportDebugEventsArgs {
    format: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetDebugWindowOpenArgs {
    open: bool,
    #[serde(default, alias = "always_on_top")]
    always_on_top: Option<bool>,
    #[serde(default)]
    redock: Option<bool>,
}

// ─── D-003 `cmd_diag_*` arguments (mirror of `DiagCommandMap` in src/types/udsClient.ts) ───

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagConfigArgs {
    config: DiagSessionConfigDto,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagSendUdsArgs {
    config: DiagSessionConfigDto,
    sid: u8,
    #[serde(default, alias = "sub_function")]
    sub_function: Option<u8>,
    #[serde(default)]
    data: Vec<u8>,
    #[serde(default)]
    options: Option<UdsRequestOptionsDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagReadDidArgs {
    config: DiagSessionConfigDto,
    did: u16,
    /// Conversation origin tag; default `did`.
    #[serde(default)]
    origin: Option<DiagOrigin>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagReadDtcsArgs {
    config: DiagSessionConfigDto,
    #[serde(default, alias = "status_mask")]
    status_mask: Option<u8>,
    /// Conversation origin tag; default `dtc`.
    #[serde(default)]
    origin: Option<DiagOrigin>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagTesterPresentArgs {
    config: DiagSessionConfigDto,
    enabled: bool,
    #[serde(default, alias = "interval_ms")]
    interval_ms: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagConversationArgs {
    config: DiagSessionConfigDto,
    #[serde(default, alias = "since_seq")]
    since_seq: u64,
    #[serde(default)]
    max: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagReadDtcReportArgs {
    config: DiagSessionConfigDto,
    #[serde(alias = "sub_function")]
    sub_function: u8,
    #[serde(default)]
    params: Vec<u8>,
    #[serde(default)]
    options: Option<UdsRequestOptionsDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagBusArgs {
    #[serde(alias = "bus_id")]
    bus_id: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagPhysicalSweepArgs {
    request: PhysicalSweepRequestDto,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagDiscoverEcusArgs {
    request: EcuDiscoveryRequestDto,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedKeyComputeAdhocArgs {
    provider: KeyProviderSpecDto,
    level: u8,
    #[serde(alias = "seed_hex")]
    seed_hex: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedKeyProbeLibraryArgs {
    path: String,
}

/// Body limit of `/api/invoke/{cmd}`: a 64 MiB firmware image as base64 plus JSON overhead.
const INVOKE_BODY_LIMIT: usize = 96 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlashLoadImageArgs {
    file_name: String,
    format: FlashLoadFormat,
    base_address: u32,
    data_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlashImageIdArgs {
    image_id: String,
}

/// `cmd_flash_download` over the bridge: no `onProgress` (a browser cannot pass a Tauri
/// Channel); any such field is ignored and only the final report is returned.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlashDownloadArgs {
    config: DiagSessionConfigDto,
    image_id: String,
    #[serde(default)]
    download: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlashCancelArgs {
    config: DiagSessionConfigDto,
}

/// Flash error without a transfer position (argument / worker failures).
fn flash_err(kind: FlashErrorKind, message: String) -> FlashError {
    FlashError {
        kind,
        phase: FlashPhase::RequestDownload,
        segment_index: None,
        address: None,
        offset: None,
        block_counter: None,
        last_nrc: None,
        last_nrc_name: None,
        diag_code: None,
        bytes_done: 0,
        segments_completed: 0,
        message,
    }
}

fn flash_bad_args(cmd: &str, e: serde_json::Error) -> Response {
    bad_request(flash_error_to_ipc(&flash_err(
        FlashErrorKind::InvalidConfig,
        format!("invalid arguments for {cmd}: {e}"),
    )))
}

/// Contract §4: native seed/key providers only for loopback peers AND
/// `NEXUS_BRIDGE_ALLOW_NATIVE_SEEDKEY=1`. An unknown peer (no `ConnectInfo`) is refused.
fn seedkey_policy(extensions: &Extensions) -> SeedKeyPolicy {
    let loopback = extensions
        .get::<ConnectInfo<SocketAddr>>()
        .is_some_and(|ConnectInfo(addr)| addr.ip().is_loopback());
    SeedKeyPolicy::bridge(loopback)
}

fn seedkey_bad_args(cmd: &str, e: serde_json::Error) -> Response {
    bad_request(
        SeedKeyError::InvalidInput(format!("invalid arguments for {cmd}: {e}")).to_ipc_string(),
    )
}

/// Flow library commands: blocking pool, errors `"[flowlib:<code>] msg"` via `bad_request`.
async fn run_flowlib<T, F>(engine: Arc<PipelineEngine>, f: F) -> Response
where
    T: serde::Serialize + Send + 'static,
    F: FnOnce(&PipelineEngine) -> Result<T, FlowLibError> + Send + 'static,
{
    match tokio::task::spawn_blocking(move || f(&engine)).await {
        Ok(Ok(v)) => ok_json(v),
        Ok(Err(e)) => bad_request(e.to_ipc_string()),
        Err(e) => bad_request(
            FlowLibError::Io(format!("flow library worker failed: {e}")).to_ipc_string(),
        ),
    }
}

/// Run store commands: blocking pool, errors `"[runstore:<code>] msg"` via `bad_request`.
async fn run_runstore<T, F>(engine: Arc<PipelineEngine>, f: F) -> Response
where
    T: serde::Serialize + Send + 'static,
    F: FnOnce(&PipelineEngine) -> Result<T, RunStoreError> + Send + 'static,
{
    match tokio::task::spawn_blocking(move || f(&engine)).await {
        Ok(Ok(v)) => ok_json(v),
        Ok(Err(e)) => bad_request(e.to_ipc_string()),
        Err(e) => {
            bad_request(RunStoreError::Io(format!("run store worker failed: {e}")).to_ipc_string())
        }
    }
}

fn flowlib_bad_args(cmd: &str, e: serde_json::Error) -> Response {
    bad_request(FlowLibError::Invalid(format!("invalid arguments for {cmd}: {e}")).to_ipc_string())
}

fn runstore_bad_args(cmd: &str, e: serde_json::Error) -> Response {
    bad_request(RunStoreError::Invalid(format!("invalid arguments for {cmd}: {e}")).to_ipc_string())
}

fn diag_bad_args(cmd: &str, e: serde_json::Error) -> Response {
    bad_request(
        DiagError::new(
            DiagErrorCode::InvalidInput,
            format!("invalid arguments for {cmd}: {e}"),
        )
        .to_ipc_string(),
    )
}

/// Runs a blocking UDS call on the tokio blocking pool; errors use the `"[diag:<code>] msg"`
/// wire format through the regular 400 `bad_request` path.
async fn run_diag<T, F>(engine: Arc<PipelineEngine>, f: F) -> Response
where
    T: serde::Serialize + Send + 'static,
    F: FnOnce(&PipelineEngine) -> Result<T, DiagError> + Send + 'static,
{
    match tokio::task::spawn_blocking(move || f(&engine)).await {
        Ok(Ok(v)) => ok_json(v),
        Ok(Err(e)) => bad_request(e.to_ipc_string()),
        Err(join_err) => bad_request(
            DiagError::new(
                DiagErrorCode::Internal,
                format!("diag worker failed: {join_err}"),
            )
            .to_ipc_string(),
        ),
    }
}

/// D-003 router. `None` = not a diag command.
async fn handle_diag_invoke(
    cmd: &str,
    payload: Value,
    engine: &Arc<PipelineEngine>,
) -> Option<Response> {
    macro_rules! args {
        ($ty:ty) => {
            match serde_json::from_value::<$ty>(payload) {
                Ok(a) => a,
                Err(e) => return Some(diag_bad_args(cmd, e)),
            }
        };
    }
    let engine = Arc::clone(engine);
    let resp = match cmd {
        "cmd_diag_open_session" => {
            let a = args!(DiagConfigArgs);
            run_diag(engine, move |e| e.cmd_diag_open_session(a.config)).await
        }
        "cmd_diag_close_session" => {
            let a = args!(DiagConfigArgs);
            run_diag(engine, move |e| {
                e.cmd_diag_close_session(a.config).map(|()| Value::Null)
            })
            .await
        }
        "cmd_diag_session_info" => {
            let a = args!(DiagConfigArgs);
            run_diag(engine, move |e| e.cmd_diag_session_info(a.config)).await
        }
        "cmd_diag_send_uds" => {
            let a = args!(DiagSendUdsArgs);
            run_diag(engine, move |e| {
                e.cmd_diag_send_uds(a.config, a.sid, a.sub_function, a.data, a.options)
            })
            .await
        }
        "cmd_diag_read_did" => {
            let a = args!(DiagReadDidArgs);
            run_diag(engine, move |e| {
                e.cmd_diag_read_did(a.config, a.did, a.origin)
            })
            .await
        }
        "cmd_diag_read_stored_dtcs" => {
            let a = args!(DiagReadDtcsArgs);
            run_diag(engine, move |e| {
                e.cmd_diag_read_stored_dtcs(a.config, a.status_mask, a.origin)
            })
            .await
        }
        "cmd_diag_set_tester_present" => {
            let a = args!(DiagTesterPresentArgs);
            run_diag(engine, move |e| {
                e.cmd_diag_set_tester_present(a.config, a.enabled, a.interval_ms)
            })
            .await
        }
        "cmd_diag_get_conversation" => {
            let a = args!(DiagConversationArgs);
            run_diag(engine, move |e| {
                e.cmd_diag_get_conversation(a.config, a.since_seq, a.max)
            })
            .await
        }
        "cmd_diag_get_isotp_frames" => {
            let a = args!(DiagConversationArgs);
            run_diag(engine, move |e| {
                e.cmd_diag_get_isotp_frames(a.config, a.since_seq, a.max)
            })
            .await
        }
        "cmd_diag_discover_ecus" => {
            let a = args!(DiagDiscoverEcusArgs);
            run_diag(engine, move |e| e.cmd_diag_discover_ecus(a.request)).await
        }
        "cmd_diag_passive_discovery_start" => {
            let a = args!(DiagBusArgs);
            run_diag(engine, move |e| {
                e.cmd_diag_passive_discovery_start(a.bus_id)
            })
            .await
        }
        "cmd_diag_passive_discovery_snapshot" => {
            let a = args!(DiagBusArgs);
            run_diag(engine, move |e| {
                e.cmd_diag_passive_discovery_snapshot(a.bus_id)
            })
            .await
        }
        "cmd_diag_passive_discovery_stop" => {
            let a = args!(DiagBusArgs);
            run_diag(engine, move |e| e.cmd_diag_passive_discovery_stop(a.bus_id)).await
        }
        "cmd_diag_physical_sweep" => {
            let a = args!(DiagPhysicalSweepArgs);
            run_diag(engine, move |e| e.cmd_diag_physical_sweep(a.request)).await
        }
        "cmd_diag_read_dtc_report" => {
            let a = args!(DiagReadDtcReportArgs);
            run_diag(engine, move |e| {
                e.cmd_diag_read_dtc_report(a.config, a.sub_function, a.params, a.options)
            })
            .await
        }
        _ => return None,
    };
    Some(resp)
}

// ─── RE Toolkit (re-toolkit-v1 §2.1 / §6, amendment 14) ──────────────────────────────────────
// Same camelCase args / JSON results as the Tauri commands in `src-tauri/src/commands.rs`;
// errors are the engine text (`"[re:<code>] …"` for R2a errors) in the regular 400
// `{"error": …}` body. Every engine call runs on the blocking pool (as `run_blocking` does in
// Tauri); `cmd_re_correlate` / `cmd_re_classify` / `cmd_re_dbc_generate` never run on the
// async workers.

/// Bounded `/ws/re` queue (snapshots); full -> drop + force a full resync.
const RE_WS_QUEUE: usize = 16;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReStartArgs {
    #[serde(default)]
    buses: Option<Vec<u8>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RePhaseArgs {
    phase: RePhase,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReMarkArgs {
    label: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReRowArgs {
    bus: u8,
    arb_id: u32,
    is_extended: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReFocusSetArgs {
    targets: Vec<ReTargetDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReScanFirstArgs {
    spec: ReScanFirstSpec,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReScanNextArgs {
    op: ReScanNextOp,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReScanResultsArgs {
    offset: u32,
    limit: u32,
    sort: ReScanSort,
}

fn re_bad_args(cmd: &str, e: serde_json::Error) -> Response {
    bad_request(ReError::Invalid(format!("invalid arguments for {cmd}: {e}")).to_string())
}

async fn run_re_blocking<T, F>(
    engine: Arc<PipelineEngine>,
    cmd: &'static str,
    f: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&PipelineEngine) -> Result<T, HalError> + Send + 'static,
{
    match tokio::task::spawn_blocking(move || f(&engine)).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(e.to_string()),
        Err(join_err) => Err(format!("{cmd} worker failed: {join_err}")),
    }
}

async fn run_re<T, F>(engine: Arc<PipelineEngine>, cmd: &'static str, f: F) -> Response
where
    T: serde::Serialize + Send + 'static,
    F: FnOnce(&PipelineEngine) -> Result<T, HalError> + Send + 'static,
{
    match run_re_blocking(engine, cmd, f).await {
        Ok(v) => ok_json(v),
        Err(msg) => bad_request(msg),
    }
}

/// RE router. `None` = not an RE invoke command.
async fn handle_re_invoke(
    cmd: &str,
    payload: Value,
    engine: &Arc<PipelineEngine>,
) -> Option<Response> {
    macro_rules! args {
        ($ty:ty, $name:literal) => {
            match serde_json::from_value::<$ty>(payload) {
                Ok(a) => a,
                Err(e) => return Some(re_bad_args($name, e)),
            }
        };
    }
    let engine = Arc::clone(engine);
    let resp = match cmd {
        "cmd_re_start" => {
            let a = args!(ReStartArgs, "cmd_re_start");
            run_re(engine, "cmd_re_start", move |e| Ok(e.cmd_re_start(a.buses))).await
        }
        "cmd_re_stop" => run_re(engine, "cmd_re_stop", |e| Ok(e.cmd_re_stop())).await,
        "cmd_re_reset" => run_re(engine, "cmd_re_reset", |e| Ok(e.cmd_re_reset())).await,
        "cmd_re_set_phase" => {
            let a = args!(RePhaseArgs, "cmd_re_set_phase");
            run_re(engine, "cmd_re_set_phase", move |e| {
                e.cmd_re_set_phase(a.phase)
            })
            .await
        }
        "cmd_re_mark" => {
            let a = args!(ReMarkArgs, "cmd_re_mark");
            run_re(engine, "cmd_re_mark", move |e| Ok(e.cmd_re_mark(&a.label))).await
        }
        "cmd_re_markers" => run_re(engine, "cmd_re_markers", |e| Ok(e.cmd_re_markers())).await,
        "cmd_re_row_detail" => {
            let a = args!(ReRowArgs, "cmd_re_row_detail");
            run_re(engine, "cmd_re_row_detail", move |e| {
                e.cmd_re_row_detail(a.bus, a.arb_id, a.is_extended)
            })
            .await
        }
        "cmd_re_classify" => {
            let a = args!(ReRowArgs, "cmd_re_classify");
            run_re(engine, "cmd_re_classify", move |e| {
                e.cmd_re_classify(a.bus, a.arb_id, a.is_extended)
            })
            .await
        }
        "cmd_re_focus_set" => {
            let a = args!(ReFocusSetArgs, "cmd_re_focus_set");
            run_re(engine, "cmd_re_focus_set", move |e| {
                e.cmd_re_focus_set(a.targets)
            })
            .await
        }
        "cmd_re_focus_status" => {
            run_re(engine, "cmd_re_focus_status", |e| {
                Ok(e.cmd_re_focus_status())
            })
            .await
        }
        "cmd_re_series" => {
            let req = args!(ReSeriesRequest, "cmd_re_series");
            match run_re_blocking(engine, "cmd_re_series", move |e| e.cmd_re_series(req)).await {
                // Same NRS1 bytes as the Tauri raw `Response` body.
                Ok(bytes) => (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "application/octet-stream")],
                    bytes,
                )
                    .into_response(),
                Err(msg) => bad_request(msg),
            }
        }
        "cmd_re_correlate" => {
            let req = args!(ReCorrelateRequest, "cmd_re_correlate");
            run_re(engine, "cmd_re_correlate", move |e| e.cmd_re_correlate(req)).await
        }
        // R2c (§8.3): value scan. first / next / results are CPU-bound (≤ 2 s budget) and run
        // on the blocking pool like every other RE call (`run_re` = spawn_blocking).
        "cmd_re_scan_first" => {
            let a = args!(ReScanFirstArgs, "cmd_re_scan_first");
            run_re(engine, "cmd_re_scan_first", move |e| {
                e.cmd_re_scan_first(a.spec)
            })
            .await
        }
        "cmd_re_scan_next" => {
            let a = args!(ReScanNextArgs, "cmd_re_scan_next");
            run_re(engine, "cmd_re_scan_next", move |e| {
                e.cmd_re_scan_next(a.op)
            })
            .await
        }
        "cmd_re_scan_undo" => run_re(engine, "cmd_re_scan_undo", |e| e.cmd_re_scan_undo()).await,
        "cmd_re_scan_reset" => {
            run_re(engine, "cmd_re_scan_reset", |e| Ok(e.cmd_re_scan_reset())).await
        }
        "cmd_re_scan_status" => {
            run_re(engine, "cmd_re_scan_status", |e| Ok(e.cmd_re_scan_status())).await
        }
        "cmd_re_scan_results" => {
            let a = args!(ReScanResultsArgs, "cmd_re_scan_results");
            run_re(engine, "cmd_re_scan_results", move |e| {
                e.cmd_re_scan_results(a.offset, a.limit, a.sort)
            })
            .await
        }
        // R2b (§7.3): pure generator, no engine state, no file system; blocking pool.
        "cmd_re_dbc_generate" => {
            let req = args!(ReDbcGenerateRequest, "cmd_re_dbc_generate");
            match tokio::task::spawn_blocking(move || {
                re_dbc_generate(&req.drafts, req.base.as_ref())
            })
            .await
            {
                Ok(Ok(v)) => ok_json(v),
                Ok(Err(e)) => bad_request(e.to_string()),
                Err(join_err) => {
                    bad_request(format!("cmd_re_dbc_generate worker failed: {join_err}"))
                }
            }
        }
        _ => return None,
    };
    Some(resp)
}

fn build_router(engine: Arc<PipelineEngine>, security: Arc<BridgeSecurity>) -> Router {
    let state = BridgeState {
        engine,
        security: Arc::clone(&security),
    };
    // Layer order (outermost last): host/origin guard -> CORS -> token guard -> routes.
    Router::new()
        .route("/api/health", get(handle_health))
        .route("/api/hardware/probe", get(handle_hardware_probe))
        .route("/api/debug/snapshot", get(handle_debug_snapshot))
        .route("/ws/telemetry", get(handle_ws_upgrade))
        .route("/ws/hardware", get(handle_hw_ws_upgrade))
        .route("/ws/debug", get(handle_debug_ws_upgrade))
        .route("/ws/re", get(handle_re_ws_upgrade))
        // Flash images arrive base64-encoded (≤ 64 MiB decoded ≈ 85.4 MiB of base64); axum's
        // default 2 MB body limit would reject them. Auth / Host guards run before the body.
        .route(
            "/api/invoke/{cmd}",
            post(handle_invoke).layer(DefaultBodyLimit::max(INVOKE_BODY_LIMIT)),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            api_token_guard,
        ))
        .layer(security.cors_layer())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            host_origin_guard,
        ))
        .with_state(state)
}

/// Binds `bind_addr`, then writes `token` to `token_path`. A failed bind leaves the token file
/// untouched (it belongs to the bridge that holds the port).
async fn bind_then_write_token(
    bind_addr: SocketAddr,
    token_path: &FsPath,
    token: &str,
) -> Result<tokio::net::TcpListener, String> {
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .map_err(|e| format!("cannot bind {bind_addr}: {e} (token file left unchanged)"))?;
    write_token_file(token_path, token)?;
    Ok(listener)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bind_addr: SocketAddr = std::env::var("NEXUS_BRIDGE_ADDR")
        .unwrap_or_else(|_| DEFAULT_BIND_ADDR.to_string())
        .parse()?;
    if !bind_addr.ip().is_loopback() {
        eprintln!(
            "WARNING: NexusCAN Bridge is binding to non-loopback address {bind_addr}. \
             Anyone who can reach this address and obtains the token can control your CAN buses."
        );
    }

    let token = resolve_token(std::env::var("NEXUS_BRIDGE_TOKEN").ok())?;
    let token_path = token_file_path()?;
    // Bind BEFORE publishing the token: a second instance on a busy port must not overwrite
    // the running bridge's token file (its UI session would get 401).
    let listener = bind_then_write_token(bind_addr, &token_path, &token).await?;
    let extra_origins = std::env::var("NEXUS_BRIDGE_ALLOWED_ORIGINS").unwrap_or_default();
    let security = Arc::new(BridgeSecurity::new(token, &extra_origins, bind_addr));

    let engine = Arc::new(PipelineEngine::new());
    let app = build_router(Arc::clone(&engine), Arc::clone(&security));

    println!("NexusCAN Bridge listening on http://{bind_addr} (WS: ws://{bind_addr}/ws/telemetry)");
    println!("Bridge auth token written to {}", token_path.display());
    println!("Allowed origins: {}", security.allowed_origins.join(", "));

    // ConnectInfo: the seed/key native-provider policy needs the TCP peer address.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;

    Ok(())
}

async fn handle_health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "engine": "nexus-hal"
    }))
}

async fn handle_hardware_probe(State(engine): State<Arc<PipelineEngine>>) -> Response {
    ok_json(engine.snapshot_hardware_state("initial"))
}

async fn handle_debug_snapshot(State(engine): State<Arc<PipelineEngine>>) -> Response {
    ok_json(engine.snapshot_debug_events())
}

async fn handle_ws_upgrade(ws: WebSocketUpgrade, State(state): State<BridgeState>) -> Response {
    ws.max_message_size(WS_MAX_CLIENT_MESSAGE)
        .max_frame_size(WS_MAX_CLIENT_MESSAGE)
        .on_upgrade(move |socket| ws_authenticate_then_stream(socket, state))
}

async fn handle_hw_ws_upgrade(ws: WebSocketUpgrade, State(state): State<BridgeState>) -> Response {
    ws.max_message_size(WS_MAX_CLIENT_MESSAGE)
        .max_frame_size(WS_MAX_CLIENT_MESSAGE)
        .on_upgrade(move |socket| ws_authenticate_then_stream_hardware(socket, state))
}

async fn handle_debug_ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<BridgeState>,
) -> Response {
    ws.max_message_size(WS_MAX_CLIENT_MESSAGE)
        .max_frame_size(WS_MAX_CLIENT_MESSAGE)
        .on_upgrade(move |socket| ws_authenticate_then_stream_debug(socket, state))
}

/// `true` if `msg` is `{"type":"auth","token":"<token>"}` with the right token.
fn ws_auth_message_ok(msg: &Message, security: &BridgeSecurity) -> bool {
    let Message::Text(text) = msg else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else {
        return false;
    };
    v.get("type").and_then(Value::as_str) == Some("auth")
        && v.get("token")
            .and_then(Value::as_str)
            .is_some_and(|t| security.token_matches(t))
}

async fn ws_authenticate_then_stream(mut socket: WebSocket, state: BridgeState) {
    let authed = match tokio::time::timeout(WS_AUTH_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(msg))) => ws_auth_message_ok(&msg, &state.security),
        _ => false,
    };
    if !authed {
        let _ = socket
            .send(Message::Close(Some(CloseFrame {
                code: WS_CLOSE_UNAUTHORIZED,
                reason: "unauthorized".into(),
            })))
            .await;
        return;
    }
    stream_telemetry_ws(socket, state.engine).await;
}

async fn ws_authenticate_then_stream_hardware(mut socket: WebSocket, state: BridgeState) {
    let authed = match tokio::time::timeout(WS_AUTH_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(msg))) => ws_auth_message_ok(&msg, &state.security),
        _ => false,
    };
    if !authed {
        let _ = socket
            .send(Message::Close(Some(CloseFrame {
                code: WS_CLOSE_UNAUTHORIZED,
                reason: "unauthorized".into(),
            })))
            .await;
        return;
    }
    stream_hardware_ws(socket, state.engine).await;
}

async fn handle_re_ws_upgrade(ws: WebSocketUpgrade, State(state): State<BridgeState>) -> Response {
    ws.max_message_size(WS_MAX_CLIENT_MESSAGE)
        .max_frame_size(WS_MAX_CLIENT_MESSAGE)
        .on_upgrade(move |socket| ws_authenticate_then_stream_re(socket, state))
}

async fn ws_authenticate_then_stream_re(mut socket: WebSocket, state: BridgeState) {
    let authed = match tokio::time::timeout(WS_AUTH_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(msg))) => ws_auth_message_ok(&msg, &state.security),
        _ => false,
    };
    if !authed {
        let _ = socket
            .send(Message::Close(Some(CloseFrame {
                code: WS_CLOSE_UNAUTHORIZED,
                reason: "unauthorized".into(),
            })))
            .await;
        return;
    }
    stream_re_ws(socket, state.engine).await;
}

/// `/ws/re`: subscribes the RE snapshot thread (replacing any older subscriber, Tauri or WS)
/// and forwards each snapshot as one binary message. The sink never blocks the snapshot
/// thread: queue full -> drop + full resync next tick; client gone -> `false` ends it.
async fn stream_re_ws(mut socket: WebSocket, engine: Arc<PipelineEngine>) {
    let (tx, mut rx) = mpsc::channel::<Bytes>(RE_WS_QUEUE);
    let resync = Arc::new(AtomicBool::new(false));
    let sink_resync = Arc::clone(&resync);
    let sink: nexus_hal::pipeline::ReSnapshotSink =
        Box::new(
            move |bytes: &[u8]| match tx.try_send(Bytes::copy_from_slice(bytes)) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    sink_resync.store(true, Ordering::Release);
                    true
                }
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            },
        );
    let eng = Arc::clone(&engine);
    let subscribed =
        tokio::task::spawn_blocking(move || eng.cmd_re_subscribe_with_resync(sink, resync)).await;
    match subscribed {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = socket
                .send(Message::Close(Some(CloseFrame {
                    code: 1011,
                    reason: e.to_string().chars().take(100).collect::<String>().into(),
                })))
                .await;
            return;
        }
        Err(_) => return,
    }

    loop {
        tokio::select! {
            snap = rx.recv() => {
                match snap {
                    Some(bytes) => {
                        if socket.send(Message::Binary(bytes)).await.is_err() {
                            break;
                        }
                    }
                    None => {
                        // Backend ended the subscription (cmd_re_stop / newer subscriber).
                        let _ = socket
                            .send(Message::Close(Some(CloseFrame {
                                code: 1000,
                                reason: "re subscription ended".into(),
                            })))
                            .await;
                        break;
                    }
                }
            }
            client_msg = socket.recv() => {
                match client_msg {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    // Dropping `rx` makes the sink return false on its next tick, ending the subscription.
}

async fn ws_authenticate_then_stream_debug(mut socket: WebSocket, state: BridgeState) {
    let authed = match tokio::time::timeout(WS_AUTH_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(msg))) => ws_auth_message_ok(&msg, &state.security),
        _ => false,
    };
    if !authed {
        let _ = socket
            .send(Message::Close(Some(CloseFrame {
                code: WS_CLOSE_UNAUTHORIZED,
                reason: "unauthorized".into(),
            })))
            .await;
        return;
    }
    stream_debug_ws(socket, state.engine).await;
}

async fn stream_debug_ws(mut socket: WebSocket, engine: Arc<PipelineEngine>) {
    let mut rx = engine.subscribe_debug_events();
    let initial = engine.snapshot_debug_events();
    if let Ok(json_str) = serde_json::to_string(&initial) {
        if socket.send(Message::Text(json_str.into())).await.is_err() {
            return;
        }
    }

    loop {
        tokio::select! {
            batch_res = rx.recv() => {
                match batch_res {
                    Ok(batch) => {
                        if let Ok(json_str) = serde_json::to_string(&batch) {
                            if socket.send(Message::Text(json_str.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(RecvError::Lagged(_)) => {
                        let snap = engine.snapshot_debug_events();
                        if let Ok(json_str) = serde_json::to_string(&snap) {
                            if socket.send(Message::Text(json_str.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(RecvError::Closed) => break,
                }
            }
            client_msg = socket.recv() => {
                match client_msg {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn stream_hardware_ws(mut socket: WebSocket, engine: Arc<PipelineEngine>) {
    let mut rx = engine.subscribe_hardware_changes();
    let initial = engine.snapshot_hardware_state("initial");
    if let Ok(json_str) = serde_json::to_string(&initial) {
        if socket.send(Message::Text(json_str.into())).await.is_err() {
            return;
        }
    }

    loop {
        tokio::select! {
            evt_res = rx.recv() => {
                match evt_res {
                    Ok(evt) => {
                        if let Ok(json_str) = serde_json::to_string(&evt) {
                            if socket.send(Message::Text(json_str.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                }
            }
            client_msg = socket.recv() => {
                match client_msg {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn stream_telemetry_ws(mut socket: WebSocket, engine: Arc<PipelineEngine>) {
    let mut rx = engine.subscribe();

    if let Some(initial) = engine.latest_snapshot() {
        if let Ok(json_str) = serde_json::to_string(&initial) {
            if socket.send(Message::Text(json_str.into())).await.is_err() {
                return;
            }
        }
    }

    loop {
        tokio::select! {
            snap_res = rx.recv() => {
                match snap_res {
                    Ok(snapshot) => {
                        if let Ok(json_str) = serde_json::to_string(&snapshot) {
                            if socket.send(Message::Text(json_str.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                }
            }
            client_msg = socket.recv() => {
                match client_msg {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

fn bad_request(msg: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": msg.into() })),
    )
        .into_response()
}

fn ok_json<T: serde::Serialize>(val: T) -> Response {
    match serde_json::to_value(val) {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => bad_request(format!("Response serialization error: {e}")),
    }
}

async fn handle_invoke(
    Path(cmd): Path<String>,
    State(engine): State<Arc<PipelineEngine>>,
    extensions: Extensions,
    body: Bytes,
) -> Response {
    let payload: Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => return bad_request(format!("Invalid JSON request body: {e}")),
        }
    };

    if cmd.starts_with("cmd_diag_") {
        if let Some(resp) = handle_diag_invoke(&cmd, payload.clone(), &engine).await {
            return resp;
        }
    }
    if cmd.starts_with("cmd_re_") {
        if let Some(resp) = handle_re_invoke(&cmd, payload.clone(), &engine).await {
            return resp;
        }
    }

    match cmd.as_str() {
        "cmd_list_devices" => ok_json(engine.cmd_list_devices()),
        "cmd_probe_drivers" => ok_json(engine.cmd_probe_drivers()),
        "cmd_subscribe_hardware_changes" => ok_json(json!({
            "subscribed": true,
            "wsPath": "/ws/hardware",
            "initial": engine.snapshot_hardware_state("initial")
        })),
        "cmd_connect_bus" => {
            let args: ConnectBusArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_connect_bus: {e}"))
                }
            };
            match engine.cmd_connect_bus(args.device_id, args.config) {
                Ok(res) => ok_json(res),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_disconnect_bus" => {
            let args: DisconnectBusArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_disconnect_bus: {e}"))
                }
            };
            match engine.cmd_disconnect_bus(args.bus_id) {
                Ok(()) => ok_json(Value::Null),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_disconnect_all_buses" => ok_json(engine.cmd_disconnect_all_buses()),
        "cmd_arm_active_bus" => {
            let args: ArmBusArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_arm_active_bus: {e}"))
                }
            };
            match engine.cmd_arm_active_bus(args.bus_id, args.armed) {
                Ok(res) => ok_json(res),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_set_bus_mode" => {
            let args: SetBusModeArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_set_bus_mode: {e}"))
                }
            };
            match engine.cmd_set_bus_mode(args.bus_id, args.listen_only, args.arm_tx) {
                Ok(res) => ok_json(res),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_panic_stop_tx" => ok_json(engine.cmd_panic_stop_tx()),
        "cmd_clear_panic_latch" => {
            engine.cmd_clear_panic_latch();
            ok_json(Value::Null)
        }
        "cmd_reset_session" => {
            let eng = Arc::clone(&engine);
            match tokio::task::spawn_blocking(move || eng.cmd_reset_session()).await {
                Ok(res) => ok_json(res),
                Err(e) => bad_request(format!("reset session worker failed: {e}")),
            }
        }
        "cmd_seedkey_capabilities" => {
            let policy = seedkey_policy(&extensions);
            let eng = Arc::clone(&engine);
            match tokio::task::spawn_blocking(move || eng.cmd_seedkey_capabilities(policy)).await {
                Ok(caps) => ok_json(caps),
                Err(e) => bad_request(
                    SeedKeyError::Script(format!("seed/key worker failed: {e}")).to_ipc_string(),
                ),
            }
        }
        "cmd_seedkey_compute_adhoc" => {
            let args: SeedKeyComputeAdhocArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => return seedkey_bad_args("cmd_seedkey_compute_adhoc", e),
            };
            let policy = seedkey_policy(&extensions);
            let eng = Arc::clone(&engine);
            match tokio::task::spawn_blocking(move || {
                eng.cmd_seedkey_compute_adhoc(policy, &args.provider, args.level, &args.seed_hex)
            })
            .await
            {
                Ok(Ok(res)) => ok_json(res),
                Ok(Err(e)) => bad_request(e.to_ipc_string()),
                Err(e) => bad_request(
                    SeedKeyError::Script(format!("seed/key worker failed: {e}")).to_ipc_string(),
                ),
            }
        }
        "cmd_flash_load_image" => {
            let args: FlashLoadImageArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(
                        FirmwareError::InvalidArgument(format!(
                            "invalid arguments for cmd_flash_load_image: {e}"
                        ))
                        .to_ipc_string(),
                    )
                }
            };
            let eng = Arc::clone(&engine);
            match tokio::task::spawn_blocking(move || {
                eng.cmd_flash_load_image(
                    args.file_name,
                    args.format,
                    args.base_address,
                    &args.data_base64,
                )
            })
            .await
            {
                Ok(Ok(res)) => ok_json(res),
                Ok(Err(e)) => bad_request(e.to_ipc_string()),
                Err(e) => bad_request(
                    FirmwareError::InvalidArgument(format!("firmware worker failed: {e}"))
                        .to_ipc_string(),
                ),
            }
        }
        "cmd_flash_release_image" => {
            let args: FlashImageIdArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => return flash_bad_args("cmd_flash_release_image", e),
            };
            engine.cmd_flash_release_image(&args.image_id);
            ok_json(Value::Null)
        }
        "cmd_flash_download" => {
            let args: FlashDownloadArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => return flash_bad_args("cmd_flash_download", e),
            };
            let download = match resolve_download_config(
                args.download.unwrap_or_default(),
                args.config.use_fd,
            ) {
                Ok(d) => d,
                Err(e) => return bad_request(flash_error_to_ipc(&e)),
            };
            let eng = Arc::clone(&engine);
            // Bridge: final report only (progress is a Tauri Channel feature).
            match tokio::task::spawn_blocking(move || {
                eng.cmd_flash_download(args.config, &args.image_id, download, &mut |_| {})
            })
            .await
            {
                Ok(Ok(res)) => ok_json(res),
                Ok(Err(e)) => bad_request(flash_error_to_ipc(&e)),
                Err(e) => bad_request(flash_error_to_ipc(&flash_err(
                    FlashErrorKind::Transport,
                    format!("flash worker failed: {e}"),
                ))),
            }
        }
        "cmd_flash_cancel" => {
            let args: FlashCancelArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => return flash_bad_args("cmd_flash_cancel", e),
            };
            engine.cmd_flash_cancel(&args.config);
            ok_json(Value::Null)
        }
        "cmd_seedkey_probe_library" => {
            let args: SeedKeyProbeLibraryArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => return seedkey_bad_args("cmd_seedkey_probe_library", e),
            };
            let policy = seedkey_policy(&extensions);
            let eng = Arc::clone(&engine);
            match tokio::task::spawn_blocking(move || {
                eng.cmd_seedkey_probe_library(policy, &args.path)
            })
            .await
            {
                Ok(Ok(res)) => ok_json(res),
                Ok(Err(e)) => bad_request(e.to_ipc_string()),
                Err(e) => bad_request(
                    SeedKeyError::Script(format!("seed/key worker failed: {e}")).to_ipc_string(),
                ),
            }
        }
        "cmd_load_preset_databases" => match engine.cmd_load_preset_databases() {
            Ok(schema) => ok_json(schema),
            Err(e) => bad_request(e.to_string()),
        },
        "cmd_get_preset_database_files" => match engine.cmd_get_preset_database_files() {
            Ok(files) => ok_json(files),
            Err(e) => bad_request(e.to_string()),
        },
        "cmd_parse_database_schema" => {
            let args: ParseDatabaseSchemaArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!(
                        "Invalid arguments for cmd_parse_database_schema: {e}"
                    ))
                }
            };
            match engine.cmd_parse_database_schema(args.file_name, args.content_base64) {
                Ok(schema) => ok_json(schema),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_set_bus_databases" => {
            let args: SetBusDatabasesArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_set_bus_databases: {e}"))
                }
            };
            match engine.cmd_set_bus_databases(args.bus_id, args.files) {
                Ok(schema_opt) => ok_json(schema_opt),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_get_current_schema" => ok_json(engine.cmd_get_current_schema()),
        "cmd_clear_database" => match engine.cmd_clear_database() {
            Ok(()) => ok_json(Value::Null),
            Err(e) => bad_request(e.to_string()),
        },
        "cmd_reset_telemetry" => match engine.cmd_reset_telemetry() {
            Ok(()) => ok_json(Value::Null),
            Err(e) => bad_request(e.to_string()),
        },
        "cmd_load_database_content" => {
            let args: LoadDatabaseContentArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!(
                        "Invalid arguments for cmd_load_database_content: {e}"
                    ))
                }
            };
            match engine.cmd_load_database_content(
                args.file_name,
                args.content_base64,
                args.append_to_existing,
            ) {
                Ok(schema) => ok_json(schema),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_subscribe_telemetry" => ok_json(json!({
            "subscribed": true,
            "wsPath": "/ws/telemetry"
        })),
        "cmd_transmit_signal_frame" => {
            let args: TransmitSignalFrameArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!(
                        "Invalid arguments for cmd_transmit_signal_frame: {e}"
                    ))
                }
            };
            match engine.cmd_transmit_signal_frame(
                args.bus_id,
                args.arb_id,
                args.is_extended,
                args.signal_values,
                args.periodic_ms,
                args.job_label,
            ) {
                Ok(res) => ok_json(res),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_transmit_raw_frame" => {
            let args: TransmitRawFrameArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!(
                        "Invalid arguments for cmd_transmit_raw_frame: {e}"
                    ))
                }
            };
            match engine.cmd_transmit_raw_frame(
                args.bus_id,
                args.arb_id,
                args.is_extended,
                args.is_fd,
                args.is_brs,
                args.data,
                args.periodic_ms,
                args.job_label,
            ) {
                Ok(res) => ok_json(res),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_stop_periodic_tx" => {
            let args: StopPeriodicTxArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_stop_periodic_tx: {e}"))
                }
            };
            match engine.cmd_stop_periodic_tx(args.job_id) {
                Ok(()) => ok_json(Value::Null),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_list_periodic_tx" => ok_json(engine.cmd_list_periodic_tx()),
        "cmd_flowlib_list" => {
            let args: FlowLibListArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => return flowlib_bad_args("cmd_flowlib_list", e),
            };
            run_flowlib(engine, move |e| e.cmd_flowlib_list(args.include_deleted)).await
        }
        "cmd_flowlib_revisions" => {
            let args: FlowLibIdArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => return flowlib_bad_args("cmd_flowlib_revisions", e),
            };
            run_flowlib(engine, move |e| e.cmd_flowlib_revisions(&args.id)).await
        }
        "cmd_flowlib_load" => {
            let args: FlowLibLoadArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => return flowlib_bad_args("cmd_flowlib_load", e),
            };
            run_flowlib(engine, move |e| e.cmd_flowlib_load(&args.id, args.revision)).await
        }
        "cmd_flowlib_save" => {
            let args: FlowLibSaveArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => return flowlib_bad_args("cmd_flowlib_save", e),
            };
            run_flowlib(engine, move |e| e.cmd_flowlib_save(&args.file_json)).await
        }
        "cmd_flowlib_delete" => {
            let args: FlowLibIdArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => return flowlib_bad_args("cmd_flowlib_delete", e),
            };
            run_flowlib(engine, move |e| e.cmd_flowlib_delete(&args.id)).await
        }
        "cmd_run_append" => {
            let args: RunAppendArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => return runstore_bad_args("cmd_run_append", e),
            };
            run_runstore(engine, move |e| e.cmd_run_append(&args.record)).await
        }
        "cmd_run_query" => {
            let args: RunQueryArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => return runstore_bad_args("cmd_run_query", e),
            };
            run_runstore(engine, move |e| {
                e.cmd_run_query(&args.project_id, &args.filter, args.limit)
            })
            .await
        }
        "cmd_run_latest" => {
            let args: RunProjectArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => return runstore_bad_args("cmd_run_latest", e),
            };
            run_runstore(engine, move |e| e.cmd_run_latest(&args.project_id)).await
        }
        "cmd_list_projects" => match engine.cmd_list_projects() {
            Ok(list) => ok_json(list),
            Err(e) => bad_request(e.to_string()),
        },
        "cmd_save_project" => {
            let args: SaveProjectArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_save_project: {e}"))
                }
            };
            match engine.cmd_save_project(args.file_stem, args.project_json) {
                Ok(summary) => ok_json(summary),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_load_project" => {
            let args: ProjectStemArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_load_project: {e}"))
                }
            };
            match engine.cmd_load_project(args.file_stem) {
                Ok(raw_json) => ok_json(raw_json),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_delete_project" => {
            let args: ProjectStemArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_delete_project: {e}"))
                }
            };
            match engine.cmd_delete_project(args.file_stem) {
                Ok(()) => ok_json(Value::Null),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_list_traces" => match engine.cmd_list_traces() {
            Ok(info) => ok_json(info),
            Err(e) => bad_request(e.to_string()),
        },
        "cmd_save_trace_file" => {
            let args: TraceFileContentArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_save_trace_file: {e}"))
                }
            };
            match engine.cmd_save_trace_file(args.file_name, args.content, args.content_base64) {
                Ok(summary) => ok_json(summary),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_load_trace_file" => {
            let args: TraceFileNameArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_load_trace_file: {e}"))
                }
            };
            match engine.cmd_load_trace_file(args.file_name) {
                Ok(loaded) => ok_json(loaded),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_delete_trace_file" => {
            let args: TraceFileNameArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_delete_trace_file: {e}"))
                }
            };
            match engine.cmd_delete_trace_file(args.file_name) {
                Ok(()) => ok_json(Value::Null),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_parse_trace_content" => {
            let args: TraceFileContentArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!(
                        "Invalid arguments for cmd_parse_trace_content: {e}"
                    ))
                }
            };
            match engine.cmd_parse_trace_content(args.file_name, args.content, args.content_base64)
            {
                Ok(loaded) => ok_json(loaded),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_export_trace_blf" => {
            let args: ExportTraceBlfArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!("Invalid arguments for cmd_export_trace_blf: {e}"))
                }
            };
            match engine.cmd_export_trace_blf(args.file_name, args.frames) {
                Ok(b64) => ok_json(b64),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_start_trace_replay" => {
            let raw_args = payload.get("args").cloned().unwrap_or(payload);
            let args: StartTraceReplayArgsDto = match serde_json::from_value(raw_args) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!(
                        "Invalid arguments for cmd_start_trace_replay: {e}"
                    ))
                }
            };
            match engine.cmd_start_trace_replay(args) {
                Ok(status) => ok_json(status),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_control_trace_replay" => {
            let raw_args = payload.get("args").cloned().unwrap_or(payload);
            let args: TraceReplayControlArgsDto = match serde_json::from_value(raw_args) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!(
                        "Invalid arguments for cmd_control_trace_replay: {e}"
                    ))
                }
            };
            match engine.cmd_control_trace_replay(args) {
                Ok(status) => ok_json(status),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_subscribe_debug_events" => ok_json(json!({
            "subscribed": true,
            "wsPath": "/ws/debug",
            "initial": engine.snapshot_debug_events()
        })),
        "cmd_append_debug_event" => {
            let raw_input = payload.get("input").cloned().unwrap_or(payload);
            let input: AppendDebugEventInputDto = match serde_json::from_value(raw_input) {
                Ok(i) => i,
                Err(e) => {
                    return bad_request(format!(
                        "Invalid arguments for cmd_append_debug_event: {e}"
                    ))
                }
            };
            ok_json(engine.cmd_append_debug_event(input))
        }
        "cmd_clear_debug_events" => {
            engine.cmd_clear_debug_events();
            ok_json(Value::Null)
        }
        "cmd_export_debug_events" => {
            let args: ExportDebugEventsArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!(
                        "Invalid arguments for cmd_export_debug_events: {e}"
                    ))
                }
            };
            match engine.cmd_export_debug_events(args.format) {
                Ok(out) => ok_json(out),
                Err(e) => bad_request(e.to_string()),
            }
        }
        "cmd_set_debug_window_open" => {
            let args: SetDebugWindowOpenArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(format!(
                        "Invalid arguments for cmd_set_debug_window_open: {e}"
                    ))
                }
            };
            let ws = engine.set_debug_window_state(
                args.open,
                args.always_on_top.unwrap_or(false),
                args.redock.unwrap_or(false),
            );
            ok_json(ws)
        }
        unknown => bad_request(format!("Unknown NexusCAN IPC command: '{unknown}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use nexus_hal::DriverRegistry;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    const TEST_TOKEN: &str = "0123456789abcdef0123456789abcdef-test";

    fn test_security() -> Arc<BridgeSecurity> {
        Arc::new(BridgeSecurity::new(
            TEST_TOKEN.to_string(),
            "",
            "127.0.0.1:14210".parse().expect("addr"),
        ))
    }

    // ─── WP-1 pure security helpers ─────────────────────────────────────────

    #[test]
    fn host_header_parsing_and_rebinding_rules() {
        let sec = test_security();
        for ok in [
            "localhost",
            "localhost:14210",
            "LOCALHOST:5173",
            "127.0.0.1",
            "127.0.0.1:1",
            "[::1]",
            "[::1]:14210",
        ] {
            assert!(sec.host_allowed(ok), "{ok} must be allowed");
        }
        for bad in [
            "",
            "evil.example",
            "evil.example:14210",
            "localhost.evil.example",
            "127.0.0.1.nip.io",
            "localhost:abc",
            "localhost:",
            ":14210",
            "[::1]x",
            "::1",
            "0.0.0.0:14210",
            "192.168.1.5",
            "localhost:14210:1",
        ] {
            assert!(!sec.host_allowed(bad), "{bad} must be rejected");
        }
        let lan = BridgeSecurity::new(TEST_TOKEN.into(), "", "192.168.1.5:14210".parse().unwrap());
        assert!(lan.host_allowed("192.168.1.5:14210"));
        assert!(!lan.host_allowed("192.168.1.6:14210"));
        let any = BridgeSecurity::new(TEST_TOKEN.into(), "", "0.0.0.0:14210".parse().unwrap());
        assert!(
            !any.host_allowed("0.0.0.0:14210"),
            "wildcard bind is never a valid Host"
        );
        assert!(any.host_allowed("localhost:14210"));
    }

    #[test]
    fn origin_allowlist_and_env_extension() {
        let sec = BridgeSecurity::new(
            TEST_TOKEN.into(),
            " https://hmi.lab.local/ , null,,http://127.0.0.1:4173",
            "127.0.0.1:14210".parse().unwrap(),
        );
        assert!(sec.origin_allowed("http://localhost:5173"));
        assert!(sec.origin_allowed("http://127.0.0.1:5173"));
        assert!(sec.origin_allowed("https://hmi.lab.local"));
        assert!(sec.origin_allowed("http://127.0.0.1:4173"));
        assert!(!sec.origin_allowed("null"));
        assert!(!sec.origin_allowed("http://localhost:5174"));
        assert!(!sec.origin_allowed("http://evil.example"));
    }

    #[test]
    fn token_resolution_compare_and_bearer_parsing() {
        assert!(resolve_token(Some("short".into())).is_err());
        assert!(resolve_token(Some(format!("{}x y", "a".repeat(32)))).is_err());
        assert_eq!(resolve_token(Some(TEST_TOKEN.into())).unwrap(), TEST_TOKEN);
        let a = resolve_token(None).unwrap();
        let b = resolve_token(None).unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "random tokens must differ");

        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));

        let mut h = HeaderMap::new();
        h.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("bearer   tok123 "),
        );
        assert_eq!(bearer_token(&h), Some("tok123"));
        h.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Basic tok123"),
        );
        assert_eq!(bearer_token(&h), None);
    }

    #[cfg(unix)]
    #[test]
    fn token_file_is_private_and_atomically_replaced() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("nexuscan-tokentest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("sub").join("bridge.token");
        write_token_file(&path, "first-token").expect("write 1");
        write_token_file(&path, "second-token").expect("write 2");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second-token");
        let fmode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        let dmode = std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(fmode, 0o600);
        assert_eq!(dmode, 0o700);
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp file left behind");
        // A symlinked directory is refused.
        let link_dir = dir.join("link");
        std::os::unix::fs::symlink(path.parent().unwrap(), &link_dir).unwrap();
        assert!(write_token_file(&link_dir.join("bridge.token"), "x").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ─── WP-1 end-to-end over a real socket (raw HTTP / WebSocket) ──────────

    #[tokio::test]
    async fn busy_port_leaves_running_bridges_token_file_unchanged() {
        let dir = std::env::temp_dir().join(format!("nexuscan-bindtest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("bridge.token");
        // "Running bridge": holds the port and published its token.
        let first = bind_then_write_token("127.0.0.1:0".parse().unwrap(), &path, "running-token")
            .await
            .expect("first instance");
        let busy = first.local_addr().expect("addr");
        // Second instance on the same port: bind fails, token file untouched.
        let err = bind_then_write_token(busy, &path, "intruder-token")
            .await
            .unwrap_err();
        assert!(err.contains("token file left unchanged"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "running-token");
        drop(first);
        // A free port publishes the new token.
        let _ok = bind_then_write_token("127.0.0.1:0".parse().unwrap(), &path, "next-token")
            .await
            .expect("free port");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "next-token");
        let _ = std::fs::remove_dir_all(&dir);
    }

    async fn spawn_server() -> SocketAddr {
        let engine = Arc::new(PipelineEngine::new());
        let app = build_router(engine, test_security());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        addr
    }

    /// Sends one raw HTTP/1.1 request; returns (status, raw response text).
    async fn raw_http(
        addr: SocketAddr,
        method: &str,
        path: &str,
        headers: &[(&str, String)],
        body: &str,
    ) -> (u16, String) {
        let mut req = format!(
            "{method} {path} HTTP/1.1\r\nConnection: close\r\nContent-Length: {}\r\n",
            body.len()
        );
        for (k, v) in headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("\r\n");
        req.push_str(body);
        let mut stream = TcpStream::connect(addr).await.expect("connect");
        stream.write_all(req.as_bytes()).await.expect("write");
        let mut buf = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut buf))
            .await
            .expect("response timeout")
            .expect("read");
        let text = String::from_utf8_lossy(&buf).to_string();
        let status = text
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        (status, text)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bridge_rejects_missing_token_foreign_origin_and_rebinding_host() {
        let addr = spawn_server().await;
        let host = ("Host", format!("127.0.0.1:{}", addr.port()));
        let auth = ("Authorization", format!("Bearer {TEST_TOKEN}"));
        let ct = ("Content-Type", "application/json".to_string());
        let invoke = "/api/invoke/cmd_list_devices";

        let (st, body) = raw_http(addr, "POST", invoke, &[host.clone(), ct.clone()], "{}").await;
        assert_eq!(st, 401, "{body}");
        assert!(body.contains(r#"{"error":"unauthorized"}"#), "{body}");

        let wrong = ("Authorization", format!("Bearer {TEST_TOKEN}x"));
        let (st, _) = raw_http(
            addr,
            "POST",
            invoke,
            &[host.clone(), wrong, ct.clone()],
            "{}",
        )
        .await;
        assert_eq!(st, 401);

        let (st, _) = raw_http(addr, "GET", "/api/health", std::slice::from_ref(&host), "").await;
        assert_eq!(st, 401, "health is under /api/* and needs the token too");

        let (st, body) = raw_http(
            addr,
            "POST",
            invoke,
            &[host.clone(), auth.clone(), ct.clone()],
            "{}",
        )
        .await;
        assert_eq!(st, 200, "{body}");
        assert!(body.contains("mock:mock0"));

        // DNS rebinding: valid token, attacker-controlled Host.
        let evil_host = ("Host", format!("evil.example:{}", addr.port()));
        let (st, _) = raw_http(
            addr,
            "POST",
            invoke,
            &[evil_host, auth.clone(), ct.clone()],
            "{}",
        )
        .await;
        assert_eq!(st, 403);

        // Foreign Origin (browser "simple request" CSRF): valid token, still refused.
        let evil_origin = ("Origin", "http://evil.example".to_string());
        let (st, _) = raw_http(
            addr,
            "POST",
            invoke,
            &[host.clone(), evil_origin.clone(), auth.clone(), ct.clone()],
            "{}",
        )
        .await;
        assert_eq!(st, 403);

        // Allowed origin: 200 with an exact (non-wildcard) CORS header.
        let good_origin = ("Origin", "http://localhost:5173".to_string());
        let (st, body) = raw_http(
            addr,
            "POST",
            invoke,
            &[host.clone(), good_origin.clone(), auth.clone(), ct.clone()],
            "{}",
        )
        .await;
        assert_eq!(st, 200);
        let lower = body.to_ascii_lowercase();
        assert!(
            lower.contains("access-control-allow-origin: http://localhost:5173"),
            "{body}"
        );
        // ...and a missing token from an allowed origin is a readable 401 (CORS headers present).
        let (st, body) = raw_http(
            addr,
            "POST",
            invoke,
            &[host.clone(), good_origin.clone(), ct.clone()],
            "{}",
        )
        .await;
        assert_eq!(st, 401);
        assert!(body
            .to_ascii_lowercase()
            .contains("access-control-allow-origin: http://localhost:5173"));

        // CORS preflight needs no token; foreign origin preflight is refused.
        let pf = [
            ("Access-Control-Request-Method", "POST".to_string()),
            (
                "Access-Control-Request-Headers",
                "authorization,content-type".to_string(),
            ),
        ];
        let (st, body) = raw_http(
            addr,
            "OPTIONS",
            invoke,
            &[host.clone(), good_origin, pf[0].clone(), pf[1].clone()],
            "",
        )
        .await;
        assert!((200..300).contains(&st), "{body}");
        let lower = body.to_ascii_lowercase();
        assert!(
            lower.contains("access-control-allow-origin: http://localhost:5173"),
            "{body}"
        );
        assert!(lower.contains("authorization"), "{body}");
        let (st, _) = raw_http(
            addr,
            "OPTIONS",
            invoke,
            &[host, evil_origin, pf[0].clone(), pf[1].clone()],
            "",
        )
        .await;
        assert_eq!(st, 403);
    }

    async fn ws_connect(addr: SocketAddr, extra: &[(&str, String)]) -> (u16, TcpStream) {
        ws_connect_path(addr, "/ws/telemetry", extra).await
    }

    async fn ws_connect_path(
        addr: SocketAddr,
        path: &str,
        extra: &[(&str, String)],
    ) -> (u16, TcpStream) {
        let mut req = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n",
            addr.port()
        );
        for (k, v) in extra {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("\r\n");
        let mut stream = TcpStream::connect(addr).await.expect("connect");
        stream.write_all(req.as_bytes()).await.expect("write");
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut byte))
                .await
                .expect("handshake timeout")
                .expect("read");
            if n == 0 {
                break;
            }
            head.push(byte[0]);
        }
        let text = String::from_utf8_lossy(&head);
        let status = text
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        (status, stream)
    }

    /// Reads one server frame: (opcode, payload).
    async fn ws_read_frame(stream: &mut TcpStream, wait: Duration) -> Option<(u8, Vec<u8>)> {
        tokio::time::timeout(wait, async {
            let mut h = [0u8; 2];
            stream.read_exact(&mut h).await.ok()?;
            let mut len = u64::from(h[1] & 0x7F);
            if len == 126 {
                let mut b = [0u8; 2];
                stream.read_exact(&mut b).await.ok()?;
                len = u64::from(u16::from_be_bytes(b));
            } else if len == 127 {
                let mut b = [0u8; 8];
                stream.read_exact(&mut b).await.ok()?;
                len = u64::from_be_bytes(b);
            }
            let mut payload = vec![0u8; usize::try_from(len).ok()?];
            stream.read_exact(&mut payload).await.ok()?;
            Some((h[0] & 0x0F, payload))
        })
        .await
        .ok()
        .flatten()
    }

    async fn ws_send_text(stream: &mut TcpStream, text: &str) {
        let mask = [0x11u8, 0x22, 0x33, 0x44];
        let payload = text.as_bytes();
        assert!(payload.len() < 126);
        let mut frame = vec![0x81, 0x80 | payload.len() as u8];
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        stream.write_all(&frame).await.expect("ws write");
    }

    fn close_code(payload: &[u8]) -> u16 {
        u16::from_be_bytes([payload[0], payload[1]])
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn websocket_requires_auth_message_and_checks_origin() {
        let addr = spawn_server().await;

        // Foreign Origin is refused at upgrade.
        let (st, _) = ws_connect(addr, &[("Origin", "http://evil.example".to_string())]).await;
        assert_eq!(st, 403);

        // No auth message -> closed with 4401 after ~3 s; no telemetry before that.
        let (st, mut s) = ws_connect(addr, &[]).await;
        assert_eq!(st, 101);
        let (op, payload) = ws_read_frame(&mut s, Duration::from_secs(5))
            .await
            .expect("close frame");
        assert_eq!(op, 0x8, "first frame must be Close, not telemetry");
        assert_eq!(close_code(&payload), WS_CLOSE_UNAUTHORIZED);

        // Wrong token -> 4401 immediately.
        let (_, mut s) = ws_connect(addr, &[("Origin", "http://localhost:5173".to_string())]).await;
        ws_send_text(&mut s, r#"{"type":"auth","token":"nope"}"#).await;
        let (op, payload) = ws_read_frame(&mut s, Duration::from_secs(2))
            .await
            .expect("close frame");
        assert_eq!((op, close_code(&payload)), (0x8, WS_CLOSE_UNAUTHORIZED));

        // Correct auth -> telemetry text frames.
        let (_, mut s) = ws_connect(addr, &[("Origin", "http://localhost:5173".to_string())]).await;
        ws_send_text(
            &mut s,
            &format!(r#"{{"type":"auth","token":"{TEST_TOKEN}"}}"#),
        )
        .await;
        let (op, payload) = ws_read_frame(&mut s, Duration::from_secs(3))
            .await
            .expect("snapshot");
        assert_eq!(op, 0x1, "expected a text snapshot");
        let v: Value = serde_json::from_slice(&payload).expect("snapshot json");
        assert!(v.get("seq").is_some());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bridge_panic_latch_reset_session_and_seedkey_commands() {
        let engine = Arc::new(PipelineEngine::new());
        let (st, _) = call_invoke(
            &engine,
            "cmd_connect_bus",
            r#"{"deviceId":"mock:mock0","config":{"busId":0,"bitrate":500000,"dataBitrate":2000000,"enableFd":true,"listenOnly":false,"mockFpsPreset":500}}"#,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) =
            call_invoke(&engine, "cmd_arm_active_bus", r#"{"busId":0,"armed":true}"#).await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = call_invoke(&engine, "cmd_panic_stop_tx", "").await;
        assert_eq!(st, StatusCode::OK);
        let (st, v) =
            call_invoke(&engine, "cmd_arm_active_bus", r#"{"busId":0,"armed":true}"#).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(
            v["error"].as_str().unwrap().starts_with("PANIC_LATCHED:"),
            "{v}"
        );
        let (st, v) = call_invoke(&engine, "cmd_clear_panic_latch", "").await;
        assert_eq!(st, StatusCode::OK);
        assert!(v.is_null());
        let (st, v) =
            call_invoke(&engine, "cmd_arm_active_bus", r#"{"busId":0,"armed":true}"#).await;
        assert_eq!(st, StatusCode::OK, "{v}");

        let (st, v) = call_invoke(&engine, "cmd_reset_session", "").await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["disconnectedBuses"], 1);
        assert_eq!(v["disarmedBuses"], 1);
        assert_eq!(v["stoppedPeriodicJobs"], 0);
        assert!(!engine.is_panic_latched());

        let (st, v) = call_invoke(&engine, "cmd_seedkey_capabilities", "{}").await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["nativeProvidersAllowed"], false);
        assert_eq!(v["scriptAvailable"], true);
        assert_eq!(
            v["nativeKindsAvailable"],
            json!(["library", "external_process"])
        );

        let body = json!({
            "provider": {
                "kind": "script",
                "source": "fn calculate_key(seed, level) { let k = blob(); for b in seed { k.push(b ^ 0xA5); } k }",
                "timeoutMs": 1000
            },
            "level": 1,
            "seedHex": "11223344"
        });
        let (st, v) = call_invoke(&engine, "cmd_seedkey_compute_adhoc", &body.to_string()).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["keyHex"], "B48796E1");
        assert_eq!(v["providerKind"], "script");

        let body = json!({
            "provider": { "kind": "external_process", "program": "/bin/sh", "args": ["-c", "id"] },
            "level": 1,
            "seedHex": "11223344"
        });
        // Unknown peer (no ConnectInfo) => native providers refused by policy.
        let (st, v) = call_invoke(&engine, "cmd_seedkey_compute_adhoc", &body.to_string()).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(
            v["error"]
                .as_str()
                .unwrap()
                .starts_with("[seedkey:native_not_allowed] "),
            "{v}"
        );
        let (st, v) = call_invoke(
            &engine,
            "cmd_seedkey_probe_library",
            r#"{"path":"/tmp/keygen.so"}"#,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(
            v["error"]
                .as_str()
                .unwrap()
                .starts_with("[seedkey:native_not_allowed] "),
            "{v}"
        );
        let (st, v) = call_invoke(&engine, "cmd_seedkey_probe_library", "{}").await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(
            v["error"]
                .as_str()
                .unwrap()
                .starts_with("[seedkey:invalid_input] "),
            "{v}"
        );

        let (st, v) = call_invoke(&engine, "cmd_seedkey_compute_adhoc", r#"{"level":1}"#).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(
            v["error"]
                .as_str()
                .unwrap()
                .starts_with("[seedkey:invalid_input] "),
            "{v}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bridge_flash_routes_load_download_cancel_release() {
        let engine = Arc::new(PipelineEngine::new());
        // 4 bytes of raw binary, base64.
        let body = json!({
            "fileName": "app.bin", "format": "binary", "baseAddress": 0x0800_0000u32,
            "dataBase64": "AQIDBA=="
        });
        let (st, v) = call_invoke(&engine, "cmd_flash_load_image", &body.to_string()).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["fileName"], "app.bin");
        assert_eq!(v["format"], "binary");
        assert_eq!(v["summary"]["totalBytes"], 4);
        let image_id = v["imageId"].as_str().unwrap().to_string();

        let body =
            json!({"fileName": "x", "format": "auto", "baseAddress": 0, "dataBase64": "AQIDBA=="});
        let (st, v) = call_invoke(&engine, "cmd_flash_load_image", &body.to_string()).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(
            v["error"].as_str().unwrap().starts_with("[firmware] "),
            "{v}"
        );

        // No onProgress (browser) and no bus: the session gate fails -> `[flash] {json}`.
        let config =
            json!({"busId": 0, "requestId": 0x7E0, "responseId": 0x7E8, "isExtendedId": false});
        let body = json!({"config": config, "imageId": image_id});
        let (st, v) = call_invoke(&engine, "cmd_flash_download", &body.to_string()).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let wire = v["error"].as_str().unwrap();
        let err: Value = serde_json::from_str(wire.strip_prefix("[flash] ").expect(wire)).unwrap();
        assert_eq!(err["kind"], "transport");
        assert!(err["diagCode"].is_string(), "{err}");

        let (st, _) = call_invoke(
            &engine,
            "cmd_flash_cancel",
            &json!({"config": config}).to_string(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, _) = call_invoke(
            &engine,
            "cmd_flash_release_image",
            &json!({"imageId": image_id}).to_string(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, v) = call_invoke(&engine, "cmd_flash_download", &body.to_string()).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(
            v["error"]
                .as_str()
                .unwrap()
                .starts_with(r#"[flash] {"kind":"invalidImage""#),
            "{v}"
        );
    }

    async fn call_invoke(
        engine: &Arc<PipelineEngine>,
        cmd: &str,
        body_str: &str,
    ) -> (StatusCode, Value) {
        let resp = handle_invoke(
            Path(cmd.to_string()),
            State(Arc::clone(engine)),
            Extensions::new(),
            Bytes::from(body_str.to_string()),
        )
        .await;
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .expect("read response body");
        let val: Value = serde_json::from_slice(&bytes).expect("parse response json");
        (status, val)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bridge_diag_routes_use_diag_error_wire_format() {
        let engine = Arc::new(PipelineEngine::new());
        let cfg = r#"{"busId":0,"requestId":2020,"responseId":2028,"isExtendedId":false}"#;

        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_open_session",
            &format!(r#"{{"config":{cfg}}}"#),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"]
            .as_str()
            .unwrap()
            .starts_with("[diag:bus_not_connected] "));

        let (st, v) = call_invoke(&engine, "cmd_diag_read_did", r#"{"config":{"busId":0}}"#).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"]
            .as_str()
            .unwrap()
            .starts_with("[diag:invalid_input] "));

        let (st, _) = call_invoke(
            &engine,
            "cmd_connect_bus",
            r#"{"deviceId":"mock:mock0","config":{"busId":0,"bitrate":500000,"dataBitrate":2000000,"enableFd":true,"listenOnly":false,"mockFpsPreset":1000}}"#,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_send_uds",
            &format!(r#"{{"config":{cfg},"sid":62,"subFunction":0,"data":[]}}"#),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"].as_str().unwrap().starts_with("[diag:disarmed] "));

        // ISO-TP Monitor: unknown session → empty page (never opens one); bad config → invalid_input.
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_get_isotp_frames",
            &format!(r#"{{"config":{cfg},"sinceSeq":0,"max":100}}"#),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["frames"].as_array().map(Vec::len), Some(0));
        assert_eq!(v["lastSeq"], 0);
        assert_eq!(v["truncated"], false);
        assert_eq!(v["dropped"], 0);
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_get_isotp_frames",
            r#"{"config":{"busId":0,"requestId":2020,"responseId":2020,"isExtendedId":false},"sinceSeq":0}"#,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"]
            .as_str()
            .unwrap()
            .starts_with("[diag:invalid_input] "));

        // ECU discovery: `{ request: {...} }`, same gate and wire format.
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_discover_ecus",
            r#"{"request":{"busId":0,"isExtendedId":false,"functionalId":2014,"windowMs":100}}"#,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"].as_str().unwrap().starts_with("[diag:disarmed] "));
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_discover_ecus",
            r#"{"request":{"busId":0,"isExtendedId":false,"functionalId":2014,"requestPdu":[62,128]}}"#,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"]
            .as_str()
            .unwrap()
            .starts_with("[diag:invalid_input] "));

        // 0x19 report: same gate and wire format; bad reportType / params → invalid_input.
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_read_dtc_report",
            &format!(r#"{{"config":{cfg},"subFunction":2,"params":[255]}}"#),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"].as_str().unwrap().starts_with("[diag:disarmed] "));
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_read_dtc_report",
            &format!(r#"{{"config":{cfg},"subFunction":5}}"#),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"]
            .as_str()
            .unwrap()
            .starts_with("[diag:invalid_input] "));

        // Passive discovery: works on the connected (disarmed) bus, never sends.
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_passive_discovery_start",
            r#"{"busId":0}"#,
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["running"], true);
        assert_eq!(v["maxPairs"], 512);
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_passive_discovery_snapshot",
            r#"{"busId":0}"#,
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert!(v["pairs"].is_array());
        let (st, v) =
            call_invoke(&engine, "cmd_diag_passive_discovery_stop", r#"{"busId":0}"#).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["running"], false);
        assert_eq!(v["stopReason"], "stopped by user");
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_passive_discovery_start",
            r#"{"busId":9}"#,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"]
            .as_str()
            .unwrap()
            .starts_with("[diag:bus_not_connected] "));

        // Physical sweep: `{ request: {...} }`, refused up front on a disarmed bus.
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_physical_sweep",
            r#"{"request":{"busId":0,"isExtendedId":false,"requestIdRange":{"start":1536,"end":1539},"responseIdFilters":[{"id":1600,"mask":1984}]}}"#,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"].as_str().unwrap().starts_with("[diag:disarmed] "));
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_physical_sweep",
            r#"{"request":{"busId":0,"isExtendedId":false}}"#,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"]
            .as_str()
            .unwrap()
            .starts_with("[diag:invalid_input] "));

        // Read-only commands answer without a session.
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_get_conversation",
            &format!(r#"{{"config":{cfg},"sinceSeq":0,"max":null}}"#),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["lastSeq"], 0);
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_session_info",
            &format!(r#"{{"config":{cfg}}}"#),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["open"], false);
        let (st, v) = call_invoke(
            &engine,
            "cmd_diag_close_session",
            &format!(r#"{{"config":{cfg}}}"#),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert!(v.is_null());
    }

    fn workspace_engine(tag: &str) -> (Arc<PipelineEngine>, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "nexuscan-bridge-{tag}-{}-{}",
            std::process::id(),
            nexus_core::now_monotonic_us()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let engine = Arc::new(PipelineEngine::with_data_root(
            DriverRegistry::with_builtin_drivers(),
            nexus_hal::storage::DataRoot::under(&root),
        ));
        (engine, root)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bridge_flowlib_commands_and_error_wire_format() {
        let (engine, root) = workspace_engine("flowlib");
        let file = |rev: u32| {
            json!({
                "schemaVersion": 1,
                "kind": "nexuscan.flow",
                "flow": {
                    "id": "read_vin", "revision": rev, "name": "Read VIN", "description": "",
                    "createdAt": "2026-11-18T10:00:00Z", "updatedAt": "2026-11-18T10:00:00Z",
                    "author": null, "origin": "user", "aiReviewed": false, "tags": [],
                    "blocks": [], "connections": []
                },
                "contentHash": "ab".repeat(32)
            })
            .to_string()
        };
        let save = |rev: u32| json!({ "fileJson": file(rev) }).to_string();

        let (st, v) = call_invoke(&engine, "cmd_flowlib_save", &save(1)).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["id"], "read_vin");
        assert_eq!(v["latestRevision"], 1);
        assert_eq!(v["deleted"], false);

        let (st, v) = call_invoke(&engine, "cmd_flowlib_save", &save(1)).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(
            v["error"]
                .as_str()
                .unwrap()
                .starts_with("[flowlib:conflict] "),
            "{v}"
        );

        let (st, v) = call_invoke(&engine, "cmd_flowlib_list", r#"{"includeDeleted":false}"#).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v.as_array().unwrap().len(), 1);

        let (st, v) = call_invoke(&engine, "cmd_flowlib_revisions", r#"{"id":"read_vin"}"#).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v[0]["revision"], 1);
        assert_eq!(v[0]["contentHash"], "ab".repeat(32));

        let (st, v) = call_invoke(
            &engine,
            "cmd_flowlib_load",
            r#"{"id":"read_vin","revision":null}"#,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v.as_str().unwrap(), file(1));

        let (st, v) = call_invoke(&engine, "cmd_flowlib_delete", r#"{"id":"read_vin"}"#).await;
        assert_eq!(st, StatusCode::OK);
        assert!(v.is_null());
        let (_, v) = call_invoke(&engine, "cmd_flowlib_list", r#"{"includeDeleted":false}"#).await;
        assert_eq!(v.as_array().unwrap().len(), 0);
        let (st, _) = call_invoke(
            &engine,
            "cmd_flowlib_load",
            r#"{"id":"read_vin","revision":1}"#,
        )
        .await;
        assert_eq!(
            st,
            StatusCode::OK,
            "pinned revision of a deleted flow still loads"
        );

        for (cmd, body, code) in [
            (
                "cmd_flowlib_load",
                r#"{"id":"../x","revision":null}"#,
                "invalid",
            ),
            ("cmd_flowlib_delete", r#"{"id":"missing"}"#, "not_found"),
            ("cmd_flowlib_list", "{}", "invalid"),
            ("cmd_flowlib_save", r#"{"fileJson":"{}"}"#, "invalid"),
        ] {
            let (st, v) = call_invoke(&engine, cmd, body).await;
            assert_eq!(st, StatusCode::BAD_REQUEST, "{cmd}");
            assert!(
                v["error"]
                    .as_str()
                    .unwrap()
                    .starts_with(&format!("[flowlib:{code}] ")),
                "{cmd}: {v}"
            );
        }
        assert!(root.join("flowlib/read_vin/r1.json").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bridge_runstore_commands_and_error_wire_format() {
        let (engine, root) = workspace_engine("runstore");
        let project = "3f2b8c1e-7d4a-4e9b-9c0d-112233445566";
        let rec = |run_id: &str, started: &str, parent: Value| {
            json!({
                "schemaVersion": 1, "runId": run_id, "parentRunId": parent, "queueId": null,
                "projectId": project, "vehicleId": null, "ecuId": "ecu-1", "ecuName": "BMS",
                "ecuSnapshotHash": null, "flowId": "read_vin", "flowRevision": 1,
                "flowContentHash": "ab".repeat(32), "flowName": "Read VIN",
                "params": { "did": "F190", "retries": 3, "verbose": false, "x": null },
                "files": [{ "key": "fw", "name": "app.hex", "size": 10, "crc32": "0A1B2C3D" }],
                "startedAt": started, "endedAt": started, "durationMs": 5,
                "outcome": "ok", "outputName": null, "outputs": {}, "nrc": null,
                "errorMessage": null, "logExcerpt": ["TX 22 F1 90"], "operator": null,
                "deviceId": "dev-1", "appVersion": "0.1.0"
            })
        };
        for (id, ts, parent) in [
            ("r1", "2026-10-31T10:00:00Z", Value::Null),
            ("r2", "2026-11-01T10:00:00Z", Value::Null),
            ("c1", "2026-11-01T10:00:01Z", json!("r2")),
        ] {
            let body = json!({ "record": rec(id, ts, parent) }).to_string();
            let (st, v) = call_invoke(&engine, "cmd_run_append", &body).await;
            assert_eq!(st, StatusCode::OK, "{v}");
            assert!(v.is_null());
        }

        let body = json!({ "projectId": project, "filter": {}, "limit": 10 }).to_string();
        let (st, v) = call_invoke(&engine, "cmd_run_query", &body).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        let ids: Vec<&str> = v
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["runId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["c1", "r2", "r1"]);
        // Exact wire round trip (durationMs stays the integer 5).
        assert_eq!(v[2], rec("r1", "2026-10-31T10:00:00Z", Value::Null));
        assert!(v[2]["durationMs"].is_u64());

        let body = json!({ "projectId": project, "filter": { "topLevelOnly": true, "ecuId": null }, "limit": 1 }).to_string();
        let (_, v) = call_invoke(&engine, "cmd_run_query", &body).await;
        assert_eq!(v.as_array().unwrap().len(), 1);
        assert_eq!(v[0]["runId"], "r2");

        let (st, v) = call_invoke(
            &engine,
            "cmd_run_latest",
            &json!({ "projectId": project }).to_string(),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v.as_array().unwrap().len(), 1);
        assert_eq!(v[0]["runId"], "r2");

        let bad_ts = json!({ "record": rec("r9", "2026-11-01 10:00:00", Value::Null) }).to_string();
        for (cmd, body, code) in [
            (
                "cmd_run_query",
                json!({ "projectId": project, "filter": {}, "limit": 0 }).to_string(),
                "invalid",
            ),
            (
                "cmd_run_query",
                json!({ "projectId": project, "filter": {}, "limit": -1 }).to_string(),
                "invalid",
            ),
            (
                "cmd_run_query",
                json!({ "projectId": project, "filter": {}, "limit": 5001 }).to_string(),
                "invalid",
            ),
            (
                "cmd_run_latest",
                json!({ "projectId": "../etc" }).to_string(),
                "invalid",
            ),
            ("cmd_run_append", bad_ts, "invalid"),
            ("cmd_run_append", "{}".to_string(), "invalid"),
        ] {
            let (st, v) = call_invoke(&engine, cmd, &body).await;
            assert_eq!(st, StatusCode::BAD_REQUEST, "{cmd}");
            assert!(
                v["error"]
                    .as_str()
                    .unwrap()
                    .starts_with(&format!("[runstore:{code}] ")),
                "{cmd}: {v}"
            );
        }
        let mut big = rec("big", "2026-11-01T10:00:00Z", Value::Null);
        big["errorMessage"] = json!("x".repeat(300 * 1024));
        let (st, v) = call_invoke(
            &engine,
            "cmd_run_append",
            &json!({ "record": big }).to_string(),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(
            v["error"]
                .as_str()
                .unwrap()
                .starts_with("[runstore:too_large] "),
            "{v}"
        );
        assert!(root.join(format!("runs/{project}/2026-11.jsonl")).is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn bridge_http_endpoints_and_400_error_contract() {
        // Isolated parent: `logs/` (and lazily `flowlib/` / `runs/`) are siblings of
        // `projects/`, never directly under the shared temp dir.
        let tmp_root = std::env::temp_dir().join(format!(
            "nexuscan-bridge-http-{}-{}",
            std::process::id(),
            nexus_core::now_monotonic_us()
        ));
        let tmp_projects = tmp_root.join("projects");
        let tmp_traces = tmp_root.join("traces");
        let _ = std::fs::remove_dir_all(&tmp_root);

        let engine = Arc::new(PipelineEngine::with_storage_dirs(
            DriverRegistry::with_builtin_drivers(),
            tmp_projects.clone(),
            tmp_traces.clone(),
        ));
        let _router = build_router(Arc::clone(&engine), test_security());

        // 1. Health endpoint
        let Json(health) = handle_health().await;
        assert_eq!(health["status"], "ok");
        assert_eq!(health["engine"], "nexus-hal");

        // 2. cmd_list_devices exposes both mock:mock0 and mock:mock1
        let (st_dev, devs) = call_invoke(&engine, "cmd_list_devices", "").await;
        assert_eq!(st_dev, StatusCode::OK);
        let dev_arr = devs.as_array().expect("array");
        assert!(dev_arr.iter().any(|d| d["deviceId"] == "mock:mock0"
            && d["displayName"] == "mock0 — Virtual EV Powertrain + BMS Bus"));
        assert!(dev_arr.iter().any(|d| d["deviceId"] == "mock:mock1"
            && d["displayName"] == "mock1 — Virtual Auxiliary / Charger Bus"));

        // 2b. cmd_probe_drivers returns all 7 driver families + hostEnv
        let (st_probe, probe_val) = call_invoke(&engine, "cmd_probe_drivers", "").await;
        assert_eq!(st_probe, StatusCode::OK);
        let fams = probe_val["families"].as_array().expect("families array");
        assert_eq!(fams.len(), 7);
        assert!(probe_val["hostEnv"]["os"].as_str().is_some());
        assert!(fams
            .iter()
            .any(|f| f["familyId"] == "slcan" && f["installed"] == true));
        assert!(fams.iter().any(|f| f["familyId"] == "gs_usb"));
        assert!(fams.iter().any(|f| f["familyId"] == "pcan"));
        assert!(fams.iter().any(|f| f["familyId"] == "kvaser"));
        assert!(fams.iter().any(|f| f["familyId"] == "vector_xl"));

        // 3. cmd_connect_bus in Listen-Only mode + verify 400 {"error": ...} on arming Listen-Only
        let (st_conn, bus_dto) = call_invoke(
            &engine,
            "cmd_connect_bus",
            r#"{"deviceId":"mock:mock0","config":{"busId":0,"bitrate":500000,"dataBitrate":2000000,"enableFd":true,"listenOnly":true,"mockFpsPreset":null}}"#,
        )
        .await;
        assert_eq!(st_conn, StatusCode::OK);
        assert_eq!(bus_dto["listenOnly"], true);

        let (st_err, err_json) =
            call_invoke(&engine, "cmd_arm_active_bus", r#"{"busId":0,"armed":true}"#).await;
        assert_eq!(st_err, StatusCode::BAD_REQUEST);
        assert!(err_json["error"]
            .as_str()
            .expect("error string")
            .contains("Listen-Only"));

        let (st_disc, _) = call_invoke(&engine, "cmd_disconnect_bus", r#"{"busId":0}"#).await;
        assert_eq!(st_disc, StatusCode::OK);

        // 4. Active mode + dual bus (mock0 + mock1) + cmd_transmit_raw_frame + cmd_disconnect_all_buses
        let (st_rw, _) = call_invoke(
            &engine,
            "cmd_connect_bus",
            r#"{"deviceId":"mock:mock0","config":{"busId":0,"bitrate":500000,"dataBitrate":2000000,"enableFd":true,"listenOnly":false,"mockFpsPreset":null}}"#,
        )
        .await;
        assert_eq!(st_rw, StatusCode::OK);

        let (st_b1, _) = call_invoke(
            &engine,
            "cmd_connect_bus",
            r#"{"deviceId":"mock:mock1","config":{"busId":1,"bitrate":500000,"dataBitrate":2000000,"enableFd":true,"listenOnly":true,"mockFpsPreset":null}}"#,
        )
        .await;
        assert_eq!(st_b1, StatusCode::OK);

        // Verify cmd_set_bus_mode rejects unconnected busId 7 and atomically upgrades mock:mock1 on busId 1
        let (st_unconn_mode, err_unconn_mode) = call_invoke(
            &engine,
            "cmd_set_bus_mode",
            r#"{"busId":7,"listenOnly":false,"armTx":true}"#,
        )
        .await;
        assert_eq!(st_unconn_mode, StatusCode::BAD_REQUEST);
        assert!(err_unconn_mode["error"]
            .as_str()
            .expect("error string")
            .contains("Bus 7 is not connected"));

        let (st_b1_mode, b1_mode_dto) = call_invoke(
            &engine,
            "cmd_set_bus_mode",
            r#"{"busId":1,"listenOnly":false,"armTx":true}"#,
        )
        .await;
        assert_eq!(st_b1_mode, StatusCode::OK);
        assert_eq!(b1_mode_dto["deviceId"], "mock:mock1");
        assert_eq!(b1_mode_dto["listenOnly"], false);
        assert_eq!(b1_mode_dto["txArmed"], true);

        let (st_arm, _) =
            call_invoke(&engine, "cmd_arm_active_bus", r#"{"busId":0,"armed":true}"#).await;
        assert_eq!(st_arm, StatusCode::OK);

        let (st_raw_tx, raw_tx_val) = call_invoke(
            &engine,
            "cmd_transmit_raw_frame",
            r#"{"busId":0,"arbId":1919,"isExtended":false,"isFd":false,"isBrs":false,"data":[2,1,12,0,0,0,0,0],"periodicMs":50,"jobLabel":"UDS_TesterPresent"}"#,
        )
        .await;
        assert_eq!(st_raw_tx, StatusCode::OK);
        assert_eq!(raw_tx_val["encodedDlc"], 8);

        let (st_jobs, jobs_val) = call_invoke(&engine, "cmd_list_periodic_tx", "").await;
        assert_eq!(st_jobs, StatusCode::OK);
        let jobs_arr = jobs_val.as_array().expect("jobs array");
        assert_eq!(jobs_arr.len(), 1);
        assert_eq!(jobs_arr[0]["arbId"], 1919);

        let (st_disc_all, disc_count) = call_invoke(&engine, "cmd_disconnect_all_buses", "").await;
        assert_eq!(st_disc_all, StatusCode::OK);
        assert_eq!(disc_count, 2);

        // 5. Project CRUD + database clear via HTTP invoke
        let (st_save, saved_proj) = call_invoke(
            &engine,
            "cmd_save_project",
            r#"{"fileStem":"ev_dyno_bench","projectJson":"{\"name\":\"EV Dyno Bench\",\"updatedAt\":\"2026-11-06T03:00:00Z\"}"}"#,
        )
        .await;
        assert_eq!(st_save, StatusCode::OK);
        assert_eq!(saved_proj["fileStem"], "ev_dyno_bench");
        assert_eq!(saved_proj["name"], "EV Dyno Bench");

        let (st_list_p, listed_p) = call_invoke(&engine, "cmd_list_projects", "").await;
        assert_eq!(st_list_p, StatusCode::OK);
        assert_eq!(listed_p.as_array().expect("projects array").len(), 1);

        let (st_load_p, loaded_p) = call_invoke(
            &engine,
            "cmd_load_project",
            r#"{"fileStem":"ev_dyno_bench"}"#,
        )
        .await;
        assert_eq!(st_load_p, StatusCode::OK);
        assert!(loaded_p
            .as_str()
            .expect("project json str")
            .contains("EV Dyno Bench"));

        let (st_del_p, _) = call_invoke(
            &engine,
            "cmd_delete_project",
            r#"{"fileStem":"ev_dyno_bench"}"#,
        )
        .await;
        assert_eq!(st_del_p, StatusCode::OK);

        let (st_reset_tel, _) = call_invoke(&engine, "cmd_reset_telemetry", "").await;
        assert_eq!(st_reset_tel, StatusCode::OK);

        // 6. Stateless catalog parsing + preset files + per-bus DB binding
        let (st_presets, preset_files) =
            call_invoke(&engine, "cmd_get_preset_database_files", "{}").await;
        assert_eq!(st_presets, StatusCode::OK);
        let preset_arr = preset_files.as_array().expect("preset files array");
        assert_eq!(preset_arr.len(), 2);
        let first_file_name = preset_arr[0]["fileName"].as_str().expect("fileName");
        let first_b64 = preset_arr[0]["contentBase64"]
            .as_str()
            .expect("contentBase64");

        let (st_parse, parsed_schema) = call_invoke(
            &engine,
            "cmd_parse_database_schema",
            &serde_json::to_string(&json!({
                "fileName": first_file_name,
                "contentBase64": first_b64,
            }))
            .unwrap(),
        )
        .await;
        assert_eq!(st_parse, StatusCode::OK);
        assert!(parsed_schema["messages"].as_array().unwrap().len() >= 4);
        assert!(
            engine.cmd_get_current_schema().is_none(),
            "cmd_parse_database_schema must remain strictly stateless"
        );

        let (st_bind_some, bound_schema) = call_invoke(
            &engine,
            "cmd_set_bus_databases",
            &serde_json::to_string(&json!({
                "busId": 0,
                "files": preset_arr,
            }))
            .unwrap(),
        )
        .await;
        assert_eq!(st_bind_some, StatusCode::OK);
        assert_eq!(bound_schema["messages"].as_array().unwrap().len(), 8);

        let (st_bind_none, unbound_res) = call_invoke(
            &engine,
            "cmd_set_bus_databases",
            r#"{"busId":1,"files":[]}"#,
        )
        .await;
        assert_eq!(st_bind_none, StatusCode::OK);
        assert!(unbound_res.is_null());

        let (st_clear_db, _) = call_invoke(&engine, "cmd_clear_database", "").await;
        assert_eq!(st_clear_db, StatusCode::OK);

        // 7. Trace persistent CRUD + parse + replay start/control via HTTP invoke (both wrapped {args} & flat)
        let sample_trc = ";$FILEVERSION=2.1\n1 0.000 DT 1 0101 Rx 8 10 20 30 40 50 60 70 80\n2 40.000 DT 1 0101 Rx 8 11 22 33 44 55 66 77 88\n";
        let (st_t_save, saved_trace) = call_invoke(
            &engine,
            "cmd_save_trace_file",
            &serde_json::to_string(&json!({
                "fileName": "bridge_run.trc",
                "content": sample_trc,
            }))
            .unwrap(),
        )
        .await;
        assert_eq!(st_t_save, StatusCode::OK);
        assert_eq!(saved_trace["fileName"], "bridge_run.trc");
        assert_eq!(saved_trace["frameCount"], 2);
        assert_eq!(saved_trace["durationUs"], 40_000);

        let (st_t_list, listed_traces) = call_invoke(&engine, "cmd_list_traces", "").await;
        assert_eq!(st_t_list, StatusCode::OK);
        assert_eq!(listed_traces["files"].as_array().unwrap().len(), 1);

        let (st_t_load, loaded_trace) = call_invoke(
            &engine,
            "cmd_load_trace_file",
            r#"{"fileName":"bridge_run.trc"}"#,
        )
        .await;
        assert_eq!(st_t_load, StatusCode::OK);
        assert_eq!(loaded_trace["frames"].as_array().unwrap().len(), 2);

        let (st_t_parse, parsed_trace) = call_invoke(
            &engine,
            "cmd_parse_trace_content",
            &serde_json::to_string(&json!({
                "file_name": "inline.log",
                "content": "(1700000000.000000) vcan0 123#AABBCCDD\n",
            }))
            .unwrap(),
        )
        .await;
        assert_eq!(st_t_parse, StatusCode::OK);
        assert_eq!(parsed_trace["summary"]["frameCount"], 1);

        let (st_rep_start, rep_status) = call_invoke(
            &engine,
            "cmd_start_trace_replay",
            r#"{"args":{"sourceName":"bridge_run.trc","fileName":"bridge_run.trc","speedFactor":0.5,"filterMode":"exclude","filterKeys":["std:0x102"],"directionFilter":"rx"}}"#,
        )
        .await;
        assert_eq!(st_rep_start, StatusCode::OK);
        assert_eq!(rep_status["state"], "playing");
        assert_eq!(rep_status["filterMode"], "exclude");
        assert_eq!(rep_status["filterKeys"], json!(["STD:0x102"]));
        assert_eq!(rep_status["directionFilter"], "rx");

        let (st_rep_cfg, rep_cfg) = call_invoke(
            &engine,
            "cmd_control_trace_replay",
            r#"{"action":"configure","filterMode":"include","updateFilterKeys":true,"filterKeys":["STD:0x101"],"directionFilter":"all"}"#,
        )
        .await;
        assert_eq!(st_rep_cfg, StatusCode::OK);
        assert_eq!(rep_cfg["filterMode"], "include");
        assert_eq!(rep_cfg["filterKeys"], json!(["STD:0x101"]));
        assert_eq!(rep_cfg["directionFilter"], "all");

        let (st_rep_stop, rep_stopped) =
            call_invoke(&engine, "cmd_control_trace_replay", r#"{"action":"stop"}"#).await;
        assert_eq!(st_rep_stop, StatusCode::OK);
        assert_eq!(rep_stopped["state"], "idle");

        // 8. Binary Vector `.blf` export + `contentBase64` save & stateless parse via HTTP invoke
        let (st_blf_exp, blf_b64_val) = call_invoke(
            &engine,
            "cmd_export_trace_blf",
            &serde_json::to_string(&json!({
                "fileName": "bridge_export.blf",
                "frames": loaded_trace["frames"],
            }))
            .unwrap(),
        )
        .await;
        assert_eq!(st_blf_exp, StatusCode::OK);
        let blf_b64 = blf_b64_val.as_str().expect("base64 string");
        assert!(!blf_b64.is_empty());

        let (st_blf_save, saved_blf) = call_invoke(
            &engine,
            "cmd_save_trace_file",
            &serde_json::to_string(&json!({
                "fileName": "bridge_export.blf",
                "contentBase64": blf_b64,
            }))
            .unwrap(),
        )
        .await;
        assert_eq!(st_blf_save, StatusCode::OK);
        assert_eq!(saved_blf["format"], "blf");
        assert_eq!(saved_blf["frameCount"], 2);

        let (st_blf_parse, parsed_blf) = call_invoke(
            &engine,
            "cmd_parse_trace_content",
            &serde_json::to_string(&json!({
                "fileName": "bridge_export.blf",
                "contentBase64": blf_b64,
            }))
            .unwrap(),
        )
        .await;
        assert_eq!(st_blf_parse, StatusCode::OK);
        assert_eq!(parsed_blf["summary"]["format"], "blf");
        assert_eq!(parsed_blf["frames"].as_array().unwrap().len(), 2);

        let (st_t_del, _) = call_invoke(
            &engine,
            "cmd_delete_trace_file",
            r#"{"fileName":"bridge_run.trc"}"#,
        )
        .await;
        assert_eq!(st_t_del, StatusCode::OK);

        let _ = std::fs::remove_dir_all(&tmp_root);
    }

    // ─── RE Toolkit bridge routes (re-toolkit-v1 amendment 14) ─────────────────────────

    /// Like [`call_invoke`] but returns the raw body and its content type.
    async fn call_invoke_raw(
        engine: &Arc<PipelineEngine>,
        cmd: &str,
        body_str: &str,
    ) -> (StatusCode, String, Vec<u8>) {
        let resp = handle_invoke(
            Path(cmd.to_string()),
            State(Arc::clone(engine)),
            Extensions::new(),
            Bytes::from(body_str.to_string()),
        )
        .await;
        let status = resp.status();
        let ct = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = to_bytes(resp.into_body(), 4 * 1024 * 1024)
            .await
            .expect("read response body")
            .to_vec();
        (status, ct, bytes)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bridge_re_invoke_routes_need_token() {
        let addr = spawn_server().await;
        let host = ("Host", format!("127.0.0.1:{}", addr.port()));
        let auth = ("Authorization", format!("Bearer {TEST_TOKEN}"));
        let ct = ("Content-Type", "application/json".to_string());
        for cmd in [
            "cmd_re_start",
            "cmd_re_series",
            "cmd_re_correlate",
            "cmd_re_focus_status",
            "cmd_re_dbc_generate",
            "cmd_re_scan_first",
            "cmd_re_scan_next",
            "cmd_re_scan_undo",
            "cmd_re_scan_reset",
            "cmd_re_scan_status",
            "cmd_re_scan_results",
        ] {
            let path = format!("/api/invoke/{cmd}");
            let (st, body) = raw_http(addr, "POST", &path, &[host.clone(), ct.clone()], "{}").await;
            assert_eq!(st, 401, "{cmd} without token: {body}");
        }
        let (st, body) = raw_http(
            addr,
            "POST",
            "/api/invoke/cmd_re_start",
            &[host.clone(), auth.clone(), ct.clone()],
            "{}",
        )
        .await;
        assert_eq!(st, 200, "{body}");
        assert!(body.contains(r#""phase":"free""#), "{body}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bridge_re_commands_round_trip_and_error_wire_format() {
        let engine = Arc::new(PipelineEngine::new());
        let target = r#"{"bus":0,"arbId":291,"isExtended":false}"#;
        let series_body =
            format!(r#"{{"target":{target},"candidates":[],"reference":null,"maxPoints":64}}"#);

        // Before start: R2a errors keep the "[re:<code>] …" text in the 400 body.
        let (st, _, body) = call_invoke_raw(&engine, "cmd_re_series", &series_body).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let v: Value = serde_json::from_slice(&body).expect("json error");
        assert!(
            v["error"]
                .as_str()
                .unwrap()
                .starts_with("[re:not_started] "),
            "{v}"
        );

        // start / status round trip (same JSON as the Tauri ReStatusDto).
        let (st, v) = call_invoke(&engine, "cmd_re_start", r#"{"buses":[0]}"#).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["phase"], "free");
        let status = serde_json::to_value(engine.re_status()).unwrap();
        assert_eq!(v, status);

        let (st, v) = call_invoke(&engine, "cmd_re_set_phase", r#"{"phase":"baseline"}"#).await;
        assert_eq!(
            (st, v["phase"].as_str()),
            (StatusCode::OK, Some("baseline"))
        );
        let (st, v) = call_invoke(&engine, "cmd_re_set_phase", r#"{"phase":"idle"}"#).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(
            v["error"].as_str().unwrap().contains("RE phase must be"),
            "{v}"
        );
        let (st, v) = call_invoke(&engine, "cmd_re_set_phase", r#"{"phase":"bogus"}"#).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(
            v["error"]
                .as_str()
                .unwrap()
                .starts_with("[re:invalid] invalid arguments for cmd_re_set_phase"),
            "{v}"
        );

        let (st, v) = call_invoke(&engine, "cmd_re_mark", r#"{"label":"door open"}"#).await;
        assert_eq!(
            (st, v["label"].as_str()),
            (StatusCode::OK, Some("door open")),
            "{v}"
        );
        let (st, v) = call_invoke(&engine, "cmd_re_markers", "").await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v.as_array().map(Vec::len), Some(1));

        let (st, v) = call_invoke(
            &engine,
            "cmd_re_row_detail",
            r#"{"bus":0,"arbId":291,"isExtended":false}"#,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(
            v["error"].as_str().unwrap().contains("RE row not found"),
            "{v}"
        );
        let (st, _) = call_invoke(
            &engine,
            "cmd_re_classify",
            r#"{"bus":0,"arbId":291,"isExtended":false}"#,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        // focus_set -> series = 200 octet-stream NRS1 (empty window).
        let (st, v) = call_invoke(
            &engine,
            "cmd_re_focus_set",
            &format!(r#"{{"targets":[{target}]}}"#),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{v}");
        let (st, v) = call_invoke(&engine, "cmd_re_focus_status", "").await;
        assert_eq!(st, StatusCode::OK, "{v}");
        let (st, ct, body) = call_invoke_raw(&engine, "cmd_re_series", &series_body).await;
        assert_eq!(st, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        assert_eq!(ct, "application/octet-stream");
        assert_eq!(&body[..4], b"NRS1");

        // correlate: invalid search -> [re:…] error, never a panic / hang.
        let (st, v) = call_invoke(
            &engine,
            "cmd_re_correlate",
            &format!(
                r#"{{"target":{target},"reference":{{"kind":"markers","points":[]}},"search":{{"bitFrom":0,"bitTo":63,"lengths":[0,99],"byteOrders":[],"signed":[]}},"topN":5}}"#
            ),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"].as_str().unwrap().starts_with("[re:"), "{v}");

        // R2c value scan: status / no_scan / first / results / undo / reset wire format.
        let (st, v) = call_invoke(&engine, "cmd_re_scan_status", "").await;
        assert_eq!(
            (st, &v["active"]),
            (StatusCode::OK, &Value::Bool(false)),
            "{v}"
        );
        let (st, v) = call_invoke(&engine, "cmd_re_scan_next", r#"{"op":{"op":"changed"}}"#).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(
            v["error"].as_str().unwrap().starts_with("[re:no_scan] "),
            "{v}"
        );
        let (st, v) = call_invoke(
            &engine,
            "cmd_re_scan_first",
            r#"{"spec":{"kind":"unknown","options":{"lengths":[8]}}}"#,
        )
        .await;
        assert_eq!(
            (st, &v["active"]),
            (StatusCode::OK, &Value::Bool(true)),
            "{v}"
        );
        let (st, v) = call_invoke(
            &engine,
            "cmd_re_scan_results",
            r#"{"offset":0,"limit":10,"sort":"id"}"#,
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert!(v["rows"].is_array(), "{v}");
        let (st, v) = call_invoke(
            &engine,
            "cmd_re_scan_results",
            r#"{"offset":0,"limit":501,"sort":"id"}"#,
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(
            v["error"].as_str().unwrap().starts_with("[re:invalid] "),
            "{v}"
        );
        let (st, v) = call_invoke(&engine, "cmd_re_scan_undo", "").await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(
            v["error"].as_str().unwrap().starts_with("[re:invalid] "),
            "{v}"
        );
        let (st, v) = call_invoke(&engine, "cmd_re_scan_reset", "").await;
        assert_eq!(
            (st, &v["active"]),
            (StatusCode::OK, &Value::Bool(false)),
            "{v}"
        );

        let (st, v) = call_invoke(&engine, "cmd_re_reset", "").await;
        assert_eq!(st, StatusCode::OK, "{v}");
        let (st, v) = call_invoke(&engine, "cmd_re_stop", "").await;
        assert_eq!(
            (st, v["enabled"].as_bool()),
            (StatusCode::OK, Some(false)),
            "{v}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bridge_re_dbc_generate_round_trip_and_error_wire_format() {
        use base64::engine::general_purpose::STANDARD as BASE64_STD;
        use base64::Engine as _;
        let engine = Arc::new(PipelineEngine::new());

        // Reachability probe: empty drafts, null base -> 200, counts 0, no diagnostics.
        let (st, v) = call_invoke(
            &engine,
            "cmd_re_dbc_generate",
            r#"{"drafts":[],"base":null}"#,
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["messages"], 0);
        assert_eq!(v["signals"], 0);
        assert_eq!(v["diagnostics"], json!([]));
        assert!(v["dbcText"].is_string(), "{v}");

        // One standalone draft: same JSON as the shared function (= the Tauri command result).
        let draft = json!({
            "id": "d1", "bus": 0, "arbId": 0x6A0, "isExtended": false, "messageName": null,
            "dlcBytes": 8, "name": "VehSpeed", "startBit": 7, "bitLength": 16,
            "byteOrder": "motorola", "valueType": "unsigned", "factor": 0.25, "offset": -40.0,
            "min": -40.0, "max": 16343.75, "unit": "km/h", "comment": "",
            "provenance": { "r": 0.998, "lagMs": 120.0, "reference": "OBD 0x0D", "samples": 812,
                            "createdAtMs": 0.0 },
            "valueTable": []
        });
        let body = json!({ "drafts": [draft.clone()], "base": null });
        let (st, v) = call_invoke(&engine, "cmd_re_dbc_generate", &body.to_string()).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        let req: ReDbcGenerateRequest = serde_json::from_value(body).unwrap();
        let direct = re_dbc_generate(&req.drafts, req.base.as_ref()).unwrap();
        assert_eq!(v, serde_json::to_value(direct).unwrap());
        assert_eq!(
            (v["messages"].as_u64(), v["signals"].as_u64()),
            (Some(1), Some(1))
        );
        assert!(
            v["dbcText"].as_str().unwrap().contains("SG_ VehSpeed"),
            "{v}"
        );

        // Base .kcd input through the bridge.
        let kcd = include_bytes!("../../../../scripts/sample_bms.kcd");
        let body = json!({
            "drafts": [draft.clone()],
            "base": { "fileName": "sample_bms.kcd", "contentBase64": BASE64_STD.encode(kcd) }
        });
        let (st, v) = call_invoke(&engine, "cmd_re_dbc_generate", &body.to_string()).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert!(
            v["dbcText"]
                .as_str()
                .unwrap()
                .contains("CMC_CellVoltagesMux"),
            "{v}"
        );

        // Errors: 400 {"error": "[re:invalid] …"}.
        for body in [
            json!({ "drafts": [], "base": { "fileName": "x.dbc", "contentBase64": "@@ nope" } }),
            json!({ "drafts": [], "base": { "fileName": "x.dbc",
                                            "contentBase64": BASE64_STD.encode("garbage text") } }),
            json!({ "base": null }),
            json!({ "drafts": [{ "id": "broken" }], "base": null }),
        ] {
            let (st, v) = call_invoke(&engine, "cmd_re_dbc_generate", &body.to_string()).await;
            assert_eq!(st, StatusCode::BAD_REQUEST, "{body}: {v}");
            assert!(
                v["error"].as_str().unwrap().starts_with("[re:invalid] "),
                "{body}: {v}"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bridge_re_ws_requires_auth_and_streams_binary_nre2() {
        let addr = spawn_server().await;
        let origin = ("Origin", "http://localhost:5173".to_string());

        let (st, _) =
            ws_connect_path(addr, "/ws/re", &[("Origin", "http://evil.example".into())]).await;
        assert_eq!(st, 403);

        let (st, mut s) = ws_connect_path(addr, "/ws/re", std::slice::from_ref(&origin)).await;
        assert_eq!(st, 101);
        ws_send_text(&mut s, r#"{"type":"auth","token":"nope"}"#).await;
        let (op, payload) = ws_read_frame(&mut s, Duration::from_secs(2))
            .await
            .expect("close frame");
        assert_eq!((op, close_code(&payload)), (0x8, WS_CLOSE_UNAUTHORIZED));

        let host = ("Host", format!("127.0.0.1:{}", addr.port()));
        let auth = ("Authorization", format!("Bearer {TEST_TOKEN}"));
        let ct = ("Content-Type", "application/json".to_string());
        let (st, body) = raw_http(
            addr,
            "POST",
            "/api/invoke/cmd_re_start",
            &[host.clone(), auth.clone(), ct.clone()],
            "{}",
        )
        .await;
        assert_eq!(st, 200, "{body}");

        let (st, mut s) = ws_connect_path(addr, "/ws/re", std::slice::from_ref(&origin)).await;
        assert_eq!(st, 101);
        ws_send_text(
            &mut s,
            &format!(r#"{{"type":"auth","token":"{TEST_TOKEN}"}}"#),
        )
        .await;
        let (op, payload) = ws_read_frame(&mut s, Duration::from_secs(3))
            .await
            .expect("first RE snapshot");
        assert_eq!(op, 0x2, "RE snapshots are binary messages");
        assert_eq!(&payload[..4], b"NRE2");
        assert_eq!(
            payload[17], 1,
            "first snapshot after subscribe is a full resync"
        );

        // cmd_re_stop ends the subscription: final snapshot, then a normal close (1000).
        let (st, body) = raw_http(
            addr,
            "POST",
            "/api/invoke/cmd_re_stop",
            &[host, auth, ct],
            "{}",
        )
        .await;
        assert_eq!(st, 200, "{body}");
        let mut closed = None;
        for _ in 0..8 {
            match ws_read_frame(&mut s, Duration::from_secs(3)).await {
                Some((0x2, p)) => assert_eq!(&p[..4], b"NRE2"),
                Some((0x8, p)) => {
                    closed = Some(close_code(&p));
                    break;
                }
                other => panic!("unexpected frame {other:?}"),
            }
        }
        assert_eq!(closed, Some(1000));
    }
}
