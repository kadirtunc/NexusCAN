
import React, { useMemo, useState } from 'react';
import {
  Activity,
  Compass,
  Copy,
  Database,
  Link2,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Unlink,
} from 'lucide-react';
import type {
  DatabaseSchemaDto,
  MessageSchemaDto,
  NetworkDatabaseSummaryDto,
  SignalSchemaDto,
  SimulationAccentColor,
  SimulationComboOptionDto,
  SimulationGeneratorSpecDto,
  SimulationLedOperator,
  SimulationMapTileStyle,
  SimulationSignalBindingDto,
  SimulationWaveformKind,
  SimulationWidgetConfigDto,
  SimulationWidgetDto,
  SimulationWidgetKind,
} from './contracts';
import {
  ACCENT_HEX_MAP,
  TRACE_PALETTE,
  createClientUid,
  enumTableToComboOptions,
  findGnssSiblingsInMessage,
  formatDatabaseDisplayLabel,
  isWidgetInsideGroup,
  signalSchemaToBinding,
  type LoadedSimulationDatabaseEntry,
  type SignalBindingDbMeta,
} from './virtualCanPacking';

const GROUP_QUICK_ADD_OPTIONS: ReadonlyArray<{
  kind: SimulationWidgetKind;
  label: string;
}> = [
  { kind: 'button', label: '+ BUTTON' },
  { kind: 'checkbox', label: '+ CHECKBOX' },
  { kind: 'combobox', label: '+ COMBOBOX' },
  { kind: 'slider', label: '+ SLIDER' },
  { kind: 'gauge', label: '+ GAUGE' },
  { kind: 'bar', label: '+ BAR' },
  { kind: 'numeric', label: '+ NUMERIC' },
  { kind: 'led', label: '+ LED' },
  { kind: 'enum_badge', label: '+ ENUM' },
  { kind: 'graph', label: '+ GRAPH' },
  { kind: 'map', label: '+ MAP' },
];

const ACCENT_OPTIONS: readonly SimulationAccentColor[] = [
  'steel',
  'cyan',
  'emerald',
  'amber',
  'red',
  'blue',
];

const WIDGET_KIND_OPTIONS: ReadonlyArray<{
  value: SimulationWidgetKind;
  label: string;
}> = [
  { value: 'gauge', label: 'GAUGE (240° Dial)' },
  { value: 'bar', label: 'BAR (Level Meter)' },
  { value: 'numeric', label: 'NUMERIC (Digital)' },
  { value: 'led', label: 'LED (Status Lamp)' },
  { value: 'enum_badge', label: 'ENUM_BADGE (Symbolic)' },
  { value: 'graph', label: 'GRAPH (60 FPS Canvas)' },
  { value: 'map', label: 'MAP (OpenStreetMap / GNSS)' },
  { value: 'button', label: 'BUTTON (Momentary/Toggle)' },
  { value: 'checkbox', label: 'CHECKBOX (Switch)' },
  { value: 'combobox', label: 'COMBOBOX (Dropdown)' },
  { value: 'slider', label: 'SLIDER (Range Fader)' },
  { value: 'group', label: 'GROUP (Subsystem Frame)' },
];

const WAVEFORM_OPTIONS: readonly SimulationWaveformKind[] = [
  'sine',
  'triangle',
  'sawtooth',
  'square',
  'constant',
];

interface CatalogSignalPair {
  id: string;
  busSignalKey: string;
  db: NetworkDatabaseSummaryDto;
  busId: number;
  entrySchema: DatabaseSchemaDto;
  msg: MessageSchemaDto;
  sig: SignalSchemaDto;
  labelAll: string;
  labelSingle: string;
}

function formatMessageKey(arbId: number, isExtended: boolean): string {
  const cleanArb = Math.max(0, Math.floor(arbId));
  return `${isExtended ? 'EXT' : 'STD'}:0x${cleanArb.toString(16).toUpperCase()}`;
}

function parseHexOrInt(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const parsed =
    trimmed.startsWith('0x') || trimmed.startsWith('0X')
      ? Number.parseInt(trimmed.slice(2), 16)
      : Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function resolveBindingCatalogId(
  binding: SimulationSignalBindingDto | null | undefined,
  pairs: readonly CatalogSignalPair[]
): string {
  if (!binding) return '';
  if (binding.databaseId) {
    const exact = pairs.find(
      (p) =>
        p.db.id === binding.databaseId &&
        p.msg.messageKey === binding.messageKey &&
        p.sig.name === binding.signalName
    );
    if (exact) return exact.id;
  }
  const byKey = pairs.find(
    (p) =>
      p.msg.messageKey === binding.messageKey &&
      p.sig.name === binding.signalName
  );
  return byKey?.id ?? '';
}

export interface SimulationInspectorSidebarProps {
  canMutate: boolean;
  gridCols: number;
  selectedWidget: SimulationWidgetDto | null;
  allWidgets: readonly SimulationWidgetDto[];
  generators: readonly SimulationGeneratorSpecDto[];
  databases: readonly NetworkDatabaseSummaryDto[];
  loadedDbEntries: readonly LoadedSimulationDatabaseEntry[];
  schema: DatabaseSchemaDto | null;
  onSelectWidget: (widgetId: string) => void;
  onAddWidgetToGroup: (groupId: string, kind: SimulationWidgetKind) => void;
  onMoveWidgetIntoGroup: (widgetId: string, groupId: string) => void;
  onUpdateWidget: (
    widgetId: string,
    updater: (prev: SimulationWidgetDto) => SimulationWidgetDto
  ) => void;
  onDuplicateWidget: (widgetId: string) => void;
  onDeleteWidget: (widgetId: string) => void;
  onUpdateGenerators: (next: SimulationGeneratorSpecDto[]) => void;
}

export function SimulationInspectorSidebar({
  canMutate,
  gridCols,
  selectedWidget,
  allWidgets,
  generators,
  databases,
  loadedDbEntries,
  schema,
  onSelectWidget,
  onAddWidgetToGroup,
  onMoveWidgetIntoGroup,
  onUpdateWidget,
  onDuplicateWidget,
  onDeleteWidget,
  onUpdateGenerators,
}: SimulationInspectorSidebarProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<'inspector' | 'generators'>(
    'inspector'
  );
  const [pickerDbFilter, setPickerDbFilter] = useState<string>('ALL');
  const [pickerQuery, setPickerQuery] = useState<string>('');
  const [extraSignalKeyToAdd, setExtraSignalKeyToAdd] = useState<string>('');
  const [newEnumKey, setNewEnumKey] = useState<string>('0');
  const [newEnumLabel, setNewEnumLabel] = useState<string>('READY');
  const [newOptVal, setNewOptVal] = useState<string>('0');
  const [newOptLabel, setNewOptLabel] = useState<string>('0 : OFF');
  const [moveCandidateWidgetId, setMoveCandidateWidgetId] =
    useState<string>('');

  const groupChildren = useMemo<SimulationWidgetDto[]>(() => {
    if (!selectedWidget || selectedWidget.kind !== 'group') return [];
    return allWidgets.filter((w) => isWidgetInsideGroup(w, selectedWidget));
  }, [allWidgets, selectedWidget]);

  const outsideGroupWidgets = useMemo<SimulationWidgetDto[]>(() => {
    if (!selectedWidget || selectedWidget.kind !== 'group') return [];
    return allWidgets.filter(
      (w) => w.kind !== 'group' && !isWidgetInsideGroup(w, selectedWidget)
    );
  }, [allWidgets, selectedWidget]);

  const effectiveMoveCandidateId = useMemo<string>(() => {
    if (outsideGroupWidgets.length === 0) return '';
    if (outsideGroupWidgets.some((w) => w.id === moveCandidateWidgetId)) {
      return moveCandidateWidgetId;
    }
    return outsideGroupWidgets[0]!.id;
  }, [moveCandidateWidgetId, outsideGroupWidgets]);

  const isAllDbFilter = pickerDbFilter === 'ALL' || !pickerDbFilter;

  const allCatalogPairs = useMemo<CatalogSignalPair[]>(() => {
    const list: CatalogSignalPair[] = [];
    for (const entry of loadedDbEntries) {
      const msgMap = new Map<string, MessageSchemaDto>();
      for (const m of entry.schema.messages) {
        msgMap.set(m.messageKey, m);
      }
      for (const sig of entry.schema.signals) {
        const msg = msgMap.get(sig.messageKey);
        if (!msg) continue;
        const hex = `0x${msg.arbId.toString(16).toUpperCase()}`;
        const baseLabel = `${hex} ${msg.name} -> ${sig.name}${
          sig.unit ? ` [${sig.unit}]` : ''
        }`;
        list.push({
          id: `${entry.db.id}::${msg.messageKey}::${sig.name}`,
          busSignalKey: `${msg.messageKey}::${sig.name}`,
          db: entry.db,
          busId: entry.inferredBusId,
          entrySchema: entry.schema,
          msg,
          sig,
          labelAll: `[${entry.db.name}] ${baseLabel}`,
          labelSingle: baseLabel,
        });
      }
    }
    return list;
  }, [loadedDbEntries]);

  const visibleCatalogPairs = useMemo<CatalogSignalPair[]>(() => {
    if (isAllDbFilter) return allCatalogPairs;
    return allCatalogPairs.filter((p) => p.db.id === pickerDbFilter);
  }, [allCatalogPairs, isAllDbFilter, pickerDbFilter]);

  const filteredCatalogPairs = useMemo<CatalogSignalPair[]>(() => {
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return visibleCatalogPairs;
    return visibleCatalogPairs.filter(
      (p) =>
        p.labelAll.toLowerCase().includes(q) ||
        p.msg.messageKey.toLowerCase().includes(q)
    );
  }, [pickerQuery, visibleCatalogPairs]);

  const boundCatalogEntry = useMemo<LoadedSimulationDatabaseEntry | null>(() => {
    if (!selectedWidget?.binding) return null;
    const b = selectedWidget.binding;
    if (b.databaseId) {
      const exact = loadedDbEntries.find((e) => e.db.id === b.databaseId);
      if (exact) return exact;
    }
    return (
      loadedDbEntries.find((e) =>
        e.schema.signals.some(
          (s) => s.messageKey === b.messageKey && s.name === b.signalName
        )
      ) ?? null
    );
  }, [loadedDbEntries, selectedWidget]);

  const boundSchemaSignal = useMemo<SignalSchemaDto | null>(() => {
    if (!selectedWidget?.binding) return null;
    const b = selectedWidget.binding;
    const sourceSchema = boundCatalogEntry?.schema ?? schema;
    if (!sourceSchema) return null;
    return (
      sourceSchema.signals.find(
        (s) => s.messageKey === b.messageKey && s.name === b.signalName
      ) ?? null
    );
  }, [boundCatalogEntry, schema, selectedWidget]);

  const gnssSiblingsForSelected = useMemo(() => {
    if (
      !selectedWidget ||
      selectedWidget.kind !== 'map' ||
      !selectedWidget.binding
    ) {
      return null;
    }
    const sourceSchema = boundCatalogEntry?.schema ?? schema;
    if (!sourceSchema) return null;
    const msg = sourceSchema.messages.find(
      (m) => m.messageKey === selectedWidget.binding?.messageKey
    );
    if (!msg) return null;
    const siblings = findGnssSiblingsInMessage(msg, sourceSchema);
    if (!siblings.lon && !siblings.heading && !siblings.speed) {
      return null;
    }
    return siblings;
  }, [boundCatalogEntry, schema, selectedWidget]);

  const handleAutoPairMapSiblings = (widget: SimulationWidgetDto) => {
    if (!gnssSiblingsForSelected || !canMutate) return;
    const dbMeta: SignalBindingDbMeta | undefined = boundCatalogEntry
      ? {
          databaseId: boundCatalogEntry.db.id,
          databaseName: boundCatalogEntry.db.name,
        }
      : widget.binding?.databaseId || widget.binding?.databaseName
        ? {
            databaseId: widget.binding.databaseId,
            databaseName: widget.binding.databaseName,
          }
        : undefined;
    const resolvedBusId =
      boundCatalogEntry?.inferredBusId ?? widget.binding?.busId ?? 0;

    onUpdateWidget(widget.id, (prev) => {
      const nextCfg: SimulationWidgetConfigDto = { ...prev.config };
      if (gnssSiblingsForSelected.lon) {
        nextCfg.lonBinding = signalSchemaToBinding(
          gnssSiblingsForSelected.lon.msg,
          gnssSiblingsForSelected.lon.sig,
          resolvedBusId,
          TRACE_PALETTE[1],
          dbMeta
        );
      }
      if (gnssSiblingsForSelected.heading) {
        nextCfg.headingBinding = signalSchemaToBinding(
          gnssSiblingsForSelected.heading.msg,
          gnssSiblingsForSelected.heading.sig,
          resolvedBusId,
          TRACE_PALETTE[2],
          dbMeta
        );
      }
      if (gnssSiblingsForSelected.speed) {
        nextCfg.speedBinding = signalSchemaToBinding(
          gnssSiblingsForSelected.speed.msg,
          gnssSiblingsForSelected.speed.sig,
          resolvedBusId,
          TRACE_PALETTE[3],
          dbMeta
        );
      }
      return {
        ...prev,
        config: nextCfg,
      };
    });
  };

  const applyDbcSignalToWidget = (
    widget: SimulationWidgetDto,
    found: CatalogSignalPair
  ) => {
    const dbMeta: SignalBindingDbMeta = {
      databaseId: found.db.id,
      databaseName: found.db.name,
    };
    const baseBinding = signalSchemaToBinding(
      found.msg,
      found.sig,
      found.busId,
      ACCENT_HEX_MAP[widget.accentColor],
      dbMeta
    );
    const nextBinding =
      widget.kind === 'map'
        ? { ...baseBinding, decimals: Math.max(baseBinding.decimals, 6) }
        : baseBinding;
    const enumOpts = enumTableToComboOptions(found.sig.enumTable);

    onUpdateWidget(widget.id, (prev) => {
      const nextCfg: SimulationWidgetConfigDto = { ...prev.config };
      if (
        prev.kind === 'gauge' ||
        prev.kind === 'bar' ||
        prev.kind === 'slider'
      ) {
        nextCfg.min = nextBinding.min;
        nextCfg.max = nextBinding.max;
      }
      if (prev.kind === 'map' && !nextCfg.lonBinding) {
        const siblings = findGnssSiblingsInMessage(
          found.msg,
          found.entrySchema
        );
        if (siblings.lon && siblings.lon.sig.name !== found.sig.name) {
          nextCfg.lonBinding = signalSchemaToBinding(
            siblings.lon.msg,
            siblings.lon.sig,
            found.busId,
            TRACE_PALETTE[1],
            dbMeta
          );
        }
        if (!nextCfg.headingBinding && siblings.heading) {
          nextCfg.headingBinding = signalSchemaToBinding(
            siblings.heading.msg,
            siblings.heading.sig,
            found.busId,
            TRACE_PALETTE[2],
            dbMeta
          );
        }
        if (!nextCfg.speedBinding && siblings.speed) {
          nextCfg.speedBinding = signalSchemaToBinding(
            siblings.speed.msg,
            siblings.speed.sig,
            found.busId,
            TRACE_PALETTE[3],
            dbMeta
          );
        }
      }
      if (Object.keys(found.sig.enumTable).length > 0) {
        nextCfg.enumMap = { ...found.sig.enumTable };
        if (enumOpts.length > 0) {
          nextCfg.options = enumOpts;
        }
      }
      return {
        ...prev,
        title:
          prev.title.startsWith('Dial ') ||
          prev.title.startsWith('Level ') ||
          prev.title.startsWith('Digital ') ||
          prev.title.startsWith('Status ') ||
          prev.title.startsWith('Symbolic ') ||
          prev.title.startsWith('Oscilloscope') ||
          prev.title.startsWith('GNSS ') ||
          prev.title.startsWith('Push ') ||
          prev.title.startsWith('Enable ') ||
          prev.title.startsWith('State ') ||
          prev.title.startsWith('Setpoint ')
            ? prev.kind === 'map'
              ? `${found.msg.name} // GNSS MAP`
              : found.sig.name
            : prev.title,
        binding: nextBinding,
        config: nextCfg,
      };
    });
  };

  const initManualBinding = (widget: SimulationWidgetDto) => {
    if (widget.kind === 'map') {
      const arbId = 0x180;
      const msgKey = formatMessageKey(arbId, false);
      const manualLat: SimulationSignalBindingDto = {
        busId: 0,
        messageKey: msgKey,
        messageName: 'VirtualGnssFrame',
        arbId,
        isExtended: false,
        signalName: 'GPS_Latitude',
        unit: 'deg',
        min: -90,
        max: 90,
        factor: 1,
        offset: 0,
        decimals: 6,
        color: ACCENT_HEX_MAP[widget.accentColor],
      };
      const manualLon: SimulationSignalBindingDto = {
        busId: 0,
        messageKey: msgKey,
        messageName: 'VirtualGnssFrame',
        arbId,
        isExtended: false,
        signalName: 'GPS_Longitude',
        unit: 'deg',
        min: -180,
        max: 180,
        factor: 1,
        offset: 0,
        decimals: 6,
        color: TRACE_PALETTE[1],
      };
      onUpdateWidget(widget.id, (prev) => ({
        ...prev,
        binding: manualLat,
        config: {
          ...prev.config,
          lonBinding: prev.config.lonBinding ?? manualLon,
        },
      }));
      return;
    }

    const arbId = 0x101;
    const manual: SimulationSignalBindingDto = {
      busId: 0,
      messageKey: formatMessageKey(arbId, false),
      messageName: 'ManualFrame',
      arbId,
      isExtended: false,
      signalName: 'ManualSignal_1',
      unit: '',
      min: 0,
      max: 100,
      factor: 1,
      offset: 0,
      decimals: 1,
      color: ACCENT_HEX_MAP[widget.accentColor],
    };
    onUpdateWidget(widget.id, (prev) => ({
      ...prev,
      binding: manual,
    }));
  };

  const handleAddGenerator = () => {
    if (!canMutate) return;
    const firstPair = visibleCatalogPairs[0] ?? allCatalogPairs[0];
    const binding: SimulationSignalBindingDto = firstPair
      ? signalSchemaToBinding(
          firstPair.msg,
          firstPair.sig,
          firstPair.busId,
          TRACE_PALETTE[0],
          { databaseId: firstPair.db.id, databaseName: firstPair.db.name }
        )
      : {
          busId: 0,
          messageKey: 'STD:0x100',
          messageName: 'VirtualSimFrame',
          arbId: 0x100,
          isExtended: false,
          signalName: `SimSignal_${generators.length + 1}`,
          unit: '',
          min: 0,
          max: 100,
          factor: 1,
          offset: 0,
          decimals: 1,
          color:
            TRACE_PALETTE[generators.length % TRACE_PALETTE.length] ?? '#0e8ac8',
        };

    const nextGen: SimulationGeneratorSpecDto = {
      id: createClientUid('gen'),
      enabled: true,
      binding,
      waveform: 'sine',
      min: binding.min,
      max: binding.max,
      constantValue: binding.min,
      frequencyHz: 0.5,
    };
    onUpdateGenerators([...generators, nextGen]);
  };

  const activeGenCount = generators.filter((g) => g.enabled).length;

  const renderDatabaseFilterDropdown = (ariaLabel: string) => {
    if (databases.length === 0) return null;
    return (
      <select
        aria-label={ariaLabel}
        value={isAllDbFilter ? 'ALL' : pickerDbFilter}
        onChange={(e) => setPickerDbFilter(e.target.value)}
        className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 font-mono text-[10px] tabular-nums text-ink"
      >
        <option value="ALL">
          {`TÜM YÜKLÜ VERİTABANLARI (${databases.length})`}
        </option>
        {databases.map((db) => (
          <option key={db.id} value={db.id}>
            {formatDatabaseDisplayLabel(db)}
          </option>
        ))}
      </select>
    );
  };

  return (
    <aside
      aria-label="Widget Denetçisi ve Sinyal Üreteçleri"
      className="flex w-full shrink-0 flex-col border-t border-hairline bg-surface lg:w-[324px] lg:border-t-0 lg:border-l"
    >
      {/* Top Sub-Tabs: INSPECTOR vs GENERATORS */}
      <div className="grid h-9 shrink-0 grid-cols-2 border-b border-hairline bg-elevated font-mono text-[10px] font-semibold uppercase tracking-wider">
        <button
          type="button"
          onClick={() => setActiveTab('inspector')}
          className={`flex cursor-pointer items-center justify-center gap-1.5 border-r border-hairline transition-colors ${
            activeTab === 'inspector'
              ? 'bg-surface text-ink'
              : 'text-muted hover:text-ink'
          }`}
        >
          <Settings2 className="h-3 w-3 text-focus" aria-hidden="true" />
          INSPECTOR
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('generators')}
          className={`flex cursor-pointer items-center justify-center gap-1.5 tabular-nums transition-colors ${
            activeTab === 'generators'
              ? 'bg-surface text-ink'
              : 'text-muted hover:text-ink'
          }`}
        >
          <Activity className="h-3 w-3 text-nominal" aria-hidden="true" />
          GENERATORS ({activeGenCount}/{generators.length})
        </button>
      </div>

      {activeTab === 'generators' ? (
        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
              60HZ VIRTUAL WAVEFORMS
            </span>
            <button
              type="button"
              disabled={!canMutate}
              onClick={handleAddGenerator}
              className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-elevated px-2 font-mono text-[10px] font-semibold text-focus hover:border-strong disabled:opacity-50"
            >
              <Plus className="h-3 w-3" aria-hidden="true" />
              ADD GENERATOR
            </button>
          </div>

          {databases.length > 0 && (
            <div className="space-y-1">
              <span className="block font-mono text-[9px] uppercase text-subtle">
                VERİTABANI FİLTRESİ
              </span>
              {renderDatabaseFilterDropdown(
                'Üreteç sinyal veritabanı filtresi'
              )}
            </div>
          )}

          {generators.length === 0 ? (
            <div className="rounded-[2px] border border-hairline bg-canvas p-4 text-center font-mono text-[11px] text-muted">
              KAYITLI SİNYAL ÜRETECİ YOK. RUN (VIRTUAL BUS) MODUNDA OTOMATİK SİNÜS / ÜÇGEN / TESTERE DİŞİ DALGA ÜRETMEK İÇİN EKLEYİN.
            </div>
          ) : (
            <div className="space-y-2">
              {generators.map((gen) => {
                const currentCatalogId = resolveBindingCatalogId(
                  gen.binding,
                  visibleCatalogPairs
                );
                return (
                  <div
                    key={gen.id}
                    className="space-y-2 rounded-[2px] border border-hairline bg-canvas p-2.5 font-mono text-[10px] tabular-nums"
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <button
                        type="button"
                        disabled={!canMutate}
                        onClick={() =>
                          onUpdateGenerators(
                            generators.map((g) =>
                              g.id === gen.id ? { ...g, enabled: !g.enabled } : g
                            )
                          )
                        }
                        className="cursor-pointer rounded-[2px] border px-1.5 py-0.5 text-[9px] font-bold uppercase"
                        style={
                          gen.enabled
                            ? {
                                backgroundColor: 'var(--status-nominal-bg)',
                                borderColor: 'var(--status-nominal-border)',
                                color: 'var(--status-nominal)',
                              }
                            : {
                                backgroundColor: 'var(--bg-elevated)',
                                borderColor: 'var(--border-hairline)',
                                color: 'var(--text-muted)',
                              }
                        }
                      >
                        {gen.enabled ? 'ENABLED' : 'PAUSED'}
                      </button>

                      <span className="truncate font-semibold text-ink">
                        {gen.binding.databaseName
                          ? `[${gen.binding.databaseName}] `
                          : ''}
                        {gen.binding.messageKey} :: {gen.binding.signalName}
                      </span>

                      <button
                        type="button"
                        disabled={!canMutate}
                        onClick={() =>
                          onUpdateGenerators(
                            generators.filter((g) => g.id !== gen.id)
                          )
                        }
                        aria-label="Üreteci sil"
                        className="cursor-pointer rounded-[2px] p-1 text-muted hover:text-critical"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>

                    {visibleCatalogPairs.length > 0 && (
                      <select
                        aria-label="Üreteç DBC sinyali"
                        disabled={!canMutate}
                        value={currentCatalogId}
                        onChange={(e) => {
                          const found = visibleCatalogPairs.find(
                            (p) => p.id === e.target.value
                          );
                          if (!found) return;
                          const nextB = signalSchemaToBinding(
                            found.msg,
                            found.sig,
                            found.busId,
                            gen.binding.color,
                            {
                              databaseId: found.db.id,
                              databaseName: found.db.name,
                            }
                          );
                          onUpdateGenerators(
                            generators.map((g) =>
                              g.id === gen.id
                                ? {
                                    ...g,
                                    binding: nextB,
                                    min: nextB.min,
                                    max: nextB.max,
                                  }
                                : g
                            )
                          );
                        }}
                        className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-[10px] text-ink"
                      >
                        <option value="">-- DBC / KCD SİNYALİ SEÇ --</option>
                        {visibleCatalogPairs.map((p) => (
                          <option key={p.id} value={p.id}>
                            {isAllDbFilter ? p.labelAll : p.labelSingle}
                          </option>
                        ))}
                      </select>
                    )}

                    <div className="grid grid-cols-2 gap-1.5">
                      <label className="space-y-0.5">
                        <span className="block text-[9px] text-subtle">
                          MESSAGE KEY
                        </span>
                        <input
                          type="text"
                          disabled={!canMutate}
                          value={gen.binding.messageKey}
                          onChange={(e) =>
                            onUpdateGenerators(
                              generators.map((g) =>
                                g.id === gen.id
                                  ? {
                                      ...g,
                                      binding: {
                                        ...g.binding,
                                        messageKey: e.target.value,
                                      },
                                    }
                                  : g
                              )
                            )
                          }
                          className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-[10px] text-ink"
                        />
                      </label>
                      <label className="space-y-0.5">
                        <span className="block text-[9px] text-subtle">
                          SIGNAL NAME
                        </span>
                        <input
                          type="text"
                          disabled={!canMutate}
                          value={gen.binding.signalName}
                          onChange={(e) =>
                            onUpdateGenerators(
                              generators.map((g) =>
                                g.id === gen.id
                                  ? {
                                      ...g,
                                      binding: {
                                        ...g.binding,
                                        signalName: e.target.value,
                                      },
                                    }
                                  : g
                              )
                            )
                          }
                          className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-[10px] text-ink"
                        />
                      </label>
                    </div>

                    <div className="grid grid-cols-2 gap-1.5">
                      <label className="space-y-0.5">
                        <span className="block text-[9px] text-subtle">
                          WAVEFORM
                        </span>
                        <select
                          disabled={!canMutate}
                          value={gen.waveform}
                          onChange={(e) =>
                            onUpdateGenerators(
                              generators.map((g) =>
                                g.id === gen.id
                                  ? {
                                      ...g,
                                      waveform:
                                        e.target.value as SimulationWaveformKind,
                                    }
                                  : g
                              )
                            )
                          }
                          className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1 text-[10px] uppercase text-ink"
                        >
                          {WAVEFORM_OPTIONS.map((wf) => (
                            <option key={wf} value={wf}>
                              {wf.toUpperCase()}
                            </option>
                          ))}
                        </select>
                      </label>

                      {gen.waveform === 'constant' ? (
                        <label className="space-y-0.5">
                          <span className="block text-[9px] text-subtle">
                            CONST VAL
                          </span>
                          <input
                            type="number"
                            disabled={!canMutate}
                            step="any"
                            value={gen.constantValue}
                            onChange={(e) =>
                              onUpdateGenerators(
                                generators.map((g) =>
                                  g.id === gen.id
                                    ? {
                                        ...g,
                                        constantValue:
                                          Number(e.target.value) || 0,
                                      }
                                    : g
                                )
                              )
                            }
                            className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-[10px] text-ink"
                          />
                        </label>
                      ) : (
                        <label className="space-y-0.5">
                          <span className="block text-[9px] text-subtle">
                            FREQ (HZ)
                          </span>
                          <input
                            type="number"
                            disabled={!canMutate}
                            min={0.05}
                            max={50}
                            step={0.05}
                            value={gen.frequencyHz}
                            onChange={(e) =>
                              onUpdateGenerators(
                                generators.map((g) =>
                                  g.id === gen.id
                                    ? {
                                        ...g,
                                        frequencyHz: Math.max(
                                          0.05,
                                          Math.min(
                                            50,
                                            Number(e.target.value) || 0.5
                                          )
                                        ),
                                      }
                                    : g
                                )
                              )
                            }
                            className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-[10px] text-ink"
                          />
                        </label>
                      )}
                    </div>

                    {gen.waveform !== 'constant' && (
                      <div className="grid grid-cols-2 gap-1.5">
                        <label className="space-y-0.5">
                          <span className="block text-[9px] text-subtle">
                            MIN
                          </span>
                          <input
                            type="number"
                            disabled={!canMutate}
                            step="any"
                            value={gen.min}
                            onChange={(e) =>
                              onUpdateGenerators(
                                generators.map((g) =>
                                  g.id === gen.id
                                    ? { ...g, min: Number(e.target.value) || 0 }
                                    : g
                                )
                              )
                            }
                            className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-[10px] text-ink"
                          />
                        </label>
                        <label className="space-y-0.5">
                          <span className="block text-[9px] text-subtle">
                            MAX
                          </span>
                          <input
                            type="number"
                            disabled={!canMutate}
                            step="any"
                            value={gen.max}
                            onChange={(e) =>
                              onUpdateGenerators(
                                generators.map((g) =>
                                  g.id === gen.id
                                    ? { ...g, max: Number(e.target.value) || 0 }
                                    : g
                                )
                              )
                            }
                            className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-[10px] text-ink"
                          />
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : !selectedWidget ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center font-mono text-[11px] text-muted">
          24-SÜTUNLU IZGARADAN BİR ENSTRÜMAN SEÇİN VEYA SOL PALETTEN YENİ WIDGET EKLEYİN.
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 font-mono text-[10px] tabular-nums">
          {/* Header Actions */}
          <div className="flex items-center justify-between gap-2 border-b border-hairline pb-2">
            <span className="truncate font-semibold uppercase text-focus">
              {selectedWidget.kind.toUpperCase()} // {selectedWidget.id.slice(0, 10)}
            </span>
            {canMutate && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onDuplicateWidget(selectedWidget.id)}
                  title="Widget kopyala"
                  className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-elevated px-1.5 text-[9px] text-ink hover:border-strong"
                >
                  <Copy className="h-2.5 w-2.5" aria-hidden="true" />
                  DUP
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteWidget(selectedWidget.id)}
                  title="Widget sil"
                  className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-elevated px-1.5 text-[9px] text-muted hover:border-critical hover:text-critical"
                >
                  <Trash2 className="h-2.5 w-2.5" aria-hidden="true" />
                  DEL
                </button>
              </div>
            )}
          </div>

          {/* General Metadata & Grid Coordinates */}
          <div className="space-y-2">
            <label className="block space-y-0.5">
              <span className="text-[9px] uppercase text-subtle">TITLE</span>
              <input
                type="text"
                disabled={!canMutate}
                value={selectedWidget.title}
                onChange={(e) =>
                  onUpdateWidget(selectedWidget.id, (w) => ({
                    ...w,
                    title: e.target.value,
                  }))
                }
                className="h-7 w-full rounded-[2px] border border-hairline bg-canvas px-2 font-sans text-xs text-ink"
              />
            </label>

            <label className="block space-y-0.5">
              <span className="text-[9px] uppercase text-subtle">
                WIDGET TYPE
              </span>
              <select
                disabled={!canMutate}
                value={selectedWidget.kind}
                onChange={(e) =>
                  onUpdateWidget(selectedWidget.id, (w) => ({
                    ...w,
                    kind: e.target.value as SimulationWidgetKind,
                    binding:
                      e.target.value === 'group' ? null : w.binding,
                  }))
                }
                className="h-7 w-full rounded-[2px] border border-hairline bg-canvas px-1.5 text-[10px] text-ink"
              >
                {WIDGET_KIND_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="space-y-1">
              <span className="block text-[9px] uppercase text-subtle">
                ACCENT COLOR
              </span>
              <div className="grid grid-cols-6 gap-1">
                {ACCENT_OPTIONS.map((acc) => {
                  const active = selectedWidget.accentColor === acc;
                  return (
                    <button
                      key={acc}
                      type="button"
                      disabled={!canMutate}
                      onClick={() =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          accentColor: acc,
                          binding: w.binding
                            ? { ...w.binding, color: ACCENT_HEX_MAP[acc] }
                            : null,
                        }))
                      }
                      title={acc.toUpperCase()}
                      className={`flex h-6 cursor-pointer items-center justify-center rounded-[2px] border ${
                        active
                          ? 'border-ink bg-elevated'
                          : 'border-hairline bg-canvas'
                      }`}
                    >
                      <span
                        className="h-3 w-3 rounded-[1px]"
                        style={{ backgroundColor: ACCENT_HEX_MAP[acc] }}
                      />
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Accessible Keyboard & Single-Pointer Grid Layout Inputs */}
            <div className="grid grid-cols-4 gap-1.5">
              <label className="space-y-0.5">
                <span className="block text-[9px] text-subtle">COL</span>
                <input
                  type="number"
                  disabled={!canMutate}
                  min={0}
                  max={gridCols - 1}
                  value={selectedWidget.layout.col}
                  onChange={(e) => {
                    const col = Math.max(
                      0,
                      Math.min(
                        gridCols - selectedWidget.layout.w,
                        Number(e.target.value) || 0
                      )
                    );
                    onUpdateWidget(selectedWidget.id, (w) => ({
                      ...w,
                      layout: { ...w.layout, col },
                    }));
                  }}
                  className="h-6 w-full rounded-[2px] border border-hairline bg-canvas px-1.5 text-ink"
                />
              </label>
              <label className="space-y-0.5">
                <span className="block text-[9px] text-subtle">ROW</span>
                <input
                  type="number"
                  disabled={!canMutate}
                  min={0}
                  max={399}
                  value={selectedWidget.layout.row}
                  onChange={(e) => {
                    const row = Math.max(
                      0,
                      Math.min(399, Number(e.target.value) || 0)
                    );
                    onUpdateWidget(selectedWidget.id, (w) => ({
                      ...w,
                      layout: { ...w.layout, row },
                    }));
                  }}
                  className="h-6 w-full rounded-[2px] border border-hairline bg-canvas px-1.5 text-ink"
                />
              </label>
              <label className="space-y-0.5">
                <span className="block text-[9px] text-subtle">W</span>
                <input
                  type="number"
                  disabled={!canMutate}
                  min={1}
                  max={gridCols}
                  value={selectedWidget.layout.w}
                  onChange={(e) => {
                    const wVal = Math.max(
                      1,
                      Math.min(
                        gridCols - selectedWidget.layout.col,
                        Number(e.target.value) || 1
                      )
                    );
                    onUpdateWidget(selectedWidget.id, (w) => ({
                      ...w,
                      layout: { ...w.layout, w: wVal },
                    }));
                  }}
                  className="h-6 w-full rounded-[2px] border border-hairline bg-canvas px-1.5 text-ink"
                />
              </label>
              <label className="space-y-0.5">
                <span className="block text-[9px] text-subtle">H</span>
                <input
                  type="number"
                  disabled={!canMutate}
                  min={1}
                  max={48}
                  value={selectedWidget.layout.h}
                  onChange={(e) => {
                    const hVal = Math.max(
                      1,
                      Math.min(48, Number(e.target.value) || 1)
                    );
                    onUpdateWidget(selectedWidget.id, (w) => ({
                      ...w,
                      layout: { ...w.layout, h: hVal },
                    }));
                  }}
                  className="h-6 w-full rounded-[2px] border border-hairline bg-canvas px-1.5 text-ink"
                />
              </label>
            </div>
          </div>

          {/* Multi-DBC Smart SignalBindingPicker (for all non-group widgets) */}
          {selectedWidget.kind !== 'group' && (
            <div className="space-y-2 rounded-[2px] border border-hairline bg-canvas p-2.5">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1 font-semibold uppercase text-ink">
                  <Link2 className="h-3 w-3 text-focus" aria-hidden="true" />
                  {selectedWidget.kind === 'map'
                    ? 'LATITUDE SIGNAL (PRIMARY)'
                    : 'SIGNAL BINDING'}
                </span>
                {canMutate &&
                  (selectedWidget.binding ? (
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          binding: null,
                        }))
                      }
                      className="inline-flex cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-1.5 py-0.5 text-[9px] text-muted hover:text-critical"
                    >
                      <Unlink className="h-2.5 w-2.5" />
                      UNBIND
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => initManualBinding(selectedWidget)}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-1.5 py-0.5 text-[9px] text-focus hover:border-strong"
                    >
                      <Plus className="h-2.5 w-2.5" />
                      MANUAL BIND
                    </button>
                  ))}
              </div>

              {selectedWidget.binding?.databaseName && (
                <div className="flex items-center justify-between gap-1.5 rounded-[2px] border border-hairline bg-elevated px-2 py-1 text-[9px]">
                  <span className="inline-flex min-w-0 items-center gap-1 text-muted">
                    <Database
                      className="h-2.5 w-2.5 shrink-0 text-nominal"
                      aria-hidden="true"
                    />
                    <span className="truncate">
                      ŞEMA:{' '}
                      <strong className="text-ink">
                        {selectedWidget.binding.databaseName}
                      </strong>
                    </span>
                  </span>
                  <span className="shrink-0 font-semibold text-focus">
                    CAN{selectedWidget.binding.busId}
                  </span>
                </div>
              )}

              {selectedWidget.kind === 'map' &&
                gnssSiblingsForSelected &&
                canMutate && (
                  <button
                    type="button"
                    onClick={() => handleAutoPairMapSiblings(selectedWidget)}
                    className="inline-flex h-6 w-full cursor-pointer items-center justify-center gap-1.5 rounded-[2px] border border-strong bg-elevated px-2 text-[9px] font-semibold uppercase text-focus hover:bg-hover"
                  >
                    <Compass
                      className="h-2.5 w-2.5 text-nominal"
                      aria-hidden="true"
                    />
                    AUTO-PAIR LON / HDG / SPD FROM SAME MESSAGE
                  </button>
                )}

              {/* Multi-DBC Filter + Searchable Signal Picker */}
              {allCatalogPairs.length > 0 && (
                <div className="space-y-1">
                  {renderDatabaseFilterDropdown(
                    'Denetçi sinyal veritabanı filtresi'
                  )}

                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute top-1.5 left-1.5 h-3 w-3 text-subtle"
                      aria-hidden="true"
                    />
                    <input
                      type="text"
                      value={pickerQuery}
                      onChange={(e) => setPickerQuery(e.target.value)}
                      placeholder="DB adı, 0x101, mesaj veya sinyal ara..."
                      className="h-6 w-full rounded-[2px] border border-hairline bg-surface pr-2 pl-5 text-[10px] text-ink placeholder:text-subtle"
                    />
                  </div>

                  <select
                    aria-label="DBC sinyali seç"
                    disabled={!canMutate}
                    value={resolveBindingCatalogId(
                      selectedWidget.binding,
                      filteredCatalogPairs
                    )}
                    onChange={(e) => {
                      const found = allCatalogPairs.find(
                        (p) => p.id === e.target.value
                      );
                      if (found) {
                        applyDbcSignalToWidget(selectedWidget, found);
                      }
                    }}
                    className="h-7 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-[10px] text-ink"
                  >
                    <option value="">
                      {`-- SİNYAL SEÇ (${filteredCatalogPairs.length}) --`}
                    </option>
                    {filteredCatalogPairs.map((p) => (
                      <option key={p.id} value={p.id}>
                        {isAllDbFilter ? p.labelAll : p.labelSingle}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Editable Binding Fields (Manual or DBC-populated) */}
              {selectedWidget.binding && (
                <div className="space-y-1.5 border-t border-hairline pt-2">
                  <div className="grid grid-cols-3 gap-1.5">
                    <label className="space-y-0.5">
                      <span className="block text-[9px] text-subtle">BUS</span>
                      <input
                        type="number"
                        disabled={!canMutate}
                        min={0}
                        max={15}
                        value={selectedWidget.binding.busId}
                        onChange={(e) =>
                          onUpdateWidget(selectedWidget.id, (w) =>
                            w.binding
                              ? {
                                  ...w,
                                  binding: {
                                    ...w.binding,
                                    busId: Math.max(
                                      0,
                                      Math.min(15, Number(e.target.value) || 0)
                                    ),
                                  },
                                }
                              : w
                          )
                        }
                        className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                      />
                    </label>
                    <label className="space-y-0.5">
                      <span className="block text-[9px] text-subtle">
                        ARB ID (HEX)
                      </span>
                      <input
                        type="text"
                        disabled={!canMutate}
                        value={`0x${selectedWidget.binding.arbId
                          .toString(16)
                          .toUpperCase()}`}
                        onChange={(e) => {
                          const arb = parseHexOrInt(
                            e.target.value,
                            selectedWidget.binding?.arbId ?? 0x100
                          );
                          onUpdateWidget(selectedWidget.id, (w) =>
                            w.binding
                              ? {
                                  ...w,
                                  binding: {
                                    ...w.binding,
                                    arbId: arb,
                                    messageKey: formatMessageKey(
                                      arb,
                                      w.binding.isExtended
                                    ),
                                  },
                                }
                              : w
                          );
                        }}
                        className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                      />
                    </label>
                    <label className="space-y-0.5">
                      <span className="block text-[9px] text-subtle">FRAME</span>
                      <select
                        disabled={!canMutate}
                        value={selectedWidget.binding.isExtended ? 'EXT' : 'STD'}
                        onChange={(e) => {
                          const ext = e.target.value === 'EXT';
                          onUpdateWidget(selectedWidget.id, (w) =>
                            w.binding
                              ? {
                                  ...w,
                                  binding: {
                                    ...w.binding,
                                    isExtended: ext,
                                    messageKey: formatMessageKey(
                                      w.binding.arbId,
                                      ext
                                    ),
                                  },
                                }
                              : w
                          );
                        }}
                        className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1 text-ink"
                      >
                        <option value="STD">STD 11b</option>
                        <option value="EXT">EXT 29b</option>
                      </select>
                    </label>
                  </div>

                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="space-y-0.5">
                      <span className="block text-[9px] text-subtle">
                        MESSAGE NAME
                      </span>
                      <input
                        type="text"
                        disabled={!canMutate}
                        value={selectedWidget.binding.messageName}
                        onChange={(e) =>
                          onUpdateWidget(selectedWidget.id, (w) =>
                            w.binding
                              ? {
                                  ...w,
                                  binding: {
                                    ...w.binding,
                                    messageName: e.target.value,
                                  },
                                }
                              : w
                          )
                        }
                        className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                      />
                    </label>
                    <label className="space-y-0.5">
                      <span className="block text-[9px] text-subtle">
                        SIGNAL NAME
                      </span>
                      <input
                        type="text"
                        disabled={!canMutate}
                        value={selectedWidget.binding.signalName}
                        onChange={(e) =>
                          onUpdateWidget(selectedWidget.id, (w) =>
                            w.binding
                              ? {
                                  ...w,
                                  binding: {
                                    ...w.binding,
                                    signalName: e.target.value,
                                  },
                                }
                              : w
                          )
                        }
                        className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                      />
                    </label>
                  </div>

                  <div className="grid grid-cols-3 gap-1.5">
                    <label className="space-y-0.5">
                      <span className="block text-[9px] text-subtle">UNIT</span>
                      <input
                        type="text"
                        disabled={!canMutate}
                        value={selectedWidget.binding.unit}
                        onChange={(e) =>
                          onUpdateWidget(selectedWidget.id, (w) =>
                            w.binding
                              ? {
                                  ...w,
                                  binding: {
                                    ...w.binding,
                                    unit: e.target.value,
                                  },
                                }
                              : w
                          )
                        }
                        className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                      />
                    </label>
                    <label className="space-y-0.5">
                      <span className="block text-[9px] text-subtle">MIN</span>
                      <input
                        type="number"
                        disabled={!canMutate}
                        step="any"
                        value={selectedWidget.binding.min}
                        onChange={(e) =>
                          onUpdateWidget(selectedWidget.id, (w) =>
                            w.binding
                              ? {
                                  ...w,
                                  binding: {
                                    ...w.binding,
                                    min: Number(e.target.value) || 0,
                                  },
                                }
                              : w
                          )
                        }
                        className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                      />
                    </label>
                    <label className="space-y-0.5">
                      <span className="block text-[9px] text-subtle">MAX</span>
                      <input
                        type="number"
                        disabled={!canMutate}
                        step="any"
                        value={selectedWidget.binding.max}
                        onChange={(e) =>
                          onUpdateWidget(selectedWidget.id, (w) =>
                            w.binding
                              ? {
                                  ...w,
                                  binding: {
                                    ...w.binding,
                                    max: Number(e.target.value) || 0,
                                  },
                                }
                              : w
                          )
                        }
                        className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                      />
                    </label>
                  </div>

                  <div className="grid grid-cols-3 gap-1.5">
                    <label className="space-y-0.5">
                      <span className="block text-[9px] text-subtle">
                        FACTOR
                      </span>
                      <input
                        type="number"
                        disabled={!canMutate}
                        step="any"
                        value={selectedWidget.binding.factor}
                        onChange={(e) =>
                          onUpdateWidget(selectedWidget.id, (w) =>
                            w.binding
                              ? {
                                  ...w,
                                  binding: {
                                    ...w.binding,
                                    factor: Number(e.target.value) || 1,
                                  },
                                }
                              : w
                          )
                        }
                        className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                      />
                    </label>
                    <label className="space-y-0.5">
                      <span className="block text-[9px] text-subtle">
                        OFFSET
                      </span>
                      <input
                        type="number"
                        disabled={!canMutate}
                        step="any"
                        value={selectedWidget.binding.offset}
                        onChange={(e) =>
                          onUpdateWidget(selectedWidget.id, (w) =>
                            w.binding
                              ? {
                                  ...w,
                                  binding: {
                                    ...w.binding,
                                    offset: Number(e.target.value) || 0,
                                  },
                                }
                              : w
                          )
                        }
                        className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                      />
                    </label>
                    <label className="space-y-0.5">
                      <span className="block text-[9px] text-subtle">
                        DECIMALS
                      </span>
                      <input
                        type="number"
                        disabled={!canMutate}
                        min={0}
                        max={6}
                        value={selectedWidget.binding.decimals}
                        onChange={(e) =>
                          onUpdateWidget(selectedWidget.id, (w) =>
                            w.binding
                              ? {
                                  ...w,
                                  binding: {
                                    ...w.binding,
                                    decimals: Math.max(
                                      0,
                                      Math.min(6, Number(e.target.value) || 0)
                                    ),
                                  },
                                }
                              : w
                          )
                        }
                        className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                      />
                    </label>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Kind-Specific Instrument Configuration */}
          <div className="space-y-2 rounded-[2px] border border-hairline bg-canvas p-2.5">
            <div className="font-semibold uppercase text-ink">
              INSTRUMENT PARAMETERS
            </div>

            {(selectedWidget.kind === 'gauge' ||
              selectedWidget.kind === 'bar' ||
              selectedWidget.kind === 'slider') && (
              <div className="grid grid-cols-2 gap-1.5">
                <label className="space-y-0.5">
                  <span className="block text-[9px] text-subtle">
                    SCALE MIN
                  </span>
                  <input
                    type="number"
                    disabled={!canMutate}
                    step="any"
                    value={
                      selectedWidget.config.min ??
                      selectedWidget.binding?.min ??
                      0
                    }
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: {
                          ...w.config,
                          min: Number(e.target.value) || 0,
                        },
                      }))
                    }
                    className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="block text-[9px] text-subtle">
                    SCALE MAX
                  </span>
                  <input
                    type="number"
                    disabled={!canMutate}
                    step="any"
                    value={
                      selectedWidget.config.max ??
                      selectedWidget.binding?.max ??
                      100
                    }
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: {
                          ...w.config,
                          max: Number(e.target.value) || 0,
                        },
                      }))
                    }
                    className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                  />
                </label>
              </div>
            )}

            {(selectedWidget.kind === 'gauge' ||
              selectedWidget.kind === 'bar' ||
              selectedWidget.kind === 'numeric') && (
              <div className="grid grid-cols-2 gap-1.5">
                <label className="space-y-0.5">
                  <span className="block text-[9px] text-subtle">WARN LOW</span>
                  <input
                    type="number"
                    disabled={!canMutate}
                    step="any"
                    value={selectedWidget.config.warnLow ?? ''}
                    placeholder="—"
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: {
                          ...w.config,
                          warnLow: parseOptionalNumber(e.target.value),
                        },
                      }))
                    }
                    className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="block text-[9px] text-subtle">
                    WARN HIGH
                  </span>
                  <input
                    type="number"
                    disabled={!canMutate}
                    step="any"
                    value={selectedWidget.config.warnHigh ?? ''}
                    placeholder="—"
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: {
                          ...w.config,
                          warnHigh: parseOptionalNumber(e.target.value),
                        },
                      }))
                    }
                    className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="block text-[9px] text-subtle">CRIT LOW</span>
                  <input
                    type="number"
                    disabled={!canMutate}
                    step="any"
                    value={selectedWidget.config.critLow ?? ''}
                    placeholder="—"
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: {
                          ...w.config,
                          critLow: parseOptionalNumber(e.target.value),
                        },
                      }))
                    }
                    className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="block text-[9px] text-subtle">
                    CRIT HIGH
                  </span>
                  <input
                    type="number"
                    disabled={!canMutate}
                    step="any"
                    value={selectedWidget.config.critHigh ?? ''}
                    placeholder="—"
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: {
                          ...w.config,
                          critHigh: parseOptionalNumber(e.target.value),
                        },
                      }))
                    }
                    className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                  />
                </label>
              </div>
            )}

            {selectedWidget.kind === 'gauge' && (
              <div className="space-y-1.5">
                <label className="block space-y-0.5">
                  <span className="text-[9px] text-subtle">MAJOR TICKS</span>
                  <input
                    type="number"
                    disabled={!canMutate}
                    min={2}
                    max={16}
                    value={selectedWidget.config.majorTicks ?? 6}
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: {
                          ...w.config,
                          majorTicks: Math.max(
                            2,
                            Math.min(16, Number(e.target.value) || 6)
                          ),
                        },
                      }))
                    }
                    className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                  />
                </label>
                <div className="flex items-center gap-3 pt-1">
                  <label className="inline-flex items-center gap-1.5 text-ink">
                    <input
                      type="checkbox"
                      disabled={!canMutate}
                      checked={selectedWidget.config.showNeedle ?? true}
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: { ...w.config, showNeedle: e.target.checked },
                        }))
                      }
                    />
                    NEEDLE
                  </label>
                  <label className="inline-flex items-center gap-1.5 text-ink">
                    <input
                      type="checkbox"
                      disabled={!canMutate}
                      checked={selectedWidget.config.showDigital ?? true}
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            showDigital: e.target.checked,
                          },
                        }))
                      }
                    />
                    DIGITAL
                  </label>
                </div>
              </div>
            )}

            {selectedWidget.kind === 'bar' && (
              <div className="space-y-1.5">
                <label className="block space-y-0.5">
                  <span className="text-[9px] text-subtle">ORIENTATION</span>
                  <select
                    disabled={!canMutate}
                    value={selectedWidget.config.orientation ?? 'horizontal'}
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: {
                          ...w.config,
                          orientation: e.target.value as
                            | 'horizontal'
                            | 'vertical',
                        },
                      }))
                    }
                    className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                  >
                    <option value="horizontal">HORIZONTAL</option>
                    <option value="vertical">VERTICAL</option>
                  </select>
                </label>
                <label className="inline-flex items-center gap-1.5 pt-1 text-ink">
                  <input
                    type="checkbox"
                    disabled={!canMutate}
                    checked={selectedWidget.config.showPeakHold ?? false}
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: { ...w.config, showPeakHold: e.target.checked },
                      }))
                    }
                  />
                  PEAK-HOLD HAIRLINE
                </label>
              </div>
            )}

            {selectedWidget.kind === 'numeric' && (
              <div className="space-y-1.5">
                <label className="block space-y-0.5">
                  <span className="text-[9px] text-subtle">DIGIT SIZE</span>
                  <select
                    disabled={!canMutate}
                    value={selectedWidget.config.fontSize ?? 'md'}
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: {
                          ...w.config,
                          fontSize: e.target.value as 'sm' | 'md' | 'lg',
                        },
                      }))
                    }
                    className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                  >
                    <option value="sm">SMALL (SM)</option>
                    <option value="md">MEDIUM (MD)</option>
                    <option value="lg">LARGE (LG)</option>
                  </select>
                </label>
                <label className="inline-flex items-center gap-1.5 pt-1 text-ink">
                  <input
                    type="checkbox"
                    disabled={!canMutate}
                    checked={selectedWidget.config.showRawHex ?? false}
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: { ...w.config, showRawHex: e.target.checked },
                      }))
                    }
                  />
                  SHOW RAW INT & HEX
                </label>
              </div>
            )}

            {selectedWidget.kind === 'led' && (
              <div className="space-y-1.5">
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="space-y-0.5">
                    <span className="block text-[9px] text-subtle">
                      OPERATOR
                    </span>
                    <select
                      disabled={!canMutate}
                      value={selectedWidget.config.ledOperator ?? 'gte'}
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            ledOperator:
                              e.target.value as SimulationLedOperator,
                          },
                        }))
                      }
                      className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                    >
                      <option value="eq">== (EQ)</option>
                      <option value="neq">!= (NEQ)</option>
                      <option value="gt">&gt; (GT)</option>
                      <option value="gte">&gt;= (GTE)</option>
                      <option value="lt">&lt; (LT)</option>
                      <option value="lte">&lt;= (LTE)</option>
                    </select>
                  </label>
                  <label className="space-y-0.5">
                    <span className="block text-[9px] text-subtle">
                      THRESHOLD
                    </span>
                    <input
                      type="number"
                      disabled={!canMutate}
                      step="any"
                      value={selectedWidget.config.ledThreshold ?? 1}
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            ledThreshold: Number(e.target.value) || 0,
                          },
                        }))
                      }
                      className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                    />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="space-y-0.5">
                    <span className="block text-[9px] text-subtle">
                      ON LABEL
                    </span>
                    <input
                      type="text"
                      disabled={!canMutate}
                      value={selectedWidget.config.onLabel ?? 'ACTIVE'}
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: { ...w.config, onLabel: e.target.value },
                        }))
                      }
                      className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                    />
                  </label>
                  <label className="space-y-0.5">
                    <span className="block text-[9px] text-subtle">
                      OFF LABEL
                    </span>
                    <input
                      type="text"
                      disabled={!canMutate}
                      value={selectedWidget.config.offLabel ?? 'IDLE'}
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: { ...w.config, offLabel: e.target.value },
                        }))
                      }
                      className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                    />
                  </label>
                </div>
              </div>
            )}

            {selectedWidget.kind === 'enum_badge' && (
              <div className="space-y-1.5">
                {boundSchemaSignal &&
                  Object.keys(boundSchemaSignal.enumTable).length > 0 &&
                  canMutate && (
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            enumMap: { ...boundSchemaSignal.enumTable },
                          },
                        }))
                      }
                      className="inline-flex h-6 w-full cursor-pointer items-center justify-center gap-1 rounded-[2px] border border-hairline bg-elevated text-[9px] font-semibold text-focus hover:border-strong"
                    >
                      <RefreshCw className="h-2.5 w-2.5" />
                      SYNC VAL_ FROM DBC
                    </button>
                  )}

                <div className="max-h-32 space-y-1 overflow-y-auto">
                  {Object.entries(selectedWidget.config.enumMap ?? {}).map(
                    ([k, lbl]) => (
                      <div
                        key={k}
                        className="flex items-center justify-between gap-1 rounded-[2px] border border-hairline bg-surface px-1.5 py-1"
                      >
                        <span className="truncate text-ink">
                          {k} : {lbl}
                        </span>
                        {canMutate && (
                          <button
                            type="button"
                            onClick={() =>
                              onUpdateWidget(selectedWidget.id, (w) => {
                                const next = { ...(w.config.enumMap ?? {}) };
                                delete next[k];
                                return {
                                  ...w,
                                  config: { ...w.config, enumMap: next },
                                };
                              })
                            }
                            className="cursor-pointer text-muted hover:text-critical"
                          >
                            <Trash2 className="h-2.5 w-2.5" />
                          </button>
                        )}
                      </div>
                    )
                  )}
                </div>

                {canMutate && (
                  <div className="flex gap-1 pt-1">
                    <input
                      type="number"
                      value={newEnumKey}
                      onChange={(e) => setNewEnumKey(e.target.value)}
                      placeholder="0"
                      className="h-6 w-12 rounded-[2px] border border-hairline bg-surface px-1 text-ink"
                    />
                    <input
                      type="text"
                      value={newEnumLabel}
                      onChange={(e) => setNewEnumLabel(e.target.value)}
                      placeholder="STATE"
                      className="h-6 flex-1 rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const k = String(Math.round(Number(newEnumKey) || 0));
                        if (!newEnumLabel.trim()) return;
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            enumMap: {
                              ...(w.config.enumMap ?? {}),
                              [k]: newEnumLabel.trim(),
                            },
                          },
                        }));
                      }}
                      className="h-6 cursor-pointer rounded-[2px] border border-hairline bg-elevated px-2 text-focus hover:border-strong"
                    >
                      +
                    </button>
                  </div>
                )}
              </div>
            )}

            {selectedWidget.kind === 'graph' && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="space-y-0.5">
                    <span className="block text-[9px] text-subtle">
                      WINDOW (SEC)
                    </span>
                    <input
                      type="number"
                      disabled={!canMutate}
                      min={1}
                      max={300}
                      value={selectedWidget.config.timeWindowSec ?? 15}
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            timeWindowSec: Math.max(
                              1,
                              Math.min(300, Number(e.target.value) || 15)
                            ),
                          },
                        }))
                      }
                      className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                    />
                  </label>
                  <div className="flex flex-col justify-end gap-1">
                    <label className="inline-flex items-center gap-1.5 text-ink">
                      <input
                        type="checkbox"
                        disabled={!canMutate}
                        checked={selectedWidget.config.autoScaleY ?? true}
                        onChange={(e) =>
                          onUpdateWidget(selectedWidget.id, (w) => ({
                            ...w,
                            config: {
                              ...w.config,
                              autoScaleY: e.target.checked,
                            },
                          }))
                        }
                      />
                      AUTO-SCALE Y
                    </label>
                    <label className="inline-flex items-center gap-1.5 text-ink">
                      <input
                        type="checkbox"
                        disabled={!canMutate}
                        checked={selectedWidget.config.showLegend ?? true}
                        onChange={(e) =>
                          onUpdateWidget(selectedWidget.id, (w) => ({
                            ...w,
                            config: {
                              ...w.config,
                              showLegend: e.target.checked,
                            },
                          }))
                        }
                      />
                      SHOW LEGEND
                    </label>
                  </div>
                </div>

                {!(selectedWidget.config.autoScaleY ?? true) && (
                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="space-y-0.5">
                      <span className="block text-[9px] text-subtle">
                        FIXED Y MIN
                      </span>
                      <input
                        type="number"
                        disabled={!canMutate}
                        step="any"
                        value={
                          selectedWidget.config.min ??
                          selectedWidget.binding?.min ??
                          0
                        }
                        onChange={(e) =>
                          onUpdateWidget(selectedWidget.id, (w) => ({
                            ...w,
                            config: {
                              ...w.config,
                              min: Number(e.target.value) || 0,
                            },
                          }))
                        }
                        className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                      />
                    </label>
                    <label className="space-y-0.5">
                      <span className="block text-[9px] text-subtle">
                        FIXED Y MAX
                      </span>
                      <input
                        type="number"
                        disabled={!canMutate}
                        step="any"
                        value={
                          selectedWidget.config.max ??
                          selectedWidget.binding?.max ??
                          100
                        }
                        onChange={(e) =>
                          onUpdateWidget(selectedWidget.id, (w) => ({
                            ...w,
                            config: {
                              ...w.config,
                              max: Number(e.target.value) || 100,
                            },
                          }))
                        }
                        className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                      />
                    </label>
                  </div>
                )}

                {/* Extra Multi-Trace Bindings (can mix signals across ANY DBC!) */}
                <div className="space-y-1 border-t border-hairline pt-2">
                  <span className="block text-[9px] uppercase text-subtle">
                    EXTRA TRACES (
                    {selectedWidget.config.extraBindings?.length ?? 0})
                  </span>
                  {(selectedWidget.config.extraBindings ?? []).map(
                    (extra, idx) => (
                      <div
                        key={`${extra.messageKey}-${extra.signalName}-${idx}`}
                        className="flex items-center justify-between gap-1 rounded-[2px] border border-hairline bg-surface px-1.5 py-1"
                      >
                        <div className="flex min-w-0 items-center gap-1.5">
                          <input
                            type="color"
                            disabled={!canMutate}
                            value={extra.color || '#2ea043'}
                            onChange={(e) =>
                              onUpdateWidget(selectedWidget.id, (w) => ({
                                ...w,
                                config: {
                                  ...w.config,
                                  extraBindings: (
                                    w.config.extraBindings ?? []
                                  ).map((eb, ebIdx) =>
                                    ebIdx === idx
                                      ? { ...eb, color: e.target.value }
                                      : eb
                                  ),
                                },
                              }))
                            }
                            className="h-4 w-4 shrink-0 cursor-pointer border-0 bg-transparent p-0"
                          />
                          <span className="truncate text-ink">
                            {extra.databaseName
                              ? `[${extra.databaseName}] `
                              : ''}
                            {extra.signalName}
                          </span>
                        </div>
                        {canMutate && (
                          <button
                            type="button"
                            onClick={() =>
                              onUpdateWidget(selectedWidget.id, (w) => ({
                                ...w,
                                config: {
                                  ...w.config,
                                  extraBindings: (
                                    w.config.extraBindings ?? []
                                  ).filter((_, ebIdx) => ebIdx !== idx),
                                },
                              }))
                            }
                            className="cursor-pointer text-muted hover:text-critical"
                          >
                            <Trash2 className="h-2.5 w-2.5" />
                          </button>
                        )}
                      </div>
                    )
                  )}

                  {canMutate && visibleCatalogPairs.length > 0 && (
                    <div className="flex gap-1 pt-1">
                      <select
                        value={extraSignalKeyToAdd}
                        onChange={(e) => setExtraSignalKeyToAdd(e.target.value)}
                        className="h-6 min-w-0 flex-1 rounded-[2px] border border-hairline bg-surface px-1 text-[10px] text-ink"
                      >
                        <option value="">-- EXTRA TRACE SEÇ --</option>
                        {visibleCatalogPairs.map((p) => (
                          <option key={p.id} value={p.id}>
                            {isAllDbFilter ? p.labelAll : p.labelSingle}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          const found = allCatalogPairs.find(
                            (p) => p.id === extraSignalKeyToAdd
                          );
                          if (!found) return;
                          onUpdateWidget(selectedWidget.id, (w) => {
                            const cur = w.config.extraBindings ?? [];
                            const color =
                              TRACE_PALETTE[
                                (cur.length + 1) % TRACE_PALETTE.length
                              ] ?? '#2ea043';
                            return {
                              ...w,
                              config: {
                                ...w.config,
                                extraBindings: [
                                  ...cur,
                                  signalSchemaToBinding(
                                    found.msg,
                                    found.sig,
                                    found.busId,
                                    color,
                                    {
                                      databaseId: found.db.id,
                                      databaseName: found.db.name,
                                    }
                                  ),
                                ],
                              },
                            };
                          });
                          setExtraSignalKeyToAdd('');
                        }}
                        className="h-6 cursor-pointer rounded-[2px] border border-hairline bg-elevated px-2 text-focus hover:border-strong"
                      >
                        +ADD
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {selectedWidget.kind === 'map' && (
              <div className="space-y-2.5">
                {/* 1. Longitude Signal (config.lonBinding) */}
                <div className="space-y-1 rounded-[2px] border border-hairline bg-surface p-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] font-semibold uppercase text-ink">
                      LONGITUDE SIGNAL (LON)
                    </span>
                    {canMutate &&
                      (selectedWidget.config.lonBinding ? (
                        <button
                          type="button"
                          onClick={() =>
                            onUpdateWidget(selectedWidget.id, (w) => ({
                              ...w,
                              config: { ...w.config, lonBinding: null },
                            }))
                          }
                          className="cursor-pointer text-[9px] text-muted hover:text-critical"
                        >
                          UNBIND
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            const arb = selectedWidget.binding?.arbId ?? 0x180;
                            const ext =
                              selectedWidget.binding?.isExtended ?? false;
                            const manualLon: SimulationSignalBindingDto = {
                              busId: selectedWidget.binding?.busId ?? 0,
                              messageKey: formatMessageKey(arb, ext),
                              messageName:
                                selectedWidget.binding?.messageName ||
                                'VirtualGnssFrame',
                              arbId: arb,
                              isExtended: ext,
                              signalName: 'GPS_Longitude',
                              unit: 'deg',
                              min: -180,
                              max: 180,
                              factor: 1,
                              offset: 0,
                              decimals: 6,
                              color: TRACE_PALETTE[1],
                            };
                            onUpdateWidget(selectedWidget.id, (w) => ({
                              ...w,
                              config: { ...w.config, lonBinding: manualLon },
                            }));
                          }}
                          className="cursor-pointer text-[9px] font-semibold text-focus hover:underline"
                        >
                          +MANUAL
                        </button>
                      ))}
                  </div>

                  {visibleCatalogPairs.length > 0 && (
                    <select
                      aria-label="Longitude DBC sinyali seç"
                      disabled={!canMutate}
                      value={resolveBindingCatalogId(
                        selectedWidget.config.lonBinding,
                        visibleCatalogPairs
                      )}
                      onChange={(e) => {
                        const found = allCatalogPairs.find(
                          (p) => p.id === e.target.value
                        );
                        if (!found) return;
                        const bLon = signalSchemaToBinding(
                          found.msg,
                          found.sig,
                          found.busId,
                          TRACE_PALETTE[1],
                          {
                            databaseId: found.db.id,
                            databaseName: found.db.name,
                          }
                        );
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            lonBinding: {
                              ...bLon,
                              decimals: Math.max(bLon.decimals, 6),
                            },
                          },
                        }));
                      }}
                      className="h-6 w-full rounded-[2px] border border-hairline bg-canvas px-1.5 text-[10px] text-ink"
                    >
                      <option value="">-- PICK LONGITUDE FROM DBC --</option>
                      {visibleCatalogPairs.map((p) => (
                        <option key={p.id} value={p.id}>
                          {isAllDbFilter ? p.labelAll : p.labelSingle}
                        </option>
                      ))}
                    </select>
                  )}

                  {selectedWidget.config.lonBinding && (
                    <div className="grid grid-cols-2 gap-1 pt-1">
                      <input
                        type="text"
                        disabled={!canMutate}
                        aria-label="Longitude Message Key"
                        value={selectedWidget.config.lonBinding.messageKey}
                        onChange={(e) =>
                          onUpdateWidget(selectedWidget.id, (w) =>
                            w.config.lonBinding
                              ? {
                                  ...w,
                                  config: {
                                    ...w.config,
                                    lonBinding: {
                                      ...w.config.lonBinding,
                                      messageKey: e.target.value,
                                    },
                                  },
                                }
                              : w
                          )
                        }
                        className="h-6 rounded-[2px] border border-hairline bg-canvas px-1.5 text-[10px] text-ink"
                      />
                      <input
                        type="text"
                        disabled={!canMutate}
                        aria-label="Longitude Signal Name"
                        value={selectedWidget.config.lonBinding.signalName}
                        onChange={(e) =>
                          onUpdateWidget(selectedWidget.id, (w) =>
                            w.config.lonBinding
                              ? {
                                  ...w,
                                  config: {
                                    ...w.config,
                                    lonBinding: {
                                      ...w.config.lonBinding,
                                      signalName: e.target.value,
                                    },
                                  },
                                }
                              : w
                          )
                        }
                        className="h-6 rounded-[2px] border border-hairline bg-canvas px-1.5 text-[10px] text-ink"
                      />
                    </div>
                  )}
                </div>

                {/* 2. Heading / Yaw Signal (config.headingBinding, optional) */}
                <div className="space-y-1 rounded-[2px] border border-hairline bg-surface p-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] font-semibold uppercase text-subtle">
                      HEADING / YAW (0..360° OPT)
                    </span>
                    {canMutate &&
                      (selectedWidget.config.headingBinding ? (
                        <button
                          type="button"
                          onClick={() =>
                            onUpdateWidget(selectedWidget.id, (w) => ({
                              ...w,
                              config: { ...w.config, headingBinding: null },
                            }))
                          }
                          className="cursor-pointer text-[9px] text-muted hover:text-critical"
                        >
                          CLEAR
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            const arb = selectedWidget.binding?.arbId ?? 0x180;
                            const ext =
                              selectedWidget.binding?.isExtended ?? false;
                            const manualHdg: SimulationSignalBindingDto = {
                              busId: selectedWidget.binding?.busId ?? 0,
                              messageKey: formatMessageKey(arb, ext),
                              messageName:
                                selectedWidget.binding?.messageName ||
                                'VirtualGnssFrame',
                              arbId: arb,
                              isExtended: ext,
                              signalName: 'GPS_Heading',
                              unit: 'deg',
                              min: 0,
                              max: 360,
                              factor: 0.1,
                              offset: 0,
                              decimals: 1,
                              color: TRACE_PALETTE[2],
                            };
                            onUpdateWidget(selectedWidget.id, (w) => ({
                              ...w,
                              config: {
                                ...w.config,
                                headingBinding: manualHdg,
                              },
                            }));
                          }}
                          className="cursor-pointer text-[9px] font-semibold text-focus hover:underline"
                        >
                          +MANUAL
                        </button>
                      ))}
                  </div>

                  {visibleCatalogPairs.length > 0 && (
                    <select
                      aria-label="Heading DBC sinyali seç"
                      disabled={!canMutate}
                      value={resolveBindingCatalogId(
                        selectedWidget.config.headingBinding,
                        visibleCatalogPairs
                      )}
                      onChange={(e) => {
                        if (!e.target.value) {
                          onUpdateWidget(selectedWidget.id, (w) => ({
                            ...w,
                            config: { ...w.config, headingBinding: null },
                          }));
                          return;
                        }
                        const found = allCatalogPairs.find(
                          (p) => p.id === e.target.value
                        );
                        if (!found) return;
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            headingBinding: signalSchemaToBinding(
                              found.msg,
                              found.sig,
                              found.busId,
                              TRACE_PALETTE[2],
                              {
                                databaseId: found.db.id,
                                databaseName: found.db.name,
                              }
                            ),
                          },
                        }));
                      }}
                      className="h-6 w-full rounded-[2px] border border-hairline bg-canvas px-1.5 text-[10px] text-ink"
                    >
                      <option value="">
                        -- AUTO COURSE BEARING (OPTIONAL) --
                      </option>
                      {visibleCatalogPairs.map((p) => (
                        <option key={p.id} value={p.id}>
                          {isAllDbFilter ? p.labelAll : p.labelSingle}
                        </option>
                      ))}
                    </select>
                  )}

                  {selectedWidget.config.headingBinding && (
                    <div className="truncate text-[9px] text-muted">
                      {selectedWidget.config.headingBinding.databaseName
                        ? `[${selectedWidget.config.headingBinding.databaseName}] `
                        : ''}
                      {selectedWidget.config.headingBinding.messageKey} ::{' '}
                      <strong className="text-ink">
                        {selectedWidget.config.headingBinding.signalName}
                      </strong>
                    </div>
                  )}
                </div>

                {/* 3. Ground Speed Signal (config.speedBinding, optional) */}
                <div className="space-y-1 rounded-[2px] border border-hairline bg-surface p-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] font-semibold uppercase text-subtle">
                      SPEED SIGNAL (OPTIONAL)
                    </span>
                    {canMutate &&
                      (selectedWidget.config.speedBinding ? (
                        <button
                          type="button"
                          onClick={() =>
                            onUpdateWidget(selectedWidget.id, (w) => ({
                              ...w,
                              config: { ...w.config, speedBinding: null },
                            }))
                          }
                          className="cursor-pointer text-[9px] text-muted hover:text-critical"
                        >
                          CLEAR
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            const arb = selectedWidget.binding?.arbId ?? 0x180;
                            const ext =
                              selectedWidget.binding?.isExtended ?? false;
                            const manualSpd: SimulationSignalBindingDto = {
                              busId: selectedWidget.binding?.busId ?? 0,
                              messageKey: formatMessageKey(arb, ext),
                              messageName:
                                selectedWidget.binding?.messageName ||
                                'VirtualGnssFrame',
                              arbId: arb,
                              isExtended: ext,
                              signalName: 'GPS_GroundSpeed',
                              unit: 'km/h',
                              min: 0,
                              max: 250,
                              factor: 0.1,
                              offset: 0,
                              decimals: 1,
                              color: TRACE_PALETTE[3],
                            };
                            onUpdateWidget(selectedWidget.id, (w) => ({
                              ...w,
                              config: { ...w.config, speedBinding: manualSpd },
                            }));
                          }}
                          className="cursor-pointer text-[9px] font-semibold text-focus hover:underline"
                        >
                          +MANUAL
                        </button>
                      ))}
                  </div>

                  {visibleCatalogPairs.length > 0 && (
                    <select
                      aria-label="Speed DBC sinyali seç"
                      disabled={!canMutate}
                      value={resolveBindingCatalogId(
                        selectedWidget.config.speedBinding,
                        visibleCatalogPairs
                      )}
                      onChange={(e) => {
                        if (!e.target.value) {
                          onUpdateWidget(selectedWidget.id, (w) => ({
                            ...w,
                            config: { ...w.config, speedBinding: null },
                          }));
                          return;
                        }
                        const found = allCatalogPairs.find(
                          (p) => p.id === e.target.value
                        );
                        if (!found) return;
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            speedBinding: signalSchemaToBinding(
                              found.msg,
                              found.sig,
                              found.busId,
                              TRACE_PALETTE[3],
                              {
                                databaseId: found.db.id,
                                databaseName: found.db.name,
                              }
                            ),
                          },
                        }));
                      }}
                      className="h-6 w-full rounded-[2px] border border-hairline bg-canvas px-1.5 text-[10px] text-ink"
                    >
                      <option value="">-- NONE (OPTIONAL) --</option>
                      {visibleCatalogPairs.map((p) => (
                        <option key={p.id} value={p.id}>
                          {isAllDbFilter ? p.labelAll : p.labelSingle}
                        </option>
                      ))}
                    </select>
                  )}

                  {selectedWidget.config.speedBinding && (
                    <div className="truncate text-[9px] text-muted">
                      {selectedWidget.config.speedBinding.databaseName
                        ? `[${selectedWidget.config.speedBinding.databaseName}] `
                        : ''}
                      {selectedWidget.config.speedBinding.messageKey} ::{' '}
                      <strong className="text-ink">
                        {selectedWidget.config.speedBinding.signalName}
                      </strong>{' '}
                      {selectedWidget.config.speedBinding.unit
                        ? `[${selectedWidget.config.speedBinding.unit}]`
                        : ''}
                    </div>
                  )}
                </div>

                {/* 4. Map Layer Style + Custom Tile URL */}
                <label className="block space-y-0.5">
                  <span className="text-[9px] text-subtle">
                    MAP LAYER STYLE
                  </span>
                  <select
                    disabled={!canMutate}
                    value={selectedWidget.config.mapTileStyle ?? 'osm_standard'}
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: {
                          ...w.config,
                          mapTileStyle: e.target.value as SimulationMapTileStyle,
                        },
                      }))
                    }
                    className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                  >
                    <option value="osm_standard">
                      OSM STANDARD (STREET)
                    </option>
                    <option value="osm_dark">
                      OSM DARK MATTER (LOW-GLARE)
                    </option>
                    <option value="osm_hot">OSM HUMANITARIAN (HOT)</option>
                    <option value="custom">CUSTOM XYZ TILE SERVER</option>
                  </select>
                </label>

                {selectedWidget.config.mapTileStyle === 'custom' && (
                  <label className="block space-y-0.5">
                    <span className="text-[9px] text-subtle">
                      CUSTOM TILE URL ({'{z}/{x}/{y}'})
                    </span>
                    <input
                      type="url"
                      disabled={!canMutate}
                      value={selectedWidget.config.mapCustomTileUrl ?? ''}
                      placeholder="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            mapCustomTileUrl: e.target.value,
                          },
                        }))
                      }
                      className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                    />
                  </label>
                )}

                {/* 5. Initial Zoom & Max Trail Points */}
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="space-y-0.5">
                    <span className="block text-[9px] text-subtle">
                      INITIAL ZOOM (1..19)
                    </span>
                    <input
                      type="number"
                      disabled={!canMutate}
                      min={1}
                      max={19}
                      value={selectedWidget.config.mapZoom ?? 15}
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            mapZoom: Math.max(
                              1,
                              Math.min(
                                19,
                                Math.round(Number(e.target.value) || 15)
                              )
                            ),
                          },
                        }))
                      }
                      className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                    />
                  </label>

                  <label className="space-y-0.5">
                    <span className="block text-[9px] text-subtle">
                      TRAIL MAX PTS
                    </span>
                    <input
                      type="number"
                      disabled={!canMutate}
                      min={10}
                      max={5000}
                      step={50}
                      value={selectedWidget.config.mapTrailMaxPoints ?? 400}
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            mapTrailMaxPoints: Math.max(
                              10,
                              Math.min(
                                5000,
                                Math.round(Number(e.target.value) || 400)
                              )
                            ),
                          },
                        }))
                      }
                      className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                    />
                  </label>
                </div>

                {/* 6. Default Center (Lat, Lon) */}
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="space-y-0.5">
                    <span className="block text-[9px] text-subtle">
                      DEFAULT LAT (°)
                    </span>
                    <input
                      type="number"
                      disabled={!canMutate}
                      min={-85.0511}
                      max={85.0511}
                      step={0.0001}
                      value={selectedWidget.config.mapCenterLat ?? 41.0082}
                      onChange={(e) => {
                        const parsed = Number(e.target.value);
                        if (!Number.isFinite(parsed)) return;
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            mapCenterLat: Math.max(
                              -85.0511,
                              Math.min(85.0511, parsed)
                            ),
                          },
                        }));
                      }}
                      className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                    />
                  </label>

                  <label className="space-y-0.5">
                    <span className="block text-[9px] text-subtle">
                      DEFAULT LON (°)
                    </span>
                    <input
                      type="number"
                      disabled={!canMutate}
                      min={-180}
                      max={180}
                      step={0.0001}
                      value={selectedWidget.config.mapCenterLon ?? 28.9784}
                      onChange={(e) => {
                        const parsed = Number(e.target.value);
                        if (!Number.isFinite(parsed)) return;
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            mapCenterLon: Math.max(
                              -180,
                              Math.min(180, parsed)
                            ),
                          },
                        }));
                      }}
                      className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                    />
                  </label>
                </div>

                {/* 7. GNSS Tracking & Virtual Bus Stimulus Checkboxes */}
                <div className="space-y-1.5 border-t border-hairline pt-2">
                  <label className="flex items-center gap-1.5 text-ink">
                    <input
                      type="checkbox"
                      disabled={!canMutate}
                      checked={selectedWidget.config.mapAutoFollow ?? true}
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            mapAutoFollow: e.target.checked,
                          },
                        }))
                      }
                    />
                    <span>Auto-Follow Position</span>
                  </label>

                  <label className="flex items-center gap-1.5 text-ink">
                    <input
                      type="checkbox"
                      disabled={!canMutate}
                      checked={selectedWidget.config.mapShowTrail ?? true}
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            mapShowTrail: e.target.checked,
                          },
                        }))
                      }
                    />
                    <span>Show GPS Breadcrumb Trail</span>
                  </label>

                  <label className="flex items-center gap-1.5 text-ink">
                    <input
                      type="checkbox"
                      disabled={!canMutate}
                      checked={selectedWidget.config.mapClickToSimulate ?? true}
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            mapClickToSimulate: e.target.checked,
                          },
                        }))
                      }
                    />
                    <span>Click Map to Set Simulated GPS (Virtual Bus)</span>
                  </label>
                </div>
              </div>
            )}

            {selectedWidget.kind === 'button' && (
              <div className="space-y-1.5">
                <label className="block space-y-0.5">
                  <span className="text-[9px] text-subtle">BUTTON MODE</span>
                  <select
                    disabled={!canMutate}
                    value={selectedWidget.config.buttonMode ?? 'momentary'}
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: {
                          ...w.config,
                          buttonMode: e.target.value as 'momentary' | 'toggle',
                        },
                      }))
                    }
                    className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                  >
                    <option value="momentary">MOMENTARY (PUSH-HOLD)</option>
                    <option value="toggle">TOGGLE (LATCH)</option>
                  </select>
                </label>
                <label className="block space-y-0.5">
                  <span className="text-[9px] text-subtle">BUTTON LABEL</span>
                  <input
                    type="text"
                    disabled={!canMutate}
                    value={selectedWidget.config.buttonLabel ?? ''}
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: { ...w.config, buttonLabel: e.target.value },
                      }))
                    }
                    className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                  />
                </label>
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="space-y-0.5">
                    <span className="block text-[9px] text-subtle">
                      PRESS VAL
                    </span>
                    <input
                      type="number"
                      disabled={!canMutate}
                      step="any"
                      value={selectedWidget.config.pressValue ?? 1}
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            pressValue: Number(e.target.value) || 0,
                          },
                        }))
                      }
                      className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                    />
                  </label>
                  <label className="space-y-0.5">
                    <span className="block text-[9px] text-subtle">
                      RELEASE VAL
                    </span>
                    <input
                      type="number"
                      disabled={!canMutate}
                      step="any"
                      value={selectedWidget.config.releaseValue ?? 0}
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            releaseValue: Number(e.target.value) || 0,
                          },
                        }))
                      }
                      className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                    />
                  </label>
                </div>
              </div>
            )}

            {selectedWidget.kind === 'checkbox' && (
              <div className="space-y-1.5">
                <label className="block space-y-0.5">
                  <span className="text-[9px] text-subtle">SWITCH LABEL</span>
                  <input
                    type="text"
                    disabled={!canMutate}
                    value={selectedWidget.config.checkLabel ?? ''}
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: { ...w.config, checkLabel: e.target.value },
                      }))
                    }
                    className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                  />
                </label>
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="space-y-0.5">
                    <span className="block text-[9px] text-subtle">
                      CHECKED VAL
                    </span>
                    <input
                      type="number"
                      disabled={!canMutate}
                      step="any"
                      value={selectedWidget.config.checkedValue ?? 1}
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            checkedValue: Number(e.target.value) || 0,
                          },
                        }))
                      }
                      className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                    />
                  </label>
                  <label className="space-y-0.5">
                    <span className="block text-[9px] text-subtle">
                      UNCHECKED VAL
                    </span>
                    <input
                      type="number"
                      disabled={!canMutate}
                      step="any"
                      value={selectedWidget.config.uncheckedValue ?? 0}
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            uncheckedValue: Number(e.target.value) || 0,
                          },
                        }))
                      }
                      className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                    />
                  </label>
                </div>
              </div>
            )}

            {selectedWidget.kind === 'combobox' && (
              <div className="space-y-1.5">
                {boundSchemaSignal &&
                  Object.keys(boundSchemaSignal.enumTable).length > 0 &&
                  canMutate && (
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            options: enumTableToComboOptions(
                              boundSchemaSignal.enumTable
                            ),
                          },
                        }))
                      }
                      className="inline-flex h-6 w-full cursor-pointer items-center justify-center gap-1 rounded-[2px] border border-hairline bg-elevated text-[9px] font-semibold text-focus hover:border-strong"
                    >
                      <RefreshCw className="h-2.5 w-2.5" />
                      POPULATE FROM DBC VAL_
                    </button>
                  )}

                <div className="max-h-32 space-y-1 overflow-y-auto">
                  {(selectedWidget.config.options ?? []).map((opt, idx) => (
                    <div
                      key={`${opt.value}-${idx}`}
                      className="flex items-center justify-between gap-1 rounded-[2px] border border-hairline bg-surface px-1.5 py-1"
                    >
                      <span className="truncate text-ink">
                        [{opt.value}] {opt.label}
                      </span>
                      {canMutate && (
                        <button
                          type="button"
                          onClick={() =>
                            onUpdateWidget(selectedWidget.id, (w) => ({
                              ...w,
                              config: {
                                ...w.config,
                                options: (w.config.options ?? []).filter(
                                  (_, oIdx) => oIdx !== idx
                                ),
                              },
                            }))
                          }
                          className="cursor-pointer text-muted hover:text-critical"
                        >
                          <Trash2 className="h-2.5 w-2.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {canMutate && (
                  <div className="flex gap-1 pt-1">
                    <input
                      type="number"
                      step="any"
                      value={newOptVal}
                      onChange={(e) => setNewOptVal(e.target.value)}
                      placeholder="0"
                      className="h-6 w-12 rounded-[2px] border border-hairline bg-surface px-1 text-ink"
                    />
                    <input
                      type="text"
                      value={newOptLabel}
                      onChange={(e) => setNewOptLabel(e.target.value)}
                      placeholder="0 : OFF"
                      className="h-6 flex-1 rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (!newOptLabel.trim()) return;
                        const nextOpt: SimulationComboOptionDto = {
                          value: Number(newOptVal) || 0,
                          label: newOptLabel.trim(),
                        };
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            options: [...(w.config.options ?? []), nextOpt],
                          },
                        }));
                      }}
                      className="h-6 cursor-pointer rounded-[2px] border border-hairline bg-elevated px-2 text-focus hover:border-strong"
                    >
                      +
                    </button>
                  </div>
                )}
              </div>
            )}

            {selectedWidget.kind === 'slider' && (
              <div className="space-y-1.5">
                <label className="block space-y-0.5">
                  <span className="text-[9px] text-subtle">STEP</span>
                  <input
                    type="number"
                    disabled={!canMutate}
                    min={0.0001}
                    step="any"
                    value={selectedWidget.config.step ?? 1}
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: {
                          ...w.config,
                          step: Math.max(0.0001, Number(e.target.value) || 1),
                        },
                      }))
                    }
                    className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                  />
                </label>
                <label className="inline-flex items-center gap-1.5 pt-1 text-ink">
                  <input
                    type="checkbox"
                    disabled={!canMutate}
                    checked={selectedWidget.config.showNumericInput ?? true}
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: {
                          ...w.config,
                          showNumericInput: e.target.checked,
                        },
                      }))
                    }
                  />
                  SHOW NUMERIC INPUT
                </label>
              </div>
            )}

            {(selectedWidget.kind === 'button' ||
              selectedWidget.kind === 'checkbox' ||
              selectedWidget.kind === 'combobox' ||
              selectedWidget.kind === 'slider') && (
              <div className="border-t border-hairline pt-2">
                <label className="block space-y-0.5">
                  <span className="text-[9px] text-subtle">
                    DESKTOP TX CYCLE HINT (MS · 0 = ON-CHANGE)
                  </span>
                  <input
                    type="number"
                    disabled={!canMutate}
                    min={0}
                    max={60000}
                    value={selectedWidget.config.txCycleMs ?? 0}
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: {
                          ...w.config,
                          txCycleMs: Math.max(
                            0,
                            Math.min(
                              60000,
                              Math.floor(Number(e.target.value) || 0)
                            )
                          ),
                        },
                      }))
                    }
                    className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                  />
                </label>
                <p className="mt-1 text-[9px] text-subtle">
                  Senkronize edilen NexusCAN Masaüstü istemcisi için periyodik ipucudur; Bulut üzerinde uzaktan CAN TX her zaman kilitlidir.
                </p>
              </div>
            )}

            {selectedWidget.kind === 'group' && (
              <div className="space-y-3">
                <label className="block space-y-0.5">
                  <span className="text-[9px] text-subtle">SUBTITLE</span>
                  <input
                    type="text"
                    disabled={!canMutate}
                    value={selectedWidget.config.subtitle ?? ''}
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: { ...w.config, subtitle: e.target.value },
                      }))
                    }
                    className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                  />
                </label>

                <div className="space-y-2.5 border-t border-hairline pt-2.5">
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="font-semibold uppercase tracking-wider text-focus">
                      GROUP CONTAINER // İÇERİK YÖNETİMİ
                    </span>
                    <span className="rounded-[2px] border border-hairline bg-surface px-1.5 py-0.5 text-[9px] tabular-nums text-muted">
                      {groupChildren.length} ÖĞE
                    </span>
                  </div>

                  {/* 1. Quick Add Control / Indicator into Group */}
                  <div className="space-y-1">
                    <span className="block text-[9px] uppercase text-subtle">
                      GRUBA HIZLI KONTROL / GÖSTERGE EKLE
                    </span>
                    <div className="grid grid-cols-2 gap-1">
                      {GROUP_QUICK_ADD_OPTIONS.map((opt) => (
                        <button
                          key={opt.kind}
                          type="button"
                          disabled={!canMutate}
                          onClick={() =>
                            onAddWidgetToGroup(selectedWidget.id, opt.kind)
                          }
                          className="flex h-6 cursor-pointer items-center justify-center rounded-[2px] border border-hairline bg-surface px-1.5 text-[9px] font-semibold uppercase tracking-wider text-ink transition-colors hover:border-strong hover:bg-elevated hover:text-focus disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 2. Move Existing Outside Widget into This Group */}
                  {outsideGroupWidgets.length > 0 && (
                    <div className="space-y-1 border-t border-hairline pt-2">
                      <span className="block text-[9px] uppercase text-subtle">
                        PANELDEKİ MEVCUT BİLEŞENİ BU GRUBA TAŞI
                      </span>
                      <div className="flex items-center gap-1">
                        <select
                          aria-label="Bu gruba taşınacak bileşeni seçin"
                          disabled={!canMutate}
                          value={effectiveMoveCandidateId}
                          onChange={(e) =>
                            setMoveCandidateWidgetId(e.target.value)
                          }
                          className="h-6 min-w-0 flex-1 rounded-[2px] border border-hairline bg-surface px-1.5 text-[10px] tabular-nums text-ink disabled:opacity-60"
                        >
                          {outsideGroupWidgets.map((w) => (
                            <option key={w.id} value={w.id}>
                              [{w.kind.toUpperCase()}] {w.title} ({w.layout.col},
                              {w.layout.row})
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={!canMutate || !effectiveMoveCandidateId}
                          onClick={() => {
                            if (!effectiveMoveCandidateId) return;
                            onMoveWidgetIntoGroup(
                              effectiveMoveCandidateId,
                              selectedWidget.id
                            );
                          }}
                          className="h-6 shrink-0 cursor-pointer rounded-[2px] border border-strong bg-elevated px-2 text-[9px] font-semibold uppercase tracking-wider text-focus hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          GRUBA TAŞI
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 3. Children Inside Group List */}
                  <div className="space-y-1 border-t border-hairline pt-2">
                    <span className="block text-[9px] uppercase tabular-nums text-subtle">
                      GRUP İÇİNDEKİ BİLEŞENLER ({groupChildren.length})
                    </span>
                    {groupChildren.length === 0 ? (
                      <div className="rounded-[2px] border border-hairline bg-surface px-2 py-2 text-center text-[9px] text-muted">
                        BU GRUPTA HENÜZ BİLEŞEN YOK. YUKARIDAN HIZLI EKLEYİN VEYA SOL PALETTEN SÜRÜKLEYİN.
                      </div>
                    ) : (
                      <div className="max-h-44 space-y-1 overflow-y-auto">
                        {groupChildren.map((child) => (
                          <div
                            key={child.id}
                            className="flex items-center justify-between gap-1.5 rounded-[2px] border border-hairline bg-surface px-2 py-1"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-1">
                                <span className="shrink-0 rounded-[1px] border border-hairline bg-elevated px-1 text-[8px] font-semibold uppercase text-focus">
                                  {child.kind}
                                </span>
                                <span className="truncate font-semibold text-ink">
                                  {child.title}
                                </span>
                              </div>
                              <div className="text-[9px] tabular-nums text-subtle">
                                {child.layout.col},{child.layout.row} ·{' '}
                                {child.layout.w}×{child.layout.h}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => onSelectWidget(child.id)}
                              className="shrink-0 cursor-pointer rounded-[2px] border border-hairline bg-elevated px-1.5 py-0.5 text-[9px] font-semibold uppercase text-ink hover:border-strong hover:text-focus"
                            >
                              DÜZENLE
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
