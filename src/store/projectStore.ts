import { useSyncExternalStore } from 'react';
import {
  apiClearDatabase,
  apiConnectBus,
  apiDeleteProject,
  apiGetPresetDatabaseFiles,
  apiListPeriodicTx,
  apiListProjects,
  apiLoadProject,
  resetSessionCompat,
  apiParseDatabaseSchema,
  apiResetTelemetry,
  apiSaveProject,
} from '../services/ipcClient';
import type { ProjectSummaryDto } from '../types/hal';
import {
  type SavedConnectionProfile,
  buildChannelConfigForProfile,
  connectionStore,
} from './connectionStore';
import {
  type ActiveDocumentTab,
  type CustomDbFileRecord,
  type ProjectDatabaseEntry,
  type UiTheme,
  databaseStore,
  makeCatalogDbId,
} from './databaseStore';
import { syncAllBusDatabasesWithBackend } from '../utils/busDatabaseSync';
import { type PlotProjectState, plotStore } from './plotStore';
import { simulationPanelStore } from './simulationPanelStore';
import { DEFAULT_CHRONO_BUFFER_ROWS, telemetryStore } from './telemetryStore';
import { type TxListEntry, transmitStore } from './transmitStore';
import type { SimulationPanelDto } from '../types/simulation';
import {
  type EngineeringToolpackId,
  DEFAULT_ENABLED_TOOLPACKS,
  isToolpackEnabled,
  normalizeEnabledToolpacks,
} from '../types/toolpacks';
import {
  LAST_ACTIVE_PROJECT_KEY,
  clearActiveProjectFromLocalDb,
  loadActiveProjectFromLocalDb,
  readActiveSessionMetaSync,
  saveActiveProjectToLocalDb,
  writeActiveSessionMetaSync,
} from '../utils/workspaceDb';
import type { CloudProjectBindingV1 } from '../utils/workspaceDiff';
import { sanitizeProject } from '../utils/projectSanitize';

export interface QuickBarConnectionState {
  selectedDeviceId: string;
  bitrateProfileId: string;
  mockFpsPreset: number | null;
  listenOnly: boolean;
}

export interface NexusProjectFileV1 {
  version: 1;
  name: string;
  fileStem: string;
  createdAt: string;
  updatedAt: string;
  notes: string;
  databases: {
    usePresetDb: boolean;
    customFiles: CustomDbFileRecord[];
  };
  connections: {
    profiles: SavedConnectionProfile[];
    activeConnectedProfileIds: string[];
    quickBarState: QuickBarConnectionState;
  };
  transmitList: {
    entries: TxListEntry[];
  };
  plotter: PlotProjectState;
  simulationPanels?: SimulationPanelDto[];
  workspace: {
    traceMaxBufferRows: number;
    activeDocTab: ActiveDocumentTab;
    theme: UiTheme;
    expandedRxKeys: string[];
    enabledToolpacks?: EngineeringToolpackId[];
  };
  cloudBinding?: CloudProjectBindingV1 | null;
}

export interface ProjectStoreState {
  hasActiveWorkspace: boolean;
  currentName: string;
  currentFileStem: string;
  createdAt: string;
  updatedAt: string | null;
  notes: string;
  dirty: boolean;
  savedProjects: readonly ProjectSummaryDto[];
  modalOpen: boolean;
  toolpacksModalOpen: boolean;
  acknowledgmentsModalOpen: boolean;
  enabledToolpacks: readonly EngineeringToolpackId[];
  cloudBinding: CloudProjectBindingV1 | null;
  /** Set after opening an external project file: connections are NOT opened automatically. */
  importNotice: ImportNotice | null;
}

export interface ImportNotice {
  /** Profiles that asked to connect (still Listen-Only). */
  profileIds: readonly string[];
  /** Withheld until the user confirms. */
  cloudBinding: CloudProjectBindingV1 | null;
}

export function sanitizeProjectFileStem(input: string): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 64) : 'nexus-project';
}

const initialMeta = typeof window !== 'undefined' ? readActiveSessionMetaSync() : null;

let currentState: ProjectStoreState = {
  hasActiveWorkspace: Boolean(initialMeta?.isOpen),
  currentName: initialMeta?.isOpen ? initialMeta.name : 'No Project',
  currentFileStem: initialMeta?.isOpen ? initialMeta.fileStem : 'no-project',
  createdAt: initialMeta?.isOpen ? initialMeta.updatedAt : new Date().toISOString(),
  updatedAt: initialMeta?.isOpen ? initialMeta.updatedAt : null,
  notes: '',
  dirty: false,
  savedProjects: [],
  modalOpen: false,
  toolpacksModalOpen: false,
  acknowledgmentsModalOpen: false,
  enabledToolpacks: [...DEFAULT_ENABLED_TOOLPACKS],
  cloudBinding: null,
  importNotice: null,
};

const listeners = new Set<() => void>();
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let isRestoring = false;

function emitChange(): void {
  for (const fn of listeners) {
    fn();
  }
}

export function cacheLastActiveProject(project: NexusProjectFileV1): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_ACTIVE_PROJECT_KEY, JSON.stringify(project));
  } catch {
    // Ignore localStorage quota errors when custom .dbc is very large
  }
}

export function readCachedLastActiveProject(): NexusProjectFileV1 | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LAST_ACTIVE_PROJECT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<NexusProjectFileV1>;
    if (parsed && parsed.version === 1 && typeof parsed.name === 'string') {
      return parsed as NexusProjectFileV1;
    }
  } catch {
    // Ignore malformed JSON
  }
  return null;
}

export function clearCachedLastActiveProject(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(LAST_ACTIVE_PROJECT_KEY);
  } catch {
    // Ignore
  }
}

export const projectStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getState(): ProjectStoreState {
    return currentState;
  },

  setModalOpen(open: boolean): void {
    if (currentState.modalOpen === open) return;
    currentState = { ...currentState, modalOpen: open };
    emitChange();
  },

  setToolpacksModalOpen(open: boolean): void {
    if (currentState.toolpacksModalOpen === open) return;
    currentState = { ...currentState, toolpacksModalOpen: open };
    emitChange();
  },

  setAcknowledgmentsModalOpen(open: boolean): void {
    if (currentState.acknowledgmentsModalOpen === open) return;
    currentState = { ...currentState, acknowledgmentsModalOpen: open };
    emitChange();
  },

  setEnabledToolpacks(
    ids: readonly (EngineeringToolpackId | string)[] | undefined | null,
    quickBarState?: QuickBarConnectionState,
  ): void {
    const normalized = normalizeEnabledToolpacks(ids);
    const wasSimEnabled = isToolpackEnabled(currentState.enabledToolpacks, 'simulation_replay');
    const isSimNowEnabled = isToolpackEnabled(normalized, 'simulation_replay');

    // 0 CPU Rule: If simulation is disabled, shut down any running stimulus loop
    if (wasSimEnabled && !isSimNowEnabled) {
      if (simulationPanelStore.getState().editorMode === 'RUN') {
        simulationPanelStore.setEditorMode('DESIGN');
      }
      simulationPanelStore.stopAllPeriodicStimulusJobs();

      if (databaseStore.getState().activeDocTab === 'panels') {
        databaseStore.setActiveDocTab('rxtx');
      }
    }

    currentState = {
      ...currentState,
      enabledToolpacks: normalized,
      dirty: true,
    };
    emitChange();

    if (currentState.hasActiveWorkspace) {
      projectStore.scheduleAutoSave(quickBarState);
    }
  },

  toggleToolpack(
    id: EngineeringToolpackId,
    quickBarState?: QuickBarConnectionState,
  ): void {
    if (id === 'core') return; // Core pack is immutable and permanently active
    const current = new Set(currentState.enabledToolpacks);
    if (current.has(id)) {
      current.delete(id);
    } else {
      current.add(id);
    }
    projectStore.setEnabledToolpacks(Array.from(current), quickBarState);
  },

  setProjectMetadata(name: string, notes?: string): void {
    const trimmed = name.trim() || 'Untitled Project';
    currentState = {
      ...currentState,
      currentName: trimmed,
      currentFileStem: sanitizeProjectFileStem(trimmed),
      notes: notes !== undefined ? notes : currentState.notes,
    };
    emitChange();
  },

  async refreshSavedProjects(): Promise<ProjectSummaryDto[]> {
    try {
      const list = await apiListProjects();
      currentState = {
        ...currentState,
        savedProjects: list,
      };
      emitChange();
      return list;
    } catch {
      return [...currentState.savedProjects];
    }
  },

  /**
   * Captures the complete workspace state (embedded `.dbc`/`.kcd` files, saved connection profiles,
   * active buses, TX list, Plotter signals & layout, Trace 100k buffer limit, and UI theme) into `NexusProjectFileV1`.
   */
  buildProjectSnapshot(
    quickBarState?: QuickBarConnectionState,
    overrideName?: string,
    overrideNotes?: string,
  ): NexusProjectFileV1 {
    const db = databaseStore.getState();
    const conn = connectionStore.getState();
    const tx = transmitStore.getState();
    const chrono = telemetryStore.getChronoSlice();
    const header = telemetryStore.getHeaderSlice();

    const name = (overrideName ?? currentState.currentName).trim() || 'Untitled Project';
    const fileStem = sanitizeProjectFileStem(name);
    const nowIso = new Date().toISOString();

    const connectedBusSet = new Set<number>(
      header.buses.filter((b) => b.connected).map((b) => b.busId),
    );
    const activeConnectedProfileIds = conn.profiles
      .filter((p) => connectedBusSet.has(p.busId))
      .map((p) => p.id);

    const safeTxEntries: TxListEntry[] = tx.entries.map((e) => ({
      ...e,
      rawBytes: [...e.rawBytes],
      signalValues: { ...e.signalValues },
      periodicEnabled: false,
      backendJobId: null,
      manualSentCount: 0,
      periodicSentCount: 0,
    }));

    return {
      version: 1,
      name,
      fileStem,
      createdAt: currentState.createdAt,
      updatedAt: nowIso,
      notes: overrideNotes ?? currentState.notes,
      databases: {
        usePresetDb: false,
        customFiles: db.databases.map((f) => ({
          fileName: f.fileName,
          contentBase64: f.contentBase64,
          sizeBytes: f.sizeBytes,
        })),
      },
      connections: {
        profiles: conn.profiles.map((p) => ({ ...p })),
        activeConnectedProfileIds,
        quickBarState: quickBarState
          ? { ...quickBarState }
          : {
              selectedDeviceId: '',
              bitrateProfileId: 'fd_500k_2m',
              mockFpsPreset: null,
              listenOnly: true,
            },
      },
      transmitList: {
        entries: safeTxEntries,
      },
      plotter: plotStore.exportProjectState(),
      simulationPanels: simulationPanelStore.exportForProject(),
      workspace: {
        traceMaxBufferRows: chrono.maxBufferRows,
        activeDocTab: db.activeDocTab,
        theme: db.theme,
        expandedRxKeys: [...db.expandedRxKeys],
        enabledToolpacks: normalizeEnabledToolpacks(currentState.enabledToolpacks),
      },
      cloudBinding: currentState.cloudBinding ?? null,
    };
  },

  /**
   * Debounced 400ms automatic background persistence:
   * Updates synchronous session metadata, writes to IndexedDB (`workspace_kv`),
   * and asynchronously writes `projects/<stem>.nexusproj.json` on disk.
   */
  scheduleAutoSave(quickBarState?: QuickBarConnectionState): void {
    if (!currentState.hasActiveWorkspace || isRestoring) return;

    if (autoSaveTimer !== null) {
      clearTimeout(autoSaveTimer);
    }

    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      if (!currentState.hasActiveWorkspace || isRestoring) return;

      try {
        const snapshot = projectStore.buildProjectSnapshot(quickBarState);
        writeActiveSessionMetaSync({
          isOpen: true,
          fileStem: snapshot.fileStem,
          name: snapshot.name,
          activeDocTab: snapshot.workspace.activeDocTab,
          theme: snapshot.workspace.theme,
          updatedAt: snapshot.updatedAt,
        });
        void saveActiveProjectToLocalDb(snapshot);
        void apiSaveProject(
          snapshot.fileStem,
          JSON.stringify(snapshot, null, 2),
        ).catch(() => undefined);
      } catch (err) {
        console.warn('[projectStore] scheduleAutoSave error:', err);
      }
    }, 400);
  },

  async persistActiveWorkspaceNow(
    quickBarState?: QuickBarConnectionState,
  ): Promise<void> {
    if (!currentState.hasActiveWorkspace || isRestoring) return;
    if (autoSaveTimer !== null) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    const snapshot = projectStore.buildProjectSnapshot(quickBarState);
    writeActiveSessionMetaSync({
      isOpen: true,
      fileStem: snapshot.fileStem,
      name: snapshot.name,
      activeDocTab: snapshot.workspace.activeDocTab,
      theme: snapshot.workspace.theme,
      updatedAt: snapshot.updatedAt,
    });
    await saveActiveProjectToLocalDb(snapshot);
    await apiSaveProject(
      snapshot.fileStem,
      JSON.stringify(snapshot, null, 2),
    ).catch(() => undefined);
  },

  async saveCurrentProject(
    quickBarState: QuickBarConnectionState,
    overrideName?: string,
    overrideNotes?: string,
  ): Promise<NexusProjectFileV1> {
    const snapshot = projectStore.buildProjectSnapshot(
      quickBarState,
      overrideName,
      overrideNotes,
    );
    const json = JSON.stringify(snapshot, null, 2);

    writeActiveSessionMetaSync({
      isOpen: true,
      fileStem: snapshot.fileStem,
      name: snapshot.name,
      activeDocTab: snapshot.workspace.activeDocTab,
      theme: snapshot.workspace.theme,
      updatedAt: snapshot.updatedAt,
    });
    await saveActiveProjectToLocalDb(snapshot);

    try {
      await apiSaveProject(snapshot.fileStem, json);
      await projectStore.refreshSavedProjects();
    } catch (err) {
      // Even if backend command is still warming up, IndexedDB and sync meta succeeded
      currentState = {
        ...currentState,
        hasActiveWorkspace: true,
        currentName: snapshot.name,
        currentFileStem: snapshot.fileStem,
        updatedAt: snapshot.updatedAt,
        notes: snapshot.notes,
        dirty: false,
      };
      emitChange();
      throw err;
    }

    currentState = {
      ...currentState,
      hasActiveWorkspace: true,
      currentName: snapshot.name,
      currentFileStem: snapshot.fileStem,
      updatedAt: snapshot.updatedAt,
      notes: snapshot.notes,
      dirty: false,
    };
    emitChange();
    return snapshot;
  },

  async loadServerProjectByStem(
    fileStem: string,
    onApplyQuickBar: (qb: QuickBarConnectionState) => void,
  ): Promise<NexusProjectFileV1> {
    const rawJson = await apiLoadProject(fileStem);
    const parsed = JSON.parse(rawJson) as NexusProjectFileV1;
    await projectStore.restoreProject(parsed, onApplyQuickBar);
    return parsed;
  },

  async deleteServerProjectByStem(fileStem: string): Promise<void> {
    await apiDeleteProject(fileStem);
    await projectStore.refreshSavedProjects();
  },

  /** Dismisses the "N connection profiles want to connect" notice without connecting. */
  dismissImportNotice(): void {
    if (currentState.importNotice === null) return;
    currentState = { ...currentState, importNotice: null };
    emitChange();
  },

  /** User confirmed: adopt the cloud binding that came with an imported file. */
  adoptImportedCloudBinding(): void {
    const notice = currentState.importNotice;
    if (notice === null || notice.cloudBinding === null) return;
    currentState = {
      ...currentState,
      cloudBinding: notice.cloudBinding,
      importNotice: { ...notice, cloudBinding: null },
    };
    emitChange();
  },

  /**
   * User confirmed: connect the imported profiles that asked to connect. They are still
   * Listen-Only (forced by the sanitizer); arming TX remains a separate explicit action.
   */
  async connectImportedProfiles(): Promise<{ connected: number; warnings: string[] }> {
    const notice = currentState.importNotice;
    if (notice === null) return { connected: 0, warnings: [] };
    const wanted = new Set(notice.profileIds);
    const warnings: string[] = [];
    let connected = 0;
    for (const prof of connectionStore.getState().profiles) {
      if (!wanted.has(prof.id)) continue;
      try {
        const { deviceId, config } = buildChannelConfigForProfile({ ...prof, listenOnly: true });
        const health = await apiConnectBus(deviceId, config);
        telemetryStore.upsertBusHealth(health);
        connected += 1;
      } catch (err) {
        warnings.push(`${prof.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    currentState = {
      ...currentState,
      importNotice: notice.cloudBinding !== null ? { profileIds: [], cloudBinding: notice.cloudBinding } : null,
    };
    emitChange();
    return { connected, warnings };
  },

  /**
   * Restores a complete `NexusProjectFileV1` across backend & frontend stores.
   * If `options.isReload === true` (e.g. F5 reload):
   * - Keeps existing live backend connections without dropping them.
   * - Reuses currently loaded schema from backend if available.
   * - Preserves the exact active tab without forcing 'rxtx'.
   */
  async restoreProject(
    projectIn: unknown,
    onApplyQuickBar?: (qb: QuickBarConnectionState) => void,
    options?: { isReload?: boolean },
  ): Promise<{ reconnectedCount: number; connectionWarnings: string[] }> {
    const isReload = Boolean(options?.isReload);
    // Every load path is validated; only a reload of the user's own last session keeps connections.
    const sanitized = sanitizeProject(projectIn, isReload ? 'own' : 'external');
    const project = sanitized.project;
    isRestoring = true;

    try {
      if (!isReload) {
        // Reset without latching Panic (old backends lack the command: fall back).
        await resetSessionCompat();
        await apiClearDatabase().catch(() => undefined);
        telemetryStore.clearAllBuses();
        transmitStore.markAllPaused();
      }

      // 1. Build database catalog from project files
      const catalogEntries: ProjectDatabaseEntry[] = [];
      const customFiles = project.databases?.customFiles ?? [];

      for (const file of customFiles) {
        try {
          const schema = await apiParseDatabaseSchema(file.fileName, file.contentBase64);
          catalogEntries.push({
            id: makeCatalogDbId(file.fileName),
            name: file.fileName.replace(/\.[^/.]+$/, ''),
            fileName: file.fileName,
            format: file.fileName.toLowerCase().endsWith('.kcd') ? 'kcd' : 'dbc',
            contentBase64: file.contentBase64,
            sizeBytes: file.sizeBytes ?? Math.round((file.contentBase64.length * 3) / 4),
            uploadedAt: new Date().toISOString(),
            schema,
          });
        } catch {
          catalogEntries.push({
            id: makeCatalogDbId(file.fileName),
            name: file.fileName.replace(/\.[^/.]+$/, ''),
            fileName: file.fileName,
            format: file.fileName.toLowerCase().endsWith('.kcd') ? 'kcd' : 'dbc',
            contentBase64: file.contentBase64,
            sizeBytes: file.sizeBytes ?? Math.round((file.contentBase64.length * 3) / 4),
            uploadedAt: new Date().toISOString(),
            schema: null,
          });
        }
      }

      if (catalogEntries.length === 0 && project.databases?.usePresetDb) {
        try {
          const presetFiles = await apiGetPresetDatabaseFiles();
          for (const f of presetFiles) {
            try {
              const schema = await apiParseDatabaseSchema(f.fileName, f.contentBase64);
              catalogEntries.push({
                id: makeCatalogDbId(f.fileName),
                name: f.fileName.replace(/\.[^/.]+$/, ''),
                fileName: f.fileName,
                format: f.fileName.toLowerCase().endsWith('.kcd') ? 'kcd' : 'dbc',
                contentBase64: f.contentBase64,
                sizeBytes: Math.round((f.contentBase64.length * 3) / 4),
                uploadedAt: new Date().toISOString(),
                schema,
              });
            } catch {
              // ignore broken preset
            }
          }
        } catch {
          // ignore preset fetch error
        }
      }

      databaseStore.setDatabasesCatalog(catalogEntries);

      // 2. Restore Connections with Legacy Migration for databaseIds
      const allCatalogIds = catalogEntries.map((d) => d.id);
      const rawProfiles = project.connections?.profiles ?? [];
      const normalizedProfiles = rawProfiles.map((p) => {
        // If databaseIds is explicitly provided (even empty []), preserve it!
        // If undefined (legacy project or from cloud), attach all catalog databases as migration.
        const databaseIds = Array.isArray(p.databaseIds)
          ? p.databaseIds
          : [...allCatalogIds];
        return {
          ...p,
          databaseIds,
        };
      });

      connectionStore.setProfiles(normalizedProfiles);
      if (project.connections?.quickBarState && onApplyQuickBar) {
        onApplyQuickBar(project.connections.quickBarState);
      }

      // 3. Sync all bus databases with Rust backend
      await syncAllBusDatabasesWithBackend({ force: true }).catch(() => undefined);

      // Per-bus resolver: every bus resolves symbols only from the databases bound to it
      const loadedSchema = (busId: number) => databaseStore.getBusSchema(busId);

      transmitStore.setEntriesFromProject(
        project.transmitList?.entries ?? [],
        loadedSchema,
      );

      if (project.plotter) {
        plotStore.restoreFromProject(project.plotter, loadedSchema);
      } else {
        plotStore.clearAllSeries();
      }

      simulationPanelStore.restoreFromProject(project.simulationPanels ?? []);

      const ws = project.workspace;
      const normalizedToolpacks = normalizeEnabledToolpacks(ws?.enabledToolpacks);
      const isSimEnabled = isToolpackEnabled(normalizedToolpacks, 'simulation_replay');
      if (!isSimEnabled) {
        if (simulationPanelStore.getState().editorMode === 'RUN') {
          simulationPanelStore.setEditorMode('DESIGN');
        }
        simulationPanelStore.stopAllPeriodicStimulusJobs();
      }

      if (ws) {
        telemetryStore.setMaxChronoBufferRows(
          ws.traceMaxBufferRows ?? DEFAULT_CHRONO_BUFFER_ROWS,
        );
        if (ws.theme === 'dark' || ws.theme === 'light') {
          databaseStore.setTheme(ws.theme);
        }
        databaseStore.setExpandedRxKeys(ws.expandedRxKeys ?? []);
        const validTabs: readonly ActiveDocumentTab[] = [
          'start',
          'rxtx',
          'connections',
          'plotter',
          'trace',
          'symbols',
          'panels',
          'cloud',
        ];
        let targetTab = ws.activeDocTab;
        if (!validTabs.includes(targetTab)) {
          targetTab = 'rxtx';
        }
        if (!isReload && targetTab === 'start') {
          targetTab = 'rxtx';
        }
        if (targetTab === 'panels' && !isSimEnabled) {
          targetTab = 'rxtx';
        }
        databaseStore.setActiveDocTab(targetTab);
      } else {
        databaseStore.setActiveDocTab('rxtx');
      }

      // Reconnect saved active / auto-connect profiles safely
      const activeIds = new Set<string>(
        project.connections?.activeConnectedProfileIds ?? [],
      );
      const profilesToConnect = isReload
        ? (project.connections?.profiles ?? []).filter(
            (p) => activeIds.has(p.id) || p.autoConnectOnProjectLoad,
          )
        : [];

      let reconnectedCount = 0;
      const connectionWarnings: string[] = [];

      for (const prof of profilesToConnect) {
        try {
          const { deviceId, config } = buildChannelConfigForProfile(prof);
          const health = await apiConnectBus(deviceId, config);
          telemetryStore.upsertBusHealth(health);
          reconnectedCount += 1;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (isReload && errMsg.toLowerCase().includes('already connected')) {
            reconnectedCount += 1;
          } else {
            connectionWarnings.push(`${prof.name}: ${errMsg}`);
          }
        }
      }

      // On F5 reload, preserve and re-bind any active periodic TX cycles running in nexus_bridge
      if (isReload) {
        const runningJobs = await apiListPeriodicTx().catch(() => []);
        if (runningJobs.length > 0) {
          transmitStore.syncBackendPeriodicJobs(runningJobs, loadedSchema);
        }
      }

      currentState = {
        ...currentState,
        hasActiveWorkspace: true,
        currentName: project.name || 'Loaded Project',
        currentFileStem:
          project.fileStem || sanitizeProjectFileStem(project.name || 'project'),
        createdAt: project.createdAt || new Date().toISOString(),
        updatedAt: project.updatedAt || new Date().toISOString(),
        notes: project.notes ?? '',
        dirty: false,
        enabledToolpacks: normalizedToolpacks,
        cloudBinding: project.cloudBinding ?? null,
        importNotice:
          !isReload &&
          (sanitized.connectCandidates.length > 0 || sanitized.pendingCloudBinding !== null)
            ? {
                profileIds: sanitized.connectCandidates.map((p) => p.id),
                cloudBinding: sanitized.pendingCloudBinding,
              }
            : null,
      };

      writeActiveSessionMetaSync({
        isOpen: true,
        fileStem: currentState.currentFileStem,
        name: currentState.currentName,
        activeDocTab: databaseStore.getState().activeDocTab,
        theme: databaseStore.getState().theme,
        updatedAt: currentState.updatedAt ?? new Date().toISOString(),
      });
      void saveActiveProjectToLocalDb(project);
      emitChange();

      return { reconnectedCount, connectionWarnings };
    } finally {
      isRestoring = false;
    }
  },

  /**
   * Restores active project session after page refresh (F5 / Ctrl+R).
   * Returns true if an active project was successfully restored, false otherwise.
   */
  async restoreActiveSessionOnReload(
    onApplyQuickBar?: (qb: QuickBarConnectionState) => void,
  ): Promise<boolean> {
    const meta = readActiveSessionMetaSync();
    if (!meta || !meta.isOpen) {
      return false;
    }

    let project = await loadActiveProjectFromLocalDb();
    if (!project) {
      project = readCachedLastActiveProject();
    }
    if (!project && meta.fileStem) {
      try {
        const rawJson = await apiLoadProject(meta.fileStem);
        project = JSON.parse(rawJson) as NexusProjectFileV1;
      } catch {
        project = null;
      }
    }

    if (!project) {
      writeActiveSessionMetaSync(null);
      return false;
    }

    try {
      await projectStore.restoreProject(project, onApplyQuickBar, { isReload: true });
      return true;
    } catch (err) {
      console.warn('[projectStore] restoreActiveSessionOnReload failed:', err);
      return false;
    }
  },

  async createNewCleanProject(
    projectNameOrOnApply?: string | ((qb: QuickBarConnectionState) => void),
    maybeOnApply?: (qb: QuickBarConnectionState) => void,
  ): Promise<void> {
    let projectName = 'Untitled Project';
    let onApplyQuickBar: ((qb: QuickBarConnectionState) => void) | undefined = maybeOnApply;
    if (typeof projectNameOrOnApply === 'string') {
      projectName = projectNameOrOnApply;
    } else if (typeof projectNameOrOnApply === 'function') {
      onApplyQuickBar = projectNameOrOnApply;
    }

    if (autoSaveTimer !== null) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }

    await resetSessionCompat();
    await apiClearDatabase().catch(() => undefined);
    await apiResetTelemetry().catch(() => undefined);

    telemetryStore.clearAllBuses();
    telemetryStore.clearAllTelemetry();
    telemetryStore.clearChrono();
    telemetryStore.setMaxChronoBufferRows(DEFAULT_CHRONO_BUFFER_ROWS);
    databaseStore.clearAll();
    databaseStore.setExpandedRxKeys([]);
    databaseStore.setActiveDocTab('rxtx');
    connectionStore.resetToDefaults();
    transmitStore.clearAll();
    plotStore.clearAllSeries();
    simulationPanelStore.clearAll();

    const defaultQb: QuickBarConnectionState = {
      selectedDeviceId: '',
      bitrateProfileId: 'fd_500k_2m',
      mockFpsPreset: null,
      listenOnly: true,
    };

    if (onApplyQuickBar) {
      onApplyQuickBar(defaultQb);
    }

    const nowIso = new Date().toISOString();
    const cleanName = projectName.trim() || 'Untitled Project';
    const fileStem = sanitizeProjectFileStem(cleanName);

    currentState = {
      ...currentState,
      hasActiveWorkspace: true,
      currentName: cleanName,
      currentFileStem: fileStem,
      createdAt: nowIso,
      updatedAt: nowIso,
      notes: '',
      dirty: false,
      enabledToolpacks: [...DEFAULT_ENABLED_TOOLPACKS],
      cloudBinding: null,
    };
    emitChange();

    const snapshot = projectStore.buildProjectSnapshot(defaultQb, cleanName, '');
    writeActiveSessionMetaSync({
      isOpen: true,
      fileStem: snapshot.fileStem,
      name: snapshot.name,
      activeDocTab: snapshot.workspace.activeDocTab,
      theme: snapshot.workspace.theme,
      updatedAt: snapshot.updatedAt,
    });
    await saveActiveProjectToLocalDb(snapshot);
    void apiSaveProject(snapshot.fileStem, JSON.stringify(snapshot, null, 2))
      .then(() => projectStore.refreshSavedProjects())
      .catch(() => undefined);
  },

  async closeCurrentProject(
    onApplyQuickBar?: (qb: QuickBarConnectionState) => void,
  ): Promise<void> {
    if (autoSaveTimer !== null) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }

    // 1. Clear session metadata & local DB (does NOT delete projects/*.nexusproj.json on disk)
    writeActiveSessionMetaSync(null);
    await clearActiveProjectFromLocalDb();

    // 2. Disarm backend
    await resetSessionCompat();
    await apiClearDatabase().catch(() => undefined);
    await apiResetTelemetry().catch(() => undefined);

    // 3. Clear frontend stores
    telemetryStore.clearAllBuses();
    telemetryStore.clearAllTelemetry();
    telemetryStore.clearChrono();
    telemetryStore.setMaxChronoBufferRows(DEFAULT_CHRONO_BUFFER_ROWS);
    databaseStore.clearAll();
    databaseStore.setExpandedRxKeys([]);
    databaseStore.setActiveDocTab('start');
    connectionStore.setProfiles([]);
    connectionStore.resetToDefaults();
    transmitStore.clearAll();
    plotStore.clearAllSeries();
    simulationPanelStore.clearAll();
    plotStore.clearBuffers();

    if (onApplyQuickBar) {
      onApplyQuickBar({
        selectedDeviceId: '',
        bitrateProfileId: 'fd_500k_2m',
        mockFpsPreset: null,
        listenOnly: true,
      });
    }

    currentState = {
      ...currentState,
      hasActiveWorkspace: false,
      currentName: 'No Project',
      currentFileStem: 'no-project',
      createdAt: new Date().toISOString(),
      updatedAt: null,
      notes: '',
      dirty: false,
      enabledToolpacks: [...DEFAULT_ENABLED_TOOLPACKS],
      cloudBinding: null,
    };
    emitChange();
  },

  setCloudBinding(
    binding: CloudProjectBindingV1 | null,
    quickBarState?: QuickBarConnectionState,
  ): void {
    currentState = {
      ...currentState,
      cloudBinding: binding,
    };
    emitChange();
    if (quickBarState && currentState.hasActiveWorkspace) {
      projectStore.scheduleAutoSave(quickBarState);
    }
  },
};

export function useProjectStore(): ProjectStoreState {
  return useSyncExternalStore(
    projectStore.subscribe,
    projectStore.getState,
    projectStore.getState,
  );
}
