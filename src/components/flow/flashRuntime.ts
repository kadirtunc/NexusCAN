/**
 * Per-block runtime state of `uds_flash_image` blocks: the loaded firmware image handle (imageId,
 * summary) and the live run state (progress, report, error). Memory only, NEVER persisted with the
 * saved flow (the saved block keeps just `file_name` + settings).
 *
 * Progress may arrive at 60 Hz: `pushProgress` only stores the latest message per block and a single
 * requestAnimationFrame flush commits it (one React notification per frame, never per message).
 */
import { useSyncExternalStore } from 'react';
import { overallProgress, type OverallProgress } from '../../services/flashCodec';
import type {
  FlashErrorDto,
  FlashImageHandleDto,
  FlashProgressDto,
  FlashReportDto,
} from '../../types/flash';

export interface FlashImageState {
  handle: FlashImageHandleDto | null;
  /** The handle was fabricated by the DEMO loader (nothing parsed, not known to the backend). */
  mock: boolean;
  /** Kept so a format / base-address change can reload without a new file pick. */
  file: File | null;
  loadedFormat: string;
  loadedBase: number;
  loading: boolean;
  loadError: string | null;
}

export type FlashRunStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

/** Frontend-driven phase around the backend download (per-segment erase / verify routines). */
export interface FlashStage {
  kind: 'erase' | 'download' | 'verify';
  /** 1-based segment index (0 for `download`). */
  index: number;
  count: number;
}

export interface FlashRunState {
  status: FlashRunStatus;
  mock: boolean;
  progress: FlashProgressDto | null;
  overall: OverallProgress | null;
  startedAt: number;
  elapsedMs: number;
  /** Average bytes/s since the run started (overall bytes / elapsed). */
  throughputBps: number;
  report: FlashReportDto | null;
  error: FlashErrorDto | null;
  /** Human text of a failure that has no structured `FlashErrorDto` (backend missing, [firmware], ...). */
  errorText: string | null;
  /** Current erase / download / verify stage (null = plain download only). */
  stage: FlashStage | null;
}

const IDLE_IMAGE: FlashImageState = {
  handle: null,
  mock: false,
  file: null,
  loadedFormat: '',
  loadedBase: 0,
  loading: false,
  loadError: null,
};

const IDLE_RUN: FlashRunState = {
  status: 'idle',
  mock: false,
  progress: null,
  overall: null,
  startedAt: 0,
  elapsedMs: 0,
  throughputBps: 0,
  report: null,
  error: null,
  errorText: null,
  stage: null,
};

const images = new Map<string, FlashImageState>();
const runs = new Map<string, FlashRunState>();
const pending = new Map<string, FlashProgressDto>();
const listeners = new Set<() => void>();
let frame: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function notify(): void {
  for (const l of listeners) l();
}

function flush(): void {
  frame = null;
  timer = null;
  if (pending.size === 0) return;
  const now = Date.now();
  for (const [blockId, p] of pending) {
    const prev = runs.get(blockId);
    if (!prev || prev.status !== 'running') continue;
    const overall = overallProgress(p, images.get(blockId)?.handle?.summary ?? null);
    const elapsedMs = Math.max(0, now - prev.startedAt);
    runs.set(blockId, {
      ...prev,
      progress: p,
      overall,
      elapsedMs,
      throughputBps: elapsedMs > 0 ? Math.round((overall.done * 1000) / elapsedMs) : 0,
    });
  }
  pending.clear();
  notify();
}

function schedule(): void {
  if (frame !== null || timer !== null) return;
  if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(flush);
  else timer = setTimeout(flush, 16);
}

function dropPending(blockId: string): void {
  pending.delete(blockId);
}

export const flashRuntime = {
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },

  getImage(blockId: string): FlashImageState {
    return images.get(blockId) ?? IDLE_IMAGE;
  },

  getRun(blockId: string): FlashRunState {
    return runs.get(blockId) ?? IDLE_RUN;
  },

  patchImage(blockId: string, patch: Partial<FlashImageState>): void {
    images.set(blockId, { ...this.getImage(blockId), ...patch });
    notify();
  },

  removeImage(blockId: string): void {
    if (images.delete(blockId)) notify();
  },

  beginRun(blockId: string, mock: boolean): void {
    dropPending(blockId);
    runs.set(blockId, { ...IDLE_RUN, status: 'running', mock, startedAt: Date.now() });
    notify();
  },

  /** Erase / download / verify stage change (a few per run: committed immediately). */
  setStage(blockId: string, stage: FlashStage | null): void {
    const prev = runs.get(blockId);
    if (!prev || prev.status !== 'running') return;
    runs.set(blockId, { ...prev, stage });
    notify();
  },

  /** Coalesced to one commit per animation frame. */
  pushProgress(blockId: string, p: FlashProgressDto): void {
    if (runs.get(blockId)?.status !== 'running') return;
    pending.set(blockId, p);
    schedule();
  },

  finishRun(
    blockId: string,
    outcome: { status: 'done'; report: FlashReportDto } | { status: 'error' | 'cancelled'; error: FlashErrorDto | null; errorText: string | null },
  ): void {
    dropPending(blockId);
    const prev = runs.get(blockId) ?? IDLE_RUN;
    const elapsedMs = prev.startedAt > 0 ? Date.now() - prev.startedAt : prev.elapsedMs;
    if (outcome.status === 'done') {
      const total = outcome.report.totalBytes;
      runs.set(blockId, {
        ...prev,
        status: 'done',
        report: outcome.report,
        elapsedMs: outcome.report.durationMs || elapsedMs,
        throughputBps: outcome.report.throughputBytesPerSec,
        overall: { done: total, total, percent: 100 },
        error: null,
        errorText: null,
        stage: null,
      });
    } else {
      runs.set(blockId, { ...prev, status: outcome.status, elapsedMs, error: outcome.error, errorText: outcome.errorText });
    }
    notify();
  },

  /** New flow run: clear every block's previous progress / result (images stay loaded). */
  resetRuns(): void {
    pending.clear();
    if (runs.size === 0) return;
    runs.clear();
    notify();
  },
};

export function useFlashRun(blockId: string): FlashRunState {
  return useSyncExternalStore(
    flashRuntime.subscribe,
    () => flashRuntime.getRun(blockId),
    () => flashRuntime.getRun(blockId),
  );
}

export function useFlashImage(blockId: string): FlashImageState {
  return useSyncExternalStore(
    flashRuntime.subscribe,
    () => flashRuntime.getImage(blockId),
    () => flashRuntime.getImage(blockId),
  );
}
