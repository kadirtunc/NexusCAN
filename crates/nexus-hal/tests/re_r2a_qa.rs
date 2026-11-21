//! QA gate probes for RE Toolkit R2a "Signal Inspector" (planning/contracts/re-toolkit-v1.md §6, §5).
//!
//! Written BEFORE the implementation, independent of backend-dev's own unit tests.
//! Run: `cargo test -p nexus-hal --test re_r2a_qa` (sweep time budget asserted only in `--release`).
//!
//! Bit-math oracle: `nexus_netdb::compiler::bit_plan::{NormalizedBitSpan, trace_signal_bits}` (contract
//! §6: no second Intel/Motorola implementation). The oracle itself is pinned against hand-computed
//! layouts in `r2a_qa_oracle_pinned_by_hand`, so an oracle regression cannot silently pass these probes.
//!
//! ======================================================================================
//! API ASSUMPTION BLOCK (frozen by team-lead; backend-dev implements exactly this)
//! ======================================================================================
//! ```text
//! use nexus_hal::pipeline::re_analyzer::{ReAnalyzer, MAX_RE_FOCUS, RE_FOCUS_DEPTH, obd_pid_value,
//!     ReTargetDto, ReCandidateDto, ReReferenceDto, ReSearchDto, ReSeriesRequest, ReCorrelateRequest};
//! impl ReAnalyzer {
//!   pub fn focus_set(&mut self, targets: &[ReTargetDto]) -> Result<ReFocusStatusDto, ReError>;  // >8 → Err
//!   pub fn focus_status(&self) -> ReFocusStatusDto;
//!   pub fn series(&mut self, req: &ReSeriesRequest, out: &mut Vec<u8>) -> Result<(), ReError>;   // §6.3 bytes; may auto-focus reference IDs
//!   pub fn correlate(&mut self, req: &ReCorrelateRequest) -> Result<ReCorrelationResultDto, ReError>; // sync; engine runs it off the aggregator
//! }
//! pub fn obd_pid_value(pid: u8, data: &[u8]) -> Option<f64>;   // A,B,C,D bytes after [0x41,pid]
//! // ReSeriesRequest { target, candidates, reference: Option<ReReferenceDto>, from_us: Option<u64>, to_us: Option<u64>, max_points: u16 }
//! // ReCorrelateRequest { target, reference, from_us: Option<u64>, to_us: Option<u64>, search: ReSearchDto, top_n: u8 }
//! // ReError Display starts with "[re:<code>]" — codes: invalid, focus_full, no_reference, not_started
//! // All DTOs serde camelCase as in §6.2; DTO structs constructible from tests (pub fields) or via serde_json::from_value.
//! ```
//! QA usage notes (no extra API demanded):
//! - Input DTOs (`ReTargetDto`, `ReCandidateDto`, `ReReferenceDto`, `ReSearchDto`) are built through
//!   `serde_json::from_value` with the §6.2 camelCase wire shape (`ReReferenceDto` tagged by `kind`).
//!   A wire value that fails to deserialize counts as a rejection in the "invalid" probes.
//! - `ReSeriesRequest` / `ReCorrelateRequest` are built with struct literals (field names above).
//! - Results (`ReFocusStatusDto`, `ReCorrelationResultDto`) are read through `serde_json::to_value`.
//! - Errors are read through `Display` only (`[re:<code>]` prefix).
//! - `ReAnalyzer::{new, start, stop, ingest, mark, markers}` are the R1 API (tests/re_qa.rs).
//!
//! ======================================================================================

use nexus_core::{flags::FLAG_ERROR, now_monotonic_us, CanIdKey, RawCanFrame};
use nexus_hal::pipeline::re_analyzer::{
    obd_pid_value, ReAnalyzer, ReCandidateDto, ReCorrelateRequest, ReReferenceDto, ReSearchDto,
    ReSeriesRequest, ReTargetDto, MAX_RE_FOCUS, RE_FOCUS_DEPTH,
};
use nexus_netdb::compiler::bit_plan::{trace_signal_bits, NormalizedBitSpan};
use nexus_netdb::ByteOrder;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::collections::BTreeSet;
use std::fmt::Display;
use std::time::{Duration, Instant};

/// Local mirrors of the frozen constants (each asserted equal in `r2a_qa_constants`).
const FOCUS_SLOTS: usize = 8;
const DEPTH: usize = 16_384;

// ─── Thread-local counting allocator (counts calls AND bytes on a thread that armed it) ────────

struct CountingAlloc;

thread_local! {
    static COUNT_ON: Cell<bool> = const { Cell::new(false) };
    static COUNT: Cell<u64> = const { Cell::new(0) };
    static BYTES: Cell<u64> = const { Cell::new(0) };
}

#[inline]
fn record_alloc(size: usize) {
    if COUNT_ON.try_with(Cell::get).unwrap_or(false) {
        let _ = COUNT.try_with(|c| c.set(c.get() + 1));
        let _ = BYTES.try_with(|c| c.set(c.get() + size as u64));
    }
}

// SAFETY: forwards every call unchanged to the system allocator; only counts.
unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_alloc(layout.size());
        // SAFETY: same contract as the caller's.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_alloc(layout.size());
        // SAFETY: same contract as the caller's.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record_alloc(new_size);
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

/// Returns (allocation calls, allocated bytes) performed by `f` on this thread.
fn count_allocs(f: impl FnOnce()) -> (u64, u64) {
    COUNT.with(|c| c.set(0));
    BYTES.with(|c| c.set(0));
    COUNT_ON.with(|o| o.set(true));
    f();
    COUNT_ON.with(|o| o.set(false));
    (COUNT.with(Cell::get), BYTES.with(Cell::get))
}

// ─── Frame builders ───────────────────────────────────────────────────────────────────────────

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

fn started() -> ReAnalyzer {
    let mut a = ReAnalyzer::new();
    let _ = a.start(None);
    a
}

/// Deterministic LCG for pseudo-random payload bytes.
struct Lcg(u32);
impl Lcg {
    fn next_u8(&mut self) -> u8 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (self.0 >> 24) as u8
    }
    fn fill(&mut self, d: &mut [u8]) {
        for x in d {
            *x = self.next_u8();
        }
    }
}

// ─── Wire-shape DTO builders / readers ────────────────────────────────────────────────────────

fn from<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v.clone())
        .unwrap_or_else(|e| panic!("DTO must deserialize from {v}: {e}"))
}

fn try_from<T: DeserializeOwned>(v: Value) -> Option<T> {
    serde_json::from_value(v).ok()
}

fn j<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).expect("DTO must serialize")
}

fn tgt(bus: u8, id: u32, ext: bool) -> ReTargetDto {
    from(json!({ "bus": bus, "arbId": id, "isExtended": ext }))
}

fn cand_json(start: u16, len: u8, order: &str, vt: &str, factor: f64, offset: f64) -> Value {
    json!({ "startBit": start, "bitLength": len, "byteOrder": order, "valueType": vt,
            "factor": factor, "offset": offset })
}

fn cand(start: u16, len: u8, order: &str, vt: &str, factor: f64, offset: f64) -> ReCandidateDto {
    from(cand_json(start, len, order, vt, factor, offset))
}

fn ref_obd(pid: u8, bus: u8) -> ReReferenceDto {
    from(json!({ "kind": "obd_pid", "pid": pid, "bus": bus }))
}

fn ref_markers(points: &[(u32, f64)]) -> ReReferenceDto {
    let pts: Vec<Value> = points
        .iter()
        .map(|&(id, v)| json!({ "markerId": id, "value": v }))
        .collect();
    from(json!({ "kind": "markers", "points": pts }))
}

fn ref_cand(bus: u8, id: u32, ext: bool, c: Value) -> ReReferenceDto {
    from(json!({ "kind": "candidate",
                 "target": { "bus": bus, "arbId": id, "isExtended": ext },
                 "candidate": c }))
}

fn search(
    bit_from: u16,
    bit_to: u16,
    lmin: u8,
    lmax: u8,
    orders: &[&str],
    signed: &[bool],
) -> ReSearchDto {
    from(
        json!({ "bitFrom": bit_from, "bitTo": bit_to, "lengths": [lmin, lmax],
                 "byteOrders": orders, "signed": signed }),
    )
}

fn sreq(
    target: ReTargetDto,
    candidates: Vec<ReCandidateDto>,
    reference: Option<ReReferenceDto>,
    from_us: Option<u64>,
    to_us: Option<u64>,
    max_points: u16,
) -> ReSeriesRequest {
    ReSeriesRequest {
        target,
        candidates,
        reference,
        from_us,
        to_us,
        max_points,
    }
}

fn creq(
    target: ReTargetDto,
    reference: ReReferenceDto,
    from_us: Option<u64>,
    to_us: Option<u64>,
    search: ReSearchDto,
    top_n: u8,
) -> ReCorrelateRequest {
    ReCorrelateRequest {
        target,
        reference,
        from_us,
        to_us,
        search,
        top_n,
    }
}

fn num(v: &Value, key: &str) -> u64 {
    v.get(key)
        .and_then(Value::as_u64)
        .unwrap_or_else(|| panic!("missing/non-u64 `{key}` in {v}"))
}

fn fnum(v: &Value, key: &str) -> f64 {
    v.get(key)
        .and_then(Value::as_f64)
        .unwrap_or_else(|| panic!("missing/non-number `{key}` in {v}"))
}

fn st(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("missing/non-string `{key}` in {v}"))
        .to_string()
}

/// `[re:<code>] ...` -> `<code>`; panics with context when the call succeeded.
fn err_code<T, E: Display>(r: Result<T, E>, ctx: &str) -> String {
    match r {
        Ok(_) => panic!("{ctx}: expected Err([re:...]), got Ok"),
        Err(e) => {
            let s = e.to_string();
            let rest = s.strip_prefix("[re:").unwrap_or_else(|| {
                panic!("{ctx}: error Display must start with `[re:` — got {s:?}")
            });
            let end = rest
                .find(']')
                .unwrap_or_else(|| panic!("{ctx}: unterminated code in {s:?}"));
            rest[..end].to_string()
        }
    }
}

fn expect_code<T, E: Display>(r: Result<T, E>, code: &str, ctx: &str) {
    let c = err_code(r, ctx);
    assert_eq!(c, code, "{ctx}: wrong error code");
}

fn okv<T, E: Display>(r: Result<T, E>, ctx: &str) -> T {
    r.unwrap_or_else(|e| panic!("{ctx}: unexpected error {e}"))
}

fn focus(a: &mut ReAnalyzer, targets: &[(u8, u32, bool)]) -> Value {
    let t: Vec<ReTargetDto> = targets.iter().map(|&(b, i, e)| tgt(b, i, e)).collect();
    j(&okv(a.focus_set(&t), "focus_set"))
}

fn status_targets(v: &Value) -> Vec<Value> {
    v["targets"]
        .as_array()
        .unwrap_or_else(|| panic!("targets not an array: {v}"))
        .clone()
}

fn focus_entry(a: &ReAnalyzer, bus: u8, id: u32, ext: bool) -> Option<Value> {
    status_targets(&j(&a.focus_status())).into_iter().find(|t| {
        num(t, "bus") == u64::from(bus)
            && num(t, "arbId") == u64::from(id)
            && t["isExtended"].as_bool() == Some(ext)
    })
}

fn samples(a: &ReAnalyzer, bus: u8, id: u32, ext: bool) -> u64 {
    num(
        &focus_entry(a, bus, id, ext)
            .unwrap_or_else(|| panic!("0x{id:X} (bus {bus}, ext {ext}) not in focus_status")),
        "samples",
    )
}

// ─── Oracle (nexus-netdb bit plan) ────────────────────────────────────────────────────────────

fn order(motorola: bool) -> ByteOrder {
    if motorola {
        ByteOrder::BigEndian
    } else {
        ByteOrder::LittleEndian
    }
}

fn span(start: u16, len: u8, motorola: bool) -> NormalizedBitSpan {
    NormalizedBitSpan::compile(start, len, order(motorola))
        .unwrap_or_else(|e| panic!("oracle compile({start},{len},motorola={motorola}): {e:?}"))
}

fn oracle_raw(payload: &[u8], start: u16, len: u8, motorola: bool) -> u64 {
    span(start, len, motorola).extract_raw_u64(payload)
}

fn sign_extend(raw: u64, len: u8) -> i64 {
    if len >= 64 {
        return raw as i64;
    }
    let shift = 64 - u32::from(len);
    ((raw << shift) as i64) >> shift
}

/// Physical value per §6.2 candidate semantics: interpret raw, then `* factor + offset`.
fn oracle_value(
    payload: &[u8],
    start: u16,
    len: u8,
    motorola: bool,
    vt: &str,
    factor: f64,
    offset: f64,
) -> f64 {
    let raw = oracle_raw(payload, start, len, motorola);
    let x = match vt {
        "unsigned" => raw as f64,
        "signed" => sign_extend(raw, len) as f64,
        "float32" => f64::from(f32::from_bits(raw as u32)),
        "float64" => f64::from_bits(raw),
        other => panic!("unknown value type {other}"),
    };
    x * factor + offset
}

fn pack(payload: &mut [u8; 64], start: u16, len: u8, motorola: bool, raw: u64) {
    span(start, len, motorola).pack_raw_u64(raw, payload);
}

/// DBC bit set (`byte*8 + bit`) of a candidate.
fn bit_set(start: u16, len: u8, motorola: bool) -> BTreeSet<u16> {
    trace_signal_bits(start, len, order(motorola))
        .unwrap_or_else(|e| panic!("trace_signal_bits({start},{len}): {e:?}"))
        .iter()
        .map(|&(b, k)| u16::from(b) * 8 + u16::from(k))
        .collect()
}

fn row_bits(row: &Value) -> BTreeSet<u16> {
    let c = &row["candidate"];
    bit_set(
        num(c, "startBit") as u16,
        num(c, "bitLength") as u8,
        st(c, "byteOrder") == "motorola",
    )
}

fn pearson(x: &[f64], y: &[f64]) -> f64 {
    let n = x.len() as f64;
    let mx = x.iter().sum::<f64>() / n;
    let my = y.iter().sum::<f64>() / n;
    let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
    for (a, b) in x.iter().zip(y) {
        sxy += (a - mx) * (b - my);
        sxx += (a - mx) * (a - mx);
        syy += (b - my) * (b - my);
    }
    sxy / (sxx * syy).sqrt()
}

// ─── Strict §6.3 series parser ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
struct Pt {
    t: u32,
    min: f64,
    max: f64,
}

#[derive(Debug)]
struct Ser {
    kind: u8,
    index: u8,
    pts: Vec<Pt>,
}

#[derive(Debug)]
struct Series {
    count: u8,
    points_max: u16,
    from_us: u64,
    series: Vec<Ser>,
}

impl Series {
    fn get(&self, kind: u8, index: u8) -> &Ser {
        let hits: Vec<&Ser> = self
            .series
            .iter()
            .filter(|s| s.kind == kind && s.index == index)
            .collect();
        assert_eq!(
            hits.len(),
            1,
            "expected exactly one series kind={kind} index={index}: {:?}",
            self.headers()
        );
        hits[0]
    }
    fn cand(&self, index: u8) -> &[Pt] {
        &self.get(0, index).pts
    }
    fn reference(&self) -> &[Pt] {
        &self.get(1, 0).pts
    }
    fn headers(&self) -> Vec<(u8, u8, usize)> {
        self.series
            .iter()
            .map(|s| (s.kind, s.index, s.pts.len()))
            .collect()
    }
}

fn parse_series(b: &[u8]) -> Result<Series, String> {
    if b.len() < 16 {
        return Err(format!("header truncated: {} bytes", b.len()));
    }
    if &b[0..4] != b"NRS1" {
        return Err(format!("bad magic {:02X?}", &b[0..4]));
    }
    let u16le = |o: usize| u16::from_le_bytes([b[o], b[o + 1]]);
    let u32le = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
    let f64le = |o: usize| f64::from_le_bytes(b[o..o + 8].try_into().expect("8 bytes"));
    if b[5] != 0 {
        return Err(format!(
            "header reserved byte = {} (encoder must write 0)",
            b[5]
        ));
    }
    let count = b[4];
    let points_max = u16le(6);
    let from_us = u64::from_le_bytes(b[8..16].try_into().expect("8 bytes"));
    let mut off = 16usize;
    let mut series = Vec::new();
    for s in 0..count {
        if off + 8 > b.len() {
            return Err(format!("series {s} header past end"));
        }
        let kind = b[off];
        let index = b[off + 1];
        if kind > 1 {
            return Err(format!("series {s} kind {kind} > 1"));
        }
        if u16le(off + 2) != 0 {
            return Err(format!("series {s} reserved u16 != 0"));
        }
        let n = u32le(off + 4) as usize;
        off += 8;
        if n > (b.len() - off) / 20 {
            return Err(format!("series {s}: pointCount {n} past end"));
        }
        let mut pts = Vec::with_capacity(n);
        for _ in 0..n {
            pts.push(Pt {
                t: u32le(off),
                min: f64le(off + 4),
                max: f64le(off + 12),
            });
            off += 20;
        }
        series.push(Ser { kind, index, pts });
    }
    if off != b.len() {
        return Err(format!(
            "{} trailing bytes after {count} series",
            b.len() - off
        ));
    }
    Ok(Series {
        count,
        points_max,
        from_us,
        series,
    })
}

/// Runs `series`, parses strictly and checks the structural invariants every response must hold.
fn run_series(a: &mut ReAnalyzer, req: &ReSeriesRequest) -> Series {
    let mut out = Vec::new();
    okv(a.series(req, &mut out), "series");
    let s = parse_series(&out).unwrap_or_else(|e| {
        panic!(
            "series bytes malformed: {e}\n{:02X?}",
            &out[..out.len().min(64)]
        )
    });
    assert_eq!(usize::from(s.count), s.series.len());
    let expect_count = req.candidates.len() + usize::from(req.reference.is_some());
    assert_eq!(
        usize::from(s.count),
        expect_count,
        "seriesCount = candidates + (reference ? 1 : 0)"
    );
    assert!(
        s.points_max <= req.max_points,
        "pointsMax {} > requested maxPoints {}",
        s.points_max,
        req.max_points
    );
    let mut seen = BTreeSet::new();
    for ser in &s.series {
        assert!(
            seen.insert((ser.kind, ser.index)),
            "duplicate series (kind {}, index {})",
            ser.kind,
            ser.index
        );
        assert!(
            ser.pts.len() <= usize::from(req.max_points),
            "pointCount {} > maxPoints {}",
            ser.pts.len(),
            req.max_points
        );
        assert!(
            ser.pts.len() <= usize::from(s.points_max),
            "pointCount {} > header pointsMax {}",
            ser.pts.len(),
            s.points_max
        );
        for w in ser.pts.windows(2) {
            assert!(
                w[0].t <= w[1].t,
                "series (kind {}, idx {}) not time-ordered: {:?}",
                ser.kind,
                ser.index,
                w
            );
        }
        for p in &ser.pts {
            if !p.min.is_nan() && !p.max.is_nan() {
                assert!(p.min <= p.max, "bucket min {} > max {}", p.min, p.max);
            }
        }
    }
    for i in 0..req.candidates.len() {
        let _ = s.get(0, i as u8);
    }
    if req.reference.is_some() {
        let _ = s.get(1, 0);
    }
    if let Some(f) = req.from_us {
        assert_eq!(s.from_us, f, "header fromUs must echo the requested fromUs");
    }
    s
}

fn series_err(a: &mut ReAnalyzer, req: &ReSeriesRequest) -> String {
    let mut out = Vec::new();
    err_code(a.series(req, &mut out), "series")
}

/// Asserts exact (non-decimated) series: one point per sample, min == max == value.
fn assert_exact(pts: &[Pt], from_us: u64, expected: &[(u64, f64)], ctx: &str) {
    assert_eq!(
        pts.len(),
        expected.len(),
        "{ctx}: point count (samples <= maxPoints must be exact)"
    );
    for (i, (p, &(ts, v))) in pts.iter().zip(expected).enumerate() {
        assert_eq!(u64::from(p.t) + from_us, ts, "{ctx}: point {i} time");
        assert!(
            p.min == v && p.max == v,
            "{ctx}: point {i} (ts {ts}) expected min=max={v}, got min={} max={}",
            p.min,
            p.max
        );
    }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Constants, oracle pin
// ═════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn r2a_qa_constants() {
    assert_eq!(MAX_RE_FOCUS, 8, "MAX_RE_FOCUS");
    assert_eq!(RE_FOCUS_DEPTH, 16_384, "RE_FOCUS_DEPTH");
    assert_eq!(FOCUS_SLOTS, 8);
    assert_eq!(DEPTH, 16_384);
}

#[test]
fn r2a_qa_oracle_pinned_by_hand() {
    // Motorola (DBC sawtooth) start 3 len 12: MSB = byte0 bit3 .. byte0 bit0, byte1 bit7 .. bit0 (LSB).
    let bits: Vec<(u8, u8)> = trace_signal_bits(3, 12, ByteOrder::BigEndian)
        .expect("trace")
        .to_vec();
    let mut want: Vec<(u8, u8)> = (0..8).map(|k| (1, k)).collect();
    want.extend((0..4).map(|k| (0, k)));
    assert_eq!(bits, want, "oracle Motorola sawtooth layout drifted");
    assert_eq!(oracle_raw(&[0x0A, 0xBC], 3, 12, true), 0xABC);
    assert_eq!(
        oracle_value(&[0x0A, 0xBC], 3, 12, true, "signed", 1.0, 0.0),
        -1348.0
    );
    // Intel start 6 len 12: byte0 bits 6..7, byte1, byte2 bits 0..1.
    assert_eq!(
        oracle_value(&[0xC0, 0xFF, 0x01], 6, 12, false, "signed", 1.0, 0.0),
        2047.0
    );
    assert_eq!(
        oracle_value(&[0x00, 0x00, 0x02], 6, 12, false, "signed", 1.0, 0.0),
        -2048.0
    );
    assert_eq!(
        oracle_value(&[0xC0, 0xFF, 0x03], 6, 12, false, "signed", 1.0, 0.0),
        -1.0
    );
    // Motorola start 15 len 16 == big-endian u16 of bytes 1..2.
    assert_eq!(oracle_raw(&[0, 0x12, 0x34], 15, 16, true), 0x1234);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6.1 Focus rings
// ═════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn r2a_qa_focus_set_eight_ok_nine_rejected_atomically() {
    let mut a = started();
    let eight: Vec<(u8, u32, bool)> = (0..8u32).map(|i| (0, 0x100 + i, false)).collect();
    let v = focus(&mut a, &eight);
    let ts = status_targets(&v);
    assert_eq!(ts.len(), 8, "focus_set result must list the 8 targets: {v}");
    for t in &ts {
        assert_eq!(num(t, "samples"), 0, "fresh ring has 0 samples: {t}");
        assert!(
            t["firstUs"].is_null() && t["lastUs"].is_null(),
            "fresh ring firstUs/lastUs null: {t}"
        );
        assert_eq!(
            t["auto"].as_bool(),
            Some(false),
            "explicit target auto=false: {t}"
        );
    }
    for i in 0..8u16 {
        a.ingest(&std_frame(
            0,
            0x100 + i,
            &[i as u8; 8],
            1_000 + u64::from(i),
        ));
    }
    let nine: Vec<ReTargetDto> = (0..9u32).map(|i| tgt(0, 0x200 + i, false)).collect();
    let code = err_code(a.focus_set(&nine), "focus_set(9 targets)");
    assert!(
        code == "invalid" || code == "focus_full",
        "9 targets: code {code} (expected invalid|focus_full)"
    );
    let after = j(&a.focus_status());
    assert_eq!(
        status_targets(&after).len(),
        8,
        "rejected focus_set must leave the previous set intact: {after}"
    );
    for i in 0..8u32 {
        assert_eq!(
            samples(&a, 0, 0x100 + i, false),
            1,
            "rejected focus_set wiped ring of 0x{:X}",
            0x100 + i
        );
    }
    assert!(
        focus_entry(&a, 0, 0x200, false).is_none(),
        "partially applied rejected set"
    );
    // Empty set is legal and clears.
    let v = focus(&mut a, &[]);
    assert!(status_targets(&v).is_empty(), "focus_set([]) clears: {v}");
}

#[test]
fn r2a_qa_focus_keyed_by_bus_ext_id_and_skips_error_frames() {
    let mut a = started();
    focus(&mut a, &[(0, 0x123, false), (1, 0x123, true)]);
    for i in 0..10u64 {
        a.ingest(&std_frame(0, 0x123, &[1; 8], 100 + i)); // counted (0, std)
        a.ingest(&std_frame(1, 0x123, &[2; 8], 100 + i)); // other bus, std -> not focused
        a.ingest(&ext_frame(0, 0x123, &[3; 8], 100 + i)); // ext on bus 0 -> not focused
        a.ingest(&ext_frame(1, 0x123, &[4; 8], 100 + i)); // counted (1, ext)
        let mut e = std_frame(0, 0x123, &[0xFF; 8], 100 + i);
        e.flags |= FLAG_ERROR;
        a.ingest(&e);
    }
    assert_eq!(
        samples(&a, 0, 0x123, false),
        10,
        "(bus0,std,0x123) must hold exactly its 10 data frames"
    );
    assert_eq!(
        samples(&a, 1, 0x123, true),
        10,
        "(bus1,ext,0x123) must hold exactly its 10 frames"
    );
    let e = focus_entry(&a, 0, 0x123, false).expect("entry");
    assert_eq!(
        (num(&e, "firstUs"), num(&e, "lastUs")),
        (100, 109),
        "firstUs/lastUs = frame timestamps"
    );
}

#[test]
fn r2a_qa_focus_requires_re_started() {
    let mut a = started();
    focus(&mut a, &[(0, 0x321, false)]);
    for i in 0..10u64 {
        a.ingest(&std_frame(0, 0x321, &[i as u8; 8], 10 + i));
    }
    let _ = a.stop();
    for i in 0..10u64 {
        a.ingest(&std_frame(0, 0x321, &[i as u8; 8], 100 + i));
    }
    assert_eq!(
        samples(&a, 0, 0x321, false),
        10,
        "RE stopped: focus ring must not ingest"
    );
    let _ = a.start(None);
    a.ingest(&std_frame(0, 0x321, &[0; 8], 500));
    assert_eq!(
        samples(&a, 0, 0x321, false),
        11,
        "RE restarted: ring resumes, previous samples kept"
    );
}

#[test]
fn r2a_qa_focus_reset_keeps_kept_targets_ring() {
    let mut a = started();
    let (ta, tb, tc) = (0x10u16, 0x20u16, 0x30u16);
    focus(&mut a, &[(0, ta.into(), false), (0, tb.into(), false)]);
    for i in 0..100u64 {
        a.ingest(&std_frame(
            0,
            ta,
            &[i as u8, 0, 0, 0, 0, 0, 0, 0],
            1_000 + i * 10,
        ));
    }
    for i in 0..50u64 {
        a.ingest(&std_frame(
            0,
            tb,
            &[i as u8, 7, 0, 0, 0, 0, 0, 0],
            2_000 + i * 10,
        ));
    }
    let c0 = || vec![cand(0, 8, "intel", "unsigned", 1.0, 0.0)];
    let before = run_series(
        &mut a,
        &sreq(
            tgt(0, tb.into(), false),
            c0(),
            None,
            Some(0),
            Some(10_000),
            4096,
        ),
    );
    let before_pts = before.cand(0).to_vec();
    assert_eq!(before_pts.len(), 50);

    let v = focus(&mut a, &[(0, tb.into(), false), (0, tc.into(), false)]);
    assert_eq!(status_targets(&v).len(), 2);
    assert!(
        focus_entry(&a, 0, ta.into(), false).is_none(),
        "dropped target still listed"
    );
    let eb = focus_entry(&a, 0, tb.into(), false).expect("kept target");
    assert_eq!(num(&eb, "samples"), 50, "kept target must keep its ring");
    assert_eq!((num(&eb, "firstUs"), num(&eb, "lastUs")), (2_000, 2_490));
    assert_eq!(
        samples(&a, 0, tc.into(), false),
        0,
        "new target starts empty"
    );
    let after = run_series(
        &mut a,
        &sreq(
            tgt(0, tb.into(), false),
            c0(),
            None,
            Some(0),
            Some(10_000),
            4096,
        ),
    );
    assert_eq!(
        after.cand(0),
        &before_pts[..],
        "kept target series changed across focus_set"
    );

    // Re-adding a dropped target gives it a fresh (empty) ring.
    focus(
        &mut a,
        &[
            (0, ta.into(), false),
            (0, tb.into(), false),
            (0, tc.into(), false),
        ],
    );
    assert_eq!(
        samples(&a, 0, ta.into(), false),
        0,
        "re-added target must not resurrect old samples"
    );
    assert_eq!(samples(&a, 0, tb.into(), false), 50);
}

#[test]
fn r2a_qa_focus_ring_wraps_at_16384_overwrite_oldest() {
    let mut a = started();
    focus(&mut a, &[(0, 0x456, false)]);
    let extra = 500usize;
    let n = DEPTH + extra;
    let ts = |i: usize| 1_000_000 + i as u64 * 100;
    for i in 0..n {
        let v = i as u16;
        a.ingest(&std_frame(
            0,
            0x456,
            &[v as u8, (v >> 8) as u8, 0xAA, 0, 0, 0, 0, 0],
            ts(i),
        ));
    }
    let e = focus_entry(&a, 0, 0x456, false).expect("entry");
    assert_eq!(
        num(&e, "samples"),
        DEPTH as u64,
        "ring holds exactly RE_FOCUS_DEPTH samples"
    );
    assert_eq!(
        num(&e, "firstUs"),
        ts(extra),
        "oldest retained = frame #{extra}"
    );
    assert_eq!(num(&e, "lastUs"), ts(n - 1));
    let c = || vec![cand(0, 16, "intel", "unsigned", 1.0, 0.0)];
    // Overwritten window -> no points.
    let gone = run_series(
        &mut a,
        &sreq(
            tgt(0, 0x456, false),
            c(),
            None,
            Some(ts(0)),
            Some(ts(extra - 1)),
            4096,
        ),
    );
    assert!(
        gone.cand(0).is_empty(),
        "overwritten samples still returned: {} points",
        gone.cand(0).len()
    );
    // First 4096 retained samples, exact.
    let from = ts(extra);
    let s = run_series(
        &mut a,
        &sreq(
            tgt(0, 0x456, false),
            c(),
            None,
            Some(from),
            Some(ts(extra + 4095)),
            4096,
        ),
    );
    let want: Vec<(u64, f64)> = (extra..extra + 4096).map(|i| (ts(i), i as f64)).collect();
    assert_exact(s.cand(0), from, &want, "ring after wrap, oldest window");
    // Newest 16 samples.
    let from = ts(n - 16);
    let s = run_series(
        &mut a,
        &sreq(
            tgt(0, 0x456, false),
            c(),
            None,
            Some(from),
            Some(ts(n - 1)),
            16,
        ),
    );
    let want: Vec<(u64, f64)> = (n - 16..n).map(|i| (ts(i), i as f64)).collect();
    assert_exact(s.cand(0), from, &want, "ring after wrap, newest window");
}

#[test]
fn r2a_qa_focus_ring_alloc_once_zero_alloc_ingest() {
    let mut a = started();
    let ids: Vec<u16> = (0..8u16).map(|i| 0x500 + i).collect();
    // Warm-up BEFORE focus: creates RE rows (row creation may allocate) for focused + unfocused IDs.
    for &id in &ids {
        a.ingest(&std_frame(0, id, &[0; 8], 1));
    }
    a.ingest(&std_frame(0, 0x600, &[0; 8], 1));
    a.ingest(&fd_frame(0, 0x601, &[0; 64], 1));
    let targets: Vec<(u8, u32, bool)> = ids.iter().map(|&i| (0, u32::from(i), false)).collect();
    let (_, bytes_set) = count_allocs(|| {
        focus(&mut a, &targets);
    });
    eprintln!("focus_set(8) allocated {bytes_set} bytes");
    assert!(
        bytes_set >= (FOCUS_SLOTS * DEPTH * 64) as u64,
        "focus_set(8) allocated only {bytes_set} B: rings must be preallocated at focus time \
         (8 x 16384 x >=64 B payload), not lazily on the first frame"
    );
    let mut rng = Lcg(42);
    // Each focused ID gets 1/10 of the frames -> > RE_FOCUS_DEPTH each (forces a wrap).
    let total = 10 * DEPTH + 640;
    let mut frames = Vec::with_capacity(total);
    for i in 0..total {
        let mut d = [0u8; 8];
        rng.fill(&mut d);
        let ts = 10 + i as u64 * 20;
        frames.push(match i % 10 {
            8 => std_frame(0, 0x600, &d, ts),
            9 => fd_frame(0, 0x601, &[d[0]; 64], ts),
            k => std_frame(0, ids[k % 8], &d, ts),
        });
    }
    let (n, b) = count_allocs(|| {
        for f in &frames {
            a.ingest(f);
        }
    });
    assert_eq!(n, 0, "ingest with 8 focused rings allocated {n} times ({b} B) — rings incl. wrap must be alloc-free");
    for &id in &ids {
        assert!(
            samples(&a, 0, id.into(), false) > 0,
            "focused 0x{id:X} received nothing"
        );
    }
    // Wrapped at least once for the hot targets.
    assert_eq!(samples(&a, 0, ids[0].into(), false), DEPTH as u64);
    // Re-setting the identical set must not reallocate rings.
    let (_, bytes_same) = count_allocs(|| {
        focus(&mut a, &targets);
    });
    assert!(
        bytes_same < 64 * 1024,
        "identical focus_set re-allocated {bytes_same} B (kept targets keep their ring)"
    );
    assert_eq!(
        samples(&a, 0, ids[0].into(), false),
        DEPTH as u64,
        "identical re-set lost samples"
    );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6.3 Series values
// ═════════════════════════════════════════════════════════════════════════════════════════════

/// Edge values for a 12-bit signed field followed by pseudo-random ones.
fn signed12_values(n: usize, seed: u32) -> Vec<i64> {
    let mut v = vec![-2048, -2047, -1348, -1, 0, 1, 2046, 2047];
    let mut r = Lcg(seed);
    while v.len() < n {
        let x = u64::from((u16::from(r.next_u8()) << 4) | u16::from(r.next_u8() & 0x0F));
        v.push(sign_extend(x, 12));
    }
    v
}

#[test]
fn r2a_qa_series_exact_intel_motorola_12bit_signed_across_bytes() {
    let mut a = started();
    let id = 0x2A0u16;
    focus(&mut a, &[(0, id.into(), false)]);
    // c0 Intel  @1- start 6  len 12 : bytes 0..2
    // c1 Moto   @0- start 35 len 12 : byte4 bits3..0 + byte5
    // c2 Moto   @0- start 31 len 12 : byte3 + byte4 bits7..4
    // c3 Moto   @0+ start 55 len 16 : bytes 6..7 (unsigned control)
    let specs: [(u16, u8, bool, &str, f64, f64); 4] = [
        (6, 12, false, "signed", 0.5, -10.0),
        (35, 12, true, "signed", 1.0, 0.0),
        (31, 12, true, "signed", 0.25, 3.0),
        (55, 16, true, "unsigned", 1.0, 0.0),
    ];
    let n = 200usize;
    let v0 = signed12_values(n, 1);
    let v1 = signed12_values(n, 2);
    let v2: Vec<i64> = signed12_values(n, 3).into_iter().rev().collect();
    let mut rng = Lcg(77);
    let mut payloads = Vec::new();
    for i in 0..n {
        let mut p = [0u8; 64];
        rng.fill(&mut p[..8]);
        pack(&mut p, 6, 12, false, v0[i] as u64 & 0xFFF);
        pack(&mut p, 35, 12, true, v1[i] as u64 & 0xFFF);
        pack(&mut p, 31, 12, true, v2[i] as u64 & 0xFFF);
        assert_eq!(
            oracle_value(&p, 6, 12, false, "signed", 1.0, 0.0),
            v0[i] as f64,
            "fixture"
        );
        assert_eq!(
            oracle_value(&p, 35, 12, true, "signed", 1.0, 0.0),
            v1[i] as f64,
            "fixture"
        );
        assert_eq!(
            oracle_value(&p, 31, 12, true, "signed", 1.0, 0.0),
            v2[i] as f64,
            "fixture"
        );
        let ts = 10_000 + i as u64 * 1_000;
        a.ingest(&std_frame(0, id, &p[..8], ts));
        payloads.push((ts, p));
    }
    let cands: Vec<ReCandidateDto> = specs
        .iter()
        .map(|&(s, l, m, vt, f, o)| cand(s, l, if m { "motorola" } else { "intel" }, vt, f, o))
        .collect();
    let from = 5_000;
    let s = run_series(
        &mut a,
        &sreq(
            tgt(0, id.into(), false),
            cands,
            None,
            Some(from),
            Some(1_000_000),
            4096,
        ),
    );
    for (k, &(st_, l, m, vt, f, o)) in specs.iter().enumerate() {
        let want: Vec<(u64, f64)> = payloads
            .iter()
            .map(|(ts, p)| (*ts, oracle_value(p, st_, l, m, vt, f, o)))
            .collect();
        assert_exact(
            s.cand(k as u8),
            from,
            &want,
            &format!("candidate {k} (start {st_}, motorola {m}, {vt})"),
        );
    }
}

#[test]
fn r2a_qa_series_float32_float64_intel_and_motorola() {
    let mut a = started();
    focus(&mut a, &[(0, 0x2B0, false), (0, 0x2B1, false)]);
    let f32s: [f32; 8] = [
        1.5,
        -0.1,
        3.4e38,
        -0.0,
        1e-40,
        12_345.5,
        -7.25,
        f32::MIN_POSITIVE,
    ];
    let f64s: [f64; 8] = [
        1.5,
        -0.1,
        1e300,
        -0.0,
        5e-324,
        12_345.678_901_234,
        -7.25,
        f64::MAX,
    ];
    let mut want_le = Vec::new();
    let mut want_be = Vec::new();
    let mut want_64 = Vec::new();
    let mut want_64m = Vec::new();
    for (i, (&x, &y)) in f32s.iter().zip(f32s.iter().rev()).enumerate() {
        let mut d = [0u8; 8];
        d[0..4].copy_from_slice(&x.to_le_bytes()); // Intel start 0 len 32
        d[4..8].copy_from_slice(&y.to_be_bytes()); // Motorola start 39 len 32 (bytes 4..7 big-endian)
        assert_eq!(
            oracle_value(&d, 39, 32, true, "float32", 1.0, 0.0),
            f64::from(y),
            "oracle vs hand BE layout"
        );
        let ts = 100 + i as u64 * 10;
        a.ingest(&std_frame(0, 0x2B0, &d, ts));
        want_le.push((ts, f64::from(x)));
        want_be.push((ts, f64::from(y) * 2.0 + 1.0));
        // FD: f64 LE at bytes 8..15 (Intel start 64), f64 BE at bytes 56..63 (Motorola start 455).
        let mut e = [0x5Au8; 64];
        e[8..16].copy_from_slice(&f64s[i].to_le_bytes());
        e[56..64].copy_from_slice(&f64s[7 - i].to_be_bytes());
        assert_eq!(
            oracle_value(&e, 455, 64, true, "float64", 1.0, 0.0),
            f64s[7 - i],
            "oracle vs hand"
        );
        a.ingest(&fd_frame(0, 0x2B1, &e, ts));
        want_64.push((ts, f64s[i]));
        want_64m.push((ts, f64s[7 - i]));
    }
    let s = run_series(
        &mut a,
        &sreq(
            tgt(0, 0x2B0, false),
            vec![
                cand(0, 32, "intel", "float32", 1.0, 0.0),
                cand(39, 32, "motorola", "float32", 2.0, 1.0),
            ],
            None,
            Some(0),
            Some(10_000),
            64,
        ),
    );
    assert_exact(s.cand(0), 0, &want_le, "float32 Intel");
    assert_exact(
        s.cand(1),
        0,
        &want_be,
        "float32 Motorola (factor 2, offset 1)",
    );
    let s = run_series(
        &mut a,
        &sreq(
            tgt(0, 0x2B1, false),
            vec![
                cand(64, 64, "intel", "float64", 1.0, 0.0),
                cand(455, 64, "motorola", "float64", 1.0, 0.0),
            ],
            None,
            Some(0),
            Some(10_000),
            64,
        ),
    );
    assert_exact(s.cand(0), 0, &want_64, "float64 Intel (CAN-FD bytes 8..15)");
    assert_exact(
        s.cand(1),
        0,
        &want_64m,
        "float64 Motorola (CAN-FD bytes 56..63)",
    );
}

#[test]
fn r2a_qa_series_canfd_bits_above_63() {
    let mut a = started();
    let id = 0x2C0u16;
    focus(&mut a, &[(2, id.into(), false)]);
    let specs: [(u16, u8, bool, &str, f64, f64); 4] = [
        (500, 12, false, "signed", 1.0, 0.0), // bits 500..511 (byte62 hi nibble + byte63)
        (487, 16, true, "unsigned", 0.1, -5.0), // byte60 bit7 .. byte61 bit0
        (451, 12, true, "signed", 1.0, 0.0),  // byte56 bits3..0 + byte57
        (64, 64, false, "unsigned", 1.0, 0.0), // full u64 bytes 8..15 (values < 2^53 for exactness)
    ];
    let vals = signed12_values(64, 9);
    let mut rng = Lcg(3);
    let mut payloads = Vec::new();
    for (i, &v) in vals.iter().enumerate() {
        let mut p = [0u8; 64];
        rng.fill(&mut p);
        pack(&mut p, 500, 12, false, v as u64 & 0xFFF);
        pack(&mut p, 451, 12, true, ((-v) as u64) & 0xFFF);
        pack(&mut p, 64, 64, false, ((i as u64) << 40) | 0x1234_5678);
        let ts = 7_000 + i as u64 * 250;
        a.ingest(&fd_frame(2, id, &p, ts));
        payloads.push((ts, p));
    }
    assert_eq!(
        oracle_value(&payloads[0].1, 500, 12, false, "signed", 1.0, 0.0),
        -2048.0,
        "fixture"
    );
    let cands = specs
        .iter()
        .map(|&(s, l, m, vt, f, o)| cand(s, l, if m { "motorola" } else { "intel" }, vt, f, o))
        .collect();
    let s = run_series(
        &mut a,
        &sreq(
            tgt(2, id.into(), false),
            cands,
            None,
            Some(7_000),
            Some(100_000),
            4096,
        ),
    );
    for (k, &(st_, l, m, vt, f, o)) in specs.iter().enumerate() {
        let want: Vec<(u64, f64)> = payloads
            .iter()
            .map(|(ts, p)| (*ts, oracle_value(p, st_, l, m, vt, f, o)))
            .collect();
        assert_exact(
            s.cand(k as u8),
            7_000,
            &want,
            &format!("FD candidate {k} start {st_}"),
        );
    }
}

#[test]
fn r2a_qa_series_window_none_is_consistent() {
    let mut a = started();
    focus(&mut a, &[(0, 0x2D0, false)]);
    for i in 0..20u64 {
        a.ingest(&std_frame(0, 0x2D0, &[i as u8; 8], 50_000 + i * 3_000));
    }
    let s = run_series(
        &mut a,
        &sreq(
            tgt(0, 0x2D0, false),
            vec![cand(0, 8, "intel", "unsigned", 1.0, 0.0)],
            None,
            None,
            None,
            64,
        ),
    );
    assert!(
        s.from_us <= 50_000,
        "fromUs {} after the first sample",
        s.from_us
    );
    let want: Vec<(u64, f64)> = (0..20u64).map(|i| (50_000 + i * 3_000, i as f64)).collect();
    assert_exact(s.cand(0), s.from_us, &want, "window None = whole ring");
    // Inclusive window strictly inside: samples 5..=9 only.
    let s = run_series(
        &mut a,
        &sreq(
            tgt(0, 0x2D0, false),
            vec![cand(0, 8, "intel", "unsigned", 1.0, 0.0)],
            None,
            Some(64_000),
            Some(77_500),
            64,
        ),
    );
    let want: Vec<(u64, f64)> = (5..10u64).map(|i| (50_000 + i * 3_000, i as f64)).collect();
    assert_exact(s.cand(0), 64_000, &want, "explicit window filters samples");
}

#[test]
fn r2a_qa_series_decimation_buckets_exact_min_max() {
    let mut a = started();
    focus(&mut a, &[(0, 0x2E0, false)]);
    let n = 10_000usize;
    let ts = |i: usize| 1_000_000 + i as u64 * 100;
    let mut rng = Lcg(11);
    let mut noise = Vec::with_capacity(n);
    for i in 0..n {
        let r = rng.next_u8();
        noise.push(f64::from(r));
        let v = i as u16;
        a.ingest(&std_frame(
            0,
            0x2E0,
            &[v as u8, (v >> 8) as u8, r, 0, 0, 0, 0, 0],
            ts(i),
        ));
    }
    let from = ts(0) - 50;
    let to = ts(n - 1) + 50;
    let s = run_series(
        &mut a,
        &sreq(
            tgt(0, 0x2E0, false),
            vec![
                cand(0, 16, "intel", "unsigned", 1.0, 0.0),
                cand(16, 8, "intel", "unsigned", 1.0, 0.0),
            ],
            None,
            Some(from),
            Some(to),
            100,
        ),
    );
    let ramp = s.cand(0);
    let rnd = s.cand(1);
    assert!(ramp.len() <= 100, "{} points > maxPoints", ramp.len());
    assert!(
        ramp.len() >= 50,
        "decimation collapsed {n} uniform samples into {} points",
        ramp.len()
    );
    assert_eq!(
        ramp.len(),
        rnd.len(),
        "same samples -> same buckets for every candidate"
    );
    // Ramp value == sample index -> each bucket = a contiguous index run; runs partition all samples.
    assert_eq!(ramp[0].min, 0.0, "first bucket must start with sample 0");
    assert_eq!(
        ramp[ramp.len() - 1].max,
        (n - 1) as f64,
        "last bucket must end with the last sample"
    );
    for k in 0..ramp.len() {
        let (lo, hi) = (ramp[k].min as usize, ramp[k].max as usize);
        assert!(ramp[k].min.fract() == 0.0 && ramp[k].max.fract() == 0.0 && lo <= hi);
        if k + 1 < ramp.len() {
            assert_eq!(
                ramp[k + 1].min,
                ramp[k].max + 1.0,
                "buckets {k},{} not contiguous (gap/overlap)",
                k + 1
            );
            assert!(
                ramp[k].t < ramp[k + 1].t,
                "bucket times not strictly increasing"
            );
        }
        // Bucket time lies inside its own time span (bounded by neighbouring samples).
        let t_abs = from + u64::from(ramp[k].t);
        let lower = if lo == 0 { from } else { ts(lo - 1) + 1 };
        let upper = if hi + 1 == n { to } else { ts(hi + 1) };
        assert!(
            lower <= t_abs && t_abs <= upper,
            "bucket {k} time {t_abs} outside [{lower}, {upper}]"
        );
        assert_eq!(
            rnd[k].t, ramp[k].t,
            "bucket {k} time differs between candidates"
        );
        let run = &noise[lo..=hi];
        let mn = run.iter().copied().fold(f64::INFINITY, f64::min);
        let mx = run.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        assert!(
            rnd[k].min == mn && rnd[k].max == mx,
            "bucket {k} (samples {lo}..={hi}): expected min {mn} max {mx}, got {} {}",
            rnd[k].min,
            rnd[k].max
        );
    }
}

#[test]
fn r2a_qa_series_max_points_boundaries() {
    let mut a = started();
    focus(&mut a, &[(0, 0x2F0, false)]);
    for i in 0..17u64 {
        a.ingest(&std_frame(0, 0x2F0, &[i as u8 * 3; 8], 1_000 + i * 1_000));
    }
    let c = || vec![cand(0, 8, "intel", "unsigned", 1.0, 0.0)];
    for bad in [0u16, 1, 15, 4097, 65_535] {
        let code = series_err(
            &mut a,
            &sreq(tgt(0, 0x2F0, false), c(), None, Some(0), Some(100_000), bad),
        );
        assert_eq!(code, "invalid", "maxPoints {bad} must be rejected");
    }
    // 16 samples with maxPoints 16 -> exact.
    let s = run_series(
        &mut a,
        &sreq(tgt(0, 0x2F0, false), c(), None, Some(0), Some(16_000), 16),
    );
    let want: Vec<(u64, f64)> = (0..16u64)
        .map(|i| (1_000 + i * 1_000, (i * 3) as f64))
        .collect();
    assert_exact(s.cand(0), 0, &want, "16 samples / maxPoints 16");
    // 17 samples with maxPoints 16 -> decimated, extremes preserved.
    let s = run_series(
        &mut a,
        &sreq(tgt(0, 0x2F0, false), c(), None, Some(0), Some(100_000), 16),
    );
    let p = s.cand(0);
    assert!(
        !p.is_empty() && p.len() <= 16,
        "17 samples / maxPoints 16 -> {} points",
        p.len()
    );
    assert_eq!(p.iter().map(|x| x.min).fold(f64::INFINITY, f64::min), 0.0);
    assert_eq!(
        p.iter().map(|x| x.max).fold(f64::NEG_INFINITY, f64::max),
        48.0
    );
    let _ = run_series(
        &mut a,
        &sreq(
            tgt(0, 0x2F0, false),
            c(),
            None,
            Some(0),
            Some(100_000),
            4096,
        ),
    );
}

#[test]
fn r2a_qa_series_rejects_bad_candidates() {
    let mut a = started();
    focus(&mut a, &[(0, 0x300, false)]);
    a.ingest(&std_frame(0, 0x300, &[1; 8], 10));
    let five: Vec<ReCandidateDto> = (0..5)
        .map(|i| cand(i * 8, 8, "intel", "unsigned", 1.0, 0.0))
        .collect();
    assert_eq!(
        series_err(
            &mut a,
            &sreq(tgt(0, 0x300, false), five, None, None, None, 64)
        ),
        "invalid",
        "5 candidates"
    );
    let bad: [(u16, u8, &str, &str, &str); 8] = [
        (0, 0, "intel", "unsigned", "bitLength 0"),
        (0, 65, "intel", "unsigned", "bitLength 65"),
        (512, 8, "intel", "unsigned", "startBit 512"),
        (500, 16, "intel", "unsigned", "Intel span past bit 511"),
        (
            503,
            24,
            "motorola",
            "unsigned",
            "Motorola span past byte 63",
        ),
        (0, 16, "intel", "float32", "float32 with bitLength 16"),
        (0, 32, "intel", "float64", "float64 with bitLength 32"),
        (0, 64, "intel", "float32", "float32 with bitLength 64"),
    ];
    for (s0, l, o, vt, what) in bad {
        let Some(c) = try_from::<ReCandidateDto>(cand_json(s0, l, o, vt, 1.0, 0.0)) else {
            continue; // rejected at the wire level: acceptable
        };
        let code = series_err(
            &mut a,
            &sreq(tgt(0, 0x300, false), vec![c], None, None, None, 64),
        );
        assert_eq!(code, "invalid", "{what} must be rejected");
    }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Errors: not started, focus_full, auto-focus
// ═════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn r2a_qa_not_started_errors() {
    let mut a = ReAnalyzer::new();
    let _ = a.focus_set(&[tgt(0, 0x10, false)]); // may or may not be accepted before start
    let code = series_err(
        &mut a,
        &sreq(
            tgt(0, 0x10, false),
            vec![cand(0, 8, "intel", "unsigned", 1.0, 0.0)],
            None,
            None,
            None,
            64,
        ),
    );
    assert_eq!(code, "not_started", "series on a never-started analyzer");
    let r = a.correlate(&creq(
        tgt(0, 0x10, false),
        ref_cand(
            0,
            0x11,
            false,
            cand_json(0, 8, "intel", "unsigned", 1.0, 0.0),
        ),
        None,
        None,
        search(0, 63, 1, 8, &["intel"], &[false]),
        10,
    ));
    expect_code(r, "not_started", "correlate on a never-started analyzer");
}

#[test]
fn r2a_qa_reference_auto_focus_and_focus_full() {
    let mut a = started();
    focus(&mut a, &[(0, 0x400, false)]);
    let rc = || {
        ref_cand(
            0,
            0x401,
            false,
            cand_json(0, 8, "intel", "unsigned", 1.0, 0.0),
        )
    };
    let c = || vec![cand(0, 8, "intel", "unsigned", 1.0, 0.0)];
    a.ingest(&std_frame(0, 0x400, &[1; 8], 100));
    a.ingest(&std_frame(0, 0x401, &[2; 8], 101));
    let mut out = Vec::new();
    let _ = a.series(
        &sreq(tgt(0, 0x400, false), c(), Some(rc()), None, None, 64),
        &mut out,
    ); // triggers auto-focus
    let e = focus_entry(&a, 0, 0x401, false).expect("reference ID must be auto-focused by series");
    assert_eq!(
        e["auto"].as_bool(),
        Some(true),
        "auto-focused reference must report auto=true: {e}"
    );
    assert_eq!(
        focus_entry(&a, 0, 0x400, false).expect("target")["auto"].as_bool(),
        Some(false)
    );
    for i in 0..5u64 {
        a.ingest(&std_frame(0, 0x400, &[10 + i as u8; 8], 1_000 + i * 100));
        a.ingest(&std_frame(0, 0x401, &[20 + i as u8; 8], 1_050 + i * 100));
    }
    let s = run_series(
        &mut a,
        &sreq(
            tgt(0, 0x400, false),
            c(),
            Some(rc()),
            Some(1_000),
            Some(2_000),
            64,
        ),
    );
    let want: Vec<(u64, f64)> = (0..5u64)
        .map(|i| (1_050 + i * 100, (20 + i) as f64))
        .collect();
    assert_exact(
        s.reference(),
        1_000,
        &want,
        "candidate reference series after auto-focus",
    );

    // focus_full: 8 explicit targets, reference on a 9th ID.
    let mut b = started();
    let eight: Vec<(u8, u32, bool)> = (0..8u32).map(|i| (0, 0x700 + i, false)).collect();
    focus(&mut b, &eight);
    b.ingest(&std_frame(0, 0x700, &[1; 8], 10));
    b.ingest(&std_frame(0, 0x7A0, &[1; 8], 11));
    let r9 = || {
        ref_cand(
            0,
            0x7A0,
            false,
            cand_json(0, 8, "intel", "unsigned", 1.0, 0.0),
        )
    };
    let code = series_err(
        &mut b,
        &sreq(tgt(0, 0x700, false), c(), Some(r9()), None, None, 64),
    );
    assert_eq!(code, "focus_full", "series: reference needs a 9th slot");
    let r = b.correlate(&creq(
        tgt(0, 0x700, false),
        r9(),
        None,
        None,
        search(0, 63, 1, 8, &["intel"], &[false]),
        5,
    ));
    expect_code(r, "focus_full", "correlate: reference needs a 9th slot");
    assert_eq!(
        status_targets(&j(&b.focus_status())).len(),
        8,
        "failed auto-focus must not evict a target"
    );
    // OBD reference whose responder row exists but no slot is free.
    b.ingest(&std_frame(
        0,
        0x7E8,
        &[0x04, 0x41, 0x0C, 0x1A, 0xF8, 0x55, 0x55, 0x55],
        20,
    ));
    let code = series_err(
        &mut b,
        &sreq(
            tgt(0, 0x700, false),
            c(),
            Some(ref_obd(0x0C, 0)),
            None,
            None,
            64,
        ),
    );
    assert_eq!(
        code, "focus_full",
        "series: OBD responder 0x7E8 needs a 9th slot"
    );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6.4 OBD-II reference
// ═════════════════════════════════════════════════════════════════════════════════════════════

/// Hand-derived vectors from the TS `PID_CATALOG` formulas (src/types/diagnostics.ts).
/// (pid, A, B, expected)
const OBD_TABLE: [(u8, u8, u8, f64); 12] = [
    (0x04, 0x80, 0x00, 50.196_078_431_372_55), // Engine Load      A/2.55          128/2.55
    (0x05, 0x7B, 0x00, 83.0),                  // Coolant Temp     A-40            123-40
    (0x0C, 0x1A, 0xF8, 1726.0),                // Engine RPM       (256A+B)/4      6904/4
    (0x0D, 0x3C, 0x00, 60.0),                  // Vehicle Speed    A
    (0x0F, 0x00, 0x00, -40.0),                 // Intake Air Temp  A-40
    (0x10, 0x12, 0x34, 46.6),                  // MAF              (256A+B)/100    4660/100
    (0x11, 0x33, 0x00, 20.0),                  // Throttle         A/2.55          51/2.55
    (0x2F, 0xCC, 0x00, 80.0),                  // Fuel Level       A/2.55          204/2.55
    (0x33, 0x65, 0x00, 101.0),                 // Baro             A
    (0x42, 0x30, 0x39, 12.345),                // Module Voltage   (256A+B)/1000   12345/1000
    (0x46, 0xFF, 0x00, 215.0),                 // Ambient Temp     A-40
    (0x5C, 0x5A, 0x00, 50.0),                  // Oil Temp         A-40
];

#[test]
fn r2a_qa_obd_pid_value_matches_catalog_table() {
    for &(pid, a, b, want) in &OBD_TABLE {
        let got = obd_pid_value(pid, &[a, b, 0xC3, 0xD4])
            .unwrap_or_else(|| panic!("PID 0x{pid:02X} unsupported"));
        assert!(
            (got - want).abs() <= 1e-9,
            "PID 0x{pid:02X} A={a:#04X} B={b:#04X}: got {got}, want {want}"
        );
    }
    // Extra boundary vectors.
    assert_eq!(obd_pid_value(0x0C, &[0xFF, 0xFF]), Some(16_383.75));
    assert_eq!(obd_pid_value(0x0C, &[0, 0]), Some(0.0));
    assert!((obd_pid_value(0x04, &[0xFF]).expect("0x04") - 100.0).abs() < 1e-9);
    // Too short -> None (never read out of bounds, never guess).
    assert_eq!(
        obd_pid_value(0x0C, &[0x1A]),
        None,
        "2-byte PID with 1 data byte"
    );
    assert_eq!(obd_pid_value(0x05, &[]), None, "1-byte PID with no data");
    assert_eq!(obd_pid_value(0x42, &[0x30]), None);
}

/// The Rust PID list must be IDENTICAL to `PID_CATALOG` (contract §6.4) — parsed from the TS source.
#[test]
fn r2a_qa_obd_pid_list_identical_to_ts_catalog() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../src/types/diagnostics.ts"
    );
    let src = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let start = src
        .find("export const PID_CATALOG")
        .expect("PID_CATALOG in diagnostics.ts");
    let body = &src[start..];
    let end = body.find("\n];").expect("end of PID_CATALOG");
    let ts_pids: BTreeSet<u8> = body[..end]
        .match_indices("pid: 0x")
        .map(|(i, m)| {
            let hex: String = body[i + m.len()..]
                .chars()
                .take_while(char::is_ascii_hexdigit)
                .collect();
            u8::from_str_radix(&hex, 16).expect("hex pid")
        })
        .collect();
    let table_pids: BTreeSet<u8> = OBD_TABLE.iter().map(|x| x.0).collect();
    assert_eq!(
        ts_pids, table_pids,
        "QA OBD_TABLE out of sync with PID_CATALOG — update the table"
    );
    let rust_pids: BTreeSet<u8> = (0..=255u8)
        .filter(|&p| obd_pid_value(p, &[0x80, 0x80, 0x80, 0x80]).is_some())
        .collect();
    assert_eq!(
        rust_pids, ts_pids,
        "obd_pid_value PID set must equal PID_CATALOG exactly"
    );
}

/// Mode-01 single-frame positive response with the ISO 15031-5 length byte (2 + data bytes).
fn obd_frame(bus: u8, id: u16, pid: u8, a: u8, b: u8, ts: u64) -> RawCanFrame {
    let len = if matches!(pid, 0x0C | 0x10 | 0x42) {
        4
    } else {
        3
    };
    std_frame(bus, id, &[len, 0x41, pid, a, b, 0x55, 0x55, 0x55], ts)
}

/// Scripted 0x7E8 traffic: RPM / speed / coolant responses + distractors. Returns (ts, value) per PID.
/// `(tsUs, expected physical value)` samples.
type Samples = Vec<(u64, f64)>;

fn script_obd(a: &mut ReAnalyzer, id: u16, bus: u8) -> (Samples, Samples, Samples) {
    let (mut rpm, mut spd, mut clt) = (Vec::new(), Vec::new(), Vec::new());
    for i in 0..20u64 {
        let t = 100_000 + i * 50_000;
        // RPM 0x0C: first is the reference vector 1A F8 -> 1726.
        let raw = if i == 0 {
            0x1AF8u16
        } else {
            0x0800 + (i as u16) * 0x123
        };
        a.ingest(&obd_frame(bus, id, 0x0C, (raw >> 8) as u8, raw as u8, t));
        rpm.push((t, f64::from(raw) / 4.0));
        a.ingest(&std_frame(
            bus,
            id,
            &[0x03, 0x41, 0x0D, 0x3C + i as u8, 0x55, 0x55, 0x55, 0x55],
            t + 10_000,
        ));
        spd.push((t + 10_000, f64::from(0x3C + i as u8)));
        a.ingest(&std_frame(
            bus,
            id,
            &[0x03, 0x41, 0x05, 0x7B - i as u8, 0, 0, 0, 0],
            t + 20_000,
        ));
        clt.push((t + 20_000, f64::from(0x7B - i as u8) - 40.0));
        // Distractors that must never become reference samples:
        a.ingest(&std_frame(
            bus,
            id,
            &[0x03, 0x7F, 0x01, 0x12, 0, 0, 0, 0],
            t + 30_000,
        )); // negative response
        a.ingest(&std_frame(
            bus,
            id,
            &[0x02, 0x41, 0x0C, 0xFF, 0xFF, 0, 0, 0],
            t + 31_000,
        )); // len too short for RPM
        a.ingest(&std_frame(
            bus,
            id,
            &[0x05, 0x62, 0x0C, 0x0D, 0xFF, 0xFF, 0, 0],
            t + 32_000,
        )); // UDS 0x22 reply
        a.ingest(&std_frame(
            bus,
            id,
            &[0x10, 0x14, 0x41, 0x0C, 0xEE, 0xEE, 0, 0],
            t + 33_000,
        )); // ISO-TP FF, not SF
        a.ingest(&std_frame(
            bus,
            0x7DF,
            &[0x02, 0x01, 0x0C, 0, 0, 0, 0, 0],
            t - 1_000,
        )); // request
    }
    (rpm, spd, clt)
}

#[test]
fn r2a_qa_obd_reference_series_rpm_speed_coolant_7e8() {
    let mut a = started();
    focus(&mut a, &[(0, 0x111, false), (0, 0x7E8, false)]);
    for i in 0..50u64 {
        a.ingest(&std_frame(0, 0x111, &[i as u8; 8], 90_000 + i * 20_000));
    }
    let (rpm, spd, clt) = script_obd(&mut a, 0x7E8, 0);
    let c = || vec![cand(0, 8, "intel", "unsigned", 1.0, 0.0)];
    for (pid, want, what) in [
        (0x0Cu8, &rpm, "RPM 0x0C"),
        (0x0D, &spd, "speed 0x0D"),
        (0x05, &clt, "coolant 0x05"),
    ] {
        let s = run_series(
            &mut a,
            &sreq(
                tgt(0, 0x111, false),
                c(),
                Some(ref_obd(pid, 0)),
                Some(0),
                Some(5_000_000),
                4096,
            ),
        );
        assert_exact(s.reference(), 0, want, what);
    }
    assert_eq!(
        rpm[0].1, 1726.0,
        "reference vector [04 41 0C 1A F8] = 1726 rpm"
    );
}

#[test]
fn r2a_qa_obd_reference_29bit_and_responder_range() {
    let mut a = started();
    focus(
        &mut a,
        &[
            (0, 0x111, false),
            (0, 0x18DA_F110, true),
            (0, 0x7EF, false),
            (0, 0x7F0, false),
        ],
    );
    a.ingest(&std_frame(0, 0x111, &[1; 8], 1));
    let mut want = Vec::new();
    for i in 0..10u64 {
        let t = 10_000 + i * 10_000;
        a.ingest(&ext_frame(
            0,
            0x18DA_F110,
            &[0x04, 0x41, 0x0C, 0x10 + i as u8, 0x00, 0xAA, 0xAA, 0xAA],
            t,
        ));
        want.push((t, f64::from(u16::from(0x10 + i as u8) << 8) / 4.0));
        // 29-bit request direction (tester -> ECU) must be ignored even if it looks like a response.
        a.ingest(&ext_frame(
            0,
            0x18DA_10F1,
            &[0x04, 0x41, 0x0C, 0xFF, 0xFF, 0, 0, 0],
            t + 1,
        ));
        // 0x7F0 is outside 0x7E8..=0x7EF.
        a.ingest(&obd_frame(0, 0x7F0, 0x0C, 0xEE, 0xEE, t + 2));
    }
    let c = || vec![cand(0, 8, "intel", "unsigned", 1.0, 0.0)];
    let s = run_series(
        &mut a,
        &sreq(
            tgt(0, 0x111, false),
            c(),
            Some(ref_obd(0x0C, 0)),
            Some(0),
            Some(1_000_000),
            4096,
        ),
    );
    assert_exact(
        s.reference(),
        0,
        &want,
        "29-bit 0x18DAF110 RPM responses (0x7F0 / 0x18DA10F1 ignored)",
    );
    // 0x7EF is inside the responder range.
    let mut b = started();
    focus(&mut b, &[(0, 0x111, false), (0, 0x7EF, false)]);
    b.ingest(&std_frame(0, 0x111, &[1; 8], 1));
    b.ingest(&obd_frame(0, 0x7EF, 0x0D, 99, 0, 5_000));
    let s = run_series(
        &mut b,
        &sreq(
            tgt(0, 0x111, false),
            c(),
            Some(ref_obd(0x0D, 0)),
            Some(0),
            Some(10_000),
            64,
        ),
    );
    assert_exact(
        s.reference(),
        0,
        &[(5_000, 99.0)],
        "0x7EF responder accepted",
    );
}

#[test]
fn r2a_qa_obd_no_reference() {
    let mut a = started();
    focus(
        &mut a,
        &[(0, 0x111, false), (0, 0x7E8, false), (1, 0x7E8, false)],
    );
    for i in 0..50u64 {
        a.ingest(&std_frame(0, 0x111, &[i as u8; 8], 1_000 + i * 1_000));
    }
    let c = || vec![cand(0, 8, "intel", "unsigned", 1.0, 0.0)];
    let s = || search(0, 7, 1, 8, &["intel"], &[false]);
    // 1. Nothing at all.
    assert_eq!(
        series_err(
            &mut a,
            &sreq(
                tgt(0, 0x111, false),
                c(),
                Some(ref_obd(0x0C, 0)),
                None,
                None,
                64
            )
        ),
        "no_reference"
    );
    expect_code(
        a.correlate(&creq(
            tgt(0, 0x111, false),
            ref_obd(0x0C, 0),
            None,
            None,
            s(),
            5,
        )),
        "no_reference",
        "correlate, no responses",
    );
    // 2. Only other PIDs / other bus / only requests.
    a.ingest(&obd_frame(0, 0x7E8, 0x0D, 10, 0, 10_000));
    a.ingest(&obd_frame(1, 0x7E8, 0x0C, 10, 0, 11_000));
    a.ingest(&std_frame(
        0,
        0x7DF,
        &[0x02, 0x01, 0x0C, 0, 0, 0, 0, 0],
        12_000,
    ));
    expect_code(
        a.correlate(&creq(
            tgt(0, 0x111, false),
            ref_obd(0x0C, 0),
            None,
            None,
            s(),
            5,
        )),
        "no_reference",
        "correlate, wrong pid/bus",
    );
    // 3. Valid responses, but outside the window.
    a.ingest(&obd_frame(0, 0x7E8, 0x0C, 10, 0, 40_000));
    a.ingest(&obd_frame(0, 0x7E8, 0x0C, 11, 0, 41_000));
    expect_code(
        a.correlate(&creq(
            tgt(0, 0x111, false),
            ref_obd(0x0C, 0),
            Some(0),
            Some(30_000),
            s(),
            5,
        )),
        "no_reference",
        "correlate, responses outside window",
    );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6.2 Correlation
// ═════════════════════════════════════════════════════════════════════════════════════════════

fn planted_raw(i: usize) -> u16 {
    let x = i as f64;
    (32_768.0 + 26_000.0 * (x * 0.037).sin() + 4_000.0 * (x * 0.21 + 1.0).sin()).round() as u16
}

const T_ID: u16 = 0x3A0;
const R_ID: u16 = 0x3B0;

/// Target 0x3A0: byte0 = counter in the high nibble, low nibble constant 0; bytes1..2 = planted
/// Motorola start 15 len 16 (unsigned); bytes 3..6 = noise; byte7 = XOR checksum of bytes 0..6.
/// Reference 0x3B0 (+1 ms): Intel 0/16 raw = planted raw(i - lag_frames), factor 0.25 offset -40.
fn plant(
    a: &mut ReAnalyzer,
    n: usize,
    lag_frames: usize,
    raw_fn: fn(usize) -> u16,
) -> Vec<(u64, f64)> {
    let mut rng = Lcg(2024);
    let mut refs = Vec::new();
    for i in 0..n {
        let t = 1_000_000 + i as u64 * 10_000;
        let mut p = [0u8; 64];
        p[0] = ((i % 16) as u8) << 4;
        pack(&mut p, 15, 16, true, u64::from(raw_fn(i)));
        rng.fill(&mut p[3..7]);
        p[7] = p[..7].iter().fold(0, |x, y| x ^ y);
        assert_eq!(
            u16::from_be_bytes([p[1], p[2]]),
            raw_fn(i),
            "fixture: Motorola 15/16 = BE bytes 1..2"
        );
        a.ingest(&std_frame(0, T_ID, &p[..8], t));
        if i >= lag_frames {
            let r = raw_fn(i - lag_frames);
            let mut q = [0u8; 8];
            q[..2].copy_from_slice(&r.to_le_bytes());
            rng.fill(&mut q[2..]);
            a.ingest(&std_frame(0, R_ID, &q, t + 1_000));
            refs.push((t + 1_000, f64::from(r) * 0.25 - 40.0));
        }
    }
    refs
}

fn planted_reference() -> ReReferenceDto {
    ref_cand(
        0,
        R_ID.into(),
        false,
        cand_json(0, 16, "intel", "unsigned", 0.25, -40.0),
    )
}

fn rows(v: &Value) -> Vec<Value> {
    v["rows"]
        .as_array()
        .unwrap_or_else(|| panic!("rows not an array: {v}"))
        .clone()
}

fn is_cand(row: &Value, start: u64, len: u64, ord: &str, vt: &str) -> bool {
    let c = &row["candidate"];
    num(c, "startBit") == start
        && num(c, "bitLength") == len
        && st(c, "byteOrder") == ord
        && st(c, "valueType") == vt
}

/// Invariants every correlation result must satisfy.
/// `bits = (bitFrom, bitTo)`, `lens = (min, max)` of the request's search.
fn assert_result_wellformed(v: &Value, top_n: usize, bits: (u16, u16), lens: (u64, u64)) {
    let (bf, bt) = bits;
    let (lmin, lmax) = lens;
    let rs = rows(v);
    assert!(rs.len() <= top_n, "{} rows > topN {top_n}", rs.len());
    let _ = num(v, "evaluated");
    let _ = num(v, "referenceSamples");
    let _ = fnum(v, "elapsedMs");
    assert!(v["truncated"].is_boolean(), "truncated must be a bool: {v}");
    for (i, r) in rs.iter().enumerate() {
        let rr = fnum(r, "r");
        assert!(
            rr.is_finite() && rr.abs() <= 1.0 + 1e-9,
            "row {i}: r = {rr}"
        );
        assert!(
            (fnum(r, "r2") - rr * rr).abs() < 1e-9,
            "row {i}: r2 != r^2 ({r})"
        );
        assert!(
            fnum(r, "rmse").is_finite() && fnum(r, "rmse") >= 0.0,
            "row {i}: rmse"
        );
        let lag = fnum(r, "lagMs");
        assert!(
            (-500.0..=500.0).contains(&lag) && (lag / 10.0).fract() == 0.0,
            "row {i}: lagMs {lag} not on the 10 ms grid within ±500"
        );
        assert!(num(r, "samples") > 0);
        let c = &r["candidate"];
        let len = num(c, "bitLength");
        assert!(
            (lmin..=lmax).contains(&len),
            "row {i}: bitLength {len} outside search lengths"
        );
        let bits = row_bits(r);
        assert!(
            bits.iter().all(|&b| (bf..=bt).contains(&b)),
            "row {i}: bits {bits:?} outside [{bf},{bt}]"
        );
        assert!(fnum(c, "factor").is_finite() && fnum(c, "offset").is_finite());
        if i > 0 {
            let (p, q) = (fnum(&rs[i - 1], "r").abs(), rr.abs());
            assert!(
                p >= q - 1e-12,
                "rows not sorted by |r| desc at {i}: {p} < {q}"
            );
            if (p - q).abs() <= 1e-12 {
                assert!(
                    num(&rs[i - 1]["candidate"], "bitLength") <= len,
                    "|r| tie must prefer shorter bitLength at {i}"
                );
            }
        }
    }
    // Dedupe: no row is a PROPER superset of a better-ranked row with |Δr| < 0.002, among rows
    // evaluated on the same sample count (R2a amendment 1: a credited lag can change `samples`,
    // and rank scores are only comparable on equal counts; wall-clock jitter on CI runners makes
    // the credited lag, and therefore `samples`, differ between nested fields).
    for (i, better) in rs.iter().enumerate() {
        let bb = row_bits(better);
        for worse in &rs[i + 1..] {
            let wb = row_bits(worse);
            if num(worse, "samples") == num(better, "samples")
                && wb.len() > bb.len()
                && wb.is_superset(&bb)
            {
                let d = (fnum(worse, "r").abs() - fnum(better, "r").abs()).abs();
                assert!(
                    d >= 0.002,
                    "dedupe: {} is a superset of better-ranked {} with |Δr| = {d}",
                    worse["candidate"],
                    better["candidate"]
                );
            }
        }
    }
}

#[test]
fn r2a_qa_correlate_recovers_planted_motorola_16bit() {
    let mut a = started();
    focus(&mut a, &[(0, T_ID.into(), false), (0, R_ID.into(), false)]);
    let n = 600;
    let refs = plant(&mut a, n, 0, planted_raw);
    let srch = || search(0, 31, 8, 20, &["intel", "motorola"], &[false, true]);
    let v = j(&okv(
        a.correlate(&creq(
            tgt(0, T_ID.into(), false),
            planted_reference(),
            None,
            None,
            srch(),
            20,
        )),
        "correlate",
    ));
    eprintln!(
        "planted: evaluated {} elapsed {} ms",
        v["evaluated"], v["elapsedMs"]
    );
    assert_result_wellformed(&v, 20, (0, 31), (8, 20));
    assert_eq!(
        v["truncated"].as_bool(),
        Some(false),
        "small search must not truncate: {v}"
    );
    assert_eq!(num(&v, "referenceSamples"), refs.len() as u64);
    let rs = rows(&v);
    assert!(!rs.is_empty(), "no rows");
    let top = &rs[0];
    assert!(
        is_cand(top, 15, 16, "motorola", "unsigned"),
        "top row must be Motorola 15|16 unsigned, got {}",
        top["candidate"]
    );
    assert!(fnum(top, "r") > 0.999, "r = {}", fnum(top, "r"));
    let c = &top["candidate"];
    assert!(
        (fnum(c, "factor") - 0.25).abs() <= 1e-6,
        "factor {} (want 0.25)",
        fnum(c, "factor")
    );
    assert!(
        (fnum(c, "offset") + 40.0).abs() <= 1e-6,
        "offset {} (want -40)",
        fnum(c, "offset")
    );
    assert!(fnum(top, "rmse") < 1e-6, "rmse {}", fnum(top, "rmse"));
    assert_eq!(
        fnum(top, "lagMs"),
        0.0,
        "exact relation at lag 0 -> lagMs 0"
    );
    assert_eq!(
        num(top, "samples"),
        refs.len() as u64,
        "every reference sample has a held target sample"
    );
    // Supersets over the constant-zero low nibble of byte0 (Motorola MSB at bits 0..3) carry IDENTICAL
    // values -> identical r -> must be deduped.
    for msb in 0..4u64 {
        let len = 16 + (msb + 1);
        assert!(
            !rs.iter()
                .any(|r| is_cand(r, msb, len, "motorola", "unsigned")),
            "superset Motorola {msb}|{len} not deduped"
        );
    }
    // Zero-variance candidates (entirely inside byte0 bits 0..3) skipped.
    let zero: BTreeSet<u16> = (0..4).collect();
    assert!(
        !rs.iter().any(|r| row_bits(r).is_subset(&zero)),
        "zero-variance candidate reported"
    );
}

#[test]
fn r2a_qa_correlate_zero_variance_target_yields_no_rows() {
    let mut a = started();
    focus(&mut a, &[(0, T_ID.into(), false), (0, R_ID.into(), false)]);
    for i in 0..300u64 {
        let t = 10_000 + i * 10_000;
        a.ingest(&std_frame(0, T_ID, &[0x5A, 0xA5, 0, 0xFF, 1, 2, 3, 4], t));
        let r = planted_raw(i as usize);
        a.ingest(&std_frame(
            0,
            R_ID,
            &[r as u8, (r >> 8) as u8, 0, 0, 0, 0, 0, 0],
            t + 1_000,
        ));
    }
    let srch = search(0, 63, 1, 16, &["intel", "motorola"], &[false, true]);
    let v = j(&okv(
        a.correlate(&creq(
            tgt(0, T_ID.into(), false),
            planted_reference(),
            None,
            None,
            srch,
            50,
        )),
        "correlate",
    ));
    assert!(
        rows(&v).is_empty(),
        "constant target: every candidate has zero variance -> no rows, got {}",
        v["rows"]
    );
}

#[test]
fn r2a_qa_correlate_planted_lag_120ms() {
    fn lag_raw(k: usize) -> u16 {
        let x = k as f64;
        let tau = std::f64::consts::TAU;
        (32_768.0 + 20_000.0 * (tau * x / 200.0).sin() + 8_000.0 * (tau * x / 331.0 + 0.7).sin())
            .round() as u16
    }
    let mut a = started();
    focus(&mut a, &[(0, T_ID.into(), false), (0, R_ID.into(), false)]);
    let refs = plant(&mut a, 1_000, 12, lag_raw); // reference = target delayed by 12 x 10 ms
    let srch = || search(0, 31, 8, 16, &["intel", "motorola"], &[false]);
    let v = j(&okv(
        a.correlate(&creq(
            tgt(0, T_ID.into(), false),
            planted_reference(),
            None,
            None,
            srch(),
            10,
        )),
        "correlate",
    ));
    assert_result_wellformed(&v, 10, (0, 31), (8, 16));
    assert_eq!(num(&v, "referenceSamples"), refs.len() as u64);
    let planted = bit_set(15, 16, true);
    let rs = rows(&v);
    // At lag 0 an MSB-aligned sub-field of the planted signal may legitimately outrank it (dedupe keeps
    // the minimal field); accept any field holding the planted MSB (bit 15), >= 8 bits, inside the planted bits.
    // (Single-byte Intel 8|8 == Motorola 15|8 carry identical bits/values, so either order is accepted.)
    let is_planted_family = |r: &Value| {
        let b = row_bits(r);
        b.len() >= 8 && b.contains(&15) && b.is_subset(&planted)
    };
    assert!(
        !rs.is_empty() && is_planted_family(&rs[0]),
        "top row must be the planted signal (family), got {:?}",
        rs.first().map(|r| &r["candidate"])
    );
    let lag = fnum(&rs[0], "lagMs");
    eprintln!("planted lag 120 ms -> lagMs {lag} (sign convention: see report)");
    assert!(
        (110.0..=130.0).contains(&lag.abs()),
        "lagMs {lag}: |lag| must be 120 ± 10"
    );
    assert!(
        fnum(&rs[0], "r") > 0.999,
        "r must be recomputed at the best lag: {}",
        fnum(&rs[0], "r")
    );
}

/// (id, tsUs, value) per marker.
type Marks = Vec<(u32, u64, f64)>;

/// (raw byte-2 level, marker value) per segment: raw = 43 * v - 86. No signed/unsigned sub-field of the
/// byte (nor the signed byte) is exactly linear in v, so the planted byte is the unique r == 1 field.
const MARKER_LEVELS: [(u8, f64); 4] = [(43, 3.0), (129, 5.0), (0, 2.0), (86, 4.0)];

/// Markers reference: step function. Frames are generated in real time so marker timestamps and frame
/// timestamps share the clock whether `mark()` uses the monotonic clock or the last frame timestamp.
/// `per_seg` target frames per level segment, `gap` real-time sleep between frames.
fn markers_scenario(per_seg: usize, gap: Duration) -> (ReAnalyzer, Marks, Vec<(u64, u8)>) {
    let levels = MARKER_LEVELS;
    let mut a = started();
    focus(&mut a, &[(0, 0x3C0, false)]);
    let pre_raw = 200u8;
    let mut rng = Lcg(5);
    let mut frames = Vec::new();
    let mut marks = Vec::new();
    let _ = now_monotonic_us();
    std::thread::sleep(Duration::from_millis(5));
    for seg in 0..=levels.len() {
        if seg > 0 {
            std::thread::sleep(Duration::from_millis(2));
            a.ingest(&std_frame(0, 0x3C1, &[0; 8], now_monotonic_us())); // dummy (non-target) frame
            let m = a.mark(&format!("level {seg}"));
            marks.push((m.id, m.ts_us, levels[seg - 1].1));
            std::thread::sleep(Duration::from_millis(2));
        }
        let raw = if seg == 0 { pre_raw } else { levels[seg - 1].0 };
        for _ in 0..per_seg {
            let mut d = [0u8; 8];
            rng.fill(&mut d);
            d[2] = raw;
            let ts = now_monotonic_us();
            a.ingest(&std_frame(0, 0x3C0, &d, ts));
            frames.push((ts, raw));
            std::thread::sleep(gap);
        }
    }
    (a, marks, frames)
}

fn step_at(marks: &[(u32, u64, f64)], t: u64) -> Option<f64> {
    marks
        .iter()
        .filter(|m| m.1 <= t)
        .max_by_key(|m| m.1)
        .map(|m| m.2)
}

#[test]
fn r2a_qa_markers_reference_step_function_series() {
    let (mut a, marks, frames) = markers_scenario(30, Duration::from_micros(300));
    for w in marks.windows(2) {
        assert!(
            w[0].1 < w[1].1,
            "fixture: marker timestamps must be distinct and increasing: {marks:?}"
        );
    }
    let pts: Vec<(u32, f64)> = marks.iter().map(|m| (m.0, m.2)).collect();
    let from = frames[0].0;
    let to = frames[frames.len() - 1].0 + 1;
    let s = run_series(
        &mut a,
        &sreq(
            tgt(0, 0x3C0, false),
            vec![cand(16, 8, "intel", "unsigned", 1.0, 0.0)],
            Some(ref_markers(&pts)),
            Some(from),
            Some(to),
            4096,
        ),
    );
    let r = s.reference();
    assert!(
        r.len() >= 2,
        "markers reference series has {} points",
        r.len()
    );
    let mut seen = BTreeSet::new();
    for (i, p) in r.iter().enumerate() {
        let t = from + u64::from(p.t);
        let want = step_at(&marks, t).unwrap_or_else(|| {
            panic!(
                "reference point {i} at {t} precedes the first marker {}",
                marks[0].1
            )
        });
        assert!(
            p.min == want && p.max == want,
            "reference point {i} at {t}: step value {want}, got {}..{}",
            p.min,
            p.max
        );
        seen.insert(want.to_bits());
    }
    assert!(
        seen.len() >= 3,
        "step function should expose >= 3 marker levels, saw {}",
        seen.len()
    );
    // Candidate series unaffected by the reference.
    let want: Vec<(u64, f64)> = frames.iter().map(|&(t, raw)| (t, f64::from(raw))).collect();
    assert_exact(
        s.cand(0),
        from,
        &want,
        "candidate next to a markers reference",
    );
}

#[test]
fn r2a_qa_markers_reference_correlation_and_validation() {
    // Realistic marker spacing: each level segment (~600 ms) is longer than the ±500 ms lag search.
    let (mut a, marks, _frames) = markers_scenario(120, Duration::from_millis(5));
    let pts: Vec<(u32, f64)> = marks.iter().map(|m| (m.0, m.2)).collect();
    // Fixture sanity: no proper sub-field of byte 2 is EXACTLY linear in the levels (an exact tie would
    // let a shorter field outrank the planted byte). MSB sub-fields are near-linear (r ~ 0.9999) by
    // nature; that is fine: the planted byte has r == 1 and ranks first.
    let levels = [43u8, 129, 0, 86];
    let vals = [3.0, 5.0, 2.0, 4.0];
    for len in 1..=8u8 {
        for st0 in 16..=(24 - u16::from(len)) {
            for vt in ["unsigned", "signed"] {
                if len == 8 && vt == "unsigned" {
                    continue; // the planted field itself
                }
                let xs: Vec<f64> = levels
                    .iter()
                    .map(|&l| oracle_value(&[0, 0, l], st0, len, false, vt, 1.0, 0.0))
                    .collect();
                if xs.iter().all(|&x| x == xs[0]) {
                    continue;
                }
                assert!(
                    pearson(&xs, &vals).abs() < 1.0 - 1e-9,
                    "fixture bug: Intel {st0}|{len} {vt} exactly linear in levels"
                );
            }
        }
    }
    let srch = || search(0, 63, 1, 8, &["intel", "motorola"], &[false, true]);
    let v = j(&okv(
        a.correlate(&creq(
            tgt(0, 0x3C0, false),
            ref_markers(&pts),
            None,
            None,
            srch(),
            50,
        )),
        "correlate",
    ));
    assert_result_wellformed(&v, 50, (0, 63), (1, 8));
    let rs = rows(&v);
    let top = rs.first().unwrap_or_else(|| panic!("no rows: {v}"));
    assert!(
        is_cand(top, 16, 8, "intel", "unsigned") || is_cand(top, 23, 8, "motorola", "unsigned"),
        "top row must be byte 2 unsigned, got {}",
        top["candidate"]
    );
    assert!(fnum(top, "r") > 0.999);
    let c = &top["candidate"];
    assert!(
        (fnum(c, "factor") - 1.0 / 43.0).abs() <= 1e-6,
        "factor {}",
        fnum(c, "factor")
    );
    assert!(
        (fnum(c, "offset") - 2.0).abs() <= 1e-6,
        "offset {}",
        fnum(c, "offset")
    );

    // Validation: < 2 points, unknown marker id.
    let s1 = || search(0, 63, 1, 8, &["intel"], &[false]);
    let c0 = || vec![cand(16, 8, "intel", "unsigned", 1.0, 0.0)];
    for (bad, what) in [
        (vec![(marks[0].0, 1.0)], "1 point"),
        (vec![], "0 points"),
        (vec![(marks[0].0, 1.0), (999_999, 2.0)], "unknown markerId"),
    ] {
        expect_code(
            a.correlate(&creq(
                tgt(0, 0x3C0, false),
                ref_markers(&bad),
                None,
                None,
                s1(),
                5,
            )),
            "invalid",
            &format!("correlate markers {what}"),
        );
        assert_eq!(
            series_err(
                &mut a,
                &sreq(
                    tgt(0, 0x3C0, false),
                    c0(),
                    Some(ref_markers(&bad)),
                    None,
                    None,
                    64
                )
            ),
            "invalid",
            "series markers {what}"
        );
    }
}

#[test]
fn r2a_qa_correlate_rejects_bad_requests() {
    let mut a = started();
    focus(&mut a, &[(0, T_ID.into(), false), (0, R_ID.into(), false)]);
    let _ = plant(&mut a, 100, 0, planted_raw);
    let run = |a: &mut ReAnalyzer, s: Option<ReSearchDto>, top_n: u8, what: &str| {
        let Some(s) = s else { return }; // rejected at the wire level: acceptable
        expect_code(
            a.correlate(&creq(
                tgt(0, T_ID.into(), false),
                planted_reference(),
                None,
                None,
                s,
                top_n,
            )),
            "invalid",
            what,
        );
    };
    let ok = || Some(search(0, 31, 8, 16, &["intel"], &[false]));
    run(&mut a, ok(), 0, "topN 0");
    run(&mut a, ok(), 51, "topN 51");
    let sj = |bf: u16, bt: u16, l0: u8, l1: u8, o: Value, s: Value| {
        try_from::<ReSearchDto>(
            json!({ "bitFrom": bf, "bitTo": bt, "lengths": [l0, l1], "byteOrders": o, "signed": s }),
        )
    };
    run(
        &mut a,
        sj(0, 31, 0, 8, json!(["intel"]), json!([false])),
        5,
        "lengths min 0",
    );
    run(
        &mut a,
        sj(0, 31, 8, 33, json!(["intel"]), json!([false])),
        5,
        "lengths max 33",
    );
    run(
        &mut a,
        sj(0, 31, 9, 8, json!(["intel"]), json!([false])),
        5,
        "lengths min > max",
    );
    run(
        &mut a,
        sj(20, 10, 1, 8, json!(["intel"]), json!([false])),
        5,
        "bitFrom > bitTo",
    );
    run(
        &mut a,
        sj(0, 512, 1, 8, json!(["intel"]), json!([false])),
        5,
        "bitTo 512",
    );
    run(
        &mut a,
        sj(0, 31, 1, 8, json!([]), json!([false])),
        5,
        "empty byteOrders",
    );
    run(
        &mut a,
        sj(0, 31, 1, 8, json!(["intel"]), json!([])),
        5,
        "empty signed",
    );
    let bad_ref = ref_cand(
        0,
        R_ID.into(),
        false,
        cand_json(0, 0, "intel", "unsigned", 1.0, 0.0),
    );
    expect_code(
        a.correlate(&creq(
            tgt(0, T_ID.into(), false),
            bad_ref,
            None,
            None,
            search(0, 31, 8, 16, &["intel"], &[false]),
            5,
        )),
        "invalid",
        "reference candidate bitLength 0",
    );
    // Sanity: the valid request succeeds.
    okv(
        a.correlate(&creq(
            tgt(0, T_ID.into(), false),
            planted_reference(),
            None,
            None,
            search(0, 31, 8, 16, &["intel"], &[false]),
            5,
        )),
        "valid",
    );
}

#[test]
fn r2a_qa_full_classic_sweep_2000_samples_budget() {
    let mut a = started();
    focus(&mut a, &[(0, T_ID.into(), false), (0, R_ID.into(), false)]);
    let refs = plant(&mut a, 2_000, 0, planted_raw);
    assert_eq!(refs.len(), 2_000);
    let srch = || search(0, 63, 1, 32, &["intel", "motorola"], &[false, true]);
    let t0 = Instant::now();
    let v = j(&okv(
        a.correlate(&creq(
            tgt(0, T_ID.into(), false),
            planted_reference(),
            None,
            None,
            srch(),
            10,
        )),
        "correlate",
    ));
    let wall = t0.elapsed();
    let elapsed = fnum(&v, "elapsedMs");
    let truncated = v["truncated"].as_bool().expect("truncated bool");
    let evaluated = num(&v, "evaluated");
    eprintln!("full sweep: wall {wall:?}, elapsedMs {elapsed}, evaluated {evaluated}, truncated {truncated}");
    assert_result_wellformed(&v, 10, (0, 63), (1, 32));
    assert_eq!(num(&v, "referenceSamples"), 2_000);
    assert!(
        elapsed >= 0.0 && elapsed <= wall.as_secs_f64() * 1_000.0 + 50.0,
        "elapsedMs {elapsed} vs wall {wall:?}"
    );
    // Nominal sweep size: 64 starts x 32 lengths x 2 orders x 2 signedness = 8192 (out-of-frame spans excluded).
    assert!(
        evaluated <= 8_192,
        "evaluated {evaluated} > nominal sweep size"
    );
    assert!(
        wall < nexus_core::testing::scaled(Duration::from_millis(3_500)),
        "correlate ignored the 2 s budget: {wall:?}"
    );
    if truncated {
        assert!(
            elapsed >= 1_500.0,
            "truncated=true after only {elapsed} ms (budget is 2 s)"
        );
        assert!(evaluated < 8_192, "truncated but evaluated the whole sweep");
    } else {
        assert!(evaluated > 0);
        let top = &rows(&v)[0];
        assert!(
            is_cand(top, 15, 16, "motorola", "unsigned"),
            "full sweep top row {}",
            top["candidate"]
        );
    }
    if !cfg!(debug_assertions) {
        assert!(
            !truncated,
            "release: full classic sweep over 2000 samples must finish inside the budget"
        );
        assert!(
            wall < Duration::from_secs(2),
            "release: full sweep took {wall:?}"
        );
    }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Golden bytes shared with TS (backend writes tests/fixtures/re_series_golden.bin)
// ═════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn r2a_qa_series_golden_fixture_strict() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/re_series_golden.bin"
    );
    let bytes = std::fs::read(path).unwrap_or_else(|e| {
        panic!("golden fixture missing ({path}): {e} — backend-dev must produce it")
    });
    let s = parse_series(&bytes).unwrap_or_else(|e| panic!("golden fixture malformed: {e}"));
    assert!(
        s.series.iter().any(|x| x.kind == 0),
        "golden must contain a candidate series"
    );
    assert!(
        s.series.iter().any(|x| x.kind == 1),
        "golden must contain a reference series"
    );
    let all: Vec<&Pt> = s.series.iter().flat_map(|x| x.pts.iter()).collect();
    assert!(
        all.iter().any(|p| p.min == p.max),
        "golden must contain an exact point (min == max)"
    );
    assert!(
        all.iter().any(|p| p.min < p.max),
        "golden must contain a decimated bucket (min < max)"
    );
    assert!(
        all.iter().any(|p| p.min < 0.0),
        "golden must contain a negative (signed) value"
    );
    for ser in &s.series {
        assert!(
            ser.pts.len() <= usize::from(s.points_max),
            "pointCount > pointsMax in golden"
        );
        for w in ser.pts.windows(2) {
            assert!(w[0].t <= w[1].t, "golden series not time-ordered");
        }
    }
    let mut seen = BTreeSet::new();
    for ser in &s.series {
        assert!(
            seen.insert((ser.kind, ser.index)),
            "golden duplicate series"
        );
    }
    // Every strict prefix and any trailing byte must be rejected by the strict parser.
    for n in 0..bytes.len() {
        assert!(
            parse_series(&bytes[..n]).is_err(),
            "prefix of {n} bytes accepted"
        );
    }
    let mut t = bytes.clone();
    t.push(0);
    assert!(parse_series(&t).is_err(), "trailing byte accepted");
}
