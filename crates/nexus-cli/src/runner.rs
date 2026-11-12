//! Headless Field Agent runtime orchestrator: `PipelineEngine` lifecycle,
//! local/cloud DBC loading, Read-Only Local Edge Web HMI (`/` & `/api/live` & `/api/status`),
//! WebSocket bridge supervisor, `4003` `EX_CONFIG` (`78`) termination, and clean `SIGINT` + `SIGTERM` shutdown.

use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use base64::engine::general_purpose::{STANDARD as BASE64_STD, STANDARD_NO_PAD as BASE64_NO_PAD};
use base64::Engine as _;
use nexus_hal::{DriverRegistry, HalError, PipelineEngine, TelemetrySnapshotDto};
use thiserror::Error;
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;

use crate::config::EffectiveAgentConfig;
use crate::http_client::sync_project_database_from_cloud;
use crate::web_status::{
    spawn_web_status_server, AgentLiveSnapshotDto, AgentStatusDto, SharedAgentState,
};
use crate::ws_bridge::{
    coalesce_and_convert_snapshot, run_ws_bridge_supervisor, LoadedEdgeDatabase,
    WsSupervisorOutcome,
};

static INSTANCE_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Error)]
pub enum RunnerError {
    #[error("CAN HAL error: {0}")]
    Hal(#[from] HalError),

    #[error("Failed to read local database file '{path}': {source}")]
    DatabaseFileIo {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error("Failed to bind local status HTTP server on '{bind}': {source}")]
    WebBind {
        bind: String,
        #[source]
        source: std::io::Error,
    },

    #[error(
        "Device token revoked or forbidden by NexusCANCloud (4003); stopping agent permanently"
    )]
    TokenRevoked4003,
}

/// Handle to a running headless telemetry agent instance (used by `nexuscan agent run` and E2E tests).
pub struct RunningAgentHandle {
    engine: Option<PipelineEngine>,
    temp_root_dir: PathBuf,
    shared_state: Arc<SharedAgentState>,
    web_local_addr: Option<SocketAddr>,
    shutdown_tx: watch::Sender<bool>,
    ws_join: Option<JoinHandle<WsSupervisorOutcome>>,
    local_ingestor_join: Option<JoinHandle<()>>,
    web_join: Option<JoinHandle<()>>,
}

impl RunningAgentHandle {
    pub fn status_snapshot(&self) -> AgentStatusDto {
        self.shared_state.snapshot()
    }

    pub fn live_snapshot(&self) -> AgentLiveSnapshotDto {
        self.shared_state.live_snapshot()
    }

    pub fn web_local_addr(&self) -> Option<SocketAddr> {
        self.web_local_addr
    }

    /// Cleanly closes the WebSocket bridge (`1000`), stops the optional `/api/status` & Edge HMI server,
    /// disconnects all CAN buses (`< 25ms`), and removes temporary runtime directories.
    pub async fn shutdown(mut self) -> AgentStatusDto {
        let _ = self.shutdown_tx.send(true);
        if let Some(ws_handle) = self.ws_join.take() {
            let _ = ws_handle.await;
        }
        if let Some(local_handle) = self.local_ingestor_join.take() {
            let _ = local_handle.await;
        }
        if let Some(web_handle) = self.web_join.take() {
            let _ = web_handle.await;
        }

        let final_status = self.shared_state.snapshot();

        if let Some(engine) = self.engine.take() {
            let _ = tokio::task::spawn_blocking(move || {
                engine.cmd_disconnect_all_buses();
                drop(engine);
            })
            .await;
        }

        let _ = fs::remove_dir_all(&self.temp_root_dir);
        final_status
    }
}

fn create_isolated_runtime_dirs() -> (PathBuf, PathBuf, PathBuf) {
    let pid = std::process::id();
    let seq = INSTANCE_SEQ.fetch_add(1, Ordering::Relaxed);
    let dir_name = if seq == 0 {
        format!("nexuscan-agent-{pid}")
    } else {
        format!("nexuscan-agent-{pid}-{seq}")
    };
    let root = std::env::temp_dir().join(dir_name);
    let projects = root.join("projects");
    let traces = root.join("traces");
    let _ = fs::create_dir_all(&projects);
    let _ = fs::create_dir_all(&traces);
    (root, projects, traces)
}

async fn run_local_telemetry_ingestor(
    mut rx: broadcast::Receiver<TelemetrySnapshotDto>,
    shared_state: Arc<SharedAgentState>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() {
                    break;
                }
            }
            res = rx.recv() => {
                match res {
                    Ok(snap) => {
                        let coalesced = coalesce_and_convert_snapshot(&snap, Vec::new());
                        shared_state.update_live_telemetry(coalesced);
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

/// Starts the `PipelineEngine`, opens Bus `0` in strict `listen_only = true` mode,
/// loads/syncs any `.dbc`/`.kcd` database, starts the optional Read-Only Edge Web HMI,
/// and spawns the `NexusCANCloud` WebSocket bridge task.
pub async fn spawn_agent_runtime(
    config: EffectiveAgentConfig,
) -> Result<RunningAgentHandle, RunnerError> {
    if config.forced_listen_only_override {
        eprintln!(
            "[SAFETY] Active TX configuration override rejected: NexusCAN headless field agent enforces listen_only = true (passive bus observation only)."
        );
    }

    let (temp_root_dir, projects_dir, traces_dir) = create_isolated_runtime_dirs();
    let engine = PipelineEngine::with_storage_dirs(
        DriverRegistry::with_builtin_drivers(),
        projects_dir,
        traces_dir,
    );

    // 1. Open CAN / CAN-FD Bus 0 with hard listen_only == true assertion
    let channel_cfg = config.to_channel_config_dto();
    assert!(
        channel_cfg.listen_only,
        "SAFETY INVARIANT VIOLATION: ChannelConfigDto.listen_only must be true"
    );

    let bus_health = match engine.cmd_connect_bus(config.resolved_device_id.clone(), channel_cfg) {
        Ok(h) => h,
        Err(e) => {
            let _ = fs::remove_dir_all(&temp_root_dir);
            return Err(RunnerError::Hal(e));
        }
    };
    assert!(
        bus_health.listen_only && !bus_health.tx_armed,
        "SAFETY INVARIANT VIOLATION: connected bus must report listen_only=true and tx_armed=false"
    );

    eprintln!(
        "[INFO] Opened CAN channel '{}' ({}) at {} bps (FD: {}, data: {} bps, Listen-Only: true)",
        bus_health.channel_name,
        bus_health.device_id,
        config.bitrate,
        config.enable_fd,
        config.data_bitrate
    );

    // 2. Load local `--dbc` database OR auto-sync active project database from Cloud
    let loaded_db: Option<LoadedEdgeDatabase> = if let Some(local_dbc) = &config.dbc_path {
        let raw_bytes = match fs::read(local_dbc) {
            Ok(b) => b,
            Err(source) => {
                engine.cmd_disconnect_all_buses();
                let _ = fs::remove_dir_all(&temp_root_dir);
                return Err(RunnerError::DatabaseFileIo {
                    path: local_dbc.display().to_string(),
                    source,
                });
            }
        };
        let file_name = local_dbc
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("local.dbc")
            .to_string();
        let b64 = BASE64_STD.encode(&raw_bytes);
        let schema = match engine.cmd_load_database_content(file_name.clone(), b64, false) {
            Ok(s) => s,
            Err(e) => {
                engine.cmd_disconnect_all_buses();
                let _ = fs::remove_dir_all(&temp_root_dir);
                return Err(RunnerError::Hal(e));
            }
        };
        eprintln!(
            "[INFO] Loaded local database '{}' ({} messages, {} signals)",
            file_name,
            schema.messages.len(),
            schema.signals.len()
        );
        Some(LoadedEdgeDatabase::new(file_name, schema, &raw_bytes))
    } else if config.auto_sync_dbc {
        match sync_project_database_from_cloud(&config.cloud_url, &config.project_id, &config.token)
            .await
        {
            Ok(Some(synced)) => {
                let raw_bytes = BASE64_STD
                    .decode(synced.content_base64.trim())
                    .or_else(|_| BASE64_NO_PAD.decode(synced.content_base64.trim()))
                    .unwrap_or_default();
                match engine.cmd_load_database_content(
                    synced.file_name.clone(),
                    synced.content_base64,
                    false,
                ) {
                    Ok(schema) => {
                        eprintln!(
                            "[INFO] Auto-synced cloud database '{}' ({} messages, {} signals)",
                            synced.file_name,
                            schema.messages.len(),
                            schema.signals.len()
                        );
                        Some(LoadedEdgeDatabase::new(
                            synced.file_name,
                            schema,
                            &raw_bytes,
                        ))
                    }
                    Err(err) => {
                        eprintln!(
                            "[WARN] Cloud database '{}' could not be compiled ({err}); streaming raw CAN frames.",
                            synced.file_name
                        );
                        None
                    }
                }
            }
            Ok(None) => {
                eprintln!(
                    "[INFO] Project '{}' has 0 cloud databases; streaming raw CAN frames.",
                    config.project_id
                );
                None
            }
            Err(err) => {
                eprintln!("[INFO] Cloud DBC auto-sync skipped ({err}); streaming raw CAN frames.");
                None
            }
        }
    } else {
        None
    };

    let shared_state = Arc::new(SharedAgentState::new(
        &config,
        loaded_db.as_ref().map(|d| d.db_name.clone()),
        loaded_db.as_ref().map(|d| &d.schema),
    ));
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    // 3. Optional Read-Only Local Edge Web HMI & `/api/status` Server
    let (web_local_addr, web_join) = if config.web_enabled {
        match spawn_web_status_server(
            &config.web_bind,
            Arc::clone(&shared_state),
            shutdown_rx.clone(),
        )
        .await
        {
            Ok((addr, join)) => {
                eprintln!(
                    "[INFO] Local Read-Only Web HMI listening on http://{addr}/ (API: http://{addr}/api/status)"
                );
                (Some(addr), Some(join))
            }
            Err(source) => {
                engine.cmd_disconnect_all_buses();
                let _ = fs::remove_dir_all(&temp_root_dir);
                return Err(RunnerError::WebBind {
                    bind: config.web_bind.clone(),
                    source,
                });
            }
        }
    } else {
        (None, None)
    };

    // 4. Spawn dedicated 60Hz local state updater so `/api/live` & `/` work 100% offline
    let local_rx = engine.subscribe();
    let local_state = Arc::clone(&shared_state);
    let local_shutdown = shutdown_rx.clone();
    let local_ingestor_join = tokio::spawn(async move {
        run_local_telemetry_ingestor(local_rx, local_state, local_shutdown).await;
    });

    // 5. Subscribe to 60Hz `StateTable` telemetry and spawn non-blocking WebSocket bridge supervisor
    let snapshot_rx = engine.subscribe();
    let ws_state = Arc::clone(&shared_state);
    let ws_shutdown = shutdown_rx.clone();
    let ws_join = tokio::spawn(async move {
        run_ws_bridge_supervisor(config, loaded_db, snapshot_rx, ws_state, ws_shutdown).await
    });

    Ok(RunningAgentHandle {
        engine: Some(engine),
        temp_root_dir,
        shared_state,
        web_local_addr,
        shutdown_tx,
        ws_join: Some(ws_join),
        local_ingestor_join: Some(local_ingestor_join),
        web_join,
    })
}

/// Runs the headless field telemetry agent until `SIGINT` (`Ctrl+C`), `SIGTERM`, or permanent
/// `4003` token revocation occurs, performing deterministic graceful hardware & server cleanup.
pub async fn run_agent_until_signal(config: EffectiveAgentConfig) -> Result<(), RunnerError> {
    let mut handle = spawn_agent_runtime(config).await?;
    let mut ws_join = handle.ws_join.take().expect("ws_join present");

    tokio::select! {
        _ = wait_for_os_termination_signal() => {
            handle.ws_join = Some(ws_join);
            eprintln!("[INFO] Shutdown signal received; closing WebSocket bridge and CAN channels...");
            let _ = handle.shutdown().await;
            eprintln!("[INFO] NexusCAN headless agent stopped cleanly.");
            Ok(())
        }
        ws_res = &mut ws_join => {
            match ws_res {
                Ok(WsSupervisorOutcome::RevokedForbidden4003) => {
                    eprintln!(
                        "[ERROR] Cloud token revoked/forbidden (4003); closing CAN channels and exiting with EX_CONFIG (78)..."
                    );
                    let _ = handle.shutdown().await;
                    Err(RunnerError::TokenRevoked4003)
                }
                _ => {
                    let _ = handle.shutdown().await;
                    Ok(())
                }
            }
        }
    }
}

async fn wait_for_os_termination_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut sigterm) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = sigterm.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }

    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
