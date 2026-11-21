import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Compass,
  Copy,
  Database,
  Keyboard,
  Link2,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  Trash2,
  Unlink,
  X,
} from 'lucide-react';
import { useI18n, type TranslationKey } from '../../i18n';
import type {
  DatabaseSchemaDto,
  MessageSchemaDto,
  NetworkDatabaseSummaryDto,
  SignalSchemaDto,
  SimulationAccentColor,
  SimulationButtonMode,
  SimulationComboOptionDto,
  SimulationGeneratorSpecDto,
  SimulationLedOperator,
  SimulationMapTileStyle,
  SimulationTextFormat,
  SimulationTextMode,
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
import {
  captureHotkeyFromKeyboardEvent,
  formatHotkeyBadge,
} from './buttonControlUtils';

interface GroupQuickAddOptionDef {
  kind: SimulationWidgetKind;
  labelKey: TranslationKey;
}

const GROUP_QUICK_ADD_OPTIONS: ReadonlyArray<GroupQuickAddOptionDef> = [
  { kind: 'button', labelKey: 'simInsp.groupAdd.button' },
  { kind: 'checkbox', labelKey: 'simInsp.groupAdd.checkbox' },
  { kind: 'combobox', labelKey: 'simInsp.groupAdd.combobox' },
  { kind: 'slider', labelKey: 'simInsp.groupAdd.slider' },
  { kind: 'gauge', labelKey: 'simInsp.groupAdd.gauge' },
  { kind: 'bar', labelKey: 'simInsp.groupAdd.bar' },
  { kind: 'numeric', labelKey: 'simInsp.groupAdd.numeric' },
  { kind: 'led', labelKey: 'simInsp.groupAdd.led' },
  { kind: 'enum_badge', labelKey: 'simInsp.groupAdd.enum' },
  { kind: 'graph', labelKey: 'simInsp.groupAdd.graph' },
  { kind: 'map', labelKey: 'simInsp.groupAdd.map' },
];

const ACCENT_OPTIONS: readonly SimulationAccentColor[] = [
  'steel',
  'cyan',
  'emerald',
  'amber',
  'red',
  'blue',
];

interface WidgetKindOptionDef {
  value: SimulationWidgetKind;
  labelKey: TranslationKey;
}

const WIDGET_KIND_OPTIONS: ReadonlyArray<WidgetKindOptionDef> = [
  { value: 'gauge', labelKey: 'simInsp.kind.gauge' },
  { value: 'bar', labelKey: 'simInsp.kind.bar' },
  { value: 'numeric', labelKey: 'simInsp.kind.numeric' },
  { value: 'led', labelKey: 'simInsp.kind.led' },
  { value: 'enum_badge', labelKey: 'simInsp.kind.enum_badge' },
  { value: 'graph', labelKey: 'simInsp.kind.graph' },
  { value: 'map', labelKey: 'simInsp.kind.map' },
  { value: 'button', labelKey: 'simInsp.kind.button' },
  { value: 'checkbox', labelKey: 'simInsp.kind.checkbox' },
  { value: 'combobox', labelKey: 'simInsp.kind.combobox' },
  { value: 'slider', labelKey: 'simInsp.kind.slider' },
  { value: 'textbox', labelKey: 'simInsp.kind.textbox' },
  { value: 'group', labelKey: 'simInsp.kind.group' },
];

interface WaveformOptionDef {
  value: SimulationWaveformKind;
  labelKey: TranslationKey;
}

const WAVEFORM_OPTIONS: ReadonlyArray<WaveformOptionDef> = [
  { value: 'sine', labelKey: 'simInsp.waveform.sine' },
  { value: 'triangle', labelKey: 'simInsp.waveform.triangle' },
  { value: 'sawtooth', labelKey: 'simInsp.waveform.sawtooth' },
  { value: 'square', labelKey: 'simInsp.waveform.square' },
  { value: 'constant', labelKey: 'simInsp.waveform.constant' },
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
  generators?: readonly SimulationGeneratorSpecDto[];
  databases?: readonly NetworkDatabaseSummaryDto[];
  loadedDbEntries?: readonly LoadedSimulationDatabaseEntry[];
  schema?: DatabaseSchemaDto | null;
  onSelectWidget: (widgetId: string) => void;
  onAddWidgetToGroup: (groupId: string, kind: SimulationWidgetKind) => void;
  onMoveWidgetIntoGroup: (widgetId: string, groupId: string) => void;
  onUpdateWidget: (
    widgetId: string,
    updater: (prev: SimulationWidgetDto) => SimulationWidgetDto
  ) => void;
  onDuplicateWidget: (widgetId: string) => void;
  onDeleteWidget: (widgetId: string) => void;
  onUpdateGenerators?: (next: SimulationGeneratorSpecDto[]) => void;
  /** Restrict the kind selector (e.g. UDS panels have no GNSS map). Default: all kinds. */
  widgetKinds?: readonly SimulationWidgetKind[];
  /** Replaces the DBC signal binding block of non-group widgets (e.g. UDS read/write binding). */
  renderBindingSection?: (widget: SimulationWidgetDto) => React.ReactNode;
  /** Show the waveform GENERATORS tab (DBC virtual bus only). Default true. */
  showGeneratorsTab?: boolean;
  /** Show the periodic TX cycle hint field (CAN signal TX only). Default true. */
  showTxCycle?: boolean;
  /** 'signal' = numeric CAN signal (ascii display only); 'bytes' = byte payload source (UDS). */
  textboxSource?: 'signal' | 'bytes';
}

const NO_GENERATORS: readonly SimulationGeneratorSpecDto[] = [];
const NO_DATABASES: readonly NetworkDatabaseSummaryDto[] = [];
const NO_DB_ENTRIES: readonly LoadedSimulationDatabaseEntry[] = [];

export function SimulationInspectorSidebar({
  canMutate,
  gridCols,
  selectedWidget,
  allWidgets,
  generators = NO_GENERATORS,
  databases = NO_DATABASES,
  loadedDbEntries = NO_DB_ENTRIES,
  schema = null,
  onSelectWidget,
  onAddWidgetToGroup,
  onMoveWidgetIntoGroup,
  onUpdateWidget,
  onDuplicateWidget,
  onDeleteWidget,
  onUpdateGenerators = () => undefined,
  widgetKinds,
  renderBindingSection,
  showGeneratorsTab = true,
  showTxCycle = true,
  textboxSource = 'signal',
}: SimulationInspectorSidebarProps): React.JSX.Element {
  const { t } = useI18n();

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
  const [newCycleVal, setNewCycleVal] = useState<string>('0');
  const [newCycleLabel, setNewCycleLabel] = useState<string>('MOD 0');
  const [capturingHotkeyWidgetId, setCapturingHotkeyWidgetId] = useState<
    string | null
  >(null);
  const [moveCandidateWidgetId, setMoveCandidateWidgetId] =
    useState<string>('');

  useEffect(() => {
    if (
      !capturingHotkeyWidgetId ||
      !selectedWidget ||
      selectedWidget.id !== capturingHotkeyWidgetId ||
      !canMutate
    ) {
      return;
    }

    const onCaptureKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setCapturingHotkeyWidgetId(null);
        return;
      }
      const captured = captureHotkeyFromKeyboardEvent(e);
      if (!captured) return;
      e.preventDefault();
      e.stopPropagation();
      onUpdateWidget(selectedWidget.id, (w) => ({
        ...w,
        config: {
          ...w.config,
          hotkey: captured,
        },
      }));
      setCapturingHotkeyWidgetId(null);
    };

    window.addEventListener('keydown', onCaptureKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onCaptureKeyDown, true);
    };
  }, [canMutate, capturingHotkeyWidgetId, onUpdateWidget, selectedWidget]);

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
          {t('simInsp.gen.allDbs', { count: databases.length })}
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
      data-tour="panels.inspector"
      aria-label={t('simInsp.aside.aria')}
      className="flex w-full shrink-0 flex-col border-t border-hairline bg-surface lg:w-[340px] xl:w-[380px] lg:border-t-0 lg:border-l"
    >
      {/* Top Sub-Tabs: INSPECTOR vs GENERATORS */}
      <div
        className={`grid min-h-[40px] shrink-0 border-b border-hairline bg-elevated font-mono text-[12px] font-semibold uppercase tracking-wider ${
          showGeneratorsTab ? 'grid-cols-2' : 'grid-cols-1'
        }`}
      >
        <button
          type="button"
          onClick={() => setActiveTab('inspector')}
          className={`flex cursor-pointer items-center justify-center gap-1.5 border-r border-hairline transition-colors ${
            activeTab === 'inspector'
              ? 'bg-surface text-ink'
              : 'text-muted hover:text-ink'
          }`}
        >
          <Settings2 className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
          {t('simInsp.tab.inspector')}
        </button>
        {showGeneratorsTab && (
        <button
          type="button"
          onClick={() => setActiveTab('generators')}
          className={`flex cursor-pointer items-center justify-center gap-1.5 tabular-nums transition-colors ${
            activeTab === 'generators'
              ? 'bg-surface text-ink'
              : 'text-muted hover:text-ink'
          }`}
        >
          <Activity className="h-3.5 w-3.5 text-nominal" aria-hidden="true" />
          {t('simInsp.tab.generators', {
            active: activeGenCount,
            total: generators.length,
          })}
        </button>
        )}
      </div>

      {showGeneratorsTab && activeTab === 'generators' ? (
        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted">
              {t('simInsp.gen.headerTitle')}
            </span>
            <button
              type="button"
              disabled={!canMutate}
              onClick={handleAddGenerator}
              className="inline-flex h-[28px] cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-elevated px-2.5 font-mono text-[11.5px] font-semibold text-focus hover:border-strong disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {t('simInsp.gen.addBtn')}
            </button>
          </div>

          {databases.length > 0 && (
            <div className="space-y-1">
              <span className="block font-mono text-[9px] uppercase text-subtle">
                {t('simInsp.gen.dbFilterLabel')}
              </span>
              {renderDatabaseFilterDropdown(t('simInsp.gen.dbFilterAria'))}
            </div>
          )}

          {generators.length === 0 ? (
            <div className="rounded-[2px] border border-hairline bg-canvas p-4 text-center font-mono text-[11px] text-muted">
              {t('simInsp.gen.empty')}
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
                        {gen.enabled ? t('simInsp.gen.enabled') : t('simInsp.gen.paused')}
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
                        aria-label={t('simInsp.gen.deleteAria')}
                        className="cursor-pointer rounded-[2px] p-1 text-muted hover:text-critical"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>

                    {visibleCatalogPairs.length > 0 && (
                      <select
                        aria-label={t('simInsp.gen.signalAria')}
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
                        <option value="">{t('simInsp.gen.selectSignal')}</option>
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
                          {t('simInsp.gen.messageKey')}
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
                          {t('simInsp.gen.signalName')}
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
                          {t('simInsp.gen.waveform')}
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
                            <option key={wf.value} value={wf.value}>
                              {t(wf.labelKey)}
                            </option>
                          ))}
                        </select>
                      </label>

                      {gen.waveform === 'constant' ? (
                        <label className="space-y-0.5">
                          <span className="block text-[9px] text-subtle">
                            {t('simInsp.gen.constVal')}
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
                            {t('simInsp.gen.freqHz')}
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
                            {t('simInsp.gen.min')}
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
                            {t('simInsp.gen.max')}
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
          {t('simInsp.empty.hint')}
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
                  title={t('simInsp.actions.dupTitle')}
                  className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-elevated px-1.5 text-[9px] text-ink hover:border-strong"
                >
                  <Copy className="h-2.5 w-2.5" aria-hidden="true" />
                  {t('simInsp.actions.dupBtn')}
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteWidget(selectedWidget.id)}
                  title={t('simInsp.actions.delTitle')}
                  className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-elevated px-1.5 text-[9px] text-muted hover:border-critical hover:text-critical"
                >
                  <Trash2 className="h-2.5 w-2.5" aria-hidden="true" />
                  {t('simInsp.actions.delBtn')}
                </button>
              </div>
            )}
          </div>

          {/* General Metadata & Grid Coordinates */}
          <div className="space-y-2.5">
            <label className="block space-y-1">
              <span className="text-[11.5px] font-medium uppercase text-muted">
                {t('simInsp.general.title')}
              </span>
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
                className="h-[30px] w-full rounded-[2px] border border-hairline bg-canvas px-2.5 font-sans text-[12px] text-ink"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[11.5px] font-medium uppercase text-muted">
                {t('simInsp.general.type')}
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
                className="h-[30px] w-full rounded-[2px] border border-hairline bg-canvas px-2 text-[12px] text-ink"
              >
                {WIDGET_KIND_OPTIONS.filter(
                  (opt) => !widgetKinds || widgetKinds.includes(opt.value)
                ).map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {t(opt.labelKey)}
                  </option>
                ))}
              </select>
            </label>

            <div className="space-y-1">
              <span className="block text-[11.5px] font-medium uppercase text-muted">
                {t('simInsp.general.accentColor')}
              </span>
              <div className="grid grid-cols-6 gap-1.5">
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
                      className={`flex h-7 cursor-pointer items-center justify-center rounded-[2px] border ${
                        active
                          ? 'border-ink bg-elevated'
                          : 'border-hairline bg-canvas'
                      }`}
                    >
                      <span
                        className="h-3.5 w-3.5 rounded-[1px]"
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
                <span className="block text-[11px] font-medium text-muted">
                  {t('simInsp.general.col')}
                </span>
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
                  className="h-[28px] w-full rounded-[2px] border border-hairline bg-canvas px-1.5 font-mono text-[12px] text-ink"
                />
              </label>
              <label className="space-y-0.5">
                <span className="block text-[11px] font-medium text-muted">
                  {t('simInsp.general.row')}
                </span>
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
                  className="h-[28px] w-full rounded-[2px] border border-hairline bg-canvas px-1.5 font-mono text-[12px] text-ink"
                />
              </label>
              <label className="space-y-0.5">
                <span className="block text-[11px] font-medium text-muted">
                  {t('simInsp.general.w')}
                </span>
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
                  className="h-[28px] w-full rounded-[2px] border border-hairline bg-canvas px-1.5 font-mono text-[12px] text-ink"
                />
              </label>
              <label className="space-y-0.5">
                <span className="block text-[11px] font-medium text-muted">
                  {t('simInsp.general.h')}
                </span>
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
                  className="h-[28px] w-full rounded-[2px] border border-hairline bg-canvas px-1.5 font-mono text-[12px] text-ink"
                />
              </label>
            </div>
          </div>

          {/* Custom data-source binding (e.g. UDS) replaces the DBC picker when provided */}
          {selectedWidget.kind !== 'group' && renderBindingSection?.(selectedWidget)}

          {/* Multi-DBC Smart SignalBindingPicker (for all non-group widgets) */}
          {selectedWidget.kind !== 'group' && !renderBindingSection && (
            <div className="space-y-2 rounded-[2px] border border-hairline bg-canvas p-2.5">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1 font-semibold uppercase text-ink">
                  <Link2 className="h-3 w-3 text-focus" aria-hidden="true" />
                  {selectedWidget.kind === 'map'
                    ? t('simInsp.binding.latPrimary')
                    : t('simInsp.binding.title')}
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
                      {t('simInsp.binding.unbindBtn')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => initManualBinding(selectedWidget)}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-1.5 py-0.5 text-[9px] text-focus hover:border-strong"
                    >
                      <Plus className="h-2.5 w-2.5" />
                      {t('simInsp.binding.manualBindBtn')}
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
                      {t('simInsp.binding.schemaLabel')}{' '}
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
                    {t('simInsp.binding.autoPairGnss')}
                  </button>
                )}

              {/* Multi-DBC Filter + Searchable Signal Picker */}
              {allCatalogPairs.length > 0 && (
                <div className="space-y-1">
                  {renderDatabaseFilterDropdown(
                    t('simInsp.binding.dbFilterAria')
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
                      placeholder={t('simInsp.binding.searchPlaceholder')}
                      className="h-6 w-full rounded-[2px] border border-hairline bg-surface pr-2 pl-5 text-[10px] text-ink placeholder:text-subtle"
                    />
                  </div>

                  <select
                    aria-label={t('simInsp.binding.selectSignalAria')}
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
                      {t('simInsp.binding.selectSignalPrompt', {
                        count: filteredCatalogPairs.length,
                      })}
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
                      <span className="block text-[9px] text-subtle">
                        {t('simInsp.binding.bus')}
                      </span>
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
                        {t('simInsp.binding.arbId')}
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
                      <span className="block text-[9px] text-subtle">
                        {t('simInsp.binding.frame')}
                      </span>
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
                        <option value="STD">{t('simInsp.binding.std11')}</option>
                        <option value="EXT">{t('simInsp.binding.ext29')}</option>
                      </select>
                    </label>
                  </div>

                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="space-y-0.5">
                      <span className="block text-[9px] text-subtle">
                        {t('simInsp.binding.messageName')}
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
                        {t('simInsp.binding.signalName')}
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
                      <span className="block text-[9px] text-subtle">
                        {t('simInsp.binding.unit')}
                      </span>
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
                      <span className="block text-[9px] text-subtle">
                        {t('simInsp.binding.min')}
                      </span>
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
                      <span className="block text-[9px] text-subtle">
                        {t('simInsp.binding.max')}
                      </span>
                      <input
                        type="number"
                        disabled={!!canMutate}
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
                        {t('simInsp.binding.factor')}
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
                        {t('simInsp.binding.offset')}
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
                        {t('simInsp.binding.decimals')}
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
              {t('simInsp.params.header')}
            </div>

            {(selectedWidget.kind === 'gauge' ||
              selectedWidget.kind === 'bar' ||
              selectedWidget.kind === 'slider') && (
              <div className="grid grid-cols-2 gap-1.5">
                <label className="space-y-0.5">
                  <span className="block text-[9px] text-subtle">
                    {t('simInsp.params.scaleMin')}
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
                    {t('simInsp.params.scaleMax')}
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
                  <span className="block text-[9px] text-subtle">
                    {t('simInsp.params.warnLow')}
                  </span>
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
                    {t('simInsp.params.warnHigh')}
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
                  <span className="block text-[9px] text-subtle">
                    {t('simInsp.params.critLow')}
                  </span>
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
                    {t('simInsp.params.critHigh')}
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
                  <span className="text-[9px] text-subtle">
                    {t('simInsp.params.majorTicks')}
                  </span>
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
                    {t('simInsp.params.needle')}
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
                    {t('simInsp.params.digital')}
                  </label>
                </div>
              </div>
            )}

            {selectedWidget.kind === 'bar' && (
              <div className="space-y-1.5">
                <label className="block space-y-0.5">
                  <span className="text-[9px] text-subtle">
                    {t('simInsp.params.orientation')}
                  </span>
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
                    <option value="horizontal">
                      {t('simInsp.params.horizontal')}
                    </option>
                    <option value="vertical">
                      {t('simInsp.params.vertical')}
                    </option>
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
                  {t('simInsp.params.peakHold')}
                </label>
              </div>
            )}

            {selectedWidget.kind === 'numeric' && (
              <div className="space-y-1.5">
                <label className="block space-y-0.5">
                  <span className="text-[9px] text-subtle">
                    {t('simInsp.params.digitSize')}
                  </span>
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
                    <option value="sm">{t('simInsp.params.sizeSm')}</option>
                    <option value="md">{t('simInsp.params.sizeMd')}</option>
                    <option value="lg">{t('simInsp.params.sizeLg')}</option>
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
                  {t('simInsp.params.showRawHex')}
                </label>
              </div>
            )}

            {selectedWidget.kind === 'led' && (
              <div className="space-y-1.5">
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="space-y-0.5">
                    <span className="block text-[9px] text-subtle">
                      {t('simInsp.params.ledOperator')}
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
                      {t('simInsp.params.ledThreshold')}
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
                      {t('simInsp.params.ledOnLabel')}
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
                      {t('simInsp.params.ledOffLabel')}
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
                      {t('simInsp.params.syncValDbc')}
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
                      {t('simInsp.params.graphWindowSec')}
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
                      {t('simInsp.params.graphAutoScaleY')}
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
                      {t('simInsp.params.graphShowLegend')}
                    </label>
                  </div>
                </div>

                {!(selectedWidget.config.autoScaleY ?? true) && (
                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="space-y-0.5">
                      <span className="block text-[9px] text-subtle">
                        {t('simInsp.params.graphFixedYMin')}
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
                        {t('simInsp.params.graphFixedYMax')}
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
                    {t('simInsp.params.extraTraces', {
                      count: selectedWidget.config.extraBindings?.length ?? 0,
                    })}
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
                        <option value="">{t('simInsp.params.selectExtraTrace')}</option>
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
                        {t('simInsp.params.addExtraTraceBtn')}
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
                      {t('simInsp.params.mapLonSignal')}
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
                          {t('simInsp.binding.unbindBtn')}
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
                          {t('simInsp.params.mapManualBtn')}
                        </button>
                      ))}
                  </div>

                  {visibleCatalogPairs.length > 0 && (
                    <select
                      aria-label={t('simInsp.params.mapPickLonDbc')}
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
                      <option value="">{t('simInsp.params.mapPickLonDbc')}</option>
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
                      {t('simInsp.params.mapHdgSignal')}
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
                          {t('simInsp.params.clearBtn')}
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
                          {t('simInsp.params.mapManualBtn')}
                        </button>
                      ))}
                  </div>

                  {visibleCatalogPairs.length > 0 && (
                    <select
                      aria-label={t('simInsp.params.mapAutoBearing')}
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
                        {t('simInsp.params.mapAutoBearing')}
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
                      {t('simInsp.params.mapSpeedSignal')}
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
                          {t('simInsp.params.clearBtn')}
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
                          {t('simInsp.params.mapManualBtn')}
                        </button>
                      ))}
                  </div>

                  {visibleCatalogPairs.length > 0 && (
                    <select
                      aria-label={t('simInsp.params.mapSpeedSignal')}
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
                      <option value="">{t('simInsp.params.mapSpeedNone')}</option>
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
                    {t('simInsp.params.mapLayerStyle')}
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
                      {t('simInsp.params.mapOsmStandard')}
                    </option>
                    <option value="osm_dark">
                      {t('simInsp.params.mapOsmDark')}
                    </option>
                    <option value="osm_hot">
                      {t('simInsp.params.mapOsmHot')}
                    </option>
                    <option value="custom">
                      {t('simInsp.params.mapCustomTile')}
                    </option>
                  </select>
                </label>

                {selectedWidget.config.mapTileStyle === 'custom' && (
                  <label className="block space-y-0.5">
                    <span className="text-[9px] text-subtle">
                      {t('simInsp.params.mapCustomTileUrl')}
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
                      {t('simInsp.params.mapInitZoom')}
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
                      {t('simInsp.params.mapTrailMaxPts')}
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
                      {t('simInsp.params.mapDefaultLat')}
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
                      {t('simInsp.params.mapDefaultLon')}
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
                    <span>{t('simInsp.params.mapAutoFollow')}</span>
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
                    <span>{t('simInsp.params.mapShowTrail')}</span>
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
                    <span>{t('simInsp.params.mapClickToSimulate')}</span>
                  </label>
                </div>
              </div>
            )}

            {selectedWidget.kind === 'button' && (
              <div className="space-y-2">
                <label className="block space-y-0.5">
                  <span className="text-[9px] text-subtle">
                    {t('simInsp.params.btnModeLabel')}
                  </span>
                  <select
                    disabled={!canMutate}
                    value={selectedWidget.config.buttonMode ?? 'momentary'}
                    onChange={(e) =>
                      onUpdateWidget(selectedWidget.id, (w) => ({
                        ...w,
                        config: {
                          ...w.config,
                          buttonMode: e.target.value as SimulationButtonMode,
                        },
                      }))
                    }
                    className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                  >
                    <option value="momentary">
                      {t('simInsp.params.btnModeMomentary')}
                    </option>
                    <option value="toggle">
                      {t('simInsp.params.btnModeToggle')}
                    </option>
                    <option value="pulse">
                      {t('simInsp.params.btnModePulse')}
                    </option>
                    <option value="step">
                      {t('simInsp.params.btnModeStep')}
                    </option>
                    <option value="cycle">
                      {t('simInsp.params.btnModeCycle')}
                    </option>
                  </select>
                </label>

                <label className="block space-y-0.5">
                  <span className="text-[9px] text-subtle">
                    {t('simInsp.params.btnLabel')}
                  </span>
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

                {/* PRESS / RELEASE values for momentary, toggle, pulse */}
                {(selectedWidget.config.buttonMode === undefined ||
                  selectedWidget.config.buttonMode === 'momentary' ||
                  selectedWidget.config.buttonMode === 'toggle' ||
                  selectedWidget.config.buttonMode === 'pulse') && (
                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="space-y-0.5">
                      <span className="block text-[9px] text-subtle">
                        {t('simInsp.params.btnPressVal')}
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
                        {t('simInsp.params.btnReleaseVal')}
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
                )}

                {/* PULSE duration */}
                {selectedWidget.config.buttonMode === 'pulse' && (
                  <label className="block space-y-0.5">
                    <span className="text-[9px] text-subtle">
                      {t('simInsp.params.btnPulseDuration')}
                    </span>
                    <input
                      type="number"
                      disabled={!canMutate}
                      min={20}
                      max={60000}
                      step={10}
                      value={selectedWidget.config.pulseDurationMs ?? 250}
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            pulseDurationMs: Math.max(
                              20,
                              Math.min(
                                60000,
                                Math.round(Number(e.target.value) || 250)
                              )
                            ),
                          },
                        }))
                      }
                      className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                    />
                  </label>
                )}

                {/* STEP delta, bounds & wrap */}
                {selectedWidget.config.buttonMode === 'step' && (
                  <div className="space-y-1.5 rounded-[2px] border border-hairline bg-surface p-2">
                    <label className="block space-y-0.5">
                      <span className="text-[9px] text-subtle">
                        {t('simInsp.params.btnStepDelta')}
                      </span>
                      <input
                        type="number"
                        disabled={!canMutate}
                        step="any"
                        value={selectedWidget.config.stepDelta ?? 1}
                        onChange={(e) => {
                          const parsed = Number(e.target.value);
                          onUpdateWidget(selectedWidget.id, (w) => ({
                            ...w,
                            config: {
                              ...w.config,
                              stepDelta: Number.isFinite(parsed) ? parsed : 1,
                            },
                          }));
                        }}
                        className="h-6 w-full rounded-[2px] border border-hairline bg-canvas px-1.5 text-ink"
                      />
                    </label>
                    <div className="grid grid-cols-2 gap-1.5">
                      <label className="space-y-0.5">
                        <span className="block text-[9px] text-subtle">
                          {t('simInsp.params.btnMinBound')}
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
                          className="h-6 w-full rounded-[2px] border border-hairline bg-canvas px-1.5 text-ink"
                        />
                      </label>
                      <label className="space-y-0.5">
                        <span className="block text-[9px] text-subtle">
                          {t('simInsp.params.btnMaxBound')}
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
                          className="h-6 w-full rounded-[2px] border border-hairline bg-canvas px-1.5 text-ink"
                        />
                      </label>
                    </div>
                    <label className="inline-flex cursor-pointer items-center gap-1.5 pt-0.5 text-[10px] text-ink">
                      <input
                        type="checkbox"
                        disabled={!canMutate}
                        checked={selectedWidget.config.stepWrap === true}
                        onChange={(e) =>
                          onUpdateWidget(selectedWidget.id, (w) => ({
                            ...w,
                            config: {
                              ...w.config,
                              stepWrap: e.target.checked,
                            },
                          }))
                        }
                      />
                      <span>{t('simInsp.params.btnStepWrap')}</span>
                    </label>
                  </div>
                )}

                {/* CYCLE options add / edit / remove */}
                {selectedWidget.config.buttonMode === 'cycle' && (
                  <div className="space-y-1.5 rounded-[2px] border border-hairline bg-surface p-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] font-semibold uppercase text-subtle">
                        {t('simInsp.params.btnCycleOptions')}
                      </span>
                      <span className="text-[9px] text-muted">
                        {t('simInsp.params.btnCycleCount', {
                          count: (selectedWidget.config.cycleOptions ?? []).length,
                        })}
                      </span>
                    </div>

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
                                cycleOptions: enumTableToComboOptions(
                                  boundSchemaSignal.enumTable
                                ),
                              },
                            }))
                          }
                          className="inline-flex h-6 w-full cursor-pointer items-center justify-center gap-1 rounded-[2px] border border-hairline bg-elevated text-[9px] font-semibold text-focus hover:border-strong"
                        >
                          <RefreshCw className="h-2.5 w-2.5" />
                          {t('simInsp.params.btnFillDbc')}
                        </button>
                      )}

                    <div className="max-h-36 space-y-1 overflow-y-auto">
                      {(selectedWidget.config.cycleOptions ?? []).length ===
                        0 && (
                        <div className="rounded-[2px] border border-dashed border-hairline bg-canvas px-1.5 py-1 text-[9px] text-muted">
                          {t('simInsp.params.btnCycleEmptyHint')}
                        </div>
                      )}
                      {(selectedWidget.config.cycleOptions ?? []).map(
                        (opt, idx) => (
                          <div
                            key={`cycle-${idx}`}
                            className="flex items-center gap-1"
                          >
                            <input
                              type="number"
                              step="any"
                              disabled={!canMutate}
                              aria-label={`Cycle value ${idx + 1}`}
                              value={opt.value}
                              onChange={(e) => {
                                const nextNum = Number(e.target.value) || 0;
                                onUpdateWidget(selectedWidget.id, (w) => ({
                                  ...w,
                                  config: {
                                    ...w.config,
                                    cycleOptions: (
                                      w.config.cycleOptions ?? []
                                    ).map((item, oIdx) =>
                                      oIdx === idx
                                        ? { ...item, value: nextNum }
                                        : item
                                    ),
                                  },
                                }));
                              }}
                              className="h-6 w-12 rounded-[2px] border border-hairline bg-canvas px-1 text-ink"
                            />
                            <input
                              type="text"
                              disabled={!canMutate}
                              aria-label={`Cycle label ${idx + 1}`}
                              value={opt.label}
                              maxLength={120}
                              onChange={(e) => {
                                const nextLabel = e.target.value;
                                onUpdateWidget(selectedWidget.id, (w) => ({
                                  ...w,
                                  config: {
                                    ...w.config,
                                    cycleOptions: (
                                      w.config.cycleOptions ?? []
                                    ).map((item, oIdx) =>
                                      oIdx === idx
                                        ? {
                                            ...item,
                                            label: nextLabel || `${item.value}`,
                                          }
                                        : item
                                    ),
                                  },
                                }));
                              }}
                              className="h-6 min-w-0 flex-1 rounded-[2px] border border-hairline bg-canvas px-1.5 text-ink"
                            />
                            {canMutate && (
                              <button
                                type="button"
                                title={t('simInsp.params.btnDeleteCycleState')}
                                onClick={() =>
                                  onUpdateWidget(selectedWidget.id, (w) => ({
                                    ...w,
                                    config: {
                                      ...w.config,
                                      cycleOptions: (
                                        w.config.cycleOptions ?? []
                                      ).filter((_, oIdx) => oIdx !== idx),
                                    },
                                  }))
                                }
                                className="cursor-pointer p-0.5 text-muted hover:text-critical"
                              >
                                <Trash2 className="h-3 w-3" />
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
                          step="any"
                          value={newCycleVal}
                          onChange={(e) => setNewCycleVal(e.target.value)}
                          placeholder="0"
                          className="h-6 w-12 rounded-[2px] border border-hairline bg-canvas px-1 text-ink"
                        />
                        <input
                          type="text"
                          value={newCycleLabel}
                          maxLength={120}
                          onChange={(e) => setNewCycleLabel(e.target.value)}
                          placeholder={t('simInsp.params.btnCycleNamePlaceholder')}
                          className="h-6 min-w-0 flex-1 rounded-[2px] border border-hairline bg-canvas px-1.5 text-ink"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const clean = newCycleLabel.trim();
                            if (!clean) return;
                            const nextVal = Number(newCycleVal) || 0;
                            const nextOpt: SimulationComboOptionDto = {
                              value: nextVal,
                              label: clean,
                            };
                            onUpdateWidget(selectedWidget.id, (w) => ({
                              ...w,
                              config: {
                                ...w.config,
                                cycleOptions: [
                                  ...(w.config.cycleOptions ?? []),
                                  nextOpt,
                                ],
                              },
                            }));
                            setNewCycleVal(String(nextVal + 1));
                            setNewCycleLabel(`MOD ${nextVal + 1}`);
                          }}
                          className="inline-flex h-6 cursor-pointer items-center gap-0.5 rounded-[2px] border border-hairline bg-elevated px-2 text-[9px] font-semibold text-focus hover:border-strong"
                        >
                          <Plus className="h-2.5 w-2.5" />
                          {t('simInsp.params.btnAddBtn')}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Hotkey Assignment ("Tuş Ata" capture + clear) */}
                <div className="space-y-1 rounded-[2px] border border-hairline bg-surface p-2">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase text-subtle">
                      <Keyboard className="h-2.5 w-2.5" />
                      {t('simInsp.params.btnHotkeyLabel')}
                    </span>
                    {selectedWidget.config.hotkey ? (
                      <kbd className="rounded-[2px] border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[9px] font-bold text-focus">
                        [{formatHotkeyBadge(selectedWidget.config.hotkey)}]
                      </kbd>
                    ) : (
                      <span className="text-[9px] text-muted">
                        {t('simInsp.params.btnHotkeyNone')}
                      </span>
                    )}
                  </div>

                  {canMutate && (
                    <div className="flex items-center gap-1 pt-0.5">
                      <button
                        type="button"
                        onClick={() =>
                          setCapturingHotkeyWidgetId((prev) =>
                            prev === selectedWidget.id
                              ? null
                              : selectedWidget.id
                          )
                        }
                        className="inline-flex h-6 flex-1 cursor-pointer items-center justify-center gap-1 rounded-[2px] border px-2 text-[9px] font-semibold transition-colors"
                        style={
                          capturingHotkeyWidgetId === selectedWidget.id
                            ? {
                                backgroundColor: 'var(--status-focus-bg)',
                                borderColor: 'var(--status-focus)',
                                color: 'var(--status-focus)',
                              }
                            : {
                                backgroundColor: 'var(--bg-elevated)',
                                borderColor: 'var(--border-hairline)',
                                color: 'var(--text-ink)',
                              }
                        }
                      >
                        {capturingHotkeyWidgetId === selectedWidget.id
                          ? t('simInsp.params.btnPressKey')
                          : t('simInsp.params.btnAssignKey')}
                      </button>

                      {selectedWidget.config.hotkey && (
                        <button
                          type="button"
                          title={t('simInsp.params.btnClearHotkeyTitle')}
                          onClick={() => {
                            setCapturingHotkeyWidgetId(null);
                            onUpdateWidget(selectedWidget.id, (w) => ({
                              ...w,
                              config: {
                                ...w.config,
                                hotkey: undefined,
                              },
                            }));
                          }}
                          className="inline-flex h-6 cursor-pointer items-center gap-0.5 rounded-[2px] border border-hairline bg-canvas px-1.5 text-[9px] text-muted hover:border-strong hover:text-critical"
                        >
                          <X className="h-2.5 w-2.5" />
                          {t('simInsp.params.btnClearHotkeyBtn')}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Guarded Switch Cover (requireConfirm + confirmPrompt) */}
                <div className="space-y-1.5 rounded-[2px] border border-hairline bg-surface p-2">
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-[10px] font-medium text-ink">
                    <input
                      type="checkbox"
                      disabled={!canMutate}
                      checked={selectedWidget.config.requireConfirm === true}
                      onChange={(e) =>
                        onUpdateWidget(selectedWidget.id, (w) => ({
                          ...w,
                          config: {
                            ...w.config,
                            requireConfirm: e.target.checked,
                          },
                        }))
                      }
                    />
                    <ShieldAlert className="h-3 w-3 shrink-0 text-warn" />
                    <span>{t('simInsp.params.btnGuardedSwitch')}</span>
                  </label>

                  {selectedWidget.config.requireConfirm === true && (
                    <label className="block space-y-0.5">
                      <span className="text-[9px] text-subtle">
                        {t('simInsp.params.btnConfirmPromptLabel')}
                      </span>
                      <input
                        type="text"
                        disabled={!canMutate}
                        maxLength={120}
                        placeholder={t('simInsp.params.btnConfirmPromptPlaceholder')}
                        value={selectedWidget.config.confirmPrompt ?? ''}
                        onChange={(e) =>
                          onUpdateWidget(selectedWidget.id, (w) => ({
                            ...w,
                            config: {
                              ...w.config,
                              confirmPrompt: e.target.value,
                            },
                          }))
                        }
                        className="h-6 w-full rounded-[2px] border border-hairline bg-canvas px-1.5 text-ink"
                      />
                    </label>
                  )}
                </div>
              </div>
            )}

            {selectedWidget.kind === 'checkbox' && (
              <div className="space-y-1.5">
                <label className="block space-y-0.5">
                  <span className="text-[9px] text-subtle">
                    {t('simInsp.params.chkLabel')}
                  </span>
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
                      {t('simInsp.params.chkCheckedVal')}
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
                      {t('simInsp.params.chkUncheckedVal')}
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
                      {t('simInsp.params.cmbPopulateDbc')}
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
                  <span className="text-[9px] text-subtle">
                    {t('simInsp.params.sldStep')}
                  </span>
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
                  {t('simInsp.params.sldShowNumeric')}
                </label>
              </div>
            )}


            {selectedWidget.kind === 'textbox' &&
              (() => {
                const cfg = selectedWidget.config;
                const mode = cfg.textMode ?? 'display';
                const format = cfg.textFormat ?? 'decimal';
                const bytesSource = textboxSource === 'bytes';
                const isInputMode = mode !== 'display';
                const formatsFor = (m: SimulationTextMode): SimulationTextFormat[] =>
                  m === 'display'
                    ? ['decimal', 'hex', 'ascii', 'enum']
                    : bytesSource
                      ? ['decimal', 'hex', 'ascii']
                      : ['decimal', 'hex'];
                const patchCfg = (p: Partial<SimulationWidgetConfigDto>) =>
                  onUpdateWidget(selectedWidget.id, (w) => ({
                    ...w,
                    config: { ...w.config, ...p },
                  }));
                const numInput = (
                  label: string,
                  value: number | undefined,
                  onChange: (n: number) => void,
                  min?: number
                ) => (
                  <label className="block space-y-0.5">
                    <span className="text-[9px] text-subtle">{label}</span>
                    <input
                      type="number"
                      disabled={!canMutate}
                      min={min}
                      step={1}
                      value={value ?? 0}
                      onChange={(e) => {
                        const n = Math.floor(Number(e.target.value));
                        if (Number.isFinite(n)) onChange(n);
                      }}
                      className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                    />
                  </label>
                );
                return (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-1.5">
                      <label className="space-y-0.5">
                        <span className="block text-[9px] text-subtle">{t('simInsp.textbox.mode')}</span>
                        <select
                          disabled={!canMutate}
                          value={mode}
                          onChange={(e) => {
                            const nextMode = e.target.value as SimulationTextMode;
                            const allowed = formatsFor(nextMode);
                            patchCfg({
                              textMode: nextMode,
                              textFormat: allowed.includes(format) ? format : 'decimal',
                            });
                          }}
                          className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1 text-ink"
                        >
                          {(['display', 'input', 'readwrite'] as const).map((m) => (
                            <option key={m} value={m}>
                              {t(`textbox.mode.${m}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="space-y-0.5">
                        <span className="block text-[9px] text-subtle">{t('simInsp.textbox.format')}</span>
                        <select
                          disabled={!canMutate}
                          value={format}
                          onChange={(e) =>
                            patchCfg({ textFormat: e.target.value as SimulationTextFormat })
                          }
                          className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1 text-ink"
                        >
                          {formatsFor(mode).map((f) => (
                            <option key={f} value={f}>
                              {t(`textbox.fmt.${f}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <p className="text-[9px] text-subtle">
                      {bytesSource ? t('simInsp.textbox.udsComboHint') : t('simInsp.textbox.comboHint')}
                    </p>

                    {!bytesSource && format === 'ascii' && (
                      <div className="grid grid-cols-2 gap-1.5">
                        {numInput(t('simInsp.textbox.byteOffset'), cfg.textByteOffset, (n) =>
                          patchCfg({ textByteOffset: Math.max(0, n) }), 0)}
                        {numInput(t('simInsp.textbox.byteLength'), cfg.textByteLength, (n) =>
                          patchCfg({ textByteLength: Math.max(0, n) }), 0)}
                      </div>
                    )}
                    {bytesSource && (format === 'ascii' || format === 'hex') &&
                      numInput(t('simInsp.textbox.udsByteLen'), cfg.textByteLen, (n) =>
                        patchCfg({ textByteLen: Math.max(0, Math.min(255, n)) }), 0)}

                    {format === 'enum' && (
                      <label className="block space-y-0.5">
                        <span className="text-[9px] text-subtle">{t('simInsp.textbox.enumMap')}</span>
                        <textarea
                          disabled={!canMutate}
                          rows={4}
                          value={Object.entries(cfg.enumMap ?? {})
                            .map(([k, v]) => `${k}=${v}`)
                            .join('\n')}
                          onChange={(e) => {
                            const map: Record<string, string> = {};
                            for (const line of e.target.value.split('\n')) {
                              const [k, ...rest] = line.split('=');
                              if (k && k.trim()) map[k.trim()] = rest.join('=').trim();
                            }
                            patchCfg({ enumMap: map });
                          }}
                          className="w-full resize-none rounded-[2px] border border-hairline bg-surface px-1.5 py-1 text-ink"
                        />
                      </label>
                    )}

                    {isInputMode && (
                      <>
                        <label className="block space-y-0.5">
                          <span className="text-[9px] text-subtle">{t('simInsp.textbox.placeholder')}</span>
                          <input
                            type="text"
                            disabled={!canMutate}
                            value={cfg.placeholder ?? ''}
                            onChange={(e) => patchCfg({ placeholder: e.target.value })}
                            className="h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink"
                          />
                        </label>
                        {bytesSource && (format === 'ascii' || format === 'hex') && (
                          <div className="grid grid-cols-3 gap-1.5">
                            {numInput(t('simInsp.textbox.maxLength'), cfg.maxLength, (n) =>
                              patchCfg({ maxLength: Math.max(0, n) }), 0)}
                            {numInput(t('simInsp.textbox.fixedLength'), cfg.fixedLength, (n) =>
                              patchCfg({ fixedLength: Math.max(0, n) }), 0)}
                            {numInput(t('simInsp.textbox.padByte'), cfg.padByte ?? 0, (n) =>
                              patchCfg({ padByte: Math.max(-1, Math.min(255, n)) }), -1)}
                          </div>
                        )}
                        <label className="flex cursor-pointer items-center gap-1.5 text-ink">
                          <input
                            type="checkbox"
                            disabled={!canMutate}
                            checked={cfg.sendOnEnter ?? true}
                            onChange={(e) => patchCfg({ sendOnEnter: e.target.checked })}
                          />
                          {t('simInsp.textbox.sendOnEnter')}
                        </label>
                        <label className="flex cursor-pointer items-center gap-1.5 text-ink">
                          <input
                            type="checkbox"
                            disabled={!canMutate}
                            checked={cfg.confirmBeforeSend ?? bytesSource}
                            onChange={(e) => patchCfg({ confirmBeforeSend: e.target.checked })}
                          />
                          {t('simInsp.textbox.confirm')}
                        </label>
                      </>
                    )}
                  </div>
                );
              })()}

            {showTxCycle &&
              (selectedWidget.kind === 'button' ||
              selectedWidget.kind === 'checkbox' ||
              selectedWidget.kind === 'combobox' ||
              selectedWidget.kind === 'slider') && (
              <div className="border-t border-hairline pt-2">
                <label className="block space-y-0.5">
                  <span className="text-[9px] text-subtle">
                    {t('simInsp.params.txCycleHint')}
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
                  {t('simInsp.params.txCycleExpl')}
                </p>
              </div>
            )}

            {selectedWidget.kind === 'group' && (
              <div className="space-y-3">
                <label className="block space-y-0.5">
                  <span className="text-[9px] text-subtle">
                    {t('simInsp.group.subtitle')}
                  </span>
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
                      {t('simInsp.group.containerTitle')}
                    </span>
                    <span className="rounded-[2px] border border-hairline bg-surface px-1.5 py-0.5 text-[9px] tabular-nums text-muted">
                      {t('simInsp.group.itemCount', {
                        count: groupChildren.length,
                      })}
                    </span>
                  </div>

                  {/* 1. Quick Add Control / Indicator into Group */}
                  <div className="space-y-1">
                    <span className="block text-[9px] uppercase text-subtle">
                      {t('simInsp.group.quickAddTitle')}
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
                          {t(opt.labelKey)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 2. Move Existing Outside Widget into This Group */}
                  {outsideGroupWidgets.length > 0 && (
                    <div className="space-y-1 border-t border-hairline pt-2">
                      <span className="block text-[9px] uppercase text-subtle">
                        {t('simInsp.group.moveExistingTitle')}
                      </span>
                      <div className="flex items-center gap-1">
                        <select
                          aria-label={t('simInsp.group.moveSelectAria')}
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
                          {t('simInsp.group.moveBtn')}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 3. Children Inside Group List */}
                  <div className="space-y-1 border-t border-hairline pt-2">
                    <span className="block text-[9px] uppercase tabular-nums text-subtle">
                      {t('simInsp.group.childrenTitle', {
                        count: groupChildren.length,
                      })}
                    </span>
                    {groupChildren.length === 0 ? (
                      <div className="rounded-[2px] border border-hairline bg-surface px-2 py-2 text-center text-[9px] text-muted">
                        {t('simInsp.group.emptyHint')}
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
                              {t('simInsp.group.editChildBtn')}
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
