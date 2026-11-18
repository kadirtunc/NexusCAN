import { useSyncExternalStore } from 'react';
import type { BusHealthDto } from '../types/hal';
import type {
  ChronologicalFrameDto,
  FrameTelemetryDto,
  TelemetrySnapshotDto,
  TraceReplayStatusDto,
} from '../types/telemetry';
import { plotStore } from './plotStore';
import { buildFrameInstanceKey } from '../utils/muxFormat';

export const MIN_CHRONO_BUFFER_ROWS = 100;
export const DEFAULT_CHRONO_BUFFER_ROWS = 10_000;
export const MAX_CHRONO_BUFFER_ROWS = 100_000;

const SIGNAL_CHANGE_HIGHLIGHT_MS = 300;

/**
 * Fixed-index O(1) circular ring buffer supporting up to 100,000 chronological frames
 * with zero per-tick array copying or GC churn at 60Hz!
 */
export class ChronoRingBuffer {
  private buf: (ChronologicalFrameDto | undefined)[];
  private cap: number;
  private head = 0;
  private len = 0;
  private evicted = 0;

  constructor(capacity: number) {
    this.cap = Math.max(
      MIN_CHRONO_BUFFER_ROWS,
      Math.min(MAX_CHRONO_BUFFER_ROWS, Math.floor(capacity)),
    );
    this.buf = new Array<ChronologicalFrameDto | undefined>(this.cap);
  }

  get capacity(): number {
    return this.cap;
  }

  get length(): number {
    return this.len;
  }

  /** Monotonic sequence ID of logical index 0 (`frameUid = baseSeq + logicalIndex`). */
  get baseSeq(): number {
    return this.evicted;
  }

  push(item: ChronologicalFrameDto): void {
    if (this.len < this.cap) {
      const idx = (this.head + this.len) % this.cap;
      this.buf[idx] = item;
      this.len += 1;
    } else {
      this.buf[this.head] = item;
      this.head = (this.head + 1) % this.cap;
      this.evicted += 1;
    }
  }

  getAt(logicalIndex: number): ChronologicalFrameDto | undefined {
    if (logicalIndex < 0 || logicalIndex >= this.len) {
      return undefined;
    }
    return this.buf[(this.head + logicalIndex) % this.cap];
  }

  clear(): void {
    this.buf = new Array<ChronologicalFrameDto | undefined>(this.cap);
    this.head = 0;
    this.len = 0;
    this.evicted = 0;
  }

  resize(nextCapacity: number): void {
    const clamped = Math.max(
      MIN_CHRONO_BUFFER_ROWS,
      Math.min(MAX_CHRONO_BUFFER_ROWS, Math.floor(nextCapacity)),
    );
    if (clamped === this.cap) return;

    const keepCount = Math.min(this.len, clamped);
    const startOffset = this.len - keepCount;
    const nextBuf = new Array<ChronologicalFrameDto | undefined>(clamped);
    for (let i = 0; i < keepCount; i++) {
      nextBuf[i] = this.getAt(startOffset + i);
    }
    this.buf = nextBuf;
    this.cap = clamped;
    this.head = 0;
    this.len = keepCount;
    this.evicted += startOffset;
  }

  cloneSnapshot(): ChronoRingBuffer {
    const copy = new ChronoRingBuffer(this.cap);
    for (let i = 0; i < this.len; i++) {
      const item = this.getAt(i);
      if (item !== undefined) {
        copy.push(item);
      }
    }
    copy.evicted = this.evicted;
    return copy;
  }
}

export const DEFAULT_REPLAY_STATUS: TraceReplayStatusDto = {
  state: 'idle',
  sourceName: '',
  currentIndex: 0,
  totalFrames: 0,
  elapsedUs: 0,
  durationUs: 0,
  speedFactor: 1,
  loopPlayback: false,
  busOverride: null,
  transmitToHardware: false,
  filterMode: 'all',
  filterKeys: [],
  directionFilter: 'all',
  dispatchedFrames: 0,
  filteredOutFrames: 0,
  hwTxFrames: 0,
};

export interface TelemetryHeaderSlice {
  seq: number;
  timestampUs: number;
  fpsRx: number;
  fpsTx: number;
  estimatedBusLoadPct: number;
  totalFramesRx: number;
  totalFramesTx: number;
  totalFramesErr: number;
  droppedFrames: number;
  activeIdsCount: number;
  decodedSignalsCount: number;
  txPanicLatched: boolean;
  buses: readonly BusHealthDto[];
  transportConnected: boolean;
  replay: TraceReplayStatusDto;
}

export interface TelemetryFramesSlice {
  seq: number;
  timestampUs: number;
  frames: readonly FrameTelemetryDto[];
  framesByKey: ReadonlyMap<string, FrameTelemetryDto>;
  recentlyChangedSignals: ReadonlySet<string>;
}

export interface TelemetryChronoSlice {
  version: number;
  ring: ChronoRingBuffer;
  count: number;
  maxBufferRows: number;
  paused: boolean;
  totalCaptured: number;
  originTimestampUs: number;
}

let headerSlice: TelemetryHeaderSlice = {
  seq: 0,
  timestampUs: 0,
  fpsRx: 0,
  fpsTx: 0,
  estimatedBusLoadPct: 0,
  totalFramesRx: 0,
  totalFramesTx: 0,
  totalFramesErr: 0,
  droppedFrames: 0,
  activeIdsCount: 0,
  decodedSignalsCount: 0,
  txPanicLatched: false,
  buses: [],
  transportConnected: false,
  replay: DEFAULT_REPLAY_STATUS,
};

let framesSlice: TelemetryFramesSlice = {
  seq: 0,
  timestampUs: 0,
  frames: [],
  framesByKey: new Map<string, FrameTelemetryDto>(),
  recentlyChangedSignals: new Set<string>(),
};

const liveChronoRing = new ChronoRingBuffer(DEFAULT_CHRONO_BUFFER_ROWS);
let pausedChronoRing: ChronoRingBuffer | null = null;
let chronoVersion = 0;
let lastSeenChronoMaxTs = -1;
let lastProcessedChronoSeq = -1;
let totalChronoCaptured = 0;
let chronoOriginTimestampUs = 0;

let chronoSlice: TelemetryChronoSlice = {
  version: 0,
  ring: liveChronoRing,
  count: 0,
  maxBufferRows: DEFAULT_CHRONO_BUFFER_ROWS,
  paused: false,
  totalCaptured: 0,
  originTimestampUs: 0,
};

// Lightweight O(1) tracker for 300ms Industrial CAN signal value green highlights
const prevSignalRawMap = new Map<string, number>();
const signalChangedUntilMs = new Map<string, number>();

const headerListeners = new Set<() => void>();
const framesListeners = new Set<() => void>();
const chronoListeners = new Set<() => void>();
const rawSnapshotListeners = new Set<(snap: TelemetrySnapshotDto) => void>();
let latestRawSnapshot: TelemetrySnapshotDto | null = null;

function notifySet(set: Set<() => void>): void {
  for (const fn of set) {
    fn();
  }
}

export const telemetryStore = {
  subscribeHeader(listener: () => void): () => void {
    headerListeners.add(listener);
    return () => {
      headerListeners.delete(listener);
    };
  },

  getHeaderSlice(): TelemetryHeaderSlice {
    return headerSlice;
  },

  subscribeFrames(listener: () => void): () => void {
    framesListeners.add(listener);
    return () => {
      framesListeners.delete(listener);
    };
  },

  getFramesSlice(): TelemetryFramesSlice {
    return framesSlice;
  },

  subscribeChrono(listener: () => void): () => void {
    chronoListeners.add(listener);
    return () => {
      chronoListeners.delete(listener);
    };
  },

  getChronoSlice(): TelemetryChronoSlice {
    return chronoSlice;
  },

  subscribeRawSnapshots(listener: (snap: TelemetrySnapshotDto) => void): () => void {
    rawSnapshotListeners.add(listener);
    return () => {
      rawSnapshotListeners.delete(listener);
    };
  },

  getLatestRawSnapshot(): TelemetrySnapshotDto | null {
    return latestRawSnapshot;
  },

  setTransportStatus(connected: boolean): void {
    if (headerSlice.transportConnected === connected) return;
    headerSlice = {
      ...headerSlice,
      transportConnected: connected,
    };
    notifySet(headerListeners);
  },

  upsertBusHealth(bus: BusHealthDto): void {
    const existingIdx = headerSlice.buses.findIndex((b) => b.busId === bus.busId);
    let nextBuses: BusHealthDto[];
    if (existingIdx >= 0) {
      nextBuses = headerSlice.buses.map((b, idx) => (idx === existingIdx ? bus : b));
    } else {
      nextBuses = [...headerSlice.buses, bus];
    }
    headerSlice = {
      ...headerSlice,
      buses: nextBuses,
    };
    notifySet(headerListeners);
  },

  removeBusHealth(busId: number): void {
    headerSlice = {
      ...headerSlice,
      buses: headerSlice.buses.filter((b) => b.busId !== busId),
    };
    notifySet(headerListeners);
  },

  clearAllBuses(): void {
    headerSlice = {
      ...headerSlice,
      buses: [],
    };
    notifySet(headerListeners);
  },

  markPanicLatched(): void {
    headerSlice = {
      ...headerSlice,
      txPanicLatched: true,
      buses: headerSlice.buses.map((b) => ({ ...b, txArmed: false })),
    };
    notifySet(headerListeners);
  },

  /** Optimistic local update after `cmd_clear_panic_latch`; the next snapshot confirms it. */
  markPanicCleared(): void {
    headerSlice = { ...headerSlice, txPanicLatched: false };
    notifySet(headerListeners);
  },

  setMaxChronoBufferRows(limit: number): void {
    const clamped = Math.max(
      MIN_CHRONO_BUFFER_ROWS,
      Math.min(MAX_CHRONO_BUFFER_ROWS, Math.floor(limit || DEFAULT_CHRONO_BUFFER_ROWS)),
    );
    liveChronoRing.resize(clamped);
    if (pausedChronoRing) {
      pausedChronoRing.resize(clamped);
    }
    const activeRing = chronoSlice.paused && pausedChronoRing ? pausedChronoRing : liveChronoRing;
    chronoVersion += 1;
    chronoSlice = {
      ...chronoSlice,
      version: chronoVersion,
      ring: activeRing,
      count: activeRing.length,
      maxBufferRows: clamped,
    };
    notifySet(chronoListeners);
  },

  setChronoPaused(paused: boolean): void {
    if (chronoSlice.paused === paused) return;
    if (paused) {
      pausedChronoRing = liveChronoRing.cloneSnapshot();
    } else {
      pausedChronoRing = null;
    }
    const activeRing = paused && pausedChronoRing ? pausedChronoRing : liveChronoRing;
    chronoVersion += 1;
    chronoSlice = {
      version: chronoVersion,
      ring: activeRing,
      count: activeRing.length,
      maxBufferRows: liveChronoRing.capacity,
      paused,
      totalCaptured: totalChronoCaptured,
      originTimestampUs: chronoOriginTimestampUs,
    };
    notifySet(chronoListeners);
  },

  clearChrono(): void {
    liveChronoRing.clear();
    if (pausedChronoRing) {
      pausedChronoRing.clear();
    }
    totalChronoCaptured = 0;
    chronoOriginTimestampUs = 0;
    lastSeenChronoMaxTs = -1;
    lastProcessedChronoSeq = -1;
    const activeRing = chronoSlice.paused && pausedChronoRing ? pausedChronoRing : liveChronoRing;
    chronoVersion += 1;
    chronoSlice = {
      version: chronoVersion,
      ring: activeRing,
      count: 0,
      maxBufferRows: liveChronoRing.capacity,
      paused: chronoSlice.paused,
      totalCaptured: 0,
      originTimestampUs: 0,
    };
    notifySet(chronoListeners);
  },

  clearAllTelemetry(): void {
    latestRawSnapshot = null;
    prevSignalRawMap.clear();
    signalChangedUntilMs.clear();

    framesSlice = {
      seq: 0,
      timestampUs: 0,
      frames: [],
      framesByKey: new Map<string, FrameTelemetryDto>(),
      recentlyChangedSignals: new Set<string>(),
    };
    notifySet(framesListeners);

    headerSlice = {
      ...headerSlice,
      fpsRx: 0,
      fpsTx: 0,
      estimatedBusLoadPct: 0,
      totalFramesRx: 0,
      totalFramesTx: 0,
      totalFramesErr: 0,
      droppedFrames: 0,
      activeIdsCount: 0,
      decodedSignalsCount: 0,
    };
    notifySet(headerListeners);

    telemetryStore.clearChrono();
  },

  ingestSnapshot(snap: TelemetrySnapshotDto): void {
    const nowMs = performance.now();

    // 1. Header KPI Slice
    headerSlice = {
      seq: snap.seq,
      timestampUs: snap.timestampUs,
      fpsRx: snap.fpsRx,
      fpsTx: snap.fpsTx,
      estimatedBusLoadPct: snap.estimatedBusLoadPct,
      totalFramesRx: snap.totalFramesRx,
      totalFramesTx: snap.totalFramesTx,
      totalFramesErr: snap.totalFramesErr ?? headerSlice.totalFramesErr,
      droppedFrames: snap.droppedFrames,
      activeIdsCount: snap.activeIdsCount,
      decodedSignalsCount: snap.decodedSignalsCount,
      txPanicLatched: snap.txPanicLatched,
      buses: snap.buses,
      transportConnected: true,
      replay: snap.replay
        ? {
            ...DEFAULT_REPLAY_STATUS,
            ...snap.replay,
            filterMode: snap.replay.filterMode ?? 'all',
            filterKeys: snap.replay.filterKeys ?? [],
            directionFilter: snap.replay.directionFilter ?? 'all',
            dispatchedFrames: snap.replay.dispatchedFrames ?? snap.replay.currentIndex ?? 0,
            filteredOutFrames: snap.replay.filteredOutFrames ?? 0,
            hwTxFrames: snap.replay.hwTxFrames ?? 0,
          }
        : DEFAULT_REPLAY_STATUS,
    };
    notifySet(headerListeners);

    // 2. Overwrite Frames Slice + 300ms Signal Change Tracker
    const framesByKey = new Map<string, FrameTelemetryDto>();
    const recentlyChangedSignals = new Set<string>();
    const newestSignalTsMap = new Map<string, number>();

    for (let i = 0; i < snap.frames.length; i++) {
      const frame = snap.frames[i];
      const instanceKey = buildFrameInstanceKey(frame);
      framesByKey.set(instanceKey, frame);

      // For message-level fallback keys (`${frame.busId}:${frame.messageKey}` and `frame.messageKey`,
      // used by `BitLayoutMatrix`), only overwrite if no entry exists yet OR `frame.lastTimestampUs >= existing.lastTimestampUs`
      const busMsgKey = `${frame.busId}:${frame.messageKey}`;
      const existingBusMsg = framesByKey.get(busMsgKey);
      if (!existingBusMsg || frame.lastTimestampUs >= existingBusMsg.lastTimestampUs) {
        framesByKey.set(busMsgKey, frame);
      }
      const existingMsg = framesByKey.get(frame.messageKey);
      if (!existingMsg || frame.lastTimestampUs >= existingMsg.lastTimestampUs) {
        framesByKey.set(frame.messageKey, frame);
      }

      const sigs = frame.signals;
      for (let j = 0; j < sigs.length; j++) {
        const sig = sigs[j];
        // Keyed by instanceKey:signalId to prevent cross-mux branch false flashing
        const instSigKey = `${instanceKey}:${sig.signalId}`;
        const prevRaw = prevSignalRawMap.get(instSigKey);
        if (prevRaw !== undefined && prevRaw !== sig.rawInt) {
          signalChangedUntilMs.set(instSigKey, nowMs + SIGNAL_CHANGE_HIGHLIGHT_MS);
        }
        prevSignalRawMap.set(instSigKey, sig.rawInt);

        const until = signalChangedUntilMs.get(instSigKey);
        if (until !== undefined && nowMs <= until) {
          recentlyChangedSignals.add(instSigKey);
        }

        // Also keep busId:signalId updated ONLY from newest lastTimestampUs frame
        const busSigKey = `${frame.busId}:${sig.signalId}`;
        const prevTs = newestSignalTsMap.get(busSigKey);
        if (prevTs === undefined || frame.lastTimestampUs >= prevTs) {
          newestSignalTsMap.set(busSigKey, frame.lastTimestampUs);
          if (until !== undefined && nowMs <= until) {
            recentlyChangedSignals.add(busSigKey);
          } else if (prevTs !== undefined) {
            recentlyChangedSignals.delete(busSigKey);
          }
        }
      }
    }

    framesSlice = {
      seq: snap.seq,
      timestampUs: snap.timestampUs,
      frames: snap.frames,
      framesByKey,
      recentlyChangedSignals,
    };
    notifySet(framesListeners);

    // 3. Zero-GC O(1) Plotter Time-Series Ring Ingestion
    plotStore.ingestFrameSignals(snap.timestampUs, snap.frames);

    // 4. O(1) Chronological Ring Buffer (Up to 100,000 Rows, Zero Array Copies!)
    const incoming = snap.recentChronological;
    if (incoming.length > 0 && snap.seq !== lastProcessedChronoSeq) {
      lastProcessedChronoSeq = snap.seq;
      if (chronoOriginTimestampUs === 0) {
        chronoOriginTimestampUs = incoming[0].timestampUs;
      }

      const batchLastTs = incoming[incoming.length - 1].timestampUs;
      if (
        batchLastTs < lastSeenChronoMaxTs &&
        incoming[0].timestampUs < lastSeenChronoMaxTs
      ) {
        lastSeenChronoMaxTs = -1;
        chronoOriginTimestampUs = incoming[0].timestampUs;
      }

      for (let i = 0; i < incoming.length; i++) {
        liveChronoRing.push(incoming[i]);
      }
      const appendedCount = incoming.length;
      lastSeenChronoMaxTs = batchLastTs;

      if (appendedCount > 0) {
        totalChronoCaptured += appendedCount;

        if (!chronoSlice.paused) {
          chronoVersion += 1;
          chronoSlice = {
            version: chronoVersion,
            ring: liveChronoRing,
            count: liveChronoRing.length,
            maxBufferRows: liveChronoRing.capacity,
            paused: false,
            totalCaptured: totalChronoCaptured,
            originTimestampUs: chronoOriginTimestampUs,
          };
          notifySet(chronoListeners);
        }
      }
    }

    // 5. Non-blocking fanout to Read-Only Cloud Bridge observers (never affects local 60Hz UI)
    latestRawSnapshot = snap;
    if (rawSnapshotListeners.size > 0) {
      for (const listener of rawSnapshotListeners) {
        try {
          listener(snap);
        } catch {
          // Isolate observer errors from local 60 FPS hot path
        }
      }
    }
  },
};

export function useTelemetryHeader(): TelemetryHeaderSlice {
  return useSyncExternalStore(
    telemetryStore.subscribeHeader,
    telemetryStore.getHeaderSlice,
    telemetryStore.getHeaderSlice,
  );
}

export function useTelemetryFrames(): TelemetryFramesSlice {
  return useSyncExternalStore(
    telemetryStore.subscribeFrames,
    telemetryStore.getFramesSlice,
    telemetryStore.getFramesSlice,
  );
}

export function useTelemetryChrono(): TelemetryChronoSlice {
  return useSyncExternalStore(
    telemetryStore.subscribeChrono,
    telemetryStore.getChronoSlice,
    telemetryStore.getChronoSlice,
  );
}
