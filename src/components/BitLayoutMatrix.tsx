import React, { useEffect, useMemo, useState } from 'react';
import { GitBranch, Layers, Radio, SlidersHorizontal } from 'lucide-react';
import { databaseStore, useDatabaseStore } from '../store/databaseStore';
import { plotStore } from '../store/plotStore';
import { useTelemetryFrames } from '../store/telemetryStore';
import { useI18n } from '../i18n';
import type { BitCellDto, MessageSchemaDto, SignalSchemaDto } from '../types/netdb';
import {
  formatByteHex,
  formatMuxRanges,
  formatPcanIdHex,
  formatPhysicalValue,
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

interface SignalPalette {
  bg: string;
  bgActive: string;
  text: string;
  solid: string;
}

function signalPalette(i: number): SignalPalette {
  const v = `var(--series-${(Math.abs(i) % 8) + 1})`;
  return {
    bg: `color-mix(in srgb, ${v} 12%, transparent)`,
    bgActive: `color-mix(in srgb, ${v} 28%, transparent)`,
    text: v,
    solid: v,
  };
}

const BIT_COLUMNS: readonly number[] = [7, 6, 5, 4, 3, 2, 1, 0];

function rangeContains(ranges: readonly [number, number][], val: number): boolean {
  for (const [start, end] of ranges) {
    if (val >= start && val <= end) return true;
  }
  return false;
}

export const BitLayoutMatrix: React.FC = () => {
  const { t } = useI18n();
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
    const map = new Map<number, SignalPalette>();
    if (!selectedMessage) return map;
    selectedMessage.signalIds.forEach((sigId, idx) => {
      map.set(sigId, signalPalette(idx));
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
        {t('netdb.matrix.noDbLoaded')}
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
          ? t('netdb.matrix.cascadedSubSwitchTooltip', { ranges: formatMuxRanges(c.muxRanges) })
          : t('netdb.matrix.masterSwitchTooltip')
        : c.isMultiplexed
          ? t('netdb.matrix.muxTooltip', { ranges: formatMuxRanges(c.muxRanges), parent: sw?.name ?? 'Switch' })
          : '';
      return `${s?.name ?? `Sig#${c.signalId}`}${muxDesc} · bit[${c.signalBitIndex}] (Byte ${byteIdx}, Bit ${bitInByte})`;
    }

    const lines = [
      t('netdb.matrix.sharedBitHeader', { byteIdx, bitInByte, count: cells.length }),
    ];
    for (const c of cells) {
      const s = dbState.signalsById[c.signalId];
      const sw = c.switchSignalId !== null ? dbState.signalsById[c.switchSignalId] : null;
      const cond = c.isMultiplexed
        ? `${sw?.name ?? 'Switch'} = m${formatMuxRanges(c.muxRanges)}`
        : t('netdb.matrix.staticOrMaster');
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
      {/* Slim 38px Matrix Header */}
      <div
        style={{
          backgroundColor: 'var(--bg-toolbar)',
          borderBottom: '1px solid var(--border-strong)',
        }}
        className="shrink-0 min-h-[38px] px-3 py-1 flex items-center justify-between gap-2 text-[12px] flex-wrap"
      >
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="font-semibold text-[var(--text-secondary)]">{t('netdb.matrix.symbolLabel')}</span>
          <select
            aria-label={t('netdb.matrix.selectSymbolAria')}
            value={selectedMessage.messageKey}
            onChange={(e) => databaseStore.setSelectedMessageKey(e.target.value)}
            style={{
              backgroundColor: 'var(--bg-input)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[28px] px-2 border font-mono text-[12px]"
          >
            {messages.map((m) => (
              <option key={m.messageKey} value={m.messageKey}>
                {formatPcanIdHex(m.arbId, m.isExtended)}h — {m.name} ({m.dlc}B)
                {m.isMultiplexed ? ' [MUX]' : ''}
              </option>
            ))}
          </select>

          <span className="font-mono text-[var(--text-muted)] truncate text-[12px]">
            {t('netdb.matrix.symbolMeta', {
              protocol: selectedMessage.protocol,
              dlc: selectedMessage.dlc,
              signals: selectedMessage.signalIds.length,
            })}
          </span>
        </div>

        {selectedMessage.isMultiplexed && (
          <span className="px-2 h-[22px] leading-[20px] text-[11px] font-mono font-bold border border-[var(--status-warn-border)] bg-[var(--status-warn-bg)] text-warn shrink-0">
            {subSwitchCount > 0 ? t('netdb.matrix.cascadedMuxBadge') : t('netdb.matrix.multiplexedBadge')}
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
          className="shrink-0 px-3 py-2 space-y-2 text-[12px] select-none"
        >
          {/* Row 1: Segmented Mux View Mode Control + Mux Summary Telemetry Strip */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[var(--text-secondary)] flex items-center gap-1">
                <GitBranch className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                <span>{t('netdb.matrix.muxLabel')}</span>
              </span>

              <div
                style={{ borderColor: 'var(--border-strong)' }}
                className="h-[26px] border inline-flex items-center overflow-hidden"
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
                  className="h-full px-2.5 flex items-center gap-1 font-medium cursor-pointer text-[12px]"
                  title={t('netdb.matrix.interactiveTitle')}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <span>{t('netdb.matrix.interactiveBtn')}</span>
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
                  className="h-full px-2.5 flex items-center gap-1 font-medium cursor-pointer text-[12px]"
                  title={t('netdb.matrix.liveBusTitle')}
                >
                  <Radio className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <span>{t('netdb.matrix.liveBusBtn')}</span>
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
                  className="h-full px-2.5 flex items-center gap-1 font-medium cursor-pointer text-[12px]"
                  title={t('netdb.matrix.overlayTitle')}
                >
                  <Layers className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <span>{t('netdb.matrix.overlayBtn')}</span>
                </button>
              </div>
            </div>

            {/* Mux Summary Strip */}
            <div className="flex items-center gap-3 font-mono tabular-nums text-[12px] text-[var(--text-secondary)] flex-wrap">
              <span>
                {t('netdb.matrix.summaryStatic')}{' '}
                <strong className="text-[var(--text-primary)]">{muxSummary.staticCount}</strong>
              </span>
              <span>
                {t('netdb.matrix.summarySwitches')}{' '}
                <strong className="text-warn">
                  {masterSwitchCount} M
                  {subSwitchCount > 0 ? ` + ${subSwitchCount} Sub-M` : ''}
                </strong>
              </span>
              <span>
                {t('netdb.matrix.summaryPage')}{' '}
                <strong className="text-[var(--text-primary)]">
                  {muxViewMode === 'overlay'
                    ? selectedMessage.signalIds.length
                    : activeSignalIdsOnPage.size}
                </strong>
                /{selectedMessage.signalIds.length}
              </span>
              <span>
                {t('netdb.matrix.summarySharedBits')}{' '}
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
                        ? 'pl-4 border-l-2 border-[var(--status-warn-border)]'
                        : ''
                    }`}
                  >
                    <span className="font-mono text-[11px] font-semibold text-warn">
                      {desc.isSubSwitch
                        ? t('netdb.matrix.levelSubSwitch', { level: desc.level + 1, ranges: formatMuxRanges(desc.signal.muxRanges) })
                        : t('netdb.matrix.levelMaster')}
                    </span>
                    <span
                      className="font-semibold text-[var(--text-primary)] mr-1"
                      title={
                        parentSw
                          ? t('netdb.matrix.activatedWhen', { parent: parentSw.name, ranges: formatMuxRanges(desc.signal.muxRanges) })
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
                              ? 'var(--status-warn-bg)'
                              : 'var(--bg-panel)',
                            borderColor: isSelected
                              ? 'var(--status-warn)'
                              : 'var(--border-strong)',
                            color: isSelected
                              ? 'var(--text-primary)'
                              : 'var(--text-secondary)',
                          }}
                          className={`h-[26px] px-2.5 border font-mono tabular-nums text-[11.5px] cursor-pointer ${
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
                <span className="font-sans text-[var(--text-muted)] text-[12px]">
                  {t('netdb.matrix.noLiveTraffic', { id: formatPcanIdHex(selectedMessage.arbId, selectedMessage.isExtended) })}
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
                      className={`px-2.5 py-1 border text-[12px] ${
                        isActiveSw ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
                      }`}
                    >
                      <span className="text-warn font-semibold mr-1">
                        {desc.isSubSwitch ? '[Sub-M]' : '[M]'}
                      </span>
                      {desc.signal.name} ={' '}
                      {isActiveSw && liveVal !== undefined ? (
                        <strong className="text-nominal">
                          m{liveVal}
                          {enumName ? ` (${enumName})` : ''}
                        </strong>
                      ) : (
                        <span>{t('netdb.matrix.inactive')}</span>
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
          data-tour="symbols.bit-grid"
          style={{ borderColor: 'var(--border-strong)' }}
          className="border overflow-x-auto"
        >
          <table className="pcan-grid pcan-grid-fixed font-mono tabular-nums select-none text-[12px]">
            <colgroup>
              <col style={{ width: '68px' }} />
              {BIT_COLUMNS.map((bitCol) => (
                <col key={bitCol} />
              ))}
              <col style={{ width: '58px' }} />
            </colgroup>
            <thead>
              <tr>
                <th>{t('netdb.matrix.thByte')}</th>
                {BIT_COLUMNS.map((bitCol) => (
                  <th key={bitCol} className="text-center">
                    {t('netdb.matrix.thBit', { bitCol })}
                    {bitCol === 7 ? ' (MSB)' : bitCol === 0 ? ' (LSB)' : ''}
                  </th>
                ))}
                <th className="text-center">{t('netdb.matrix.thHex')}</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: byteCount }, (_, byteIdx) => {
                const liveByte = liveFrame?.rawBytes[byteIdx];
                return (
                  <tr key={byteIdx}>
                    <td style={{ backgroundColor: 'var(--bg-row-alt)' }}>
                      <div className="pcan-cell text-[var(--text-secondary)] text-[12px]">
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
                            <div className="pcan-cell pcan-cell-center text-[11px] text-[var(--text-muted)]">
                              <span>{globalBitNum}</span>
                              {liveBitVal !== null && (
                                <span className="ml-1.5 font-semibold text-[var(--text-primary)]">{liveBitVal}</span>
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
                        signalPalette(primaryCell.signalId);
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
                          className="cursor-pointer"
                          style={{
                            backgroundColor: isHighlighted
                              ? palette.bgActive
                              : palette.bg,
                          }}
                        >
                          <div
                            className={`pcan-cell justify-between gap-1 text-[11px] ${
                              isSwitchCell
                                ? 'px-1 border border-dashed border-[var(--status-warn-border)]'
                                : ''
                            }`}
                          >
                            <span
                              className="font-semibold truncate text-[11.5px]"
                              style={{ color: palette.text }}
                            >
                              {sigSchema
                                ? sigSchema.name.slice(0, 10)
                                : `S${primaryCell.signalId}`}
                            </span>

                            {isConflictOverlay ? (
                              <span className="px-1.5 h-[16px] leading-[14px] text-[10px] font-bold border border-[var(--status-warn-border)] bg-[var(--status-warn-bg)] text-warn shrink-0">
                                MUX ×{matchingCells.length}
                              </span>
                            ) : isSwitchCell ? (
                              <span className="px-1.5 h-[16px] leading-[14px] text-[10px] font-bold bg-[var(--status-warn-bg)] text-warn shrink-0">
                                {isSubSwitchCell ? 'Sub-M' : 'M'}
                              </span>
                            ) : (
                              <span className="text-[10px] text-[var(--text-secondary)] shrink-0">
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
                      <div className="pcan-cell pcan-cell-center text-[12px]">
                        {liveByte !== undefined ? formatByteHex(liveByte) : '—'}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* DBC Studio Signals & Multiplexer Layout Table */}
        <div style={{ borderColor: 'var(--border-strong)' }} className="border">
          {/* Table Subheader + Quick Mux Page Filter */}
          <div
            style={{
              backgroundColor: 'var(--bg-toolbar)',
              borderBottom: '1px solid var(--border-strong)',
            }}
            className="min-h-[38px] px-3 py-1 flex items-center justify-between text-[12px] select-none flex-wrap gap-2"
          >
            <span className="font-semibold text-[var(--text-secondary)]">
              {t('netdb.matrix.signalsAndVars', { count: displayedTableSignalIds.length })}
            </span>

            {selectedMessage.isMultiplexed && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[var(--text-muted)] mr-1">{t('netdb.matrix.showFilter')}</span>
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
                  className="h-[28px] px-2.5 border font-medium cursor-pointer text-[12px]"
                >
                  {t('netdb.matrix.allSignals', { count: selectedMessage.signalIds.length })}
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
                  className="h-[28px] px-2.5 border font-medium cursor-pointer text-[12px]"
                >
                  {t('netdb.matrix.currentMuxPageOnly', { count: activeSignalIdsOnPage.size })}
                </button>
              </div>
            )}
          </div>

          <table className="pcan-grid pcan-grid-fixed font-mono tabular-nums text-[12px]">
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
                <th className="font-sans">{t('netdb.matrix.thSignalName')}</th>
                <th className="font-sans">{t('netdb.matrix.thMuxPage')}</th>
                <th>{t('netdb.matrix.thStartLen')}</th>
                <th className="font-sans">{t('netdb.matrix.thByteOrder')}</th>
                <th className="font-sans">{t('netdb.matrix.thType')}</th>
                <th>{t('netdb.matrix.thScaleOff')}</th>
                <th>{t('netdb.matrix.thRange')}</th>
                <th className="text-right">{t('netdb.matrix.thLiveValue')}</th>
              </tr>
            </thead>
            <tbody>
              {displayedTableSignalIds.map((sigId) => {
                const sig = dbState.signalsById[sigId];
                if (!sig) return null;
                const palette = signalColorMap.get(sigId) ?? signalPalette(sigId);
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
                    className="group cursor-pointer"
                    style={isHovered ? { backgroundColor: palette.bgActive } : undefined}
                  >
                    <td>
                      <div className="pcan-cell justify-between gap-1 font-sans">
                        <div className="flex items-center min-w-0">
                          <span
                            className="inline-block w-2 h-2 mr-1.5 shrink-0"
                            style={{ backgroundColor: palette.solid }}
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
                          <span className="text-warn font-semibold truncate">
                            {t('netdb.matrix.sigMasterSwitch')}
                          </span>
                        ) : isSubSw ? (
                          <span
                            className="text-warn font-semibold truncate"
                            title={`Sub-Switch [m${formatMuxRanges(sig.muxRanges)} -> M] gated by ${parentSw?.name ?? 'Switch'}`}
                          >
                            {t('netdb.matrix.sigSubSwitch', { ranges: formatMuxRanges(sig.muxRanges) })}
                          </span>
                        ) : sig.muxRole === 'multiplexed' ? (
                          <span
                            className="flex items-center gap-1 min-w-0"
                            title={`Active when ${parentSw?.name ?? 'Switch'} in [${formatMuxRanges(sig.muxRanges)}]`}
                          >
                            <span
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                isActiveOnSelectedPage
                                  ? 'bg-[var(--status-nominal-bg)]'
                                  : 'bg-[var(--text-muted)] opacity-40'
                              }`}
                            />
                            <span className="text-focus truncate">
                              Mux m{formatMuxRanges(sig.muxRanges)}
                              {parentSw ? ` (${parentSw.name})` : ''}
                            </span>
                          </span>
                        ) : (
                          <span className="text-[var(--text-muted)] font-sans">
                            {t('netdb.matrix.sigStatic')}
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
