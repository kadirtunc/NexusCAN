/**
 * R2a DEMO signal source (browser preview only; reClient flags everything DEMO and the UI badges it).
 * Synthetic payload history is a pure function of time, so series/correlation need no stored ring. The bit
 * extraction here is a DEMO-ONLY helper (sawtooth order comes from `fieldBits`); the real path never uses it - on
 * Tauri all values come from the Rust `NormalizedBitSpan` extractor via `cmd_re_series` / `cmd_re_correlate`.
 *
 * Synthetic targets: 0x100 (16-bit Intel sine @16, 30 s period) and 0x18FF1234 ext (16-bit ramp @0, +300/s).
 * Demo OBD reference (any PID): `raw16(0x100) * 0.5 + 10` -> the sweep must find 0x100 @16+16 intel, factor 0.5.
 */
import { fieldBits } from '../components/re/reModel';
import type {
  ReCandidateDto,
  ReCorrelateRequest,
  ReCorrelationResultDto,
  ReCorrelationRowDto,
  ReFocusStatusDto,
  ReMarkerDto,
  RePoints,
  ReReferenceDto,
  ReSeries,
  ReSeriesEntry,
  ReSeriesRequest,
  ReTargetDto,
} from '../types/re';

export const DEMO_STEP_US = 10_000;
const DEMO_DEFAULT_SPAN_US = 30_000_000;
const DEMO_BUDGET_MS = 2000;

export interface DemoSignalEnv {
  nowUs: number;
  /** virtual-time origin so the 16-bit ramps never wrap inside the visible window */
  originUs: number;
  markers: readonly ReMarkerDto[];
}

function sampleIndex(env: DemoSignalEnv, tUs: number): number {
  return Math.max(0, Math.floor((tUs - env.originUs) / DEMO_STEP_US));
}

export function demoPayload(arbId: number, n: number): Uint8Array {
  const p = new Uint8Array(8);
  if (arbId === 0x100) {
    const ramp = Math.round(30000 + 20000 * Math.sin((2 * Math.PI * n) / 3000)) & 0xffff; // 30 s sine: needs all 16 bits
    p[0] = 0xa0 | (n & 0x0f);
    p[1] = 0x55;
    p[2] = ramp & 0xff;
    p[3] = ramp >> 8;
    p[4] = 0x40;
  } else if (arbId === 0x18ff1234) {
    const v = (n * 3) & 0xffff;
    p[0] = v & 0xff;
    p[1] = v >> 8;
    p[2] = 0x7d;
  } else {
    p.fill(0x11);
  }
  return p;
}

/** DEMO-ONLY raw bit assembly in signal order (see header note). */
export function demoRaw(payload: Uint8Array, bits: readonly number[], order: 'intel' | 'motorola'): bigint {
  let raw = 0n;
  const n = bits.length;
  for (let i = 0; i < n; i += 1) {
    const bit = bits[i];
    const set = ((payload[bit >> 3] ?? 0) >> (bit & 7)) & 1;
    if (set === 1) raw |= 1n << BigInt(order === 'intel' ? i : n - 1 - i);
  }
  return raw;
}

export function demoValue(payload: Uint8Array, c: ReCandidateDto): number {
  const bits = fieldBits(c, 512);
  if (bits.length < c.bitLength) return Number.NaN;
  const raw = demoRaw(payload, bits, c.byteOrder);
  let v: number;
  if (c.valueType === 'float32' && c.bitLength === 32) {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setUint32(0, Number(raw), true);
    v = dv.getFloat32(0, true);
  } else if (c.valueType === 'float64' && c.bitLength === 64) {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setBigUint64(0, raw, true);
    v = dv.getFloat64(0, true);
  } else if (c.valueType === 'signed') {
    v = Number(BigInt.asIntN(c.bitLength, raw));
  } else {
    v = Number(raw);
  }
  return v * c.factor + c.offset;
}

export function decimate(t: readonly number[], v: readonly number[], fromUs: number, toUs: number, maxPoints: number): RePoints {
  const count = t.length;
  if (count <= maxPoints) {
    return {
      tUsRel: Float64Array.from(t, (x) => x - fromUs),
      min: Float64Array.from(v),
      max: Float64Array.from(v),
    };
  }
  const width = Math.max(1, (toUs - fromUs) / maxPoints);
  const ts: number[] = [];
  const mins: number[] = [];
  const maxs: number[] = [];
  let bucket = -1;
  for (let i = 0; i < count; i += 1) {
    const b = Math.min(maxPoints - 1, Math.floor((t[i] - fromUs) / width));
    if (b !== bucket) {
      bucket = b;
      ts.push(t[i] - fromUs);
      mins.push(v[i]);
      maxs.push(v[i]);
    } else {
      const k = mins.length - 1;
      if (v[i] < mins[k]) mins[k] = v[i];
      if (v[i] > maxs[k]) maxs[k] = v[i];
    }
  }
  return { tUsRel: Float64Array.from(ts), min: Float64Array.from(mins), max: Float64Array.from(maxs) };
}

function demoRamp(env: DemoSignalEnv, tUs: number): number {
  return demoValue(demoPayload(0x100, sampleIndex(env, tUs)), {
    startBit: 16, bitLength: 16, byteOrder: 'intel', valueType: 'unsigned', factor: 1, offset: 0,
  });
}

/** Reference value at time t, or NaN when undefined (e.g. before the first marker). */
export function demoReferenceValue(ref: ReReferenceDto, env: DemoSignalEnv, tUs: number): number {
  switch (ref.kind) {
    case 'obd_pid':
      return demoRamp(env, tUs) * 0.5 + 10;
    case 'markers': {
      let value = Number.NaN;
      let best = -Infinity;
      for (const p of ref.points) {
        const m = env.markers.find((x) => x.id === p.markerId);
        if (m !== undefined && m.tsUs <= tUs && m.tsUs > best) {
          best = m.tsUs;
          value = p.value;
        }
      }
      return value;
    }
    case 'candidate':
      return demoValue(demoPayload(ref.target.arbId, sampleIndex(env, tUs)), ref.candidate);
  }
}

function timeWindow(env: DemoSignalEnv, fromUs: number | null, toUs: number | null): [number, number] {
  const to = toUs ?? env.nowUs;
  const from = Math.max(0, fromUs ?? to - DEMO_DEFAULT_SPAN_US);
  return [from, Math.max(from + DEMO_STEP_US, to)];
}

export function demoSeries(req: ReSeriesRequest, env: DemoSignalEnv): ReSeries {
  const [from, to] = timeWindow(env, req.fromUs, req.toUs);
  const first = Math.ceil(from / DEMO_STEP_US) * DEMO_STEP_US;
  const times: number[] = [];
  for (let t = first; t <= to; t += DEMO_STEP_US) times.push(t);
  const series: ReSeriesEntry[] = [];
  req.candidates.slice(0, 4).forEach((c, index) => {
    const vals = times.map((t) => demoValue(demoPayload(req.target.arbId, sampleIndex(env, t)), c));
    series.push({ kind: 'candidate', index, points: decimate(times, vals, from, to, req.maxPoints) });
  });
  if (req.reference !== null) {
    const ref = req.reference;
    const rt: number[] = [];
    const rv: number[] = [];
    for (const t of times) {
      const v = demoReferenceValue(ref, env, t);
      if (!Number.isNaN(v)) {
        rt.push(t);
        rv.push(v);
      }
    }
    series.push({ kind: 'reference', index: 0, points: decimate(rt, rv, from, to, req.maxPoints) });
  }
  return { seriesCount: series.length, pointsMax: req.maxPoints, fromUs: from, series };
}

export function demoFocusStatus(targets: readonly ReTargetDto[], env: DemoSignalEnv): ReFocusStatusDto {
  return {
    targets: targets.map((t) => ({
      ...t,
      samples: 16384,
      firstUs: env.nowUs - 16384 * DEMO_STEP_US,
      lastUs: env.nowUs,
      auto: false,
    })),
  };
}

function setOf(c: ReCandidateDto): Set<number> {
  return new Set(fieldBits(c, 512));
}

/** Demo correlation sweep: same row semantics as the backend (Pearson r, LS fit raw->reference, superset dedupe). */
export function demoCorrelate(req: ReCorrelateRequest, env: DemoSignalEnv): ReCorrelationResultDto {
  const started = performance.now();
  const [from, to] = timeWindow(env, req.fromUs, req.toUs);
  const refT: number[] = [];
  const refV: number[] = [];
  const stepUs = Math.max(DEMO_STEP_US * 5, Math.ceil((to - from) / 300 / DEMO_STEP_US) * DEMO_STEP_US);
  for (let t = Math.ceil(from / stepUs) * stepUs; t <= to; t += stepUs) {
    const v = demoReferenceValue(req.reference, env, t);
    if (!Number.isNaN(v)) {
      refT.push(t);
      refV.push(v);
    }
  }
  const n = refV.length;
  const payloads = refT.map((t) => demoPayload(req.target.arbId, sampleIndex(env, t)));
  const mr = n === 0 ? 0 : refV.reduce((a, b) => a + b, 0) / n;
  let sRR = 0;
  for (const y of refV) sRR += (y - mr) * (y - mr);

  const rows: ReCorrelationRowDto[] = [];
  let evaluated = 0;
  let truncated = false;
  const s = req.search;
  const probe: ReCandidateDto = { startBit: 0, bitLength: 1, byteOrder: 'intel', valueType: 'unsigned', factor: 1, offset: 0 };
  outer: for (const order of s.byteOrders) {
    for (let start = s.bitFrom; start <= s.bitTo; start += 1) {
      for (let len = s.lengths[0]; len <= s.lengths[1]; len += 1) {
        const bits = fieldBits({ startBit: start, bitLength: len, byteOrder: order }, 512);
        if (bits.length < len || bits.some((b) => b < s.bitFrom || b > s.bitTo)) continue;
        if (performance.now() - started > DEMO_BUDGET_MS) {
          truncated = true;
          break outer;
        }
        const raws = payloads.map((p) => demoRaw(p, bits, order));
        for (const signed of s.signed) {
          evaluated += 1;
          const xs = raws.map((r) => Number(signed ? BigInt.asIntN(len, r) : r));
          const mx = xs.reduce((a, b) => a + b, 0) / n;
          let sXX = 0;
          let sXY = 0;
          for (let i = 0; i < n; i += 1) {
            sXX += (xs[i] - mx) * (xs[i] - mx);
            sXY += (xs[i] - mx) * (refV[i] - mr);
          }
          if (sXX === 0 || sRR === 0) continue;
          const r = sXY / Math.sqrt(sXX * sRR);
          const factor = sXY / sXX;
          const offset = mr - factor * mx;
          let sse = 0;
          for (let i = 0; i < n; i += 1) sse += (refV[i] - (factor * xs[i] + offset)) ** 2;
          rows.push({
            candidate: { ...probe, startBit: start, bitLength: len, byteOrder: order, valueType: signed ? 'signed' : 'unsigned', factor, offset },
            r, r2: r * r, rmse: Math.sqrt(sse / n), samples: n, lagMs: 0,
          });
        }
      }
    }
  }
  rows.sort((a, b) => {
    const d = Math.abs(b.r) - Math.abs(a.r);
    return Math.abs(d) > 1e-9 ? d : a.candidate.bitLength - b.candidate.bitLength; // float noise is a tie: shorter field wins
  });
  const kept: ReCorrelationRowDto[] = [];
  const keptSets: Set<number>[] = [];
  for (const row of rows) {
    const bits = setOf(row.candidate);
    const dup = kept.some((k, i) => {
      if (Math.abs(Math.abs(k.r) - Math.abs(row.r)) >= 0.002) return false;
      for (const b of keptSets[i]) if (!bits.has(b)) return false;
      return true;
    });
    if (dup) continue;
    kept.push(row);
    keptSets.push(bits);
    if (kept.length >= req.topN) break;
  }
  return { rows: kept, evaluated, referenceSamples: n, elapsedMs: performance.now() - started, truncated };
}
