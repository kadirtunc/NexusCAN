# Contract — DBC Editor Port (Cloud `dbc-editor` → Desktop DBC Studio "Edit DB")

Status: ACTIVE · Owner: team-lead · Frontend-only (no Rust changes).

## 1. Scope
Cloud `NexusCANCloud/src/components/dbc-editor/` (11 files, all dialogs included) has been **copied verbatim**
to `src/components/dbc-editor/` with import paths rewritten:

| Specifier in copied files | Meaning on desktop | Owner |
|---|---|---|
| `./contracts` | NEW local barrel: desktop netdb types + serializer + editor-only DTOs | Agent A |
| `./host` | NEW adapter replacing `cloudApiClient` + `cloudStore` (IPC + `databaseStore`) | Agent A |
| `./i18n/core` | NEW shim of Cloud i18n core API bound to desktop locale | Agent B |
| `./i18n/dbcStudio` | Cloud shard copied unchanged (imports `./core`) | Agent B (only if shim needs it) |
| `./dbcSerializer` | Cloud `contracts/dbcSerializer.ts` copied (imports `../../types/netdb`) | Agent A |

Desktop has **no** `@/` alias, **no** `zustand`, **no** `zod`, **no** `next/*`. Use relative imports and plain TS types.

## 2. Public entry (consumed by `SymbolsLayoutView`)
```ts
// src/components/dbc-editor/index.ts
export interface DbcEditorWorkbenchProps {
  databaseId: string;   // ProjectDatabaseEntry.id from databaseStore
  onClose: () => void;  // return to DBC Studio list
}
export { DbcEditorWorkbench } from './DbcEditorWorkbench';
```

## 3. `./host` adapter (Agent A)
```ts
export interface EditorDatabaseSource {
  databaseId: string; name: string; fileName: string; format: 'dbc' | 'kcd';
  dbcText: string;                    // decoded from ProjectDatabaseEntry.contentBase64 (UTF-8)
  schema: DatabaseSchemaDto;          // entry.schema ?? await apiParseDatabaseSchema(...)
}
export function loadEditorDatabase(databaseId: string): Promise<EditorDatabaseSource>;
/** Validation = apiParseDatabaseSchema(fileName, base64(dbcText)); never mutates the store. */
export function validateDbcText(fileName: string, dbcText: string):
  Promise<{ ok: true; schema: DatabaseSchemaDto } | { ok: false; error: string }>;
/** SAVE (overwrite): same id; fileName extension forced to .dbc only if source was .kcd → then it is a Save As. */
export function saveDatabaseOverwrite(databaseId: string, dbcText: string): Promise<ProjectDatabaseEntry>;
/** SAVE AS: new `<name>.dbc`; id = makeCatalogDbId(fileName); refuse silent overwrite of an existing different id. */
export function saveDatabaseAs(fileName: string, dbcText: string): Promise<ProjectDatabaseEntry>;
```
- Both saves: validate first (Rust parser = safety net), then `databaseStore.upsertDatabaseEntry(entry)`
  (entry shape identical to `buildCatalogEntry` in `SymbolsLayoutView.tsx:54`).
- If the overwritten DB is bound to a bus/connection, re-push bindings using the **existing** path that calls
  `cmd_set_bus_databases` (find it with `graphify query`); do not add new IPC commands.
- Base64 must be UTF-8 safe (`TextEncoder`), not `btoa(str)` on raw strings.

## 4. Workbench de-clouding (Agent A) — remove / replace
- `next/link`, `useRouter`, `router.replace(...)` → removed; navigation = `onClose()`.
- `useCloudStore` (authHydrated, syncingBackend, projects, databases, currentUserRole, loadDatabaseVersionsAsync)
  → removed. Role = always editor. No project selector, no version history list, no diff links.
- `apiGetDatabaseDetail` → `loadEditorDatabase`; `apiValidateDbcEditor` → `validateDbcText`
  (the "wasm" validation state/badge now reflects the Rust parser result — keep UI, rename nothing user-visible).
- `apiSaveDbcEditorVersion` + `CandbSaveVersionModal` → two actions: **Save** (overwrite, `Ctrl+S`) and
  **Save As…** (asks file name, default `<name>_edited.dbc`). For `.kcd` sources, Save behaves as Save As.
- All dialogs (`CandbToolModals`, `CandbSupportDialogs`, `CommMatrixTab`, Message/Signal dialogs) stay functional.

## 5. Integration (Agent B)
- `SymbolsLayoutView.tsx` list row (~L725): add **Edit DB** button right after "Inspect Bit Matrix"
  (same button classes, `Pencil` icon from lucide-react). Add `mode: 'list' | 'inspect' | 'edit'`;
  `edit` renders `<DbcEditorWorkbench databaseId=… onClose={() => setMode('list')} />` filling the view.
- New desktop i18n keys (tr+en) in the existing netdb shard: `netdb.symbols.editDb`.
- `CHANGELOG.md` → `## [Unreleased]` → `Added`: one user-facing line.

## 6. Gates (team-lead runs; no QA agent)
- `npx tsc -p tsconfig.app.json --noEmit` → 0 errors.
- `node scripts/check-theme-tokens.mjs` → PASS (baseline 640; editor files baseline 0 → must be 0 violations).
  Map Cloud colors to existing tokens per `planning/contracts/theme-tokens-v1.md`; never add tokens.
- No `any`, no `backdrop-blur`, numeric/hex fields `font-mono tabular-nums`.
- After edits: `graphify update .` (CLAUDE.md §5.8).

## 7. Kontrol Listesi
- [ ] No `next/`, `@/`, `zod`, `zustand` import left in `src/components/dbc-editor/`.
- [ ] Theme script `--file <each editor file>` = 0.
- [ ] Save on `.kcd` source never writes a `.kcd` entry with DBC text.

## 8. Bit Matrix Drag-to-Move (iteration 2) — Status: ACTIVE · frontend-only

### 8.1 Decisions
- Pointer Events + `setPointerCapture` ONLY. HTML5 DnD (`draggable`, `onDragStart`, `onDrop`) is forbidden:
  Tauri `dragDropEnabled` (default true) swallows HTML5 drag events on Windows.
- Drag threshold 4 px: below = click (existing select / double-click → signal dialog unchanged).
- Commit = exactly ONE `onMoveSignalStartBit(sigId, newStart)` on `pointerup`. No store updates during drag
  (each update triggers a 220 ms Rust revalidation round-trip).
- `Esc` / `pointercancel` / `lostpointercapture` → cancel, no commit. `canMutate === false` → drag disabled.
- Out of range footprint (any bit ∉ `[0, dlc*8)`) → ghost `--status-critical`, drop = no-op. **Never clamp/shift.**
- Overlap with other signals → ghost warning colour, drop ALLOWED (mux signals overlap legitimately; Rust overlap
  diagnostics stay authoritative after commit).
- Click-to-move mode (`moveSelected` / `createNew`) stays.
- Out of scope (next iteration): edge-resize of `bitLength`, keyboard nudging, undo.

### 8.2 Pure helpers — NEW `src/components/dbc-editor/bitDrag.ts` (no React, no imports beyond types)
```ts
export type ByteOrder = SignalSchemaDto['byteOrder']; // 'littleEndian' | 'bigEndian'
/** Linear bit indices (byte*8+bitInByte) occupied by the signal, ordered LSB→MSB.
 *  Intel: start..start+len-1 (start = LSB). Motorola (DBC): start = MSB, sawtooth
 *  (bitInByte 7→0 then next byte bit 7). Returns null if any bit falls outside [0,totalBits). */
export function computeSignalFootprint(startBit: number, bitLength: number, byteOrder: ByteOrder, totalBits: number): number[] | null;
/** New DBC startBit so that the grabbed bit (signalBitIndex, same semantics as BitCellDto) lands on targetLinearBit.
 *  Returns null if the resulting footprint is out of range. */
export function computeDropStartBit(grabbedSignalBitIndex: number, targetLinearBit: number, sig: Pick<SignalSchemaDto,'startBit'|'bitLength'|'byteOrder'>, totalBits: number): number | null;
```
- `signalBitIndex` semantics MUST be taken from Rust `crates/nexus-netdb` bit-layout code (read-only), not guessed.
- Tests `src/components/dbc-editor/bitDrag.test.ts` + `package.json` script `test:bitdrag` (same esbuild pattern as
  `test:decode`). Vectors: Intel in-byte, Intel cross-byte, Motorola in-byte, Motorola cross-byte (e.g. start 7 len 16 →
  bytes 0..1), CAN-FD bit 511 edge, out-of-range → null, round-trip: footprint(computeDropStartBit(k, footprint[k])) == same.
  At least 2 vectors must match cells produced by Rust tests/fixtures in `crates/nexus-netdb`.

### 8.3 UI (`CandbInteractiveBitMatrixTab.tsx`)
- Every bit cell gets `data-bit={linearBit}`; hit-test via `document.elementFromPoint` → closest `[data-bit]`.
- Drag state in `useRef`; React state updated only when target cell changes.
- Ghost: dashed border + signal colour on target footprint; source cells dimmed; `cursor-grabbing` while dragging.
- Info line: `startBit A → B · B03.5 · overlaps: n` (`font-mono tabular-nums`).
- Tokens only (`var(--…)` / existing aliases), no new tokens, no `backdrop-blur`, no `any`, no heavy animations.

### 8.4 Gates
`npx tsc -p tsconfig.app.json --noEmit` = 0 · `npm run test:bitdrag` PASS ·
`node scripts/check-theme-tokens.mjs` PASS and `--file` = 0 for touched editor files · CHANGELOG `Added` line ·
`graphify update .`

### 8.5 Kontrol Listesi
- [ ] No `draggable` / `onDrop` / `onDragStart` in dbc-editor.
- [ ] Exactly one commit per drag; zero commits on cancel/out-of-range.
- [ ] Click and double-click behaviour unchanged below threshold.

## 9. Bit Matrix Mux Page Selector (iteration 3) — Status: ACTIVE · frontend-only

### 9.1 Problem
- Matrix overlays ALL mux pages at once; `deriveBitOverlaps` (`DbcEditorWorkbench.tsx:164`) is NOT mux-aware →
  `m0`/`m1` signals sharing bits are falsely flagged as collisions (red in matrix, tree, list).

### 9.2 Mux model (from Rust DTO, `crates/nexus-netdb/src/ui_dto.rs:229`)
- `muxRole: 'static' | 'masterSwitch' | 'multiplexed'`; multiplexed has `switchSignalId` + `muxRanges` (inclusive
  `[start,end]`, from `mN` or `SG_MUL_VAL_`).
- **Cascaded** (`m2M`): DTO role is `'multiplexed'`, but the signal is ALSO a switch → a switch = any signal that is
  `masterSwitch` OR is referenced as `switchSignalId` by another signal of the same message.
- Switch page labels: switch signal's `enumTable` (VAL_) — `"2 · CHARGING"`, else `"2"` / `"0x02"`.

### 9.3 Pure helpers — NEW `src/components/dbc-editor/muxView.ts` (types-only imports, no React)
```ts
export interface MuxPageOption { value: number; label: string; hasSignals: boolean }
export interface MuxSwitchNode {
  switchId: number;               // signalId of the switch
  parentSwitchId: number | null;  // null for master
  parentRanges: [number, number][]; // switch's own muxRanges on its parent (cascaded); [] for master
  pages: MuxPageOption[];         // union of children muxRanges values ∪ enumTable keys, ascending
}
/** MuxSelection: switchId → selected page value, or 'all' (overlay, legacy view). */
export type MuxSelection = ReadonlyMap<number, number | 'all'>;
export function buildMuxSwitchTree(messageSignals: readonly SignalSchemaDto[]): MuxSwitchNode[]; // master first, then depth order
export function defaultMuxSelection(tree: readonly MuxSwitchNode[]): Map<number, number | 'all'>; // each switch → first page
/** Switch nodes whose combobox must be shown under the current selection (sub-switch hidden if its parent page excludes it). */
export function visibleSwitchNodes(tree: readonly MuxSwitchNode[], sel: MuxSelection, signalMap: ReadonlyMap<number, SignalSchemaDto>): MuxSwitchNode[];
/** static/master → true; multiplexed → own switch selection 'all' or value ∈ muxRanges, AND its switch is itself visible (recursive). */
export function isSignalVisibleOnPage(sig: SignalSchemaDto, sel: MuxSelection, signalMap: ReadonlyMap<number, SignalSchemaDto>): boolean;
/** Selection that makes `sig` visible (walk up the chain, pick first value of each range) — used when a hidden signal is selected. */
export function selectionRevealingSignal(sig: SignalSchemaDto, current: MuxSelection, signalMap: ReadonlyMap<number, SignalSchemaDto>): Map<number, number | 'all'>;
/** true if a and b can never be active in the same frame: there is a common switch S on both activation chains
 *  for which their ranges on S are disjoint. Switch vs its own children → false (real collision). */
export function areMuxExclusive(a: SignalSchemaDto, b: SignalSchemaDto, signalMap: ReadonlyMap<number, SignalSchemaDto>): boolean;
```
- Page explosion guard: if a range spans > 256 values, emit only its start and end as options (label `"a…b"` on start).
- Cycle guard in every chain walk (max depth 16).

### 9.4 UI (`CandbInteractiveBitMatrixTab.tsx`)
- If message has ≥1 switch: toolbar row above matrix, one `<select>` per `visibleSwitchNodes` entry:
  `<switch name>: [All pages (overlay) | 0 · IDLE | 1 · DRIVE …]`, cascaded selects indented with `↳`.
  Option for pages with no signals shown with `(empty)` suffix. `font-mono tabular-nums`, existing select styling in file.
- Default selection = `defaultMuxSelection` (first page); reset when `selectedMessage.messageKey` changes.
- Matrix shows only cells whose signal `isSignalVisibleOnPage`; signal legend list below matrix filtered the same way.
- Collision colouring in page mode = >1 visible signal on a cell (computed locally). In `'all'` mode = only pairs that
  are NOT `areMuxExclusive` (mux pages drawn overlaid, distinct from collisions — e.g. existing dimmed/striped style,
  tokens only).
- Selecting a hidden signal (prop `selectedSignal` changes from tree/list) → `selectionRevealingSignal`.
- Drag (§8): only visible signals draggable; ghost overlap count uses visible, non-exclusive signals only.
- Header shows active page summary: `Mode=2 · SubMode=1 · 7 signals`.

### 9.5 Overlap fix (`DbcEditorWorkbench.tsx` `deriveBitOverlaps` only)
- Group per cell as today, but report only signal pairs where `!areMuxExclusive(a,b)`; `signalNames` = the
  non-exclusive set. No other workbench changes.

### 9.6 Out of scope
- Creating a new signal on the currently selected page (auto `m<page>`) — next iteration.

### 9.7 Gates
`npx tsc -p tsconfig.app.json --noEmit` = 0 · `npm run test:muxview` PASS · `npm run test:bitdrag` still PASS ·
theme `--file` = 0 for touched files + global PASS · CHANGELOG `Added` (+ `Fixed` for false mux collisions) ·
`graphify update .`

### 9.8 Kontrol Listesi
- [ ] Cascaded `m2M` treated as switch AND multiplexed.
- [ ] `m0` vs `m1` on same switch → exclusive; switch vs its child → not exclusive; static vs anything → not exclusive.
- [ ] Sub-switch combobox hidden when parent page excludes it.
- [ ] No new colour tokens.

## 10. Network Nodes Graph (iteration 4) — Status: ACTIVE · frontend-only

### 10.1 Placement
- `CandbListView.tsx` "VIEW 2: NETWORK NODES (ECUs) FOLDER" (~L698): segmented toggle **Table | Graph** in the
  view header; Table = current table unchanged. Graph = NEW `CandbNodeGraph.tsx` filling the view.
- Optional prop on `CandbListView`: `nodeGraphStorageKey?: string` — workbench passes
  `nexuscan.dbcEditor.nodeGraph.<databaseId>` (only that one prop change in `DbcEditorWorkbench.tsx` ~L2159).

### 10.2 Pure model — NEW `src/components/dbc-editor/nodeGraphModel.ts` (types-only imports, no React/DOM)
```ts
export const UNASSIGNED_NODE = '__unassigned__'; // Vector__XXX / empty transmitter or no receivers
export interface GraphEdgeMessage { messageKey: string; name: string; arbId: number; isExtended: boolean;
  dlc: number; cycleMs: number | null; signalNames: string[] /* signals of this msg received by target */ }
export interface GraphEdge { id: string /* `${from}->${to}` */; from: string; to: string;
  messages: GraphEdgeMessage[] /* sorted by arbId */; hasReverse: boolean }
export interface GraphNodeModel { name: string; txCount: number; rxCount: number; isUnassigned: boolean }
export function buildNodeGraph(schema: DatabaseSchemaDto, opts: { includeUnassigned: boolean }):
  { nodes: GraphNodeModel[]; edges: GraphEdge[] };
/** Normalised (0..1) deterministic circle: nodes sorted by name, angle starts at top, clockwise; unassigned at centre. */
export function circularLayout(nodeNames: readonly string[]): Record<string, { x: number; y: number }>;
/** Quadratic-bezier control point; bidirectional pairs bend to opposite sides (offset sign by from<to). */
export function edgeControlPoint(a: Pt, b: Pt, hasReverse: boolean, bend: number): Pt;
/** Distance from p to the sampled quadratic curve (24 samples) — edge hit-testing. */
export function distanceToEdge(p: Pt, a: Pt, c: Pt, b: Pt): number;
export function edgeWidth(messageCount: number): number; // 1..5 px, log scale
export function serializeLayout(pos: Record<string, Pt>): string; export function parseLayout(raw: string | null): Record<string, Pt>; // tolerant, drops non-finite
```
- Edge rule: for message M, each transmitter T (∉ {'', 'Vector__XXX'} else UNASSIGNED) → each receiver R in the
  union of M's signals' `receivers` (R ≠ T, R ∉ {'', 'Vector__XXX'}); no receivers → T → UNASSIGNED.
- Aggregate per directed pair; ECUs from `schema.ecus` always appear as nodes even with no edges.

### 10.3 Canvas component — NEW `src/components/dbc-editor/CandbNodeGraph.tsx`
Props: `{ schema: DatabaseSchemaDto; storageKey?: string; onOpenMessageDialog(key: string, openLayoutTab?: boolean): void; onOpenEcuDialog(name: string): void }`
- HTML5 Canvas, DPR-scaled, `ResizeObserver`, redraw via `requestAnimationFrame` only when dirty. Colours ONLY via
  `readThemeColor()` from `src/utils/themeTokens.ts` + re-read on `subscribeThemeChange`. Never add tokens.
- Nodes: rounded rects, ECU name + `TX n · RX m` (monospace). Edges: quadratic curves with arrowheads, width =
  `edgeWidth`, bidirectional pairs as two separate arcs.
- **TX vs RX look (required):** with a focus node (hovered, else selected): outgoing = TX → solid `--series-1`;
  incoming = RX → dashed `--series-2`; unrelated edges/nodes dimmed (globalAlpha ≈ 0.2). No focus: all edges
  `--border-strong`, solid. Legend in corner: `── TX` / `- - RX`.
- **Edge hover tooltip** (DOM overlay near cursor, not canvas text, `font-mono tabular-nums`): header
  `BMS → VCU · 3 messages`; rows `0x101  BMS_Status  DLC 8  100 ms  4 sig` (cycle `—` if null), max 12 rows + `+k more`.
  Hovered edge highlighted. Hit threshold 6 px (screen space).
- Click edge → pinned side panel with the full message list; row click → `onOpenMessageDialog(key, false)`. `Esc` unpins.
- **Node drag** (Pointer Events + `setPointerCapture`, 4 px threshold; below = click → select/focus;
  double-click → `onOpenEcuDialog`). Empty-area drag = pan; wheel = zoom (0.3..3) around cursor.
- Positions persisted (normalised) to `localStorage[storageKey]` on drag end; missing nodes → circular slot.
  Toolbar: **Reset layout** (back to circle), **Fit**, checkbox **Show unassigned**.
- No HTML5 DnD, no `any`, no backdrop-blur, no heavy animation (no physics simulation).

### 10.4 Out of scope (next iteration — editing)
- Shift-drag node→node to add receiver, edge/context action to remove receiver, change transmitter.
  The model must keep `messages[].messageKey` so these can be layered on later.

### 10.5 Gates
`npx tsc -p tsconfig.app.json --noEmit` = 0 · `npm run test:nodegraph` PASS · existing `test:muxview`,
`test:bitdrag` PASS · theme global PASS and `--file` = 0 for touched files · CHANGELOG `Added` · `graphify update .`

### 10.6 Kontrol Listesi
- [ ] TX solid / RX dashed only relative to focus node; legend present.
- [ ] Bidirectional A↔B drawn as two distinct arcs, each hit-testable.
- [ ] Vector__XXX never shown as a real ECU.
- [ ] Layout survives resize (normalised coords) and reload (localStorage), corrupt storage ignored.

### 10.7 Details sidebar (revision)
- One right sidebar (flex sibling of the canvas, ~320px, `border-l border-hairline bg-panel`, scrollable) replaces the
  pinned edge panel. Canvas shrinks while open; positions stay normalised.
- Node selected (click without drag): header name + `TX n · RX m` + "Open ECU" (`onOpenEcuDialog`); sections Incoming (RX) /
  Outgoing (TX) grouped by peer (`nodeTraffic`, peers sorted by name), message rows `0x101  Name  DLC 8  100 ms`, received
  signal names below (collapse after 6 with `+k`); group header hover/click highlights that edge. Unassigned uses its label.
- Edge selected: header `from → to`, TX(solid)/RX(dashed) chips, message count, `reverse: n messages` button when
  `hasReverse` switches to the reverse edge; message rows as above.
- Row click -> `onOpenMessageDialog(key, false)`. Close (x), Esc or click on empty canvas (not pan) closes + clears selection.
  Node focus styling (TX solid / RX dashed) stays while the sidebar is open.
- Pure `nodeTraffic(graph, ecu): { incoming, outgoing }` in `nodeGraphModel.ts` (groups carry `peer`, `edgeId`, `messages`).

### 10.8 Edge labels (experimental)
- Optional pill labels at curve midpoints (name or `n msg`, zoom-gated, greedy overlap skip, label hover = edge hover); toolbar toggle default ON, not persisted; isolated in `drawEdgeLabels`.
