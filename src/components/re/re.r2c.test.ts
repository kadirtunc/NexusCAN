/** RE R2c Value Scan frontend tests (non-probe logic): form builders, store wiring, paging, demo scan. Run: `npm run test:re-r2c`. */
import { ReDemoEngine, decodeDemoTick } from '../../services/reDemo';
import { DemoScanner } from '../../services/reScanDemo';
import { reScanFirst, reScanNext, reScanResults } from '../../services/reClient';
import { createReScanStore, type ReScanApi } from '../../store/reScanStore';
import { createReLogger } from '../../store/reDebugLog';
import {
  buildFirstSpec, buildNextOp, defaultScanForm, formatScanRawHex, parseScanNumber, parseBusFilter, parseIdFilter, parseNumText, parseUserPreset, scanCandidateKey,
  validateFirstSpec, validateNextOp, virtualWindow,
} from './reScanModel';
import type { ReScanFirstSpec, ReScanNextOp, ReScanResultRowDto, ReScanResultsDto, ReScanSort, ReScanStatusDto } from '../../types/reScan';
import type { AppendDebugEventInputDto } from '../../types/hal';

let checks = 0;
let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

// ---- hex input / display
{
  const v = (x: string): number | null => parseScanNumber(x);
  check('parseScanNumber decimal', v('80') === 80 && v('1.5') === 1.5 && v('1e3') === 1000 && v('') === null && v('1,5') === 1.5);
  check('parseScanNumber hex', v('0x50') === 80 && v('0X1f40') === 8000 && v('-0x10') === -16 && v(' 0xFF ') === 255);
  check('parseScanNumber invalid -> NaN', Number.isNaN(v('0x') ?? 0) && Number.isNaN(v('0xZZ') ?? 0) && Number.isNaN(v('0x1.8') ?? 0) && v('0x') !== null);
  const spec = buildFirstSpec({ ...defaultScanForm(), kind: 'exact', valueText: '0x1F40', tolText: '0x2' }, []);
  check('buildFirstSpec hex value/tolerance', spec.value === 8000 && spec.tolerance === 2 && validateFirstSpec(spec).length === 0);
  check('buildFirstSpec bad hex invalid', validateFirstSpec(buildFirstSpec({ ...defaultScanForm(), kind: 'exact', valueText: '0xZZ' }, [])).includes('value_not_finite'));
  const r = buildFirstSpec({ ...defaultScanForm(), kind: 'range', rangeAText: '0x10', rangeBText: '0x20' }, []);
  check('hex range', r.range?.[0] === 16 && r.range[1] === 32);
  const op = buildNextOp({ ...defaultScanForm(), op: 'range', opRangeAText: '0x0', opRangeBText: '0xFF' });
  check('hex next-op range', op.range?.[1] === 255 && validateNextOp(op).length === 0);
  check('stableMs stays decimal-only', Number.isNaN(buildNextOp({ ...defaultScanForm(), op: 'stable', opStableText: '0x10' }).stableMs ?? 0));
  check('formatScanRawHex', formatScanRawHex(8000) === '0x1F40' && formatScanRawHex(-16) === '-0x10' && formatScanRawHex(0) === '0x0' && formatScanRawHex(null) === '—' && formatScanRawHex(1.5) === '1.5');
}

// ---- pure form helpers
check('parseNumText', parseNumText('') === null && parseNumText(' 1,5 ') === 1.5 && Number.isNaN(parseNumText('abc') ?? 0) && parseNumText('-2e1') === -20);
check('parseBusFilter', JSON.stringify(parseBusFilter('0, 1')) === '[0,1]' && parseBusFilter('') === null && Number.isNaN(parseBusFilter('x')?.[0] ?? 0));
{
  const ids = parseIdFilter('1A0 0:0x18FF1234x 7FF', [0, 1]);
  check('parseIdFilter expands buses + ext detection', JSON.stringify(ids) === JSON.stringify([
    { bus: 0, arbId: 0x1a0, isExtended: false }, { bus: 1, arbId: 0x1a0, isExtended: false },
    { bus: 0, arbId: 0x18ff1234, isExtended: true }, { bus: 0, arbId: 0x7ff, isExtended: false }, { bus: 1, arbId: 0x7ff, isExtended: false },
  ]), JSON.stringify(ids));
  check('parseIdFilter empty -> null; garbage -> invalid id', parseIdFilter(' ', []) === null && validateFirstSpec({ ...buildFirstSpec(defaultScanForm(), []), options: { ...buildFirstSpec(defaultScanForm(), []).options, ids: parseIdFilter('zz!', []) } }).includes('id_out_of_range'));
}
check('parseUserPreset', JSON.stringify(parseUserPreset('0.02:-5')) === '{"factor":0.02,"offset":-5}' && parseUserPreset('0') === null && parseUserPreset('a') === null && parseUserPreset('2')?.offset === 0);
{
  const f = { ...defaultScanForm(), kind: 'physical' as const, valueText: '80', tolText: '' };
  const spec = buildFirstSpec(f, [0]);
  check('buildFirstSpec physical', spec.kind === 'physical' && spec.value === 80 && spec.tolerance === null && validateFirstSpec(spec).length === 0);
  check('buildFirstSpec empty value invalid', validateFirstSpec(buildFirstSpec({ ...f, valueText: '' }, [])).includes('value_required'));
  const op = buildNextOp({ ...defaultScanForm(), op: 'stable', opStableText: '1500' });
  check('buildNextOp stable', op.stableMs === 1500 && op.value === null && validateNextOp(op).length === 0);
  check('buildNextOp physical only where supported', !buildNextOp({ ...defaultScanForm(), op: 'changed', opPhysical: true }).physical && buildNextOp({ ...defaultScanForm(), op: 'exact', opPhysical: true }).physical);
  check('median samples parsed', buildFirstSpec({ ...defaultScanForm(), options: { ...defaultScanForm().options, readMode: { kind: 'median', samples: 5 } }, medianSamplesText: '7' }, []).options.readMode.kind === 'median');
}
{
  const w = virtualWindow(220, 100, 22, 1000, 2);
  check('virtualWindow', w.start === 8 && w.end === 17, JSON.stringify(w));
  const e = virtualWindow(0, 100, 22, 3, 6);
  check('virtualWindow clamps', e.start === 0 && e.end === 3 && virtualWindow(0, 100, 22, 0).end === 0);
}

// ---- store with a fake API
function st(over: Partial<ReScanStatusDto> = {}): ReScanStatusDto {
  return { active: true, scanId: 1, step: 0, candidates: 10, history: [10], truncated: false, elapsedMs: 1, undoDepth: 0, historyCovered: null, ...over };
}
function mkRow(arb: number, start: number): ReScanResultRowDto {
  return {
    candidate: { bus: 0, arbId: arb, isExtended: false, startBit: start, bitLength: 8, byteOrder: 'intel', valueType: 'unsigned' },
    preset: null, currentRaw: 1, currentPhysical: null, previousRaw: null, changeCount: 0, kindHint: null, containedCount: 0, contained: [],
  };
}

async function storeTests(): Promise<void> {
  const calls: string[] = [];
  const all = Array.from({ length: 250 }, (_, i) => mkRow(0x100 + (i >> 3), (i & 7) * 8));
  let step = 0;
  let fail: string | null = null;
  const status = (): ReScanStatusDto => st({ step, candidates: all.length, history: Array.from({ length: step + 1 }, () => all.length), undoDepth: step });
  const api: ReScanApi = {
    first: async (spec: ReScanFirstSpec) => { calls.push(`first:${spec.kind}`); if (fail !== null) throw new Error(fail); step = 0; return status(); },
    next: async (op: ReScanNextOp) => { calls.push(`next:${op.op}`); step += 1; return status(); },
    undo: async () => { calls.push('undo'); step -= 1; return status(); },
    reset: async () => { calls.push('reset'); step = 0; return st({ active: false, candidates: 0, history: [], undoDepth: 0 }); },
    status: async () => status(),
    results: async (offset: number, limit: number, sort: ReScanSort): Promise<ReScanResultsDto> => {
      calls.push(`results:${offset}:${limit}:${sort}`);
      return { scanId: 1, step, total: all.length, candidates: all.length, offset, rows: all.slice(offset, offset + limit) };
    },
  };
  const events: AppendDebugEventInputDto[] = [];
  const logger = createReLogger({ emit: (e) => events.push(e), nowMs: () => 0 });
  const s = createReScanStore(api, logger);

  await s.first([0]);
  check('first: status + page 0 loaded', s.getState().ui.status?.active === true && s.getState().results?.rows.length === 100 && calls.join() === 'first:unknown,results:0:100:id', calls.join());
  s.setForm({ op: 'increased' });
  await s.next();
  check('next records lastOp and reloads page 0', s.getState().ui.lastOp?.op === 'increased' && calls[calls.length - 1] === 'results:0:100:id');
  await s.setOffset(100);
  check('paging offset', s.getState().results?.offset === 100 && s.getState().offset === 100);
  await s.setSort('changes');
  check('sort resets to page 0', s.getState().sort === 'changes' && s.getState().offset === 0 && calls[calls.length - 1] === 'results:0:100:changes');
  await s.setLimit(9999);
  check('limit clamped to 500', s.getState().limit === 500 && calls[calls.length - 1] === 'results:0:500:changes');
  await s.setLimit(100);
  await s.repeatLast();
  check('Enter repeats last op', calls.includes('next:increased') && calls.filter((c) => c === 'next:increased').length === 2);
  await s.undo();
  check('undo', calls.includes('undo') && s.getState().ui.status?.undoDepth === 1);

  // refreshVisible merges by key, keeps other rows
  const before = s.getState().results;
  all[3] = { ...all[3], currentRaw: 99 };
  await s.refreshVisible(2, 3);
  const after = s.getState().results;
  check('refreshVisible merges only visible rows', after?.rows[3].currentRaw === 99 && after.rows[0] === before?.rows[0] && calls[calls.length - 1] === 'results:2:3:id'.replace(':id', ':changes'), calls[calls.length - 1]);

  // failure path -> error + Debug console RE
  fail = '[re:scan_too_large] too many';
  await s.first([0]);
  check('failure: error kept, status kept, logged as RE', s.getState().ui.error === '[re:scan_too_large] too many' && !s.getState().ui.busy && s.getState().ui.status?.active === true
    && events.length === 1 && events[0].category === 'RE' && events[0].action === 're.scan_first' && events[0].severity === 'error', JSON.stringify(events));
  fail = null;

  await s.reset();
  check('reset clears results, keeps lastOp', s.getState().results === null && s.getState().ui.status?.active === false && s.getState().ui.lastOp?.op === 'increased');
  const n = calls.length;
  await s.refreshVisible(0, 5);
  check('no refresh without an active scan', calls.length === n);
  await s.first([0]);
  s.invalidate();
  check('invalidate drops scan', s.getState().results === null && s.getState().ui.status === null);

  // busy guard
  let release: () => void = () => undefined;
  const slow: ReScanApi = { ...api, first: () => new Promise((r) => { release = () => r(st()); }) };
  const s2 = createReScanStore(slow);
  const p = s2.first([]);
  const p2 = s2.first([]);
  check('busy guard ignores a second click', s2.getState().ui.busy);
  release();
  await Promise.all([p, p2]);
}

// ---- reClient client-side validation (never reaches IPC)
async function clientTests(): Promise<void> {
  const bad = { ...buildFirstSpec(defaultScanForm(), []), kind: 'exact' as const, value: null };
  let msg = '';
  try { await reScanFirst(bad); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
  check('reScanFirst validates before sending', msg.startsWith('[re:invalid]') && msg.includes('value_required'), msg);
  msg = '';
  try { await reScanNext({ op: 'stable', value: null, tolerance: null, range: null, stableMs: 0, physical: false, presets: null }); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
  check('reScanNext validates before sending', msg.includes('stable_ms_invalid'), msg);
  msg = '';
  try { await reScanResults(0, 501, 'id'); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
  check('results limit <= 500 enforced', msg.startsWith('[re:invalid]'), msg);
}

// ---- demo scan with planted pedal / speed
function demoTests(): void {
  const eng = new ReDemoEngine(() => 1_000_000_000, true);
  const sc = new DemoScanner(eng);
  let threw = '';
  try { sc.first(buildFirstSpec(defaultScanForm(), [])); } catch (e) { threw = String(e); }
  check('scan while stopped -> not_started', threw.includes('[re:not_started]'), threw);
  try { sc.next({ op: 'changed', value: null, tolerance: null, range: null, stableMs: null, physical: false, presets: null }); threw = ''; } catch (e) { threw = String(e); }
  check('next without scan -> no_scan', threw.includes('[re:no_scan]'), threw);
  eng.start(null);
  const tick = (n: number): void => { for (let i = 0; i < n; i += 1) decodeDemoTick(eng); };
  tick(30);
  const op = (o: ReScanNextOp['op'], extra: Partial<ReScanNextOp> = {}): ReScanNextOp => ({ op: o, value: null, tolerance: null, range: null, stableMs: null, physical: false, presets: null, ...extra });
  const s0 = sc.first(buildFirstSpec(defaultScanForm(), [0]));
  check('unknown first scan keeps non-constant candidates', s0.active && s0.candidates > 0 && s0.history.length === 1 && s0.undoDepth === 0, JSON.stringify(s0));
  tick(20);
  const s1 = sc.next(op('increased'));
  tick(20);
  const s2 = sc.next(op('increased'));
  check('increased x2 shrinks the set', s2.candidates < s0.candidates && s1.candidates <= s0.candidates && s2.undoDepth === 2 && s2.history.length === 3, JSON.stringify(s2));
  const latest = eng.scanRows().find((r) => r.arbId === 0x1a0)?.latest ?? new Uint8Array(8);
  const speed = (((latest[1] << 8) | latest[2]) * 0.01);
  const s3 = sc.next(op('exact', { value: Number(speed.toFixed(2)), physical: true }));
  const res = sc.results(0, 500, 'id');
  for (let off = 500; off < res.total; off += 500) res.rows.push(...sc.results(off, 500, 'id').rows);
  const isPlanted = (c: { arbId: number; startBit: number; bitLength: number; byteOrder: string; valueType: string }): boolean =>
    c.arbId === 0x1a0 && c.startBit === 15 && c.bitLength === 16 && c.byteOrder === 'motorola' && c.valueType === 'unsigned';
  const planted = res.rows.find((r) => isPlanted(r.candidate));
  const inGroup = res.rows.some((r) => r.contained.some(isPlanted));
  check('planted 16-bit Motorola speed survives (head or contained)', planted !== undefined || inGroup, JSON.stringify(res.rows.filter((r) => r.candidate.arbId === 0x1a0)));
  check('planted speed head carries preset 0.01 / 0', planted !== undefined && planted.preset?.factor === 0.01 && planted.preset.offset === 0, JSON.stringify(planted));
  check('physical value matches', planted !== undefined && Math.abs((planted.currentPhysical ?? -1) - speed) < 0.5, String(planted?.currentPhysical));
  check('results total/candidates consistent', res.total <= res.candidates && res.candidates === s3.candidates && res.rows.length === res.total);
  const contained = res.rows.reduce((a, r) => a + r.containedCount, 0);
  check('contained group counted once each', new Set(res.rows.flatMap((r) => [scanCandidateKey(r.candidate), ...r.contained.map(scanCandidateKey)])).size === res.rows.length + contained);
  const undone = sc.undo();
  check('undo restores previous set', undone.candidates === s2.candidates && undone.undoDepth === 2 && undone.history.length === 3);
  sc.reset();
  check('reset -> inactive', !sc.status().active);
  let e2 = '';
  try { sc.results(0, 10, 'id'); } catch (e) { e2 = String(e); }
  check('results without scan -> no_scan', e2.includes('[re:no_scan]'));
  // undo at depth 0
  sc.first(buildFirstSpec(defaultScanForm(), []));
  try { sc.undo(); e2 = ''; } catch (e) { e2 = String(e); }
  check('undo at depth 0 -> invalid', e2.includes('[re:invalid]'), e2);
  // exact raw first scan: pedal raw plausible; alignment byte filters odd starts
  const byteAligned = sc.first(buildFirstSpec({ ...defaultScanForm(), options: { ...defaultScanForm().options, alignment: 'byte', lengths: [8] } }, []));
  const rows = sc.results(0, 500, 'id').rows;
  check('byte alignment: every start % 8 == 0 (Intel)', byteAligned.candidates > 0 && rows.filter((r) => r.candidate.byteOrder === 'intel').every((r) => r.candidate.startBit % 8 === 0));
  const filtered = sc.first(buildFirstSpec({ ...defaultScanForm(), idText: '2B0' }, [0]));
  check('ID filter limits rows', sc.results(0, 500, 'id').rows.every((r) => r.candidate.arbId === 0x2b0) && filtered.candidates > 0);
  const stable = sc.next(op('stable', { stableMs: 100 }));
  check('stable sets historyCovered', stable.historyCovered !== null);
  sc.invalidate();
  check('invalidate -> inactive', !sc.status().active);
}

async function main(): Promise<void> {
  await storeTests();
  await clientTests();
  demoTests();
  console.log(`re.r2c: ${checks - failures}/${checks} checks passed`);
  if (failures > 0) (globalThis as { process?: { exitCode?: number } }).process!.exitCode = 1;
}
void main();
