/** RE Toolkit R1 frontend tests: codec, store merge, filters, demo engine, bit geometry. Run: `npm run test:re`. */
import { decodeReSnapshot, encodeReSnapshotForTest, ReCodecError, RE_HEADER_BYTES } from '../../services/reSnapshotCodec';
import { decodeDemoTick, ReDemoEngine } from '../../services/reDemo';
import {
  createReStore, DEFAULT_RE_FILTERS, filterRows, RE_NOISE_HEAT, type ReClientApi, type ReRowView, type ReSourceController,
} from '../../store/reStore';
import { createReSourceState, RE_SOURCE_STORAGE_KEY, type ReSource } from '../../services/reClient';
import { createReSignalStore, type ReSignalApi } from '../../store/reSignalStore';
import { fieldBits, formatByteTriple, formatElapsed, hexToBytes, HEX2 } from './reModel';
import type { ReSnapshot, ReSnapshotRow, ReStatusDto } from '../../types/re';

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}
function throwsCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof ReCodecError ? e.code : `other:${String(e)}`;
  }
}

function mkRow(p: Partial<ReSnapshotRow> & { arbId: number }): ReSnapshotRow {
  const dlc = p.dlcBytes ?? 8;
  return {
    bus: 0, extended: false, fd: false, hasDiff: false, isNew: false, rxCount: 1, dlcBytes: dlc,
    heat: new Uint8Array(dlc * 8), diff: new Uint8Array(dlc), constant: new Uint8Array(dlc).fill(0xff), data: new Uint8Array(dlc), ...p,
  };
}
function mkSnap(rows: ReSnapshotRow[], over: Partial<ReSnapshot> = {}): ReSnapshot {
  return { seq: 1, tsUs: 1_000_000, phase: 'free', full: false, rowCount: rows.length, totalRows: rows.length, rows, ...over };
}

function codecTests(): void {
  const heat = Uint8Array.from({ length: 64 }, (_, i) => i * 4);
  const r1 = mkRow({ arbId: 0x123, bus: 2, rxCount: 77, heat, diff: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), hasDiff: true, isNew: true });
  const fdHeat = Uint8Array.from({ length: 512 }, (_, i) => i & 0xff);
  const r2 = mkRow({
    arbId: 0x1ffffff0, extended: true, fd: true, dlcBytes: 64, rxCount: 0xfffffff0, heat: fdHeat,
    diff: new Uint8Array(64).fill(0xaa), constant: new Uint8Array(64).fill(0x0f),
  });
  const tsUs = 0x1_2345_6789_ab; // > 2^32, < 2^53
  const buf = encodeReSnapshotForTest(mkSnap([r1, r2], { seq: 0xdeadbeef, tsUs, phase: 'action', full: true, totalRows: 300 }));
  check('hdr size', buf.byteLength === RE_HEADER_BYTES + 12 + 88 + 12 + 704);
  const d = decodeReSnapshot(buf);
  check('hdr seq', d.seq === 0xdeadbeef);
  check('hdr ts', d.tsUs === tsUs, String(d.tsUs));
  check('hdr phase/full', d.phase === 'action' && d.full);
  check('hdr counts', d.rowCount === 2 && d.totalRows === 300 && d.rows.length === 2);
  const a = d.rows[0];
  check('row0 fields', a.bus === 2 && a.arbId === 0x123 && a.rxCount === 77 && !a.extended && !a.fd && a.hasDiff && a.isNew && a.dlcBytes === 8);
  check('row0 heat', a.heat.length === 64 && a.heat[63] === 252 && a.heat[1] === 4);
  check('row0 diff', a.diff.length === 8 && a.diff[7] === 8);
  const b = d.rows[1];
  check('fd row flags', b.extended && b.fd && !b.hasDiff && !b.isNew && b.dlcBytes === 64);
  check('fd row id/rx', b.arbId === 0x1ffffff0 && b.rxCount === 0xfffffff0);
  check('fd row sizes', b.heat.length === 512 && b.diff.length === 64 && b.constant.length === 64);
  check('fd bit 511 heat', b.heat[511] === 255 && b.diff[63] === 0xaa && b.constant[0] === 0x0f);
  check('zero copy', a.heat.buffer === buf && b.constant.buffer === buf);

  // errors
  const bad = new Uint8Array(buf.slice(0));
  bad[0] = 0x58;
  check('bad magic', throwsCode(() => decodeReSnapshot(bad.buffer)) === 'badMagic');
  check('empty buf', throwsCode(() => decodeReSnapshot(new ArrayBuffer(0))) === 'truncated');
  let allTrunc = true;
  for (let n = 0; n < buf.byteLength; n += 1) {
    const code = throwsCode(() => decodeReSnapshot(buf.slice(0, n)));
    if (code !== 'truncated') {
      allTrunc = false;
      console.log(`  truncation at ${n} -> ${code}`);
      break;
    }
  }
  check('every truncation throws typed error', allTrunc);
  const badPhase = new Uint8Array(buf.slice(0));
  badPhase[16] = 9;
  check('bad phase', throwsCode(() => decodeReSnapshot(badPhase.buffer)) === 'badField');
  const badDlc = new Uint8Array(buf.slice(0));
  badDlc[RE_HEADER_BYTES + 2] = 65;
  check('dlc > 64', throwsCode(() => decodeReSnapshot(badDlc.buffer)) === 'badField');
  const padded = new Uint8Array(buf.byteLength + 1);
  padded.set(new Uint8Array(buf));
  check('trailing bytes rejected (typed)', throwsCode(() => decodeReSnapshot(padded.buffer)) === 'trailing');
  // NRE2: data payload decodes (byte 0 first) and v1 magic is rejected with a clear message
  check('row0 data default', a.data.length === 8 && a.data.every((v) => v === 0));
  const dd = decodeReSnapshot(encodeReSnapshotForTest(mkSnap([mkRow({ arbId: 1, data: Uint8Array.from([0x3f, 0, 0xff, 1, 2, 3, 4, 0x80]) })])));
  check('data decoded', Array.from(dd.rows[0].data).join() === '63,0,255,1,2,3,4,128');
  const v1 = new Uint8Array(buf.slice(0));
  v1.set([0x4e, 0x52, 0x45, 0x31], 0);
  let v1msg = '';
  try {
    decodeReSnapshot(v1.buffer);
  } catch (e) {
    v1msg = e instanceof ReCodecError ? `${e.code}:${e.message}` : 'other';
  }
  check('NRE1 rejected clearly', v1msg.startsWith('badMagic:') && v1msg.includes('outdated backend'), v1msg);
  const empty = decodeReSnapshot(encodeReSnapshotForTest(mkSnap([], { totalRows: 5 })));
  check('empty snapshot', empty.rows.length === 0 && empty.totalRows === 5);
}

const FAKE_STATUS: ReStatusDto = {
  enabled: true, phase: 'free', rows: 0, overflowRows: 0, framesIngested: 0, startedAtUs: 0, phaseStartedAtUs: 0,
};
function fakeApi(): ReClientApi {
  return {
    demo: false,
    start: async () => FAKE_STATUS,
    stop: async () => ({ ...FAKE_STATUS, enabled: false }),
    reset: async () => ({ ...FAKE_STATUS, rows: 0 }),
    setPhase: async (phase) => ({ ...FAKE_STATUS, phase }),
    mark: async (label) => ({ id: 1, tsUs: 5, label, phase: 'free' }),
    markers: async () => [],
    subscribe: async () => () => undefined,
  };
}

async function resubscribeTests(): Promise<void> {
  let subs = 0;
  const h: { sink: ((s: ReSnapshot) => void) | null } = { sink: null };
  let closed = false;
  const api = fakeApi();
  api.subscribe = async (on) => {
    subs += 1;
    h.sink = on;
    closed = false;
    return () => {
      closed = true;
    };
  };
  const base = api.stop;
  api.stop = async () => {
    // backend ends the subscription on stop
    h.sink = null;
    return base();
  };
  const st = createReStore(api);
  await st.attach();
  await st.start();
  check('start resubscribes', subs === 2);
  h.sink?.(mkSnap([mkRow({ arbId: 1 })], { seq: 1, full: true }));
  check('snapshots flow 1', st.getRows().size === 1);
  await st.stop();
  check('sink closed by backend on stop', h.sink === null);
  await st.start();
  check('second start resubscribes', subs === 3);
  h.sink?.(mkSnap([mkRow({ arbId: 2 })], { seq: 1, full: true }));
  check('snapshots flow again after stop/start', st.getRows().size === 1 && st.getRows().has('0:s:2'));
  check('old subscription disposed', closed === false && st.getState().status?.enabled === true);
  st.detach();
}

async function storeTests(): Promise<void> {
  const st = createReStore(fakeApi());
  await st.start();
  check('store status', st.getState().status?.enabled === true && st.getState().phase === 'free');
  const src = mkRow({ arbId: 0x10, rxCount: 1, heat: new Uint8Array(64).fill(9) });
  st.applySnapshot(mkSnap([src, mkRow({ arbId: 0x20 })], { seq: 1, full: true, totalRows: 2 }));
  check('full inserts', st.getRows().size === 2 && st.getState().totalRows === 2);
  const v0 = st.getState().rowsVersion;
  // copy semantics: mutating the source buffer must not alter the store
  src.heat[0] = 200;
  check('store copies bytes', st.getRows().get('0:s:16')?.heat[0] === 9);
  // dirty: only row 0x10 updated, 0x20 retained
  st.applySnapshot(mkSnap([mkRow({ arbId: 0x10, rxCount: 50 })], { seq: 2, full: false, totalRows: 2, phase: 'baseline' }));
  check('dirty keeps others', st.getRows().size === 2 && st.getRows().get('0:s:32') !== undefined);
  check('dirty updates', st.getRows().get('0:s:16')?.rxCount === 50 && st.getRows().get('0:s:16')?.updatedSeq === 2);
  check('phase from snapshot', st.getState().phase === 'baseline' && st.getState().status?.phase === 'baseline');
  check('version bumps', st.getState().rowsVersion === v0 + 1);
  // key distinguishes ext/bus
  st.applySnapshot(mkSnap([mkRow({ arbId: 0x10, extended: true }), mkRow({ arbId: 0x10, bus: 1 })], { seq: 3, totalRows: 4 }));
  check('key ext/bus', st.getRows().size === 4 && st.getRows().has('0:x:16') && st.getRows().has('1:s:16'));
  // full replaces
  st.applySnapshot(mkSnap([mkRow({ arbId: 0x99 })], { seq: 4, full: true, totalRows: 1 }));
  check('full replaces', st.getRows().size === 1 && st.getRows().has('0:s:153'));
  // prevData: first update == data; second update keeps the previous value; unchanged third update -> equal again
  const pv = createReStore(fakeApi());
  pv.applySnapshot(mkSnap([mkRow({ arbId: 0x77, data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) })], { seq: 1, full: true, totalRows: 1 }));
  const p1 = pv.getRows().get('0:s:119');
  check('prevData first == data', p1 !== undefined && p1.prevData.join() === p1.data.join());
  pv.applySnapshot(mkSnap([mkRow({ arbId: 0x77, data: Uint8Array.from([1, 9, 3, 4, 5, 6, 7, 0]) })], { seq: 2, totalRows: 1 }));
  const p2 = pv.getRows().get('0:s:119');
  check('prevData keeps old value', p2 !== undefined && p2.data.join() === '1,9,3,4,5,6,7,0' && p2.prevData.join() === '1,2,3,4,5,6,7,8');
  pv.applySnapshot(mkSnap([mkRow({ arbId: 0x77, data: Uint8Array.from([1, 9, 3, 4, 5, 6, 7, 0]) })], { seq: 3, totalRows: 1 }));
  const p3 = pv.getRows().get('0:s:119');
  check('prevData settles when unchanged', p3 !== undefined && p3.prevData.join() === p3.data.join());
  const srcData = Uint8Array.from([5, 5]);
  pv.applySnapshot(mkSnap([mkRow({ arbId: 0x78, dlcBytes: 2, data: srcData })], { seq: 4, totalRows: 2 }));
  srcData[0] = 0;
  check('data copied', pv.getRows().get('0:s:120')?.data[0] === 5);
  await st.mark('door');
  check('marker stored', st.getState().markers.length === 1 && st.getState().markers[0].label === 'door');
  await st.reset();
  check('reset clears', st.getRows().size === 0 && st.getState().markers.length === 0 && st.getState().selected === null);
  st.setFilters({ onlyDiff: true });
  check('filters patch', st.getState().filters.onlyDiff && !st.getState().filters.hideConstant);
}

function view(p: Partial<ReSnapshotRow> & { arbId: number }): ReRowView {
  const r = mkRow(p);
  return {
    key: `${r.bus}:${r.extended ? 'x' : 's'}:${r.arbId}`, bus: r.bus, extended: r.extended, fd: r.fd, hasDiff: r.hasDiff,
    dlcBytes: r.dlcBytes, arbId: r.arbId, rxCount: r.rxCount, heat: r.heat, diff: r.diff, constant: r.constant, data: r.data, prevData: r.data, updatedSeq: 0,
  };
}

function filterTests(): void {
  const constRow = view({ arbId: 0x300 }); // all constant
  const diffRow = view({ arbId: 0x100, hasDiff: true, diff: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]), constant: new Uint8Array(8) });
  const noisyHeat = new Uint8Array(64).fill(RE_NOISE_HEAT + 10);
  const noisyRow = view({ arbId: 0x200, heat: noisyHeat, constant: new Uint8Array(8) });
  const busRow = view({ arbId: 0x050, bus: 1, constant: new Uint8Array(8), heat: new Uint8Array(64).fill(20) });
  const extRow = view({ arbId: 0x18ff1234, extended: true, constant: new Uint8Array(8), heat: new Uint8Array(64).fill(20) });
  const all = [constRow, noisyRow, diffRow, busRow, extRow];
  const ids = (f: Partial<typeof DEFAULT_RE_FILTERS>): number[] => filterRows(all, { ...DEFAULT_RE_FILTERS, ...f }).map((r) => r.arbId);

  check('no filter sorted', ids({}).join() === [0x100, 0x200, 0x300, 0x18ff1234, 0x050].join(), ids({}).join());
  check('onlyDiff', ids({ onlyDiff: true }).join() === String(0x100));
  check('hideConstant', !ids({ hideConstant: true }).includes(0x300) && ids({ hideConstant: true }).length === 4);
  check('muteNoisy hides fully noisy rows', !ids({ muteNoisy: true }).includes(0x200) && ids({ muteNoisy: true }).includes(0x100));
  check('muteNoisy keeps diff row even if noisy', filterRows([{ ...noisyRow, hasDiff: true }], { ...DEFAULT_RE_FILTERS, muteNoisy: true }).length === 1);
  check('bus', ids({ bus: 1 }).join() === String(0x050));
  check('search hex', ids({ search: '0x18ff' }).join() === String(0x18ff1234));
  check('search case', ids({ search: '1A' }).length === 0 && ids({ search: 'FF12' }).length === 1);
  check('search decimal', ids({ search: String(0x300) }).includes(0x300));
}

function demoTests(): void {
  const mk = (): ReDemoEngine => new ReDemoEngine(() => 1_000_000_000);
  const e = mk();
  check('demo tick before start is null', e.tick() === null);
  e.start(null);
  const first = decodeDemoTick(e);
  check('demo first full', first !== null && first.full && first.totalRows >= 4 && first.rows.every((r) => r.isNew));
  const second = decodeDemoTick(e);
  check('demo second dirty not full', second !== null && !second.full && second.rows.every((r) => !r.isNew));
  // determinism
  const a = mk();
  const b = mk();
  a.start(null);
  b.start(null);
  let same = true;
  for (let i = 0; i < 30; i += 1) {
    const x = a.tick();
    const y = b.tick();
    if (x === null || y === null || new Uint8Array(x).join() !== new Uint8Array(y).join()) same = false;
  }
  check('demo deterministic', same);

  // baseline -> action diff: flag bit (0x100 byte4 bit0 = bit 32) appears only after action
  const d = mk();
  d.start(null);
  d.setPhase('baseline');
  for (let i = 0; i < 30; i += 1) d.tick();
  let det = d.rowDetail({ bus: 0, arbId: 0x100, isExtended: false });
  check('baseline: no diff', hexToBytes(det.diffMask).every((v) => v === 0));
  check('counter nibble toggles in baseline', hexToBytes(det.baselineMask)[0] === 0x0f, det.baselineMask);
  d.setPhase('action');
  for (let i = 0; i < 30; i += 1) d.tick();
  det = d.rowDetail({ bus: 0, arbId: 0x100, isExtended: false });
  check('action: flag bit in diff', hexToBytes(det.diffMask)[4] === 0x01, det.diffMask);
  check('toggles exact length', det.toggles.length === 64 && det.toggles[32] > 0 && det.toggles[8] === 0);
  check('constant mask byte1', hexToBytes(det.constantMask)[1] === 0xff);
  const snap = decodeDemoTick(d);
  const r100 = snap?.rows.find((r) => r.arbId === 0x100);
  check('snapshot diff + hasDiff', r100 !== undefined && r100.hasDiff && r100.diff[4] === 1);
  // entering baseline again clears baseline_active only
  d.setPhase('baseline');
  det = d.rowDetail({ bus: 0, arbId: 0x100, isExtended: false });
  check('re-enter baseline clears baseline', hexToBytes(det.baselineMask).every((v) => v === 0));
  // classify
  const cls = d.classify({ bus: 0, arbId: 0x100, isExtended: false });
  check('classify demo fields', cls.samples === 64 && cls.fields.some((f) => f.kind === 'counter') && cls.fields.some((f) => f.kind === 'checksum'));
  check('classify entropy len', cls.bitEntropy.length === 64 && cls.bitEntropy[32] >= 0 && cls.bitEntropy[8] === 0);
  check('classify period ~10ms', cls.periodMs !== null && Math.abs(cls.periodMs - 10) < 1, String(cls.periodMs));
  // FD row
  const fd = d.rowDetail({ bus: 1, arbId: 0x400, isExtended: false });
  check('demo fd row 16 bytes', fd.dlcBytes === 16 && fd.toggles.length === 128);
  // stop pauses, reset clears
  d.stop();
  check('stopped -> no tick', d.tick() === null);
  d.start(null);
  d.mark('x');
  d.reset();
  check('reset clears rows+markers', d.status().rows === 0 && d.listMarkers().length === 0);
  // bus filter
  const f = mk();
  f.start([1]);
  f.tick();
  check('bus filter', f.status().rows === 1);
}

function modelTests(): void {
  check('intel bits', fieldBits({ startBit: 6, bitLength: 4, byteOrder: 'intel' }).join() === '6,7,8,9');
  check('motorola sawtooth', fieldBits({ startBit: 11, bitLength: 8, byteOrder: 'motorola' }).join() === '11,10,9,8,23,22,21,20');
  check('fd bit 511', fieldBits({ startBit: 510, bitLength: 4, byteOrder: 'intel' }).join() === '510,511');
  check('elapsed', formatElapsed(65_300_000) === '01:05.3' && formatElapsed(-5) === '00:00.0');
  check('HEX2 table', HEX2.length === 256 && HEX2[0] === '00' && HEX2[0x3f] === '3F' && HEX2[255] === 'FF' && HEX2[16] === '10');
  check('byte triple', formatByteTriple(0x3f) === '0x3F · 63 · 0011 1111' && formatByteTriple(0) === '0x00 · 0 · 0000 0000');
  check('hexToBytes', hexToBytes('00ff10').join() === '0,255,16' && hexToBytes('00FF1A').join() === '0,255,26');
}

async function sourceTests(): Promise<void> {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  const src = createReSourceState(storage);
  check('source default live', src.get() === 'live');
  src.set('demo');
  check('source persisted', src.get() === 'demo' && mem.get(RE_SOURCE_STORAGE_KEY) === 'demo');
  check('source restored from storage', createReSourceState(storage).get() === 'demo');
  check('unknown stored value -> live', createReSourceState({ getItem: () => 'bogus', setItem: () => undefined }).get() === 'live');

  const calls: string[] = [];
  const mk = (name: string, demo: boolean): ReClientApi => ({ ...fakeApi(), demo, stop: async () => { calls.push(`stop:${name}`); return FAKE_STATUS; } });
  const liveApi = mk('live', false);
  const demoApi = mk('demo', true);
  const ctlState = createReSourceState(null);
  const ctl: ReSourceController = { get: ctlState.get, set: ctlState.set, apiFor: (x: ReSource) => (x === 'demo' ? demoApi : liveApi) };
  const st = createReStore(ctl.apiFor(ctl.get()), ctl);
  check('store starts live', !st.getState().demo);
  let notified = 0;
  st.onSourceChange(() => { notified += 1; });
  st.applySnapshot(mkSnap([mkRow({ arbId: 0x10 })], { seq: 1, full: true, totalRows: 1 }));
  await st.mark('x');
  st.select({ bus: 0, arbId: 0x10, isExtended: false });
  await st.setSource('demo');
  check('setSource demo: state flag', st.getState().demo && ctl.get() === 'demo');
  check('setSource stopped old (live) session', calls.join() === 'stop:live', calls.join());
  check('setSource cleared rows/markers/selection', st.getRows().size === 0 && st.getState().markers.length === 0 && st.getState().selected === null && st.getState().totalRows === 0);
  check('source listener notified', notified === 1);
  await st.setSource('demo');
  check('same source is a no-op', notified === 1 && calls.length === 1);
  await st.start();
  check('demo client used only for demo source', st.getState().demo);
  await st.setSource('live');
  check('back to live', !st.getState().demo && calls.join() === 'stop:live,stop:demo', calls.join());

  const sigApi: ReSignalApi = {
    demo: false, focusSet: async () => ({ targets: [] }), series: async () => { throw new Error('no'); }, correlate: async () => { throw new Error('no'); },
    nowUs: () => 0, originUs: () => null, setInterval: () => 1, clearInterval: () => undefined,
  };
  const sg = createReSignalStore(sigApi);
  await sg.setTarget({ bus: 0, arbId: 1, isExtended: false });
  sg.addCandidateFromField({ startBit: 0, bitLength: 8, byteOrder: 'intel' });
  sg.resetForSource();
  check('signal store reset on source change', sg.getState().target === null && sg.getState().candidates.length === 0);
}

async function main(): Promise<void> {
  codecTests();
  await storeTests();
  await resubscribeTests();
  await sourceTests();
  filterTests();
  demoTests();
  modelTests();
  console.log(`\nre: ${checks - failures}/${checks} checks`);
  if (failures > 0) {
    const proc = (globalThis as { process?: { exitCode?: number } }).process;
    if (proc) proc.exitCode = 1;
  }
}

await main();
