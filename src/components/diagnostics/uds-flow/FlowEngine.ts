import type { FlowBlock, FlowDiagram } from './types';
import { flowStore } from './FlowStore';
import { t } from '../../../i18n';
import { crc16ibm, crc32, computeKey } from './flowAlgos';
import { demoFlowTransport, demoDelay, realFlowTransport } from './flowTransport';
import { RealFlowExecutor } from './flowReal';
import { flowPrompt } from './flowPrompt';
import { diagnosticsStore } from '../../../store/diagnosticsStore';
import { registerTxSource } from '../../../store/txSources';

// ─── Transports (see flowTransport.ts) ───────────────────────────────────────

function ts(): string {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function hexB(b: number): string {
  return b.toString(16).padStart(2, '0').toUpperCase();
}

function nrcName(nrc: number): string {
  const map: Record<number, string> = {
    0x10: 'generalReject',
    0x11: 'serviceNotSupported',
    0x12: 'subFunctionNotSupported',
    0x13: 'incorrectMessageLengthOrInvalidFormat',
    0x21: 'busyRepeatRequest',
    0x22: 'conditionsNotCorrect',
    0x24: 'requestSequenceError',
    0x31: 'requestOutOfRange',
    0x33: 'securityAccessDenied',
    0x35: 'invalidKey',
    0x36: 'exceededNumberOfAttempts',
    0x37: 'requiredTimeDelayNotExpired',
    0x70: 'uploadDownloadNotAccepted',
    0x71: 'transferDataSuspended',
    0x72: 'generalProgrammingFailure',
    0x73: 'wrongBlockSequenceCounter',
    0x7E: 'subFunctionNotSupportedInActiveSession',
    0x7F: 'serviceNotSupportedInActiveSession',
  };
  return `NRC 0x${hexB(nrc)}${map[nrc] ? ` (${map[nrc]})` : ''}`;
}

/** DEMO-only simulated request (used exclusively by `dispatchDemo`). */
async function udsRequest(sid: number, payload: number[]): Promise<Uint8Array> {
  return new Uint8Array(await demoFlowTransport.request(sid, payload));
}

async function randomDelay(min = 20, max = 80): Promise<void> {
  await demoDelay(min, max);
}

// ─── Run context ──────────────────────────────────────────────────────────────

export interface RunContext {
  sessionType: 'default' | 'extended' | 'programming' | 'safety';
  securityUnlocked: boolean;
  unlockedLevel: number;
  commControlled: boolean;  // disableRxAndTx aktif mi
  dtcSettingOff: boolean;   // DTCSetting off mu
  downloadActive: boolean;
  /** Real mode: the active transfer is an upload (0x35), not a download. */
  uploadActive: boolean;
  /** Real mode: maxNumberOfBlockLength reported by the ECU for the active transfer (0 = unknown). */
  maxBlockLen: number;
  downloadAddress: number;
  downloadSize: number;
  transferBlockSeq: number;
  transferredBytes: number;
  variables: Map<string, unknown>;
}

function newRunContext(): RunContext {
  return {
    sessionType: 'default',
    securityUnlocked: false,
    unlockedLevel: 0,
    commControlled: false,
    dtcSettingOff: false,
    downloadActive: false,
    uploadActive: false,
    maxBlockLen: 0,
    downloadAddress: 0,
    downloadSize: 0,
    transferBlockSeq: 1,
    transferredBytes: 0,
    variables: new Map(),
  };
}

function log(blockId: string, blockLabel: string, msg: string) {
  flowStore.addRunLog({ blockId, blockLabel, level: 'info', message: msg });
}

/** Blocks that are pure flow structure (no transport, no fabricated data) and run identically in real mode. */
const REAL_STRUCTURAL: ReadonlySet<string> = new Set(['start', 'end', 'delay', 'loop', 'flow_while', 'uds_lockout_guard']);

// ─── Engine ───────────────────────────────────────────────────────────────────

let flowEngineSeq = 0;

export class FlowEngine {
  private readonly _txSourceId = `uds-flow:${++flowEngineSeq}`;
  private _stopped = false;
  private _paused  = false;
  private _resumeResolve: (() => void) | null = null;
  private _ctx: RunContext = newRunContext();
  /** Snapshot of `diagnosticsStore.mockMode` at run start: true = simulation, false = live bus. */
  private _demo = false;
  private _real: RealFlowExecutor | null = null;

  stop():   void { this._stopped = true; this._resumeResolve?.(); flowPrompt.cancel(); }
  pause():  void { this._paused = true;  flowStore.setPaused(true); }
  resume(): void {
    this._paused = false; flowStore.setPaused(false);
    this._resumeResolve?.(); this._resumeResolve = null;
  }

  private async waitIfPaused(): Promise<void> {
    if (this._paused) await new Promise<void>((r) => { this._resumeResolve = r; });
  }

  async run(): Promise<void> {
    this._stopped = false;
    this._paused  = false;
    this._ctx     = newRunContext();
    this._demo    = diagnosticsStore.getState().mockMode;
    this._real    = this._demo
      ? null
      : new RealFlowExecutor(realFlowTransport, this._ctx, (b, msg) => log(b.id, b.label, `[${ts()}]   ${msg}`));

    // A flow run can transmit UDS requests on its own schedule: Panic Stop must be able to abort it.
    const unregisterTx = this._demo
      ? null
      : registerTxSource(this._txSourceId, () => {
          this.stop();
          flowStore.setRunning(false);
          flowStore.setPaused(false);
        });

    flowStore.setRunning(true);
    flowStore.resetBlockStatuses();
    flowStore.clearRunLog();
    flowStore.addRunLog({ blockId: '', blockLabel: 'Engine', level: 'info',
      message: `[${ts()}] ${t('diagEng.flowStarted')} (${this._demo ? t('diagReal.flow.modeDemo') : t('diagReal.flow.modeReal')})` });

    const { diagram } = flowStore.getSnapshot() as { diagram: FlowDiagram };
    const startBlock = diagram.blocks.find((b) => b.type === 'start');
    if (!startBlock) {
      flowStore.addRunLog({ blockId: '', blockLabel: 'Engine', level: 'error',
        message: `[${ts()}] ✗ ${t('diagEng.startNotFound')}` });
      flowStore.setRunning(false);
      unregisterTx?.();
      return;
    }

    try {
      await this.executeChain(startBlock);
    } catch (err) {
      flowStore.addRunLog({ blockId: '', blockLabel: 'Engine', level: 'error',
        message: `[${ts()}] ✗ ${err instanceof Error ? err.message : String(err)}` });
    }
    unregisterTx?.();

    flowStore.setRunning(false);
    flowStore.setPaused(false);
    if (!this._stopped) {
      flowStore.addRunLog({ blockId: '', blockLabel: 'Engine', level: 'info',
        message: `[${ts()}] ${t('diagEng.flowDone')}` });
    }
  }

  private async executeChain(block: FlowBlock): Promise<void> {
    if (this._stopped) return;
    await this.waitIfPaused();
    if (this._stopped) return;
    const result = await this.executeBlock(block);
    if (this._stopped) return;
    if (result.nextPortId) {
      const next = this.findNextBlock(block.id, result.nextPortId);
      if (next) await this.executeChain(next);
    }
  }

  private async executeBlock(block: FlowBlock): Promise<{ nextPortId: string; result?: unknown }> {
    const { diagram } = flowStore.getSnapshot() as { diagram: FlowDiagram };
    flowStore.setBlockStatus(block.id, 'running');

    try {
      const outcome = await this.dispatchBlock(block);
      if (this._real) this._real.record(block, outcome);
      flowStore.setBlockStatus(block.id, 'success', outcome.message);
      flowStore.setBlockResult(block.id, outcome.result);
      flowStore.addRunLog({ blockId: block.id, blockLabel: block.label, level: 'success',
        message: `[${ts()}] ✓ ${block.label}  →  ${outcome.message}` });

      if (block.type === 'loop') {
        const iters = Number(block.config['iterations'] ?? 3);
        for (let i = 1; i < iters; i++) {
          if (this._stopped) break;
          await this.waitIfPaused();
          if (this._stopped) break;
          const bodyNext = this.findNextBlock(block.id, 'body_out');
          if (bodyNext) await this.executeChain(bodyNext);
        }
        return { nextPortId: 'done_out', result: outcome.result };
      }
      if (block.type === 'flow_while') {
        const maxIter = Number(block.config['max_iterations'] ?? 100);
        let iterCount = 0;
        if (this._real) {
          // Real: re-evaluate the connected bool input before every iteration (no fixed fake count).
          while (iterCount < maxIter) {
            if (this._stopped) break;
            await this.waitIfPaused();
            if (this._stopped || !(await this._real.evalBool(block, 'bool_in'))) break;
            iterCount++;
            const bodyNext = this.findNextBlock(block.id, 'body_out');
            if (bodyNext) await this.executeChain(bodyNext);
          }
          return { nextPortId: 'done_out', result: iterCount };
        }
        // DEMO: body runs 3 times (simulation)
        while (iterCount < Math.min(3, maxIter)) {
          if (this._stopped) break;
          await this.waitIfPaused();
          iterCount++;
          const bodyNext = this.findNextBlock(block.id, 'body_out');
          if (bodyNext) await this.executeChain(bodyNext);
        }
        return { nextPortId: 'done_out', result: iterCount };
      }
      if (block.type === 'condition') return { nextPortId: outcome.result ? 'true_out' : 'false_out', result: outcome.result };
      if (block.type === 'assert')    return { nextPortId: outcome.result ? 'pass_out' : 'fail_out', result: outcome.result };

      return { nextPortId: outcome.nextPort ?? 'exec_out', result: outcome.result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      flowStore.setBlockStatus(block.id, 'error', msg);
      flowStore.addRunLog({ blockId: block.id, blockLabel: block.label, level: 'error',
        message: `[${ts()}] ✗ ${block.label}  →  ${msg}` });
      const hasErrOut = diagram.connections.some((c) => c.fromBlockId === block.id && c.fromPortId === 'error_out');
      if (hasErrOut) return { nextPortId: 'error_out' };
      throw err;
    }
  }

  /** Real mode: structural blocks without any bus/data content run as-is; everything else is live. */
  private async dispatchBlock(
    block: FlowBlock,
  ): Promise<{ message: string; result?: unknown; nextPort?: string; outputs?: Record<string, unknown> }> {
    if (this._real && !REAL_STRUCTURAL.has(block.type)) return this._real.execute(block);
    return this.dispatchDemo(block);
  }

  /**
   * DEMO simulation (random latency / NRCs / fabricated records). Reached in real mode ONLY for the
   * structural blocks in `REAL_STRUCTURAL`, which contain no simulated data.
   */
  private async dispatchDemo(
    block: FlowBlock,
  ): Promise<{ message: string; result?: unknown; nextPort?: string }> {
    const ctx = this._ctx;

    switch (block.type) {

      // ── FLOW ─────────────────────────────────────────────────────────────────

      case 'start': return { message: t('diagEng.startMsg') };
      case 'end':   return { message: t('diagEng.endMsg') };

      case 'delay': {
        const ms = Number(block.config['delay_ms'] ?? 1000);
        log(block.id, block.label, `[${ts()}]   ${t('diagEng.delayWaiting', { ms })}`);
        await new Promise<void>((r) => setTimeout(r, ms));
        return { message: t('diagEng.delayDone', { ms }) };
      }

      case 'condition': return { message: t('diagEng.condEval'), result: true };
      case 'loop':      return { message: t('diagEng.loopStart', { n: String(block.config['iterations'] ?? 3) }) };
      case 'assert':    return { message: t('diagEng.assertPass'), result: true };

      case 'log': {
        const msg = String(block.config['message'] ?? '');
        log(block.id, block.label, `[${ts()}]   LOG: ${msg || t('diagEng.empty')}`);
        return { message: msg || t('diagEng.emptyMsg') };
      }

      case 'flow_while': {
        const maxIter = Number(block.config['max_iterations'] ?? 100);
        // The actual loop execution is handled in executeBlock — just return the message
        return { message: t('diagEng.whileLoop', { max: maxIter }) };
      }

      case 'flow_timeout_guard': {
        const timeoutMs = Number(block.config['timeout_ms'] ?? 5000);
        log(block.id, block.label, `[${ts()}]   ${t('diagEng.timeoutActive', { ms: timeoutMs })}`);
        return { message: t('diagEng.timeoutGuard', { ms: timeoutMs }) };
      }

      // ── 0x10 DiagnosticSessionControl ────────────────────────────────────────

      case 'uds_session': {
        const st = (block.config['session_type'] as string) ?? 'extended';
        const subFn: Record<string, number> = { default: 0x01, programming: 0x02, extended: 0x03, safety: 0x04 };
        const sf = subFn[st] ?? 0x03;

        log(block.id, block.label, `[${ts()}]   TX: 10 ${hexB(sf)}  (DiagnosticSessionControl)`);
        const resp = await udsRequest(0x10, [sf, 0x00, 0x19, 0x01, 0xF4]);
        const p2ms  = ((resp[2] << 8) | resp[3]) * 0.5;
        const p2ext = ((resp[4] << 8) | resp[5]) * 10;
        log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}  P2=${p2ms}ms P2*=${p2ext}ms`);

        ctx.sessionType = st as RunContext['sessionType'];
        return { message: t('diagEng.sessionOpened', { st: st.toUpperCase(), p2: p2ms }), result: { sessionType: st, p2: p2ms, p2ext } };
      }

      // ── 0x11 ECUReset ─────────────────────────────────────────────────────────

      case 'uds_ecu_reset': {
        const rt = (block.config['reset_type'] as string) ?? 'hardReset';
        const rtBytes: Record<string, number> = { hardReset: 0x01, keyOffOnReset: 0x02, softReset: 0x03, enableRapidPowerShutDown: 0x04 };
        const sf = rtBytes[rt] ?? 0x01;

        if (ctx.sessionType === 'default') throw new Error(nrcName(0x7F));

        log(block.id, block.label, `[${ts()}]   TX: 11 ${hexB(sf)}  (ECUReset)`);
        const resp = await udsRequest(0x11, [sf]);
        log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}`);

        ctx.sessionType      = 'default';
        ctx.securityUnlocked = false;
        ctx.commControlled   = false;

        const labels: Record<string, string> = { hardReset: 'Hard', keyOffOnReset: 'Key Off/On', softReset: 'Soft', enableRapidPowerShutDown: 'Rapid Shutdown' };
        return { message: t('diagEng.ecuReset', { type: labels[rt] ?? rt }) };
      }

      // ── 0x14 ClearDiagnosticInformation ──────────────────────────────────────

      case 'uds_clear_dtc': {
        const group = String(block.config['group'] ?? 'FFFFFF').toUpperCase().replace(/[^0-9A-F]/g, '').padStart(6, '0');
        const gb = [parseInt(group.slice(0, 2), 16), parseInt(group.slice(2, 4), 16), parseInt(group.slice(4, 6), 16)];

        log(block.id, block.label, `[${ts()}]   TX: 14 ${gb.map(hexB).join(' ')}  (ClearDiagnosticInformation)`);
        const resp = await udsRequest(0x14, gb);
        log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}`);

        return { message: t('diagEng.dtcGroupCleared', { group }) };
      }

      // ── 0x19 ReadDTCInformation ───────────────────────────────────────────────

      case 'uds_read_dtc': {
        const subFnVal  = String(block.config['sub_fn'] ?? '02');
        const sf        = parseInt(subFnVal, 16);
        const statusMask = parseInt(String(block.config['status_mask'] ?? 'FF'), 16);

        log(block.id, block.label, `[${ts()}]   TX: 19 ${hexB(sf)} ${hexB(statusMask)}  (ReadDTCInformation subFn=0x${hexB(sf)})`);
        await udsRequest(0x19, [sf, statusMask]);

        // subFn 0x01 / 0x07 / 0x11: return count only
        if ([0x01, 0x07, 0x11].includes(sf)) {
          const count = sf === 0x07 ? 1 : 3;
          log(block.id, block.label, `[${ts()}]   RX: 59 ${hexB(sf)} FF 00 ${hexB(count)}  (${t('diagEng.dtcMatched', { n: count })})`);
          return { message: t('diagEng.dtcCount', { count, sf: hexB(sf), mask: hexB(statusMask) }), result: count };
        }

        // subFn 0x0A / 0x0B / 0x0C / 0x0D / 0x0E: single/all DTC lists
        if ([0x0A, 0x0B, 0x0C, 0x0D, 0x0E].includes(sf)) {
          const supported = ['P0100', 'P0200', 'P0300', 'C0010', 'U0100', 'U0073'];
          const single = [0x0B, 0x0C, 0x0D, 0x0E].includes(sf);
          const result = single ? [supported[0]] : supported;
          result.forEach((d) => log(block.id, block.label, `[${ts()}]       ${d}`));
          return { message: `${result.length} DTC (subFn=0x${hexB(sf)})`, result };
        }

        // subFn 0x09: severity info for specific DTC
        if (sf === 0x09) {
          log(block.id, block.label, `[${ts()}]   RX: 59 09 00 P0100  status=0x08  severity=0x20`);
          return { message: t('diagEng.dtcSeverity'), result: { dtc: 'P0100', severity: 0x20 } };
        }

        // subFn 0x14 / 0x15 / 0x55: fault detection counter / permanent DTCs
        if ([0x14, 0x15, 0x55].includes(sf)) {
          log(block.id, block.label, `[${ts()}]   RX: 59 ${hexB(sf)}  P0100 counter=127  P0300 permanent`);
          return { message: t('diagEng.dtcCustom', { sf: hexB(sf) }), result: [] };
        }

        // subFn 0x02 / 0x05 / 0x08 / 0x0F / 0x42: list by mask/severity
        const mockDtcs = [
          { code: 'P0100', raw: [0x01, 0x00, 0x09], status: 0x08, desc: t('diagEng.dtcDescP0100') },
          { code: 'P0300', raw: [0x03, 0x00, 0x00], status: 0x09, desc: t('diagEng.dtcDescP0300') },
          { code: 'U0100', raw: [0x50, 0x01, 0x00], status: 0x08, desc: t('diagEng.dtcDescU0100') },
        ];
        log(block.id, block.label, `[${ts()}]   RX: 59 ${hexB(sf)} FF  ${t('diagEng.dtcRecords', { n: mockDtcs.length })}`);
        mockDtcs.forEach((d) => {
          log(block.id, block.label, `[${ts()}]       ${d.code}  status=0x${hexB(d.status)}  ${d.desc}`);
        });
        return { message: `${mockDtcs.length} DTC (subFn=0x${hexB(sf)}, mask=0x${hexB(statusMask)})`, result: mockDtcs };
      }

      // ── 0x22 ReadDataByIdentifier ─────────────────────────────────────────────

      case 'uds_read_did': {
        const did = String(block.config['did'] ?? 'F190').toUpperCase().replace(/[^0-9A-F]/g, '').padStart(4, '0');
        const didBytes = [parseInt(did.slice(0, 2), 16), parseInt(did.slice(2, 4), 16)];

        log(block.id, block.label, `[${ts()}]   TX: 22 ${didBytes.map(hexB).join(' ')}  (ReadDataByIdentifier 0x${did})`);
        await udsRequest(0x22, didBytes);

        const mockData: Record<string, { label: string; raw: number[]; display: string }> = {
          'F190': { label: 'VIN',              raw: [0x57,0x4E,0x58,0x53,0x59,0x4E,0x54,0x48,0x30,0x30,0x30,0x30,0x30,0x30,0x30,0x30,0x31], display: 'WNXSYNTH000000001' },
          'F188': { label: 'ECU Software No',  raw: [0x53,0x57,0x5F,0x76,0x32,0x2E,0x33,0x2E,0x31], display: 'SW_v2.3.1' },
          'F187': { label: 'ECU Part No',      raw: [0x50,0x4E,0x2D,0x37,0x36,0x35,0x34,0x33,0x32,0x31], display: 'PN-7654321' },
          'F18C': { label: 'ECU Serial No',    raw: [0x45,0x43,0x55,0x2D,0x30,0x30,0x31,0x32,0x33], display: 'ECU-00123' },
          'F197': { label: 'System Name',      raw: [0x45,0x4E,0x47,0x49,0x4E,0x45,0x5F,0x43,0x54,0x52,0x4C], display: 'ENGINE_CTRL' },
          'F1A0': { label: 'Calibration ID',   raw: [0x43,0x41,0x4C,0x5F,0x32,0x30,0x32,0x34,0x2D,0x41], display: 'CAL_2024-A' },
          'F1A2': { label: 'Fingerprint',      raw: [0x4E,0x45,0x58,0x55,0x53,0x43,0x41,0x4E,0x5F,0x44,0x45,0x56], display: 'NEXUSCAN_DEV' },
          'F180': { label: 'Boot Software ID', raw: [0x42,0x4F,0x4F,0x54,0x5F,0x31,0x2E,0x30,0x2E,0x32], display: 'BOOT_1.0.2' },
          'F182': { label: 'App Software ID',  raw: [0x41,0x50,0x50,0x5F,0x32,0x2E,0x33,0x2E,0x31], display: 'APP_2.3.1' },
        };

        const entry = mockData[did] ?? { label: `DID 0x${did}`, raw: [0xDE, 0xAD, 0xBE, 0xEF], display: '0xDEADBEEF' };
        const rawBytes = new Uint8Array(entry.raw);
        log(block.id, block.label, `[${ts()}]   RX: 62 ${didBytes.map(hexB).join(' ')} ${entry.raw.map(hexB).join(' ')}`);
        log(block.id, block.label, `[${ts()}]       ${entry.label}: "${entry.display}"`);

        return { message: `0x${did} (${entry.label}) = "${entry.display}"`, result: { did, label: entry.label, raw: rawBytes, display: entry.display } };
      }

      // ── 0x23 ReadMemoryByAddress ──────────────────────────────────────────────

      case 'uds_read_memory': {
        const addrHex = String(block.config['memory_address'] ?? '08000000').toUpperCase().replace(/[^0-9A-F]/g, '');
        const sizeHex = String(block.config['memory_size']    ?? '00000010').toUpperCase().replace(/[^0-9A-F]/g, '');
        const addrBytes = addrHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [0x08,0,0,0];
        const sizeBytes = sizeHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [0,0,0,0x10];
        const addrLen = addrBytes.length;
        const sizeLen = sizeBytes.length;
        const memFmt  = ((addrLen & 0xF) << 4) | (sizeLen & 0xF);

        log(block.id, block.label, `[${ts()}]   TX: 23 ${hexB(memFmt)} ${addrBytes.map(hexB).join(' ')} ${sizeBytes.map(hexB).join(' ')}  (ReadMemoryByAddress)`);
        await udsRequest(0x23, [memFmt, ...addrBytes, ...sizeBytes]);

        const dataSize = parseInt(sizeHex, 16);
        const mockData = new Uint8Array(Math.min(dataSize, 32));
        for (let i = 0; i < mockData.length; i++) mockData[i] = (parseInt(addrHex, 16) + i) & 0xFF;
        log(block.id, block.label, `[${ts()}]   RX: 63 ${hex(mockData)}${dataSize > 32 ? ` ... (${dataSize} bytes total)` : ''}`);

        return { message: `${t('diagEng.memRead', { addr: addrHex, size: dataSize })}`, result: mockData };
      }

      // ── 0x27 SecurityAccess ───────────────────────────────────────────────────

      case 'uds_security_access': {
        // ISO 14229-1 Table 23: SecurityAccess NOT available in default session
        if (ctx.sessionType === 'default') throw new Error(nrcName(0x7F) + ` — ${t('diagEng.needExtProg')}`);

        const accessLevelHex = String(block.config['access_level'] ?? '01').toUpperCase().replace(/[^0-9A-F]/g, '').padStart(2, '0');
        const oddLevel       = parseInt(accessLevelHex, 16);
        const evenLevel      = oddLevel + 1;
        const algorithm      = String(block.config['algorithm'] ?? 'xor_ff');
        const constantHex    = String(block.config['constant']  ?? '5A3C1E8F');
        const script         = String(block.config['script']    ?? '');

        // ── Step 1: Request seed ─────────────────────────────────────────────
        log(block.id, block.label, `[${ts()}]   [1/3] TX: 27 ${hexB(oddLevel)}  (SecurityAccess — requestSeed level=0x${accessLevelHex})`);
        await randomDelay(30, 80);
        const seedBytes = new Uint8Array(4);
        crypto.getRandomValues(seedBytes);
        const seedResp = new Uint8Array([0x67, oddLevel, ...seedBytes]);
        log(block.id, block.label, `[${ts()}]   [1/3] RX: ${hex(seedResp)}  seed=${hex(seedBytes)}`);

        // Check for zero seed (already unlocked in some ECUs)
        if (seedBytes.every((b) => b === 0x00)) {
          log(block.id, block.label, `[${ts()}]   [1/3] ${t('diagEng.seedZero')}`);
          ctx.securityUnlocked = true;
          ctx.unlockedLevel = oddLevel;
          return { message: `${t('diagEng.secAlreadyOpen', { level: accessLevelHex })}`, result: { seed: seedBytes, key: new Uint8Array(0), level: oddLevel }, nextPort: 'success_out' };
        }

        // ── Step 2: Calculate key ────────────────────────────────────────────
        log(block.id, block.label, `[${ts()}]   [2/3] ${t('diagEng.keyCalc', { algorithm })}`);
        let keyBytes: Uint8Array;
        try {
          keyBytes = await computeKey(algorithm, seedBytes, oddLevel, constantHex, script);
        } catch (e) {
          throw new Error(t('diagEng.scriptError', { msg: e instanceof Error ? e.message : String(e) }));
        }
        log(block.id, block.label, `[${ts()}]   [2/3] key = ${hex(keyBytes)}`);

        // ── Step 3: Send key ─────────────────────────────────────────────────
        const keyPayload = [evenLevel, ...keyBytes];
        log(block.id, block.label, `[${ts()}]   [3/3] TX: 27 ${keyPayload.map(hexB).join(' ')}  (SecurityAccess — sendKey level=0x${hexB(evenLevel)})`);
        await randomDelay(30, 80);

        if (Math.random() < 0.04) throw new Error(nrcName(0x35));

        const keyResp = new Uint8Array([0x67, evenLevel]);
        log(block.id, block.label, `[${ts()}]   [3/3] RX: ${hex(keyResp)}  → ${t('diagEng.accessGranted')}`);

        ctx.securityUnlocked = true;
        ctx.unlockedLevel    = oddLevel;

        return {
          message: `Security Access 0x${accessLevelHex} [${algorithm}]  seed=${hex(seedBytes)}  key=${hex(keyBytes)}`,
          result:  { seed: seedBytes, key: keyBytes, level: oddLevel },
          nextPort: 'success_out',
        };
      }

      // ── Lockout Guard ─────────────────────────────────────────────────────────

      case 'uds_lockout_guard': {
        const maxAttempts = Number(block.config['max_attempts'] ?? 3);
        const lockoutMs   = Number(block.config['lockout_ms']   ?? 10000);

        // Use ctx.variables to track attempt count per block
        const countKey = `_lockout_${block.id}`;
        const lockedKey = `_lockout_locked_${block.id}`;
        const lockedUntil = ctx.variables.get(lockedKey) as number | undefined;

        if (lockedUntil && Date.now() < lockedUntil) {
          const remaining = Math.ceil((lockedUntil - Date.now()) / 1000);
          log(block.id, block.label, `[${ts()}]   ⚠ ${t('diagEng.lockActive', { s: remaining })}`);
          return { message: t('diagEng.lockActiveShort', { s: remaining }), nextPort: 'delay_out' };
        }

        const attempts = (ctx.variables.get(countKey) as number ?? 0) + 1;
        ctx.variables.set(countKey, attempts);

        if (attempts > maxAttempts) {
          ctx.variables.set(lockedKey, Date.now() + lockoutMs);
          ctx.variables.set(countKey, 0);
          log(block.id, block.label, `[${ts()}]   ✗ ${t('diagEng.maxAttempts', { max: maxAttempts, ms: lockoutMs })}`);
          return { message: t('diagEng.lockoutMsg', { nrc: nrcName(0x36), ms: lockoutMs }), nextPort: 'delay_out' };
        }

        log(block.id, block.label, `[${ts()}]   ${t('diagEng.attemptAllowed', { a: attempts, max: maxAttempts })}`);
        return { message: t('diagEng.attemptShort', { a: attempts, max: maxAttempts }), result: attempts };
      }

      // ── Seed/Key Validator ────────────────────────────────────────────────────

      case 'uds_seed_validator': {
        const expectedHex = String(block.config['expected_key'] ?? 'C9A8').replace(/[^0-9a-fA-F]/g, '');

        log(block.id, block.label, `[${ts()}]   ${t('diagEng.expectedKey', { key: expectedHex || t('diagEng.empty') })}`);
        log(block.id, block.label, `[${ts()}]   ${t('diagEng.mockVerify')}`);

        const passed = Math.random() > 0.1; // 90% pass in simulation
        if (passed) {
          log(block.id, block.label, `[${ts()}]   ✓ ${t('diagEng.keyMatched')}`);
          return { message: t('diagEng.keyVerified'), result: { valid: true, expected: expectedHex }, nextPort: 'pass_out' };
        } else {
          log(block.id, block.label, `[${ts()}]   ✗ ${t('diagEng.keyMismatchLog', { nrc: nrcName(0x35) })}`);
          return { message: t('diagEng.keyMismatchMsg', { nrc: nrcName(0x35) }), result: { valid: false, expected: expectedHex }, nextPort: 'fail_out' };
        }
      }

      // ── 0x28 CommunicationControl ─────────────────────────────────────────────

      case 'uds_comm_control': {
        // ISO 14229-1 Table 23: CommunicationControl NOT available in default session
        if (ctx.sessionType === 'default') throw new Error(nrcName(0x7F) + ` — ${t('diagEng.needExtProg')}`);

        const ctrlType = String(block.config['control_type'] ?? '03');
        const commType = String(block.config['comm_type']    ?? '01');
        const ctrlByte = parseInt(ctrlType, 16);
        const commByte = parseInt(commType, 16);
        const ctrlLabel: Record<string, string> = {
          '00': 'enableRxAndTx', '01': 'enableRxAndDisableTx',
          '02': 'disableRxAndEnableTx', '03': 'disableRxAndTx',
        };

        log(block.id, block.label, `[${ts()}]   TX: 28 ${hexB(ctrlByte)} ${hexB(commByte)}  (CommunicationControl — ${ctrlLabel[ctrlType] ?? ctrlType})`);
        const resp = await udsRequest(0x28, [ctrlByte, commByte]);
        log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}`);

        ctx.commControlled = ctrlType === '03';
        return { message: `CommunicationControl: ${ctrlLabel[ctrlType] ?? ctrlType}` };
      }

      // ── 0x2E WriteDataByIdentifier ────────────────────────────────────────────

      case 'uds_write_did': {
        const did = String(block.config['did'] ?? 'F190').toUpperCase().replace(/[^0-9A-F]/g, '').padStart(4, '0');
        const didBytes = [parseInt(did.slice(0, 2), 16), parseInt(did.slice(2, 4), 16)];
        if (!ctx.securityUnlocked) throw new Error(nrcName(0x33));
        log(block.id, block.label, `[${ts()}]   TX: 2E ${didBytes.map(hexB).join(' ')} <data>  (WriteDataByIdentifier 0x${did})`);
        const resp = await udsRequest(0x2E, [...didBytes, 0x00]);
        log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}`);
        return { message: t('diagEng.didWritten', { did }) };
      }

      // ── 0x2F InputOutputControlByIdentifier ──────────────────────────────────

      case 'uds_io_control': {
        const did = String(block.config['did'] ?? '3001').toUpperCase().replace(/[^0-9A-F]/g, '').padStart(4, '0');
        const didBytes  = [parseInt(did.slice(0, 2), 16), parseInt(did.slice(2, 4), 16)];
        const ctrlOpt   = parseInt(String(block.config['io_control'] ?? '03'), 16);
        const ctrlVal   = parseInt(String(block.config['control_value'] ?? '00'), 16);
        const ctrlLabel: Record<number, string> = { 0: 'returnControlToECU', 1: 'resetToDefault', 2: 'freezeCurrentState', 3: 'shortTermAdjustment' };

        log(block.id, block.label, `[${ts()}]   TX: 2F ${didBytes.map(hexB).join(' ')} ${hexB(ctrlOpt)} ${hexB(ctrlVal)}  (InputOutputControl ${ctrlLabel[ctrlOpt] ?? ''})`);
        const resp = await udsRequest(0x2F, [...didBytes, ctrlOpt, ctrlVal]);
        log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}`);

        return { message: `IO Control 0x${did}: ${ctrlLabel[ctrlOpt] ?? ctrlOpt}`, result: resp };
      }

      // ── 0x31 RoutineControl ───────────────────────────────────────────────────

      case 'uds_routine_ctrl': {
        const ctrlType = String(block.config['control_type'] ?? '01');
        const ridSel   = String(block.config['routine_id'] ?? 'FF00');
        const rid      = ridSel === 'custom'
          ? String(block.config['routine_id_custom'] ?? '0203').toUpperCase().replace(/[^0-9A-F]/g, '').padStart(4, '0')
          : ridSel.toUpperCase();
        const ridBytes  = [parseInt(rid.slice(0, 2), 16), parseInt(rid.slice(2, 4), 16)];
        const ctrlByte  = parseInt(ctrlType, 16);
        const ctrlLabel: Record<string, string> = { '01': 'startRoutine', '02': 'stopRoutine', '03': 'requestRoutineResults' };
        const ridNames: Record<string, string> = {
          'FF00': 'eraseMemory',
          '0202': 'checkProgrammingDependencies',
          '0203': 'eraseMirrorMemoryDTCs',
          'DF01': 'checkMemoryIntegrity',
          'E200': 'requestSoftwareUpdate',
        };

        log(block.id, block.label, `[${ts()}]   TX: 31 ${hexB(ctrlByte)} ${ridBytes.map(hexB).join(' ')}  (RoutineControl — 0x${rid} ${ridNames[rid] ?? ''} ${ctrlLabel[ctrlType] ?? ''})`);
        await udsRequest(0x31, [ctrlByte, ...ridBytes]);

        const resultBytes = ctrlType === '03' ? new Uint8Array([0x00, 0x01]) : new Uint8Array([0x00]);
        log(block.id, block.label, `[${ts()}]   RX: 71 ${hexB(ctrlByte)} ${ridBytes.map(hexB).join(' ')} ${hex(resultBytes)}`);

        return { message: `Rutin 0x${rid} (${ctrlLabel[ctrlType] ?? ctrlType}) → ${hex(resultBytes)}`, result: resultBytes };
      }

      // ── 0x34 RequestDownload ──────────────────────────────────────────────────

      case 'uds_req_download': {
        if (ctx.sessionType !== 'programming') throw new Error(nrcName(0x7F) + ` — ${t('diagEng.needProg')}`);
        if (!ctx.securityUnlocked)             throw new Error(nrcName(0x33) + ` — ${t('diagEng.needSecurity')}`);

        const addrHex = String(block.config['memory_address'] ?? '08000000').toUpperCase().replace(/[^0-9A-F]/g, '');
        const sizeHex = String(block.config['memory_size']    ?? '00010000').toUpperCase().replace(/[^0-9A-F]/g, '');
        const fmtHex  = String(block.config['data_format']    ?? '00').toUpperCase().replace(/[^0-9A-F]/g, '');
        const fmtByte   = parseInt(fmtHex, 16);
        const addrBytes = addrHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [0x08,0,0,0];
        const sizeBytes = sizeHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [0,0x01,0,0];
        const memFmt    = ((addrBytes.length & 0xF) << 4) | (sizeBytes.length & 0xF);

        log(block.id, block.label, `[${ts()}]   TX: 34 ${hexB(fmtByte)} ${hexB(memFmt)} ${addrBytes.map(hexB).join(' ')} ${sizeBytes.map(hexB).join(' ')}  (RequestDownload)`);
        await udsRequest(0x34, [fmtByte, memFmt, ...addrBytes, ...sizeBytes]);

        const maxBlockLen = 0x0802;
        log(block.id, block.label, `[${ts()}]   RX: 74 20 ${hexB((maxBlockLen >> 8) & 0xFF)} ${hexB(maxBlockLen & 0xFF)}  maxBlockLen=0x${maxBlockLen.toString(16).toUpperCase()}`);

        ctx.downloadActive   = true;
        ctx.downloadAddress  = parseInt(addrHex, 16);
        ctx.downloadSize     = parseInt(sizeHex, 16);
        ctx.transferBlockSeq = 1;
        ctx.transferredBytes = 0;

        return { message: t('diagEng.downloadAccepted', { addr: addrHex, size: sizeHex, max: maxBlockLen.toString(16).toUpperCase() }), result: { address: ctx.downloadAddress, size: ctx.downloadSize, maxBlockLen } };
      }

      // ── 0x35 RequestUpload ────────────────────────────────────────────────────

      case 'uds_req_upload': {
        const addrHex = String(block.config['memory_address'] ?? '08000000').toUpperCase().replace(/[^0-9A-F]/g, '');
        const sizeHex = String(block.config['memory_size']    ?? '00010000').toUpperCase().replace(/[^0-9A-F]/g, '');
        const fmtHex  = String(block.config['data_format']    ?? '00');
        const fmtByte   = parseInt(fmtHex, 16);
        const addrBytes = addrHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [0x08,0,0,0];
        const sizeBytes = sizeHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [0,0x01,0,0];
        const memFmt    = ((addrBytes.length & 0xF) << 4) | (sizeBytes.length & 0xF);

        log(block.id, block.label, `[${ts()}]   TX: 35 ${hexB(fmtByte)} ${hexB(memFmt)} ${addrBytes.map(hexB).join(' ')} ${sizeBytes.map(hexB).join(' ')}  (RequestUpload)`);
        await udsRequest(0x35, [fmtByte, memFmt, ...addrBytes, ...sizeBytes]);

        const maxBlockLen = 0x0802;
        log(block.id, block.label, `[${ts()}]   RX: 75 20 ${hexB((maxBlockLen >> 8) & 0xFF)} ${hexB(maxBlockLen & 0xFF)}`);

        ctx.downloadActive   = true;
        ctx.downloadSize     = parseInt(sizeHex, 16);
        ctx.transferBlockSeq = 1;
        ctx.transferredBytes = 0;

        return { message: t('diagEng.uploadAccepted', { addr: addrHex, size: sizeHex }), result: { address: parseInt(addrHex, 16), size: ctx.downloadSize } };
      }

      // ── 0x36 TransferData ─────────────────────────────────────────────────────

      case 'uds_transfer_data': {
        if (!ctx.downloadActive) throw new Error(nrcName(0x24) + ` — ${t('diagEng.needDownloadFirst')}`);

        const chunkSize  = parseInt(String(block.config['chunk_size'] ?? '0800').replace(/[^0-9a-fA-F]/g, ''), 16) || 0x0800;
        const seq        = ctx.transferBlockSeq;
        const remaining  = ctx.downloadSize - ctx.transferredBytes;
        const thisChunk  = Math.min(chunkSize, remaining);

        log(block.id, block.label, `[${ts()}]   TX: 36 ${hexB(seq)} <${thisChunk} bytes data>  (TransferData blockSeq=${seq})`);
        await randomDelay(40, 160);

        if (Math.random() < 0.01) throw new Error(nrcName(0x73) + ` ${t('diagEng.blockSeqExpected', { seq })}`);

        const resp = new Uint8Array([0x76, seq & 0xFF]);
        ctx.transferredBytes += thisChunk;
        ctx.transferBlockSeq  = (seq % 0xFF) + 1;

        const pct = Math.min(100, Math.round((ctx.transferredBytes / ctx.downloadSize) * 100));
        log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}  [${pct}%]  ${ctx.transferredBytes}/${ctx.downloadSize} bytes`);

        return { message: t('diagEng.blockMsg', { seq, done: ctx.transferredBytes, total: ctx.downloadSize, pct }), result: { seq, transferred: ctx.transferredBytes, total: ctx.downloadSize, percent: pct } };
      }

      // ── 0x37 RequestTransferExit ──────────────────────────────────────────────

      case 'uds_transfer_exit': {
        if (!ctx.downloadActive) throw new Error(nrcName(0x24) + ` — ${t('diagEng.noActiveTransfer')}`);

        log(block.id, block.label, `[${ts()}]   TX: 37  (RequestTransferExit)`);
        const resp = await udsRequest(0x37, []);
        log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}  — ${t('diagEng.transferDoneLog')}`);

        const transferred = ctx.transferredBytes;
        ctx.downloadActive   = false;
        ctx.transferredBytes = 0;

        return { message: t('diagEng.transferDoneMsg', { n: transferred }) };
      }

      // ── 0x3D WriteMemoryByAddress ──────────────────────────────────────────────

      case 'uds_write_memory': {
        if (!ctx.securityUnlocked) throw new Error(nrcName(0x33) + ` — ${t('diagEng.needSecurity')}`);

        const addrHex = String(block.config['memory_address'] ?? '08000000').toUpperCase().replace(/[^0-9A-F]/g, '');
        const sizeHex = String(block.config['memory_size']    ?? '00000010').toUpperCase().replace(/[^0-9A-F]/g, '');
        const addrBytes = addrHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [0x08,0,0,0];
        const sizeBytes = sizeHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [0,0,0,0x10];
        const memFmt    = ((addrBytes.length & 0xF) << 4) | (sizeBytes.length & 0xF);

        log(block.id, block.label, `[${ts()}]   TX: 3D ${hexB(memFmt)} ${addrBytes.map(hexB).join(' ')} ${sizeBytes.map(hexB).join(' ')} <data>  (WriteMemoryByAddress)`);
        const resp = await udsRequest(0x3D, [memFmt, ...addrBytes, ...sizeBytes]);
        log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}`);

        return { message: `WriteMemory 0x${addrHex}  size=0x${sizeHex}` };
      }

      // ── 0x3E TesterPresent ────────────────────────────────────────────────────

      case 'uds_tester_present': {
        const suppress = !!block.config['suppress'];
        const sf       = suppress ? 0x80 : 0x00;
        log(block.id, block.label, `[${ts()}]   TX: 3E ${hexB(sf)}  (TesterPresent suppress=${suppress})`);
        if (!suppress) {
          await randomDelay(10, 30);
          log(block.id, block.label, `[${ts()}]   RX: 7E 00`);
        }
        return { message: `TesterPresent${suppress ? ' (suppress)' : ''}` };
      }

      // ── 0x85 ControlDTCSetting ────────────────────────────────────────────────

      case 'uds_dtc_setting': {
        // ISO 14229-1 Table 23: ControlDTCSetting NOT available in default session
        if (ctx.sessionType === 'default') throw new Error(nrcName(0x7F) + ` — ${t('diagEng.needExtProg')}`);

        const st = String(block.config['setting_type'] ?? '02');
        const sf = parseInt(st, 16);
        const label = st === '01' ? 'DTCSettingOn' : 'DTCSettingOff';
        log(block.id, block.label, `[${ts()}]   TX: 85 ${hexB(sf)}  (ControlDTCSetting — ${label})`);
        const resp = await udsRequest(0x85, [sf]);
        log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}`);
        ctx.dtcSettingOff = st === '02';
        return { message: `ControlDTCSetting: ${label}` };
      }

      // ── 0x87 LinkControl ─────────────────────────────────────────────────────

      case 'uds_link_control': {
        // ISO 14229-1 §9.11: Only available in Programming session
        if (ctx.sessionType !== 'programming') throw new Error(nrcName(0x7F) + ` — ${t('diagEng.needProg')}`);

        const lcType  = String(block.config['link_control_type'] ?? '01');
        const brId    = String(block.config['link_baudrate_id']  ?? '05');
        const lcByte  = parseInt(lcType, 16);
        const brByte  = parseInt(brId,   16);
        const lcLabel: Record<string, string> = {
          '01': 'verifyModeTransitionWithFixedParameter',
          '02': 'verifyModeTransitionWithSpecificParameter',
          '03': 'transitionMode',
        };
        const brLabel: Record<string, string> = {
          '01': 'PC9600Baud', '02': 'PC19200Baud', '03': 'PC38400Baud',
          '04': 'PC57600Baud', '05': 'PC115200Baud',
          '10': 'CAN125Kbps', '11': 'CAN250Kbps', '12': 'CAN500Kbps', '13': 'CAN1Mbps',
          '20': 'ProgrammingSetup',
        };

        // 2-step sequence: verify → transition
        log(block.id, block.label, `[${ts()}]   [1/2] TX: 87 ${hexB(lcByte)} ${hexB(brByte)}  (LinkControl — ${lcLabel[lcType] ?? lcType})`);
        const verifyResp = await udsRequest(0x87, [lcByte, brByte]);
        log(block.id, block.label, `[${ts()}]   [1/2] RX: ${hex(verifyResp)}  — Verify OK`);

        // transitionMode with suppressPosRspMsgIndicationBit=1 (0x83)
        const transByte = 0x83; // transitionMode | suppress
        log(block.id, block.label, `[${ts()}]   [2/2] TX: 87 ${hexB(transByte)}  (LinkControl — transitionMode, suppress=true)`);
        await randomDelay(20, 60);
        log(block.id, block.label, `[${ts()}]   [2/2] ${t('diagEng.noResponse', { baud: brLabel[brId] ?? brId })}`);

        return { message: `LinkControl: ${brLabel[brId] ?? brId}  (${lcLabel[lcType] ?? lcType} → transitionMode)` };
      }

      // ── DATA ─────────────────────────────────────────────────────────────────

      case 'data_const': {
        const val = block.config['value'];
        ctx.variables.set(`_const_${block.id}`, val);
        return { message: t('diagEng.constMsg', { val: String(val) }), result: val };
      }

      case 'data_var': {
        const name = String(block.config['name'] ?? 'myVar');
        const existing = ctx.variables.get(name);
        if (existing !== undefined) return { message: `"${name}" = ${JSON.stringify(existing)}`, result: existing };
        const initial = block.config['initial'];
        ctx.variables.set(name, initial);
        return { message: `"${name}" init = ${JSON.stringify(initial)}`, result: initial };
      }

      case 'data_compare': return { message: t('diagEng.cmpEqual'), result: true };

      case 'data_extract': {
        const offset = Number(block.config['offset'] ?? 0);
        const length = Number(block.config['length'] ?? 1);
        return { message: `Byte [${offset}:${offset + length}]`, result: `0x00` };
      }

      case 'data_byte_builder': {
        const template = String(block.config['template'] ?? '00 00 00 00');
        const bytes = template.replace(/[^0-9a-fA-F]/g, '').match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [];
        const result = new Uint8Array(bytes);
        log(block.id, block.label, `[${ts()}]   ${t('diagEng.byteSeq', { hex: hex(result), n: result.length })}`);
        return { message: t('diagEng.bytesBuilt', { n: result.length, hex: hex(result) }), result };
      }

      case 'data_bitfield_extract': {
        const byteOffset = Number(block.config['byte_offset'] ?? 0);
        const bitHigh    = Number(block.config['bit_high']    ?? 7);
        const bitLow     = Number(block.config['bit_low']     ?? 0);

        // mock: use a sample byte
        const mockByte = 0xAB;
        const bits = bitHigh - bitLow + 1;
        const mask  = (1 << bits) - 1;
        const value = (mockByte >> bitLow) & mask;

        log(block.id, block.label, `[${ts()}]   byte[${byteOffset}]=0x${hexB(mockByte)}  bit[${bitHigh}:${bitLow}] = 0x${hexB(value)} (${value})`);
        return { message: `bit[${bitHigh}:${bitLow}] = 0x${hexB(value)}`, result: value };
      }

      case 'data_checksum': {
        const algorithm = String(block.config['algorithm'] ?? 'crc32');

        // Mock 16-byte input
        const mockData = new Uint8Array([0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0A,0x0B,0x0C,0x0D,0x0E,0x0F,0x10]);

        let checksum: number;
        switch (algorithm) {
          case 'crc16':   checksum = crc16ibm(mockData); break;
          case 'crc32':   checksum = crc32(mockData); break;
          case 'xor_sum': checksum = mockData.reduce((a, b) => a ^ b, 0); break;
          case 'add_sum': checksum = mockData.reduce((a, b) => (a + b) & 0xFF, 0); break;
          default:        checksum = crc32(mockData);
        }

        const hexResult = `0x${checksum.toString(16).toUpperCase().padStart(algorithm === 'crc16' ? 4 : 8, '0')}`;
        log(block.id, block.label, `[${ts()}]   ${algorithm.toUpperCase()}: ${hexResult}`);
        return { message: `${algorithm.toUpperCase()} = ${hexResult}`, result: checksum };
      }

      // ── IO ────────────────────────────────────────────────────────────────────

      case 'io_file_input': {
        await randomDelay(50, 100);
        const path = String(block.config['file_path'] ?? '');
        if (!path) throw new Error(t('diagEng.noFilePath'));
        const mockSize = 65536; // 64KB mock firmware
        const data = new Uint8Array(mockSize);
        for (let i = 0; i < mockSize; i++) data[i] = (0x20 + i) & 0xFF;
        log(block.id, block.label, `[${ts()}]   ${t('diagEng.fileLine', { path, n: mockSize })}`);
        return { message: t('diagEng.fileRead', { path, n: mockSize }), result: data };
      }

      case 'io_display': return { message: t('diagEng.valueShown') };

      case 'io_user_prompt': {
        const msg = String(block.config['message'] ?? t('diagBlk.enterAValue'));
        log(block.id, block.label, `[${ts()}]   Prompt: "${msg}" → "mock_value"`);
        return { message: t('diagEng.userPrompt'), result: 'mock_value' };
      }

      default:
        return { message: t('diagEng.unknownBlock', { type: block.type }) };
    }
  }

  private findNextBlock(fromBlockId: string, fromPortId: string): FlowBlock | null {
    const { diagram } = flowStore.getSnapshot() as { diagram: FlowDiagram };
    const conn = diagram.connections.find((c) => c.fromBlockId === fromBlockId && c.fromPortId === fromPortId);
    if (!conn) return null;
    return diagram.blocks.find((b) => b.id === conn.toBlockId) ?? null;
  }
}
