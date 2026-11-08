import React, { useMemo, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Compass,
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
  panel: SimulationPanelDto
): Array<{ kind: SimulationWidgetKind; code: string; count: number }> {
  const counts = new Map<SimulationWidgetKind, number>();
  for (const w of panel.widgets) {
    counts.set(w.kind, (counts.get(w.kind) ?? 0) + 1);
  }
  const out: Array<{ kind: SimulationWidgetKind; code: string; count: number }> =
    [];
  for (const kind of KIND_ORDER) {
    const c = counts.get(kind) ?? 0;
    if (c > 0) {
      out.push({ kind, code: KIND_SHORT_CODE[kind], count: c });
    }
  }
  return out;
}

export interface SimulationPanelListViewProps {
  canMutate: boolean;
  allowProjectSwitch: boolean;
  projects: readonly CloudProjectDto[];
  resolvedProject: CloudProjectDto | null;
  panels: readonly SimulationPanelDto[];
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
  onExportPanelJson: (panel: SimulationPanelDto) => void;
  onRequestRenamePanel: (panel: SimulationPanelDto) => void;
  onRequestDeletePanel: (panel: SimulationPanelDto) => void;
}

export function SimulationPanelListView({
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
}: SimulationPanelListViewProps): React.JSX.Element {
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
                  {resolvedProject.code} PROJESİNE DÖN
                </button>
              )}

              {allowProjectSwitch && projects.length > 0 && resolvedProject && (
                <div className="inline-flex items-center gap-1.5">
                  <FolderGit2
                    className="h-3.5 w-3.5 text-focus"
                    aria-hidden="true"
                  />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                    PROJE:
                  </span>
                  <select
                    aria-label="Simülasyon projesi seçin"
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

              <span className="rounded-[2px] border border-hairline bg-canvas px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted">
                .NEXUSPROJ.JSON 1:1 SENKRON
              </span>
            </div>

            <h1 className="font-mono text-base font-bold uppercase tracking-wider text-ink">
              SİMÜLASYON &amp; SANAL ENSTRÜMAN PANELLERİ
            </h1>
            <p className="max-w-2xl text-xs leading-relaxed text-muted">
              Tasarlamak veya 60 FPS sanal/canlı telemetri modunda çalıştırmak istediğiniz panele tıklayın. Her panel içinde projedeki tüm .dbc / .kcd veritabanlarından dilediğiniz sinyalleri birlikte seçebilirsiniz.
            </p>
          </div>

          {/* Primary Directory Actions */}
          <div className="flex flex-wrap items-center gap-2">
            {onSyncFromCloud && (
              <button
                type="button"
                disabled={syncingFromCloud}
                onClick={() => void onSyncFromCloud()}
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-[11px] font-semibold uppercase text-ink hover:border-strong hover:bg-elevated disabled:opacity-50"
                title="Panelleri ve Projeyi Cloud'dan Eşitle"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 text-focus ${syncingFromCloud ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                CLOUD SYNC / YENİLE
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
                .NEXUSPANEL.JSON İÇE AKTAR
              </button>
            )}

            {canMutate && databases.length > 0 && (
              <button
                type="button"
                disabled={savingPanel}
                onClick={onOpenGenerateFromDbcModal}
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[2px] border border-strong bg-elevated px-3 font-mono text-[11px] font-semibold uppercase text-ink hover:bg-hover disabled:opacity-50"
              >
                <Database
                  className="h-3.5 w-3.5 text-nominal"
                  aria-hidden="true"
                />
                DBC&apos;DEN TASLAK OLUŞTUR...
              </button>
            )}

            {canMutate && (
              <button
                type="button"
                disabled={savingPanel}
                onClick={onOpenCreateModal}
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[2px] px-3.5 font-mono text-[11px] font-semibold uppercase text-white disabled:opacity-50"
                style={{ backgroundColor: 'var(--status-focus)' }}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                YENİ PANEL OLUŞTUR
              </button>
            )}
          </div>
        </div>

        {/* 2. Summary Engineering Metrics Strip */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-[2px] border border-hairline bg-surface px-4 py-3 font-mono tabular-nums">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted">
              <span>KAYITLI PANELLER</span>
              <Layers className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
            </div>
            <div className="mt-1 text-xl font-bold text-ink">
              {panels.length}
            </div>
            <div className="mt-0.5 text-[10px] text-subtle">
              24-SÜTUNLU ENDÜSTRİYEL IZGARA
            </div>
          </div>

          <div className="rounded-[2px] border border-hairline bg-surface px-4 py-3 font-mono tabular-nums">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted">
              <span>TOPLAM ENSTRÜMAN</span>
              <Gauge className="h-3.5 w-3.5 text-nominal" aria-hidden="true" />
            </div>
            <div className="mt-1 text-xl font-bold text-ink">
              {metrics.instruments}
            </div>
            <div className="mt-0.5 text-[10px] text-subtle">
              {metrics.mapCount > 0 ? (
                <span className="inline-flex items-center gap-1 text-focus">
                  <Compass className="h-2.5 w-2.5" aria-hidden="true" />
                  {metrics.mapCount} GNSS / OSM HARİTA DAHİL
                </span>
              ) : (
                'GAUGE · PLOT · MAP · STIMULUS'
              )}
            </div>
          </div>

          <div className="rounded-[2px] border border-hairline bg-surface px-4 py-3 font-mono tabular-nums">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted">
              <span>SİNYAL ÜRETEÇLERİ</span>
              <Activity className="h-3.5 w-3.5 text-warn" aria-hidden="true" />
            </div>
            <div className="mt-1 text-xl font-bold text-ink">
              {metrics.activeGens}
              <span className="text-sm font-normal text-muted">
                /{metrics.totalGens}
              </span>
            </div>
            <div className="mt-0.5 text-[10px] text-subtle">
              60HZ SANAL DALGA KAYNAĞI
            </div>
          </div>

          <div className="rounded-[2px] border border-hairline bg-surface px-4 py-3 font-mono tabular-nums">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted">
              <span>PROJEDEKİ VERİTABANLARI</span>
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
                  · {dbTotals.totalMessages} MESAJ · {dbTotals.totalSignals}{' '}
                  SİNYAL
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[10px] text-subtle">
              TÜM VERİTABANLARINDAN SİNYAL SEÇİLEBİLİR
            </div>
          </div>
        </div>

        {/* 3. Panel Directory Table / Empty State */}
        <div className="rounded-[2px] border border-hairline bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline bg-elevated px-4 py-2.5">
            <div className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-wider tabular-nums text-ink">
              <span>PROJE PANEL DİZİNİ ({filteredPanels.length})</span>
            </div>

            {panels.length > 0 && (
              <div className="relative w-full sm:w-72">
                <Search
                  className="pointer-events-none absolute top-2 left-2.5 h-3.5 w-3.5 text-subtle"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Panel adı, veritabanı veya sinyal filtrele..."
                  aria-label="Panellerde ara"
                  className="h-7 w-full rounded-[2px] border border-hairline bg-canvas pr-2.5 pl-8 font-mono text-[11px] text-ink placeholder:text-subtle"
                />
              </div>
            )}
          </div>

          {loadingPanels ? (
            <div className="px-6 py-14 text-center font-mono text-xs uppercase tracking-wider text-muted">
              SİMÜLASYON PANELLERİ YÜKLENİYOR...
            </div>
          ) : panels.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <Gauge
                className="mx-auto h-6 w-6 text-focus"
                aria-hidden="true"
              />
              <h2 className="mt-3 font-mono text-xs font-bold uppercase tracking-wider text-ink">
                BU PROJEDE HENÜZ SİMÜLASYON PANELİ YOK
              </h2>
              <p className="mx-auto mt-2 max-w-lg text-xs leading-relaxed text-muted">
                Yeni bir 24-sütunlu boş gösterge paneli oluşturun, yüklü{' '}
                <span className="font-mono text-ink">.dbc / .kcd</span>{' '}
                veritabanlarınızdan istediğiniz mesajları seçerek taslak panel
                oluşturun veya{' '}
                <span className="font-mono text-ink">.nexuspanel.json</span>{' '}
                dosyası içe aktarın.
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
                    + YENİ PANEL OLUŞTUR
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
                      DBC&apos;DEN TASLAK OLUŞTUR...
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={savingPanel}
                    onClick={onTriggerImportJson}
                    className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-[11px] uppercase text-muted hover:border-strong hover:text-ink"
                  >
                    <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                    .NEXUSPANEL.JSON İÇE AKTAR
                  </button>
                </div>
              )}
            </div>
          ) : filteredPanels.length === 0 ? (
            <div className="px-6 py-10 text-center font-mono text-xs text-muted">
              ARAMA KRİTERİYLE EŞLEŞEN PANEL BULUNAMADI.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead className="border-b border-hairline bg-canvas font-mono text-[10px] uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">
                      PANEL ADI &amp; AÇIKLAMA
                    </th>
                    <th className="px-4 py-2.5 font-semibold">
                      BİLEŞEN ÖZETİ
                    </th>
                    <th className="px-4 py-2.5 font-semibold">
                      SİNYAL ÜRETEÇLERİ (GEN)
                    </th>
                    <th className="px-4 py-2.5 font-semibold">
                      SON GÜNCELLEME
                    </th>
                    <th className="px-4 py-2.5 text-right font-semibold">
                      İŞLEMLER
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {filteredPanels.map((panel) => {
                    const summaryChips = summarizePanelWidgets(panel);
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
                        aria-label={`${panel.name} panelini aç`}
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
                                KAYDEDİLMEMİŞ *
                              </span>
                            )}
                            <span className="rounded-[2px] border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-subtle">
                              {panel.gridCols}C×{panel.rowHeightPx}PX
                            </span>
                          </div>
                          <p className="mt-1 line-clamp-1 text-xs text-muted">
                            {panel.description ||
                              'Açıklama girilmedi — 24-sütunlu sanal enstrüman ve simülasyon paneli'}
                          </p>
                        </td>

                        {/* 2. Widget Breakdown Badges */}
                        <td className="px-4 py-3.5 align-middle font-mono text-[10px] tabular-nums">
                          {panel.widgets.length === 0 ? (
                            <span className="text-subtle">BOŞ PANEL (0)</span>
                          ) : (
                            <div className="flex flex-wrap items-center gap-1">
                              <span className="rounded-[2px] border border-strong bg-elevated px-1.5 py-0.5 font-semibold text-ink">
                                {nonGroupCount} WIDGET
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
                        <td className="px-4 py-3.5 align-middle font-mono text-[10px] tabular-nums">
                          {panel.generators.length === 0 ? (
                            <span className="text-subtle">0 GEN</span>
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
                              {enabledGenCount}/{panel.generators.length} GEN
                            </span>
                          )}
                        </td>

                        {/* 4. Updated At */}
                        <td className="px-4 py-3.5 align-middle whitespace-nowrap font-mono text-[11px] tabular-nums text-muted">
                          {formatTimestampTabular(panel.updatedAt)}
                        </td>

                        {/* 5. Row Actions */}
                        <td
                          className="px-4 py-3.5 text-right align-middle whitespace-nowrap"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="inline-flex items-center justify-end gap-1.5 font-mono text-[10px] font-semibold uppercase">
                            <button
                              type="button"
                              onClick={() => onEnterPanel(panel.id, 'design')}
                              className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border border-strong bg-elevated px-2.5 text-ink hover:border-focus hover:text-focus"
                            >
                              <span>AÇ / DÜZENLE</span>
                              <ArrowRight
                                className="h-3 w-3"
                                aria-hidden="true"
                              />
                            </button>

                            <button
                              type="button"
                              onClick={() => onEnterPanel(panel.id, 'run')}
                              className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border px-2.5 text-white"
                              style={{
                                backgroundColor: 'var(--status-nominal)',
                                borderColor: 'var(--status-nominal)',
                              }}
                              title="Paneli doğrudan 60 FPS Çalıştırma (RUN) modunda aç"
                            >
                              <Play className="h-3 w-3" aria-hidden="true" />
                              <span>ÇALIŞTIR</span>
                            </button>

                            {canMutate && (
                              <button
                                type="button"
                                onClick={() => onRequestRenamePanel(panel)}
                                title="Paneli yeniden adlandır"
                                aria-label={`${panel.name} panelini yeniden adlandır`}
                                className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-[2px] border border-hairline bg-canvas text-muted hover:border-strong hover:text-ink"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => onExportPanelJson(panel)}
                              title=".nexuspanel.json olarak dışa aktar"
                              aria-label={`${panel.name} panelini dışa aktar`}
                              className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-[2px] border border-hairline bg-canvas text-muted hover:border-strong hover:text-ink"
                            >
                              <Download className="h-3 w-3" />
                            </button>

                            {canMutate && (
                              <button
                                type="button"
                                onClick={() => onRequestDeletePanel(panel)}
                                title="Paneli sil"
                                aria-label={`${panel.name} panelini sil`}
                                className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-[2px] border border-hairline bg-canvas text-muted hover:border-critical hover:text-critical"
                              >
                                <Trash2 className="h-3 w-3" />
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
