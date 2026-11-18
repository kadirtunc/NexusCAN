/**
 * Diagnostics Workspace v1 — ECU registry DTOs (FROZEN contract, planning/contracts/diag-workspace-v1.md §4).
 * Persisted inside `NexusProjectFileV1.diagnostics`. Changing a field requires a contract update.
 */
import type { AddressFormat } from './udsClient';

/** Protocol chosen manually per ECU. v1: only `uds_can` is operable; others are reserved. */
export type DiagProtocol = 'uds_can' | 'kwp_can' | 'obd_can' | 'j1939' | 'canopen';
export const DIAG_PROTOCOLS: readonly DiagProtocol[] = ['uds_can', 'kwp_can', 'obd_can', 'j1939', 'canopen'];
export const OPERABLE_PROTOCOLS: readonly DiagProtocol[] = ['uds_can'];

/** Key used in `{ecu.*}` paths. Never the display label. */
export const REGISTRY_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

export interface DiagnosticsProjectV1 {
  schemaVersion: 1;
  vehicles: DiagVehicleV1[];
  activeVehicleId: string | null;
}

export interface DiagVehicleV1 {
  id: string;                 // uuid, stable
  name: string;               // unique (trim, case-insensitive) within the project
  notes: string;
  groups: EcuGroupV1[];
  ecus: EcuRecordV1[];
  bindings: FlowBindingV1[];
  revision: number;           // +1 on every change (cloud sync)
  createdAt: string;          // ISO-8601 UTC
  updatedAt: string;
}

export type EcuGroupColor = 'amber' | 'red' | 'orange' | 'cyan' | 'violet' | 'emerald' | 'slate';
export const ECU_GROUP_COLORS: readonly EcuGroupColor[] = ['amber', 'red', 'orange', 'cyan', 'violet', 'emerald', 'slate'];

/** Flat in v1 (organisation only, no behaviour). */
export interface EcuGroupV1 {
  id: string;
  name: string;               // unique within the vehicle
  color: EcuGroupColor;
  order: number;
}

export type EcuSource = 'manual' | 'discovery' | 'import';

export interface EcuRecordV1 {
  id: string;
  name: string;               // unique (trim, case-insensitive) within the vehicle
  groupId: string | null;     // null = ungrouped
  order: number;
  notes: string;
  source: EcuSource;
  protocol: DiagProtocol;
  /** Project connection profile (`connections.profiles[].id`); bus id resolved at run time. null = choose at run. */
  connectionProfileId: string | null;
  addressing: EcuAddressingV1;
  timing: EcuTimingV1;
  security: EcuSecurityV1;
  routines: EcuRoutineV1[];
  flash: EcuFlashParamsV1;
  identification: EcuIdentificationV1;
  dids: EcuDidV1[];
  vars: EcuVarV1[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Maps 1:1 onto `DiagSessionConfigDto` minus `busId` / `p2MarginMs`. */
export interface EcuAddressingV1 {
  requestId: number;
  responseId: number;
  isExtendedId: boolean;
  functionalId: number | null;
  addressFormat: AddressFormat;
  targetAddress: number | null;
  responseAddress: number | null;
  padding: number | null;     // null = no padding
  useFd: boolean;
}

export interface EcuTimingV1 {
  p2MarginMs: number;
  keepaliveIntervalMs: number;
}

/** Reference only: provider specs live in the seed/key profile store (seedkey-v1), never in the project. */
export interface EcuSecurityV1 {
  seedKeyProfileId: string | null;
  levels: EcuSecurityLevelV1[];   // first entry = `{ecu.security.level}`
}

export interface EcuSecurityLevelV1 {
  key: string;                // REGISTRY_KEY_RE
  label: string;              // "Programming"
  level: number;              // requestSeed sub-function, odd 0x01..=0x7D
}

/** Well-known routine keys (others allowed). */
export const ECU_ROUTINE_KEYS = ['erase', 'checkIntegrity', 'checkDependencies', 'checkPreconditions'] as const;

export interface EcuRoutineV1 {
  key: string;                // REGISTRY_KEY_RE
  label: string;
  rid: string;                // exactly 4 hex digits, uppercase ("FF00")
}

export interface EcuMemoryRegionV1 {
  key: string;                // REGISTRY_KEY_RE
  label: string;
  start: number;              // u32
  length: number;             // > 0, start + length <= 2^32
}

export interface EcuFlashParamsV1 {
  alfid: number;              // both nibbles 1..4
  dfi: number;                // u8
  maxBlockLenOverride: number | null;   // decimal >= 3, null = ECU-reported (0x74)
  eraseAlfid: number;
  memoryRegions: EcuMemoryRegionV1[];   // non-overlapping
}

export interface EcuIdentificationV1 {
  expectedHw: string | null;
  expectedSparePart: string | null;
  vinDid: string;             // 4 hex, default "F190"
  swDid: string;              // default "F189"
  hwDid: string;              // default "F191"
  sparePartDid: string;       // default "F187"
}

export type EcuDidFormat = 'ascii' | 'hex' | 'uint' | 'int' | 'bcd';

export interface EcuDidV1 {
  did: string;                // 4 hex
  name: string;
  format: EcuDidFormat;
}

export interface EcuVarV1 {
  key: string;                // REGISTRY_KEY_RE
  value: string;
}

/** Pinned library reference (flow-platform-v1 §6). */
export interface FlowRefV1 {
  flowId: string;
  revision: number;
}

export type FlowBindingParamValue = string | number | boolean;

/** One Workbench column cell source: flow bound to one ECU. "Bind to group" creates one per member. */
export interface FlowBindingV1 {
  id: string;
  ecuId: string;
  flowRef: FlowRefV1;
  label: string | null;       // column label override; null = flow name
  /** Preset values for non-`ecu`, non-`file` flow inputs (file inputs are always asked at run time). */
  params: Record<string, FlowBindingParamValue>;
  order: number;
}

export interface NexusEcuFileV1 {
  schemaVersion: 1;
  kind: 'nexuscan.ecus';
  exportedAt: string;
  groups: EcuGroupV1[];
  ecus: EcuRecordV1[];
}

export const EMPTY_DIAGNOSTICS: DiagnosticsProjectV1 = { schemaVersion: 1, vehicles: [], activeVehicleId: null };
