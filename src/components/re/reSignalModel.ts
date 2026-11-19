/** Pure helpers for the R2a Signal Inspector (no React, no DOM, no IPC). */
import type { ReByteOrder, ReCandidateDto, ReFieldDto, ReReferenceDto, ReSearchDto, ReSeries } from '../../types/re';
import type { TranslationKey } from '../../i18n';
import { bitIsSet, fieldBits } from './reModel';

export const RE_MAX_CANDIDATES = 4;

export const DEFAULT_CANDIDATE: ReCandidateDto = {
  startBit: 0,
  bitLength: 8,
  byteOrder: 'intel',
  valueType: 'unsigned',
  factor: 1,
  offset: 0,
};

/**
 * Bit coordinates (bit = byte*8 + k) highlighted for a selection. Highlight-only mirror of
 * `nexus_netdb::compiler::bit_plan::trace_signal_bits` (Intel ascending, Motorola DBC sawtooth); values are NEVER
 * extracted with TS bit math - the series always comes from the backend. Test-matched to the netdb vectors.
 */
export function selectionBits(c: Pick<ReCandidateDto, 'startBit' | 'bitLength' | 'byteOrder'>, maxBits: number): number[] {
  return fieldBits(c, maxBits);
}

/** True when the whole selection fits inside `maxBits` (dlcBytes*8). */
export function selectionFits(c: Pick<ReCandidateDto, 'startBit' | 'bitLength' | 'byteOrder'>, maxBits: number): boolean {
  return c.bitLength >= 1 && c.bitLength <= 64 && selectionBits(c, maxBits).length === c.bitLength;
}

function sawtoothNext(pos: number): number {
  return pos % 8 === 0 ? pos + 15 : pos - 1;
}

/**
 * Drag from bit `a` to bit `b` (bit = byte*8 + k). Intel: contiguous ascending range. Motorola: the DBC sawtooth walk
 * from the MSB start bit; if `b` is not downstream of `a` the roles swap. Returns null when unreachable within 64 bits.
 */
export function dragSelection(
  a: number,
  b: number,
  order: ReByteOrder,
): { startBit: number; bitLength: number } | null {
  if (order === 'intel') {
    const lo = Math.min(a, b);
    const len = Math.abs(a - b) + 1;
    return len <= 64 ? { startBit: lo, bitLength: len } : null;
  }
  for (const [from, to] of [[a, b], [b, a]] as const) {
    let pos = from;
    for (let len = 1; len <= 64 && pos >= 0; len += 1) {
      if (pos === to) return { startBit: from, bitLength: len };
      pos = sawtoothNext(pos);
    }
  }
  return null;
}

/** Candidate seeded from a classifier field (identity scaling, unsigned). */
export function candidateFromField(f: Pick<ReFieldDto, 'startBit' | 'bitLength' | 'byteOrder'>): ReCandidateDto {
  return {
    startBit: f.startBit,
    bitLength: Math.max(1, Math.min(64, f.bitLength)),
    byteOrder: f.byteOrder,
    valueType: 'unsigned',
    factor: 1,
    offset: 0,
  };
}

export function sameCandidateBits(a: ReCandidateDto, b: ReCandidateDto): boolean {
  return a.startBit === b.startBit && a.bitLength === b.bitLength && a.byteOrder === b.byteOrder && a.valueType === b.valueType;
}

/**
 * Default search range = the span of non-constant bits of the row (classifier constant mask: bit set = never changed).
 * Falls back to the whole payload when everything is constant or the mask is empty.
 */
export function defaultSearchFromConstant(constant: Uint8Array, dlcBytes: number): ReSearchDto {
  const total = dlcBytes * 8;
  let lo = -1;
  let hi = -1;
  for (let bit = 0; bit < total; bit += 1) {
    if (bitIsSet(constant, bit)) continue;
    if (lo < 0) lo = bit;
    hi = bit;
  }
  if (lo < 0) {
    lo = 0;
    hi = Math.max(0, total - 1);
  }
  return { bitFrom: lo, bitTo: hi, lengths: [4, 16], byteOrders: ['intel', 'motorola'], signed: [false, true] };
}

export function normalizeSearch(s: ReSearchDto): ReSearchDto {
  const lo = Math.max(1, Math.min(32, Math.round(s.lengths[0])));
  const hi = Math.max(lo, Math.min(32, Math.round(s.lengths[1])));
  const bitFrom = Math.max(0, Math.round(Math.min(s.bitFrom, s.bitTo)));
  const bitTo = Math.max(bitFrom, Math.round(Math.max(s.bitFrom, s.bitTo)));
  return { bitFrom, bitTo, lengths: [lo, hi], byteOrders: s.byteOrders.length === 0 ? ['intel'] : s.byteOrders, signed: s.signed.length === 0 ? [false] : s.signed };
}

export interface ParsedReError {
  /** `[re:code]` token without brackets, or null */
  code: string | null;
  message: string;
}

/** Backend errors carry a `[re:code]` token (e.g. `[re:no_reference]`); the UI maps it to a hint. */
export function parseReError(e: unknown): ParsedReError {
  const message = e instanceof Error ? e.message : String(e);
  const m = /\[re:([a-z_]+)\]/.exec(message);
  return { code: m === null ? null : m[1], message };
}

export function referenceKey(r: ReReferenceDto | null): string {
  if (r === null) return '';
  switch (r.kind) {
    case 'obd_pid':
      return `obd:${r.bus}:${r.pid}`;
    case 'markers':
      return `mk:${r.points.map((p) => `${p.markerId}=${p.value}`).join(',')}`;
    case 'candidate':
      return `cand:${r.target.bus}:${r.target.arbId}:${r.candidate.startBit}:${r.candidate.bitLength}`;
  }
}

export function formatSignalValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? '+Inf' : '-Inf';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e7 || a < 1e-3)) return v.toExponential(3);
  return Number(v.toPrecision(7)).toString();
}

// ---- plot geometry (pure) ---------------------------------------------------------------------------------------


/** Absolute time of the last point over all series (µs), or null when there are no points. */
export function seriesEndUs(s: ReSeries | null): number | null {
  if (s === null) return null;
  let end: number | null = null;
  for (const e of s.series) {
    const n = e.points.tUsRel.length;
    if (n > 0) {
      const t = s.fromUs + e.points.tUsRel[n - 1];
      end = end === null ? t : Math.max(end, t);
    }
  }
  return end;
}

/** Absolute time (µs) of the first point over all series, or null. */
export function seriesStartUs(s: ReSeries | null): number | null {
  if (s === null) return null;
  let start: number | null = null;
  for (const e of s.series) {
    if (e.points.tUsRel.length > 0) {
      const t = s.fromUs + e.points.tUsRel[0];
      start = start === null ? t : Math.min(start, t);
    }
  }
  return start;
}

/**
 * Visible time window [t0, t1] (absolute µs), oscilloscope style. Live: until the data is longer than `spanUs` the
 * window is `[origin, origin + span]` (trace starts at the left edge and grows right); afterwards it scrolls
 * `[end - span, end]`. `origin` = RE capture start, else the first sample. Paused: `view`.
 */
export function plotRange(
  s: ReSeries | null,
  follow: boolean,
  spanUs: number,
  view: { t0Us: number; t1Us: number } | null,
  originUs: number | null = null,
): [number, number] | null {
  if (!follow && view !== null) return [view.t0Us, view.t1Us];
  const end = seriesEndUs(s);
  if (end === null) return null;
  const origin = originUs ?? seriesStartUs(s) ?? end;
  if (end - origin < spanUs) return [origin, origin + spanUs];
  return [end - spanUs, end];
}

/**
 * Request window aligned to the decimation bucket grid so bucket boundaries are identical between polls
 * (no shimmer). `bucketUs = round(spanUs / maxPoints)` (>= 1): an INTEGER, because `fromUs`/`toUs` are Rust `u64`
 * and a JSON float is rejected by serde. The window always has length `round(spanUs)`. While the capture is younger
 * than `spanUs` the window is `[origin, origin + span]`. All returned bounds are integers.
 */
export function alignedWindow(nowUs: number, spanUs: number, maxPoints: number, originUs: number | null): { fromUs: number; toUs: number } {
  const span = Math.max(1, Math.round(spanUs));
  const bucket = Math.max(1, Math.round(span / maxPoints));
  const toAligned = Math.ceil(Math.round(nowUs) / bucket) * bucket;
  const fromAligned = toAligned - span;
  if (originUs !== null && fromAligned < originUs) {
    const o = Math.max(0, Math.round(originUs));
    return { fromUs: o, toUs: o + span };
  }
  const from = Math.max(0, fromAligned);
  return { fromUs: from, toUs: from + span };
}

/** Paused view snapped to the (integer) bucket grid (window length preserved, rounded to whole µs). */
export function alignedView(t0Us: number, t1Us: number, maxPoints: number): { fromUs: number; toUs: number } {
  const span = Math.max(1, Math.round(t1Us - t0Us));
  const bucket = Math.max(1, Math.round(span / maxPoints));
  const from = Math.max(0, Math.floor(t0Us / bucket) * bucket);
  return { fromUs: from, toUs: from + span };
}

/** "0 s", "2.5 s", "12 s"; from 100 s on `m:ss`. Input in seconds since the capture origin. */
export function formatAxisTime(sec: number): string {
  const v = Math.round(sec * 1000) / 1000;
  if (Math.abs(v) >= 100) {
    const m = Math.floor(Math.abs(v) / 60);
    const r = Math.floor(Math.abs(v) % 60);
    return `${v < 0 ? '-' : ''}${m}:${String(r).padStart(2, '0')}`;
  }
  return `${Number(v.toFixed(2))} s`;
}

/** Time ticks for window [t0, t1]; labels are absolute since `originUs`, ascending left to right. */
export function timeTicks(t0Us: number, t1Us: number, originUs: number, count: number): { frac: number; label: string }[] {
  const span = Math.max(1, t1Us - t0Us);
  const out: { frac: number; label: string }[] = [];
  for (const v of niceTicks((t0Us - originUs) / 1e6, (t1Us - originUs) / 1e6, count)) {
    out.push({ frac: (originUs + v * 1e6 - t0Us) / span, label: formatAxisTime(v) });
  }
  return out;
}

// ---- stable Y axis -----------------------------------------------------------------------------------------------

export interface AxisState {
  lo: number;
  hi: number;
  /** ms timestamp since when the needed range stayed below 50 % of the axis (null = not shrinking) */
  lowSince: number | null;
}

export interface AxisOpts {
  zeroBased: boolean;
  manualMin: number | null;
  manualMax: number | null;
  /** approximate tick count used for snapping */
  ticks?: number;
}

export const AXIS_SHRINK_MS = 2000;
export const AXIS_SHRINK_RATIO = 0.5;

function niceStep(range: number, ticks: number): number {
  const raw = range / Math.max(1, ticks);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
}

function snapBounds(lo: number, hi: number, ticks: number): [number, number] {
  let a = lo;
  let b = hi;
  if (b - a < 1e-12) {
    const d = Math.abs(a) > 0 ? Math.abs(a) * 0.1 : 1;
    a -= d;
    b += d;
  }
  const step = niceStep(b - a, ticks);
  let slo = Math.floor(a / step + 1e-9) * step;
  let shi = Math.ceil(b / step - 1e-9) * step;
  if (lo - slo < 0.02 * (shi - slo) && lo < 0 && lo !== slo) slo -= step; // keep data off the frame
  if (shi - hi < 0.02 * (shi - slo) && hi > 0 && hi !== shi) shi += step;
  return [Number(slo.toPrecision(12)), Number(shi.toPrecision(12))];
}

/**
 * Flicker-free Y axis. Bounds snap to nice tick steps and include 0 when `zeroBased`. Expands immediately when the data
 * leaves the axis; shrinks only after the needed range used < 50 % of the axis for >= 2 s (hysteresis). Manual
 * min/max override the corresponding side.
 */
export function stableAxis(prev: AxisState | null, dataLo: number, dataHi: number, nowMs: number, opts: AxisOpts): AxisState {
  const ticks = opts.ticks ?? 5;
  let lo = dataLo;
  let hi = dataHi;
  if (opts.zeroBased) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  let [nlo, nhi] = snapBounds(lo, hi, ticks);
  const manual = (a: number, b: number): AxisState => {
    const mlo = opts.manualMin ?? a;
    const mhi = opts.manualMax ?? b;
    return mhi > mlo ? { lo: mlo, hi: mhi, lowSince: null } : { lo: mlo, hi: mlo + 1, lowSince: null };
  };
  if (opts.manualMin !== null && opts.manualMax !== null) return manual(nlo, nhi);
  let next: AxisState;
  if (prev === null) {
    next = { lo: nlo, hi: nhi, lowSince: null };
  } else if (nlo < prev.lo || nhi > prev.hi) {
    nlo = Math.min(nlo, prev.lo);
    nhi = Math.max(nhi, prev.hi);
    next = { lo: nlo, hi: nhi, lowSince: null };
  } else if ((nhi - nlo) / (prev.hi - prev.lo) < AXIS_SHRINK_RATIO) {
    const since = prev.lowSince ?? nowMs;
    next = nowMs - since >= AXIS_SHRINK_MS ? { lo: nlo, hi: nhi, lowSince: null } : { lo: prev.lo, hi: prev.hi, lowSince: since };
  } else {
    next = { lo: prev.lo, hi: prev.hi, lowSince: null };
  }
  return opts.manualMin !== null || opts.manualMax !== null ? manual(next.lo, next.hi) : next;
}

/** Index of the point whose time is closest to `tRel` (µs since series start); -1 for an empty series. */
export function nearestIndex(tUsRel: Float64Array, tRel: number): number {
  const n = tUsRel.length;
  if (n === 0) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tUsRel[mid] < tRel) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(tUsRel[lo - 1] - tRel) <= Math.abs(tUsRel[lo] - tRel)) return lo - 1;
  return lo;
}

/** "Nice" tick values covering [lo, hi] with about `count` ticks. */
export function niceTicks(lo: number, hi: number, count: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return Number.isFinite(lo) ? [lo] : [];
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/**
 * Frozen R2a backend error codes with a UI hint. `invalid` has no hint on purpose: the backend message is shown as is.
 * Any other code falls back to the raw message.
 */
export const RE_ERR_HINT_KEYS: Readonly<Record<string, TranslationKey>> = {
  no_reference: 're.err.no_reference',
  focus_full: 're.err.focus_full',
  not_started: 're.err.not_started',
};
