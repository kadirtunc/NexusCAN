//! Zero-allocation hot-path `StateTable` aggregating 1k–50k+ fps CAN / CAN-FD streams into
//! 60Hz `TelemetrySnapshotDto` frames with EMA cycle timing, 64-byte 300ms change masks,
//! and PCAN-Explorer style dynamic on-arrival multi-row Multiplexed & Cascaded Mux state.

use crate::dto::{
    BusHealthDto, ChronologicalFrameDto, FrameTelemetryDto, LiveSignalDto, TelemetrySnapshotDto,
};
use indexmap::IndexMap;
use nexus_core::{estimate_frame_wire_bits, BusId, CanIdKey, RawCanFrame};
use nexus_netdb::{CompiledDatabase, DecodedSignalSample, SignalId};
use rustc_hash::FxHashMap;
use smallvec::SmallVec;
use std::cmp::Ordering;
use std::collections::hash_map::Entry;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

/// Duration (`300,000 us` = `300 ms`) during which a modified payload byte remains highlighted.
pub const BYTE_HIGHLIGHT_WINDOW_US: u64 = 300_000;

const NEVER_CHANGED_US: u64 = u64::MAX;

/// Per-snapshot (16.67ms @ 60Hz) chronological ring capacity (`2,048 * 60 = 122,880 fps` sustain!).
pub const CHRONOLOGICAL_RING_CAP: usize = 2_048;

/// Full `u8` (`0..=255` -> `Bus 1 .. Bus 256`) O(1) per-bus database slot table capacity.
pub const MAX_BUS_SLOTS: usize = 256;

/// Stack-allocated cascaded multiplexer switch path (`Copy`, zero heap allocation on hot path).
/// `len == 0` for non-multiplexed or raw (unbound) frames; `len == 1..=8` for 1..8-level cascaded muxes.
#[derive(Clone, Copy, Debug, Default)]
pub struct MuxPathKey {
    pub len: u8,
    pub pairs: [(SignalId, i64); 8],
}

impl MuxPathKey {
    /// Builds a [`MuxPathKey`] from up to 8 `(SignalId, switch_value)` pairs in outer-to-inner order.
    #[inline]
    pub fn from_switches(switches: &[(SignalId, i64)]) -> Self {
        let mut pairs = [(0, 0); 8];
        let count = switches.len().min(8);
        pairs[..count].copy_from_slice(&switches[..count]);
        Self {
            len: count as u8,
            pairs,
        }
    }

    /// Returns the active outer-to-inner `(SignalId, i64)` slice (`0..=8` entries).
    #[inline]
    pub fn as_slice(&self) -> &[(SignalId, i64)] {
        let n = usize::from(self.len).min(8);
        &self.pairs[..n]
    }

    /// Returns `true` when this key represents a non-multiplexed or unbound Raw Hex row.
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl PartialEq for MuxPathKey {
    #[inline]
    fn eq(&self, other: &Self) -> bool {
        self.as_slice() == other.as_slice()
    }
}

impl Eq for MuxPathKey {}

impl Hash for MuxPathKey {
    #[inline]
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.as_slice().hash(state);
    }
}

impl PartialOrd for MuxPathKey {
    #[inline]
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for MuxPathKey {
    #[inline]
    fn cmp(&self, other: &Self) -> Ordering {
        self.as_slice().cmp(other.as_slice())
    }
}

/// Retained signal slot preserving the most recent decoded engineering value for a row.
#[derive(Clone, Copy, Debug)]
pub struct RetainedSignalSlot {
    pub raw_int: i64,
    pub physical_value: f64,
    pub out_of_range: bool,
    pub last_updated_us: u64,
    pub active_in_last_frame: bool,
}

/// Live state tracked dynamically on arrival per `(BusId, CanIdKey, MuxPathKey)`.
#[derive(Clone, Debug)]
struct MessageLiveState {
    bus_id: BusId,
    can_id: CanIdKey,
    message_key: String,
    dlc: u8,
    flags: u8,
    data: [u8; 64],
    has_prev_data: bool,
    byte_last_changed_us: [u64; 64],
    last_timestamp_us: u64,
    smoothed_cycle_ms: f64,
    rx_count: u64,
    active_switches: SmallVec<[(SignalId, i64); 8]>,
    retained_signals: FxHashMap<SignalId, RetainedSignalSlot>,
}

impl MessageLiveState {
    fn new(bus_id: BusId, can_id: CanIdKey) -> Self {
        Self {
            bus_id,
            can_id,
            message_key: can_id.schema_key(),
            dlc: 0,
            flags: 0,
            data: [0u8; 64],
            has_prev_data: false,
            byte_last_changed_us: [NEVER_CHANGED_US; 64],
            last_timestamp_us: 0,
            smoothed_cycle_ms: 0.0,
            rx_count: 0,
            active_switches: SmallVec::new(),
            retained_signals: FxHashMap::default(),
        }
    }

    #[inline]
    fn compute_changed_masks(&self, now_us: u64) -> (u32, u32) {
        let mut lo = 0u32;
        let mut hi = 0u32;
        let active_len = usize::from(self.dlc.min(64));

        for i in 0..active_len.min(32) {
            let changed_at = self.byte_last_changed_us[i];
            if changed_at != NEVER_CHANGED_US
                && now_us.saturating_sub(changed_at) <= BYTE_HIGHLIGHT_WINDOW_US
            {
                lo |= 1u32 << i;
            }
        }

        if active_len > 32 {
            for i in 32..active_len {
                let changed_at = self.byte_last_changed_us[i];
                if changed_at != NEVER_CHANGED_US
                    && now_us.saturating_sub(changed_at) <= BYTE_HIGHLIGHT_WINDOW_US
                {
                    hi |= 1u32 << (i - 32);
                }
            }
        }

        (lo, hi)
    }
}

/// Fixed-capacity ring buffer of recent frames (`2,048` slots = `160 KB` allocated once on startup,
/// zero stack bloat and zero hot-path allocations during `push`).
struct ChronologicalRing {
    buf: Box<[RawCanFrame]>,
    write_idx: usize,
    pending_count: usize,
}

impl ChronologicalRing {
    fn new() -> Self {
        Self {
            buf: vec![RawCanFrame::zeroed(); CHRONOLOGICAL_RING_CAP].into_boxed_slice(),
            write_idx: 0,
            pending_count: 0,
        }
    }

    #[inline]
    fn push(&mut self, frame: RawCanFrame) {
        self.buf[self.write_idx] = frame;
        self.write_idx = (self.write_idx + 1) % CHRONOLOGICAL_RING_CAP;
        if self.pending_count < CHRONOLOGICAL_RING_CAP {
            self.pending_count += 1;
        }
    }

    fn drain_to_dtos(&mut self) -> Vec<ChronologicalFrameDto> {
        let count = self.pending_count;
        if count == 0 {
            return Vec::new();
        }

        let start = (self.write_idx + CHRONOLOGICAL_RING_CAP - count) % CHRONOLOGICAL_RING_CAP;
        let mut out = Vec::with_capacity(count);
        for offset in 0..count {
            let idx = (start + offset) % CHRONOLOGICAL_RING_CAP;
            let f = &self.buf[idx];
            let can_id = f.can_id_key();
            out.push(ChronologicalFrameDto {
                timestamp_us: f.timestamp_us,
                bus_id: f.bus_id,
                message_key: can_id.schema_key(),
                arb_id: can_id.raw_id(),
                is_extended: f.is_extended(),
                is_fd: f.is_fd(),
                is_tx: f.is_tx(),
                dlc: f.dlc,
                raw_bytes: f.payload().to_vec(),
            });
        }

        self.pending_count = 0;
        out
    }

    #[inline]
    fn clear(&mut self) {
        self.write_idx = 0;
        self.pending_count = 0;
    }
}

/// Real-time telemetry state table owned exclusively by the 60Hz aggregator thread.
///
/// Rows are created dynamically **only on frame arrival** per `(BusId, CanIdKey, MuxPathKey)` —
/// multiplexer branches are never pre-populated before traffic arrives on the bus.
pub struct StateTable {
    messages: FxHashMap<(BusId, CanIdKey, MuxPathKey), MessageLiveState>,
    chronological: ChronologicalRing,
    database: Option<Arc<CompiledDatabase>>,
    bus_databases: [Option<Option<Arc<CompiledDatabase>>>; MAX_BUS_SLOTS],
    seq: u64,
    total_frames_rx: u64,
    total_frames_tx: u64,
    window_rx_frames: u64,
    window_tx_frames: u64,
    window_wire_bits: u64,
    last_snapshot_us: u64,
    smoothed_fps_rx: f64,
    smoothed_fps_tx: f64,
}

impl Default for StateTable {
    fn default() -> Self {
        Self::new()
    }
}

impl StateTable {
    /// Creates an empty [`StateTable`].
    pub fn new() -> Self {
        Self {
            messages: FxHashMap::default(),
            chronological: ChronologicalRing::new(),
            database: None,
            bus_databases: std::array::from_fn(|_| None),
            seq: 0,
            total_frames_rx: 0,
            total_frames_tx: 0,
            window_rx_frames: 0,
            window_tx_frames: 0,
            window_wire_bits: 0,
            last_snapshot_us: 0,
            smoothed_fps_rx: 0.0,
            smoothed_fps_tx: 0.0,
        }
    }

    /// Binds or replaces the legacy global [`CompiledDatabase`] and re-keys / re-decodes already-arrived
    /// frame entries on buses that do not have an explicit per-bus database override.
    pub fn set_database(&mut self, database: Option<Arc<CompiledDatabase>>) {
        self.database = database;
        self.rekey_and_redecode_entries(None);
    }

    /// Binds an explicit per-bus [`CompiledDatabase`] (`Some(db)`) or explicitly unbinds `bus_id`
    /// (`None`, keeping frames strictly Raw Hex), immediately re-keying and re-decoding any
    /// already-arrived entries on `bus_id`.
    pub fn set_bus_database(&mut self, bus_id: BusId, db: Option<Arc<CompiledDatabase>>) {
        let slot = usize::from(bus_id);
        if slot >= self.bus_databases.len() {
            return;
        }
        self.bus_databases[slot] = Some(db);
        self.rekey_and_redecode_entries(Some(bus_id));
    }

    /// Clears all per-bus database overrides and re-keys / re-evaluates already-arrived entries across all buses.
    pub fn clear_all_bus_databases(&mut self) {
        self.bus_databases = std::array::from_fn(|_| None);
        self.rekey_and_redecode_entries(None);
    }

    fn rekey_and_redecode_entries(&mut self, filter_bus: Option<BusId>) {
        let keys_to_rekey: Vec<(BusId, CanIdKey, MuxPathKey)> = self
            .messages
            .keys()
            .copied()
            .filter(|&(b, _, _)| filter_bus.is_none_or(|target| b == target))
            .collect();

        if keys_to_rekey.is_empty() {
            return;
        }

        let mut decoded_buf = [DecodedSignalSample {
            signal_id: 0,
            raw_bits: 0,
            raw_int: 0,
            physical_value: 0.0,
            out_of_range: false,
            is_mux_switch: false,
        }; 128];
        let mut switch_buf = [(0u32, 0i64); 16];

        let mut drained = Vec::with_capacity(keys_to_rekey.len());
        for key in keys_to_rekey {
            if let Some(state) = self.messages.remove(&key) {
                drained.push(state);
            }
        }

        for mut state in drained {
            state.retained_signals.clear();
            state.active_switches.clear();

            let effective_db =
                resolve_effective_db(&self.database, &self.bus_databases, state.bus_id);

            let mut new_mux_path = MuxPathKey::default();
            if let Some(db) = effective_db {
                if state.rx_count > 0 {
                    let mut cached = RawCanFrame::zeroed();
                    cached.timestamp_us = state.last_timestamp_us;
                    cached.arb_id = state.can_id.raw_id();
                    cached.bus_id = state.bus_id;
                    cached.dlc = state.dlc;
                    cached.flags = state.flags;
                    cached.data = state.data;

                    if let Some(summary) =
                        db.decode_frame_into(&cached, &mut decoded_buf, &mut switch_buf)
                    {
                        new_mux_path =
                            MuxPathKey::from_switches(&switch_buf[..summary.active_switch_count]);
                        for sample in &decoded_buf[..summary.decoded_count] {
                            state.retained_signals.insert(
                                sample.signal_id,
                                RetainedSignalSlot {
                                    raw_int: sample.raw_int,
                                    physical_value: sample.physical_value,
                                    out_of_range: sample.out_of_range,
                                    last_updated_us: cached.timestamp_us,
                                    active_in_last_frame: true,
                                },
                            );
                        }
                        for &sw in &switch_buf[..summary.active_switch_count] {
                            state.active_switches.push(sw);
                        }
                    }
                }
            }

            let target_key = (state.bus_id, state.can_id, new_mux_path);
            match self.messages.entry(target_key) {
                Entry::Vacant(vacant) => {
                    vacant.insert(state);
                }
                Entry::Occupied(mut occupied) => {
                    let existing = occupied.get_mut();
                    let combined_rx_count = existing.rx_count.saturating_add(state.rx_count);
                    if state.last_timestamp_us >= existing.last_timestamp_us {
                        let mut newer = state;
                        newer.rx_count = combined_rx_count;
                        *existing = newer;
                    } else {
                        existing.rx_count = combined_rx_count;
                    }
                }
            }
        }
    }

    /// Returns a reference to the currently bound [`CompiledDatabase`], if any.
    pub fn database(&self) -> Option<&Arc<CompiledDatabase>> {
        self.database.as_ref()
    }

    /// Clears telemetry entries associated with a specific `bus_id` if desired.
    pub fn clear_bus(&mut self, bus_id: BusId) {
        self.messages.retain(|&(b, _, _), _| b != bus_id);
    }

    /// Resets all accumulated message rows, chronological trace frames, and RX/TX rate counters
    /// while preserving any bound `.dbc` / `.kcd` [`CompiledDatabase`].
    pub fn reset_all(&mut self) {
        self.messages.clear();
        self.chronological.clear();
        self.total_frames_rx = 0;
        self.total_frames_tx = 0;
        self.window_rx_frames = 0;
        self.window_tx_frames = 0;
        self.window_wire_bits = 0;
        self.smoothed_fps_rx = 0.0;
        self.smoothed_fps_tx = 0.0;
    }

    /// Ingests a single [`RawCanFrame`] on the hot path without per-frame String/Vec allocations.
    ///
    /// Decodes `.dbc`/`.kcd` signals into stack-allocated buffers first to derive the zero-alloc
    /// [`MuxPathKey`], dynamically creating or updating strictly the matching `(bus_id, can_id, mux_path)`
    /// row on arrival.
    #[inline]
    pub fn ingest_frame(&mut self, frame: &RawCanFrame) {
        let wire_bits = estimate_frame_wire_bits(frame.dlc, frame.is_extended(), frame.is_fd());
        self.window_wire_bits = self.window_wire_bits.saturating_add(u64::from(wire_bits));

        self.chronological.push(*frame);

        if frame.is_tx() {
            self.total_frames_tx = self.total_frames_tx.wrapping_add(1);
            self.window_tx_frames = self.window_tx_frames.wrapping_add(1);
        } else {
            self.total_frames_rx = self.total_frames_rx.wrapping_add(1);
            self.window_rx_frames = self.window_rx_frames.wrapping_add(1);
        }

        let can_id = frame.can_id_key();

        let mut decoded_buf = [DecodedSignalSample {
            signal_id: 0,
            raw_bits: 0,
            raw_int: 0,
            physical_value: 0.0,
            out_of_range: false,
            is_mux_switch: false,
        }; 128];
        let mut switch_buf = [(0u32, 0i64); 16];

        let decode_summary = resolve_effective_db(&self.database, &self.bus_databases, frame.bus_id)
            .and_then(|db| db.decode_frame_into(frame, &mut decoded_buf, &mut switch_buf));

        let mux_path = match decode_summary {
            Some(ref summary) => {
                MuxPathKey::from_switches(&switch_buf[..summary.active_switch_count])
            }
            None => MuxPathKey::default(),
        };

        let key = (frame.bus_id, can_id, mux_path);
        let state = self
            .messages
            .entry(key)
            .or_insert_with(|| MessageLiveState::new(frame.bus_id, can_id));

        // 1. Update EMA inter-arrival cycle time for this specific mux branch / CAN ID
        if state.rx_count > 0 && frame.timestamp_us >= state.last_timestamp_us {
            let dt_ms = (frame.timestamp_us - state.last_timestamp_us) as f64 / 1_000.0;
            if state.rx_count == 1 {
                state.smoothed_cycle_ms = dt_ms;
            } else {
                state.smoothed_cycle_ms = 0.85 * state.smoothed_cycle_ms + 0.15 * dt_ms;
            }
        }
        state.last_timestamp_us = frame.timestamp_us;
        state.rx_count = state.rx_count.wrapping_add(1);

        // 2. Update 64-byte diff timestamps (300ms highlight window) against this branch's previous payload
        let new_len = usize::from(frame.dlc.min(64));
        if state.has_prev_data {
            let cmp_len = new_len.max(usize::from(state.dlc.min(64)));
            for i in 0..cmp_len {
                if frame.data[i] != state.data[i] {
                    state.byte_last_changed_us[i] = frame.timestamp_us;
                }
            }
        }
        state.data = frame.data;
        state.dlc = frame.dlc;
        state.flags = frame.flags;
        state.has_prev_data = true;

        // 3. Populate decoded signals & active mux switches strictly for this branch
        if let Some(summary) = decode_summary {
            state.retained_signals.clear();
            for sample in &decoded_buf[..summary.decoded_count] {
                state.retained_signals.insert(
                    sample.signal_id,
                    RetainedSignalSlot {
                        raw_int: sample.raw_int,
                        physical_value: sample.physical_value,
                        out_of_range: sample.out_of_range,
                        last_updated_us: frame.timestamp_us,
                        active_in_last_frame: true,
                    },
                );
            }

            state.active_switches.clear();
            for &sw in &switch_buf[..summary.active_switch_count] {
                state.active_switches.push(sw);
            }
        }
    }

    /// Builds a deterministic 60Hz [`TelemetrySnapshotDto`] at `now_us`.
    pub fn build_snapshot(
        &mut self,
        now_us: u64,
        dropped_frames: u64,
        tx_panic_latched: bool,
        nominal_bus_capacity_bps: u64,
        buses: Vec<BusHealthDto>,
    ) -> TelemetrySnapshotDto {
        self.seq = self.seq.wrapping_add(1);

        let dt_us = if self.last_snapshot_us == 0 {
            16_667
        } else {
            now_us.saturating_sub(self.last_snapshot_us).max(1)
        };
        let dt_sec = (dt_us as f64) / 1_000_000.0;
        self.last_snapshot_us = now_us;

        let inst_rx_fps = (self.window_rx_frames as f64) / dt_sec;
        let inst_tx_fps = (self.window_tx_frames as f64) / dt_sec;

        if self.seq == 1 || (self.smoothed_fps_rx < 1.0 && inst_rx_fps > 0.0) {
            self.smoothed_fps_rx = inst_rx_fps;
        } else {
            self.smoothed_fps_rx = 0.70 * self.smoothed_fps_rx + 0.30 * inst_rx_fps;
        }

        if self.seq == 1 || (self.smoothed_fps_tx < 0.5 && inst_tx_fps > 0.0) {
            self.smoothed_fps_tx = inst_tx_fps;
        } else {
            self.smoothed_fps_tx = 0.70 * self.smoothed_fps_tx + 0.30 * inst_tx_fps;
        }

        let bits_per_sec = (self.window_wire_bits as f64) / dt_sec;
        let cap_bps = (nominal_bus_capacity_bps.max(500_000)) as f64;
        let estimated_bus_load_pct = if self.window_wire_bits == 0 {
            0.0
        } else {
            ((bits_per_sec / cap_bps) * 100.0).clamp(0.0, 100.0)
        };

        self.window_rx_frames = 0;
        self.window_tx_frames = 0;
        self.window_wire_bits = 0;

        // Sort message keys deterministically by (bus_id, is_extended, raw_id, mux_path)
        let mut sorted_keys: Vec<(BusId, CanIdKey, MuxPathKey)> =
            self.messages.keys().copied().collect();
        sorted_keys.sort_by_key(|&(bus, id, mux_path)| (bus, id.is_extended(), id.raw_id(), mux_path));

        let mut frames = Vec::with_capacity(sorted_keys.len());
        let mut decoded_signals_count = 0usize;
        let mut active_ids_count = 0usize;
        let mut prev_bus_can_id: Option<(BusId, CanIdKey)> = None;

        for key in sorted_keys {
            let Some(state) = self.messages.get(&key) else {
                continue;
            };

            let cur_bus_can_id = (state.bus_id, state.can_id);
            if prev_bus_can_id != Some(cur_bus_can_id) {
                active_ids_count += 1;
                prev_bus_can_id = Some(cur_bus_can_id);
            }

            let (changed_bytes_lo, changed_bytes_hi) = state.compute_changed_masks(now_us);
            let frequency_hz = if state.smoothed_cycle_ms > 1e-6 {
                1_000.0 / state.smoothed_cycle_ms
            } else {
                0.0
            };

            let effective_db =
                resolve_effective_db(&self.database, &self.bus_databases, state.bus_id);

            let expected_cycle_ms = effective_db
                .and_then(|db| db.get_message(&state.can_id))
                .and_then(|m| m.expected_cycle_ms);

            let cycle_health = compute_cycle_health(
                expected_cycle_ms,
                state.smoothed_cycle_ms,
                state.last_timestamp_us,
                now_us,
                !key.2.is_empty(),
                state.rx_count,
            );

            let mut active_mux_switches = IndexMap::new();
            if let Some(db) = effective_db {
                for &(sw_id, sw_val) in &state.active_switches {
                    if let Some(sig) = db.get_signal(sw_id) {
                        active_mux_switches.insert(sig.name.clone(), sw_val);
                    }
                }
            }

            let mut signals: Vec<LiveSignalDto> =
                Vec::with_capacity(state.retained_signals.len());
            for (&sig_id, slot) in &state.retained_signals {
                let age_ms = (now_us.saturating_sub(slot.last_updated_us) / 1_000)
                    .min(u64::from(u32::MAX)) as u32;
                signals.push(LiveSignalDto {
                    signal_id: sig_id,
                    raw_int: slot.raw_int,
                    physical_value: slot.physical_value,
                    active_in_last_frame: slot.active_in_last_frame,
                    out_of_range: slot.out_of_range,
                    age_ms,
                });
            }
            signals.sort_by_key(|s| s.signal_id);
            decoded_signals_count += signals.len();

            let dlc_len = usize::from(state.dlc.min(64));
            frames.push(FrameTelemetryDto {
                bus_id: state.bus_id,
                message_key: state.message_key.clone(),
                arb_id: state.can_id.raw_id(),
                is_extended: state.can_id.is_extended(),
                is_fd: (state.flags & nexus_core::FLAG_FD) != 0,
                is_brs: (state.flags & nexus_core::FLAG_BRS) != 0,
                is_tx: (state.flags & nexus_core::FLAG_TX) != 0,
                has_hw_timestamp: (state.flags & nexus_core::FLAG_HW_TIMESTAMP) != 0,
                dlc: state.dlc,
                raw_bytes: state.data[..dlc_len].to_vec(),
                changed_bytes_lo,
                changed_bytes_hi,
                last_timestamp_us: state.last_timestamp_us,
                cycle_ms: state.smoothed_cycle_ms,
                frequency_hz,
                cycle_health: cycle_health.to_string(),
                rx_count: state.rx_count,
                active_mux_switches,
                signals,
            });
        }

        let recent_chronological = self.chronological.drain_to_dtos();

        TelemetrySnapshotDto {
            seq: self.seq,
            timestamp_us: now_us,
            fps_rx: self.smoothed_fps_rx,
            fps_tx: self.smoothed_fps_tx,
            estimated_bus_load_pct,
            total_frames_rx: self.total_frames_rx,
            total_frames_tx: self.total_frames_tx,
            dropped_frames,
            active_ids_count,
            decoded_signals_count,
            tx_panic_latched,
            buses,
            frames,
            recent_chronological,
        }
    }
}

#[inline]
fn resolve_effective_db<'a>(
    legacy_db: &'a Option<Arc<CompiledDatabase>>,
    bus_dbs: &'a [Option<Option<Arc<CompiledDatabase>>>; MAX_BUS_SLOTS],
    bus_id: BusId,
) -> Option<&'a CompiledDatabase> {
    let slot = usize::from(bus_id);
    if slot < bus_dbs.len() {
        if let Some(ref bus_override) = bus_dbs[slot] {
            return bus_override.as_deref();
        }
    }
    legacy_db.as_deref()
}

#[inline]
fn compute_cycle_health(
    expected_cycle_ms: Option<u32>,
    smoothed_cycle_ms: f64,
    last_timestamp_us: u64,
    now_us: u64,
    is_mux_branch: bool,
    rx_count: u64,
) -> &'static str {
    let Some(exp_u32) = expected_cycle_ms else {
        return "unconfigured";
    };
    if exp_u32 == 0 {
        return "unconfigured";
    };

    let exp = f64::from(exp_u32);
    let silence_ms = (now_us.saturating_sub(last_timestamp_us) as f64) / 1_000.0;
    let ref_period_ms = if smoothed_cycle_ms > 1.0 {
        smoothed_cycle_ms.max(exp)
    } else if is_mux_branch && rx_count <= 1 {
        (exp * 8.0).max(2_000.0)
    } else {
        exp
    };

    if silence_ms > (3.5 * ref_period_ms).max(1_500.0) {
        "timeout"
    } else if silence_ms > 2.0 * ref_period_ms && silence_ms > 500.0 {
        "jitterWarning"
    } else {
        "nominal"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_netdb::{DatabaseInfoDto, FormatRegistry, ParseOptions};

    fn compile_dbc_str(name: &str, dbc_text: &str) -> (Arc<CompiledDatabase>, u32) {
        let registry = FormatRegistry::new();
        let bundle = registry
            .parse_bytes(dbc_text.as_bytes(), Some(name), &ParseOptions::default())
            .expect("parse inline dbc");
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
        let compiled = Arc::new(CompiledDatabase::compile(bundle.database).expect("compile dbc"));
        let schema = compiled.to_schema_dto(info);
        assert_eq!(schema.signals.len(), 1);
        let sig_id = schema.signals[0].signal_id;
        (compiled, sig_id)
    }

    #[test]
    fn per_bus_databases_isolate_decoding_and_allow_unbound_raw_bus() {
        // Both DBCs define Standard CAN ID 0x100 (decimal 256) with completely different signals!
        let dbc_bus0 = r#"VERSION "1.0"
BU_: VCU
BO_ 256 Powertrain_Status: 8 VCU
 SG_ Speed : 0|16@1+ (0.1,0) [0|500] "km/h" Vector__XXX
"#;
        let dbc_bus1 = r#"VERSION "1.0"
BU_: BMS
BO_ 256 Thermal_Status: 8 BMS
 SG_ Temp : 16|8@1+ (1,-40) [-40|215] "degC" Vector__XXX
"#;

        let (db0, speed_sig_id) = compile_dbc_str("bus0_speed.dbc", dbc_bus0);
        let (db1, temp_sig_id) = compile_dbc_str("bus1_temp.dbc", dbc_bus1);

        let mut table = StateTable::new();
        // Set a legacy DB too, to prove Bus 2 (`Some(None)`) strictly ignores legacy DB and stays Raw Hex!
        table.set_database(Some(Arc::clone(&db0)));

        table.set_bus_database(0, Some(Arc::clone(&db0)));
        table.set_bus_database(1, Some(Arc::clone(&db1)));
        table.set_bus_database(2, None); // Explicitly 0 DBCs bound -> pure Raw Hex!

        // Payload:
        // - bytes[0..2] LE = 0x05DC = 1500 -> Speed = 1500 * 0.1 = 150.0 km/h on Bus 0
        // - byte[2] = 0x5A = 90            -> Temp  = 90 * 1 - 40 = 50.0 degC on Bus 1
        let payload = [0xDC, 0x05, 0x5A, 0x11, 0x22, 0x33, 0x44, 0x55];

        let f_bus0 =
            RawCanFrame::new_classical(0, CanIdKey::Standard(0x100), &payload, 10_000).unwrap();
        let f_bus1 =
            RawCanFrame::new_classical(1, CanIdKey::Standard(0x100), &payload, 10_050).unwrap();
        let f_bus2 =
            RawCanFrame::new_classical(2, CanIdKey::Standard(0x100), &payload, 10_100).unwrap();

        table.ingest_frame(&f_bus0);
        table.ingest_frame(&f_bus1);
        table.ingest_frame(&f_bus2);

        let snap = table.build_snapshot(20_000, 0, false, 500_000, Vec::new());
        assert_eq!(snap.frames.len(), 3);

        let row0 = snap.frames.iter().find(|r| r.bus_id == 0).expect("bus 0 row");
        assert_eq!(row0.signals.len(), 1);
        assert_eq!(row0.signals[0].signal_id, speed_sig_id);
        assert!((row0.signals[0].physical_value - 150.0).abs() < 1e-6);

        let row1 = snap.frames.iter().find(|r| r.bus_id == 1).expect("bus 1 row");
        assert_eq!(row1.signals.len(), 1);
        assert_eq!(row1.signals[0].signal_id, temp_sig_id);
        assert!((row1.signals[0].physical_value - 50.0).abs() < 1e-6);

        let row2 = snap.frames.iter().find(|r| r.bus_id == 2).expect("bus 2 row");
        assert!(
            row2.signals.is_empty(),
            "Bus 2 has 0 DBCs bound and must remain pure Raw Hex without cross-bus decoding!"
        );
        assert_eq!(row2.raw_bytes, payload);

        // Late-bind db1 onto Bus 2 without receiving any new CAN frames -> cached payload decodes immediately!
        table.set_bus_database(2, Some(Arc::clone(&db1)));
        let snap_redecoded = table.build_snapshot(25_000, 0, false, 500_000, Vec::new());
        let row2_after = snap_redecoded
            .frames
            .iter()
            .find(|r| r.bus_id == 2)
            .expect("bus 2 row after late bind");
        assert_eq!(row2_after.signals.len(), 1);
        assert!((row2_after.signals[0].physical_value - 50.0).abs() < 1e-6);

        // Verify high bus indices (`bus_id = 12` / Bus 13, `bus_id = 42` / Bus 43, and `bus_id = 255` / Bus 256)
        // work seamlessly without any 16-bus ceiling!
        table.set_bus_database(12, Some(Arc::clone(&db0)));
        table.set_bus_database(42, Some(Arc::clone(&db1)));
        table.set_bus_database(255, None);

        table.ingest_frame(
            &RawCanFrame::new_classical(12, CanIdKey::Standard(0x100), &payload, 30_000).unwrap(),
        );
        table.ingest_frame(
            &RawCanFrame::new_classical(42, CanIdKey::Standard(0x100), &payload, 30_050).unwrap(),
        );
        table.ingest_frame(
            &RawCanFrame::new_classical(255, CanIdKey::Standard(0x100), &payload, 30_100).unwrap(),
        );

        let snap_high_buses = table.build_snapshot(35_000, 0, false, 500_000, Vec::new());
        let row12 = snap_high_buses
            .frames
            .iter()
            .find(|r| r.bus_id == 12)
            .expect("bus 12 (Bus 13) row");
        assert_eq!(row12.signals.len(), 1);
        assert_eq!(row12.signals[0].signal_id, speed_sig_id);
        assert!((row12.signals[0].physical_value - 150.0).abs() < 1e-6);

        let row42 = snap_high_buses
            .frames
            .iter()
            .find(|r| r.bus_id == 42)
            .expect("bus 42 (Bus 43) row");
        assert_eq!(row42.signals.len(), 1);
        assert_eq!(row42.signals[0].signal_id, temp_sig_id);
        assert!((row42.signals[0].physical_value - 50.0).abs() < 1e-6);

        let row255 = snap_high_buses
            .frames
            .iter()
            .find(|r| r.bus_id == 255)
            .expect("bus 255 (Bus 256) row");
        assert!(row255.signals.is_empty());
    }

    #[test]
    fn dynamic_on_arrival_cascaded_mux_rows_never_prepopulate_and_collapse_on_unbind() {
        let scripts_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts");
        let dbc_bytes = std::fs::read(scripts_dir.join("sample_vehicle.dbc")).expect("read dbc");
        let bundle = FormatRegistry::new()
            .parse_bytes(
                &dbc_bytes,
                Some("sample_vehicle.dbc"),
                &ParseOptions::default(),
            )
            .expect("parse sample_vehicle.dbc");
        let compiled = Arc::new(CompiledDatabase::compile(bundle.database).expect("compile dbc"));

        let mut table = StateTable::new();
        table.set_bus_database(0, Some(Arc::clone(&compiled)));

        // 1. CRITICAL INVARIANT: Before any frames arrive, snap.frames MUST be completely empty (0 pre-populated rows!)
        let snap_initial = table.build_snapshot(10_000, 0, false, 500_000, Vec::new());
        assert_eq!(
            snap_initial.frames.len(),
            0,
            "DBC messages and multiplexer branches must NEVER be pre-listed before bus arrival"
        );
        assert_eq!(snap_initial.active_ids_count, 0);

        let can_105 = CanIdKey::Standard(0x105);

        // Payload helper for 0x105:
        // byte 0 low nibble = MuxDomainSwitch (bits 0..3)
        // byte 0 high nibble = SubBankSwitch / ContactorState (bits 4..7)
        // byte 1 = PackSocPct raw (156 => 78.0%)
        let make_105 = |dom: u8, sub_or_cont: u8, b2: u8, ts_us: u64| -> RawCanFrame {
            let payload = [(dom & 0x0F) | ((sub_or_cont & 0x0F) << 4), 156, b2, 0x10, 0x20, 0x30, 0x40, 0x00];
            RawCanFrame::new_classical(0, can_105, &payload, ts_us).expect("0x105 frame")
        };

        // 2. Arrive branch #1: MuxDomainSwitch = 2 -> snap.frames grows 0 -> 1
        table.ingest_frame(&make_105(2, 2, 0xAA, 20_000));
        let snap_1 = table.build_snapshot(21_000, 0, false, 500_000, Vec::new());
        assert_eq!(snap_1.frames.len(), 1);
        assert_eq!(snap_1.active_ids_count, 1);
        assert_eq!(
            snap_1.frames[0]
                .active_mux_switches
                .iter()
                .map(|(k, &v)| (k.as_str(), v))
                .collect::<Vec<_>>(),
            vec![("MuxDomainSwitch", 2)]
        );
        assert_eq!(snap_1.frames[0].rx_count, 1);

        // 3. Arrive branch #2: MuxDomainSwitch = 1, SubBankSwitch = 1 -> snap.frames grows 1 -> 2, sorted (1,1) then (2)
        table.ingest_frame(&make_105(1, 1, 0xBB, 40_000));
        let snap_2 = table.build_snapshot(41_000, 0, false, 500_000, Vec::new());
        assert_eq!(snap_2.frames.len(), 2);
        assert_eq!(snap_2.active_ids_count, 1);
        assert_eq!(
            snap_2.frames[0]
                .active_mux_switches
                .iter()
                .map(|(k, &v)| (k.as_str(), v))
                .collect::<Vec<_>>(),
            vec![("MuxDomainSwitch", 1), ("SubBankSwitch", 1)]
        );
        assert_eq!(
            snap_2.frames[1]
                .active_mux_switches
                .iter()
                .map(|(k, &v)| (k.as_str(), v))
                .collect::<Vec<_>>(),
            vec![("MuxDomainSwitch", 2)]
        );

        // 4. Arrive branch #3: MuxDomainSwitch = 0, SubBankSwitch = 0 (twice!) -> snap.frames grows 2 -> 3,
        //    sorted lexicographically (0,0), (1,1), (2), with independent rx_count, cycle_ms, and raw_bytes!
        table.ingest_frame(&make_105(0, 0, 0xCC, 60_000));
        table.ingest_frame(&make_105(0, 0, 0xCD, 160_000));
        let snap_3 = table.build_snapshot(161_000, 0, false, 500_000, Vec::new());
        assert_eq!(snap_3.frames.len(), 3);
        assert_eq!(snap_3.active_ids_count, 1);

        assert_eq!(
            snap_3.frames[0]
                .active_mux_switches
                .iter()
                .map(|(k, &v)| (k.as_str(), v))
                .collect::<Vec<_>>(),
            vec![("MuxDomainSwitch", 0), ("SubBankSwitch", 0)]
        );
        assert_eq!(snap_3.frames[0].rx_count, 2);
        assert!((snap_3.frames[0].cycle_ms - 100.0).abs() < 1e-6);
        assert_eq!(snap_3.frames[0].raw_bytes[2], 0xCD);
        // Only byte 2 changed on branch (0,0) -> bit 2 highlighted!
        assert_eq!(snap_3.frames[0].changed_bytes_lo, 1u32 << 2);

        assert_eq!(snap_3.frames[1].rx_count, 1);
        assert_eq!(snap_3.frames[1].raw_bytes[2], 0xBB);
        assert_eq!(snap_3.frames[2].rx_count, 1);
        assert_eq!(snap_3.frames[2].raw_bytes[2], 0xAA);

        // 5. Unbind bus 0 database (`set_bus_database(0, None)`) -> collapses the 3 mux rows into 1 Raw Hex row
        //    with summed rx_count (2 + 1 + 1 == 4) and the newest frame's payload/timestamp (t = 160_000, byte[2] = 0xCD)!
        table.set_bus_database(0, None);
        let snap_unbound = table.build_snapshot(165_000, 0, false, 500_000, Vec::new());
        assert_eq!(snap_unbound.frames.len(), 1);
        assert_eq!(snap_unbound.active_ids_count, 1);
        let collapsed = &snap_unbound.frames[0];
        assert_eq!(collapsed.rx_count, 4);
        assert_eq!(collapsed.last_timestamp_us, 160_000);
        assert_eq!(collapsed.raw_bytes[2], 0xCD);
        assert!(collapsed.signals.is_empty());
        assert!(collapsed.active_mux_switches.is_empty());
    }
}
