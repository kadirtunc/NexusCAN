import { getLocale, type Locale } from '../i18n';
import { databaseStore, type UiTheme } from '../store/databaseStore';
import { traceSessionsStore, type TraceSession } from '../store/traceSessionsStore';
import type { ChronoRingBuffer } from '../store/telemetryStore';
import type { DatabaseSchemaDto } from '../types/netdb';
import type { ChronologicalFrameDto } from '../types/telemetry';
import { invokeCmd, isTauri } from './ipcClient';

const MAX_BATCH_FRAMES = 4096;

export const TRACE_WINDOW_POLL_MS = 100;
export const traceWindowChannel = (key: string): string => `nexuscan:trace-window:${key}`;

export type TraceRecordingAction = 'record' | 'pause' | 'stop';

export type TraceWindowRequest =
  | { kind: 'sync'; cursor: number; stream: number; version: number; schemaVersion: number }
  | { kind: 'recording'; action: TraceRecordingAction }
  | { kind: 'dock' };

type TraceWindowSession = Omit<TraceSession, 'ring' | 'displayRing'>;

export interface TraceWindowUpdate {
  kind: 'update';
  stream: number;
  start: number;
  end: number;
  session: TraceWindowSession;
  frames: ChronologicalFrameDto[];
  schemaVersion: number;
  schemas?: readonly [number, DatabaseSchemaDto][];
  theme: UiTheme;
  locale: Locale;
}

export interface TraceWindowHandle {
  ready: Promise<void>;
  focus: () => void;
  close: () => void;
}

export function openTraceWindow(sessionId: string, onClose: () => void): TraceWindowHandle {
  const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const channel = new BroadcastChannel(traceWindowChannel(key));
  const invokeWindow = (action: 'open' | 'focus' | 'close' | 'exists') =>
    invokeCmd<boolean>('cmd_trace_window', { channelId: key, action });
  let popup: Window | null = null;
  let stream = 0;
  let previousRing: ChronoRingBuffer | null = null;
  let previousGeneration = -1;
  let previousSchemas: ReturnType<typeof databaseStore.getState>['busSchemas'] | null = null;
  let schemaVersion = 0;
  let previousTheme: UiTheme | null = null;
  let previousLocale: Locale | null = null;
  let closed = false;
  let checkPending = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const dispose = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    window.removeEventListener('pagehide', close);
    channel.close();
    onClose();
  };

  const close = (): void => {
    dispose();
    if (isTauri) void invokeWindow('close').catch(() => undefined);
    else popup?.close();
  };

  channel.onmessage = (event: MessageEvent<TraceWindowRequest>) => {
    const request = event.data;
    if (!request || typeof request !== 'object') return;
    const session = traceSessionsStore.getState().sessions.find((item) => item.id === sessionId);
    if (!session || request.kind === 'dock') {
      close();
      return;
    }
    if (request.kind === 'recording') {
      if (request.action === 'record') traceSessionsStore.startRecording(sessionId, false);
      if (request.action === 'pause') traceSessionsStore.pauseRecording(sessionId);
      if (request.action === 'stop') traceSessionsStore.stopRecording(sessionId);
      return;
    }
    if (request.kind !== 'sync') return;

    const { ring: _, displayRing, ...metadata } = session;
    if (displayRing !== previousRing || displayRing.generation !== previousGeneration) {
      stream += 1;
      previousRing = displayRing;
      previousGeneration = displayRing.generation;
    }
    const db = databaseStore.getState();
    if (db.busSchemas !== previousSchemas) {
      schemaVersion += 1;
      previousSchemas = db.busSchemas;
    }
    const locale = getLocale();
    const end = displayRing.baseSeq + displayRing.length;
    const current = request.stream === stream &&
      Number.isSafeInteger(request.cursor) &&
      request.cursor >= displayRing.baseSeq && request.cursor <= end;
    const start = current ? request.cursor : displayRing.baseSeq;
    const schemasChanged = request.schemaVersion !== schemaVersion;
    if (current && start === end && request.version === metadata.version
      && !schemasChanged && previousTheme === db.theme && previousLocale === locale) return;

    const frames: ChronologicalFrameDto[] = [];
    for (let seq = start; seq < Math.min(end, start + MAX_BATCH_FRAMES); seq += 1) {
      const frame = displayRing.getAt(seq - displayRing.baseSeq);
      if (frame) frames.push(frame);
    }
    previousTheme = db.theme;
    previousLocale = locale;
    const update: TraceWindowUpdate = {
      kind: 'update', stream, start, end, session: metadata, frames, schemaVersion, theme: db.theme, locale,
      schemas: schemasChanged ? Array.from(db.busSchemas, ([id, entry]) => [id, entry.schema]) : undefined,
    };
    channel.postMessage(update);
  };

  const ready = (async () => {
    try {
      if (isTauri) {
        await invokeWindow('open');
        if (closed) {
          await invokeWindow('close');
          return;
        }
      }
      else {
        const url = new URL(window.location.pathname, window.location.origin);
        url.searchParams.set('window', 'trace');
        url.searchParams.set('key', key);
        popup = window.open(url, `trace-view-${key}`, 'popup,width=1200,height=700');
        if (!popup) throw new Error('Popup blocked');
      }

      window.addEventListener('pagehide', close);
      timer = setInterval(() => {
        if (!traceSessionsStore.getState().sessions.some((session) => session.id === sessionId)) {
          close();
        } else if (!isTauri) {
          if (popup?.closed) dispose();
        } else if (!checkPending) {
          checkPending = true;
          void invokeWindow('exists')
            .then((exists) => { if (!exists) dispose(); })
            .catch(() => undefined)
            .finally(() => { checkPending = false; });
        }
      }, 500);
    } catch (error) {
      dispose();
      throw error;
    }
  })();

  return {
    ready,
    close,
    focus: () => {
      if (isTauri) void invokeWindow('focus').catch(() => undefined);
      else popup?.focus();
    },
  };
}
