/**
 * Headless verification of the production `ecu_flasher` template on the REAL flow executor
 * (FlowEngine + RealFlowExecutor + runFlashBlock) with a scripted fake transport that records every
 * request (sid, data, addressing, SPR, timeout, busy retry) and a stubbed `cmd_flash_*` backend
 * (injected through `FlowTransport.flash`).
 * Run: `npm run test:flasher` (esbuild bundle -> node; throws on the first failure).
 */
import { FlowEngine } from './FlowEngine';
import { flowStore } from './FlowStore';
import { FLOW_TEMPLATES } from './templates';
import { getBlockDef } from './blockDefs';
import { isCompactBlock, listTerminals, resolveGotoTarget, terminalName, terminalReferences, validateTerminals } from './flowTerminals';
import { flowPrompt } from './flowPrompt';
import { bcd, buildFingerprint, asciiText } from './flowData';
import { stopAllTxSources } from '../../store/txSources';
import { t } from '../../i18n';
import type { FlowRequestOptions, FlowTransport } from './flowTransport';
import type { FlashBackend } from './flashRun';
import type { FlowBlock, FlowDiagram } from './types';
import type { DownloadConfigDto, FirmwareImageSummaryDto, FlashReportDto } from '../../types/flash';
import type { DiagSessionConfigDto } from '../../types/udsClient';

// ─── Tiny assert helpers ───────────────────────────────────────────────────────

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
const hx = (b: readonly number[]): string => b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

// ─── Fake image (2 segments) ───────────────────────────────────────────────────

const SUMMARY: FirmwareImageSummaryDto = {
  segments: [
    { address: 0x08004000, length: 0x0001c000, crc32: 0xdeadbeef },
    { address: 0x08020000, length: 0x00000200, crc32: 0x0a0b0c0d },
  ],
  totalBytes: 0x1c200,
  crc32: 0x11223344,
};
const DTO: DiagSessionConfigDto = { busId: 0, requestId: 0x7e0, responseId: 0x7e8, isExtendedId: false, functionalId: 0x7df };

// ─── Scripted transport ────────────────────────────────────────────────────────

interface Rec {
  kind: 'uds' | 'download' | 'ka';
  sid: number;
  data: number[];
  addressing: 'physical' | 'functional';
  suppressed: boolean;
  timeoutMs: number | null;
  busyRetryMax: number;
  ka?: boolean;
}

type Responder = (sid: number, data: readonly number[], o: FlowRequestOptions, tr: FakeTransport) => number[] | Error | undefined;

class FakeTransport implements FlowTransport {
  readonly demo = false;
  readonly tabId = 'tab-test';
  recs: Rec[] = [];
  fid: number | null = 0x7df;
  flashed = false;
  downloadFails = false;
  /** Probe 3E 00 failures to inject (counted per call). */
  probeFailures = 0;
  probeAlwaysFail = false;
  override: Responder | null = null;
  delayMs = 0;
  readonly flash: FlashBackend;

  constructor() {
    const self = this;
    this.flash = {
      async prepare() {
        return { handle: { imageId: 'img-1', fileName: 'fw.hex', format: 'intelHex', summary: SUMMARY }, dto: DTO };
      },
      async download(_dto: DiagSessionConfigDto, imageId: string, cfg: DownloadConfigDto): Promise<FlashReportDto> {
        self.recs.push({ kind: 'download', sid: 0x34, data: [], addressing: 'physical', suppressed: false, timeoutMs: null, busyRetryMax: cfg.retriesPerBlock ?? 0 });
        if (imageId !== 'img-1') throw new Error('wrong image id');
        if (self.downloadFails) throw new Error('[flash] negativeResponse NRC 0x72 generalProgrammingFailure');
        self.flashed = true;
        return { segments: [], totalBytes: SUMMARY.totalBytes, totalBlocks: 30, totalRetries: 0, durationMs: 12, throughputBytesPerSec: 1000 };
      },
      async cancel() {
        // nothing in flight
      },
    };
  }

  functionalId(): number | null {
    return this.fid;
  }

  async setKeepalive(enabled: boolean, intervalMs: number): Promise<void> {
    this.recs.push({ kind: 'ka', sid: 0x3e, data: [0x80], addressing: 'physical', suppressed: true, timeoutMs: intervalMs, busyRetryMax: 0, ka: enabled });
  }

  async readDid(did: number): Promise<number[]> {
    const pdu = await this.request(0x22, [(did >> 8) & 0xff, did & 0xff]);
    return pdu.slice(3);
  }

  async request(sid: number, data: readonly number[], o: FlowRequestOptions = {}): Promise<number[]> {
    this.recs.push({
      kind: 'uds',
      sid,
      data: [...data],
      addressing: o.addressing ?? 'physical',
      suppressed: o.suppressed === true,
      timeoutMs: o.timeoutMs ?? null,
      busyRetryMax: o.busyRetryMax ?? 0,
    });
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const ov = this.override?.(sid, data, o, this);
    if (ov instanceof Error) throw ov;
    if (ov !== undefined) return ov;
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
      case 0x3e:
        if (this.probeAlwaysFail) throw new Error('timeout (P2)');
        if (this.probeFailures > 0) {
          this.probeFailures -= 1;
          throw new Error('timeout (P2)');
        }
        return [0x7e, data[0]];
      case 0x85: return [0xc5, data[0]];
      default: throw new Error(`unexpected SID 0x${sid.toString(16)}`);
    }
  }

  /** "HEX|P|-" style lines of the UDS requests (keepalive / download as markers). */
  lines(): string[] {
    return this.recs.map((r) => {
      if (r.kind === 'ka') return `KA ${r.ka ? 'START' : 'STOP'}`;
      if (r.kind === 'download') return 'DOWNLOAD';
      return `${hx([r.sid, ...r.data])}|${r.addressing === 'functional' ? 'F' : 'P'}${r.suppressed ? '|SPR' : ''}`;
    });
  }
  uds(): Rec[] {
    return this.recs.filter((r) => r.kind === 'uds');
  }
}

// ─── Harness ───────────────────────────────────────────────────────────────────

let promptAnswer: string | null = 'OK';
flowPrompt.subscribe(() => {
  const p = flowPrompt.getSnapshot();
  if (p !== null) setTimeout(() => flowPrompt.answer(promptAnswer), 0);
});

function loadFlasher(): void {
  const tpl = FLOW_TEMPLATES.find((x) => x.id === 'ecu_flasher');
  if (!tpl) throw new Error('ecu_flasher template missing');
  flowStore.loadTemplate(tpl);
}
function diagram(): FlowDiagram {
  return flowStore.getSnapshot().diagram;
}
function blockByLabel(label: string): FlowBlock {
  const b = diagram().blocks.find((x) => x.label === label);
  if (!b) throw new Error(`block "${label}" not found`);
  return b;
}
function runLogText(): string {
  return flowStore.getSnapshot().runLog.map((e) => e.message).join('\n');
}
async function runFlasher(tr: FakeTransport, prep?: () => void): Promise<void> {
  loadFlasher();
  prep?.();
  await new FlowEngine().run({ transport: tr });
}
const lastKa = (tr: FakeTransport): boolean | undefined => tr.recs.filter((r) => r.kind === 'ka').at(-1)?.ka;

// ─── 0. Template structure: no dangling error outputs, no overlapping nodes ────

function checkStructure(): void {
  loadFlasher();
  const d = diagram();
  const wired = (b: FlowBlock, port: string): boolean => d.connections.some((c) => c.fromBlockId === b.id && c.fromPortId === port);
  for (const b of d.blocks) {
    for (const port of ['error_out', 'fail_out', 'timeout_out', 'false_out', 'true_out']) {
      const has = ({
        error_out: b.type.startsWith('uds_') && !['uds_flash_image', 'uds_wait_ecu_ready'].includes(b.type) || b.type === 'io_user_prompt',
        fail_out: b.type === 'uds_flash_image',
        timeout_out: b.type === 'uds_wait_ecu_ready',
        false_out: b.type === 'condition',
        true_out: b.type === 'condition',
      } as Record<string, boolean>)[port];
      if (has) {
        ok(wired(b, port), `"${b.label}" ${port} is wired`);
        // Recovery coverage is NOT weakened by the wireless routing: a wire that ends at a goto must
        // resolve to an existing terminal that really leads into a lane head.
        for (const c of d.connections.filter((x) => x.fromBlockId === b.id && x.fromPortId === port)) {
          const to = d.blocks.find((x) => x.id === c.toBlockId);
          if (to?.type === 'flow_goto') {
            const term = resolveGotoTarget(d, to);
            ok(term !== null, `"${b.label}" ${port}: goto resolves to a terminal`);
            ok(term !== null && d.connections.some((x) => x.fromBlockId === term.id && x.fromPortId === 'exec_out'), `"${b.label}" ${port}: terminal leads into its lane`);
          }
        }
      }
    }
    if (b.type === 'uds_security_access') ok(wired(b, 'success_out'), 'security success_out wired');
  }
  // Recovery lanes: three terminals, referenced by the expected number of gotos; no long exec wire
  // from the main rows into a lane head any more (only terminal -> head).
  eq(validateTerminals(d), [], 'flasher: terminal validation clean');
  const refs = (name: string): number => {
    const tb = listTerminals(d).find((x) => terminalName(x) === name);
    return tb ? terminalReferences(d, tb.id).length : -1;
  };
  eq([refs('SAFE ABORT'), refs('ECU IN BOOTLOADER'), refs('POST-PROGRAMMING')], [14, 4, 8], 'flasher: goto count per terminal');
  for (const label of ['udsTpl.fl.safeHead', 'udsTpl.fl.bootHead', 'udsTpl.fl.postHead'] as const) {
    const head = blockByLabel(t(label));
    const into = d.connections.filter((c) => c.toBlockId === head.id && c.toPortId === 'exec_in');
    eq(into.map((c) => d.blocks.find((x) => x.id === c.fromBlockId)?.type), ['flow_terminal'], `${label}: only fed by its terminal`);
  }
  // Node boxes (200 x estimated height; pills 140 x 28) never overlap.
  const box = (b: FlowBlock): { w: number; h: number } => {
    if (isCompactBlock(b.type)) return { w: 140, h: 28 };
    const def = getBlockDef(b.type);
    const rows = def ? Math.max(def.ports.filter((p) => p.direction === 'input').length, def.ports.filter((p) => p.direction === 'output').length) : 1;
    return { w: 200, h: 36 + 8 + rows * 24 + 38 + (b.type === 'uds_flash_image' ? 40 : 0) };
  };
  for (let i = 0; i < d.blocks.length; i++) {
    for (let j = i + 1; j < d.blocks.length; j++) {
      const a = d.blocks[i];
      const b = d.blocks[j];
      const ba = box(a);
      const bb = box(b);
      const overlap = a.x < b.x + bb.w && b.x < a.x + ba.w && a.y < b.y + bb.h && b.y < a.y + ba.h;
      ok(!overlap, `"${a.label}" and "${b.label}" do not overlap`);
    }
  }
}

// ─── 1. Happy path ─────────────────────────────────────────────────────────────

async function happyPath(): Promise<void> {
  const tr = new FakeTransport();
  const before = new Date();
  await runFlasher(tr);
  const after = new Date();
  const fpBefore = buildFingerprint({ format: 'iso_f15a', serial: 'NEXUS1', serialLen: 6, pad: 0x20, template: '' }, before);
  const fpAfter = buildFingerprint({ format: 'iso_f15a', serial: 'NEXUS1', serialLen: 6, pad: 0x20, template: '' }, after);
  const writeFp = tr.uds().find((r) => r.sid === 0x2e);
  ok(writeFp !== undefined, '2E F15A sent');
  const fpSent = writeFp ? writeFp.data.slice(2) : [];
  ok(hx(fpSent) === hx(fpBefore) || hx(fpSent) === hx(fpAfter), `fingerprint bytes (${hx(fpSent)})`);
  eq(fpSent.length, 9, 'fingerprint = 3 BCD date bytes + 6 serial bytes');

  const expected = [
    '10 03|P',
    'KA START',
    '22 F1 90|P',
    '22 F1 87|P',
    '22 F1 89|P',
    '22 F1 91|P',
    '31 01 02 03|P',
    '85 82|F|SPR',
    '28 83 01|F|SPR',
    '10 02|P',
    '3E 00|P',
    '27 11|P',
    '27 12 ED CB A9 87|P',
    `2E F1 5A ${hx(fpSent)}|P`,
    '31 01 FF 00 44 08 00 40 00 00 01 C0 00|P',
    '31 01 FF 00 44 08 02 00 00 00 00 02 00|P',
    'DOWNLOAD',
    '31 01 02 02 DE AD BE EF|P',
    '31 01 02 02 0A 0B 0C 0D|P',
    '31 01 FF 01|P',
    '11 01|P',
    '3E 00|P',
    '10 03|P',
    '28 80 01|F|SPR',
    '85 81|F|SPR',
    '14 FF FF FF|P',
    '22 F1 89|P',
    '10 01|P',
    'KA STOP',
  ];
  eq(tr.lines(), expected, 'happy path: exact ordered request list');

  const u = tr.uds();
  const prog = u.find((r) => r.sid === 0x10 && r.data[0] === 0x02);
  eq(prog?.timeoutMs ?? null, 5000, '10 02 timeout 5000 ms');
  const erases = u.filter((r) => r.sid === 0x31 && r.data[1] === 0xff && r.data[2] === 0x00);
  eq(erases.map((r) => [r.timeoutMs, r.busyRetryMax]), [[30000, 3], [30000, 3]], 'erase timeout 30 s + busy retry 3 per segment');
  const verifies = u.filter((r) => r.sid === 0x31 && r.data[1] === 0x02 && r.data[2] === 0x02);
  eq(verifies.map((r) => r.timeoutMs), [5000, 5000], 'verify timeout 5 s per segment');
  eq(tr.recs.find((r) => r.kind === 'download')?.busyRetryMax, 2, 'download retries per block = 2');
  const kaStart = tr.recs.find((r) => r.kind === 'ka' && r.ka === true);
  eq(kaStart?.timeoutMs, 2000, 'keep-alive interval 2000 ms');
  ok(runLogText().includes(t('udsTpl.fl.okMsg')), 'Flash OK summary logged');
  ok(runLogText().includes(t('udsTpl.fl.swChangedMsg')), 'SW version change detected (bytes_not_equal)');
  ok(!runLogText().includes(t('udsTpl.fl.safeHeadMsg')) && !runLogText().includes(t('udsTpl.fl.bootHeadMsg')), 'no recovery lane on the happy path');
}

// ─── 2. Failure before erase → SAFE ABORT ──────────────────────────────────────

const SAFE_TAIL = ['28 80 01|F|SPR', '85 81|F|SPR', '10 01|P', 'KA STOP'];

function assertNoProgramming(tr: FakeTransport, label: string): void {
  const l = tr.lines();
  ok(!l.some((x) => x.startsWith('31 01 FF 00')), `${label}: no 31 FF00 erase`);
  ok(!l.includes('DOWNLOAD') && !tr.uds().some((r) => r.sid === 0x34), `${label}: no 0x34 download`);
  ok(!tr.uds().some((r) => r.sid === 0x11), `${label}: no 0x11 reset`);
}

async function failBeforeErase(): Promise<void> {
  // a) 0203 preconditions report status 01
  const a = new FakeTransport();
  a.override = (sid, data) => (sid === 0x31 && data[1] === 0x02 && data[2] === 0x03 ? [0x71, 0x01, 0x02, 0x03, 0x01] : undefined);
  await runFlasher(a);
  eq(a.lines().slice(-4), SAFE_TAIL, '0203 status 01: safe-abort lane (28 00, 85 01, 10 01, KA stop)');
  assertNoProgramming(a, '0203 status 01');
  ok(runLogText().includes(t('udsFlow.err.routineStatus', { rid: '0203', got: '01', exp: '00' })), '0203 error names the status');
  eq(lastKa(a), false, '0203 status 01: keep-alive stopped');

  // b) NRC 0x35 invalidKey on 27 12
  const b = new FakeTransport();
  b.override = (sid, data) => (sid === 0x27 && data[0] === 0x12 ? new Error('NRC 0x35 (invalidKey)') : undefined);
  await runFlasher(b);
  eq(b.lines().slice(-4), SAFE_TAIL, '27 12 NRC: safe-abort lane');
  assertNoProgramming(b, '27 12 NRC');
  ok(!b.uds().some((r) => r.sid === 0x2e), '27 12 NRC: no fingerprint write');

  // c) HW number mismatch (expected filled in) → safe abort
  const c = new FakeTransport();
  await runFlasher(c, () => flowStore.updateBlockConfig(blockByLabel(t('udsTpl.fl.hwExpected')).id, { value: 'HW99' }));
  eq(c.lines().slice(-4), SAFE_TAIL, 'HW mismatch: safe-abort lane');
  ok(!c.uds().some((r) => r.sid === 0x31), 'HW mismatch: no routine sent');

  // d) user cancels the precondition prompt → nothing sent at all
  promptAnswer = null;
  const d = new FakeTransport();
  await runFlasher(d);
  promptAnswer = 'OK';
  eq(d.recs.length, 0, 'prompt cancel: nothing transmitted');
  ok(runLogText().includes(t('udsTpl.fl.cancelledMsg')), 'prompt cancel: abort log');
}

// ─── 3. Failure during flash → ECU IN BOOTLOADER ───────────────────────────────

async function failDuringFlash(): Promise<void> {
  const tr = new FakeTransport();
  tr.downloadFails = true;
  await runFlasher(tr);
  const l = tr.lines();
  const i = l.indexOf('DOWNLOAD');
  ok(i > 0, 'download attempted');
  eq(l.slice(i + 1), ['28 80 01|F|SPR', '85 81|F|SPR', 'KA STOP'], 'bootloader lane: comm + DTC re-enabled, keep-alive stopped');
  ok(!tr.uds().some((r) => r.sid === 0x11), 'bootloader lane: NO 11 01');
  ok(!l.slice(i + 1).includes('10 01|P'), 'bootloader lane: no 10 01');
  ok(runLogText().includes(t('udsTpl.fl.bootHeadMsg')), 'critical bootloader message logged');

  // Erase failure on segment 2 (NRC 0x72) → bootloader lane with segment + address in the message.
  const e = new FakeTransport();
  e.override = (sid, data) => (sid === 0x31 && data[1] === 0xff && data[2] === 0x00 && data[5] === 0x02 ? new Error('NRC 0x72 (generalProgrammingFailure)') : undefined);
  await runFlasher(e);
  ok(!e.lines().includes('DOWNLOAD'), 'erase failure: download never starts');
  ok(/2\/2/.test(runLogText()) && runLogText().includes('0x08020000') && runLogText().includes('NRC 0x72'), 'erase failure names segment, address and NRC');
  eq(e.lines().slice(-3), ['28 80 01|F|SPR', '85 81|F|SPR', 'KA STOP'], 'erase failure: bootloader lane');

  // Verify status 01 on segment 1 → bootloader lane
  const v = new FakeTransport();
  v.override = (sid, data) => (sid === 0x31 && data[1] === 0x02 && data[2] === 0x02 && data[3] === 0xde ? [0x71, 0x01, 0x02, 0x02, 0x01] : undefined);
  await runFlasher(v);
  ok(!v.uds().some((r) => r.sid === 0x31 && r.data[1] === 0xff && r.data[2] === 0x01), 'verify failure: FF01 not sent');
  eq(v.lines().slice(-3), ['28 80 01|F|SPR', '85 81|F|SPR', 'KA STOP'], 'verify failure: bootloader lane');
  ok(!v.uds().some((r) => r.sid === 0x11), 'verify failure: no reset');
}

// ─── 4. Functional request without functionalId ────────────────────────────────

async function noFunctionalId(): Promise<void> {
  const tr = new FakeTransport();
  tr.fid = null;
  await runFlasher(tr);
  ok(!tr.uds().some((r) => r.addressing === 'functional'), 'no functional request transmitted');
  ok(!tr.uds().some((r) => r.sid === 0x85 || r.sid === 0x28), 'no silent physical 85 / 28 fallback');
  ok(runLogText().includes(t('udsFlow.err.noFunctionalId')), 'clear functionalId error logged');
  eq(tr.lines().slice(-2), ['10 01|P', 'KA STOP'], 'safe-abort lane still runs its physical steps');
  assertNoProgramming(tr, 'no functionalId');
}

// ─── 5. Wait-ready ─────────────────────────────────────────────────────────────

async function waitReady(): Promise<void> {
  const tr = new FakeTransport();
  tr.override = (sid, data, _o, self) => {
    // Only the boot wait (after 10 02) fails 3 times.
    if (sid === 0x10 && data[0] === 0x02) self.probeFailures = 3;
    return undefined;
  };
  await runFlasher(tr);
  const l = tr.lines();
  const i = l.indexOf('10 02|P');
  eq(l.slice(i + 1, i + 6), ['3E 00|P', '3E 00|P', '3E 00|P', '3E 00|P', '27 11|P'], 'wait-ready: 3 failed probes, 4th answers, flow proceeds');
  ok(l.at(-1) === 'KA STOP' && runLogText().includes(t('udsTpl.fl.okMsg')), 'wait-ready: run completes');
  const probe = tr.uds().find((r) => r.sid === 0x3e);
  ok((probe?.timeoutMs ?? 0) > 0 && (probe?.timeoutMs ?? 0) <= 300, 'probe uses its own short timeout');

  const never = new FakeTransport();
  never.probeAlwaysFail = true;
  const t0 = Date.now();
  await runFlasher(never, () => flowStore.updateBlockConfig(blockByLabel(t('udsTpl.fl.waitBoot')).id, { initial_delay_ms: 100, poll_ms: 50, timeout_ms: 600 }));
  ok(Date.now() - t0 < 5000, 'wait-ready timeout honoured');
  ok(never.uds().filter((r) => r.sid === 0x3e).length >= 3, 'several probes before timeout');
  eq(never.lines().slice(-4), SAFE_TAIL, 'boot wait timeout → timeout_out → safe-abort lane');
  assertNoProgramming(never, 'boot wait timeout');

  // Reset wait timeout → bootloader lane (no second reset)
  const rst = new FakeTransport();
  rst.override = (sid, _d, _o, self) => {
    if (sid === 0x11) self.probeAlwaysFail = true;
    return undefined;
  };
  await runFlasher(rst, () => flowStore.updateBlockConfig(blockByLabel(t('udsTpl.fl.waitApp')).id, { initial_delay_ms: 50, poll_ms: 50, timeout_ms: 300 }));
  eq(rst.lines().slice(-3), ['28 80 01|F|SPR', '85 81|F|SPR', 'KA STOP'], 'reset wait timeout → bootloader lane');
  eq(rst.uds().filter((r) => r.sid === 0x11).length, 1, 'only one 11 01');
}

// ─── 6. Keep-alive stopped on every terminal path ──────────────────────────────

async function keepaliveRelease(): Promise<void> {
  // engine.stop() mid-run
  const tr = new FakeTransport();
  tr.delayMs = 40;
  loadFlasher();
  const engine = new FlowEngine();
  const run = engine.run({ transport: tr });
  while (!tr.recs.some((r) => r.kind === 'ka')) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 60));
  engine.stop();
  await run;
  eq(lastKa(tr), false, 'engine.stop(): keep-alive stopped');
  ok(!tr.uds().some((r) => r.sid === 0x31 && r.data[1] === 0xff), 'engine.stop(): no erase after stop');

  // Panic Stop (TX source registry) mid-run
  const p = new FakeTransport();
  p.delayMs = 40;
  loadFlasher();
  const run2 = new FlowEngine().run({ transport: p });
  while (!p.recs.some((r) => r.kind === 'ka')) await new Promise((r) => setTimeout(r, 5));
  stopAllTxSources();
  await run2;
  eq(lastKa(p), false, 'Panic Stop: keep-alive stopped');

  // Unhandled error (lane block missing): remove the safe-abort wiring of 22 F190 → run aborts
  const u = new FakeTransport();
  u.override = (sid, data) => (sid === 0x22 && data[1] === 0x90 ? new Error('NRC 0x22 (conditionsNotCorrect)') : undefined);
  await runFlasher(u, () => {
    const vin = blockByLabel(t('udsTpl.fl.readVin'));
    const d = diagram();
    const c = d.connections.find((x) => x.fromBlockId === vin.id && x.fromPortId === 'error_out');
    if (c) flowStore.removeConnection(c.id);
  });
  eq(u.lines().at(-1), 'KA STOP', 'unhandled error: engine still stops the keep-alive');
}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

function pureHelpers(): void {
  eq(bcd(26), 0x26, 'bcd');
  const d = new Date(2026, 10, 18, 9, 7);
  eq(hx(buildFingerprint({ format: 'iso_f15a', serial: 'AB', serialLen: 4, pad: 0x20, template: '' }, d)), '26 11 18 41 42 20 20', 'iso_f15a fingerprint');
  eq(hx(buildFingerprint({ format: 'custom', serial: 'XYZ', serialLen: 0, pad: 0x00, template: '01 {YY}{MM}{DD}{hh}{mm} {SERIAL:2} FF' }, d)), '01 26 11 18 09 07 58 59 FF', 'custom fingerprint');
  eq(asciiText(Uint8Array.from([0x53, 0x57, 0x31, 0x20, 0x00])), 'SW1', 'ascii padding stripped');
}

async function main(): Promise<void> {
  pureHelpers();
  checkStructure();
  await happyPath();
  await failBeforeErase();
  await failDuringFlash();
  await noFunctionalId();
  await waitReady();
  await keepaliveRelease();
  console.log(`ecuFlasher.test: ${passed} checks passed`);
}

// Top-level await: a failure rejects the module and node exits non-zero.
await main();
