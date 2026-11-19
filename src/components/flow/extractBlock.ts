/**
 * "Make Custom Block from selection" (pure). The selection becomes the body of a new `nexuscan.block`:
 * `flow_in` inputs come from the incoming data edges, `flow_return` outcomes from the distinct outgoing exec
 * edges (named after the source port: `exec_out` -> `ok`, `error_out` -> `error`), `flow_out` outputs from the
 * outgoing data edges; `flow_start` starts the body. The parent gets a call block wired to the same neighbours. Refuses selections whose semantics would
 * change silently (several entry edges, variables shared with the rest of the flow, loop control without its loop).
 */
import { t } from '../../i18n';
import { REGISTRY_KEY_RE } from '../../types/diagWorkspace';
import type { FlowPortSpecV1, FlowPortValueType } from '../../types/flowLibrary';
import { listEcuRefs } from '../diagnostics/workspace/ecuRefs';
import { getBlockDefFor } from './blockDefs';
import { callType } from './callIndex';
import { LOOP_BLOCKS } from './coreRuntime';
import { FLOW_IN, FLOW_OUT, FLOW_RETURN, FLOW_START, LEGACY_START, VALUE_PORT, blockPortSpec } from './flowPorts';
import { variableReferences } from './flowVars';
import type { FlowBlock, FlowConnection, FlowDiagram, PortType } from './types';
import { CALL_IN } from './callPorts';

export type ExtractionResult =
  | { ok: false; message: string }
  | {
      ok: true;
      /** The new custom block's diagram (id / name set; save as `nexuscan.block` r1). */
      callee: FlowDiagram;
      /** Parent diagram with the selection replaced by a call block pinned to `revision` of the callee. */
      apply: (revision: number) => FlowDiagram;
      inputs: FlowPortSpecV1[];
      outcomes: string[];
    };

const UNSUPPORTED = new Set<string>([FLOW_START, FLOW_IN, FLOW_OUT, FLOW_RETURN, LEGACY_START, 'flow_terminal', 'flow_goto']);

function sanitizeKey(raw: string): string {
  let s = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '');
  if (s === '' || !/^[A-Za-z]/.test(s)) s = `p${s}`;
  return s.slice(0, 32);
}

function uniqueKey(base: string, taken: ReadonlySet<string>): string {
  let key = sanitizeKey(base);
  let n = 2;
  while (taken.has(key) || key === 'in' || !REGISTRY_KEY_RE.test(key)) {
    key = `${sanitizeKey(base).slice(0, 28)}_${n}`;
    n += 1;
  }
  return key;
}

function valueTypeOf(type: PortType): FlowPortValueType {
  switch (type) {
    case 'bytes': return 'bytes';
    case 'bool': return 'bool';
    case 'ecu': return 'ecu';
    default: return 'text';
  }
}

/** Outcome name of an outgoing exec source port. */
function outcomeBase(portId: string): string {
  if (portId === 'exec_out') return 'ok';
  const base = portId.replace(/_out$/, '');
  return base === 'error' ? 'error' : base === '' ? 'ok' : sanitizeKey(base);
}

export function buildExtraction(
  parent: FlowDiagram,
  selectedIds: readonly string[],
  name: string,
  calleeId: string,
  genId: (prefix: string) => string,
): ExtractionResult {
  const fail = (key: Parameters<typeof t>[0], params?: Record<string, string | number>): ExtractionResult => ({ ok: false, message: t(key, params) });
  const sel = new Set(selectedIds);
  const inS = parent.blocks.filter((b) => sel.has(b.id));
  if (inS.length === 0) return fail('flowNest.ext.empty');
  const bad = inS.find((b) => UNSUPPORTED.has(b.type));
  if (bad) return fail('flowNest.ext.unsupported', { block: bad.label });

  const portType = (blockId: string, portId: string): PortType => {
    const b = parent.blocks.find((x) => x.id === blockId);
    return (b ? getBlockDefFor(b)?.ports.find((p) => p.id === portId)?.type : undefined) ?? 'data';
  };
  const labelOf = (id: string): string => parent.blocks.find((b) => b.id === id)?.label ?? id;
  const incoming = parent.connections.filter((c) => sel.has(c.toBlockId) && !sel.has(c.fromBlockId));
  const outgoing = parent.connections.filter((c) => sel.has(c.fromBlockId) && !sel.has(c.toBlockId));
  const inner = parent.connections.filter((c) => sel.has(c.fromBlockId) && sel.has(c.toBlockId));
  const incExec = incoming.filter((c) => portType(c.toBlockId, c.toPortId) === 'exec');
  const incData = incoming.filter((c) => portType(c.toBlockId, c.toPortId) !== 'exec');
  const outExec = outgoing.filter((c) => portType(c.fromBlockId, c.fromPortId) === 'exec');
  const outData = outgoing.filter((c) => portType(c.fromBlockId, c.fromPortId) !== 'exec');
  if (incExec.length !== 1) return fail('flowNest.ext.execIn', { n: incExec.length });

  // Variables used inside must not be shared with the rest of the flow (frame-scoped copies would diverge).
  const outsideBlocks = parent.blocks.filter((b) => !sel.has(b.id));
  const insideDiagram: FlowDiagram = { ...parent, blocks: inS };
  const outsideDiagram: FlowDiagram = { ...parent, blocks: outsideBlocks };
  const usedVars = (parent.variables ?? []).filter((d) => variableReferences(insideDiagram, d.name).length > 0);
  for (const d of usedVars) {
    if (variableReferences(outsideDiagram, d.name).length > 0) return fail('flowNest.ext.sharedVar', { name: d.name });
  }
  if (inS.some((b) => b.type === 'flow_break' || b.type === 'flow_continue') && !inS.some((b) => LOOP_BLOCKS.has(b.type))) {
    return fail('flowNest.ext.loopCtl');
  }
  if (outData.length > 0 && outExec.length === 0) return fail('flowNest.ext.noOutcome');

  // Inputs: one per distinct incoming data source (`ecu` edges share the single `ecu` input).
  const taken = new Set<string>();
  const inputs: FlowPortSpecV1[] = [];
  const inKeyOf = new Map<string, string>();
  const srcKey = (c: FlowConnection): string => `${c.fromBlockId}\u0000${c.fromPortId}`;
  for (const c of incData) {
    const k = srcKey(c);
    if (inKeyOf.has(k)) continue;
    const ty = valueTypeOf(portType(c.fromBlockId, c.fromPortId));
    let key: string;
    if (ty === 'ecu') key = 'ecu';
    else {
      // A `flow_in` source is named after its key (its port is always `value`).
      const srcBlock = parent.blocks.find((b) => b.id === c.fromBlockId);
      const base = srcBlock?.type === FLOW_IN ? blockPortSpec(srcBlock).key : c.fromPortId;
      key = uniqueKey(base, taken);
      if (taken.has(sanitizeKey(base)) || key !== sanitizeKey(base)) key = uniqueKey(`${labelOf(c.fromBlockId)}_${base}`, taken);
    }
    if (taken.has(key)) { inKeyOf.set(k, key); continue; }
    taken.add(key);
    inKeyOf.set(k, key);
    inputs.push({ key, label: key, type: ty, required: false });
  }
  // `{ecu.*}` inside needs the ecu input even without an incoming ecu edge.
  const needEcu = inS.some((b) => listEcuRefs(b.config).length > 0);
  const parentEcuIn: FlowBlock | undefined = parent.blocks.find((b) => b.type === FLOW_IN && blockPortSpec(b).type === 'ecu');
  const parentHasEcu = parentEcuIn !== undefined;
  if (needEcu && !taken.has('ecu')) {
    if (!parentHasEcu) return fail('flowNest.ext.ecuUndeclared');
    taken.add('ecu');
    inputs.push({ key: 'ecu', label: 'ecu', type: 'ecu', required: false });
  }
  inputs.forEach((s, i) => { s.order = i; });

  // Outcomes: one per distinct outgoing exec source.
  const outcomeOf = new Map<string, string>();
  const outcomeNames = new Set<string>();
  for (const c of outExec) {
    const k = srcKey(c);
    if (outcomeOf.has(k)) continue;
    let nm = outcomeBase(c.fromPortId);
    let n = 2;
    const base = nm;
    while (outcomeNames.has(nm) || nm === CALL_IN) nm = `${base}_${n++}`;
    outcomeNames.add(nm);
    outcomeOf.set(k, nm);
  }
  // Outputs: one per distinct outgoing data source; keys must not collide with outcome names / inputs' ports.
  const outputs: FlowPortSpecV1[] = [];
  const outKeyOf = new Map<string, string>();
  const outTaken = new Set<string>([...outcomeNames, 'error', CALL_IN]);
  for (const c of outData) {
    const k = srcKey(c);
    if (outKeyOf.has(k)) continue;
    const key = uniqueKey(`${c.fromPortId}`, outTaken);
    outTaken.add(key);
    outKeyOf.set(k, key);
    outputs.push({ key, label: key, type: valueTypeOf(portType(c.fromBlockId, c.fromPortId)), required: false });
  }

  // ── Callee diagram ──
  const minX = Math.min(...inS.map((b) => b.x));
  const minY = Math.min(...inS.map((b) => b.y));
  const maxX = Math.max(...inS.map((b) => b.x));
  const dx = 260 - minX;
  const dy = 80 - minY;
  const fs: FlowBlock = {
    id: genId('start'), type: FLOW_START, label: t('flowIface.blk.start'), x: 20, y: 80,
    config: {}, status: 'idle', collapsed: false,
  };
  const fiBlocks: FlowBlock[] = inputs.map((spec, i) => ({
    id: genId('in'), type: FLOW_IN, label: spec.label !== '' ? spec.label : spec.key, x: 20, y: 180 + i * 60,
    config: { ...spec }, status: 'idle' as const, collapsed: false,
  }));
  const fiOf = (key: string): FlowBlock => fiBlocks[inputs.findIndex((s) => s.key === key)];
  const cConns: FlowConnection[] = inner.map((c) => ({ ...c }));
  const cid = (): string => genId('c');
  const entry = incExec[0];
  cConns.push({ id: cid(), fromBlockId: fs.id, fromPortId: 'start', toBlockId: entry.toBlockId, toPortId: entry.toPortId });
  for (const c of incData) {
    cConns.push({ id: cid(), fromBlockId: fiOf(inKeyOf.get(srcKey(c)) as string).id, fromPortId: VALUE_PORT, toBlockId: c.toBlockId, toPortId: c.toPortId });
  }
  const retBlocks: FlowBlock[] = [];
  let oy = 80;
  const retX = maxX + dx + 260;
  for (const [k, nm] of outcomeOf) {
    const [fromBlockId, fromPortId] = k.split('\u0000');
    const fr: FlowBlock = {
      id: genId('ret'), type: FLOW_RETURN, label: nm, x: retX, y: oy,
      config: { name: nm, outcome: nm === 'error' ? 'error' : nm === 'fail' ? 'fail' : 'ok' },
      status: 'idle', collapsed: false,
    };
    oy += 120;
    retBlocks.push(fr);
    cConns.push({ id: cid(), fromBlockId, fromPortId, toBlockId: fr.id, toPortId: 'in' });
  }
  // Outputs are flow-level: one `flow_out` per output key, fed by its source (sampled when the frame ends).
  const outBlocks: FlowBlock[] = outputs.map((spec, i) => ({
    id: genId('out'), type: FLOW_OUT, label: spec.label !== '' ? spec.label : spec.key, x: retX, y: oy + 20 + i * 60,
    config: { ...spec, order: i }, status: 'idle' as const, collapsed: false,
  }));
  for (const c of outData) {
    const key = outKeyOf.get(srcKey(c)) as string;
    const fo = outBlocks[outputs.findIndex((o) => o.key === key)];
    if (cConns.some((x) => x.toBlockId === fo.id)) continue;
    cConns.push({ id: cid(), fromBlockId: c.fromBlockId, fromPortId: c.fromPortId, toBlockId: fo.id, toPortId: VALUE_PORT });
  }
  const callee: FlowDiagram = {
    id: calleeId,
    name,
    blocks: [fs, ...fiBlocks, ...inS.map((b) => ({ ...b, x: b.x + dx, y: b.y + dy, status: 'idle' as const, statusMessage: undefined, lastResult: undefined })), ...retBlocks, ...outBlocks],
    connections: cConns,
    variables: usedVars.map((v) => ({ ...v })),
  };

  const apply = (revision: number): FlowDiagram => {
    const call: FlowBlock = {
      id: genId('call'), type: callType(calleeId), label: name, x: minX, y: minY,
      config: { ref: { flowId: calleeId, revision } }, status: 'idle', collapsed: false,
    };
    const drop = new Set<string>([...incoming, ...outgoing, ...inner].map((c) => c.id));
    const conns: FlowConnection[] = parent.connections.filter((c) => !drop.has(c.id));
    const add = (fromBlockId: string, fromPortId: string, toBlockId: string, toPortId: string): void => {
      conns.push({ id: genId('c'), fromBlockId, fromPortId, toBlockId, toPortId });
    };
    add(entry.fromBlockId, entry.fromPortId, call.id, CALL_IN);
    const seenIn = new Set<string>();
    for (const c of incData) {
      const key = inKeyOf.get(srcKey(c)) as string;
      if (seenIn.has(key)) continue;
      seenIn.add(key);
      add(c.fromBlockId, c.fromPortId, call.id, key);
    }
    if (needEcu && !seenIn.has('ecu') && parentEcuIn) add(parentEcuIn.id, VALUE_PORT, call.id, 'ecu');
    for (const c of outExec) add(call.id, outcomeOf.get(srcKey(c)) as string, c.toBlockId, c.toPortId);
    for (const c of outData) add(call.id, outKeyOf.get(srcKey(c)) as string, c.toBlockId, c.toPortId);
    return {
      ...parent,
      blocks: [...outsideBlocks, call],
      connections: conns,
    };
  };

  return { ok: true, callee, apply, inputs, outcomes: [...outcomeNames] };
}
