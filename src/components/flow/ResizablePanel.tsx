/**
 * Side panel of the Flow Editor: resizable (drag handle on the inner edge, keyboard, double-click = default) and
 * collapsible (thin rail with icon + vertical label). Width and collapsed state persist per panel id in
 * localStorage (UI preference only; never part of the project or of flow files).
 *
 * Performance: while dragging, the width is written straight to the panel element on `requestAnimationFrame`
 * (no React state per pointer move, so the canvas does not re-render); React state is committed on release.
 * No CSS transitions / animations.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '../../i18n';

export const PANEL_KEY_STEP = 16;
const STORAGE_PREFIX = 'nexuscan:flow_panel:';

export function clampPanelWidth(w: number, min: number, max: number): number {
  if (!Number.isFinite(w)) return min;
  return Math.min(max, Math.max(min, Math.round(w)));
}

export interface PanelPrefs {
  width: number;
  collapsed: boolean;
}

/** Parses stored prefs; anything invalid falls back to the defaults (width is clamped to the bounds). */
export function parsePanelPrefs(raw: string | null, def: number, min: number, max: number): PanelPrefs {
  try {
    const v: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof v === 'object' && v !== null) {
      const o = v as Record<string, unknown>;
      return {
        width: typeof o['w'] === 'number' ? clampPanelWidth(o['w'], min, max) : def,
        collapsed: o['c'] === true,
      };
    }
  } catch {
    // fall through
  }
  return { width: def, collapsed: false };
}

function readPrefs(id: string, def: number, min: number, max: number): PanelPrefs {
  try {
    return parsePanelPrefs(localStorage.getItem(`${STORAGE_PREFIX}${id}:v1`), def, min, max);
  } catch {
    return { width: def, collapsed: false };
  }
}

function writePrefs(id: string, p: PanelPrefs): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${id}:v1`, JSON.stringify({ w: p.width, c: p.collapsed }));
  } catch {
    // ignore (private mode / quota)
  }
}

export interface ResizablePanelProps {
  /** Persistence key (`palette`, `registry`, `inspector`). */
  id: string;
  /** Side of the editor the panel sits on: the handle is on its inner edge. */
  side: 'left' | 'right';
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  title: string;
  icon: React.ReactNode;
  /** Right-aligned header content (next to the collapse button). */
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}

export const ResizablePanel: React.FC<ResizablePanelProps> = ({
  id, side, defaultWidth, minWidth, maxWidth, title, icon, headerExtra, children,
}) => {
  const { t } = useI18n();
  const [prefs, setPrefs] = useState<PanelPrefs>(() => readPrefs(id, defaultWidth, minWidth, maxWidth));
  const rootRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startW: number; w: number; raf: number | null } | null>(null);

  const commit = useCallback((next: PanelPrefs) => {
    setPrefs(next);
    writePrefs(id, next);
  }, [id]);

  const apply = useCallback((w: number) => {
    if (rootRef.current) rootRef.current.style.width = `${w}px`;
    handleRef.current?.setAttribute('aria-valuenow', String(w));
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startW: prefs.width, w: prefs.width, raf: null };
    e.preventDefault();
  }, [prefs.width]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    d.w = clampPanelWidth(side === 'left' ? d.startW + dx : d.startW - dx, minWidth, maxWidth);
    if (d.raf === null) {
      d.raf = requestAnimationFrame(() => {
        if (drag.current) {
          drag.current.raf = null;
          apply(drag.current.w);
        }
      });
    }
  }, [apply, maxWidth, minWidth, side]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.raf !== null) cancelAnimationFrame(d.raf);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    apply(d.w);
    commit({ ...prefs, width: d.w });
  }, [apply, commit, prefs]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Growing direction: the panel's own side is anchored, so the handle moves away from it.
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    const w = clampPanelWidth(prefs.width + (e.key === grow ? PANEL_KEY_STEP : -PANEL_KEY_STEP), minWidth, maxWidth);
    commit({ ...prefs, width: w });
  }, [commit, maxWidth, minWidth, prefs, side]);

  // The committed width is applied through React; keep the element in sync when the state changes.
  useEffect(() => {
    if (rootRef.current && !prefs.collapsed) rootRef.current.style.width = `${prefs.width}px`;
  }, [prefs.width, prefs.collapsed]);

  const borderCls = side === 'left' ? 'border-r' : 'border-l';
  const Collapse = side === 'left' ? ChevronLeft : ChevronRight;
  const Expand = side === 'left' ? ChevronRight : ChevronLeft;

  if (prefs.collapsed) {
    return (
      <button
        type="button"
        onClick={() => commit({ ...prefs, collapsed: false })}
        title={t('flowReg.panel.expand', { name: title })}
        aria-label={t('flowReg.panel.expand', { name: title })}
        aria-expanded={false}
        className={`flex h-full w-8 shrink-0 cursor-pointer flex-col items-center gap-2 ${borderCls} border-hairline bg-surface py-2 text-muted hover:text-ink`}
      >
        <Expand className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="shrink-0 text-muted" aria-hidden="true">{icon}</span>
        <span
          className="font-mono text-[11px] font-semibold uppercase tracking-wider"
          style={{ writingMode: 'vertical-rl' }}
        >
          {title}
        </span>
      </button>
    );
  }

  const handle = (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('flowReg.panel.resize', { name: title })}
      aria-valuenow={prefs.width}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => commit({ ...prefs, width: defaultWidth })}
      onKeyDown={onKeyDown}
      className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-focus focus:bg-focus focus:outline-none"
      style={{ touchAction: 'none' }}
    />
  );

  return (
    <div className="flex h-full shrink-0">
      {side === 'right' && handle}
      <div
        ref={rootRef}
        className={`flex h-full min-w-0 shrink-0 flex-col overflow-hidden ${borderCls} border-hairline bg-surface text-ink`}
        style={{ width: prefs.width }}
      >
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline bg-elevated px-2.5">
          <span className="shrink-0 text-muted" aria-hidden="true">{icon}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-semibold uppercase tracking-wider text-ink">{title}</span>
          {headerExtra}
          <button
            type="button"
            onClick={() => commit({ ...prefs, collapsed: true })}
            title={t('flowReg.panel.collapse', { name: title })}
            aria-label={t('flowReg.panel.collapse', { name: title })}
            aria-expanded
            className="shrink-0 cursor-pointer rounded-[2px] p-0.5 text-muted hover:text-ink"
          >
            <Collapse className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
      {side === 'left' && handle}
    </div>
  );
};
