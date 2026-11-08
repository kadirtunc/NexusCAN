
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
  ToggleLeft,
  UploadCloud,
} from 'lucide-react';
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
  label: string;
  code: string;
  group: 'DISPLAY' | 'STIMULUS' | 'LAYOUT';
  icon: React.ComponentType<{ className?: string }>;
}

const PALETTE_ITEMS: readonly PaletteItemDef[] = [
  { kind: 'gauge', label: '240° Dial Gauge', code: 'GAUGE', group: 'DISPLAY', icon: Gauge },
  { kind: 'bar', label: 'Level Meter', code: 'BAR', group: 'DISPLAY', icon: BarChart3 },
  { kind: 'numeric', label: 'Digital Readout', code: 'NUM', group: 'DISPLAY', icon: Hash },
  { kind: 'led', label: 'Status Lamp', code: 'LED', group: 'DISPLAY', icon: CircleDot },
  { kind: 'enum_badge', label: 'Symbolic State', code: 'ENUM', group: 'DISPLAY', icon: Tag },
  { kind: 'graph', label: '60 FPS Oscilloscope', code: 'PLOT', group: 'DISPLAY', icon: Activity },
  { kind: 'map', label: 'OpenStreetMap / GNSS', code: 'MAP', group: 'DISPLAY', icon: Compass },
  { kind: 'button', label: 'Push / Latch Button', code: 'BTN', group: 'STIMULUS', icon: ToggleLeft },
  { kind: 'checkbox', label: 'Toggle Switch', code: 'CHK', group: 'STIMULUS', icon: CheckSquare },
  { kind: 'combobox', label: 'Enum ComboBox', code: 'CMB', group: 'STIMULUS', icon: ListFilter },
  { kind: 'slider', label: 'Range Fader', code: 'SLD', group: 'STIMULUS', icon: SlidersHorizontal },
  { kind: 'group', label: 'Subsystem Frame', code: 'GRP', group: 'LAYOUT', icon: BoxSelect },
];

export interface SimulationPaletteSidebarProps {
  canMutate: boolean;
  databases: readonly NetworkDatabaseSummaryDto[];
  loadedDbEntries: readonly LoadedSimulationDatabaseEntry[];
  versionsByDbId: Readonly<Record<string, readonly DatabaseVersionDto[]>>;
  selectedDatabaseFilter: string;
  selectedVersionByDbId: Readonly<Record<string, string>>;
  loadingSchema: boolean;
  hasSelectedBindableWidget: boolean;
  targetGroupTitle?: string | null;
  onClearTargetGroup?: () => void;
  onSelectDatabaseFilter: (filterValue: string) => void;
  onSelectDatabaseVersion: (dbId: string, versionId: string) => void;
  onAddWidget: (
    kind: SimulationWidgetKind,
    boundContext?: SignalBoundContextInput | null
  ) => void;
  onBindSignalToSelected: (ctx: SignalBoundContextInput) => void;
  onOpenUploadDbc: () => void;
}

interface GroupedTreeMessageItem {
  compositeKey: string;
  entry: LoadedSimulationDatabaseEntry;
  msg: MessageSchemaDto;
  signals: SignalSchemaDto[];
}

export function SimulationPaletteSidebar({
  canMutate,
  databases,
  loadedDbEntries,
  versionsByDbId,
  selectedDatabaseFilter,
  selectedVersionByDbId,
  loadingSchema,
  hasSelectedBindableWidget,
  targetGroupTitle,
  onClearTargetGroup,
  onSelectDatabaseFilter,
  onSelectDatabaseVersion,
  onAddWidget,
  onBindSignalToSelected,
  onOpenUploadDbc,
}: SimulationPaletteSidebarProps): React.JSX.Element {
  const [search, setSearch] = useState<string>('');
  const [expandedMsgKeys, setExpandedMsgKeys] = useState<Record<string, boolean>>({});
  const [activePair, setActivePair] = useState<SignalBoundContextInput | null>(
    null
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
      aria-label="Widget Paleti ve Çoklu DBC Sinyal Gezgini"
      className="flex w-full shrink-0 flex-col border-b border-hairline bg-surface lg:w-[276px] lg:border-r lg:border-b-0"
    >
      {/* 1. Widget Palette */}
      <div className="border-b border-hairline">
        <div className="flex items-center justify-between border-b border-hairline bg-elevated px-3 py-2">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-ink">
            INSTRUMENT PALETTE ({PALETTE_ITEMS.length})
          </span>
          {activePair && (
            <span
              title={
                activePair.db
                  ? `[${activePair.db.name}] ${activePair.sig.name}`
                  : activePair.sig.name
              }
              className="max-w-[118px] truncate rounded-[2px] border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[9px] text-focus"
            >
              {activePair.db
                ? `[${activePair.db.name}] ${activePair.sig.name}`
                : activePair.sig.name}
            </span>
          )}
        </div>

        {targetGroupTitle && (
          <div
            className="flex items-center justify-between gap-1.5 border-b border-hairline bg-canvas px-2.5 py-1.5 font-mono text-[10px]"
            style={{ borderLeft: '2px solid var(--status-focus)' }}
          >
            <span
              className="min-w-0 truncate font-semibold uppercase tracking-wider text-focus"
              title={`HEDEF GRUP: ${targetGroupTitle}`}
            >
              HEDEF GRUP: <span className="text-ink">{targetGroupTitle}</span>
            </span>
            {onClearTargetGroup && (
              <button
                type="button"
                onClick={onClearTargetGroup}
                title="Hedef grubu temizle ve grup dışına (kök ızgaraya) ekle"
                className="shrink-0 cursor-pointer rounded-[2px] border border-hairline bg-elevated px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase text-muted hover:border-strong hover:text-ink"
              >
                × DIŞARI
              </button>
            )}
          </div>
        )}

        <div className="space-y-2.5 p-2.5">
          {(['DISPLAY', 'STIMULUS', 'LAYOUT'] as const).map((grp) => {
            const grpItems = PALETTE_ITEMS.filter((i) => i.group === grp);
            const grpTitle =
              grp === 'DISPLAY'
                ? 'INDICATORS, OSCILLOSCOPE & GNSS'
                : grp === 'STIMULUS'
                  ? 'VIRTUAL STIMULUS CONTROLS'
                  : 'STRUCTURAL FRAME';

            return (
              <div key={grp} className="space-y-1">
                <div className="font-mono text-[9px] font-semibold uppercase tracking-wider text-subtle">
                  {grpTitle}
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {grpItems.map((item) => {
                    const Icon = item.icon;
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
                            ? `${item.label} -> [${targetGroupTitle}] grubuna ekle (veya tuvale sürükle)`
                            : `${item.label} ekle (veya tuvale sürükle)`
                        }
                        className="flex h-7 cursor-pointer items-center justify-between gap-1 rounded-[2px] border border-hairline bg-canvas px-2 text-left transition-colors hover:border-strong hover:bg-elevated focus-visible:outline-1 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <Icon className="h-3 w-3 shrink-0 text-focus" aria-hidden="true" />
                          <span className="truncate text-[11px] font-medium text-ink">
                            {item.code}
                          </span>
                        </span>
                        <Plus className="h-2.5 w-2.5 shrink-0 text-muted" aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Multi-DBC / KCD Signal Browser */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-hairline bg-elevated px-3 py-2">
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider tabular-nums text-ink">
            <Database className="h-3 w-3 text-nominal" aria-hidden="true" />
            DBC / KCD SİNYALLERİ ({databases.length} DB)
          </span>
          <button
            type="button"
            onClick={onOpenUploadDbc}
            className="inline-flex h-5 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-canvas px-1.5 font-mono text-[9px] font-semibold uppercase text-focus hover:border-strong"
          >
            <UploadCloud className="h-2.5 w-2.5" aria-hidden="true" />
            UPLOAD
          </button>
        </div>

        <div className="space-y-1.5 border-b border-hairline p-2.5">
          <div
            className={
              isAllSelected ? 'grid grid-cols-1 gap-1' : 'grid grid-cols-3 gap-1'
            }
          >
            <select
              aria-label="Sinyal ağacı veritabanı filtresi"
              value={isAllSelected ? 'ALL' : selectedDatabaseFilter}
              disabled={databases.length === 0}
              onChange={(e) => onSelectDatabaseFilter(e.target.value)}
              className={`${
                isAllSelected ? 'col-span-1' : 'col-span-2'
              } h-7 w-full rounded-[2px] border border-hairline bg-canvas px-1.5 font-mono text-[10px] tabular-nums text-ink disabled:opacity-60`}
            >
              {databases.length === 0 ? (
                <option value="ALL">NO DBC / KCD UPLOADED</option>
              ) : (
                <>
                  <option value="ALL">
                    {`TÜM YÜKLÜ VERİTABANLARI (${databases.length})`}
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
                aria-label="Veritabanı sürümü seçin"
                value={selectedVersionForSingleDb}
                disabled={activeVersionsForSingleDb.length === 0}
                onChange={(e) =>
                  onSelectDatabaseVersion(selectedDatabaseFilter, e.target.value)
                }
                className="h-7 rounded-[2px] border border-hairline bg-canvas px-1 font-mono text-[10px] tabular-nums text-ink disabled:opacity-60"
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
              className="pointer-events-none absolute top-2 left-2 h-3 w-3 text-subtle"
              aria-hidden="true"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="DB adı, 0x101, mesaj veya sinyal ara..."
              aria-label="DBC sinyallerinde ara"
              className="h-7 w-full rounded-[2px] border border-hairline bg-canvas pr-2 pl-6 font-mono text-[11px] text-ink placeholder:text-subtle"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loadingSchema && loadedDbEntries.length === 0 ? (
            <div className="py-6 text-center font-mono text-[11px] text-muted">
              LOADING SCHEMAS...
            </div>
          ) : databases.length === 0 || totalLoadedMessages === 0 ? (
            <div className="space-y-2 rounded-[2px] border border-hairline bg-canvas p-3 text-center font-mono text-[11px] text-muted">
              <p>BU PROJEDE YÜKLÜ .DBC / .KCD ŞEMASI YOK.</p>
              <p className="text-[10px] text-subtle">
                Sağ denetçiden manuel sinyal bağlayabilir veya .dbc / .kcd dosyası yükleyebilirsiniz.
              </p>
            </div>
          ) : groupedMessages.length === 0 ? (
            <div className="py-6 text-center font-mono text-[11px] text-muted">
              EŞLEŞEN SİNYAL YOK.
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
                      className="flex w-full cursor-pointer items-center justify-between gap-1.5 px-2 py-1.5 text-left font-mono text-[10px] hover:bg-elevated"
                    >
                      <span className="flex min-w-0 items-center gap-1">
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3 shrink-0 text-muted" />
                        ) : (
                          <ChevronRight className="h-3 w-3 shrink-0 text-muted" />
                        )}
                        {isAllSelected && (
                          <span className="max-w-[78px] shrink-0 truncate rounded-[1px] border border-hairline bg-elevated px-1 text-[9px] font-semibold text-muted">
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
                      <span className="shrink-0 tabular-nums text-subtle">
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
                                  ? `[${entry.db.name}] ${sig.name} — tıklayarak seçin veya doğrudan tuvale/gruba sürükleyin`
                                  : `[${entry.db.name}] ${sig.name}`
                              }
                              className={`flex items-center justify-between gap-1.5 px-2 py-1 font-mono text-[10px] tabular-nums transition-colors ${
                                canMutate ? 'cursor-grab' : ''
                              } ${
                                isCurrent ? 'bg-elevated' : 'hover:bg-surface'
                              }`}
                            >
                              <div className="min-w-0">
                                <div className="truncate font-medium text-ink">
                                  {sig.name}
                                </div>
                                <div className="truncate text-[9px] text-subtle">
                                  {sig.startBit}|{sig.bitLength}{' '}
                                  {sig.unit ? `[${sig.unit}]` : ''}
                                </div>
                              </div>

                              {canMutate && (
                                <div className="flex shrink-0 items-center gap-1">
                                  {hasSelectedBindableWidget && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onBindSignalToSelected(sigCtx);
                                      }}
                                      className="cursor-pointer rounded-[2px] border border-hairline bg-surface px-1.5 py-0.5 text-[9px] font-semibold text-focus hover:border-strong"
                                      title={`Seçili widget'a [${entry.db.name}] ${sig.name} sinyalini bağla`}
                                    >
                                      BIND
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
                                    className="cursor-pointer rounded-[2px] border border-hairline bg-surface px-1.5 py-0.5 text-[9px] font-semibold text-ink hover:border-strong"
                                    title={`[${entry.db.name}] ${sig.name} için yeni widget ekle`}
                                  >
                                    +ADD
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
    </aside>
  );
}
