/**
 * Widget-level editing actions of the UDS panel. Layout rules (free-slot search, group placement,
 * duplicate placement) are the shared Simulation helpers; only the widget payload differs.
 */
import type {
  SimulationWidgetConfigDto,
  SimulationWidgetDto,
  SimulationWidgetKind,
} from '../../../types/simulation';
import type { UdsReadBinding, UdsWidgetDto } from '../../../types/uds';
import { planWidgetCopyLayout } from '../../simulation/instrumentGridInteractions';
import {
  createClientUid,
  placeWidgetInsideGroup,
} from '../../simulation/virtualCanPacking';
import { withDerivedBinding } from './udsBinding';
import { createUdsWidget, udsPanelStore } from './udsInstrumentStore';

function activePanel() {
  const s = udsPanelStore.getSnapshot();
  return s.panels.find((p) => p.id === s.activePanelId) ?? null;
}

export interface AddUdsWidgetOptions {
  title?: string;
  readOverride?: Partial<UdsReadBinding>;
  configOverride?: Partial<SimulationWidgetConfigDto>;
  groupId?: string | null;
  preferredCell?: { col: number; row: number };
  /** Absolute drop position (non-group drop). */
  dropCell?: { col: number; row: number };
  select?: boolean;
}

export function addUdsWidget(kind: SimulationWidgetKind, options: AddUdsWidgetOptions = {}): void {
  const panel = activePanel();
  if (!panel) return;
  const created = createUdsWidget(
    kind,
    panel.widgets,
    panel.gridCols,
    options.readOverride,
    options.configOverride
  );
  const base: UdsWidgetDto = options.title ? { ...created, title: options.title } : created;

  const targetGroup =
    kind !== 'group' && options.groupId
      ? (panel.widgets.find((w) => w.id === options.groupId && w.kind === 'group') ?? null)
      : null;

  if (!targetGroup) {
    const widget: UdsWidgetDto = options.dropCell
      ? {
          ...base,
          layout: {
            ...base.layout,
            col: Math.max(0, Math.min(panel.gridCols - base.layout.w, options.dropCell.col)),
            row: Math.max(0, Math.min(399, options.dropCell.row)),
          },
        }
      : base;
    udsPanelStore.mutateActivePanel((p) => ({ ...p, widgets: [...p.widgets, widget] }));
    if (options.select !== false) udsPanelStore.selectWidget(widget.id);
    return;
  }

  const { childLayout, updatedGroupLayout } = placeWidgetInsideGroup(
    targetGroup,
    panel.widgets,
    base.layout.w,
    base.layout.h,
    panel.gridCols,
    options.preferredCell
  );
  const placed: UdsWidgetDto = { ...base, layout: childLayout };
  udsPanelStore.mutateActivePanel((p) => ({
    ...p,
    widgets: [
      ...p.widgets.map((w) => (w.id === targetGroup.id ? { ...w, layout: updatedGroupLayout } : w)),
      placed,
    ],
  }));
  if (options.select !== false) udsPanelStore.selectWidget(placed.id);
}

/**
 * Applies a shared-inspector edit. The inspector edits the Simulation view of the widget
 * (title, kind, accent, layout, config); UDS bindings are carried over and `binding` is re-derived.
 */
export function updateUdsWidget(
  widgetId: string,
  updater: (prev: SimulationWidgetDto) => SimulationWidgetDto
): void {
  udsPanelStore.mutateActivePanel((p) => ({
    ...p,
    widgets: p.widgets.map((w) => {
      if (w.id !== widgetId) return w;
      const next = updater(w);
      return withDerivedBinding({ ...next, udsRead: w.udsRead, udsWrite: w.udsWrite });
    }),
  }));
}

export function patchUdsBindings(
  widgetId: string,
  patch: Partial<Pick<UdsWidgetDto, 'udsRead' | 'udsWrite'>>
): void {
  udsPanelStore.mutateActivePanel((p) => ({
    ...p,
    widgets: p.widgets.map((w) => (w.id === widgetId ? withDerivedBinding({ ...w, ...patch }) : w)),
  }));
}

export function duplicateUdsWidget(widgetId: string): void {
  const panel = activePanel();
  const target = panel?.widgets.find((w) => w.id === widgetId);
  if (!panel || !target) return;
  const { parentGroup, copyLayout, updatedGroupLayout } = planWidgetCopyLayout(
    target,
    panel.widgets,
    panel.gridCols
  );
  const copy: UdsWidgetDto = {
    ...target,
    id: createClientUid(`w-${target.kind}`),
    title: `${target.title} (Copy)`,
    layout: copyLayout,
    udsRead: target.udsRead ? { ...target.udsRead } : null,
    udsWrite: target.udsWrite ? { ...target.udsWrite } : null,
    config: {
      ...target.config,
      options: target.config.options?.map((o) => ({ ...o })),
      enumMap: target.config.enumMap ? { ...target.config.enumMap } : undefined,
    },
  };
  const copyDerived = withDerivedBinding(copy);
  udsPanelStore.mutateActivePanel((p) => ({
    ...p,
    widgets: [
      ...p.widgets.map((w) =>
        parentGroup && updatedGroupLayout && w.id === parentGroup.id
          ? { ...w, layout: updatedGroupLayout }
          : w
      ),
      copyDerived,
    ],
  }));
  udsPanelStore.selectWidget(copyDerived.id);
}

export function deleteUdsWidget(widgetId: string): void {
  udsPanelStore.mutateActivePanel((p) => ({
    ...p,
    widgets: p.widgets.filter((w) => w.id !== widgetId),
  }));
  if (udsPanelStore.getSnapshot().selectedWidgetId === widgetId) {
    udsPanelStore.selectWidget(null);
  }
}

export function moveUdsWidgetIntoGroup(widgetId: string, groupId: string): void {
  udsPanelStore.mutateActivePanel((p) => {
    const moving = p.widgets.find((w) => w.id === widgetId && w.kind !== 'group');
    const targetGroup = p.widgets.find((w) => w.id === groupId && w.kind === 'group');
    if (!moving || !targetGroup) return p;
    const others = p.widgets.filter((w) => w.id !== widgetId);
    const { childLayout, updatedGroupLayout } = placeWidgetInsideGroup(
      targetGroup,
      others,
      moving.layout.w,
      moving.layout.h,
      p.gridCols
    );
    return {
      ...p,
      widgets: p.widgets.map((w) => {
        if (w.id === moving.id) return { ...w, layout: childLayout };
        if (w.id === targetGroup.id) return { ...w, layout: updatedGroupLayout };
        return w;
      }),
    };
  });
}
