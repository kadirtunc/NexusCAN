/**
 * Interface blocks of a flow (flow-interface-v2 §2): `flow_start`, one `flow_in` per input, one `flow_out` per
 * output and `flow_return` per outcome. The spec of a port lives in the block config (`FlowPortSpecV1`); the
 * block port is DERIVED from it (id `value`, type from the spec). Pure, no dependency on the block catalog.
 */
import type { FlowOutcome, FlowPortSpecV1, FlowPortValueType } from '../../types/flowLibrary';
import type { FlowBlock, PortDef, PortType } from './types';

export const FLOW_START = 'flow_start';
export const FLOW_IN = 'flow_in';
export const FLOW_OUT = 'flow_out';
export const FLOW_RETURN = 'flow_return';

/** v1 interface blocks (kept as `hidden` defs; load-time migration rewrites them, see `flowMigrate.ts`). */
export const LEGACY_START = 'start';
export const LEGACY_END = 'end';
export const LEGACY_FLOW_INPUT = 'flow_input';
export const LEGACY_FLOW_OUTPUT = 'flow_output';

/** Port id of `flow_in` / `flow_out`. */
export const VALUE_PORT = 'value';

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

function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Lenient reader of ONE stored spec (an object); `null` when `raw` is not an object with a string key. */
export function readPortSpec(raw: unknown): FlowPortSpecV1 | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o['key'] !== 'string') return null;
  const spec: FlowPortSpecV1 = {
    key: o['key'],
    label: typeof o['label'] === 'string' ? o['label'] : o['key'],
    type: isPortValueType(o['type']) ? o['type'] : 'text',
    required: o['required'] === true,
  };
  const d = o['default'];
  if (typeof d === 'string' || typeof d === 'number' || typeof d === 'boolean') spec.default = d;
  if (Array.isArray(o['options'])) spec.options = o['options'].filter((x): x is string => typeof x === 'string');
  const order = finiteNumber(o['order']);
  if (order !== undefined) spec.order = order;
  if (typeof o['description'] === 'string' && o['description'] !== '') spec.description = o['description'];
  if (typeof o['unit'] === 'string' && o['unit'] !== '') spec.unit = o['unit'];
  const min = finiteNumber(o['min']);
  if (min !== undefined) spec.min = min;
  const max = finiteNumber(o['max']);
  if (max !== undefined) spec.max = max;
  const bl = finiteNumber(o['byteLength']);
  if (bl !== undefined && Number.isInteger(bl) && bl > 0) spec.byteLength = bl;
  if (Array.isArray(o['accept'])) {
    const acc = o['accept'].filter((x): x is string => typeof x === 'string');
    if (acc.length > 0) spec.accept = acc;
  }
  return spec;
}

/** Lenient reader of a stored spec LIST (v1 `flow_input.inputs` / `flow_output.outputs`). */
export function readPortSpecs(raw: unknown): FlowPortSpecV1[] {
  if (!Array.isArray(raw)) return [];
  const out: FlowPortSpecV1[] = [];
  for (const item of raw) {
    const s = readPortSpec(item);
    if (s) out.push(s);
  }
  return out;
}

/** Spec of a `flow_in` / `flow_out` block (its config); a block without a string key reads as key `''`. */
export function blockPortSpec(block: FlowBlock): FlowPortSpecV1 {
  const c = block.config;
  return readPortSpec({ ...c, key: typeof c['key'] === 'string' ? c['key'] : '' }) as FlowPortSpecV1;
}

/** Ascending `order`, ties (and unordered) by key. */
export function sortPortSpecs(specs: readonly FlowPortSpecV1[]): FlowPortSpecV1[] {
  return [...specs].sort((a, b) => {
    const oa = a.order ?? Number.MAX_SAFE_INTEGER;
    const ob = b.order ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

export function flowInSpecs(diagram: { blocks: readonly FlowBlock[] }): FlowPortSpecV1[] {
  return sortPortSpecs(diagram.blocks.filter((b) => b.type === FLOW_IN).map(blockPortSpec));
}

export function flowOutSpecs(diagram: { blocks: readonly FlowBlock[] }): FlowPortSpecV1[] {
  return sortPortSpecs(diagram.blocks.filter((b) => b.type === FLOW_OUT).map(blockPortSpec));
}

export function returnName(block: FlowBlock): string {
  const n = block.config['name'];
  return typeof n === 'string' ? n : '';
}

export function returnOutcome(block: FlowBlock): FlowOutcome {
  const o = block.config['outcome'];
  return o === 'fail' || o === 'error' ? o : 'ok';
}

/** Dynamic ports of an interface block; `null` for other blocks. */
export function interfacePorts(block: FlowBlock): PortDef[] | null {
  if (block.type === FLOW_IN) {
    const s = blockPortSpec(block);
    return [{ id: VALUE_PORT, label: s.key !== '' ? s.key : VALUE_PORT, type: portTypeOf(s.type), direction: 'output' }];
  }
  if (block.type === FLOW_OUT) {
    const s = blockPortSpec(block);
    return [{ id: VALUE_PORT, label: s.key !== '' ? s.key : VALUE_PORT, type: portTypeOf(s.type), direction: 'input', optional: true }];
  }
  return null;
}

/** Stable cache key of an interface block's dynamic ports. */
export function interfacePortsKey(block: FlowBlock): string {
  const ports = interfacePorts(block);
  return ports === null ? '' : `${block.type}\u0000${ports.map((p) => `${p.id}:${p.label}:${p.type}`).join('\u0001')}`;
}
