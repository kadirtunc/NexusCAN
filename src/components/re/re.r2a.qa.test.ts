/**
 * QA gate probes for RE Toolkit R2a series binary codec (planning/contracts/re-toolkit-v1.md §6.3, §6.6).
 * Written independent of the implementer's own `test:re-r2a`. Buffers are hand-built here (NOT with
 * `encodeReSeriesForTest`) so encoder/decoder symmetry bugs cannot cancel out.
 *
 * Assumed API: `decodeReSeries(buf: ArrayBuffer): ReSeries` from `src/services/reSeriesCodec.ts`:
 *   { seriesCount, pointsMax, fromUs, series: { kind: 'candidate'|'reference', index,
 *     points: { tUsRel: Float64Array, min: Float64Array, max: Float64Array } }[] }
 * Malformed input throws `ReCodecError` (codes badMagic / truncated / badField / trailing) and never
 * reads past the end (a RangeError counts as a FAIL).
 * Golden bytes: `crates/nexus-hal/tests/fixtures/re_series_golden.bin` (+ `.json` sidecar) from the Rust encoder.
 * Run: `npm run test:re-r2a-qa` (from the repo root).
 */
import { decodeReSeries } from '../../services/reSeriesCodec';
import { ReCodecError } from '../../services/reSnapshotCodec';
import type { ReSeries } from '../../types/re';

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
function eqv(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
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

// ─── Node shims (app tsconfig has no node types: reach them through globalThis) ──

interface NodeFsShim {
  readFileSync(path: string, enc?: string): Uint8Array | string;
  existsSync(path: string): boolean;
}
interface NodeProcShim {
  exitCode?: number;
  getBuiltinModule?: (id: string) => unknown;
}
const proc = (globalThis as { process?: NodeProcShim }).process;
const fs = proc?.getBuiltinModule?.('node:fs') as NodeFsShim | undefined;

const GOLDEN = 'crates/nexus-hal/tests/fixtures/re_series_golden.bin';
const GOLDEN_JSON = 'crates/nexus-hal/tests/fixtures/re_series_golden.json';

// ─── Independent hand-built encoder ─────────────────────────────────────────────

interface PtSpec {
  t: number;
  min: number;
  max: number;
}
interface SerSpec {
  kind: number;
  index: number;
  pts: PtSpec[];
  countOverride?: number;
}
interface HdrSpec {
  magic?: string;
  seriesCount?: number;
  pointsMax?: number;
  fromLo?: number;
  fromHi?: number;
}

function build(h: HdrSpec, series: SerSpec[]): ArrayBuffer {
  const size = 16 + series.reduce((s, x) => s + 8 + x.pts.length * 20, 0);
  const buf = new ArrayBuffer(size);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const magic = h.magic ?? 'NRS1';
  for (let i = 0; i < 4; i += 1) u8[i] = magic.charCodeAt(i) & 0xff;
  u8[4] = h.seriesCount ?? series.length;
  u8[5] = 0;
  dv.setUint16(6, h.pointsMax ?? 4096, true);
  dv.setUint32(8, h.fromLo ?? 0, true);
  dv.setUint32(12, h.fromHi ?? 0, true);
  let off = 16;
  for (const s of series) {
    u8[off] = s.kind;
    u8[off + 1] = s.index;
    dv.setUint16(off + 2, 0, true);
    dv.setUint32(off + 4, (s.countOverride ?? s.pts.length) >>> 0, true);
    off += 8;
    for (const p of s.pts) {
      dv.setUint32(off, p.t >>> 0, true);
      dv.setFloat64(off + 4, p.min, true);
      dv.setFloat64(off + 12, p.max, true);
      off += 20;
    }
  }
  return buf;
}

/** Contract rejection = a thrown ReCodecError. Returns its code, or a description of what happened instead. */
function rejection(buf: ArrayBuffer): { rejected: boolean; code: string } {
  try {
    const r = decodeReSeries(buf);
    return { rejected: false, code: `returned ${JSON.stringify(summary(r))}` };
  } catch (e) {
    if (e instanceof ReCodecError) return { rejected: true, code: e.code };
    if (e instanceof RangeError) return { rejected: false, code: `RangeError (read past end): ${e.message}` };
    return { rejected: false, code: `non-ReCodecError throw: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function summary(s: ReSeries): unknown {
  return { seriesCount: s.seriesCount, series: s.series?.map((x) => [x.kind, x.index, x.points.tUsRel.length]) };
}

function arr(a: ArrayLike<number>): number[] {
  return Array.from(a);
}

function readFileAb(path: string): ArrayBuffer {
  const raw = fs?.readFileSync(path) as Uint8Array;
  // Node Buffers may be views into a shared pool: copy exactly the file bytes.
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
}

// ─── Probes ─────────────────────────────────────────────────────────────────────

interface GoldenJson {
  byteLength: number;
  header: { fromUs: number; magic: string; pointsMax: number; seriesCount: number };
  series: Array<{ index: number; kind: string; kindCode: number; pointCount: number; points: PtJson[] }>;
}
interface PtJson {
  tUsRel: number;
  min: number | null;
  max: number | null;
}

function main(): void {
  probe('golden: Rust-produced .bin decodes and equals the .json sidecar exactly', () => {
    if (!fs) {
      check(false, 'node:fs unavailable (process.getBuiltinModule missing; Node >= 20.16 required)');
      return;
    }
    for (const p of [GOLDEN, GOLDEN_JSON]) {
      if (!fs.existsSync(p)) {
        check(false, `golden fixture missing: ${p} (backend-dev must produce it; run from repo root)`);
        return;
      }
    }
    const ab = readFileAb(GOLDEN);
    const g = JSON.parse(fs.readFileSync(GOLDEN_JSON, 'utf8') as string) as GoldenJson;
    eqv(ab.byteLength, g.byteLength, 'byteLength matches sidecar');
    const s = decodeReSeries(ab);
    eqv([s.seriesCount, s.pointsMax, s.fromUs], [g.header.seriesCount, g.header.pointsMax, g.header.fromUs], 'header');
    eqv(s.series.length, g.series.length, 'series count');
    g.series.forEach((gs, i) => {
      const ds = s.series[i];
      if (!ds) return;
      eqv([ds.kind, ds.index, ds.points.tUsRel.length], [gs.kind, gs.index, gs.pointCount], `series ${i} header`);
      eqv(arr(ds.points.tUsRel), gs.points.map((p) => p.tUsRel), `series ${i} tUsRel`);
      // JSON has no NaN: null in the sidecar stands for NaN.
      const nanOr = (v: number | null): number => (v === null ? NaN : v);
      const same = (a: number, b: number): boolean => (Number.isNaN(a) && Number.isNaN(b)) || Object.is(a, b) || a === b;
      gs.points.forEach((p, k) => {
        check(same(ds.points.min[k], nanOr(p.min)) && same(ds.points.max[k], nanOr(p.max)),
          `series ${i} point ${k} min/max`, `want ${p.min}/${p.max}, got ${ds.points.min[k]}/${ds.points.max[k]}`);
      });
    });
    check(s.series.some((x) => x.kind === 'candidate'), 'golden covers a candidate series');
    check(s.series.some((x) => x.kind === 'reference'), 'golden covers a reference series');
  });

  probe('golden: decoder output equals an independent DataView walk', () => {
    if (!fs || !fs.existsSync(GOLDEN)) {
      check(false, 'golden fixture missing');
      return;
    }
    const ab = readFileAb(GOLDEN);
    const dv = new DataView(ab);
    const s = decodeReSeries(ab);
    eqv(String.fromCharCode(...new Uint8Array(ab, 0, 4)), 'NRS1', 'magic');
    eqv(s.fromUs, dv.getUint32(8, true) + dv.getUint32(12, true) * 2 ** 32, 'fromUs u64 LE @8');
    let off = 16;
    for (const x of s.series) {
      eqv([x.kind === 'candidate' ? 0 : 1, x.index], [dv.getUint8(off), dv.getUint8(off + 1)], 'series header bytes');
      const n = dv.getUint32(off + 4, true);
      off += 8;
      eqv(x.points.tUsRel.length, n, 'pointCount');
      check(n <= s.pointsMax, `pointCount ${n} <= pointsMax ${s.pointsMax}`);
      for (let k = 0; k < n; k += 1) {
        check(x.points.tUsRel[k] === dv.getUint32(off, true), `t[${k}]`);
        check(Object.is(x.points.min[k], dv.getFloat64(off + 4, true)) || Number.isNaN(x.points.min[k]), `min[${k}]`);
        check(Object.is(x.points.max[k], dv.getFloat64(off + 12, true)) || Number.isNaN(x.points.max[k]), `max[${k}]`);
        if (k > 0) check(x.points.tUsRel[k - 1] <= x.points.tUsRel[k], `series time-ordered at ${k}`);
        off += 20;
      }
    }
    eqv(off, ab.byteLength, 'walk consumes the file exactly');
  });

  probe('header + points: little-endian, unsigned, u64 fromUs exact up to 2^53-1', () => {
    const buf = build({ pointsMax: 0xfffe, fromLo: 0xffffffff, fromHi: 0x1fffff }, [
      { kind: 0, index: 0, pts: [{ t: 0, min: -1.5, max: 2.25 }, { t: 0xffffffff, min: 7, max: 7 }] },
      { kind: 0, index: 3, pts: [] },
      { kind: 1, index: 0, pts: [{ t: 0x01020304, min: -0, max: Infinity }] },
    ]);
    const s = decodeReSeries(buf);
    eqv([s.seriesCount, s.pointsMax, s.fromUs], [3, 0xfffe, 2 ** 53 - 1], 'header (pointsMax u16 unsigned, fromUs 2^53-1)');
    eqv(s.series.map((x) => [x.kind, x.index, x.points.tUsRel.length]), [['candidate', 0, 2], ['candidate', 3, 0], ['reference', 0, 1]], 'series headers');
    const a = s.series[0].points;
    eqv([arr(a.tUsRel), arr(a.min), arr(a.max)], [[0, 0xffffffff], [-1.5, 7], [2.25, 7]], 'points (tUsRel u32 unsigned, not -1)');
    const r = s.series[2].points;
    eqv(r.tUsRel[0], 0x01020304, 'tUsRel little-endian');
    check(Object.is(r.min[0], -0), 'f64 -0 preserved');
    check(r.max[0] === Infinity, 'f64 +Infinity preserved');
    eqv(decodeReSeries(build({ fromLo: 5, fromHi: 0x100 }, [])).fromUs, 0x100 * 2 ** 32 + 5, 'fromUs = hi*2^32 + lo');
  });

  probe('f64 NaN passthrough (min and max, incl. non-canonical NaN payload)', () => {
    const buf = build({}, [{ kind: 0, index: 1, pts: [{ t: 10, min: NaN, max: NaN }, { t: 20, min: 1, max: NaN }, { t: 30, min: NaN, max: -2 }] }]);
    // Non-canonical NaN payload in point 0 min: 0x7FF8_0000_DEAD_BEEF.
    const dv = new DataView(buf);
    dv.setUint32(16 + 8 + 4, 0xdeadbeef, true);
    dv.setUint32(16 + 8 + 8, 0x7ff80000, true);
    const r = rejection(buf);
    check(!r.rejected, 'NaN values must not be rejected', r.code);
    if (r.rejected) return;
    const p = decodeReSeries(buf).series[0].points;
    check(Number.isNaN(p.min[0]) && Number.isNaN(p.max[0]), 'point 0 NaN/NaN');
    check(p.min[1] === 1 && Number.isNaN(p.max[1]), 'point 1 1/NaN');
    check(Number.isNaN(p.min[2]) && p.max[2] === -2, 'point 2 NaN/-2');
    eqv(arr(p.tUsRel), [10, 20, 30], 'times next to NaN values intact');
  });

  probe('empty: header-only (seriesCount 0) and zero-point series decode', () => {
    const s0 = decodeReSeries(build({ pointsMax: 16 }, []));
    eqv([s0.seriesCount, s0.series.length, s0.pointsMax], [0, 0, 16], 'header-only buffer');
    const s1 = decodeReSeries(build({}, [{ kind: 1, index: 0, pts: [] }]));
    eqv(s1.series.map((x) => [x.kind, x.points.tUsRel.length, x.points.min.length, x.points.max.length]), [['reference', 0, 0, 0]], 'zero-point series');
  });

  probe('bad magic rejected (badMagic)', () => {
    for (const m of ['NRS2', 'nrs1', '1SRN', 'NRE1', '\0\0\0\0']) {
      const r = rejection(build({ magic: m }, [{ kind: 0, index: 0, pts: [{ t: 1, min: 1, max: 1 }] }]));
      check(r.rejected && r.code === 'badMagic', `magic ${JSON.stringify(m)} -> badMagic`, r.code);
    }
  });

  probe('truncated: every strict prefix of a valid buffer is rejected (never reads past end)', () => {
    const buf = build({ pointsMax: 4 }, [
      { kind: 0, index: 0, pts: [{ t: 1, min: 1, max: 2 }, { t: 2, min: -3, max: 4 }] },
      { kind: 0, index: 1, pts: [] },
      { kind: 1, index: 0, pts: [{ t: 9, min: NaN, max: NaN }] },
    ]);
    let bad = 0;
    const firstBad: string[] = [];
    for (let n = 0; n < buf.byteLength; n += 1) {
      const r = rejection(buf.slice(0, n));
      const okCode = r.rejected && (n < 4 || r.code === 'truncated');
      if (!okCode) {
        bad += 1;
        if (firstBad.length < 4) firstBad.push(`len ${n}: ${r.code}`);
      }
    }
    check(bad === 0, `${bad}/${buf.byteLength} truncated prefixes not rejected as 'truncated'`, firstBad.join('\n      '));
    check(!rejection(buf).rejected, 'the untruncated buffer must decode');
  });

  probe('trailing bytes rejected (trailing), 1..21 extra bytes', () => {
    const base = build({}, [{ kind: 0, index: 0, pts: [{ t: 1, min: 1, max: 1 }] }]);
    for (const extra of [1, 7, 8, 19, 20, 21]) {
      const b = new ArrayBuffer(base.byteLength + extra);
      new Uint8Array(b).set(new Uint8Array(base));
      const r = rejection(b);
      check(r.rejected && r.code === 'trailing', `+${extra} trailing bytes -> trailing`, r.code);
    }
    // A whole extra zero-point series header beyond seriesCount is also trailing data.
    const two = build({ seriesCount: 1 }, [{ kind: 0, index: 0, pts: [] }, { kind: 1, index: 0, pts: [] }]);
    const r = rejection(two);
    check(r.rejected && r.code === 'trailing', 'series beyond seriesCount -> trailing', r.code);
  });

  probe('hostile: huge pointCount / seriesCount > present / kind > 1 rejected fast', () => {
    const t0 = Date.now();
    const huge = rejection(build({}, [{ kind: 0, index: 0, pts: [{ t: 1, min: 1, max: 1 }], countOverride: 0xffffffff }]));
    check(huge.rejected && huge.code === 'truncated', 'pointCount 0xFFFFFFFF -> truncated (no huge allocation)', huge.code);
    const off1 = rejection(build({}, [{ kind: 0, index: 0, pts: [{ t: 1, min: 1, max: 1 }], countOverride: 2 }]));
    check(off1.rejected && off1.code === 'truncated', 'pointCount one past the data -> truncated', off1.code);
    check(Date.now() - t0 < 200, 'hostile counts rejected without heavy work');
    const more = rejection(build({ seriesCount: 3 }, [{ kind: 0, index: 0, pts: [] }, { kind: 1, index: 0, pts: [] }]));
    check(more.rejected && more.code === 'truncated', 'seriesCount 3 with 2 present -> truncated', more.code);
    for (const k of [2, 0x80, 0xff]) {
      const r = rejection(build({}, [{ kind: k, index: 0, pts: [] }]));
      check(r.rejected && r.code === 'badField', `kind ${k} -> badField`, r.code);
    }
    for (const n of [0, 1, 4, 15]) {
      const r = rejection(new ArrayBuffer(n));
      check(r.rejected, `${n}-byte buffer rejected`, r.code);
    }
  });

  probe('decoder is pure: input bytes unchanged, outputs independent', () => {
    const buf = build({}, [{ kind: 0, index: 2, pts: [{ t: 5, min: 1, max: 2 }] }]);
    const before = arr(new Uint8Array(buf));
    const a = decodeReSeries(buf);
    a.series[0].points.min[0] = 999;
    const b = decodeReSeries(buf);
    eqv(arr(new Uint8Array(buf)), before, 'input buffer not mutated');
    eqv(b.series[0].points.min[0], 1, 'mutating one decode result does not leak into the next');
  });

  const failed = results.filter((x) => !x.ok);
  console.log(`\nre.r2a.qa: ${results.length - failed.length}/${results.length} probes PASS (${totalChecks} checks)`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((x) => x.name).join(', ')}`);
    if (proc) proc.exitCode = 1;
  }
}

main();
