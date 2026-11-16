/**
 * ECU Graph pure model: node identity, discovery merge, deterministic radial layout, geometry helpers
 * and persistence (de)serialisation. No React, no DOM, no store access, so it is unit-testable with the
 * dependency-free runner (`npm run test:graph`).
 *
 * Invariants:
 *  - nodes are NEVER removed by a scan (only by explicit user actions);
 *  - existing nodes never move on a scan (positions are assigned once, when a node is first seen);
 *  - the layout is deterministic: new nodes are ordered by (extended, responseId) and take the
 *    lowest-index free slot of a fixed ring scheme.
 */
import type { UdsSessionType } from '../../../types/diagnostics';
import type { DiscoveredEcuDto, EcuDiscoveryResultDto } from '../../../types/udsClient';

export interface GraphPos {
  x: number;
  y: number;
}

export interface GraphIdentity {
  vin: string | null;
  serialNumber: string | null;
  partNumber: string | null;
  systemName: string | null;
  swNumber: string | null;
  swVersion: string | null;
  hwNumber: string | null;
}

export interface GraphDidValue {
  did: number;
  text: string;
}

export interface GraphNode {
  key: string;
  busId: number;
  isExtendedId: boolean;
  responseId: number;
  requestId: number | null;
  firstSeenMs: number;
  lastSeenMs: number;
  /** Answered the last scan that covered this node's bus + addressing mode. */
  lastScanSeen: boolean;
  positive: boolean;
  nrc: number | null;
  nrcName: string | null;
  pending: boolean;
  firstResponseUs: number;
  /** Raw discovery response (service id + data) of the last scan that saw this node. */
  raw: number[];
  identifyError: string | null;
  identity: GraphIdentity;
  /** Identification DIDs (F186..F19F) read through a live session; sorted by DID. */
  dids: GraphDidValue[];
  dtcCount: number | null;
  lastSession: UdsSessionType | null;
  pos: GraphPos;
  /** User moved the node: never repositioned automatically. */
  pinned: boolean;
}

export const EMPTY_IDENTITY: GraphIdentity = {
  vin: null,
  serialNumber: null,
  partNumber: null,
  systemName: null,
  swNumber: null,
  swVersion: null,
  hwNumber: null,
};

/** Identification DID -> identity field (ISO 14229 Annex C). */
export const IDENTITY_DIDS: ReadonlyArray<{ did: number; field: keyof GraphIdentity }> = [
  { did: 0xf190, field: 'vin' },
  { did: 0xf18c, field: 'serialNumber' },
  { did: 0xf187, field: 'partNumber' },
  { did: 0xf197, field: 'systemName' },
  { did: 0xf188, field: 'swNumber' },
  { did: 0xf189, field: 'swVersion' },
  { did: 0xf191, field: 'hwNumber' },
];

export const IDENT_DID_FIRST = 0xf186;
export const IDENT_DID_LAST = 0xf19f;

export function nodeKey(busId: number, isExtendedId: boolean, responseId: number): string {
  return `${busId}:${isExtendedId ? 'x' : 's'}:${responseId}`;
}

/**
 * Secondary card line, never repeating the title: part number (unless it IS the title) with the SW
 * version / number; otherwise serial number, otherwise SW; otherwise `null`.
 */
export function nodeDetailLine(n: GraphNode): string | null {
  const title = nodeTitle(n);
  const id = n.identity;
  const sw = id.swVersion ?? id.swNumber;
  const part = id.partNumber !== null && id.partNumber !== title ? id.partNumber : null;
  if (part !== null) return sw ? `${part} · SW ${sw}` : part;
  if (id.serialNumber !== null && id.serialNumber !== title) return `S/N ${id.serialNumber}`;
  return sw ? `SW ${sw}` : null;
}

export function formatCanId(id: number, extended: boolean): string {
  return '0x' + id.toString(16).toUpperCase().padStart(extended ? 8 : 3, '0');
}

export function nodeTitle(n: GraphNode): string {
  return n.identity.systemName ?? n.identity.partNumber ?? `ECU ${formatCanId(n.responseId, n.isExtendedId)}`;
}

// ─── Radial layout ────────────────────────────────────────────────────────────

/** Fixed card sizes (world px): used by layout, hit-testing and rendering. */
export const NODE_W = 220;
export const NODE_H = 100;
export const TESTER_W = 210;
export const TESTER_H = 58;

export const RING0_RADIUS = 300;
export const RING_STEP = 260;
/** Minimum visible edge length (card border to card border) along every direction. */
export const MIN_EDGE_GAP = 170;
const RING0_CAPACITY = 8;
/** A slot counts as occupied when an existing node sits closer than this (world px). */
export const SLOT_OCCUPIED_DIST = 90;

function bitReverse(value: number, bits: number): number {
  let out = 0;
  for (let i = 0; i < bits; i++) {
    out = (out << 1) | ((value >> i) & 1);
  }
  return out;
}

/** Distance from a rect centre to its border along direction angle `angle`. */
function halfExtentAlong(hw: number, hh: number, angle: number): number {
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  return Math.min(c < 1e-9 ? Infinity : hw / c, s < 1e-9 ? Infinity : hh / s);
}

/**
 * Deterministic position of ring slot `slot` (0-based). Ring k holds 8 * 2^k slots. Within a ring the
 * slots are visited in bit-reversal order, so the first nodes spread evenly (2 nodes opposite, 4 on a
 * cross, ...). Odd rings are rotated half a step. The radius is direction-dependent (an ellipse-like
 * ring): it is at least `RING0_RADIUS + k * RING_STEP` and always leaves `MIN_EDGE_GAP` of visible
 * edge between the tester card and the node card, so wide cards on the left / right never swallow
 * the edge label.
 */
export function slotPosition(slot: number): GraphPos {
  let ring = 0;
  let cap = RING0_CAPACITY;
  let rest = Math.max(0, Math.floor(slot));
  while (rest >= cap) {
    rest -= cap;
    ring += 1;
    cap *= 2;
  }
  const bits = Math.round(Math.log2(cap));
  const order = bitReverse(rest, bits);
  const angle = -Math.PI / 2 + (2 * Math.PI * order) / cap + (ring % 2 === 1 ? Math.PI / cap : 0);
  const clearance =
    halfExtentAlong(TESTER_W / 2, TESTER_H / 2, angle) + halfExtentAlong(NODE_W / 2, NODE_H / 2, angle) + MIN_EDGE_GAP;
  const radius = Math.max(RING0_RADIUS, clearance) + ring * RING_STEP;
  return { x: Math.round(Math.cos(angle) * radius), y: Math.round(Math.sin(angle) * radius) };
}

function dist(a: GraphPos, b: GraphPos): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Lowest-index slot whose position is not near any of `occupied`. */
export function nextFreePosition(occupied: readonly GraphPos[]): GraphPos {
  for (let slot = 0; ; slot++) {
    const p = slotPosition(slot);
    if (!occupied.some((o) => dist(o, p) < SLOT_OCCUPIED_DIST)) return p;
  }
}

function compareNodesStable(a: GraphNode, b: GraphNode): number {
  if (a.busId !== b.busId) return a.busId - b.busId;
  if (a.isExtendedId !== b.isExtendedId) return a.isExtendedId ? 1 : -1;
  return a.responseId - b.responseId;
}

/**
 * Re-arranges the radial layout. `all = true`: every node is unpinned and re-placed in order.
 * `all = false`: pinned nodes keep their position, unpinned ones move to the lowest free slots.
 */
export function relayout(nodes: readonly GraphNode[], all: boolean): GraphNode[] {
  const occupied: GraphPos[] = all ? [] : nodes.filter((n) => n.pinned).map((n) => n.pos);
  const targets = nodes.filter((n) => all || !n.pinned).sort(compareNodesStable);
  const placed = new Map<string, GraphPos>();
  for (const n of targets) {
    const p = nextFreePosition(occupied);
    occupied.push(p);
    placed.set(n.key, p);
  }
  return nodes.map((n) => {
    const p = placed.get(n.key);
    return p ? { ...n, pos: p, pinned: all ? false : n.pinned } : n;
  });
}

// ─── Discovery merge ──────────────────────────────────────────────────────────

function pick(next: string | null, prev: string | null): string | null {
  return next !== null && next.length > 0 ? next : prev;
}

function nodeFromEcu(e: DiscoveredEcuDto, busId: number, nowMs: number, pos: GraphPos): GraphNode {
  return {
    key: nodeKey(busId, e.isExtendedId, e.responseId),
    busId,
    isExtendedId: e.isExtendedId,
    responseId: e.responseId,
    requestId: e.requestId,
    firstSeenMs: nowMs,
    lastSeenMs: nowMs,
    lastScanSeen: true,
    positive: e.positive,
    nrc: e.nrc,
    nrcName: e.nrcName,
    pending: e.pending,
    firstResponseUs: e.firstResponseUs,
    raw: [...e.raw],
    identifyError: e.identifyError,
    identity: {
      ...EMPTY_IDENTITY,
      vin: e.vin,
      serialNumber: e.serialNumber,
      partNumber: e.partNumber,
    },
    dids: [],
    dtcCount: null,
    lastSession: null,
    pos,
    pinned: false,
  };
}

export interface MergeOptions {
  /**
   * `true` (default, functional discovery): known nodes of the same bus + addressing mode that did not
   * answer get `lastScanSeen = false`. `false` (partial probes: physical sweep, passive pairs): a probe that
   * covers only some ids says nothing about the others, so they are left untouched.
   */
  markUnseen?: boolean;
  /**
   * `true` for passive observations: the response content is not decoded, so a known node keeps its
   * status / NRC / raw / identity and only gains `requestId` (when it had none) and a fresh `lastSeen`.
   */
  passive?: boolean;
}

/**
 * Merges one discovery result into the node list of `busId`.
 *  - unknown responders become new nodes at the next free radial slots (ordered by id);
 *  - seen nodes are refreshed in place (position / pinned / identity read via DIDs are kept; a null
 *    discovery identity field never wipes a known value);
 *  - previously known nodes of the same bus AND addressing mode that did not answer get
 *    `lastScanSeen = false` but are kept.
 */
export function mergeDiscovery(
  nodes: readonly GraphNode[],
  result: EcuDiscoveryResultDto,
  busId: number,
  nowMs: number,
  options: MergeOptions = {},
): GraphNode[] {
  const markUnseen = options.markUnseen !== false;
  const passive = options.passive === true;
  const answered = new Map<string, DiscoveredEcuDto>();
  for (const e of result.ecus) answered.set(nodeKey(busId, e.isExtendedId, e.responseId), e);

  const next: GraphNode[] = nodes.map((n) => {
    const e = answered.get(n.key);
    if (e && passive) {
      return { ...n, requestId: n.requestId ?? e.requestId, lastSeenMs: nowMs, lastScanSeen: true };
    }
    if (e) {
      return {
        ...n,
        requestId: e.requestId ?? n.requestId,
        lastSeenMs: nowMs,
        lastScanSeen: true,
        positive: e.positive,
        nrc: e.nrc,
        nrcName: e.nrcName,
        pending: e.pending,
        firstResponseUs: e.firstResponseUs,
        raw: [...e.raw],
        identifyError: e.identifyError,
        identity: {
          ...n.identity,
          vin: pick(e.vin, n.identity.vin),
          serialNumber: pick(e.serialNumber, n.identity.serialNumber),
          partNumber: pick(e.partNumber, n.identity.partNumber),
        },
      };
    }
    if (markUnseen && n.busId === busId && n.isExtendedId === result.isExtendedId && n.lastScanSeen) {
      return { ...n, lastScanSeen: false };
    }
    return n;
  });

  const known = new Set(nodes.map((n) => n.key));
  const fresh = [...answered.entries()]
    .filter(([key]) => !known.has(key))
    .map(([, e]) => e)
    .sort((a, b) => (a.isExtendedId === b.isExtendedId ? a.responseId - b.responseId : a.isExtendedId ? 1 : -1));
  const occupied = next.map((n) => n.pos);
  for (const e of fresh) {
    const pos = nextFreePosition(occupied);
    occupied.push(pos);
    next.push(nodeFromEcu(e, busId, nowMs, pos));
  }
  return next;
}

/** Applies identification DID reads: updates `dids` and the identity fields they map to. */
export function applyDidValues(node: GraphNode, values: readonly GraphDidValue[]): GraphNode {
  if (values.length === 0) return node;
  const byDid = new Map<number, string>(node.dids.map((d) => [d.did, d.text]));
  for (const v of values) byDid.set(v.did, v.text);
  const identity: GraphIdentity = { ...node.identity };
  for (const m of IDENTITY_DIDS) {
    const text = byDid.get(m.did);
    if (text !== undefined && text.length > 0) identity[m.field] = text;
  }
  const dids = [...byDid.entries()].map(([did, text]) => ({ did, text })).sort((a, b) => a.did - b.did);
  return { ...node, identity, dids };
}

// ─── Geometry ─────────────────────────────────────────────────────────────────

/** Point where the ray from the rect centre towards (tx, ty) leaves the rect (half-size hw x hh). */
export function rectEdgePoint(cx: number, cy: number, hw: number, hh: number, tx: number, ty: number): GraphPos {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx === 0 ? Infinity : hw / Math.abs(dx);
  const sy = dy === 0 ? Infinity : hh / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

export interface GraphBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function graphBounds(
  nodes: readonly GraphNode[],
  nodeW: number,
  nodeH: number,
  testerW: number,
  testerH: number,
): GraphBounds {
  let minX = -testerW / 2;
  let minY = -testerH / 2;
  let maxX = testerW / 2;
  let maxY = testerH / 2;
  for (const n of nodes) {
    minX = Math.min(minX, n.pos.x - nodeW / 2);
    maxX = Math.max(maxX, n.pos.x + nodeW / 2);
    minY = Math.min(minY, n.pos.y - nodeH / 2);
    maxY = Math.max(maxY, n.pos.y + nodeH / 2);
  }
  return { minX, minY, maxX, maxY };
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export const GRAPH_STORAGE_VERSION = 1;

export function graphStorageKey(demo: boolean, busId: number): string {
  return `nexuscan.ecuGraph.v${GRAPH_STORAGE_VERSION}.${demo ? 'demo' : 'real'}.bus${busId}`;
}

export function serializeNodes(nodes: readonly GraphNode[]): string {
  return JSON.stringify({ version: GRAPH_STORAGE_VERSION, nodes });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function sanitizeNode(v: unknown, busId: number): GraphNode | null {
  if (!isRecord(v)) return null;
  const responseId = numOrNull(v.responseId);
  if (responseId === null || typeof v.isExtendedId !== 'boolean') return null;
  const isExtendedId = v.isExtendedId;
  const posRaw = isRecord(v.pos) ? v.pos : {};
  const idRaw = isRecord(v.identity) ? v.identity : {};
  const session = v.lastSession;
  const dids: GraphDidValue[] = [];
  if (Array.isArray(v.dids)) {
    for (const d of v.dids) {
      if (isRecord(d) && typeof d.did === 'number' && typeof d.text === 'string') dids.push({ did: d.did, text: d.text });
    }
  }
  return {
    key: nodeKey(busId, isExtendedId, responseId),
    busId,
    isExtendedId,
    responseId,
    requestId: numOrNull(v.requestId),
    firstSeenMs: num(v.firstSeenMs, 0),
    lastSeenMs: num(v.lastSeenMs, 0),
    lastScanSeen: v.lastScanSeen === true,
    positive: v.positive === true,
    nrc: numOrNull(v.nrc),
    nrcName: strOrNull(v.nrcName),
    pending: v.pending === true,
    firstResponseUs: num(v.firstResponseUs, 0),
    raw: Array.isArray(v.raw) ? v.raw.filter((b): b is number => typeof b === 'number') : [],
    identifyError: strOrNull(v.identifyError),
    identity: {
      vin: strOrNull(idRaw.vin),
      serialNumber: strOrNull(idRaw.serialNumber),
      partNumber: strOrNull(idRaw.partNumber),
      systemName: strOrNull(idRaw.systemName),
      swNumber: strOrNull(idRaw.swNumber),
      swVersion: strOrNull(idRaw.swVersion),
      hwNumber: strOrNull(idRaw.hwNumber),
    },
    dids,
    dtcCount: numOrNull(v.dtcCount),
    lastSession: session === 'default' || session === 'extended' || session === 'programming' ? session : null,
    pos: { x: num(posRaw.x, 0), y: num(posRaw.y, 0) },
    pinned: v.pinned === true,
  };
}

/** Defensive parse of persisted JSON: unknown / malformed input yields an empty list, never throws. */
export function deserializeNodes(text: string | null, busId: number): GraphNode[] {
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || parsed.version !== GRAPH_STORAGE_VERSION || !Array.isArray(parsed.nodes)) return [];
  const out: GraphNode[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.nodes) {
    const n = sanitizeNode(raw, busId);
    if (n && !seen.has(n.key)) {
      seen.add(n.key);
      out.push(n);
    }
  }
  return out;
}
