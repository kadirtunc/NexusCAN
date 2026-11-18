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
import type { FlowVariableDeclV1, FlowVariableType } from '../../types/flowLibrary';
import type { FlowBlock, FlowConnection, FlowDiagram } from './types';
import { getBlockDef } from './blockDefs';
import { isValidVarName } from './coreBlocks';

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

// ─── start -> flow_input (diag-workspace-v1 §8) ─────────────────────────────────────────────────────

/**
 * Legacy `start` -> `flow_input` with `inputs: []`: same id, label and position; the exec output port
 * `exec_out` becomes `start`. Only the FIRST `start` (the one the engine ran) is migrated, and nothing is
 * changed when a `flow_input` already exists, so a flow never ends up with two interface blocks. Legacy
 * `end` blocks are NOT migrated (they keep working as outcome `ok`).
 */
export function migrateLegacyStart(input: FlowDiagram): FlowDiagram {
  if (input.blocks.some((b) => b.type === 'flow_input')) return input;
  const start = input.blocks.find((b) => b.type === 'start');
  if (!start) return input;
  return {
    ...input,
    blocks: input.blocks.map((b) => (b.id === start.id ? { ...b, type: 'flow_input', config: { inputs: [] } } : b)),
    connections: input.connections.map((c) =>
      c.fromBlockId === start.id && c.fromPortId === 'exec_out' ? { ...c, fromPortId: 'start' } : c),
  };
}

/** Every load-time migration in order (legacy variables, then start -> flow_input). */
export function migrateAll(input: FlowDiagram): MigrationResult {
  const vars = migrateLegacyVars(input);
  return { diagram: migrateLegacyStart(vars.diagram), notes: vars.notes };
}
