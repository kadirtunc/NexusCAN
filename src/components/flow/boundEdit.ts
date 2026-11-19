/**
 * Pure diagram edits of bound parameters (flow-interface-v2 §3): bind a field to a `p:<key>` port, unbind it
 * (the port and its connection go away), and promote it to a flow input in one step. `FlowStore` wraps each of
 * them in ONE undo step.
 */
import { t } from '../../i18n';
import { REGISTRY_KEY_RE } from '../../types/diagWorkspace';
import type { FlowPortSpecV1, FlowPortValueType } from '../../types/flowLibrary';
import { FLASH_FILE_ACCEPT, bindableFields, boundPortId, readBoundParams, type BindableField } from './blockDefs';
import { bindableLabel } from './boundParams';
import { FLOW_IN, VALUE_PORT, blockPortSpec } from './flowPorts';
import type { FlowBlock, FlowConnection, FlowDiagram } from './types';

/** `file` -> file, number -> number, boolean -> bool, select -> select, hex -> hex, text / textarea -> text. */
export function promotedType(kind: BindableField['kind']): FlowPortValueType {
  switch (kind) {
    case 'file': return 'file';
    case 'number': return 'number';
    case 'boolean': return 'bool';
    case 'select': return 'select';
    case 'hex': return 'hex';
    default: return 'text';
  }
}

/** Field key as a registry key (`[A-Za-z][A-Za-z0-9_]{0,31}`) that is not taken (`_2`, `_3` ...) and not reserved. */
export function promotedKey(fieldKey: string, taken: ReadonlySet<string>): string {
  let base = fieldKey.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '');
  if (base === '') base = 'p';
  base = base.slice(0, 32);
  const bad = (k: string): boolean => taken.has(k) || k === 'in' || k === 'ecu' || !REGISTRY_KEY_RE.test(k);
  let key = base;
  let n = 2;
  while (bad(key)) {
    key = `${base.slice(0, 32 - `_${n}`.length)}_${n}`;
    n += 1;
  }
  return key;
}

function withBound(block: FlowBlock, keys: string[]): FlowBlock {
  return { ...block, config: { ...block.config, boundParams: keys } };
}

/** Adds `key` to the block's bound parameters (no-op when unknown / already bound). */
export function bindParam(diagram: FlowDiagram, blockId: string, key: string): FlowDiagram {
  const block = diagram.blocks.find((b) => b.id === blockId);
  if (!block || !bindableFields(block.type).some((f) => f.key === key)) return diagram;
  const keys = readBoundParams(block.config);
  if (keys.includes(key)) return diagram;
  return { ...diagram, blocks: diagram.blocks.map((b) => (b.id === blockId ? withBound(b, [...keys, key]) : b)) };
}

/** Removes `key` from the bound parameters together with the connection into its `p:` port. */
export function unbindParam(diagram: FlowDiagram, blockId: string, key: string): FlowDiagram {
  const block = diagram.blocks.find((b) => b.id === blockId);
  if (!block) return diagram;
  const keys = readBoundParams(block.config);
  if (!keys.includes(key)) return diagram;
  const port = boundPortId(key);
  const next = keys.filter((k) => k !== key);
  const config = { ...block.config };
  if (next.length === 0) delete config['boundParams'];
  else config['boundParams'] = next;
  return {
    ...diagram,
    blocks: diagram.blocks.map((b) => (b.id === blockId ? { ...b, config } : b)),
    connections: diagram.connections.filter((c) => !(c.toBlockId === blockId && c.toPortId === port)),
  };
}

export type PromoteResult =
  | { ok: true; diagram: FlowDiagram; flowInId: string; key: string }
  | { ok: false; reason: 'unknown' | 'wired' };

/** Default of the promoted input: the block's current config value (never for files). */
function currentDefault(block: FlowBlock, f: BindableField): FlowPortSpecV1['default'] {
  if (f.kind === 'file') return undefined;
  const v = block.config[f.key];
  if (f.kind === 'number') {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
  }
  if (f.kind === 'boolean') return typeof v === 'boolean' ? v : undefined;
  if (typeof v === 'string' && v !== '') return v;
  return undefined;
}

/**
 * "Flow girişine yükselt": creates a `flow_in` for the field (key = field key made unique, type mapped from the
 * field, label = field label, default = current value, select options / file `accept` copied), binds the field
 * and wires `flow_in.value -> block.p:key`, left of the block. Works on an unbound field and on a bound but
 * unwired `p:` port; refuses a port that already has a source.
 */
export function promoteParam(
  diagram: FlowDiagram,
  blockId: string,
  fieldKey: string,
  genId: (prefix: string) => string,
): PromoteResult {
  const block = diagram.blocks.find((b) => b.id === blockId);
  const f = block ? bindableFields(block.type).find((x) => x.key === fieldKey) : undefined;
  if (!block || !f) return { ok: false, reason: 'unknown' };
  const port = boundPortId(fieldKey);
  if (diagram.connections.some((c) => c.toBlockId === blockId && c.toPortId === port)) return { ok: false, reason: 'wired' };

  const ins = diagram.blocks.filter((b) => b.type === FLOW_IN).map(blockPortSpec);
  const key = promotedKey(fieldKey, new Set(ins.map((s) => s.key)));
  const spec: FlowPortSpecV1 = {
    key,
    label: bindableLabel(f),
    type: promotedType(f.kind),
    required: f.kind === 'file',
    order: ins.reduce((m, s) => Math.max(m, (s.order ?? -1) + 1), ins.length),
  };
  const d = currentDefault(block, f);
  if (d !== undefined) spec.default = d;
  if (f.kind === 'select') spec.options = [...(f.options ?? [])];
  if (f.kind === 'file') spec.accept = [...FLASH_FILE_ACCEPT];

  const keys = readBoundParams(block.config);
  const boundIdx = keys.includes(fieldKey) ? keys.indexOf(fieldKey) : keys.length;
  const flowIn: FlowBlock = {
    id: genId('in'),
    type: FLOW_IN,
    label: spec.label !== '' ? spec.label : key,
    x: block.x - 240,
    y: block.y + boundIdx * 60,
    config: { ...spec },
    status: 'idle',
    collapsed: false,
  };
  const conn: FlowConnection = { id: genId('c'), fromBlockId: flowIn.id, fromPortId: VALUE_PORT, toBlockId: blockId, toPortId: port };
  const blocks = diagram.blocks.map((b) => (b.id === blockId ? (keys.includes(fieldKey) ? b : withBound(b, [...keys, fieldKey])) : b));
  return { ok: true, diagram: { ...diagram, blocks: [...blocks, flowIn], connections: [...diagram.connections, conn] }, flowInId: flowIn.id, key };
}

/** Message of a refused promote (for the inspector). */
export function promoteError(reason: 'unknown' | 'wired'): string {
  return t(reason === 'wired' ? 'flowIface.promote.wired' : 'flowIface.promote.unknown');
}
