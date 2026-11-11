/**
 * Transport abstraction of the UDS flow engine.
 *
 * - `RealFlowTransport`: the live diagnostic session (`diagnosticsStore.sendUdsStrict` /
 *   `readDidStrict`). Real NRCs, timeouts and a missing session surface as thrown errors.
 * - `DemoFlowTransport`: local simulation (random latency / NRCs). Used ONLY while the global
 *   Diagnostics Demo switch (`diagnosticsStore.mockMode`) is on, snapshotted at run start.
 */
import { diagnosticsStore } from '../../../store/diagnosticsStore';
import { udsNrcName } from '../../../services/udsDecode';

export interface FlowRequestOptions {
  /** Request sets the suppress-positive-response bit: no response PDU is expected. */
  suppressed?: boolean;
}

export interface FlowTransport {
  readonly demo: boolean;
  /**
   * Sends `[sid, ...data]`. Resolves with the complete positive response PDU (`sid + 0x40` first),
   * or an empty array for a suppressed request. Rejects with an Error (negative response with its
   * NRC name, timeout, not connected, ...).
   */
  request(sid: number, data: readonly number[], options?: FlowRequestOptions): Promise<number[]>;
  /** ReadDataByIdentifier: resolves with the DID data record only (without 0x62 and the DID echo). */
  readDid(did: number): Promise<number[]>;
}

export class RealFlowTransport implements FlowTransport {
  readonly demo = false;

  async request(sid: number, data: readonly number[], options: FlowRequestOptions = {}): Promise<number[]> {
    const rest = await diagnosticsStore.sendUdsStrict(sid, data, { record: true, origin: 'flow' });
    return options.suppressed ? [] : [(sid + 0x40) & 0xff, ...rest];
  }

  readDid(did: number): Promise<number[]> {
    return diagnosticsStore.readDidStrict(did, 'flow');
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

  async request(sid: number, data: readonly number[]): Promise<number[]> {
    await demoDelay(20, 80);
    if (Math.random() < 0.015) {
      const nrc = [0x22, 0x31, 0x7f][Math.floor(Math.random() * 3)];
      throw new Error(demoNrcText(nrc));
    }
    return [sid + 0x40, ...data];
  }

  async readDid(did: number): Promise<number[]> {
    return this.request(0x22, [(did >> 8) & 0xff, did & 0xff]).then((r) => r.slice(3));
  }
}

export const demoFlowTransport = new DemoFlowTransport();
export const realFlowTransport = new RealFlowTransport();
