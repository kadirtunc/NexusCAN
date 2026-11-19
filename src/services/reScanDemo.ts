/**
 * DEMO-ONLY Value Scan over the synthetic `ReDemoEngine` rows (pure TS, browser preview). It mirrors the frozen
 * semantics of the backend scan (re-toolkit-v1 §8.2 / §8.6) on the tiny demo row set and is NEVER used for live data:
 * `reClient` routes scans here only when the runtime source is `demo`. Limits of this simulation: toggle exactness
 * for "changed" is judged on the (<= 64 sample) row history, grouping is skipped for > 3000 survivors per bucket,
 * no time budget / truncation.
 */
import { fieldBits } from '../components/re/reModel';
import {
  RE_SCAN_MAX_CANDIDATES,
  RE_SCAN_MAX_UNDO,
  RE_SCAN_MAX_RESULTS,
  RE_SCAN_PRESETS,
  defaultPhysicalTolerance,
  scanCandidateKey,
} from '../components/re/reScanModel';
import type { ReFieldKind } from '../types/re';
import type {
  ReScalePresetDto,
  ReScanCandidateDto,
  ReScanFirstSpec,
  ReScanNextOp,
  ReScanReadMode,
  ReScanResultRowDto,
  ReScanResultsDto,
  ReScanSort,
  ReScanStatusDto,
} from '../types/reScan';
import { demoRaw } from './reSignalDemo';
import type { DemoScanRow, ReDemoEngine } from './reDemo';

interface DCand {
  c: ReScanCandidateDto;
  mask: bigint;
  width: number;
  cur: number;
  prev: number | null;
  preset: ReScalePresetDto | null;
  changeCount: number;
  hint: ReFieldKind | null;
}

const err = (code: string, text: string): Error => new Error(`[re:${code}] ${text}`);
const rowId = (r: { bus: number; isExtended: boolean; arbId: number }): string => `${r.bus}:${r.isExtended ? 'x' : 's'}:${r.arbId}`;

/** Raw field value of one payload (signed = two's complement of the field, float32 = IEEE single). */
export function demoScanRaw(payload: Uint8Array, c: ReScanCandidateDto, bits: readonly number[]): number {
  const raw = demoRaw(payload, bits, c.byteOrder);
  if (c.valueType === 'float32') {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setUint32(0, Number(raw), true);
    return dv.getFloat32(0, true);
  }
  if (c.valueType === 'signed') return Number(BigInt.asIntN(c.bitLength, raw));
  return Number(raw);
}

function bitsOf(c: { startBit: number; bitLength: number; byteOrder: "intel" | "motorola" }, maxBits: number): number[] {
  return fieldBits(c, maxBits);
}

function maskOf(bits: readonly number[]): bigint {
  let m = 0n;
  for (const b of bits) m |= 1n << BigInt(b);
  return m;
}

function hexMask(hex: string): bigint {
  let m = 0n;
  for (let i = 0; i < hex.length / 2; i += 1) m |= BigInt(Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0) << BigInt(i * 8);
  return m;
}

function readValue(row: DemoScanRow, c: ReScanCandidateDto, bits: readonly number[], mode: ReScanReadMode): number {
  if (mode.kind === 'latest' || row.historyData.length === 0) return demoScanRaw(row.latest, c, bits);
  const n = Math.min(mode.samples, row.historyData.length);
  const vals = row.historyData.slice(row.historyData.length - n).map((p) => demoScanRaw(p, c, bits));
  vals.sort((a, b) => a - b);
  return vals[Math.floor((vals.length - 1) / 2)];
}

function samePreset(a: ReScalePresetDto | null, b: ReScalePresetDto | null): boolean {
  return a === null || b === null ? a === b : a.factor === b.factor && a.offset === b.offset;
}

export class DemoScanner {
  private active = false;
  private scanId = 0;
  private step = 0;
  private cands: DCand[] = [];
  private undoStack: DCand[][] = [];
  private history: number[] = [];
  private elapsedMs = 0;
  private historyCovered: boolean | null = null;
  private lastScanTs = 0;
  private readMode: ReScanReadMode = { kind: 'latest' };
  private version = 0;
  private sortedCache: { key: string; rows: GroupedRow[] } | null = null;

  constructor(private readonly engine: ReDemoEngine) {}

  private rowMap(): Map<string, DemoScanRow> {
    return new Map(this.engine.scanRows().map((r) => [rowId(r), r]));
  }

  private newestTs(rows: Iterable<DemoScanRow>): number {
    let t = 0;
    for (const r of rows) if (r.historyTs.length > 0) t = Math.max(t, r.historyTs[r.historyTs.length - 1]);
    return t;
  }

  private ensureRunning(): void {
    if (!this.engine.status().enabled) throw err('not_started', 'RE capture is not running');
  }

  status(): ReScanStatusDto {
    return {
      active: this.active,
      scanId: this.scanId,
      step: this.step,
      candidates: this.active ? this.cands.length : 0,
      history: this.active ? [...this.history] : [],
      truncated: false,
      elapsedMs: this.elapsedMs,
      undoDepth: this.active ? this.undoStack.length : 0,
      historyCovered: this.historyCovered,
    };
  }

  /** Analyzer reset / new engine session: the old scan is gone. */
  invalidate(): void {
    this.active = false;
    this.cands = [];
    this.undoStack = [];
    this.history = [];
    this.step = 0;
    this.version += 1;
  }

  reset(): ReScanStatusDto {
    this.invalidate();
    this.historyCovered = null;
    return this.status();
  }

  first(spec: ReScanFirstSpec): ReScanStatusDto {
    this.ensureRunning();
    const t0 = Date.now();
    const o = spec.options;
    const rows = this.rowMap();
    const out: DCand[] = [];
    const step = o.alignment === 'byte' ? 8 : o.alignment === 'nibble' ? 4 : 1;
    const lengths = [...new Set([...o.lengths, ...(o.include64 ? [64] : [])])];
    const valued = spec.kind === 'exact' || spec.kind === 'physical';
    const presets = [...spec.userPresets, ...(spec.presets ?? RE_SCAN_PRESETS)];
    for (const row of rows.values()) {
      if (o.buses !== null && !o.buses.includes(row.bus)) continue;
      if (o.ids !== null && !o.ids.some((i) => i.bus === row.bus && i.arbId === row.arbId && i.isExtended === row.isExtended)) continue;
      const nbits = row.dlcBytes * 8;
      const key = { bus: row.bus, arbId: row.arbId, isExtended: row.isExtended };
      const cls = this.engine.classify(key);
      let skipMask = 0n;
      for (const f of cls.fields) {
        if (f.kind === 'counter' || f.kind === 'checksum') skipMask |= maskOf(bitsOf(f, nbits));
      }
      const constMask = hexMask(this.engine.rowDetail(key).constantMask);
      const emit = (c: ReScanCandidateDto): void => {
        const bits = bitsOf(c, nbits);
        if (bits.length < c.bitLength) return;
        if (c.byteOrder === 'motorola' && c.valueType !== 'float32' && bits[0] >> 3 === bits[bits.length - 1] >> 3) return;
        if (c.byteOrder === 'motorola' && c.valueType === 'float32' && bits[0] >> 3 === bits[bits.length - 1] >> 3) return;
        const lsb = c.byteOrder === 'intel' ? bits[0] : bits[bits.length - 1];
        if (lsb % step !== 0) return;
        const mask = maskOf(bits);
        if (o.excludeCounterChecksum && (mask & skipMask) !== 0n) return;
        if (o.excludeConstant && !valued && (mask & ~constMask) === 0n) return;
        const field = cls.fields.find((f) => (maskOf(bitsOf(f, nbits)) & mask) === mask);
        out.push({ c, mask, width: c.bitLength, cur: 0, prev: null, preset: null, changeCount: 0, hint: field?.kind ?? null });
      };
      const spans = (len: number, float: boolean): void => {
        for (const byteOrder of o.byteOrders) {
          for (let s = 0; s < nbits; s += 1) {
            if (byteOrder === 'intel' && s + len > nbits) break;
            if (float) emit({ ...key, startBit: s, bitLength: len, byteOrder, valueType: 'float32' });
            else {
              for (const signed of o.signed) {
                if (signed && len < 4) continue;
                emit({ ...key, startBit: s, bitLength: len, byteOrder, valueType: signed ? 'signed' : 'unsigned' });
              }
            }
          }
        }
      };
      for (const len of lengths) spans(len, false);
      if (o.float32) spans(32, true);
      if (out.length > RE_SCAN_MAX_CANDIDATES) throw err('scan_too_large', `more than ${RE_SCAN_MAX_CANDIDATES} candidates; narrow the scan`);
    }
    // evaluate
    this.readMode = o.readMode;
    const survivors: DCand[] = [];
    for (const d of out) {
      const row = rows.get(rowId(d.c));
      if (row === undefined) continue;
      const bits = bitsOf(d.c, row.dlcBytes * 8);
      const cur = readValue(row, d.c, bits, o.readMode);
      let keep = true;
      let preset: ReScalePresetDto | null = null;
      if (spec.kind === 'exact') {
        keep = Math.abs(cur - (spec.value ?? 0)) <= (spec.tolerance ?? 0);
      } else if (spec.kind === 'physical') {
        const x = spec.value ?? 0;
        preset = presets.find((p) => Math.abs(cur * p.factor + p.offset - x) <= (spec.tolerance ?? defaultPhysicalTolerance(x, p.factor))) ?? null;
        keep = preset !== null;
      } else if (spec.kind === 'range') {
        const [a, b] = spec.range ?? [0, 0];
        if (spec.physical) {
          preset = presets.find((p) => cur * p.factor + p.offset >= a && cur * p.factor + p.offset <= b) ?? null;
          keep = preset !== null;
        } else keep = cur >= a && cur <= b;
      }
      if (keep && Number.isFinite(cur)) survivors.push({ ...d, cur, preset });
    }
    this.commitFirst(survivors, rows, t0);
    return this.status();
  }

  private commitFirst(survivors: DCand[], rows: Map<string, DemoScanRow>, t0: number): void {
    this.scanId += 1;
    this.step = 0;
    this.active = true;
    this.cands = survivors;
    this.undoStack = [];
    this.history = [survivors.length];
    this.historyCovered = null;
    this.lastScanTs = this.newestTs(rows.values());
    this.elapsedMs = Date.now() - t0;
    this.version += 1;
  }

  next(op: ReScanNextOp): ReScanStatusDto {
    if (!this.active) throw err('no_scan', 'no active scan');
    this.ensureRunning();
    const t0 = Date.now();
    const rows = this.rowMap();
    const newest = this.newestTs(rows.values());
    const grid = op.presets ?? RE_SCAN_PRESETS;
    let covered = true;
    const survivors: DCand[] = [];
    for (const d of this.cands) {
      const row = rows.get(rowId(d.c));
      if (row === undefined) continue;
      const bits = bitsOf(d.c, row.dlcBytes * 8);
      const cur = readValue(row, d.c, bits, this.readMode);
      const prev = d.cur; // value at the previous scan
      let preset = d.preset;
      let keep = true;
      switch (op.op) {
        case 'changed':
        case 'unchanged': {
          let changed = cur !== prev;
          let last = prev;
          for (let i = 0; i < row.historyTs.length && !changed; i += 1) {
            if (row.historyTs[i] < this.lastScanTs) continue;
            const v = demoScanRaw(row.historyData[i], d.c, bits);
            if (v !== last) changed = true;
            last = v;
          }
          keep = op.op === 'changed' ? changed : !changed;
          break;
        }
        case 'increased':
          keep = cur > prev;
          break;
        case 'decreased':
          keep = cur < prev;
          break;
        case 'either':
          keep = cur !== prev;
          break;
        case 'increasedBy':
        case 'decreasedBy': {
          const n = op.value ?? 0;
          const delta = op.op === 'increasedBy' ? cur - prev : prev - cur;
          if (op.physical) {
            const cands = preset !== null ? [preset] : grid;
            const hit = cands.find((p) => Math.abs(delta * p.factor - n) <= (op.tolerance ?? defaultPhysicalTolerance(n, p.factor)));
            keep = hit !== undefined;
            if (hit !== undefined) preset = hit;
          } else keep = Math.abs(delta - n) <= (op.tolerance ?? 0);
          break;
        }
        case 'exact':
        case 'range': {
          const [a, b] = op.op === 'range' ? (op.range ?? [0, 0]) : [0, 0];
          const x = op.value ?? 0;
          const inRange = (v: number): boolean => (op.op === 'exact' ? false : v >= a && v <= b);
          if (op.physical) {
            const phys = (p: ReScalePresetDto): number => cur * p.factor + p.offset;
            const ok = (p: ReScalePresetDto): boolean =>
              op.op === 'exact' ? Math.abs(phys(p) - x) <= (op.tolerance ?? defaultPhysicalTolerance(x, p.factor)) : inRange(phys(p));
            const hit = (preset !== null ? [preset] : grid).find(ok);
            keep = hit !== undefined;
            if (hit !== undefined) preset = hit;
          } else keep = op.op === 'exact' ? Math.abs(cur - x) <= (op.tolerance ?? 0) : inRange(cur);
          break;
        }
        case 'stable': {
          const from = newest - (op.stableMs ?? 0) * 1000;
          if (row.historyTs.length === 0 || row.historyTs[0] > from) covered = false;
          keep = true;
          for (let i = 0; i < row.historyTs.length && keep; i += 1) {
            if (row.historyTs[i] >= from && demoScanRaw(row.historyData[i], d.c, bits) !== cur) keep = false;
          }
          break;
        }
      }
      if (keep) survivors.push({ ...d, prev, cur, preset, changeCount: d.changeCount + (cur !== prev ? 1 : 0) });
    }
    this.undoStack.push(this.cands);
    if (this.undoStack.length > RE_SCAN_MAX_UNDO) this.undoStack.shift();
    this.cands = survivors;
    this.step += 1;
    this.history = [...this.history, survivors.length];
    this.historyCovered = op.op === 'stable' ? covered : null;
    this.lastScanTs = newest;
    this.elapsedMs = Date.now() - t0;
    this.version += 1;
    return this.status();
  }

  undo(): ReScanStatusDto {
    if (!this.active) throw err('no_scan', 'no active scan');
    const prev = this.undoStack.pop();
    if (prev === undefined) throw err('invalid', 'nothing to undo');
    this.cands = prev;
    this.step -= 1;
    this.history = this.history.slice(0, -1);
    this.historyCovered = null;
    this.version += 1;
    return this.status();
  }

  results(offset: number, limit: number, sort: ReScanSort): ReScanResultsDto {
    if (!this.active) throw err('no_scan', 'no active scan');
    if (!Number.isInteger(offset) || offset < 0) throw err('invalid', `offset ${offset}`);
    if (!Number.isInteger(limit) || limit < 1 || limit > RE_SCAN_MAX_RESULTS) throw err('invalid', `limit must be 1..=${RE_SCAN_MAX_RESULTS}`);
    const grouped = this.sorted(sort);
    const rows = this.rowMap();
    const page = grouped.slice(offset, offset + limit).map((g): ReScanResultRowDto => {
      const row = rows.get(rowId(g.head.c));
      let currentRaw: number | null = null;
      if (row !== undefined) {
        const v = demoScanRaw(row.latest, g.head.c, bitsOf(g.head.c, row.dlcBytes * 8));
        currentRaw = Number.isFinite(v) ? v : null;
      }
      const p = g.head.preset;
      return {
        candidate: g.head.c,
        preset: p,
        currentRaw,
        currentPhysical: currentRaw !== null && p !== null ? currentRaw * p.factor + p.offset : null,
        previousRaw: g.head.prev,
        changeCount: g.head.changeCount,
        kindHint: g.head.hint,
        containedCount: g.contained.length,
        contained: g.contained.map((x) => x.c),
      };
    });
    return { scanId: this.scanId, step: this.step, total: grouped.length, candidates: this.cands.length, offset, rows: page };
  }

  private sorted(sort: ReScanSort): GroupedRow[] {
    const key = `${this.version}:${sort}`;
    if (this.sortedCache?.key === key) return this.sortedCache.rows;
    const byId = (a: DCand, b: DCand): number =>
      a.c.bus - b.c.bus || Number(a.c.isExtended) - Number(b.c.isExtended) || a.c.arbId - b.c.arbId || a.c.startBit - b.c.startBit || a.c.bitLength - b.c.bitLength;
    const rows = groupCandidates(this.cands);
    rows.sort((a, b) => {
      if (sort === 'changes') return b.head.changeCount - a.head.changeCount || byId(a.head, b.head);
      if (sort === 'width') return b.head.width - a.head.width || byId(a.head, b.head);
      return byId(a.head, b.head);
    });
    this.sortedCache = { key, rows };
    return rows;
  }
}

interface GroupedRow {
  head: DCand;
  contained: DCand[];
}

/** Same row, strict bit subset, equal changeCount >= 1, same preset: the widest candidate keeps the others. */
function groupCandidates(cands: readonly DCand[]): GroupedRow[] {
  const out: GroupedRow[] = [];
  const buckets = new Map<string, DCand[]>();
  for (const d of cands) {
    if (d.changeCount < 1) {
      out.push({ head: d, contained: [] });
      continue;
    }
    const k = `${rowId(d.c)}|${d.changeCount}|${d.preset?.factor ?? ''}|${d.preset?.offset ?? ''}`;
    const list = buckets.get(k);
    if (list === undefined) buckets.set(k, [d]);
    else list.push(d);
  }
  for (const list of buckets.values()) {
    if (list.length > 3000) {
      for (const d of list) out.push({ head: d, contained: [] });
      continue;
    }
    const heads: GroupedRow[] = [];
    for (const d of [...list].sort((a, b) => b.width - a.width)) {
      const host = heads.find((h) => h.head.mask !== d.mask && (h.head.mask & d.mask) === d.mask && samePreset(h.head.preset, d.preset));
      if (host === undefined) heads.push({ head: d, contained: [] });
      else host.contained.push(d);
    }
    out.push(...heads);
  }
  return out;
}

export { scanCandidateKey as demoScanKey };
