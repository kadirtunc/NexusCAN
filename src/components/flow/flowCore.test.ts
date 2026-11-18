/**
 * Headless tests of the Flow Editor core block pack (diag-workspace-v1 §8.1): the four golden example
 * flows on BOTH engines (simulated = DEMO transport, real = stub transport), the pure block
 * semantics (math, logic, convert, text templates, coercion), loop control / `flow_for` rules, static
 * validation and the legacy `data_var` migration.
 * Run: `npm run test:flowcore` (esbuild bundle -> node; throws on the first failure).
 */
import { FlowEngine } from './FlowEngine';
import { flowStore } from './FlowStore';
import { FLOW_TEMPLATES } from './templates';
import { migrateLegacyVars } from './flowMigrate';
import { validateCore, type CoreIssueCode } from './coreValidate';
import { renameVariableRefs } from './flowVars';
import { fromFlowBody, toFlowBody } from './registry/flowBody';
import {
  bytesToNumber,
  convertValue,
  createScope,
  logicOp,
  mathOp,
  numberToBytes,
  parseTemplate,
  renderTemplate,
  checkForRange,
} from './coreBlocks';
import { compareValues } from './flowValues';
import { stopAllTxSources } from '../../store/txSources';
import type { FlowRequestOptions, FlowTransport } from './flowTransport';
import type { FlowBlock, FlowConnection, FlowDiagram } from './types';
import type { FlowVariableDeclV1 } from '../../types/flowLibrary';

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
function throws(fn: () => unknown, re: RegExp, msg: string): void {
  try {
    fn();
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (!re.test(m)) throw new Error(`FAIL: ${msg}\n  message: ${m}`);
    passed += 1;
    return;
  }
  throw new Error(`FAIL: ${msg} (did not throw)`);
}

// ─── Diagram builders ──────────────────────────────────────────────────────────

let seq = 0;
function blk(type: string, label: string, config: Record<string, unknown> = {}): FlowBlock {
  return { id: `b${++seq}`, type, label, x: seq * 10, y: 0, config, status: 'idle', collapsed: false };
}
function wire(from: FlowBlock, fromPort: string, to: FlowBlock, toPort = 'exec_in'): FlowConnection {
  return { id: `c${++seq}`, fromBlockId: from.id, fromPortId: fromPort, toBlockId: to.id, toPortId: toPort };
}
function dia(blocks: FlowBlock[], connections: FlowConnection[], variables?: FlowVariableDeclV1[]): FlowDiagram {
  return { id: 'd', name: 'd', blocks, connections, ...(variables ? { variables } : {}) };
}
const num = (name: string, initial = '0'): FlowVariableDeclV1 => ({ name, type: 'number', initial });

function load(d: FlowDiagram): void {
  flowStore.loadTemplate({
    id: 'x',
    nameKey: 'flowCore.tpl.counter.name',
    descriptionKey: 'flowCore.tpl.counter.desc',
    category: 'examples',
    icon: '',
    diagram: { blocks: d.blocks, connections: d.connections, ...(d.variables ? { variables: d.variables } : {}) },
  });
}
function loadExample(id: string): void {
  const tpl = FLOW_TEMPLATES.find((x) => x.id === id);
  if (!tpl) throw new Error(`template ${id} missing`);
  flowStore.loadTemplate(tpl);
}

// ─── Transports ────────────────────────────────────────────────────────────────

const simTransport = { demo: true } as unknown as FlowTransport;
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const VIN = 'WVWZZZ1KZAW000001';

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
    const pdu = await this.request(0x22, [(did >> 8) & 0xff, did & 0xff]);
    return pdu.slice(3);
  }
  async request(sid: number, data: readonly number[], _o: FlowRequestOptions = {}): Promise<number[]> {
    this.sent.push([sid, ...data].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' '));
    if (sid === 0x10) return [0x50, data[0], 0x00, 0x32, 0x01, 0xf4];
    if (sid === 0x22 && data[0] === 0xf1 && data[1] === 0x90) return [0x62, 0xf1, 0x90, ...ascii(VIN)];
    throw new Error(`unexpected request ${sid.toString(16)}`);
  }
}

type Mode = 'sim' | 'real';
interface RunResult {
  lines: string[];
  errors: string[];
  tx: string[];
  running: boolean;
}

/** Runs the loaded diagram; `lines` = payload of every `LOG:` entry in order. */
async function run(mode: Mode): Promise<RunResult> {
  const tr = new StubTransport();
  await new FlowEngine().run({ transport: mode === 'sim' ? simTransport : tr });
  const snap = flowStore.getSnapshot();
  const lines: string[] = [];
  for (const e of snap.runLog) {
    const m = /^\[[\d:.]+\]\s{3}LOG: (.*)$/.exec(e.message);
    if (m) lines.push(m[1]);
  }
  return {
    lines,
    errors: snap.runLog.filter((e) => e.level === 'error').map((e) => e.message),
    tx: tr.sent,
    running: snap.isRunning,
  };
}
const status = (id: string): string => flowStore.getSnapshot().diagram.blocks.find((b) => b.id === id)?.status ?? '?';

async function both(label: string, d: FlowDiagram, check: (r: RunResult, mode: Mode) => void): Promise<void> {
  for (const mode of ['sim', 'real'] as const) {
    load(d);
    const r = await run(mode);
    ok(!r.running, `${label} [${mode}]: run state reset`);
    check(r, mode);
  }
}

function codes(d: FlowDiagram): CoreIssueCode[] {
  return validateCore(d).map((i) => i.code);
}

async function main(): Promise<void> {
  // ── 1. Golden flows on BOTH engines ──────────────────────────────────────────
  for (const mode of ['sim', 'real'] as const) {
    // 1: counter 0 -> 99
    loadExample('ex_counter');
    eq(validateCore(flowStore.getSnapshot().diagram).length, 0, `golden 1 validates [${mode}]`);
    let r = await run(mode);
    eq(r.errors, [], `golden 1: no errors [${mode}]`);
    eq(r.lines.length, 100, `golden 1: exactly 100 log lines [${mode}]`);
    eq(r.lines, Array.from({ length: 100 }, (_, i) => `x = ${i}`), `golden 1: x = 0 .. x = 99 [${mode}]`);
    const endCounter = flowStore.getSnapshot().diagram.blocks.find((b) => b.type === 'end');
    ok(endCounter !== undefined && status(endCounter.id) === 'success', `golden 1: loop exits to End [${mode}]`);
    // a second run starts again from the typed initial (x = 0): variables are run-scoped
    r = await run(mode);
    eq(r.lines.length, 100, `golden 1: second run resets x [${mode}]`);

    // 2: for 1..10 with break at 5
    loadExample('ex_for_break');
    eq(validateCore(flowStore.getSnapshot().diagram).length, 0, `golden 2 validates [${mode}]`);
    r = await run(mode);
    eq(r.errors, [], `golden 2: no errors [${mode}]`);
    eq(r.lines, ['i = 1', 'i = 2', 'i = 3', 'i = 4'], `golden 2: 4 logged iterations, break at 5 [${mode}]`);
    const endFor = flowStore.getSnapshot().diagram.blocks.find((b) => b.type === 'end');
    ok(endFor !== undefined && status(endFor.id) === 'success', `golden 2: loop exits via done_out [${mode}]`);

    // 3: sum 1..100
    loadExample('ex_sum');
    eq(validateCore(flowStore.getSnapshot().diagram).length, 0, `golden 3 validates [${mode}]`);
    r = await run(mode);
    eq(r.errors, [], `golden 3: no errors [${mode}]`);
    eq(r.lines, ['sum = 5050'], `golden 3: sum = 5050 [${mode}]`);
  }

  // 4: read DID F190 -> convert text -> text_format -> log
  {
    loadExample('ex_did_format');
    eq(validateCore(flowStore.getSnapshot().diagram).length, 0, 'golden 4 validates');
    const r = await run('real');
    eq(r.errors, [], 'golden 4: no errors (real)');
    eq(r.tx, ['10 03', '22 F1 90'], 'golden 4: session + DID request sent');
    eq(r.lines, [`VIN = ${VIN}`], 'golden 4: formatted VIN (real, 17 chars)');
    eq(VIN.length, 17, 'golden 4: VIN has 17 chars');
    const sim = await run('sim');
    eq(sim.errors, [], 'golden 4: no errors (sim)');
    eq(sim.lines, ['VIN = WNXSYNTH000000001'], 'golden 4: formatted VIN (sim)');
  }
  stopAllTxSources();

  // ── 2. math ──────────────────────────────────────────────────────────────────
  eq(mathOp('add', 2, 3, 'm'), 5, 'math add');
  eq(mathOp('sub', 2, 3, 'm'), -1, 'math sub');
  eq(mathOp('mul', 4, 2.5, 'm'), 10, 'math mul');
  eq(mathOp('div', 7, 2, 'm'), 3.5, 'math div');
  eq(mathOp('mod', 7, 4, 'm'), 3, 'math mod');
  eq(mathOp('min', 7, 4, 'm'), 4, 'math min');
  eq(mathOp('max', 7, 4, 'm'), 7, 'math max');
  eq(mathOp('abs', -3, undefined, 'm'), 3, 'math abs (unary, b ignored)');
  eq(mathOp('round', 2.5, undefined, 'm'), 3, 'math round');
  eq(mathOp('floor', 2.9, undefined, 'm'), 2, 'math floor');
  eq(mathOp('add', '5', '0x10', 'm'), 21, 'math numeric text / hex operands');
  throws(() => mathOp('div', 1, 0, 'DivBlock'), /DivBlock/, 'math division by zero names the block');
  throws(() => mathOp('mod', 1, 0, 'ModBlock'), /ModBlock/, 'math modulo by zero');
  throws(() => mathOp('add', 'abc', 1, 'NanBlock'), /NanBlock/, 'math non-numeric operand');
  throws(() => mathOp('add', Number.MAX_VALUE, Number.MAX_VALUE, 'OvfBlock'), /OvfBlock/, 'math non-finite result');
  throws(() => mathOp('pow', 1, 2, 'OpBlock'), /OpBlock/, 'math unknown op');

  // ── 3. logic ─────────────────────────────────────────────────────────────────
  eq([logicOp('and', true, false, 'l'), logicOp('and', true, true, 'l')], [false, true], 'logic and');
  eq([logicOp('or', false, false, 'l'), logicOp('or', false, true, 'l')], [false, true], 'logic or');
  eq([logicOp('xor', true, true, 'l'), logicOp('xor', true, false, 'l')], [false, true], 'logic xor');
  eq([logicOp('not', true, undefined, 'l'), logicOp('not', 0, undefined, 'l')], [false, true], 'logic not ignores b');

  // ── 4. convert ───────────────────────────────────────────────────────────────
  const cv = (v: unknown, target: string, byteLength = 1, endianness: 'big' | 'little' = 'big'): unknown =>
    convertValue(v, { target, byteLength, endianness }, 'cv');
  eq(Array.from(cv(0x1234, 'bytes', 2, 'big') as Uint8Array), [0x12, 0x34], 'number -> bytes big-endian');
  eq(Array.from(cv(0x1234, 'bytes', 2, 'little') as Uint8Array), [0x34, 0x12], 'number -> bytes little-endian');
  eq(Array.from(cv(0x1234, 'bytes', 4, 'big') as Uint8Array), [0, 0, 0x12, 0x34], 'number -> bytes byteLength 4');
  eq(Array.from(cv(0xdeadbeef, 'bytes', 8, 'little') as Uint8Array), [0xef, 0xbe, 0xad, 0xde, 0, 0, 0, 0], 'number -> bytes 8 little');
  throws(() => cv(0x1234, 'bytes', 1), /cv/, 'number does not fit byteLength');
  throws(() => cv(-1, 'bytes', 2), /cv/, 'negative number -> bytes');
  throws(() => cv(1, 'bytes', 9), /cv/, 'byteLength above 8');
  throws(() => cv(1, 'bytes', 0), /cv/, 'byteLength below 1');
  eq(cv(Uint8Array.of(0x12, 0x34), 'number', 1, 'big'), 0x1234, 'bytes -> number big-endian');
  eq(cv(Uint8Array.of(0x12, 0x34), 'number', 1, 'little'), 0x3412, 'bytes -> number little-endian');
  throws(() => cv(new Uint8Array(7), 'number'), /cv/, 'bytes -> number over 6 bytes');
  eq(Array.from(cv('AB', 'bytes') as Uint8Array), [0x41, 0x42], 'text -> bytes ASCII');
  throws(() => cv('é', 'bytes'), /cv/, 'text -> bytes rejects non-ASCII');
  eq(cv(Uint8Array.from(ascii('WVW')), 'text'), 'WVW', 'bytes -> text ASCII');
  eq(cv(Uint8Array.of(0x41, 0x00, 0x42), 'text'), 'A.B', 'bytes -> text non-printable as "."');
  eq(cv(Uint8Array.of(0xde, 0xad, 0x01), 'hex'), 'DE AD 01', 'bytes -> hex spaced uppercase');
  eq(cv(255, 'hex'), 'FF', 'number -> hex');
  eq(cv(256, 'hex'), '01 00', 'number -> hex pads to whole bytes');
  eq(cv(42, 'text'), '42', 'number -> text');
  eq(cv(true, 'text'), 'true', 'bool -> text');
  eq(cv('12', 'number'), 12, 'text -> number');
  eq(bytesToNumber(Uint8Array.of(1, 0), 'big', 'b'), 256, 'bytesToNumber');
  eq(Array.from(numberToBytes(258, 2, 'little', 'b')), [2, 1], 'numberToBytes');

  // ── 5. text templates ────────────────────────────────────────────────────────
  eq(parseTemplate('a {x} b {{y}} {z}').map((p) => (p.kind === 'ph' ? `<${p.name}>` : p.text)), ['a ', '<x>', ' b {y} ', '<z>'], 'template parse + escapes');
  eq(parseTemplate('{a:1} {').map((p) => (p.kind === 'ph' ? `<${p.name}>` : p.text)), ['{a:1} {'], 'stray braces stay literal');
  eq(renderTemplate('n={n} h={h} t={t} b={b}', (k) => ({ n: 7, h: Uint8Array.of(0xab, 1), t: 'hi', b: true }[k])), 'n=7 h=AB 01 t=hi b=true', 'template value rendering');

  {
    const tf = blk('text_format', 'Fmt', { template: 'x = {x}, nrc = {nrc}, bad = {nope}', inputs: ['nrc'] });
    const d = dia([tf], [], [num('x', '3')]);
    const issue = validateCore(d).find((i) => i.code === 'fmt_unknown');
    ok(issue !== undefined && issue.blockId === tf.id && issue.message.includes('nope'), 'text_format: unknown placeholder is a validation error');
    eq(codes(dia([blk('text_format', 'Fmt2', { template: 'x = {x}, nrc = {nrc}', inputs: ['nrc'] })], [], [num('x')])), [], 'text_format: input + variable placeholders validate');
    eq(codes(dia([blk('text_format', 'Fmt3', { template: '{a}', inputs: ['a', 'a', '1x'] })], [])), ['fmt_input_dup', 'fmt_input_name'], 'text_format: bad / duplicate input names');
  }

  // text_format at run time: input port wins over a same-named variable; bytes as hex, numbers decimal
  {
    const start = blk('start', 'Start');
    const c = blk('data_const', 'C', { value: 'AA BB', format: 'hex' });
    const fmt = blk('text_format', 'Fmt', { template: 'x={x} nrc={nrc}', inputs: ['x', 'nrc'] });
    const lg = blk('log', 'Log', { message: '{value}' });
    const cx = blk('data_const', 'CX', { value: '9', format: 'dec' });
    const d = dia([start, c, cx, fmt, lg], [
      wire(start, 'exec_out', lg), wire(c, 'value_out', fmt, 'nrc'), wire(cx, 'value_out', fmt, 'x'), wire(fmt, 'text_out', lg, 'value_in'),
    ], [num('x', '1')]);
    await both('text_format ports', d, (r) => {
      eq(r.errors, [], 'text_format run: no errors');
      eq(r.lines, ['x=9 nrc=AA BB'], 'text_format run: named input shadows variable, bytes as hex');
    });
  }
  // unconnected declared input = run error with block label
  {
    const start = blk('start', 'Start');
    const fmt = blk('text_format', 'FmtOpen', { template: '{a}', inputs: ['a'] });
    const lg = blk('log', 'Log', { message: '{value}' });
    const d = dia([start, fmt, lg], [wire(start, 'exec_out', lg), wire(fmt, 'text_out', lg, 'value_in')]);
    await both('text_format open input', d, (r) => {
      ok(r.errors.some((e) => e.includes('FmtOpen')), 'text_format unconnected input: error names the block');
    });
  }

  // ── 6. var_set / var_get semantics ───────────────────────────────────────────
  {
    // set with coercion, add / sub default amount 1, add with value_in, reads are pure
    const start = blk('start', 'Start');
    const s1 = blk('var_set', 'S1', { name: 'n', mode: 'set' });
    const c = blk('data_const', 'C', { value: '41', format: 'text' });
    const s2 = blk('var_set', 'S2', { name: 'n', mode: 'add', amount: 1 });
    const s3 = blk('var_set', 'S3', { name: 'n', mode: 'sub', amount: 5 });
    const l = blk('log', 'L', { message: 'n={n}' });
    const d = dia([start, s1, c, s2, s3, l], [
      wire(start, 'exec_out', s1), wire(c, 'value_out', s1, 'value_in'), wire(s1, 'exec_out', s2), wire(s2, 'exec_out', s3), wire(s3, 'exec_out', l),
    ], [num('n', '0')]);
    await both('var_set basic', d, (r) => {
      eq(r.errors, [], 'var_set: no errors');
      eq(r.lines, ['n=37'], 'var_set: text "41" coerced to number, +1, -5');
    });
  }
  {
    // pure read does not assign: var_get feeding a log twice never changes the value
    const start = blk('start', 'Start');
    const g = blk('var_get', 'G', { name: 'k' });
    const l1 = blk('log', 'L1', { message: 'a' });
    const l2 = blk('log', 'L2', { message: 'b' });
    const d = dia([start, g, l1, l2], [wire(start, 'exec_out', l1), wire(l1, 'exec_out', l2), wire(g, 'value', l1, 'value_in'), wire(g, 'value', l2, 'value_in')], [num('k', '7')]);
    await both('pure read', d, (r) => eq(r.lines, ['a 7', 'b 7'], 'var_get is a pure read (legacy append format kept)'));
  }
  {
    // coercion error: text into a number variable
    const start = blk('start', 'Start');
    const c = blk('data_const', 'C', { value: 'abc', format: 'text' });
    const s = blk('var_set', 'SetBad', { name: 'n', mode: 'set' });
    const d = dia([start, c, s], [wire(start, 'exec_out', s), wire(c, 'value_out', s, 'value_in')], [num('n')]);
    await both('coerce error', d, (r) => ok(r.errors.some((e) => e.includes('SetBad')), 'var_set: "abc" -> number is a run error naming the block'));
    // add on a text variable: static validation error and no run
    const s2 = blk('var_set', 'AddText', { name: 't', mode: 'add' });
    const dd = dia([blk('start', 'Start'), s2], [], [{ name: 't', type: 'text', initial: '' }]);
    ok(codes(dd).includes('var_type'), 'var_set add on a text variable is a validation error');
    load(dia([start, s2], [wire(start, 'exec_out', s2)], [{ name: 't', type: 'text', initial: 'a' }]));
    const rr = await run('real');
    ok(rr.errors.some((e) => e.includes('AddText')), 'var_set add on text: run refused with the block label');
  }
  {
    // bool and bytes variables
    const start = blk('start', 'Start');
    const c1 = blk('data_const', 'C1', { value: 'AB CD', format: 'hex' });
    const s1 = blk('var_set', 'S1', { name: 'bs', mode: 'set' });
    const c2 = blk('data_const', 'C2', { value: '0', format: 'dec' });
    const s2 = blk('var_set', 'S2', { name: 'flag', mode: 'set' });
    const l = blk('log', 'L', { message: 'bs={bs} flag={flag}' });
    const d = dia([start, c1, s1, c2, s2, l], [
      wire(start, 'exec_out', s1), wire(c1, 'value_out', s1, 'value_in'), wire(s1, 'exec_out', s2), wire(c2, 'value_out', s2, 'value_in'), wire(s2, 'exec_out', l),
    ], [{ name: 'bs', type: 'bytes', initial: '' }, { name: 'flag', type: 'bool', initial: 'true' }]);
    await both('bool/bytes vars', d, (r) => {
      eq(r.errors, [], 'bool/bytes: no errors');
      eq(r.lines, ['bs=AB CD flag=false'], 'bool/bytes: hex bytes and number -> bool coercion');
    });
  }
  {
    // unknown variable: validation error and refused run
    const start = blk('start', 'Start');
    const g = blk('var_get', 'GetGhost', { name: 'ghost' });
    const l = blk('log', 'L', { message: '' });
    const d = dia([start, g, l], [wire(start, 'exec_out', l), wire(g, 'value', l, 'value_in')]);
    ok(codes(d).includes('var_unknown'), 'var_get of an undeclared variable is a validation error');
    load(d);
    const r = await run('sim');
    ok(r.errors.length > 0 && r.lines.length === 0, 'undeclared variable: run refused, nothing executed');
  }
  {
    // declaration validation
    eq(codes(dia([], [], [num('1bad'), num('ok'), num('ok')])), ['decl_name', 'decl_dup'], 'declarations: name regex + uniqueness');
    eq(codes(dia([], [], [{ name: 'n', type: 'number', initial: 'abc' }, { name: 'b', type: 'bool', initial: 'maybe' }, { name: 'h', type: 'bytes', initial: 'ZZ' }])),
      ['decl_initial', 'decl_initial', 'decl_initial'], 'declarations: typed initial must parse');
    const sc = createScope([num('a', '5'), { name: 'h', type: 'bytes', initial: '01 02' }]);
    eq([sc.vars.get('a'), Array.from(sc.vars.get('h') as Uint8Array)], [5, [1, 2]], 'createScope: typed initials');
  }
  {
    // rename propagates to var_get / var_set / templates / log; port-shadowed placeholders are untouched
    const g = blk('var_get', 'G', { name: 'x' });
    const s = blk('var_set', 'S', { name: 'x', mode: 'add' });
    const f = blk('text_format', 'F', { template: 'x={x}', inputs: [] });
    const fs = blk('text_format', 'Fshadow', { template: 'x={x}', inputs: ['x'] });
    const l = blk('log', 'L', { message: 'v {x} {{x}}' });
    const out = renameVariableRefs(dia([g, s, f, fs, l], []), 'x', 'count');
    const cfg = (id: string): Record<string, unknown> => out.blocks.find((b) => b.id === id)?.config ?? {};
    eq([cfg(g.id)['name'], cfg(s.id)['name'], cfg(f.id)['template'], cfg(fs.id)['template'], cfg(l.id)['message']],
      ['count', 'count', 'x={count}', 'x={x}', 'v {count} {{x}}'], 'rename updates every reference');
    // store-level rename keeps references valid
    load(dia([blk('start', 'Start'), blk('var_get', 'G', { name: 'x' })], [], [num('x')]));
    ok(flowStore.updateVariable('x', { name: 'y' }), 'store rename accepted');
    eq(flowStore.getSnapshot().diagram.blocks[1].config['name'], 'y', 'store rename re-points var_get');
    ok(!flowStore.updateVariable('y', { name: '9bad' }), 'store rename rejects an invalid name');
    flowStore.addVariable();
    const v = flowStore.getSnapshot().diagram.variables ?? [];
    ok(!flowStore.updateVariable(v[1].name, { name: 'y' }), 'store rename rejects a duplicate name');
  }

  // ── 7. compare operators on numbers ──────────────────────────────────────────
  eq([compareValues('lt', 1, 2), compareValues('lt', 2, 2), compareValues('le', 2, 2), compareValues('le', 3, 2)], [true, false, true, false], 'compare lt / le');
  eq([compareValues('gt', 3, 2), compareValues('gt', 2, 2), compareValues('ge', 2, 2), compareValues('ge', 1, 2)], [true, false, true, false], 'compare gt / ge');
  eq(compareValues('lt', '5', 10), true, 'compare numeric text vs number');
  eq(compareValues('eq', 5, '5'), true, 'compare eq number vs numeric text');
  throws(() => compareValues('lt', 'abc', 1), /./, 'compare lt on non-numeric throws');

  // ── 8. loops: flow_for rules, break / continue ───────────────────────────────
  eq(checkForRange({ from: 1, to: 10, step: 0 }), 'step_zero', 'for: step 0');
  eq(checkForRange({ from: 1, to: 10, step: -1 }), 'step_sign', 'for: step sign vs range (down)');
  eq(checkForRange({ from: 10, to: 1, step: 1 }), 'step_sign', 'for: step sign vs range (up)');
  eq(checkForRange({ from: 5, to: 5, step: 1 }), null, 'for: from == to is one pass');
  eq(checkForRange({ from: NaN, to: 5, step: 1 }), 'not_finite', 'for: NaN');
  {
    const mk = (cfg: Record<string, unknown>): FlowDiagram => {
      const start = blk('start', 'Start');
      const f = blk('flow_for', 'ForX', cfg);
      return dia([start, f], [wire(start, 'exec_out', f)]);
    };
    ok(codes(mk({ from: 1, to: 3, step: 0 })).includes('for_range'), 'flow_for step 0 is a validation error');
    ok(codes(mk({ from: 1, to: 3, step: -1 })).includes('for_range'), 'flow_for sign-inconsistent step is a validation error');
    load(mk({ from: 1, to: 3, step: 0 }));
    const r = await run('real');
    ok(r.errors.some((e) => e.includes('ForX')), 'flow_for step 0: run refused with the block label');
    // cap: 200000 passes -> run error after 100000
    load(mk({ from: 1, to: 200000, step: 1 }));
    for (const mode of ['sim', 'real'] as const) {
      const rc = await run(mode);
      ok(rc.errors.some((e) => e.includes('ForX') && e.includes('100000')), `flow_for safety cap 100000 is a run error [${mode}]`);
    }
    // counting down, and a step that skips the end
    const start = blk('start', 'Start');
    const f = blk('flow_for', 'F', { from: 10, to: 1, step: -4 });
    const l = blk('log', 'L', { message: 'i' });
    const dd = dia([start, f, l], [wire(start, 'exec_out', f), wire(f, 'body_out', l), wire(f, 'index', l, 'value_in')]);
    await both('for down', dd, (r) => eq(r.lines, ['i 10', 'i 6', 'i 2'], 'flow_for counts down by step'));
  }
  {
    // continue skips the rest of the body (index 3), break exits
    const start = blk('start', 'Start');
    const f = blk('flow_for', 'F', { from: 1, to: 5, step: 1 });
    const three = blk('data_const', 'Three', { value: '3', format: 'dec' });
    const eq3 = blk('data_compare', 'Eq3', { operator: 'eq' });
    const cond = blk('condition', 'Cond');
    const cont = blk('flow_continue', 'Cont');
    const lg = blk('log', 'Lg', { message: 'i={value}' });
    const d = dia([start, f, three, eq3, cond, cont, lg], [
      wire(start, 'exec_out', f), wire(f, 'body_out', cond), wire(f, 'index', eq3, 'left_in'), wire(three, 'value_out', eq3, 'right_in'),
      wire(eq3, 'result_out', cond, 'bool_in'), wire(cond, 'true_out', cont), wire(cond, 'false_out', lg), wire(f, 'index', lg, 'value_in'),
    ]);
    eq(codes(d), [], 'continue inside a loop body validates');
    await both('continue', d, (r) => {
      eq(r.errors, [], 'continue: no errors');
      eq(r.lines, ['i=1', 'i=2', 'i=4', 'i=5'], 'continue skips only the current pass');
    });
  }
  {
    // nested loops: break leaves only the INNER loop
    const start = blk('start', 'Start');
    const outer = blk('flow_for', 'Outer', { from: 1, to: 2, step: 1 });
    const setO = blk('var_set', 'SetO', { name: 'o', mode: 'set' });
    const inner = blk('flow_for', 'Inner', { from: 1, to: 5, step: 1 });
    const lg = blk('log', 'Lg', { message: 'o={o} i={value}' });
    const two = blk('data_const', 'Two', { value: '2', format: 'dec' });
    const eq2 = blk('data_compare', 'Eq2', { operator: 'eq' });
    const cond = blk('condition', 'Cond');
    const brk = blk('flow_break', 'Brk');
    const after = blk('log', 'After', { message: 'inner done' });
    const d = dia([start, outer, setO, inner, lg, two, eq2, cond, brk, after], [
      wire(start, 'exec_out', outer), wire(outer, 'body_out', setO), wire(outer, 'index', setO, 'value_in'), wire(setO, 'exec_out', inner),
      wire(inner, 'body_out', lg), wire(inner, 'index', lg, 'value_in'), wire(lg, 'exec_out', cond),
      wire(inner, 'index', eq2, 'left_in'), wire(two, 'value_out', eq2, 'right_in'), wire(eq2, 'result_out', cond, 'bool_in'),
      wire(cond, 'true_out', brk), wire(inner, 'done_out', after),
    ], [num('o')]);
    await both('nested break', d, (r) => {
      eq(r.errors, [], 'nested break: no errors');
      eq(r.lines, ['o=1 i=1', 'o=1 i=2', 'inner done', 'o=2 i=1', 'o=2 i=2', 'inner done'], 'break leaves only the nearest loop');
    });
  }
  {
    // break in a while and in the legacy fixed loop
    const start = blk('start', 'Start');
    const lp = blk('loop', 'Loop', { iterations: 4 });
    const lg = blk('log', 'Lg', { message: 'pass' });
    const d = dia([start, lp, lg], [wire(start, 'exec_out', lp), wire(lp, 'body_out', lg)]);
    await both('fixed loop', d, (r) => eq(r.lines.length, 4, 'loop block runs its body exactly `iterations` times'));

    const start2 = blk('start', 'Start');
    const wh = blk('flow_while', 'While', { max_iterations: 50 });
    const t = blk('data_const', 'T', { value: '1', format: 'dec' });
    const brk = blk('flow_break', 'Brk');
    const lg2 = blk('log', 'Lg', { message: 'once' });
    const d2 = dia([start2, wh, t, brk, lg2], [wire(start2, 'exec_out', wh), wire(t, 'value_out', wh, 'bool_in'), wire(wh, 'body_out', lg2), wire(lg2, 'exec_out', brk)]);
    await both('while break', d2, (r) => {
      eq(r.errors, [], 'while + break: no errors');
      eq(r.lines, ['once'], 'break ends a while loop');
    });
  }
  {
    // break / continue outside a loop: validation error + refused run
    const start = blk('start', 'Start');
    const brk = blk('flow_break', 'BrkOut');
    const d = dia([start, brk], [wire(start, 'exec_out', brk)]);
    ok(codes(d).includes('loop_outside'), 'flow_break outside a loop is a validation error');
    const cont = blk('flow_continue', 'ContOut');
    ok(codes(dia([cont], [])).includes('loop_outside'), 'flow_continue outside a loop is a validation error');
    for (const mode of ['sim', 'real'] as const) {
      load(d);
      const r = await run(mode);
      ok(r.errors.some((e) => e.includes('BrkOut')) && status(brk.id) === 'error', `flow_break outside a loop refuses the run [${mode}]`);
    }
    // inside a loop (also reached through a nested pure/branch path) it is fine
    const f = blk('flow_for', 'F', { from: 1, to: 2 });
    const brk2 = blk('flow_break', 'Brk2');
    eq(codes(dia([start, f, brk2], [wire(start, 'exec_out', f), wire(f, 'body_out', brk2)])), [], 'flow_break in a loop body validates');
    // a break on the done_out path of the loop is OUTSIDE it
    const brk3 = blk('flow_break', 'Brk3');
    ok(codes(dia([start, f, brk3], [wire(start, 'exec_out', f), wire(f, 'done_out', brk3)])).includes('loop_outside'), 'flow_break after done_out is outside the loop');
  }

  // ── 8b. flow_while safety cap is a run error, never a silent stop ────────────
  {
    const mkWhile = (cond: 'x150' | 'true', cfg: Record<string, unknown>): FlowDiagram => {
      const start = blk('start', 'Start');
      const wh = blk('flow_while', 'WhileCap', cfg);
      const lg = blk('log', 'Lg', { message: 'x = {x}' });
      const inc = blk('var_set', 'Inc', { name: 'x', mode: 'add', amount: 1 });
      const bl: FlowBlock[] = [start, wh, lg, inc];
      const cn: FlowConnection[] = [wire(start, 'exec_out', wh), wire(wh, 'body_out', lg), wire(lg, 'exec_out', inc)];
      if (cond === 'x150') {
        const lim = blk('data_const', 'Lim', { value: '150', format: 'dec' });
        const lt = blk('data_compare', 'Lt', { operator: 'lt' });
        const g = blk('var_get', 'G', { name: 'x' });
        bl.push(lim, lt, g);
        cn.push(wire(g, 'value', lt, 'left_in'), wire(lim, 'value_out', lt, 'right_in'), wire(lt, 'result_out', wh, 'bool_in'));
      } else {
        const t1 = blk('data_const', 'T1', { value: '1', format: 'dec' });
        bl.push(t1);
        cn.push(wire(t1, 'value_out', wh, 'bool_in'));
      }
      return dia(bl, cn, [num('x')]);
    };
    // block without a stored cap uses 10000: 150 passes are fine
    await both('while default cap', mkWhile('x150', {}), (r) => {
      eq(r.errors, [], 'while x < 150 with the default cap: no error');
      eq(r.lines.length, 150, 'while x < 150: 150 log lines');
    });
    await both('while cap', mkWhile('true', { max_iterations: 50 }), (r) => {
      ok(r.errors.some((e) => e.includes('WhileCap') && e.includes('50')), 'while true with cap 50: run error naming block and limit');
      eq(r.lines.length, 50, 'while true with cap 50: exactly 50 body executions');
    });
    // cap equal to the needed passes is NOT an error (condition false afterwards)
    await both('while exact cap', mkWhile('x150', { max_iterations: 150 }), (r) => {
      eq(r.errors, [], 'while cap == needed passes: no error');
      eq(r.lines.length, 150, 'while cap == needed passes: 150 lines');
    });
    ok(codes(mkWhile('true', { max_iterations: 0 })).includes('while_range'), 'while max_iterations 0 invalid');
    ok(codes(mkWhile('true', { max_iterations: 1_000_001 })).includes('while_range'), 'while max_iterations above 1000000 invalid');
    eq(codes(mkWhile('true', { max_iterations: 1_000_000 })), [], 'while max_iterations 1000000 valid');
  }

  // ── 9. log templates ─────────────────────────────────────────────────────────
  {
    const start = blk('start', 'Start');
    const l1 = blk('log', 'Plain', { message: 'hello world' });
    const c = blk('data_const', 'C', { value: 'AA BB', format: 'hex' });
    const l2 = blk('log', 'Legacy', { message: 'bytes:' });
    const l3 = blk('log', 'Esc', { message: 'literal {{x}} and {x}' });
    const d = dia([start, l1, c, l2, l3], [wire(start, 'exec_out', l1), wire(l1, 'exec_out', l2), wire(c, 'value_out', l2, 'value_in'), wire(l2, 'exec_out', l3)], [num('x', '4')]);
    await both('log compat', d, (r) => {
      eq(r.lines, ['hello world', 'bytes: AA BB', 'literal {x} and 4'], 'log: messages without braces byte-identical; {{ }} escapes; {x} variable');
    });
    ok(codes(dia([blk('log', 'L', { message: '{nope}' })], [])).includes('fmt_unknown'), 'log: unknown placeholder is a validation error');
    ok(codes(dia([blk('log', 'L', { message: '{value}' })], [])).includes('log_value'), 'log: {value} without value_in is a validation error');
  }

  // ── 10. migration of the legacy data_var ─────────────────────────────────────
  {
    // (a) set_in unconnected -> declared variable + var_get; reader connection re-pointed to `value`
    const start = blk('start', 'Start');
    const dv = blk('data_var', 'Counter', { name: 'cnt', initial: '5' });
    const lg = blk('log', 'Lg', { message: 'cnt =' });
    const d = dia([start, dv, lg], [wire(start, 'exec_out', lg), wire(dv, 'get_out', lg, 'value_in')]);
    const m = migrateLegacyVars(d);
    eq(m.diagram.variables, [{ name: 'cnt', type: 'number', initial: '5' }], 'migration (a): variable declared, type inferred from initial');
    const mb = m.diagram.blocks.find((b) => b.id === dv.id);
    eq([mb?.type, mb?.config['name']], ['var_get', 'cnt'], 'migration (a): same block id becomes var_get');
    ok(m.diagram.connections.some((c) => c.fromBlockId === dv.id && c.fromPortId === 'value' && c.toBlockId === lg.id), 'migration (a): connection re-pointed to value');
    ok(m.notes.length > 0, 'migration (a): note emitted');
    eq(codes(m.diagram), [], 'migration (a): result validates');
    await both('migration a', d, (r) => eq(r.lines, ['cnt = 5'], 'migration (a): runs with the same output'));
    // text initial
    const dt = blk('data_var', 'T', { name: 'label', initial: 'abc' });
    eq(migrateLegacyVars(dia([dt], [])).diagram.variables, [{ name: 'label', type: 'text', initial: 'abc' }], 'migration (a): non-numeric initial is text');
    // invalid legacy name is sanitized and reported
    const di = blk('data_var', 'I', { name: 'my var-1', initial: '' });
    const mi = migrateLegacyVars(dia([di], []));
    eq(mi.diagram.variables?.map((v) => v.name), ['my_var_1'], 'migration (a): invalid name sanitized');
    eq(codes(mi.diagram), [], 'migration (a): sanitized name validates');
    // unchanged diagrams are returned as-is
    const plain = dia([blk('start', 'S')], []);
    ok(migrateLegacyVars(plain).diagram === plain, 'migration: no legacy block -> same diagram object');
  }
  {
    // (b) set_in connected, exactly one exec reader -> var_set inserted before it
    const start = blk('start', 'Start');
    const c = blk('data_const', 'Forty2', { value: '42', format: 'dec' });
    const dv = blk('data_var', 'Assign', { name: 'v', initial: '' });
    const lg = blk('log', 'Reader', { message: 'v =' });
    const end = blk('end', 'End');
    const d = dia([start, c, dv, lg, end], [
      wire(start, 'exec_out', lg), wire(c, 'value_out', dv, 'set_in'), wire(dv, 'get_out', lg, 'value_in'), wire(lg, 'exec_out', end),
    ]);
    const m = migrateLegacyVars(d);
    const sets = m.diagram.blocks.filter((b) => b.type === 'var_set');
    eq(sets.length, 1, 'migration (b): one var_set inserted');
    const sb = sets[0];
    const conns = m.diagram.connections;
    ok(conns.some((x) => x.fromBlockId === start.id && x.toBlockId === sb.id && x.toPortId === 'exec_in'), 'migration (b): start -> var_set');
    ok(conns.some((x) => x.fromBlockId === sb.id && x.fromPortId === 'exec_out' && x.toBlockId === lg.id && x.toPortId === 'exec_in'), 'migration (b): var_set -> reader');
    ok(!conns.some((x) => x.fromBlockId === start.id && x.toBlockId === lg.id), 'migration (b): original exec edge replaced');
    ok(conns.some((x) => x.fromBlockId === c.id && x.toBlockId === sb.id && x.toPortId === 'value_in'), 'migration (b): value source feeds var_set');
    eq(m.diagram.variables?.[0].type, 'number', 'migration (b): variable type derived from the decimal constant source');
    eq(codes(m.diagram), [], 'migration (b): result validates');
    await both('migration b', d, (r) => {
      eq(r.errors, [], 'migration (b): no errors');
      eq(r.lines, ['v = 42'], 'migration (b): same output as the legacy flow');
    });
  }
  {
    // (c) not provable: two readers / while reader -> block kept as data_var, flagged, run refused
    const start = blk('start', 'Start');
    const c = blk('data_const', 'C', { value: '1', format: 'dec' });
    const dv = blk('data_var', 'Ambig', { name: 'v', initial: '0' });
    const l1 = blk('log', 'R1', { message: '' });
    const l2 = blk('log', 'R2', { message: '' });
    const d = dia([start, c, dv, l1, l2], [
      wire(start, 'exec_out', l1), wire(l1, 'exec_out', l2), wire(c, 'value_out', dv, 'set_in'), wire(dv, 'get_out', l1, 'value_in'), wire(dv, 'get_out', l2, 'value_in'),
    ]);
    const m = migrateLegacyVars(d);
    eq(m.diagram.blocks.find((b) => b.id === dv.id)?.type, 'data_var', 'migration (c): ambiguous block is kept as data_var');
    const issue = validateCore(m.diagram).find((i) => i.code === 'legacy_var');
    ok(issue !== undefined && issue.blockId === dv.id, 'migration (c): validation error points at the block');
    ok(m.notes.some((n) => n.includes('Ambig')), 'migration (c): note explains the manual action');
    for (const mode of ['sim', 'real'] as const) {
      load(m.diagram);
      const r = await run(mode);
      ok(r.errors.length > 0 && r.lines.length === 0 && status(dv.id) === 'error', `migration (c): run refused, block marked [${mode}]`);
    }
    // while reader
    const start2 = blk('start', 'Start');
    const c2 = blk('data_const', 'C2', { value: '1', format: 'dec' });
    const dv2 = blk('data_var', 'WhileVar', { name: 'w', initial: '0' });
    const wh = blk('flow_while', 'W', {});
    const d2 = dia([start2, c2, dv2, wh], [wire(start2, 'exec_out', wh), wire(c2, 'value_out', dv2, 'set_in'), wire(dv2, 'get_out', wh, 'bool_in')]);
    eq(migrateLegacyVars(d2).diagram.blocks.find((b) => b.id === dv2.id)?.type, 'data_var', 'migration (c): while reader is not migrated (per-iteration re-evaluation)');
    // persistence: variables survive the library save / load round trip (the Flow Registry replaced the old
    // localStorage diagram list, so the same guarantee is checked through the library body converters)
    load(dia([blk('start', 'S')], [], [num('keep', '9')]));
    const persisted = fromFlowBody(toFlowBody(flowStore.getSnapshot().diagram, {
      id: 'persist-test', revision: 1, description: '', createdAt: '', updatedAt: '', author: null, origin: 'user', aiReviewed: true, tags: [],
    }));
    eq(persisted.variables, [num('keep', '9')], 'variables persist with the diagram (save / load)');
  }

  // ── 11. connection compatibility (data <-> typed ports) ──────────────────────
  {
    const g = blk('var_get', 'G', { name: 'x' });
    const lg = blk('logic', 'Lg', { op: 'not' });
    const cmp = blk('data_compare', 'Cmp', { operator: 'eq' });
    const wh = blk('flow_while', 'W', {});
    load(dia([g, lg, cmp, wh], [], [num('x')]));
    ok(flowStore.addConnection({ fromBlockId: g.id, fromPortId: 'value', toBlockId: lg.id, toPortId: 'a_in' }), 'var_get (data) -> logic a_in (bool)');
    ok(flowStore.addConnection({ fromBlockId: cmp.id, fromPortId: 'result_out', toBlockId: wh.id, toPortId: 'bool_in' }), 'compare (bool) -> while bool_in');
    ok(!flowStore.addConnection({ fromBlockId: g.id, fromPortId: 'value', toBlockId: wh.id, toPortId: 'exec_in' }), 'data never connects to exec');
  }

  console.log(`flowCore.test: ${passed} checks passed`);
}

await main();
