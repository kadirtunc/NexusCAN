import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Minimize2,
  Pause,
  Play,
  Trash2,
  X,
} from 'lucide-react';
import { databaseStore, useDatabaseStore } from '../store/databaseStore';
import { plotStore } from '../store/plotStore';
import {
  MAX_CHRONO_BUFFER_ROWS,
  MIN_CHRONO_BUFFER_ROWS,
  telemetryStore,
  useTelemetryChrono,
} from '../store/telemetryStore';
import type { ChronologicalFrameDto } from '../types/telemetry';
import {
  formatByteHex,
  formatMuxRanges,
  formatPcanIdHex,
  formatRelativeTimeSec,
} from '../utils/formatters';
import {
  type DecodedTraceSignal,
  decodeTraceFrame,
  formatDecodedTraceInline,
  resolveTraceFrameSymbol,
} from '../utils/traceDecoder';
import { QuickPlotButton } from './PlotterView';

const ROW_HEIGHT = 24;
const OVERSCAN = 14;

const BUFFER_PRESETS: readonly number[] = [
  1_000,
  5_000,
  10_000,
  25_000,
  50_000,
  100_000,
];

interface ExpandedAnchor {
  baseIdx: number;
  frameUid: number;
  frame: ChronologicalFrameDto;
  signals: readonly DecodedTraceSignal[];
  childRowCount: number; // >= 1
  cumExtraBefore: number;
}

type VirtualRowItem =
  | {
      kind: 'frame';
      vIdx: number;
      baseIdx: number;
      frameUid: number;
      frame: ChronologicalFrameDto;
      isExpanded: boolean;
    }
  | {
      kind: 'signal';
      vIdx: number;
      frameUid: number;
      frame: ChronologicalFrameDto;
      sig: DecodedTraceSignal | null;
      childIdx: number;
    };

function binarySearchInt32(arr: Int32Array, target: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = arr[mid];
    if (v === target) return mid;
    if (v < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export const TraceView: React.FC = () => {
  const dbState = useDatabaseStore();
  const chrono = useTelemetryChrono();

  const [filterQuery, setFilterQuery] = useState<string>('');
  const [dirFilter, setDirFilter] = useState<'ALL' | 'RX' | 'TX'>('ALL');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [showDecodedCol, setShowDecodedCol] = useState<boolean>(true);
  const [expandedUids, setExpandedUids] = useState<Set<number>>(() => new Set());
  const [customBufferText, setCustomBufferText] = useState<string>(
    String(chrono.maxBufferRows),
  );

  const [scrollTop, setScrollTop] = useState<number>(0);
  const [viewportHeight, setViewportHeight] = useState<number>(600);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setCustomBufferText(String(chrono.maxBufferRows));
  }, [chrono.maxBufferRows]);

  const q = filterQuery.trim().toLowerCase();
  const isUnfiltered = q.length === 0 && dirFilter === 'ALL';

  // When unfiltered (99% case): ZERO array allocation! When filtered: compact Int32Array of ring indices.
  const filteredIndices: Int32Array | null = useMemo(() => {
    if (isUnfiltered) return null;

    const matches: number[] = [];
    const len = chrono.count;
    for (let i = 0; i < len; i++) {
      const row = chrono.ring.getAt(i);
      if (!row) continue;
      if (dirFilter === 'RX' && row.isTx) continue;
      if (dirFilter === 'TX' && !row.isTx) continue;

      if (q.length > 0) {
        const msg = databaseStore.getMessageForBus(row.busId, row.messageKey, row.arbId, row.isExtended);
        const signalsById = databaseStore.getBusSignals(row.busId);
        const muxSym = resolveTraceFrameSymbol(row.rawBytes, msg, signalsById);
        const idHex = formatPcanIdHex(row.arbId, row.isExtended).toLowerCase();
        const sym = (msg?.name ?? '').toLowerCase();
        const fullMuxSym = muxSym.fullSymbol.toLowerCase();
        let sigMatch = false;
        if (msg) {
          for (const sigId of msg.signalIds) {
            const s = databaseStore.getSignalForBus(row.busId, sigId);
            if (s && s.name.toLowerCase().includes(q)) {
              sigMatch = true;
              break;
            }
          }
        }
        if (!idHex.includes(q) && !sym.includes(q) && !fullMuxSym.includes(q) && !sigMatch) {
          continue;
        }
      }
      matches.push(i);
    }

    return Int32Array.from(matches);
  }, [
    isUnfiltered,
    chrono.version,
    chrono.count,
    chrono.ring,
    dirFilter,
    q,
    dbState.busSchemas,
  ]);

  const baseFrameCount = isUnfiltered
    ? chrono.count
    : (filteredIndices?.length ?? 0);

  // Build O(K) sorted expanded anchors ONLY for frames the user actually expanded!
  const { expandedAnchors, totalExtraRows } = useMemo(() => {
    const anchors: ExpandedAnchor[] = [];
    if (expandedUids.size === 0 || baseFrameCount === 0) {
      return { expandedAnchors: anchors, totalExtraRows: 0 };
    }

    const baseSeq = chrono.ring.baseSeq;
    const ringLen = chrono.count;

    const resolvedPairs: { baseIdx: number; frameUid: number; ringIdx: number }[] = [];
    for (const uid of expandedUids) {
      const ringIdx = uid - baseSeq;
      if (ringIdx < 0 || ringIdx >= ringLen) continue;

      if (isUnfiltered) {
        resolvedPairs.push({ baseIdx: ringIdx, frameUid: uid, ringIdx });
      } else if (filteredIndices) {
        const foundPos = binarySearchInt32(filteredIndices, ringIdx);
        if (foundPos >= 0) {
          resolvedPairs.push({ baseIdx: foundPos, frameUid: uid, ringIdx });
        }
      }
    }

    resolvedPairs.sort((a, b) => a.baseIdx - b.baseIdx);

    let cumExtra = 0;
    for (const item of resolvedPairs) {
      const frame = chrono.ring.getAt(item.ringIdx);
      if (!frame) continue;
      const msgSchema = databaseStore.getMessageForBus(
        frame.busId,
        frame.messageKey,
        frame.arbId,
        frame.isExtended,
      );
      const decoded = decodeTraceFrame(
        frame.rawBytes,
        msgSchema,
        databaseStore.getBusSignals(frame.busId),
      );
      const childRowCount = Math.max(1, decoded.length);
      anchors.push({
        baseIdx: item.baseIdx,
        frameUid: item.frameUid,
        frame,
        signals: decoded,
        childRowCount,
        cumExtraBefore: cumExtra,
      });
      cumExtra += childRowCount;
    }

    return { expandedAnchors: anchors, totalExtraRows: cumExtra };
  }, [
    expandedUids,
    baseFrameCount,
    isUnfiltered,
    filteredIndices,
    chrono.version,
    chrono.count,
    chrono.ring,
    dbState.busSchemas,
  ]);

  const totalVirtualRows = baseFrameCount + totalExtraRows;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const syncSize = (): void => setViewportHeight(el.clientHeight || 600);
    syncSize();
    const ro = new ResizeObserver(syncSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!autoScroll || chrono.paused) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, totalVirtualRows * ROW_HEIGHT - el.clientHeight);
  }, [totalVirtualRows, autoScroll, chrono.paused]);

  const totalHeight = totalVirtualRows * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    totalVirtualRows,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );
  const offsetY = startIndex * ROW_HEIGHT;

  // Map ONLY the ~35 visible virtual row indices in [startIndex, endIndex) in O(log K)!
  const visibleVirtualItems: readonly VirtualRowItem[] = useMemo(() => {
    const out: VirtualRowItem[] = [];
    if (totalVirtualRows === 0 || endIndex <= startIndex) return out;

    const getFrameByBaseIdx = (
      bIdx: number,
    ): { frame: ChronologicalFrameDto; frameUid: number } | null => {
      const ringIdx = isUnfiltered
        ? bIdx
        : (filteredIndices?.[bIdx] ?? -1);
      if (ringIdx < 0) return null;
      const frame = chrono.ring.getAt(ringIdx);
      if (!frame) return null;
      return { frame, frameUid: chrono.ring.baseSeq + ringIdx };
    };

    for (let vIdx = startIndex; vIdx < endIndex; vIdx++) {
      if (expandedAnchors.length === 0) {
        const resolved = getFrameByBaseIdx(vIdx);
        if (resolved) {
          out.push({
            kind: 'frame',
            vIdx,
            baseIdx: vIdx,
            frameUid: resolved.frameUid,
            frame: resolved.frame,
            isExpanded: false,
          });
        }
        continue;
      }

      // Find last anchor whose virtual parent position `anchorParentV <= vIdx`
      let lo = 0;
      let hi = expandedAnchors.length - 1;
      let candidateIdx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const anchorParentV =
          expandedAnchors[mid].baseIdx + expandedAnchors[mid].cumExtraBefore;
        if (anchorParentV <= vIdx) {
          candidateIdx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      if (candidateIdx >= 0) {
        const anc = expandedAnchors[candidateIdx];
        const ancParentV = anc.baseIdx + anc.cumExtraBefore;
        if (vIdx === ancParentV) {
          out.push({
            kind: 'frame',
            vIdx,
            baseIdx: anc.baseIdx,
            frameUid: anc.frameUid,
            frame: anc.frame,
            isExpanded: true,
          });
          continue;
        }
        if (vIdx > ancParentV && vIdx <= ancParentV + anc.childRowCount) {
          const childIdx = vIdx - ancParentV - 1;
          out.push({
            kind: 'signal',
            vIdx,
            frameUid: anc.frameUid,
            frame: anc.frame,
            sig: anc.signals[childIdx] ?? null,
            childIdx,
          });
          continue;
        }
        // `vIdx` lies AFTER `anc`'s expanded children
        const totalExtraBeforeV = anc.cumExtraBefore + anc.childRowCount;
        const baseIdx = vIdx - totalExtraBeforeV;
        const resolved = getFrameByBaseIdx(baseIdx);
        if (resolved) {
          out.push({
            kind: 'frame',
            vIdx,
            baseIdx,
            frameUid: resolved.frameUid,
            frame: resolved.frame,
            isExpanded: false,
          });
        }
      } else {
        // Before the very first expanded anchor (`cumExtraBefore === 0`)
        const resolved = getFrameByBaseIdx(vIdx);
        if (resolved) {
          out.push({
            kind: 'frame',
            vIdx,
            baseIdx: vIdx,
            frameUid: resolved.frameUid,
            frame: resolved.frame,
            isExpanded: false,
          });
        }
      }
    }

    return out;
  }, [
    totalVirtualRows,
    startIndex,
    endIndex,
    expandedAnchors,
    isUnfiltered,
    filteredIndices,
    chrono.version,
    chrono.ring,
  ]);

  const toggleExpandFrame = (frameUid: number): void => {
    // Pause auto-scroll when inspecting an expanded historical row so it stays under the cursor!
    setExpandedUids((prev) => {
      const next = new Set(prev);
      if (next.has(frameUid)) {
        next.delete(frameUid);
      } else {
        next.add(frameUid);
        setAutoScroll(false);
      }
      return next;
    });
  };

  const applyCustomBufferLimit = (): void => {
    const parsed = Number(customBufferText);
    if (Number.isFinite(parsed)) {
      const clamped = Math.max(
        MIN_CHRONO_BUFFER_ROWS,
        Math.min(MAX_CHRONO_BUFFER_ROWS, Math.floor(parsed)),
      );
      telemetryStore.setMaxChronoBufferRows(clamped);
      setCustomBufferText(String(clamped));
    } else {
      setCustomBufferText(String(chrono.maxBufferRows));
    }
  };

  const gridTemplateClass = showDecodedCol
    ? 'grid-cols-[26px_96px_42px_46px_84px_175px_46px_44px_225px_1fr]'
    : 'grid-cols-[26px_96px_42px_46px_84px_190px_46px_48px_1fr]';

  return (
    <div
      style={{ backgroundColor: 'var(--bg-panel)' }}
      className="flex flex-col flex-1 min-h-0 select-none"
    >
      {/* Slim 28px PCAN Trace Toolbar with 100,000 Buffer Controls & Show Decoded Toggle */}
      <div
        style={{
          backgroundColor: 'var(--bg-toolbar)',
          borderBottom: '1px solid var(--border-strong)',
        }}
        className="shrink-0 h-[28px] px-2 flex items-center justify-between gap-2 text-[11px]"
      >
        <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto">
          <button
            type="button"
            onClick={() => telemetryStore.setChronoPaused(!chrono.paused)}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[21px] px-2 border flex items-center gap-1 font-medium cursor-pointer shrink-0"
          >
            {chrono.paused ? (
              <>
                <Play className="w-3 h-3 text-[var(--text-secondary)]" />
                <span>Resume</span>
              </>
            ) : (
              <>
                <Pause className="w-3 h-3 text-[var(--text-secondary)]" />
                <span>Pause</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              setExpandedUids(new Set());
              telemetryStore.clearChrono();
            }}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[21px] px-2 border flex items-center gap-1 cursor-pointer shrink-0"
          >
            <Trash2 className="w-3 h-3 text-[var(--text-secondary)]" />
            <span>Clear</span>
          </button>

          <label className="flex items-center gap-1 px-1 cursor-pointer text-[var(--text-secondary)] shrink-0">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="accent-sky-600 cursor-pointer"
            />
            <span>Auto-Scroll</span>
          </label>

          <label
            className="flex items-center gap-1 px-1 cursor-pointer text-[var(--text-primary)] font-medium shrink-0"
            title="Decode DBC/KCD physical & enum signal values inline for every historical frame"
          >
            <input
              type="checkbox"
              checked={showDecodedCol}
              onChange={(e) => setShowDecodedCol(e.target.checked)}
              className="accent-emerald-600 cursor-pointer"
            />
            <span>Show Decoded</span>
          </label>

          {expandedUids.size > 0 && (
            <button
              type="button"
              onClick={() => setExpandedUids(new Set())}
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-grid)',
                color: 'var(--text-secondary)',
              }}
              className="h-[21px] px-1.5 border flex items-center gap-1 cursor-pointer shrink-0"
              title="Collapse all expanded trace frames"
            >
              <Minimize2 className="w-3 h-3" />
              <span>Collapse ({expandedUids.size})</span>
            </button>
          )}

          <div className="h-3.5 w-[1px] bg-[var(--border-strong)] mx-0.5 shrink-0" />

          <span className="text-[var(--text-secondary)] shrink-0">Filter:</span>
          <div className="relative flex items-center shrink-0">
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="ID, Symbol, Signal..."
              style={{
                backgroundColor: 'var(--bg-input)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              className="h-[21px] w-36 px-1.5 pr-5 border text-[11px] focus:outline-none"
            />
            {filterQuery && (
              <button
                type="button"
                onClick={() => setFilterQuery('')}
                className="absolute right-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <select
            aria-label="Direction Filter"
            value={dirFilter}
            onChange={(e) => setDirFilter(e.target.value as 'ALL' | 'RX' | 'TX')}
            style={{
              backgroundColor: 'var(--bg-input)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[21px] px-1.5 border text-[11px] focus:outline-none shrink-0"
          >
            <option value="ALL">Rx + Tx</option>
            <option value="RX">Rx Only</option>
            <option value="TX">Tx Only</option>
          </select>

          <div className="h-3.5 w-[1px] bg-[var(--border-strong)] mx-0.5 shrink-0" />

          {/* Adjustable O(1) Ring Buffer Capacity up to 100,000 Frames */}
          <span className="text-[var(--text-secondary)] shrink-0">Buffer Limit:</span>
          <select
            aria-label="Trace Buffer Preset Size"
            value={
              BUFFER_PRESETS.includes(chrono.maxBufferRows)
                ? String(chrono.maxBufferRows)
                : 'custom'
            }
            onChange={(e) => {
              if (e.target.value !== 'custom') {
                telemetryStore.setMaxChronoBufferRows(Number(e.target.value));
              }
            }}
            style={{
              backgroundColor: 'var(--bg-input)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[21px] px-1.5 border font-mono tabular-nums text-[11px] focus:outline-none shrink-0"
          >
            {BUFFER_PRESETS.map((sz) => (
              <option key={sz} value={sz}>
                {sz.toLocaleString('en-US')} rows
              </option>
            ))}
            {!BUFFER_PRESETS.includes(chrono.maxBufferRows) && (
              <option value="custom">Custom</option>
            )}
          </select>

          <input
            type="number"
            aria-label="Custom Trace Buffer Rows (100 to 100000)"
            min={MIN_CHRONO_BUFFER_ROWS}
            max={MAX_CHRONO_BUFFER_ROWS}
            step={1000}
            value={customBufferText}
            onChange={(e) => setCustomBufferText(e.target.value)}
            onBlur={applyCustomBufferLimit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                applyCustomBufferLimit();
              }
            }}
            style={{
              backgroundColor: 'var(--bg-input)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[21px] w-[72px] px-1.5 border font-mono tabular-nums text-[11px] text-right focus:outline-none shrink-0"
            title="Enter custom ring buffer size between 100 and 100,000 frames"
          />
        </div>

        <div className="font-mono tabular-nums text-[var(--text-secondary)] shrink-0">
          Buffer: {baseFrameCount.toLocaleString('en-US')} /{' '}
          {chrono.maxBufferRows.toLocaleString('en-US')} (Total:{' '}
          {chrono.totalCaptured.toLocaleString('en-US')})
        </div>
      </div>

      {/* Fixed Header matching PCAN-Explorer Trace Window */}
      <div
        style={{
          backgroundColor: 'var(--bg-header)',
          borderBottom: '1px solid var(--border-strong)',
          color: 'var(--text-secondary)',
        }}
        className={`shrink-0 h-[24px] grid ${gridTemplateClass} items-center text-[11px] font-semibold`}
      >
        <div className="h-full flex items-center justify-center border-r border-[var(--border-grid)]" />
        <div className="px-2 h-full flex items-center justify-end border-r border-[var(--border-grid)]">
          Time
        </div>
        <div className="px-2 h-full flex items-center border-r border-[var(--border-grid)]">
          Bus
        </div>
        <div className="px-2 h-full flex items-center border-r border-[var(--border-grid)]">
          Type
        </div>
        <div className="px-2 h-full flex items-center border-r border-[var(--border-grid)]">
          ID
        </div>
        <div className="px-2 h-full flex items-center border-r border-[var(--border-grid)]">
          Symbol
        </div>
        <div className="px-2 h-full flex items-center border-r border-[var(--border-grid)]">
          Dir
        </div>
        <div className="px-2 h-full flex items-center justify-end border-r border-[var(--border-grid)]">
          DLC
        </div>
        <div
          className={`px-2 h-full flex items-center ${
            showDecodedCol ? 'border-r border-[var(--border-grid)]' : ''
          }`}
        >
          Data
        </div>
        {showDecodedCol && (
          <div className="px-2 h-full flex items-center">
            Decoded Signals
          </div>
        )}
      </div>

      {/* Virtualized O(1) Chronological Rows + Expandable 24px-Locked Decoded Signal Rows */}
      <div
        ref={containerRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="flex-1 min-h-0 overflow-y-auto font-mono tabular-nums text-[12px]"
      >
        {totalVirtualRows === 0 ? (
          <div className="py-12 text-center font-sans text-[var(--text-muted)]">
            No trace frames
          </div>
        ) : (
          <div style={{ height: `${totalHeight}px`, position: 'relative' }}>
            <div style={{ transform: `translateY(${offsetY}px)` }}>
              {visibleVirtualItems.map((item) => {
                if (item.kind === 'signal') {
                  const d = item.sig;
                  return (
                    <div
                      key={`sig-${item.frameUid}-${item.childIdx}`}
                      style={{
                        height: `${ROW_HEIGHT}px`,
                        minHeight: `${ROW_HEIGHT}px`,
                        maxHeight: `${ROW_HEIGHT}px`,
                        backgroundColor: 'var(--bg-row-signal)',
                        borderBottom: '1px solid var(--border-grid)',
                      }}
                      className="group flex items-center justify-between px-2 pl-8 overflow-hidden whitespace-nowrap hover:!bg-[var(--bg-row-hover)]"
                    >
                      {!d ? (
                        <span className="font-sans text-[11px] text-[var(--text-muted)] border-l-2 border-[var(--border-strong)] pl-3">
                          No decoded signals
                        </span>
                      ) : (
                        <>
                          <div className="flex items-center gap-2 min-w-0 border-l-2 border-[var(--border-strong)] pl-3">
                            <span className="text-[var(--text-muted)]">~</span>
                            <span className="font-sans font-medium text-[var(--text-primary)] truncate">
                              {d.signal.name}
                            </span>
                            <span className="text-[var(--text-muted)]">=</span>
                            <span className="font-semibold text-[var(--text-primary)] select-text">
                              {d.formattedValue}
                            </span>
                            {d.outOfRange && (
                              <span className="text-red-500 font-sans text-[11px] font-semibold">
                                [Out of Range]
                              </span>
                            )}
                            <QuickPlotButton
                              busId={item.frame.busId}
                              signalId={d.signal.signalId}
                              hoverReveal
                              onToggle={() =>
                                plotStore.toggleSignal(item.frame.busId, d.signal)
                              }
                            />
                          </div>

                          <div className="text-[11px] text-[var(--text-muted)] shrink-0 ml-4">
                            Raw: {d.rawHex}
                            {d.signal.muxRole === 'masterSwitch'
                              ? ' · Master [M]'
                              : d.isSubSwitch
                                ? ` · Sub-Switch [m${formatMuxRanges(d.signal.muxRanges)} · M]`
                                : d.signal.muxRole === 'multiplexed'
                                  ? ` · Mux m${formatMuxRanges(d.signal.muxRanges)}`
                                  : ''}
                          </div>
                        </>
                      )}
                    </div>
                  );
                }

                const row = item.frame;
                const msg = databaseStore.getMessageForBus(
                  row.busId,
                  row.messageKey,
                  row.arbId,
                  row.isExtended,
                );
                const signalsById = databaseStore.getBusSignals(row.busId);
                const muxSym = resolveTraceFrameSymbol(row.rawBytes, msg, signalsById);
                const decodedInline =
                  showDecodedCol && msg
                    ? formatDecodedTraceInline(
                        decodeTraceFrame(row.rawBytes, msg, signalsById),
                      )
                    : '';
                const byteLen = Math.min(row.dlc, row.rawBytes.length);

                return (
                  <div
                    key={`frm-${item.frameUid}`}
                    onClick={() => toggleExpandFrame(item.frameUid)}
                    style={{
                      height: `${ROW_HEIGHT}px`,
                      minHeight: `${ROW_HEIGHT}px`,
                      maxHeight: `${ROW_HEIGHT}px`,
                      backgroundColor: item.isExpanded
                        ? 'var(--bg-row-selected)'
                        : item.baseIdx % 2 === 1
                          ? 'var(--bg-row-alt)'
                          : 'var(--bg-panel)',
                      borderBottom: '1px solid var(--border-grid)',
                    }}
                    className={`grid ${gridTemplateClass} items-center hover:!bg-[var(--bg-row-hover)] cursor-pointer overflow-hidden whitespace-nowrap`}
                  >
                    <div className="h-full flex items-center justify-center border-r border-[var(--border-grid)]">
                      {msg && msg.signalIds.length > 0 ? (
                        item.isExpanded ? (
                          <ChevronDown className="w-3.5 h-3.5 text-[var(--text-primary)]" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                        )
                      ) : null}
                    </div>

                    <div className="px-2 h-full flex items-center justify-end border-r border-[var(--border-grid)] text-[var(--text-secondary)]">
                      {formatRelativeTimeSec(row.timestampUs, chrono.originTimestampUs)}
                    </div>

                    <div className="px-2 h-full flex items-center border-r border-[var(--border-grid)]">
                      {row.busId + 1}
                    </div>

                    <div className="px-2 h-full flex items-center border-r border-[var(--border-grid)]">
                      {row.isFd || row.dlc > 8 ? 'FD' : 'CC'}
                    </div>

                    <div className="px-2 h-full flex items-center border-r border-[var(--border-grid)]">
                      {formatPcanIdHex(row.arbId, row.isExtended)}
                    </div>

                    <div
                      className="px-2 h-full flex items-center border-r border-[var(--border-grid)] font-sans truncate"
                      title={msg ? muxSym.fullSymbol : undefined}
                    >
                      {msg ? (
                        <span className="truncate">
                          <span style={{ color: '#E6EDF3' }}>{muxSym.baseName}</span>
                          {muxSym.muxSuffix !== null && (
                            <span className="font-mono tabular-nums" style={{ color: '#79C0FF' }}>
                              .{muxSym.muxSuffix}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </div>

                    <div
                      className={`px-2 h-full flex items-center border-r border-[var(--border-grid)] font-sans ${
                        row.isTx ? 'text-sky-500 font-semibold' : ''
                      }`}
                    >
                      {row.isTx ? 'Tx' : 'Rx'}
                    </div>

                    <div className="px-2 h-full flex items-center justify-end border-r border-[var(--border-grid)]">
                      {row.dlc}
                    </div>

                    <div
                      className={`px-2 h-full flex items-center overflow-x-auto no-scrollbar select-text ${
                        showDecodedCol ? 'border-r border-[var(--border-grid)]' : ''
                      }`}
                    >
                      <span>
                        {Array.from({ length: byteLen }, (_, bIdx) =>
                          formatByteHex(row.rawBytes[bIdx] ?? 0),
                        ).join(' ')}
                      </span>
                    </div>

                    {showDecodedCol && (
                      <div
                        className="px-2 h-full flex items-center text-[11px] text-[var(--text-secondary)] truncate select-text"
                        title={decodedInline || undefined}
                      >
                        <span className="truncate">
                          {decodedInline || (msg ? '' : '—')}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
