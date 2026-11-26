import { copyMenuText, openContextMenu } from './ContextMenu';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Edit3,
  Keyboard,
  Pause,
  Plus,
  RotateCcw,
  Send,
  Copy,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';
import { useI18n, type TranslationKey } from '../i18n';
import { GuideInfoButton, GuideTourButton, GuideWhyLink } from '../onboarding/GuideButtons';
import { GuideStrip } from '../onboarding/GuideStrip';
import {
  CAN_ERR_MASK,
  decodeCanErrorFields,
  formatErrorFrameShortTitle,
} from '../utils/canErrorDecoder';
import {
  apiListPeriodicTx,
  apiResetTelemetry,
  apiStopPeriodicTx,
  apiTransmitRawFrame,
  apiTransmitSignalFrame,
} from '../services/ipcClient';
import { describeTxError } from '../store/busTxControl';
import { databaseStore, useDatabaseStore } from '../store/databaseStore';
import { plotStore } from '../store/plotStore';
import { workbenchStore } from '../store/workbenchStore';
import { projectStore, useProjectStore } from '../store/projectStore';
import { cloudBridgeStore } from '../store/cloudBridgeStore';
import { isExperimentalCloudEnabled } from '../store/experimentalStore';
import {
  telemetryStore,
  useTelemetryFrames,
  useTelemetryHeader,
} from '../store/telemetryStore';
import {
  type TxListEntry,
  transmitStore,
  useTransmitStore,
} from '../store/transmitStore';
import type { DeviceDescriptorDto } from '../types/hal';
import type { MessageSchemaDto, SignalSchemaDto } from '../types/netdb';
import type { FrameTelemetryDto, LiveSignalDto } from '../types/telemetry';
import {
  extractJ1939Fields,
  formatByteHex,
  formatMuxRanges,
  formatPcanIdHex,
  formatPhysicalValue,
  formatRawHex,
  isByteRecentlyChanged,
} from '../utils/formatters';
import {
  buildFrameInstanceKey,
  formatMultiplexedSymbol,
  resolveMuxChainFromSignalValues,
} from '../utils/muxFormat';
import {
  type ClipboardFrame,
  formatFrameLine,
  formatFrameLines,
  frameClipboard,
  isValidFdLength,
  nextValidFdLength,
  parseFrameLines,
} from '../utils/frameClipboard';
import { QuickPlotButton } from './PlotterView';
import type { StatusBanner } from './TopBar';
import { TxMessageModal } from './TxMessageModal';

interface ReceiveTransmitViewProps {
  devices: readonly DeviceDescriptorDto[];
  bitrateProfileId: string;
  mockFpsPreset: number | null;
  statusBanner: StatusBanner | null;
  onStatusMessage: (msg: StatusBanner) => void;
  onSwitchToActiveTx: (targetBusId?: number) => Promise<void>;
  panicCounter: number;
}

type RxColumnMode = 'CAN' | 'CAN_DEC' | 'J1939';

export type RxColumnId =
  | 'bus'
  | 'type'
  | 'id'
  | 'idDec'
  | 'pgn'
  | 'sa'
  | 'dlc'
  | 'symbol'
  | 'data'
  | 'cycle'
  | 'count';

export const DEFAULT_RX_COLUMN_ORDER: readonly RxColumnId[] = [
  'bus',
  'type',
  'id',
  'idDec',
  'pgn',
  'sa',
  'dlc',
  'symbol',
  'data',
  'cycle',
  'count',
];

export const DEFAULT_RX_COLUMN_WIDTHS: Readonly<Record<RxColumnId, number | null>> = {
  bus: 38,
  type: 58,
  id: 82,
  idDec: 68,
  pgn: 68,
  sa: 44,
  dlc: 42,
  symbol: 190,
  data: null,
  cycle: 86,
  count: 74,
};

export type TxColumnId =
  | 'bus'
  | 'type'
  | 'id'
  | 'dlc'
  | 'symbol'
  | 'data'
  | 'cycle'
  | 'count'
  | 'trigger'
  | 'comment';

export const DEFAULT_TX_COLUMN_ORDER: readonly TxColumnId[] = [
  'bus',
  'type',
  'id',
  'dlc',
  'symbol',
  'data',
  'cycle',
  'count',
  'trigger',
  'comment',
];

export const DEFAULT_TX_COLUMN_WIDTHS: Readonly<Record<TxColumnId, number | null>> = {
  bus: 38,
  type: 54,
  id: 82,
  dlc: 42,
  symbol: 190,
  data: null,
  cycle: 84,
  count: 74,
  trigger: 116,
  comment: 190,
};

const RX_COLUMN_KEYS: Record<
  RxColumnId,
  { labelKey: TranslationKey; align: 'left' | 'right'; font?: 'font-sans' | 'font-mono' }
> = {
  bus: { labelKey: 'rxtx.col.bus', align: 'left' },
  type: { labelKey: 'rxtx.col.type', align: 'left' },
  id: { labelKey: 'rxtx.col.id', align: 'left' },
  idDec: { labelKey: 'rxtx.col.idDec', align: 'right' },
  pgn: { labelKey: 'rxtx.col.pgn', align: 'left' },
  sa: { labelKey: 'rxtx.col.sa', align: 'left' },
  dlc: { labelKey: 'rxtx.col.dlc', align: 'right' },
  symbol: { labelKey: 'rxtx.col.symbol', align: 'left', font: 'font-sans' },
  data: { labelKey: 'rxtx.col.data', align: 'left' },
  cycle: { labelKey: 'rxtx.col.cycle', align: 'right' },
  count: { labelKey: 'rxtx.col.count', align: 'right' },
};

const TX_COLUMN_KEYS: Record<
  TxColumnId,
  { labelKey: TranslationKey; align: 'left' | 'right'; font?: 'font-sans' | 'font-mono' }
> = {
  bus: { labelKey: 'rxtx.col.bus', align: 'left' },
  type: { labelKey: 'rxtx.col.type', align: 'left' },
  id: { labelKey: 'rxtx.col.id', align: 'left' },
  dlc: { labelKey: 'rxtx.col.dlc', align: 'right' },
  symbol: { labelKey: 'rxtx.col.symbol', align: 'left', font: 'font-sans' },
  data: { labelKey: 'rxtx.col.data', align: 'left' },
  cycle: { labelKey: 'rxtx.col.cycle', align: 'right' },
  count: { labelKey: 'rxtx.col.count', align: 'right' },
  trigger: { labelKey: 'rxtx.col.trigger', align: 'left', font: 'font-sans' },
  comment: { labelKey: 'rxtx.col.comment', align: 'left', font: 'font-sans' },
};

const COLUMN_STORAGE_KEY = 'nexuscan:rxtxColumnLayout:v1';

interface PersistedColumnLayout {
  rxOrder?: string[];
  rxWidths?: Record<string, number | null>;
  txOrder?: string[];
  txWidths?: Record<string, number | null>;
}

function loadPersistedColumnLayout(): {
  rxOrder: RxColumnId[];
  rxWidths: Record<RxColumnId, number | null>;
  txOrder: TxColumnId[];
  txWidths: Record<TxColumnId, number | null>;
} {
  const rxOrder: RxColumnId[] = [...DEFAULT_RX_COLUMN_ORDER];
  const rxWidths: Record<RxColumnId, number | null> = { ...DEFAULT_RX_COLUMN_WIDTHS };
  const txOrder: TxColumnId[] = [...DEFAULT_TX_COLUMN_ORDER];
  const txWidths: Record<TxColumnId, number | null> = { ...DEFAULT_TX_COLUMN_WIDTHS };

  if (typeof window === 'undefined') {
    return { rxOrder, rxWidths, txOrder, txWidths };
  }

  try {
    const raw = localStorage.getItem(COLUMN_STORAGE_KEY);
    if (!raw) return { rxOrder, rxWidths, txOrder, txWidths };
    const parsed = JSON.parse(raw) as PersistedColumnLayout;

    if (Array.isArray(parsed.rxOrder)) {
      const validCols = parsed.rxOrder.filter((c): c is RxColumnId =>
        DEFAULT_RX_COLUMN_ORDER.includes(c as RxColumnId),
      );
      for (const c of DEFAULT_RX_COLUMN_ORDER) {
        if (!validCols.includes(c)) validCols.push(c);
      }
      rxOrder.length = 0;
      rxOrder.push(...validCols);
    }

    if (parsed.rxWidths && typeof parsed.rxWidths === 'object') {
      for (const col of DEFAULT_RX_COLUMN_ORDER) {
        const val = parsed.rxWidths[col];
        if (val === null) {
          rxWidths[col] = null;
        } else if (typeof val === 'number' && Number.isFinite(val)) {
          rxWidths[col] = Math.max(34, Math.min(900, Math.round(val)));
        }
      }
    }

    if (Array.isArray(parsed.txOrder)) {
      const validCols = parsed.txOrder.filter((c): c is TxColumnId =>
        DEFAULT_TX_COLUMN_ORDER.includes(c as TxColumnId),
      );
      for (const c of DEFAULT_TX_COLUMN_ORDER) {
        if (!validCols.includes(c)) validCols.push(c);
      }
      txOrder.length = 0;
      txOrder.push(...validCols);
    }

    if (parsed.txWidths && typeof parsed.txWidths === 'object') {
      for (const col of DEFAULT_TX_COLUMN_ORDER) {
        const val = parsed.txWidths[col];
        if (val === null) {
          txWidths[col] = null;
        } else if (typeof val === 'number' && Number.isFinite(val)) {
          txWidths[col] = Math.max(34, Math.min(900, Math.round(val)));
        }
      }
    }
  } catch {
    // Ignore JSON errors
  }

  return { rxOrder, rxWidths, txOrder, txWidths };
}

function savePersistedColumnLayout(partial: Partial<PersistedColumnLayout>): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = localStorage.getItem(COLUMN_STORAGE_KEY);
    const existing: PersistedColumnLayout = raw ? (JSON.parse(raw) as PersistedColumnLayout) : {};
    const merged: PersistedColumnLayout = {
      ...existing,
      ...partial,
      rxWidths: partial.rxWidths ?? existing.rxWidths,
      txWidths: partial.txWidths ?? existing.txWidths,
    };
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Ignore storage quota errors
  }
}

function getColumnLabel(
  table: 'rx' | 'tx',
  colId: string,
  translate: (k: TranslationKey) => string,
): string {
  if (table === 'rx') {
    const def = RX_COLUMN_KEYS[colId as RxColumnId];
    return def ? translate(def.labelKey) : colId;
  }
  const def = TX_COLUMN_KEYS[colId as TxColumnId];
  return def ? translate(def.labelKey) : colId;
}

function getFrameTypeTag(
  frame: { isFd: boolean; dlc: number; isTx?: boolean; isError?: boolean },
  msgSchema?: MessageSchemaDto,
): { label: string; cls: string } {
  if (frame.isError) {
    return {
      label: 'ERR',
      cls: 'pcan-tag font-bold text-[var(--status-critical)] bg-[var(--status-critical-bg)] border border-[var(--status-critical-border)]',
    };
  }
  const proto = msgSchema?.protocol.toUpperCase() ?? '';
  const txSuffix = frame.isTx ? '·Tx' : '';
  if (proto.includes('J1939')) {
    return { label: `J1939${txSuffix}`, cls: 'pcan-tag pcan-tag-j1939' };
  }
  if (frame.isFd || proto.includes('FD') || frame.dlc > 8) {
    return { label: `FD${txSuffix}`, cls: 'pcan-tag pcan-tag-fd' };
  }
  return { label: `CC${txSuffix}`, cls: 'pcan-tag pcan-tag-cc' };
}

function formatHexDumpTooltip(rawBytes: readonly number[], byteLen: number): string {
  const lines: string[] = [];
  for (let start = 0; start < byteLen; start += 16) {
    const end = Math.min(byteLen, start + 16);
    const chunk: string[] = [];
    for (let i = start; i < end; i++) {
      chunk.push(formatByteHex(rawBytes[i] ?? 0));
    }
    lines.push(`[${start.toString().padStart(2, '0')}..${(end - 1).toString().padStart(2, '0')}]: ${chunk.join(' ')}`);
  }
  return lines.join('\n');
}

function buildActiveSignalTupleList(
  msgSchema: MessageSchemaDto,
  signalsById: readonly (SignalSchemaDto | undefined)[],
  signalValues: Readonly<Record<number, number>>,
): [number, number][] {
  const isSigActive = (sig: SignalSchemaDto, depth: number): boolean => {
    if (depth > 10) return false;
    if (sig.muxRole === 'static' || sig.muxRole === 'masterSwitch') return true;
    if (sig.switchSignalId === null) return true;
    const sw = signalsById[sig.switchSignalId];
    if (!sw || !isSigActive(sw, depth + 1)) return false;
    const swPhys = signalValues[sw.signalId] ?? sw.initialValue ?? 0;
    const swRaw =
      sw.factor !== 0
        ? Math.round((swPhys - sw.offset) / sw.factor)
        : Math.round(swPhys);
    return sig.muxRanges.some(([s, e]) => swRaw >= s && swRaw <= e);
  };

  const tuples: [number, number][] = [];
  for (const sigId of msgSchema.signalIds) {
    const sig = signalsById[sigId];
    if (!sig || !isSigActive(sig, 0)) continue;
    const val = signalValues[sigId] ?? sig.initialValue ?? 0;
    tuples.push([sigId, Number.isFinite(val) ? val : 0]);
  }
  return tuples;
}

function updateExpandedRows(previous: Set<string>, keys: readonly string[], expanded: boolean): Set<string> {
  const next = new Set(previous);
  for (const key of keys) {
    if (expanded) next.add(key);
    else next.delete(key);
  }
  return next;
}

function getTxMessageSchema(entry: TxListEntry): MessageSchemaDto | undefined {
  if (entry.mode !== 'symbolic') return undefined;
  return databaseStore.getMessageForBus(entry.busId, entry.messageKey ?? '', entry.arbId, entry.isExtended);
}

function focusMessagePane(event: React.MouseEvent<HTMLElement>): void {
  if (event.target instanceof Element && !event.target.closest('button, input, select, textarea, a, [contenteditable]')
    && !window.getSelection()?.toString()) {
    event.currentTarget.focus({ preventScroll: true });
  }
}

export const ReceiveTransmitView: React.FC<ReceiveTransmitViewProps> = ({
  bitrateProfileId: _bitrateProfileId,
  mockFpsPreset: _mockFpsPreset,
  onStatusMessage,
  onSwitchToActiveTx,
  panicCounter,
}) => {
  const { t } = useI18n();
  const dbState = useDatabaseStore();
  const header = useTelemetryHeader();
  const framesSlice = useTelemetryFrames();
  const txState = useTransmitStore();
  const projState = useProjectStore();


  // Resizable Receive vs Transmit vertical split ratio
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const [rxHeightPct, setRxHeightPct] = useState<number>(60);
  const draggingRef = useRef<boolean>(false);

  // Receive pane controls (expandedRxKeys persisted in databaseStore for Project save/restore)
  const [rxFilter, setRxFilter] = useState<string>('');
  const [rxErrorsOnly, setRxErrorsOnly] = useState<boolean>(false);
  const [hiddenRxKeys, setHiddenRxKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [rxColumnMode, setRxColumnMode] = useState<RxColumnMode>('CAN');
  const expandedRxKeys = useMemo(
    () => new Set<string>(dbState.expandedRxKeys),
    [dbState.expandedRxKeys],
  );
  const setExpandedRxKeys = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)): void => {
      const prevSet = new Set<string>(databaseStore.getState().expandedRxKeys);
      const nextSet = typeof updater === 'function' ? updater(prevSet) : updater;
      databaseStore.setExpandedRxKeys(Array.from(nextSet));
    },
    [],
  );

  // Transmit pane controls & Modal
  const [expandedTxIds, setExpandedTxIds] = useState<Set<string>>(() => new Set());
  const [modalState, setModalState] = useState<{
    open: boolean;
    editing: TxListEntry | null;
  }>({ open: false, editing: null });
  const [busyTxIds, setBusyTxIds] = useState<Set<string>>(() => new Set());

  // Keyboard scope: last clicked/focused pane + RX row selection
  const [activePane, setActivePane] = useState<'rx' | 'tx' | null>(null);
  const [selectedRxKey, setSelectedRxKey] = useState<string | null>(null);
  const rxSectionRef = useRef<HTMLElement | null>(null);
  const txSectionRef = useRef<HTMLElement | null>(null);

  const [selectedRxKeys, setSelectedRxKeys] = useState<ReadonlySet<string> | null>(null);
  const [selectedTxIds, setSelectedTxIds] = useState<ReadonlySet<string> | null>(null);
  const multipleTxSelected = (selectedTxIds?.size ?? 0) > 1;

  useEffect(() => {
    if (!selectedTxIds) return;
    const current = txState.selectedEntryId;
    if (current === null || !selectedTxIds.has(current)) {
      setSelectedTxIds(null);
      return;
    }
    const surviving = new Set(txState.entries.filter((entry) => selectedTxIds.has(entry.id)).map((entry) => entry.id));
    if (surviving.size !== selectedTxIds.size) setSelectedTxIds(surviving.size > 1 ? surviving : null);
  }, [selectedTxIds, txState.entries, txState.selectedEntryId]);

  const selectRxRow = (key: string): void => {
    setSelectedRxKey(key);
    setSelectedRxKeys(null);
  };

  const selectTxRow = (id: string): void => {
    transmitStore.selectEntry(id);
    setSelectedTxIds(null);
  };

  const toggleRxRow = (key: string): void => {
    setExpandedRxKeys((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  const toggleTxRow = (id: string): void => {
    setExpandedTxIds((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  // Column layout state (order + widths) with localStorage persistence
  const [initialLayout] = useState(() => loadPersistedColumnLayout());
  const [rxColumnOrder, setRxColumnOrder] = useState<RxColumnId[]>(initialLayout.rxOrder);
  const [rxColumnWidths, setRxColumnWidths] = useState<Record<RxColumnId, number | null>>(
    initialLayout.rxWidths,
  );
  const [txColumnOrder, setTxColumnOrder] = useState<TxColumnId[]>(initialLayout.txOrder);
  const [txColumnWidths, setTxColumnWidths] = useState<Record<TxColumnId, number | null>>(
    initialLayout.txWidths,
  );

  const visibleRxCols = useMemo(() => {
    return rxColumnOrder.filter((col) => {
      if (col === 'idDec') return rxColumnMode === 'CAN_DEC';
      if (col === 'pgn' || col === 'sa') return rxColumnMode === 'J1939';
      return true;
    });
  }, [rxColumnOrder, rxColumnMode]);

  const visibleTxCols = txColumnOrder;

  // Cached translated column labels to eliminate string allocation in table loops (60 FPS discipline)
  const rxColLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of visibleRxCols) {
      map[c] = t(RX_COLUMN_KEYS[c].labelKey);
    }
    return map;
  }, [visibleRxCols, t]);

  const txColLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of visibleTxCols) {
      map[c] = t(TX_COLUMN_KEYS[c].labelKey);
    }
    return map;
  }, [visibleTxCols, t]);

  // Static loop text constants resolved outside rows
  const strWait = t('rxtx.common.wait');
  const strManual = t('rxtx.tx.manual');
  const strPeriodic = t('rxtx.tx.periodic');
  const strPaused = t('rxtx.tx.paused');
  const strSend = t('rxtx.common.send');
  const strCustomRaw = t('rxtx.tx.customRaw');

  const isRxLayoutModified = useMemo(() => {
    if (rxColumnOrder.length !== DEFAULT_RX_COLUMN_ORDER.length) return true;
    for (let i = 0; i < rxColumnOrder.length; i++) {
      if (rxColumnOrder[i] !== DEFAULT_RX_COLUMN_ORDER[i]) return true;
    }
    for (const col of DEFAULT_RX_COLUMN_ORDER) {
      if (rxColumnWidths[col] !== DEFAULT_RX_COLUMN_WIDTHS[col]) return true;
    }
    return false;
  }, [rxColumnOrder, rxColumnWidths]);

  const isTxLayoutModified = useMemo(() => {
    if (txColumnOrder.length !== DEFAULT_TX_COLUMN_ORDER.length) return true;
    for (let i = 0; i < txColumnOrder.length; i++) {
      if (txColumnOrder[i] !== DEFAULT_TX_COLUMN_ORDER[i]) return true;
    }
    for (const col of DEFAULT_TX_COLUMN_ORDER) {
      if (txColumnWidths[col] !== DEFAULT_TX_COLUMN_WIDTHS[col]) return true;
    }
    return false;
  }, [txColumnOrder, txColumnWidths]);

  const handleResetRxLayout = useCallback(() => {
    const nextOrder = [...DEFAULT_RX_COLUMN_ORDER];
    const nextWidths = { ...DEFAULT_RX_COLUMN_WIDTHS };
    setRxColumnOrder(nextOrder);
    setRxColumnWidths(nextWidths);
    savePersistedColumnLayout({ rxOrder: nextOrder, rxWidths: nextWidths });
  }, []);

  const handleResetTxLayout = useCallback(() => {
    const nextOrder = [...DEFAULT_TX_COLUMN_ORDER];
    const nextWidths = { ...DEFAULT_TX_COLUMN_WIDTHS };
    setTxColumnOrder(nextOrder);
    setTxColumnWidths(nextWidths);
    savePersistedColumnLayout({ txOrder: nextOrder, txWidths: nextWidths });
  }, []);

  // Column drag-to-reorder and right-edge resize state
  const pendingDragRef = useRef<{
    table: 'rx' | 'tx';
    colId: string;
    startX: number;
    startY: number;
  } | null>(null);

  const activeDragRef = useRef<{
    table: 'rx' | 'tx';
    sourceCol: string;
    overCol: string;
    side: 'before' | 'after';
    clientX: number;
    clientY: number;
  } | null>(null);
  const [activeDrag, setActiveDrag] = useState<{
    table: 'rx' | 'tx';
    sourceCol: string;
    overCol: string;
    side: 'before' | 'after';
    clientX: number;
    clientY: number;
  } | null>(null);

  const activeResizeRef = useRef<{
    table: 'rx' | 'tx';
    colId: string;
    startX: number;
    startWidth: number;
  } | null>(null);

  const handleHeaderPointerDown = (
    e: React.PointerEvent,
    table: 'rx' | 'tx',
    colId: string,
  ): void => {
    if (e.button !== 0) return;
    pendingDragRef.current = {
      table,
      colId,
      startX: e.clientX,
      startY: e.clientY,
    };
  };

  const handleResizePointerDown = (
    e: React.PointerEvent,
    table: 'rx' | 'tx',
    colId: string,
  ): void => {
    e.stopPropagation();
    e.preventDefault();
    pendingDragRef.current = null;

    const currentW =
      table === 'rx'
        ? rxColumnWidths[colId as RxColumnId]
        : txColumnWidths[colId as TxColumnId];

    let startWidth: number;
    if (currentW !== null) {
      startWidth = currentW;
    } else {
      const th = e.currentTarget.parentElement as HTMLElement | null;
      startWidth = th ? th.getBoundingClientRect().width : 100;
    }

    activeResizeRef.current = {
      table,
      colId,
      startX: e.clientX,
      startWidth,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handleResetColumnWidth = (
    e: React.MouseEvent,
    table: 'rx' | 'tx',
    colId: string,
  ): void => {
    e.stopPropagation();
    e.preventDefault();
    if (table === 'rx') {
      const defW = DEFAULT_RX_COLUMN_WIDTHS[colId as RxColumnId];
      setRxColumnWidths((prev) => {
        const next = { ...prev, [colId]: defW };
        savePersistedColumnLayout({ rxWidths: next });
        return next;
      });
    } else {
      const defW = DEFAULT_TX_COLUMN_WIDTHS[colId as TxColumnId];
      setTxColumnWidths((prev) => {
        const next = { ...prev, [colId]: defW };
        savePersistedColumnLayout({ txWidths: next });
        return next;
      });
    }
  };

  useEffect(() => {
    const onWindowPointerMove = (e: PointerEvent): void => {
      // 1. Column resize
      if (activeResizeRef.current) {
        const { table, colId, startX, startWidth } = activeResizeRef.current;
        const delta = e.clientX - startX;
        const newWidth = Math.max(34, Math.min(900, Math.round(startWidth + delta)));
        if (table === 'rx') {
          setRxColumnWidths((prev) => ({ ...prev, [colId]: newWidth }));
        } else {
          setTxColumnWidths((prev) => ({ ...prev, [colId]: newWidth }));
        }
        return;
      }

      // 2. Active column drag
      if (activeDragRef.current) {
        const cur = activeDragRef.current;
        cur.clientX = e.clientX;
        cur.clientY = e.clientY;

        const thElements = document.querySelectorAll<HTMLTableCellElement>(
          `th[data-${cur.table}-col]`,
        );
        for (let i = 0; i < thElements.length; i++) {
          const th = thElements[i];
          const rect = th.getBoundingClientRect();
          if (e.clientX >= rect.left && e.clientX <= rect.right) {
            const col = th.getAttribute(`data-${cur.table}-col`);
            if (col) {
              const mid = rect.left + rect.width / 2;
              cur.overCol = col;
              cur.side = e.clientX < mid ? 'before' : 'after';
            }
            break;
          }
        }
        setActiveDrag({ ...cur });
        return;
      }

      // 3. Pending drag threshold (>= 4px)
      if (pendingDragRef.current) {
        const p = pendingDragRef.current;
        const dx = e.clientX - p.startX;
        const dy = e.clientY - p.startY;
        if (Math.hypot(dx, dy) >= 4) {
          activeDragRef.current = {
            table: p.table,
            sourceCol: p.colId,
            overCol: p.colId,
            side: 'before',
            clientX: e.clientX,
            clientY: e.clientY,
          };
          setActiveDrag({ ...activeDragRef.current });
          document.body.style.cursor = 'grabbing';
          document.body.style.userSelect = 'none';
        }
      }
    };

    const onWindowPointerUp = (): void => {
      if (activeResizeRef.current) {
        const { table } = activeResizeRef.current;
        activeResizeRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        if (table === 'rx') {
          setRxColumnWidths((latest) => {
            savePersistedColumnLayout({ rxWidths: latest });
            return latest;
          });
        } else {
          setTxColumnWidths((latest) => {
            savePersistedColumnLayout({ txWidths: latest });
            return latest;
          });
        }
      }

      if (activeDragRef.current) {
        const { table, sourceCol, overCol, side } = activeDragRef.current;
        activeDragRef.current = null;
        setActiveDrag(null);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        if (sourceCol !== overCol) {
          if (table === 'rx') {
            setRxColumnOrder((prev) => {
              const next = [...prev];
              const fromIdx = next.indexOf(sourceCol as RxColumnId);
              if (fromIdx < 0) return prev;
              next.splice(fromIdx, 1);
              const toIdx = next.indexOf(overCol as RxColumnId);
              if (toIdx < 0) return prev;
              const insertIdx = side === 'before' ? toIdx : toIdx + 1;
              next.splice(insertIdx, 0, sourceCol as RxColumnId);
              savePersistedColumnLayout({ rxOrder: next });
              return next;
            });
          } else {
            setTxColumnOrder((prev) => {
              const next = [...prev];
              const fromIdx = next.indexOf(sourceCol as TxColumnId);
              if (fromIdx < 0) return prev;
              next.splice(fromIdx, 1);
              const toIdx = next.indexOf(overCol as TxColumnId);
              if (toIdx < 0) return prev;
              const insertIdx = side === 'before' ? toIdx : toIdx + 1;
              next.splice(insertIdx, 0, sourceCol as TxColumnId);
              savePersistedColumnLayout({ txOrder: next });
              return next;
            });
          }
        }
      }

      pendingDragRef.current = null;
    };

    const onWindowCancel = (): void => {
      activeResizeRef.current = null;
      activeDragRef.current = null;
      pendingDragRef.current = null;
      setActiveDrag(null);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowCancel);
    return () => {
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowCancel);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  // Splitter pointer drag handling
  useEffect(() => {
    const onPointerMove = (ev: PointerEvent): void => {
      if (!draggingRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      if (rect.height <= 0) return;
      const pct = ((ev.clientY - rect.top) / rect.height) * 100;
      setRxHeightPct(Math.max(22, Math.min(80, pct)));
    };
    const onPointerUp = (): void => {
      draggingRef.current = false;
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  // Poll backend periodic TX jobs every 250ms while any periodic TX entry is enabled
  const anyPeriodicActive = txState.entries.some((e) => e.periodicEnabled);
  useEffect(() => {
    let cancelled = false;
    const syncJobs = async (): Promise<void> => {
      try {
        const jobs = await apiListPeriodicTx();
        if (!cancelled) {
          transmitStore.syncBackendPeriodicJobs(jobs, (busId) => databaseStore.getBusSchema(busId));
        }
      } catch {
        // Ignore transient offline errors
      }
    };
    void syncJobs();
    if (!anyPeriodicActive) {
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setInterval(() => {
      void syncJobs();
    }, 250);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [anyPeriodicActive, panicCounter]);

  // All live bus frames (including TX loopback / self-received frames so TX is observable in Receive!)
  const rxFrames: readonly FrameTelemetryDto[] = useMemo(() => {
    const q = rxFilter.trim().toLowerCase();
    const out: FrameTelemetryDto[] = [];

    for (const f of framesSlice.frames) {
      if ((rxErrorsOnly && !f.isError) || (hiddenRxKeys.size > 0 && hiddenRxKeys.has(buildFrameInstanceKey(f)))) {
        continue;
      }

      const msgSchema = databaseStore.getMessageForBus(f.busId, f.messageKey, f.arbId, f.isExtended);
      const signalsById = databaseStore.getBusSignals(f.busId);
      const muxSym = formatMultiplexedSymbol(msgSchema, signalsById, f.activeMuxSwitches);

      if (q.length > 0) {
        if (f.isError) {
          const errTitle = formatErrorFrameShortTitle(f.arbId, f.rawBytes, f.errorSummary).toLowerCase();
          const idHex = (f.arbId & CAN_ERR_MASK).toString(16).toLowerCase();
          const busLabel = `bus ${f.busId + 1}`.toLowerCase();
          if (!errTitle.includes(q) && !idHex.includes(q) && !busLabel.includes(q) && !q.includes('err')) {
            continue;
          }
        } else {
          const idHex = formatPcanIdHex(f.arbId, f.isExtended).toLowerCase();
          const idDec = String(f.arbId);
          const sym = (msgSchema?.name ?? '').toLowerCase();
          const fullMuxSym = muxSym.fullSymbol.toLowerCase();
          const busLabel = `bus ${f.busId + 1}`.toLowerCase();
          let sigMatch = false;
          if (msgSchema) {
            for (const sigId of msgSchema.signalIds) {
              const s = signalsById[sigId];
              if (s && s.name.toLowerCase().includes(q)) {
                sigMatch = true;
                break;
              }
            }
          }
          if (
            !idHex.includes(q) &&
            !idDec.includes(q) &&
            !sym.includes(q) &&
            !fullMuxSym.includes(q) &&
            !busLabel.includes(q) &&
            !sigMatch
          ) {
            continue;
          }
        }
      }

      out.push(f);
    }

    out.sort((a, b) => {
      if (a.busId !== b.busId) return a.busId - b.busId;
      if (a.arbId !== b.arbId) return a.arbId - b.arbId;
      if (a.isExtended !== b.isExtended) return Number(a.isExtended) - Number(b.isExtended);
      const keyA = buildFrameInstanceKey(a);
      const keyB = buildFrameInstanceKey(b);
      return keyA.localeCompare(keyB);
    });

    return out;
  }, [framesSlice.frames, rxFilter, rxErrorsOnly, hiddenRxKeys, dbState.busSchemas]);

  // Transmit execution helper (single-shot or start periodic)
  const sendTxEntry = useCallback(
    async (entry: TxListEntry, startPeriodic: boolean): Promise<void> => {
      const busHealth = header.buses.find(
        (b) => b.busId === entry.busId && b.connected,
      );
      if (!busHealth) {
        onStatusMessage({
          kind: 'error',
          message: t('rxtx.status.cannotTxDisconnected', { bus: entry.busId + 1 }),
        });
        return;
      }
      if (busHealth.listenOnly || !busHealth.txArmed) {
        onStatusMessage({
          kind: 'error',
          message: t('rxtx.status.txLocked', {
            bus: entry.busId + 1,
            mode: busHealth.listenOnly
              ? t('rxtx.busBadge.listenOnly')
              : t('rxtx.busBadge.txDisarmed'),
          }),
        });
        return;
      }

      setBusyTxIds((prev) => new Set(prev).add(entry.id));
      try {
        const periodicMs = startPeriodic ? Math.max(5, entry.cycleTimeMs || 100) : null;
        const jobLabel = startPeriodic
          ? entry.symbolName || `0x${formatPcanIdHex(entry.arbId, entry.isExtended)}`
          : null;

        const msgSchema =
          entry.mode === 'symbolic'
            ? databaseStore.getMessageForBus(
                entry.busId,
                entry.messageKey ?? '',
                entry.arbId,
                entry.isExtended,
              )
            : undefined;

        const res =
          entry.mode === 'symbolic' && msgSchema
            ? await apiTransmitSignalFrame({
                busId: entry.busId,
                arbId: entry.arbId,
                isExtended: entry.isExtended,
                signalValues: buildActiveSignalTupleList(
                  msgSchema,
                  databaseStore.getBusSignals(entry.busId),
                  entry.signalValues,
                ),
                periodicMs,
                jobLabel,
              })
            : await apiTransmitRawFrame({
                busId: entry.busId,
                arbId: entry.arbId,
                isExtended: entry.isExtended,
                isFd: entry.isFd,
                isBrs: entry.isBrs,
                data: entry.rawBytes.slice(0, entry.dlc),
                periodicMs,
                jobLabel,
              });

        transmitStore.updateEntry(entry.id, (prev) => ({
          ...prev,
          dlc: res.encodedDlc,
          rawBytes: res.encodedBytes.slice(0, res.encodedDlc),
          cycleTimeMs: startPeriodic && prev.cycleTimeMs === 0 ? 100 : prev.cycleTimeMs,
          periodicEnabled: startPeriodic ? true : prev.periodicEnabled,
          backendJobId: startPeriodic ? res.jobId : prev.backendJobId,
          manualSentCount: startPeriodic ? prev.manualSentCount : prev.manualSentCount + 1,
        }));
      } catch (err) {
        onStatusMessage({
          kind: 'error',
          message: t('rxtx.status.txFailed', {
            error: err instanceof Error ? err.message : String(err),
          }),
        });
      } finally {
        setBusyTxIds((prev) => {
          const next = new Set(prev);
          next.delete(entry.id);
          return next;
        });
      }
    },
    [header.buses, onStatusMessage, t],
  );

  const handleTogglePeriodicCheckbox = async (entry: TxListEntry): Promise<void> => {
    if (busyTxIds.has(entry.id)) return;

    if (entry.periodicEnabled) {
      setBusyTxIds((prev) => new Set(prev).add(entry.id));
      try {
        if (entry.backendJobId !== null) {
          await apiStopPeriodicTx(entry.backendJobId).catch(() => undefined);
        } else {
          const jobs = await apiListPeriodicTx().catch(() => []);
          for (const j of jobs) {
            if (
              j.busId === entry.busId &&
              j.arbId === entry.arbId &&
              j.isExtended === entry.isExtended
            ) {
              await apiStopPeriodicTx(j.jobId).catch(() => undefined);
            }
          }
        }
        transmitStore.updateEntry(entry.id, (prev) => ({
          ...prev,
          periodicEnabled: false,
          backendJobId: null,
        }));
      } finally {
        setBusyTxIds((prev) => {
          const next = new Set(prev);
          next.delete(entry.id);
          return next;
        });
      }
      return;
    }

    await sendTxEntry(entry, true);
  };

  const handlePauseAllTx = async (): Promise<void> => {
    const activeEntries = txState.entries.filter(
      (e) => e.periodicEnabled && e.backendJobId !== null,
    );
    for (const e of activeEntries) {
      if (e.backendJobId !== null) {
        try {
          await apiStopPeriodicTx(e.backendJobId);
        } catch {
          // Ignore
        }
      }
    }
    transmitStore.markAllPaused();
    onStatusMessage({
      kind: 'info',
      message: t('rxtx.status.pausedPeriodic', { count: activeEntries.length }),
    });
  };

  const handleDeleteTx = async (id: string): Promise<void> => {
    const entry = transmitStore.getState().entries.find((item) => item.id === id);
    if (!entry || busyTxIds.has(id)) return;
    setBusyTxIds((previous) => new Set(previous).add(id));
    try {
      if (entry.backendJobId !== null) {
        await apiStopPeriodicTx(entry.backendJobId);
      }
      transmitStore.removeEntry(id);
    } catch (error) {
      onStatusMessage({
        kind: 'error',
        message: t('context.deleteTxFailed', { error: describeTxError(error) }),
      });
    } finally {
      setBusyTxIds((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  };

  const handleDeleteSelectedTx = async (): Promise<void> => {
    const id = transmitStore.getState().selectedEntryId;
    if (id !== null) await handleDeleteTx(id);
  };

  const hideRxRows = (keys: ReadonlySet<string>): void => {
    if (keys.size === 0) return;
    setHiddenRxKeys((previous) => new Set([...previous, ...keys]));
    setSelectedRxKey((selected) => selected !== null && keys.has(selected) ? null : selected);
    setSelectedRxKeys((selected) => {
      if (!selected) return null;
      const remaining = new Set([...selected].filter((key) => !keys.has(key)));
      return remaining.size > 0 ? remaining : null;
    });
  };

  const handleClearReceive = async (): Promise<void> => {
    await apiResetTelemetry().catch(() => undefined);
    telemetryStore.clearAllTelemetry();
    setHiddenRxKeys(new Set());
    setSelectedRxKeys(null);
    setSelectedRxKey(null);
    transmitStore.resetCounters();
    onStatusMessage({
      kind: 'info',
      message: t('rxtx.status.clearedRx'),
    });
  };

  const handleResetTxCounts = (): void => {
    transmitStore.resetCounters();
    onStatusMessage({
      kind: 'info',
      message: t('rxtx.status.resetTxCounts'),
    });
  };

  const handleClearTxList = async (): Promise<void> => {
    const activeEntries = txState.entries.filter(
      (e) => e.periodicEnabled && e.backendJobId !== null,
    );
    for (const e of activeEntries) {
      if (e.backendJobId !== null) {
        try {
          await apiStopPeriodicTx(e.backendJobId);
        } catch {
          // Ignore
        }
      }
    }
    transmitStore.clearAllEntries();
    onStatusMessage({
      kind: 'info',
      message: t('rxtx.status.clearedTxList'),
    });
  };

  const handleSaveModalEntry = async (saved: TxListEntry): Promise<void> => {
    const existing = txState.entries.find((e) => e.id === saved.id);
    if (existing?.periodicEnabled && existing.backendJobId !== null) {
      try {
        await apiStopPeriodicTx(existing.backendJobId);
      } catch {
        // Ignore
      }
      const resetEntry: TxListEntry = {
        ...saved,
        periodicEnabled: false,
        backendJobId: null,
      };
      transmitStore.updateEntry(saved.id, () => resetEntry);
      setModalState({ open: false, editing: null });
      if (saved.cycleTimeMs > 0) {
        await sendTxEntry(resetEntry, true);
      }
      return;
    }

    if (existing) {
      transmitStore.updateEntry(saved.id, () => saved);
    } else {
      transmitStore.addEntry(saved);
    }
    setModalState({ open: false, editing: null });
  };

  const selectedTxEntry = multipleTxSelected
    ? null
    : txState.entries.find((entry) => entry.id === txState.selectedEntryId) ?? null;

  // ── Keyboard: RX frame clipboard, TX paste, list navigation ───────────────
  const buildClipFromRx = (f: FrameTelemetryDto): ClipboardFrame | 'invalid' | null => {
    if (f.isError) return null;
    const rawLen = Math.min(f.dlc, f.rawBytes.length);
    let len = rawLen;
    if (f.isFd) {
      if (!isValidFdLength(len)) {
        const up = nextValidFdLength(len);
        if (up === null) return 'invalid';
        len = up;
      }
    } else if (len > 8) {
      return 'invalid';
    }
    const bytes: number[] = [];
    for (let i = 0; i < len; i++) bytes.push(f.rawBytes[i] ?? 0);
    const schema = databaseStore.getMessageForBus(f.busId, f.messageKey, f.arbId, f.isExtended);
    return {
      busId: f.busId,
      arbId: f.arbId,
      isExtended: f.isExtended,
      isFd: f.isFd,
      isBrs: f.isFd && f.isBrs,
      len,
      bytes,
      symbolName: schema?.name ?? '',
    };
  };

  const collectRxClips = (clickedRowKey?: string): { frames: ClipboardFrame[]; skipped: number } => {
    const keys = clickedRowKey && !selectedRxKeys?.has(clickedRowKey)
      ? new Set([clickedRowKey])
      : selectedRxKeys ?? new Set(selectedRxKey === null ? [] : [selectedRxKey]);
    const frames: ClipboardFrame[] = [];
    let skipped = 0;
    let hasInvalidPayload = false;
    for (const frame of rxFrames) {
      if (!keys.has(buildFrameInstanceKey(frame))) continue;
      const clip = buildClipFromRx(frame);
      if (!clip || clip === 'invalid') {
        skipped += 1;
        if (clip === 'invalid') hasInvalidPayload = true;
      } else {
        frames.push(clip);
      }
    }
    if (frames.length === 0) {
      onStatusMessage({
        kind: skipped > 0 ? 'error' : 'info',
        message: t(skipped === 0 ? 'rxtx.status.rxCopyNone'
          : hasInvalidPayload ? 'rxtx.status.rxCopyInvalid' : 'rxtx.status.rxCopyError'),
      });
    }
    return { frames, skipped };
  };

  const copySelectedRx = async (clickedRowKey?: string): Promise<void> => {
    const { frames, skipped } = collectRxClips(clickedRowKey);
    if (frames.length === 0) return;
    frameClipboard.set(frames);
    const text = formatFrameLines(frames);
    try {
      await navigator.clipboard.writeText(text);
      frameClipboard.markSystemSynced(frames);
    } catch {
      // The in-app clipboard preserves the batch when system clipboard access is denied.
    }
    onStatusMessage({
      kind: 'success',
      message: frames.length === 1 && skipped === 0
        ? t('rxtx.status.rxCopied', { line: text })
        : t('rxtx.status.rxCopiedBatch', { count: frames.length, skipped }),
    });
  };

  /** Prepares a manual TX entry with periodic TX off. */
  const makeTxEntryFromClip = (clip: ClipboardFrame): TxListEntry => {
    const selTx = txState.entries.find((e) => e.id === txState.selectedEntryId);
    const busId =
      clip.busId ?? selTx?.busId ?? header.buses.find((b) => b.connected)?.busId ?? 0;
    return {
      id: `tx-clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      busId,
      mode: 'raw',
      messageKey: null,
      arbId: clip.arbId,
      isExtended: clip.isExtended,
      isFd: clip.isFd,
      isBrs: clip.isFd && clip.isBrs,
      dlc: clip.len,
      symbolName: clip.symbolName,
      rawBytes: clip.bytes.slice(0, clip.len),
      signalValues: {},
      cycleTimeMs: 0,
      periodicEnabled: false,
      backendJobId: null,
      manualSentCount: 0,
      periodicSentCount: 0,
      creator: 'Clipboard',
      comment: '',
    };
  };

  const addTxEntriesFromClipboard = (frames: readonly ClipboardFrame[], skipped = 0): void => {
    if (frames.length === 0) return;
    transmitStore.addEntries(frames.map(makeTxEntryFromClip));
    onStatusMessage({
      kind: 'success',
      message: frames.length === 1 && skipped === 0
        ? t('rxtx.status.txAddedFromFrame', { line: formatFrameLine(frames[0]) })
        : t('rxtx.status.txAddedFromFrames', { count: frames.length, skipped }),
    });
  };

  const copySelectedRxToTx = (clickedRowKey?: string): void => {
    const { frames, skipped } = collectRxClips(clickedRowKey);
    addTxEntriesFromClipboard(frames, skipped);
  };

  const handlePasteToTx = async (): Promise<void> => {
    const { frames: localFrames, systemSynced } = frameClipboard.get();
    if (localFrames.length > 0 && !systemSynced) {
      addTxEntriesFromClipboard(localFrames);
      return;
    }
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      if (localFrames.length > 0) addTxEntriesFromClipboard(localFrames);
      else onStatusMessage({ kind: 'error', message: t('rxtx.status.pasteUnavailable') });
      return;
    }
    const normalizedText = text.replace(/\r\n/g, '\n').trim();
    const frames = localFrames.length > 0 &&
      (!normalizedText || normalizedText === formatFrameLines(localFrames))
      ? localFrames
      : parseFrameLines(normalizedText);
    if (!frames) {
      onStatusMessage({ kind: 'error', message: t('rxtx.status.pasteInvalid') });
      return;
    }
    addTxEntriesFromClipboard(frames);
  };

  const newTxMenuItem = {
    label: t('rxtx.tx.newMessage'),
    run: () => setModalState({ open: true, editing: null }),
  };

  const openRxRowMenu = (
    event: React.MouseEvent<HTMLTableRowElement>,
    frame: FrameTelemetryDto,
    rowKey: string,
    message: MessageSchemaDto | undefined,
    signals: readonly (SignalSchemaDto | undefined)[],
  ): void => {
    const clip = buildClipFromRx(frame);
    const canUseFrame = clip !== null && clip !== 'invalid';
    const copiesSelection = (selectedRxKeys?.size ?? 0) > 1 && selectedRxKeys?.has(rowKey);
    const watched = (message?.signalIds ?? []).flatMap((id) => {
      const signal = signals[id];
      return signal ? [makeWatchSignal(frame.busId, signal)] : [];
    });
    openContextMenu(event, [
      newTxMenuItem,
      {
        label: t('context.editRxAsTx'),
        run: () => {
          if (canUseFrame) setModalState({ open: true, editing: makeTxEntryFromClip(clip) });
        },
        disabled: !canUseFrame,
      },
      {
        label: t(copiesSelection ? 'context.copyRxSelection' : 'context.copyRxFrame'),
        run: () => void copySelectedRx(rowKey),
        disabled: !canUseFrame && !copiesSelection,
      },
      {
        label: t(copiesSelection ? 'context.copyRxSelectionToTx' : 'rxtx.rx.copyToTx'),
        run: () => copySelectedRxToTx(rowKey),
        disabled: !canUseFrame && !copiesSelection,
      },
      {
        label: t('context.copyCanId'),
        run: () => copyMenuText(formatPcanIdHex(frame.arbId, frame.isExtended)),
        disabled: frame.isError,
      },
      {
        label: t('context.copyPayload'),
        run: () => copyMenuText(frame.rawBytes.slice(0, frame.dlc).map(formatByteHex).join(' ')),
      },
      {
        label: t('context.watchMessage'),
        run: () => workbenchStore.addWatchSignals(watched),
        disabled: watched.length === 0,
      },
      {
        label: t('rxtx.rx.openInDbc'),
        run: () => {
          if (message) databaseStore.selectMessageInSymbolsTab(message.messageKey, undefined, frame.busId);
        },
        disabled: !message,
      },
      {
        label: t(copiesSelection ? 'context.hideRxSelection' : 'context.hideRxRow'),
        run: () => hideRxRows(copiesSelection && selectedRxKeys ? selectedRxKeys : new Set([rowKey])),
      },
    ]);
  };

  // Latest-closure holder so the window listener is bound once (not per 60 Hz render).
  const kbRef = useRef<{
    activePane: 'rx' | 'tx' | null;
    blocked: boolean;
    rxFrames: readonly FrameTelemetryDto[];
    selectedRxKey: string | null;
    txEntries: readonly TxListEntry[];
    selectedTxId: string | null;
    multipleTxSelected: boolean;
    selectAll: () => void;
    expandSelection: (expanded: boolean) => void;
    selectRx: (key: string) => void;
    selectTx: (id: string) => void;
    sendTx: (entry: TxListEntry) => Promise<void>;
    copyRx: () => Promise<void>;
    rxToTx: () => void;
    paste: () => Promise<void>;
    editTx: (e: TxListEntry) => void;
    deleteTx: () => Promise<void>;
    deleteRx: () => void;
    hasRxSelection: boolean;
  } | null>(null);
  useEffect(() => {
    kbRef.current = {
      activePane,
      blocked: modalState.open || projState.modalOpen,
      rxFrames,
      selectedRxKey,
      txEntries: txState.entries,
      selectedTxId: txState.selectedEntryId,
      multipleTxSelected,
      selectAll: () => {
        if (activePane === 'rx') {
          const keys = new Set(rxFrames.map(buildFrameInstanceKey));
          setSelectedRxKeys(keys.size ? keys : null);
          if (selectedRxKey === null || !keys.has(selectedRxKey)) {
            setSelectedRxKey(keys.values().next().value ?? null);
          }
        } else {
          const ids = new Set(txState.entries.map((entry) => entry.id));
          setSelectedTxIds(ids.size ? ids : null);
          if (txState.selectedEntryId === null || !ids.has(txState.selectedEntryId)) {
            transmitStore.selectEntry(ids.values().next().value ?? null);
          }
        }
      },
      expandSelection: (expanded) => {
        if (activePane === 'rx') {
          const keys = rxFrames.filter((frame) => {
            const key = buildFrameInstanceKey(frame);
            return (selectedRxKeys?.has(key) ?? (key === selectedRxKey)) &&
              (!expanded || frame.isError || frame.signals.length > 0 || Boolean(databaseStore.getMessageForBus(
                frame.busId, frame.messageKey, frame.arbId, frame.isExtended,
              )));
          }).map(buildFrameInstanceKey);
          if (keys.length === 0) return;
          setExpandedRxKeys((previous) => updateExpandedRows(previous, keys, expanded));
        } else {
          const ids = txState.entries.filter((entry) =>
            (selectedTxIds?.has(entry.id) ?? (entry.id === txState.selectedEntryId)) &&
            (!expanded || Boolean(getTxMessageSchema(entry)?.signalIds.length)),
          ).map((entry) => entry.id);
          if (ids.length === 0) return;
          setExpandedTxIds((previous) => updateExpandedRows(previous, ids, expanded));
        }
      },
      selectRx: selectRxRow,
      selectTx: selectTxRow,
      sendTx: (entry) => sendTxEntry(entry, false),
      copyRx: copySelectedRx,
      rxToTx: copySelectedRxToTx,
      paste: handlePasteToTx,
      editTx: (e) => setModalState({ open: true, editing: e }),
      deleteTx: handleDeleteSelectedTx,
      deleteRx: () => hideRxRows(selectedRxKeys ?? new Set(selectedRxKey === null ? [] : [selectedRxKey])),
      hasRxSelection: (selectedRxKeys?.size ?? 0) > 0 || selectedRxKey !== null,
    };
  });

  useEffect(() => {
    const step = (key: string, cur: number, n: number): number => {
      if (key === 'Home') return 0;
      if (key === 'End') return n - 1;
      if (cur < 0) return 0;
      return key === 'ArrowDown' ? Math.min(n - 1, cur + 1) : Math.max(0, cur - 1);
    };
    const onKeyDown = (ev: KeyboardEvent): void => {
      const c = kbRef.current;
      if (!c || c.blocked || ev.defaultPrevented || !c.activePane) return;
      const target = ev.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable
        || target?.closest('[role="menu"]')) {
        return;
      }
      if (
        workbenchStore.getState().newConnectionModalOpen ||
        document.querySelector('[role="dialog"], [aria-modal="true"]')
      ) {
        return;
      }

      const pane = c.activePane === 'rx' ? rxSectionRef.current : txSectionRef.current;
      if (!target || !pane?.contains(target)) return;
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod) {
        if (ev.altKey || ev.shiftKey) return;
        const k = ev.key.toLowerCase();
        if (k === 'a') {
          ev.preventDefault();
          c.selectAll();
        } else if (k === 'c' && c.activePane === 'rx') {
          if (!c.hasRxSelection || (window.getSelection()?.toString() ?? '') !== '') return;
          ev.preventDefault();
          void c.copyRx();
        } else if (k === 't' && c.hasRxSelection) {
          ev.preventDefault();
          c.rxToTx();
        } else if (k === 'v' && c.activePane === 'tx') {
          ev.preventDefault();
          void c.paste();
        }
        return;
      }
      if (ev.altKey || ev.shiftKey) return;

      const key = ev.key;
      if (key === 'ArrowRight' || key === 'ArrowLeft') {
        ev.preventDefault();
        c.expandSelection(key === 'ArrowRight');
        return;
      }
      const isNav = key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End';
      if (c.activePane === 'tx') {
        const n = c.txEntries.length;
        if (isNav) {
          if (n === 0) return;
          ev.preventDefault();
          let cur = -1;
          for (let i = 0; i < n; i++) {
            if (c.txEntries[i].id === c.selectedTxId) {
              cur = i;
              break;
            }
          }
          c.selectTx(c.txEntries[step(key, cur, n)].id);
        } else if ((key === 'Enter' || key === ' ') && tag !== 'BUTTON' && !c.multipleTxSelected) {
          const entry = c.txEntries.find((candidate) => candidate.id === c.selectedTxId);
          if (entry) {
            ev.preventDefault();
            if (key === 'Enter') c.editTx(entry);
            else if (!ev.repeat) void c.sendTx(entry);
          }
        } else if (key === 'Delete' && c.selectedTxId !== null && !c.multipleTxSelected) {
          ev.preventDefault();
          void c.deleteTx();
        }
      } else if (key === 'Delete' && c.hasRxSelection) {
        ev.preventDefault();
        c.deleteRx();
      } else if (isNav) {
        const n = c.rxFrames.length;
        if (n === 0) return;
        ev.preventDefault();
        let cur = -1;
        for (let i = 0; i < n; i++) {
          if (buildFrameInstanceKey(c.rxFrames[i]) === c.selectedRxKey) {
            cur = i;
            break;
          }
        }
        c.selectRx(buildFrameInstanceKey(c.rxFrames[step(key, cur, n)]));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Keep keyboard-selected rows visible
  useEffect(() => {
    if (selectedRxKey === null) return;
    rxSectionRef.current
      ?.querySelector(`[data-rx-key="${CSS.escape(selectedRxKey)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedRxKey]);
  useEffect(() => {
    if (txState.selectedEntryId === null) return;
    txSectionRef.current
      ?.querySelector(`[data-tx-id="${CSS.escape(txState.selectedEntryId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [txState.selectedEntryId]);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden select-none">
      <GuideStrip pageId="rxtx" />
      {/* MAIN DRAG-RESIZABLE RECEIVE (TOP) + TRANSMIT (BOTTOM) WORKSPACE */}
      <div
        ref={splitContainerRef}
        className="flex flex-col flex-1 min-h-0 overflow-hidden"
      >
        {/* ================================================================ */}
        {/* 1. TOP PANE: RECEIVE LIST (LIVE RX + TX LOOPBACK ECHO)           */}
        {/* ================================================================ */}
        <section
          ref={rxSectionRef}
          tabIndex={0}
          onContextMenu={(event) => openContextMenu(event, [
            newTxMenuItem,
            {
              label: t('context.restoreRxRows'),
              run: () => setHiddenRxKeys(new Set()),
              disabled: hiddenRxKeys.size === 0,
            },
            {
              label: t('rxtx.rx.expandAll'),
              run: () => setExpandedRxKeys(new Set(rxFrames.map(buildFrameInstanceKey))),
              disabled: rxFrames.length === 0,
            },
            {
              label: t('rxtx.rx.collapseAll'),
              run: () => setExpandedRxKeys(new Set()),
              disabled: expandedRxKeys.size === 0,
            },
          ])}
          onMouseDown={() => setActivePane('rx')}
          onFocus={() => setActivePane('rx')}
          onClick={focusMessagePane}
          style={{
            height: `${rxHeightPct}%`,
            backgroundColor: 'var(--bg-panel)',
            outline: activePane === 'rx' ? '1px solid var(--text-muted)' : 'none',
            outlineOffset: '-1px',
          }}
          className="flex min-h-[120px] overflow-hidden"
        >
          {/* Left 22px Rotated "Receive" Strip */}
          <div className="pcan-side-strip">
            <span className="pcan-side-strip-label">{t('rxtx.section.receive')}</span>
          </div>

          <div className="flex flex-col flex-1 min-w-0 min-h-0">
            {/* Slim Receive Sub-Toolbar (Scaled & Responsive) */}
            <div
              data-tour="rxtx.rx-toolbar"
              style={{
                backgroundColor: 'var(--bg-toolbar)',
                borderBottom: '1px solid var(--border-strong)',
              }}
              className="shrink-0 min-h-[38px] py-1 px-3 flex items-center justify-between gap-2 text-[12px] flex-wrap"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[var(--text-secondary)] font-medium">
                  {t('rxtx.rx.filterLabel')}
                </span>
                <div className="relative flex items-center">
                  <input
                    type="text"
                    value={rxFilter}
                    onChange={(e) => setRxFilter(e.target.value)}
                    placeholder={t('rxtx.rx.filterPlaceholder')}
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="h-[28px] w-40 sm:w-52 xl:w-64 px-2 pr-6 border text-[12px] focus:outline-none"
                  />
                  {rxFilter && (
                    <button
                      type="button"
                      onClick={() => setRxFilter('')}
                      className="absolute right-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <span className="text-[var(--text-secondary)] ml-1 font-medium">
                  {t('rxtx.rx.columnsLabel')}
                </span>
                <select
                  aria-label="Receive Table Columns Profile"
                  value={rxColumnMode}
                  onChange={(e) => setRxColumnMode(e.target.value as RxColumnMode)}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="h-[28px] px-2 border text-[12px] focus:outline-none"
                >
                  <option value="CAN">{t('rxtx.rx.colOptCan')}</option>
                  <option value="CAN_DEC">{t('rxtx.rx.colOptCanDec')}</option>
                  <option value="J1939">{t('rxtx.rx.colOptJ1939')}</option>
                </select>

                {isRxLayoutModified && (
                  <button
                    type="button"
                    onClick={handleResetRxLayout}
                    style={{
                      backgroundColor: 'var(--bg-panel)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-secondary)',
                    }}
                    className="h-[28px] px-2.5 border text-[11.5px] hover:text-[var(--text-primary)] cursor-pointer"
                    title={t('rxtx.rx.resetLayoutTooltip')}
                  >
                    {t('rxtx.rx.resetColumns')}
                  </button>
                )}
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                {/* Error Frames KPI & Quick Toggle */}
                <button
                  type="button"
                  onClick={() => setRxErrorsOnly((v) => !v)}
                  style={{
                    backgroundColor: rxErrorsOnly
                      ? 'rgba(220, 38, 38, 0.25)'
                      : (header.totalFramesErr ?? 0) > 0
                        ? 'rgba(159, 18, 57, 0.20)'
                        : 'var(--bg-panel)',
                    borderColor: rxErrorsOnly
                      ? '#ef4444'
                      : (header.totalFramesErr ?? 0) > 0
                        ? 'rgba(244, 63, 94, 0.5)'
                        : 'var(--border-strong)',
                    color: (header.totalFramesErr ?? 0) > 0 ? '#f43f5e' : 'var(--text-muted)',
                  }}
                  className={`h-[28px] px-2.5 border font-mono text-[11.5px] font-semibold flex items-center gap-1.5 cursor-pointer ${
                    (header.totalFramesErr ?? 0) > 0 ? 'hover:border-rose-400' : 'hover:text-[var(--text-secondary)]'
                  }`}
                  title={
                    (header.totalFramesErr ?? 0) > 0
                      ? t('rxtx.rx.errorsToggleTooltip', { count: header.totalFramesErr })
                      : t('rxtx.rx.noErrorsTooltip')
                  }
                >
                  <AlertTriangle className={`w-3.5 h-3.5 ${(header.totalFramesErr ?? 0) > 0 ? 'text-[var(--status-critical)]' : 'text-slate-500'}`} />
                  <span>ERR: {header.totalFramesErr ?? 0}</span>
                  {rxErrorsOnly && (
                    <span className="ml-0.5 text-[9.5px] uppercase font-bold text-[var(--status-critical)]">
                      [{t('rxtx.rx.filterActive')}]
                    </span>
                  )}
                </button>
                <div className="h-4 w-[1px] bg-[var(--border-strong)] mx-1" />

                <button
                  type="button"
                  onClick={() => void handleClearReceive()}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="h-[28px] px-2.5 border flex items-center gap-1.5 font-medium hover:border-[var(--text-secondary)] cursor-pointer"
                  title={t('rxtx.rx.clearTooltip')}
                >
                  <RotateCcw className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <span>{t('rxtx.rx.clear')}</span>
                </button>
                <div className="h-4 w-[1px] bg-[var(--border-strong)] mx-1" />
                <button
                  type="button"
                  onClick={() =>
                    setExpandedRxKeys(
                      new Set(rxFrames.map((f) => buildFrameInstanceKey(f))),
                    )
                  }
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-grid)',
                    color: 'var(--text-secondary)',
                  }}
                  className="h-[28px] px-2.5 border hover:text-[var(--text-primary)] cursor-pointer"
                >
                  {t('rxtx.rx.expandAll')}
                </button>
                <button
                  type="button"
                  onClick={() => setExpandedRxKeys(new Set())}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-grid)',
                    color: 'var(--text-secondary)',
                  }}
                  className="h-[28px] px-2.5 border hover:text-[var(--text-primary)] cursor-pointer"
                >
                  {t('rxtx.rx.collapseAll')}
                </button>
                <div className="h-4 w-[1px] bg-[var(--border-strong)] mx-1" />
                <button
                  type="button"
                  disabled={selectedRxKey === null && !selectedRxKeys?.size}
                  onClick={() => copySelectedRxToTx()}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="h-[28px] px-2.5 border flex items-center gap-1.5 hover:border-[var(--text-secondary)] disabled:opacity-40 cursor-pointer"
                  title={t('rxtx.rx.copyToTxTooltip')}
                >
                  <Copy className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <span>{t('rxtx.rx.copyToTx')}</span>
                </button>
                <GuideTourButton pageId="rxtx" />
                <GuideInfoButton pageId="rxtx" tourAnchor="rxtx.info" />
                <ShortcutsHelp />
              </div>
            </div>

            {/* Flat Dense PCAN Receive Grid (table-layout: fixed, locked 26px rows) */}
            <div data-tour="rxtx.rx-table" className="flex-1 min-h-0 overflow-auto flex flex-col">
              <table className="pcan-grid pcan-grid-fixed font-mono tabular-nums">
                <colgroup>
                  <col style={{ width: '26px' }} />
                  {visibleRxCols.map((colId) => {
                    const w = rxColumnWidths[colId];
                    return (
                      <col
                        key={colId}
                        style={w !== null ? { width: `${w}px` } : undefined}
                      />
                    );
                  })}
                </colgroup>
                <thead>
                  <tr>
                    <th className="text-center" style={{ width: '26px' }} />
                    {visibleRxCols.map((colId) => {
                      const def = RX_COLUMN_KEYS[colId];
                      const label = rxColLabels[colId] ?? colId;
                      const isDropTarget = activeDrag?.table === 'rx' && activeDrag.overCol === colId;
                      const isDraggingThis = activeDrag?.table === 'rx' && activeDrag.sourceCol === colId;

                      return (
                        <th
                          key={colId}
                          data-rx-col={colId}
                          onPointerDown={(e) => handleHeaderPointerDown(e, 'rx', colId)}
                          className={`${def.align === 'right' ? 'text-right' : 'text-left'} select-none cursor-grab active:cursor-grabbing ${def.font ?? ''} ${isDraggingThis ? 'opacity-40' : ''}`}
                          title={t('rxtx.col.headerTooltip', { label })}
                        >
                          {isDropTarget && (
                            <span
                              className={`absolute top-0 bottom-0 w-[2px] bg-[#58A6FF] z-20 pointer-events-none ${
                                activeDrag.side === 'before' ? 'left-0' : 'right-0'
                              }`}
                            />
                          )}
                          <span className="truncate block pr-1.5">{label}</span>
                          <span
                            data-resize-handle
                            onPointerDown={(e) => handleResizePointerDown(e, 'rx', colId)}
                            onDoubleClick={(e) => handleResetColumnWidth(e, 'rx', colId)}
                            className="absolute top-0 right-0 bottom-0 w-[6px] cursor-col-resize hover:bg-[#58A6FF]/40 z-10"
                            title={t('rxtx.col.resizeTooltip')}
                          />
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rxFrames.map((frame, rowIdx) => {
                      const rowKey = buildFrameInstanceKey(frame);
                      const isExpanded = expandedRxKeys.has(rowKey);
                      const isSelected = selectedRxKeys?.has(rowKey) ?? (rowKey === selectedRxKey);
                      const msgSchema = databaseStore.getMessageForBus(
                        frame.busId,
                        frame.messageKey,
                        frame.arbId,
                        frame.isExtended,
                      );
                      const signalsById = databaseStore.getBusSignals(frame.busId);
                      const muxSym = formatMultiplexedSymbol(
                        msgSchema,
                        signalsById,
                        frame.activeMuxSwitches,
                      );
                      const typeTag = getFrameTypeTag(frame, msgSchema);
                      const j1939 =
                        rxColumnMode === 'J1939'
                          ? extractJ1939Fields(frame.arbId, frame.isExtended)
                          : null;
                      const byteLen = Math.min(frame.dlc, frame.rawBytes.length);
                      const switchEntries = Object.entries(frame.activeMuxSwitches);
                      const muxTooltip = msgSchema
                        ? switchEntries.length > 0
                          ? t('rxtx.rx.muxTooltipWithEntries', {
                              symbol: muxSym.fullSymbol,
                              entries: switchEntries.map(([k, v]) => `${k}=${v}`).join(', '),
                            })
                          : t('rxtx.rx.muxTooltipPlain', { name: msgSchema.name })
                        : undefined;

                      return (
                        <React.Fragment key={rowKey}>
                          <tr
                            data-rx-key={rowKey}
                            aria-selected={isSelected}
                            onContextMenu={(event) => openRxRowMenu(event, frame, rowKey, msgSchema, signalsById)}
                            onClick={() => selectRxRow(rowKey)}
                            style={{
                              scrollMarginTop: '28px',
                              backgroundColor: isSelected
                                ? 'var(--bg-row-selected)'
                                : frame.isError
                                ? isExpanded
                                  ? 'color-mix(in srgb, var(--status-critical) 24%, transparent)'
                                  : 'var(--status-critical-bg)'
                                : rowIdx % 2 === 1
                                  ? 'var(--bg-row-alt)'
                                  : 'var(--bg-panel)',
                              borderLeft: frame.isError ? '2px solid var(--status-critical)' : undefined,
                            }}
                            className="hover:!bg-[var(--bg-row-hover)] cursor-pointer"
                          >
                            {/* Expand Chevron */}
                            <td className="px-0">
                              <div className="pcan-cell pcan-cell-center">
                                {(frame.isError || frame.signals.length > 0 || msgSchema) && (
                                  <button
                                    type="button"
                                    aria-label={t(isExpanded ? 'rxtx.row.collapse' : 'rxtx.row.expand')}
                                    aria-expanded={isExpanded}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      toggleRxRow(rowKey);
                                    }}
                                    className={`grid size-6 place-items-center cursor-pointer ${frame.isError ? 'text-critical' : 'text-[var(--text-secondary)]'}`}
                                  >
                                    {isExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                                  </button>
                                )}
                              </div>
                            </td>

                            {visibleRxCols.map((colId) => {
                              switch (colId) {
                                case 'bus':
                                  return (
                                    <td key="bus">
                                      <div className="pcan-cell">{frame.busId + 1}</div>
                                    </td>
                                  );
                                case 'type':
                                  return (
                                    <td key="type">
                                      <div
                                        className="pcan-cell"
                                        title={
                                          frame.isTx
                                            ? t('rxtx.rx.loopbackTooltip')
                                            : undefined
                                        }
                                      >
                                        <span className={typeTag.cls}>{typeTag.label}</span>
                                      </div>
                                    </td>
                                  );
                                case 'id':
                                  return (
                                    <td key="id">
                                      <div
                                        className="pcan-cell font-mono"
                                        title={`Dec: ${frame.arbId}`}
                                      >
                                        {frame.isError ? (
                                          <span className="text-[var(--status-critical)] font-bold">
                                            {(frame.arbId & CAN_ERR_MASK)
                                              .toString(16)
                                              .toUpperCase()
                                              .padStart(3, '0')}
                                            h
                                          </span>
                                        ) : (
                                          formatPcanIdHex(frame.arbId, frame.isExtended)
                                        )}
                                      </div>
                                    </td>
                                  );
                                case 'idDec':
                                  return (
                                    <td key="idDec">
                                      <div className="pcan-cell pcan-cell-right text-[var(--text-secondary)]">
                                        {frame.arbId}
                                      </div>
                                    </td>
                                  );
                                case 'pgn':
                                  return (
                                    <td key="pgn">
                                      <div className="pcan-cell">{j1939?.pgnHex ?? '—'}</div>
                                    </td>
                                  );
                                case 'sa':
                                  return (
                                    <td key="sa">
                                      <div className="pcan-cell">{j1939?.saHex ?? '—'}</div>
                                    </td>
                                  );
                                case 'dlc':
                                  return (
                                    <td key="dlc">
                                      <div className="pcan-cell pcan-cell-right">{frame.dlc}</div>
                                    </td>
                                  );
                                case 'symbol':
                                  return (
                                    <td key="symbol">
                                      <div
                                        className="pcan-cell font-sans"
                                        title={
                                          frame.isError
                                            ? `Arrived at t = ${(frame.lastTimestampUs / 1_000_000).toFixed(3)}s (${frame.lastTimestampUs} µs)`
                                            : muxTooltip
                                        }
                                      >
                                        {frame.isError ? (
                                          <div className="flex items-center gap-1.5 truncate">
                                            <span className="text-[var(--status-critical)] font-mono text-[11px] font-semibold truncate select-all">
                                              {formatErrorFrameShortTitle(
                                                frame.arbId,
                                                frame.rawBytes,
                                                frame.errorSummary,
                                              )}
                                            </span>
                                            <span className="text-[10px] text-[var(--text-muted)] font-mono shrink-0">
                                              [t={(frame.lastTimestampUs / 1_000_000).toFixed(3)}s]
                                            </span>
                                          </div>
                                        ) : msgSchema ? (
                                          <span className="truncate">
                                            <span style={{ color: 'var(--text-primary)' }}>{muxSym.baseName}</span>
                                            {muxSym.muxSuffix !== null && (
                                              <span
                                                className="font-mono tabular-nums font-semibold"
                                                style={{ color: 'var(--status-focus)' }}
                                              >
                                                .{muxSym.muxSuffix}
                                              </span>
                                            )}
                                          </span>
                                        ) : (
                                          <span className="text-[var(--text-muted)]">—</span>
                                        )}
                                      </div>
                                    </td>
                                  );
                                case 'data':
                                  return (
                                    <td key="data">
                                      <div
                                        className="pcan-cell overflow-x-auto no-scrollbar select-text"
                                        title={
                                          byteLen > 8
                                            ? formatHexDumpTooltip(frame.rawBytes, byteLen)
                                            : undefined
                                        }
                                      >
                                        <span className="whitespace-nowrap flex items-center gap-[3px]">
                                          {Array.from({ length: byteLen }, (_, bIdx) => {
                                            const hex = formatByteHex(frame.rawBytes[bIdx] ?? 0);
                                            const changed = isByteRecentlyChanged(
                                              bIdx,
                                              frame.changedBytesLo,
                                              frame.changedBytesHi,
                                            );
                                            return (
                                              <span
                                                key={bIdx}
                                                className={changed ? 'pcan-byte pcan-byte-changed' : 'pcan-byte'}
                                              >
                                                {hex}
                                              </span>
                                            );
                                          })}
                                        </span>
                                      </div>
                                    </td>
                                  );
                                case 'cycle':
                                  return (
                                    <td key="cycle">
                                      <div
                                        className={`pcan-cell pcan-cell-right ${
                                          frame.cycleHealth === 'timeout'
                                            ? 'text-red-500 font-semibold'
                                            : ''
                                        }`}
                                      >
                                        {frame.cycleMs > 0 ? frame.cycleMs.toFixed(1) : '0.0'}
                                        {frame.cycleHealth === 'timeout' ? ' TO' : ''}
                                      </div>
                                    </td>
                                  );
                                case 'count':
                                  return (
                                    <td key="count">
                                      <div className="pcan-cell pcan-cell-right">
                                        {frame.rxCount}
                                      </div>
                                    </td>
                                  );
                                default:
                                  return null;
                              }
                            })}
                          </tr>

                          {/* Inline Tree Signal Rows (Locked 26px height, crisp 12px font) or Error Diagnostics */}
                          {isExpanded && (
                            frame.isError ? (
                              <RxErrorDetailRows
                                frame={frame}
                                colSpan={visibleRxCols.length}
                              />
                            ) : (
                              <RxSignalTreeRows
                                rowKey={rowKey}
                                frame={frame}
                                signalsById={signalsById}
                                recentlyChangedSignals={framesSlice.recentlyChangedSignals}
                                visibleCols={visibleRxCols}
                              />
                            )
                          )}
                        </React.Fragment>
                      );
                    })}
                </tbody>
              </table>
              {rxFrames.length === 0 && (
                <RxEmptyOnboarding
                  hasActiveWorkspace={projState.hasActiveWorkspace}
                  anyBusConnected={header.buses.some((b) => b.connected)}
                  hasSchema={dbState.busSchemas.size > 0}
                  schemaName={`${dbState.busSchemas.size} hat · ${dbState.databases.length} DB`}
                  onOpenNewConnection={() => workbenchStore.setNewConnectionModalOpen(true)}
                  onGoToConnections={() => databaseStore.setActiveDocTab('connections')}
                  onOpenDb={() => databaseStore.setActiveDocTab('symbols')}
                  onLoadSampleDb={() => databaseStore.setActiveDocTab('connections')}
                  onAddTx={() => setModalState({ open: true, editing: null })}
                  onCreateProject={async () => {
                    await projectStore.createNewCleanProject('Vehicle Bench 01');
                    if (isExperimentalCloudEnabled() && Boolean(cloudBridgeStore.getState().sessionToken)) {
                      cloudBridgeStore.openPushPrompt({
                        reason: 'new_project',
                        projectName: 'Vehicle Bench 01',
                      });
                    }
                  }}
                  onOpenProject={() => projectStore.setModalOpen(true)}
                />
              )}
            </div>
          </div>
        </section>

        {/* DRAGGABLE HORIZONTAL SPLITTER BAR */}
        <div
          onPointerDown={(ev) => {
            ev.preventDefault();
            draggingRef.current = true;
          }}
          style={{
            backgroundColor: 'var(--bg-header)',
            borderTop: '1px solid var(--border-strong)',
            borderBottom: '1px solid var(--border-strong)',
          }}
          className="h-[5px] shrink-0 cursor-row-resize hover:bg-sky-500/40 transition-colors"
          title="Drag to resize Receive and Transmit panes"
        />

        {/* ================================================================ */}
        {/* 2. BOTTOM PANE: TRANSMIT LIST (STRICTLY TX COMPOSER)             */}
        {/* ================================================================ */}
        <section
          ref={txSectionRef}
          tabIndex={0}
          onContextMenu={(event) => openContextMenu(event, [
            newTxMenuItem,
            { label: t('context.pasteTx'), run: () => void handlePasteToTx() },
          ])}
          onMouseDown={() => setActivePane('tx')}
          onFocus={() => setActivePane('tx')}
          onClick={focusMessagePane}
          style={{
            height: `${100 - rxHeightPct}%`,
            backgroundColor: 'var(--bg-panel)',
            outline: activePane === 'tx' ? '1px solid var(--text-muted)' : 'none',
            outlineOffset: '-1px',
          }}
          className="flex min-h-[110px] overflow-hidden"
        >
          {/* Left 22px Rotated "Transmit" Strip */}
          <div className="pcan-side-strip">
            <span className="pcan-side-strip-label">{t('rxtx.section.transmit')}</span>
          </div>

          <div className="flex flex-col flex-1 min-w-0 min-h-0">
            {/* Slim Transmit Sub-Toolbar (Scaled & Responsive) */}
            <div
              style={{
                backgroundColor: 'var(--bg-toolbar)',
                borderBottom: '1px solid var(--border-strong)',
              }}
              className="shrink-0 min-h-[38px] py-1 px-3 flex items-center justify-between gap-2 text-[12px] flex-wrap"
            >
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  data-tour="rxtx.tx-new"
                  onClick={() => setModalState({ open: true, editing: null })}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="h-[28px] px-2.5 border flex items-center gap-1.5 font-medium hover:border-[var(--text-secondary)] cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <span>{t('rxtx.tx.newMessage')}</span>
                </button>

                <button
                  type="button"
                  disabled={!selectedTxEntry}
                  onClick={() => {
                    if (selectedTxEntry) {
                      setModalState({ open: true, editing: selectedTxEntry });
                    }
                  }}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="h-[28px] px-2.5 border flex items-center gap-1.5 hover:border-[var(--text-secondary)] disabled:opacity-40 cursor-pointer"
                >
                  <Edit3 className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <span>{t('rxtx.tx.editMessage')}</span>
                </button>

                <button
                  type="button"
                  disabled={!selectedTxEntry}
                  onClick={() => void handleDeleteSelectedTx()}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="h-[28px] px-2.5 border flex items-center gap-1.5 hover:border-[var(--text-secondary)] disabled:opacity-40 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <span>{t('rxtx.tx.delete')}</span>
                </button>

                <div className="h-4 w-[1px] bg-[var(--border-strong)] mx-1" />

                <button
                  type="button"
                  disabled={!selectedTxEntry || busyTxIds.has(selectedTxEntry.id)}
                  onClick={() => {
                    if (selectedTxEntry) {
                      void sendTxEntry(selectedTxEntry, false);
                    }
                  }}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="h-[28px] px-3 border flex items-center gap-1.5 font-semibold hover:border-[var(--text-secondary)] disabled:opacity-40 cursor-pointer text-emerald-400"
                  title={t('rxtx.tx.sendTooltip')}
                >
                  <Send className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{t('rxtx.tx.sendSpace')}</span>
                </button>

                <button
                  type="button"
                  disabled={!anyPeriodicActive}
                  onClick={() => void handlePauseAllTx()}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="h-[28px] px-2.5 border flex items-center gap-1.5 hover:border-[var(--text-secondary)] disabled:opacity-40 cursor-pointer"
                >
                  <Pause className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <span>{t('rxtx.tx.pauseAll')}</span>
                </button>

                <div className="h-4 w-[1px] bg-[var(--border-strong)] mx-1" />

                <button
                  type="button"
                  disabled={txState.entries.length === 0}
                  onClick={handleResetTxCounts}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="h-[28px] px-2.5 border flex items-center gap-1.5 hover:border-[var(--text-secondary)] disabled:opacity-40 cursor-pointer"
                  title={t('rxtx.tx.resetCountsTooltip')}
                >
                  <RotateCcw className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <span>{t('rxtx.tx.resetCounts')}</span>
                </button>

                <button
                  type="button"
                  disabled={txState.entries.length === 0}
                  onClick={() => void handleClearTxList()}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="h-[28px] px-2.5 border flex items-center gap-1.5 hover:border-[var(--text-secondary)] disabled:opacity-40 cursor-pointer"
                  title={t('rxtx.tx.clearListTooltip')}
                >
                  <Trash2 className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <span>{t('rxtx.tx.clearList')}</span>
                </button>

                {isTxLayoutModified && (
                  <button
                    type="button"
                    onClick={handleResetTxLayout}
                    style={{
                      backgroundColor: 'var(--bg-panel)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-secondary)',
                    }}
                    className="h-[28px] px-2.5 border text-[11.5px] hover:text-[var(--text-primary)] cursor-pointer"
                    title={t('rxtx.tx.resetLayoutTooltip')}
                  >
                    {t('rxtx.tx.resetColumns')}
                  </button>
                )}
                <ShortcutsHelp />
              </div>

              {/* Right-Side Compact Bus TX Safety Status */}
              {(() => {
                const connectedBuses = header.buses.filter((b) => b.connected);
                const targetBusId = selectedTxEntry
                  ? selectedTxEntry.busId
                  : (connectedBuses[0]?.busId ?? null);
                const targetBus =
                  targetBusId !== null
                    ? connectedBuses.find((b) => b.busId === targetBusId)
                    : undefined;

                if (targetBusId === null || !targetBus) {
                  return (
                    <div data-tour="rxtx.tx-mode" className="flex items-center gap-1.5 text-[11px] font-mono text-[var(--text-muted)]">
                      <span>{t('rxtx.tx.noActiveBus')}</span>
                    </div>
                  );
                }

                const isReady = Boolean(!targetBus.listenOnly && targetBus.txArmed);

                return (
                  <div data-tour="rxtx.tx-mode" className="flex items-center gap-2">
                    <span className="font-mono text-[11.5px] text-[var(--text-secondary)]">
                      Bus {targetBus.busId + 1} ({targetBus.channelName}):
                    </span>
                    {isReady ? (
                      <span className="flex items-center gap-1.5 text-amber-400 font-medium text-[12px]">
                        <span className="w-2 h-2 rounded-full bg-amber-400" />
                        <span>{t('rxtx.tx.txArmed')}</span>
                      </span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="text-[var(--text-muted)] text-[11.5px]">
                          {targetBus.listenOnly ? t('rxtx.tx.listenOnly') : t('rxtx.tx.txDisarmed')}
                        </span>
                        <GuideWhyLink pageId="rxtx" sectionId="txSafety" />
                        <button
                          type="button"
                          onClick={() => void onSwitchToActiveTx(targetBus.busId)}
                          style={{
                            backgroundColor: 'rgba(217, 155, 38, 0.14)',
                            borderColor: 'rgba(217, 155, 38, 0.55)',
                            color: 'var(--status-warn)',
                          }}
                          className="h-[28px] px-2.5 border hover:border-amber-400 flex items-center gap-1.5 font-medium cursor-pointer text-[12px]"
                          title={t('rxtx.tx.enableActiveTxTooltip', {
                            bus: targetBus.busId + 1,
                            name: targetBus.channelName,
                          })}
                        >
                          <Unlock className="w-3.5 h-3.5" />
                          <span>{t('rxtx.tx.enableActiveTx')}</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* Flat Dense PCAN Transmit Grid (table-layout: fixed, locked 26px rows) */}
            <div className="flex-1 min-h-0 overflow-auto">
              <table className="pcan-grid pcan-grid-fixed font-mono tabular-nums">
                <colgroup>
                  <col style={{ width: '48px' }} />
                  {visibleTxCols.map((colId) => {
                    const w = txColumnWidths[colId];
                    return (
                      <col
                        key={colId}
                        style={w !== null ? { width: `${w}px` } : undefined}
                      />
                    );
                  })}
                </colgroup>
                <thead>
                  <tr>
                    <th className="text-center" style={{ width: '48px' }}>
                      {t('rxtx.tx.colOn')}
                    </th>
                    {visibleTxCols.map((colId) => {
                      const def = TX_COLUMN_KEYS[colId];
                      const label = txColLabels[colId] ?? colId;
                      const isDropTarget = activeDrag?.table === 'tx' && activeDrag.overCol === colId;
                      const isDraggingThis = activeDrag?.table === 'tx' && activeDrag.sourceCol === colId;

                      return (
                        <th
                          key={colId}
                          data-tx-col={colId}
                          onPointerDown={(e) => handleHeaderPointerDown(e, 'tx', colId)}
                          className={`${def.align === 'right' ? 'text-right' : 'text-left'} select-none cursor-grab active:cursor-grabbing ${def.font ?? ''} ${isDraggingThis ? 'opacity-40' : ''}`}
                          title={t('rxtx.col.headerTooltip', { label })}
                        >
                          {isDropTarget && (
                            <span
                              className={`absolute top-0 bottom-0 w-[2px] bg-[#58A6FF] z-20 pointer-events-none ${
                                activeDrag.side === 'before' ? 'left-0' : 'right-0'
                              }`}
                            />
                          )}
                          <span className="truncate block pr-1.5">{label}</span>
                          <span
                            data-resize-handle
                            onPointerDown={(e) => handleResizePointerDown(e, 'tx', colId)}
                            onDoubleClick={(e) => handleResetColumnWidth(e, 'tx', colId)}
                            className="absolute top-0 right-0 bottom-0 w-[6px] cursor-col-resize hover:bg-[#58A6FF]/40 z-10"
                            title={t('rxtx.col.resizeTooltip')}
                          />
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {txState.entries.length === 0 ? (
                    <tr>
                      <td colSpan={1 + visibleTxCols.length}>
                        <div className="pcan-cell pcan-cell-center font-sans text-[var(--text-muted)]">
                          {t('rxtx.tx.noEntries')}
                        </div>
                      </td>
                    </tr>
                  ) : (
                    txState.entries.map((entry) => {
                      const isSelected = selectedTxIds?.has(entry.id) ?? (entry.id === txState.selectedEntryId);
                      const isExpanded = expandedTxIds.has(entry.id);
                      const msgSchema = getTxMessageSchema(entry);
                      const signalsById = databaseStore.getBusSignals(entry.busId);
                      const txMuxInfo =
                        entry.mode === 'symbolic' && msgSchema
                          ? resolveMuxChainFromSignalValues(
                              msgSchema,
                              signalsById,
                              entry.signalValues,
                            )
                          : null;
                      const hasSignals = Boolean(
                        msgSchema && msgSchema.signalIds.length > 0,
                      );
                      const totalCount = entry.manualSentCount + entry.periodicSentCount;
                      const byteLen = Math.min(entry.dlc, entry.rawBytes.length);

                      return (
                        <React.Fragment key={entry.id}>
                          <tr
                            data-tx-id={entry.id}
                            aria-selected={isSelected}
                            onContextMenu={(event) => openContextMenu(event, [
                              newTxMenuItem,
                              {
                                label: t('rxtx.tx.editMessage'),
                                run: () => {
                                  const current = transmitStore.getState().entries.find((item) => item.id === entry.id);
                                  if (current) setModalState({ open: true, editing: current });
                                },
                                disabled: busyTxIds.has(entry.id),
                              },
                              {
                                label: t('rxtx.tx.delete'),
                                run: () => void handleDeleteTx(entry.id),
                                disabled: busyTxIds.has(entry.id),
                              },
                            ])}
                            onClick={() => selectTxRow(entry.id)}
                            onDoubleClick={() =>
                              setModalState({ open: true, editing: entry })
                            }
                            style={{
                              scrollMarginTop: '28px',
                              backgroundColor: isSelected
                                ? 'var(--bg-row-selected)'
                                : 'var(--bg-panel)',
                            }}
                            className="hover:!bg-[var(--bg-row-hover)] cursor-pointer"
                          >
                            {/* Checkbox [x] + Symbolic Expand Chevron [>] */}
                            <td
                              className="px-1.5"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div className="pcan-cell gap-1">
                                <input
                                  type="checkbox"
                                  checked={entry.periodicEnabled}
                                  disabled={busyTxIds.has(entry.id)}
                                  onChange={() => void handleTogglePeriodicCheckbox(entry)}
                                  title={
                                    entry.cycleTimeMs > 0
                                      ? t('rxtx.tx.periodicToggleStop', { ms: entry.cycleTimeMs })
                                      : t('rxtx.tx.periodicToggleStart')
                                  }
                                  className="accent-emerald-600 cursor-pointer shrink-0"
                                />
                                {hasSignals && (
                                  <button
                                    type="button"
                                    aria-label={t(isExpanded ? 'rxtx.row.collapse' : 'rxtx.row.expand')}
                                    aria-expanded={isExpanded}
                                    onClick={() => toggleTxRow(entry.id)}
                                    className="text-[var(--text-secondary)] cursor-pointer shrink-0"
                                  >
                                    {isExpanded ? (
                                      <ChevronDown className="w-3.5 h-3.5" />
                                    ) : (
                                      <ChevronRight className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                )}
                              </div>
                            </td>

                            {visibleTxCols.map((colId) => {
                              switch (colId) {
                                case 'bus':
                                  return (
                                    <td key="bus">
                                      <div className="pcan-cell">{entry.busId + 1}</div>
                                    </td>
                                  );
                                case 'type':
                                  return (
                                    <td key="type">
                                      <div className="pcan-cell">
                                        <span
                                          className={
                                            entry.isFd
                                              ? 'pcan-tag pcan-tag-fd'
                                              : 'pcan-tag pcan-tag-cc'
                                          }
                                        >
                                          {entry.isFd ? 'FD' : 'CC'}
                                        </span>
                                      </div>
                                    </td>
                                  );
                                case 'id':
                                  return (
                                    <td key="id">
                                      <div className="pcan-cell">
                                        {formatPcanIdHex(entry.arbId, entry.isExtended)}
                                      </div>
                                    </td>
                                  );
                                case 'dlc':
                                  return (
                                    <td key="dlc">
                                      <div className="pcan-cell pcan-cell-right">{entry.dlc}</div>
                                    </td>
                                  );
                                case 'symbol':
                                  return (
                                    <td key="symbol">
                                      <div
                                        className="pcan-cell font-sans"
                                        title={
                                          txMuxInfo
                                            ? txMuxInfo.formatted.fullSymbol
                                            : entry.symbolName || strCustomRaw
                                        }
                                      >
                                        {txMuxInfo ? (
                                          <span className="truncate">
                                            <span style={{ color: 'var(--text-primary)' }}>
                                              {txMuxInfo.formatted.baseName}
                                            </span>
                                            {txMuxInfo.formatted.muxSuffix !== null && (
                                              <span
                                                className="font-mono tabular-nums font-semibold"
                                                style={{ color: 'var(--status-focus)' }}
                                              >
                                                .{txMuxInfo.formatted.muxSuffix}
                                              </span>
                                            )}
                                          </span>
                                        ) : (
                                          <span className="truncate">
                                            {entry.symbolName || strCustomRaw}
                                          </span>
                                        )}
                                      </div>
                                    </td>
                                  );
                                case 'data':
                                  return (
                                    <td key="data">
                                      <div
                                        className="pcan-cell overflow-x-auto no-scrollbar select-text"
                                        title={
                                          byteLen > 8
                                            ? formatHexDumpTooltip(entry.rawBytes, byteLen)
                                            : undefined
                                        }
                                      >
                                        <span className="whitespace-nowrap flex items-center gap-[3px]">
                                          {Array.from({ length: byteLen }, (_, i) => (
                                            <span key={i} className="pcan-byte">
                                              {formatByteHex(entry.rawBytes[i] ?? 0)}
                                            </span>
                                          ))}
                                        </span>
                                      </div>
                                    </td>
                                  );
                                case 'cycle':
                                  return (
                                    <td key="cycle">
                                      <div className="pcan-cell pcan-cell-right font-sans">
                                        {entry.cycleTimeMs === 0 ? (
                                          <span className="text-[var(--text-secondary)]">{strWait}</span>
                                        ) : (
                                          <span className="font-mono">
                                            {entry.cycleTimeMs.toFixed(1)}
                                          </span>
                                        )}
                                      </div>
                                    </td>
                                  );
                                case 'count':
                                  return (
                                    <td key="count">
                                      <div className="pcan-cell pcan-cell-right">
                                        {totalCount}
                                      </div>
                                    </td>
                                  );
                                case 'trigger':
                                  return (
                                    <td key="trigger" onClick={(e) => e.stopPropagation()}>
                                      <div className="pcan-cell justify-between gap-1 font-sans">
                                        <span
                                          className={`text-[11px] ${
                                            entry.periodicEnabled
                                              ? 'text-emerald-500 font-semibold'
                                              : 'text-[var(--text-secondary)]'
                                          }`}
                                        >
                                          {entry.cycleTimeMs === 0
                                            ? strManual
                                            : entry.periodicEnabled
                                              ? strPeriodic
                                              : strPaused}
                                        </span>
                                        <button
                                          type="button"
                                          disabled={busyTxIds.has(entry.id)}
                                          onClick={() => void sendTxEntry(entry, false)}
                                          style={{
                                            backgroundColor: 'var(--bg-toolbar)',
                                            borderColor: 'var(--border-strong)',
                                          }}
                                          className="px-1.5 h-[17px] leading-none border text-[10px] hover:border-sky-500 cursor-pointer shrink-0"
                                          title={t('rxtx.tx.sendBtnTooltip')}
                                        >
                                          {strSend}
                                        </button>
                                      </div>
                                    </td>
                                  );
                                case 'comment':
                                  return (
                                    <td key="comment">
                                      <div
                                        className="pcan-cell font-sans text-[var(--text-secondary)]"
                                        title={entry.comment || entry.creator}
                                      >
                                        <span className="truncate">
                                          {entry.comment
                                            ? `${entry.creator}: ${entry.comment}`
                                            : entry.creator}
                                        </span>
                                      </div>
                                    </td>
                                  );
                                default:
                                  return null;
                              }
                            })}
                          </tr>

                          {/* Expanded Symbolic TX Signal Values (Locked 26px height) */}
                          {isExpanded && msgSchema && (
                            <TxSymbolicSignalRows
                              msgSchema={msgSchema}
                              signalsById={databaseStore.getBusSignals(entry.busId)}
                              signalValues={entry.signalValues}
                              visibleCols={visibleTxCols}
                            />
                          )}
                        </React.Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>

      {modalState.open && (
        <TxMessageModal
          initialEntry={modalState.editing}
          defaultBusId={header.buses.find((b) => b.connected)?.busId ?? 0}
          onClose={() => setModalState({ open: false, editing: null })}
          onSave={(saved) => void handleSaveModalEntry(saved)}
        />
      )}

      {activeDrag && (
        <div
          style={{
            position: 'fixed',
            left: `${activeDrag.clientX + 12}px`,
            top: `${activeDrag.clientY + 12}px`,
            pointerEvents: 'none',
            zIndex: 9999,
          }}
          className="px-2 py-1 bg-[#1F242C] border border-[#58A6FF] rounded text-[11px] font-mono text-white shadow-lg flex items-center gap-1.5"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[#58A6FF]" />
          <span>{getColumnLabel(activeDrag.table, activeDrag.sourceCol, t)}</span>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Clean 3-Step Guided Onboarding when Receive list is empty
// ============================================================================

interface RxEmptyOnboardingProps {
  hasActiveWorkspace: boolean;
  anyBusConnected: boolean;
  hasSchema: boolean;
  schemaName?: string;
  onOpenNewConnection: () => void;
  onGoToConnections: () => void;
  onOpenDb: () => void;
  onLoadSampleDb: () => void;
  onAddTx: () => void;
  onCreateProject: () => void;
  onOpenProject: () => void;
}

const RxEmptyOnboarding: React.FC<RxEmptyOnboardingProps> = ({
  hasActiveWorkspace,
  anyBusConnected,
  hasSchema,
  schemaName,
  onOpenNewConnection,
  onGoToConnections,
  onOpenDb,
  onLoadSampleDb,
  onAddTx,
  onCreateProject,
  onOpenProject,
}) => {
  const { t } = useI18n();

  return (
    <div className="p-6 flex flex-col items-center justify-center text-center font-sans">
      {!hasActiveWorkspace && (
        <div
          style={{
            backgroundColor: 'rgba(56, 139, 253, 0.08)',
            borderColor: 'rgba(56, 139, 253, 0.30)',
          }}
          className="mb-4 px-3.5 py-2 border rounded-sm flex items-center justify-between gap-4 max-w-[760px] w-full text-left"
        >
          <div>
            <span className="text-[12px] font-semibold text-sky-400">
              {t('rxtx.onboarding.noProjectTitle')}
            </span>
            <p className="text-[11px] text-[var(--text-secondary)]">
              {t('rxtx.onboarding.noProjectDesc')}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={onCreateProject}
              style={{
                backgroundColor: 'rgba(56, 139, 253, 0.18)',
                borderColor: 'rgba(56, 139, 253, 0.50)',
                color: '#6CB6FF',
              }}
              className="h-[22px] px-2.5 border text-[10px] font-semibold cursor-pointer hover:opacity-90"
            >
              {t('rxtx.onboarding.newProject')}
            </button>
            <button
              type="button"
              onClick={onOpenProject}
              style={{
                backgroundColor: 'var(--bg-toolbar)',
                borderColor: 'var(--border-strong)',
              }}
              className="h-[22px] px-2.5 border text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              {t('rxtx.onboarding.openProject')}
            </button>
          </div>
        </div>
      )}

      <div className="max-w-[760px] w-full text-left">
        <div className="text-[12px] font-bold text-[var(--text-primary)] mb-1 flex items-center gap-2">
          <span>{t('rxtx.onboarding.standbyTitle')}</span>
          <span className="text-[10px] font-mono text-[var(--text-muted)] font-normal">
            {t('rxtx.onboarding.standbyDesc')}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2">
          {/* Step 1: Connect Interface */}
          <div
            style={{
              backgroundColor: 'var(--bg-input)',
              borderColor: anyBusConnected ? 'rgba(16, 185, 129, 0.40)' : 'var(--border-grid)',
            }}
            className="p-3 border rounded-sm flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between gap-1 mb-1.5">
                <span className="text-[11px] font-bold text-[var(--text-primary)]">
                  {t('rxtx.onboarding.step1Title')}
                </span>
                {anyBusConnected ? (
                  <span className="text-[9px] font-mono font-bold text-emerald-400 bg-emerald-500/15 px-1 py-0.5 border border-emerald-500/30 rounded-xs flex items-center gap-1">
                    <CheckCircle2 className="w-2.5 h-2.5" />
                    <span>{t('rxtx.onboarding.connected')}</span>
                  </span>
                ) : (
                  <span className="text-[9px] font-mono text-[var(--text-muted)] bg-[var(--bg-panel)] px-1 py-0.5 border border-[var(--border-grid)] rounded-xs">
                    {t('rxtx.onboarding.offline')}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-[var(--text-secondary)] leading-relaxed">
                {t('rxtx.onboarding.step1Desc')}
              </p>
            </div>

            <div className="mt-3 flex items-center gap-1.5 pt-2 border-t border-[var(--border-grid)]">
              <button
                type="button"
                onClick={onOpenNewConnection}
                style={{
                  backgroundColor: 'rgba(63, 185, 128, 0.14)',
                  borderColor: 'rgba(63, 185, 128, 0.50)',
                  color: 'var(--text-primary)',
                }}
                className="h-[22px] px-2 border text-[10px] font-semibold hover:opacity-90 cursor-pointer"
              >
                {t('rxtx.onboarding.newConn')}
              </button>
              <button
                type="button"
                onClick={onGoToConnections}
                style={{
                  backgroundColor: 'var(--bg-panel)',
                  borderColor: 'var(--border-strong)',
                }}
                className="h-[22px] px-2 border text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                {t('rxtx.onboarding.toConn')}
              </button>
            </div>
          </div>

          {/* Step 2: Load Symbol DB */}
          <div
            style={{
              backgroundColor: 'var(--bg-input)',
              borderColor: hasSchema ? 'rgba(16, 185, 129, 0.40)' : 'var(--border-grid)',
            }}
            className="p-3 border rounded-sm flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between gap-1 mb-1.5">
                <span className="text-[11px] font-bold text-[var(--text-primary)]">
                  {t('rxtx.onboarding.step2Title')}
                </span>
                {hasSchema ? (
                  <span className="text-[9px] font-mono font-bold text-emerald-400 bg-emerald-500/15 px-1 py-0.5 border border-emerald-500/30 rounded-xs flex items-center gap-1 truncate max-w-[110px]" title={schemaName}>
                    <CheckCircle2 className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate">{schemaName}</span>
                  </span>
                ) : (
                  <span className="text-[9px] font-mono text-[var(--text-muted)] bg-[var(--bg-panel)] px-1 py-0.5 border border-[var(--border-grid)] rounded-xs">
                    {t('rxtx.onboarding.rawMode')}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-[var(--text-secondary)] leading-relaxed">
                {t('rxtx.onboarding.step2Desc')}
              </p>
            </div>

            <div className="mt-3 flex items-center gap-1.5 pt-2 border-t border-[var(--border-grid)]">
              <button
                type="button"
                onClick={onOpenDb}
                style={{
                  backgroundColor: 'var(--bg-panel)',
                  borderColor: 'var(--border-strong)',
                }}
                className="h-[22px] px-2 border text-[10px] font-medium text-[var(--text-primary)] hover:border-[var(--text-secondary)] cursor-pointer"
              >
                {t('rxtx.onboarding.toDb')}
              </button>
              <button
                type="button"
                onClick={onLoadSampleDb}
                style={{
                  backgroundColor: 'var(--bg-toolbar)',
                  borderColor: 'var(--border-strong)',
                }}
                className="h-[22px] px-1.5 border text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                {t('rxtx.onboarding.bindToConn')}
              </button>
            </div>
          </div>

          {/* Step 3: Monitor & Transmit */}
          <div
            style={{
              backgroundColor: 'var(--bg-input)',
              borderColor: 'var(--border-grid)',
            }}
            className="p-3 border rounded-sm flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between gap-1 mb-1.5">
                <span className="text-[11px] font-bold text-[var(--text-primary)]">
                  {t('rxtx.onboarding.step3Title')}
                </span>
                <span className="text-[9px] font-mono text-sky-400 bg-sky-500/15 px-1 py-0.5 border border-sky-500/30 rounded-xs">
                  {t('rxtx.onboarding.ready')}
                </span>
              </div>
              <p className="text-[10px] text-[var(--text-secondary)] leading-relaxed">
                {t('rxtx.onboarding.step3Desc')}
              </p>
            </div>

            <div className="mt-3 flex items-center gap-1.5 pt-2 border-t border-[var(--border-grid)]">
              <button
                type="button"
                onClick={onAddTx}
                style={{
                  backgroundColor: 'var(--bg-panel)',
                  borderColor: 'var(--border-strong)',
                }}
                className="h-[22px] px-2 border text-[10px] font-semibold text-[var(--text-primary)] hover:border-[var(--text-secondary)] cursor-pointer flex items-center gap-1"
              >
                <Plus className="w-2.5 h-2.5 text-emerald-400" />
                <span>{t('rxtx.onboarding.addTxMsg')}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Clean Indented RX Error Detail Rows for Frame.isError
// ============================================================================

interface RxErrorDetailRowsProps {
  frame: FrameTelemetryDto;
  colSpan: number;
}

const RxErrorDetailRows: React.FC<RxErrorDetailRowsProps> = ({ frame, colSpan }) => {
  const fields = useMemo(() => {
    return decodeCanErrorFields(frame.arbId, frame.rawBytes);
  }, [frame.arbId, frame.rawBytes]);

  const arrivalSec = (frame.lastTimestampUs / 1_000_000).toFixed(6);

  return (
    <tr style={{ backgroundColor: 'rgba(69, 10, 10, 0.45)' }}>
      <td className="px-0" />
      <td colSpan={colSpan} className="p-2">
        <div className="border-l-2 border-[var(--status-critical)] pl-3 space-y-1.5 font-mono text-[11.5px]">
          <div className="flex items-center gap-3 text-[11px] text-[var(--status-critical)] font-semibold flex-wrap">
            <span>CAN BUS ERROR DIAGNOSTICS</span>
            <span className="text-[var(--text-secondary)] font-normal">
              Arrival: <span className="text-[var(--text-primary)] font-mono">{arrivalSec} s</span> ({frame.lastTimestampUs} µs)
            </span>
            <span className="text-[var(--text-secondary)] font-normal">
              Bus {frame.busId + 1}
            </span>
            <span className="text-[var(--text-secondary)] font-normal">
              Count: <span className="text-[var(--text-primary)] font-mono">{frame.rxCount}</span>
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 pt-1">
            {fields.map((f, idx) => (
              <div
                key={idx}
                className="flex items-start justify-between gap-2 p-1.5 bg-[var(--bg-panel)] border border-[var(--border-grid)]"
              >
                <span className="text-[var(--text-muted)] shrink-0 font-sans text-[11px]">
                  {f.label}:
                </span>
                <span
                  className={`font-mono text-right text-[11.5px] select-all ${
                    f.isCritical ? 'text-[var(--status-critical)] font-bold' : 'text-[var(--text-primary)]'
                  }`}
                >
                  {f.value}
                </span>
              </div>
            ))}
          </div>

          {frame.rawBytes.length > 0 && (
            <div className="flex items-center gap-2 pt-1 text-[11px] text-[var(--text-secondary)]">
              <span className="font-sans">Payload Hex:</span>
              <span className="font-mono text-[var(--status-critical)] select-all font-semibold">
                {frame.rawBytes
                  .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
                  .join(' ')}
              </span>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
};

// ============================================================================
// Clean Indented RX Signal Tree Rows (Locked 26px height, crisp 12px font)
// ============================================================================

function makeWatchSignal(busId: number, signal: SignalSchemaDto) {
  return {
    key: `${busId}:${signal.signalId}`,
    busId,
    signalId: signal.signalId,
    name: signal.name,
    unit: signal.unit,
    min: signal.min,
    max: signal.max,
  };
}

interface RxSignalTreeRowsProps {
  rowKey: string;
  frame: FrameTelemetryDto;
  signalsById: readonly (SignalSchemaDto | undefined)[];
  recentlyChangedSignals: ReadonlySet<string>;
  visibleCols: readonly RxColumnId[];
}

const RxSignalTreeRows: React.FC<RxSignalTreeRowsProps> = ({
  rowKey,
  frame,
  signalsById,
  recentlyChangedSignals,
  visibleCols,
}) => {
  const { t } = useI18n();
  const visibleSignals: readonly LiveSignalDto[] = useMemo(() => {
    return [...frame.signals].sort((a, b) => a.signalId - b.signalId);
  }, [frame.signals]);

  if (visibleSignals.length === 0) {
    return (
      <tr style={{ backgroundColor: 'var(--bg-row-signal)' }}>
        <td className="px-0" />
        <td colSpan={visibleCols.length}>
          <div className="pcan-cell pl-3 border-l-2 border-[var(--border-strong)] font-sans text-[12px] text-[var(--text-muted)]">
            {t('rxtx.rx.noDecodedSignals')}
          </div>
        </td>
      </tr>
    );
  }

  const dataIdx = visibleCols.indexOf('data');

  return (
    <>
      {visibleSignals.map((sig) => {
        const sigSchema = signalsById[sig.signalId];
        const enumLabel = sigSchema?.enumTable[String(Math.trunc(sig.rawInt))];
        const changed =
          recentlyChangedSignals.has(`${rowKey}:${sig.signalId}`) ||
          recentlyChangedSignals.has(`${frame.busId}:${sig.signalId}`);

        const formattedVal = enumLabel
          ? `${enumLabel} (${Math.trunc(sig.rawInt)})`
          : `${formatPhysicalValue(sig.physicalValue, sigSchema)}${
              sigSchema?.unit ? ` ${sigSchema.unit}` : ''
            }`;

        const rawHex = formatRawHex(sig.rawInt, sigSchema?.bitLength ?? 16);
        const muxInfo =
          sigSchema?.muxRole === 'multiplexed'
            ? sig.activeInLastFrame
              ? ` · m${formatMuxRanges(sigSchema.muxRanges)}`
              : ` · Ret ${Math.round(sig.ageMs)}ms`
            : '';

        const nameCellContent = (
          <div className="pcan-cell justify-between gap-2 pl-3 border-l-2 border-[var(--border-strong)] font-sans">
            <div className="flex items-center min-w-0">
              <span className="text-[var(--text-muted)] font-mono mr-1.5 shrink-0">
                ~
              </span>
              <span
                className="truncate font-medium text-[var(--text-primary)]"
                title={sigSchema?.comment ?? sigSchema?.name}
              >
                {sigSchema?.name ?? `Signal_${sig.signalId}`}
              </span>
              {sigSchema?.muxRole === 'masterSwitch' && (
                <span className="ml-1.5 px-1 h-[15px] leading-[13px] text-[10px] font-mono text-amber-400 border border-amber-500/40 shrink-0">
                  M
                </span>
              )}
            </div>
            {sigSchema && (
              <QuickPlotButton
                busId={frame.busId}
                signalId={sig.signalId}
                hoverReveal
                onToggle={() => plotStore.toggleSignal(frame.busId, sigSchema)}
              />
            )}
          </div>
        );

        const valCellContent = (
          <div className="pcan-cell font-mono tabular-nums select-text">
            <span className="text-[var(--text-muted)] mr-1.5 shrink-0">=</span>
            <span
              className={`truncate pcan-sig-val ${
                changed ? 'pcan-sig-val-changed' : 'text-[var(--text-primary)]'
              }`}
            >
              {formattedVal}
            </span>
            {sig.outOfRange && (
              <span className="text-red-500 ml-2 font-sans text-[11px] font-semibold shrink-0">
                {t('rxtx.common.outOfRange')}
              </span>
            )}
          </div>
        );

        const rawCellContent = (
          <div
            className="pcan-cell pcan-cell-right font-mono tabular-nums text-[11px] text-[var(--text-muted)]"
            title={`Raw: ${rawHex}${muxInfo}`}
          >
            <span className="truncate">
              {rawHex}
              {muxInfo}
            </span>
          </div>
        );

        const afterDataSpan = visibleCols.length - dataIdx - 1;

        return (
          <tr
            key={sig.signalId}
            onContextMenu={(event) => openContextMenu(event, [
              { label: t('context.copySignalValue'), run: () => copyMenuText(formattedVal) },
              {
                label: t('context.watchSignal'),
                run: () => {
                  if (sigSchema) workbenchStore.addWatchSignal(makeWatchSignal(frame.busId, sigSchema));
                },
                disabled: !sigSchema,
              },
            ])}
            style={{ backgroundColor: 'var(--bg-row-signal)' }}
            className="group text-[12px] hover:!bg-[var(--bg-row-hover)]"
          >
            {/* Empty Expand column */}
            <td className="px-0">
              <div className="pcan-cell" />
            </td>

            {dataIdx >= 1 ? (
              <>
                <td colSpan={dataIdx}>{nameCellContent}</td>
                <td>{valCellContent}</td>
                {afterDataSpan > 0 ? (
                  <td colSpan={afterDataSpan}>{rawCellContent}</td>
                ) : null}
              </>
            ) : dataIdx === 0 ? (
              <>
                <td>{valCellContent}</td>
                <td colSpan={visibleCols.length - 1}>
                  <div className="flex items-center justify-between">
                    {nameCellContent}
                    {rawCellContent}
                  </div>
                </td>
              </>
            ) : (
              <>
                <td colSpan={Math.max(1, Math.floor(visibleCols.length / 2))}>
                  {nameCellContent}
                </td>
                <td colSpan={visibleCols.length - Math.max(1, Math.floor(visibleCols.length / 2))}>
                  <div className="flex items-center justify-between">
                    {valCellContent}
                    {rawCellContent}
                  </div>
                </td>
              </>
            )}
          </tr>
        );
      })}
    </>
  );
};

// ============================================================================
// Expanded Symbolic TX Signal Tree Rows (Locked 26px height)
// ============================================================================

interface TxSymbolicSignalRowsProps {
  msgSchema: MessageSchemaDto;
  signalsById: readonly (SignalSchemaDto | undefined)[];
  signalValues: Readonly<Record<number, number>>;
  visibleCols: readonly TxColumnId[];
}

const TxSymbolicSignalRows: React.FC<TxSymbolicSignalRowsProps> = ({
  msgSchema,
  signalsById,
  signalValues,
  visibleCols,
}) => {
  const { activeSignalIds } = useMemo(
    () => resolveMuxChainFromSignalValues(msgSchema, signalsById, signalValues),
    [msgSchema, signalsById, signalValues],
  );

  const visibleSignalIds = useMemo(() => {
    return msgSchema.signalIds.filter((id) => activeSignalIds.has(id));
  }, [msgSchema.signalIds, activeSignalIds]);

  const dataIdx = visibleCols.indexOf('data');

  return (
    <>
      {visibleSignalIds.map((sigId) => {
        const sig = signalsById[sigId];
        if (!sig) return null;
        const val = signalValues[sigId] ?? sig.initialValue ?? 0;
        const rawInt =
          sig.factor !== 0
            ? Math.round((val - sig.offset) / sig.factor)
            : Math.round(val);
        const enumLabel = sig.enumTable[String(rawInt)];

        const nameContent = (
          <div className="pcan-cell pl-3 border-l-2 border-sky-500/50 font-sans">
            <span className="text-sky-500 font-mono font-bold mr-1.5 shrink-0">
              ~
            </span>
            <span className="truncate font-medium">{sig.name}</span>
            {sig.muxRole === 'masterSwitch' && (
              <span className="ml-1.5 px-1 h-[15px] leading-[13px] text-[10px] font-mono text-amber-400 border border-amber-500/40 shrink-0">
                M
              </span>
            )}
          </div>
        );

        const valContent = (
          <div className="pcan-cell font-mono tabular-nums">
            <span className="text-[var(--text-muted)] mr-1.5 shrink-0">=</span>
            <span className="font-semibold truncate">
              {enumLabel
                ? `${enumLabel} (${rawInt})`
                : `${formatPhysicalValue(val, sig)}${sig.unit ? ` ${sig.unit}` : ''}`}
            </span>
          </div>
        );

        return (
          <tr
            key={sigId}
            style={{ backgroundColor: 'var(--bg-row-signal)' }}
            className="text-[12px]"
          >
            <td className="px-0">
              <div className="pcan-cell" />
            </td>
            {dataIdx >= 1 ? (
              <>
                <td colSpan={dataIdx}>{nameContent}</td>
                <td colSpan={visibleCols.length - dataIdx}>{valContent}</td>
              </>
            ) : dataIdx === 0 ? (
              <>
                <td>{valContent}</td>
                <td colSpan={visibleCols.length - 1}>{nameContent}</td>
              </>
            ) : (
              <>
                <td colSpan={Math.max(1, Math.floor(visibleCols.length / 2))}>
                  {nameContent}
                </td>
                <td colSpan={visibleCols.length - Math.max(1, Math.floor(visibleCols.length / 2))}>
                  {valContent}
                </td>
              </>
            )}
          </tr>
        );
      })}
    </>
  );
};

const ShortcutsHelp: React.FC = () => {
  const { t } = useI18n();
  const [open, setOpen] = useState<boolean>(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (ev: PointerEvent): void => {
      if (!rootRef.current?.contains(ev.target as Node)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const rows: readonly (readonly [string, string])[] = [
    ['← / →', t('rxtx.kbd.expandCollapse')],
    ['Ctrl+A / ⌘A', t('rxtx.kbd.selectAll')],
    ['\u2191 / \u2193', t('rxtx.kbd.txNav')],
    ['Home / End', t('rxtx.kbd.txJump')],
    ['Enter', t('rxtx.kbd.txEdit')],
    ['Delete', t('rxtx.kbd.txDelete')],
    ['Space', t('rxtx.kbd.txSend')],
    ['Ctrl+V', t('rxtx.kbd.txPaste')],
    ['\u2191 / \u2193 / Home / End', t('rxtx.kbd.rxNav')],
    ['Ctrl+C', t('rxtx.kbd.rxCopy')],
    ['Ctrl+T', t('rxtx.kbd.rxToTx')],
    ['Delete', t('rxtx.kbd.rxDelete')],
  ];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          backgroundColor: 'var(--bg-panel)',
          borderColor: 'var(--border-strong)',
          color: 'var(--text-secondary)',
        }}
        className="h-[28px] w-[28px] border flex items-center justify-center hover:text-[var(--text-primary)] cursor-pointer"
        title={t('rxtx.kbd.tooltip')}
        aria-label={t('rxtx.kbd.tooltip')}
      >
        <Keyboard className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div
          style={{
            backgroundColor: 'var(--bg-header)',
            borderColor: 'var(--border-strong)',
            color: 'var(--text-primary)',
          }}
          className="absolute right-0 top-[32px] z-50 w-[420px] max-w-[90vw] border p-2.5 text-[11.5px]"
        >
          <div className="font-semibold mb-1.5">{t('rxtx.kbd.title')}</div>
          <div className="text-[var(--text-muted)] mb-2">{t('rxtx.kbd.scope')}</div>
          <table className="w-full">
            <tbody>
              {rows.map(([keys, desc]) => (
                <tr key={keys + desc}>
                  <td className="pr-3 py-0.5 whitespace-nowrap font-mono tabular-nums text-sky-400 align-top">
                    {keys}
                  </td>
                  <td className="py-0.5 font-sans text-[var(--text-secondary)]">{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
