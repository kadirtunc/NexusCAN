import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronDown, ChevronUp, Maximize2, Minimize2, PanelRight, Pause, Play, Trash2,
} from 'lucide-react';
import { useI18n } from '../../../i18n';
import { diagnosticsStore, useDiagnosticsSelector } from '../../../store/diagnosticsStore';
import { DIAG_ORIGINS, type DiagOrigin } from '../../../types/udsClient';
import {
  DIAG_BTN_SM, DIAG_BTN_SM_ACTIVE, DIAG_CHECKBOX, DIAG_INPUT, DiagBadge, DiagDemoBadge, diagToneButtonClass,
} from '../diagUi';
import { formatElapsedMs } from '../diagFormat';
import {
  TrafficModel, buildRows, sidName, type TrafficSnapshot, type TrafficViewMode, type Transaction,
} from './trafficModel';
import { compileFilters, type TrafficFilters } from './trafficFilters';
import {
  DOCK_MAX_FRACTION, DOCK_MIN_HEIGHT, loadPrefs, savePrefs, type DockState, type TrafficPrefs,
} from './trafficPrefs';
import { ORIGIN_KEY, STATUS_KEY, STATUS_TONE } from './trafficUi';
import { TrafficTable } from './TrafficTable';
import { TrafficDetail, type ResendDraft } from './TrafficDetail';

const STRIP_H = 28;
const DETAIL_W = 340;

const VIEWS: readonly { id: TrafficViewMode; key: 'diagTraffic.view.transactions' | 'diagTraffic.view.interleaved' | 'diagTraffic.view.frames' }[] = [
  { id: 'transactions', key: 'diagTraffic.view.transactions' },
  { id: 'interleaved', key: 'diagTraffic.view.interleaved' },
  { id: 'frames', key: 'diagTraffic.view.frames' },
];

function clampHeight(h: number, parentH: number): number {
  const max = Math.max(DOCK_MIN_HEIGHT, Math.floor(parentH * DOCK_MAX_FRACTION));
  return Math.min(max, Math.max(DOCK_MIN_HEIGHT, Math.round(h)));
}

// ─── Origin filter popover (position: fixed so the scrolling toolbar cannot clip it) ───────────

const OriginMenu: React.FC<{
  origins: readonly DiagOrigin[];
  onChange: (next: readonly DiagOrigin[]) => void;
}> = ({ origins, onChange }) => {
  const { t } = useI18n();
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const open = pos !== null;

  useEffect(() => {
    if (!open) return undefined;
    const close = (e: Event) => {
      const target = e.target;
      if (target instanceof Node && (menuRef.current?.contains(target) || btnRef.current?.contains(target))) return;
      setPos(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPos(null);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const toggle = (o: DiagOrigin) => {
    const next = origins.includes(o) ? origins.filter((x) => x !== o) : DIAG_ORIGINS.filter((x) => x === o || origins.includes(x));
    onChange(next);
  };
  const allOn = origins.length === DIAG_ORIGINS.length;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={allOn ? DIAG_BTN_SM : DIAG_BTN_SM_ACTIVE}
        onClick={() => {
          const r = btnRef.current?.getBoundingClientRect();
          setPos(open || !r ? null : { left: r.left, bottom: window.innerHeight - r.top + 4 });
        }}
      >
        {t('diagTraffic.filter.origins')} {origins.length}/{DIAG_ORIGINS.length}
      </button>
      {pos && (
        <div
          ref={menuRef}
          className="fixed z-50 w-[190px] rounded-[2px] border border-[color:var(--border-strong)] bg-elevated p-2"
          style={{ left: pos.left, bottom: pos.bottom }}
        >
          <div className="mb-1.5 flex gap-1.5">
            <button type="button" className={DIAG_BTN_SM} onClick={() => onChange(DIAG_ORIGINS)}>
              {t('diagTraffic.filter.all')}
            </button>
            <button type="button" className={DIAG_BTN_SM} onClick={() => onChange([])}>
              {t('diagTraffic.filter.none')}
            </button>
          </div>
          {DIAG_ORIGINS.map((o) => (
            <label key={o} className="flex cursor-pointer items-center gap-2 py-0.5 font-mono text-[11.5px] text-ink">
              <input type="checkbox" className={DIAG_CHECKBOX} checked={origins.includes(o)} onChange={() => toggle(o)} />
              {t(ORIGIN_KEY[o])}
            </label>
          ))}
        </div>
      )}
    </>
  );
};

// ─── Dock ──────────────────────────────────────────────────────────────────────────────────────

export const TrafficDock: React.FC<{
  onOpenConsole: () => void;
  /** Reports whether the dock currently fills the whole Diagnostics content area. */
  onMaximizedChange: (maximized: boolean) => void;
}> = ({ onOpenConsole, onMaximizedChange }) => {
  const { t } = useI18n();
  const conversation = useDiagnosticsSelector((s) => s.conversation);
  const isotpFrames = useDiagnosticsSelector((s) => s.isotpFrames);
  const sessionInfo = useDiagnosticsSelector((s) => s.sessionInfo);
  const mockMode = useDiagnosticsSelector((s) => s.mockMode);

  const [prefs, setPrefs] = useState<TrafficPrefs>(loadPrefs);
  const [parentH, setParentH] = useState(600);
  const [frozen, setFrozen] = useState<TrafficSnapshot | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const modelRef = useRef<TrafficModel | null>(null);
  if (modelRef.current === null) modelRef.current = new TrafficModel();

  useEffect(() => savePrefs(prefs), [prefs]);
  const isMax = prefs.dock === 'maximized';
  useEffect(() => onMaximizedChange(isMax), [isMax, onMaximizedChange]);

  useEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent) return undefined;
    const ro = new ResizeObserver(() => setParentH(parent.clientHeight));
    ro.observe(parent);
    setParentH(parent.clientHeight);
    return () => ro.disconnect();
  }, []);

  const update = useCallback((patch: Partial<TrafficPrefs>) => setPrefs((p) => ({ ...p, ...patch })), []);
  const updateFilters = useCallback(
    (patch: Partial<TrafficFilters>) => setPrefs((p) => ({ ...p, filters: { ...p.filters, ...patch } })),
    [],
  );

  // Incremental join (idempotent for unchanged arrays) -> immutable snapshot.
  const live = useMemo(
    () => (modelRef.current as TrafficModel).update(conversation, isotpFrames),
    [conversation, isotpFrames],
  );
  const snap = frozen ?? live;
  const newCount = frozen ? Math.max(0, live.ingested - frozen.ingested) : 0;

  const deferredFilters = useDeferredValue(prefs.filters);
  const pred = useMemo(() => compileFilters(deferredFilters), [deferredFilters]);
  const rows = useMemo(
    () => (prefs.dock === 'collapsed' ? [] : buildRows(snap, prefs.view, pred, expanded, prefs.order)),
    [snap, prefs.view, prefs.order, prefs.dock, pred, expanded],
  );

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Selection -> transaction (via the row key) or a lone frame.
  const selection = useMemo<{ tx: Transaction | undefined; frame: TrafficSnapshot['frames'][number] | undefined }>(() => {
    if (selectedKey === null) return { tx: undefined, frame: undefined };
    if (selectedKey.startsWith('t:')) {
      const [epoch, seq] = selectedKey.slice(2).split(':').map(Number);
      return { tx: snap.findTx(epoch, seq), frame: undefined };
    }
    if (selectedKey.startsWith('e:')) {
      const uid = Number(selectedKey.slice(2));
      const item = snap.timeline.find((it) => it.kind === 'event' && it.uid === uid);
      if (item && item.kind === 'event') {
        const e = item.event;
        const tx = (e.requestSeq !== null ? snap.findTx(item.epoch, e.requestSeq) : undefined) ?? snap.findTx(item.epoch, e.seq);
        return { tx, frame: undefined };
      }
      return { tx: undefined, frame: undefined };
    }
    const uid = Number(selectedKey.slice(2));
    const frame = snap.frames.find((f) => f.uid === uid);
    const tx = frame && frame.requestSeq !== null ? snap.findTx(frame.epoch, frame.requestSeq) : undefined;
    return { tx, frame: tx ? undefined : frame };
  }, [selectedKey, snap]);

  const resend = useCallback(
    (draft: ResendDraft) => {
      diagnosticsStore.setConsoleDraft(draft);
      // A maximized dock hides the sub-tab content: restore it so the Console is actually visible.
      setPrefs((p) => (p.dock === 'maximized' ? { ...p, dock: 'pinned' } : p));
      onOpenConsole();
    },
    [onOpenConsole],
  );

  // ─ resize (direct style mutation while dragging, one state commit on release)
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = root.getBoundingClientRect().height;
    const pH = root.parentElement?.clientHeight ?? parentH;
    let latest = startH;
    const move = (ev: PointerEvent) => {
      latest = clampHeight(startH + (startY - ev.clientY), pH);
      root.style.height = `${latest}px`;
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      update({ height: latest });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const setDock = (dock: DockState) => update({ dock });
  const filtered = !pred.passthrough;
  const c = live.counters;

  // ─── Collapsed: one-line strip ─────────────────────────────────────────────────────────────
  if (prefs.dock === 'collapsed') {
    const last = live.lastTx;
    return (
      <div
        ref={rootRef}
        className="flex shrink-0 select-none items-center gap-3 border-t border-[color:var(--border-strong)] bg-elevated px-3 font-mono text-[11.5px] tabular-nums"
        style={{ height: STRIP_H }}
      >
        <button type="button" className={DIAG_BTN_SM} onClick={() => setDock('pinned')} title={t('diagTraffic.dock.expand')}>
          <ChevronUp className="h-3 w-3" aria-hidden="true" />
          {t('diagTraffic.title')}
        </button>
        {mockMode && <DiagDemoBadge />}
        <div className="flex min-w-0 flex-1 items-center gap-2 truncate text-muted">
          {last ? (
            <>
              <span className="text-subtle">{t('diagTraffic.strip.last')}</span>
              <span>#{last.seq}</span>
              <span>{t(ORIGIN_KEY[last.origin])}</span>
              <span className="truncate text-ink">{last.sid === null ? '—' : sidName(last.sid)}</span>
              <DiagBadge tone={STATUS_TONE[last.status]}>{t(STATUS_KEY[last.status])}</DiagBadge>
              {last.elapsedUs !== null && <span>{formatElapsedMs(last.elapsedUs)}</span>}
            </>
          ) : (
            <span className="text-subtle">{t('diagTraffic.strip.none')}</span>
          )}
        </div>
        <span className="text-muted">{t('diagTraffic.cnt.total')} <b className="text-ink">{c.total}</b></span>
        <span className="text-muted">NRC <b className={c.nrc > 0 ? 'text-critical' : 'text-ink'}>{c.nrc}</b></span>
        <span className="text-muted">{t('diagTraffic.cnt.timeout')} <b className={c.timeout > 0 ? 'text-critical' : 'text-ink'}>{c.timeout}</b></span>
        <span className="text-muted">{t('diagTraffic.cnt.frames')} <b className="text-ink">{c.frames}</b></span>
        <button type="button" className={DIAG_BTN_SM} onClick={() => setDock('maximized')} title={t('diagTraffic.dock.maximize')}>
          <Maximize2 className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
    );
  }

  const maximized = prefs.dock === 'maximized';
  const newestFirst = prefs.order === 'newestFirst';
  const style: React.CSSProperties = maximized ? {} : { height: clampHeight(prefs.height, parentH) };

  return (
    <div
      ref={rootRef}
      className={`flex min-h-0 flex-col overflow-hidden border-t border-[color:var(--border-strong)] bg-canvas ${maximized ? 'flex-1' : 'shrink-0'}`}
      style={style}
    >
      {!maximized && (
        <div
          role="separator"
          aria-orientation="horizontal"
          title={t('diagTraffic.dock.resize')}
          className="h-[5px] shrink-0 cursor-row-resize bg-[var(--bg-header)] hover:bg-[var(--status-focus)]"
          onPointerDown={startDrag}
        />
      )}

      {/* Toolbar (single row, scrolls horizontally on narrow windows) */}
      <div className="no-scrollbar flex h-8 shrink-0 select-none items-center gap-2 overflow-x-auto border-b border-hairline bg-elevated px-2.5">
        <button type="button" className={DIAG_BTN_SM} onClick={() => setDock('collapsed')} title={t('diagTraffic.dock.collapse')}>
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </button>
        <span className="shrink-0 font-mono text-xs font-semibold uppercase tracking-wider text-ink">{t('diagTraffic.title')}</span>
        {mockMode && <DiagDemoBadge />}

        <div className="flex shrink-0 gap-px">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className={diagToneButtonClass('focus', prefs.view === v.id, 'sm')}
              onClick={() => update({ view: v.id })}
            >
              {t(v.key)}
            </button>
          ))}
        </div>

        <button
          type="button"
          className={DIAG_BTN_SM}
          onClick={() => update({ order: newestFirst ? 'oldestFirst' : 'newestFirst' })}
          title={t(newestFirst ? 'diagTraffic.order.newestFirst' : 'diagTraffic.order.oldestFirst')}
          aria-label={t(newestFirst ? 'diagTraffic.order.newestFirst' : 'diagTraffic.order.oldestFirst')}
        >
          {newestFirst ? <ArrowDownWideNarrow className="h-3 w-3" aria-hidden="true" /> : <ArrowUpNarrowWide className="h-3 w-3" aria-hidden="true" />}
          {t(newestFirst ? 'diagTraffic.order.newestFirst' : 'diagTraffic.order.oldestFirst')}
        </button>

        <OriginMenu origins={prefs.filters.origins} onChange={(origins) => updateFilters({ origins })} />
        <button
          type="button"
          className={diagToneButtonClass('critical', prefs.filters.errorsOnly, 'sm')}
          title={t('diagTraffic.filter.errorsTitle')}
          onClick={() => updateFilters({ errorsOnly: !prefs.filters.errorsOnly })}
        >
          {t('diagTraffic.filter.errors')}
        </button>
        <input
          className={`${DIAG_INPUT} !h-[24px] !w-[64px] shrink-0 !text-[11.5px]`}
          placeholder={t('diagTraffic.filter.sid')}
          value={prefs.filters.sid}
          maxLength={4}
          onChange={(e) => updateFilters({ sid: e.target.value })}
        />
        <input
          className={`${DIAG_INPUT} !h-[24px] !w-[170px] shrink-0 !text-[11.5px]`}
          placeholder={t('diagTraffic.filter.search')}
          value={prefs.filters.search}
          onChange={(e) => updateFilters({ search: e.target.value })}
        />

        <div className="flex-1" />

        <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-muted">
          {c.total} · NRC <span className={c.nrc > 0 ? 'text-critical' : ''}>{c.nrc}</span> · TO{' '}
          <span className={c.timeout > 0 ? 'text-critical' : ''}>{c.timeout}</span> · {t('diagTraffic.cnt.frames')} {c.frames}
        </span>
        {frozen ? (
          <button type="button" className={DIAG_BTN_SM_ACTIVE} onClick={() => setFrozen(null)}>
            <Play className="h-3 w-3" aria-hidden="true" />
            {t('diagTraffic.resume')}
            <span className="tabular-nums">{t('diagTraffic.newItems', { n: newCount })}</span>
          </button>
        ) : (
          <button type="button" className={DIAG_BTN_SM} onClick={() => setFrozen(live)} title={t('diagTraffic.freezeTitle')}>
            <Pause className="h-3 w-3" aria-hidden="true" />
            {t('diagTraffic.freeze')}
          </button>
        )}
        <button
          type="button"
          className={DIAG_BTN_SM}
          onClick={() => {
            diagnosticsStore.clearTraffic();
            setFrozen(null);
            setSelectedKey(null);
            setExpanded(new Set<string>());
          }}
        >
          <Trash2 className="h-3 w-3" aria-hidden="true" />
          {t('diagTraffic.clear')}
        </button>
        <button
          type="button"
          className={prefs.detailOpen ? DIAG_BTN_SM_ACTIVE : DIAG_BTN_SM}
          onClick={() => update({ detailOpen: !prefs.detailOpen })}
          title={t('diagTraffic.detail.toggle')}
        >
          <PanelRight className="h-3 w-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={DIAG_BTN_SM}
          onClick={() => setDock(maximized ? 'pinned' : 'maximized')}
          title={maximized ? t('diagTraffic.dock.restore') : t('diagTraffic.dock.maximize')}
        >
          {maximized ? <Minimize2 className="h-3 w-3" aria-hidden="true" /> : <Maximize2 className="h-3 w-3" aria-hidden="true" />}
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <TrafficTable
          rows={rows}
          mode={prefs.view}
          order={prefs.order}
          baseUs={snap.baseUs}
          selectedKey={selectedKey}
          frozen={frozen !== null}
          filtered={filtered}
          onSelect={setSelectedKey}
          onToggle={toggleExpanded}
        />
        {prefs.detailOpen && (
          <div className="flex min-h-0 shrink-0 flex-col border-l border-[color:var(--border-strong)] bg-[var(--bg-panel)]" style={{ width: DETAIL_W }}>
            <TrafficDetail tx={selection.tx} frame={selection.frame} sessionInfo={sessionInfo} onResend={resend} />
          </div>
        )}
      </div>
    </div>
  );
};
