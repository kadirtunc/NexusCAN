/** RE IPC-boundary sanitisers + RE -> Debug console logging (rate limiter, store error paths). Run: `npm run test:re-hardening`. */
import {
  reBuses, reCandidate, reCorrelateRequest, reOptUint, reReference, reSeriesRequest, reUint, RE_U16_MAX, RE_U32_MAX, RE_U64_MAX, RE_U8_MAX,
} from '../../services/reArgs';
import { ReCodecError } from '../../services/reSnapshotCodec';
import { createReLogger, NOOP_RE_LOGGER, RE_LOG_RATE_LIMIT_MS } from '../../store/reDebugLog';
import { createReStore, type ReClientApi } from '../../store/reStore';
import { createReSignalStore, type ReSignalApi } from '../../store/reSignalStore';
import type { AppendDebugEventInputDto } from '../../types/hal';
import type { ReCandidateDto, ReSearchDto, ReSeriesRequest, ReStatusDto, ReTargetDto } from '../../types/re';
import { parseReError } from './reSignalModel';
import {
  DEFAULT_RE_DISPLAY, formatByteValue, loadReDisplay, parseReDisplay, reLayout, RE_DISPLAY_STORAGE_KEY, saveReDisplay, type ReDisplayStorage,
} from '../../store/reDisplay';

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}
function throwsInvalid(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof Error && parseReError(e).code === 'invalid';
  }
}

const T: ReTargetDto = { bus: 0, arbId: 0x100, isExtended: false };
const CAND: ReCandidateDto = { startBit: 16, bitLength: 16, byteOrder: 'intel', valueType: 'unsigned', factor: 0.1, offset: -40.25 };
const SEARCH: ReSearchDto = { bitFrom: 0, bitTo: 15, lengths: [4, 16], byteOrders: ['intel'], signed: [false] };

function argsTests(): void {
  check('uint rounds', reUint('x', 1_500_832_321.875, RE_U64_MAX) === 1_500_832_322 && reUint('x', 2.4, RE_U8_MAX) === 2);
  check('uint -0.4 -> 0 (not negative after rounding)', Object.is(reUint('x', -0.4, RE_U8_MAX), 0));
  check('uint rejects NaN/Inf', throwsInvalid(() => reUint('x', Number.NaN, 10)) && throwsInvalid(() => reUint('x', Infinity, 10)));
  check('uint rejects negative', throwsInvalid(() => reUint('x', -1, 10)) && throwsInvalid(() => reUint('x', -0.6, 10)));
  check('uint rejects overflow per width', throwsInvalid(() => reUint('x', 256, RE_U8_MAX)) && throwsInvalid(() => reUint('x', 65536, RE_U16_MAX)) && throwsInvalid(() => reUint('x', 2 ** 32, RE_U32_MAX)));
  check('error message names the field', (() => { try { reUint('fromUs', Number.NaN, 5); } catch (e) { return String(e).includes('[re:invalid] fromUs'); } return false; })());
  check('opt passes null', reOptUint('x', null, 5) === null && reOptUint('x', undefined, 5) === null && reOptUint('x', 1.6, 5) === 2);

  const req: ReSeriesRequest = { target: T, candidates: [CAND], reference: null, fromUs: 1_500_832_321.875, toUs: 1_530_832_321.5, maxPoints: 1023.7 };
  const out = reSeriesRequest(req);
  check('series req ints', out.fromUs === 1_500_832_322 && out.toUs === 1_530_832_322 && out.maxPoints === 1024);
  check('f64 factor/offset NOT rounded', out.candidates[0].factor === 0.1 && out.candidates[0].offset === -40.25);
  check('series req null window kept', reSeriesRequest({ ...req, fromUs: null, toUs: null }).fromUs === null);
  check('series req rejects negative window', throwsInvalid(() => reSeriesRequest({ ...req, fromUs: -5 })));
  check('series req rejects NaN maxPoints', throwsInvalid(() => reSeriesRequest({ ...req, maxPoints: Number.NaN })));
  check('series req rejects u16 overflow startBit', throwsInvalid(() => reSeriesRequest({ ...req, candidates: [{ ...CAND, startBit: 70000 }] })));
  check('candidate bits rounded', reCandidate({ ...CAND, startBit: 7.6, bitLength: 11.2 }).startBit === 8 && reCandidate({ ...CAND, startBit: 7.6, bitLength: 11.2 }).bitLength === 11);

  const ref = reReference({ kind: 'markers', points: [{ markerId: 1.2, value: 12.75 }, { markerId: 2, value: -0.5 }] });
  check('markers: id rounded, value untouched', ref?.kind === 'markers' && ref.points[0].markerId === 1 && ref.points[0].value === 12.75 && ref.points[1].value === -0.5);
  const obd = reReference({ kind: 'obd_pid', pid: 12.4, bus: 0.2 });
  check('obd pid/bus rounded', obd?.kind === 'obd_pid' && obd.pid === 12 && obd.bus === 0);
  const cr = reReference({ kind: 'candidate', target: { ...T, arbId: 256.4 }, candidate: { ...CAND, startBit: 1.5 } });
  check('candidate reference nested', cr?.kind === 'candidate' && cr.target.arbId === 256 && cr.candidate.startBit === 2 && cr.candidate.factor === 0.1);

  const c = reCorrelateRequest({ target: T, reference: { kind: 'obd_pid', pid: 12, bus: 0 }, fromUs: 10.5, toUs: 20.4, search: { ...SEARCH, bitTo: 15.6, lengths: [3.6, 16.2] }, topN: 10.5 });
  check('correlate req ints', c.fromUs === 11 && c.toUs === 20 && c.search.bitTo === 16 && c.search.lengths[0] === 4 && c.search.lengths[1] === 16 && c.topN === 11);
  check('correlate rejects topN > u8', throwsInvalid(() => reCorrelateRequest({ target: T, reference: { kind: 'obd_pid', pid: 12, bus: 0 }, fromUs: null, toUs: null, search: SEARCH, topN: 300 })));
  check('buses', reBuses(null) === null && reBuses([0.4, 1])?.join() === '0,1' && throwsInvalid(() => reBuses([-1])));
}

// ---- logger ----------------------------------------------------------------------------------------------------

function mkLogger(): { events: AppendDebugEventInputDto[]; clock: { t: number }; log: ReturnType<typeof createReLogger> } {
  const events: AppendDebugEventInputDto[] = [];
  const clock = { t: 1_000 };
  const log = createReLogger({ emit: (e) => events.push(e), nowMs: () => clock.t });
  return { events, clock, log };
}

function loggerTests(): void {
  const { events, clock, log } = mkLogger();
  log.error('re.series', 'RE series request failed', new Error('boom'), 'target=bus0 id=0x100');
  check('error logged once', events.length === 1);
  const e0 = events[0];
  check('event shape', e0.severity === 'error' && e0.category === 'RE' && e0.source === 'ui' && e0.action === 're.series' && e0.title === 'RE series request failed');
  check('details = message + ctx', e0.details === 'boom | target=bus0 id=0x100', String(e0.details));
  for (let i = 0; i < 50; i += 1) {
    clock.t += 100; // 10 Hz poll failing for 5 s -> collapsed
    if (clock.t - 1_000 < RE_LOG_RATE_LIMIT_MS) log.error('re.series', 'RE series request failed', new Error('boom'));
  }
  check('repeats within 5 s collapsed', events.length === 1, String(events.length));
  log.error('re.series', 'RE series request failed', new Error('other message'));
  check('different message is logged', events.length === 2);
  log.error('re.correlate', 'RE correlation failed', new Error('boom'));
  check('different action is logged', events.length === 3);
  clock.t = 1_000 + RE_LOG_RATE_LIMIT_MS + 1;
  log.error('re.series', 'RE series request failed', new Error('boom'));
  check('after 5 s the next log carries the repeat count', events.length === 4 && events[3].title.includes('(×49 repeated)'), events[3]?.title);
  clock.t += RE_LOG_RATE_LIMIT_MS + 1;
  log.error('re.series', 'RE series request failed', new Error('boom'));
  check('count resets after being reported', events.length === 5 && !events[4].title.includes('repeated'));
  log.info('re.start', 'RE capture start requested');
  log.info('re.start', 'RE capture start requested');
  check('info events are not rate limited', events.length === 7 && events[6].severity === 'info' && events[6].category === 'RE');
  check('string errors accepted', (() => { const m = mkLogger(); m.log.error('re.ws', 't', 'plain'); return m.events[0].details === 'plain'; })());
}

// ---- stores ----------------------------------------------------------------------------------------------------

const STATUS: ReStatusDto = { enabled: true, phase: 'free', rows: 0, overflowRows: 0, framesIngested: 0, startedAtUs: 1, phaseStartedAtUs: 1 };
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function reStoreTests(): Promise<void> {
  const { events, log } = mkLogger();
  let failStart = true;
  let onErr: ((e: Error) => void) | null = null;
  const api: ReClientApi = {
    demo: false,
    start: async () => { if (failStart) throw new Error('[re:invalid] fromUs must be a finite number'); return STATUS; },
    stop: async () => { throw new Error('stop down'); },
    reset: async () => STATUS,
    setPhase: async () => { throw new Error('phase down'); },
    mark: async () => { throw new Error('mark down'); },
    markers: async () => { throw new Error('markers down'); },
    subscribe: async (_s, e) => { onErr = e ?? null; return () => undefined; },
  };
  const st = createReStore(api, null, log);
  await st.attach();
  await st.start();
  check('start failure logged once, error state kept', events.filter((e) => e.action === 're.start' && e.severity === 'error').length === 1 && st.getState().error !== null);
  check('start info logged', events.some((e) => e.action === 're.start' && e.severity === 'info'));
  await st.start();
  check('repeated identical start failure collapsed', events.filter((e) => e.action === 're.start' && e.severity === 'error').length === 1);
  await st.stop();
  await st.setPhase('baseline');
  await st.mark('x');
  await st.refreshMarkers();
  const acts = new Set(events.filter((e) => e.severity === 'error').map((e) => e.action));
  check('stop/phase/mark/markers failures each logged', ['re.stop', 're.phase', 're.mark', 're.markers'].every((a) => acts.has(a)), [...acts].join());
  check('phase ctx in details', events.some((e) => e.action === 're.phase' && (e.details ?? '').includes('phase=baseline')));
  await st.reset();
  check('reset info logged', events.some((e) => e.action === 're.reset' && e.severity === 'info'));
  const decode = new ReCodecError('badMagic', 'bad magic');
  (onErr as ((e: Error) => void) | null)?.(decode);
  (onErr as ((e: Error) => void) | null)?.(new Error('socket closed'));
  check('decode and ws errors logged under their actions', events.some((e) => e.action === 're.snapshot_decode') && events.some((e) => e.action === 're.ws'));

  // subscribe failure + source switch
  const m2 = mkLogger();
  let src: 'live' | 'demo' = 'live';
  const api2: ReClientApi = { ...api, start: async () => STATUS, subscribe: async () => { throw new Error('ws refused'); } };
  const st2 = createReStore(api2, { get: () => src, set: (s) => { src = s; }, apiFor: () => api2 }, m2.log);
  await st2.attach();
  check('subscribe failure logged', m2.events.some((e) => e.action === 're.subscribe' && e.severity === 'error' && (e.details ?? '').includes('ws refused')));
  await st2.setSource('demo');
  check('source switch info logged; stop failure logged', m2.events.some((e) => e.action === 're.source' && e.severity === 'info') && m2.events.some((e) => e.action === 're.stop' && e.severity === 'error'));
}

function mkSignalApi(): ReSignalApi & { seriesFail: boolean; focusFail: boolean; corrFail: boolean; timers: Map<number, () => void> } {
  let id = 1;
  const api = {
    demo: false,
    seriesFail: true,
    focusFail: false,
    corrFail: true,
    timers: new Map<number, () => void>(),
    focusSet: async () => { if (api.focusFail) throw new Error('focus down'); return { targets: [] }; },
    series: async () => { if (api.seriesFail) throw new Error('invalid type: floating point 1500832321.875, expected u64'); throw new Error('unreachable'); },
    correlate: async () => { if (api.corrFail) throw new Error('[re:no_reference] nope'); throw new Error('unreachable'); },
    nowUs: () => 1_500_832_321.875,
    originUs: () => null,
    setInterval: (fn: () => void) => { const n = id; id += 1; api.timers.set(n, fn); return n; },
    clearInterval: (n: number) => { api.timers.delete(n); },
  };
  return api;
}

async function reSignalStoreTests(): Promise<void> {
  const { events, clock, log } = mkLogger();
  const api = mkSignalApi();
  api.focusFail = true;
  const st = createReSignalStore(api, log);
  await st.setTarget(T);
  check('focus_set failure logged with target', events.some((e) => e.action === 're.focus_set' && (e.details ?? '').includes('id=0x100')));
  st.addCandidate(CAND);
  st.setVisible(true);
  await tick();
  const series = events.filter((e) => e.action === 're.series');
  check('series failure logged once with args summary', series.length === 1 && series[0].severity === 'error' && (series[0].details ?? '').includes('expected u64') && (series[0].details ?? '').includes('maxPoints=1024') && (series[0].details ?? '').includes('bits=16+16@intel'), series[0]?.details ?? '');
  const poll = [...api.timers.values()][0];
  for (let i = 0; i < 25; i += 1) { clock.t += 100; poll(); await tick(); }
  check('10 Hz-style poll failures do not flood the console', events.filter((e) => e.action === 're.series').length === 1, String(events.filter((e) => e.action === 're.series').length));
  clock.t += RE_LOG_RATE_LIMIT_MS;
  poll();
  await tick();
  const after = events.filter((e) => e.action === 're.series');
  check('next log after the window shows the repeat count', after.length === 2 && after[1].title.includes('repeated'), after[1]?.title);
  st.setVisible(false);

  await st.runCorrelation(SEARCH, 5); // no reference -> client-side error
  check('correlate without reference logged', events.some((e) => e.action === 're.correlate' && (e.details ?? '').includes('no_reference')));
  st.setReference({ kind: 'obd_pid', pid: 12, bus: 0 }, 'rpm');
  await st.runCorrelation(SEARCH, 5);
  check('correlate backend failure logged with args', events.filter((e) => e.action === 're.correlate').length >= 1 && st.getState().correlation.status === 'error');

  // default (no logger) never throws
  const quiet = createReSignalStore(mkSignalApi(), NOOP_RE_LOGGER);
  await quiet.setTarget(T);
  check('noop logger store works', quiet.getState().target !== null);
}

function memStorage(init?: string): ReDisplayStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (init !== undefined) data.set(RE_DISPLAY_STORAGE_KEY, init);
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

function displayTests(): void {
  const d = DEFAULT_RE_DISPLAY;
  check('display defaults', d.showBits && d.showHex && d.showHeat && d.byteFormat === 'hex');
  check('empty storage -> defaults', JSON.stringify(loadReDisplay(memStorage())) === JSON.stringify(d) && JSON.stringify(loadReDisplay(null)) === JSON.stringify(d));
  const st = memStorage();
  saveReDisplay({ showBits: false, showHex: true, byteFormat: 'dec', showHeat: false }, st);
  const back = loadReDisplay(st);
  check('persistence round-trip', !back.showBits && back.showHex && back.byteFormat === 'dec' && !back.showHeat);
  for (const bad of ['{not json', 'null', '42', '[]', '"x"', '']) {
    check(`corrupt storage ${JSON.stringify(bad)} -> defaults`, JSON.stringify(loadReDisplay(memStorage(bad))) === JSON.stringify(d));
  }
  const partial = parseReDisplay('{"showBits":false,"showHex":"yes","byteFormat":"oct","showHeat":1}');
  check('invalid fields fall back individually', !partial.showBits && partial.showHex && partial.byteFormat === 'hex' && partial.showHeat);
  const throwing: ReDisplayStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  saveReDisplay(d, throwing);
  check('throwing storage tolerated', JSON.stringify(loadReDisplay(throwing)) === JSON.stringify(d));

  const both = reLayout({ showBits: true, showHex: true });
  const bitsOnly = reLayout({ showBits: true, showHex: false });
  const hexOnly = reLayout({ showBits: false, showHex: true });
  const none = reLayout({ showBits: false, showHex: false });
  check('neither = old compact layout', none.rowH === 20 && none.headerH === 22 && none.pitch === 10 && none.cellW === 9 && none.cellH === 14 && !none.bits && !none.hexLine && none.cellTop === 3);
  check('no hex line -> no extra height', bitsOnly.rowH === bitsOnly.cellH + 6 && none.rowH === none.cellH + 6 && !bitsOnly.hexLine);
  check('hex line adds exactly its height', both.rowH - bitsOnly.rowH === 14 && hexOnly.rowH - none.rowH === 14 && both.hexLine && hexOnly.hexLine);
  check('bits layout widens cells + header', both.pitch === 13 && both.headerH === 36 && hexOnly.headerH === 22 && hexOnly.pitch === 10);
  check('byteW = 8*pitch + gap', both.byteW === 8 * 13 + 6 && none.byteW === 8 * 10 + 6);
  check('cells always fit inside the row', [both, bitsOnly, hexOnly, none].every((l) => l.cellTop >= 0 && l.cellTop + l.cellH + (l.hexLine ? 14 : 0) <= l.rowH));
  check('byte value formats', formatByteValue(7, 'hex') === '07' && formatByteValue(255, 'hex') === 'FF' && formatByteValue(7, 'dec') === '007' && formatByteValue(255, 'dec') === '255');
}

async function displayStoreTests(): Promise<void> {
  const st = memStorage('{"showHeat":false}');
  const store = createReStore({ demo: false, start: async () => STATUS, stop: async () => STATUS, reset: async () => STATUS, setPhase: async () => STATUS, mark: async () => ({ id: 1, tsUs: 1, label: '', phase: 'free' }), markers: async () => [], subscribe: async () => () => undefined }, null, NOOP_RE_LOGGER, st);
  check('store loads persisted display', !store.getState().display.showHeat && store.getState().display.showBits);
  store.setDisplay({ byteFormat: 'dec', showBits: false });
  const s = store.getState().display;
  check('setDisplay merges + persists', s.byteFormat === 'dec' && !s.showBits && !s.showHeat && loadReDisplay(st).byteFormat === 'dec');
  check('showValues removed from filters', !('showValues' in store.getState().filters));
}

async function main(): Promise<void> {
  displayTests();
  await displayStoreTests();
  argsTests();
  loggerTests();
  await reStoreTests();
  await reSignalStoreTests();
  console.log(`re.hardening: ${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    const proc = (globalThis as { process?: { exitCode?: number } }).process;
    if (proc) proc.exitCode = 1;
  }
}
void main();
