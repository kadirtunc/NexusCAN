/** RE Toolkit R2a frontend tests: series codec, bit highlight vectors, plot geometry, signal store, demo correlation. Run: `npm run test:re-r2a`. */
import { decodeReSeries, encodeReSeriesForTest } from '../../services/reSeriesCodec';
import { getReTheme, heatLut, mix, parseColor, withAlpha } from './reTheme';
import { ReCodecError } from '../../services/reSnapshotCodec';
import { demoCorrelate, demoSeries, type DemoSignalEnv } from '../../services/reSignalDemo';
import {
  createReSignalStore, RE_SERIES_POLL_MS, type ReSignalApi,
} from '../../store/reSignalStore';
import {
  candidateFromField, defaultSearchFromConstant, dragSelection, nearestIndex, niceTicks, normalizeSearch, parseReError,
  alignedView, alignedWindow, AXIS_SHRINK_MS, formatAxisTime, plotRange, RE_ERR_HINT_KEYS, stableAxis, timeTicks, type AxisState, selectionBits, selectionFits,
} from './reSignalModel';
import type {
  ReCandidateDto, ReCorrelateRequest, ReCorrelationResultDto, ReSeries, ReSeriesRequest, ReTargetDto,
} from '../../types/re';

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}
function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof ReCodecError ? e.code : `other:${String(e)}`;
  }
}
const eq = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const range = (from: number, to: number): number[] => {
  const out: number[] = [];
  for (let v = from; v >= to; v -= 1) out.push(v);
  return out;
};

function mkSeries(): ReSeries {
  return {
    seriesCount: 2,
    pointsMax: 1024,
    fromUs: 0x1_0000_0000 + 5,
    series: [
      { kind: 'candidate', index: 0, points: { tUsRel: Float64Array.from([0, 1000, 4294967295]), min: Float64Array.from([-1.5, 0, Number.NaN]), max: Float64Array.from([2.5, 0, Number.NaN]) } },
      { kind: 'reference', index: 0, points: { tUsRel: new Float64Array(0), min: new Float64Array(0), max: new Float64Array(0) } },
    ],
  };
}

function codecTests(): void {
  const s = mkSeries();
  const buf = encodeReSeriesForTest(s);
  check('size', buf.byteLength === 16 + 8 + 3 * 20 + 8);
  const d = decodeReSeries(buf);
  check('hdr', d.seriesCount === 2 && d.pointsMax === 1024 && d.fromUs === s.fromUs, String(d.fromUs));
  check('kinds', d.series[0].kind === 'candidate' && d.series[1].kind === 'reference' && d.series[1].index === 0);
  const p = d.series[0].points;
  check('points', p.tUsRel[2] === 4294967295 && p.min[0] === -1.5 && p.max[0] === 2.5 && p.min[1] === 0);
  check('nan passthrough', Number.isNaN(p.min[2]) && Number.isNaN(p.max[2]));
  check('empty series', d.series[1].points.tUsRel.length === 0);
  check('empty message', decodeReSeries(encodeReSeriesForTest({ seriesCount: 0, pointsMax: 16, fromUs: 0, series: [] })).series.length === 0);

  const bad = new Uint8Array(buf.slice(0));
  bad[0] = 0x58;
  check('bad magic', codeOf(() => decodeReSeries(bad.buffer)) === 'badMagic');
  check('short header', codeOf(() => decodeReSeries(buf.slice(0, 10))) === 'truncated');
  check('truncated points', codeOf(() => decodeReSeries(buf.slice(0, 16 + 8 + 30))) === 'truncated');
  check('truncated entry header', codeOf(() => decodeReSeries(buf.slice(0, 16 + 8 + 60 + 4))) === 'truncated');
  const trailing = new Uint8Array(buf.byteLength + 1);
  trailing.set(new Uint8Array(buf));
  check('trailing', codeOf(() => decodeReSeries(trailing.buffer)) === 'trailing');
  const kind = new Uint8Array(buf.slice(0));
  kind[16] = 7;
  check('bad kind', codeOf(() => decodeReSeries(kind.buffer)) === 'badField');
  const huge = new Uint8Array(buf.slice(0));
  new DataView(huge.buffer).setUint32(16 + 4, 0xffffffff, true);
  check('huge count rejected without allocation', codeOf(() => decodeReSeries(huge.buffer)) === 'truncated');
}

function highlightTests(): void {
  // vectors from netdb bit_plan::trace_signal_bits semantics (bit = byte*8 + k, signal MSB-first for Motorola)
  check('intel 4+12', eq(selectionBits({ startBit: 4, bitLength: 12, byteOrder: 'intel' }, 64), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]));
  check('intel byte boundary 6+4', eq(selectionBits({ startBit: 6, bitLength: 4, byteOrder: 'intel' }, 64), [6, 7, 8, 9]));
  check('motorola 7+8', eq(selectionBits({ startBit: 7, bitLength: 8, byteOrder: 'motorola' }, 64), range(7, 0)));
  check('motorola 23+16 = 23..16 then 31..24', eq(selectionBits({ startBit: 23, bitLength: 16, byteOrder: 'motorola' }, 64), [...range(23, 16), ...range(31, 24)]));
  check('motorola 3+12 = 3..0 then 15..8', eq(selectionBits({ startBit: 3, bitLength: 12, byteOrder: 'motorola' }, 64), [3, 2, 1, 0, ...range(15, 8)]));
  check('motorola 0+3 jumps to next byte MSB', eq(selectionBits({ startBit: 0, bitLength: 3, byteOrder: 'motorola' }, 64), [0, 15, 14]));
  check('intel 0+64', selectionBits({ startBit: 0, bitLength: 64, byteOrder: 'intel' }, 64).length === 64);
  check('fits ok', selectionFits({ startBit: 56, bitLength: 8, byteOrder: 'intel' }, 64));
  check('fits intel overflow', !selectionFits({ startBit: 60, bitLength: 8, byteOrder: 'intel' }, 64));
  check('fits motorola overflow', !selectionFits({ startBit: 63, bitLength: 16, byteOrder: 'motorola' }, 64));
  check('fits len 0 / 65', !selectionFits({ startBit: 0, bitLength: 0, byteOrder: 'intel' }, 64) && !selectionFits({ startBit: 0, bitLength: 65, byteOrder: 'intel' }, 512));

  const di = dragSelection(10, 4, 'intel');
  check('drag intel either direction', di?.startBit === 4 && di.bitLength === 7);
  const dm = dragSelection(23, 24, 'motorola');
  check('drag motorola 23->24 spans 16 bits', dm?.startBit === 23 && dm.bitLength === 16, JSON.stringify(dm));
  const dr = dragSelection(24, 23, 'motorola');
  check('drag motorola reversed swaps roles', dr?.startBit === 23 && dr.bitLength === 16, JSON.stringify(dr));
  const dm1 = dragSelection(5, 5, 'motorola');
  check('drag single bit', dm1?.startBit === 5 && dm1.bitLength === 1);
  check('drag intel > 64 rejected', dragSelection(0, 100, 'intel') === null);
  const dm2 = dragSelection(7, 0, 'motorola');
  check('drag motorola 7->0 = 8 bits', dm2?.startBit === 7 && dm2.bitLength === 8);
  // drag result highlights exactly the span between the two cells
  const sel = dragSelection(19, 28, 'motorola');
  check('drag motorola cross-byte contains both endpoints', sel !== null && selectionBits({ ...sel, byteOrder: 'motorola' }, 64).includes(19) && selectionBits({ ...sel, byteOrder: 'motorola' }, 64).includes(28), JSON.stringify(sel));

  const f = candidateFromField({ startBit: 16, bitLength: 99, byteOrder: 'intel' });
  check('seed from field', f.bitLength === 64 && f.valueType === 'unsigned' && f.factor === 1 && f.offset === 0);
  const constant = Uint8Array.from([0xff, 0xff, 0x00, 0x00, 0x7f, 0xff, 0xff, 0xff]);
  const sr = defaultSearchFromConstant(constant, 8);
  check('default search = non-constant span', sr.bitFrom === 16 && sr.bitTo === 39, JSON.stringify(sr));
  const all = defaultSearchFromConstant(new Uint8Array(8).fill(0xff), 8);
  check('all constant falls back to whole payload', all.bitFrom === 0 && all.bitTo === 63);
  const n = normalizeSearch({ bitFrom: 9, bitTo: 3, lengths: [40, 2], byteOrders: [], signed: [] });
  check('normalize search', n.bitFrom === 3 && n.bitTo === 9 && n.lengths[0] === 32 && n.lengths[1] === 32 && n.byteOrders.length === 1 && n.signed.length === 1, JSON.stringify(n));
  check('err hints = frozen codes', RE_ERR_HINT_KEYS.no_reference === 're.err.no_reference' && RE_ERR_HINT_KEYS.focus_full === 're.err.focus_full' && RE_ERR_HINT_KEYS.not_started === 're.err.not_started' && RE_ERR_HINT_KEYS.invalid === undefined && RE_ERR_HINT_KEYS.not_enabled === undefined && Object.keys(RE_ERR_HINT_KEYS).length === 3);
  check('err invalid keeps backend message', parseReError('[re:invalid] bitLength 0').code === 'invalid' && parseReError('[re:invalid] bitLength 0').message.includes('bitLength 0'));
  check('err code parse', parseReError('x [re:no_reference] y').code === 'no_reference' && parseReError(new Error('boom')).code === null);
}

function geometryTests(): void {
  const s = mkSeries();
  check('range follow = last point', plotRange(s, true, 10_000_000, null)?.[1] === s.fromUs + 4294967295);
  check('range follow span', (() => { const r = plotRange(s, true, 10_000_000, null); return r !== null && r[1] - r[0] === 10_000_000; })());
  check('range paused uses view', plotRange(s, false, 5, { t0Us: 100, t1Us: 200 })?.[0] === 100);
  check('range empty', plotRange(null, true, 5, null) === null);
  const t = Float64Array.from([0, 10, 20, 30]);
  check('nearest', nearestIndex(t, 12) === 1 && nearestIndex(t, 26) === 3 && nearestIndex(t, -5) === 0 && nearestIndex(t, 99) === 3 && nearestIndex(new Float64Array(0), 1) === -1);
  const ticks = niceTicks(0, 10, 5);
  check('ticks', ticks.length >= 3 && ticks[0] === 0 && ticks[ticks.length - 1] <= 10, ticks.join(','));
}

function plotStabilityTests(): void {
  const base = { zeroBased: true, manualMin: null, manualMax: null } as const;
  // (b) axis identical across 20 polls with +-5 % noise
  let rng = 12345;
  const rand = (): number => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng / 4294967296; };
  let ax: AxisState | null = null;
  const seen = new Set<string>();
  for (let i = 0; i < 20; i += 1) {
    const hi = 100 * (1 + (rand() - 0.5) * 0.1);
    const lo = 80 * (1 + (rand() - 0.5) * 0.1);
    ax = stableAxis(ax, lo, hi, i * 200, base);
    if (i >= 1) seen.add(`${ax.lo}:${ax.hi}`);
  }
  check('axis stable over 20 noisy polls', seen.size === 1, [...seen].join('|'));
  check('zero included by default', ax !== null && ax.lo <= 0 && ax.hi >= 100, JSON.stringify(ax));
  const noZero = stableAxis(null, 80, 100, 0, { ...base, zeroBased: false });
  check('zero-based off: axis hugs data', noZero.lo > 0 && noZero.lo <= 80 && noZero.hi >= 100, JSON.stringify(noZero));
  check('bounds snapped to nice steps', (() => { const a = stableAxis(null, 3.3, 97.1, 0, base); return a.lo === 0 && a.hi % 10 === 0 && a.hi >= 97.1; })());
  // expand immediately on a spike, shrink only after 2 s of < 50 % use
  const a0 = stableAxis(null, 0, 100, 0, base);
  const a1 = stableAxis(a0, 0, 500, 100, base);
  check('expands immediately on spike', a1.hi >= 500 && a1.lo <= 0, JSON.stringify(a1));
  const a2 = stableAxis(a1, 0, 100, 200, base);
  check('no shrink right after spike', a2.hi === a1.hi);
  const a3 = stableAxis(a2, 0, 100, 200 + AXIS_SHRINK_MS - 1, base);
  check('no shrink before 2 s', a3.hi === a1.hi);
  const a4 = stableAxis(a3, 0, 100, 200 + AXIS_SHRINK_MS, base);
  check('shrinks after 2 s of low use', a4.hi < a1.hi && a4.hi >= 100, JSON.stringify(a4));
  const b1 = stableAxis(a1, 0, 100, 300, base);
  const b2 = stableAxis(b1, 0, 450, 1500, base);
  const b3 = stableAxis(b2, 0, 100, 2600, base);
  check('usage recovery resets the shrink timer', b3.hi === a1.hi && b3.lowSince !== null && b2.lowSince === null);
  const man = stableAxis(null, 0, 100, 0, { zeroBased: true, manualMin: -20, manualMax: 300 });
  check('manual min/max override', man.lo === -20 && man.hi === 300);
  const half = stableAxis(null, 0, 100, 0, { zeroBased: true, manualMin: null, manualMax: 400 });
  check('manual max only keeps auto min', half.lo === 0 && half.hi === 400);

  // (a) time axis starts at 0 and ascends; fill-then-scroll
  const mk = (fromUs: number, rel: number[]): ReSeries => ({
    seriesCount: 1, pointsMax: 16, fromUs,
    series: [{ kind: 'candidate', index: 0, points: { tUsRel: Float64Array.from(rel), min: Float64Array.from(rel.map(() => 1)), max: Float64Array.from(rel.map(() => 1)) } }],
  });
  const origin = 1_000_000_000;
  const young = mk(origin, [0, 1_000_000, 2_000_000]);
  const r0 = plotRange(young, true, 10_000_000, null, origin);
  check('young capture: window = [origin, origin+span]', r0 !== null && r0[0] === origin && r0[1] === origin + 10_000_000);
  const ticks = r0 === null ? [] : timeTicks(r0[0], r0[1], origin, 5);
  check('time labels start at 0', ticks.length > 2 && ticks[0].label === '0 s' && ticks[0].frac === 0, JSON.stringify(ticks[0]));
  const secs = ticks.map((x) => Number.parseFloat(x.label));
  check('time labels ascend', secs.every((v, i) => i === 0 || v > secs[i - 1]) && ticks.every((x, i) => i === 0 || x.frac > ticks[i - 1].frac));
  const full = mk(origin + 20_000_000, [0, 5_000_000, 10_000_000]);
  const r1 = plotRange(full, true, 10_000_000, null, origin);
  check('full capture scrolls [end-span, end]', r1 !== null && r1[1] === origin + 30_000_000 && r1[0] === origin + 20_000_000);
  const t1 = r1 === null ? [] : timeTicks(r1[0], r1[1], origin, 5);
  check('scrolling labels stay absolute since origin', t1.length > 1 && Number.parseFloat(t1[0].label) >= 20 && t1.every((x) => x.frac >= 0 && x.frac <= 1));
  const noOrigin = plotRange(mk(500, [0, 1000]), true, 5_000_000, null, null);
  check('origin falls back to first sample', noOrigin !== null && noOrigin[0] === 500);
  check('time format', formatAxisTime(0) === '0 s' && formatAxisTime(2.5) === '2.5 s' && formatAxisTime(125) === '2:05' && formatAxisTime(100) === '1:40');

  // (c) bucket-aligned request windows
  const span = 30_000_000;
  const bucket = Math.round(span / 1024); // integer µs bucket (u64 IPC)
  let edgesOk = true;
  let lenOk = true;
  const firsts = new Set<number>();
  for (let i = 0; i < 50; i += 1) {
    const now = 400_000_000 + i * 200_000 + (i % 7) * 13;
    const w = alignedWindow(now, span, 1024, 1_000_000);
    const k = w.toUs / bucket; // integer bucket: the `to` edge sits on the grid, `from` = to - span (constant offset)
    if (Math.abs(k - Math.round(k)) > 1e-6) edgesOk = false;
    if (Math.abs(w.toUs - w.fromUs - span) > 1e-6 || w.toUs < now) lenOk = false;
    firsts.add(w.fromUs);
  }
  check('aligned toUs lies on the integer bucket grid for 50 polls', edgesOk);
  check('aligned window length == span and covers now', lenOk);
  check('aligned from changes only in whole buckets', [...firsts].every((v) => Math.abs(((v - [...firsts][0]) / bucket) - Math.round((v - [...firsts][0]) / bucket)) < 1e-6));
  const young2 = alignedWindow(5_000_000, span, 1024, 1_000_000);
  check('young capture request window = [origin, origin+span]', young2.fromUs === 1_000_000 && young2.toUs === 31_000_000);
  const p1 = alignedWindow(400_000_000, span, 1024, 0);
  const p2 = alignedWindow(400_000_000 + bucket * 0.4, span, 1024, 0);
  check('polls within one bucket request an identical window', p1.fromUs === p2.fromUs && p1.toUs === p2.toUs);
  const v = alignedView(12_345_678, 22_345_678, 1024);
  check('paused view aligned, length kept', Math.abs(v.toUs - v.fromUs - 10_000_000) < 1e-6 && Math.abs(v.fromUs / Math.round(10_000_000 / 1024) - Math.round(v.fromUs / Math.round(10_000_000 / 1024))) < 1e-6);
}

interface NodeFs { readdirSync(p: string): string[]; readFileSync(p: string, enc: 'utf8'): string }

function themeHelperTests(): void {
  const th = getReTheme(); // node: no document -> dark fallbacks
  check('theme fallbacks present', th.bgCanvas !== '' && th.nominal !== '' && th.grid.startsWith('rgba'));
  check('parse hex/rgba', JSON.stringify(parseColor('#fff')) === '[255,255,255,1]' && parseColor('rgba(1, 2, 3, 0.5)')?.[3] === 0.5 && parseColor('nonsense') === null);
  check('mix endpoints', mix('#000000', '#ffffff', 0) === 'rgba(0,0,0,1)' && mix('#000000', '#ffffff', 1) === 'rgba(255,255,255,1)' && mix('#000000', '#ffffff', 0.5) === 'rgba(128,128,128,1)');
  check('withAlpha', withAlpha('#ff0000', 0.5) === 'rgba(255,0,0,0.5)');
  const lut = heatLut(th);
  check('heat lut 256, cached, ends at nominal', lut.length === 256 && heatLut(th) === lut && lut[255] === mix(th.bgSurface, th.nominal, 1));
}

function themeGuardTests(): void {
  const proc = (globalThis as { process?: { getBuiltinModule?: (n: string) => unknown; cwd?: () => string } }).process;
  const fs = proc?.getBuiltinModule?.('node:fs') as NodeFs | undefined;
  if (fs === undefined || proc?.cwd === undefined) {
    check('theme guard: node:fs available', false);
    return;
  }
  const dir = `${proc.cwd()}/src/components/re`;
  const hex = /#[0-9a-fA-F]{3,8}\b/g;
  let scanned = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(ts|tsx)$/.test(f) || f === 'reTheme.ts' || /\.(test|qa\.test)\.ts$/.test(f)) continue;
    scanned += 1;
    const src = fs.readFileSync(`${dir}/${f}`, 'utf8');
    const hits = src.split('\n').flatMap((line, i) => (line.match(hex) ?? []).map((h) => `${f}:${i + 1} ${h}`));
    check(`no raw hex colours in ${f}`, hits.length === 0, hits.slice(0, 3).join('; '));
    const tw = src.match(/\b(?:text|bg|border)-(?:slate|gray|zinc|cyan|sky|emerald|amber|red|blue)-\d{2,3}\b/g);
    check(`no tailwind palette classes in ${f}`, tw === null, tw?.slice(0, 3).join(','));
  }
  check('theme guard scanned the RE sources', scanned >= 9, String(scanned));
}

// ---- store ---------------------------------------------------------------------------------------------------------

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface FakeApi extends ReSignalApi {
  seriesCalls: ReSeriesRequest[];
  correlateCalls: ReCorrelateRequest[];
  focusCalls: ReTargetDto[][];
  timers: Map<number, () => void>;
  pendingSeries: Deferred<ReSeries>[];
  mode: 'immediate' | 'deferred';
  correlateResult: Deferred<ReCorrelationResultDto> | null;
  now: number;
  origin: number | null;
}

function seriesWith(tag: number): ReSeries {
  return { seriesCount: 1, pointsMax: 16, fromUs: tag, series: [{ kind: 'candidate', index: 0, points: { tUsRel: Float64Array.from([0]), min: Float64Array.from([tag]), max: Float64Array.from([tag]) } }] };
}

function mkApi(): FakeApi {
  let timerId = 1;
  const api: FakeApi = {
    demo: false,
    seriesCalls: [], correlateCalls: [], focusCalls: [], timers: new Map(), pendingSeries: [],
    mode: 'immediate', correlateResult: null, now: 50_000_000, origin: null,
    focusSet: async (targets) => { api.focusCalls.push(targets); return { targets: [] }; },
    series: (req) => {
      api.seriesCalls.push(req);
      if (api.mode === 'immediate') return Promise.resolve(seriesWith(api.seriesCalls.length));
      const d = deferred<ReSeries>();
      api.pendingSeries.push(d);
      return d.promise;
    },
    correlate: (req) => {
      api.correlateCalls.push(req);
      if (api.correlateResult !== null) return api.correlateResult.promise;
      return Promise.resolve({ rows: [], evaluated: 0, referenceSamples: 0, elapsedMs: 0, truncated: false });
    },
    nowUs: () => api.now,
    originUs: () => api.origin,
    setInterval: (fn) => { const id = timerId; timerId += 1; api.timers.set(id, fn); return id; },
    clearInterval: (id) => { api.timers.delete(id); },
  };
  return api;
}

const T1: ReTargetDto = { bus: 0, arbId: 0x100, isExtended: false };
const T2: ReTargetDto = { bus: 0, arbId: 0x200, isExtended: false };
const CAND: ReCandidateDto = { startBit: 16, bitLength: 16, byteOrder: 'intel', valueType: 'unsigned', factor: 1, offset: 0 };

async function storeTests(): Promise<void> {
  // polling guard
  {
    const api = mkApi();
    const st = createReSignalStore(api);
    await st.setTarget(T1);
    check('focus set on target', api.focusCalls.length === 1 && api.focusCalls[0][0].arbId === 0x100);
    check('no poll without candidates', api.timers.size === 0);
    st.addCandidate(CAND);
    check('no poll while hidden', api.timers.size === 0 && api.seriesCalls.length === 0);
    st.setVisible(true);
    check('poll starts when visible+follow+work', api.timers.size === 1);
    await tick();
    check('visible triggers one immediate fetch', api.seriesCalls.length === 1);
    const w0 = alignedWindow(50_000_000, 30_000_000, 1024, null);
    check('follow window derived from nowUs, bucket aligned, length = span', api.seriesCalls[0].fromUs === w0.fromUs && api.seriesCalls[0].toUs === w0.toUs && (w0.toUs - w0.fromUs) === 30_000_000 && (w0.toUs as number) >= 50_000_000 && api.seriesCalls[0].maxPoints === 1024);
    const fn = [...api.timers.values()][0];
    fn();
    await tick();
    check('tick fetches', api.seriesCalls.length === 2);
    check('poll period is 5 Hz', RE_SERIES_POLL_MS === 200);
    st.setFollow(false);
    check('paused clears timer', api.timers.size === 0);
    const before = api.seriesCalls.length;
    await tick();
    const v = st.getState().view;
    check('paused freezes a view window', v !== null && v.t1Us > v.t0Us);
    check('paused does not poll', api.seriesCalls.length <= before + 1);
    st.setFollow(true);
    check('follow resumes timer', api.timers.size === 1);
    st.setVisible(false);
    check('hidden stops timer', api.timers.size === 0);
    st.setVisible(true);
    st.removeCandidate(st.getState().candidates[0].id);
    check('no work -> no timer, series cleared', api.timers.size === 0 && st.getState().series === null);
    st.setReference({ kind: 'obd_pid', pid: 0x0c, bus: 0 }, 'rpm');
    check('reference alone is work', api.timers.size === 1);
    st.setVisible(false);
  }
  // in-flight skip + stale guard
  {
    const api = mkApi();
    api.mode = 'deferred';
    const st = createReSignalStore(api);
    await st.setTarget(T1);
    st.addCandidate(CAND);
    st.setVisible(true);
    await tick();
    check('first request pending', api.seriesCalls.length === 1);
    const fn = [...api.timers.values()][0];
    fn();
    fn();
    check('ticks skipped while in flight', api.seriesCalls.length === 1);
    api.pendingSeries[0].resolve(seriesWith(1));
    await tick();
    check('applied', st.getState().series?.fromUs === 1);
    // two direct refreshes: older answer arriving late must be dropped
    const a = st.refresh();
    const b = st.refresh();
    const n = api.pendingSeries.length;
    api.pendingSeries[n - 1].resolve(seriesWith(222));
    await b;
    api.pendingSeries[n - 2].resolve(seriesWith(111));
    await a;
    check('stale response dropped', st.getState().series?.fromUs === 222, String(st.getState().series?.fromUs));
    // target change invalidates in-flight
    const c = st.refresh();
    const idx = api.pendingSeries.length - 1;
    await st.setTarget(T2);
    api.pendingSeries[idx].resolve(seriesWith(333));
    await c;
    check('target change drops in-flight + clears candidates', st.getState().series === null && st.getState().candidates.length === 0 && api.focusCalls.length === 2);
    st.setVisible(false);
  }
  // coalescing of bursts (pan/zoom/typing)
  {
    const api = mkApi();
    api.mode = 'deferred';
    const st = createReSignalStore(api);
    await st.setTarget(T1);
    st.setVisible(true);
    st.addCandidate(CAND);
    await tick();
    for (let i = 0; i < 10; i += 1) st.setView(1_000_000 + i * 1000, 5_000_000 + i * 1000);
    check('burst: one in flight', api.seriesCalls.length === 1);
    api.pendingSeries[0].resolve(seriesWith(1));
    await tick();
    check('burst: exactly one trailing refresh with latest view', api.seriesCalls.length === 2 && api.seriesCalls[1].fromUs === alignedView(1_009_000, 5_009_000, 1024).fromUs, String(api.seriesCalls[1]?.fromUs));
    api.pendingSeries[1].resolve(seriesWith(2));
    await tick();
    check('burst: nothing further', api.seriesCalls.length === 2);
    st.setVisible(false);
  }
  // candidates: max 4, colours, preview
  {
    const api = mkApi();
    const st = createReSignalStore(api);
    await st.setTarget(T1);
    const ids = [0, 1, 2, 3].map((i) => st.addCandidate({ ...CAND, startBit: i * 8, bitLength: 8 }));
    check('4 candidates', ids.every((x) => x !== null) && st.getState().candidates.length === 4);
    check('distinct colours', new Set(st.getState().candidates.map((c) => c.slot)).size === 4);
    check('5th rejected + notice', st.addCandidate(CAND) === null && st.getState().notice === 'max' && st.getState().candidates.length === 4);
    st.removeCandidate(ids[1] as number);
    const re = st.addCandidate({ ...CAND, startBit: 40, bitLength: 4 });
    check('freed slot reused', st.getState().candidates.find((c) => c.id === re)?.slot === 1);
    st.updateCandidate(re as number, { factor: 0.25, offset: -40, valueType: 'signed' });
    const e = st.getState().candidates.find((c) => c.id === re);
    check('update keeps colour, applies fields', e?.slot === 1 && e.dto.factor === 0.25 && e.dto.offset === -40 && e.dto.valueType === 'signed');
  }
  // correlation -> candidate / preview semantics
  {
    const api = mkApi();
    const st = createReSignalStore(api);
    await st.setTarget(T1);
    await st.runCorrelation(defaultSearchFromConstant(new Uint8Array(8), 8), 20);
    check('no reference -> no_reference error, no call', st.getState().correlation.status === 'error' && st.getState().correlation.errorCode === 'no_reference' && api.correlateCalls.length === 0);
    st.setReference({ kind: 'obd_pid', pid: 0x0c, bus: 0 }, 'rpm');
    const row = { candidate: { ...CAND, factor: 0.25, offset: -40 }, r: 0.9995, r2: 0.999, rmse: 0.1, samples: 100, lagMs: 120 };
    api.correlateResult = deferred<ReCorrelationResultDto>();
    const p = st.runCorrelation({ bitFrom: 0, bitTo: 63, lengths: [4, 16], byteOrders: ['intel'], signed: [false] }, 99);
    check('running state', st.getState().correlation.status === 'running');
    api.correlateResult.resolve({ rows: [row], evaluated: 5, referenceSamples: 100, elapsedMs: 3, truncated: true });
    await p;
    const c = st.getState().correlation;
    check('result stored', c.status === 'done' && c.result?.rows.length === 1 && c.result.truncated);
    check('topN clamped, window null in follow', api.correlateCalls[0].topN === 50 && api.correlateCalls[0].fromUs === null && api.correlateCalls[0].reference.kind === 'obd_pid');
    st.plotRow(row);
    check('plot adds preview candidate', st.getState().candidates.length === 1 && st.getState().candidates[0].preview);
    st.plotRow({ ...row, candidate: { ...CAND, startBit: 0 } });
    check('plot replaces previous preview', st.getState().candidates.length === 1 && st.getState().candidates[0].dto.startBit === 0);
    st.plotRow(row);
    const id = st.useRowAsCandidate(row);
    const cand = st.getState().candidates.find((x) => x.id === id);
    check('use promotes preview with fitted factor/offset', st.getState().candidates.length === 1 && cand?.preview === false && cand.dto.factor === 0.25 && cand.dto.offset === -40 && cand.dto.startBit === 16);
    // stale correlation dropped
    const d1 = deferred<ReCorrelationResultDto>();
    const d2 = deferred<ReCorrelationResultDto>();
    const ds = [d1, d2];
    let k = 0;
    api.correlate = (req) => { api.correlateCalls.push(req); const d = ds[k]; k += 1; return d.promise; };
    const s = { bitFrom: 0, bitTo: 7, lengths: [1, 8] as [number, number], byteOrders: ['intel' as const], signed: [false] };
    const p1 = st.runCorrelation(s, 5);
    const p2 = st.runCorrelation(s, 5);
    d2.resolve({ rows: [], evaluated: 2, referenceSamples: 1, elapsedMs: 1, truncated: false });
    await p2;
    d1.resolve({ rows: [], evaluated: 1, referenceSamples: 1, elapsedMs: 1, truncated: false });
    await p1;
    check('stale correlation dropped', st.getState().correlation.result?.evaluated === 2);
    // backend error code surfaced
    api.correlate = () => Promise.reject('correlation failed [re:no_reference] no Mode-01 responses');
    await st.runCorrelation(s, 5);
    check('backend error code', st.getState().correlation.status === 'error' && st.getState().correlation.errorCode === 'no_reference');
  }
  // series error surfaced with code
  {
    const api = mkApi();
    const st = createReSignalStore(api);
    await st.setTarget(T1);
    st.addCandidate(CAND);
    api.series = () => Promise.reject(new Error('boom [re:focus_full]'));
    st.setVisible(true);
    await tick();
    check('series error code', st.getState().seriesErrorCode === 'focus_full');
    st.setVisible(false);
  }
}

function demoTests(): void {
  const now = 1_700_000_000_000_000;
  const env: DemoSignalEnv = { nowUs: now, originUs: now - 20_000_000, markers: [] };
  const req: ReCorrelateRequest = {
    target: { bus: 0, arbId: 0x100, isExtended: false },
    reference: { kind: 'obd_pid', pid: 0x0c, bus: 0 },
    fromUs: null, toUs: null,
    search: { bitFrom: 0, bitTo: 63, lengths: [4, 24], byteOrders: ['intel', 'motorola'], signed: [false, true] },
    topN: 10,
  };
  const res = demoCorrelate(req, env);
  const top = res.rows[0];
  check('demo finds the ramp', top !== undefined && top.candidate.startBit === 16 && top.candidate.bitLength === 16 && top.candidate.byteOrder === 'intel' && top.r > 0.999, JSON.stringify(top?.candidate));
  check('demo factor/offset recovered', top !== undefined && Math.abs(top.candidate.factor - 0.5) < 1e-6 && Math.abs(top.candidate.offset - 10) < 1e-3, `${top?.candidate.factor} ${top?.candidate.offset}`);
  check('demo supersets deduped', res.rows.filter((r) => r.candidate.startBit === 16 && r.candidate.byteOrder === 'intel' && Math.abs(r.r) > 0.999).length === 1);
  check('demo stats', res.evaluated > 0 && res.referenceSamples > 50 && !res.truncated);

  const sreq: ReSeriesRequest = { target: req.target, candidates: [CAND], reference: req.reference, fromUs: null, toUs: null, maxPoints: 64 };
  const ser = demoSeries(sreq, env);
  check('demo series shape', ser.seriesCount === 2 && ser.series[0].kind === 'candidate' && ser.series[1].kind === 'reference');
  const pts = ser.series[0].points;
  check('demo decimated <= maxPoints, min<=max', pts.tUsRel.length <= 64 && pts.tUsRel.length > 10 && pts.min.every((v, i) => v <= pts.max[i]));
  const exact = demoSeries({ ...sreq, maxPoints: 4096 }, env).series[0].points;
  check('demo exact when samples <= maxPoints', exact.min.every((v, i) => v === exact.max[i]));
  const mk = demoSeries({ ...sreq, candidates: [], reference: { kind: 'markers', points: [{ markerId: 1, value: 10 }, { markerId: 2, value: 20 }] } }, { ...env, markers: [{ id: 1, tsUs: now - 10_000_000, label: 'a', phase: 'free' }, { id: 2, tsUs: now - 5_000_000, label: 'b', phase: 'free' }] });
  const mp = mk.series[0].points;
  check('demo markers reference is a step function', mp.min[0] === 10 && mp.min[mp.min.length - 1] === 20 && mp.min.every((v) => v === 10 || v === 20));
  const motorola: ReCandidateDto = { startBit: 23, bitLength: 16, byteOrder: 'motorola', valueType: 'unsigned', factor: 1, offset: 0 };
  const m = demoSeries({ ...sreq, candidates: [motorola], reference: null, maxPoints: 4096 }, env);
  check('demo motorola series defined', m.series[0].points.min.every((v) => !Number.isNaN(v)));
}

/** Deterministic LCG so failures are reproducible. */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 0x1_0000_0000;
  };
}

function integerWindowTests(): void {
  const rnd = lcg(12345);
  let allInt = true;
  let ordered = true;
  let firstBad = '';
  for (let i = 0; i < 5000; i += 1) {
    const nowUs = rnd() < 0.3 ? 1_500_832_321.875 : Math.floor(rnd() * 4e12) + rnd(); // fractional on purpose
    const span = 200_000 + rnd() * 599_800_000; // fractional span
    const maxPoints = [16, 100, 777, 1024, 4096][Math.floor(rnd() * 5)];
    const origin = rnd() < 0.5 ? null : Math.floor(rnd() * 1e9) + rnd();
    const w = alignedWindow(nowUs, span, maxPoints, origin);
    const t0 = rnd() * 1e11;
    const v = alignedView(t0, t0 + span, maxPoints);
    for (const b of [w.fromUs, w.toUs, v.fromUs, v.toUs]) {
      if (!Number.isInteger(b) || b < 0) { allInt = false; firstBad ||= `now=${nowUs} span=${span} mp=${maxPoints} w=${JSON.stringify(w)} v=${JSON.stringify(v)}`; }
    }
    if (w.toUs <= w.fromUs || v.toUs <= v.fromUs) ordered = false;
  }
  check('alignedWindow/alignedView bounds are non-negative integers (5000 random combos)', allInt, firstBad);
  check('integer windows keep from < to', ordered);
  const bad = alignedWindow(1_500_832_321.875, 30_000_000, 1024, null);
  check('regression: now=1500832321.875 gives integer from/to', Number.isInteger(bad.fromUs) && Number.isInteger(bad.toUs), JSON.stringify(bad));
  // identical bucket grid between polls: successive polls differ only by whole (integer) buckets
  const b = Math.round(30_000_000 / 1024);
  const f0 = alignedWindow(400_000_000, 30_000_000, 1024, 0).fromUs;
  let grid = true;
  for (let i = 1; i < 200; i += 1) {
    const f = alignedWindow(400_000_000 + i * 7_919, 30_000_000, 1024, 0).fromUs;
    if ((f - f0) % b !== 0) grid = false;
  }
  check('integer bucket grid identical between polls', grid);
}

async function integerStoreTests(): Promise<void> {
  const rnd = lcg(777);
  // follow-live path with fractional bus time and fractional span input
  {
    const api = mkApi();
    const st = createReSignalStore(api);
    await st.setTarget(T1);
    st.addCandidate(CAND);
    st.setVisible(true);
    await tick();
    let ok = true;
    for (let i = 0; i < 100; i += 1) {
      api.now = 1_500_832_321.875 + rnd() * 1e9;
      st.setSpan(200_000 + rnd() * 5e8);
      await tick();
    }
    for (const r of api.seriesCalls) {
      if (r.fromUs === null || r.toUs === null || !Number.isInteger(r.fromUs) || !Number.isInteger(r.toUs)) ok = false;
    }
    check('follow-live series windows are integers', ok && api.seriesCalls.length > 50, String(api.seriesCalls.length));
    st.setVisible(false);
  }
  // paused-view path with fractional view bounds + correlation window
  {
    const api = mkApi();
    const st = createReSignalStore(api);
    await st.setTarget(T1);
    st.addCandidate(CAND);
    st.setReference({ kind: 'obd_pid', pid: 0x0c, bus: 0 }, 'rpm');
    st.setVisible(true);
    await tick();
    let ok = true;
    for (let i = 0; i < 100; i += 1) {
      const t0 = 1_000_000.37 + rnd() * 1e9;
      st.setView(t0, t0 + 300_000.61 + rnd() * 1e7);
      await tick();
    }
    await st.runCorrelation({ bitFrom: 0, bitTo: 15, lengths: [4, 16], byteOrders: ['intel'], signed: [false] }, 10);
    const calls = [...api.seriesCalls, ...api.correlateCalls];
    for (const r of calls) {
      if (r.fromUs === null || r.toUs === null || !Number.isInteger(r.fromUs) || !Number.isInteger(r.toUs)) ok = false;
    }
    check('paused-view series + correlate windows are integers', ok && api.correlateCalls.length === 1 && api.seriesCalls.length > 50);
    st.setVisible(false);
  }
}

async function main(): Promise<void> {
  integerWindowTests();
  await integerStoreTests();
  codecTests();
  highlightTests();
  geometryTests();
  plotStabilityTests();
  themeHelperTests();
  themeGuardTests();
  await storeTests();
  demoTests();
  console.log(`re.r2a: ${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    const proc = (globalThis as { process?: { exitCode?: number } }).process;
    if (proc) proc.exitCode = 1;
  }
}
void main();
