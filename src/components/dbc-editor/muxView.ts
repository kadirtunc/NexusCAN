/**
 * Pure multiplexer view helpers for the bit-layout matrix (no React, types-only imports).
 * Semantics mirror crates/nexus-netdb (ui_dto.rs mux mapping, ir/mux.rs MuxRole/MuxRange):
 * ranges are inclusive; a cascaded `m2M` signal arrives as `multiplexed` but is also a switch
 * (referenced by other signals' `switchSignalId`).
 */
import type { SignalSchemaDto } from './contracts';

export interface MuxPageOption {
  value: number;
  label: string;
  hasSignals: boolean;
}

export interface MuxSwitchNode {
  /** signalId of the switch. */
  switchId: number;
  /** null for a master switch. */
  parentSwitchId: number | null;
  /** The switch's own muxRanges on its parent (cascaded); [] for a master. */
  parentRanges: [number, number][];
  /** Union of children muxRanges values and enumTable keys, ascending. */
  pages: MuxPageOption[];
}

/** switchId -> selected page value, or 'all' (overlay, legacy view). */
export type MuxSelection = ReadonlyMap<number, number | 'all'>;

type SignalMap = ReadonlyMap<number, SignalSchemaDto>;
type MuxLink = readonly [switchId: number, ranges: readonly (readonly [number, number])[]];

const MAX_CHAIN_DEPTH = 16;
/** A range spanning more than this many values only contributes its start and end as pages. */
const MAX_RANGE_EXPANSION = 256;

/** Activation chain of a signal: [switch, ranges of the signal on that switch], nearest switch first. */
function activationChain(sig: SignalSchemaDto, signalMap: SignalMap): MuxLink[] {
  const chain: MuxLink[] = [];
  const seen = new Set<number>([sig.signalId]);
  let cur: SignalSchemaDto | undefined = sig;
  while (
    cur &&
    cur.muxRole === 'multiplexed' &&
    cur.switchSignalId !== null &&
    chain.length < MAX_CHAIN_DEPTH
  ) {
    const swId: number = cur.switchSignalId;
    if (seen.has(swId)) break; // cycle
    seen.add(swId);
    chain.push([swId, cur.muxRanges]);
    cur = signalMap.get(swId);
  }
  return chain;
}

function inRanges(value: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([a, b]) => value >= a && value <= b);
}

function rangesDisjoint(
  a: readonly (readonly [number, number])[],
  b: readonly (readonly [number, number])[]
): boolean {
  for (const [a0, a1] of a) {
    for (const [b0, b1] of b) {
      if (a0 <= b1 && b0 <= a1) return false;
    }
  }
  return true;
}

function pageLabel(value: number, sw: SignalSchemaDto): string {
  const name = sw.enumTable[String(value)];
  return name !== undefined ? `${value} · ${name}` : String(value);
}

export function buildMuxSwitchTree(messageSignals: readonly SignalSchemaDto[]): MuxSwitchNode[] {
  const signalMap = new Map<number, SignalSchemaDto>();
  for (const s of messageSignals) signalMap.set(s.signalId, s);

  const switchIds = new Set<number>();
  for (const s of messageSignals) {
    if (s.muxRole === 'masterSwitch') switchIds.add(s.signalId);
    if (s.muxRole === 'multiplexed' && s.switchSignalId !== null && signalMap.has(s.switchSignalId)) {
      switchIds.add(s.switchSignalId);
    }
  }

  const entries: { node: MuxSwitchNode; depth: number }[] = [];
  for (const id of switchIds) {
    const sw = signalMap.get(id);
    if (!sw) continue;
    const hasParent =
      sw.muxRole === 'multiplexed' && sw.switchSignalId !== null && signalMap.has(sw.switchSignalId);

    const pageMap = new Map<number, { label: string; has: boolean }>();
    const add = (value: number, label: string, has: boolean): void => {
      const prev = pageMap.get(value);
      if (prev) prev.has = prev.has || has;
      else pageMap.set(value, { label, has });
    };
    for (const child of messageSignals) {
      if (child.muxRole !== 'multiplexed' || child.switchSignalId !== id) continue;
      for (const [a, b] of child.muxRanges) {
        if (b < a) continue;
        if (b - a + 1 > MAX_RANGE_EXPANSION) {
          add(a, `${a}…${b}`, true);
          add(b, pageLabel(b, sw), true);
        } else {
          for (let v = a; v <= b; v += 1) add(v, pageLabel(v, sw), true);
        }
      }
    }
    for (const key of Object.keys(sw.enumTable)) {
      const v = Number(key);
      if (Number.isInteger(v)) add(v, pageLabel(v, sw), false);
    }
    const pages: MuxPageOption[] = [...pageMap.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([value, p]) => ({ value, label: p.label, hasSignals: p.has }));

    entries.push({
      node: {
        switchId: id,
        parentSwitchId: hasParent ? sw.switchSignalId : null,
        parentRanges: hasParent ? sw.muxRanges.map(([a, b]): [number, number] => [a, b]) : [],
        pages,
      },
      depth: activationChain(sw, signalMap).length,
    });
  }
  entries.sort((x, y) => x.depth - y.depth || x.node.switchId - y.node.switchId);
  return entries.map((e) => e.node);
}

export function defaultMuxSelection(tree: readonly MuxSwitchNode[]): Map<number, number | 'all'> {
  const sel = new Map<number, number | 'all'>();
  for (const n of tree) sel.set(n.switchId, n.pages.length > 0 ? n.pages[0].value : 'all');
  return sel;
}

export function isSignalVisibleOnPage(
  sig: SignalSchemaDto,
  sel: MuxSelection,
  signalMap: SignalMap
): boolean {
  if (sig.muxRole !== 'multiplexed') return true;
  for (const [swId, ranges] of activationChain(sig, signalMap)) {
    const cur = sel.get(swId);
    if (cur === undefined || cur === 'all') continue;
    if (!inRanges(cur, ranges)) return false;
  }
  return true;
}

export function visibleSwitchNodes(
  tree: readonly MuxSwitchNode[],
  sel: MuxSelection,
  signalMap: SignalMap
): MuxSwitchNode[] {
  return tree.filter((n) => {
    const sw = signalMap.get(n.switchId);
    return sw ? isSignalVisibleOnPage(sw, sel, signalMap) : false;
  });
}

export function selectionRevealingSignal(
  sig: SignalSchemaDto,
  current: MuxSelection,
  signalMap: SignalMap
): Map<number, number | 'all'> {
  const next = new Map<number, number | 'all'>(current);
  for (const [swId, ranges] of activationChain(sig, signalMap)) {
    const cur = next.get(swId);
    if (cur === 'all') continue;
    if (cur !== undefined && inRanges(cur, ranges)) continue;
    const first = ranges.find(([a, b]) => b >= a);
    if (first) next.set(swId, first[0]);
  }
  return next;
}

export function areMuxExclusive(
  a: SignalSchemaDto,
  b: SignalSchemaDto,
  signalMap: SignalMap
): boolean {
  if (a.signalId === b.signalId) return false;
  const chainA = activationChain(a, signalMap);
  if (chainA.length === 0) return false;
  const chainB = activationChain(b, signalMap);
  if (chainB.length === 0) return false;
  const rangesB = new Map<number, readonly (readonly [number, number])[]>(chainB);
  for (const [swId, ra] of chainA) {
    const rb = rangesB.get(swId);
    if (rb && rangesDisjoint(ra, rb)) return true;
  }
  return false;
}
