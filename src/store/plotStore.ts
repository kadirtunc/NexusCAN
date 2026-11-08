import { useSyncExternalStore } from 'react';
import type { DatabaseSchemaDto, SignalSchemaDto } from '../types/netdb';
import type { FrameTelemetryDto } from '../types/telemetry';

/**
 * 18,000 samples = 300 seconds (5 minutes) of full 60Hz signal history per series
 * backed by pre-allocated `Float64Array` buffers (~288 KB/signal, zero GC pressure at 60 FPS!).
 */
export const PLOT_RING_CAPACITY = 18000;
export const PLOT_MIN_SPAN_SEC = 0.05; // 50 ms micro-zoom
export const PLOT_MAX_SPAN_SEC = 300; // 300 s (5 min) deep history
const MAX_ZOOM_HISTORY = 32;

export type PlotLayoutMode = 'combined' | 'split';
export type PlotYScaleMode = 'multiAxis' | 'normalized' | 'shared';
export type PlotTimeWindowPresetSec = 5 | 10 | 30 | 60 | 120 | 300;
export type PlotDragTool = 'pan' | 'boxZoom';
export type PlotSplitRowHeight = 140 | 200 | 280;

export const PLOT_TRACE_COLORS: readonly string[] = [
  '#3FB980', // Matte Emerald
  '#58A6FF', // Instrument Blue
  '#E3B341', // Warm Amber
  '#A371F7', // Soft Violet
  '#E56B77', // Muted Coral
  '#39C5BB', // Oscilloscope Teal
  '#79C0FF', // Ice Sky
  '#D29922', // Ochre Gold
  '#D66BA0', // Desaturated Rose
  '#87C846', // Matte Lime
  '#E08244', // Warm Copper
  '#4AC2D9', // Instrument Cyan
];

export interface PlotSeriesEntry {
  key: string; // `${busId}:${signalId}`
  busId: number;
  signalId: number;
  messageKey: string;
  signalName: string;
  unit: string;
  schemaMin: number;
  schemaMax: number;
  colorHex: string;
  visible: boolean;
  autoScale: boolean;
  customYMin: number;
  customYMax: number;
  // Sticky quantized 1-2-5 nice-grid Y bounds (monotonic during live streaming; zero breathing!):
  initializedAutoY: boolean;
  stickyAutoYMin: number;
  stickyAutoYMax: number;
  // Cached last auto-computed Y bounds so switching to manual Y-zoom/pan never jumps:
  lastAutoYMin: number;
  lastAutoYMax: number;
  // Pre-allocated ring buffer mutated in-place on 60Hz telemetry hot path:
  timestamps: Float64Array;
  values: Float64Array;
  writePos: number;
  count: number;
  latestValue: number | null;
  minObserved: number;
  maxObserved: number;
  sampleCount: number;
  pendingVal: number;
  pendingTsUs: number;
  hasPending: boolean;
}

export interface SavedPlotSignalSpec {
  busId: number;
  signalId: number;
  messageKey: string;
  signalName: string;
  unit: string;
  schemaMin: number;
  schemaMax: number;
  colorHex: string;
  visible: boolean;
  autoScale: boolean;
  customYMin: number;
  customYMax: number;
}

export interface PlotProjectState {
  watchedSignals: SavedPlotSignalSpec[];
  layoutMode: PlotLayoutMode;
  yScaleMode: PlotYScaleMode;
  timeWindowSec: number;
  splitRowHeight?: PlotSplitRowHeight;
}

export interface SeriesYAxisSnapshot {
  autoScale: boolean;
  customYMin: number;
  customYMax: number;
}

export interface PlotZoomSnapshot {
  viewSpanSec: number;
  liveFollow: boolean;
  viewRightTimeSec: number;
  combinedYAuto: boolean;
  combinedYMin: number;
  combinedYMax: number;
  seriesY: Readonly<Record<string, SeriesYAxisSnapshot>>;
}

/**
 * High-frequency mutable viewport read directly by 60 FPS `<canvas>` loops
 * without forcing top-level React tree reconciliations on every pointer pixel.
 */
export interface PlotViewportState {
  viewSpanSec: number;
  liveFollow: boolean;
  viewRightTimeSec: number;
  combinedYAuto: boolean;
  combinedYMin: number;
  combinedYMax: number;
  stickySharedInitialized: boolean;
  stickySharedYMin: number;
  stickySharedYMax: number;
  lastCombinedAutoYMin: number;
  lastCombinedAutoYMax: number;
  cursorATimeSec: number | null;
  cursorBTimeSec: number | null;
}

export interface PlotStoreState {
  series: readonly PlotSeriesEntry[];
  plottedKeys: ReadonlySet<string>;
  layoutMode: PlotLayoutMode;
  yScaleMode: PlotYScaleMode;
  viewSpanSec: number;
  liveFollow: boolean;
  combinedYAuto: boolean;
  dragTool: PlotDragTool;
  splitRowHeight: PlotSplitRowHeight;
  deltaCursorsEnabled: boolean;
  zoomHistoryDepth: number;
  paused: boolean;
  configRev: number;
}

export function clampPlotSpan(spanSec: number): number {
  if (!Number.isFinite(spanSec)) return 30;
  return Math.max(PLOT_MIN_SPAN_SEC, Math.min(PLOT_MAX_SPAN_SEC, spanSec));
}

export function makePlotSeriesKey(busId: number, signalId: number): string {
  return `${busId}:${signalId}`;
}

/**
 * Snaps any raw division step onto a clean oscilloscope `1 - 2 - 2.5 - 5 - 10 × 10^k` step.
 */
export function computeNiceStep(rawStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const exp = Math.floor(Math.log10(rawStep));
  const pow10 = Math.pow(10, exp);
  const frac = rawStep / pow10;
  let niceFrac = 10;
  if (frac <= 1) niceFrac = 1;
  else if (frac <= 2) niceFrac = 2;
  else if (frac <= 2.5) niceFrac = 2.5;
  else if (frac <= 5) niceFrac = 5;
  return Number((niceFrac * pow10).toPrecision(12));
}

function cleanFloat(val: number): number {
  if (!Number.isFinite(val)) return 0;
  if (Math.abs(val) < 1e-12) return 0;
  return Number(val.toPrecision(12));
}

/**
 * Quantizes `[rawMin, rawMax]` onto clean 4-division `1-2-5` oscilloscope graticule bounds.
 */
export function quantizeNiceAxisBounds(
  rawMin: number,
  rawMax: number,
  addHeadroom: boolean,
): { yMin: number; yMax: number } {
  if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) {
    return { yMin: -1, yMax: 1 };
  }
  let lo = Math.min(rawMin, rawMax);
  let hi = Math.max(rawMin, rawMax);

  // Digital boolean / 2-state flag [0..1]: center cleanly inside graticule so 0 and 1 aren't on borders
  if (!addHeadroom && lo >= 0 && hi > 0 && hi <= 1.0001) {
    return { yMin: -0.5, yMax: 1.5 };
  }

  const diff = hi - lo;
  if (diff < 1e-6) {
    if (lo >= 0 && lo <= 1.0001) {
      return { yMin: -0.5, yMax: 1.5 };
    }
    const pad = Math.max(1, Math.abs(lo) * 0.15);
    lo = lo >= 0 && lo - pad < 0 ? 0 : lo - pad;
    hi = hi + pad;
  } else if (addHeadroom) {
    const pad = diff * 0.18;
    const anchorZeroFloor = lo >= 0 && hi > 0 && lo <= hi * 0.25;
    lo = anchorZeroFloor ? 0 : lo - pad;
    hi = hi + pad;
  }

  const step = computeNiceStep(Math.max(1e-6, hi - lo) / 4);
  let niceMin = cleanFloat(Math.floor(lo / step + 1e-9) * step);
  let niceMax = cleanFloat(Math.ceil(hi / step - 1e-9) * step);
  if (niceMax - niceMin < step) {
    niceMax = cleanFloat(niceMin + step * 4);
  }
  return { yMin: niceMin, yMax: niceMax };
}

/** Either one schema for all buses (legacy) or a per-bus resolver (multi-DBC catalog). */
export type PlotSchemaSource =
  | DatabaseSchemaDto
  | null
  | ((busId: number) => DatabaseSchemaDto | null);

function resolvePlotSchema(src: PlotSchemaSource, busId: number): DatabaseSchemaDto | null {
  return typeof src === 'function' ? src(busId) : src;
}

function computeInitialStickyFromSchema(
  schemaMin: number,
  schemaMax: number,
): { initialized: boolean; yMin: number; yMax: number } {
  const span = schemaMax - schemaMin;
  // Use DBC physical [min, max] when calibrated (skip 0..0 or uncalibrated raw 16/32-bit >= 50000)
  if (Number.isFinite(span) && span > 0 && span < 50_000) {
    const q = quantizeNiceAxisBounds(schemaMin, schemaMax, false);
    return { initialized: true, yMin: q.yMin, yMax: q.yMax };
  }
  return { initialized: false, yMin: -1, yMax: 1 };
}

function createFreshSeriesEntry(spec: SavedPlotSignalSpec): PlotSeriesEntry {
  const stickyInit = computeInitialStickyFromSchema(spec.schemaMin, spec.schemaMax);
  const hasSchemaSpan = spec.schemaMax > spec.schemaMin;
  const initMin = Number.isFinite(spec.customYMin)
    ? spec.customYMin
    : stickyInit.initialized
      ? stickyInit.yMin
      : hasSchemaSpan
        ? spec.schemaMin
        : -10;
  const initMax = Number.isFinite(spec.customYMax)
    ? spec.customYMax
    : stickyInit.initialized
      ? stickyInit.yMax
      : hasSchemaSpan
        ? spec.schemaMax
        : 100;
  const safeMax = initMax > initMin ? initMax : initMin + 1;

  return {
    key: makePlotSeriesKey(spec.busId, spec.signalId),
    busId: spec.busId,
    signalId: spec.signalId,
    messageKey: spec.messageKey,
    signalName: spec.signalName,
    unit: spec.unit,
    schemaMin: spec.schemaMin,
    schemaMax: spec.schemaMax,
    colorHex: spec.colorHex,
    visible: spec.visible,
    autoScale: spec.autoScale,
    customYMin: initMin,
    customYMax: safeMax,
    initializedAutoY: stickyInit.initialized,
    stickyAutoYMin: stickyInit.initialized ? stickyInit.yMin : initMin,
    stickyAutoYMax: stickyInit.initialized ? stickyInit.yMax : safeMax,
    lastAutoYMin: stickyInit.initialized ? stickyInit.yMin : initMin,
    lastAutoYMax: stickyInit.initialized ? stickyInit.yMax : safeMax,
    timestamps: new Float64Array(PLOT_RING_CAPACITY),
    values: new Float64Array(PLOT_RING_CAPACITY),
    writePos: 0,
    count: 0,
    latestValue: null,
    minObserved: Number.POSITIVE_INFINITY,
    maxObserved: Number.NEGATIVE_INFINITY,
    sampleCount: 0,
    pendingVal: 0,
    pendingTsUs: -1,
    hasPending: false,
  };
}

const seriesMap = new Map<string, PlotSeriesEntry>();
let originTimestampUs = 0;
let lastIngestedTimestampUs = -1;
let latestTimeSec = 0;
let nextColorIdx = 0;
let lastWheelHistoryPushMs = 0;

const viewport: PlotViewportState = {
  viewSpanSec: 30,
  liveFollow: true,
  viewRightTimeSec: 30,
  combinedYAuto: true,
  combinedYMin: 0,
  combinedYMax: 100,
  stickySharedInitialized: false,
  stickySharedYMin: -1,
  stickySharedYMax: 1,
  lastCombinedAutoYMin: 0,
  lastCombinedAutoYMax: 100,
  cursorATimeSec: null,
  cursorBTimeSec: null,
};

let zoomHistory: PlotZoomSnapshot[] = [];

let currentState: PlotStoreState = {
  series: [],
  plottedKeys: new Set<string>(),
  layoutMode: 'combined',
  yScaleMode: 'multiAxis',
  viewSpanSec: 30,
  liveFollow: true,
  combinedYAuto: true,
  dragTool: 'pan',
  splitRowHeight: 200,
  deltaCursorsEnabled: false,
  zoomHistoryDepth: 0,
  paused: false,
  configRev: 0,
};

const listeners = new Set<() => void>();

function recomputeStickySharedBounds(): void {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const entry of seriesMap.values()) {
    if (!entry.visible) continue;
    if (entry.stickyAutoYMin < lo) lo = entry.stickyAutoYMin;
    if (entry.stickyAutoYMax > hi) hi = entry.stickyAutoYMax;
  }
  if (Number.isFinite(lo) && Number.isFinite(hi)) {
    const q = quantizeNiceAxisBounds(lo, hi, false);
    viewport.stickySharedInitialized = true;
    viewport.stickySharedYMin = q.yMin;
    viewport.stickySharedYMax = q.yMax;
  } else {
    viewport.stickySharedInitialized = false;
    viewport.stickySharedYMin = -1;
    viewport.stickySharedYMax = 1;
  }
}

function fitEntryStickyYToWindow(
  entry: PlotSeriesEntry,
  tMin: number,
  tMax: number,
): void {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  const count = entry.count;
  const startPos = (entry.writePos - count + PLOT_RING_CAPACITY) % PLOT_RING_CAPACITY;

  for (let i = 0; i < count; i++) {
    const idx = (startPos + i) % PLOT_RING_CAPACITY;
    const t = entry.timestamps[idx];
    if (t < tMin || t > tMax) continue;
    const v = entry.values[idx];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }

  // Fallback to full observed range if current window has no samples yet
  if ((!Number.isFinite(lo) || !Number.isFinite(hi)) && Number.isFinite(entry.minObserved)) {
    lo = entry.minObserved;
    hi = entry.maxObserved;
  }

  if (Number.isFinite(lo) && Number.isFinite(hi)) {
    const q = quantizeNiceAxisBounds(lo, hi, true);
    entry.initializedAutoY = true;
    entry.stickyAutoYMin = q.yMin;
    entry.stickyAutoYMax = q.yMax;
    entry.lastAutoYMin = q.yMin;
    entry.lastAutoYMax = q.yMax;
    return;
  }

  const stickyInit = computeInitialStickyFromSchema(entry.schemaMin, entry.schemaMax);
  entry.initializedAutoY = stickyInit.initialized;
  entry.stickyAutoYMin = stickyInit.yMin;
  entry.stickyAutoYMax = stickyInit.yMax;
  entry.lastAutoYMin = stickyInit.yMin;
  entry.lastAutoYMax = stickyInit.yMax;
}

function syncSnapshotAndEmit(rebuildSeriesList = false): void {
  if (rebuildSeriesList) {
    recomputeStickySharedBounds();
  }
  const list = rebuildSeriesList ? Array.from(seriesMap.values()) : currentState.series;
  const keys = rebuildSeriesList ? new Set<string>(seriesMap.keys()) : currentState.plottedKeys;
  currentState = {
    ...currentState,
    series: list,
    plottedKeys: keys,
    viewSpanSec: viewport.viewSpanSec,
    liveFollow: viewport.liveFollow,
    combinedYAuto: viewport.combinedYAuto,
    zoomHistoryDepth: zoomHistory.length,
    configRev: currentState.configRev + 1,
  };
  for (const fn of listeners) {
    fn();
  }
}

function resetRingDataInPlace(entry: PlotSeriesEntry): void {
  entry.writePos = 0;
  entry.count = 0;
  entry.latestValue = null;
  entry.minObserved = Number.POSITIVE_INFINITY;
  entry.maxObserved = Number.NEGATIVE_INFINITY;
  entry.sampleCount = 0;
  const stickyInit = computeInitialStickyFromSchema(entry.schemaMin, entry.schemaMax);
  entry.initializedAutoY = stickyInit.initialized;
  entry.stickyAutoYMin = stickyInit.yMin;
  entry.stickyAutoYMax = stickyInit.yMax;
  entry.lastAutoYMin = stickyInit.yMin;
  entry.lastAutoYMax = stickyInit.yMax;
}

function captureZoomSnapshot(): PlotZoomSnapshot {
  const seriesY: Record<string, SeriesYAxisSnapshot> = {};
  for (const [k, entry] of seriesMap.entries()) {
    seriesY[k] = {
      autoScale: entry.autoScale,
      customYMin: entry.customYMin,
      customYMax: entry.customYMax,
    };
  }
  const effectiveRight = viewport.liveFollow
    ? Math.max(viewport.viewSpanSec, latestTimeSec)
    : viewport.viewRightTimeSec;

  return {
    viewSpanSec: viewport.viewSpanSec,
    liveFollow: viewport.liveFollow,
    viewRightTimeSec: effectiveRight,
    combinedYAuto: viewport.combinedYAuto,
    combinedYMin: viewport.combinedYMin,
    combinedYMax: viewport.combinedYMax,
    seriesY,
  };
}

function pushZoomSnapshotInternal(debounceWheel = false): void {
  const now = performance.now();
  if (debounceWheel && now - lastWheelHistoryPushMs < 480) {
    lastWheelHistoryPushMs = now;
    return;
  }
  if (debounceWheel) {
    lastWheelHistoryPushMs = now;
  }
  zoomHistory.push(captureZoomSnapshot());
  if (zoomHistory.length > MAX_ZOOM_HISTORY) {
    zoomHistory = zoomHistory.slice(zoomHistory.length - MAX_ZOOM_HISTORY);
  }
}

export const plotStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getState(): PlotStoreState {
    return currentState;
  },

  getViewport(): Readonly<PlotViewportState> {
    return viewport;
  },

  getLatestTimeSec(): number {
    return latestTimeSec;
  },

  /**
   * Computes the current active `[tStart, tEnd]` time window in seconds.
   */
  getEffectiveTimeWindow(): { tStart: number; tEnd: number; span: number } {
    const span = viewport.viewSpanSec;
    const tEnd = viewport.liveFollow
      ? Math.max(span, latestTimeSec)
      : viewport.viewRightTimeSec;
    return {
      tStart: tEnd - span,
      tEnd,
      span,
    };
  },

  /**
   * Returns `[minTimeSec, maxTimeSec]` across all `18,000`-sample ring buffers (up to 300s history).
   */
  getTimeBounds(): { minTimeSec: number; maxTimeSec: number } {
    let minT = Number.POSITIVE_INFINITY;
    let maxT = latestTimeSec;

    for (const entry of seriesMap.values()) {
      if (entry.count === 0) continue;
      const oldestIdx =
        (entry.writePos - entry.count + PLOT_RING_CAPACITY) % PLOT_RING_CAPACITY;
      const newestIdx = (entry.writePos - 1 + PLOT_RING_CAPACITY) % PLOT_RING_CAPACITY;
      const tOld = entry.timestamps[oldestIdx];
      const tNew = entry.timestamps[newestIdx];
      if (tOld < minT) minT = tOld;
      if (tNew > maxT) maxT = tNew;
    }

    if (!Number.isFinite(minT)) {
      minT = 0;
    }
    if (maxT < minT) {
      maxT = minT;
    }
    return { minTimeSec: minT, maxTimeSec: maxT };
  },

  isSignalPlotted(busId: number, signalId: number): boolean {
    return seriesMap.has(makePlotSeriesKey(busId, signalId));
  },

  /**
   * Zero-allocation O(1) 60Hz hot-path writer called from `telemetryStore.ingestSnapshot`.
   * Writes directly into pre-allocated `Float64Array(18000)` ring buffers even while
   * `liveFollow === false` (history pan/inspection mode) so zero samples are lost!
   */
  ingestFrameSignals(timestampUs: number, frames: readonly FrameTelemetryDto[]): void {
    if (currentState.paused || seriesMap.size === 0) {
      return;
    }

    if (
      originTimestampUs === 0 ||
      (lastIngestedTimestampUs > 0 && timestampUs < lastIngestedTimestampUs - 1_000_000)
    ) {
      originTimestampUs = timestampUs;
      latestTimeSec = 0;
      viewport.liveFollow = true;
      viewport.viewRightTimeSec = viewport.viewSpanSec;
      for (const entry of seriesMap.values()) {
        resetRingDataInPlace(entry);
      }
      recomputeStickySharedBounds();
    }
    lastIngestedTimestampUs = timestampUs;

    const tSec = Math.max(0, (timestampUs - originTimestampUs) / 1_000_000);
    latestTimeSec = tSec;

    let sharedDirty = false;

    if (seriesMap.size === 0) return;

    // Scan frames and aggregate best sample per watched signal (largest lastTimestampUs)
    // Multiple mux rows (e.g. 0x105 m0.m0..m2) coexist in snap.frames; this ensures exactly 1 sample/tick!
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const sigs = f.signals;
      for (let j = 0; j < sigs.length; j++) {
        const s = sigs[j];
        const entry = seriesMap.get(`${f.busId}:${s.signalId}`);
        if (!entry) continue;

        const val = s.physicalValue;
        if (!Number.isFinite(val)) continue;

        if (!entry.hasPending || f.lastTimestampUs > entry.pendingTsUs) {
          entry.hasPending = true;
          entry.pendingTsUs = f.lastTimestampUs;
          entry.pendingVal = val;
        }
      }
    }

    // Now push exactly ONE authoritative sample per watched series entry per tick!
    for (const entry of seriesMap.values()) {
      if (!entry.hasPending) continue;
      entry.hasPending = false;
      const val = entry.pendingVal;

      const wp = entry.writePos;
      entry.timestamps[wp] = tSec;
      entry.values[wp] = val;
      entry.writePos = (wp + 1) % PLOT_RING_CAPACITY;
      if (entry.count < PLOT_RING_CAPACITY) {
        entry.count += 1;
      }
      entry.latestValue = val;
      if (val < entry.minObserved) entry.minObserved = val;
      if (val > entry.maxObserved) entry.maxObserved = val;
      entry.sampleCount += 1;

      if (!entry.initializedAutoY) {
        const q = quantizeNiceAxisBounds(val, val, true);
        entry.initializedAutoY = true;
        entry.stickyAutoYMin = q.yMin;
        entry.stickyAutoYMax = q.yMax;
        entry.lastAutoYMin = q.yMin;
        entry.lastAutoYMax = q.yMax;
        if (entry.visible) {
          sharedDirty = true;
        }
      } else if (val < entry.stickyAutoYMin || val > entry.stickyAutoYMax) {
        const curSpan = Math.max(1e-6, entry.stickyAutoYMax - entry.stickyAutoYMin);
        const targetMin =
          val < entry.stickyAutoYMin ? val - curSpan * 0.25 : entry.stickyAutoYMin;
        const targetMax =
          val > entry.stickyAutoYMax ? val + curSpan * 0.25 : entry.stickyAutoYMax;
        const q = quantizeNiceAxisBounds(targetMin, targetMax, false);
        entry.stickyAutoYMin = Math.min(entry.stickyAutoYMin, q.yMin);
        entry.stickyAutoYMax = Math.max(entry.stickyAutoYMax, q.yMax);
        entry.lastAutoYMin = entry.stickyAutoYMin;
        entry.lastAutoYMax = entry.stickyAutoYMax;
        if (entry.visible) {
          sharedDirty = true;
        }
      }
    }

    if (sharedDirty) {
      if (!viewport.stickySharedInitialized) {
        recomputeStickySharedBounds();
      } else {
        let nextLo = viewport.stickySharedYMin;
        let nextHi = viewport.stickySharedYMax;
        for (const entry of seriesMap.values()) {
          if (!entry.visible) continue;
          if (entry.stickyAutoYMin < nextLo) nextLo = entry.stickyAutoYMin;
          if (entry.stickyAutoYMax > nextHi) nextHi = entry.stickyAutoYMax;
        }
        if (nextLo < viewport.stickySharedYMin || nextHi > viewport.stickySharedYMax) {
          const q = quantizeNiceAxisBounds(nextLo, nextHi, false);
          viewport.stickySharedYMin = Math.min(viewport.stickySharedYMin, q.yMin);
          viewport.stickySharedYMax = Math.max(viewport.stickySharedYMax, q.yMax);
        }
      }
    }
  },

  // ==========================================================================
  // Series Management
  // ==========================================================================

  addSignal(busId: number, sig: SignalSchemaDto, preferredColor?: string): void {
    const key = makePlotSeriesKey(busId, sig.signalId);
    if (seriesMap.has(key)) return;

    const color =
      preferredColor ?? PLOT_TRACE_COLORS[nextColorIdx % PLOT_TRACE_COLORS.length];
    nextColorIdx += 1;

    const hasSpan = sig.max > sig.min;
    const entry = createFreshSeriesEntry({
      busId,
      signalId: sig.signalId,
      messageKey: sig.messageKey,
      signalName: sig.name,
      unit: sig.unit,
      schemaMin: sig.min,
      schemaMax: sig.max,
      colorHex: color,
      visible: true,
      autoScale: true,
      customYMin: hasSpan ? sig.min : -10,
      customYMax: hasSpan ? sig.max : 100,
    });
    seriesMap.set(key, entry);
    syncSnapshotAndEmit(true);
  },

  removeSeries(key: string): void {
    if (!seriesMap.delete(key)) return;
    syncSnapshotAndEmit(true);
  },

  toggleSignal(busId: number, sig: SignalSchemaDto): boolean {
    const key = makePlotSeriesKey(busId, sig.signalId);
    if (seriesMap.has(key)) {
      seriesMap.delete(key);
      syncSnapshotAndEmit(true);
      return false;
    }
    plotStore.addSignal(busId, sig);
    return true;
  },

  /**
   * Batch add/remove all signals of a CAN message in a single atomic store update.
   */
  setSignalsPlottedBatch(
    busId: number,
    signals: readonly SignalSchemaDto[],
    plotted: boolean,
  ): void {
    let changed = false;
    for (const sig of signals) {
      const key = makePlotSeriesKey(busId, sig.signalId);
      if (plotted) {
        if (!seriesMap.has(key)) {
          const color = PLOT_TRACE_COLORS[nextColorIdx % PLOT_TRACE_COLORS.length];
          nextColorIdx += 1;
          const hasSpan = sig.max > sig.min;
          const entry = createFreshSeriesEntry({
            busId,
            signalId: sig.signalId,
            messageKey: sig.messageKey,
            signalName: sig.name,
            unit: sig.unit,
            schemaMin: sig.min,
            schemaMax: sig.max,
            colorHex: color,
            visible: true,
            autoScale: true,
            customYMin: hasSpan ? sig.min : -10,
            customYMax: hasSpan ? sig.max : 100,
          });
          seriesMap.set(key, entry);
          changed = true;
        }
      } else if (seriesMap.delete(key)) {
        changed = true;
      }
    }
    if (changed) {
      syncSnapshotAndEmit(true);
    }
  },

  setSeriesVisible(key: string, visible: boolean): void {
    const entry = seriesMap.get(key);
    if (!entry || entry.visible === visible) return;
    entry.visible = visible;
    syncSnapshotAndEmit(true);
  },

  setSeriesColor(key: string, colorHex: string): void {
    const entry = seriesMap.get(key);
    if (!entry || entry.colorHex === colorHex) return;
    entry.colorHex = colorHex;
    syncSnapshotAndEmit(true);
  },

  // ==========================================================================
  // Oscilloscope Zoom, Pan, Box-Zoom, Axis Drag & History Stack
  // ==========================================================================

  recordLastCombinedAutoY(yMin: number, yMax: number): void {
    viewport.lastCombinedAutoYMin = yMin;
    viewport.lastCombinedAutoYMax = yMax;
  },

  pushZoomHistory(): void {
    pushZoomSnapshotInternal(false);
    syncSnapshotAndEmit(false);
  },

  popZoomHistory(): boolean {
    const snap = zoomHistory.pop();
    if (!snap) return false;

    viewport.viewSpanSec = clampPlotSpan(snap.viewSpanSec);
    viewport.liveFollow = snap.liveFollow;
    viewport.viewRightTimeSec = snap.viewRightTimeSec;
    viewport.combinedYAuto = snap.combinedYAuto;
    viewport.combinedYMin = snap.combinedYMin;
    viewport.combinedYMax = snap.combinedYMax;

    for (const [key, yState] of Object.entries(snap.seriesY)) {
      const entry = seriesMap.get(key);
      if (entry) {
        entry.autoScale = yState.autoScale;
        entry.customYMin = yState.customYMin;
        entry.customYMax = yState.customYMax;
      }
    }

    syncSnapshotAndEmit(false);
    return true;
  },

  /**
   * Cursor-anchored continuous X time zoom (`0.05s .. 300s`).
   * Keeps `anchorRatio` (`0..1` across plot width) pinned to the exact same timestamp!
   */
  zoomTimeAtRatio(
    factor: number,
    anchorRatio: number,
    fromWheel = false,
  ): void {
    pushZoomSnapshotInternal(fromWheel);

    const { tStart, span } = plotStore.getEffectiveTimeWindow();
    const clampedRatio = Math.max(0, Math.min(1, anchorRatio));
    const tAnchor = tStart + clampedRatio * span;
    const nextSpan = clampPlotSpan(span * factor);

    if (viewport.liveFollow && clampedRatio > 0.92) {
      viewport.viewSpanSec = nextSpan;
      viewport.viewRightTimeSec = Math.max(nextSpan, latestTimeSec);
    } else {
      const nextStart = tAnchor - clampedRatio * nextSpan;
      const nextEnd = nextStart + nextSpan;
      viewport.liveFollow = false;
      viewport.viewSpanSec = nextSpan;
      viewport.viewRightTimeSec = Math.max(nextSpan * 0.1, nextEnd);
    }

    syncSnapshotAndEmit(false);
  },

  /**
   * Sets an explicit `[tStart, tEnd]` time window (used by Box-Zoom & Minimap edge handles).
   */
  setTimeRange(
    tStart: number,
    tEnd: number,
    saveHistory = false,
    emit = true,
  ): void {
    if (saveHistory) {
      pushZoomSnapshotInternal(false);
    }
    const rawSpan = Math.abs(tEnd - tStart);
    const nextSpan = clampPlotSpan(rawSpan);
    const lo = Math.min(tStart, tEnd);
    viewport.viewSpanSec = nextSpan;
    viewport.liveFollow = false;
    viewport.viewRightTimeSec = lo + nextSpan;
    if (emit) {
      syncSnapshotAndEmit(false);
    }
  },

  /**
   * Pans time window by `deltaTimeSec` (positive = forward in time, negative = backward in history).
   * Automatically detaches `liveFollow` so incoming 60Hz frames don't shift the waveform under the cursor!
   */
  panTimeBy(deltaTimeSec: number, emit = true): void {
    const { tEnd } = plotStore.getEffectiveTimeWindow();
    const { minTimeSec, maxTimeSec } = plotStore.getTimeBounds();
    const span = viewport.viewSpanSec;

    const minAllowedRight = Math.min(minTimeSec + span * 0.15, span);
    const maxAllowedRight = Math.max(maxTimeSec + span * 0.25, span);
    const nextRight = Math.max(
      minAllowedRight,
      Math.min(maxAllowedRight, tEnd + deltaTimeSec),
    );

    const wasFollowing = viewport.liveFollow;
    viewport.liveFollow = false;
    viewport.viewRightTimeSec = nextRight;

    if (emit || wasFollowing) {
      syncSnapshotAndEmit(false);
    }
  },

  /**
   * Sets `viewRightTimeSec` directly during high-precision pointer drag pan.
   */
  setViewRightTimeSec(nextRightTimeSec: number, emit = false): void {
    const { minTimeSec, maxTimeSec } = plotStore.getTimeBounds();
    const span = viewport.viewSpanSec;
    const minAllowedRight = Math.min(minTimeSec + span * 0.1, span * 0.1);
    const maxAllowedRight = Math.max(maxTimeSec + span * 0.5, span);

    const wasFollowing = viewport.liveFollow;
    viewport.liveFollow = false;
    viewport.viewRightTimeSec = Math.max(
      minAllowedRight,
      Math.min(maxAllowedRight, nextRightTimeSec),
    );

    if (emit || wasFollowing) {
      syncSnapshotAndEmit(false);
    }
  },

  setPresetTimeSpan(spanSec: number): void {
    pushZoomSnapshotInternal(false);
    const nextSpan = clampPlotSpan(spanSec);
    if (!viewport.liveFollow) {
      const { tEnd } = plotStore.getEffectiveTimeWindow();
      viewport.viewRightTimeSec = Math.max(nextSpan, tEnd);
    }
    viewport.viewSpanSec = nextSpan;
    syncSnapshotAndEmit(false);
  },

  setLiveFollow(liveFollow: boolean): void {
    if (viewport.liveFollow === liveFollow) return;
    if (!liveFollow) {
      viewport.viewRightTimeSec = Math.max(viewport.viewSpanSec, latestTimeSec);
    }
    viewport.liveFollow = liveFollow;
    syncSnapshotAndEmit(false);
  },

  /**
   * Updates Y-axis manual range for either `'combined'` or a specific Split `seriesKey`.
   */
  setScopeManualY(
    targetKey: 'combined' | string,
    yMin: number,
    yMax: number,
    options?: { saveHistory?: boolean; fromWheel?: boolean; emit?: boolean },
  ): void {
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return;
    if (options?.saveHistory) {
      pushZoomSnapshotInternal(Boolean(options.fromWheel));
    }

    const lo = Math.min(yMin, yMax);
    const hi = Math.max(yMin, yMax);
    const safeSpan = Math.max(1e-6, Math.min(1e9, hi - lo));
    const finalMin = lo;
    const finalMax = lo + safeSpan;

    let flippedAuto = false;
    if (targetKey === 'combined') {
      flippedAuto = viewport.combinedYAuto;
      viewport.combinedYAuto = false;
      viewport.combinedYMin = finalMin;
      viewport.combinedYMax = finalMax;
    } else {
      const entry = seriesMap.get(targetKey);
      if (!entry) return;
      flippedAuto = entry.autoScale;
      entry.autoScale = false;
      entry.customYMin = finalMin;
      entry.customYMax = finalMax;
    }

    if ((options?.emit ?? true) || flippedAuto) {
      syncSnapshotAndEmit(false);
    }
  },

  resetScopeAutoY(targetKey: 'combined' | string): void {
    pushZoomSnapshotInternal(false);
    const { tStart, tEnd } = plotStore.getEffectiveTimeWindow();
    if (targetKey === 'combined') {
      viewport.combinedYAuto = true;
      for (const entry of seriesMap.values()) {
        if (entry.visible && entry.autoScale) {
          fitEntryStickyYToWindow(entry, tStart, tEnd);
        }
      }
      recomputeStickySharedBounds();
    } else {
      const entry = seriesMap.get(targetKey);
      if (entry) {
        entry.autoScale = true;
        fitEntryStickyYToWindow(entry, tStart, tEnd);
        recomputeStickySharedBounds();
      }
    }
    syncSnapshotAndEmit(false);
  },

  resetAllAutoScale(): void {
    pushZoomSnapshotInternal(false);
    const { tStart, tEnd } = plotStore.getEffectiveTimeWindow();
    viewport.combinedYAuto = true;
    for (const entry of seriesMap.values()) {
      entry.autoScale = true;
      fitEntryStickyYToWindow(entry, tStart, tEnd);
    }
    recomputeStickySharedBounds();
    syncSnapshotAndEmit(false);
  },

  /**
   * Full oscilloscope Fit / Reset (`R` key or Double-Click inside plot):
   * Restores Auto-Scale Y on all channels, fits tightly to visible data, and enables `Follow Live`.
   */
  resetFullView(): void {
    pushZoomSnapshotInternal(false);
    viewport.liveFollow = true;
    const { minTimeSec, maxTimeSec } = plotStore.getTimeBounds();
    const recordedSpan = maxTimeSec - minTimeSec;
    viewport.viewSpanSec =
      recordedSpan > 1 ? clampPlotSpan(Math.min(30, Math.max(5, recordedSpan))) : 30;
    viewport.viewRightTimeSec = Math.max(viewport.viewSpanSec, latestTimeSec);
    viewport.combinedYAuto = true;
    const { tStart, tEnd } = plotStore.getEffectiveTimeWindow();
    for (const entry of seriesMap.values()) {
      entry.autoScale = true;
      fitEntryStickyYToWindow(entry, tStart, tEnd);
    }
    recomputeStickySharedBounds();
    syncSnapshotAndEmit(false);
  },

  panVisibleYByFraction(fractionOfSpan: number): void {
    const usePerSeries =
      currentState.layoutMode === 'split' ||
      currentState.yScaleMode === 'multiAxis';
    if (!usePerSeries) {
      const baseMin = viewport.combinedYAuto
        ? viewport.lastCombinedAutoYMin
        : viewport.combinedYMin;
      const baseMax = viewport.combinedYAuto
        ? viewport.lastCombinedAutoYMax
        : viewport.combinedYMax;
      const delta = (baseMax - baseMin) * fractionOfSpan;
      plotStore.setScopeManualY('combined', baseMin + delta, baseMax + delta, {
        emit: true,
      });
    } else {
      for (const entry of seriesMap.values()) {
        if (!entry.visible) continue;
        const baseMin = entry.autoScale ? entry.lastAutoYMin : entry.customYMin;
        const baseMax = entry.autoScale ? entry.lastAutoYMax : entry.customYMax;
        const delta = (baseMax - baseMin) * fractionOfSpan;
        entry.autoScale = false;
        entry.customYMin = baseMin + delta;
        entry.customYMax = baseMax + delta;
      }
      syncSnapshotAndEmit(false);
    }
  },

  /**
   * Scales all visible series proportionally by normalized vertical range `[normLo, normHi]`
   * (`0` = bottom of plot, `1` = top of plot) for 2D Box-Zoom & `Shift+Wheel` in `multiAxis` mode!
   */
  applyProportionalYWindowToVisibleSeries(
    normLo: number,
    normHi: number,
    options?: { saveHistory?: boolean; fromWheel?: boolean; emit?: boolean },
  ): void {
    if (options?.saveHistory) {
      pushZoomSnapshotInternal(Boolean(options.fromWheel));
    }
    for (const entry of seriesMap.values()) {
      if (!entry.visible) continue;
      const baseMin = entry.autoScale ? entry.lastAutoYMin : entry.customYMin;
      const baseMax = entry.autoScale ? entry.lastAutoYMax : entry.customYMax;
      const span = Math.max(1e-6, baseMax - baseMin);
      const nextMin = baseMin + normLo * span;
      const nextMax = baseMin + normHi * span;
      const safeSpan = Math.max(1e-6, Math.min(1e9, nextMax - nextMin));
      entry.autoScale = false;
      entry.customYMin = nextMin;
      entry.customYMax = nextMin + safeSpan;
    }
    if (options?.emit ?? true) {
      syncSnapshotAndEmit(false);
    }
  },

  // ==========================================================================
  // Toolbar & Cursor Controls
  // ==========================================================================

  setDragTool(dragTool: PlotDragTool): void {
    if (currentState.dragTool === dragTool) return;
    currentState = { ...currentState, dragTool };
    syncSnapshotAndEmit(false);
  },

  setSplitRowHeight(splitRowHeight: PlotSplitRowHeight): void {
    if (currentState.splitRowHeight === splitRowHeight) return;
    currentState = { ...currentState, splitRowHeight };
    syncSnapshotAndEmit(false);
  },

  setDeltaCursorsEnabled(enabled: boolean): void {
    if (currentState.deltaCursorsEnabled === enabled) return;
    if (enabled) {
      const { tStart, tEnd, span } = plotStore.getEffectiveTimeWindow();
      const aInvalid =
        viewport.cursorATimeSec === null ||
        viewport.cursorATimeSec < tStart ||
        viewport.cursorATimeSec > tEnd;
      const bInvalid =
        viewport.cursorBTimeSec === null ||
        viewport.cursorBTimeSec < tStart ||
        viewport.cursorBTimeSec > tEnd;
      if (aInvalid || bInvalid) {
        viewport.cursorATimeSec = tStart + span * 0.3;
        viewport.cursorBTimeSec = tStart + span * 0.7;
      }
    }
    currentState = { ...currentState, deltaCursorsEnabled: enabled };
    syncSnapshotAndEmit(false);
  },

  setDeltaCursorTime(which: 'A' | 'B', timeSec: number, emit = false): void {
    if (which === 'A') {
      viewport.cursorATimeSec = timeSec;
    } else {
      viewport.cursorBTimeSec = timeSec;
    }
    if (emit) {
      syncSnapshotAndEmit(false);
    }
  },

  placeDeltaCursorsInCurrentWindow(): void {
    const { tStart, span } = plotStore.getEffectiveTimeWindow();
    viewport.cursorATimeSec = tStart + span * 0.3;
    viewport.cursorBTimeSec = tStart + span * 0.7;
    syncSnapshotAndEmit(false);
  },

  setLayoutMode(layoutMode: PlotLayoutMode): void {
    if (currentState.layoutMode === layoutMode) return;
    currentState = { ...currentState, layoutMode };
    syncSnapshotAndEmit(false);
  },

  setYScaleMode(yScaleMode: PlotYScaleMode): void {
    if (currentState.yScaleMode === yScaleMode) return;
    viewport.combinedYAuto = true;
    recomputeStickySharedBounds();
    currentState = { ...currentState, yScaleMode };
    syncSnapshotAndEmit(false);
  },

  setPaused(paused: boolean): void {
    if (currentState.paused === paused) return;
    currentState = { ...currentState, paused };
    syncSnapshotAndEmit(false);
  },

  notifyInteractionEnd(): void {
    syncSnapshotAndEmit(false);
  },

  clearBuffers(): void {
    originTimestampUs = 0;
    lastIngestedTimestampUs = -1;
    latestTimeSec = 0;
    zoomHistory = [];
    viewport.liveFollow = true;
    viewport.viewRightTimeSec = viewport.viewSpanSec;
    for (const entry of seriesMap.values()) {
      resetRingDataInPlace(entry);
    }
    recomputeStickySharedBounds();
    syncSnapshotAndEmit(false);
  },

  clearAllSeries(): void {
    seriesMap.clear();
    originTimestampUs = 0;
    lastIngestedTimestampUs = -1;
    latestTimeSec = 0;
    zoomHistory = [];
    viewport.liveFollow = true;
    viewport.combinedYAuto = true;
    syncSnapshotAndEmit(true);
  },

  /**
   * Re-binds watched signal `signalId`s by `(messageKey, signalName)` when a `.dbc`/`.kcd` schema reloads.
   */
  rebindWithSchema(schema: PlotSchemaSource): void {
    if (!schema || seriesMap.size === 0) return;

    const oldEntries = Array.from(seriesMap.values());
    seriesMap.clear();

    for (const old of oldEntries) {
      const busSchema = resolvePlotSchema(schema, old.busId);
      const matched = busSchema
        ? (busSchema.signals.find(
            (s) => s.messageKey === old.messageKey && s.name === old.signalName,
          ) ?? busSchema.signals.find((s) => s.name === old.signalName))
        : undefined;

      if (matched) {
        const nextKey = makePlotSeriesKey(old.busId, matched.signalId);
        old.key = nextKey;
        old.signalId = matched.signalId;
        old.messageKey = matched.messageKey;
        old.unit = matched.unit;
        old.schemaMin = matched.min;
        old.schemaMax = matched.max;
        if (old.count === 0) {
          const stickyInit = computeInitialStickyFromSchema(matched.min, matched.max);
          old.initializedAutoY = stickyInit.initialized;
          old.stickyAutoYMin = stickyInit.yMin;
          old.stickyAutoYMax = stickyInit.yMax;
          old.lastAutoYMin = stickyInit.yMin;
          old.lastAutoYMax = stickyInit.yMax;
        }
        seriesMap.set(nextKey, old);
      } else {
        seriesMap.set(old.key, old);
      }
    }
    syncSnapshotAndEmit(true);
  },

  exportProjectState(): PlotProjectState {
    const watchedSignals: SavedPlotSignalSpec[] = Array.from(seriesMap.values()).map(
      (e) => ({
        busId: e.busId,
        signalId: e.signalId,
        messageKey: e.messageKey,
        signalName: e.signalName,
        unit: e.unit,
        schemaMin: e.schemaMin,
        schemaMax: e.schemaMax,
        colorHex: e.colorHex,
        visible: e.visible,
        autoScale: e.autoScale,
        customYMin: e.customYMin,
        customYMax: e.customYMax,
      }),
    );

    return {
      watchedSignals,
      layoutMode: currentState.layoutMode,
      yScaleMode: currentState.yScaleMode,
      timeWindowSec: viewport.viewSpanSec,
      splitRowHeight: currentState.splitRowHeight,
    };
  },

  restoreFromProject(
    state: PlotProjectState,
    schema: PlotSchemaSource,
  ): void {
    seriesMap.clear();
    originTimestampUs = 0;
    lastIngestedTimestampUs = -1;
    latestTimeSec = 0;
    zoomHistory = [];

    for (const spec of state.watchedSignals) {
      const busSchema = resolvePlotSchema(schema, spec.busId);
      const matched = busSchema
        ? (busSchema.signals.find(
            (s) => s.messageKey === spec.messageKey && s.name === spec.signalName,
          ) ?? busSchema.signals.find((s) => s.name === spec.signalName))
        : undefined;

      const resolvedSpec: SavedPlotSignalSpec = matched
        ? {
            ...spec,
            signalId: matched.signalId,
            messageKey: matched.messageKey,
            unit: matched.unit,
            schemaMin: matched.min,
            schemaMax: matched.max,
          }
        : spec;

      const entry = createFreshSeriesEntry(resolvedSpec);
      seriesMap.set(entry.key, entry);
    }

    const restoredSpan = clampPlotSpan(state.timeWindowSec ?? 30);
    viewport.viewSpanSec = restoredSpan;
    viewport.liveFollow = true;
    viewport.viewRightTimeSec = restoredSpan;
    viewport.combinedYAuto = true;

    const validHeights: readonly PlotSplitRowHeight[] = [140, 200, 280];
    const resolvedHeight: PlotSplitRowHeight =
      state.splitRowHeight && validHeights.includes(state.splitRowHeight)
        ? state.splitRowHeight
        : 200;

    const resolvedYScale: PlotYScaleMode =
      state.yScaleMode === 'shared' ||
      state.yScaleMode === 'normalized' ||
      state.yScaleMode === 'multiAxis'
        ? state.yScaleMode
        : 'multiAxis';

    currentState = {
      ...currentState,
      layoutMode: state.layoutMode === 'split' ? 'split' : 'combined',
      yScaleMode: resolvedYScale,
      splitRowHeight: resolvedHeight,
      paused: false,
    };
    syncSnapshotAndEmit(true);
  },
};

export function usePlotStore(): PlotStoreState {
  return useSyncExternalStore(
    plotStore.subscribe,
    plotStore.getState,
    plotStore.getState,
  );
}
