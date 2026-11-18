/**
 * Headless tests of nested flows (Phase B2): call blocks with inputs / outcomes / outputs on BOTH engines,
 * per-frame variable isolation, hierarchical log paths, error propagation, runtime limits, static call-graph
 * validation (cycles with path, unresolved refs, ports), update-to-latest, "Make Custom Block" extraction
 * equivalence, ECU binding ({ecu.*} per frame, protocol and session refusal), Stop propagation and keep-alive
 * cleanup on frame exit.
 * Run: `npm run test:flownest` (esbuild bundle -> node; throws on the first failure).
 */
import { FlowEngine, type FlowRunOptions } from '../FlowEngine';
import { flowStore } from '../FlowStore';
import { callIndex, callType } from '../callIndex';
import { applyMarquee, blockSize, clickSelect, marqueeHits, rectFromPoints, rectsIntersect, screenToCanvas } from '../canvasSelect';
import { callPorts } from '../callPorts';
import { buildExtraction } from '../extractBlock';
import { deriveFlowInterface } from '../flowInterface';
import { checkEcuSession } from '../ecuBinding';
import type { FlowRequestOptions, FlowTransport } from '../flowTransport';
import type { FlowBlock, FlowConnection, FlowDiagram } from '../types';
import { stopAllTxSources } from '../../../store/txSources';
import { t } from '../../../i18n';
import type { FlowLibKind, FlowPortSpecV1 } from '../../../types/flowLibrary';
import { newEcuRecord } from '../../diagnostics/workspace/ecuDefaults';
import { buildFlowFile, toFlowBody } from './flowBody';
import { FakeLib } from './fakeLib';
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
  return { id: `n${++seq}`, type, label, x: seq * 10, y: seq * 5, config, status: 'idle', collapsed: false };
}
function wire(from: FlowBlock, fromPort: string, to: FlowBlock, toPort: string): FlowConnection {
  return { id: `w${++seq}`, fromBlockId: from.id, fromPortId: fromPort, toBlockId: to.id, toPortId: toPort };
}
function dia(blocks: FlowBlock[], connections: FlowConnection[], variables: FlowDiagram['variables'] = []): FlowDiagram {
  return { id: 'd', name: 'd', blocks, connections, variables };
}
const spec = (key: string, type: FlowPortSpecV1['type'], extra: Partial<FlowPortSpecV1> = {}): FlowPortSpecV1 => ({ key, label: key, type, required: false, ...extra });
const fin = (inputs: FlowPortSpecV1[] = []): FlowBlock => blk('flow_input', 'In', { inputs });
const fout = (name: string, outcome: 'ok' | 'fail' | 'error', outputs: FlowPortSpecV1[] = []): FlowBlock => blk('flow_output', name, { name, outcome, outputs });
const logb = (message: string): FlowBlock => blk('log', `Log ${message}`, { message });
const call = (flowId: string, revision: number, label = flowId): FlowBlock => blk(callType(flowId), label, { ref: { flowId, revision } });

function load(d: FlowDiagram): void {
  flowStore.loadTemplate({
    id: 'x', nameKey: 'flowCore.tpl.counter.name', descriptionKey: 'flowCore.tpl.counter.desc', category: 'examples', icon: '',
    diagram: { blocks: d.blocks, connections: d.connections, ...(d.variables ? { variables: d.variables } : {}) },
  });
}

// ─── Transports ────────────────────────────────────────────────────────────────

const simTransport = { demo: true } as unknown as FlowTransport;
class StubTransport implements FlowTransport {
  readonly demo = false;
  readonly tabId = 'tab-test';
  sent: string[] = [];
  keepalive: string[] = [];
  functionalId(): number | null {
    return null;
  }
  async setKeepalive(on: boolean): Promise<void> {
    this.keepalive.push(on ? 'on' : 'off');
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
  tr: StubTransport;
  lines: string[];
  errors: string[];
  log: Array<{ message: string; path: string[] }>;
}

let uuidN = 0;
function fresh(): { lib: FakeLib; reg: FlowRegistryStore; add: (id: string, name: string, d: FlowDiagram, kind?: FlowLibKind, rev?: number) => Promise<void>; run: (mode: Mode, d: FlowDiagram, opts?: FlowRunOptions) => Promise<Run> } {
  callIndex.clear();
  const lib = new FakeLib();
  const reg = new FlowRegistryStore(lib, null, { uuid: () => `u${++uuidN}`, now: () => new Date('2026-11-19T10:00:00.000Z') });
  const add = async (id: string, name: string, d: FlowDiagram, kind: FlowLibKind = 'nexuscan.block', rev = 1): Promise<void> => {
    const body = toFlowBody({ ...d, id, name }, {
      id, revision: rev, description: '', createdAt: '2026-11-19T10:00:00.000Z', updatedAt: '2026-11-19T10:00:00.000Z', author: null, origin: 'user', aiReviewed: true, tags: [],
    });
    await lib.save(JSON.stringify(await buildFlowFile(kind, body)));
  };
  const run = async (mode: Mode, d: FlowDiagram, opts: FlowRunOptions = {}): Promise<Run> => {
    load(d);
    const tr = new StubTransport();
    const eng = new FlowEngine();
    await eng.run({
      transport: mode === 'sim' ? simTransport : tr, rootId: 'root', rootName: 'Root',
      resolveCallee: (id, rev) => reg.loadBody(id, rev), ...opts,
    });
    const snap = flowStore.getSnapshot();
    ok(!snap.isRunning, `run state reset [${mode}]`);
    const lines: string[] = [];
    for (const e of snap.runLog) {
      const m = /^\[[\d:.]+\]\s{3}LOG: (.*)$/.exec(e.message);
      if (m) lines.push(m[1]);
    }
    return { eng, tr, lines, errors: snap.runLog.filter((e) => e.level === 'error').map((e) => e.message), log: snap.runLog.map((e) => ({ message: e.message, path: e.path })) };
  };
  return { lib, reg, add, run };
}

const MODES = ['sim', 'real'] as const;

async function main(): Promise<void> {
  // ── 1. Interface: implicit ok, call ports ────────────────────────────────────
  {
    eq(deriveFlowInterface(dia([blk('start', 'S')], [])).outcomes, [{ name: 'ok', outcome: 'ok', outputs: [] }], 'a flow without flow_output derives the implicit ok outcome');
    eq(deriveFlowInterface(dia([fin(), fout('x', 'fail')], [])).outcomes.map((o) => o.name), ['x'], 'explicit outcomes replace the implicit one');
    const iface = deriveFlowInterface(dia([fin([spec('ecu', 'ecu'), spec('n', 'number', { required: true })]), fout('done', 'ok', [spec('r', 'number')]), fout('bad', 'fail', [spec('r', 'number'), spec('blob', 'bytes')])], []));
    const { ports, conflicts } = callPorts(iface);
    eq(ports.map((p) => `${p.direction}:${p.id}:${p.type}`), ['input:in:exec', 'input:ecu:ecu', 'input:n:data', 'output:done:exec', 'output:bad:exec', 'output:error:exec', 'output:r:data', 'output:blob:bytes'], 'call ports: exec in + inputs, exec per outcome + error, data outputs (union)');
    eq(ports.find((p) => p.id === 'n')?.optional, false, 'required callee input is not optional');
    eq(conflicts, [], 'no conflicts');
    const clash = callPorts(deriveFlowInterface(dia([fin(), fout('a', 'ok', [spec('r', 'number')]), fout('b', 'ok', [spec('r', 'bytes')])], [])));
    eq(clash.conflicts.length, 1, 'same output key with different types is a conflict');
    const shared = callPorts(deriveFlowInterface(dia([fin(), fout('error', 'error')], [])));
    eq(shared.ports.filter((p) => p.id === 'error').length, 1, 'an outcome named error shares the error port');
  }

  // ── 2. Call with inputs / outcomes / outputs on both engines ────────────────
  for (const mode of MODES) {
    const f = fresh();
    const fi = fin([spec('n', 'number', { required: true })]);
    const m = blk('math', 'Inc', { op: 'add', b: 1 });
    const fo = fout('done', 'ok', [spec('r', 'number')]);
    await f.add('X', 'Plus One', dia([fi, m, fo], [wire(fi, 'start', fo, 'in'), wire(fi, 'n', m, 'a_in'), wire(m, 'result', fo, 'r')]));
    const bad = fout('bad', 'fail');
    const fi2 = fin();
    await f.add('Y', 'Fails', dia([fi2, bad], [wire(fi2, 'start', bad, 'in')]));

    const rfi = fin();
    const c = blk('data_const', 'C', { value: '41', format: 'dec' });
    const cl = call('X', 1, 'Plus');
    const ok1 = logb('done');
    const er = logb('err');
    let r = await f.run(mode, dia([rfi, c, cl, ok1, er], [wire(rfi, 'start', cl, 'in'), wire(c, 'value_out', cl, 'n'), wire(cl, 'done', ok1, 'exec_in'), wire(cl, 'r', ok1, 'value_in'), wire(cl, 'error', er, 'exec_in')]));
    eq(r.errors, [], `call: no errors [${mode}]`);
    eq(r.lines, ['done 42'], `call: input mapped in, outcome port taken, output mapped back [${mode}]`);
    eq(r.eng.result?.outcome, 'ok', `call: parent outcome ok [${mode}]`);
    eq(flowStore.getSnapshot().diagram.blocks.find((b) => b.id === cl.id)?.status, 'success', `call block status [${mode}]`);
    ok(r.log.some((e) => e.message.includes('Plus One') && e.message.includes('r1')), `call: enter log names callee + revision [${mode}]`);

    // outcome routing: a failing callee leaves through its named outcome port
    const rfi2 = fin();
    const cl2 = call('Y', 1, 'Fails');
    const took = logb('took bad');
    const okp = logb('took ok');
    r = await f.run(mode, dia([rfi2, cl2, took, okp], [wire(rfi2, 'start', cl2, 'in'), wire(cl2, 'bad', took, 'exec_in'), wire(cl2, 'error', okp, 'exec_in')]));
    eq(r.lines, ['took bad'], `call: outcome name selects the exec output [${mode}]`);

    // a missing required callee input (unwired) fails the call -> error port
    const rfi3 = fin();
    const cl3 = call('X', 1, 'NoInput');
    const caught = logb('caught');
    r = await f.run(mode, dia([rfi3, cl3, caught], [wire(rfi3, 'start', cl3, 'in'), wire(cl3, 'error', caught, 'exec_in')]));
    eq(r.lines, ['caught'], `call: missing required input -> error port [${mode}]`);
  }

  // ── 3. Three nested levels: per-frame variables + hierarchical log paths ────
  for (const mode of MODES) {
    const f = fresh();
    const mk = (initial: string, add: number, label: string, callee: string | null): FlowDiagram => {
      const fi = fin();
      const vs = blk('var_set', 'Add', { name: 'x', mode: 'add', amount: add });
      const lg = logb(`${label} x={x}`);
      const decl = [{ name: 'x', type: 'number' as const, initial }];
      if (callee === null) return dia([fi, vs, lg], [wire(fi, 'start', vs, 'exec_in'), wire(vs, 'exec_out', lg, 'exec_in')], decl);
      const cl = call(callee, 1, callee);
      return dia([fi, vs, cl, lg], [wire(fi, 'start', vs, 'exec_in'), wire(vs, 'exec_out', cl, 'in'), wire(cl, 'ok', lg, 'exec_in')], decl);
    };
    await f.add('L2', 'Level Two', mk('100', 50, 'l2', null));
    await f.add('L1', 'Level One', mk('10', 5, 'l1', 'L2'));
    const root = mk('1', 1, 'root', 'L1');
    const r = await f.run(mode, root);
    eq(r.errors, [], `nested: no errors [${mode}]`);
    eq(r.lines, ['l2 x=150', 'l1 x=15', 'root x=2'], `nested: every frame has its own variable scope [${mode}]`);
    const lineEntries = r.log.filter((e) => /LOG: l\d x|LOG: root x/.test(e.message));
    eq(lineEntries.map((e) => e.path), [['Root', 'Level One', 'Level Two'], ['Root', 'Level One'], ['Root']], `nested: hierarchical log paths [${mode}]`);
    const fs = flowStore.getSnapshot().frameStatus;
    const rootCall = root.blocks.find((b) => b.type === callType('L1')) as FlowBlock;
    ok(Object.keys(fs).includes('') && Object.keys(fs).includes(rootCall.id) && Object.keys(fs).some((k) => k.startsWith(`${rootCall.id}/`)), `nested: live statuses are kept per frame path [${mode}]`);
    // viewing the callee frame overlays its statuses on its diagram
    const l1 = parseDia(f.lib, 'L1');
    flowStore.loadDocument(await l1, { viewPath: rootCall.id, readOnly: true, keepLog: true });
    ok(flowStore.getSnapshot().diagram.blocks.filter((b) => b.status === 'success').length >= 3, `nested: entering a frame shows its block statuses [${mode}]`);
    flowStore.loadDocument(dia([], []));
  }

  // ── 4. Error propagation ─────────────────────────────────────────────────────
  for (const mode of MODES) {
    const f = fresh();
    const fi = fin();
    const c = blk('data_const', 'C', { value: '1', format: 'dec' });
    const dv = blk('math', 'Div', { op: 'div', b: 0 });
    const lg = blk('log', 'L', { message: 'x' });
    await f.add('Z', 'Boom', dia([fi, c, dv, lg], [wire(fi, 'start', lg, 'exec_in'), wire(c, 'value_out', dv, 'a_in'), wire(dv, 'result', lg, 'value_in')]));
    const rfi = fin();
    const cl = call('Z', 1, 'Boom');
    const caught = logb('caught');
    let r = await f.run(mode, dia([rfi, cl, caught], [wire(rfi, 'start', cl, 'in'), wire(cl, 'error', caught, 'exec_in')]));
    eq(r.lines, ['caught'], `error: unhandled callee error reaches the call block's error port [${mode}]`);
    eq(r.eng.result?.outcome, 'ok', `error: handled by the parent -> ok [${mode}]`);
    ok(r.errors.some((m) => m.includes('Boom') || m.includes('Div')), `error: the callee error is logged [${mode}]`);
    const rfi2 = fin();
    const cl2 = call('Z', 1, 'Boom');
    const after = logb('never');
    r = await f.run(mode, dia([rfi2, cl2, after], [wire(rfi2, 'start', cl2, 'in'), wire(cl2, 'ok', after, 'exec_in')]));
    eq(r.eng.result?.outcome, 'error', `error: unwired error port -> parent frame error [${mode}]`);
    eq(r.lines, [], `error: nothing runs after the failed call [${mode}]`);
  }

  // ── 5. Runtime limits ────────────────────────────────────────────────────────
  {
    const f = fresh();
    const N = 70;
    for (let i = N - 1; i >= 0; i--) {
      const fi = fin();
      if (i === N - 1) await f.add(`D${i}`, `Chain ${i}`, dia([fi, logb('leaf')], []));
      else {
        const cl = call(`D${i + 1}`, 1, `D${i + 1}`);
        await f.add(`D${i}`, `Chain ${i}`, dia([fi, cl], [wire(fi, 'start', cl, 'in')]));
      }
    }
    const rfi = fin();
    const cl = call('D0', 1, 'D0');
    const root = dia([rfi, cl], [wire(rfi, 'start', cl, 'in')]);
    const r = await f.run('sim', root);
    eq(r.eng.result?.outcome, 'error', 'depth: a 70-deep chain ends with outcome error (limit 64)');
    ok(r.errors.some((m) => m.includes('64')), 'depth: the error names the limit');
    // a chain within the limit runs
    const f2 = fresh();
    const leafFi = fin();
    await f2.add('E2', 'Leaf', dia([leafFi, logb('leaf')], []));
    const e1fi = fin();
    const e1c = call('E2', 1);
    await f2.add('E1', 'Mid', dia([e1fi, e1c], [wire(e1fi, 'start', e1c, 'in')]));
    const e0fi = fin();
    const e0c = call('E1', 1);
    const small = dia([e0fi, e0c], [wire(e0fi, 'start', e0c, 'in')]);
    eq((await f2.run('sim', small, { limits: { maxDepth: 2 } })).eng.result?.outcome, 'ok', 'depth: 2 nested calls pass with maxDepth 2');
    const tooDeep = await f2.run('sim', small, { limits: { maxDepth: 1 } });
    eq(tooDeep.eng.result?.outcome, 'error', 'depth: 2 nested calls fail with maxDepth 1');
    // executed block limit
    const bfi = fin();
    const fr = blk('flow_for', 'For', { from: 1, to: 100, step: 1 });
    const bl = logb('i');
    const lim = await f2.run('sim', dia([bfi, fr, bl], [wire(bfi, 'start', fr, 'exec_in'), wire(fr, 'body_out', bl, 'exec_in')]), { limits: { maxBlocks: 30 } });
    eq(lim.eng.result?.outcome, 'error', 'blocks: exceeding the executed block limit ends with outcome error');
    ok(lim.errors.some((m) => m.includes('30')), 'blocks: the error names the limit');
    ok(lim.lines.length < 40, 'blocks: the run stopped promptly');
  }

  // ── 6. Static validation: cycles, unresolved refs, ports ────────────────────
  for (const mode of MODES) {
    const f = fresh();
    const afi = fin();
    await f.add('A', 'Alpha', dia([afi, logb('a')], []), 'nexuscan.flow', 1);
    const bfi = fin();
    const bcl = call('A', 1, 'A');
    await f.add('B', 'Beta', dia([bfi, bcl], [wire(bfi, 'start', bcl, 'in')]));
    // A r2 calls B@1 which calls A@1: A -> B -> A
    const rfi = fin();
    const rc = call('B', 1, 'B');
    let r = await f.run(mode, dia([rfi, rc], [wire(rfi, 'start', rc, 'in')]), { rootId: 'A', rootName: 'Alpha' });
    eq(r.eng.result?.refused, true, `cycle: refused [${mode}]`);
    ok(r.errors.some((m) => m.includes('Alpha › Beta › Alpha')), `cycle: the message carries the full path [${mode}]`);
    eq(r.tr.sent, [], `cycle: nothing transmitted [${mode}]`);
    // self reference
    const sfi = fin();
    const sc = call('A', 1, 'A');
    r = await f.run(mode, dia([sfi, sc], [wire(sfi, 'start', sc, 'in')]), { rootId: 'A', rootName: 'Alpha' });
    ok(r.eng.result?.refused === true && r.errors.some((m) => m.includes('Alpha › Alpha')), `cycle: self reference refused [${mode}]`);

    // unresolved id and revision
    const ufi = fin();
    const uc = call('nope', 1, 'Gone');
    r = await f.run(mode, dia([ufi, uc], [wire(ufi, 'start', uc, 'in')]));
    eq(r.eng.result?.refused, true, `unresolved: missing id refused [${mode}]`);
    eq(flowStore.getSnapshot().diagram.blocks.find((b) => b.id === uc.id)?.status, 'error', `unresolved: the call block is marked [${mode}]`);
    const vfi = fin();
    const vc = call('A', 9, 'BadRev');
    r = await f.run(mode, dia([vfi, vc], [wire(vfi, 'start', vc, 'in')]));
    eq(r.eng.result?.refused, true, `unresolved: missing revision refused [${mode}]`);
    ok(r.errors.some((m) => m.includes('r9')), `unresolved: the message names the revision [${mode}]`);

    // a parent connection to a port the pinned callee does not have
    const pfi = fin();
    const pc = call('A', 1, 'A');
    const pl = logb('p');
    r = await f.run(mode, dia([pfi, pc, pl], [wire(pfi, 'start', pc, 'in'), wire(pc, 'zzz', pl, 'exec_in')]));
    eq(r.eng.result?.refused, true, `ports: connection to a missing port refused [${mode}]`);
    ok(r.errors.some((m) => m.includes('zzz')), `ports: the message names the port [${mode}]`);
    // conflicting callee interface
    const cfi = fin();
    await f.add('K', 'Conflict', dia([cfi, fout('a', 'ok', [spec('r', 'number')]), fout('b', 'ok', [spec('r', 'bytes')])], []));
    const kfi = fin();
    const kc = call('K', 1, 'K');
    r = await f.run(mode, dia([kfi, kc], [wire(kfi, 'start', kc, 'in')]));
    eq(r.eng.result?.refused, true, `interface: conflicting callee outputs refused [${mode}]`);
  }

  // ── 7. Registry: insert (cycle check), where used, update to latest, enter ──
  {
    const f = fresh();
    const { reg, lib } = f;
    // X r1: input n, output r. Parent wires both.
    const xfi = fin([spec('n', 'number')]);
    const xo = fout('ok', 'ok', [spec('r', 'number')]);
    await f.add('X', 'Lib X', dia([xfi, xo], [wire(xfi, 'start', xo, 'in'), wire(xfi, 'n', xo, 'r')]));
    await reg.refresh();
    const root = reg.newDocument('nexuscan.flow');
    reg.getDoc(root);
    ok(await reg.insertCall('X'), 'insert: a library item can be added as a call block');
    const placed = flowStore.getSnapshot().diagram.blocks.find((b) => b.type === callType('X')) as FlowBlock;
    eq((placed.config['ref'] as { revision: number }).revision, 1, 'insert: pinned to the latest revision');
    eq(placed.label, 'Lib X', 'insert: labelled with the callee name');
    eq(flowStore.getSnapshot().diagram.blocks.some((b) => b.type === callType(root)), false, 'insert: nothing else was added');
    // self insertion is refused: save the root first so it exists in the library
    flowStore.setDiagramName('Root doc');
    ok((await reg.save(root)).ok, 'root saved');
    ok(!(await reg.insertCall(root)), 'insert: a flow cannot call itself');
    ok((reg.getSnapshot().notice ?? '').length > 0, 'insert: the refusal is explained');
    reg.clearNotice();
    // library-level cycle: X (new rev) calls root, then root cannot call X any more
    const x2fi = fin();
    const x2c = call(root, 1, 'Root doc');
    await f.add('X', 'Lib X', dia([x2fi, x2c], [wire(x2fi, 'start', x2c, 'in')]), 'nexuscan.block', 2);
    await reg.refresh();
    const before = flowStore.getSnapshot().diagram.blocks.length;
    ok(!(await reg.insertCall('X')), 'insert: indirect recursion (X -> root) refused');
    eq(flowStore.getSnapshot().diagram.blocks.length, before, 'insert: refused insertion adds nothing');
    reg.clearNotice();

    // where used
    await reg.whereUsed(root);
    eq(reg.getSnapshot().usages?.list.map((u) => [u.id, u.revisions]), [['X', [1]]], 'where used: lists the flows that call the item (latest revisions)');

    // update to latest: X r2 has no input n and no output r -> the wired ports are dropped, one undo step
    const f2 = fresh();
    const { reg: reg2 } = f2;
    const yfi = fin([spec('n', 'number')]);
    const yo = fout('ok', 'ok', [spec('r', 'number')]);
    await f2.add('Y', 'Lib Y', dia([yfi, yo], [wire(yfi, 'start', yo, 'in'), wire(yfi, 'n', yo, 'r')]));
    const pfi = fin();
    const pc = call('Y', 1, 'Lib Y');
    const cst = blk('data_const', 'C', { value: '1', format: 'dec' });
    const pl = logb('after');
    load(dia([pfi, pc, cst, pl], [wire(pfi, 'start', pc, 'in'), wire(cst, 'value_out', pc, 'n'), wire(pc, 'ok', pl, 'exec_in'), wire(pc, 'r', pl, 'value_in')]));
    await reg2.primeCallees(flowStore.getSnapshot().diagram);
    eq(flowStore.getSnapshot().diagram.connections.length, 4, 'repin: parent starts with 4 connections');
    ok(!(await reg2.repin(pc.id)), 'repin: nothing to do while pinned == latest');
    const y2fi = fin();
    const y2o = fout('ok', 'ok');
    await f2.add('Y', 'Lib Y', dia([y2fi, y2o], [wire(y2fi, 'start', y2o, 'in')]), 'nexuscan.block', 2);
    await reg2.refresh();
    eq(callIndex.latestOf('Y'), 2, 'repin: the latest revision is known');
    const undoBefore = flowStore.getSnapshot().undoStack.length;
    ok(await reg2.repin(pc.id), 'repin: updates to the latest revision');
    eq((flowStore.getSnapshot().diagram.blocks.find((b) => b.id === pc.id)?.config['ref'] as { revision: number }).revision, 2, 'repin: re-pinned to r2');
    eq(flowStore.getSnapshot().diagram.connections.map((c) => c.toPortId).sort(), ['exec_in', 'in'], 'repin: the connections to removed ports were dropped');
    eq(reg2.getSnapshot().repinReport?.dropped.length, 2, 'repin: the dropped connections are listed');
    eq(flowStore.getSnapshot().undoStack.length, undoBefore + 1, 'repin: exactly one undo step');
    flowStore.undo();
    eq([flowStore.getSnapshot().diagram.connections.length, (flowStore.getSnapshot().diagram.blocks.find((b) => b.id === pc.id)?.config['ref'] as { revision: number }).revision], [4, 1], 'repin: undo restores revision and connections');
    void lib;
  }

  // ── 8. Enter / breadcrumb ────────────────────────────────────────────────────
  {
    const f = fresh();
    const { reg } = f;
    const ifi = fin();
    await f.add('IN', 'Inner', dia([ifi, logb('i')], []));
    await reg.refresh();
    const rootKey = reg.newDocument('nexuscan.flow');
    ok(await reg.insertCall('IN'), 'enter: call block inserted');
    const cb = flowStore.getSnapshot().diagram.blocks.find((b) => b.type === callType('IN')) as FlowBlock;
    ok(await reg.enterCall(cb.id), 'enter: opens the callee');
    const s = reg.getSnapshot();
    eq([s.activeKey, s.trail.length, reg.getDoc('IN@r1')?.readOnly], ['IN@r1', 2, true], 'enter: callee shown read-only at its pinned revision');
    eq(flowStore.getSnapshot().readOnly, true, 'enter: the canvas is read-only');
    eq(flowStore.getSnapshot().viewPathKey, cb.id, 'enter: the view path is the call block id');
    reg.goToTrail(0);
    eq([reg.getSnapshot().activeKey, reg.getSnapshot().trail.length, reg.getDoc('IN@r1')], [rootKey, 1, undefined], 'breadcrumb: going up restores the parent and closes the deeper view');
    eq(flowStore.getSnapshot().readOnly, false, 'breadcrumb: parent canvas is editable again');
    ok(await reg.editLatest('IN'), 'edit latest: opens an editable tab');
    eq(reg.getDoc('IN')?.readOnly, false, 'edit latest: normal editable document');
  }

  // ── 9. Make Custom Block from selection ──────────────────────────────────────
  for (const mode of MODES) {
    const f = fresh();
    const { reg, lib } = f;
    reg.newDocument('nexuscan.flow');
    const rfi = fin();
    const l0 = logb('before');
    const s1 = logb('inside');
    const l3 = logb('after');
    const c = blk('data_const', 'C', { value: '7', format: 'dec' });
    const m = blk('math', 'Inc', { op: 'add', b: 3 });
    const parent = dia([rfi, l0, s1, l3, c, m], [
      wire(rfi, 'start', l0, 'exec_in'), wire(l0, 'exec_out', s1, 'exec_in'), wire(s1, 'exec_out', l3, 'exec_in'),
      wire(c, 'value_out', m, 'a_in'), wire(m, 'result', l3, 'value_in'),
    ]);
    flowStore.loadDocument(parent);
    const before = await f.run(mode, flowStore.getSnapshot().diagram);
    eq(before.lines, ['before', 'inside', 'after 10'], `extract: baseline [${mode}]`);
    flowStore.loadDocument(parent);
    flowStore.selectBlock(s1.id);
    flowStore.selectBlock(m.id, true);
    const undoBefore = flowStore.getSnapshot().undoStack.length;
    const res = await reg.extractSelection('Extracted');
    ok(res.ok, `extract: succeeds [${mode}]`);
    const after = flowStore.getSnapshot().diagram;
    eq(after.blocks.length, 5, `extract: two blocks replaced by one call block [${mode}]`);
    const callBlock = after.blocks.find((b) => b.type.startsWith('call:')) as FlowBlock;
    ok(callBlock !== undefined && callBlock.label === 'Extracted', `extract: call block named after the block [${mode}]`);
    eq(flowStore.getSnapshot().undoStack.length, undoBefore + 1, `extract: single undo step [${mode}]`);
    const entry = (await lib.list(false)).find((e) => e.name === 'Extracted');
    eq([entry?.kind, entry?.latestRevision], ['nexuscan.block', 1], `extract: saved as nexuscan.block r1 [${mode}]`);
    const iface = callIndex.get({ flowId: entry?.id ?? '', revision: 1 })?.iface;
    eq(iface?.inputs.map((i) => i.key), ['value_out'], `extract: input key from the source port [${mode}]`);
    eq(iface?.outcomes.map((o) => [o.name, o.outputs.map((x) => x.key)]), [['ok', ['result']]], `extract: outcome from the exec port, output from the data edge [${mode}]`);
    flowStore.undo();
    eq(flowStore.getSnapshot().diagram.blocks.length, 6, `extract: one undo restores the whole selection [${mode}]`);
    const post = await f.run(mode, after);
    eq(post.errors, [], `extract: no errors after extraction [${mode}]`);
    eq(post.lines, before.lines, `extract: identical logs before / after [${mode}]`);
  }
  {
    const f = fresh();
    f.reg.newDocument('nexuscan.flow');
    const rfi = fin();
    const a = logb('a');
    const b = logb('b');
    const s = logb('s');
    // two entry edges
    const two = dia([rfi, a, b, s], [wire(rfi, 'start', a, 'exec_in'), wire(a, 'exec_out', s, 'exec_in'), wire(b, 'exec_out', s, 'exec_in')]);
    const r1 = buildExtraction(two, [s.id], 'X', 'cid', (p) => `${p}_1`);
    ok(!r1.ok && r1.message.includes('2'), 'extract: two entry exec edges are refused with an explanation');
    // shared variable
    const v1 = blk('var_set', 'V1', { name: 'x', mode: 'add', amount: 1 });
    const v2 = blk('var_set', 'V2', { name: 'x', mode: 'add', amount: 1 });
    const shared = dia([rfi, v1, v2], [wire(rfi, 'start', v1, 'exec_in'), wire(v1, 'exec_out', v2, 'exec_in')], [{ name: 'x', type: 'number', initial: '0' }]);
    const r2 = buildExtraction(shared, [v2.id], 'X', 'cid', (p) => `${p}_1`);
    ok(!r2.ok && r2.message.includes('"x"'), 'extract: a variable shared with the rest of the flow is refused');
    const r3 = buildExtraction(shared, [rfi.id], 'X', 'cid', (p) => `${p}_1`);
    ok(!r3.ok, 'extract: the flow_input cannot be extracted');
    const loopless = dia([rfi, blk('flow_break', 'Br')], []);
    ok(!buildExtraction(loopless, [loopless.blocks[1].id], 'X', 'cid', (p) => `${p}_1`).ok, 'extract: a selection without an entry edge is refused');
  }

  // ── 10. ECU binding ──────────────────────────────────────────────────────────
  for (const mode of MODES) {
    const f = fresh();
    const ecu = newEcuRecord({ name: 'Engine1' });
    const cfi2 = fin([spec('ecu', 'ecu')]);
    const cl2 = logb('{ecu.name}-callee');
    await f.add('EC', 'EcuCallee', dia([cfi2, cl2], [wire(cfi2, 'start', cl2, 'exec_in')]));
    const rfi = fin([spec('ecu', 'ecu', { required: true })]);
    const rl = logb('{ecu.name}');
    const rc = call('EC', 1, 'EC');
    const root = dia([rfi, rl, rc], [wire(rfi, 'start', rl, 'exec_in'), wire(rl, 'exec_out', rc, 'in'), wire(rfi, 'ecu', rc, 'ecu')]);
    const good = await f.run(mode, root, { ecu, ecuSession: () => ({ tabId: 't1', ecuId: ecu.id, connected: true }) });
    eq(good.errors, [], `ecu: no errors [${mode}]`);
    eq(good.lines, ['Engine1', 'Engine1-callee'], `ecu: {ecu.*} resolved in the root and in the callee frame (ecu passed through the call port) [${mode}]`);
    // required ecu input without an ECU
    const none = await f.run(mode, root);
    eq(none.eng.result?.refused, true, `ecu: required ecu input without a bound ECU refuses the run [${mode}]`);
    // unresolvable reference in a callee frame -> refused before TX
    const bfi = fin([spec('ecu', 'ecu')]);
    const bl = logb('{ecu.routines.nope}');
    await f.add('BADREF', 'BadRef', dia([bfi, bl], [wire(bfi, 'start', bl, 'exec_in')]));
    const r2fi = fin([spec('ecu', 'ecu')]);
    const r2c = call('BADREF', 1);
    const bad = await f.run(mode, dia([r2fi, r2c], [wire(r2fi, 'start', r2c, 'in'), wire(r2fi, 'ecu', r2c, 'ecu')]), { ecu });
    eq(bad.eng.result?.refused, true, `ecu: a bad {ecu.*} reference in a callee refuses the run [${mode}]`);
    ok(bad.errors.some((m) => m.includes('BadRef') && m.includes('ecu.routines.nope')), `ecu: the error names the frame and the reference [${mode}]`);
    eq(bad.tr.sent, [], `ecu: refused before any TX [${mode}]`);
    // {ecu.*} without a declared ecu input
    const ufi = fin();
    const ul = logb('{ecu.name}');
    const und = await f.run(mode, dia([ufi, ul], [wire(ufi, 'start', ul, 'exec_in')]), { ecu });
    eq(und.eng.result?.refused, true, `ecu: {ecu.*} without an ecu input is refused [${mode}]`);
    // protocol: a uds block in a callee with a KWP ECU
    const sfi2 = fin();
    const ses = blk('uds_session', 'Session', {});
    await f.add('UDSB', 'UdsBlock', dia([sfi2, ses], [wire(sfi2, 'start', ses, 'exec_in')]));
    const pfi = fin([spec('ecu', 'ecu')]);
    const pc = call('UDSB', 1);
    const proto = await f.run(mode, dia([pfi, pc], [wire(pfi, 'start', pc, 'in')]), { ecu: newEcuRecord({ name: 'K', protocol: 'kwp_can' }) });
    eq(proto.eng.result?.refused, true, `ecu: callee requiring uds_can refused for a kwp_can ECU [${mode}]`);
    ok(proto.errors.some((m) => m.includes('UdsBlock') && m.includes('kwp_can')), `ecu: the refusal names the callee frame and protocols [${mode}]`);
  }
  {
    // session mismatch / disconnected (real engine only)
    const f = fresh();
    const ecu = newEcuRecord({ name: 'E2' });
    const fi = fin([spec('ecu', 'ecu')]);
    const lg = logb('go');
    const d = dia([fi, lg], [wire(fi, 'start', lg, 'exec_in')]);
    let r = await f.run('real', d, { ecu, ecuSession: () => ({ tabId: 't', ecuId: 'other-ecu', connected: true }) });
    eq(r.eng.result?.refused, true, 'session: a session opened for another ECU refuses the run');
    ok(r.errors.some((m) => m.includes(t('flowNest.run.sessionMissing', { name: 'E2' }))), 'session: the message tells to open a session for this ECU first');
    r = await f.run('real', d, { ecu, ecuSession: () => ({ tabId: 't', ecuId: ecu.id, connected: false }) });
    eq(r.eng.result?.refused, true, 'session: a disconnected session refuses the run');
    r = await f.run('real', d, { ecu, ecuSession: () => null });
    eq(r.eng.result?.refused, true, 'session: no session tab refuses the run');
    r = await f.run('real', d, { ecu, ecuSession: () => ({ tabId: 't', ecuId: ecu.id, connected: true }) });
    eq([r.eng.result?.refused, r.lines], [false, ['go']], 'session: the matching connected session runs');
    r = await f.run('sim', d, { ecu });
    eq(r.eng.result?.refused, false, 'session: the simulated engine needs no session');
    ok(checkEcuSession(ecu, { tabId: 't', ecuId: ecu.id, connected: true }) === null && checkEcuSession(ecu, null) !== null, 'session: checkEcuSession helper');
  }

  // ── 11. Required outputs (real enforces, simulated lenient) ─────────────────
  {
    const f = fresh();
    const fi = fin();
    const fo = fout('done', 'ok', [spec('r', 'number', { required: true })]);
    const d = dia([fi, fo], [wire(fi, 'start', fo, 'in')]);
    const real = await f.run('real', d);
    eq(real.eng.result?.outcome, 'error', 'outputs: the real engine fails on a missing required output');
    ok(real.errors.some((m) => m.includes('"r"')), 'outputs: the error names the output');
    const sim = await f.run('sim', d);
    eq(sim.eng.result?.outcome, 'ok', 'outputs: the simulated engine stays lenient');
  }

  // ── 12. Stop propagation + keep-alive cleanup on frame exit ─────────────────
  for (const mode of MODES) {
    const f = fresh();
    const fi = fin();
    const a = logb('inner1');
    const dl = blk('delay', 'Wait', { delay_ms: 250 });
    const b = logb('inner2');
    await f.add('SL', 'Slow', dia([fi, a, dl, b], [wire(fi, 'start', a, 'exec_in'), wire(a, 'exec_out', dl, 'exec_in'), wire(dl, 'exec_out', b, 'exec_in')]));
    const rfi = fin();
    const cl = call('SL', 1);
    const after = logb('after');
    load(dia([rfi, cl, after], [wire(rfi, 'start', cl, 'in'), wire(cl, 'ok', after, 'exec_in')]));
    const tr = new StubTransport();
    const eng = new FlowEngine();
    const p = eng.run({ transport: mode === 'sim' ? simTransport : tr, rootId: 'root', rootName: 'Root', resolveCallee: (id, rev) => f.reg.loadBody(id, rev) });
    await new Promise<void>((r) => setTimeout(r, 90));
    eng.stop();
    await p;
    const lines = flowStore.getSnapshot().runLog.map((e) => e.message).filter((m) => /LOG:/.test(m));
    ok(lines.some((m) => m.includes('inner1')), `stop: the inner frame had started [${mode}]`);
    ok(!lines.some((m) => m.includes('inner2')) && !lines.some((m) => m.includes('after')), `stop: nothing runs after Stop in the inner or the outer frame [${mode}]`);
    eq(eng.result?.stopped, true, `stop: the run result is stopped [${mode}]`);
    eq(flowStore.getSnapshot().isRunning, false, `stop: run state reset [${mode}]`);
  }
  {
    // keep-alive started inside a frame is released when the frame exits (before the parent continues)
    const f = fresh();
    const fi = fin();
    const ka = blk('uds_tester_present_keepalive', 'KA', { action: 'start', interval_ms: 500 });
    await f.add('KAB', 'KeepAlive', dia([fi, ka], [wire(fi, 'start', ka, 'exec_in')]));
    const rfi = fin();
    const cl = call('KAB', 1);
    const after = logb('after');
    const r = await f.run('real', dia([rfi, cl, after], [wire(rfi, 'start', cl, 'in'), wire(cl, 'ok', after, 'exec_in')]));
    eq(r.tr.keepalive, ['on', 'off'], 'keep-alive: started in the frame, stopped exactly once');
    const msgs = r.log.map((e) => e.message);
    const offAt = msgs.findIndex((m) => m.includes(t('udsFlow.log.kaReleasedEnd')));
    const afterAt = msgs.findIndex((m) => m.includes('LOG: after'));
    ok(offAt >= 0 && afterAt > offAt, 'keep-alive: released when the frame exits, before the parent continues');
  }
  stopAllTxSources();

  // ── 13. Canvas navigation: marquee hit-testing, modifier semantics, group ops ──
  {
    eq(screenToCanvas(300, 200, { zoom: 2, panX: 100, panY: -40 }), { x: 100, y: 120 }, 'screen -> canvas under zoom 2 and pan');
    eq(screenToCanvas(100, 60, { zoom: 0.5, panX: 100, panY: 60 }), { x: 0, y: 0 }, 'screen -> canvas under zoom 0.5');
    eq(rectFromPoints(50, 60, 10, 20), { x: 10, y: 20, w: 40, h: 40 }, 'marquee rect is normalized for any drag direction');
    ok(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 10, w: 5, h: 5 }) && !rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 11, y: 0, w: 5, h: 5 }), 'rectangles touching intersect, apart do not');
    const blocks = [
      { id: 'a', x: 0, y: 0, w: 200, h: 60 },
      { id: 'b', x: 400, y: 0, w: 200, h: 60 },
      { id: 'c', x: 0, y: 300, w: 140, h: 28 },
    ];
    // a marquee drawn on screen at zoom 2 / pan (100, 50): covers canvas x 0..150, y -25..100
    const view = { zoom: 2, panX: 100, panY: 50 };
    const p1 = screenToCanvas(100, 0, view);
    const p2 = screenToCanvas(400, 250, view);
    eq(marqueeHits(blocks, rectFromPoints(p1.x, p1.y, p2.x, p2.y)), ['a'], 'marquee under zoom / pan hits only the block it covers');
    // partial overlap counts (intersection, not containment)
    const q1 = screenToCanvas(100 + 190 * 2, 50, view);
    const q2 = screenToCanvas(100 + 420 * 2, 50 + 10, view);
    eq(marqueeHits(blocks, rectFromPoints(q1.x, q1.y, q2.x, q2.y)), ['a', 'b'], 'a marquee crossing the edge of two blocks selects both');
    eq(marqueeHits(blocks, { x: 1000, y: 1000, w: 10, h: 10 }), [], 'an empty marquee selects nothing');
    // modifiers
    eq(applyMarquee(['x'], ['a', 'b'], { shift: false, ctrl: false }), ['a', 'b'], 'plain marquee replaces the selection');
    eq(applyMarquee(['x', 'a'], ['a', 'b'], { shift: true, ctrl: false }), ['x', 'a', 'b'], 'Shift marquee adds to the selection');
    eq(applyMarquee(['x', 'a'], ['a', 'b'], { shift: false, ctrl: true }), ['x', 'b'], 'Ctrl / Cmd marquee toggles');
    eq(applyMarquee(['x'], [], { shift: false, ctrl: false }), [], 'plain marquee over nothing clears');
    eq(clickSelect(['a'], 'b', { shift: false, ctrl: false }), { selection: ['b'], collapseOnRelease: false }, 'plain click selects one block');
    eq(clickSelect(['a'], 'b', { shift: true, ctrl: false }), { selection: ['a', 'b'], collapseOnRelease: false }, 'Shift click adds');
    eq(clickSelect(['a', 'b'], 'b', { shift: false, ctrl: true }), { selection: ['a'], collapseOnRelease: false }, 'Ctrl / Cmd click toggles off');
    eq(clickSelect(['a'], 'b', { shift: false, ctrl: true }), { selection: ['a', 'b'], collapseOnRelease: false }, 'Ctrl / Cmd click toggles on');
    eq(clickSelect(['a', 'b'], 'a', { shift: false, ctrl: false }), { selection: ['a', 'b'], collapseOnRelease: true }, 'plain press inside a multi-selection keeps it (group drag) and narrows on release');
    eq(blockSize({ type: 'log', collapsed: false }, 3), { w: 200, h: 36 + 3 * 24 + 8 }, 'block height follows the port rows');
    eq(blockSize({ type: 'log', collapsed: true }, 3).h, 36, 'a collapsed block is header only');
    eq(blockSize({ type: 'flow_terminal', collapsed: false }, 1), { w: 140, h: 28 }, 'terminals are pills');

    // group move / delete through the store: single undo step each
    const b1 = blk('log', 'B1');
    const b2 = blk('log', 'B2');
    const b3 = blk('log', 'B3');
    flowStore.loadDocument(dia([b1, b2, b3], [wire(b1, 'exec_out', b2, 'exec_in'), wire(b2, 'exec_out', b3, 'exec_in')]));
    flowStore.setSelection([b1.id, b2.id]);
    eq(flowStore.getSnapshot().selectedBlockIds, [b1.id, b2.id], 'setSelection replaces the block selection');
    flowStore.checkpoint();
    flowStore.moveBlocks({ [b1.id]: { x: 1, y: 2 }, [b2.id]: { x: 3, y: 4 } });
    flowStore.moveBlocks({ [b1.id]: { x: 5, y: 6 }, [b2.id]: { x: 7, y: 8 } });
    eq(flowStore.getSnapshot().undoStack.length, 1, 'a group drag is one undo step however many moves');
    flowStore.undo();
    eq(flowStore.getSnapshot().diagram.blocks.map((b) => [b.x, b.y]), [[b1.x, b1.y], [b2.x, b2.y], [b3.x, b3.y]], 'undo restores every moved block');
    flowStore.setSelection([b1.id, b2.id]);
    flowStore.removeBlocks(flowStore.getSnapshot().selectedBlockIds);
    eq([flowStore.getSnapshot().diagram.blocks.map((b) => b.id), flowStore.getSnapshot().diagram.connections.length, flowStore.getSnapshot().selectedBlockIds], [[b3.id], 0, []], 'delete removes the selection and its connections');
    eq(flowStore.getSnapshot().undoStack.length, 1, 'deleting a multi-selection is one undo step');
    flowStore.undo();
    eq([flowStore.getSnapshot().diagram.blocks.length, flowStore.getSnapshot().diagram.connections.length], [3, 2], 'undo restores the deleted blocks and connections');
    flowStore.loadDocument(dia([], []));
  }

  console.log(`flowNest.test: ${passed} checks passed`);
}

async function parseDia(lib: FakeLib, id: string): Promise<FlowDiagram> {
  const { parseFlowFile, fromFlowBody } = await import('./flowBody');
  const p = parseFlowFile(await lib.load(id, null));
  if (!p.ok) throw new Error('parse');
  return fromFlowBody(p.file.flow);
}

await main();
