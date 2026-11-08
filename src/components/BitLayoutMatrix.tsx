import React, { useEffect, useMemo, useState } from 'react';
import { GitBranch, Layers, Radio, SlidersHorizontal } from 'lucide-react';
import { databaseStore, useDatabaseStore } from '../store/databaseStore';
import { plotStore } from '../store/plotStore';
import { useTelemetryFrames } from '../store/telemetryStore';
import type { BitCellDto, MessageSchemaDto, SignalSchemaDto } from '../types/netdb';
import {
  formatByteHex,
  formatMuxRanges,
  formatPcanIdHex,
  formatPhysicalValue,
  getSignalColor,
} from '../utils/formatters';
import { QuickPlotButton } from './PlotterView';

type MuxViewMode = 'interactive' | 'live' | 'overlay';
type SignalTableScope = 'all' | 'activePage';

interface SwitchDescriptor {
  signal: SignalSchemaDto;
  isSubSwitch: boolean;
  level: number;
  branchValues: readonly number[];
}

const BIT_COLUMNS: readonly number[] = [7, 6, 5, 4, 3, 2, 1, 0];

function rangeContains(ranges: readonly [number, number][], val: number): boolean {
  for (const [start, end] of ranges) {
    if (val >= start && val <= end) return true;
  }
  return false;
}

export const BitLayoutMatrix: React.FC = () => {
  const dbState = useDatabaseStore();
  const framesSlice = useTelemetryFrames();

  const [hoveredSignalId, setHoveredSignalId] = useState<number | null>(null);
  const [muxViewMode, setMuxViewMode] = useState<MuxViewMode>('interactive');
  const [muxSelections, setMuxSelections] = useState<Record<number, number>>({});
  const [signalTableScope, setSignalTableScope] = useState<SignalTableScope>('all');

  const messages = dbState.schema?.messages ?? [];

  const selectedMessage: MessageSchemaDto | undefined = useMemo(() => {
    if (messages.length === 0) return undefined;
    if (dbState.selectedMessageKey) {
      const found = dbState.messagesByKey.get(dbState.selectedMessageKey);
      if (found) return found;
    }
    return messages[0];
  }, [messages, dbState.selectedMessageKey, dbState.messagesByKey]);

  const liveFrame = selectedMessage
    ? framesSlice.framesByKey.get(selectedMessage.messageKey)
    : undefined;

  const signalColorMap = useMemo(() => {
    const map = new Map<number, ReturnType<typeof getSignalColor>>();
    if (!selectedMessage) return map;
    selectedMessage.signalIds.forEach((sigId, idx) => {
      map.set(sigId, getSignalColor(idx));
    });
    return map;
  }, [selectedMessage]);

  // Discover all Master Switches & Cascaded Sub-Switches in the selected message
  const { switchDescriptors, subSwitchIds, masterSwitchCount, subSwitchCount } =
    useMemo(() => {
      const subIds = new Set<number>();
      const descriptors: SwitchDescriptor[] = [];
      let masterCnt = 0;
      let subCnt = 0;

      if (!selectedMessage || !selectedMessage.isMultiplexed) {
        return {
          switchDescriptors: descriptors,
          subSwitchIds: subIds,
          masterSwitchCount: 0,
          subSwitchCount: 0,
        };
      }

      // Collect discrete branch values referenced by child signals for each switchSignalId
      const childValuesBySwitch = new Map<number, Set<number>>();
      for (const sigId of selectedMessage.signalIds) {
        const sig: SignalSchemaDto | undefined = dbState.signalsById[sigId];
        if (!sig || sig.switchSignalId === null) continue;

        const parentSw: SignalSchemaDto | undefined =
          dbState.signalsById[sig.switchSignalId];
        if (parentSw && parentSw.muxRole === 'multiplexed') {
          subIds.add(parentSw.signalId);
        }

        let valSet = childValuesBySwitch.get(sig.switchSignalId);
        if (!valSet) {
          valSet = new Set<number>();
          childValuesBySwitch.set(sig.switchSignalId, valSet);
        }
        for (const [start, end] of sig.muxRanges) {
          const span = Math.min(end - start, 15);
          for (let offset = 0; offset <= span; offset++) {
            valSet.add(start + offset);
          }
          if (end > start + 15) {
            valSet.add(end);
          }
        }
      }

      // Compute hierarchy depth (0 = masterSwitch, 1 = level-2 sub-switch, ...)
      const getSwitchDepth = (sig: SignalSchemaDto): number => {
        let depth = 0;
        let curSwId: number | null = sig.switchSignalId;
        while (curSwId !== null && depth < 10) {
          depth += 1;
          const parentSig: SignalSchemaDto | undefined = dbState.signalsById[curSwId];
          curSwId = parentSig?.switchSignalId ?? null;
        }
        return depth;
      };

      for (const sigId of selectedMessage.signalIds) {
        const sig: SignalSchemaDto | undefined = dbState.signalsById[sigId];
        if (!sig) continue;
        const isMaster = sig.muxRole === 'masterSwitch';
        const isSub = subIds.has(sig.signalId);
        if (!isMaster && !isSub) continue;

        if (isMaster) masterCnt += 1;
        if (isSub) subCnt += 1;

        const valSet = new Set<number>(childValuesBySwitch.get(sig.signalId) ?? []);
        for (const enumKey of Object.keys(sig.enumTable)) {
          const parsed = Number(enumKey);
          if (Number.isInteger(parsed)) {
            valSet.add(parsed);
          }
        }
        if (valSet.size === 0) {
          valSet.add(0);
        }

        const sortedVals = Array.from(valSet).sort((a, b) => a - b);
        descriptors.push({
          signal: sig,
          isSubSwitch: isSub,
          level: getSwitchDepth(sig),
          branchValues: sortedVals,
        });
      }

      descriptors.sort((a, b) =>
        a.level !== b.level ? a.level - b.level : a.signal.startBit - b.signal.startBit,
      );

      return {
        switchDescriptors: descriptors,
        subSwitchIds: subIds,
        masterSwitchCount: masterCnt,
        subSwitchCount: subCnt,
      };
    }, [selectedMessage, dbState.signalsById]);

  // Reset / seed default switch branch values when switching symbols
  useEffect(() => {
    if (!selectedMessage || !selectedMessage.isMultiplexed) {
      setMuxSelections({});
      setSignalTableScope('all');
      return;
    }
    setMuxSelections((prev) => {
      const next: Record<number, number> = {};
      for (const desc of switchDescriptors) {
        const existing = prev[desc.signal.signalId];
        next[desc.signal.signalId] =
          existing !== undefined && desc.branchValues.includes(existing)
            ? existing
            : (desc.branchValues[0] ?? 0);
      }
      return next;
    });
  }, [selectedMessage?.messageKey, switchDescriptors]);

  // Automatically jump Interactive Mux Page to a signal's cascaded mux branch when selected
  useEffect(() => {
    if (
      !selectedMessage ||
      !selectedMessage.isMultiplexed ||
      dbState.selectedSignalId === null
    ) {
      return;
    }
    const targetSig: SignalSchemaDto | undefined =
      dbState.signalsById[dbState.selectedSignalId];
    if (!targetSig || targetSig.messageKey !== selectedMessage.messageKey) {
      return;
    }

    if (targetSig.muxRole === 'multiplexed' && targetSig.switchSignalId !== null) {
      setMuxViewMode('interactive');
      setMuxSelections((prev) => {
        const next: Record<number, number> = { ...prev };
        let cur: SignalSchemaDto | undefined = targetSig;
        let guard = 0;
        while (cur && cur.switchSignalId !== null && guard < 12) {
          guard += 1;
          const parentSwId: number = cur.switchSignalId;
          const existingVal = next[parentSwId];
          const matchesExisting =
            existingVal !== undefined && rangeContains(cur.muxRanges, existingVal);
          if (!matchesExisting && cur.muxRanges.length > 0) {
            next[parentSwId] = cur.muxRanges[0][0];
          }
          const parentSig: SignalSchemaDto | undefined = dbState.signalsById[parentSwId];
          cur = parentSig;
        }
        return next;
      });
    }
  }, [
    selectedMessage,
    dbState.selectedSignalId,
    dbState.selectedSignalSeq,
    dbState.signalsById,
  ]);

  // Compute effective switch values (Interactive vs Live Bus Follow)
  const effectiveSwitchValues: Readonly<Record<number, number>> = useMemo(() => {
    if (muxViewMode !== 'live') {
      const out: Record<number, number> = {};
      for (const desc of switchDescriptors) {
        out[desc.signal.signalId] =
          muxSelections[desc.signal.signalId] ?? desc.branchValues[0] ?? 0;
      }
      return out;
    }

    // Live Bus Follow: read from liveFrame.activeMuxSwitches or live decoded switch signals
    const out: Record<number, number> = {};
    if (!liveFrame) return out;

    for (const desc of switchDescriptors) {
      const sw = desc.signal;
      const byId = liveFrame.activeMuxSwitches[String(sw.signalId)];
      const byName = liveFrame.activeMuxSwitches[sw.name];
      if (byId !== undefined) {
        out[sw.signalId] = byId;
      } else if (byName !== undefined) {
        out[sw.signalId] = byName;
      } else {
        const liveSw = liveFrame.signals.find(
          (s) => s.signalId === sw.signalId && s.activeInLastFrame,
        );
        if (liveSw) {
          out[sw.signalId] = Math.trunc(liveSw.rawInt);
        }
      }
    }
    return out;
  }, [muxViewMode, muxSelections, switchDescriptors, liveFrame]);

  // Recursive cascaded evaluation: is `signalId` active on the current mux page?
  const activeSignalIdsOnPage: ReadonlySet<number> = useMemo(() => {
    const active = new Set<number>();
    if (!selectedMessage) return active;

    const checkActive = (sigId: number, depth: number): boolean => {
      if (depth > 12) return false;
      const sig: SignalSchemaDto | undefined = dbState.signalsById[sigId];
      if (!sig) return false;
      if (sig.muxRole === 'static' || sig.muxRole === 'masterSwitch') return true;
      if (sig.switchSignalId === null) return true;
      if (!checkActive(sig.switchSignalId, depth + 1)) return false;
      const swVal = effectiveSwitchValues[sig.switchSignalId];
      if (swVal === undefined) return false;
      return rangeContains(sig.muxRanges, swVal);
    };

    for (const sigId of selectedMessage.signalIds) {
      if (checkActive(sigId, 0)) {
        active.add(sigId);
      }
    }
    return active;
  }, [selectedMessage, dbState.signalsById, effectiveSwitchValues]);

  // Precompute message-wide mux statistics & full-overlay bit conflict count
  const muxSummary = useMemo(() => {
    if (!selectedMessage) {
      return { staticCount: 0, overlappingBitsCount: 0 };
    }
    let staticCount = 0;
    for (const sigId of selectedMessage.signalIds) {
      const sig = dbState.signalsById[sigId];
      if (sig && sig.muxRole === 'static') {
        staticCount += 1;
      }
    }
    const bitCoordCounts = new Map<string, number>();
    for (const cell of selectedMessage.bitLayout) {
      const k = `${cell.byteIndex}:${cell.bitInByte}`;
      bitCoordCounts.set(k, (bitCoordCounts.get(k) ?? 0) + 1);
    }
    let overlappingBitsCount = 0;
    for (const count of bitCoordCounts.values()) {
      if (count > 1) overlappingBitsCount += 1;
    }
    return { staticCount, overlappingBitsCount };
  }, [selectedMessage, dbState.signalsById]);

  // Build (byteIndex:bitInByte) -> BitCellDto[] map for current view mode
  const filteredCellsByCoord = useMemo(() => {
    const grid = new Map<string, BitCellDto[]>();
    if (!selectedMessage) return grid;

    for (const cell of selectedMessage.bitLayout) {
      const include =
        !selectedMessage.isMultiplexed ||
        muxViewMode === 'overlay' ||
        activeSignalIdsOnPage.has(cell.signalId);

      if (!include) continue;

      const coordKey = `${cell.byteIndex}:${cell.bitInByte}`;
      const bucket = grid.get(coordKey);
      if (bucket) {
        bucket.push(cell);
      } else {
        grid.set(coordKey, [cell]);
      }
    }

    return grid;
  }, [selectedMessage, muxViewMode, activeSignalIdsOnPage]);

  if (!dbState.schema || !selectedMessage) {
    return (
      <div
        style={{ backgroundColor: 'var(--bg-panel)', color: 'var(--text-muted)' }}
        className="flex items-center justify-center h-full p-6 text-center text-[12px]"
      >
        No symbol database loaded
      </div>
    );
  }

  const byteCount = Math.max(1, selectedMessage.dlc);
  const liveSignalsMap = new Map<number, { phys: number; active: boolean }>();
  if (liveFrame) {
    for (const s of liveFrame.signals) {
      liveSignalsMap.set(s.signalId, {
        phys: s.physicalValue,
        active: s.activeInLastFrame,
      });
    }
  }

  const displayedTableSignalIds =
    selectedMessage.isMultiplexed && signalTableScope === 'activePage'
      ? selectedMessage.signalIds.filter((id) => activeSignalIdsOnPage.has(id))
      : selectedMessage.signalIds;

  const formatCellTooltip = (
    byteIdx: number,
    bitInByte: number,
    cells: readonly BitCellDto[],
  ): string => {
    if (cells.length === 1) {
      const c = cells[0];
      const s = dbState.signalsById[c.signalId];
      const sw = c.switchSignalId !== null ? dbState.signalsById[c.switchSignalId] : null;
      const muxDesc = c.isMuxSwitch
        ? subSwitchIds.has(c.signalId)
          ? ` [Cascaded Sub-Switch m${formatMuxRanges(c.muxRanges)} · M]`
          : ' [Master Switch M]'
        : c.isMultiplexed
          ? ` [Mux m${formatMuxRanges(c.muxRanges)} via ${sw?.name ?? 'Switch'}]`
          : '';
      return `${s?.name ?? `Sig#${c.signalId}`}${muxDesc} · bit[${c.signalBitIndex}] (Byte ${byteIdx}, Bit ${bitInByte})`;
    }

    const lines = [
      `Shared Multiplexed Bit — Byte ${byteIdx}, Bit ${bitInByte} (${cells.length} signals):`,
    ];
    for (const c of cells) {
      const s = dbState.signalsById[c.signalId];
      const sw = c.switchSignalId !== null ? dbState.signalsById[c.switchSignalId] : null;
      const cond = c.isMultiplexed
        ? `${sw?.name ?? 'Switch'} = m${formatMuxRanges(c.muxRanges)}`
        : 'Static / Master';
      lines.push(
        `• ${s?.name ?? `Sig#${c.signalId}`} [bit ${c.signalBitIndex}] — ${cond}`,
      );
    }
    return lines.join('\n');
  };

  return (
    <div
      style={{ backgroundColor: 'var(--bg-panel)' }}
      className="flex flex-col h-full min-h-0"
    >
      {/* Slim 26px Matrix Header */}
      <div
        style={{
          backgroundColor: 'var(--bg-toolbar)',
          borderBottom: '1px solid var(--border-strong)',
        }}
        className="shrink-0 h-[26px] px-2 flex items-center justify-between gap-2 text-[11px]"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-[var(--text-secondary)]">Symbol:</span>
          <select
            aria-label="Select Symbol for Bit Layout"
            value={selectedMessage.messageKey}
            onChange={(e) => databaseStore.setSelectedMessageKey(e.target.value)}
            style={{
              backgroundColor: 'var(--bg-input)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[20px] px-1.5 border font-mono text-[11px]"
          >
            {messages.map((m) => (
              <option key={m.messageKey} value={m.messageKey}>
                {formatPcanIdHex(m.arbId, m.isExtended)}h — {m.name} ({m.dlc}B)
                {m.isMultiplexed ? ' [MUX]' : ''}
              </option>
            ))}
          </select>

          <span className="font-mono text-[var(--text-muted)] truncate">
            {selectedMessage.protocol} · {selectedMessage.dlc} Bytes ·{' '}
            {selectedMessage.signalIds.length} Signals
          </span>
        </div>

        {selectedMessage.isMultiplexed && (
          <span className="px-1.5 h-[18px] leading-[16px] text-[10px] font-mono font-bold border border-amber-500/50 bg-amber-500/15 text-amber-500 shrink-0">
            {subSwitchCount > 0 ? 'CASCADED MUX (SG_MUL_VAL_)' : 'MULTIPLEXED SYMBOL'}
          </span>
        )}
      </div>

      {/* ==================================================================== */}
      {/* MULTIPLEXER INSPECTOR & CASCADED BRANCH SELECTOR (FOR MUX MESSAGES)  */}
      {/* ==================================================================== */}
      {selectedMessage.isMultiplexed && (
        <div
          style={{
            backgroundColor: 'var(--bg-toolbar)',
            borderBottom: '1px solid var(--border-strong)',
          }}
          className="shrink-0 px-3 py-2 space-y-2 text-[11px] select-none"
        >
          {/* Row 1: Segmented Mux View Mode Control + Mux Summary Telemetry Strip */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[var(--text-secondary)] flex items-center gap-1">
                <GitBranch className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                <span>Mux:</span>
              </span>

              <div
                style={{ borderColor: 'var(--border-strong)' }}
                className="h-[22px] border inline-flex items-center overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => setMuxViewMode('interactive')}
                  style={{
                    backgroundColor:
                      muxViewMode === 'interactive'
                        ? 'var(--bg-header)'
                        : 'var(--bg-input)',
                    color:
                      muxViewMode === 'interactive'
                        ? 'var(--text-primary)'
                        : 'var(--text-muted)',
                  }}
                  className="h-full px-2 flex items-center gap-1 font-medium cursor-pointer"
                  title="Select multiplexer switch branches step-by-step (supports cascaded switches)"
                >
                  <SlidersHorizontal className="w-3 h-3 text-[var(--text-secondary)]" />
                  <span>Interactive</span>
                </button>

                <button
                  type="button"
                  onClick={() => setMuxViewMode('live')}
                  style={{
                    backgroundColor:
                      muxViewMode === 'live'
                        ? 'var(--bg-header)'
                        : 'var(--bg-input)',
                    color:
                      muxViewMode === 'live'
                        ? 'var(--text-primary)'
                        : 'var(--text-muted)',
                    borderLeft: '1px solid var(--border-strong)',
                  }}
                  className="h-full px-2 flex items-center gap-1 font-medium cursor-pointer"
                  title="Follow live CAN bus activeMuxSwitches in real time"
                >
                  <Radio className="w-3 h-3 text-[var(--text-secondary)]" />
                  <span>Live Bus</span>
                </button>

                <button
                  type="button"
                  onClick={() => setMuxViewMode('overlay')}
                  style={{
                    backgroundColor:
                      muxViewMode === 'overlay'
                        ? 'var(--bg-header)'
                        : 'var(--bg-input)',
                    color:
                      muxViewMode === 'overlay'
                        ? 'var(--text-primary)'
                        : 'var(--text-muted)',
                    borderLeft: '1px solid var(--border-strong)',
                  }}
                  className="h-full px-2 flex items-center gap-1 font-medium cursor-pointer"
                  title="Overlay all static, switch, and multiplexed branches simultaneously; shared payload bits are badged MUX ×N (hover any shared bit cell to inspect all overlapping mux signals)"
                >
                  <Layers className="w-3 h-3 text-[var(--text-secondary)]" />
                  <span>Overlay</span>
                </button>
              </div>
            </div>

            {/* Mux Summary Strip */}
            <div className="flex items-center gap-3 font-mono tabular-nums text-[11px] text-[var(--text-secondary)]">
              <span>
                Static: <strong className="text-[var(--text-primary)]">{muxSummary.staticCount}</strong>
              </span>
              <span>
                Switches:{' '}
                <strong className="text-amber-400">
                  {masterSwitchCount} M
                  {subSwitchCount > 0 ? ` + ${subSwitchCount} Sub-M` : ''}
                </strong>
              </span>
              <span>
                Page:{' '}
                <strong className="text-[var(--text-primary)]">
                  {muxViewMode === 'overlay'
                    ? selectedMessage.signalIds.length
                    : activeSignalIdsOnPage.size}
                </strong>
                /{selectedMessage.signalIds.length}
              </span>
              <span>
                Shared Bits:{' '}
                <strong className="text-[var(--text-primary)]">
                  {muxSummary.overlappingBitsCount}
                </strong>
              </span>
            </div>
          </div>

          {/* Row 2+: Cascaded Switch Selector Pills (Interactive) or Live Switch Readout */}
          {muxViewMode === 'interactive' && (
            <div className="space-y-1.5 pt-0.5">
              {switchDescriptors.map((desc) => {
                // Only show a cascaded sub-switch when its parent switch condition is currently active!
                if (
                  desc.isSubSwitch &&
                  !activeSignalIdsOnPage.has(desc.signal.signalId)
                ) {
                  return null;
                }
                const selectedVal =
                  effectiveSwitchValues[desc.signal.signalId] ??
                  desc.branchValues[0] ??
                  0;
                const parentSw =
                  desc.signal.switchSignalId !== null
                    ? dbState.signalsById[desc.signal.switchSignalId]
                    : undefined;

                return (
                  <div
                    key={desc.signal.signalId}
                    className={`flex flex-wrap items-center gap-1.5 ${
                      desc.level > 0
                        ? 'pl-4 border-l-2 border-amber-500/50'
                        : ''
                    }`}
                  >
                    <span className="font-mono text-[11px] font-semibold text-amber-500">
                      {desc.isSubSwitch
                        ? `Level ${desc.level + 1} Sub-Switch [m${formatMuxRanges(desc.signal.muxRanges)} · M]`
                        : 'Level 1 Master [M]'}
                      :
                    </span>
                    <span
                      className="font-semibold text-[var(--text-primary)] mr-1"
                      title={
                        parentSw
                          ? `Activated when ${parentSw.name} in [${formatMuxRanges(desc.signal.muxRanges)}]`
                          : undefined
                      }
                    >
                      {desc.signal.name}{' '}
                      <span className="font-mono text-[var(--text-muted)] font-normal">
                        ({desc.signal.startBit}|{desc.signal.bitLength})
                      </span>
                    </span>

                    {desc.branchValues.map((val) => {
                      const isSelected = selectedVal === val;
                      const enumName = desc.signal.enumTable[String(val)];
                      return (
                        <button
                          key={val}
                          type="button"
                          onClick={() =>
                            setMuxSelections((prev) => ({
                              ...prev,
                              [desc.signal.signalId]: val,
                            }))
                          }
                          style={{
                            backgroundColor: isSelected
                              ? 'rgba(245, 158, 11, 0.22)'
                              : 'var(--bg-panel)',
                            borderColor: isSelected
                              ? '#f59e0b'
                              : 'var(--border-strong)',
                            color: isSelected
                              ? 'var(--text-primary)'
                              : 'var(--text-secondary)',
                          }}
                          className={`h-[21px] px-2 border font-mono tabular-nums text-[11px] cursor-pointer ${
                            isSelected ? 'font-bold' : 'hover:text-[var(--text-primary)]'
                          }`}
                        >
                          m{val}
                          {enumName ? `: ${enumName}` : ''}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}

          {muxViewMode === 'live' && (
            <div className="flex flex-wrap items-center gap-2 font-mono tabular-nums">
              {!liveFrame ? (
                <span className="font-sans text-[var(--text-muted)]">
                  No live traffic on{' '}
                  <strong className="font-mono">
                    {formatPcanIdHex(selectedMessage.arbId, selectedMessage.isExtended)}h
                  </strong>
                </span>
              ) : (
                switchDescriptors.map((desc) => {
                  const isActiveSw = activeSignalIdsOnPage.has(desc.signal.signalId);
                  const liveVal = effectiveSwitchValues[desc.signal.signalId];
                  const enumName =
                    liveVal !== undefined
                      ? desc.signal.enumTable[String(liveVal)]
                      : undefined;
                  return (
                    <span
                      key={desc.signal.signalId}
                      style={{
                        backgroundColor: 'var(--bg-panel)',
                        borderColor: isActiveSw
                          ? 'var(--border-strong)'
                          : 'var(--border-grid)',
                      }}
                      className={`px-2 py-0.5 border text-[11px] ${
                        isActiveSw ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
                      }`}
                    >
                      <span className="text-amber-400 font-semibold mr-1">
                        {desc.isSubSwitch ? '[Sub-M]' : '[M]'}
                      </span>
                      {desc.signal.name} ={' '}
                      {isActiveSw && liveVal !== undefined ? (
                        <strong className="text-emerald-500">
                          m{liveVal}
                          {enumName ? ` (${enumName})` : ''}
                        </strong>
                      ) : (
                        <span>inactive</span>
                      )}
                    </span>
                  );
                })
              )}
            </div>
          )}
        </div>
      )}

      {/* Scrollable Bit Matrix + Flat Variables & Signals Table */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        <div
          style={{ borderColor: 'var(--border-strong)' }}
          className="border overflow-x-auto"
        >
          <table className="pcan-grid pcan-grid-fixed font-mono tabular-nums select-none">
            <colgroup>
              <col style={{ width: '64px' }} />
              {BIT_COLUMNS.map((bitCol) => (
                <col key={bitCol} />
              ))}
              <col style={{ width: '54px' }} />
            </colgroup>
            <thead>
              <tr>
                <th>Byte</th>
                {BIT_COLUMNS.map((bitCol) => (
                  <th key={bitCol} className="text-center">
                    Bit {bitCol}
                    {bitCol === 7 ? ' (MSB)' : bitCol === 0 ? ' (LSB)' : ''}
                  </th>
                ))}
                <th className="text-center">Hex</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: byteCount }, (_, byteIdx) => {
                const liveByte = liveFrame?.rawBytes[byteIdx];
                return (
                  <tr key={byteIdx}>
                    <td style={{ backgroundColor: 'var(--bg-row-alt)' }}>
                      <div className="pcan-cell text-[var(--text-secondary)]">
                        Byte {byteIdx}
                      </div>
                    </td>

                    {BIT_COLUMNS.map((bitInByte) => {
                      const coordKey = `${byteIdx}:${bitInByte}`;
                      const matchingCells = filteredCellsByCoord.get(coordKey) ?? [];
                      const globalBitNum = byteIdx * 8 + bitInByte;
                      const liveBitVal =
                        liveByte !== undefined ? (liveByte >>> bitInByte) & 1 : null;

                      if (matchingCells.length === 0) {
                        return (
                          <td key={bitInByte}>
                            <div className="pcan-cell pcan-cell-center text-[10px] text-[var(--text-muted)]">
                              <span>{globalBitNum}</span>
                              {liveBitVal !== null && (
                                <span className="ml-1.5 font-semibold">{liveBitVal}</span>
                              )}
                            </div>
                          </td>
                        );
                      }

                      const hoveredMatch =
                        hoveredSignalId !== null
                          ? matchingCells.find((c) => c.signalId === hoveredSignalId)
                          : undefined;
                      const selectedMatch =
                        dbState.selectedSignalId !== null
                          ? matchingCells.find(
                              (c) => c.signalId === dbState.selectedSignalId,
                            )
                          : undefined;
                      const primaryCell =
                        hoveredMatch ?? selectedMatch ?? matchingCells[0];
                      const sigSchema = dbState.signalsById[primaryCell.signalId];
                      const palette =
                        signalColorMap.get(primaryCell.signalId) ??
                        getSignalColor(primaryCell.signalId);
                      const isHighlighted =
                        hoveredSignalId === primaryCell.signalId ||
                        dbState.selectedSignalId === primaryCell.signalId;
                      const isSwitchCell =
                        primaryCell.isMuxSwitch || subSwitchIds.has(primaryCell.signalId);
                      const isSubSwitchCell = subSwitchIds.has(primaryCell.signalId);
                      const isConflictOverlay =
                        muxViewMode === 'overlay' && matchingCells.length > 1;

                      return (
                        <td
                          key={bitInByte}
                          onMouseEnter={() => setHoveredSignalId(primaryCell.signalId)}
                          onMouseLeave={() => setHoveredSignalId(null)}
                          onClick={() =>
                            databaseStore.selectSignalInSymbolsTab(
                              selectedMessage.messageKey,
                              primaryCell.signalId,
                            )
                          }
                          title={formatCellTooltip(byteIdx, bitInByte, matchingCells)}
                          className={`cursor-pointer ${
                            isHighlighted ? palette.bgActive : palette.bg
                          }`}
                        >
                          <div
                            className={`pcan-cell justify-between gap-1 text-[10px] ${
                              isSwitchCell
                                ? 'px-1 border border-dashed border-amber-500/80'
                                : ''
                            }`}
                          >
                            <span
                              className={`font-semibold truncate ${palette.text}`}
                            >
                              {sigSchema
                                ? sigSchema.name.slice(0, 8)
                                : `S${primaryCell.signalId}`}
                            </span>

                            {isConflictOverlay ? (
                              <span className="px-1 h-[14px] leading-[12px] text-[9px] font-bold border border-amber-500/60 bg-amber-500/20 text-amber-500 shrink-0">
                                MUX ×{matchingCells.length}
                              </span>
                            ) : isSwitchCell ? (
                              <span className="px-1 h-[14px] leading-[12px] text-[9px] font-bold bg-amber-500/20 text-amber-500 shrink-0">
                                {isSubSwitchCell ? 'Sub-M' : 'M'}
                              </span>
                            ) : (
                              <span className="text-[9px] text-[var(--text-secondary)] shrink-0">
                                {primaryCell.isMsb
                                  ? 'MSB'
                                  : primaryCell.isLsb
                                    ? 'LSB'
                                    : `b${primaryCell.signalBitIndex}`}
                              </span>
                            )}
                          </div>
                        </td>
                      );
                    })}

                    <td style={{ backgroundColor: 'var(--bg-row-alt)' }}>
                      <div className="pcan-cell pcan-cell-center">
                        {liveByte !== undefined ? formatByteHex(liveByte) : '—'}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Clean PCAN Symbol Editor Variables & Signals Table with Mux / Page Column */}
        <div style={{ borderColor: 'var(--border-strong)' }} className="border">
          {/* Table Subheader + Quick Mux Page Filter */}
          <div
            style={{
              backgroundColor: 'var(--bg-toolbar)',
              borderBottom: '1px solid var(--border-strong)',
            }}
            className="h-[26px] px-2 flex items-center justify-between text-[11px] select-none"
          >
            <span className="font-semibold text-[var(--text-secondary)]">
              Signals &amp; Variables ({displayedTableSignalIds.length} shown)
            </span>

            {selectedMessage.isMultiplexed && (
              <div className="flex items-center gap-1">
                <span className="text-[var(--text-muted)] mr-1">Show:</span>
                <button
                  type="button"
                  onClick={() => setSignalTableScope('all')}
                  style={{
                    backgroundColor:
                      signalTableScope === 'all' ? 'var(--bg-panel)' : 'transparent',
                    borderColor:
                      signalTableScope === 'all'
                        ? 'var(--border-strong)'
                        : 'transparent',
                    color:
                      signalTableScope === 'all'
                        ? 'var(--text-primary)'
                        : 'var(--text-secondary)',
                  }}
                  className="h-[20px] px-2 border font-medium cursor-pointer"
                >
                  All Signals ({selectedMessage.signalIds.length})
                </button>
                <button
                  type="button"
                  onClick={() => setSignalTableScope('activePage')}
                  style={{
                    backgroundColor:
                      signalTableScope === 'activePage'
                        ? 'var(--bg-panel)'
                        : 'transparent',
                    borderColor:
                      signalTableScope === 'activePage'
                        ? 'var(--border-strong)'
                        : 'transparent',
                    color:
                      signalTableScope === 'activePage'
                        ? 'var(--text-primary)'
                        : 'var(--text-secondary)',
                  }}
                  className="h-[20px] px-2 border font-medium cursor-pointer"
                >
                  Current Mux Page Only ({activeSignalIdsOnPage.size})
                </button>
              </div>
            )}
          </div>

          <table className="pcan-grid pcan-grid-fixed font-mono tabular-nums">
            <colgroup>
              <col />
              <col style={{ width: '195px' }} />
              <col style={{ width: '78px' }} />
              <col style={{ width: '104px' }} />
              <col style={{ width: '76px' }} />
              <col style={{ width: '96px' }} />
              <col style={{ width: '108px' }} />
              <col style={{ width: '112px' }} />
            </colgroup>
            <thead>
              <tr>
                <th className="font-sans">Signal Name</th>
                <th className="font-sans">Mux / Page</th>
                <th>Start | Len</th>
                <th className="font-sans">Byte Order</th>
                <th className="font-sans">Type</th>
                <th>Scale / Off</th>
                <th>Range</th>
                <th className="text-right">Live Value</th>
              </tr>
            </thead>
            <tbody>
              {displayedTableSignalIds.map((sigId) => {
                const sig = dbState.signalsById[sigId];
                if (!sig) return null;
                const palette = signalColorMap.get(sigId) ?? getSignalColor(sigId);
                const isHovered =
                  hoveredSignalId === sigId || dbState.selectedSignalId === sigId;
                const liveEntry = liveSignalsMap.get(sigId);
                const isSubSw = subSwitchIds.has(sigId);
                const parentSw =
                  sig.switchSignalId !== null
                    ? dbState.signalsById[sig.switchSignalId]
                    : undefined;
                const isActiveOnSelectedPage = activeSignalIdsOnPage.has(sigId);

                return (
                  <tr
                    key={sigId}
                    onMouseEnter={() => setHoveredSignalId(sigId)}
                    onMouseLeave={() => setHoveredSignalId(null)}
                    onClick={() =>
                      databaseStore.selectSignalInSymbolsTab(
                        selectedMessage.messageKey,
                        sig.signalId,
                      )
                    }
                    className={`group cursor-pointer ${isHovered ? palette.bgActive : ''}`}
                  >
                    <td>
                      <div className="pcan-cell justify-between gap-1 font-sans">
                        <div className="flex items-center min-w-0">
                          <span
                            className="inline-block w-2 h-2 mr-1.5 shrink-0"
                            style={{ backgroundColor: palette.hex }}
                          />
                          <span className="font-medium truncate" title={sig.name}>
                            {sig.name}
                          </span>
                        </div>
                        <QuickPlotButton
                          busId={liveFrame?.busId ?? 0}
                          signalId={sig.signalId}
                          hoverReveal
                          onToggle={() =>
                            plotStore.toggleSignal(liveFrame?.busId ?? 0, sig)
                          }
                        />
                      </div>
                    </td>

                    {/* Mux / Page Role & Branch Dependency */}
                    <td>
                      <div className="pcan-cell text-[11px]">
                        {sig.muxRole === 'masterSwitch' ? (
                          <span className="text-amber-500 font-semibold truncate">
                            Master Switch [M]
                          </span>
                        ) : isSubSw ? (
                          <span
                            className="text-amber-400 font-semibold truncate"
                            title={`Sub-Switch [m${formatMuxRanges(sig.muxRanges)} -> M] gated by ${parentSw?.name ?? 'Switch'}`}
                          >
                            Sub-Switch [m{formatMuxRanges(sig.muxRanges)} → M]
                          </span>
                        ) : sig.muxRole === 'multiplexed' ? (
                          <span
                            className="flex items-center gap-1 min-w-0"
                            title={`Active when ${parentSw?.name ?? 'Switch'} in [${formatMuxRanges(sig.muxRanges)}]`}
                          >
                            <span
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                isActiveOnSelectedPage
                                  ? 'bg-emerald-500'
                                  : 'bg-[var(--text-muted)] opacity-40'
                              }`}
                            />
                            <span className="text-sky-500 truncate">
                              Mux m{formatMuxRanges(sig.muxRanges)}
                              {parentSw ? ` (${parentSw.name})` : ''}
                            </span>
                          </span>
                        ) : (
                          <span className="text-[var(--text-muted)] font-sans">
                            Static
                          </span>
                        )}
                      </div>
                    </td>

                    <td>
                      <div className="pcan-cell">
                        {sig.startBit} | {sig.bitLength}
                      </div>
                    </td>

                    <td>
                      <div className="pcan-cell font-sans">
                        {sig.byteOrder === 'littleEndian' ? 'Intel (@1)' : 'Motorola (@0)'}
                      </div>
                    </td>

                    <td>
                      <div className="pcan-cell font-sans">{sig.valueType}</div>
                    </td>

                    <td>
                      <div className="pcan-cell">
                        <span className="truncate">
                          {sig.factor}, {sig.offset}
                        </span>
                      </div>
                    </td>

                    <td>
                      <div className="pcan-cell">
                        <span className="truncate">
                          [{sig.min}..{sig.max}]
                        </span>
                      </div>
                    </td>

                    <td>
                      <div className="pcan-cell pcan-cell-right">
                        {liveEntry !== undefined
                          ? `${formatPhysicalValue(liveEntry.phys, sig)}${
                              sig.unit ? ` ${sig.unit}` : ''
                            }`
                          : '—'}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
