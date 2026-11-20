import { useSyncExternalStore } from 'react';

/**
 * Per-trace-session CAN ID filter ((arbId, isExtended) pairs). `null` = no ID filter.
 * Hoisted out of `TraceView` so it can be driven externally (MCP UI bridge).
 */
export interface TraceIdEntry {
  arbId: number;
  isExtended: boolean;
}

/** STD `0x1A0` and EXT `0x000001A0` are distinct IDs; this is the canonical set key. */
export function traceIdKey(arbId: number, isExtended: boolean): string {
  return `${isExtended ? 'E' : 'S'}${arbId >>> 0}`;
}

const filters = new Map<string, readonly TraceIdEntry[]>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  listeners.forEach((l) => l());
}

export const traceIdFilterStore = {
  get(sessionId: string): readonly TraceIdEntry[] | null {
    return filters.get(sessionId) ?? null;
  },
  set(sessionId: string, ids: readonly TraceIdEntry[] | null): void {
    if (ids === null || ids.length === 0) filters.delete(sessionId);
    else filters.set(sessionId, [...ids]);
    emit();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getVersion: (): number => version,
};

/** Re-renders when any filter changes; returns the filter for `sessionId`. */
export function useTraceIdFilter(sessionId: string): readonly TraceIdEntry[] | null {
  useSyncExternalStore(traceIdFilterStore.subscribe, traceIdFilterStore.getVersion, traceIdFilterStore.getVersion);
  return traceIdFilterStore.get(sessionId);
}
