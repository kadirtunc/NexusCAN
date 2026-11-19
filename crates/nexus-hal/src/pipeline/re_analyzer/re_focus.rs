//! RE Toolkit R2a — Signal Inspector (`planning/contracts/re-toolkit-v1.md` §6).
//!
//! * **Focus rings** (§6.1): up to [`MAX_RE_FOCUS`] targets `(bus, arbId, isExtended)`, each with a
//!   ring of [`RE_FOCUS_DEPTH`] samples `{ tsUs, len, payload[64] }` allocated **once** when the
//!   target is focused. Ingest ([`FocusRing::push`]) is a fixed-size copy: zero allocation per frame.
//! * **Series** (§6.3): candidate / reference time series, min/max-decimated into the `NRS1`
//!   little-endian binary layout.
//! * **Correlation** (§6.2): exhaustive bit-field sweep against a reference. Split in two so the
//!   engine never holds the analyzer lock for the sweep: [`ReAnalyzer::prepare_correlation`]
//!   copies the bounded ring windows out (under the lock), [`ReCorrelationJob::run`] sweeps on the
//!   caller's worker thread with a wall-time budget and a cancellation predicate.
//! * **OBD-II reference** (§6.4): Mode-01 single-frame responses on the bus, decoded by
//!   [`obd_pid_value`] (Rust port of `PID_CATALOG` in `src/types/diagnostics.ts`).
//!
//! Bit math is `nexus_netdb::compiler::bit_plan::NormalizedBitSpan` only; value conversion mirrors
//! `CompiledSignal::decode_physical` (unsigned / two's-complement signed / f32 / f64).

use super::{ReAnalyzer, ReByteOrder, RePhase, RowKey};
use nexus_core::{RawCanFrame, EXT_CAN_ID_MASK, STD_CAN_ID_MASK};
use nexus_netdb::compiler::bit_plan::NormalizedBitSpan;
use nexus_netdb::ir::ByteOrder;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering as CmpOrdering;
use std::time::{Duration, Instant};

// ─── Limits ─────────────────────────────────────────────────────────────────

/// Maximum number of focused targets (explicit + automatic reference targets).
pub const MAX_RE_FOCUS: usize = 8;
/// Samples per focus ring (power of two).
pub const RE_FOCUS_DEPTH: usize = 16_384;
/// Maximum candidates per `cmd_re_series` call.
pub const RE_SERIES_MAX_CANDIDATES: usize = 4;
/// `maxPoints` bounds of `cmd_re_series`.
pub const RE_SERIES_MIN_POINTS: u16 = 16;
pub const RE_SERIES_MAX_POINTS: u16 = 4_096;
/// Series binary magic (`"NRS1"`).
pub const RE_SERIES_MAGIC: [u8; 4] = *b"NRS1";
/// Series binary header / per-series header / per-point sizes in bytes (§6.3).
pub const RE_SERIES_HEADER_BYTES: usize = 16;
pub const RE_SERIES_ENTRY_BYTES: usize = 8;
pub const RE_SERIES_POINT_BYTES: usize = 20;
/// Series kind codes.
pub const RE_SERIES_KIND_CANDIDATE: u8 = 0;
pub const RE_SERIES_KIND_REFERENCE: u8 = 1;
/// Correlation sweep wall-time budget (`truncated = true` when cut).
pub const RE_CORRELATE_BUDGET: Duration = Duration::from_secs(2);
/// Zero-order hold: a target sample older than this (relative to the reference time) is not used.
pub const RE_ZOH_MAX_AGE_US: u64 = 1_000_000;
/// Lag search: `[-500, +500] ms`, step 10 ms, top rows only (a lag must keep ≥ 90 % of the
/// lag-0 pairs and never holds past the last target sample).
pub const RE_LAG_RANGE_MS: i64 = 500;
pub const RE_LAG_STEP_MS: i64 = 10;
/// Lag-search pool: best rows by lag-0 |r| that get a lag search (topN x 6, 64..=300).
pub const RE_LAG_POOL_MAX: usize = 300;
/// A lag must keep at least this percentage of the lag-0 samples (amendment R2a-1).
pub const RE_LAG_MIN_OVERLAP_PCT: usize = 95;
/// A non-zero lag is reported only when `|r|` improves by more than this.
pub const RE_LAG_MIN_GAIN: f64 = 0.01;
/// Superset dedupe threshold on `|r|`.
pub const RE_DEDUPE_DELTA_R: f64 = 0.002;
/// `topN` upper bound.
pub const RE_CORRELATE_MAX_TOP_N: u8 = 50;
/// Search field lengths are within `1..=32`.
pub const RE_SEARCH_MAX_LEN: u16 = 32;

const _: () = assert!(RE_FOCUS_DEPTH.is_power_of_two());

// ─── Errors ─────────────────────────────────────────────────────────────────

/// R2a error; `Display` = `"[re:<code>] message"` (codes `invalid | focus_full | no_reference | not_started`).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ReError {
    #[error("[re:invalid] {0}")]
    Invalid(String),
    #[error("[re:focus_full] {0}")]
    FocusFull(String),
    #[error("[re:no_reference] {0}")]
    NoReference(String),
    #[error("[re:not_started] {0}")]
    NotStarted(String),
    /// R2c: first-scan survivors exceed `RE_SCAN_MAX_CANDIDATES`.
    #[error("[re:scan_too_large] {0}")]
    ScanTooLarge(String),
    /// R2c: next / undo / results without an active value scan.
    #[error("[re:no_scan] {0}")]
    NoScan(String),
}

impl ReError {
    /// Wire code (`invalid`, `focus_full`, `no_reference`, `not_started`, `scan_too_large`, `no_scan`).
    pub fn code(&self) -> &'static str {
        match self {
            ReError::Invalid(_) => "invalid",
            ReError::FocusFull(_) => "focus_full",
            ReError::NoReference(_) => "no_reference",
            ReError::NotStarted(_) => "not_started",
            ReError::ScanTooLarge(_) => "scan_too_large",
            ReError::NoScan(_) => "no_scan",
        }
    }
}

fn invalid(msg: impl Into<String>) -> ReError {
    ReError::Invalid(msg.into())
}

// ─── DTOs (§6.2) ────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReTargetDto {
    pub bus: u8,
    pub arb_id: u32,
    pub is_extended: bool,
}

impl ReTargetDto {
    pub(super) fn key(&self) -> Result<RowKey, ReError> {
        let max = if self.is_extended {
            EXT_CAN_ID_MASK
        } else {
            STD_CAN_ID_MASK
        };
        if self.arb_id > max {
            return Err(invalid(format!(
                "arbId 0x{:X} exceeds the {} range",
                self.arb_id,
                if self.is_extended { "29-bit" } else { "11-bit" }
            )));
        }
        Ok((self.bus, self.is_extended, self.arb_id))
    }
}

/// One focused target with its ring fill (`ReTargetDto & { samples, firstUs, lastUs, auto }`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReFocusTargetStatusDto {
    pub bus: u8,
    pub arb_id: u32,
    pub is_extended: bool,
    pub samples: u32,
    pub first_us: Option<u64>,
    pub last_us: Option<u64>,
    /// `true` = focused automatically for a reference (`cmd_re_series` / `cmd_re_correlate`).
    pub auto: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReFocusStatusDto {
    pub targets: Vec<ReFocusTargetStatusDto>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReValueType {
    Unsigned,
    Signed,
    Float32,
    Float64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReCandidateDto {
    /// Intel: LSB bit. Motorola: DBC MSB start bit (sawtooth numbering).
    pub start_bit: u16,
    /// `1..=64` (float32 = 32, float64 = 64).
    pub bit_length: u16,
    pub byte_order: ReByteOrder,
    pub value_type: ReValueType,
    pub factor: f64,
    pub offset: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReMarkerPointDto {
    pub marker_id: u32,
    pub value: f64,
}

/// Reference signal (`kind` tag: `obd_pid | markers | candidate`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReReferenceDto {
    /// Decoded from on-bus OBD-II Mode-01 responses (§6.4).
    ObdPid { pid: u8, bus: u8 },
    /// Step function at marker timestamps (≥ 2 points).
    Markers { points: Vec<ReMarkerPointDto> },
    /// Another candidate signal as reference.
    Candidate {
        target: ReTargetDto,
        candidate: ReCandidateDto,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReSearchDto {
    /// Only candidates whose (Intel-numbered) bits all lie inside `[bitFrom, bitTo]`.
    pub bit_from: u16,
    pub bit_to: u16,
    /// `[min, max]` within `1..=32`.
    pub lengths: [u16; 2],
    pub byte_orders: Vec<ReByteOrder>,
    pub signed: Vec<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReSeriesRequest {
    pub target: ReTargetDto,
    pub candidates: Vec<ReCandidateDto>,
    pub reference: Option<ReReferenceDto>,
    pub from_us: Option<u64>,
    pub to_us: Option<u64>,
    pub max_points: u16,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReCorrelateRequest {
    pub target: ReTargetDto,
    pub reference: ReReferenceDto,
    pub from_us: Option<u64>,
    pub to_us: Option<u64>,
    pub search: ReSearchDto,
    pub top_n: u8,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReCorrelationRowDto {
    /// `factor` / `offset` = least-squares fit raw -> reference.
    pub candidate: ReCandidateDto,
    pub r: f64,
    pub r2: f64,
    /// In reference units.
    pub rmse: f64,
    pub samples: u32,
    /// Best lag (10 ms grid, ±500 ms): `lagMs > 0` = the target changes **before** the
    /// reference (reference ≈ target shifted later by `lagMs`). `r` / fit are at that lag.
    pub lag_ms: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReCorrelationResultDto {
    /// Sorted by `|r|` desc, then shorter `bitLength`.
    pub rows: Vec<ReCorrelationRowDto>,
    pub evaluated: u32,
    pub reference_samples: u32,
    pub elapsed_ms: f64,
    pub truncated: bool,
}

// ─── OBD-II PID catalog (port of `PID_CATALOG`, src/types/diagnostics.ts) ───

/// `(pid, data bytes)` of every catalog PID (same list as the TS `PID_CATALOG`).
pub const OBD_PID_CATALOG: [(u8, usize); 12] = [
    (0x04, 1),
    (0x05, 1),
    (0x0C, 2),
    (0x0D, 1),
    (0x0F, 1),
    (0x10, 2),
    (0x11, 1),
    (0x2F, 1),
    (0x33, 1),
    (0x42, 2),
    (0x46, 1),
    (0x5C, 1),
];

fn obd_pid_bytes(pid: u8) -> Option<usize> {
    OBD_PID_CATALOG
        .iter()
        .find(|(p, _)| *p == pid)
        .map(|&(_, n)| n)
}

/// Physical value of a Mode-01 PID from its data bytes `[A, B, ...]` (bytes after the PID byte).
/// `None` for PIDs outside the catalog or when `data` is shorter than the PID needs.
pub fn obd_pid_value(pid: u8, data: &[u8]) -> Option<f64> {
    let n = obd_pid_bytes(pid)?;
    if data.len() < n {
        return None;
    }
    let a = f64::from(data[0]);
    let ab = || 256.0 * a + f64::from(data[1]);
    Some(match pid {
        0x04 | 0x11 | 0x2F => a / 2.55,
        0x05 | 0x0F | 0x46 | 0x5C => a - 40.0,
        0x0C => ab() / 4.0,
        0x0D | 0x33 => a,
        0x10 => ab() / 100.0,
        0x42 => ab() / 1000.0,
        _ => return None,
    })
}

/// `true` for OBD-II response IDs: 11-bit `0x7E8..=0x7EF`, 29-bit `0x18DAF1xx`.
fn is_obd_response(key: RowKey) -> bool {
    if key.1 {
        key.2 & 0x1FFF_FF00 == 0x18DA_F100
    } else {
        (0x7E8..=0x7EF).contains(&key.2)
    }
}

/// Decodes a Mode-01 single-frame positive response `[len, 0x41, pid, A, B, C, D]` for `pid`.
/// Amendment R2a-4: the single-frame length byte must be `>= 2 + data bytes of the PID` and
/// `<= 7`; the frame must actually carry those bytes.
fn obd_decode_frame(pid: u8, payload: &[u8]) -> Option<f64> {
    let n = obd_pid_bytes(pid)?;
    if payload.len() < 3 + n {
        return None;
    }
    let sf_len = usize::from(payload[0]);
    if sf_len < 2 + n || sf_len > 7 || payload[1] != 0x41 || payload[2] != pid {
        return None;
    }
    obd_pid_value(pid, &payload[3..3 + n])
}

// ─── Focus ring ─────────────────────────────────────────────────────────────

/// Preallocated sample ring of one focused target (≈ 1.2 MiB, allocated once).
pub(crate) struct FocusRing {
    key: RowKey,
    auto: bool,
    ts: Box<[u64]>,
    len: Box<[u8]>,
    payload: Box<[[u8; 64]]>,
    head: usize,
    count: usize,
}

impl FocusRing {
    fn new(key: RowKey, auto: bool) -> Self {
        Self {
            key,
            auto,
            ts: vec![0u64; RE_FOCUS_DEPTH].into_boxed_slice(),
            len: vec![0u8; RE_FOCUS_DEPTH].into_boxed_slice(),
            payload: vec![[0u8; 64]; RE_FOCUS_DEPTH].into_boxed_slice(),
            head: 0,
            count: 0,
        }
    }

    /// Hot path: fixed-size copy, overwrite-oldest, no allocation.
    #[inline]
    fn push(&mut self, ts: u64, data: &[u8; 64], n: usize) {
        let h = self.head;
        self.ts[h] = ts;
        self.len[h] = n as u8;
        let slot = &mut self.payload[h];
        slot[..n].copy_from_slice(&data[..n]);
        slot[n..].fill(0);
        self.head = (h + 1) & (RE_FOCUS_DEPTH - 1);
        if self.count < RE_FOCUS_DEPTH {
            self.count += 1;
        }
    }

    fn clear(&mut self) {
        self.head = 0;
        self.count = 0;
    }

    /// Ring index of the `i`-th oldest sample.
    #[inline]
    fn idx(&self, i: usize) -> usize {
        (self.head + RE_FOCUS_DEPTH - self.count + i) & (RE_FOCUS_DEPTH - 1)
    }

    fn chrono(&self) -> impl Iterator<Item = usize> + '_ {
        (0..self.count).map(move |i| self.idx(i))
    }

    #[inline]
    fn sample(&self, i: usize) -> (u64, &[u8]) {
        (self.ts[i], &self.payload[i][..usize::from(self.len[i])])
    }

    fn extent(&self) -> Option<(u64, u64)> {
        let mut it = self.chrono().map(|i| self.ts[i]);
        let first = it.next()?;
        Some(it.fold((first, first), |(lo, hi), t| (lo.min(t), hi.max(t))))
    }

    fn status(&self) -> ReFocusTargetStatusDto {
        let ext = self.extent();
        ReFocusTargetStatusDto {
            bus: self.key.0,
            arb_id: self.key.2,
            is_extended: self.key.1,
            samples: self.count as u32,
            first_us: ext.map(|e| e.0),
            last_us: ext.map(|e| e.1),
            auto: self.auto,
        }
    }
}

/// Aggregator hot path: routes a frame of row `key` into its focus ring (≤ 8 key compares).
#[inline]
pub(super) fn focus_ingest(rings: &mut [FocusRing], key: RowKey, f: &RawCanFrame) {
    for r in rings.iter_mut() {
        if r.key == key {
            r.push(f.timestamp_us, &f.data, usize::from(f.dlc.min(64)));
            return;
        }
    }
}

// ─── Candidate decoding (NormalizedBitSpan + decode_physical mirror) ────────

fn netdb_order(o: ReByteOrder) -> ByteOrder {
    match o {
        ReByteOrder::Intel => ByteOrder::LittleEndian,
        ReByteOrder::Motorola => ByteOrder::BigEndian,
    }
}

/// Raw -> value conversion mirroring `CompiledSignal::decode_physical` (factor 1, offset 0).
#[inline]
fn raw_to_value(vt: ReValueType, raw: u64, bit_len: u8) -> f64 {
    match vt {
        ReValueType::Unsigned => raw as f64,
        ReValueType::Signed => {
            let shift = 64 - u32::from(bit_len);
            (((raw << shift) as i64) >> shift) as f64
        }
        ReValueType::Float32 => f64::from(f32::from_bits(raw as u32)),
        ReValueType::Float64 => f64::from_bits(raw),
    }
}

/// Compiled candidate: span + conversion.
struct CandPlan {
    span: NormalizedBitSpan,
    vt: ReValueType,
    factor: f64,
    offset: f64,
}

impl CandPlan {
    fn new(c: &ReCandidateDto) -> Result<Self, ReError> {
        if c.bit_length == 0 || c.bit_length > 64 {
            return Err(invalid(format!(
                "bitLength {} outside 1..=64",
                c.bit_length
            )));
        }
        if c.start_bit >= 512 {
            return Err(invalid(format!("startBit {} outside 0..=511", c.start_bit)));
        }
        match c.value_type {
            ReValueType::Float32 if c.bit_length != 32 => {
                return Err(invalid("float32 candidates need bitLength 32"))
            }
            ReValueType::Float64 if c.bit_length != 64 => {
                return Err(invalid("float64 candidates need bitLength 64"))
            }
            _ => {}
        }
        if !c.factor.is_finite() || !c.offset.is_finite() {
            return Err(invalid("factor / offset must be finite"));
        }
        let span =
            NormalizedBitSpan::compile(c.start_bit, c.bit_length as u8, netdb_order(c.byte_order))
                .map_err(|e| invalid(format!("candidate bit span: {e}")))?;
        Ok(Self {
            span,
            vt: c.value_type,
            factor: c.factor,
            offset: c.offset,
        })
    }

    /// Physical value of one payload; `None` when the frame is too short for the span or the
    /// value is not finite (NaN / inf float payloads).
    #[inline]
    fn value(&self, payload: &[u8]) -> Option<f64> {
        if usize::from(self.span.max_byte) >= payload.len() {
            return None;
        }
        let raw = self.span.extract_raw_u64(payload);
        let v = raw_to_value(self.vt, raw, self.span.bit_len) * self.factor + self.offset;
        v.is_finite().then_some(v)
    }
}

// ─── Reference resolution ───────────────────────────────────────────────────

/// Resolved reference data (copied out of the rings / marker list).
enum RefData {
    /// Discrete samples `(tsUs, value)`, sorted by time.
    Samples(Vec<(u64, f64)>),
    /// Step function: value holds from each `(tsUs, value)` until the next, sorted by time.
    Steps(Vec<(u64, f64)>),
}

impl RefData {
    fn extent(&self) -> Option<(u64, u64)> {
        let v = match self {
            RefData::Samples(v) | RefData::Steps(v) => v,
        };
        Some((v.first()?.0, v.last()?.0))
    }
}

fn sort_by_ts(v: &mut [(u64, f64)]) {
    v.sort_by_key(|s| s.0);
}

/// Step-function value at `t` (last step with `ts <= t`).
fn step_at(steps: &[(u64, f64)], t: u64) -> Option<f64> {
    let i = steps.partition_point(|s| s.0 <= t);
    (i > 0).then(|| steps[i - 1].1)
}

// ─── Series encoding ────────────────────────────────────────────────────────

/// `(kind, index, samples)` of one series before encoding.
type SeriesData = (u8, u8, Vec<(u64, f64)>);

/// Writes one series (§6.3), min/max-decimated by time into ≤ `max_points` buckets (exact when
/// `samples.len() <= max_points`). `samples` must be sorted by time and lie in `[from, to]`.
/// Point time = time of the first sample of the bucket.
fn write_series(
    out: &mut Vec<u8>,
    kind: u8,
    index: u8,
    samples: &[(u64, f64)],
    from: u64,
    to: u64,
    max_points: u16,
) {
    out.push(kind);
    out.push(index);
    out.extend_from_slice(&0u16.to_le_bytes());
    let count_at = out.len();
    out.extend_from_slice(&0u32.to_le_bytes());
    let rel = |t: u64| (t.saturating_sub(from)).min(u64::from(u32::MAX)) as u32;
    let put = |out: &mut Vec<u8>, t: u64, lo: f64, hi: f64| {
        out.extend_from_slice(&rel(t).to_le_bytes());
        out.extend_from_slice(&lo.to_le_bytes());
        out.extend_from_slice(&hi.to_le_bytes());
    };
    let m = usize::from(max_points);
    let mut count: u32 = 0;
    if samples.len() <= m {
        for &(t, v) in samples {
            put(out, t, v, v);
            count += 1;
        }
    } else {
        let span = u128::from(to - from) + 1;
        let bucket = |t: u64| (u128::from(t - from) * m as u128 / span) as usize;
        let mut i = 0;
        while i < samples.len() {
            let b = bucket(samples[i].0);
            let t0 = samples[i].0;
            let (mut lo, mut hi) = (samples[i].1, samples[i].1);
            i += 1;
            while i < samples.len() && bucket(samples[i].0) == b {
                lo = lo.min(samples[i].1);
                hi = hi.max(samples[i].1);
                i += 1;
            }
            put(out, t0, lo, hi);
            count += 1;
        }
    }
    out[count_at..count_at + 4].copy_from_slice(&count.to_le_bytes());
}

// ─── Analyzer API (§6.1 / §6.2) ─────────────────────────────────────────────

impl ReAnalyzer {
    fn focus_index(&self, key: RowKey) -> Option<usize> {
        self.focus.iter().position(|r| r.key == key)
    }

    /// Replaces the focus set (≤ [`MAX_RE_FOCUS`] distinct targets; duplicates are merged).
    /// Kept targets keep their ring (and become explicit); new targets get a fresh empty ring.
    /// RE must be started (`[re:not_started]`), except for clearing the set with `[]`.
    pub fn focus_set(&mut self, targets: &[ReTargetDto]) -> Result<ReFocusStatusDto, ReError> {
        if !targets.is_empty() && !self.enabled {
            return Err(ReError::NotStarted(
                "RE sniffer is not running; call cmd_re_start before focusing targets".into(),
            ));
        }
        let mut keys: Vec<RowKey> = Vec::with_capacity(targets.len());
        for t in targets {
            let k = t.key()?;
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
        if keys.len() > MAX_RE_FOCUS {
            return Err(ReError::FocusFull(format!(
                "{} targets requested, at most {MAX_RE_FOCUS} can be focused",
                keys.len()
            )));
        }
        let mut old = std::mem::take(&mut self.focus);
        let mut next = Vec::with_capacity(MAX_RE_FOCUS);
        for k in keys {
            let ring = match old.iter().position(|r| r.key == k) {
                Some(i) => {
                    let mut r = old.swap_remove(i);
                    r.auto = false;
                    r
                }
                None => FocusRing::new(k, false),
            };
            next.push(ring);
        }
        self.focus = next;
        Ok(self.focus_status())
    }

    /// Focused targets in focus order with ring fill.
    pub fn focus_status(&self) -> ReFocusStatusDto {
        ReFocusStatusDto {
            targets: self.focus.iter().map(FocusRing::status).collect(),
        }
    }

    /// Empties every focus ring (targets kept); called by `reset`.
    pub(super) fn focus_clear_samples(&mut self) {
        for r in &mut self.focus {
            r.clear();
        }
    }

    /// Focuses `key` automatically for a reference (no-op when already focused). A new ring is
    /// seeded with the sniffer's payload history of that row (≤ 64 most recent frames) so the
    /// reference is usable immediately.
    fn ensure_auto_focus(&mut self, key: RowKey) -> Result<usize, ReError> {
        if let Some(i) = self.focus_index(key) {
            return Ok(i);
        }
        if self.focus.len() >= MAX_RE_FOCUS {
            return Err(ReError::FocusFull(format!(
                "reference id 0x{:X} on bus {} needs a focus slot; all {MAX_RE_FOCUS} are in use",
                key.2, key.0
            )));
        }
        let mut ring = FocusRing::new(key, true);
        if let Some(h) = self.row_history(key.0, key.2, key.1) {
            let n = usize::from(h.dlc_bytes);
            for (p, &ts) in h.payloads.iter().zip(&h.ts_us) {
                ring.push(ts, p, n);
            }
        }
        self.focus.push(ring);
        Ok(self.focus.len() - 1)
    }

    fn require_started(&self) -> Result<(), ReError> {
        if self.phase == RePhase::Idle {
            return Err(ReError::NotStarted(
                "RE sniffer has not been started (cmd_re_start)".into(),
            ));
        }
        Ok(())
    }

    fn require_target(&self, t: &ReTargetDto) -> Result<usize, ReError> {
        let key = t.key()?;
        self.focus_index(key).ok_or_else(|| {
            invalid(format!(
                "target 0x{:X} on bus {} is not focused (cmd_re_focus_set)",
                t.arb_id, t.bus
            ))
        })
    }

    fn obd_reference(&mut self, pid: u8, bus: u8) -> Result<RefData, ReError> {
        if obd_pid_bytes(pid).is_none() {
            return Err(invalid(format!(
                "OBD-II PID 0x{pid:02X} is not in the PID catalog"
            )));
        }
        let mut rings: Vec<usize> = self
            .focus
            .iter()
            .enumerate()
            .filter(|(_, r)| r.key.0 == bus && is_obd_response(r.key))
            .map(|(i, _)| i)
            .collect();
        if rings.is_empty() {
            let mut keys: Vec<RowKey> = self
                .index
                .keys()
                .copied()
                .filter(|&k| k.0 == bus && is_obd_response(k))
                .collect();
            keys.sort_unstable();
            if keys.is_empty() {
                return Err(ReError::NoReference(format!(
                    "no OBD-II responses (0x7E8..0x7EF / 0x18DAF1xx) seen on bus {bus}; a tester must be \
                     polling Mode 01 PID 0x{pid:02X} (Diagnostic Simulation panel, Live PID gauges or an external tool)"
                )));
            }
            for k in keys {
                rings.push(self.ensure_auto_focus(k)?);
            }
        }
        let mut v = Vec::new();
        for i in rings {
            let r = &self.focus[i];
            for j in r.chrono() {
                let (ts, p) = r.sample(j);
                if let Some(val) = obd_decode_frame(pid, p) {
                    v.push((ts, val));
                }
            }
        }
        sort_by_ts(&mut v);
        Ok(RefData::Samples(v))
    }

    fn resolve_reference(&mut self, r: &ReReferenceDto) -> Result<RefData, ReError> {
        match r {
            ReReferenceDto::ObdPid { pid, bus } => self.obd_reference(*pid, *bus),
            ReReferenceDto::Markers { points } => {
                if points.len() < 2 {
                    return Err(invalid("markers reference needs at least 2 points"));
                }
                let mut steps = Vec::with_capacity(points.len());
                for p in points {
                    if !p.value.is_finite() {
                        return Err(invalid(format!(
                            "marker {} value is not finite",
                            p.marker_id
                        )));
                    }
                    let m = self
                        .markers
                        .iter()
                        .find(|m| m.id == p.marker_id)
                        .ok_or_else(|| invalid(format!("marker {} not found", p.marker_id)))?;
                    steps.push((m.ts_us, m.id, p.value));
                }
                // Markers created within the same clock tick share `ts_us`; creation order (marker id,
                // monotonically increasing) breaks the tie so the step function is deterministic.
                steps.sort_by_key(|s| (s.0, s.1));
                Ok(RefData::Steps(
                    steps.into_iter().map(|(ts, _, v)| (ts, v)).collect(),
                ))
            }
            ReReferenceDto::Candidate { target, candidate } => {
                let plan = CandPlan::new(candidate)?;
                let i = self.ensure_auto_focus(target.key()?)?;
                let ring = &self.focus[i];
                let mut v: Vec<(u64, f64)> = ring
                    .chrono()
                    .filter_map(|j| {
                        let (ts, p) = ring.sample(j);
                        plan.value(p).map(|x| (ts, x))
                    })
                    .collect();
                sort_by_ts(&mut v);
                Ok(RefData::Samples(v))
            }
        }
    }

    /// `cmd_re_series`: candidate + reference series (§6.3) into `out` (cleared first).
    /// Window defaults to the extent of the target ring and the reference.
    pub fn series(&mut self, req: &ReSeriesRequest, out: &mut Vec<u8>) -> Result<(), ReError> {
        out.clear();
        self.require_started()?;
        if !(RE_SERIES_MIN_POINTS..=RE_SERIES_MAX_POINTS).contains(&req.max_points) {
            return Err(invalid(format!(
                "maxPoints {} outside {RE_SERIES_MIN_POINTS}..={RE_SERIES_MAX_POINTS}",
                req.max_points
            )));
        }
        if req.candidates.len() > RE_SERIES_MAX_CANDIDATES {
            return Err(invalid(format!(
                "{} candidates, at most {RE_SERIES_MAX_CANDIDATES}",
                req.candidates.len()
            )));
        }
        let plans = req
            .candidates
            .iter()
            .map(CandPlan::new)
            .collect::<Result<Vec<_>, _>>()?;
        let ti = self.require_target(&req.target)?;
        let ref_data = match &req.reference {
            Some(r) => Some(self.resolve_reference(r)?),
            None => None,
        };

        let ring = &self.focus[ti];
        let mut lo = u64::MAX;
        let mut hi = 0u64;
        for e in [ring.extent(), ref_data.as_ref().and_then(RefData::extent)]
            .into_iter()
            .flatten()
        {
            lo = lo.min(e.0);
            hi = hi.max(e.1);
        }
        if lo > hi {
            lo = 0;
            hi = 0;
        }
        let to = req.to_us.unwrap_or(hi);
        let from = req.from_us.unwrap_or(lo.min(to));
        if from > to {
            return Err(invalid(format!("fromUs {from} > toUs {to}")));
        }
        // Amendment R2a-7: point times are u32 µs offsets (≈ 71 min).
        if to - from > u64::from(u32::MAX) {
            return Err(invalid(format!(
                "window too long: {} µs exceeds the u32 µs series range (~71 min); narrow fromUs / toUs",
                to - from
            )));
        }
        let in_win = |t: u64| t >= from && t <= to;

        // Collect everything before writing so an error never leaves a partial buffer.
        let mut series: Vec<SeriesData> = Vec::with_capacity(plans.len() + 1);
        for (i, plan) in plans.iter().enumerate() {
            let mut v: Vec<(u64, f64)> = ring
                .chrono()
                .filter_map(|j| {
                    let (ts, p) = ring.sample(j);
                    if !in_win(ts) {
                        return None;
                    }
                    plan.value(p).map(|x| (ts, x))
                })
                .collect();
            sort_by_ts(&mut v);
            series.push((RE_SERIES_KIND_CANDIDATE, i as u8, v));
        }
        if let Some(rd) = ref_data {
            let v: Vec<(u64, f64)> = match rd {
                RefData::Samples(s) => s.into_iter().filter(|s| in_win(s.0)).collect(),
                RefData::Steps(steps) => {
                    let mut v = Vec::with_capacity(steps.len() + 1);
                    // Value held at the window start from an earlier step.
                    if let Some(x) = step_at(&steps, from) {
                        if !steps.iter().any(|s| s.0 == from) {
                            v.push((from, x));
                        }
                    }
                    v.extend(steps.iter().copied().filter(|s| in_win(s.0)));
                    v
                }
            };
            if v.is_empty() {
                if let Some(ReReferenceDto::ObdPid { pid, bus }) = &req.reference {
                    return Err(ReError::NoReference(format!(
                        "no Mode-01 responses for PID 0x{pid:02X} on bus {bus} in the window; \
                         a tester must be polling it"
                    )));
                }
            }
            series.push((RE_SERIES_KIND_REFERENCE, 0, v));
        }

        out.extend_from_slice(&RE_SERIES_MAGIC);
        out.push(series.len() as u8);
        out.push(0);
        out.extend_from_slice(&req.max_points.to_le_bytes());
        out.extend_from_slice(&from.to_le_bytes());
        for (kind, index, v) in &series {
            write_series(out, *kind, *index, v, from, to, req.max_points);
        }
        Ok(())
    }

    /// Validates `req`, resolves the reference (auto-focus) and copies the bounded ring windows
    /// out of the analyzer. Run the returned job **outside** the analyzer lock.
    pub fn prepare_correlation(
        &mut self,
        req: &ReCorrelateRequest,
    ) -> Result<ReCorrelationJob, ReError> {
        self.require_started()?;
        if req.top_n == 0 || req.top_n > RE_CORRELATE_MAX_TOP_N {
            return Err(invalid(format!(
                "topN {} outside 1..={RE_CORRELATE_MAX_TOP_N}",
                req.top_n
            )));
        }
        let s = &req.search;
        if s.bit_from > s.bit_to || s.bit_to > 511 {
            return Err(invalid(format!(
                "search bit range {}..{} invalid (0 <= bitFrom <= bitTo <= 511)",
                s.bit_from, s.bit_to
            )));
        }
        let [lmin, lmax] = s.lengths;
        if lmin == 0 || lmin > lmax || lmax > RE_SEARCH_MAX_LEN {
            return Err(invalid(format!(
                "search lengths [{lmin}, {lmax}] invalid (1 <= min <= max <= {RE_SEARCH_MAX_LEN})"
            )));
        }
        if s.byte_orders.is_empty() || s.signed.is_empty() {
            return Err(invalid("search byteOrders / signed must not be empty"));
        }
        let ti = self.require_target(&req.target)?;
        let rd = self.resolve_reference(&req.reference)?;

        let ring = &self.focus[ti];
        // Default window = target extent ∪ sampled-reference extent (a step reference is
        // evaluated at target sample times, so it does not widen the window).
        let mut ext = ring.extent();
        if let (RefData::Samples(_), Some(re)) = (&rd, rd.extent()) {
            ext = Some(match ext {
                Some((lo, hi)) => (lo.min(re.0), hi.max(re.1)),
                None => re,
            });
        }
        let (lo, hi) = ext.unwrap_or((0, 0));
        let from = req.from_us.unwrap_or(lo);
        let to = req.to_us.unwrap_or(hi);
        if from > to {
            return Err(invalid(format!("fromUs {from} > toUs {to}")));
        }
        // Target window incl. ZOH age and lag margins (bounded by the ring depth).
        let margin_lo = RE_ZOH_MAX_AGE_US + (RE_LAG_RANGE_MS as u64) * 1_000;
        let margin_hi = (RE_LAG_RANGE_MS as u64) * 1_000;
        let t_lo = from.saturating_sub(margin_lo);
        let t_hi = to.saturating_add(margin_hi);
        let mut idx: Vec<usize> = ring
            .chrono()
            .filter(|&j| (t_lo..=t_hi).contains(&ring.ts[j]))
            .collect();
        idx.sort_by_key(|&j| ring.ts[j]);
        let target_ts: Vec<u64> = idx.iter().map(|&j| ring.ts[j]).collect();
        let target_len: Vec<u8> = idx.iter().map(|&j| ring.len[j]).collect();
        let target_payload: Vec<[u8; 64]> = idx.iter().map(|&j| ring.payload[j]).collect();

        let in_win = |t: u64| t >= from && t <= to;
        let reference: Vec<(u64, f64)> = match rd {
            RefData::Samples(v) => v.into_iter().filter(|s| in_win(s.0)).collect(),
            RefData::Steps(steps) => target_ts
                .iter()
                .copied()
                .filter(|&t| in_win(t))
                .filter_map(|t| step_at(&steps, t).map(|x| (t, x)))
                .collect(),
        };
        if reference.is_empty() {
            let hint = match &req.reference {
                ReReferenceDto::ObdPid { pid, bus } => format!(
                    "no Mode-01 responses for PID 0x{pid:02X} on bus {bus} in the window; a tester must be polling it"
                ),
                ReReferenceDto::Markers { .. } => {
                    "no target samples after the first marker in the window".to_string()
                }
                ReReferenceDto::Candidate { .. } => {
                    "reference candidate has no samples in the window".to_string()
                }
            };
            return Err(ReError::NoReference(hint));
        }
        let dlc_bits = usize::from(target_len.iter().copied().max().unwrap_or(0)) * 8;
        Ok(ReCorrelationJob {
            target_ts,
            target_payload,
            ref_ts: reference.iter().map(|s| s.0).collect(),
            ref_val: reference.iter().map(|s| s.1).collect(),
            search: s.clone(),
            top_n: usize::from(req.top_n),
            dlc_bits,
        })
    }

    /// `cmd_re_correlate` convenience: [`Self::prepare_correlation`] + [`ReCorrelationJob::run`]
    /// with the 2 s budget (no external cancellation). The engine splits the two steps so the
    /// sweep never runs under the analyzer lock.
    pub fn correlate(
        &mut self,
        req: &ReCorrelateRequest,
    ) -> Result<ReCorrelationResultDto, ReError> {
        let job = self.prepare_correlation(req)?;
        Ok(job.run(RE_CORRELATE_BUDGET, &|| false))
    }
}

// ─── Correlation job (runs off the aggregator, outside the lock) ────────────

/// Bounded copy of the target window + reference samples for one correlation sweep.
pub struct ReCorrelationJob {
    target_ts: Vec<u64>,
    target_payload: Vec<[u8; 64]>,
    ref_ts: Vec<u64>,
    ref_val: Vec<f64>,
    search: ReSearchDto,
    top_n: usize,
    dlc_bits: usize,
}

/// One evaluated candidate.
#[derive(Clone)]
struct Hit {
    mask: [u64; 8],
    cand: ReCandidateDto,
    r: f64,
    factor: f64,
    offset: f64,
    rmse: f64,
    samples: u32,
}

#[derive(Clone, Copy)]
struct Fit {
    r: f64,
    factor: f64,
    offset: f64,
    rmse: f64,
    n: usize,
}

/// Two-pass Pearson / least-squares over `(x, y)` pairs; `None` when either side has zero variance.
fn fit(x: impl Iterator<Item = f64> + Clone, y: impl Iterator<Item = f64> + Clone) -> Option<Fit> {
    let mut n = 0usize;
    let (mut sx, mut sy) = (0.0f64, 0.0f64);
    for (a, b) in x.clone().zip(y.clone()) {
        sx += a;
        sy += b;
        n += 1;
    }
    if n < 3 {
        return None;
    }
    let nf = n as f64;
    let (mx, my) = (sx / nf, sy / nf);
    let (mut sxx, mut syy, mut sxy) = (0.0f64, 0.0f64, 0.0f64);
    for (a, b) in x.zip(y) {
        let (dx, dy) = (a - mx, b - my);
        sxx += dx * dx;
        syy += dy * dy;
        sxy += dx * dy;
    }
    if sxx <= 0.0 || syy <= 0.0 || !sxx.is_finite() || !syy.is_finite() {
        return None;
    }
    let r = (sxy / (sxx * syy).sqrt()).clamp(-1.0, 1.0);
    let factor = sxy / sxx;
    let offset = my - factor * mx;
    let sse = (syy - factor * sxy).max(0.0);
    Some(Fit {
        r,
        factor,
        offset,
        rmse: (sse / nf).sqrt(),
        n,
    })
}

fn span_mask(span: &NormalizedBitSpan) -> [u64; 8] {
    let mut m = [0u64; 8];
    for &(byte, bib) in &span.bit_coords {
        let b = usize::from(byte) * 8 + usize::from(bib);
        m[b / 64] |= 1u64 << (b % 64);
    }
    m
}

fn is_superset(a: &[u64; 8], b: &[u64; 8]) -> bool {
    a.iter().zip(b).all(|(x, y)| x & y == *y)
}

fn rank(a: &Hit, b: &Hit) -> CmpOrdering {
    b.r.abs()
        .total_cmp(&a.r.abs())
        .then(a.cand.bit_length.cmp(&b.cand.bit_length))
        .then(
            (a.cand.value_type == ReValueType::Signed)
                .cmp(&(b.cand.value_type == ReValueType::Signed)),
        )
        .then(
            (a.cand.byte_order == ReByteOrder::Motorola)
                .cmp(&(b.cand.byte_order == ReByteOrder::Motorola)),
        )
        .then(a.cand.start_bit.cmp(&b.cand.start_bit))
}

/// Keeps the best `n` rows, dropping a row whose bit set is a **proper** superset of a
/// better-ranked kept row with `||r| - |r_kept|| < RE_DEDUPE_DELTA_R` (prefer the minimal
/// field). Rank scores are only compared between rows evaluated on the same sample count.
/// `rows` must be sorted by [`rank`].
fn dedupe_lagged(rows: Vec<(Hit, f64)>, n: usize) -> Vec<(Hit, f64)> {
    let mut kept: Vec<(Hit, f64)> = Vec::with_capacity(n);
    for row in rows {
        if kept.len() >= n {
            break;
        }
        let h = &row.0;
        let dup = kept.iter().any(|(k, _)| {
            h.mask != k.mask
                && h.samples == k.samples
                && is_superset(&h.mask, &k.mask)
                && (h.r.abs() - k.r.abs()).abs() < RE_DEDUPE_DELTA_R
        });
        if !dup {
            kept.push(row);
        }
    }
    kept
}

impl ReCorrelationJob {
    /// Number of reference samples in the window.
    pub fn reference_samples(&self) -> usize {
        self.ref_ts.len()
    }

    /// Zero-order-hold alignment at `lag_us`: `(target index, reference index)` pairs where the
    /// target sample is the last one with `ts <= t_ref + lag` and not older than 1 s.
    fn align(&self, lag_us: i64) -> Vec<(u32, u32)> {
        let mut pairs = Vec::with_capacity(self.ref_ts.len());
        let mut j = 0usize; // number of target samples with ts <= tq
        for (i, &t) in self.ref_ts.iter().enumerate() {
            let tq = t as i64 + lag_us;
            if tq < 0 {
                continue;
            }
            let tq = tq as u64;
            while j < self.target_ts.len() && self.target_ts[j] <= tq {
                j += 1;
            }
            if j == 0 {
                continue;
            }
            if tq - self.target_ts[j - 1] > RE_ZOH_MAX_AGE_US {
                continue;
            }
            // Shifted alignments never hold past the end of the target data: otherwise a lag
            // comparable to the window maps many reference samples onto the last target sample
            // and fabricates a near-perfect r from a few distinct values.
            if lag_us != 0 && j == self.target_ts.len() && tq > self.target_ts[j - 1] {
                continue;
            }
            pairs.push(((j - 1) as u32, i as u32));
        }
        pairs
    }

    /// Exhaustive sweep. Stops early (`truncated = true`) when `budget` elapses or `cancelled()`
    /// returns `true` (newer call). Pure CPU work on the caller's thread.
    pub fn run(&self, budget: Duration, cancelled: &dyn Fn() -> bool) -> ReCorrelationResultDto {
        let t0 = Instant::now();
        let stop = || t0.elapsed() >= budget || cancelled();
        let mut truncated = false;
        let mut evaluated: u32 = 0;
        let mut hits: Vec<Hit> = Vec::new();

        let pairs = self.align(0);
        let ys: Vec<f64> = pairs
            .iter()
            .map(|&(_, i)| self.ref_val[i as usize])
            .collect();
        let s = &self.search;
        let bit_hi = usize::from(s.bit_to).min(self.dlc_bits.saturating_sub(1));
        let bit_lo = usize::from(s.bit_from);
        let mut orders: Vec<ReByteOrder> = Vec::with_capacity(2);
        for o in [ReByteOrder::Intel, ReByteOrder::Motorola] {
            if s.byte_orders.contains(&o) {
                orders.push(o);
            }
        }
        let mut signs: Vec<bool> = Vec::with_capacity(2);
        for sg in [false, true] {
            if s.signed.contains(&sg) {
                signs.push(sg);
            }
        }

        let y_var = pairs.len() >= 3 && fit(ys.iter().copied(), ys.iter().copied()).is_some();
        if self.dlc_bits > 0 && bit_lo <= bit_hi && y_var {
            let mut raws: Vec<u64> = vec![0; pairs.len()];
            'outer: for &order in &orders {
                for start in bit_lo..=bit_hi {
                    if stop() {
                        truncated = true;
                        break 'outer;
                    }
                    for len in s.lengths[0]..=s.lengths[1] {
                        let Ok(span) =
                            NormalizedBitSpan::compile(start as u16, len as u8, netdb_order(order))
                        else {
                            break;
                        };
                        let in_range = span.bit_coords.iter().all(|&(byte, bib)| {
                            let b = usize::from(byte) * 8 + usize::from(bib);
                            b >= bit_lo && b <= bit_hi
                        });
                        if !in_range {
                            // Longer spans contain this one's bits: they are out of range too.
                            break;
                        }
                        for (k, &(ti, _)) in pairs.iter().enumerate() {
                            raws[k] = span.extract_raw_u64(&self.target_payload[ti as usize]);
                        }
                        let mask = span_mask(&span);
                        for &signed in &signs {
                            evaluated += 1;
                            let vt = if signed {
                                ReValueType::Signed
                            } else {
                                ReValueType::Unsigned
                            };
                            let xs = raws.iter().map(|&r| raw_to_value(vt, r, len as u8));
                            if let Some(f) = fit(xs, ys.iter().copied()) {
                                hits.push(Hit {
                                    mask,
                                    cand: ReCandidateDto {
                                        start_bit: start as u16,
                                        bit_length: len,
                                        byte_order: order,
                                        value_type: vt,
                                        factor: f.factor,
                                        offset: f.offset,
                                    },
                                    r: f.r,
                                    factor: f.factor,
                                    offset: f.offset,
                                    rmse: f.rmse,
                                    samples: f.n as u32,
                                });
                            }
                        }
                    }
                }
            }
        }

        // Amendment R2a-1 (rev.): rank score = max(|r lag 0|, |r at the credited lag|). The lag
        // search runs on the lag-0-ranked pool (NOT deduped yet: a full field and its MSB
        // sub-field tie at lag 0 but not at the true lag); credited rows report the fit at
        // that lag; the pool is then re-ranked and deduped on the rank scores before the cut.
        hits.sort_by(rank);
        hits.truncate((self.top_n * 6).clamp(64, RE_LAG_POOL_MAX));
        let mut rows: Vec<(Hit, f64)> = hits.into_iter().map(|h| (h, 0.0)).collect();
        if !rows.is_empty() {
            if stop() || !self.refine_lags(&mut rows, &stop) {
                truncated = true;
            }
            rows.sort_by(|a, b| rank(&a.0, &b.0));
        }
        let rows = dedupe_lagged(rows, self.top_n);

        ReCorrelationResultDto {
            rows: rows
                .into_iter()
                .map(|(h, lag)| ReCorrelationRowDto {
                    candidate: ReCandidateDto {
                        factor: h.factor,
                        offset: h.offset,
                        ..h.cand
                    },
                    r: h.r,
                    r2: h.r * h.r,
                    rmse: h.rmse,
                    samples: h.samples,
                    lag_ms: lag,
                })
                .collect(),
            evaluated,
            reference_samples: self.ref_ts.len() as u32,
            elapsed_ms: t0.elapsed().as_secs_f64() * 1_000.0,
            truncated,
        }
    }

    /// Lag search for the pool rows: a credited lag (≥ 95 % of the lag-0 samples, |r| gain
    /// > 0.01) replaces the row's fit; returns `false` when interrupted (remaining rows keep lag 0).
    fn refine_lags(&self, rows: &mut [(Hit, f64)], stop: &dyn Fn() -> bool) -> bool {
        let steps = RE_LAG_RANGE_MS / RE_LAG_STEP_MS;
        let mut alignments: Vec<(i64, Vec<(u32, u32)>)> =
            Vec::with_capacity((2 * steps + 1) as usize);
        for k in -steps..=steps {
            if k != 0 {
                let lag_ms = k * RE_LAG_STEP_MS;
                // Amendment R2a-2: lagMs > 0 = the target changes BEFORE the reference, i.e. the
                // reference at t is compared with the target at t - lagMs.
                alignments.push((lag_ms, self.align(-lag_ms * 1_000)));
            }
        }
        let mut values: Vec<f64> = vec![0.0; self.target_ts.len()];
        for (hit, lag) in rows.iter_mut() {
            if stop() {
                return false;
            }
            let Ok(plan) = CandPlan::new(&ReCandidateDto {
                factor: 1.0,
                offset: 0.0,
                ..hit.cand
            }) else {
                continue;
            };
            for (v, p) in values.iter_mut().zip(&self.target_payload) {
                *v = raw_to_value(plan.vt, plan.span.extract_raw_u64(p), plan.span.bit_len);
            }
            let mut best: Option<(i64, Fit)> = None;
            for (lag_ms, pairs) in &alignments {
                let xs = pairs.iter().map(|&(t, _)| values[t as usize]);
                let ys = pairs.iter().map(|&(_, i)| self.ref_val[i as usize]);
                if let Some(f) = fit(xs, ys) {
                    // Amendment R2a-1: a lag must keep ≥ 95 % of the lag-0 samples (on short /
                    // few-level data a shifted subset can otherwise fit "perfectly" by accident).
                    if f.n * 100 < hit.samples as usize * RE_LAG_MIN_OVERLAP_PCT {
                        continue;
                    }
                    if best.as_ref().is_none_or(|(_, b)| f.r.abs() > b.r.abs()) {
                        best = Some((*lag_ms, f));
                    }
                }
            }
            if let Some((lag_ms, f)) = best {
                if f.r.abs() > hit.r.abs() + RE_LAG_MIN_GAIN {
                    hit.r = f.r;
                    hit.factor = f.factor;
                    hit.offset = f.offset;
                    hit.rmse = f.rmse;
                    hit.samples = f.n as u32;
                    *lag = lag_ms as f64;
                }
            }
        }
        true
    }
}

// ─── Tests (`cargo test -p nexus-hal re_`) ──────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_core::CanIdKey;

    const T: ReTargetDto = ReTargetDto {
        bus: 0,
        arb_id: 0x123,
        is_extended: false,
    };

    fn std_f(bus: u8, id: u16, d: &[u8], ts: u64) -> RawCanFrame {
        RawCanFrame::new_classical(bus, CanIdKey::new_standard(id).unwrap(), d, ts).unwrap()
    }
    fn started(targets: &[ReTargetDto]) -> ReAnalyzer {
        let mut a = ReAnalyzer::new();
        a.start(None);
        a.focus_set(targets).unwrap();
        a
    }
    fn cand(start: u16, len: u16, order: ReByteOrder, vt: ReValueType) -> ReCandidateDto {
        ReCandidateDto {
            start_bit: start,
            bit_length: len,
            byte_order: order,
            value_type: vt,
            factor: 1.0,
            offset: 0.0,
        }
    }
    fn series_req(c: Vec<ReCandidateDto>, r: Option<ReReferenceDto>, max: u16) -> ReSeriesRequest {
        ReSeriesRequest {
            target: T,
            candidates: c,
            reference: r,
            from_us: None,
            to_us: None,
            max_points: max,
        }
    }
    fn search(from: u16, to: u16, lens: [u16; 2]) -> ReSearchDto {
        ReSearchDto {
            bit_from: from,
            bit_to: to,
            lengths: lens,
            byte_orders: vec![ReByteOrder::Intel, ReByteOrder::Motorola],
            signed: vec![false, true],
        }
    }

    /// Decoded series: `(kind, index, [(tRel, min, max)])`, plus header `(pointsMax, fromUs)`.
    type Decoded = (u16, u64, Vec<(u8, u8, Vec<(u32, f64, f64)>)>);
    fn decode(b: &[u8]) -> Decoded {
        assert_eq!(b[..4], RE_SERIES_MAGIC);
        let n = usize::from(b[4]);
        let pm = u16::from_le_bytes([b[6], b[7]]);
        let from = u64::from_le_bytes(b[8..16].try_into().unwrap());
        let mut off = 16;
        let mut out = Vec::new();
        for _ in 0..n {
            let (k, i) = (b[off], b[off + 1]);
            let c = u32::from_le_bytes(b[off + 4..off + 8].try_into().unwrap()) as usize;
            off += 8;
            let mut pts = Vec::new();
            for _ in 0..c {
                let t = u32::from_le_bytes(b[off..off + 4].try_into().unwrap());
                let lo = f64::from_le_bytes(b[off + 4..off + 12].try_into().unwrap());
                let hi = f64::from_le_bytes(b[off + 12..off + 20].try_into().unwrap());
                pts.push((t, lo, hi));
                off += 20;
            }
            out.push((k, i, pts));
        }
        assert_eq!(off, b.len(), "no trailing bytes");
        (pm, from, out)
    }

    #[test]
    fn re_focus_requires_start_caps_and_keeps_rings() {
        let mut a = ReAnalyzer::new();
        assert_eq!(a.focus_set(&[T]).unwrap_err().code(), "not_started");
        assert!(a.focus_set(&[]).is_ok());
        a.start(None);
        let s = a.focus_set(&[T, T]).unwrap();
        assert_eq!(s.targets.len(), 1, "duplicates merged");
        a.ingest(&std_f(0, 0x123, &[1, 2], 10));
        let nine: Vec<ReTargetDto> = (0..9)
            .map(|i| ReTargetDto {
                arb_id: 0x200 + i,
                ..T
            })
            .collect();
        assert_eq!(a.focus_set(&nine).unwrap_err().code(), "focus_full");
        let bad = ReTargetDto { arb_id: 0x800, ..T };
        let e = a.focus_set(&[bad]).unwrap_err();
        assert_eq!(e.code(), "invalid");
        assert!(e.to_string().starts_with("[re:invalid] "));
        // Kept target keeps its ring; new one starts empty.
        let other = ReTargetDto { arb_id: 0x124, ..T };
        let s = a.focus_set(&[other, T]).unwrap();
        assert_eq!(s.targets[0].samples, 0);
        assert_eq!(s.targets[1].samples, 1);
        assert_eq!(s.targets[1].first_us, Some(10));
        assert!(!s.targets[1].auto);
        // Reset empties rings, keeps targets.
        a.reset();
        assert_eq!(a.focus_status().targets[1].samples, 0);
    }

    #[test]
    fn re_focus_ring_wraps_overwriting_oldest() {
        let mut a = started(&[T]);
        let n = RE_FOCUS_DEPTH + 100;
        for i in 0..n as u64 {
            a.ingest(&std_f(0, 0x123, &(i as u16).to_le_bytes(), 1_000 + i));
            a.ingest(&std_f(0, 0x7FF, &[0], 1_000 + i)); // not focused
        }
        let s = &a.focus_status().targets[0];
        assert_eq!(s.samples as usize, RE_FOCUS_DEPTH);
        assert_eq!(s.first_us, Some(1_100));
        assert_eq!(s.last_us, Some(1_000 + n as u64 - 1));
        let mut out = Vec::new();
        let req = ReSeriesRequest {
            from_us: Some(1_100),
            to_us: Some(1_100 + 15),
            ..series_req(
                vec![cand(0, 16, ReByteOrder::Intel, ReValueType::Unsigned)],
                None,
                16,
            )
        };
        a.series(&req, &mut out).unwrap();
        let (_, _, s) = decode(&out);
        let vals: Vec<f64> = s[0].2.iter().map(|p| p.1).collect();
        assert_eq!(vals, (100..116).map(f64::from).collect::<Vec<_>>());
    }

    #[test]
    fn re_series_signed12_intel_motorola_exact_vs_span() {
        let mut a = started(&[T]);
        let payloads: Vec<[u8; 8]> = (0..20u8)
            .map(|i| {
                [
                    i.wrapping_mul(37),
                    0x80 | i,
                    i.wrapping_mul(91),
                    0xF0 ^ i,
                    0,
                    0,
                    0,
                    0,
                ]
            })
            .collect();
        for (i, p) in payloads.iter().enumerate() {
            a.ingest(&std_f(0, 0x123, p, 100 + i as u64 * 10));
        }
        let ci = ReCandidateDto {
            factor: 0.5,
            offset: -3.0,
            ..cand(4, 12, ReByteOrder::Intel, ReValueType::Signed)
        };
        let cm = cand(7, 12, ReByteOrder::Motorola, ReValueType::Signed);
        let mut out = Vec::new();
        a.series(&series_req(vec![ci, cm], None, 64), &mut out)
            .unwrap();
        let (pm, from, s) = decode(&out);
        assert_eq!((pm, from, s.len()), (64, 100, 2));
        let si = NormalizedBitSpan::compile(4, 12, ByteOrder::LittleEndian).unwrap();
        let sm = NormalizedBitSpan::compile(7, 12, ByteOrder::BigEndian).unwrap();
        let sx = |raw: u64| (((raw << 52) as i64) >> 52) as f64;
        for (k, p) in payloads.iter().enumerate() {
            assert_eq!(
                s[0].2[k],
                (
                    k as u32 * 10,
                    sx(si.extract_raw_u64(p)) * 0.5 - 3.0,
                    sx(si.extract_raw_u64(p)) * 0.5 - 3.0
                )
            );
            let m = sx(sm.extract_raw_u64(p));
            assert_eq!(s[1].2[k], (k as u32 * 10, m, m));
        }
        // Motorola start 7 len 12 = byte0 (MSB) + high nibble of byte1.
        let p = payloads[3];
        let raw = (u64::from(p[0]) << 4) | u64::from(p[1] >> 4);
        assert_eq!(s[1].2[3].1, sx(raw));
    }

    #[test]
    fn re_series_float32_and_float64() {
        let mut a = started(&[T]);
        for i in 0..5u64 {
            let v = i as f32 * 1.25 - 2.0;
            let mut d = [0u8; 8];
            d[..4].copy_from_slice(&v.to_le_bytes());
            a.ingest(&std_f(0, 0x123, &d, i * 1_000));
        }
        let c32 = ReCandidateDto {
            factor: 2.0,
            ..cand(0, 32, ReByteOrder::Intel, ReValueType::Float32)
        };
        let mut out = Vec::new();
        a.series(&series_req(vec![c32], None, 16), &mut out)
            .unwrap();
        let (_, _, s) = decode(&out);
        let vals: Vec<f64> = s[0].2.iter().map(|p| p.1).collect();
        assert_eq!(vals, vec![-4.0, -1.5, 1.0, 3.5, 6.0]);
        let bad = cand(0, 16, ReByteOrder::Intel, ReValueType::Float32);
        assert_eq!(
            a.series(&series_req(vec![bad], None, 16), &mut out)
                .unwrap_err()
                .code(),
            "invalid"
        );
        assert!(out.is_empty());
    }

    #[test]
    fn re_series_decimation_min_max_and_validation() {
        let mut a = started(&[T]);
        // 100 samples, 1 ms apart, value = i % 7.
        for i in 0..100u64 {
            a.ingest(&std_f(0, 0x123, &[(i % 7) as u8], i * 1_000));
        }
        let c = cand(0, 8, ReByteOrder::Intel, ReValueType::Unsigned);
        let mut out = Vec::new();
        a.series(&series_req(vec![c], None, 16), &mut out).unwrap();
        let (_, from, s) = decode(&out);
        assert_eq!(from, 0);
        let pts = &s[0].2;
        assert!(pts.len() <= 16 && pts.len() >= 15, "{}", pts.len());
        // span = 99_001 µs over 16 buckets: bucket b holds samples with i*1000*16/99001 == b.
        let mut expect: Vec<(u32, f64, f64)> = Vec::new();
        for i in 0..100u64 {
            let b = (i * 1_000 * 16 / 99_001) as usize;
            let v = (i % 7) as f64;
            match expect.get_mut(b) {
                Some(e) => {
                    e.1 = e.1.min(v);
                    e.2 = e.2.max(v);
                }
                None => expect.push(((i * 1_000) as u32, v, v)),
            }
        }
        assert_eq!(*pts, expect);
        for bad in [15u16, 4097] {
            assert_eq!(
                a.series(&series_req(vec![c], None, bad), &mut out)
                    .unwrap_err()
                    .code(),
                "invalid"
            );
        }
        assert_eq!(
            a.series(&series_req(vec![c; 5], None, 16), &mut out)
                .unwrap_err()
                .code(),
            "invalid"
        );
        let unfocused = ReSeriesRequest {
            target: ReTargetDto { arb_id: 0x55, ..T },
            ..series_req(vec![c], None, 16)
        };
        assert_eq!(
            a.series(&unfocused, &mut out).unwrap_err().code(),
            "invalid"
        );
        assert_eq!(
            ReAnalyzer::new()
                .series(&series_req(vec![c], None, 16), &mut out)
                .unwrap_err()
                .code(),
            "not_started"
        );
    }

    fn obd_frame(pid: u8, a_: u8, b: u8, ts: u64) -> RawCanFrame {
        let n = obd_pid_bytes(pid).unwrap();
        std_f(
            0,
            0x7E8,
            &[2 + n as u8, 0x41, pid, a_, b, 0xAA, 0xAA, 0xAA],
            ts,
        )
    }

    #[test]
    fn re_obd_pid_value_matches_ts_catalog() {
        // Vectors from the TS PID_CATALOG formulas (src/types/diagnostics.ts).
        let v = |pid, d: &[u8]| obd_pid_value(pid, d).unwrap();
        assert!((v(0x04, &[255]) - 100.0).abs() < 1e-12);
        assert_eq!(v(0x05, &[130]), 90.0);
        assert_eq!(v(0x0C, &[0x1A, 0xF8]), 1726.0);
        assert_eq!(v(0x0D, &[88]), 88.0);
        assert_eq!(v(0x0F, &[0]), -40.0);
        assert_eq!(v(0x10, &[0x01, 0x2C]), 3.0);
        assert!((v(0x11, &[51]) - 20.0).abs() < 1e-12);
        assert!((v(0x2F, &[102]) - 40.0).abs() < 1e-12);
        assert_eq!(v(0x33, &[101]), 101.0);
        assert_eq!(v(0x42, &[0x30, 0x39]), 12.345);
        assert_eq!(v(0x46, &[65]), 25.0);
        assert_eq!(v(0x5C, &[255]), 215.0);
        assert_eq!(OBD_PID_CATALOG.len(), 12);
        assert_eq!(obd_pid_value(0x0C, &[1]), None, "too short");
        assert_eq!(obd_pid_value(0x01, &[1, 2, 3, 4]), None, "not in catalog");
    }

    #[test]
    fn re_obd_reference_from_bus_and_no_reference() {
        let mut a = started(&[T]);
        let obd = Some(ReReferenceDto::ObdPid { pid: 0x0C, bus: 0 });
        let mut out = Vec::new();
        a.ingest(&std_f(0, 0x123, &[1], 0));
        let e = a
            .series(&series_req(vec![], obd.clone(), 16), &mut out)
            .unwrap_err();
        assert_eq!(e.code(), "no_reference");
        assert!(e.to_string().contains("polling"));
        // Scripted 0x7E8 responses for 0x0C, 0x0D, 0x05 interleaved (+ a negative response).
        for k in 0..6u64 {
            a.ingest(&obd_frame(0x0C, 0x0F, (k * 4) as u8, 1_000 + k * 30_000));
            a.ingest(&obd_frame(0x0D, 10 * k as u8, 0, 11_000 + k * 30_000));
            a.ingest(&obd_frame(0x05, 100 + k as u8, 0, 21_000 + k * 30_000));
            a.ingest(&std_f(
                0,
                0x7E8,
                &[3, 0x7F, 0x01, 0x12],
                22_000 + k * 30_000,
            ));
        }
        for (pid, f) in [
            (
                0x0Cu8,
                Box::new(|k: u64| (256.0 * 15.0 + (k * 4) as f64) / 4.0) as Box<dyn Fn(u64) -> f64>,
            ),
            (0x0D, Box::new(|k: u64| (10 * k) as f64)),
            (0x05, Box::new(|k: u64| (100 + k) as f64 - 40.0)),
        ] {
            let req = series_req(vec![], Some(ReReferenceDto::ObdPid { pid, bus: 0 }), 16);
            a.series(&req, &mut out).unwrap();
            let (_, _, s) = decode(&out);
            assert_eq!(s[0].0, RE_SERIES_KIND_REFERENCE);
            let vals: Vec<f64> = s[0].2.iter().map(|p| p.1).collect();
            assert_eq!(vals, (0..6).map(&f).collect::<Vec<_>>(), "pid {pid:#x}");
        }
        let st = a.focus_status();
        assert_eq!(st.targets.len(), 2);
        assert!(st.targets[1].auto && st.targets[1].arb_id == 0x7E8);
        // Window without responses -> no_reference.
        let req = ReSeriesRequest {
            from_us: Some(500_000),
            to_us: Some(600_000),
            ..series_req(vec![], obd, 16)
        };
        assert_eq!(a.series(&req, &mut out).unwrap_err().code(), "no_reference");
        // Unknown PID -> invalid.
        let req = series_req(
            vec![],
            Some(ReReferenceDto::ObdPid { pid: 0x01, bus: 0 }),
            16,
        );
        assert_eq!(a.series(&req, &mut out).unwrap_err().code(), "invalid");
    }

    /// Amendment R2a-4: length byte >= 2 + PID data bytes and <= 7 (lenient above the minimum).
    #[test]
    fn re_obd_single_frame_length_rules() {
        let f = |b: &[u8]| obd_decode_frame(0x0C, b);
        assert_eq!(f(&[4, 0x41, 0x0C, 0x1A, 0xF8, 0, 0, 0]), Some(1726.0));
        assert_eq!(
            f(&[7, 0x41, 0x0C, 0x1A, 0xF8, 0, 0, 0]),
            Some(1726.0),
            "lenient up to 7"
        );
        assert_eq!(
            f(&[3, 0x41, 0x0C, 0x1A, 0xF8, 0, 0, 0]),
            None,
            "< 2 + 2 data bytes"
        );
        assert_eq!(f(&[8, 0x41, 0x0C, 0x1A, 0xF8, 0, 0, 0]), None, "> 7");
        assert_eq!(
            f(&[0x10, 0x41, 0x0C, 0x1A, 0xF8, 0, 0, 0]),
            None,
            "ISO-TP first frame"
        );
        assert_eq!(
            f(&[4, 0x41, 0x0C, 0x1A]),
            None,
            "frame shorter than the data"
        );
        assert_eq!(f(&[4, 0x41, 0x0D, 0x1A, 0xF8]), None, "other PID");
        assert_eq!(f(&[4, 0x7F, 0x0C, 0x1A, 0xF8]), None, "negative response");
        assert_eq!(
            obd_decode_frame(0x0D, &[5, 0x41, 0x0D, 88, 0, 0, 0, 0]),
            Some(88.0)
        );
        assert_eq!(
            obd_decode_frame(0x0D, &[2, 0x41, 0x0D, 88, 0, 0, 0, 0]),
            None
        );
    }

    /// Amendment R2a-3: markers / phase starts are stamped in the frame time base.
    #[test]
    fn re_markers_use_frame_time_base() {
        let mut a = started(&[T]);
        let before = a.mark("before any frame");
        let mono = nexus_core::now_monotonic_us();
        assert!(before.ts_us <= mono, "no frame yet -> monotonic");
        // Hardware clock 1 h ahead of the monotonic clock.
        const AHEAD: u64 = 3_600_000_000;
        a.ingest(&std_f(
            0,
            0x123,
            &[1],
            nexus_core::now_monotonic_us() + AHEAD,
        ));
        let m = a.mark("hw");
        let now = nexus_core::now_monotonic_us();
        assert!(
            m.ts_us >= mono + AHEAD - 1_000_000 && m.ts_us <= now + AHEAD,
            "{} vs {}",
            m.ts_us,
            now + AHEAD
        );
        let st = a.set_phase(RePhase::Baseline);
        let p = st.phase_started_at_us.unwrap();
        assert!(p >= m.ts_us && p <= nexus_core::now_monotonic_us() + AHEAD);
        // A markers reference lines up with frames stamped by that clock.
        let m2 = a.mark("hw2");
        a.ingest(&std_f(0, 0x123, &[2], m2.ts_us + 10));
        let r = Some(ReReferenceDto::Markers {
            points: vec![
                ReMarkerPointDto {
                    marker_id: m.id,
                    value: 1.0,
                },
                ReMarkerPointDto {
                    marker_id: m2.id,
                    value: 2.0,
                },
            ],
        });
        let mut out = Vec::new();
        a.series(&series_req(vec![], r, 16), &mut out).unwrap();
        let (_, from, s) = decode(&out);
        assert!(from >= mono + AHEAD - 1_000_000, "window in frame time");
        assert_eq!(s[0].2.len(), 2);
    }

    /// Amendment R2a-7: a series window wider than u32 µs is invalid ("window too long").
    #[test]
    fn re_series_window_too_long_is_invalid() {
        let mut a = started(&[T]);
        a.ingest(&std_f(0, 0x123, &[1], 1_000));
        a.ingest(&std_f(0, 0x123, &[2], 1_000 + u64::from(u32::MAX) + 1));
        let c = cand(0, 8, ReByteOrder::Intel, ReValueType::Unsigned);
        let mut out = Vec::new();
        let e = a
            .series(&series_req(vec![c], None, 16), &mut out)
            .unwrap_err();
        assert_eq!(e.code(), "invalid");
        assert!(e.to_string().contains("window too long"), "{e}");
        let req = ReSeriesRequest {
            from_us: Some(0),
            to_us: Some(u64::from(u32::MAX)),
            ..series_req(vec![c], None, 16)
        };
        a.series(&req, &mut out).unwrap();
        let req = ReSeriesRequest {
            to_us: Some(u64::from(u32::MAX) + 1),
            ..req
        };
        assert_eq!(a.series(&req, &mut out).unwrap_err().code(), "invalid");
    }

    #[test]
    fn re_markers_reference_step_function() {
        let mut a = started(&[T]);
        let m1 = a.mark("idle");
        let m2 = a.mark("pedal");
        let m3 = a.mark("release");
        let pts = vec![
            ReMarkerPointDto {
                marker_id: m2.id,
                value: 50.0,
            },
            ReMarkerPointDto {
                marker_id: m1.id,
                value: 0.0,
            },
            ReMarkerPointDto {
                marker_id: m3.id,
                value: 10.0,
            },
        ];
        let r = Some(ReReferenceDto::Markers {
            points: pts.clone(),
        });
        a.ingest(&std_f(0, 0x123, &[0], m1.ts_us));
        a.ingest(&std_f(0, 0x123, &[0], m3.ts_us + 10));
        let mut out = Vec::new();
        a.series(&series_req(vec![], r.clone(), 16), &mut out)
            .unwrap();
        let (_, from, s) = decode(&out);
        assert_eq!(from, m1.ts_us);
        let got: Vec<(u64, f64)> = s[0]
            .2
            .iter()
            .map(|p| (from + u64::from(p.0), p.1))
            .collect();
        assert_eq!(
            got,
            vec![(m1.ts_us, 0.0), (m2.ts_us, 50.0), (m3.ts_us, 10.0)]
        );
        // Window starting between markers holds the earlier value at fromUs.
        let req = ReSeriesRequest {
            from_us: Some(m2.ts_us + 1),
            ..series_req(vec![], r, 16)
        };
        if m3.ts_us > m2.ts_us + 1 {
            a.series(&req, &mut out).unwrap();
            let (_, _, s) = decode(&out);
            assert_eq!(s[0].2[0], (0, 50.0, 50.0));
        }
        let one = Some(ReReferenceDto::Markers {
            points: pts[..1].to_vec(),
        });
        assert_eq!(
            a.series(&series_req(vec![], one, 16), &mut out)
                .unwrap_err()
                .code(),
            "invalid"
        );
        let ghost = Some(ReReferenceDto::Markers {
            points: vec![
                pts[0],
                ReMarkerPointDto {
                    marker_id: 999,
                    value: 1.0,
                },
            ],
        });
        assert_eq!(
            a.series(&series_req(vec![], ghost, 16), &mut out)
                .unwrap_err()
                .code(),
            "invalid"
        );
    }

    /// Target 0x123 @ 100 Hz carrying a Motorola 16-bit value (bytes 0..1) + noise; reference
    /// 0x456 carrying `v(t - ref_delay) * 0.25 - 40` as Intel float64, every 2nd target tick
    /// (`ref_delay_ms > 0` = the target changes before the reference).
    fn planted(n: usize, ref_delay_ms: i64) -> (ReAnalyzer, ReReferenceDto) {
        let r_t = ReTargetDto { arb_id: 0x456, ..T };
        let mut a = started(&[T, r_t]);
        let v = |i: u64| -> u16 {
            let x = i as f64 * 0.01; // seconds
            (30_000.0 + 25_000.0 * (x * std::f64::consts::TAU).sin() + 4_000.0 * (x * 7.3).cos())
                as u16
        };
        let mut seed = 7u32;
        let k = ref_delay_ms / 10;
        for i in 0..n as u64 {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let s = seed.to_le_bytes();
            let x = v(i).to_be_bytes();
            a.ingest(&std_f(
                0,
                0x123,
                &[x[0], x[1], i as u8, s[1], s[2], s[3], 0x5A, 0],
                1_000_000 + i * 10_000,
            ));
            if i % 2 == 0 && i as i64 >= k {
                let rv = f64::from(v((i as i64 - k) as u64)) * 0.25 - 40.0;
                a.ingest(&std_f(0, 0x456, &rv.to_le_bytes(), 1_000_000 + i * 10_000));
            }
        }
        let rc = cand(0, 64, ReByteOrder::Intel, ReValueType::Float64);
        (
            a,
            ReReferenceDto::Candidate {
                target: r_t,
                candidate: rc,
            },
        )
    }

    fn corr_req(r: ReReferenceDto, s: ReSearchDto, top: u8) -> ReCorrelateRequest {
        ReCorrelateRequest {
            target: T,
            reference: r,
            from_us: None,
            to_us: None,
            search: s,
            top_n: top,
        }
    }

    #[test]
    fn re_correlate_finds_planted_motorola16_and_dedupes() {
        let (mut a, r) = planted(4_000, 0);
        let req = corr_req(r, search(0, 63, [1, 32]), 20);
        // The 2 s budget is a release-build contract (§6.2). Unoptimized builds on small CI runners
        // need ~2 s for this sweep, so correctness runs with a generous budget and the budget itself
        // is asserted in release only.
        if !cfg!(debug_assertions) {
            let timed = a.correlate(&req).unwrap();
            assert!(
                !timed.truncated,
                "release: full classic sweep must finish inside RE_CORRELATE_BUDGET ({:.1} ms)",
                timed.elapsed_ms
            );
        }
        let res = a
            .prepare_correlation(&req)
            .unwrap()
            .run(Duration::from_secs(120), &|| false);
        eprintln!(
            "re_correlate full classic sweep: {} candidates x {} reference samples in {:.1} ms",
            res.evaluated, res.reference_samples, res.elapsed_ms
        );
        assert!(!res.truncated);
        assert_eq!(res.reference_samples, 2_000);
        // 1552 Intel + 1552 Motorola spans inside bits 0..63 (lengths 1..=32) x 2 signedness.
        assert_eq!(res.evaluated, 6_208);
        let top = &res.rows[0];
        assert_eq!(
            (
                top.candidate.start_bit,
                top.candidate.bit_length,
                top.candidate.byte_order,
                top.candidate.value_type
            ),
            (7, 16, ReByteOrder::Motorola, ReValueType::Unsigned),
            "{:#?}",
            &res.rows[..3]
        );
        assert!(top.r > 0.999_999, "r = {}", top.r);
        assert!(
            (top.candidate.factor - 0.25).abs() < 1e-6,
            "{}",
            top.candidate.factor
        );
        assert!(
            (top.candidate.offset + 40.0).abs() < 1e-6,
            "{}",
            top.candidate.offset
        );
        assert!(top.rmse < 1e-6 && top.lag_ms == 0.0 && top.samples == 2_000);
        // Superset dedupe invariant + sorted by |r|.
        let masks: Vec<[u64; 8]> = res
            .rows
            .iter()
            .map(|r| span_mask(&CandPlan::new(&r.candidate).unwrap().span))
            .collect();
        for i in 0..res.rows.len() {
            if i > 0 {
                assert!(res.rows[i - 1].r.abs() >= res.rows[i].r.abs());
            }
            for j in i + 1..res.rows.len() {
                assert!(
                    !(masks[j] != masks[i]
                        && is_superset(&masks[j], &masks[i])
                        && (res.rows[i].r.abs() - res.rows[j].r.abs()).abs() < RE_DEDUPE_DELTA_R),
                    "row {j} is a near-equal proper superset of row {i}"
                );
            }
        }
        if !cfg!(debug_assertions) {
            assert!(
                res.elapsed_ms < 500.0,
                "full classic sweep {} ms",
                res.elapsed_ms
            );
        }
    }

    fn lag_search() -> ReSearchDto {
        ReSearchDto {
            byte_orders: vec![ReByteOrder::Motorola],
            signed: vec![false],
            ..search(0, 15, [16, 16])
        }
    }

    /// Amendment R2a-2: `lagMs > 0` = the target changes BEFORE the reference.
    #[test]
    fn re_correlate_lag_sign_convention() {
        for (delay, want) in [(120i64, 120.0f64), (-120, -120.0)] {
            let (mut a, r) = planted(1_200, delay);
            let res = a.correlate(&corr_req(r, lag_search(), 5)).unwrap();
            let top = &res.rows[0];
            assert_eq!((top.candidate.start_bit, top.candidate.bit_length), (7, 16));
            assert!(
                (top.lag_ms - want).abs() <= 10.0,
                "delay {delay}: lag {}",
                top.lag_ms
            );
        }
        // No lag planted -> 0.
        let (mut a, r) = planted(1_200, 0);
        assert_eq!(
            a.correlate(&corr_req(r, lag_search(), 5)).unwrap().rows[0].lag_ms,
            0.0
        );
    }

    /// Amendment R2a-1 (rev.): a credited lag reports the fit at that lag and ranks by it; a
    /// lag keeping < 95 % of the lag-0 samples is never credited.
    #[test]
    fn re_correlate_credited_lag_reports_lagged_fit() {
        let (mut a, r) = planted(1_200, 120);
        let job = a
            .prepare_correlation(&corr_req(r.clone(), lag_search(), 5))
            .unwrap();
        let top = job.run(RE_CORRELATE_BUDGET, &|| false).rows[0].clone();
        assert_eq!(top.lag_ms, 120.0);
        let pairs0 = job.align(0);
        let plan =
            CandPlan::new(&cand(7, 16, ReByteOrder::Motorola, ReValueType::Unsigned)).unwrap();
        let xv = |t: u32| plan.value(&job.target_payload[t as usize]).unwrap();
        let f0 = fit(
            pairs0.iter().map(|&(t, _)| xv(t)),
            pairs0.iter().map(|&(_, i)| job.ref_val[i as usize]),
        )
        .unwrap();
        let pl = job.align(-120_000);
        let fl = fit(
            pl.iter().map(|&(t, _)| xv(t)),
            pl.iter().map(|&(_, i)| job.ref_val[i as usize]),
        )
        .unwrap();
        assert!(
            f0.r < 0.99 && fl.r > 0.999_999,
            "lag0 {} lag {}",
            f0.r,
            fl.r
        );
        assert_eq!(top.r, fl.r);
        assert_eq!(top.samples as usize, fl.n);
        assert!(
            (top.candidate.factor - 0.25).abs() < 1e-6
                && (top.candidate.offset + 40.0).abs() < 1e-6
        );
        assert!(fl.n * 100 >= f0.n * RE_LAG_MIN_OVERLAP_PCT);
        // Wide search: the planted field (credited lag) outranks every lag-0 sub-field.
        let res = a
            .correlate(&corr_req(r, search(0, 31, [8, 16]), 10))
            .unwrap();
        assert_eq!(
            (
                res.rows[0].candidate.start_bit,
                res.rows[0].candidate.bit_length,
                res.rows[0].lag_ms
            ),
            (7, 16, 120.0),
            "{:#?}",
            &res.rows[..2]
        );
        for w in res.rows.windows(2) {
            assert!(w[0].r.abs() >= w[1].r.abs());
        }
        // 95 % overlap rule: 30 target samples over 290 ms with the reference 120 ms ahead; the
        // -120 ms shift would need target samples past the end (only ~60 % of the pairs remain),
        // so no lag is credited even though the shifted fit would be better.
        let (mut a, r) = planted(30, -120);
        let row = a.correlate(&corr_req(r, lag_search(), 5)).unwrap().rows[0].clone();
        assert_eq!(row.lag_ms, 0.0);
        assert!(row.r < 0.999, "lag-0 fit reported: {}", row.r);
    }

    #[test]
    fn re_correlate_budget_cancel_and_errors() {
        let (mut a, r) = planted(400, 0);
        let req = corr_req(r.clone(), search(0, 63, [1, 32]), 10);
        let job = a.prepare_correlation(&req).unwrap();
        let res = job.run(Duration::ZERO, &|| false);
        assert!(res.truncated && res.evaluated == 0);
        let res = job.run(RE_CORRELATE_BUDGET, &|| true);
        assert!(res.truncated);
        let full = job.run(RE_CORRELATE_BUDGET, &|| false);
        assert!(!full.truncated && !full.rows.is_empty());

        let mut bad = req.clone();
        bad.top_n = 0;
        assert_eq!(a.correlate(&bad).unwrap_err().code(), "invalid");
        bad.top_n = 51;
        assert_eq!(a.correlate(&bad).unwrap_err().code(), "invalid");
        let mut bad = req.clone();
        bad.search.lengths = [0, 8];
        assert_eq!(a.correlate(&bad).unwrap_err().code(), "invalid");
        bad.search.lengths = [1, 33];
        assert_eq!(a.correlate(&bad).unwrap_err().code(), "invalid");
        let mut bad = req.clone();
        bad.search.byte_orders.clear();
        assert_eq!(a.correlate(&bad).unwrap_err().code(), "invalid");
        let mut bad = req.clone();
        bad.reference = ReReferenceDto::ObdPid { pid: 0x0D, bus: 3 };
        assert_eq!(a.correlate(&bad).unwrap_err().code(), "no_reference");
        let mut bad = req.clone();
        bad.from_us = Some(u64::MAX - 10);
        bad.to_us = Some(u64::MAX);
        assert_eq!(a.correlate(&bad).unwrap_err().code(), "no_reference");
        assert_eq!(
            ReAnalyzer::new().correlate(&req).unwrap_err().code(),
            "not_started"
        );
    }

    #[test]
    fn re_correlate_focus_full_for_reference() {
        let targets: Vec<ReTargetDto> = (0..8)
            .map(|i| ReTargetDto {
                arb_id: 0x100 + i,
                ..T
            })
            .collect();
        let mut a = ReAnalyzer::new();
        a.start(None);
        a.focus_set(&targets).unwrap();
        let req = ReCorrelateRequest {
            target: targets[0],
            ..corr_req(
                ReReferenceDto::Candidate {
                    target: ReTargetDto { arb_id: 0x7AA, ..T },
                    candidate: cand(0, 8, ReByteOrder::Intel, ReValueType::Unsigned),
                },
                search(0, 7, [1, 8]),
                5,
            )
        };
        assert_eq!(a.correlate(&req).unwrap_err().code(), "focus_full");
    }

    #[test]
    fn re_shared_newer_correlation_cancels_older() {
        use crate::pipeline::re_analyzer::ReShared;
        use std::sync::Arc;
        let (a, r) = planted(16_000, 0);
        let shared = Arc::new(ReShared::new());
        *shared.lock() = a;
        // Wide CAN-FD-sized search over 8000 reference samples: long enough to be cancelled.
        let slow = corr_req(r.clone(), search(0, 63, [1, 32]), 10);
        let s2 = Arc::clone(&shared);
        let h = std::thread::spawn(move || s2.correlate(&slow).unwrap());
        std::thread::sleep(Duration::from_millis(30));
        let quick = corr_req(
            r,
            ReSearchDto {
                byte_orders: vec![ReByteOrder::Motorola],
                signed: vec![false],
                ..search(0, 15, [16, 16])
            },
            1,
        );
        let q = shared.correlate(&quick).unwrap();
        assert!(!q.truncated);
        let old = h.join().unwrap();
        if old.elapsed_ms > 60.0 {
            assert!(
                old.truncated,
                "older sweep must be cancelled by the newer call"
            );
        }
    }

    // ─── Golden series fixture (shared with the TS codec test) ──────────────

    fn golden_analyzer() -> ReAnalyzer {
        let obd_t = ReTargetDto { arb_id: 0x7E8, ..T };
        let mut a = started(&[T, obd_t]);
        for i in 0..40u64 {
            let raw = ((i as i32 * 100 - 2000) as u16 & 0x0FFF) << 4;
            let b = raw.to_le_bytes();
            a.ingest(&std_f(
                0,
                0x123,
                &[b[0] | 0x5, b[1], i as u8, 0, 0, 0, 0, 0],
                1_000_000 + i * 10_000,
            ));
        }
        for k in 0..5u64 {
            a.ingest(&obd_frame(0x0D, 10 * k as u8, 0, 1_050_000 + k * 80_000));
        }
        a
    }

    fn golden_request() -> ReSeriesRequest {
        ReSeriesRequest {
            from_us: Some(1_000_000),
            to_us: Some(1_390_000),
            ..series_req(
                vec![ReCandidateDto {
                    factor: 0.5,
                    offset: 1.0,
                    ..cand(4, 12, ReByteOrder::Intel, ReValueType::Signed)
                }],
                Some(ReReferenceDto::ObdPid { pid: 0x0D, bus: 0 }),
                16,
            )
        }
    }

    #[test]
    fn re_series_golden_bytes() {
        let mut a = golden_analyzer();
        let mut out = Vec::new();
        a.series(&golden_request(), &mut out).unwrap();
        let (pm, from, s) = decode(&out);
        assert_eq!((pm, from, s.len()), (16, 1_000_000, 2));
        assert_eq!((s[0].0, s[0].1, s[0].2.len()), (0, 0, 16));
        assert_eq!((s[1].0, s[1].1, s[1].2.len()), (1, 0, 5));
        // Candidate bucket 0: samples 0..=2 (t 0, 10 ms, 20 ms) -> values -999, -949, -899.
        assert_eq!(s[0].2[0], (0, -999.0, -899.0));
        assert_eq!(s[1].2[4], (370_000, 40.0, 40.0));
        assert_eq!(out.len(), 16 + 8 + 16 * 20 + 8 + 5 * 20);

        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/re_series_golden.bin"
        );
        if std::env::var_os("RE_GOLDEN_UPDATE").is_some() {
            std::fs::write(path, &out).unwrap();
            std::fs::write(path.replace(".bin", ".json"), golden_json(&out)).unwrap();
        }
        let golden =
            std::fs::read(path).expect("golden fixture (RE_GOLDEN_UPDATE=1 to regenerate)");
        assert_eq!(
            out, golden,
            "series encoder output drifted from the golden fixture"
        );
    }

    fn golden_json(bin: &[u8]) -> String {
        let (pm, from, s) = decode(bin);
        let series: Vec<serde_json::Value> = s
            .iter()
            .map(|(k, i, pts)| {
                serde_json::json!({
                    "kind": if *k == 0 { "candidate" } else { "reference" },
                    "kindCode": k, "index": i, "pointCount": pts.len(),
                    "points": pts.iter().map(|p| serde_json::json!({ "tUsRel": p.0, "min": p.1, "max": p.2 })).collect::<Vec<_>>(),
                })
            })
            .collect();
        let v = serde_json::json!({
            "description": "RE Toolkit R2a series binary golden fixture (re-toolkit-v1 §6.3), little-endian. Generated by `cargo test -p nexus-hal re_series_golden_bytes` with RE_GOLDEN_UPDATE=1 (scenario: re_focus.rs golden_analyzer / golden_request). Candidate: 0x123 bus 0, Intel start 4 len 12 signed, factor 0.5 offset 1, 40 frames every 10 ms from tsUs 1000000 (raw = i*100-2000), decimated into 16 min/max buckets (point t = first sample of the bucket). Reference: OBD-II PID 0x0D from 5 scripted 0x7E8 responses (exact, min = max).",
            "byteLength": bin.len(),
            "header": { "magic": "NRS1", "seriesCount": s.len(), "pointsMax": pm, "fromUs": from },
            "request": serde_json::to_value(golden_request()).unwrap(),
            "series": series,
        });
        serde_json::to_string_pretty(&v).unwrap() + "\n"
    }
}
