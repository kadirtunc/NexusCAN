import React, { useMemo, type MutableRefObject, type RefObject } from 'react';
import { Copy, GripHorizontal, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { SimulationWidgetDto } from '../../types/simulation';
import type { DragGroupChildOffset, DragInteractionState } from './instrumentGridInteractions';
import { ACCENT_HEX_MAP, isWidgetInsideGroup } from './virtualCanPacking';

export interface InstrumentWidgetHeaderMeta {
  /** Small badge shown in DESIGN mode next to the coordinates (e.g. DBC name / UDS service). */
  badge: string | null;
  /** Message / identifier tag shown in RUN mode header (e.g. DBC messageKey / DID). */
  tag: string | null;
}

export interface InstrumentCanvasGridProps<W extends SimulationWidgetDto> {
  widgets: readonly W[];
  gridCols: number;
  rowHeightPx: number;
  isDesignMode: boolean;
  canMutate: boolean;
  selectedWidgetId: string | null;
  dragHoverGroupId: string | null;
  containerRef: RefObject<HTMLDivElement | null>;
  dragStateRef: MutableRefObject<DragInteractionState | null>;
  onSelectWidget: (widgetId: string | null) => void;
  onDuplicateWidget: (widgetId: string) => void;
  onDeleteWidget: (widgetId: string) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  getHeaderMeta: (widget: W) => InstrumentWidgetHeaderMeta;
  renderBody: (widget: W, ctx: { groupChildCount: number }) => React.ReactNode;
  /** Rendered centered inside the grid when there are no widgets. */
  emptyState?: React.ReactNode;
}

/**
 * 24-column absolute-positioned instrument canvas with the crisp widget chrome
 * (header bar, drag-to-move, corner resize handle, group frames). Shared by the Simulation
 * workbench and the Diagnostics UDS instrument panel.
 */
export function InstrumentCanvasGrid<W extends SimulationWidgetDto>({
  widgets,
  gridCols,
  rowHeightPx,
  isDesignMode,
  canMutate,
  selectedWidgetId,
  dragHoverGroupId,
  containerRef,
  dragStateRef,
  onSelectWidget,
  onDuplicateWidget,
  onDeleteWidget,
  onDragOver,
  onDragLeave,
  onDrop,
  getHeaderMeta,
  renderBody,
  emptyState,
}: InstrumentCanvasGridProps<W>): React.JSX.Element {
  const { t } = useI18n();

  const groupChildCountById = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const w of widgets) {
      if (w.kind === 'group') {
        counts[w.id] = widgets.filter((cand) => isWidgetInsideGroup(cand, w)).length;
      }
    }
    return counts;
  }, [widgets]);

  const maxOccupiedRow = widgets.reduce(
    (maxR, w) => Math.max(maxR, w.layout.row + w.layout.h),
    14
  );
  const canvasRows = isDesignMode ? maxOccupiedRow + 6 : maxOccupiedRow + 1;
  const canvasMinHeightPx = Math.max(540, canvasRows * rowHeightPx);

  // Render group frames below display/stimulus widgets so inner widgets remain interactive
  const orderedWidgets = useMemo(
    () =>
      [...widgets].sort((a, b) => {
        if (a.kind === 'group' && b.kind !== 'group') return -1;
        if (a.kind !== 'group' && b.kind === 'group') return 1;
        return 0;
      }),
    [widgets]
  );

  return (
    <div
      className="min-h-0 flex-1 overflow-auto p-3"
      onClick={(e) => {
        if (e.target === e.currentTarget && isDesignMode) {
          onSelectWidget(null);
        }
      }}
    >
      <div
        ref={containerRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={(e) => {
          if (e.target === e.currentTarget && isDesignMode) {
            onSelectWidget(null);
          }
        }}
        style={{
          minHeight: `${canvasMinHeightPx}px`,
          ...(isDesignMode
            ? {
                backgroundImage:
                  'linear-gradient(to right, var(--canvas-grid) 1px, transparent 1px), linear-gradient(to bottom, var(--canvas-grid) 1px, transparent 1px)',
                backgroundSize: `calc(100% / ${gridCols}) ${rowHeightPx}px`,
              }
            : {}),
        }}
        className={`relative w-full min-w-[720px] rounded-[2px] ${
          isDesignMode ? 'border border-hairline bg-canvas' : 'bg-canvas'
        }`}
      >
        {widgets.length === 0 && emptyState}

        {orderedWidgets.map((widget) => {
          const isSelected = isDesignMode && selectedWidgetId === widget.id;
          const isGroup = widget.kind === 'group';
          const isDragHoverTarget =
            isDesignMode && isGroup && dragHoverGroupId === widget.id;
          const groupChildCount = isGroup ? (groupChildCountById[widget.id] ?? 0) : 0;
          const leftPct = (widget.layout.col / gridCols) * 100;
          const widthPct = (widget.layout.w / gridCols) * 100;
          const topPx = widget.layout.row * rowHeightPx;
          const heightPx = widget.layout.h * rowHeightPx;
          const accentHex = ACCENT_HEX_MAP[widget.accentColor];
          const headerMeta = getHeaderMeta(widget);

          return (
            <div
              key={widget.id}
              style={{
                left: `${leftPct}%`,
                width: `${widthPct}%`,
                top: `${topPx}px`,
                height: `${heightPx}px`,
                zIndex: isGroup
                  ? isSelected || isDragHoverTarget
                    ? 5
                    : 1
                  : isSelected
                    ? 30
                    : 10,
              }}
              className={`absolute p-[3px] ${
                isGroup && !isDesignMode ? 'pointer-events-none' : 'pointer-events-auto'
              }`}
            >
              <div
                onClick={(e) => {
                  if (isDesignMode) {
                    e.stopPropagation();
                    onSelectWidget(widget.id);
                  }
                }}
                style={{
                  borderColor:
                    isDragHoverTarget || isSelected
                      ? 'var(--status-focus)'
                      : isGroup
                        ? 'var(--border-strong)'
                        : 'var(--border-hairline)',
                }}
                className={`flex h-full w-full flex-col overflow-hidden rounded-[2px] border ${
                  isGroup ? 'bg-surface/35' : 'bg-surface'
                }`}
              >
                {/* Crisp Instrument Header Bar */}
                <div
                  onPointerDown={(e) => {
                    if (!isDesignMode || !canMutate) return;
                    if ((e.target as HTMLElement).closest('button')) {
                      return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    onSelectWidget(widget.id);
                    const childOffsets: DragGroupChildOffset[] =
                      widget.kind === 'group'
                        ? widgets
                            .filter((child) => isWidgetInsideGroup(child, widget))
                            .map((child) => ({
                              id: child.id,
                              origCol: child.layout.col,
                              origRow: child.layout.row,
                              w: child.layout.w,
                              h: child.layout.h,
                            }))
                        : [];
                    dragStateRef.current = {
                      mode: 'move',
                      widgetId: widget.id,
                      widgetKind: widget.kind,
                      startClientX: e.clientX,
                      startClientY: e.clientY,
                      origCol: widget.layout.col,
                      origRow: widget.layout.row,
                      origW: widget.layout.w,
                      origH: widget.layout.h,
                      childOffsets,
                    };
                  }}
                  className={`pointer-events-auto flex h-6 shrink-0 select-none items-center justify-between gap-1.5 border-b border-hairline bg-elevated px-2 font-mono text-[10px] tabular-nums ${
                    isDesignMode && canMutate ? 'cursor-move' : ''
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span
                      className="h-2 w-1 shrink-0 rounded-[1px]"
                      style={{ backgroundColor: accentHex }}
                      aria-hidden="true"
                    />
                    {isDesignMode && canMutate && (
                      <GripHorizontal
                        className="h-3 w-3 shrink-0 text-subtle"
                        aria-hidden="true"
                      />
                    )}
                    <span className="truncate font-semibold uppercase tracking-wider text-ink">
                      {widget.title}
                    </span>
                    {isGroup && widget.config.subtitle && (
                      <span className="hidden truncate text-[9px] text-muted sm:inline">
                        // {widget.config.subtitle}
                      </span>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {isDesignMode ? (
                      <>
                        {isDragHoverTarget && (
                          <span
                            className="rounded-[2px] border bg-canvas px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-focus"
                            style={{ borderColor: 'var(--status-focus)' }}
                          >
                            {t('simWb.widget.dropToGroup')}
                          </span>
                        )}
                        {isGroup && (
                          <span className="rounded-[2px] border border-hairline bg-canvas px-1 py-0.5 font-mono text-[9px] font-semibold tabular-nums text-muted">
                            {t('simWb.widget.itemCount', { count: groupChildCount })}
                          </span>
                        )}
                        {headerMeta.badge && (
                          <span className="hidden max-w-[74px] truncate rounded-[1px] border border-hairline bg-canvas px-1 text-[8px] text-muted xl:inline">
                            {headerMeta.badge}
                          </span>
                        )}
                        <span className="text-[9px] text-subtle">
                          {widget.layout.col},{widget.layout.row} {widget.layout.w}×
                          {widget.layout.h}
                        </span>
                        {isSelected && canMutate && (
                          <>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDuplicateWidget(widget.id);
                              }}
                              title={t('simWb.widget.copy')}
                              aria-label={t('simWb.widget.copy')}
                              className="cursor-pointer rounded-[2px] p-0.5 text-muted hover:bg-surface hover:text-ink"
                            >
                              <Copy className="h-2.5 w-2.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDeleteWidget(widget.id);
                              }}
                              title={t('simWb.widget.delete')}
                              aria-label={t('simWb.widget.delete')}
                              className="cursor-pointer rounded-[2px] p-0.5 text-muted hover:bg-surface hover:text-critical"
                            >
                              <Trash2 className="h-2.5 w-2.5" />
                            </button>
                          </>
                        )}
                      </>
                    ) : (
                      headerMeta.tag && (
                        <span className="max-w-[130px] truncate text-[9px] text-subtle">
                          {headerMeta.badge ? `[${headerMeta.badge}] ` : ''}
                          {headerMeta.tag}
                        </span>
                      )
                    )}
                  </div>
                </div>

                {/* Widget Instrument Body */}
                <div className="relative min-h-0 flex-1">
                  {renderBody(widget, { groupChildCount })}
                </div>

                {/* Bottom-Right Machined Resize Handle (DESIGN Mode) */}
                {isDesignMode && canMutate && (
                  <div
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onSelectWidget(widget.id);
                      dragStateRef.current = {
                        mode: 'resize',
                        widgetId: widget.id,
                        widgetKind: widget.kind,
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        origCol: widget.layout.col,
                        origRow: widget.layout.row,
                        origW: widget.layout.w,
                        origH: widget.layout.h,
                        childOffsets: [],
                      };
                    }}
                    title={t('simWb.widget.resizeTitle')}
                    className="pointer-events-auto absolute right-[3px] bottom-[3px] z-20 flex h-3.5 w-3.5 cursor-se-resize items-end justify-end border-t border-l border-strong bg-elevated p-0.5 hover:border-focus"
                  >
                    <span
                      className="h-1.5 w-1.5 border-r border-b border-ink"
                      aria-hidden="true"
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
