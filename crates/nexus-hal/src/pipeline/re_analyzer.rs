//! RE Toolkit R1 (`planning/contracts/re-toolkit-v1.md` §1 / §2): passive reverse-engineering
//! sniffer state owned by the 60 Hz aggregator thread.
//!
//! * Per row `(bus, isExtended, arbId)` (mux path ignored, error and RTR frames excluded) a
//!   fixed-size [`ReRowState`] is allocated **once** when the row is first seen (bounded by
//!   [`MAX_RE_ROWS`]; frames of further rows are only counted in `overflowRows`, amendment 3). [`ReAnalyzer::ingest`]
//!   never allocates afterwards.
//! * Bit numbering = DBC Intel numbering (`bit = byte*8 + k`, `k = 0` = LSB of the byte); every
//!   array covers 64 bytes / 512 bits (CAN-FD). Bit operations work on eight `u64` words of
//!   the 64-byte payload, never on a single `u64` of the frame.
//! * [`ReAnalyzer::encode_snapshot`] writes the §2.2 little-endian binary snapshot into a
//!   caller-owned, reused `Vec<u8>` (dirty rows only, or every row on a full resync).
//! * [`classify_history`] is the pure §2.3 field classifier (on demand, never on the hot path).

use nexus_core::flags::{FLAG_ERROR, FLAG_EXTENDED, FLAG_FD, FLAG_RTR};
use nexus_core::{now_monotonic_us, RawCanFrame, EXT_CAN_ID_MASK, STD_CAN_ID_MASK};
use parking_lot::{Mutex, MutexGuard};
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

mod re_dbc;
mod re_focus;
mod re_scan;
pub use re_dbc::{
    re_dbc_generate, ReDbcBaseDto, ReDbcGenerateRequest, RE_DBC_MAX_BASE_B64_LEN,
    RE_DBC_MAX_BASE_BYTES, RE_DBC_MAX_COMMENT, RE_DBC_MAX_DRAFTS, RE_DBC_MAX_FIELD,
    RE_DBC_MAX_FILE_NAME, RE_DBC_MAX_VALUE_TABLE, RE_DBC_MAX_VALUE_TABLE_TOTAL,
};
use re_focus::{focus_ingest, FocusRing};
pub use re_focus::{
    obd_pid_value, ReCandidateDto, ReCorrelateRequest, ReCorrelationJob, ReCorrelationResultDto,
    ReCorrelationRowDto, ReError, ReFocusStatusDto, ReFocusTargetStatusDto, ReMarkerPointDto,
    ReReferenceDto, ReSearchDto, ReSeriesRequest, ReTargetDto, ReValueType, MAX_RE_FOCUS,
    OBD_PID_CATALOG, RE_CORRELATE_BUDGET, RE_CORRELATE_MAX_TOP_N, RE_DEDUPE_DELTA_R,
    RE_FOCUS_DEPTH, RE_LAG_MIN_GAIN, RE_LAG_RANGE_MS, RE_LAG_STEP_MS, RE_SEARCH_MAX_LEN,
    RE_SERIES_ENTRY_BYTES, RE_SERIES_HEADER_BYTES, RE_SERIES_KIND_CANDIDATE,
    RE_SERIES_KIND_REFERENCE, RE_SERIES_MAGIC, RE_SERIES_MAX_CANDIDATES, RE_SERIES_MAX_POINTS,
    RE_SERIES_MIN_POINTS, RE_SERIES_POINT_BYTES, RE_ZOH_MAX_AGE_US,
};
use re_scan::ScanState;
pub use re_scan::{
    ReScalePresetDto, ReScanAlignment, ReScanCandidateDto, ReScanFirstSpec, ReScanKind,
    ReScanNextOp, ReScanOpKind, ReScanOptionsDto, ReScanReadMode, ReScanResultRowDto,
    ReScanResultsDto, ReScanSort, ReScanStatusDto, RE_SCAN_BUDGET, RE_SCAN_DEFAULT_LENGTHS,
    RE_SCAN_MAX_CANDIDATES, RE_SCAN_MAX_PRESETS, RE_SCAN_MAX_RESULTS, RE_SCAN_MAX_UNDO,
    RE_SCAN_MAX_USER_PRESETS, RE_SCAN_PRESET_FACTORS, RE_SCAN_PRESET_OFFSETS,
};

// ─── Limits ─────────────────────────────────────────────────────────────────

/// Maximum number of RE rows; frames of rows beyond are counted in `overflowRows` (amendment 3).
pub const MAX_RE_ROWS: usize = 2_048;
/// Maximum number of retained event markers (oldest dropped).
pub const MAX_RE_MARKERS: usize = 1_024;
/// Maximum marker label length in characters.
pub const MAX_RE_MARKER_LABEL_CHARS: usize = 64;
/// Payload history ring depth per row (classifier input).
pub const RE_HISTORY_DEPTH: usize = 64;
/// Minimum history samples before the classifier emits fields.
pub const RE_MIN_CLASSIFY_SAMPLES: usize = 16;
/// Heat window decay period (`x -> x/2` every second of frame time).
pub const RE_HEAT_DECAY_PERIOD_US: u64 = 1_000_000;
/// Snapshot header size in bytes (§2.2).
pub const RE_SNAPSHOT_HEADER_BYTES: usize = 24;
/// Fixed row header size in bytes (§2.2) before the `heat` / `diff` / `constant` / `data` arrays.
pub const RE_SNAPSHOT_ROW_HEADER_BYTES: usize = 12;
/// Worst-case snapshot size (all rows, 64-byte payloads): reserve once, never grows.
pub const RE_SNAPSHOT_MAX_BYTES: usize =
    RE_SNAPSHOT_HEADER_BYTES + MAX_RE_ROWS * (RE_SNAPSHOT_ROW_HEADER_BYTES + 64 * 8 + 64 + 64 + 64);
/// Snapshot magic (`"NRE2"`, R1 amendment 13: snapshot v2, rows carry the latest payload
/// `data [u8; dlcBytes]` after the constant mask). `"NRE1"` is no longer produced.
pub const RE_SNAPSHOT_MAGIC: [u8; 4] = *b"NRE2";
/// Snapshot row flag bits.
pub const RE_ROW_FLAG_EXTENDED: u8 = 1 << 0;
pub const RE_ROW_FLAG_FD: u8 = 1 << 1;
pub const RE_ROW_FLAG_HAS_DIFF: u8 = 1 << 2;
pub const RE_ROW_FLAG_NEW: u8 = 1 << 3;
/// Heat value of a bit toggling in exactly 50 % of the window frames (bits above are "noisy").
pub const RE_HEAT_NOISY_THRESHOLD: u8 = 229;

// ─── DTOs (§2.1 / §2.3) ─────────────────────────────────────────────────────

/// Analyzer phase (`idle | free | baseline | action`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RePhase {
    #[default]
    Idle,
    Free,
    Baseline,
    Action,
}

impl RePhase {
    /// Snapshot wire code (0 idle, 1 free, 2 baseline, 3 action).
    pub const fn code(self) -> u8 {
        match self {
            RePhase::Idle => 0,
            RePhase::Free => 1,
            RePhase::Baseline => 2,
            RePhase::Action => 3,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReStatusDto {
    pub enabled: bool,
    pub phase: RePhase,
    pub rows: u32,
    pub overflow_rows: u32,
    pub frames_ingested: u64,
    pub started_at_us: Option<u64>,
    pub phase_started_at_us: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReMarkerDto {
    pub id: u32,
    pub ts_us: u64,
    pub label: String,
    pub phase: RePhase,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReRowDetailDto {
    pub bus: u8,
    pub arb_id: u32,
    pub is_extended: bool,
    pub dlc_bytes: u8,
    pub rx_count: u32,
    /// `dlcBytes * 8` exact (saturating `u32`) toggle counts.
    pub toggles: Vec<u32>,
    /// Uppercase hex, 2 chars per byte, byte 0 first.
    pub constant_mask: String,
    pub baseline_mask: String,
    pub action_mask: String,
    pub diff_mask: String,
    /// Additive to the contract: noise mute mask (toggled in baseline OR window rate > 50 %).
    pub noisy_mask: String,
    pub first_us: u64,
    pub last_us: u64,
    pub history_len: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReFieldKind {
    Constant,
    Counter,
    Checksum,
    Flag,
    Physical,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReByteOrder {
    Intel,
    Motorola,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReChecksumAlgo {
    #[serde(rename = "xor8")]
    Xor8,
    #[serde(rename = "sum8")]
    Sum8,
    #[serde(rename = "crc8_j1850")]
    Crc8J1850,
    #[serde(rename = "crc8_h2f")]
    Crc8H2f,
    #[serde(rename = "crc8_custom")]
    Crc8Custom,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReFieldDto {
    /// Intel: LSB bit. Motorola: MSB bit (DBC sawtooth start bit).
    pub start_bit: u16,
    pub bit_length: u16,
    pub byte_order: ReByteOrder,
    pub kind: ReFieldKind,
    pub confidence: f64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub counter_modulo: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub counter_step: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub checksum_algo: Option<ReChecksumAlgo>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub checksum_init: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub checksum_coverage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub max: Option<f64>,
}

impl ReFieldDto {
    fn new(
        start_bit: u16,
        bit_length: u16,
        order: ReByteOrder,
        kind: ReFieldKind,
        conf: f64,
    ) -> Self {
        Self {
            start_bit,
            bit_length,
            byte_order: order,
            kind,
            confidence: conf.clamp(0.0, 1.0),
            counter_modulo: None,
            counter_step: None,
            checksum_algo: None,
            checksum_init: None,
            checksum_coverage: None,
            min: None,
            max: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReClassificationDto {
    pub bus: u8,
    pub arb_id: u32,
    pub is_extended: bool,
    pub samples: u32,
    /// `dlcBytes * 8` Shannon entropies of the bits (0..1).
    pub bit_entropy: Vec<f64>,
    pub fields: Vec<ReFieldDto>,
    pub period_ms: Option<f64>,
    pub jitter_ms: Option<f64>,
}

// ─── Per-row state ──────────────────────────────────────────────────────────

type RowKey = (u8, bool, u32);

/// Fixed-size per-row RE state (~7.8 KB, boxed once at row creation).
pub struct ReRowState {
    bus: u8,
    is_extended: bool,
    arb_id: u32,
    /// Max payload length seen.
    dlc_bytes: u8,
    /// Previous payload as eight little-endian words (= `prev: [u8; 64]`), masked to `prev_len`.
    prev: [u64; 8],
    prev_len: u8,
    has_prev: bool,
    toggles: [u32; 512],
    window_toggles: [u16; 512],
    /// Frames in the current heat window (decayed with `window_toggles`).
    window_rx: u32,
    /// Frame-time epoch (seconds) of the heat window.
    window_epoch: u64,
    seen_one: [u64; 8],
    seen_zero: [u64; 8],
    baseline_active: [u64; 8],
    action_active: [u64; 8],
    history: [[u8; 64]; RE_HISTORY_DEPTH],
    hist_len: u8,
    hist_head: u8,
    hist_ts_us: [u64; RE_HISTORY_DEPTH],
    /// R2c: payload length of each history slot (value reads past a short frame are null).
    hist_dlc: [u8; RE_HISTORY_DEPTH],
    /// R2c (§8.2): OR-mask of bits toggled since the last first/next value scan.
    scan_changed: [u64; 8],
    rx_count: u32,
    first_us: u64,
    last_us: u64,
    fd_seen: bool,
    dirty: bool,
    is_new: bool,
}

#[inline]
fn len_mask(word: usize, len_bytes: usize) -> u64 {
    let lo = word * 8;
    if len_bytes >= lo + 8 {
        u64::MAX
    } else if len_bytes <= lo {
        0
    } else {
        (1u64 << ((len_bytes - lo) * 8)) - 1
    }
}

#[inline]
fn load_word(data: &[u8; 64], word: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&data[word * 8..word * 8 + 8]);
    u64::from_le_bytes(b)
}

impl ReRowState {
    fn new(key: RowKey, ts_us: u64) -> Box<Self> {
        Box::new(Self {
            bus: key.0,
            is_extended: key.1,
            arb_id: key.2,
            dlc_bytes: 0,
            prev: [0; 8],
            prev_len: 0,
            has_prev: false,
            toggles: [0; 512],
            window_toggles: [0; 512],
            window_rx: 0,
            window_epoch: ts_us / RE_HEAT_DECAY_PERIOD_US,
            seen_one: [0; 8],
            seen_zero: [0; 8],
            baseline_active: [0; 8],
            action_active: [0; 8],
            history: [[0; 64]; RE_HISTORY_DEPTH],
            hist_len: 0,
            hist_head: 0,
            hist_ts_us: [0; RE_HISTORY_DEPTH],
            hist_dlc: [0; RE_HISTORY_DEPTH],
            scan_changed: [0; 8],
            rx_count: 0,
            first_us: ts_us,
            last_us: ts_us,
            fd_seen: false,
            dirty: true,
            is_new: true,
        })
    }

    #[inline]
    fn decay_window(&mut self, ts_us: u64) {
        let epoch = ts_us / RE_HEAT_DECAY_PERIOD_US;
        if epoch > self.window_epoch {
            let d = epoch - self.window_epoch;
            if d >= 16 {
                self.window_toggles = [0; 512];
                self.window_rx = 0;
            } else {
                let s = d as u32;
                for w in self.window_toggles.iter_mut() {
                    *w >>= s;
                }
                self.window_rx >>= s;
            }
            self.window_epoch = epoch;
        } else if epoch < self.window_epoch {
            // Time went backwards (replay restart): re-anchor without decay.
            self.window_epoch = epoch;
        }
    }

    #[inline]
    fn ingest(&mut self, f: &RawCanFrame, phase: RePhase) {
        let n = usize::from(f.dlc.min(64));
        let ts = f.timestamp_us;
        self.decay_window(ts);

        let words = n.div_ceil(8);
        let cmp_len = if self.has_prev {
            n.min(usize::from(self.prev_len))
        } else {
            0
        };
        for w in 0..8 {
            let lm = len_mask(w, n);
            let cur = if w < words {
                load_word(&f.data, w) & lm
            } else {
                0
            };
            if w < words {
                self.seen_one[w] |= cur;
                self.seen_zero[w] |= !cur & lm;
            }
            let mut changed = (cur ^ self.prev[w]) & len_mask(w, cmp_len);
            if changed != 0 {
                self.scan_changed[w] |= changed;
                match phase {
                    RePhase::Baseline => self.baseline_active[w] |= changed,
                    RePhase::Action => self.action_active[w] |= changed,
                    RePhase::Free | RePhase::Idle => {}
                }
                let base = w * 64;
                while changed != 0 {
                    let bit = base + changed.trailing_zeros() as usize;
                    self.toggles[bit] = self.toggles[bit].saturating_add(1);
                    self.window_toggles[bit] = self.window_toggles[bit].saturating_add(1);
                    changed &= changed - 1;
                }
            }
            self.prev[w] = cur;
        }
        self.prev_len = n as u8;
        self.has_prev = true;
        if n as u8 > self.dlc_bytes {
            self.dlc_bytes = n as u8;
        }

        let h = usize::from(self.hist_head);
        let slot = &mut self.history[h];
        slot[..n].copy_from_slice(&f.data[..n]);
        slot[n..].fill(0);
        self.hist_ts_us[h] = ts;
        self.hist_dlc[h] = n as u8;
        self.hist_head = ((h + 1) % RE_HISTORY_DEPTH) as u8;
        if usize::from(self.hist_len) < RE_HISTORY_DEPTH {
            self.hist_len += 1;
        }

        self.window_rx = self.window_rx.saturating_add(1);
        self.rx_count = self.rx_count.saturating_add(1);
        self.last_us = ts;
        self.fd_seen |= f.flags & FLAG_FD != 0;
        self.dirty = true;
    }

    #[inline]
    fn bits(&self) -> usize {
        usize::from(self.dlc_bytes) * 8
    }

    #[inline]
    fn constant_word(&self, w: usize) -> u64 {
        !(self.seen_one[w] & self.seen_zero[w]) & len_mask(w, usize::from(self.dlc_bytes))
    }

    #[inline]
    fn diff_word(&self, w: usize) -> u64 {
        self.action_active[w] & !self.baseline_active[w]
    }

    fn has_diff(&self) -> bool {
        (0..8).any(|w| self.diff_word(w) != 0)
    }

    fn noisy_word(&self, w: usize) -> u64 {
        let mut m = self.baseline_active[w];
        for k in 0..64 {
            let bit = w * 64 + k;
            if 2 * u32::from(self.window_toggles[bit]) > self.window_rx {
                m |= 1u64 << k;
            }
        }
        m & len_mask(w, usize::from(self.dlc_bytes))
    }

    /// Chronological (oldest first) copy of the history ring.
    fn history_chrono(&self) -> (Vec<[u8; 64]>, Vec<u64>) {
        let len = usize::from(self.hist_len);
        let start = (usize::from(self.hist_head) + RE_HISTORY_DEPTH - len) % RE_HISTORY_DEPTH;
        let mut p = Vec::with_capacity(len);
        let mut t = Vec::with_capacity(len);
        for i in 0..len {
            let idx = (start + i) % RE_HISTORY_DEPTH;
            p.push(self.history[idx]);
            t.push(self.hist_ts_us[idx]);
        }
        (p, t)
    }
}

/// Heat byte from a window toggle count and window frame count: `0` = static, else
/// `1 + 254 * log2(1 + q) / log2(1025)` with `q = 1024 * rate` (integer fixed-point log2,
/// bit-exact on every platform).
#[inline]
pub fn re_heat(window_toggles: u16, window_rx: u32) -> u8 {
    if window_toggles == 0 || window_rx == 0 {
        return 0;
    }
    let q = ((u64::from(window_toggles) * 1024) / u64::from(window_rx)).min(1024) as u32;
    let num = 254 * log2_q8(1 + q);
    (1 + num / log2_q8(1025)).min(255) as u8
}

/// `log2(x) * 256` with linear interpolation of the fractional part (`x >= 1`).
#[inline]
const fn log2_q8(x: u32) -> u32 {
    let i = 31 - x.leading_zeros();
    let frac = if i >= 8 {
        (x >> (i - 8)) & 0xFF
    } else {
        (x << (8 - i)) & 0xFF
    };
    i * 256 + frac
}

fn hex_words(words: impl Fn(usize) -> u64, n_bytes: usize) -> String {
    let mut s = String::with_capacity(n_bytes * 2);
    for i in 0..n_bytes {
        let b = (words(i / 8) >> ((i % 8) * 8)) as u8;
        let _ = write!(s, "{b:02X}");
    }
    s
}

// ─── Analyzer ───────────────────────────────────────────────────────────────

/// RE sniffer state (owned by [`ReShared`], ingested from the aggregator thread).
pub struct ReAnalyzer {
    enabled: bool,
    phase: RePhase,
    bus_filter: [bool; 256],
    index: FxHashMap<RowKey, u16>,
    rows: Vec<Box<ReRowState>>,
    overflow_frames: u64,
    frames_ingested: u64,
    started_at_us: Option<u64>,
    phase_started_at_us: Option<u64>,
    markers: VecDeque<ReMarkerDto>,
    next_marker_id: u32,
    seq: u32,
    last_frame_us: u64,
    /// R2a focus rings (≤ `MAX_RE_FOCUS`, each preallocated once when focused).
    focus: Vec<FocusRing>,
    /// Amendment R2a-3: latest `frame.tsUs - monotonic_now` seen at ingest (frame time base for
    /// markers / phase starts when frames carry hardware timestamps). `None` before any frame.
    clock_offset_us: Option<i64>,
    /// R2c: bumped by every [`ReAnalyzer::reset`] (invalidates an active value scan).
    reset_epoch: u64,
}

impl Default for ReAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

impl ReAnalyzer {
    /// Creates a disabled analyzer. Row index / row vector / marker capacities are
    /// reserved here so that `ingest` never reallocates them.
    pub fn new() -> Self {
        let mut index = FxHashMap::default();
        index.reserve(MAX_RE_ROWS);
        Self {
            enabled: false,
            phase: RePhase::Idle,
            bus_filter: [true; 256],
            index,
            rows: Vec::with_capacity(MAX_RE_ROWS),
            overflow_frames: 0,
            frames_ingested: 0,
            started_at_us: None,
            phase_started_at_us: None,
            markers: VecDeque::with_capacity(MAX_RE_MARKERS),
            next_marker_id: 1,
            seq: 0,
            last_frame_us: 0,
            focus: Vec::with_capacity(MAX_RE_FOCUS),
            clock_offset_us: None,
            reset_epoch: 0,
        }
    }

    /// Enables ingest on `buses` (`None` = all). `idle -> free`.
    pub fn start(&mut self, buses: Option<&[u8]>) -> ReStatusDto {
        match buses {
            None => self.bus_filter = [true; 256],
            Some(list) => {
                self.bus_filter = [false; 256];
                for &b in list {
                    self.bus_filter[usize::from(b)] = true;
                }
            }
        }
        let now = now_monotonic_us();
        if !self.enabled {
            self.started_at_us = Some(now);
        }
        self.enabled = true;
        if self.phase == RePhase::Idle {
            self.phase = RePhase::Free;
            self.phase_started_at_us = Some(self.frame_time(now));
        }
        self.status()
    }

    /// Pauses ingest (state kept).
    pub fn stop(&mut self) -> ReStatusDto {
        self.enabled = false;
        self.status()
    }

    /// Clears all rows, overflow accounting, counters and markers (phase / enabled kept).
    pub fn reset(&mut self) -> ReStatusDto {
        self.index.clear();
        self.rows.clear();
        self.overflow_frames = 0;
        self.frames_ingested = 0;
        self.markers.clear();
        self.last_frame_us = 0;
        self.reset_epoch = self.reset_epoch.wrapping_add(1);
        self.focus_clear_samples();
        let now = now_monotonic_us();
        self.started_at_us = if self.enabled { Some(now) } else { None };
        if self.phase != RePhase::Idle {
            self.phase_started_at_us = Some(self.frame_time(now));
        }
        self.status()
    }

    /// Switches phase; entering `baseline` clears `baseline_active`, entering `action` clears
    /// `action_active` (every row is marked dirty since its diff mask may change).
    pub fn set_phase(&mut self, phase: RePhase) -> ReStatusDto {
        match phase {
            RePhase::Baseline => {
                for r in &mut self.rows {
                    r.baseline_active = [0; 8];
                    r.dirty = true;
                }
            }
            RePhase::Action => {
                for r in &mut self.rows {
                    r.action_active = [0; 8];
                    r.dirty = true;
                }
            }
            RePhase::Free | RePhase::Idle => {}
        }
        self.phase = phase;
        self.phase_started_at_us = Some(self.frame_time(now_monotonic_us()));
        self.status()
    }

    /// Maps a monotonic timestamp into the frame time base (amendment R2a-3): `mono + offset`
    /// with the latest ingest offset, or `mono` before any frame was ingested.
    #[inline]
    pub fn frame_time(&self, mono_us: u64) -> u64 {
        match self.clock_offset_us {
            Some(o) => (mono_us as i64).saturating_add(o).max(0) as u64,
            None => mono_us,
        }
    }

    /// Current phase.
    pub fn phase(&self) -> RePhase {
        self.phase
    }

    /// `true` while ingest is enabled.
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Hot path: zero allocation once the row exists (row creation boxes one [`ReRowState`]).
    #[inline]
    pub fn ingest(&mut self, f: &RawCanFrame) {
        if !self.enabled || f.flags & (FLAG_ERROR | FLAG_RTR) != 0 {
            return;
        }
        if !self.bus_filter[usize::from(f.bus_id)] {
            return;
        }
        let ext = f.flags & FLAG_EXTENDED != 0;
        let arb = f.arb_id
            & if ext {
                EXT_CAN_ID_MASK
            } else {
                STD_CAN_ID_MASK
            };
        let key: RowKey = (f.bus_id, ext, arb);
        self.frames_ingested = self.frames_ingested.saturating_add(1);
        if f.timestamp_us > self.last_frame_us {
            self.last_frame_us = f.timestamp_us;
        }
        // Amendment R2a-3: frame clock vs monotonic clock (one vDSO clock read, no allocation).
        self.clock_offset_us =
            Some((f.timestamp_us as i64).wrapping_sub(now_monotonic_us() as i64));
        if !self.focus.is_empty() {
            // R2a focus rings: fixed-size copy, independent of the RE row budget.
            focus_ingest(&mut self.focus, key, f);
        }
        let idx = match self.index.get(&key) {
            Some(&i) => usize::from(i),
            None => {
                if self.rows.len() >= MAX_RE_ROWS {
                    self.overflow_frames = self.overflow_frames.saturating_add(1);
                    return;
                }
                let i = self.rows.len();
                self.rows.push(ReRowState::new(key, f.timestamp_us));
                self.index.insert(key, i as u16);
                i
            }
        };
        let phase = self.phase;
        self.rows[idx].ingest(f, phase);
    }

    /// Adds an event marker; never fails: labels are truncated to 64 chars (UTF-8 safe).
    pub fn mark(&mut self, label: &str) -> ReMarkerDto {
        let label = match label.char_indices().nth(MAX_RE_MARKER_LABEL_CHARS) {
            Some((byte_idx, _)) => &label[..byte_idx],
            None => label,
        };
        let m = ReMarkerDto {
            id: self.next_marker_id,
            ts_us: self.frame_time(now_monotonic_us()),
            label: label.to_string(),
            phase: self.phase,
        };
        self.next_marker_id = self.next_marker_id.wrapping_add(1);
        if self.markers.len() >= MAX_RE_MARKERS {
            self.markers.pop_front();
        }
        self.markers.push_back(m.clone());
        m
    }

    /// Markers, oldest first.
    pub fn markers(&self) -> Vec<ReMarkerDto> {
        self.markers.iter().cloned().collect()
    }

    pub fn status(&self) -> ReStatusDto {
        ReStatusDto {
            enabled: self.enabled,
            phase: self.phase,
            rows: self.rows.len() as u32,
            overflow_rows: self.overflow_frames.min(u64::from(u32::MAX)) as u32,
            frames_ingested: self.frames_ingested,
            started_at_us: self.started_at_us,
            phase_started_at_us: self.phase_started_at_us,
        }
    }

    fn row(&self, bus: u8, arb_id: u32, is_ext: bool) -> Option<&ReRowState> {
        let arb = arb_id
            & if is_ext {
                EXT_CAN_ID_MASK
            } else {
                STD_CAN_ID_MASK
            };
        self.index
            .get(&(bus, is_ext, arb))
            .map(|&i| &*self.rows[usize::from(i)])
    }

    pub fn row_detail(&self, bus: u8, arb_id: u32, is_ext: bool) -> Option<ReRowDetailDto> {
        let r = self.row(bus, arb_id, is_ext)?;
        let n = usize::from(r.dlc_bytes);
        Some(ReRowDetailDto {
            bus: r.bus,
            arb_id: r.arb_id,
            is_extended: r.is_extended,
            dlc_bytes: r.dlc_bytes,
            rx_count: r.rx_count,
            toggles: r.toggles[..r.bits()].to_vec(),
            constant_mask: hex_words(|w| r.constant_word(w), n),
            baseline_mask: hex_words(|w| r.baseline_active[w], n),
            action_mask: hex_words(|w| r.action_active[w], n),
            diff_mask: hex_words(|w| r.diff_word(w), n),
            noisy_mask: hex_words(|w| r.noisy_word(w), n),
            first_us: r.first_us,
            last_us: r.last_us,
            history_len: r.hist_len,
        })
    }

    /// Chronological copy of a row's payload history and dlc (classifier input), so the
    /// caller can classify outside the shared lock.
    pub fn row_history(&self, bus: u8, arb_id: u32, is_ext: bool) -> Option<ReRowHistory> {
        let r = self.row(bus, arb_id, is_ext)?;
        let (payloads, ts_us) = r.history_chrono();
        Some(ReRowHistory {
            bus: r.bus,
            arb_id: r.arb_id,
            is_extended: r.is_extended,
            dlc_bytes: r.dlc_bytes,
            payloads,
            ts_us,
        })
    }

    pub fn classify(&self, bus: u8, arb_id: u32, is_ext: bool) -> Option<ReClassificationDto> {
        self.row_history(bus, arb_id, is_ext).map(|h| h.classify())
    }

    /// Encodes the §2.2 binary snapshot into `out` (cleared first; capacity reused). Includes
    /// dirty rows, or every row when `full`. Clears dirty / new flags of the emitted rows.
    /// `tsUs` = newest frame timestamp seen (frame-time domain); `seq` starts at 0.
    pub fn encode_snapshot(&mut self, out: &mut Vec<u8>, full: bool) {
        out.clear();
        out.extend_from_slice(&RE_SNAPSHOT_MAGIC);
        out.extend_from_slice(&self.seq.to_le_bytes());
        out.extend_from_slice(&self.last_frame_us.to_le_bytes());
        out.push(self.phase.code());
        out.push(u8::from(full));
        let row_count_at = out.len();
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(self.rows.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        self.seq = self.seq.wrapping_add(1);

        let mut count: u16 = 0;
        let now_frame_us = self.last_frame_us;
        for r in self.rows.iter_mut() {
            if !(full || r.dirty) {
                continue;
            }
            // Amendment 9: heat window decay on frame timestamps, evaluated at snapshot time.
            r.decay_window(now_frame_us);
            count += 1;
            let n = usize::from(r.dlc_bytes);
            let mut flags = 0u8;
            if r.is_extended {
                flags |= RE_ROW_FLAG_EXTENDED;
            }
            if r.fd_seen {
                flags |= RE_ROW_FLAG_FD;
            }
            if r.has_diff() {
                flags |= RE_ROW_FLAG_HAS_DIFF;
            }
            if r.is_new {
                flags |= RE_ROW_FLAG_NEW;
            }
            out.push(r.bus);
            out.push(flags);
            out.push(r.dlc_bytes);
            out.push(0);
            out.extend_from_slice(&r.arb_id.to_le_bytes());
            out.extend_from_slice(&r.rx_count.to_le_bytes());
            for bit in 0..n * 8 {
                out.push(re_heat(r.window_toggles[bit], r.window_rx));
            }
            for i in 0..n {
                out.push((r.diff_word(i / 8) >> ((i % 8) * 8)) as u8);
            }
            for i in 0..n {
                out.push((r.constant_word(i / 8) >> ((i % 8) * 8)) as u8);
            }
            // Amendment 13: latest payload, byte 0 first. `prev` is masked to `prev_len`
            // (bytes past a shorter last frame are 0; all-zero before the first frame).
            for i in 0..n {
                out.push((r.prev[i / 8] >> ((i % 8) * 8)) as u8);
            }
            r.dirty = false;
            r.is_new = false;
        }
        out[row_count_at..row_count_at + 2].copy_from_slice(&count.to_le_bytes());
    }
}

/// Chronological history copy of one row (see [`ReAnalyzer::row_history`]).
#[derive(Clone, Debug)]
pub struct ReRowHistory {
    pub bus: u8,
    pub arb_id: u32,
    pub is_extended: bool,
    pub dlc_bytes: u8,
    pub payloads: Vec<[u8; 64]>,
    pub ts_us: Vec<u64>,
}

impl ReRowHistory {
    pub fn classify(&self) -> ReClassificationDto {
        let r = classify_history(&self.payloads, &self.ts_us, usize::from(self.dlc_bytes));
        ReClassificationDto {
            bus: self.bus,
            arb_id: self.arb_id,
            is_extended: self.is_extended,
            samples: r.samples,
            bit_entropy: r.bit_entropy,
            fields: r.fields,
            period_ms: r.period_ms,
            jitter_ms: r.jitter_ms,
        }
    }
}

// ─── Shared state (engine <-> aggregator <-> snapshot thread) ───────────────

/// Analyzer + the `enabled` gate the aggregator reads once per batch (relaxed).
pub struct ReShared {
    enabled: AtomicBool,
    analyzer: Mutex<ReAnalyzer>,
    /// Correlation generation: a newer `cmd_re_correlate` cancels the running sweep.
    corr_gen: AtomicU64,
    /// R2c value scan state (never locked while the analyzer lock is held, and vice versa).
    scan: Mutex<ScanState>,
    /// R2c generation: a newer first / next / undo / reset cancels a running scan.
    scan_gen: AtomicU64,
    /// R2c wall-time budget per scan call (nanoseconds; test hook `scan_set_budget`).
    scan_budget_ns: AtomicU64,
}

impl Default for ReShared {
    fn default() -> Self {
        Self::new()
    }
}

impl ReShared {
    pub fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            analyzer: Mutex::new(ReAnalyzer::new()),
            corr_gen: AtomicU64::new(0),
            scan: Mutex::new(ScanState::default()),
            scan_gen: AtomicU64::new(0),
            scan_budget_ns: AtomicU64::new(RE_SCAN_BUDGET.as_nanos() as u64),
        }
    }

    /// Aggregator entry: ONE relaxed atomic load; when on, the analyzer lock for the batch.
    #[inline]
    pub fn batch(&self) -> Option<MutexGuard<'_, ReAnalyzer>> {
        if self.enabled.load(Ordering::Relaxed) {
            Some(self.analyzer.lock())
        } else {
            None
        }
    }

    /// Locks the analyzer (commands / snapshot thread).
    pub fn lock(&self) -> MutexGuard<'_, ReAnalyzer> {
        self.analyzer.lock()
    }

    /// `cmd_re_correlate`: copies the windows out under the lock (bounded), releases it, then
    /// sweeps on the **calling** thread (a worker, never the aggregator) with the 2 s budget.
    /// Starting a call bumps the generation, which cancels any older sweep still running
    /// (that one returns its partial result with `truncated = true`).
    pub fn correlate(&self, req: &ReCorrelateRequest) -> Result<ReCorrelationResultDto, ReError> {
        let gen = self.corr_gen.fetch_add(1, Ordering::AcqRel) + 1;
        let job = self.analyzer.lock().prepare_correlation(req)?;
        Ok(job.run(RE_CORRELATE_BUDGET, &|| {
            self.corr_gen.load(Ordering::Acquire) != gen
        }))
    }

    /// Publishes the analyzer's enabled state to the aggregator gate.
    pub fn sync_enabled(&self, a: &ReAnalyzer) {
        self.enabled.store(a.is_enabled(), Ordering::Relaxed);
    }
}

// ─── CRC / checksum primitives ─────────────────────────────────────────────

const fn crc8_table(poly: u8) -> [u8; 256] {
    let mut t = [0u8; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u8;
        let mut j = 0;
        while j < 8 {
            c = if c & 0x80 != 0 {
                (c << 1) ^ poly
            } else {
                c << 1
            };
            j += 1;
        }
        t[i] = c;
        i += 1;
    }
    t
}

static CRC8_J1850_TABLE: [u8; 256] = crc8_table(0x1D);
static CRC8_H2F_TABLE: [u8; 256] = crc8_table(0x2F);

#[inline]
fn crc8_with(table: &[u8; 256], init: u8, data: impl Iterator<Item = u8>) -> u8 {
    let mut c = init;
    for b in data {
        c = table[usize::from(c ^ b)];
    }
    c ^ 0xFF
}

/// CRC8 SAE-J1850 (poly 0x1D, xorout 0xFF); standard init 0xFF (`"123456789"` -> `0x4B`).
pub fn crc8_j1850(data: &[u8], init: u8) -> u8 {
    crc8_with(&CRC8_J1850_TABLE, init, data.iter().copied())
}

/// CRC8 AUTOSAR H2F (poly 0x2F, xorout 0xFF); standard init 0xFF (`"123456789"` -> `0xDF`).
pub fn crc8_h2f(data: &[u8], init: u8) -> u8 {
    crc8_with(&CRC8_H2F_TABLE, init, data.iter().copied())
}

fn checksum_of(algo: ReChecksumAlgo, init: u8, data: impl Iterator<Item = u8>) -> u8 {
    match algo {
        ReChecksumAlgo::Xor8 => data.fold(init, |a, b| a ^ b),
        ReChecksumAlgo::Sum8 => data.fold(init, |a, b| a.wrapping_add(b)),
        ReChecksumAlgo::Crc8J1850 | ReChecksumAlgo::Crc8Custom => {
            crc8_with(&CRC8_J1850_TABLE, init, data)
        }
        ReChecksumAlgo::Crc8H2f => crc8_with(&CRC8_H2F_TABLE, init, data),
    }
}

// ─── Classifier (§2.3) ─────────────────────────────────────────────────────

/// Pure classifier output (row identity added by [`ReRowHistory::classify`]).
#[derive(Clone, Debug, PartialEq)]
pub struct ReClassifyResult {
    pub samples: u32,
    pub bit_entropy: Vec<f64>,
    pub fields: Vec<ReFieldDto>,
    pub period_ms: Option<f64>,
    pub jitter_ms: Option<f64>,
}

#[inline]
fn bit_of(p: &[u8; 64], bit: usize) -> bool {
    (p[bit / 8] >> (bit % 8)) & 1 != 0
}

/// Intel extraction (`start` = LSB, `len <= 64`) over the 64-byte payload.
pub fn re_extract_intel(p: &[u8; 64], start: usize, len: usize) -> u64 {
    let mut v = 0u64;
    for k in 0..len.min(64) {
        let pos = start + k;
        if pos < 512 && bit_of(p, pos) {
            v |= 1u64 << k;
        }
    }
    v
}

/// Motorola (DBC sawtooth) extraction (`msb` = start bit, `len <= 64`).
pub fn re_extract_motorola(p: &[u8; 64], msb: usize, len: usize) -> u64 {
    let mut v = 0u64;
    let mut byte = msb / 8;
    let mut bib = msb % 8;
    for _ in 0..len.min(64) {
        if byte >= 64 {
            break;
        }
        v = (v << 1) | u64::from((p[byte] >> bib) & 1);
        if bib == 0 {
            byte += 1;
            bib = 7;
        } else {
            bib -= 1;
        }
    }
    v
}

/// Intel bit indices covered by a Motorola field.
fn motorola_bits(msb: usize, len: usize) -> Vec<usize> {
    let mut out = Vec::with_capacity(len);
    let mut byte = msb / 8;
    let mut bib = msb % 8;
    for _ in 0..len {
        out.push(byte * 8 + bib);
        if bib == 0 {
            byte += 1;
            bib = 7;
        } else {
            bib -= 1;
        }
    }
    out
}

struct Bits512([u64; 8]);

impl Bits512 {
    fn new() -> Self {
        Self([0; 8])
    }
    #[inline]
    fn get(&self, b: usize) -> bool {
        (self.0[b / 64] >> (b % 64)) & 1 != 0
    }
    #[inline]
    fn set(&mut self, b: usize) {
        self.0[b / 64] |= 1u64 << (b % 64);
    }
}

fn byte_ranges(bytes: impl Iterator<Item = usize>) -> String {
    let v: Vec<usize> = bytes.collect();
    let mut s = String::new();
    let mut i = 0;
    while i < v.len() {
        let a = v[i];
        let mut j = i;
        while j + 1 < v.len() && v[j + 1] == v[j] + 1 {
            j += 1;
        }
        if !s.is_empty() {
            s.push(',');
        }
        if j == i {
            let _ = write!(s, "{a}");
        } else {
            let _ = write!(s, "{a}-{}", v[j]);
        }
        i = j + 1;
    }
    s
}

/// Smoothness of a value series: `(mean|Δ| / range) + fraction of |Δ| > range/2`. Lower is
/// smoother; `INFINITY` when constant.
fn smoothness(vals: &[u64]) -> f64 {
    let (mn, mx) = vals
        .iter()
        .fold((u64::MAX, 0u64), |(a, b), &v| (a.min(v), b.max(v)));
    if vals.len() < 2 || mx == mn {
        return f64::INFINITY;
    }
    let range = (mx - mn) as f64;
    let mut sum = 0.0;
    let mut jumps = 0usize;
    for w in vals.windows(2) {
        let d = w[0].abs_diff(w[1]) as f64;
        sum += d;
        if d > range / 2.0 {
            jumps += 1;
        }
    }
    let pairs = (vals.len() - 1) as f64;
    sum / pairs / range + jumps as f64 / pairs
}

const PHYSICAL_MAX_SCORE: f64 = 0.2;

/// §2.3 classifier over a chronological payload history (`dlc_bytes` = row payload length).
pub fn classify_history(
    payloads: &[[u8; 64]],
    ts_us: &[u64],
    dlc_bytes: usize,
) -> ReClassifyResult {
    let n = dlc_bytes.min(64);
    let nbits = n * 8;
    let samples = payloads.len();

    // Bit statistics.
    let mut ones = vec![0usize; nbits];
    let mut flips = vec![0usize; nbits];
    for (i, p) in payloads.iter().enumerate() {
        for (b, o) in ones.iter_mut().enumerate() {
            if bit_of(p, b) {
                *o += 1;
            }
        }
        if i > 0 {
            let q = &payloads[i - 1];
            for (b, f) in flips.iter_mut().enumerate() {
                if bit_of(p, b) != bit_of(q, b) {
                    *f += 1;
                }
            }
        }
    }
    let bit_entropy: Vec<f64> = ones
        .iter()
        .map(|&o| {
            if samples == 0 || o == 0 || o == samples {
                0.0
            } else {
                let p = o as f64 / samples as f64;
                -(p * p.log2() + (1.0 - p) * (1.0 - p).log2())
            }
        })
        .collect();

    let (period_ms, jitter_ms) = if ts_us.len() >= 2 {
        let d: Vec<f64> = ts_us
            .windows(2)
            .map(|w| w[1].saturating_sub(w[0]) as f64 / 1000.0)
            .collect();
        let mean = d.iter().sum::<f64>() / d.len() as f64;
        let var = d.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / d.len() as f64;
        (Some(mean), Some(var.sqrt()))
    } else {
        (None, None)
    };

    let mut fields = Vec::new();
    if samples >= RE_MIN_CLASSIFY_SAMPLES && n > 0 {
        let constant = |b: usize| flips[b] == 0 && (ones[b] == 0 || ones[b] == samples);
        let pairs = (samples - 1) as f64;
        let mut claimed = Bits512::new();

        // 1. Counters: aligned 8 / 4 / 2-bit, +1 mod 2^n, <= 10 % gaps, widest on ties.
        let counter_score = |start: usize, len: usize| -> f64 {
            let m = 1u64 << len;
            let mut ok = 0usize;
            for w in payloads.windows(2) {
                let a = re_extract_intel(&w[0], start, len);
                let b = re_extract_intel(&w[1], start, len);
                if (b + m - a) % m == 1 {
                    ok += 1;
                }
            }
            ok as f64 / pairs
        };
        let emit_counter =
            |fields: &mut Vec<ReFieldDto>, claimed: &mut Bits512, s: usize, l: usize, sc: f64| {
                let mut f = ReFieldDto::new(
                    s as u16,
                    l as u16,
                    ReByteOrder::Intel,
                    ReFieldKind::Counter,
                    sc,
                );
                f.counter_modulo = Some(1u32 << l);
                f.counter_step = Some(1);
                fields.push(f);
                for b in s..s + l {
                    claimed.set(b);
                }
            };
        for byte in 0..n {
            let base = byte * 8;
            let s8 = counter_score(base, 8);
            let s4 = [counter_score(base, 4), counter_score(base + 4, 4)];
            if s8 >= 0.9 && s8 >= s4[0].max(s4[1]) {
                emit_counter(&mut fields, &mut claimed, base, 8, s8);
                continue;
            }
            for (nib, &sn) in s4.iter().enumerate() {
                let nb = base + nib * 4;
                let s2 = [counter_score(nb, 2), counter_score(nb + 2, 2)];
                if sn >= 0.9 && sn >= s2[0].max(s2[1]) {
                    emit_counter(&mut fields, &mut claimed, nb, 4, sn);
                    continue;
                }
                for (pi, &sp) in s2.iter().enumerate() {
                    if sp >= 0.9 {
                        emit_counter(&mut fields, &mut claimed, nb + pi * 2, 2, sp);
                    }
                }
            }
        }

        // 2. Checksum: one non-constant unclaimed byte matching >= 95 % over the other bytes
        //    (ascending order, checksum byte skipped). XOR8 first, scanning from the LAST byte
        //    (amendment 6: XOR8 is position-symmetric -> report dlcBytes-1), then SUM8 / CRC8
        //    from byte 0 upward.
        if n >= 2 {
            const XOR_CANDIDATES: [(ReChecksumAlgo, u8); 2] =
                [(ReChecksumAlgo::Xor8, 0x00), (ReChecksumAlgo::Xor8, 0xFF)];
            const OTHER_CANDIDATES: [(ReChecksumAlgo, u8); 6] = [
                (ReChecksumAlgo::Sum8, 0x00),
                (ReChecksumAlgo::Sum8, 0xFF),
                (ReChecksumAlgo::Crc8J1850, 0xFF),
                (ReChecksumAlgo::Crc8J1850, 0x00),
                (ReChecksumAlgo::Crc8H2f, 0xFF),
                (ReChecksumAlgo::Crc8H2f, 0x00),
            ];
            let eligible = |claimed: &Bits512, pos: usize| {
                let base = pos * 8;
                !(base..base + 8).any(|b| claimed.get(b)) && !(base..base + 8).all(constant)
            };
            let match_rate = |pos: usize, algo: ReChecksumAlgo, init: u8| {
                let hits = payloads
                    .iter()
                    .filter(|p| {
                        let it = (0..n).filter(|&i| i != pos).map(|i| p[i]);
                        checksum_of(algo, init, it) == p[pos]
                    })
                    .count();
                hits as f64 / samples as f64
            };
            let mut found: Option<(usize, ReChecksumAlgo, u8, f64)> = None;
            'xor: for pos in (0..n).rev() {
                if !eligible(&claimed, pos) {
                    continue;
                }
                for &(algo, init) in &XOR_CANDIDATES {
                    let rate = match_rate(pos, algo, init);
                    if rate >= 0.95 {
                        found = Some((pos, algo, init, rate));
                        break 'xor;
                    }
                }
            }
            if found.is_none() {
                'other: for pos in 0..n {
                    if !eligible(&claimed, pos) {
                        continue;
                    }
                    for &(algo, init) in &OTHER_CANDIDATES {
                        let rate = match_rate(pos, algo, init);
                        if rate >= 0.95 {
                            found = Some((pos, algo, init, rate));
                            break 'other;
                        }
                    }
                }
            }
            if let Some((pos, algo, init, rate)) = found {
                let base = pos * 8;
                let mut f = ReFieldDto::new(
                    base as u16,
                    8,
                    ReByteOrder::Intel,
                    ReFieldKind::Checksum,
                    rate,
                );
                f.checksum_algo = Some(algo);
                f.checksum_init = Some(init);
                f.checksum_coverage = Some(byte_ranges((0..n).filter(|&i| i != pos)));
                fields.push(f);
                for b in base..base + 8 {
                    claimed.set(b);
                }
            }
        }

        // 3. Physical: byte runs seeded by "busy" (non-constant, non-rare) unclaimed bits;
        //    a rare-only neighbour byte is absorbed only if it turns a non-smooth core smooth.
        let rare = |b: usize| !constant(b) && (flips[b] as f64) < 0.05 * pairs;
        let active = |claimed: &Bits512, b: usize| !claimed.get(b) && !constant(b);
        let busy = |claimed: &Bits512, b: usize| active(claimed, b) && !rare(b);
        let byte_busy = |claimed: &Bits512, y: usize| (y * 8..y * 8 + 8).any(|b| busy(claimed, b));
        let byte_active =
            |claimed: &Bits512, y: usize| (y * 8..y * 8 + 8).any(|b| active(claimed, b));

        // Candidate (order, start, len, covered bits) for bytes g0..=g1, or None if invalid.
        let candidate = |claimed: &Bits512,
                         g0: usize,
                         g1: usize,
                         order: ReByteOrder|
         -> Option<(usize, usize, Vec<usize>)> {
            let lo_act = (g0 * 8..g0 * 8 + 8).find(|&b| active(claimed, b))?;
            let hi_act_g0 = (g0 * 8..g0 * 8 + 8).rev().find(|&b| active(claimed, b))?;
            let hi_act_g1 = (g1 * 8..g1 * 8 + 8).rev().find(|&b| active(claimed, b))?;
            let lo_act_g1 = (g1 * 8..g1 * 8 + 8).find(|&b| active(claimed, b))?;
            let (start, len, bits) = match order {
                ReByteOrder::Intel => {
                    let len = hi_act_g1 - lo_act + 1;
                    (lo_act, len, (lo_act..=hi_act_g1).collect::<Vec<_>>())
                }
                ReByteOrder::Motorola => {
                    if g0 == g1 {
                        return None;
                    }
                    let msb_k = hi_act_g0 % 8;
                    let lsb_k = lo_act_g1 % 8;
                    let len = (msb_k + 1) + 8 * (g1 - g0 - 1) + (8 - lsb_k);
                    (hi_act_g0, len, motorola_bits(hi_act_g0, len))
                }
            };
            if len > 64 || bits.iter().any(|&b| claimed.get(b)) {
                return None;
            }
            Some((start, len, bits))
        };
        let evaluate = |claimed: &Bits512,
                        g0: usize,
                        g1: usize|
         -> Option<(f64, ReByteOrder, usize, usize, Vec<usize>)> {
            let mut best: Option<(f64, ReByteOrder, usize, usize, Vec<usize>)> = None;
            for order in [ReByteOrder::Intel, ReByteOrder::Motorola] {
                if let Some((s, l, bits)) = candidate(claimed, g0, g1, order) {
                    let vals: Vec<u64> = payloads
                        .iter()
                        .map(|p| match order {
                            ReByteOrder::Intel => re_extract_intel(p, s, l),
                            ReByteOrder::Motorola => re_extract_motorola(p, s, l),
                        })
                        .collect();
                    let sc = smoothness(&vals);
                    if best.as_ref().is_none_or(|b| sc < b.0) {
                        best = Some((sc, order, s, l, bits));
                    }
                }
            }
            best
        };

        let mut used_byte = [false; 64];
        let mut y = 0;
        while y < n {
            if !byte_busy(&claimed, y) {
                y += 1;
                continue;
            }
            let g0 = y;
            let mut g1 = y;
            while g1 + 1 < n && g1 + 1 - g0 < 4 && byte_busy(&claimed, g1 + 1) {
                g1 += 1;
            }
            y = g1 + 1;

            let mut choice = evaluate(&claimed, g0, g1);
            let core_ok = choice.as_ref().is_some_and(|c| c.0 <= PHYSICAL_MAX_SCORE);
            if !core_ok && g1 - g0 < 3 {
                let mut ext = Vec::new();
                if g0 > 0
                    && !used_byte[g0 - 1]
                    && byte_active(&claimed, g0 - 1)
                    && !byte_busy(&claimed, g0 - 1)
                {
                    ext.push((g0 - 1, g1));
                }
                if g1 + 1 < n && byte_active(&claimed, g1 + 1) && !byte_busy(&claimed, g1 + 1) {
                    ext.push((g0, g1 + 1));
                }
                for (a, b) in ext {
                    if let Some(c) = evaluate(&claimed, a, b) {
                        if c.0 <= PHYSICAL_MAX_SCORE && choice.as_ref().is_none_or(|x| c.0 < x.0) {
                            choice = Some(c);
                            if b > g1 {
                                y = b + 1;
                            }
                        }
                    }
                }
            }
            match choice {
                Some((sc, order, s, l, bits)) => {
                    let vals: Vec<u64> = payloads
                        .iter()
                        .map(|p| match order {
                            ReByteOrder::Intel => re_extract_intel(p, s, l),
                            ReByteOrder::Motorola => re_extract_motorola(p, s, l),
                        })
                        .collect();
                    let (kind, conf) = if l >= 2 && sc <= PHYSICAL_MAX_SCORE {
                        (
                            ReFieldKind::Physical,
                            0.1 + 0.9 * (1.0 - sc / PHYSICAL_MAX_SCORE),
                        )
                    } else {
                        (ReFieldKind::Unknown, 0.0)
                    };
                    let mut f = ReFieldDto::new(s as u16, l as u16, order, kind, conf);
                    f.min = vals.iter().min().map(|&v| v as f64);
                    f.max = vals.iter().max().map(|&v| v as f64);
                    fields.push(f);
                    for &b in &bits {
                        claimed.set(b);
                        used_byte[b / 8] = true;
                    }
                }
                None => {
                    // Fallback: contiguous unclaimed segments containing busy bits -> unknown.
                    for yy in g0..=g1 {
                        let mut b = yy * 8;
                        while b < yy * 8 + 8 {
                            if claimed.get(b) {
                                b += 1;
                                continue;
                            }
                            let s = b;
                            while b < yy * 8 + 8 && !claimed.get(b) {
                                b += 1;
                            }
                            if (s..b).any(|x| busy(&claimed, x)) {
                                let mut f = ReFieldDto::new(
                                    s as u16,
                                    (b - s) as u16,
                                    ReByteOrder::Intel,
                                    ReFieldKind::Unknown,
                                    0.0,
                                );
                                let vals: Vec<u64> = payloads
                                    .iter()
                                    .map(|p| re_extract_intel(p, s, b - s))
                                    .collect();
                                f.min = vals.iter().min().map(|&v| v as f64);
                                f.max = vals.iter().max().map(|&v| v as f64);
                                fields.push(f);
                                for x in s..b {
                                    claimed.set(x);
                                }
                            }
                        }
                    }
                    used_byte[g0..=g1].fill(true);
                }
            }
        }

        // 4. Flags (rare 1-bit) and leftover active bits.
        for b in 0..nbits {
            if !active(&claimed, b) {
                continue;
            }
            let rate = flips[b] as f64 / pairs;
            let (kind, conf) = if rate < 0.05 {
                (ReFieldKind::Flag, 0.6 + 0.4 * bit_entropy[b].min(1.0))
            } else {
                (ReFieldKind::Unknown, 0.0)
            };
            let mut f = ReFieldDto::new(b as u16, 1, ReByteOrder::Intel, kind, conf);
            f.min = Some(0.0);
            f.max = Some(1.0);
            fields.push(f);
            claimed.set(b);
        }

        // 5. Constant runs over the remaining bits.
        let mut b = 0;
        while b < nbits {
            if claimed.get(b) {
                b += 1;
                continue;
            }
            let s = b;
            while b < nbits && !claimed.get(b) {
                b += 1;
            }
            let l = b - s;
            let mut f = ReFieldDto::new(
                s as u16,
                l as u16,
                ReByteOrder::Intel,
                ReFieldKind::Constant,
                1.0,
            );
            if l <= 52 {
                let v = re_extract_intel(&payloads[0], s, l) as f64;
                f.min = Some(v);
                f.max = Some(v);
            }
            fields.push(f);
        }

        fields.sort_by_key(|f| f.start_bit);
    }

    ReClassifyResult {
        samples: samples as u32,
        bit_entropy,
        fields,
        period_ms,
        jitter_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_core::CanIdKey;

    fn std_f(bus: u8, id: u16, d: &[u8], ts: u64) -> RawCanFrame {
        RawCanFrame::new_classical(bus, CanIdKey::new_standard(id).unwrap(), d, ts).unwrap()
    }
    fn fd_f(bus: u8, id: u32, d: &[u8], ts: u64) -> RawCanFrame {
        RawCanFrame::new_fd(bus, CanIdKey::new_extended(id).unwrap(), d, false, ts).unwrap()
    }
    fn started() -> ReAnalyzer {
        let mut a = ReAnalyzer::new();
        a.start(None);
        a
    }
    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }
    struct Lcg(u32);
    impl Lcg {
        fn next(&mut self) -> u8 {
            self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (self.0 >> 24) as u8
        }
    }
    fn classify_frames(frames: &[[u8; 8]]) -> ReClassifyResult {
        let p: Vec<[u8; 64]> = frames
            .iter()
            .map(|f| {
                let mut x = [0u8; 64];
                x[..8].copy_from_slice(f);
                x
            })
            .collect();
        let ts: Vec<u64> = (0..frames.len() as u64).map(|i| i * 10_000).collect();
        classify_history(&p, &ts, 8)
    }
    fn field(r: &ReClassifyResult, kind: ReFieldKind, start: u16) -> &ReFieldDto {
        r.fields
            .iter()
            .find(|f| f.kind == kind && f.start_bit == start)
            .unwrap_or_else(|| panic!("{kind:?}@{start} not in {:#?}", r.fields))
    }

    #[test]
    fn re_off_by_default_and_error_rtr_excluded() {
        let mut a = ReAnalyzer::new();
        a.ingest(&std_f(0, 1, &[1], 1));
        assert_eq!(a.status().rows, 0);
        a.start(None);
        assert_eq!(a.phase(), RePhase::Free);
        let mut e = std_f(0, 2, &[1], 2);
        e.flags |= FLAG_ERROR;
        a.ingest(&e);
        a.ingest(&RawCanFrame::new_rtr(0, CanIdKey::new_standard(3).unwrap(), 8, 3).unwrap());
        assert_eq!(a.status().rows, 0);
        assert_eq!(a.status().frames_ingested, 0);
    }

    #[test]
    fn re_toggle_counts_exact_on_scripted_frames() {
        let mut a = started();
        let script: [[u8; 8]; 5] = [
            [0x00, 0, 0, 0, 0, 0, 0, 0x00],
            [0x01, 0, 0, 0, 0, 0, 0, 0x80],
            [0x03, 0, 0, 0, 0, 0, 0, 0x80],
            [0x02, 0, 0, 0, 0, 0, 0, 0x00],
            [0x02, 0xFF, 0, 0, 0, 0, 0, 0x00],
        ];
        for (i, d) in script.iter().enumerate() {
            a.ingest(&std_f(0, 0x10, d, i as u64));
        }
        let d = a.row_detail(0, 0x10, false).unwrap();
        let mut want = vec![0u32; 64];
        want[0] = 2; // bit0: 00->01, 03->02
        want[1] = 1; // 01->03
        want[63] = 2;
        for w in &mut want[8..16] {
            *w = 1;
        }
        assert_eq!(d.toggles, want);
        assert_eq!(d.rx_count, 5);
        assert_eq!(d.history_len, 5);
    }

    #[test]
    fn re_canfd_bit_511_counted() {
        let mut a = started();
        let mut d = [0u8; 64];
        for i in 0..5u8 {
            d[63] = (i & 1) << 7;
            a.ingest(&fd_f(1, 0x1234, &d, u64::from(i)));
        }
        let r = a.row_detail(1, 0x1234, true).unwrap();
        assert_eq!(r.toggles.len(), 512);
        assert_eq!(r.toggles[511], 4);
        assert_eq!(r.toggles.iter().sum::<u32>(), 4);
        let cm = hex(&r.constant_mask);
        assert_eq!(cm[63], 0x7F);
    }

    #[test]
    fn re_dlc_growth_adopts_new_bytes_without_toggles() {
        let mut a = started();
        a.ingest(&std_f(0, 5, &[0xFF; 4], 0));
        a.ingest(&std_f(0, 5, &[0xFF; 8], 1));
        let r = a.row_detail(0, 5, false).unwrap();
        assert_eq!(r.dlc_bytes, 8);
        assert!(r.toggles.iter().all(|&t| t == 0));
    }

    #[test]
    fn re_baseline_action_diff_semantics() {
        let mut a = started();
        let mut ts = 0;
        let mut push = |a: &mut ReAnalyzer, b: u8| {
            ts += 1;
            a.ingest(&std_f(0, 0x20, &[b], ts));
        };
        push(&mut a, 0);
        a.set_phase(RePhase::Baseline);
        for i in 0..4u8 {
            push(&mut a, i & 1); // bit0 noise
        }
        a.set_phase(RePhase::Action);
        for i in 0..4u8 {
            push(&mut a, (i & 1) | ((i & 1) << 3)); // bit0 + bit3
        }
        let d = a.row_detail(0, 0x20, false).unwrap();
        assert_eq!(d.baseline_mask, "01");
        assert_eq!(d.action_mask, "09");
        assert_eq!(d.diff_mask, "08");
        assert_eq!(hex(&d.noisy_mask)[0] & 1, 1, "baseline toggler is noisy");
        a.set_phase(RePhase::Action);
        assert_eq!(a.row_detail(0, 0x20, false).unwrap().diff_mask, "00");
    }

    #[test]
    fn re_constant_mask_and_uppercase_hex() {
        let mut a = started();
        a.ingest(&std_f(0, 0x30, &[0xAA, 0x00], 0));
        a.ingest(&std_f(0, 0x30, &[0xAB, 0x00], 1));
        let d = a.row_detail(0, 0x30, false).unwrap();
        assert_eq!(d.constant_mask, "FEFF");
    }

    #[test]
    fn re_history_ring_wraps_chronologically() {
        let mut a = started();
        for i in 0..100u32 {
            a.ingest(&std_f(0, 0x40, &[i as u8], u64::from(i)));
        }
        let h = a.row_history(0, 0x40, false).unwrap();
        assert_eq!(h.payloads.len(), 64);
        assert_eq!(h.payloads[0][0], 36);
        assert_eq!(h.payloads[63][0], 99);
        assert_eq!(h.ts_us[0], 36);
    }

    #[test]
    fn re_overflow_counts_frames_beyond_max_rows() {
        let mut a = started();
        for id in 0..MAX_RE_ROWS as u32 + 3 {
            a.ingest(&fd_f(0, id, &[0; 8], 0));
        }
        a.ingest(&fd_f(0, MAX_RE_ROWS as u32, &[0; 8], 0));
        let s = a.status();
        assert_eq!(s.rows as usize, MAX_RE_ROWS);
        assert_eq!(s.overflow_rows, 4);
    }

    #[test]
    fn re_markers_truncate_and_cap() {
        let mut a = started();
        let m = a.mark(&"ğ".repeat(70));
        assert_eq!(m.label.chars().count(), 64);
        for i in 0..1100 {
            a.mark(&format!("{i}"));
        }
        let ms = a.markers();
        assert_eq!(ms.len(), MAX_RE_MARKERS);
        assert_eq!(ms.last().unwrap().label, "1099");
    }

    #[test]
    fn re_crc8_known_vectors() {
        assert_eq!(crc8_j1850(b"123456789", 0xFF), 0x4B);
        assert_eq!(crc8_h2f(b"123456789", 0xFF), 0xDF);
    }

    #[test]
    fn re_heat_curve() {
        assert_eq!(re_heat(0, 100), 0);
        assert_eq!(re_heat(1, 60_000), 1);
        assert_eq!(re_heat(50, 100), RE_HEAT_NOISY_THRESHOLD);
        assert_eq!(re_heat(100, 100), 255);
        assert_eq!(re_heat(u16::MAX, 10), 255);
    }

    #[test]
    fn re_classifier_needs_16_samples() {
        let frames: Vec<[u8; 8]> = (0..15u8).map(|i| [i, 0, 0, 0, 0, 0, 0, 0]).collect();
        let r = classify_frames(&frames);
        assert_eq!(r.samples, 15);
        assert!(r.fields.is_empty());
        assert_eq!(r.bit_entropy.len(), 64);
        assert!((r.period_ms.unwrap() - 10.0).abs() < 1e-9);
        assert!(r.jitter_ms.unwrap() < 1e-9);
    }

    #[test]
    fn re_classifier_4bit_counter_in_high_nibble() {
        let mut rng = Lcg(3);
        let frames: Vec<[u8; 8]> = (0..48u8)
            .map(|i| [((i % 16) << 4) | 0x0A, rng.next(), 0, 0, 0, 0, 0, 0])
            .collect();
        let r = classify_frames(&frames);
        let f = field(&r, ReFieldKind::Counter, 4);
        assert_eq!(
            (f.bit_length, f.counter_modulo, f.counter_step),
            (4, Some(16), Some(1))
        );
        assert_eq!(field(&r, ReFieldKind::Constant, 0).bit_length, 4);
    }

    #[test]
    fn re_classifier_8bit_counter() {
        let frames: Vec<[u8; 8]> = (0..40u32)
            .map(|i| [0, (250 + i) as u8, 0, 0, 0, 0, 0, 0])
            .collect();
        let r = classify_frames(&frames);
        let f = field(&r, ReFieldKind::Counter, 8);
        assert_eq!((f.bit_length, f.counter_modulo), (8, Some(256)));
    }

    fn cs_frames(pos: usize, f: impl Fn(&[u8]) -> u8) -> Vec<[u8; 8]> {
        let mut rng = Lcg(77 + pos as u32);
        (0..40)
            .map(|_| {
                let mut d = [0u8; 8];
                for (k, x) in d.iter_mut().enumerate() {
                    if k != pos {
                        *x = rng.next();
                    }
                }
                let o: Vec<u8> = (0..8).filter(|&k| k != pos).map(|k| d[k]).collect();
                d[pos] = f(&o);
                d
            })
            .collect()
    }

    #[test]
    fn re_classifier_xor8_reports_last_byte() {
        let r = classify_frames(&cs_frames(2, |o| o.iter().fold(0, |a, b| a ^ b)));
        let f = field(&r, ReFieldKind::Checksum, 56);
        assert_eq!(f.checksum_algo, Some(ReChecksumAlgo::Xor8));
        assert_eq!(f.checksum_coverage.as_deref(), Some("0-6"));
    }

    #[test]
    fn re_classifier_sum8() {
        let r = classify_frames(&cs_frames(3, |o| {
            o.iter().fold(0xFFu8, |a, b| a.wrapping_add(*b))
        }));
        let f = field(&r, ReFieldKind::Checksum, 24);
        assert_eq!(
            (f.checksum_algo, f.checksum_init),
            (Some(ReChecksumAlgo::Sum8), Some(0xFF))
        );
        assert_eq!(f.checksum_coverage.as_deref(), Some("0-2,4-7"));
    }

    #[test]
    fn re_classifier_crc8_j1850_with_init_sweep() {
        let r = classify_frames(&cs_frames(7, |o| crc8_j1850(o, 0xFF)));
        let f = field(&r, ReFieldKind::Checksum, 56);
        assert_eq!(
            (f.checksum_algo, f.checksum_init),
            (Some(ReChecksumAlgo::Crc8J1850), Some(0xFF))
        );
        let r0 = classify_frames(&cs_frames(0, |o| crc8_j1850(o, 0x00)));
        let f0 = field(&r0, ReFieldKind::Checksum, 0);
        assert_eq!(
            (f0.checksum_algo, f0.checksum_init),
            (Some(ReChecksumAlgo::Crc8J1850), Some(0x00))
        );
    }

    #[test]
    fn re_classifier_crc8_h2f() {
        let r = classify_frames(&cs_frames(0, |o| crc8_h2f(o, 0xFF)));
        let f = field(&r, ReFieldKind::Checksum, 0);
        assert_eq!(f.checksum_algo, Some(ReChecksumAlgo::Crc8H2f));
        assert!(f.confidence >= 0.95);
    }

    #[test]
    fn re_classifier_flag() {
        let frames: Vec<[u8; 8]> = (0..64)
            .map(|i| [0x11, if i >= 40 { 0x20 } else { 0 }, 0, 0, 0, 0, 0, 0])
            .collect();
        let r = classify_frames(&frames);
        assert_eq!(field(&r, ReFieldKind::Flag, 13).bit_length, 1);
    }

    fn ramp(motorola: bool) -> Vec<[u8; 8]> {
        (0..40u32)
            .map(|i| {
                // Smooth triangle-ish value 300..~3500, rare MSB-byte changes.
                let v = (300 + ((i * 83) % 3200)) as u16;
                let [lo, hi] = v.to_le_bytes();
                let (a, b) = if motorola { (hi, lo) } else { (lo, hi) };
                [0, a, b, 0, 0, 0, 0, 0]
            })
            .collect()
    }

    #[test]
    fn re_classifier_physical_intel_vs_motorola() {
        let r = classify_frames(&ramp(false));
        let f = r
            .fields
            .iter()
            .find(|f| f.kind == ReFieldKind::Physical)
            .expect("physical intel");
        assert_eq!(f.byte_order, ReByteOrder::Intel);
        assert_eq!(f.start_bit, 8);
        assert!(f.bit_length >= 12);

        let r = classify_frames(&ramp(true));
        let f = r
            .fields
            .iter()
            .find(|f| f.kind == ReFieldKind::Physical)
            .expect("physical motorola");
        assert_eq!(f.byte_order, ReByteOrder::Motorola);
        assert_eq!(f.start_bit / 8, 1, "Motorola MSB start bit in byte 1");
        let bits = motorola_bits(usize::from(f.start_bit), usize::from(f.bit_length));
        assert!(bits.iter().all(|b| (8..24).contains(b)));
        assert!(bits.contains(&16), "LSB of byte 2 covered");
    }

    #[test]
    fn re_classifier_fields_non_overlapping_sorted_fd() {
        let mut rng = Lcg(9);
        let p: Vec<[u8; 64]> = (0..64u8)
            .map(|i| {
                let mut x = [0u8; 64];
                x[0] = i;
                for y in x.iter_mut().skip(10).take(20) {
                    *y = rng.next();
                }
                x[63] = if i > 60 { 0x80 } else { 0 };
                x
            })
            .collect();
        let ts: Vec<u64> = (0..64).collect();
        let r = classify_history(&p, &ts, 64);
        assert_eq!(r.bit_entropy.len(), 512);
        let mut used = Bits512::new();
        let mut prev = 0;
        for f in &r.fields {
            assert!(f.start_bit >= prev);
            prev = f.start_bit;
            let bits: Vec<usize> = match f.byte_order {
                ReByteOrder::Intel => {
                    (usize::from(f.start_bit)..usize::from(f.start_bit + f.bit_length)).collect()
                }
                ReByteOrder::Motorola => {
                    motorola_bits(usize::from(f.start_bit), usize::from(f.bit_length))
                }
            };
            for b in bits {
                assert!(b < 512 && !used.get(b), "overlap at {b}");
                used.set(b);
            }
        }
        assert_eq!(used.0, [u64::MAX; 8], "fields cover every bit");
        assert_eq!(field(&r, ReFieldKind::Flag, 511).bit_length, 1);
        assert_eq!(field(&r, ReFieldKind::Counter, 0).bit_length, 8);
    }

    // ─── Snapshot encoder golden bytes ──────────────────────────────────────

    /// Deterministic golden scenario shared with the TS codec test
    /// (`tests/fixtures/re_snapshot_golden.bin` + `.json`).
    fn golden_analyzer() -> ReAnalyzer {
        let mut a = started();
        a.set_phase(RePhase::Baseline);
        for i in 0..4u8 {
            a.ingest(&std_f(
                2,
                0x123,
                &[i & 1, 0x55, 0, 0, 0, 0, 0, 0xF0 | (i >> 1)],
                1_000 + u64::from(i),
            ));
        }
        a.set_phase(RePhase::Action);
        for i in 0..6u8 {
            let mut d = [0u8; 64];
            d[0] = 0xA5;
            d[8] = i; // bits 64..66 toggle at different rates
            d[63] = (i & 1) << 7; // bit 511
            a.ingest(&fd_f(5, 0x18FF_0001, &d, 2_000 + u64::from(i)));
        }
        // Classic row also moves bit 1 during action -> diff.
        a.ingest(&std_f(2, 0x123, &[0x03, 0x55, 0, 0, 0, 0, 0, 0xF1], 3_000));
        a
    }

    const GOLDEN_HEADER: [u8; 24] = [
        b'N', b'R', b'E', b'2', // magic
        0, 0, 0, 0, // seq 0
        0xB8, 0x0B, 0, 0, 0, 0, 0, 0, // tsUs 3000
        3, 1, // phase action, full
        2, 0, 2, 0, 0, 0, // rowCount 2, totalRows 2, reserved
    ];

    #[test]
    fn re_snapshot_golden_bytes() {
        let mut a = golden_analyzer();
        let mut out = Vec::with_capacity(RE_SNAPSHOT_MAX_BYTES);
        a.encode_snapshot(&mut out, true);
        assert_eq!(out[..24], GOLDEN_HEADER);
        // Classic row header + diff/constant literal bytes.
        let r0 = &out[24..];
        assert_eq!(
            r0[..12],
            [
                2,
                RE_ROW_FLAG_HAS_DIFF | RE_ROW_FLAG_NEW,
                8,
                0,
                0x23,
                0x01,
                0,
                0,
                5,
                0,
                0,
                0
            ]
        );
        let heat = &r0[12..12 + 64];
        // bit0: 0,1,0,1,1 -> 3 toggles / 5 frames; bit1: 1/5; bit56: F0,F0,F1,F1,F1 -> 1/5.
        assert_eq!(heat[0], re_heat(3, 5));
        assert_eq!(heat[1], re_heat(1, 5));
        assert_eq!(heat[56], re_heat(1, 5));
        assert!(heat
            .iter()
            .enumerate()
            .all(|(i, &h)| (h != 0) == matches!(i, 0 | 1 | 56)));
        assert_eq!(r0[76..84], [0x02, 0, 0, 0, 0, 0, 0, 0], "diff = bit1");
        assert_eq!(
            r0[84..92],
            [0xFC, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE],
            "constant"
        );
        assert_eq!(
            r0[92..100],
            [0x03, 0x55, 0, 0, 0, 0, 0, 0xF1],
            "data = last payload"
        );
        let r1 = &r0[100..];
        assert_eq!(
            r1[..12],
            [5, 0x0F, 64, 0, 0x01, 0x00, 0xFF, 0x18, 6, 0, 0, 0]
        );
        let r1_data = &r1[12 + 640..12 + 704];
        assert_eq!(r1_data[0], 0xA5);
        assert_eq!(r1_data[8], 5);
        assert_eq!(r1_data[63], 0x80, "last FD frame i=5 -> bit 511 set");
        assert!(r1_data
            .iter()
            .enumerate()
            .all(|(i, &b)| (b != 0) == matches!(i, 0 | 8 | 63)));
        assert_eq!(out.len(), 24 + 100 + 12 + 704);

        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/re_snapshot_golden.bin"
        );
        if std::env::var_os("RE_GOLDEN_UPDATE").is_some() {
            std::fs::write(path, &out).unwrap();
            std::fs::write(path.replace(".bin", ".json"), golden_json(&out)).unwrap();
        }
        let golden =
            std::fs::read(path).expect("golden fixture (RE_GOLDEN_UPDATE=1 to regenerate)");
        assert_eq!(
            out, golden,
            "encoder output drifted from the golden fixture"
        );

        // Second snapshot: nothing dirty, header only, seq 1, full 0.
        a.encode_snapshot(&mut out, false);
        assert_eq!(out.len(), 24);
        assert_eq!(out[4..8], [1, 0, 0, 0]);
        assert_eq!(out[17], 0);
        assert_eq!(out[18..20], [0, 0]);
    }

    /// Returns `(arbId, dlcBytes, data)` per row of an encoded v2 snapshot.
    fn snapshot_row_data(bin: &[u8]) -> Vec<(u32, usize, Vec<u8>)> {
        assert_eq!(bin[..4], *b"NRE2");
        let rows = usize::from(u16::from_le_bytes([bin[18], bin[19]]));
        let mut off = RE_SNAPSHOT_HEADER_BYTES;
        let mut v = Vec::new();
        for _ in 0..rows {
            let n = usize::from(bin[off + 2]);
            let id = u32::from_le_bytes(bin[off + 4..off + 8].try_into().unwrap());
            let data_at = off + RE_SNAPSHOT_ROW_HEADER_BYTES + n * 10;
            v.push((id, n, bin[data_at..data_at + n].to_vec()));
            off = data_at + n;
        }
        assert_eq!(off, bin.len(), "no trailing bytes");
        v
    }

    #[test]
    fn re_snapshot_v2_data_is_last_payload() {
        let mut a = started();
        let mut out = Vec::with_capacity(RE_SNAPSHOT_MAX_BYTES);
        // Classic 8-byte row: data = last payload, not the first.
        a.ingest(&std_f(0, 0x100, &[1, 2, 3, 4, 5, 6, 7, 8], 10));
        a.ingest(&std_f(
            0,
            0x100,
            &[0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x23, 0x45, 0x67],
            20,
        ));
        // FD 64-byte row with distinct bytes in every word.
        let fd: [u8; 64] = core::array::from_fn(|i| (i as u8).wrapping_mul(7).wrapping_add(1));
        a.ingest(&fd_f(1, 0x1ABC_DEF0, &[0xFF; 64], 30));
        a.ingest(&fd_f(1, 0x1ABC_DEF0, &fd, 40));
        a.encode_snapshot(&mut out, true);
        let rows = snapshot_row_data(&out);
        assert_eq!(
            rows[0],
            (
                0x100,
                8,
                vec![0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x23, 0x45, 0x67]
            )
        );
        assert_eq!(rows[1], (0x1ABC_DEF0, 64, fd.to_vec()));

        // Payload change marks the row dirty and the next dirty-only snapshot carries it.
        a.ingest(&std_f(0, 0x100, &[9, 9, 9, 9, 9, 9, 9, 9], 50));
        a.encode_snapshot(&mut out, false);
        assert_eq!(snapshot_row_data(&out), vec![(0x100, 8, vec![9; 8])]);

        // Shorter last frames: dlcBytes stays at the max seen, tail bytes are zero.
        a.ingest(&std_f(0, 0x100, &[0xAA, 0xBB, 0xCC], 60));
        let short_fd: [u8; 12] = core::array::from_fn(|i| 0x80 | i as u8);
        a.ingest(&fd_f(1, 0x1ABC_DEF0, &short_fd, 70));
        a.encode_snapshot(&mut out, false);
        let rows = snapshot_row_data(&out);
        assert_eq!(rows[0], (0x100, 8, vec![0xAA, 0xBB, 0xCC, 0, 0, 0, 0, 0]));
        let mut want = vec![0u8; 64];
        want[..12].copy_from_slice(&short_fd);
        assert_eq!(rows[1], (0x1ABC_DEF0, 64, want));

        // Zero-length last frame -> all-zero data.
        a.ingest(&std_f(0, 0x100, &[], 80));
        a.encode_snapshot(&mut out, false);
        assert_eq!(snapshot_row_data(&out), vec![(0x100, 8, vec![0; 8])]);
    }

    fn golden_json(bin: &[u8]) -> String {
        let a = golden_analyzer();
        let rows: Vec<serde_json::Value> = [(2u8, 0x123u32, false), (5, 0x18FF_0001, true)]
            .iter()
            .map(|&(bus, id, ext)| {
                let d = a.row_detail(bus, id, ext).unwrap();
                let r = a.row(bus, id, ext).unwrap();
                let n = usize::from(r.dlc_bytes);
                let heat: Vec<u8> = (0..n * 8).map(|b| re_heat(r.window_toggles[b], r.window_rx)).collect();
                let nonzero: serde_json::Map<String, serde_json::Value> = heat
                    .iter()
                    .enumerate()
                    .filter(|(_, &h)| h != 0)
                    .map(|(i, &h)| (i.to_string(), h.into()))
                    .collect();
                serde_json::json!({
                    "bus": bus, "arbId": id, "extended": ext, "fd": r.fd_seen, "hasDiff": r.has_diff(),
                    "isNew": true, "dlcBytes": n, "rxCount": r.rx_count,
                    "heatNonZero": nonzero,
                    "diffHex": d.diff_mask, "constantHex": d.constant_mask,
                    "dataHex": hex_words(|w| r.prev[w], n),
                })
            })
            .collect();
        let v = serde_json::json!({
            "description": "RE Toolkit binary snapshot v2 golden fixture (re-toolkit-v1 §2.2 + R1 amendment 13, magic NRE2), little-endian. Generated by `cargo test -p nexus-hal re_snapshot_golden_bytes` with RE_GOLDEN_UPDATE=1 (scenario: re_analyzer.rs golden_analyzer). heat bytes not listed in heatNonZero are 0; diff/constant are the per-byte bit masks and data is the last received payload (uppercase hex, byte 0 first).",
            "byteLength": bin.len(),
            "header": { "magic": "NRE2", "seq": 0, "tsUs": 3000, "phase": "action", "phaseCode": 3, "full": true, "rowCount": 2, "totalRows": 2 },
            "rows": rows,
        });
        serde_json::to_string_pretty(&v).unwrap() + "\n"
    }

    // ─── Throughput (debug: relaxed bound; release numbers in the report) ───

    #[test]
    fn re_ingest_throughput_2048_rows() {
        let mut a = started();
        let n = 204_800usize;
        let mut rng = Lcg(1);
        let frames: Vec<RawCanFrame> = (0..n)
            .map(|i| {
                let mut d = [0u8; 8];
                for x in &mut d {
                    *x = rng.next();
                }
                fd_f(0, (i % 2048) as u32, &d, i as u64 * 20)
            })
            .collect();
        let t = std::time::Instant::now();
        for f in &frames {
            a.ingest(f);
        }
        let fps = n as f64 / t.elapsed().as_secs_f64();
        eprintln!("re_ingest_throughput_2048_rows: {fps:.0} fps");
        assert_eq!(a.status().rows, 2048);
        let floor = if cfg!(debug_assertions) {
            5_000.0
        } else {
            50_000.0
        };
        assert!(fps >= floor, "{fps:.0} fps < {floor}");
    }
}
