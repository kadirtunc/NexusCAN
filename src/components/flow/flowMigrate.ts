/**
 * Migration of the legacy `data_var` block (assign-on-read) to the core variable model
 * (diag-workspace-v1 §8.1): declared variables + pure `var_get` + exec `var_set`.
 *
 * - `set_in` unconnected: `var_get` + a declared variable (type inferred from `initial`).
 * - `set_in` connected: `var_get` + a `var_set` inserted on the exec path immediately before the one
 *   exec block that (transitively, through pure blocks) reads it, when that insertion point is unique
 *   and equivalent. Otherwise the block is KEPT as `data_var` and `validateCore` reports it as an
 *   error (the run is refused): behaviour is never changed silently.
 */
import { t } from '../../i18n';
import type { FlowPortSpecV1, FlowVariableDeclV1, FlowVariableType } from '../../types/flowLibrary';
import type { FlowBlock, FlowConnection, FlowDiagram } from './types';
import { getBlockDef } from './blockDefs';
import { isValidVarName } from './coreBlocks';
import {
  FLOW_IN, FLOW_OUT, FLOW_RETURN, FLOW_START, LEGACY_END, LEGACY_FLOW_INPUT, LEGACY_FLOW_OUTPUT, LEGACY_START, VALUE_PORT,
  readPortSpecs, returnOutcome,
} from './flowPorts';

export interface MigrationResult {
  diagram: FlowDiagram;
  /** Localized human-readable notes (one per migrated / refused block). */
  notes: string[];
}

function inferType(initial: unknown): FlowVariableType {
  if (typeof initial === 'number' && Number.isFinite(initial)) return 'number';
  if (typeof initial === 'string' && /^-?\d+(\.\d+)?$/.test(initial.trim())) return 'number';
  return 'text';
}

function sanitizeName(raw: string): string {
  let s = raw.replace(/[^A-Za-z0-9_]/g, '_');
  if (s === '' || /^[0-9]/.test(s)) s = `_${s}`;
  return s.slice(0, 32);
}

function hasExecPort(type: string): boolean {
  return getBlockDef(type)?.ports.some((p) => p.type === 'exec') ?? false;
}

export function migrateLegacyVars(input: FlowDiagram): MigrationResult {
  if (!input.blocks.some((b) => b.type === 'data_var')) return { diagram: input, notes: [] };

  const notes: string[] = [];
  const decls: FlowVariableDeclV1[] = (input.variables ?? []).map((v) => ({ ...v }));
  let blocks: FlowBlock[] = [...input.blocks];
  let conns: FlowConnection[] = [...input.connections];
  const rawToName = new Map<string, string>();
  let idSeq = 0;
  const usedIds = new Set(input.blocks.map((b) => b.id).concat(input.connections.map((c) => c.id)));
  const freshId = (base: string): string => {
    let id = `${base}_m${++idSeq}`;
    while (usedIds.has(id)) id = `${base}_m${++idSeq}`;
    usedIds.add(id);
    return id;
  };

  const newDecl = (name: string, initial: unknown, hint?: FlowVariableType): FlowVariableDeclV1 => {
    const type = hint ?? inferType(initial);
    const text = initial === undefined || initial === null ? '' : String(initial);
    // The initial must be valid for the (possibly source-derived) type.
    const init = type === 'bytes' ? '' : type === 'bool' ? 'false' : type === 'number' && inferType(initial) !== 'number' ? '0' : text;
    return { name, type, initial: init };
  };
  // Valid legacy names keep their name; sanitized names are placed around them.
  const reserved = new Set<string>(decls.map((d) => d.name));
  for (const b of input.blocks) {
    const raw = String(b.config['name'] ?? 'myVar');
    if (b.type === 'data_var' && isValidVarName(raw)) reserved.add(raw);
  }

  const declare = (raw: string, initial: unknown, hint?: FlowVariableType): string => {
    const known = rawToName.get(raw);
    if (known !== undefined) return known;
    if (isValidVarName(raw)) {
      if (!decls.some((d) => d.name === raw)) decls.push(newDecl(raw, initial, hint));
      rawToName.set(raw, raw);
      return raw;
    }
    const base = sanitizeName(raw);
    let cand = base;
    let n = 1;
    while (reserved.has(cand) || decls.some((d) => d.name === cand)) {
      n += 1;
      cand = `${base.slice(0, 29)}_${n}`;
    }
    reserved.add(cand);
    decls.push(newDecl(cand, initial, hint));
    rawToName.set(raw, cand);
    notes.push(t('flowCore.mig.renamed', { from: raw, to: cand }));
    return cand;
  };

  const incoming = (blockId: string, portId: string): FlowConnection[] =>
    conns.filter((c) => c.toBlockId === blockId && c.toPortId === portId);

  /** Blocks in the pure data cone feeding `blockId` (excluding exec-capable blocks, which end the walk). */
  const pureCone = (blockId: string, acc = new Set<string>()): Set<string> => {
    for (const c of conns) {
      if (c.toBlockId !== blockId || acc.has(c.fromBlockId)) continue;
      const src = blocks.find((b) => b.id === c.fromBlockId);
      if (!src) continue;
      acc.add(src.id);
      if (!hasExecPort(src.type)) pureCone(src.id, acc);
    }
    return acc;
  };

  const legacy = input.blocks.filter((b) => b.type === 'data_var');
  for (const d of legacy) {
    const rawName = String(d.config['name'] ?? 'myVar');
    const initial = d.config['initial'];
    const setConns = incoming(d.id, 'set_in');

    const toVarGet = (name: string): void => {
      blocks = blocks.map((b) => (b.id === d.id ? { ...b, type: 'var_get', config: { name } } : b));
      conns = conns
        .filter((c) => !(c.toBlockId === d.id && c.toPortId === 'set_in'))
        .map((c) => (c.fromBlockId === d.id && c.fromPortId === 'get_out' ? { ...c, fromPortId: 'value' } : c));
    };

    if (setConns.length === 0) {
      toVarGet(declare(rawName, initial));
      notes.push(t('flowCore.mig.plain', { block: d.label, name: rawToName.get(rawName) ?? rawName }));
      continue;
    }

    // set_in connected: find the exec readers of this block (through pure blocks).
    const setSource = setConns[0];
    const readers: FlowBlock[] = [];
    let complex = setConns.length > 1;
    for (const b of blocks) {
      if (!hasExecPort(b.type) || b.id === d.id) continue;
      const cone = pureCone(b.id);
      if (cone.has(d.id)) readers.push(b);
    }
    // Another legacy assign-on-read block in the chain, or the value depends on this very block: not provable.
    const upstream = pureCone(d.id);
    if (upstream.has(d.id)) complex = true;
    for (const id of upstream) {
      const ub = blocks.find((b) => b.id === id);
      if (ub?.type === 'data_var') complex = true;
    }
    for (const b of blocks) {
      if (b.type === 'data_var' && b.id !== d.id && incoming(b.id, 'set_in').length > 0 && pureCone(b.id).has(d.id)) complex = true;
    }

    const reader = readers.length === 1 ? readers[0] : null;
    const execIn = reader ? incoming(reader.id, 'exec_in') : [];
    if (complex || reader === null || reader.type === 'flow_while' || execIn.length !== 1) {
      notes.push(t('flowCore.mig.manual', { block: d.label }));
      continue;
    }

    // Type of a variable that is assigned from a wire: derived from the source port (bytes / bool are kept
    // exactly; a decimal constant is a number), otherwise from `initial`.
    const srcBlock = blocks.find((b) => b.id === setSource.fromBlockId);
    const srcPort = srcBlock ? getBlockDef(srcBlock.type)?.ports.find((p) => p.id === setSource.fromPortId) : undefined;
    const hint: FlowVariableType | undefined =
      srcPort?.type === 'bytes' ? 'bytes'
        : srcPort?.type === 'bool' ? 'bool'
          : srcBlock?.type === 'data_const' && srcBlock.config['format'] === 'dec' ? 'number'
            : undefined;
    const name = declare(rawName, initial, hint);
    toVarGet(name);
    const setId = freshId(`${reader.id}_set`);
    const setBlock: FlowBlock = {
      id: setId,
      type: 'var_set',
      label: t('flowCore.blk.varSet'),
      x: reader.x - 220,
      y: reader.y,
      config: { name, mode: 'set', amount: 1 },
      status: 'idle',
      collapsed: false,
    };
    const pre = execIn[0];
    conns = conns.filter((c) => c.id !== pre.id);
    conns.push({ id: freshId('c'), fromBlockId: pre.fromBlockId, fromPortId: pre.fromPortId, toBlockId: setId, toPortId: 'exec_in' });
    conns.push({ id: freshId('c'), fromBlockId: setId, fromPortId: 'exec_out', toBlockId: reader.id, toPortId: 'exec_in' });
    conns.push({ id: freshId('c'), fromBlockId: setSource.fromBlockId, fromPortId: setSource.fromPortId, toBlockId: setId, toPortId: 'value_in' });
    blocks = [...blocks, setBlock];
    notes.push(t('flowCore.mig.inserted', { block: d.label, name, reader: reader.label }));
  }

  return { diagram: { ...input, blocks, connections: conns, variables: decls }, notes };
}

// ─── v1 interface blocks -> flow-interface-v2 (§4) ─────────────────────────────────────────────────

const IN_STEP_Y = 60;
const IN_FIRST_DY = 100;

function sourceKey(c: FlowConnection): string {
  return `${c.fromBlockId}\u0000${c.fromPortId}`;
}

/**
 * Deterministic v1 -> v2 interface migration (never silent):
 * - `start` -> `flow_start` (same id; `exec_out` connections -> `start`). Only the FIRST `start`, and only when
 *   there is no `flow_input` (a stray `start` next to a `flow_input` stays an inert legacy block, as before).
 * - `flow_input { inputs }` -> `flow_start` (same id, `start` port kept) + one `flow_in` per spec
 *   (`${oldId}__in_${key}`, same x, stacked below, config = spec + `order` = index); `(old, key)` connections ->
 *   `(newIn, 'value')`.
 * - `flow_output { name, outcome, outputs }` -> `flow_return { name, outcome }` (same id, `in` kept) + one
 *   `flow_out` per distinct output key over ALL old outputs (`${firstOwnerId}__out_${key}`, `order` = first-seen
 *   index); `(old, key)` connections -> `(flowOut, 'value')`. A key that had different sources or different types
 *   keeps the FIRST and gets `config.migrateConflict` (a `migrate_output_conflict` validation issue: the flow
 *   cannot run until it is fixed and the conflict is acknowledged).
 * - `end` -> `flow_return { name: 'ok', outcome: 'ok' }` (`exec_in` -> `in`).
 */
export function migrateInterfaceV2(input: FlowDiagram): MigrationResult {
  const hasLegacy = input.blocks.some((b) => b.type === LEGACY_START || b.type === LEGACY_END || b.type === LEGACY_FLOW_INPUT || b.type === LEGACY_FLOW_OUTPUT);
  // A `start` next to an existing `flow_start` / `flow_input` is inert legacy data: never converted (idempotent).
  const startConvertible = !input.blocks.some((b) => b.type === FLOW_START || b.type === LEGACY_FLOW_INPUT);
  const needsWork = input.blocks.some((b) => b.type === LEGACY_END || b.type === LEGACY_FLOW_INPUT || b.type === LEGACY_FLOW_OUTPUT
    || (b.type === LEGACY_START && startConvertible));
  if (!hasLegacy || !needsWork) return { diagram: input, notes: [] };

  const notes: string[] = [];
  const usedIds = new Set(input.blocks.map((b) => b.id));
  const uniqueId = (base: string): string => {
    let id = base;
    let n = 2;
    while (usedIds.has(id)) id = `${base}_${n++}`;
    usedIds.add(id);
    return id;
  };
  const newBlock = (id: string, type: string, label: string, x: number, y: number, config: Record<string, unknown>): FlowBlock =>
    ({ id, type, label, x, y, config, status: 'idle', collapsed: false });

  let blocks: FlowBlock[] = input.blocks.map((b) => ({ ...b }));
  let conns: FlowConnection[] = input.connections.map((c) => ({ ...c }));
  const added: FlowBlock[] = [];
  const legacyDefaultLabel = t('flowReg.blk.flowInput');

  // 1. start -> flow_start (first one only, and only without a flow_input)
  if (startConvertible) {
    const start = blocks.find((b) => b.type === LEGACY_START);
    if (start) {
      blocks = blocks.map((b) => (b.id === start.id ? { ...b, type: FLOW_START, config: {} } : b));
      conns = conns.map((c) => (c.fromBlockId === start.id && c.fromPortId === 'exec_out' ? { ...c, fromPortId: 'start' } : c));
    }
  }

  // 2. flow_input -> flow_start + flow_in blocks
  for (const old of blocks.filter((b) => b.type === LEGACY_FLOW_INPUT)) {
    const specs = readPortSpecs(old.config['inputs']);
    blocks = blocks.map((b) => (b.id === old.id
      ? { ...b, type: FLOW_START, label: b.label === legacyDefaultLabel ? t('flowIface.blk.start') : b.label, config: {} }
      : b));
    specs.forEach((spec, i) => {
      const id = uniqueId(`${old.id}__in_${spec.key}`);
      added.push(newBlock(id, FLOW_IN, spec.label !== '' ? spec.label : spec.key, old.x, old.y + IN_FIRST_DY + i * IN_STEP_Y, { ...spec, order: i }));
      // `start` is the exec port of the block: a (legacy-invalid) data key of that name is never remapped.
      if (spec.key !== 'start') {
        conns = conns.map((c) => (c.fromBlockId === old.id && c.fromPortId === spec.key ? { ...c, fromBlockId: id, fromPortId: VALUE_PORT } : c));
      }
    });
  }

  // 3. flow_output -> flow_return + flow_out blocks (one per distinct key)
  interface OutAcc {
    key: string;
    owner: FlowBlock;
    ownerIndex: number;
    spec: FlowPortSpecV1;
    required: boolean;
    order: number;
    source: FlowConnection | null;
    dropped: string[];
  }
  const outs = new Map<string, OutAcc>();
  const labelOf = (id: string): string => blocks.find((b) => b.id === id)?.label ?? added.find((b) => b.id === id)?.label ?? id;
  const oldOutputs = blocks.filter((b) => b.type === LEGACY_FLOW_OUTPUT);
  const perOwner = new Map<string, number>();
  for (const old of oldOutputs) {
    const outcomeName = typeof old.config['name'] === 'string' ? old.config['name'] : '';
    for (const spec of readPortSpecs(old.config['outputs'])) {
      const incoming = conns.find((c) => c.toBlockId === old.id && c.toPortId === spec.key) ?? null;
      const acc = outs.get(spec.key);
      if (!acc) {
        const idx = perOwner.get(old.id) ?? 0;
        perOwner.set(old.id, idx + 1);
        outs.set(spec.key, { key: spec.key, owner: old, ownerIndex: idx, spec, required: spec.required && returnOutcome(old) === 'ok', order: outs.size, source: incoming, dropped: [] });
        continue;
      }
      // `required` only ever bound the `ok` outcome in the engine: outputs on fail / error stay non-required.
      acc.required = acc.required || (spec.required && returnOutcome(old) === 'ok');
      if (spec.type !== acc.spec.type) acc.dropped.push(`${outcomeName}: ${spec.type} ≠ ${acc.spec.type}`);
      if (incoming) {
        if (acc.source === null) acc.source = incoming;
        else if (sourceKey(incoming) !== sourceKey(acc.source)) acc.dropped.push(`${outcomeName}: ${labelOf(incoming.fromBlockId)}.${incoming.fromPortId}`);
      }
    }
  }
  const oldOutIds = new Set(oldOutputs.map((b) => b.id));
  const newConns: FlowConnection[] = [];
  for (const acc of outs.values()) {
    const id = uniqueId(`${acc.owner.id}__out_${acc.key}`);
    // Spec of a flow_out: no default / options / accept (those belong to inputs).
    const config: Record<string, unknown> = { ...acc.spec, required: acc.required, order: acc.order };
    delete config['default'];
    delete config['options'];
    delete config['accept'];
    if (acc.dropped.length > 0) {
      config['migrateConflict'] = acc.dropped.join('; ');
      notes.push(t('flowIface.mig.conflict', { key: acc.key, detail: acc.dropped.join('; ') }));
    }
    added.push(newBlock(id, FLOW_OUT, acc.spec.label !== '' ? acc.spec.label : acc.key, acc.owner.x, acc.owner.y + IN_FIRST_DY + acc.ownerIndex * IN_STEP_Y, config));
    if (acc.source) newConns.push({ ...acc.source, toBlockId: id, toPortId: VALUE_PORT });
  }
  // Every connection into an old output key is replaced by (at most) one connection into its flow_out (the kept
  // one is re-created with its original id on the new endpoint); the exec `in` connections stay.
  conns = [...conns.filter((c) => !(oldOutIds.has(c.toBlockId) && c.toPortId !== 'in')), ...newConns];
  blocks = blocks.map((b) => {
    if (b.type !== LEGACY_FLOW_OUTPUT) return b;
    return { ...b, type: FLOW_RETURN, config: { name: typeof b.config['name'] === 'string' ? b.config['name'] : '', outcome: returnOutcome(b) } };
  });

  // 4. end -> flow_return ok
  const endIds = new Set(blocks.filter((b) => b.type === LEGACY_END).map((b) => b.id));
  if (endIds.size > 0) {
    blocks = blocks.map((b) => (endIds.has(b.id) ? { ...b, type: FLOW_RETURN, config: { name: 'ok', outcome: 'ok' } } : b));
    conns = conns.map((c) => (endIds.has(c.toBlockId) && c.toPortId === 'exec_in' ? { ...c, toPortId: 'in' } : c));
  }

  notes.unshift(t('flowIface.mig.converted'));
  return { diagram: { ...input, blocks: [...blocks, ...added], connections: conns }, notes };
}

/** Every load-time migration in order (legacy variables, then the v1 interface blocks -> v2). */
export function migrateAll(input: FlowDiagram): MigrationResult {
  const vars = migrateLegacyVars(input);
  const iface = migrateInterfaceV2(vars.diagram);
  return { diagram: iface.diagram, notes: [...vars.notes, ...iface.notes] };
}
