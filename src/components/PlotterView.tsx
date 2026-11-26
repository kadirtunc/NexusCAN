import { nativeContextMenuPending, openContextMenu, showContextMenu } from './ContextMenu';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlignJustify,
  ChevronDown,
  ChevronRight,
  Columns2,
  Download,
  FastForward,
  GitCommitVertical,
  Hand,
  HelpCircle,
  Layers,
  Maximize2,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Plus,
  RotateCcw,
  ScanSearch,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  databaseStore,
  type ProjectDatabaseEntry,
  useDatabaseStore,
} from '../store/databaseStore';
import {
  connectionStore,
  MAX_BUS_ID,
  useConnectionStore,
} from '../store/connectionStore';
import { useTraceSessionsStore } from '../store/traceSessionsStore';
import {
  telemetryStore,
  useTelemetryHeader,
} from '../store/telemetryStore';
import {
  apiControlTraceReplay,
  apiSetBusDatabases,
} from '../services/ipcClient';
import { syncAllBusDatabasesWithBackend } from '../utils/busDatabaseSync';
import type { ChronologicalFrameDto } from '../types/telemetry';
import {
  PLOT_MAX_SPAN_SEC,
  PLOT_MIN_SPAN_SEC,
  PLOT_RING_CAPACITY,
  type PlotSeriesEntry,
  type PlotSplitRowHeight,
  type PlotYScaleMode,
  computeNiceStep,
  makePlotSeriesKey,
  plotStore,
  usePlotStore,
} from '../store/plotStore';
import type { SignalSchemaDto } from '../types/netdb';
import { formatPcanIdHex } from '../utils/formatters';
import { useI18n } from '../i18n';
import { GuideInfoButton, GuideTourButton } from '../onboarding/GuideButtons';
import { GuideStrip } from '../onboarding/GuideStrip';

const TIME_PRESETS_SEC: readonly number[] = [1, 5, 10, 30, 60, 120, 300];
const SPLIT_HEIGHT_OPTIONS: readonly { label: string; px: PlotSplitRowHeight }[] = [
  { label: 'S', px: 140 },
  { label: 'M', px: 200 },
  { label: 'L', px: 280 },
];

interface SeriesBounds {
  yMin: number;
  yMax: number;
}

function resolveSeriesYBounds(entry: PlotSeriesEntry): SeriesBounds {
  const autoMin = entry.stickyAutoYMin;
  const autoMax = entry.stickyAutoYMax > autoMin ? entry.stickyAutoYMax : autoMin + 1;
  entry.lastAutoYMin = autoMin;
  entry.lastAutoYMax = autoMax;

  if (!entry.autoScale) {
    const span = entry.customYMax - entry.customYMin;
    return {
      yMin: entry.customYMin,
      yMax: span > 1e-9 ? entry.customYMax : entry.customYMin + 1,
    };
  }
  return { yMin: autoMin, yMax: autoMax };
}

function findValueAtTime(entry: PlotSeriesEntry, targetTimeSec: number): number | null {
  const count = entry.count;
  if (count === 0) return null;
  const startPos = (entry.writePos - count + PLOT_RING_CAPACITY) % PLOT_RING_CAPACITY;

  let left = 0;
  let right = count - 1;
  while (left < right) {
    const mid = (left + right) >>> 1;
    const midIdx = (startPos + mid) % PLOT_RING_CAPACITY;
    if (entry.timestamps[midIdx] < targetTimeSec) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  const candIdx = (startPos + left) % PLOT_RING_CAPACITY;
  if (left > 0) {
    const prevIdx = (startPos + left - 1) % PLOT_RING_CAPACITY;
    if (
      Math.abs(targetTimeSec - entry.timestamps[prevIdx]) <=
      Math.abs(entry.timestamps[candIdx] - targetTimeSec)
    ) {
      return entry.values[prevIdx];
    }
  }
  return entry.values[candIdx];
}

function formatAxisNum(val: number, ySpan?: number): string {
  if (!Number.isFinite(val)) return '0';
  if (ySpan !== undefined && ySpan > 0) {
    if (ySpan < 0.02) return val.toFixed(4);
    if (ySpan < 0.2) return val.toFixed(3);
    if (ySpan < 2) return val.toFixed(2);
    if (ySpan < 25) return val.toFixed(2);
    if (ySpan < 250) return val.toFixed(1);
    return val.toFixed(0);
  }
  const abs = Math.abs(val);
  if (abs >= 1000) return val.toFixed(0);
  if (abs >= 100) return val.toFixed(1);
  if (abs >= 1) return val.toFixed(2);
  if (abs === 0) return '0.00';
  return val.toFixed(3);
}

function formatTimeTick(tSec: number, spanSec: number): string {
  if (spanSec < 0.5) return `${tSec.toFixed(3)}s`;
  if (spanSec < 5) return `${tSec.toFixed(2)}s`;
  if (spanSec < 60) return `${tSec.toFixed(1)}s`;
  return `${tSec.toFixed(0)}s`;
}

function formatSpanBadge(spanSec: number): string {
  if (spanSec < 1) {
    return `${Math.round(spanSec * 1000)} ms`;
  }
  if (spanSec < 10) {
    return `${spanSec.toFixed(2)} s`;
  }
  if (spanSec < 100) {
    return `${spanSec.toFixed(1)} s`;
  }
  return `${Math.round(spanSec)} s`;
}

function formatDeltaTime(dtSec: number): string {
  const abs = Math.abs(dtSec);
  const sign = dtSec >= 0 ? '+' : '-';
  if (abs < 1) {
    return `${sign}${(abs * 1000).toFixed(1)} ms`;
  }
  return `${sign}${abs.toFixed(3)} s`;
}

export const PlotterView: React.FC = () => {
  const { t, locale } = useI18n();
  const dbState = useDatabaseStore();
  const connState = useConnectionStore();
  const plotState = usePlotStore();
  const traceState = useTraceSessionsStore();
  const telemetryHeader = useTelemetryHeader();
  const replay = telemetryHeader.replay;

  const pickerOpen = plotState.pickerOpen;
  const pickerBusId = plotState.pickerBusId;
  const pickerFilter = plotState.pickerFilter;

  const [expandedMsgs, setExpandedMsgs] = useState<Set<string>>(() => new Set());
  const [helpOpen, setHelpOpen] = useState<boolean>(false);
  const [csvFeedback, setCsvFeedback] = useState<string | null>(null);
  const [, setHudTick] = useState<number>(0);

  // Synchronized time-cursor X fraction (0..1) across Combined & all Split scopes
  const sharedCursorRatioRef = useRef<number | null>(null);
  // Tracks temporary Spacebar hold for Pan-on-Space+Drag vs Tap-Space-to-Pause
  const spaceHeldRef = useRef<boolean>(false);
  const spaceUsedForDragRef = useRef<boolean>(false);

  // 8Hz HUD refresh for top digital Min/Max/Latest & Delta Cursor bar
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!plotStore.getState().paused || plotStore.getState().deltaCursorsEnabled) {
        setHudTick((n) => (n + 1) % 1_000_000);
      }
    }, 125);
    return () => window.clearInterval(id);
  }, []);

  // Oscilloscope Keyboard Shortcuts (active on Plotter tab when no input is focused)
  useEffect(() => {
    const isInputFocused = (target: EventTarget | null): boolean => {
      const tag = (target as HTMLElement | null)?.tagName;
      return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
    };

    const onKeyDown = (ev: KeyboardEvent): void => {
      if (isInputFocused(ev.target)) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

      if (ev.code === 'Space') {
        ev.preventDefault();
        if (!ev.repeat) {
          spaceHeldRef.current = true;
          spaceUsedForDragRef.current = false;
        }
        return;
      }

      switch (ev.key) {
        case '+':
        case '=':
          ev.preventDefault();
          plotStore.zoomTimeAtRatio(0.8, plotStore.getViewport().liveFollow ? 1 : 0.5);
          break;
        case '-':
        case '_':
          ev.preventDefault();
          plotStore.zoomTimeAtRatio(1.25, plotStore.getViewport().liveFollow ? 1 : 0.5);
          break;
        case 'ArrowLeft': {
          ev.preventDefault();
          const { span } = plotStore.getEffectiveTimeWindow();
          plotStore.panTimeBy(-span * 0.2, true);
          break;
        }
        case 'ArrowRight': {
          ev.preventDefault();
          const { span } = plotStore.getEffectiveTimeWindow();
          plotStore.panTimeBy(span * 0.2, true);
          break;
        }
        case 'ArrowUp':
          ev.preventDefault();
          plotStore.panVisibleYByFraction(0.15);
          break;
        case 'ArrowDown':
          ev.preventDefault();
          plotStore.panVisibleYByFraction(-0.15);
          break;
        case 'f':
        case 'F':
          ev.preventDefault();
          plotStore.setLiveFollow(true);
          break;
        case 'r':
        case 'R':
        case '0':
          ev.preventDefault();
          plotStore.resetFullView();
          break;
        case 'Backspace':
          ev.preventDefault();
          plotStore.popZoomHistory();
          break;
        case 'h':
        case 'H':
          ev.preventDefault();
          plotStore.setDragTool('pan');
          break;
        case 'z':
        case 'Z':
          ev.preventDefault();
          plotStore.setDragTool('boxZoom');
          break;
        default:
          break;
      }
    };

    const onKeyUp = (ev: KeyboardEvent): void => {
      if (ev.code === 'Space') {
        const wasHeld = spaceHeldRef.current;
        const usedForDrag = spaceUsedForDragRef.current;
        spaceHeldRef.current = false;
        spaceUsedForDragRef.current = false;
        if (wasHeld && !usedForDrag && !isInputFocused(ev.target)) {
          ev.preventDefault();
          plotStore.setPaused(!plotStore.getState().paused);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Active trace session for instant waveform loading
  const activeTraceSession =
    traceState.sessions.find((s) => s.id === traceState.activeSessionId) ??
    traceState.sessions[0];

  const handlePlotActiveTrace = useCallback((): void => {
    if (!activeTraceSession || activeTraceSession.count === 0) return;
    const frames: ChronologicalFrameDto[] = [];
    const ring = activeTraceSession.displayRing;
    for (let i = 0; i < ring.length; i++) {
      const f = ring.getAt(i);
      if (f) frames.push(f);
    }
    if (frames.length > 0) {
      plotStore.loadFromTraceFrames(
        frames,
        (bId) =>
          databaseStore.getBusSchema(bId) ??
          databaseStore.getState().schema ??
          databaseStore.getState().databases.find((d) => d.schema)?.schema ??
          null,
      );
    }
  }, [activeTraceSession]);

  const handleBindDbcToBus = async (
    busId: number,
    targetDb: ProjectDatabaseEntry,
  ): Promise<void> => {
    const profile = connState.profiles.find((p) => p.busId === busId);
    if (profile) {
      const existing = new Set(profile.databaseIds ?? []);
      existing.add(targetDb.id);
      connectionStore.upsertProfile({
        ...profile,
        databaseIds: Array.from(existing),
      });
      await syncAllBusDatabasesWithBackend({ force: true });
    } else {
      if (targetDb.schema) {
        databaseStore.setBusSchema(busId, targetDb.schema);
      }
      try {
        await apiSetBusDatabases(busId, [
          {
            fileName: targetDb.fileName,
            contentBase64: targetDb.contentBase64,
          },
        ]);
      } catch (err) {
        console.warn('[PlotterView] apiSetBusDatabases error:', err);
      }
    }
  };

  const pickerBusOptions = useMemo(() => {
    let maxBus = Math.max(7, pickerBusId >= 0 ? pickerBusId : 0);
    for (const p of connState.profiles) {
      if (p.busId > maxBus) maxBus = p.busId;
    }
    for (const b of dbState.busSchemas.keys()) {
      if (b > maxBus) maxBus = b;
    }
    const maxBusId = Math.min(MAX_BUS_ID, maxBus);
    const out: { busId: number; label: string }[] = [];
    out.push({
      busId: -1,
      label: t('plotter.bus.allCatalog'),
    });
    for (let b = 0; b <= maxBusId; b++) {
      const prof = connState.profiles.find((p) => p.busId === b);
      const dbCount = dbState.busSchemas.get(b) ? ' · DB' : '';
      out.push({
        busId: b,
        label: prof
          ? `${b + 1} · ${prof.name}${dbCount}`
          : t('plotter.bus.busN', { bus: b + 1 }),
      });
    }
    return out;
  }, [connState.profiles, dbState.busSchemas, pickerBusId, t]);

  // One-time initial fallback: if user has not explicitly chosen a bus yet, pick first bound bus
  useEffect(() => {
    if (plotState.pickerUserSelectedBus) return;
    if (pickerBusId >= 0 && !dbState.busSchemas.has(pickerBusId)) {
      const firstBound = Array.from(dbState.busSchemas.keys()).sort((a, b) => a - b)[0];
      if (firstBound !== undefined) {
        plotStore.setPickerBusId(firstBound, false);
      }
    }
  }, [dbState.busSchemas, pickerBusId, plotState.pickerUserSelectedBus]);

  // Unified signal tree bundle: solves multi-DBC catalog aggregation & prevents signalId collisions!
  interface SignalTreeMessageItem {
    uniqueKey: string;
    messageKey: string;
    name: string;
    arbId: number;
    isExtended: boolean;
    dbName: string;
    effectiveBusId: number;
    signals: SignalSchemaDto[];
  }

  const signalTreeBundle = useMemo<{
    hasAnySchema: boolean;
    items: readonly SignalTreeMessageItem[];
  }>(() => {
    const items: SignalTreeMessageItem[] = [];

    if (pickerBusId >= 0) {
      const lookup = dbState.busSchemas.get(pickerBusId);
      const s = lookup?.schema ?? null;
      if (lookup && s) {
        for (const msg of s.messages) {
          const sigs: SignalSchemaDto[] = [];
          for (const sId of msg.signalIds) {
            const sig = lookup.signalsById[sId];
            if (sig) sigs.push(sig);
          }
          items.push({
            uniqueKey: msg.messageKey,
            messageKey: msg.messageKey,
            name: msg.name,
            arbId: msg.arbId,
            isExtended: msg.isExtended,
            dbName: `Bus ${pickerBusId + 1}`,
            effectiveBusId: pickerBusId,
            signals: sigs,
          });
        }
      }
      return {
        hasAnySchema: Boolean(s),
        items,
      };
    }

    // pickerBusId === -1: Aggregate across all project databases (or dbState.schema fallback)
    let hasAny = false;
    for (const db of dbState.databases) {
      if (!db.schema) continue;
      hasAny = true;
      for (const msg of db.schema.messages) {
        const sigs: SignalSchemaDto[] = [];
        for (const sId of msg.signalIds) {
          const sig = db.schema.signals.find((s) => s.signalId === sId);
          if (sig) sigs.push(sig);
        }
        const assignedBus = databaseStore.findBusForMessage(msg.messageKey) ?? 0;
        items.push({
          uniqueKey: `${db.id}:${msg.messageKey}`,
          messageKey: msg.messageKey,
          name: msg.name,
          arbId: msg.arbId,
          isExtended: msg.isExtended,
          dbName: db.name,
          effectiveBusId: assignedBus,
          signals: sigs,
        });
      }
    }

    if (!hasAny && dbState.schema) {
      hasAny = true;
      for (const msg of dbState.schema.messages) {
        const sigs: SignalSchemaDto[] = [];
        for (const sId of msg.signalIds) {
          const sig = dbState.signalsById[sId];
          if (sig) sigs.push(sig);
        }
        const assignedBus = databaseStore.findBusForMessage(msg.messageKey) ?? 0;
        items.push({
          uniqueKey: msg.messageKey,
          messageKey: msg.messageKey,
          name: msg.name,
          arbId: msg.arbId,
          isExtended: msg.isExtended,
          dbName: 'Katalog',
          effectiveBusId: assignedBus,
          signals: sigs,
        });
      }
    }

    return {
      hasAnySchema: hasAny,
      items,
    };
  }, [
    pickerBusId,
    dbState.busSchemas,
    dbState.databases,
    dbState.schema,
    dbState.signalsById,
  ]);

  const q = pickerFilter.trim().toLowerCase();

  const filteredTreeItems = useMemo<readonly SignalTreeMessageItem[]>(() => {
    if (q.length === 0) return signalTreeBundle.items;
    return signalTreeBundle.items.filter((item) => {
      const idStr = formatPcanIdHex(item.arbId, item.isExtended).toLowerCase();
      if (
        idStr.includes(q) ||
        item.name.toLowerCase().includes(q) ||
        item.dbName.toLowerCase().includes(q)
      ) {
        return true;
      }
      for (const sig of item.signals) {
        if (sig.name.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [signalTreeBundle.items, q]);

  const handleAddQuickDemoSignals = (): void => {
    const targetSchema =
      (pickerBusId >= 0 ? dbState.busSchemas.get(pickerBusId)?.schema : null) ??
      dbState.schema ??
      dbState.databases.find((d) => d.schema)?.schema ??
      null;
    if (!targetSchema) return;
    const targetBus = pickerBusId >= 0 ? pickerBusId : 0;
    const preferredNames = [
      'MotorSpeedRpm',
      'MotorTorqueNm',
      'PackVoltageV',
      'PackCurrentA',
      'Cell01_Voltage',
    ];
    let added = 0;
    for (const target of preferredNames) {
      const found = targetSchema.signals.find(
        (s) => s.name.toLowerCase() === target.toLowerCase(),
      );
      if (found) {
        plotStore.addSignal(targetBus, found);
        added += 1;
      }
      if (added >= 4) break;
    }
    if (added === 0) {
      for (const s of targetSchema.signals.slice(0, 3)) {
        plotStore.addSignal(targetBus, s);
      }
    }
  };

  const visibleSeries = useMemo(
    () => plotState.series.filter((s) => s.visible),
    [plotState.series, plotState.configRev],
  );

  const hasAnySamples = useMemo(
    () => plotState.series.some((s) => s.count > 0),
    [plotState.series, plotState.configRev],
  );

  const handleExportCsv = (): void => {
    const ok = plotStore.downloadWatchedSignalsCsv();
    if (ok) {
      setCsvFeedback(t('plotter.csv.downloaded'));
      setTimeout(() => setCsvFeedback(null), 1500);
    }
  };

  const vp = plotStore.getViewport();
  const cursorA = vp.cursorATimeSec;
  const cursorB = vp.cursorBTimeSec;
  const deltaT =
    plotState.deltaCursorsEnabled && cursorA !== null && cursorB !== null
      ? cursorB - cursorA
      : null;

  return (
    <div
      style={{ backgroundColor: 'var(--bg-panel)' }}
      className="relative flex flex-col flex-1 min-h-0 overflow-hidden select-none"
    >
      <GuideStrip pageId="plotter" />
      {/* ==================================================================== */}
      {/* 1. OSCILLOSCOPE COMMAND TOOLBAR (Scaled & Responsive)                */}
      {/* ==================================================================== */}
      <div
        style={{
          backgroundColor: 'var(--bg-toolbar)',
          borderBottom: '1px solid var(--border-strong)',
        }}
        className="shrink-0 min-h-[40px] py-1 px-3 flex items-center justify-between gap-2 select-none flex-wrap text-[12px]"
      >
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
          <button
            type="button"
            data-tour="plotter.signals"
            onClick={() => plotStore.setPickerOpen(!pickerOpen)}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[28px] px-2.5 border flex items-center gap-1.5 cursor-pointer shrink-0 font-medium"
            title={t('plotter.toolbar.signalsToggleTitle')}
          >
            {pickerOpen ? (
              <PanelLeftClose className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
            ) : (
              <PanelLeftOpen className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
            )}
            <span>
              {t('plotter.toolbar.signals')}
              {plotState.series.length > 0 ? ` (${plotState.series.length})` : ''}
            </span>
          </button>

          <div className="h-4 w-[1px] bg-[var(--border-strong)] mx-0.5" />

          {/* Combined vs Split Oscilloscope Mode */}
          <div
            data-tour="plotter.layout"
            style={{ borderColor: 'var(--border-strong)' }}
            className="h-[28px] border inline-flex items-center shrink-0 overflow-hidden"
          >
            <button
              type="button"
              onClick={() => plotStore.setLayoutMode('combined')}
              style={{
                backgroundColor:
                  plotState.layoutMode === 'combined'
                    ? 'var(--bg-header)'
                    : 'var(--bg-input)',
                color:
                  plotState.layoutMode === 'combined'
                    ? 'var(--text-primary)'
                    : 'var(--text-muted)',
              }}
              className="h-full px-2.5 flex items-center gap-1 font-medium cursor-pointer"
              title={t('plotter.layout.combinedTitle')}
            >
              <Layers className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
              <span>{t('plotter.layout.combined')}</span>
            </button>

            <button
              type="button"
              onClick={() => plotStore.setLayoutMode('compactSplit')}
              style={{
                backgroundColor:
                  plotState.layoutMode === 'compactSplit'
                    ? 'var(--bg-header)'
                    : 'var(--bg-input)',
                color:
                  plotState.layoutMode === 'compactSplit'
                    ? 'var(--text-primary)'
                    : 'var(--text-muted)',
                borderLeft: '1px solid var(--border-strong)',
              }}
              className="h-full px-2.5 flex items-center gap-1 font-medium cursor-pointer"
              title={t('plotter.layout.compactSplitTitle')}
            >
              <AlignJustify className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
              <span>{t('plotter.layout.compactSplit')}</span>
            </button>

            <button
              type="button"
              onClick={() => plotStore.setLayoutMode('split')}
              style={{
                backgroundColor:
                  plotState.layoutMode === 'split'
                    ? 'var(--bg-header)'
                    : 'var(--bg-input)',
                color:
                  plotState.layoutMode === 'split'
                    ? 'var(--text-primary)'
                    : 'var(--text-muted)',
                borderLeft: '1px solid var(--border-strong)',
              }}
              className="h-full px-2.5 flex items-center gap-1 font-medium cursor-pointer"
              title={t('plotter.layout.splitTitle')}
            >
              <Columns2 className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
              <span>{t('plotter.layout.split')}</span>
            </button>
          </div>

          {plotState.layoutMode === 'combined' ? (
            <select
              aria-label={t('plotter.yScale.ariaLabel')}
              value={plotState.yScaleMode}
              onChange={(e) =>
                plotStore.setYScaleMode(e.target.value as PlotYScaleMode)
              }
              style={{
                backgroundColor: 'var(--bg-input)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              className="h-[28px] px-2 border text-[12px] focus:outline-none"
            >
              <option value="multiAxis">{t('plotter.yScale.multiAxis')}</option>
              <option value="normalized">{t('plotter.yScale.normalized')}</option>
              <option value="shared">{t('plotter.yScale.shared')}</option>
            </select>
          ) : plotState.layoutMode === 'split' ? (
            <div className="flex items-center gap-0.5 font-mono">
              <span className="text-[var(--text-muted)] font-sans mr-0.5 text-[11px]">
                {t('plotter.split.heightPrefix')}
              </span>
              {SPLIT_HEIGHT_OPTIONS.map((opt) => {
                const active = plotState.splitRowHeight === opt.px;
                return (
                  <button
                    key={opt.px}
                    type="button"
                    onClick={() => plotStore.setSplitRowHeight(opt.px)}
                    style={{
                      backgroundColor: active ? 'var(--bg-header)' : 'transparent',
                      borderColor: active
                        ? 'var(--border-strong)'
                        : 'var(--border-grid)',
                      color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}
                    className="h-[28px] px-2 border cursor-pointer text-[11.5px]"
                    title={t('plotter.split.heightTitle', { px: opt.px })}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          ) : (
            <span
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-grid)',
                color: 'var(--text-secondary)',
              }}
              className="h-[28px] px-2.5 border flex items-center text-[11px] font-mono shrink-0"
              title={t('plotter.layout.autoLanesTitle')}
            >
              {t('plotter.layout.autoLanes', { count: visibleSeries.length })}
            </span>
          )}

          <div className="h-4 w-[1px] bg-[var(--border-strong)] mx-0.5" />

          {/* Pointer Drag Tool: Pan vs Box Zoom */}
          <div
            data-tour="plotter.tools"
            style={{ borderColor: 'var(--border-strong)' }}
            className="h-[28px] border inline-flex items-center shrink-0 overflow-hidden"
          >
            <button
              type="button"
              onClick={() => plotStore.setDragTool('pan')}
              style={{
                backgroundColor:
                  plotState.dragTool === 'pan'
                    ? 'var(--bg-header)'
                    : 'var(--bg-input)',
                color:
                  plotState.dragTool === 'pan'
                    ? 'var(--text-primary)'
                    : 'var(--text-muted)',
              }}
              className="h-full px-2.5 flex items-center gap-1 font-medium cursor-pointer"
              title={t('plotter.tool.panTitle')}
            >
              <Hand className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
              <span>{t('plotter.tool.pan')}</span>
            </button>

            <button
              type="button"
              onClick={() => plotStore.setDragTool('boxZoom')}
              style={{
                backgroundColor:
                  plotState.dragTool === 'boxZoom'
                    ? 'var(--bg-header)'
                    : 'var(--bg-input)',
                color:
                  plotState.dragTool === 'boxZoom'
                    ? 'var(--text-primary)'
                    : 'var(--text-muted)',
                borderLeft: '1px solid var(--border-strong)',
              }}
              className="h-full px-2.5 flex items-center gap-1 font-medium cursor-pointer"
              title={t('plotter.tool.boxZoomTitle')}
            >
              <ScanSearch className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
              <span>{t('plotter.tool.boxZoom')}</span>
            </button>
          </div>

          {/* Zoom In / Out / Undo / Reset */}
          <button
            type="button"
            onClick={() =>
              plotStore.zoomTimeAtRatio(0.8, plotState.liveFollow ? 1 : 0.5)
            }
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[28px] px-2 border flex items-center hover:text-[var(--text-primary)] cursor-pointer"
            title={t('plotter.zoom.inTitle')}
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() =>
              plotStore.zoomTimeAtRatio(1.25, plotState.liveFollow ? 1 : 0.5)
            }
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[28px] px-2 border flex items-center hover:text-[var(--text-primary)] cursor-pointer"
            title={t('plotter.zoom.outTitle')}
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            disabled={plotState.zoomHistoryDepth === 0}
            onClick={() => {
              plotStore.popZoomHistory();
            }}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[28px] px-2 border flex items-center gap-1 hover:text-[var(--text-primary)] disabled:opacity-40 cursor-pointer font-mono tabular-nums text-[11px]"
            title={t('plotter.zoom.undoTitle')}
          >
            <Undo2 className="w-3.5 h-3.5" />
            {plotState.zoomHistoryDepth > 0 && (
              <span>{plotState.zoomHistoryDepth}</span>
            )}
          </button>

          <button
            type="button"
            onClick={() => plotStore.resetFullView()}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[28px] px-2.5 border flex items-center gap-1.5 cursor-pointer font-medium"
            title={t('plotter.zoom.resetTitle')}
          >
            <RotateCcw className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
            <span>{t('plotter.zoom.reset')}</span>
          </button>

          <div className="h-4 w-[1px] bg-[var(--border-strong)] mx-0.5" />

          {/* Time Span Presets + Continuous Span Badge */}
          <div data-tour="plotter.timespan" className="flex items-center gap-1 font-mono tabular-nums">
            {TIME_PRESETS_SEC.map((sec) => {
              const active = Math.abs(plotState.viewSpanSec - sec) < 0.005;
              return (
                <button
                  key={sec}
                  type="button"
                  onClick={() => plotStore.setPresetTimeSpan(sec)}
                  style={{
                    backgroundColor: active ? 'var(--bg-header)' : 'transparent',
                    borderColor: active
                      ? 'var(--border-strong)'
                      : 'var(--border-grid)',
                    color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                  }}
                  className={`h-[28px] px-2 border cursor-pointer text-[11.5px] ${
                    active ? 'font-semibold' : 'hover:text-[var(--text-secondary)]'
                  }`}
                >
                  {sec}s
                </button>
              );
            })}
            <span
              style={{
                backgroundColor: 'var(--bg-input)',
                borderColor: 'var(--border-grid)',
                color: 'var(--text-secondary)',
              }}
              className="h-[28px] w-[68px] px-1 border inline-flex items-center justify-center text-[11px] tabular-nums shrink-0 font-mono"
              title={t('plotter.timeSpan.badgeTitle')}
            >
              {formatSpanBadge(plotState.viewSpanSec)}
            </span>
          </div>
        </div>

        {/* Right Controls: Delta Cursors, Follow Live, Auto-Y, Pause, Clear, Shortcuts */}
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
          <button
            type="button"
            data-tour="plotter.cursors"
            onClick={() =>
              plotStore.setDeltaCursorsEnabled(!plotState.deltaCursorsEnabled)
            }
            style={{
              backgroundColor: plotState.deltaCursorsEnabled
                ? 'var(--bg-header)'
                : 'var(--bg-panel)',
              borderColor: plotState.deltaCursorsEnabled
                ? 'var(--text-secondary)'
                : 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[28px] px-2.5 border flex items-center gap-1.5 font-medium cursor-pointer shrink-0 text-[12px]"
            title={t('plotter.cursor.deltaTitle')}
          >
            <GitCommitVertical className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
            <span>{t('plotter.cursor.delta')}</span>
          </button>

          <button
            type="button"
            data-tour="plotter.live"
            onClick={() => plotStore.setLiveFollow(!plotState.liveFollow)}
            style={
              plotState.liveFollow
                ? {
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }
                : {
                    backgroundColor: 'rgba(217, 155, 38, 0.16)',
                    borderColor: 'rgba(217, 155, 38, 0.65)',
                    color: '#E3B341',
                  }
            }
            className="h-[28px] w-[96px] px-2 border flex items-center justify-center gap-1 font-semibold cursor-pointer shrink-0 text-[12px]"
            title={
              plotState.liveFollow
                ? t('plotter.live.followingTitle')
                : t('plotter.live.historyTitle')
            }
          >
            <FastForward
              className={`w-3.5 h-3.5 shrink-0 ${
                plotState.liveFollow ? 'text-emerald-500' : 'text-amber-400'
              }`}
            />
            <span>{plotState.liveFollow ? t('plotter.live.live') : t('plotter.live.follow')}</span>
          </button>

          <button
            type="button"
            onClick={() => plotStore.resetAllAutoScale()}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[28px] px-2.5 border flex items-center gap-1.5 cursor-pointer text-[12px]"
            title={t('plotter.autoY.title')}
          >
            <Maximize2 className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
            <span>{t('plotter.autoY.button')}</span>
          </button>

          <button
            type="button"
            onClick={() => plotStore.setPaused(!plotState.paused)}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[28px] px-2.5 border flex items-center gap-1.5 font-medium cursor-pointer text-[12px]"
            title={t('plotter.playPause.title')}
          >
            {plotState.paused ? (
              <>
                <Play className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                <span>{t('plotter.playPause.resume')}</span>
              </>
            ) : (
              <>
                <Pause className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                <span>{t('plotter.playPause.pause')}</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => plotStore.clearBuffers()}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[28px] px-2.5 border flex items-center gap-1.5 cursor-pointer text-[12px]"
            title={t('plotter.clear.title')}
          >
            <Trash2 className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
            <span>{t('plotter.clear.button')}</span>
          </button>

          <button
            type="button"
            data-tour="plotter.export"
            disabled={!hasAnySamples}
            onClick={handleExportCsv}
            style={{
              backgroundColor: csvFeedback ? 'rgba(16, 185, 129, 0.15)' : 'var(--bg-panel)',
              borderColor: csvFeedback ? 'rgba(16, 185, 129, 0.5)' : 'var(--border-strong)',
              color: csvFeedback ? '#34d399' : 'var(--text-primary)',
            }}
            className="h-[28px] px-2.5 border flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed text-[12px]"
            title={t('plotter.csv.title')}
          >
            <Download className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
            <span>{csvFeedback ?? t('plotter.csv.button')}</span>
          </button>

          {/* Instant Waveform Plot from Trace Session */}
          {activeTraceSession && activeTraceSession.count > 0 && (
            <button
              type="button"
              onClick={handlePlotActiveTrace}
              style={{
                backgroundColor: 'rgba(56, 189, 248, 0.12)',
                borderColor: 'rgba(56, 189, 248, 0.45)',
                color: '#38BDF8',
              }}
              className="h-[28px] px-2.5 border flex items-center gap-1.5 font-semibold hover:bg-sky-500/20 cursor-pointer shrink-0 text-[12px]"
              title={t('plotter.trace.plotSessionTitle', {
                sessionName: activeTraceSession.name,
                count: activeTraceSession.count.toLocaleString(locale === 'tr' ? 'tr-TR' : 'en-US'),
              })}
            >
              <Activity className="w-3.5 h-3.5 text-sky-400" />
              <span>
                {t('plotter.trace.plotSession', {
                  count: activeTraceSession.count.toLocaleString(locale === 'tr' ? 'tr-TR' : 'en-US'),
                })}
              </span>
            </button>
          )}

          {/* Live Replay Indicator & Mini-Controls */}
          {replay && replay.state !== 'idle' && (
            <div
              style={{
                backgroundColor: 'rgba(6, 182, 212, 0.12)',
                borderColor: 'rgba(6, 182, 212, 0.45)',
                color: '#22D3EE',
              }}
              className="h-[28px] px-2.5 border flex items-center gap-1.5 font-mono text-[11px] tabular-nums shrink-0"
            >
              <span className="font-bold">{t('plotter.replay.badge')}</span>
              <span>
                {(replay.elapsedUs / 1_000_000).toFixed(1)}s / {(replay.durationUs / 1_000_000).toFixed(1)}s
              </span>
              <button
                type="button"
                onClick={() => {
                  if (replay.state === 'playing') void apiControlTraceReplay({ action: 'pause' });
                  else if (replay.state === 'paused') void apiControlTraceReplay({ action: 'resume' });
                }}
                className="px-0.5 hover:text-white cursor-pointer"
                title={replay.state === 'playing' ? t('plotter.replay.pauseTitle') : t('plotter.replay.resumeTitle')}
              >
                {replay.state === 'playing' ? (
                  <Pause className="w-3 h-3" />
                ) : (
                  <Play className="w-3 h-3 fill-current" />
                )}
              </button>
              <button
                type="button"
                onClick={() => void apiControlTraceReplay({ action: 'stop' })}
                className="px-0.5 hover:text-red-400 cursor-pointer"
                title={t('plotter.replay.stopTitle')}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          <GuideTourButton pageId="plotter" />
          <GuideInfoButton pageId="plotter" tourAnchor="plotter.info" />
          <button
            type="button"
            onClick={() => setHelpOpen((v) => !v)}
            style={{
              backgroundColor: helpOpen ? 'var(--bg-header)' : 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[28px] w-[28px] border flex items-center justify-center hover:text-[var(--text-primary)] cursor-pointer shrink-0"
            title={t('plotter.help.buttonTitle')}
          >
            <HelpCircle className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Compact Oscilloscope Shortcuts Popover */}
      {helpOpen && (
        <div
          style={{
            backgroundColor: 'var(--bg-header)',
            borderColor: 'var(--border-strong)',
            color: 'var(--text-primary)',
          }}
          className="absolute right-2 top-[32px] z-30 w-[330px] border p-2.5 shadow-xl text-[11px] space-y-1.5"
        >
          <div className="flex items-center justify-between font-semibold border-b border-[var(--border-grid)] pb-1">
            <span>{t('plotter.help.title')}</span>
            <button
              type="button"
              onClick={() => setHelpOpen(false)}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1 font-mono text-[10px] text-[var(--text-secondary)]">
            <span>{t('plotter.help.wheel')}</span>
            <span className="text-[var(--text-primary)]">{t('plotter.help.zoomX')}</span>
            <span>{t('plotter.help.shiftWheel')}</span>
            <span className="text-[var(--text-primary)]">{t('plotter.help.zoomY')}</span>
            <span>{t('plotter.help.ctrlWheel')}</span>
            <span className="text-[var(--text-primary)]">{t('plotter.help.zoomXY')}</span>
            <span>{t('plotter.help.drag')}</span>
            <span className="text-[var(--text-primary)]">{t('plotter.help.panXY')}</span>
            <span>{t('plotter.help.rightDrag')}</span>
            <span className="text-[var(--text-primary)]">{t('plotter.help.boxZoom')}</span>
            <span>{t('plotter.help.axisDrag')}</span>
            <span className="text-[var(--text-primary)]">{t('plotter.help.panAxis')}</span>
            <span>{t('plotter.help.doubleClick')}</span>
            <span className="text-[var(--text-primary)]">{t('plotter.help.resetFit')}</span>
            <span>{t('plotter.help.keys')}</span>
            <span className="text-[var(--text-primary)]">{t('plotter.help.keyActions')}</span>
          </div>
          <div className="pt-1 border-t border-[var(--border-grid)] text-[10px] font-mono text-[var(--text-muted)]">
            {t('plotter.help.ringBuffer')}
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* 2. BODY: SIGNAL PICKER SIDEBAR (LEFT) + 60 FPS SCOPES (RIGHT)        */}
      {/* ==================================================================== */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Collapsible Signal Picker Tree with Message-Level Select-All Checkboxes */}
        {pickerOpen && (
          <aside
            data-tour="plotter.picker"
            style={{ borderRight: '1px solid var(--border-strong)' }}
            className="w-[270px] lg:w-[300px] xl:w-[330px] shrink-0 flex flex-col min-h-0 overflow-hidden"
          >
            <div
              style={{
                backgroundColor: 'var(--bg-row-alt)',
                borderBottom: '1px solid var(--border-grid)',
              }}
              className="p-2 space-y-2 text-[12px]"
            >
              <div className="flex items-center gap-1.5">
                <select
                  aria-label={t('plotter.picker.busAriaLabel')}
                  value={pickerBusId}
                  onChange={(e) => plotStore.setPickerBusId(Number(e.target.value), true)}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="h-[28px] px-2 border font-mono text-[12px]"
                >
                  {pickerBusOptions.map((opt) => (
                    <option key={opt.busId} value={opt.busId}>
                      {opt.label}
                    </option>
                  ))}
                </select>

                <div className="relative flex-1 flex items-center">
                  <input
                    type="text"
                    value={pickerFilter}
                    onChange={(e) => plotStore.setPickerFilter(e.target.value)}
                    placeholder={t('plotter.picker.searchPlaceholder')}
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="w-full h-[28px] px-2 pr-6 border text-[12px] focus:outline-none"
                  />
                  {pickerFilter && (
                    <button
                      type="button"
                      onClick={() => plotStore.setPickerFilter('')}
                      className="absolute right-1.5 text-[var(--text-muted)] cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {plotState.series.length > 0 && (
                <div className="flex items-center justify-between pt-0.5 px-0.5 text-[11px]">
                  <span className="font-mono tabular-nums text-emerald-400 font-medium">
                    {t('plotter.picker.signalsSelected', { count: plotState.series.length })}
                  </span>
                  <button
                    type="button"
                    onClick={() => plotStore.clearAllSeries()}
                    style={{
                      backgroundColor: 'rgba(239, 68, 68, 0.1)',
                      borderColor: 'rgba(239, 68, 68, 0.3)',
                      color: '#f87171',
                    }}
                    className="h-[22px] px-2 border hover:bg-red-500/20 hover:text-red-300 flex items-center gap-1 font-sans text-[11px] cursor-pointer"
                    title={t('plotter.picker.clearAllTitle')}
                  >
                    <X className="w-3 h-3" />
                    <span>{t('plotter.picker.clearAll')}</span>
                  </button>
                </div>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto text-[12px]">
              {!signalTreeBundle.hasAnySchema ? (
                <div className="p-4 text-center text-[var(--text-muted)] flex flex-col gap-2 items-center">
                  <div>
                    {pickerBusId >= 0
                      ? t('plotter.picker.noDbOnBus', { bus: pickerBusId + 1 })
                      : t('plotter.picker.noDbInProject')}
                  </div>
                  {pickerBusId >= 0 && dbState.databases.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        const firstDb = dbState.databases[0];
                        if (firstDb) {
                          void handleBindDbcToBus(pickerBusId, firstDb);
                        }
                      }}
                      style={{
                        backgroundColor: 'var(--bg-toolbar)',
                        borderColor: 'var(--border-strong)',
                        color: 'var(--text-primary)',
                      }}
                      className="h-[28px] px-3 border hover:border-sky-500 text-[12px] cursor-pointer"
                    >
                      {t('plotter.picker.bindDbToBus', {
                        dbName: dbState.databases[0].name,
                        bus: pickerBusId + 1,
                      })}
                    </button>
                  )}
                  {pickerBusId >= 0 && (
                    <button
                      type="button"
                      onClick={() => plotStore.setPickerBusId(-1, true)}
                      style={{
                        backgroundColor: 'var(--bg-panel)',
                        borderColor: 'var(--border-strong)',
                        color: 'var(--text-secondary)',
                      }}
                      className="h-[28px] px-3 border hover:border-amber-400 text-[12px] cursor-pointer"
                    >
                      {t('plotter.picker.switchToCatalog')}
                    </button>
                  )}
                </div>
              ) : (
                filteredTreeItems.map((item) => {
                  const isExp = expandedMsgs.has(item.uniqueKey) || q.length > 0;
                  const allMsgSignals = item.signals;
                  let plottedInMsg = 0;
                  for (let i = 0; i < allMsgSignals.length; i++) {
                    const s = allMsgSignals[i];
                    if (
                      plotState.plottedKeys.has(
                        makePlotSeriesKey(item.effectiveBusId, s.signalId),
                      )
                    ) {
                      plottedInMsg += 1;
                    }
                  }
                  const allPlotted =
                    allMsgSignals.length > 0 && plottedInMsg === allMsgSignals.length;
                  const somePlotted = plottedInMsg > 0 && !allPlotted;

                  return (
                    <div
                      key={item.uniqueKey}
                      style={{ borderBottom: '1px solid var(--border-grid)' }}
                    >
                      <div
                        onClick={() =>
                          setExpandedMsgs((prev) => {
                            const next = new Set(prev);
                            if (next.has(item.uniqueKey)) next.delete(item.uniqueKey);
                            else next.add(item.uniqueKey);
                            return next;
                          })
                        }
                        className="h-[30px] px-2.5 flex items-center justify-between gap-1 hover:bg-[var(--bg-row-hover)] cursor-pointer font-medium text-[12px]"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <input
                            type="checkbox"
                            checked={allPlotted}
                            disabled={allMsgSignals.length === 0}
                            ref={(el) => {
                              if (el) {
                                el.indeterminate = somePlotted;
                              }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() =>
                              plotStore.setSignalsPlottedBatch(
                                item.effectiveBusId,
                                allMsgSignals,
                                !allPlotted,
                              )
                            }
                            title={
                              allPlotted
                                ? t('plotter.picker.unplotAllMsg', {
                                    count: allMsgSignals.length,
                                    name: item.name,
                                  })
                                : t('plotter.picker.plotAllMsg', {
                                    count: allMsgSignals.length,
                                    name: item.name,
                                  })
                            }
                            className="accent-emerald-600 cursor-pointer shrink-0"
                          />
                          {isExp ? (
                            <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                          )}
                          <span className="font-mono text-[var(--text-secondary)] shrink-0">
                            {formatPcanIdHex(item.arbId, item.isExtended)}h
                          </span>
                          <span className="truncate" title={item.name}>
                            {item.name}
                          </span>
                          {pickerBusId === -1 && item.dbName && (
                            <span className="px-1 text-[10px] font-sans rounded-xs bg-[var(--bg-panel)] border border-[var(--border-grid)] text-[var(--text-muted)] shrink-0">
                              {item.dbName}
                            </span>
                          )}
                        </div>

                        {plottedInMsg > 0 && (
                          <span className="font-mono tabular-nums text-[11px] text-emerald-500 shrink-0">
                            {plottedInMsg}/{allMsgSignals.length}
                          </span>
                        )}
                      </div>

                      {isExp && (
                        <div style={{ backgroundColor: 'var(--bg-row-signal)' }}>
                          {allMsgSignals.map((sig) => {
                            if (
                              q.length > 0 &&
                              !sig.name.toLowerCase().includes(q) &&
                              !item.name.toLowerCase().includes(q)
                            ) {
                              return null;
                            }
                            const seriesKey = makePlotSeriesKey(
                              item.effectiveBusId,
                              sig.signalId,
                            );
                            const isChecked = plotState.plottedKeys.has(seriesKey);
                            const activeEntry = plotState.series.find(
                              (s) => s.key === seriesKey,
                            );

                            return (
                              <label
                                key={sig.signalId}
                                className="h-[28px] pl-7 pr-2.5 flex items-center justify-between gap-1 hover:bg-[var(--bg-row-hover)] cursor-pointer text-[12px]"
                              >
                                <span className="flex items-center gap-1.5 min-w-0">
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={() =>
                                      plotStore.toggleSignal(item.effectiveBusId, sig)
                                    }
                                    className="accent-emerald-600 cursor-pointer shrink-0"
                                  />
                                  {activeEntry && (
                                    <span
                                      className="w-2.5 h-2.5 rounded-full shrink-0"
                                      style={{ backgroundColor: activeEntry.colorHex }}
                                    />
                                  )}
                                  <span className="truncate" title={sig.name}>
                                    {sig.name}
                                  </span>
                                </span>
                                {activeEntry && activeEntry.latestValue !== null ? (
                                  <span className="font-mono tabular-nums text-[11px] text-emerald-400 font-semibold shrink-0">
                                    {formatAxisNum(activeEntry.latestValue)}
                                    {sig.unit ? ` ${sig.unit}` : ''}
                                  </span>
                                ) : (
                                  sig.unit && (
                                    <span className="font-mono text-[11px] text-[var(--text-muted)] shrink-0">
                                      {sig.unit}
                                    </span>
                                  )
                                )}
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </aside>
        )}

        {/* RIGHT: Delta Cursor Bar + 60 FPS Scopes + 40px Minimap */}
        <div data-tour="plotter.canvas" className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
          {/* Dual Measurement Cursors A & B Readout Bar (Locked 28px height) */}
          {plotState.deltaCursorsEnabled &&
            plotState.series.length > 0 &&
            cursorA !== null &&
            cursorB !== null &&
            deltaT !== null && (
              <div
                style={{
                  backgroundColor: 'var(--bg-toolbar)',
                  borderBottom: '1px solid var(--border-strong)',
                }}
                className="shrink-0 h-[28px] min-h-[28px] max-h-[28px] px-2.5 flex items-center justify-between gap-2 overflow-x-auto overflow-y-hidden whitespace-nowrap text-[12px] font-mono tabular-nums"
              >
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-amber-400 font-semibold">
                    A: {cursorA.toFixed(3)}s
                  </span>
                  <span className="text-rose-400 font-semibold">
                    B: {cursorB.toFixed(3)}s
                  </span>
                  <span className="font-semibold text-[var(--text-primary)]">
                    Δt: {formatDeltaTime(deltaT)}
                  </span>
                  <span className="text-[var(--text-secondary)]">
                    {Math.abs(deltaT) > 1e-6
                      ? `${(1 / Math.abs(deltaT)).toFixed(2)} Hz`
                      : '∞ Hz'}
                  </span>

                  {visibleSeries.slice(0, 5).map((entry) => {
                    const vA = findValueAtTime(entry, cursorA);
                    const vB = findValueAtTime(entry, cursorB);
                    if (vA === null || vB === null) return null;
                    const dY = vB - vA;
                    const sign = dY >= 0 ? '+' : '';
                    return (
                      <span key={entry.key} className="text-[11px] shrink-0">
                        <strong style={{ color: entry.colorHex }}>
                          Δ{entry.signalName}:
                        </strong>{' '}
                        {sign}
                        {formatAxisNum(dY)}
                        {entry.unit ? ` ${entry.unit}` : ''}
                      </span>
                    );
                  })}
                </div>

                <button
                  type="button"
                  onClick={() => plotStore.placeDeltaCursorsInCurrentWindow()}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-grid)',
                  }}
                  className="h-[22px] px-2 border text-[11px] font-sans text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)] shrink-0"
                  title={t('plotter.cursor.centerTitle')}
                >
                  {t('plotter.cursor.center')}
                </button>
              </div>
            )}

          {/* Oscilloscope Canvas Workspace */}
          {plotState.series.length === 0 ? (
            <div
              onContextMenu={(event) => openContextMenu(event, [{
                label: t('plotter.empty.loadSamples'),
                run: handleAddQuickDemoSignals,
                disabled: !signalTreeBundle.hasAnySchema,
              }])}
              className="flex-1 flex flex-col items-center justify-center p-6 text-center gap-2"
            >
              <Activity className="w-8 h-8 text-[var(--text-muted)]" />
              <div className="text-[13px] font-semibold text-[var(--text-primary)]">
                {t('plotter.empty.title')}
              </div>
              <div className="text-[12px] text-[var(--text-muted)]">
                {t('plotter.empty.subtitle')}
              </div>
              <div className="flex items-center gap-2 mt-1">
                {signalTreeBundle.hasAnySchema && (
                  <button
                    type="button"
                    onClick={handleAddQuickDemoSignals}
                    style={{
                      backgroundColor: 'var(--bg-toolbar)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="h-[28px] px-3.5 border hover:border-[var(--text-secondary)] flex items-center gap-1.5 text-[12px] font-medium cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                    <span>{t('plotter.empty.loadSamples')}</span>
                  </button>
                )}
                {activeTraceSession && activeTraceSession.count > 0 && (
                  <button
                    type="button"
                    onClick={handlePlotActiveTrace}
                    style={{
                      backgroundColor: 'rgba(56, 189, 248, 0.15)',
                      borderColor: '#38BDF8',
                      color: '#7DD3FC',
                    }}
                    className="h-[28px] px-3.5 border hover:bg-sky-500/25 flex items-center gap-1.5 text-[12px] font-semibold cursor-pointer"
                  >
                    <Activity className="w-3.5 h-3.5 text-sky-400" />
                    <span>
                      {t('plotter.empty.plotFromTrace', {
                        name: activeTraceSession.name,
                        count: activeTraceSession.count.toLocaleString(
                          locale === 'tr' ? 'tr-TR' : 'en-US',
                        ),
                      })}
                    </span>
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              {plotState.layoutMode === 'combined' ? (
                <div className="flex-1 min-h-0 p-2 pb-1 flex flex-col">
                  <ScopeCanvas
                    scopeMode="combined"
                    entries={visibleSeries}
                    yScaleMode={plotState.yScaleMode}
                    dragTool={plotState.dragTool}
                    deltaCursorsEnabled={plotState.deltaCursorsEnabled}
                    theme={dbState.theme}
                    sharedCursorRatioRef={sharedCursorRatioRef}
                    spaceHeldRef={spaceHeldRef}
                    spaceUsedForDragRef={spaceUsedForDragRef}
                    title=""
                  />
                </div>
              ) : plotState.layoutMode === 'compactSplit' ? (
                <div className="flex-1 min-h-0 p-2 pb-1 flex flex-col">
                  <CompactStackedScopeCanvas
                    entries={visibleSeries}
                    dragTool={plotState.dragTool}
                    deltaCursorsEnabled={plotState.deltaCursorsEnabled}
                    theme={dbState.theme}
                    sharedCursorRatioRef={sharedCursorRatioRef}
                    spaceHeldRef={spaceHeldRef}
                    spaceUsedForDragRef={spaceUsedForDragRef}
                  />
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-y-auto p-2 pb-1 space-y-2">
                  {visibleSeries.map((entry) => (
                    <div
                      key={entry.key}
                      style={{ height: `${plotState.splitRowHeight}px` }}
                      className="shrink-0"
                    >
                      <ScopeCanvas
                        scopeMode="split"
                        entries={[entry]}
                        yScaleMode="shared"
                        dragTool={plotState.dragTool}
                        deltaCursorsEnabled={plotState.deltaCursorsEnabled}
                        theme={dbState.theme}
                        sharedCursorRatioRef={sharedCursorRatioRef}
                        spaceHeldRef={spaceHeldRef}
                        spaceUsedForDragRef={spaceUsedForDragRef}
                        title={`${
                          entry.busId > 0 ? `B${entry.busId + 1}: ` : ''
                        }${entry.signalName}${
                          entry.unit ? ` [${entry.unit}]` : ''
                        }`}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* 40px Interactive Timeline Overview Minimap & Range Scrollbar */}
              <div className="shrink-0 px-2 pb-1.5">
                <TimelineMinimap
                  entries={visibleSeries}
                  theme={dbState.theme}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Multi-Y Axis Strip Layout & Hit-Testing Geometry
// ============================================================================

interface AxisStripDescriptor {
  side: 'left' | 'right';
  x0: number;
  x1: number;
  lineX: number;
  targetKey: 'combined' | string;
  entry: PlotSeriesEntry | null;
  colorHex: string;
  headerTag: string;
  isAuto: boolean;
}

interface ScopeLayoutGeometry {
  plotLeft: number;
  plotRight: number;
  plotW: number;
  plotH: number;
  strips: readonly AxisStripDescriptor[];
}

const PAD_TOP = 24;
const PAD_BOTTOM = 22;

function computeScopeGeometry(
  w: number,
  h: number,
  scopeMode: 'combined' | 'split',
  yScaleMode: PlotYScaleMode,
  entries: readonly PlotSeriesEntry[],
  isDark: boolean,
): ScopeLayoutGeometry {
  const plotH = Math.max(24, h - PAD_TOP - PAD_BOTTOM);
  const neutralColor = isDark ? '#94A3B8' : '#475569';
  const vp = plotStore.getViewport();

  if (scopeMode === 'combined' && yScaleMode === 'multiAxis' && entries.length > 0) {
    const leftEntries = entries.slice(0, 4);
    const rightEntries = entries.slice(4, 8);
    const totalStrips = leftEntries.length + rightEntries.length;

    const idealStripW = entries.length === 1 ? 62 : entries.length <= 3 ? 56 : 50;
    const maxTotalGutter = Math.max(76, Math.floor(w * 0.5));
    const stripW = Math.max(
      42,
      Math.min(idealStripW, Math.floor(maxTotalGutter / Math.max(1, totalStrips))),
    );

    const plotLeft = leftEntries.length * stripW;
    const rightGutter = rightEntries.length > 0 ? rightEntries.length * stripW : 14;
    const plotRight = Math.max(plotLeft + 40, w - rightGutter);
    const plotW = plotRight - plotLeft;

    const strips: AxisStripDescriptor[] = [];
    for (let i = 0; i < leftEntries.length; i++) {
      const e = leftEntries[i];
      const x0 = i * stripW;
      const x1 = (i + 1) * stripW;
      const shortSig =
        e.signalName.length > 6 ? `${e.signalName.slice(0, 6)}..` : e.signalName;
      strips.push({
        side: 'left',
        x0,
        x1,
        lineX: x1 - 0.5,
        targetKey: e.key,
        entry: e,
        colorHex: e.colorHex,
        headerTag: e.unit ? `[${e.unit}]` : shortSig,
        isAuto: e.autoScale,
      });
    }

    for (let j = 0; j < rightEntries.length; j++) {
      const e = rightEntries[j];
      const x0 = plotRight + j * stripW;
      const x1 = plotRight + (j + 1) * stripW;
      const shortSig =
        e.signalName.length > 6 ? `${e.signalName.slice(0, 6)}..` : e.signalName;
      strips.push({
        side: 'right',
        x0,
        x1,
        lineX: x0 + 0.5,
        targetKey: e.key,
        entry: e,
        colorHex: e.colorHex,
        headerTag: e.unit ? `[${e.unit}]` : shortSig,
        isAuto: e.autoScale,
      });
    }

    return { plotLeft, plotRight, plotW, plotH, strips };
  }

  // Single left axis strip (Split scope OR Combined Normalized / Shared)
  const plotLeft = 64;
  const plotRight = Math.max(plotLeft + 40, w - 14);
  const plotW = plotRight - plotLeft;
  const singleEntry = scopeMode === 'split' && entries.length === 1 ? entries[0] : null;

  const strip: AxisStripDescriptor = singleEntry
    ? {
        side: 'left',
        x0: 0,
        x1: plotLeft,
        lineX: plotLeft + 0.5,
        targetKey: singleEntry.key,
        entry: singleEntry,
        colorHex: singleEntry.colorHex,
        headerTag: singleEntry.unit ? `[${singleEntry.unit}]` : 'Y',
        isAuto: singleEntry.autoScale,
      }
    : {
        side: 'left',
        x0: 0,
        x1: plotLeft,
        lineX: plotLeft + 0.5,
        targetKey: 'combined',
        entry: null,
        colorHex: neutralColor,
        headerTag: yScaleMode === 'normalized' ? '[% Span]' : '[Shared]',
        isAuto: vp.combinedYAuto,
      };

  return { plotLeft, plotRight, plotW, plotH, strips: [strip] };
}

function findHitAxisStrip(
  x: number,
  y: number,
  geom: ScopeLayoutGeometry,
): AxisStripDescriptor | null {
  if (y < PAD_TOP || y > PAD_TOP + geom.plotH) return null;
  for (let i = 0; i < geom.strips.length; i++) {
    const st = geom.strips[i];
    if (x >= st.x0 && x <= st.x1) {
      return st;
    }
  }
  return null;
}

// ============================================================================
// 60 FPS Zero-Allocation HTML5 Canvas Oscilloscope Surface
// ============================================================================

type ActivePointerDrag =
  | {
      kind: 'pan';
      startX: number;
      startY: number;
      initialRightSec: number;
      initialSpanSec: number;
      panYTarget: 'combined' | 'multiAll' | string | null;
      initialYMin: number;
      initialYMax: number;
      initialMultiY: Record<string, SeriesBounds>;
    }
  | {
      kind: 'axisPanY';
      targetKey: 'combined' | string;
      startY: number;
      initialYMin: number;
      initialYMax: number;
    }
  | {
      kind: 'axisPanX';
      startX: number;
      initialRightSec: number;
      initialSpanSec: number;
    }
  | {
      kind: 'boxZoom';
      startX: number;
      startY: number;
      curX: number;
      curY: number;
    }
  | {
      kind: 'cursor';
      which: 'A' | 'B';
    };

// ============================================================================
// Compact Split Multi-Lane Stacked Oscilloscope
// Single unified 60 FPS HTML5 Canvas with stacked zero-gap lanes, common bottom
// time X-axis, compact left Y-strip per lane, and global crosshairs & cursors.
// ============================================================================

interface CompactStackedScopeCanvasProps {
  entries: readonly PlotSeriesEntry[];
  dragTool: 'pan' | 'boxZoom';
  deltaCursorsEnabled: boolean;
  theme: 'dark' | 'light';
  sharedCursorRatioRef: React.MutableRefObject<number | null>;
  spaceHeldRef: React.MutableRefObject<boolean>;
  spaceUsedForDragRef: React.MutableRefObject<boolean>;
}

function usePlotContextMenu() {
  const { t } = useI18n();
  const gesture = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const items = () => [
    { label: t('plotter.zoom.reset'), run: () => plotStore.resetFullView() },
    { label: t('context.followLive'), run: () => plotStore.setLiveFollow(true) },
  ];

  return {
    onContextMenu(event: React.MouseEvent<HTMLCanvasElement>) {
      if (event.button === 2) event.preventDefault();
      else openContextMenu(event, items());
    },
    start(event: React.PointerEvent<HTMLCanvasElement>): boolean {
      if (event.button !== 2) return true;
      if (nativeContextMenuPending()) return false;
      gesture.current = { x: event.clientX, y: event.clientY, moved: false };
      return true;
    },
    move(event: React.PointerEvent<HTMLCanvasElement>) {
      const start = gesture.current;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 6) {
        start.moved = true;
      }
    },
    finish(event: React.PointerEvent<HTMLCanvasElement>) {
      const start = gesture.current;
      gesture.current = null;
      if (event.type === 'pointerup' && event.button === 2 && start && !start.moved
        && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) {
        showContextMenu({
          x: event.clientX,
          y: event.clientY,
          anchor: event.currentTarget,
          items: items(),
        });
      }
    },
  };
}

const CompactStackedScopeCanvas: React.FC<CompactStackedScopeCanvasProps> = ({
  entries,
  dragTool,
  deltaCursorsEnabled,
  theme,
  sharedCursorRatioRef,
  spaceHeldRef,
  spaceUsedForDragRef,
}) => {
  const contextMenu = usePlotContextMenu();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef<{ w: number; h: number }>({ w: 800, h: 400 });
  const localHoverRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<ActivePointerDrag | null>(null);
  const [cursorCss, setCursorCss] = useState<string>('crosshair');

  const propsRef = useRef({
    entries,
    dragTool,
    deltaCursorsEnabled,
    theme,
  });
  propsRef.current = {
    entries,
    dragTool,
    deltaCursorsEnabled,
    theme,
  };

  const PAD_TOP = 4;
  const PAD_BOTTOM = 22;
  const PLOT_LEFT = 150;
  const PAD_RIGHT = 8;

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const updateSize = (): void => {
      sizeRef.current = {
        w: Math.max(200, el.clientWidth),
        h: Math.max(120, el.clientHeight),
      };
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Non-passive wheel handler: Wheel over left strip zooms that lane's Y; Wheel over plot zooms time X
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (ev: WheelEvent): void => {
      ev.preventDefault();
      ev.stopPropagation();

      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const curEntries = propsRef.current.entries;
      if (curEntries.length === 0) return;

      const { w, h } = sizeRef.current;
      const totalH = Math.max(20, h - PAD_TOP - PAD_BOTTOM);
      const laneH = totalH / curEntries.length;
      const plotW = Math.max(20, w - PLOT_LEFT - PAD_RIGHT);

      // Horizontal touchpad swipe -> smooth time pan
      if (
        !ev.ctrlKey &&
        !ev.altKey &&
        !ev.shiftKey &&
        Math.abs(ev.deltaX) > Math.abs(ev.deltaY) &&
        Math.abs(ev.deltaX) > 1
      ) {
        const { span } = plotStore.getEffectiveTimeWindow();
        const dt = (ev.deltaX / plotW) * span;
        plotStore.panTimeBy(dt, true);
        return;
      }

      if (ev.deltaY === 0) return;
      const zoomFactor = ev.deltaY < 0 ? 0.8 : 1.25;

      const laneIdx = Math.max(
        0,
        Math.min(curEntries.length - 1, Math.floor((y - PAD_TOP) / laneH)),
      );
      const targetEntry = curEntries[laneIdx];

      // 1. Wheel over Left Strip -> zoom that specific lane's Y scale!
      if (x < PLOT_LEFT) {
        if (!targetEntry) return;
        const bounds = resolveSeriesYBounds(targetEntry);
        const spanY = Math.max(1e-6, bounds.yMax - bounds.yMin);
        const laneY0 = PAD_TOP + laneIdx * laneH;
        const yRatio = Math.max(0, Math.min(1, 1 - (y - laneY0) / laneH));
        const anchorVal = bounds.yMin + yRatio * spanY;
        const nextSpanY = Math.max(1e-6, Math.min(1e9, spanY * zoomFactor));
        const nextMin = anchorVal - yRatio * nextSpanY;
        plotStore.setScopeManualY(targetEntry.key, nextMin, nextMin + nextSpanY, {
          saveHistory: true,
          fromWheel: true,
          emit: true,
        });
        return;
      }

      // 2. Wheel over Plot Area -> Zoom common time X (or Shift+wheel zooms lane Y)
      const doYZoom = ev.shiftKey || ev.ctrlKey || ev.altKey;
      const doXZoom = !ev.shiftKey || ev.ctrlKey || ev.altKey;

      if (doXZoom) {
        const xRatio = Math.max(0, Math.min(1, (x - PLOT_LEFT) / plotW));
        plotStore.zoomTimeAtRatio(zoomFactor, xRatio, true);
      }

      if (doYZoom && targetEntry) {
        const bounds = resolveSeriesYBounds(targetEntry);
        const spanY = Math.max(1e-6, bounds.yMax - bounds.yMin);
        const laneY0 = PAD_TOP + laneIdx * laneH;
        const yRatio = Math.max(0, Math.min(1, 1 - (y - laneY0) / laneH));
        const anchorVal = bounds.yMin + yRatio * spanY;
        const nextSpanY = Math.max(1e-6, Math.min(1e9, spanY * zoomFactor));
        const nextMin = anchorVal - yRatio * nextSpanY;
        plotStore.setScopeManualY(targetEntry.key, nextMin, nextMin + nextSpanY, {
          saveHistory: !doXZoom,
          fromWheel: true,
          emit: true,
        });
      }
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  // 60 FPS Render Loop for Compact Split
  useEffect(() => {
    let rafId = 0;
    let active = true;

    const renderFrame = (): void => {
      if (!active) return;
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const { w, h } = sizeRef.current;
          const dpr = window.devicePixelRatio || 1;
          const targetPxW = Math.floor(w * dpr);
          const targetPxH = Math.floor(h * dpr);
          if (canvas.width !== targetPxW || canvas.height !== targetPxH) {
            canvas.width = targetPxW;
            canvas.height = targetPxH;
          }
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

          const isDark = theme === 'dark';
          const bgColor = isDark ? '#14171B' : '#FAFAFB';
          const gridColor = isDark ? '#22262C' : '#E2E6ED';
          const borderColor = isDark ? '#313741' : '#B8C0CC';
          const textMuted = isDark ? '#8B949E' : '#57606A';
          const textPrimary = isDark ? '#D8DEE6' : '#1F2328';

          ctx.fillStyle = bgColor;
          ctx.fillRect(0, 0, w, h);

          const curEntries = entries;
          const N = Math.max(1, curEntries.length);
          const totalPlotH = Math.max(20, h - PAD_TOP - PAD_BOTTOM);
          const laneH = totalPlotH / N;
          const plotW = Math.max(20, w - PLOT_LEFT - PAD_RIGHT);
          const plotRight = PLOT_LEFT + plotW;

          const vp = plotStore.getViewport();
          const { tStart, tEnd, span: timeSpan } = plotStore.getEffectiveTimeWindow();

          const localHover = localHoverRef.current;
          const cursorRatio = sharedCursorRatioRef.current;
          const tCursor =
            cursorRatio !== null ? tStart + cursorRatio * timeSpan : null;

          // 1. Draw Common Bottom Time Axis Grid & Numbers
          ctx.strokeStyle = gridColor;
          ctx.lineWidth = 1;

          const timeGridStep = computeNiceStep(timeSpan / 6);
          const firstGridT = Math.ceil(tStart / timeGridStep) * timeGridStep;
          ctx.font = '10px Consolas, "JetBrains Mono", monospace';
          ctx.fillStyle = textMuted;
          ctx.textBaseline = 'top';
          ctx.textAlign = 'center';

          let gridSafeGuard = 0;
          for (
            let tGrid = firstGridT;
            tGrid <= tEnd + timeGridStep * 1e-6 && gridSafeGuard < 24;
            tGrid += timeGridStep, gridSafeGuard += 1
          ) {
            const cleanT = Math.abs(tGrid) < timeGridStep * 1e-9 ? 0 : tGrid;
            const frac = (cleanT - tStart) / timeSpan;
            if (frac < -1e-4 || frac > 1.0001) continue;
            const x = Math.round(PLOT_LEFT + frac * plotW) + 0.5;
            ctx.beginPath();
            ctx.moveTo(x, PAD_TOP);
            ctx.lineTo(x, PAD_TOP + totalPlotH);
            ctx.stroke();

            if (x >= PLOT_LEFT + 20 && x <= plotRight - 20) {
              ctx.fillText(formatTimeTick(cleanT, timeSpan), x, PAD_TOP + totalPlotH + 5);
            }
          }

          // 2. Render each lane
          for (let i = 0; i < curEntries.length; i++) {
            const entry = curEntries[i];
            const laneY0 = PAD_TOP + i * laneH;
            const laneY1 = laneY0 + laneH;
            const bounds = resolveSeriesYBounds(entry);
            const yLo = bounds.yMin;
            const yHi = bounds.yMax > yLo ? bounds.yMax : yLo + 1;
            const ySpan = Math.max(1e-9, yHi - yLo);

            // Lane Divider
            ctx.strokeStyle = borderColor;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, Math.round(laneY1) + 0.5);
            ctx.lineTo(plotRight, Math.round(laneY1) + 0.5);
            ctx.stroke();

            // Lane Dotted Midline
            ctx.strokeStyle = gridColor;
            ctx.setLineDash([2, 4]);
            ctx.beginPath();
            ctx.moveTo(PLOT_LEFT, Math.round(laneY0 + laneH * 0.5) + 0.5);
            ctx.lineTo(plotRight, Math.round(laneY0 + laneH * 0.5) + 0.5);
            ctx.stroke();
            ctx.setLineDash([]);

            // Left Legend Strip
            // Color bar
            ctx.fillStyle = entry.colorHex;
            ctx.fillRect(2, laneY0 + 2, 3.5, Math.max(2, laneH - 4));

            // Hover highlight on left strip
            if (
              localHover &&
              localHover.x < PLOT_LEFT &&
              localHover.y >= laneY0 &&
              localHover.y <= laneY1
            ) {
              ctx.fillStyle = entry.colorHex;
              ctx.globalAlpha = isDark ? 0.12 : 0.08;
              ctx.fillRect(0, laneY0, PLOT_LEFT, laneH);
              ctx.globalAlpha = 1;
            }

            // Signal Name & Bus
            ctx.font = 'bold 10px Consolas, "JetBrains Mono", monospace';
            ctx.fillStyle = textPrimary;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            const nameStr = `${entry.busId > 0 ? `B${entry.busId + 1} ` : ''}${entry.signalName}`;
            ctx.fillText(nameStr, 8, laneY0 + 4, 80);

            // Unit below name if room
            if (entry.unit && laneH >= 36) {
              ctx.font = '9px Consolas, "JetBrains Mono", monospace';
              ctx.fillStyle = textMuted;
              ctx.fillText(`[${entry.unit}]`, 8, laneY0 + 17, 80);
            }

            // Value at cursor or latest
            let displayVal: number | null = entry.latestValue;
            if (tCursor !== null && entry.count > 0) {
              // Binary search nearest sample
              const startPos =
                (entry.writePos - entry.count + PLOT_RING_CAPACITY) % PLOT_RING_CAPACITY;
              let lo = 0;
              let hi = entry.count - 1;
              while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                const rIdx = (startPos + mid) % PLOT_RING_CAPACITY;
                const t = entry.timestamps[rIdx];
                if (t < tCursor) lo = mid + 1;
                else hi = mid - 1;
              }
              const bestIdx = Math.max(0, Math.min(entry.count - 1, lo));
              const rBest = (startPos + bestIdx) % PLOT_RING_CAPACITY;
              displayVal = entry.values[rBest];
            }

            if (displayVal !== null && Number.isFinite(displayVal)) {
              ctx.font = 'bold 10.5px Consolas, "JetBrains Mono", monospace';
              ctx.fillStyle = entry.colorHex;
              ctx.textAlign = 'right';
              ctx.textBaseline = 'middle';
              ctx.fillText(
                formatAxisNum(displayVal, ySpan),
                PLOT_LEFT - 36,
                laneY0 + laneH * 0.5,
              );
            }

            // Y Bounds (Min / Max indicators on far right of left strip)
            ctx.font = '8.5px Consolas, "JetBrains Mono", monospace';
            ctx.fillStyle = textMuted;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'top';
            ctx.fillText(formatAxisNum(yHi, ySpan), PLOT_LEFT - 3, laneY0 + 2);
            ctx.textBaseline = 'bottom';
            ctx.fillText(formatAxisNum(yLo, ySpan), PLOT_LEFT - 3, laneY1 - 2);

            // Manual scale badge if disabled
            if (!entry.autoScale) {
              ctx.fillStyle = '#D97706';
              ctx.fillRect(PLOT_LEFT - 26, laneY0 + 2, 8, 8);
              ctx.font = 'bold 7px sans-serif';
              ctx.fillStyle = '#FFFFFF';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText('M', PLOT_LEFT - 22, laneY0 + 6);
            }

            // 3. Draw Waveform for this lane (Clipped to lane rectangle)
            if (entry.count > 0) {
              ctx.save();
              ctx.beginPath();
              ctx.rect(PLOT_LEFT, laneY0, plotW, laneH);
              ctx.clip();

              const startPos =
                (entry.writePos - entry.count + PLOT_RING_CAPACITY) % PLOT_RING_CAPACITY;

              let firstIdx = 0;
              let lo = 0;
              let hi = entry.count - 1;
              while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                const rIdx = (startPos + mid) % PLOT_RING_CAPACITY;
                const t = entry.timestamps[rIdx];
                if (t < tStart) {
                  firstIdx = mid;
                  lo = mid + 1;
                } else {
                  hi = mid - 1;
                }
              }

              let endIdx = entry.count - 1;
              lo = firstIdx;
              hi = entry.count - 1;
              while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                const rIdx = (startPos + mid) % PLOT_RING_CAPACITY;
                const t = entry.timestamps[rIdx];
                if (t > tEnd) {
                  endIdx = mid;
                  hi = mid - 1;
                } else {
                  lo = mid + 1;
                }
              }

              const visiblePts = endIdx - firstIdx + 1;
              const tracePath = new Path2D();
              let started = false;

              if (visiblePts <= 4500) {
                for (let k = firstIdx; k <= endIdx; k++) {
                  const ringIdx = (startPos + k) % PLOT_RING_CAPACITY;
                  const t = entry.timestamps[ringIdx];
                  const v = entry.values[ringIdx];
                  const x = PLOT_LEFT + ((t - tStart) / timeSpan) * plotW;
                  const y = laneY0 + (1 - (v - yLo) / ySpan) * laneH;
                  if (!started) {
                    tracePath.moveTo(x, y);
                    started = true;
                  } else {
                    tracePath.lineTo(x, y);
                  }
                }
              } else {
                let curCol = -999999;
                let firstY = 0;
                let minY = 0;
                let maxY = 0;
                let lastY = 0;

                const flushCol = (col: number): void => {
                  const xCol = PLOT_LEFT + col + 0.5;
                  if (!started) {
                    tracePath.moveTo(xCol, firstY);
                    started = true;
                  } else {
                    tracePath.lineTo(xCol, firstY);
                  }
                  if (minY !== firstY || maxY !== firstY) {
                    tracePath.lineTo(xCol, minY);
                    tracePath.lineTo(xCol, maxY);
                  }
                  if (lastY !== maxY) {
                    tracePath.lineTo(xCol, lastY);
                  }
                };

                for (let k = firstIdx; k <= endIdx; k++) {
                  const ringIdx = (startPos + k) % PLOT_RING_CAPACITY;
                  const t = entry.timestamps[ringIdx];
                  const v = entry.values[ringIdx];
                  const col = Math.floor(((t - tStart) / timeSpan) * plotW);
                  const y = laneY0 + (1 - (v - yLo) / ySpan) * laneH;

                  if (col !== curCol) {
                    if (curCol !== -999999) flushCol(curCol);
                    curCol = col;
                    firstY = y;
                    minY = y;
                    maxY = y;
                    lastY = y;
                  } else {
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    lastY = y;
                  }
                }
                if (curCol !== -999999) flushCol(curCol);
              }

              ctx.strokeStyle = entry.colorHex;
              ctx.lineWidth = 1.6;
              ctx.stroke(tracePath);
              ctx.restore();
            }
          }

          // Outer plot area border
          ctx.strokeStyle = borderColor;
          ctx.lineWidth = 1;
          ctx.strokeRect(PLOT_LEFT + 0.5, PAD_TOP + 0.5, plotW, totalPlotH);

          // 4. Global Indicators (Cut across ALL lanes!)
          // 4a. Dual Measurement Cursors A & B
          if (deltaCursorsEnabled) {
            const drawDeltaCursor = (
              tVal: number | null,
              color: string,
              tag: 'A' | 'B',
            ): void => {
              if (tVal === null || tVal < tStart || tVal > tEnd) return;
              const x = Math.round(PLOT_LEFT + ((tVal - tStart) / timeSpan) * plotW) + 0.5;
              ctx.save();
              ctx.strokeStyle = color;
              ctx.lineWidth = 1.4;
              ctx.setLineDash([5, 3]);
              ctx.beginPath();
              ctx.moveTo(x, PAD_TOP);
              ctx.lineTo(x, PAD_TOP + totalPlotH);
              ctx.stroke();
              ctx.setLineDash([]);

              ctx.fillStyle = color;
              ctx.fillRect(x - 7, PAD_TOP, 14, 13);
              ctx.font = 'bold 9.5px Consolas, "JetBrains Mono", monospace';
              ctx.fillStyle = '#FFFFFF';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(tag, x, PAD_TOP + 6.5);
              ctx.restore();
            };

            drawDeltaCursor(vp.cursorATimeSec, '#F59E0B', 'A');
            drawDeltaCursor(vp.cursorBTimeSec, '#EC4899', 'B');
          }

          // 4b. Replay Line
          const replay = telemetryStore.getHeaderSlice().replay;
          if (replay && replay.state !== 'idle' && replay.durationUs > 0) {
            const replaySec = replay.elapsedUs / 1_000_000;
            if (replaySec >= tStart && replaySec <= tEnd) {
              const rx = Math.round(PLOT_LEFT + ((replaySec - tStart) / timeSpan) * plotW) + 0.5;
              ctx.save();
              ctx.strokeStyle = '#06B6D4';
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.moveTo(rx, PAD_TOP);
              ctx.lineTo(rx, PAD_TOP + totalPlotH);
              ctx.stroke();

              ctx.fillStyle = '#06B6D4';
              ctx.fillRect(rx - 22, PAD_TOP, 44, 13);
              ctx.font = 'bold 9px Consolas, "JetBrains Mono", monospace';
              ctx.fillStyle = '#0B0F17';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText('REPLAY', rx, PAD_TOP + 6.5);
              ctx.restore();
            }
          }

          // 4c. Global Vertical Crosshair
          if (cursorRatio !== null && cursorRatio >= 0 && cursorRatio <= 1) {
            const cx = Math.round(PLOT_LEFT + cursorRatio * plotW) + 0.5;
            ctx.save();
            ctx.strokeStyle = isDark ? 'rgba(248,250,252,0.55)' : 'rgba(15,23,42,0.45)';
            ctx.setLineDash([3, 3]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cx, PAD_TOP);
            ctx.lineTo(cx, PAD_TOP + totalPlotH);
            ctx.stroke();
            ctx.restore();
          }

          // 4d. Rubber-Band Box Zoom Selection
          const activeDrag = dragRef.current;
          if (activeDrag && activeDrag.kind === 'boxZoom') {
            const bx0 = Math.max(PLOT_LEFT, Math.min(plotRight, activeDrag.startX));
            const bx1 = Math.max(PLOT_LEFT, Math.min(plotRight, activeDrag.curX));
            const rx = Math.min(bx0, bx1);
            const rw = Math.abs(bx1 - bx0);
            ctx.fillStyle = 'rgba(14, 165, 233, 0.16)';
            ctx.fillRect(rx, PAD_TOP, rw, totalPlotH);
            ctx.save();
            ctx.strokeStyle = '#0EA5E9';
            ctx.lineWidth = 1.2;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(rx + 0.5, PAD_TOP + 0.5, rw - 1, totalPlotH - 1);
            ctx.restore();
          }
        }
      }

      rafId = window.requestAnimationFrame(renderFrame);
    };

    rafId = window.requestAnimationFrame(renderFrame);
    return () => {
      active = false;
      window.cancelAnimationFrame(rafId);
    };
  }, [entries, deltaCursorsEnabled, theme, sharedCursorRatioRef]);

  // Pointer interaction handlers (pan, zoom, box-zoom, drag)
  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const curEntries = propsRef.current.entries;
    if (curEntries.length === 0) return;

    const { w, h } = sizeRef.current;
    const totalPlotH = Math.max(20, h - PAD_TOP - PAD_BOTTOM);
    const laneH = totalPlotH / curEntries.length;
    const plotW = Math.max(20, w - PLOT_LEFT - PAD_RIGHT);

    canvas.setPointerCapture(ev.pointerId);

    // 1. Click on Left Strip -> Axis Pan of that specific lane
    if (x < PLOT_LEFT && y >= PAD_TOP && y <= PAD_TOP + totalPlotH) {
      const laneIdx = Math.max(
        0,
        Math.min(curEntries.length - 1, Math.floor((y - PAD_TOP) / laneH)),
      );
      const targetEntry = curEntries[laneIdx];
      if (targetEntry) {
        const bounds = resolveSeriesYBounds(targetEntry);
        dragRef.current = {
          kind: 'axisPanY',
          targetKey: targetEntry.key,
          startY: y,
          initialYMin: bounds.yMin,
          initialYMax: bounds.yMax,
        };
        plotStore.pushZoomHistory();
        return;
      }
    }

    // 2. Click on Delta Cursors A or B
    if (deltaCursorsEnabled && x >= PLOT_LEFT && x <= PLOT_LEFT + plotW) {
      const vp = plotStore.getViewport();
      const { tStart, span } = plotStore.getEffectiveTimeWindow();
      if (vp.cursorATimeSec !== null) {
        const ax = PLOT_LEFT + ((vp.cursorATimeSec - tStart) / span) * plotW;
        if (Math.abs(x - ax) <= 8) {
          dragRef.current = { kind: 'cursor', which: 'A' };
          return;
        }
      }
      if (vp.cursorBTimeSec !== null) {
        const bx = PLOT_LEFT + ((vp.cursorBTimeSec - tStart) / span) * plotW;
        if (Math.abs(x - bx) <= 8) {
          dragRef.current = { kind: 'cursor', which: 'B' };
          return;
        }
      }
    }

    // 3. Click on Bottom Time Axis -> Axis Pan Time
    if (y > PAD_TOP + totalPlotH && x >= PLOT_LEFT && x <= PLOT_LEFT + plotW) {
      const { tEnd, span } = plotStore.getEffectiveTimeWindow();
      dragRef.current = {
        kind: 'axisPanX',
        startX: x,
        initialRightSec: tEnd,
        initialSpanSec: span,
      };
      plotStore.pushZoomHistory();
      return;
    }

    // 4. Click inside Plot Area -> Pan or BoxZoom
    if (
      x >= PLOT_LEFT &&
      x <= PLOT_LEFT + plotW &&
      y >= PAD_TOP &&
      y <= PAD_TOP + totalPlotH
    ) {
      const tool = spaceHeldRef.current ? 'pan' : propsRef.current.dragTool;
      if (spaceHeldRef.current) {
        spaceUsedForDragRef.current = true;
      }

      if (tool === 'boxZoom') {
        dragRef.current = {
          kind: 'boxZoom',
          startX: x,
          startY: y,
          curX: x,
          curY: y,
        };
      } else {
        const { tEnd, span } = plotStore.getEffectiveTimeWindow();
        const laneIdx = Math.max(
          0,
          Math.min(curEntries.length - 1, Math.floor((y - PAD_TOP) / laneH)),
        );
        const targetEntry = curEntries[laneIdx];
        const bounds = targetEntry
          ? resolveSeriesYBounds(targetEntry)
          : { yMin: -1, yMax: 1 };
        dragRef.current = {
          kind: 'pan',
          startX: x,
          startY: y,
          initialRightSec: tEnd,
          initialSpanSec: span,
          panYTarget: targetEntry?.key ?? null,
          initialYMin: bounds.yMin,
          initialYMax: bounds.yMax,
          initialMultiY: {},
        };
        plotStore.pushZoomHistory();
      }
    }
  };

  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    localHoverRef.current = { x, y };

    const { w, h } = sizeRef.current;
    const totalPlotH = Math.max(20, h - PAD_TOP - PAD_BOTTOM);
    const plotW = Math.max(20, w - PLOT_LEFT - PAD_RIGHT);

    // Update shared crosshair ratio
    if (x >= PLOT_LEFT && x <= PLOT_LEFT + plotW) {
      sharedCursorRatioRef.current = Math.max(0, Math.min(1, (x - PLOT_LEFT) / plotW));
    }

    const curDrag = dragRef.current;
    if (!curDrag) {
      if (x < PLOT_LEFT) setCursorCss('ns-resize');
      else if (y > PAD_TOP + totalPlotH) setCursorCss('ew-resize');
      else setCursorCss(propsRef.current.dragTool === 'boxZoom' ? 'crosshair' : 'grab');
      return;
    }

    if (curDrag.kind === 'boxZoom') {
      curDrag.curX = x;
      curDrag.curY = y;
      return;
    }

    if (curDrag.kind === 'cursor') {
      const { tStart, span } = plotStore.getEffectiveTimeWindow();
      const nextT = tStart + Math.max(0, Math.min(1, (x - PLOT_LEFT) / plotW)) * span;
      plotStore.setDeltaCursorTime(curDrag.which, nextT, false);
      return;
    }

    if (curDrag.kind === 'axisPanX' || curDrag.kind === 'pan') {
      const dxPx = x - curDrag.startX;
      const dt = -(dxPx / plotW) * curDrag.initialSpanSec;
      plotStore.setViewRightTimeSec(curDrag.initialRightSec + dt, false);

      if (curDrag.kind === 'pan' && curDrag.panYTarget) {
        const curEntries = propsRef.current.entries;
        const totalPlotH2 = Math.max(20, h - PAD_TOP - PAD_BOTTOM);
        const laneH = totalPlotH2 / Math.max(1, curEntries.length);
        const dyPx = y - curDrag.startY;
        const spanY = curDrag.initialYMax - curDrag.initialYMin;
        const dVal = (dyPx / laneH) * spanY;
        plotStore.setScopeManualY(
          curDrag.panYTarget,
          curDrag.initialYMin + dVal,
          curDrag.initialYMax + dVal,
          { emit: false },
        );
      }
      return;
    }

    if (curDrag.kind === 'axisPanY') {
      const curEntries = propsRef.current.entries;
      const laneH = totalPlotH / Math.max(1, curEntries.length);
      const dyPx = y - curDrag.startY;
      const spanY = curDrag.initialYMax - curDrag.initialYMin;
      const dVal = (dyPx / laneH) * spanY;
      plotStore.setScopeManualY(
        curDrag.targetKey,
        curDrag.initialYMin + dVal,
        curDrag.initialYMax + dVal,
        { emit: false },
      );
    }
  };

  const onPointerUp = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (canvas && canvas.hasPointerCapture(ev.pointerId)) {
      canvas.releasePointerCapture(ev.pointerId);
    }
    const curDrag = dragRef.current;
    dragRef.current = null;

    if (!curDrag) return;

    if (curDrag.kind === 'boxZoom') {
      const { w } = sizeRef.current;
      const plotW = Math.max(20, w - PLOT_LEFT - PAD_RIGHT);
      const bx0 = Math.max(PLOT_LEFT, Math.min(PLOT_LEFT + plotW, curDrag.startX));
      const bx1 = Math.max(PLOT_LEFT, Math.min(PLOT_LEFT + plotW, curDrag.curX));
      const rw = Math.abs(bx1 - bx0);
      if (rw > 8) {
        const { tStart, span } = plotStore.getEffectiveTimeWindow();
        const tA = tStart + ((Math.min(bx0, bx1) - PLOT_LEFT) / plotW) * span;
        const tB = tStart + ((Math.max(bx0, bx1) - PLOT_LEFT) / plotW) * span;
        plotStore.setTimeRange(tA, tB, true, true);
      }
    } else {
      plotStore.notifyInteractionEnd();
    }
  };

  const onDoubleClick = (ev: React.MouseEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const curEntries = propsRef.current.entries;
    if (curEntries.length === 0) return;

    const { h } = sizeRef.current;
    const totalPlotH = Math.max(20, h - PAD_TOP - PAD_BOTTOM);
    const laneH = totalPlotH / curEntries.length;

    // Double click on Left Strip of lane i -> reset Auto-Y for that lane!
    if (x < PLOT_LEFT) {
      const laneIdx = Math.max(
        0,
        Math.min(curEntries.length - 1, Math.floor((y - PAD_TOP) / laneH)),
      );
      const targetEntry = curEntries[laneIdx];
      if (targetEntry) {
        plotStore.resetScopeAutoY(targetEntry.key);
      }
      return;
    }

    // Double click inside Plot Area -> Reset full oscilloscope view!
    plotStore.resetFullView();
  };

  return (
    <div
      ref={wrapperRef}
      style={{
        backgroundColor: theme === 'dark' ? '#14171B' : '#FAFAFB',
        borderColor: 'var(--border-strong)',
      }}
      className="relative flex-1 min-h-0 border overflow-hidden select-none"
    >
      <canvas
        ref={canvasRef}
        tabIndex={0}
        onContextMenu={contextMenu.onContextMenu}
        onPointerDown={(event) => { if (contextMenu.start(event)) onPointerDown(event); }}
        onPointerMove={(event) => { contextMenu.move(event); onPointerMove(event); }}
        onPointerUp={(event) => { onPointerUp(event); contextMenu.finish(event); }}
        onPointerCancel={(event) => { onPointerUp(event); contextMenu.finish(event); }}
        onDoubleClick={onDoubleClick}
        onPointerLeave={() => {
          localHoverRef.current = null;
          sharedCursorRatioRef.current = null;
        }}
        style={{ cursor: cursorCss }}
        className="block w-full h-full touch-none"
      />
    </div>
  );
};

interface ScopeCanvasProps {
  scopeMode: 'combined' | 'split';
  entries: readonly PlotSeriesEntry[];
  yScaleMode: PlotYScaleMode;
  dragTool: 'pan' | 'boxZoom';
  deltaCursorsEnabled: boolean;
  theme: 'dark' | 'light';
  sharedCursorRatioRef: React.MutableRefObject<number | null>;
  spaceHeldRef: React.MutableRefObject<boolean>;
  spaceUsedForDragRef: React.MutableRefObject<boolean>;
  title: string;
}

const ScopeCanvas: React.FC<ScopeCanvasProps> = ({
  scopeMode,
  entries,
  yScaleMode,
  dragTool,
  deltaCursorsEnabled,
  theme,
  sharedCursorRatioRef,
  spaceHeldRef,
  spaceUsedForDragRef,
  title,
}) => {
  const contextMenu = usePlotContextMenu();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef<{ w: number; h: number }>({ w: 800, h: 300 });
  const localHoverRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<ActivePointerDrag | null>(null);
  const autoYBadgeRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(
    null,
  );
  const lastRenderedBoundsRef = useRef<{
    combinedBounds: SeriesBounds;
    perSeriesBounds: Map<string, SeriesBounds>;
  }>({
    combinedBounds: { yMin: 0, yMax: 100 },
    perSeriesBounds: new Map(),
  });

  const [cursorCss, setCursorCss] = useState<string>('crosshair');

  // Keep latest props in a ref so the non-passive wheel listener always reads fresh config
  const propsRef = useRef({
    scopeMode,
    entries,
    yScaleMode,
    dragTool,
    deltaCursorsEnabled,
    theme,
  });
  propsRef.current = {
    scopeMode,
    entries,
    yScaleMode,
    dragTool,
    deltaCursorsEnabled,
    theme,
  };

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const updateSize = (): void => {
      sizeRef.current = {
        w: Math.max(140, el.clientWidth),
        h: Math.max(100, el.clientHeight),
      };
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Non-passive wheel listener so Split view NEVER scrolls page while zooming!
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (ev: WheelEvent): void => {
      ev.preventDefault();
      ev.stopPropagation();

      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const { scopeMode: sMode, entries: curEntries, yScaleMode: yMode, theme: curTheme } =
        propsRef.current;
      const geom = computeScopeGeometry(
        rect.width,
        rect.height,
        sMode,
        yMode,
        curEntries,
        curTheme === 'dark',
      );

      // 1. Touchpad Horizontal Swipe -> Smooth Horizontal Time Pan
      if (
        !ev.ctrlKey &&
        !ev.altKey &&
        !ev.shiftKey &&
        Math.abs(ev.deltaX) > Math.abs(ev.deltaY) &&
        Math.abs(ev.deltaX) > 1
      ) {
        const { span } = plotStore.getEffectiveTimeWindow();
        const dt = (ev.deltaX / Math.max(20, geom.plotW)) * span;
        plotStore.panTimeBy(dt, true);
        return;
      }

      if (ev.deltaY === 0) return;
      const zoomFactor = ev.deltaY < 0 ? 0.8 : 1.25;

      // 2. Check if wheel is directly over a Left or Right Y-Axis Strip!
      const hitStrip = findHitAxisStrip(x, y, geom);
      const yRatio = Math.max(0, Math.min(1, 1 - (y - PAD_TOP) / geom.plotH));

      const zoomSpecificTargetY = (targetKey: 'combined' | string): void => {
        const bounds =
          targetKey === 'combined'
            ? lastRenderedBoundsRef.current.combinedBounds
            : (lastRenderedBoundsRef.current.perSeriesBounds.get(targetKey) ?? {
                yMin: -1,
                yMax: 1,
              });
        const spanY = Math.max(1e-6, bounds.yMax - bounds.yMin);
        const anchorVal = bounds.yMin + yRatio * spanY;
        const nextSpanY = Math.max(1e-6, Math.min(1e9, spanY * zoomFactor));
        const nextMin = anchorVal - yRatio * nextSpanY;
        plotStore.setScopeManualY(targetKey, nextMin, nextMin + nextSpanY, {
          saveHistory: true,
          fromWheel: true,
          emit: true,
        });
      };

      if (hitStrip) {
        zoomSpecificTargetY(hitStrip.targetKey);
        return;
      }

      const xRatio = Math.max(0, Math.min(1, (x - geom.plotLeft) / geom.plotW));
      const doYZoomInPlot = ev.shiftKey || ev.ctrlKey || ev.altKey;
      const doXZoomInPlot = !ev.shiftKey || ev.ctrlKey || ev.altKey;

      if (doXZoomInPlot) {
        plotStore.zoomTimeAtRatio(zoomFactor, xRatio, true);
      }

      if (doYZoomInPlot) {
        if (sMode === 'split' && curEntries.length === 1) {
          zoomSpecificTargetY(curEntries[0].key);
        } else if (sMode === 'combined' && yMode === 'multiAxis') {
          const normLo = yRatio - yRatio * zoomFactor;
          const normHi = normLo + zoomFactor;
          plotStore.applyProportionalYWindowToVisibleSeries(normLo, normHi, {
            saveHistory: !doXZoomInPlot,
            fromWheel: true,
            emit: true,
          });
        } else {
          zoomSpecificTargetY('combined');
        }
      }
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  // 60 FPS Canvas Rendering Loop
  useEffect(() => {
    let rafId = 0;
    let active = true;

    const renderFrame = (): void => {
      if (!active) return;
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const { w, h } = sizeRef.current;
          const dpr = window.devicePixelRatio || 1;
          const targetPxW = Math.floor(w * dpr);
          const targetPxH = Math.floor(h * dpr);
          if (canvas.width !== targetPxW || canvas.height !== targetPxH) {
            canvas.width = targetPxW;
            canvas.height = targetPxH;
          }
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

          const isDark = theme === 'dark';
          const bgColor = isDark ? '#14171B' : '#FAFAFB';
          const gridColor = isDark ? '#22262C' : '#E2E6ED';
          const borderColor = isDark ? '#313741' : '#B8C0CC';
          const textMuted = isDark ? '#8B949E' : '#57606A';
          const textPrimary = isDark ? '#D8DEE6' : '#1F2328';

          ctx.fillStyle = bgColor;
          ctx.fillRect(0, 0, w, h);

          const geom = computeScopeGeometry(w, h, scopeMode, yScaleMode, entries, isDark);
          const { plotLeft, plotRight, plotW, plotH, strips } = geom;
          const vp = plotStore.getViewport();
          const { tStart, tEnd, span: timeSpan } = plotStore.getEffectiveTimeWindow();

          // Compute Y bounds for every visible series + sticky shared/normalized combined bounds
          const perSeriesBounds = new Map<string, SeriesBounds>();
          let sharedAutoMin = Number.POSITIVE_INFINITY;
          let sharedAutoMax = Number.NEGATIVE_INFINITY;

          for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const b = resolveSeriesYBounds(e);
            perSeriesBounds.set(e.key, b);
            const autoB = { yMin: e.lastAutoYMin, yMax: e.lastAutoYMax };
            if (autoB.yMin < sharedAutoMin) sharedAutoMin = autoB.yMin;
            if (autoB.yMax > sharedAutoMax) sharedAutoMax = autoB.yMax;
          }

          if (!Number.isFinite(sharedAutoMin) || !Number.isFinite(sharedAutoMax)) {
            sharedAutoMin = -1;
            sharedAutoMax = 1;
          }
          if (Math.abs(sharedAutoMax - sharedAutoMin) < 1e-6) {
            sharedAutoMin -= 1;
            sharedAutoMax += 1;
          }

          const stickySharedMin = vp.stickySharedInitialized
            ? Math.min(vp.stickySharedYMin, sharedAutoMin)
            : sharedAutoMin;
          const stickySharedMax =
            vp.stickySharedInitialized && vp.stickySharedYMax > stickySharedMin
              ? Math.max(vp.stickySharedYMax, sharedAutoMax)
              : sharedAutoMax;

          const defaultCombinedAuto: SeriesBounds =
            yScaleMode === 'normalized'
              ? { yMin: 0, yMax: 100 }
              : { yMin: stickySharedMin, yMax: stickySharedMax };
          plotStore.recordLastCombinedAutoY(
            defaultCombinedAuto.yMin,
            defaultCombinedAuto.yMax,
          );

          const combinedBounds: SeriesBounds = vp.combinedYAuto
            ? defaultCombinedAuto
            : {
                yMin: vp.combinedYMin,
                yMax:
                  vp.combinedYMax > vp.combinedYMin
                    ? vp.combinedYMax
                    : vp.combinedYMin + 1,
              };

          lastRenderedBoundsRef.current = { combinedBounds, perSeriesBounds };

          const getEffectiveYBoundsForEntry = (entry: PlotSeriesEntry): SeriesBounds => {
            if (scopeMode === 'split' || yScaleMode === 'multiAxis') {
              return perSeriesBounds.get(entry.key) ?? { yMin: -1, yMax: 1 };
            }
            if (yScaleMode === 'normalized') {
              const autoMin = entry.lastAutoYMin;
              const autoSpan = Math.max(1e-9, entry.lastAutoYMax - autoMin);
              return {
                yMin: autoMin + (combinedBounds.yMin / 100) * autoSpan,
                yMax: autoMin + (combinedBounds.yMax / 100) * autoSpan,
              };
            }
            return combinedBounds;
          };

          // 1. Draw Oscilloscope Graticule Grid (World-Time-Aligned Scrolling Vertical Gridlines!)
          ctx.strokeStyle = gridColor;
          ctx.lineWidth = 1;
          const hDivs = 4;
          for (let row = 0; row <= hDivs; row++) {
            const frac = row / hDivs;
            const y = Math.round(PAD_TOP + frac * plotH) + 0.5;
            ctx.beginPath();
            ctx.moveTo(plotLeft, y);
            ctx.lineTo(plotRight, y);
            ctx.stroke();
          }

          const timeGridStep = computeNiceStep(timeSpan / 6);
          const firstGridT = Math.ceil(tStart / timeGridStep) * timeGridStep;
          ctx.font = '10px Consolas, "JetBrains Mono", monospace';
          ctx.fillStyle = textMuted;
          ctx.textBaseline = 'top';
          ctx.textAlign = 'center';

          let gridSafeGuard = 0;
          for (
            let tGrid = firstGridT;
            tGrid <= tEnd + timeGridStep * 1e-6 && gridSafeGuard < 24;
            tGrid += timeGridStep, gridSafeGuard += 1
          ) {
            const cleanT =
              Math.abs(tGrid) < timeGridStep * 1e-9 ? 0 : tGrid;
            const frac = (cleanT - tStart) / timeSpan;
            if (frac < -1e-4 || frac > 1.0001) continue;
            const x = Math.round(plotLeft + frac * plotW) + 0.5;
            ctx.beginPath();
            ctx.moveTo(x, PAD_TOP);
            ctx.lineTo(x, PAD_TOP + plotH);
            ctx.stroke();

            if (x >= plotLeft + 22 && x <= plotRight - 22) {
              ctx.fillText(formatTimeTick(cleanT, timeSpan), x, PAD_TOP + plotH + 5);
            }
          }

          // 2. Draw Left & Right Y-Axis Strips (Single or Multi-Axis!)
          const localHover = localHoverRef.current;
          const hoveredStrip = localHover
            ? findHitAxisStrip(localHover.x, localHover.y, geom)
            : null;

          for (let sIdx = 0; sIdx < strips.length; sIdx++) {
            const st = strips[sIdx];
            const stripBounds = st.entry
              ? (perSeriesBounds.get(st.entry.key) ?? { yMin: -1, yMax: 1 })
              : combinedBounds;
            const stripSpan = Math.max(1e-9, stripBounds.yMax - stripBounds.yMin);

            if (hoveredStrip && hoveredStrip.targetKey === st.targetKey) {
              ctx.save();
              ctx.fillStyle = st.colorHex;
              ctx.globalAlpha = isDark ? 0.12 : 0.08;
              ctx.fillRect(st.x0, PAD_TOP, st.x1 - st.x0, plotH);
              ctx.restore();
            }

            // Colored vertical scale line
            ctx.strokeStyle = st.colorHex;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(st.lineX, PAD_TOP);
            ctx.lineTo(st.lineX, PAD_TOP + plotH);
            ctx.stroke();

            // Strip top unit/tag header
            ctx.font = 'bold 10px Consolas, "JetBrains Mono", monospace';
            ctx.fillStyle = st.colorHex;
            ctx.textBaseline = 'middle';
            if (st.side === 'left') {
              ctx.textAlign = 'right';
              ctx.fillText(
                `${st.headerTag}${st.isAuto ? '' : '·M'}`,
                st.x1 - 5,
                12,
              );
            } else {
              ctx.textAlign = 'left';
              ctx.fillText(
                `${st.headerTag}${st.isAuto ? '' : '·M'}`,
                st.x0 + 5,
                12,
              );
            }

            // Tick labels along strip
            ctx.font = '10px Consolas, "JetBrains Mono", monospace';
            ctx.fillStyle = st.entry ? st.colorHex : textMuted;
            for (let row = 0; row <= hDivs; row++) {
              const frac = row / hDivs;
              const y = Math.round(PAD_TOP + frac * plotH) + 0.5;
              const tickVal = stripBounds.yMax - frac * stripSpan;
              const label =
                !st.entry && yScaleMode === 'normalized'
                  ? `${formatAxisNum(tickVal, stripSpan)}%`
                  : formatAxisNum(tickVal, stripSpan);

              if (st.side === 'left') {
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, st.x1 - 5, y);
              } else {
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, st.x0 + 5, y);
              }
            }
          }

          // Outer plot frame
          ctx.strokeStyle = borderColor;
          ctx.lineWidth = 1;
          ctx.strokeRect(plotLeft + 0.5, PAD_TOP + 0.5, plotW, plotH);

          // Title (Split mode only) & Manual Y Reset Pill
          let titleW = 0;
          if (title.length > 0) {
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.font = '600 11px "Segoe UI", Inter, sans-serif';
            ctx.fillStyle = textPrimary;
            ctx.fillText(title, plotLeft + 4, 12);
            titleW = ctx.measureText(title).width;
          }

          const hasAnyManualY =
            scopeMode === 'split'
              ? entries.some((e) => !e.autoScale)
              : yScaleMode === 'multiAxis'
                ? entries.some((e) => !e.autoScale)
                : !vp.combinedYAuto;

          if (hasAnyManualY) {
            const bx = plotLeft + (titleW > 0 ? titleW + 12 : 6);
            const by = 3;
            const bw = 56;
            const bh = 17;
            autoYBadgeRectRef.current = { x: bx, y: by, w: bw, h: bh };

            ctx.fillStyle = isDark ? '#1D2126' : '#FEF3C7';
            ctx.strokeStyle = '#D99B26';
            ctx.fillRect(bx, by, bw, bh);
            ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
            ctx.font = 'bold 9.5px Consolas, "JetBrains Mono", monospace';
            ctx.fillStyle = '#E3B341';
            ctx.textAlign = 'center';
            ctx.fillText('Auto-Y ↺', bx + bw / 2, by + bh / 2 + 0.5);
          } else {
            autoYBadgeRectRef.current = null;
          }

          // Determine hovered waveform line (closest to mouseY at tCursor) BEFORE drawing traces
          const cursorRatio = sharedCursorRatioRef.current;
          const tCursor =
            cursorRatio !== null && cursorRatio >= 0 && cursorRatio <= 1
              ? tStart + cursorRatio * timeSpan
              : null;

          interface PointSample {
            entry: PlotSeriesEntry;
            val: number;
            cx: number;
            cy: number;
            ySpan: number;
          }

          const cursorPoints: PointSample[] = [];
          let hoveredSeriesKey: string | null = null;
          let nearestPoint: PointSample | null = null;
          let minDistPx = Number.POSITIVE_INFINITY;

          if (tCursor !== null && cursorRatio !== null) {
            const cx = plotLeft + cursorRatio * plotW;
            for (let i = 0; i < entries.length; i++) {
              const e = entries[i];
              const val = findValueAtTime(e, tCursor);
              if (val === null) continue;
              const b = getEffectiveYBoundsForEntry(e);
              const ySpan = Math.max(1e-9, b.yMax - b.yMin);
              const cy = PAD_TOP + (1 - (val - b.yMin) / ySpan) * plotH;
              const pt: PointSample = { entry: e, val, cx, cy, ySpan };
              cursorPoints.push(pt);

              if (
                localHover &&
                localHover.x >= plotLeft &&
                localHover.x <= plotRight &&
                localHover.y >= PAD_TOP &&
                localHover.y <= PAD_TOP + plotH
              ) {
                const dist = Math.abs(localHover.y - cy);
                if (dist < minDistPx) {
                  minDistPx = dist;
                  nearestPoint = pt;
                }
              }
            }
            if (nearestPoint && minDistPx <= 28) {
              hoveredSeriesKey = nearestPoint.entry.key;
            }
          }

          // 3. Draw Clipped Waveforms
          ctx.save();
          ctx.beginPath();
          ctx.rect(plotLeft, PAD_TOP, plotW, plotH);
          ctx.clip();

          for (let sIdx = 0; sIdx < entries.length; sIdx++) {
            const entry = entries[sIdx];
            const count = entry.count;
            if (count === 0) continue;

            const bounds = getEffectiveYBoundsForEntry(entry);
            const yLo = bounds.yMin;
            const ySpan = Math.max(1e-9, bounds.yMax - yLo);
            const isHoveredLine = entry.key === hoveredSeriesKey;

            const startPos =
              (entry.writePos - count + PLOT_RING_CAPACITY) % PLOT_RING_CAPACITY;

            // Binary search first sample >= tStart - small margin for fast deep-history rendering!
            let loIdx = 0;
            let hiIdx = count - 1;
            while (loIdx < hiIdx) {
              const mid = (loIdx + hiIdx) >>> 1;
              const rIdx = (startPos + mid) % PLOT_RING_CAPACITY;
              if (entry.timestamps[rIdx] < tStart) {
                loIdx = mid + 1;
              } else {
                hiIdx = mid;
              }
            }
            const firstIdx = Math.max(0, loIdx - 1);

            let endIdx = firstIdx;
            // Binary search last sample <= tEnd + 1
            let rLo = firstIdx;
            let rHi = count - 1;
            while (rLo < rHi) {
              const mid = (rLo + rHi + 1) >>> 1;
              const rIdx = (startPos + mid) % PLOT_RING_CAPACITY;
              if (entry.timestamps[rIdx] <= tEnd) {
                rLo = mid;
              } else {
                rHi = mid - 1;
              }
            }
            endIdx = Math.min(count - 1, rLo + 1);

            const visibleCount = Math.max(0, endIdx - firstIdx + 1);
            const tracePath = new Path2D();
            let started = false;

            if (visibleCount <= 4500) {
              // Full-resolution exact rendering (zero sample skipping, zero aliasing!)
              for (let i = firstIdx; i <= endIdx; i++) {
                const ringIdx = (startPos + i) % PLOT_RING_CAPACITY;
                const t = entry.timestamps[ringIdx];
                const v = entry.values[ringIdx];
                const x = plotLeft + ((t - tStart) / timeSpan) * plotW;
                const y = PAD_TOP + (1 - (v - yLo) / ySpan) * plotH;

                if (!started) {
                  tracePath.moveTo(x, y);
                  started = true;
                } else {
                  tracePath.lineTo(x, y);
                }
              }
            } else {
              // Deep-history (> 4500 pts): Deterministic per-pixel-column (firstY, minY, maxY, lastY) peak-detect envelope!
              let curCol = -999999;
              let firstY = 0;
              let minY = 0;
              let maxY = 0;
              let lastY = 0;

              const flushCol = (col: number): void => {
                const xCol = plotLeft + col + 0.5;
                if (!started) {
                  tracePath.moveTo(xCol, firstY);
                  started = true;
                } else {
                  tracePath.lineTo(xCol, firstY);
                }
                if (minY !== firstY || maxY !== firstY) {
                  tracePath.lineTo(xCol, minY);
                  tracePath.lineTo(xCol, maxY);
                }
                if (lastY !== maxY) {
                  tracePath.lineTo(xCol, lastY);
                }
              };

              for (let i = firstIdx; i <= endIdx; i++) {
                const ringIdx = (startPos + i) % PLOT_RING_CAPACITY;
                const t = entry.timestamps[ringIdx];
                const v = entry.values[ringIdx];
                const col = Math.floor(((t - tStart) / timeSpan) * plotW);
                const y = PAD_TOP + (1 - (v - yLo) / ySpan) * plotH;

                if (col !== curCol) {
                  if (curCol !== -999999) {
                    flushCol(curCol);
                  }
                  curCol = col;
                  firstY = y;
                  minY = y;
                  maxY = y;
                  lastY = y;
                } else {
                  if (y < minY) minY = y;
                  if (y > maxY) maxY = y;
                  lastY = y;
                }
              }
              if (curCol !== -999999) {
                flushCol(curCol);
              }
            }

            if (isHoveredLine) {
              ctx.save();
              ctx.strokeStyle = entry.colorHex;
              ctx.globalAlpha = 0.24;
              ctx.lineWidth = 5;
              ctx.stroke(tracePath);
              ctx.restore();
            }

            ctx.strokeStyle = entry.colorHex;
            ctx.lineWidth = isHoveredLine ? 2.6 : 1.6;
            ctx.stroke(tracePath);
          }

          // 4. Draw Dual Measurement Cursors A & B inside Clipped Plot Box
          if (deltaCursorsEnabled) {
            const drawMeasCursor = (
              tVal: number | null,
              color: string,
              tag: 'A' | 'B',
            ): void => {
              if (tVal === null || tVal < tStart || tVal > tEnd) return;
              const x = Math.round(plotLeft + ((tVal - tStart) / timeSpan) * plotW) + 0.5;
              ctx.save();
              ctx.strokeStyle = color;
              ctx.lineWidth = 1.4;
              ctx.setLineDash([5, 3]);
              ctx.beginPath();
              ctx.moveTo(x, PAD_TOP);
              ctx.lineTo(x, PAD_TOP + plotH);
              ctx.stroke();
              ctx.setLineDash([]);

              ctx.fillStyle = color;
              ctx.fillRect(x - 7, PAD_TOP, 14, 13);
              ctx.font = 'bold 9.5px Consolas, "JetBrains Mono", monospace';
              ctx.fillStyle = '#FFFFFF';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(tag, x, PAD_TOP + 6.5);
              ctx.restore();
            };

            drawMeasCursor(vp.cursorATimeSec, '#F59E0B', 'A');
            drawMeasCursor(vp.cursorBTimeSec, '#EC4899', 'B');
          }

          // 4b. Draw Replay Progress Indicator if replaying
          const replay = telemetryStore.getHeaderSlice().replay;
          if (replay && replay.state !== 'idle' && replay.durationUs > 0) {
            const replaySec = replay.elapsedUs / 1_000_000;
            if (replaySec >= tStart && replaySec <= tEnd) {
              const rx = Math.round(plotLeft + ((replaySec - tStart) / timeSpan) * plotW) + 0.5;
              ctx.save();
              ctx.strokeStyle = '#06B6D4';
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.moveTo(rx, PAD_TOP);
              ctx.lineTo(rx, PAD_TOP + plotH);
              ctx.stroke();

              ctx.fillStyle = '#06B6D4';
              ctx.fillRect(rx - 22, PAD_TOP, 44, 13);
              ctx.font = 'bold 9px Consolas, "JetBrains Mono", monospace';
              ctx.fillStyle = '#0B0F17';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText('REPLAY', rx, PAD_TOP + 6.5);
              ctx.restore();
            }
          }

          // 5. Draw Synchronized Hover Crosshair + Target Dots on Lines
          if (cursorRatio !== null && cursorRatio >= 0 && cursorRatio <= 1) {
            const cx = Math.round(plotLeft + cursorRatio * plotW) + 0.5;

            ctx.save();
            ctx.strokeStyle = isDark ? 'rgba(248,250,252,0.55)' : 'rgba(15,23,42,0.45)';
            ctx.setLineDash([3, 3]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cx, PAD_TOP);
            ctx.lineTo(cx, PAD_TOP + plotH);
            ctx.stroke();
            ctx.restore();

            for (let i = 0; i < cursorPoints.length; i++) {
              const pt = cursorPoints[i];
              if (pt.cy < PAD_TOP - 2 || pt.cy > PAD_TOP + plotH + 2) continue;
              const isSnapped = pt.entry.key === hoveredSeriesKey;
              ctx.beginPath();
              ctx.arc(pt.cx, pt.cy, isSnapped ? 5 : 3, 0, Math.PI * 2);
              ctx.fillStyle = pt.entry.colorHex;
              ctx.fill();
              ctx.lineWidth = isSnapped ? 2 : 1;
              ctx.strokeStyle = isDark ? '#0B0F17' : '#FFFFFF';
              ctx.stroke();
            }
          }

          // 6. Draw Rubber-Band Box Zoom Selection Overlay
          const activeDrag = dragRef.current;
          if (activeDrag && activeDrag.kind === 'boxZoom') {
            const bx0 = Math.max(plotLeft, Math.min(plotRight, activeDrag.startX));
            const bx1 = Math.max(plotLeft, Math.min(plotRight, activeDrag.curX));
            const by0 = Math.max(PAD_TOP, Math.min(PAD_TOP + plotH, activeDrag.startY));
            const by1 = Math.max(PAD_TOP, Math.min(PAD_TOP + plotH, activeDrag.curY));
            const is1DTimeOnly = Math.abs(by1 - by0) < 12;

            const rx = Math.min(bx0, bx1);
            const rw = Math.abs(bx1 - bx0);
            const ry = is1DTimeOnly ? PAD_TOP : Math.min(by0, by1);
            const rh = is1DTimeOnly ? plotH : Math.abs(by1 - by0);

            ctx.fillStyle = 'rgba(14, 165, 233, 0.16)';
            ctx.fillRect(rx, ry, rw, rh);
            ctx.save();
            ctx.strokeStyle = '#0EA5E9';
            ctx.lineWidth = 1.2;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(rx + 0.5, ry + 0.5, Math.max(1, rw - 1), Math.max(1, rh - 1));
            ctx.restore();

            if (rw > 24) {
              const selSpanSec = (rw / plotW) * timeSpan;
              const label = is1DTimeOnly
                ? `1D Time Zoom: Δt = ${formatSpanBadge(selSpanSec)}`
                : `2D Box Zoom: Δt = ${formatSpanBadge(selSpanSec)}`;
              ctx.font = 'bold 10px Consolas, "JetBrains Mono", monospace';
              const tw = ctx.measureText(label).width + 10;
              const lx = Math.min(plotRight - tw - 2, Math.max(plotLeft + 2, rx + 4));
              const ly = Math.max(PAD_TOP + 4, ry + 4);
              ctx.fillStyle = isDark ? '#0F172A' : '#FFFFFF';
              ctx.fillRect(lx, ly, tw, 16);
              ctx.strokeStyle = '#0EA5E9';
              ctx.strokeRect(lx + 0.5, ly + 0.5, tw - 1, 15);
              ctx.fillStyle = '#0EA5E9';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(label, lx + 5, ly + 8.5);
            }
          }

          ctx.restore(); // End plot clip

          // 7. Floating Line-Hover Value Callout Box (Directly beside hovered line / cursor!)
          if (
            localHover &&
            !dragRef.current &&
            tCursor !== null &&
            cursorPoints.length > 0 &&
            localHover.x >= plotLeft &&
            localHover.x <= plotRight &&
            localHover.y >= PAD_TOP &&
            localHover.y <= PAD_TOP + plotH
          ) {
            // Order hovered/nearest line first so it's prominently displayed
            const ordered = [...cursorPoints].sort((a, b) => {
              if (a.entry.key === hoveredSeriesKey) return -1;
              if (b.entry.key === hoveredSeriesKey) return 1;
              return 0;
            });
            const shown = ordered.slice(0, 6);

            ctx.font = '10.5px Consolas, "JetBrains Mono", monospace';
            const headerStr = `t = ${tCursor.toFixed(3)} s`;
            let maxTextW = ctx.measureText(headerStr).width + 14;

            const rowStrings: { pt: PointSample; text: string; highlight: boolean }[] = [];
            for (let i = 0; i < shown.length; i++) {
              const pt = shown[i];
              const highlight = pt.entry.key === hoveredSeriesKey;
              const prefix = highlight ? '▸ ' : '  ';
              const txt = `${prefix}${pt.entry.signalName}: ${formatAxisNum(
                pt.val,
                pt.ySpan,
              )}${pt.entry.unit ? ` ${pt.entry.unit}` : ''}`;
              rowStrings.push({ pt, text: txt, highlight });
              ctx.font = highlight
                ? 'bold 11px Consolas, "JetBrains Mono", monospace'
                : '10.5px Consolas, "JetBrains Mono", monospace';
              const wRow = ctx.measureText(txt).width + 22;
              if (wRow > maxTextW) maxTextW = wRow;
            }

            const boxW = Math.ceil(maxTextW) + 8;
            const lineH = 15;
            const boxH = 18 + rowStrings.length * lineH + 4;

            const anchorX = cursorPoints[0].cx;
            const anchorY =
              nearestPoint && hoveredSeriesKey
                ? Math.max(PAD_TOP + 6, Math.min(PAD_TOP + plotH - 6, nearestPoint.cy))
                : localHover.y;

            let bx = anchorX + 12;
            if (bx + boxW > plotRight - 4) {
              bx = Math.max(plotLeft + 4, anchorX - boxW - 12);
            }
            const by = Math.max(
              PAD_TOP + 4,
              Math.min(PAD_TOP + plotH - boxH - 4, anchorY - boxH / 2),
            );

            const accentBorder =
              nearestPoint && hoveredSeriesKey ? nearestPoint.entry.colorHex : borderColor;

            ctx.fillStyle = isDark ? 'rgba(15, 23, 42, 0.96)' : 'rgba(255, 255, 255, 0.96)';
            ctx.fillRect(bx, by, boxW, boxH);
            ctx.strokeStyle = accentBorder;
            ctx.lineWidth = hoveredSeriesKey ? 1.4 : 1;
            ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);

            ctx.font = '10px Consolas, "JetBrains Mono", monospace';
            ctx.fillStyle = textMuted;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(headerStr, bx + 7, by + 10);

            for (let i = 0; i < rowStrings.length; i++) {
              const r = rowStrings[i];
              const ry = by + 24 + i * lineH;
              ctx.fillStyle = r.pt.entry.colorHex;
              ctx.fillRect(bx + 7, ry - 3.5, 6, 6);

              ctx.font = r.highlight
                ? 'bold 11px Consolas, "JetBrains Mono", monospace'
                : '10.5px Consolas, "JetBrains Mono", monospace';
              ctx.fillStyle = r.highlight ? r.pt.entry.colorHex : textPrimary;
              ctx.fillText(r.text, bx + 16, ry);
            }
          } else if (cursorRatio !== null && tCursor !== null && cursorPoints.length > 0) {
            // Synchronized readout in top-right of companion Split charts
            const summary = cursorPoints
              .slice(0, 3)
              .map(
                (p) =>
                  `${p.entry.signalName}=${formatAxisNum(p.val, p.ySpan)}${
                    p.entry.unit ? ` ${p.entry.unit}` : ''
                  }`,
              )
              .join(' | ');
            ctx.font = '10px Consolas, "JetBrains Mono", monospace';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = textPrimary;
            ctx.fillText(`t=${tCursor.toFixed(3)}s | ${summary}`, plotRight - 2, 12);
          } else if (entries.length === 1) {
            const single = entries[0];
            const latestVal = single.latestValue;
            if (latestVal !== null) {
              ctx.font = 'bold 11px Consolas, "JetBrains Mono", monospace';
              ctx.textAlign = 'right';
              ctx.textBaseline = 'middle';
              ctx.fillStyle = single.colorHex;
              ctx.fillText(
                `${formatAxisNum(latestVal)}${single.unit ? ` ${single.unit}` : ''}`,
                plotRight - 2,
                12,
              );
            }
          }
        }
      }

      rafId = window.requestAnimationFrame(renderFrame);
    };

    rafId = window.requestAnimationFrame(renderFrame);
    return () => {
      active = false;
      window.cancelAnimationFrame(rafId);
    };
  }, [
    scopeMode,
    entries,
    yScaleMode,
    deltaCursorsEnabled,
    theme,
    sharedCursorRatioRef,
    title,
  ]);

  const updateHoverCursorStyle = useCallback(
    (x: number, y: number, rectW: number, rectH: number): void => {
      if (dragRef.current) return;
      const badge = autoYBadgeRectRef.current;
      if (badge && x >= badge.x && x <= badge.x + badge.w && y >= badge.y && y <= badge.y + badge.h) {
        setCursorCss('pointer');
        return;
      }

      const geom = computeScopeGeometry(
        rectW,
        rectH,
        scopeMode,
        yScaleMode,
        entries,
        theme === 'dark',
      );

      if (findHitAxisStrip(x, y, geom)) {
        setCursorCss('ns-resize');
        return;
      }
      if (y > PAD_TOP + geom.plotH && x >= geom.plotLeft && x <= geom.plotRight) {
        setCursorCss('ew-resize');
        return;
      }

      if (deltaCursorsEnabled && x >= geom.plotLeft && x <= geom.plotRight) {
        const vp = plotStore.getViewport();
        const { tStart, span } = plotStore.getEffectiveTimeWindow();
        if (vp.cursorATimeSec !== null) {
          const ax = geom.plotLeft + ((vp.cursorATimeSec - tStart) / span) * geom.plotW;
          if (Math.abs(x - ax) <= 6) {
            setCursorCss('col-resize');
            return;
          }
        }
        if (vp.cursorBTimeSec !== null) {
          const bx = geom.plotLeft + ((vp.cursorBTimeSec - tStart) / span) * geom.plotW;
          if (Math.abs(x - bx) <= 6) {
            setCursorCss('col-resize');
            return;
          }
        }
      }

      setCursorCss(dragTool === 'boxZoom' ? 'crosshair' : 'grab');
    },
    [scopeMode, yScaleMode, entries, theme, deltaCursorsEnabled, dragTool],
  );

  const handlePointerDown = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    const canvas = ev.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;

    // 1. Clickable Auto-Y reset pill in header
    const badge = autoYBadgeRectRef.current;
    if (
      ev.button === 0 &&
      badge &&
      x >= badge.x &&
      x <= badge.x + badge.w &&
      y >= badge.y &&
      y <= badge.y + badge.h
    ) {
      if (scopeMode === 'split' && entries.length === 1) {
        plotStore.resetScopeAutoY(entries[0].key);
      } else if (scopeMode === 'combined' && yScaleMode === 'multiAxis') {
        plotStore.resetAllAutoScale();
      } else {
        plotStore.resetScopeAutoY('combined');
      }
      return;
    }

    const geom = computeScopeGeometry(
      rect.width,
      rect.height,
      scopeMode,
      yScaleMode,
      entries,
      theme === 'dark',
    );

    // 2. Left or Right Y-Axis Strip Direct Drag (Y-Pan)
    const hitStrip = findHitAxisStrip(x, y, geom);
    if (ev.button === 0 && hitStrip) {
      canvas.setPointerCapture(ev.pointerId);
      const b =
        hitStrip.targetKey === 'combined'
          ? lastRenderedBoundsRef.current.combinedBounds
          : (lastRenderedBoundsRef.current.perSeriesBounds.get(hitStrip.targetKey) ?? {
              yMin: -1,
              yMax: 1,
            });
      plotStore.pushZoomHistory();
      dragRef.current = {
        kind: 'axisPanY',
        targetKey: hitStrip.targetKey,
        startY: y,
        initialYMin: b.yMin,
        initialYMax: b.yMax,
      };
      setCursorCss('ns-resize');
      return;
    }

    // 3. Bottom X-Axis Time Strip Direct Drag (X-Pan)
    if (
      ev.button === 0 &&
      y > PAD_TOP + geom.plotH &&
      x >= geom.plotLeft &&
      x <= geom.plotRight
    ) {
      canvas.setPointerCapture(ev.pointerId);
      const { tEnd, span } = plotStore.getEffectiveTimeWindow();
      plotStore.pushZoomHistory();
      dragRef.current = {
        kind: 'axisPanX',
        startX: x,
        initialRightSec: tEnd,
        initialSpanSec: span,
      };
      setCursorCss('ew-resize');
      return;
    }

    // Must be inside plot box for Cursor Drag, Pan, or Box-Zoom
    if (
      x < geom.plotLeft ||
      x > geom.plotRight ||
      y < PAD_TOP ||
      y > PAD_TOP + geom.plotH
    ) {
      return;
    }

    // 4. Delta Cursors A & B Drag Hit-Test
    if (ev.button === 0 && deltaCursorsEnabled) {
      const vp = plotStore.getViewport();
      const { tStart, span } = plotStore.getEffectiveTimeWindow();
      const distA =
        vp.cursorATimeSec !== null
          ? Math.abs(
              x - (geom.plotLeft + ((vp.cursorATimeSec - tStart) / span) * geom.plotW),
            )
          : Number.POSITIVE_INFINITY;
      const distB =
        vp.cursorBTimeSec !== null
          ? Math.abs(
              x - (geom.plotLeft + ((vp.cursorBTimeSec - tStart) / span) * geom.plotW),
            )
          : Number.POSITIVE_INFINITY;

      if (distA <= 6 || distB <= 6) {
        canvas.setPointerCapture(ev.pointerId);
        dragRef.current = {
          kind: 'cursor',
          which: distA <= distB ? 'A' : 'B',
        };
        setCursorCss('col-resize');
        return;
      }
    }

    // 5. Box-Zoom vs Pan inside Main Plot Area
    const forcePan = ev.button === 1 || (ev.button === 0 && spaceHeldRef.current);
    const startBoxZoom =
      !forcePan &&
      (ev.button === 2 ||
        (ev.button === 0 && ev.shiftKey) ||
        (ev.button === 0 && dragTool === 'boxZoom'));

    if (startBoxZoom) {
      canvas.setPointerCapture(ev.pointerId);
      dragRef.current = {
        kind: 'boxZoom',
        startX: x,
        startY: y,
        curX: x,
        curY: y,
      };
      setCursorCss('crosshair');
      return;
    }

    if (ev.button === 0 || ev.button === 1) {
      if (spaceHeldRef.current) {
        spaceUsedForDragRef.current = true;
      }
      canvas.setPointerCapture(ev.pointerId);
      const { tEnd, span } = plotStore.getEffectiveTimeWindow();
      const vp = plotStore.getViewport();
      plotStore.pushZoomHistory();

      let panYTarget: 'combined' | 'multiAll' | string | null = null;
      let initYMin = 0;
      let initYMax = 100;
      const initialMultiY: Record<string, SeriesBounds> = {};

      if (scopeMode === 'split' && entries.length === 1) {
        const single = entries[0];
        if (!single.autoScale || ev.altKey) {
          panYTarget = single.key;
          const b = lastRenderedBoundsRef.current.perSeriesBounds.get(single.key) ?? {
            yMin: -1,
            yMax: 1,
          };
          initYMin = b.yMin;
          initYMax = b.yMax;
        }
      } else if (scopeMode === 'combined' && yScaleMode === 'multiAxis') {
        if (entries.some((e) => !e.autoScale) || ev.altKey) {
          panYTarget = 'multiAll';
          for (const e of entries) {
            initialMultiY[e.key] = lastRenderedBoundsRef.current.perSeriesBounds.get(
              e.key,
            ) ?? { yMin: -1, yMax: 1 };
          }
        }
      } else if (!vp.combinedYAuto || ev.altKey) {
        panYTarget = 'combined';
        initYMin = lastRenderedBoundsRef.current.combinedBounds.yMin;
        initYMax = lastRenderedBoundsRef.current.combinedBounds.yMax;
      }

      dragRef.current = {
        kind: 'pan',
        startX: x,
        startY: y,
        initialRightSec: tEnd,
        initialSpanSec: span,
        panYTarget,
        initialYMin: initYMin,
        initialYMax: initYMax,
        initialMultiY,
      };
      setCursorCss('grabbing');
    }
  };

  const handlePointerMove = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    localHoverRef.current = { x, y };

    const geom = computeScopeGeometry(
      rect.width,
      rect.height,
      scopeMode,
      yScaleMode,
      entries,
      theme === 'dark',
    );

    const ratio = (x - geom.plotLeft) / geom.plotW;
    if (ratio >= 0 && ratio <= 1) {
      sharedCursorRatioRef.current = ratio;
    } else {
      sharedCursorRatioRef.current = null;
    }

    const activeDrag = dragRef.current;
    if (!activeDrag) {
      updateHoverCursorStyle(x, y, rect.width, rect.height);
      return;
    }

    if (activeDrag.kind === 'pan') {
      const dx = x - activeDrag.startX;
      const dt = -(dx / geom.plotW) * activeDrag.initialSpanSec;
      plotStore.setViewRightTimeSec(activeDrag.initialRightSec + dt, false);

      if (activeDrag.panYTarget) {
        const dy = y - activeDrag.startY;
        const fracY = dy / geom.plotH;
        if (activeDrag.panYTarget === 'multiAll') {
          for (const e of entries) {
            const initB = activeDrag.initialMultiY[e.key];
            if (!initB) continue;
            const dVal = fracY * (initB.yMax - initB.yMin);
            plotStore.setScopeManualY(e.key, initB.yMin + dVal, initB.yMax + dVal, {
              emit: false,
            });
          }
        } else {
          const dVal = fracY * (activeDrag.initialYMax - activeDrag.initialYMin);
          plotStore.setScopeManualY(
            activeDrag.panYTarget,
            activeDrag.initialYMin + dVal,
            activeDrag.initialYMax + dVal,
            { emit: false },
          );
        }
      }
      return;
    }

    if (activeDrag.kind === 'axisPanY') {
      const dy = y - activeDrag.startY;
      const dVal = (dy / geom.plotH) * (activeDrag.initialYMax - activeDrag.initialYMin);
      plotStore.setScopeManualY(
        activeDrag.targetKey,
        activeDrag.initialYMin + dVal,
        activeDrag.initialYMax + dVal,
        { emit: false },
      );
      return;
    }

    if (activeDrag.kind === 'axisPanX') {
      const dx = x - activeDrag.startX;
      const dt = -(dx / geom.plotW) * activeDrag.initialSpanSec;
      plotStore.setViewRightTimeSec(activeDrag.initialRightSec + dt, false);
      return;
    }

    if (activeDrag.kind === 'boxZoom') {
      activeDrag.curX = x;
      activeDrag.curY = y;
      return;
    }

    if (activeDrag.kind === 'cursor') {
      const { tStart, span } = plotStore.getEffectiveTimeWindow();
      const clampedRatio = Math.max(0, Math.min(1, (x - geom.plotLeft) / geom.plotW));
      plotStore.setDeltaCursorTime(activeDrag.which, tStart + clampedRatio * span, false);
    }
  };

  const handlePointerUp = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    const activeDrag = dragRef.current;
    if (!activeDrag) return;
    dragRef.current = null;

    if (ev.currentTarget.hasPointerCapture(ev.pointerId)) {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    }

    const rect = ev.currentTarget.getBoundingClientRect();
    const geom = computeScopeGeometry(
      rect.width,
      rect.height,
      scopeMode,
      yScaleMode,
      entries,
      theme === 'dark',
    );

    if (activeDrag.kind === 'boxZoom') {
      const bx0 = Math.max(geom.plotLeft, Math.min(geom.plotRight, activeDrag.startX));
      const bx1 = Math.max(geom.plotLeft, Math.min(geom.plotRight, activeDrag.curX));
      const by0 = Math.max(PAD_TOP, Math.min(PAD_TOP + geom.plotH, activeDrag.startY));
      const by1 = Math.max(PAD_TOP, Math.min(PAD_TOP + geom.plotH, activeDrag.curY));

      if (Math.abs(bx1 - bx0) >= 6) {
        const { tStart, span } = plotStore.getEffectiveTimeWindow();
        const r0 = (Math.min(bx0, bx1) - geom.plotLeft) / geom.plotW;
        const r1 = (Math.max(bx0, bx1) - geom.plotLeft) / geom.plotW;
        const nextTStart = tStart + r0 * span;
        const nextTEnd = tStart + r1 * span;

        plotStore.setTimeRange(nextTStart, nextTEnd, true, false);

        // 2D XY Box Zoom when vertical drag >= 12px (otherwise 1D Horizontal Time Range Zoom!)
        if (Math.abs(by1 - by0) >= 12) {
          const normTop = 1 - (Math.min(by0, by1) - PAD_TOP) / geom.plotH;
          const normBot = 1 - (Math.max(by0, by1) - PAD_TOP) / geom.plotH;

          if (scopeMode === 'split' && entries.length === 1) {
            const b = lastRenderedBoundsRef.current.perSeriesBounds.get(entries[0].key) ?? {
              yMin: -1,
              yMax: 1,
            };
            const ySpan = b.yMax - b.yMin;
            plotStore.setScopeManualY(
              entries[0].key,
              b.yMin + normBot * ySpan,
              b.yMin + normTop * ySpan,
              { emit: false },
            );
          } else if (scopeMode === 'combined' && yScaleMode === 'multiAxis') {
            plotStore.applyProportionalYWindowToVisibleSeries(normBot, normTop, {
              emit: false,
            });
          } else {
            const b = lastRenderedBoundsRef.current.combinedBounds;
            const ySpan = b.yMax - b.yMin;
            plotStore.setScopeManualY(
              'combined',
              b.yMin + normBot * ySpan,
              b.yMin + normTop * ySpan,
              { emit: false },
            );
          }
        }
      }
    }

    plotStore.notifyInteractionEnd();
    updateHoverCursorStyle(
      ev.clientX - rect.left,
      ev.clientY - rect.top,
      rect.width,
      rect.height,
    );
  };

  const handleDoubleClick = (ev: React.MouseEvent<HTMLCanvasElement>): void => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const geom = computeScopeGeometry(
      rect.width,
      rect.height,
      scopeMode,
      yScaleMode,
      entries,
      theme === 'dark',
    );

    const hitStrip = findHitAxisStrip(x, y, geom);
    if (hitStrip) {
      plotStore.resetScopeAutoY(hitStrip.targetKey);
      return;
    }

    if (y > PAD_TOP + geom.plotH) {
      plotStore.setLiveFollow(true);
      return;
    }

    plotStore.resetFullView();
  };

  return (
    <div
      ref={wrapperRef}
      style={{ borderColor: 'var(--border-strong)' }}
      className="w-full h-full border overflow-hidden relative"
    >
      <canvas
        ref={canvasRef}
        style={{ cursor: cursorCss }}
        tabIndex={0}
        onContextMenu={contextMenu.onContextMenu}
        onPointerDown={(event) => { if (contextMenu.start(event)) handlePointerDown(event); }}
        onPointerMove={(event) => { contextMenu.move(event); handlePointerMove(event); }}
        onPointerUp={(event) => { handlePointerUp(event); contextMenu.finish(event); }}
        onPointerCancel={(event) => { handlePointerUp(event); contextMenu.finish(event); }}
        onDoubleClick={handleDoubleClick}
        onPointerLeave={() => {
          localHoverRef.current = null;
          sharedCursorRatioRef.current = null;
        }}
        className="block w-full h-full"
      />
    </div>
  );
};

// ============================================================================
// 40px Interactive Timeline Overview Minimap & Range Scrollbar
// ============================================================================

type MinimapDragState =
  | {
      mode: 'move';
      startX: number;
      initTStart: number;
      initTEnd: number;
      fullMin: number;
      fullSpan: number;
    }
  | {
      mode: 'leftEdge' | 'rightEdge';
      initTStart: number;
      initTEnd: number;
      fullMin: number;
      fullSpan: number;
    };

const MINIMAP_PAD_X = 8;

const TimelineMinimap: React.FC<{
  entries: readonly PlotSeriesEntry[];
  theme: 'dark' | 'light';
}> = ({ entries, theme }) => {
  const { t } = useI18n();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const widthRef = useRef<number>(800);
  const dragRef = useRef<MinimapDragState | null>(null);
  const [cursorStyle, setCursorStyle] = useState<string>('pointer');

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const update = (): void => {
      widthRef.current = Math.max(120, el.clientWidth);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Non-passive wheel on Minimap for rapid X span zoom
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (ev: WheelEvent): void => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.deltaY === 0) return;
      const factor = ev.deltaY < 0 ? 0.8 : 1.25;
      plotStore.zoomTimeAtRatio(factor, plotStore.getViewport().liveFollow ? 1 : 0.5, true);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const getFullHistoryRange = useCallback((): { fullMin: number; fullMax: number; fullSpan: number } => {
    const { minTimeSec, maxTimeSec } = plotStore.getTimeBounds();
    const { tStart, tEnd, span } = plotStore.getEffectiveTimeWindow();
    const fullMin = Math.min(minTimeSec, tStart);
    const rawMax = Math.max(maxTimeSec, tEnd);
    const fullSpan = Math.max(span, rawMax - fullMin, 1);
    const fullMax = fullMin + fullSpan;
    return { fullMin, fullMax, fullSpan };
  }, []);

  useEffect(() => {
    let rafId = 0;
    let active = true;

    const drawMinimap = (): void => {
      if (!active) return;
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const w = widthRef.current;
          const h = 40;
          const dpr = window.devicePixelRatio || 1;
          if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
            canvas.width = Math.floor(w * dpr);
            canvas.height = Math.floor(h * dpr);
          }
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

          const isDark = theme === 'dark';
          ctx.fillStyle = isDark ? '#111418' : '#ECEFF4';
          ctx.fillRect(0, 0, w, h);

          const trackW = Math.max(20, w - MINIMAP_PAD_X * 2);
          const { fullMin, fullMax, fullSpan } = getFullHistoryRange();
          const { tStart, tEnd } = plotStore.getEffectiveTimeWindow();

          // Mini waveforms across full 300s history using sticky Y bounds & column envelope
          for (let sIdx = 0; sIdx < entries.length; sIdx++) {
            const entry = entries[sIdx];
            const count = entry.count;
            if (count < 2) continue;

            const yMin = entry.stickyAutoYMin;
            const yMax = entry.stickyAutoYMax > yMin ? entry.stickyAutoYMax : yMin + 1;
            const ySpan = Math.max(1e-6, yMax - yMin);
            const startPos =
              (entry.writePos - count + PLOT_RING_CAPACITY) % PLOT_RING_CAPACITY;

            ctx.save();
            ctx.strokeStyle = entry.colorHex;
            ctx.globalAlpha = 0.65;
            ctx.lineWidth = 1;
            ctx.beginPath();
            let started = false;

            if (count <= trackW * 2) {
              for (let i = 0; i < count; i++) {
                const rIdx = (startPos + i) % PLOT_RING_CAPACITY;
                const t = entry.timestamps[rIdx];
                const v = entry.values[rIdx];
                const x = MINIMAP_PAD_X + ((t - fullMin) / fullSpan) * trackW;
                const y = 4 + (1 - (v - yMin) / ySpan) * (h - 10);
                if (!started) {
                  ctx.moveTo(x, y);
                  started = true;
                } else {
                  ctx.lineTo(x, y);
                }
              }
            } else {
              let curCol = -999999;
              let minY = 0;
              let maxY = 0;
              let firstY = 0;
              let lastY = 0;

              const flushMiniCol = (col: number): void => {
                const xCol = MINIMAP_PAD_X + col + 0.5;
                if (!started) {
                  ctx.moveTo(xCol, firstY);
                  started = true;
                } else {
                  ctx.lineTo(xCol, firstY);
                }
                if (minY !== firstY || maxY !== firstY) {
                  ctx.lineTo(xCol, minY);
                  ctx.lineTo(xCol, maxY);
                }
                if (lastY !== maxY) {
                  ctx.lineTo(xCol, lastY);
                }
              };

              for (let i = 0; i < count; i++) {
                const rIdx = (startPos + i) % PLOT_RING_CAPACITY;
                const t = entry.timestamps[rIdx];
                const v = entry.values[rIdx];
                const col = Math.floor(((t - fullMin) / fullSpan) * trackW);
                const y = 4 + (1 - (v - yMin) / ySpan) * (h - 10);
                if (col !== curCol) {
                  if (curCol !== -999999) flushMiniCol(curCol);
                  curCol = col;
                  firstY = y;
                  minY = y;
                  maxY = y;
                  lastY = y;
                } else {
                  if (y < minY) minY = y;
                  if (y > maxY) maxY = y;
                  lastY = y;
                }
              }
              if (curCol !== -999999) flushMiniCol(curCol);
            }
            ctx.stroke();
            ctx.restore();
          }

          // Active Viewport Window Box & Dimmed Masks
          const winX0 =
            MINIMAP_PAD_X +
            Math.max(0, Math.min(1, (tStart - fullMin) / fullSpan)) * trackW;
          const winX1 =
            MINIMAP_PAD_X +
            Math.max(0, Math.min(1, (tEnd - fullMin) / fullSpan)) * trackW;
          const boxLeft = Math.min(winX0, winX1);
          const boxW = Math.max(10, Math.abs(winX1 - winX0));

          ctx.fillStyle = isDark ? 'rgba(0, 0, 0, 0.50)' : 'rgba(148, 163, 184, 0.30)';
          if (boxLeft > MINIMAP_PAD_X) {
            ctx.fillRect(MINIMAP_PAD_X, 0, boxLeft - MINIMAP_PAD_X, h);
          }
          if (boxLeft + boxW < MINIMAP_PAD_X + trackW) {
            ctx.fillRect(
              boxLeft + boxW,
              0,
              MINIMAP_PAD_X + trackW - (boxLeft + boxW),
              h,
            );
          }

          const isFollowing = plotStore.getViewport().liveFollow;
          const frameColor = isFollowing ? '#10B981' : '#0EA5E9';

          ctx.fillStyle = isFollowing
            ? 'rgba(16, 185, 129, 0.10)'
            : 'rgba(14, 165, 233, 0.12)';
          ctx.fillRect(boxLeft, 1, boxW, h - 2);

          ctx.strokeStyle = frameColor;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(boxLeft + 0.5, 1.5, boxW - 1, h - 3);

          // Left & Right Edge Resize Grips
          ctx.fillStyle = frameColor;
          ctx.fillRect(boxLeft, 9, 4, h - 18);
          ctx.fillRect(boxLeft + boxW - 4, 9, 4, h - 18);

          // Full History End Labels
          ctx.font = '9.5px Consolas, "JetBrains Mono", monospace';
          ctx.fillStyle = isDark ? '#94A3B8' : '#475569';
          ctx.textBaseline = 'bottom';
          ctx.textAlign = 'left';
          ctx.fillText(`${fullMin.toFixed(1)}s`, MINIMAP_PAD_X + 2, h - 2);
          ctx.textAlign = 'right';
          ctx.fillText(`${fullMax.toFixed(1)}s`, MINIMAP_PAD_X + trackW - 2, h - 2);
        }
      }

      rafId = window.requestAnimationFrame(drawMinimap);
    };

    rafId = window.requestAnimationFrame(drawMinimap);
    return () => {
      active = false;
      window.cancelAnimationFrame(rafId);
    };
  }, [entries, theme, getFullHistoryRange]);

  const handlePointerDown = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    if (ev.button !== 0) return;
    const canvas = ev.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const trackW = Math.max(20, rect.width - MINIMAP_PAD_X * 2);
    const { fullMin, fullSpan } = getFullHistoryRange();
    const { tStart, tEnd, span } = plotStore.getEffectiveTimeWindow();

    const winX0 =
      MINIMAP_PAD_X + Math.max(0, Math.min(1, (tStart - fullMin) / fullSpan)) * trackW;
    const winX1 =
      MINIMAP_PAD_X + Math.max(0, Math.min(1, (tEnd - fullMin) / fullSpan)) * trackW;
    const boxLeft = Math.min(winX0, winX1);
    const boxRight = Math.max(boxLeft + 10, Math.max(winX0, winX1));

    canvas.setPointerCapture(ev.pointerId);
    plotStore.pushZoomHistory();

    if (Math.abs(x - boxLeft) <= 7) {
      dragRef.current = {
        mode: 'leftEdge',
        initTStart: tStart,
        initTEnd: tEnd,
        fullMin,
        fullSpan,
      };
      setCursorStyle('ew-resize');
      return;
    }

    if (Math.abs(x - boxRight) <= 7) {
      dragRef.current = {
        mode: 'rightEdge',
        initTStart: tStart,
        initTEnd: tEnd,
        fullMin,
        fullSpan,
      };
      setCursorStyle('ew-resize');
      return;
    }

    if (x >= boxLeft && x <= boxRight) {
      dragRef.current = {
        mode: 'move',
        startX: x,
        initTStart: tStart,
        initTEnd: tEnd,
        fullMin,
        fullSpan,
      };
      setCursorStyle('grabbing');
      return;
    }

    // Clicked outside current window -> jump center to clicked timestamp & begin scrubbing!
    const clickRatio = Math.max(0, Math.min(1, (x - MINIMAP_PAD_X) / trackW));
    const clickedT = fullMin + clickRatio * fullSpan;
    const jumpedRight = clickedT + span / 2;
    plotStore.setViewRightTimeSec(jumpedRight, true);
    const afterJump = plotStore.getEffectiveTimeWindow();
    dragRef.current = {
      mode: 'move',
      startX: x,
      initTStart: afterJump.tStart,
      initTEnd: afterJump.tEnd,
      fullMin,
      fullSpan,
    };
    setCursorStyle('grabbing');
  };

  const handlePointerMove = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const trackW = Math.max(20, rect.width - MINIMAP_PAD_X * 2);

    const st = dragRef.current;
    if (!st) {
      const { fullMin, fullSpan } = getFullHistoryRange();
      const { tStart, tEnd } = plotStore.getEffectiveTimeWindow();
      const boxLeft =
        MINIMAP_PAD_X + Math.max(0, Math.min(1, (tStart - fullMin) / fullSpan)) * trackW;
      const boxRight = Math.max(
        boxLeft + 10,
        MINIMAP_PAD_X + Math.max(0, Math.min(1, (tEnd - fullMin) / fullSpan)) * trackW,
      );
      if (Math.abs(x - boxLeft) <= 7 || Math.abs(x - boxRight) <= 7) {
        setCursorStyle('ew-resize');
      } else if (x >= boxLeft && x <= boxRight) {
        setCursorStyle('grab');
      } else {
        setCursorStyle('pointer');
      }
      return;
    }

    if (st.mode === 'move') {
      const dt = ((x - st.startX) / trackW) * st.fullSpan;
      plotStore.setViewRightTimeSec(st.initTEnd + dt, false);
      return;
    }

    const hoverT =
      st.fullMin + Math.max(0, Math.min(1, (x - MINIMAP_PAD_X) / trackW)) * st.fullSpan;
    if (st.mode === 'leftEdge') {
      const clampedStart = Math.min(
        st.initTEnd - PLOT_MIN_SPAN_SEC,
        Math.max(st.initTEnd - PLOT_MAX_SPAN_SEC, hoverT),
      );
      plotStore.setTimeRange(clampedStart, st.initTEnd, false, false);
    } else {
      const clampedEnd = Math.max(
        st.initTStart + PLOT_MIN_SPAN_SEC,
        Math.min(st.initTStart + PLOT_MAX_SPAN_SEC, hoverT),
      );
      plotStore.setTimeRange(st.initTStart, clampedEnd, false, false);
    }
  };

  const handlePointerUp = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (ev.currentTarget.hasPointerCapture(ev.pointerId)) {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    }
    plotStore.notifyInteractionEnd();
    setCursorStyle('grab');
  };

  return (
    <div
      ref={wrapperRef}
      style={{ borderColor: 'var(--border-strong)' }}
      className="h-[40px] w-full border overflow-hidden"
      title={t('plotter.minimap.title')}
    >
      <canvas
        ref={canvasRef}
        style={{ cursor: cursorStyle }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={() => plotStore.setLiveFollow(true)}
        className="block w-full h-full"
      />
    </div>
  );
};

/**
 * Reusable compact 1-click `Plot (+ / ✓)` button for ReceiveTransmitView, TraceView, and BitLayoutMatrix.
 * When `hoverReveal` is true, unplotted buttons remain hidden until the parent `group` row is hovered;
 * plotted (`Plot✓`) badges remain subtly visible so active oscilloscope channels are always identifiable.
 */
export const QuickPlotButton: React.FC<{
  busId: number;
  signalId: number;
  onToggle: () => void;
  hoverReveal?: boolean;
}> = ({ busId, signalId, onToggle, hoverReveal = false }) => {
  const { t } = useI18n();
  const plotState = usePlotStore();
  const isPlotted = plotState.plottedKeys.has(makePlotSeriesKey(busId, signalId));

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      style={{
        backgroundColor: isPlotted ? 'rgba(63, 185, 128, 0.14)' : 'var(--bg-toolbar)',
        borderColor: isPlotted ? 'rgba(63, 185, 128, 0.6)' : 'var(--border-grid)',
        color: isPlotted ? '#3FB980' : 'var(--text-secondary)',
      }}
      className={`h-[16px] px-1 border text-[9px] font-mono inline-flex items-center gap-0.5 hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer shrink-0 ${
        !isPlotted && hoverReveal
          ? 'opacity-0 group-hover:opacity-100 focus:opacity-100'
          : 'opacity-100'
      }`}
      title={
        isPlotted
          ? t('plotter.quickPlot.removeTitle')
          : t('plotter.quickPlot.addTitle')
      }
    >
      {!isPlotted && <Plus className="w-2.5 h-2.5" />}
      <span>{isPlotted ? t('plotter.quickPlot.plotted') : t('plotter.quickPlot.plot')}</span>
    </button>
  );
};
