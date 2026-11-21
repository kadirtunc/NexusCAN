import React, { useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Compass,
  Copy,
  Database,
  Download,
  FolderGit2,
  Gauge,
  Layers,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  CloudProjectDto,
  NetworkDatabaseSummaryDto,
  SimulationPanelDto,
  SimulationWidgetKind,
} from './contracts';
import type { LoadedSimulationDatabaseEntry } from './virtualCanPacking';
import { useI18n } from '../../i18n';

const KIND_SHORT_CODE: Record<SimulationWidgetKind, string> = {
  gauge: 'GAUGE',
  bar: 'BAR',
  numeric: 'NUM',
  led: 'LED',
  enum_badge: 'ENUM',
  graph: 'GRAPH',
  map: 'MAP',
  button: 'BTN',
  checkbox: 'CHK',
  combobox: 'CMB',
  slider: 'SLD',
  textbox: 'TXT',
  group: 'GRP',
};

const KIND_ORDER: readonly SimulationWidgetKind[] = [
  'map',
  'graph',
  'gauge',
  'bar',
  'numeric',
  'led',
  'enum_badge',
  'slider',
  'button',
  'checkbox',
  'combobox',
  'group',
];

function formatTimestampTabular(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function summarizePanelWidgets(
  panel: SimulationPanelDto,
  kindOrder: readonly SimulationWidgetKind[]
): Array<{ kind: SimulationWidgetKind; code: string; count: number }> {
  const counts = new Map<SimulationWidgetKind, number>();
  for (const w of panel.widgets) {
    counts.set(w.kind, (counts.get(w.kind) ?? 0) + 1);
  }
  const out: Array<{ kind: SimulationWidgetKind; code: string; count: number }> =
    [];
  for (const kind of kindOrder) {
    const c = counts.get(kind) ?? 0;
    if (c > 0) {
      out.push({ kind, code: KIND_SHORT_CODE[kind], count: c });
    }
  }
  return out;
}

/** Optional pre-translated copy overrides (Diagnostic Simulation reuses this view with its own wording). */
export interface PanelListTexts {
  mainTitle?: string;
  mainDesc?: string;
  importLabel?: string;
  exportTitle?: string;
  emptyTitle?: string;
  emptyDesc?: string;
  duplicateTitle?: string;
}

/** Widget kind order of the component breakdown chips (default: Simulation order). */
export const DEFAULT_PANEL_KIND_ORDER = KIND_ORDER;

export interface SimulationPanelListViewProps<P extends SimulationPanelDto = SimulationPanelDto> {
  canMutate: boolean;
  allowProjectSwitch: boolean;
  projects: readonly CloudProjectDto[];
  resolvedProject: CloudProjectDto | null;
  panels: readonly P[];
  dirtyById: Readonly<Record<string, boolean>>;
  databases: readonly NetworkDatabaseSummaryDto[];
  loadedDbEntries: readonly LoadedSimulationDatabaseEntry[];
  loadingPanels: boolean;
  savingPanel: boolean;
  onSelectProjectSlug: (slug: string) => void;
  onEnterPanel: (panelId: string, mode: 'design' | 'run') => void;
  onOpenCreateModal: () => void;
  onOpenGenerateFromDbcModal: () => void;
  onNavigateToProject?: () => void;
  onSyncFromCloud?: () => void | Promise<void>;
  syncingFromCloud?: boolean;
  onTriggerImportJson: () => void;
  onExportPanelJson: (panel: P) => void;
  onRequestRenamePanel: (panel: P) => void;
  onRequestDeletePanel: (panel: P) => void;
  /** When given, every row gets a duplicate button (mutating users only). */
  onDuplicatePanel?: (panel: P) => void;
  /** Hide the signal-generator column / metric (panels without generators). Default: shown. */
  showGenerators?: boolean;
  /** Hide the DBC / project-sync chrome (badge, database metric). Default: shown. */
  showDatabases?: boolean;
  kindOrder?: readonly SimulationWidgetKind[];
  texts?: PanelListTexts;
  /** Extra header actions rendered before the primary actions. */
  extraActions?: ReactNode;
}

export function SimulationPanelListView<P extends SimulationPanelDto = SimulationPanelDto>({
  canMutate,
  allowProjectSwitch,
  projects,
  resolvedProject,
  panels,
  dirtyById,
  databases,
  loadedDbEntries,
  loadingPanels,
  savingPanel,
  onSelectProjectSlug,
  onEnterPanel,
  onOpenCreateModal,
  onOpenGenerateFromDbcModal,
  onNavigateToProject,
  onSyncFromCloud,
  syncingFromCloud = false,
  onTriggerImportJson,
  onExportPanelJson,
  onRequestRenamePanel,
  onRequestDeletePanel,
  onDuplicatePanel,
  showGenerators = true,
  showDatabases = true,
  kindOrder = KIND_ORDER,
  texts,
  extraActions,
}: SimulationPanelListViewProps<P>): React.JSX.Element {
  const { t } = useI18n();
  const [query, setQuery] = useState<string>('');

  const filteredPanels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return panels;
    return panels.filter((pan) => {
      if (
        pan.name.toLowerCase().includes(q) ||
        pan.description.toLowerCase().includes(q)
      ) {
        return true;
      }
      return pan.widgets.some(
        (w) =>
          w.title.toLowerCase().includes(q) ||
          w.kind.toLowerCase().includes(q) ||
          (w.binding?.signalName.toLowerCase().includes(q) ?? false) ||
          (w.binding?.databaseName?.toLowerCase().includes(q) ?? false) ||
          (w.config.lonBinding?.signalName.toLowerCase().includes(q) ?? false)
      );
    });
  }, [panels, query]);

  const dbTotals = useMemo(() => {
    const entryById = new Map<string, LoadedSimulationDatabaseEntry>();
    for (const entry of loadedDbEntries) {
      entryById.set(entry.db.id, entry);
    }
    let totalMessages = 0;
    let totalSignals = 0;
    for (const db of databases) {
      const loaded = entryById.get(db.id);
      totalMessages +=
        loaded?.schema.messages.length ?? db.latestVersion.messageCount;
      totalSignals +=
        loaded?.schema.signals.length ?? db.latestVersion.signalCount;
    }
    return { totalMessages, totalSignals };
  }, [databases, loadedDbEntries]);

  const metrics = useMemo(() => {
    let instruments = 0;
    let mapCount = 0;
    let activeGens = 0;
    let totalGens = 0;
    for (const pan of panels) {
      for (const w of pan.widgets) {
        if (w.kind !== 'group') {
          instruments += 1;
        }
        if (w.kind === 'map') {
          mapCount += 1;
        }
      }
      totalGens += pan.generators.length;
      activeGens += pan.generators.filter((g) => g.enabled).length;
    }
    return { instruments, mapCount, activeGens, totalGens };
  }, [panels]);

  return (
    <div className="min-h-[calc(100vh-2.75rem)] bg-canvas p-5 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        {/* 1. Top Directory Header & Actions */}
        <div className="flex flex-col justify-between gap-4 rounded-[2px] border border-hairline bg-surface p-5 lg:flex-row lg:items-center">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] tabular-nums">
              {resolvedProject && !allowProjectSwitch && (
                <button
                  type="button"
                  onClick={onNavigateToProject}
                  className="inline-flex h-6 items-center gap-1 rounded-[2px] border border-hairline bg-elevated px-2 font-semibold uppercase text-muted hover:border-strong hover:text-ink cursor-pointer"
                >
                  <ArrowLeft className="h-3 w-3" aria-hidden="true" />
                  {t('simWb.list.backToProject', { code: resolvedProject.code })}
                </button>
              )}

              {allowProjectSwitch && projects.length > 0 && resolvedProject && (
                <div className="inline-flex items-center gap-1.5">
                  <FolderGit2
                    className="h-3.5 w-3.5 text-focus"
                    aria-hidden="true"
                  />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                    {t('simWb.list.projectLabel')}
                  </span>
                  <select
                    aria-label={t('simWb.list.selectProjectAria')}
                    value={resolvedProject.slug}
                    onChange={(e) => onSelectProjectSlug(e.target.value)}
                    className="h-7 rounded-[2px] border border-strong bg-elevated px-2.5 font-mono text-[11px] font-semibold text-ink"
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.slug}>
                        {p.code} — {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {showDatabases && (
                <span className="rounded-[2px] border border-hairline bg-canvas px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted">
                  {t('simWb.list.syncedBadge')}
                </span>
              )}
            </div>

            <h1 className="font-mono text-base font-bold uppercase tracking-wider text-ink">
              {texts?.mainTitle ?? t('simWb.list.mainTitle')}
            </h1>
            <p className="max-w-2xl text-xs leading-relaxed text-muted">
              {texts?.mainDesc ?? t('simWb.list.mainDesc')}
            </p>
          </div>

          {/* Primary Directory Actions */}
          <div className="flex flex-wrap items-center gap-2">
            {extraActions}
            {onSyncFromCloud && (
              <button
                type="button"
                disabled={syncingFromCloud}
                onClick={() => void onSyncFromCloud()}
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-[11px] font-semibold uppercase text-ink hover:border-strong hover:bg-elevated disabled:opacity-50"
                title={t('simWb.list.cloudSyncTitle')}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 text-focus ${syncingFromCloud ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                {t('simWb.list.cloudSync')}
              </button>
            )}

            {canMutate && (
              <button
                type="button"
                disabled={savingPanel}
                onClick={onTriggerImportJson}
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-[11px] font-semibold uppercase text-ink hover:border-strong hover:bg-elevated disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
                {texts?.importLabel ?? t('simWb.list.importJson')}
              </button>
            )}

            {canMutate && databases.length > 0 && (
              <button
                type="button"
                disabled={savingPanel}
                onClick={onOpenGenerateFromDbcModal}
                data-tour="panels.from-dbc"
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[2px] border border-strong bg-elevated px-3 font-mono text-[11px] font-semibold uppercase text-ink hover:bg-hover disabled:opacity-50"
              >
                <Database
                  className="h-3.5 w-3.5 text-nominal"
                  aria-hidden="true"
                />
                {t('simWb.list.generateFromDbc')}
              </button>
            )}

            {canMutate && (
              <button
                type="button"
                disabled={savingPanel}
                onClick={onOpenCreateModal}
                data-tour="panels.new"
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[2px] px-3.5 font-mono text-[11px] font-semibold uppercase text-white disabled:opacity-50"
                style={{ backgroundColor: 'var(--status-focus)' }}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('simWb.list.newPanel')}
              </button>
            )}
          </div>
        </div>

        {/* 2. Summary Engineering Metrics Strip */}
        <div
          className={`grid grid-cols-2 gap-3 ${showGenerators && showDatabases ? 'lg:grid-cols-4' : 'lg:grid-cols-2'}`}
        >
          <div className="rounded-[2px] border border-hairline bg-surface px-4 py-3 font-mono tabular-nums">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted">
              <span>{t('simWb.list.metricRegistered')}</span>
              <Layers className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
            </div>
            <div className="mt-1 text-xl font-bold text-ink">
              {panels.length}
            </div>
            <div className="mt-0.5 text-[10px] text-subtle">
              {t('simWb.list.metricRegisteredSub')}
            </div>
          </div>

          <div className="rounded-[2px] border border-hairline bg-surface px-4 py-3 font-mono tabular-nums">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted">
              <span>{t('simWb.list.metricInstruments')}</span>
              <Gauge className="h-3.5 w-3.5 text-nominal" aria-hidden="true" />
            </div>
            <div className="mt-1 text-xl font-bold text-ink">
              {metrics.instruments}
            </div>
            <div className="mt-0.5 text-[10px] text-subtle">
              {metrics.mapCount > 0 ? (
                <span className="inline-flex items-center gap-1 text-focus">
                  <Compass className="h-2.5 w-2.5" aria-hidden="true" />
                  {t('simWb.list.metricInstrumentsSubWithMap', { count: metrics.mapCount })}
                </span>
              ) : (
                t('simWb.list.metricInstrumentsSubNoMap')
              )}
            </div>
          </div>

          {showGenerators && (
          <div className="rounded-[2px] border border-hairline bg-surface px-4 py-3 font-mono tabular-nums">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted">
              <span>{t('simWb.list.metricGenerators')}</span>
              <Activity className="h-3.5 w-3.5 text-warn" aria-hidden="true" />
            </div>
            <div className="mt-1 text-xl font-bold text-ink">
              {metrics.activeGens}
              <span className="text-sm font-normal text-muted">
                /{metrics.totalGens}
              </span>
            </div>
            <div className="mt-0.5 text-[10px] text-subtle">
              {t('simWb.list.metricGeneratorsSub')}
            </div>
          </div>
          )}

          {showDatabases && (
          <div className="rounded-[2px] border border-hairline bg-surface px-4 py-3 font-mono tabular-nums">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted">
              <span>{t('simWb.list.metricDatabases')}</span>
              <Database className="h-3.5 w-3.5 text-nominal" aria-hidden="true" />
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-1.5">
              <span className="text-xl font-bold text-ink">
                {databases.length}
              </span>
              <span className="text-xs font-semibold text-muted">
                .DBC / .KCD
              </span>
              {databases.length > 0 && (
                <span className="text-[10px] text-muted">
                  {t('simWb.list.metricDatabasesStats', { msgs: dbTotals.totalMessages, sigs: dbTotals.totalSignals })}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[10px] text-subtle">
              {t('simWb.list.metricDatabasesSub')}
            </div>
          </div>
          )}
        </div>

        {/* 3. Panel Directory Table / Empty State */}
        <div data-tour="panels.list" className="rounded-[2px] border border-hairline bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline bg-elevated px-4 py-2.5">
            <div className="flex items-center gap-2 font-mono text-[12px] font-semibold uppercase tracking-wider tabular-nums text-ink">
              <span>{t('simWb.list.tableHeader', { count: filteredPanels.length })}</span>
            </div>

            {panels.length > 0 && (
              <div className="relative w-full sm:w-80">
                <Search
                  className="pointer-events-none absolute top-2.5 left-2.5 h-3.5 w-3.5 text-subtle"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('simWb.list.searchPlaceholder')}
                  aria-label={t('simWb.list.searchAria')}
                  className="h-[30px] w-full rounded-[2px] border border-hairline bg-canvas pr-2.5 pl-8 font-mono text-[12px] text-ink placeholder:text-subtle"
                />
              </div>
            )}
          </div>

          {loadingPanels ? (
            <div className="px-6 py-14 text-center font-mono text-xs uppercase tracking-wider text-muted">
              {t('simWb.list.loading')}
            </div>
          ) : panels.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <Gauge
                className="mx-auto h-6 w-6 text-focus"
                aria-hidden="true"
              />
              <h2 className="mt-3 font-mono text-xs font-bold uppercase tracking-wider text-ink">
                {texts?.emptyTitle ?? t('simWb.list.emptyTitle')}
              </h2>
              <p className="mx-auto mt-2 max-w-lg text-xs leading-relaxed text-muted">
                {texts?.emptyDesc ?? t('simWb.list.emptyDesc')}
              </p>
              {canMutate && (
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    disabled={savingPanel}
                    onClick={onOpenCreateModal}
                    className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[2px] px-4 font-mono text-[11px] font-semibold uppercase text-white disabled:opacity-50"
                    style={{ backgroundColor: 'var(--status-focus)' }}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('simWb.list.emptyCreateBtn')}
                  </button>

                  {databases.length > 0 && (
                    <button
                      type="button"
                      disabled={savingPanel}
                      onClick={onOpenGenerateFromDbcModal}
                      className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[2px] border border-strong bg-elevated px-3.5 font-mono text-[11px] font-semibold uppercase text-ink hover:bg-hover disabled:opacity-50"
                    >
                      <Database
                        className="h-3.5 w-3.5 text-nominal"
                        aria-hidden="true"
                      />
                      {t('simWb.list.generateFromDbc')}
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={savingPanel}
                    onClick={onTriggerImportJson}
                    className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-[11px] uppercase text-muted hover:border-strong hover:text-ink"
                  >
                    <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                    {texts?.importLabel ?? t('simWb.list.importJson')}
                  </button>
                </div>
              )}
            </div>
          ) : filteredPanels.length === 0 ? (
            <div className="px-6 py-10 text-center font-mono text-xs text-muted">
              {t('simWb.list.noSearchResult')}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead className="border-b border-hairline bg-canvas font-mono text-[10px] uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">
                      {t('simWb.list.thName')}
                    </th>
                    <th className="px-4 py-2.5 font-semibold">
                      {t('simWb.list.thComponents')}
                    </th>
                    {showGenerators && (
                      <th className="px-4 py-2.5 font-semibold">
                        {t('simWb.list.thGenerators')}
                      </th>
                    )}
                    <th className="px-4 py-2.5 font-semibold">
                      {t('simWb.list.thUpdated')}
                    </th>
                    <th className="px-4 py-2.5 text-right font-semibold">
                      {t('simWb.list.thActions')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {filteredPanels.map((panel) => {
                    const summaryChips = summarizePanelWidgets(panel, kindOrder);
                    const nonGroupCount = panel.widgets.filter(
                      (w) => w.kind !== 'group'
                    ).length;
                    const enabledGenCount = panel.generators.filter(
                      (g) => g.enabled
                    ).length;
                    const isDirty = Boolean(dirtyById[panel.id]);

                    return (
                      <tr
                        key={panel.id}
                        tabIndex={0}
                        role="button"
                        aria-label={t('simWb.list.rowOpenAria', { name: panel.name })}
                        onClick={() => onEnterPanel(panel.id, 'design')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onEnterPanel(panel.id, 'design');
                          }
                        }}
                        className="group cursor-pointer transition-colors hover:bg-elevated/75 focus-visible:bg-elevated focus-visible:outline-1 focus-visible:outline-focus"
                      >
                        {/* 1. Panel Name & Description */}
                        <td className="px-4 py-3.5 align-middle">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-bold text-ink group-hover:text-focus">
                              {panel.name}
                            </span>
                            {isDirty && (
                              <span
                                className="rounded-[2px] border px-1 py-0.5 font-mono text-[9px] font-semibold uppercase"
                                style={{
                                  backgroundColor: 'var(--status-warn-bg)',
                                  borderColor: 'var(--status-warn-border)',
                                  color: 'var(--status-warn)',
                                }}
                              >
                                {t('simWb.list.badgeUnsaved')}
                              </span>
                            )}
                            <span className="rounded-[2px] border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-subtle">
                              {panel.gridCols}C×{panel.rowHeightPx}PX
                            </span>
                          </div>
                          <p className="mt-1 line-clamp-1 text-xs text-muted">
                            {panel.description || t('simWb.list.emptyDescRow')}
                          </p>
                        </td>

                        {/* 2. Widget Breakdown Badges */}
                        <td className="px-4 py-3.5 align-middle font-mono text-[10px] tabular-nums">
                          {panel.widgets.length === 0 ? (
                            <span className="text-subtle">{t('simWb.list.emptyPanelBadge')}</span>
                          ) : (
                            <div className="flex flex-wrap items-center gap-1">
                              <span className="rounded-[2px] border border-strong bg-elevated px-1.5 py-0.5 font-semibold text-ink">
                                {t('simWb.list.widgetCount', { count: nonGroupCount })}
                              </span>
                              {summaryChips.slice(0, 6).map((chip) => (
                                <span
                                  key={chip.kind}
                                  className={`rounded-[2px] border px-1.5 py-0.5 ${
                                    chip.kind === 'map'
                                      ? 'border-focus/60 bg-canvas font-semibold text-focus'
                                      : 'border-hairline bg-canvas text-muted'
                                  }`}
                                >
                                  {chip.count} {chip.code}
                                </span>
                              ))}
                              {summaryChips.length > 6 && (
                                <span className="text-subtle">
                                  +{summaryChips.length - 6}
                                </span>
                              )}
                            </div>
                          )}
                        </td>

                        {/* 3. Generators */}
                        {showGenerators && (
                        <td className="px-4 py-3.5 align-middle font-mono text-[10px] tabular-nums">
                          {panel.generators.length === 0 ? (
                            <span className="text-subtle">{t('simWb.list.noGen')}</span>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 font-semibold"
                              style={
                                enabledGenCount > 0
                                  ? {
                                      backgroundColor:
                                        'var(--status-nominal-bg)',
                                      borderColor:
                                        'var(--status-nominal-border)',
                                      color: 'var(--status-nominal)',
                                    }
                                  : {
                                      backgroundColor: 'var(--bg-canvas)',
                                      borderColor: 'var(--border-hairline)',
                                      color: 'var(--text-muted)',
                                    }
                              }
                            >
                              {t('simWb.list.genBadge', { enabled: enabledGenCount, total: panel.generators.length })}
                            </span>
                          )}
                        </td>
                        )}

                        {/* 4. Updated At */}
                        <td className="px-4 py-3.5 align-middle whitespace-nowrap font-mono text-[11px] tabular-nums text-muted">
                          {formatTimestampTabular(panel.updatedAt)}
                        </td>

                        {/* 5. Row Actions */}
                        <td
                          className="px-4 py-3.5 text-right align-middle whitespace-nowrap"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="inline-flex items-center justify-end gap-1.5 font-mono text-[11px] font-semibold uppercase">
                            <button
                              type="button"
                              onClick={() => onEnterPanel(panel.id, 'design')}
                              className="inline-flex h-[28px] cursor-pointer items-center gap-1 rounded-[2px] border border-strong bg-elevated px-3 text-ink hover:border-focus hover:text-focus"
                            >
                              <span>{t('simWb.list.btnOpenEdit')}</span>
                              <ArrowRight
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                            </button>

                            <button
                              type="button"
                              onClick={() => onEnterPanel(panel.id, 'run')}
                              className="inline-flex h-[28px] cursor-pointer items-center gap-1 rounded-[2px] border px-3 text-white"
                              style={{
                                backgroundColor: 'var(--status-nominal)',
                                borderColor: 'var(--status-nominal)',
                              }}
                              title={t('simWb.list.btnRunTitle')}
                            >
                              <Play className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>{t('simWb.list.btnRun')}</span>
                            </button>

                            {canMutate && (
                              <button
                                type="button"
                                onClick={() => onRequestRenamePanel(panel)}
                                title={t('simWb.list.renameTitle')}
                                aria-label={t('simWb.list.renameAria', { name: panel.name })}
                                className="inline-flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[2px] border border-hairline bg-canvas text-muted hover:border-strong hover:text-ink"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            )}

                            {canMutate && onDuplicatePanel && (
                              <button
                                type="button"
                                onClick={() => onDuplicatePanel(panel)}
                                title={texts?.duplicateTitle}
                                aria-label={texts?.duplicateTitle}
                                className="inline-flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[2px] border border-hairline bg-canvas text-muted hover:border-strong hover:text-ink"
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => onExportPanelJson(panel)}
                              title={texts?.exportTitle ?? t('simWb.list.exportTitle')}
                              aria-label={t('simWb.list.exportAria', { name: panel.name })}
                              className="inline-flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[2px] border border-hairline bg-canvas text-muted hover:border-strong hover:text-ink"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </button>

                            {canMutate && (
                              <button
                                type="button"
                                onClick={() => onRequestDeletePanel(panel)}
                                title={t('simWb.list.deleteTitle')}
                                aria-label={t('simWb.list.deleteAria', { name: panel.name })}
                                className="inline-flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[2px] border border-hairline bg-canvas text-muted hover:border-critical hover:text-critical"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
