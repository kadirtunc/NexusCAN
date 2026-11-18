import { csvQuote } from '../utils/csvSafe';
import { useSyncExternalStore } from 'react';
import { databaseStore } from './databaseStore';
import { registerTxSource } from './txSources';
import { plotStore } from './plotStore';
import {
  ChronoRingBuffer,
  DEFAULT_CHRONO_BUFFER_ROWS,
  MAX_CHRONO_BUFFER_ROWS,
  MIN_CHRONO_BUFFER_ROWS,
  telemetryStore,
} from './telemetryStore';
import type {
  ChronologicalFrameDto,
  TraceFileSummaryDto,
  TraceReplayDirectionFilter,
  TraceReplayFilterMode,
  TraceReplayStatusDto,
  TraceStorageInfoDto,
} from '../types/telemetry';
import {
  apiControlTraceReplay,
  apiDeleteTraceFile,
  apiExportTraceBlf,
  apiListTraces,
  apiLoadTraceFile,
  apiParseTraceContent,
  apiSaveTraceFile,
  apiStartTraceReplay,
} from '../services/ipcClient';
import { formatByteHex, formatPcanIdHex } from '../utils/formatters';
import { formatErrorFrameShortTitle } from '../utils/canErrorDecoder';
import { logUiDebugEvent } from './debugConsoleStore';
import {
  decodeTraceFrame,
  formatDecodedTraceInline,
  resolveTraceFrameSymbol,
} from '../utils/traceDecoder';

/**
 * Converts an ArrayBuffer to a Base64 string in chunks to prevent call-stack overflow on large traces.
 */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK_SIZE = 0x8000; // 32KB
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Converts a Base64 string back to Uint8Array for binary Blob creation.
 */
export function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Checks whether a given filename or buffer represents a Vector Binary Log (.blf).
 * Vector BLF files begin with ASCII magic "LOGG" (0x4C, 0x4F, 0x47, 0x47).
 */
export function isBlfFile(fileName: string, headerBytes?: Uint8Array): boolean {
  if (fileName.toLowerCase().endsWith('.blf')) return true;
  if (headerBytes && headerBytes.length >= 4) {
    return (
      headerBytes[0] === 0x4c &&
      headerBytes[1] === 0x4f &&
      headerBytes[2] === 0x47 &&
      headerBytes[3] === 0x47
    );
  }
  return false;
}

export type TraceRecordingState = 'recording' | 'paused' | 'stopped';
export type TraceExportFormat = 'trc' | 'asc' | 'csv';

export interface TraceSession {
  id: string;
  index: number;
  name: string;
  fileName: string;
  createdAtIso: string;
  state: TraceRecordingState;
  ring: ChronoRingBuffer;
  /** Snapshot clone used while `state === 'paused'` so live capture can optionally continue or freeze cleanly */
  displayRing: ChronoRingBuffer;
  version: number;
  count: number;
  maxBufferRows: number;
  totalCaptured: number;
  rxCaptured: number;
  txCaptured: number;
  errCaptured: number;
  originTimestampUs: number;
  lastTimestampUs: number;
  lastSeenMaxTs: number;
  lastProcessedSeq?: number;
  busFilter: number | null; // null = all buses
  savedFilePath: string | null;
  savedAtIso: string | null;
  dirtySinceSave: boolean;
}

export interface TraceSessionsState {
  sessions: readonly TraceSession[];
  activeSessionId: string;
  anyRecording: boolean;
  recordingCount: number;
  tracesDir: string;
  savedFiles: readonly TraceFileSummaryDto[];
  autoSaveOnStop: boolean;
  replayingSessionId: string | null;
  replayFilterMode: TraceReplayFilterMode;
  replayFilterKeys: readonly string[];
  replayDirectionFilter: TraceReplayDirectionFilter;
}

let nextTraceNumber = 1;

function buildTimestampFileStem(index: number, date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}_Trace${index}.trc`;
}

function createTraceSessionObject(
  initialState: TraceRecordingState,
  customName?: string,
  busFilter: number | null = null,
): TraceSession {
  const idx = nextTraceNumber++;
  const now = new Date();
  const ring = new ChronoRingBuffer(DEFAULT_CHRONO_BUFFER_ROWS);
  return {
    id: `trace-${idx}-${now.getTime()}`,
    index: idx,
    name: customName?.trim() || `Trace ${idx}`,
    fileName: buildTimestampFileStem(idx, now),
    createdAtIso: now.toISOString(),
    state: initialState,
    ring,
    displayRing: ring,
    version: 0,
    count: 0,
    maxBufferRows: DEFAULT_CHRONO_BUFFER_ROWS,
    totalCaptured: 0,
    rxCaptured: 0,
    txCaptured: 0,
    errCaptured: 0,
    originTimestampUs: 0,
    lastTimestampUs: 0,
    lastSeenMaxTs: -1,
    lastProcessedSeq: -1,
    busFilter,
    savedFilePath: null,
    savedAtIso: null,
    dirtySinceSave: false,
  };
}

const initialSession = createTraceSessionObject('stopped', 'Trace 1');

let storeState: TraceSessionsState = {
  sessions: [initialSession],
  activeSessionId: initialSession.id,
  anyRecording: false,
  recordingCount: 0,
  tracesDir: './traces',
  savedFiles: [],
  autoSaveOnStop: true,
  replayingSessionId: null,
  replayFilterMode: 'all',
  replayFilterKeys: [],
  replayDirectionFilter: 'all',
};

const listeners = new Set<() => void>();

function recomputeAndEmit(nextSessions: readonly TraceSession[], nextActiveId?: string): void {
  const recCount = nextSessions.filter((s) => s.state === 'recording').length;
  const resolvedActive =
    nextActiveId && nextSessions.some((s) => s.id === nextActiveId)
      ? nextActiveId
      : nextSessions.some((s) => s.id === storeState.activeSessionId)
        ? storeState.activeSessionId
        : (nextSessions[0]?.id ?? '');

  storeState = {
    ...storeState,
    sessions: nextSessions,
    activeSessionId: resolvedActive,
    anyRecording: recCount > 0,
    recordingCount: recCount,
  };

  for (const fn of listeners) {
    fn();
  }
}

// Subscribe once to 60Hz raw telemetry snapshots — zero overhead when no Trace is recording!
telemetryStore.subscribeRawSnapshots((snap) => {
  if (!storeState.anyRecording) return;
  const incoming = snap.recentChronological;
  if (incoming.length === 0) return;

  let anyMutated = false;
  const nextSessions = storeState.sessions.map((sess) => {
    if (sess.state !== 'recording') return sess;
    if (sess.lastProcessedSeq !== undefined && sess.lastProcessedSeq === snap.seq) {
      return sess;
    }

    let originTs = sess.originTimestampUs;
    let lastTs = sess.lastTimestampUs;
    let totalCap = sess.totalCaptured;
    let rxCap = sess.rxCaptured;
    let txCap = sess.txCaptured;
    let errCap = sess.errCaptured;

    const batchLastTs = incoming[incoming.length - 1].timestampUs;

    let appended = 0;
    for (let i = 0; i < incoming.length; i++) {
      const f = incoming[i];
      if (sess.busFilter !== null && f.busId !== sess.busFilter) continue;

      if (originTs === 0) {
        originTs = f.timestampUs;
      }
      const isErr = Boolean(f.isError);
      sess.ring.push({
        ...f,
        isBrs: Boolean(f.isBrs),
        isError: isErr,
      });
      lastTs = f.timestampUs;
      totalCap += 1;
      if (isErr) {
        errCap += 1;
      } else if (f.isTx) {
        txCap += 1;
      } else {
        rxCap += 1;
      }
      appended += 1;
    }

    if (appended === 0) {
      sess.lastProcessedSeq = snap.seq;
      sess.lastSeenMaxTs = batchLastTs;
      return sess;
    }

    anyMutated = true;
    return {
      ...sess,
      displayRing: sess.ring,
      version: sess.version + 1,
      count: sess.ring.length,
      totalCaptured: totalCap,
      rxCaptured: rxCap,
      txCaptured: txCap,
      errCaptured: errCap,
      originTimestampUs: originTs,
      lastTimestampUs: lastTs,
      lastSeenMaxTs: batchLastTs,
      lastProcessedSeq: snap.seq,
      dirtySinceSave: true,
    };
  });

  if (anyMutated) {
    recomputeAndEmit(nextSessions);
  }
});

export const traceSessionsStore = {
  getState(): TraceSessionsState {
    return storeState;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getSession(sessionId?: string | null): TraceSession {
    const targetId = sessionId || storeState.activeSessionId;
    return (
      storeState.sessions.find((s) => s.id === targetId) ??
      storeState.sessions[0]
    );
  },

  setActiveSession(sessionId: string): void {
    if (storeState.activeSessionId === sessionId) return;
    if (!storeState.sessions.some((s) => s.id === sessionId)) return;
    recomputeAndEmit(storeState.sessions, sessionId);
  },

  setAutoSaveOnStop(enabled: boolean): void {
    if (storeState.autoSaveOnStop === enabled) return;
    storeState = { ...storeState, autoSaveOnStop: enabled };
    for (const fn of listeners) fn();
  },

  setReplayingSessionId(id: string | null): void {
    if (storeState.replayingSessionId === id) return;
    storeState = { ...storeState, replayingSessionId: id };
    for (const fn of listeners) fn();
  },

  /**
   * Sets or updates Replay filter mode ('all' | 'include' | 'exclude'), selected message keys,
   * and direction filter ('all' | 'rx' | 'tx').
   * If a replay is currently running, applies changes immediately to the Rust backend without restarting.
   */
  setReplayFilterConfig(patch: {
    filterMode?: TraceReplayFilterMode;
    filterKeys?: string[];
    directionFilter?: TraceReplayDirectionFilter;
  }): void {
    const nextMode = patch.filterMode ?? storeState.replayFilterMode;
    const nextKeys = patch.filterKeys ?? [...storeState.replayFilterKeys];
    const nextDir = patch.directionFilter ?? storeState.replayDirectionFilter;

    storeState = {
      ...storeState,
      replayFilterMode: nextMode,
      replayFilterKeys: nextKeys,
      replayDirectionFilter: nextDir,
    };
    for (const fn of listeners) fn();

    const currentReplay = telemetryStore.getHeaderSlice().replay;
    if (
      currentReplay &&
      (currentReplay.state === 'playing' || currentReplay.state === 'paused')
    ) {
      void apiControlTraceReplay({
        action: 'configure',
        filterMode: nextMode,
        updateFilterKeys: true,
        filterKeys: [...nextKeys],
        directionFilter: nextDir,
      }).catch((err) => {
        console.warn('[traceSessionsStore] Live replay filter update error:', err);
      });
    }
  },

  /**
   * Refreshes the list of files in the project workspace `traces/` folder.
   */
  async refreshSavedTraces(): Promise<TraceStorageInfoDto> {
    try {
      const info = await apiListTraces();
      storeState = {
        ...storeState,
        tracesDir: info.tracesDir,
        savedFiles: info.files,
      };
      for (const fn of listeners) fn();
      return info;
    } catch (err) {
      console.warn('[traceSessionsStore] refreshSavedTraces error:', err);
      return { tracesDir: storeState.tracesDir, files: [...storeState.savedFiles] };
    }
  },

  /**
   * Starts recording on a specific Trace session.
   * If `resetIfStoppedWithData` is true and the session was previously stopped with frames,
   * clears its buffer and starts a fresh recording from 0.0000 s.
   */
  startRecording(sessionId?: string, resetIfStoppedWithData = false): TraceSession {
    const target = traceSessionsStore.getSession(sessionId);
    const nowSnap = telemetryStore.getLatestRawSnapshot();
    const baselineLastSeen =
      nowSnap && nowSnap.recentChronological.length > 0
        ? nowSnap.recentChronological[nowSnap.recentChronological.length - 1].timestampUs
        : -1;

    const nextSessions = storeState.sessions.map((s) => {
      if (s.id !== target.id) return s;
      if (s.state === 'recording') return s;

      const shouldReset = resetIfStoppedWithData && s.state === 'stopped' && s.count > 0;
      if (shouldReset) {
        s.ring.clear();
        const now = new Date();
        return {
          ...s,
          fileName: buildTimestampFileStem(s.index, now),
          createdAtIso: now.toISOString(),
          state: 'recording' as const,
          displayRing: s.ring,
          version: s.version + 1,
          count: 0,
          totalCaptured: 0,
          rxCaptured: 0,
          txCaptured: 0,
          errCaptured: 0,
          originTimestampUs: 0,
          lastTimestampUs: 0,
          lastSeenMaxTs: baselineLastSeen,
          lastProcessedSeq: nowSnap?.seq ?? -1,
          savedFilePath: null,
          savedAtIso: null,
          dirtySinceSave: false,
        };
      }

      return {
        ...s,
        state: 'recording' as const,
        displayRing: s.ring,
        version: s.version + 1,
        lastSeenMaxTs: s.count === 0 ? baselineLastSeen : s.lastSeenMaxTs,
        lastProcessedSeq: s.count === 0 ? (nowSnap?.seq ?? -1) : s.lastProcessedSeq,
      };
    });

    recomputeAndEmit(nextSessions, target.id);
    if (plotStore.getState().paused) {
      plotStore.setPaused(false);
    }
    plotStore.setIsStaticTraceLoaded(false);
    logUiDebugEvent({
      severity: 'info',
      category: 'TRACE',
      action: target.count === 0 ? 'trace.record.start' : 'trace.record.resume',
      title: `${target.count === 0 ? 'Trace Started' : 'Trace Resumed'}: ${target.name}`,
      details: `Bus: ${target.busFilter !== null ? target.busFilter + 1 : 'ALL'}, Max Rows: ${target.maxBufferRows}`,
    });
    return traceSessionsStore.getSession(target.id);
  },

  pauseRecording(sessionId?: string): void {
    const target = traceSessionsStore.getSession(sessionId);
    const nextSessions = storeState.sessions.map((s) => {
      if (s.id !== target.id || s.state !== 'recording') return s;
      const snapClone = s.ring.cloneSnapshot();
      return {
        ...s,
        state: 'paused' as const,
        displayRing: snapClone,
        version: s.version + 1,
        count: snapClone.length,
      };
    });
    recomputeAndEmit(nextSessions);
    logUiDebugEvent({
      severity: 'info',
      category: 'TRACE',
      action: 'trace.record.pause',
      title: `Trace Paused: ${target.name}`,
      details: `Buffered Frames: ${target.count}`,
    });
  },

  stopRecording(sessionId?: string): TraceSession {
    const target = traceSessionsStore.getSession(sessionId);
    const wasRecording = target.state === 'recording';
    const nextSessions = storeState.sessions.map((s) => {
      if (s.id !== target.id || s.state === 'stopped') return s;
      return {
        ...s,
        state: 'stopped' as const,
        displayRing: s.ring,
        version: s.version + 1,
        count: s.ring.length,
      };
    });
    recomputeAndEmit(nextSessions);

    if (wasRecording) {
      logUiDebugEvent({
        severity: 'info',
        category: 'TRACE',
        action: 'trace.record.stop',
        title: `Trace Stopped: ${target.name}`,
        details: `Total: ${target.totalCaptured}, Rx: ${target.rxCaptured}, Tx: ${target.txCaptured}, Err: ${target.errCaptured}`,
      });
      // NOTE: stopping a trace must NOT pause the plotter. Plot ingestion is independent of
      // trace recording; `plotStore.paused` is only a user action (Space / Pause button).
    }

    if (wasRecording && target.count > 0 && storeState.autoSaveOnStop) {
      void traceSessionsStore.saveSessionToDisk(target.id, 'trc').catch((err) => {
        console.warn('[traceSessionsStore] Auto-save on stop error:', err);
      });
    }

    return traceSessionsStore.getSession(target.id);
  },

  /**
   * Primary TopBar single-click action:
   * - If active session is recording -> stops it cleanly (and auto-saves if enabled).
   * - Otherwise -> starts/resumes recording on active session!
   */
  toggleActiveRecording(): { session: TraceSession; started: boolean } {
    const active = traceSessionsStore.getSession();
    if (active.state === 'recording') {
      const stopped = traceSessionsStore.stopRecording(active.id);
      return { session: stopped, started: false };
    }
    const updated = traceSessionsStore.startRecording(active.id, false);
    return { session: updated, started: true };
  },

  /**
   * Spawns an additional independent Trace session ("Bir Trace Daha Başlat")
   * and immediately begins recording on it without disturbing existing Trace sessions!
   */
  spawnNewTraceSession(options?: {
    autoStart?: boolean;
    name?: string;
    busFilter?: number | null;
  }): TraceSession {
    const autoStart = options?.autoStart ?? true;
    const nowSnap = telemetryStore.getLatestRawSnapshot();
    const baselineLastSeen =
      nowSnap && nowSnap.recentChronological.length > 0
        ? nowSnap.recentChronological[nowSnap.recentChronological.length - 1].timestampUs
        : -1;

    const created = createTraceSessionObject(
      autoStart ? 'recording' : 'stopped',
      options?.name,
      options?.busFilter ?? null,
    );
    created.lastSeenMaxTs = baselineLastSeen;
    created.lastProcessedSeq = nowSnap?.seq ?? -1;

    const nextSessions = [...storeState.sessions, created];
    recomputeAndEmit(nextSessions, created.id);
    if (autoStart) {
      if (plotStore.getState().paused) {
        plotStore.setPaused(false);
      }
      plotStore.setIsStaticTraceLoaded(false);
    }
    logUiDebugEvent({
      severity: 'info',
      category: 'TRACE',
      action: 'trace.session.spawn',
      title: `New Trace Session Spawned: ${created.name}`,
      details: `Auto-Start: ${autoStart}, Bus: ${created.busFilter !== null ? created.busFilter + 1 : 'ALL'}`,
    });
    return created;
  },

  renameSession(sessionId: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    const nextSessions = storeState.sessions.map((s) =>
      s.id === sessionId ? { ...s, name: trimmed } : s,
    );
    recomputeAndEmit(nextSessions);
  },

  setSessionBusFilter(sessionId: string, busFilter: number | null): void {
    const nextSessions = storeState.sessions.map((s) =>
      s.id === sessionId ? { ...s, busFilter, version: s.version + 1 } : s,
    );
    recomputeAndEmit(nextSessions);
  },

  setSessionMaxBufferRows(sessionId: string, limit: number): void {
    const clamped = Math.max(
      MIN_CHRONO_BUFFER_ROWS,
      Math.min(MAX_CHRONO_BUFFER_ROWS, Math.floor(limit || DEFAULT_CHRONO_BUFFER_ROWS)),
    );
    const nextSessions = storeState.sessions.map((s) => {
      if (s.id !== sessionId) return s;
      s.ring.resize(clamped);
      if (s.displayRing !== s.ring) {
        s.displayRing.resize(clamped);
      }
      return {
        ...s,
        maxBufferRows: clamped,
        count: s.displayRing.length,
        version: s.version + 1,
      };
    });
    recomputeAndEmit(nextSessions);
    const targetSession = storeState.sessions.find((s) => s.id === sessionId);
    logUiDebugEvent({
      severity: 'info',
      category: 'TRACE',
      action: 'trace.buffer.resize',
      title: `Trace Buffer Resized: ${targetSession?.name ?? sessionId}`,
      details: `Max Rows: ${clamped}`,
    });
  },

  clearSession(sessionId?: string): void {
    const target = traceSessionsStore.getSession(sessionId);
    const nextSessions = storeState.sessions.map((s) => {
      if (s.id !== target.id) return s;
      s.ring.clear();
      if (s.displayRing !== s.ring) {
        s.displayRing.clear();
      }
      return {
        ...s,
        displayRing: s.state === 'paused' ? s.ring.cloneSnapshot() : s.ring,
        version: s.version + 1,
        count: 0,
        totalCaptured: 0,
        rxCaptured: 0,
        txCaptured: 0,
        errCaptured: 0,
        originTimestampUs: 0,
        lastTimestampUs: 0,
        savedFilePath: null,
        savedAtIso: null,
        dirtySinceSave: false,
      };
    });
    recomputeAndEmit(nextSessions);
    logUiDebugEvent({
      severity: 'info',
      category: 'TRACE',
      action: 'trace.record.clear',
      title: `Trace Buffer Cleared: ${target.name}`,
    });
  },

  closeSession(sessionId: string): void {
    if (storeState.sessions.length <= 1) {
      // Keep at least 1 default Trace session, stop and clear it
      traceSessionsStore.stopRecording(sessionId);
      traceSessionsStore.clearSession(sessionId);
      return;
    }
    const remaining = storeState.sessions.filter((s) => s.id !== sessionId);
    const nextActive =
      storeState.activeSessionId === sessionId
        ? remaining[remaining.length - 1].id
        : storeState.activeSessionId;
    recomputeAndEmit(remaining, nextActive);
  },

  stopAllRecordings(): void {
    const toAutoSave: string[] = [];
    const nextSessions = storeState.sessions.map((s) => {
      if (s.state === 'recording' || s.state === 'paused') {
        if (s.state === 'recording' && s.count > 0 && storeState.autoSaveOnStop) {
          toAutoSave.push(s.id);
        }
        return { ...s, state: 'stopped' as const, displayRing: s.ring, version: s.version + 1 };
      }
      return s;
    });
    recomputeAndEmit(nextSessions);
    // Plotter keeps running: only trace recording stops (see stopRecording).

    for (const sid of toAutoSave) {
      void traceSessionsStore.saveSessionToDisk(sid, 'trc').catch((err) => {
        console.warn('[traceSessionsStore] Auto-save error:', err);
      });
    }
  },

  /**
   * Generates the serialized string representation of a Trace session in `.trc`, `.asc`, or `.csv` format.
   */
  serializeSessionContent(
    sessionId: string,
    format: TraceExportFormat,
  ): { fileName: string; content: string } {
    const sess = traceSessionsStore.getSession(sessionId);
    const ring = sess.displayRing;
    const len = ring.length;
    const originUs =
      sess.originTimestampUs > 0
        ? sess.originTimestampUs
        : len > 0
          ? (ring.getAt(0)?.timestampUs ?? 0)
          : 0;
    const baseStem = sess.fileName.replace(/\.(trc|asc|csv|log)$/i, '');
    const outFileName = `${baseStem}.${format}`;

    const lines: string[] = [];

    if (format === 'trc') {
      lines.push(';$FILEVERSION=2.1');
      lines.push(`;$STARTTIME=${(new Date(sess.createdAtIso).getTime() / 86400000 + 25569).toFixed(10)}`);
      lines.push(';$COLUMNS=N,O,T,B,I,d,L,D');
      lines.push(';');
      lines.push(`;   NexusCAN Trace Recording — ${sess.name} (${outFileName})`);
      lines.push(`;   Start time: ${sess.createdAtIso}`);
      lines.push(`;   Captured frames: ${len}`);
      lines.push(';-------------------------------------------------------------------------------');
      for (let i = 0; i < len; i++) {
        const f = ring.getAt(i);
        if (!f) continue;
        const relMs = originUs > 0 ? Math.max(0, (f.timestampUs - originUs) / 1000) : 0;
        const isErr = Boolean(f.isError);
        const typeStr = isErr ? 'ER' : f.isFd || f.dlc > 8 ? 'FD' : 'DT';
        const idStr = formatPcanIdHex(f.arbId, f.isExtended);
        const dirStr = isErr ? 'Er' : f.isTx ? 'Tx' : 'Rx';
        const byteCount = Math.min(f.dlc, f.rawBytes.length);
        const bytesHex = Array.from({ length: byteCount }, (_, b) =>
          formatByteHex(f.rawBytes[b] ?? 0),
        ).join(' ');
        lines.push(
          `${String(i + 1).padStart(7, ' ')} ${relMs.toFixed(3).padStart(11, ' ')} ${typeStr} ${String(f.busId + 1).padStart(2, ' ')} ${idStr.padStart(8, ' ')} ${dirStr} ${String(f.dlc).padStart(2, ' ')}  ${bytesHex}`,
        );
      }
    } else if (format === 'asc') {
      const dateStr = new Date(sess.createdAtIso).toString();
      lines.push(`date ${dateStr}`);
      lines.push('base hex  timestamps absolute');
      lines.push('internal events logged');
      lines.push('// version 11.0.0 NexusCAN');
      lines.push(`Begin Triggerblock ${dateStr}`);
      for (let i = 0; i < len; i++) {
        const f = ring.getAt(i);
        if (!f) continue;
        const relSec = originUs > 0 ? Math.max(0, (f.timestampUs - originUs) / 1_000_000) : 0;
        const isErr = Boolean(f.isError);
        if (isErr) {
          lines.push(
            `${relSec.toFixed(6).padStart(11, ' ')} ${f.busId + 1}  ErrorFrame`,
          );
          continue;
        }
        const idStr = `${formatPcanIdHex(f.arbId, f.isExtended)}${f.isExtended ? 'x' : ''}`;
        const dirStr = f.isTx ? 'Tx' : 'Rx';
        const byteCount = Math.min(f.dlc, f.rawBytes.length);
        const bytesHex = Array.from({ length: byteCount }, (_, b) =>
          formatByteHex(f.rawBytes[b] ?? 0),
        ).join(' ');
        if (f.isFd || f.dlc > 8) {
          const dlcCode =
            byteCount <= 8
              ? String(byteCount)
              : byteCount <= 12
                ? '9'
                : byteCount <= 16
                  ? 'a'
                  : byteCount <= 20
                    ? 'b'
                    : byteCount <= 24
                      ? 'c'
                      : byteCount <= 32
                        ? 'd'
                        : byteCount <= 48
                          ? 'e'
                          : 'f';
          lines.push(
            `${relSec.toFixed(6).padStart(11, ' ')} CANFD ${f.busId + 1} ${dirStr} ${idStr}  1 0 ${dlcCode} ${byteCount} ${bytesHex}`,
          );
        } else {
          lines.push(
            `${relSec.toFixed(6).padStart(11, ' ')} ${f.busId + 1}  ${idStr.padEnd(9, ' ')} ${dirStr}   d ${Math.min(8, f.dlc)} ${bytesHex}`,
          );
        }
      }
      lines.push('End TriggerBlock');
    } else {
      lines.push('Index,Time_s,Bus,Protocol,ID_Hex,Direction,DLC,Symbol,Data_Hex,Decoded_Signals');
      for (let i = 0; i < len; i++) {
        const f = ring.getAt(i);
        if (!f) continue;
        const relSec = originUs > 0 ? Math.max(0, (f.timestampUs - originUs) / 1_000_000) : 0;
        const isErr = Boolean(f.isError);
        const proto = isErr ? 'ERR' : f.isFd || f.dlc > 8 ? 'FD' : 'CC';
        const idStr = formatPcanIdHex(f.arbId, f.isExtended);
        const dirStr = isErr ? 'Err' : f.isTx ? 'Tx' : 'Rx';
        const msg = databaseStore.getMessageForBus(f.busId, f.messageKey, f.arbId, f.isExtended);
        const signalsById = databaseStore.getBusSignals(f.busId);
        const sym = isErr
          ? 'BUS ERROR'
          : msg
            ? resolveTraceFrameSymbol(f.rawBytes, msg, signalsById).fullSymbol
            : '';
        const decoded = isErr
          ? f.errorSummary || formatErrorFrameShortTitle(f.arbId, f.rawBytes)
          : msg
            ? formatDecodedTraceInline(decodeTraceFrame(f.rawBytes, msg, signalsById))
            : '';
        const byteCount = Math.min(f.dlc, f.rawBytes.length);
        const bytesHex = Array.from({ length: byteCount }, (_, b) =>
          formatByteHex(f.rawBytes[b] ?? 0),
        ).join(' ');
        const esc = csvQuote;
        lines.push(
          `${i + 1},${relSec.toFixed(6)},${f.busId + 1},${proto},${idStr},${dirStr},${f.dlc},${esc(sym)},${esc(bytesHex)},${esc(decoded)}`,
        );
      }
    }

    return { fileName: outFileName, content: lines.join('\n') + '\n' };
  },

  /**
   * Saves the current Trace session directly to the project workspace `traces/` folder.
   */
  async saveSessionToDisk(
    sessionId: string,
    format: TraceExportFormat = 'trc',
  ): Promise<TraceFileSummaryDto> {
    const { fileName, content } = traceSessionsStore.serializeSessionContent(sessionId, format);
    const summary = await apiSaveTraceFile(fileName, content);

    const nextSessions = storeState.sessions.map((s) =>
      s.id === sessionId
        ? {
            ...s,
            fileName: summary.fileName,
            savedFilePath: summary.filePath,
            savedAtIso: summary.updatedAt,
            dirtySinceSave: false,
            version: s.version + 1,
          }
        : s,
    );
    recomputeAndEmit(nextSessions);
    void traceSessionsStore.refreshSavedTraces();
    return summary;
  },

  /**
   * Exports a Trace session to browser/Tauri download file (`~/Downloads`).
   */
  exportSessionToFile(sessionId: string, format: TraceExportFormat): string {
    const { fileName, content } = traceSessionsStore.serializeSessionContent(sessionId, format);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    logUiDebugEvent({
      severity: 'info',
      category: 'TRACE',
      action: 'trace.export',
      title: `Trace Exported: ${fileName}`,
      details: `Format: ${format.toUpperCase()}`,
    });
    return fileName;
  },

  /**
   * Exports session frames to Vector Binary Log (.blf) format using the Rust backend engine.
   */
  async exportSessionToBlf(sessionId: string): Promise<string> {
    const sess = traceSessionsStore.getSession(sessionId);
    const ring = sess.displayRing;
    const len = ring.length;
    const frames: ChronologicalFrameDto[] = [];
    for (let i = 0; i < len; i++) {
      const f = ring.getAt(i);
      if (f) {
        frames.push({
          ...f,
          isBrs: Boolean(f.isBrs),
        });
      }
    }
    const baseStem = sess.fileName.replace(/\.(trc|asc|csv|log|blf)$/i, '');
    const outFileName = `${baseStem}.blf`;
    const base64 = await apiExportTraceBlf(outFileName, frames);
    const uint8 = base64ToUint8Array(base64);
    const blob = new Blob([uint8], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = outFileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return outFileName;
  },

  /**
   * Loads a saved file from `traces/` into a Trace session and focuses it.
   */
  async openSavedTraceFile(fileName: string): Promise<TraceSession> {
    const loaded = await apiLoadTraceFile(fileName);
    const existing = storeState.sessions.find(
      (s) =>
        (s.fileName === loaded.summary.fileName ||
          s.savedFilePath === loaded.summary.filePath) &&
        s.state !== 'recording',
    );
    const isSingleEmptyInitial =
      !existing &&
      storeState.sessions.length === 1 &&
      storeState.sessions[0].count === 0 &&
      storeState.sessions[0].state === 'stopped' &&
      !storeState.sessions[0].savedFilePath;

    const targetSession = existing || (isSingleEmptyInitial ? storeState.sessions[0] : null);

    const neededCap = Math.min(
      MAX_CHRONO_BUFFER_ROWS,
      Math.max(DEFAULT_CHRONO_BUFFER_ROWS, loaded.frames.length),
    );

    let session: TraceSession;
    if (targetSession) {
      targetSession.ring.resize(neededCap);
      targetSession.ring.clear();
      for (const f of loaded.frames) {
        targetSession.ring.push({
          ...f,
          isBrs: Boolean(f.isBrs),
          isError: Boolean(f.isError),
        });
      }
      targetSession.displayRing = targetSession.ring;
      targetSession.count = targetSession.ring.length;
      targetSession.maxBufferRows = neededCap;
      targetSession.totalCaptured = targetSession.count;
      targetSession.rxCaptured = loaded.frames.filter((f) => !f.isTx && !f.isError).length;
      targetSession.txCaptured = loaded.frames.filter((f) => f.isTx && !f.isError).length;
      targetSession.errCaptured = loaded.frames.filter((f) => Boolean(f.isError)).length;
      targetSession.originTimestampUs = loaded.frames[0]?.timestampUs ?? 0;
      targetSession.lastTimestampUs = loaded.frames[loaded.frames.length - 1]?.timestampUs ?? 0;
      targetSession.lastSeenMaxTs = loaded.frames[loaded.frames.length - 1]?.timestampUs ?? -1;
      targetSession.state = 'stopped';
      targetSession.name = loaded.summary.fileName.replace(/\.(trc|asc|log|csv|blf)$/i, '');
      targetSession.fileName = loaded.summary.fileName;
      targetSession.savedFilePath = loaded.summary.filePath;
      targetSession.savedAtIso = loaded.summary.updatedAt;
      targetSession.dirtySinceSave = false;
      targetSession.version += 1;
      session = targetSession;
      recomputeAndEmit(storeState.sessions, targetSession.id);
    } else {
      const idx = nextTraceNumber++;
      const now = new Date();
      const ring = new ChronoRingBuffer(neededCap);
      for (const f of loaded.frames) {
        ring.push({
          ...f,
          isBrs: Boolean(f.isBrs),
          isError: Boolean(f.isError),
        });
      }
      session = {
        id: `trace-${idx}-${now.getTime()}`,
        index: idx,
        name: loaded.summary.fileName.replace(/\.(trc|asc|log|csv|blf)$/i, ''),
        fileName: loaded.summary.fileName,
        createdAtIso: loaded.summary.updatedAt || now.toISOString(),
        state: 'stopped',
        ring,
        displayRing: ring,
        version: 1,
        count: ring.length,
        maxBufferRows: neededCap,
        totalCaptured: ring.length,
        rxCaptured: loaded.frames.filter((f) => !f.isTx && !f.isError).length,
        txCaptured: loaded.frames.filter((f) => f.isTx && !f.isError).length,
        errCaptured: loaded.frames.filter((f) => Boolean(f.isError)).length,
        originTimestampUs: loaded.frames[0]?.timestampUs ?? 0,
        lastTimestampUs: loaded.frames[loaded.frames.length - 1]?.timestampUs ?? 0,
        lastSeenMaxTs: loaded.frames[loaded.frames.length - 1]?.timestampUs ?? -1,
        busFilter: null,
        savedFilePath: loaded.summary.filePath,
        savedAtIso: loaded.summary.updatedAt,
        dirtySinceSave: false,
      };
      const nextSessions = [...storeState.sessions, session];
      recomputeAndEmit(nextSessions, session.id);
    }

    databaseStore.setActiveDocTab('trace');
    return session;
  },

  /**
   * Imports a trace file from user's computer (.trc, .asc, .log, .csv, .blf), parses it via backend,
   * opens it in a new Trace tab.
   * If `contentBase64` is provided, passes binary base64 payload to preserve binary integrity.
   */
  async importLocalTraceFile(
    fileName: string,
    content: string,
    alsoSaveToDisk = false,
    contentBase64?: string,
  ): Promise<TraceSession> {
    const isBinary = Boolean(contentBase64 && contentBase64.length > 0);
    const loaded = await apiParseTraceContent(
      fileName,
      content,
      isBinary ? contentBase64 : undefined,
    );
    let diskSummary: TraceFileSummaryDto | null = null;
    if (alsoSaveToDisk) {
      try {
        diskSummary = await apiSaveTraceFile(
          fileName,
          content,
          isBinary ? contentBase64 : undefined,
        );
        void traceSessionsStore.refreshSavedTraces();
      } catch (err) {
        console.warn('[traceSessionsStore] importLocalTraceFile disk save warning:', err);
      }
    }

    const neededCap = Math.min(
      MAX_CHRONO_BUFFER_ROWS,
      Math.max(DEFAULT_CHRONO_BUFFER_ROWS, loaded.frames.length),
    );
    const existing = storeState.sessions.find(
      (s) =>
        (s.fileName === fileName ||
          (diskSummary && s.savedFilePath === diskSummary.filePath)) &&
        s.state !== 'recording',
    );
    const isSingleEmptyInitial =
      !existing &&
      storeState.sessions.length === 1 &&
      storeState.sessions[0].count === 0 &&
      storeState.sessions[0].state === 'stopped' &&
      !storeState.sessions[0].savedFilePath;

    const targetSession = existing || (isSingleEmptyInitial ? storeState.sessions[0] : null);

    const now = new Date();
    let session: TraceSession;

    if (targetSession) {
      targetSession.ring.resize(neededCap);
      targetSession.ring.clear();
      for (const f of loaded.frames) {
        targetSession.ring.push({
          ...f,
          isBrs: Boolean(f.isBrs),
          isError: Boolean(f.isError),
        });
      }
      targetSession.displayRing = targetSession.ring;
      targetSession.count = targetSession.ring.length;
      targetSession.maxBufferRows = neededCap;
      targetSession.totalCaptured = targetSession.count;
      targetSession.rxCaptured = loaded.frames.filter((f) => !f.isTx && !f.isError).length;
      targetSession.txCaptured = loaded.frames.filter((f) => f.isTx && !f.isError).length;
      targetSession.errCaptured = loaded.frames.filter((f) => Boolean(f.isError)).length;
      targetSession.originTimestampUs = loaded.frames[0]?.timestampUs ?? 0;
      targetSession.lastTimestampUs =
        loaded.frames[loaded.frames.length - 1]?.timestampUs ?? 0;
      targetSession.lastSeenMaxTs =
        loaded.frames[loaded.frames.length - 1]?.timestampUs ?? -1;
      targetSession.state = 'stopped';
      targetSession.name = fileName.replace(/\.(trc|asc|log|csv|blf)$/i, '');
      targetSession.fileName = fileName;
      targetSession.savedFilePath = diskSummary?.filePath ?? null;
      targetSession.savedAtIso = diskSummary?.updatedAt ?? now.toISOString();
      targetSession.dirtySinceSave = diskSummary === null;
      targetSession.version += 1;
      session = targetSession;
      recomputeAndEmit(storeState.sessions, targetSession.id);
    } else {
      const idx = nextTraceNumber++;
      const ring = new ChronoRingBuffer(neededCap);
      for (const f of loaded.frames) {
        ring.push({
          ...f,
          isBrs: Boolean(f.isBrs),
          isError: Boolean(f.isError),
        });
      }
      session = {
        id: `trace-${idx}-${now.getTime()}`,
        index: idx,
        name: fileName.replace(/\.(trc|asc|log|csv|blf)$/i, ''),
        fileName,
        createdAtIso: now.toISOString(),
        state: 'stopped',
        ring,
        displayRing: ring,
        version: 1,
        count: ring.length,
        maxBufferRows: neededCap,
        totalCaptured: ring.length,
        rxCaptured: loaded.frames.filter((f) => !f.isTx && !f.isError).length,
        txCaptured: loaded.frames.filter((f) => f.isTx && !f.isError).length,
        errCaptured: loaded.frames.filter((f) => Boolean(f.isError)).length,
        originTimestampUs: loaded.frames[0]?.timestampUs ?? 0,
        lastTimestampUs: loaded.frames[loaded.frames.length - 1]?.timestampUs ?? 0,
        lastSeenMaxTs: loaded.frames[loaded.frames.length - 1]?.timestampUs ?? -1,
        busFilter: null,
        savedFilePath: diskSummary?.filePath ?? null,
        savedAtIso: diskSummary?.updatedAt ?? now.toISOString(),
        dirtySinceSave: diskSummary === null,
      };

      const nextSessions = [...storeState.sessions, session];
      recomputeAndEmit(nextSessions, session.id);
    }

    databaseStore.setActiveDocTab('trace');
    return session;
  },

  /**
   * Automatically inspects a File object:
   * - If Vector BLF (.blf or 'LOGG' magic), reads as binary ArrayBuffer -> Base64 without UTF-8 corruption.
   * - Otherwise reads as UTF-8 text (.trc, .asc, .log, .csv).
   * Opens the trace in a tab and persists to `traces/` ONLY if `alsoSaveToDisk` is explicitly true (default false; saving is an explicit user action).
   */
  async importTraceFileObject(
    file: File,
    alsoSaveToDisk = false,
  ): Promise<TraceSession> {
    const slice = await file.slice(0, 4).arrayBuffer();
    const magic = new Uint8Array(slice);
    const isBlf = isBlfFile(file.name, magic);

    if (isBlf) {
      const buf = await file.arrayBuffer();
      const contentBase64 = arrayBufferToBase64(buf);
      return traceSessionsStore.importLocalTraceFile(
        file.name,
        '',
        alsoSaveToDisk,
        contentBase64,
      );
    }

    const text = await file.text();
    return traceSessionsStore.importLocalTraceFile(
      file.name,
      text,
      alsoSaveToDisk,
    );
  },

  /**
   * Deletes a trace file from the `traces/` directory.
   */
  async deleteSavedTraceFile(fileName: string): Promise<void> {
    await apiDeleteTraceFile(fileName);
    await traceSessionsStore.refreshSavedTraces();
  },

  /**
   * Starts replaying an active or loaded Trace session through the backend Replay engine.
   */
  async startSessionReplay(
    sessionId?: string,
    opts?: {
      speedFactor?: number;
      loopPlayback?: boolean;
      busOverride?: number | null;
      transmitToHardware?: boolean;
      resetTelemetryFirst?: boolean;
      filterMode?: TraceReplayFilterMode;
      filterKeys?: string[];
      directionFilter?: TraceReplayDirectionFilter;
    },
  ): Promise<TraceReplayStatusDto> {
    const sess = traceSessionsStore.getSession(sessionId);
    if (sess.state === 'recording') {
      traceSessionsStore.stopRecording(sess.id);
    }

    const useSavedFile = Boolean(sess.savedFilePath && !sess.dirtySinceSave);
    let frames: ChronologicalFrameDto[] | null = null;
    let fileName: string | null = null;

    if (useSavedFile) {
      fileName = sess.fileName;
    } else {
      frames = [];
      const ring = sess.displayRing;
      const len = ring.length;
      for (let i = 0; i < len; i++) {
        const f = ring.getAt(i);
        if (f) {
          frames.push({
            ...f,
            isBrs: Boolean(f.isBrs),
          });
        }
      }
    }

    storeState = {
      ...storeState,
      replayingSessionId: sess.id,
    };
    for (const fn of listeners) fn();

    if (!plotStore.getState().isStaticTraceLoaded) {
      plotStore.clearBuffers();
      plotStore.setPaused(false);
    }

    return apiStartTraceReplay({
      sourceName: sess.name,
      fileName,
      frames,
      speedFactor: opts?.speedFactor ?? 1,
      loopPlayback: opts?.loopPlayback ?? false,
      busOverride: opts?.busOverride ?? null,
      transmitToHardware: opts?.transmitToHardware ?? false,
      resetTelemetryFirst: opts?.resetTelemetryFirst ?? false,
      filterMode: opts?.filterMode ?? storeState.replayFilterMode,
      filterKeys: opts?.filterKeys ?? [...storeState.replayFilterKeys],
      directionFilter: opts?.directionFilter ?? storeState.replayDirectionFilter,
    });
  },

  /**
   * Starts replaying a saved file from `traces/` directory directly.
   */
  async startSavedFileReplay(
    fileName: string,
    opts?: {
      speedFactor?: number;
      loopPlayback?: boolean;
      busOverride?: number | null;
      transmitToHardware?: boolean;
      resetTelemetryFirst?: boolean;
      filterMode?: TraceReplayFilterMode;
      filterKeys?: string[];
      directionFilter?: TraceReplayDirectionFilter;
    },
  ): Promise<TraceReplayStatusDto> {
    storeState = {
      ...storeState,
      replayingSessionId: null,
    };
    for (const fn of listeners) fn();

    if (!plotStore.getState().isStaticTraceLoaded) {
      plotStore.clearBuffers();
      plotStore.setPaused(false);
    }

    return apiStartTraceReplay({
      sourceName: fileName,
      fileName,
      speedFactor: opts?.speedFactor ?? 1,
      loopPlayback: opts?.loopPlayback ?? false,
      busOverride: opts?.busOverride ?? null,
      transmitToHardware: opts?.transmitToHardware ?? false,
      resetTelemetryFirst: opts?.resetTelemetryFirst ?? false,
      filterMode: opts?.filterMode ?? storeState.replayFilterMode,
      filterKeys: opts?.filterKeys ?? [...storeState.replayFilterKeys],
      directionFilter: opts?.directionFilter ?? storeState.replayDirectionFilter,
    });
  },
};

export function useTraceSessionsStore(): TraceSessionsState {
  return useSyncExternalStore(
    traceSessionsStore.subscribe,
    traceSessionsStore.getState,
    traceSessionsStore.getState,
  );
}

// Panic Stop: a trace replay that transmits to hardware must stop (the replay itself is stopped, not
// just muted, so it cannot resume transmitting later).
registerTxSource('trace-replay-hw-tx', () => {
  const replay = telemetryStore.getHeaderSlice().replay;
  if (replay.state === 'idle' || !replay.transmitToHardware) return;
  apiControlTraceReplay({ action: 'stop' }).catch(() => undefined);
});

if (typeof window !== 'undefined') {
  window.setTimeout(() => {
    void traceSessionsStore.refreshSavedTraces();
  }, 150);
}
