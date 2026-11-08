//! Multi-bus 60Hz Telemetry Pipeline Engine (`PipelineEngine`), safety interlocks,
//! preset/custom `.dbc` & `.kcd` database management, persistent `.nexusproj.json` project storage,
//! cross-OS driver diagnostics, and all 20 IPC command handlers.

pub mod blf;
pub mod replay;
pub mod state_table;
pub mod tx_scheduler;

use crate::drivers::probe::probe_all_drivers;
use crate::dto::{
    BusHealthDto, ChannelConfigDto, ChronologicalFrameDto, DbFileInputDto, DeviceDescriptorDto,
    DriverProbeReportDto, LoadedTraceFileDto, PanicStopResultDto, PeriodicTxJobDto,
    ProjectSummaryDto, StartTraceReplayArgsDto, TelemetrySnapshotDto, TraceFileSummaryDto,
    TraceReplayControlArgsDto, TraceReplayStatusDto, TraceStorageInfoDto, TxTransmitResultDto,
};
use crate::error::{AdapterError, HalError};
use crate::registry::DriverRegistry;
use crate::traits::{BusState, CanChannel, DeviceDescriptor};
use base64::engine::general_purpose::{STANDARD as BASE64_STD, STANDARD_NO_PAD as BASE64_NO_PAD};
use base64::Engine as _;
use crossbeam_channel::{bounded, Receiver, Sender, TrySendError};
use nexus_core::{now_monotonic_us, BusId, CanIdKey, RawCanFrame};
use nexus_netdb::{
    merge_databases, CompiledDatabase, DatabaseInfoDto, DatabaseSchemaDto, DbError, FormatRegistry,
    NetworkDatabase, ParseOptions,
};
use parking_lot::{Mutex, RwLock};
use replay::{
    compile_chronological_frames, delete_trace_file, list_trace_files, load_trace_file,
    parse_trace_bytes, parse_trace_entries_from_bytes, sanitize_trace_filename, save_trace_file,
    save_trace_file_bytes, ReplayController,
};
use state_table::StateTable;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
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
}

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
}

impl ConnectedBusHandle {
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
        }
    }

    fn nominal_capacity_bps(&self) -> u64 {
        if self.config.enable_fd && self.descriptor.capabilities.supports_fd {
            u64::from(self.config.data_bitrate.max(self.config.bitrate).max(500_000))
        } else {
            u64::from(self.config.bitrate.max(125_000))
        }
    }

    fn shutdown(&mut self) {
        self.stop_flag.store(true, Ordering::Release);
        self.tx_armed.store(false, Ordering::Release);
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
    projects_dir: PathBuf,
    traces_dir: PathBuf,
    buses: Arc<Mutex<BTreeMap<BusId, ConnectedBusHandle>>>,
    db_state: RwLock<Option<LoadedDatabaseState>>,
    bus_db_states: RwLock<BTreeMap<BusId, Option<LoadedDatabaseState>>>,
    tx_scheduler: Arc<Mutex<TxScheduler>>,
    replay: Arc<ReplayController>,
    frame_tx: Sender<RawCanFrame>,
    ctrl_tx: Sender<AggregatorControl>,
    dropped_frames: Arc<AtomicU64>,
    tx_panic_latched: Arc<AtomicBool>,
    engine_stop: Arc<AtomicBool>,
    snapshot_bcast_tx: broadcast::Sender<TelemetrySnapshotDto>,
    latest_snapshot: Arc<RwLock<Option<TelemetrySnapshotDto>>>,
    aggregator_join: Mutex<Option<JoinHandle<()>>>,
    scheduler_join: Mutex<Option<JoinHandle<()>>>,
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

    /// Creates a [`PipelineEngine`] with a custom [`DriverRegistry`].
    pub fn with_registry(registry: DriverRegistry) -> Self {
        Self::with_storage_dirs(registry, locate_projects_dir(), locate_traces_dir())
    }

    /// Creates a [`PipelineEngine`] with an explicit persistent `./projects` directory path.
    pub fn with_projects_dir(registry: DriverRegistry, projects_dir: PathBuf) -> Self {
        Self::with_storage_dirs(registry, projects_dir, locate_traces_dir())
    }

    /// Creates a [`PipelineEngine`] with explicit persistent `./projects` and `./traces` directories.
    pub fn with_storage_dirs(
        registry: DriverRegistry,
        projects_dir: PathBuf,
        traces_dir: PathBuf,
    ) -> Self {
        let _ = fs::create_dir_all(&traces_dir);

        let (frame_tx, frame_rx) = bounded::<RawCanFrame>(FRAME_RING_CAPACITY);
        let (ctrl_tx, ctrl_rx) = bounded::<AggregatorControl>(64);
        let (snapshot_bcast_tx, _) = broadcast::channel::<TelemetrySnapshotDto>(128);

        let buses: Arc<Mutex<BTreeMap<BusId, ConnectedBusHandle>>> =
            Arc::new(Mutex::new(BTreeMap::new()));
        let tx_scheduler = Arc::new(Mutex::new(TxScheduler::new()));
        let dropped_frames = Arc::new(AtomicU64::new(0));
        let tx_panic_latched = Arc::new(AtomicBool::new(false));
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
        let sched_buses = Arc::clone(&buses);
        let sched_table = Arc::clone(&tx_scheduler);

        let scheduler_handle = thread::Builder::new()
            .name("nexus-tx-scheduler".to_string())
            .spawn(move || {
                run_tx_scheduler_loop(sched_stop, sched_panic, sched_buses, sched_table);
            })
            .expect("failed to spawn nexus-tx-scheduler thread");

        Self {
            registry,
            projects_dir,
            traces_dir,
            buses,
            db_state: RwLock::new(None),
            bus_db_states: RwLock::new(BTreeMap::new()),
            tx_scheduler,
            replay,
            frame_tx,
            ctrl_tx,
            dropped_frames,
            tx_panic_latched,
            engine_stop,
            snapshot_bcast_tx,
            latest_snapshot,
            aggregator_join: Mutex::new(Some(aggregator_handle)),
            scheduler_join: Mutex::new(Some(scheduler_handle)),
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
                    io_state,
                    io_tx_err,
                    io_rx_err,
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
        })
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
            bus.tx_armed.store(true, Ordering::Release);
            self.tx_panic_latched.store(false, Ordering::Release);
        } else {
            bus.tx_armed.store(false, Ordering::Release);
            drop(guard);
            self.tx_scheduler.lock().remove_jobs_for_bus(bus_id);
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

        {
            let guard = self.buses.lock();
            let bus = guard.get(&bus_id).ok_or(HalError::BusNotConnected(bus_id))?;
            if bus.listen_only == listen_only {
                bus.tx_armed.store(target_armed, Ordering::Release);
                if target_armed {
                    self.tx_panic_latched.store(false, Ordering::Release);
                    return Ok(bus.to_health_dto());
                }
                drop(guard);
                self.tx_scheduler.lock().remove_jobs_for_bus(bus_id);
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

        if target_armed {
            self.tx_panic_latched.store(false, Ordering::Release);
        }

        let new_handle = self.spawn_connected_bus_handle(
            bus_id,
            descriptor,
            updated_config,
            channel,
            target_armed,
        )?;
        let dto = new_handle.to_health_dto();
        self.buses.lock().insert(bus_id, new_handle);
        Ok(dto)
    }

    /// 5. `cmd_panic_stop_tx` -> Emergency stop: cancels all periodic TX jobs, disarms replay hardware TX, and disarms every bus.
    pub fn cmd_panic_stop_tx(&self) -> PanicStopResultDto {
        self.tx_panic_latched.store(true, Ordering::Release);
        self.replay.disarm_hardware_tx();
        let stopped_periodic_jobs = self.tx_scheduler.lock().clear_all();

        let mut disarmed_buses = 0usize;
        {
            let guard = self.buses.lock();
            for bus in guard.values() {
                if bus.tx_armed.swap(false, Ordering::AcqRel) {
                    disarmed_buses += 1;
                }
            }
        }

        PanicStopResultDto {
            stopped_periodic_jobs,
            disarmed_buses,
            timestamp_us: now_monotonic_us(),
        }
    }

    /// 6. `cmd_load_preset_databases` -> Parses & merges `scripts/sample_vehicle.dbc` + `scripts/sample_bms.kcd`.
    pub fn cmd_load_preset_databases(&self) -> Result<DatabaseSchemaDto, HalError> {
        let scripts_dir = locate_preset_scripts_dir()?;
        let dbc_path = scripts_dir.join("sample_vehicle.dbc");
        let kcd_path = scripts_dir.join("sample_bms.kcd");

        let dbc_bytes = fs::read(&dbc_path).map_err(|e| {
            HalError::InvalidInput(format!(
                "Failed to read preset DBC '{}': {e}",
                dbc_path.display()
            ))
        })?;
        let kcd_bytes = fs::read(&kcd_path).map_err(|e| {
            HalError::InvalidInput(format!(
                "Failed to read preset KCD '{}': {e}",
                kcd_path.display()
            ))
        })?;

        let registry = FormatRegistry::new();
        let opts = ParseOptions::default();
        let dbc_bundle = registry.parse_bytes(&dbc_bytes, Some("sample_vehicle.dbc"), &opts)?;
        let kcd_bundle = registry.parse_bytes(&kcd_bytes, Some("sample_bms.kcd"), &opts)?;

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

    /// Reads `scripts/sample_vehicle.dbc` and `scripts/sample_bms.kcd` as Base64 `DbFileInputDto`
    /// items for populating the multi-database catalog without mutating `StateTable`.
    pub fn cmd_get_preset_database_files(&self) -> Result<Vec<DbFileInputDto>, HalError> {
        let scripts_dir = locate_preset_scripts_dir()?;
        let dbc_path = scripts_dir.join("sample_vehicle.dbc");
        let kcd_path = scripts_dir.join("sample_bms.kcd");

        let dbc_bytes = fs::read(&dbc_path).map_err(|e| {
            HalError::InvalidInput(format!(
                "Failed to read preset DBC '{}': {e}",
                dbc_path.display()
            ))
        })?;
        let kcd_bytes = fs::read(&kcd_path).map_err(|e| {
            HalError::InvalidInput(format!(
                "Failed to read preset KCD '{}': {e}",
                kcd_path.display()
            ))
        })?;

        Ok(vec![
            DbFileInputDto {
                file_name: "sample_vehicle.dbc".to_string(),
                content_base64: BASE64_STD.encode(&dbc_bytes),
            },
            DbFileInputDto {
                file_name: "sample_bms.kcd".to_string(),
                content_base64: BASE64_STD.encode(&kcd_bytes),
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
        if self.tx_panic_latched.load(Ordering::Acquire) {
            return Err(HalError::SafetyLock(
                "TX Panic Stop is latched; explicitly re-arm the target bus before transmitting"
                    .to_string(),
            ));
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
                    self.tx_scheduler
                        .lock()
                        .register_job(label, bus_id, can_id, ms, tx_frame),
                )
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
        if self.tx_panic_latched.load(Ordering::Acquire) {
            return Err(HalError::SafetyLock(
                "TX Panic Stop is latched; explicitly re-arm the target bus before transmitting"
                    .to_string(),
            ));
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
                    self.tx_scheduler
                        .lock()
                        .register_job(label, bus_id, can_id, ms, tx_frame),
                )
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

    /// 17. `cmd_list_projects` -> Scans `./projects/*.nexusproj.json` (creating `./projects` if missing),
    ///     extracts summary metadata, and returns entries sorted descending by `updated_at`.
    pub fn cmd_list_projects(&self) -> Result<Vec<ProjectSummaryDto>, HalError> {
        fs::create_dir_all(&self.projects_dir)
            .map_err(|e| HalError::Adapter(AdapterError::Io(e)))?;

        let entries = fs::read_dir(&self.projects_dir)
            .map_err(|e| HalError::Adapter(AdapterError::Io(e)))?;

        let mut summaries = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let file_name = entry.file_name().to_string_lossy().to_string();
            let Some(raw_stem) = file_name.strip_suffix(".nexusproj.json") else {
                continue;
            };
            let safe_stem = sanitize_project_stem(raw_stem);

            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let size_bytes = meta.len();
            let fallback_updated = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| format!("{}", d.as_secs()))
                .unwrap_or_else(|| "0".to_string());

            let (name, updated_at) = match fs::read_to_string(&path)
                .ok()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            {
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

    /// 18. `cmd_save_project` -> Sanitizes `file_stem` against path traversal, validates `project_json` as a JSON object,
    ///     writes `./projects/<safe_stem>.nexusproj.json`, and returns its [`ProjectSummaryDto`].
    pub fn cmd_save_project(
        &self,
        file_stem: String,
        project_json: String,
    ) -> Result<ProjectSummaryDto, HalError> {
        fs::create_dir_all(&self.projects_dir)
            .map_err(|e| HalError::Adapter(AdapterError::Io(e)))?;

        let safe_stem = sanitize_project_stem(&file_stem);
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

        let target_path = self.projects_dir.join(format!("{safe_stem}.nexusproj.json"));
        fs::write(&target_path, project_json.as_bytes())
            .map_err(|e| HalError::Adapter(AdapterError::Io(e)))?;

        Ok(ProjectSummaryDto {
            file_stem: safe_stem,
            name,
            updated_at,
            size_bytes: project_json.len() as u64,
        })
    }

    /// 19. `cmd_load_project` -> Reads `./projects/<safe_stem>.nexusproj.json` and returns raw JSON string.
    pub fn cmd_load_project(&self, file_stem: String) -> Result<String, HalError> {
        let safe_stem = sanitize_project_stem(&file_stem);
        let target_path = self.projects_dir.join(format!("{safe_stem}.nexusproj.json"));
        if !target_path.is_file() {
            return Err(HalError::InvalidInput(format!(
                "Project '{safe_stem}' does not exist in projects directory"
            )));
        }
        fs::read_to_string(&target_path).map_err(|e| HalError::Adapter(AdapterError::Io(e)))
    }

    /// 20. `cmd_delete_project` -> Deletes `./projects/<safe_stem>.nexusproj.json`.
    pub fn cmd_delete_project(&self, file_stem: String) -> Result<(), HalError> {
        let safe_stem = sanitize_project_stem(&file_stem);
        let target_path = self.projects_dir.join(format!("{safe_stem}.nexusproj.json"));
        if !target_path.is_file() {
            return Err(HalError::InvalidInput(format!(
                "Project '{safe_stem}' does not exist in projects directory"
            )));
        }
        fs::remove_file(&target_path).map_err(|e| HalError::Adapter(AdapterError::Io(e)))
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
    pub fn cmd_list_traces(&self) -> Result<TraceStorageInfoDto, HalError> {
        list_trace_files(&self.traces_dir)
    }

    /// 23. `cmd_save_trace_file` -> Sanitizes `file_name` and persists either binary `content_base64` (e.g. `.blf`)
    ///     or UTF-8 `content` inside `./traces/`.
    pub fn cmd_save_trace_file(
        &self,
        file_name: String,
        content: Option<String>,
        content_base64: Option<String>,
    ) -> Result<TraceFileSummaryDto, HalError> {
        if let Some(b64) = content_base64.as_deref().filter(|s| !s.trim().is_empty()) {
            let raw_bytes = decode_base64_trace_bytes(b64)?;
            save_trace_file_bytes(&self.traces_dir, &file_name, &raw_bytes)
        } else if let Some(text) = content {
            save_trace_file(&self.traces_dir, &file_name, &text)
        } else {
            Err(HalError::InvalidInput(
                "Trace kaydında oynatılacak çerçeve bulunamadı".to_string(),
            ))
        }
    }

    /// 24. `cmd_load_trace_file` -> Loads and parses `./traces/<safe_name>` into `LoadedTraceFileDto`.
    pub fn cmd_load_trace_file(&self, file_name: String) -> Result<LoadedTraceFileDto, HalError> {
        load_trace_file(&self.traces_dir, &file_name)
    }

    /// 25. `cmd_delete_trace_file` -> Deletes `./traces/<safe_name>`.
    pub fn cmd_delete_trace_file(&self, file_name: String) -> Result<(), HalError> {
        delete_trace_file(&self.traces_dir, &file_name)
    }

    /// 26. `cmd_parse_trace_content` -> Statelessly parses binary `content_base64` (`.blf`) or text `content`
    ///     (`.trc`, `.asc`, `.log`, `.csv`) into `LoadedTraceFileDto`.
    pub fn cmd_parse_trace_content(
        &self,
        file_name: String,
        content: Option<String>,
        content_base64: Option<String>,
    ) -> Result<LoadedTraceFileDto, HalError> {
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
            if let Some(ref frames) = args.frames.as_ref().filter(|f| !f.is_empty()) {
                (
                    compile_chronological_frames(frames),
                    "In-Memory Trace".to_string(),
                )
            } else if let Some(ref b64) =
                args.content_base64.as_ref().filter(|c| !c.trim().is_empty())
            {
                let name_hint = resolve_name_hint("inline_trace.blf");
                let raw_bytes = decode_base64_trace_bytes(b64)?;
                (
                    parse_trace_entries_from_bytes(&name_hint, &raw_bytes)?,
                    name_hint,
                )
            } else if let Some(ref content) = args.content.as_ref().filter(|c| !c.trim().is_empty())
            {
                let name_hint = resolve_name_hint("inline_trace.trc");
                (
                    parse_trace_entries_from_bytes(&name_hint, content.as_bytes())?,
                    name_hint,
                )
            } else if let Some(ref fname) = args.file_name.as_ref().filter(|s| !s.trim().is_empty())
            {
                let safe_name = sanitize_trace_filename(fname);
                let target_path = self.traces_dir.join(&safe_name);
                if !target_path.is_file() {
                    return Err(HalError::InvalidInput(format!(
                        "Trace file '{safe_name}' does not exist in traces directory"
                    )));
                }
                let raw_bytes =
                    fs::read(&target_path).map_err(|e| HalError::Adapter(AdapterError::Io(e)))?;
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
    bus_state: Arc<AtomicU8>,
    tx_errors: Arc<AtomicU32>,
    rx_errors: Arc<AtomicU32>,
) {
    let mut rx_batch = [RawCanFrame::zeroed(); 256];
    let mut tick_counter = 0u32;
    let driver_has_self_loopback = channel.descriptor().driver_id == "mock";
    let mut pending_suppressed_mock_echoes = 0usize;

    while !bus_stop.load(Ordering::Acquire) && !engine_stop.load(Ordering::Acquire) {
        // 1. Drain outbound TX requests immediately
        while let Ok(req) = tx_rx.try_recv() {
            let res = if listen_only {
                Err(AdapterError::ListenOnlyMode)
            } else if !tx_armed.load(Ordering::Acquire) {
                Err(AdapterError::Driver(format!(
                    "Bus {bus_id} TX is disarmed"
                )))
            } else {
                let send_res = channel.send_frame(&req.frame);
                if send_res.is_ok() {
                    if let Some(ref counter) = req.hw_tx_counter {
                        counter.fetch_add(1, Ordering::Relaxed);
                    }
                    if driver_has_self_loopback && req.suppress_echo {
                        pending_suppressed_mock_echoes =
                            pending_suppressed_mock_echoes.saturating_add(1);
                    } else if !driver_has_self_loopback && !req.suppress_echo {
                        let mut tx_echo = req.frame.with_flags(nexus_core::FLAG_TX);
                        tx_echo.bus_id = bus_id;
                        if tx_echo.timestamp_us == 0 {
                            tx_echo.timestamp_us = now_monotonic_us().max(1);
                        }
                        let _ = frame_tx.try_send(tx_echo);
                    }
                }
                send_res
            };
            if let Some(ack) = req.ack {
                let _ = ack.send(res);
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
    buses: Arc<Mutex<BTreeMap<BusId, ConnectedBusHandle>>>,
    tx_scheduler: Arc<Mutex<TxScheduler>>,
) {
    while !engine_stop.load(Ordering::Acquire) {
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
                    if !bus.listen_only && bus.tx_armed.load(Ordering::Acquire) {
                        let _ = bus.tx_sender.try_send(TxDispatchRequest {
                            frame,
                            ack: None,
                            suppress_echo: false,
                            hw_tx_counter: None,
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

fn locate_preset_scripts_dir() -> Result<PathBuf, HalError> {
    let manifest_scripts = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts");
    let mut candidates = vec![
        manifest_scripts,
        PathBuf::from("scripts"),
        PathBuf::from("../scripts"),
        PathBuf::from("../../scripts"),
    ];

    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent();
        for _ in 0..5 {
            if let Some(dir) = cur {
                candidates.push(dir.join("scripts"));
                cur = dir.parent();
            }
        }
    }

    for dir in candidates {
        if dir.join("sample_vehicle.dbc").is_file() && dir.join("sample_bms.kcd").is_file() {
            return Ok(dir);
        }
    }

    Err(HalError::InvalidInput(
        "Could not locate preset databases 'scripts/sample_vehicle.dbc' and 'scripts/sample_bms.kcd'"
            .to_string(),
    ))
}

/// Sanitizes an arbitrary project stem to `[a-zA-Z0-9_-]`, strictly eliminating `..`, `/`, and `\` path traversal.
pub fn sanitize_project_stem(raw: &str) -> String {
    let trimmed = raw
        .trim()
        .strip_suffix(".nexusproj.json")
        .or_else(|| raw.trim().strip_suffix(".json"))
        .unwrap_or_else(|| raw.trim());

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
        "untitled_project".to_string()
    } else {
        cleaned.to_string()
    }
}

fn locate_projects_dir() -> PathBuf {
    if let Ok(scripts_dir) = locate_preset_scripts_dir() {
        if let Some(workspace_root) = scripts_dir.parent() {
            return workspace_root.join("projects");
        }
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("projects")
}

fn locate_traces_dir() -> PathBuf {
    if let Ok(scripts_dir) = locate_preset_scripts_dir() {
        if let Some(workspace_root) = scripts_dir.parent() {
            return workspace_root.join("traces");
        }
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("traces")
}

