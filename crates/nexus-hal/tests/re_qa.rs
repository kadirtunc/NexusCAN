//! QA gate probes for RE Toolkit R1 (planning/contracts/re-toolkit-v1.md §1, §2, §4).
//!
//! Written BEFORE the implementation, independent of backend-dev's own `re_` unit tests.
//! Run: `cargo test -p nexus-hal --test re_qa` (throughput assertion only in `--release`).
//!
//! ======================================================================================
//! API ASSUMPTION BLOCK (QA -> backend-dev: expose exactly these names)
//! ======================================================================================
//! ```text
//! use nexus_hal::pipeline::re_analyzer::{ReAnalyzer, RePhase, MAX_RE_ROWS};
//!
//! pub const MAX_RE_ROWS: usize = 2048;
//! pub enum RePhase { Idle, Free, Baseline, Action }            // serde: "idle"|"free"|"baseline"|"action"
//!
//! impl ReAnalyzer {
//!     pub fn new() -> Self;                                     // off: phase Idle, enabled=false, no rows
//!     pub fn start(&mut self, buses: Option<&[u8]>) -> ReStatusDto;   // None = all buses; phase -> Free
//!     pub fn stop(&mut self) -> ReStatusDto;                   // ingest paused, state kept
//!     pub fn reset(&mut self) -> ReStatusDto;                  // rows + markers cleared
//!     pub fn status(&self) -> ReStatusDto;
//!     pub fn set_phase(&mut self, phase: RePhase) -> ReStatusDto;     // Baseline clears baseline_active,
//!                                                                     // Action clears action_active
//!     pub fn ingest(&mut self, frame: &nexus_core::RawCanFrame);      // zero alloc for existing rows
//!     pub fn mark(&mut self, label: &str) -> ReMarkerDto;      // label truncated to 64 chars (char-safe)
//!     pub fn markers(&self) -> Vec<ReMarkerDto>;               // <= 1024, oldest dropped, oldest first
//!     pub fn row_detail(&self, bus: u8, arb_id: u32, is_ext: bool) -> Option<ReRowDetailDto>;
//!     pub fn classify(&self, bus: u8, arb_id: u32, is_ext: bool) -> Option<ReClassificationDto>;
//!     pub fn encode_snapshot(&mut self, out: &mut Vec<u8>, full: bool); // clears `out`, writes ONE
//!                                                                     // complete §2.2 snapshot, then marks
//!                                                                     // all emitted rows clean, seq += 1
//! }
//! ```
//! All DTOs (`ReStatusDto`, `ReMarkerDto`, `ReRowDetailDto`, `ReClassificationDto`, `ReFieldDto`)
//! implement `serde::Serialize` with `rename_all = "camelCase"` and enum values exactly as the TS
//! types in §2.1/§2.3 (`"crc8_j1850"`, `"motorola"`, ...). These probes read every DTO through
//! `serde_json::to_value` (the IPC wire shape), so Rust field / variant names are free.
//! ======================================================================================

use nexus_core::{flags::FLAG_ERROR, CanIdKey, RawCanFrame};
use nexus_hal::pipeline::re_analyzer::{ReAnalyzer, RePhase, MAX_RE_ROWS};
use serde::Serialize;
use serde_json::Value;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::collections::BTreeSet;
use std::time::Instant;

// ─── Thread-local counting allocator (only counts on a thread that armed it) ─────────────────

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

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_alloc();
        // SAFETY: forwarded verbatim to the system allocator.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_alloc();
        // SAFETY: forwarded verbatim to the system allocator.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record_alloc();
        // SAFETY: forwarded verbatim to the system allocator.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: forwarded verbatim to the system allocator.
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

// ─── Frame builders ───────────────────────────────────────────────────────────────────────────

fn std_frame(bus: u8, id: u16, data: &[u8], ts: u64) -> RawCanFrame {
    RawCanFrame::new_classical(bus, CanIdKey::new_standard(id).expect("std id"), data, ts)
        .expect("classic frame")
}

fn ext_frame(bus: u8, id: u32, data: &[u8], ts: u64) -> RawCanFrame {
    RawCanFrame::new_classical(bus, CanIdKey::new_extended(id).expect("ext id"), data, ts)
        .expect("classic ext frame")
}

fn fd_frame(bus: u8, key: CanIdKey, data: &[u8], ts: u64) -> RawCanFrame {
    RawCanFrame::new_fd(bus, key, data, false, ts).expect("fd frame")
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
}

// ─── JSON (wire-shape) accessors ──────────────────────────────────────────────────────────────

fn j<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).expect("DTO must serialize")
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

fn status(a: &ReAnalyzer) -> Value {
    j(&a.status())
}

fn detail(a: &ReAnalyzer, bus: u8, id: u32, ext: bool) -> Value {
    j(&a.row_detail(bus, id, ext)
        .unwrap_or_else(|| panic!("row_detail({bus}, 0x{id:X}, ext={ext}) returned None")))
}

fn toggles(d: &Value) -> Vec<u64> {
    d["toggles"]
        .as_array()
        .unwrap_or_else(|| panic!("toggles not an array: {d}"))
        .iter()
        .map(|x| x.as_u64().expect("toggle u64"))
        .collect()
}

/// Hex mask (2 chars per byte, byte 0 first) -> bytes. Case-insensitive.
fn hex_bytes(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "hex mask has odd length: {s:?}");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap_or_else(|_| panic!("bad hex {s:?}")))
        .collect()
}

fn mask_has_bit(mask: &[u8], bit: usize) -> bool {
    mask[bit / 8] & (1 << (bit % 8)) != 0
}

fn classify(a: &ReAnalyzer, bus: u8, id: u32, ext: bool) -> Value {
    let c = j(&a
        .classify(bus, id, ext)
        .unwrap_or_else(|| panic!("classify({bus}, 0x{id:X}, ext={ext}) returned None")));
    assert_fields_wellformed(&c);
    c
}

fn fields(c: &Value) -> Vec<Value> {
    c["fields"]
        .as_array()
        .unwrap_or_else(|| panic!("fields not an array: {c}"))
        .clone()
}

/// DBC bit set of a field: Intel = startBit..startBit+len (LSB first); Motorola = DBC sawtooth from
/// the MSB (`startBit`), i.e. b -> b-1 inside a byte, b%8==0 -> b+15.
fn field_bits(f: &Value) -> Vec<usize> {
    let start = num(f, "startBit") as usize;
    let len = num(f, "bitLength") as usize;
    assert!(len >= 1, "bitLength 0 in {f}");
    match st(f, "byteOrder").as_str() {
        "intel" => (start..start + len).collect(),
        "motorola" => {
            let mut out = Vec::with_capacity(len);
            let mut b = start;
            for i in 0..len {
                out.push(b);
                if i + 1 < len {
                    b = if b.is_multiple_of(8) { b + 15 } else { b - 1 };
                }
            }
            out
        }
        other => panic!("byteOrder {other:?} not intel|motorola in {f}"),
    }
}

/// §2.3 invariants on every classification: entropy array size/range, fields sorted by startBit,
/// non-overlapping, inside dlcBytes*8, confidence in 0..1, kind in the closed set.
fn assert_fields_wellformed(c: &Value) {
    let ent = c["bitEntropy"]
        .as_array()
        .unwrap_or_else(|| panic!("bitEntropy missing: {c}"));
    let nbits = ent.len();
    assert!(
        nbits.is_multiple_of(8) && nbits <= 512,
        "bitEntropy len {nbits} not dlcBytes*8"
    );
    for (i, e) in ent.iter().enumerate() {
        let e = e.as_f64().expect("entropy f64");
        assert!(
            (0.0..=1.0 + 1e-9).contains(&e),
            "bitEntropy[{i}] = {e} outside 0..1"
        );
    }
    let mut prev_start: Option<u64> = None;
    let mut used = BTreeSet::new();
    for f in fields(c) {
        let s = num(&f, "startBit");
        if let Some(p) = prev_start {
            assert!(s >= p, "fields not sorted by startBit: {p} then {s} in {c}");
        }
        prev_start = Some(s);
        let kind = st(&f, "kind");
        assert!(
            ["constant", "counter", "checksum", "flag", "physical", "unknown"]
                .contains(&kind.as_str()),
            "unknown kind {kind:?}"
        );
        let conf = fnum(&f, "confidence");
        assert!(
            (0.0..=1.0).contains(&conf),
            "confidence {conf} outside 0..1 in {f}"
        );
        for b in field_bits(&f) {
            assert!(b < nbits, "field bit {b} outside dlcBytes*8={nbits}: {f}");
            assert!(used.insert(b), "fields overlap at bit {b}: {c}");
        }
    }
}

fn find_field<'a>(fs: &'a [Value], kind: &str, start_bit: u64) -> Option<&'a Value> {
    fs.iter()
        .find(|f| f["kind"] == kind && f["startBit"] == start_bit)
}

// ─── Reference CRC oracles (test-side; used to build frames) ──────────────────────────────────

fn crc8(data: &[u8], poly: u8, init: u8, xorout: u8) -> u8 {
    let mut crc = init;
    for &b in data {
        crc ^= b;
        for _ in 0..8 {
            crc = if crc & 0x80 != 0 {
                (crc << 1) ^ poly
            } else {
                crc << 1
            };
        }
    }
    crc ^ xorout
}
fn crc8_j1850(d: &[u8]) -> u8 {
    crc8(d, 0x1D, 0xFF, 0xFF)
}
fn crc8_h2f(d: &[u8]) -> u8 {
    crc8(d, 0x2F, 0xFF, 0xFF)
}

// ─── Snapshot parser (test-side, strict) ──────────────────────────────────────────────────────

#[derive(Debug)]
struct SnapRow {
    bus: u8,
    flags: u8,
    dlc: u8,
    reserved: u8,
    arb_id: u32,
    rx_count: u32,
    heat: Vec<u8>,
    diff: Vec<u8>,
    constant: Vec<u8>,
    data: Vec<u8>,
}

#[derive(Debug)]
struct Snap {
    seq: u32,
    phase: u8,
    full: u8,
    row_count: u16,
    total_rows: u16,
    reserved: u16,
    rows: Vec<SnapRow>,
}

fn parse_snapshot(b: &[u8]) -> Result<Snap, String> {
    if b.len() < 24 {
        return Err(format!("header truncated: {} bytes", b.len()));
    }
    if &b[0..4] != b"NRE2" {
        return Err(format!("bad magic {:02X?}", &b[0..4]));
    }
    let u16le = |o: usize| u16::from_le_bytes([b[o], b[o + 1]]);
    let u32le = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
    let row_count = u16le(18);
    let mut rows = Vec::new();
    let mut off = 24usize;
    for r in 0..row_count {
        if off + 12 > b.len() {
            return Err(format!("row {r} header past end"));
        }
        let dlc = b[off + 2];
        if dlc > 64 {
            return Err(format!("row {r} dlcBytes {dlc} > 64"));
        }
        let d = usize::from(dlc);
        let end = off + 12 + d * 11;
        if end > b.len() {
            return Err(format!("row {r} payload past end"));
        }
        let p = off + 12;
        rows.push(SnapRow {
            bus: b[off],
            flags: b[off + 1],
            dlc,
            reserved: b[off + 3],
            arb_id: u32le(off + 4),
            rx_count: u32le(off + 8),
            heat: b[p..p + d * 8].to_vec(),
            diff: b[p + d * 8..p + d * 9].to_vec(),
            constant: b[p + d * 9..p + d * 10].to_vec(),
            data: b[p + d * 10..p + d * 11].to_vec(),
        });
        off = end;
    }
    if off != b.len() {
        return Err(format!(
            "{} trailing bytes after {row_count} rows",
            b.len() - off
        ));
    }
    Ok(Snap {
        seq: u32le(4),
        phase: b[16],
        full: b[17],
        row_count,
        total_rows: u16le(20),
        reserved: u16le(22),
        rows,
    })
}

fn snap(a: &mut ReAnalyzer, out: &mut Vec<u8>, full: bool) -> Snap {
    a.encode_snapshot(out, full);
    parse_snapshot(out).unwrap_or_else(|e| panic!("snapshot malformed: {e}\n{:02X?}", out))
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 Off by default / lifecycle
// ═════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn re_qa_off_by_default_ingest_changes_nothing() {
    let mut a = ReAnalyzer::new();
    let s0 = status(&a);
    assert_eq!(s0["enabled"], false, "new analyzer must be disabled: {s0}");
    assert_eq!(s0["phase"], "idle", "new analyzer phase must be idle: {s0}");
    assert_eq!(
        s0["startedAtUs"],
        Value::Null,
        "startedAtUs must be null before start: {s0}"
    );
    for i in 0..50u8 {
        a.ingest(&std_frame(
            0,
            0x123,
            &[i, !i, 0, 0, 0, 0, 0, 0],
            u64::from(i) * 1000,
        ));
    }
    let s1 = status(&a);
    assert_eq!(num(&s1, "rows"), 0, "ingest while off created rows: {s1}");
    assert_eq!(
        num(&s1, "framesIngested"),
        0,
        "ingest while off counted frames: {s1}"
    );
    assert!(
        a.row_detail(0, 0x123, false).is_none(),
        "row detail exists while off"
    );
    assert!(
        a.classify(0, 0x123, false).is_none(),
        "classify returns data while off"
    );

    let s2 = j(&a.start(None));
    assert_eq!(s2["enabled"], true, "start must enable: {s2}");
    assert_eq!(s2["phase"], "free", "start must enter `free` phase: {s2}");
    assert_eq!(
        num(&s2, "rows"),
        0,
        "frames ingested while off leaked in after start: {s2}"
    );
}

#[test]
fn re_qa_stop_keeps_state_reset_clears() {
    let mut a = started();
    for i in 0..10u8 {
        a.ingest(&std_frame(
            0,
            0x10,
            &[i & 1, 0, 0, 0, 0, 0, 0, 0],
            u64::from(i) * 10_000,
        ));
    }
    let _ = a.mark("before-stop");
    let before = detail(&a, 0, 0x10, false);
    assert_eq!(num(&before, "rxCount"), 10);
    assert_eq!(
        toggles(&before)[0],
        9,
        "bit0 alternates 10 frames -> 9 toggles"
    );

    let s = j(&a.stop());
    assert_eq!(s["enabled"], false, "stop must disable ingest: {s}");
    for i in 0..10u8 {
        a.ingest(&std_frame(
            0,
            0x10,
            &[0xFF, i, 0, 0, 0, 0, 0, 0],
            200_000 + u64::from(i),
        ));
        a.ingest(&std_frame(
            0,
            0x11,
            &[i, 0, 0, 0, 0, 0, 0, 0],
            200_000 + u64::from(i),
        ));
    }
    let after = detail(&a, 0, 0x10, false);
    assert_eq!(after, before, "stop must keep state and pause ingest");
    assert!(
        a.row_detail(0, 0x11, false).is_none(),
        "new row created while stopped"
    );
    assert_eq!(a.markers().len(), 1, "stop must keep markers");

    let r = j(&a.reset());
    assert_eq!(num(&r, "rows"), 0, "reset must clear rows: {r}");
    assert_eq!(
        num(&r, "overflowRows"),
        0,
        "reset must clear overflow count: {r}"
    );
    assert!(a.row_detail(0, 0x10, false).is_none(), "row survived reset");
    assert!(a.markers().is_empty(), "reset must clear markers");
}

#[test]
fn re_qa_bus_filter_and_row_identity() {
    let mut a = ReAnalyzer::new();
    let _ = a.start(Some(&[1]));
    a.ingest(&std_frame(0, 0x100, &[1; 8], 1));
    a.ingest(&std_frame(1, 0x100, &[1; 8], 2));
    a.ingest(&ext_frame(1, 0x100, &[1; 8], 3));
    a.ingest(&std_frame(2, 0x100, &[1; 8], 4));
    assert!(
        a.row_detail(0, 0x100, false).is_none(),
        "bus 0 not in filter but row created"
    );
    assert!(
        a.row_detail(2, 0x100, false).is_none(),
        "bus 2 not in filter but row created"
    );
    let s = detail(&a, 1, 0x100, false);
    let e = detail(&a, 1, 0x100, true);
    assert_eq!(s["isExtended"], false);
    assert_eq!(
        e["isExtended"], true,
        "std 0x100 and ext 0x100 must be distinct rows"
    );
    assert_eq!(num(&status(&a), "rows"), 2);

    // None = all buses.
    let mut b = started();
    for bus in [0u8, 1, 7, 255] {
        b.ingest(&std_frame(bus, 0x7FF, &[0; 8], 1));
    }
    assert_eq!(
        num(&status(&b), "rows"),
        4,
        "start(None) must accept every bus"
    );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1/§2 Toggle counting, bit numbering, CAN-FD 512 bits
// ═════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn re_qa_bit_numbering_is_intel_lsb_first() {
    let mut a = started();
    let seq: [[u8; 2]; 4] = [[0x01, 0x00], [0x00, 0x00], [0x80, 0x00], [0x00, 0x01]];
    for (i, b) in seq.iter().enumerate() {
        a.ingest(&std_frame(
            0,
            0x101,
            &[b[0], b[1], 0, 0, 0, 0, 0, 0],
            i as u64 * 1000,
        ));
    }
    let t = toggles(&detail(&a, 0, 0x101, false));
    assert_eq!(t.len(), 64, "8-byte frame -> 64 toggle entries");
    // 01->00: bit0; 00->80: bit7; 80->00: bit7; byte1 00->01: bit8.
    let mut want = vec![0u64; 64];
    want[0] = 1;
    want[7] = 2;
    want[8] = 1;
    assert_eq!(t, want, "bit = byte*8 + k, k=0 = LSB (Intel numbering)");
}

#[test]
fn re_qa_toggle_counts_exact_scripted() {
    let mut a = started();
    let mut rng = Lcg(0xC0FFEE);
    let mut frames: Vec<[u8; 8]> = Vec::new();
    for _ in 0..200 {
        let mut d = [0u8; 8];
        for (k, x) in d.iter_mut().enumerate() {
            // byte k changes with varying probability so counts differ per bit.
            *x = if k % 3 == 0 {
                rng.next_u8()
            } else {
                rng.next_u8() & (0x0F >> (k % 4))
            };
        }
        frames.push(d);
    }
    for (i, d) in frames.iter().enumerate() {
        a.ingest(&std_frame(3, 0x3A5, d, 1_000 + i as u64 * 500));
    }
    let mut want = vec![0u64; 64];
    for w in frames.windows(2) {
        for bit in 0..64 {
            if (w[0][bit / 8] ^ w[1][bit / 8]) & (1 << (bit % 8)) != 0 {
                want[bit] += 1;
            }
        }
    }
    let d = detail(&a, 3, 0x3A5, false);
    assert_eq!(
        toggles(&d),
        want,
        "toggle counts must equal XOR popcount per bit over consecutive frames"
    );
    assert_eq!(num(&d, "rxCount"), 200);
    assert_eq!(num(&d, "dlcBytes"), 8);
    assert_eq!(num(&d, "bus"), 3);
    assert_eq!(num(&d, "arbId"), 0x3A5);
    assert_eq!(num(&d, "firstUs"), 1_000);
    assert_eq!(num(&d, "lastUs"), 1_000 + 199 * 500);
    assert_eq!(num(&status(&a), "framesIngested"), 200);
}

#[test]
fn re_qa_fd_bit_511_and_dlc_growth_keeps_counts() {
    let mut a = started();
    let key = CanIdKey::new_extended(0x18DA_F110).expect("ext");
    // 5 classic 8-byte frames, bit0 alternating -> 4 toggles.
    for i in 0..5u8 {
        let mut d = [0u8; 8];
        d[0] = i & 1;
        d[7] = 0x80; // bit 63 constant 1
        a.ingest(&ext_frame(0, 0x18DA_F110, &d, u64::from(i) * 100));
    }
    let d8 = detail(&a, 0, 0x18DA_F110, true);
    assert_eq!(num(&d8, "dlcBytes"), 8);
    assert_eq!(toggles(&d8)[0], 4);

    // Grow to 64 bytes: new bytes are 0 on the growth frame (unambiguous under any prev policy),
    // bit0 continues to alternate (+1), bit63 stays 1.
    let mut d = [0u8; 64];
    d[0] = 1; // previous was 0 (i=4)
    d[7] = 0x80;
    a.ingest(&fd_frame(0, key, &d, 1_000));
    // Then toggle bit 511 (byte 63 bit 7) three times and bit 504 (byte 63 bit 0) once.
    for (n, b63) in [0x80u8, 0x00, 0x80, 0x81].iter().enumerate() {
        let mut e = d;
        e[63] = *b63;
        a.ingest(&fd_frame(0, key, &e, 2_000 + n as u64));
    }
    let dd = detail(&a, 0, 0x18DA_F110, true);
    assert_eq!(
        num(&dd, "dlcBytes"),
        64,
        "dlcBytes = max payload length seen"
    );
    let t = toggles(&dd);
    assert_eq!(t.len(), 512, "64-byte row -> 512 toggle entries");
    assert_eq!(t[0], 5, "bit0 count must survive DLC growth (4 + 1)");
    assert_eq!(t[63], 0, "bit63 constant across growth");
    assert_eq!(t[511], 3, "bit 511 (byte63 bit7) toggled 3 times");
    assert_eq!(t[504], 1, "bit 504 (byte63 bit0) toggled once");
    assert_eq!(
        t.iter().sum::<u64>(),
        5 + 3 + 1,
        "no phantom toggles in grown bytes"
    );
    assert_eq!(
        st(&dd, "constantMask").len(),
        128,
        "hex mask = 2 chars per byte for 64 bytes"
    );
    let cm = hex_bytes(&st(&dd, "constantMask"));
    assert!(!mask_has_bit(&cm, 511), "bit 511 changed -> not constant");
    assert!(mask_has_bit(&cm, 63), "bit 63 never changed -> constant");
    assert!(mask_has_bit(&cm, 300), "bit 300 never changed -> constant");
}

#[test]
fn re_qa_error_frames_ignored() {
    let mut a = started();
    for i in 0..3u8 {
        a.ingest(&std_frame(
            0,
            0x123,
            &[i & 1, 0, 0, 0, 0, 0, 0, 0],
            u64::from(i),
        ));
    }
    let before = detail(&a, 0, 0x123, false);
    let frames_before = num(&status(&a), "framesIngested");
    for i in 0..10u8 {
        let mut f = std_frame(
            0,
            0x123,
            &[0xFF, i, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF],
            100 + u64::from(i),
        );
        f.flags |= FLAG_ERROR;
        a.ingest(&f);
        let mut g = std_frame(0, 0x456, &[i; 8], 100 + u64::from(i));
        g.flags |= FLAG_ERROR;
        a.ingest(&g);
    }
    assert_eq!(
        detail(&a, 0, 0x123, false),
        before,
        "error frames must not touch an existing row"
    );
    assert!(
        a.row_detail(0, 0x456, false).is_none(),
        "error frame created an RE row"
    );
    assert_eq!(num(&status(&a), "rows"), 1);
    assert_eq!(
        num(&status(&a), "framesIngested"),
        frames_before,
        "error frames counted as ingested"
    );
}

#[test]
fn re_qa_history_ring_wraps_at_64() {
    let mut a = started();
    for i in 0..100u32 {
        a.ingest(&std_frame(
            0,
            0x50,
            &[i as u8, 0, 0, 0, 0, 0, 0, 0],
            5_000 + u64::from(i) * 10,
        ));
    }
    let d = detail(&a, 0, 0x50, false);
    assert_eq!(num(&d, "historyLen"), 64, "history ring capped at 64");
    assert_eq!(num(&d, "rxCount"), 100);
    assert_eq!(num(&d, "firstUs"), 5_000);
    assert_eq!(num(&d, "lastUs"), 5_000 + 990);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 Baseline / action diff, constant mask
// ═════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn re_qa_baseline_action_diff_semantics() {
    let mut a = started();
    let id = 0x2C0u16;
    let mut ts = 0u64;
    let mut push = |a: &mut ReAnalyzer, b0: u8| {
        ts += 10_000;
        a.ingest(&std_frame(0, id, &[b0, 0, 0, 0, 0, 0, 0, 0], ts));
    };
    // free phase: bit 5 toggles -> must NOT land in baseline nor action mask.
    for i in 0..5u8 {
        push(&mut a, (i & 1) << 5); // ends at 0x00 so the baseline starts from a clean byte
    }
    let _ = a.set_phase(RePhase::Baseline);
    assert_eq!(status(&a)["phase"], "baseline");
    // baseline: bit0 (A) toggles, bit1 (B) stays 0.
    for i in 0..6u8 {
        push(&mut a, i & 1);
    }
    let _ = a.set_phase(RePhase::Action);
    assert_eq!(status(&a)["phase"], "action");
    // action: A and B both toggle.
    for i in 0..6u8 {
        let x = i & 1;
        push(&mut a, x | (x << 1));
    }
    let d = detail(&a, 0, u32::from(id), false);
    let base = hex_bytes(&st(&d, "baselineMask"));
    let act = hex_bytes(&st(&d, "actionMask"));
    let diff = hex_bytes(&st(&d, "diffMask"));
    assert_eq!(base.len(), 8);
    assert!(
        mask_has_bit(&base, 0) && !mask_has_bit(&base, 1),
        "baseline mask = bit0 only: {base:02X?}"
    );
    assert!(
        !mask_has_bit(&base, 5),
        "free-phase toggles leaked into baseline mask"
    );
    assert!(
        mask_has_bit(&act, 0) && mask_has_bit(&act, 1),
        "action mask must hold bit0+bit1: {act:02X?}"
    );
    assert!(
        !mask_has_bit(&act, 5),
        "free-phase toggles leaked into action mask"
    );
    assert_eq!(
        diff,
        vec![0x02, 0, 0, 0, 0, 0, 0, 0],
        "diff = action & !baseline = bit1 only"
    );

    // Re-entering action clears action mask -> diff empty, baseline retained.
    let _ = a.set_phase(RePhase::Action);
    let d2 = detail(&a, 0, u32::from(id), false);
    assert_eq!(
        hex_bytes(&st(&d2, "actionMask")),
        vec![0; 8],
        "re-entering action must clear action mask"
    );
    assert_eq!(
        hex_bytes(&st(&d2, "diffMask")),
        vec![0; 8],
        "diff must be empty after action re-entry"
    );
    assert_eq!(
        hex_bytes(&st(&d2, "baselineMask")),
        base,
        "action re-entry must keep baseline"
    );
    // Toggles counts are NOT cleared by a phase change.
    assert_eq!(
        toggles(&d2)[0],
        toggles(&d)[0],
        "phase change must not reset toggle counts"
    );

    // Re-entering baseline clears baseline mask; then bit1 moving in action is diff again.
    let _ = a.set_phase(RePhase::Baseline);
    let d3 = detail(&a, 0, u32::from(id), false);
    assert_eq!(
        hex_bytes(&st(&d3, "baselineMask")),
        vec![0; 8],
        "re-entering baseline must clear it"
    );
    let _ = a.set_phase(RePhase::Action);
    // last frame was 0x03: keep bits 0/1 at 1 so only bit2 moves.
    for i in 0..4u8 {
        push(&mut a, 0x03 | ((i & 1) << 2));
    }
    let d4 = detail(&a, 0, u32::from(id), false);
    assert_eq!(
        hex_bytes(&st(&d4, "diffMask"))[0],
        0x04,
        "only bit2 in diff after rerun"
    );
}

#[test]
fn re_qa_constant_mask() {
    let mut a = started();
    // Single frame: every bit constant.
    a.ingest(&std_frame(0, 0x60, &[0xAA; 8], 1));
    assert_eq!(
        hex_bytes(&st(&detail(&a, 0, 0x60, false), "constantMask")),
        vec![0xFF; 8]
    );
    // byte0 bit0 flips; byte3 = 0x0F -> 0x0E -> 0x0F (bit 24 changes, back to start: still non-constant).
    a.ingest(&std_frame(
        0,
        0x60,
        &[0xAB, 0xAA, 0xAA, 0x0E, 0xAA, 0xAA, 0xAA, 0xAA],
        2,
    ));
    a.ingest(&std_frame(
        0,
        0x60,
        &[0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA],
        3,
    ));
    let cm = hex_bytes(&st(&detail(&a, 0, 0x60, false), "constantMask"));
    // 0xAA ^ 0x0E = 0xA4 -> bits 2,5,7 of byte3 changed.
    assert_eq!(
        cm,
        vec![0xFE, 0xFF, 0xFF, !0xA4, 0xFF, 0xFF, 0xFF, 0xFF],
        "constant = never changed since start"
    );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2.1 Markers
// ═════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn re_qa_markers_cap_1024_oldest_dropped() {
    let mut a = started();
    let mut ids = Vec::new();
    for i in 0..1030u32 {
        let m = j(&a.mark(&format!("m{i}")));
        assert_eq!(st(&m, "label"), format!("m{i}"));
        assert_eq!(m["phase"], "free", "marker carries current phase");
        ids.push(num(&m, "id"));
    }
    assert!(
        ids.windows(2).all(|w| w[1] > w[0]),
        "marker ids must be strictly increasing"
    );
    let ms: Vec<Value> = a.markers().iter().map(j).collect();
    assert_eq!(ms.len(), 1024, "markers capped at 1024");
    assert_eq!(
        st(&ms[0], "label"),
        "m6",
        "oldest 6 dropped, oldest-first order"
    );
    assert_eq!(st(&ms[1023], "label"), "m1029");
    assert_eq!(num(&ms[0], "id"), ids[6]);
    let _ = a.set_phase(RePhase::Action);
    assert_eq!(j(&a.mark("act"))["phase"], "action");
}

#[test]
fn re_qa_marker_label_over_64_chars_truncated_char_safe() {
    let mut a = started();
    let long = "x".repeat(100);
    let m = j(&a.mark(&long));
    let l = st(&m, "label");
    assert!(
        l.chars().count() <= 64,
        "label > 64 chars stored: {} chars",
        l.chars().count()
    );
    assert!(long.starts_with(&l), "truncation must keep a prefix");
    // Multi-byte chars: 2-byte UTF-8 'ş' x100 -> byte-slicing at 64 would split a char / panic.
    let tr = "ş".repeat(100);
    let m2 = j(&a.mark(&tr));
    let l2 = st(&m2, "label");
    assert!(
        l2.chars().count() <= 64 && tr.starts_with(&l2),
        "char-safe truncation failed: {l2:?}"
    );
    assert!(!l2.is_empty(), "truncation must not drop the whole label");
    // Exactly 64 chars preserved.
    let exact = "é".repeat(64);
    assert_eq!(
        st(&j(&a.mark(&exact)), "label"),
        exact,
        "a 64-char label must be kept verbatim"
    );
    let stored: Vec<Value> = a.markers().iter().map(j).collect();
    assert_eq!(
        st(&stored[0], "label"),
        l,
        "markers() returns the truncated label"
    );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 MAX_RE_ROWS overflow
// ═════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn re_qa_max_rows_overflow() {
    assert_eq!(MAX_RE_ROWS, 2048, "contract MAX_RE_ROWS = 2048");
    let mut a = started();
    for id in 0..MAX_RE_ROWS as u32 {
        a.ingest(&ext_frame(0, id, &[1, 2, 3, 4, 5, 6, 7, 8], u64::from(id)));
    }
    let s = status(&a);
    assert_eq!(num(&s, "rows"), 2048);
    assert_eq!(num(&s, "overflowRows"), 0);
    a.ingest(&ext_frame(0, 0x1ABC_DEF0, &[9; 8], 99_999));
    let s2 = status(&a);
    assert_eq!(num(&s2, "rows"), 2048, "row 2049 must not get RE state");
    assert_eq!(
        num(&s2, "overflowRows"),
        1,
        "row 2049 counted in overflowRows"
    );
    assert!(
        a.row_detail(0, 0x1ABC_DEF0, true).is_none(),
        "overflow row must have no detail"
    );
    assert!(
        a.classify(0, 0x1ABC_DEF0, true).is_none(),
        "overflow row must not classify"
    );
    // Existing rows keep working after overflow.
    a.ingest(&ext_frame(0, 5, &[0; 8], 100_000));
    assert_eq!(num(&detail(&a, 0, 5, true), "rxCount"), 2);
    // Reset frees the slots.
    let _ = a.reset();
    a.ingest(&ext_frame(0, 0x1ABC_DEF0, &[9; 8], 1));
    assert!(
        a.row_detail(0, 0x1ABC_DEF0, true).is_some(),
        "after reset a new row must fit"
    );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2.3 Classifier
// ═════════════════════════════════════════════════════════════════════════════════════════════

fn feed(a: &mut ReAnalyzer, id: u16, frames: &[[u8; 8]], period_us: u64) {
    for (i, d) in frames.iter().enumerate() {
        a.ingest(&std_frame(0, id, d, 1_000_000 + i as u64 * period_us));
    }
}

#[test]
fn re_qa_crc_oracle_vectors() {
    assert_eq!(crc8_j1850(b"123456789"), 0x4B, "SAE-J1850 check value");
    assert_eq!(crc8_h2f(b"123456789"), 0xDF, "AUTOSAR CRC8H2F check value");
}

#[test]
fn re_qa_classifier_under_16_samples_has_no_fields() {
    let mut a = started();
    let frames: Vec<[u8; 8]> = (0..15u8).map(|i| [i, 0, 0, 0, 0, 0, 0, 0]).collect();
    feed(&mut a, 0x70, &frames, 10_000);
    let c = classify(&a, 0, 0x70, false);
    assert_eq!(num(&c, "samples"), 15, "samples must be reported");
    assert!(
        fields(&c).is_empty(),
        "< 16 samples -> fields must be empty: {c}"
    );
    // 16th sample unlocks fields.
    a.ingest(&std_frame(
        0,
        0x70,
        &[15, 0, 0, 0, 0, 0, 0, 0],
        1_000_000 + 15 * 10_000,
    ));
    let c2 = classify(&a, 0, 0x70, false);
    assert_eq!(num(&c2, "samples"), 16);
    assert!(!fields(&c2).is_empty(), ">= 16 samples must produce fields");
}

#[test]
fn re_qa_classifier_nibble_counter_with_one_dropped_frame() {
    let mut a = started();
    let mut rng = Lcg(7);
    let mut frames = Vec::new();
    let mut ctr = 0u8;
    for i in 0..40 {
        if i == 20 {
            ctr = (ctr + 1) & 0x0F; // one dropped frame -> jump by 2
        }
        let mut d = [0u8; 8];
        d[0] = 0x50 | ctr;
        for x in d.iter_mut().skip(4) {
            *x = rng.next_u8();
        }
        frames.push(d);
        ctr = (ctr + 1) & 0x0F;
    }
    feed(&mut a, 0x71, &frames, 10_000);
    let c = classify(&a, 0, 0x71, false);
    let fs = fields(&c);
    let f = find_field(&fs, "counter", 0)
        .unwrap_or_else(|| panic!("4-bit counter at bit 0 not found: {c}"));
    assert_eq!(num(f, "bitLength"), 4, "nibble counter length 4: {f}");
    assert_eq!(num(f, "counterModulo"), 16, "{f}");
    assert_eq!(num(f, "counterStep"), 1, "{f}");
    // High nibble constant 0x5 -> entropy 0; LSB of counter -> entropy ~1.
    let ent = c["bitEntropy"].as_array().expect("entropy");
    assert_eq!(ent.len(), 64);
    assert!(
        ent[4].as_f64().unwrap_or(1.0) < 1e-9,
        "constant bit 4 entropy must be 0"
    );
    assert!(
        ent[0].as_f64().unwrap_or(0.0) > 0.9,
        "counter LSB entropy must be ~1"
    );
    let p = c["periodMs"]
        .as_f64()
        .expect("periodMs must be a number for a periodic row");
    assert!((p - 10.0).abs() < 0.5, "periodMs {p} != 10");
    let jit = c["jitterMs"].as_f64().expect("jitterMs number");
    assert!(
        jit < 0.5,
        "jitter {jit} too large for a perfectly periodic stream"
    );
}

#[test]
fn re_qa_classifier_8bit_counter_wraps_255_to_0() {
    let mut a = started();
    let frames: Vec<[u8; 8]> = (0..40u32)
        .map(|i| [0x11, 0x22, (240 + i) as u8, 0x33, 0, 0, 0, 0])
        .collect();
    feed(&mut a, 0x72, &frames, 20_000);
    let c = classify(&a, 0, 0x72, false);
    let fs = fields(&c);
    let f = find_field(&fs, "counter", 16)
        .unwrap_or_else(|| panic!("8-bit counter at bit 16 not found: {c}"));
    assert_eq!(
        num(f, "bitLength"),
        8,
        "widest counter must win over its low nibble: {f}"
    );
    assert_eq!(num(f, "counterModulo"), 256, "{f}");
    assert_eq!(num(f, "counterStep"), 1, "{f}");
}

/// Builds 40 frames: pseudo-random bytes,
/// checksum written at `ck_pos` by `ck` over the other bytes in index order.
fn checksum_frames(seed: u32, ck_pos: usize, ck: impl Fn(&[u8]) -> u8) -> Vec<[u8; 8]> {
    let mut rng = Lcg(seed);
    (0..40u8)
        .map(|_| {
            let mut d = [0u8; 8];
            for (k, x) in d.iter_mut().enumerate() {
                if k != ck_pos {
                    *x = rng.next_u8();
                }
            }
            let others: Vec<u8> = (0..8).filter(|&k| k != ck_pos).map(|k| d[k]).collect();
            d[ck_pos] = ck(&others);
            d
        })
        .collect()
}

fn assert_checksum(frames: &[[u8; 8]], id: u16, pos: usize, algo: &str) {
    let mut a = started();
    feed(&mut a, id, frames, 10_000);
    let c = classify(&a, 0, u32::from(id), false);
    let fs = fields(&c);
    let f = find_field(&fs, "checksum", pos as u64 * 8)
        .unwrap_or_else(|| panic!("{algo} checksum at byte {pos} not found: {c}"));
    assert_eq!(num(f, "bitLength"), 8, "{f}");
    assert_eq!(st(f, "checksumAlgo"), algo, "{f}");
}

#[test]
fn re_qa_classifier_xor8_checksum() {
    // XOR8 is position-symmetric (every byte is the XOR of the others), so only "some byte is an
    // xor8 checksum" is contract-decidable.
    let frames = checksum_frames(11, 7, |o| o.iter().fold(0, |x, b| x ^ b));
    let mut a = started();
    feed(&mut a, 0x80, &frames, 10_000);
    let c = classify(&a, 0, 0x80, false);
    let fs = fields(&c);
    assert!(
        fs.iter()
            .any(|f| f["kind"] == "checksum" && f["checksumAlgo"] == "xor8" && f["bitLength"] == 8),
        "no xor8 checksum byte found: {c}"
    );
}

#[test]
fn re_qa_classifier_sum8_checksum_byte0_and_middle() {
    let sum = |o: &[u8]| o.iter().fold(0u8, |s, b| s.wrapping_add(*b));
    assert_checksum(&checksum_frames(21, 0, sum), 0x81, 0, "sum8");
    assert_checksum(&checksum_frames(22, 4, sum), 0x82, 4, "sum8");
}

#[test]
fn re_qa_classifier_crc8_j1850_byte7_and_byte0() {
    assert_checksum(&checksum_frames(31, 7, crc8_j1850), 0x83, 7, "crc8_j1850");
    assert_checksum(&checksum_frames(32, 0, crc8_j1850), 0x84, 0, "crc8_j1850");
}

#[test]
fn re_qa_classifier_crc8_h2f_byte0_and_byte7() {
    assert_checksum(&checksum_frames(41, 0, crc8_h2f), 0x85, 0, "crc8_h2f");
    assert_checksum(&checksum_frames(42, 7, crc8_h2f), 0x86, 7, "crc8_h2f");
}

#[test]
fn re_qa_classifier_flag_bit() {
    let mut a = started();
    let frames: Vec<[u8; 8]> = (0..64)
        .map(|i| {
            let b1 = if (30..=31).contains(&i) { 0x08 } else { 0x00 };
            [0xC3, b1, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        })
        .collect();
    feed(&mut a, 0x90, &frames, 10_000);
    let c = classify(&a, 0, 0x90, false);
    let fs = fields(&c);
    let f = find_field(&fs, "flag", 11).unwrap_or_else(|| panic!("flag at bit 11 not found: {c}"));
    assert_eq!(num(f, "bitLength"), 1, "{f}");
    assert!(
        find_field(&fs, "flag", 0).is_none() && find_field(&fs, "flag", 1).is_none(),
        "constant bits must not be flags: {c}"
    );
}

fn physical_frames(motorola: bool) -> Vec<[u8; 8]> {
    (0..32u32)
        .map(|i| {
            let v = (0x0100 + i * 2039) as u16;
            let [lo, hi] = v.to_le_bytes();
            let (b2, b3) = if motorola { (hi, lo) } else { (lo, hi) };
            [0, 0, b2, b3, 0, 0, 0, 0]
        })
        .collect()
}

fn assert_physical(motorola: bool, id: u16) {
    let mut a = started();
    feed(&mut a, id, &physical_frames(motorola), 10_000);
    let c = classify(&a, 0, u32::from(id), false);
    let fs = fields(&c);
    let order = if motorola { "motorola" } else { "intel" };
    let msb = if motorola { 23 } else { 31 };
    let f = fs
        .iter()
        .find(|f| f["kind"] == "physical")
        .unwrap_or_else(|| panic!("no physical field for 16-bit {order} ramp: {c}"));
    assert_eq!(st(f, "byteOrder"), order, "wrong byte order picked: {f}");
    assert!(
        num(f, "bitLength") >= 12,
        "physical field too short for a 16-bit ramp: {f}"
    );
    let bits = field_bits(f);
    assert!(
        bits.iter().all(|b| (16..32).contains(b)),
        "physical field leaks outside bytes 2..3: {f}"
    );
    assert!(
        bits.contains(&msb),
        "physical field must contain value MSB (DBC bit {msb}): {f}"
    );
    assert_eq!(
        fs.iter().filter(|f| f["kind"] == "physical").count(),
        1,
        "single ramp -> single physical: {c}"
    );
}

#[test]
fn re_qa_classifier_physical_intel_ramp() {
    assert_physical(false, 0xA0);
}

#[test]
fn re_qa_classifier_physical_motorola_ramp() {
    assert_physical(true, 0xA1);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2.2 Binary snapshot
// ═════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn re_qa_snapshot_header_and_row_layout_full() {
    let mut a = started();
    let _ = a.set_phase(RePhase::Baseline);
    for i in 0..4u8 {
        a.ingest(&std_frame(
            2,
            0x123,
            &[i & 1, 0x55, 0, 0, 0, 0, 0, 0],
            10 + u64::from(i),
        ));
    }
    let _ = a.set_phase(RePhase::Action);
    let key = CanIdKey::new_extended(0x18FF_0001).expect("ext");
    for i in 0..4u8 {
        let mut d = [0u8; 64];
        d[63] = (i & 1) << 7;
        a.ingest(&fd_frame(5, key, &d, 100 + u64::from(i)));
    }
    let mut out = Vec::new();
    let s = snap(&mut a, &mut out, true);
    assert_eq!(&out[0..4], b"NRE2");
    assert_eq!(s.phase, 3, "phase byte: action = 3");
    assert_eq!(s.full, 1, "full=true -> full byte 1");
    assert_eq!(s.row_count, 2);
    assert_eq!(s.total_rows, 2);
    assert_eq!(s.reserved, 0, "reserved u16 must be 0");
    assert_eq!(
        out.len(),
        24 + (12 + 8 * 11) + (12 + 64 * 11),
        "exact byte size"
    );

    let r_std = s
        .rows
        .iter()
        .find(|r| r.arb_id == 0x123)
        .expect("std row in full snapshot");
    assert_eq!(r_std.bus, 2);
    assert_eq!(r_std.dlc, 8);
    assert_eq!(r_std.reserved, 0);
    assert_eq!(r_std.rx_count, 4);
    assert_eq!(r_std.flags & 0b011, 0, "std classic: ext=0 fd=0");
    assert_eq!(
        r_std.flags & 0b100,
        0,
        "std row: bit0 moved only in baseline -> no diff"
    );
    assert_eq!(r_std.diff, vec![0; 8]);
    assert!(r_std.heat[0] > 0, "toggled bit0 must have heat > 0");
    assert!(
        r_std.heat[1..].iter().all(|&h| h == 0),
        "never-toggled bits must have heat 0 (static)"
    );
    assert_eq!(
        r_std.constant,
        vec![0xFE, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]
    );
    assert_eq!(
        r_std.data,
        vec![1, 0x55, 0, 0, 0, 0, 0, 0],
        "data = last payload (i = 3)"
    );

    let r_fd = s
        .rows
        .iter()
        .find(|r| r.arb_id == 0x18FF_0001)
        .expect("fd row in full snapshot");
    assert_eq!(r_fd.bus, 5);
    assert_eq!(r_fd.dlc, 64);
    assert_eq!(r_fd.flags & 0b011, 0b011, "ext + fd flags");
    assert_eq!(
        r_fd.flags & 0b100,
        0b100,
        "bit 511 moved only in action -> hasDiff"
    );
    assert_eq!(r_fd.heat.len(), 512);
    assert!(r_fd.heat[511] > 0, "bit 511 heat");
    assert_eq!(r_fd.diff[63], 0x80, "diff bytes: bit 511 set");
    assert!(r_fd.diff[..63].iter().all(|&b| b == 0));
    assert_eq!(r_fd.constant[63], 0x7F, "bit 511 not constant");
    assert!(r_fd.constant[..63].iter().all(|&b| b == 0xFF));
    assert_eq!(
        r_fd.data[63], 0x80,
        "data = last payload (i = 3 -> bit 511 set)"
    );
    assert!(r_fd.data[..63].iter().all(|&b| b == 0));
    assert!(
        s.rows.iter().all(|r| r.flags & 0b1000 != 0),
        "first snapshot: every row is new"
    );
    assert!(
        s.rows.iter().all(|r| r.flags & 0xF0 == 0),
        "reserved flag bits must be 0"
    );
}

#[test]
fn re_qa_snapshot_dirty_only_after_full_resync() {
    let mut a = started();
    for id in [0x10u16, 0x20, 0x30] {
        a.ingest(&std_frame(0, id, &[1; 8], 1));
    }
    let mut out = Vec::new();
    let s0 = snap(&mut a, &mut out, true);
    assert_eq!((s0.full, s0.row_count, s0.total_rows), (1, 3, 3));

    let s1 = snap(&mut a, &mut out, false);
    assert_eq!(
        s1.seq,
        s0.seq.wrapping_add(1),
        "seq increments per snapshot"
    );
    assert_eq!(s1.full, 0, "full=false -> full byte 0");
    assert_eq!(
        s1.row_count, 0,
        "no frames since last snapshot -> no dirty rows"
    );
    assert_eq!(s1.total_rows, 3);
    assert_eq!(out.len(), 24, "header-only snapshot");

    a.ingest(&std_frame(0, 0x20, &[2; 8], 2));
    a.ingest(&std_frame(0, 0x40, &[3; 8], 3));
    let s2 = snap(&mut a, &mut out, false);
    assert_eq!(s2.seq, s1.seq.wrapping_add(1));
    assert_eq!(s2.row_count, 2, "exactly the 2 touched rows are dirty");
    assert_eq!(s2.total_rows, 4);
    let ids: BTreeSet<u32> = s2.rows.iter().map(|r| r.arb_id).collect();
    assert_eq!(ids, [0x20u32, 0x40].into_iter().collect());
    let r20 = s2.rows.iter().find(|r| r.arb_id == 0x20).expect("0x20");
    let r40 = s2.rows.iter().find(|r| r.arb_id == 0x40).expect("0x40");
    assert_eq!(
        r20.flags & 0b1000,
        0,
        "already-sent row must not be flagged new"
    );
    assert_ne!(
        r40.flags & 0b1000,
        0,
        "row created since last snapshot must be flagged new"
    );
    assert_eq!(r20.rx_count, 2);

    // Explicit full resync re-sends every row even when nothing is dirty.
    let s3 = snap(&mut a, &mut out, true);
    assert_eq!((s3.full, s3.row_count, s3.total_rows), (1, 4, 4));
}

#[test]
fn re_qa_snapshot_reuses_buffer_and_clears_it() {
    let mut a = started();
    for id in 0..64u16 {
        a.ingest(&std_frame(0, id, &[id as u8; 8], 1));
    }
    let mut out = vec![0xEEu8; 7]; // garbage the encoder must overwrite, not append to
    let s = snap(&mut a, &mut out, true);
    assert_eq!(s.row_count, 64);
    let cap = out.capacity();
    let ptr = out.as_ptr();
    for id in 0..64u16 {
        a.ingest(&std_frame(0, id, &[!(id as u8); 8], 2));
    }
    let n = count_allocs(|| a.encode_snapshot(&mut out, true));
    assert_eq!(
        n, 0,
        "encode_snapshot allocated {n} times after warm-up (contract: no per-tick allocation)"
    );
    assert_eq!(out.capacity(), cap);
    assert_eq!(out.as_ptr(), ptr, "snapshot buffer was reallocated");
    assert!(parse_snapshot(&out).is_ok());
}

#[test]
fn re_qa_snapshot_golden_fixture_wellformed() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/re_snapshot_golden.bin"
    );
    let bytes = std::fs::read(path).unwrap_or_else(|e| {
        panic!("golden fixture missing ({path}): {e} — backend-dev must produce it")
    });
    let s = parse_snapshot(&bytes).unwrap_or_else(|e| panic!("golden fixture malformed: {e}"));
    assert!(s.phase <= 3, "golden phase byte {} > 3", s.phase);
    assert!(s.full <= 1, "golden full byte {} not 0/1", s.full);
    assert!(s.row_count <= s.total_rows, "rowCount > totalRows");
    assert!(
        !s.rows.is_empty(),
        "golden fixture should contain at least one row"
    );
    assert!(
        s.rows.iter().any(|r| r.dlc == 64),
        "golden fixture should cover a 64-byte FD row"
    );
    assert!(
        s.rows.iter().any(|r| r.dlc == 8),
        "golden fixture should cover an 8-byte classic row"
    );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 Zero allocation in ingest, throughput
// ═════════════════════════════════════════════════════════════════════════════════════════════

#[test]
fn re_qa_ingest_zero_alloc_for_existing_rows() {
    let mut a = started();
    let key = CanIdKey::new_standard(0x7A0).expect("std");
    // Warm-up: create rows (allocation allowed at row creation).
    for id in 0..256u16 {
        a.ingest(&std_frame(0, id, &[0; 8], 0));
    }
    a.ingest(&fd_frame(0, key, &[0; 64], 0));
    let mut frames = Vec::with_capacity(20_000);
    let mut rng = Lcg(99);
    for i in 0..20_000u64 {
        let mut d = [0u8; 8];
        for x in &mut d {
            *x = rng.next_u8();
        }
        if i % 10 == 0 {
            let mut e = [0u8; 64];
            e[63] = rng.next_u8();
            frames.push(fd_frame(0, key, &e, 1_000 + i * 20));
        } else {
            frames.push(std_frame(0, (i % 256) as u16, &d, 1_000 + i * 20));
        }
    }
    let _ = a.set_phase(RePhase::Baseline);
    let n = count_allocs(|| {
        for f in &frames[..10_000] {
            a.ingest(f);
        }
    });
    assert_eq!(
        n, 0,
        "ingest allocated {n} times for existing rows (baseline phase)"
    );
    let _ = a.set_phase(RePhase::Action);
    let n2 = count_allocs(|| {
        for f in &frames[10_000..] {
            a.ingest(f);
        }
    });
    assert_eq!(
        n2, 0,
        "ingest allocated {n2} times for existing rows (action phase)"
    );
}

#[test]
fn re_qa_throughput_2048_rows_50kfps() {
    let mut a = started();
    let n = 200_000usize;
    let mut frames = Vec::with_capacity(n);
    let mut rng = Lcg(5);
    for i in 0..n {
        let mut d = [0u8; 8];
        for x in &mut d {
            *x = rng.next_u8();
        }
        frames.push(ext_frame(0, (i % 2048) as u32, &d, i as u64 * 20));
    }
    let t0 = Instant::now();
    for f in &frames {
        a.ingest(f);
    }
    let dt = t0.elapsed();
    let fps = n as f64 / dt.as_secs_f64();
    eprintln!("re_qa throughput: {n} frames / 2048 rows in {dt:?} -> {fps:.0} fps");
    assert_eq!(num(&status(&a), "rows"), 2048);
    assert_eq!(num(&status(&a), "framesIngested"), n as u64);
    if !cfg!(debug_assertions) {
        assert!(
            fps >= 50_000.0,
            "RE ingest {fps:.0} fps < 50k fps gate (release)"
        );
    }
}
