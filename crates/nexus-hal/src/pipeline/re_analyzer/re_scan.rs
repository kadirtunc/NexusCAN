//! RE Toolkit R2c — Value Scan ("Cheat Engine" style), `planning/contracts/re-toolkit-v1.md` §8 / §8.6.
//!
//! The "address space" is every bit field `(row, startBit, bitLength, byteOrder, valueType)` of every
//! RE row. A first scan generates the candidate space lazily from the rows seen so far and filters it;
//! next scans only filter the surviving set; undo restores one of the last 8 sets.
//!
//! * **Storage**: struct-of-arrays [`CandSet`] (packed descriptor `u64` + last value `f64` (NaN =
//!   null) + preset index `u16` + change count `u16`), sorted by the frozen "id" order, hard cap
//!   [`RE_SCAN_MAX_CANDIDATES`]. Sets are `Arc`-shared between the live state and the undo stack.
//! * **Locks**: the analyzer lock is held only to copy row data ([`RowSnap`]: latest payload,
//!   `scan_changed` mask (cleared atomically with the copy), constant mask, optional history);
//!   classification and filtering run on the calling (worker) thread without it. The scan state
//!   mutex and the analyzer mutex are never held at the same time.
//! * **Cancel / budget**: every first / next / undo / reset bumps `ReShared::scan_gen`; a running
//!   scan whose generation is stale stops and is never committed. Wall-time budget per call
//!   (default [`RE_SCAN_BUDGET`]) checked before every row (first scan) / chunk (next scan).
//! * **Bit math**: `nexus_netdb::compiler::bit_plan::NormalizedBitSpan` only, compiled once per
//!   candidate shape `(byteOrder, startBit, bitLength)` into a process-wide lazily filled table.

use super::re_focus::{ReError, ReTargetDto, ReValueType};
use super::{
    classify_history, len_mask, ReAnalyzer, ReByteOrder, ReFieldKind, ReRowState, ReShared, RowKey,
    RE_HISTORY_DEPTH,
};
use nexus_netdb::compiler::bit_plan::NormalizedBitSpan;
use nexus_netdb::ir::ByteOrder;
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

// ─── Limits / constants (§8.1, §8.6) ────────────────────────────────────────

/// Live-set cap (survivors of the first scan).
pub const RE_SCAN_MAX_CANDIDATES: usize = 4_000_000;
/// Undo stack depth (older sets dropped).
pub const RE_SCAN_MAX_UNDO: usize = 8;
/// Results page limit.
pub const RE_SCAN_MAX_RESULTS: u32 = 500;
/// Wall-time budget per scan call (`truncated = true` when cut).
pub const RE_SCAN_BUDGET: Duration = Duration::from_secs(2);
/// Default candidate lengths.
pub const RE_SCAN_DEFAULT_LENGTHS: [u8; 8] = [1, 2, 4, 8, 12, 16, 24, 32];
/// Standard preset factors (grid = factor-major cross product with the offsets, 66 presets).
pub const RE_SCAN_PRESET_FACTORS: [f64; 11] = [
    1.0,
    0.1,
    0.01,
    0.001,
    0.5,
    0.25,
    0.125,
    1.0 / 128.0,
    1.0 / 256.0,
    2.0,
    10.0,
];
/// Standard preset offsets.
pub const RE_SCAN_PRESET_OFFSETS: [f64; 6] = [0.0, -40.0, -50.0, -100.0, -273.15, -1000.0];
/// Maximum user-defined presets per first scan.
pub const RE_SCAN_MAX_USER_PRESETS: usize = 64;
/// Maximum explicit presets per call (`presets` list).
pub const RE_SCAN_MAX_PRESETS: usize = 256;

/// Next-scan budget / cancel granularity.
const NEXT_CHUNK: usize = 16_384;
const NO_PRESET: u16 = u16::MAX;
/// Preset table bound (indices are `u16`, `NO_PRESET` reserved).
const MAX_PRESET_TABLE: usize = 60_000;
const VT_U: u8 = 0;
const VT_S: u8 = 1;
const VT_F32: u8 = 2;
const VT_F64: u8 = 3;

// ─── Wire DTOs (serde camelCase) ────────────────────────────────────────────

/// First-scan kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReScanKind {
    /// `= X` on the raw value (tolerance default 0).
    Exact,
    /// `= X` on the physical value under scale presets.
    Physical,
    /// `a <= v <= b` (raw, or physical when `physical`).
    Range,
    /// Unknown initial value (nothing filtered).
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReScalePresetDto {
    pub factor: f64,
    pub offset: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReScanAlignment {
    #[default]
    Any,
    Nibble,
    Byte,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReScanReadMode {
    #[default]
    Latest,
    /// Lower median of the last `samples` (1..=64) decoded values.
    Median { samples: u16 },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReScanOptionsDto {
    pub lengths: Vec<u16>,
    pub byte_orders: Vec<ReByteOrder>,
    pub signed: Vec<bool>,
    pub float32: bool,
    pub include64: bool,
    pub alignment: ReScanAlignment,
    pub exclude_counter_checksum: bool,
    pub exclude_constant: bool,
    pub buses: Option<Vec<u8>>,
    pub ids: Option<Vec<ReTargetDto>>,
    pub read_mode: ReScanReadMode,
}

impl Default for ReScanOptionsDto {
    fn default() -> Self {
        Self {
            lengths: RE_SCAN_DEFAULT_LENGTHS
                .iter()
                .map(|&l| u16::from(l))
                .collect(),
            byte_orders: vec![ReByteOrder::Intel, ReByteOrder::Motorola],
            signed: vec![false, true],
            float32: false,
            include64: false,
            alignment: ReScanAlignment::Any,
            exclude_counter_checksum: true,
            exclude_constant: true,
            buses: None,
            ids: None,
            read_mode: ReScanReadMode::Latest,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReScanFirstSpec {
    pub kind: ReScanKind,
    #[serde(default)]
    pub value: Option<f64>,
    #[serde(default)]
    pub tolerance: Option<f64>,
    #[serde(default)]
    pub range: Option<[f64; 2]>,
    /// Only for kind `range`: range on the physical value (presets).
    #[serde(default)]
    pub physical: bool,
    /// `None` = standard 66-preset grid; `[]` is invalid when physical.
    #[serde(default)]
    pub presets: Option<Vec<ReScalePresetDto>>,
    /// Tried before `presets`, in order.
    #[serde(default)]
    pub user_presets: Vec<ReScalePresetDto>,
    #[serde(default)]
    pub options: ReScanOptionsDto,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReScanOpKind {
    Changed,
    Unchanged,
    Increased,
    Decreased,
    Either,
    IncreasedBy,
    DecreasedBy,
    Exact,
    Range,
    Stable,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReScanNextOp {
    pub op: ReScanOpKind,
    #[serde(default)]
    pub value: Option<f64>,
    #[serde(default)]
    pub tolerance: Option<f64>,
    #[serde(default)]
    pub range: Option<[f64; 2]>,
    /// `1..=600000`, only for `stable`.
    #[serde(default)]
    pub stable_ms: Option<u32>,
    #[serde(default)]
    pub physical: bool,
    #[serde(default)]
    pub presets: Option<Vec<ReScalePresetDto>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReScanSort {
    Id,
    Changes,
    Width,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReScanStatusDto {
    pub active: bool,
    pub scan_id: u32,
    pub step: u32,
    pub candidates: u64,
    /// Candidate count after every step (first scan first).
    pub history: Vec<u64>,
    pub truncated: bool,
    pub elapsed_ms: f64,
    pub undo_depth: u8,
    /// Only for `stable` steps (S6), else `null`.
    pub history_covered: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReScanCandidateDto {
    pub bus: u8,
    pub arb_id: u32,
    pub is_extended: bool,
    pub start_bit: u16,
    pub bit_length: u16,
    pub byte_order: ReByteOrder,
    pub value_type: ReValueType,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReScanResultRowDto {
    pub candidate: ReScanCandidateDto,
    pub preset: Option<ReScalePresetDto>,
    pub current_raw: Option<f64>,
    pub current_physical: Option<f64>,
    pub previous_raw: Option<f64>,
    pub change_count: u32,
    pub kind_hint: Option<ReFieldKind>,
    pub contained_count: u32,
    pub contained: Vec<ReScanCandidateDto>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReScanResultsDto {
    pub scan_id: u32,
    pub step: u32,
    /// Grouped rows.
    pub total: u32,
    /// Ungrouped candidates.
    pub candidates: u64,
    pub offset: u32,
    pub rows: Vec<ReScanResultRowDto>,
}

fn invalid(msg: impl Into<String>) -> ReError {
    ReError::Invalid(msg.into())
}

fn superseded() -> ReError {
    invalid("scan superseded by a newer scan call (result discarded)")
}

// ─── Shapes (NormalizedBitSpan compiled once per shape) ─────────────────────

struct Shape {
    span: NormalizedBitSpan,
    mask: [u64; 8],
    /// Intel bit index (`byte*8 + bit`) of signal bit 0.
    lsb: u16,
    multi_byte: bool,
}

const SHAPE_LENS: usize = 65;

static SHAPES: OnceLock<Vec<OnceLock<Option<Box<Shape>>>>> = OnceLock::new();

/// Compiled shape `(moto, start, len)`; `None` when the span does not compile (e.g. a Motorola
/// span running past byte 63). Thread-safe, lock-free after the first compile.
fn shape(moto: bool, start: u16, len: u8) -> Option<&'static Shape> {
    if start >= 512 || len == 0 || usize::from(len) >= SHAPE_LENS {
        return None;
    }
    let table = SHAPES.get_or_init(|| (0..2 * 512 * SHAPE_LENS).map(|_| OnceLock::new()).collect());
    let idx = (usize::from(moto) * 512 + usize::from(start)) * SHAPE_LENS + usize::from(len);
    table[idx]
        .get_or_init(|| {
            let order = if moto {
                ByteOrder::BigEndian
            } else {
                ByteOrder::LittleEndian
            };
            let span = NormalizedBitSpan::compile(start, len, order).ok()?;
            let mut mask = [0u64; 8];
            for &(byte, bib) in &span.bit_coords {
                let b = usize::from(byte) * 8 + usize::from(bib);
                mask[b / 64] |= 1u64 << (b % 64);
            }
            let (b0, k0) = span.bit_coords[0];
            Some(Box::new(Shape {
                lsb: u16::from(b0) * 8 + u16::from(k0),
                multi_byte: span.min_byte != span.max_byte,
                mask,
                span,
            }))
        })
        .as_deref()
}

// Descriptor: row << 32 | start << 16 | len << 8 | moto << 2 | vt  (numeric order == "id" sort).
#[inline]
fn pack(row: usize, start: u16, len: u8, moto: bool, vt: u8) -> u64 {
    ((row as u64) << 32)
        | (u64::from(start) << 16)
        | (u64::from(len) << 8)
        | (u64::from(moto) << 2)
        | u64::from(vt)
}
#[inline]
fn d_row(d: u64) -> usize {
    (d >> 32) as usize
}
#[inline]
fn d_start(d: u64) -> u16 {
    (d >> 16) as u16
}
#[inline]
fn d_len(d: u64) -> u8 {
    (d >> 8) as u8
}
#[inline]
fn d_moto(d: u64) -> bool {
    (d >> 2) & 1 != 0
}
#[inline]
fn d_vt(d: u64) -> u8 {
    (d & 3) as u8
}
#[inline]
fn d_shape(d: u64) -> &'static Shape {
    shape(d_moto(d), d_start(d), d_len(d)).expect("stored candidate shapes compile")
}

#[inline]
fn mask_hits(a: &[u64; 8], b: &[u64; 8]) -> bool {
    (0..8).any(|w| a[w] & b[w] != 0)
}
#[inline]
fn mask_within(a: &[u64; 8], b: &[u64; 8]) -> bool {
    (0..8).all(|w| a[w] & !b[w] == 0)
}

/// Decoded value (S3): `None` when the span lies past `len` payload bytes or is not finite.
#[inline]
fn decode(s: &Shape, vt: u8, payload: &[u8; 64], len: u8) -> Option<f64> {
    let len = usize::from(len.min(64));
    if usize::from(s.span.max_byte) >= len {
        return None;
    }
    let raw = s.span.extract_raw_u64(&payload[..len]);
    let v = match vt {
        VT_U => raw as f64,
        VT_S => {
            let sh = 64 - u32::from(s.span.bit_len);
            (((raw << sh) as i64) >> sh) as f64
        }
        VT_F32 => f64::from(f32::from_bits(raw as u32)),
        _ => f64::from_bits(raw),
    };
    v.is_finite().then_some(v)
}

#[inline]
fn to_store(v: Option<f64>) -> f64 {
    v.unwrap_or(f64::NAN)
}
#[inline]
fn from_store(v: f64) -> Option<f64> {
    (!v.is_nan()).then_some(v)
}
#[inline]
fn differs(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (Some(x), Some(y)) => x != y,
        (None, None) => false,
        _ => true,
    }
}

// ─── Row snapshots (copied under the analyzer lock) ─────────────────────────

/// Copy of one RE row (bounded: ≤ 64 history slots of 64 bytes).
struct RowSnap {
    key: RowKey,
    dlc: u8,
    latest: [u8; 64],
    latest_len: u8,
    changed: [u64; 8],
    constant: [u64; 8],
    /// Chronological history (only when requested).
    hist: Vec<[u8; 64]>,
    hist_ts: Vec<u64>,
    hist_dlc: Vec<u8>,
}

fn snap_row(r: &ReRowState, history: bool) -> RowSnap {
    let mut latest = [0u8; 64];
    for (i, b) in latest.iter_mut().enumerate() {
        *b = (r.prev[i / 8] >> ((i % 8) * 8)) as u8;
    }
    let mut constant = [0u64; 8];
    for (w, c) in constant.iter_mut().enumerate() {
        *c = r.constant_word(w);
    }
    let (mut hist, mut hist_ts, mut hist_dlc) = (Vec::new(), Vec::new(), Vec::new());
    if history {
        let len = usize::from(r.hist_len);
        let start = (usize::from(r.hist_head) + RE_HISTORY_DEPTH - len) % RE_HISTORY_DEPTH;
        hist.reserve_exact(len);
        hist_ts.reserve_exact(len);
        hist_dlc.reserve_exact(len);
        for i in 0..len {
            let idx = (start + i) % RE_HISTORY_DEPTH;
            hist.push(r.history[idx]);
            hist_ts.push(r.hist_ts_us[idx]);
            hist_dlc.push(r.hist_dlc[idx]);
        }
    }
    RowSnap {
        key: (r.bus, r.is_extended, r.arb_id),
        dlc: r.dlc_bytes,
        latest,
        latest_len: if r.has_prev { r.prev_len } else { 0 },
        changed: r.scan_changed,
        constant,
        hist,
        hist_ts,
        hist_dlc,
    }
}

impl ReAnalyzer {
    fn scan_row_mut(&mut self, key: RowKey) -> Option<&mut ReRowState> {
        let i = *self.index.get(&key)?;
        Some(&mut *self.rows[usize::from(i)])
    }

    /// Copies the rows accepted by `filter` (sorted by key) and clears their `scan_changed`.
    fn scan_copy_filtered(&mut self, filter: impl Fn(RowKey) -> bool) -> Vec<RowSnap> {
        let mut out = Vec::new();
        for r in self.rows.iter_mut() {
            if filter((r.bus, r.is_extended, r.arb_id)) {
                out.push(snap_row(r, true));
                r.scan_changed = [0; 8];
            }
        }
        out.sort_unstable_by_key(|s| s.key);
        out
    }

    /// Copies the rows `keys` (missing rows -> `None`), optionally clearing `scan_changed`.
    fn scan_copy_keys<'a>(
        &mut self,
        keys: impl Iterator<Item = &'a RowKey>,
        history: bool,
        clear: bool,
    ) -> Vec<Option<RowSnap>> {
        keys.map(|&k| {
            self.scan_row_mut(k).map(|r| {
                let s = snap_row(r, history);
                if clear {
                    r.scan_changed = [0; 8];
                }
                s
            })
        })
        .collect()
    }

    /// Undoes the `scan_changed` clear of a failed first scan.
    fn scan_restore_changed(&mut self, snaps: &[RowSnap]) {
        for s in snaps {
            if let Some(r) = self.scan_row_mut(s.key) {
                for w in 0..8 {
                    r.scan_changed[w] |= s.changed[w];
                }
            }
        }
    }
}

// ─── Scan state ─────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReadMode {
    Latest,
    Median(usize),
}

impl ReadMode {
    fn needs_history(self) -> bool {
        matches!(self, ReadMode::Median(_))
    }
}

/// Value read per scan read mode (S3).
fn read_value(s: &RowSnap, sh: &Shape, vt: u8, mode: ReadMode) -> Option<f64> {
    match mode {
        ReadMode::Latest => decode(sh, vt, &s.latest, s.latest_len),
        ReadMode::Median(n) => {
            let len = s.hist.len();
            let k = n.min(len);
            let mut buf = [0f64; RE_HISTORY_DEPTH];
            let mut m = 0usize;
            for i in len - k..len {
                if let Some(v) = decode(sh, vt, &s.hist[i], s.hist_dlc[i]) {
                    buf[m] = v;
                    m += 1;
                }
            }
            if m == 0 {
                return None;
            }
            buf[..m].sort_unstable_by(f64::total_cmp);
            Some(buf[(m - 1) / 2])
        }
    }
}

/// Struct-of-arrays candidate set, sorted by descriptor ("id" order).
#[derive(Default)]
struct CandSet {
    desc: Vec<u64>,
    value: Vec<f64>,
    preset: Vec<u16>,
    changes: Vec<u16>,
}

impl CandSet {
    fn with_capacity(n: usize) -> Self {
        Self {
            desc: Vec::with_capacity(n),
            value: Vec::with_capacity(n),
            preset: Vec::with_capacity(n),
            changes: Vec::with_capacity(n),
        }
    }
    #[inline]
    fn push(&mut self, d: u64, v: f64, p: u16, c: u16) {
        self.desc.push(d);
        self.value.push(v);
        self.preset.push(p);
        self.changes.push(c);
    }
    fn len(&self) -> usize {
        self.desc.len()
    }
}

/// Immutable per-scan context (first-scan snapshot).
struct ScanRow {
    key: RowKey,
    /// Classifier fields at first-scan time (S10 kindHint).
    fields: Vec<([u64; 8], ReFieldKind)>,
}

struct ScanCtx {
    scan_id: u32,
    epoch: u64,
    rows: Vec<ScanRow>,
    mode: ReadMode,
}

/// Undoable step state.
#[derive(Clone)]
struct ScanCore {
    set: Arc<CandSet>,
    presets: Arc<Vec<ReScalePresetDto>>,
    step: u32,
    history: Vec<u64>,
    truncated: bool,
    elapsed_ms: f64,
    history_covered: Option<bool>,
    version: u64,
}

struct ActiveScan {
    ctx: Arc<ScanCtx>,
    core: ScanCore,
    undo: VecDeque<ScanCore>,
}

/// Results grouping (S10): entries `(rep index, children offset, children count)` in id order.
struct Grouping {
    entries: Vec<(u32, u32, u32)>,
    children: Vec<u32>,
}

struct GroupCache {
    version: u64,
    grouping: Arc<Grouping>,
    by_width: Option<Arc<Vec<u32>>>,
    by_changes: Option<Arc<Vec<u32>>>,
}

/// R2c value-scan state held by [`ReShared`].
#[derive(Default)]
pub struct ScanState {
    active: Option<ActiveScan>,
    last_scan_id: u32,
    version: u64,
    cache: Option<GroupCache>,
}

impl ScanState {
    fn sync_epoch(&mut self, epoch: u64) {
        if self.active.as_ref().is_some_and(|a| a.ctx.epoch != epoch) {
            self.active = None;
            self.cache = None;
        }
    }

    fn status(&self) -> ReScanStatusDto {
        match &self.active {
            Some(a) => ReScanStatusDto {
                active: true,
                scan_id: a.ctx.scan_id,
                step: a.core.step,
                candidates: a.core.set.len() as u64,
                history: a.core.history.clone(),
                truncated: a.core.truncated,
                elapsed_ms: a.core.elapsed_ms,
                undo_depth: a.undo.len() as u8,
                history_covered: a.core.history_covered,
            },
            None => ReScanStatusDto {
                active: false,
                scan_id: self.last_scan_id,
                step: 0,
                candidates: 0,
                history: Vec::new(),
                truncated: false,
                elapsed_ms: 0.0,
                undo_depth: 0,
                history_covered: None,
            },
        }
    }
}

// ─── Validation / plans ─────────────────────────────────────────────────────

#[derive(Clone, Copy)]
enum Cmp {
    Exact { x: f64, tol: Option<f64> },
    Range { a: f64, b: f64 },
}

fn finite(v: f64, what: &str) -> Result<f64, ReError> {
    if v.is_finite() {
        Ok(v)
    } else {
        Err(invalid(format!("{what} must be finite")))
    }
}

fn check_tolerance(t: Option<f64>) -> Result<Option<f64>, ReError> {
    match t {
        Some(t) if !t.is_finite() || t < 0.0 => {
            Err(invalid(format!("tolerance {t} must be finite and >= 0")))
        }
        t => Ok(t),
    }
}

fn exact_cmp(value: Option<f64>, tol: Option<f64>, what: &str) -> Result<Cmp, ReError> {
    let x = value.ok_or_else(|| invalid(format!("{what} needs a value")))?;
    Ok(Cmp::Exact {
        x: finite(x, "value")?,
        tol: check_tolerance(tol)?,
    })
}

fn range_cmp(range: Option<[f64; 2]>, what: &str) -> Result<Cmp, ReError> {
    let [a, b] = range.ok_or_else(|| invalid(format!("{what} needs a range [a, b]")))?;
    let (a, b) = (finite(a, "range")?, finite(b, "range")?);
    if a > b {
        return Err(invalid(format!("range [{a}, {b}] inverted (a > b)")));
    }
    Ok(Cmp::Range { a, b })
}

fn check_presets(list: &[ReScalePresetDto], what: &str, max: usize) -> Result<(), ReError> {
    if list.len() > max {
        return Err(invalid(format!("{what}: at most {max} presets")));
    }
    for p in list {
        if !p.factor.is_finite() || p.factor == 0.0 || !p.offset.is_finite() {
            return Err(invalid(format!(
                "{what}: preset factor must be finite and != 0, offset finite (got {} / {})",
                p.factor, p.offset
            )));
        }
    }
    Ok(())
}

fn grid() -> Vec<ReScalePresetDto> {
    let mut v = Vec::with_capacity(RE_SCAN_PRESET_FACTORS.len() * RE_SCAN_PRESET_OFFSETS.len());
    for &factor in &RE_SCAN_PRESET_FACTORS {
        for &offset in &RE_SCAN_PRESET_OFFSETS {
            v.push(ReScalePresetDto { factor, offset });
        }
    }
    v
}

/// Resolved preset list (`None` = grid, `[]` invalid).
fn resolve_presets(p: &Option<Vec<ReScalePresetDto>>) -> Result<Vec<ReScalePresetDto>, ReError> {
    match p {
        None => Ok(grid()),
        Some(v) if v.is_empty() => Err(invalid("presets must not be empty (null = standard grid)")),
        Some(v) => {
            check_presets(v, "presets", RE_SCAN_MAX_PRESETS)?;
            Ok(v.clone())
        }
    }
}

#[inline]
fn phys_ok(v: f64, p: &ReScalePresetDto, cmp: Cmp) -> bool {
    let y = v * p.factor + p.offset;
    match cmp {
        Cmp::Exact { x, tol } => {
            let t = tol.unwrap_or_else(|| p.factor.abs().max(0.005 * x.abs()));
            (y - x).abs() <= t
        }
        Cmp::Range { a, b } => y >= a && y <= b,
    }
}

#[inline]
fn raw_ok(v: f64, cmp: Cmp) -> bool {
    match cmp {
        Cmp::Exact { x, tol } => (v - x).abs() <= tol.unwrap_or(0.0),
        Cmp::Range { a, b } => v >= a && v <= b,
    }
}

struct FirstPlan {
    kind: ReScanKind,
    cmp: Option<Cmp>,
    physical: bool,
    /// userPresets ++ presets (physical only).
    presets: Vec<ReScalePresetDto>,
    lens: Vec<u8>,
    int_len: [bool; SHAPE_LENS],
    unsigned: bool,
    signed: bool,
    float32: bool,
    include64: bool,
    intel: bool,
    moto: bool,
    align: u16,
    excl_cc: bool,
    excl_const: bool,
    buses: Option<[bool; 256]>,
    ids: Option<Vec<RowKey>>,
    mode: ReadMode,
}

impl FirstPlan {
    fn new(s: &ReScanFirstSpec) -> Result<Self, ReError> {
        let o = &s.options;
        let (cmp, physical) = match s.kind {
            ReScanKind::Exact => (Some(exact_cmp(s.value, s.tolerance, "exact scan")?), false),
            ReScanKind::Physical => (
                Some(exact_cmp(s.value, s.tolerance, "physical scan")?),
                true,
            ),
            ReScanKind::Range => (Some(range_cmp(s.range, "range scan")?), s.physical),
            ReScanKind::Unknown => (None, false),
        };
        check_presets(&s.user_presets, "userPresets", RE_SCAN_MAX_USER_PRESETS)?;
        let presets = if physical {
            let mut v = s.user_presets.clone();
            v.extend(resolve_presets(&s.presets)?);
            v
        } else {
            if let Some(p) = &s.presets {
                check_presets(p, "presets", RE_SCAN_MAX_PRESETS)?;
            }
            Vec::new()
        };
        if o.lengths.is_empty() {
            return Err(invalid("options.lengths must not be empty"));
        }
        let mut int_len = [false; SHAPE_LENS];
        for &l in &o.lengths {
            if !(1..=32).contains(&l) {
                return Err(invalid(format!(
                    "options.lengths: {l} outside 1..=32 (use include64 for 64)"
                )));
            }
            int_len[usize::from(l)] = true;
        }
        if o.include64 {
            int_len[64] = true;
        }
        if o.byte_orders.is_empty() {
            return Err(invalid("options.byteOrders must not be empty"));
        }
        if o.signed.is_empty() {
            return Err(invalid("options.signed must not be empty"));
        }
        let mode = match o.read_mode {
            ReScanReadMode::Latest => ReadMode::Latest,
            ReScanReadMode::Median { samples } => {
                if !(1..=RE_HISTORY_DEPTH as u16).contains(&samples) {
                    return Err(invalid(format!(
                        "readMode median samples {samples} outside 1..={RE_HISTORY_DEPTH}"
                    )));
                }
                ReadMode::Median(usize::from(samples))
            }
        };
        let buses = match &o.buses {
            None => None,
            Some(v) if v.is_empty() => {
                return Err(invalid("options.buses must not be empty (null = all)"))
            }
            Some(v) => {
                let mut b = [false; 256];
                for &x in v {
                    b[usize::from(x)] = true;
                }
                Some(b)
            }
        };
        let ids = match &o.ids {
            None => None,
            Some(v) if v.is_empty() => {
                return Err(invalid("options.ids must not be empty (null = all)"))
            }
            Some(v) => Some(
                v.iter()
                    .map(ReTargetDto::key)
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        };
        let mut lens: Vec<u8> = (1..SHAPE_LENS as u8)
            .filter(|&l| {
                int_len[usize::from(l)]
                    || (o.float32 && l == 32)
                    || (o.float32 && o.include64 && l == 64)
            })
            .collect();
        lens.dedup();
        Ok(Self {
            kind: s.kind,
            cmp,
            physical,
            presets,
            lens,
            int_len,
            unsigned: o.signed.contains(&false),
            signed: o.signed.contains(&true),
            float32: o.float32,
            include64: o.include64,
            intel: o.byte_orders.contains(&ReByteOrder::Intel),
            moto: o.byte_orders.contains(&ReByteOrder::Motorola),
            align: match o.alignment {
                ReScanAlignment::Any => 1,
                ReScanAlignment::Nibble => 4,
                ReScanAlignment::Byte => 8,
            },
            excl_cc: o.exclude_counter_checksum,
            excl_const: o.exclude_constant
                && !matches!(s.kind, ReScanKind::Exact | ReScanKind::Physical),
            buses,
            ids,
            mode,
        })
    }

    fn accepts(&self, key: RowKey) -> bool {
        self.buses.is_none_or(|b| b[usize::from(key.0)])
            && self.ids.as_ref().is_none_or(|ids| ids.contains(&key))
    }

    /// Visits the candidate space of one row in "id" order (S1 / S2).
    #[inline]
    fn for_each_candidate(
        &self,
        dlc: u8,
        excluded: &[u64; 8],
        constant: Option<&[u64; 8]>,
        mut f: impl FnMut(u16, u8, bool, &'static Shape, u8),
    ) {
        let dlc = usize::from(dlc);
        for start in 0..(dlc * 8) as u16 {
            for &len in &self.lens {
                for moto in [false, true] {
                    if (moto && !self.moto) || (!moto && !self.intel) {
                        continue;
                    }
                    let Some(sh) = shape(moto, start, len) else {
                        continue;
                    };
                    if usize::from(sh.span.max_byte) >= dlc
                        || (moto && !sh.multi_byte)
                        || sh.lsb % self.align != 0
                        || mask_hits(&sh.mask, excluded)
                        || constant.is_some_and(|c| mask_within(&sh.mask, c))
                    {
                        continue;
                    }
                    if self.int_len[usize::from(len)] {
                        if self.unsigned {
                            f(start, len, moto, sh, VT_U);
                        }
                        if self.signed && len >= 4 {
                            f(start, len, moto, sh, VT_S);
                        }
                    }
                    if self.float32 && len == 32 {
                        f(start, len, moto, sh, VT_F32);
                    }
                    if self.float32 && self.include64 && len == 64 {
                        f(start, len, moto, sh, VT_F64);
                    }
                }
            }
        }
    }
}

enum NextKind {
    Changed,
    Unchanged,
    Increased,
    Decreased,
    Either,
    By { n: f64, tol: Option<f64>, sign: f64 },
    Value(Cmp),
    Stable { window_us: u64 },
}

struct NextPlan {
    kind: NextKind,
    /// Presets tried for candidates without one (physical value ops only).
    presets: Option<Vec<ReScalePresetDto>>,
}

impl NextPlan {
    fn new(op: &ReScanNextOp) -> Result<Self, ReError> {
        let tol = check_tolerance(op.tolerance)?;
        let by = |sign: f64| -> Result<NextKind, ReError> {
            let n = op
                .value
                .ok_or_else(|| invalid("increasedBy / decreasedBy need a value"))?;
            Ok(NextKind::By {
                n: finite(n, "value")?,
                tol,
                sign,
            })
        };
        let kind = match op.op {
            ReScanOpKind::Changed => NextKind::Changed,
            ReScanOpKind::Unchanged => NextKind::Unchanged,
            ReScanOpKind::Increased => NextKind::Increased,
            ReScanOpKind::Decreased => NextKind::Decreased,
            ReScanOpKind::Either => NextKind::Either,
            ReScanOpKind::IncreasedBy => by(1.0)?,
            ReScanOpKind::DecreasedBy => by(-1.0)?,
            ReScanOpKind::Exact => NextKind::Value(exact_cmp(op.value, tol, "exact")?),
            ReScanOpKind::Range => NextKind::Value(range_cmp(op.range, "range")?),
            ReScanOpKind::Stable => {
                let ms = op
                    .stable_ms
                    .ok_or_else(|| invalid("stable needs stableMs"))?;
                if !(1..=600_000).contains(&ms) {
                    return Err(invalid(format!("stableMs {ms} outside 1..=600000")));
                }
                NextKind::Stable {
                    window_us: u64::from(ms) * 1_000,
                }
            }
        };
        let value_op = matches!(kind, NextKind::By { .. } | NextKind::Value(_));
        let presets = if op.physical && value_op {
            Some(resolve_presets(&op.presets)?)
        } else {
            if let Some(p) = &op.presets {
                if op.physical && p.is_empty() {
                    return Err(invalid("presets must not be empty (null = standard grid)"));
                }
                check_presets(p, "presets", RE_SCAN_MAX_PRESETS)?;
            }
            None
        };
        Ok(Self { kind, presets })
    }

    fn needs_history(&self) -> bool {
        matches!(self.kind, NextKind::Stable { .. })
    }
}

/// Per-row stable-window summary (S6).
struct StableRow {
    covered: bool,
    /// Bits that differ from the newest sample in any sample of the window.
    varied: [u64; 8],
    /// Shortest payload in the window.
    min_len: u8,
    /// History indices of the window (newest first).
    first_idx: usize,
}

fn stable_row(s: &RowSnap, now: u64, window_us: u64) -> Option<StableRow> {
    let n = s.hist.len();
    if n == 0 {
        return None;
    }
    let w0 = now.saturating_sub(window_us);
    let newest = &s.hist[n - 1];
    let mut varied = [0u64; 8];
    let mut min_len = 64u8;
    let mut first_idx = 0usize;
    let mut covered = false;
    for i in (0..n).rev() {
        let p = &s.hist[i];
        for (w, v) in varied.iter_mut().enumerate() {
            let mut a = [0u8; 8];
            let mut b = [0u8; 8];
            a.copy_from_slice(&p[w * 8..w * 8 + 8]);
            b.copy_from_slice(&newest[w * 8..w * 8 + 8]);
            *v |= u64::from_le_bytes(a) ^ u64::from_le_bytes(b);
        }
        min_len = min_len.min(s.hist_dlc[i]);
        first_idx = i;
        if s.hist_ts[i] <= w0 {
            covered = true;
            break;
        }
    }
    for (w, v) in varied.iter_mut().enumerate() {
        *v &= len_mask(w, usize::from(min_len));
    }
    Some(StableRow {
        covered,
        varied,
        min_len,
        first_idx,
    })
}

fn stable_ok(s: &RowSnap, st: &StableRow, sh: &Shape, vt: u8) -> bool {
    let n = s.hist.len();
    let Some(ref_v) = decode(sh, vt, &s.hist[n - 1], s.hist_dlc[n - 1]) else {
        return false;
    };
    if vt == VT_U || vt == VT_S {
        usize::from(sh.span.max_byte) < usize::from(st.min_len) && !mask_hits(&sh.mask, &st.varied)
    } else {
        // Floats: value equality (±0.0), never bitwise.
        (st.first_idx..n).all(|i| decode(sh, vt, &s.hist[i], s.hist_dlc[i]) == Some(ref_v))
    }
}

// ─── Grouping (S10) ─────────────────────────────────────────────────────────

fn for_each_bit(m: &[u64; 8], mut f: impl FnMut(usize)) {
    for (w, &word) in m.iter().enumerate() {
        let mut x = word;
        while x != 0 {
            f(w * 64 + x.trailing_zeros() as usize);
            x &= x - 1;
        }
    }
}

fn group(set: &CandSet) -> Grouping {
    let n = set.len();
    let mut home = vec![u32::MAX; n];
    let mut idx: Vec<u32> = (0..n as u32)
        .filter(|&i| set.changes[i as usize] >= 1)
        .collect();
    let bucket = |i: u32| {
        let i = i as usize;
        (d_row(set.desc[i]), set.changes[i], set.preset[i])
    };
    idx.sort_unstable_by_key(|&i| (bucket(i), Reverse(d_len(set.desc[i as usize])), i));
    let mut lists: Vec<Vec<u32>> = vec![Vec::new(); 512];
    let mut touched: Vec<usize> = Vec::new();
    let mut b = 0usize;
    while b < idx.len() {
        let key = bucket(idx[b]);
        let mut e = b;
        while e < idx.len() && bucket(idx[e]) == key {
            e += 1;
        }
        for &c in &idx[b..e] {
            let dc = set.desc[c as usize];
            let mc = &d_shape(dc).mask;
            let lc = d_len(dc);
            let mut best = usize::MAX;
            for_each_bit(mc, |bit| {
                if best == usize::MAX || lists[bit].len() < lists[best].len() {
                    best = bit;
                }
            });
            let mut found = u32::MAX;
            for &r in &lists[best] {
                let dr = set.desc[r as usize];
                if d_len(dr) <= lc {
                    break;
                }
                if mask_within(mc, &d_shape(dr).mask) {
                    found = r;
                    break;
                }
            }
            if found != u32::MAX {
                home[c as usize] = found;
            } else {
                for_each_bit(mc, |bit| {
                    if lists[bit].is_empty() {
                        touched.push(bit);
                    }
                    lists[bit].push(c);
                });
            }
        }
        for t in touched.drain(..) {
            lists[t].clear();
        }
        b = e;
    }
    let mut count = vec![0u32; n];
    for &h in &home {
        if h != u32::MAX {
            count[h as usize] += 1;
        }
    }
    let mut entries = Vec::new();
    let mut off = 0u32;
    // `count` becomes the write cursor of each representative.
    for i in 0..n {
        if home[i] == u32::MAX {
            entries.push((i as u32, off, count[i]));
            let c = count[i];
            count[i] = off;
            off += c;
        }
    }
    let mut children = vec![0u32; off as usize];
    for (i, &h) in home.iter().enumerate() {
        if h != u32::MAX {
            let cur = &mut count[h as usize];
            children[*cur as usize] = i as u32;
            *cur += 1;
        }
    }
    Grouping { entries, children }
}

// ─── ReShared API ───────────────────────────────────────────────────────────

impl ReShared {
    fn scan_budget(&self) -> Duration {
        Duration::from_nanos(self.scan_budget_ns.load(Ordering::Relaxed))
    }

    fn scan_bump(&self) -> u64 {
        self.scan_gen.fetch_add(1, Ordering::AcqRel) + 1
    }

    fn scan_stale(&self, gen: u64) -> bool {
        self.scan_gen.load(Ordering::Acquire) != gen
    }

    fn analyzer_epoch(&self) -> (bool, u64) {
        let a = self.analyzer.lock();
        (a.enabled, a.reset_epoch)
    }

    /// Test hook: wall-time budget per scan call (default [`RE_SCAN_BUDGET`]).
    #[doc(hidden)]
    pub fn scan_set_budget(&self, budget: Duration) {
        self.scan_budget_ns.store(
            budget.as_nanos().min(u128::from(u64::MAX)) as u64,
            Ordering::Relaxed,
        );
    }

    /// `cmd_re_scan_status` (never fails).
    pub fn scan_status(&self) -> ReScanStatusDto {
        let (_, epoch) = self.analyzer_epoch();
        let mut st = self.scan.lock();
        st.sync_epoch(epoch);
        st.status()
    }

    /// `cmd_re_scan_reset` (idempotent, never fails; cancels a running scan).
    pub fn scan_reset(&self) -> ReScanStatusDto {
        self.scan_bump();
        let mut st = self.scan.lock();
        st.active = None;
        st.cache = None;
        st.status()
    }

    /// `cmd_re_scan_undo`: restores the previous set (S7).
    pub fn scan_undo(&self) -> Result<ReScanStatusDto, ReError> {
        let (_, epoch) = self.analyzer_epoch();
        let mut st = self.scan.lock();
        st.sync_epoch(epoch);
        let Some(a) = st.active.as_mut() else {
            return Err(ReError::NoScan("no active value scan".into()));
        };
        let Some(prev) = a.undo.pop_back() else {
            return Err(invalid("nothing to undo (undo stack empty)"));
        };
        self.scan_bump();
        a.core = prev;
        Ok(st.status())
    }

    /// `cmd_re_scan_first`: new scan over the current RE rows (replaces an active scan on success).
    /// Synchronous on the calling (worker) thread.
    pub fn scan_first(&self, spec: &ReScanFirstSpec) -> Result<ReScanStatusDto, ReError> {
        let t0 = Instant::now();
        let plan = FirstPlan::new(spec)?;
        let (gen, epoch, snaps) = {
            let mut a = self.analyzer.lock();
            if !a.enabled {
                return Err(ReError::NotStarted(
                    "RE is not started (cmd_re_start)".into(),
                ));
            }
            let gen = self.scan_bump();
            let snaps = a.scan_copy_filtered(|k| plan.accepts(k));
            (gen, a.reset_epoch, snaps)
        };
        match self.first_eval(&plan, &snaps, gen, t0) {
            Ok((rows, set, presets, truncated)) => {
                let mut st = self.scan.lock();
                if self.scan_stale(gen) {
                    return Err(superseded());
                }
                st.last_scan_id = st.last_scan_id.wrapping_add(1);
                st.version += 1;
                let n = set.len() as u64;
                st.active = Some(ActiveScan {
                    ctx: Arc::new(ScanCtx {
                        scan_id: st.last_scan_id,
                        epoch,
                        rows,
                        mode: plan.mode,
                    }),
                    core: ScanCore {
                        set: Arc::new(set),
                        presets: Arc::new(presets),
                        step: 0,
                        history: vec![n],
                        truncated,
                        elapsed_ms: t0.elapsed().as_secs_f64() * 1e3,
                        history_covered: None,
                        version: st.version,
                    },
                    undo: VecDeque::new(),
                });
                st.cache = None;
                Ok(st.status())
            }
            Err(e) => {
                if matches!(e, ReError::ScanTooLarge(_)) {
                    self.analyzer.lock().scan_restore_changed(&snaps);
                }
                Err(e)
            }
        }
    }

    #[allow(clippy::type_complexity)]
    fn first_eval(
        &self,
        plan: &FirstPlan,
        snaps: &[RowSnap],
        gen: u64,
        t0: Instant,
    ) -> Result<(Vec<ScanRow>, CandSet, Vec<ReScalePresetDto>, bool), ReError> {
        // Classifier snapshot (S2 / S10), outside the analyzer lock.
        let classified = classify_rows(snaps);
        if self.scan_stale(gen) {
            return Err(superseded());
        }
        let mut rows = Vec::with_capacity(snaps.len());
        let mut excluded = Vec::with_capacity(snaps.len());
        for (s, fields) in snaps.iter().zip(classified) {
            let mut ex = [0u64; 8];
            if plan.excl_cc {
                for (m, k) in &fields {
                    if matches!(k, ReFieldKind::Counter | ReFieldKind::Checksum) {
                        for w in 0..8 {
                            ex[w] |= m[w];
                        }
                    }
                }
            }
            excluded.push(ex);
            rows.push(ScanRow { key: s.key, fields });
        }
        let constant = |i: usize| plan.excl_const.then_some(&snaps[i].constant);
        // S8a: unknown -> cap counted up front (masks only, not budgeted).
        if plan.kind == ReScanKind::Unknown {
            let mut total = 0usize;
            for (i, s) in snaps.iter().enumerate() {
                plan.for_each_candidate(s.dlc, &excluded[i], constant(i), |_, _, _, _, _| {
                    total += 1
                });
                if total > RE_SCAN_MAX_CANDIDATES {
                    return Err(too_large(total, true));
                }
            }
        }
        let budget = self.scan_budget();
        let mut set = CandSet::default();
        let mut truncated = false;
        for (i, s) in snaps.iter().enumerate() {
            if self.scan_stale(gen) {
                return Err(superseded());
            }
            if t0.elapsed() >= budget {
                truncated = true;
                break;
            }
            plan.for_each_candidate(
                s.dlc,
                &excluded[i],
                constant(i),
                |start, len, moto, sh, vt| {
                    let v = read_value(s, sh, vt, plan.mode);
                    let d = pack(i, start, len, moto, vt);
                    match (plan.cmp, plan.physical) {
                        (None, _) => set.push(d, to_store(v), NO_PRESET, 0),
                        (Some(cmp), false) => {
                            if let Some(x) = v.filter(|&x| raw_ok(x, cmp)) {
                                set.push(d, x, NO_PRESET, 0);
                            }
                        }
                        (Some(cmp), true) => {
                            if let Some(x) = v {
                                if let Some(p) =
                                    plan.presets.iter().position(|p| phys_ok(x, p, cmp))
                                {
                                    set.push(d, x, p as u16, 0);
                                }
                            }
                        }
                    }
                },
            );
            if set.len() > RE_SCAN_MAX_CANDIDATES {
                return Err(too_large(set.len(), false));
            }
        }
        Ok((rows, set, plan.presets.clone(), truncated))
    }

    /// `cmd_re_scan_next`: filters the surviving set (never adds).
    pub fn scan_next(&self, op: &ReScanNextOp) -> Result<ReScanStatusDto, ReError> {
        let t0 = Instant::now();
        let plan = NextPlan::new(op)?;
        let (enabled, epoch) = self.analyzer_epoch();
        let (gen, ctx, base) = {
            let mut st = self.scan.lock();
            st.sync_epoch(epoch);
            let Some(a) = st.active.as_ref() else {
                return Err(ReError::NoScan("no active value scan (scan_first)".into()));
            };
            if !enabled {
                return Err(ReError::NotStarted(
                    "RE is not started (cmd_re_start)".into(),
                ));
            }
            (self.scan_bump(), Arc::clone(&a.ctx), a.core.clone())
        };
        let history = plan.needs_history() || ctx.mode.needs_history();
        let (snaps, now) = {
            let mut a = self.analyzer.lock();
            if a.reset_epoch != epoch {
                return Err(ReError::NoScan("RE analyzer was reset".into()));
            }
            let s = a.scan_copy_keys(ctx.rows.iter().map(|r| &r.key), history, true);
            (s, a.last_frame_us)
        };
        let stable: Vec<Option<StableRow>> = match plan.kind {
            NextKind::Stable { window_us } => snaps
                .iter()
                .map(|s| s.as_ref().and_then(|s| stable_row(s, now, window_us)))
                .collect(),
            _ => Vec::new(),
        };
        let mut evaluated = vec![false; snaps.len()];

        let set = &*base.set;
        let n = set.len();
        let mut out = CandSet::with_capacity(n.min(1 << 16));
        let mut presets = Arc::clone(&base.presets);
        let mut op_base: Option<usize> = None;
        let budget = self.scan_budget();
        let mut truncated = false;
        let mut i = 0usize;
        while i < n {
            if self.scan_stale(gen) {
                return Err(superseded());
            }
            if t0.elapsed() >= budget {
                truncated = true;
                for j in i..n {
                    out.push(set.desc[j], set.value[j], set.preset[j], set.changes[j]);
                }
                break;
            }
            let end = (i + NEXT_CHUNK).min(n);
            for j in i..end {
                let d = set.desc[j];
                let row = d_row(d);
                let Some(s) = snaps[row].as_ref() else {
                    continue;
                };
                evaluated[row] = true;
                let sh = d_shape(d);
                let vt = d_vt(d);
                let cur = read_value(s, sh, vt, ctx.mode);
                let prev = from_store(set.value[j]);
                let mut preset = set.preset[j];
                let keep = match &plan.kind {
                    NextKind::Changed => mask_hits(&sh.mask, &s.changed),
                    NextKind::Unchanged => !mask_hits(&sh.mask, &s.changed),
                    NextKind::Increased => matches!((cur, prev), (Some(c), Some(p)) if c > p),
                    NextKind::Decreased => matches!((cur, prev), (Some(c), Some(p)) if c < p),
                    NextKind::Either => matches!((cur, prev), (Some(c), Some(p)) if c != p),
                    NextKind::Stable { .. } => stable[row]
                        .as_ref()
                        .is_some_and(|st| stable_ok(s, st, sh, vt)),
                    NextKind::By {
                        n: target,
                        tol,
                        sign,
                    } => match (cur, prev) {
                        (Some(c), Some(p)) => {
                            let delta = (c - p) * sign;
                            match &plan.presets {
                                None => (delta - target).abs() <= tol.unwrap_or(0.0),
                                Some(list) => {
                                    let ok = |f: f64| {
                                        let t = tol
                                            .unwrap_or_else(|| f.abs().max(0.005 * target.abs()));
                                        (delta * f - target).abs() <= t
                                    };
                                    if preset != NO_PRESET {
                                        ok(presets[usize::from(preset)].factor)
                                    } else if let Some(k) = list.iter().position(|p| ok(p.factor)) {
                                        preset =
                                            assign_preset(&mut presets, &mut op_base, list, k)?;
                                        true
                                    } else {
                                        false
                                    }
                                }
                            }
                        }
                        _ => false,
                    },
                    NextKind::Value(cmp) => match cur {
                        Some(c) => match &plan.presets {
                            None => raw_ok(c, *cmp),
                            Some(list) => {
                                if preset != NO_PRESET {
                                    phys_ok(c, &presets[usize::from(preset)], *cmp)
                                } else if let Some(k) =
                                    list.iter().position(|p| phys_ok(c, p, *cmp))
                                {
                                    preset = assign_preset(&mut presets, &mut op_base, list, k)?;
                                    true
                                } else {
                                    false
                                }
                            }
                        },
                        None => false,
                    },
                };
                if keep {
                    let ch = set.changes[j].saturating_add(u16::from(differs(cur, prev)));
                    out.push(d, to_store(cur), preset, ch);
                }
            }
            i = end;
        }
        let history_covered = match plan.kind {
            NextKind::Stable { .. } => Some(
                stable
                    .iter()
                    .zip(&evaluated)
                    .all(|(st, &ev)| !ev || st.as_ref().is_some_and(|st| st.covered)),
            ),
            _ => None,
        };
        let mut st = self.scan.lock();
        if self.scan_stale(gen) {
            return Err(superseded());
        }
        st.version += 1;
        let version = st.version;
        let Some(a) = st.active.as_mut() else {
            return Err(ReError::NoScan("value scan was reset".into()));
        };
        let mut history_counts = base.history.clone();
        history_counts.push(out.len() as u64);
        let new_core = ScanCore {
            set: Arc::new(out),
            presets,
            step: base.step + 1,
            history: history_counts,
            truncated,
            elapsed_ms: t0.elapsed().as_secs_f64() * 1e3,
            history_covered,
            version,
        };
        let old = std::mem::replace(&mut a.core, new_core);
        a.undo.push_back(old);
        while a.undo.len() > RE_SCAN_MAX_UNDO {
            a.undo.pop_front();
        }
        st.cache = None;
        Ok(st.status())
    }

    /// `cmd_re_scan_results`: one page of grouped rows (S10), current values re-read now.
    pub fn scan_results(
        &self,
        offset: u32,
        limit: u32,
        sort: ReScanSort,
    ) -> Result<ReScanResultsDto, ReError> {
        if limit == 0 || limit > RE_SCAN_MAX_RESULTS {
            return Err(invalid(format!(
                "limit {limit} outside 1..={RE_SCAN_MAX_RESULTS}"
            )));
        }
        let (_, epoch) = self.analyzer_epoch();
        let (ctx, core, cached) = {
            let mut st = self.scan.lock();
            st.sync_epoch(epoch);
            let Some(a) = st.active.as_ref() else {
                return Err(ReError::NoScan("no active value scan".into()));
            };
            let ver = a.core.version;
            let cached = st.cache.as_ref().filter(|c| c.version == ver).map(|c| {
                (
                    Arc::clone(&c.grouping),
                    c.by_width.clone(),
                    c.by_changes.clone(),
                )
            });
            (Arc::clone(&a.ctx), a.core.clone(), cached)
        };
        let set = &*core.set;
        let (grouping, by_width, by_changes) = match cached {
            Some(c) => c,
            None => (Arc::new(group(set)), None, None),
        };
        let order: Option<Arc<Vec<u32>>> = match sort {
            ReScanSort::Id => None,
            ReScanSort::Width => Some(by_width.unwrap_or_else(|| {
                Arc::new(sorted_entries(&grouping, |rep| {
                    (Reverse(d_len(set.desc[rep])), rep)
                }))
            })),
            ReScanSort::Changes => Some(by_changes.unwrap_or_else(|| {
                Arc::new(sorted_entries(&grouping, |rep| {
                    (Reverse(set.changes[rep]), rep)
                }))
            })),
        };
        {
            let mut st = self.scan.lock();
            let current = st
                .active
                .as_ref()
                .is_some_and(|a| a.core.version == core.version);
            if current {
                let c = st.cache.get_or_insert_with(|| GroupCache {
                    version: core.version,
                    grouping: Arc::clone(&grouping),
                    by_width: None,
                    by_changes: None,
                });
                if c.version != core.version {
                    *c = GroupCache {
                        version: core.version,
                        grouping: Arc::clone(&grouping),
                        by_width: None,
                        by_changes: None,
                    };
                }
                match sort {
                    ReScanSort::Width => c.by_width = order.clone(),
                    ReScanSort::Changes => c.by_changes = order.clone(),
                    ReScanSort::Id => {}
                }
            }
        }
        let total = grouping.entries.len();
        let from = (offset as usize).min(total);
        let to = (from + limit as usize).min(total);
        let page: Vec<(u32, u32, u32)> = (from..to)
            .map(|k| match &order {
                Some(o) => grouping.entries[o[k] as usize],
                None => grouping.entries[k],
            })
            .collect();
        // Rows touched by the page -> one bounded copy under the analyzer lock.
        let mut need: Vec<usize> = Vec::new();
        for &(rep, off, cnt) in &page {
            need.push(d_row(set.desc[rep as usize]));
            for &c in &grouping.children[off as usize..(off + cnt) as usize] {
                need.push(d_row(set.desc[c as usize]));
            }
        }
        need.sort_unstable();
        need.dedup();
        let snaps = if need.is_empty() {
            Vec::new()
        } else {
            let mut a = self.analyzer.lock();
            if a.reset_epoch != ctx.epoch {
                return Err(ReError::NoScan("RE analyzer was reset".into()));
            }
            a.scan_copy_keys(
                need.iter().map(|&r| &ctx.rows[r].key),
                ctx.mode.needs_history(),
                false,
            )
        };
        let snap_of = |row: usize| -> Option<&RowSnap> {
            need.binary_search(&row)
                .ok()
                .and_then(|k| snaps[k].as_ref())
        };
        let cand = |i: usize| -> ReScanCandidateDto {
            let d = set.desc[i];
            let (bus, ext, arb) = ctx.rows[d_row(d)].key;
            ReScanCandidateDto {
                bus,
                arb_id: arb,
                is_extended: ext,
                start_bit: d_start(d),
                bit_length: u16::from(d_len(d)),
                byte_order: if d_moto(d) {
                    ReByteOrder::Motorola
                } else {
                    ReByteOrder::Intel
                },
                value_type: match d_vt(d) {
                    VT_U => ReValueType::Unsigned,
                    VT_S => ReValueType::Signed,
                    VT_F32 => ReValueType::Float32,
                    _ => ReValueType::Float64,
                },
            }
        };
        let rows = page
            .iter()
            .map(|&(rep, off, cnt)| {
                let i = rep as usize;
                let d = set.desc[i];
                let sh = d_shape(d);
                let row = d_row(d);
                let cur = snap_of(row).and_then(|s| read_value(s, sh, d_vt(d), ctx.mode));
                let preset =
                    (set.preset[i] != NO_PRESET).then(|| core.presets[usize::from(set.preset[i])]);
                let kind_hint = ctx.rows[row]
                    .fields
                    .iter()
                    .find(|(m, _)| mask_within(&sh.mask, m))
                    .map(|(_, k)| *k);
                ReScanResultRowDto {
                    candidate: cand(i),
                    preset,
                    current_raw: cur,
                    current_physical: match (cur, preset) {
                        (Some(c), Some(p)) => Some(c * p.factor + p.offset),
                        _ => None,
                    },
                    previous_raw: from_store(set.value[i]),
                    change_count: u32::from(set.changes[i]),
                    kind_hint,
                    contained_count: cnt,
                    contained: grouping.children[off as usize..(off + cnt) as usize]
                        .iter()
                        .map(|&c| cand(c as usize))
                        .collect(),
                }
            })
            .collect();
        Ok(ReScanResultsDto {
            scan_id: ctx.scan_id,
            step: core.step,
            total: total as u32,
            candidates: set.len() as u64,
            offset,
            rows,
        })
    }
}

fn too_large(n: usize, up_front: bool) -> ReError {
    ReError::ScanTooLarge(format!(
        "{}{n} candidates exceed the {RE_SCAN_MAX_CANDIDATES} cap; narrow the scan (bus / ID filter, fewer lengths, nibble / byte alignment, one byte order)",
        if up_front { "" } else { "more than " }
    ))
}

/// Appends the op preset list to the scan's preset table once per step; index of `list[k]`.
fn assign_preset(
    table: &mut Arc<Vec<ReScalePresetDto>>,
    base: &mut Option<usize>,
    list: &[ReScalePresetDto],
    k: usize,
) -> Result<u16, ReError> {
    let b = match *base {
        Some(b) => b,
        None => {
            if table.len() + list.len() > MAX_PRESET_TABLE {
                return Err(invalid("preset table full; start a new scan"));
            }
            let t = Arc::make_mut(table);
            let b = t.len();
            t.extend_from_slice(list);
            *base = Some(b);
            b
        }
    };
    Ok((b + k) as u16)
}

fn sorted_entries<K: Ord>(g: &Grouping, key: impl Fn(usize) -> K) -> Vec<u32> {
    let mut v: Vec<u32> = (0..g.entries.len() as u32).collect();
    v.sort_unstable_by_key(|&e| key(g.entries[e as usize].0 as usize));
    v
}

/// Classifier fields `(mask, kind)` per row (parallel over rows; pure).
fn classify_rows(snaps: &[RowSnap]) -> Vec<Vec<([u64; 8], ReFieldKind)>> {
    let one = |s: &RowSnap| -> Vec<([u64; 8], ReFieldKind)> {
        classify_history(&s.hist, &s.hist_ts, usize::from(s.dlc))
            .fields
            .iter()
            .filter_map(|f| {
                let moto = f.byte_order == ReByteOrder::Motorola;
                let len = u8::try_from(f.bit_length).ok()?;
                shape(moto, f.start_bit, len).map(|sh| (sh.mask, f.kind))
            })
            .collect()
    };
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(8);
    if snaps.len() < 32 || threads < 2 {
        return snaps.iter().map(one).collect();
    }
    let chunk = snaps.len().div_ceil(threads);
    std::thread::scope(|sc| {
        let handles: Vec<_> = snaps
            .chunks(chunk)
            .map(|c| sc.spawn(move || c.iter().map(one).collect::<Vec<_>>()))
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().expect("classifier worker"))
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_order_is_id_order() {
        let a = pack(0, 3, 8, false, VT_S);
        let b = pack(0, 3, 8, true, VT_U);
        let c = pack(0, 3, 12, false, VT_U);
        let d = pack(1, 0, 1, false, VT_U);
        assert!(a < b && b < c && c < d);
        assert_eq!(
            (d_row(c), d_start(c), d_len(c), d_moto(b), d_vt(a)),
            (0, 3, 12, true, VT_S)
        );
    }

    #[test]
    fn shape_matches_normalized_bit_span() {
        let s = shape(true, 11, 12).unwrap();
        assert_eq!(s.lsb, 16);
        assert!(s.multi_byte);
        assert!(shape(true, 3, 4).is_some_and(|s| !s.multi_byte));
        let p = {
            let mut p = [0u8; 64];
            p[1] = 0x0B;
            p[2] = 0xB8;
            p
        };
        assert_eq!(decode(s, VT_U, &p, 8), Some(3000.0));
        assert_eq!(decode(s, VT_U, &p, 2), None, "span past the frame length");
    }

    #[test]
    fn grid_is_factor_major() {
        let g = grid();
        assert_eq!(g.len(), 66);
        assert_eq!(
            g[1],
            ReScalePresetDto {
                factor: 1.0,
                offset: -40.0
            }
        );
        assert_eq!(
            g[6],
            ReScalePresetDto {
                factor: 0.1,
                offset: 0.0
            }
        );
    }
}
