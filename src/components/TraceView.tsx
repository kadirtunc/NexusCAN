import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Crosshair,
  Disc,
  Download,
  Filter,
  FolderOpen,
  Loader2,
  Minimize2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { databaseStore, useDatabaseStore } from '../store/databaseStore';
import { useConnectionStore } from '../store/connectionStore';
import { plotStore } from '../store/plotStore';
import {
  traceSessionsStore,
  useTraceSessionsStore,
} from '../store/traceSessionsStore';
import {
  MAX_CHRONO_BUFFER_ROWS,
  MIN_CHRONO_BUFFER_ROWS,
  useTelemetryHeader,
} from '../store/telemetryStore';
import { apiControlTraceReplay } from '../services/ipcClient';
import { workbenchStore } from '../store/workbenchStore';
import type {
  ChronologicalFrameDto,
  TraceReplayDirectionFilter,
  TraceReplayFilterMode,
} from '../types/telemetry';
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
import type { StatusBanner } from './TopBar';

const ROW_HEIGHT = 28;
const OVERSCAN = 14;

const BUFFER_PRESETS: readonly number[] = [
  1_000,
  5_000,
  10_000,
  25_000,
  50_000,
  100_000,
];

const SPEED_PRESETS: readonly number[] = [0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0];

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

function formatFilterMessageKey(arbId: number, isExtended: boolean): string {
  const prefix = isExtended ? 'EXT:0x' : 'STD:0x';
  const width = isExtended ? 8 : 3;
  return `${prefix}${arbId.toString(16).toUpperCase().padStart(width, '0')}`;
}

function parseFilterKey(key: string): { arbId: number; isExtended: boolean } {
  const isExtended = key.startsWith('EXT:');
  const hex = key.replace(/^(STD|EXT):0x?/i, '');
  const arbId = parseInt(hex, 16) || 0;
  return { arbId, isExtended };
}

function parseManualIdInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^(STD|EXT):0x[0-9A-Fa-f]+$/i.test(trimmed)) {
    const parts = trimmed.split(':0x');
    const hex = parts[1].toUpperCase();
    const isExt = parts[0].toUpperCase() === 'EXT';
    const padded = isExt ? hex.padStart(8, '0') : hex.padStart(3, '0');
    return `${parts[0].toUpperCase()}:0x${padded}`;
  }
  const cleanHex = trimmed.replace(/^0x/i, '');
  if (!/^[0-9A-Fa-f]+$/.test(cleanHex)) return null;
  const num = parseInt(cleanHex, 16);
  if (isNaN(num)) return null;
  const isExt = num > 0x7ff || cleanHex.length > 3;
  return formatFilterMessageKey(num, isExt);
}

interface RestbusMessageItem {
  messageKey: string;
  arbId: number;
  isExtended: boolean;
  name: string;
  senderEcu: string;
  count: number;
}

function formatReplayTime(us: number): string {
  const totalSec = Math.max(0, us / 1_000_000);
  const mm = Math.floor(totalSec / 60);
  const ss = (totalSec % 60).toFixed(3).padStart(6, '0');
  return `${String(mm).padStart(2, '0')}:${ss}`;
}

export interface TraceViewProps {
  sessionId?: string;
  onStatusMessage?: (msg: StatusBanner) => void;
}

export const TraceView: React.FC<TraceViewProps> = ({ sessionId, onStatusMessage }) => {
  const { t } = useI18n();
  const dbState = useDatabaseStore();
  const connState = useConnectionStore();
  const header = useTelemetryHeader();
  const traceState = useTraceSessionsStore();
  const sess = traceSessionsStore.getSession(sessionId);

  const availableBusIds = useMemo(() => {
    const ids = new Set<number>([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const p of connState.profiles) ids.add(p.busId);
    for (const b of header.buses) ids.add(b.busId);
    if (sess.busFilter !== null) ids.add(sess.busFilter);
    return Array.from(ids).sort((a, b) => a - b);
  }, [connState.profiles, header.buses, sess.busFilter]);

  const [filterQuery, setFilterQuery] = useState<string>('');
  const [dirFilter, setDirFilter] = useState<'ALL' | 'RX' | 'TX'>('ALL');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [showDecodedCol, setShowDecodedCol] = useState<boolean>(true);
  const [expandedUids, setExpandedUids] = useState<Set<number>>(() => new Set());
  const [customBufferText, setCustomBufferText] = useState<string>(
    String(sess.maxBufferRows),
  );

  // Replay Transport States
  const [replaySpeed, setReplaySpeed] = useState<number>(1.0);
  const [replayLoop, setReplayLoop] = useState<boolean>(false);
  const [replayBusOverride, setReplayBusOverride] = useState<number | null>(null);
  const [replayTxHardware, setReplayTxHardware] = useState<boolean>(false);
  const [followCursor, setFollowCursor] = useState<boolean>(true);

  // Simulation & Replay Faz-2 States: BLF export & Restbus Filter
  const [exportingBlf, setExportingBlf] = useState<boolean>(false);
  const [restbusFilterOpen, setRestbusFilterOpen] = useState<boolean>(false);
  const [restbusSearchQuery, setRestbusSearchQuery] = useState<string>('');
  const [manualIdInput, setManualIdInput] = useState<string>('');
  const [manualIdError, setManualIdError] = useState<string | null>(null);

  // Compact Header Popover Menus
  const [settingsMenuOpen, setSettingsMenuOpen] = useState<boolean>(false);
  const [exportMenuOpen, setExportMenuOpen] = useState<boolean>(false);
  const settingsMenuRef = useRef<HTMLDivElement | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!settingsMenuOpen && !exportMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (
        settingsMenuOpen &&
        settingsMenuRef.current &&
        !settingsMenuRef.current.contains(target)
      ) {
        setSettingsMenuOpen(false);
      }
      if (
        exportMenuOpen &&
        exportMenuRef.current &&
        !exportMenuRef.current.contains(target)
      ) {
        setExportMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', handleClickOutside);
    return () => window.removeEventListener('pointerdown', handleClickOutside);
  }, [settingsMenuOpen, exportMenuOpen]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [scrollTop, setScrollTop] = useState<number>(0);
  const [viewportHeight, setViewportHeight] = useState<number>(600);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setExpandedUids(new Set());
    setCustomBufferText(String(sess.maxBufferRows));
  }, [sess.id]);

  useEffect(() => {
    setCustomBufferText(String(sess.maxBufferRows));
  }, [sess.maxBufferRows]);

  const replay = header.replay;
  const isThisSessionReplaying =
    replay.state !== 'idle' &&
    (replay.sourceName === sess.name || traceState.replayingSessionId === sess.id);

  // Keep transport controls synchronized with active replay from backend
  useEffect(() => {
    if (replay.state !== 'idle') {
      setReplaySpeed(replay.speedFactor);
      setReplayLoop(replay.loopPlayback);
      setReplayBusOverride(replay.busOverride);
      setReplayTxHardware(replay.transmitToHardware);
    }
  }, [replay.state, replay.speedFactor, replay.loopPlayback, replay.busOverride, replay.transmitToHardware]);

  // Auto-scroll to follow cursor during active replay
  useEffect(() => {
    if (!followCursor || !isThisSessionReplaying) return;
    const currentIdx = replay.currentIndex;
    if (currentIdx < 0) return;
    const el = containerRef.current;
    if (!el) return;
    const targetScrollTop = Math.max(0, currentIdx * ROW_HEIGHT - viewportHeight / 2);
    if (Math.abs(el.scrollTop - targetScrollTop) > ROW_HEIGHT * 6) {
      el.scrollTop = targetScrollTop;
    }
  }, [followCursor, isThisSessionReplaying, replay.currentIndex, viewportHeight]);

  // Restbus & Replay Filter computations
  const filterMode = traceState.replayFilterMode;
  const filterKeys = traceState.replayFilterKeys;
  const directionFilter = traceState.replayDirectionFilter;
  const isFilterActive = filterMode !== 'all' || directionFilter !== 'all';

  const filterBadgeText = useMemo(() => {
    let text = t('trace.filter.badgeRestbus');
    if (filterMode === 'exclude') {
      text = t('trace.filter.badgeRestbusSilenced', { count: filterKeys.length });
    } else if (filterMode === 'include') {
      text = t('trace.filter.badgeInclude', { count: filterKeys.length });
    }
    if (directionFilter === 'rx') text += ' · Rx';
    else if (directionFilter === 'tx') text += ' · Tx';
    return text;
  }, [filterMode, filterKeys.length, directionFilter, t]);

  // Compute unique messages appearing in active trace or DBC schema
  const restbusTraceMessages = useMemo(() => {
    const map = new Map<string, RestbusMessageItem>();
    const ring = sess.displayRing;
    const len = ring.length;

    for (let i = 0; i < len; i++) {
      const f = ring.getAt(i);
      if (!f) continue;
      const msgKey = f.messageKey || formatFilterMessageKey(f.arbId, f.isExtended);
      const existing = map.get(msgKey);
      if (existing) {
        existing.count += 1;
      } else {
        const msgSchema = databaseStore.getMessageForBus(f.busId, f.messageKey, f.arbId, f.isExtended);
        const ecuStr =
          msgSchema?.transmitters?.[0] ??
          (msgSchema?.transmitters?.length ? msgSchema.transmitters.join(', ') : '—');
        map.set(msgKey, {
          messageKey: msgKey,
          arbId: f.arbId,
          isExtended: f.isExtended,
          name: msgSchema?.name ?? t('trace.table.unknownMessage'),
          senderEcu: ecuStr,
          count: 1,
        });
      }
    }

    if (dbState.schema?.messages) {
      for (const m of dbState.schema.messages) {
        if (!map.has(m.messageKey)) {
          const ecuStr =
            m.transmitters?.[0] ?? (m.transmitters?.length ? m.transmitters.join(', ') : '—');
          map.set(m.messageKey, {
            messageKey: m.messageKey,
            arbId: m.arbId,
            isExtended: m.isExtended,
            name: m.name,
            senderEcu: ecuStr,
            count: 0,
          });
        }
      }
    }

    for (const k of traceState.replayFilterKeys) {
      if (!map.has(k)) {
        const parsed = parseFilterKey(k);
        map.set(k, {
          messageKey: k,
          arbId: parsed.arbId,
          isExtended: parsed.isExtended,
          name: t('trace.table.manualFilterId'),
          senderEcu: '—',
          count: 0,
        });
      }
    }

    return Array.from(map.values()).sort((a, b) => a.arbId - b.arbId);
  }, [sess.displayRing, sess.version, dbState.schema, traceState.replayFilterKeys, t]);

  // Extract distinct ECU nodes
  const availableEcus = useMemo(() => {
    const ecuMap = new Map<string, { name: string; messageKeys: string[] }>();
    for (const item of restbusTraceMessages) {
      if (item.senderEcu && item.senderEcu !== '—') {
        const parts = item.senderEcu.split(',').map((s) => s.trim()).filter(Boolean);
        for (const p of parts) {
          let entry = ecuMap.get(p);
          if (!entry) {
            entry = { name: p, messageKeys: [] };
            ecuMap.set(p, entry);
          }
          if (!entry.messageKeys.includes(item.messageKey)) {
            entry.messageKeys.push(item.messageKey);
          }
        }
      }
    }
    return Array.from(ecuMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [restbusTraceMessages]);

  // Filter messages by search query
  const filteredRestbusMessages = useMemo(() => {
    const query = restbusSearchQuery.trim().toLowerCase();
    if (!query) return restbusTraceMessages;
    return restbusTraceMessages.filter((m) => {
      const idHex = formatPcanIdHex(m.arbId, m.isExtended).toLowerCase();
      const with0x = `0x${idHex}`;
      return (
        m.messageKey.toLowerCase().includes(query) ||
        idHex.includes(query) ||
        with0x.includes(query) ||
        m.name.toLowerCase().includes(query) ||
        m.senderEcu.toLowerCase().includes(query)
      );
    });
  }, [restbusTraceMessages, restbusSearchQuery]);

  // Target bus status check for Hardware TX safety badge
  const anyTargetDisarmed = useMemo(() => {
    if (replayBusOverride !== null) {
      const b = header.buses.find((bus) => bus.busId === replayBusOverride);
      return !b || b.listenOnly || !b.txArmed || header.txPanicLatched;
    }
    if (header.buses.length === 0) return true;
    return header.buses.some((b) => b.listenOnly || !b.txArmed) || header.txPanicLatched;
  }, [replayBusOverride, header.buses, header.txPanicLatched]);

  const handleToggleKey = (key: string) => {
    const currentKeys = new Set(traceState.replayFilterKeys);
    if (currentKeys.has(key)) {
      currentKeys.delete(key);
    } else {
      currentKeys.add(key);
    }
    const nextMode = traceState.replayFilterMode === 'all' ? 'include' : traceState.replayFilterMode;
    traceSessionsStore.setReplayFilterConfig({
      filterMode: nextMode,
      filterKeys: Array.from(currentKeys),
    });
  };

  const handleToggleEcu = (ecuKeys: string[]) => {
    const currentKeys = new Set(traceState.replayFilterKeys);
    const allSelected = ecuKeys.length > 0 && ecuKeys.every((k) => currentKeys.has(k));
    if (allSelected) {
      for (const k of ecuKeys) currentKeys.delete(k);
    } else {
      for (const k of ecuKeys) currentKeys.add(k);
    }
    const nextMode = traceState.replayFilterMode === 'all' ? 'exclude' : traceState.replayFilterMode;
    traceSessionsStore.setReplayFilterConfig({
      filterMode: nextMode,
      filterKeys: Array.from(currentKeys),
    });
  };

  const handleSelectAllVisible = () => {
    const currentKeys = new Set(traceState.replayFilterKeys);
    for (const m of filteredRestbusMessages) {
      currentKeys.add(m.messageKey);
    }
    const nextMode = traceState.replayFilterMode === 'all' ? 'include' : traceState.replayFilterMode;
    traceSessionsStore.setReplayFilterConfig({
      filterMode: nextMode,
      filterKeys: Array.from(currentKeys),
    });
  };

  const handleClearKeys = () => {
    traceSessionsStore.setReplayFilterConfig({
      filterKeys: [],
    });
  };

  const handleSetFilterMode = (mode: TraceReplayFilterMode) => {
    traceSessionsStore.setReplayFilterConfig({ filterMode: mode });
  };

  const handleSetDirectionFilter = (dir: TraceReplayDirectionFilter) => {
    traceSessionsStore.setReplayFilterConfig({ directionFilter: dir });
  };

  const handleAddManualId = () => {
    const normalized = parseManualIdInput(manualIdInput);
    if (!normalized) {
      setManualIdError(t('trace.filter.invalidCanId'));
      return;
    }
    setManualIdError(null);
    const currentKeys = new Set(traceState.replayFilterKeys);
    currentKeys.add(normalized);
    const nextMode = traceState.replayFilterMode === 'all' ? 'include' : traceState.replayFilterMode;
    traceSessionsStore.setReplayFilterConfig({
      filterMode: nextMode,
      filterKeys: Array.from(currentKeys),
    });
    setManualIdInput('');
  };

  const q = filterQuery.trim().toLowerCase();
  const isUnfiltered = q.length === 0 && dirFilter === 'ALL';

  // When unfiltered (99% case): ZERO array allocation! When filtered: compact Int32Array of ring indices.
  const filteredIndices: Int32Array | null = useMemo(() => {
    if (isUnfiltered) return null;

    const matches: number[] = [];
    const len = sess.count;
    for (let i = 0; i < len; i++) {
      const row = sess.displayRing.getAt(i);
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
    sess.version,
    sess.count,
    sess.displayRing,
    dirFilter,
    q,
    dbState.busSchemas,
  ]);

  const baseFrameCount = isUnfiltered
    ? sess.count
    : (filteredIndices?.length ?? 0);

  // Build O(K) sorted expanded anchors ONLY for frames the user actually expanded!
  const { expandedAnchors, totalExtraRows } = useMemo(() => {
    const anchors: ExpandedAnchor[] = [];
    if (expandedUids.size === 0 || baseFrameCount === 0) {
      return { expandedAnchors: anchors, totalExtraRows: 0 };
    }

    const baseSeq = sess.displayRing.baseSeq;
    const ringLen = sess.count;

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
      const frame = sess.displayRing.getAt(item.ringIdx);
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
    sess.version,
    sess.count,
    sess.displayRing,
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
    if (!autoScroll || sess.state !== 'recording') return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, totalVirtualRows * ROW_HEIGHT - el.clientHeight);
  }, [totalVirtualRows, autoScroll, sess.state]);

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
      const frame = sess.displayRing.getAt(ringIdx);
      if (!frame) return null;
      return { frame, frameUid: sess.displayRing.baseSeq + ringIdx };
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
    sess.version,
    sess.displayRing,
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
      traceSessionsStore.setSessionMaxBufferRows(sess.id, clamped);
      setCustomBufferText(String(clamped));
    } else {
      setCustomBufferText(String(sess.maxBufferRows));
    }
  };

  // Replay Transport Handlers
  const handleTogglePlayReplay = async (): Promise<void> => {
    try {
      if (replay.state === 'playing') {
        await apiControlTraceReplay({ action: 'pause' });
      } else if (replay.state === 'paused') {
        await apiControlTraceReplay({ action: 'resume' });
      } else {
        await traceSessionsStore.startSessionReplay(sess.id, {
          speedFactor: replaySpeed,
          loopPlayback: replayLoop,
          busOverride: replayBusOverride,
          transmitToHardware: replayTxHardware,
        });
        onStatusMessage?.({
          kind: 'info',
          message: t('trace.notify.replaying', { name: sess.name }),
        });
      }
    } catch (err) {
      onStatusMessage?.({
        kind: 'error',
        message: t('trace.notify.replayError', {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  };

  const handleStopReplay = async (): Promise<void> => {
    try {
      await apiControlTraceReplay({ action: 'stop' });
      traceSessionsStore.setReplayingSessionId(null);
      onStatusMessage?.({
        kind: 'info',
        message: t('trace.notify.replayStopped'),
      });
    } catch (err) {
      onStatusMessage?.({
        kind: 'error',
        message: t('trace.notify.stopError', {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  };

  const handleOpenLocalTraceFile = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const loaded = await traceSessionsStore.importTraceFileObject(file, false);
      onStatusMessage?.({
        kind: 'success',
        message: t('trace.notify.fileOpened', {
          fileName: file.name,
          count: loaded.count.toLocaleString('en-US'),
        }),
      });
    } catch (err) {
      onStatusMessage?.({
        kind: 'error',
        message: t('trace.notify.fileOpenError', {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  };

  const handleSaveToDisk = async (): Promise<void> => {
    try {
      const summary = await traceSessionsStore.saveSessionToDisk(sess.id, 'trc');
      onStatusMessage?.({
        kind: 'success',
        message: t('trace.notify.savedToDisk', {
          fileName: summary.fileName,
          filePath: summary.filePath,
        }),
      });
    } catch (err) {
      onStatusMessage?.({
        kind: 'error',
        message: t('trace.notify.saveError', {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  };

  const handlePlotTraceInPlotter = (): void => {
    const ring = sess.displayRing;
    const frames: ChronologicalFrameDto[] = [];
    for (let i = 0; i < ring.length; i++) {
      const f = ring.getAt(i);
      if (f) frames.push(f);
    }
    if (frames.length === 0) return;
    const count = plotStore.loadFromTraceFrames(
      frames,
      (bId) =>
        databaseStore.getBusSchema(bId) ??
        databaseStore.getState().schema ??
        databaseStore.getState().databases.find((d) => d.schema)?.schema ??
        null,
    );
    if (count === 0) {
      onStatusMessage?.({
        kind: 'error',
        message: t('trace.notify.noPlotSignals'),
      });
      return;
    }
    workbenchStore.setSplitSecondaryTab('plotter');
    onStatusMessage?.({
      kind: 'success',
      message: t('trace.notify.plotted', {
        name: sess.name,
        count: count.toLocaleString('en-US'),
      }),
    });
  };

  const gridTemplateClass = showDecodedCol
    ? 'grid-cols-[26px_96px_42px_46px_84px_175px_46px_44px_225px_1fr]'
    : 'grid-cols-[26px_96px_42px_46px_84px_190px_46px_48px_1fr]';

  const showReplayTransport =
    (sess.count > 0 && sess.state !== 'recording') || replay.state !== 'idle';

  // Static constants for virtual row hot path (60 FPS discipline)
  const strNoDecodedSignals = t('trace.table.noDecodedSignals');
  const strOutOfRange = t('trace.table.outOfRange');

  return (
    <div
      style={{ backgroundColor: 'var(--bg-panel)' }}
      className="flex flex-col flex-1 min-h-0 select-none"
    >
      {/* Hidden file input for opening .trc / .asc / .log / .csv / .blf from disk */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".trc,.asc,.log,.csv,.blf"
        onChange={(e) => void handleOpenLocalTraceFile(e)}
        className="hidden"
      />

      {/* Industrial 38px Trace Toolbar with Clean Sol / Orta / Sağ Groups — ZERO horizontal scroll! */}
      <div
        style={{
          backgroundColor: 'var(--bg-toolbar)',
          borderBottom: '1px solid var(--border-strong)',
        }}
        className="shrink-0 h-[38px] px-2.5 flex items-center justify-between gap-3 text-[11px] select-none"
      >
        {/* Sol Grup: Oturum, Kayıt Butonları, Temizle, Dosya Aç/Kaydet & Plotter */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Multi-Session Selector or Name Badge */}
          {traceState.sessions.length > 1 ? (
            <select
              aria-label={t('trace.toolbar.sessionAria')}
              value={sess.id}
              onChange={(e) => {
                const targetId = e.target.value;
                if (sessionId) {
                  workbenchStore.setSplitSecondaryTab('trace', targetId);
                } else {
                  traceSessionsStore.setActiveSession(targetId);
                  workbenchStore.setSelection({ kind: 'trace', sessionId: targetId });
                }
              }}
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              className="h-[28px] px-2 border text-[12px] font-semibold focus:outline-none shrink-0 rounded-xs cursor-pointer"
            >
              {traceState.sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.state === 'recording' ? '● ' : s.state === 'paused' ? '⏸ ' : '■ '}
                  {s.name} ({s.count.toLocaleString('en-US')})
                </option>
              ))}
            </select>
          ) : (
            <span
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              className="h-[28px] px-2.5 border flex items-center font-bold text-[12px] shrink-0 rounded-xs"
            >
              {sess.name}
            </span>
          )}

          {/* Record / Pause / Stop Controls */}
          {sess.state === 'recording' ? (
            <>
              <button
                type="button"
                onClick={() => traceSessionsStore.pauseRecording(sess.id)}
                style={{
                  backgroundColor: 'rgba(234, 179, 8, 0.15)',
                  borderColor: 'rgba(234, 179, 8, 0.45)',
                  color: '#FACC15',
                }}
                className="h-[28px] px-3 border flex items-center gap-1.5 text-[12px] font-semibold cursor-pointer shrink-0 hover:bg-yellow-500/25 rounded-xs"
                title={t('trace.toolbar.pauseTooltip')}
              >
                <Pause className="w-3.5 h-3.5" />
                <span>{t('trace.toolbar.pause')}</span>
              </button>
              <button
                type="button"
                onClick={() => traceSessionsStore.stopRecording(sess.id)}
                style={{
                  backgroundColor: 'rgba(239, 68, 68, 0.15)',
                  borderColor: 'rgba(239, 68, 68, 0.45)',
                  color: '#F87171',
                }}
                className="h-[28px] px-3 border flex items-center gap-1.5 text-[12px] font-semibold cursor-pointer shrink-0 hover:bg-red-500/25 rounded-xs"
                title={t('trace.toolbar.stopTooltip')}
              >
                <Square className="w-3 h-3 fill-current" />
                <span>{t('trace.toolbar.stop')}</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => traceSessionsStore.startRecording(sess.id, false)}
              style={{
                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                borderColor: 'rgba(239, 68, 68, 0.45)',
                color: '#F87171',
              }}
              className="h-[28px] px-3 border flex items-center gap-2 text-[12px] font-semibold cursor-pointer shrink-0 hover:bg-red-500/25 rounded-xs"
              title={sess.state === 'paused' ? t('trace.toolbar.resumeTooltip') : t('trace.toolbar.recordTooltip')}
            >
              <div className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse" />
              <span>{sess.state === 'paused' ? t('trace.toolbar.resume') : t('trace.toolbar.record')}</span>
            </button>
          )}

          {/* Temizle Button */}
          <button
            type="button"
            onClick={() => {
              setExpandedUids(new Set());
              traceSessionsStore.clearSession(sess.id);
            }}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[11px] font-medium cursor-pointer shrink-0 hover:text-red-400 hover:border-red-500/40 rounded-xs"
            title={t('trace.toolbar.clearTooltip')}
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{t('trace.toolbar.clear')}</span>
          </button>

          <div className="h-4 w-[1px] bg-[var(--border-strong)] mx-0.5 shrink-0" />

          {/* Open Trace from Disk (.trc/.asc/.log/.csv/.blf) */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[11px] font-medium hover:border-amber-400 cursor-pointer shrink-0 rounded-xs"
            title={t('trace.toolbar.openTooltip')}
          >
            <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
            <span>{t('trace.toolbar.open')}</span>
          </button>

          {/* Save to Workspace Disk (traces/) */}
          <button
            type="button"
            disabled={sess.count === 0}
            onClick={() => void handleSaveToDisk()}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: sess.savedFilePath && !sess.dirtySinceSave ? '#10B981' : 'var(--border-strong)',
              color: sess.savedFilePath && !sess.dirtySinceSave ? '#34D399' : 'var(--text-primary)',
            }}
            className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[11px] font-medium hover:border-emerald-500 cursor-pointer shrink-0 disabled:opacity-40 rounded-xs"
            title={
              sess.savedFilePath
                ? t('trace.toolbar.savedTooltip', {
                    path: sess.savedFilePath,
                    dirty: sess.dirtySinceSave ? '(Yeni veriler kaydedilmedi)' : '',
                  })
                : t('trace.toolbar.saveTooltip')
            }
          >
            {sess.savedFilePath && !sess.dirtySinceSave ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Save className="w-3.5 h-3.5 text-emerald-400" />
            )}
            <span>{sess.savedFilePath && !sess.dirtySinceSave ? t('trace.toolbar.saved') : t('trace.toolbar.save')}</span>
          </button>

          {/* Plot in Scope / Plotter */}
          <button
            type="button"
            disabled={sess.count === 0}
            onClick={handlePlotTraceInPlotter}
            style={{
              backgroundColor: 'rgba(56, 189, 248, 0.15)',
              borderColor: 'rgba(56, 189, 248, 0.45)',
              color: '#38BDF8',
            }}
            className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[11px] font-semibold hover:bg-sky-500/25 cursor-pointer shrink-0 disabled:opacity-40 rounded-xs"
            title={t('trace.toolbar.plotterTooltip')}
          >
            <Activity className="w-3.5 h-3.5 text-sky-400" />
            <span>{t('trace.toolbar.plotter')}</span>
          </button>
        </div>

        {/* Orta Grup: Hızlı Arama & Hat/Yön Filtresi */}
        <div className="flex items-center gap-1.5 min-w-0 flex-shrink">
          {/* Filter Query */}
          <div className="relative flex items-center min-w-0">
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder={t('trace.toolbar.filterPlaceholder')}
              style={{
                backgroundColor: 'var(--bg-input)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              className="h-[28px] w-36 xl:w-48 px-2 pr-6 border text-[11px] rounded-xs focus:outline-none focus:border-cyan-500"
            />
            {filterQuery && (
              <button
                type="button"
                onClick={() => setFilterQuery('')}
                className="absolute right-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Bus Filter */}
          <select
            aria-label="Bus Filter"
            value={sess.busFilter ?? 'ALL'}
            onChange={(e) => {
              const val = e.target.value === 'ALL' ? null : Number(e.target.value);
              traceSessionsStore.setSessionBusFilter(sess.id, val);
            }}
            style={{
              backgroundColor: 'var(--bg-input)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[28px] px-1.5 border text-[11px] rounded-xs focus:outline-none shrink-0 cursor-pointer"
            title="Trace kaydı için Bus filtresi"
          >
            <option value="ALL">{t('trace.toolbar.allBuses')}</option>
            {availableBusIds.map((id) => (
              <option key={id} value={id}>
                {t('trace.toolbar.busLabel', { bus: id + 1 })}
              </option>
            ))}
          </select>

          {/* Direction Filter */}
          <select
            aria-label="Direction Filter"
            value={dirFilter}
            onChange={(e) => setDirFilter(e.target.value as 'ALL' | 'RX' | 'TX')}
            style={{
              backgroundColor: 'var(--bg-input)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[28px] px-1.5 border text-[11px] rounded-xs focus:outline-none shrink-0 cursor-pointer"
            title="Yön Filtresi"
          >
            <option value="ALL">{t('trace.toolbar.dirAll')}</option>
            <option value="RX">{t('trace.toolbar.dirRx')}</option>
            <option value="TX">{t('trace.toolbar.dirTx')}</option>
          </select>
        </div>

        {/* Sağ Grup: Ayarlar ▾ ve Dışa Aktar ▾ Popover Menüleri */}
        <div className="flex items-center gap-1.5 shrink-0 relative">
          {/* Settings Popover Button */}
          <div ref={settingsMenuRef} className="relative">
            <button
              type="button"
              onClick={() => {
                setSettingsMenuOpen((prev) => !prev);
                setExportMenuOpen(false);
              }}
              style={{
                backgroundColor: settingsMenuOpen ? 'var(--bg-panel)' : 'var(--bg-panel)',
                borderColor: settingsMenuOpen ? '#38BDF8' : 'var(--border-strong)',
                color: settingsMenuOpen ? '#38BDF8' : 'var(--text-primary)',
              }}
              className="h-[28px] px-2.5 border rounded-xs flex items-center gap-1.5 text-[11px] font-medium hover:border-sky-500 cursor-pointer"
              title={t('trace.settings.tooltip')}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>{t('trace.settings.btn')}</span>
              <ChevronDown className={`w-3 h-3 transition-transform ${settingsMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            {settingsMenuOpen && (
              <div
                style={{
                  backgroundColor: '#0F1623',
                  borderColor: '#1E293B',
                }}
                className="absolute right-0 top-[32px] z-50 w-64 p-3 border shadow-2xl rounded-xs flex flex-col gap-2.5 text-[11px]"
              >
                <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  {t('trace.settings.viewOptions')}
                </div>

                <label className="flex items-center justify-between text-slate-200 cursor-pointer select-none">
                  <span>{t('trace.settings.autoScroll')}</span>
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(e) => setAutoScroll(e.target.checked)}
                    className="accent-sky-500 cursor-pointer"
                  />
                </label>

                <label className="flex items-center justify-between text-slate-200 cursor-pointer select-none">
                  <span>{t('trace.settings.showDecoded')}</span>
                  <input
                    type="checkbox"
                    checked={showDecodedCol}
                    onChange={(e) => setShowDecodedCol(e.target.checked)}
                    className="accent-emerald-500 cursor-pointer"
                  />
                </label>

                {expandedUids.size > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setExpandedUids(new Set());
                      setSettingsMenuOpen(false);
                    }}
                    className="w-full h-[26px] px-2 border border-slate-700 bg-slate-900/60 hover:bg-slate-800 text-slate-300 flex items-center justify-center gap-1.5 rounded-xs cursor-pointer text-[11px]"
                  >
                    <Minimize2 className="w-3 h-3" />
                    <span>{t('trace.settings.collapseRows', { count: expandedUids.size })}</span>
                  </button>
                )}

                <div className="border-t border-slate-800/80 my-0.5" />

                <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  {t('trace.settings.bufferCapacity')}
                </div>

                <div className="flex items-center gap-1.5">
                  <select
                    aria-label="Trace Buffer Preset Size"
                    value={
                      BUFFER_PRESETS.includes(sess.maxBufferRows)
                        ? String(sess.maxBufferRows)
                        : 'custom'
                    }
                    onChange={(e) => {
                      if (e.target.value !== 'custom') {
                        traceSessionsStore.setSessionMaxBufferRows(sess.id, Number(e.target.value));
                      }
                    }}
                    className="h-[24px] px-1.5 border font-mono tabular-nums text-[11px] bg-slate-900 border-slate-700 text-slate-200 rounded-xs flex-1 focus:outline-none"
                  >
                    {BUFFER_PRESETS.map((sz) => (
                      <option key={sz} value={sz}>
                        {t('trace.settings.bufferPreset', { count: sz.toLocaleString('en-US') })}
                      </option>
                    ))}
                    {!BUFFER_PRESETS.includes(sess.maxBufferRows) && (
                      <option value="custom">{t('trace.settings.customSize')}</option>
                    )}
                  </select>

                  <input
                    type="number"
                    aria-label="Custom Trace Buffer Rows"
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
                    className="h-[24px] w-20 px-1.5 border font-mono tabular-nums text-[11px] text-right bg-slate-900 border-slate-700 text-slate-200 rounded-xs focus:outline-none"
                    title={t('trace.settings.customBufferTooltip')}
                  />
                </div>

                <div className="border-t border-slate-800/80 my-0.5" />

                {/* Spawn New Trace Action */}
                <button
                  type="button"
                  onClick={() => {
                    const created = traceSessionsStore.spawnNewTraceSession({ autoStart: true });
                    setSettingsMenuOpen(false);
                    if (sessionId) {
                      workbenchStore.setSplitSecondaryTab('trace', created.id);
                    } else {
                      workbenchStore.setSelection({ kind: 'trace', sessionId: created.id });
                    }
                    onStatusMessage?.({
                      kind: 'info',
                      message: t('trace.notify.sessionSpawned', { name: created.name }),
                    });
                  }}
                  className="w-full h-[26px] px-2 border border-sky-600/50 bg-sky-950/40 hover:bg-sky-900/50 text-sky-300 font-medium text-[11px] flex items-center justify-center gap-1.5 rounded-xs cursor-pointer transition-colors"
                >
                  <Plus className="w-3.5 h-3.5 text-sky-400" />
                  <span>{t('trace.settings.newSession')}</span>
                </button>
              </div>
            )}
          </div>

          {/* Export Popover Button */}
          <div ref={exportMenuRef} className="relative">
            <button
              type="button"
              disabled={sess.count === 0}
              onClick={() => {
                setExportMenuOpen((prev) => !prev);
                setSettingsMenuOpen(false);
              }}
              style={{
                backgroundColor: exportMenuOpen ? 'var(--bg-panel)' : 'var(--bg-panel)',
                borderColor: exportMenuOpen ? '#A855F7' : 'var(--border-strong)',
                color: exportMenuOpen ? '#C084FC' : 'var(--text-primary)',
              }}
              className="h-[28px] px-2.5 border rounded-xs flex items-center gap-1.5 text-[11px] font-medium hover:border-purple-500 cursor-pointer disabled:opacity-40"
              title={t('trace.export.tooltip')}
            >
              <Download className="w-3.5 h-3.5" />
              <span>{t('trace.export.btn')}</span>
              <ChevronDown className={`w-3 h-3 transition-transform ${exportMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            {exportMenuOpen && (
              <div
                style={{
                  backgroundColor: '#0F1623',
                  borderColor: '#1E293B',
                }}
                className="absolute right-0 top-[32px] z-50 w-60 p-1.5 border shadow-2xl rounded-xs flex flex-col gap-1 text-[11px]"
              >
                <div className="px-2 py-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  {t('trace.export.formatTitle')}
                </div>

                {/* .blf */}
                <button
                  type="button"
                  disabled={exportingBlf}
                  onClick={async () => {
                    setExportMenuOpen(false);
                    try {
                      setExportingBlf(true);
                      const name = await traceSessionsStore.exportSessionToBlf(sess.id);
                      onStatusMessage?.({
                        kind: 'info',
                        message: t('trace.notify.blfExported', { name }),
                      });
                    } catch (err) {
                      onStatusMessage?.({
                        kind: 'error',
                        message: t('trace.notify.saveError', {
                          error: err instanceof Error ? err.message : String(err),
                        }),
                      });
                    } finally {
                      setExportingBlf(false);
                    }
                  }}
                  className="w-full text-left px-2.5 py-1.5 rounded-xs hover:bg-purple-950/40 text-purple-300 font-mono text-[11px] flex items-center justify-between border border-transparent hover:border-purple-500/40 cursor-pointer"
                >
                  <span>{t('trace.export.blf')}</span>
                  {exportingBlf ? (
                    <Loader2 className="w-3 h-3 animate-spin text-purple-300" />
                  ) : (
                    <span className="text-[9px] px-1 py-0.2 bg-purple-500/20 text-purple-300 font-bold rounded-xs border border-purple-500/30">
                      BLF
                    </span>
                  )}
                </button>

                {/* .trc */}
                <button
                  type="button"
                  onClick={() => {
                    setExportMenuOpen(false);
                    const name = traceSessionsStore.exportSessionToFile(sess.id, 'trc');
                    onStatusMessage?.({ kind: 'info', message: t('trace.notify.exported', { name }) });
                  }}
                  className="w-full text-left px-2.5 py-1.5 rounded-xs hover:bg-slate-800/80 text-slate-200 font-mono text-[11px] flex items-center justify-between border border-transparent hover:border-slate-700 cursor-pointer"
                >
                  <span>{t('trace.export.trc')}</span>
                  <span className="text-[9px] px-1 py-0.2 bg-slate-800 text-slate-300 font-bold rounded-xs border border-slate-700">
                    TRC
                  </span>
                </button>

                {/* .asc */}
                <button
                  type="button"
                  onClick={() => {
                    setExportMenuOpen(false);
                    const name = traceSessionsStore.exportSessionToFile(sess.id, 'asc');
                    onStatusMessage?.({ kind: 'info', message: t('trace.notify.exported', { name }) });
                  }}
                  className="w-full text-left px-2.5 py-1.5 rounded-xs hover:bg-slate-800/80 text-slate-200 font-mono text-[11px] flex items-center justify-between border border-transparent hover:border-slate-700 cursor-pointer"
                >
                  <span>{t('trace.export.asc')}</span>
                  <span className="text-[9px] px-1 py-0.2 bg-slate-800 text-slate-300 font-bold rounded-xs border border-slate-700">
                    ASC
                  </span>
                </button>

                {/* .csv */}
                <button
                  type="button"
                  onClick={() => {
                    setExportMenuOpen(false);
                    const name = traceSessionsStore.exportSessionToFile(sess.id, 'csv');
                    onStatusMessage?.({ kind: 'info', message: t('trace.notify.exported', { name }) });
                  }}
                  className="w-full text-left px-2.5 py-1.5 rounded-xs hover:bg-slate-800/80 text-slate-200 font-mono text-[11px] flex items-center justify-between border border-transparent hover:border-slate-700 cursor-pointer"
                >
                  <span>{t('trace.export.csv')}</span>
                  <span className="text-[9px] px-1 py-0.2 bg-slate-800 text-slate-300 font-bold rounded-xs border border-slate-700">
                    CSV
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* PCAN-Style Trace Replay Transport Bar — Responsive min-h-[40px], flex-wrap, zero-overflow */}
      {showReplayTransport && (
        <div
          style={{
            backgroundColor: '#0F1623',
            borderBottom: '1px solid var(--border-strong)',
          }}
          className="shrink-0 min-h-[40px] py-1 px-3 flex items-center justify-between gap-3 text-[12px] select-none flex-wrap"
        >
          {/* Transport Left: Play / Pause / Stop / Loop / Restbus Filter */}
          <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
            <button
              type="button"
              onClick={() => void handleTogglePlayReplay()}
              style={{
                backgroundColor: replay.state === 'playing' ? 'rgba(234, 179, 8, 0.20)' : 'rgba(6, 182, 212, 0.20)',
                borderColor: replay.state === 'playing' ? '#FACC15' : '#22D3EE',
                color: replay.state === 'playing' ? '#FDE047' : '#67E8F9',
              }}
              className="h-[28px] px-3 border font-semibold flex items-center gap-1.5 cursor-pointer rounded-xs hover:opacity-90 text-[12px]"
              title={
                replay.state === 'playing'
                  ? t('trace.replay.pauseTooltip')
                  : replay.state === 'paused'
                    ? t('trace.replay.resumeTooltip')
                    : t('trace.replay.startTooltip')
              }
            >
              {replay.state === 'playing' ? (
                <>
                  <Pause className="w-3.5 h-3.5" />
                  <span>{t('trace.replay.pause')}</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>{replay.state === 'paused' ? t('trace.replay.resume') : t('trace.replay.replay')}</span>
                </>
              )}
            </button>

            {replay.state !== 'idle' && (
              <button
                type="button"
                onClick={() => void handleStopReplay()}
                style={{
                  backgroundColor: 'rgba(239, 68, 68, 0.18)',
                  borderColor: '#EF4444',
                  color: '#F87171',
                }}
                className="h-[28px] px-2.5 border font-semibold flex items-center gap-1.5 cursor-pointer rounded-xs hover:opacity-90 text-[12px]"
                title={t('trace.replay.stopTooltip')}
              >
                <Square className="w-3 h-3 fill-current" />
                <span>{t('trace.replay.stop')}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                const next = !replayLoop;
                setReplayLoop(next);
                if (replay.state !== 'idle') {
                  void apiControlTraceReplay({ action: 'configure', loopPlayback: next });
                }
              }}
              style={{
                backgroundColor: replayLoop ? 'rgba(168, 85, 247, 0.20)' : 'var(--bg-panel)',
                borderColor: replayLoop ? '#A855F7' : 'var(--border-strong)',
                color: replayLoop ? '#C084FC' : 'var(--text-secondary)',
              }}
              className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[11.5px] font-semibold cursor-pointer rounded-xs hover:text-[var(--text-primary)]"
              title={t('trace.replay.loopTooltip')}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{t('trace.replay.loop')}</span>
            </button>

            {/* Restbus Filter Drawer Toggle Button */}
            <button
              type="button"
              onClick={() => setRestbusFilterOpen((prev) => !prev)}
              style={{
                backgroundColor: isFilterActive
                  ? filterMode === 'exclude'
                    ? 'rgba(245, 158, 11, 0.20)'
                    : 'rgba(6, 182, 212, 0.20)'
                  : restbusFilterOpen
                    ? 'var(--bg-toolbar)'
                    : 'var(--bg-panel)',
                borderColor: isFilterActive
                  ? filterMode === 'exclude'
                    ? '#F59E0B'
                    : '#06B6D4'
                  : restbusFilterOpen
                    ? 'var(--border-strong)'
                    : 'var(--border-strong)',
                color: isFilterActive
                  ? filterMode === 'exclude'
                    ? '#FDE047'
                    : '#67E8F9'
                  : 'var(--text-secondary)',
              }}
              className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[11.5px] font-semibold cursor-pointer rounded-xs hover:text-[var(--text-primary)]"
              title={t('trace.replay.filterDrawerTooltip')}
            >
              <Filter className="w-3.5 h-3.5" />
              <span>{filterBadgeText}</span>
              <ChevronDown
                className={`w-3.5 h-3.5 transition-transform ${
                  restbusFilterOpen ? 'rotate-180 text-cyan-400' : ''
                }`}
              />
            </button>
          </div>

          {/* Transport Center: Scrubber Slider, Time & Compact Counters */}
          <div className="flex-1 min-w-0 max-w-2xl flex items-center gap-2.5">
            <span className="font-mono tabular-nums text-[12px] text-cyan-300 font-semibold shrink-0">
              {formatReplayTime(replay.elapsedUs)} /{' '}
              {formatReplayTime(replay.durationUs || (sess.lastTimestampUs - sess.originTimestampUs))}
            </span>

            <input
              type="range"
              aria-label="Replay Scrubber"
              min={0}
              max={Math.max(1, replay.durationUs || (sess.lastTimestampUs - sess.originTimestampUs) || 1)}
              value={replay.elapsedUs || 0}
              onChange={(e) => {
                const seekUs = Number(e.target.value);
                void apiControlTraceReplay({ action: 'seek', seekUs });
              }}
              className="flex-1 h-2 accent-cyan-400 cursor-pointer min-w-[80px]"
            />

            {/* Compact Live Replay Counters */}
            <div className="flex items-center gap-2 font-mono tabular-nums text-[11px] shrink-0">
              <span className="text-[var(--text-secondary)]">
                {t('trace.replay.framesCount')}{' '}
                <strong className="text-cyan-300">
                  {(
                    replay.dispatchedFrames ??
                    (replay.currentIndex >= 0 ? replay.currentIndex + 1 : 0)
                  ).toLocaleString('en-US')}
                </strong>
                /{' '}
                {(replay.totalFrames || sess.count).toLocaleString('en-US')}
              </span>
              {(isFilterActive || (replay.filteredOutFrames ?? 0) > 0) && (
                <span className="text-amber-400">
                  {t('trace.replay.filteredCount')}{' '}
                  <strong className="text-amber-300">
                    {(replay.filteredOutFrames ?? 0).toLocaleString('en-US')}
                  </strong>
                </span>
              )}
              {replayTxHardware && (
                <span className="text-emerald-400">
                  {t('trace.replay.hwCount')}{' '}
                  <strong className="text-emerald-300">
                    {(replay.hwTxFrames ?? 0).toLocaleString('en-US')}
                  </strong>
                </span>
              )}
            </div>
          </div>

          {/* Transport Right: Speed, Target Bus, Compact Cursor, HW TX & Safety Badge */}
          <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
            {/* Speed Selector */}
            <div className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)]">
              <span>{t('trace.replay.speed')}</span>
              <select
                aria-label="Replay Hızı"
                value={replaySpeed}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setReplaySpeed(val);
                  if (replay.state !== 'idle') {
                    void apiControlTraceReplay({ action: 'configure', speedFactor: val });
                  }
                }}
                style={{
                  backgroundColor: 'var(--bg-input)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-primary)',
                }}
                className="h-[28px] px-1.5 border font-mono tabular-nums text-[11.5px] rounded-xs focus:outline-none"
              >
                {SPEED_PRESETS.map((sp) => (
                  <option key={sp} value={sp}>
                    {sp.toFixed(sp < 1 ? 2 : 1)}x
                  </option>
                ))}
              </select>
            </div>

            {/* Target Bus Override */}
            <div className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)]">
              <span>{t('trace.replay.bus')}</span>
              <select
                aria-label="Replay Hedef Hat"
                value={replayBusOverride ?? 'orig'}
                onChange={(e) => {
                  const val = e.target.value === 'orig' ? null : Number(e.target.value);
                  setReplayBusOverride(val);
                  if (replay.state !== 'idle') {
                    void apiControlTraceReplay({
                      action: 'configure',
                      updateBusOverride: true,
                      busOverride: val,
                    });
                  }
                }}
                style={{
                  backgroundColor: 'var(--bg-input)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-primary)',
                }}
                className="h-[28px] px-1.5 border text-[11.5px] rounded-xs focus:outline-none"
                title="Orijinal: Kayıttaki bus_id kullanılır. Seçilirse tüm paketler seçilen hatta yönlendirilir."
              >
                <option value="orig">{t('trace.replay.origBus')}</option>
                {availableBusIds.map((id) => (
                  <option key={id} value={id}>
                    {t('trace.toolbar.busLabel', { bus: id + 1 })}
                  </option>
                ))}
              </select>
            </div>

            {/* Follow Cursor Toggle - Compact */}
            <button
              type="button"
              onClick={() => setFollowCursor(!followCursor)}
              style={{
                backgroundColor: followCursor ? 'rgba(34, 211, 238, 0.15)' : 'var(--bg-panel)',
                borderColor: followCursor ? '#22D3EE' : 'var(--border-strong)',
                color: followCursor ? '#67E8F9' : 'var(--text-secondary)',
              }}
              className="h-[28px] px-2 border flex items-center gap-1 text-[11px] font-semibold cursor-pointer rounded-xs"
              title={t('trace.replay.cursorTooltip')}
            >
              <Crosshair className="w-3.5 h-3.5" />
              <span>{t('trace.replay.cursor')}</span>
            </button>

            {/* Hardware TX Checkbox */}
            <label
              className="flex items-center gap-1 px-1.5 text-[11px] text-amber-400 font-semibold cursor-pointer shrink-0"
              title={t('trace.replay.hwTxTooltip')}
            >
              <input
                type="checkbox"
                checked={replayTxHardware}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setReplayTxHardware(checked);
                  if (replay.state !== 'idle') {
                    void apiControlTraceReplay({
                      action: 'configure',
                      transmitToHardware: checked,
                    });
                  }
                }}
                className="accent-amber-500 cursor-pointer"
              />
              <span className="flex items-center gap-1">
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                <span>{t('trace.replay.hwTx')}</span>
              </span>
            </label>

            {/* Compact Hardware Safety Badge */}
            {replayTxHardware && (
              anyTargetDisarmed ? (
                <div
                  className="flex items-center gap-1 px-2 h-[26px] rounded-xs text-[11px] font-semibold font-mono bg-amber-950/80 border border-amber-500/70 text-amber-300 shrink-0"
                  title={t('trace.replay.txDisarmedBadgeTooltip')}
                >
                  <span>{t('trace.replay.txDisarmedBadge')}</span>
                </div>
              ) : (
                <div
                  className="flex items-center gap-1 px-2 h-[26px] rounded-xs text-[11px] font-semibold font-mono bg-emerald-950/80 border border-emerald-500/70 text-emerald-300 shrink-0"
                  title={t('trace.replay.activeTxBadgeTooltip')}
                >
                  <span className="text-red-400 animate-pulse font-bold">⚡</span>
                  <span>
                    {replayBusOverride !== null ? `CAN${replayBusOverride + 1}` : 'CAN'}{' '}
                    {t('trace.replay.activeTxBadge')}
                  </span>
                </div>
              )
            )}
          </div>
        </div>
      )}

      {/* Restbus ID & ECU Filter Console Panel (Industrial Drawer) */}
      {showReplayTransport && restbusFilterOpen && (
        <div
          style={{
            backgroundColor: '#0B0F17',
            borderBottom: '1px solid var(--border-strong)',
          }}
          className="shrink-0 p-2.5 flex flex-col gap-2 text-[11px] select-none"
        >
          {/* Top Row: Mode Tabs & Direction Filter */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* Mode Selection */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] font-semibold text-slate-400 mr-1 uppercase tracking-wider">
                {t('trace.restbus.modeLabel')}
              </span>
              <button
                type="button"
                onClick={() => handleSetFilterMode('all')}
                className={`h-[28px] px-3 text-[12px] border rounded-xs transition-colors cursor-pointer ${
                  filterMode === 'all'
                    ? 'bg-slate-800 border-slate-600 text-slate-100 font-semibold'
                    : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {t('trace.restbus.modeAll')}
              </button>
              <button
                type="button"
                onClick={() => handleSetFilterMode('include')}
                className={`h-[28px] px-3 text-[12px] border rounded-xs transition-colors cursor-pointer ${
                  filterMode === 'include'
                    ? 'bg-cyan-950/80 border-cyan-500 text-cyan-300 font-semibold'
                    : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
                title={t('trace.restbus.includeTitle')}
              >
                {t('trace.restbus.modeInclude')}
              </button>
              <button
                type="button"
                onClick={() => handleSetFilterMode('exclude')}
                className={`h-[28px] px-3 text-[12px] border rounded-xs transition-colors cursor-pointer ${
                  filterMode === 'exclude'
                    ? 'bg-amber-950/80 border-amber-500 text-amber-300 font-semibold'
                    : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
                title={t('trace.restbus.excludeTitle')}
              >
                {t('trace.restbus.modeExclude')}
              </button>
            </div>

            {/* Direction Filter */}
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-slate-400 font-semibold uppercase tracking-wider mr-1">
                {t('trace.restbus.dirLabel')}
              </span>
              <div className="flex border border-slate-800 rounded-xs overflow-hidden">
                <button
                  type="button"
                  onClick={() => handleSetDirectionFilter('all')}
                  className={`px-2.5 h-[26px] font-mono cursor-pointer ${
                    directionFilter === 'all'
                      ? 'bg-slate-800 text-slate-100 font-semibold'
                      : 'bg-slate-900/60 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t('trace.restbus.dirAll')}
                </button>
                <button
                  type="button"
                  onClick={() => handleSetDirectionFilter('rx')}
                  className={`px-2.5 h-[26px] font-mono border-l border-slate-800 cursor-pointer ${
                    directionFilter === 'rx'
                      ? 'bg-cyan-950 text-cyan-300 font-semibold'
                      : 'bg-slate-900/60 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t('trace.restbus.dirRx')}
                </button>
                <button
                  type="button"
                  onClick={() => handleSetDirectionFilter('tx')}
                  className={`px-2.5 h-[26px] font-mono border-l border-slate-800 cursor-pointer ${
                    directionFilter === 'tx'
                      ? 'bg-amber-950 text-amber-300 font-semibold'
                      : 'bg-slate-900/60 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t('trace.restbus.dirTx')}
                </button>
              </div>
            </div>
          </div>

          {/* Mode Explanatory Notice */}
          <div className="text-[11px] text-slate-400 font-sans px-2.5 py-1.5 rounded-xs bg-slate-900/80 border border-slate-800/80 flex items-center justify-between">
            <span>
              {filterMode === 'all' && t('trace.restbus.descAll')}
              {filterMode === 'include' && (
                <span className="text-cyan-300 font-medium">
                  {t('trace.restbus.descInclude', { count: filterKeys.length })}
                </span>
              )}
              {filterMode === 'exclude' && (
                <span className="text-amber-300 font-medium">
                  {t('trace.restbus.descExclude', { count: filterKeys.length })}
                </span>
              )}
            </span>
            <span className="font-mono text-[10px] text-slate-500">
              {t('trace.restbus.liveUpdate')}
            </span>
          </div>

          {/* DBC ECU Node Quick Select Chips */}
          {availableEcus.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <span className="text-[11px] font-semibold text-slate-400 mr-0.5 uppercase tracking-wider">
                {t('trace.restbus.ecuQuickSelect')}
              </span>
              {availableEcus.map((ecu) => {
                const currentKeys = new Set(traceState.replayFilterKeys);
                const selectedCount = ecu.messageKeys.filter((k) => currentKeys.has(k)).length;
                const allSelected = selectedCount === ecu.messageKeys.length && ecu.messageKeys.length > 0;
                const partialSelected = selectedCount > 0 && !allSelected;

                return (
                  <button
                    key={ecu.name}
                    type="button"
                    onClick={() => handleToggleEcu(ecu.messageKeys)}
                    className={`h-[25px] px-2.5 text-[11px] font-mono rounded-xs border flex items-center gap-1.5 transition-colors cursor-pointer ${
                      allSelected
                        ? filterMode === 'exclude'
                          ? 'bg-amber-950/80 border-amber-500 text-amber-300 font-semibold'
                          : 'bg-cyan-950/80 border-cyan-500 text-cyan-300 font-semibold'
                        : partialSelected
                          ? 'bg-slate-800/80 border-dashed border-amber-500/70 text-amber-200'
                          : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                    }`}
                    title={t('trace.restbus.ecuTooltip', {
                      name: ecu.name,
                      count: ecu.messageKeys.length,
                    })}
                  >
                    <span>{ecu.name}</span>
                    <span className="text-[10px] opacity-75 tabular-nums">
                      ({selectedCount}/{ecu.messageKeys.length})
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Search & Actions Bar */}
          <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-800/80 flex-wrap">
            <div className="flex items-center gap-1.5 flex-1 min-w-0 max-w-md">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 absolute left-2 top-2 text-slate-500" />
                <input
                  type="text"
                  placeholder={t('trace.restbus.searchPlaceholder')}
                  value={restbusSearchQuery}
                  onChange={(e) => setRestbusSearchQuery(e.target.value)}
                  className="w-full h-[28px] pl-7 pr-2 text-[12px] bg-slate-950 border border-slate-800 rounded-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500 font-sans"
                />
              </div>
              <button
                type="button"
                onClick={handleSelectAllVisible}
                className="h-[28px] px-2.5 text-[11.5px] font-medium bg-slate-900 border border-slate-800 text-slate-300 rounded-xs hover:border-slate-700 cursor-pointer shrink-0"
              >
                {t('trace.restbus.selectAll')}
              </button>
              <button
                type="button"
                onClick={handleClearKeys}
                disabled={filterKeys.length === 0}
                className="h-[28px] px-2.5 text-[11.5px] font-medium bg-slate-900 border border-slate-800 text-slate-400 rounded-xs hover:text-rose-400 hover:border-rose-900/50 cursor-pointer disabled:opacity-40 shrink-0"
              >
                {t('trace.restbus.clear')}
              </button>
            </div>

            {/* Manual ID Input */}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[11px] text-slate-400 font-semibold">
                {t('trace.restbus.manualIdLabel')}
              </span>
              <input
                type="text"
                placeholder={t('trace.restbus.manualIdPlaceholder')}
                value={manualIdInput}
                onChange={(e) => {
                  setManualIdInput(e.target.value);
                  if (manualIdError) setManualIdError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddManualId();
                }}
                className={`h-[28px] w-[180px] px-2 text-[12px] font-mono tabular-nums bg-slate-950 border rounded-xs text-slate-200 placeholder:text-slate-600 focus:outline-none ${
                  manualIdError ? 'border-red-500' : 'border-slate-800 focus:border-cyan-500'
                }`}
              />
              <button
                type="button"
                onClick={handleAddManualId}
                className="h-[28px] px-3 text-[11.5px] font-semibold bg-cyan-950 border border-cyan-600 text-cyan-300 rounded-xs hover:bg-cyan-900 cursor-pointer"
              >
                {t('trace.restbus.addBtn')}
              </button>
            </div>
          </div>

          {manualIdError && (
            <div className="text-[11px] text-red-400 font-mono -mt-1">
              {manualIdError}
            </div>
          )}

          {/* CAN ID Selection Table */}
          <div className="max-h-64 overflow-y-auto border border-slate-800 rounded-xs bg-slate-950/60 divide-y divide-slate-800/60">
            {filteredRestbusMessages.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] text-slate-500 italic">
                {t('trace.restbus.noMessagesMatch')}
              </div>
            ) : (
              filteredRestbusMessages.map((item) => {
                const isSelected = traceState.replayFilterKeys.includes(item.messageKey);
                const idHex = formatPcanIdHex(item.arbId, item.isExtended);

                return (
                  <div
                    key={item.messageKey}
                    onClick={() => handleToggleKey(item.messageKey)}
                    className={`flex items-center justify-between px-2.5 py-1 text-[11px] hover:bg-slate-900/80 cursor-pointer transition-colors ${
                      isSelected
                        ? filterMode === 'exclude'
                          ? 'bg-amber-950/25'
                          : 'bg-cyan-950/25'
                        : ''
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleToggleKey(item.messageKey)}
                        onClick={(e) => e.stopPropagation()}
                        className={`cursor-pointer rounded-xs ${
                          filterMode === 'exclude' ? 'accent-amber-500' : 'accent-cyan-500'
                        }`}
                      />
                      <span
                        className={`text-[9px] font-mono font-bold px-1 py-0.2 rounded-xs uppercase ${
                          item.isExtended
                            ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                            : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                        }`}
                      >
                        {item.isExtended ? 'EXT' : 'STD'}
                      </span>
                      <span className="font-mono tabular-nums font-bold text-slate-200">
                        0x{idHex}
                      </span>
                      <span className="truncate text-slate-300 font-medium ml-1">
                        {item.name}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 shrink-0 ml-2">
                      {item.senderEcu && item.senderEcu !== '—' && (
                        <span className="text-[10px] font-mono px-1.5 py-0.2 bg-slate-800/80 text-slate-300 rounded-xs border border-slate-700/60">
                          {item.senderEcu}
                        </span>
                      )}
                      <span className="font-mono tabular-nums text-[10px] text-slate-400 w-20 text-right">
                        {item.count > 0
                          ? t('trace.restbus.framesCount', { count: item.count.toLocaleString('en-US') })
                          : 'DBC'}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Fixed Header Industrial Trace Window */}
      <div
        style={{
          backgroundColor: 'var(--bg-header)',
          borderBottom: '1px solid var(--border-strong)',
          color: 'var(--text-secondary)',
        }}
        className={`shrink-0 h-[30px] grid ${gridTemplateClass} items-center text-[12px] font-semibold`}
      >
        <div className="h-full flex items-center justify-center border-r border-[var(--border-grid)]" />
        <div className="px-2 h-full flex items-center justify-end border-r border-[var(--border-grid)]">
          {t('trace.table.colTime')}
        </div>
        <div className="px-2 h-full flex items-center border-r border-[var(--border-grid)]">
          {t('trace.table.colBus')}
        </div>
        <div className="px-2 h-full flex items-center border-r border-[var(--border-grid)]">
          {t('trace.table.colType')}
        </div>
        <div className="px-2 h-full flex items-center border-r border-[var(--border-grid)]">
          {t('trace.table.colId')}
        </div>
        <div className="px-2 h-full flex items-center border-r border-[var(--border-grid)]">
          {t('trace.table.colSymbol')}
        </div>
        <div className="px-2 h-full flex items-center border-r border-[var(--border-grid)]">
          {t('trace.table.colDir')}
        </div>
        <div className="px-2 h-full flex items-center justify-end border-r border-[var(--border-grid)]">
          {t('trace.table.colDlc')}
        </div>
        <div
          className={`px-2 h-full flex items-center ${
            showDecodedCol ? 'border-r border-[var(--border-grid)]' : ''
          }`}
        >
          {t('trace.table.colData')}
        </div>
        {showDecodedCol && (
          <div className="px-2 h-full flex items-center">
            {t('trace.table.colDecoded')}
          </div>
        )}
      </div>

      {/* Virtualized O(1) Chronological Rows + Expandable 28px-Locked Decoded Signal Rows */}
      <div
        ref={containerRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="flex-1 min-h-0 overflow-y-auto font-mono tabular-nums text-[12px]"
      >
        {totalVirtualRows === 0 ? (
          <div className="h-full flex flex-col items-center justify-center py-16 px-4 text-center select-none">
            {sess.state === 'stopped' ? (
              <div
                style={{
                  backgroundColor: 'var(--bg-toolbar)',
                  borderColor: 'var(--border-strong)',
                }}
                className="max-w-md p-6 border rounded-sm flex flex-col items-center text-center shadow-lg"
              >
                <div className="w-10 h-10 rounded-full bg-rose-500/15 border border-rose-500/30 flex items-center justify-center mb-3 text-rose-400">
                  <Disc className="w-5 h-5 animate-spin" style={{ animationDuration: '6s' }} />
                </div>
                <h3 className="text-[13px] font-bold text-[var(--text-primary)] mb-1">
                  {t('trace.empty.stoppedTitle', { name: sess.name })}
                </h3>
                <p className="text-[11px] text-[var(--text-muted)] mb-4 max-w-xs leading-relaxed">
                  {t('trace.empty.stoppedDesc')}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => traceSessionsStore.startRecording(sess.id, false)}
                    style={{
                      backgroundColor: '#DC2626',
                      color: '#FFFFFF',
                    }}
                    className="h-[28px] px-4 font-semibold text-[11px] rounded-xs flex items-center gap-2 hover:bg-red-700 cursor-pointer shadow-md transition-colors"
                  >
                    <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
                    <span>{t('trace.empty.startBtn')}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    style={{
                      backgroundColor: 'var(--bg-panel)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="h-[28px] px-3 font-semibold text-[11px] border rounded-xs flex items-center gap-1.5 hover:border-amber-400 cursor-pointer transition-colors"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
                    <span>{t('trace.empty.openFileBtn')}</span>
                  </button>
                </div>
              </div>
            ) : sess.state === 'paused' ? (
              <div className="flex flex-col items-center text-[var(--text-muted)]">
                <Pause className="w-6 h-6 text-amber-400 mb-2" />
                <span className="text-[12px] font-medium text-[var(--text-primary)]">
                  {t('trace.empty.pausedTitle')}
                </span>
                <span className="text-[11px] text-[var(--text-muted)] mt-1">
                  {t('trace.empty.pausedDesc')}
                </span>
              </div>
            ) : (
              <div className="flex flex-col items-center text-[var(--text-muted)]">
                <div className="w-3 h-3 rounded-full bg-rose-500 animate-ping mb-3" />
                <span className="text-[12px] font-medium text-[var(--text-primary)]">
                  {t('trace.empty.recordingTitle')}
                </span>
                <span className="text-[11px] text-[var(--text-muted)] mt-1 font-mono">
                  {t('trace.empty.recordingDesc')}
                </span>
              </div>
            )}
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
                          {strNoDecodedSignals}
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
                                {strOutOfRange}
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

                const isReplayCursorRow =
                  isThisSessionReplaying && item.baseIdx === replay.currentIndex;

                return (
                  <div
                    key={`frm-${item.frameUid}`}
                    onClick={() => toggleExpandFrame(item.frameUid)}
                    style={{
                      height: `${ROW_HEIGHT}px`,
                      minHeight: `${ROW_HEIGHT}px`,
                      maxHeight: `${ROW_HEIGHT}px`,
                      backgroundColor: isReplayCursorRow
                        ? 'rgba(8, 51, 68, 0.70)'
                        : item.isExpanded
                          ? 'var(--bg-row-selected)'
                          : item.baseIdx % 2 === 1
                            ? 'var(--bg-row-alt)'
                            : 'var(--bg-panel)',
                      borderBottom: '1px solid var(--border-grid)',
                      borderLeft: isReplayCursorRow ? '3px solid #22D3EE' : undefined,
                    }}
                    className={`grid ${gridTemplateClass} items-center hover:!bg-[var(--bg-row-hover)] cursor-pointer overflow-hidden whitespace-nowrap ${
                      isReplayCursorRow ? 'font-semibold text-cyan-200' : ''
                    }`}
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
                      {formatRelativeTimeSec(row.timestampUs, sess.originTimestampUs)}
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

      {/* Bottom 22px PCAN Trace Status Bar (Direct answer to "Trace kayıt yeri nerede?") */}
      <div
        style={{
          backgroundColor: 'var(--bg-header)',
          borderTop: '1px solid var(--border-strong)',
          color: 'var(--text-secondary)',
        }}
        className="shrink-0 h-[22px] px-2 flex items-center justify-between text-[11px] select-none font-sans"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-1.5 shrink-0">
            <span
              className={`w-2 h-2 rounded-full ${
                sess.state === 'recording'
                  ? 'bg-rose-500 animate-pulse shadow-xs shadow-rose-500/50'
                  : sess.state === 'paused'
                    ? 'bg-amber-400'
                    : 'bg-slate-500'
              }`}
            />
            <span
              className={`font-semibold uppercase text-[10px] ${
                sess.state === 'recording'
                  ? 'text-rose-400'
                  : sess.state === 'paused'
                    ? 'text-amber-400'
                    : 'text-[var(--text-muted)]'
              }`}
            >
              {sess.state === 'recording'
                ? t('trace.status.recording')
                : sess.state === 'paused'
                  ? t('trace.status.paused')
                  : t('trace.status.stopped')}
            </span>
          </div>

          {/* Persistent Disk Location Badge with 1-Click Clipboard Copy */}
          {sess.savedFilePath ? (
            <button
              type="button"
              onClick={() => {
                if (sess.savedFilePath) {
                  void navigator.clipboard.writeText(sess.savedFilePath);
                  onStatusMessage?.({
                    kind: 'info',
                    message: t('trace.notify.pathCopied', { path: sess.savedFilePath }),
                  });
                }
              }}
              className="flex items-center gap-1 font-mono text-[10px] text-emerald-400 hover:text-emerald-300 hover:underline cursor-pointer truncate max-w-[360px]"
              title={t('trace.status.copyPathTooltip')}
            >
              <span>{t('trace.status.saveLocation')}</span>
              <span className="truncate">{sess.savedFilePath}</span>
              <Copy className="w-2.5 h-2.5 shrink-0 text-emerald-500" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(traceState.tracesDir);
                onStatusMessage?.({
                  kind: 'info',
                  message: t('trace.notify.dirCopied', { dir: traceState.tracesDir }),
                });
              }}
              className="flex items-center gap-1 font-mono text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:underline cursor-pointer truncate max-w-[360px]"
              title={t('trace.status.copyDirTooltip')}
            >
              <span>{t('trace.status.saveDir')}</span>
              <span className="truncate">{traceState.tracesDir}</span>
              <span className="text-[9px] text-sky-400">
                {t('trace.status.autoSave', {
                  state: traceState.autoSaveOnStop
                    ? t('trace.status.autoSaveOn')
                    : t('trace.status.autoSaveOff'),
                })}
              </span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0 font-mono tabular-nums text-[11px]">
          <span>
            {t('trace.status.duration')}{' '}
            {sess.originTimestampUs > 0 && sess.lastTimestampUs >= sess.originTimestampUs
              ? ((sess.lastTimestampUs - sess.originTimestampUs) / 1_000_000).toFixed(4)
              : '0.0000'}
            s
          </span>
          <span className="text-[var(--border-strong)]">|</span>
          <span>
            {t('trace.status.buffer')}{' '}
            {baseFrameCount.toLocaleString('en-US')} / {sess.maxBufferRows.toLocaleString('en-US')}
          </span>
          <span className="text-[var(--border-strong)]">|</span>
          <span>
            {t('trace.status.total')}{' '}
            {sess.totalCaptured.toLocaleString('en-US')}
          </span>
          <span className="text-[var(--border-strong)]">|</span>
          <span className="text-emerald-400">Rx: {sess.rxCaptured.toLocaleString('en-US')}</span>
          <span className="text-[var(--border-strong)]">|</span>
          <span className="text-sky-400">Tx: {sess.txCaptured.toLocaleString('en-US')}</span>
        </div>
      </div>
    </div>
  );
};
