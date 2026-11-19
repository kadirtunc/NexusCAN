/**
 * Headless tests of flow-interface-v2 (Simulink-style ports, bindable parameters): interface derivation order,
 * the deterministic v1 -> v2 migration (shared output keys, conflicts, call-block port ids), bound-parameter
 * overrides on BOTH engines (validation before any TX, stored config untouched), the promote action, required
 * outputs (real enforces on `ok` only), "Make Custom Block" output and the production flasher templates
 * (contract interface, headless simulated run with a `FlowFileValue` firmware input).
 * Run: `npm run test:flowiface` (esbuild bundle -> node; throws on the first failure).
 */
import { FlowEngine, type FlowRunOptions } from './FlowEngine';
import { flowStore } from './FlowStore';
import { callIndex, callType } from './callIndex';
import { callPorts } from './callPorts';
import { buildExtraction } from './extractBlock';
import { migrateAll, migrateInterfaceV2 } from './flowMigrate';
import { deriveFlowInterface, interfaceSummary, resolveRunInputs, validateInterface } from './flowInterface';
import { bindParam, promoteParam, unbindParam } from './boundEdit';
import { bindableFields, getBlockDefFor } from './blockDefs';
import { asBytes } from './flowValues';
import { FLOW_TEMPLATES } from './templates';
import type { FlowRequestOptions, FlowTransport } from './flowTransport';
import type { FlowBlock, FlowConnection, FlowDiagram } from './types';
import { FakeLib } from './registry/fakeLib';
import { FlowRegistryStore } from './registry/flowRegistryStore';
import { buildFlowFile, toFlowBody } from './registry/flowBody';
import { newEcuRecord } from '../diagnostics/workspace/ecuDefaults';
import { t } from '../../i18n';
import type { FlowFileValue, FlowPortSpecV1 } from '../../types/flowLibrary';

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
function blk(type: string, label: string, config: Record<string, unknown> = {}, id?: string): FlowBlock {
  return { id: id ?? `b${++seq}`, type, label, x: 100 + seq * 10, y: 200 + seq * 5, config, status: 'idle', collapsed: false };
}
function wire(from: FlowBlock, fromPort: string, to: FlowBlock, toPort: string): FlowConnection {
  return { id: `c${++seq}`, fromBlockId: from.id, fromPortId: fromPort, toBlockId: to.id, toPortId: toPort };
}
function dia(blocks: FlowBlock[], connections: FlowConnection[]): FlowDiagram {
  return { id: 'd', name: 'd', blocks, connections, variables: [] };
}
const spec = (key: string, type: FlowPortSpecV1['type'], extra: Partial<FlowPortSpecV1> = {}): FlowPortSpecV1 => ({ key, label: key, type, required: false, ...extra });
const fin = (s: FlowPortSpecV1): FlowBlock => blk('flow_in', s.key, { ...s });
const fout = (s: FlowPortSpecV1): FlowBlock => blk('flow_out', s.key, { ...s });
const logb = (message: string): FlowBlock => blk('log', `Log ${message}`, { message });
function load(d: FlowDiagram): void {
  flowStore.loadTemplate({
    id: 'x', nameKey: 'flowCore.tpl.counter.name', descriptionKey: 'flowCore.tpl.counter.desc', category: 'examples', icon: '',
    diagram: { blocks: d.blocks, connections: d.connections, ...(d.variables ? { variables: d.variables } : {}) },
  });
}
const snap = (): FlowDiagram => flowStore.getSnapshot().diagram;

// ─── Transports ────────────────────────────────────────────────────────────────

const simTransport = { demo: true } as unknown as FlowTransport;
const hx = (b: readonly number[]): string => b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
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
  async readDid(did: number): Promise<number[]> {
    return (await this.request(0x22, [(did >> 8) & 0xff, did & 0xff])).slice(3);
  }
  async request(sid: number, data: readonly number[], _o: FlowRequestOptions = {}): Promise<number[]> {
    this.sent.push(hx([sid, ...data]));
    if (sid === 0x10) return [0x50, data[0], 0x00, 0x32, 0x01, 0xf4];
    if (sid === 0x22) return [0x62, data[0], data[1], 0x41, 0x42];
    throw new Error(`unexpected request ${sid.toString(16)}`);
  }
}

type Mode = 'sim' | 'real';
interface Run {
  eng: FlowEngine;
  tr: StubTransport;
  msgs: string[];
  errors: string[];
}
async function run(mode: Mode, d: FlowDiagram, opts: FlowRunOptions = {}): Promise<Run> {
  load(d);
  const tr = new StubTransport();
  const eng = new FlowEngine();
  await eng.run({ transport: mode === 'sim' ? simTransport : tr, ...opts });
  const s = flowStore.getSnapshot();
  ok(!s.isRunning, `run state reset [${mode}]`);
  return { eng, tr, msgs: s.runLog.map((e) => e.message), errors: s.runLog.filter((e) => e.level === 'error').map((e) => e.message) };
}
const MODES = ['sim', 'real'] as const;

// ─── v1 fixtures (legacy blocks, exactly as old library files store them) ──────

/** v1 flow: flow_input(a number, b hex, c file) + two flow_outputs sharing the output key `r` (same source). */
function v1Shared(): { d: FlowDiagram; ids: Record<string, string> } {
  const fi = blk('flow_input', 'In', { inputs: [spec('a', 'number', { required: true }), spec('b', 'hex'), spec('c', 'file')] }, 'fi');
  const lg = logb('x');
  const c1 = blk('data_const', 'C1', { value: '5', format: 'dec' });
  const o1 = blk('flow_output', 'Done', { name: 'done', outcome: 'ok', outputs: [spec('r', 'number'), spec('s', 'text')] }, 'o1');
  const o2 = blk('flow_output', 'Bad', { name: 'bad', outcome: 'fail', outputs: [spec('r', 'number')] }, 'o2');
  const conns = [
    wire(fi, 'start', lg, 'exec_in'), wire(lg, 'exec_out', o1, 'in'), wire(fi, 'a', lg, 'value_in'),
    wire(c1, 'value_out', o1, 'r'), wire(c1, 'value_out', o2, 'r'), wire(fi, 'a', o1, 's'),
  ];
  return { d: dia([fi, lg, c1, o1, o2], conns), ids: { fi: fi.id, lg: lg.id, c1: c1.id, o1: o1.id, o2: o2.id, aToLog: conns[2].id, c1ToO1: conns[3].id, aToS: conns[5].id } };
}

async function main(): Promise<void> {
  // ── 1. Interface derivation order ────────────────────────────────────────────
  {
    const d = dia([
      blk('flow_start', 'S'),
      fin(spec('beta', 'text', { order: 1 })), fin(spec('alpha', 'text', { order: 1 })), fin(spec('first', 'number', { order: 0 })), fin(spec('loose', 'text')),
      fout(spec('o2', 'text', { order: 1 })), fout(spec('o1', 'text', { order: 0 })),
      blk('flow_return', 'B', { name: 'bad', outcome: 'fail' }), blk('flow_return', 'A', { name: 'ok', outcome: 'ok' }), blk('flow_return', 'A2', { name: 'ok', outcome: 'ok' }),
    ], []);
    const iface = deriveFlowInterface(d);
    eq(iface.inputs.map((i) => i.key), ['first', 'alpha', 'beta', 'loose'], 'inputs sorted by (order, key), unordered last');
    eq(iface.outputs.map((o) => o.key), ['o1', 'o2'], 'outputs sorted by order');
    eq(iface.outcomes, [{ name: 'bad', outcome: 'fail' }, { name: 'ok', outcome: 'ok' }], 'outcomes in block order, a repeated name counts once');
    eq(interfaceSummary(d), 'in(first, alpha, beta, loose) → bad · ok | out(o1, o2)', 'summary line: in(...) → outcomes | out(...)');
    eq(interfaceSummary(dia([blk('flow_start', 'S')], [])), 'in() → ok', 'summary of an empty interface');
    const { ports } = callPorts(iface);
    eq(ports.filter((p) => p.direction === 'input').map((p) => p.id), ['in', 'first', 'alpha', 'beta', 'loose'], 'call block inputs follow the interface order');
    eq(ports.filter((p) => p.direction === 'output').map((p) => p.id), ['bad', 'ok', 'error', 'o1', 'o2'], 'call block outputs: outcomes, error, flow-level outputs');
  }

  // ── 2. Migration of a v1 flow (3 inputs, 2 outputs sharing a key + source) ───
  {
    const { d, ids } = v1Shared();
    const { diagram: m, notes } = migrateInterfaceV2(d);
    eq(notes.length, 1, 'one non-blocking migration note, no conflict notes');
    const byId = (id: string): FlowBlock | undefined => m.blocks.find((b) => b.id === id);
    eq([byId(ids.fi)?.type, byId(ids.fi)?.config], ['flow_start', {}], 'flow_input -> flow_start (same id)');
    eq(['fi__in_a', 'fi__in_b', 'fi__in_c'].map((id) => byId(id)?.type), ['flow_in', 'flow_in', 'flow_in'], 'one flow_in per input with deterministic ids');
    eq(['fi__in_a', 'fi__in_b', 'fi__in_c'].map((id) => byId(id)?.config['order']), [0, 1, 2], 'order = index');
    eq(byId('fi__in_a')?.config, { key: 'a', label: 'a', type: 'number', required: true, order: 0 }, 'flow_in config = spec + order');
    const fiOld = d.blocks[0];
    const ys = ['fi__in_a', 'fi__in_b', 'fi__in_c'].map((id) => byId(id)?.y ?? -1);
    ok(['fi__in_a', 'fi__in_b', 'fi__in_c'].every((id) => byId(id)?.x === fiOld.x) && ys[0] > fiOld.y && ys[0] < ys[1] && ys[1] < ys[2], 'flow_in blocks keep x and are stacked below the old block');
    eq([byId(ids.o1)?.type, byId(ids.o1)?.config, byId(ids.o2)?.type, byId(ids.o2)?.config], ['flow_return', { name: 'done', outcome: 'ok' }, 'flow_return', { name: 'bad', outcome: 'fail' }], 'flow_output -> flow_return {name, outcome} (same ids)');
    const outs = m.blocks.filter((b) => b.type === 'flow_out');
    eq(outs.map((b) => b.id), ['o1__out_r', 'o1__out_s'], 'one flow_out per distinct key, id = firstOwner__out_key (shared key r once)');
    eq(outs.map((b) => b.config['order']), [0, 1], 'flow_out order = first-seen index');
    eq(outs.map((b) => b.config['migrateConflict']), [undefined, undefined], 'same key + same source: no conflict');
    const conn = (id: string): FlowConnection | undefined => m.connections.find((c) => c.id === id);
    eq([conn(ids.aToLog)?.fromBlockId, conn(ids.aToLog)?.fromPortId], ['fi__in_a', 'value'], 'connection (fi, a) -> (flow_in a, value), same id');
    eq([conn(ids.c1ToO1)?.toBlockId, conn(ids.c1ToO1)?.toPortId, conn(ids.c1ToO1)?.fromBlockId], ['o1__out_r', 'value', ids.c1], 'shared-source connection kept on the flow_out');
    eq(m.connections.filter((c) => c.toBlockId === 'o2' || c.toBlockId === ids.o2).map((c) => c.toPortId), [], 'nothing wired into the migrated flow_return o2 data ports');
    eq([conn(ids.aToS)?.fromBlockId, conn(ids.aToS)?.toBlockId, conn(ids.aToS)?.toPortId], ['fi__in_a', 'o1__out_s', 'value'], 'flow_input -> flow_output data path becomes flow_in -> flow_out');
    eq(m.connections.length, d.connections.length - 1, 'exactly the duplicate shared-source connection is gone');
    eq(validateInterface(m), [], 'the migrated flow validates');
    const iface = deriveFlowInterface(m);
    eq([iface.inputs.map((i) => i.key), iface.outcomes.map((o) => o.name), iface.outputs.map((o) => o.key)], [['a', 'b', 'c'], ['done', 'bad'], ['r', 's']], 'derived interface of the migrated flow');
    ok(migrateInterfaceV2(m).diagram === m, 'migration is idempotent (same object)');
    eq(migrateAll(d).diagram.blocks.map((b) => b.id), migrateAll(d).diagram.blocks.map((b) => b.id), 'deterministic ids (two migrations of the same input)');
  }

  // ── 3. Migration conflicts (never silent) ────────────────────────────────────
  {
    // different sources for the same key
    const fi = blk('flow_input', 'In', { inputs: [] }, 'fi');
    const c1 = blk('data_const', 'C1', { value: '1', format: 'dec' });
    const c2 = blk('data_const', 'C2', { value: '2', format: 'dec' });
    const o1 = blk('flow_output', 'A', { name: 'a', outcome: 'ok', outputs: [spec('r', 'number')] }, 'oa');
    const o2 = blk('flow_output', 'B', { name: 'b', outcome: 'fail', outputs: [spec('r', 'number')] }, 'ob');
    const d = dia([fi, c1, c2, o1, o2], [wire(fi, 'start', o1, 'in'), wire(c1, 'value_out', o1, 'r'), wire(c2, 'value_out', o2, 'r')]);
    const { diagram: m, notes } = migrateInterfaceV2(d);
    const out = m.blocks.find((b) => b.type === 'flow_out') as FlowBlock;
    eq(m.blocks.filter((b) => b.type === 'flow_out').length, 1, 'conflict: one flow_out is kept');
    eq(m.connections.filter((c) => c.toBlockId === out.id).map((c) => c.fromBlockId), [c1.id], 'conflict: the FIRST source is kept, the other dropped');
    ok(typeof out.config['migrateConflict'] === 'string' && (out.config['migrateConflict'] as string).includes('C2'), 'conflict: the dropped source is named in the marker');
    eq(notes.length, 2, 'conflict: the conflict note comes with the general migration note');
    const issues = validateInterface(m).filter((i) => i.code === 'migrate_output_conflict');
    eq(issues.map((i) => i.blockId), [out.id], 'conflict: validation issue migrate_output_conflict on the flow_out');
    for (const mode of MODES) {
      const r = await run(mode, d);
      eq([r.eng.result?.refused, r.eng.result?.outcome], [true, 'error'], `conflict: the flow cannot run [${mode}]`);
      eq(r.tr.sent, [], `conflict: nothing transmitted [${mode}]`);
      eq(snap().blocks.find((b) => b.id === out.id)?.status, 'error', `conflict: the flow_out is marked [${mode}]`);
    }
    // there is no "acknowledge": the flag clears only when the output is really rewired
    flowStore.updateBlockConfig(out.id, { label: 'r2' });
    eq(validateInterface(snap()).map((i) => i.code), [], 'conflict: editing the flow_out clears the flag');
    load(d);
    const conn = snap().connections.find((c) => c.toBlockId === out.id) as FlowConnection;
    ok(validateInterface(snap()).some((i) => i.code === 'migrate_output_conflict'), 'conflict: reload keeps the flag');
    flowStore.removeConnection(conn.id);
    eq(validateInterface(snap()).map((i) => i.code), [], 'conflict: rewiring clears the flag');
    const after = new FlowEngine();
    await after.run({ transport: simTransport });
    eq(after.result?.refused, false, 'conflict: runs once fixed');

    // different types for the same key
    const t1 = blk('flow_output', 'A', { name: 'a', outcome: 'ok', outputs: [spec('r', 'number')] }, 'ta');
    const t2 = blk('flow_output', 'B', { name: 'b', outcome: 'fail', outputs: [spec('r', 'bytes')] }, 'tb');
    const mt = migrateInterfaceV2(dia([blk('flow_input', 'In', { inputs: [] }), t1, t2], [])).diagram;
    eq(validateInterface(mt).map((i) => i.code), ['migrate_output_conflict'], 'conflict: different types for one key');
    eq(mt.blocks.find((b) => b.type === 'flow_out')?.config['type'], 'number', 'conflict: the first type is kept');

    // an output wired in one outcome only is NOT a conflict
    const u1 = blk('flow_output', 'A', { name: 'a', outcome: 'ok', outputs: [spec('r', 'number')] }, 'ua');
    const u2 = blk('flow_output', 'B', { name: 'b', outcome: 'fail', outputs: [spec('r', 'number')] }, 'ub');
    const cs = blk('data_const', 'C', { value: '1', format: 'dec' });
    const mu = migrateInterfaceV2(dia([blk('flow_input', 'In', { inputs: [] }), cs, u1, u2], [wire(cs, 'value_out', u2, 'r')])).diagram;
    eq(validateInterface(mu).map((i) => i.code), [], 'a key wired in only one old output merges without conflict');
    eq(mu.connections.map((c) => [c.fromBlockId, c.toBlockId]), [[cs.id, 'ua__out_r']], 'the single source feeds the merged flow_out');
  }

  // ── 4. Call block port ids survive the migration of the callee ───────────────
  for (const mode of MODES) {
    callIndex.clear();
    const lib = new FakeLib();
    const reg = new FlowRegistryStore(lib, null, { uuid: () => 'u1', now: () => new Date('2026-11-19T10:00:00.000Z') });
    // v1 callee, stored AS IS (legacy blocks): input n, optional m, outcomes done / bad, output r
    const fi = blk('flow_input', 'In', { inputs: [spec('n', 'number', { required: true }), spec('m', 'number')] });
    const inc = blk('math', 'Inc', { op: 'add', b: 1 });
    const done = blk('flow_output', 'Done', { name: 'done', outcome: 'ok', outputs: [spec('r', 'number')] });
    const bad = blk('flow_output', 'Bad', { name: 'bad', outcome: 'fail', outputs: [] });
    const v1 = dia([fi, inc, done, bad], [wire(fi, 'start', done, 'in'), wire(fi, 'n', inc, 'a_in'), wire(inc, 'result', done, 'r')]);
    const body = toFlowBody({ ...v1, id: 'CAL', name: 'Callee' }, { id: 'CAL', revision: 1, description: '', createdAt: '2026-11-19T10:00:00.000Z', updatedAt: '2026-11-19T10:00:00.000Z', author: null, origin: 'user', aiReviewed: true, tags: [] });
    await lib.save(JSON.stringify(await buildFlowFile('nexuscan.block', body)));
    const v1PortIds = ['in', 'n', 'm', 'done', 'bad', 'error', 'r'];

    // parent wired to the v1 port ids
    const rs = blk('flow_start', 'S');
    const c = blk('data_const', 'C', { value: '41', format: 'dec' });
    const cl = blk(callType('CAL'), 'Call', { ref: { flowId: 'CAL', revision: 1 } });
    const l1 = logb('done');
    const l2 = logb('err');
    const parent = dia([rs, c, cl, l1, l2], [wire(rs, 'start', cl, 'in'), wire(c, 'value_out', cl, 'n'), wire(cl, 'done', l1, 'exec_in'), wire(cl, 'r', l1, 'value_in'), wire(cl, 'error', l2, 'exec_in')]);
    const r = await run(mode, parent, { rootId: 'root', rootName: 'Root', resolveCallee: (id, rev) => reg.loadBody(id, rev) });
    eq(r.errors, [], `callee v1 port ids: no errors [${mode}]`);
    ok(r.msgs.some((m) => /LOG: done 42/.test(m)), `callee v1 port ids: the parent wiring still works (outcome + input + output) [${mode}]`);
    const info = callIndex.get({ flowId: 'CAL', revision: 1 });
    eq(callPorts(info?.iface ?? deriveFlowInterface(dia([], []))).ports.map((p) => p.id), v1PortIds, `callee v1 port ids: identical to the v1 derivation [${mode}]`);
    eq(getBlockDefFor(snap().blocks.find((b) => b.id === cl.id) as FlowBlock)?.ports.map((p) => p.id), v1PortIds, `callee v1 port ids: the call block ports [${mode}]`);
  }

  // ── 5. Bound parameters on BOTH engines ──────────────────────────────────────
  {
    eq(bindableFields('delay').map((f) => [f.key, f.kind, f.portType]), [['delay_ms', 'number', 'data']], 'delay: number field is bindable');
    eq(bindableFields('uds_flash_image').at(-1)?.key, 'file', 'uds_flash_image exposes the file pseudo-field');
    eq([bindableFields('flow_return').length, bindableFields('flow_goto').length, bindableFields('var_get').length], [0, 0, 0], 'structural blocks / variable selectors are not bindable');
    ok(bindableFields('text_format').every((f) => f.key !== 'inputs'), 'namelist fields (text_format inputs) are not bindable');
    ok(bindableFields('var_set').every((f) => f.key !== 'name'), 'variable selectors are not bindable');
    ok(bindableFields('uds_security_access').every((f) => f.key !== 'script'), 'code fields are not bindable');

    // number
    for (const mode of MODES) {
      const st = blk('flow_start', 'S');
      const w = fin(spec('wait', 'number', { default: 7 }));
      const dl = blk('delay', 'Wait', { delay_ms: 1, boundParams: ['delay_ms'] });
      const d = dia([st, w, dl, blk('flow_return', 'R', { name: 'ok', outcome: 'ok' })], []);
      d.connections.push(wire(st, 'start', dl, 'exec_in'), wire(w, 'value', dl, 'p:delay_ms'), wire(dl, 'exec_out', d.blocks[3], 'in'));
      eq(validateInterface(d), [], `number: valid [${mode}]`);
      const r = await run(mode, d, { inputs: { wait: 9 } });
      eq(r.errors, [], `number: no errors [${mode}]`);
      ok(r.msgs.some((m) => m.includes(t('diagEng.delayDone', { ms: 9 }))), `number: the bound value (9 ms) overrides the stored 1 ms [${mode}]`);
      eq(snap().blocks.find((b) => b.id === dl.id)?.config['delay_ms'], 1, `number: the stored config is untouched [${mode}]`);
      const dflt = await run(mode, d);
      ok(dflt.msgs.some((m) => m.includes(t('diagEng.delayDone', { ms: 7 }))), `number: the flow_in default is used when no value is given [${mode}]`);
    }

    // hex (did) on the real engine: the request carries the bound DID
    {
      const st = blk('flow_start', 'S');
      const w = fin(spec('did', 'hex', { byteLength: 2, default: 'F190' }));
      const rd = blk('uds_read_did', 'Read', { did: 'F187', boundParams: ['did'] });
      const d = dia([st, w, rd], [wire(st, 'start', rd, 'exec_in'), wire(w, 'value', rd, 'p:did')]);
      const r = await run('real', d, { inputs: { did: 'F1 89' } });
      eq(r.tr.sent, ['22 F1 89'], 'hex: the bound DID (F189) overrides the stored one (F187)');
      eq(snap().blocks.find((b) => b.id === rd.id)?.config['did'], 'F187', 'hex: stored DID untouched');
      const dr = await run('real', d);
      eq(dr.tr.sent, ['22 F1 90'], 'hex: the flow_in default is used');
    }
    // invalid hex (odd length from a text source) -> block error, nothing transmitted
    for (const mode of MODES) {
      const st = blk('flow_start', 'S');
      const src = blk('data_const', 'Bad', { value: 'F19', format: 'text' });
      const rd = blk('uds_read_did', 'Read', { did: 'F187', boundParams: ['did'] });
      const r = await run(mode, dia([st, src, rd], [wire(st, 'start', rd, 'exec_in'), wire(src, 'value_out', rd, 'p:did')]));
      eq(r.eng.result?.outcome, 'error', `invalid hex: block error ends the run [${mode}]`);
      eq(r.tr.sent, [], `invalid hex: nothing transmitted [${mode}]`);
      ok(r.errors.some((m) => m.includes('Read') && m.includes('p:did')), `invalid hex: the error names block and port [${mode}]`);
      eq(snap().blocks.find((b) => b.id === rd.id)?.status, 'error', `invalid hex: block marked [${mode}]`);
    }
    // select: valid value is used, a value outside the FIELD options is a block error before TX
    {
      const st = blk('flow_start', 'S');
      const w = fin(spec('mode', 'select', { options: ['extended', 'programming', 'bogus'], default: 'extended' }));
      const ses = blk('uds_session', 'Ses', { session_type: 'default', boundParams: ['session_type'] });
      const d = dia([st, w, ses], [wire(st, 'start', ses, 'exec_in'), wire(w, 'value', ses, 'p:session_type')]);
      const good = await run('real', d, { inputs: { mode: 'programming' } });
      eq(good.tr.sent, ['10 02'], 'select: the bound session type (programming) overrides the stored default');
      eq(snap().blocks.find((b) => b.id === ses.id)?.config['session_type'], 'default', 'select: stored config untouched');
      for (const mode of MODES) {
        const r = await run(mode, d, { inputs: { mode: 'bogus' } });
        eq(r.eng.result?.outcome, 'error', `select outside the field options: block error [${mode}]`);
        eq(r.tr.sent, [], `select outside the field options: nothing transmitted [${mode}]`);
        eq(snap().blocks.find((b) => b.id === ses.id)?.config['session_type'], 'default', `select outside the field options: stored config untouched [${mode}]`);
      }
    }
    // boolean from text; missing value (unconnected source output) -> block error
    {
      const st = blk('flow_start', 'S');
      const w = fin(spec('spr', 'bool', { default: true }));
      const rs = blk('uds_session', 'Ses', { session_type: 'default', req_spr: false, boundParams: ['session_type'] });
      void w;
      const d = dia([st, rs], [wire(st, 'start', rs, 'exec_in')]);
      // unwired p: port: refused by validation, nothing transmitted
      for (const mode of MODES) {
        const r = await run(mode, d);
        eq([r.eng.result?.refused, r.tr.sent], [true, []], `unwired p: port refuses the run [${mode}]`);
        ok(validateInterface(d).some((i) => i.code === 'bound_unwired' && i.blockId === rs.id), 'unwired p: port is a validation issue');
      }
      const unk = blk('uds_session', 'Ses', { session_type: 'default', boundParams: ['nope'] });
      eq(validateInterface(dia([blk('flow_start', 'S'), unk], [])).map((i) => i.code), ['bound_unknown'], 'unknown boundParams key is an error');
    }
  }

  // ── 6. Bind / unbind / promote ───────────────────────────────────────────────
  {
    const st = blk('flow_start', 'S');
    const fl = blk('uds_flash_image', 'Flash', { base_address: '08000000', format: 'auto' }, 'flash');
    const ses = blk('uds_session', 'Ses', { session_type: 'extended' }, 'ses');
    const d0 = dia([st, fl, ses], []);
    let n = 0;
    const gen = (p: string): string => `${p}_g${++n}`;

    const hexRes = promoteParam(d0, 'flash', 'base_address', gen);
    ok(hexRes.ok, 'promote: a hex field can be promoted');
    if (!hexRes.ok) throw new Error('unreachable');
    const fiB = hexRes.diagram.blocks.find((b) => b.id === hexRes.flowInId) as FlowBlock;
    eq([fiB.type, fiB.config['key'], fiB.config['type'], fiB.config['default'], fiB.config['order'], fiB.config['required']], ['flow_in', 'base_address', 'hex', '08000000', 0, false], 'promote: flow_in key / type / default = current value / order');
    eq(fiB.config['label'], t('flash.cfg.baseAddress'), 'promote: label = the field label');
    ok(fiB.x < fl.x && hexRes.key === 'base_address', 'promote: the flow_in sits left of the block');
    const flB = hexRes.diagram.blocks.find((b) => b.id === 'flash') as FlowBlock;
    eq(flB.config['boundParams'], ['base_address'], 'promote: the field is bound');
    eq(hexRes.diagram.connections.map((c) => [c.fromBlockId, c.fromPortId, c.toBlockId, c.toPortId]), [[hexRes.flowInId, 'value', 'flash', 'p:base_address']], 'promote: flow_in.value -> block.p:key wired');
    eq(getBlockDefFor(flB)?.ports.find((p) => p.id === 'p:base_address')?.type, 'data', 'promote: the block now has the p: input port');
    eq(validateInterface(hexRes.diagram), [], 'promote: the result validates');
    eq(promoteParam(hexRes.diagram, 'flash', 'base_address', gen), { ok: false, reason: 'wired' }, 'promote: a port that already has a source is refused');
    eq(hexRes.diagram.blocks.find((b) => b.id === 'flash')?.config['base_address'], '08000000', 'promote: the stored value is kept');

    // de-duplication of the key
    const dup = promoteParam(hexRes.diagram, 'ses', 'session_type', gen);
    ok(dup.ok, 'promote: select field');
    if (dup.ok) {
      const selIn = dup.diagram.blocks.find((b) => b.id === dup.flowInId) as FlowBlock;
      eq([selIn.config['type'], selIn.config['options'], selIn.config['default'], selIn.config['order']], ['select', ['default', 'programming', 'extended', 'safety'], 'extended', 1], 'promote: select options copied, order continues');
    }
    const clash = promoteParam(dia([...hexRes.diagram.blocks, blk('uds_flash_image', 'Flash2', { base_address: '1' }, 'flash2')], hexRes.diagram.connections), 'flash2', 'base_address', gen);
    eq(clash.ok ? clash.key : '', 'base_address_2', 'promote: a taken key becomes key_2');

    // file pseudo-field
    const fileRes = promoteParam(d0, 'flash', 'file', gen);
    ok(fileRes.ok, 'promote: the firmware file pseudo-field');
    if (fileRes.ok) {
      const fb = fileRes.diagram.blocks.find((b) => b.id === fileRes.flowInId) as FlowBlock;
      eq([fb.config['type'], fb.config['accept'], fb.config['required']], ['file', ['.hex', '.s19', '.srec', '.bin'], true], 'promote: file input, accept copied, required');
      eq(getBlockDefFor(fileRes.diagram.blocks.find((b) => b.id === 'flash') as FlowBlock)?.ports.find((p) => p.id === 'p:file')?.type, 'bytes', 'promote: p:file is a bytes port');
    }

    // bind alone adds the port; unbind removes port + connection
    const bound = bindParam(d0, 'ses', 'session_type');
    eq(getBlockDefFor(bound.blocks.find((b) => b.id === 'ses') as FlowBlock)?.ports.some((p) => p.id === 'p:session_type'), true, 'bind: adds the p: port');
    eq(bindParam(bound, 'ses', 'session_type'), bound, 'bind: idempotent');
    eq(bindParam(d0, 'ses', 'no_such_field'), d0, 'bind: unknown field is a no-op');
    eq(unbindParam(hexRes.diagram, 'flash', 'base_address').connections.length, 0, 'unbind: the connection goes away');
    eq(unbindParam(hexRes.diagram, 'flash', 'base_address').blocks.find((b) => b.id === 'flash')?.config['boundParams'], undefined, 'unbind: boundParams removed');
    // promote on a bound-but-unwired port wires it without double-binding
    const onBound = promoteParam(bound, 'ses', 'session_type', gen);
    eq(onBound.ok ? onBound.diagram.blocks.find((b) => b.id === 'ses')?.config['boundParams'] : null, ['session_type'], 'promote: a bound but unwired port is wired, not bound twice');

    // store: ONE undo step per action
    flowStore.loadDocument(d0);
    const before = flowStore.getSnapshot().undoStack.length;
    const sres = flowStore.promoteParam('flash', 'base_address');
    ok(sres.ok, 'store promote ok');
    eq(flowStore.getSnapshot().undoStack.length, before + 1, 'promote is exactly one undo step');
    eq([snap().blocks.length, snap().connections.length], [4, 1], 'store promote: one flow_in + one connection');
    flowStore.undo();
    eq([snap().blocks.length, snap().connections.length, snap().blocks.find((b) => b.id === 'flash')?.config['boundParams']], [3, 0, undefined], 'undo reverts the whole promote');
    flowStore.bindParam('ses', 'session_type');
    flowStore.unbindParam('ses', 'session_type');
    eq(snap().blocks.find((b) => b.id === 'ses')?.config['boundParams'], undefined, 'store bind + unbind');
    // changing a bound port's field type drops incompatible connections
    flowStore.loadDocument(dia([blk('flow_start', 'S'), blk('flow_in', 'x', { ...spec('x', 'text') }, 'x'), blk('uds_session', 'Ses', { session_type: 'extended' }, 'ses2')], []));
    ok(flowStore.addConnection({ fromBlockId: 'x', fromPortId: 'value', toBlockId: 'ses2', toPortId: 'exec_in' }) === false, 'data -> exec connection is refused');
    flowStore.bindParam('ses2', 'session_type');
    ok(flowStore.addConnection({ fromBlockId: 'x', fromPortId: 'value', toBlockId: 'ses2', toPortId: 'p:session_type' }), 'a flow_in connects to a bound port');
    flowStore.unbindParam('ses2', 'session_type');
    eq(snap().connections.length, 0, 'unbinding via the store drops the connection');
  }

  // ── 7. Required outputs: real enforces on ok only, simulated is lenient ──────
  {
    for (const outcome of ['ok', 'fail'] as const) {
      const st = blk('flow_start', 'S');
      const ret = blk('flow_return', 'R', { name: outcome, outcome });
      const out = fout(spec('r', 'number', { required: true }));
      const d = dia([st, ret, out], [wire(st, 'start', ret, 'in')]);
      const real = await run('real', d);
      if (outcome === 'ok') {
        eq(real.eng.result?.outcome, 'error', 'required output missing on ok: real engine error');
        ok(real.errors.some((m) => m.includes('"r"')), 'required output missing on ok: the error names the output');
        eq(snap().blocks.find((b) => b.id === out.id)?.status, 'error', 'required output missing on ok: the flow_out is marked');
      } else {
        eq([real.eng.result?.outcome, real.eng.result?.name, real.errors], ['fail', 'fail', []], 'required output missing on fail: no error');
      }
      const sim = await run('sim', d);
      eq(sim.eng.result?.outcome, outcome, `required output missing (${outcome}): the simulated engine stays lenient`);
    }
    // an unhandled error ends with outcome error and no sampled outputs
    const st = blk('flow_start', 'S');
    const dv = blk('math', 'Div', { op: 'div', b: 0 });
    const cc = blk('data_const', 'C', { value: '1', format: 'dec' });
    const lg = blk('log', 'L', { message: 'x' });
    const o = fout(spec('r', 'number'));
    const r = await run('real', dia([st, dv, cc, lg, o], [wire(st, 'start', lg, 'exec_in'), wire(cc, 'value_out', dv, 'a_in'), wire(dv, 'result', lg, 'value_in'), wire(cc, 'value_out', o, 'value')]));
    eq([r.eng.result?.outcome, r.eng.result?.outputs], ['error', {}], 'unhandled error: outcome error, no outputs');
  }

  // ── 8. Make Custom Block emits v2 blocks ─────────────────────────────────────
  {
    const rs = blk('flow_start', 'S');
    const l0 = logb('before');
    const s1 = logb('inside');
    const l3 = logb('after');
    const c = blk('data_const', 'C', { value: '7', format: 'dec' });
    const m = blk('math', 'Inc', { op: 'add', b: 3 });
    const rin = fin(spec('rin', 'number'));
    const parent = dia([rs, l0, s1, l3, c, m, rin], [
      wire(rs, 'start', l0, 'exec_in'), wire(l0, 'exec_out', s1, 'exec_in'), wire(s1, 'exec_out', l3, 'exec_in'),
      wire(c, 'value_out', m, 'a_in'), wire(m, 'result', l3, 'value_in'), wire(rin, 'value', m, 'b_in'),
    ]);
    let k = 0;
    const res = buildExtraction(parent, [s1.id, m.id], 'X', 'cid', (p) => `${p}_${++k}`);
    ok(res.ok, 'extract: succeeds');
    if (res.ok) {
      const types = res.callee.blocks.map((b) => b.type);
      eq([types.filter((x) => x === 'flow_start').length, types.filter((x) => x === 'flow_in').length, types.filter((x) => x === 'flow_return').length, types.filter((x) => x === 'flow_out').length], [1, 2, 1, 1], 'extract: flow_start + one flow_in per input + flow_return + one flow_out per output');
      ok(!types.some((x) => x === 'flow_input' || x === 'flow_output' || x === 'start' || x === 'end'), 'extract: no v1 interface blocks');
      const iface = deriveFlowInterface(res.callee);
      eq([iface.inputs.map((i) => i.key), iface.outcomes.map((o) => o.name), iface.outputs.map((o) => o.key)], [['value_out', 'rin'], ['ok'], ['result']], 'extract: derived interface');
      eq(validateInterface(res.callee), [], 'extract: the callee validates');
      const parentOut = res.apply(1);
      const call = parentOut.blocks.find((b) => b.type.startsWith('call:')) as FlowBlock;
      ok(parentOut.connections.some((x) => x.fromBlockId === rin.id && x.fromPortId === 'value' && x.toBlockId === call.id), 'extract: the parent flow_in feeds the call block');
    }
  }

  // ── 9. Templates: contract interface + headless run ──────────────────────────
  {
    /** Spec without its label, keys sorted (the comparison is by value, not by key order). */
    const specOnly = (s: FlowPortSpecV1): Record<string, unknown> =>
      Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'label').sort(([a], [b]) => (a < b ? -1 : 1)));
    const expectedInputs: Array<Record<string, unknown>> = [
      { key: 'ecu', type: 'ecu', required: true, order: 0 },
      { key: 'firmware', type: 'file', required: true, order: 1, accept: ['.hex', '.s19', '.srec', '.bin'] },
      { key: 'baseAddr', type: 'hex', required: false, order: 2, byteLength: 4, default: '00000000' },
      { key: 'secLevel', type: 'select', required: false, order: 3, options: ['01', '03', '11'], default: '11' },
    ];
    for (const id of ['ecu_flasher', 'ecu_flasher_minimal'] as const) {
      const tpl = FLOW_TEMPLATES.find((x) => x.id === id);
      if (!tpl) throw new Error(`${id} missing`);
      flowStore.loadTemplate(tpl);
      const d = snap();
      const iface = deriveFlowInterface(d);
      eq(iface.inputs.map(specOnly), expectedInputs.map((e) => Object.fromEntries(Object.entries(e).sort(([a], [b]) => (a < b ? -1 : 1)))), `${id}: inputs = contract §6`);
      eq(iface.outcomes.map((o) => [o.name, o.outcome]), id === 'ecu_flasher'
        ? [['ok', 'ok'], ['safe_abort', 'fail'], ['bootloader_fail', 'fail'], ['post_warning', 'fail'], ['error', 'error']]
        : [['ok', 'ok'], ['safe_abort', 'fail'], ['bootloader_fail', 'fail']], `${id}: outcomes = contract §6`);
      eq(iface.outputs.map((o) => [o.key, o.type]), [['crc32', 'number'], ['report', 'text']], `${id}: outputs = contract §6`);
      eq(validateInterface(d), [], `${id}: the interface validates`);
      eq(interfaceSummary(d), `in(ecu, firmware, baseAddr, secLevel) → ${iface.outcomes.map((o) => o.name).join(' · ')} | out(crc32, report)`, `${id}: summary line`);
      const feeder = (blockType: string, port: string): string | undefined => {
        const b = d.blocks.find((x) => x.type === blockType) as FlowBlock;
        const c = d.connections.find((x) => x.toBlockId === b.id && x.toPortId === port);
        const src = d.blocks.find((x) => x.id === c?.fromBlockId);
        return src?.type === 'flow_in' ? String(src.config['key']) : undefined;
      };
      eq([feeder('uds_flash_image', 'p:file'), feeder('uds_flash_image', 'p:base_address'), feeder('uds_security_access', 'p:access_level')], ['firmware', 'baseAddr', 'secLevel'], `${id}: bound params wired to the contract inputs`);
      eq([d.blocks.find((b) => b.type === 'uds_flash_image')?.config['boundParams'], d.blocks.find((b) => b.type === 'uds_security_access')?.config['boundParams']], [['file', 'base_address'], ['access_level']], `${id}: boundParams`);
      eq(d.connections.filter((c) => c.fromPortId === 'crc32' || c.fromPortId === 'report').filter((c) => d.blocks.find((b) => b.id === c.toBlockId)?.type === 'flow_out').length, 2, `${id}: crc32 + report feed the flow_out blocks`);
      ok(!d.blocks.some((b) => ['start', 'end', 'flow_input', 'flow_output'].includes(b.type)), `${id}: no v1 interface blocks`);
      // the derived call block of the template is a real Flow = Block port set
      const ports = callPorts(iface).ports.map((p) => p.id);
      ok(['ecu', 'firmware', 'baseAddr', 'secLevel', 'ok', 'safe_abort', 'bootloader_fail', 'error', 'crc32', 'report'].every((p) => ports.includes(p)), `${id}: as a block it exposes every input, outcome and output`);
    }
    // all other templates: flow_start / flow_return in source, no runtime migration needed
    for (const tpl of FLOW_TEMPLATES.filter((x) => x.id !== 'ecu_flasher' && x.id !== 'ecu_flasher_minimal')) {
      const types = tpl.diagram.blocks.map((b) => b.type);
      ok(types.includes('flow_start') && !types.includes('start') && !types.includes('end'), `template ${tpl.id}: flow_start in source, no legacy start / end`);
      eq(migrateInterfaceV2({ id: 'x', name: 'x', ...tpl.diagram }).diagram.blocks.length, tpl.diagram.blocks.length, `template ${tpl.id}: nothing left to migrate`);
    }

    // headless run in the SIMULATED engine with a FlowFileValue firmware input (deterministic: no random NRCs)
    const realRandom = Math.random;
    Math.random = (): number => 0.5;
    try {
      for (const id of ['ecu_flasher', 'ecu_flasher_minimal'] as const) {
        const tpl = FLOW_TEMPLATES.find((x) => x.id === id) as (typeof FLOW_TEMPLATES)[number];
        flowStore.loadTemplate(tpl);
        const fw: FlowFileValue = { name: 'app.hex', bytes: Uint8Array.from([0x3a, 1, 2, 3, 4]) };
        const eng = new FlowEngine();
        await eng.run({ transport: simTransport, ecu: newEcuRecord({ name: 'Engine1' }), inputs: { firmware: fw } });
        const res = eng.result;
        eq([res?.refused, res?.stopped], [false, false], `${id}: the simulated run is accepted`);
        eq([res?.outcome, res?.name], ['ok', 'ok'], `${id}: simulated run ends with the ok outcome`);
        ok(res?.outputs['crc32'] !== undefined && res?.outputs['report'] !== undefined, `${id}: crc32 + report outputs sampled from the flash block`);
        const flash = snap().blocks.find((b) => b.type === 'uds_flash_image') as FlowBlock;
        eq(flash.status, 'success', `${id}: the flash block ran with the bound firmware`);
        // the same run without the firmware is refused before anything runs
        const eng2 = new FlowEngine();
        await eng2.run({ transport: simTransport, ecu: newEcuRecord({ name: 'Engine1' }), inputs: {} });
        eq(eng2.result?.refused, true, `${id}: no firmware = refused`);
      }
    } finally {
      Math.random = realRandom;
    }
  }

  // ── 10. File values ──────────────────────────────────────────────────────────
  {
    const fv: FlowFileValue = { name: 'a.bin', bytes: Uint8Array.from([1, 2, 3]) };
    eq(Array.from(asBytes(fv) ?? []), [1, 2, 3], 'asBytes(FlowFileValue) returns its bytes (existing bytes consumers keep working)');
    const r = resolveRunInputs([spec('img', 'file', { required: true, accept: ['.bin'] })], { img: fv });
    eq([r.errors, (r.values['img'] as FlowFileValue).name], [[], 'a.bin'], 'file input resolves to the FlowFileValue');
    eq(resolveRunInputs([spec('img', 'file', { required: true })], {}).errors.length, 1, 'required file input missing');
  }

  console.log(`flowInterfaceV2.test: ${passed} checks passed`);
}

await main();
