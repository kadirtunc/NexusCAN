/**
 * Workbench v1 / Phase C1 unit tests (workbench-v1 §7), headless, no Tauri. Run: `npm run test:workbench`.
 * Covers: form generation, `{ecu.*}` resolution per ECU (+ error), incomplete bindings, update-to-latest
 * reconciliation, CRC refusal with zero TX, the `ecu_flasher` template through the dedicated engine (record outcome /
 * outputName / files / integer durationMs), Stop -> aborted, Panic Stop -> panic_stop, canvas store untouched, `fileExpect`
 * sanitizing and the in-memory run store.
 */
import {
  buildBindingForm, buildRunRecord, cellView, checkFileExpectation, crc32Hex, isBindableInterface, mapOutcome,
  reconcileBindingToRevision, resolveBindingParams,
} from './workbenchModel';
import { startWorkbenchRun, type WbRunDeps } from './workbenchRunner';
import { FLOW_TEMPLATES } from '../../flow/templates';
import { migrateAll } from '../../flow/flowMigrate';
import { deriveFlowInterface } from '../../flow/flowInterface';
import { flowStore } from '../../flow/FlowStore';
import { flowPrompt } from '../../flow/flowPrompt';
import { stopAllTxSources } from '../../../store/txSources';
import { newEcuRecord } from '../workspace/ecuDefaults';
import { sanitizeDiagnostics } from '../workspace/diagnosticsSanitize';
import { createMemoryRunStore } from '../../../services/runStoreClient';
import type { FlashBackend } from '../../flow/flashRun';
import type { FlowRequestOptions, FlowTransport } from '../../flow/flowTransport';
import type { FlowDiagram } from '../../flow/types';
import type { FlowFileValue, FlowInterfaceV1, FlowPortSpecV1 } from '../../../types/flowLibrary';
import type { FlowBindingV1, FlowRefV1 } from '../../../types/diagWorkspace';
import type { RunRecordV1 } from '../../../types/runRecord';

let failures = 0;
let checks = 0;
function ok(cond: boolean, msg: string, detail = ''): void {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.log(`  FAIL ${msg}${detail !== '' ? ` :: ${detail}` : ''}`);
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function section(name: string, fn: () => Promise<void> | void): Promise<void> {
  const before = failures;
  try {
    await fn();
  } catch (e) {
    failures += 1;
    console.log(`  THROW ${e instanceof Error ? e.stack : String(e)}`);
  }
  console.log(`${failures === before ? 'PASS' : 'FAIL'} ${name}`);
}

const spec = (key: string, type: FlowPortSpecV1['type'], extra: Partial<FlowPortSpecV1> = {}): FlowPortSpecV1 => ({ key, label: key, type, required: false, ...extra });
const iface = (inputs: FlowPortSpecV1[]): FlowInterfaceV1 => ({ inputs, outcomes: [{ name: 'ok', outcome: 'ok' }], outputs: [], requiresProtocols: ['uds_can'] });
const ECU_IN = spec('ecu', 'ecu', { required: true, order: 0 });
const bind = (params: FlowBindingV1['params'], over: Partial<FlowBindingV1> = {}): FlowBindingV1 =>
  ({ id: 'b', ecuId: 'e', flowRef: { flowId: 'f', revision: 1 }, label: null, params, order: 0, ...over });
const ecuWith = (name: string, start: number, extra: Parameters<typeof newEcuRecord>[0] = {}): ReturnType<typeof newEcuRecord> =>
  newEcuRecord({ name, flash: { memoryRegions: [{ key: 'app', label: 'App', start, length: 0x1000 }], maxBlockLenOverride: 4096 }, ...extra });

// ─── Fake transport (counts every TX-capable call) ────────────────────────────

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
class FakeTransport implements FlowTransport {
  readonly demo = false;
  readonly tabId = 'tab-wb';
  calls: string[] = [];
  flashed = false;
  delayMs = 0;
  readonly flash: FlashBackend;
  constructor() {
    this.flash = {
      prepare: async () => {
        this.calls.push('PREPARE');
        return {
          handle: { imageId: 'i', fileName: 'fw.hex', format: 'intelHex', summary: { segments: [{ address: 0x08004000, length: 0x1c000, crc32: 1 }], totalBytes: 0x1c000, crc32: 2 } },
          dto: { busId: 0, requestId: 0x7e0, responseId: 0x7e8, isExtendedId: false, functionalId: 0x7df },
        };
      },
      download: async () => {
        this.calls.push('DOWNLOAD');
        this.flashed = true;
        return { segments: [], totalBytes: 0x1c000, totalBlocks: 1, totalRetries: 0, durationMs: 1, throughputBytesPerSec: 1 };
      },
      cancel: async () => undefined,
    };
  }
  functionalId(): number | null { return 0x7df; }
  async setKeepalive(on: boolean): Promise<void> { this.calls.push(on ? 'KA START' : 'KA STOP'); }
  async readDid(did: number): Promise<number[]> { return (await this.request(0x22, [(did >> 8) & 0xff, did & 0xff])).slice(3); }
  async request(sid: number, data: readonly number[], o: FlowRequestOptions = {}): Promise<number[]> {
    this.calls.push([sid, ...data].map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' '));
    if (this.delayMs > 0) await sleep(this.delayMs);
    if (o.suppressed) return [];
    switch (sid) {
      case 0x10: return [0x50, data[0], 0, 0x32, 1, 0xf4];
      case 0x11: return [0x51, data[0]];
      case 0x14: return [0x54];
      case 0x22: {
        const did = (data[0] << 8) | data[1];
        const rec: Record<number, number[]> = { 0xf190: ascii('WVWZZZ1KZAW000001'), 0xf187: ascii('5Q0906259'), 0xf189: ascii(this.flashed ? 'SW0200' : 'SW0100'), 0xf191: ascii('HW01'), 0xf186: [2] };
        const r = rec[did];
        if (!r) throw new Error('NRC 0x31 (requestOutOfRange)');
        return [0x62, data[0], data[1], ...r];
      }
      case 0x27: return (data[0] & 1) === 1 ? [0x67, data[0], 0x12, 0x34, 0x56, 0x78] : [0x67, data[0]];
      case 0x28: return [0x68, data[0]];
      case 0x2e: return [0x6e, data[0], data[1]];
      case 0x31: return [0x71, data[0], data[1], data[2], 0];
      case 0x3e: return [0x7e, data[0]];
      case 0x85: return [0xc5, data[0]];
      default: throw new Error(`unexpected SID ${sid}`);
    }
  }
}
let autoAnswer = true;
flowPrompt.subscribe(() => {
  if (autoAnswer && flowPrompt.getSnapshot() !== null) setTimeout(() => flowPrompt.answer('OK'), 0);
});

function flasherBody(): FlowDiagram {
  const tpl = FLOW_TEMPLATES.find((x) => x.id === 'ecu_flasher');
  if (!tpl) throw new Error('ecu_flasher template missing');
  return migrateAll({
    id: 'ecu_flasher', name: 'Flash ECU',
    blocks: tpl.diagram.blocks.map((b) => ({ ...b, config: { ...b.config } })),
    connections: tpl.diagram.connections.map((c) => ({ ...c })),
    variables: (tpl.diagram.variables ?? []).map((v) => ({ ...v })),
  }).diagram;
}
const FW = Uint8Array.from(Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff));
const FW_CRC = crc32Hex(FW);
const FIRMWARE: FlowFileValue = { name: 'fw.hex', bytes: FW };
const REF: FlowRefV1 = { flowId: 'ecu_flasher', revision: 3 };
const ECU = ecuWith('Engine1', 0x08004000);
const flasherBinding = (over: Partial<FlowBindingV1> = {}): FlowBindingV1 => ({
  id: 'bf', ecuId: ECU.id, flowRef: REF, label: null, params: { baseAddr: '{ecu.flash.regions.app.start}' }, order: 0,
  fileExpect: { firmware: { fileName: 'fw.hex', crc32: FW_CRC } }, ...over,
});

function makeDeps(tr: FlowTransport | null, over: Partial<WbRunDeps> = {}): { deps: WbRunDeps; appended: RunRecordV1[]; reviews: number } {
  const spy = { deps: undefined as unknown as WbRunDeps, appended: [] as RunRecordV1[], reviews: 0 };
  let clock = 1_700_000_000_000.5;
  let n = 0;
  const body = flasherBody();
  spy.deps = {
    loadRevision: async (r) => (r.flowId === REF.flowId && r.revision === REF.revision ? { body, iface: deriveFlowInterface(body), name: 'Flash ECU', contentHash: 'cd'.repeat(32) } : null),
    loadCallee: () => null,
    transportFor: () => tr,
    isRunActive: () => false,
    confirmReview: async () => { spy.reviews += 1; return true; },
    appendRecord: async (rec) => { spy.appended.push(rec); },
    now: () => (clock += 2.71),
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    deviceId: 'dev', appVersion: '0.0.0-test', projectId: '11111111-1111-4111-8111-111111111111', vehicleId: 'veh',
    ...over,
  };
  return spy;
}

async function main(): Promise<void> {
  await section('binding form generation', () => {
    const f = buildBindingForm(iface([
      ECU_IN, spec('v', 'number', { order: 1, required: true, unit: 'V', min: 9, max: 16 }), spec('m', 'select', { order: 2, options: ['a', 'b'] }),
      spec('fw', 'file', { order: 3, accept: ['.hex'] }),
    ]));
    ok(f.map((x) => x.key).join() === 'v,m,fw', 'ecu excluded, order kept');
    ok(f[0].unit === 'V' && f[0].min === 9 && f[0].max === 16 && f[0].required, 'number metadata');
    ok(f[1].options?.length === 2 && f[2].kind === 'file' && f[2].accept?.[0] === '.hex', 'select options / file accept');
    ok(isBindableInterface(iface([ECU_IN])) && !isBindableInterface(iface([])), 'bindable = has ecu input');
  });

  await section('{ecu.*} resolution per ECU, error, incomplete', () => {
    const ifc = iface([ECU_IN, spec('baseAddr', 'hex', { order: 1, byteLength: 4 }), spec('n', 'number', { order: 2, required: true, min: 0, max: 10 })]);
    const a = ecuWith('A', 0x08004000);
    const b = ecuWith('B', 0x10000);
    const bnd = bind({ baseAddr: '{ecu.flash.regions.app.start}', n: 3 });
    const ra = resolveBindingParams(bnd, ifc, a);
    const rb = resolveBindingParams(bnd, ifc, b);
    ok(ra.status === 'ready' && ra.params.baseAddr === '08004000' && ra.notes.length === 0, 'ECU A value + empty notes', JSON.stringify(ra));
    ok(rb.status === 'ready' && rb.params.baseAddr === '00010000', 'ECU B value');
    const rc = resolveBindingParams(bnd, ifc, newEcuRecord({ name: 'C' }));
    ok(rc.status === 'invalid' && rc.issues.some((i) => i.code === 'ecu_ref'), 'region missing -> invalid ecu_ref');
    ok(resolveBindingParams(bind({ baseAddr: '08004000' }), ifc, a).status === 'incomplete', 'required n missing -> incomplete');
    const g = resolveBindingParams(bind({ n: 3, ghost: 1 }), ifc, a);
    ok(g.status === 'ready' && g.notes.some((x) => x.code === 'unknown_key') && !('ghost' in g.params), 'unknown key -> note, not param');
    ok(resolveBindingParams(bind({ n: 11 }), ifc, a).status === 'invalid', 'range never clamped');
  });

  await section('update-to-latest reconciliation', () => {
    const next = iface([ECU_IN, spec('a', 'number', { order: 1 }), spec('c', 'number', { order: 2, required: true })]);
    const b0 = bind({ a: 1, b: 'x' }, { fileExpect: { fw: { fileName: 'x', crc32: 'CBF43926' } } });
    const r = reconcileBindingToRevision(b0, next, 2);
    ok(r.dropped.join() === 'b,fw' && r.newlyMissing.join() === 'c', 'dropped (params + fileExpect) / newlyMissing', JSON.stringify(r));
    ok(r.binding.flowRef.revision === 2 && r.binding.fileExpect === undefined && b0.params['b'] === 'x', 'new revision, input untouched');
  });

  await section('CRC mismatch refuses with zero TX', async () => {
    const tr = new FakeTransport();
    const spy = makeDeps(tr);
    const bad: FlowFileValue = { name: 'fw.hex', bytes: Uint8Array.from([1, 2, 3]) };
    const r = await startWorkbenchRun(flasherBinding(), ECU, { firmware: bad }, spy.deps).done;
    ok(r.kind === 'refused' && r.refusal.code === 'crc_mismatch', 'refused crc_mismatch');
    await sleep(20);
    ok(tr.calls.length === 0 && spy.appended.length === 0 && spy.reviews === 0, 'zero TX, no record, no review');
    ok(!checkFileExpectation(flasherBinding(), 'firmware', bad).ok, 'checkFileExpectation mismatch');
  });

  await section('ecu_flasher via dedicated engine -> record', async () => {
    const tr = new FakeTransport();
    const spy = makeDeps(tr);
    const r = await startWorkbenchRun(flasherBinding(), ECU, { firmware: FIRMWARE }, spy.deps).done;
    ok(r.kind === 'ran', 'ran', JSON.stringify(r).slice(0, 200));
    if (r.kind !== 'ran') return;
    const rec = r.record;
    ok(rec.outcome === 'ok' && rec.outputName === 'ok', 'outcome / outputName');
    ok(rec.files.length === 1 && rec.files[0].crc32 === FW_CRC && rec.files[0].name === 'fw.hex' && rec.files[0].size === FW.length, 'files ref');
    ok(Number.isInteger(rec.durationMs) && rec.durationMs >= 0, 'durationMs integer');
    ok(rec.params.baseAddr === '08004000' && rec.operator === null && rec.flowRevision === 3, 'resolved params, operator null, pinned revision');
    ok(spy.reviews === 1 && spy.appended.length === 1 && tr.calls.includes('DOWNLOAD'), 'review once, appended once, downloaded');
    const store = createMemoryRunStore();
    await store.append(rec);
    ok((await store.latest(rec.projectId)).length === 1, 'memory run store round trip');
    ok(cellView(rec).chip === 'ok', 'cell chip ok');
  });

  await section('Stop -> aborted, Panic Stop -> panic_stop, canvas untouched', async () => {
    const tpl = FLOW_TEMPLATES.find((x) => x.id === 'ex_counter');
    if (tpl) flowStore.loadTemplate(tpl);
    const snap = flowStore.getSnapshot();
    {
      const tr = new FakeTransport();
      tr.delayMs = 30;
      const spy = makeDeps(tr);
      const h = startWorkbenchRun(flasherBinding(), ECU, { firmware: FIRMWARE }, spy.deps);
      for (let i = 0; i < 400 && !tr.calls.includes('KA START'); i++) await sleep(5);
      await sleep(40);
      h.stop();
      const r = await h.done;
      ok(r.kind === 'ran' && r.record.outcome === 'aborted', 'Stop -> aborted', JSON.stringify(r).slice(0, 160));
      ok(!tr.calls.includes('DOWNLOAD'), 'no download after Stop');
    }
    {
      const tr = new FakeTransport();
      tr.delayMs = 30;
      const spy = makeDeps(tr);
      const h = startWorkbenchRun(flasherBinding(), ECU, { firmware: FIRMWARE }, spy.deps);
      for (let i = 0; i < 400 && !tr.calls.includes('KA START'); i++) await sleep(5);
      stopAllTxSources();
      const r = await h.done;
      ok(r.kind === 'ran' && r.record.outcome === 'panic_stop', 'Panic -> panic_stop', JSON.stringify(r).slice(0, 160));
    }
    ok(flowStore.getSnapshot() === snap, 'flowStore snapshot reference unchanged');
    ok(mapOutcome({ outcome: 'error', stopped: true }, null) === 'aborted', 'mapOutcome stopped/null');
  });

  await section('operator prompt is observable and answered from outside the editor; Stop clears it', async () => {
    autoAnswer = false;
    try {
      {
        const tr = new FakeTransport();
        const spy = makeDeps(tr);
        let done = false;
        const h = startWorkbenchRun(flasherBinding(), ECU, { firmware: FIRMWARE }, spy.deps);
        void h.done.then(() => { done = true; });
        for (let i = 0; i < 400 && flowPrompt.getSnapshot() === null; i++) await sleep(5);
        ok(flowPrompt.getSnapshot() !== null, 'prompt state observable (host-visible)');
        await sleep(40);
        ok(!done && tr.calls.length === 0, 'run waits at the prompt, nothing transmitted yet');
        flowPrompt.answer('OK');
        const r = await h.done;
        ok(r.kind === 'ran' && r.record.outcome === 'ok', 'run completes after the external answer', JSON.stringify(r).slice(0, 160));
      }
      {
        const tr = new FakeTransport();
        const h = startWorkbenchRun(flasherBinding(), ECU, { firmware: FIRMWARE }, makeDeps(tr).deps);
        for (let i = 0; i < 400 && flowPrompt.getSnapshot() === null; i++) await sleep(5);
        h.stop();
        const r = await h.done;
        ok(r.kind === 'ran' && r.record.outcome === 'aborted' && flowPrompt.getSnapshot() === null, 'Stop at the prompt -> aborted, prompt cleared');
        ok(!tr.calls.includes('DOWNLOAD'), 'no download');
      }
    } finally {
      autoAnswer = true;
    }
  });

  await section('buildRunRecord + fileExpect sanitizer', () => {
    const rec = buildRunRecord({
      runId: 'r', projectId: 'p', vehicleId: null, ecu: ECU, flowId: 'f', flowRevision: 1, flowContentHash: 'h', flowName: 'F', params: {}, files: [],
      startedAtMs: 1000, endedAtMs: 1010.6, result: { outcome: 'ok', name: 'ok', outputs: { raw: Uint8Array.from([1, 0xab]) }, stopped: false, refused: false },
      stopKind: null, log: [], deviceId: 'd', appVersion: 'v', ecuSnapshotHash: 'x',
    });
    ok(rec.durationMs === 11 && rec.outputs['raw'] === '01AB', 'duration rounded, bytes -> hex');
    const raw = {
      schemaVersion: 1, activeVehicleId: 'v1',
      vehicles: [{ id: 'v1', name: 'V', notes: '', groups: [], ecus: [{ ...ECU }], revision: 1, createdAt: '', updatedAt: '',
        bindings: [
          { id: 'b1', ecuId: ECU.id, flowRef: { flowId: 'f', revision: 1 }, label: null, params: {}, order: 0, fileExpect: { a: { fileName: 'x.hex', crc32: 'cbf43926' }, bad: { fileName: 'y', crc32: 'ZZ' } } },
          { id: 'b2', ecuId: ECU.id, flowRef: { flowId: 'g', revision: 1 }, label: null, params: {}, order: 1 },
        ] }],
    };
    const s = sanitizeDiagnostics(raw);
    const b = s.value.vehicles[0]?.bindings ?? [];
    ok(b[0]?.fileExpect?.['a']?.crc32 === 'CBF43926' && b[0]?.fileExpect?.['bad'] === undefined, 'valid kept (upper-cased), malformed dropped');
    ok(s.problems.some((p) => p.includes('fileExpect.bad')), 'visible note for the dropped entry');
    ok(b[1] !== undefined && b[1].fileExpect === undefined, 'old binding loads unchanged');
  });

  console.log(`\nworkbench: ${checks - failures}/${checks} checks`);
  if (failures > 0) {
    const proc = (globalThis as { process?: { exitCode?: number } }).process;
    if (proc) proc.exitCode = 1;
  }
}

await main();
