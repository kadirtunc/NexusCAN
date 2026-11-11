import React, { useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  BoxSelect,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Compass,
  Database,
  Gauge,
  Hash,
  ListFilter,
  Plus,
  Search,
  SlidersHorizontal,
  Tag,
  TextCursorInput,
  ToggleLeft,
  UploadCloud,
} from 'lucide-react';
import { useI18n, type TranslationKey } from '../../i18n';
import type {
  DatabaseVersionDto,
  MessageSchemaDto,
  NetworkDatabaseSummaryDto,
  SignalSchemaDto,
  SimulationWidgetKind,
} from './contracts';
import {
  SIM_PALETTE_DRAG_MIME,
  formatDatabaseDisplayLabel,
  isLatitudeSignalName,
  makeCompositeMessageKey,
  type LoadedSimulationDatabaseEntry,
  type PaletteDragPayload,
  type SignalBoundContextInput,
} from './virtualCanPacking';

interface PaletteItemDef {
  kind: SimulationWidgetKind;
  labelKey: TranslationKey;
  code: string;
  group: 'DISPLAY' | 'STIMULUS' | 'LAYOUT';
  icon: React.ComponentType<{ className?: string }>;
}

const PALETTE_ITEMS: readonly PaletteItemDef[] = [
  { kind: 'gauge', labelKey: 'simPal.items.gauge.label', code: 'GAUGE', group: 'DISPLAY', icon: Gauge },
  { kind: 'bar', labelKey: 'simPal.items.bar.label', code: 'BAR', group: 'DISPLAY', icon: BarChart3 },
  { kind: 'numeric', labelKey: 'simPal.items.numeric.label', code: 'NUM', group: 'DISPLAY', icon: Hash },
  { kind: 'led', labelKey: 'simPal.items.led.label', code: 'LED', group: 'DISPLAY', icon: CircleDot },
  { kind: 'enum_badge', labelKey: 'simPal.items.enum_badge.label', code: 'ENUM', group: 'DISPLAY', icon: Tag },
  { kind: 'graph', labelKey: 'simPal.items.graph.label', code: 'PLOT', group: 'DISPLAY', icon: Activity },
  { kind: 'map', labelKey: 'simPal.items.map.label', code: 'MAP', group: 'DISPLAY', icon: Compass },
  { kind: 'button', labelKey: 'simPal.items.button.label', code: 'BTN', group: 'STIMULUS', icon: ToggleLeft },
  { kind: 'checkbox', labelKey: 'simPal.items.checkbox.label', code: 'CHK', group: 'STIMULUS', icon: CheckSquare },
  { kind: 'combobox', labelKey: 'simPal.items.combobox.label', code: 'CMB', group: 'STIMULUS', icon: ListFilter },
  { kind: 'slider', labelKey: 'simPal.items.slider.label', code: 'SLD', group: 'STIMULUS', icon: SlidersHorizontal },
  { kind: 'textbox', labelKey: 'simPal.items.textbox.label', code: 'TXT', group: 'STIMULUS', icon: TextCursorInput },
  { kind: 'group', labelKey: 'simPal.items.group.label', code: 'GRP', group: 'LAYOUT', icon: BoxSelect },
];

export interface SimulationPaletteSidebarProps {
  canMutate: boolean;
  /** DBC signal browser inputs (ignored when `signalSource` replaces the browser). */
  databases?: readonly NetworkDatabaseSummaryDto[];
  loadedDbEntries?: readonly LoadedSimulationDatabaseEntry[];
  versionsByDbId?: Readonly<Record<string, readonly DatabaseVersionDto[]>>;
  selectedDatabaseFilter?: string;
  selectedVersionByDbId?: Readonly<Record<string, string>>;
  loadingSchema?: boolean;
  hasSelectedBindableWidget?: boolean;
  targetGroupTitle?: string | null;
  onClearTargetGroup?: () => void;
  onSelectDatabaseFilter?: (filterValue: string) => void;
  onSelectDatabaseVersion?: (dbId: string, versionId: string) => void;
  onAddWidget: (
    kind: SimulationWidgetKind,
    boundContext?: SignalBoundContextInput | null
  ) => void;
  onBindSignalToSelected?: (ctx: SignalBoundContextInput) => void;
  onOpenUploadDbc?: () => void;
  /** Restrict the instrument list (e.g. UDS panels have no GNSS map). Default: all kinds. */
  widgetKinds?: readonly SimulationWidgetKind[];
  /** Replaces the Multi-DBC signal browser (lower half) with a custom data-source browser. */
  signalSource?: React.ReactNode;
}

interface GroupedTreeMessageItem {
  compositeKey: string;
  entry: LoadedSimulationDatabaseEntry;
  msg: MessageSchemaDto;
  signals: SignalSchemaDto[];
}

const NO_DATABASES: readonly NetworkDatabaseSummaryDto[] = [];
const NO_DB_ENTRIES: readonly LoadedSimulationDatabaseEntry[] = [];
const NO_VERSIONS: Readonly<Record<string, readonly DatabaseVersionDto[]>> = {};
const NO_SELECTED_VERSIONS: Readonly<Record<string, string>> = {};
const noop = (): void => undefined;

export function SimulationPaletteSidebar({
  canMutate,
  databases = NO_DATABASES,
  loadedDbEntries = NO_DB_ENTRIES,
  versionsByDbId = NO_VERSIONS,
  selectedDatabaseFilter = 'ALL',
  selectedVersionByDbId = NO_SELECTED_VERSIONS,
  loadingSchema = false,
  hasSelectedBindableWidget = false,
  targetGroupTitle,
  onClearTargetGroup,
  onSelectDatabaseFilter = noop,
  onSelectDatabaseVersion = noop,
  onAddWidget,
  onBindSignalToSelected = noop,
  onOpenUploadDbc = noop,
  widgetKinds,
  signalSource,
}: SimulationPaletteSidebarProps): React.JSX.Element {
  const { t } = useI18n();
  const [search, setSearch] = useState<string>('');
  const [expandedMsgKeys, setExpandedMsgKeys] = useState<Record<string, boolean>>({});
  const [activePair, setActivePair] = useState<SignalBoundContextInput | null>(
    null
  );
  const paletteItems = useMemo(
    () =>
      widgetKinds
        ? PALETTE_ITEMS.filter((i) => widgetKinds.includes(i.kind))
        : PALETTE_ITEMS,
    [widgetKinds]
  );

  const isAllSelected =
    selectedDatabaseFilter === 'ALL' || !selectedDatabaseFilter;

  const activeVersionsForSingleDb = useMemo<readonly DatabaseVersionDto[]>(() => {
    if (isAllSelected) return [];
    return versionsByDbId[selectedDatabaseFilter] ?? [];
  }, [isAllSelected, selectedDatabaseFilter, versionsByDbId]);

  const selectedVersionForSingleDb = isAllSelected
    ? ''
    : (selectedVersionByDbId[selectedDatabaseFilter] ?? '');

  const visibleEntries = useMemo(() => {
    if (isAllSelected) {
      return loadedDbEntries;
    }
    return loadedDbEntries.filter((e) => e.db.id === selectedDatabaseFilter);
  }, [isAllSelected, loadedDbEntries, selectedDatabaseFilter]);

  const groupedMessages = useMemo<GroupedTreeMessageItem[]>(() => {
    if (visibleEntries.length === 0) return [];
    const q = search.trim().toLowerCase();
    const out: GroupedTreeMessageItem[] = [];

    for (const entry of visibleEntries) {
      const sigsByMsg = new Map<string, SignalSchemaDto[]>();
      for (const s of entry.schema.signals) {
        const arr = sigsByMsg.get(s.messageKey) ?? [];
        arr.push(s);
        sigsByMsg.set(s.messageKey, arr);
      }

      const dbNameLower = entry.db.name.toLowerCase();
      for (const msg of entry.schema.messages) {
        const compositeKey = makeCompositeMessageKey(
          entry.db.id,
          msg.messageKey
        );
        const hex = `0x${msg.arbId.toString(16).toLowerCase()}`;
        const msgSigs = sigsByMsg.get(msg.messageKey) ?? [];

        if (!q) {
          out.push({ compositeKey, entry, msg, signals: msgSigs });
          continue;
        }

        const msgMatches =
          dbNameLower.includes(q) ||
          msg.name.toLowerCase().includes(q) ||
          msg.messageKey.toLowerCase().includes(q) ||
          hex.includes(q);
        const matchingSigs = msgMatches
          ? msgSigs
          : msgSigs.filter(
              (s) =>
                s.name.toLowerCase().includes(q) ||
                s.unit.toLowerCase().includes(q)
            );
        if (msgMatches || matchingSigs.length > 0) {
          out.push({ compositeKey, entry, msg, signals: matchingSigs });
        }
      }
    }

    return out;
  }, [search, visibleEntries]);

  const totalLoadedMessages = useMemo(
    () =>
      loadedDbEntries.reduce((acc, e) => acc + e.schema.messages.length, 0),
    [loadedDbEntries]
  );

  const toggleMsgExpanded = (compositeKey: string) => {
    setExpandedMsgKeys((prev) => ({
      ...prev,
      [compositeKey]: !(prev[compositeKey] ?? true),
    }));
  };

  const inferSmartKindForSignal = (sig: SignalSchemaDto): SimulationWidgetKind => {
    if (isLatitudeSignalName(sig.name)) return 'map';
    if (Object.keys(sig.enumTable).length > 0) return 'enum_badge';
    if (sig.bitLength === 1) return 'led';
    return 'gauge';
  };

  return (
    <aside
      aria-label={t('simPal.aria.palette')}
      className="flex w-full shrink-0 flex-col border-b border-hairline bg-surface lg:w-[280px] xl:w-[320px] lg:border-r lg:border-b-0"
    >
      {/* 1. Widget Palette */}
      <div className="border-b border-hairline">
        <div className="flex items-center justify-between border-b border-hairline bg-elevated px-3 py-2">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-ink">
            {t('simPal.header.instrumentPalette', { count: paletteItems.length })}
          </span>
          {activePair && (
            <span
              title={
                activePair.db
                  ? `[${activePair.db.name}] ${activePair.sig.name}`
                  : activePair.sig.name
              }
              className="max-w-[130px] truncate rounded-[2px] border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-focus"
            >
              {activePair.db
                ? `[${activePair.db.name}] ${activePair.sig.name}`
                : activePair.sig.name}
            </span>
          )}
        </div>

        {targetGroupTitle && (
          <div
            className="flex items-center justify-between gap-1.5 border-b border-hairline bg-canvas px-2.5 py-1.5 font-mono text-[11px]"
            style={{ borderLeft: '2px solid var(--status-focus)' }}
          >
            <span
              className="min-w-0 truncate font-semibold uppercase tracking-wider text-focus"
              title={t('simPal.targetGroup.title', { title: targetGroupTitle })}
            >
              {t('simPal.targetGroup.label')} <span className="text-ink">{targetGroupTitle}</span>
            </span>
            {onClearTargetGroup && (
              <button
                type="button"
                onClick={onClearTargetGroup}
                title={t('simPal.targetGroup.clearTitle')}
                className="shrink-0 cursor-pointer rounded-[2px] border border-hairline bg-elevated px-2 py-0.5 font-mono text-[10px] font-semibold uppercase text-muted hover:border-strong hover:text-ink"
              >
                {t('simPal.targetGroup.clearButton')}
              </button>
            )}
          </div>
        )}

        <div className="space-y-2.5 p-2.5">
          {(['DISPLAY', 'STIMULUS', 'LAYOUT'] as const).map((grp) => {
            const grpItems = paletteItems.filter((i) => i.group === grp);
            const grpTitle =
              grp === 'DISPLAY'
                ? t('simPal.group.display')
                : grp === 'STIMULUS'
                  ? t('simPal.group.stimulus')
                  : t('simPal.group.layout');

            return (
              <div key={grp} className="space-y-1">
                <div className="font-mono text-[10px] font-semibold uppercase tracking-wider text-subtle">
                  {grpTitle}
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {grpItems.map((item) => {
                    const Icon = item.icon;
                    const itemLabel = t(item.labelKey);
                    return (
                      <button
                        key={item.kind}
                        type="button"
                        disabled={!canMutate}
                        draggable={canMutate}
                        onDragStart={(e) => {
                          if (!canMutate) return;
                          const payload: PaletteDragPayload = {
                            kind: item.kind,
                            boundContext:
                              item.kind === 'group' ? null : activePair,
                          };
                          e.dataTransfer.setData(
                            SIM_PALETTE_DRAG_MIME,
                            JSON.stringify(payload)
                          );
                          e.dataTransfer.effectAllowed = 'copy';
                        }}
                        onClick={() => onAddWidget(item.kind, activePair)}
                        title={
                          targetGroupTitle && item.kind !== 'group'
                            ? t('simPal.item.addToGroupTooltip', {
                                label: itemLabel,
                                group: targetGroupTitle,
                              })
                            : t('simPal.item.addTooltip', { label: itemLabel })
                        }
                        className="flex h-[30px] cursor-pointer items-center justify-between gap-1.5 rounded-[2px] border border-hairline bg-canvas px-2.5 text-left transition-colors hover:border-strong hover:bg-elevated focus-visible:outline-1 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <Icon className="h-3.5 w-3.5 shrink-0 text-focus" aria-hidden="true" />
                          <span className="truncate text-[11.5px] font-medium text-ink">
                            {item.code}
                          </span>
                        </span>
                        <Plus className="h-3 w-3 shrink-0 text-muted" aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Multi-DBC / KCD Signal Browser (or a custom data-source browser) */}
      {signalSource ? (
        <div className="flex min-h-0 flex-1 flex-col">{signalSource}</div>
      ) : (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-hairline bg-elevated px-3 py-2">
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider tabular-nums text-ink">
            <Database className="h-3.5 w-3.5 text-nominal" aria-hidden="true" />
            {t('simPal.header.signals', { count: databases.length })}
          </span>
          <button
            type="button"
            onClick={onOpenUploadDbc}
            className="inline-flex h-[24px] cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-canvas px-2 font-mono text-[10px] font-semibold uppercase text-focus hover:border-strong"
          >
            <UploadCloud className="h-3 w-3" aria-hidden="true" />
            {t('simPal.header.upload')}
          </button>
        </div>

        <div className="space-y-2 border-b border-hairline p-2.5">
          <div
            className={
              isAllSelected ? 'grid grid-cols-1 gap-1' : 'grid grid-cols-3 gap-1'
            }
          >
            <select
              aria-label={t('simPal.dbFilter.aria')}
              value={isAllSelected ? 'ALL' : selectedDatabaseFilter}
              disabled={databases.length === 0}
              onChange={(e) => onSelectDatabaseFilter(e.target.value)}
              className={`${
                isAllSelected ? 'col-span-1' : 'col-span-2'
              } h-[30px] w-full rounded-[2px] border border-hairline bg-canvas px-2 font-mono text-[11px] tabular-nums text-ink disabled:opacity-60`}
            >
              {databases.length === 0 ? (
                <option value="ALL">{t('simPal.dbFilter.noDbc')}</option>
              ) : (
                <>
                  <option value="ALL">
                    {t('simPal.dbFilter.allDbs', { count: databases.length })}
                  </option>
                  {databases.map((db) => (
                    <option key={db.id} value={db.id}>
                      {formatDatabaseDisplayLabel(db)}
                    </option>
                  ))}
                </>
              )}
            </select>

            {!isAllSelected && (
              <select
                aria-label={t('simPal.dbVersion.aria')}
                value={selectedVersionForSingleDb}
                disabled={activeVersionsForSingleDb.length === 0}
                onChange={(e) =>
                  onSelectDatabaseVersion(selectedDatabaseFilter, e.target.value)
                }
                className="h-[30px] rounded-[2px] border border-hairline bg-canvas px-1.5 font-mono text-[11px] tabular-nums text-ink disabled:opacity-60"
              >
                {activeVersionsForSingleDb.length === 0 ? (
                  <option value="">—</option>
                ) : (
                  activeVersionsForSingleDb.map((ver) => (
                    <option key={ver.id} value={ver.id}>
                      {ver.versionLabel}
                    </option>
                  ))
                )}
              </select>
            )}
          </div>

          <div className="relative">
            <Search
              className="pointer-events-none absolute top-2.5 left-2 h-3.5 w-3.5 text-subtle"
              aria-hidden="true"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('simPal.search.placeholder')}
              aria-label={t('simPal.search.aria')}
              className="h-[30px] w-full rounded-[2px] border border-hairline bg-canvas pr-2.5 pl-7 font-mono text-[11.5px] text-ink placeholder:text-subtle"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loadingSchema && loadedDbEntries.length === 0 ? (
            <div className="py-6 text-center font-mono text-[11px] text-muted">
              {t('simPal.status.loadingSchemas')}
            </div>
          ) : databases.length === 0 || totalLoadedMessages === 0 ? (
            <div className="space-y-2 rounded-[2px] border border-hairline bg-canvas p-3 text-center font-mono text-[11px] text-muted">
              <p>{t('simPal.status.noDbcLoaded')}</p>
              <p className="text-[10px] text-subtle">
                {t('simPal.status.noDbcHint')}
              </p>
            </div>
          ) : groupedMessages.length === 0 ? (
            <div className="py-6 text-center font-mono text-[11px] text-muted">
              {t('simPal.status.noMatchingSignal')}
            </div>
          ) : (
            <div className="space-y-1">
              {groupedMessages.map(({ compositeKey, entry, msg, signals }) => {
                const isExpanded =
                  search.trim().length > 0 ||
                  (expandedMsgKeys[compositeKey] ?? true);
                const hexId = `0x${msg.arbId.toString(16).toUpperCase()}`;

                return (
                  <div
                    key={compositeKey}
                    className="rounded-[2px] border border-hairline bg-canvas"
                  >
                    <button
                      type="button"
                      onClick={() => toggleMsgExpanded(compositeKey)}
                      title={`[${entry.db.name}] ${hexId} ${msg.name} (CAN${entry.inferredBusId}, DLC ${msg.dlc})`}
                      className="flex w-full cursor-pointer items-center justify-between gap-1.5 px-2 py-2 text-left font-mono text-[11.5px] hover:bg-elevated"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />
                        )}
                        {isAllSelected && (
                          <span className="max-w-[85px] shrink-0 truncate rounded-[1px] border border-hairline bg-elevated px-1 text-[9.5px] font-semibold text-muted">
                            [{entry.db.name}]
                          </span>
                        )}
                        <span className="shrink-0 font-bold tabular-nums text-focus">
                          {hexId}
                        </span>
                        <span className="truncate font-semibold text-ink">
                          {msg.name}
                        </span>
                      </span>
                      <span className="shrink-0 tabular-nums text-subtle text-[11px]">
                        [C{entry.inferredBusId}·{msg.dlc}]
                      </span>
                    </button>

                    {isExpanded && signals.length > 0 && (
                      <div className="divide-y divide-hairline border-t border-hairline">
                        {signals.map((sig) => {
                          const sigCtx: SignalBoundContextInput = {
                            msg,
                            sig,
                            db: entry.db,
                            busId: entry.inferredBusId,
                          };
                          const isCurrent =
                            activePair?.db?.id === entry.db.id &&
                            activePair.msg.messageKey === msg.messageKey &&
                            activePair.sig.name === sig.name;

                          return (
                            <div
                              key={`${compositeKey}-${sig.signalId}-${sig.name}`}
                              draggable={canMutate}
                              onDragStart={(e) => {
                                if (!canMutate) return;
                                const payload: PaletteDragPayload = {
                                  kind: inferSmartKindForSignal(sig),
                                  boundContext: sigCtx,
                                };
                                e.dataTransfer.setData(
                                  SIM_PALETTE_DRAG_MIME,
                                  JSON.stringify(payload)
                                );
                                e.dataTransfer.effectAllowed = 'copy';
                              }}
                              onClick={() => setActivePair(sigCtx)}
                              title={
                                canMutate
                                  ? t('simPal.signal.dragTitle', {
                                      db: entry.db.name,
                                      sig: sig.name,
                                    })
                                  : `[${entry.db.name}] ${sig.name}`
                              }
                              className={`flex items-center justify-between gap-1.5 px-2.5 py-1.5 font-mono text-[11.5px] tabular-nums transition-colors ${
                                canMutate ? 'cursor-grab' : ''
                              } ${
                                isCurrent ? 'bg-elevated' : 'hover:bg-surface'
                              }`}
                            >
                              <div className="min-w-0">
                                <div className="truncate font-medium text-ink">
                                  {sig.name}
                                </div>
                                <div className="truncate text-[10px] text-subtle">
                                  {sig.startBit}|{sig.bitLength}{' '}
                                  {sig.unit ? `[${sig.unit}]` : ''}
                                </div>
                              </div>

                              {canMutate && (
                                <div className="flex shrink-0 items-center gap-1.5">
                                  {hasSelectedBindableWidget && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onBindSignalToSelected(sigCtx);
                                      }}
                                      className="h-[22px] cursor-pointer rounded-[2px] border border-hairline bg-surface px-2 text-[10px] font-semibold text-focus hover:border-strong"
                                      title={t('simPal.signal.bindTooltip', {
                                        db: entry.db.name,
                                        sig: sig.name,
                                      })}
                                    >
                                      {t('simPal.signal.bindBtn')}
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onAddWidget(
                                        inferSmartKindForSignal(sig),
                                        sigCtx
                                      );
                                    }}
                                    className="h-[22px] cursor-pointer rounded-[2px] border border-hairline bg-surface px-2 text-[10px] font-semibold text-ink hover:border-strong"
                                    title={t('simPal.signal.addTooltip', {
                                      db: entry.db.name,
                                      sig: sig.name,
                                    })}
                                  >
                                    {t('simPal.signal.addBtn')}
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      )}
    </aside>
  );
}
