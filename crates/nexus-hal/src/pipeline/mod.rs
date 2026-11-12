//! Multi-bus 60Hz Telemetry Pipeline Engine (`PipelineEngine`), safety interlocks,
//! preset/custom `.dbc` & `.kcd` database management, persistent `.nexusproj.json` project storage,
//! cross-OS driver diagnostics, and all 20 IPC command handlers.

pub mod blf;
pub mod diag_discovery;
pub mod diag_session;
pub mod diag_tap;
pub mod replay;
pub mod state_table;
pub mod tx_scheduler;

use crate::drivers::probe::probe_all_drivers;
use crate::dto::{
    BusHealthDto, ChannelConfigDto, ChronologicalFrameDto, DbFileInputDto, DeviceDescriptorDto,
    DriverProbeReportDto, LoadedTraceFileDto, PanicStopResultDto, PeriodicTxJobDto,
    ProjectSummaryDto, ResetSessionResultDto, StartTraceReplayArgsDto, TelemetrySnapshotDto, TraceFileSummaryDto,
    TraceReplayControlArgsDto, TraceReplayStatusDto, TraceStorageInfoDto, TxTransmitResultDto,
};
use crate::error::{AdapterError, HalError};
use crate::registry::DriverRegistry;
use crate::traits::{BusState, CanChannel, DeviceDescriptor, ListenOnlyEnforcement};
use diag_tap::{DiagBusShared, GateRefs, TapCtl, TapRegisterError, TapTable, TxOrigin};
use nexus_protocols::uds::dto::{DiagError, DiagErrorCode};
use nexus_protocols::uds::port::{DiagPortEvent, DiagTapFilter, DiagTxReject};
use base64::engine::general_purpose::{STANDARD as BASE64_STD, STANDARD_NO_PAD as BASE64_NO_PAD};
use base64::Engine as _;
use crossbeam_channel::{bounded, Receiver, Sender, TrySendError};
use nexus_core::{now_monotonic_us, BusId, CanIdKey, RawCanFrame};
use nexus_netdb::{
    merge_databases, CompiledDatabase, DatabaseInfoDto, DatabaseSchemaDto, DbError, FormatRegistry,
    NetworkDatabase, ParseOptions,
};
use parking_lot::{Mutex, RwLock};
use crate::storage::{
    check_frame_count, check_ipc_size, DataRoot, MAX_DB_FILES_PER_CALL, MAX_IPC_CONTENT_BYTES,
    MAX_IPC_DB_TOTAL_BYTES, MAX_LISTED_ENTRIES, MAX_PROJECT_FILE_BYTES,
};
use replay::{
    compile_chronological_frames, delete_trace_file, list_trace_files, load_trace_file_cached,
    parse_trace_bytes, parse_trace_entries_from_bytes, read_trace_file_bytes, sanitize_trace_filename,
    save_trace_file_bytes_cached, ReplayController, TraceStatsCache,
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
            listen_only_enforcement: self
                .listen_only_enforcement
                .map(|e| e.as_str().to_string()),
        }
    }

    #[inline]
    fn fd_enabled(&self) -> bool {
        self.config.enable_fd && self.descriptor.capabilities.supports_fd
    }

    fn nominal_capacity_bps(&self) -> u64 {
        if self.config.enable_fd && self.descriptor.capabilities.supports_fd {
            u64::from(self.config.data_bitrate.max(self.config.bitrate).max(500_000))
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

/// Core NexusCAN multi-bus pipeline engine shared by both `src-tauri` and `nexus_bridge`.
pub struct PipelineEngine {
    registry: DriverRegistry,
    /// WP-8: persistent `projects/` + `traces/` locations (see [`crate::storage`]).
    data_root: DataRoot,
    /// WP-8: frame-count cache so `cmd_list_traces` never parses file bodies.
    trace_stats: TraceStatsCache,
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
    engine_stop: Arc<AtomicBool>,
    snapshot_bcast_tx: broadcast::Sender<TelemetrySnapshotDto>,
    latest_snapshot: Arc<RwLock<Option<TelemetrySnapshotDto>>>,
    aggregator_join: Mutex<Option<JoinHandle<()>>>,
    scheduler_join: Mutex<Option<JoinHandle<()>>>,
    /// D-003 diag session manager (`cmd_diag_*`), see [`diag_session`].
    diag_sessions: diag_session::DiagSessionMap,
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

        let buses: Arc<Mutex<BTreeMap<BusId, ConnectedBusHandle>>> =
            Arc::new(Mutex::new(BTreeMap::new()));
        let tx_scheduler = Arc::new(Mutex::new(TxScheduler::new()));
        let dropped_frames = Arc::new(AtomicU64::new(0));
        let tx_panic_latched = Arc::new(AtomicBool::new(false));
        let tx_epoch = Arc::new(AtomicU64::new(0));
        let engine_stop = Arc::new(AtomicBool::new(false));
        let latest_snapshot = Arc::new(RwLock::new(None));

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
                );
            })
            .expect("failed to spawn nexus-aggregator-60hz thread");

        let sched_stop = Arc::clone(&engine_stop);
        let sched_panic = Arc::clone(&tx_panic_latched);
        let sched_epoch = Arc::clone(&tx_epoch);
        let sched_buses = Arc::clone(&buses);
        let sched_table = Arc::clone(&tx_scheduler);

        let scheduler_handle = thread::Builder::new()
            .name("nexus-tx-scheduler".to_string())
            .spawn(move || {
                run_tx_scheduler_loop(sched_stop, sched_panic, sched_epoch, sched_buses, sched_table);
            })
            .expect("failed to spawn nexus-tx-scheduler thread");

        Self {
            registry,
            data_root,
            trace_stats: TraceStatsCache::default(),
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
            engine_stop,
            snapshot_bcast_tx,
            latest_snapshot,
            aggregator_join: Mutex::new(Some(aggregator_handle)),
            scheduler_join: Mutex::new(Some(scheduler_handle)),
            diag_sessions: diag_session::DiagSessionMap::default(),
        }
    }

    /// Subscribes to the 60Hz [`TelemetrySnapshotDto`] broadcast stream.
    pub fn subscribe(&self) -> broadcast::Receiver<TelemetrySnapshotDto> {
        self.snapshot_bcast_tx.subscribe()
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
        let deadline = Instant::now() + TX_QUIESCE_TIMEOUT;
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
                TX_QUIESCE_TIMEOUT.as_millis()
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
        let bus = guard.get(&bus_id).ok_or(HalError::BusNotConnected(bus_id))?;
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
        self.registry.discover_all()
    }

    /// 2. `cmd_connect_bus` -> Opens a CAN / CAN-FD channel and starts its zero-alloc reader thread.
    pub fn cmd_connect_bus(
        &self,
        device_id: String,
        config: ChannelConfigDto,
    ) -> Result<BusHealthDto, HalError> {
        let bus_id = config.bus_id;
        {
            let guard = self.buses.lock();
            if guard.contains_key(&bus_id) {
                return Err(HalError::BusAlreadyConnected(bus_id));
            }
        }

        let (descriptor, channel) = self.registry.open_by_device_id(&device_id, &config)?;
        let handle =
            self.spawn_connected_bus_handle(bus_id, descriptor, config, channel, false)?;

        let dto = handle.to_health_dto();
        self.buses.lock().insert(bus_id, handle);
        Ok(dto)
    }

    /// 3. `cmd_disconnect_bus` -> Stops periodic TX on `bus_id` and cleanly closes the channel (`< 25ms`).
    pub fn cmd_disconnect_bus(&self, bus_id: u8) -> Result<(), HalError> {
        self.tx_scheduler.lock().remove_jobs_for_bus(bus_id);

        let mut handle = self
            .buses
            .lock()
            .remove(&bus_id)
            .ok_or(HalError::BusNotConnected(bus_id))?;

        handle.shutdown();
        let _ = self.ctrl_tx.try_send(AggregatorControl::ClearBus(bus_id));
        Ok(())
    }

    /// 4. `cmd_arm_active_bus` -> Arms or disarms active TX on `bus_id`, enforcing `Listen-Only` lock.
    pub fn cmd_arm_active_bus(&self, bus_id: u8, armed: bool) -> Result<BusHealthDto, HalError> {
        let guard = self.buses.lock();
        let bus = guard.get(&bus_id).ok_or(HalError::BusNotConnected(bus_id))?;

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
    }

    /// Atomically transitions an ALREADY-CONNECTED `bus_id` between `Listen-Only` and `Active TX`
    /// while strictly preserving its bound `descriptor.device_id` (e.g. `"socketcan:vcan0"`) and
    /// existing `StateTable` RX history.
    ///
    /// Never opens a fallback or `mock0` device: returns `Err(HalError::BusNotConnected(bus_id))`
    /// if `bus_id` is not currently connected.
    pub fn cmd_set_bus_mode(
        &self,
        bus_id: u8,
        listen_only: bool,
        arm_tx: bool,
    ) -> Result<BusHealthDto, HalError> {
        let target_armed = arm_tx && !listen_only;
        // A Panic Stop / reset that lands while the channel is reopened bumps the epoch.
        let epoch_at_start = self.tx_epoch.load(Ordering::SeqCst);

        {
            let guard = self.buses.lock();
            let bus = guard.get(&bus_id).ok_or(HalError::BusNotConnected(bus_id))?;
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
        self.tx_scheduler.lock().remove_jobs_for_bus(bus_id);

        let mut old_handle = self
            .buses
            .lock()
            .remove(&bus_id)
            .ok_or(HalError::BusNotConnected(bus_id))?;

        let exact_device_id = old_handle.descriptor.device_id.clone();
        let mut updated_config = old_handle.config.clone();
        updated_config.bus_id = bus_id;
        updated_config.listen_only = listen_only;

        // Cleanly close the existing handle WITHOUT sending AggregatorControl::ClearBus(bus_id)
        // so captured RX frames on this bus remain visible in StateTable!
        old_handle.shutdown();

        let (descriptor, channel) = self
            .registry
            .open_by_device_id(&exact_device_id, &updated_config)?;

        // WP-4: a Panic Stop may have landed while the channel was reopened; never come back
        // armed in that case (the bus is reconnected disarmed instead).
        let target_armed = target_armed && !self.tx_panic_latched.load(Ordering::SeqCst);

        let new_handle = self.spawn_connected_bus_handle(
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
        if self.tx_epoch.load(Ordering::SeqCst) != epoch_at_start
            || self.tx_panic_latched.load(Ordering::SeqCst)
        {
            new_handle.tx_armed.store(false, Ordering::SeqCst);
        }
        let dto = new_handle.to_health_dto();
        guard.insert(bus_id, new_handle);
        Ok(dto)
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

        ResetSessionResultDto {
            stopped_periodic_jobs,
            disarmed_buses,
            disconnected_buses,
            in_flight_timeout_buses,
        }
    }

    /// WP-2: `cmd_seedkey_capabilities` (native seed/key providers are never allowed in v0.1).
    pub fn cmd_seedkey_capabilities(
        &self,
    ) -> nexus_protocols::uds::security::SeedKeyCapabilitiesDto {
        crate::seedkey::capabilities()
    }

    /// WP-2: `cmd_seedkey_compute_adhoc` (portable providers only). BLOCKING: call it from
    /// `spawn_blocking` (Tauri) / a blocking task (bridge).
    pub fn cmd_seedkey_compute_adhoc(
        &self,
        provider: &nexus_protocols::uds::security::KeyProviderSpecDto,
        level: u8,
        seed_hex: &str,
    ) -> Result<
        nexus_protocols::uds::security::ComputeKeyResultDto,
        nexus_protocols::uds::security::SeedKeyError,
    > {
        crate::seedkey::compute_adhoc(provider, level, seed_hex)
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

        Ok(schema)
    }

    /// 7. `cmd_get_current_schema` -> Returns the currently loaded Plane 1 `DatabaseSchemaDto`, if any.
    pub fn cmd_get_current_schema(&self) -> Option<DatabaseSchemaDto> {
        self.db_state.read().as_ref().map(|s| s.schema.clone())
    }

    /// 8. `cmd_load_database_content` -> Decodes Base64 `.dbc` / `.kcd` bytes, compiles, and binds to `StateTable`.
    pub fn cmd_load_database_content(
        &self,
        file_name: String,
        content_base64: String,
        append_to_existing: bool,
    ) -> Result<DatabaseSchemaDto, HalError> {
        check_ipc_size("Database content", content_base64.len(), MAX_IPC_CONTENT_BYTES)?;
        let raw_bytes = decode_base64_db_bytes(&content_base64)?;

        let registry = FormatRegistry::new();
        let bundle = registry.parse_bytes(&raw_bytes, Some(&file_name), &ParseOptions::default())?;

        let existing_raw = if append_to_existing {
            self.db_state
                .read()
                .as_ref()
                .map(|st| st.raw_database.clone())
        } else {
            None
        };

        let (target_raw, format_str, source_enc, diagnostics) =
            if let Some(prev_raw) = existing_raw {
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

        Ok(schema)
    }

    /// Stateless `.dbc` / `.kcd` parser & compiler returning `DatabaseSchemaDto` for the UI catalog
    /// without mutating `db_state`, `bus_db_states`, or `StateTable`.
    pub fn cmd_parse_database_schema(
        &self,
        file_name: String,
        content_base64: String,
    ) -> Result<DatabaseSchemaDto, HalError> {
        check_ipc_size("Database content", content_base64.len(), MAX_IPC_CONTENT_BYTES)?;
        let raw_bytes = decode_base64_db_bytes(&content_base64)?;
        let bundle =
            FormatRegistry::new().parse_bytes(&raw_bytes, Some(&file_name), &ParseOptions::default())?;

        let message_count = bundle.database.messages.len();
        let signal_count = bundle.database.messages.values().map(|m| m.signals.len()).sum();
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
            check_ipc_size("Database content", f.content_base64.len(), MAX_IPC_CONTENT_BYTES)?;
            total_len = total_len.saturating_add(f.content_base64.len());
        }
        check_ipc_size("Combined database content", total_len, MAX_IPC_DB_TOTAL_BYTES)?;

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
            let bus = guard.get(&bus_id).ok_or(HalError::BusNotConnected(bus_id))?;
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
                Some(self.register_periodic_job_checked(
                    bus_id, label, can_id, ms, tx_frame, epoch,
                )?)
            }
            _ => None,
        };

        Ok(TxTransmitResultDto {
            job_id,
            encoded_dlc,
            encoded_bytes,
            clamped_signals,
        })
    }

    /// 11. `cmd_stop_periodic_tx` -> Stops an active periodic TX job by `job_id`.
    pub fn cmd_stop_periodic_tx(&self, job_id: u64) -> Result<(), HalError> {
        self.tx_scheduler.lock().stop_job(job_id)
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
            let bus = guard.get(&bus_id).ok_or(HalError::BusNotConnected(bus_id))?;
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
                Some(self.register_periodic_job_checked(
                    bus_id, label, can_id, ms, tx_frame, epoch,
                )?)
            }
            _ => None,
        };

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
        probe_all_drivers()
    }

    /// 15. `cmd_clear_database` -> Clears any loaded `.dbc`/`.kcd` schema and resets live signal decoding in `StateTable`.
    pub fn cmd_clear_database(&self) -> Result<(), HalError> {
        *self.db_state.write() = None;
        self.bus_db_states.write().clear();
        let _ = self.ctrl_tx.send(AggregatorControl::SetDatabase(None));
        let _ = self.ctrl_tx.send(AggregatorControl::ClearAllBusDatabases);
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

        Ok(ProjectSummaryDto {
            file_stem: safe_stem,
            name,
            updated_at,
            size_bytes: project_json.len() as u64,
        })
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
        String::from_utf8(raw).map_err(|_| {
            HalError::InvalidInput(format!("Project '{safe_stem}' is not valid UTF-8"))
        })
    }

    /// 20. `cmd_delete_project` -> Deletes `<projects>/<safe_stem>.nexusproj.json` (symlinks refused).
    pub fn cmd_delete_project(&self, file_stem: String) -> Result<(), HalError> {
        let (safe_stem, target_path) = self.project_path(&file_stem, true)?;
        if !crate::storage::is_regular_file(&target_path) {
            return Err(HalError::InvalidInput(format!(
                "Project '{safe_stem}' does not exist in projects directory"
            )));
        }
        crate::storage::remove_regular_file(&target_path)
    }

    /// 21. `cmd_reset_telemetry` -> Resets `StateTable` (`Receive` rows, `Trace` ring, and RX/TX counters)
    ///     without disconnecting buses, cancelling periodic TX jobs, or clearing the loaded database.
    pub fn cmd_reset_telemetry(&self) -> Result<(), HalError> {
        self.ctrl_tx
            .send(AggregatorControl::ResetAll)
            .map_err(|_| HalError::InvalidInput("Aggregator thread stopped".to_string()))?;
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
        if let Some(b64) = content_base64.as_deref().filter(|s| !s.trim().is_empty()) {
            let raw_bytes = decode_base64_trace_bytes(b64)?;
            save_trace_file_bytes_cached(traces_dir, &file_name, &raw_bytes, Some(&self.trace_stats))
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
        }
    }

    /// 24. `cmd_load_trace_file` -> Loads and parses `./traces/<safe_name>` into `LoadedTraceFileDto`.
    pub fn cmd_load_trace_file(&self, file_name: String) -> Result<LoadedTraceFileDto, HalError> {
        load_trace_file_cached(self.data_root.traces_dir(), &file_name, Some(&self.trace_stats))
    }

    /// 25. `cmd_delete_trace_file` -> Deletes `./traces/<safe_name>`.
    pub fn cmd_delete_trace_file(&self, file_name: String) -> Result<(), HalError> {
        let res = delete_trace_file(self.data_root.traces_dir(), &file_name);
        if res.is_ok() {
            if let Ok(safe) = sanitize_trace_filename(&file_name) {
                self.trace_stats.forget(&safe);
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
            } else if let Some(b64) =
                args.content_base64.as_ref().filter(|c| !c.trim().is_empty())
            {
                let name_hint = resolve_name_hint("inline_trace.blf");
                let raw_bytes = decode_base64_trace_bytes(b64)?;
                (
                    parse_trace_entries_from_bytes(&name_hint, &raw_bytes)?,
                    name_hint,
                )
            } else if let Some(content) = args.content.as_ref().filter(|c| !c.trim().is_empty())
            {
                let name_hint = resolve_name_hint("inline_trace.trc");
                (
                    parse_trace_entries_from_bytes(&name_hint, content.as_bytes())?,
                    name_hint,
                )
            } else if let Some(fname) = args.file_name.as_ref().filter(|s| !s.trim().is_empty())
            {
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

        self.replay.start_compiled(source_name, entries, &args)
    }

    /// 28. `cmd_control_trace_replay` -> Controls active playback (`pause`, `resume`, `stop`, `seek`, `configure`).
    pub fn cmd_control_trace_replay(
        &self,
        args: TraceReplayControlArgsDto,
    ) -> Result<TraceReplayStatusDto, HalError> {
        self.replay.control(args)
    }

    /// 29. `cmd_export_trace_blf` -> Encodes `ChronologicalFrameDto` records into a zlib-compressed
    ///     standard Vector `.blf` binary file and returns Base64-encoded bytes.
    pub fn cmd_export_trace_blf(
        &self,
        _file_name: String,
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
        let blf_bytes = blf::encode_blf_bytes(&entries)?;
        Ok(BASE64_STD.encode(&blf_bytes))
    }
}

impl Drop for PipelineEngine {
    fn drop(&mut self) {
        // Stop UDS sessions (keepalive threads) before their buses go away.
        self.diag_sessions.clear();
        self.engine_stop.store(true, Ordering::Release);
        self.replay.shutdown();
        {
            let mut buses = self.buses.lock();
            for bus in buses.values_mut() {
                bus.shutdown();
            }
            buses.clear();
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
        DiagTxReject::PanicLatched => AdapterError::Driver(format!(
            "Bus {bus_id} TX blocked: Panic Stop is latched"
        )),
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
) {
    #[cfg(any(test, feature = "test-hooks"))]
    {
        let hook = *BUS_IO_THREAD_START_HOOK.lock();
        if let Some(hook) = hook {
            hook();
        }
    }

    let gate = GateRefs {
        listen_only,
        tx_armed,
        panic_latched: tx_panic_latched,
        tx_epoch,
    };
    let mut rx_batch = [RawCanFrame::zeroed(); 256];
    let mut taps = TapTable::new();
    let mut tick_counter = 0u32;
    let driver_has_self_loopback = channel.descriptor().driver_id == "mock";
    let mut pending_suppressed_mock_echoes = 0usize;

    while !bus_stop.load(Ordering::Acquire) && !engine_stop.load(Ordering::Acquire) {
        // 0. Cold path: diag tap add/remove.
        taps.apply_ctl(&diag_ctl_rx);

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
                        pending_suppressed_mock_echoes =
                            pending_suppressed_mock_echoes.saturating_add(1);
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
                    if pending_suppressed_mock_echoes > 0 && frame.is_tx() {
                        pending_suppressed_mock_echoes -= 1;
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
            Err(AdapterError::ChannelClosed) => break,
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
        }
    }

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
) {
    let mut state_table = StateTable::new();
    let tick_duration = Duration::from_micros(SNAPSHOT_INTERVAL_US);
    let mut next_tick = Instant::now() + tick_duration;

    while !engine_stop.load(Ordering::Acquire) {
        // 1. Apply pending control commands
        while let Ok(ctrl) = ctrl_rx.try_recv() {
            match ctrl {
                AggregatorControl::SetDatabase(db_opt) => state_table.set_database(db_opt),
                AggregatorControl::SetBusDatabase(bus_id, db_opt) => {
                    state_table.set_bus_database(bus_id, db_opt);
                }
                AggregatorControl::ClearAllBusDatabases => state_table.clear_all_bus_databases(),
                AggregatorControl::ClearBus(bus_id) => state_table.clear_bus(bus_id),
                AggregatorControl::ResetAll => {
                    while frame_rx.try_recv().is_ok() {}
                    state_table.reset_all();
                    dropped_frames.store(0, Ordering::Relaxed);
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
                    while let Ok(f) = frame_rx.try_recv() {
                        state_table.ingest_frame(&f);
                    }
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
        let mut drained = 0usize;
        while drained < 16_384 {
            match frame_rx.try_recv() {
                Ok(frame) => {
                    state_table.ingest_frame(&frame);
                    drained += 1;
                }
                Err(_) => break,
            }
        }

        // 3. Check 60Hz (16.667ms) snapshot deadline
        let now = Instant::now();
        if now >= next_tick {
            while let Ok(frame) = frame_rx.try_recv() {
                state_table.ingest_frame(&frame);
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
            }
        }
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

fn run_tx_scheduler_loop(
    engine_stop: Arc<AtomicBool>,
    tx_panic_latched: Arc<AtomicBool>,
    tx_epoch: Arc<AtomicU64>,
    buses: Arc<Mutex<BTreeMap<BusId, ConnectedBusHandle>>>,
    tx_scheduler: Arc<Mutex<TxScheduler>>,
) {
    while !engine_stop.load(Ordering::Acquire) {
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
        check_ipc_size("TX job label", label.len(), crate::storage::MAX_TX_JOB_LABEL_BYTES)?;
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
        for bad in ["../evil", "..", ".", "", "  ", ".dot", "a..b", "a/b", "a\\b", "CON"] {
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
        assert!(engine.cmd_parse_database_schema("big.dbc".into(), big).is_err());
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
        fs::write(traces.join("garbage.asc"), b"\x00\xffnot a trace at all\x01").unwrap();
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
        let known = listed.files.iter().find(|f| f.file_name == "known.trc").unwrap();
        assert!(known.stats_known);
        assert_eq!(known.frame_count, 2);
        assert_eq!(known.duration_us, 25_000);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(traces.join("locked.trc"), fs::Permissions::from_mode(0o600));
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
        assert_eq!(dir_snapshot(&traces), before, "open/parse must not write to disk");
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
        let _ = engine.cmd_transmit_raw_frame(0, 0x321, false, false, false, vec![0x11], None, None);
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
            assert!(r.completed.lock().is_empty(), "the blocking write is still running");
            r.release.send(()).expect("release driver");
        });
        r.engine.cmd_disconnect_bus(0).expect("disconnect");
    }

    #[test]
    fn disarm_waits_for_in_flight_write_and_reports_timeout() {
        let r = rig(Duration::from_secs(3));
        thread::scope(|s| {
            s.spawn(|| one_shot(&r.engine));
            r.entered.recv_timeout(Duration::from_secs(2)).expect("blocked");
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

        // Blocking driver: disarm still disarms, but reports the stuck write.
        r.engine.cmd_arm_active_bus(0, true).expect("re-arm");
        thread::scope(|s| {
            s.spawn(|| one_shot(&r.engine));
            r.entered.recv_timeout(Duration::from_secs(2)).expect("blocked");
            let err = r
                .engine
                .cmd_arm_active_bus(0, false)
                .expect_err("stuck write must be reported");
            assert!(err.to_string().contains(TX_IN_FLIGHT_TIMEOUT_PREFIX), "{err}");
            assert!(!r.engine.buses.lock()[&0].tx_armed.load(Ordering::SeqCst));
            r.release.send(()).expect("release");
        });
        r.engine.cmd_disconnect_bus(0).expect("disconnect");
    }

    #[test]
    fn request_queued_before_disarm_never_reaches_driver_after_fast_rearm() {
        let r = rig(Duration::from_secs(3));
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
        r.entered.recv_timeout(Duration::from_secs(2)).expect("A blocked in driver");
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
            let res = done_rx.recv_timeout(Duration::from_secs(2)).expect("disarm returns");
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
        assert!(t0.elapsed() < Duration::from_millis(5));
    }
}
