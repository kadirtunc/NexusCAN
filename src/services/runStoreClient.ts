/**
 * Run store client (diag-workspace-v1 §10, workbench-v1 §9.5): typed wrappers over the `cmd_run_*` commands.
 * Same transport rules as the flow library: Tauri `invoke` in the desktop shell, the authenticated local
 * bridge in browser mode (`invokeCmd`). The `RunStoreClient` seam lets headless tests inject
 * `createMemoryRunStore()` (append-only, backend-like validation of the integer `durationMs`).
 * Errors are `"[runstore:<code>] <message>"` (`parseRunStoreError`).
 */
import type { RunQueryFilterDto, RunRecordV1, RunStoreCommandMap } from '../types/runRecord';
import { invokeCmd } from './ipcClient';

export interface RunStoreClient {
  append(record: RunRecordV1): Promise<void>;
  query(projectId: string, filter: RunQueryFilterDto, limit: number): Promise<RunRecordV1[]>;
  /** Newest record per (ecuId, flowId) of the project. */
  latest(projectId: string): Promise<RunRecordV1[]>;
}

function call<K extends keyof RunStoreCommandMap>(cmd: K, args: RunStoreCommandMap[K]['args']): Promise<RunStoreCommandMap[K]['result']> {
  return invokeCmd<RunStoreCommandMap[K]['result']>(cmd, args);
}

export async function runAppend(record: RunRecordV1): Promise<void> {
  await call('cmd_run_append', { record });
}

export function runQuery(projectId: string, filter: RunQueryFilterDto, limit: number): Promise<RunRecordV1[]> {
  return call('cmd_run_query', { projectId, filter, limit });
}

export function runLatest(projectId: string): Promise<RunRecordV1[]> {
  return call('cmd_run_latest', { projectId });
}

export const ipcRunStoreClient: RunStoreClient = {
  append: runAppend,
  query: runQuery,
  latest: runLatest,
};

/** In-memory client (tests / no-backend fallback) with the backend's append-only semantics. */
export function createMemoryRunStore(): RunStoreClient & { readonly records: RunRecordV1[] } {
  const records: RunRecordV1[] = [];
  const matches = (r: RunRecordV1, f: RunQueryFilterDto): boolean =>
    (f.ecuId == null || r.ecuId === f.ecuId) &&
    (f.flowId == null || r.flowId === f.flowId) &&
    (f.queueId == null || r.queueId === f.queueId) &&
    (f.outcome == null || r.outcome === f.outcome) &&
    (f.since == null || r.startedAt >= f.since) &&
    (f.until == null || r.startedAt < f.until) &&
    (f.topLevelOnly !== true || r.parentRunId === null);
  return {
    records,
    async append(record) {
      if (!Number.isInteger(record.durationMs) || record.durationMs < 0) throw new Error('[runstore:invalid] durationMs must be a non-negative integer');
      if (records.some((r) => r.runId === record.runId)) throw new Error('[runstore:invalid] duplicate runId');
      records.push(JSON.parse(JSON.stringify(record)) as RunRecordV1);
    },
    async query(projectId, filter, limit) {
      return records.filter((r) => r.projectId === projectId && matches(r, filter)).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, limit);
    },
    async latest(projectId) {
      const best = new Map<string, RunRecordV1>();
      for (const r of records) {
        if (r.projectId !== projectId) continue;
        const k = `${r.ecuId ?? ''}\u0000${r.flowId}`;
        const cur = best.get(k);
        if (!cur || r.startedAt >= cur.startedAt) best.set(k, r);
      }
      return [...best.values()];
    },
  };
}
