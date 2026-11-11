/**
 * Dependency-free checks for the ECU Graph pure model.
 * Run: `npm run test:graph` (esbuild bundle -> node; throws on the first failure).
 */
import type { DiscoveredEcuDto, EcuDiscoveryResultDto } from '../../../types/udsClient';
import {
  applyDidValues,
  deserializeNodes,
  graphStorageKey,
  mergeDiscovery,
  MIN_EDGE_GAP,
  NODE_H,
  NODE_W,
  TESTER_H,
  TESTER_W,
  nextFreePosition,
  nodeDetailLine,
  nodeKey,
  nodeTitle,
  rectEdgePoint,
  relayout,
  serializeNodes,
  slotPosition,
  type GraphNode,
} from './graphModel';

function eq<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(`FAIL ${label}`);
}

function ecu(responseId: number, over: Partial<DiscoveredEcuDto> = {}): DiscoveredEcuDto {
  return {
    responseId,
    requestId: responseId - 8,
    isExtendedId: false,
    positive: true,
    nrc: null,
    nrcName: null,
    pending: false,
    raw: [0x7e, 0x00],
    multiFrame: false,
    firstResponseUs: 1200,
    responseCount: 1,
    vin: null,
    serialNumber: null,
    partNumber: null,
    identifyError: null,
    ...over,
  };
}
function scan(ecus: DiscoveredEcuDto[], isExtendedId = false): EcuDiscoveryResultDto {
  return { requestBytes: [0x3e, 0x00], functionalId: 0x7df, isExtendedId, windowMs: 300, txTimestampUs: 0, ecus, ignoredFrames: 0 };
}
function byKey(nodes: GraphNode[], key: string): GraphNode {
  const n = nodes.find((x) => x.key === key);
  if (!n) throw new Error(`FAIL missing node ${key}`);
  return n;
}

// ─── key separation ──────────────────────────────────────────────────────────
ok(nodeKey(0, false, 0x7e8) !== nodeKey(0, true, 0x7e8), 'key: 11/29-bit separated');
ok(nodeKey(0, false, 0x7e8) !== nodeKey(1, false, 0x7e8), 'key: bus separated');
eq(nodeKey(2, true, 255), '2:x:255', 'key format');

// ─── merge: new nodes, deterministic order ───────────────────────────────────
const nodes = mergeDiscovery([], scan([ecu(0x7ef), ecu(0x7e8), ecu(0x7e9)]), 0, 1000);
eq(nodes.map((n) => n.responseId), [0x7e8, 0x7e9, 0x7ef], 'merge: new nodes ordered by responseId');
eq(nodes[0].pos, slotPosition(0), 'merge: first node takes slot 0');
eq(nodes[1].pos, slotPosition(1), 'merge: second node takes slot 1');
eq(nodes[2].pos, slotPosition(2), 'merge: third node takes slot 2');
ok(nodes.every((n) => n.lastScanSeen && !n.pinned && n.firstSeenMs === 1000), 'merge: new nodes flags');
const again = mergeDiscovery([], scan([ecu(0x7e9), ecu(0x7ef), ecu(0x7e8)]), 0, 1000);
eq(again.map((n) => n.pos), nodes.map((n) => n.pos), 'layout deterministic regardless of response order');

// first slots spread: 2nd node opposite the 1st
const p0 = slotPosition(0);
const p1 = slotPosition(1);
eq({ x: p0.x + p1.x, y: p0.y + p1.y }, { x: 0, y: 0 }, 'slot 1 is opposite slot 0');
ok(slotPosition(8).x !== slotPosition(0).x || slotPosition(8).y !== slotPosition(0).y, 'ring 1 differs from ring 0');
ok(Math.hypot(slotPosition(8).x, slotPosition(8).y) > Math.hypot(p0.x, p0.y), 'radius grows with ring');

// ─── merge: seen / not seen / never auto-remove ──────────────────────────────
const second = mergeDiscovery(nodes, scan([ecu(0x7e8, { firstResponseUs: 900 }), ecu(0x7ed)]), 0, 2000);
eq(second.length, 4, 'merge: nothing removed, one added');
const n8 = byKey(second, nodeKey(0, false, 0x7e8));
eq([n8.lastScanSeen, n8.lastSeenMs, n8.firstSeenMs, n8.firstResponseUs], [true, 2000, 1000, 900], 'merge: seen node refreshed');
const n9 = byKey(second, nodeKey(0, false, 0x7e9));
eq([n9.lastScanSeen, n9.lastSeenMs], [false, 1000], 'merge: unseen node kept, flagged not seen');
eq(byKey(second, nodeKey(0, false, 0x7ed)).pos, slotPosition(3), 'merge: new node takes next free slot');
const empty = mergeDiscovery(second, scan([]), 0, 3000);
eq(empty.length, 4, 'merge: empty scan removes nothing');
ok(empty.every((n) => !n.lastScanSeen), 'merge: empty scan marks all not seen');
const back = mergeDiscovery(empty, scan([ecu(0x7e9)]), 0, 4000);
eq(byKey(back, nodeKey(0, false, 0x7e9)).lastScanSeen, true, 'merge: node can reappear');

// scan of 11-bit must not mark 29-bit nodes (or other buses) as unseen
let mixed = mergeDiscovery([], scan([ecu(0x18daf100, { isExtendedId: true, requestId: 0x18da00f1 })], true), 0, 1000);
mixed = mergeDiscovery(mixed, scan([ecu(0x7e8)]), 0, 2000);
eq(byKey(mixed, nodeKey(0, true, 0x18daf100)).lastScanSeen, true, 'merge: other addressing mode untouched');
mixed = mergeDiscovery(mixed, scan([ecu(0x7e8)]), 1, 3000);
eq(byKey(mixed, nodeKey(0, false, 0x7e8)).lastScanSeen, true, 'merge: other bus scan does not touch bus-0 node');
eq(mixed.length, 3, 'merge: same responseId on different bus is a separate node');
const sameId = mergeDiscovery(
  mergeDiscovery([], scan([ecu(0x7e8)]), 0, 1),
  scan([ecu(0x7e8, { isExtendedId: true })], true),
  0,
  2,
);
eq(sameId.length, 2, 'merge: 11-bit and 29-bit with the same numeric id are separate nodes');

// ─── identity: null never wipes, DID reads kept across scans ─────────────────
let idn = mergeDiscovery([], scan([ecu(0x7e8, { partNumber: 'PN-1', vin: 'VIN123' })]), 0, 1);
idn = idn.map((n) => applyDidValues(n, [{ did: 0xf197, text: 'BMS_MASTER' }, { did: 0xf189, text: '1.2.3' }]));
idn = mergeDiscovery(idn, scan([ecu(0x7e8, { partNumber: null, vin: null })]), 0, 2);
eq([idn[0].identity.partNumber, idn[0].identity.vin], ['PN-1', 'VIN123'], 'identity: null discovery fields keep old values');
eq([idn[0].identity.systemName, idn[0].identity.swVersion], ['BMS_MASTER', '1.2.3'], 'identity: DID-read fields survive a scan');
eq(nodeTitle(idn[0]), 'BMS_MASTER', 'title: systemName first');
eq(nodeTitle(mergeDiscovery([], scan([ecu(0x7e8, { partNumber: 'PN-9' })]), 0, 1)[0]), 'PN-9', 'title: partNumber second');
eq(nodeTitle(mergeDiscovery([], scan([ecu(0x7e8)]), 0, 1)[0]), 'ECU 0x7E8', 'title: fallback');
eq(idn[0].dids.map((d) => d.did), [0xf189, 0xf197], 'dids sorted');

// ─── pinned positions stable across scans / relayout ─────────────────────────
let pin = mergeDiscovery([], scan([ecu(0x7e8), ecu(0x7e9)]), 0, 1);
pin = pin.map((n) => (n.responseId === 0x7e8 ? { ...n, pos: { x: 12, y: 34 }, pinned: true } : n));
const pinAfter = mergeDiscovery(pin, scan([ecu(0x7e8), ecu(0x7e9), ecu(0x7ea)]), 0, 2);
eq(byKey(pinAfter, nodeKey(0, false, 0x7e8)).pos, { x: 12, y: 34 }, 'pinned: stable across scan');
eq(byKey(pinAfter, nodeKey(0, false, 0x7e9)).pos, pin[1].pos, 'unpinned existing node does not move on scan');
// slot 0 was vacated by the dragged node, so the new node may take it
eq(byKey(pinAfter, nodeKey(0, false, 0x7ea)).pos, slotPosition(0), 'new node takes the vacated lowest free slot');

const rel = relayout(pinAfter, false);
eq(byKey(rel, nodeKey(0, false, 0x7e8)).pos, { x: 12, y: 34 }, 'relayout(unpinned): pinned stays');
const relAll = relayout(pinAfter, true);
ok(relAll.every((n) => !n.pinned), 'relayout(all): clears pinned');
eq(relAll.map((n) => n.pos), [slotPosition(0), slotPosition(1), slotPosition(2)], 'relayout(all): sequential slots by id');
eq(relayout(relAll, true).map((n) => n.pos), relAll.map((n) => n.pos), 'relayout idempotent');
const unique = new Set(
  Array.from({ length: 56 }, (_, i) => `${slotPosition(i).x},${slotPosition(i).y}`),
);
eq(unique.size, 56, 'slots 0..55 are all distinct');
eq(nextFreePosition([slotPosition(0), slotPosition(1)]), slotPosition(2), 'nextFreePosition skips occupied');

// ─── geometry ────────────────────────────────────────────────────────────────
eq(rectEdgePoint(0, 0, 100, 50, 400, 0), { x: 100, y: 0 }, 'edge point horizontal');
eq(rectEdgePoint(0, 0, 100, 50, 0, -400), { x: 0, y: -50 }, 'edge point vertical');
eq(rectEdgePoint(0, 0, 100, 50, 200, 200), { x: 50, y: 50 }, 'edge point diagonal hits top/bottom first');

// visible edge length (card border to card border) is >= MIN_EDGE_GAP in every direction
for (let i = 0; i < 56; i++) {
  const p = slotPosition(i);
  const a = rectEdgePoint(0, 0, TESTER_W / 2, TESTER_H / 2, p.x, p.y);
  const b = rectEdgePoint(p.x, p.y, NODE_W / 2, NODE_H / 2, 0, 0);
  ok(Math.hypot(b.x - a.x, b.y - a.y) >= MIN_EDGE_GAP - 2, `slot ${i}: visible edge gap >= ${MIN_EDGE_GAP - 2}`);
}

// ─── card detail line never duplicates the title ─────────────────────────────
const dn = (over: Partial<GraphNode['identity']>): GraphNode => {
  const n = mergeDiscovery([], scan([ecu(0x7e8)]), 0, 1)[0];
  return { ...n, identity: { ...n.identity, ...over } };
};
eq(nodeDetailLine(dn({})), null, 'detail: nothing known -> null');
eq(nodeDetailLine(dn({ serialNumber: 'S1' })), 'S/N S1', 'detail: serial when no part');
eq(nodeDetailLine(dn({ partNumber: 'PN-1', systemName: 'BMS' })), 'PN-1', 'detail: part when title is systemName');
eq(nodeDetailLine(dn({ partNumber: 'PN-1', swVersion: '2.0' })), 'SW 2.0', 'detail: title==part -> sw only');
eq(nodeDetailLine(dn({ partNumber: 'PN-1', swVersion: '2.0', systemName: 'BMS' })), 'PN-1 · SW 2.0', 'detail: part + sw');
eq(nodeDetailLine(dn({ partNumber: 'PN-1', serialNumber: 'SN9' })), 'S/N SN9', 'detail: title==part -> serial');
eq(nodeDetailLine(dn({ partNumber: 'PN-1', swNumber: 'SWN' })), 'SW SWN', 'detail: title==part -> sw');

// ─── persistence ─────────────────────────────────────────────────────────────
const stored = serializeNodes(pinAfter);
const loaded = deserializeNodes(stored, 0);
eq(loaded, pinAfter, 'persistence: round-trip');
eq(deserializeNodes(null, 0), [], 'persistence: null');
eq(deserializeNodes('{not json', 0), [], 'persistence: corrupt json');
eq(deserializeNodes('{"version":99,"nodes":[]}', 0), [], 'persistence: wrong version');
eq(deserializeNodes('{"version":1,"nodes":[1,"x",{"responseId":"a"},{"responseId":5,"isExtendedId":false}]}', 3).length, 1, 'persistence: malformed entries skipped');
ok(graphStorageKey(true, 0) !== graphStorageKey(false, 0), 'persistence: demo and real keys differ');
ok(graphStorageKey(false, 0) !== graphStorageKey(false, 1), 'persistence: per-bus keys');

console.log('graphModel: all checks passed');
