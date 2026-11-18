/**
 * Flow library + flow interface DTOs (FROZEN contract, diag-workspace-v1.md §8 / §9).
 * Rust mirror: crates/nexus-hal/src/flowlib.rs. IPC args/results are camelCase.
 */
import type { DiagProtocol, FlowRefV1 } from './diagWorkspace';

export type FlowLibKind = 'nexuscan.flow' | 'nexuscan.block';
export type FlowOrigin = 'user' | 'template' | 'ai' | 'import';
export type WarningLevel = 'none' | 'info' | 'warn' | 'high' | 'critical';

/** Block packs (palette groups). Protocol packs declare `requires` on their blocks. */
export type BlockPack = 'core' | 'can' | 'uds' | 'kwp' | 'obd' | 'j1939' | 'canopen' | 'xcp' | 'custom';

/** Interface port of a flow (declared in `flow_input` / `flow_output` config). */
export type FlowPortValueType = 'ecu' | 'file' | 'hex' | 'number' | 'text' | 'bool' | 'bytes' | 'select';

export interface FlowPortSpecV1 {
  key: string;                // [A-Za-z][A-Za-z0-9_]{0,31}; the `ecu` input MUST use key "ecu"
  label: string;
  type: FlowPortValueType;
  required: boolean;
  default?: string | number | boolean;
  options?: string[];         // type 'select'
}

export type FlowOutcome = 'ok' | 'fail' | 'error';

export interface FlowOutcomeSpecV1 {
  name: string;               // flow_output config.name, unique per flow
  outcome: FlowOutcome;
  outputs: FlowPortSpecV1[];
}

/** Derived from the graph, never stored separately. */
export interface FlowInterfaceV1 {
  inputs: FlowPortSpecV1[];
  outcomes: FlowOutcomeSpecV1[];
  /** Union of `requires` over the expanded subtree; empty = protocol-agnostic. */
  requiresProtocols: DiagProtocol[];
}

export type FlowVariableType = 'number' | 'text' | 'bool' | 'bytes';

/** Frame-scoped variable, reset to `initial` at every frame start (§8.1). */
export interface FlowVariableDeclV1 {
  name: string;               // [A-Za-z_][A-Za-z0-9_]{0,31}, unique per flow
  type: FlowVariableType;
  initial: string;            // number: decimal text; bytes: hex text; bool: "true" | "false"
}

export interface NxFlowBlockV1 {
  id: string;
  type: string;               // block type, or `call:<flowId>` for library calls
  label: string;
  x?: number;
  y?: number;
  config: Record<string, unknown>;   // call blocks: config.ref: FlowRefV1
  ai?: { warningLevel: WarningLevel; reason: string };
}

export interface NxFlowConnectionV1 {
  id: string;
  fromBlockId: string;
  fromPortId: string;
  toBlockId: string;
  toPortId: string;
}

export interface NxFlowBodyV1 {
  id: string;                 // [A-Za-z0-9_-]{1,64}, stable
  revision: number;           // +1 on every save, first = 1
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  author: string | null;
  origin: FlowOrigin;
  aiReviewed: boolean;
  tags: string[];
  /** Declared frame-scoped variables (§8.1); optional for files written before B0 (treated as []). */
  variables?: FlowVariableDeclV1[];
  blocks: NxFlowBlockV1[];
  connections: NxFlowConnectionV1[];
}

/** `.nxflow.json` envelope; same for flows and custom blocks. */
export interface NxFlowFileV1 {
  schemaVersion: 1;
  kind: FlowLibKind;
  flow: NxFlowBodyV1;
  /** sha-256 hex over canonical JSON of `flow` minus revision / updatedAt. */
  contentHash: string;
}

export interface FlowLibEntryDto {
  id: string;
  kind: FlowLibKind;
  name: string;
  latestRevision: number;
  updatedAt: string;
  origin: FlowOrigin;
  aiReviewed: boolean;
  contentHash: string;
  tags: string[];
  deleted: boolean;
}

export interface FlowLibRevisionDto {
  revision: number;
  updatedAt: string;
  contentHash: string;
}

export type FlowLibErrorCode = 'invalid' | 'conflict' | 'not_found' | 'too_large' | 'io';

export interface FlowLibCommandMap {
  cmd_flowlib_list: { args: { includeDeleted: boolean }; result: FlowLibEntryDto[] };
  cmd_flowlib_revisions: { args: { id: string }; result: FlowLibRevisionDto[] };
  cmd_flowlib_load: { args: { id: string; revision: number | null }; result: string };
  cmd_flowlib_save: { args: { fileJson: string }; result: FlowLibEntryDto };
  cmd_flowlib_delete: { args: { id: string }; result: null };
}

/** Parses `"[flowlib:<code>] <message>"`; null when the string is not a flowlib error. */
export function parseFlowLibError(raw: unknown): { code: FlowLibErrorCode; message: string } | null {
  const s = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : '';
  const m = /^\[flowlib:(invalid|conflict|not_found|too_large|io)\]\s*(.*)$/s.exec(s);
  return m ? { code: m[1] as FlowLibErrorCode, message: m[2] } : null;
}

export type { FlowRefV1 };
