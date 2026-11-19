/**
 * Headless tests of the Flow Registry phase (B1): library file serialization (no runtime fields, canonical
 * content hash), the v1 `start` / `end` -> `flow_start` / `flow_return` migration, the derived flow interface
 * (flow-interface-v2) and its validation, `flow_return` / `flow_out` outcome semantics and run-input reading
 * on BOTH engines, the localStorage -> library migration
 * (fake storage + fake client), the registry store (documents, per-document undo, conflict handling, revisions,
 * import) and the side-panel preference helpers.
 * Run: `npm run test:flowreg` (esbuild bundle -> node; throws on the first failure).
 */
import { FlowEngine } from '../FlowEngine';
import { flowStore, LEGACY_FLOW_STORAGE_KEY } from '../FlowStore';
import { getBlockDefFor, portsCompatible, requiredProtocols } from '../blockDefs';
import { migrateAll, migrateInterfaceV2 } from '../flowMigrate';
import { deriveFlowInterface, resolveRunInputs, validateInterface } from '../flowInterface';
import { clampPanelWidth, parsePanelPrefs } from '../ResizablePanel';
import type { FlowRequestOptions, FlowTransport } from '../flowTransport';
import type { FlowBlock, FlowConnection, FlowDiagram } from '../types';
import { stopAllTxSources } from '../../../store/txSources';
import {
  parseFlowLibError,
  type FlowLibEntryDto,
  type FlowLibRevisionDto,
  type FlowPortSpecV1,
  type NxFlowBodyV1,
} from '../../../types/flowLibrary';
import {
  buildFlowFile,
  canonicalJson,
  computeContentHash,
  contentCanon,
  fromFlowBody,
  parseFlowFile,
  toFlowBody,
  type FlowMeta,
} from './flowBody';
import type { FlowLibClient } from './flowLibClient';
import {
  FLOW_REGISTRY_MIGRATED_IDS_KEY,
  FLOW_REGISTRY_MIGRATED_KEY,
  migrateLegacyDiagrams,
  type StorageLike,
} from './flowLegacyMigration';
import { FlowRegistryStore } from './flowRegistryStore';

let passed = 0;
function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  passed += 1;
}
function eq<T>(actual: T, expected: T, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${msg}\n  expected: ${e}\n  actual:   ${a}`);
  passed += 1;
}

// ─── Builders ──────────────────────────────────────────────────────────────────

let seq = 0;
function blk(type: string, label: string, config: Record<string, unknown> = {}): FlowBlock {
  return { id: `b${++seq}`, type, label, x: seq * 10, y: seq * 5, config, status: 'idle', collapsed: false };
}
function wire(from: FlowBlock, fromPort: string, to: FlowBlock, toPort: string): FlowConnection {
  return { id: `c${++seq}`, fromBlockId: from.id, fromPortId: fromPort, toBlockId: to.id, toPortId: toPort };
}
function dia(blocks: FlowBlock[], connections: FlowConnection[], name = 'd'): FlowDiagram {
  return { id: 'd', name, blocks, connections, variables: [] };
}
const spec = (key: string, type: FlowPortSpecV1['type'], extra: Partial<FlowPortSpecV1> = {}): FlowPortSpecV1 => ({
  key, label: key, type, required: false, ...extra,
});
function meta(over: Partial<FlowMeta> = {}): FlowMeta {
  return { id: 'f1', revision: 1, description: 'desc', createdAt: '2026-11-18T10:00:00.000Z', updatedAt: '2026-11-18T10:00:00.000Z', author: null, origin: 'user', aiReviewed: true, tags: ['a'], ...over };
}
function load(d: FlowDiagram): void {
  flowStore.loadTemplate({
    id: 'x', nameKey: 'flowCore.tpl.counter.name', descriptionKey: 'flowCore.tpl.counter.desc', category: 'examples', icon: '',
    diagram: { blocks: d.blocks, connections: d.connections, ...(d.variables ? { variables: d.variables } : {}) },
  });
}

// ─── Fakes ─────────────────────────────────────────────────────────────────────

class FakeStorage implements StorageLike {
  readonly data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
}

class FakeLib implements FlowLibClient {
  readonly files = new Map<string, Map<number, string>>();
  readonly deleted = new Set<string>();
  saves = 0;
  /** Throws for saves whose flow name matches. */
  failName: string | null = null;
  async list(includeDeleted: boolean): Promise<FlowLibEntryDto[]> {
    const out: FlowLibEntryDto[] = [];
    for (const [id, revs] of this.files) {
      const latest = Math.max(...revs.keys());
      const parsed = parseFlowFile(revs.get(latest) as string);
      if (!parsed.ok) continue;
      const f = parsed.file;
      const deleted = this.deleted.has(id);
      if (deleted && !includeDeleted) continue;
      out.push({ id, kind: f.kind, name: f.flow.name, latestRevision: latest, updatedAt: f.flow.updatedAt, origin: f.flow.origin,
        aiReviewed: f.flow.aiReviewed, contentHash: f.contentHash, tags: f.flow.tags, deleted });
    }
    return out;
  }
  async revisions(id: string): Promise<FlowLibRevisionDto[]> {
    const revs = this.files.get(id);
    if (!revs) throw new Error(`[flowlib:not_found] ${id}`);
    return [...revs.keys()].sort((a, b) => a - b).map((revision) => {
      const p = parseFlowFile(revs.get(revision) as string);
      return { revision, updatedAt: p.ok ? p.file.flow.updatedAt : '', contentHash: p.ok ? p.file.contentHash : '' };
    });
  }
  async load(id: string, revision: number | null): Promise<string> {
    const revs = this.files.get(id);
    if (!revs) throw new Error(`[flowlib:not_found] ${id}`);
    const text = revs.get(revision ?? Math.max(...revs.keys()));
    if (text === undefined) throw new Error(`[flowlib:not_found] ${id} r${String(revision)}`);
    return text;
  }
  async save(fileJson: string): Promise<FlowLibEntryDto> {
    this.saves += 1;
    const p = parseFlowFile(fileJson);
    if (!p.ok) throw new Error(`[flowlib:invalid] ${p.message}`);
    if (this.failName !== null && p.file.flow.name === this.failName) throw new Error('[flowlib:io] disk full');
    if (!/^[0-9a-f]{64}$/.test(p.file.contentHash)) throw new Error('[flowlib:invalid] contentHash');
    const revs = this.files.get(p.file.flow.id) ?? new Map<number, string>();
    const latest = revs.size === 0 ? 0 : Math.max(...revs.keys());
    if (p.file.flow.revision !== latest + 1) throw new Error(`[flowlib:conflict] revision ${p.file.flow.revision}, latest ${latest}`);
    revs.set(p.file.flow.revision, fileJson);
    this.files.set(p.file.flow.id, revs);
    this.deleted.delete(p.file.flow.id);
    const e = (await this.list(true)).find((x) => x.id === p.file.flow.id) as FlowLibEntryDto;
    return e;
  }
  async delete(id: string): Promise<void> {
    if (!this.files.has(id)) throw new Error(`[flowlib:not_found] ${id}`);
    this.deleted.add(id);
  }
}

// ─── Engines ───────────────────────────────────────────────────────────────────

const simTransport = { demo: true } as unknown as FlowTransport;
class StubTransport implements FlowTransport {
  readonly demo = false;
  readonly tabId = 'tab-test';
  sent: string[] = [];
  functionalId(): number | null {
    return null;
  }
  async setKeepalive(): Promise<void> {
    // not used
  }
  async readDid(): Promise<number[]> {
    return [];
  }
  async request(sid: number, data: readonly number[], _o: FlowRequestOptions = {}): Promise<number[]> {
    this.sent.push([sid, ...data].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' '));
    throw new Error('unexpected request');
  }
}

type Mode = 'sim' | 'real';
interface Run {
  eng: FlowEngine;
  lines: string[];
  errors: string[];
  tx: string[];
}
async function runDiagram(mode: Mode, inputs: Record<string, unknown> = {}): Promise<Run> {
  const tr = new StubTransport();
  const eng = new FlowEngine();
  await eng.run({ transport: mode === 'sim' ? simTransport : tr, inputs });
  const snap = flowStore.getSnapshot();
  const lines: string[] = [];
  for (const e of snap.runLog) {
    const m = /^\[[\d:.]+\]\s{3}LOG: (.*)$/.exec(e.message);
    if (m) lines.push(m[1]);
  }
  ok(!snap.isRunning, `run state reset [${mode}]`);
  return { eng, lines, errors: snap.runLog.filter((e) => e.level === 'error').map((e) => e.message), tx: tr.sent };
}
async function both(d: FlowDiagram, inputs: Record<string, unknown>, check: (r: Run, mode: Mode) => void): Promise<void> {
  for (const mode of ['sim', 'real'] as const) {
    load(d);
    check(await runDiagram(mode, inputs), mode);
  }
}

function logBlock(label: string, message: string): FlowBlock {
  return blk('log', label, { message });
}

async function main(): Promise<void> {
  // ── 1. toFlowBody / fromFlowBody: no runtime fields, round trip ─────────────
  {
    const a = blk('log', 'A', { message: 'hi' });
    const b = blk('delay', 'B', { delay_ms: 5 });
    a.status = 'success';
    a.statusMessage = 'done';
    a.lastResult = new Uint8Array([1, 2, 3]);
    b.collapsed = true;
    const d: FlowDiagram = { ...dia([a, b], [wire(a, 'exec_out', b, 'exec_in')], 'Persist'), variables: [{ name: 'x', type: 'number', initial: '5' }] };
    const body = toFlowBody(d, meta());
    const text = JSON.stringify(body);
    ok(!/"status"|"statusMessage"|"lastResult"|"collapsed"/.test(text), 'body has no runtime fields');
    eq(Object.keys(body.blocks[0]).sort(), ['config', 'id', 'label', 'type', 'x', 'y'], 'block keys are exactly the persisted ones');
    eq(body.name, 'Persist', 'name from the diagram');
    eq(body.blocks[1].config['uiCollapsed'], true, 'collapsed kept as a config UI flag');
    ok(body.blocks[0].config['uiCollapsed'] === undefined, 'expanded block has no UI flag');
    const back = fromFlowBody(JSON.parse(text) as NxFlowBodyV1);
    eq(back.blocks.map((x) => x.status), ['idle', 'idle'], 'status is idle after load');
    eq(back.blocks.map((x) => x.collapsed), [false, true], 'collapsed restored');
    eq(back.blocks[1].config, { delay_ms: 5 }, 'UI flag removed from the config on load');
    eq(back.variables, d.variables, 'variables round trip');
    eq(back.connections, d.connections, 'connections round trip');
    eq(JSON.stringify(toFlowBody(back, meta())), text, 'second serialization is byte-identical');
    // blocks without coordinates are laid out, not dropped
    const laid = fromFlowBody({ ...body, blocks: body.blocks.map((x) => ({ id: x.id, type: x.type, label: x.label, config: x.config })) });
    ok(laid.blocks.every((x) => Number.isFinite(x.x) && Number.isFinite(x.y)), 'missing x / y are auto-laid-out');
    // ai metadata survives
    const ai = blk('uds_session', 'S');
    ai.ai = { warningLevel: 'high', reason: 'because' };
    eq(fromFlowBody(toFlowBody(dia([ai], []), meta())).blocks[0].ai, { warningLevel: 'high', reason: 'because' }, 'ai metadata round trip');
  }

  // ── 2. canonical JSON / content hash ────────────────────────────────────────
  {
    eq(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}', 'canonical JSON sorts keys recursively, drops undefined');
    const mk = (order: 'ab' | 'ba'): FlowDiagram => {
      const cfg: Record<string, unknown> = order === 'ab' ? { a: 1, b: { x: 1, y: 2 } } : { b: { y: 2, x: 1 }, a: 1 };
      return dia([{ ...blk('delay', 'X', cfg), id: 'fixed', x: 1, y: 2 }], []);
    };
    const h1 = await computeContentHash(toFlowBody(mk('ab'), meta()));
    const h2 = await computeContentHash(toFlowBody(mk('ba'), meta()));
    ok(/^[0-9a-f]{64}$/.test(h1), 'hash is 64 hex chars');
    eq(h1, h2, 'hash is stable under key order');
    eq(await computeContentHash(toFlowBody(mk('ab'), meta({ revision: 9, updatedAt: '2027-01-01T00:00:00.000Z' }))), h1, 'hash ignores revision and updatedAt');
    ok(await computeContentHash(toFlowBody({ ...mk('ab'), name: 'other' }, meta())) !== h1, 'hash changes with the name');
    ok(await computeContentHash(toFlowBody(mk('ab'), meta({ description: 'x' }))) !== h1, 'hash changes with the description');
    const file = await buildFlowFile('nexuscan.flow', toFlowBody(mk('ab'), meta()));
    eq(file.contentHash, h1, 'file carries the content hash');
    ok(contentCanon(file.flow).indexOf('"revision"') < 0 && contentCanon(file.flow).indexOf('"updatedAt"') < 0, 'canon excludes revision / updatedAt');
    const parsed = parseFlowFile(JSON.stringify(file));
    ok(parsed.ok, 'file parses');
    ok(!parseFlowFile('{"schemaVersion":2}').ok && !parseFlowFile('nope').ok && !parseFlowFile(JSON.stringify({ ...file, kind: 'x' })).ok, 'parser rejects bad envelopes');
    ok(!parseFlowFile(JSON.stringify({ ...file, flow: { ...file.flow, id: 'bad id!' } })).ok, 'parser rejects an invalid id');
  }

  // ── 3. start / end -> flow_start / flow_return migration ─────────────────────
  {
    const s0 = blk('start', 'Start');
    const l = logBlock('L', 'x');
    const e = blk('end', 'End');
    const d = dia([s0, l, e], [wire(s0, 'exec_out', l, 'exec_in'), wire(l, 'exec_out', e, 'exec_in')]);
    const m = migrateInterfaceV2(d).diagram;
    const fs = m.blocks.find((b) => b.id === s0.id) as FlowBlock;
    eq([fs.type, fs.x, fs.y, fs.label, fs.config], ['flow_start', s0.x, s0.y, 'Start', {}], 'start -> flow_start keeps id, position, label');
    eq(m.connections[0].fromPortId, 'start', 'exec_out re-pointed to start');
    const fr = m.blocks.find((b) => b.id === e.id) as FlowBlock;
    eq([fr.type, fr.config], ['flow_return', { name: 'ok', outcome: 'ok' }], 'end -> flow_return ok');
    eq(m.connections[1].toPortId, 'in', 'end exec_in re-pointed to in');
    eq(migrateInterfaceV2(m).diagram, m, 'migration is idempotent');
    const two = dia([s0, blk('start', 'S2'), l], [wire(s0, 'exec_out', l, 'exec_in')]);
    eq(migrateInterfaceV2(two).diagram.blocks.filter((b) => b.type === 'flow_start').length, 1, 'only the first start is migrated');
    eq(migrateAll(d).diagram.blocks[0].type, 'flow_start', 'migrateAll includes the interface migration');
    eq(migrateInterfaceV2(dia([blk('flow_input', 'In', { inputs: [] }), blk('start', 'S')], [])).diagram.blocks.map((b) => b.type), ['flow_start', 'start'], 'an existing flow_input keeps a stray start inert');
    // the store applies it on load
    load(d);
    eq(flowStore.getSnapshot().diagram.blocks[0].type, 'flow_start', 'loadTemplate migrates start');
  }

  // ── 4. Interface: ports, derivation, validation (flow-interface-v2 §2 / §5) ───
  {
    const inSpecs = [
      spec('ecu', 'ecu', { required: true, order: 0 }), spec('image', 'file', { order: 1 }), spec('h', 'hex', { order: 2 }),
      spec('n', 'number', { order: 3 }), spec('f', 'bool', { order: 4 }), spec('bb', 'bytes', { order: 5 }),
    ];
    const ins = inSpecs.map((sp) => blk('flow_in', sp.key, { ...sp }));
    eq(ins.map((b) => getBlockDefFor(b)?.ports.map((p) => [p.id, p.type, p.direction])), [
      [['value', 'ecu', 'output']], [['value', 'bytes', 'output']], [['value', 'data', 'output']],
      [['value', 'data', 'output']], [['value', 'bool', 'output']], [['value', 'bytes', 'output']],
    ], 'flow_in port derives from its spec (ecu->ecu, file/bytes->bytes, bool->bool, others->data)');
    const outA = blk('flow_out', 'code', { ...spec('code', 'number'), order: 0 });
    const outB = blk('flow_out', 'blob', { ...spec('blob', 'bytes'), order: 1 });
    eq([outA, outB].map((b) => getBlockDefFor(b)?.ports.map((p) => [p.id, p.type, p.direction, p.optional])), [
      [['value', 'data', 'input', true]], [['value', 'bytes', 'input', true]],
    ], 'flow_out: one optional value input of the spec type');
    eq(getBlockDefFor(blk('flow_return', 'R', { name: 'ok', outcome: 'ok' }))?.ports.map((p) => [p.id, p.type, p.direction]), [['in', 'exec', 'input']], 'flow_return: exec in');
    eq(getBlockDefFor(blk('flow_start', 'S'))?.ports.map((p) => [p.id, p.type, p.direction]), [['start', 'exec', 'output']], 'flow_start: exec start');
    ok(!portsCompatible('ecu', 'data') && !portsCompatible('data', 'ecu') && portsCompatible('ecu', 'ecu'), 'ecu connects only to ecu');

    const retOk = blk('flow_return', 'Ok', { name: 'ok', outcome: 'ok' });
    const retBad = blk('flow_return', 'F', { name: 'bad', outcome: 'fail' });
    const start = blk('flow_start', 'S');
    const uds = blk('uds_session', 'Session', {});
    const d = dia([start, ...ins, retOk, retBad, outA, outB, uds], []);
    const iface = deriveFlowInterface(d);
    eq(iface.inputs, inSpecs, 'derived inputs (sorted by order)');
    eq(iface.outcomes, [{ name: 'ok', outcome: 'ok' }, { name: 'bad', outcome: 'fail' }], 'derived outcomes');
    eq(iface.outputs.map((o) => o.key), ['code', 'blob'], 'derived flow-level outputs');
    eq(iface.requiresProtocols, ['uds_can'], 'requiresProtocols from the pack');
    eq(requiredProtocols(dia([start, ...ins], [])), [], 'protocol-agnostic flow requires nothing');
    eq(deriveFlowInterface(dia([start], [])).outcomes, [{ name: 'ok', outcome: 'ok' }], 'no flow_return: implicit ok');
    const codesOf = (blocks: FlowBlock[], withStart = true): string[] => validateInterface(dia(withStart ? [blk('flow_start', 'S'), ...blocks] : blocks, [])).map((i) => i.code);
    eq(codesOf([...ins, retOk, retBad, outA, outB]), [], 'valid interface has no issues');
    eq(codesOf([], false), ['no_entry'], 'no flow_start = no entry');
    eq(codesOf([blk('flow_start', 'B')]), ['start_multiple', 'start_multiple'], 'two flow_start blocks');
    eq(codesOf([blk('flow_in', 'A', { ...spec('1bad', 'text') })]), ['input_key'], 'key regex');
    eq(codesOf([blk('flow_in', 'A', { ...spec('has space', 'text') })]), ['input_key'], 'key regex (space)');
    eq(codesOf([blk('flow_in', 'A', { ...spec('in', 'text') })]), ['input_key'], 'reserved input key in');
    eq(codesOf([blk('flow_in', 'A', { ...spec('x', 'text') }), blk('flow_in', 'B', { ...spec('x', 'number') })]), ['input_dup'], 'duplicate input keys');
    eq(codesOf([blk('flow_in', 'A', { ...spec('vehicle', 'ecu') })]), ['ecu_key'], 'ecu input key must be "ecu"');
    eq(codesOf([blk('flow_in', 'A', { ...spec('ecu', 'text') })]), ['ecu_key'], 'key "ecu" is reserved for the ecu type');
    ok(codesOf([blk('flow_in', 'A', { ...spec('ecu', 'ecu') }), blk('flow_in', 'B', { ...spec('ecu2', 'ecu') })]).includes('ecu_multiple'), 'at most one ecu input');
    eq(codesOf([blk('flow_in', 'A', { ...spec('s', 'select') })]), ['input_options'], 'select needs options');
    eq(codesOf([blk('flow_in', 'A', { ...spec('n', 'number', { min: 5, max: 1 }) })]), ['input_range'], 'min <= max');
    eq(codesOf([blk('flow_return', 'A', { name: 'x', outcome: 'ok' }), blk('flow_return', 'B', { name: 'x', outcome: 'fail' })]), ['return_name_dup', 'return_name_dup'], 'a return name used with different outcomes');
    eq(codesOf([blk('flow_return', 'A', { name: 'x', outcome: 'ok' }), blk('flow_return', 'B', { name: 'x', outcome: 'ok' })]), [], 'repeated returns with the same outcome are one outcome');
    eq(codesOf([blk('flow_return', 'A', { name: '  ', outcome: 'ok' })]), ['return_name'], 'empty return name');
    eq(codesOf([blk('flow_return', 'A', { name: 'in', outcome: 'ok' })]), ['return_reserved'], 'return name in is reserved');
    eq(codesOf([blk('flow_out', 'A', { ...spec('in', 'text') })]), ['output_key'], 'reserved output key in');
    eq(codesOf([blk('flow_out', 'A', { ...spec('error', 'text') })]), ['output_key'], 'reserved output key error');
    eq(codesOf([blk('flow_out', 'A', { ...spec('done', 'text') }), blk('flow_return', 'R', { name: 'done', outcome: 'ok' })]), ['output_reserved'], 'output key = outcome name');
    eq(codesOf([blk('flow_out', 'A', { ...spec('x', 'text') }), blk('flow_out', 'B', { ...spec('x', 'text') })]), ['output_dup'], 'duplicate output keys');
    eq(validateInterface(dia([blk('flow_start', 'S'), blk('flow_in', 'A', { ...spec('1bad', 'text') })], []))[0].message.includes('1bad'), true, 'issues are localized and name the key');

    // editing the interface drops dangling connections (undoable)
    const src = blk('flow_in', 'In', { ...spec('n', 'number') });
    const dst = blk('log', 'L', {});
    load(dia([blk('flow_start', 'S'), src, dst], [wire(src, 'value', dst, 'value_in')]));
    eq(flowStore.getSnapshot().diagram.connections.length, 1, 'connection from the flow_in value port');
    flowStore.updateBlockConfig(src.id, { type: 'bool' });
    eq(flowStore.getSnapshot().diagram.connections.length, 1, 'compatible type change (data -> bool) keeps the connection');
    flowStore.updateBlockConfig(src.id, { type: 'ecu' });
    eq(flowStore.getSnapshot().diagram.connections.length, 0, 'incompatible type change drops the connection');
    flowStore.undo();
    eq(flowStore.getSnapshot().diagram.connections.length, 1, 'undo restores the connection');
    // exactly one flow_start; any number of flow_in / flow_out
    ok(flowStore.addBlock('flow_start', 0, 0) === '', 'a second flow_start cannot be added');
    const n1 = flowStore.addBlock('flow_in', 0, 0);
    const n2 = flowStore.addBlock('flow_in', 0, 0);
    const keys = flowStore.getSnapshot().diagram.blocks.filter((b) => b.id === n1 || b.id === n2).map((b) => b.config['key']);
    eq(keys, ['in1', 'in2'], 'added flow_in blocks get unique keys');
  }

  // ── 5. resolveRunInputs ──────────────────────────────────────────────────────
  {
    const specs = [spec('n', 'number', { required: true }), spec('t', 'text', { default: 'hi' }), spec('h', 'hex'), spec('b', 'bool', { default: true }),
      spec('s', 'select', { options: ['a', 'b'], default: 'b' }), spec('img', 'file', { required: true })];
    const r = resolveRunInputs(specs, { n: '7', h: '0A 0B', img: new Uint8Array([1]) });
    eq(r.errors, [], 'all inputs resolve');
    eq([r.values['n'], r.values['t'], Array.from(r.values['h'] as Uint8Array), r.values['b'], r.values['s']], [7, 'hi', [10, 11], true, 'b'], 'typed values and defaults');
    eq(resolveRunInputs(specs, {}).errors.length, 2, 'missing required number + file');
    eq(resolveRunInputs([spec('n', 'number')], { n: 'abc' }).errors.length, 1, 'bad number');
    eq(resolveRunInputs([spec('h', 'hex')], { h: 'zz' }).errors.length, 1, 'bad hex');
    eq(resolveRunInputs([spec('s', 'select', { options: ['a'] })], { s: 'q' }).errors.length, 1, 'bad option');
    eq(resolveRunInputs([spec('ecu', 'ecu', { required: true })], {}).errors.length, 1, 'required ecu input refuses the run');
    eq(resolveRunInputs([spec('ecu', 'ecu')], {}).errors, [], 'optional ecu input is skipped');
    // file inputs resolve to FlowFileValue; a bare Uint8Array is wrapped
    const fv = resolveRunInputs([spec('img', 'file')], { img: { name: 'a.hex', bytes: new Uint8Array([1, 2]) } });
    eq([fv.errors, (fv.values['img'] as { name: string }).name], [[], 'a.hex'], 'FlowFileValue input kept');
    eq((resolveRunInputs([spec('img', 'file')], { img: new Uint8Array([1]) }).values['img'] as { name: string }).name, '', 'bytes wrapped as an unnamed file value');
    // spec checks: range (never clamped), byte length, accepted extension
    eq(resolveRunInputs([spec('n', 'number', { min: 1, max: 10 })], { n: '11' }).errors.length, 1, 'number above max is an error');
    eq(resolveRunInputs([spec('n', 'number', { min: 1, max: 10 })], { n: '0' }).errors.length, 1, 'number below min is an error');
    eq(resolveRunInputs([spec('n', 'number', { min: 1, max: 10 })], { n: '10' }).errors, [], 'number on the bound passes');
    eq(resolveRunInputs([spec('a', 'hex', { byteLength: 4 })], { a: '0102' }).errors.length, 1, 'hex byteLength mismatch');
    eq(resolveRunInputs([spec('a', 'hex', { byteLength: 4 })], { a: '01020304' }).errors, [], 'hex byteLength match');
    eq(resolveRunInputs([spec('img', 'file', { accept: ['.hex', '.bin'] })], { img: { name: 'x.S19', bytes: new Uint8Array([1]) } }).errors.length, 1, 'file extension not accepted');
    eq(resolveRunInputs([spec('img', 'file', { accept: ['.hex', '.bin'] })], { img: { name: 'x.HEX', bytes: new Uint8Array([1]) } }).errors, [], 'file extension accepted (case-insensitive)');
  }

  // ── 6. flow_return / flow_out semantics + run inputs on BOTH engines ─────────
  {
    // outputs sampled from wired values at frame end; inputs read from the flow_in blocks
    const st = blk('flow_start', 'S');
    const inN = blk('flow_in', 'n', { ...spec('n', 'number', { required: true }) });
    const inT = blk('flow_in', 't', { ...spec('t', 'text', { default: 'hi' }) });
    const inH = blk('flow_in', 'h', { ...spec('h', 'hex') });
    const ret = blk('flow_return', 'Ret', { name: 'done', outcome: 'ok' });
    const oN = blk('flow_out', 'n', { ...spec('n', 'number') });
    const oT = blk('flow_out', 't', { ...spec('t', 'text') });
    const oH = blk('flow_out', 'h', { ...spec('h', 'hex') });
    const d = dia([st, inN, inT, inH, ret, oN, oT, oH], [wire(st, 'start', ret, 'in'), wire(inN, 'value', oN, 'value'), wire(inT, 'value', oT, 'value'), wire(inH, 'value', oH, 'value')]);
    await both(d, { n: '7', h: '0A 0B' }, (r, mode) => {
      eq(r.errors, [], `inputs run: no errors [${mode}]`);
      eq(r.eng.result?.outcome, 'ok', `flow_return ok [${mode}]`);
      eq(r.eng.result?.name, 'done', `outcome name [${mode}]`);
      eq(r.eng.result?.outputs['n'], 7, `number input read from the flow_in block [${mode}]`);
      eq(r.eng.result?.outputs['t'], 'hi', `text default used [${mode}]`);
      eq(Array.from(r.eng.result?.outputs['h'] as Uint8Array), [10, 11], `hex input -> bytes [${mode}]`);
      eq([r.eng.result?.stopped, r.eng.result?.refused], [false, false], `not stopped / refused [${mode}]`);
    });
    // missing required input: refused before anything runs
    await both(d, {}, (r, mode) => {
      eq(r.eng.result?.refused, true, `missing required input refuses the run [${mode}]`);
      eq(r.eng.result?.outcome, 'error', `refused run is an error outcome [${mode}]`);
      eq(r.tx, [], `refused run transmits nothing [${mode}]`);
      ok(r.errors.some((m) => m.includes('"n"')), `refusal names the input [${mode}]`);
      eq(flowStore.getSnapshot().diagram.blocks.find((b) => b.id === st.id)?.status, 'error', `entry block marked [${mode}]`);
    });
    // required ecu input: refused
    const fiE = blk('flow_in', 'ecu', { ...spec('ecu', 'ecu', { required: true }) });
    await both(dia([blk('flow_start', 'S'), fiE], []), {}, (r, mode) => {
      eq(r.eng.result?.refused, true, `required ecu input refuses the run [${mode}]`);
    });
    const fiO = blk('flow_in', 'ecu', { ...spec('ecu', 'ecu') });
    await both(dia([blk('flow_start', 'S'), fiO], []), {}, (r, mode) => {
      eq([r.eng.result?.refused, r.eng.result?.outcome], [false, 'ok'], `optional ecu input does not block [${mode}]`);
    });
    // two flow_start blocks / no flow_start: refused
    await both(dia([blk('flow_start', 'A'), blk('flow_start', 'B')], []), {}, (r, mode) => {
      eq(r.eng.result?.refused, true, `two flow_start blocks refuse the run [${mode}]`);
    });
    await both(dia([blk('log', 'L', { message: 'x' })], []), {}, (r, mode) => {
      eq(r.eng.result?.refused, true, `no flow_start refuses the run [${mode}]`);
    });

    // outcomes ok / fail / error
    for (const outcome of ['ok', 'fail', 'error'] as const) {
      const i2 = blk('flow_start', 'S');
      const c = blk('data_const', 'C', { value: '42', format: 'dec' });
      const o2 = blk('flow_return', 'Ret', { name: `n_${outcome}`, outcome });
      const ov = blk('flow_out', 'v', { ...spec('v', 'number') });
      await both(dia([i2, c, o2, ov], [wire(i2, 'start', o2, 'in'), wire(c, 'value_out', ov, 'value')]), {}, (r, mode) => {
        eq([r.eng.result?.outcome, r.eng.result?.name, r.eng.result?.outputs['v']], [outcome, `n_${outcome}`, 42], `flow_return ${outcome} + output recorded [${mode}]`);
      });
    }

    // no flow_return: ok when the path ends (implicit), outputs still sampled
    const l1 = logBlock('L', 'a');
    const i3 = blk('flow_start', 'S');
    await both(dia([i3, l1], [wire(i3, 'start', l1, 'exec_in')]), {}, (r, mode) => {
      eq([r.eng.result?.outcome, r.eng.result?.name, r.eng.result?.outputs], ['ok', null, {}], `implicit ok without outputs [${mode}]`);
      eq(r.lines, ['a'], `flow ran [${mode}]`);
    });
    const i3b = blk('flow_start', 'S');
    const c3b = blk('data_const', 'C', { value: '5', format: 'dec' });
    const o3b = blk('flow_out', 'v', { ...spec('v', 'number') });
    await both(dia([i3b, c3b, o3b], [wire(c3b, 'value_out', o3b, 'value')]), {}, (r, mode) => {
      eq([r.eng.result?.outcome, r.eng.result?.name, r.eng.result?.outputs['v']], ['ok', null, 5], `implicit ok samples the flow_out [${mode}]`);
    });
    const i4 = blk('flow_start', 'S');
    await both(dia([i4], []), {}, (r, mode) => {
      eq(r.eng.result?.outcome, 'ok', `no flow_return: ok [${mode}]`);
    });

    // unhandled error -> error
    const i5 = blk('flow_start', 'S');
    const c5 = blk('data_const', 'C', { value: '1', format: 'dec' });
    const m5 = blk('math', 'Div', { op: 'div', b: 0 });
    const l5 = blk('log', 'L', { message: 'x' });
    await both(dia([i5, c5, m5, l5], [wire(i5, 'start', l5, 'exec_in'), wire(c5, 'value_out', m5, 'a_in'), wire(m5, 'result', l5, 'value_in')]), {}, (r, mode) => {
      eq(r.eng.result?.outcome, 'error', `unhandled error ends with outcome error [${mode}]`);
      ok(r.errors.length > 0, `error logged [${mode}]`);
    });

    // reaching a flow_return inside a loop ends the whole run
    const i6 = blk('flow_start', 'S');
    const f6 = blk('flow_for', 'For', { from: 1, to: 5, step: 1 });
    const a6 = logBlock('A', 'iter');
    const o6 = blk('flow_return', 'Ret', { name: 'stop', outcome: 'fail' });
    const z6 = logBlock('Z', 'after');
    await both(dia([i6, f6, a6, o6, z6], [wire(i6, 'start', f6, 'exec_in'), wire(f6, 'body_out', a6, 'exec_in'), wire(a6, 'exec_out', o6, 'in'), wire(f6, 'done_out', z6, 'exec_in')]), {}, (r, mode) => {
      eq(r.lines, ['iter'], `flow_return in a loop body ends the run after one iteration [${mode}]`);
      eq([r.eng.result?.outcome, r.eng.result?.name], ['fail', 'stop'], `loop flow_return outcome [${mode}]`);
    });
    stopAllTxSources();
  }

  // ── 7. localStorage -> library migration ─────────────────────────────────────
  {
    const legacyDiagram = (id: string, name: string): Record<string, unknown> => ({
      id, name,
      blocks: [
        { id: 's', type: 'start', label: 'Start', x: 10, y: 20, config: {}, status: 'success', statusMessage: 'x', lastResult: 1, collapsed: true },
        { id: 'l', type: 'log', label: 'Log', x: 200, y: 20, config: { message: 'm' }, status: 'idle', collapsed: false },
      ],
      connections: [{ id: 'c1', fromBlockId: 's', fromPortId: 'exec_out', toBlockId: 'l', toPortId: 'exec_in' }],
    });
    const raw = JSON.stringify([legacyDiagram('lxyz_abc123', 'First'), legacyDiagram('second-id', 'Second')]);
    const uuids = (): (() => string) => {
      let n = 0;
      return () => `uuid-${++n}`;
    };

    // success
    {
      const st = new FakeStorage();
      st.setItem(LEGACY_FLOW_STORAGE_KEY, raw);
      const lib = new FakeLib();
      const rep = await migrateLegacyDiagrams(st, lib, { uuid: uuids() });
      eq([rep.skipped, rep.migrated, rep.failed.length], [false, 2, 0], 'migration: both diagrams migrated');
      const list = await lib.list(false);
      eq(list.map((e) => [e.kind, e.latestRevision, e.origin, e.name]).sort(), [['nexuscan.flow', 1, 'user', 'First'], ['nexuscan.flow', 1, 'user', 'Second']].sort(), 'migrated entries are user flows, revision 1');
      const first = parseFlowFile(await lib.load(list.find((e) => e.name === 'First')?.id ?? '', null));
      ok(first.ok, 'migrated file parses');
      if (first.ok) {
        eq(first.file.flow.blocks[0].type, 'flow_start', 'migrated flow uses flow_start');
        eq(first.file.flow.connections[0].fromPortId, 'start', 'migrated connection re-pointed');
        ok(!/status|lastResult/.test(JSON.stringify(first.file.flow)), 'migrated file has no runtime fields');
        eq([first.file.flow.author, first.file.flow.aiReviewed], [null, true], 'author null, aiReviewed true');
        ok(/^uuid-\d+$/.test(first.file.flow.id), 'new uuid id');
      }
      ok(st.getItem(FLOW_REGISTRY_MIGRATED_KEY) !== null, 'marker set on full success');
      eq(st.getItem(LEGACY_FLOW_STORAGE_KEY), raw, 'old key untouched (backup)');
      const again = await migrateLegacyDiagrams(st, lib, { uuid: uuids() });
      eq([again.skipped, lib.saves], [true, 2], 'second run is skipped by the marker (idempotent)');
    }
    // partial failure, then retry
    {
      const st = new FakeStorage();
      st.setItem(LEGACY_FLOW_STORAGE_KEY, raw);
      const lib = new FakeLib();
      lib.failName = 'Second';
      const rep = await migrateLegacyDiagrams(st, lib, { uuid: uuids() });
      eq([rep.migrated, rep.failed.length], [1, 1], 'partial failure reported');
      ok(rep.failed[0].name === 'Second' && rep.failed[0].message.includes('disk full'), 'failure names the diagram and the reason');
      ok(st.getItem(FLOW_REGISTRY_MIGRATED_KEY) === null, 'no marker after a partial failure');
      eq((await lib.list(false)).length, 1, 'the successful diagram is in the library');
      lib.failName = null;
      const retry = await migrateLegacyDiagrams(st, lib, { uuid: uuids() });
      eq([retry.migrated, retry.alreadyDone, retry.failed.length], [1, 1, 0], 'retry migrates only the failed one (no duplicate)');
      eq((await lib.list(false)).length, 2, 'library has exactly two flows after the retry');
      ok(st.getItem(FLOW_REGISTRY_MIGRATED_KEY) !== null, 'marker set after the retry');
      ok(st.getItem(FLOW_REGISTRY_MIGRATED_IDS_KEY) !== null, 'legacy id map kept');
    }
    // empty / garbage
    {
      const st = new FakeStorage();
      const rep = await migrateLegacyDiagrams(st, new FakeLib());
      eq([rep.migrated, rep.failed.length], [0, 0], 'no legacy key: nothing to do');
      ok(st.getItem(FLOW_REGISTRY_MIGRATED_KEY) !== null, 'marker set when there was nothing to migrate');
      const st2 = new FakeStorage();
      st2.setItem(LEGACY_FLOW_STORAGE_KEY, JSON.stringify([{ name: 'broken', blocks: 'x' }, legacyDiagram('ok-id', 'Fine')]));
      const lib2 = new FakeLib();
      const rep2 = await migrateLegacyDiagrams(st2, lib2, { uuid: uuids() });
      eq([rep2.migrated, rep2.failed.length], [1, 1], 'an invalid entry is reported, the others migrate');
      ok(st2.getItem(FLOW_REGISTRY_MIGRATED_KEY) === null, 'invalid entry keeps the marker unset (never silently lost)');
    }
  }

  // ── 8. Registry store: documents, save, conflict, revisions, import ─────────
  {
    let n = 0;
    const uuid = (): string => `id-${++n}`;
    let clock = Date.parse('2026-11-18T10:00:00.000Z');
    const now = (): Date => new Date((clock += 1000));
    const lib = new FakeLib();
    const reg = new FlowRegistryStore(lib, null, { uuid, now });

    // new flow = flow_start; new block = flow_start + flow_return "ok"
    const fid = reg.newDocument('nexuscan.flow');
    eq(flowStore.getSnapshot().diagram.blocks.map((b) => b.type), ['flow_start'], 'new flow starts with a flow_start');
    const bid = reg.newDocument('nexuscan.block');
    const blockDoc = reg.getDoc(bid);
    eq(blockDoc?.kind, 'nexuscan.block', 'custom block document');
    eq(flowStore.getSnapshot().diagram.blocks.map((b) => b.type), ['flow_start', 'flow_return'], 'new block: flow_start + flow_return');
    eq(flowStore.getSnapshot().diagram.blocks[1].config['name'], 'ok', 'block output is "ok"');
    eq(flowStore.getSnapshot().diagram.connections.length, 1, 'block start is wired to the output');
    eq(reg.getSnapshot().activeKey, bid, 'new document is active');
    ok(reg.getDoc(fid)?.dirty === true && reg.getDoc(bid)?.dirty === true, 'new documents are dirty');

    // per-document undo
    reg.activate(fid);
    flowStore.addBlock('delay', 100, 100);
    flowStore.addBlock('delay', 200, 100);
    eq(flowStore.getSnapshot().undoStack.length, 2, 'undo stack of document A');
    reg.activate(bid);
    eq(flowStore.getSnapshot().undoStack.length, 0, 'document B has its own (empty) undo stack');
    flowStore.addBlock('delay', 300, 100);
    reg.activate(fid);
    eq([flowStore.getSnapshot().undoStack.length, flowStore.getSnapshot().diagram.blocks.length], [2, 3], 'A: undo stack and content restored on switch back');
    flowStore.undo();
    eq(flowStore.getSnapshot().diagram.blocks.length, 2, 'undo works in A');

    // save
    flowStore.setDiagramName('Flow A');
    let res = await reg.save(fid);
    ok(res.ok && res.revision === 1, 'first save = revision 1');
    eq(reg.getDoc(fid)?.dirty, false, 'clean after save');
    const saved = parseFlowFile(await lib.load(fid, null));
    ok(saved.ok && saved.file.flow.revision === 1 && saved.file.flow.name === 'Flow A', 'library has r1 with the name');
    if (saved.ok) eq(saved.file.contentHash, await computeContentHash(saved.file.flow), 'saved contentHash matches the content');
    flowStore.addBlock('delay', 10, 10);
    reg.refreshDirty();
    eq(reg.getDoc(fid)?.dirty, true, 'edit makes the document dirty');
    res = await reg.save(fid);
    ok(res.ok && res.revision === 2, 'second save = revision 2');
    flowStore.setBlockStatus(flowStore.getSnapshot().diagram.blocks[0].id, 'success');
    reg.refreshDirty();
    eq(reg.getDoc(fid)?.dirty, false, 'runtime status changes do not make the document dirty');

    // conflict
    {
      const other = new FlowRegistryStore(lib, null, { uuid: () => `o-${++n}`, now });
      await other.open(fid);
      other.refreshDirty();
      // the other registry (same canvas store!) edits and saves r3
      flowStore.addBlock('delay', 1, 1);
      other.refreshDirty();
      const r3 = await other.save(fid);
      ok(r3.ok && r3.revision === 3, 'other session saves r3');
      // our registry still believes r2
      reg.activate(fid);
      flowStore.loadDocument(reg.getDoc(fid)?.diagram as FlowDiagram);
      flowStore.addBlock('delay', 2, 2);
      reg.refreshDirty();
      const c = await reg.save(fid);
      ok(!c.ok && c.conflict, 'stale save reports a conflict');
      eq(reg.getSnapshot().conflict?.latestRevision, 3, 'conflict dialog data names the latest revision');
      eq((await lib.list(false)).find((e) => e.id === fid)?.latestRevision, 3, 'library untouched by the conflicting save');
      // save as copy
      const before = (await lib.list(false)).length;
      await reg.resolveConflictSaveCopy();
      eq(reg.getSnapshot().conflict, null, 'conflict cleared');
      const after = await lib.list(false);
      eq(after.length, before + 1, 'save as copy created a new item');
      ok(after.some((e) => e.name === 'Flow A (kopya)' && e.latestRevision === 1 && e.id !== fid), 'copy is a new r1 item');
      eq(reg.getDoc(fid)?.baseRevision, 3, 'original reloaded to the latest revision');
      eq(reg.getDoc(fid)?.dirty, false, 'original is clean after reload');
    }
    {
      // reload latest path
      reg.activate(fid);
      flowStore.addBlock('delay', 3, 3);
      reg.refreshDirty();
      // make the library move on behind our back
      const text = await lib.load(fid, null);
      const p = parseFlowFile(text);
      if (!p.ok) throw new Error('parse');
      const body: NxFlowBodyV1 = { ...p.file.flow, revision: 4, name: 'Flow A moved' };
      await lib.save(JSON.stringify(await buildFlowFile('nexuscan.flow', body)));
      const c = await reg.save(fid);
      ok(!c.ok && c.conflict, 'second conflict detected');
      await reg.resolveConflictReload();
      eq([reg.getDoc(fid)?.baseRevision, flowStore.getSnapshot().diagram.name], [4, 'Flow A moved'], 'reload latest replaces the document content');
      eq(reg.getDoc(fid)?.dirty, false, 'reloaded document is clean');
    }

    // revisions, read-only view, restore as new revision
    await reg.loadRevisions(fid);
    eq(reg.getSnapshot().revisions?.list.map((r) => r.revision), [1, 2, 3, 4], 'revision list');
    ok(await reg.openRevision(fid, 1), 'open a revision');
    const ro = reg.getDoc(`${fid}@r1`);
    eq([ro?.readOnly, ro?.viewRevision, reg.getSnapshot().activeKey], [true, 1, `${fid}@r1`], 'revision opens as a read-only document');
    eq(flowStore.getSnapshot().readOnly, true, 'canvas is read-only');
    const nBlocks = flowStore.getSnapshot().diagram.blocks.length;
    eq(flowStore.addBlock('delay', 0, 0), '', 'read-only canvas refuses addBlock');
    flowStore.removeBlock(flowStore.getSnapshot().diagram.blocks[0].id);
    flowStore.setDiagramName('nope');
    eq([flowStore.getSnapshot().diagram.blocks.length, flowStore.getSnapshot().diagram.name === 'nope'], [nBlocks, false], 'read-only canvas refuses edits');
    ok(!(await reg.save(`${fid}@r1`)).ok, 'a read-only revision cannot be saved');
    reg.close(`${fid}@r1`);
    eq(flowStore.getSnapshot().readOnly, false, 'closing the revision restores the editable canvas');
    ok(await reg.restoreRevision(fid, 1), 'restore revision 1 as new');
    eq((await lib.list(false)).find((e) => e.id === fid)?.latestRevision, 5, 'restore created revision 5');
    eq(reg.getDoc(fid)?.baseRevision, 5, 'document reopened at r5');

    // duplicate / rename / delete / restore
    ok(await reg.duplicate(fid), 'duplicate');
    ok((await lib.list(false)).filter((e) => e.name.endsWith('(kopya)')).length >= 2, 'duplicate is a separate item');
    reg.close(fid);
    ok(await reg.rename(fid, 'Renamed A'), 'rename a closed item');
    eq((await lib.list(false)).find((e) => e.id === fid)?.name, 'Renamed A', 'rename wrote a new revision with the new name');
    eq((await lib.list(false)).find((e) => e.id === fid)?.latestRevision, 6, 'rename = next revision');
    ok(await reg.remove(fid), 'soft delete');
    ok(!(await lib.list(false)).some((e) => e.id === fid) && (await lib.list(true)).some((e) => e.id === fid), 'deleted item hidden unless requested');
    ok(await reg.restoreDeleted(fid), 'restore deleted');
    eq((await lib.list(false)).find((e) => e.id === fid)?.latestRevision, 7, 'restore = next revision of the last body');
    eq(await reg.rename(fid, '   '), false, 'empty rename refused');

    // import
    const exportedText = await lib.load(fid, null);
    ok(await reg.importText(exportedText), 'import a library file');
    const imported = (await lib.list(false)).filter((e) => e.origin === 'import');
    eq(imported.length, 1, 'imported item has origin import');
    ok(imported[0].id !== fid && imported[0].latestRevision === 1, 'import regenerates the id and starts at r1');
    ok(!(await reg.importText('not json')), 'invalid import refused');
    ok((reg.getSnapshot().error ?? '').length > 0, 'invalid import reports an error');
    // import of a legacy-start file migrates it
    const legacyFile = JSON.stringify({
      schemaVersion: 1, kind: 'nexuscan.flow', contentHash: '',
      flow: { id: 'legacy-1', name: 'Legacy', blocks: [{ id: 's', type: 'start', label: 'Start', config: {} }], connections: [] },
    });
    ok(await reg.importText(legacyFile), 'import a file without hash / meta');
    const legacyEntry = (await lib.list(false)).find((e) => e.name === 'Legacy');
    ok(legacyEntry !== undefined, 'legacy import stored');
    const lp = parseFlowFile(await lib.load(legacyEntry?.id ?? '', null));
    eq(lp.ok ? lp.file.flow.blocks[0].type : '?', 'flow_start', 'imported start migrated to flow_start');
    eq(lp.ok ? lp.file.flow.blocks[0].x : -1, 80, 'imported block without coordinates is laid out');

    // tabs: close the active document selects a neighbour; the last close empties the canvas
    for (const d of [...reg.getSnapshot().docs]) reg.close(d.key);
    eq([reg.getSnapshot().docs.length, reg.getSnapshot().activeKey], [0, null], 'all documents closed');
    eq(flowStore.getSnapshot().diagram.blocks.length, 0, 'canvas is empty without a document');
    // list error handling
    const broken = new FlowRegistryStore({ ...lib, list: async () => { throw new Error('[flowlib:io] boom'); } } as unknown as FlowLibClient, null, { uuid, now });
    await broken.refresh();
    ok((broken.getSnapshot().error ?? '').includes('boom'), 'list failure is surfaced');
    eq(parseFlowLibError('[flowlib:conflict] x')?.code, 'conflict', 'conflict error code parses');
  }

  // ── 9. Side-panel preferences ────────────────────────────────────────────────
  {
    eq(clampPanelWidth(100, 160, 480), 160, 'width clamps to min');
    eq(clampPanelWidth(900, 160, 480), 480, 'width clamps to max');
    eq(clampPanelWidth(300.4, 160, 480), 300, 'width rounds');
    eq(parsePanelPrefs(null, 220, 160, 480), { width: 220, collapsed: false }, 'default prefs');
    eq(parsePanelPrefs('{"w":333,"c":true}', 220, 160, 480), { width: 333, collapsed: true }, 'stored prefs');
    eq(parsePanelPrefs('{"w":9999}', 220, 160, 480), { width: 480, collapsed: false }, 'stored width is clamped');
    eq(parsePanelPrefs('garbage', 220, 160, 480), { width: 220, collapsed: false }, 'garbage falls back to defaults');
  }

  console.log(`flowRegistry.test: ${passed} checks passed`);
}

await main();
