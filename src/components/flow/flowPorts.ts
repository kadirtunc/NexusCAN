/**
 * Interface ports of a flow (diag-workspace-v1 §8): `flow_input.config.inputs` and
 * `flow_output.config.outputs` are `FlowPortSpecV1[]`; the block ports are DERIVED from them
 * (one port per spec, port id = key). Pure, no dependency on the block catalog.
 */
import type { FlowOutcome, FlowPortSpecV1, FlowPortValueType } from '../../types/flowLibrary';
import type { FlowBlock, PortDef, PortType } from './types';

export const FLOW_INPUT = 'flow_input';
export const FLOW_OUTPUT = 'flow_output';

export const PORT_VALUE_TYPES: readonly FlowPortValueType[] = ['ecu', 'file', 'hex', 'number', 'text', 'bool', 'bytes', 'select'];
export const FLOW_OUTCOMES: readonly FlowOutcome[] = ['ok', 'fail', 'error'];

/** Block port type of an interface value type: ecu -> ecu, bytes / file -> bytes, bool -> bool, others -> data. */
export function portTypeOf(v: FlowPortValueType): PortType {
  switch (v) {
    case 'ecu': return 'ecu';
    case 'bytes':
    case 'file': return 'bytes';
    case 'bool': return 'bool';
    default: return 'data';
  }
}

function isPortValueType(v: unknown): v is FlowPortValueType {
  return typeof v === 'string' && (PORT_VALUE_TYPES as readonly string[]).includes(v);
}

/** Lenient reader of a stored spec list: drops entries that are not objects with a string key. */
export function readPortSpecs(raw: unknown): FlowPortSpecV1[] {
  if (!Array.isArray(raw)) return [];
  const out: FlowPortSpecV1[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o['key'] !== 'string') continue;
    const spec: FlowPortSpecV1 = {
      key: o['key'],
      label: typeof o['label'] === 'string' ? o['label'] : o['key'],
      type: isPortValueType(o['type']) ? o['type'] : 'text',
      required: o['required'] === true,
    };
    const d = o['default'];
    if (typeof d === 'string' || typeof d === 'number' || typeof d === 'boolean') spec.default = d;
    if (Array.isArray(o['options'])) spec.options = o['options'].filter((x): x is string => typeof x === 'string');
    out.push(spec);
  }
  return out;
}

export function flowInputSpecs(block: FlowBlock): FlowPortSpecV1[] {
  return readPortSpecs(block.config['inputs']);
}

export function flowOutputSpecs(block: FlowBlock): FlowPortSpecV1[] {
  return readPortSpecs(block.config['outputs']);
}

export function flowOutputName(block: FlowBlock): string {
  const n = block.config['name'];
  return typeof n === 'string' ? n : '';
}

export function flowOutputOutcome(block: FlowBlock): FlowOutcome {
  const o = block.config['outcome'];
  return o === 'fail' || o === 'error' ? o : 'ok';
}

/** Dynamic ports of an interface block (appended to its static ports); `null` for other blocks. */
export function interfacePorts(block: FlowBlock): PortDef[] | null {
  if (block.type === FLOW_INPUT) {
    return flowInputSpecs(block).map((s) => ({ id: s.key, label: s.key, type: portTypeOf(s.type), direction: 'output' as const }));
  }
  if (block.type === FLOW_OUTPUT) {
    return flowOutputSpecs(block).map((s) => ({ id: s.key, label: s.key, type: portTypeOf(s.type), direction: 'input' as const, optional: true }));
  }
  return null;
}

/** Stable cache key of an interface block's dynamic ports. */
export function interfacePortsKey(block: FlowBlock): string {
  const ports = interfacePorts(block);
  return ports === null ? '' : `${block.type}\u0000${ports.map((p) => `${p.id}:${p.type}`).join('\u0001')}`;
}
