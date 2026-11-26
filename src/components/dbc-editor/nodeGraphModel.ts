/**
 * Pure model for the DBC editor "Network Nodes Graph" (TX/RX relations between ECUs).
 * Types-only imports: no React, no DOM.
 */
import type { DatabaseSchemaDto, MessageSchemaDto, SignalSchemaDto } from './contracts';

export const UNASSIGNED_NODE = '__unassigned__';

export interface Pt {
  x: number;
  y: number;
}

export interface GraphEdgeMessage {
  messageKey: string;
  name: string;
  arbId: number;
  isExtended: boolean;
  dlc: number;
  cycleMs: number | null;
  signalNames: string[];
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  messages: GraphEdgeMessage[];
  hasReverse: boolean;
}

export interface GraphNodeModel {
  name: string;
  txCount: number;
  rxCount: number;
  isUnassigned: boolean;
}

function isNoNode(name: string): boolean {
  const n = name.trim();
  return n === '' || n === 'Vector__XXX';
}

export function buildNodeGraph(
  schema: DatabaseSchemaDto,
  opts: { includeUnassigned: boolean }
): { nodes: GraphNodeModel[]; edges: GraphEdge[] } {
  const sigById = new Map<number, SignalSchemaDto>();
  for (const s of schema.signals) sigById.set(s.signalId, s);

  const txSets = new Map<string, Set<string>>();
  const rxSets = new Map<string, Set<string>>();
  const edgeMap = new Map<string, GraphEdge>();
  const known = new Set<string>();
  for (const e of schema.ecus) known.add(e.name);

  const addTo = (m: Map<string, Set<string>>, node: string, key: string): void => {
    let s = m.get(node);
    if (!s) {
      s = new Set<string>();
      m.set(node, s);
    }
    s.add(key);
  };

  const addEdge = (from: string, to: string, msg: MessageSchemaDto, signalNames: string[]): void => {
    const id = `${from}->${to}`;
    let edge = edgeMap.get(id);
    if (!edge) {
      edge = { id, from, to, messages: [], hasReverse: false };
      edgeMap.set(id, edge);
    }
    if (edge.messages.some((m) => m.messageKey === msg.messageKey)) return;
    edge.messages.push({
      messageKey: msg.messageKey,
      name: msg.name,
      arbId: msg.arbId,
      isExtended: msg.isExtended,
      dlc: msg.dlc,
      cycleMs: msg.expectedCycleMs,
      signalNames,
    });
  };

  for (const msg of schema.messages) {
    const sigs: SignalSchemaDto[] = [];
    for (const id of msg.signalIds) {
      const s = sigById.get(id);
      if (s) sigs.push(s);
    }
    const receivers = new Set<string>();
    for (const s of sigs) for (const r of s.receivers) if (!isNoNode(r)) receivers.add(r);

    const txers = new Set<string>();
    for (const t of msg.transmitters) txers.add(isNoNode(t) ? UNASSIGNED_NODE : t);
    if (txers.size === 0) txers.add(UNASSIGNED_NODE);

    for (const r of receivers) {
      known.add(r);
      addTo(rxSets, r, msg.messageKey);
    }
    if (receivers.size === 0) addTo(rxSets, UNASSIGNED_NODE, msg.messageKey);

    for (const t of txers) {
      if (t !== UNASSIGNED_NODE) known.add(t);
      addTo(txSets, t, msg.messageKey);
      if (receivers.size === 0) {
        addEdge(t, UNASSIGNED_NODE, msg, sigs.map((s) => s.name));
        continue;
      }
      for (const r of receivers) {
        if (r === t) continue;
        addEdge(t, r, msg, sigs.filter((s) => s.receivers.includes(r)).map((s) => s.name));
      }
    }
  }

  let edges = [...edgeMap.values()];
  if (!opts.includeUnassigned) {
    edges = edges.filter((e) => e.from !== UNASSIGNED_NODE && e.to !== UNASSIGNED_NODE);
  }
  const ids = new Set(edges.map((e) => e.id));
  for (const e of edges) {
    e.messages.sort((a, b) => a.arbId - b.arbId);
    e.hasReverse = ids.has(`${e.to}->${e.from}`);
  }
  edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const names = [...known].sort();
  const nodes: GraphNodeModel[] = names.map((name) => ({
    name,
    txCount: txSets.get(name)?.size ?? 0,
    rxCount: rxSets.get(name)?.size ?? 0,
    isUnassigned: false,
  }));
  if (opts.includeUnassigned) {
    nodes.push({
      name: UNASSIGNED_NODE,
      txCount: txSets.get(UNASSIGNED_NODE)?.size ?? 0,
      rxCount: rxSets.get(UNASSIGNED_NODE)?.size ?? 0,
      isUnassigned: true,
    });
  }
  return { nodes, edges };
}

/** Normalised (0..1) deterministic circle: sorted by name, start at top, clockwise; unassigned at centre. */
export function circularLayout(nodeNames: readonly string[]): Record<string, Pt> {
  const out: Record<string, Pt> = {};
  const real = nodeNames.filter((n) => n !== UNASSIGNED_NODE).slice().sort();
  const n = real.length;
  const r = 0.4;
  real.forEach((name, i) => {
    if (n === 1) {
      out[name] = { x: 0.5, y: 0.5 };
      return;
    }
    const ang = -Math.PI / 2 + (2 * Math.PI * i) / n;
    out[name] = { x: 0.5 + r * Math.cos(ang), y: 0.5 + r * Math.sin(ang) };
  });
  if (nodeNames.includes(UNASSIGNED_NODE)) out[UNASSIGNED_NODE] = { x: 0.5, y: 0.5 };
  return out;
}

/** Quadratic-bezier control point; bidirectional pairs bend to opposite sides (normal flips with direction). */
export function edgeControlPoint(a: Pt, b: Pt, hasReverse: boolean, bend: number): Pt {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  if (!hasReverse) return { x: mx, y: my };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: mx + (-dy / len) * bend, y: my + (dx / len) * bend };
}

export function quadPoint(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance from p to the quadratic curve sampled in 24 segments. */
export function distanceToEdge(p: Pt, a: Pt, c: Pt, b: Pt): number {
  const N = 24;
  let best = Infinity;
  let prev = a;
  for (let i = 1; i <= N; i++) {
    const cur = quadPoint(a, c, b, i / N);
    best = Math.min(best, distToSegment(p, prev, cur));
    prev = cur;
  }
  return best;
}

/** 1..5 px, log scale in the message count. */
export function edgeWidth(messageCount: number): number {
  const n = Math.max(1, Math.floor(messageCount));
  return Math.min(5, 1 + Math.log2(n) * 0.8);
}

export function serializeLayout(pos: Record<string, Pt>): string {
  return JSON.stringify(pos);
}

export function parseLayout(raw: string | null): Record<string, Pt> {
  const out: Record<string, Pt> = {};
  if (!raw) return out;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'object' || val === null) continue;
    const { x, y } = val as { x?: unknown; y?: unknown };
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
      out[k] = { x, y };
    }
  }
  return out;
}

export interface NodeTrafficGroup {
  peer: string;
  edgeId: string;
  messages: GraphEdgeMessage[];
}

/** Incoming / outgoing traffic of one node grouped by peer node (sorted by peer name). */
export function nodeTraffic(
  graph: { edges: readonly GraphEdge[] },
  ecuName: string
): { incoming: NodeTrafficGroup[]; outgoing: NodeTrafficGroup[] } {
  // Real ECUs alphabetically (case-insensitive), the Unassigned pseudo-node always last.
  const byPeer = (a: NodeTrafficGroup, b: NodeTrafficGroup): number => {
    const ua = a.peer === UNASSIGNED_NODE;
    const ub = b.peer === UNASSIGNED_NODE;
    if (ua !== ub) return ua ? 1 : -1;
    return a.peer.localeCompare(b.peer, undefined, { sensitivity: 'base' });
  };
  const incoming: NodeTrafficGroup[] = [];
  const outgoing: NodeTrafficGroup[] = [];
  for (const e of graph.edges) {
    if (e.to === ecuName) incoming.push({ peer: e.from, edgeId: e.id, messages: e.messages });
    if (e.from === ecuName) outgoing.push({ peer: e.to, edgeId: e.id, messages: e.messages });
  }
  return { incoming: incoming.sort(byPeer), outgoing: outgoing.sort(byPeer) };
}
