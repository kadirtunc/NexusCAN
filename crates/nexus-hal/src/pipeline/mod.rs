//! Multi-bus 60Hz Telemetry Pipeline Engine (`PipelineEngine`), safety interlocks,
//! preset/custom `.dbc` & `.kcd` database management, persistent `.nexusproj.json` project storage,
//! cross-OS driver diagnostics, and all 20 IPC command handlers.

pub mod blf;
pub mod diag_discovery;
pub mod diag_dtc;
pub mod diag_flash;
pub mod diag_passive;
pub mod diag_session;
pub mod diag_sweep;
pub mod diag_tap;
pub mod diag_workspace;
mod echo_suppress;
pub mod re_analyzer;
pub mod replay;
pub mod state_table;
pub mod tx_scheduler;

use crate::debug_log::DebugEventHub;
use crate::drivers::gs_usb_drv::usb_device_location_info;
use crate::drivers::probe::probe_all_drivers;
use crate::dto::{
    AppendDebugEventInputDto, BusHealthDto, ChannelConfigDto, ChronologicalFrameDto,
    DbFileInputDto, DebugEventBatchDto, DebugEventDto, DebugWindowStateDto, DeviceDescriptorDto,
    DriverProbeReportDto, HardwareWatchEventDto, LoadedTraceFileDto, PanicStopResultDto,
    PeriodicTxJobDto, ProjectSummaryDto, ResetSessionResultDto, StartTraceReplayArgsDto,
    TelemetrySnapshotDto, TraceFileSummaryDto, TraceReplayControlArgsDto, TraceReplayStatusDto,
    TraceStorageInfoDto, TxTransmitResultDto,
};
use crate::error::{AdapterError, HalError};
use crate::registry::DriverRegistry;
use crate::storage::{
    check_frame_count, check_ipc_size, DataRoot, MAX_DB_FILES_PER_CALL, MAX_IPC_CONTENT_BYTES,
    MAX_IPC_DB_TOTAL_BYTES, MAX_LISTED_ENTRIES, MAX_PROJECT_FILE_BYTES,
};
use crate::traits::{BusState, CanChannel, DeviceDescriptor, ListenOnlyEnforcement};
use base64::engine::general_purpose::{STANDARD as BASE64_STD, STANDARD_NO_PAD as BASE64_NO_PAD};
use base64::Engine as _;
use crossbeam_channel::{bounded, select, Receiver, Sender, TrySendError};
use diag_tap::{DiagBusShared, GateRefs, TapCtl, TapRegisterError, TapTable, TxOrigin};
use futures_lite::StreamExt as _;
use nexus_core::{now_monotonic_us, BusId, CanIdKey, RawCanFrame};
use nexus_netdb::{
    merge_databases, CompiledDatabase, DatabaseInfoDto, DatabaseSchemaDto, DbError, FormatRegistry,
    NetworkDatabase, ParseOptions,
};
use nexus_protocols::uds::dto::{DiagError, DiagErrorCode};
use nexus_protocols::uds::port::{DiagPortEvent, DiagTapFilter, DiagTxReject};
use parking_lot::{Mutex, RwLock};
use re_analyzer::{
    ReClassificationDto, ReCorrelateRequest, ReCorrelationResultDto, ReError, ReFocusStatusDto,
    ReMarkerDto, RePhase, ReRowDetailDto, ReScanFirstSpec, ReScanNextOp, ReScanResultsDto,
    ReScanSort, ReScanStatusDto, ReSeriesRequest, ReShared, ReStatusDto, ReTargetDto,
    RE_SNAPSHOT_MAX_BYTES,
};
use replay::{
    compile_chronological_frames, delete_trace_file, list_trace_files, load_trace_file_cached,
    parse_trace_bytes, parse_trace_entries_from_bytes, read_trace_file_bytes,
    sanitize_trace_filename, save_trace_file_bytes_cached, ReplayController, TraceStatsCache,
};
use state_table::StateTable;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;
use tx_scheduler::{find_clamped_signals, TxScheduler};

/// Capacity of the lock-free/bounded RX frame ring between reader threads and `StateTable`.
pub const FRAME_RING_CAPACITY: usize = 65_536;

/// Exact 60Hz snapshot emission period (`16,667 us`).
pub const SNAPSHOT_INTERVAL_US: u64 = 16_667;

enum AggregatorControl {
    SetDatabase(Option<Arc<CompiledDatabase>>),
    SetBusDatabase(BusId, Option<Arc<CompiledDatabase>>),
    ClearAllBusDatabases,
    ClearBus(BusId),
    ResetAll,
    FlushSnapshot(Sender<TelemetrySnapshotDto>),
}

pub(crate) struct TxDispatchRequest {
    pub(crate) frame: RawCanFrame,
    pub(crate) ack: Option<Sender<Result<(), AdapterError>>>,
    pub(crate) suppress_echo: bool,
    pub(crate) hw_tx_counter: Option<Arc<AtomicU64>>,
    /// D-003: diag-tap TX verdicts (`TxConfirmed` / `TxRejected`) go to the origin tap only.
    pub(crate) origin: TxOrigin,
    /// WP-4: TX epoch observed when the request was enqueued. Panic Stop and
    /// `cmd_reset_session` bump the engine epoch, so a request queued before them is rejected
    /// by the bus-io gate even if the bus is cleared + re-armed before the queue drains.
    pub(crate) epoch: u64,
}

/// Test-only instrumentation: runs once at the start of every bus-io thread (used by the
/// allocation-counting integration test to mark the thread). Not part of the public API and
/// compiled only for unit tests or with the `test-hooks` feature (WP-8 / LOW-01).
#[cfg(any(test, feature = "test-hooks"))]
#[doc(hidden)]
pub static BUS_IO_THREAD_START_HOOK: Mutex<Option<fn()>> = Mutex::new(None);

pub(crate) struct ConnectedBusHandle {
    bus_id: BusId,
    descriptor: DeviceDescriptor,
    config: ChannelConfigDto,
    pub(crate) listen_only: bool,
    pub(crate) tx_armed: Arc<AtomicBool>,
    bus_state: Arc<AtomicU8>,
    tx_errors: Arc<AtomicU32>,
    rx_errors: Arc<AtomicU32>,
    stop_flag: Arc<AtomicBool>,
    pub(crate) tx_sender: Sender<TxDispatchRequest>,
    io_join: Option<JoinHandle<()>>,
    /// D-003 diag tap registry of this bus.
    diag: Arc<DiagBusShared>,
    /// D-005: how Listen-Only is enforced (`None` when the bus is active).
    listen_only_enforcement: Option<ListenOnlyEnforcement>,
    /// WP-4: engine-wide TX epoch (shared with every bus, scheduler and replay).
    pub(crate) tx_epoch: Arc<AtomicU64>,
    /// Write barrier: non-zero while this bus's io thread is between "enter gate" and
    /// "`send_frame` returned" (see [`TxInFlightGuard`] and [`wait_tx_quiesced`]).
    tx_in_flight: Arc<AtomicU32>,
}

/// What [`PipelineEngine::quiesce_bus_after_disarm`] waits on (cloned under the buses lock).
struct DisarmBarrier {
    in_flight: Arc<AtomicU32>,
    tx_sender: Sender<TxDispatchRequest>,
    bus_state: Arc<AtomicU8>,
}

impl ConnectedBusHandle {
    fn disarm_barrier(&self) -> DisarmBarrier {
        DisarmBarrier {
            in_flight: Arc::clone(&self.tx_in_flight),
            tx_sender: self.tx_sender.clone(),
            bus_state: Arc::clone(&self.bus_state),
        }
    }

    #[inline]
    pub(crate) fn is_connected(&self) -> bool {
        BusState::from_u8(self.bus_state.load(Ordering::Acquire)) != BusState::Disconnected
    }

    fn to_health_dto(&self) -> BusHealthDto {
        let state = BusState::from_u8(self.bus_state.load(Ordering::Acquire));
        BusHealthDto {
            bus_id: self.bus_id,
            device_id: self.descriptor.device_id.clone(),
            channel_name: self.descriptor.channel_name.clone(),
            connected: state != BusState::Disconnected,
            listen_only: self.listen_only,
            tx_armed: self.tx_armed.load(Ordering::Acquire),
            bus_state: state.as_str().to_string(),
            tx_error_count: self.tx_errors.load(Ordering::Relaxed),
            rx_error_count: self.rx_errors.load(Ordering::Relaxed),
            listen_only_enforcement: self.listen_only_enforcement.map(|e| e.as_str().to_string()),
        }
    }

    #[inline]
    fn fd_enabled(&self) -> bool {
        self.config.enable_fd && self.descriptor.capabilities.supports_fd
    }

    fn nominal_capacity_bps(&self) -> u64 {
        if self.config.enable_fd && self.descriptor.capabilities.supports_fd {
            u64::from(
                self.config
                    .data_bitrate
                    .max(self.config.bitrate)
                    .max(500_000),
            )
        } else {
            u64::from(self.config.bitrate.max(125_000))
        }
    }

    fn shutdown(&mut self) {
        // Disarm BEFORE stopping: the io thread finishes its current TX drain before it sees
        // `stop_flag`, and the gate must reject everything in that drain. The join below is
        // the (unbounded) write barrier for this path.
        self.tx_armed.store(false, Ordering::SeqCst);
        self.diag.close_all();
        self.stop_flag.store(true, Ordering::Release);
        if let Some(handle) = self.io_join.take() {
            let _ = handle.join();
        }
        self.bus_state
            .store(BusState::Disconnected.to_u8(), Ordering::Release);
    }
}

struct LoadedDatabaseState {
    raw_database: NetworkDatabase,
    compiled: Arc<CompiledDatabase>,
    schema: DatabaseSchemaDto,
}

/// Zero-`unsafe` async `Waker` shutdown latch allowing `nusb::watch_devices()` to exit in `< 1 ms`.
struct HwWatchShutdown {
    stopped: AtomicBool,
    waker: Mutex<Option<std::task::Waker>>,
}

impl HwWatchShutdown {
    fn new() -> Self {
        Self {
            stopped: AtomicBool::new(false),
            waker: Mutex::new(None),
        }
    }

    fn signal(&self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(w) = self.waker.lock().take() {
            w.wake();
        }
    }

    #[inline]
    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }
}

/// Identity and safety state captured before asking the operator to arm a bus.
pub struct BusArmTarget {
    bus_id: BusId,
    connection: Arc<AtomicBool>,
    epoch: u64,
    listen_only: bool,
    armed: bool,
    deadline: Instant,
}

/// Core NexusCAN multi-bus pipeline engine shared by both `src-tauri` and `nexus_bridge`.
pub struct PipelineEngine {
    registry: Arc<DriverRegistry>,
    /// WP-8: persistent `projects/` + `traces/` locations (see [`crate::storage`]).
    data_root: DataRoot,
    /// WP-8: frame-count cache so `cmd_list_traces` never parses file bodies.
    trace_stats: TraceStatsCache,
    /// Structured system audit & multi-window debug console ring buffer.
    pub(crate) debug_hub: Arc<DebugEventHub>,
    buses: Arc<Mutex<BTreeMap<BusId, ConnectedBusHandle>>>,
    db_state: RwLock<Option<LoadedDatabaseState>>,
    bus_db_states: RwLock<BTreeMap<BusId, Option<LoadedDatabaseState>>>,
    tx_scheduler: Arc<Mutex<TxScheduler>>,
    replay: Arc<ReplayController>,
    frame_tx: Sender<RawCanFrame>,
    ctrl_tx: Sender<AggregatorControl>,
    dropped_frames: Arc<AtomicU64>,
    tx_panic_latched: Arc<AtomicBool>,
    /// WP-4: bumped by Panic Stop / reset session; see [`TxDispatchRequest::epoch`].
    tx_epoch: Arc<AtomicU64>,
    /// Bound for the per-bus disarm write barrier. Always [`TX_QUIESCE_TIMEOUT`] in production;
    /// the race tests raise it so a paused CI VM cannot turn the bounded wait into a false
    /// "returned early" (the barrier logic itself is unchanged).
    disarm_quiesce_timeout: Duration,
    engine_stop: Arc<AtomicBool>,
    snapshot_bcast_tx: broadcast::Sender<TelemetrySnapshotDto>,
    latest_snapshot: Arc<RwLock<Option<TelemetrySnapshotDto>>>,
    hw_bcast_tx: broadcast::Sender<HardwareWatchEventDto>,
    hw_watcher_started: AtomicBool,
    hw_watch_shutdown: Arc<HwWatchShutdown>,
    hw_stop_tx: Sender<()>,
    hw_stop_rx: Receiver<()>,
    hw_hotplug_join: Mutex<Option<JoinHandle<()>>>,
    hw_topology_join: Mutex<Option<JoinHandle<()>>>,
    aggregator_join: Mutex<Option<JoinHandle<()>>>,
    scheduler_join: Mutex<Option<JoinHandle<()>>>,
    /// D-003 diag session manager (`cmd_diag_*`), see [`diag_session`].
    diag_sessions: diag_session::DiagSessionMap,
    /// Passive (TX-free) ECU discovery scans by bus, see [`diag_passive`].
    diag_passive: diag_passive::PassiveScanMap,
    /// Buses with a physical sweep in progress, see [`diag_sweep`].
    diag_sweeps: diag_sweep::SweepGuardSet,
    /// Parsed firmware images by `imageId`, see [`diag_flash`].
    flash_images: diag_flash::FlashImageCache,
    /// Cancel flags of running flash downloads by session key, see [`diag_flash`].
    flash_runs: diag_flash::FlashRunMap,
    /// Diagnostics Workspace flow library (`<data_root>/flowlib`), see [`diag_workspace`].
    flowlib: crate::flowlib::FlowLibrary,
    /// Append-only run store (`<data_root>/runs`), see [`diag_workspace`].
    runstore: crate::runstore::RunStore,
    /// RE Toolkit R1 sniffer state (ingested by the aggregator thread), see [`re_analyzer`].
    re: Arc<ReShared>,
    /// Active 10 Hz RE binary snapshot subscription (single subscriber, latest wins).
    re_sub: Mutex<Option<ReSubscription>>,
}

/// Longest DNS host name (RFC 1035); also bounds IPv4 / `[ipv6]:port` literals.
pub const CANSUB_MAX_HOST_LEN: usize = 253;

/// Validates `cmd_cansub_probe_host` arguments: `host` is trimmed, non-empty and at most
/// [`CANSUB_MAX_HOST_LEN`] characters; a non-blank `device_id` must be exactly 8 hex digits and is
/// normalized to lower case (blank -> `None`). Errors are [`HalError::InvalidInput`].
pub fn validate_cansub_probe_args(
    host: &str,
    device_id: Option<String>,
) -> Result<(String, Option<String>), HalError> {
    let host = host.trim();
    if host.is_empty() {
        return Err(HalError::InvalidInput(
            "CANsub: host / IP address must not be empty".into(),
        ));
    }
    if host.chars().count() > CANSUB_MAX_HOST_LEN {
        return Err(HalError::InvalidInput(format!(
            "CANsub: host is longer than {CANSUB_MAX_HOST_LEN} characters"
        )));
    }
    let device_id = match device_id.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(id) if id.len() == 8 && id.bytes().all(|b| b.is_ascii_hexdigit()) => {
            Some(id.to_ascii_lowercase())
        }
        Some(id) => {
            return Err(HalError::InvalidInput(format!(
                "CANsub: Device ID '{id}' must be exactly 8 hex digits (e.g. 1a2b3c4d)"
            )))
        }
    };
    Ok((host.to_string(), device_id))
}

impl Default for PipelineEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl PipelineEngine {
    /// Creates and starts the 60Hz aggregator and periodic TX scheduler worker threads.
    pub fn new() -> Self {
        Self::with_registry(DriverRegistry::with_builtin_drivers())
    }

    /// Creates a [`PipelineEngine`] with a custom [`DriverRegistry`] and the default data root
    /// ([`DataRoot::resolve_default`]: `NEXUS_DATA_DIR`, else the dev repo-relative layout).
    pub fn with_registry(registry: DriverRegistry) -> Self {
        Self::with_data_root(registry, DataRoot::resolve_default())
    }

    /// Creates a [`PipelineEngine`] with an explicit persistent `./projects` directory path.
    pub fn with_projects_dir(registry: DriverRegistry, projects_dir: PathBuf) -> Self {
        let traces_dir = DataRoot::resolve_default().traces_dir().to_path_buf();
        Self::with_storage_dirs(registry, projects_dir, traces_dir)
    }

    /// Creates a [`PipelineEngine`] with explicit persistent `./projects` and `./traces` directories.
    pub fn with_storage_dirs(
        registry: DriverRegistry,
        projects_dir: PathBuf,
        traces_dir: PathBuf,
    ) -> Self {
        Self::with_data_root(registry, DataRoot::from_dirs(projects_dir, traces_dir))
    }

    /// WP-8: creates a [`PipelineEngine`] storing projects/traces under `data_root`
    /// (`src-tauri` passes `app_local_data_dir()`). Directories are created lazily on first
    /// use as well, so a failure here is not fatal.
    pub fn with_data_root(registry: DriverRegistry, data_root: DataRoot) -> Self {
        let _ = data_root.ensure_dirs();

        let (frame_tx, frame_rx) = bounded::<RawCanFrame>(FRAME_RING_CAPACITY);
        let (ctrl_tx, ctrl_rx) = bounded::<AggregatorControl>(64);
        let (snapshot_bcast_tx, _) = broadcast::channel::<TelemetrySnapshotDto>(128);
        let (hw_bcast_tx, _) = broadcast::channel::<HardwareWatchEventDto>(32);
        let (hw_stop_tx, hw_stop_rx) = bounded::<()>(1);

        let buses: Arc<Mutex<BTreeMap<BusId, ConnectedBusHandle>>> =
            Arc::new(Mutex::new(BTreeMap::new()));
        let tx_scheduler = Arc::new(Mutex::new(TxScheduler::new()));
        let dropped_frames = Arc::new(AtomicU64::new(0));
        let tx_panic_latched = Arc::new(AtomicBool::new(false));
        let tx_epoch = Arc::new(AtomicU64::new(0));
        let engine_stop = Arc::new(AtomicBool::new(false));
        let latest_snapshot = Arc::new(RwLock::new(None));

        let logs_dir_opt = if cfg!(any(test, feature = "test-hooks")) {
            None
        } else {
            Some(data_root.logs_dir())
        };
        let debug_hub = Arc::new(DebugEventHub::with_logs_dir(logs_dir_opt));
        debug_hub.record(
            "info",
            "CONN",
            "backend",
            None,
            "engine.started",
            "NexusCAN Telemetry Pipeline Engine initialized",
            Some(format!(
                "os={}, arch={}, ringCap=5000",
                std::env::consts::OS,
                std::env::consts::ARCH
            )),
        );

        let replay = Arc::new(ReplayController::spawn(
            frame_tx.clone(),
            Arc::clone(&dropped_frames),
            Arc::clone(&buses),
            Arc::clone(&tx_panic_latched),
            Arc::clone(&engine_stop),
        ));

        let agg_stop = Arc::clone(&engine_stop);
        let agg_buses = Arc::clone(&buses);
        let agg_dropped = Arc::clone(&dropped_frames);
        let agg_panic = Arc::clone(&tx_panic_latched);
        let agg_replay = Arc::clone(&replay);
        let agg_bcast = snapshot_bcast_tx.clone();
        let agg_latest = Arc::clone(&latest_snapshot);
        let agg_debug = Arc::clone(&debug_hub);
        let re = Arc::new(ReShared::new());
        let agg_re = Arc::clone(&re);

        let aggregator_handle = thread::Builder::new()
            .name("nexus-aggregator-60hz".to_string())
            .spawn(move || {
                run_aggregator_loop(
                    frame_rx,
                    ctrl_rx,
                    agg_stop,
                    agg_buses,
                    agg_dropped,
                    agg_panic,
                    agg_replay,
                    agg_bcast,
                    agg_latest,
                    agg_debug,
                    agg_re,
                );
            })
            .expect("failed to spawn nexus-aggregator-60hz thread");

        let sched_stop = Arc::clone(&engine_stop);
        let sched_panic = Arc::clone(&tx_panic_latched);
        let sched_epoch = Arc::clone(&tx_epoch);
        let sched_buses = Arc::clone(&buses);
        let sched_table = Arc::clone(&tx_scheduler);
        let sched_debug = Arc::clone(&debug_hub);

        let scheduler_handle = thread::Builder::new()
            .name("nexus-tx-scheduler".to_string())
            .spawn(move || {
                run_tx_scheduler_loop(
                    sched_stop,
                    sched_panic,
                    sched_epoch,
                    sched_buses,
                    sched_table,
                    sched_debug,
                );
            })
            .expect("failed to spawn nexus-tx-scheduler thread");

        Self {
            registry: Arc::new(registry),
            trace_stats: TraceStatsCache::default(),
            debug_hub,
            buses,
            db_state: RwLock::new(None),
            bus_db_states: RwLock::new(BTreeMap::new()),
            tx_scheduler,
            replay,
            frame_tx,
            ctrl_tx,
            dropped_frames,
            tx_panic_latched,
            tx_epoch,
            disarm_quiesce_timeout: TX_QUIESCE_TIMEOUT,
            engine_stop,
            snapshot_bcast_tx,
            latest_snapshot,
            hw_bcast_tx,
            hw_watcher_started: AtomicBool::new(false),
            hw_watch_shutdown: Arc::new(HwWatchShutdown::new()),
            hw_stop_tx,
            hw_stop_rx,
            hw_hotplug_join: Mutex::new(None),
            hw_topology_join: Mutex::new(None),
            aggregator_join: Mutex::new(Some(aggregator_handle)),
            scheduler_join: Mutex::new(Some(scheduler_handle)),
            diag_sessions: diag_session::DiagSessionMap::default(),
            diag_passive: diag_passive::PassiveScanMap::default(),
            diag_sweeps: diag_sweep::SweepGuardSet::default(),
            flash_images: diag_flash::FlashImageCache::default(),
            flash_runs: diag_flash::FlashRunMap::default(),
            flowlib: crate::flowlib::FlowLibrary::new(data_root.flowlib_dir()),
            runstore: crate::runstore::RunStore::new(data_root.runs_dir()),
            data_root,
            re,
            re_sub: Mutex::new(None),
        }
    }

    /// Subscribes to the 60Hz [`TelemetrySnapshotDto`] broadcast stream.
    pub fn subscribe(&self) -> broadcast::Receiver<TelemetrySnapshotDto> {
        self.snapshot_bcast_tx.subscribe()
    }

    /// Returns a reference to the shared [`DebugEventHub`].
    pub fn debug_hub(&self) -> &Arc<DebugEventHub> {
        &self.debug_hub
    }

    /// Subscribes to structured [`DebugEventBatchDto`] updates (`"append"`, `"cleared"`, `"windowState"`).
    pub fn subscribe_debug_events(&self) -> broadcast::Receiver<DebugEventBatchDto> {
        self.debug_hub.subscribe()
    }

    /// Captures a `"snapshot"` batch of all buffered debug/audit events + current window state.
    pub fn snapshot_debug_events(&self) -> DebugEventBatchDto {
        self.debug_hub.snapshot_batch()
    }

    /// Appends a structured event from the UI or an external caller (`cmd_append_debug_event`).
    pub fn cmd_append_debug_event(&self, input: AppendDebugEventInputDto) -> DebugEventDto {
        self.debug_hub.append_input(input)
    }

    /// Clears all buffered events in `DebugEventHub` (`cmd_clear_debug_events`).
    pub fn cmd_clear_debug_events(&self) {
        self.debug_hub.clear();
    }

    /// Exports all buffered debug events as `"jsonl"`, `"log"`, or `"csv"` (`cmd_export_debug_events`).
    pub fn cmd_export_debug_events(&self, format: String) -> Result<String, HalError> {
        self.debug_hub.export_formatted(&format)
    }

    /// Synchronizes tear-off window state across `"main"` and `"debug-console"` (`cmd_set_debug_window_open`).
    pub fn set_debug_window_state(
        &self,
        detached_open: bool,
        always_on_top: bool,
        re_dock_requested: bool,
    ) -> DebugWindowStateDto {
        self.debug_hub
            .set_window_state(detached_open, always_on_top, re_dock_requested)
    }

    /// Captures a point-in-time cross-OS hardware discovery + driver probe snapshot (`HardwareWatchEventDto`).
    pub fn snapshot_hardware_state(&self, reason: &str) -> HardwareWatchEventDto {
        self.reap_dead_buses();
        build_hardware_watch_event(&self.registry, reason)
    }

    /// Subscribes to OS-level USB hotplug (`nusb::watch_devices()`) and periodic (`2,500 ms`)
    /// topology change events, lazy-starting the two background watcher threads on first call.
    pub fn subscribe_hardware_changes(&self) -> broadcast::Receiver<HardwareWatchEventDto> {
        let rx = self.hw_bcast_tx.subscribe();
        self.ensure_hardware_watchers_started();
        rx
    }

    fn ensure_hardware_watchers_started(&self) {
        if self.engine_stop.load(Ordering::Acquire) {
            return;
        }
        if self
            .hw_watcher_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }

        let (pulse_tx, pulse_rx) = bounded::<()>(1);
        let hotplug_epoch = Arc::new(AtomicU64::new(0));

        // Thread A — OS Native USB Hotplug Event Listener (`nusb::watch_devices()`)
        let hp_stop = Arc::clone(&self.engine_stop);
        let hp_shutdown = Arc::clone(&self.hw_watch_shutdown);
        let hp_epoch = Arc::clone(&hotplug_epoch);
        if let Ok(handle_a) = thread::Builder::new()
            .name("nexus-usb-hotplug".to_string())
            .spawn(move || {
                run_usb_hotplug_listener(hp_stop, hp_shutdown, hp_epoch, pulse_tx);
            })
        {
            *self.hw_hotplug_join.lock() = Some(handle_a);
        }

        // Thread B — Debounced Hotplug Emitter + Lightweight Topology Fingerprint Poll (2,500 ms)
        let topo_stop = Arc::clone(&self.engine_stop);
        let topo_stop_rx = self.hw_stop_rx.clone();
        let topo_registry = Arc::clone(&self.registry);
        let topo_buses = Arc::clone(&self.buses);
        let topo_sched = Arc::clone(&self.tx_scheduler);
        let topo_bcast = self.hw_bcast_tx.clone();
        let topo_epoch = Arc::clone(&hotplug_epoch);
        let topo_debug = Arc::clone(&self.debug_hub);
        if let Ok(handle_b) = thread::Builder::new()
            .name("nexus-hw-topology".to_string())
            .spawn(move || {
                run_hardware_topology_watcher(
                    topo_stop,
                    topo_stop_rx,
                    pulse_rx,
                    topo_epoch,
                    topo_registry,
                    topo_buses,
                    topo_sched,
                    topo_bcast,
                    topo_debug,
                );
            })
        {
            *self.hw_topology_join.lock() = Some(handle_b);
        }
    }

    /// Returns the most recently emitted [`TelemetrySnapshotDto`], if any.
    pub fn latest_snapshot(&self) -> Option<TelemetrySnapshotDto> {
        self.latest_snapshot.read().clone()
    }

    /// Forces an immediate synchronous snapshot flush from the aggregator thread (useful for tests).
    pub fn flush_snapshot_now(&self) -> Result<TelemetrySnapshotDto, HalError> {
        let (tx, rx) = bounded(1);
        self.ctrl_tx
            .send(AggregatorControl::FlushSnapshot(tx))
            .map_err(|_| HalError::InvalidInput("Aggregator thread stopped".to_string()))?;
        rx.recv_timeout(Duration::from_millis(250))
            .map_err(|_| HalError::InvalidInput("Timed out waiting for snapshot flush".to_string()))
    }

    // =========================================================================
    // EXACT 12 IPC COMMAND IMPLEMENTATIONS
    // =========================================================================

    fn spawn_connected_bus_handle(
        &self,
        bus_id: BusId,
        descriptor: DeviceDescriptor,
        config: ChannelConfigDto,
        channel: Box<dyn CanChannel>,
        initial_tx_armed: bool,
    ) -> Result<ConnectedBusHandle, HalError> {
        let initial_health = channel.health();
        let listen_only = config.listen_only;
        let listen_only_enforcement = listen_only.then(|| channel.listen_only_enforcement());
        let (diag, diag_ctl_rx) = DiagBusShared::new();
        let effective_armed = initial_tx_armed && !listen_only;

        let tx_armed = Arc::new(AtomicBool::new(effective_armed));
        let bus_state = Arc::new(AtomicU8::new(initial_health.state.to_u8()));
        let tx_errors = Arc::new(AtomicU32::new(initial_health.tx_error_count));
        let rx_errors = Arc::new(AtomicU32::new(initial_health.rx_error_count));
        let stop_flag = Arc::new(AtomicBool::new(false));
        let (tx_sender, tx_receiver) = bounded::<TxDispatchRequest>(4_096);

        let io_stop = Arc::clone(&stop_flag);
        let io_engine_stop = Arc::clone(&self.engine_stop);
        let io_armed = Arc::clone(&tx_armed);
        let io_state = Arc::clone(&bus_state);
        let io_tx_err = Arc::clone(&tx_errors);
        let io_rx_err = Arc::clone(&rx_errors);
        let io_frame_tx = self.frame_tx.clone();
        let io_dropped = Arc::clone(&self.dropped_frames);
        let io_panic = Arc::clone(&self.tx_panic_latched);
        let io_epoch = Arc::clone(&self.tx_epoch);
        let tx_in_flight = Arc::new(AtomicU32::new(0));
        let io_in_flight = Arc::clone(&tx_in_flight);
        let io_debug = Arc::clone(&self.debug_hub);

        let io_join = thread::Builder::new()
            .name(format!("nexus-bus-io-{bus_id}"))
            .spawn(move || {
                run_bus_io_loop(
                    bus_id,
                    listen_only,
                    channel,
                    tx_receiver,
                    io_frame_tx,
                    io_dropped,
                    io_stop,
                    io_engine_stop,
                    io_armed,
                    io_panic,
                    io_epoch,
                    io_in_flight,
                    io_state,
                    io_tx_err,
                    io_rx_err,
                    diag_ctl_rx,
                    io_debug,
                );
            })
            .map_err(|e| HalError::Adapter(AdapterError::Io(e)))?;

        Ok(ConnectedBusHandle {
            bus_id,
            descriptor,
            config,
            listen_only,
            tx_armed,
            bus_state,
            tx_errors,
            rx_errors,
            stop_flag,
            tx_sender,
            io_join: Some(io_join),
            diag,
            listen_only_enforcement,
            tx_epoch: Arc::clone(&self.tx_epoch),
            tx_in_flight,
        })
    }

    /// Write barrier for one bus after `tx_armed` was cleared (SeqCst). Unlike Panic Stop /
    /// reset, disarm does not bump the engine-wide epoch (that would spuriously reject TX on
    /// every other bus), so requests still QUEUED for this bus are not epoch-invalidated.
    /// Instead we wait until the io thread has drained the queue (every request drained after
    /// the disarm store is rejected by the gate) and no write is in flight; a fast re-arm can
    /// then not release a pre-disarm frame.
    ///
    /// Returns `Err` if that does not happen within [`TX_QUIESCE_TIMEOUT`]; the bus stays
    /// disarmed either way.
    fn quiesce_bus_after_disarm(&self, bus_id: BusId, b: DisarmBarrier) -> Result<(), HalError> {
        let deadline = Instant::now() + self.disarm_quiesce_timeout;
        // A dead io thread (channel closed) never drains, but it cannot write either.
        let io_alive =
            || BusState::from_u8(b.bus_state.load(Ordering::Acquire)) != BusState::Disconnected;
        while !b.tx_sender.is_empty() && io_alive() && Instant::now() < deadline {
            thread::sleep(Duration::from_micros(100));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        let stuck = wait_tx_quiesced(&[(bus_id, b.in_flight)], remaining);
        if stuck.is_empty() && (b.tx_sender.is_empty() || !io_alive()) {
            Ok(())
        } else {
            report_quiesce_timeout("disarm", &[bus_id]);
            Err(HalError::SafetyLock(format!(
                "{TX_IN_FLIGHT_TIMEOUT_PREFIX} bus {bus_id} is disarmed, but a driver write or \
                 queued TX request from before the disarm was not settled within {} ms",
                self.disarm_quiesce_timeout.as_millis()
            )))
        }
    }

    /// Snapshot of every connected bus's write-barrier counter (cold path, may allocate).
    fn in_flight_counters(&self) -> Vec<(BusId, Arc<AtomicU32>)> {
        self.buses
            .lock()
            .iter()
            .map(|(id, b)| (*id, Arc::clone(&b.tx_in_flight)))
            .collect()
    }

    /// WP-4 (CRIT-05.3): registers a periodic TX job only if, at registration time and under
    /// BOTH the buses and scheduler locks, the Panic latch is clear, no Panic Stop / reset
    /// happened since the request started (`epoch`), and the bus is still armed and active.
    ///
    /// Lock order is buses -> scheduler (nobody takes them the other way round nested).
    /// Panic Stop bumps the epoch and sets the latch BEFORE it clears the scheduler, so either
    /// this check fails, or the job is registered first and then removed by `clear_all`.
    fn register_periodic_job_checked(
        &self,
        bus_id: BusId,
        label: String,
        can_id: CanIdKey,
        period_ms: u32,
        frame: RawCanFrame,
        epoch: u64,
    ) -> Result<u64, HalError> {
        let guard = self.buses.lock();
        let mut sched = self.tx_scheduler.lock();
        let bus = guard
            .get(&bus_id)
            .ok_or(HalError::BusNotConnected(bus_id))?;
        if self.tx_panic_latched.load(Ordering::Acquire)
            || self.tx_epoch.load(Ordering::Acquire) != epoch
        {
            return Err(panic_latched_error());
        }
        if bus.listen_only {
            return Err(HalError::Adapter(AdapterError::ListenOnlyMode));
        }
        if !bus.tx_armed.load(Ordering::Acquire) {
            return Err(HalError::SafetyLock(format!(
                "Bus {bus_id} TX was disarmed before the periodic job could be registered"
            )));
        }
        Ok(sched.register_job(label, bus_id, can_id, period_ms, frame))
    }

    /// 1. `cmd_list_devices` -> Discovers all available hardware and virtual CAN channels.
    pub fn cmd_list_devices(&self) -> Vec<DeviceDescriptorDto> {
        self.reap_dead_buses();
        self.registry.discover_all()
    }

    /// The registered CSS Electronics CANsub driver (for `CansubDriver::add_known_host`, used by
    /// the Tauri `cmd_cansub_probe_host` command). `None` only for custom registries without it.
    pub fn cansub_driver(&self) -> Option<Arc<crate::drivers::cansub_drv::CansubDriver>> {
        self.registry.cansub()
    }

    /// `cmd_cansub_probe_host` -> Validates the arguments ([`validate_cansub_probe_args`]),
    /// connects to a manually entered CANsub host (TLS rules from `device_id` / `accept_any`),
    /// remembers it for discovery / open and returns one descriptor per channel. Blocking
    /// network I/O (≤ ~3 s connect timeout): call from a blocking worker, never a UI thread.
    /// SDK / driver error messages (e.g. the "enter the Device ID" hint) pass through verbatim.
    pub fn cmd_cansub_probe_host(
        &self,
        host: String,
        device_id: Option<String>,
        accept_any: bool,
    ) -> Result<Vec<DeviceDescriptorDto>, HalError> {
        let (host, device_id) = validate_cansub_probe_args(&host, device_id)?;
        let driver = self.cansub_driver().ok_or_else(|| {
            HalError::Adapter(AdapterError::Driver(
                "CANsub driver is not available in this build".into(),
            ))
        })?;
        Ok(driver.add_known_host(&host, device_id, accept_any)?)
    }

    /// Side-effect-free device discovery (no dead-bus reaping, no lock on `buses`): same list as
    /// [`Self::cmd_list_devices`]. Used by read-only consumers such as the MCP server.
    pub fn discover_devices(&self) -> Vec<DeviceDescriptorDto> {
        self.registry.discover_all()
    }

    /// Reaps any `ConnectedBusHandle` whose channel has transitioned to [`BusState::Disconnected`]
    /// (e.g. physical USB hot-unplug), disarming TX, stopping periodic jobs, closing diag taps,
    /// and joining its I/O thread outside locks so OS handles are released immediately.
    pub fn reap_dead_buses(&self) -> usize {
        reap_dead_bus_handles(&self.buses, &self.tx_scheduler, &self.debug_hub)
    }

    /// 2. `cmd_connect_bus` -> Opens a CAN / CAN-FD channel and starts its zero-alloc reader thread.
    ///
    /// WP-5 fail-closed: with `config.listen_only && config.require_hardware_listen_only`, a
    /// channel that could only be software-locked is never connected (see
    /// [`DriverRegistry::open_by_device_id`]); the bus is not inserted and the error is a
    /// [`HalError::SafetyLock`] whose message starts with
    /// [`crate::error::HW_LISTEN_ONLY_UNAVAILABLE_PREFIX`].
    pub fn cmd_connect_bus(
        &self,
        device_id: String,
        mut config: ChannelConfigDto,
    ) -> Result<BusHealthDto, HalError> {
        let bus_id = config.bus_id;
        // Reap any unplugged / dead handle before checking `contains_key(&bus_id)` so hot-replugging
        // an adapter never hits a zombie `BusAlreadyConnected` error!
        self.reap_dead_buses();

        let result =
            (|| -> Result<(BusHealthDto, String, ChannelConfigDto, Option<String>), HalError> {
                {
                    let guard = self.buses.lock();
                    if guard.contains_key(&bus_id) {
                        return Err(HalError::BusAlreadyConnected(bus_id));
                    }
                }

                let (descriptor, channel) = self
                    .registry
                    .open_by_device_id(&device_id, &config)
                    .map_err(HalError::from_channel_open)?;
                let driver_id = descriptor.driver_id.clone();
                if descriptor.driver_id == "gs_usb" && config.adapter_channel.is_some() {
                    config.adapter_channel = Some(descriptor.channel_name.clone());
                }
                let cfg_snap = config.clone();
                let timing_note = channel.bit_timing_note();
                let handle =
                    self.spawn_connected_bus_handle(bus_id, descriptor, config, channel, false)?;

                let dto = handle.to_health_dto();
                self.buses.lock().insert(bus_id, handle);
                Ok((dto, driver_id, cfg_snap, timing_note))
            })();

        match result {
            Ok((dto, driver_id, cfg_snap, timing_note)) => {
                let bitrate_desc = if cfg_snap.enable_fd {
                    format!(
                        "{} / {} bps (CAN-FD)",
                        cfg_snap.bitrate, cfg_snap.data_bitrate
                    )
                } else {
                    format!("{} bps (Classical CAN)", cfg_snap.bitrate)
                };
                self.debug_hub.record(
                    "success",
                    "CONN",
                    "backend",
                    Some(bus_id),
                    "bus.connected",
                    format!(
                        "Connected Bus {} to {} ({})",
                        u16::from(bus_id) + 1,
                        dto.device_id,
                        dto.channel_name
                    ),
                    Some(format!(
                        "driver={driver_id}, bitrate={bitrate_desc}, listenOnly={}, \
                         enforcement={}{}",
                        dto.listen_only,
                        dto.listen_only_enforcement.as_deref().unwrap_or("none"),
                        timing_note
                            .map(|n| format!(", timing={n}"))
                            .unwrap_or_default()
                    )),
                );
                Ok(dto)
            }
            Err(err) => {
                self.debug_hub.record(
                    "error",
                    "CONN",
                    "backend",
                    Some(bus_id),
                    "bus.connect_failed",
                    format!(
                        "Failed to connect Bus {} to {device_id}",
                        u16::from(bus_id) + 1
                    ),
                    Some(err.to_string()),
                );
                Err(err)
            }
        }
    }

    /// 3. `cmd_disconnect_bus` -> Stops periodic TX on `bus_id` and cleanly closes the channel (`< 25ms`).
    pub fn cmd_disconnect_bus(&self, bus_id: u8) -> Result<(), HalError> {
        self.tx_scheduler.lock().remove_jobs_for_bus(bus_id);

        let mut handle = self
            .buses
            .lock()
            .remove(&bus_id)
            .ok_or(HalError::BusNotConnected(bus_id))?;

        let dev_id = handle.descriptor.device_id.clone();
        let chan_name = handle.descriptor.channel_name.clone();
        handle.shutdown();
        let _ = self.ctrl_tx.try_send(AggregatorControl::ClearBus(bus_id));

        self.debug_hub.record(
            "info",
            "CONN",
            "backend",
            Some(bus_id),
            "bus.disconnected",
            format!("Disconnected Bus {} ({dev_id})", u16::from(bus_id) + 1),
            Some(format!("channel={chan_name}")),
        );
        Ok(())
    }

    /// 4. `cmd_arm_active_bus` -> Arms or disarms active TX on `bus_id`, enforcing `Listen-Only` lock.
    pub fn cmd_arm_active_bus(&self, bus_id: u8, armed: bool) -> Result<BusHealthDto, HalError> {
        let res = (|| -> Result<BusHealthDto, HalError> {
            let guard = self.buses.lock();
            let bus = guard
                .get(&bus_id)
                .ok_or(HalError::BusNotConnected(bus_id))?;

            if armed {
                if bus.listen_only {
                    return Err(HalError::SafetyLock(
                        "Cannot arm TX while channel is opened in Listen-Only mode; reconnect with Listen-Only unchecked"
                            .to_string(),
                    ));
                }
                // WP-4: arming never clears the Panic latch (`cmd_clear_panic_latch` does).
                if self.tx_panic_latched.load(Ordering::SeqCst) {
                    return Err(panic_latched_error());
                }
                bus.tx_armed.store(true, Ordering::SeqCst);
            } else {
                // SeqCst store, then the write barrier (see `cmd_panic_stop_tx`).
                bus.tx_armed.store(false, Ordering::SeqCst);
                bus.diag.close_all();
                let barrier = bus.disarm_barrier();
                drop(guard);
                self.tx_scheduler.lock().remove_jobs_for_bus(bus_id);
                self.quiesce_bus_after_disarm(bus_id, barrier)?;
                let guard2 = self.buses.lock();
                let bus2 = guard2
                    .get(&bus_id)
                    .ok_or(HalError::BusNotConnected(bus_id))?;
                return Ok(bus2.to_health_dto());
            }

            Ok(bus.to_health_dto())
        })();

        match &res {
            Ok(dto) => {
                if dto.tx_armed {
                    self.debug_hub.record(
                        "safety",
                        "SAFETY",
                        "backend",
                        Some(bus_id),
                        "safety.tx_armed",
                        format!(
                            "Active TX armed on Bus {} ({})",
                            u16::from(bus_id) + 1,
                            dto.device_id
                        ),
                        Some(format!("channel={}, listenOnly=false", dto.channel_name)),
                    );
                } else {
                    self.debug_hub.record(
                        "safety",
                        "SAFETY",
                        "backend",
                        Some(bus_id),
                        "safety.tx_disarmed",
                        format!(
                            "Active TX disarmed on Bus {} ({})",
                            u16::from(bus_id) + 1,
                            dto.device_id
                        ),
                        Some("periodicJobsCleared=true, diagTapsClosed=true".to_string()),
                    );
                }
            }
            Err(err) => {
                self.debug_hub.record(
                    "warn",
                    "SAFETY",
                    "backend",
                    Some(bus_id),
                    if armed {
                        "safety.tx_arm_rejected"
                    } else {
                        "safety.tx_disarm_warning"
                    },
                    format!(
                        "TX {} blocked on Bus {}",
                        if armed { "arm" } else { "disarm" },
                        u16::from(bus_id) + 1
                    ),
                    Some(err.to_string()),
                );
            }
        }
        res
    }

    /// Atomically transitions an ALREADY-CONNECTED `bus_id` between `Listen-Only` and `Active TX`
    /// while strictly preserving its bound `descriptor.device_id` (e.g. `"socketcan:vcan0"`) and
    /// existing `StateTable` RX history.
    ///
    /// Never opens a fallback or `mock0` device: returns `Err(HalError::BusNotConnected(bus_id))`
    /// if `bus_id` is not currently connected.
    ///
    /// The stored `require_hardware_listen_only` flag is kept across re-opens. If a re-open into
    /// Listen-Only is refused by it (`HW_LISTEN_ONLY_UNAVAILABLE:`), the old channel is already
    /// closed and the bus stays disconnected (fail-closed), like any other re-open failure.
    pub fn cmd_set_bus_mode(
        &self,
        bus_id: u8,
        listen_only: bool,
        arm_tx: bool,
    ) -> Result<BusHealthDto, HalError> {
        self.set_bus_mode(bus_id, listen_only, arm_tx, None)
    }

    pub fn capture_bus_arm_target(
        &self,
        bus_id: BusId,
        timeout: Duration,
    ) -> Result<(BusArmTarget, BusHealthDto), HalError> {
        let buses = self.buses.lock();
        let epoch = self.tx_epoch.load(Ordering::SeqCst);
        if self.is_panic_latched() {
            return Err(panic_latched_error());
        }
        let bus = buses.get(&bus_id).ok_or(HalError::BusNotConnected(bus_id))?;
        let health = bus.to_health_dto();
        if !health.connected {
            return Err(HalError::BusNotConnected(bus_id));
        }
        Ok((
            BusArmTarget {
                bus_id,
                connection: Arc::clone(&bus.tx_armed),
                epoch,
                listen_only: health.listen_only,
                armed: health.tx_armed,
                deadline: Instant::now() + timeout.min(Duration::from_secs(60)),
            },
            health,
        ))
    }

    pub fn arm_confirmed_bus(&self, target: BusArmTarget) -> Result<BusHealthDto, HalError> {
        self.set_bus_mode(target.bus_id, false, true, Some(target))
    }

    fn validate_bus_arm_target(
        &self,
        bus: &ConnectedBusHandle,
        target: &BusArmTarget,
    ) -> Result<(), HalError> {
        if Instant::now() >= target.deadline
            || self.tx_epoch.load(Ordering::SeqCst) != target.epoch
            || self.is_panic_latched()
            || !Arc::ptr_eq(&bus.tx_armed, &target.connection)
            || !bus.to_health_dto().connected
            || bus.listen_only != target.listen_only
            || bus.tx_armed.load(Ordering::SeqCst) != target.armed
        {
            return Err(HalError::SafetyLock(
                "Arm Active Bus approval expired or the target bus changed".into(),
            ));
        }
        Ok(())
    }

    fn set_bus_mode(
        &self,
        bus_id: u8,
        listen_only: bool,
        arm_tx: bool,
        approval: Option<BusArmTarget>,
    ) -> Result<BusHealthDto, HalError> {
        let res = (|| -> Result<BusHealthDto, HalError> {
            let target_armed = arm_tx && !listen_only;
            // A Panic Stop / reset that lands while the channel is reopened bumps the epoch.
            let epoch_at_start = self.tx_epoch.load(Ordering::SeqCst);

            {
                let guard = self.buses.lock();
                let bus = guard
                    .get(&bus_id)
                    .ok_or(HalError::BusNotConnected(bus_id))?;
                if let Some(target) = &approval {
                    self.validate_bus_arm_target(bus, target)?;
                }
                if target_armed && self.tx_panic_latched.load(Ordering::SeqCst) {
                    return Err(panic_latched_error());
                }
                if bus.listen_only == listen_only {
                    bus.tx_armed.store(target_armed, Ordering::SeqCst);
                    if target_armed {
                        return Ok(bus.to_health_dto());
                    }
                    bus.diag.close_all();
                    let barrier = bus.disarm_barrier();
                    drop(guard);
                    self.tx_scheduler.lock().remove_jobs_for_bus(bus_id);
                    self.quiesce_bus_after_disarm(bus_id, barrier)?;
                    let guard2 = self.buses.lock();
                    let bus2 = guard2
                        .get(&bus_id)
                        .ok_or(HalError::BusNotConnected(bus_id))?;
                    return Ok(bus2.to_health_dto());
                }
            }

            // Mode change (`listen_only` toggled): stop periodic TX jobs for this bus first.
            let mut old_handle = {
                let mut buses = self.buses.lock();
                if let Some(target) = &approval {
                    let bus = buses.get(&bus_id).ok_or(HalError::BusNotConnected(bus_id))?;
                    self.validate_bus_arm_target(bus, target)?;
                }
                buses.remove(&bus_id).ok_or(HalError::BusNotConnected(bus_id))?
            };
            self.tx_scheduler.lock().remove_jobs_for_bus(bus_id);

            let exact_device_id = old_handle.descriptor.device_id.clone();
            let mut updated_config = old_handle.config.clone();
            updated_config.bus_id = bus_id;
            updated_config.listen_only = listen_only;

            // Cleanly close the existing handle WITHOUT sending AggregatorControl::ClearBus(bus_id)
            // so captured RX frames on this bus remain visible in StateTable!
            old_handle.shutdown();
            if approval.is_some()
                && (self.tx_epoch.load(Ordering::SeqCst) != epoch_at_start
                    || self.is_panic_latched())
            {
                return Err(panic_latched_error());
            }

            let (descriptor, channel) = self
                .registry
                .open_by_device_id(&exact_device_id, &updated_config)
                .map_err(HalError::from_channel_open)?;

            // WP-4: a Panic Stop may have landed while the channel was reopened; never come back
            // armed in that case (the bus is reconnected disarmed instead).
            let target_armed = target_armed && !self.tx_panic_latched.load(Ordering::SeqCst);

            let mut new_handle = self.spawn_connected_bus_handle(
                bus_id,
                descriptor,
                updated_config,
                channel,
                target_armed,
            )?;
            // The new bus is not in `buses` yet, so a Panic Stop / reset racing the reopen could
            // not disarm it. Re-check under the buses lock (Panic bumps the epoch BEFORE it takes
            // that lock): either we see the bump here, or Panic sees the inserted bus. Nobody can
            // enqueue TX before the insert (its `tx_sender` is not published yet).
            let mut guard = self.buses.lock();
            let stopped = self.tx_epoch.load(Ordering::SeqCst) != epoch_at_start
                || self.tx_panic_latched.load(Ordering::SeqCst);
            if approval.is_some() && (stopped || guard.contains_key(&bus_id)) {
                drop(guard);
                new_handle.shutdown();
                return Err(HalError::SafetyLock(
                    "Bus changed or Panic Stop interrupted arming".into(),
                ));
            }
            if stopped {
                new_handle.tx_armed.store(false, Ordering::SeqCst);
            }
            let dto = new_handle.to_health_dto();
            guard.insert(bus_id, new_handle);
            Ok(dto)
        })();

        match &res {
            Ok(dto) => {
                let mode_label = if dto.listen_only {
                    "Listen-Only (Passive)"
                } else {
                    "Active CAN"
                };
                self.debug_hub.record(
                    "safety",
                    "SAFETY",
                    "backend",
                    Some(bus_id),
                    "safety.mode_changed",
                    format!(
                        "Bus {} mode switched to {mode_label}",
                        u16::from(bus_id) + 1
                    ),
                    Some(format!(
                        "device={}, txArmed={}, enforcement={}",
                        dto.device_id,
                        dto.tx_armed,
                        dto.listen_only_enforcement.as_deref().unwrap_or("none")
                    )),
                );
            }
            Err(err) => {
                self.debug_hub.record(
                    "error",
                    "SAFETY",
                    "backend",
                    Some(bus_id),
                    "safety.mode_change_failed",
                    format!(
                        "Failed to switch Bus {} mode (listenOnly={listen_only})",
                        u16::from(bus_id) + 1
                    ),
                    Some(err.to_string()),
                );
            }
        }
        res
    }

    /// 5. `cmd_panic_stop_tx` -> Emergency stop: cancels all periodic TX jobs, disarms replay hardware TX, and disarms every bus.
    ///
    /// Contract: when this returns, no driver write that passed a bus-io safety gate before
    /// the Panic is still running (write barrier, bounded by [`TX_QUIESCE_TIMEOUT`]; buses
    /// that exceed it are reported in `in_flight_timeout_buses`), and no frame of the old
    /// epoch can be written afterwards, even after Clear Panic + re-arm.
    ///
    /// Memory ordering (Dekker-style store->load handshake, all `SeqCst`):
    /// * bus-io: `tx_in_flight.fetch_add(1)` -> load latch / epoch / armed -> `send_frame`
    ///   -> `tx_in_flight.fetch_sub(1)`.
    /// * here: epoch `fetch_add` + latch store + armed swap -> load `tx_in_flight` until 0.
    ///
    /// In the single total order of SeqCst operations, either the bus-io gate loads come after
    /// our latch store (the gate rejects), or its `fetch_add` comes before our first
    /// `tx_in_flight` load (we observe >= 1 and wait for the matching `fetch_sub`, whose
    /// release makes the completed `send_frame` happen-before our return). Acquire/Release
    /// alone would allow both sides to read the stale value (store->load reordering).
    pub fn cmd_panic_stop_tx(&self) -> PanicStopResultDto {
        // Order matters (WP-4): epoch + latch BEFORE the scheduler is cleared.
        self.tx_epoch.fetch_add(1, Ordering::SeqCst);
        self.tx_panic_latched.store(true, Ordering::SeqCst);
        // Cancel running flash downloads BEFORE the taps close, so they end as `cancelled`
        // (not as a transport failure) and never send another block.
        let cancelled_flash_downloads = self
            .flash_runs
            .cancel_all(diag_flash::CancelReason::PanicStop);
        self.replay.disarm_hardware_tx();
        let stopped_periodic_jobs = self.tx_scheduler.lock().clear_all();

        let mut disarmed_buses = 0usize;
        let in_flight = {
            let guard = self.buses.lock();
            let mut counters = Vec::with_capacity(guard.len());
            for (bus_id, bus) in guard.iter() {
                if bus.tx_armed.swap(false, Ordering::SeqCst) {
                    disarmed_buses += 1;
                }
                // D-003: every diag tap dies with Panic Stop (pending sends -> Closed).
                bus.diag.close_all();
                counters.push((*bus_id, Arc::clone(&bus.tx_in_flight)));
            }
            counters
        };
        // Wait OUTSIDE the buses lock: bus-io threads never take it, but the aggregator and
        // scheduler do, and they must not stall behind a slow driver write.
        let in_flight_timeout_buses = wait_tx_quiesced(&in_flight, TX_QUIESCE_TIMEOUT);
        if !in_flight_timeout_buses.is_empty() {
            report_quiesce_timeout("panic stop", &in_flight_timeout_buses);
        }

        let details = if in_flight_timeout_buses.is_empty() {
            format!(
                "stoppedPeriodicJobs={stopped_periodic_jobs}, disarmedBuses={disarmed_buses}, cancelledFlashDownloads={cancelled_flash_downloads}, panicLatch=true"
            )
        } else {
            format!(
                "stoppedPeriodicJobs={stopped_periodic_jobs}, disarmedBuses={disarmed_buses}, cancelledFlashDownloads={cancelled_flash_downloads}, inFlightTimeoutBuses={in_flight_timeout_buses:?}"
            )
        };
        self.debug_hub.record(
            if in_flight_timeout_buses.is_empty() {
                "safety"
            } else {
                "error"
            },
            "SAFETY",
            "backend",
            None,
            "safety.panic_stop",
            format!(
                "PANIC STOP engaged — stopped {stopped_periodic_jobs} job(s), disarmed {disarmed_buses} bus(es)"
            ),
            Some(details),
        );

        PanicStopResultDto {
            stopped_periodic_jobs,
            disarmed_buses,
            timestamp_us: now_monotonic_us(),
            in_flight_timeout_buses,
        }
    }

    /// WP-4: `cmd_clear_panic_latch` -> clears the global Panic Stop latch ONLY. Buses stay
    /// disarmed; the operator must explicitly Arm Active Bus again.
    pub fn cmd_clear_panic_latch(&self) {
        self.tx_panic_latched.store(false, Ordering::SeqCst);
        self.debug_hub.record(
            "safety",
            "SAFETY",
            "backend",
            None,
            "safety.panic_cleared",
            "Panic Stop latch cleared — buses remain safely disarmed",
            None,
        );
    }

    /// `true` while the Panic Stop latch is engaged.
    pub fn is_panic_latched(&self) -> bool {
        self.tx_panic_latched.load(Ordering::Acquire)
    }

    /// WP-4: `cmd_reset_session` -> cold-start / "new session" reset that does NOT latch
    /// Panic Stop: stops every periodic TX job, disarms replay hardware TX, closes every diag
    /// session and tap, disarms and disconnects every bus, then clears the Panic latch.
    /// Nothing can transmit afterwards (no bus is connected).
    pub fn cmd_reset_session(&self) -> ResetSessionResultDto {
        // Invalidate anything already queued towards a bus-io thread.
        self.tx_epoch.fetch_add(1, Ordering::SeqCst);
        self.replay.disarm_hardware_tx();
        self.flash_runs
            .cancel_all(diag_flash::CancelReason::SessionReset);
        self.diag_sessions.clear();

        let mut disarmed_buses = 0usize;
        {
            let guard = self.buses.lock();
            for bus in guard.values() {
                if bus.tx_armed.swap(false, Ordering::SeqCst) {
                    disarmed_buses += 1;
                }
                bus.diag.close_all();
            }
        }
        // Bounded write barrier (same handshake as Panic Stop) BEFORE the unbounded joins in
        // `cmd_disconnect_all_buses`, so a stuck driver write is reported, not just waited on.
        let in_flight_timeout_buses =
            wait_tx_quiesced(&self.in_flight_counters(), TX_QUIESCE_TIMEOUT);
        if !in_flight_timeout_buses.is_empty() {
            report_quiesce_timeout("reset session", &in_flight_timeout_buses);
        }
        let stopped_periodic_jobs = self.tx_scheduler.lock().clear_all();
        // Also clears the scheduler again, so a job registered in between cannot survive.
        let disconnected_buses = self.cmd_disconnect_all_buses();
        self.tx_panic_latched.store(false, Ordering::SeqCst);

        self.debug_hub.record(
            "safety",
            "SAFETY",
            "backend",
            None,
            "safety.session_reset",
            format!(
                "Session reset completed — disconnected {disconnected_buses} bus(es), stopped {stopped_periodic_jobs} job(s)"
            ),
            Some(format!(
                "disarmedBuses={disarmed_buses}, inFlightTimeoutBuses={in_flight_timeout_buses:?}"
            )),
        );

        ResetSessionResultDto {
            stopped_periodic_jobs,
            disarmed_buses,
            disconnected_buses,
            in_flight_timeout_buses,
        }
    }

    /// WP-2: `cmd_seedkey_capabilities`. `policy` is per caller (desktop: native allowed;
    /// bridge: loopback + env switch). Reports which native kinds exist and whether the
    /// 32/64-bit `library` helpers were found. Touches the file system: call it off the
    /// async runtime.
    pub fn cmd_seedkey_capabilities(
        &self,
        policy: crate::seedkey::SeedKeyPolicy,
    ) -> nexus_protocols::uds::security::SeedKeyCapabilitiesDto {
        crate::seedkey::capabilities(policy)
    }

    /// WP-2: `cmd_seedkey_compute_adhoc`. Portable kinds always; native kinds (`library` via
    /// the isolated helper process, `external_process`) only when `policy` allows them.
    /// BLOCKING: call it from `spawn_blocking` (Tauri) / a blocking task (bridge).
    pub fn cmd_seedkey_compute_adhoc(
        &self,
        policy: crate::seedkey::SeedKeyPolicy,
        provider: &nexus_protocols::uds::security::KeyProviderSpecDto,
        level: u8,
        seed_hex: &str,
    ) -> Result<
        nexus_protocols::uds::security::ComputeKeyResultDto,
        nexus_protocols::uds::security::SeedKeyError,
    > {
        let res = crate::seedkey::compute_adhoc(policy, provider, level, seed_hex);
        match &res {
            Ok(out) => {
                // Never the key bytes: length, provider kind and timing only.
                self.debug_hub.record(
                    "info",
                    "DIAG",
                    "protocol",
                    None,
                    "diag.seedkey",
                    format!("Computed UDS 0x27 Seed/Key for security level 0x{level:02X}"),
                    Some(format!(
                        "provider={}, keyHexLen={}, elapsedUs={}",
                        out.provider_kind,
                        out.key_hex.len(),
                        out.elapsed_us
                    )),
                );
            }
            Err(err) => {
                self.debug_hub.record(
                    "warn",
                    "DIAG",
                    "protocol",
                    None,
                    "diag.seedkey_failed",
                    format!("UDS 0x27 Seed/Key computation failed (level 0x{level:02X})"),
                    Some(err.to_string()),
                );
            }
        }
        res
    }

    /// Contract `cmd_seedkey_probe_library`: library header (format / arch) parsed in-process
    /// without loading it; exports detected by the isolated helper. Native policy applies.
    /// BLOCKING (starts a helper process): call it from a blocking worker.
    pub fn cmd_seedkey_probe_library(
        &self,
        policy: crate::seedkey::SeedKeyPolicy,
        path: &str,
    ) -> Result<
        nexus_protocols::uds::security::SeedKeyLibraryInfoDto,
        nexus_protocols::uds::security::SeedKeyError,
    > {
        crate::seedkey::probe_library(policy, path)
    }

    /// 6. `cmd_load_preset_databases` -> Parses & merges `scripts/sample_vehicle.dbc` + `scripts/sample_bms.kcd`.
    ///    WP-8: the preset files are embedded at build time (no runtime repo lookup).
    pub fn cmd_load_preset_databases(&self) -> Result<DatabaseSchemaDto, HalError> {
        let registry = FormatRegistry::new();
        let opts = ParseOptions::default();
        let dbc_bundle =
            registry.parse_bytes(PRESET_VEHICLE_DBC, Some(PRESET_VEHICLE_DBC_NAME), &opts)?;
        let kcd_bundle = registry.parse_bytes(PRESET_BMS_KCD, Some(PRESET_BMS_KCD_NAME), &opts)?;

        let mut diagnostics = dbc_bundle.diagnostics;
        diagnostics.extend(kcd_bundle.diagnostics);

        let (mut merged_raw, merge_diags) =
            merge_databases(vec![dbc_bundle.database, kcd_bundle.database]);
        merged_raw.name = "NexusCAN EV Powertrain + Multi-Bank BMS Preset".to_string();
        diagnostics.extend(merge_diags);

        let message_count = merged_raw.messages.len();
        let signal_count = merged_raw.messages.values().map(|m| m.signals.len()).sum();
        let info = DatabaseInfoDto {
            name: merged_raw.name.clone(),
            version: merged_raw.version.clone(),
            format: "DBC + KCD".to_string(),
            source_encoding: "UTF-8".to_string(),
            message_count,
            signal_count,
            diagnostics,
        };

        let compiled = Arc::new(CompiledDatabase::compile(merged_raw.clone())?);
        let schema = compiled.to_schema_dto(info);

        *self.db_state.write() = Some(LoadedDatabaseState {
            raw_database: merged_raw,
            compiled: Arc::clone(&compiled),
            schema: schema.clone(),
        });
        let _ = self
            .ctrl_tx
            .send(AggregatorControl::SetDatabase(Some(compiled)));

        self.debug_hub.record(
            "success",
            "NETDB",
            "backend",
            None,
            "netdb.preset_loaded",
            format!("Loaded preset database ({message_count} messages, {signal_count} signals)"),
            Some(format!(
                "files={PRESET_VEHICLE_DBC_NAME} + {PRESET_BMS_KCD_NAME}"
            )),
        );

        Ok(schema)
    }

    /// 7. `cmd_get_current_schema` -> Returns the currently loaded Plane 1 `DatabaseSchemaDto`, if any.
    pub fn cmd_get_current_schema(&self) -> Option<DatabaseSchemaDto> {
        self.db_state.read().as_ref().map(|s| s.schema.clone())
    }

    /// Read-only handle to the currently loaded global compiled database (the one bound to the
    /// `StateTable`), if any. Cheap `Arc` clone; never touches the RX / aggregator hot path.
    /// Used by offline consumers such as the in-app MCP server (`nexus-mcp`).
    pub fn current_compiled_database(&self) -> Option<Arc<CompiledDatabase>> {
        self.db_state
            .read()
            .as_ref()
            .map(|s| Arc::clone(&s.compiled))
    }

    /// Read-only `DatabaseInfoDto` (name / format / counts / parse diagnostics) of the currently
    /// loaded global database, without cloning the full schema.
    pub fn current_database_info(&self) -> Option<nexus_netdb::DatabaseInfoDto> {
        self.db_state.read().as_ref().map(|s| s.schema.info.clone())
    }

    /// Read-only list of per-bus database bindings (`cmd_set_bus_databases`), ascending by bus
    /// id: `(bus_id, compiled, info)`. Buses explicitly bound to "no database" (Raw Hex mode)
    /// are omitted. `Arc` clones under a read lock; no behavior change, no hot-path access.
    pub fn bus_databases(&self) -> Vec<(u8, Arc<CompiledDatabase>, nexus_netdb::DatabaseInfoDto)> {
        self.bus_db_states
            .read()
            .iter()
            .filter_map(|(bus, st)| {
                st.as_ref()
                    .map(|s| (*bus, Arc::clone(&s.compiled), s.schema.info.clone()))
            })
            .collect()
    }

    /// 8. `cmd_load_database_content` -> Decodes Base64 `.dbc` / `.kcd` bytes, compiles, and binds to `StateTable`.
    pub fn cmd_load_database_content(
        &self,
        file_name: String,
        content_base64: String,
        append_to_existing: bool,
    ) -> Result<DatabaseSchemaDto, HalError> {
        check_ipc_size(
            "Database content",
            content_base64.len(),
            MAX_IPC_CONTENT_BYTES,
        )?;
        let raw_bytes = decode_base64_db_bytes(&content_base64)?;

        let registry = FormatRegistry::new();
        let bundle =
            registry.parse_bytes(&raw_bytes, Some(&file_name), &ParseOptions::default())?;

        let existing_raw = if append_to_existing {
            self.db_state
                .read()
                .as_ref()
                .map(|st| st.raw_database.clone())
        } else {
            None
        };

        let (target_raw, format_str, source_enc, diagnostics) = if let Some(prev_raw) = existing_raw
        {
            let prev_name = prev_raw.name.clone();
            let mut diags = bundle.diagnostics;
            let (mut merged, merge_diags) = merge_databases(vec![prev_raw, bundle.database]);
            merged.name = format!("{prev_name} + {file_name}");
            diags.extend(merge_diags);
            (
                merged,
                format!("Merged ({})", bundle.format_name),
                bundle.source_encoding.to_string(),
                diags,
            )
        } else {
            (
                bundle.database,
                bundle.format_name.to_string(),
                bundle.source_encoding.to_string(),
                bundle.diagnostics,
            )
        };

        let message_count = target_raw.messages.len();
        let signal_count = target_raw.messages.values().map(|m| m.signals.len()).sum();
        let info = DatabaseInfoDto {
            name: target_raw.name.clone(),
            version: target_raw.version.clone(),
            format: format_str,
            source_encoding: source_enc,
            message_count,
            signal_count,
            diagnostics,
        };

        let compiled = Arc::new(CompiledDatabase::compile(target_raw.clone())?);
        let schema = compiled.to_schema_dto(info);

        *self.db_state.write() = Some(LoadedDatabaseState {
            raw_database: target_raw,
            compiled: Arc::clone(&compiled),
            schema: schema.clone(),
        });
        let _ = self
            .ctrl_tx
            .send(AggregatorControl::SetDatabase(Some(compiled)));

        self.debug_hub.record(
            "success",
            "NETDB",
            "backend",
            None,
            "netdb.loaded",
            format!(
                "Loaded database '{file_name}' ({message_count} messages, {signal_count} signals)"
            ),
            Some(format!("append={append_to_existing}")),
        );

        Ok(schema)
    }

    /// Stateless `.dbc` / `.kcd` parser & compiler returning `DatabaseSchemaDto` for the UI catalog
    /// without mutating `db_state`, `bus_db_states`, or `StateTable`.
    pub fn cmd_parse_database_schema(
        &self,
        file_name: String,
        content_base64: String,
    ) -> Result<DatabaseSchemaDto, HalError> {
        check_ipc_size(
            "Database content",
            content_base64.len(),
            MAX_IPC_CONTENT_BYTES,
        )?;
        let raw_bytes = decode_base64_db_bytes(&content_base64)?;
        let bundle = FormatRegistry::new().parse_bytes(
            &raw_bytes,
            Some(&file_name),
            &ParseOptions::default(),
        )?;

        let message_count = bundle.database.messages.len();
        let signal_count = bundle
            .database
            .messages
            .values()
            .map(|m| m.signals.len())
            .sum();
        let info = DatabaseInfoDto {
            name: bundle.database.name.clone(),
            version: bundle.database.version.clone(),
            format: bundle.format_name.to_string(),
            source_encoding: bundle.source_encoding.to_string(),
            message_count,
            signal_count,
            diagnostics: bundle.diagnostics,
        };

        let compiled = CompiledDatabase::compile(bundle.database)?;
        Ok(compiled.to_schema_dto(info))
    }

    /// Returns the embedded `scripts/sample_vehicle.dbc` and `scripts/sample_bms.kcd` as Base64
    /// `DbFileInputDto` items for populating the multi-database catalog without mutating `StateTable`.
    pub fn cmd_get_preset_database_files(&self) -> Result<Vec<DbFileInputDto>, HalError> {
        Ok(vec![
            DbFileInputDto {
                file_name: PRESET_VEHICLE_DBC_NAME.to_string(),
                content_base64: BASE64_STD.encode(PRESET_VEHICLE_DBC),
            },
            DbFileInputDto {
                file_name: PRESET_BMS_KCD_NAME.to_string(),
                content_base64: BASE64_STD.encode(PRESET_BMS_KCD),
            },
        ])
    }

    /// Binds 0, 1, or multiple `.dbc` / `.kcd` files exclusively to `bus_id` (`0..=255`, i.e. `Bus 1..Bus 256`),
    /// returning `Ok(None)` when `files` is empty (pure Raw Hex mode on `bus_id`) or
    /// `Ok(Some(DatabaseSchemaDto))` for the compiled per-bus database.
    pub fn cmd_set_bus_databases(
        &self,
        bus_id: u8,
        files: Vec<DbFileInputDto>,
    ) -> Result<Option<DatabaseSchemaDto>, HalError> {
        if files.is_empty() {
            self.bus_db_states.write().insert(bus_id, None);
            let _ = self
                .ctrl_tx
                .send(AggregatorControl::SetBusDatabase(bus_id, None));
            self.debug_hub.record(
                "info",
                "NETDB",
                "backend",
                Some(bus_id),
                "netdb.bus_unbound",
                format!(
                    "Cleared database binding on Bus {} (Raw Hex mode)",
                    u16::from(bus_id) + 1
                ),
                None,
            );
            return Ok(None);
        }
        if files.len() > MAX_DB_FILES_PER_CALL {
            return Err(HalError::InvalidInput(format!(
                "Too many database files ({}, limit {MAX_DB_FILES_PER_CALL})",
                files.len()
            )));
        }
        let mut total_len = 0usize;
        for f in &files {
            check_ipc_size(
                "Database content",
                f.content_base64.len(),
                MAX_IPC_CONTENT_BYTES,
            )?;
            total_len = total_len.saturating_add(f.content_base64.len());
        }
        check_ipc_size(
            "Combined database content",
            total_len,
            MAX_IPC_DB_TOTAL_BYTES,
        )?;

        let registry = FormatRegistry::new();
        let opts = ParseOptions::default();
        let mut parsed_dbs = Vec::with_capacity(files.len());
        let mut format_names = Vec::with_capacity(files.len());
        let mut encodings = Vec::with_capacity(files.len());
        let mut diagnostics = Vec::new();

        for f in &files {
            let raw_bytes = decode_base64_db_bytes(&f.content_base64)?;
            let bundle = registry.parse_bytes(&raw_bytes, Some(&f.file_name), &opts)?;
            format_names.push(bundle.format_name.to_string());
            encodings.push(bundle.source_encoding.to_string());
            diagnostics.extend(bundle.diagnostics);
            parsed_dbs.push(bundle.database);
        }

        let (target_raw, format_str, source_enc) = if parsed_dbs.len() == 1 {
            let single_db = parsed_dbs.into_iter().next().expect("len == 1");
            let fmt = format_names.into_iter().next().unwrap_or_default();
            let enc = encodings
                .into_iter()
                .next()
                .unwrap_or_else(|| "UTF-8".to_string());
            (single_db, fmt, enc)
        } else {
            let (mut merged, merge_diags) = merge_databases(parsed_dbs);
            merged.name = files
                .iter()
                .map(|f| f.file_name.as_str())
                .collect::<Vec<_>>()
                .join(" + ");
            diagnostics.extend(merge_diags);
            let mut unique_fmts = Vec::new();
            for fmt in format_names {
                if !unique_fmts.contains(&fmt) {
                    unique_fmts.push(fmt);
                }
            }
            let fmt_str = format!("Merged ({})", unique_fmts.join(" + "));
            let enc_str = encodings
                .into_iter()
                .next()
                .unwrap_or_else(|| "UTF-8".to_string());
            (merged, fmt_str, enc_str)
        };

        let message_count = target_raw.messages.len();
        let signal_count = target_raw.messages.values().map(|m| m.signals.len()).sum();
        let info = DatabaseInfoDto {
            name: target_raw.name.clone(),
            version: target_raw.version.clone(),
            format: format_str,
            source_encoding: source_enc,
            message_count,
            signal_count,
            diagnostics,
        };

        let compiled = Arc::new(CompiledDatabase::compile(target_raw.clone())?);
        let schema = compiled.to_schema_dto(info);

        let bound_names = files
            .iter()
            .map(|f| f.file_name.as_str())
            .collect::<Vec<_>>()
            .join(", ");

        self.bus_db_states.write().insert(
            bus_id,
            Some(LoadedDatabaseState {
                raw_database: target_raw,
                compiled: Arc::clone(&compiled),
                schema: schema.clone(),
            }),
        );
        let _ = self
            .ctrl_tx
            .send(AggregatorControl::SetBusDatabase(bus_id, Some(compiled)));

        self.debug_hub.record(
            "success",
            "NETDB",
            "backend",
            Some(bus_id),
            "netdb.bus_bound",
            format!(
                "Bound {} database file(s) to Bus {} ({message_count} messages, {signal_count} signals)",
                files.len(),
                u16::from(bus_id) + 1
            ),
            Some(format!("files=[{bound_names}]")),
        );

        Ok(Some(schema))
    }

    /// 10. `cmd_transmit_signal_frame` -> Encodes engineering signals (with range clamping & auto-mux),
    ///     transmits immediately on `bus_id`, and optionally schedules a periodic TX job.
    pub fn cmd_transmit_signal_frame(
        &self,
        bus_id: u8,
        arb_id: u32,
        is_extended: bool,
        signal_values: Vec<(u32, f64)>,
        periodic_ms: Option<u32>,
        job_label: Option<String>,
    ) -> Result<TxTransmitResultDto, HalError> {
        check_tx_request_sizes(Some(signal_values.len()), job_label.as_deref())?;
        // Epoch first, then the latch: see `register_periodic_job_checked`.
        let epoch = self.tx_epoch.load(Ordering::Acquire);
        if self.tx_panic_latched.load(Ordering::Acquire) {
            return Err(panic_latched_error());
        }

        let compiled = {
            let bus_db_guard = self.bus_db_states.read();
            match bus_db_guard.get(&bus_id) {
                Some(Some(st)) => Arc::clone(&st.compiled),
                Some(None) => {
                    return Err(HalError::InvalidInput(format!(
                        "Bus {} has no signal database bound; bind a .dbc/.kcd in Connections first",
                        bus_id + 1
                    )));
                }
                None => {
                    drop(bus_db_guard);
                    self.db_state
                        .read()
                        .as_ref()
                        .map(|s| Arc::clone(&s.compiled))
                        .ok_or_else(|| {
                            HalError::SafetyLock(
                                "No signal database loaded; load a .dbc or .kcd database before transmitting"
                                    .to_string(),
                            )
                        })?
                }
            }
        };

        let tx_sender = {
            let guard = self.buses.lock();
            let bus = guard
                .get(&bus_id)
                .ok_or(HalError::BusNotConnected(bus_id))?;
            if bus.listen_only {
                return Err(HalError::Adapter(AdapterError::ListenOnlyMode));
            }
            if !bus.tx_armed.load(Ordering::Acquire) {
                return Err(HalError::SafetyLock(format!(
                    "Bus {bus_id} TX is disarmed; engage Arm Active Bus before transmitting"
                )));
            }
            bus.tx_sender.clone()
        };

        let can_id = CanIdKey::new_masked(arb_id, is_extended);
        let clamped_signals = find_clamped_signals(&compiled, &signal_values);
        let now_us = now_monotonic_us().max(1);
        let tx_frame = compiled
            .encode_raw_frame(bus_id, can_id, &signal_values, now_us)
            .map_err(DbError::from)?;

        let encoded_dlc = usize::from(tx_frame.dlc.min(64));
        let encoded_bytes = tx_frame.payload().to_vec();

        // Dispatch immediate TX with completion ack so driver-level errors surface synchronously
        let (ack_tx, ack_rx) = bounded(1);
        tx_sender
            .send(TxDispatchRequest {
                frame: tx_frame,
                ack: Some(ack_tx),
                suppress_echo: false,
                hw_tx_counter: None,
                origin: TxOrigin::Other,
                epoch,
            })
            .map_err(|_| HalError::BusNotConnected(bus_id))?;

        match ack_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Ok(())) => {}
            Ok(Err(adapter_err)) => return Err(HalError::Adapter(adapter_err)),
            Err(_) => {
                return Err(HalError::Adapter(AdapterError::Driver(
                    "Timed out waiting for bus I/O thread TX completion".to_string(),
                )))
            }
        }

        let job_id = match periodic_ms {
            Some(ms) if ms > 0 => {
                let default_label = compiled
                    .get_message(&can_id)
                    .map(|m| m.name.clone())
                    .unwrap_or_else(|| can_id.schema_key());
                let label = job_label
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or(default_label);
                Some(
                    self.register_periodic_job_checked(bus_id, label, can_id, ms, tx_frame, epoch)?,
                )
            }
            _ => None,
        };

        if !clamped_signals.is_empty() {
            self.debug_hub.record(
                "warn",
                "TX",
                "backend",
                Some(bus_id),
                "tx.signals_clamped",
                format!(
                    "Clamped {} out-of-range signal value(s) on {} (Bus {})",
                    clamped_signals.len(),
                    can_id.schema_key(),
                    u16::from(bus_id) + 1
                ),
                Some(format!("signalIds={clamped_signals:?}")),
            );
        }

        let hex_preview = format_hex_bytes_preview(&encoded_bytes);
        if let Some(jid) = job_id {
            self.debug_hub.record(
                "info",
                "TX",
                "backend",
                Some(bus_id),
                "tx.cycle.started",
                format!(
                    "Started periodic signal TX job #{jid} on {} ({} ms)",
                    can_id.schema_key(),
                    periodic_ms.unwrap_or(0)
                ),
                Some(format!(
                    "arbId=0x{arb_id:X}, dlc={encoded_dlc}, data=[{hex_preview}]"
                )),
            );
        } else {
            self.debug_hub.record(
                "info",
                "TX",
                "backend",
                Some(bus_id),
                "tx.single_shot",
                format!(
                    "Transmitted signal frame {} on Bus {}",
                    can_id.schema_key(),
                    u16::from(bus_id) + 1
                ),
                Some(format!(
                    "arbId=0x{arb_id:X}, dlc={encoded_dlc}, data=[{hex_preview}]"
                )),
            );
        }

        Ok(TxTransmitResultDto {
            job_id,
            encoded_dlc,
            encoded_bytes,
            clamped_signals,
        })
    }

    /// 11. `cmd_stop_periodic_tx` -> Stops an active periodic TX job by `job_id`.
    pub fn cmd_stop_periodic_tx(&self, job_id: u64) -> Result<(), HalError> {
        let res = self.tx_scheduler.lock().stop_job(job_id);
        if res.is_ok() {
            self.debug_hub.record(
                "info",
                "TX",
                "backend",
                None,
                "tx.cycle.stopped",
                format!("Stopped periodic TX job #{job_id}"),
                None,
            );
        }
        res
    }

    /// 12. `cmd_list_periodic_tx` -> Lists all active periodic TX jobs.
    pub fn cmd_list_periodic_tx(&self) -> Vec<PeriodicTxJobDto> {
        self.tx_scheduler.lock().list_jobs()
    }

    /// 13. `cmd_transmit_raw_frame` -> Transmits a raw Classical CAN or CAN-FD frame immediately on
    ///     `bus_id` (enforcing `Listen-Only`, `tx_armed`, and `tx_panic_latched` interlocks without
    ///     requiring a loaded database) and optionally schedules a periodic TX job.
    #[allow(clippy::too_many_arguments)]
    pub fn cmd_transmit_raw_frame(
        &self,
        bus_id: u8,
        arb_id: u32,
        is_extended: bool,
        is_fd: bool,
        is_brs: bool,
        data: Vec<u8>,
        periodic_ms: Option<u32>,
        job_label: Option<String>,
    ) -> Result<TxTransmitResultDto, HalError> {
        check_tx_request_sizes(None, job_label.as_deref())?;
        // Epoch first, then the latch: see `register_periodic_job_checked`.
        let epoch = self.tx_epoch.load(Ordering::Acquire);
        if self.tx_panic_latched.load(Ordering::Acquire) {
            return Err(panic_latched_error());
        }

        let tx_sender = {
            let guard = self.buses.lock();
            let bus = guard
                .get(&bus_id)
                .ok_or(HalError::BusNotConnected(bus_id))?;
            if bus.listen_only {
                return Err(HalError::Adapter(AdapterError::ListenOnlyMode));
            }
            if !bus.tx_armed.load(Ordering::Acquire) {
                return Err(HalError::SafetyLock(format!(
                    "Bus {bus_id} TX is disarmed; engage Arm Active Bus before transmitting"
                )));
            }
            bus.tx_sender.clone()
        };

        let can_id = if is_extended {
            CanIdKey::new_extended(arb_id).ok_or_else(|| {
                HalError::InvalidInput(format!(
                    "Extended 29-bit CAN ID 0x{arb_id:X} exceeds 0x1FFFFFFF"
                ))
            })?
        } else {
            u16::try_from(arb_id)
                .ok()
                .and_then(CanIdKey::new_standard)
                .ok_or_else(|| {
                    HalError::InvalidInput(format!(
                        "Standard 11-bit CAN ID 0x{arb_id:X} exceeds 0x7FF"
                    ))
                })?
        };

        let now_us = now_monotonic_us().max(1);
        let use_fd = is_fd || data.len() > nexus_core::MAX_CLASSICAL_CAN_DLC;
        let tx_frame = if use_fd {
            RawCanFrame::new_fd(bus_id, can_id, &data, is_brs, now_us)
                .map_err(|e| HalError::InvalidInput(e.to_string()))?
        } else {
            RawCanFrame::new_classical(bus_id, can_id, &data, now_us)
                .map_err(|e| HalError::InvalidInput(e.to_string()))?
        };

        let encoded_dlc = usize::from(tx_frame.dlc.min(64));
        let encoded_bytes = tx_frame.payload().to_vec();

        // Dispatch immediate TX with completion ack so driver-level errors surface synchronously
        let (ack_tx, ack_rx) = bounded(1);
        tx_sender
            .send(TxDispatchRequest {
                frame: tx_frame,
                ack: Some(ack_tx),
                suppress_echo: false,
                hw_tx_counter: None,
                origin: TxOrigin::Other,
                epoch,
            })
            .map_err(|_| HalError::BusNotConnected(bus_id))?;

        match ack_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Ok(())) => {}
            Ok(Err(adapter_err)) => return Err(HalError::Adapter(adapter_err)),
            Err(_) => {
                return Err(HalError::Adapter(AdapterError::Driver(
                    "Timed out waiting for bus I/O thread TX completion".to_string(),
                )))
            }
        }

        let job_id = match periodic_ms {
            Some(ms) if ms > 0 => {
                let default_label = {
                    let bus_db_guard = self.bus_db_states.read();
                    match bus_db_guard.get(&bus_id) {
                        Some(Some(st)) => st
                            .compiled
                            .get_message(&can_id)
                            .map(|m| m.name.clone())
                            .unwrap_or_else(|| can_id.schema_key()),
                        Some(None) => can_id.schema_key(),
                        None => {
                            drop(bus_db_guard);
                            self.db_state
                                .read()
                                .as_ref()
                                .and_then(|s| s.compiled.get_message(&can_id))
                                .map(|m| m.name.clone())
                                .unwrap_or_else(|| can_id.schema_key())
                        }
                    }
                };
                let label = job_label
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or(default_label);
                Some(
                    self.register_periodic_job_checked(bus_id, label, can_id, ms, tx_frame, epoch)?,
                )
            }
            _ => None,
        };

        let hex_preview = format_hex_bytes_preview(&encoded_bytes);
        if let Some(jid) = job_id {
            self.debug_hub.record(
                "info",
                "TX",
                "backend",
                Some(bus_id),
                "tx.cycle.started",
                format!(
                    "Started periodic raw TX job #{jid} on {} ({} ms)",
                    can_id.schema_key(),
                    periodic_ms.unwrap_or(0)
                ),
                Some(format!(
                    "arbId=0x{arb_id:X}, fd={use_fd}, brs={is_brs}, dlc={encoded_dlc}, data=[{hex_preview}]"
                )),
            );
        } else {
            self.debug_hub.record(
                "info",
                "TX",
                "backend",
                Some(bus_id),
                "tx.single_shot",
                format!(
                    "Transmitted raw frame {} on Bus {}",
                    can_id.schema_key(),
                    u16::from(bus_id) + 1
                ),
                Some(format!(
                    "arbId=0x{arb_id:X}, fd={use_fd}, brs={is_brs}, dlc={encoded_dlc}, data=[{hex_preview}]"
                )),
            );
        }

        Ok(TxTransmitResultDto {
            job_id,
            encoded_dlc,
            encoded_bytes,
            clamped_signals: Vec::new(),
        })
    }

    /// 14. `cmd_probe_drivers` -> Probes OS kernel modules, vendor SDK libraries (`PCAN`, `Kvaser`, `gs_usb`, `SocketCAN`),
    ///     and attached COM / `/dev/ttyUSB*` / `/dev/ttyACM*` serial ports for SLCAN.
    pub fn cmd_probe_drivers(&self) -> DriverProbeReportDto {
        self.reap_dead_buses();
        probe_all_drivers()
    }

    /// 15. `cmd_clear_database` -> Clears any loaded `.dbc`/`.kcd` schema and resets live signal decoding in `StateTable`.
    pub fn cmd_clear_database(&self) -> Result<(), HalError> {
        *self.db_state.write() = None;
        self.bus_db_states.write().clear();
        let _ = self.ctrl_tx.send(AggregatorControl::SetDatabase(None));
        let _ = self.ctrl_tx.send(AggregatorControl::ClearAllBusDatabases);
        self.debug_hub.record(
            "info",
            "NETDB",
            "backend",
            None,
            "netdb.cleared",
            "Cleared all loaded signal databases",
            None,
        );
        Ok(())
    }

    /// 16. `cmd_disconnect_all_buses` -> Cancels all periodic TX jobs, shuts down every connected bus,
    ///     clears per-bus state in `StateTable`, and returns the number of disconnected buses.
    pub fn cmd_disconnect_all_buses(&self) -> usize {
        self.tx_scheduler.lock().clear_all();
        let removed = std::mem::take(&mut *self.buses.lock());
        let count = removed.len();
        for (bus_id, mut handle) in removed {
            handle.shutdown();
            let _ = self.ctrl_tx.send(AggregatorControl::ClearBus(bus_id));
        }
        if count > 0 {
            self.debug_hub.record(
                "info",
                "CONN",
                "backend",
                None,
                "bus.disconnected_all",
                format!("Disconnected {count} active CAN channel(s)"),
                None,
            );
        }
        count
    }

    /// WP-8: persistent storage locations of this engine.
    pub fn data_root(&self) -> &DataRoot {
        &self.data_root
    }

    /// 17. `cmd_list_projects` -> Scans `<projects>/*.nexusproj.json` (creating the directory if
    ///     missing), extracts summary metadata, and returns entries sorted descending by
    ///     `updated_at`. Symlinks, non-regular entries and invalid stems are skipped; files larger
    ///     than [`MAX_PROJECT_FILE_BYTES`] are listed from metadata only.
    pub fn cmd_list_projects(&self) -> Result<Vec<ProjectSummaryDto>, HalError> {
        let projects_dir = self.data_root.projects_dir();
        crate::storage::create_private_dir_all(projects_dir)
            .map_err(|e| HalError::Adapter(AdapterError::Io(e)))?;

        let entries =
            fs::read_dir(projects_dir).map_err(|e| HalError::Adapter(AdapterError::Io(e)))?;

        let mut summaries = Vec::new();
        for entry in entries.flatten().take(MAX_LISTED_ENTRIES) {
            // `DirEntry::file_type` does not follow symlinks.
            match entry.file_type() {
                Ok(ft) if ft.is_file() => {}
                _ => continue,
            }
            let file_name = entry.file_name().to_string_lossy().to_string();
            let Some(raw_stem) = file_name.strip_suffix(".nexusproj.json") else {
                continue;
            };
            let Ok(safe_stem) = sanitize_project_stem(raw_stem) else {
                continue;
            };
            // Only list files whose on-disk name is exactly the sanitized name, so every listed
            // stem can be loaded/deleted again.
            if safe_stem != raw_stem {
                continue;
            }
            let path = entry.path();
            let meta = match fs::symlink_metadata(&path) {
                Ok(m) if m.is_file() => m,
                _ => continue,
            };
            let size_bytes = meta.len();
            let fallback_updated = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| format!("{}", d.as_secs()))
                .unwrap_or_else(|| "0".to_string());

            let parsed = if size_bytes <= MAX_PROJECT_FILE_BYTES {
                crate::storage::read_regular_file(&path, MAX_PROJECT_FILE_BYTES)
                    .ok()
                    .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
            } else {
                None
            };
            let (name, updated_at) = match parsed {
                Some(val) => {
                    let parsed_name = val
                        .get("name")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(&safe_stem)
                        .to_string();
                    let parsed_updated = val
                        .get("updatedAt")
                        .or_else(|| val.get("updated_at"))
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(ToString::to_string)
                        .unwrap_or(fallback_updated);
                    (parsed_name, parsed_updated)
                }
                None => (safe_stem.clone(), fallback_updated),
            };

            summaries.push(ProjectSummaryDto {
                file_stem: safe_stem,
                name,
                updated_at,
                size_bytes,
            });
        }

        summaries.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.file_stem.cmp(&b.file_stem))
        });
        Ok(summaries)
    }

    /// Resolves `<projects>/<safe_stem>.nexusproj.json` (invalid stems and symlinks refused).
    /// `strict` (load / delete): the stem must already be canonical, nothing is rewritten.
    fn project_path(&self, file_stem: &str, strict: bool) -> Result<(String, PathBuf), HalError> {
        let safe_stem = sanitize_project_stem(file_stem)?;
        if strict {
            let given = file_stem.trim();
            let given = given.strip_suffix(".nexusproj.json").unwrap_or(given);
            if given != safe_stem {
                return Err(HalError::InvalidInput(format!(
                    "Invalid project name '{}': expected '{safe_stem}'",
                    given.escape_debug()
                )));
            }
        }
        let path = crate::storage::resolve_in_dir(
            self.data_root.projects_dir(),
            &format!("{safe_stem}.nexusproj.json"),
        )?;
        Ok((safe_stem, path))
    }

    /// 18. `cmd_save_project` -> Validates `file_stem` (invalid names are errors), validates
    ///     `project_json` as a JSON object (max [`MAX_IPC_CONTENT_BYTES`]), writes
    ///     `<projects>/<safe_stem>.nexusproj.json` atomically, and returns its [`ProjectSummaryDto`].
    pub fn cmd_save_project(
        &self,
        file_stem: String,
        project_json: String,
    ) -> Result<ProjectSummaryDto, HalError> {
        check_ipc_size("Project JSON", project_json.len(), MAX_IPC_CONTENT_BYTES)?;
        let (safe_stem, target_path) = self.project_path(&file_stem, false)?;
        let parsed: serde_json::Value = serde_json::from_str(&project_json)
            .map_err(|e| HalError::InvalidInput(format!("Invalid project JSON payload: {e}")))?;
        let obj = parsed.as_object().ok_or_else(|| {
            HalError::InvalidInput("Project JSON root must be a JSON object".to_string())
        })?;

        let name = obj
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&safe_stem)
            .to_string();

        let updated_at = obj
            .get("updatedAt")
            .or_else(|| obj.get("updated_at"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| {
                let secs = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                format!("{secs}")
            });

        crate::storage::write_regular_file_atomic(&target_path, project_json.as_bytes())?;

        let summary = ProjectSummaryDto {
            file_stem: safe_stem.clone(),
            name: name.clone(),
            updated_at,
            size_bytes: project_json.len() as u64,
        };
        self.debug_hub.record(
            "success",
            "WORKBENCH",
            "backend",
            None,
            "workbench.project_saved",
            format!("Saved project '{name}' ({safe_stem}.nexusproj.json)"),
            Some(format!("sizeBytes={}", summary.size_bytes)),
        );
        Ok(summary)
    }

    /// 19. `cmd_load_project` -> Reads `<projects>/<safe_stem>.nexusproj.json` (regular file,
    ///     max [`MAX_PROJECT_FILE_BYTES`]) and returns the raw JSON string.
    pub fn cmd_load_project(&self, file_stem: String) -> Result<String, HalError> {
        let (safe_stem, target_path) = self.project_path(&file_stem, true)?;
        if !crate::storage::is_regular_file(&target_path) {
            return Err(HalError::InvalidInput(format!(
                "Project '{safe_stem}' does not exist in projects directory"
            )));
        }
        let raw = crate::storage::read_regular_file(&target_path, MAX_PROJECT_FILE_BYTES)?;
        let json = String::from_utf8(raw).map_err(|_| {
            HalError::InvalidInput(format!("Project '{safe_stem}' is not valid UTF-8"))
        })?;
        self.debug_hub.record(
            "info",
            "WORKBENCH",
            "backend",
            None,
            "workbench.project_loaded",
            format!("Loaded project '{safe_stem}.nexusproj.json'"),
            Some(format!("sizeBytes={}", json.len())),
        );
        Ok(json)
    }

    /// 20. `cmd_delete_project` -> Deletes `<projects>/<safe_stem>.nexusproj.json` (symlinks refused).
    pub fn cmd_delete_project(&self, file_stem: String) -> Result<(), HalError> {
        let (safe_stem, target_path) = self.project_path(&file_stem, true)?;
        if !crate::storage::is_regular_file(&target_path) {
            return Err(HalError::InvalidInput(format!(
                "Project '{safe_stem}' does not exist in projects directory"
            )));
        }
        crate::storage::remove_regular_file(&target_path)?;
        self.debug_hub.record(
            "info",
            "WORKBENCH",
            "backend",
            None,
            "workbench.project_deleted",
            format!("Deleted project '{safe_stem}.nexusproj.json'"),
            None,
        );
        Ok(())
    }

    /// 21. `cmd_reset_telemetry` -> Resets `StateTable` (`Receive` rows, `Trace` ring, and RX/TX counters)
    ///     without disconnecting buses, cancelling periodic TX jobs, or clearing the loaded database.
    pub fn cmd_reset_telemetry(&self) -> Result<(), HalError> {
        self.ctrl_tx
            .send(AggregatorControl::ResetAll)
            .map_err(|_| HalError::InvalidInput("Aggregator thread stopped".to_string()))?;
        self.debug_hub.record(
            "info",
            "WORKBENCH",
            "backend",
            None,
            "workbench.telemetry_reset",
            "Reset telemetry counters, Receive rows, and Trace ring",
            None,
        );
        Ok(())
    }

    /// 22. `cmd_list_traces` -> Lists persistent `.trc`, `.asc`, `.blf`, `.log`, and `.csv` files in `./traces/`.
    ///     WP-8: metadata only; `frameCount` / `durationUs` are exact only when `statsKnown`.
    pub fn cmd_list_traces(&self) -> Result<TraceStorageInfoDto, HalError> {
        list_trace_files(self.data_root.traces_dir(), Some(&self.trace_stats))
    }

    /// 23. `cmd_save_trace_file` -> Sanitizes `file_name` and persists either binary `content_base64` (e.g. `.blf`)
    ///     or UTF-8 `content` inside `./traces/`.
    pub fn cmd_save_trace_file(
        &self,
        file_name: String,
        content: Option<String>,
        content_base64: Option<String>,
    ) -> Result<TraceFileSummaryDto, HalError> {
        check_trace_content_sizes(content.as_deref(), content_base64.as_deref())?;
        let traces_dir = self.data_root.traces_dir();
        let res = if let Some(b64) = content_base64.as_deref().filter(|s| !s.trim().is_empty()) {
            let raw_bytes = decode_base64_trace_bytes(b64)?;
            save_trace_file_bytes_cached(
                traces_dir,
                &file_name,
                &raw_bytes,
                Some(&self.trace_stats),
            )
        } else if let Some(text) = content {
            save_trace_file_bytes_cached(
                traces_dir,
                &file_name,
                text.as_bytes(),
                Some(&self.trace_stats),
            )
        } else {
            Err(HalError::InvalidInput(
                "Trace kaydında oynatılacak çerçeve bulunamadı".to_string(),
            ))
        };
        if let Ok(summary) = &res {
            self.debug_hub.record(
                "success",
                "TRACE",
                "backend",
                None,
                "trace.saved",
                format!(
                    "Saved trace '{}' ({} frames)",
                    summary.file_name, summary.frame_count
                ),
                Some(format!(
                    "format={}, sizeBytes={}, durationUs={}",
                    summary.format, summary.size_bytes, summary.duration_us
                )),
            );
        }
        res
    }

    /// 24. `cmd_load_trace_file` -> Loads and parses `./traces/<safe_name>` into `LoadedTraceFileDto`.
    pub fn cmd_load_trace_file(&self, file_name: String) -> Result<LoadedTraceFileDto, HalError> {
        let res = load_trace_file_cached(
            self.data_root.traces_dir(),
            &file_name,
            Some(&self.trace_stats),
        );
        if let Ok(loaded) = &res {
            self.debug_hub.record(
                "info",
                "TRACE",
                "backend",
                None,
                "trace.loaded",
                format!(
                    "Loaded trace '{}' ({} frames)",
                    loaded.summary.file_name, loaded.summary.frame_count
                ),
                Some(format!(
                    "format={}, durationUs={}",
                    loaded.summary.format, loaded.summary.duration_us
                )),
            );
        }
        res
    }

    /// 25. `cmd_delete_trace_file` -> Deletes `./traces/<safe_name>`.
    pub fn cmd_delete_trace_file(&self, file_name: String) -> Result<(), HalError> {
        let res = delete_trace_file(self.data_root.traces_dir(), &file_name);
        if res.is_ok() {
            if let Ok(safe) = sanitize_trace_filename(&file_name) {
                self.trace_stats.forget(&safe);
                self.debug_hub.record(
                    "info",
                    "TRACE",
                    "backend",
                    None,
                    "trace.deleted",
                    format!("Deleted trace file '{safe}'"),
                    None,
                );
            }
        }
        res
    }

    /// 26. `cmd_parse_trace_content` -> Statelessly parses binary `content_base64` (`.blf`) or text `content`
    ///     (`.trc`, `.asc`, `.log`, `.csv`) into `LoadedTraceFileDto`.
    pub fn cmd_parse_trace_content(
        &self,
        file_name: String,
        content: Option<String>,
        content_base64: Option<String>,
    ) -> Result<LoadedTraceFileDto, HalError> {
        check_trace_content_sizes(content.as_deref(), content_base64.as_deref())?;
        if let Some(b64) = content_base64.as_deref().filter(|s| !s.trim().is_empty()) {
            let raw_bytes = decode_base64_trace_bytes(b64)?;
            parse_trace_bytes(&file_name, &raw_bytes)
        } else {
            let bytes = content.unwrap_or_default().into_bytes();
            parse_trace_bytes(&file_name, &bytes)
        }
    }

    /// 27. `cmd_start_trace_replay` -> Compiles frames from `args.frames`, `args.content_base64`,
    ///     `args.content`, or `./traces/<file_name>` and launches deterministic zero-allocation
    ///     ID-filtered Restbus playback on `nexus-trace-replay`.
    pub fn cmd_start_trace_replay(
        &self,
        args: StartTraceReplayArgsDto,
    ) -> Result<TraceReplayStatusDto, HalError> {
        check_trace_content_sizes(args.content.as_deref(), args.content_base64.as_deref())?;
        if let Some(frames) = args.frames.as_ref() {
            check_frame_count("Trace replay", frames.len())?;
        }
        let resolve_name_hint = |default_name: &'static str| -> String {
            args.file_name
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| {
                    let s = args.source_name.trim();
                    if s.is_empty() {
                        None
                    } else {
                        Some(s)
                    }
                })
                .unwrap_or(default_name)
                .to_string()
        };

        let (entries, fallback_source) =
            if let Some(frames) = args.frames.as_ref().filter(|f| !f.is_empty()) {
                (
                    compile_chronological_frames(frames),
                    "In-Memory Trace".to_string(),
                )
            } else if let Some(b64) = args
                .content_base64
                .as_ref()
                .filter(|c| !c.trim().is_empty())
            {
                let name_hint = resolve_name_hint("inline_trace.blf");
                let raw_bytes = decode_base64_trace_bytes(b64)?;
                (
                    parse_trace_entries_from_bytes(&name_hint, &raw_bytes)?,
                    name_hint,
                )
            } else if let Some(content) = args.content.as_ref().filter(|c| !c.trim().is_empty()) {
                let name_hint = resolve_name_hint("inline_trace.trc");
                (
                    parse_trace_entries_from_bytes(&name_hint, content.as_bytes())?,
                    name_hint,
                )
            } else if let Some(fname) = args.file_name.as_ref().filter(|s| !s.trim().is_empty()) {
                let (safe_name, _path, raw_bytes) =
                    read_trace_file_bytes(self.data_root.traces_dir(), fname)?;
                (
                    parse_trace_entries_from_bytes(&safe_name, &raw_bytes)?,
                    safe_name,
                )
            } else {
                (Vec::new(), String::new())
            };

        if entries.is_empty() {
            return Err(HalError::InvalidInput(
                "Trace kaydında oynatılacak çerçeve bulunamadı".to_string(),
            ));
        }

        if args.reset_telemetry_first {
            self.replay.stop_sync();
            self.cmd_reset_telemetry()?;
            let _ = self.flush_snapshot_now();
        }

        let source_name = if args.source_name.trim().is_empty() {
            fallback_source
        } else {
            args.source_name.trim().to_string()
        };

        let entry_count = entries.len();
        let res = self.replay.start_compiled(source_name, entries, &args);
        if let Ok(st) = &res {
            self.debug_hub.record(
                if st.transmit_to_hardware {
                    "safety"
                } else {
                    "info"
                },
                "TRACE",
                "backend",
                st.bus_override,
                "trace.replay_started",
                format!(
                    "Started trace replay '{}' ({entry_count} frames @ {:.2}x)",
                    st.source_name, st.speed_factor
                ),
                Some(format!(
                    "loop={}, transmitToHardware={}, filterMode={}",
                    st.loop_playback, st.transmit_to_hardware, st.filter_mode
                )),
            );
        }
        res
    }

    /// 28. `cmd_control_trace_replay` -> Controls active playback (`pause`, `resume`, `stop`, `seek`, `configure`).
    pub fn cmd_control_trace_replay(
        &self,
        args: TraceReplayControlArgsDto,
    ) -> Result<TraceReplayStatusDto, HalError> {
        let action = args.action.clone();
        let res = self.replay.control(args);
        if let Ok(st) = &res {
            let act_key = format!("trace.replay_{action}");
            self.debug_hub.record(
                "info",
                "TRACE",
                "backend",
                st.bus_override,
                &act_key,
                format!("Trace replay action '{action}' -> state '{}'", st.state),
                Some(format!(
                    "source={}, index={}/{}, speed={:.2}x, hwTx={}",
                    st.source_name,
                    st.current_index,
                    st.total_frames,
                    st.speed_factor,
                    st.transmit_to_hardware
                )),
            );
        }
        res
    }

    /// 29. `cmd_export_trace_blf` -> Encodes `ChronologicalFrameDto` records into a zlib-compressed
    ///     standard Vector `.blf` binary file and returns Base64-encoded bytes.
    pub fn cmd_export_trace_blf(
        &self,
        file_name: String,
        frames: Vec<ChronologicalFrameDto>,
    ) -> Result<String, HalError> {
        check_frame_count("BLF export", frames.len())?;
        if frames.is_empty() {
            return Err(HalError::InvalidInput(
                "Trace kaydında oynatılacak çerçeve bulunamadı".to_string(),
            ));
        }
        let entries = compile_chronological_frames(&frames);
        if entries.is_empty() {
            return Err(HalError::InvalidInput(
                "Trace kaydında oynatılacak çerçeve bulunamadı".to_string(),
            ));
        }
        let frame_count = entries.len();
        let blf_bytes = blf::encode_blf_bytes(&entries)?;
        let encoded = BASE64_STD.encode(&blf_bytes);
        self.debug_hub.record(
            "success",
            "TRACE",
            "backend",
            None,
            "trace.exported_blf",
            format!("Exported Vector BLF '{file_name}' ({frame_count} frames)"),
            Some(format!("compressedBytes={}", blf_bytes.len())),
        );
        Ok(encoded)
    }
}

// ─── RE Toolkit R1 (re-toolkit-v1 §2.1) ─────────────────────────────────────

/// 10 Hz RE binary snapshot period.
pub const RE_SNAPSHOT_INTERVAL: Duration = Duration::from_millis(100);

enum ReSubCtl {
    /// Next tick is a full resync (after `cmd_re_reset`).
    ForceFull,
    /// Ends the subscription, optionally after one final snapshot.
    Stop { final_snapshot: bool },
}

/// Handle of the RE snapshot thread (`nexus-re-snapshot-10hz`).
struct ReSubscription {
    ctl: Sender<ReSubCtl>,
    join: JoinHandle<()>,
}

/// Snapshot sink: receives each encoded snapshot; returns `false` when the subscriber is gone.
pub type ReSnapshotSink = Box<dyn FnMut(&[u8]) -> bool + Send + 'static>;

fn run_re_snapshot_loop(
    re: Arc<ReShared>,
    ctl: Receiver<ReSubCtl>,
    mut sink: ReSnapshotSink,
    resync: Arc<AtomicBool>,
) {
    // Reserved once for the worst case (2048 rows x 64-byte payloads): never grows.
    let mut buf: Vec<u8> = Vec::with_capacity(RE_SNAPSHOT_MAX_BYTES);
    let mut full = true; // first tick after subscribe = full resync
    let mut next = Instant::now();
    loop {
        let wait = next.saturating_duration_since(Instant::now());
        let mut final_tick = false;
        match ctl.recv_timeout(wait) {
            Ok(ReSubCtl::ForceFull) => {
                full = true;
                continue;
            }
            Ok(ReSubCtl::Stop { final_snapshot }) => {
                if !final_snapshot {
                    return;
                }
                final_tick = true;
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => return,
        }
        // A subscriber that dropped a snapshot (bounded queue full) asks for a full resync so
        // no dirty row is lost (re-toolkit-v1 amendment 14).
        full |= resync.swap(false, Ordering::AcqRel);
        re.lock().encode_snapshot(&mut buf, full);
        full = false;
        if !sink(&buf) || final_tick {
            return;
        }
        next += RE_SNAPSHOT_INTERVAL;
        let now = Instant::now();
        if next <= now {
            next = now + RE_SNAPSHOT_INTERVAL;
        }
    }
}

impl PipelineEngine {
    /// Shared RE state (tests / embedding).
    pub fn re_shared(&self) -> &Arc<ReShared> {
        &self.re
    }

    fn re_stop_subscription(&self, final_snapshot: bool) {
        let sub = self.re_sub.lock().take();
        if let Some(sub) = sub {
            let _ = sub.ctl.send(ReSubCtl::Stop { final_snapshot });
            let _ = sub.join.join();
        }
    }

    /// `cmd_re_start`: enables RE ingest on `buses` (`None` = all buses).
    pub fn cmd_re_start(&self, buses: Option<Vec<u8>>) -> ReStatusDto {
        let mut a = self.re.lock();
        a.start(buses.as_deref());
        self.re.sync_enabled(&a);
        a.status()
    }

    /// `cmd_re_stop`: pauses ingest (state kept); the subscription gets one final snapshot
    /// and then ends.
    pub fn cmd_re_stop(&self) -> ReStatusDto {
        let status = {
            let mut a = self.re.lock();
            a.stop();
            self.re.sync_enabled(&a);
            a.status()
        };
        self.re_stop_subscription(true);
        status
    }

    /// `cmd_re_reset`: clears all rows and markers; the next snapshot is a full resync.
    pub fn cmd_re_reset(&self) -> ReStatusDto {
        let status = {
            let mut a = self.re.lock();
            a.reset();
            a.status()
        };
        if let Some(sub) = self.re_sub.lock().as_ref() {
            let _ = sub.ctl.send(ReSubCtl::ForceFull);
        }
        status
    }

    /// `cmd_re_set_phase`: `free | baseline | action` (`idle` is rejected).
    pub fn cmd_re_set_phase(&self, phase: RePhase) -> Result<ReStatusDto, HalError> {
        if phase == RePhase::Idle {
            return Err(HalError::InvalidInput(
                "RE phase must be 'free', 'baseline' or 'action'".to_string(),
            ));
        }
        let mut a = self.re.lock();
        a.set_phase(phase);
        Ok(a.status())
    }

    /// `cmd_re_mark`: adds an event marker (label truncated to 64 chars, never fails).
    pub fn cmd_re_mark(&self, label: &str) -> ReMarkerDto {
        self.re.lock().mark(label)
    }

    /// `cmd_re_markers`: all markers, oldest first (≤ 1024).
    pub fn cmd_re_markers(&self) -> Vec<ReMarkerDto> {
        self.re.lock().markers()
    }

    /// `cmd_re_status`-style accessor (not an IPC command).
    pub fn re_status(&self) -> ReStatusDto {
        self.re.lock().status()
    }

    /// `cmd_re_subscribe`: starts the 10 Hz binary snapshot thread feeding `sink` (replaces
    /// any previous subscription). The first snapshot is a full resync.
    pub fn cmd_re_subscribe(&self, sink: ReSnapshotSink) -> Result<(), HalError> {
        self.cmd_re_subscribe_with_resync(sink, Arc::new(AtomicBool::new(false)))
    }

    /// Like [`Self::cmd_re_subscribe`], plus a lock-free resync request flag: setting `resync`
    /// (e.g. from the sink after it had to drop a snapshot) makes the next snapshot a full
    /// resync. Used by the browser bridge's bounded `/ws/re` queue.
    pub fn cmd_re_subscribe_with_resync(
        &self,
        sink: ReSnapshotSink,
        resync: Arc<AtomicBool>,
    ) -> Result<(), HalError> {
        self.re_stop_subscription(false);
        let (ctl_tx, ctl_rx) = bounded::<ReSubCtl>(8);
        let re = Arc::clone(&self.re);
        let join = thread::Builder::new()
            .name("nexus-re-snapshot-10hz".to_string())
            .spawn(move || run_re_snapshot_loop(re, ctl_rx, sink, resync))
            .map_err(|e| {
                HalError::InvalidInput(format!("failed to spawn RE snapshot thread: {e}"))
            })?;
        *self.re_sub.lock() = Some(ReSubscription { ctl: ctl_tx, join });
        Ok(())
    }

    /// `cmd_re_row_detail`.
    pub fn cmd_re_row_detail(
        &self,
        bus: u8,
        arb_id: u32,
        is_extended: bool,
    ) -> Result<ReRowDetailDto, HalError> {
        self.re
            .lock()
            .row_detail(bus, arb_id, is_extended)
            .ok_or_else(|| re_row_not_found(bus, arb_id, is_extended))
    }

    /// `cmd_re_classify`: copies the row history under the lock, classifies outside it.
    pub fn cmd_re_classify(
        &self,
        bus: u8,
        arb_id: u32,
        is_extended: bool,
    ) -> Result<ReClassificationDto, HalError> {
        let hist = self
            .re
            .lock()
            .row_history(bus, arb_id, is_extended)
            .ok_or_else(|| re_row_not_found(bus, arb_id, is_extended))?;
        Ok(hist.classify())
    }

    // ─── RE Toolkit R2a — Signal Inspector (re-toolkit-v1 §6) ───────────────────────────

    /// `cmd_re_focus_set`: replaces the focus set (≤ 8 targets; kept targets keep their ring).
    pub fn cmd_re_focus_set(
        &self,
        targets: Vec<ReTargetDto>,
    ) -> Result<ReFocusStatusDto, HalError> {
        self.re.lock().focus_set(&targets).map_err(re_err)
    }

    /// `cmd_re_focus_status`.
    pub fn cmd_re_focus_status(&self) -> ReFocusStatusDto {
        self.re.lock().focus_status()
    }

    /// `cmd_re_series`: §6.3 binary series. Runs under the analyzer lock (bounded: ≤ 5 series
    /// x 16384 samples, sub-millisecond in release); the buffer is handed to IPC as is.
    pub fn cmd_re_series(&self, req: ReSeriesRequest) -> Result<Vec<u8>, HalError> {
        let mut out = Vec::new();
        self.re.lock().series(&req, &mut out).map_err(re_err)?;
        Ok(out)
    }

    /// `cmd_re_correlate`: the ring windows are copied out under the lock, the sweep runs on
    /// the calling worker thread (Tauri `spawn_blocking`, never the aggregator) without the
    /// lock, bounded to 2 s; a newer call cancels an older running sweep.
    pub fn cmd_re_correlate(
        &self,
        req: ReCorrelateRequest,
    ) -> Result<ReCorrelationResultDto, HalError> {
        self.re.correlate(&req).map_err(re_err)
    }

    /// Read-only observer correlation (MCP): never cancels a correlation the user started.
    pub fn cmd_re_correlate_observer(
        &self,
        req: ReCorrelateRequest,
    ) -> Result<ReCorrelationResultDto, HalError> {
        self.re.correlate_observer(&req).map_err(re_err)
    }

    // ─── RE Toolkit R2c — Value Scan (re-toolkit-v1 §8) ─────────────────────────────────
    // Call from a blocking worker (Tauri `spawn_blocking` / bridge blocking pool), never the
    // aggregator: first / next / results run synchronously (≤ 2 s budget) and hold the analyzer
    // lock only for the row copy.

    /// `cmd_re_scan_first`.
    pub fn cmd_re_scan_first(&self, spec: ReScanFirstSpec) -> Result<ReScanStatusDto, HalError> {
        self.re.scan_first(&spec).map_err(re_err)
    }

    /// `cmd_re_scan_next`.
    pub fn cmd_re_scan_next(&self, op: ReScanNextOp) -> Result<ReScanStatusDto, HalError> {
        self.re.scan_next(&op).map_err(re_err)
    }

    /// `cmd_re_scan_undo`.
    pub fn cmd_re_scan_undo(&self) -> Result<ReScanStatusDto, HalError> {
        self.re.scan_undo().map_err(re_err)
    }

    /// `cmd_re_scan_reset` (never fails).
    pub fn cmd_re_scan_reset(&self) -> ReScanStatusDto {
        self.re.scan_reset()
    }

    /// `cmd_re_scan_status` (never fails).
    pub fn cmd_re_scan_status(&self) -> ReScanStatusDto {
        self.re.scan_status()
    }

    /// `cmd_re_scan_results` (`limit` 1..=500).
    pub fn cmd_re_scan_results(
        &self,
        offset: u32,
        limit: u32,
        sort: ReScanSort,
    ) -> Result<ReScanResultsDto, HalError> {
        self.re.scan_results(offset, limit, sort).map_err(re_err)
    }
}

/// R2a errors keep their `"[re:<code>] message"` text across IPC.
fn re_err(e: ReError) -> HalError {
    HalError::InvalidInput(e.to_string())
}

fn re_row_not_found(bus: u8, arb_id: u32, is_extended: bool) -> HalError {
    HalError::InvalidInput(format!(
        "RE row not found: bus {bus}, id 0x{arb_id:X}{}",
        if is_extended { " (extended)" } else { "" }
    ))
}

impl Drop for PipelineEngine {
    fn drop(&mut self) {
        // Stop UDS sessions (keepalive threads) and passive scans before their buses go away.
        self.diag_sessions.clear();
        self.diag_passive.stop_all();
        self.re_stop_subscription(false);
        self.engine_stop.store(true, Ordering::Release);
        self.hw_watch_shutdown.signal();
        let _ = self.hw_stop_tx.try_send(());
        self.replay.shutdown();
        {
            let mut buses = self.buses.lock();
            for bus in buses.values_mut() {
                bus.shutdown();
            }
            buses.clear();
        }
        if let Some(handle) = self.hw_hotplug_join.lock().take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.hw_topology_join.lock().take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.scheduler_join.lock().take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.aggregator_join.lock().take() {
            let _ = handle.join();
        }
    }
}

/// Prefix of every error caused by the Panic Stop latch (parsed by the HMI).
pub const PANIC_LATCHED_PREFIX: &str = "PANIC_LATCHED:";

/// Prefix of the disarm error returned when an in-flight driver write outlived
/// [`TX_QUIESCE_TIMEOUT`] (the bus IS disarmed; parsed by the HMI).
pub const TX_IN_FLIGHT_TIMEOUT_PREFIX: &str = "TX_IN_FLIGHT_TIMEOUT:";

/// Upper bound Panic Stop / disarm / reset session wait for a driver write that passed the
/// bus-io gate before them. Built-in drivers stay far below it: SocketCAN sockets are
/// non-blocking (`EAGAIN`/`ENOBUFS` returns immediately), mock is a `try_send`, and SLCAN
/// `write_all` is bounded by the serial port timeout (1..=10 ms per partial write).
pub const TX_QUIESCE_TIMEOUT: Duration = Duration::from_millis(250);

/// RAII half of the bus-io write barrier: `fetch_add` on creation (BEFORE the gate loads),
/// `fetch_sub` on drop (AFTER `send_frame` returned, also on unwind out of a driver).
struct TxInFlightGuard<'a>(&'a AtomicU32);

impl<'a> TxInFlightGuard<'a> {
    #[inline]
    fn enter(counter: &'a AtomicU32) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter)
    }
}

impl Drop for TxInFlightGuard<'_> {
    #[inline]
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Waits until every counter is 0 or `timeout` elapses; returns the buses still in flight.
/// Must be called AFTER the caller made the buses unable to pass the gate (SeqCst stores).
/// Never allocates when nothing is in flight (the normal case returns at the first check).
fn wait_tx_quiesced(counters: &[(BusId, Arc<AtomicU32>)], timeout: Duration) -> Vec<u8> {
    let busy = |c: &Arc<AtomicU32>| c.load(Ordering::SeqCst) != 0;
    if !counters.iter().any(|(_, c)| busy(c)) {
        return Vec::new();
    }
    let deadline = Instant::now() + timeout;
    let mut round = 0u32;
    loop {
        if !counters.iter().any(|(_, c)| busy(c)) {
            return Vec::new();
        }
        if Instant::now() >= deadline {
            return counters
                .iter()
                .filter(|(_, c)| busy(c))
                .map(|(id, _)| *id)
                .collect();
        }
        // A preempted writer needs CPU time, not our spinning: spin briefly, then yield, then
        // sleep in short steps (the bound above stays exact to ~50 us).
        if round < 64 {
            std::hint::spin_loop();
        } else if round < 256 {
            thread::yield_now();
        } else {
            thread::sleep(Duration::from_micros(50));
        }
        round = round.saturating_add(1);
    }
}

#[cold]
fn report_quiesce_timeout(op: &str, buses: &[u8]) {
    eprintln!(
        "nexus-hal: ERROR {op}: driver write still in flight after {} ms on bus(es) {buses:?}; \
         TX is latched/disarmed, but that one frame may still reach the wire",
        TX_QUIESCE_TIMEOUT.as_millis()
    );
}

/// Bus-io side edge detector for Panic Stop -> [`CanChannel::abort_pending_tx`].
///
/// Fires when the latch is set and either it was clear on the previous poll (rising edge) or
/// the epoch moved while it stayed set (a second Panic Stop without Clear). The latch is loaded
/// BEFORE the epoch: `cmd_panic_stop_tx` bumps the epoch before storing the latch (SeqCst), so a
/// latch observed as set implies the epoch load already sees that panic's value; one Panic Stop
/// therefore fires exactly once. (A `cmd_reset_session` while still latched also moves the epoch
/// and fires once more right before the bus is disconnected; harmless.)
pub(crate) struct PanicAbortWatch {
    latched: bool,
    epoch: u64,
}

impl PanicAbortWatch {
    /// Starts from the current state, so a bus opened while latched does not fire.
    pub(crate) fn new(latch: &AtomicBool, epoch: &AtomicU64) -> Self {
        let latched = latch.load(Ordering::SeqCst);
        Self {
            latched,
            epoch: epoch.load(Ordering::SeqCst),
        }
    }

    /// `true` when `abort_pending_tx` must be called now.
    #[inline]
    pub(crate) fn poll(&mut self, latch: &AtomicBool, epoch: &AtomicU64) -> bool {
        let latched = latch.load(Ordering::SeqCst);
        let e = epoch.load(Ordering::SeqCst);
        let fire = latched && (!self.latched || e != self.epoch);
        self.latched = latched;
        self.epoch = e;
        fire
    }
}

#[cold]
fn report_abort_pending_tx_error(debug_hub: &DebugEventHub, bus_id: BusId, err: &AdapterError) {
    eprintln!(
        "nexus-hal: WARN panic stop: bus {bus_id}: adapter-side TX abort failed: {err} \
         (software TX gate is latched regardless)"
    );
    debug_hub.record(
        "error",
        "SAFETY",
        "backend",
        Some(bus_id),
        "panic_stop.adapter_abort_failed",
        format!(
            "Panic Stop: adapter-side TX abort failed on Bus {}",
            u16::from(bus_id) + 1
        ),
        Some(format!("{err} (software TX gate is latched regardless)")),
    );
}

/// Minimum spacing of the bus-io thread's cold-path counter reports to the debug console.
const BUS_IO_REPORT_INTERVAL: Duration = Duration::from_secs(1);

/// Cold path: driver-side RX drops and pending-echo evictions since the last report
/// (rate-limited to [`BUS_IO_REPORT_INTERVAL`] by the caller).
#[cold]
fn report_bus_io_counters(
    debug_hub: &DebugEventHub,
    bus_id: BusId,
    driver_dropped: u64,
    echo_evicted: u64,
) {
    if driver_dropped > 0 {
        debug_hub.record(
            "warning",
            "TRACE",
            "backend",
            Some(bus_id),
            "bus.driver_rx_overflow",
            format!(
                "Adapter RX overflow on Bus {}: frames dropped",
                u16::from(bus_id) + 1
            ),
            Some(format!(
                "{driver_dropped} frame(s) dropped by the driver RX ring"
            )),
        );
    }
    if echo_evicted > 0 {
        debug_hub.record(
            "warning",
            "TX",
            "backend",
            Some(bus_id),
            "bus.echo_suppress_overflow",
            format!(
                "Bus {}: too many unacknowledged suppressed TX echoes",
                u16::from(bus_id) + 1
            ),
            Some(format!(
                "{echo_evicted} pending echo(es) evicted (capacity {}); their late TX-acks may \
                 appear in the trace",
                echo_suppress::PENDING_ECHO_CAPACITY
            )),
        );
    }
}

#[cold]
fn panic_latched_error() -> HalError {
    HalError::SafetyLock(format!(
        "{PANIC_LATCHED_PREFIX} TX is panic-latched; clear the panic latch first"
    ))
}

/// Maps a gate/driver verdict to the legacy `AdapterError` acked to UI TX callers.
/// Only called when an ack channel exists (UI commands), never for diag / scheduler TX.
#[cold]
fn gate_reject_to_adapter_error(bus_id: BusId, reason: DiagTxReject) -> AdapterError {
    match reason {
        DiagTxReject::ListenOnly => AdapterError::ListenOnlyMode,
        DiagTxReject::PanicLatched => {
            AdapterError::Driver(format!("Bus {bus_id} TX blocked: Panic Stop is latched"))
        }
        DiagTxReject::Closed => AdapterError::ChannelClosed,
        _ => AdapterError::Driver(format!("Bus {bus_id} TX is disarmed")),
    }
}

#[inline]
fn adapter_error_to_reject(err: &AdapterError) -> DiagTxReject {
    match err {
        AdapterError::ListenOnlyMode => DiagTxReject::ListenOnly,
        AdapterError::ChannelClosed => DiagTxReject::Closed,
        _ => DiagTxReject::DriverError,
    }
}

/// Single owner of one `CanChannel`: TX drain (with the authoritative safety gate), RX burst
/// fan-out to the StateTable ring and to D-003 diag taps, health refresh.
///
/// Hot-path allocation policy: nothing on this thread allocates per frame. Tap queues and
/// their `Sender`s are created by the command thread and moved in via `diag_ctl_rx`; rejected
/// TX only builds an `AdapterError` string when a UI caller is waiting on an ack.
#[allow(clippy::too_many_arguments)]
fn run_bus_io_loop(
    bus_id: BusId,
    listen_only: bool,
    mut channel: Box<dyn CanChannel>,
    tx_rx: Receiver<TxDispatchRequest>,
    frame_tx: Sender<RawCanFrame>,
    dropped_frames: Arc<AtomicU64>,
    bus_stop: Arc<AtomicBool>,
    engine_stop: Arc<AtomicBool>,
    tx_armed: Arc<AtomicBool>,
    tx_panic_latched: Arc<AtomicBool>,
    tx_epoch: Arc<AtomicU64>,
    tx_in_flight: Arc<AtomicU32>,
    bus_state: Arc<AtomicU8>,
    tx_errors: Arc<AtomicU32>,
    rx_errors: Arc<AtomicU32>,
    diag_ctl_rx: Receiver<TapCtl>,
    debug_hub: Arc<DebugEventHub>,
) {
    #[cfg(any(test, feature = "test-hooks"))]
    {
        let hook = *BUS_IO_THREAD_START_HOOK.lock();
        if let Some(hook) = hook {
            hook();
        }
    }

    let mut panic_watch = PanicAbortWatch::new(&tx_panic_latched, &tx_epoch);
    let gate = GateRefs {
        listen_only,
        tx_armed: Arc::clone(&tx_armed),
        panic_latched: tx_panic_latched,
        tx_epoch,
    };
    let mut rx_batch = [RawCanFrame::zeroed(); 256];
    let mut taps = TapTable::new();
    let mut tick_counter = 0u32;
    // Drivers that deliver our own TX back as RX (mock0 loopback, CANsub `tx_ack_frames` TX-ack
    // with `FLAG_TX`): no synthesized echo, otherwise every TX would appear twice in the trace.
    let driver_has_self_loopback = matches!(
        channel.descriptor().driver_id.as_str(),
        "mock" | crate::drivers::cansub_drv::CANSUB_DRIVER_ID
    );
    // Suppressed (restbus/replay) TX whose loopback echo is still expected: matched by identity
    // with a timeout, so an echo that never comes (no ACK on the bus) cannot eat a later TX-ack.
    let mut pending_echoes = echo_suppress::PendingEchoes::new();
    // Cold-path counter reporting (driver RX drops, pending-echo evictions).
    let mut driver_dropped_seen = channel.driver_dropped_frames();
    let mut reported_driver_dropped = driver_dropped_seen;
    let mut reported_echo_evicted = 0u64;
    let mut last_report = Instant::now();

    while !bus_stop.load(Ordering::Acquire) && !engine_stop.load(Ordering::Acquire) {
        // 0. Cold path: diag tap add/remove.
        taps.apply_ctl(&diag_ctl_rx);

        // 0b. Panic Stop: discard adapter-side TX work exactly once per Panic (this thread owns
        //     the channel, so the call is serialized with `send_frame`). Read-only on the latch
        //     and epoch: the WP-4 SeqCst handshake in `cmd_panic_stop_tx` is unchanged.
        if panic_watch.poll(&gate.panic_latched, &gate.tx_epoch) {
            if let Err(e) = channel.abort_pending_tx() {
                report_abort_pending_tx_error(&debug_hub, bus_id, &e);
            }
        }

        // 1. Drain outbound TX requests immediately
        while let Ok(req) = tx_rx.try_recv() {
            // Resolve the diag origin. A tap registered just before this drain may not be
            // applied yet: re-apply control messages once before declaring it stale.
            let origin_idx = match req.origin {
                TxOrigin::Other => None,
                TxOrigin::Tap { slot, gen } => match taps.lookup(slot, gen) {
                    Some(i) => Some(i),
                    None => {
                        taps.apply_ctl(&diag_ctl_rx);
                        match taps.lookup(slot, gen) {
                            Some(i) => Some(i),
                            None => continue, // tap dropped: nobody to report to
                        }
                    }
                },
            };

            // Write barrier: announce "in flight" BEFORE the gate loads; released only after
            // `send_frame` returned (Panic Stop / disarm wait for it, see `cmd_panic_stop_tx`).
            let in_flight = TxInFlightGuard::enter(&tx_in_flight);

            // Authoritative safety gate, immediately before the driver write (Listen-Only,
            // Panic latch, Arm Active Bus, and the TX epoch the request was queued under).
            let verdict = match origin_idx {
                Some(i) if taps.is_slot_closed(i) => Err(DiagTxReject::Closed),
                _ => gate.verdict_for_epoch(req.epoch),
            };
            let sent = match verdict {
                Err(reason) => Err((reason, None)),
                Ok(()) => channel
                    .send_frame(&req.frame)
                    .map_err(|e| (adapter_error_to_reject(&e), Some(e))),
            };
            drop(in_flight);

            let result: Result<RawCanFrame, (DiagTxReject, Option<AdapterError>)> =
                sent.map(|()| {
                    if let Some(ref counter) = req.hw_tx_counter {
                        counter.fetch_add(1, Ordering::Relaxed);
                    }
                    let mut tx_echo = req.frame.with_flags(nexus_core::FLAG_TX);
                    tx_echo.bus_id = bus_id;
                    if tx_echo.timestamp_us == 0 || origin_idx.is_some() {
                        tx_echo.timestamp_us = now_monotonic_us().max(1);
                    }
                    if driver_has_self_loopback && req.suppress_echo {
                        pending_echoes.push(&req.frame, now_monotonic_us());
                    } else if !driver_has_self_loopback && !req.suppress_echo {
                        // Synthesized TX echo for Trace / StateTable (diag frames included).
                        if let Err(TrySendError::Full(_)) = frame_tx.try_send(tx_echo) {
                            dropped_frames.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    tx_echo
                });

            match result {
                Ok(echo) => {
                    if let Some(i) = origin_idx {
                        taps.notify(i, DiagPortEvent::TxConfirmed(echo));
                    }
                    // Other taps see this frame as ordinary bus traffic (as a second tester
                    // on the wire would). Restbus replay frames are virtual and excluded.
                    if !req.suppress_echo {
                        taps.deliver(&echo, origin_idx);
                    }
                    if let Some(ack) = req.ack {
                        let _ = ack.send(Ok(()));
                    }
                }
                Err((reason, driver_err)) => {
                    if let Some(i) = origin_idx {
                        taps.notify(i, DiagPortEvent::TxRejected(req.frame, reason));
                    }
                    if let Some(ack) = req.ack {
                        let err = driver_err
                            .unwrap_or_else(|| gate_reject_to_adapter_error(bus_id, reason));
                        let _ = ack.send(Err(err));
                    }
                }
            }
        }

        // 2. Burst-read up to 256 frames (waiting at most 1ms when idle for <25ms shutdown & snappy TX)
        match channel.recv_batch(&mut rx_batch, 1) {
            Ok(count) => {
                for frame in &mut rx_batch[..count] {
                    if frame.is_tx()
                        && !pending_echoes.is_empty()
                        && pending_echoes.take_match(frame, now_monotonic_us())
                    {
                        continue;
                    }
                    frame.bus_id = bus_id;
                    if let Err(TrySendError::Full(_)) = frame_tx.try_send(*frame) {
                        dropped_frames.fetch_add(1, Ordering::Relaxed);
                    }
                    // mock0 loops our own TX back: taps already got it at send time.
                    if !taps.is_empty() && !(driver_has_self_loopback && frame.is_tx()) {
                        taps.deliver(frame, None);
                    }
                }
            }
            Err(AdapterError::ChannelClosed) => {
                tx_armed.store(false, Ordering::SeqCst);
                break;
            }
            Err(_) => {
                rx_errors.fetch_add(1, Ordering::Relaxed);
            }
        }

        // 3. Periodically refresh controller health counters
        tick_counter = tick_counter.wrapping_add(1);
        if (tick_counter & 0x1F) == 0 {
            let h = channel.health();
            bus_state.store(h.state.to_u8(), Ordering::Release);
            tx_errors.store(h.tx_error_count, Ordering::Relaxed);
            rx_errors.store(h.rx_error_count, Ordering::Relaxed);
            // Frames the driver had to drop before they reached us count as pipeline drops.
            let drv_dropped = channel.driver_dropped_frames();
            if drv_dropped > driver_dropped_seen {
                dropped_frames.fetch_add(drv_dropped - driver_dropped_seen, Ordering::Relaxed);
                driver_dropped_seen = drv_dropped;
            }
            if (driver_dropped_seen != reported_driver_dropped
                || pending_echoes.evicted_full() != reported_echo_evicted)
                && last_report.elapsed() >= BUS_IO_REPORT_INTERVAL
            {
                report_bus_io_counters(
                    &debug_hub,
                    bus_id,
                    driver_dropped_seen - reported_driver_dropped,
                    pending_echoes.evicted_full() - reported_echo_evicted,
                );
                reported_driver_dropped = driver_dropped_seen;
                reported_echo_evicted = pending_echoes.evicted_full();
                last_report = Instant::now();
            }
            if h.state == BusState::Disconnected {
                tx_armed.store(false, Ordering::SeqCst);
                break;
            }
        }
    }

    tx_armed.store(false, Ordering::SeqCst);
    // Close all diag taps and reject their queued sends with `Closed` before the channel goes.
    taps.shutdown(&tx_rx, &diag_ctl_rx);
    let _ = channel.close();
    bus_state.store(BusState::Disconnected.to_u8(), Ordering::Release);
}

#[allow(clippy::too_many_arguments)]
fn run_aggregator_loop(
    frame_rx: Receiver<RawCanFrame>,
    ctrl_rx: Receiver<AggregatorControl>,
    engine_stop: Arc<AtomicBool>,
    buses: Arc<Mutex<BTreeMap<BusId, ConnectedBusHandle>>>,
    dropped_frames: Arc<AtomicU64>,
    tx_panic_latched: Arc<AtomicBool>,
    replay: Arc<ReplayController>,
    snapshot_bcast_tx: broadcast::Sender<TelemetrySnapshotDto>,
    latest_snapshot: Arc<RwLock<Option<TelemetrySnapshotDto>>>,
    debug_hub: Arc<DebugEventHub>,
    re: Arc<ReShared>,
) {
    let mut state_table = StateTable::new();
    let tick_duration = Duration::from_micros(SNAPSHOT_INTERVAL_US);
    let mut next_tick = Instant::now() + tick_duration;
    let mut health_tick = 0u32;
    let mut prev_bus_states: BTreeMap<BusId, BusState> = BTreeMap::new();
    let mut prev_total_err = 0u64;
    let mut prev_dropped = 0u64;

    while !engine_stop.load(Ordering::Acquire) {
        // 1. Apply pending control commands
        while let Ok(ctrl) = ctrl_rx.try_recv() {
            match ctrl {
                AggregatorControl::SetDatabase(db_opt) => state_table.set_database(db_opt),
                AggregatorControl::SetBusDatabase(bus_id, db_opt) => {
                    state_table.set_bus_database(bus_id, db_opt);
                }
                AggregatorControl::ClearAllBusDatabases => state_table.clear_all_bus_databases(),
                AggregatorControl::ClearBus(bus_id) => {
                    state_table.clear_bus(bus_id);
                    prev_bus_states.remove(&bus_id);
                }
                AggregatorControl::ResetAll => {
                    while frame_rx.try_recv().is_ok() {}
                    state_table.reset_all();
                    dropped_frames.store(0, Ordering::Relaxed);
                    prev_total_err = 0;
                    prev_dropped = 0;
                    let _ = emit_snapshot_now(
                        &mut state_table,
                        &buses,
                        &dropped_frames,
                        &tx_panic_latched,
                        &replay,
                        &snapshot_bcast_tx,
                        &latest_snapshot,
                    );
                }
                AggregatorControl::FlushSnapshot(reply_tx) => {
                    let mut re_batch = re.batch();
                    while let Ok(f) = frame_rx.try_recv() {
                        state_table.ingest_frame(&f);
                        if let Some(a) = re_batch.as_mut() {
                            a.ingest(&f);
                        }
                    }
                    drop(re_batch);
                    check_bus_err_health(
                        &state_table,
                        &buses,
                        &dropped_frames,
                        &debug_hub,
                        &mut prev_bus_states,
                        &mut prev_total_err,
                        &mut prev_dropped,
                    );
                    let snap = emit_snapshot_now(
                        &mut state_table,
                        &buses,
                        &dropped_frames,
                        &tx_panic_latched,
                        &replay,
                        &snapshot_bcast_tx,
                        &latest_snapshot,
                    );
                    let _ = reply_tx.send(snap);
                }
            }
        }

        // 2. Burst-drain bounded frame channel into StateTable
        // RE Toolkit: one relaxed atomic load per batch when off; analyzer lock held per batch.
        let mut drained = 0usize;
        let mut re_batch = re.batch();
        while drained < 16_384 {
            match frame_rx.try_recv() {
                Ok(frame) => {
                    state_table.ingest_frame(&frame);
                    if let Some(a) = re_batch.as_mut() {
                        a.ingest(&frame);
                    }
                    drained += 1;
                }
                Err(_) => break,
            }
        }
        drop(re_batch);

        // 3. Check 60Hz (16.667ms) snapshot deadline
        let now = Instant::now();
        if now >= next_tick {
            let mut re_batch = re.batch();
            while let Ok(frame) = frame_rx.try_recv() {
                state_table.ingest_frame(&frame);
                if let Some(a) = re_batch.as_mut() {
                    a.ingest(&frame);
                }
            }
            drop(re_batch);

            health_tick = health_tick.wrapping_add(1);
            if health_tick.is_multiple_of(30) {
                check_bus_err_health(
                    &state_table,
                    &buses,
                    &dropped_frames,
                    &debug_hub,
                    &mut prev_bus_states,
                    &mut prev_total_err,
                    &mut prev_dropped,
                );
            }

            let _ = emit_snapshot_now(
                &mut state_table,
                &buses,
                &dropped_frames,
                &tx_panic_latched,
                &replay,
                &snapshot_bcast_tx,
                &latest_snapshot,
            );

            next_tick += tick_duration;
            if next_tick <= now {
                next_tick = now + tick_duration;
            }
        } else if drained == 0 {
            let wait = (next_tick - now).min(Duration::from_millis(2));
            if let Ok(frame) = frame_rx.recv_timeout(wait) {
                state_table.ingest_frame(&frame);
                if let Some(mut a) = re.batch() {
                    a.ingest(&frame);
                }
            }
        }
    }
}

/// Coalesced ~500 ms (30-tick) controller state, CAN error frame, and ring-drop monitor.
/// Zero cost on the per-frame `ingest_frame` hot path.
fn check_bus_err_health(
    state_table: &StateTable,
    buses: &Mutex<BTreeMap<BusId, ConnectedBusHandle>>,
    dropped_frames: &AtomicU64,
    debug_hub: &DebugEventHub,
    prev_bus_states: &mut BTreeMap<BusId, BusState>,
    prev_total_err: &mut u64,
    prev_dropped: &mut u64,
) {
    // 1. Check per-bus ISO 11898-1 controller error state transitions (`Active` <-> `Warning` / `Passive` / `BusOff`)
    {
        let guard = buses.lock();
        prev_bus_states.retain(|id, _| guard.contains_key(id));
        for (&bus_id, bus) in guard.iter() {
            let cur_state = BusState::from_u8(bus.bus_state.load(Ordering::Acquire));
            if cur_state == BusState::Disconnected {
                continue;
            }
            let prev_opt = prev_bus_states.insert(bus_id, cur_state);
            match prev_opt {
                None => {
                    if matches!(
                        cur_state,
                        BusState::Warning | BusState::Passive | BusState::BusOff
                    ) {
                        let tec = bus.tx_errors.load(Ordering::Relaxed);
                        let rec = bus.rx_errors.load(Ordering::Relaxed);
                        let sev = match cur_state {
                            BusState::BusOff | BusState::Passive => "error",
                            _ => "warn",
                        };
                        debug_hub.record(
                            sev,
                            "BUS_ERR",
                            "backend",
                            Some(bus_id),
                            "bus.state_changed",
                            format!(
                                "Bus {} controller in '{}' state",
                                u16::from(bus_id) + 1,
                                cur_state.as_str()
                            ),
                            Some(format!(
                                "device={}, TEC={tec}, REC={rec}",
                                bus.descriptor.device_id
                            )),
                        );
                    }
                }
                Some(prev_state) if prev_state != cur_state => {
                    let tec = bus.tx_errors.load(Ordering::Relaxed);
                    let rec = bus.rx_errors.load(Ordering::Relaxed);
                    let sev = match cur_state {
                        BusState::BusOff | BusState::Passive => "error",
                        BusState::Warning => "warn",
                        BusState::Active => "success",
                        BusState::Disconnected => "info",
                    };
                    debug_hub.record(
                        sev,
                        "BUS_ERR",
                        "backend",
                        Some(bus_id),
                        "bus.state_changed",
                        format!(
                            "Bus {} controller transitioned '{}' -> '{}'",
                            u16::from(bus_id) + 1,
                            prev_state.as_str(),
                            cur_state.as_str()
                        ),
                        Some(format!(
                            "device={}, TEC={tec}, REC={rec}",
                            bus.descriptor.device_id
                        )),
                    );
                }
                _ => {}
            }
        }
    }

    // 2. Check coalesced CAN error frames accumulated in `StateTable`
    let cur_err = state_table.total_frames_err();
    if cur_err > *prev_total_err {
        let delta = cur_err - *prev_total_err;
        *prev_total_err = cur_err;
        if let Some((err_bus, err_mask, summary)) = state_table.latest_error_summary_hint() {
            debug_hub.record(
                "error",
                "BUS_ERR",
                "backend",
                Some(err_bus),
                "bus.error_frames",
                format!(
                    "Captured +{delta} CAN Error Frame(s) on Bus {} ({summary})",
                    u16::from(err_bus) + 1
                ),
                Some(format!(
                    "totalErrFrames={cur_err}, errMask=0x{err_mask:03X}"
                )),
            );
        } else {
            debug_hub.record(
                "error",
                "BUS_ERR",
                "backend",
                None,
                "bus.error_frames",
                format!("Captured +{delta} CAN Error Frame(s)"),
                Some(format!("totalErrFrames={cur_err}")),
            );
        }
    } else if cur_err < *prev_total_err {
        *prev_total_err = cur_err;
    }

    // 3. Check lock-free ring buffer drops
    let cur_dropped = dropped_frames.load(Ordering::Relaxed);
    if cur_dropped > *prev_dropped {
        let delta = cur_dropped - *prev_dropped;
        *prev_dropped = cur_dropped;
        debug_hub.record(
            "warn",
            "BUS_ERR",
            "backend",
            None,
            "bus.dropped_frames",
            format!("Ring buffer backpressure dropped +{delta} frame(s)"),
            Some(format!("totalDroppedFrames={cur_dropped}")),
        );
    } else if cur_dropped < *prev_dropped {
        *prev_dropped = cur_dropped;
    }
}

fn emit_snapshot_now(
    state_table: &mut StateTable,
    buses: &Mutex<BTreeMap<BusId, ConnectedBusHandle>>,
    dropped_frames: &AtomicU64,
    tx_panic_latched: &AtomicBool,
    replay: &ReplayController,
    snapshot_bcast_tx: &broadcast::Sender<TelemetrySnapshotDto>,
    latest_snapshot: &RwLock<Option<TelemetrySnapshotDto>>,
) -> TelemetrySnapshotDto {
    let (bus_dtos, nominal_cap_bps) = {
        let guard = buses.lock();
        let mut list = Vec::with_capacity(guard.len());
        let mut total_cap = 0u64;
        for bus in guard.values() {
            list.push(bus.to_health_dto());
            total_cap = total_cap.saturating_add(bus.nominal_capacity_bps());
        }
        (list, total_cap)
    };

    let now_us = now_monotonic_us().max(1);
    let dropped = dropped_frames.load(Ordering::Relaxed);
    let panic = tx_panic_latched.load(Ordering::Acquire);
    let mut snapshot =
        state_table.build_snapshot(now_us, dropped, panic, nominal_cap_bps, bus_dtos);
    snapshot.replay = replay.status_snapshot();

    *latest_snapshot.write() = Some(snapshot.clone());
    let _ = snapshot_bcast_tx.send(snapshot.clone());
    snapshot
}

fn reap_dead_bus_handles(
    buses: &Mutex<BTreeMap<BusId, ConnectedBusHandle>>,
    tx_scheduler: &Mutex<TxScheduler>,
    debug_hub: &DebugEventHub,
) -> usize {
    let dead_handles: Vec<(BusId, ConnectedBusHandle)> = {
        let mut guard = buses.lock();
        if guard.values().all(ConnectedBusHandle::is_connected) {
            return 0;
        }
        let dead_ids: Vec<BusId> = guard
            .iter()
            .filter_map(|(&id, h)| (!h.is_connected()).then_some(id))
            .collect();
        let mut extracted = Vec::with_capacity(dead_ids.len());
        for id in dead_ids {
            if let Some(h) = guard.remove(&id) {
                h.tx_armed.store(false, Ordering::SeqCst);
                h.diag.close_all();
                extracted.push((id, h));
            }
        }
        extracted
    };

    if dead_handles.is_empty() {
        return 0;
    }

    {
        let mut sched = tx_scheduler.lock();
        for &(bus_id, _) in &dead_handles {
            sched.remove_jobs_for_bus(bus_id);
        }
    }

    let count = dead_handles.len();
    for (bus_id, mut handle) in dead_handles {
        let dev_id = handle.descriptor.device_id.clone();
        let chan_name = handle.descriptor.channel_name.clone();
        handle.shutdown();
        debug_hub.record(
            "warn",
            "CONN",
            "os",
            Some(bus_id),
            "bus.hot_unplugged",
            format!(
                "Physical adapter lost on Bus {} ({dev_id}) — channel reaped & disarmed",
                u16::from(bus_id) + 1
            ),
            Some(format!(
                "channel={chan_name}, periodicJobsStopped=true, txArmed=false"
            )),
        );
    }
    count
}

fn run_tx_scheduler_loop(
    engine_stop: Arc<AtomicBool>,
    tx_panic_latched: Arc<AtomicBool>,
    tx_epoch: Arc<AtomicU64>,
    buses: Arc<Mutex<BTreeMap<BusId, ConnectedBusHandle>>>,
    tx_scheduler: Arc<Mutex<TxScheduler>>,
    debug_hub: Arc<DebugEventHub>,
) {
    let mut reap_tick = 0u32;
    while !engine_stop.load(Ordering::Acquire) {
        reap_tick = reap_tick.wrapping_add(1);
        if (reap_tick & 0x1F) == 0 {
            let _ = reap_dead_bus_handles(&buses, &tx_scheduler, &debug_hub);
        }

        // Epoch captured BEFORE the due frames are collected: frames of a job that a Panic
        // Stop removed in between are rejected by the bus-io gate even after a re-arm.
        let epoch = tx_epoch.load(Ordering::Acquire);
        if tx_panic_latched.load(Ordering::Acquire) {
            tx_scheduler.lock().clear_all();
            thread::sleep(Duration::from_millis(2));
            continue;
        }

        let due = {
            let mut sched = tx_scheduler.lock();
            if sched.is_empty() {
                Vec::new()
            } else {
                sched.collect_due_frames(Instant::now(), now_monotonic_us().max(1))
            }
        };

        if !due.is_empty() {
            let guard = buses.lock();
            for (bus_id, frame) in due {
                if let Some(bus) = guard.get(&bus_id) {
                    if !bus.listen_only
                        && !tx_panic_latched.load(Ordering::Acquire)
                        && bus.tx_armed.load(Ordering::Acquire)
                    {
                        let _ = bus.tx_sender.try_send(TxDispatchRequest {
                            frame,
                            ack: None,
                            suppress_echo: false,
                            hw_tx_counter: None,
                            origin: TxOrigin::Other,
                            epoch,
                        });
                    }
                }
            }
        }

        thread::sleep(Duration::from_millis(1));
    }
}

pub(crate) fn format_hex_bytes_preview(bytes: &[u8]) -> String {
    const MAX_PREVIEW: usize = 16;
    let shown = bytes.len().min(MAX_PREVIEW);
    let mut out = String::with_capacity(shown * 3 + 8);
    for (idx, b) in bytes[..shown].iter().enumerate() {
        if idx > 0 {
            out.push(' ');
        }
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02X}");
    }
    if bytes.len() > MAX_PREVIEW {
        use std::fmt::Write as _;
        let _ = write!(&mut out, " … ({} B)", bytes.len());
    }
    out
}

fn decode_base64_db_bytes(content_base64: &str) -> Result<Vec<u8>, HalError> {
    let trimmed = content_base64.trim();
    BASE64_STD
        .decode(trimmed)
        .or_else(|_| BASE64_NO_PAD.decode(trimmed))
        .map_err(|e| HalError::InvalidInput(format!("Invalid Base64 database content: {e}")))
}

fn decode_base64_trace_bytes(content_base64: &str) -> Result<Vec<u8>, HalError> {
    let trimmed = content_base64.trim();
    BASE64_STD
        .decode(trimmed)
        .or_else(|_| BASE64_NO_PAD.decode(trimmed))
        .map_err(|e| HalError::InvalidInput(format!("Invalid Base64 trace content: {e}")))
}

/// WP-8 / HIGH-09: preset sample databases are embedded at build time so packaged builds do
/// not depend on the source checkout (`CARGO_MANIFEST_DIR`) at runtime.
const PRESET_VEHICLE_DBC_NAME: &str = "sample_vehicle.dbc";
const PRESET_BMS_KCD_NAME: &str = "sample_bms.kcd";
const PRESET_VEHICLE_DBC: &[u8] = include_bytes!("../../../../scripts/sample_vehicle.dbc");
const PRESET_BMS_KCD: &[u8] = include_bytes!("../../../../scripts/sample_bms.kcd");

/// WP-8: bounds the variable-length parts of TX requests (raw `data` is bounded to 64 bytes
/// by `RawCanFrame::new_fd` / `new_classical`).
fn check_tx_request_sizes(
    signal_count: Option<usize>,
    job_label: Option<&str>,
) -> Result<(), HalError> {
    if let Some(n) = signal_count {
        if n > crate::storage::MAX_TX_SIGNAL_VALUES {
            return Err(HalError::InvalidInput(format!(
                "Too many signal values ({n}, limit {})",
                crate::storage::MAX_TX_SIGNAL_VALUES
            )));
        }
    }
    if let Some(label) = job_label {
        check_ipc_size(
            "TX job label",
            label.len(),
            crate::storage::MAX_TX_JOB_LABEL_BYTES,
        )?;
    }
    Ok(())
}

/// Rejects trace `content` / `content_base64` payloads above [`MAX_IPC_CONTENT_BYTES`].
fn check_trace_content_sizes(
    content: Option<&str>,
    content_base64: Option<&str>,
) -> Result<(), HalError> {
    if let Some(c) = content {
        check_ipc_size("Trace content", c.len(), MAX_IPC_CONTENT_BYTES)?;
    }
    if let Some(c) = content_base64 {
        check_ipc_size("Trace content (base64)", c.len(), MAX_IPC_CONTENT_BYTES)?;
    }
    Ok(())
}

/// Validates a project stem and normalizes it to `[a-zA-Z0-9_-]` (whitespace -> `_`, other
/// punctuation dropped). Path-like input (`/`, `\\`, `..`, leading `.`, `:`, control chars) is an
/// error (WP-8), never rewritten.
///
/// WP-8: a stem that sanitizes to nothing (empty, `.`, `..`, only separators / punctuation) or to
/// a Windows reserved device name is an error instead of a shared `untitled_project` default.
pub fn sanitize_project_stem(raw: &str) -> Result<String, HalError> {
    let trimmed = raw
        .trim()
        .strip_suffix(".nexusproj.json")
        .or_else(|| raw.trim().strip_suffix(".json"))
        .unwrap_or_else(|| raw.trim());
    crate::storage::reject_path_like_name("project name", trimmed)?;

    let mut out = String::with_capacity(trimmed.len().min(120));
    let mut last_underscore = false;

    for ch in trimmed.chars() {
        if out.len() >= 120 {
            break;
        }
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
            last_underscore = ch == '_';
        } else if ch.is_whitespace() && !last_underscore && !out.is_empty() {
            out.push('_');
            last_underscore = true;
        }
    }

    let cleaned = out.trim_matches(|c| c == '_' || c == '-');
    if cleaned.is_empty() {
        return Err(HalError::InvalidInput(format!(
            "Invalid project name '{}': use letters, digits, '-' or '_'",
            raw.trim()
        )));
    }
    if crate::storage::is_windows_reserved_stem(cleaned) {
        return Err(HalError::InvalidInput(format!(
            "Invalid project name '{cleaned}': reserved device name"
        )));
    }
    Ok(cleaned.to_string())
}

/// WP-8 / HIGH-09 / HIGH-10: storage hardening at the engine command level.
#[cfg(test)]
mod wp8_storage_tests {
    use super::*;
    use crate::storage::MAX_IPC_CONTENT_BYTES;

    const TRC: &str = "\
;$FILEVERSION=2.1
;$COLUMNS=N,O,T,B,I,d,L,D
1 0.000 DT 1 0101 Rx 8 10 27 00 00 00 00 00 00
2 25.000 DT 1 0101 Rx 8 20 4E 00 00 00 00 00 00
";

    fn engine(tag: &str) -> (PipelineEngine, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "nexuscan-wp8-{tag}-{}-{}",
            std::process::id(),
            nexus_core::now_monotonic_us()
        ));
        let _ = fs::remove_dir_all(&root);
        let engine = PipelineEngine::with_data_root(
            DriverRegistry::with_builtin_drivers(),
            DataRoot::under(&root),
        );
        (engine, root)
    }

    /// Sorted (name, len, mtime) snapshot of a directory.
    fn dir_snapshot(dir: &std::path::Path) -> Vec<(String, u64, Option<std::time::SystemTime>)> {
        let mut v: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| {
                let m = fs::symlink_metadata(e.path()).unwrap();
                (
                    e.file_name().to_string_lossy().into_owned(),
                    m.len(),
                    m.modified().ok(),
                )
            })
            .collect();
        v.sort();
        v
    }

    #[test]
    fn with_data_root_creates_layout_and_uses_it() {
        let (engine, root) = engine("layout");
        assert!(root.join("projects").is_dir());
        assert!(root.join("traces").is_dir());
        engine
            .cmd_save_trace_file("a.trc".into(), Some(TRC.into()), None)
            .unwrap();
        engine
            .cmd_save_project("p1".into(), r#"{"name":"P1"}"#.into())
            .unwrap();
        assert!(root.join("traces/a.trc").is_file());
        assert!(root.join("projects/p1.nexusproj.json").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn invalid_names_are_errors_and_write_nothing() {
        let (engine, root) = engine("names");
        for bad in [
            "../evil", "..", ".", "", "  ", ".dot", "a..b", "a/b", "a\\b", "CON",
        ] {
            assert!(
                engine
                    .cmd_save_trace_file(format!("{bad}.trc"), Some(TRC.into()), None)
                    .is_err(),
                "trace {bad:?} must be rejected"
            );
            assert!(
                engine
                    .cmd_save_project(bad.to_string(), "{}".into())
                    .is_err(),
                "project {bad:?} must be rejected"
            );
            assert!(engine.cmd_load_trace_file(bad.to_string()).is_err());
            assert!(engine.cmd_delete_trace_file(bad.to_string()).is_err());
        }
        assert!(dir_snapshot(&root.join("traces")).is_empty());
        assert!(dir_snapshot(&root.join("projects")).is_empty());
        assert!(!root.join("evil.trc").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn oversized_payloads_are_rejected_before_parsing() {
        let (engine, root) = engine("size");
        let big = "x".repeat(MAX_IPC_CONTENT_BYTES + 1);
        assert!(engine
            .cmd_save_project("big".into(), big.clone())
            .unwrap_err()
            .to_string()
            .contains("too large"));
        assert!(engine
            .cmd_save_trace_file("big.trc".into(), Some(big.clone()), None)
            .is_err());
        assert!(engine
            .cmd_save_trace_file("big.blf".into(), None, Some(big.clone()))
            .is_err());
        assert!(engine
            .cmd_parse_trace_content("big.trc".into(), Some(big.clone()), None)
            .is_err());
        assert!(engine
            .cmd_load_database_content("big.dbc".into(), big.clone(), false)
            .is_err());
        assert!(engine
            .cmd_parse_database_schema("big.dbc".into(), big)
            .is_err());
        let many = vec![(0u32, 0.0f64); crate::storage::MAX_TX_SIGNAL_VALUES + 1];
        assert!(engine
            .cmd_transmit_signal_frame(0, 0x100, false, many, None, None)
            .unwrap_err()
            .to_string()
            .contains("Too many signal values"));
        let label = Some("l".repeat(crate::storage::MAX_TX_JOB_LABEL_BYTES + 1));
        assert!(engine
            .cmd_transmit_raw_frame(0, 0x100, false, false, false, vec![1], Some(100), label)
            .unwrap_err()
            .to_string()
            .contains("too large"));
        assert!(dir_snapshot(&root.join("traces")).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_traces_reads_metadata_only() {
        let (engine, root) = engine("list");
        let traces = root.join("traces");
        // Garbage body with a trace extension: listing must not parse it.
        fs::write(
            traces.join("garbage.asc"),
            b"\x00\xffnot a trace at all\x01",
        )
        .unwrap();
        // Hidden temp-like file and non-canonical name are not listed.
        fs::write(traces.join(".partial.trc.tmp"), b"x").unwrap();
        fs::write(traces.join("has space.trc"), TRC).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let locked = traces.join("locked.trc");
            fs::write(&locked, TRC).unwrap();
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        }

        let listed = engine.cmd_list_traces().unwrap();
        let names: Vec<_> = listed.files.iter().map(|f| f.file_name.as_str()).collect();
        assert!(names.contains(&"garbage.asc"), "{names:?}");
        assert!(!names.contains(&"has space.trc"));
        assert!(!names.iter().any(|n| n.starts_with('.')));
        for f in &listed.files {
            assert!(!f.stats_known, "{} must not be parsed by list", f.file_name);
            assert_eq!(f.frame_count, 0);
            assert_eq!(f.duration_us, 0);
        }
        #[cfg(unix)]
        assert!(names.contains(&"locked.trc"));

        // Once saved / opened through the engine, stats become known via the cache.
        engine
            .cmd_save_trace_file("known.trc".into(), Some(TRC.into()), None)
            .unwrap();
        let listed = engine.cmd_list_traces().unwrap();
        let known = listed
            .files
            .iter()
            .find(|f| f.file_name == "known.trc")
            .unwrap();
        assert!(known.stats_known);
        assert_eq!(known.frame_count, 2);
        assert_eq!(known.duration_us, 25_000);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ =
                fs::set_permissions(traces.join("locked.trc"), fs::Permissions::from_mode(0o600));
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn load_trace_leaves_traces_dir_unchanged() {
        let (engine, root) = engine("load");
        let traces = root.join("traces");
        fs::write(traces.join("cap.trc"), TRC).unwrap();
        let before = dir_snapshot(&traces);
        let loaded = engine.cmd_load_trace_file("cap.trc".into()).unwrap();
        assert_eq!(loaded.frames.len(), 2);
        assert!(loaded.summary.stats_known);
        let parsed = engine
            .cmd_parse_trace_content("imported.trc".into(), Some(TRC.into()), None)
            .unwrap();
        assert_eq!(parsed.frames.len(), 2);
        assert_eq!(
            dir_snapshot(&traces),
            before,
            "open/parse must not write to disk"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_project_and_trace_are_refused() {
        use std::os::unix::fs::symlink;
        let (engine, root) = engine("symlink");
        let outside = root.join("outside.txt");
        fs::write(&outside, TRC).unwrap();
        symlink(&outside, root.join("traces/link.trc")).unwrap();
        symlink(&outside, root.join("projects/link.nexusproj.json")).unwrap();

        assert!(engine.cmd_load_trace_file("link.trc".into()).is_err());
        assert!(engine.cmd_delete_trace_file("link.trc".into()).is_err());
        assert!(engine
            .cmd_save_trace_file("link.trc".into(), Some(TRC.into()), None)
            .is_err());
        assert!(engine.cmd_load_project("link".into()).is_err());
        assert!(engine.cmd_delete_project("link".into()).is_err());
        assert!(engine
            .cmd_save_project("link".into(), r#"{"name":"x"}"#.into())
            .is_err());
        // Listing skips symlinks.
        assert!(engine.cmd_list_traces().unwrap().files.is_empty());
        assert!(engine.cmd_list_projects().unwrap().is_empty());
        // Target untouched, links still in place.
        assert_eq!(fs::read_to_string(&outside).unwrap(), TRC);
        assert!(fs::symlink_metadata(root.join("traces/link.trc"))
            .unwrap()
            .file_type()
            .is_symlink());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn preset_databases_are_embedded() {
        let (engine, root) = engine("preset");
        let files = engine.cmd_get_preset_database_files().unwrap();
        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|f| !f.content_base64.is_empty()));
        assert!(engine.cmd_load_preset_databases().is_ok());
        let _ = fs::remove_dir_all(&root);
    }
}

/// Write-barrier contract of Panic Stop / disarm (field-safety bug: a frame that passed the
/// bus-io gate before the Panic reached the wire after `cmd_panic_stop_tx()` returned).
/// A test channel blocks inside `send_frame` (i.e. AFTER the gate passed) under test control.
#[cfg(test)]
mod tx_write_barrier_tests {
    use super::*;
    use crate::drivers::mock_drv::MOCK0_DEVICE_ID;
    use crate::traits::{AdapterCapabilities, BusHealthSnapshot, CanFilter};

    /// Disarm barrier bound for the race tests (production keeps [`TX_QUIESCE_TIMEOUT`]).
    const RACE_TEST_QUIESCE_BOUND: Duration = Duration::from_secs(10);

    /// mock0 wrapper: `send_frame` reports entry, then blocks until released (or `hold`).
    struct GatedSendChannel {
        inner: Box<dyn CanChannel>,
        entered: Sender<()>,
        release: Receiver<()>,
        hold: Duration,
        completed: Arc<Mutex<Vec<Instant>>>,
    }

    impl CanChannel for GatedSendChannel {
        fn descriptor(&self) -> &DeviceDescriptor {
            self.inner.descriptor()
        }
        fn capabilities(&self) -> &AdapterCapabilities {
            self.inner.capabilities()
        }
        fn close(&mut self) -> Result<(), AdapterError> {
            self.inner.close()
        }
        fn recv_batch(
            &mut self,
            out_batch: &mut [RawCanFrame],
            timeout_ms: u32,
        ) -> Result<usize, AdapterError> {
            self.inner.recv_batch(out_batch, timeout_ms)
        }
        fn send_frame(&mut self, frame: &RawCanFrame) -> Result<(), AdapterError> {
            let _ = self.entered.send(());
            let _ = self.release.recv_timeout(self.hold);
            let r = self.inner.send_frame(frame);
            self.completed.lock().push(Instant::now());
            r
        }
        fn set_filters(&mut self, filters: &[CanFilter]) -> Result<(), AdapterError> {
            self.inner.set_filters(filters)
        }
        fn health(&self) -> BusHealthSnapshot {
            self.inner.health()
        }
    }

    struct Rig {
        engine: PipelineEngine,
        entered: Receiver<()>,
        release: Sender<()>,
        completed: Arc<Mutex<Vec<Instant>>>,
    }

    /// Engine with bus 0 = armed, active mock0 behind a [`GatedSendChannel`].
    fn rig(hold: Duration) -> Rig {
        let engine = PipelineEngine::new();
        let cfg = ChannelConfigDto {
            bus_id: 0,
            listen_only: false,
            ..ChannelConfigDto::default()
        };
        let (descriptor, inner) = engine
            .registry
            .open_by_device_id(MOCK0_DEVICE_ID, &cfg)
            .expect("open mock0");
        let (entered_tx, entered) = bounded(64);
        let (release, release_rx) = bounded(64);
        let completed = Arc::new(Mutex::new(Vec::new()));
        let chan = GatedSendChannel {
            inner,
            entered: entered_tx,
            release: release_rx,
            hold,
            completed: Arc::clone(&completed),
        };
        let handle = engine
            .spawn_connected_bus_handle(0, descriptor, cfg, Box::new(chan), true)
            .expect("spawn bus");
        engine.buses.lock().insert(0, handle);
        Rig {
            engine,
            entered,
            release,
            completed,
        }
    }

    fn one_shot(engine: &PipelineEngine) {
        // The 50 ms ack timeout may expire while the test holds the driver; irrelevant here.
        let _ =
            engine.cmd_transmit_raw_frame(0, 0x321, false, false, false, vec![0x11], None, None);
    }

    /// Enqueues `frame` with an explicit epoch, bypassing the command-side checks (emulates a
    /// request that was queued before a Panic and drains after Clear Panic + re-arm).
    fn enqueue_raw(engine: &PipelineEngine, epoch: u64) {
        let guard = engine.buses.lock();
        let bus = guard.get(&0).expect("bus 0");
        let frame = RawCanFrame::new_classical(
            0,
            CanIdKey::new_standard(0x322).expect("id"),
            &[0x22],
            now_monotonic_us().max(1),
        )
        .expect("frame");
        bus.tx_sender
            .try_send(TxDispatchRequest {
                frame,
                ack: None,
                suppress_echo: false,
                hw_tx_counter: None,
                origin: TxOrigin::Other,
                epoch,
            })
            .expect("enqueue");
    }

    #[test]
    fn panic_does_not_return_before_in_flight_write_completes_and_nothing_follows() {
        let r = rig(Duration::from_secs(5));
        let stale_epoch = r.engine.tx_epoch.load(Ordering::SeqCst);

        thread::scope(|s| {
            s.spawn(|| one_shot(&r.engine));
            r.entered
                .recv_timeout(Duration::from_secs(2))
                .expect("gate passed, driver write blocked");

            let (done_tx, done_rx) = bounded(1);
            let engine = &r.engine;
            s.spawn(move || {
                let res = engine.cmd_panic_stop_tx();
                let _ = done_tx.send((res, Instant::now()));
            });
            assert!(
                done_rx.recv_timeout(Duration::from_millis(100)).is_err(),
                "cmd_panic_stop_tx returned while a gated write was still in flight"
            );
            assert!(r.engine.is_panic_latched(), "latch is set before the wait");

            r.release.send(()).expect("release driver");
            let (res, returned_at) = done_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("panic returns once the write finished");
            let completed = r.completed.lock().clone();
            assert_eq!(completed.len(), 1);
            assert!(
                completed[0] <= returned_at,
                "write completed after cmd_panic_stop_tx returned"
            );
            assert!(res.in_flight_timeout_buses.is_empty(), "{res:?}");
            assert_eq!(res.disarmed_buses, 1);
        });

        // Latched: nothing passes the gate (let the io thread drain it while latched).
        enqueue_raw(&r.engine, r.engine.tx_epoch.load(Ordering::SeqCst));
        assert!(
            r.entered.recv_timeout(Duration::from_millis(100)).is_err(),
            "a frame reached send_frame while Panic Stop is latched"
        );
        // Clear + re-arm: a request of the pre-Panic epoch still never reaches the driver.
        r.engine.cmd_clear_panic_latch();
        r.engine.cmd_arm_active_bus(0, true).expect("re-arm");
        enqueue_raw(&r.engine, stale_epoch);
        assert!(
            r.entered.recv_timeout(Duration::from_millis(100)).is_err(),
            "a frame reached send_frame after Panic Stop"
        );
        assert_eq!(r.completed.lock().len(), 1);

        // Positive control: a fresh request after re-arm does reach the driver.
        thread::scope(|s| {
            s.spawn(|| one_shot(&r.engine));
            r.entered
                .recv_timeout(Duration::from_secs(2))
                .expect("fresh TX after re-arm reaches the driver");
            r.release.send(()).expect("release");
        });
        r.engine.cmd_disconnect_bus(0).expect("disconnect");
    }

    #[test]
    fn panic_reports_driver_write_that_outlives_the_quiesce_timeout() {
        let r = rig(Duration::from_secs(3));
        thread::scope(|s| {
            s.spawn(|| one_shot(&r.engine));
            r.entered
                .recv_timeout(Duration::from_secs(2))
                .expect("gate passed, driver write blocked");

            let t0 = Instant::now();
            let res = r.engine.cmd_panic_stop_tx();
            let waited = t0.elapsed();
            assert!(
                waited >= TX_QUIESCE_TIMEOUT && waited < TX_QUIESCE_TIMEOUT * 4,
                "panic waited {waited:?}, expected ~{TX_QUIESCE_TIMEOUT:?}"
            );
            assert_eq!(res.in_flight_timeout_buses, vec![0]);
            assert!(r.engine.is_panic_latched());
            assert!(
                r.completed.lock().is_empty(),
                "the blocking write is still running"
            );
            r.release.send(()).expect("release driver");
        });
        r.engine.cmd_disconnect_bus(0).expect("disconnect");
    }

    #[test]
    fn disarm_waits_for_in_flight_write_and_reports_timeout() {
        let mut r = rig(Duration::from_secs(3));
        // Part 1 checks that disarm WAITS; a generous bound keeps a paused CI VM (steal time)
        // from turning the bounded wait into a false "returned early".
        r.engine.disarm_quiesce_timeout = RACE_TEST_QUIESCE_BOUND;
        thread::scope(|s| {
            s.spawn(|| one_shot(&r.engine));
            r.entered
                .recv_timeout(Duration::from_secs(2))
                .expect("blocked");
            let (done_tx, done_rx) = bounded(1);
            let engine = &r.engine;
            s.spawn(move || {
                let res = engine.cmd_arm_active_bus(0, false);
                let _ = done_tx.send((res.map(|h| h.tx_armed), Instant::now()));
            });
            assert!(
                done_rx.recv_timeout(Duration::from_millis(100)).is_err(),
                "disarm returned while a gated write was still in flight"
            );
            r.release.send(()).expect("release");
            let (res, returned_at) = done_rx.recv_timeout(Duration::from_secs(2)).expect("done");
            assert!(!res.expect("disarm ok"), "bus must report disarmed");
            assert!(r.completed.lock()[0] <= returned_at);
        });

        // Blocking driver: disarm still disarms, but reports the stuck write (production bound).
        r.engine.disarm_quiesce_timeout = TX_QUIESCE_TIMEOUT;
        r.engine.cmd_arm_active_bus(0, true).expect("re-arm");
        thread::scope(|s| {
            s.spawn(|| one_shot(&r.engine));
            r.entered
                .recv_timeout(Duration::from_secs(2))
                .expect("blocked");
            let err = r
                .engine
                .cmd_arm_active_bus(0, false)
                .expect_err("stuck write must be reported");
            assert!(
                err.to_string().contains(TX_IN_FLIGHT_TIMEOUT_PREFIX),
                "{err}"
            );
            assert!(!r.engine.buses.lock()[&0].tx_armed.load(Ordering::SeqCst));
            r.release.send(()).expect("release");
        });
        r.engine.cmd_disconnect_bus(0).expect("disconnect");
    }

    #[test]
    fn request_queued_before_disarm_never_reaches_driver_after_fast_rearm() {
        let mut r = rig(Duration::from_secs(3));
        // The property under test is "disarm never returns Ok while a pre-disarm request is
        // pending"; the bound only has to outlast any CI scheduling pause.
        r.engine.disarm_quiesce_timeout = RACE_TEST_QUIESCE_BOUND;
        let epoch = r.engine.tx_epoch.load(Ordering::SeqCst);
        // A's ack channel is pre-filled, so after A's write returns (in-flight already 0) the
        // io thread parks in `ack.send` BEFORE it drains B: a deterministic pause exactly
        // between "previous write done" and "next queued request reaches the gate".
        let (ack_tx, ack_rx) = bounded::<Result<(), AdapterError>>(1);
        ack_tx.send(Ok(())).expect("pre-fill ack");
        {
            let guard = r.engine.buses.lock();
            let frame = RawCanFrame::new_classical(
                0,
                CanIdKey::new_standard(0x321).expect("id"),
                &[0x11],
                1,
            )
            .expect("frame");
            guard[&0]
                .tx_sender
                .try_send(TxDispatchRequest {
                    frame,
                    ack: Some(ack_tx),
                    suppress_echo: false,
                    hw_tx_counter: None,
                    origin: TxOrigin::Other,
                    epoch,
                })
                .expect("enqueue A");
        }
        r.entered
            .recv_timeout(Duration::from_secs(2))
            .expect("A blocked in driver");
        // B is queued while armed, behind A (same epoch: disarm does not bump the epoch, so
        // only the queue-drain barrier can stop it).
        enqueue_raw(&r.engine, epoch);

        thread::scope(|s| {
            let engine = &r.engine;
            let (done_tx, done_rx) = bounded(1);
            s.spawn(move || {
                let _ = done_tx.send(engine.cmd_arm_active_bus(0, false).map(|h| h.tx_armed));
            });
            thread::sleep(Duration::from_millis(30));
            r.release.send(()).expect("release A"); // A completes, io thread parks on the ack
            let early = done_rx.recv_timeout(Duration::from_millis(100));
            if early.is_ok() {
                // Barrier missing: show the consequence (fast re-arm releases B) before failing.
                r.engine.cmd_arm_active_bus(0, true).expect("re-arm");
            }
            let _ = ack_rx.recv(); // drain the pre-fill
            let _ = ack_rx.recv_timeout(Duration::from_secs(1)); // A's ack: io thread resumes
            assert!(
                early.is_err(),
                "disarm returned while a request queued before it was still pending"
            );
            let res = done_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("disarm returns");
            assert!(!res.expect("disarm ok"));
            r.engine.cmd_arm_active_bus(0, true).expect("re-arm");
        });
        assert!(
            r.entered.recv_timeout(Duration::from_millis(100)).is_err(),
            "a request queued before disarm reached the driver after re-arm"
        );
        assert_eq!(r.completed.lock().len(), 1, "only A was written");
        r.engine.cmd_disconnect_bus(0).expect("disconnect");
    }

    #[test]
    fn quiesce_is_immediate_and_allocation_free_when_idle() {
        let idle = Arc::new(AtomicU32::new(0));
        let t0 = Instant::now();
        let stuck = wait_tx_quiesced(&[(0, idle)], TX_QUIESCE_TIMEOUT);
        assert!(stuck.is_empty() && stuck.capacity() == 0);
        assert!(t0.elapsed() < nexus_core::testing::scaled(Duration::from_millis(5)));
    }

    struct UnpluggableTestChannel {
        inner: Box<dyn CanChannel>,
        unplugged: Arc<AtomicBool>,
    }

    impl CanChannel for UnpluggableTestChannel {
        fn descriptor(&self) -> &DeviceDescriptor {
            self.inner.descriptor()
        }
        fn capabilities(&self) -> &AdapterCapabilities {
            self.inner.capabilities()
        }
        fn close(&mut self) -> Result<(), AdapterError> {
            self.inner.close()
        }
        fn recv_batch(
            &mut self,
            out_batch: &mut [RawCanFrame],
            timeout_ms: u32,
        ) -> Result<usize, AdapterError> {
            if self.unplugged.load(Ordering::Acquire) {
                return Err(AdapterError::ChannelClosed);
            }
            self.inner.recv_batch(out_batch, timeout_ms)
        }
        fn send_frame(&mut self, frame: &RawCanFrame) -> Result<(), AdapterError> {
            if self.unplugged.load(Ordering::Acquire) {
                return Err(AdapterError::ChannelClosed);
            }
            self.inner.send_frame(frame)
        }
        fn set_filters(&mut self, filters: &[CanFilter]) -> Result<(), AdapterError> {
            self.inner.set_filters(filters)
        }
        fn health(&self) -> BusHealthSnapshot {
            if self.unplugged.load(Ordering::Acquire) {
                return BusHealthSnapshot {
                    state: BusState::Disconnected,
                    tx_error_count: 0,
                    rx_error_count: 0,
                };
            }
            self.inner.health()
        }
    }

    #[test]
    fn hot_unplug_dead_bus_is_reaped_and_reconnects_without_already_connected_error() {
        let engine = PipelineEngine::new();

        // 1. Connect Bus 0 (unpluggable adapter) AND Bus 1 (live adapter) simultaneously
        let cfg0 = ChannelConfigDto {
            bus_id: 0,
            listen_only: false,
            ..ChannelConfigDto::default()
        };
        let (desc0, inner0) = engine
            .registry
            .open_by_device_id(MOCK0_DEVICE_ID, &cfg0)
            .expect("open mock0");
        let unplugged_flag = Arc::new(AtomicBool::new(false));
        let unpluggable = UnpluggableTestChannel {
            inner: inner0,
            unplugged: Arc::clone(&unplugged_flag),
        };
        let handle0 = engine
            .spawn_connected_bus_handle(0, desc0, cfg0.clone(), Box::new(unpluggable), true)
            .expect("spawn bus 0");
        engine.buses.lock().insert(0, handle0);

        let cfg1 = ChannelConfigDto {
            bus_id: 1,
            listen_only: true,
            ..ChannelConfigDto::default()
        };
        let h1 = engine
            .cmd_connect_bus("mock:mock1".to_string(), cfg1)
            .expect("connect bus 1");
        assert!(h1.connected);

        // Register a periodic TX job on armed Bus 0 before unplugging
        let tx_res = engine
            .cmd_transmit_raw_frame(
                0,
                0x123,
                false,
                false,
                false,
                vec![0xAA, 0x55],
                Some(20),
                Some("Heartbeat".to_string()),
            )
            .expect("start periodic job on bus 0");
        assert!(tx_res.job_id.is_some());
        assert_eq!(engine.cmd_list_periodic_tx().len(), 1);

        // 2. Simulate physical USB unplug on Bus 0 while Bus 1 remains connected!
        unplugged_flag.store(true, Ordering::Release);

        // Wait briefly for `run_bus_io_loop` to observe `Err(AdapterError::ChannelClosed)`
        let deadline = Instant::now() + Duration::from_millis(200);
        while Instant::now() < deadline {
            let still_marked_connected = engine
                .buses
                .lock()
                .get(&0)
                .is_some_and(ConnectedBusHandle::is_connected);
            if !still_marked_connected {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }

        // 3. Reconnect Bus 0 immediately (simulating hot-replug + clicking Connect) ->
        //    MUST reap any dead handle, cancel the orphaned periodic TX job, keep Bus 1 alive,
        //    and succeed WITHOUT `BusAlreadyConnected(0)`!
        let reconnected = engine
            .cmd_connect_bus(MOCK0_DEVICE_ID.to_string(), cfg0)
            .expect("hot-replug cmd_connect_bus on bus 0 must NOT fail with BusAlreadyConnected");
        assert!(reconnected.connected);
        assert!(
            !reconnected.tx_armed,
            "reconnected bus must always start safely disarmed"
        );
        assert!(
            engine.cmd_list_periodic_tx().is_empty(),
            "periodic TX jobs from unplugged session must be purged"
        );
        assert!(
            engine
                .buses
                .lock()
                .get(&1)
                .is_some_and(ConnectedBusHandle::is_connected),
            "surviving Bus 1 must remain connected untouched"
        );

        engine.cmd_disconnect_all_buses();
    }
}

// =============================================================================
// OS-LEVEL USB HOTPLUG (`nusb::watch_devices()`) + TOPOLOGY MONITOR
// =============================================================================

const HOTPLUG_DEBOUNCE_MS: u64 = 200;
const HOTPLUG_FOLLOWUP_MS: u64 = 600;
const TOPOLOGY_POLL_MS: u64 = 2_500;

fn build_hardware_watch_event(registry: &DriverRegistry, reason: &str) -> HardwareWatchEventDto {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    let devices = registry.discover_all();
    let report = probe_all_drivers();
    HardwareWatchEventDto {
        reason: reason.to_string(),
        timestamp_ms,
        devices,
        report,
    }
}

fn run_usb_hotplug_listener(
    engine_stop: Arc<AtomicBool>,
    shutdown: Arc<HwWatchShutdown>,
    hotplug_epoch: Arc<AtomicU64>,
    pulse_tx: Sender<()>,
) {
    let Ok(mut watch) = nusb::watch_devices() else {
        return;
    };

    while !engine_stop.load(Ordering::Acquire) && !shutdown.is_stopped() {
        let next_evt = futures_lite::future::block_on(futures_lite::future::or(
            async { watch.next().await },
            std::future::poll_fn(|cx| {
                if shutdown.is_stopped() || engine_stop.load(Ordering::Acquire) {
                    std::task::Poll::Ready(None)
                } else {
                    *shutdown.waker.lock() = Some(cx.waker().clone());
                    if shutdown.is_stopped() || engine_stop.load(Ordering::Acquire) {
                        std::task::Poll::Ready(None)
                    } else {
                        std::task::Poll::Pending
                    }
                }
            }),
        ));

        let Some(evt) = next_evt else {
            break;
        };

        match evt {
            nusb::hotplug::HotplugEvent::Connected(_)
            | nusb::hotplug::HotplugEvent::Disconnected(_) => {
                hotplug_epoch.fetch_add(1, Ordering::AcqRel);
                let _ = pulse_tx.try_send(());
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_hardware_topology_watcher(
    engine_stop: Arc<AtomicBool>,
    stop_rx: Receiver<()>,
    pulse_rx: Receiver<()>,
    hotplug_epoch: Arc<AtomicU64>,
    registry: Arc<DriverRegistry>,
    buses: Arc<Mutex<BTreeMap<BusId, ConnectedBusHandle>>>,
    tx_scheduler: Arc<Mutex<TxScheduler>>,
    hw_bcast_tx: broadcast::Sender<HardwareWatchEventDto>,
    debug_hub: Arc<DebugEventHub>,
) {
    let mut last_fingerprint = compute_lightweight_topology_fingerprint();
    let mut debounce_deadline: Option<Instant> = None;
    let mut followup_deadline: Option<(Instant, u64)> = None;
    let mut next_poll_deadline = Instant::now() + Duration::from_millis(TOPOLOGY_POLL_MS);
    let mut pulse_alive = true;

    while !engine_stop.load(Ordering::Acquire) {
        let now = Instant::now();

        // 1. Fire 200ms debounced USB hotplug snapshot
        if let Some(dl) = debounce_deadline {
            if now >= dl {
                debounce_deadline = None;
                let _ = reap_dead_bus_handles(&buses, &tx_scheduler, &debug_hub);
                let epoch_at_emit = hotplug_epoch.load(Ordering::Acquire);
                let evt = build_hardware_watch_event(&registry, "usb_hotplug");
                debug_hub.record(
                    "info",
                    "CONN",
                    "os",
                    None,
                    "hw.usb_hotplug",
                    format!(
                        "OS USB hotplug change detected ({} CAN channel(s) discovered)",
                        evt.devices.len()
                    ),
                    None,
                );
                last_fingerprint = compute_lightweight_topology_fingerprint();
                let _ = hw_bcast_tx.send(evt);
                followup_deadline = Some((
                    Instant::now() + Duration::from_millis(HOTPLUG_FOLLOWUP_MS),
                    epoch_at_emit,
                ));
                continue;
            }
        }

        // 2. Fire +600ms delayed follow-up (catches Windows WCID/WinUSB or USB-CDC COMx creation)
        if let Some((fu_dl, expected_epoch)) = followup_deadline {
            if now >= fu_dl {
                followup_deadline = None;
                if debounce_deadline.is_none()
                    && hotplug_epoch.load(Ordering::Acquire) == expected_epoch
                {
                    let _ = reap_dead_bus_handles(&buses, &tx_scheduler, &debug_hub);
                    let evt = build_hardware_watch_event(&registry, "usb_hotplug");
                    last_fingerprint = compute_lightweight_topology_fingerprint();
                    let _ = hw_bcast_tx.send(evt);
                }
                continue;
            }
        }

        // 3. Fire 2,500ms lightweight non-invasive topology poll when fingerprint changes
        if now >= next_poll_deadline {
            next_poll_deadline = now + Duration::from_millis(TOPOLOGY_POLL_MS);
            if debounce_deadline.is_none() {
                let fp = compute_lightweight_topology_fingerprint();
                if fp != last_fingerprint {
                    let _ = reap_dead_bus_handles(&buses, &tx_scheduler, &debug_hub);
                    last_fingerprint = fp;
                    let evt = build_hardware_watch_event(&registry, "topology_poll");
                    debug_hub.record(
                        "info",
                        "CONN",
                        "os",
                        None,
                        "hw.topology_poll",
                        format!(
                            "Hardware topology delta detected ({} CAN channel(s) visible)",
                            evt.devices.len()
                        ),
                        None,
                    );
                    let _ = hw_bcast_tx.send(evt);
                }
            }
            continue;
        }

        // 4. Compute sleep window until earliest pending deadline
        let mut earliest = next_poll_deadline;
        if let Some(dl) = debounce_deadline {
            if dl < earliest {
                earliest = dl;
            }
        }
        if let Some((fu_dl, _)) = followup_deadline {
            if fu_dl < earliest {
                earliest = fu_dl;
            }
        }
        let wait = earliest.saturating_duration_since(Instant::now());

        if pulse_alive {
            select! {
                recv(stop_rx) -> _ => break,
                recv(pulse_rx) -> msg => {
                    match msg {
                        Ok(()) => {
                            while pulse_rx.try_recv().is_ok() {}
                            debounce_deadline = Some(Instant::now() + Duration::from_millis(HOTPLUG_DEBOUNCE_MS));
                            followup_deadline = None;
                        }
                        Err(_) => {
                            pulse_alive = false;
                        }
                    }
                }
                default(wait) => {}
            }
        } else if stop_rx.recv_timeout(wait).is_ok() {
            break;
        }
    }
}

/// Computes a deterministic, zero-device-open fingerprint of `(serial ports + Linux SocketCAN netdevs + USB topology)`.
fn compute_lightweight_topology_fingerprint() -> String {
    let mut out = String::with_capacity(512);

    // 1. Host Serial / USB-CDC ports (no port opened)
    if let Ok(mut ports) = serialport::available_ports() {
        ports.sort_by(|a, b| a.port_name.cmp(&b.port_name));
        for p in ports {
            match p.port_type {
                serialport::SerialPortType::UsbPort(u) => {
                    out.push_str(&format!(
                        "SER:{}:{:04X}:{:04X}:{}\n",
                        p.port_name,
                        u.vid,
                        u.pid,
                        u.serial_number.as_deref().unwrap_or("")
                    ));
                }
                other => {
                    out.push_str(&format!("SER:{}:{other:?}\n", p.port_name));
                }
            }
        }
    }

    // 2. Linux SocketCAN `/sys/class/net` interfaces & link states (`ARPHRD_CAN = 280`, no socket opened)
    #[cfg(target_os = "linux")]
    {
        if let Ok(entries) = fs::read_dir("/sys/class/net") {
            let mut net_rows: Vec<(String, String, String)> = Vec::new();
            for entry in entries.flatten() {
                let path = entry.path();
                let iface_type = fs::read_to_string(path.join("type")).unwrap_or_default();
                if iface_type.trim() == "280" {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let operstate = fs::read_to_string(path.join("operstate"))
                        .unwrap_or_default()
                        .trim()
                        .to_string();
                    let mtu = fs::read_to_string(path.join("mtu"))
                        .unwrap_or_default()
                        .trim()
                        .to_string();
                    net_rows.push((name, operstate, mtu));
                }
            }
            net_rows.sort_by(|a, b| a.0.cmp(&b.0));
            for (name, state, mtu) in net_rows {
                out.push_str(&format!("NET:{name}:{state}:{mtu}\n"));
            }
        }
    }

    // 3. Host USB topology (`nusb::list_devices()`, zero `dev.open()` handle opens!)
    if let Ok(iter) = nusb::list_devices() {
        let mut usb_rows: Vec<(String, String)> = Vec::new();
        for dev in iter {
            let (sort_key, _) = usb_device_location_info(&dev);
            #[cfg(target_os = "windows")]
            let drv = dev.driver().unwrap_or("").to_ascii_lowercase();
            #[cfg(target_os = "linux")]
            let drv = {
                let sysfs = dev.sysfs_path();
                let if0_drv = PathBuf::from(format!("{}:1.0/driver", sysfs.display()));
                fs::read_link(&if0_drv)
                    .or_else(|_| fs::read_link(sysfs.join("driver")))
                    .ok()
                    .and_then(|p| {
                        p.file_name()
                            .map(|n| n.to_string_lossy().to_ascii_lowercase())
                    })
                    .unwrap_or_default()
            };
            #[cfg(not(any(target_os = "linux", target_os = "windows")))]
            let drv = String::new();

            let line = format!(
                "USB:{sort_key}:{:04X}:{:04X}:{}:{}:{drv}\n",
                dev.vendor_id(),
                dev.product_id(),
                dev.bus_number(),
                dev.device_address(),
            );
            usb_rows.push((sort_key, line));
        }
        usb_rows.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        for (_, line) in usb_rows {
            out.push_str(&line);
        }
    }

    out
}

#[cfg(test)]
mod panic_abort_pending_tx_tests {
    use super::*;
    use crate::drivers::mock_drv::MOCK0_DEVICE_ID;
    use crate::traits::{AdapterCapabilities, BusHealthSnapshot, CanFilter};

    /// mock0 wrapper counting `abort_pending_tx` calls (and the calling thread).
    struct AbortCountingChannel {
        inner: Box<dyn CanChannel>,
        aborts: Arc<AtomicU32>,
        threads: Arc<Mutex<Vec<String>>>,
    }

    impl CanChannel for AbortCountingChannel {
        fn descriptor(&self) -> &DeviceDescriptor {
            self.inner.descriptor()
        }
        fn capabilities(&self) -> &AdapterCapabilities {
            self.inner.capabilities()
        }
        fn close(&mut self) -> Result<(), AdapterError> {
            self.inner.close()
        }
        fn recv_batch(
            &mut self,
            out_batch: &mut [RawCanFrame],
            timeout_ms: u32,
        ) -> Result<usize, AdapterError> {
            self.inner.recv_batch(out_batch, timeout_ms)
        }
        fn send_frame(&mut self, frame: &RawCanFrame) -> Result<(), AdapterError> {
            self.inner.send_frame(frame)
        }
        fn set_filters(&mut self, filters: &[CanFilter]) -> Result<(), AdapterError> {
            self.inner.set_filters(filters)
        }
        fn health(&self) -> BusHealthSnapshot {
            self.inner.health()
        }
        fn abort_pending_tx(&mut self) -> Result<(), AdapterError> {
            self.aborts.fetch_add(1, Ordering::SeqCst);
            self.threads
                .lock()
                .push(thread::current().name().unwrap_or("").to_string());
            Ok(())
        }
    }

    fn wait_count(c: &AtomicU32, want: u32) -> u32 {
        let deadline = Instant::now() + Duration::from_secs(2);
        while c.load(Ordering::SeqCst) < want && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(2));
        }
        // Settle: a double call would show up within a few loop iterations.
        thread::sleep(Duration::from_millis(60));
        c.load(Ordering::SeqCst)
    }

    #[test]
    fn panic_stop_calls_abort_pending_tx_exactly_once_per_panic() {
        let engine = PipelineEngine::new();
        let cfg = ChannelConfigDto {
            bus_id: 0,
            listen_only: false,
            mock_fps_preset: Some(500),
            ..ChannelConfigDto::default()
        };
        let (descriptor, inner) = engine
            .registry
            .open_by_device_id(MOCK0_DEVICE_ID, &cfg)
            .expect("open mock0");
        let aborts = Arc::new(AtomicU32::new(0));
        let threads = Arc::new(Mutex::new(Vec::new()));
        let chan = AbortCountingChannel {
            inner,
            aborts: Arc::clone(&aborts),
            threads: Arc::clone(&threads),
        };
        let handle = engine
            .spawn_connected_bus_handle(0, descriptor, cfg, Box::new(chan), true)
            .expect("spawn bus");
        engine.buses.lock().insert(0, handle);

        // No panic yet -> no call.
        assert_eq!(wait_count(&aborts, 1), 0);

        engine.cmd_panic_stop_tx();
        assert_eq!(wait_count(&aborts, 1), 1, "first Panic Stop");

        // Second Panic Stop while still latched -> one more call.
        engine.cmd_panic_stop_tx();
        assert_eq!(wait_count(&aborts, 2), 2, "second Panic Stop");

        // Clearing the latch never calls it.
        engine.cmd_clear_panic_latch();
        assert_eq!(wait_count(&aborts, 3), 2, "clear latch");

        // Latch again after a clear -> rising edge -> one call.
        engine.cmd_panic_stop_tx();
        assert_eq!(wait_count(&aborts, 3), 3, "panic after clear");

        // Always on the bus-io thread (the channel owner), never the command thread.
        let me = thread::current().name().unwrap_or("").to_string();
        assert!(
            threads.lock().iter().all(|t| *t != me),
            "{:?}",
            threads.lock()
        );
        engine.cmd_disconnect_all_buses();
    }

    #[test]
    fn watch_fires_once_even_if_epoch_seen_before_latch() {
        let latch = AtomicBool::new(false);
        let epoch = AtomicU64::new(0);
        let mut w = PanicAbortWatch::new(&latch, &epoch);
        assert!(!w.poll(&latch, &epoch));
        // Panic half-done (epoch bumped, latch not yet stored) observed by the io thread.
        epoch.fetch_add(1, Ordering::SeqCst);
        assert!(!w.poll(&latch, &epoch));
        latch.store(true, Ordering::SeqCst);
        assert!(w.poll(&latch, &epoch));
        assert!(!w.poll(&latch, &epoch));
        // Opened while latched: no spurious call.
        let w2 = &mut PanicAbortWatch::new(&latch, &epoch);
        assert!(!w2.poll(&latch, &epoch));
    }
}

/// C7: identity-matched TX-echo suppression in `run_bus_io_loop` (CANsub TX-ack / mock0 loopback).
#[cfg(test)]
mod echo_suppress_pipeline_tests {
    use super::echo_suppress::SUPPRESSED_ECHO_TIMEOUT_US;
    use super::*;
    use crate::drivers::cansub_drv::cansub_descriptor;
    use crate::drivers::mock_drv::MOCK0_DEVICE_ID;
    use crate::traits::{AdapterCapabilities, BusHealthSnapshot, CanFilter};
    use nexus_core::{FLAG_HW_TIMESTAMP, FLAG_TX};
    use std::collections::VecDeque;

    /// CANsub-like channel: TX succeeds, TX-acks are delivered only when the test injects them
    /// (a frame nobody ACKs on the bus never comes back).
    struct AckScriptChannel {
        desc: DeviceDescriptor,
        acks: Arc<Mutex<VecDeque<RawCanFrame>>>,
    }

    impl CanChannel for AckScriptChannel {
        fn descriptor(&self) -> &DeviceDescriptor {
            &self.desc
        }
        fn capabilities(&self) -> &AdapterCapabilities {
            &self.desc.capabilities
        }
        fn close(&mut self) -> Result<(), AdapterError> {
            Ok(())
        }
        fn recv_batch(
            &mut self,
            out: &mut [RawCanFrame],
            timeout_ms: u32,
        ) -> Result<usize, AdapterError> {
            let mut q = self.acks.lock();
            let mut n = 0;
            while n < out.len() {
                match q.pop_front() {
                    Some(f) => {
                        out[n] = f;
                        n += 1;
                    }
                    None => break,
                }
            }
            drop(q);
            if n == 0 {
                thread::sleep(Duration::from_millis(u64::from(timeout_ms)));
            }
            Ok(n)
        }
        fn send_frame(&mut self, _frame: &RawCanFrame) -> Result<(), AdapterError> {
            Ok(())
        }
        fn set_filters(&mut self, _filters: &[CanFilter]) -> Result<(), AdapterError> {
            Ok(())
        }
        fn health(&self) -> BusHealthSnapshot {
            BusHealthSnapshot::default()
        }
    }

    struct Harness {
        tx: Sender<TxDispatchRequest>,
        frames: Receiver<RawCanFrame>,
        stop: Arc<AtomicBool>,
        join: Option<JoinHandle<()>>,
        acks: Option<Arc<Mutex<VecDeque<RawCanFrame>>>>,
    }

    impl Harness {
        fn start(
            channel: Box<dyn CanChannel>,
            acks: Option<Arc<Mutex<VecDeque<RawCanFrame>>>>,
        ) -> Self {
            let (tx, tx_rx) = bounded::<TxDispatchRequest>(64);
            let (frame_tx, frames) = bounded::<RawCanFrame>(65_536);
            let stop = Arc::new(AtomicBool::new(false));
            let (_diag, diag_ctl_rx) = DiagBusShared::new();
            let s = Arc::clone(&stop);
            let join = thread::spawn(move || {
                let _diag = _diag;
                run_bus_io_loop(
                    0,
                    false,
                    channel,
                    tx_rx,
                    frame_tx,
                    Arc::new(AtomicU64::new(0)),
                    s,
                    Arc::new(AtomicBool::new(false)),
                    Arc::new(AtomicBool::new(true)),
                    Arc::new(AtomicBool::new(false)),
                    Arc::new(AtomicU64::new(0)),
                    Arc::new(AtomicU32::new(0)),
                    Arc::new(AtomicU8::new(0)),
                    Arc::new(AtomicU32::new(0)),
                    Arc::new(AtomicU32::new(0)),
                    diag_ctl_rx,
                    Arc::new(DebugEventHub::new_in_memory()),
                );
            });
            Self {
                tx,
                frames,
                stop,
                join: Some(join),
                acks,
            }
        }

        fn cansub() -> Self {
            let acks = Arc::new(Mutex::new(VecDeque::new()));
            let chan = AckScriptChannel {
                desc: cansub_descriptor("0123456789ab", "sim", 1, 1),
                acks: Arc::clone(&acks),
            };
            Self::start(Box::new(chan), Some(acks))
        }

        /// Sends through the io thread and waits until it was written (and echo bookkeeping done).
        fn send(&self, frame: RawCanFrame, suppress_echo: bool) {
            let (ack_tx, ack_rx) = bounded(1);
            self.tx
                .send(TxDispatchRequest {
                    frame,
                    ack: Some(ack_tx),
                    suppress_echo,
                    hw_tx_counter: None,
                    origin: TxOrigin::Other,
                    epoch: 0,
                })
                .expect("queue tx");
            ack_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("tx processed")
                .expect("tx ok");
        }

        /// Adapter delivers the TX-ack of `frame` (as CANsub does: `FLAG_TX | FLAG_HW_TIMESTAMP`).
        fn ack(&self, frame: RawCanFrame) {
            let mut echo = frame.with_flags(FLAG_TX | FLAG_HW_TIMESTAMP);
            echo.timestamp_us = now_monotonic_us().max(1);
            self.acks.as_ref().expect("scripted").lock().push_back(echo);
        }

        /// TX frames that reached the trace within `window`.
        fn trace_tx(&self, window: Duration) -> Vec<RawCanFrame> {
            let deadline = Instant::now() + window;
            let mut out = Vec::new();
            while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                match self.frames.recv_timeout(left) {
                    Ok(f) if f.is_tx() => out.push(f),
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            out
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(j) = self.join.take() {
                let _ = j.join();
            }
        }
    }

    fn frame(id: u32, data: &[u8]) -> RawCanFrame {
        let mut f = RawCanFrame::zeroed();
        f.arb_id = id;
        f.dlc = data.len() as u8;
        f.data[..data.len()].copy_from_slice(data);
        f
    }

    #[test]
    fn unacked_suppressed_frame_does_not_swallow_next_tx_ack() {
        let h = Harness::cansub();
        let replay = frame(0x100, &[1, 2, 3, 4]);
        let real = frame(0x200, &[9, 9]);
        h.send(replay, true); // never ACKed on the bus
        h.send(real, false);
        h.ack(real);
        let got = h.trace_tx(Duration::from_millis(150));
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0].arb_id, 0x200);
    }

    #[test]
    fn same_frame_sent_twice_both_acks_suppressed() {
        let h = Harness::cansub();
        let replay = frame(0x123, &[0xAA; 8]);
        h.send(replay, true);
        h.send(replay, true);
        h.ack(replay);
        h.ack(replay);
        let marker = frame(0x7FF, &[0x55]);
        h.send(marker, false);
        h.ack(marker);
        let got = h.trace_tx(Duration::from_millis(150));
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0].arb_id, 0x7FF);
    }

    #[test]
    fn late_ack_after_timeout_appears_once() {
        let h = Harness::cansub();
        let replay = frame(0x321, &[7; 3]);
        h.send(replay, true);
        thread::sleep(Duration::from_micros(SUPPRESSED_ECHO_TIMEOUT_US + 100_000));
        h.ack(replay);
        let got = h.trace_tx(Duration::from_millis(150));
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0].arb_id, 0x321);
    }

    /// mock0 behaviour unchanged: suppressed loopback hidden, normal loopback shown exactly once.
    #[test]
    fn mock_loopback_suppression_unchanged() {
        let registry = DriverRegistry::new();
        let cfg = ChannelConfigDto {
            bus_id: 0,
            listen_only: false,
            mock_fps_preset: Some(100),
            ..ChannelConfigDto::default()
        };
        let (_d, chan) = registry
            .open_by_device_id(MOCK0_DEVICE_ID, &cfg)
            .expect("open mock0");
        let h = Harness::start(chan, None);
        h.send(frame(0x5A0, &[1]), true);
        h.send(frame(0x5A1, &[2]), false);
        let got = h.trace_tx(Duration::from_millis(150));
        let ids: Vec<u32> = got.iter().map(|f| f.arb_id).collect();
        assert_eq!(ids, vec![0x5A1]);
    }
}
