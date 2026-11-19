/**
 * RE Toolkit IPC client (re-toolkit-v1 §2.1, amendment 14). Runtime source `'live' | 'demo'` (default live, persisted
 * in localStorage `nexus.re.source`). Live: Tauri `invoke` + `Channel<ArrayBuffer>` (10 Hz binary snapshots), or in the
 * browser the authenticated bridge (`invokeCmd`, raw-body series, `/ws/re`). Demo (explicit opt-in only) is backed by
 * the synthetic ReDemoEngine and the UI shows a DEMO badge. There is never a silent fallback to demo.
 */
import { Channel, invoke } from '@tauri-apps/api/core';
import { t } from '../i18n';
import { BRIDGE_PORT, getBridgeHost, getBridgeToken, invokeCmd, invokeCmdRaw, isTauri } from './ipcClient';
import { reBuses, reCorrelateRequest, reRowKey, reSeriesRequest, reTarget } from './reArgs';
import { ReDemoEngine } from './reDemo';
import { DemoScanner } from './reScanDemo';
import { validateFirstSpec, validateNextOp, RE_SCAN_MAX_RESULTS } from '../components/re/reScanModel';
import { decodeReSeries } from './reSeriesCodec';
import { decodeReSnapshot } from './reSnapshotCodec';
import { demoCorrelate, demoFocusStatus, demoSeries, type DemoSignalEnv } from './reSignalDemo';
import type {
  ReClassificationDto,
  ReCorrelateRequest,
  ReCorrelationResultDto,
  ReFocusStatusDto,
  ReSeries,
  ReSeriesRequest,
  ReTargetDto,
  ReMarkerDto,
  ReRowDetailDto,
  ReRowKey,
  ReSettablePhase,
  ReSnapshot,
  ReStatusDto,
} from '../types/re';
import type { ReDbcGenerateResultDto, ReSignalDraftDto } from '../types/reDraft';
import type { ReScanFirstSpec, ReScanNextOp, ReScanResultsDto, ReScanSort, ReScanStatusDto } from '../types/reScan';

// ---- data source (live | demo) ---------------------------------------------------------------------------------

export type ReSource = 'live' | 'demo';
export const RE_SOURCE_STORAGE_KEY = 'nexus.re.source';

export interface ReSourceState {
  get(): ReSource;
  set(src: ReSource): void;
  subscribe(l: () => void): () => void;
}

type ReSourceStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): ReSourceStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Source holder persisted under `nexus.re.source`; default (and anything unrecognised) is `'live'`. */
export function createReSourceState(storage: ReSourceStorage | null = defaultStorage()): ReSourceState {
  let value: ReSource = 'live';
  try {
    if (storage?.getItem(RE_SOURCE_STORAGE_KEY) === 'demo') value = 'demo';
  } catch {
    /* storage unavailable: stay live */
  }
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(src) {
      if (src === value) return;
      value = src;
      try {
        storage?.setItem(RE_SOURCE_STORAGE_KEY, src);
      } catch {
        /* non-persistent */
      }
      for (const l of listeners) l();
    },
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

const sourceState = createReSourceState();
export const getReSource = (): ReSource => sourceState.get();
export const setReSource = (src: ReSource): void => sourceState.set(src);
export const subscribeReSource = (l: () => void): (() => void) => sourceState.subscribe(l);
export const reSourceState: ReSourceState = sourceState;

const isDemo = (): boolean => sourceState.get() === 'demo';

let demoEngine: ReDemoEngine | null = null;
function demo(): ReDemoEngine {
  demoEngine ??= new ReDemoEngine(() => Date.now() * 1000, true);
  return demoEngine;
}

/** Live JSON command: Tauri `invoke` or the authenticated bridge. Network failures get a visible hint (no demo fallback). */
async function live<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invokeCmd<T>(cmd, args);
  } catch (e) {
    throw hintBridgeError(e);
  }
}

function hintBridgeError(e: unknown): Error {
  if (!isTauri && e instanceof TypeError) return new Error(t('re.error.bridgeUnreachable'));
  return e instanceof Error ? e : new Error(String(e));
}

export async function reStart(rawBuses: number[] | null): Promise<ReStatusDto> {
  const buses = reBuses(rawBuses);
  return isDemo() ? demo().start(buses) : live<ReStatusDto>('cmd_re_start', { buses });
}

export async function reStop(): Promise<ReStatusDto> {
  return isDemo() ? demo().stop() : live<ReStatusDto>('cmd_re_stop', {});
}

export async function reReset(): Promise<ReStatusDto> {
  if (isDemo()) {
    demoScanner?.invalidate(); // analyzer reset invalidates the scan (contract §8.6 S7)
    return demo().reset();
  }
  return live<ReStatusDto>('cmd_re_reset', {});
}

export async function reSetPhase(phase: ReSettablePhase): Promise<ReStatusDto> {
  return isDemo() ? demo().setPhase(phase) : live<ReStatusDto>('cmd_re_set_phase', { phase });
}

export async function reMark(label: string): Promise<ReMarkerDto> {
  const clean = label.slice(0, 64);
  return isDemo() ? demo().mark(clean) : live<ReMarkerDto>('cmd_re_mark', { label: clean });
}

export async function reMarkers(): Promise<ReMarkerDto[]> {
  return isDemo() ? demo().listMarkers() : live<ReMarkerDto[]>('cmd_re_markers', {});
}

export async function reRowDetail(rawKey: ReRowKey): Promise<ReRowDetailDto> {
  const key = reRowKey(rawKey);
  return isDemo()
    ? demo().rowDetail(key)
    : live<ReRowDetailDto>('cmd_re_row_detail', { bus: key.bus, arbId: key.arbId, isExtended: key.isExtended });
}

export async function reClassify(rawKey: ReRowKey): Promise<ReClassificationDto> {
  const key = reRowKey(rawKey);
  return isDemo()
    ? demo().classify(key)
    : live<ReClassificationDto>('cmd_re_classify', { bus: key.bus, arbId: key.arbId, isExtended: key.isExtended });
}

// ---- R2a Signal Inspector (re-toolkit-v1 §6.2) ----------------------------------------------------------------

let demoFocus: ReTargetDto[] = [];
const demoOriginUs = Date.now() * 1000;

function demoEnv(): DemoSignalEnv {
  return { nowUs: Date.now() * 1000, originUs: demoOriginUs, markers: demo().listMarkers() };
}

export async function reFocusSet(rawTargets: ReTargetDto[]): Promise<ReFocusStatusDto> {
  const targets = rawTargets.map((t, i) => reTarget(t, `targets[${i}]`));
  if (isDemo()) {
    demoFocus = targets.slice(0, 8);
    return demoFocusStatus(demoFocus, demoEnv());
  }
  return live<ReFocusStatusDto>('cmd_re_focus_set', { targets });
}

export async function reFocusStatus(): Promise<ReFocusStatusDto> {
  return isDemo() ? demoFocusStatus(demoFocus, demoEnv()) : live<ReFocusStatusDto>('cmd_re_focus_status', {});
}

/** `cmd_re_series` answers with a raw binary response (ArrayBuffer); it is decoded here (`decodeReSeries`). */
export async function reSeries(rawReq: ReSeriesRequest): Promise<ReSeries> {
  const req = reSeriesRequest(rawReq);
  if (isDemo()) return demoSeries(req, demoEnv());
  const args = {
    target: req.target,
    candidates: req.candidates,
    reference: req.reference,
    fromUs: req.fromUs,
    toUs: req.toUs,
    maxPoints: req.maxPoints,
  };
  if (!isTauri) {
    try {
      return decodeReSeries(await invokeCmdRaw('cmd_re_series', args));
    } catch (e) {
      throw hintBridgeError(e);
    }
  }
  const msg = await invoke<ArrayBuffer | Uint8Array | number[]>('cmd_re_series', args);
  return decodeReSeries(toArrayBuffer(msg));
}

export async function reCorrelate(rawReq: ReCorrelateRequest): Promise<ReCorrelationResultDto> {
  const req = reCorrelateRequest(rawReq);
  if (isDemo()) return demoCorrelate(req, demoEnv());
  return live<ReCorrelationResultDto>('cmd_re_correlate', {
    target: req.target,
    reference: req.reference,
    fromUs: req.fromUs,
    toUs: req.toUs,
    search: req.search,
    topN: req.topN,
  });
}

function toArrayBuffer(msg: ArrayBuffer | Uint8Array | number[]): ArrayBuffer {
  if (msg instanceof ArrayBuffer) return msg;
  if (msg instanceof Uint8Array) {
    return msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength) as ArrayBuffer;
  }
  return Uint8Array.from(msg).buffer;
}

/**
 * Subscribes to 10 Hz snapshots. Resolves to an unsubscribe function (stops delivery; the backend stream ends
 * with `reStop`). Decode errors are reported through `onError`, never thrown into the Channel callback.
 */
export async function subscribeRe(
  onSnapshot: (snap: ReSnapshot) => void,
  onError?: (err: Error) => void,
): Promise<() => void> {
  let disposed = false;
  const deliver = (buf: ArrayBuffer): void => {
    if (disposed) return;
    try {
      onSnapshot(decodeReSnapshot(buf));
    } catch (e) {
      onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  };

  if (isDemo()) {
    const engine = demo();
    engine.requestFull();
    const timer = window.setInterval(() => {
      const buf = engine.tick();
      if (buf !== null) deliver(buf);
    }, 100);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }

  if (!isTauri) return subscribeBridgeWs(deliver, onError, () => disposed, () => {
    disposed = true;
  });

  const ch = new Channel<ArrayBuffer | Uint8Array | number[]>();
  ch.onmessage = (msg) => deliver(toArrayBuffer(msg));
  await invoke<null>('cmd_re_subscribe', { onSnapshot: ch });
  return () => {
    disposed = true;
    ch.onmessage = () => undefined;
  };
}

/**
 * Browser live mode: `/ws/re` (auth frame first, exactly like `/ws/telemetry`), binary NRE2 messages. Resolves once the
 * socket is open and the auth frame is sent; rejects (visible hint) when it cannot connect. A close by the backend
 * (code 1000 after `cmd_re_stop`) just ends delivery; an abnormal close is reported once through `onError`. There is
 * no reconnect loop: `reStore` re-subscribes after every start.
 */
function subscribeBridgeWs(
  deliver: (buf: ArrayBuffer) => void,
  onError: ((err: Error) => void) | undefined,
  isDisposed: () => boolean,
  dispose: () => void,
): Promise<() => void> {
  return getBridgeToken()
    .catch((e: unknown) => {
      throw hintBridgeError(e instanceof Error ? e : new Error(String(e)));
    })
    .then(
      (token) =>
        new Promise<() => void>((resolve, reject) => {
          let opened = false;
          let socket: WebSocket;
          try {
            socket = new WebSocket(`ws://${getBridgeHost()}:${BRIDGE_PORT}/ws/re`);
          } catch {
            reject(new Error(t('re.error.bridgeUnreachable')));
            return;
          }
          socket.binaryType = 'arraybuffer';
          socket.onopen = () => {
            if (isDisposed()) {
              socket.close();
              return;
            }
            // First message MUST be the auth frame.
            socket.send(JSON.stringify({ type: 'auth', token }));
            opened = true;
            resolve(() => {
              dispose();
              socket.onmessage = null;
              socket.onclose = null;
              socket.onerror = null;
              try {
                socket.close();
              } catch {
                /* already closed */
              }
            });
          };
          socket.onmessage = (ev: MessageEvent) => {
            if (!isDisposed() && ev.data instanceof ArrayBuffer) deliver(ev.data);
          };
          socket.onclose = (ev: CloseEvent) => {
            if (!opened) {
              void getBridgeToken(true).catch(() => undefined); // stale token after a bridge restart
              reject(new Error(t('re.error.bridgeUnreachable')));
              return;
            }
            if (isDisposed() || ev.code === 1000) return;
            if (ev.code === 4401) void getBridgeToken(true).catch(() => undefined);
            onError?.(new Error(t('re.error.bridgeUnreachable')));
          };
        }),
    );
}

// ---- R2b Save found signals to DBC (re-toolkit-v1 §7.3) ---------------------------------------------------------

export interface ReDbcBaseDto {
  fileName: string;
  contentBase64: string;
}

/**
 * `cmd_re_dbc_generate`: backend-only (no frontend generator, no demo fallback: the DBC text must come from the
 * round-trip-verified Rust generator). Errors arrive as `[re:invalid] ...` strings. Nothing is written to disk here.
 */
export async function reDbcGenerate(drafts: readonly ReSignalDraftDto[], base: ReDbcBaseDto | null): Promise<ReDbcGenerateResultDto> {
  return live<ReDbcGenerateResultDto>('cmd_re_dbc_generate', { drafts, base });
}

// ---- R2c Value Scan (re-toolkit-v1 §8.3, amendments §8.6) -------------------------------------------------------

let demoScanner: DemoScanner | null = null;
function scanner(): DemoScanner {
  demoScanner ??= new DemoScanner(demo());
  return demoScanner;
}

/** Client-side validation (defence in depth, same `[re:invalid]` token as the backend). */
function assertValid(what: string, issues: string[]): void {
  if (issues.length > 0) throw new Error(`[re:invalid] ${what}: ${issues.join(', ')}`);
}

/** Live scans always go to the backend; the demo source scans the synthetic rows in TS (DEMO-badged in the UI). */
export async function reScanFirst(spec: ReScanFirstSpec): Promise<ReScanStatusDto> {
  assertValid('scan spec', validateFirstSpec(spec));
  return isDemo() ? scanner().first(spec) : live<ReScanStatusDto>('cmd_re_scan_first', { spec });
}

export async function reScanNext(op: ReScanNextOp): Promise<ReScanStatusDto> {
  assertValid('scan op', validateNextOp(op));
  return isDemo() ? scanner().next(op) : live<ReScanStatusDto>('cmd_re_scan_next', { op });
}

export async function reScanUndo(): Promise<ReScanStatusDto> {
  return isDemo() ? scanner().undo() : live<ReScanStatusDto>('cmd_re_scan_undo', {});
}

export async function reScanReset(): Promise<ReScanStatusDto> {
  return isDemo() ? scanner().reset() : live<ReScanStatusDto>('cmd_re_scan_reset', {});
}

export async function reScanStatus(): Promise<ReScanStatusDto> {
  return isDemo() ? scanner().status() : live<ReScanStatusDto>('cmd_re_scan_status', {});
}

export async function reScanResults(offset: number, limit: number, sort: ReScanSort): Promise<ReScanResultsDto> {
  const o = Math.round(offset);
  const l = Math.round(limit);
  if (!Number.isFinite(o) || o < 0) throw new Error(`[re:invalid] offset must be >= 0 (got ${offset})`);
  if (!Number.isFinite(l) || l < 1 || l > RE_SCAN_MAX_RESULTS) throw new Error(`[re:invalid] limit must be 1..=${RE_SCAN_MAX_RESULTS} (got ${limit})`);
  return isDemo() ? scanner().results(o, l, sort) : live<ReScanResultsDto>('cmd_re_scan_results', { offset: o, limit: l, sort });
}
