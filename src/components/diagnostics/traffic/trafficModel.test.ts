/**
 * Dependency-free checks for the Traffic Dock pure logic (join, interleave, filters, timing).
 * Run: `npm run test:traffic` (esbuild bundle -> node; throws on the first failure).
 */
import type {
  ConversationEventDto,
  ConversationEventKind,
  DiagOrigin,
  IsoTpFrameDto,
  UdsAddressing,
} from '../../../types/udsClient';
import { normalizeConversationEvent, normalizeIsoTpFrame } from '../../../types/udsClient';
import type { IsoTpFrameEntry, IsoTpFrameType } from '../../../types/diagnostics';
import {
  buildRows,
  compareTimeline,
  TrafficModel,
  type DockRow,
  type TrafficConversationEntry,
  type TrafficSnapshot,
} from './trafficModel';
import { DEFAULT_FILTERS, compileFilters, hexNeedle, parseSidFilter } from './trafficFilters';
import { analyzeTiming } from './trafficTiming';

function eq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

let uid = 0;
function ev(
  kind: ConversationEventKind,
  seq: number,
  ts: number,
  over: Partial<ConversationEventDto> = {},
  epoch = 0,
): TrafficConversationEntry {
  const event: ConversationEventDto = {
    seq,
    timestampUs: ts,
    kind,
    addressing: 'physical' as UdsAddressing,
    sid: null,
    bytes: [],
    requestSeq: null,
    elapsedUs: null,
    nrc: null,
    detail: null,
    origin: 'console' as DiagOrigin,
    ...over,
  };
  return { uid: ++uid, epoch, event, note: null };
}

const TYPE_BY_KIND: Record<string, IsoTpFrameType> = { single: 'SF', first: 'FF', consecutive: 'CF', flowControl: 'FC' };
function fr(
  seq: number,
  ts: number,
  dir: 'tx' | 'rx',
  kind: 'single' | 'first' | 'consecutive' | 'flowControl',
  requestSeq: number | null,
  data: number[] = [0x02, 0x3e, 0x00, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa],
  epoch = 0,
): IsoTpFrameEntry {
  const id = ++uid;
  return {
    id: `tp-${id}`,
    uid: id,
    seq,
    epoch,
    requestSeq,
    timestampMs: Math.floor(ts / 1000),
    timestampUs: ts,
    canId: dir === 'tx' ? 0x7e0 : 0x7e8,
    isExtended: false,
    frameType: TYPE_BY_KIND[kind],
    rawBytes: data,
    description: kind,
    direction: dir,
  };
}

const none = new Set<string>();
const all = compileFilters(DEFAULT_FILTERS);

// ── Join: request + pending + final response; frames attach by requestSeq ──────────────────────
{
  const conv = [
    ev('request', 1, 1000, { sid: 0x31, bytes: [0x31, 0x01, 0xff, 0x00], origin: 'console' }),
    ev('response_pending', 2, 5000, { requestSeq: 1, nrc: 0x78 }),
    ev('response_pending', 3, 9000, { requestSeq: 1, nrc: 0x78 }),
    ev('response', 4, 20_000, { requestSeq: 1, sid: 0x71, bytes: [0x71, 0x01, 0xff, 0x00], elapsedUs: 19_000 }),
  ];
  const frames = [fr(1, 1100, 'tx', 'single', 1), fr(2, 4900, 'rx', 'single', 1), fr(3, 19_900, 'rx', 'single', 1)];
  const snap = new TrafficModel().update(conv, frames);
  eq(snap.txs.length, 1, 'one transaction');
  const tx = snap.txs[0];
  eq(tx.pendingCount, 2, 'pending count');
  eq(tx.status, 'ok', 'final status');
  eq(tx.elapsedUs, 19_000, 'elapsed from backend');
  eq(tx.frames.length, 3, 'frames joined');
  eq(tx.firstPendingUs, 5000, 'first pending ts');
  eq(snap.counters.total, 1, 'counter total');
  eq(snap.counters.frames, 3, 'counter frames');
}

// ── Pending (no final) and timeout ─────────────────────────────────────────────────────────────
{
  const conv = [
    ev('request', 1, 1000, { sid: 0x22, bytes: [0x22, 0xf1, 0x90] }),
    ev('request', 2, 2000, { sid: 0x10, bytes: [0x10, 0x03] }),
    ev('timeout', 3, 3_000_000, { requestSeq: 2, elapsedUs: 2_998_000 }),
  ];
  const snap = new TrafficModel().update(conv, []);
  eq(snap.txs[0].status, 'pending', 'no final -> pending');
  eq(snap.txs[1].status, 'timeout', 'timeout final');
  eq(snap.counters.timeout, 1, 'timeout counter');
  eq(snap.counters.pending, 1, 'pending counter');
  eq(snap.counters.errors, 1, 'error counter');
}

// ── NRC response, suppressed, keepalive, orphan tx_blocked / late final ────────────────────────
{
  const conv = [
    ev('request', 1, 1000, { sid: 0x22, bytes: [0x22, 0xf1, 0x90] }),
    ev('response', 2, 2000, { requestSeq: 1, nrc: 0x31, bytes: [0x7f, 0x22, 0x31] }),
    ev('request', 3, 3000, { sid: 0x3e, bytes: [0x3e, 0x80] }),
    ev('response', 4, 3100, { requestSeq: 3, bytes: [] }),
    ev('keepalive_sent', 5, 4000, { sid: 0x3e, bytes: [0x3e, 0x80], origin: 'keepalive' }),
    ev('tx_blocked', 6, 5000, { sid: 0x10, detail: 'listen-only' }),
    ev('response', 7, 6000, { requestSeq: 99, bytes: [0x62, 0xf1, 0x90, 0x41] }), // request evicted
    ev('response', 8, 7000, { requestSeq: 1, bytes: [0x62] }), // duplicate final: standalone
  ];
  const snap = new TrafficModel().update(conv, []);
  eq(snap.txs.map((t) => t.status).join(','), 'nrc,suppressed,keepalive,tx_blocked,ok,ok', 'statuses');
  eq(snap.txs[2].origin, 'keepalive', 'keepalive origin');
  eq(snap.txs[3].request, null, 'orphan has no request');
  eq(snap.counters.nrc, 1, 'nrc counter');
  eq(snap.counters.errors, 2, 'nrc + tx_blocked are errors');
}

// ── Failed exchange without a Request: frames tagged with the error event's own seq ──────────────
{
  const model = new TrafficModel();
  // Late frames: the frame page arrives one poll AFTER the event.
  const conv = [
    ev('tx_blocked', 5, 5000, { sid: 0x10, origin: 'session', detail: 'listen-only' }),
    ev('timeout', 6, 9000, { sid: 0x22, origin: 'did' }),
    ev('transport_error', 7, 9500, { sid: 0x19, origin: 'dtc' }),
  ];
  const s1 = model.update(conv, []);
  eq(s1.txs.length, 3, 'each failed exchange is its own row');
  eq(s1.txs[0].request, null, 'no Request event');
  const frames = [fr(1, 4900, 'tx', 'first', 5), fr(2, 8000, 'tx', 'single', 6), fr(3, 9400, 'tx', 'single', 7)];
  const s2 = model.update(conv, frames);
  eq(s2.txs[0].frames.length, 1, 'late frame attached to tx_blocked row');
  eq(s2.txs[1].frames.length, 1, 'late frame attached to timeout row');
  eq(s2.txs[2].frames.length, 1, 'late frame attached to transport_error row');
  eq(s2.txs.map((t) => t.status).join(','), 'tx_blocked,timeout,transport_error', 'failed statuses');
  const rows = buildRows(s2, 'frames', compileFilters(DEFAULT_FILTERS), none);
  eq(rows.every((r) => r.type === 'frame' && !r.unmatched && r.tx !== undefined), true, 'not shown as unmatched');
  // Frames BEFORE the event (same poll, frames ingested first by another consumer order).
  const m2 = new TrafficModel();
  const early = fr(1, 100, 'tx', 'single', 3);
  m2.update([], [early]);
  const s3 = m2.update([ev('timeout', 3, 200, { sid: 0x22 })], [early]);
  eq(s3.txs[0].frames.length, 1, 'early frame attached when error event arrives');
}

// ── Keepalive: one row with its 3E 80 frames (frames arrive a poll later) ──────────────────────
{
  const model = new TrafficModel();
  const conv = [ev('keepalive_sent', 1, 1000, { sid: 0x3e, bytes: [0x3e, 0x80], origin: 'keepalive' })];
  const s1 = model.update(conv, []);
  eq(s1.txs.length, 1, 'keepalive row');
  eq(s1.txs[0].status, 'keepalive', 'keepalive status');
  eq(s1.txs[0].origin, 'keepalive', 'keepalive origin');
  const s2 = model.update(conv, [fr(1, 1100, 'tx', 'single', 1, [0x02, 0x3e, 0x80, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa])]);
  eq(s2.txs[0].frames.length, 1, 'late 3E 80 frame attached');
  eq(s2.counters.unmatchedFrames, 0, 'keepalive frame not unmatched');
}

// ── Epochs: same seq in two backend sessions never joins across the epoch ──────────────────────
{
  const conv = [
    ev('request', 1, 1000, { sid: 0x22, bytes: [0x22, 0xf1, 0x90] }, 0),
    ev('request', 1, 9000, { sid: 0x10, bytes: [0x10, 0x01] }, 1),
    ev('response', 2, 9500, { requestSeq: 1, bytes: [0x50, 0x01] }, 1),
  ];
  const frames = [fr(1, 1100, 'tx', 'single', 1, undefined, 0), fr(1, 9100, 'tx', 'single', 1, undefined, 1)];
  const snap = new TrafficModel().update(conv, frames);
  eq(snap.txs.length, 2, 'two epochs, two transactions');
  eq(snap.txs[0].status, 'pending', 'epoch 0 tx unaffected by epoch 1 response');
  eq(snap.txs[1].status, 'ok', 'epoch 1 tx completed');
  eq(snap.txs[0].frames.length, 1, 'epoch 0 frame');
  eq(snap.txs[1].frames.length, 1, 'epoch 1 frame');
}

// ── Incremental: frame arriving before its request is attached later; immutability for freeze ──
{
  const model = new TrafficModel();
  const convA = [ev('request', 1, 1000, { sid: 0x22, bytes: [0x22, 0xf1, 0x90] })];
  const s1 = model.update(convA, []);
  eq(s1.txs[0].status, 'pending', 'incremental: pending first');
  const convB = [...convA, ev('response', 2, 2000, { requestSeq: 1, bytes: [0x62, 0xf1, 0x90, 0x41] })];
  const early = fr(1, 2500, 'tx', 'single', 7); // frame of a request not ingested yet
  const s2 = model.update(convB, [early]);
  eq(s1.txs[0].status, 'pending', 'frozen snapshot not mutated');
  eq(s2.txs[0].status, 'ok', 'incremental: completed');
  eq(s2.counters.unmatchedFrames, 0, 'requestSeq non-null is not unmatched');
  const convC = [...convB, ev('request', 7, 2400, { sid: 0x3e, bytes: [0x3e, 0x00] })];
  const s3 = model.update(convC, [early]);
  eq(s3.txs[1].frames.length, 1, 'orphan frame attached when its request arrives');
  eq(model.update(convC, [early]) === s3, true, 'no change -> same snapshot object');
}

// ── Eviction (front trim) and clear ────────────────────────────────────────────────────────────
{
  const model = new TrafficModel();
  const conv = [
    ev('request', 1, 1000, { sid: 0x22, bytes: [0x22, 0xf1, 0x90] }),
    ev('response', 2, 2000, { requestSeq: 1, bytes: [0x62, 0xf1, 0x90, 0x41] }),
    ev('request', 3, 3000, { sid: 0x10, bytes: [0x10, 0x01] }),
  ];
  const frames = [fr(1, 1100, 'tx', 'single', 1), fr(2, 3100, 'tx', 'single', 3)];
  model.update(conv, frames);
  const s = model.update(conv.slice(2), frames.slice(1)); // cap trimmed the first two events + first frame
  eq(s.txs.length, 1, 'evicted transaction removed');
  eq(s.txs[0].seq, 3, 'remaining transaction');
  eq(s.timeline.length, 2, 'timeline trimmed (1 event + 1 frame)');
  const cleared = model.update([], []);
  eq(cleared.txs.length, 0, 'clear: no transactions');
  eq(cleared.timeline.length, 0, 'clear: empty timeline');
  const again = model.update([ev('request', 1, 9000, { sid: 0x10, bytes: [0x10, 0x01] })], []);
  eq(again.txs.length, 1, 'after clear: new data flows');
}

// ── Interleave ordering: ts, then request < frame < completing event, then seq ─────────────────
{
  const conv = [
    ev('request', 1, 1000, { sid: 0x22, bytes: [0x22, 0xf1, 0x90] }),
    ev('response', 2, 2000, { requestSeq: 1, bytes: [0x62, 0xf1, 0x90, 0x41] }),
  ];
  const frames = [
    fr(1, 1000, 'tx', 'single', 1), // same ts as the request -> after it
    fr(2, 2000, 'rx', 'single', 1), // same ts as the response -> before it
    fr(3, 1500, 'rx', 'single', null), // unmatched, between
  ];
  const snap = new TrafficModel().update(conv, frames);
  const rows = buildRows(snap, 'interleaved', all, none);
  eq(
    rows.map((r) => (r.type === 'event' ? `E${r.item.event.seq}` : r.type === 'frame' ? `F${r.frame.seq}` : '?')).join(' '),
    'E1 F1 F3 F2 E2',
    'interleave order',
  );
  const unmatched = rows.filter((r): r is Extract<DockRow, { type: 'frame' }> => r.type === 'frame' && r.unmatched);
  eq(unmatched.length, 1, 'one unmatched frame');
  eq(unmatched[0].frame.seq, 3, 'unmatched frame is the null-requestSeq one');
  const a = snap.timeline[0];
  const b = snap.timeline[1];
  eq(compareTimeline(a, b) < 0, true, 'compareTimeline');
}

// ── Late (out-of-order) timeline insert keeps order ────────────────────────────────────────────
{
  const model = new TrafficModel();
  const c1 = [ev('request', 1, 1000, { sid: 0x22, bytes: [0x22, 0xf1, 0x90] }), ev('response', 2, 5000, { requestSeq: 1, bytes: [0x62] })];
  model.update(c1, []);
  const late = fr(1, 3000, 'rx', 'single', 1);
  const snap = model.update(c1, [late]);
  eq(snap.timeline.map((t) => t.kind).join(','), 'event,frame,event', 'late frame inserted by timestamp');
}

// ── Transactions rows: expansion + notes ───────────────────────────────────────────────────────
{
  const conv: TrafficConversationEntry[] = [
    ev('request', 1, 1000, { sid: 0x22, bytes: [0x22, 0xf1, 0x90] }),
    { uid: ++uid, epoch: 1, event: null, note: 'reopened' },
    ev('request', 1, 9000, { sid: 0x10, bytes: [0x10, 0x01] }, 1),
  ];
  const frames = [fr(1, 1100, 'tx', 'single', 1), fr(2, 1200, 'rx', 'single', 1)];
  const snap = new TrafficModel().update(conv, frames);
  const open = buildRows(snap, 'transactions', all, new Set([snap.txs[0].key]));
  eq(open.map((r) => r.type).join(','), 'tx,txFrame,txFrame,note,tx', 'expanded tx rows + note');
  const collapsed = buildRows(snap, 'transactions', all, none);
  eq(collapsed.map((r) => r.type).join(','), 'tx,note,tx', 'collapsed rows');
  const dt = open[1].type === 'txFrame' ? open[1].dtUs : -1;
  eq(dt, 100, 'child delta from request');
}

// ── Row order: newest first ────────────────────────────────────────────────────────────────────
{
  const conv: TrafficConversationEntry[] = [
    ev('request', 1, 1000, { sid: 0x22, bytes: [0x22, 0xf1, 0x90] }),
    { uid: ++uid, epoch: 1, event: null, note: 'reopened' },
    ev('request', 1, 9000, { sid: 0x10, bytes: [0x10, 0x01] }, 1),
    ev('request', 2, 9500, { sid: 0x3e, bytes: [0x3e, 0x00] }, 1),
  ];
  const frames = [
    fr(1, 1100, 'tx', 'first', 1),
    fr(1, 1200, 'rx', 'flowControl', 1),
    fr(1, 1300, 'tx', 'consecutive', 1),
  ];
  const snap = new TrafficModel().update(conv, frames);
  const open = new Set([snap.txs[0].key]);
  const types = (rows: DockRow[]) => rows.map((r) => r.type).join(',');
  const old = buildRows(snap, 'transactions', all, open, 'oldestFirst');
  eq(types(old), 'tx,txFrame,txFrame,txFrame,note,tx,tx', 'oldestFirst unchanged');
  const neu = buildRows(snap, 'transactions', all, open, 'newestFirst');
  eq(types(neu), 'tx,tx,note,tx,txFrame,txFrame,txFrame', 'newestFirst: txs reversed, children kept, note between epochs');
  eq(neu.map((r) => r.key).join('|'), [...old].reverse().filter((r) => r.type !== 'txFrame').map((r) => r.key).slice(0, 3).join('|') + '|' + neu.slice(3).map((r) => r.key).join('|'), 'newestFirst keys');
  const kids = neu.filter((r) => r.type === 'txFrame').map((r) => (r.type === 'txFrame' ? r.frame.frameType : ''));
  eq(kids.join(','), 'FF,FC,CF', 'child frames chronological');
  eq(neu[3].type === 'tx' && neu[3].expanded, true, 'parent row directly above its children');
  eq(buildRows(snap, 'transactions', all, none, 'newestFirst').map((r) => r.type).join(','), 'tx,tx,note,tx', 'collapsed newestFirst');

  const il = buildRows(snap, 'interleaved', all, none, 'oldestFirst');
  const ilN = buildRows(snap, 'interleaved', all, none, 'newestFirst');
  eq(ilN.map((r) => r.key).join('|'), [...il].reverse().map((r) => r.key).join('|'), 'interleaved reversed');
  const fo = buildRows(snap, 'frames', all, none, 'oldestFirst');
  const foN = buildRows(snap, 'frames', all, none, 'newestFirst');
  eq(foN.map((r) => r.key).join('|'), [...fo].reverse().map((r) => r.key).join('|'), 'frames reversed');
  eq(buildRows(snap, 'frames', all, none).map((r) => r.key).join('|'), fo.map((r) => r.key).join('|'), 'default order = oldestFirst');
}

// ── Filters ────────────────────────────────────────────────────────────────────────────────────
{
  const conv = [
    ev('request', 1, 1000, { sid: 0x22, bytes: [0x22, 0xf1, 0x90], origin: 'did' }),
    ev('response', 2, 2000, { requestSeq: 1, sid: 0x62, bytes: [0x62, 0xf1, 0x90, 0x41, 0x42], origin: 'did' }),
    ev('request', 3, 3000, { sid: 0x01, bytes: [0x01, 0x0c], origin: 'pids' }),
    ev('response', 4, 3500, { requestSeq: 3, nrc: 0x12, bytes: [0x7f, 0x01, 0x12], origin: 'pids' }),
    ev('request', 5, 4000, { sid: 0x10, bytes: [0x10, 0x03], origin: 'session' }),
    ev('timeout', 6, 9000, { requestSeq: 5, origin: 'session' }),
  ];
  const frames = [
    fr(1, 1100, 'tx', 'single', 1),
    fr(2, 3100, 'tx', 'single', 3),
    fr(3, 4100, 'tx', 'single', 5),
    fr(4, 5000, 'rx', 'single', null),
  ];
  const snap = new TrafficModel().update(conv, frames);
  const count = (mode: 'transactions' | 'interleaved' | 'frames', f: Partial<typeof DEFAULT_FILTERS>): number =>
    buildRows(snap, mode, compileFilters({ ...DEFAULT_FILTERS, ...f }), none).length;

  eq(count('transactions', {}), 3, 'defaults: all on');
  eq(count('transactions', { origins: DEFAULT_FILTERS.origins.filter((o) => o !== 'pids') }), 2, 'origin off hides pids tx');
  eq(count('frames', { origins: DEFAULT_FILTERS.origins.filter((o) => o !== 'pids') }), 3, 'origin off hides its frames, keeps unmatched');
  eq(count('transactions', { errorsOnly: true }), 2, 'errors only: nrc + timeout');
  eq(count('frames', { errorsOnly: true }), 2, 'errors only frames: unmatched hidden');
  eq(count('interleaved', { errorsOnly: true }), 4, 'errors only interleaved: nrc + timeout events, 2 error-tx frames');
  eq(count('transactions', { sid: '22' }), 1, 'SID filter');
  eq(count('transactions', { sid: '0x10' }), 1, 'SID filter 0x prefix');
  eq(count('frames', { sid: '22' }), 1, 'SID filter on frames (unmatched hidden)');
  eq(count('transactions', { sid: 'zz' }), 0, 'invalid SID matches nothing');
  eq(count('transactions', { search: 'F1 90' }), 1, 'hex search spaced');
  eq(count('transactions', { search: '0x7F0112' }), 1, 'hex search across response');
  eq(count('transactions', { search: 'timeout' }), 1, 'text search status');
  eq(count('transactions', { search: 'serviceNotSupported' }), 0, 'NRC 0x12 is subFunctionNotSupported');
  eq(count('transactions', { search: 'subfunctionnotsupported' }), 1, 'NRC name text search (case-insens.)');
  eq(parseSidFilter(' 0x3E '), 0x3e, 'parseSidFilter');
  eq(parseSidFilter(''), null, 'parseSidFilter empty');
  eq(hexNeedle('de ad,0xbe'), 'DEADBE', 'hexNeedle');
  eq(hexNeedle('hello'), null, 'hexNeedle text');
  eq(compileFilters(DEFAULT_FILTERS).passthrough, true, 'defaults passthrough');
}

// ── Timing: P2 vs limit, STmin vs CF gap ───────────────────────────────────────────────────────
{
  const conv = [
    ev('request', 1, 1000, { sid: 0x22, bytes: [0x22, 0xf1, 0x90] }),
    ev('response', 2, 400_000, { requestSeq: 1, bytes: [0x62, 0xf1, 0x90, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }),
  ];
  const frames = [
    fr(1, 1100, 'tx', 'single', 1),
    fr(2, 200_000, 'rx', 'first', 1, [0x10, 0x0d, 0x62, 0xf1, 0x90, 1, 2, 3]),
    fr(3, 200_300, 'tx', 'flowControl', 1, [0x30, 0x00, 0x02, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa]), // STmin 2 ms
    fr(4, 202_500, 'rx', 'consecutive', 1, [0x21, 4, 5, 6, 7, 8, 9, 10]),
    fr(5, 203_000, 'rx', 'consecutive', 1, [0x22, 11, 12, 13, 14, 15, 16, 17]), // 0.5 ms gap < 2 ms
  ];
  const snap: TrafficSnapshot = new TrafficModel().update(conv, frames);
  const tx = snap.txs[0];
  const t = analyzeTiming(tx, 50, 100); // limit 150 ms, measured ~199 ms
  eq(t.p2Source, 'frames', 'P2 from frames');
  eq(t.p2MeasuredUs, 198_900, 'P2 measured');
  eq(t.p2LimitUs, 150_000, 'P2 limit');
  eq(t.p2Violation, true, 'P2 violation');
  eq(t.multiFrame, true, 'multi-frame');
  eq(t.flowControls.length, 1, 'one FC');
  eq(t.flowControls[0].stMinUs, 2000, 'STmin 2 ms');
  eq(t.flowControls[0].bs, 0, 'BS');
  eq(t.minCfGapUs, 500, 'min CF gap');
  eq(t.stMinViolation, true, 'CF gap < STmin flagged');
  const unknown = analyzeTiming(tx, null, 100);
  eq(unknown.p2LimitUs, null, 'P2 unknown: no limit');
  eq(unknown.p2Violation, false, 'P2 unknown: no verdict');

  const ok = analyzeTiming(
    new TrafficModel().update(conv, [frames[0], frames[1], frames[2], frames[3]]).txs[0],
    300,
    100,
  );
  eq(ok.stMinViolation, false, 'single CF: no gap, no violation');
  eq(ok.p2Violation, false, 'within P2');
}

// ── Event-only timing fallback ─────────────────────────────────────────────────────────────────
{
  const conv = [
    ev('request', 1, 1000, { sid: 0x10, bytes: [0x10, 0x03] }),
    ev('response_pending', 2, 60_000, { requestSeq: 1, nrc: 0x78 }),
    ev('response', 3, 90_000, { requestSeq: 1, bytes: [0x50, 0x03] }),
  ];
  const tx = new TrafficModel().update(conv, []).txs[0];
  const t = analyzeTiming(tx, 50, 100);
  eq(t.p2Source, 'events', 'events fallback');
  eq(t.p2MeasuredUs, 59_000, 'first answer = pending');
  eq(t.p2Violation, false, '59 ms <= 150 ms');
}

// ── Normalizers (old backend without origin / requestSeq) ──────────────────────────────────────
{
  const legacyEvent = JSON.parse('{"seq":1,"timestampUs":1,"kind":"request","addressing":"physical","sid":1,"bytes":[1],"requestSeq":null,"elapsedUs":null,"nrc":null,"detail":null}') as ConversationEventDto;
  eq(normalizeConversationEvent(legacyEvent).origin, 'other', 'missing origin -> other');
  const bogus = JSON.parse('{"seq":1,"timestampUs":1,"kind":"request","addressing":"physical","sid":1,"bytes":[1],"requestSeq":null,"elapsedUs":null,"nrc":null,"detail":null,"origin":"nonsense"}') as ConversationEventDto;
  eq(normalizeConversationEvent(bogus).origin, 'other', 'unknown origin -> other');
  const legacyFrame = JSON.parse('{"seq":1,"timestampUs":1,"canId":1,"isExtended":false,"direction":"tx","fd":false,"data":[2],"kind":"single"}') as IsoTpFrameDto;
  eq(normalizeIsoTpFrame(legacyFrame).requestSeq, null, 'missing requestSeq -> null');
}

console.log('traffic tests passed');
