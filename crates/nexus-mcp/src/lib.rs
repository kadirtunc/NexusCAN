//! # nexus-mcp
//!
//! In-app, **read-only**, offline-oriented MCP (Model Context Protocol) server for NexusCAN.
//!
//! * Transport: MCP Streamable HTTP (official `rmcp` SDK), bound to `127.0.0.1` only, path `/mcp`.
//! * Auth: random 32-byte (hex) bearer token generated per start; `Authorization: Bearer <token>`
//!   is required on every request (401 otherwise, constant-time comparison).
//! * DNS rebinding: `Host` must be `127.0.0.1`/`localhost` and a present `Origin` must be
//!   `http://127.0.0.1[:port]` / `http://localhost[:port]` (403 otherwise).
//! * Tools only call existing read-only `PipelineEngine` APIs on the blocking pool; nothing here
//!   touches the RX / aggregator / `StateTable` hot path and nothing can transmit, arm a bus,
//!   change bus modes, run UDS / flashing or start a replay.

#![forbid(unsafe_code)]

pub mod audit;
pub mod dbsel;
mod guard;
mod server;
pub mod tools_db;
pub mod tools_diag;
pub mod tools_live;
pub mod tools_re;
pub mod tools_runs;
pub mod tools_trace;
pub mod tools_workspace;
pub mod ui;
pub mod util;

pub use guard::CLIENT_ACTIVE_WINDOW;
pub use server::NexusMcpServer;
pub use ui::{UiBridge, UiFuture, UI_NOT_ATTACHED, UI_TIMEOUT};

use axum::{middleware, Router};
use nexus_hal::pipeline::PipelineEngine;
use parking_lot::Mutex;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// Default loopback port of the MCP endpoint.
// Below every common ephemeral range: Linux default 32768-60999, Windows 49152-65535 and the
// range WSL2 `networkingMode=mirrored` reserves for Linux (e.g. 44620-48715), where a Windows
// bind fails with AddrInUse even though no process is listening.
pub const DEFAULT_PORT: u16 = 17800;
/// HTTP path of the MCP endpoint.
pub const MCP_PATH: &str = "/mcp";

/// Start-up configuration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct McpConfig {
    /// Loopback TCP port (`0` = ephemeral, used by tests). Default [`DEFAULT_PORT`].
    pub port: u16,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self { port: DEFAULT_PORT }
    }
}

/// Start-up errors.
#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("MCP port {port} on 127.0.0.1 is already in use; choose another port or stop the other process (ports in an ephemeral range, e.g. 44xxx-48xxx under WSL2 mirrored networking, can be reserved even when nothing is listening; ports below 32768 are safest)")]
    PortInUse { port: u16 },
    #[error("cannot bind MCP server to 127.0.0.1:{port}: {source}")]
    Bind {
        port: u16,
        #[source]
        source: std::io::Error,
    },
    #[error("cannot generate MCP access token: {0}")]
    Token(String),
}

/// Point-in-time server status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpServerStatus {
    pub running: bool,
    pub port: u16,
    /// `http://127.0.0.1:<port>/mcp`
    pub endpoint_url: String,
    pub token: String,
    /// Distinct MCP clients (session id, or TCP peer for sessionless requests) that made an
    /// authenticated request within the last [`CLIENT_ACTIVE_WINDOW`] (60 s).
    pub connected_clients: u32,
    /// Number of tool calls served since start.
    pub total_calls: u64,
    /// Always `true` in M1.
    pub read_only: bool,
    /// `true` while a frontend is attached to the UI bridge (`ui_*` tools usable).
    pub ui_attached: bool,
    /// Set if the HTTP server task terminated with an error.
    pub last_error: Option<String>,
}

/// Handle of a running server. Dropping it without [`McpServerHandle::stop`] also stops it.
pub struct McpServerHandle {
    port: u16,
    token: String,
    cancel: CancellationToken,
    task: Option<JoinHandle<()>>,
    flush_task: Option<JoinHandle<()>>,
    ctx: Arc<server::Ctx>,
    guard: Arc<guard::GuardState>,
    task_error: Arc<Mutex<Option<String>>>,
}

impl McpServerHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// Trace cache statistics of this server instance (diagnostics / tests).
    pub fn trace_cache_stats(&self) -> tools_trace::TraceCacheStats {
        self.ctx.traces.stats()
    }

    pub fn endpoint_url(&self) -> String {
        format!("http://127.0.0.1:{}{MCP_PATH}", self.port)
    }

    pub fn status(&self) -> McpServerStatus {
        let running =
            !self.cancel.is_cancelled() && self.task.as_ref().is_some_and(|t| !t.is_finished());
        McpServerStatus {
            running,
            port: self.port,
            endpoint_url: self.endpoint_url(),
            token: self.token.clone(),
            connected_clients: if running {
                self.guard.connected_clients()
            } else {
                0
            },
            total_calls: self.ctx.total_calls.load(Ordering::Relaxed),
            read_only: true,
            ui_attached: self.ctx.ui_attached(),
            last_error: self.task_error.lock().clone(),
        }
    }

    /// Non-blocking stop: cancels all sessions and aborts the HTTP task (the listening socket is
    /// released as soon as the runtime drops the task).
    pub fn stop(mut self) {
        let _ = self.halt();
    }

    /// Async stop that also waits until the HTTP task (and its listening socket) is gone, so the
    /// port can be reused immediately afterwards.
    pub async fn shutdown(mut self) {
        if let Some(t) = self.halt() {
            let _ = t.await;
        }
    }

    /// Cancels sessions + aborts the task; records one `mcp.stopped` audit event.
    fn halt(&mut self) -> Option<JoinHandle<()>> {
        if let Some(f) = self.flush_task.take() {
            f.abort();
        }
        if !self.cancel.is_cancelled() {
            self.cancel.cancel();
            self.ctx.stop.store(true, Ordering::Relaxed);
            // Pending rate-limited audit summary (MCP-QA-03) and trace cache memory (MCP-QA-02)
            // are released deterministically on stop, even if a session still holds the ctx.
            self.ctx.flush_audit(true);
            self.ctx.traces.clear();
            self.ctx.engine.debug_hub().record(
                "info",
                "MCP",
                "mcp",
                None,
                "mcp.stopped",
                format!("MCP server on port {} stopped", self.port),
                Some(format!(
                    "totalCalls={}",
                    self.ctx.total_calls.load(Ordering::Relaxed)
                )),
            );
        }
        let task = self.task.take();
        if let Some(t) = &task {
            t.abort();
        }
        task
    }
}

impl Drop for McpServerHandle {
    fn drop(&mut self) {
        let _ = self.halt();
    }
}

fn generate_token() -> Result<String, McpError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| McpError::Token(e.to_string()))?;
    Ok(util::hex_upper(&bytes).to_ascii_lowercase())
}

/// Starts the MCP server on `127.0.0.1:<cfg.port>` using the caller's Tokio runtime `rt`.
/// Binding happens synchronously, so a busy port is reported here as [`McpError::PortInUse`]
/// (the server never silently falls back to another port).
pub fn start(
    engine: Arc<PipelineEngine>,
    cfg: McpConfig,
    rt: &tokio::runtime::Handle,
) -> Result<McpServerHandle, McpError> {
    start_with_ui(engine, cfg, None, rt)
}

/// Like [`start`], additionally enabling the `ui_*` co-pilot tools through `ui`.
///
/// The bridge is a separate argument (not a `McpConfig` field) so `McpConfig` stays a small
/// `Copy` value and every existing `McpConfig { port }` call site keeps compiling.
pub fn start_with_ui(
    engine: Arc<PipelineEngine>,
    cfg: McpConfig,
    ui: Option<Arc<dyn UiBridge>>,
    rt: &tokio::runtime::Handle,
) -> Result<McpServerHandle, McpError> {
    let token = generate_token()?;
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, cfg.port));
    let std_listener = std::net::TcpListener::bind(addr).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            McpError::PortInUse { port: cfg.port }
        } else {
            McpError::Bind {
                port: cfg.port,
                source: e,
            }
        }
    })?;
    let port = std_listener
        .local_addr()
        .map_err(|e| McpError::Bind {
            port: cfg.port,
            source: e,
        })?
        .port();
    std_listener
        .set_nonblocking(true)
        .map_err(|e| McpError::Bind { port, source: e })?;
    let listener = {
        let _enter = rt.enter();
        tokio::net::TcpListener::from_std(std_listener)
            .map_err(|e| McpError::Bind { port, source: e })?
    };

    let cancel = CancellationToken::new();
    let ctx = Arc::new(server::Ctx::with_ui(engine, ui));
    let guard_state = Arc::new(guard::GuardState::new(token.clone()));

    let rmcp_cfg = StreamableHttpServerConfig::default()
        .with_cancellation_token(cancel.child_token())
        .with_allowed_hosts(["127.0.0.1", "localhost"])
        .with_allowed_origins(["http://127.0.0.1:*", "http://localhost:*"])
        .with_max_request_body_bytes(256 * 1024);
    let factory_ctx = Arc::clone(&ctx);
    let service: StreamableHttpService<NexusMcpServer, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(NexusMcpServer::new(Arc::clone(&factory_ctx))),
            Arc::new(LocalSessionManager::default()),
            rmcp_cfg,
        );

    let app = Router::new()
        .nest_service(MCP_PATH, service)
        .layer(middleware::from_fn_with_state(
            Arc::clone(&guard_state),
            guard::guard,
        ));

    let task_error = Arc::new(Mutex::new(None));
    let task_err = Arc::clone(&task_error);
    let shutdown = cancel.clone();
    let task = rt.spawn(async move {
        let res = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move { shutdown.cancelled_owned().await })
        .await;
        if let Err(e) = res {
            *task_err.lock() = Some(format!("MCP HTTP server stopped: {e}"));
        }
    });

    // Periodic flush of the rate-limited audit summary (MCP-QA-03).
    let flush_ctx = Arc::clone(&ctx);
    let flush_task = rt.spawn(async move {
        let mut tick = tokio::time::interval(audit::AUDIT_FLUSH_INTERVAL);
        tick.tick().await;
        loop {
            tick.tick().await;
            flush_ctx.flush_audit(false);
        }
    });

    ctx.engine.debug_hub().record(
        "info",
        "MCP",
        "mcp",
        None,
        "mcp.started",
        format!("MCP server listening on http://127.0.0.1:{port}{MCP_PATH} (read-only)"),
        None,
    );

    Ok(McpServerHandle {
        port,
        token,
        cancel,
        task: Some(task),
        flush_task: Some(flush_task),
        ctx,
        guard: guard_state,
        task_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_hal::registry::DriverRegistry;
    use nexus_hal::storage::DataRoot;

    /// MCP-QA-02: stopping the server releases cached traces even while other references to
    /// the server context (e.g. lingering sessions) are still alive.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stop_releases_trace_cache() {
        // Nanos, not `{:?}` of SystemTime: its Debug output contains `{`, `:` and spaces, which
        // are invalid in Windows file names (os error 123).
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = DataRoot::under(std::env::temp_dir().join(format!(
            "nexus-mcp-unit-stop-{}-{nanos}",
            std::process::id()
        )));
        root.ensure_dirs().unwrap();
        let engine = Arc::new(PipelineEngine::with_data_root(DriverRegistry::new(), root));
        engine
            .cmd_save_trace_file(
                "s.log".into(),
                Some("(1.000000) can0 1A0#00\n(1.001000) can0 1A0#01\n".into()),
                None,
            )
            .unwrap();
        let handle = start(
            Arc::clone(&engine),
            McpConfig { port: 0 },
            &tokio::runtime::Handle::current(),
        )
        .unwrap();
        let ctx = Arc::clone(&handle.ctx); // simulates a session still holding the ctx
        let weak = Arc::downgrade(&ctx.traces.load(&engine, "s.log").unwrap());
        assert!(weak.upgrade().is_some(), "cached while running");
        assert_eq!(handle.trace_cache_stats().cached_frames, 2);
        handle.stop();
        assert!(weak.upgrade().is_none(), "cache released on stop");
        assert_eq!(ctx.traces.stats().cached_frames, 0);
    }
}
