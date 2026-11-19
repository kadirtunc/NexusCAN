/**
 * QA gate probes (written BEFORE implementation) for RE Toolkit R2c "Value Scan" (Cheat-Engine style)
 * (planning/contracts/re-toolkit-v1.md §8.2, §8.4, §8.5 frontend items). Pure: no Tauri, no DOM.
 * Run: `npm run test:re-r2c-qa` (from the repo root).
 *
 * ============================================================================================
 * ASSUMPTION BLOCK (authoritative TS API; mirrors crates/nexus-hal/tests/re_r2c_qa.rs)
 * ============================================================================================
 * `src/types/reScan.ts` (Rust serde camelCase mirror; ReByteOrder / ReValueType / ReTargetDto / ReFieldKind
 * reused from `src/types/re.ts`):
 *   export type ReScanKind = 'exact' | 'physical' | 'range' | 'unknown';     // 'physical' = exact physical value
 *   export type ReScanAlignment = 'any' | 'nibble' | 'byte';
 *   export type ReScanReadMode = { kind: 'latest' } | { kind: 'median'; samples: number };   // samples 1..64
 *   export interface ReScalePresetDto { factor: number; offset: number }
 *   export interface ReScanOptionsDto { lengths: number[]; byteOrders: ReByteOrder[]; signed: boolean[];
 *     float32: boolean; include64: boolean; alignment: ReScanAlignment; excludeCounterChecksum: boolean;
 *     excludeConstant: boolean; buses: number[] | null; ids: ReTargetDto[] | null; readMode: ReScanReadMode }
 *   export interface ReScanFirstSpec { kind: ReScanKind; value: number | null; tolerance: number | null;
 *     range: [number, number] | null; physical: boolean /* range only *\/; presets: ReScalePresetDto[] | null
 *     /* null = standard grid *\/; userPresets: ReScalePresetDto[]; options: ReScanOptionsDto }
 *   export type ReScanOpKind = 'changed' | 'unchanged' | 'increased' | 'decreased' | 'either' | 'increasedBy'
 *     | 'decreasedBy' | 'exact' | 'range' | 'stable';
 *   export interface ReScanNextOp { op: ReScanOpKind; value: number | null; tolerance: number | null;
 *     range: [number, number] | null; stableMs: number | null; physical: boolean; presets: ReScalePresetDto[] | null }
 *   export type ReScanSort = 'id' | 'changes' | 'width';
 *   export interface ReScanStatusDto { active: boolean; scanId: number; step: number; candidates: number;
 *     history: number[]; truncated: boolean; elapsedMs: number; undoDepth: number; historyCovered: boolean | null }
 *   export interface ReScanCandidateDto { bus: number; arbId: number; isExtended: boolean; startBit: number;
 *     bitLength: number; byteOrder: ReByteOrder; valueType: ReValueType }
 *   export interface ReScanResultRowDto { candidate: ReScanCandidateDto; preset: ReScalePresetDto | null;
 *     currentRaw: number | null; currentPhysical: number | null; previousRaw: number | null; changeCount: number;
 *     kindHint: ReFieldKind | null; containedCount: number; contained: ReScanCandidateDto[] }
 *   export interface ReScanResultsDto { scanId: number; step: number; total: number; candidates: number;
 *     offset: number; rows: ReScanResultRowDto[] }
 *
 * `src/components/re/reScanModel.ts` (pure, no imports from stores / Tauri):
 *   export const RE_SCAN_MAX_CANDIDATES = 4_000_000; RE_SCAN_MAX_UNDO = 8; RE_SCAN_MAX_RESULTS = 500;
 *   export const RE_SCAN_DEFAULT_LENGTHS: readonly number[] = [1, 2, 4, 8, 12, 16, 24, 32];
 *   export const RE_SCAN_PRESET_FACTORS: readonly number[] = [1, 0.1, 0.01, 0.001, 0.5, 0.25, 0.125, 1/128, 1/256, 2, 10];
 *   export const RE_SCAN_PRESET_OFFSETS: readonly number[] = [0, -40, -50, -100, -273.15, -1000];
 *   export const RE_SCAN_PRESETS: readonly ReScalePresetDto[];   // 66 = full cross product, FACTOR-major
 *   export const RE_SCAN_NEXT_OPS: readonly ReScanOpKind[];      // the 10 ops in the ReScanOpKind order above
 *   export function defaultScanOptions(): ReScanOptionsDto;      // contract defaults, fresh object every call
 *   export function formatScanCount(n: number): string;          // integer, thousands groups joined by ' '
 *                                                                // (U+0020): 1284112 -> '1 284 112'; non-finite -> '—'
 *   export function formatScanHistory(h: readonly number[]): string;   // counts joined by ' → ' ('' for [])
 *   export function defaultPhysicalTolerance(x: number, factor: number): number;  // max(|factor|, 0.005·|x|)
 *   export function opNeedsValue(op: ReScanOpKind): boolean;     // increasedBy, decreasedBy, exact
 *   export function opNeedsRange(op: ReScanOpKind): boolean;     // range
 *   export function opNeedsStableMs(op: ReScanOpKind): boolean;  // stable
 *   export function opSupportsPhysical(op: ReScanOpKind): boolean;  // increasedBy, decreasedBy, exact, range
 *   export function validateFirstSpec(spec: ReScanFirstSpec): string[];   // [] = valid; unique issue codes:
 *     // value_required (exact/physical & value null), value_not_finite, tolerance_invalid (negative / non-finite),
 *     // range_required (range & null), range_invalid (non-finite or a > b), presets_empty (physical matching
 *     // set userPresets ++ (presets ?? grid) is empty), preset_invalid (factor 0 / non-finite, offset non-finite),
 *     // lengths_empty, length_out_of_range (not an integer 1..32), byte_orders_empty, signed_empty,
 *     // median_samples (not an integer 1..64), buses_empty, bus_out_of_range (not an integer 0..255), ids_empty,
 *     // id_out_of_range (bus not 0..255, arbId not an integer 0..0x7FF std / 0..0x1FFFFFFF ext)
 *   export function validateNextOp(op: ReScanNextOp): string[];   // [] = valid; codes: value_required,
 *     // value_not_finite, tolerance_invalid, range_required, range_invalid, stable_ms_invalid (null / non-integer /
 *     // outside 1..600000 for 'stable'), presets_empty (physical && presets = []), preset_invalid.
 *     // Fields irrelevant to the op are ignored (e.g. value on 'changed').
 *   export interface ReScanKeyEvent { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean;
 *     altKey: boolean; targetIsEditable: boolean }
 *   export function scanHotkeyAction(e: ReScanKeyEvent): 'next' | 'undo' | null;
 *     // 'Enter' without ctrl/meta/alt/shift -> 'next' (also inside the value input);
 *     // Ctrl+Z or Meta+Z (key 'z'/'Z'), no shift/alt, target NOT editable -> 'undo' (editable -> null: native
 *     // text undo); Ctrl+Shift+Z and everything else -> null.
 *   export function scanCandidateKey(c: ReScanCandidateDto): string;   // stable, unique per candidate identity
 *   export function scanRowToInspect(row: ReScanResultRowDto): { target: ReTargetDto; candidate: ReCandidateDto };
 *     // Inspect / Save-signal seed: target from the candidate; candidate bits/order/type copied; factor/offset
 *     // from the row's preset, else 1 / 0.
 *
 * `src/store/reScanStore.ts` exports these pure parts (module import must not touch DOM / localStorage):
 *   export interface ReScanUiState { status: ReScanStatusDto | null; lastOp: ReScanNextOp | null; busy: boolean;
 *     error: string | null }
 *   export function initialReScanUiState(): ReScanUiState;   // { status: null, lastOp: null, busy: false, error: null }
 *   export type ReScanUiAction =
 *     | { type: 'begin' }                                     // busy = true, error = null
 *     | { type: 'firstDone'; status: ReScanStatusDto }        // status set, busy false, error null, lastOp kept
 *     | { type: 'nextDone'; status: ReScanStatusDto; op: ReScanNextOp }   // + lastOp = op
 *     | { type: 'undoDone'; status: ReScanStatusDto }         // lastOp kept
 *     | { type: 'resetDone'; status: ReScanStatusDto }        // lastOp kept (Enter after New scan repeats it)
 *     | { type: 'failed'; message: string };                  // busy false, error = message, status kept
 *   export function reScanReducer(s: ReScanUiState, a: ReScanUiAction): ReScanUiState;  // pure, never mutates,
 *                                                                                       // always a new object
 *   export function hotkeyNextOp(s: ReScanUiState): ReScanNextOp | null;
 *     // Enter = Next Scan with the last op: lastOp when status?.active && !busy, else null
 *   export function canUndo(s: ReScanUiState): boolean;      // status?.active && status.undoDepth > 0 && !busy
 * ============================================================================================
 */
import {
  RE_SCAN_DEFAULT_LENGTHS,
  RE_SCAN_MAX_CANDIDATES,
  RE_SCAN_MAX_RESULTS,
  RE_SCAN_MAX_UNDO,
  RE_SCAN_NEXT_OPS,
  RE_SCAN_PRESETS,
  RE_SCAN_PRESET_FACTORS,
  RE_SCAN_PRESET_OFFSETS,
  defaultPhysicalTolerance,
  defaultScanOptions,
  formatScanCount,
  formatScanHistory,
  opNeedsRange,
  opNeedsStableMs,
  opNeedsValue,
  opSupportsPhysical,
  scanCandidateKey,
  scanHotkeyAction,
  scanRowToInspect,
  validateFirstSpec,
  validateNextOp,
} from './reScanModel';
import type { ReScanKeyEvent } from './reScanModel';
import { canUndo, hotkeyNextOp, initialReScanUiState, reScanReducer } from '../../store/reScanStore';
import type { ReScanUiState } from '../../store/reScanStore';
import type {
  ReScanCandidateDto,
  ReScanFirstSpec,
  ReScanNextOp,
  ReScanOpKind,
  ReScanResultRowDto,
  ReScanStatusDto,
} from '../../types/reScan';

// ─── Probe harness ─────────────────────────────────────────────────────────────

let currentProbe = '';
const probeFailures = new Map<string, string[]>();
let totalChecks = 0;
const results: Array<{ name: string; ok: boolean }> = [];

function check(cond: boolean, msg: string, detail = ''): void {
  totalChecks += 1;
  if (cond) return;
  const list = probeFailures.get(currentProbe) ?? [];
  list.push(`${msg}${detail !== '' ? `\n      ${detail}` : ''}`);
  probeFailures.set(currentProbe, list);
}
/** JSON with object keys sorted, so key order produced by the implementation never matters. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) return val;
    const src = val as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = src[key];
    return out;
  });
}
function eqv(actual: unknown, expected: unknown, msg: string): void {
  const a = canon(actual);
  const e = canon(expected);
  check(a === e, msg, `expected: ${e}\n      actual:   ${a}`);
}
function probe(name: string, fn: () => void): void {
  currentProbe = name;
  probeFailures.set(name, []);
  try {
    fn();
  } catch (e) {
    check(false, 'probe threw', e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
  }
  const fails = probeFailures.get(name) ?? [];
  const ok = fails.length === 0;
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  for (const f of fails) console.log(`    - ${f}`);
}

interface NodeProcShim {
  exitCode?: number;
}
const proc = (globalThis as { process?: NodeProcShim }).process;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS = {
  lengths: [1, 2, 4, 8, 12, 16, 24, 32],
  byteOrders: ['intel', 'motorola'],
  signed: [false, true],
  float32: false,
  include64: false,
  alignment: 'any',
  excludeCounterChecksum: true,
  excludeConstant: true,
  buses: null,
  ids: null,
  readMode: { kind: 'latest' },
};

function firstSpec(over: Partial<ReScanFirstSpec> = {}): ReScanFirstSpec {
  return {
    kind: 'unknown',
    value: null,
    tolerance: null,
    range: null,
    physical: false,
    presets: null,
    userPresets: [],
    options: defaultScanOptions(),
    ...over,
  };
}

function withOptions(over: Partial<ReScanFirstSpec['options']>): ReScanFirstSpec {
  return firstSpec({ options: { ...defaultScanOptions(), ...over } });
}

function nextOp(over: Partial<ReScanNextOp> & { op: ReScanOpKind }): ReScanNextOp {
  return { value: null, tolerance: null, range: null, stableMs: null, physical: false, presets: null, ...over };
}

function statusDto(over: Partial<ReScanStatusDto> = {}): ReScanStatusDto {
  return {
    active: true,
    scanId: 3,
    step: 1,
    candidates: 9210,
    history: [1284112, 9210],
    truncated: false,
    elapsedMs: 12.5,
    undoDepth: 1,
    historyCovered: null,
    ...over,
  };
}

const CAND: ReScanCandidateDto = {
  bus: 1,
  arbId: 0x1a0,
  isExtended: false,
  startBit: 11,
  bitLength: 12,
  byteOrder: 'motorola',
  valueType: 'unsigned',
};

function key(over: Partial<ReScanKeyEvent>): ReScanKeyEvent {
  return { key: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, targetIsEditable: false, ...over };
}

function has(codes: readonly string[], code: string, ctx: string): void {
  check(codes.includes(code), `${ctx}: expected issue '${code}'`, `got ${JSON.stringify(codes)}`);
}

// ─── Probes ───────────────────────────────────────────────────────────────────

function main(): void {
  probe('constants match the Rust probe and §8.1/§8.2 exactly', () => {
    check(RE_SCAN_MAX_CANDIDATES === 4_000_000, 'max candidates');
    check(RE_SCAN_MAX_UNDO === 8, 'undo depth');
    check(RE_SCAN_MAX_RESULTS === 500, 'results limit');
    eqv(RE_SCAN_DEFAULT_LENGTHS, [1, 2, 4, 8, 12, 16, 24, 32], 'default lengths');
    eqv(RE_SCAN_PRESET_FACTORS, [1, 0.1, 0.01, 0.001, 0.5, 0.25, 0.125, 1 / 128, 1 / 256, 2, 10], 'factors');
    eqv(RE_SCAN_PRESET_OFFSETS, [0, -40, -50, -100, -273.15, -1000], 'offsets');
    check(RE_SCAN_PRESETS.length === 66, 'grid = 11 × 6 presets', String(RE_SCAN_PRESETS.length));
    let i = 0;
    for (const factor of RE_SCAN_PRESET_FACTORS) {
      for (const offset of RE_SCAN_PRESET_OFFSETS) {
        eqv(RE_SCAN_PRESETS[i], { factor, offset }, `preset #${i} (factor-major order)`);
        i += 1;
      }
    }
    eqv(
      RE_SCAN_NEXT_OPS,
      ['changed', 'unchanged', 'increased', 'decreased', 'either', 'increasedBy', 'decreasedBy', 'exact', 'range', 'stable'],
      'next-scan op list',
    );
  });

  probe('defaultScanOptions = contract defaults, fresh object each call', () => {
    const a = defaultScanOptions();
    eqv(a, DEFAULT_OPTIONS, 'defaults');
    a.lengths.push(64);
    a.byteOrders.pop();
    eqv(defaultScanOptions(), DEFAULT_OPTIONS, 'mutating a returned object never leaks into the next call');
    check(defaultScanOptions().lengths !== defaultScanOptions().lengths, 'arrays are not shared');
  });

  probe('count and history formatting', () => {
    check(formatScanCount(1284112) === '1 284 112', 'thousands groups', formatScanCount(1284112));
    check(formatScanCount(9210) === '9 210', '4 digits', formatScanCount(9210));
    check(formatScanCount(312) === '312', '3 digits');
    check(formatScanCount(1000) === '1 000', 'exact thousand', formatScanCount(1000));
    check(formatScanCount(0) === '0', 'zero');
    check(formatScanCount(4_000_000) === '4 000 000', 'cap', formatScanCount(4_000_000));
    check(formatScanCount(Number.NaN) === '—', 'non-finite', formatScanCount(Number.NaN));
    const h = formatScanHistory([1284112, 9210, 312, 4]);
    check(h === '1 284 112 → 9 210 → 312 → 4', 'contract example', h);
    check(formatScanHistory([]) === '', 'empty history');
    check(formatScanHistory([7]) === '7', 'single step');
  });

  probe('default physical tolerance = max(|factor|, 0.5 % of X)', () => {
    check(defaultPhysicalTolerance(80, 0.01) === 0.4, '80 km/h ×0.01 -> 0.4', String(defaultPhysicalTolerance(80, 0.01)));
    check(defaultPhysicalTolerance(1, 0.1) === 0.1, 'small X -> 1 LSB', String(defaultPhysicalTolerance(1, 0.1)));
    check(defaultPhysicalTolerance(-200, 0.5) === 1, 'negative X uses |X|', String(defaultPhysicalTolerance(-200, 0.5)));
    check(defaultPhysicalTolerance(0, -0.25) === 0.25, 'negative factor uses |factor|');
  });

  probe('op metadata', () => {
    const needsValue = RE_SCAN_NEXT_OPS.filter((o) => opNeedsValue(o));
    eqv(needsValue, ['increasedBy', 'decreasedBy', 'exact'], 'ops needing a value');
    eqv(RE_SCAN_NEXT_OPS.filter((o) => opNeedsRange(o)), ['range'], 'ops needing a range');
    eqv(RE_SCAN_NEXT_OPS.filter((o) => opNeedsStableMs(o)), ['stable'], 'ops needing stableMs');
    eqv(
      RE_SCAN_NEXT_OPS.filter((o) => opSupportsPhysical(o)),
      ['increasedBy', 'decreasedBy', 'exact', 'range'],
      'ops with a physical (preset) variant',
    );
  });

  probe('validateFirstSpec: valid specs', () => {
    eqv(validateFirstSpec(firstSpec()), [], 'unknown with defaults');
    eqv(validateFirstSpec(firstSpec({ kind: 'exact', value: -12 })), [], 'exact raw');
    eqv(validateFirstSpec(firstSpec({ kind: 'exact', value: 100, tolerance: 2 })), [], 'exact with tolerance');
    eqv(validateFirstSpec(firstSpec({ kind: 'physical', value: 80 })), [], 'physical with grid');
    eqv(
      validateFirstSpec(firstSpec({ kind: 'physical', value: 24.68, presets: [], userPresets: [{ factor: 0.02, offset: 0 }] })),
      [],
      'physical with only user presets',
    );
    eqv(validateFirstSpec(firstSpec({ kind: 'range', range: [5, 5] })), [], 'degenerate range a == b');
    eqv(validateFirstSpec(firstSpec({ kind: 'range', range: [12, 13], physical: true })), [], 'physical range');
    eqv(validateFirstSpec(withOptions({ lengths: [3, 32], alignment: 'byte', float32: true, include64: true })), [], 'options');
    eqv(validateFirstSpec(withOptions({ readMode: { kind: 'median', samples: 64 } })), [], 'median 64');
    eqv(
      validateFirstSpec(withOptions({ buses: [0, 255], ids: [{ bus: 0, arbId: 0x1fffffff, isExtended: true }] })),
      [],
      'filters at the limits',
    );
    eqv(validateFirstSpec(firstSpec({ kind: 'unknown', value: Number.NaN })), [], 'value ignored by unknown');
  });

  probe('validateFirstSpec: issue codes', () => {
    has(validateFirstSpec(firstSpec({ kind: 'exact' })), 'value_required', 'exact without value');
    has(validateFirstSpec(firstSpec({ kind: 'physical' })), 'value_required', 'physical without value');
    has(validateFirstSpec(firstSpec({ kind: 'exact', value: Number.POSITIVE_INFINITY })), 'value_not_finite', 'inf');
    has(validateFirstSpec(firstSpec({ kind: 'exact', value: 1, tolerance: -1 })), 'tolerance_invalid', 'tol < 0');
    has(validateFirstSpec(firstSpec({ kind: 'exact', value: 1, tolerance: Number.NaN })), 'tolerance_invalid', 'tol NaN');
    has(validateFirstSpec(firstSpec({ kind: 'range' })), 'range_required', 'range missing');
    has(validateFirstSpec(firstSpec({ kind: 'range', range: [5, 1] })), 'range_invalid', 'inverted range');
    has(validateFirstSpec(firstSpec({ kind: 'range', range: [Number.NaN, 1] })), 'range_invalid', 'NaN range');
    has(validateFirstSpec(firstSpec({ kind: 'physical', value: 1, presets: [] })), 'presets_empty', 'no presets');
    has(
      validateFirstSpec(firstSpec({ kind: 'range', range: [0, 1], physical: true, presets: [] })),
      'presets_empty',
      'physical range without presets',
    );
    has(
      validateFirstSpec(firstSpec({ kind: 'physical', value: 1, presets: [{ factor: 0, offset: 0 }] })),
      'preset_invalid',
      'factor 0',
    );
    has(
      validateFirstSpec(firstSpec({ kind: 'physical', value: 1, userPresets: [{ factor: 1, offset: Number.NaN }] })),
      'preset_invalid',
      'offset NaN',
    );
    has(validateFirstSpec(withOptions({ lengths: [] })), 'lengths_empty', 'lengths []');
    for (const bad of [0, 33, 64, 2.5, -1]) {
      has(validateFirstSpec(withOptions({ lengths: [8, bad] })), 'length_out_of_range', `length ${bad}`);
    }
    has(validateFirstSpec(withOptions({ byteOrders: [] })), 'byte_orders_empty', 'byteOrders []');
    has(validateFirstSpec(withOptions({ signed: [] })), 'signed_empty', 'signed []');
    for (const bad of [0, 65, 1.5]) {
      has(
        validateFirstSpec(withOptions({ readMode: { kind: 'median', samples: bad } })),
        'median_samples',
        `median ${bad}`,
      );
    }
    has(validateFirstSpec(withOptions({ buses: [] })), 'buses_empty', 'buses []');
    has(validateFirstSpec(withOptions({ buses: [256] })), 'bus_out_of_range', 'bus 256');
    has(validateFirstSpec(withOptions({ ids: [] })), 'ids_empty', 'ids []');
    has(
      validateFirstSpec(withOptions({ ids: [{ bus: 0, arbId: 0x800, isExtended: false }] })),
      'id_out_of_range',
      'std id 0x800',
    );
    has(
      validateFirstSpec(withOptions({ ids: [{ bus: 0, arbId: 0x20000000, isExtended: true }] })),
      'id_out_of_range',
      'ext id > 29 bits',
    );
    const multi = validateFirstSpec(
      firstSpec({ kind: 'exact', options: { ...defaultScanOptions(), lengths: [], signed: [] } }),
    );
    has(multi, 'value_required', 'multi');
    has(multi, 'lengths_empty', 'multi');
    has(multi, 'signed_empty', 'multi');
    check(new Set(multi).size === multi.length, 'codes are unique', JSON.stringify(multi));
  });

  probe('validateNextOp', () => {
    for (const op of ['changed', 'unchanged', 'increased', 'decreased', 'either'] as const) {
      eqv(validateNextOp(nextOp({ op, value: Number.NaN, stableMs: -5 })), [], `${op} ignores irrelevant fields`);
    }
    eqv(validateNextOp(nextOp({ op: 'increasedBy', value: 5 })), [], 'increasedBy 5');
    eqv(validateNextOp(nextOp({ op: 'exact', value: 80, physical: true, presets: [{ factor: 0.01, offset: 0 }] })), [], 'exact phys');
    eqv(validateNextOp(nextOp({ op: 'exact', value: 80, physical: true })), [], 'exact phys with grid');
    eqv(validateNextOp(nextOp({ op: 'range', range: [50, 80] })), [], 'range');
    eqv(validateNextOp(nextOp({ op: 'stable', stableMs: 1000 })), [], 'stable 1000');
    eqv(validateNextOp(nextOp({ op: 'stable', stableMs: 600000 })), [], 'stable max');
    has(validateNextOp(nextOp({ op: 'increasedBy' })), 'value_required', 'increasedBy');
    has(validateNextOp(nextOp({ op: 'decreasedBy' })), 'value_required', 'decreasedBy');
    has(validateNextOp(nextOp({ op: 'exact' })), 'value_required', 'exact');
    has(validateNextOp(nextOp({ op: 'exact', value: Number.NaN })), 'value_not_finite', 'exact NaN');
    has(validateNextOp(nextOp({ op: 'exact', value: 1, tolerance: -0.5 })), 'tolerance_invalid', 'tol');
    has(validateNextOp(nextOp({ op: 'range' })), 'range_required', 'range');
    has(validateNextOp(nextOp({ op: 'range', range: [3, 2] })), 'range_invalid', 'inverted');
    for (const bad of [null, 0, 600001, 12.5]) {
      has(validateNextOp(nextOp({ op: 'stable', stableMs: bad })), 'stable_ms_invalid', `stableMs ${String(bad)}`);
    }
    has(validateNextOp(nextOp({ op: 'exact', value: 1, physical: true, presets: [] })), 'presets_empty', 'presets []');
    has(
      validateNextOp(nextOp({ op: 'increasedBy', value: 1, physical: true, presets: [{ factor: Number.NaN, offset: 0 }] })),
      'preset_invalid',
      'NaN factor',
    );
  });

  probe('hotkeys: Enter = next, Ctrl/Cmd+Z = undo', () => {
    check(scanHotkeyAction(key({ key: 'Enter' })) === 'next', 'Enter');
    check(scanHotkeyAction(key({ key: 'Enter', targetIsEditable: true })) === 'next', 'Enter in the value input');
    check(scanHotkeyAction(key({ key: 'Enter', ctrlKey: true })) === null, 'Ctrl+Enter');
    check(scanHotkeyAction(key({ key: 'Enter', shiftKey: true })) === null, 'Shift+Enter');
    check(scanHotkeyAction(key({ key: 'z', ctrlKey: true })) === 'undo', 'Ctrl+Z');
    check(scanHotkeyAction(key({ key: 'Z', ctrlKey: true })) === 'undo', 'Ctrl+Z (caps)');
    check(scanHotkeyAction(key({ key: 'z', metaKey: true })) === 'undo', 'Cmd+Z');
    check(scanHotkeyAction(key({ key: 'z', ctrlKey: true, targetIsEditable: true })) === null, 'native text undo wins');
    check(scanHotkeyAction(key({ key: 'z', ctrlKey: true, shiftKey: true })) === null, 'Ctrl+Shift+Z (no redo)');
    check(scanHotkeyAction(key({ key: 'z', ctrlKey: true, altKey: true })) === null, 'Ctrl+Alt+Z');
    check(scanHotkeyAction(key({ key: 'z' })) === null, 'plain z');
    check(scanHotkeyAction(key({ key: 'm' })) === null, 'other keys');
  });

  probe('scanCandidateKey unique per identity, stable', () => {
    const variants: ReScanCandidateDto[] = [
      CAND,
      { ...CAND, bus: 2 },
      { ...CAND, arbId: 0x1a1 },
      { ...CAND, isExtended: true },
      { ...CAND, startBit: 12 },
      { ...CAND, bitLength: 16 },
      { ...CAND, byteOrder: 'intel' },
      { ...CAND, valueType: 'signed' },
    ];
    const keys = variants.map(scanCandidateKey);
    check(new Set(keys).size === keys.length, 'all different', JSON.stringify(keys));
    check(scanCandidateKey({ ...CAND }) === scanCandidateKey(CAND), 'value-equal candidates share a key');
  });

  probe('scanRowToInspect seeds an R2a candidate (preset scale or 1/0)', () => {
    const row: ReScanResultRowDto = {
      candidate: CAND,
      preset: { factor: 0.01, offset: -40 },
      currentRaw: 3000,
      currentPhysical: -10,
      previousRaw: 2000,
      changeCount: 2,
      kindHint: 'physical',
      containedCount: 0,
      contained: [],
    };
    eqv(
      scanRowToInspect(row),
      {
        target: { bus: 1, arbId: 0x1a0, isExtended: false },
        candidate: { startBit: 11, bitLength: 12, byteOrder: 'motorola', valueType: 'unsigned', factor: 0.01, offset: -40 },
      },
      'with preset',
    );
    eqv(
      scanRowToInspect({ ...row, preset: null }).candidate,
      { startBit: 11, bitLength: 12, byteOrder: 'motorola', valueType: 'unsigned', factor: 1, offset: 0 },
      'without preset',
    );
  });

  probe('reScanReducer transitions (pure, never mutates)', () => {
    const s0 = initialReScanUiState();
    eqv(s0, { status: null, lastOp: null, busy: false, error: null }, 'initial');
    check(initialReScanUiState() !== s0, 'fresh initial state per call');
    const frozen = JSON.stringify(s0);
    const s1 = reScanReducer(s0, { type: 'begin' });
    check(JSON.stringify(s0) === frozen, 'input not mutated');
    check(s1 !== s0, 'new object');
    eqv(s1, { status: null, lastOp: null, busy: true, error: null }, 'begin');
    const st0 = statusDto({ step: 0, history: [1284112], candidates: 1284112, undoDepth: 0 });
    const s2 = reScanReducer(s1, { type: 'firstDone', status: st0 });
    eqv(s2, { status: st0, lastOp: null, busy: false, error: null }, 'firstDone');
    const inc = nextOp({ op: 'increased' });
    const st1 = statusDto();
    const s3 = reScanReducer(reScanReducer(s2, { type: 'begin' }), { type: 'nextDone', status: st1, op: inc });
    eqv(s3, { status: st1, lastOp: inc, busy: false, error: null }, 'nextDone records lastOp');
    const s4 = reScanReducer(reScanReducer(s3, { type: 'begin' }), { type: 'failed', message: '[re:invalid] x' });
    eqv(s4, { status: st1, lastOp: inc, busy: false, error: '[re:invalid] x' }, 'failed keeps status + lastOp');
    const s5 = reScanReducer(s4, { type: 'begin' });
    check(s5.error === null && s5.busy, 'begin clears the error');
    const s6 = reScanReducer(s5, { type: 'undoDone', status: st0 });
    eqv(s6, { status: st0, lastOp: inc, busy: false, error: null }, 'undoDone keeps lastOp');
    const off = statusDto({ active: false, step: 0, candidates: 0, history: [], undoDepth: 0 });
    const s7 = reScanReducer(s6, { type: 'resetDone', status: off });
    eqv(s7, { status: off, lastOp: inc, busy: false, error: null }, 'resetDone keeps lastOp');
  });

  probe('hotkeyNextOp / canUndo gating', () => {
    const inc = nextOp({ op: 'increased' });
    const base: ReScanUiState = { status: statusDto(), lastOp: inc, busy: false, error: null };
    eqv(hotkeyNextOp(base), inc, 'Enter repeats the last op');
    check(hotkeyNextOp({ ...base, lastOp: null }) === null, 'no last op');
    check(hotkeyNextOp({ ...base, busy: true }) === null, 'busy');
    check(hotkeyNextOp({ ...base, status: null }) === null, 'no scan');
    check(hotkeyNextOp({ ...base, status: statusDto({ active: false }) }) === null, 'scan reset');
    check(canUndo(base), 'undoDepth 1');
    check(!canUndo({ ...base, status: statusDto({ undoDepth: 0 }) }), 'undoDepth 0');
    check(!canUndo({ ...base, busy: true }), 'busy');
    check(!canUndo({ ...base, status: null }), 'no scan');
    check(!canUndo({ ...base, status: statusDto({ active: false, undoDepth: 3 }) }), 'inactive');
  });

  const failed = results.filter((x) => !x.ok);
  console.log(`\nre.r2c.qa: ${results.length - failed.length}/${results.length} probes PASS (${totalChecks} checks)`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((x) => x.name).join(', ')}`);
    if (proc) proc.exitCode = 1;
  }
}

main();
