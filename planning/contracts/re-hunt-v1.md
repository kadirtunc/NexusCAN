# RE Hunt v1 — Labelled-State Signal Hunt, offline-first (team-lead contract)

Status: **DRAFT 2026-11-23** — user direction: "offline (trace) da yapabilmek; hem MCP'li hem MCP'siz". Freezes on user
approval of §9. Parent: `re-toolkit-v1.md` (R1/R2a/R2b/R2c done). This file is the active contract for R2d → M4-RE.

## 0. Goal & phases
Find a signal (brake switch, gear, door, steering…) by labelling time spans of a recording with the vehicle state
("pressed" / "released", "P/R/N/D") and filtering every bit field of every ID down to the ones that explain the labels.
**Offline is the core**: one recording in the car, analysis at the desk, repeatable. Live mode = the same engine fed by a
recording made by the wizard. MCP is a thin wrapper over the same engine functions — the UI alone must do everything.

| Phase | Scope | Bus impact |
| :--- | :--- | :--- |
| **R2d (this file, frozen part)** | Offline hunt engine (State Pattern, binary + multi-state), trace labels sidecar, Trace-view labelling UI, Hunt panel (results, candidate plot, → R2b draft dialog) | none (file analysis) |
| R2e | Guided recording wizard (live: "Şimdi frene basın" → [Yaptım] → label written into the recording's sidecar), multi-trace intersection UX, raw bit-diff view | passive (Listen-Only) |
| R2f | Sweep recipe (steering/pedal: monotonic + return-to-start), Known-value recipe (dashboard reading → R2c Exact-physical presets on a labelled instant), OBD-reference recipe (R2a correlate over a trace) | none |
| M4-RE | MCP `re_hunt` + `re_labels_get`; every state-changing / run step behind `ui_confirm` | none (MCP never writes files) |

## 1. Invariants
- Pure analysis over a parsed file; **never touches the reader thread, aggregator or 60 Hz StateTable**. Live RE (R1/R2c)
  state is not read or modified by a hunt run.
- Input frames = `replay::parse_trace_entries_from_bytes` → `Vec<CompiledReplayEntry>` (`rel_us`, `RawCanFrame`); all
  formats replay supports (`.log`, `.asc`, `.blf`, `.mf4` when present). Time = `rel_us` (file time, never wall clock).
- Bit numbering = DBC Intel numbering (`re-toolkit-v1.md` §1); all masks sized 512 bits (CAN-FD 64 B).
- Deterministic: same inputs + spec ⇒ byte-identical result JSON (stable sort keys, no HashMap iteration order leaks).
- Bounded: ≤ 8 traces, ≤ 4 000 000 frames total, ≤ 64 segments, ≤ 16 labels, ≤ 4 M candidates evaluated, time budget
  10 s (`truncated: true` + partial results), generation-counter cancel. Above a cap → `[re:hunt_too_large]` with a hint.
- Two result slots: owner `ui` and owner `mcp`. An MCP run never overwrites, cancels or reads-and-mutates the UI slot;
  a UI run cancels a running MCP run, never the reverse.
- Files: only the UI path writes the labels sidecar. MCP never writes/deletes files.

## 2. Labels (sidecar) — DTO shared Rust ↔ TS (camelCase)
Stored next to the trace: `<traces_dir>/<file_name>.labels.json` (name validated against `cmd_list_traces`, no path
traversal; sidecars are hidden from the trace list).
```ts
interface ReTraceLabelsDto {
  version: 1;
  fileName: string;
  labels: { id: string /* ≤32, [A-Za-z0-9_-] */; name: string /* ≤64, e.g. "Basılı" */ }[];   // ≤16
  segments: { labelId: string; startUs: number; endUs: number; source: 'manual' | 'wizard' | 'mcp'; note?: string }[]; // ≤64
}
```
Rules: `startUs < endUs`, inside `[0, durationUs]`, segments must not overlap (adjacent allowed), integers only.
Invalid file → `[re:labels_invalid]` naming the first bad field; never a partial load.

## 3. Engine — `crates/nexus-hal/src/pipeline/re_analyzer/re_hunt.rs` (new, pure, no I/O)
### 3.1 Spec / result DTOs
```rust
#[serde(rename_all = "camelCase")]
pub struct ReHuntSpecDto {
    pub inputs: Vec<ReHuntInputDto>,          // 1..=8
    pub options: ReScanOptionsDto,            // reused from R2c (lengths, byte orders, signed, alignment, buses, ids, exclude_counter_checksum)
    pub settle_ms: u32,                       // default 300: trimmed from each segment start
    pub tail_ms: u32,                         // default 100: trimmed from each segment end
    pub glitch_pct: f32,                      // default 2.0: max minority share for a bit to count as stable in a segment
    pub min_frames_per_segment: u32,          // default 3: below → row "not covered" in that segment
    pub min_coverage: f32,                    // default 1.0: share of segments a candidate must be stable+consistent in
    pub restrict_to: Option<Vec<ReHuntCandidateKeyDto>>, // refine: only re-test these (previous run / other trace)
}
pub struct ReHuntInputDto { pub file_name: String, pub labels: ReTraceLabelsDto }  // labels inline (UI: from sidecar)
pub struct ReHuntCandidateKeyDto { pub bus: u8, pub arb_id: u32, pub is_extended: bool,
    pub start_bit: u16, pub bit_length: u8, pub byte_order: ReByteOrder, pub signed: bool }
pub struct ReHuntResultDto {
    pub run_id: u64, pub owner: String /* "ui"|"mcp" */, pub truncated: bool, pub cancelled: bool,
    pub frames: u64, pub rows: u32, pub segments_used: u32, pub candidates_evaluated: u64, pub survivors: u32,
    pub elapsed_ms: u32, pub warnings: Vec<String>,   // e.g. "label 'Basılı' has only 1 segment — weak evidence"
    pub labels: Vec<String>,                          // label ids in column order of value_per_label
}
pub struct ReHuntRowDto {                             // via cmd_re_hunt_results (paged)
    pub key: ReHuntCandidateKeyDto, pub value_per_label: Vec<i64>, // settled raw value per label (column order above)
    pub coverage: f32, pub segments_matched: u32, pub segments_total: u32,
    pub lag_ms_median: Option<f32>, pub lag_ms_spread: Option<f32>, // signed: value change vs segment start
    pub glitch_pct_max: f32, pub score: f32, pub equivalents: u32,     // wider fields collapsed into this one (§3.3)
    pub kind_hint: Option<String>,                                     // classifier: flag / enum / physical / counter…
}
```

### 3.2 Algorithm (State Pattern)
1. Parse each input (cache by `(file_name, size, updated_at)` like MCP `TraceCache`); apply bus/id filters.
2. Per (row, segment) — streaming, alloc only at row creation: over frames with `rel_us ∈ [start+settle, end−tail]`
   count ones per bit (`u32[512]` scratch reused per segment), then reduce to `settled: [u8;64]` (majority) and
   `stable: [u64;8]` (minority ≤ `glitch_pct`) + frame count. Kept: 128 B + count per (row, segment) (≤ 2048 rows × 64).
3. Candidates = R2c candidate generator (refactor it to a pure fn shared by `re_scan.rs` and `re_hunt.rs`; R2c
   behaviour and tests unchanged) restricted to rows covered in ≥ `min_coverage` of segments, or `restrict_to`.
   Counter/checksum rows/fields excluded via the offline classifier (§3.4) when `exclude_counter_checksum`.
4. A candidate is consistent in a segment iff all its bits are `stable` there; its value = extract from `settled`.
   Survives iff: consistent in ≥ `min_coverage` of segments; all consistent segments with the same label give the same
   raw value; **every pair of different labels gives different values**; at least 2 labels present.
5. Lag (survivors only, capped at the top 2 000 by pre-score): for each segment whose previous segment has another label,
   scan frames from `prev.end − 2 s` to `start + settle` for the first time the candidate takes the new label's value and
   keeps it until settle; lag = that time − `start` (signed, ms). Median + spread (p90 − p10).
6. Score (documented, unit-tested): coverage first, then lag spread (lower better), glitch, then narrower width.

### 3.3 Grouping
A wider candidate whose extra bits are constant (same value) across all used segments explains nothing more than its
narrowest contained survivor ⇒ collapsed into it (`equivalents += 1`, expandable via `cmd_re_hunt_equivalents`).

### 3.4 Offline classifier
`ReAnalyzer` gets an offline time mode (`ReAnalyzer::new_offline()`: frame time = `rel_us`, no `now_monotonic_us`);
the hunt ingests the inputs into a private instance and uses its classifier for `kind_hint` and counter/checksum
exclusion. The live analyzer instance is never used.

### 3.5 Candidate series (verification plot)
`series(input_index, key, max_points ≤ 2000) -> { points: [[t_us, min, max]], segments }` — min/max decimated raw value
over the whole trace plus segment bands, for the UI plot and MCP.

## 4. Commands (backend; permission set `re`; Tauri + `nexus_bridge`; engine methods in `pipeline/mod.rs`)
| Command | Args | Result |
| :--- | :--- | :--- |
| `cmd_re_labels_load` | `{ fileName }` | `ReTraceLabelsDto \| null` |
| `cmd_re_labels_save` | `{ fileName, labels }` | `ReTraceLabelsDto` (validated, atomic write tmp+rename) — UI only, never exposed to MCP |
| `cmd_re_hunt_run` | `{ spec }` | `ReHuntResultDto` (owner `ui`; blocking worker; previous UI run cancelled) |
| `cmd_re_hunt_cancel` | `{}` | `null` |
| `cmd_re_hunt_results` | `{ offset, limit ≤ 500, sort: 'score'\|'id'\|'width'\|'lag' }` | `{ rows: ReHuntRowDto[], nextOffset: number \| null, runId }` |
| `cmd_re_hunt_equivalents` | `{ key }` | `ReHuntCandidateKeyDto[]` (≤ 64) |
| `cmd_re_hunt_series` | `{ inputIndex, key, maxPoints }` | §3.5 |
Errors: `[re:hunt_invalid|hunt_too_large|hunt_cancelled|trace_not_found|labels_invalid|no_hunt]`, logged to the
Debug console category `RE`. Engine exposes owner-parameterised fns so MCP calls them with owner `mcp`.

## 5. Frontend (`src/components/re/**`, `src/components/TraceView.tsx` labelling only, stores, `src/types/re.ts`)
- **Trace labelling:** in TraceView a label band above the timeline: create labels (name), drag to create a segment,
  resize/delete, keyboard shortcuts `1..9` = label for the selected span; save/load sidecar; overlap rejected inline.
- **Hunt panel** (RE tab, sub-view "Avlama / Hunt"): pick 1..8 traces (each shows its label coverage), options
  (lengths, byte orders, settle/tail, glitch, coverage), Run / Cancel / "Refine with these results" (→ `restrict_to`).
  Results table (virtualised): ID, bits, order, value per label (with label names), coverage, lag, score, equivalents,
  kind hint. Row → candidate plot (Canvas, segment bands, theme tokens) and **"Sinyal olarak kaydet"** → the existing
  R2b draft dialog prefilled (multi-state ⇒ `value_table` from label names, binary ⇒ 2 entries).
- `font-mono tabular-nums` for numbers; colours only via theme tokens; i18n tr/en shards; no `any`.

## 6. MCP (phase M4-RE, after R2d gate) — `crates/nexus-mcp/src/server/re.rs`, `tools_re.rs`
- `re_labels_get { file_name }` — read-only.
- `re_hunt { op: "run"|"results"|"equivalents"|"series"|"cancel", … }`: `run` takes inputs with **inline** labels
  (sidecar or Claude-proposed segments; `source: "mcp"`); every `run` and `cancel` first asks `ui_confirm` showing the
  traces, labels and segment count — reject/timeout ⇒ nothing runs. Owner slot `mcp` only. ≤ 16 KB responses.
- MCP never calls `cmd_re_labels_save`; to persist Claude-proposed labels it asks the user via `ui_notify` to save them
  in the Trace view (UI Bridge may open the view with the proposal pre-filled — user clicks Save).

## 7. Tests / gate (R2d) — QA probes first
Fixture generator (`scripts/` or `crates/nexus-hal/tests/fixtures`, deterministic seed) writes candump `.log` + labels:
brake bit (0x1A0 byte3 bit5, Intel), gear 3-bit Motorola in 0x3F1 (P=0 R=7 N=6 D=1), 4-bit counter + XOR checksum,
moving 16-bit RPM, a bit that follows "pressed" only in 1 of 3 cycles, a bit flickering 30 % while pressed, a 29-bit
ID, a CAN-FD 64 B frame with a 1-bit flag at bit 400, a frame missing inside one segment.
Acceptance:
- 3 press/release cycles ⇒ brake bit is rank 1, flicker / 1-of-3 / counter / checksum / RPM absent; 1 cycle ⇒ warning.
- Gear ⇒ single survivor with `value_per_label = [0,7,6,1]`; Intel-misread variants absent.
- Two traces (pressed-only file + released-only file, whole-file segments) ⇒ same brake result (two-log diff case).
- `restrict_to` from run 1 + new trace ⇒ intersection; determinism (two runs byte-identical JSON).
- Caps → `[re:hunt_too_large]`; cancel mid-run ⇒ `cancelled: true`; empty/garbage/overlapping labels ⇒ typed error, no panic.
- Live path untouched: existing R1/R2c tests + `qa_hotpath` (50k fps, `dropped_frames == 0`) unchanged.
- Light gate: `cargo test -q -p nexus-hal`, `(cd src-tauri && cargo check -q && cargo clippy -q --all-targets -- -D warnings)`,
  `npx tsc -p tsconfig.app.json --noEmit`, `node scripts/check-theme-tokens.mjs`. Full gate at R2d end (opus).

## 8. Agent split (R2d)
| Agent | Files | Scope |
| :--- | :--- | :--- |
| qa-hil-verifier (first) | `crates/nexus-hal/tests/re_hunt_qa.rs`, fixture generator | §7 probes (expected to fail until engine lands) |
| backend-A | `re_analyzer/re_hunt.rs` (new), `re_scan.rs` (generator extraction only), `re_analyzer.rs` (`new_offline`) | §3 |
| backend-B | `pipeline/re_labels.rs` (new), `pipeline/mod.rs` (engine methods), `src-tauri` commands + `permissions/re.toml` + bridge routes | §2, §4 (against §3 signatures; stub until A lands) |
| frontend-dev (sonnet) | `src/types/re.ts`, `src/store/reHuntStore.ts`, `src/components/re/ReHuntPanel.tsx`, TraceView label band, i18n | §5 |

## 9. Open decisions (user)
1. Sidecar location `<file>.labels.json` next to the trace (portable with the file) vs inside the project file.
2. Default `min_coverage = 1.0` (strict: every segment must match) vs 0.9 (tolerates one bad label in 10+ segments).
3. R2d UI language for labels: free text (user types "Basılı") with presets ("Basılı/Bırakılı", "P/R/N/D", "Açık/Kapalı").

## 10. Checklist (implementers verify before delivery; QA adds failure classes here)
- [ ] No wall-clock time in hunt paths; only `rel_us`.
- [ ] No per-frame allocation; per-(row,segment) state allocated once; `u32[512]` scratch reused.
- [ ] Every cap enforced before allocation; integer µs everywhere (no float µs).
- [ ] UI and MCP slots isolated; MCP cannot reach `cmd_re_labels_save`.
- [ ] R2c generator extraction: R2c tests pass unchanged.
- [ ] Theme tokens only, `font-mono tabular-nums`, i18n tr/en, no `any`.
