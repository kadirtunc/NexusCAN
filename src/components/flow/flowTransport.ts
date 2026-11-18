/**
 * Transport abstraction of the UDS flow engine.
 *
 * - `RealFlowTransport`: the live diagnostic session (`diagnosticsStore.sendUdsStrict` /
 *   `readDidStrict` / `setTesterPresentOn`). Real NRCs, timeouts and a missing session surface as
 *   thrown errors. Every request goes through the normal gated backend path (Listen-Only / Arm /
 *   Panic latch are enforced by the backend for every transmission).
 * - `DemoFlowTransport`: local simulation (random latency / NRCs). Used ONLY while the global
 *   Diagnostics Demo switch (`diagnosticsStore.mockMode`) is on, snapshotted at run start.
 *
 * Per-request options (`FlowRequestOptions`):
 * - `addressing: 'functional'` → the tab config's `functionalId` (e.g. 0x7DF). Missing id = Error
 *   before anything is sent (checked by the executor AND by `sendUdsStrict`).
 *   Functional WITHOUT SPR resolves with the FIRST positive response the backend receives (the
 *   first ECU to answer); other ECUs' answers are ignored.
 * - `suppressed` (SPR bit already set by the caller in the sub-function byte) → resolves with `[]`.
 *   The backend still listens for P2 for a negative response (an NRC rejects), but no positive
 *   response is awaited or returned.
 * - `timeoutMs` → whole-exchange budget override (null/0 = backend P2/P2* handling).
 * - `busyRetryMax` / `busyRetryDelayMs` → NRC 0x21 retries (physical only; ignored for functional).
 */
import { diagnosticsStore } from '../../store/diagnosticsStore';
import { udsNrcName } from '../../services/udsDecode';
import type { UdsAddressing } from '../../types/udsClient';
import type { FlashBackend } from './flashRun';

export interface FlowRequestOptions {
  /** Request sets the suppress-positive-response bit: no response PDU is expected. */
  suppressed?: boolean;
  /** Default 'physical'. */
  addressing?: UdsAddressing;
  /** Whole-exchange timeout override in ms; null / 0 / absent = backend default. */
  timeoutMs?: number | null;
  /** NRC 0x21 busyRepeatRequest retries (0 / absent = off). */
  busyRetryMax?: number;
  /** Delay before each 0x21 retry (absent = backend default 50 ms). */
  busyRetryDelayMs?: number | null;
}

/** True when the options differ from a plain physical request with backend defaults. */
export function hasCustomOptions(o: FlowRequestOptions): boolean {
  return (o.addressing ?? 'physical') !== 'physical'
    || (o.timeoutMs ?? 0) > 0
    || (o.busyRetryMax ?? 0) > 0
    || o.suppressed === true;
}

export interface FlowTransport {
  readonly demo: boolean;
  /** Diagnostics tab the run is pinned to (real transport only). */
  readonly tabId?: string;
  /**
   * Optional flash backend override (headless tests inject a stub for `cmd_flash_*`).
   * Absent = the real Tauri backend (`realFlashBackend`).
   */
  readonly flash?: FlashBackend;
  /**
   * Sends `[sid, ...data]`. Resolves with the complete positive response PDU (`sid + 0x40` first),
   * or an empty array for a suppressed request. Rejects with an Error (negative response with its
   * NRC name, timeout, not connected, ...).
   */
  request(sid: number, data: readonly number[], options?: FlowRequestOptions): Promise<number[]>;
  /** ReadDataByIdentifier: resolves with the DID data record only (without 0x62 and the DID echo). */
  readDid(did: number): Promise<number[]>;
  /** Functional request id configured on the pinned session, `null` = physical only. */
  functionalId(): number | null;
  /**
   * Backend TesterPresent keep-alive of the pinned session (`3E 80`, PHYSICAL, sent only when the
   * tester was silent for one interval). `intervalMs` 100..60000.
   */
  setKeepalive(enabled: boolean, intervalMs: number): Promise<void>;
}

export class RealFlowTransport implements FlowTransport {
  readonly demo = false;

  /**
   * `tabId` pins the whole run to one diagnostic session tab (captured at run start): switching the
   * active tab mid-run never redirects requests to another ECU.
   */
  constructor(readonly tabId: string) {}

  async request(sid: number, data: readonly number[], options: FlowRequestOptions = {}): Promise<number[]> {
    const retryMax = Math.max(0, Math.min(10, Math.trunc(options.busyRetryMax ?? 0)));
    const delay = options.busyRetryDelayMs ?? null;
    const rest = await diagnosticsStore.sendUdsStrict(sid, data, {
      record: true,
      origin: 'flow',
      tabId: this.tabId,
      addressing: options.addressing ?? 'physical',
      timeoutMs: options.timeoutMs ?? null,
      busyRetry: retryMax > 0
        ? { max: retryMax, delayMs: delay === null || delay <= 0 ? null : Math.min(5000, Math.max(10, Math.round(delay))) }
        : null,
    });
    return options.suppressed ? [] : [(sid + 0x40) & 0xff, ...rest];
  }

  readDid(did: number): Promise<number[]> {
    return diagnosticsStore.readDidStrict(did, 'flow', this.tabId);
  }

  functionalId(): number | null {
    return diagnosticsStore.functionalIdOf(this.tabId);
  }

  setKeepalive(enabled: boolean, intervalMs: number): Promise<void> {
    return diagnosticsStore.setTesterPresentOn(this.tabId, enabled, enabled ? intervalMs : null);
  }
}

export function demoDelay(min: number, max: number): Promise<void> {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

function demoNrcText(nrc: number): string {
  const name = udsNrcName(nrc);
  return `NRC 0x${nrc.toString(16).toUpperCase().padStart(2, '0')}${name ? ` (${name})` : ''}`;
}

/** DEMO ONLY: fabricated responses. Never instantiate outside demo mode. */
export class DemoFlowTransport implements FlowTransport {
  readonly demo = true;

  async request(sid: number, data: readonly number[], options: FlowRequestOptions = {}): Promise<number[]> {
    // A long timeout override (e.g. a 30 s erase) shows as a slightly longer fake latency.
    const slow = (options.timeoutMs ?? 0) >= 5000;
    await demoDelay(slow ? 120 : 20, slow ? 260 : 80);
    if (options.suppressed) return [];
    if (Math.random() < 0.015) {
      const nrc = [0x22, 0x31, 0x7f][Math.floor(Math.random() * 3)];
      throw new Error(demoNrcText(nrc));
    }
    // RoutineControl: echo control type + routine id and report routineStatus 0x00 (OK).
    if (sid === 0x31) return [0x71, data[0] ?? 0x01, data[1] ?? 0x00, data[2] ?? 0x00, 0x00];
    return [sid + 0x40, ...data];
  }

  async readDid(did: number): Promise<number[]> {
    return this.request(0x22, [(did >> 8) & 0xff, did & 0xff]).then((r) => r.slice(3));
  }

  functionalId(): number | null {
    return 0x7df;
  }

  async setKeepalive(): Promise<void> {
    await demoDelay(5, 15);
  }
}

export const demoFlowTransport = new DemoFlowTransport();
