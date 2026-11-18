/**
 * Synchronous index of resolved callee interfaces (`<flowId>@<revision>`), so `getBlockDefFor` can derive the
 * ports of a call block without awaiting. Revisions are immutable, so an entry never goes stale; it is filled
 * by `CalleeCache` (engine / preflight) and by the registry store (`primeCallees`). Also tracks the latest
 * known revision per library id for the "update to latest" badge.
 */
import type { FlowInterfaceV1, FlowLibKind } from '../../types/flowLibrary';
import type { FlowRefV1 } from '../../types/diagWorkspace';

export const CALL_PREFIX = 'call:';

export interface CallInfo {
  ref: FlowRefV1;
  name: string;
  kind: FlowLibKind;
  iface: FlowInterfaceV1;
}

export function isCallType(type: string): boolean {
  return type.startsWith(CALL_PREFIX);
}

export function callType(flowId: string): string {
  return `${CALL_PREFIX}${flowId}`;
}

export const refKey = (r: FlowRefV1): string => `${r.flowId}@${r.revision}`;

/** `config.ref` of a call block (`null` when missing or malformed). */
export function readCallRef(block: { config: Record<string, unknown> }): FlowRefV1 | null {
  const r = block.config['ref'];
  if (typeof r !== 'object' || r === null) return null;
  const o = r as Record<string, unknown>;
  return typeof o['flowId'] === 'string' && typeof o['revision'] === 'number' && Number.isInteger(o['revision']) && o['revision'] >= 1
    ? { flowId: o['flowId'], revision: o['revision'] }
    : null;
}

const infos = new Map<string, CallInfo>();
const latest = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

export const callIndex = {
  get(ref: FlowRefV1): CallInfo | undefined {
    return infos.get(refKey(ref));
  },
  set(info: CallInfo): void {
    infos.set(refKey(info.ref), info);
    emit();
  },
  clear(): void {
    infos.clear();
    latest.clear();
    emit();
  },
  setLatest(entries: ReadonlyArray<{ id: string; latestRevision: number }>): void {
    let changed = false;
    for (const e of entries) {
      if (latest.get(e.id) !== e.latestRevision) {
        latest.set(e.id, e.latestRevision);
        changed = true;
      }
    }
    if (changed) emit();
  },
  latestOf(flowId: string): number | undefined {
    return latest.get(flowId);
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  getVersion(): number {
    return version;
  },
};
