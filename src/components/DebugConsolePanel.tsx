import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpToLine,
  Check,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  Maximize2,
  PanelBottom,
  PanelRight,
  Pin,
  PinOff,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useI18n } from '../i18n';
import type {
  DebugCategory,
  DebugSeverity,
} from '../types/hal';
import {
  apiExportDebugEvents,
  apiSetDebugWindowOpen,
} from '../services/ipcClient';
import {
  debugConsoleStore,
  useDebugConsoleStore,
} from '../store/debugConsoleStore';

export interface DebugConsolePanelProps {
  mode?: 'inline' | 'detached';
  onClose?: () => void;
}

const CATEGORIES: readonly (DebugCategory | 'ALL')[] = [
  'ALL',
  'CONN',
  'SAFETY',
  'TX',
  'NETDB',
  'TRACE',
  'BUS_ERR',
  'DIAG',
  'WORKBENCH',
  'RE',
];

/** Newest-first display cap; the store keeps up to 5000, DOM keeps the newest N. */
const RENDER_CAP = 1000;
/** Approximate row pitch (26px row + 1px divider) used only to pick a scroll anchor. */
const ROW_PITCH_PX = 27;

function formatTime(timestampMs: number): string {
  const d = new Date(timestampMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const mmm = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${mmm}`;
}

const BADGE_CRIT =
  'text-[var(--status-critical)] bg-[var(--status-critical-bg)] border border-[var(--status-critical-border)]';
const BADGE_WARN =
  'text-[var(--status-warn)] bg-[var(--status-warn-bg)] border border-[var(--status-warn-border)]';
const BADGE_OK =
  'text-[var(--status-nominal)] bg-[var(--status-nominal-bg)] border border-[var(--status-nominal-border)]';
const BADGE_NEUTRAL =
  'text-[var(--tag-cc-text)] bg-[var(--tag-cc-bg)] border border-[var(--tag-cc-border)]';

function getSeverityBadge(severity: DebugSeverity): {
  label: string;
  className: string;
} {
  switch (severity) {
    case 'info':
      return { label: 'INFO', className: BADGE_NEUTRAL };
    case 'success':
      return { label: 'OK', className: BADGE_OK };
    case 'warn':
      return { label: 'WARN', className: BADGE_WARN };
    case 'error':
      return { label: 'ERR', className: `${BADGE_CRIT} font-semibold` };
    case 'safety':
      return { label: 'SAFETY', className: `${BADGE_CRIT} font-bold` };
  }
}

/** Category badges are neutral; only the safety-relevant ones carry status colour. */
function getCategoryColor(cat: DebugCategory): string {
  switch (cat) {
    case 'SAFETY':
    case 'BUS_ERR':
      return `${BADGE_CRIT} font-semibold`;
    default:
      return BADGE_NEUTRAL;
  }
}

export const DebugConsolePanel: React.FC<DebugConsolePanelProps> = ({
  mode = 'inline',
  onClose,
}) => {
  const { t } = useI18n();
  const {
    events,
    dockLayout,
    alwaysOnTop,
    sessionLogPath,
  } = useDebugConsoleStore();

  const [categoryFilter, setCategoryFilter] = useState<DebugCategory | 'ALL'>('ALL');
  const [severityFilter, setSeverityFilter] = useState<'all' | 'warnErr' | 'errOnly'>('all');
  const [busFilter, setBusFilter] = useState<'all' | 'sys' | number>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState<boolean>(false);
  const [copiedState, setCopiedState] = useState<boolean>(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Scroll anchor (row seq + its viewport offset) used to keep the visible
  // content stationary when newer rows are prepended while follow is paused.
  const anchorRef = useRef<{ seq: number; offset: number } | null>(null);

  // Available buses present in events
  const presentBusIds = useMemo(() => {
    const set = new Set<number>();
    for (const ev of events) {
      if (ev.busId !== null) {
        set.add(ev.busId);
      }
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [events]);

  // Filtered event list
  const filteredEvents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return events.filter((ev) => {
      if (categoryFilter !== 'ALL' && ev.category !== categoryFilter) {
        return false;
      }
      if (severityFilter === 'warnErr' && (ev.severity === 'info' || ev.severity === 'success')) {
        return false;
      }
      if (severityFilter === 'errOnly' && ev.severity !== 'error' && ev.severity !== 'safety') {
        return false;
      }
      if (busFilter === 'sys' && ev.busId !== null) {
        return false;
      }
      if (typeof busFilter === 'number' && ev.busId !== busFilter) {
        return false;
      }
      if (q) {
        const inTitle = ev.title.toLowerCase().includes(q);
        const inAction = ev.action.toLowerCase().includes(q);
        const inDetails = ev.details?.toLowerCase().includes(q) ?? false;
        if (!inTitle && !inAction && !inDetails) {
          return false;
        }
      }
      return true;
    });
  }, [events, categoryFilter, severityFilter, busFilter, searchQuery]);

  // Selected event object
  const selectedEvent = useMemo(() => {
    if (selectedSeq === null) return null;
    return events.find((e) => e.seq === selectedSeq) ?? null;
  }, [events, selectedSeq]);

  // Newest-first view: reverse index math, capped, store array untouched.
  const rows = useMemo(() => {
    const n = filteredEvents.length;
    const count = Math.min(n, RENDER_CAP);
    const out = new Array<(typeof filteredEvents)[number]>(count);
    for (let i = 0; i < count; i++) {
      out[i] = filteredEvents[n - 1 - i];
    }
    return out;
  }, [filteredEvents]);

  // Follow = pinned to top (newest). Otherwise preserve the viewport anchor.
  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (autoScroll) {
      el.scrollTop = 0;
      return;
    }
    const anchor = anchorRef.current;
    if (!anchor || el.scrollTop <= 0) return;
    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i] as HTMLElement;
      if (child.dataset.seq === String(anchor.seq)) {
        el.scrollTop = child.offsetTop - anchor.offset;
        return;
      }
    }
  }, [rows, autoScroll]);

  const handleScroll = (): void => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (el.scrollTop > 4 && autoScroll) {
      setAutoScroll(false);
    }
    const idx = Math.min(rows.length - 1, Math.floor(el.scrollTop / ROW_PITCH_PX));
    const child = idx >= 0 ? (el.children[idx] as HTMLElement | undefined) : undefined;
    if (child && child.dataset.seq !== undefined) {
      anchorRef.current = {
        seq: Number(child.dataset.seq),
        offset: child.offsetTop - el.scrollTop,
      };
    } else {
      anchorRef.current = null;
    }
  };

  const handleCopyFilteredLog = useCallback(async (): Promise<void> => {
    const text = filteredEvents
      .map(
        (e) =>
          `[${formatTime(e.timestampMs)}] [${e.severity.toUpperCase().padEnd(6)}] [${e.category.padEnd(8)}] [${
            e.busId !== null ? `Bus ${e.busId + 1}` : 'SYS  '
          }] ${e.action}: ${e.title}${e.repeatCount > 1 ? ` (x${e.repeatCount})` : ''}${
            e.details ? `\n  ${e.details}` : ''
          }`,
      )
      .join('\n');

    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopiedState(true);
        setTimeout(() => setCopiedState(false), 2000);
      }
    } catch {
      // clipboard access denied
    }
  }, [filteredEvents]);

  const handleExportDownload = async (
    format: 'jsonl' | 'log' | 'csv',
  ): Promise<void> => {
    setExportOpen(false);
    try {
      const content = await apiExportDebugEvents(format);
      const mime =
        format === 'jsonl'
          ? 'application/x-ndjson'
          : format === 'csv'
            ? 'text/csv'
            : 'text/plain';
      const blob = new Blob([content], { type: `${mime};charset=utf-8` });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nexuscan-debug-${Date.now()}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn('[DebugConsolePanel] export error:', err);
    }
  };

  const handleClear = (): void => {
    if (window.confirm(t('debug.console.clearConfirm'))) {
      debugConsoleStore.clearEvents();
      setSelectedSeq(null);
    }
  };

  const handleTearOffWindow = async (): Promise<void> => {
    try {
      await apiSetDebugWindowOpen(true);
      if (mode === 'inline') {
        debugConsoleStore.setDockOpen(false);
      }
    } catch (err) {
      console.warn('[DebugConsolePanel] failed to undock:', err);
    }
  };

  const handleDockBack = async (): Promise<void> => {
    try {
      await apiSetDebugWindowOpen(false, false, true);
    } catch (err) {
      console.warn('[DebugConsolePanel] failed to dock back:', err);
    }
  };

  const handleToggleAlwaysOnTop = async (): Promise<void> => {
    try {
      const next = !alwaysOnTop;
      debugConsoleStore.setAlwaysOnTop(next);
      await apiSetDebugWindowOpen(true, next, false);
    } catch (err) {
      console.warn('[DebugConsolePanel] always-on-top toggle error:', err);
    }
  };

  return (
    <div
      style={{
        backgroundColor: 'var(--bg-panel)',
        color: 'var(--text-primary)',
        borderTopColor: 'var(--border-grid)',
      }}
      className="@container flex-1 flex flex-col min-h-0 min-w-0 h-full overflow-hidden font-mono text-[11px] select-none border-t"
    >
      {/* ─── Header Row 1: identity (shrinks) + dock controls (pinned, never clipped) ─── */}
      <div className="shrink-0 min-h-[30px] px-2 py-1 bg-[var(--bg-header)] border-b border-[var(--border-grid)] flex items-center gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
          <div className="flex items-center gap-1.5 text-[var(--text-secondary)] font-semibold tracking-wider uppercase text-[11px] min-w-0 truncate">
            <span className="truncate">{t('debug.console.title')}</span>
          </div>

                    {/* Event count badge */}
          <span
            className="shrink-0 px-1.5 py-0.5 rounded-xs bg-[var(--bg-input)] border border-[var(--border-grid)] text-[10px] text-[var(--text-secondary)] tabular-nums"
            title={sessionLogPath ?? undefined}
          >
            {t('debug.console.totalEvents', { count: filteredEvents.length })}
            {events.length !== filteredEvents.length && ` / ${events.length}`}
          </span>

          {/* Session log indicator if active */}
          {sessionLogPath && (
            <span
              className="px-1.5 py-0.5 rounded-xs bg-[var(--status-nominal-bg)] border border-[var(--status-nominal-border)] text-[10px] text-[var(--status-nominal)] truncate max-w-[120px] @[520px]:max-w-[200px] hidden @[420px]:inline"
              title={sessionLogPath}
            >
              LOG: {sessionLogPath.split(/[/\\]/).pop()}
            </span>
          )}

        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Docking & Tear-Off Controls */}
          {mode === 'inline' ? (
            <>
              <button
                type="button"
                onClick={() => debugConsoleStore.setDockLayout('bottom')}
                className={`p-1 rounded-xs border cursor-pointer ${
                  dockLayout === 'bottom'
                    ? 'bg-[var(--status-focus-bg)] border-[var(--status-focus-border)] text-[var(--status-focus)]'
                    : 'bg-[var(--bg-input)] border-[var(--border-grid)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)]'
                }`}
                title={t('debug.console.layoutBottom')}
              >
                <PanelBottom className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => debugConsoleStore.setDockLayout('right')}
                className={`p-1 rounded-xs border cursor-pointer ${
                  dockLayout === 'right'
                    ? 'bg-[var(--status-focus-bg)] border-[var(--status-focus-border)] text-[var(--status-focus)]'
                    : 'bg-[var(--bg-input)] border-[var(--border-grid)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)]'
                }`}
                title={t('debug.console.layoutRight')}
              >
                <PanelRight className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => debugConsoleStore.setDockLayout('floating')}
                className={`p-1 rounded-xs border cursor-pointer ${
                  dockLayout === 'floating'
                    ? 'bg-[var(--status-focus-bg)] border-[var(--status-focus-border)] text-[var(--status-focus)]'
                    : 'bg-[var(--bg-input)] border-[var(--border-grid)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)]'
                }`}
                title={t('debug.console.layoutFloating')}
              >
                <Maximize2 className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => void handleTearOffWindow()}
                className="h-[24px] px-2 text-[10px] bg-[var(--status-focus-bg)] border border-[var(--status-focus-border)] text-[var(--status-focus)] hover:bg-[var(--bg-row-hover)] rounded-xs flex items-center gap-1 cursor-pointer"
                title={t('debug.console.undock')}
              >
                <ExternalLink className="w-3 h-3" />
                <span className="hidden @[520px]:inline">{t('debug.console.undock')}</span>
              </button>
              <button
                type="button"
                onClick={onClose ?? (() => debugConsoleStore.setDockOpen(false))}
                className="h-[24px] px-1.5 text-[10px] bg-[var(--bg-input)] border border-[var(--border-grid)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded-xs flex items-center cursor-pointer"
                title={t('debug.console.close')}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </>
          ) : (
            <>
              {/* Detached External Window Controls */}
              <button
                type="button"
                onClick={() => void handleToggleAlwaysOnTop()}
                className={`h-[24px] px-2 text-[10px] border rounded-xs flex items-center gap-1 cursor-pointer ${
                  alwaysOnTop
                    ? 'bg-[var(--status-warn-bg)] border-[var(--status-warn-border)] text-[var(--status-warn)] font-semibold'
                    : 'bg-[var(--bg-input)] border-[var(--border-grid)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)]'
                }`}
                title={t('debug.console.alwaysOnTop')}
              >
                {alwaysOnTop ? <Pin className="w-3 h-3" /> : <PinOff className="w-3 h-3" />}
                <span className="hidden @[520px]:inline">{t('debug.console.alwaysOnTop')}</span>
              </button>
              <button
                type="button"
                onClick={() => void handleDockBack()}
                className="h-[24px] px-2 text-[10px] bg-[var(--status-focus-bg)] border border-[var(--status-focus-border)] text-[var(--status-focus)] hover:bg-[var(--bg-row-hover)] rounded-xs flex items-center gap-1 cursor-pointer"
                title={t('debug.console.dockBack')}
              >
                <RotateCcw className="w-3 h-3" />
                <span className="hidden @[520px]:inline">{t('debug.console.dockBack')}</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* ─── Header Row 2: filters & actions (wrap at narrow widths) ─────────── */}
      <div className="shrink-0 px-2 py-1 bg-[var(--bg-toolbar)] border-b border-[var(--border-grid)] flex items-center gap-x-2 gap-y-1 flex-wrap min-w-0">
          {/* Category Filter Pills */}
          <div className="flex items-center gap-1 flex-wrap min-w-0">
            {CATEGORIES.map((cat) => {
              const active = categoryFilter === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategoryFilter(cat)}
                  className={`px-1.5 py-0.5 rounded-xs text-[10px] border font-mono transition-colors cursor-pointer ${
                    active
                      ? 'bg-[var(--status-focus-bg)] border-[var(--status-focus-border)] text-[var(--status-focus)] font-bold'
                      : 'bg-[var(--bg-input)] border-[var(--border-grid)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)]'
                  }`}
                >
                  {cat === 'ALL' ? t('debug.console.allCategories') : cat}
                </button>
              );
            })}
          </div>
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          {/* Severity filter */}
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value as 'all' | 'warnErr' | 'errOnly')}
            aria-label={t('debug.console.colLevel')}
            className="h-[24px] px-1.5 text-[10px] bg-[var(--bg-input)] border border-[var(--border-grid)] text-[var(--text-primary)] rounded-xs focus:outline-none focus:border-[var(--status-focus)] cursor-pointer"
          >
            <option value="all">{t('debug.console.level.all')}</option>
            <option value="warnErr">{t('debug.console.level.warnErr')}</option>
            <option value="errOnly">{t('debug.console.level.errOnly')}</option>
          </select>

          {/* Bus Filter */}
          <select
            value={typeof busFilter === 'number' ? String(busFilter) : busFilter}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'all' || v === 'sys') {
                setBusFilter(v);
              } else {
                setBusFilter(Number(v));
              }
            }}
            aria-label={t('debug.console.colBus')}
            className="h-[24px] px-1.5 text-[10px] bg-[var(--bg-input)] border border-[var(--border-grid)] text-[var(--text-primary)] rounded-xs focus:outline-none focus:border-[var(--status-focus)] cursor-pointer"
          >
            <option value="all">{t('debug.console.bus.all')}</option>
            <option value="sys">{t('debug.console.bus.sys')}</option>
            {presentBusIds.map((b) => (
              <option key={b} value={String(b)}>
                {t('debug.console.bus.num', { num: b + 1 })}
              </option>
            ))}
          </select>

          {/* Search Input */}
          <div className="relative flex items-center flex-1 min-w-[96px] max-w-[220px]">
            <Search className="w-3 h-3 absolute left-1.5 text-[var(--text-muted)] pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('debug.console.searchPlaceholder')}
              className="h-[24px] w-full min-w-[96px] pl-5 pr-5 text-[10px] bg-[var(--bg-input)] border border-[var(--border-grid)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] rounded-xs focus:outline-none focus:border-[var(--status-focus)]"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            )}
          </div>

                    {/* Auto-scroll toggle */}
          <button
            type="button"
            onClick={() => {
              if (autoScroll) {
                setAutoScroll(false);
              } else {
                setAutoScroll(true);
                if (scrollContainerRef.current) {
                  scrollContainerRef.current.scrollTop = 0;
                }
              }
            }}
            className={`h-[24px] px-1.5 text-[10px] border rounded-xs flex items-center gap-1 cursor-pointer transition-colors ${
              autoScroll
                ? 'bg-[var(--status-focus-bg)] border-[var(--status-focus-border)] text-[var(--status-focus)]'
                : 'bg-[var(--status-warn-bg)] border-[var(--status-warn-border)] text-[var(--status-warn)]'
            }`}
            title={autoScroll ? t('debug.console.follow') : t('debug.console.followPaused')}
          >
            <ArrowUpToLine className="w-3 h-3" />
            <span className="hidden @[520px]:inline">{autoScroll ? t('debug.console.follow') : t('debug.console.followPaused')}</span>
          </button>

          {/* Copy Button */}
          <button
            type="button"
            onClick={() => void handleCopyFilteredLog()}
            className="h-[24px] px-2 text-[10px] bg-[var(--bg-input)] border border-[var(--border-grid)] text-[var(--text-primary)] hover:border-[var(--border-strong)] rounded-xs flex items-center gap-1 cursor-pointer"
            title={t('debug.console.copy')}
          >
            {copiedState ? (
              <Check className="w-3 h-3 text-[var(--status-nominal)]" />
            ) : (
              <Copy className="w-3 h-3 text-[var(--text-secondary)]" />
            )}
            <span className="hidden @[520px]:inline">{copiedState ? t('debug.console.copied') : t('debug.console.copy')}</span>
          </button>

          {/* Export Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setExportOpen((v) => !v)}
              className="h-[24px] px-2 text-[10px] bg-[var(--bg-input)] border border-[var(--border-grid)] text-[var(--text-primary)] hover:border-[var(--border-strong)] rounded-xs flex items-center gap-1 cursor-pointer"
              title={t('debug.console.export')}
            >
              <Download className="w-3 h-3 text-[var(--text-secondary)]" />
              <span className="hidden @[520px]:inline">{t('debug.console.export')}</span>
              <ChevronDown className="w-2.5 h-2.5" />
            </button>
            {exportOpen && (
              <div className="absolute right-0 top-[28px] w-32 bg-[var(--bg-panel)] border border-[var(--border-strong)] rounded-xs py-1 z-50">
                <button
                  type="button"
                  onClick={() => void handleExportDownload('log')}
                  className="w-full text-left px-2.5 py-1 text-[10px] text-[var(--text-primary)] hover:bg-[var(--bg-row-hover)] cursor-pointer"
                >
                  Text Log (.log)
                </button>
                <button
                  type="button"
                  onClick={() => void handleExportDownload('jsonl')}
                  className="w-full text-left px-2.5 py-1 text-[10px] text-[var(--text-primary)] hover:bg-[var(--bg-row-hover)] cursor-pointer"
                >
                  JSON Lines (.jsonl)
                </button>
                <button
                  type="button"
                  onClick={() => void handleExportDownload('csv')}
                  className="w-full text-left px-2.5 py-1 text-[10px] text-[var(--text-primary)] hover:bg-[var(--bg-row-hover)] cursor-pointer"
                >
                  Table CSV (.csv)
                </button>
              </div>
            )}
          </div>

          {/* Clear Button */}
          <button
            type="button"
            onClick={handleClear}
            className="h-[24px] px-1.5 text-[10px] bg-[var(--bg-input)] border border-[var(--border-grid)] text-[var(--text-secondary)] hover:text-[var(--status-critical)] hover:border-[var(--status-critical-border)] rounded-xs flex items-center gap-1 cursor-pointer"
            title={t('debug.console.clear')}
          >
            <Trash2 className="w-3 h-3" />
          </button>

        </div>
      </div>

      {/* ─── Table Header ───────────────────────────────────────────────────── */}
      <div className="shrink-0 h-[24px] px-2 bg-[var(--bg-header)] border-b border-[var(--border-grid)] grid grid-cols-[56px_106px_68px_84px_58px_1fr] items-center text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
        <div className="border-r border-[var(--border-grid)] px-1">{t('debug.console.colSeq')}</div>
        <div className="border-r border-[var(--border-grid)] px-1">{t('debug.console.colTime')}</div>
        <div className="border-r border-[var(--border-grid)] px-1 text-center">{t('debug.console.colLevel')}</div>
        <div className="border-r border-[var(--border-grid)] px-1 text-center">{t('debug.console.colCategory')}</div>
        <div className="border-r border-[var(--border-grid)] px-1 text-center">{t('debug.console.colBus')}</div>
        <div className="px-1.5">{t('debug.console.colMessage')}</div>
      </div>

      {/* ─── Virtualized / High-Density 26px Row Stream ────────────────────── */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain divide-y divide-[var(--border-grid)] font-mono tabular-nums text-[11px]"
      >
        {filteredEvents.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-[var(--text-muted)] py-8 px-4 text-center">
            <span className="text-[12px]">{t('debug.console.empty')}</span>
          </div>
        ) : (
          rows.map((ev) => {
            const isSelected = selectedSeq === ev.seq;
            const badge = getSeverityBadge(ev.severity);
            const catClass = getCategoryColor(ev.category);

            return (
              <div
                key={ev.seq}
                data-seq={ev.seq}
                onClick={() => setSelectedSeq((prev) => (prev === ev.seq ? null : ev.seq))}
                style={{ height: '26px' }}
                className={`grid grid-cols-[56px_106px_68px_84px_58px_1fr] items-center px-2 cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-[var(--bg-row-selected)] border-l-2 border-[var(--status-focus)] text-[var(--text-primary)] font-semibold'
                    : ev.severity === 'safety'
                      ? 'bg-[var(--status-critical-bg)] hover:bg-[var(--bg-row-hover)]'
                      : ev.severity === 'error'
                        ? 'bg-[var(--status-critical-bg)] hover:bg-[var(--bg-row-hover)]'
                        : ev.severity === 'warn'
                          ? 'bg-[var(--status-warn-bg)] hover:bg-[var(--bg-row-hover)]'
                          : 'hover:bg-[var(--bg-row-hover)]'
                }`}
              >
                {/* Seq */}
                <div className="text-[var(--text-muted)] border-r border-[var(--border-grid)] px-1 truncate">
                  #{ev.seq}
                </div>

                {/* Time */}
                <div className="text-[var(--text-secondary)] border-r border-[var(--border-grid)] px-1 truncate">
                  {formatTime(ev.timestampMs)}
                </div>

                {/* Level */}
                <div className="border-r border-[var(--border-grid)] px-1 flex items-center justify-center">
                  <span className={`px-1 py-0.2 rounded-xs text-[9px] ${badge.className}`}>
                    {badge.label}
                  </span>
                </div>

                {/* Category */}
                <div className="border-r border-[var(--border-grid)] px-1 flex items-center justify-center">
                  <span className={`px-1 py-0.2 rounded-xs text-[9px] border ${catClass}`}>
                    {ev.category}
                  </span>
                </div>

                {/* Bus */}
                <div className="border-r border-[var(--border-grid)] px-1 text-center text-[var(--text-secondary)] text-[10px] truncate">
                  {ev.busId !== null ? `Bus ${ev.busId + 1}` : 'SYS'}
                </div>

                {/* Action + Title + Repeat Count */}
                <div className="px-1.5 flex items-center gap-1.5 min-w-0 truncate">
                  <span className="text-[var(--text-secondary)] font-medium truncate">
                    <span className="text-[var(--text-secondary)] font-mono">[{ev.action}]</span>{' '}
                    <span className="text-[var(--text-primary)]">{ev.title}</span>
                  </span>

                  {ev.repeatCount > 1 && (
                    <span className="px-1 py-0.2 text-[9px] font-bold rounded-xs bg-[var(--status-warn-bg)] border border-[var(--status-warn-border)] text-[var(--status-warn)]">
                      ×{ev.repeatCount}
                    </span>
                  )}

                  {ev.details && !isSelected && (
                    <span className="text-[var(--text-muted)] text-[10px] truncate font-sans">
                      — {ev.details.replace(/\s+/g, ' ')}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ─── Expandable Details / Inspector Drawer ─────────────────────────── */}
      {selectedEvent && (
        <div className="shrink-0 max-h-56 border-t border-[var(--border-strong)] bg-[var(--bg-header)] flex flex-col p-2.5 overflow-hidden">
          <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-[var(--border-grid)]">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-bold text-[var(--text-secondary)] uppercase tracking-wide text-[10px]">
                {t('debug.console.detailsTitle')} [#{selectedEvent.seq}]
              </span>
              <span className="text-[var(--text-secondary)] font-mono text-[11px]">
                {selectedEvent.action}
              </span>
              <span className="text-[var(--text-muted)] text-[10px]">
                source: {selectedEvent.source} · mono: {selectedEvent.monotonicUs}µs
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      JSON.stringify(selectedEvent, null, 2),
                    );
                    setCopiedState(true);
                    setTimeout(() => setCopiedState(false), 2000);
                  } catch {
                    // ignore
                  }
                }}
                className="h-[22px] px-2 text-[10px] bg-[var(--bg-input)] border border-[var(--border-grid)] text-[var(--text-primary)] hover:border-[var(--border-strong)] rounded-xs flex items-center gap-1 cursor-pointer"
              >
                <Copy className="w-2.5 h-2.5" />
                <span>{copiedState ? t('debug.console.copied') : t('debug.console.copyJson')}</span>
              </button>

              <button
                type="button"
                onClick={() => setSelectedSeq(null)}
                className="h-[22px] px-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                title={t('debug.console.closeDetails')}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto text-[11px] space-y-1 font-mono select-text">
            <div className="text-[var(--text-primary)] font-semibold">{selectedEvent.title}</div>
            {selectedEvent.details ? (
              <pre className="p-1.5 bg-[var(--bg-input)] border border-[var(--border-grid)] rounded-xs text-[var(--text-primary)] whitespace-pre-wrap break-all text-[10.5px]">
                {selectedEvent.details}
              </pre>
            ) : (
              <div className="text-[var(--text-muted)] italic text-[10px]">No extra details attached.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
