//! QA gate probes for RE Toolkit R2c "Value Scan" (Cheat-Engine style scan over CAN bit fields)
//! (planning/contracts/re-toolkit-v1.md §8; R1 invariants §1–2, R2a conventions §6, §7.5a).
//!
//! Written BEFORE the implementation, independent of backend-dev's own unit tests.
//! Run: `cargo test -p nexus-hal --test re_r2c_qa` (debug + `--release`; the timing probes
//! `r2c_qa_perf_*` are release-only via `#[cfg_attr(debug_assertions, ignore)]`).
//!
//! Bit-math oracle: `nexus_netdb::compiler::bit_plan::NormalizedBitSpan` only (contract §6: no second
//! Intel/Motorola implementation). The oracle is pinned by hand in `r2c_qa_oracle_pinned_by_hand`.
//! The candidate-space / filter oracle in this file (`oracle_*`) is a deliberately naive reference
//! implementation of the frozen semantics below; several probes require `scan == oracle` exactly.
//!
//! ======================================================================================
//! API ASSUMPTION BLOCK (authoritative once accepted by team-lead; backend-dev implements exactly this)
//! ======================================================================================
//! ```text
//! use nexus_hal::pipeline::re_analyzer::{ReShared, ReScanFirstSpec, ReScanNextOp, ReScanSort,
//!     RE_SCAN_MAX_CANDIDATES, RE_SCAN_MAX_UNDO, RE_SCAN_MAX_RESULTS, RE_SCAN_BUDGET,
//!     RE_SCAN_DEFAULT_LENGTHS, RE_SCAN_PRESET_FACTORS, RE_SCAN_PRESET_OFFSETS};
//!
//! pub const RE_SCAN_MAX_CANDIDATES: usize = 4_000_000;   // live-set cap (survivors of the first scan)
//! pub const RE_SCAN_MAX_UNDO: usize = 8;                  // undo stack depth (older sets dropped)
//! pub const RE_SCAN_MAX_RESULTS: u32 = 500;               // results page limit
//! pub const RE_SCAN_BUDGET: std::time::Duration;          // 2 s wall-time budget per scan call
//! pub const RE_SCAN_DEFAULT_LENGTHS: [u8; 8] = [1, 2, 4, 8, 12, 16, 24, 32];
//! pub const RE_SCAN_PRESET_FACTORS: [f64; 11] = [1, 0.1, 0.01, 0.001, 0.5, 0.25, 0.125, 1/128, 1/256, 2, 10];
//! pub const RE_SCAN_PRESET_OFFSETS: [f64; 6]  = [0, -40, -50, -100, -273.15, -1000];
//! // Standard preset grid = full cross product, FACTOR-major (66 presets: f0o0, f0o1, …, f10o5).
//!
//! // Scan state lives in ReShared (beside the analyzer). Every scan call is SYNCHRONOUS on the calling
//! // thread and returns when done (Tauri / bridge call it from a blocking worker, never the aggregator).
//! // The analyzer lock is held only to copy row data (payloads / history / masks / classifier input);
//! // filtering runs outside the lock. A newer scan_first/scan_next/scan_reset bumps a generation counter
//! // that cancels an older running scan (the superseded call's result is discarded, never committed).
//! impl ReShared {
//!   pub fn scan_first(&self, spec: &ReScanFirstSpec) -> Result<ReScanStatusDto, ReError>;
//!   pub fn scan_next(&self, op: &ReScanNextOp) -> Result<ReScanStatusDto, ReError>;
//!   pub fn scan_undo(&self) -> Result<ReScanStatusDto, ReError>;
//!   pub fn scan_reset(&self) -> ReScanStatusDto;                         // idempotent, never fails
//!   pub fn scan_status(&self) -> ReScanStatusDto;                        // never fails
//!   pub fn scan_results(&self, offset: u32, limit: u32, sort: ReScanSort) -> Result<ReScanResultsDto, ReError>;
//!   #[doc(hidden)] pub fn scan_set_budget(&self, budget: std::time::Duration); // test hook, default RE_SCAN_BUDGET
//! }
//! // R1/R2a API used unchanged: ReShared::{new, lock, sync_enabled}, ReAnalyzer::{start, stop, reset,
//! // ingest, row_detail, classify}.
//!
//! // ---- wire DTOs (serde camelCase; tests build inputs with serde_json::from_value, read outputs with to_value)
//! ReScanFirstSpec { kind: "exact"|"physical"|"range"|"unknown",           // "physical" = exact physical value
//!   value: number|null, tolerance: number|null, range: [a, b]|null,
//!   physical: bool,                    // only for kind "range": range on the physical value (presets)
//!   presets: ReScalePresetDto[]|null,  // null = standard 66-preset grid; [] = invalid when physical
//!   userPresets: ReScalePresetDto[],   // tried BEFORE the presets list, in order
//!   options: ReScanOptionsDto }        // every field except `kind` has a serde default (null/false/[]/defaults)
//! ReScalePresetDto { factor: number, offset: number }                     // factor finite, != 0; offset finite
//! ReScanOptionsDto {                                                       // serde(default) = contract defaults:
//!   lengths: number[],                 // each 1..=32, non-empty           [1,2,4,8,12,16,24,32]
//!   byteOrders: ("intel"|"motorola")[] // non-empty                        ["intel","motorola"]
//!   signed: boolean[],                 // non-empty (like ReSearchDto)     [false,true]
//!   float32: bool,                     // + float32 on every 32-bit span (independent of lengths); false
//!                                      //   (+ float64 on 64-bit spans when include64 is also on)
//!   include64: bool,                   // + length 64 (unsigned/signed)    false
//!   alignment: "any"|"nibble"|"byte",  // on the candidate's LSB bit index  "any"
//!   excludeCounterChecksum: bool,      //                                   true
//!   excludeConstant: bool,             // ignored by "exact"/"physical"     true
//!   buses: number[]|null, ids: ReTargetDto[]|null,   // null = all; [] = invalid
//!   readMode: { kind: "latest" } | { kind: "median", samples: 1..=64 } }   { kind: "latest" }
//! ReScanNextOp { op: "changed"|"unchanged"|"increased"|"decreased"|"either"|"increasedBy"|"decreasedBy"
//!                    |"exact"|"range"|"stable",
//!   value: number|null, tolerance: number|null, range: [a,b]|null, stableMs: number|null (1..=600000),
//!   physical: bool, presets: ReScalePresetDto[]|null }                     // all except `op` serde-default
//! ReScanSort = "id" | "changes" | "width"
//! ReScanStatusDto { active: bool, scanId: u32, step: u32, candidates: u64, history: u64[],
//!   truncated: bool, elapsedMs: f64, undoDepth: u8, historyCovered: bool|null }
//! ReScanResultsDto { scanId, step, total: u32 /* grouped rows */, candidates: u64 /* ungrouped */,
//!   offset: u32, rows: ReScanResultRowDto[] }
//! ReScanResultRowDto { candidate: ReScanCandidateDto, preset: ReScalePresetDto|null,
//!   currentRaw: number|null, currentPhysical: number|null, previousRaw: number|null,
//!   changeCount: u32, kindHint: ReFieldKind|null, containedCount: u32, contained: ReScanCandidateDto[] }
//! ReScanCandidateDto { bus, arbId, isExtended, startBit, bitLength, byteOrder, valueType }
//! // ReError Display starts with "[re:<code>]"; new codes: scan_too_large, no_scan (+ invalid, not_started).
//! ```
//! FROZEN SEMANTICS (defaults chosen by QA; each pinned by a probe):
//! S1  Candidate space per RE row (bus, ext, id), dlc = row dlcBytes: for each byte order in `byteOrders`, each
//!     startBit (Intel = LSB, Motorola = DBC MSB sawtooth) and each length L, the span must compile with
//!     NormalizedBitSpan and lie inside dlc bytes. Motorola only when the span covers ≥ 2 bytes
//!     (min_byte != max_byte); single-byte Motorola == Intel and is never generated. Alignment tests the
//!     LSB bit index `byte*8 + bit` of signal bit 0 (`% 4` nibble, `% 8` byte). Value types: unsigned if
//!     `false ∈ signed`, signed if `true ∈ signed` AND L ≥ 4; float32 / float64 as in options.
//! S2  Exclusions at first-scan time: a candidate touching ANY bit of a classifier `counter` or `checksum`
//!     field of its row (ReAnalyzer::classify at that moment) is dropped when excludeCounterChecksum;
//!     a candidate whose bits are ALL in the R1 constant mask is dropped when excludeConstant, except for
//!     kinds "exact" and "physical". Error frames never form rows (R1).
//! S3  Value read = latest payload of the row (or lower median, index (n-1)/2 of the sorted last
//!     min(N, history) decoded values); a span past the latest frame length → value null → the candidate
//!     fails every value-based filter. Signed = two's complement of L bits; floats via f32/f64 bits;
//!     NaN/inf → null.
//! S4  Physical: tolerance default max(|factor|, 0.005·|X|) per preset (X = target value; for
//!     increasedBy/decreasedBy X = N, compared against (cur - prev)·factor). A candidate WITH a preset is
//!     tested only under its own preset (op.presets ignored). A candidate WITHOUT one tries userPresets
//!     then presets (null = grid) and keeps the FIRST match. Raw tolerance default 0 (exact equality).
//!     Range is inclusive, no tolerance.
//! S5  changed/unchanged use the per-row `scan_changed` OR-mask (bits toggled since the last first/next
//!     scan; cleared by every first/next scan, untouched by undo/reset). increased/decreased/either and
//!     the `By` ops compare the current value to the value stored at the previous scan (endpoints);
//!     either = value differs. Every next scan stores the current value for survivors.
//! S6  changeCount = number of next-scan steps at which the candidate's endpoint value differed from the
//!     stored one. stable(T): now = newest frame timestamp seen by the analyzer; kept iff the value held
//!     at now−T and every history sample in (now−T, now] are equal; historyCovered = Some(true) iff every
//!     evaluated row's history reaches back to now−T (oldest retained ts ≤ now−T), else Some(false)
//!     (uncovered rows are judged on the samples they have); None for every other op.
//! S7  Undo restores the exact previous candidate set incl. stored values, presets, change counts, step and
//!     history; depth ≤ 8. undo at depth 0 with an active scan → [re:invalid]; no scan → [re:no_scan].
//!     scan_first on an active scan replaces it (new scanId, undo stack cleared). A failed call changes nothing.
//!     ReAnalyzer::reset invalidates the scan (status.active = false, next → [re:no_scan]).
//! S8  Errors: scan_first / scan_next while RE is not enabled → [re:not_started]; scan_next / undo / results
//!     without a scan → [re:no_scan]; first-scan survivors > RE_SCAN_MAX_CANDIDATES → [re:scan_too_large];
//!     results limit 0 or > 500 → [re:invalid]; offset ≥ total → Ok with empty rows.
//! S8a Cap vs budget: for kind "unknown" the survivors ARE the generated space, so it is counted up front
//!     (masks only, no decoding, not budgeted) and rejected with [re:scan_too_large] before any evaluation;
//!     for value kinds the cap is checked as survivors accumulate (exceeding it at any point → error, even
//!     if the budget would have truncated later). The up-front count is not budgeted; evaluation still is (S9).
//! S9  Budget: checked before every row (first scan) / every chunk (next scan), INCLUDING the first, so
//!     Duration::ZERO evaluates nothing; truncated first scan keeps only what was evaluated; truncated next
//!     scan keeps every unevaluated candidate (never removes unjudged ones).
//! S10 Grouping (results only): candidate C is "contained" in R iff same row, bits(C) ⊊ bits(R),
//!     C.changeCount == R.changeCount ≥ 1 and C.preset == R.preset. Representatives are the maximal ones;
//!     each candidate appears exactly once (in the widest containing representative, ties → id order).
//!     changeCount 0 → never grouped. Sort "id" = (bus, isExtended false<true, arbId, startBit, bitLength,
//!     intel<motorola, unsigned<signed<float32<float64) asc; "width" = bitLength desc then id;
//!     "changes" = changeCount desc then id. kindHint = kind of the row's classifier field whose bits ⊇
//!     the candidate's bits, from the SAME classification snapshot taken at first-scan time for S2 (stable
//!     across steps / undo; no classify per results call), else null.
//! ======================================================================================

use nexus_core::{CanIdKey, RawCanFrame};
use nexus_hal::pipeline::re_analyzer::{
    ReScanFirstSpec, ReScanNextOp, ReScanSort, ReShared, RE_SCAN_BUDGET, RE_SCAN_DEFAULT_LENGTHS,
    RE_SCAN_MAX_CANDIDATES, RE_SCAN_MAX_RESULTS, RE_SCAN_MAX_UNDO, RE_SCAN_PRESET_FACTORS,
    RE_SCAN_PRESET_OFFSETS,
};
use nexus_netdb::compiler::bit_plan::NormalizedBitSpan;
use nexus_netdb::ByteOrder;
use serde::Serialize;
use serde_json::{json, Value};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

// ─── Thread-local counting allocator ──────────────────────────────────────────────────────────

struct CountingAlloc;

thread_local! {
    static COUNT_ON: Cell<bool> = const { Cell::new(false) };
    static COUNT: Cell<u64> = const { Cell::new(0) };
}

#[inline]
fn record_alloc() {
    if COUNT_ON.try_with(Cell::get).unwrap_or(false) {
        let _ = COUNT.try_with(|c| c.set(c.get() + 1));
    }
}

// SAFETY: forwards every call unchanged to the system allocator; only counts.
unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_alloc();
        // SAFETY: same contract as the caller's.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_alloc();
        // SAFETY: same contract as the caller's.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record_alloc();
        // SAFETY: same contract as the caller's.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: same contract as the caller's.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

fn count_allocs(f: impl FnOnce()) -> u64 {
    COUNT.with(|c| c.set(0));
    COUNT_ON.with(|o| o.set(true));
    f();
    COUNT_ON.with(|o| o.set(false));
    COUNT.with(Cell::get)
}

// ─── Frames / analyzer helpers ────────────────────────────────────────────────────────────────

fn std_frame(bus: u8, id: u16, data: &[u8], ts: u64) -> RawCanFrame {
    RawCanFrame::new_classical(bus, CanIdKey::new_standard(id).expect("std id"), data, ts)
        .expect("classic frame")
}

fn ext_frame(bus: u8, id: u32, data: &[u8], ts: u64) -> RawCanFrame {
    RawCanFrame::new_classical(bus, CanIdKey::new_extended(id).expect("ext id"), data, ts)
        .expect("classic ext frame")
}

fn fd_frame(bus: u8, id: u16, data: &[u8], ts: u64) -> RawCanFrame {
    RawCanFrame::new_fd(
        bus,
        CanIdKey::new_standard(id).expect("std id"),
        data,
        false,
        ts,
    )
    .expect("fd frame")
}

fn sh_started() -> ReShared {
    let sh = ReShared::new();
    {
        let mut g = sh.lock();
        let _ = g.start(None);
        sh.sync_enabled(&g);
    }
    sh
}

fn feed(sh: &ReShared, frames: &[RawCanFrame]) {
    let mut g = sh.lock();
    for f in frames {
        g.ingest(f);
    }
}

/// Feeds one std frame per payload, `period_us` apart starting at `t0`.
fn feed_seq(sh: &ReShared, bus: u8, id: u16, payloads: &[&[u8]], t0: u64, period_us: u64) {
    let frames: Vec<RawCanFrame> = payloads
        .iter()
        .enumerate()
        .map(|(i, p)| std_frame(bus, id, p, t0 + i as u64 * period_us))
        .collect();
    feed(sh, &frames);
}

struct Lcg(u32);
impl Lcg {
    fn next_u8(&mut self) -> u8 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (self.0 >> 24) as u8
    }
}

fn j<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).expect("serialize")
}

fn u(v: &Value, key: &str) -> u64 {
    v.get(key)
        .and_then(Value::as_u64)
        .unwrap_or_else(|| panic!("missing u64 `{key}` in {v}"))
}

fn fnum(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

fn assert_code(r: &Result<Value, String>, code: &str, ctx: &str) {
    match r {
        Ok(v) => panic!("{ctx}: expected [re:{code}] error, got Ok({v})"),
        Err(e) => assert!(
            e.starts_with(&format!("[re:{code}]")),
            "{ctx}: expected [re:{code}] …, got `{e}`"
        ),
    }
}

/// Rejection = `[re:invalid]` or a serde deserialization failure of the wire value.
fn assert_rejected(r: &Result<Value, String>, ctx: &str) {
    match r {
        Ok(v) => panic!("{ctx}: expected rejection, got Ok({v})"),
        Err(e) => assert!(
            e.starts_with("[re:invalid]") || e.starts_with("[deser]"),
            "{ctx}: expected [re:invalid] (or deserialization failure), got `{e}`"
        ),
    }
}

// ─── Scan call wrappers (wire-shape inputs, JSON outputs) ────────────────────────────────────

fn default_opts() -> Value {
    json!({
        "lengths": [1, 2, 4, 8, 12, 16, 24, 32],
        "byteOrders": ["intel", "motorola"],
        "signed": [false, true],
        "float32": false,
        "include64": false,
        "alignment": "any",
        "excludeCounterChecksum": true,
        "excludeConstant": true,
        "buses": null,
        "ids": null,
        "readMode": { "kind": "latest" }
    })
}

fn opts(over: Value) -> Value {
    let mut o = default_opts();
    let m = o.as_object_mut().unwrap();
    for (k, v) in over.as_object().expect("override object") {
        assert!(m.contains_key(k), "unknown option key {k}");
        m.insert(k.clone(), v.clone());
    }
    o
}

fn spec(kind: &str, extra: Value, over: Value) -> Value {
    let mut s = json!({
        "kind": kind, "value": null, "tolerance": null, "range": null, "physical": false,
        "presets": null, "userPresets": [], "options": opts(over)
    });
    let m = s.as_object_mut().unwrap();
    for (k, v) in extra.as_object().expect("extra object") {
        assert!(m.contains_key(k), "unknown spec key {k}");
        m.insert(k.clone(), v.clone());
    }
    s
}

fn unknown(over: Value) -> Value {
    spec("unknown", json!({}), over)
}

fn op(name: &str, extra: Value) -> Value {
    let mut o = json!({
        "op": name, "value": null, "tolerance": null, "range": null, "stableMs": null,
        "physical": false, "presets": null
    });
    let m = o.as_object_mut().unwrap();
    for (k, v) in extra.as_object().expect("extra object") {
        assert!(m.contains_key(k), "unknown op key {k}");
        m.insert(k.clone(), v.clone());
    }
    o
}

fn first(sh: &ReShared, s: Value) -> Result<Value, String> {
    let s: ReScanFirstSpec = serde_json::from_value(s).map_err(|e| format!("[deser] {e}"))?;
    sh.scan_first(&s)
        .map(|st| j(&st))
        .map_err(|e| e.to_string())
}

fn first_ok(sh: &ReShared, s: Value) -> Value {
    first(sh, s.clone()).unwrap_or_else(|e| panic!("scan_first({s}) failed: {e}"))
}

fn next(sh: &ReShared, o: Value) -> Result<Value, String> {
    let o: ReScanNextOp = serde_json::from_value(o).map_err(|e| format!("[deser] {e}"))?;
    sh.scan_next(&o).map(|st| j(&st)).map_err(|e| e.to_string())
}

fn next_ok(sh: &ReShared, o: Value) -> Value {
    next(sh, o.clone()).unwrap_or_else(|e| panic!("scan_next({o}) failed: {e}"))
}

fn undo(sh: &ReShared) -> Result<Value, String> {
    sh.scan_undo().map(|st| j(&st)).map_err(|e| e.to_string())
}

fn status(sh: &ReShared) -> Value {
    j(&sh.scan_status())
}

fn results(sh: &ReShared, offset: u32, limit: u32, sort: &str) -> Result<Value, String> {
    let sort: ReScanSort =
        serde_json::from_value(json!(sort)).map_err(|e| format!("[deser] {e}"))?;
    sh.scan_results(offset, limit, sort)
        .map(|r| j(&r))
        .map_err(|e| e.to_string())
}

/// Every grouped row, paging with the maximum limit.
fn all_rows(sh: &ReShared, sort: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut offset = 0u32;
    loop {
        let page = results(sh, offset, RE_SCAN_MAX_RESULTS, sort)
            .unwrap_or_else(|e| panic!("scan_results failed: {e}"));
        let total = u(&page, "total") as u32;
        let rows = page["rows"].as_array().expect("rows").clone();
        assert!(rows.len() <= RE_SCAN_MAX_RESULTS as usize);
        let n = rows.len() as u32;
        out.extend(rows);
        offset += n;
        if offset >= total || n == 0 {
            assert_eq!(out.len() as u32, total, "paging lost rows");
            return out;
        }
    }
}

fn cands(st: &Value) -> u64 {
    u(st, "candidates")
}

// ─── Candidate keys ───────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum Vt {
    U,
    S,
    F32,
    F64,
}

/// Field order == frozen "id" sort order (S10).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct Key {
    bus: u8,
    ext: bool,
    arb: u32,
    start: u16,
    len: u16,
    moto: bool,
    vt: Vt,
}

fn key(bus: u8, arb: u32, start: u16, len: u16, moto: bool, vt: Vt) -> Key {
    Key {
        bus,
        ext: false,
        arb,
        start,
        len,
        moto,
        vt,
    }
}

fn key_of(c: &Value) -> Key {
    let vt = match c["valueType"].as_str().expect("valueType") {
        "unsigned" => Vt::U,
        "signed" => Vt::S,
        "float32" => Vt::F32,
        "float64" => Vt::F64,
        other => panic!("bad valueType {other}"),
    };
    let moto = match c["byteOrder"].as_str().expect("byteOrder") {
        "intel" => false,
        "motorola" => true,
        other => panic!("bad byteOrder {other}"),
    };
    Key {
        bus: u(c, "bus") as u8,
        ext: c["isExtended"].as_bool().expect("isExtended"),
        arb: u(c, "arbId") as u32,
        start: u(c, "startBit") as u16,
        len: u(c, "bitLength") as u16,
        moto,
        vt,
    }
}

impl Key {
    fn span(&self) -> NormalizedBitSpan {
        NormalizedBitSpan::compile(self.start, self.len as u8, order(self.moto)).expect("span")
    }
    fn mask(&self) -> [u64; 8] {
        span_mask(&self.span())
    }
}

fn order(moto: bool) -> ByteOrder {
    if moto {
        ByteOrder::BigEndian
    } else {
        ByteOrder::LittleEndian
    }
}

fn span_mask(s: &NormalizedBitSpan) -> [u64; 8] {
    let mut m = [0u64; 8];
    for &(byte, bib) in &s.bit_coords {
        let b = usize::from(byte) * 8 + usize::from(bib);
        m[b / 64] |= 1u64 << (b % 64);
    }
    m
}

fn mask_and(a: &[u64; 8], b: &[u64; 8]) -> bool {
    (0..8).any(|w| a[w] & b[w] != 0)
}

fn proper_subset(a: &[u64; 8], b: &[u64; 8]) -> bool {
    (0..8).all(|w| a[w] & !b[w] == 0) && a != b
}

/// Representatives + contained candidates, flattened (each must appear once).
fn flat_keys(rows: &[Value]) -> Vec<Key> {
    let mut v = Vec::new();
    for r in rows {
        v.push(key_of(&r["candidate"]));
        for c in r["contained"].as_array().expect("contained") {
            v.push(key_of(c));
        }
    }
    v
}

fn key_set(rows: &[Value]) -> BTreeSet<Key> {
    let flat = flat_keys(rows);
    let set: BTreeSet<Key> = flat.iter().copied().collect();
    assert_eq!(
        set.len(),
        flat.len(),
        "a candidate appears more than once in results"
    );
    set
}

fn row_by_key<'a>(rows: &'a [Value], k: &Key) -> Option<&'a Value> {
    rows.iter().find(|r| key_of(&r["candidate"]) == *k)
}

// ─── Oracle (naive reference of S1–S4 using NormalizedBitSpan) ───────────────────────────────

#[derive(Clone)]
struct OOpts {
    lengths: Vec<u16>,
    intel: bool,
    moto: bool,
    unsigned: bool,
    signed: bool,
    float32: bool,
    include64: bool,
    align: u16,
}

impl OOpts {
    fn defaults() -> Self {
        Self {
            lengths: vec![1, 2, 4, 8, 12, 16, 24, 32],
            intel: true,
            moto: true,
            unsigned: true,
            signed: true,
            float32: false,
            include64: false,
            align: 1,
        }
    }
}

/// Visits every candidate (start, len, moto, vt) of one row per S1/S2.
/// `excluded`: bits that disqualify (counter/checksum); `constant`: Some(mask) drops constant-only.
fn oracle_enum_row(
    dlc: usize,
    o: &OOpts,
    excluded: &[u64; 8],
    constant: Option<&[u64; 8]>,
    mut visit: impl FnMut(u16, u16, bool, Vt),
) {
    let mut lens: BTreeSet<u16> = o.lengths.iter().copied().collect();
    if o.float32 {
        lens.insert(32);
    }
    if o.include64 {
        lens.insert(64);
    }
    for moto in [false, true] {
        if (moto && !o.moto) || (!moto && !o.intel) {
            continue;
        }
        for start in 0..(dlc * 8) as u16 {
            for &len in &lens {
                let Ok(span) = NormalizedBitSpan::compile(start, len as u8, order(moto)) else {
                    continue;
                };
                if usize::from(span.max_byte) >= dlc {
                    continue;
                }
                if moto && span.min_byte == span.max_byte {
                    continue;
                }
                let (b0, k0) = span.bit_coords[0];
                let lsb = u16::from(b0) * 8 + u16::from(k0);
                if lsb % o.align != 0 {
                    continue;
                }
                let m = span_mask(&span);
                if mask_and(&m, excluded) {
                    continue;
                }
                if let Some(c) = constant {
                    if (0..8).all(|w| m[w] & !c[w] == 0) {
                        continue;
                    }
                }
                let int_ok = o.lengths.contains(&len) || (len == 64 && o.include64);
                if int_ok {
                    if o.unsigned {
                        visit(start, len, moto, Vt::U);
                    }
                    if o.signed && len >= 4 {
                        visit(start, len, moto, Vt::S);
                    }
                }
                if o.float32 && len == 32 {
                    visit(start, len, moto, Vt::F32);
                }
                if o.float32 && o.include64 && len == 64 {
                    visit(start, len, moto, Vt::F64);
                }
            }
        }
    }
}

fn oracle_count_row(dlc: usize, o: &OOpts) -> u64 {
    let mut n = 0u64;
    oracle_enum_row(dlc, o, &[0; 8], None, |_, _, _, _| n += 1);
    n
}

/// Decoded value of `k` on `payload` (S3); None when the span is past the payload or not finite.
fn oracle_value(k: &Key, payload: &[u8]) -> Option<f64> {
    let span = k.span();
    if usize::from(span.max_byte) >= payload.len() {
        return None;
    }
    let raw = span.extract_raw_u64(payload);
    let v = match k.vt {
        Vt::U => raw as f64,
        Vt::S => {
            let sh = 64 - u32::from(k.len);
            (((raw << sh) as i64) >> sh) as f64
        }
        Vt::F32 => f64::from(f32::from_bits(raw as u32)),
        Vt::F64 => f64::from_bits(raw),
    };
    v.is_finite().then_some(v)
}

fn hex_mask(s: &str) -> [u64; 8] {
    let mut m = [0u64; 8];
    for i in 0..s.len() / 2 {
        let byte = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex");
        for k in 0..8 {
            if byte >> k & 1 == 1 {
                let b = i * 8 + k;
                m[b / 64] |= 1u64 << (b % 64);
            }
        }
    }
    m
}

struct RowMeta {
    dlc: usize,
    constant: [u64; 8],
    counter_checksum: [u64; 8],
    latest: Vec<u8>,
}

/// Row metadata through the R1 API (constant mask, real classifier, latest payload).
fn row_meta(sh: &ReShared, bus: u8, ext: bool, arb: u32) -> RowMeta {
    let g = sh.lock();
    let d = j(&g.row_detail(bus, arb, ext).expect("row exists"));
    let c = j(&g.classify(bus, arb, ext).expect("row exists"));
    let h = g.row_history(bus, arb, ext).expect("row exists");
    drop(g);
    let dlc = u(&d, "dlcBytes") as usize;
    let mut cc = [0u64; 8];
    for f in c["fields"].as_array().expect("fields") {
        let kind = f["kind"].as_str().unwrap();
        if kind == "counter" || kind == "checksum" {
            let k = Key {
                bus,
                ext,
                arb,
                start: u(f, "startBit") as u16,
                len: u(f, "bitLength") as u16,
                moto: f["byteOrder"] == "motorola",
                vt: Vt::U,
            };
            let m = k.mask();
            for w in 0..8 {
                cc[w] |= m[w];
            }
        }
    }
    let latest = h
        .payloads
        .last()
        .map(|p| p[..dlc].to_vec())
        .unwrap_or_default();
    RowMeta {
        dlc,
        constant: hex_mask(d["constantMask"].as_str().expect("constantMask")),
        counter_checksum: cc,
        latest,
    }
}

fn latest_payload(sh: &ReShared, bus: u8, ext: bool, arb: u32) -> Vec<u8> {
    let g = sh.lock();
    let d = j(&g.row_detail(bus, arb, ext).expect("row"));
    let h = g.row_history(bus, arb, ext).expect("row");
    let dlc = u(&d, "dlcBytes") as usize;
    h.payloads
        .last()
        .map(|p| p[..dlc].to_vec())
        .unwrap_or_default()
}

/// Oracle first-scan candidate set for `rows` (S1/S2), with values (S3, latest).
fn oracle_first(
    sh: &ReShared,
    rows: &[(u8, bool, u32)],
    o: &OOpts,
    excl_cc: bool,
    excl_const: bool,
) -> BTreeMap<Key, Option<f64>> {
    let mut out = BTreeMap::new();
    for &(bus, ext, arb) in rows {
        let m = row_meta(sh, bus, ext, arb);
        let excluded = if excl_cc { m.counter_checksum } else { [0; 8] };
        let constant = excl_const.then_some(&m.constant);
        oracle_enum_row(m.dlc, o, &excluded, constant, |start, len, moto, vt| {
            let k = Key {
                bus,
                ext,
                arb,
                start,
                len,
                moto,
                vt,
            };
            out.insert(k, oracle_value(&k, &m.latest));
        });
    }
    out
}

fn phys_tol(factor: f64, x: f64) -> f64 {
    factor.abs().max(0.005 * x.abs())
}

// ─── Planted speed scenario (contract §8.5) ──────────────────────────────────────────────────

struct Variant {
    name: &'static str,
    start: u16,
    len: u8,
    /// Endpoint raw values at scan 1 (Unknown), scan 2 (Increased), scan 3 (Increased).
    raws: [u64; 3],
    /// Final exact physical value (preset 0.01) == raws[2] * 0.01.
    phys: f64,
    seed: u32,
}

const PLANTED_ID: u16 = 0x1A0;
const NOISE_IDS: [u16; 2] = [0x2B0, 0x3D0];
const NOISE_EXT_ID: u32 = 0x18FF_1234;
const CONST_ID: u16 = 0x3C0;
const TICKS: u64 = 80;

/// Contract §8.5 as written says "12-bit … factor 0.01 … 80 km/h", but 80 / 0.01 = 8000 > 4095 does not fit
/// 12 bits. Resolution (amendment proposal A1): 12-bit Motorola, factor 0.01, final value 30.00 km/h; the
/// 80 km/h case is probed with a 16-bit Motorola field (factor 0.01, raw 8000).
/// Seeds were chosen once with `r2c_qa_oracle_planted_scenarios_unique` (random noise rows never produce
/// a coincidental survivor under the frozen semantics).
const VARIANT_12: Variant = Variant {
    name: "12-bit Motorola 11|12 x0.01 -> 30 km/h",
    start: 11,
    len: 12,
    raws: [1000, 2000, 3000],
    phys: 30.0,
    seed: SEED_12,
};
const VARIANT_16: Variant = Variant {
    name: "16-bit Motorola 15|16 x0.01 -> 80 km/h",
    start: 15,
    len: 16,
    raws: [5000, 6500, 8000],
    phys: 80.0,
    seed: SEED_16,
};
const SEED_12: u32 = 1;
const SEED_16: u32 = 1;

fn planted_rows() -> Vec<(u8, bool, u32)> {
    vec![
        (0, false, u32::from(PLANTED_ID)),
        (0, false, u32::from(NOISE_IDS[0])),
        (0, false, u32::from(NOISE_IDS[1])),
        (0, true, NOISE_EXT_ID),
        (0, false, u32::from(CONST_ID)),
    ]
}

/// Three phases of frames: phase 0 (before Unknown), 1 (before Increased), 2 (before Increased, Exact).
/// Planted row: byte0 = 8-bit counter, planted span via NormalizedBitSpan::pack_raw_u64, other bits random,
/// byte7 = XOR8 of bytes 0..6 (classifier checksum). 12-bit variant: byte1 high nibble forced non-zero.
fn planted_phases(v: &Variant) -> [Vec<RawCanFrame>; 3] {
    let span =
        NormalizedBitSpan::compile(v.start, v.len, ByteOrder::BigEndian).expect("planted span");
    let mut rng = Lcg(v.seed);
    let mut counter = 0u8;
    let wiggle: [i64; 8] = [0, 1, 2, 1, 0, -1, -2, -1];
    let mut phases: [Vec<RawCanFrame>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for (p, phase) in phases.iter_mut().enumerate() {
        for i in 0..TICKS {
            let tick = p as u64 * TICKS + i;
            let ts = tick * 20_000;
            let val: u64 = if p == 0 {
                if i == TICKS - 1 {
                    v.raws[0]
                } else {
                    (v.raws[0] as i64 + wiggle[(i % 8) as usize]) as u64
                }
            } else {
                let a = v.raws[p - 1];
                let b = v.raws[p];
                a + (b - a) * (i + 1) / TICKS
            };
            let mut d = [0u8; 64];
            d[0] = counter;
            counter = counter.wrapping_add(1);
            for b in d.iter_mut().take(7).skip(1) {
                *b = rng.next_u8();
            }
            span.pack_raw_u64(val, &mut d);
            if v.len == 12 && d[1] >> 4 == 0 {
                d[1] |= 0x10;
            }
            d[7] = d[..7].iter().fold(0, |a, b| a ^ b);
            phase.push(std_frame(0, PLANTED_ID, &d[..8], ts));
            for (n, &id) in NOISE_IDS.iter().enumerate() {
                let mut x = [0u8; 8];
                for b in &mut x {
                    *b = rng.next_u8();
                }
                phase.push(std_frame(0, id, &x, ts + 1_000 * (n as u64 + 1)));
            }
            let mut x = [0u8; 8];
            for b in &mut x {
                *b = rng.next_u8();
            }
            phase.push(ext_frame(0, NOISE_EXT_ID, &x, ts + 3_000));
            phase.push(std_frame(
                0,
                CONST_ID,
                &[0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88],
                ts + 4_000,
            ));
        }
    }
    phases
}

fn planted_key(v: &Variant, vt: Vt) -> Key {
    key(
        0,
        u32::from(PLANTED_ID),
        v.start,
        u16::from(v.len),
        true,
        vt,
    )
}

/// Oracle run of Unknown → Increased → Increased → Exact physical (preset 0.01 only).
/// Returns (candidate count after each scan, final survivors).
fn oracle_planted(v: &Variant) -> (Vec<u64>, BTreeSet<Key>) {
    let sh = sh_started();
    let phases = planted_phases(v);
    let rows = planted_rows();
    feed(&sh, &phases[0]);
    let mut set: BTreeMap<Key, Option<f64>> =
        oracle_first(&sh, &rows, &OOpts::defaults(), true, true);
    let mut hist = vec![set.len() as u64];
    let read = |sh: &ReShared, k: &Key| oracle_value(k, &latest_payload(sh, k.bus, k.ext, k.arb));
    for phase in &phases[1..] {
        feed(&sh, phase);
        let mut nxt = BTreeMap::new();
        for (k, prev) in &set {
            let cur = read(&sh, k);
            if let (Some(c), Some(p)) = (cur, prev) {
                if c > *p {
                    nxt.insert(*k, cur);
                }
            }
        }
        set = nxt;
        hist.push(set.len() as u64);
    }
    let tol = phys_tol(0.01, v.phys);
    let survivors: BTreeSet<Key> = set
        .iter()
        .filter(|(k, _)| matches!(read(&sh, k), Some(c) if (c * 0.01 - v.phys).abs() <= tol))
        .map(|(k, _)| *k)
        .collect();
    hist.push(survivors.len() as u64);
    (hist, survivors)
}

fn run_planted(v: &Variant) {
    let (o_hist, o_surv) = oracle_planted(v);
    let sh = sh_started();
    let phases = planted_phases(v);
    feed(&sh, &phases[0]);
    let s1 = first_ok(&sh, unknown(json!({})));
    assert_eq!(
        cands(&s1),
        o_hist[0],
        "{}: Unknown candidate count != oracle",
        v.name
    );
    feed(&sh, &phases[1]);
    let s2 = next_ok(&sh, op("increased", json!({})));
    assert_eq!(
        cands(&s2),
        o_hist[1],
        "{}: 1st Increased count != oracle",
        v.name
    );
    feed(&sh, &phases[2]);
    let s3 = next_ok(&sh, op("increased", json!({})));
    assert_eq!(
        cands(&s3),
        o_hist[2],
        "{}: 2nd Increased count != oracle",
        v.name
    );
    let s4 = next_ok(
        &sh,
        op(
            "exact",
            json!({ "value": v.phys, "physical": true, "presets": [{ "factor": 0.01, "offset": 0.0 }] }),
        ),
    );
    let hist: Vec<u64> = s4["history"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_u64().unwrap())
        .collect();
    eprintln!("{}: history {hist:?} (oracle {o_hist:?})", v.name);
    assert_eq!(hist, o_hist, "{}: per-step history != oracle", v.name);
    assert_eq!(u(&s4, "step"), 3);
    assert!(hist.len() <= 4, "found in ≤ 4 scans");
    let rows = all_rows(&sh, "id");
    let got = key_set(&rows);
    assert_eq!(got, o_surv, "{}: survivors != oracle", v.name);
    let pk = planted_key(v, Vt::U);
    assert!(
        got.contains(&pk),
        "{}: planted candidate {pk:?} not found",
        v.name
    );
    let r = row_by_key(&rows, &pk).expect("planted candidate is a representative");
    assert_eq!(r["preset"], json!({ "factor": 0.01, "offset": 0.0 }));
    assert_eq!(fnum(r, "currentRaw"), Some(v.raws[2] as f64));
    assert_eq!(fnum(r, "previousRaw"), Some(v.raws[2] as f64));
    let phys = fnum(r, "currentPhysical").expect("currentPhysical");
    assert!((phys - v.phys).abs() < 1e-9, "currentPhysical {phys}");
    assert_eq!(u(r, "changeCount"), 2, "changed at scans 2 and 3, not at 4");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Oracle self-checks (run before the implementation exists)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn r2c_qa_oracle_pinned_by_hand() {
    // Motorola 11|12: MSB = byte1 bit3, LSB = byte2 bit0 (sawtooth).
    let m = NormalizedBitSpan::compile(11, 12, ByteOrder::BigEndian).unwrap();
    assert_eq!(m.bit_coords[0], (2, 0));
    assert_eq!(m.bit_coords[7], (2, 7));
    assert_eq!(m.bit_coords[8], (1, 0));
    assert_eq!(m.bit_coords[11], (1, 3));
    let p = [0x00u8, 0x0B, 0xB8, 0, 0, 0, 0, 0];
    assert_eq!(m.extract_raw_u64(&p), 3000);
    // Motorola 15|16 = bytes 1..2 big-endian.
    let m16 = NormalizedBitSpan::compile(15, 16, ByteOrder::BigEndian).unwrap();
    assert_eq!(m16.extract_raw_u64(&[0, 0x1F, 0x40, 0, 0, 0, 0, 0]), 8000);
    assert_eq!((m16.min_byte, m16.max_byte), (1, 2));
    // Intel 4|12: bits 4..15.
    let i = NormalizedBitSpan::compile(4, 12, ByteOrder::LittleEndian).unwrap();
    assert_eq!(i.bit_coords[0], (0, 4));
    assert_eq!(i.bit_coords[11], (1, 7));
    assert_eq!(i.extract_raw_u64(&[0x40, 0xFF]), 0xFF4);
    // Motorola 3|4 is single-byte (never a candidate), Motorola 3|5 is multi-byte.
    let s = NormalizedBitSpan::compile(3, 4, ByteOrder::BigEndian).unwrap();
    assert_eq!(s.min_byte, s.max_byte);
    let t = NormalizedBitSpan::compile(3, 5, ByteOrder::BigEndian).unwrap();
    assert_eq!((t.min_byte, t.max_byte), (0, 1));
    // Oracle counts on a fully varying 2-byte row, defaults: Intel 59 unsigned + 28 signed.
    let intel_only = OOpts {
        moto: false,
        ..OOpts::defaults()
    };
    assert_eq!(oracle_count_row(2, &intel_only), 87);
}

#[test]
fn r2c_qa_oracle_planted_scenarios_unique() {
    for v in [&VARIANT_12, &VARIANT_16] {
        let (hist, surv) = oracle_planted(v);
        eprintln!("oracle {}: history {hist:?} survivors {surv:?}", v.name);
        assert_eq!(hist.len(), 4);
        let mut expected: BTreeSet<Key> = [planted_key(v, Vt::U)].into_iter().collect();
        if v.len == 16 {
            // 8000 is positive as signed 16-bit too: same bits, same value (not "nested", S10).
            expected.insert(planted_key(v, Vt::S));
        }
        assert_eq!(
            surv, expected,
            "{}: oracle survivors (choose another seed)",
            v.name
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Constants / wire shapes
// ═══════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn r2c_qa_constants_and_preset_grid() {
    assert_eq!(RE_SCAN_MAX_CANDIDATES, 4_000_000);
    assert_eq!(RE_SCAN_MAX_UNDO, 8);
    assert_eq!(RE_SCAN_MAX_RESULTS, 500);
    assert_eq!(RE_SCAN_BUDGET, Duration::from_secs(2));
    assert_eq!(RE_SCAN_DEFAULT_LENGTHS, [1, 2, 4, 8, 12, 16, 24, 32]);
    assert_eq!(
        RE_SCAN_PRESET_FACTORS,
        [
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
            10.0
        ]
    );
    assert_eq!(
        RE_SCAN_PRESET_OFFSETS,
        [0.0, -40.0, -50.0, -100.0, -273.15, -1000.0]
    );
}

#[test]
fn r2c_qa_wire_shapes() {
    // Every field except `kind` / `op` is serde-defaulted; defaults == contract defaults.
    let min: ReScanFirstSpec =
        serde_json::from_value(json!({ "kind": "unknown" })).expect("minimal spec");
    let full: ReScanFirstSpec = serde_json::from_value(unknown(json!({}))).expect("full spec");
    assert_eq!(
        j(&min),
        j(&full),
        "minimal spec must default to the contract defaults"
    );
    assert_eq!(j(&full)["options"], default_opts());
    let o: ReScanNextOp =
        serde_json::from_value(json!({ "op": "increasedBy", "value": 5 })).expect("op");
    assert_eq!(j(&o)["op"], "increasedBy");
    assert!(serde_json::from_value::<ReScanNextOp>(json!({ "op": "increased_by" })).is_err());
    for s in ["id", "changes", "width"] {
        assert!(
            serde_json::from_value::<ReScanSort>(json!(s)).is_ok(),
            "sort {s}"
        );
    }
    assert!(serde_json::from_value::<ReScanFirstSpec>(json!({ "kind": "exact_value" })).is_err());
    let m: ReScanFirstSpec = serde_json::from_value(json!({
        "kind": "unknown", "options": { "readMode": { "kind": "median", "samples": 5 }, "alignment": "nibble" }
    }))
    .expect("median read mode");
    assert_eq!(
        j(&m)["options"]["readMode"],
        json!({ "kind": "median", "samples": 5 })
    );
    assert_eq!(
        j(&m)["options"]["lengths"],
        json!([1, 2, 4, 8, 12, 16, 24, 32])
    );

    // Output key sets are exact.
    let sh = sh_started();
    feed_seq(&sh, 0, 0x100, &[&[0x00], &[0xFF]], 0, 10_000);
    let idle = status(&sh);
    let keys = |v: &Value| -> BTreeSet<String> { v.as_object().unwrap().keys().cloned().collect() };
    let st_keys: BTreeSet<String> = [
        "active",
        "scanId",
        "step",
        "candidates",
        "history",
        "truncated",
        "elapsedMs",
        "undoDepth",
        "historyCovered",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    assert_eq!(keys(&idle), st_keys);
    assert_eq!(idle["active"], false);
    assert_eq!(cands(&idle), 0);
    assert_eq!(idle["history"], json!([]));
    let st = first_ok(
        &sh,
        unknown(json!({ "lengths": [8], "byteOrders": ["intel"], "signed": [false] })),
    );
    assert_eq!(keys(&st), st_keys);
    assert_eq!(st["active"], true);
    assert_eq!(u(&st, "step"), 0);
    assert_eq!(st["history"], json!([1]));
    assert_eq!(st["historyCovered"], Value::Null);
    assert_eq!(u(&st, "undoDepth"), 0);
    let r = results(&sh, 0, 10, "id").expect("results");
    let r_keys: BTreeSet<String> = ["scanId", "step", "total", "candidates", "offset", "rows"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(keys(&r), r_keys);
    let row = &r["rows"][0];
    let row_keys: BTreeSet<String> = [
        "candidate",
        "preset",
        "currentRaw",
        "currentPhysical",
        "previousRaw",
        "changeCount",
        "kindHint",
        "containedCount",
        "contained",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    assert_eq!(keys(row), row_keys);
    let c_keys: BTreeSet<String> = [
        "bus",
        "arbId",
        "isExtended",
        "startBit",
        "bitLength",
        "byteOrder",
        "valueType",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    assert_eq!(keys(&row["candidate"]), c_keys);
    assert_eq!(key_of(&row["candidate"]), key(0, 0x100, 0, 8, false, Vt::U));
    assert_eq!(row["preset"], Value::Null);
    assert_eq!(row["currentPhysical"], Value::Null);
    assert_eq!(fnum(row, "currentRaw"), Some(255.0));
    assert_eq!(fnum(row, "previousRaw"), Some(255.0));
    assert_eq!(u(row, "changeCount"), 0);
    assert_eq!(u(row, "containedCount"), 0);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Errors / validation
// ═══════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn r2c_qa_errors_not_started_and_no_scan() {
    let sh = ReShared::new();
    assert_code(
        &first(&sh, unknown(json!({}))),
        "not_started",
        "scan_first before RE start",
    );
    assert_code(
        &next(&sh, op("changed", json!({}))),
        "no_scan",
        "scan_next without scan",
    );
    assert_code(&undo(&sh), "no_scan", "undo without scan");
    assert_code(
        &results(&sh, 0, 10, "id"),
        "no_scan",
        "results without scan",
    );
    assert_eq!(status(&sh)["active"], false);
    let _ = sh.scan_reset();

    let sh = sh_started();
    feed_seq(&sh, 0, 0x100, &[&[0x00], &[0xFF]], 0, 10_000);
    assert_code(
        &next(&sh, op("changed", json!({}))),
        "no_scan",
        "next before first",
    );
    first_ok(&sh, unknown(json!({ "lengths": [8] })));
    {
        let mut g = sh.lock();
        let _ = g.stop();
        sh.sync_enabled(&g);
    }
    assert_code(
        &next(&sh, op("changed", json!({}))),
        "not_started",
        "scan_next while RE stopped",
    );
    assert_code(
        &first(&sh, unknown(json!({}))),
        "not_started",
        "scan_first while RE stopped",
    );
    // Read-only calls keep working while stopped.
    assert_eq!(status(&sh)["active"], true);
    assert!(results(&sh, 0, 10, "id").is_ok());
}

#[test]
fn r2c_qa_invalid_specs_and_ops_rejected() {
    let sh = sh_started();
    feed_seq(&sh, 0, 0x100, &[&[0x00, 0x00], &[0xFF, 0xFF]], 0, 10_000);
    let bad_first = [
        ("exact without value", spec("exact", json!({}), json!({}))),
        (
            "physical without value",
            spec("physical", json!({}), json!({})),
        ),
        (
            "negative tolerance",
            spec("exact", json!({ "value": 1, "tolerance": -1 }), json!({})),
        ),
        ("range without range", spec("range", json!({}), json!({}))),
        (
            "inverted range",
            spec("range", json!({ "range": [5, 1] }), json!({})),
        ),
        (
            "empty presets",
            spec("physical", json!({ "value": 1, "presets": [] }), json!({})),
        ),
        (
            "zero factor preset",
            spec(
                "physical",
                json!({ "value": 1, "presets": [{ "factor": 0, "offset": 0 }] }),
                json!({}),
            ),
        ),
        (
            "zero factor user preset",
            spec(
                "physical",
                json!({ "value": 1, "userPresets": [{ "factor": 0, "offset": 1 }] }),
                json!({}),
            ),
        ),
        ("empty lengths", unknown(json!({ "lengths": [] }))),
        ("length 0", unknown(json!({ "lengths": [0] }))),
        ("length 33", unknown(json!({ "lengths": [33] }))),
        (
            "length 64 (use include64)",
            unknown(json!({ "lengths": [64] })),
        ),
        ("empty byteOrders", unknown(json!({ "byteOrders": [] }))),
        ("empty signed", unknown(json!({ "signed": [] }))),
        (
            "median 0",
            unknown(json!({ "readMode": { "kind": "median", "samples": 0 } })),
        ),
        (
            "median 65",
            unknown(json!({ "readMode": { "kind": "median", "samples": 65 } })),
        ),
        ("empty buses", unknown(json!({ "buses": [] }))),
        ("empty ids", unknown(json!({ "ids": [] }))),
        (
            "std id > 0x7FF",
            unknown(json!({ "ids": [{ "bus": 0, "arbId": 0x800, "isExtended": false }] })),
        ),
        ("bad alignment", unknown(json!({ "alignment": "word" }))),
    ];
    for (name, s) in bad_first {
        assert_rejected(&first(&sh, s), name);
        assert_eq!(
            status(&sh)["active"],
            false,
            "{name}: a failed first scan changes nothing"
        );
    }
    first_ok(&sh, unknown(json!({ "lengths": [8] })));
    let before = status(&sh);
    let bad_next = [
        ("increasedBy without value", op("increasedBy", json!({}))),
        ("decreasedBy without value", op("decreasedBy", json!({}))),
        ("exact without value", op("exact", json!({}))),
        ("range without range", op("range", json!({}))),
        ("inverted range", op("range", json!({ "range": [3, 2] }))),
        ("stable without stableMs", op("stable", json!({}))),
        ("stableMs 0", op("stable", json!({ "stableMs": 0 }))),
        (
            "stableMs > 600000",
            op("stable", json!({ "stableMs": 600_001 })),
        ),
        (
            "negative tolerance",
            op("exact", json!({ "value": 1, "tolerance": -0.5 })),
        ),
        (
            "physical, empty presets",
            op(
                "exact",
                json!({ "value": 1, "physical": true, "presets": [] }),
            ),
        ),
    ];
    for (name, o) in bad_next {
        assert_rejected(&next(&sh, o), name);
        assert_eq!(
            status(&sh),
            before,
            "{name}: a failed next scan changes nothing"
        );
    }
    assert_rejected(&results(&sh, 0, 0, "id"), "limit 0");
    assert_rejected(&results(&sh, 0, RE_SCAN_MAX_RESULTS + 1, "id"), "limit 501");
    assert_rejected(&results(&sh, 0, 10, "random"), "unknown sort");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Candidate space (S1/S2) and values (S3)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

fn varying_row(sh: &ReShared, bus: u8, id: u16, dlc: usize, seed: u32) {
    let mut rng = Lcg(seed);
    let zeros = vec![0u8; dlc];
    let ones = vec![0xFFu8; dlc];
    let rnd: Vec<u8> = (0..dlc).map(|_| rng.next_u8()).collect();
    let frames = if dlc > 8 {
        vec![
            fd_frame(bus, id, &zeros, 0),
            fd_frame(bus, id, &ones, 10_000),
            fd_frame(bus, id, &rnd, 20_000),
        ]
    } else {
        vec![
            std_frame(bus, id, &zeros, 0),
            std_frame(bus, id, &ones, 10_000),
            std_frame(bus, id, &rnd, 20_000),
        ]
    };
    feed(sh, &frames);
}

#[test]
fn r2c_qa_candidate_space_counts_match_oracle() {
    let sh = sh_started();
    varying_row(&sh, 0, 0x101, 8, 7);
    let ids = json!([{ "bus": 0, "arbId": 0x101, "isExtended": false }]);
    let d = OOpts::defaults();
    let cases: Vec<(&str, Value, OOpts)> = vec![
        ("defaults", json!({}), d.clone()),
        (
            "nibble",
            json!({ "alignment": "nibble" }),
            OOpts {
                align: 4,
                ..d.clone()
            },
        ),
        (
            "byte",
            json!({ "alignment": "byte" }),
            OOpts {
                align: 8,
                ..d.clone()
            },
        ),
        (
            "intel only",
            json!({ "byteOrders": ["intel"] }),
            OOpts {
                moto: false,
                ..d.clone()
            },
        ),
        (
            "motorola only",
            json!({ "byteOrders": ["motorola"] }),
            OOpts {
                intel: false,
                ..d.clone()
            },
        ),
        (
            "signed only",
            json!({ "signed": [true] }),
            OOpts {
                unsigned: false,
                ..d.clone()
            },
        ),
        (
            "unsigned only",
            json!({ "signed": [false] }),
            OOpts {
                signed: false,
                ..d.clone()
            },
        ),
        (
            "float32",
            json!({ "float32": true }),
            OOpts {
                float32: true,
                ..d.clone()
            },
        ),
        (
            "float32 without length 32",
            json!({ "float32": true, "lengths": [8] }),
            OOpts {
                float32: true,
                lengths: vec![8],
                ..d.clone()
            },
        ),
        (
            "include64",
            json!({ "include64": true }),
            OOpts {
                include64: true,
                ..d.clone()
            },
        ),
        (
            "float32 + include64",
            json!({ "float32": true, "include64": true }),
            OOpts {
                float32: true,
                include64: true,
                ..d.clone()
            },
        ),
        (
            "lengths 3,5,7",
            json!({ "lengths": [3, 5, 7] }),
            OOpts {
                lengths: vec![3, 5, 7],
                ..d.clone()
            },
        ),
    ];
    for (name, over, o) in cases {
        let mut over = over;
        over.as_object_mut()
            .unwrap()
            .insert("ids".into(), ids.clone());
        let st = first_ok(&sh, unknown(over));
        let expected = oracle_count_row(8, &o);
        eprintln!("candidate space {name}: {expected}");
        assert_eq!(cands(&st), expected, "candidate count for `{name}`");
    }
    // FD 64-byte row: bit 511 is reachable (Intel 504|8 and Motorola 495|16 ending at byte 63 bit 0).
    varying_row(&sh, 0, 0x102, 64, 9);
    let st = first_ok(
        &sh,
        unknown(
            json!({ "ids": [{ "bus": 0, "arbId": 0x102, "isExtended": false }], "lengths": [8, 16], "signed": [false] }),
        ),
    );
    let o = OOpts {
        lengths: vec![8, 16],
        signed: false,
        ..d
    };
    assert_eq!(
        cands(&st),
        oracle_count_row(64, &o),
        "CAN-FD 64-byte candidate count"
    );
}

#[test]
fn r2c_qa_two_byte_row_exact_set_values_motorola_multibyte_signed_ge4() {
    let sh = sh_started();
    varying_row(&sh, 0, 0x103, 2, 11);
    let rows_def = [(0u8, false, 0x103u32)];
    let st = first_ok(
        &sh,
        unknown(json!({ "ids": [{ "bus": 0, "arbId": 0x103, "isExtended": false }] })),
    );
    let oracle = oracle_first(&sh, &rows_def, &OOpts::defaults(), true, true);
    assert_eq!(cands(&st), oracle.len() as u64);
    let rows = all_rows(&sh, "id");
    let got = key_set(&rows);
    let want: BTreeSet<Key> = oracle.keys().copied().collect();
    assert_eq!(got, want, "exact candidate set (S1)");
    let ordered: Vec<Key> = rows.iter().map(|r| key_of(&r["candidate"])).collect();
    let mut sorted = ordered.clone();
    sorted.sort();
    assert_eq!(ordered, sorted, "sort `id` order");
    for r in &rows {
        let k = key_of(&r["candidate"]);
        if k.moto {
            let s = k.span();
            assert_ne!(
                s.min_byte, s.max_byte,
                "single-byte Motorola candidate {k:?}"
            );
        }
        if k.vt == Vt::S {
            assert!(k.len >= 4, "signed candidate shorter than 4 bits {k:?}");
        }
        assert_eq!(
            fnum(r, "currentRaw"),
            oracle[&k],
            "currentRaw of {k:?} vs NormalizedBitSpan"
        );
        assert_eq!(
            fnum(r, "previousRaw"),
            oracle[&k],
            "previousRaw of {k:?} after first scan"
        );
    }
    assert!(
        got.iter().any(|k| k.moto),
        "multi-byte Motorola candidates exist"
    );
}

#[test]
fn r2c_qa_values_cross_checked_intel_motorola_signed_float() {
    let sh = sh_started();
    let pack = |start: u16, len: u8, moto: bool, raw: u64| -> Vec<u8> {
        let mut d = [0u8; 64];
        NormalizedBitSpan::compile(start, len, order(moto))
            .unwrap()
            .pack_raw_u64(raw, &mut d);
        d[..8].to_vec()
    };
    let p0 = pack(4, 12, false, 0xFF4); // Intel signed 12-bit -12
    let p1 = pack(39, 12, true, 4096 - 300); // Motorola signed 12-bit -300
    let p2 = pack(0, 32, false, u64::from(1.5f32.to_bits()));
    let p3 = pack(7, 32, true, u64::from((-2.25f32).to_bits()));
    feed(
        &sh,
        &[
            std_frame(0, 0x1B0, &p0, 0),
            std_frame(0, 0x1B1, &p1, 1_000),
            std_frame(0, 0x1B2, &p2, 2_000),
            std_frame(0, 0x1B3, &p3, 3_000),
        ],
    );
    let cases: [(u32, f64, Value, OOpts, Key); 4] = [
        (
            0x1B0,
            -12.0,
            json!({ "lengths": [12], "signed": [true] }),
            OOpts {
                lengths: vec![12],
                unsigned: false,
                ..OOpts::defaults()
            },
            key(0, 0x1B0, 4, 12, false, Vt::S),
        ),
        (
            0x1B1,
            -300.0,
            json!({ "lengths": [12] }),
            OOpts {
                lengths: vec![12],
                ..OOpts::defaults()
            },
            key(0, 0x1B1, 39, 12, true, Vt::S),
        ),
        (
            0x1B2,
            1.5,
            json!({ "lengths": [8], "float32": true }),
            OOpts {
                lengths: vec![8],
                float32: true,
                ..OOpts::defaults()
            },
            key(0, 0x1B2, 0, 32, false, Vt::F32),
        ),
        (
            0x1B3,
            -2.25,
            json!({ "lengths": [8], "float32": true }),
            OOpts {
                lengths: vec![8],
                float32: true,
                ..OOpts::defaults()
            },
            key(0, 0x1B3, 7, 32, true, Vt::F32),
        ),
    ];
    for (id, x, over, o, planted) in cases {
        let mut over = over;
        over.as_object_mut().unwrap().insert(
            "ids".into(),
            json!([{ "bus": 0, "arbId": id, "isExtended": false }]),
        );
        first_ok(&sh, spec("exact", json!({ "value": x }), over));
        let rows = all_rows(&sh, "id");
        let got = key_set(&rows);
        // exact ignores excludeConstant (S2): oracle without the constant filter.
        let want: BTreeSet<Key> = oracle_first(&sh, &[(0, false, id)], &o, true, false)
            .into_iter()
            .filter(|(_, v)| *v == Some(x))
            .map(|(k, _)| k)
            .collect();
        assert!(want.contains(&planted), "oracle sanity for {id:#X}");
        assert_eq!(
            got, want,
            "exact {x} on {id:#X}: set != NormalizedBitSpan oracle"
        );
        for r in &rows {
            assert_eq!(fnum(r, "currentRaw"), Some(x));
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Contract §8.5: planted speed found in ≤ 4 scans
// ═══════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn r2c_qa_planted_12bit_motorola_speed_found_in_4_scans() {
    run_planted(&VARIANT_12);
}

#[test]
fn r2c_qa_planted_16bit_motorola_80kmh_found_in_4_scans() {
    run_planted(&VARIANT_16);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Next-scan semantics
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/// Row 0x100, dlc 1, every bit toggled before the first scan; candidates: 1-bit ×8 + 4-bit Intel ×5.
fn changed_setup() -> ReShared {
    let sh = sh_started();
    feed_seq(&sh, 0, 0x100, &[&[0x00], &[0xFF], &[0x00]], 0, 10_000);
    let st = first_ok(
        &sh,
        unknown(json!({ "lengths": [1, 4], "byteOrders": ["intel"], "signed": [false] })),
    );
    assert_eq!(cands(&st), 13);
    sh
}

#[test]
fn r2c_qa_changed_is_exact_not_endpoint() {
    let sh = changed_setup();
    // bit0 toggles twice (ends equal), bit1 toggles once.
    feed_seq(&sh, 0, 0x100, &[&[0x01], &[0x00], &[0x02]], 100_000, 10_000);
    let st = next_ok(&sh, op("changed", json!({})));
    let got = key_set(&all_rows(&sh, "id"));
    let want: BTreeSet<Key> = [
        key(0, 0x100, 0, 1, false, Vt::U),
        key(0, 0x100, 1, 1, false, Vt::U),
        key(0, 0x100, 0, 4, false, Vt::U),
        key(0, 0x100, 1, 4, false, Vt::U),
    ]
    .into_iter()
    .collect();
    assert_eq!(
        got, want,
        "changed = any bit toggled in the interval (bit0 toggled twice counts)"
    );
    assert_eq!(cands(&st), 4);
    // The OR-mask was cleared by that scan: no frames since -> nothing changed.
    let st = next_ok(&sh, op("changed", json!({})));
    assert_eq!(cands(&st), 0);
}

#[test]
fn r2c_qa_unchanged_removes_double_toggled_bit_and_undo_restores() {
    let sh = changed_setup();
    let before = all_rows(&sh, "id");
    feed_seq(&sh, 0, 0x100, &[&[0x01], &[0x00]], 100_000, 10_000);
    let st = next_ok(&sh, op("unchanged", json!({})));
    assert_eq!(cands(&st), 11);
    let got = key_set(&all_rows(&sh, "id"));
    assert!(!got.contains(&key(0, 0x100, 0, 1, false, Vt::U)));
    assert!(!got.contains(&key(0, 0x100, 0, 4, false, Vt::U)));
    let st = undo(&sh).expect("undo");
    assert_eq!(cands(&st), 13);
    assert_eq!(u(&st, "step"), 0);
    assert_eq!(st["history"], json!([13]));
    assert_eq!(
        all_rows(&sh, "id"),
        before,
        "undo restores the exact previous set and values"
    );
}

#[test]
fn r2c_qa_undo_depth_max_8_and_exact_restore() {
    let sh = sh_started();
    feed_seq(&sh, 0, 0x100, &[&[0x00], &[0xFF], &[0x00]], 0, 10_000);
    first_ok(
        &sh,
        unknown(json!({ "lengths": [1], "byteOrders": ["intel"], "signed": [false] })),
    );
    let mut snapshots = vec![(status(&sh), all_rows(&sh, "id"))];
    for i in 0..10u64 {
        // Toggle bit i%8 once each step so sets and stored values differ between steps.
        let b = 1u8 << (i % 8);
        feed_seq(
            &sh,
            0,
            0x100,
            &[&[b], &[0x00]],
            1_000_000 + i * 100_000,
            10_000,
        );
        let st = next_ok(&sh, op("unchanged", json!({})));
        assert_eq!(u(&st, "step"), i + 1);
        assert_eq!(
            u(&st, "undoDepth") as usize,
            ((i + 1) as usize).min(RE_SCAN_MAX_UNDO)
        );
        snapshots.push((st, all_rows(&sh, "id")));
    }
    assert_eq!(status(&sh)["history"].as_array().unwrap().len(), 11);
    for k in 1..=RE_SCAN_MAX_UNDO {
        let st = undo(&sh).unwrap_or_else(|e| panic!("undo #{k}: {e}"));
        let (exp_st, exp_rows) = &snapshots[10 - k];
        assert_eq!(u(&st, "step"), u(exp_st, "step"));
        assert_eq!(st["history"], exp_st["history"]);
        assert_eq!(cands(&st), cands(exp_st));
        assert_eq!(u(&st, "undoDepth") as usize, RE_SCAN_MAX_UNDO - k);
        assert_eq!(
            &all_rows(&sh, "id"),
            exp_rows,
            "undo #{k} restores the exact set"
        );
    }
    assert_code(&undo(&sh), "invalid", "9th undo (stack depth 8)");
    assert_eq!(u(&status(&sh), "step"), 2);
}

#[test]
fn r2c_qa_new_scan_and_reset() {
    let sh = changed_setup();
    let id1 = u(&status(&sh), "scanId");
    feed_seq(&sh, 0, 0x100, &[&[0x01]], 100_000, 10_000);
    next_ok(&sh, op("changed", json!({})));
    let st = first_ok(
        &sh,
        unknown(json!({ "lengths": [8], "byteOrders": ["intel"], "signed": [false] })),
    );
    assert!(u(&st, "scanId") > id1, "new scan gets a new scanId");
    assert_eq!(u(&st, "step"), 0);
    assert_eq!(u(&st, "undoDepth"), 0, "new scan clears the undo stack");
    assert_eq!(st["history"], json!([1]));
    assert_code(&undo(&sh), "invalid", "undo right after a new scan");
    let st = j(&sh.scan_reset());
    assert_eq!(st["active"], false);
    assert_eq!(cands(&st), 0);
    assert_eq!(st["history"], json!([]));
    assert_eq!(u(&st, "undoDepth"), 0);
    assert_code(
        &next(&sh, op("changed", json!({}))),
        "no_scan",
        "next after reset",
    );
    assert_code(&results(&sh, 0, 10, "id"), "no_scan", "results after reset");
    assert_code(&undo(&sh), "no_scan", "undo after reset");
    let _ = sh.scan_reset(); // idempotent
    let st = first_ok(&sh, unknown(json!({ "lengths": [8] })));
    assert!(u(&st, "scanId") > id1);
}

#[test]
fn r2c_qa_increased_decreased_either_signed_aware() {
    let sh = sh_started();
    feed_seq(&sh, 0, 0x110, &[&[0x05]], 0, 10_000);
    let base =
        || unknown(json!({ "lengths": [8], "byteOrders": ["intel"], "excludeConstant": false }));
    first_ok(&sh, base());
    feed_seq(&sh, 0, 0x110, &[&[0xFB]], 100_000, 10_000); // unsigned 5 -> 251, signed 5 -> -5
    let ku = key(0, 0x110, 0, 8, false, Vt::U);
    let ks = key(0, 0x110, 0, 8, false, Vt::S);
    next_ok(&sh, op("increased", json!({})));
    assert_eq!(key_set(&all_rows(&sh, "id")), [ku].into_iter().collect());
    undo(&sh).unwrap();
    next_ok(&sh, op("decreased", json!({})));
    assert_eq!(key_set(&all_rows(&sh, "id")), [ks].into_iter().collect());
    undo(&sh).unwrap();
    next_ok(&sh, op("either", json!({})));
    assert_eq!(
        key_set(&all_rows(&sh, "id")),
        [ku, ks].into_iter().collect()
    );
    let rows = all_rows(&sh, "id");
    assert_eq!(
        fnum(row_by_key(&rows, &ks).unwrap(), "previousRaw"),
        Some(-5.0)
    );
    assert_eq!(
        fnum(row_by_key(&rows, &ku).unwrap(), "previousRaw"),
        Some(251.0)
    );
    // 0xFB -> 0x05 -> 0xFB: endpoint equal -> changed keeps (toggle-based), either removes (endpoint-based).
    feed_seq(&sh, 0, 0x110, &[&[0x05], &[0xFB]], 200_000, 10_000);
    let st = next_ok(&sh, op("changed", json!({})));
    assert_eq!(cands(&st), 2, "changed is toggle-based (S5)");
    undo(&sh).unwrap();
    // Undo does not restore the OR-mask (S5): the same movement again for the either probe.
    feed_seq(&sh, 0, 0x110, &[&[0x05], &[0xFB]], 300_000, 10_000);
    let st = next_ok(&sh, op("either", json!({})));
    assert_eq!(cands(&st), 0, "either is endpoint-based");
}

#[test]
fn r2c_qa_increased_by_decreased_by_raw_and_physical() {
    let sh = sh_started();
    feed_seq(&sh, 0, 0x120, &[&[10, 100]], 0, 10_000);
    first_ok(
        &sh,
        unknown(
            json!({ "lengths": [8], "byteOrders": ["intel"], "signed": [false], "excludeConstant": false }),
        ),
    );
    let b0 = key(0, 0x120, 0, 8, false, Vt::U);
    feed_seq(&sh, 0, 0x120, &[&[15, 107]], 100_000, 10_000); // +5, +7
    let st = next_ok(
        &sh,
        op("increasedBy", json!({ "value": 6, "tolerance": 1 })),
    );
    assert_eq!(cands(&st), 2, "tolerance ±1 around 6 keeps +5 and +7");
    undo(&sh).unwrap();
    let st = next_ok(&sh, op("increasedBy", json!({ "value": 5 })));
    assert_eq!(cands(&st), 1, "raw tolerance defaults to 0");
    assert_eq!(key_set(&all_rows(&sh, "id")), [b0].into_iter().collect());
    feed_seq(&sh, 0, 0x120, &[&[12, 105]], 200_000, 10_000); // -3
    let st = next_ok(&sh, op("decreasedBy", json!({ "value": 3 })));
    assert_eq!(cands(&st), 1);
    undo(&sh).unwrap();
    // Physical: -3 raw × 0.5 = -1.5 physical.
    let st = next_ok(
        &sh,
        op(
            "decreasedBy",
            json!({ "value": 1.5, "physical": true, "presets": [{ "factor": 0.5, "offset": 0 }] }),
        ),
    );
    assert_eq!(cands(&st), 1);
    let rows = all_rows(&sh, "id");
    let r = row_by_key(&rows, &b0).unwrap();
    assert_eq!(
        r["preset"],
        json!({ "factor": 0.5, "offset": 0.0 }),
        "matching preset kept per candidate"
    );
    assert_eq!(fnum(r, "currentPhysical"), Some(6.0));
    undo(&sh).unwrap();
    let st = next_ok(&sh, op("decreasedBy", json!({ "value": 2 })));
    assert_eq!(cands(&st), 0, "decreasedBy 2 does not match -3");
}

#[test]
fn r2c_qa_exact_raw_tolerance_and_range() {
    let sh = sh_started();
    feed_seq(&sh, 0, 0x130, &[&[98, 100, 102, 105]], 0, 10_000);
    let o =
        json!({ "lengths": [8], "byteOrders": ["intel"], "signed": [false], "alignment": "byte" });
    let b = |s: u16| key(0, 0x130, s, 8, false, Vt::U);
    first_ok(&sh, spec("exact", json!({ "value": 100 }), o.clone()));
    assert_eq!(key_set(&all_rows(&sh, "id")), [b(8)].into_iter().collect());
    first_ok(
        &sh,
        spec("exact", json!({ "value": 100, "tolerance": 2 }), o.clone()),
    );
    assert_eq!(
        key_set(&all_rows(&sh, "id")),
        [b(0), b(8), b(16)].into_iter().collect()
    );
    let mut oc = o.clone();
    oc.as_object_mut()
        .unwrap()
        .insert("excludeConstant".into(), json!(false));
    first_ok(
        &sh,
        spec("range", json!({ "range": [101, 110] }), oc.clone()),
    );
    assert_eq!(
        key_set(&all_rows(&sh, "id")),
        [b(16), b(24)].into_iter().collect()
    );
    // Next exact / range on the surviving set (CE "next scan = new value").
    first_ok(&sh, unknown(oc));
    feed_seq(&sh, 0, 0x130, &[&[50, 80, 102, 120]], 100_000, 10_000);
    next_ok(&sh, op("range", json!({ "range": [80, 102] })));
    assert_eq!(
        key_set(&all_rows(&sh, "id")),
        [b(8), b(16)].into_iter().collect()
    );
    next_ok(&sh, op("exact", json!({ "value": 81, "tolerance": 1 })));
    assert_eq!(key_set(&all_rows(&sh, "id")), [b(8)].into_iter().collect());
}

#[test]
fn r2c_qa_physical_first_scan_preset_order_and_kept_preset() {
    let sh = sh_started();
    feed_seq(&sh, 0, 0x140, &[&[0xD2, 0x04]], 0, 10_000); // Intel 16-bit = 1234
    let o = json!({ "lengths": [16], "byteOrders": ["intel"], "signed": [false] });
    let k = key(0, 0x140, 0, 16, false, Vt::U);
    // Standard grid (presets null): first match in factor-major order is ×0.01 +0.
    first_ok(&sh, spec("physical", json!({ "value": 12.34 }), o.clone()));
    let rows = all_rows(&sh, "id");
    assert_eq!(key_set(&rows), [k].into_iter().collect());
    let r = row_by_key(&rows, &k).unwrap();
    assert_eq!(r["preset"], json!({ "factor": 0.01, "offset": 0.0 }));
    assert!((fnum(r, "currentPhysical").unwrap() - 12.34).abs() < 1e-9);
    // A candidate with a preset is tested only under its own preset (op.presets ignored).
    let st = next_ok(
        &sh,
        op(
            "exact",
            json!({ "value": 12.34, "physical": true, "presets": [{ "factor": 1, "offset": 0 }] }),
        ),
    );
    assert_eq!(cands(&st), 1);
    // User presets are tried first.
    first_ok(
        &sh,
        spec(
            "physical",
            json!({ "value": 24.68, "userPresets": [{ "factor": 0.02, "offset": 0 }] }),
            o.clone(),
        ),
    );
    let rows = all_rows(&sh, "id");
    assert_eq!(
        row_by_key(&rows, &k).unwrap()["preset"],
        json!({ "factor": 0.02, "offset": 0.0 })
    );
    // Offsets: 1234 × 0.1 − 40 = 83.4.
    first_ok(&sh, spec("physical", json!({ "value": 83.4 }), o.clone()));
    let rows = all_rows(&sh, "id");
    assert_eq!(
        row_by_key(&rows, &k).unwrap()["preset"],
        json!({ "factor": 0.1, "offset": -40.0 })
    );
    // Default tolerance = max(|factor|, 0.5 % of X): 12.40 is within 0.062 of 12.34 under ×0.01 -> match;
    // 12.45 is not (and no other preset matches).
    first_ok(&sh, spec("physical", json!({ "value": 12.40 }), o.clone()));
    assert_eq!(cands(&status(&sh)), 1);
    first_ok(
        &sh,
        spec(
            "physical",
            json!({ "value": 12.45, "presets": [{ "factor": 0.01, "offset": 0 }] }),
            o.clone(),
        ),
    );
    assert_eq!(cands(&status(&sh)), 0);
    // Physical range with presets.
    let mut oc = o;
    oc.as_object_mut()
        .unwrap()
        .insert("excludeConstant".into(), json!(false));
    first_ok(
        &sh,
        spec(
            "range",
            json!({ "range": [12.0, 13.0], "physical": true, "presets": [{ "factor": 0.01, "offset": 0 }] }),
            oc,
        ),
    );
    assert_eq!(cands(&status(&sh)), 1);
}

#[test]
fn r2c_qa_stable_for_t_ms_and_history_covered() {
    let sh = sh_started();
    // 80 frames @ 50 ms. byte0 toggles in frames 0..9 then 0x42; byte1 0x10 until frame 74, then 0x20.
    let payload = |i: u64| -> [u8; 2] {
        let b0 = if i < 10 {
            [0x00, 0xFF][(i % 2) as usize]
        } else {
            0x42
        };
        let b1 = if i < 74 { 0x10 } else { 0x20 };
        [b0, b1]
    };
    let frames = |r: std::ops::Range<u64>| -> Vec<RawCanFrame> {
        r.map(|i| std_frame(0, 0x150, &payload(i), i * 50_000))
            .collect()
    };
    feed(&sh, &frames(0..20));
    first_ok(
        &sh,
        unknown(json!({
            "lengths": [8], "byteOrders": ["intel"], "signed": [false], "alignment": "byte", "excludeConstant": false
        })),
    );
    feed(&sh, &frames(20..80));
    let k0 = key(0, 0x150, 0, 8, false, Vt::U);
    // now = 3950 ms; window 1000 ms starts at 2950 ms; ring holds frames 16..79 (oldest 800 ms).
    let st = next_ok(&sh, op("stable", json!({ "stableMs": 1000 })));
    assert_eq!(key_set(&all_rows(&sh, "id")), [k0].into_iter().collect());
    assert_eq!(st["historyCovered"], true);
    undo(&sh).unwrap();
    // 3500 ms window starts at 450 ms < oldest retained sample (800 ms): judged on what the ring has.
    let st = next_ok(&sh, op("stable", json!({ "stableMs": 3500 })));
    assert_eq!(st["historyCovered"], false);
    assert_eq!(key_set(&all_rows(&sh, "id")), [k0].into_iter().collect());
    let st = next_ok(&sh, op("unchanged", json!({})));
    assert_eq!(
        st["historyCovered"],
        Value::Null,
        "historyCovered only for stable"
    );
}

#[test]
fn r2c_qa_counter_checksum_excluded_by_default_and_kind_hint() {
    let sh = sh_started();
    feed(&sh, &planted_phases(&VARIANT_12)[0]);
    let row = (0u8, false, u32::from(PLANTED_ID));
    let meta = row_meta(&sh, row.0, row.1, row.2);
    assert!(
        meta.counter_checksum[0] & 0xFF != 0,
        "precondition: classifier finds the byte0 counter"
    );
    assert!(
        meta.counter_checksum[0] >> 56 != 0,
        "precondition: classifier finds the byte7 checksum"
    );
    let ids = json!([{ "bus": 0, "arbId": PLANTED_ID, "isExtended": false }]);
    let st = first_ok(&sh, unknown(json!({ "ids": ids.clone() })));
    let want = oracle_first(&sh, &[row], &OOpts::defaults(), true, true);
    assert_eq!(cands(&st), want.len() as u64);
    let got = key_set(&all_rows(&sh, "id"));
    assert_eq!(got, want.keys().copied().collect::<BTreeSet<Key>>());
    for k in &got {
        assert!(
            !mask_and(&k.mask(), &meta.counter_checksum),
            "{k:?} touches counter/checksum bits"
        );
    }
    let st = first_ok(
        &sh,
        unknown(
            json!({ "ids": ids, "excludeCounterChecksum": false, "lengths": [8], "signed": [false] }),
        ),
    );
    let want = oracle_first(
        &sh,
        &[row],
        &OOpts {
            lengths: vec![8],
            signed: false,
            ..OOpts::defaults()
        },
        false,
        true,
    );
    assert_eq!(cands(&st), want.len() as u64);
    let rows = all_rows(&sh, "id");
    let c = row_by_key(&rows, &key(0, row.2, 0, 8, false, Vt::U)).expect("byte0 candidate");
    assert_eq!(c["kindHint"], "counter");
    let c = row_by_key(&rows, &key(0, row.2, 56, 8, false, Vt::U)).expect("byte7 candidate");
    assert_eq!(c["kindHint"], "checksum");
}

#[test]
fn r2c_qa_constant_excluded_except_equals_first_scan() {
    let sh = sh_started();
    feed_seq(
        &sh,
        0,
        0x160,
        &[&[0x00, 0x00], &[0x00, 0xFF], &[0x00, 0x0F]],
        0,
        10_000,
    );
    let o = |c: bool| json!({ "lengths": [8], "byteOrders": ["intel"], "signed": [false], "alignment": "byte", "excludeConstant": c });
    let st = first_ok(&sh, unknown(o(true)));
    assert_eq!(
        key_set(&all_rows(&sh, "id")),
        [key(0, 0x160, 8, 8, false, Vt::U)].into_iter().collect()
    );
    assert_eq!(cands(&st), 1);
    assert_eq!(cands(&first_ok(&sh, unknown(o(false)))), 2);
    first_ok(&sh, spec("exact", json!({ "value": 0 }), o(true)));
    assert_eq!(
        key_set(&all_rows(&sh, "id")),
        [key(0, 0x160, 0, 8, false, Vt::U)].into_iter().collect(),
        "exact first scan ignores excludeConstant"
    );
    first_ok(&sh, spec("range", json!({ "range": [0, 0] }), o(true)));
    assert_eq!(
        cands(&status(&sh)),
        0,
        "range first scan applies excludeConstant"
    );
}

#[test]
fn r2c_qa_bus_and_id_filters() {
    let sh = sh_started();
    for bus in [0u8, 1] {
        feed_seq(
            &sh,
            bus,
            0x170,
            &[&[0x00], &[0xFF]],
            u64::from(bus) * 1_000,
            10_000,
        );
        feed_seq(
            &sh,
            bus,
            0x171,
            &[&[0x00], &[0xFF]],
            u64::from(bus) * 1_000 + 500,
            10_000,
        );
    }
    let o = |extra: Value| {
        let mut v = json!({ "lengths": [8], "byteOrders": ["intel"], "signed": [false] });
        for (k, x) in extra.as_object().unwrap() {
            v.as_object_mut().unwrap().insert(k.clone(), x.clone());
        }
        v
    };
    assert_eq!(cands(&first_ok(&sh, unknown(o(json!({}))))), 4);
    first_ok(&sh, unknown(o(json!({ "buses": [1] }))));
    let got = key_set(&all_rows(&sh, "id"));
    assert_eq!(got.len(), 2);
    assert!(got.iter().all(|k| k.bus == 1));
    first_ok(
        &sh,
        unknown(o(
            json!({ "ids": [{ "bus": 0, "arbId": 0x171, "isExtended": false }] }),
        )),
    );
    assert_eq!(
        key_set(&all_rows(&sh, "id")),
        [key(0, 0x171, 0, 8, false, Vt::U)].into_iter().collect()
    );
    let st = first_ok(
        &sh,
        unknown(o(
            json!({ "buses": [1], "ids": [{ "bus": 0, "arbId": 0x171, "isExtended": false }] }),
        )),
    );
    assert_eq!(cands(&st), 0, "buses ∩ ids");
    // An ext id with the same number is a different row.
    let st = first_ok(
        &sh,
        unknown(o(
            json!({ "ids": [{ "bus": 0, "arbId": 0x171, "isExtended": true }] }),
        )),
    );
    assert_eq!(cands(&st), 0);
}

#[test]
fn r2c_qa_next_never_adds_rows_seen_after_first_scan() {
    let sh = sh_started();
    feed_seq(&sh, 0, 0x100, &[&[0x00], &[0xFF]], 0, 10_000);
    first_ok(
        &sh,
        unknown(json!({ "lengths": [8], "byteOrders": ["intel"] })),
    );
    let before = key_set(&all_rows(&sh, "id"));
    feed_seq(&sh, 0, 0x101, &[&[0x00], &[0xFF], &[0x0F]], 100_000, 10_000);
    feed_seq(&sh, 0, 0x100, &[&[0x01]], 200_000, 10_000);
    next_ok(&sh, op("changed", json!({})));
    let after = key_set(&all_rows(&sh, "id"));
    assert!(after.is_subset(&before), "next scans only filter");
    assert!(after.iter().all(|k| k.arb == 0x100));
}

#[test]
fn r2c_qa_analyzer_reset_invalidates_scan() {
    let sh = changed_setup();
    let _ = sh.lock().reset();
    assert_eq!(status(&sh)["active"], false);
    assert_code(
        &next(&sh, op("changed", json!({}))),
        "no_scan",
        "next after ReAnalyzer::reset",
    );
}

#[test]
fn r2c_qa_median_read_mode() {
    let sh = sh_started();
    feed_seq(
        &sh,
        0,
        0x190,
        &[&[0], &[10], &[10], &[10], &[10], &[200]],
        0,
        10_000,
    );
    let o = |rm: Value| json!({ "lengths": [8], "byteOrders": ["intel"], "signed": [false], "readMode": rm });
    let k = key(0, 0x190, 0, 8, false, Vt::U);
    first_ok(
        &sh,
        spec(
            "exact",
            json!({ "value": 10 }),
            o(json!({ "kind": "latest" })),
        ),
    );
    assert_eq!(cands(&status(&sh)), 0, "latest = 200");
    first_ok(
        &sh,
        spec(
            "exact",
            json!({ "value": 10 }),
            o(json!({ "kind": "median", "samples": 5 })),
        ),
    );
    let rows = all_rows(&sh, "id");
    assert_eq!(key_set(&rows), [k].into_iter().collect());
    assert_eq!(
        fnum(&rows[0], "currentRaw"),
        Some(10.0),
        "results use the scan's read mode"
    );
    // Lower median for even N: last 4 = [1,2,3,4] -> 2.
    feed_seq(&sh, 0, 0x190, &[&[1], &[2], &[3], &[4]], 100_000, 10_000);
    first_ok(
        &sh,
        spec(
            "exact",
            json!({ "value": 2 }),
            o(json!({ "kind": "median", "samples": 4 })),
        ),
    );
    assert_eq!(cands(&status(&sh)), 1);
    first_ok(
        &sh,
        spec(
            "exact",
            json!({ "value": 3 }),
            o(json!({ "kind": "median", "samples": 4 })),
        ),
    );
    assert_eq!(cands(&status(&sh)), 0);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Results: pagination, sort, grouping
// ═══════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn r2c_qa_results_pagination_limit_and_sort() {
    let sh = sh_started();
    varying_row(&sh, 0, 0x1C0, 8, 21);
    let st = first_ok(&sh, unknown(json!({})));
    let n = cands(&st);
    assert!(
        n > 2 * u64::from(RE_SCAN_MAX_RESULTS),
        "precondition: > 1000 candidates ({n})"
    );
    let p0 = results(&sh, 0, RE_SCAN_MAX_RESULTS, "id").unwrap();
    assert_eq!(
        p0["rows"].as_array().unwrap().len(),
        RE_SCAN_MAX_RESULTS as usize
    );
    assert_eq!(
        u(&p0, "total"),
        n,
        "changeCount 0 -> no grouping, total == candidates"
    );
    assert_eq!(u(&p0, "candidates"), n);
    assert_eq!(u(&p0, "offset"), 0);
    let p1 = results(&sh, 7, 3, "id").unwrap();
    assert_eq!(
        p1["rows"].as_array().unwrap()[..],
        p0["rows"].as_array().unwrap()[7..10]
    );
    let all = all_rows(&sh, "id");
    assert_eq!(all.len() as u64, n);
    let ks: Vec<Key> = all.iter().map(|r| key_of(&r["candidate"])).collect();
    assert!(
        ks.windows(2).all(|w| w[0] < w[1]),
        "id sort strictly ascending, no duplicates"
    );
    let w = all_rows(&sh, "width");
    let wk: Vec<Key> = w.iter().map(|r| key_of(&r["candidate"])).collect();
    assert!(
        wk.windows(2)
            .all(|p| p[0].len > p[1].len || (p[0].len == p[1].len && p[0] < p[1])),
        "width sort = bitLength desc, then id"
    );
    let empty = results(&sh, n as u32 + 10, 10, "id").unwrap();
    assert_eq!(empty["rows"], json!([]));
    // changes sort after a step with mixed change counts.
    let mut rng = Lcg(99);
    let d: Vec<u8> = (0..8).map(|_| rng.next_u8()).collect();
    feed(&sh, &[std_frame(0, 0x1C0, &d, 1_000_000)]);
    next_ok(&sh, op("changed", json!({})));
    let c = all_rows(&sh, "changes");
    let pairs: Vec<(u64, Key)> = c
        .iter()
        .map(|r| (u(r, "changeCount"), key_of(&r["candidate"])))
        .collect();
    assert!(
        pairs
            .windows(2)
            .all(|p| p[0].0 > p[1].0 || (p[0].0 == p[1].0 && p[0].1 < p[1].1)),
        "changes sort = changeCount desc, then id"
    );
}

#[test]
fn r2c_qa_grouping_nested_identical_movers() {
    let sh = sh_started();
    // byte0: all bits toggled before the scan, then 0x10 -> 0x20 -> 0x30; byte1 constant 0.
    feed_seq(
        &sh,
        0,
        0x180,
        &[&[0x00, 0x00], &[0xFF, 0x00], &[0x10, 0x00]],
        0,
        10_000,
    );
    let st = first_ok(
        &sh,
        unknown(json!({ "lengths": [4, 8, 12, 16], "byteOrders": ["intel"], "signed": [false] })),
    );
    let n0 = cands(&st);
    let rows0 = all_rows(&sh, "id");
    assert_eq!(rows0.len() as u64, n0, "changeCount 0 -> nothing grouped");
    feed_seq(&sh, 0, 0x180, &[&[0x20, 0x00]], 100_000, 10_000);
    next_ok(&sh, op("increased", json!({})));
    feed_seq(&sh, 0, 0x180, &[&[0x30, 0x00]], 200_000, 10_000);
    let st = next_ok(&sh, op("increased", json!({})));
    let n = cands(&st);
    let page = results(&sh, 0, RE_SCAN_MAX_RESULTS, "width").unwrap();
    assert_eq!(u(&page, "candidates"), n);
    let rows = all_rows(&sh, "width");
    assert_eq!(u(&page, "total"), rows.len() as u64);
    let sum: u64 = rows.iter().map(|r| 1 + u(r, "containedCount")).sum();
    assert_eq!(
        sum, n,
        "every candidate appears exactly once (rep or contained)"
    );
    let flat = key_set(&rows);
    assert_eq!(flat.len() as u64, n);
    for r in &rows {
        let rk = key_of(&r["candidate"]);
        let contained = r["contained"].as_array().unwrap();
        assert_eq!(contained.len() as u64, u(r, "containedCount"));
        for c in contained {
            let ck = key_of(c);
            assert_eq!((ck.bus, ck.ext, ck.arb), (rk.bus, rk.ext, rk.arb));
            assert!(
                proper_subset(&ck.mask(), &rk.mask()),
                "{ck:?} not nested in {rk:?}"
            );
        }
        for o in &rows {
            let ok = key_of(&o["candidate"]);
            if ok != rk && u(o, "changeCount") == u(r, "changeCount") && o["preset"] == r["preset"]
            {
                assert!(
                    !proper_subset(&rk.mask(), &ok.mask()),
                    "representative {rk:?} nested in {ok:?}"
                );
            }
        }
    }
    let k16 = key(0, 0x180, 0, 16, false, Vt::U);
    let top = row_by_key(&rows, &k16).expect("16-bit field is a representative");
    assert_eq!(u(top, "changeCount"), 2);
    let inner: BTreeSet<Key> = top["contained"]
        .as_array()
        .unwrap()
        .iter()
        .map(key_of)
        .collect();
    assert!(
        inner.contains(&key(0, 0x180, 0, 8, false, Vt::U)),
        "8-bit inside 16-bit grouped"
    );
    assert!(
        inner.contains(&key(0, 0x180, 4, 4, false, Vt::U)),
        "high nibble grouped"
    );
    assert!(
        !flat.contains(&key(0, 0x180, 0, 4, false, Vt::U)),
        "low nibble stayed 0 -> removed"
    );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Cap, budget
// ═══════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn r2c_qa_cap_scan_too_large_keeps_previous_scan() {
    let per_row = oracle_count_row(64, &OOpts::defaults());
    let rows = (RE_SCAN_MAX_CANDIDATES as u64 / per_row + 2) as u16;
    eprintln!("cap probe: {per_row} candidates per 64-byte row × {rows} rows");
    let sh = sh_started();
    for i in 0..rows {
        varying_row(&sh, 0, 0x200 + i, 64, 1000 + u32::from(i));
    }
    assert!(per_row * u64::from(rows) > RE_SCAN_MAX_CANDIDATES as u64);
    let small = first_ok(
        &sh,
        unknown(json!({ "ids": [{ "bus": 0, "arbId": 0x200, "isExtended": false }] })),
    );
    assert_eq!(cands(&small), per_row);
    let r = first(&sh, unknown(json!({})));
    assert_code(&r, "scan_too_large", "unknown over > 4 M candidates");
    assert_eq!(
        status(&sh),
        small,
        "a failed first scan keeps the previous scan"
    );
    let st = first_ok(&sh, unknown(json!({ "lengths": [8], "alignment": "byte" })));
    assert!(cands(&st) > 0, "narrowed scan succeeds");
}

#[test]
fn r2c_qa_time_budget_zero_truncates_and_never_drops_unjudged() {
    let sh = sh_started();
    varying_row(&sh, 0, 0x1D0, 8, 5);
    let full = first_ok(&sh, unknown(json!({})));
    assert_eq!(full["truncated"], false);
    let n = cands(&full);
    sh.scan_set_budget(Duration::ZERO);
    let st = first_ok(&sh, unknown(json!({})));
    assert_eq!(st["truncated"], true);
    assert_eq!(cands(&st), 0, "zero budget evaluates nothing (S9)");
    sh.scan_set_budget(RE_SCAN_BUDGET);
    assert_eq!(cands(&first_ok(&sh, unknown(json!({})))), n);
    feed(
        &sh,
        &[std_frame(0, 0x1D0, &[1, 2, 3, 4, 5, 6, 7, 8], 1_000_000)],
    );
    sh.scan_set_budget(Duration::ZERO);
    let st = next_ok(&sh, op("unchanged", json!({})));
    assert_eq!(st["truncated"], true);
    assert_eq!(
        cands(&st),
        n,
        "truncated next scan keeps every unevaluated candidate"
    );
    sh.scan_set_budget(RE_SCAN_BUDGET);
    let st = next_ok(&sh, op("changed", json!({})));
    assert_eq!(st["truncated"], false);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Hot path: allocation-free ingest, R1 throughput, 1 M candidate scans
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const ALLOC_ROWS: u32 = 2_048;

fn rand_ext_frames(n: usize, rows: u32, seed: u32) -> Vec<RawCanFrame> {
    let mut rng = Lcg(seed);
    (0..n)
        .map(|i| {
            let mut d = [0u8; 8];
            for x in &mut d {
                *x = rng.next_u8();
            }
            ext_frame(0, (i as u32) % rows, &d, i as u64 * 20)
        })
        .collect()
}

#[test]
fn r2c_qa_ingest_alloc_free_with_scan_active() {
    let sh = sh_started();
    {
        let mut g = sh.lock();
        for id in 0..ALLOC_ROWS {
            g.ingest(&ext_frame(0, id, &[0; 8], 0));
            g.ingest(&ext_frame(0, id, &[0xFF; 8], 1));
        }
    }
    let ids: Vec<Value> = (0..4u32)
        .map(|id| json!({ "bus": 0, "arbId": id, "isExtended": true }))
        .collect();
    first_ok(&sh, unknown(json!({ "ids": ids })));
    let frames = rand_ext_frames(60_000, ALLOC_ROWS, 3);
    let n = {
        let mut g = sh.lock();
        count_allocs(|| {
            for f in &frames {
                g.ingest(f);
            }
        })
    };
    assert_eq!(
        n, 0,
        "ingest allocated {n} times with a scan active (scan_changed OR-mask)"
    );
    // The OR-mask accumulated: changed keeps every candidate of the scanned rows (all bits moved).
    let st = next_ok(&sh, op("changed", json!({})));
    assert!(cands(&st) > 0);
}

fn ingest_pass(sh: &ReShared, frames: &[RawCanFrame]) -> Duration {
    let mut g = sh.lock();
    let t0 = Instant::now();
    for f in frames {
        g.ingest(f);
    }
    t0.elapsed()
}

#[test]
#[cfg_attr(debug_assertions, ignore = "release-only timing probe")]
fn r2c_qa_perf_r1_ingest_within_10pct_with_scan_active() {
    let sh = sh_started();
    let frames = rand_ext_frames(200_000, ALLOC_ROWS, 5);
    let _ = ingest_pass(&sh, &frames); // warm-up: creates all 2048 rows
    let ids: Vec<Value> = (0..4u32)
        .map(|id| json!({ "bus": 0, "arbId": id, "isExtended": true }))
        .collect();
    let mut idle = Duration::MAX;
    let mut active = Duration::MAX;
    for _ in 0..7 {
        let _ = sh.scan_reset();
        idle = idle.min(ingest_pass(&sh, &frames));
        first_ok(&sh, unknown(json!({ "ids": ids.clone() })));
        active = active.min(ingest_pass(&sh, &frames));
    }
    let fps_idle = frames.len() as f64 / idle.as_secs_f64();
    let fps_active = frames.len() as f64 / active.as_secs_f64();
    eprintln!("R1 ingest @2048 rows: no scan {fps_idle:.0} fps, scan active {fps_active:.0} fps");
    assert!(
        fps_active >= 0.90 * fps_idle,
        "scan_changed OR-mask costs > 10 %: {fps_active:.0} vs {fps_idle:.0} fps"
    );
    // Absolute gate vs the recorded R2a baseline (≈ 6.1 M fps on the gate machine). Only asserted when the
    // gate machine provides its baseline: NEXUS_RE_R1_BASELINE_FPS=<fps> cargo test --release …
    if let Some(base) = std::env::var("NEXUS_RE_R1_BASELINE_FPS")
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
    {
        assert!(
            fps_idle.min(fps_active) >= 0.90 * base,
            "R1 ingest {:.0} fps < 90 % of baseline {base:.0}",
            fps_idle.min(fps_active)
        );
    }
}

/// ≥ 1 M candidates: 64-byte FD rows, every bit varying, default options.
fn million_setup() -> (ReShared, u64, u16) {
    let per_row = oracle_count_row(64, &OOpts::defaults());
    let rows = 1_000_000u64.div_ceil(per_row) as u16;
    let sh = sh_started();
    for i in 0..rows {
        varying_row(&sh, 0, 0x400 + i, 64, 77 + u32::from(i));
    }
    (sh, per_row * u64::from(rows), rows)
}

#[test]
#[cfg_attr(debug_assertions, ignore = "release-only timing probe")]
fn r2c_qa_perf_1m_candidates_within_budget() {
    let (sh, n, rows) = million_setup();
    assert!(n >= 1_000_000);
    let t0 = Instant::now();
    let st = first_ok(&sh, unknown(json!({})));
    let wall = t0.elapsed();
    eprintln!(
        "unknown first scan: {n} candidates in {wall:?} (elapsedMs {})",
        st["elapsedMs"]
    );
    assert_eq!(cands(&st), n);
    assert_eq!(st["truncated"], false);
    assert!(
        fnum(&st, "elapsedMs").unwrap() < 2000.0
            && wall < nexus_core::testing::scaled(Duration::from_millis(2500))
    );
    let mut rng = Lcg(4242);
    let frames: Vec<RawCanFrame> = (0..rows)
        .map(|i| {
            let d: Vec<u8> = (0..64).map(|_| rng.next_u8()).collect();
            fd_frame(0, 0x400 + i, &d, 5_000_000)
        })
        .collect();
    feed(&sh, &frames);
    for o in [op("changed", json!({})), op("increased", json!({}))] {
        let t0 = Instant::now();
        let st = next_ok(&sh, o.clone());
        let wall = t0.elapsed();
        eprintln!("{} -> {} in {wall:?}", o["op"], cands(&st));
        assert_eq!(st["truncated"], false, "{}", o["op"]);
        assert!(
            wall < nexus_core::testing::scaled(Duration::from_millis(2500)),
            "{} took {wall:?}",
            o["op"]
        );
    }
    // Exact physical over the full 66-preset grid on ≥ 1 M candidates.
    let t0 = Instant::now();
    let st = first_ok(&sh, spec("physical", json!({ "value": 42.0 }), json!({})));
    let wall = t0.elapsed();
    eprintln!(
        "physical first scan (66 presets) -> {} in {wall:?}",
        cands(&st)
    );
    assert_eq!(st["truncated"], false);
    assert!(
        wall < nexus_core::testing::scaled(Duration::from_millis(2500)),
        "physical scan took {wall:?}"
    );
    let t0 = Instant::now();
    let _ = results(&sh, 0, RE_SCAN_MAX_RESULTS, "changes").expect("results");
    assert!(
        t0.elapsed() < nexus_core::testing::scaled(Duration::from_millis(1000)),
        "results page took {:?}",
        t0.elapsed()
    );
}

#[test]
#[cfg_attr(debug_assertions, ignore = "release-only timing probe")]
fn r2c_qa_perf_scan_does_not_hold_analyzer_lock() {
    let (sh, _, _) = million_setup();
    let sh = std::sync::Arc::new(sh);
    let worker = {
        let sh = std::sync::Arc::clone(&sh);
        std::thread::spawn(move || {
            first(&sh, spec("physical", json!({ "value": 42.0 }), json!({})))
        })
    };
    let mut max_wait = Duration::ZERO;
    let mut i = 0u64;
    while !worker.is_finished() {
        let t0 = Instant::now();
        let mut g = sh.lock();
        max_wait = max_wait.max(t0.elapsed());
        g.ingest(&std_frame(1, 0x7FF, &[(i & 0xFF) as u8; 8], 10_000_000 + i));
        drop(g);
        i += 1;
        std::thread::sleep(Duration::from_micros(200));
    }
    let r = worker.join().expect("worker");
    assert!(r.is_ok(), "scan failed: {r:?}");
    eprintln!("max analyzer lock wait during a 1 M scan: {max_wait:?} ({i} ingests)");
    assert!(
        max_wait < nexus_core::testing::scaled(Duration::from_millis(50)),
        "scan held the analyzer lock for {max_wait:?}"
    );
}
