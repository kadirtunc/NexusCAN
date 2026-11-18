/**
 * Flow interface (diag-workspace-v1 §8): derived from the `flow_input` / `flow_output` blocks, validated
 * (keys, uniqueness, the single `ecu` input) and used to resolve the run-time input values. Pure.
 */
import { t } from '../../i18n';
import { REGISTRY_KEY_RE } from '../../types/diagWorkspace';
import type { FlowInterfaceV1, FlowOutcomeSpecV1, FlowPortSpecV1 } from '../../types/flowLibrary';
import { requiredProtocols } from './blockDefs';
import {
  FLOW_INPUT,
  FLOW_OUTPUT,
  flowInputSpecs,
  flowOutputName,
  flowOutputOutcome,
  flowOutputSpecs,
} from './flowPorts';
import type { FlowDiagram } from './types';
import { formatValue } from './coreBlocks';
import { asBytes, hexField, numeric } from './flowValues';

export interface FlowIssue {
  /** Offending block id; `''` for a flow-level issue. */
  blockId: string;
  code: string;
  message: string;
}

/** The flow's entry block: the `flow_input` block, else the legacy `start`. */
export function findEntryBlock(diagram: Pick<FlowDiagram, 'blocks'>): FlowDiagram['blocks'][number] | undefined {
  return diagram.blocks.find((b) => b.type === FLOW_INPUT) ?? diagram.blocks.find((b) => b.type === 'start');
}

/** Interface of the flow; a legacy `start` flow (no `flow_input`) has no inputs and no declared outcomes. */
export function deriveFlowInterface(diagram: FlowDiagram): FlowInterfaceV1 {
  const input = diagram.blocks.find((b) => b.type === FLOW_INPUT);
  const outcomes: FlowOutcomeSpecV1[] = diagram.blocks
    .filter((b) => b.type === FLOW_OUTPUT)
    .map((b) => ({ name: flowOutputName(b), outcome: flowOutputOutcome(b), outputs: flowOutputSpecs(b) }));
  // A flow without a `flow_output` ends `ok` when its exec path finishes: that implicit outcome is part of the
  // interface so consumers (call blocks) never special-case it.
  if (outcomes.length === 0) outcomes.push({ name: 'ok', outcome: 'ok', outputs: [] });
  return {
    inputs: input ? flowInputSpecs(input) : [],
    outcomes,
    requiresProtocols: requiredProtocols(diagram),
  };
}

/** Key is usable as an interface key; `start` / `in` are the reserved exec port ids of the two blocks. */
function checkSpecs(
  specs: readonly FlowPortSpecV1[],
  blockId: string,
  reserved: string,
  issues: FlowIssue[],
  side: 'input' | 'output',
): void {
  const seen = new Set<string>();
  let ecuCount = 0;
  for (const s of specs) {
    const add = (code: string, message: string): void => {
      issues.push({ blockId, code, message });
    };
    if (!REGISTRY_KEY_RE.test(s.key) || s.key === reserved) {
      add(`${side}_key`, t('flowReg.val.key', { key: s.key, reserved }));
    } else if (seen.has(s.key)) {
      add(`${side}_dup`, t('flowReg.val.keyDup', { key: s.key }));
    }
    seen.add(s.key);
    if (s.type === 'ecu') {
      ecuCount += 1;
      if (s.key !== 'ecu') add('ecu_key', t('flowReg.val.ecuKey', { key: s.key }));
    } else if (s.key === 'ecu') {
      add('ecu_key', t('flowReg.val.ecuKeyType', { type: s.type }));
    }
    if (s.type === 'select' && (s.options === undefined || s.options.length === 0)) {
      add(`${side}_options`, t('flowReg.val.options', { key: s.key }));
    }
  }
  if (ecuCount > 1) issues.push({ blockId, code: 'ecu_multiple', message: t('flowReg.val.ecuMany') });
}

/** Static validation of the flow interface (localized, block-addressed). */
export function validateInterface(diagram: FlowDiagram): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const inputs = diagram.blocks.filter((b) => b.type === FLOW_INPUT);
  if (inputs.length > 1) {
    for (const b of inputs) issues.push({ blockId: b.id, code: 'input_multiple', message: t('flowReg.val.inputMany', { n: inputs.length }) });
  }
  for (const b of inputs) checkSpecs(flowInputSpecs(b), b.id, 'start', issues, 'input');

  const outs = diagram.blocks.filter((b) => b.type === FLOW_OUTPUT);
  const names = new Map<string, number>();
  for (const b of outs) {
    const n = flowOutputName(b).trim();
    names.set(n, (names.get(n) ?? 0) + 1);
  }
  for (const b of outs) {
    const n = flowOutputName(b).trim();
    if (n === '') issues.push({ blockId: b.id, code: 'output_name', message: t('flowReg.val.outName', { block: b.label }) });
    else if ((names.get(n) ?? 0) > 1) issues.push({ blockId: b.id, code: 'output_name_dup', message: t('flowReg.val.outDup', { name: n }) });
    checkSpecs(flowOutputSpecs(b), b.id, 'in', issues, 'output');
  }
  return issues;
}

// ─── Run inputs ────────────────────────────────────────────────────────────────

export interface ResolvedInputs {
  /** Value per input key (`Uint8Array` for hex / bytes / file, `number`, `string`, `boolean`). */
  values: Record<string, unknown>;
  errors: string[];
}

function asUint8(v: unknown): Uint8Array | null {
  return v instanceof Uint8Array ? v : null;
}

/** Value of an `ecu` input: a registry ECU record (an object with a string `id`). */
function isEcuValue(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !(v instanceof Uint8Array) && typeof (v as Record<string, unknown>)['id'] === 'string';
}

/**
 * Resolves the run-time values of the declared inputs from the user's `provided` map (falling back to the
 * spec default). An `ecu` input cannot be provided yet (ECU binding = B2): a required one refuses the run,
 * an optional one stays undefined.
 */
export function resolveRunInputs(specs: readonly FlowPortSpecV1[], provided: Readonly<Record<string, unknown>>): ResolvedInputs {
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const s of specs) {
    const label = s.label !== '' ? s.label : s.key;
    if (s.type === 'ecu') {
      const given = provided[s.key];
      if (isEcuValue(given)) values[s.key] = given;
      else if (s.required) errors.push(t('flowReg.run.ecuRequired', { name: label }));
      continue;
    }
    let raw: unknown = provided[s.key];
    if (raw === undefined || raw === null || raw === '') raw = s.default;
    const missing = raw === undefined || raw === null || raw === '';
    if (missing && s.type !== 'hex' && s.type !== 'text') {
      if (s.required) errors.push(t('flowReg.run.missing', { name: label }));
      continue;
    }
    try {
      switch (s.type) {
        case 'file':
        case 'bytes': {
          const b = asUint8(raw);
          const typed = b ?? asBytes(raw);
          if (typed) values[s.key] = typed;
          else if (typeof raw === 'string' && s.type === 'bytes') values[s.key] = Uint8Array.from(hexField(raw, label));
          else if (s.required) errors.push(t('flowReg.run.missing', { name: label }));
          break;
        }
        case 'hex': {
          if (missing) {
            if (s.required) errors.push(t('flowReg.run.missing', { name: label }));
            else values[s.key] = new Uint8Array(0);
          } else {
            values[s.key] = asBytes(raw) ?? Uint8Array.from(hexField(raw, label));
          }
          break;
        }
        case 'number': {
          const n = numeric(typeof raw === 'string' ? raw.trim() : raw);
          if (!Number.isFinite(n)) errors.push(t('flowReg.run.badNumber', { name: label, value: String(raw) }));
          else values[s.key] = n;
          break;
        }
        case 'bool': {
          const str = String(raw).trim().toLowerCase();
          if (raw === true || str === 'true' || str === '1') values[s.key] = true;
          else if (raw === false || str === 'false' || str === '0') values[s.key] = false;
          else errors.push(t('flowReg.run.badBool', { name: label, value: String(raw) }));
          break;
        }
        case 'select': {
          const v = String(raw);
          if (s.options !== undefined && !s.options.includes(v)) errors.push(t('flowReg.run.badOption', { name: label, value: v }));
          else values[s.key] = v;
          break;
        }
        default: {
          if (missing) {
            if (s.required) errors.push(t('flowReg.run.missing', { name: label }));
            else values[s.key] = '';
          } else {
            values[s.key] = typeof raw === 'string' ? raw : formatValue(raw);
          }
        }
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { values, errors };
}
