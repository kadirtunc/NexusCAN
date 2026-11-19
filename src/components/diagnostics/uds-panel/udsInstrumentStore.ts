import { useSyncExternalStore } from 'react';
import type { TranslationKey } from '../../../i18n';
import type {
  SimulationWidgetConfigDto,
  SimulationWidgetKind,
} from '../../../types/simulation';
import type {
  UdsPanelDto,
  UdsReadBinding,
  UdsWidgetDto,
  UdsWriteBinding,
} from '../../../types/uds';
import {
  createClientUid,
  createDefaultWidget,
} from '../../simulation/virtualCanPacking';
import { withDerivedBinding } from './udsBinding';
import { cloneUdsPanelWithNewIds } from './udsPanelSanitize';
import { diagnosticsStore } from '../../../store/diagnosticsStore';

// ─── State ───────────────────────────────────────────────────────────────────

export type UdsPanelMode = 'design' | 'run';

export interface UdsPanelNotice {
  tone: 'error' | 'warning' | 'info';
  key: TranslationKey;
  params?: Record<string, string | number>;
  /** Monotonic id so identical consecutive notices are still re-announced. */
  seq: number;
}

export type UdsPanelView = 'list' | 'editor';

export interface UdsPanelState {
  panels: UdsPanelDto[];
  /** Panel directory (`list`) vs. the Design / Run editor of the active panel (`editor`). */
  view: UdsPanelView;
  /** JSON of every panel as of the last project save / load (unsaved-changes dot). */
  savedSnapshots: Readonly<Record<string, string>>;
  activePanelId: string | null;
  mode: UdsPanelMode;
  selectedWidgetId: string | null;
  /** Panel-wide default poll interval (widgets may override with `udsRead.pollMs`). */
  pollIntervalMs: number;
  /** Read-only mirror of the global `diagnosticsStore.mockMode` (single source of truth: the Demo switch). */
  mockMode: boolean;
  notice: UdsPanelNotice | null;
}

// ─── Default bindings ────────────────────────────────────────────────────────

export function defaultUdsRead(): UdsReadBinding {
  return {
    service: 'read_did',
    did: 'F190',
    address: '20004800',
    byteOffset: 0,
    byteLen: 2,
    signed: false,
    factor: 1,
    offset: 0,
    unit: '',
    min: 0,
    max: 65535,
    decimals: 0,
    pollMs: 0,
  };
}

export function defaultUdsWrite(): UdsWriteBinding {
  return {
    service: 'write_did',
    did: 'F190',
    address: '20004800',
    ioOption: '03',
    byteOffset: 0,
    byteLen: 1,
    factor: 1,
    offset: 0,
  };
}

const READ_KINDS: ReadonlySet<SimulationWidgetKind> = new Set<SimulationWidgetKind>([
  'gauge',
  'bar',
  'numeric',
  'led',
  'enum_badge',
  'graph',
  'checkbox',
  'combobox',
  'slider',
]);
const WRITE_KINDS: ReadonlySet<SimulationWidgetKind> = new Set<SimulationWidgetKind>([
  'button',
  'checkbox',
  'combobox',
  'slider',
]);

export function kindUsesUdsRead(kind: SimulationWidgetKind): boolean {
  return READ_KINDS.has(kind);
}
export function kindUsesUdsWrite(kind: SimulationWidgetKind): boolean {
  return WRITE_KINDS.has(kind);
}

/** New widget from the shared Simulation defaults (layout / config / accent) + UDS bindings. */
export function createUdsWidget(
  kind: SimulationWidgetKind,
  existing: readonly UdsWidgetDto[],
  gridCols: number,
  readOverride?: Partial<UdsReadBinding>,
  configOverride?: Partial<SimulationWidgetConfigDto>
): UdsWidgetDto {
  const base = createDefaultWidget(kind, existing, gridCols, null, null);
  const widget: UdsWidgetDto = {
    ...base,
    udsRead: kindUsesUdsRead(kind) ? { ...defaultUdsRead(), ...readOverride } : null,
    udsWrite: kindUsesUdsWrite(kind) ? defaultUdsWrite() : null,
  };
  if (kind === 'textbox') {
    // Text writes always ask for confirmation by default; the write target follows the read DID.
    widget.config = { ...widget.config, confirmBeforeSend: true, ...configOverride };
    if (widget.udsRead && widget.udsWrite) {
      widget.udsWrite = { ...widget.udsWrite, did: widget.udsRead.did, address: widget.udsRead.address };
    }
    return withDerivedBinding(widget);
  }
  if (configOverride) widget.config = { ...widget.config, ...configOverride };
  if (widget.udsRead && readOverride) {
    const r = widget.udsRead;
    widget.config = { ...widget.config, min: r.min, max: r.max };
  }
  return withDerivedBinding(widget);
}

// ─── Starter panel (Powertrain Monitor) ──────────────────────────────────────

function starterWidgets(): UdsWidgetDto[] {
  const mk = (w: Omit<UdsWidgetDto, 'id' | 'binding'>): UdsWidgetDto =>
    withDerivedBinding({ ...w, id: createClientUid(`w-${w.kind}`), binding: null });

  return [
    mk({
      kind: 'gauge',
      title: 'Engine RPM',
      accentColor: 'cyan',
      layout: { col: 0, row: 0, w: 6, h: 5 },
      udsRead: { ...defaultUdsRead(), did: 'F105', unit: 'RPM', min: 0, max: 8000, decimals: 0 },
      udsWrite: null,
      config: { min: 0, max: 8000, warnHigh: 6000, critHigh: 7500, showNeedle: true, showDigital: true, majorTicks: 8 },
    }),
    mk({
      kind: 'gauge',
      title: 'Coolant Temp',
      accentColor: 'amber',
      layout: { col: 6, row: 0, w: 6, h: 5 },
      udsRead: { ...defaultUdsRead(), did: 'F106', unit: '°C', min: 0, max: 130, decimals: 1 },
      udsWrite: null,
      config: { min: 0, max: 130, warnHigh: 110, critHigh: 120, showNeedle: true, showDigital: true },
    }),
    mk({
      kind: 'numeric',
      title: 'Vehicle Speed',
      accentColor: 'emerald',
      layout: { col: 12, row: 0, w: 4, h: 3 },
      udsRead: { ...defaultUdsRead(), did: 'F107', unit: 'km/h', min: 0, max: 300, decimals: 0 },
      udsWrite: null,
      config: { min: 0, max: 300, fontSize: 'lg' },
    }),
    mk({
      kind: 'bar',
      title: 'Battery Voltage',
      accentColor: 'steel',
      layout: { col: 16, row: 0, w: 8, h: 3 },
      udsRead: { ...defaultUdsRead(), did: 'F108', unit: 'V', min: 10, max: 16, decimals: 1 },
      udsWrite: null,
      config: { min: 10, max: 16, warnLow: 11.5, critLow: 10.5, orientation: 'horizontal', showPeakHold: true },
    }),
    mk({
      kind: 'led',
      title: 'Fan Relay',
      accentColor: 'cyan',
      layout: { col: 12, row: 3, w: 4, h: 2 },
      udsRead: { ...defaultUdsRead(), did: '2201', byteLen: 1, min: 0, max: 1, decimals: 0 },
      udsWrite: null,
      config: { ledOperator: 'gte', ledThreshold: 1, onLabel: 'ON', offLabel: 'OFF' },
    }),
    mk({
      kind: 'led',
      title: 'A/C Relay',
      accentColor: 'blue',
      layout: { col: 16, row: 3, w: 4, h: 2 },
      udsRead: { ...defaultUdsRead(), did: '2202', byteLen: 1, min: 0, max: 1, decimals: 0 },
      udsWrite: null,
      config: { ledOperator: 'gte', ledThreshold: 1, onLabel: 'ON', offLabel: 'OFF' },
    }),
    mk({
      kind: 'button',
      title: 'Fan Relay ON',
      accentColor: 'cyan',
      layout: { col: 20, row: 3, w: 4, h: 2 },
      udsRead: null,
      udsWrite: { ...defaultUdsWrite(), did: '2201', byteLen: 1, service: 'write_did' },
      config: { buttonMode: 'momentary', pressValue: 1, releaseValue: 0, buttonLabel: 'FAN ON', min: 0, max: 1 },
    }),
  ];
}

function makeStarterPanel(): UdsPanelDto {
  const now = new Date().toISOString();
  return {
    id: createClientUid('uds-pan'),
    name: 'Powertrain Monitor',
    description: 'Engine RPM, Coolant, Speed, Battery',
    gridCols: 24,
    rowHeightPx: 42,
    targetDatabaseId: null,
    widgets: starterWidgets(),
    generators: [],
    createdAt: now,
    updatedAt: now,
  };
}

// ─── Store ───────────────────────────────────────────────────────────────────

class UdsPanelStore {
  private s: UdsPanelState;
  private readonly listeners = new Set<() => void>();
  private noticeSeq = 0;

  private readonly mutationListeners = new Set<() => void>();

  constructor() {
    this.s = {
      panels: [],
      view: 'list',
      savedSnapshots: {},
      activePanelId: null,
      mode: 'design',
      selectedWidgetId: null,
      pollIntervalMs: 1000,
      mockMode: diagnosticsStore.getState().mockMode,
      notice: null,
    };
    // Single source of truth: follow the global Diagnostics Demo switch.
    diagnosticsStore.subscribe(() => {
      const mock = diagnosticsStore.getState().mockMode;
      if (mock !== this.s.mockMode) this.emit({ mockMode: mock });
    });
  }

  public getSnapshot = (): UdsPanelState => this.s;

  public subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  private emit(next: Partial<UdsPanelState>): void {
    this.s = { ...this.s, ...next };
    for (const cb of this.listeners) cb();
  }

  /** Persistence hook: called after every USER edit of the panel set (not after restore / clear / markSaved). */
  public onMutation(listener: () => void): () => void {
    this.mutationListeners.add(listener);
    return () => {
      this.mutationListeners.delete(listener);
    };
  }

  private touch(): void {
    for (const cb of this.mutationListeners) cb();
  }

  // Project persistence

  /** Deep copy for `NexusProjectFileV1.diagnosticPanels`. */
  public exportForProject(): UdsPanelDto[] {
    return JSON.parse(JSON.stringify(this.s.panels)) as UdsPanelDto[];
  }

  /** Project open: replaces all panels (already sanitized). Never starts polling; lands on the list in Design mode. */
  public restoreFromProject(panels: readonly UdsPanelDto[]): void {
    const copy = JSON.parse(JSON.stringify(panels)) as UdsPanelDto[];
    this.emit({
      panels: copy,
      view: 'list',
      activePanelId: null,
      mode: 'design',
      selectedWidgetId: null,
      savedSnapshots: snapshotsOf(copy),
    });
  }

  public clearAll(): void {
    this.emit({
      panels: [],
      view: 'list',
      activePanelId: null,
      mode: 'design',
      selectedWidgetId: null,
      savedSnapshots: {},
      notice: null,
    });
  }

  /** Project save: the given (exported) panels are now the saved baseline. */
  public markSaved(panels: readonly UdsPanelDto[]): void {
    this.emit({ savedSnapshots: snapshotsOf(panels) });
  }

  // Panels

  public enterPanel(id: string, mode: UdsPanelMode): void {
    if (!this.s.panels.some((p) => p.id === id)) return;
    this.emit({ activePanelId: id, view: 'editor', mode, selectedWidgetId: null });
  }

  public backToList(): void {
    this.emit({ view: 'list', mode: 'design', selectedWidgetId: null });
  }

  public duplicatePanel(id: string): void {
    const src = this.s.panels.find((p) => p.id === id);
    if (!src) return;
    const copy = cloneUdsPanelWithNewIds(src, `${src.name} (Copy)`);
    this.emit({ panels: [...this.s.panels, copy] });
    this.touch();
  }

  /** Adds an already sanitized panel (fresh ids) from a `.nexusdiagpanel.json` import. */
  public addImportedPanel(panel: UdsPanelDto): void {
    this.emit({ panels: [...this.s.panels, panel] });
    this.touch();
  }

  public createStarterPanel(name: string): void {
    const panel = { ...makeStarterPanel(), name };
    this.emit({ panels: [...this.s.panels, panel] });
    this.touch();
  }

  public createPanel(name: string, description = ''): string {
    const now = new Date().toISOString();
    const panel: UdsPanelDto = {
      id: createClientUid('uds-pan'),
      name,
      description,
      gridCols: 24,
      rowHeightPx: 42,
      targetDatabaseId: null,
      widgets: [],
      generators: [],
      createdAt: now,
      updatedAt: now,
    };
    this.emit({ panels: [...this.s.panels, panel] });
    this.touch();
    return panel.id;
  }

  public deletePanel(id: string): void {
    const panels = this.s.panels.filter((p) => p.id !== id);
    const activePanelId =
      this.s.activePanelId === id ? (panels[0]?.id ?? null) : this.s.activePanelId;
    this.emit({
      panels,
      activePanelId,
      selectedWidgetId: null,
      view: activePanelId === null ? 'list' : this.s.view,
    });
    this.touch();
  }

  public renamePanel(id: string, name: string, description?: string): void {
    this.emit({
      panels: this.s.panels.map((p) =>
        p.id === id
          ? {
              ...p,
              name,
              description: description ?? p.description,
              updatedAt: new Date().toISOString(),
            }
          : p
      ),
    });
    this.touch();
  }

  public setActivePanel(id: string): void {
    this.emit({ activePanelId: id, selectedWidgetId: null });
  }

  /** Same contract as the Simulation workbench `mutateActivePanel`. */
  public mutateActivePanel = (updater: (prev: UdsPanelDto) => UdsPanelDto): void => {
    const id = this.s.activePanelId;
    if (!id) return;
    this.emit({
      panels: this.s.panels.map((p) =>
        p.id === id ? { ...updater(p), updatedAt: new Date().toISOString() } : p
      ),
    });
    this.touch();
  };

  // UI state

  public selectWidget = (id: string | null): void => {
    if (this.s.selectedWidgetId !== id) this.emit({ selectedWidgetId: id });
  };

  public setMode(mode: UdsPanelMode): void {
    this.emit({ mode, selectedWidgetId: mode === 'run' ? null : this.s.selectedWidgetId });
  }

  public setPollInterval(ms: number): void {
    this.emit({ pollIntervalMs: ms });
  }

  public notify(
    tone: UdsPanelNotice['tone'],
    key: TranslationKey,
    params?: Record<string, string | number>
  ): void {
    this.noticeSeq += 1;
    this.emit({ notice: { tone, key, params, seq: this.noticeSeq } });
  }

  public dismissNotice(): void {
    if (this.s.notice) this.emit({ notice: null });
  }
}

export const udsPanelStore = new UdsPanelStore();

function snapshotsOf(panels: readonly UdsPanelDto[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of panels) out[p.id] = JSON.stringify(p);
  return out;
}

/** Panels whose content differs from the last project save (new panels count as unsaved). */
export function computeUdsDirtyById(
  panels: readonly UdsPanelDto[],
  saved: Readonly<Record<string, string>>
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const p of panels) out[p.id] = saved[p.id] !== JSON.stringify(p);
  return out;
}

export function useUdsPanelStore(): UdsPanelState {
  return useSyncExternalStore(
    udsPanelStore.subscribe,
    udsPanelStore.getSnapshot,
    udsPanelStore.getSnapshot
  );
}
