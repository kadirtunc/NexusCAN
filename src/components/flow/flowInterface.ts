/**
 * Flow interface (flow-interface-v2): derived from the `flow_start` / `flow_in` / `flow_out` / `flow_return`
 * blocks, validated (keys, uniqueness, the single `ecu` input, bound parameters) and used to resolve the
 * run-time input values. Pure.
 */
import { t } from '../../i18n';
import { REGISTRY_KEY_RE } from '../../types/diagWorkspace';
import type { FlowFileValue, FlowInterfaceV1, FlowOutcomeSpecV1, FlowPortSpecV1 } from '../../types/flowLibrary';
import { listEcuRefs } from '../diagnostics/workspace/ecuRefs';
import { bindableFields, boundPortId, readBoundParams, requiredProtocols } from './blockDefs';
import {
  FLOW_IN,
  FLOW_OUT,
  FLOW_RETURN,
  FLOW_START,
  blockPortSpec,
  flowInSpecs,
  flowOutSpecs,
  returnName,
  returnOutcome,
} from './flowPorts';
import type { FlowDiagram } from './types';
import { formatValue } from './coreBlocks';
import { asBytes, hexField, isFlowFileValue, numeric } from './flowValues';

export interface FlowIssue {
  /** Offending block id; `''` for a flow-level issue. */
  blockId: string;
  code: string;
  message: string;
}

/** The flow's entry block: its `flow_start` (first one when invalid data has several). */
export function findEntryBlock(diagram: Pick<FlowDiagram, 'blocks'>): FlowDiagram['blocks'][number] | undefined {
  return diagram.blocks.find((b) => b.type === FLOW_START);
}

/**
 * Interface of the flow: inputs / outputs sorted by (order, key); outcomes in block order, a repeated name
 * counts once; a flow without a `flow_return` ends `ok` when its exec path finishes (implicit outcome).
 */
export function deriveFlowInterface(diagram: FlowDiagram): FlowInterfaceV1 {
  const outcomes: FlowOutcomeSpecV1[] = [];
  for (const b of diagram.blocks) {
    if (b.type !== FLOW_RETURN) continue;
    const name = returnName(b);
    if (!outcomes.some((o) => o.name === name)) outcomes.push({ name, outcome: returnOutcome(b) });
  }
  if (outcomes.length === 0) outcomes.push({ name: 'ok', outcome: 'ok' });
  return {
    inputs: flowInSpecs(diagram),
    outcomes,
    outputs: flowOutSpecs(diagram),
    requiresProtocols: requiredProtocols(diagram),
  };
}

/** `in(ecu, image) → ok · fail | out(crc32)`: the derived interface of a flow as one line (flow-interface-v2 §7). */
export function interfaceSummary(diagram: FlowDiagram): string {
  const iface = deriveFlowInterface(diagram);
  const ins = iface.inputs.map((i) => i.key).join(', ');
  const outcomes = iface.outcomes.map((o) => (o.name !== '' ? o.name : o.outcome)).join(' · ');
  const outs = iface.outputs.map((o) => o.key).join(', ');
  return `in(${ins}) → ${outcomes}${outs !== '' ? ` | out(${outs})` : ''}`;
}

/** Per-spec checks shared by `flow_in` and `flow_out`. */
function checkSpec(
  s: FlowPortSpecV1,
  blockId: string,
  side: 'input' | 'output',
  seen: Set<string>,
  reservedKeys: ReadonlySet<string>,
  issues: FlowIssue[],
): void {
  const add = (code: string, message: string): void => {
    issues.push({ blockId, code, message });
  };
  const reservedOwn = side === 'input' ? s.key === 'in' : s.key === 'in' || s.key === 'error';
  if (!REGISTRY_KEY_RE.test(s.key) || reservedOwn) {
    add(`${side}_key`, t('flowReg.val.key', { key: s.key, reserved: side === 'input' ? 'in' : 'in / error' }));
  } else if (reservedKeys.has(s.key)) {
    add('output_reserved', t('flowIface.val.outReserved', { key: s.key }));
  } else if (seen.has(s.key)) {
    add(`${side}_dup`, t('flowReg.val.keyDup', { key: s.key }));
  }
  seen.add(s.key);
  if (s.type === 'ecu') {
    if (s.key !== 'ecu') add('ecu_key', t('flowReg.val.ecuKey', { key: s.key }));
  } else if (s.key === 'ecu') {
    add('ecu_key', t('flowReg.val.ecuKeyType', { type: s.type }));
  }
  if (s.type === 'select' && (s.options === undefined || s.options.length === 0)) {
    add(`${side}_options`, t('flowReg.val.options', { key: s.key }));
  }
  if (s.min !== undefined && s.max !== undefined && s.min > s.max) {
    add(`${side}_range`, t('flowIface.val.range', { key: s.key, min: s.min, max: s.max }));
  }
}

/** Bound-parameter rules: every bound key is a known bindable field and its `p:` port is wired. */
function checkBound(diagram: FlowDiagram, issues: FlowIssue[]): void {
  for (const b of diagram.blocks) {
    const keys = readBoundParams(b.config);
    if (keys.length === 0) continue;
    const fields = bindableFields(b.type);
    for (const key of keys) {
      if (!fields.some((f) => f.key === key)) {
        issues.push({ blockId: b.id, code: 'bound_unknown', message: t('flowIface.val.boundUnknown', { block: b.label, key }) });
      } else if (!diagram.connections.some((c) => c.toBlockId === b.id && c.toPortId === boundPortId(key))) {
        issues.push({ blockId: b.id, code: 'bound_unwired', message: t('flowIface.val.boundUnwired', { block: b.label, port: boundPortId(key) }) });
      }
    }
  }
}

/** Static validation of the flow interface (localized, block-addressed). */
export function validateInterface(diagram: FlowDiagram): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const starts = diagram.blocks.filter((b) => b.type === FLOW_START);
  if (starts.length === 0) issues.push({ blockId: '', code: 'no_entry', message: t('flowIface.val.noEntry') });
  else if (starts.length > 1) {
    for (const b of starts) issues.push({ blockId: b.id, code: 'start_multiple', message: t('flowIface.val.startMany', { n: starts.length }) });
  }

  const ins = diagram.blocks.filter((b) => b.type === FLOW_IN);
  const seenIn = new Set<string>();
  for (const b of ins) checkSpec(blockPortSpec(b), b.id, 'input', seenIn, new Set(), issues);
  if (ins.filter((b) => blockPortSpec(b).type === 'ecu').length > 1) {
    issues.push({ blockId: '', code: 'ecu_multiple', message: t('flowReg.val.ecuMany') });
  }

  const returns = diagram.blocks.filter((b) => b.type === FLOW_RETURN);
  // Without a `flow_return` the implicit outcome `ok` still owns the port id `ok`.
  const reservedOut = new Set<string>(returns.length === 0 ? ['ok'] : returns.map((b) => returnName(b).trim()));
  const seenOut = new Set<string>();
  for (const b of diagram.blocks.filter((x) => x.type === FLOW_OUT)) {
    const spec = blockPortSpec(b);
    checkSpec(spec, b.id, 'output', seenOut, reservedOut, issues);
    const conflict = b.config['migrateConflict'];
    if (typeof conflict === 'string' && conflict !== '') {
      issues.push({ blockId: b.id, code: 'migrate_output_conflict', message: t('flowIface.val.migrateConflict', { key: spec.key, detail: conflict }) });
    }
  }
  // `flow_return` names: non-empty, not `in`, unique. Repeated returns with the SAME outcome are one outcome
  // (outputs are flow-level, so they cannot differ): only a name used with different outcomes is ambiguous.
  const byName = new Map<string, Set<string>>();
  for (const b of returns) {
    const n = returnName(b).trim();
    byName.set(n, (byName.get(n) ?? new Set()).add(returnOutcome(b)));
  }
  for (const b of returns) {
    const n = returnName(b).trim();
    if (n === '') issues.push({ blockId: b.id, code: 'return_name', message: t('flowIface.val.returnEmpty', { block: b.label }) });
    else if (n === 'in') issues.push({ blockId: b.id, code: 'return_reserved', message: t('flowIface.val.returnReserved', { name: n }) });
    else if ((byName.get(n)?.size ?? 0) > 1) issues.push({ blockId: b.id, code: 'return_name_dup', message: t('flowIface.val.returnDup', { name: n }) });
  }
  checkBound(diagram, issues);
  return issues;
}

/** Live-editor rule: `{ecu.*}` references need an `ecu` `flow_in` (the run-time check lives in `ecuBinding.ts`). */
export function validateEcuRefs(diagram: FlowDiagram): FlowIssue[] {
  const hasEcu = diagram.blocks.some((b) => b.type === FLOW_IN && blockPortSpec(b).type === 'ecu');
  if (hasEcu) return [];
  const uses = diagram.blocks.filter((b) => listEcuRefs(b.config).length > 0);
  return uses.map((b) => ({ blockId: b.id, code: 'ecu_undeclared', message: t('flowIface.val.ecuUndeclared', { block: b.label }) }));
}

// ─── Run inputs ────────────────────────────────────────────────────────────────

export interface ResolvedInputs {
  /**
   * Value per input key: `FlowFileValue` for file, `Uint8Array` for hex / bytes, `number`, `string`, `boolean`,
   * the ECU record for `ecu`.
   */
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

/** Lower-case extension (with the dot) of a file name; `''` when there is none. */
function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

/**
 * Resolves the run-time values of the declared inputs from the `provided` map (falling back to the spec
 * default) and checks them against the spec: `min` / `max` (an out-of-range number is an error, never clamped),
 * `byteLength`, `accept` (file extension), select options. An `ecu` input is the registry ECU record chosen in
 * the run form (or the ECU bound by the caller); a required one that is missing refuses the run.
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
    const checkLength = (b: Uint8Array): boolean => {
      if (s.byteLength !== undefined && b.length !== s.byteLength) {
        errors.push(t('flowIface.run.byteLength', { name: label, n: b.length, want: s.byteLength }));
        return false;
      }
      return true;
    };
    try {
      switch (s.type) {
        case 'file': {
          let file: FlowFileValue | null = null;
          if (isFlowFileValue(raw)) file = raw;
          else {
            const b = asBytes(raw);
            if (b) file = { name: '', bytes: b };
          }
          if (file === null) {
            errors.push(t('flowIface.run.badBytes', { name: label }));
          } else if (s.accept !== undefined && s.accept.length > 0 && file.name !== '' && !s.accept.map((x) => x.toLowerCase()).includes(extOf(file.name))) {
            errors.push(t('flowIface.run.accept', { name: label, file: file.name, accept: s.accept.join(' ') }));
          } else {
            values[s.key] = file;
          }
          break;
        }
        case 'bytes': {
          const b = asUint8(raw) ?? asBytes(raw) ?? (typeof raw === 'string' ? Uint8Array.from(hexField(raw, label)) : null);
          if (b === null) errors.push(t('flowIface.run.badBytes', { name: label }));
          else if (checkLength(b)) values[s.key] = b;
          break;
        }
        case 'hex': {
          if (missing) {
            if (s.required) errors.push(t('flowReg.run.missing', { name: label }));
            else values[s.key] = new Uint8Array(0);
          } else {
            const b = asBytes(raw) ?? Uint8Array.from(hexField(raw, label));
            if (checkLength(b)) values[s.key] = b;
          }
          break;
        }
        case 'number': {
          const n = numeric(typeof raw === 'string' ? raw.trim() : raw);
          if (!Number.isFinite(n)) errors.push(t('flowReg.run.badNumber', { name: label, value: String(raw) }));
          else if ((s.min !== undefined && n < s.min) || (s.max !== undefined && n > s.max)) {
            errors.push(t('flowIface.run.range', {
              name: label, value: n, min: s.min !== undefined ? s.min : '−∞', max: s.max !== undefined ? s.max : '∞', unit: s.unit ?? '',
            }));
          } else values[s.key] = n;
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
