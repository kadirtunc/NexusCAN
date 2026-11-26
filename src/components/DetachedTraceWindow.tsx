import { useEffect, useRef, useState } from 'react';
import { setLocale, useI18n } from '../i18n';
import {
  TRACE_WINDOW_POLL_MS,
  traceWindowChannel,
  type TraceWindowRequest,
  type TraceWindowUpdate,
} from '../services/traceWindow';
import { databaseStore } from '../store/databaseStore';
import { ChronoRingBuffer } from '../store/telemetryStore';
import type { TraceSession } from '../store/traceSessionsStore';
import { ContextMenu } from './ContextMenu';
import { TraceView } from './TraceView';

export function DetachedTraceWindow({ channelKey }: { channelKey: string }): React.JSX.Element {
  const { t } = useI18n();
  const [session, setSession] = useState<TraceSession | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    const channel = new BroadcastChannel(traceWindowChannel(channelKey));
    channelRef.current = channel;
    let ring: ChronoRingBuffer | null = null;
    let cursor = 0;
    let stream = 0;
    let version = -1;
    let schemaVersion = 0;
    let viewVersion = 0;

    const sync = () => {
      const request: TraceWindowRequest = { kind: 'sync', cursor, stream, version, schemaVersion };
      channel.postMessage(request);
    };
    channel.onmessage = (event: MessageEvent<TraceWindowUpdate>) => {
      const update = event.data;
      if (update?.kind !== 'update' || update.stream < stream) return;
      if (update.stream === stream && update.start < cursor) return;

      if (!ring || update.stream !== stream || update.start !== cursor) {
        ring = new ChronoRingBuffer(update.session.maxBufferRows, update.start);
      } else {
        ring.resize(update.session.maxBufferRows);
      }
      for (const frame of update.frames) ring.push(frame);
      cursor = update.start + update.frames.length;
      stream = update.stream;
      version = update.session.version;
      if (update.schemas && update.schemaVersion !== schemaVersion) {
        const existingIds = [...databaseStore.getState().busSchemas.keys()];
        for (const [id, schema] of update.schemas) databaseStore.setBusSchema(id, schema);
        for (const id of existingIds) {
          if (!update.schemas.some(([busId]) => busId === id)) databaseStore.setBusSchema(id, null);
        }
        schemaVersion = update.schemaVersion;
      }
      if (update.theme !== databaseStore.getState().theme) databaseStore.setTheme(update.theme);
      setLocale(update.locale);
      setSession({
        ...update.session,
        ring,
        displayRing: ring,
        count: ring.length,
        version: ++viewVersion,
      });
      document.title = `${update.session.name} — NexusCAN`;
    };
    sync();
    const timer = window.setInterval(sync, TRACE_WINDOW_POLL_MS);
    return () => {
      window.clearInterval(timer);
      channel.close();
      channelRef.current = null;
    };
  }, [channelKey]);

  const send = (request: TraceWindowRequest) => channelRef.current?.postMessage(request);

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-panel">
      {session ? (
        <TraceView detached={{
          session,
          onRecordingAction: (action) => send({ kind: 'recording', action }),
          onDock: () => send({ kind: 'dock' }),
        }} />
      ) : (
        <div role="status" className="p-4 text-[12px] text-[var(--text-secondary)]">
          {t('trace.window.waiting')}
        </div>
      )}
      <ContextMenu />
    </div>
  );
}
