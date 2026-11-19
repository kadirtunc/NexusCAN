/**
 * Pure helpers for the R2c Value Scan (re-toolkit-v1 §8): constants, option defaults, formatting, op metadata,
 * client-side validation (issue codes), hotkeys, candidate identity and the form -> spec builders. No React, no DOM,
 * no stores, no IPC.
 */
import type { ReCandidateDto, ReTargetDto } from '../../types/re';
import type {
  ReScalePresetDto,
  ReScanCandidateDto,
  ReScanFirstSpec,
  ReScanKind,
  ReScanNextOp,
  ReScanOpKind,
  ReScanOptionsDto,
  ReScanResultRowDto,
} from '../../types/reScan';

export const RE_SCAN_MAX_CANDIDATES = 4_000_000;
export const RE_SCAN_MAX_UNDO = 8;
export const RE_SCAN_MAX_RESULTS = 500;
export const RE_SCAN_DEFAULT_LENGTHS: readonly number[] = [1, 2, 4, 8, 12, 16, 24, 32];
/** Selectable lengths in the option checkboxes (64 is the separate `include64` flag). */
export const RE_SCAN_SELECTABLE_LENGTHS: readonly number[] = [1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32];
export const RE_SCAN_PRESET_FACTORS: readonly number[] = [1, 0.1, 0.01, 0.001, 0.5, 0.25, 0.125, 1 / 128, 1 / 256, 2, 10];
export const RE_SCAN_PRESET_OFFSETS: readonly number[] = [0, -40, -50, -100, -273.15, -1000];
export const RE_SCAN_MAX_STABLE_MS = 600_000;

function buildPresetGrid(): ReScalePresetDto[] {
  const out: ReScalePresetDto[] = [];
  for (const factor of RE_SCAN_PRESET_FACTORS) {
    for (const offset of RE_SCAN_PRESET_OFFSETS) out.push({ factor, offset });
  }
  return out;
}

/** 11 x 6 = 66 presets, factor-major (the backend grid order; first match wins). */
export const RE_SCAN_PRESETS: readonly ReScalePresetDto[] = buildPresetGrid();

export const RE_SCAN_NEXT_OPS: readonly ReScanOpKind[] = [
  'changed',
  'unchanged',
  'increased',
  'decreased',
  'either',
  'increasedBy',
  'decreasedBy',
  'exact',
  'range',
  'stable',
];

export function defaultScanOptions(): ReScanOptionsDto {
  return {
    lengths: [...RE_SCAN_DEFAULT_LENGTHS],
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
}

// ---- formatting -----------------------------------------------------------------------------------------------

/** Integer with thousands groups joined by a plain space: 1284112 -> '1 284 112'; non-finite -> '—'. */
export function formatScanCount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const r = Math.round(Math.abs(n));
  const digits = String(r);
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ' ';
    out += digits[i];
  }
  return n < 0 && r !== 0 ? `-${out}` : out;
}

export function formatScanHistory(h: readonly number[]): string {
  return h.map(formatScanCount).join(' → ');
}

/** max(|factor|, 0.5 % of |x|): one LSB of the scale or half a percent of the target, whichever is larger. */
export function defaultPhysicalTolerance(x: number, factor: number): number {
  return Math.max(Math.abs(factor), (Math.abs(x) * 5) / 1000);
}

// ---- op metadata ----------------------------------------------------------------------------------------------

export function opNeedsValue(op: ReScanOpKind): boolean {
  return op === 'increasedBy' || op === 'decreasedBy' || op === 'exact';
}
export function opNeedsRange(op: ReScanOpKind): boolean {
  return op === 'range';
}
export function opNeedsStableMs(op: ReScanOpKind): boolean {
  return op === 'stable';
}
export function opSupportsPhysical(op: ReScanOpKind): boolean {
  return op === 'increasedBy' || op === 'decreasedBy' || op === 'exact' || op === 'range';
}

// ---- validation -----------------------------------------------------------------------------------------------

const isInt = (v: number): boolean => typeof v === 'number' && Number.isInteger(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function checkTolerance(tol: number | null, issues: Set<string>): void {
  if (tol !== null && (!isFiniteNum(tol) || tol < 0)) issues.add('tolerance_invalid');
}

function checkRange(range: [number, number] | null, issues: Set<string>): void {
  if (range === null) {
    issues.add('range_required');
    return;
  }
  const [a, b] = range;
  if (!isFiniteNum(a) || !isFiniteNum(b) || a > b) issues.add('range_invalid');
}

function checkPresets(presets: readonly ReScalePresetDto[], issues: Set<string>): void {
  for (const p of presets) {
    if (!isFiniteNum(p.factor) || p.factor === 0 || !isFiniteNum(p.offset)) {
      issues.add('preset_invalid');
      return;
    }
  }
}

/** Issue codes for a first-scan spec; `[]` = valid. Codes are unique. */
export function validateFirstSpec(spec: ReScanFirstSpec): string[] {
  const issues = new Set<string>();
  const valued = spec.kind === 'exact' || spec.kind === 'physical';
  if (valued) {
    if (spec.value === null) issues.add('value_required');
    else if (!isFiniteNum(spec.value)) issues.add('value_not_finite');
    checkTolerance(spec.tolerance, issues);
  }
  if (spec.kind === 'range') checkRange(spec.range, issues);
  if (spec.kind === 'physical' || (spec.kind === 'range' && spec.physical)) {
    const matching = [...spec.userPresets, ...(spec.presets ?? RE_SCAN_PRESETS)];
    if (matching.length === 0) issues.add('presets_empty');
    checkPresets(matching, issues);
  }
  const o = spec.options;
  if (o.lengths.length === 0) issues.add('lengths_empty');
  if (o.lengths.some((l) => !isInt(l) || l < 1 || l > 32)) issues.add('length_out_of_range');
  if (o.byteOrders.length === 0) issues.add('byte_orders_empty');
  if (o.signed.length === 0) issues.add('signed_empty');
  if (o.readMode.kind === 'median' && (!isInt(o.readMode.samples) || o.readMode.samples < 1 || o.readMode.samples > 64)) {
    issues.add('median_samples');
  }
  if (o.buses !== null) {
    if (o.buses.length === 0) issues.add('buses_empty');
    if (o.buses.some((b) => !isInt(b) || b < 0 || b > 255)) issues.add('bus_out_of_range');
  }
  if (o.ids !== null) {
    if (o.ids.length === 0) issues.add('ids_empty');
    for (const id of o.ids) {
      const max = id.isExtended ? 0x1fff_ffff : 0x7ff;
      if (!isInt(id.bus) || id.bus < 0 || id.bus > 255 || !isInt(id.arbId) || id.arbId < 0 || id.arbId > max) {
        issues.add('id_out_of_range');
      }
    }
  }
  return [...issues];
}

/** Issue codes for a next-scan op; fields irrelevant to the op are ignored. */
export function validateNextOp(op: ReScanNextOp): string[] {
  const issues = new Set<string>();
  if (opNeedsValue(op.op)) {
    if (op.value === null) issues.add('value_required');
    else if (!isFiniteNum(op.value)) issues.add('value_not_finite');
    checkTolerance(op.tolerance, issues);
  }
  if (opNeedsRange(op.op)) checkRange(op.range, issues);
  if (opNeedsStableMs(op.op)) {
    const ms = op.stableMs;
    if (ms === null || !isInt(ms) || ms < 1 || ms > RE_SCAN_MAX_STABLE_MS) issues.add('stable_ms_invalid');
  }
  if (op.physical && opSupportsPhysical(op.op) && op.presets !== null) {
    if (op.presets.length === 0) issues.add('presets_empty');
    checkPresets(op.presets, issues);
  }
  return [...issues];
}

// ---- hotkeys / identity ---------------------------------------------------------------------------------------

export interface ReScanKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  targetIsEditable: boolean;
}

/** Enter = Next Scan (also in inputs); Ctrl/Cmd+Z = Undo unless a text field owns the key (native text undo). */
export function scanHotkeyAction(e: ReScanKeyEvent): 'next' | 'undo' | null {
  if (e.key === 'Enter') return !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey ? 'next' : null;
  if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && !e.targetIsEditable) return 'undo';
  return null;
}

export function scanCandidateKey(c: ReScanCandidateDto): string {
  return `${c.bus}:${c.isExtended ? 'x' : 's'}:${c.arbId}:${c.startBit}:${c.bitLength}:${c.byteOrder}:${c.valueType}`;
}

/** Inspect / Save-signal seed: the candidate bits with the row's preset scale (else identity 1 / 0). */
export function scanRowToInspect(row: ReScanResultRowDto): { target: ReTargetDto; candidate: ReCandidateDto } {
  const c = row.candidate;
  return {
    target: { bus: c.bus, arbId: c.arbId, isExtended: c.isExtended },
    candidate: {
      startBit: c.startBit,
      bitLength: c.bitLength,
      byteOrder: c.byteOrder,
      valueType: c.valueType,
      factor: row.preset?.factor ?? 1,
      offset: row.preset?.offset ?? 0,
    },
  };
}

// ---- form -> spec (text fields as typed; parse failures become NaN so validation reports them) --------------------

/** Decimal comma accepted. Empty -> null, unparsable -> NaN. */
export function parseNumText(text: string): number | null {
  const s = text.trim().replace(',', '.');
  if (s === '') return null;
  return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) ? Number(s) : Number.NaN;
}

/**
 * Scan-form number: decimal (fraction / exponent) or integer hex `0x1F40` / `0X1f40` / `-0x10`. Empty -> null,
 * anything else (`0x`, `0xZZ`, `0x1.8`) -> NaN so validation reports it. The wire stays a plain number.
 */
export function parseScanNumber(text: string): number | null {
  const s = text.trim();
  const m = /^([+-]?)0x([0-9a-f]+)$/i.exec(s);
  if (m !== null) {
    const v = Number.parseInt(m[2], 16);
    return m[1] === '-' ? -v : v;
  }
  return parseNumText(s);
}

/** Raw value as `0x1F40` / `-0x10` (uppercase); null -> '—'; non-integers (float32) stay decimal. */
export function formatScanRawHex(v: number | null): string {
  if (v === null) return '—';
  if (!Number.isFinite(v) || !Number.isInteger(v)) return String(v);
  return `${v < 0 ? '-' : ''}0x${Math.abs(v).toString(16).toUpperCase()}`;
}

/** `[bus:]id[x]` tokens, e.g. `1A0, 0:0x18FF1234x`. No bus -> every known bus; id > 0x7FF or `x` suffix = extended. */
export function parseIdFilter(text: string, knownBuses: readonly number[]): ReTargetDto[] | null {
  const tokens = text.split(/[\s,;]+/).filter((t) => t !== '');
  if (tokens.length === 0) return null;
  const out: ReTargetDto[] = [];
  for (const tok of tokens) {
    const m = /^(?:(\d+):)?(?:0x)?([0-9a-f]+?)(x?)$/i.exec(tok);
    if (m === null) {
      out.push({ bus: 0, arbId: -1, isExtended: false });
      continue;
    }
    const arbId = Number.parseInt(m[2], 16);
    const isExtended = m[3] !== '' || arbId > 0x7ff;
    const buses = m[1] !== undefined ? [Number(m[1])] : knownBuses.length > 0 ? knownBuses : [0];
    for (const bus of buses) out.push({ bus, arbId, isExtended });
  }
  return out;
}

/** `bus list` text `0, 1` -> numbers; empty -> null (all buses); garbage -> NaN entry (validation: bus_out_of_range). */
export function parseBusFilter(text: string): number[] | null {
  const tokens = text.split(/[\s,;]+/).filter((t) => t !== '');
  return tokens.length === 0 ? null : tokens.map((t) => (/^\d+$/.test(t) ? Number(t) : Number.NaN));
}

/** `factor:offset` or `factor,offset` pairs separated by `;` or spaces -> presets (NaN on garbage -> preset_invalid). */
export function parseUserPreset(text: string): ReScalePresetDto | null {
  const parts = text.split(/[:;\s]+/).filter((t) => t !== '');
  if (parts.length === 0 || parts.length > 2) return null;
  const factor = parseNumText(parts[0]);
  const offset = parts.length === 2 ? parseNumText(parts[1]) : 0;
  if (factor === null || offset === null || !Number.isFinite(factor) || !Number.isFinite(offset) || factor === 0) return null;
  return { factor, offset };
}

export type ReScanReadModeKind = 'latest' | 'median';

export interface ReScanForm {
  kind: ReScanKind;
  valueText: string;
  tolText: string;
  rangeAText: string;
  rangeBText: string;
  rangePhysical: boolean;
  options: ReScanOptionsDto;
  busText: string;
  idText: string;
  medianSamplesText: string;
  userPresets: ReScalePresetDto[];
  op: ReScanOpKind;
  opValueText: string;
  opTolText: string;
  opRangeAText: string;
  opRangeBText: string;
  opStableText: string;
  opPhysical: boolean;
}

export function defaultScanForm(): ReScanForm {
  return {
    kind: 'unknown',
    valueText: '',
    tolText: '',
    rangeAText: '',
    rangeBText: '',
    rangePhysical: false,
    options: defaultScanOptions(),
    busText: '',
    idText: '',
    medianSamplesText: '5',
    userPresets: [],
    op: 'changed',
    opValueText: '',
    opTolText: '',
    opRangeAText: '',
    opRangeBText: '',
    opStableText: '1000',
    opPhysical: false,
  };
}

function rangeOf(a: string, b: string): [number, number] | null {
  const lo = parseScanNumber(a);
  const hi = parseScanNumber(b);
  return lo === null || hi === null ? null : [lo, hi];
}

export function buildFirstSpec(form: ReScanForm, knownBuses: readonly number[]): ReScanFirstSpec {
  const options: ReScanOptionsDto = {
    ...form.options,
    lengths: [...form.options.lengths],
    byteOrders: [...form.options.byteOrders],
    signed: [...form.options.signed],
    buses: parseBusFilter(form.busText),
    ids: parseIdFilter(form.idText, knownBuses),
    readMode:
      form.options.readMode.kind === 'median'
        ? { kind: 'median', samples: parseNumText(form.medianSamplesText) ?? Number.NaN }
        : { kind: 'latest' },
  };
  const valued = form.kind === 'exact' || form.kind === 'physical';
  return {
    kind: form.kind,
    value: valued ? parseScanNumber(form.valueText) : null,
    tolerance: valued ? parseScanNumber(form.tolText) : null,
    range: form.kind === 'range' ? rangeOf(form.rangeAText, form.rangeBText) : null,
    physical: form.kind === 'range' && form.rangePhysical,
    presets: null,
    userPresets: form.userPresets.map((p) => ({ ...p })),
    options,
  };
}

export function buildNextOp(form: ReScanForm): ReScanNextOp {
  const op = form.op;
  const stable = parseNumText(form.opStableText);
  return {
    op,
    value: opNeedsValue(op) ? parseScanNumber(form.opValueText) : null,
    tolerance: opNeedsValue(op) ? parseScanNumber(form.opTolText) : null,
    range: opNeedsRange(op) ? rangeOf(form.opRangeAText, form.opRangeBText) : null,
    stableMs: opNeedsStableMs(op) ? stable : null,
    physical: opSupportsPhysical(op) && form.opPhysical,
    presets: null,
  };
}

// ---- table virtualization (fixed row height) -------------------------------------------------------------------

export interface ReVirtualWindow {
  start: number;
  end: number;
}

/** Rows `[start, end)` to render for a scroll position (fixed `rowH`), with `overscan` rows on both sides. */
export function virtualWindow(scrollTop: number, viewportH: number, rowH: number, count: number, overscan = 6): ReVirtualWindow {
  if (count <= 0 || rowH <= 0) return { start: 0, end: 0 };
  const first = Math.max(0, Math.floor(scrollTop / rowH));
  const last = Math.ceil((scrollTop + Math.max(0, viewportH)) / rowH);
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + overscan) };
}
