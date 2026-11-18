/**
 * Run store DTOs (FROZEN contract, diag-workspace-v1.md §10). Immutable, append-only, cloud upload-only.
 * Rust mirror: crates/nexus-hal/src/runstore.rs. IPC args/results are camelCase.
 */
export type RunOutcome = 'ok' | 'fail' | 'error' | 'aborted' | 'panic_stop';

export type RunValue = string | number | boolean | null;

export interface RunFileRefV1 {
  key: string;                // flow input key
  name: string;
  size: number;
  crc32: string;              // 8 hex uppercase
}

export interface RunRecordV1 {
  schemaVersion: 1;
  runId: string;              // uuid
  parentRunId: string | null; // nested call frame / vehicle flow child
  queueId: string | null;     // Workbench queue batch
  projectId: string;          // uuid (NexusProjectFileV1.projectId)
  vehicleId: string | null;
  ecuId: string | null;
  ecuName: string | null;
  ecuSnapshotHash: string | null;   // sha-256 hex of canonical EcuRecordV1 at run start
  flowId: string;
  flowRevision: number;
  flowContentHash: string;
  flowName: string;
  params: Record<string, RunValue>; // non-file inputs, resolved values
  files: RunFileRefV1[];            // never file bytes
  startedAt: string;          // ISO-8601 UTC
  endedAt: string;
  durationMs: number;         // integer ms (writer MUST send Math.round), 0..=2^53-1; fractions rejected
  outcome: RunOutcome;
  outputName: string | null;  // flow_output name reached
  outputs: Record<string, RunValue>;
  nrc: number | null;
  errorMessage: string | null;
  logExcerpt: string[];       // <= 200 lines, each <= 512 chars
  operator: string | null;
  deviceId: string;
  appVersion: string;
}

export interface RunQueryFilterDto {
  ecuId?: string | null;
  flowId?: string | null;
  queueId?: string | null;
  outcome?: RunOutcome | null;
  since?: string | null;      // ISO-8601 inclusive
  until?: string | null;      // ISO-8601 exclusive
  topLevelOnly?: boolean;     // parentRunId === null
}

export type RunStoreErrorCode = 'invalid' | 'too_large' | 'io';

export interface RunStoreCommandMap {
  cmd_run_append: { args: { record: RunRecordV1 }; result: null };
  cmd_run_query: { args: { projectId: string; filter: RunQueryFilterDto; limit: number }; result: RunRecordV1[] };
  cmd_run_latest: { args: { projectId: string }; result: RunRecordV1[] };
}

export function parseRunStoreError(raw: unknown): { code: RunStoreErrorCode; message: string } | null {
  const s = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : '';
  const m = /^\[runstore:(invalid|too_large|io)\]\s*(.*)$/s.exec(s);
  return m ? { code: m[1] as RunStoreErrorCode, message: m[2] } : null;
}
