/**
 * QA gate probes for Workbench v1 / Phase C1 (planning/contracts/workbench-v1.md §4, §5, §7, §9).
 * Written BEFORE the implementation, against the FROZEN §9 API only; independent of the implementer's
 * `workbench.test.ts`. Every probe reports PASS / FAIL and the run continues; the process exits non-zero
 * when any probe failed (or hung past its time budget).
 * Run: `npm run test:workbench-qa`.
 */
import {
  buildBindingForm,
  buildRunRecord,
  cellView,
  checkFileExpectation,
  crc32Hex,
  isBindableInterface,
  mapOutcome,
  reconcileBindingToRevision,
  resolveBindingParams,
  reviewItems,
  type WbFormField,
  type WbRecordInput,
  type WbReviewItem,
} from './workbenchModel';
import { startWorkbenchRun, type WbRunDeps, type WbRunResult } from './workbenchRunner';
import { FlowEngine, type FlowRunResult } from '../../flow/FlowEngine';
import { flowStore } from '../../flow/FlowStore';
import { FLOW_TEMPLATES } from '../../flow/templates';
import { migrateAll } from '../../flow/flowMigrate';
import { deriveFlowInterface } from '../../flow/flowInterface';
import { flowPrompt } from '../../flow/flowPrompt';
import { listTxSourceIds, stopAllTxSources } from '../../../store/txSources';
import { newEcuRecord, type EcuRecordInit } from '../workspace/ecuDefaults';
import { ecuSnapshotHash as refEcuSnapshotHash } from '../workspace/ecuRefs';
import type { FlashBackend } from '../../flow/flashRun';
import type { FlowRequestOptions, FlowTransport } from '../../flow/flowTransport';
import type { FlowBlock, FlowConnection, FlowDiagram } from '../../flow/types';
import type { DownloadConfigDto, FirmwareImageSummaryDto, FlashReportDto } from '../../../types/flash';
import type { DiagSessionConfigDto } from '../../../types/udsClient';
import type { FlowFileValue, FlowInterfaceV1, FlowPortSpecV1 } from '../../../types/flowLibrary';
import type { EcuRecordV1, FileExpectV1, FlowBindingV1, FlowRefV1 } from '../../../types/diagWorkspace';
import type { RunFileRefV1, RunRecordV1 } from '../../../types/runRecord';

// ─── Probe harness ─────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 15_000;
let currentProbe = '';
const probeFailures = new Map<string, string[]>();
let totalChecks = 0;
let hung = false;

function check(cond: boolean, msg: string, detail = ''): void {
  totalChecks += 1;
  if (cond) return;
  const list = probeFailures.get(currentProbe) ?? [];
  list.push(`${msg}${detail !== '' ? `\n      ${detail}` : ''}`);
  probeFailures.set(currentProbe, list);
}
function eqv(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, msg, `expected: ${e}\n      actual:   ${a}`);
}
const results: Array<{ name: string; ok: boolean }> = [];

async function probe(name: string, fn: () => Promise<void> | void): Promise<void> {
  currentProbe = name;
  probeFailures.set(name, []);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => {
          hung = true;
          rej(new Error(`probe exceeded ${PROBE_TIMEOUT_MS} ms (hung run / unresolved done promise)`));
        }, PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    check(false, 'probe threw', e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
  } finally {
    if (timer) clearTimeout(timer);
  }
  const f = probeFailures.get(name) ?? [];
  results.push({ name, ok: f.length === 0 });
  if (f.length === 0) console.log(`PASS ${name}`);
  else console.log(`FAIL ${name}\n${f.map((x) => `    - ${x}`).join('\n')}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, label: string, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`waitFor timed out: ${label}`);
    await sleep(5);
  }
}
const isRunValue = (v: unknown): boolean => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).toUpperCase().padStart(2, '0')).join('');

/** Independent IEEE CRC-32 oracle (does not use flowAlgos / crc32Hex). */
function oracleCrc32(bytes: Uint8Array): string {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ((c ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const spec = (key: string, type: FlowPortSpecV1['type'], extra: Partial<FlowPortSpecV1> = {}): FlowPortSpecV1 =>
  ({ key, label: `L_${key}`, type, required: false, ...extra });
const iface = (inputs: FlowPortSpecV1[]): FlowInterfaceV1 =>
  ({ inputs, outcomes: [{ name: 'ok', outcome: 'ok' }], outputs: [], requiresProtocols: ['uds_can'] });
const ECU_IN = spec('ecu', 'ecu', { required: true, order: 0 });

function binding(params: FlowBindingV1['params'], fileExpect?: Record<string, FileExpectV1>, flowRef: FlowRefV1 = { flowId: 'f', revision: 2 }): FlowBindingV1 {
  return { id: 'b1', ecuId: 'e1', flowRef, label: null, params, order: 0, ...(fileExpect ? { fileExpect } : {}) };
}

function ecuWithRegion(name: string, start: number, extra: EcuRecordInit = {}): EcuRecordV1 {
  return newEcuRecord({
    name,
    flash: { memoryRegions: [{ key: 'app', label: 'App', start, length: 0x1000 }], maxBlockLenOverride: 4096 },
    ...extra,
  });
}

/** Distinctive firmware bytes: their hex must never appear in a run record. */
const FW_BYTES = Uint8Array.from([
  0xc0, 0xff, 0xee, 0x5a, 0xa5, 0x13, 0x37, 0xbe, 0xef, 0xfa, 0xce, 0xb0, 0x0c, 0x71, 0x9e, 0x42,
  0xd1, 0x5c, 0x0f, 0xfe, 0xe1, 0x23, 0x45, 0x67,
]);
const FIRMWARE: FlowFileValue = { name: 'fw.hex', bytes: FW_BYTES };
const FW_CRC = oracleCrc32(FW_BYTES);

// ─── Transport (scripted, counts every TX-capable call) ────────────────────────

const SUMMARY: FirmwareImageSummaryDto = {
  segments: [
    { address: 0x08004000, length: 0x0001c000, crc32: 0xdeadbeef },
    { address: 0x08020000, length: 0x00000200, crc32: 0x0a0b0c0d },
  ],
  totalBytes: 0x1c200,
  crc32: 0x11223344,
};
const DTO: DiagSessionConfigDto = { busId: 0, requestId: 0x7e0, responseId: 0x7e8, isExtendedId: false, functionalId: 0x7df };
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

class QaTransport implements FlowTransport {
  readonly demo = false;
  readonly tabId = 'tab-wb-qa';
  /** Every TX-capable call: UDS request, keep-alive toggle, flash prepare, download. */
  calls: string[] = [];
  flashed = false;
  delayMs = 0;
  prepared: Array<{ baseAddress: number; file: FlowFileValue | null }> = [];
  readonly flash: FlashBackend;
  constructor() {
    const self = this;
    this.flash = {
      async prepare(_block, settings, _tab, source) {
        self.calls.push('PREPARE');
        self.prepared.push({ baseAddress: settings.baseAddress, file: source.file });
        return { handle: { imageId: 'img-1', fileName: 'fw.hex', format: 'intelHex', summary: SUMMARY }, dto: DTO };
      },
      async download(_d: DiagSessionConfigDto, _id: string, _c: DownloadConfigDto): Promise<FlashReportDto> {
        self.calls.push('DOWNLOAD');
        self.flashed = true;
        return { segments: [], totalBytes: SUMMARY.totalBytes, totalBlocks: 30, totalRetries: 0, durationMs: 12, throughputBytesPerSec: 1000 };
      },
      async cancel() {
        // nothing in flight
      },
    };
  }
  get count(): number {
    return this.calls.length;
  }
  functionalId(): number | null {
    return 0x7df;
  }
  async setKeepalive(enabled: boolean): Promise<void> {
    this.calls.push(enabled ? 'KA START' : 'KA STOP');
  }
  async readDid(did: number): Promise<number[]> {
    return (await this.request(0x22, [(did >> 8) & 0xff, did & 0xff])).slice(3);
  }
  async request(sid: number, data: readonly number[], o: FlowRequestOptions = {}): Promise<number[]> {
    this.calls.push([sid, ...data].map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' '));
    if (this.delayMs > 0) await sleep(this.delayMs);
    if (o.suppressed) return [];
    switch (sid) {
      case 0x10: return [0x50, data[0], 0x00, 0x32, 0x01, 0xf4];
      case 0x11: return [0x51, data[0]];
      case 0x14: return [0x54];
      case 0x22: {
        const did = (data[0] << 8) | data[1];
        const rec: Record<number, number[]> = {
          0xf190: ascii('WVWZZZ1KZAW000001'),
          0xf187: ascii('5Q0906259'),
          0xf189: ascii(this.flashed ? 'SW0200' : 'SW0100'),
          0xf191: ascii('HW01'),
          0xf186: [0x02],
        };
        const r = rec[did];
        if (!r) throw new Error('NRC 0x31 (requestOutOfRange)');
        return [0x62, data[0], data[1], ...r];
      }
      case 0x27: return (data[0] & 1) === 1 ? [0x67, data[0], 0x12, 0x34, 0x56, 0x78] : [0x67, data[0]];
      case 0x28: return [0x68, data[0]];
      case 0x2e: return [0x6e, data[0], data[1]];
      case 0x31: return [0x71, data[0], data[1], data[2], 0x00];
      case 0x3e: return [0x7e, data[0]];
      case 0x85: return [0xc5, data[0]];
      default: throw new Error(`unexpected SID 0x${sid.toString(16)}`);
    }
  }
}

// The flasher template opens with an operator confirmation (`io_user_prompt`): answer it headlessly.
flowPrompt.subscribe(() => {
  if (flowPrompt.getSnapshot() !== null) setTimeout(() => flowPrompt.answer('OK'), 0);
});

// ─── Pinned `ecu_flasher` revision + runner deps ───────────────────────────────

function flasherBody(): FlowDiagram {
  const tpl = FLOW_TEMPLATES.find((x) => x.id === 'ecu_flasher');
  if (!tpl) throw new Error('ecu_flasher template missing');
  const raw: FlowDiagram = {
    id: 'ecu_flasher',
    name: 'Flash ECU',
    blocks: tpl.diagram.blocks.map((b) => ({ ...b, config: { ...b.config } })),
    connections: tpl.diagram.connections.map((c) => ({ ...c })),
    variables: (tpl.diagram.variables ?? []).map((v) => ({ ...v })),
  };
  return migrateAll(raw).diagram;
}
const FLASHER_REF: FlowRefV1 = { flowId: 'ecu_flasher', revision: 3 };
const FLASHER_HASH = 'ab'.repeat(32);

function flasherBinding(over: Partial<FlowBindingV1> = {}): FlowBindingV1 {
  return {
    id: 'bind-flash',
    ecuId: 'set-by-test',
    flowRef: FLASHER_REF,
    label: null,
    params: { baseAddr: '{ecu.flash.regions.app.start}' },
    order: 0,
    fileExpect: { firmware: { fileName: 'fw.hex', crc32: FW_CRC } },
    ...over,
  };
}

interface Spy {
  deps: WbRunDeps;
  appended: RunRecordV1[];
  reviews: Array<{ items: WbReviewItem[]; ecu: EcuRecordV1; files: RunFileRefV1[] }>;
  uuids: string[];
}
let uuidSeq = 0;
function makeDeps(tr: QaTransport | null, over: Partial<WbRunDeps> = {}, reviewAnswer: boolean | Promise<boolean> = true): Spy {
  const spy: Spy = { deps: undefined as unknown as WbRunDeps, appended: [], reviews: [], uuids: [] };
  let clock = 1_700_000_000_000.25;
  const body = flasherBody();
  spy.deps = {
    async loadRevision(ref: FlowRefV1) {
      if (ref.flowId !== FLASHER_REF.flowId || ref.revision !== FLASHER_REF.revision) return null;
      return { body, iface: deriveFlowInterface(body), name: 'Flash ECU', contentHash: FLASHER_HASH };
    },
    loadCallee: () => null,
    transportFor: () => tr,
    isRunActive: () => false,
    async confirmReview(items, ecu, files) {
      spy.reviews.push({ items, ecu, files });
      return reviewAnswer;
    },
    async appendRecord(rec) {
      spy.appended.push(rec);
    },
    // Fractional, monotonic clock: the record MUST still carry an integer durationMs.
    now: () => (clock += 3.37),
    uuid: () => {
      const u = `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`;
      spy.uuids.push(u);
      return u;
    },
    deviceId: 'qa-device',
    appVersion: '0.0.0-qa',
    projectId: '11111111-1111-4111-8111-111111111111',
    vehicleId: 'veh-qa',
    ...over,
  };
  return spy;
}

const ECU_A = ecuWithRegion('Engine1', 0x08004000);

function snapshotFlowStore(): { ref: ReturnType<typeof flowStore.getSnapshot>; json: string } {
  const s = flowStore.getSnapshot();
  return { ref: s, json: JSON.stringify({ d: s.diagram, l: s.runLog, f: s.frameStatus, r: s.isRunning, sel: s.selectedBlockIds, fp: s.framePath }) };
}
function loadCanvasMarker(): void {
  const tpl = FLOW_TEMPLATES.find((x) => x.id === 'ex_counter');
  if (!tpl) throw new Error('ex_counter template missing');
  flowStore.loadTemplate(tpl);
}

// ─── Probes ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // P1 — binding form generation
  await probe('P1 form: buildBindingForm / isBindableInterface', () => {
    const inputs: FlowPortSpecV1[] = [
      ECU_IN,
      spec('voltage', 'number', { required: true, order: 1, unit: 'V', min: 9, max: 16, default: 12 }),
      spec('mode', 'select', { order: 2, options: ['01', '03', '11'], default: '11' }),
      spec('firmware', 'file', { required: true, order: 3, accept: ['.hex', '.s19'] }),
      spec('addr', 'hex', { order: 4, byteLength: 4 }),
      spec('force', 'bool', { order: 5, default: false }),
    ];
    const f: WbFormField[] = buildBindingForm(iface(inputs));
    eqv(f.map((x) => x.key), ['voltage', 'mode', 'firmware', 'addr', 'force'], 'ecu excluded, interface order preserved');
    eqv(f.map((x) => x.kind), ['number', 'select', 'file', 'hex', 'bool'], 'field kinds (file kind present)');
    check(f.every((x, i) => i === 0 || x.order > f[i - 1].order), 'field order strictly ascending', JSON.stringify(f.map((x) => x.order)));
    const v = f.find((x) => x.key === 'voltage');
    eqv([v?.label, v?.unit, v?.min, v?.max, v?.required, v?.defaultValue], ['L_voltage', 'V', 9, 16, true, 12], 'number metadata (label/unit/min/max/required/default)');
    const m = f.find((x) => x.key === 'mode');
    eqv(m?.options?.map((o) => o.value), ['01', '03', '11'], 'select options carried as {value}');
    check((m?.options ?? []).every((o) => typeof o.label === 'string' && o.label !== ''), 'select options have a label');
    eqv(m?.defaultValue, '11', 'select default carried');
    eqv(f.find((x) => x.key === 'firmware')?.accept, ['.hex', '.s19'], 'file accept carried');
    eqv(f.find((x) => x.key === 'firmware')?.required, true, 'file required carried');
    eqv(f.find((x) => x.key === 'addr')?.byteLength, 4, 'hex byteLength carried');
    check(!f.some((x) => x.key === 'ecu'), 'no field for the ecu input');
    check(isBindableInterface(iface(inputs)) === true, 'interface with an ecu input is bindable');
    check(isBindableInterface(iface(inputs.slice(1))) === false, 'interface without an ecu input is NOT bindable');
    check(isBindableInterface(iface([])) === false, 'empty interface is NOT bindable');
    // Shuffled array with explicit orders: the form must follow `order`, not array position.
    const shuffled = [inputs[3], inputs[0], inputs[5], inputs[1], inputs[4], inputs[2]];
    eqv(buildBindingForm(iface(shuffled)).map((x) => x.key), ['voltage', 'mode', 'firmware', 'addr', 'force'], 'form sorted by (order, key) even if interface array is shuffled');
  });

  // P2 — {ecu.*} resolution per ECU
  await probe('P2 {ecu.*} resolution per ECU + errors', () => {
    const ifc = iface([
      ECU_IN,
      spec('baseAddr', 'hex', { order: 1, byteLength: 4 }),
      spec('count', 'number', { order: 2, min: 0, max: 10 }),
      spec('note', 'text', { order: 3 }),
    ]);
    const a = ecuWithRegion('EcuA', 0x08004000);
    const b = ecuWithRegion('EcuB', 0x00010000);
    const bnd = binding({ baseAddr: '{ecu.flash.regions.app.start}' });
    const ra = resolveBindingParams(bnd, ifc, a);
    const rb = resolveBindingParams(bnd, ifc, b);
    check(ra.status === 'ready' && rb.status === 'ready', 'valid ref resolves for both ECUs', JSON.stringify([ra, rb]));
    if (ra.status === 'ready' && rb.status === 'ready') {
      eqv([ra.params.baseAddr, rb.params.baseAddr], ['08004000', '00010000'], 'same binding -> per-ECU values');
    }
    // ECU without the region: per-row error, other row unaffected.
    const c = newEcuRecord({ name: 'EcuC' });
    const rc = resolveBindingParams(bnd, ifc, c);
    check(rc.status === 'invalid' && rc.issues.some((i) => i.key === 'baseAddr' && i.code === 'ecu_ref'), 'ECU lacking the region -> invalid ecu_ref', JSON.stringify(rc));
    // Unknown path (not in the closed list).
    const ru = resolveBindingParams(binding({ baseAddr: '{ecu.bogus.path}' }), ifc, a);
    check(ru.status === 'invalid' && ru.issues.some((i) => i.key === 'baseAddr' && i.code === 'ecu_ref'), 'unknown path -> invalid ecu_ref', JSON.stringify(ru));
    check(ru.status !== 'invalid' || ru.issues.every((i) => typeof i.message === 'string' && i.message !== ''), 'issues carry a message');
    // A ref embedded in other text is literal text (only an exact whole `{ecu.x}` is a reference).
    const rt = resolveBindingParams(binding({ note: 'ECU {ecu.name} flashed' }), ifc, a);
    check(rt.status === 'ready' && rt.params.note === 'ECU {ecu.name} flashed', 'embedded ref in text stays literal', JSON.stringify(rt));
    const rt2 = resolveBindingParams(binding({ note: ' {ecu.name}' }), ifc, a);
    check(rt2.status === 'ready' && rt2.params.note === ' {ecu.name}', 'ref with leading space is NOT a whole ref (literal)', JSON.stringify(rt2));
    const rn = resolveBindingParams(binding({ count: '{ecu.flash.maxBlockLen} x' }), ifc, a);
    check(rn.status === 'invalid' && rn.issues.some((i) => i.key === 'count' && (i.code === 'type' || i.code === 'ecu_ref')), 'embedded ref into a number input -> invalid', JSON.stringify(rn));
    // Literal range / type.
    const rr = resolveBindingParams(binding({ count: 11 }), ifc, a);
    check(rr.status === 'invalid' && rr.issues.some((i) => i.key === 'count' && i.code === 'range'), 'number literal > max -> invalid range', JSON.stringify(rr));
    const rr2 = resolveBindingParams(binding({ count: -1 }), ifc, a);
    check(rr2.status === 'invalid' && rr2.issues.some((i) => i.key === 'count' && i.code === 'range'), 'number literal < min -> invalid range (never clamped)', JSON.stringify(rr2));
    const rok = resolveBindingParams(binding({ count: 10 }), ifc, a);
    check(rok.status === 'ready' && rok.params.count === 10, 'number literal == max is inclusive', JSON.stringify(rok));
    const rtp = resolveBindingParams(binding({ count: 'abc' }), ifc, a);
    check(rtp.status === 'invalid' && rtp.issues.some((i) => i.key === 'count' && i.code === 'type'), 'non-numeric literal for number -> invalid type', JSON.stringify(rtp));
    // A whole ref into a number input is range-checked AFTER resolution (maxBlockLen 4096 > max 10).
    const rref = resolveBindingParams(binding({ count: '{ecu.flash.maxBlockLen}' }), ifc, a);
    check(rref.status === 'invalid' && rref.issues.some((i) => i.key === 'count' && i.code === 'range'), '§10.1 resolved ref out of [min,max] -> invalid range (never clamped)', JSON.stringify(rref));
    // §10.1: resolved string parsed as decimal or 0x hex, then range-checked.
    const v = newEcuRecord({ name: 'EcuV', vars: [{ key: 'dec', value: '7' }, { key: 'hx', value: '0x0A' }, { key: 'txt', value: 'abc' }, { key: 'big', value: '0x0B' }] });
    const rvd = resolveBindingParams(binding({ count: '{ecu.vars.dec}' }), ifc, v);
    check(rvd.status === 'ready' && rvd.params.count === 7, '§10.1 {ecu.vars.dec}="7" into number -> 7 (number)', JSON.stringify(rvd));
    const rvh = resolveBindingParams(binding({ count: '{ecu.vars.hx}' }), ifc, v);
    check(rvh.status === 'ready' && rvh.params.count === 10, '§10.1 {ecu.vars.hx}="0x0A" into number -> 10', JSON.stringify(rvh));
    const rvt = resolveBindingParams(binding({ count: '{ecu.vars.txt}' }), ifc, v);
    check(rvt.status === 'invalid' && rvt.issues.some((i) => i.key === 'count' && i.code === 'type'), '§10.1 non-numeric resolved value -> invalid type', JSON.stringify(rvt));
    const rvb = resolveBindingParams(binding({ count: '{ecu.vars.big}' }), ifc, v);
    check(rvb.status === 'invalid' && rvb.issues.some((i) => i.key === 'count' && i.code === 'range'), '§10.1 resolved "0x0B" (11) > max 10 -> invalid range', JSON.stringify(rvb));
    // §10.4: unknown key = issue only; status unchanged, never in params.
    const rg = resolveBindingParams(binding({ ghost: 1, baseAddr: '{ecu.flash.regions.app.start}' }), ifc, a);
    check(rg.status === 'ready', '§10.4 unknown key does NOT change status (otherwise ready -> ready)', JSON.stringify(rg));
    check(rg.status !== 'ready' || !('ghost' in rg.params), '§10.4 unknown key never appears in resolved params', JSON.stringify(rg));
    const ifcReq = iface([ECU_IN, spec('n', 'number', { required: true, order: 1 })]);
    const rgi = resolveBindingParams(binding({ ghost: 1 }), ifcReq, a);
    check(rgi.status === 'incomplete' && rgi.missing.includes('n') && rgi.issues.some((i) => i.key === 'ghost' && i.code === 'unknown_key'), '§10.4 incomplete stays incomplete and lists unknown_key issue', JSON.stringify(rgi));
    const rgv = resolveBindingParams(binding({ ghost: 1, count: 99 }), ifc, a);
    check(rgv.status === 'invalid' && rgv.issues.some((i) => i.key === 'ghost' && i.code === 'unknown_key') && rgv.issues.some((i) => i.key === 'count' && i.code === 'range'), '§10.4 invalid stays invalid; unknown_key reported alongside', JSON.stringify(rgv));
  });

  // P3 — incomplete bindings
  await probe('P3 incomplete: required missing / file without fileExpect / optional', () => {
    const ifc = iface([
      ECU_IN,
      spec('n', 'number', { required: true, order: 1 }),
      spec('fw', 'file', { required: true, order: 2, accept: ['.hex'] }),
      spec('opt', 'number', { order: 3, default: 5 }),
      spec('name', 'text', { order: 4 }),
    ]);
    const exp = { fw: { fileName: 'a.hex', crc32: 'CBF43926' } };
    const r1 = resolveBindingParams(binding({}), ifc, ECU_A);
    check(r1.status === 'incomplete' && r1.missing.includes('n') && r1.missing.includes('fw'), 'nothing set -> incomplete, missing n + fw', JSON.stringify(r1));
    const r2 = resolveBindingParams(binding({ n: 3 }), ifc, ECU_A);
    check(r2.status === 'incomplete' && r2.missing.includes('fw') && !r2.missing.includes('n'), 'required file without fileExpect -> incomplete (fw only)', JSON.stringify(r2));
    const r3 = resolveBindingParams(binding({}, exp), ifc, ECU_A);
    check(r3.status === 'incomplete' && r3.missing.includes('n') && !r3.missing.includes('fw'), 'required number missing -> incomplete (n only)', JSON.stringify(r3));
    const r4 = resolveBindingParams(binding({ n: 3 }, exp), ifc, ECU_A);
    check(r4.status === 'ready', 'all required present, optional missing -> ready (never incomplete)', JSON.stringify(r4));
    if (r4.status === 'ready') {
      eqv(r4.params.n, 3, 'ready params carry the literal');
      check(!('fw' in r4.params), 'file input is never part of resolved params');
      check(!('opt' in r4.params) || r4.params.opt === 5, 'optional missing: default applied or omitted', JSON.stringify(r4.params));
      check(Object.values(r4.params).every(isRunValue), 'resolved params are RunValue primitives');
    }
    const ifcTxt = iface([ECU_IN, spec('who', 'text', { required: true, order: 1 })]);
    const ifcHb = iface([ECU_IN, spec('h', 'hex', { required: true, order: 1 }), spec('y', 'bytes', { required: true, order: 2 })]);
    const r6 = resolveBindingParams(binding({ h: '', y: '' }), ifcHb, ECU_A);
    check(r6.status === 'incomplete' && r6.missing.includes('h') && r6.missing.includes('y'), '§10.5 required hex / bytes "" count as missing', JSON.stringify(r6));
    const r5 = resolveBindingParams(binding({ who: '' }), ifcTxt, ECU_A);
    check(r5.status === 'incomplete' && r5.missing.includes('who'), 'required text set to "" counts as missing', JSON.stringify(r5));
  });

  // P4 — update-to-latest reconciliation
  await probe('P4 reconcile to next revision', () => {
    const b0 = binding({ a: 1, b: 'x' }, undefined, { flowId: 'f', revision: 2 });
    const before = JSON.stringify(b0);
    const next = iface([ECU_IN, spec('a', 'number', { order: 1 }), spec('c', 'number', { required: true, order: 2 })]);
    const r = reconcileBindingToRevision(b0, next, 3);
    eqv(r.dropped, ['b'], 'removed key b reported as dropped');
    eqv(r.newlyMissing, ['c'], 'new required key c reported as newly missing');
    eqv(r.binding.flowRef, { flowId: 'f', revision: 3 }, 'flowRef.revision = next revision, flowId kept');
    eqv(r.binding.params, { a: 1 }, 'a kept, b removed, c not invented');
    eqv([r.binding.id, r.binding.ecuId, r.binding.label, r.binding.order], [b0.id, b0.ecuId, b0.label, b0.order], 'identity fields unchanged');
    check(JSON.stringify(b0) === before, 'input binding not mutated', `before ${before}\n      after  ${JSON.stringify(b0)}`);
    check(r.binding !== b0 && r.binding.params !== b0.params, 'result is a new object (no shared params)');
    // Removed file input: its stale CRC expectation must not survive.
    const b1 = binding({ a: 1 }, { fw: { fileName: 'x.hex', crc32: 'CBF43926' } });
    const r1 = reconcileBindingToRevision(b1, next, 3);
    check(r1.binding.fileExpect?.fw === undefined, 'fileExpect of a removed file input dropped', JSON.stringify(r1.binding.fileExpect));
    eqv(r1.dropped, ['fw'], '§10.7 dropped lists the removed fileExpect key');
    // Deduped + sorted: param key and fileExpect key with the same name, plus another removed param.
    const b2 = binding({ a: 1, zz: 2, fw: 'stale' }, { fw: { fileName: 'x.hex', crc32: 'CBF43926' }, img0: { fileName: 'y.bin', crc32: '00000000' } });
    eqv(reconcileBindingToRevision(b2, next, 3).dropped, ['fw', 'img0', 'zz'], '§10.7 dropped = removed params + removed fileExpect keys, deduped, sorted');
    // Kept file input: its expectation survives untouched.
    const nextF = iface([ECU_IN, spec('a', 'number', { order: 1 }), spec('fw', 'file', { required: true, order: 2 })]);
    const r3 = reconcileBindingToRevision(b1, nextF, 3);
    eqv([r3.binding.fileExpect?.fw, r3.dropped, r3.newlyMissing], [{ fileName: 'x.hex', crc32: 'CBF43926' }, [], []], 'kept file input keeps its fileExpect, nothing dropped / missing');
    check(b1.fileExpect?.fw !== undefined, 'input fileExpect not mutated');
    // New required file input -> newly missing.
    const next2 = iface([ECU_IN, spec('a', 'number', { order: 1 }), spec('img', 'file', { required: true, order: 2 })]);
    const r2 = reconcileBindingToRevision(binding({ a: 1 }), next2, 4);
    check(r2.newlyMissing.includes('img'), 'new required file input without fileExpect -> newly missing', JSON.stringify(r2));
    // Kept required key already set -> not newly missing.
    const next3 = iface([ECU_IN, spec('a', 'number', { required: true, order: 1 })]);
    eqv(reconcileBindingToRevision(binding({ a: 1 }), next3, 5).newlyMissing, [], 'kept required key with value is not newly missing');
  });

  // P5 — CRC
  await probe('P5 crc32Hex + checkFileExpectation', () => {
    eqv(crc32Hex(Uint8Array.from(ascii('123456789'))), 'CBF43926', 'IEEE check value of "123456789"');
    eqv(crc32Hex(new Uint8Array(0)), '00000000', 'empty input -> 8 zero-padded hex digits');
    eqv(crc32Hex(FW_BYTES), FW_CRC, 'matches independent oracle');
    check(/^[0-9A-F]{8}$/.test(crc32Hex(Uint8Array.from([0x00]))), '8 upper-case hex digits');
    const file: FlowFileValue = { name: 'fw.hex', bytes: FW_BYTES };
    const bad = checkFileExpectation(binding({}, { firmware: { fileName: 'fw.hex', crc32: 'DEADBEEF' } }), 'firmware', file);
    check(bad.ok === false, 'mismatch -> ok:false', JSON.stringify(bad));
    if (!bad.ok) eqv([bad.key, bad.expected, bad.actual], ['firmware', 'DEADBEEF', FW_CRC], 'mismatch carries key/expected/actual');
    const low = checkFileExpectation(binding({}, { firmware: { fileName: 'fw.hex', crc32: FW_CRC.toLowerCase() } }), 'firmware', file);
    check(low.ok === true, 'lowercase expectation compared case-insensitively', JSON.stringify(low));
    if (low.ok) eqv(low.ref, { key: 'firmware', name: 'fw.hex', size: FW_BYTES.length, crc32: FW_CRC }, 'ok ref = {key,name,size,crc32 upper}');
    const renamed = checkFileExpectation(binding({}, { firmware: { fileName: 'fw.hex', crc32: FW_CRC } }), 'firmware', { name: 'fw_v2_RENAMED.s19', bytes: FW_BYTES });
    check(renamed.ok === true, '§10.8 name differs but CRC matches -> ok', JSON.stringify(renamed));
    if (renamed.ok) eqv(renamed.ref.name, 'fw_v2_RENAMED.s19', '§10.8 ref uses the CHOSEN file name');
    const oneBit = Uint8Array.from(FW_BYTES);
    oneBit[5] ^= 0x01;
    const flip = checkFileExpectation(binding({}, { firmware: { fileName: 'fw.hex', crc32: FW_CRC } }), 'firmware', { name: 'fw.hex', bytes: oneBit });
    check(flip.ok === false, 'single flipped bit -> mismatch');
  });

  // P6 — zero-TX refusals
  await probe('P6 zero-TX refusals', async () => {
    type Case = { label: string; code: string | null; bind?: FlowBindingV1; ecu?: EcuRecordV1; files?: Record<string, FlowFileValue>;
      over?: (tr: QaTransport) => Partial<WbRunDeps>; review?: boolean; expectReview?: boolean };
    const otherFw: FlowFileValue = { name: 'fw.hex', bytes: Uint8Array.from([1, 2, 3, 4]) };
    const cases: Case[] = [
      { label: 'crc mismatch', code: 'crc_mismatch', files: { firmware: otherFw } },
      { label: 'incomplete (no fileExpect for required firmware)', code: 'incomplete', bind: flasherBinding({ fileExpect: undefined }) },
      { label: 'invalid {ecu.*} ref', code: 'invalid', bind: flasherBinding({ params: { baseAddr: '{ecu.bogus.path}' } }) },
      { label: 'ECU lacks referenced region', code: 'invalid', ecu: newEcuRecord({ name: 'NoRegion' }) },
      { label: 'invalid select literal', code: 'invalid', bind: flasherBinding({ params: { baseAddr: '{ecu.flash.regions.app.start}', secLevel: '99' } }) },
      { label: 'busy', code: 'busy', over: () => ({ isRunActive: () => true }) },
      { label: 'no session', code: 'no_session', over: () => ({ transportFor: () => null }) },
      { label: 'revision missing', code: 'revision_missing', over: () => ({ loadRevision: async () => null }) },
      { label: 'ECU protocol not operable', code: 'protocol', ecu: ecuWithRegion('Kwp', 0x08004000, { protocol: 'kwp_can' }) },
      { label: 'review declined', code: 'review_declined', review: false, expectReview: true },
      { label: 'file not chosen at run time', code: 'file_missing', files: {} },
      { label: 'only an unrelated file key supplied', code: 'file_missing', files: { notFirmware: FIRMWARE } },
    ];
    const txBefore = listTxSourceIds().join(',');
    for (const c of cases) {
      const tr = new QaTransport();
      const spy = makeDeps(tr, c.over?.(tr) ?? {}, c.review ?? true);
      const ecu = c.ecu ?? ECU_A;
      const h = startWorkbenchRun(c.bind ?? flasherBinding({ ecuId: ecu.id }), ecu, c.files ?? { firmware: FIRMWARE }, spy.deps);
      const r: WbRunResult = await h.done;
      check(r.kind === 'refused', `${c.label}: kind refused`, JSON.stringify(r).slice(0, 400));
      if (r.kind === 'refused' && c.code !== null) eqv(r.refusal.code, c.code, `${c.label}: refusal code`);
      if (r.kind === 'refused') check(typeof r.refusal.message === 'string' && r.refusal.message !== '', `${c.label}: refusal has a message`);
      await sleep(20);
      eqv(tr.calls, [], `${c.label}: zero TX (requests / keep-alive / flash prepare)`);
      eqv(spy.appended.length, 0, `${c.label}: appendRecord not called`);
      eqv(spy.reviews.length, c.expectReview ? 1 : 0, `${c.label}: review gate ${c.expectReview ? 'shown once' : 'not shown (preconditions first)'}`);
    }
    eqv(listTxSourceIds().join(','), txBefore, 'no tx-source registration leaked by refused runs');
  });

  // P7 — happy path through the dedicated engine
  await probe('P7 happy path: ecu_flasher via startWorkbenchRun', async () => {
    const tr = new QaTransport();
    const spy = makeDeps(tr);
    const txBefore = listTxSourceIds().join(',');
    const bnd = flasherBinding({ ecuId: ECU_A.id });
    const h = startWorkbenchRun(bnd, ECU_A, { firmware: FIRMWARE }, spy.deps);
    const r = await h.done;
    check(r.kind === 'ran', 'kind ran', JSON.stringify(r).slice(0, 400));
    if (r.kind !== 'ran') return;
    const rec = r.record;
    eqv(r.appendError, null, 'appendError null');
    eqv([rec.outcome, rec.outputName], ['ok', 'ok'], 'outcome ok, outputName = reached flow_return name');
    eqv(rec.files, [{ key: 'firmware', name: 'fw.hex', size: FW_BYTES.length, crc32: FW_CRC }], 'files = firmware ref');
    check(Number.isInteger(rec.durationMs) && rec.durationMs >= 0, 'durationMs integer >= 0', String(rec.durationMs));
    eqv([rec.schemaVersion, rec.operator, rec.parentRunId, rec.queueId], [1, null, null, null], 'schemaVersion 1, operator/parentRunId/queueId null');
    eqv([rec.ecuId, rec.ecuName, rec.flowId, rec.flowRevision, rec.flowContentHash, rec.flowName],
      [ECU_A.id, 'Engine1', 'ecu_flasher', 3, FLASHER_HASH, 'Flash ECU'], 'ECU + pinned flow identity');
    eqv([rec.projectId, rec.vehicleId, rec.deviceId, rec.appVersion], [spy.deps.projectId, 'veh-qa', 'qa-device', '0.0.0-qa'], 'deps identity carried');
    check(spy.uuids.includes(rec.runId), 'runId produced by deps.uuid()', rec.runId);
    check(/Z$/.test(rec.startedAt) && /Z$/.test(rec.endedAt) && Date.parse(rec.endedAt) >= Date.parse(rec.startedAt), 'ISO-8601 UTC timestamps, ended >= started', `${rec.startedAt} ${rec.endedAt}`);
    eqv([rec.nrc, rec.errorMessage], [null, null], 'ok run: nrc / errorMessage null');
    eqv(rec.params.baseAddr, '08004000', 'record params carry the RESOLVED {ecu.*} value');
    check(!('firmware' in rec.params) && !('ecu' in rec.params), 'no file / ecu input in record params', JSON.stringify(rec.params));
    check(Object.values(rec.params).every(isRunValue) && Object.values(rec.outputs).every(isRunValue), 'params / outputs are RunValue primitives');
    check(rec.logExcerpt.length <= 200 && rec.logExcerpt.every((l) => typeof l === 'string' && l.length <= 512), 'logExcerpt <= 200 x 512', `n=${rec.logExcerpt.length}`);
    check(rec.logExcerpt.length > 0, 'logExcerpt not empty (engine onLog captured)');
    check(/^[0-9a-f]{64}$/.test(rec.ecuSnapshotHash ?? ''), 'ecuSnapshotHash = 64 lower hex', String(rec.ecuSnapshotHash));
    eqv(rec.ecuSnapshotHash, await refEcuSnapshotHash(ECU_A), 'ecuSnapshotHash = sha-256(canonicalJson(ecu))');
    const json = JSON.stringify(rec);
    const fwHex = hexOf(FW_BYTES);
    check(!json.includes(fwHex) && !json.toLowerCase().includes(fwHex.toLowerCase()) && !json.includes(Array.from(FW_BYTES).join(',')), 'no firmware bytes in the record');
    eqv(spy.appended.length, 1, 'appendRecord called exactly once');
    eqv(spy.appended[0], rec, 'appended record === returned record');
    // Engine really ran the pinned body on the injected transport, with the resolved base address.
    check(tr.calls.includes('DOWNLOAD') && tr.calls.some((x) => x.startsWith('31 01 FF 00')), 'erase + download went through the fake transport', tr.calls.join(' | '));
    eqv(tr.prepared.map((p) => [p.baseAddress, p.file?.name]), [[0x08004000, 'fw.hex']], 'resolved baseAddr + chosen file reached the flash block');
    // Review gate.
    eqv(spy.reviews.length, 1, 'confirmReview called once');
    const items = spy.reviews[0]?.items ?? [];
    const types = items.map((i) => i.blockType);
    check(types.includes('uds_flash_image'), 'review lists the flash (erase/download) block', JSON.stringify(items));
    check(types.includes('uds_write_did'), 'review lists the 2E write block', JSON.stringify(items));
    check(!types.includes('uds_routine_ctrl'), 'review does not list non-erase routines (0203 / FF01)', JSON.stringify(items));
    check(items.length > 0 && items.every((i) => i.path.startsWith('Flash ECU › ') && i.path.split(' › ').length >= 2), "paths are '›'-separated from the root name", JSON.stringify(items.map((i) => i.path)));
    eqv(spy.reviews[0]?.ecu.id, ECU_A.id, 'review receives the row ECU');
    eqv(spy.reviews[0]?.files, [{ key: 'firmware', name: 'fw.hex', size: FW_BYTES.length, crc32: FW_CRC }], 'review receives firmware name + CRC');
    await sleep(20);
    eqv(listTxSourceIds().join(','), txBefore, 'tx-source registration released after the run');
    h.stop(); // idempotent after completion
  });

  // P7b — reviewItems: nested path, custom FF00, cycles
  await probe('P7b reviewItems: nested call path, custom FF00, recursion-safe', () => {
    let s = 0;
    const blk = (type: string, label: string, config: Record<string, unknown> = {}): FlowBlock =>
      ({ id: `r${++s}`, type, label, x: 0, y: 0, config, status: 'idle', collapsed: false });
    const dia = (id: string, name: string, blocks: FlowBlock[]): FlowDiagram => ({ id, name, blocks, connections: [] as FlowConnection[], variables: [] });
    const calleeBlocks = [
      blk('uds_routine_ctrl', 'Erase FF00', { control_type: '01', routine_id: 'FF00' }),
      blk('uds_routine_ctrl', 'Preconditions', { control_type: '01', routine_id: '0203' }),
      blk('uds_routine_ctrl', 'Custom erase', { control_type: '01', routine_id: 'custom', routine_id_custom: 'ff00' }),
      blk('uds_routine_ctrl', 'Ref erase', { control_type: '01', routine_id: '{ecu.routines.erase}' }),
      blk('uds_routine_ctrl', 'Ref custom', { control_type: '01', routine_id: 'custom', routine_id_custom: '{ecu.routines.checkIntegrity}' }),
      blk('uds_read_did', 'Read VIN', { did: 'F190' }),
    ];
    const callee = dia('prog', 'Programming', calleeBlocks);
    const root = dia('root', 'Flash ECU', [
      blk('call:prog', 'Programming', { ref: { flowId: 'prog', revision: 1 } }),
      blk('uds_request_download', 'Request download', {}),
      blk('log', 'Log', { message: 'x' }),
    ]);
    const items = reviewItems(root, 'Flash ECU', (ref) => (ref.flowId === 'prog' ? callee : null));
    const paths = items.map((i) => i.path);
    check(paths.includes('Flash ECU › Programming › Erase FF00'), 'nested erase path "Flash ECU › Programming › Erase FF00"', JSON.stringify(paths));
    check(paths.includes('Flash ECU › Request download'), 'root-level download listed', JSON.stringify(paths));
    check(paths.includes('Flash ECU › Programming › Custom erase'), 'routine_id custom + routine_id_custom ff00 is an erase too', JSON.stringify(paths));
    check(paths.some((p) => p.startsWith('Flash ECU › Programming › ') && p.includes('Ref erase')), '§10.2 routine_id {ecu.routines.erase} flagged (conservative)', JSON.stringify(paths));
    check(paths.some((p) => p.startsWith('Flash ECU › Programming › ') && p.includes('Ref custom')), '§10.2 custom routine id given as {ecu.*} ref flagged', JSON.stringify(paths));
    const refItem = items.find((i) => i.path.includes('Ref erase'));
    eqv(refItem?.blockType, 'uds_routine_ctrl', '§10.2 flagged ref item keeps its block type');
    check(!paths.some((p) => p.endsWith('Preconditions') || p.endsWith('Read VIN') || p.endsWith('Log')), 'non-writing blocks not listed', JSON.stringify(paths));
    // Self-recursive callee must not overflow the stack.
    const loop = dia('loop', 'Loop', [blk('call:loop', 'Again', { ref: { flowId: 'loop', revision: 1 } }), blk('uds_write_did', 'Write', { did: 'F15A' })]);
    let threw = '';
    let n = -1;
    try {
      n = reviewItems(loop, 'Loop', () => loop).length;
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check(threw === '' && n >= 1, 'recursive call graph terminates and still lists the write', threw || `n=${n}`);
  });

  // P8 — Stop and Panic Stop
  await probe('P8 Stop -> aborted, Panic Stop -> panic_stop, TX frozen', async () => {
    // a) Workbench Stop
    {
      const tr = new QaTransport();
      tr.delayMs = 30;
      const spy = makeDeps(tr);
      const h = startWorkbenchRun(flasherBinding({ ecuId: ECU_A.id }), ECU_A, { firmware: FIRMWARE }, spy.deps);
      await waitFor(() => tr.calls.includes('KA START'), 'stop: keep-alive started');
      await sleep(40);
      h.stop();
      const r = await h.done;
      const n = tr.count;
      await sleep(150);
      check(r.kind === 'ran' && r.record.outcome === 'aborted', 'Stop -> outcome aborted', JSON.stringify(r).slice(0, 300));
      eqv(tr.count, n, 'Stop: TX count frozen after done');
      check(!tr.calls.some((x) => x.startsWith('31 01 FF 00')) && !tr.calls.includes('DOWNLOAD'), 'Stop: no erase / download', tr.calls.join(' | '));
      eqv(spy.appended.length, 1, 'Stop: aborted run is still recorded');
      check(r.kind !== 'ran' || Number.isInteger(r.record.durationMs), 'Stop: durationMs integer');
      h.stop(); // idempotent
    }
    // b) Global Panic Stop (tx-source registry), canvas untouched
    {
      loadCanvasMarker();
      const snap = snapshotFlowStore();
      const tr = new QaTransport();
      tr.delayMs = 30;
      const spy = makeDeps(tr);
      const h = startWorkbenchRun(flasherBinding({ ecuId: ECU_A.id }), ECU_A, { firmware: FIRMWARE }, spy.deps);
      await waitFor(() => tr.calls.includes('KA START'), 'panic: keep-alive started');
      stopAllTxSources();
      const r = await h.done;
      const n = tr.count;
      await sleep(150);
      check(r.kind === 'ran' && r.record.outcome === 'panic_stop', 'Panic Stop -> outcome panic_stop', JSON.stringify(r).slice(0, 300));
      eqv(tr.count, n, 'Panic: TX count frozen after done');
      check(!tr.calls.some((x) => x.startsWith('31 01 FF 00')) && !tr.calls.includes('DOWNLOAD'), 'Panic: no erase / download', tr.calls.join(' | '));
      check(flowStore.getSnapshot() === snap.ref, 'Panic: flowStore state untouched (engine tx-source callback must not write the canvas)');
      eqv(spy.appended.length, 1, 'Panic: run is still recorded');
    }
    // c) Panic with no run active must not poison the next run
    {
      stopAllTxSources();
      const tr = new QaTransport();
      const spy = makeDeps(tr);
      const r = await startWorkbenchRun(flasherBinding({ ecuId: ECU_A.id }), ECU_A, { firmware: FIRMWARE }, spy.deps).done;
      check(r.kind === 'ran' && r.record.outcome === 'ok', 'run after an idle Panic Stop completes ok', JSON.stringify(r).slice(0, 300));
    }
    // d) Stop while the review dialog is open -> nothing transmitted even if the operator then confirms
    {
      const tr = new QaTransport();
      let release: (v: boolean) => void = () => undefined;
      const gate = new Promise<boolean>((res) => { release = res; });
      const spy = makeDeps(tr, {}, gate);
      const h = startWorkbenchRun(flasherBinding({ ecuId: ECU_A.id }), ECU_A, { firmware: FIRMWARE }, spy.deps);
      await waitFor(() => spy.reviews.length === 1, 'review dialog shown');
      h.stop();
      release(true);
      await sleep(50);
      eqv(tr.calls, [], 'Stop during review gate: zero TX after confirm');
      const r = await h.done;
      check(r.kind === 'refused' && r.refusal.code === 'stopped', '§10.3 Stop during review -> refused stopped', JSON.stringify(r).slice(0, 300));
      eqv(spy.appended.length, 0, '§10.3 Stop during review: no record');
    }
    // e) Global Panic Stop while the review dialog is open -> refused stopped, zero TX, no record
    {
      const tr = new QaTransport();
      let release: (v: boolean) => void = () => undefined;
      const gate = new Promise<boolean>((res) => { release = res; });
      const spy = makeDeps(tr, {}, gate);
      const h = startWorkbenchRun(flasherBinding({ ecuId: ECU_A.id }), ECU_A, { firmware: FIRMWARE }, spy.deps);
      await waitFor(() => spy.reviews.length === 1, 'review dialog shown (panic)');
      stopAllTxSources();
      release(true);
      const r = await h.done;
      await sleep(50);
      check(r.kind === 'refused' && r.refusal.code === 'stopped', '§10.3 Panic Stop during review -> refused stopped (runner reachable by Panic before the engine starts)', JSON.stringify(r).slice(0, 300));
      eqv(tr.calls, [], '§10.3 Panic during review: zero TX');
      eqv(spy.appended.length, 0, '§10.3 Panic during review: no record');
    }
    // f) Stop synchronously right after start (revision still loading) -> refused stopped
    {
      const tr = new QaTransport();
      const spy = makeDeps(tr);
      const h = startWorkbenchRun(flasherBinding({ ecuId: ECU_A.id }), ECU_A, { firmware: FIRMWARE }, spy.deps);
      h.stop();
      const r = await h.done;
      await sleep(50);
      check(r.kind === 'refused' && r.refusal.code === 'stopped', '§10.3 Stop before preconditions finish -> refused stopped', JSON.stringify(r).slice(0, 300));
      eqv([tr.calls.length, spy.appended.length, spy.reviews.length], [0, 0, 0], '§10.3 early Stop: zero TX, no record, no review');
    }
  });

  // P9 — canvas isolation
  await probe('P9 canvas store untouched (runner + engine rootBody)', async () => {
    loadCanvasMarker();
    const snap = snapshotFlowStore();
    let notifications = 0;
    const unsub = flowStore.subscribe(() => { notifications += 1; });
    try {
      const tr = new QaTransport();
      const r = await startWorkbenchRun(flasherBinding({ ecuId: ECU_A.id }), ECU_A, { firmware: FIRMWARE }, makeDeps(tr).deps).done;
      check(r.kind === 'ran' && r.record.outcome === 'ok', 'runner run ok', JSON.stringify(r).slice(0, 300));
      check(flowStore.getSnapshot() === snap.ref, 'runner: flowStore state is the same reference');
      eqv(snapshotFlowStore().json, snap.json, 'runner: diagram / run log / block statuses deep-equal');
      eqv(notifications, 0, 'runner: zero flowStore notifications during the run');

      const tr2 = new QaTransport();
      const lines: string[] = [];
      const eng = new FlowEngine();
      await eng.run({ rootBody: flasherBody(), transport: tr2, ecu: ECU_A, inputs: { firmware: FIRMWARE }, rootId: 'ecu_flasher', rootName: 'Flash ECU', onLog: (l: string) => lines.push(l) });
      eqv([eng.result?.outcome, eng.result?.name], ['ok', 'ok'], 'engine rootBody: ran the given body (not the ex_counter canvas)');
      check(tr2.calls.includes('DOWNLOAD'), 'engine rootBody: flasher requests went out');
      check(lines.length > 0, 'engine rootBody: log lines delivered to onLog');
      check(flowStore.getSnapshot() === snap.ref, 'engine rootBody: flowStore state is the same reference');
      eqv(notifications, 0, 'engine rootBody: zero flowStore notifications');
    } finally {
      unsub();
    }
  });

  // P13 — §10.8 renamed firmware with matching CRC runs; record carries the chosen name
  await probe('P13 renamed file, CRC matches -> ran, record uses chosen name', async () => {
    const tr = new QaTransport();
    const spy = makeDeps(tr);
    const chosen: FlowFileValue = { name: 'fw_renamed.hex', bytes: FW_BYTES };
    const r = await startWorkbenchRun(flasherBinding({ ecuId: ECU_A.id }), ECU_A, { firmware: chosen }, spy.deps).done;
    check(r.kind === 'ran' && r.record.outcome === 'ok', 'run not refused for a name-only difference', JSON.stringify(r).slice(0, 300));
    if (r.kind === 'ran') eqv(r.record.files, [{ key: 'firmware', name: 'fw_renamed.hex', size: FW_BYTES.length, crc32: FW_CRC }], 'record.files uses the chosen file name');
    eqv(spy.reviews[0]?.files.map((f) => f.name), ['fw_renamed.hex'], 'review dialog shows the chosen file name');
    eqv(tr.prepared.map((p) => p.file?.name), ['fw_renamed.hex'], 'chosen file reached the flash block');
  });

  // P10 — append failure
  await probe('P10 appendRecord rejects -> ran + appendError', async () => {
    const tr = new QaTransport();
    const spy = makeDeps(tr, { appendRecord: async () => { throw new Error('[runstore:io] disk full'); } });
    const r = await startWorkbenchRun(flasherBinding({ ecuId: ECU_A.id }), ECU_A, { firmware: FIRMWARE }, spy.deps).done;
    check(r.kind === 'ran', 'kind ran despite append failure', JSON.stringify(r).slice(0, 300));
    if (r.kind === 'ran') {
      check(typeof r.appendError === 'string' && r.appendError !== '', 'appendError is a non-empty string', String(r.appendError));
      eqv(r.record.outcome, 'ok', 'record still returned with its outcome');
    }
  });

  // P11 — cellView + mapOutcome
  await probe('P11 cellView chips + mapOutcome table', () => {
    const rec = (outcome: RunRecordV1['outcome'], outputName: string | null): RunRecordV1 => ({
      schemaVersion: 1, runId: 'r', parentRunId: null, queueId: null, projectId: 'p', vehicleId: null, ecuId: 'e', ecuName: 'E',
      ecuSnapshotHash: null, flowId: 'f', flowRevision: 1, flowContentHash: 'h', flowName: 'F', params: {}, files: [],
      startedAt: '2026-11-19T00:00:00.000Z', endedAt: '2026-11-19T00:00:01.000Z', durationMs: 1000, outcome, outputName,
      outputs: {}, nrc: null, errorMessage: null, logExcerpt: [], operator: null, deviceId: 'd', appVersion: 'v',
    });
    const boot = cellView(rec('fail', 'bootloader_fail'));
    eqv(boot.chip, 'critical', 'bootloader_fail -> critical');
    check(boot.text.toLowerCase().includes('bootloader'), 'bootloader_fail text mentions bootloader', boot.text);
    eqv(cellView(rec('fail', 'safe_abort')).chip, 'warn', 'safe_abort -> warn');
    eqv(cellView(rec('fail', 'post_warning')).chip, 'warn', 'other fail -> warn');
    eqv(cellView(rec('fail', null)).chip, 'warn', 'fail without name -> warn');
    eqv(cellView(rec('ok', 'ok')).chip, 'ok', 'ok -> ok');
    eqv(cellView(rec('error', null)).chip, 'critical', 'error -> critical');
    eqv(cellView(null).chip, 'none', 'null -> none');
    check(cellView(rec('aborted', null)).chip !== 'ok' && cellView(rec('panic_stop', null)).chip !== 'ok', 'aborted / panic_stop never shown as ok');
    eqv(mapOutcome({ outcome: 'error', stopped: true }, 'user'), 'aborted', '(error, stopped, user) -> aborted');
    eqv(mapOutcome({ outcome: 'error', stopped: true }, 'panic'), 'panic_stop', '(error, stopped, panic) -> panic_stop');
    eqv(mapOutcome({ outcome: 'ok', stopped: false }, null), 'ok', 'ok -> ok');
    eqv(mapOutcome({ outcome: 'fail', stopped: false }, null), 'fail', 'fail -> fail');
    eqv(mapOutcome({ outcome: 'error', stopped: false }, null), 'error', '(error, not stopped) -> error');
    eqv(mapOutcome({ outcome: 'error', stopped: true }, null), 'aborted', '§10.9 (error, stopped, null) -> aborted');
  });

  // P12 — buildRunRecord
  await probe('P12 buildRunRecord rounding / bytes / log truncation', () => {
    const result = (over: Partial<FlowRunResult> = {}): FlowRunResult =>
      ({ outcome: 'ok', name: 'ok', outputs: {}, stopped: false, refused: false, ...over });
    const base: WbRecordInput = {
      runId: '00000000-0000-4000-8000-000000000001', projectId: 'p', vehicleId: null, ecu: ECU_A, flowId: 'f', flowRevision: 2,
      flowContentHash: 'h', flowName: 'F', params: { a: 1 }, files: [], startedAtMs: 1_700_000_000_000, endedAtMs: 1_700_000_000_010.4,
      result: result(), stopKind: null, log: [], deviceId: 'd', appVersion: 'v', ecuSnapshotHash: 'cd'.repeat(32),
    };
    eqv(buildRunRecord(base).durationMs, 10, '10.4 ms -> 10');
    eqv(buildRunRecord({ ...base, endedAtMs: base.startedAtMs + 10.6 }).durationMs, 11, '10.6 ms -> 11');
    eqv(buildRunRecord({ ...base, endedAtMs: base.startedAtMs - 5 }).durationMs, 0, '§10.6 clock going backwards -> durationMs clamped to 0');
    eqv(buildRunRecord({ ...base, endedAtMs: base.startedAtMs + 0.4 }).durationMs, 0, '§10.6 0.4 ms -> 0');
    eqv(buildRunRecord({ ...base, endedAtMs: base.startedAtMs + 10.5 }).durationMs, 11, '§10.6 10.5 ms -> 11 (Math.round)');
    const r = buildRunRecord({ ...base, result: result({ outputs: { raw: Uint8Array.from([0x0a, 0xff]), n: 5, s: 'x', b: true } }) });
    eqv(r.outputs.raw, '0AFF', 'bytes output -> upper hex string');
    eqv([r.outputs.n, r.outputs.s, r.outputs.b], [5, 'x', true], 'scalar outputs kept');
    eqv([r.outputName, r.outcome], ['ok', 'ok'], 'outputName / outcome from result');
    eqv([r.operator, r.parentRunId, r.queueId, r.schemaVersion], [null, null, null, 1], 'operator / parentRunId / queueId null, schemaVersion 1');
    eqv(r.startedAt, new Date(base.startedAtMs).toISOString(), 'startedAt ISO from startedAtMs');
    eqv(r.ecuSnapshotHash, 'cd'.repeat(32), 'ecuSnapshotHash passed through');
    const log = Array.from({ length: 300 }, (_, i) => `L${i}:`.padEnd(600, 'x'));
    const logCopy = JSON.stringify(log);
    const rl = buildRunRecord({ ...base, log });
    eqv(rl.logExcerpt.length, 200, '300 lines -> 200');
    check(rl.logExcerpt.every((l) => l.length <= 512), 'every line <= 512 chars');
    check((rl.logExcerpt[199] ?? '').startsWith('L299:') && (rl.logExcerpt[0] ?? '').startsWith('L100:'), 'excerpt keeps the TAIL (lines 100..299)', `${(rl.logExcerpt[0] ?? '').slice(0, 6)} .. ${(rl.logExcerpt[199] ?? '').slice(0, 6)}`);
    check(JSON.stringify(log) === logCopy, 'input log not mutated');
    eqv(buildRunRecord({ ...base, result: result({ outcome: 'error', name: null, stopped: true }), stopKind: 'user' }).outcome, 'aborted', 'stopKind user -> aborted');
    eqv(buildRunRecord({ ...base, result: result({ outcome: 'error', name: null, stopped: true }), stopKind: 'panic' }).outcome, 'panic_stop', 'stopKind panic -> panic_stop');
    eqv(buildRunRecord({ ...base, files: [{ key: 'fw', name: 'a.hex', size: 3, crc32: 'CBF43926' }] }).files, [{ key: 'fw', name: 'a.hex', size: 3, crc32: 'CBF43926' }], 'files passed through');
  });

  const failed = results.filter((x) => !x.ok);
  console.log(`\nworkbench.qa: ${results.length - failed.length}/${results.length} probes PASS (${totalChecks} checks)`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((x) => x.name).join(', ')}`);
    // `process` is not in the app tsconfig types: reach it through globalThis.
    const proc = (globalThis as { process?: { exitCode?: number; exit?: (code: number) => never } }).process;
    if (proc) proc.exitCode = 1;
    if (hung) {
      // A hung run keeps timers alive: abort it and leave immediately.
      stopAllTxSources();
      proc?.exit?.(1);
    }
  }
}

await main();
