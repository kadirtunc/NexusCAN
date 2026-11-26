# RE Toolkit v1 — Reverse Engineering / Car Hacking (team-lead contract)

Status: **DRAFT — user approved roadmap order 2026-11-19 ("sırasıyla"): R1 → R2 → R3 → R4. This file freezes R1.**
Audience: car-hacking / CAN reverse-engineering users (SavvyCAN, CANalyzat0r, cabana, ICSim class tools) —
NexusCAN must beat them on determinism (50k fps zero-loss), CAN-FD 512-bit coverage and safety.

## 0. Roadmap
> 2026-11-23: labelled-state hunt (offline-first, R2d–R2f) lives in `re-hunt-v1.md`.

| Phase | Scope | Bus impact |
| :--- | :--- | :--- |
| **R1 (this file)** | Sniffer: bit-level toggle heatmap, baseline → action diff, noise mute, event markers; field classifier (constant / counter / checksum / flag / physical, per-bit entropy) | **passive only** (no TX code paths touched) |
| R2 | Signal Finder → DBC: pick bits, endianness/sign/length sweep, live candidate plots, correlation with a reference (OBD-II PID, marker, manual), scale/offset regression, save to DBC via `nexus-netdb` writer | passive |
| R3 | Selective replay (ID subset / window / loop / payload edit), counter + checksum auto-fill in TX Composer and replay, SecOC/MAC hint; formats: MF4, pcapng (SocketCAN), SavvyCAN CSV, CRTD; two-log diff | TX (existing Arm / Panic gates) |
| R4 | Active scanners: UDS service / DID / RID / session map, SecurityAccess seed entropy, OBD-II PID scan, ID-range + payload-mutation fuzzer | TX, heaviest gate (Arm + rate limit + whitelist + Panic Stop) |

## 1. R1 invariants
- Off by default. Enabled per session by `cmd_re_start`; when off, the aggregator pays one relaxed atomic load per batch.
- **Zero allocation per frame.** Per-row RE state is allocated once at row creation (same moment a StateTable row is
  created), bounded by `MAX_RE_ROWS = 2048` (rows beyond are counted in `reOverflowRows`, no RE state).
- Bit numbering = DBC Intel numbering: `bit = byte*8 + k`, `k = 0` = LSB of the byte. All arrays sized for 64 bytes / 512 bits (CAN-FD); classic frames use the first `dlcBytes*8`.
- RE runs in the aggregator thread (owner of `StateTable`), never in the reader thread; `dropped_frames == 0` at 50k fps
  with RE on is a gate requirement.

## 2. Backend — `crates/nexus-hal/src/pipeline/re_analyzer.rs` (new) + wiring in `state_table.rs` / aggregator
Per row `(bus, isExtended, arbId)` (mux path ignored; error frames excluded):
```rust
struct ReRowState {
    dlc_bytes: u8,                    // max payload length seen
    prev: [u8; 64], has_prev: bool,
    toggles: [u32; 512],              // saturating toggle count since start/reset
    window_toggles: [u16; 512],       // toggles in the current heat window (decayed every 1 s: x -> x/2)
    seen_one: [u64; 8], seen_zero: [u64; 8],      // constant detection
    baseline_active: [u64; 8],        // bits that toggled during the baseline phase
    action_active: [u64; 8],          // bits that toggled during the action phase
    history: [[u8; 64]; 64], hist_len: u8, hist_head: u8,   // last 64 payloads (classifier)
    hist_ts_us: [u64; 64],
    rx_count: u32, first_us: u64, last_us: u64,
}
```
Phases: `idle | free | baseline | action` (`free` = counting without baseline semantics).
`diff = action_active & !baseline_active` (bits that moved only during the action).
Noise mute (UI filter, computed in backend): bit is "noisy" when it toggled in baseline OR its window rate > 50 % of frames.

### 2.1 Commands (new permission set `re` in `src-tauri/permissions/re.toml`, registered in `app_commands.rs`, added to `capabilities/default.json`)
| Command | Args | Result |
| :--- | :--- | :--- |
| `cmd_re_start` | `{ buses: number[] \| null }` (null = all) | `ReStatusDto` |
| `cmd_re_stop` | `{}` | `ReStatusDto` (state kept, ingest paused) |
| `cmd_re_reset` | `{}` | `ReStatusDto` (all rows cleared, markers cleared) |
| `cmd_re_set_phase` | `{ phase: 'free' \| 'baseline' \| 'action' }` | `ReStatusDto`; entering `baseline` clears `baseline_active`, entering `action` clears `action_active` |
| `cmd_re_mark` | `{ label: string }` (≤ 64 chars) | `ReMarkerDto` |
| `cmd_re_markers` | `{}` | `ReMarkerDto[]` (≤ 1024, oldest dropped) |
| `cmd_re_subscribe` | `{ onSnapshot: Channel }` | `null`; 10 Hz binary snapshots (§2.2) until `cmd_re_stop`/unsubscribe |
| `cmd_re_row_detail` | `{ bus, arbId, isExtended }` | `ReRowDetailDto` (exact toggle counts, masks as hex, history count) |
| `cmd_re_classify` | `{ bus, arbId, isExtended }` | `ReClassificationDto` (§2.3) |
```ts
interface ReStatusDto { enabled: boolean; phase: 'idle'|'free'|'baseline'|'action'; rows: number; overflowRows: number;
  framesIngested: number; startedAtUs: number | null; phaseStartedAtUs: number | null }
interface ReMarkerDto { id: number; tsUs: number; label: string; phase: ReStatusDto['phase'] }
interface ReRowDetailDto { bus: number; arbId: number; isExtended: boolean; dlcBytes: number; rxCount: number;
  toggles: number[] /* dlcBytes*8 */; constantMask: string; baselineMask: string; actionMask: string; diffMask: string;
  /* hex, 2 chars per byte, byte 0 first */ firstUs: number; lastUs: number; historyLen: number }
```

### 2.2 Binary snapshot (Channel → `ArrayBuffer`, little-endian), 10 Hz, dirty rows only (+ all rows on first frame after subscribe)
```
header (24 B): magic "NRE1" | seq u32 | tsUs u64 | phase u8 (0 idle,1 free,2 baseline,3 action) | full u8 (1 = full resync)
               | rowCount u16 | totalRows u16 | reserved u16
row: bus u8 | flags u8 (b0 extended, b1 fd, b2 hasDiff, b3 new) | dlcBytes u8 | reserved u8 | arbId u32 | rxCount u32
     | heat [u8; dlcBytes*8]  (0..255, log-scaled window toggle rate; 0 = static)
     | diff [u8; dlcBytes]    (diff mask bytes)
     | constant [u8; dlcBytes] (1 = bit never changed)
```
Rust encodes into a reused `Vec<u8>` owned by the snapshot task (no per-tick allocation after warm-up).
TS decoder `src/services/reSnapshotCodec.ts` (pure) + test.

### 2.3 Classifier (on demand, over the row history; pure fn, unit-tested)
```ts
type ReFieldKind = 'constant' | 'counter' | 'checksum' | 'flag' | 'physical' | 'unknown';
interface ReFieldDto { startBit: number; bitLength: number; byteOrder: 'intel' | 'motorola'; kind: ReFieldKind;
  confidence: number /* 0..1 */; counterModulo?: number; counterStep?: number;
  checksumAlgo?: 'xor8' | 'sum8' | 'crc8_j1850' | 'crc8_h2f' | 'crc8_custom'; checksumInit?: number; checksumCoverage?: string;
  min?: number; max?: number }
interface ReClassificationDto { bus: number; arbId: number; isExtended: boolean; samples: number;
  bitEntropy: number[] /* dlcBytes*8, Shannon of the bit, 0..1 */; fields: ReFieldDto[]; periodMs: number | null; jitterMs: number | null }
```
- Needs ≥ 16 samples, else `fields = []` with `samples` reported.
- Counter: 2/4/8-bit aligned nibble or byte, step +1 mod 2^n over consecutive samples, ≤ 10 % gaps tolerated.
- Checksum: one byte, candidates XOR8, SUM8, CRC8 SAE-J1850 (poly 0x1D, init 0xFF, xorout 0xFF), CRC8 AUTOSAR H2F
  (poly 0x2F, init 0xFF, xorout 0xFF), init sweep 0x00/0xFF, over the other bytes of the frame; match ≥ 95 % of samples.
- Flag: 1-bit, entropy > 0, toggles rarely (< 5 % of frames). Constant: never changed. Physical: multi-bit group whose
  consecutive deltas are small relative to range (smoothness), Intel vs Motorola chosen by smoothness score.
- Output fields are non-overlapping, sorted by startBit.

## 3. Frontend — `src/components/re/**` (new doc tab `re`, label tr "Tersine Mühendislik", en "Reverse Engineering")
- `ReSnifferView`: toolbar (Start/Stop/Reset, phase buttons **Baseline** / **Action** / Free with elapsed time, Mark
  button + hotkey `M` with optional label, filters: only diff, mute noisy, hide constant, ID search, bus).
- `ReHeatmapCanvas`: one row per ID, 8 cells per byte, color = heat, diff bits outlined, constant bits dimmed;
  **Canvas 2D**, row virtualization, 60 FPS redraw only on new snapshot; `font-mono tabular-nums` for IDs / counts.
- `ReRowInspector`: selected ID → `cmd_re_row_detail` + `cmd_re_classify` (button "Analyze"), field overlay on a
  byte×bit grid (reuse BitLayoutMatrix cell geometry if feasible), entropy bars, period/jitter, markers list.
- Store `src/store/reStore.ts`; IPC wrappers `src/services/reClient.ts` (+ browser-bridge fallback driven by a pure
  synthetic generator so the view is demoable without Tauri — must be labelled DEMO, never presented as live data).
- i18n shard `src/i18n/shards/re.ts` (tr + en).

## 4. Tests / gate (R1)
- Rust (`cargo test -p nexus-hal re_`): toggle counts exact on scripted frames; CAN-FD bit 511 counted; baseline/action
  diff semantics; constant mask; history ring wrap; classifier vectors (4-bit counter in nibble, 8-bit counter, XOR8,
  SUM8, CRC8-J1850 known vector `"123456789"` → `0x4B`, H2F vector → `0xDF`, flag, physical Intel vs Motorola);
  snapshot encoder layout golden bytes; no allocation in `ingest` (counting global allocator test); throughput bench
  ≥ 50k fps with 2048 active rows on one core, `dropped_frames == 0` in mock0 50 kHz run with RE on.
- TS: `test:re` (codec decode of golden bytes shared with Rust test, filters), `npx tsc -p tsconfig.app.json --noEmit`.
- QA writes probes first: `crates/nexus-hal/tests/re_qa.rs` + `src/components/re/re.qa.test.ts` (`test:re-qa`).

## 5. Amendments
- 2026-11-19 (team-lead, QA probe review):
  1. `mark(label)` never fails: label truncated to 64 **chars** (UTF-8 safe); returns `ReMarkerDto`.
  2. DLC growth: bytes beyond the previous length are adopted on the first longer frame (no toggles counted for them).
  3. `overflowRows` = number of **frames** that could not get a RE row because `MAX_RE_ROWS` was reached (name kept for
     wire compatibility; no per-ID tracking, no allocation).
  4. `start` → phase `free`.
  5. Snapshot flag b3 `new` = row created since the last emitted snapshot. `encode_snapshot(out, full)` clears `out`
     first; `full` is passed by the caller (subscription task sends `full=true` on its first tick).
  6. XOR8 tie-break: when the XOR of all bytes is 0, every byte qualifies; report the **last** byte of the frame
     (`dlcBytes-1`), else byte 0 if that is the only match.
  7. CRC/SUM coverage = all other bytes in **ascending** index order (checksum byte skipped); `checksumCoverage` e.g. `"0-6"`.
  8. Motorola `startBit` uses the DBC convention (MSB start bit, sawtooth numbering).
  9. Heat window decay and noise rate run on **frame timestamps** (deterministic in replay), evaluated at snapshot time.
  10. Codec: trailing bytes after the last row → reject (Rust parser and TS decoder); phase byte > 3 → reject.
  11. Hex masks are uppercase.
  12. Rust API: QA's assumption block in `crates/nexus-hal/tests/re_qa.rs` is authoritative (start/stop/reset/set_phase return `ReStatusDto`).
- R1 gate PASS (2026-11-19): nexus-hal lib 176 + re_qa 30/30 (debug + release), zero-alloc ingest test, release
  throughput ~8 M fps @ 2048 rows, mock0 50 kHz with RE on `dropped_frames == 0`; TS test:re 70/70, test:re-qa 8/8
  (golden bytes shared with Rust); tsc clean; clippy clean; Windows/macOS `cargo check -p nexus-hal` OK.
  Accepted: `noisyMask` in `ReRowDetailDto` (snapshot uses heat ≥ 229 rate rule only); RTR skipped; one `to_vec` per
  10 Hz tick at the Channel hand-off; `cmd_re_stop` ends the subscription (UI re-subscribes after every start).
  Not yet exercised against a live bus in the running app.

## 6. R2a — Signal Inspector (user decision 2026-11-19: "seçilen bitlerden sinyali inceleme kısmını istiyorum, DBC'ye kaydetme sonradan")
Scope: pick bits of an ID → live candidate signal plots, interpretation sweep, correlation with a reference, scale/offset
regression. **No DBC write in R2a** (that is R2b). Passive only. Bit math = `nexus_netdb::compiler::bit_plan::NormalizedBitSpan`
(+ `trace_signal_bits`) — no second Intel/Motorola implementation anywhere (Rust or TS).

### 6.1 Focus rings (backend, `re_analyzer.rs` or new `re_focus.rs`)
- Up to `MAX_RE_FOCUS = 8` focused targets `(bus, arbId, isExtended)`. Each has a preallocated ring of
  `RE_FOCUS_DEPTH = 16384` samples `{ tsUs: u64, len: u8, payload: [u8; 64] }` allocated once when focus is set
  (not per frame). Ingested in the same aggregator path as RE (RE must be started). Overwrite-oldest.
- Reference IDs are focused automatically by `cmd_re_correlate` / `cmd_re_series` when a reference needs them (counts
  toward the 8; error `[re:focus_full]` if no slot).

### 6.2 Commands (permission set `re`)
| Command | Args | Result |
| :--- | :--- | :--- |
| `cmd_re_focus_set` | `{ targets: ReTargetDto[] }` (≤ 8, replaces set; kept targets keep their ring) | `ReFocusStatusDto` |
| `cmd_re_focus_status` | `{}` | `ReFocusStatusDto` |
| `cmd_re_series` | `{ target, candidates: ReCandidateDto[] (≤ 4), reference: ReReferenceDto \| null, fromUs: number \| null, toUs: number \| null, maxPoints: number (16..=4096) }` | binary `ArrayBuffer` (§6.3) |
| `cmd_re_correlate` | `{ target, reference: ReReferenceDto, fromUs, toUs, search: ReSearchDto, topN: number (1..=50) }` | `ReCorrelationResultDto` |
```ts
interface ReTargetDto { bus: number; arbId: number; isExtended: boolean }
interface ReFocusStatusDto { targets: (ReTargetDto & { samples: number; firstUs: number | null; lastUs: number | null; auto: boolean })[] }
interface ReCandidateDto { startBit: number; bitLength: number /* 1..=64 */; byteOrder: 'intel' | 'motorola';
  valueType: 'unsigned' | 'signed' | 'float32' | 'float64'; factor: number; offset: number }
type ReReferenceDto =
  | { kind: 'obd_pid'; pid: number; bus: number }                 // decoded from on-bus Mode-01 responses (§6.4)
  | { kind: 'markers'; points: { markerId: number; value: number }[] }  // step function at marker timestamps (≥ 2 points)
  | { kind: 'candidate'; target: ReTargetDto; candidate: ReCandidateDto };  // another signal as reference
interface ReSearchDto { bitFrom: number; bitTo: number;           // only candidates whose bits lie inside [bitFrom, bitTo]
  lengths: [number, number] /* min,max within 1..=32 */; byteOrders: ('intel'|'motorola')[]; signed: boolean[] }
interface ReCorrelationRowDto { candidate: ReCandidateDto /* factor/offset = least-squares fit raw→reference */;
  r: number; r2: number; rmse: number; samples: number; lagMs: number }
interface ReCorrelationResultDto { rows: ReCorrelationRowDto[] /* sorted by |r| desc, then shorter bitLength */;
  evaluated: number; referenceSamples: number; elapsedMs: number; truncated: boolean }
```
- Correlation: for each reference sample time t, the target value = last target sample with `tsUs ≤ t` (zero-order
  hold; skip if none or older than 1 s). Pearson r; `factor/offset` by least squares (raw → reference); `rmse` in
  reference units. Candidates with zero variance are skipped. `lagMs` = best lag in `[-500, +500] ms` step 10 ms
  for the TOP rows only (recompute r at that lag; report lag 0 if not better by > 0.01).
- Exhaustive sweep (all start bits in range × lengths × orders × signed) runs on a worker thread (never the
  aggregator), bounded to 2 s wall time (`truncated = true` if cut), cancellable by a new call. Must evaluate a full
  classic-frame sweep (64 bits × 1..32 × 2 × 2) over 2 000 reference samples well inside the budget in release.
- Dedupe: drop a row whose bit set is a superset of a better-ranked row with |Δr| < 0.002 (prefer the minimal field).

### 6.3 Series binary (little-endian)
```
header (16 B): magic "NRS1" | seriesCount u8 | reserved u8 | pointsMax u16 | fromUs u64
series: kind u8 (0 candidate, 1 reference) | index u8 | reserved u16 | pointCount u32
        | then pointCount × { tUsRel u32 (µs since fromUs), min f64, max f64 }   // min/max decimation bucket
```
Decimation: bucket by time into ≤ `maxPoints` buckets, min/max per bucket (exact when samples ≤ maxPoints, min = max).
TS decoder `src/services/reSeriesCodec.ts` (pure), rejects bad magic / truncation / trailing bytes.

### 6.4 OBD-II reference from the bus
Mode-01 positive responses observed on the bus: 11-bit `0x7E8..=0x7EF`, 29-bit `0x18DAF1xx`; single frame
`[len, 0x41, pid, A, B, C, D]`. Value via a Rust port of the catalog formulas for the PIDs in `PID_CATALOG`
(`src/types/diagnostics.ts`) — keep the PID list identical, unit-test each formula against the TS catalog vectors.
Someone must be polling (Diagnostic Simulation panel, Live PID gauges, or an external tester); if no responses are
found in the window → error `[re:no_reference]` with a hint.

### 6.5 Frontend (`src/components/re/**`)
- `ReSignalInspector` (new panel in the RE tab, opened from the row inspector "Inspect signal"): byte×bit grid of the
  selected ID with drag-select of bits (Intel: contiguous in Intel numbering; Motorola: DBC sawtooth — the grid shows
  the selection the backend will extract via a `cmd_re_series` round trip, never via TS bit math); controls: byte
  order, value type, factor, offset, unit label; up to 4 candidates (color-coded) + 1 reference.
- `ReSeriesCanvas`: Canvas 2D time plot, min/max bands, markers as vertical lines with labels, reference on a right
  axis, pan/zoom on the time axis, live follow (poll `cmd_re_series` at 5 Hz while visible and following).
- `ReCorrelatePanel`: reference picker (OBD-II PID from `PID_CATALOG`, markers with per-marker numeric values,
  another candidate), search range (defaults to the classifier's non-constant bits), Run → ranked table (start, len,
  order, type, r, r², factor, offset, rmse, lag) with "Plot" and "Use as candidate"; elapsed / truncated shown.
- Classifier `physical` fields get an "Inspect" button that seeds a candidate.
- Candidates live in `reStore` (in-memory; persistence comes with R2b). `font-mono tabular-nums` everywhere numeric.
- Browser demo fallback: synthetic series + correlation computed by the demo generator, DEMO-badged.

### 6.6 Tests / gate (R2a)
QA probes first: `crates/nexus-hal/tests/re_r2a_qa.rs` + `src/components/re/re.r2a.qa.test.ts` (`test:re-r2a-qa`).
Must cover: focus ring alloc-once + wrap; series exact values for Intel and Motorola 12-bit signed fields
(cross-checked against `NormalizedBitSpan`), float32; decimation min/max; correlation finds a planted 16-bit
Motorola signal (factor 0.25, offset −40) with r > 0.999 and recovers factor/offset within 1e-6; planted lag 120 ms
recovered within ±10 ms; superset dedupe; markers reference step function; OBD reference decode PID 0x0C/0x0D/0x05
from scripted 0x7E8 frames; `[re:no_reference]`; sweep time budget + truncated flag; series codec golden bytes shared
Rust↔TS. Gate: `cargo test -p nexus-hal`, release throughput tests still green, `cargo clippy -p nexus-hal --all-targets
-- -D warnings`, src-tauri `cargo check`, tsc, `test:re`, `test:re-qa`, `test:re-r2a-qa`.
- 2026-11-19 (team-lead, R2a QA review):
  1. ~~Ranking uses lag-0 r only~~ (revised same day after backend gate — it demoted genuinely lagged signals):
     rank score = max(|r(lag 0)|, |r(best lag)|), where a lag is credited ONLY if it keeps ≥ 95 % of the lag-0 sample
     count (this alone removes the short-overlap sub-field artefact QA found). Superset dedupe compares rank scores of
     rows evaluated on the same sample count. `r`/`r2`/`factor`/`offset`/`rmse` are reported at the credited lag.
  2. Lag sign: `lagMs > 0` = the target changes **before** the reference (reference ≈ target shifted later by lagMs).
  3. Marker time base = frame time base: when frames carry hardware timestamps, the analyzer keeps the latest
     `frame.tsUs − monotonic_now` offset at ingest and stamps markers / phase starts with `monotonic_now + offset`.
  4. OBD single frame: length byte must be ≥ 2 + data bytes of the PID and ≤ 7 (lenient above the minimum).
  5. OBD auto-focus only takes responder IDs that already have an RE row (no blind focus of 0x7E8..0x7EF).
  6. QA's defaults accepted: >8 targets → `invalid`/`focus_full`; empty window → Ok/0 points; constant target → Ok/no
     rows; float with wrong length → `invalid`; error frames never in focus rings; only proper supersets deduped.
  7. Series window wider than u32 µs (≈ 71 min) → `[re:invalid]` "window too long".
- R2a gate PASS (2026-11-19): nexus-hal 313 tests / 0 failed (re_qa 30, re_r2a_qa 30, debug + release); release full
  classic sweep 6208 candidates ≈ 107 ms (not truncated), planted 120 ms lag recovered as +120; R1 throughput ≈ 6.1 M
  fps @ 2048 rows (one clock read per frame for amendment 3); clippy + src-tauri check clean; TS test:re 70, test:re-r2a
  92, test:re-qa 8/8, test:re-r2a-qa 10/10; tsc clean. Not yet exercised in the running app. Next: R2b (save to DBC).
- 2026-11-19 (team-lead, user request "bitlerin altında hem hex hem de bit bilgilerini görmeliyim"): R1 amendment 13 —
  **snapshot v2 (`"NRE2"`)**. Row layout gains the latest payload after the constant mask:
  `... | heat [u8; dlcBytes*8] | diff [u8; dlcBytes] | constant [u8; dlcBytes] | data [u8; dlcBytes]` (last received
  payload, byte 0 first, = the analyzer's `prev` buffer; zero-padded if the last frame was shorter than `dlcBytes`).
  Header unchanged except magic `"NRE2"`; decoders reject `"NRE1"` with a clear error (no silent misparse against a
  stale bridge). Encoder stays allocation-free after warm-up. Golden fixtures regenerated by backend.
  UI: heatmap rows show per-bit value glyphs (`0`/`1`) inside the heat cells and the byte hex value under each byte
  group (`font-mono tabular-nums`); header shows `B<n>` + bit indices `7..0`; hex text highlighted when the byte value
  changed since the previous snapshot, amber when the byte has diff bits; toolbar toggle "Değerler / Values"
  (`ReFilters.showValues`, default true) restores the compact layout; tooltip shows bit value + byte hex/dec/bin.
- 2026-11-19 (team-lead, user: "demo istersem demo verilerini görmeliyim; şu anda bus'a bağlanabilmeli"): amendment 14 —
  **RE runs live in browser/bridge mode; demo only on explicit opt-in.**
  Backend (`crates/nexus-hal/src/bin/nexus_bridge.rs`):
  - `/api/invoke/cmd_re_{start,stop,reset,set_phase,mark,markers,row_detail,classify,focus_set,focus_status,correlate}`
    with the same camelCase args / JSON results as the Tauri commands; errors keep the `"[re:<code>] …"` text in the
    bridge's existing error wire format. `cmd_re_correlate` runs off the async runtime (spawn_blocking).
  - `/api/invoke/cmd_re_series` → `200 application/octet-stream` body = NRS1 bytes (same as Tauri `Response`).
  - `/ws/re`: same Host/Origin guard + first-message auth as `/ws/telemetry`; after auth the bridge subscribes via
    `cmd_re_subscribe` with a sink that pushes each snapshot as one **binary** WS message through a bounded queue
    (cap 16). Queue full → drop and force a full resync for the next snapshot (no lost dirty rows). Client gone → sink
    returns false (subscription ends). A newer subscription (Tauri or WS) replaces the older one, as today. When the
    backend ends the subscription (cmd_re_stop) the bridge closes the socket normally (code 1000).
  Frontend (`src/services/reClient.ts`, `reStore.ts`, `ReSnifferView.tsx`):
  - `RE_DEMO` const removed → runtime source `'live' | 'demo'`, default **live** in both Tauri and browser
    (browser: `invokeCmd` over the bridge, binary series via a raw-body fetch helper, snapshots via `/ws/re` with
    the same token handling / reconnect-on-401 rules as telemetry). Demo only when the user turns on the toolbar
    "Demo" switch (persisted in localStorage `nexus.re.source`); DEMO badge stays. Switching source stops the
    current session, clears rows/markers/focus and re-attaches.
  - Live backend unreachable → visible error with hint ("bridge çalışmıyor — başlatın veya Demo'yu açın"); never a
    silent fallback to demo.

## 7. R2b — Save found signals to DBC (user approval 2026-11-19: "tamam kontrata yaz")
Status: **FROZEN 2026-11-19 (R2b started).** Passive (no TX). Goal: a signal found in the Signal Inspector survives reload, is
written as a valid DBC and is decoded everywhere (trace, Signal Inspector, plots) after "Apply".

### 7.1 Draft DTO (shared Rust ↔ TS, camelCase)
```ts
type ReSignalValueType = 'unsigned' | 'signed' | 'float32' | 'float64';
interface ReSignalDraftDto {
  id: string;                    // uuid, UI identity
  bus: number; arbId: number; isExtended: boolean;
  messageName: string | null;    // null → existing message name if the loaded bus DB has this id, else "RE_<HEXID>"
  dlcBytes: number;              // from the RE row (0..64; CAN-FD allowed)
  name: string;                  // DBC identifier [A-Za-z_][A-Za-z0-9_]*, ≤ 64 chars (warn > 32)
  startBit: number;              // DBC convention: Intel = LSB, Motorola = MSB sawtooth (same as ReCandidateDto)
  bitLength: number;             // 1..64 (float32 = 32, float64 = 64)
  byteOrder: 'intel' | 'motorola';
  valueType: ReSignalValueType;
  factor: number; offset: number; min: number; max: number;   // finite; min ≤ max
  unit: string;                  // ≤ 32 chars, printable
  comment: string;               // free text; generator appends provenance line
  provenance: { r: number | null; lagMs: number | null; reference: string | null; samples: number | null; createdAtMs: number };
  valueTable: { value: number; label: string }[];             // optional VAL_ (flags / enums), may be []
}
interface ReDbcDiagnosticDto { severity: 'error' | 'warning'; draftId: string | null; code: string; message: string }
interface ReDbcGenerateResultDto { dbcText: string; diagnostics: ReDbcDiagnosticDto[]; messages: number; signals: number }
```
Diagnostic codes: `bad_name`, `duplicate_name` (same message), `out_of_range` (bits beyond dlcBytes*8, via
`NormalizedBitSpan`), `overlap` (with another draft or a base-DB signal in the same message; error unless both are
mux-unrelated — R2b has no mux drafts), `bad_scale` (non-finite / factor 0 / min > max), `float_len`, `name_long`
(warning), `base_lossy` (warning: base DBC constructs the writer cannot round-trip), `id_conflict_dlc` (warning: base
message DLC differs from draft dlcBytes).

### 7.2 Generator (protocol-specialist, `crates/nexus-netdb/src/re_export.rs`, pure, no I/O)
`pub fn generate_re_dbc(drafts: &[ReSignalDraft], base: Option<&NetworkDatabase>) -> ReDbcGenerateResult`
- No base → standalone DB: `VERSION "NexusCAN RE"`, node `RE_FOUND` (BU_), messages grouped by (bus-agnostic) id,
  transmitter `Vector__XXX`, signals with receiver `Vector__XXX`; `CM_ SG_` = user comment + provenance line
  (`RE: r=0.998 lag=+120ms ref=OBD 0x0D n=812`); `VAL_` from valueTable; `SIG_VALTYPE_` for floats.
- With base → base IR + drafts added into existing messages (matched by id + extended) or new messages; base signals
  untouched.
- Any `error` diagnostic → `dbcText = ""` (nothing written). Output must round-trip: the result text is re-parsed and
  compiled with the existing pipeline inside the generator (`parse_and_compile`), and the generator fails with
  `roundtrip` if that fails or if any draft decodes differently from the IR it came from.
- Uses `DbcWriter` (extend it only if needed for SIG_VALTYPE_ / VAL_ correctness).

### 7.3 Command (backend-dev; Tauri + bridge, permission set `re`)
`cmd_re_dbc_generate(drafts: ReSignalDraftDto[], base: { fileName: string; contentBase64: string } | null)
 → ReDbcGenerateResultDto` — parses `base` with the existing format detection (.dbc/.kcd), calls the generator on a
blocking worker; errors as `[re:invalid] …`. No file system writes in the backend (saving is the frontend's
existing save/download path). Bridge: same route under `/api/invoke/`.

### 7.4 Frontend (`src/components/re/**`, `src/store/reSignalStore.ts` / new `reDraftStore.ts`, `projectStore.ts`)
- **Save signal** button on a candidate / correlation row → dialog prefilled: name (`<MSG>_sig<startBit>`), factor /
  offset from the correlation, min/max from observed physical range (rounded), unit/reference from the OBD PID if any,
  byte order / sign / length from the candidate; live validation calls `cmd_re_dbc_generate([draft], base)` (debounced)
  and shows diagnostics inline.
- **Found Signals** panel in the RE tab: list (message, name, bits, order, factor/offset, unit, r), edit, delete
  (confirm), multi-select. Drafts persist in the project file: `NexusProjectFileV1.reSignals?: ReSignalDraftDto[]`
  (additive, version stays 1, sanitizer `reDraftSanitize.ts` drops malformed entries with a notice; missing → []).
  Edits set `projectStore.dirty`.
- Actions:
  1. **Apply to bus** — generate standalone text from all drafts of that bus, register it as catalog DB
     `RE_found.dbc` (one per project, replaced on re-apply) through the existing databaseStore / busDatabaseSync path
     with append semantics so user DBCs stay loaded; trace / inspector / plots then decode it.
  2. **Export .dbc** — standalone text → existing save-file path (Tauri dialog / browser download).
  3. **Merge into DBC…** — pick a loaded catalog DB whose original content is available → generate with base → save
     as a NEW file (default `<name>_re.dbc`); never overwrite the original silently; show `base_lossy` warnings first.
- All RE errors go to the Debug console (category `RE`, rate-limited, see amendment debug logging).
- Demo source: generation still uses the backend if reachable; otherwise actions disabled with a hint.

### 7.5 Tests / gate (R2b) — QA probes first
- nexus-netdb: generated DBC re-parses; decoded values equal the RE series decode for Intel and Motorola 12-bit
  signed, unsigned 16-bit, float32, and a CAN-FD 64-byte message signal at startBit 300; overlap / bad_name /
  out_of_range / duplicate errors; merge with a base keeps every base signal decoding bit-identically on golden frames;
  quote/backslash escaping in unit/comment/VAL_ labels; VAL_ table round-trip.
- Backend: command round-trip (Tauri + bridge), base `.kcd` input, error text `[re:invalid]`.
- Frontend: draft sanitizer, project round-trip, dialog prefill from a correlation row, Apply replaces the previous
  `RE_found.dbc` (no duplicates), Export text equals generator output.
- E2E (QA, mock/vcan): plant 16-bit Motorola signal (factor 0.25, offset −40) → correlate → draft → generate → load →
  decoded value equals planted within factor/2.
- Gate: cargo test -p nexus-netdb -p nexus-hal, clippy -D warnings, src-tauri check, tsc, test:re*, new test:re-r2b(-qa).

### 7.5a Amendments (2026-11-19, team-lead, R2b QA probe review)
QA assumption blocks in `crates/nexus-netdb/tests/re_export_qa.rs` (Rust API, `nexus_netdb::re_export`, new
`ReByteOrder` enum "intel"/"motorola", `ReValueTableEntry.value: i64`) and `src/components/re/re.r2b.qa.test.ts`
(`src/types/reDraft.ts`, `reDraftSanitize.ts`, `reDraftModel.ts`) are **authoritative**. Frozen defaults:
1. Auto message name: std `RE_{:03X}`, ext `RE_{:08X}` (uppercase, no 0x).
2. Base message present → base name wins, draft `messageName` ignored; base messages never renamed.
3. Grouping bus-agnostic by (id, extended); new message DLC = max draft `dlcBytes`; base message keeps its DLC.
4. Provenance line `RE: r=<3 dp> lag=<signed int, +0>ms ref=<ref> n=<samples>`; null token dropped; all null →
   `RE: manual`; CM text = user comment + "\n" + line (line only if comment empty).
5. `out_of_range` also: startBit ≥ 512, span past 512, non-float bitLength 0 / > 64, dlcBytes 0 or > 64.
6. Name > 64 → `bad_name`; 33..64 → `name_long` warning.
7. Overlap with any base mux-branch signal → `overlap` error.
8. Empty draft list → valid empty DBC, no diagnostics, counts 0/0.
9. factor/offset/min/max written losslessly (exact f64 round-trip).
10. `messages`/`signals` count draft-touched only; 0 on error.
11. Sanitizer drops structural breakage only (semantic issues left for the generator); non-array → dropped 1;
    duplicate id → first kept. Prefill min/max = floor/ceil of observed range, none → 0/0.
12. Apply: `RE_found.dbc` match is case/space-insensitive, stale duplicates collapsed into the first slot.
13. `Vector__XXX` is written in the text but the parser maps it to "no node" (existing behaviour, unchanged):
    schema transmitter/receiver lists are empty for generated messages. Probe adjusted accordingly.
14. Base-signal decode change after merge → `roundtrip` error (not `base_lossy`); info-only losses → `base_lossy`
    (≤ 16, then a summary). Arb id beyond 11/29 bits and draft spans past a base message DLC → `out_of_range`.
    New CAN-FD messages get no `VFrameFormat` attribute in R2b (follow-up).
15. `cmd_re_dbc_generate`: a base that parses to zero messages → `[re:invalid] … no messages found` (tolerant
    parsers accept garbage); generator findings stay diagnostics in an Ok result. Limits: ≤ 4096 drafts, base ≤ 32 MiB.

- R2b gate PASS (2026-11-19): nexus-netdb + nexus-hal debug 408 passed / 0 failed, release 329 (50k fps zero-drop,
  RE 2048 rows, correlate lag) green; clippy -D warnings + src-tauri check clean; tsc clean; test:re 92, re-qa 8/8,
  re-r2a 158, re-r2a-qa 10/10, re-hardening 67, re-r2b 39, re-r2b-qa 12/12; re_export_qa 29/29; E2E
  `re_r2b_e2e.rs` 2/2 (planted Motorola 15|16 ×0.25 −40 found r=1.0 → draft → DBC → decode exact; merge into
  sample_vehicle.dbc keeps 104 golden frames bit-identical); writer regression 8 fixtures / 7 382 frames identical;
  live bridge smoke OK. Follow-ups: `VFrameFormat` for new FD messages; writer `num()` non-finite guard; bus sync
  signature hashes length only (frontend forces sync on Apply). Not yet clicked through in the running app.

### 7.6 Next after R2b (agreed order, not started)
0. **R2c Value Scan** (§8, Cheat-Engine style) — right after R2b (its "Save signal" reuses the R2b draft dialog).
1. **Offline analysis:** run the RE analyzer over a recorded log (`.log`, `.asc`, `.blf`, `.mf4`) at max speed with
   frame timestamps (heatmap, classifier, inspector, correlation all work on the file).
2. **Two-log diff:** "door open" vs "door closed" logs → bits/IDs that differ.
3. Period/jitter table per ID + new/vanished ID alerts; ASCII row view; ID notes/labels persisted in project.
4. R3 selective replay (counter/checksum auto-fill, Arm/Panic gates), R4 active scanners (heaviest gate).

## 8. R2c — Value Scan ("Cheat Engine" style) (user request 2026-11-19)
Status: **FROZEN 2026-11-19 (R2c started).** Passive only. Idea: like Cheat Engine's memory scan, but the "address space" is
every bit field of every CAN ID. The user scans for a value, changes something on the vehicle (press pedal, open
door, change AC temperature), scans again, and the candidate list shrinks until the signal is found.

### 8.1 Candidate space ("addresses")
Candidate = (bus, arbId, isExtended, startBit, bitLength, byteOrder, valueType). Generated lazily per scan from the RE
rows seen so far (no global enumeration kept in memory):
- lengths: user-selectable set, default {1, 2, 4, 8, 12, 16, 24, 32}; float32 optional; 64 optional;
- byte orders: Intel + Motorola (Motorola only for multi-byte spans); signed + unsigned (signed only when length ≥ 4);
- alignment: default "any bit" (CE "fast scan" analogue = byte/nibble-aligned toggle to shrink the space);
- excluded by default (toggles): bits the classifier marks counter / checksum, constant-only candidates
  (except for an "equals" first scan), error frames.
Hard cap 4 M live candidates (struct-of-arrays: descriptor u64 packed + last value f64 + flags), above the cap →
`[re:scan_too_large]` with a hint to narrow (bus filter, ID filter, lengths, alignment).

### 8.2 Scan types
First scan:
- **Exact value** `= X` (raw), optional tolerance ±t;
- **Exact physical value** `= X` under **scale presets**: factors {1, 0.1, 0.01, 0.001, 0.5, 0.25, 0.125, 1/128,
  1/256, 2, 10} × offsets {0, −40, −50, −100, −273.15 (×0.1 temps), −1000} plus user-defined (factor, offset);
  tolerance default max(1 LSB×factor, 0.5 % of X). The matching preset is kept per candidate;
- **Range** `a ≤ v ≤ b` (raw or physical-with-presets);
- **Unknown initial value** (stores current value of every candidate; nothing filtered).
Next scans (on the surviving set):
- **Changed / Unchanged** since the previous scan — exact, not endpoint-based: each RE row keeps a cheap
  `scan_changed: [u64; 8]` OR-mask of toggled bits since the last scan (one OR per word in ingest, alloc-free); a
  candidate "changed" iff any of its bits toggled in the interval;
- **Increased / Decreased** (endpoints, signed-aware; option "either direction" because the factor sign is unknown);
- **Increased by / Decreased by** `N` (raw or physical-with-preset, tolerance);
- **Exact / Range** again (CE "next scan = new value"), e.g. 50 km/h → 80 km/h;
- **Stable for ≥ T ms** (value constant over the last T ms using the row history ring, `historyCovered` flag when the
  ring is shorter than T).
Every next scan only filters (never adds); **Undo** restores the previous set (keep last 8 sets; older dropped);
**New scan** resets. Value read at scan time = latest payload of the row (option: median of the last N samples to
tolerate noise).

### 8.3 Backend (backend-dev, `crates/nexus-hal/src/pipeline/re_analyzer/re_scan.rs`)
Commands (permission set `re`, Tauri + bridge):
`cmd_re_scan_first(spec) → ReScanStatusDto`, `cmd_re_scan_next(op) → ReScanStatusDto`, `cmd_re_scan_undo()`,
`cmd_re_scan_reset()`, `cmd_re_scan_results(offset, limit ≤ 500, sort) → ReScanResultsDto` (rows: candidate +
current raw + physical (preset) + previous value + change count + classifier kind hint), `cmd_re_scan_status()`.
Scans run on a blocking worker, analyzer lock only for the row payload copy; time budget 2 s with `truncated` flag
(as correlate); generation-counter cancel. Errors `[re:invalid|scan_too_large|not_started|no_scan]`.
**Grouping:** results collapse nested candidates that move identically (e.g. 8-bit inside 16-bit with same changes):
show the widest one with "+N contained" (expandable), so the list stays readable.

### 8.4 Frontend (`src/components/re/ReValueScanPanel.tsx`, store `reScanStore.ts`)
CE-like panel in the RE tab: value input + type select (Exact / Physical (presets) / Range / Unknown), options
(lengths, orders, signed, float, alignment, exclude counter/checksum, bus/ID filter), buttons **First Scan**,
**Next Scan** with op select (Changed / Unchanged / Increased / Decreased / Increased by / Decreased by / Exact /
Range / Stable), **Undo**, **New Scan**; big candidate count + per-step history ("1 284 112 → 9 210 → 312 → 4");
results table (virtualized, `font-mono tabular-nums`, 2 Hz live value refresh of visible rows only) with
**Inspect** (seeds an R2a candidate + plot) and **Save signal** (R2b draft dialog prefilled incl. preset scale) and
"highlight in heatmap". Hotkeys: Enter = Next Scan with last op, Ctrl+Z = Undo. All errors → Debug console `RE`.
Demo source: synthetic engine supports scans (planted pedal / speed signals) DEMO-badged.

### 8.5 Tests / gate (R2c) — QA probes first
Planted 12-bit Motorola speed (factor 0.01) found in ≤ 4 scans: Unknown → Increased → Increased → Exact physical
80 km/h with preset 0.01 → exactly the planted candidate (plus contained group); "Changed" exactness: a bit that
toggles twice between scans (ends equal) counts as changed; Unchanged removes it; Undo restores the exact previous
set; cap → `scan_too_large`; Intel/Motorola/signed values cross-checked with `NormalizedBitSpan`; ingest stays
alloc-free and R1 throughput within 10 % (scan_changed OR-mask cost); scan of 1 M candidates within budget (release).
Gate as R2b + `test:re-r2c(-qa)`.

### 8.6 Amendments (2026-11-19, team-lead, R2c QA probe review)
Assumption blocks + "FROZEN SEMANTICS" S1–S10/S8a in `crates/nexus-hal/tests/re_r2c_qa.rs` and the header of
`src/components/re/re.r2c.qa.test.ts` (`src/types/reScan.ts`, `reScanModel.ts`, `reScanStore.ts` pure parts) are
**authoritative**. Frozen:
1. §8.5 correction: 80 km/h × 0.01 = raw 8000 does not fit 12 bits → probes use 12-bit Motorola `11|12` ending at
   30.00 km/h and 16-bit Motorola `15|16` ending at 80 km/h (signed twin survives too).
2. Presets = full 11 × 6 cross product (66), factor-major; user presets tried first; first match wins and is kept.
3. Motorola candidates only when the span crosses a byte boundary; alignment on the LSB bit index; float32 on every
   32-bit span; float64 only with include64.
4. Exclusion: candidate dropped if it touches any counter/checksum bit, or consists only of constant bits;
   exact/physical first scans ignore `excludeConstant`.
5. `scan_changed` mask cleared by every first/next scan, untouched by undo/reset; `either` = endpoint, `changed` =
   toggles; `changeCount` = endpoint changes.
6. Stable: "now" = newest frame timestamp; `historyCovered` only for stable scans.
7. Undo at depth 0 → `[re:invalid]`; no scan → `[re:no_scan]`; failed calls change nothing; analyzer reset
   invalidates the scan; scans while RE stopped → `[re:not_started]` (status/results still work).
8. Cap counted up front (unknown scans), > 4 M rejected before evaluation; truncated next scan keeps unjudged
   candidates; zero budget evaluates nothing.
9. Grouping: same row, strict bit subset, equal changeCount ≥ 1, same preset; each candidate appears once.
10. kindHint from the classification snapshot taken at first scan. Median = lower median of last N (1..=64).
11. Test hook `ReShared::scan_set_budget` (`#[doc(hidden)]`). Commands: `cmd_re_scan_first {spec}`,
    `cmd_re_scan_next {op}`, `cmd_re_scan_undo {}`, `cmd_re_scan_reset {}`, `cmd_re_scan_status {}`,
    `cmd_re_scan_results {offset, limit, sort}`.

- R2c gate PASS (2026-11-20): nexus-hal debug 363 / release 366 passed, 0 failed; re_r2c_qa 34/34 release
  (planted 16-bit/12-bit match oracle; 1 004 172-candidate unknown scan 50 ms; ingest −0.5 % with scan active; max
  analyzer lock wait 186 ns); E2E `re_r2c_e2e.rs` (scan → R2b draft → DBC → decode exact); test:re-r2c 45,
  test:re-r2c-qa 13/13; CI parity green (fmt, workspace clippy, `cargo test --workspace` 795, every npm test:*, build);
  live bridge smoke OK. Fixed (team-lead): R2a markers reference tie-break by marker id
  (`re_focus.rs` resolve_reference) — release flake 6/10 → 0/8. Not yet clicked through in the running app.

## 9. Session handoff (2026-11-19, before /clear)
- Done + gate green (not committed): Workbench C1, Diagnostic Simulation, RE R1, R2a, RE re-theme + stable plot,
  amendment 13 (NRE2 values: bit glyphs + byte hex), amendment 14 (live RE over nexus_bridge, explicit Demo switch;
  live e2e on vcan0 verified: 10 Hz NRE2, data bytes moving, WS close 1000).
- Backend `debug_log.rs` normalize_category accepts `"RE"` (team-lead edit, tests green).
- Done after the first handoff draft (gate green: tsc; test:re 92, re-qa 8/8, re-r2a 146, re-r2a-qa 10/10,
  re-hardening 67 (new); workbench 37; diagsim 66; bridge tests 16): float µs bug fixed (integer bucket in
  `alignedWindow`/`alignedView` + `src/services/reArgs.ts` integer guard in reClient); every RE error → Debug console
  category `RE` (`src/store/reDebugLog.ts`, 5 s rate limit, ×N) + info events; display options
  `src/store/reDisplay.ts` (`showBits`, `showHex`, `byteFormat`, `showHeat`, `nexus.re.display`) replacing
  `showValues`. nexus_bridge restarted. Not yet seen in a browser by anyone (user to check visually).
- **Resume point:** start R2b (§7), then R2c Value Scan (§8) — QA probes first (`qa-hil-verifier`), then protocol-specialist (generator) +
  backend-dev (command, Tauri + bridge) + frontend-dev (dialog, Found Signals, project persistence) in parallel.
- Open user decisions: commits (5 groups: Workbench C1, Diagnostic Simulation, RE R1, RE R2a, RE UX/live — exclude
  `projects/vehicle-bench-01.nexusproj.json` and `runs/`); Workbench refusal rule for legacy flash flows
  (uds_flash_image not fed by a `file` input can flash the Flash-panel image without CRC check).
- Background processes: `npm run dev` (5173), `nexus_bridge` (14210, restarted with NRE2 + RE routes), nexus-ecu-sim on
  vcan0 (0x7E0/0x7E8, functional 0x7DF, xor_ff seed).
