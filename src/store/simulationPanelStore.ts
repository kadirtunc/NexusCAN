import { useSyncExternalStore } from 'react';
import { logUiDebugEvent } from './debugConsoleStore';
import {
  apiStopPeriodicTx,
  apiTransmitSignalFrame,
} from '../services/ipcClient';
import { registerTxSource } from './txSources';
import type { DatabaseSchemaDto, MessageSchemaDto, SignalSchemaDto } from '../types/netdb';
import type {
  NexusSimulationPanelFileV1,
  SimulationGeneratorSpecDto,
  SimulationPanelDto,
  SimulationSignalBindingDto,
  SimulationWidgetDto,
  SimulationWidgetKind,
  SimulationWidgetLayoutDto,
} from '../types/simulation';
import { databaseStore } from './databaseStore';
import { telemetryStore } from './telemetryStore';

export function makeBindingSignalKey(
  busId: number,
  messageKey: string,
  signalName: string,
): string {
  return `${busId >>> 0}:${messageKey}:${signalName}`;
}

export interface SimulationPanelStoreState {
  panels: readonly SimulationPanelDto[];
  activePanelId: string | null;
  editorMode: 'DESIGN' | 'RUN';
  executionBusMode: 'VIRTUAL' | 'BUS_TX';
  selectedWidgetId: string | null;
  virtualSignalValues: Readonly<Record<string, number>>;
  peakHoldValues: Readonly<Record<string, number>>;
  configRev: number;
  showGeneratorsDrawer: boolean;
  showInspectorDrawer: boolean;
}

const MAX_GRAPH_POINTS = 600;

interface GraphPointSeries {
  times: number[];
  values: number[];
}

const graphSeriesMap = new Map<string, GraphPointSeries>();
const activeStimulusJobIds = new Set<number>();

let currentState: SimulationPanelStoreState = {
  panels: [],
  activePanelId: null,
  editorMode: 'DESIGN',
  executionBusMode: 'VIRTUAL',
  selectedWidgetId: null,
  virtualSignalValues: {},
  peakHoldValues: {},
  configRev: 0,
  showGeneratorsDrawer: false,
  showInspectorDrawer: true,
};

const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function cloneWidgetConfig(
  config: SimulationWidgetDto['config']
): SimulationWidgetDto['config'] {
  return {
    ...config,
    ...(config.cycleOptions
      ? { cycleOptions: config.cycleOptions.map((opt) => ({ ...opt })) }
      : {}),
    ...(config.options
      ? { options: config.options.map((opt) => ({ ...opt })) }
      : {}),
    ...(config.extraBindings
      ? { extraBindings: config.extraBindings.map((b) => ({ ...b })) }
      : {}),
    ...(config.enumMap ? { enumMap: { ...config.enumMap } } : {}),
    ...(config.lonBinding ? { lonBinding: { ...config.lonBinding } } : {}),
    ...(config.headingBinding
      ? { headingBinding: { ...config.headingBinding } }
      : {}),
    ...(config.speedBinding
      ? { speedBinding: { ...config.speedBinding } }
      : {}),
  };
}

// ============================================================================
// 60 FPS Generator & Osiloskop Animation Loop
// ============================================================================

let rafId: number | null = null;
let lastTickSec = 0;

function evaluateWaveform(
  waveform: SimulationGeneratorSpecDto['waveform'],
  min: number,
  max: number,
  constantValue: number,
  freqHz: number,
  tSec: number,
): number {
  const amp = (max - min) / 2;
  const mid = min + amp;
  const f = Math.max(0.01, freqHz);

  switch (waveform) {
    case 'constant':
      return constantValue;
    case 'sine':
      return mid + amp * Math.sin(2 * Math.PI * f * tSec);
    case 'triangle': {
      const phase = (tSec * f) % 1;
      return min + 2 * amp * (phase < 0.5 ? phase * 2 : 2 * (1 - phase));
    }
    case 'sawtooth': {
      const phase = (tSec * f) % 1;
      return min + 2 * amp * phase;
    }
    case 'square': {
      const phase = (tSec * f) % 1;
      return phase < 0.5 ? max : min;
    }
    default:
      return constantValue;
  }
}

function simulationTick(nowMs: number): void {
  const activePanel = currentState.panels.find((p) => p.id === currentState.activePanelId);
  if (!activePanel) {
    rafId = requestAnimationFrame(simulationTick);
    return;
  }

  const isPanelsTab = databaseStore.getState().activeDocTab === 'panels';
  const hasActiveGenerators =
    currentState.editorMode === 'RUN' && activePanel.generators.some((g) => g.enabled);

  if (!isPanelsTab && !hasActiveGenerators) {
    rafId = requestAnimationFrame(simulationTick);
    return;
  }

  const tSec = nowMs / 1000;
  if (lastTickSec === 0) {
    lastTickSec = tSec;
  }

  let nextVirtual: Record<string, number> | null = null;
  let nextPeak: Record<string, number> | null = null;

  // 1. Evaluate generators if in RUN mode
  if (hasActiveGenerators) {
    for (const gen of activePanel.generators) {
      if (!gen.enabled) continue;
      const key = makeBindingSignalKey(
        gen.binding.busId,
        gen.binding.messageKey,
        gen.binding.signalName,
      );
      const val = evaluateWaveform(
        gen.waveform,
        gen.min,
        gen.max,
        gen.constantValue,
        gen.frequencyHz,
        tSec,
      );
      if (currentState.virtualSignalValues[key] !== val) {
        if (!nextVirtual) {
          nextVirtual = { ...currentState.virtualSignalValues };
        }
        nextVirtual[key] = val;
      }
    }
  }

  if (nextVirtual) {
    currentState = {
      ...currentState,
      virtualSignalValues: nextVirtual,
    };
  }

  // 2. Sample values for Graph Widgets & Peak Holds in active panel
  for (const widget of activePanel.widgets) {
    if (!widget.binding) continue;
    const key = makeBindingSignalKey(
      widget.binding.busId,
      widget.binding.messageKey,
      widget.binding.signalName,
    );
    const currentVal = simulationPanelStore.resolveLiveOrVirtualValue(widget.binding);

    // Peak hold tracking
    if (widget.kind === 'bar' && widget.config.showPeakHold) {
      const curPeak = (nextPeak ?? currentState.peakHoldValues)[key];
      if (curPeak === undefined || currentVal > curPeak) {
        if (!nextPeak) {
          nextPeak = { ...currentState.peakHoldValues };
        }
        nextPeak[key] = currentVal;
      }
    }

    // Graph widget sample recording
    if (widget.kind === 'graph') {
      recordGraphPoint(key, tSec, currentVal);
      if (widget.config.extraBindings) {
        for (const extra of widget.config.extraBindings) {
          const extraKey = makeBindingSignalKey(extra.busId, extra.messageKey, extra.signalName);
          const extraVal = simulationPanelStore.resolveLiveOrVirtualValue(extra);
          recordGraphPoint(extraKey, tSec, extraVal);
        }
      }
    }
  }

  if (nextPeak) {
    currentState = {
      ...currentState,
      peakHoldValues: nextPeak,
    };
  }

  if (nextVirtual || nextPeak) {
    emitChange();
  }

  lastTickSec = tSec;
  rafId = requestAnimationFrame(simulationTick);
}

function recordGraphPoint(key: string, tSec: number, val: number): void {
  let series = graphSeriesMap.get(key);
  if (!series) {
    series = { times: [], values: [] };
    graphSeriesMap.set(key, series);
  }
  series.times.push(tSec);
  series.values.push(val);
  if (series.times.length > MAX_GRAPH_POINTS) {
    series.times.shift();
    series.values.shift();
  }
}

function startAnimationLoop(): void {
  if (typeof window === 'undefined') return;
  if (rafId === null) {
    lastTickSec = 0;
    rafId = requestAnimationFrame(simulationTick);
  }
}

startAnimationLoop();

// ============================================================================
// Store API
// ============================================================================

export const simulationPanelStore = {
  getState(): SimulationPanelStoreState {
    return currentState;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  setEditorMode(mode: 'DESIGN' | 'RUN'): void {
    if (currentState.editorMode === mode) return;
    if (mode === 'DESIGN') {
      this.stopAllPeriodicStimulusJobs();
    }
    currentState = {
      ...currentState,
      editorMode: mode,
    };
    emitChange();
  },

  setExecutionBusMode(busMode: 'VIRTUAL' | 'BUS_TX'): void {
    if (currentState.executionBusMode === busMode) return;
    if (busMode === 'VIRTUAL') {
      this.stopAllPeriodicStimulusJobs();
    }
    currentState = {
      ...currentState,
      executionBusMode: busMode,
    };
    emitChange();
  },

  setSelectedWidgetId(widgetId: string | null): void {
    if (currentState.selectedWidgetId === widgetId) return;
    currentState = {
      ...currentState,
      selectedWidgetId: widgetId,
    };
    emitChange();
  },

  setActivePanelId(panelId: string | null): void {
    if (currentState.activePanelId === panelId) return;
    currentState = {
      ...currentState,
      activePanelId: panelId,
      selectedWidgetId: null,
    };
    emitChange();
  },

  toggleGeneratorsDrawer(): void {
    currentState = {
      ...currentState,
      showGeneratorsDrawer: !currentState.showGeneratorsDrawer,
    };
    emitChange();
  },

  toggleInspectorDrawer(): void {
    currentState = {
      ...currentState,
      showInspectorDrawer: !currentState.showInspectorDrawer,
    };
    emitChange();
  },

  // ==========================================================================
  // Panel CRUD
  // ==========================================================================

  createPanel(name = 'New Instruments Panel', targetDatabaseId: string | null = null): SimulationPanelDto {
    const now = new Date().toISOString();
    const panel: SimulationPanelDto = {
      id: generateUuid(),
      name,
      description: '',
      gridCols: 24,
      rowHeightPx: 42,
      targetDatabaseId,
      widgets: [],
      generators: [],
      createdAt: now,
      updatedAt: now,
    };
    currentState = {
      ...currentState,
      panels: [...currentState.panels, panel],
      activePanelId: panel.id,
      selectedWidgetId: null,
      configRev: currentState.configRev + 1,
    };
    emitChange();
    return panel;
  },

  duplicatePanel(panelId: string): SimulationPanelDto | null {
    const source = currentState.panels.find((p) => p.id === panelId);
    if (!source) return null;
    const now = new Date().toISOString();
    const copy: SimulationPanelDto = {
      ...source,
      id: generateUuid(),
      name: `${source.name} (Copy)`,
      widgets: source.widgets.map((w) => ({
        ...w,
        id: generateUuid(),
        layout: { ...w.layout },
        config: cloneWidgetConfig(w.config),
      })),
      generators: source.generators.map((g) => ({
        ...g,
        id: generateUuid(),
        binding: { ...g.binding },
      })),
      createdAt: now,
      updatedAt: now,
    };
    currentState = {
      ...currentState,
      panels: [...currentState.panels, copy],
      activePanelId: copy.id,
      selectedWidgetId: null,
      configRev: currentState.configRev + 1,
    };
    emitChange();
    return copy;
  },

  renamePanel(panelId: string, name: string, description?: string): void {
    currentState = {
      ...currentState,
      panels: currentState.panels.map((p) =>
        p.id === panelId
          ? {
              ...p,
              name: name.trim() || p.name,
              description: description !== undefined ? description : p.description,
              updatedAt: new Date().toISOString(),
            }
          : p,
      ),
      configRev: currentState.configRev + 1,
    };
    emitChange();
  },

  deletePanel(panelId: string): void {
    const remaining = currentState.panels.filter((p) => p.id !== panelId);
    const nextActiveId =
      currentState.activePanelId === panelId
        ? remaining.length > 0
          ? remaining[0].id
          : null
        : currentState.activePanelId;

    currentState = {
      ...currentState,
      panels: remaining,
      activePanelId: nextActiveId,
      selectedWidgetId: null,
      configRev: currentState.configRev + 1,
    };
    emitChange();
  },

  upsertPanelFromCloud(panel: SimulationPanelDto): void {
    const exists = currentState.panels.some((p) => p.id === panel.id);
    let nextPanels: SimulationPanelDto[];
    if (exists) {
      nextPanels = currentState.panels.map((p) => (p.id === panel.id ? panel : p));
    } else {
      nextPanels = [...currentState.panels, panel];
    }
    currentState = {
      ...currentState,
      panels: nextPanels,
      activePanelId: currentState.activePanelId ?? panel.id,
      configRev: currentState.configRev + 1,
    };
    emitChange();
  },

  importPanelFile(file: NexusSimulationPanelFileV1): SimulationPanelDto {
    if (!file || file.schemaVersion !== 1 || !file.panel) {
      throw new Error('Geçersiz .nexuspanel.json dosya formatı (schemaVersion: 1 bekleniyor).');
    }
    const importedPanel: SimulationPanelDto = {
      ...file.panel,
      id: generateUuid(),
      widgets: (file.panel.widgets ?? []).map((w) => ({
        ...w,
        id: generateUuid(),
        layout: { ...w.layout },
        config: cloneWidgetConfig(w.config),
      })),
      generators: (file.panel.generators ?? []).map((g) => ({
        ...g,
        id: generateUuid(),
        binding: { ...g.binding },
      })),
      updatedAt: new Date().toISOString(),
    };
    currentState = {
      ...currentState,
      panels: [...currentState.panels, importedPanel],
      activePanelId: importedPanel.id,
      selectedWidgetId: null,
      configRev: currentState.configRev + 1,
    };
    emitChange();
    return importedPanel;
  },

  exportPanelFile(panelId: string): NexusSimulationPanelFileV1 {
    const p = currentState.panels.find((item) => item.id === panelId);
    if (!p) {
      throw new Error(`Panel bulunamadı: ${panelId}`);
    }
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      panel: p,
    };
  },

  // ==========================================================================
  // Auto-Generate Starter Panel from DBC / KCD Schema
  // ==========================================================================

  generateStarterPanelFromSchema(
    schema: DatabaseSchemaDto,
    busId = 0,
  ): SimulationPanelDto {
    const panelId = generateUuid();
    const now = new Date().toISOString();
    const widgets: SimulationWidgetDto[] = [];

    let curRow = 0;

    // Process messages grouped by ECU or sequentially
    const messages = schema.messages.slice(0, 12); // First 12 representative messages
    for (const msg of messages) {
      if (msg.signalIds.length === 0) continue;

      // Group Header for this message
      const groupWidget: SimulationWidgetDto = {
        id: generateUuid(),
        kind: 'group',
        title: `${msg.name} (${msg.messageKey})`,
        accentColor: 'steel',
        layout: { col: 0, row: curRow, w: 24, h: 1 },
        binding: null,
        config: {
          subtitle: `DLC: ${msg.dlc} • ${msg.isExtended ? '29-bit EXT' : '11-bit STD'} • ${msg.transmitters.join(', ') || 'ECU'}`,
        },
      };
      widgets.push(groupWidget);
      curRow += 1;

      let curCol = 0;
      let maxWidgetHInRow = 1;

      for (const sigId of msg.signalIds) {
        const sig = schema.signals[sigId];
        if (!sig) continue;

        const binding: SimulationSignalBindingDto = {
          busId,
          messageKey: msg.messageKey,
          messageName: msg.name,
          arbId: msg.arbId,
          isExtended: msg.isExtended,
          signalName: sig.name,
          unit: sig.unit || '',
          min: sig.min,
          max: sig.max,
          factor: sig.factor,
          offset: sig.offset,
          decimals: sig.factor < 1 ? 2 : 0,
          color: '#06B6D4',
        };

        const enumKeys = sig.enumTable ? Object.keys(sig.enumTable) : [];
        const isEnum = enumKeys.length > 0;
        const isOneBit = sig.bitLength === 1;

        let kind: SimulationWidgetKind = 'numeric';
        let w = 4;
        let h = 2;
        const config: SimulationWidgetDto['config'] = {
          min: sig.min,
          max: sig.max,
        };

        if (isOneBit) {
          kind = 'led';
          w = 3;
          h = 2;
          config.ledOperator = 'gt';
          config.ledThreshold = 0;
          config.onLabel = 'ACTIVE';
          config.offLabel = 'INACTIVE';
        } else if (isEnum) {
          if (enumKeys.length <= 4) {
            kind = 'enum_badge';
            w = 5;
            h = 2;
            config.enumMap = sig.enumTable ?? undefined;
          } else {
            kind = 'combobox';
            w = 6;
            h = 2;
            config.options = Object.entries(sig.enumTable ?? {}).map(([valStr, label]) => ({
              label: `${valStr}: ${label}`,
              value: Number(valStr),
            }));
          }
        } else if (sig.max - sig.min > 0) {
          // Continuous signal
          if (curCol === 0 && widgets.filter((item) => item.kind === 'gauge').length < 4) {
            kind = 'gauge';
            w = 6;
            h = 4;
            config.showNeedle = true;
            config.showDigital = true;
            config.warnHigh = sig.min + (sig.max - sig.min) * 0.8;
            config.critHigh = sig.min + (sig.max - sig.min) * 0.9;
          } else if (widgets.filter((item) => item.kind === 'slider').length < 3) {
            kind = 'slider';
            w = 6;
            h = 2;
            config.step = sig.factor || 1;
            config.showNumericInput = true;
          } else {
            kind = 'bar';
            w = 5;
            h = 2;
            config.orientation = 'horizontal';
            config.showPeakHold = true;
          }
        }

        // Check if fits in current row of 24 cols
        if (curCol + w > 24) {
          curRow += maxWidgetHInRow;
          curCol = 0;
          maxWidgetHInRow = 1;
        }

        const widget: SimulationWidgetDto = {
          id: generateUuid(),
          kind,
          title: sig.name,
          accentColor: isOneBit ? 'emerald' : isEnum ? 'amber' : 'cyan',
          layout: { col: curCol, row: curRow, w, h },
          binding,
          config,
        };
        widgets.push(widget);

        curCol += w;
        if (h > maxWidgetHInRow) {
          maxWidgetHInRow = h;
        }
      }

      curRow += maxWidgetHInRow + 1;
    }

    // Add a master 60 FPS oscilloscope at the bottom
    const continuousWidgets = widgets.filter(
      (w) => w.binding && (w.kind === 'gauge' || w.kind === 'bar' || w.kind === 'slider'),
    );
    if (continuousWidgets.length > 0) {
      const primaryBinding = continuousWidgets[0].binding;
      const extraBindings = continuousWidgets
        .slice(1, 4)
        .map((w) => w.binding)
        .filter((b): b is SimulationSignalBindingDto => b !== null);

      widgets.push({
        id: generateUuid(),
        kind: 'graph',
        title: 'Master Real-Time Waveform Analyzer (60 FPS)',
        accentColor: 'cyan',
        layout: { col: 0, row: curRow, w: 24, h: 5 },
        binding: primaryBinding,
        config: {
          extraBindings,
          timeWindowSec: 10,
          autoScaleY: true,
          showLegend: true,
        },
      });
    }

    const panel: SimulationPanelDto = {
      id: panelId,
      name: `${schema.info.name || 'DBC'} Instruments Dashboard`,
      description: `Auto-generated from ${schema.info.name} (${widgets.length} instruments).`,
      gridCols: 24,
      rowHeightPx: 42,
      targetDatabaseId: null,
      widgets,
      generators: [],
      createdAt: now,
      updatedAt: now,
    };

    currentState = {
      ...currentState,
      panels: [...currentState.panels, panel],
      activePanelId: panel.id,
      selectedWidgetId: null,
      configRev: currentState.configRev + 1,
    };
    emitChange();
    return panel;
  },

  // ==========================================================================
  // Widget CRUD
  // ==========================================================================

  addWidget(kind: SimulationWidgetKind, partial?: Partial<SimulationWidgetDto>): SimulationWidgetDto | null {
    const activePanel = currentState.panels.find((p) => p.id === currentState.activePanelId);
    if (!activePanel) return null;

    let defaultW = 4;
    let defaultH = 2;
    if (kind === 'gauge') {
      defaultW = 6;
      defaultH = 4;
    } else if (kind === 'graph') {
      defaultW = 12;
      defaultH = 4;
    } else if (kind === 'group') {
      defaultW = 24;
      defaultH = 4;
    } else if (kind === 'slider' || kind === 'combobox') {
      defaultW = 6;
      defaultH = 2;
    }

    // Find next available row
    let maxRow = 0;
    for (const w of activePanel.widgets) {
      const bottom = w.layout.row + w.layout.h;
      if (bottom > maxRow) maxRow = bottom;
    }

    const layout: SimulationWidgetLayoutDto = {
      col: 0,
      row: maxRow,
      w: defaultW,
      h: defaultH,
      ...(partial?.layout ?? {}),
    };

    const newWidget: SimulationWidgetDto = {
      id: generateUuid(),
      kind,
      title: partial?.title ?? `New ${kind}`,
      accentColor: partial?.accentColor ?? 'cyan',
      layout,
      binding: partial?.binding ?? null,
      config: { ...(partial?.config ?? {}) },
    };

    const updatedPanel: SimulationPanelDto = {
      ...activePanel,
      widgets: [...activePanel.widgets, newWidget],
      updatedAt: new Date().toISOString(),
    };

    currentState = {
      ...currentState,
      panels: currentState.panels.map((p) => (p.id === activePanel.id ? updatedPanel : p)),
      selectedWidgetId: newWidget.id,
      configRev: currentState.configRev + 1,
    };
    emitChange();
    return newWidget;
  },

  updateWidget(widgetId: string, patch: Partial<SimulationWidgetDto>): void {
    const activePanel = currentState.panels.find((p) => p.id === currentState.activePanelId);
    if (!activePanel) return;

    const updatedWidgets = activePanel.widgets.map((w) => {
      if (w.id !== widgetId) return w;
      return {
        ...w,
        ...patch,
        config: patch.config ? { ...w.config, ...patch.config } : w.config,
        layout: patch.layout ? { ...w.layout, ...patch.layout } : w.layout,
      };
    });

    const updatedPanel: SimulationPanelDto = {
      ...activePanel,
      widgets: updatedWidgets,
      updatedAt: new Date().toISOString(),
    };

    currentState = {
      ...currentState,
      panels: currentState.panels.map((p) => (p.id === activePanel.id ? updatedPanel : p)),
      configRev: currentState.configRev + 1,
    };
    emitChange();
  },

  updateWidgetLayout(widgetId: string, layout: SimulationWidgetLayoutDto): void {
    const activePanel = currentState.panels.find((p) => p.id === currentState.activePanelId);
    if (!activePanel) return;

    // Constrain col 0..23, w 1..24
    const clampedCol = Math.max(0, Math.min(23, layout.col));
    const clampedW = Math.max(1, Math.min(24 - clampedCol, layout.w));
    const clampedRow = Math.max(0, layout.row);
    const clampedH = Math.max(1, Math.min(48, layout.h));

    const updatedWidgets = activePanel.widgets.map((w) => {
      if (w.id !== widgetId) return w;
      return {
        ...w,
        layout: {
          col: clampedCol,
          row: clampedRow,
          w: clampedW,
          h: clampedH,
        },
      };
    });

    const updatedPanel: SimulationPanelDto = {
      ...activePanel,
      widgets: updatedWidgets,
      updatedAt: new Date().toISOString(),
    };

    currentState = {
      ...currentState,
      panels: currentState.panels.map((p) => (p.id === activePanel.id ? updatedPanel : p)),
      configRev: currentState.configRev + 1,
    };
    emitChange();
  },

  duplicateWidget(widgetId: string): SimulationWidgetDto | null {
    const activePanel = currentState.panels.find((p) => p.id === currentState.activePanelId);
    if (!activePanel) return null;
    const source = activePanel.widgets.find((w) => w.id === widgetId);
    if (!source) return null;

    const copy: SimulationWidgetDto = {
      ...source,
      id: generateUuid(),
      title: `${source.title} (Copy)`,
      layout: {
        ...source.layout,
        row: source.layout.row + source.layout.h,
      },
      config: cloneWidgetConfig(source.config),
    };

    const updatedPanel: SimulationPanelDto = {
      ...activePanel,
      widgets: [...activePanel.widgets, copy],
      updatedAt: new Date().toISOString(),
    };

    currentState = {
      ...currentState,
      panels: currentState.panels.map((p) => (p.id === activePanel.id ? updatedPanel : p)),
      selectedWidgetId: copy.id,
      configRev: currentState.configRev + 1,
    };
    emitChange();
    return copy;
  },

  removeWidget(widgetId: string): void {
    const activePanel = currentState.panels.find((p) => p.id === currentState.activePanelId);
    if (!activePanel) return;

    const updatedPanel: SimulationPanelDto = {
      ...activePanel,
      widgets: activePanel.widgets.filter((w) => w.id !== widgetId),
      updatedAt: new Date().toISOString(),
    };

    currentState = {
      ...currentState,
      panels: currentState.panels.map((p) => (p.id === activePanel.id ? updatedPanel : p)),
      selectedWidgetId: currentState.selectedWidgetId === widgetId ? null : currentState.selectedWidgetId,
      configRev: currentState.configRev + 1,
    };
    emitChange();
  },

  bindWidgetToSchemaSignal(
    widgetId: string,
    msg: MessageSchemaDto,
    sig: SignalSchemaDto,
    busId = 0,
  ): void {
    const activePanel = currentState.panels.find((p) => p.id === currentState.activePanelId);
    if (!activePanel) return;
    const widget = activePanel.widgets.find((w) => w.id === widgetId);
    if (!widget) return;

    const binding: SimulationSignalBindingDto = {
      busId,
      messageKey: msg.messageKey,
      messageName: msg.name,
      arbId: msg.arbId,
      isExtended: msg.isExtended,
      signalName: sig.name,
      unit: sig.unit || '',
      min: sig.min,
      max: sig.max,
      factor: sig.factor,
      offset: sig.offset,
      decimals: sig.factor < 1 ? 2 : 0,
      color: '#06B6D4',
    };

    const nextConfig = { ...widget.config };
    nextConfig.min = sig.min;
    nextConfig.max = sig.max;
    if (sig.unit) {
      // unit in subtitle or binding
    }

    // Auto-populate enum options if available
    if (sig.enumTable && Object.keys(sig.enumTable).length > 0) {
      if (widget.kind === 'combobox') {
        nextConfig.options = Object.entries(sig.enumTable).map(([valStr, label]) => ({
          label: `${valStr}: ${label}`,
          value: Number(valStr),
        }));
      } else if (widget.kind === 'enum_badge') {
        nextConfig.enumMap = sig.enumTable;
      }
    }

    this.updateWidget(widgetId, {
      title: sig.name,
      binding,
      config: nextConfig,
    });
  },

  // ==========================================================================
  // Generator CRUD
  // ==========================================================================

  addGenerator(gen: Omit<SimulationGeneratorSpecDto, 'id'>): SimulationGeneratorSpecDto | null {
    const activePanel = currentState.panels.find((p) => p.id === currentState.activePanelId);
    if (!activePanel) return null;

    const fullGen: SimulationGeneratorSpecDto = {
      ...gen,
      id: generateUuid(),
    };

    const updatedPanel: SimulationPanelDto = {
      ...activePanel,
      generators: [...activePanel.generators, fullGen],
      updatedAt: new Date().toISOString(),
    };

    currentState = {
      ...currentState,
      panels: currentState.panels.map((p) => (p.id === activePanel.id ? updatedPanel : p)),
      configRev: currentState.configRev + 1,
    };
    emitChange();
    return fullGen;
  },

  updateGenerator(genId: string, patch: Partial<SimulationGeneratorSpecDto>): void {
    const activePanel = currentState.panels.find((p) => p.id === currentState.activePanelId);
    if (!activePanel) return;

    const updatedPanel: SimulationPanelDto = {
      ...activePanel,
      generators: activePanel.generators.map((g) => (g.id === genId ? { ...g, ...patch } : g)),
      updatedAt: new Date().toISOString(),
    };

    currentState = {
      ...currentState,
      panels: currentState.panels.map((p) => (p.id === activePanel.id ? updatedPanel : p)),
      configRev: currentState.configRev + 1,
    };
    emitChange();
  },

  removeGenerator(genId: string): void {
    const activePanel = currentState.panels.find((p) => p.id === currentState.activePanelId);
    if (!activePanel) return;

    const updatedPanel: SimulationPanelDto = {
      ...activePanel,
      generators: activePanel.generators.filter((g) => g.id !== genId),
      updatedAt: new Date().toISOString(),
    };

    currentState = {
      ...currentState,
      panels: currentState.panels.map((p) => (p.id === activePanel.id ? updatedPanel : p)),
      configRev: currentState.configRev + 1,
    };
    emitChange();
  },

  // ==========================================================================
  // Signal Value Resolution & Stimulation
  // ==========================================================================

  resolveLiveOrVirtualValue(binding: SimulationSignalBindingDto | null): number {
    if (!binding) return 0;
    const key = makeBindingSignalKey(binding.busId, binding.messageKey, binding.signalName);

    // In VIRTUAL mode, check virtual signal map first
    if (currentState.executionBusMode === 'VIRTUAL') {
      const virt = currentState.virtualSignalValues[key];
      if (virt !== undefined) return virt;
    }

    // Try reading from live telemetry
    // Scan all matching frames for this CAN message (handles multi-mux rows Bank0..Bank3!)
    const liveFrames = telemetryStore.getFramesSlice().frames;
    const schema = databaseStore.getBusSchema(binding.busId);
    let targetSignalId: number | null = null;
    if (schema) {
      const msg = schema.messages.find(
        (m) =>
          m.messageKey === binding.messageKey ||
          (m.arbId === binding.arbId && m.isExtended === binding.isExtended),
      );
      if (msg) {
        for (const sId of msg.signalIds) {
          const sig = schema.signals[sId];
          if (sig && sig.name === binding.signalName) {
            targetSignalId = sig.signalId;
            break;
          }
        }
      }
    }

    if (targetSignalId !== null) {
      let bestVal: number | null = null;
      let maxTs = -1;
      for (let i = 0; i < liveFrames.length; i++) {
        const f = liveFrames[i];
        if (
          f.busId === binding.busId &&
          (f.messageKey === binding.messageKey ||
            (f.arbId === binding.arbId && f.isExtended === binding.isExtended))
        ) {
          const liveSig = f.signals.find((s) => s.signalId === targetSignalId);
          if (liveSig && f.lastTimestampUs > maxTs) {
            maxTs = f.lastTimestampUs;
            bestVal = liveSig.physicalValue;
          }
        }
      }
      if (bestVal !== null) {
        return bestVal;
      }
    }

    // Fallback to virtual map, then default min
    return currentState.virtualSignalValues[key] ?? binding.min ?? 0;
  },

  getGraphSignalHistory(signalKey: string): GraphPointSeries {
    const series = graphSeriesMap.get(signalKey);
    if (!series) {
      return { times: [], values: [] };
    }
    return series;
  },

  async triggerWidgetStimulus(
    widget: SimulationWidgetDto,
    rawTargetValue: number,
  ): Promise<{ ok: boolean; error?: string }> {
    const binding = widget.binding;
    if (!binding) {
      return { ok: false, error: 'Widget has no signal binding.' };
    }

    // Clamp value to [min, max]
    const min = widget.config.min ?? binding.min;
    const max = widget.config.max ?? binding.max;
    let clampedVal = rawTargetValue;
    if (typeof min === 'number' && typeof max === 'number' && max > min) {
      clampedVal = Math.max(min, Math.min(max, rawTargetValue));
    }

    const key = makeBindingSignalKey(binding.busId, binding.messageKey, binding.signalName);

    // Always update virtual store for instant 60 FPS UI reaction
    currentState = {
      ...currentState,
      virtualSignalValues: {
        ...currentState.virtualSignalValues,
        [key]: clampedVal,
      },
    };
    emitChange();

    // If BUS_TX mode is enabled, transmit to physical CAN bus
    if (currentState.executionBusMode === 'BUS_TX') {
      const header = telemetryStore.getHeaderSlice();
      const bus = header.buses.find((b) => b.busId === binding.busId);

      if (!bus || !bus.connected) {
        return {
          ok: false,
          error: `Bus ${binding.busId + 1} bağlı değil. BUS_TX için bağlantı gerekli.`,
        };
      }
      if (bus.listenOnly) {
        return {
          ok: false,
          error: `Bus ${binding.busId + 1} Listen-Only (Salt Okunur) modunda. Aktif TX için hattı Arm edin.`,
        };
      }
      if (!bus.txArmed) {
        return {
          ok: false,
          error: `Bus ${binding.busId + 1} TX kilidi aktif değil (txArmed: false).`,
        };
      }

      // Collect all known signal values for this message so other signals are preserved
      const schema = databaseStore.getBusSchema(binding.busId);
      const msg = schema?.messages.find(
        (m) =>
          m.messageKey === binding.messageKey ||
          (m.arbId === binding.arbId && m.isExtended === binding.isExtended),
      );

      const signalValues: [number, number][] = [];
      let targetFound = false;

      if (msg) {
        for (const sId of msg.signalIds) {
          const sig = schema?.signals[sId];
          if (!sig) continue;
          if (sig.name === binding.signalName) {
            signalValues.push([sId, clampedVal]);
            targetFound = true;
          } else {
            // Read retained / last known value
            const otherKey = makeBindingSignalKey(binding.busId, binding.messageKey, sig.name);
            const otherVal =
              currentState.virtualSignalValues[otherKey] ??
              this.resolveLiveOrVirtualValue({
                busId: binding.busId,
                messageKey: binding.messageKey,
                messageName: binding.messageName,
                arbId: binding.arbId,
                isExtended: binding.isExtended,
                signalName: sig.name,
                unit: sig.unit,
                min: sig.min,
                max: sig.max,
                factor: sig.factor,
                offset: sig.offset,
                decimals: sig.factor < 1 ? 2 : 0,
                color: '',
              });
            signalValues.push([sId, otherVal]);
          }
        }
      }

      if (!targetFound) {
        signalValues.push([0, clampedVal]);
      }

      try {
        const res = await apiTransmitSignalFrame({
          busId: binding.busId,
          arbId: binding.arbId,
          isExtended: binding.isExtended,
          signalValues,
          periodicMs:
            widget.config.txCycleMs && widget.config.txCycleMs > 0
              ? widget.config.txCycleMs
              : null,
          jobLabel: widget.title || `Sim:${binding.signalName}`,
        });

        if (res.jobId) {
          activeStimulusJobIds.add(res.jobId);
        }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return { ok: true };
  },

  stopAllPeriodicStimulusJobs(): void {
    if (activeStimulusJobIds.size === 0) return;
    for (const jobId of activeStimulusJobIds) {
      apiStopPeriodicTx(jobId).catch(() => undefined);
    }
    activeStimulusJobIds.clear();
    logUiDebugEvent({
      severity: 'warn',
      category: 'TX',
      action: 'simulation.stimulus.stop_all',
      title: 'Simulation Stimulus Stopped',
    });
  },

  // ==========================================================================
  // Project Store Integration
  // ==========================================================================

  exportForProject(): SimulationPanelDto[] {
    return currentState.panels.map((p) => ({
      ...p,
      widgets: p.widgets.map((w) => ({
        ...w,
        layout: { ...w.layout },
        config: cloneWidgetConfig(w.config),
        binding: w.binding ? { ...w.binding } : null,
      })),
      generators: p.generators.map((g) => ({
        ...g,
        binding: { ...g.binding },
      })),
    }));
  },

  restoreFromProject(panels: readonly SimulationPanelDto[]): void {
    this.stopAllPeriodicStimulusJobs();
    currentState = {
      ...currentState,
      panels: [...panels],
      activePanelId: panels.length > 0 ? panels[0].id : null,
      editorMode: 'DESIGN',
      executionBusMode: 'VIRTUAL', // ALWAYS restore in safe VIRTUAL mode
      selectedWidgetId: null,
      virtualSignalValues: {},
      peakHoldValues: {},
      configRev: currentState.configRev + 1,
    };
    emitChange();
  },

  clearAll(): void {
    this.stopAllPeriodicStimulusJobs();
    graphSeriesMap.clear();
    currentState = {
      panels: [],
      activePanelId: null,
      editorMode: 'DESIGN',
      executionBusMode: 'VIRTUAL',
      selectedWidgetId: null,
      virtualSignalValues: {},
      peakHoldValues: {},
      configRev: 0,
      showGeneratorsDrawer: false,
      showInspectorDrawer: true,
    };
    emitChange();
  },
};

// Panic Stop: stop all periodic stimulus jobs started from simulation panel widgets.
registerTxSource('simulation-stimulus', () => simulationPanelStore.stopAllPeriodicStimulusJobs());

export function useSimulationPanelStore(): SimulationPanelStoreState {
  return useSyncExternalStore(
    simulationPanelStore.subscribe,
    simulationPanelStore.getState,
    simulationPanelStore.getState,
  );
}
