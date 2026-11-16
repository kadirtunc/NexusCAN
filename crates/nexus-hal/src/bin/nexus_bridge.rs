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

use axum::{
    body::Bytes,
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        FromRef, Path, Request, State,
    },
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use nexus_hal::{
    dto::{
        ChannelConfigDto, ChronologicalFrameDto, DbFileInputDto, PhysicalSweepRequestDto,
        StartTraceReplayArgsDto, TraceReplayControlArgsDto,
    },
    pipeline::PipelineEngine,
};
use nexus_protocols::uds::dto::{
    DiagError, DiagErrorCode, DiagOrigin, DiagSessionConfigDto, EcuDiscoveryRequestDto,
    UdsRequestOptionsDto,
};
use nexus_protocols::uds::security::{KeyProviderSpecDto, SeedKeyError};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::broadcast::error::RecvError;
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

fn build_router(engine: Arc<PipelineEngine>, security: Arc<BridgeSecurity>) -> Router {
    let state = BridgeState {
        engine,
        security: Arc::clone(&security),
    };
    // Layer order (outermost last): host/origin guard -> CORS -> token guard -> routes.
    Router::new()
        .route("/api/health", get(handle_health))
        .route("/ws/telemetry", get(handle_ws_upgrade))
        .route("/api/invoke/{cmd}", post(handle_invoke))
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

    axum::serve(listener, app)
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

async fn handle_ws_upgrade(ws: WebSocketUpgrade, State(state): State<BridgeState>) -> Response {
    ws.max_message_size(WS_MAX_CLIENT_MESSAGE)
        .max_frame_size(WS_MAX_CLIENT_MESSAGE)
        .on_upgrade(move |socket| ws_authenticate_then_stream(socket, state))
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

    match cmd.as_str() {
        "cmd_list_devices" => ok_json(engine.cmd_list_devices()),
        "cmd_probe_drivers" => ok_json(engine.cmd_probe_drivers()),
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
        "cmd_seedkey_capabilities" => ok_json(engine.cmd_seedkey_capabilities()),
        "cmd_seedkey_compute_adhoc" => {
            let args: SeedKeyComputeAdhocArgs = match serde_json::from_value(payload) {
                Ok(a) => a,
                Err(e) => {
                    return bad_request(
                        SeedKeyError::InvalidInput(format!(
                            "invalid arguments for cmd_seedkey_compute_adhoc: {e}"
                        ))
                        .to_ipc_string(),
                    )
                }
            };
            let eng = Arc::clone(&engine);
            match tokio::task::spawn_blocking(move || {
                eng.cmd_seedkey_compute_adhoc(&args.provider, args.level, &args.seed_hex)
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
        let mut req = format!(
            "GET /ws/telemetry HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n",
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
        let (st, v) = call_invoke(&engine, "cmd_seedkey_compute_adhoc", &body.to_string()).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(
            v["error"]
                .as_str()
                .unwrap()
                .starts_with("[seedkey:unsupported] "),
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

    async fn call_invoke(
        engine: &Arc<PipelineEngine>,
        cmd: &str,
        body_str: &str,
    ) -> (StatusCode, Value) {
        let resp = handle_invoke(
            Path(cmd.to_string()),
            State(Arc::clone(engine)),
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

    #[tokio::test]
    async fn bridge_http_endpoints_and_400_error_contract() {
        let tmp_projects =
            std::env::temp_dir().join(format!("nexuscan-bridge-projects-{}", std::process::id()));
        let tmp_traces =
            std::env::temp_dir().join(format!("nexuscan-bridge-traces-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp_projects);
        let _ = std::fs::remove_dir_all(&tmp_traces);

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

        // 2b. cmd_probe_drivers returns all 6 driver families
        let (st_probe, probe_val) = call_invoke(&engine, "cmd_probe_drivers", "").await;
        assert_eq!(st_probe, StatusCode::OK);
        let fams = probe_val["families"].as_array().expect("families array");
        assert_eq!(fams.len(), 6);
        assert!(fams
            .iter()
            .any(|f| f["familyId"] == "slcan" && f["installed"] == true));
        assert!(fams.iter().any(|f| f["familyId"] == "pcan"));
        assert!(fams.iter().any(|f| f["familyId"] == "kvaser"));

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

        let _ = std::fs::remove_dir_all(&tmp_projects);
        let _ = std::fs::remove_dir_all(&tmp_traces);
    }
}
