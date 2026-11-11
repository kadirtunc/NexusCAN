/**
 * Shared instrument-panel grid interactions (24-column canvas).
 *
 * Extracted verbatim from SimulationWorkbenchView so that the Simulation workbench and the
 * Diagnostics UDS instrument panel share ONE drag / resize / keyboard / palette-drop / hotkey
 * implementation. Nothing in here knows about DBC signals or UDS services.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MutableRefObject,
  type RefObject,
} from 'react';
import type {
  SimulationWidgetDto,
  SimulationWidgetKind,
  SimulationWidgetLayoutDto,
} from '../../types/simulation';
import {
  isEditableActiveElement,
  matchesConfiguredHotkey,
} from './buttonControlUtils';
import type { SimulationRuntimeBus } from './simulationRuntimeBus';
import {
  SIM_PALETTE_DRAG_MIME,
  findContainingGroup,
  findNextFreeGridSlot,
  isWidgetInsideGroup,
  parsePaletteDragPayload,
  placeWidgetInsideGroup,
  type PaletteDragPayload,
} from './virtualCanPacking';

export interface InstrumentPanelLike<W extends SimulationWidgetDto> {
  gridCols: number;
  rowHeightPx: number;
  widgets: W[];
}

export type MutateInstrumentPanel<P> = (updater: (prev: P) => P) => void;

export interface DragGroupChildOffset {
  id: string;
  origCol: number;
  origRow: number;
  w: number;
  h: number;
}

export interface DragInteractionState {
  mode: 'move' | 'resize';
  widgetId: string;
  widgetKind: SimulationWidgetKind;
  startClientX: number;
  startClientY: number;
  origCol: number;
  origRow: number;
  origW: number;
  origH: number;
  childOffsets: readonly DragGroupChildOffset[];
}

// ─── Layout helper shared by "duplicate widget" flows ────────────────────────

export function planWidgetCopyLayout(
  target: SimulationWidgetDto,
  widgets: readonly SimulationWidgetDto[],
  gridCols: number
): {
  parentGroup: SimulationWidgetDto | null;
  copyLayout: SimulationWidgetLayoutDto;
  updatedGroupLayout: SimulationWidgetLayoutDto | null;
} {
  const parentGroup =
    target.kind !== 'group' ? findContainingGroup(target.layout, widgets) : null;

  if (parentGroup) {
    const placed = placeWidgetInsideGroup(
      parentGroup,
      widgets,
      target.layout.w,
      target.layout.h,
      gridCols
    );
    return {
      parentGroup,
      copyLayout: placed.childLayout,
      updatedGroupLayout: placed.updatedGroupLayout,
    };
  }
  return {
    parentGroup: null,
    copyLayout: findNextFreeGridSlot(widgets, target.layout.w, target.layout.h, gridCols),
    updatedGroupLayout: null,
  };
}

// ─── Pointer drag-to-move / corner drag-to-resize ────────────────────────────

export function useInstrumentGridDrag<
  W extends SimulationWidgetDto,
  P extends InstrumentPanelLike<W>,
>({
  panel,
  containerRef,
  mutatePanel,
}: {
  panel: P | null;
  containerRef: RefObject<HTMLDivElement | null>;
  mutatePanel: MutateInstrumentPanel<P>;
}): {
  dragStateRef: MutableRefObject<DragInteractionState | null>;
  dragHoverGroupId: string | null;
  setDragHoverGroupId: (next: string | null) => void;
} {
  const dragStateRef = useRef<DragInteractionState | null>(null);
  const [dragHoverGroupId, setDragHoverGroupIdState] = useState<string | null>(null);
  const setDragHoverGroupId = useCallback((next: string | null) => {
    setDragHoverGroupIdState((prev) => (prev === next ? prev : next));
  }, []);

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const drag = dragStateRef.current;
      const container = containerRef.current;
      if (!drag || !container || !panel) return;

      const rect = container.getBoundingClientRect();
      const colWidth = Math.max(16, rect.width / panel.gridCols);
      const rowHeight = panel.rowHeightPx;

      const deltaCols = Math.round((e.clientX - drag.startClientX) / colWidth);
      const deltaRows = Math.round((e.clientY - drag.startClientY) / rowHeight);

      if (drag.mode === 'move') {
        const nextCol = Math.max(
          0,
          Math.min(panel.gridCols - drag.origW, drag.origCol + deltaCols)
        );
        const nextRow = Math.max(0, Math.min(399, drag.origRow + deltaRows));

        if (drag.widgetKind === 'group') {
          setDragHoverGroupId(null);
          const actualDeltaCol = nextCol - drag.origCol;
          const actualDeltaRow = nextRow - drag.origRow;
          const childOffsetById = new Map<string, DragGroupChildOffset>();
          for (const childOff of drag.childOffsets) {
            childOffsetById.set(childOff.id, childOff);
          }

          mutatePanel((p) => ({
            ...p,
            widgets: p.widgets.map((w) => {
              if (w.id === drag.widgetId) {
                if (nextCol === w.layout.col && nextRow === w.layout.row) {
                  return w;
                }
                return {
                  ...w,
                  layout: { ...w.layout, col: nextCol, row: nextRow },
                };
              }
              const childOff = childOffsetById.get(w.id);
              if (childOff) {
                const targetChildCol = e.altKey
                  ? childOff.origCol
                  : Math.max(
                      0,
                      Math.min(
                        p.gridCols - childOff.w,
                        childOff.origCol + actualDeltaCol
                      )
                    );
                const targetChildRow = e.altKey
                  ? childOff.origRow
                  : Math.max(
                      0,
                      Math.min(399, childOff.origRow + actualDeltaRow)
                    );
                if (
                  targetChildCol === w.layout.col &&
                  targetChildRow === w.layout.row
                ) {
                  return w;
                }
                return {
                  ...w,
                  layout: {
                    ...w.layout,
                    col: targetChildCol,
                    row: targetChildRow,
                  },
                };
              }
              return w;
            }),
          }));
          return;
        }

        const hoveredGroup = findContainingGroup(
          { col: nextCol, row: nextRow, w: drag.origW, h: drag.origH },
          panel.widgets
        );
        setDragHoverGroupId(hoveredGroup?.id ?? null);

        mutatePanel((p) => ({
          ...p,
          widgets: p.widgets.map((w) => {
            if (w.id !== drag.widgetId) return w;
            if (nextCol === w.layout.col && nextRow === w.layout.row) {
              return w;
            }
            return {
              ...w,
              layout: { ...w.layout, col: nextCol, row: nextRow },
            };
          }),
        }));
        return;
      }

      mutatePanel((p) => ({
        ...p,
        widgets: p.widgets.map((w) => {
          if (w.id !== drag.widgetId) return w;
          const nextW = Math.max(
            1,
            Math.min(p.gridCols - drag.origCol, drag.origW + deltaCols)
          );
          const nextH = Math.max(1, Math.min(48, drag.origH + deltaRows));
          if (nextW === w.layout.w && nextH === w.layout.h) {
            return w;
          }
          return {
            ...w,
            layout: { ...w.layout, w: nextW, h: nextH },
          };
        }),
      }));
    };

    const onPointerUp = () => {
      const finishedDrag = dragStateRef.current;
      dragStateRef.current = null;
      setDragHoverGroupId(null);

      if (
        finishedDrag &&
        finishedDrag.mode === 'move' &&
        finishedDrag.widgetKind !== 'group'
      ) {
        mutatePanel((p) => {
          const moved = p.widgets.find((w) => w.id === finishedDrag.widgetId);
          if (!moved || moved.kind === 'group') return p;
          const containingGroup = findContainingGroup(moved.layout, p.widgets);
          if (!containingGroup) return p;

          const adjustedCol = Math.max(
            containingGroup.layout.col,
            Math.min(p.gridCols - moved.layout.w, moved.layout.col)
          );
          const adjustedRow =
            moved.layout.row <= containingGroup.layout.row
              ? Math.min(399, containingGroup.layout.row + 1)
              : moved.layout.row;

          const maxAllowedGroupW = Math.max(
            1,
            Math.min(24, p.gridCols - containingGroup.layout.col)
          );
          const neededGroupW =
            adjustedCol + moved.layout.w - containingGroup.layout.col;
          const nextGroupW = Math.min(
            maxAllowedGroupW,
            Math.max(containingGroup.layout.w, neededGroupW)
          );
          const neededGroupH =
            adjustedRow + moved.layout.h - containingGroup.layout.row;
          const nextGroupH = Math.min(
            48,
            Math.max(2, containingGroup.layout.h, neededGroupH)
          );

          if (
            adjustedCol === moved.layout.col &&
            adjustedRow === moved.layout.row &&
            nextGroupW === containingGroup.layout.w &&
            nextGroupH === containingGroup.layout.h
          ) {
            return p;
          }

          return {
            ...p,
            widgets: p.widgets.map((w) => {
              if (w.id === moved.id) {
                return {
                  ...w,
                  layout: { ...w.layout, col: adjustedCol, row: adjustedRow },
                };
              }
              if (w.id === containingGroup.id) {
                return {
                  ...w,
                  layout: { ...w.layout, w: nextGroupW, h: nextGroupH },
                };
              }
              return w;
            }),
          };
        });
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [containerRef, mutatePanel, panel, setDragHoverGroupId]);

  return { dragStateRef, dragHoverGroupId, setDragHoverGroupId };
}

// ─── Keyboard: Ctrl+S, Delete, arrow nudge, Shift+arrow resize ───────────────

export function useInstrumentGridKeyboard<
  W extends SimulationWidgetDto,
  P extends InstrumentPanelLike<W>,
>({
  enabled,
  isDesignMode,
  canMutate,
  selectedWidgetId,
  mutatePanel,
  onClearSelection,
  onSave,
}: {
  enabled: boolean;
  isDesignMode: boolean;
  canMutate: boolean;
  selectedWidgetId: string | null;
  mutatePanel: MutateInstrumentPanel<P>;
  onClearSelection: () => void;
  onSave?: () => void;
}): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (onSave && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        onSave();
        return;
      }

      if (!isDesignMode || !selectedWidgetId || !canMutate) {
        return;
      }

      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        mutatePanel((p) => ({
          ...p,
          widgets: p.widgets.filter((w) => w.id !== selectedWidgetId),
        }));
        onClearSelection();
        return;
      }

      if (
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight' ||
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown'
      ) {
        e.preventDefault();
        const dCol = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        const dRow = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
        mutatePanel((p) => {
          const target = p.widgets.find((w) => w.id === selectedWidgetId);
          if (!target) return p;

          if (!e.shiftKey && !e.altKey && target.kind === 'group') {
            const nextGroupCol = Math.max(
              0,
              Math.min(p.gridCols - target.layout.w, target.layout.col + dCol)
            );
            const nextGroupRow = Math.max(
              0,
              Math.min(399, target.layout.row + dRow)
            );
            const actualDeltaCol = nextGroupCol - target.layout.col;
            const actualDeltaRow = nextGroupRow - target.layout.row;
            if (actualDeltaCol === 0 && actualDeltaRow === 0) {
              return p;
            }
            const childIds = new Set(
              p.widgets
                .filter((cand) => isWidgetInsideGroup(cand, target))
                .map((cand) => cand.id)
            );
            return {
              ...p,
              widgets: p.widgets.map((w) => {
                if (w.id === target.id) {
                  return {
                    ...w,
                    layout: {
                      ...w.layout,
                      col: nextGroupCol,
                      row: nextGroupRow,
                    },
                  };
                }
                if (childIds.has(w.id)) {
                  const childNextCol = Math.max(
                    0,
                    Math.min(
                      p.gridCols - w.layout.w,
                      w.layout.col + actualDeltaCol
                    )
                  );
                  const childNextRow = Math.max(
                    0,
                    Math.min(399, w.layout.row + actualDeltaRow)
                  );
                  return {
                    ...w,
                    layout: {
                      ...w.layout,
                      col: childNextCol,
                      row: childNextRow,
                    },
                  };
                }
                return w;
              }),
            };
          }

          return {
            ...p,
            widgets: p.widgets.map((w) => {
              if (w.id !== selectedWidgetId) return w;
              if (e.shiftKey) {
                const nextW = Math.max(
                  1,
                  Math.min(p.gridCols - w.layout.col, w.layout.w + dCol)
                );
                const nextH = Math.max(1, Math.min(48, w.layout.h + dRow));
                return {
                  ...w,
                  layout: { ...w.layout, w: nextW, h: nextH },
                };
              }
              const nextCol = Math.max(
                0,
                Math.min(p.gridCols - w.layout.w, w.layout.col + dCol)
              );
              const nextRow = Math.max(0, Math.min(399, w.layout.row + dRow));
              return {
                ...w,
                layout: { ...w.layout, col: nextCol, row: nextRow },
              };
            }),
          };
        });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    canMutate,
    enabled,
    isDesignMode,
    mutatePanel,
    onClearSelection,
    onSave,
    selectedWidgetId,
  ]);
}

// ─── Palette drag & drop onto the grid ───────────────────────────────────────

export function useInstrumentGridDrop<
  W extends SimulationWidgetDto,
  P extends InstrumentPanelLike<W>,
>({
  containerRef,
  panel,
  isDesignMode,
  canMutate,
  setDragHoverGroupId,
  onDropPayload,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  panel: P | null;
  isDesignMode: boolean;
  canMutate: boolean;
  setDragHoverGroupId: (next: string | null) => void;
  onDropPayload: (
    payload: PaletteDragPayload,
    cell: { col: number; row: number },
    hoveredGroupId: string | null
  ) => void;
}): {
  resolveGridCellFromClientPoint: (
    clientX: number,
    clientY: number
  ) => { col: number; row: number } | null;
  handleDragOver: (e: ReactDragEvent<HTMLDivElement>) => void;
  handleDragLeave: (e: ReactDragEvent<HTMLDivElement>) => void;
  handleDrop: (e: ReactDragEvent<HTMLDivElement>) => void;
} {
  const resolveGridCellFromClientPoint = useCallback(
    (clientX: number, clientY: number): { col: number; row: number } | null => {
      const container = containerRef.current;
      if (!container || !panel) return null;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const colWidth = rect.width / panel.gridCols;
      const relX = clientX - rect.left;
      const relY = clientY - rect.top;
      const col = Math.max(
        0,
        Math.min(panel.gridCols - 1, Math.floor(relX / colWidth))
      );
      const row = Math.max(
        0,
        Math.min(399, Math.floor(relY / panel.rowHeightPx))
      );
      return { col, row };
    },
    [containerRef, panel]
  );

  const handleDragOver = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      if (!isDesignMode || !canMutate || !panel) return;
      if (!Array.from(e.dataTransfer.types).includes(SIM_PALETTE_DRAG_MIME)) {
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';

      const cell = resolveGridCellFromClientPoint(e.clientX, e.clientY);
      const hoveredGroup = cell
        ? findContainingGroup(
            { col: cell.col, row: cell.row, w: 1, h: 1 },
            panel.widgets
          )
        : null;
      setDragHoverGroupId(hoveredGroup?.id ?? null);
    },
    [canMutate, isDesignMode, panel, resolveGridCellFromClientPoint, setDragHoverGroupId]
  );

  const handleDragLeave = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      const related = e.relatedTarget as Node | null;
      if (!related || !e.currentTarget.contains(related)) {
        setDragHoverGroupId(null);
      }
    },
    [setDragHoverGroupId]
  );

  const handleDrop = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      if (!isDesignMode || !canMutate || !panel) return;
      const raw = e.dataTransfer.getData(SIM_PALETTE_DRAG_MIME);
      setDragHoverGroupId(null);
      if (!raw) return;
      e.preventDefault();

      const payload = parsePaletteDragPayload(raw);
      if (!payload) return;

      const cell = resolveGridCellFromClientPoint(e.clientX, e.clientY) ?? {
        col: 0,
        row: 0,
      };
      const hoveredGroup =
        payload.kind !== 'group'
          ? findContainingGroup(
              { col: cell.col, row: cell.row, w: 1, h: 1 },
              panel.widgets
            )
          : null;
      onDropPayload(payload, cell, hoveredGroup?.id ?? null);
    },
    [canMutate, isDesignMode, onDropPayload, panel, resolveGridCellFromClientPoint, setDragHoverGroupId]
  );

  return {
    resolveGridCellFromClientPoint,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}

// ─── RUN mode: configured button hotkeys ─────────────────────────────────────

export function useRunModeButtonHotkeys({
  enabled,
  widgets,
  runtimeBus,
}: {
  enabled: boolean;
  widgets: readonly SimulationWidgetDto[];
  runtimeBus: SimulationRuntimeBus;
}): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const matchButtons = (e: KeyboardEvent): SimulationWidgetDto[] =>
      widgets.filter(
        (w) =>
          w.kind === 'button' &&
          w.binding !== null &&
          Boolean(w.config.hotkey) &&
          matchesConfiguredHotkey(w.config.hotkey, e)
      );

    const onRunKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (
        isEditableActiveElement(document.activeElement) ||
        isEditableActiveElement(e.target as Element | null)
      ) {
        return;
      }

      const matchedButtons = matchButtons(e);
      if (matchedButtons.length === 0) return;

      e.preventDefault();
      for (const btn of matchedButtons) {
        runtimeBus.triggerButtonHotkeyDown(btn.id);
      }
    };

    const onRunKeyUp = (e: KeyboardEvent) => {
      const matchedButtons = matchButtons(e);
      if (matchedButtons.length === 0) return;

      const editableFocused =
        isEditableActiveElement(document.activeElement) ||
        isEditableActiveElement(e.target as Element | null);
      if (!editableFocused) {
        e.preventDefault();
      }
      for (const btn of matchedButtons) {
        runtimeBus.triggerButtonHotkeyUp(btn.id);
      }
    };

    window.addEventListener('keydown', onRunKeyDown);
    window.addEventListener('keyup', onRunKeyUp);
    return () => {
      window.removeEventListener('keydown', onRunKeyDown);
      window.removeEventListener('keyup', onRunKeyUp);
    };
  }, [enabled, runtimeBus, widgets]);
}
