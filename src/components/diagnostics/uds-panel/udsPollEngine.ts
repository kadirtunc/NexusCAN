/**
 * UDS panel poll engine: ONE timer per panel (not per widget), DID/address-level request
 * dedupe, per-widget `pollMs` override (a request runs at the fastest interval among the widgets
 * that read it), strictly serialized requests (single ISO-TP channel) and error back-off.
 *
 * Samples are published to the shared `SimulationRuntimeBus` (value / peak / history), never to
 * React state. Per-key read status (pending / ok / error) is a tiny separate external store that
 * only notifies on transitions, so a healthy 1-10 Hz poll causes zero React re-renders here.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { registerTxSource } from '../../../store/txSources';
import { UdsTransportError, type UdsTransportErrorKind } from '../../../store/diagnosticsStore';
import type { SimulationRuntimeBus } from '../../simulation/simulationRuntimeBus';
import type { UdsWidgetDto } from '../../../types/uds';
import {
  buildReadRequests,
  decodeReadValue,
  type UdsReadRequest,
} from './udsBinding';
import { mockBytes, mockPhysicalValue } from './udsMock';
import { udsReadDid, udsReadMemory } from './udsTransport';

export type UdsReadErrorKind = UdsTransportErrorKind | 'invalidId' | 'shortPayload';

export type UdsReadStatus =
  | { state: 'pending' }
  | { state: 'ok' }
  | { state: 'error'; kind: UdsReadErrorKind; message: string };

const PENDING: UdsReadStatus = { state: 'pending' };
const OK: UdsReadStatus = { state: 'ok' };

const TICK_MS = 25;
const ERROR_BACKOFF_MS = 1000;

interface RequestState {
  req: UdsReadRequest;
  nextDueMs: number;
  inFlight: boolean;
  queued: boolean;
}

export interface UdsPollConfig {
  defaultPollMs: number;
  mock: boolean;
}

function sameStatus(a: UdsReadStatus, b: UdsReadStatus): boolean {
  if (a.state !== b.state) return false;
  if (a.state === 'error' && b.state === 'error') {
    return a.kind === b.kind && a.message === b.message;
  }
  return true;
}

let pollEngineSeq = 0;

export class UdsPollEngine {
  private readonly txSourceId = `uds-poll:${++pollEngineSeq}`;
  private unregisterTx: (() => void) | null = null;
  private states: RequestState[] = [];
  private config: UdsPollConfig = { defaultPollMs: 1000, mock: false };
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private queue: RequestState[] = [];
  private pumping = false;
  private readonly t0 = performance.now();
  private readonly statuses = new Map<string, UdsReadStatus>();
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(private readonly bus: SimulationRuntimeBus) {}

  public nowSec(): number {
    return (performance.now() - this.t0) / 1000;
  }

  public isRunning(): boolean {
    return this.timer !== null;
  }

  /** (Re)build the request table from the panel widgets; keeps schedule + status of unchanged ids. */
  public configure(widgets: readonly UdsWidgetDto[], config: UdsPollConfig): void {
    this.config = config;
    const { requests, invalid } = buildReadRequests(widgets, config.defaultPollMs);
    const prev = new Map(this.states.map((s) => [s.req.id, s]));
    this.states = requests.map((req) => {
      const old = prev.get(req.id);
      return {
        req,
        nextDueMs: old?.nextDueMs ?? 0,
        inFlight: old?.inFlight ?? false,
        queued: old?.queued ?? false,
      };
    });
    this.queue = this.queue.filter((q) => this.states.some((s) => s.req.id === q.req.id));

    const liveKeys = new Set<string>();
    for (const s of this.states) for (const c of s.req.consumers) liveKeys.add(c.key);
    for (const bad of invalid) {
      liveKeys.add(bad.key);
      this.setStatus(bad.key, { state: 'error', kind: 'invalidId', message: 'invalid id' });
    }
    for (const key of [...this.statuses.keys()]) {
      if (!liveKeys.has(key)) this.statuses.delete(key);
    }
  }

  public start(): void {
    if (this.timer !== null) return;
    this.generation += 1;
    for (const s of this.states) {
      s.nextDueMs = 0;
      s.inFlight = false;
      s.queued = false;
    }
    this.queue = [];
    // A polling loop on a real session transmits requests on its own schedule: Panic Stop must stop it.
    this.unregisterTx?.();
    this.unregisterTx = this.config.mock
      ? null
      : registerTxSource(this.txSourceId, () => this.stop());
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  public stop(): void {
    this.unregisterTx?.();
    this.unregisterTx = null;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.generation += 1; // late async results of the old run are dropped
    this.queue = [];
    for (const s of this.states) {
      s.inFlight = false;
      s.queued = false;
    }
  }

  public dispose(): void {
    this.stop();
    this.listeners.clear();
    this.statuses.clear();
  }

  // ── Status store ──────────────────────────────────────────────────────────

  public getStatus(key: string): UdsReadStatus {
    return this.statuses.get(key) ?? PENDING;
  }

  public subscribeStatus(key: string, listener: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      const target = this.listeners.get(key);
      if (!target) return;
      target.delete(listener);
      if (target.size === 0) this.listeners.delete(key);
    };
  }

  private setStatus(key: string, next: UdsReadStatus): void {
    const prev = this.getStatus(key);
    if (sameStatus(prev, next)) {
      if (!this.statuses.has(key)) this.statuses.set(key, prev);
      return;
    }
    this.statuses.set(key, next);
    const set = this.listeners.get(key);
    if (set) for (const fn of set) fn();
  }

  // ── Scheduling ────────────────────────────────────────────────────────────

  private tick(): void {
    const now = performance.now();
    for (const st of this.states) {
      if (st.inFlight || st.queued || now < st.nextDueMs) continue;
      if (this.config.mock) {
        st.nextDueMs = now + st.req.intervalMs;
        this.publishMock(st);
      } else {
        st.queued = true;
        this.queue.push(st);
      }
    }
    if (!this.config.mock && this.queue.length > 0) {
      void this.pump();
    }
  }

  private publishMock(st: RequestState): void {
    const nowMs = Date.now();
    const tSec = this.nowSec();
    for (const c of st.req.consumers) {
      this.bus.publishExternalSample(c.key, mockPhysicalValue(c.read, nowMs), tSec);
      if (c.textLen !== null) {
        this.bus.publishExternalBytes(c.key, mockBytes(c.read, c.textLen));
      }
      this.setStatus(c.key, OK);
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    const gen = this.generation;
    try {
      while (this.queue.length > 0 && gen === this.generation) {
        const st = this.queue.shift();
        if (!st) break;
        st.queued = false;
        st.inFlight = true;
        try {
          const data =
            st.req.service === 'read_did' && st.req.did !== null
              ? await udsReadDid(st.req.did)
              : st.req.address !== null
                ? await udsReadMemory(st.req.address, Math.max(1, st.req.size))
                : [];
          if (gen !== this.generation) return;
          this.applyResponse(st, data);
          st.nextDueMs = performance.now() + st.req.intervalMs;
        } catch (err) {
          if (gen !== this.generation) return;
          this.applyError(st, err);
          st.nextDueMs = performance.now() + Math.max(st.req.intervalMs, ERROR_BACKOFF_MS);
        } finally {
          st.inFlight = false;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private applyResponse(st: RequestState, data: readonly number[]): void {
    const tSec = this.nowSec();
    for (const c of st.req.consumers) {
      const value = decodeReadValue(c.read, data);
      if (c.textLen !== null) {
        // Textbox: raw bytes are the primary payload; the numeric decode is best-effort.
        const end = c.textLen > 0 ? c.read.byteOffset + c.textLen : data.length;
        const slice = data.slice(c.read.byteOffset, end);
        const needed = c.textLen > 0 ? c.textLen : 1;
        if (slice.length < needed) {
          this.setStatus(c.key, {
            state: 'error',
            kind: 'shortPayload',
            message: `payload ${data.length} B < ${c.read.byteOffset + needed} B`,
          });
          continue;
        }
        if (value !== null) this.bus.publishExternalSample(c.key, value, tSec);
        this.bus.publishExternalBytes(c.key, Uint8Array.from(slice));
        this.setStatus(c.key, OK);
        continue;
      }
      if (value === null) {
        this.setStatus(c.key, {
          state: 'error',
          kind: 'shortPayload',
          message: `payload ${data.length} B < ${c.read.byteOffset + c.read.byteLen} B`,
        });
        continue;
      }
      this.bus.publishExternalSample(c.key, value, tSec);
      this.setStatus(c.key, OK);
    }
  }

  private applyError(st: RequestState, err: unknown): void {
    const kind: UdsReadErrorKind = err instanceof UdsTransportError ? err.kind : 'failed';
    const message = err instanceof Error ? err.message : String(err);
    for (const c of st.req.consumers) {
      this.setStatus(c.key, { state: 'error', kind, message });
    }
  }
}

export function useUdsReadStatus(engine: UdsPollEngine, key: string | null): UdsReadStatus {
  const subscribe = useCallback(
    (cb: () => void) => (key ? engine.subscribeStatus(key, cb) : () => undefined),
    [engine, key]
  );
  const getSnapshot = useCallback(
    () => (key ? engine.getStatus(key) : PENDING),
    [engine, key]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
