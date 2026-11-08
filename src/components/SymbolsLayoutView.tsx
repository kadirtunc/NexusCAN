import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Cable,
  Check,
  Cloud,
  Database,
  DownloadCloud,
  FileCode2,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  apiGetPresetDatabaseFiles,
  apiListDevices,
  apiParseDatabaseSchema,
} from '../services/ipcClient';
import { connectionStore, useConnectionStore } from '../store/connectionStore';
import {
  type ProjectDatabaseEntry,
  databaseStore,
  makeCatalogDbId,
  useDatabaseStore,
} from '../store/databaseStore';
import {
  type PullableCloudDatabaseItem,
  cloudBridgeStore,
  useCloudBridgeStore,
} from '../store/cloudBridgeStore';
import { useProjectStore } from '../store/projectStore';
import { fileToBase64 } from '../utils/formatters';
import { syncAllBusDatabasesWithBackend } from '../utils/busDatabaseSync';
import type { DeviceDescriptorDto } from '../types/hal';
import { BitLayoutMatrix } from './BitLayoutMatrix';
import { DatabaseExplorer } from './DatabaseExplorer';
import { NewConnectionModal } from './NewConnectionModal';

type FormatFilter = 'all' | 'dbc' | 'kcd';

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function buildCatalogEntry(
  fileName: string,
  contentBase64: string,
): Promise<ProjectDatabaseEntry> {
  const schema = await apiParseDatabaseSchema(fileName, contentBase64);
  return {
    id: makeCatalogDbId(fileName),
    name: fileName.replace(/\.[^/.]+$/, ''),
    fileName,
    format: fileName.toLowerCase().endsWith('.kcd') ? 'kcd' : 'dbc',
    contentBase64,
    sizeBytes: Math.round((contentBase64.length * 3) / 4),
    uploadedAt: new Date().toISOString(),
    schema,
  };
}

/**
 * Databases tab: a multi-file `.dbc` / `.kcd` catalog (Cloud `DatabasesView` parity).
 * There is NO global active database — each connection (Bus) binds 0..N catalog entries,
 * and clicking a row drills into that specific database's symbol tree & bit layout.
 */
export const SymbolsLayoutView: React.FC = () => {
  const dbState = useDatabaseStore();
  const connState = useConnectionStore();
  const cloudState = useCloudBridgeStore();
  const projState = useProjectStore();

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [mode, setMode] = useState<'list' | 'inspect'>('list');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [formatFilter, setFormatFilter] = useState<FormatFilter>('all');
  const [busy, setBusy] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [deletingDb, setDeletingDb] = useState<ProjectDatabaseEntry | null>(null);
  const [modalBindDb, setModalBindDb] = useState<ProjectDatabaseEntry | null>(null);

  // Cloud Pull Modal State
  const [cloudPullModalOpen, setCloudPullModalOpen] = useState<boolean>(false);
  const [selectedCloudProjId, setSelectedCloudProjId] = useState<string>('');
  const [pullableDatabases, setPullableDatabases] = useState<PullableCloudDatabaseItem[]>([]);
  const [selectedDbKeys, setSelectedDbKeys] = useState<Set<string>>(new Set());
  const [targetProfileIds, setTargetProfileIds] = useState<Set<string>>(new Set());
  const [loadingPullable, setLoadingPullable] = useState<boolean>(false);
  const [pullingBusy, setPullingBusy] = useState<boolean>(false);
  const [pullError, setPullError] = useState<string | null>(null);

  // Nested New Connection Modal State
  const [newConnModalOpen, setNewConnModalOpen] = useState<boolean>(false);
  const [devices, setDevices] = useState<readonly DeviceDescriptorDto[]>([]);

  const databases = dbState.databases;
  const profiles = connState.profiles;

  // Pre-resolve initial cloud project for pull modal
  useEffect(() => {
    if (!selectedCloudProjId && cloudState.projects.length > 0) {
      const preferred =
        projState.cloudBinding?.projectId ||
        cloudState.inspectedProjectId ||
        cloudState.selectedProjectId ||
        cloudState.projects[0].id;
      setSelectedCloudProjId(preferred);
    }
  }, [cloudState.projects, cloudState.inspectedProjectId, cloudState.selectedProjectId, projState.cloudBinding, selectedCloudProjId]);

  // Fetch pullable databases when modal opens or selected project changes
  const refreshPullableDatabases = async (projId: string): Promise<void> => {
    if (!projId || !cloudState.sessionToken) {
      setPullableDatabases([]);
      return;
    }
    setLoadingPullable(true);
    setPullError(null);
    try {
      const list = await cloudBridgeStore.listPullableCloudDatabases(projId);
      setPullableDatabases(list);
      // Default to selecting all databases
      setSelectedDbKeys(new Set(list.map((d) => d.key)));
    } catch (err) {
      setPullError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingPullable(false);
    }
  };

  useEffect(() => {
    if (cloudPullModalOpen && selectedCloudProjId) {
      void refreshPullableDatabases(selectedCloudProjId);
    }
  }, [cloudPullModalOpen, selectedCloudProjId]);

  const profilesByDbId = useMemo(() => {
    const map = new Map<string, typeof profiles>();
    for (const db of databases) {
      map.set(
        db.id,
        profiles.filter((p) => p.databaseIds.includes(db.id)).sort((a, b) => a.busId - b.busId),
      );
    }
    return map;
  }, [databases, profiles]);

  const kpi = useMemo(() => {
    let msgs = 0;
    let sigs = 0;
    let ecus = 0;
    for (const db of databases) {
      msgs += db.schema?.messages.length ?? 0;
      sigs += db.schema?.signals.length ?? 0;
      ecus += db.schema?.ecus.length ?? 0;
    }
    const boundBuses = profiles.filter((p) =>
      p.databaseIds.some((id) => databases.some((d) => d.id === id)),
    ).length;
    return { msgs, sigs, ecus, boundBuses };
  }, [databases, profiles]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return databases.filter((db) => {
      if (formatFilter !== 'all' && db.format !== formatFilter) return false;
      if (!q) return true;
      if (db.name.toLowerCase().includes(q) || db.fileName.toLowerCase().includes(q)) return true;
      if (!db.schema) return false;
      return db.schema.messages.some((m) => {
        const hex = `0x${m.arbId.toString(16).toLowerCase()}`;
        return hex.includes(q) || m.name.toLowerCase().includes(q);
      });
    });
  }, [databases, formatFilter, searchQuery]);

  const inspected = databases.find((d) => d.id === dbState.inspectedDatabaseId) ?? null;

  const handleUploadFiles = async (ev: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(ev.target.files ?? []);
    ev.target.value = '';
    if (files.length === 0) return;
    setBusy(true);
    setActionError(null);
    setActionInfo(null);
    const errors: string[] = [];
    let added = 0;
    for (const file of files) {
      try {
        const base64 = await fileToBase64(file);
        const entry = await buildCatalogEntry(file.name, base64);
        databaseStore.upsertDatabaseEntry(entry);
        added += 1;
      } catch (err) {
        errors.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (added > 0) {
      setActionInfo(
        `${added} veritabanı kataloğa eklendi. Çözümleme için "Bağlı Bağlantılar" sütunundan bir hatta bağlayın.`,
      );
    }
    if (errors.length > 0) setActionError(errors.join(' · '));
    setBusy(false);
  };

  const handleAddPresets = async (): Promise<void> => {
    setBusy(true);
    setActionError(null);
    setActionInfo(null);
    try {
      const files = await apiGetPresetDatabaseFiles();
      for (const f of files) {
        databaseStore.upsertDatabaseEntry(await buildCatalogEntry(f.fileName, f.contentBase64));
      }
      setActionInfo(
        `${files.length} örnek veritabanı kataloğa eklendi (${files.map((f) => f.fileName).join(', ')}).`,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleBinding = (dbId: string, profileId: string): void => {
    const prof = profiles.find((p) => p.id === profileId);
    if (!prof) return;
    const next = prof.databaseIds.includes(dbId)
      ? prof.databaseIds.filter((x) => x !== dbId)
      : [...prof.databaseIds, dbId];
    connectionStore.setProfileDatabases(profileId, next);
    void syncAllBusDatabasesWithBackend();
  };

  const confirmDelete = (): void => {
    if (!deletingDb) return;
    for (const p of profiles) {
      if (p.databaseIds.includes(deletingDb.id)) {
        connectionStore.setProfileDatabases(
          p.id,
          p.databaseIds.filter((x) => x !== deletingDb.id),
        );
      }
    }
    databaseStore.removeDatabaseEntry(deletingDb.id);
    void syncAllBusDatabasesWithBackend();
    if (dbState.inspectedDatabaseId === deletingDb.id) setMode('list');
    setDeletingDb(null);
  };

  const openInspector = (dbId: string): void => {
    databaseStore.setInspectedDatabaseId(dbId);
    setMode('inspect');
  };

  const handleOpenNewConnectionModal = async () => {
    try {
      const list = await apiListDevices();
      setDevices(list);
    } catch {
      setDevices([]);
    }
    setNewConnModalOpen(true);
  };

  const handleExecuteCloudPull = async () => {
    if (selectedDbKeys.size === 0) {
      setPullError('Lütfen indirilecek en az bir veritabanı seçin.');
      return;
    }
    if (!selectedCloudProjId) {
      setPullError('Lütfen bir bulut projesi seçin.');
      return;
    }

    setPullingBusy(true);
    setPullError(null);

    try {
      const toDownload = pullableDatabases.filter((d) => selectedDbKeys.has(d.key));
      const addedEntries: ProjectDatabaseEntry[] = [];

      for (const item of toDownload) {
        const dl = await cloudBridgeStore.downloadCloudDatabaseBase64(selectedCloudProjId, item);
        const entry = await buildCatalogEntry(dl.fileName, dl.contentBase64);
        databaseStore.upsertDatabaseEntry(entry);
        addedEntries.push(entry);
      }

      // Bind to all selected target profiles
      if (targetProfileIds.size > 0 && addedEntries.length > 0) {
        const addedIds = addedEntries.map((e) => e.id);
        for (const profId of targetProfileIds) {
          const prof = profiles.find((p) => p.id === profId);
          if (prof) {
            const merged = Array.from(new Set([...prof.databaseIds, ...addedIds]));
            connectionStore.setProfileDatabases(profId, merged);
          }
        }
      }

      await syncAllBusDatabasesWithBackend();

      const busCount = targetProfileIds.size;
      setActionInfo(
        `${addedEntries.length} veritabanı Cloud'dan çekildi${
          busCount > 0 ? ` ve ${busCount} Bus hattına bağlandı` : ''
        }.`,
      );
      setCloudPullModalOpen(false);
    } catch (err) {
      setPullError(err instanceof Error ? err.message : String(err));
    } finally {
      setPullingBusy(false);
    }
  };

  // ==========================================================================
  // LEVEL 2 — Symbol tree & bit matrix of ONE explicitly chosen database
  // ==========================================================================
  if (mode === 'inspect' && inspected) {
    return (
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden bg-canvas">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline bg-surface px-3 py-1.5">
          <button
            type="button"
            onClick={() => setMode('list')}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-elevated px-2.5 font-mono text-[11px] font-semibold uppercase text-ink hover:border-strong"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            VERİTABANI LİSTESİ
          </button>
          <select
            value={inspected.id}
            onChange={(e) => databaseStore.setInspectedDatabaseId(e.target.value)}
            aria-label="İncelenen veritabanı"
            className="h-7 max-w-[320px] rounded-[2px] border border-hairline bg-canvas px-2 font-mono text-[11px] text-ink"
          >
            {databases.map((d) => (
              <option key={d.id} value={d.id}>
                {d.fileName}
              </option>
            ))}
          </select>
          <span className="font-mono text-[10px] tabular-nums text-muted">
            {inspected.schema?.messages.length ?? 0} MSG · {inspected.schema?.signals.length ?? 0} SİNYAL ·{' '}
            {inspected.schema?.ecus.length ?? 0} ECU
          </span>

          {/* Interactive Bus Binding Controls on Level 2 */}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase text-muted mr-0.5">Bağlı Buslar:</span>
            {profiles.length === 0 ? (
              <span className="font-mono text-[10px] text-amber-400 border border-amber-800/60 px-1.5 py-0.5 rounded-[2px]">
                Kayıtlı Bus yok
              </span>
            ) : (
              profiles
                .slice()
                .sort((a, b) => a.busId - b.busId)
                .map((p) => {
                  const isBound = p.databaseIds.includes(inspected.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => toggleBinding(inspected.id, p.id)}
                      className={`inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border px-2 font-mono text-[10px] tabular-nums transition-colors ${
                        isBound
                          ? 'border-emerald-500/60 bg-emerald-950/50 text-emerald-300 font-semibold'
                          : 'border-hairline bg-canvas text-muted hover:text-ink hover:border-strong opacity-75 hover:opacity-100'
                      }`}
                      title={`${p.name} (${p.adapterChannel || p.deviceId}) · Tıkla ve ${isBound ? 'çöz' : 'bağla'}`}
                    >
                      <span>Bus {p.busId + 1}</span>
                      {isBound ? <Check className="h-3 w-3 text-emerald-400" /> : <Plus className="h-3 w-3 text-muted" />}
                    </button>
                  );
                })
            )}
            <button
              type="button"
              onClick={() => setModalBindDb(inspected)}
              className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-elevated px-2 font-mono text-[10px] text-focus hover:border-strong"
            >
              <Cable className="h-3 w-3" />
              <span>Bus Yönet…</span>
            </button>
          </div>
        </div>

        {inspected.schema ? (
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <div
              style={{ borderRight: '1px solid var(--border-strong)' }}
              className="w-[38%] min-w-[300px] h-full min-h-0 flex flex-col"
            >
              <DatabaseExplorer />
            </div>
            <div className="flex-1 min-w-0 h-full min-h-0 flex flex-col">
              <BitLayoutMatrix />
            </div>
          </div>
        ) : (
          <div className="p-6 font-mono text-xs" style={{ color: 'var(--status-critical)' }}>
            Bu dosya derlenemedi. Kataloğdan silip yeniden yükleyin.
          </div>
        )}
      </div>
    );
  }

  // ==========================================================================
  // LEVEL 1 — Database catalog list
  // ==========================================================================
  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-canvas">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline bg-surface px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-[11px] uppercase tracking-wider text-muted">
            NETDB // DBC·KCD KATALOĞU
          </span>
          <span className="text-subtle">/</span>
          <h1 className="text-[14px] font-semibold text-ink">Sinyal Veritabanları</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* CLOUD'DAN ÇEK BUTTON */}
          <button
            type="button"
            disabled={busy}
            onClick={() => setCloudPullModalOpen(true)}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-sky-500/50 bg-sky-950/40 px-3 font-mono text-[11px] font-semibold uppercase tracking-wider text-sky-300 hover:bg-sky-900/50 disabled:opacity-50"
          >
            <DownloadCloud className="h-3.5 w-3.5 text-sky-400" aria-hidden="true" />
            CLOUD'DAN ÇEK
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => void handleAddPresets()}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-elevated px-2.5 font-mono text-[11px] font-medium text-ink hover:border-strong disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
            ÖRNEK ARAÇ / BMS EKLE
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".dbc,.kcd,.xml"
            className="hidden"
            onChange={(ev) => void handleUploadFiles(ev)}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] px-3 font-mono text-[11px] font-semibold uppercase tracking-wider text-white hover:opacity-90 disabled:opacity-50"
            style={{ backgroundColor: 'var(--status-nominal)' }}
          >
            <UploadCloud className="h-3.5 w-3.5" aria-hidden="true" />
            {busy ? 'DERLENİYOR...' : '.DBC / .KCD YÜKLE'}
          </button>
        </div>
      </div>

      <div className="mx-auto max-w-[1600px] space-y-4 p-4">
        {actionError && (
          <div
            className="rounded-[2px] border px-3 py-2 font-mono text-[11px]"
            style={{ borderColor: 'var(--status-critical)', color: 'var(--status-critical)' }}
          >
            {actionError}
          </div>
        )}
        {actionInfo && (
          <div
            className="rounded-[2px] border px-3 py-2 font-mono text-[11px]"
            style={{ borderColor: 'var(--status-nominal)', color: 'var(--status-nominal)' }}
          >
            {actionInfo}
          </div>
        )}

        {/* KPI strip */}
        <div className="grid grid-cols-2 divide-x divide-y divide-hairline rounded-[2px] border border-hairline bg-surface sm:grid-cols-5 sm:divide-y-0">
          {(
            [
              ['TOPLAM VERİTABANI', databases.length],
              ['TOPLAM MESAJ', kpi.msgs],
              ['TOPLAM SİNYAL', kpi.sigs],
              ['ECU DÜĞÜMÜ', kpi.ecus],
              ['DB BAĞLI HAT', `${kpi.boundBuses} / ${profiles.length}`],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted">{label}</div>
              <div className="mt-1 font-mono text-[18px] font-semibold tabular-nums text-ink">{value}</div>
            </div>
          ))}
        </div>

        <section className="rounded-[2px] border border-hairline bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-hairline bg-elevated px-3.5 py-2">
            <div className="flex items-center gap-2">
              <Database className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
              <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-ink">
                KATALOGDAKİ VERİTABANLARI ({filtered.length}
                {filtered.length !== databases.length ? ` / ${databases.length}` : ''})
              </h2>
            </div>
            {databases.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex divide-x divide-hairline rounded-[2px] border border-hairline bg-canvas">
                  {(
                    [
                      { id: 'all', label: 'TÜMÜ' },
                      { id: 'dbc', label: '.DBC' },
                      { id: 'kcd', label: '.KCD' },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setFormatFilter(item.id)}
                      className={`h-7 cursor-pointer px-2.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${
                        formatFilter === item.id ? 'bg-surface text-ink' : 'text-muted hover:text-ink'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="relative w-64 sm:w-72">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted"
                    aria-hidden="true"
                  />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Dosya, mesaj adı veya 0x101 ara..."
                    aria-label="Veritabanlarını filtrele"
                    className="h-7 w-full rounded-[2px] border border-hairline bg-canvas pr-7 pl-8 font-mono text-xs text-ink placeholder:text-subtle"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      aria-label="Aramayı temizle"
                      className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer p-0.5 text-muted hover:text-ink"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {databases.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
              <Database className="h-6 w-6 text-muted" aria-hidden="true" />
              <p className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                HENÜZ .DBC / .KCD VERİTABANI EKLENMEDİ
              </p>
              <p className="max-w-lg text-xs text-muted">
                İstediğiniz kadar .dbc / .kcd dosyası ekleyin; ardından her bağlantıya (Bus) 0, 1 veya
                birden fazla veritabanı bağlayın. Veritabanı bağlanmamış hatlar Raw Hex olarak kalır.
              </p>
              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setCloudPullModalOpen(true)}
                  className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-sky-500/50 bg-sky-950/40 px-3 font-mono text-[11px] font-semibold uppercase text-sky-300 hover:bg-sky-900/50"
                >
                  <DownloadCloud className="h-3.5 w-3.5 text-sky-400" aria-hidden="true" />
                  CLOUD'DAN ÇEK
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] px-3 font-mono text-[11px] font-semibold uppercase text-white"
                  style={{ backgroundColor: 'var(--status-nominal)' }}
                >
                  <UploadCloud className="h-3.5 w-3.5" aria-hidden="true" />
                  İLK .DBC / .KCD DOSYASINI YÜKLE
                </button>
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-6 py-10 text-center font-mono text-xs text-muted">
              ARAMA KRİTERİNE UYGUN VERİTABANI BULUNAMADI.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-hairline bg-elevated font-mono text-[10px] uppercase tracking-wider text-muted">
                    <th className="py-2 px-3">FORMAT</th>
                    <th className="py-2 px-3">VERİTABANI ADI & DOSYA</th>
                    <th className="py-2 px-3">BAĞLI BAĞLANTILAR (BUS)</th>
                    <th className="py-2 px-3 text-right">MSG / SİNYAL / ECU</th>
                    <th className="py-2 px-3 text-right">BOYUT</th>
                    <th className="py-2 px-3 text-right">İŞLEMLER</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {filtered.map((db) => {
                    return (
                      <tr
                        key={db.id}
                        onClick={() => openInspector(db.id)}
                        className="cursor-pointer hover:bg-hover/60"
                      >
                        <td className="py-2.5 px-3">
                          <span className="inline-flex items-center gap-1 rounded-[2px] border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-focus">
                            <FileCode2 className="h-3 w-3" aria-hidden="true" />.{db.format}
                          </span>
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="font-semibold text-ink">{db.name}</div>
                          <div className="font-mono text-[10px] text-muted">
                            {db.fileName}
                            {db.schema ? '' : ' · DERLEME HATASI'}
                          </div>
                        </td>

                        {/* Interactive Non-Clipped Bus Selection in Catalog Table */}
                        <td className="py-2.5 px-3" onClick={(e) => e.stopPropagation()}>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {profiles.length === 0 ? (
                              <span
                                className="rounded-[2px] border px-1.5 py-0.5 font-mono text-[10px] uppercase"
                                style={{ borderColor: 'var(--status-warn)', color: 'var(--status-warn)' }}
                              >
                                Kayıtlı Bus yok
                              </span>
                            ) : (
                              profiles
                                .slice()
                                .sort((a, b) => a.busId - b.busId)
                                .map((p) => {
                                  const isBound = p.databaseIds.includes(db.id);
                                  return (
                                    <button
                                      key={p.id}
                                      type="button"
                                      onClick={() => toggleBinding(db.id, p.id)}
                                      className={`inline-flex h-5 cursor-pointer items-center gap-1 rounded-[2px] border px-1.5 font-mono text-[10px] tabular-nums transition-colors ${
                                        isBound
                                          ? 'border-emerald-500/60 bg-emerald-950/50 text-emerald-300 font-semibold'
                                          : 'border-hairline bg-canvas text-muted hover:text-ink hover:border-strong opacity-75 hover:opacity-100'
                                      }`}
                                      title={`${p.name} · Tıkla ve ${isBound ? 'çöz' : 'bağla'}`}
                                    >
                                      <span>Bus {p.busId + 1}</span>
                                      {isBound && <Check className="h-2.5 w-2.5 text-emerald-400" />}
                                    </button>
                                  );
                                })
                            )}
                            <button
                              type="button"
                              onClick={() => setModalBindDb(db)}
                              className="inline-flex h-5 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-canvas px-1.5 font-mono text-[10px] text-focus hover:border-strong"
                              title="Ayrıntılı Bus Bağlantı Penceresi"
                            >
                              <Cable className="h-3 w-3" aria-hidden="true" />
                              <span>Bus Seç…</span>
                            </button>
                          </div>
                        </td>

                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink">
                          {db.schema?.messages.length ?? 0} / {db.schema?.signals.length ?? 0} /{' '}
                          {db.schema?.ecus.length ?? 0}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-muted">
                          {formatKb(db.sizeBytes)}
                        </td>
                        <td className="py-2.5 px-3" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => openInspector(db.id)}
                              className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-elevated px-2 font-mono text-[10px] font-semibold text-ink hover:border-strong"
                            >
                              <Layers className="h-3 w-3 text-focus" aria-hidden="true" />
                              İncele (Bit Matrisi)
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeletingDb(db)}
                              className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-canvas px-2 font-mono text-[10px] hover:border-strong"
                              style={{ color: 'var(--status-critical)' }}
                            >
                              <Trash2 className="h-3 w-3" aria-hidden="true" />
                              Sil
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* FIXED BUS BINDING MODAL (PREVENTS OVERFLOW CLIPPING) */}
      {modalBindDb && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 select-none"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-[2px] border border-strong bg-surface shadow-2xl flex flex-col max-h-[85vh]">
            <div className="flex h-10 items-center justify-between border-b border-hairline bg-elevated px-3.5">
              <div className="flex items-center gap-2">
                <Cable className="h-4 w-4 text-focus" />
                <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                  BUS BAĞLANTILARI
                </span>
              </div>
              <button
                type="button"
                onClick={() => setModalBindDb(null)}
                className="cursor-pointer text-muted hover:text-ink p-1"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-4 space-y-3 flex-1 min-h-0 overflow-y-auto">
              <div className="text-xs text-muted">
                <strong className="text-ink font-mono">{modalBindDb.fileName}</strong> veritabanının
                çözümleneceği CAN Bus hatlarını seçin:
              </div>

              {profiles.length === 0 ? (
                <div className="p-3 border border-dashed border-hairline rounded-[2px] text-center text-xs text-muted">
                  Kayıtlı bağlantı (Bus) profili bulunamadı.
                </div>
              ) : (
                <div className="divide-y divide-hairline border border-hairline rounded-[2px] bg-canvas">
                  {profiles
                    .slice()
                    .sort((a, b) => a.busId - b.busId)
                    .map((p) => {
                      const isBound = p.databaseIds.includes(modalBindDb.id);
                      return (
                        <label
                          key={p.id}
                          className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-xs hover:bg-hover"
                        >
                          <input
                            type="checkbox"
                            checked={isBound}
                            onChange={() => toggleBinding(modalBindDb.id, p.id)}
                            className="h-4 w-4 rounded-[2px] accent-[var(--status-focus)]"
                          />
                          <span className="font-mono font-semibold tabular-nums text-focus">
                            Bus {p.busId + 1}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-ink font-medium">{p.name}</span>
                          <span className="font-mono text-[10px] text-muted shrink-0">
                            {p.adapterChannel || p.deviceId}
                          </span>
                        </label>
                      );
                    })}
                </div>
              )}

              <button
                type="button"
                onClick={() => void handleOpenNewConnectionModal()}
                className="w-full h-7 border border-dashed border-focus/50 bg-focus/10 text-focus hover:bg-focus/20 font-mono text-[11px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer rounded-[2px]"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>+ Yeni Bus Bağlantısı Oluştur...</span>
              </button>
            </div>

            <div className="flex justify-end gap-2 border-t border-hairline p-3 bg-elevated">
              <button
                type="button"
                onClick={() => setModalBindDb(null)}
                className="h-7 cursor-pointer rounded-[2px] px-4 font-mono text-[11px] font-semibold uppercase text-white bg-focus hover:opacity-90"
              >
                TAMAM
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CLOUD PULL MODAL */}
      {cloudPullModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 select-none"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-[620px] rounded-[2px] border border-strong bg-surface shadow-2xl flex flex-col max-h-[88vh]">
            <div className="flex h-10 items-center justify-between border-b border-hairline bg-elevated px-3.5">
              <div className="flex items-center gap-2">
                <DownloadCloud className="h-4 w-4 text-sky-400" />
                <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                  NEXUSCANCLOUD // VERİTABANI ÇEK VE BAĞLA
                </span>
              </div>
              <button
                type="button"
                onClick={() => setCloudPullModalOpen(false)}
                className="cursor-pointer text-muted hover:text-ink p-1"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-4 space-y-4 flex-1 min-h-0 overflow-y-auto">
              {!cloudState.sessionToken ? (
                <div className="p-4 border border-hairline bg-canvas rounded-[2px] text-center space-y-3">
                  <Cloud className="h-8 w-8 text-muted mx-auto" />
                  <div className="text-xs font-semibold text-ink">NexusCANCloud Oturumu Açık Değil</div>
                  <div className="text-[11px] text-muted max-w-sm mx-auto">
                    Buluttaki projelerinize ait .dbc ve .kcd veritabanlarını çekmek için önce oturum açmalısınız.
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setCloudPullModalOpen(false);
                      databaseStore.setActiveDocTab('cloud');
                    }}
                    className="h-7 px-4 rounded-[2px] font-mono text-[11px] font-semibold uppercase text-white bg-sky-600 hover:bg-sky-500 cursor-pointer"
                  >
                    Cloud Sekmesine Git ve Giriş Yap
                  </button>
                </div>
              ) : (
                <>
                  {/* Cloud Project Selector */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-mono uppercase text-muted">Cloud Projesi:</span>
                      <button
                        type="button"
                        disabled={loadingPullable}
                        onClick={() => void refreshPullableDatabases(selectedCloudProjId)}
                        className="font-mono text-[10px] text-sky-400 hover:underline flex items-center gap-1 cursor-pointer"
                      >
                        <RefreshCw className={`h-3 w-3 ${loadingPullable ? 'animate-spin' : ''}`} />
                        Yenile
                      </button>
                    </div>
                    <select
                      value={selectedCloudProjId}
                      onChange={(e) => setSelectedCloudProjId(e.target.value)}
                      className="w-full h-8 rounded-[2px] border border-hairline bg-canvas px-2 font-mono text-xs text-ink"
                    >
                      {cloudState.projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          [{p.code}] {p.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Pullable Databases List */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-mono uppercase text-muted">
                        Buluttaki Veritabanları ({pullableDatabases.length}):
                      </span>
                      {pullableDatabases.length > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            if (selectedDbKeys.size === pullableDatabases.length) {
                              setSelectedDbKeys(new Set());
                            } else {
                              setSelectedDbKeys(new Set(pullableDatabases.map((d) => d.key)));
                            }
                          }}
                          className="font-mono text-[10px] text-muted hover:text-ink cursor-pointer"
                        >
                          {selectedDbKeys.size === pullableDatabases.length ? 'Seçimi Kaldır' : 'Tümünü Seç'}
                        </button>
                      )}
                    </div>

                    {loadingPullable ? (
                      <div className="py-8 flex items-center justify-center gap-2 font-mono text-xs text-muted">
                        <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
                        <span>Veritabanları taranıyor...</span>
                      </div>
                    ) : pullableDatabases.length === 0 ? (
                      <div className="p-4 border border-dashed border-hairline rounded-[2px] text-center text-xs text-muted">
                        Bu bulut projesinde henüz kayıtlı .dbc veya .kcd veritabanı bulunamadı.
                      </div>
                    ) : (
                      <div className="divide-y divide-hairline border border-hairline rounded-[2px] bg-canvas max-h-48 overflow-y-auto">
                        {pullableDatabases.map((item) => {
                          const isSelected = selectedDbKeys.has(item.key);
                          const existsLocally = databases.some(
                            (d) => d.fileName.toLowerCase() === item.fileName.toLowerCase(),
                          );
                          return (
                            <label
                              key={item.key}
                              className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-xs hover:bg-hover"
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => {
                                  setSelectedDbKeys((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(item.key)) next.delete(item.key);
                                    else next.add(item.key);
                                    return next;
                                  });
                                }}
                                className="h-4 w-4 rounded-[2px] accent-sky-500"
                              />
                              <span className="inline-flex items-center gap-1 rounded-[2px] border border-hairline bg-surface px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-focus">
                                .{item.format}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="font-semibold text-ink truncate">{item.fileName}</div>
                                <div className="font-mono text-[10px] text-muted">
                                  {formatKb(item.sizeBytes)}
                                  {item.messageCount !== null ? ` · ${item.messageCount} msg` : ''}
                                  {item.signalCount !== null ? ` · ${item.signalCount} sig` : ''}
                                </div>
                              </div>
                              <span
                                className={`rounded-[2px] border px-1.5 py-0.5 font-mono text-[10px] uppercase font-semibold ${
                                  existsLocally
                                    ? 'border-amber-600/50 bg-amber-950/30 text-amber-300'
                                    : 'border-emerald-600/50 bg-emerald-950/30 text-emerald-300'
                                }`}
                              >
                                {existsLocally ? 'GÜNCELLE' : 'YENİ'}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Target Bus / Connection Selection */}
                  <div className="space-y-1.5">
                    <span className="font-mono text-[11px] uppercase text-muted">
                      Hedef Bus / Bağlantı Seçimi:
                    </span>
                    <div className="text-[11px] text-muted">
                      İndirilen veritabanları hangi bağlantılara bağlansın? (İsteğe bağlı, seçilmezse sadece kataloğa eklenir)
                    </div>

                    {profiles.length === 0 ? (
                      <div className="p-3 border border-dashed border-hairline rounded-[2px] text-xs text-muted flex items-center justify-between">
                        <span>Henüz kayıtlı Bus bağlantısı yok.</span>
                        <button
                          type="button"
                          onClick={() => void handleOpenNewConnectionModal()}
                          className="font-mono text-[10px] text-focus font-semibold hover:underline cursor-pointer"
                        >
                          + Bus Ekle
                        </button>
                      </div>
                    ) : (
                      <div className="divide-y divide-hairline border border-hairline rounded-[2px] bg-canvas max-h-36 overflow-y-auto">
                        {profiles
                          .slice()
                          .sort((a, b) => a.busId - b.busId)
                          .map((p) => {
                            const isChecked = targetProfileIds.has(p.id);
                            return (
                              <label
                                key={p.id}
                                className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-xs hover:bg-hover"
                              >
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => {
                                    setTargetProfileIds((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(p.id)) next.delete(p.id);
                                      else next.add(p.id);
                                      return next;
                                    });
                                  }}
                                  className="h-3.5 w-3.5 rounded-[2px] accent-sky-500"
                                />
                                <span className="font-mono font-semibold tabular-nums text-focus">
                                  Bus {p.busId + 1}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-ink">{p.name}</span>
                                <span className="font-mono text-[10px] text-muted shrink-0">
                                  {p.adapterChannel || p.deviceId}
                                </span>
                              </label>
                            );
                          })}
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => void handleOpenNewConnectionModal()}
                      className="inline-flex items-center gap-1 font-mono text-[11px] text-focus hover:underline cursor-pointer pt-0.5"
                    >
                      <Plus className="h-3 w-3" />
                      <span>+ Yeni Bus Bağlantısı Oluştur...</span>
                    </button>
                  </div>

                  {pullError && (
                    <div
                      className="rounded-[2px] border px-3 py-2 font-mono text-[11px]"
                      style={{ borderColor: 'var(--status-critical)', color: 'var(--status-critical)' }}
                    >
                      {pullError}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-hairline p-3 bg-elevated">
              <button
                type="button"
                disabled={pullingBusy}
                onClick={() => setCloudPullModalOpen(false)}
                className="h-7 cursor-pointer rounded-[2px] border border-hairline bg-surface px-3 font-mono text-[11px] text-ink hover:border-strong disabled:opacity-50"
              >
                İPTAL
              </button>

              {Boolean(cloudState.sessionToken) && (
                <button
                  type="button"
                  disabled={pullingBusy || selectedDbKeys.size === 0}
                  onClick={() => void handleExecuteCloudPull()}
                  className="h-7 cursor-pointer rounded-[2px] px-4 font-mono text-[11px] font-semibold uppercase text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-50 flex items-center gap-1.5"
                >
                  {pullingBusy ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>İNDİRİLİYOR...</span>
                    </>
                  ) : (
                    <>
                      <DownloadCloud className="h-3.5 w-3.5" />
                      <span>CLOUD'DAN ÇEK VE SEÇİLİ BUS'LARA BAĞLA</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* NESTED NEW CONNECTION MODAL IF TRIGGERED FROM WITHIN DATABASES */}
      {newConnModalOpen && (
        <NewConnectionModal
          devices={devices}
          onClose={() => setNewConnModalOpen(false)}
          onStatusMessage={(banner) => setActionInfo(banner.message)}
        />
      )}

      {/* DELETE CONFIRMATION DIALOG */}
      {deletingDb && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'var(--bg-scrim)' }}
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-[2px] border border-strong bg-surface">
            <div className="flex h-10 items-center border-b border-hairline bg-elevated px-3.5 font-mono text-xs font-semibold uppercase tracking-wider text-ink">
              VERİTABANINI SİL
            </div>
            <div className="space-y-3 p-4 text-xs text-muted">
              <p>
                <strong className="text-ink">{deletingDb.fileName}</strong> katalogdan kaldırılacak ve
                bağlı olduğu{' '}
                <span className="font-mono tabular-nums text-ink">
                  {(profilesByDbId.get(deletingDb.id) ?? []).length}
                </span>{' '}
                bağlantıdan çözülecek (bu hatlar başka DB bağlı değilse Raw Hex'e döner).
              </p>
              <div className="flex justify-end gap-2 border-t border-hairline pt-3">
                <button
                  type="button"
                  onClick={() => setDeletingDb(null)}
                  className="h-7 cursor-pointer rounded-[2px] border border-hairline bg-elevated px-3 font-mono text-[11px] text-ink"
                >
                  İPTAL
                </button>
                <button
                  type="button"
                  onClick={confirmDelete}
                  className="h-7 cursor-pointer rounded-[2px] px-3.5 font-mono text-[11px] font-semibold uppercase text-white"
                  style={{ backgroundColor: 'var(--status-critical)' }}
                >
                  SİL
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
