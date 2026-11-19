/**
 * QA gate probes for flow-interface-v2 Phase 1 (independent of the implementer's `flowInterfaceV2.test.ts`).
 * Every probe reports PASS / FAIL and the run continues; the process exits non-zero when any probe failed.
 * Run: `npm run test:flowiface-qa`.
 */
import { FlowEngine } from './FlowEngine';
import { flowStore } from './FlowStore';
import { callPorts } from './callPorts';
import { migrateAll } from './flowMigrate';
import { deriveFlowInterface, validateInterface } from './flowInterface';
import { preflightBoundValues } from './boundParams';
import { FLOW_TEMPLATES } from './templates';
import { getBlockDefFor } from './blockDefs';
import { fromFlowBody, toFlowBody, type FlowMeta } from './registry/flowBody';

const QA_META: FlowMeta = { id: 'qa', revision: 1, description: '', createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T00:00:00.000Z', author: null, origin: 'user', aiReviewed: true, tags: [] };
import type { FlashBackend } from './flashRun';
import type { FlowRequestOptions, FlowTransport } from './flowTransport';
import type { FlowBlock, FlowConnection, FlowDiagram } from './types';
import type { DownloadConfigDto, FirmwareImageSummaryDto, FlashReportDto } from '../../types/flash';
import type { DiagSessionConfigDto } from '../../types/udsClient';
import type { FlowPortSpecV1 } from '../../types/flowLibrary';

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, msg: string, detail = ''): void {
  if (cond) {
    passed += 1;
    return;
  }
  failures.push(`${msg}${detail !== '' ? `\n    ${detail}` : ''}`);
}

let seq = 0;
function blk(type: string, label: string, config: Record<string, unknown> = {}, id?: string): FlowBlock {
  return { id: id ?? `q${++seq}`, type, label, x: 100, y: 100, config, status: 'idle', collapsed: false };
}
function wire(from: FlowBlock, fp: string, to: FlowBlock, tp: string): FlowConnection {
  return { id: `qc${++seq}`, fromBlockId: from.id, fromPortId: fp, toBlockId: to.id, toPortId: tp };
}
function dia(blocks: FlowBlock[], connections: FlowConnection[]): FlowDiagram {
  return { id: 'qa', name: 'qa', blocks, connections, variables: [] };
}
const spec = (key: string, type: FlowPortSpecV1['type'], extra: Partial<FlowPortSpecV1> = {}): FlowPortSpecV1 => ({ key, label: key, type, required: false, ...extra });
function load(d: FlowDiagram): void {
  flowStore.loadTemplate({
    id: 'qa', nameKey: 'flowCore.tpl.counter.name', descriptionKey: 'flowCore.tpl.counter.desc', category: 'examples', icon: '',
    diagram: { blocks: d.blocks, connections: d.connections, variables: d.variables ?? [] },
  });
}
const count = (d: FlowDiagram, type: string): number => d.blocks.filter((b) => b.type === type).length;

// ─── Transport with a controllable flash backend ───────────────────────────────

const SUMMARY: FirmwareImageSummaryDto = { segments: [{ address: 0x08004000, length: 0x100, crc32: 0xdeadbeef }], totalBytes: 0x100, crc32: 0x11223344 };
const DTO: DiagSessionConfigDto = { busId: 0, requestId: 0x7e0, responseId: 0x7e8, isExtendedId: false, functionalId: 0x7df };

class QaTransport implements FlowTransport {
  readonly demo = false;
  readonly tabId = 'tab-qa';
  sent: number[][] = [];
  downloads = 0;
  downloadFails = false;
  prepareGate: Promise<void> | null = null;
  onPrepare: (() => void) | null = null;
  readonly flash: FlashBackend;
  constructor() {
    const self = this;
    this.flash = {
      async prepare() {
        self.onPrepare?.();
        if (self.prepareGate) await self.prepareGate;
        return { handle: { imageId: 'img', fileName: 'fw.hex', format: 'intelHex', summary: SUMMARY }, dto: DTO };
      },
      async download(_d: DiagSessionConfigDto, _i: string, _c: DownloadConfigDto): Promise<FlashReportDto> {
        self.downloads += 1;
        if (self.downloadFails) throw new Error('NRC 0x72 generalProgrammingFailure');
        return { segments: [], totalBytes: 0x100, totalBlocks: 1, totalRetries: 0, durationMs: 1, throughputBytesPerSec: 1 };
      },
      async cancel() {
        // nothing
      },
    };
  }
  functionalId(): number | null {
    return 0x7df;
  }
  async setKeepalive(): Promise<void> {
    // not used
  }
  async readDid(did: number): Promise<number[]> {
    return (await this.request(0x22, [(did >> 8) & 0xff, did & 0xff])).slice(3);
  }
  async request(sid: number, data: readonly number[], _o: FlowRequestOptions = {}): Promise<number[]> {
    this.sent.push([sid, ...data]);
    if (sid === 0x27) return (data[0] & 1) === 1 ? [0x67, data[0], 1, 2, 3, 4] : [0x67, data[0]];
    if (sid === 0x31) return [0x71, data[0], data[1], data[2], 0x00];
    return [sid + 0x40, ...data];
  }
}

async function main(): Promise<void> {
  // ── P1: parent wiring survives migration of a v1 callee ───────────────────────
  {
    const fi = blk('flow_input', 'In', { inputs: [spec('a', 'number', { required: true }), spec('b', 'text')] }, 'fi');
    const lg = blk('log', 'L', { message: 'x' }, 'lg');
    const c = blk('data_const', 'C', { value: '7', format: 'dec' }, 'c');
    const fo = blk('flow_output', 'Done', { name: 'done', outcome: 'ok', outputs: [spec('x', 'number')] }, 'fo');
    const v1 = dia([fi, lg, c, fo], [wire(fi, 'start', lg, 'exec_in'), wire(lg, 'exec_out', fo, 'in'), wire(c, 'value_out', fo, 'x'), wire(fi, 'a', lg, 'value_in')]);
    const mig = migrateAll(v1).diagram;
    const ports = callPorts(deriveFlowInterface(mig)).ports;
    const ids = (dir: 'input' | 'output'): string[] => ports.filter((p) => p.direction === dir).map((p) => p.id);
    for (const [dir, id] of [['input', 'in'], ['input', 'a'], ['input', 'b'], ['output', 'done'], ['output', 'x'], ['output', 'error']] as const) {
      check(ids(dir).includes(id), `P1 call port ${dir}:${id} still exists after callee migration`, `ports=${JSON.stringify(ports.map((p) => `${p.direction}:${p.id}`))}`);
    }
    check(validateInterface(mig).length === 0, 'P1 migrated callee validates clean', JSON.stringify(validateInterface(mig)));
    check(mig.connections.some((x) => x.fromBlockId === 'fi__in_a' && x.fromPortId === 'value' && x.toBlockId === 'lg'), 'P1 internal wire a -> log re-pointed to flow_in');
  }

  // ── P2: migration idempotency ─────────────────────────────────────────────────
  {
    const fi = blk('flow_input', 'In', { inputs: [spec('a', 'number')] }, 'fi2');
    const fo = blk('flow_output', 'Done', { name: 'done', outcome: 'ok', outputs: [spec('x', 'number')] }, 'fo2');
    const base = dia([fi, fo], [wire(fi, 'start', fo, 'in')]);
    const once = migrateAll(base).diagram;
    const twice = migrateAll(once).diagram;
    check(JSON.stringify(once) === JSON.stringify(twice), 'P2a migrate(migrate(x)) === migrate(x) (plain v1)');
    check(JSON.stringify(migrateAll(base).diagram) === JSON.stringify(once), 'P2a deterministic (same input -> same output)');

    // Stray legacy `start` next to a flow_input (deviation 3)
    const fi3 = blk('flow_input', 'In', { inputs: [] }, 'fi3');
    const st3 = blk('start', 'Start', {}, 'st3');
    const r3 = blk('end', 'End', {}, 'end3');
    const stray = dia([fi3, st3, r3], [wire(fi3, 'start', r3, 'exec_in')]);
    const s1 = migrateAll(stray).diagram;
    const s2 = migrateAll(s1).diagram;
    check(count(s1, 'flow_start') === 1, 'P2b stray start: first migration -> 1 flow_start', `got ${count(s1, 'flow_start')}`);
    check(count(s2, 'flow_start') === count(s1, 'flow_start'), 'P2b stray start: second migration (save + reload) keeps the flow_start count', `first=${count(s1, 'flow_start')} second=${count(s2, 'flow_start')}`);
    check(validateInterface(s1).length === validateInterface(s2).length, 'P2b stray start: validation result stable across reload', `first=${JSON.stringify(validateInterface(s1).map((i) => i.code))} second=${JSON.stringify(validateInterface(s2).map((i) => i.code))}`);

    // Two legacy `start` blocks, no flow_input
    const a = blk('start', 'S1', {}, 'sa');
    const b = blk('start', 'S2', {}, 'sb');
    const two = dia([a, b], []);
    const t1 = migrateAll(two).diagram;
    const t2 = migrateAll(t1).diagram;
    check(JSON.stringify(t1) === JSON.stringify(t2), 'P2c two legacy starts: idempotent', `flow_start first=${count(t1, 'flow_start')} second=${count(t2, 'flow_start')}`);
  }

  // ── P3: implicit `ok` outcome vs a flow_out keyed `ok` ─────────────────────────
  {
    const st = blk('flow_start', 'S');
    const out = blk('flow_out', 'ok', { ...spec('ok', 'number') });
    const d = dia([st, out], []);
    const issues = validateInterface(d);
    const conflicts = callPorts(deriveFlowInterface(d)).conflicts;
    check(issues.some((i) => i.code === 'output_reserved') || conflicts.length === 0, 'P3 flow_out key colliding with the implicit `ok` outcome is caught by validateInterface (callPorts reports a clash)', `iface issues=${JSON.stringify(issues.map((i) => i.code))} callPorts conflicts=${conflicts.length}`);
  }

  // ── P4: sorting by (order, key) ───────────────────────────────────────────────
  {
    const st = blk('flow_start', 'S');
    const ins = [blk('flow_in', 'z', { ...spec('z', 'number', { order: 1 }) }), blk('flow_in', 'b', { ...spec('b', 'number') }), blk('flow_in', 'a', { ...spec('a', 'number', { order: 1 }) }), blk('flow_in', 'm', { ...spec('m', 'number', { order: 0 }) })];
    const keys = deriveFlowInterface(dia([st, ...ins], [])).inputs.map((s) => s.key);
    check(JSON.stringify(keys) === JSON.stringify(['m', 'a', 'z', 'b']), 'P4 inputs sorted by (order, key), unordered last', JSON.stringify(keys));
    check(JSON.stringify(deriveFlowInterface(dia([st], [])).outcomes) === JSON.stringify([{ name: 'ok', outcome: 'ok' }]), 'P4 implicit ok outcome');
  }

  // ── P5: invalid bound value -> block error, ZERO frames, stored config untouched ─
  {
    const st = blk('flow_start', 'S');
    const fin = blk('flow_in', 'lvl', { ...spec('lvl', 'text', { default: 'ZZ' }) });
    const sa = blk('uds_security_access', 'SA', { access_level: '11', boundParams: ['access_level'] }, 'sa5');
    const ret = blk('flow_return', 'R', { name: 'ok', outcome: 'ok' });
    load(dia([st, fin, sa, ret], [wire(st, 'start', sa, 'exec_in'), wire(fin, 'value', sa, 'p:access_level'), wire(sa, 'success_out', ret, 'in')]));
    const tr = new QaTransport();
    const eng = new FlowEngine();
    await eng.run({ transport: tr });
    const stored = flowStore.getSnapshot().diagram.blocks.find((b) => b.id === 'sa5');
    check(tr.sent.length === 0, 'P5 invalid bound hex value: zero requests transmitted', JSON.stringify(tr.sent));
    check(eng.result?.outcome === 'error', 'P5 run ends with outcome error', JSON.stringify(eng.result));
    check(stored?.config['access_level'] === '11' && stored?.status === 'error', 'P5 stored config unchanged + block status error', JSON.stringify(stored));
  }

  // ── P5b: bound hex for a 1-byte field given 2 bytes (contract: byteLength when the field implies one) ─
  {
    const st = blk('flow_start', 'S');
    const fin = blk('flow_in', 'lvl', { ...spec('lvl', 'text', { default: '0103' }) });
    const sa = blk('uds_security_access', 'SA', { access_level: '11', boundParams: ['access_level'] }, 'sa5b');
    const ret = blk('flow_return', 'R', { name: 'ok', outcome: 'ok' });
    load(dia([st, fin, sa, ret], [wire(st, 'start', sa, 'exec_in'), wire(fin, 'value', sa, 'p:access_level'), wire(sa, 'success_out', ret, 'in')]));
    const tr = new QaTransport();
    const eng = new FlowEngine();
    await eng.run({ transport: tr });
    check(tr.sent.length === 0, 'P5b 2-byte value bound to the 1-byte access_level field is rejected before TX', `sent=${JSON.stringify(tr.sent)} result=${JSON.stringify(eng.result)}`);
  }

  // ── P8: deviation 4 — `required` ORed across outcomes changes the ok path of a migrated flow ─
  {
    const fi = blk('flow_input', 'In', { inputs: [] }, 'fi8');
    const c = blk('data_const', 'C', { value: '1', format: 'dec' }, 'c8');
    const lg = blk('uds_routine_ctrl', 'RC', { control_type: '01', routine_id: 'FF00' }, 'lg8');
    const ok8 = blk('flow_output', 'Ok', { name: 'done', outcome: 'ok', outputs: [] }, 'ok8');
    const bad8 = blk('flow_output', 'Bad', { name: 'bad', outcome: 'fail', outputs: [spec('code', 'number', { required: true })] }, 'bad8');
    // v1: the ok outcome declares NO outputs; `code` is only required on the fail outcome (source = a pure const: always present, so use a never-run exec source instead)
    const v1 = dia([fi, c, lg, ok8, bad8], [wire(fi, 'start', ok8, 'in'), wire(lg, 'exec_out', bad8, 'in'), wire(lg, 'result_out', bad8, 'code')]);
    const mig = migrateAll(v1).diagram;
    load(mig);
    const eng = new FlowEngine();
    await eng.run({ transport: new QaTransport() });
    const p8log = flowStore.getSnapshot().runLog.filter((e) => e.level === 'error').map((e) => e.message);
    check(eng.result?.outcome === 'ok', 'P8 v1 flow whose ok outcome had no outputs still ends ok after migration (real engine)', `log=${JSON.stringify(p8log)} result=${JSON.stringify(eng.result)} flow_out=${JSON.stringify(mig.blocks.filter((b) => b.type === 'flow_out').map((b) => b.config))}`);
  }

  // ── R1: idempotency matrix (gate 2) ───────────────────────────────────────────
  {
    const fixtures: Array<[string, FlowDiagram]> = [];
    {
      const fi = blk('flow_input', 'In', { inputs: [spec('a', 'number'), spec('b', 'hex')] }, 'r1fi');
      const st = blk('start', 'Stray', {}, 'r1st');
      const e1 = blk('end', 'E1', {}, 'r1e1');
      const e2 = blk('end', 'E2', {}, 'r1e2');
      const iff = blk('log', 'If', { message: 'x' }, 'r1if');
      fixtures.push(['stray start + multiple end', dia([fi, st, e1, e2, iff], [wire(fi, 'start', iff, 'exec_in'), wire(iff, 'exec_out', e1, 'exec_in'), wire(iff, 'exec_out', e2, 'exec_in'), wire(st, 'exec_out', e2, 'exec_in')])]);
    }
    {
      const st = blk('start', 'S', {}, 'r2st');
      const c1 = blk('data_const', 'C1', { value: '1', format: 'dec' }, 'r2c1');
      const c2 = blk('data_const', 'C2', { value: '2', format: 'dec' }, 'r2c2');
      const o1 = blk('flow_output', 'A', { name: 'a', outcome: 'ok', outputs: [spec('r', 'number', { required: true }), spec('t', 'text')] }, 'r2o1');
      const o2 = blk('flow_output', 'B', { name: 'b', outcome: 'fail', outputs: [spec('r', 'number'), spec('t', 'number')] }, 'r2o2');
      const o3 = blk('flow_output', 'C', { name: 'c', outcome: 'error', outputs: [spec('r', 'number')] }, 'r2o3');
      fixtures.push(['output conflicts (source + type)', dia([st, c1, c2, o1, o2, o3], [wire(st, 'exec_out', o1, 'in'), wire(c1, 'value_out', o1, 'r'), wire(c2, 'value_out', o2, 'r'), wire(c1, 'value_out', o3, 'r'), wire(c1, 'value_out', o1, 't'), wire(c1, 'value_out', o2, 't')])]);
    }
    {
      const s1 = blk('start', 'S1', {}, 'r3s1');
      const s2 = blk('start', 'S2', {}, 'r3s2');
      const e = blk('end', 'E', {}, 'r3e');
      const v = blk('data_var', 'V', { name: 'my var', initial: '3' }, 'r3v');
      fixtures.push(['two starts + data_var + end', dia([s1, s2, e, v], [wire(s1, 'exec_out', e, 'exec_in')])]);
    }
    {
      const fi1 = blk('flow_input', 'In1', { inputs: [spec('a', 'number')] }, 'r4a');
      const fi2 = blk('flow_input', 'In2', { inputs: [spec('a', 'text')] }, 'r4b');
      fixtures.push(['two flow_inputs with the same key', dia([fi1, fi2], [])]);
    }
    for (const [name, d] of fixtures) {
      const m1 = migrateAll(d).diagram;
      const m2 = migrateAll(m1).diagram;
      const m3 = migrateAll(fromFlowBody(toFlowBody(m2, QA_META))).diagram;
      check(JSON.stringify(m1) === JSON.stringify(m2), `R1 ${name}: migrate twice identical`);
      check(JSON.stringify(m1.blocks.map((b) => [b.id, b.type, b.config])) === JSON.stringify(m3.blocks.map((b) => [b.id, b.type, b.config])), `R1 ${name}: save + reload + migrate keeps blocks`);
      check(JSON.stringify(m1.connections.map((c) => [c.fromBlockId, c.fromPortId, c.toBlockId, c.toPortId]).sort()) === JSON.stringify(m3.connections.map((c) => [c.fromBlockId, c.fromPortId, c.toBlockId, c.toPortId]).sort()), `R1 ${name}: save + reload + migrate keeps wires`);
      check(JSON.stringify(migrateAll(d).diagram) === JSON.stringify(m1), `R1 ${name}: deterministic`);
    }
    // required only from ok outputs, conflict flagged on r and t
    const conf = migrateAll(fixtures[1][1]).diagram;
    const outs = Object.fromEntries(conf.blocks.filter((b) => b.type === 'flow_out').map((b) => [String(b.config['key']), b.config]));
    check(outs['r']?.['required'] === true && outs['t']?.['required'] === false, 'R1 required only from ok-outcome outputs', JSON.stringify(outs));
    check(typeof outs['r']?.['migrateConflict'] === 'string' && typeof outs['t']?.['migrateConflict'] === 'string', 'R1 source and type conflicts flagged', JSON.stringify(outs));
    const reqFail = migrateAll(dia([blk('flow_output', 'F', { name: 'f', outcome: 'fail', outputs: [spec('z', 'number', { required: true })] }, 'r5')], [])).diagram;
    check(reqFail.blocks.find((b) => b.type === 'flow_out')?.config['required'] === false, 'R1 required on a fail-only output -> not required');

    // ── R2: conflict survives save/reload and refuses the run before any TX (gate 5) ─
    const reloaded = migrateAll(fromFlowBody(toFlowBody(conf, QA_META))).diagram;
    check(validateInterface(reloaded).some((i) => i.code === 'migrate_output_conflict'), 'R2 conflict flag persists through save + reload');
    load(reloaded);
    const tr = new QaTransport();
    const eng = new FlowEngine();
    await eng.run({ transport: tr });
    check(eng.result?.refused === true && tr.sent.length === 0, 'R2 flagged flow: run refused, zero TX', `result=${JSON.stringify(eng.result)} sent=${tr.sent.length}`);
    // A plain config patch on a different block does not clear the flag
    const rBlock = reloaded.blocks.find((b) => b.type === 'flow_out' && b.config['key'] === 'r') as FlowBlock;
    const other = reloaded.blocks.find((b) => b.type === 'data_const') as FlowBlock;
    flowStore.updateBlockConfig(other.id, { value: '9' });
    check(typeof flowStore.getSnapshot().diagram.blocks.find((b) => b.id === rBlock.id)?.config['migrateConflict'] === 'string', 'R2 editing another block keeps the flag');
    flowStore.updateBlockConfig(rBlock.id, { label: 'edited' });
    check(flowStore.getSnapshot().diagram.blocks.find((b) => b.id === rBlock.id)?.config['migrateConflict'] === undefined, 'R2 editing the flow_out clears the flag');
  }

  // ── R3: preflightBoundValues on unusual graphs (gate 4) ───────────────────────
  {
    const sa = blk('uds_security_access', 'SA', { access_level: '11', boundParams: ['access_level', 'nope'] }, 'r3sa');
    const fl = blk('uds_flash_image', 'FL', { boundParams: ['file', 'base_address'] }, 'r3fl');
    const ghost: FlowConnection = { id: 'gx', fromBlockId: 'missing', fromPortId: 'value', toBlockId: 'r3fl', toPortId: 'p:file' };
    const p1 = blk('data_byte_builder', 'BB', {}, 'r3p1');
    const p2 = blk('data_byte_builder', 'BB2', {}, 'r3p2');
    const cyc = [wire(p1, 'bytes_out', p2, 'value_in'), wire(p2, 'bytes_out', p1, 'value_in'), wire(p1, 'bytes_out', fl, 'p:base_address')];
    const weird = blk('flow_out', 'W', { boundParams: 'not-an-array' }, 'r3w');
    const badConst = blk('data_const', 'BC', { value: 'ZZ', format: 'hex' }, 'r3bc');
    const sa2 = blk('uds_security_access', 'SA2', { access_level: '11', boundParams: ['access_level'] }, 'r3sa2');
    const d = dia([sa, fl, p1, p2, weird, badConst, sa2], [ghost, ...cyc, wire(badConst, 'value_out', sa2, 'p:access_level')]);
    let threw = '';
    let issues: Array<{ blockId: string; message: string }> = [];
    const reads: string[] = [];
    try {
      issues = await preflightBoundValues(d, async (b, port) => {
        reads.push(`${b.id}.${port}`);
        if (b.id === 'r3sa2') throw new Error('bad const');
        return undefined;
      });
    } catch (e) {
      threw = String(e);
    }
    check(threw === '', 'R3 preflightBoundValues does not throw on unconnected / ghost source / cycle / malformed boundParams / throwing read', threw);
    check(reads.length === 1 && reads[0] === 'r3sa2.p:access_level', 'R3 only direct flow_in / data_const sources are read (no cycle or exec-source evaluation)', JSON.stringify(reads));
    check(issues.length === 0, 'R3 a throwing constant read is deferred to execution (no issue)', JSON.stringify(issues));
    // Engine path: a bad bound value from a flow_in behind a TX block is refused before the first TX
    const st = blk('flow_start', 'S');
    const sess = blk('uds_session', 'Sess', {}, 'r3sess');
    const fin = blk('flow_in', 'base', { ...spec('base', 'text', { default: 'XYZ' }) });
    const fl2 = blk('uds_flash_image', 'FL2', { format: 'auto', base_address: '00000000', boundParams: ['base_address'] }, 'r3fl2');
    load(dia([st, sess, fin, fl2], [wire(st, 'start', sess, 'exec_in'), wire(sess, 'exec_out', fl2, 'exec_in'), wire(fin, 'value', fl2, 'p:base_address')]));
    const tr = new QaTransport();
    const eng = new FlowEngine();
    await eng.run({ transport: tr });
    check(tr.sent.length === 0 && eng.result?.refused === true, 'R3 invalid bound flow_in value behind a session TX block -> refused, zero TX', `sent=${JSON.stringify(tr.sent)} result=${JSON.stringify(eng.result)}`);
  }

  // ── S1: softInput change — flow_out absent, but need() / optional / bound p: still fail loudly (gate 3.2) ─
  {
    const mk = (consumer: 'flow_out' | 'log' | 'bound' | 'pure'): { d: FlowDiagram; tr: QaTransport } => {
      const st = blk('flow_start', 'S');
      const fin = blk('flow_in', 'firmware', { ...spec('firmware', 'file', { required: true }) });
      const fl = blk('uds_flash_image', 'Flash', { format: 'auto', base_address: '00000000', boundParams: ['file'] }, `s1fl_${consumer}`);
      const failRet = blk('flow_return', 'BF', { name: 'bootloader_fail', outcome: 'fail' });
      const okRet = blk('flow_return', 'OK', { name: 'ok', outcome: 'ok' });
      const blocks: FlowBlock[] = [st, fin, fl, failRet, okRet];
      const conns = [wire(st, 'start', fl, 'exec_in'), wire(fin, 'value', fl, 'p:file'), wire(fl, 'exec_out', okRet, 'in')];
      if (consumer === 'flow_out') {
        const out = blk('flow_out', 'crc', { ...spec('crc32', 'number') });
        blocks.push(out);
        conns.push(wire(fl, 'crc32', out, 'value'), wire(fl, 'fail_out', failRet, 'in'));
      } else if (consumer === 'pure') {
        const out = blk('flow_out', 'crc', { ...spec('crc32', 'number') });
        const fmt = blk('convert', 'T', { target: 'number', byteLength: 1, endianness: 'big' }, 's1pure');
        blocks.push(out, fmt);
        conns.push(wire(fl, 'crc32', fmt, 'value_in'), wire(fmt, 'value', out, 'value'), wire(fl, 'fail_out', failRet, 'in'));
      } else if (consumer === 'log') {
        const lg = blk('uds_write_did', 'W', { did: 'F15A' }, 's1need');
        blocks.push(lg);
        conns.push(wire(fl, 'fail_out', lg, 'exec_in'), wire(fl, 'crc32', lg, 'data_in'), wire(lg, 'exec_out', failRet, 'in'), wire(lg, 'error_out', failRet, 'in'));
      } else {
        const sa = blk('uds_security_access', 'SA', { access_level: '11', boundParams: ['access_level'] }, 's1bound');
        blocks.push(sa);
        conns.push(wire(fl, 'fail_out', sa, 'exec_in'), wire(fl, 'crc32', sa, 'p:access_level'), wire(sa, 'success_out', failRet, 'in'), wire(sa, 'error_out', failRet, 'in'));
      }
      const tr = new QaTransport();
      tr.downloadFails = true;
      return { d: dia(blocks, conns), tr };
    };
    const go = async (c: 'flow_out' | 'log' | 'bound' | 'pure'): Promise<{ eng: FlowEngine; tr: QaTransport; errs: string[] }> => {
      const { d, tr } = mk(c);
      load(d);
      const eng = new FlowEngine();
      await eng.run({ transport: tr, inputs: { firmware: { name: 'fw.hex', bytes: new Uint8Array([1]) } } });
      return { eng, tr, errs: flowStore.getSnapshot().runLog.filter((e) => e.level === 'error').map((e) => e.message) };
    };
    const a = await go('flow_out');
    check(a.eng.result?.outcome === 'fail' && a.eng.result?.name === 'bootloader_fail' && !('crc32' in (a.eng.result?.outputs ?? {})), 'S1 failed flash: flow_out(crc32) absent, outcome bootloader_fail (not unhandled error)', JSON.stringify(a.eng.result));
    const b = await go('log');
    const needBlk = flowStore.getSnapshot().diagram.blocks.find((x) => x.id === 's1need');
    check(needBlk?.status === 'error' && !b.tr.sent.some((f) => f[0] === 0x2e), 'S1 need(): data input from a ran-but-no-port source still errors loudly, no 0x2E sent', `status=${needBlk?.status} sent=${JSON.stringify(b.tr.sent)} errs=${JSON.stringify(b.errs)}`);
    const c = await go('bound');
    const bBlk = flowStore.getSnapshot().diagram.blocks.find((x) => x.id === 's1bound');
    check(bBlk?.status === 'error' && !c.tr.sent.some((f) => f[0] === 0x27), 'S1 bound p: from a ran-but-no-port source still errors loudly, no 0x27 sent', `status=${bBlk?.status} sent=${JSON.stringify(c.tr.sent)} result=${JSON.stringify(c.eng.result)}`);
    const dres = await go('pure');
    // Informational (nice-to-have, not a gate item): the absent rule only looks at the DIRECT source of a flow_out.
    console.log(`  INFO S1 flow_out behind a pure block fed by a failed flash -> outcome ${dres.eng.result?.outcome} (${dres.eng.result?.name ?? 'unhandled'})`);
  }

  // ── S2: flasher lane split (gate 3.3) — structural ────────────────────────────
  for (const id of ['ecu_flasher', 'ecu_flasher_minimal'] as const) {
    const tpl = FLOW_TEMPLATES.find((x) => x.id === id);
    if (!tpl) { check(false, `S2 ${id} exists`); continue; }
    const d = migrateAll({ id, name: id, blocks: tpl.diagram.blocks, connections: tpl.diagram.connections, variables: tpl.diagram.variables ?? [] }).diagram;
    const byId = new Map(d.blocks.map((b) => [b.id, b] as const));
    const execOuts = (b: FlowBlock): string[] => (getBlockDefFor(b)?.ports ?? []).filter((p) => p.type === 'exec' && p.direction === 'output').map((p) => p.id);
    const next = (b: FlowBlock, port: string): FlowBlock[] => {
      const out: FlowBlock[] = [];
      for (const c of d.connections) if (c.fromBlockId === b.id && c.fromPortId === port) { const t2 = byId.get(c.toBlockId); if (t2) out.push(t2); }
      return out;
    };
    const succ = (b: FlowBlock): FlowBlock[] => {
      if (b.type === 'flow_goto') { const t2 = byId.get(String(b.config['target_terminal_id'])); return t2 ? [t2] : []; }
      return execOuts(b).flatMap((p) => next(b, p));
    };
    const reach = (from: FlowBlock[]): Set<FlowBlock> => {
      const seen = new Set<FlowBlock>(); const st2 = [...from];
      while (st2.length) { const x = st2.pop() as FlowBlock; if (seen.has(x)) continue; seen.add(x); st2.push(...succ(x)); }
      return seen;
    };
    const returnsOf = (set: Set<FlowBlock>): string[] => [...new Set([...set].filter((b) => b.type === 'flow_return').map((b) => String(b.config['name'])))].sort();
    // dangling exec outputs
    const dangling: string[] = [];
    for (const b of d.blocks) for (const p of execOuts(b)) if (b.type !== 'flow_terminal' && next(b, p).length === 0 && !(b.type === 'log' && p === 'exec_out' && false)) dangling.push(`${b.label}.${p}`);
    check(dangling.length === 0, `S2 ${id}: no dangling exec outputs`, JSON.stringify(dangling));
    // boundary = first erase routine (FF00) or flash block on the main path
    const isBoundary = (b: FlowBlock): boolean => b.type === 'uds_flash_image' || (b.type === 'uds_routine_ctrl' && String(b.config['routine_id']).toUpperCase() === 'FF00');
    const start = d.blocks.find((b) => b.type === 'flow_start') as FlowBlock;
    // main path = success ports only
    const successPorts = new Set(['start', 'exec_out', 'success_out', 'true_out', 'false_out']);
    const pre = new Set<FlowBlock>(); const post = new Set<FlowBlock>();
    const walk = (b: FlowBlock, after: boolean, seen: Set<string>): void => {
      const key = `${b.id}|${after}`; if (seen.has(key)) return; seen.add(key);
      if (b.type === 'flow_goto' || b.type === 'flow_return') return;
      const now = after || isBoundary(b);
      (now ? post : pre).add(b);
      for (const p of execOuts(b)) if (successPorts.has(p)) for (const n of next(b, p)) walk(n, now, seen);
    };
    walk(start, false, new Set());
    const bad: string[] = [];
    for (const [set, want] of [[pre, ['safe_abort']], [post, ['bootloader_fail', 'post_warning']]] as const) {
      for (const b of set) for (const p of execOuts(b)) {
        if (successPorts.has(p)) continue;
        const rs = returnsOf(reach(next(b, p)));
        if (rs.length === 0 || rs.some((r) => !(want as readonly string[]).includes(r))) bad.push(`${set === pre ? 'pre' : 'post'} ${b.label}.${p} -> ${JSON.stringify(rs)}`);
      }
    }
    check(bad.length === 0, `S2 ${id}: pre-erase failures -> safe_abort only, erase onward -> bootloader_fail (/post_warning)`, bad.join(' | '));
    // restore lane: everything that can reach safe_abort sends no erase / download
    const safeRet = d.blocks.find((b) => b.type === 'flow_return' && b.config['name'] === 'safe_abort') as FlowBlock;
    const laneStarts = d.blocks.filter((b) => b.type === 'flow_terminal' && reach([b]).has(safeRet));
    const lane = laneStarts.length > 0 ? reach(laneStarts) : new Set([...d.blocks].filter((b) => reach([b]).has(safeRet) && !pre.has(b)));
    const danger = [...lane].filter((b) => isBoundary(b) || b.type === 'uds_ecu_reset' || (b.type === 'uds_session' && b.config['session_type'] === 'programming'));
    check(danger.length === 0 && lane.has(safeRet), `S2 ${id}: restore lane reaches safe_abort without erase / download / reset / programming session`, JSON.stringify([...lane].map((b) => b.label)));
  }

  // ── P6: required flow_out — real engine errors only on outcome ok ──────────────
  {
    const mk = (outcome: 'ok' | 'fail'): FlowDiagram => {
      const st = blk('flow_start', 'S');
      const out = blk('flow_out', 'r', { ...spec('r', 'number', { required: true }) });
      const ret = blk('flow_return', 'R', { name: outcome === 'ok' ? 'ok' : 'nope', outcome });
      return dia([st, out, ret], [wire(st, 'start', ret, 'in')]);
    };
    for (const oc of ['ok', 'fail'] as const) {
      load(mk(oc));
      const eng = new FlowEngine();
      await eng.run({ transport: new QaTransport() });
      const want = oc === 'ok' ? 'error' : 'fail';
      check(eng.result?.outcome === want, `P6 required output missing, outcome ${oc} -> run outcome ${want}`, JSON.stringify(eng.result));
    }
  }

  // ── P7: Stop while a bound-file flash block is in prepare (image load) ────────
  {
    const st = blk('flow_start', 'S');
    const fin = blk('flow_in', 'firmware', { ...spec('firmware', 'file', { required: true, accept: ['.hex'] }) });
    const fl = blk('uds_flash_image', 'Flash', { format: 'auto', base_address: '00000000', boundParams: ['file'] }, 'fl7');
    const ret = blk('flow_return', 'R', { name: 'ok', outcome: 'ok' });
    load(dia([st, fin, fl, ret], [wire(st, 'start', fl, 'exec_in'), wire(fin, 'value', fl, 'p:file'), wire(fl, 'exec_out', ret, 'in')]));
    const tr = new QaTransport();
    let release: () => void = () => undefined;
    tr.prepareGate = new Promise<void>((r) => { release = r; });
    const eng = new FlowEngine();
    tr.onPrepare = () => {
      eng.stop();   // operator hits Stop / Panic Stop while the bound image is being loaded
      release();
    };
    await eng.run({ transport: tr, inputs: { firmware: { name: 'fw.hex', bytes: new Uint8Array([1, 2, 3]) } } });
    check(tr.downloads === 0, 'P7 Stop during bound-image prepare: NO download (0x34/0x36/0x37) after Stop', `downloads=${tr.downloads} sent=${JSON.stringify(tr.sent)} result=${JSON.stringify(eng.result)}`);
    check(eng.result?.stopped === true, 'P7 run recorded as stopped', JSON.stringify(eng.result));
  }

  console.log(`flowInterfaceV2.qa: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  if (failures.length > 0) throw new Error(`${failures.length} QA probe(s) failed`);
}

void main();
