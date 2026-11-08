import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Edit3,
  Pause,
  Plus,
  RotateCcw,
  Send,
  Settings,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';
import {
  apiArmActiveBus,
  apiDisconnectBus,
  apiListPeriodicTx,
  apiResetTelemetry,
  apiSetBusMode,
  apiStopPeriodicTx,
  apiTransmitRawFrame,
  apiTransmitSignalFrame,
} from '../services/ipcClient';
import {
  connectionStore,
  useConnectionStore,
} from '../store/connectionStore';
import { databaseStore, useDatabaseStore } from '../store/databaseStore';
import { plotStore } from '../store/plotStore';
import { projectStore, useProjectStore } from '../store/projectStore';
import { cloudBridgeStore } from '../store/cloudBridgeStore';
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
import { BusStateBadge } from './BusStateBadge';
import { NewConnectionModal } from './NewConnectionModal';
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

const RX_COLUMN_DEFS: Record<
  RxColumnId,
  { label: string; align: 'left' | 'right'; font?: 'font-sans' | 'font-mono' }
> = {
  bus: { label: 'Bus', align: 'left' },
  type: { label: 'Type', align: 'left' },
  id: { label: 'ID', align: 'left' },
  idDec: { label: 'ID Dec', align: 'right' },
  pgn: { label: 'PGN', align: 'left' },
  sa: { label: 'SA', align: 'left' },
  dlc: { label: 'DLC', align: 'right' },
  symbol: { label: 'Symbol', align: 'left', font: 'font-sans' },
  data: { label: 'Data', align: 'left' },
  cycle: { label: 'Cycle', align: 'right' },
  count: { label: 'Count', align: 'right' },
};

const TX_COLUMN_DEFS: Record<
  TxColumnId,
  { label: string; align: 'left' | 'right'; font?: 'font-sans' | 'font-mono' }
> = {
  bus: { label: 'Bus', align: 'left' },
  type: { label: 'Type', align: 'left' },
  id: { label: 'ID', align: 'left' },
  dlc: { label: 'DLC', align: 'right' },
  symbol: { label: 'Symbol', align: 'left', font: 'font-sans' },
  data: { label: 'Data', align: 'left' },
  cycle: { label: 'Cycle', align: 'right' },
  count: { label: 'Count', align: 'right' },
  trigger: { label: 'Trigger', align: 'left', font: 'font-sans' },
  comment: { label: 'Comment', align: 'left', font: 'font-sans' },
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

function getColumnLabel(table: 'rx' | 'tx', colId: string): string {
  if (table === 'rx') {
    return RX_COLUMN_DEFS[colId as RxColumnId]?.label ?? colId;
  }
  return TX_COLUMN_DEFS[colId as TxColumnId]?.label ?? colId;
}

function getFrameTypeTag(
  frame: { isFd: boolean; dlc: number; isTx?: boolean },
  msgSchema?: MessageSchemaDto,
): { label: string; cls: string } {
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

export const ReceiveTransmitView: React.FC<ReceiveTransmitViewProps> = ({
  devices,
  bitrateProfileId: _bitrateProfileId,
  mockFpsPreset: _mockFpsPreset,
  statusBanner,
  onStatusMessage,
  onSwitchToActiveTx,
  panicCounter,
}) => {
  const dbState = useDatabaseStore();
  const header = useTelemetryHeader();
  const framesSlice = useTelemetryFrames();
  const txState = useTransmitStore();
  const projState = useProjectStore();

  const [onboardingNewConnModalOpen, setOnboardingNewConnModalOpen] = useState<boolean>(false);

  // Resizable Receive vs Transmit vertical split ratio
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const [rxHeightPct, setRxHeightPct] = useState<number>(60);
  const draggingRef = useRef<boolean>(false);

  // Receive pane controls (expandedRxKeys persisted in databaseStore for Project save/restore)
  const [rxFilter, setRxFilter] = useState<string>('');
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
      const msgSchema = databaseStore.getMessageForBus(f.busId, f.messageKey, f.arbId, f.isExtended);
      const signalsById = databaseStore.getBusSignals(f.busId);
      const muxSym = formatMultiplexedSymbol(msgSchema, signalsById, f.activeMuxSwitches);

      if (q.length > 0) {
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
  }, [framesSlice.frames, rxFilter, dbState.busSchemas]);

  // Transmit execution helper (single-shot or start periodic)
  const sendTxEntry = useCallback(
    async (entry: TxListEntry, startPeriodic: boolean): Promise<void> => {
      const busHealth = header.buses.find(
        (b) => b.busId === entry.busId && b.connected,
      );
      if (!busHealth) {
        onStatusMessage({
          kind: 'error',
          message: `Cannot transmit: Bus ${entry.busId + 1} is disconnected. Click "Switch to Active TX" first.`,
        });
        return;
      }
      if (busHealth.listenOnly || !busHealth.txArmed) {
        onStatusMessage({
          kind: 'error',
          message: `TX Locked on Bus ${entry.busId + 1} (${busHealth.listenOnly ? 'Listen-Only' : 'Disarmed'}). Click "Switch to Active TX" in the Transmit toolbar.`,
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
          message: `TX failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setBusyTxIds((prev) => {
          const next = new Set(prev);
          next.delete(entry.id);
          return next;
        });
      }
    },
    [header.buses, onStatusMessage],
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
      message: `Paused ${activeEntries.length} periodic transmit message(s).`,
    });
  };

  const handleDeleteSelectedTx = async (): Promise<void> => {
    const sel = txState.entries.find((e) => e.id === txState.selectedEntryId);
    if (!sel) return;
    if (sel.periodicEnabled && sel.backendJobId !== null) {
      try {
        await apiStopPeriodicTx(sel.backendJobId);
      } catch {
        // Ignore
      }
    }
    transmitStore.removeEntry(sel.id);
  };

  const handleClearReceive = async (): Promise<void> => {
    await apiResetTelemetry().catch(() => undefined);
    telemetryStore.clearAllTelemetry();
    transmitStore.resetCounters();
    onStatusMessage({
      kind: 'info',
      message: 'Cleared Receive, Trace & frame counters.',
    });
  };

  const handleResetTxCounts = (): void => {
    transmitStore.resetCounters();
    onStatusMessage({
      kind: 'info',
      message: 'Reset Transmit message counters.',
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
      message: 'Cleared Transmit message list.',
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

  // Spacebar single-shot trigger for selected TX row (PCAN-Explorer standard!)
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (modalState.open) return;
      if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return;
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      if (ev.code === 'Space' && txState.selectedEntryId) {
        const selected = txState.entries.find((e) => e.id === txState.selectedEntryId);
        if (selected) {
          ev.preventDefault();
          void sendTxEntry(selected, false);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modalState.open, txState.selectedEntryId, txState.entries, sendTxEntry]);

  const selectedTxEntry =
    txState.entries.find((e) => e.id === txState.selectedEntryId) ?? null;

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden select-none">
      {/* MAIN DRAG-RESIZABLE RECEIVE (TOP) + TRANSMIT (BOTTOM) WORKSPACE */}
      <div
        ref={splitContainerRef}
        className="flex flex-col flex-1 min-h-0 overflow-hidden"
      >
        {/* ================================================================ */}
        {/* 1. TOP PANE: RECEIVE LIST (LIVE RX + TX LOOPBACK ECHO)           */}
        {/* ================================================================ */}
        <section
          style={{ height: `${rxHeightPct}%`, backgroundColor: 'var(--bg-panel)' }}
          className="flex min-h-[120px] overflow-hidden"
        >
          {/* Left 22px Rotated "Receive" Strip */}
          <div className="pcan-side-strip">
            <span className="pcan-side-strip-label">Receive</span>
          </div>

          <div className="flex flex-col flex-1 min-w-0 min-h-0">
            {/* Slim 26px Receive Sub-Toolbar */}
            <div
              style={{
                backgroundColor: 'var(--bg-toolbar)',
                borderBottom: '1px solid var(--border-strong)',
              }}
              className="shrink-0 h-[26px] px-2 flex items-center justify-between gap-2 text-[11px]"
            >
              <div className="flex items-center gap-2">
                <span className="text-[var(--text-secondary)]">Filter:</span>
                <div className="relative flex items-center">
                  <input
                    type="text"
                    value={rxFilter}
                    onChange={(e) => setRxFilter(e.target.value)}
                    placeholder="ID, Symbol, Signal..."
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="h-[20px] w-44 px-1.5 pr-5 border text-[11px] focus:outline-none"
                  />
                  {rxFilter && (
                    <button
                      type="button"
                      onClick={() => setRxFilter('')}
                      className="absolute right-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>

                <span className="text-[var(--text-secondary)] ml-1">Columns:</span>
                <select
                  aria-label="Receive Table Columns Profile"
                  value={rxColumnMode}
                  onChange={(e) => setRxColumnMode(e.target.value as RxColumnMode)}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="h-[20px] px-1.5 border text-[11px] focus:outline-none"
                >
                  <option value="CAN">CAN (Hex)</option>
                  <option value="CAN_DEC">CAN (Hex + Dec)</option>
                  <option value="J1939">J1939</option>
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
                    className="h-[20px] px-1.5 border text-[10px] hover:text-[var(--text-primary)] cursor-pointer"
                    title="Reset Receive column widths and order to default"
                  >
                    Reset Columns
                  </button>
                )}
              </div>

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void handleClearReceive()}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="h-[20px] px-2 border flex items-center gap-1 font-medium hover:border-[var(--text-secondary)] cursor-pointer"
                  title="Clear Receive list, Trace buffer & RX/TX frame counters (Esc)"
                >
                  <RotateCcw className="w-3 h-3 text-[var(--text-secondary)]" />
                  <span>Clear (Esc)</span>
                </button>
                <div className="h-3.5 w-[1px] bg-[var(--border-strong)] mx-0.5" />
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
                  className="h-[20px] px-2 border hover:text-[var(--text-primary)] cursor-pointer"
                >
                  Expand All
                </button>
                <button
                  type="button"
                  onClick={() => setExpandedRxKeys(new Set())}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-grid)',
                    color: 'var(--text-secondary)',
                  }}
                  className="h-[20px] px-2 border hover:text-[var(--text-primary)] cursor-pointer"
                >
                  Collapse All
                </button>
              </div>
            </div>

            {/* Flat Dense PCAN Receive Grid (table-layout: fixed, locked 26px rows) */}
            <div className="flex-1 min-h-0 overflow-auto flex flex-col">
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
                      const def = RX_COLUMN_DEFS[colId];
                      const isDropTarget = activeDrag?.table === 'rx' && activeDrag.overCol === colId;
                      const isDraggingThis = activeDrag?.table === 'rx' && activeDrag.sourceCol === colId;

                      return (
                        <th
                          key={colId}
                          data-rx-col={colId}
                          onPointerDown={(e) => handleHeaderPointerDown(e, 'rx', colId)}
                          className={`${def.align === 'right' ? 'text-right' : 'text-left'} select-none cursor-grab active:cursor-grabbing ${def.font ?? ''} ${isDraggingThis ? 'opacity-40' : ''}`}
                          title={`${def.label} (Drag to reorder · Double-click right edge to reset width)`}
                        >
                          {isDropTarget && (
                            <span
                              className={`absolute top-0 bottom-0 w-[2px] bg-[#58A6FF] z-20 pointer-events-none ${
                                activeDrag.side === 'before' ? 'left-0' : 'right-0'
                              }`}
                            />
                          )}
                          <span className="truncate block pr-1.5">{def.label}</span>
                          <span
                            data-resize-handle
                            onPointerDown={(e) => handleResizePointerDown(e, 'rx', colId)}
                            onDoubleClick={(e) => handleResetColumnWidth(e, 'rx', colId)}
                            className="absolute top-0 right-0 bottom-0 w-[6px] cursor-col-resize hover:bg-[#58A6FF]/40 z-10"
                            title="Drag to resize column · Double-click to auto-fit"
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
                          ? `${muxSym.fullSymbol} (${switchEntries.map(([k, v]) => `${k}=${v}`).join(', ')}) · Double-click for Bit Layout`
                          : `${msgSchema.name} (Double-click for Bit Layout)`
                        : undefined;

                      return (
                        <React.Fragment key={rowKey}>
                          <tr
                            onClick={() =>
                              setExpandedRxKeys((prev) => {
                                const next = new Set(prev);
                                if (next.has(rowKey)) next.delete(rowKey);
                                else next.add(rowKey);
                                return next;
                              })
                            }
                            onDoubleClick={() => {
                              if (msgSchema) {
                                databaseStore.selectMessageInSymbolsTab(
                                  msgSchema.messageKey,
                                );
                              }
                            }}
                            style={{
                              backgroundColor:
                                rowIdx % 2 === 1 ? 'var(--bg-row-alt)' : 'var(--bg-panel)',
                            }}
                            className="hover:!bg-[var(--bg-row-hover)] cursor-pointer"
                          >
                            {/* Expand Chevron */}
                            <td className="px-0">
                              <div className="pcan-cell pcan-cell-center">
                                {frame.signals.length > 0 || msgSchema ? (
                                  isExpanded ? (
                                    <ChevronDown className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
                                  ) : (
                                    <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                                  )
                                ) : null}
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
                                            ? 'Self-transmitted loopback frame (from Transmit list)'
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
                                        className="pcan-cell"
                                        title={`Dec: ${frame.arbId}`}
                                      >
                                        {formatPcanIdHex(frame.arbId, frame.isExtended)}
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
                                        title={muxTooltip}
                                      >
                                        {msgSchema ? (
                                          <span className="truncate">
                                            <span style={{ color: '#E6EDF3' }}>{muxSym.baseName}</span>
                                            {muxSym.muxSuffix !== null && (
                                              <span
                                                className="font-mono tabular-nums font-semibold"
                                                style={{ color: '#79C0FF' }}
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

                          {/* Inline Tree Signal Rows (Locked 26px height, crisp 12px font) */}
                          {isExpanded && (
                            <RxSignalTreeRows
                              rowKey={rowKey}
                              frame={frame}
                              signalsById={signalsById}
                              recentlyChangedSignals={framesSlice.recentlyChangedSignals}
                              visibleCols={visibleRxCols}
                            />
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
                  onOpenNewConnection={() => setOnboardingNewConnModalOpen(true)}
                  onGoToConnections={() => databaseStore.setActiveDocTab('connections')}
                  onOpenDb={() => databaseStore.setActiveDocTab('symbols')}
                  onLoadSampleDb={() => databaseStore.setActiveDocTab('connections')}
                  onAddTx={() => setModalState({ open: true, editing: null })}
                  onCreateProject={async () => {
                    await projectStore.createNewCleanProject('Vehicle Bench 01');
                    if (Boolean(cloudBridgeStore.getState().sessionToken)) {
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
          style={{ height: `${100 - rxHeightPct}%`, backgroundColor: 'var(--bg-panel)' }}
          className="flex min-h-[110px] overflow-hidden"
        >
          {/* Left 22px Rotated "Transmit" Strip */}
          <div className="pcan-side-strip">
            <span className="pcan-side-strip-label">Transmit</span>
          </div>

          <div className="flex flex-col flex-1 min-w-0 min-h-0">
            {/* Slim 26px Transmit Sub-Toolbar */}
            <div
              style={{
                backgroundColor: 'var(--bg-toolbar)',
                borderBottom: '1px solid var(--border-strong)',
              }}
              className="shrink-0 h-[26px] px-2 flex items-center justify-between gap-2 text-[11px]"
            >
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setModalState({ open: true, editing: null })}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="h-[20px] px-2 border flex items-center gap-1 font-medium hover:border-[var(--text-secondary)] cursor-pointer"
                >
                  <Plus className="w-3 h-3 text-[var(--text-secondary)]" />
                  <span>New Message...</span>
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
                  className="h-[20px] px-2 border flex items-center gap-1 hover:border-[var(--text-secondary)] disabled:opacity-40 cursor-pointer"
                >
                  <Edit3 className="w-3 h-3 text-[var(--text-secondary)]" />
                  <span>Edit...</span>
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
                  className="h-[20px] px-2 border flex items-center gap-1 hover:border-[var(--text-secondary)] disabled:opacity-40 cursor-pointer"
                >
                  <Trash2 className="w-3 h-3 text-[var(--text-secondary)]" />
                  <span>Delete</span>
                </button>

                <div className="h-3.5 w-[1px] bg-[var(--border-strong)] mx-0.5" />

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
                  className="h-[20px] px-2 border flex items-center gap-1 font-semibold hover:border-[var(--text-secondary)] disabled:opacity-40 cursor-pointer"
                  title="Transmit selected frame once immediately (Space)"
                >
                  <Send className="w-3 h-3 text-[var(--text-secondary)]" />
                  <span>Send (Space)</span>
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
                  className="h-[20px] px-2 border flex items-center gap-1 hover:border-[var(--text-secondary)] disabled:opacity-40 cursor-pointer"
                >
                  <Pause className="w-3 h-3 text-[var(--text-secondary)]" />
                  <span>Pause All</span>
                </button>

                <div className="h-3.5 w-[1px] bg-[var(--border-strong)] mx-0.5" />

                <button
                  type="button"
                  disabled={txState.entries.length === 0}
                  onClick={handleResetTxCounts}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="h-[20px] px-2 border flex items-center gap-1 hover:border-[var(--text-secondary)] disabled:opacity-40 cursor-pointer"
                  title="Zero sent counters on all Transmit entries"
                >
                  <RotateCcw className="w-3 h-3 text-[var(--text-secondary)]" />
                  <span>Reset Counts</span>
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
                  className="h-[20px] px-2 border flex items-center gap-1 hover:border-[var(--text-secondary)] disabled:opacity-40 cursor-pointer"
                  title="Stop active periodic TX jobs and clear all entries from the Transmit list"
                >
                  <Trash2 className="w-3 h-3 text-[var(--text-secondary)]" />
                  <span>Clear List</span>
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
                    className="h-[20px] px-1.5 border text-[10px] hover:text-[var(--text-primary)] cursor-pointer"
                    title="Reset Transmit column widths and order to default"
                  >
                    Reset Columns
                  </button>
                )}
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
                    <div className="flex items-center gap-1.5 text-[10px] font-mono text-[var(--text-muted)]">
                      <span>No Active Bus</span>
                    </div>
                  );
                }

                const isReady = Boolean(!targetBus.listenOnly && targetBus.txArmed);

                return (
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-[var(--text-secondary)]">
                      Bus {targetBus.busId + 1} ({targetBus.channelName}):
                    </span>
                    {isReady ? (
                      <span className="flex items-center gap-1.5 text-amber-400 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                        <span>TX Armed</span>
                      </span>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[var(--text-muted)]">
                          {targetBus.listenOnly ? 'Listen-Only' : 'TX Disarmed'}
                        </span>
                        <button
                          type="button"
                          onClick={() => void onSwitchToActiveTx(targetBus.busId)}
                          style={{
                            backgroundColor: 'rgba(217, 155, 38, 0.14)',
                            borderColor: 'rgba(217, 155, 38, 0.55)',
                            color: '#E3B341',
                          }}
                          className="h-[20px] px-2 border hover:border-amber-400 flex items-center gap-1 font-medium cursor-pointer"
                          title={`Switch Bus ${targetBus.busId + 1} (${targetBus.channelName}) to Active TX Armed`}
                        >
                          <Unlock className="w-3 h-3" />
                          <span>Enable Active TX</span>
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
                    <th className="text-center" style={{ width: '48px' }}>On</th>
                    {visibleTxCols.map((colId) => {
                      const def = TX_COLUMN_DEFS[colId];
                      const isDropTarget = activeDrag?.table === 'tx' && activeDrag.overCol === colId;
                      const isDraggingThis = activeDrag?.table === 'tx' && activeDrag.sourceCol === colId;

                      return (
                        <th
                          key={colId}
                          data-tx-col={colId}
                          onPointerDown={(e) => handleHeaderPointerDown(e, 'tx', colId)}
                          className={`${def.align === 'right' ? 'text-right' : 'text-left'} select-none cursor-grab active:cursor-grabbing ${def.font ?? ''} ${isDraggingThis ? 'opacity-40' : ''}`}
                          title={`${def.label} (Drag to reorder · Double-click right edge to reset width)`}
                        >
                          {isDropTarget && (
                            <span
                              className={`absolute top-0 bottom-0 w-[2px] bg-[#58A6FF] z-20 pointer-events-none ${
                                activeDrag.side === 'before' ? 'left-0' : 'right-0'
                              }`}
                            />
                          )}
                          <span className="truncate block pr-1.5">{def.label}</span>
                          <span
                            data-resize-handle
                            onPointerDown={(e) => handleResizePointerDown(e, 'tx', colId)}
                            onDoubleClick={(e) => handleResetColumnWidth(e, 'tx', colId)}
                            className="absolute top-0 right-0 bottom-0 w-[6px] cursor-col-resize hover:bg-[#58A6FF]/40 z-10"
                            title="Drag to resize column · Double-click to auto-fit"
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
                          No transmit entries
                        </div>
                      </td>
                    </tr>
                  ) : (
                    txState.entries.map((entry) => {
                      const isSelected = entry.id === txState.selectedEntryId;
                      const isExpanded = expandedTxIds.has(entry.id);
                      const msgSchema =
                        entry.mode === 'symbolic'
                          ? databaseStore.getMessageForBus(
                              entry.busId,
                              entry.messageKey ?? '',
                              entry.arbId,
                              entry.isExtended,
                            )
                          : undefined;
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
                            onClick={() => transmitStore.selectEntry(entry.id)}
                            onDoubleClick={() =>
                              setModalState({ open: true, editing: entry })
                            }
                            style={{
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
                                      ? `Enable/Stop ${entry.cycleTimeMs} ms periodic transmission`
                                      : 'Start 100 ms periodic transmission (or click [Send] for manual shot)'
                                  }
                                  className="accent-emerald-600 cursor-pointer shrink-0"
                                />
                                {hasSignals && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setExpandedTxIds((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(entry.id)) next.delete(entry.id);
                                        else next.add(entry.id);
                                        return next;
                                      })
                                    }
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
                                            : entry.symbolName || 'Custom Raw'
                                        }
                                      >
                                        {txMuxInfo ? (
                                          <span className="truncate">
                                            <span style={{ color: '#E6EDF3' }}>
                                              {txMuxInfo.formatted.baseName}
                                            </span>
                                            {txMuxInfo.formatted.muxSuffix !== null && (
                                              <span
                                                className="font-mono tabular-nums font-semibold"
                                                style={{ color: '#79C0FF' }}
                                              >
                                                .{txMuxInfo.formatted.muxSuffix}
                                              </span>
                                            )}
                                          </span>
                                        ) : (
                                          <span className="truncate">
                                            {entry.symbolName || 'Custom Raw'}
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
                                          <span className="text-[var(--text-secondary)]">Wait</span>
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
                                            ? 'Manual'
                                            : entry.periodicEnabled
                                              ? 'Periodic'
                                              : 'Paused'}
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
                                          title="Send frame once now"
                                        >
                                          Send
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

      {/* ================================================================ */}
      {/* 3. MULTI-BUS CONNECTIONS DOCK & CLASSIC DESKTOP STATUS FOOTER     */}
      {/* ================================================================ */}
      <BottomConnectionsDock
        devices={devices}
        statusBanner={statusBanner}
        onStatusMessage={onStatusMessage}
      />

      {modalState.open && (
        <TxMessageModal
          initialEntry={modalState.editing}
          defaultBusId={header.buses.find((b) => b.connected)?.busId ?? 0}
          onClose={() => setModalState({ open: false, editing: null })}
          onSave={(saved) => void handleSaveModalEntry(saved)}
        />
      )}


      {onboardingNewConnModalOpen && (
        <NewConnectionModal
          devices={devices}
          onClose={() => setOnboardingNewConnModalOpen(false)}
          onStatusMessage={onStatusMessage}
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
          <span>{getColumnLabel(activeDrag.table, activeDrag.sourceCol)}</span>
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
              No project workspace initialized
            </span>
            <p className="text-[11px] text-[var(--text-secondary)]">
              Create a named project or open an existing one to persist symbols, connections & plot setups.
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
              New Project
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
              Open...
            </button>
          </div>
        </div>
      )}

      <div className="max-w-[760px] w-full text-left">
        <div className="text-[12px] font-bold text-[var(--text-primary)] mb-1 flex items-center gap-2">
          <span>Telemetry Pipeline Standby</span>
          <span className="text-[10px] font-mono text-[var(--text-muted)] font-normal">
            (Follow steps below to start live data capture)
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
                  Step 1 · Interface
                </span>
                {anyBusConnected ? (
                  <span className="text-[9px] font-mono font-bold text-emerald-400 bg-emerald-500/15 px-1 py-0.5 border border-emerald-500/30 rounded-xs flex items-center gap-1">
                    <CheckCircle2 className="w-2.5 h-2.5" />
                    <span>Connected</span>
                  </span>
                ) : (
                  <span className="text-[9px] font-mono text-[var(--text-muted)] bg-[var(--bg-panel)] px-1 py-0.5 border border-[var(--border-grid)] rounded-xs">
                    Offline
                  </span>
                )}
              </div>
              <p className="text-[10px] text-[var(--text-secondary)] leading-relaxed">
                Enable a saved interface in Connections or add a new adapter (SocketCAN, SLCAN, PCAN, Kvaser, mock0).
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
                + New Connection
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
                Connections →
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
                  Step 2 · Symbol DB
                </span>
                {hasSchema ? (
                  <span className="text-[9px] font-mono font-bold text-emerald-400 bg-emerald-500/15 px-1 py-0.5 border border-emerald-500/30 rounded-xs flex items-center gap-1 truncate max-w-[110px]" title={schemaName}>
                    <CheckCircle2 className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate">{schemaName}</span>
                  </span>
                ) : (
                  <span className="text-[9px] font-mono text-[var(--text-muted)] bg-[var(--bg-panel)] px-1 py-0.5 border border-[var(--border-grid)] rounded-xs">
                    Raw Mode
                  </span>
                )}
              </div>
              <p className="text-[10px] text-[var(--text-secondary)] leading-relaxed">
                Add .dbc / .kcd files to the Databases catalog, then bind them per connection (Bus) for physical signal decoding.
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
                Databases →
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
                Bağlantıya Bağla →
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
                  Step 3 · TX & Trace
                </span>
                <span className="text-[9px] font-mono text-sky-400 bg-sky-500/15 px-1 py-0.5 border border-sky-500/30 rounded-xs">
                  Ready
                </span>
              </div>
              <p className="text-[10px] text-[var(--text-secondary)] leading-relaxed">
                Once connected, live bus frames stream here automatically. Compose single-shot or periodic frames in Transmit.
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
                <span>Add TX Message...</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Clean Indented RX Signal Tree Rows (Locked 26px height, crisp 12px font)
// ============================================================================

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
  const visibleSignals: readonly LiveSignalDto[] = useMemo(() => {
    return [...frame.signals].sort((a, b) => a.signalId - b.signalId);
  }, [frame.signals]);

  if (visibleSignals.length === 0) {
    return (
      <tr style={{ backgroundColor: 'var(--bg-row-signal)' }}>
        <td className="px-0" />
        <td colSpan={visibleCols.length}>
          <div className="pcan-cell pl-3 border-l-2 border-[var(--border-strong)] font-sans text-[12px] text-[var(--text-muted)]">
            No decoded signals
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
                [Out of Range]
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

// ============================================================================
// Interactive Multi-Bus Connections Dock & Classic Desktop Status Footer
// ============================================================================

interface BottomConnectionsDockProps {
  devices: readonly DeviceDescriptorDto[];
  statusBanner: StatusBanner | null;
  onStatusMessage: (msg: StatusBanner) => void;
}

const BottomConnectionsDock: React.FC<BottomConnectionsDockProps> = ({
  devices,
  statusBanner,
  onStatusMessage,
}) => {
  const header = useTelemetryHeader();
  const connState = useConnectionStore();

  const [newConnModalOpen, setNewConnModalOpen] = useState<boolean>(false);
  const [busyBusIds, setBusyBusIds] = useState<Set<number>>(() => new Set());

  // STRICT INVARIANT (RULE 4): ONLY actively connected buses appear here!
  const connectedBuses = header.buses.filter((b) => b.connected);
  const connectedCount = connectedBuses.length;

  const handleDisconnectBus = async (busId: number): Promise<void> => {
    setBusyBusIds((prev) => new Set(prev).add(busId));
    try {
      await apiDisconnectBus(busId);
      telemetryStore.removeBusHealth(busId);
      onStatusMessage({
        kind: 'info',
        message: `Disconnected Bus ${busId + 1}.`,
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: `Disconnect error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyBusIds((prev) => {
        const next = new Set(prev);
        next.delete(busId);
        return next;
      });
    }
  };

  const handleToggleArmTx = async (busId: number, currentArmed: boolean): Promise<void> => {
    setBusyBusIds((prev) => new Set(prev).add(busId));
    try {
      const updated = await apiArmActiveBus(busId, !currentArmed);
      telemetryStore.upsertBusHealth(updated);
      onStatusMessage({
        kind: !currentArmed ? 'success' : 'info',
        message: !currentArmed
          ? `TX Armed on Bus ${busId + 1} (${updated.channelName}).`
          : `TX Disarmed on Bus ${busId + 1} (${updated.channelName}).`,
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: `Arm TX error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyBusIds((prev) => {
        const next = new Set(prev);
        next.delete(busId);
        return next;
      });
    }
  };

  const handleSwitchToActiveTx = async (busId: number): Promise<void> => {
    setBusyBusIds((prev) => new Set(prev).add(busId));
    try {
      const armed = await apiSetBusMode(busId, false, true);
      telemetryStore.upsertBusHealth(armed);
      const prof = connState.profiles.find((p) => p.busId === busId);
      if (prof) {
        connectionStore.upsertProfile({ ...prof, listenOnly: false });
      }
      onStatusMessage({
        kind: 'success',
        message: `Bus ${busId + 1} (${armed.channelName}) switched to Active TX Armed.`,
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: `Switch to Active TX failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyBusIds((prev) => {
        const next = new Set(prev);
        next.delete(busId);
        return next;
      });
    }
  };

  // If no buses are connected, render a clean, slim 24px bar (Zero clutter!)
  if (connectedCount === 0) {
    return (
      <footer
        style={{
          backgroundColor: 'var(--bg-panel)',
          borderTop: '1px solid var(--border-strong)',
        }}
        className="shrink-0 select-none"
      >
        <div
          style={{
            backgroundColor: 'var(--bg-toolbar)',
            color: 'var(--text-secondary)',
          }}
          className="h-[24px] px-2.5 flex items-center justify-between text-[11px] font-sans"
        >
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-muted)]" />
            <span className="font-medium text-[var(--text-muted)]">
              Active Connections (0) — No active CAN bus
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setNewConnModalOpen(true)}
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              className="h-[18px] px-2 border flex items-center gap-1 text-[10px] font-semibold hover:border-[var(--text-secondary)] cursor-pointer"
            >
              <Plus className="w-2.5 h-2.5 text-emerald-400" />
              <span>+ New Connection</span>
            </button>
            <button
              type="button"
              onClick={() => databaseStore.setActiveDocTab('connections')}
              className="text-[10px] text-sky-400 hover:underline cursor-pointer"
            >
              Open Connections ({connState.profiles.length} configured)...
            </button>
          </div>
        </div>

        {/* Bottom 22px Classic Status Strip */}
        <div
          style={{
            backgroundColor: 'var(--bg-toolbar)',
            borderTop: '1px solid var(--border-grid)',
            color: 'var(--text-secondary)',
          }}
          className="h-[22px] px-2 flex items-center justify-between text-[11px] font-mono tabular-nums"
        >
          <span className="truncate font-sans text-[var(--text-muted)]">
            {statusBanner ? statusBanner.message : 'Ready'}
          </span>
          <div className="flex items-center shrink-0 text-[var(--text-muted)]">
            <span className="inline-flex items-center justify-between w-[144px] pr-2.5">
              <span>Rx Total:</span>
              <span className="text-right text-[var(--text-secondary)]">
                {header.totalFramesRx.toLocaleString('en-US')}
              </span>
            </span>
            <span className="inline-flex items-center justify-between w-[144px] pl-2.5 border-l border-[var(--border-grid)]">
              <span>Tx Total:</span>
              <span className="text-right text-[var(--text-secondary)]">
                {header.totalFramesTx.toLocaleString('en-US')}
              </span>
            </span>
          </div>
        </div>

        {newConnModalOpen && (
          <NewConnectionModal
            devices={devices}
            onClose={() => setNewConnModalOpen(false)}
            onStatusMessage={onStatusMessage}
          />
        )}
      </footer>
    );
  }

  // When buses ARE connected, render compact table strictly with active buses!
  return (
    <footer
      style={{
        backgroundColor: 'var(--bg-panel)',
        borderTop: '1px solid var(--border-strong)',
      }}
      className="shrink-0 select-none"
    >
      {/* Active Buses Header (24px) */}
      <div
        style={{
          backgroundColor: 'var(--bg-toolbar)',
          borderBottom: '1px solid var(--border-strong)',
        }}
        className="h-[24px] px-2 flex items-center justify-between text-[11px]"
      >
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]" />
          <span className="font-semibold text-[var(--text-primary)]">
            Active Connections ({connectedCount})
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setNewConnModalOpen(true)}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[18px] px-2 border flex items-center gap-1 text-[10px] font-semibold hover:border-[var(--text-secondary)] cursor-pointer"
          >
            <Plus className="w-2.5 h-2.5 text-emerald-400" />
            <span>+ Add Connection</span>
          </button>

          <button
            type="button"
            onClick={() => databaseStore.setActiveDocTab('connections')}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[18px] px-2 border flex items-center gap-1 text-[10px] hover:text-[var(--text-primary)] cursor-pointer"
            title="Open Advanced Connections Workspace"
          >
            <Settings className="w-2.5 h-2.5" />
            <span>Manage All...</span>
          </button>
        </div>
      </div>

      {/* Active Connected Buses Grid */}
      <div className="max-h-[115px] overflow-y-auto">
        <table className="pcan-grid pcan-grid-fixed font-mono tabular-nums">
          <colgroup>
            <col style={{ width: '38px' }} />
            <col style={{ width: '56px' }} />
            <col />
            <col style={{ width: '150px' }} />
            <col style={{ width: '120px' }} />
            <col style={{ width: '115px' }} />
            <col style={{ width: '76px' }} />
            <col style={{ width: '76px' }} />
            <col style={{ width: '76px' }} />
            <col style={{ width: '60px' }} />
            <col style={{ width: '32px' }} />
          </colgroup>
          <thead>
            <tr>
              <th className="text-center font-sans" title="Connected Toggle (Uncheck to disconnect)">On</th>
              <th>Bus</th>
              <th className="font-sans">Connection / Hardware</th>
              <th className="font-sans">Bit Rate</th>
              <th className="font-sans">Mode</th>
              <th className="font-sans">Bus State</th>
              <th className="text-right">Rx/s</th>
              <th className="text-right">Tx/s</th>
              <th className="text-right">Load</th>
              <th className="text-right">Ovr</th>
              <th className="text-center font-sans" title="Configure">⚙</th>
            </tr>
          </thead>
          <tbody>
            {connectedBuses.map((bus) => {
              const prof = connState.profiles.find((p) => p.busId === bus.busId);
              const dev = devices.find((d) => d.deviceId === bus.deviceId);
              const isBusy = busyBusIds.has(bus.busId);
              const isMock = bus.channelName.toLowerCase().includes('mock');

              const bitRateLabel = isMock
                ? prof?.mockFpsPreset === null
                  ? '500k/2M FD · 16 msg/s'
                  : `500k/2M FD · ${prof?.mockFpsPreset} msg/s`
                : prof?.enableFd
                  ? `${Math.round((prof.bitrate ?? 500000) / 1000)}k/${Math.round((prof.dataBitrate ?? 2000000) / 1000000)}M FD`
                  : `${Math.round((prof?.bitrate ?? 500000) / 1000)}k CC`;

              return (
                <tr key={bus.busId} className="hover:!bg-[var(--bg-row-hover)] cursor-default text-[11px]">
                  {/* 1. Connected Checkbox */}
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="pcan-cell pcan-cell-center">
                      <input
                        type="checkbox"
                        checked={true}
                        disabled={isBusy}
                        onChange={() => void handleDisconnectBus(bus.busId)}
                        className="accent-emerald-600 cursor-pointer"
                        title={`Bus ${bus.busId + 1} (${bus.channelName}) is connected. Uncheck to Disconnect.`}
                      />
                    </div>
                  </td>

                  {/* 2. Bus */}
                  <td>
                    <div className="pcan-cell font-semibold">Bus {bus.busId + 1}</div>
                  </td>

                  {/* 3. Name & Hardware */}
                  <td>
                    <div className="pcan-cell font-sans font-medium" title={prof?.name ?? bus.channelName}>
                      <span className="truncate">{prof?.name ?? dev?.displayName ?? bus.channelName}</span>
                    </div>
                  </td>

                  {/* 4. Bit Rate */}
                  <td>
                    <div className="pcan-cell text-[10px]">
                      <span className="truncate">{bitRateLabel}</span>
                    </div>
                  </td>

                  {/* 5. Mode / TX Toggle */}
                  <td>
                    <div className="pcan-cell font-sans">
                      {bus.listenOnly ? (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleSwitchToActiveTx(bus.busId)}
                          style={{
                            backgroundColor: 'rgba(217, 155, 38, 0.12)',
                            borderColor: 'rgba(217, 155, 38, 0.50)',
                            color: '#E3B341',
                          }}
                          className="h-[18px] px-1.5 border text-[10px] font-semibold hover:border-amber-400 cursor-pointer"
                          title="Click to Switch to Active TX Armed"
                        >
                          Switch to TX
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleToggleArmTx(bus.busId, Boolean(bus.txArmed))}
                          style={{
                            backgroundColor: bus.txArmed
                              ? 'rgba(217, 155, 38, 0.22)'
                              : 'var(--bg-panel)',
                            borderColor: bus.txArmed ? '#E3B341' : 'var(--border-strong)',
                            color: bus.txArmed ? '#E3B341' : 'var(--text-muted)',
                          }}
                          className="h-[18px] px-1.5 border text-[10px] font-semibold cursor-pointer"
                          title="Click to toggle TX Armed / Disarmed"
                        >
                          {bus.txArmed ? 'TX Armed' : 'Disarmed'}
                        </button>
                      )}
                    </div>
                  </td>

                  {/* 6. Bus State & TEC/REC */}
                  <td>
                    <div className="pcan-cell">
                      <BusStateBadge
                        busState={bus.busState}
                        connected={bus.connected}
                        txErrorCount={bus.txErrorCount}
                        rxErrorCount={bus.rxErrorCount}
                        showTecRec
                        compact
                      />
                    </div>
                  </td>

                  {/* 7. Rx/s */}
                  <td>
                    <div className="pcan-cell pcan-cell-right">
                      {Math.round(header.fpsRx)}
                    </div>
                  </td>

                  {/* 8. Tx/s */}
                  <td>
                    <div className="pcan-cell pcan-cell-right">
                      {Math.round(header.fpsTx)}
                    </div>
                  </td>

                  {/* 9. Load */}
                  <td>
                    <div className="pcan-cell pcan-cell-right">
                      {header.estimatedBusLoadPct.toFixed(1)}%
                    </div>
                  </td>

                  {/* 10. Overruns */}
                  <td>
                    <div
                      className={`pcan-cell pcan-cell-right ${
                        header.droppedFrames > 0 ? 'text-red-500 font-bold' : 'text-[var(--text-muted)]'
                      }`}
                    >
                      {header.droppedFrames}
                    </div>
                  </td>

                  {/* 11. Settings Icon */}
                  <td>
                    <div className="pcan-cell pcan-cell-center">
                      <button
                        type="button"
                        onClick={() => {
                          if (prof) connectionStore.selectProfile(prof.id);
                          databaseStore.setActiveDocTab('connections');
                        }}
                        className="text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                        title="Configure profile in Connections workspace"
                      >
                        <Settings className="w-3 h-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Bottom 22px Classic Status Strip */}
      <div
        style={{
          backgroundColor: 'var(--bg-toolbar)',
          borderTop: '1px solid var(--border-strong)',
          color: 'var(--text-secondary)',
        }}
        className="h-[22px] px-2 flex items-center justify-between text-[11px] font-mono tabular-nums"
      >
        <div className="flex items-center gap-3 min-w-0 truncate font-sans">
          <span
            className={`truncate ${
              statusBanner?.kind === 'error'
                ? 'text-red-500 font-semibold'
                : statusBanner?.kind === 'success'
                  ? 'text-emerald-500'
                  : 'text-[var(--text-muted)]'
            }`}
          >
            {statusBanner ? statusBanner.message : 'Ready'}
          </span>
        </div>

        <div className="flex items-center shrink-0 text-[var(--text-muted)]">
          <button
            type="button"
            onClick={() => databaseStore.setActiveDocTab('connections')}
            className="font-sans pr-3 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline cursor-pointer"
            title="Open Multi-Bus Connections, USB/COM Serial & Driver Diagnostics"
          >
            Connections ({connectedCount} online)...
          </button>
          <span className="inline-flex items-center justify-between w-[144px] px-2.5 border-l border-[var(--border-grid)]">
            <span>Rx Total:</span>
            <span className="text-right text-[var(--text-secondary)]">
              {header.totalFramesRx.toLocaleString('en-US')}
            </span>
          </span>
          <span className="inline-flex items-center justify-between w-[144px] pl-2.5 border-l border-[var(--border-grid)]">
            <span>Tx Total:</span>
            <span className="text-right text-[var(--text-secondary)]">
              {header.totalFramesTx.toLocaleString('en-US')}
            </span>
          </span>
        </div>
      </div>

      {newConnModalOpen && (
        <NewConnectionModal
          devices={devices}
          onClose={() => setNewConnModalOpen(false)}
          onStatusMessage={onStatusMessage}
        />
      )}
    </footer>
  );
};
