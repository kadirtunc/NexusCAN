/**
 * Workbench model (workbench-v1 §9.3 / §10). Pure: no React, no Tauri, no stores. Binding form generation,
 * `{ecu.*}` parameter resolution, update-to-latest reconciliation, firmware CRC gate, review-gate item list,
 * cell display and run-record construction.
 */
import { t } from '../../../i18n';
import type { EcuRecordV1, FileExpectV1, FlowBindingParamValue, FlowBindingV1, FlowRefV1 } from '../../../types/diagWorkspace';
import type { FlowFileValue, FlowInterfaceV1, FlowPortSpecV1 } from '../../../types/flowLibrary';
import type { RunFileRefV1, RunOutcome, RunRecordV1, RunValue } from '../../../types/runRecord';
import { crc32 } from '../../flow/flowAlgos';
import { isCallType, readCallRef } from '../../flow/callIndex';
import type { FlowRunResult } from '../../flow/FlowEngine';
import type { FlowDiagram } from '../../flow/types';
import { ecuSnapshotHash as refEcuSnapshotHash, resolveEcuRefs } from '../workspace/ecuRefs';

// ─── Binding form ───────────────────────────────────────────────────────────────

export type WbFieldKind = 'number' | 'text' | 'bool' | 'bytes' | 'hex' | 'select' | 'file';

export interface WbFormField {
  key: string;
  label: string;
  kind: WbFieldKind;
  required: boolean;
  order: number;
  unit?: string;
  min?: number;
  max?: number;
  byteLength?: number;
  options?: { value: string; label: string }[];
  accept?: string[];
  description?: string;
  defaultValue?: string | number | boolean | null;
}

/** A flow can be bound to an ECU when its interface declares an `ecu` input. */
export function isBindableInterface(iface: FlowInterfaceV1): boolean {
  return iface.inputs.some((s) => s.type === 'ecu');
}

/** Inputs without the `ecu` one, sorted by (order, key) regardless of the array position. */
function sortedInputs(iface: FlowInterfaceV1): FlowPortSpecV1[] {
  return iface.inputs
    .filter((s) => s.type !== 'ecu')
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.order ?? Number.MAX_SAFE_INTEGER) - (b.s.order ?? Number.MAX_SAFE_INTEGER) || (a.s.key < b.s.key ? -1 : a.s.key > b.s.key ? 1 : a.i - b.i))
    .map((x) => x.s);
}

export function buildBindingForm(iface: FlowInterfaceV1): WbFormField[] {
  return sortedInputs(iface).map((s, idx): WbFormField => {
    const f: WbFormField = {
      key: s.key,
      label: s.label !== '' ? s.label : s.key,
      kind: s.type === 'ecu' ? 'text' : s.type,
      required: s.required,
      order: idx,
    };
    if (s.unit !== undefined) f.unit = s.unit;
    if (s.min !== undefined) f.min = s.min;
    if (s.max !== undefined) f.max = s.max;
    if (s.byteLength !== undefined) f.byteLength = s.byteLength;
    if (s.options !== undefined) f.options = s.options.map((o) => ({ value: o, label: o }));
    if (s.accept !== undefined) f.accept = [...s.accept];
    if (s.description !== undefined) f.description = s.description;
    if (s.default !== undefined) f.defaultValue = s.default;
    return f;
  });
}

// ─── Parameter resolution ───────────────────────────────────────────────────────

export type WbParamIssue = { key: string; code: 'missing' | 'type' | 'range' | 'ecu_ref' | 'unknown_key'; message: string };
export type WbResolved =
  | { status: 'ready'; params: Record<string, RunValue>; notes: WbParamIssue[] }
  | { status: 'incomplete'; missing: string[]; issues: WbParamIssue[] }
  | { status: 'invalid'; issues: WbParamIssue[] };

const WHOLE_REF_RE = /^\{ecu\.[^{}]*\}$/;
const DEC_RE = /^[+-]?\d+(\.\d+)?$/;
const HEX_NUM_RE = /^0x[0-9a-f]+$/i;

/** Decimal or `0x` hex text -> number; `null` when it is neither. */
function parseNumber(s: string): number | null {
  const x = s.trim();
  if (HEX_NUM_RE.test(x)) return Number.parseInt(x.slice(2), 16);
  if (DEC_RE.test(x)) return Number(x);
  return null;
}

function isBlank(v: FlowBindingParamValue | undefined): boolean {
  return v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Hex text (spaces allowed, even digit count) -> upper-case compact hex; `null` when malformed. */
function normHex(s: string): { hex: string; bytes: number } | null {
  const c = s.replace(/\s+/g, '');
  if (c === '' || c.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(c)) return null;
  return { hex: c.toUpperCase(), bytes: c.length / 2 };
}

export function resolveBindingParams(binding: FlowBindingV1, iface: FlowInterfaceV1, ecu: EcuRecordV1): WbResolved {
  const params: Record<string, RunValue> = {};
  const issues: WbParamIssue[] = [];
  const notes: WbParamIssue[] = [];
  const missing: string[] = [];
  const specs = sortedInputs(iface);
  const known = new Set(specs.map((s) => s.key));

  for (const key of Object.keys(binding.params)) {
    if (!known.has(key)) {
      const n: WbParamIssue = { key, code: 'unknown_key', message: t('workbench.issue.unknownKey', { key }) };
      notes.push(n);
      issues.push(n);
    }
  }

  for (const s of specs) {
    const label = s.label !== '' ? s.label : s.key;
    if (s.type === 'file') {
      if (binding.fileExpect?.[s.key] === undefined && s.required) missing.push(s.key);
      continue;
    }
    let raw: FlowBindingParamValue | undefined = binding.params[s.key];
    if (isBlank(raw)) raw = undefined;
    if (raw === undefined) {
      if (s.default !== undefined) raw = s.default;
      else {
        if (s.required) missing.push(s.key);
        continue;
      }
    }
    // A whole `{ecu.<path>}` string is a reference (resolved per row ECU); anything else is a literal.
    if (typeof raw === 'string' && WHOLE_REF_RE.test(raw)) {
      const r = resolveEcuRefs({ v: raw }, ecu);
      if (r.errors.length > 0) {
        issues.push({ key: s.key, code: 'ecu_ref', message: `${label}: ${r.errors[0].message}` });
        continue;
      }
      raw = String(r.config['v']);
      if (raw === '') {
        if (s.required) missing.push(s.key);
        continue;
      }
    }
    const bad = (code: 'type' | 'range', message: string): void => {
      issues.push({ key: s.key, code, message: `${label}: ${message}` });
    };
    switch (s.type) {
      case 'number': {
        const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseNumber(raw) : null;
        if (n === null || !Number.isFinite(n)) bad('type', t('workbench.issue.notNumber', { value: String(raw) }));
        else if ((s.min !== undefined && n < s.min) || (s.max !== undefined && n > s.max)) {
          bad('range', t('workbench.issue.range', { value: n, min: s.min ?? '−∞', max: s.max ?? '∞' }));
        } else params[s.key] = n;
        break;
      }
      case 'bool': {
        const str = String(raw).trim().toLowerCase();
        if (raw === true || str === 'true' || str === '1') params[s.key] = true;
        else if (raw === false || str === 'false' || str === '0') params[s.key] = false;
        else bad('type', t('workbench.issue.notBool', { value: String(raw) }));
        break;
      }
      case 'select': {
        const v = String(raw);
        if (s.options !== undefined && !s.options.includes(v)) bad('type', t('workbench.issue.notOption', { value: v }));
        else params[s.key] = v;
        break;
      }
      case 'hex':
      case 'bytes': {
        const h = typeof raw === 'string' ? normHex(raw) : null;
        if (h === null) bad('type', t('workbench.issue.notHex', { value: String(raw) }));
        else if (s.byteLength !== undefined && h.bytes !== s.byteLength) bad('type', t('workbench.issue.byteLength', { n: h.bytes, want: s.byteLength }));
        else params[s.key] = h.hex;
        break;
      }
      default:
        params[s.key] = String(raw);
    }
  }

  const blocking = issues.filter((i) => i.code !== 'unknown_key');
  if (blocking.length > 0) return { status: 'invalid', issues };
  if (missing.length > 0) {
    const ml: WbParamIssue[] = missing.map((key) => ({ key, code: 'missing', message: t('workbench.issue.missing', { key }) }));
    return { status: 'incomplete', missing, issues: [...ml, ...issues] };
  }
  return { status: 'ready', params, notes };
}

// ─── Update to latest revision ──────────────────────────────────────────────────

export interface WbReconcileResult {
  binding: FlowBindingV1;
  /** Removed param keys AND removed `fileExpect` keys (deduped, sorted). */
  dropped: string[];
  newlyMissing: string[];
}

export function reconcileBindingToRevision(binding: FlowBindingV1, next: FlowInterfaceV1, nextRevision: number): WbReconcileResult {
  const specs = sortedInputs(next);
  const byKey = new Map(specs.map((s) => [s.key, s] as const));
  const dropped = new Set<string>();
  const params: Record<string, FlowBindingParamValue> = {};
  for (const key of Object.keys(binding.params)) {
    if (byKey.has(key)) params[key] = binding.params[key];
    else dropped.add(key);
  }
  const fileExpect: Record<string, FileExpectV1> = {};
  for (const key of Object.keys(binding.fileExpect ?? {})) {
    if (byKey.get(key)?.type === 'file') fileExpect[key] = { ...(binding.fileExpect as Record<string, FileExpectV1>)[key] };
    else dropped.add(key);
  }
  const newlyMissing: string[] = [];
  for (const s of specs) {
    if (!s.required) continue;
    if (s.type === 'file') {
      if (fileExpect[s.key] === undefined) newlyMissing.push(s.key);
    } else if (isBlank(params[s.key]) && s.default === undefined) newlyMissing.push(s.key);
  }
  const out: FlowBindingV1 = {
    id: binding.id,
    ecuId: binding.ecuId,
    flowRef: { flowId: binding.flowRef.flowId, revision: nextRevision },
    label: binding.label,
    params,
    order: binding.order,
  };
  if (Object.keys(fileExpect).length > 0) out.fileExpect = fileExpect;
  return { binding: out, dropped: [...dropped].sort(), newlyMissing };
}

// ─── Firmware CRC ───────────────────────────────────────────────────────────────

/** IEEE CRC-32, 8 upper-case hex digits. */
export function crc32Hex(bytes: Uint8Array): string {
  return crc32(bytes).toString(16).toUpperCase().padStart(8, '0');
}

export type WbFileCheck = { ok: true; ref: RunFileRefV1 } | { ok: false; key: string; expected: string; actual: string };

/** A CRC mismatch refuses the run. A different file NAME with a matching CRC is allowed (the record keeps the chosen name). */
export function checkFileExpectation(binding: FlowBindingV1, key: string, file: FlowFileValue): WbFileCheck {
  const actual = crc32Hex(file.bytes);
  const expected = (binding.fileExpect?.[key]?.crc32 ?? '').toUpperCase();
  if (expected === '' || expected !== actual) return { ok: false, key, expected, actual };
  return { ok: true, ref: { key, name: file.name, size: file.bytes.length, crc32: actual } };
}

// ─── Review gate ────────────────────────────────────────────────────────────────

export interface WbReviewItem {
  /** `Flash ECU › Programming › Erase FF00` */
  path: string;
  blockType: string;
}

/** Block types that always write / erase / download (until computed warning levels exist). */
const WRITING_TYPES: ReadonlySet<string> = new Set([
  'uds_flash_image', 'uds_req_download', 'uds_request_download', 'uds_write_memory', 'uds_write_did',
]);
const MAX_REVIEW_DEPTH = 64;

function routineIdOf(config: Record<string, unknown>): string {
  const sel = typeof config['routine_id'] === 'string' ? config['routine_id'] : '';
  if (sel === 'custom') return typeof config['routine_id_custom'] === 'string' ? config['routine_id_custom'] : '';
  return sel;
}

/** Erase routine (`FF00`) or any routine id given as an `{ecu.*}` reference (conservative). */
function isEraseRoutine(config: Record<string, unknown>): boolean {
  const rid = routineIdOf(config).trim();
  return rid.toUpperCase() === 'FF00' || rid.includes('{ecu.');
}

/** Flash / erase / write blocks of the body and of every (non-recursive) callee, in execution-graph order. */
export function reviewItems(body: FlowDiagram, rootName: string, loadCallee: (ref: FlowRefV1) => FlowDiagram | null): WbReviewItem[] {
  const out: WbReviewItem[] = [];
  const walk = (d: FlowDiagram, path: string[], stack: ReadonlySet<string>, depth: number): void => {
    for (const b of d.blocks) {
      const label = b.label !== '' ? b.label : b.type;
      if (isCallType(b.type)) {
        const ref = readCallRef(b);
        if (!ref || depth >= MAX_REVIEW_DEPTH || stack.has(ref.flowId)) continue;
        const callee = loadCallee(ref);
        if (callee) walk(callee, [...path, callee.name !== '' ? callee.name : label], new Set([...stack, ref.flowId]), depth + 1);
      } else if (WRITING_TYPES.has(b.type) || (b.type === 'uds_routine_ctrl' && isEraseRoutine(b.config))) {
        out.push({ path: [...path, label].join(' › '), blockType: b.type });
      }
    }
  };
  walk(body, [rootName], new Set([body.id]), 0);
  return out;
}

// ─── Cell display / outcome mapping ─────────────────────────────────────────────

export type WbCellView = { chip: 'none' | 'ok' | 'warn' | 'critical'; text: string };

export function cellView(rec: RunRecordV1 | null): WbCellView {
  if (rec === null) return { chip: 'none', text: '' };
  switch (rec.outcome) {
    case 'ok':
      return { chip: 'ok', text: rec.outputName ?? 'ok' };
    case 'fail':
      if (rec.outputName === 'bootloader_fail') return { chip: 'critical', text: t('workbench.cell.bootloader') };
      return { chip: 'warn', text: rec.outputName ?? 'fail' };
    case 'error':
      return { chip: 'critical', text: rec.errorMessage ?? 'error' };
    case 'aborted':
      return { chip: 'warn', text: t('workbench.cell.aborted') };
    case 'panic_stop':
      return { chip: 'critical', text: t('workbench.cell.panic') };
  }
}

export function mapOutcome(r: { outcome: 'ok' | 'fail' | 'error'; stopped: boolean }, stopKind: 'user' | 'panic' | null): RunOutcome {
  if (r.stopped) return stopKind === 'panic' ? 'panic_stop' : 'aborted';
  return r.outcome;
}

// ─── Run record ─────────────────────────────────────────────────────────────────

export interface WbRecordInput {
  runId: string;
  projectId: string;
  vehicleId: string | null;
  ecu: EcuRecordV1;
  flowId: string;
  flowRevision: number;
  flowContentHash: string;
  flowName: string;
  params: Record<string, RunValue>;
  files: RunFileRefV1[];
  startedAtMs: number;
  endedAtMs: number;
  result: FlowRunResult;
  stopKind: 'user' | 'panic' | null;
  log: string[];
  deviceId: string;
  appVersion: string;
  ecuSnapshotHash: string;
}

const LOG_MAX_LINES = 200;
const LOG_MAX_CHARS = 512;

function hexUpper(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).toUpperCase().padStart(2, '0')).join('');
}

/** Flow output value -> `RunValue` (bytes -> upper hex); `undefined` = not representable (dropped). */
function toRunValue(v: unknown): RunValue | undefined {
  if (v === null) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (v instanceof Uint8Array) return hexUpper(v);
  return undefined;
}

/** Last `✗` log line without its time stamp, as the run's error text (outcome `error` only). */
function errorTextOf(log: readonly string[]): string | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const k = log[i].indexOf('✗');
    if (k >= 0) return log[i].slice(k + 1).trim().slice(0, LOG_MAX_CHARS) || null;
  }
  return null;
}

export function buildRunRecord(i: WbRecordInput): RunRecordV1 {
  const outcome = mapOutcome({ outcome: i.result.outcome, stopped: i.result.stopped }, i.stopKind);
  const outputs: Record<string, RunValue> = {};
  for (const key of Object.keys(i.result.outputs)) {
    const v = toRunValue(i.result.outputs[key]);
    if (v !== undefined) outputs[key] = v;
  }
  const endedMs = Math.max(i.endedAtMs, i.startedAtMs);
  const errorMessage = outcome === 'error' ? errorTextOf(i.log) : null;
  const nrc = errorMessage !== null ? /NRC 0x([0-9A-Fa-f]{2})/.exec(errorMessage) : null;
  return {
    schemaVersion: 1,
    runId: i.runId,
    parentRunId: null,
    queueId: null,
    projectId: i.projectId,
    vehicleId: i.vehicleId,
    ecuId: i.ecu.id,
    ecuName: i.ecu.name,
    ecuSnapshotHash: i.ecuSnapshotHash,
    flowId: i.flowId,
    flowRevision: i.flowRevision,
    flowContentHash: i.flowContentHash,
    flowName: i.flowName,
    params: { ...i.params },
    files: i.files.map((f) => ({ ...f })),
    startedAt: new Date(i.startedAtMs).toISOString(),
    endedAt: new Date(endedMs).toISOString(),
    durationMs: Math.max(0, Math.round(i.endedAtMs - i.startedAtMs)),
    outcome,
    outputName: i.result.name,
    outputs,
    nrc: nrc ? Number.parseInt(nrc[1], 16) : null,
    errorMessage,
    logExcerpt: i.log.slice(-LOG_MAX_LINES).map((l) => l.slice(0, LOG_MAX_CHARS)),
    operator: null,
    deviceId: i.deviceId,
    appVersion: i.appVersion,
  };
}

/** sha-256 (lower hex) of the canonical JSON of the ECU record. */
export function ecuSnapshotHash(ecu: EcuRecordV1): Promise<string> {
  return refEcuSnapshotHash(ecu);
}
