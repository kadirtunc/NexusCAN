import { findFilteredFrame, TraceFilterIndex } from '../utils/traceFilterIndex';
import type { TraceRecordingAction } from '../services/traceWindow';
import type { TraceSession } from '../store/traceSessionsStore';
import { copyMenuText, openContextMenu } from './ContextMenu';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
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
import { traceIdFilterStore, traceIdKey, useTraceIdFilter } from '../store/traceIdFilterStore';
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
import {
  CAN_ERR_MASK,
  type DecodedErrorField,
  decodeCanErrorFields,
  formatErrorFrameShortTitle,
} from '../utils/canErrorDecoder';
import { QuickPlotButton } from './PlotterView';
import type { StatusBanner } from './TopBar';
import { GuideInfoButton, GuideTourButton } from '../onboarding/GuideButtons';
import { GuideStrip } from '../onboarding/GuideStrip';

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
  errorFields?: readonly DecodedErrorField[];
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
      errField?: DecodedErrorField;
      childIdx: number;
    };

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

const EMPTY_RESTBUS_MESSAGES: readonly RestbusMessageItem[] = [];

export interface TraceViewProps {
  detached?: {
    session: TraceSession;
    onRecordingAction: (action: TraceRecordingAction) => void;
    onDock: () => void;
  };
  sessionId?: string;
  onStatusMessage?: (msg: StatusBanner) => void;
}

export const TraceView: React.FC<TraceViewProps> = ({ sessionId, onStatusMessage, detached }) => {
  const { t } = useI18n();
  const dbState = useDatabaseStore();
  const connState = useConnectionStore();
  const header = useTelemetryHeader();
  const traceState = useTraceSessionsStore();
  const sess = detached?.session ?? traceSessionsStore.getSession(sessionId);
  const record = () => detached ? detached.onRecordingAction('record') : traceSessionsStore.startRecording(sess.id, false);
  const stop = () => detached ? detached.onRecordingAction('stop') : traceSessionsStore.stopRecording(sess.id);
  const idFilter = useTraceIdFilter(sess.id);

  const availableBusIds = useMemo(() => {
    const ids = new Set<number>([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const p of connState.profiles) ids.add(p.busId);
    for (const b of header.buses) ids.add(b.busId);
    if (sess.busFilter !== null) ids.add(sess.busFilter);
    return Array.from(ids).sort((a, b) => a - b);
  }, [connState.profiles, header.buses, sess.busFilter]);

  const [filterQuery, setFilterQuery] = useState<string>('');
  const [dirFilter, setDirFilter] = useState<'ALL' | 'RX' | 'TX' | 'ERR'>('ALL');
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
  const lastScrollTop = useRef(0);
  const pendingPause = useRef<{ sessionId: string; scrollTop: number } | null>(null);
  const previousTrace = useRef({ id: sess.id, state: sess.state });

  const pause = (): void => {
    pendingPause.current = {
      sessionId: sess.id,
      scrollTop: containerRef.current?.scrollTop ?? lastScrollTop.current,
    };
    if (detached) detached.onRecordingAction('pause');
    else traceSessionsStore.pauseRecording(sess.id);
  };


  useEffect(() => {
    setExpandedUids(new Set());
    setCustomBufferText(String(sess.maxBufferRows));
  }, [sess.id]);

  useEffect(() => {
    setCustomBufferText(String(sess.maxBufferRows));
  }, [sess.maxBufferRows]);

  const replay = header.replay;
  const showReplayTransport =
    (sess.count > 0 && sess.state !== 'recording') || replay.state !== 'idle';
  const needsRestbusMessages = !detached && showReplayTransport && restbusFilterOpen;
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
    if (!followCursor || !isThisSessionReplaying || sess.state === 'paused' || pendingPause.current?.sessionId === sess.id) return;
    const currentIdx = replay.currentIndex;
    if (currentIdx < 0) return;
    const el = containerRef.current;
    if (!el) return;
    const targetScrollTop = Math.max(0, currentIdx * ROW_HEIGHT - viewportHeight / 2);
    if (Math.abs(el.scrollTop - targetScrollTop) > ROW_HEIGHT * 6) {
      el.scrollTop = targetScrollTop;
      lastScrollTop.current = el.scrollTop;
      setScrollTop(el.scrollTop);
    }
  }, [followCursor, isThisSessionReplaying, replay.currentIndex, sess.id, sess.state, viewportHeight]);

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
    if (!needsRestbusMessages) return EMPTY_RESTBUS_MESSAGES;
    const map = new Map<string, RestbusMessageItem>();
    const ring = sess.displayRing;
    const len = ring.length;

    for (let i = 0; i < len; i++) {
      const f = ring.getAt(i);
      if (!f) continue;
      if (f.isError) continue;
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
  }, [needsRestbusMessages, sess.displayRing, sess.version, dbState.schema, dbState.busSchemas, traceState.replayFilterKeys, t]);

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
  const isUnfiltered = q.length === 0 && dirFilter === 'ALL' && idFilter === null;
  const idFilterSet: ReadonlySet<string> | null = useMemo(
    () => (idFilter === null ? null : new Set(idFilter.map((e) => traceIdKey(e.arbId, e.isExtended)))),
    [idFilter],
  );

  const filterIndex = useMemo(() => {
    if (isUnfiltered) return null;

    return new TraceFilterIndex((row) => {
      if (dirFilter === 'RX' && (row.isTx || row.isError)) return false;
      if (dirFilter === 'TX' && (!row.isTx || row.isError)) return false;
      if (dirFilter === 'ERR' && !row.isError) return false;
      if (idFilterSet !== null && (row.isError || !idFilterSet.has(traceIdKey(row.arbId, row.isExtended)))) return false;
      if (!q) return true;

      if (row.isError) {
        const errTitle = formatErrorFrameShortTitle(row.arbId, row.rawBytes, row.errorSummary).toLowerCase();
        const idHex = (row.arbId & CAN_ERR_MASK).toString(16).toLowerCase();
        return errTitle.includes(q) || idHex.includes(q) || q.includes('err');
      }

      const idHex = formatPcanIdHex(row.arbId, row.isExtended).toLowerCase();
      if (idHex.includes(q)) return true;
      const msg = databaseStore.getMessageForBus(row.busId, row.messageKey, row.arbId, row.isExtended);
      if (!msg) return '—'.includes(q);
      if (msg.name.toLowerCase().includes(q)) return true;
      const signals = databaseStore.getBusSignals(row.busId);
      if (msg.signalIds.some((id) => signals[id]?.name.toLowerCase().includes(q))) return true;
      return resolveTraceFrameSymbol(row.rawBytes, msg, signals).fullSymbol.toLowerCase().includes(q);
    });
  }, [isUnfiltered, dirFilter, q, idFilterSet, dbState.busSchemas]);

  const filtered = useMemo(
    () => filterIndex?.update(sess.displayRing) ?? null,
    [filterIndex, sess.displayRing, sess.version],
  );
  const baseFrameCount = filtered ? filtered.end - filtered.start : sess.count;

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

      const baseIdx = filtered ? findFilteredFrame(filtered, uid) : ringIdx;
      if (baseIdx >= 0) resolvedPairs.push({ baseIdx, frameUid: uid, ringIdx });
    }

    resolvedPairs.sort((a, b) => a.baseIdx - b.baseIdx);

    let cumExtra = 0;
    for (const item of resolvedPairs) {
      const frame = sess.displayRing.getAt(item.ringIdx);
      if (!frame) continue;
      if (frame.isError) {
        const errorFields = decodeCanErrorFields(frame.arbId, frame.rawBytes);
        const childRowCount = Math.max(1, errorFields.length);
        anchors.push({
          baseIdx: item.baseIdx,
          frameUid: item.frameUid,
          frame,
          signals: [],
          errorFields,
          childRowCount,
          cumExtraBefore: cumExtra,
        });
        cumExtra += childRowCount;
      } else {
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
    }

    return { expandedAnchors: anchors, totalExtraRows: cumExtra };
  }, [
    expandedUids,
    baseFrameCount,
    filtered,
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

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const previous = previousTrace.current;
    previousTrace.current = { id: sess.id, state: sess.state };

    const keepPosition = sess.state === 'paused' && previous.id === sess.id && previous.state !== 'paused';
    const pausePosition = pendingPause.current?.sessionId === sess.id ? pendingPause.current : null;
    if (sess.state !== 'recording' || previous.id !== sess.id) pendingPause.current = null;

    if (keepPosition) {
      el.scrollTop = pausePosition?.scrollTop ?? lastScrollTop.current;
    } else if (autoScroll && sess.state === 'recording' && !pausePosition && !isThisSessionReplaying) {
      el.scrollTop = Math.max(0, totalVirtualRows * ROW_HEIGHT - el.clientHeight);
    }
    lastScrollTop.current = el.scrollTop;
    setScrollTop(el.scrollTop);
  }, [totalVirtualRows, viewportHeight, autoScroll, sess.id, sess.state, isThisSessionReplaying]);

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
      const ringIdx = filtered
        ? filtered.ids[filtered.start + bIdx] - sess.displayRing.baseSeq
        : bIdx;
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
            errField: anc.errorFields ? anc.errorFields[childIdx] : undefined,
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
    filtered,
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

  // Static constants for virtual row hot path (60 FPS discipline)
  const strNoDecodedSignals = t('trace.table.noDecodedSignals');
  const strOutOfRange = t('trace.table.outOfRange');

  return (
    <div
      style={{ backgroundColor: 'var(--bg-panel)' }}
      className="flex flex-col flex-1 min-h-0 select-none"
    >
      {!detached && <GuideStrip pageId="trace" />}
      {/* Hidden file input for opening .trc / .asc / .log / .csv / .blf from disk */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".trc,.asc,.log,.csv,.blf,.mf4"
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
        <div data-tour="trace.toolbar-left" className="flex items-center gap-1.5 shrink-0">
          {/* Multi-Session Selector or Name Badge */}
          {!detached && traceState.sessions.length > 1 ? (
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
                onClick={pause}
                style={{
                  backgroundColor: 'var(--status-warn-bg)',
                  borderColor: 'var(--status-warn-border)',
                  color: 'var(--status-warn)',
                }}
                className="h-[28px] px-3 border flex items-center gap-1.5 text-[12px] font-semibold cursor-pointer shrink-0 hover:bg-yellow-500/25 rounded-xs"
                title={t('trace.toolbar.pauseTooltip')}
              >
                <Pause className="w-3.5 h-3.5" />
                <span>{t('trace.toolbar.pause')}</span>
              </button>
              <button
                type="button"
                onClick={stop}
                style={{
                  backgroundColor: 'var(--status-critical-bg)',
                  borderColor: 'var(--status-critical-border)',
                  color: 'var(--status-critical)',
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
              onClick={record}
              style={{
                backgroundColor: 'var(--status-critical-bg)',
                borderColor: 'var(--status-critical-border)',
                color: 'var(--status-critical)',
              }}
              className="h-[28px] px-3 border flex items-center gap-2 text-[12px] font-semibold cursor-pointer shrink-0 hover:bg-red-500/25 rounded-xs"
              title={sess.state === 'paused' ? t('trace.toolbar.resumeTooltip') : t('trace.toolbar.recordTooltip')}
            >
              <div className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse" />
              <span>{sess.state === 'paused' ? t('trace.toolbar.resume') : t('trace.toolbar.record')}</span>
            </button>
          )}

          {/* Temizle Button */}
          {detached ? (
            <button
              type="button"
              onClick={detached.onDock}
              className="h-[28px] px-2 border border-strong bg-panel text-[var(--text-primary)] cursor-pointer"
            >
              {t('trace.window.dock')}
            </button>
          ) : (
            <>
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
            <FolderOpen className="w-3.5 h-3.5 text-[var(--status-warn)]" />
            <span>{t('trace.toolbar.open')}</span>
          </button>

          {/* Save to Workspace Disk (traces/) */}
          <button
            type="button"
            disabled={sess.count === 0}
            onClick={() => void handleSaveToDisk()}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: sess.savedFilePath && !sess.dirtySinceSave ? 'var(--status-nominal-border)' : 'var(--border-strong)',
              color: sess.savedFilePath && !sess.dirtySinceSave ? 'var(--status-nominal)' : 'var(--text-primary)',
            }}
            className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[11px] font-medium hover:border-[var(--status-nominal-border)] cursor-pointer shrink-0 disabled:opacity-40 rounded-xs"
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
              <Check className="w-3.5 h-3.5 text-[var(--status-nominal)]" />
            ) : (
              <Save className="w-3.5 h-3.5 text-[var(--status-nominal)]" />
            )}
            <span>{sess.savedFilePath && !sess.dirtySinceSave ? t('trace.toolbar.saved') : t('trace.toolbar.save')}</span>
          </button>

          {/* Plot in Scope / Plotter */}
          <button
            type="button"
            disabled={sess.count === 0}
            onClick={handlePlotTraceInPlotter}
            style={{
              backgroundColor: 'var(--status-focus-bg)',
              borderColor: 'var(--status-focus-border)',
              color: 'var(--status-focus)',
            }}
            className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[11px] font-semibold hover:bg-[var(--status-focus-bg)] cursor-pointer shrink-0 disabled:opacity-40 rounded-xs"
            title={t('trace.toolbar.plotterTooltip')}
          >
            <Activity className="w-3.5 h-3.5 text-[var(--status-focus)]" />
            <span>{t('trace.toolbar.plotter')}</span>
          </button>
            </>
          )}
        </div>

        {/* Orta Grup: Hızlı Arama & Hat/Yön Filtresi */}
        <div data-tour="trace.filter" className="flex items-center gap-1.5 min-w-0 flex-shrink">
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
              className="h-[28px] w-36 xl:w-48 px-2 pr-6 border text-[11px] rounded-xs focus:outline-none focus:border-[var(--status-focus)]"
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

          {idFilter !== null && (
            <button
              type="button"
              onClick={() => traceIdFilterStore.set(sess.id, null)}
              title={t('trace.idFilter.clear')}
              className="h-[28px] px-2 border border-sky-500/60 bg-sky-950/40 text-sky-300 text-[11px] font-mono tabular-nums cursor-pointer rounded-xs flex items-center gap-1 shrink-0"
            >
              {t('trace.idFilter.badge', { count: idFilter.length })}
              <X className="w-3 h-3" />
            </button>
          )}

          {/* Bus Filter */}
          <select
            aria-label="Bus Filter"
            disabled={Boolean(detached)}
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
            onChange={(e) => setDirFilter(e.target.value as 'ALL' | 'RX' | 'TX' | 'ERR')}
            style={{
              backgroundColor: 'var(--bg-input)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[28px] px-1.5 border text-[11px] rounded-xs focus:outline-none shrink-0 cursor-pointer"
            title="Yön / Çerçeve Tipi Filtresi"
          >
            <option value="ALL">{t('trace.toolbar.dirAll')}</option>
            <option value="RX">{t('trace.toolbar.dirRx')}</option>
            <option value="TX">{t('trace.toolbar.dirTx')}</option>
            <option value="ERR">{t('trace.toolbar.dirErr')}</option>
          </select>

          {/* Live Error Counter Pill */}
          <button
            type="button"
            onClick={() => setDirFilter((cur) => (cur === 'ERR' ? 'ALL' : 'ERR'))}
            style={{
              backgroundColor:
                dirFilter === 'ERR'
                  ? 'var(--status-critical-bg)'
                  : sess.errCaptured > 0
                    ? 'var(--status-critical-bg)'
                    : 'var(--bg-input)',
              borderColor:
                dirFilter === 'ERR'
                  ? 'var(--status-critical-border)'
                  : sess.errCaptured > 0
                    ? 'var(--status-critical-border)'
                    : 'var(--border-strong)',
              color: sess.errCaptured > 0 ? 'var(--status-critical)' : 'var(--text-muted)',
            }}
            className="h-[28px] px-2 border text-[11px] font-mono font-semibold flex items-center gap-1 cursor-pointer shrink-0 rounded-xs"
            title={`Errors captured: ${sess.errCaptured} (Click to toggle filter)`}
          >
            <AlertTriangle
              className={`w-3 h-3 ${sess.errCaptured > 0 ? 'text-[var(--status-critical)]' : 'text-[var(--text-muted)]'}`}
            />
            <span>ERR: {sess.errCaptured}</span>
          </button>
        </div>

        {/* Sağ Grup: Ayarlar ▾ ve Dışa Aktar ▾ Popover Menüleri */}
        {detached ? (
          <label className="flex shrink-0 items-center gap-1.5 text-[var(--text-secondary)]">
            <input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} />
            {t('trace.settings.autoScroll')}
          </label>
        ) : (
        <div className="flex items-center gap-1.5 shrink-0 relative">
          {/* Settings Popover Button */}
          <div ref={settingsMenuRef} data-tour="trace.settings" className="relative">
            <button
              type="button"
              onClick={() => {
                setSettingsMenuOpen((prev) => !prev);
                setExportMenuOpen(false);
              }}
              style={{
                backgroundColor: settingsMenuOpen ? 'var(--bg-panel)' : 'var(--bg-panel)',
                borderColor: settingsMenuOpen ? 'var(--status-focus)' : 'var(--border-strong)',
                color: settingsMenuOpen ? 'var(--status-focus)' : 'var(--text-primary)',
              }}
              className="h-[28px] px-2.5 border rounded-xs flex items-center gap-1.5 text-[11px] font-medium hover:border-[var(--status-focus-border)] cursor-pointer"
              title={t('trace.settings.tooltip')}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>{t('trace.settings.btn')}</span>
              <ChevronDown className={`w-3 h-3 transition-transform ${settingsMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            {settingsMenuOpen && (
              <div
                style={{
                  backgroundColor: 'var(--bg-toolbar)',
                  borderColor: 'var(--border-strong)',
                }}
                className="absolute right-0 top-[32px] z-50 w-64 p-3 border shadow-2xl rounded-xs flex flex-col gap-2.5 text-[11px]"
              >
                <div className="text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
                  {t('trace.settings.viewOptions')}
                </div>

                <label className="flex items-center justify-between text-[var(--text-primary)] cursor-pointer select-none">
                  <span>{t('trace.settings.autoScroll')}</span>
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(e) => setAutoScroll(e.target.checked)}
                    className="accent-[var(--status-focus)] cursor-pointer"
                  />
                </label>

                <label className="flex items-center justify-between text-[var(--text-primary)] cursor-pointer select-none">
                  <span>{t('trace.settings.showDecoded')}</span>
                  <input
                    type="checkbox"
                    checked={showDecodedCol}
                    onChange={(e) => setShowDecodedCol(e.target.checked)}
                    className="accent-[var(--status-nominal)] cursor-pointer"
                  />
                </label>

                {expandedUids.size > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setExpandedUids(new Set());
                      setSettingsMenuOpen(false);
                    }}
                    className="w-full h-[26px] px-2 border border-[var(--border-grid)] bg-[var(--bg-panel)] hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)] flex items-center justify-center gap-1.5 rounded-xs cursor-pointer text-[11px]"
                  >
                    <Minimize2 className="w-3 h-3" />
                    <span>{t('trace.settings.collapseRows', { count: expandedUids.size })}</span>
                  </button>
                )}

                <div className="border-t border-[var(--border-grid)] my-0.5" />

                <div className="text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
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
                    className="h-[24px] px-1.5 border font-mono tabular-nums text-[11px] bg-[var(--bg-panel)] border-[var(--border-grid)] text-[var(--text-primary)] rounded-xs flex-1 focus:outline-none"
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
                    className="h-[24px] w-20 px-1.5 border font-mono tabular-nums text-[11px] text-right bg-[var(--bg-panel)] border-[var(--border-grid)] text-[var(--text-primary)] rounded-xs focus:outline-none"
                    title={t('trace.settings.customBufferTooltip')}
                  />
                </div>

                <div className="border-t border-[var(--border-grid)] my-0.5" />

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
                  className="w-full h-[26px] px-2 border border-[var(--status-focus-border)] bg-[var(--status-focus-bg)] hover:bg-[var(--status-focus-bg)] text-[var(--status-focus)] font-medium text-[11px] flex items-center justify-center gap-1.5 rounded-xs cursor-pointer transition-colors"
                >
                  <Plus className="w-3.5 h-3.5 text-[var(--status-focus)]" />
                  <span>{t('trace.settings.newSession')}</span>
                </button>
              </div>
            )}
          </div>

          {/* Export Popover Button */}
          <div ref={exportMenuRef} data-tour="trace.export" className="relative">
            <button
              type="button"
              disabled={sess.count === 0}
              onClick={() => {
                setExportMenuOpen((prev) => !prev);
                setSettingsMenuOpen(false);
              }}
              style={{
                backgroundColor: exportMenuOpen ? 'var(--bg-panel)' : 'var(--bg-panel)',
                borderColor: exportMenuOpen ? 'var(--status-focus-border)' : 'var(--border-strong)',
                color: exportMenuOpen ? 'var(--status-focus)' : 'var(--text-primary)',
              }}
              className="h-[28px] px-2.5 border rounded-xs flex items-center gap-1.5 text-[11px] font-medium hover:border-[var(--status-focus-border)] cursor-pointer disabled:opacity-40"
              title={t('trace.export.tooltip')}
            >
              <Download className="w-3.5 h-3.5" />
              <span>{t('trace.export.btn')}</span>
              <ChevronDown className={`w-3 h-3 transition-transform ${exportMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            {exportMenuOpen && (
              <div
                style={{
                  backgroundColor: 'var(--bg-toolbar)',
                  borderColor: 'var(--border-strong)',
                }}
                className="absolute right-0 top-[32px] z-50 w-60 p-1.5 border shadow-2xl rounded-xs flex flex-col gap-1 text-[11px]"
              >
                <div className="px-2 py-1 text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
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
                  className="w-full text-left px-2.5 py-1.5 rounded-xs hover:bg-[var(--status-focus-bg)] text-[var(--status-focus)] font-mono text-[11px] flex items-center justify-between border border-transparent hover:border-[var(--status-focus-border)] cursor-pointer"
                >
                  <span>{t('trace.export.blf')}</span>
                  {exportingBlf ? (
                    <Loader2 className="w-3 h-3 animate-spin text-[var(--status-focus)]" />
                  ) : (
                    <span className="text-[9px] px-1 py-0.2 bg-[var(--status-focus-bg)] text-[var(--status-focus)] font-bold rounded-xs border border-[var(--status-focus-border)]">
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
                  className="w-full text-left px-2.5 py-1.5 rounded-xs hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)] font-mono text-[11px] flex items-center justify-between border border-transparent hover:border-[var(--border-strong)] cursor-pointer"
                >
                  <span>{t('trace.export.trc')}</span>
                  <span className="text-[9px] px-1 py-0.2 bg-[var(--bg-strip)] text-[var(--text-primary)] font-bold rounded-xs border border-[var(--border-grid)]">
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
                  className="w-full text-left px-2.5 py-1.5 rounded-xs hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)] font-mono text-[11px] flex items-center justify-between border border-transparent hover:border-[var(--border-strong)] cursor-pointer"
                >
                  <span>{t('trace.export.asc')}</span>
                  <span className="text-[9px] px-1 py-0.2 bg-[var(--bg-strip)] text-[var(--text-primary)] font-bold rounded-xs border border-[var(--border-grid)]">
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
                  className="w-full text-left px-2.5 py-1.5 rounded-xs hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)] font-mono text-[11px] flex items-center justify-between border border-transparent hover:border-[var(--border-strong)] cursor-pointer"
                >
                  <span>{t('trace.export.csv')}</span>
                  <span className="text-[9px] px-1 py-0.2 bg-[var(--bg-strip)] text-[var(--text-primary)] font-bold rounded-xs border border-[var(--border-grid)]">
                    CSV
                  </span>
                </button>
              </div>
            )}
          </div>
          <GuideTourButton pageId="trace" />
          <GuideInfoButton pageId="trace" tourAnchor="trace.info" />
        </div>
        )}
      </div>

      {/* PCAN-Style Trace Replay Transport Bar — Responsive min-h-[40px], flex-wrap, zero-overflow */}
      {!detached && showReplayTransport && (
        <div
          data-tour="trace.replay"
          style={{
            backgroundColor: 'var(--bg-toolbar)',
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
                backgroundColor: replay.state === 'playing' ? 'var(--status-warn-bg)' : 'var(--status-focus-bg)',
                borderColor: replay.state === 'playing' ? 'var(--status-warn-border)' : 'var(--status-focus-border)',
                color: replay.state === 'playing' ? 'var(--status-warn)' : 'var(--status-focus)',
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
                  backgroundColor: 'var(--status-critical-bg)',
                  borderColor: 'var(--status-critical-border)',
                  color: 'var(--status-critical)',
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
                backgroundColor: replayLoop ? 'var(--status-focus-bg)' : 'var(--bg-panel)',
                borderColor: replayLoop ? 'var(--status-focus-border)' : 'var(--border-strong)',
                color: replayLoop ? 'var(--status-focus)' : 'var(--text-secondary)',
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
                    ? 'var(--status-warn-bg)'
                    : 'var(--status-focus-bg)'
                  : restbusFilterOpen
                    ? 'var(--bg-toolbar)'
                    : 'var(--bg-panel)',
                borderColor: isFilterActive
                  ? filterMode === 'exclude'
                    ? 'var(--status-warn-border)'
                    : 'var(--status-focus-border)'
                  : restbusFilterOpen
                    ? 'var(--border-strong)'
                    : 'var(--border-strong)',
                color: isFilterActive
                  ? filterMode === 'exclude'
                    ? 'var(--status-warn)'
                    : 'var(--status-focus)'
                  : 'var(--text-secondary)',
              }}
              className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[11.5px] font-semibold cursor-pointer rounded-xs hover:text-[var(--text-primary)]"
              title={t('trace.replay.filterDrawerTooltip')}
            >
              <Filter className="w-3.5 h-3.5" />
              <span>{filterBadgeText}</span>
              <ChevronDown
                className={`w-3.5 h-3.5 transition-transform ${
                  restbusFilterOpen ? 'rotate-180 text-[var(--status-focus)]' : ''
                }`}
              />
            </button>
          </div>

          {/* Transport Center: Scrubber Slider, Time & Compact Counters */}
          <div className="flex-1 min-w-0 max-w-2xl flex items-center gap-2.5">
            <span className="font-mono tabular-nums text-[12px] text-[var(--status-focus)] font-semibold shrink-0">
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
              className="flex-1 h-2 accent-[var(--status-focus)] cursor-pointer min-w-[80px]"
            />

            {/* Compact Live Replay Counters */}
            <div className="flex items-center gap-2 font-mono tabular-nums text-[11px] shrink-0">
              <span className="text-[var(--text-secondary)]">
                {t('trace.replay.framesCount')}{' '}
                <strong className="text-[var(--status-focus)]">
                  {(
                    replay.dispatchedFrames ??
                    (replay.currentIndex >= 0 ? replay.currentIndex + 1 : 0)
                  ).toLocaleString('en-US')}
                </strong>
                /{' '}
                {(replay.totalFrames || sess.count).toLocaleString('en-US')}
              </span>
              {(isFilterActive || (replay.filteredOutFrames ?? 0) > 0) && (
                <span className="text-[var(--status-warn)]">
                  {t('trace.replay.filteredCount')}{' '}
                  <strong className="text-[var(--status-warn)]">
                    {(replay.filteredOutFrames ?? 0).toLocaleString('en-US')}
                  </strong>
                </span>
              )}
              {replayTxHardware && (
                <span className="text-[var(--status-nominal)]">
                  {t('trace.replay.hwCount')}{' '}
                  <strong className="text-[var(--status-nominal)]">
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
                backgroundColor: followCursor ? 'var(--status-focus-bg)' : 'var(--bg-panel)',
                borderColor: followCursor ? 'var(--status-focus-border)' : 'var(--border-strong)',
                color: followCursor ? 'var(--status-focus)' : 'var(--text-secondary)',
              }}
              className="h-[28px] px-2 border flex items-center gap-1 text-[11px] font-semibold cursor-pointer rounded-xs"
              title={t('trace.replay.cursorTooltip')}
            >
              <Crosshair className="w-3.5 h-3.5" />
              <span>{t('trace.replay.cursor')}</span>
            </button>

            {/* Hardware TX Checkbox */}
            <label
              className="flex items-center gap-1 px-1.5 text-[11px] text-[var(--status-warn)] font-semibold cursor-pointer shrink-0"
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
                className="accent-[var(--status-warn)] cursor-pointer"
              />
              <span className="flex items-center gap-1">
                <Zap className="w-3.5 h-3.5 text-[var(--status-warn)]" />
                <span>{t('trace.replay.hwTx')}</span>
              </span>
            </label>

            {/* Compact Hardware Safety Badge */}
            {replayTxHardware && (
              anyTargetDisarmed ? (
                <div
                  className="flex items-center gap-1 px-2 h-[26px] rounded-xs text-[11px] font-semibold font-mono bg-[var(--status-warn-bg)] border border-[var(--status-warn-border)] text-[var(--status-warn)] shrink-0"
                  title={t('trace.replay.txDisarmedBadgeTooltip')}
                >
                  <span>{t('trace.replay.txDisarmedBadge')}</span>
                </div>
              ) : (
                <div
                  className="flex items-center gap-1 px-2 h-[26px] rounded-xs text-[11px] font-semibold font-mono bg-[var(--status-nominal-bg)] border border-[var(--status-nominal-border)] text-[var(--status-nominal)] shrink-0"
                  title={t('trace.replay.activeTxBadgeTooltip')}
                >
                  <span className="text-[var(--status-critical)] animate-pulse font-bold">⚡</span>
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
      {needsRestbusMessages && (
        <div
          style={{
            backgroundColor: 'var(--bg-panel)',
            borderBottom: '1px solid var(--border-strong)',
          }}
          className="shrink-0 p-2.5 flex flex-col gap-2 text-[11px] select-none"
        >
          {/* Top Row: Mode Tabs & Direction Filter */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* Mode Selection */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] font-semibold text-[var(--text-secondary)] mr-1 uppercase tracking-wider">
                {t('trace.restbus.modeLabel')}
              </span>
              <button
                type="button"
                onClick={() => handleSetFilterMode('all')}
                className={`h-[28px] px-3 text-[12px] border rounded-xs transition-colors cursor-pointer ${
                  filterMode === 'all'
                    ? 'bg-[var(--bg-strip)] border-[var(--border-grid)] text-[var(--text-primary)] font-semibold'
                    : 'bg-[var(--bg-panel)] border-[var(--border-grid)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {t('trace.restbus.modeAll')}
              </button>
              <button
                type="button"
                onClick={() => handleSetFilterMode('include')}
                className={`h-[28px] px-3 text-[12px] border rounded-xs transition-colors cursor-pointer ${
                  filterMode === 'include'
                    ? 'bg-[var(--status-focus-bg)] border-[var(--status-focus-border)] text-[var(--status-focus)] font-semibold'
                    : 'bg-[var(--bg-panel)] border-[var(--border-grid)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
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
                    ? 'bg-[var(--status-warn-bg)] border-[var(--status-warn-border)] text-[var(--status-warn)] font-semibold'
                    : 'bg-[var(--bg-panel)] border-[var(--border-grid)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
                title={t('trace.restbus.excludeTitle')}
              >
                {t('trace.restbus.modeExclude')}
              </button>
            </div>

            {/* Direction Filter */}
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-[var(--text-secondary)] font-semibold uppercase tracking-wider mr-1">
                {t('trace.restbus.dirLabel')}
              </span>
              <div className="flex border border-[var(--border-grid)] rounded-xs overflow-hidden">
                <button
                  type="button"
                  onClick={() => handleSetDirectionFilter('all')}
                  className={`px-2.5 h-[26px] font-mono cursor-pointer ${
                    directionFilter === 'all'
                      ? 'bg-[var(--bg-strip)] text-[var(--text-primary)] font-semibold'
                      : 'bg-[var(--bg-panel)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {t('trace.restbus.dirAll')}
                </button>
                <button
                  type="button"
                  onClick={() => handleSetDirectionFilter('rx')}
                  className={`px-2.5 h-[26px] font-mono border-l border-[var(--border-grid)] cursor-pointer ${
                    directionFilter === 'rx'
                      ? 'bg-[var(--status-focus-bg)] text-[var(--status-focus)] font-semibold'
                      : 'bg-[var(--bg-panel)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {t('trace.restbus.dirRx')}
                </button>
                <button
                  type="button"
                  onClick={() => handleSetDirectionFilter('tx')}
                  className={`px-2.5 h-[26px] font-mono border-l border-[var(--border-grid)] cursor-pointer ${
                    directionFilter === 'tx'
                      ? 'bg-[var(--status-warn-bg)] text-[var(--status-warn)] font-semibold'
                      : 'bg-[var(--bg-panel)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {t('trace.restbus.dirTx')}
                </button>
              </div>
            </div>
          </div>

          {/* Mode Explanatory Notice */}
          <div className="text-[11px] text-[var(--text-secondary)] font-sans px-2.5 py-1.5 rounded-xs bg-[var(--bg-panel)] border border-[var(--border-grid)] flex items-center justify-between">
            <span>
              {filterMode === 'all' && t('trace.restbus.descAll')}
              {filterMode === 'include' && (
                <span className="text-[var(--status-focus)] font-medium">
                  {t('trace.restbus.descInclude', { count: filterKeys.length })}
                </span>
              )}
              {filterMode === 'exclude' && (
                <span className="text-[var(--status-warn)] font-medium">
                  {t('trace.restbus.descExclude', { count: filterKeys.length })}
                </span>
              )}
            </span>
            <span className="font-mono text-[10px] text-[var(--text-muted)]">
              {t('trace.restbus.liveUpdate')}
            </span>
          </div>

          {/* DBC ECU Node Quick Select Chips */}
          {availableEcus.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <span className="text-[11px] font-semibold text-[var(--text-secondary)] mr-0.5 uppercase tracking-wider">
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
                          ? 'bg-[var(--status-warn-bg)] border-[var(--status-warn-border)] text-[var(--status-warn)] font-semibold'
                          : 'bg-[var(--status-focus-bg)] border-[var(--status-focus-border)] text-[var(--status-focus)] font-semibold'
                        : partialSelected
                          ? 'bg-[var(--bg-strip)] border-dashed border-[var(--status-warn-border)] text-[var(--status-warn)]'
                          : 'bg-[var(--bg-panel)] border-[var(--border-grid)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]'
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
          <div className="flex items-center justify-between gap-2 pt-1 border-t border-[var(--border-grid)] flex-wrap">
            <div className="flex items-center gap-1.5 flex-1 min-w-0 max-w-md">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 absolute left-2 top-2 text-[var(--text-muted)]" />
                <input
                  type="text"
                  placeholder={t('trace.restbus.searchPlaceholder')}
                  value={restbusSearchQuery}
                  onChange={(e) => setRestbusSearchQuery(e.target.value)}
                  className="w-full h-[28px] pl-7 pr-2 text-[12px] bg-[var(--bg-input)] border border-[var(--border-grid)] rounded-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--status-focus)] font-sans"
                />
              </div>
              <button
                type="button"
                onClick={handleSelectAllVisible}
                className="h-[28px] px-2.5 text-[11.5px] font-medium bg-[var(--bg-panel)] border border-[var(--border-grid)] text-[var(--text-primary)] rounded-xs hover:border-[var(--border-strong)] cursor-pointer shrink-0"
              >
                {t('trace.restbus.selectAll')}
              </button>
              <button
                type="button"
                onClick={handleClearKeys}
                disabled={filterKeys.length === 0}
                className="h-[28px] px-2.5 text-[11.5px] font-medium bg-[var(--bg-panel)] border border-[var(--border-grid)] text-[var(--text-secondary)] rounded-xs hover:text-[var(--status-critical)] hover:border-[var(--status-critical-border)] cursor-pointer disabled:opacity-40 shrink-0"
              >
                {t('trace.restbus.clear')}
              </button>
            </div>

            {/* Manual ID Input */}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[11px] text-[var(--text-secondary)] font-semibold">
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
                className={`h-[28px] w-[180px] px-2 text-[12px] font-mono tabular-nums bg-[var(--bg-input)] border rounded-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none ${
                  manualIdError ? 'border-[var(--status-critical-border)]' : 'border-[var(--border-grid)] focus:border-[var(--status-focus)]'
                }`}
              />
              <button
                type="button"
                onClick={handleAddManualId}
                className="h-[28px] px-3 text-[11.5px] font-semibold bg-[var(--status-focus-bg)] border border-[var(--status-focus-border)] text-[var(--status-focus)] rounded-xs hover:bg-[var(--status-focus-bg)] cursor-pointer"
              >
                {t('trace.restbus.addBtn')}
              </button>
            </div>
          </div>

          {manualIdError && (
            <div className="text-[11px] text-[var(--status-critical)] font-mono -mt-1">
              {manualIdError}
            </div>
          )}

          {/* CAN ID Selection Table */}
          <div className="max-h-64 overflow-y-auto border border-[var(--border-grid)] rounded-xs bg-[var(--bg-input)] divide-y divide-[var(--border-grid)]">
            {filteredRestbusMessages.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] text-[var(--text-muted)] italic">
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
                    className={`flex items-center justify-between px-2.5 py-1 text-[11px] hover:bg-[var(--bg-row-hover)] cursor-pointer transition-colors ${
                      isSelected
                        ? filterMode === 'exclude'
                          ? 'bg-[var(--status-warn-bg)]'
                          : 'bg-[var(--status-focus-bg)]'
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
                          filterMode === 'exclude' ? 'accent-[var(--status-warn)]' : 'accent-[var(--status-focus)]'
                        }`}
                      />
                      <span
                        className={`text-[9px] font-mono font-bold px-1 py-0.2 rounded-xs uppercase ${
                          item.isExtended
                            ? 'bg-[var(--status-focus-bg)] text-[var(--status-focus)] border border-[var(--status-focus-border)]'
                            : 'bg-[var(--status-focus-bg)] text-[var(--status-focus)] border border-[var(--status-focus-border)]'
                        }`}
                      >
                        {item.isExtended ? 'EXT' : 'STD'}
                      </span>
                      <span className="font-mono tabular-nums font-bold text-[var(--text-primary)]">
                        0x{idHex}
                      </span>
                      <span className="truncate text-[var(--text-primary)] font-medium ml-1">
                        {item.name}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 shrink-0 ml-2">
                      {item.senderEcu && item.senderEcu !== '—' && (
                        <span className="text-[10px] font-mono px-1.5 py-0.2 bg-[var(--bg-strip)] text-[var(--text-primary)] rounded-xs border border-[var(--border-grid)]">
                          {item.senderEcu}
                        </span>
                      )}
                      <span className="font-mono tabular-nums text-[10px] text-[var(--text-secondary)] w-20 text-right">
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
        data-tour="trace.table"
        onContextMenu={(event) => openContextMenu(event, [
          { label: t('context.toggleDecodedColumn'), run: () => setShowDecodedCol((visible) => !visible) },
        ])}
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
        onContextMenu={(event) => openContextMenu(event, [
          ...(detached ? [] : [{ label: t('trace.empty.openFileBtn'), run: () => fileInputRef.current?.click() }]),
          { label: t('context.clearCanFilter'), run: () => traceIdFilterStore.set(sess.id, null), disabled: !traceIdFilterStore.get(sess.id) },
        ])}
        onScroll={(event) => {
          const { scrollTop: top, scrollHeight, clientHeight } = event.currentTarget;
          if (autoScroll && sess.state === 'recording' && !isThisSessionReplaying
            && top < lastScrollTop.current && scrollHeight - clientHeight - top > ROW_HEIGHT) {
            setAutoScroll(false);
          }
          lastScrollTop.current = top;
          setScrollTop(top);
        }}
        style={{ overflowAnchor: 'none' }}
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
                    onClick={record}
                    style={{
                      backgroundColor: '#DC2626',
                      color: '#FFFFFF',
                    }}
                    className="h-[28px] px-4 font-semibold text-[11px] rounded-xs flex items-center gap-2 hover:bg-red-700 cursor-pointer shadow-md transition-colors"
                  >
                    <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
                    <span>{t('trace.empty.startBtn')}</span>
                  </button>

                  {!detached && (
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
                  )}
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
                  if (item.frame.isError) {
                    const ef = item.errField;
                    return (
                      <div
                        key={`sig-${item.frameUid}-${item.childIdx}`}
                        style={{
                          height: `${ROW_HEIGHT}px`,
                          minHeight: `${ROW_HEIGHT}px`,
                          maxHeight: `${ROW_HEIGHT}px`,
                          backgroundColor: 'var(--status-critical-bg)',
                          borderBottom: '1px solid var(--border-grid)',
                        }}
                        className="group flex items-center justify-between px-2 pl-8 overflow-hidden whitespace-nowrap hover:!bg-[var(--bg-row-hover)]"
                      >
                        {!ef ? (
                          <span className="font-sans text-[11px] text-[var(--status-critical)] border-l-2 border-[var(--status-critical)] pl-3">
                            {strNoDecodedSignals}
                          </span>
                        ) : (
                          <>
                            <div className="flex items-center gap-2 min-w-0 border-l-2 border-[var(--status-critical)] pl-3">
                              <span className="text-[var(--status-critical)] font-mono font-semibold text-[11px] select-text">
                                {ef.label}
                              </span>
                              <span className="text-[var(--text-muted)]">=</span>
                              <span className="font-semibold text-[var(--status-critical)] select-text font-mono text-[11px]">
                                {ef.value}
                              </span>
                            </div>

                            <div className="text-[10px] text-[var(--status-critical)] shrink-0 ml-4 font-mono tabular-nums">
                              [t = {(item.frame.timestampUs / 1_000_000).toFixed(6)}s]
                            </div>
                          </>
                        )}
                      </div>
                    );
                  }

                  const d = item.sig;
                  return (
                    <div
                      key={`sig-${item.frameUid}-${item.childIdx}`}
                      onContextMenu={(event) => {
                        if (!d) return;
                        openContextMenu(event, [{
                          label: t('plotter.quickPlot.addTitle'),
                          run: () => plotStore.addSignal(item.frame.busId, d.signal),
                        }]);
                      }}
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
                              <span className="text-[var(--status-critical)] font-sans text-[11px] font-semibold">
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
                const byteLen = Math.min(row.dlc, row.rawBytes.length);
                const isReplayCursorRow =
                  isThisSessionReplaying && item.baseIdx === replay.currentIndex;

                if (row.isError) {
                  const errorTitle = formatErrorFrameShortTitle(
                    row.arbId,
                    row.rawBytes,
                    row.errorSummary,
                  );
                  return (
                    <div
                      key={`frm-${item.frameUid}`}
                      onClick={() => toggleExpandFrame(item.frameUid)}
                      style={{
                        height: `${ROW_HEIGHT}px`,
                        minHeight: `${ROW_HEIGHT}px`,
                        maxHeight: `${ROW_HEIGHT}px`,
                        backgroundColor: isReplayCursorRow
                          ? 'var(--status-focus-bg)'
                          : item.isExpanded
                            ? 'color-mix(in srgb, var(--status-critical) 24%, transparent)'
                            : 'var(--status-critical-bg)',
                        borderBottom: '1px solid var(--border-grid)',
                        borderLeft: isReplayCursorRow
                          ? '3px solid var(--status-focus)'
                          : '3px solid var(--status-critical)',
                      }}
                      className={`grid ${gridTemplateClass} items-center hover:!bg-[var(--bg-row-hover)] cursor-pointer overflow-hidden whitespace-nowrap ${
                        isReplayCursorRow ? 'font-semibold text-[var(--status-focus)]' : ''
                      }`}
                    >
                      <div className="h-full flex items-center justify-center border-r border-[var(--border-grid)]">
                        {item.isExpanded ? (
                          <ChevronDown className="w-3.5 h-3.5 text-[var(--status-critical)]" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 text-[var(--status-critical)] opacity-70" />
                        )}
                      </div>

                      <div className="px-2 h-full flex items-center justify-end border-r border-[var(--border-grid)] text-[var(--status-critical)]">
                        {formatRelativeTimeSec(row.timestampUs, sess.originTimestampUs)}
                      </div>

                      <div className="px-2 h-full flex items-center border-r border-[var(--border-grid)] text-[var(--status-critical)]">
                        {row.busId + 1}
                      </div>

                      <div className="px-2 h-full flex items-center border-r border-[var(--border-grid)] font-bold text-[var(--status-critical)]">
                        ERR
                      </div>

                      <div className="px-2 h-full flex items-center border-r border-[var(--border-grid)] font-mono text-[var(--status-critical)] font-bold">
                        {(row.arbId & CAN_ERR_MASK).toString(16).toUpperCase().padStart(3, '0')}h
                      </div>

                      <div
                        className="px-2 h-full flex items-center border-r border-[var(--border-grid)] font-sans truncate text-[var(--status-critical)] font-medium"
                        title={row.errorSummary ?? errorTitle}
                      >
                        BUS ERROR
                      </div>

                      <div className="px-2 h-full flex items-center border-r border-[var(--border-grid)] font-sans font-bold text-[var(--status-critical)]">
                        Err
                      </div>

                      <div className="px-2 h-full flex items-center justify-end border-r border-[var(--border-grid)] text-[var(--status-critical)]">
                        {row.dlc}
                      </div>

                      <div
                        className={`px-2 h-full flex items-center overflow-x-auto no-scrollbar select-text text-[var(--status-critical)] ${
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
                          className="px-2 h-full flex items-center text-[11px] text-[var(--status-critical)] truncate select-text"
                          title={row.errorSummary ?? errorTitle}
                        >
                          <span className="truncate">{errorTitle}</span>
                        </div>
                      )}
                    </div>
                  );
                }

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

                return (
                  <div
                    key={`frm-${item.frameUid}`}
                    onContextMenu={(event) => {
                      const { arbId, isExtended } = row;
                      const payload = Array.from(row.rawBytes.slice(0, byteLen), (byte) => formatByteHex(byte)).join(' ');
                      openContextMenu(event, [
                        { label: t('context.copyCanId'), run: () => copyMenuText(formatPcanIdHex(arbId, isExtended)) },
                        { label: t('context.copyPayload'), run: () => copyMenuText(payload) },
                        { label: t('context.filterCanId'), run: () => traceIdFilterStore.set(sess.id, [{ arbId, isExtended }]) },
                      ]);
                    }}
                    onClick={() => toggleExpandFrame(item.frameUid)}
                    style={{
                      height: `${ROW_HEIGHT}px`,
                      minHeight: `${ROW_HEIGHT}px`,
                      maxHeight: `${ROW_HEIGHT}px`,
                      backgroundColor: isReplayCursorRow
                        ? 'var(--status-focus-bg)'
                        : item.isExpanded
                          ? 'var(--bg-row-selected)'
                          : item.baseIdx % 2 === 1
                            ? 'var(--bg-row-alt)'
                            : 'var(--bg-panel)',
                      borderBottom: '1px solid var(--border-grid)',
                      borderLeft: isReplayCursorRow ? '3px solid var(--status-focus)' : undefined,
                    }}
                    className={`grid ${gridTemplateClass} items-center hover:!bg-[var(--bg-row-hover)] cursor-pointer overflow-hidden whitespace-nowrap ${
                      isReplayCursorRow ? 'font-semibold text-[var(--status-focus)]' : ''
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
                          <span style={{ color: 'var(--text-primary)' }}>{muxSym.baseName}</span>
                          {muxSym.muxSuffix !== null && (
                            <span className="font-mono tabular-nums" style={{ color: 'var(--status-focus)' }}>
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
                        row.isTx ? 'text-[var(--status-focus)] font-semibold' : ''
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
        data-tour="trace.status"
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
          <span className="text-[var(--border-strong)]">|</span>
          <span className="text-rose-400 font-semibold">ERR: {sess.errCaptured.toLocaleString('en-US')}</span>
        </div>
      </div>
    </div>
  );
};
