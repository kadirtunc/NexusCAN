'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Cpu,
  Database,
  Download,
  FolderGit2,
  Gauge,
  Layers,
  Lock,
  Pause,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  Upload,
  WifiOff,
  Wrench,
  X,
} from 'lucide-react';
import type { DatabaseSchemaDto, SignalSchemaDto } from '../../types/netdb';
import type { FrameTelemetryDto, LiveSignalDto } from '../../types/telemetry';
import type {
  CloudProjectDto,
  DatabaseVersionDto,
  NetworkDatabaseSummaryDto,
  NexusSimulationPanelFileV1,
  SimulationGeneratorSpecDto,
  SimulationPanelDto,
  SimulationSignalBindingDto,
  SimulationWidgetDto,
  SimulationWidgetKind,
} from '../../types/simulation';
import {
  databaseStore,
  makeCatalogDbId,
  useDatabaseStore,
} from '../../store/databaseStore';
import { useConnectionStore } from '../../store/connectionStore';
import { projectStore, useProjectStore } from '../../store/projectStore';
import {
  simulationPanelStore,
  useSimulationPanelStore,
} from '../../store/simulationPanelStore';
import { useWorkbenchStore } from '../../store/workbenchStore';
import {
  cloudBridgeStore,
  useCloudBridgeStore,
} from '../../store/cloudBridgeStore';
import { telemetryStore, useTelemetryHeader } from '../../store/telemetryStore';
import {
  apiParseDatabaseSchema,
  apiTransmitSignalFrame,
} from '../../services/ipcClient';
import { fileToBase64 } from '../../utils/formatters';
import { useI18n } from '../../i18n';
import {
  SimulationGenerateFromDbcModal,
  type GenerateFromDbcConfirmPayload,
} from './SimulationGenerateFromDbcModal';
import { SimulationInspectorSidebar } from './SimulationInspectorSidebar';
import { SimulationPaletteSidebar } from './SimulationPaletteSidebar';
import { SimulationPanelListView } from './SimulationPanelListView';
import {
  SimulationWidgetBody,
  type SimulationTelemetrySource,
} from './SimulationWidgets';
import { SimulationRuntimeBus } from './simulationRuntimeBus';
import { InstrumentCanvasGrid } from './InstrumentCanvasGrid';
import {
  planWidgetCopyLayout,
  useInstrumentGridDrag,
  useInstrumentGridDrop,
  useInstrumentGridKeyboard,
  useRunModeButtonHotkeys,
} from './instrumentGridInteractions';
import { buildLocalCatalogEntries, makeDatabaseEntry } from './desktopDbEntries';
import { VirtualCanFrameInspector } from './VirtualCanFrameInspector';
import {
  ACCENT_HEX_MAP,
  TRACE_PALETTE,
  collectPanelBindings,
  createClientUid,
  createDefaultWidget,
  enumTableToComboOptions,
  findContainingGroup,
  findGnssSiblingsInMessage,
  inferBusIdFromAssignment,
  isLongitudeSignalName,
  mergeDatabaseSchemas,
  placeWidgetInsideGroup,
  signalSchemaToBinding,
  type LoadedSimulationDatabaseEntry,
  type PaletteDragPayload,
  type SignalBindingDbMeta,
  type SignalBoundContextInput,
} from './virtualCanPacking';

function serializePanelSnapshot(panel: SimulationPanelDto): string {
  return JSON.stringify({
    name: panel.name,
    description: panel.description,
    gridCols: panel.gridCols,
    rowHeightPx: panel.rowHeightPx,
    targetDatabaseId: panel.targetDatabaseId,
    widgets: panel.widgets,
    generators: panel.generators,
  });
}

function slugifyFileName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-|-$/g, '') || 'panel'
  );
}

function syncPanelQueryInUrl(
  panelId: string | null,
  mode: 'design' | 'run',
  push: boolean
): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (panelId) {
    url.searchParams.set('panel', panelId);
    if (mode === 'run') {
      url.searchParams.set('mode', 'run');
    } else {
      url.searchParams.delete('mode');
    }
  } else {
    url.searchParams.delete('panel');
    url.searchParams.delete('mode');
  }
  const nextHref = `${url.pathname}${url.search}${url.hash}`;
  if (push) {
    window.history.pushState(null, '', nextHref);
  } else {
    window.history.replaceState(null, '', nextHref);
  }
}

export interface SimulationWorkbenchViewProps {
  projectId?: string;
  allowProjectSwitch?: boolean;
  cloudProjectContext?: {
    project: CloudProjectDto;
    panels: SimulationPanelDto[];
    schema: DatabaseSchemaDto | null;
    /** Explicit multi-DBC catalog of the Cloud project (no hidden "active" database). */
    databases?: readonly LoadedSimulationDatabaseEntry[];
    loadingDatabases?: boolean;
    syncNonce?: number;
    onSyncFromCloud?: () => void | Promise<void>;
    syncingFromCloud?: boolean;
    onSavePanel: (panel: SimulationPanelDto) => Promise<void>;
    onCreatePanel: (panel: SimulationPanelDto) => Promise<void>;
    onRequestRenamePanel: (panel: SimulationPanelDto, newName: string) => Promise<void>;
    onDeletePanel: (panelId: string) => Promise<void>;
    onPullPanelToLocal?: (panel: SimulationPanelDto) => void;
  };
  onNavigateToTab?: (tab: string) => void;
  onBack?: () => void;
}

export function SimulationWorkbenchView({
  projectId,
  allowProjectSwitch = false,
  cloudProjectContext,
  onNavigateToTab,
  onBack,
}: SimulationWorkbenchViewProps): React.JSX.Element {
  const { t } = useI18n();
  const projState = useProjectStore();
  const cloudState = useCloudBridgeStore();
  const telemetryHeader = useTelemetryHeader();
  const simStoreState = useSimulationPanelStore();
  const workbench = useWorkbenchStore();
  const workbenchSelection = workbench.selection;
  const dbcFileInputRef = useRef<HTMLInputElement | null>(null);

  const connectedBuses = useMemo(
    () => telemetryHeader.buses.filter((b) => b.connected),
    [telemetryHeader.buses]
  );
  const isLiveBusArmed = useMemo(() => {
    if (telemetryHeader.txPanicLatched) return false;
    return connectedBuses.some((b) => !b.listenOnly && b.txArmed);
  }, [connectedBuses, telemetryHeader.txPanicLatched]);

  const resolvedProject = useMemo<CloudProjectDto>(() => {
    if (cloudProjectContext) return cloudProjectContext.project;
    const cb = projState.cloudBinding;
    return {
      id: projectId ?? cb?.projectId ?? 'desktop',
      orgId: cb?.orgId ?? 'local',
      name: projState.currentName || projState.currentFileStem || t('simWb.localWorkspace'),
      slug: cb?.projectSlug ?? 'desktop',
      code: cb?.projectCode ?? 'CAN',
      description: projState.notes || '',
      vehiclePlatform: 'Desktop HAL',
      defaultProtocol: 'CAN_FD',
      databaseCount: 1,
      activeVersionLabel: 'v1.0',
      sessionCount: 1,
      onlineDeviceCount: 1,
      updatedAt: new Date().toISOString(),
    };
  }, [cloudProjectContext, projectId, projState.cloudBinding, projState.currentName, projState.currentFileStem, projState.notes]);

  const projects = useMemo<readonly CloudProjectDto[]>(() => {
    if (cloudState.projects.length > 0) {
      return cloudState.projects.map((p) => ({
        id: p.id,
        orgId: p.orgId,
        name: p.name,
        slug: p.slug,
        code: p.code,
        description: p.description ?? '',
        vehiclePlatform: p.vehiclePlatform ?? 'Desktop HAL',
        defaultProtocol: (p.defaultProtocol as 'CAN' | 'CAN_FD' | 'J1939') ?? 'CAN_FD',
        databaseCount: 1,
        activeVersionLabel: 'v1.0',
        sessionCount: 1,
        onlineDeviceCount: 1,
        updatedAt: p.updatedAt ?? new Date().toISOString(),
      }));
    }
    return [resolvedProject];
  }, [cloudState.projects, resolvedProject]);

  const effectiveProjectId = resolvedProject.id;
  const canMutate = true;

  // 2-Step View State: 'list' (default) -> 'workbench' (when user clicks a panel or ?panel=<id> is set)
  const [viewState, setViewState] = useState<'list' | 'workbench'>('list');
  const pendingUrlNavRef = useRef<{
    panelId: string;
    mode: 'design' | 'run';
  } | null>(null);
  const didReadInitialUrlRef = useRef<boolean>(false);
  if (!didReadInitialUrlRef.current && typeof window !== 'undefined') {
    didReadInitialUrlRef.current = true;
    const sp = new URLSearchParams(window.location.search);
    const initialPanelId = sp.get('panel');
    if (initialPanelId && initialPanelId.trim().length > 0) {
      pendingUrlNavRef.current = {
        panelId: initialPanelId.trim(),
        mode: sp.get('mode') === 'run' ? 'run' : 'design',
      };
    }
  }

  // Panels & Dirty Tracking
  const [panels, setPanels] = useState<SimulationPanelDto[]>([]);
  const [activePanelId, setActivePanelId] = useState<string>('');
  const [savedSnapshotsById, setSavedSnapshotsById] = useState<
    Record<string, string>
  >({});
  const [loadingPanels, setLoadingPanels] = useState<boolean>(true);
  const [savingPanel, setSavingPanel] = useState<boolean>(false);
  const [savedToast, setSavedToast] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Project Databases & Loaded Schema for Smart Signal Picker
  // Multi-DBC catalog: every project database is loaded simultaneously (no "active DBC")
  const dbCatalog = useDatabaseStore().databases;
  const connProfiles = useConnectionStore().profiles;
  const [loadedDbEntries, setLoadedDbEntries] = useState<LoadedSimulationDatabaseEntry[]>([]);
  const databases = useMemo<NetworkDatabaseSummaryDto[]>(
    () => loadedDbEntries.map((e) => e.db),
    [loadedDbEntries]
  );
  const versionsByDbId = useMemo<Record<string, DatabaseVersionDto[]>>(() => {
    const map: Record<string, DatabaseVersionDto[]> = {};
    for (const e of loadedDbEntries) map[e.db.id] = [e.version];
    return map;
  }, [loadedDbEntries]);
  const selectedVersionByDbId = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const e of loadedDbEntries) map[e.db.id] = e.version.id;
    return map;
  }, [loadedDbEntries]);
  const [selectedDatabaseFilter, setSelectedDatabaseFilter] = useState<string>('ALL');
  const loadingSchema = Boolean(cloudProjectContext?.loadingDatabases);
  // Merged schema across all catalog databases (virtual packing & signal resolution)
  const loadedSchema = useMemo<DatabaseSchemaDto | null>(
    () => mergeDatabaseSchemas(loadedDbEntries),
    [loadedDbEntries]
  );
  const [generateModalState, setGenerateModalState] = useState<{
    open: boolean;
    mode: 'create_new' | 'populate_current';
  }>({ open: false, mode: 'create_new' });

  // Workbench Mode & Selection
  const [workbenchMode, setWorkbenchMode] = useState<'design' | 'run'>(
    'design'
  );
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null);
  const [suppressAutoGroupTarget, setSuppressAutoGroupTarget] =
    useState<boolean>(false);
  const [telemetrySource, setTelemetrySource] =
    useState<SimulationTelemetrySource>('virtual');
  const [simPaused, setSimPaused] = useState<boolean>(false);
  const [inspectorDockOpen, setInspectorDockOpen] = useState<boolean>(true);
  const [measuredFps, setMeasuredFps] = useState<number>(60);

  const canSyncFromCloud = Boolean(
    cloudProjectContext?.onSyncFromCloud ||
    (projState.cloudBinding?.projectId && cloudState.sessionToken)
  );

  const [localSyncing, setLocalSyncing] = useState<boolean>(false);
  const isSyncingFromCloud = cloudProjectContext?.syncingFromCloud ?? localSyncing;

  const handleTriggerSyncFromCloud = useCallback(async () => {
    if (isSyncingFromCloud) return;
    if (cloudProjectContext?.onSyncFromCloud) {
      await cloudProjectContext.onSyncFromCloud();
      return;
    }
    const targetProjId = projState.cloudBinding?.projectId;
    if (targetProjId && cloudState.sessionToken) {
      setLocalSyncing(true);
      try {
        const fetched = await cloudBridgeStore.fetchCloudPanels(targetProjId);
        for (const p of fetched) {
          simulationPanelStore.upsertPanelFromCloud(p);
        }
        setPanels([...simulationPanelStore.getState().panels]);
      } catch (err) {
        console.warn('[SimulationWorkbench] fetchCloudPanels failed:', err);
      } finally {
        setLocalSyncing(false);
      }
    }
  }, [cloudProjectContext, cloudState.sessionToken, isSyncingFromCloud, projState.cloudBinding?.projectId]);

  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;

  // Panel CRUD Modals (Create / Rename / Delete)
  const [panelModalMode, setPanelModalMode] = useState<
    'none' | 'create' | 'rename' | 'delete'
  >('none');
  const [modalTargetPanelId, setModalTargetPanelId] = useState<string | null>(
    null
  );
  const [enterAfterCreate, setEnterAfterCreate] = useState<boolean>(true);
  const [panelNameInput, setPanelNameInput] = useState<string>('');
  const [panelDescInput, setPanelDescInput] = useState<string>('');

  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const runtimeBusRef = useRef<SimulationRuntimeBus | null>(null);
  if (runtimeBusRef.current === null) {
    runtimeBusRef.current = new SimulationRuntimeBus();
  }
  const runtimeBus = runtimeBusRef.current;

  const activePanel = useMemo(
    () => panels.find((p) => p.id === activePanelId) ?? null,
    [activePanelId, panels]
  );

  const modalTargetPanel = useMemo(
    () =>
      panels.find((p) => p.id === (modalTargetPanelId ?? activePanelId)) ??
      activePanel,
    [activePanel, activePanelId, modalTargetPanelId, panels]
  );

  const selectedWidget = useMemo(
    () =>
      activePanel?.widgets.find((w) => w.id === selectedWidgetId) ?? null,
    [activePanel, selectedWidgetId]
  );

  useEffect(() => {
    setSuppressAutoGroupTarget(false);
  }, [selectedWidgetId]);

  const activeTargetGroup = useMemo<SimulationWidgetDto | null>(() => {
    if (!activePanel || !selectedWidget || suppressAutoGroupTarget) {
      return null;
    }
    if (selectedWidget.kind === 'group') {
      return selectedWidget;
    }
    return findContainingGroup(selectedWidget.layout, activePanel.widgets);
  }, [activePanel, selectedWidget, suppressAutoGroupTarget]);

  const dirtyById = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const p of panels) {
      const saved = savedSnapshotsById[p.id];
      map[p.id] = !saved || serializePanelSnapshot(p) !== saved;
    }
    return map;
  }, [panels, savedSnapshotsById]);

  const isActivePanelDirty = activePanel
    ? Boolean(dirtyById[activePanel.id])
    : false;

  const allActiveBindings = useMemo(
    () =>
      activePanel
        ? collectPanelBindings(activePanel.widgets, activePanel.generators)
        : [],
    [activePanel]
  );

  // Sync browser Back / Forward (?panel=<id>&mode=run) with viewState
  useEffect(() => {
    const onPopState = () => {
      const sp = new URLSearchParams(window.location.search);
      const pid = sp.get('panel');
      const pmode = sp.get('mode') === 'run' ? 'run' : 'design';
      if (pid && panels.some((p) => p.id === pid)) {
        setActivePanelId(pid);
        setSelectedWidgetId(null);
        setSimPaused(false);
        setWorkbenchMode(pmode);
        setViewState('workbench');
      } else {
        setViewState('list');
        setSelectedWidgetId(null);
        setWorkbenchMode('design');
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [panels]);

  const handleEnterPanel = useCallback(
    (panelId: string, mode: 'design' | 'run') => {
      const target = panels.find((p) => p.id === panelId);
      if (!target) return;
      setActivePanelId(panelId);
      setSelectedWidgetId(null);
      setSimPaused(false);
      setWorkbenchMode(mode);
      setViewState('workbench');
      syncPanelQueryInUrl(panelId, mode, true);
      runtimeBus.ensureSeededBindings(
        collectPanelBindings(target.widgets, target.generators),
        loadedSchema
      );
    },
    [loadedSchema, panels, runtimeBus]
  );

  const handleReturnToPanelList = useCallback(() => {
    setViewState('list');
    setSelectedWidgetId(null);
    setSimPaused(false);
    setWorkbenchMode('design');
    syncPanelQueryInUrl(null, 'design', true);
  }, []);

  const handleSelectProjectSlug = useCallback(
    (nextSlug: string) => {
      const nextProj = projects.find((p) => p.slug === nextSlug);
      if (!nextProj) return;
      pendingUrlNavRef.current = null;
      setViewState('list');
      setSelectedWidgetId(null);
      setWorkbenchMode('design');
      syncPanelQueryInUrl(null, 'design', false);
    },
    [projects]
  );

  const syncNonce = cloudProjectContext?.syncNonce;
  const contextPanels = cloudProjectContext?.panels;
  const contextSchema = cloudProjectContext?.schema;

  useEffect(() => {
    let cancelled = false;
    setLoadingPanels(true);
    setErrorBanner(null);

    const loadPanelsAndDatabases = async () => {
      let loadedPanels: SimulationPanelDto[] = [];

      if (cloudProjectContext) {
        loadedPanels = [...(contextPanels ?? [])];
      } else {
        loadedPanels = [...simStoreState.panels];
      }

      if (cancelled) return;

      const snaps: Record<string, string> = {};
      for (const p of loadedPanels) {
        snaps[p.id] = serializePanelSnapshot(p);
      }
      setPanels(loadedPanels);
      setSavedSnapshotsById(snaps);

      const pendingNav = pendingUrlNavRef.current;
      if (pendingNav) {
        pendingUrlNavRef.current = null;
        if (loadedPanels.some((p) => p.id === pendingNav.panelId)) {
          setActivePanelId(pendingNav.panelId);
          setWorkbenchMode(pendingNav.mode);
          setViewState('workbench');
        } else {
          setActivePanelId(loadedPanels[0]?.id ?? '');
          setViewState('list');
          syncPanelQueryInUrl(null, 'design', false);
        }
      } else {
        setActivePanelId((prev) =>
          loadedPanels.some((p) => p.id === prev)
            ? prev
            : (loadedPanels[0]?.id ?? '')
        );
      }

      if (viewStateRef.current === 'list') {
        setSelectedWidgetId(null);
      }

      setLoadingPanels(false);
    };

    void loadPanelsAndDatabases();

    return () => {
      cancelled = true;
    };
  }, [
    cloudProjectContext,
    contextPanels,
    effectiveProjectId,
    simStoreState.configRev,
    simStoreState.panels,
    syncNonce,
  ]);

  // Activate panel immediately if ProjectExplorerDock selection points to a simulation panel
  useEffect(() => {
    if (cloudProjectContext) return;
    if (workbenchSelection.kind === 'panel' && workbenchSelection.panelId) {
      const targetId = workbenchSelection.panelId;
      const exists =
        panels.some((p) => p.id === targetId) ||
        simStoreState.panels.some((p) => p.id === targetId);
      if (exists) {
        setActivePanelId(targetId);
        setSelectedWidgetId(null);
        setSimPaused(false);
        setWorkbenchMode('design');
        setViewState('workbench');
        syncPanelQueryInUrl(targetId, 'design', true);
      }
    }
  }, [cloudProjectContext, workbenchSelection, panels, simStoreState.panels]);

  // Database catalog entries (Cloud project catalog OR desktop catalog + per-connection bus binding)
  const contextDbEntries = cloudProjectContext?.databases;
  const isCloudContext = Boolean(cloudProjectContext);
  useEffect(() => {
    let entries: LoadedSimulationDatabaseEntry[];
    if (isCloudContext) {
      if (contextDbEntries) {
        entries = [...contextDbEntries];
      } else if (contextSchema) {
        entries = [
          makeDatabaseEntry({
            id: 'cloud-workspace-db',
            name: contextSchema.info.name || 'Cloud Workspace DB',
            fileName: contextSchema.info.name || 'workspace.dbc',
            schema: contextSchema,
            busId: 0,
            busLabel: 'CAN0',
          }),
        ];
      } else {
        entries = [];
      }
    } else {
      entries = buildLocalCatalogEntries(dbCatalog, connProfiles);
    }
    setLoadedDbEntries(entries);
    setSelectedDatabaseFilter((prev) =>
      prev === 'ALL' || entries.some((e) => e.db.id === prev) ? prev : 'ALL'
    );
  }, [connProfiles, contextDbEntries, contextSchema, dbCatalog, isCloudContext]);

  // Desktop catalog keeps one compiled version per database; version switching is a no-op here
  const handleSelectDatabaseVersion = useCallback((_dbId: string, _verId: string) => {
    // Intentionally empty: Cloud version history lives in NexusCANCloud
  }, []);

  const handleLiveTransmitSignal = useCallback(
    (binding: SimulationSignalBindingDto, value: number, txCycleMs?: number) => {
      if (!isLiveBusArmed || telemetryHeader.txPanicLatched) return;
      const requestedBusId = binding.busId ?? 0;
      const exactBus = connectedBuses.find((b) => b.busId === requestedBusId);
      const targetBus =
        exactBus ??
        connectedBuses.find((b) => !b.listenOnly && b.txArmed) ??
        null;
      if (!targetBus || targetBus.listenOnly || !targetBus.txArmed) {
        return;
      }

      const schema = databaseStore.getBusSchema(targetBus.busId) ?? loadedSchema;
      const sigId = schema?.signals.find(
        (s) => s.messageKey === binding.messageKey && s.name === binding.signalName
      )?.signalId;
      if (sigId === undefined) return;

      void apiTransmitSignalFrame({
        busId: targetBus.busId,
        arbId: binding.arbId,
        isExtended: binding.isExtended,
        signalValues: [[sigId, value]],
        periodicMs: txCycleMs && txCycleMs > 0 ? txCycleMs : null,
        jobLabel: `SimPanel::${binding.signalName}`,
      }).catch((err) => {
        console.warn('[SimulationWorkbench] Live TX failed:', err);
      });
    },
    [connectedBuses, isLiveBusArmed, loadedSchema, telemetryHeader.txPanicLatched]
  );

  // Seed runtimeBus whenever active panel or loaded schema changes in workbench
  useEffect(() => {
    if (viewState !== 'workbench') return;
    runtimeBus.ensureSeededBindings(allActiveBindings, loadedSchema);
  }, [allActiveBindings, loadedSchema, runtimeBus, viewState]);

  // 2. 60 FPS requestAnimationFrame Engine in RUN Mode (Workbench Only)
  const activeGenerators = activePanel?.generators ?? [];
  useEffect(() => {
    if (viewState !== 'workbench' || workbenchMode !== 'run' || !activePanel) {
      return;
    }

    let rafId = 0;
    let startEpochMs = performance.now() - runtimeBus.getElapsedSec() * 1000;
    let fpsFrames = 0;
    let fpsWindowStart = performance.now();

    const step = (nowMs: number) => {
      fpsFrames += 1;
      if (nowMs - fpsWindowStart >= 1000) {
        const fps = Math.min(
          60,
          Math.max(1, Math.round((fpsFrames * 1000) / (nowMs - fpsWindowStart)))
        );
        setMeasuredFps(fps);
        fpsFrames = 0;
        fpsWindowStart = nowMs;
      }

      if (!simPaused) {
        const tSec = Math.max(0, (nowMs - startEpochMs) / 1000);
        if (telemetrySource === 'virtual') {
          runtimeBus.tickVirtual(
            tSec,
            allActiveBindings,
            activeGenerators,
            loadedSchema
          );
        } else {
          const slice = telemetryStore.getFramesSlice();
          const frameByKey: Record<string, FrameTelemetryDto> = {};
          const frameTimestampByComposite: Record<number, number> = {};
          const liveSignalById: Record<number, LiveSignalDto> = {};
          const schemaSignalById: Record<number, SignalSchemaDto> = {};
          // Backend signalIds are per-bus: compose (busId, signalId) into one unique key space
          for (const f of slice.frames) {
            const prevFrame = frameByKey[f.messageKey];
            if (!prevFrame || f.lastTimestampUs >= prevFrame.lastTimestampUs) {
              frameByKey[f.messageKey] = f;
            }
            const busSignals = databaseStore.getBusSignals(f.busId);
            for (const s of f.signals) {
              const meta = busSignals[s.signalId];
              if (!meta) continue;
              const composite = f.busId * 1_000_000 + s.signalId;
              const prevTs = frameTimestampByComposite[composite];
              if (prevTs === undefined || f.lastTimestampUs >= prevTs) {
                frameTimestampByComposite[composite] = f.lastTimestampUs;
                liveSignalById[composite] = s;
                schemaSignalById[composite] = meta;
              }
            }
          }
          const effectiveLiveSchema = loadedSchema;
          runtimeBus.tickFromLiveBridge(
            tSec,
            frameByKey,
            liveSignalById,
            schemaSignalById,
            effectiveLiveSchema,
            allActiveBindings
          );
        }
      } else {
        startEpochMs = nowMs - runtimeBus.getElapsedSec() * 1000;
      }

      rafId = window.requestAnimationFrame(step);
    };

    rafId = window.requestAnimationFrame(step);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [
    activeGenerators,
    activePanel,
    allActiveBindings,
    loadedSchema,
    runtimeBus,
    simPaused,
    telemetrySource,
    viewState,
    workbenchMode,
  ]);

  // 3. Mutate Local Active Panel State
  const mutateActivePanel = useCallback(
    (updater: (prev: SimulationPanelDto) => SimulationPanelDto) => {
      if (!activePanelId || !canMutate) return;
      setPanels((prev) =>
        prev.map((p) =>
          p.id === activePanelId
            ? { ...updater(p), updatedAt: new Date().toISOString() }
            : p
        )
      );
    },
    [activePanelId, canMutate]
  );

  // 4. Save Active Panel (Toolbar Button & Ctrl+S / Cmd+S)
  const handleSaveActivePanel = useCallback(async () => {
    if (!activePanel || savingPanel) {
      return;
    }
    setSavingPanel(true);
    setErrorBanner(null);
    try {
      if (cloudProjectContext) {
        await cloudProjectContext.onSavePanel(activePanel);
      } else {
        simulationPanelStore.upsertPanelFromCloud(activePanel);
        projectStore.scheduleAutoSave();
        const cb = projectStore.getState().cloudBinding;
        if (cb?.projectId) {
          void cloudBridgeStore
            .updateCloudPanel(activePanel.id, activePanel, cb.projectId)
            .catch(() => undefined);
        }
      }
      const snap = serializePanelSnapshot(activePanel);
      setPanels((prev) =>
        prev.map((p) => (p.id === activePanel.id ? activePanel : p))
      );
      setSavedSnapshotsById((prev) => ({ ...prev, [activePanel.id]: snap }));
      setSavedToast(true);
      window.setTimeout(() => setSavedToast(false), 2200);
    } catch (err: unknown) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Panel kaydedilemedi.'
      );
    } finally {
      setSavingPanel(false);
    }
  }, [activePanel, cloudProjectContext, savingPanel]);

  // Shared instrument-grid interactions (Ctrl+S / Delete / arrows, drag-move & resize, RUN hotkeys)
  const clearSelectedWidget = useCallback(() => setSelectedWidgetId(null), []);
  const saveActivePanelFromShortcut = useCallback(() => {
    void handleSaveActivePanel();
  }, [handleSaveActivePanel]);
  const { dragStateRef, dragHoverGroupId, setDragHoverGroupId } =
    useInstrumentGridDrag<SimulationWidgetDto, SimulationPanelDto>({
      panel: activePanel,
      containerRef: gridContainerRef,
      mutatePanel: mutateActivePanel,
    });

  useInstrumentGridKeyboard<SimulationWidgetDto, SimulationPanelDto>({
    enabled: viewState === 'workbench',
    isDesignMode: workbenchMode === 'design',
    canMutate,
    selectedWidgetId,
    mutatePanel: mutateActivePanel,
    onClearSelection: clearSelectedWidget,
    onSave: saveActivePanelFromShortcut,
  });

  useRunModeButtonHotkeys({
    enabled:
      viewState === 'workbench' &&
      workbenchMode === 'run' &&
      !simPaused &&
      activePanel !== null &&
      !(telemetrySource === 'live_bridge' && !isLiveBusArmed),
    widgets: activePanel?.widgets ?? [],
    runtimeBus,
  });

  // 6. Panel CRUD Handlers
  const handleCreateBlankOrStarterPanel = async (
    customName?: string,
    customDesc?: string,
    fromDbcStarter = false,
    openAfterCreate = true,
    preset?: {
      widgets: SimulationWidgetDto[];
      generators: SimulationGeneratorSpecDto[];
      targetDatabaseId: string | null;
    }
  ) => {
    if (fromDbcStarter && !preset) {
      // Never guess a database: the user explicitly picks DBC(s) + messages in the modal
      setPanelModalMode('none');
      setModalTargetPanelId(null);
      setGenerateModalState({ open: true, mode: 'create_new' });
      return;
    }
    setSavingPanel(true);
    setErrorBanner(null);
    try {
      const starter = preset
        ? { widgets: preset.widgets, generators: preset.generators }
        : { widgets: [] as SimulationWidgetDto[], generators: [] as SimulationGeneratorSpecDto[] };

      const defaultName =
        customName?.trim() || `Instrument Panel ${panels.length + 1}`;

      const newPanel: SimulationPanelDto = {
        id: createClientUid('pan'),
        name: defaultName,
        description: customDesc?.trim() ?? '',
        gridCols: 24,
        rowHeightPx: 42,
        targetDatabaseId:
          preset?.targetDatabaseId ??
          (selectedDatabaseFilter !== 'ALL' ? selectedDatabaseFilter : null),
        widgets: starter.widgets,
        generators: starter.generators,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      if (cloudProjectContext) {
        await cloudProjectContext.onCreatePanel(newPanel);
      } else {
        simulationPanelStore.upsertPanelFromCloud(newPanel);
        projectStore.scheduleAutoSave();
        const cb = projectStore.getState().cloudBinding;
        if (cb?.projectId) {
          void cloudBridgeStore
            .createCloudPanel(newPanel, cb.projectId)
            .catch(() => undefined);
        }
      }

      const snap = serializePanelSnapshot(newPanel);
      setPanels((prev) => [...prev, newPanel]);
      setSavedSnapshotsById((prev) => ({ ...prev, [newPanel.id]: snap }));
      setActivePanelId(newPanel.id);
      setSelectedWidgetId(newPanel.widgets[0]?.id ?? null);
      setPanelModalMode('none');
      setModalTargetPanelId(null);
      runtimeBus.reset(
        collectPanelBindings(newPanel.widgets, newPanel.generators),
        loadedSchema
      );

      if (openAfterCreate) {
        setSimPaused(false);
        setWorkbenchMode('design');
        setViewState('workbench');
        syncPanelQueryInUrl(newPanel.id, 'design', true);
      }
    } catch (err: unknown) {
      setErrorBanner(
        err instanceof Error ? err.message : t('simWb.errCreatePanel')
      );
    } finally {
      setSavingPanel(false);
    }
  };

  const handleConfirmGenerateFromDbc = (payload: GenerateFromDbcConfirmPayload) => {
    if (generateModalState.mode === 'populate_current' && activePanel) {
      mutateActivePanel((p) => ({
        ...p,
        widgets: payload.widgets,
        generators: payload.generators,
        targetDatabaseId: payload.targetDatabaseId ?? p.targetDatabaseId,
      }));
      setSelectedWidgetId(payload.widgets[0]?.id ?? null);
      runtimeBus.reset(
        collectPanelBindings(payload.widgets, payload.generators),
        loadedSchema
      );
      setGenerateModalState({ open: false, mode: 'create_new' });
      return;
    }
    setGenerateModalState({ open: false, mode: 'create_new' });
    void handleCreateBlankOrStarterPanel(payload.name, payload.description, true, true, {
      widgets: payload.widgets,
      generators: payload.generators,
      targetDatabaseId: payload.targetDatabaseId,
    });
  };

  const handleRenameTargetPanel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalTargetPanel || !panelNameInput.trim()) {
      return;
    }
    setSavingPanel(true);
    setErrorBanner(null);
    try {
      const updated: SimulationPanelDto = {
        ...modalTargetPanel,
        name: panelNameInput.trim(),
        description: panelDescInput.trim(),
        updatedAt: new Date().toISOString(),
      };
      if (cloudProjectContext) {
        await cloudProjectContext.onRequestRenamePanel(
          modalTargetPanel,
          panelNameInput.trim()
        );
      } else {
        simulationPanelStore.renamePanel(
          modalTargetPanel.id,
          panelNameInput.trim(),
          panelDescInput.trim()
        );
        projectStore.scheduleAutoSave();
        const cb = projectStore.getState().cloudBinding;
        if (cb?.projectId) {
          void cloudBridgeStore
            .updateCloudPanel(modalTargetPanel.id, updated, cb.projectId)
            .catch(() => undefined);
        }
      }
      const snap = serializePanelSnapshot(updated);
      setPanels((prev) =>
        prev.map((p) => (p.id === updated.id ? updated : p))
      );
      setSavedSnapshotsById((prev) => ({ ...prev, [updated.id]: snap }));
      setPanelModalMode('none');
      setModalTargetPanelId(null);
    } catch (err: unknown) {
      setErrorBanner(
        err instanceof Error ? err.message : t('simWb.errRenamePanel')
      );
    } finally {
      setSavingPanel(false);
    }
  };

  const handleDeleteTargetPanel = async () => {
    if (!modalTargetPanel) return;
    setSavingPanel(true);
    setErrorBanner(null);
    try {
      const deletingId = modalTargetPanel.id;
      if (cloudProjectContext) {
        await cloudProjectContext.onDeletePanel(deletingId);
      } else {
        simulationPanelStore.deletePanel(deletingId);
        projectStore.scheduleAutoSave();
        const cb = projectStore.getState().cloudBinding;
        if (cb?.projectId) {
          void cloudBridgeStore
            .deleteCloudPanel(deletingId, cb.projectId)
            .catch(() => undefined);
        }
      }
      const remaining = panels.filter((p) => p.id !== deletingId);
      setPanels(remaining);
      if (deletingId === activePanelId) {
        setActivePanelId(remaining[0]?.id ?? '');
        setSelectedWidgetId(null);
        if (viewState === 'workbench') {
          setViewState('list');
          setWorkbenchMode('design');
          syncPanelQueryInUrl(null, 'design', false);
        }
      }
      setPanelModalMode('none');
      setModalTargetPanelId(null);
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : t('simWb.errDeletePanel'));
    } finally {
      setSavingPanel(false);
    }
  };

  // 7. .nexuspanel.json Export & Import
  const handleExportPanelJson = useCallback(
    (panelToExport: SimulationPanelDto) => {
      const envelope: NexusSimulationPanelFileV1 = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        panel: panelToExport,
      };
      const blob = new Blob([JSON.stringify(envelope, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slugifyFileName(panelToExport.name)}.nexuspanel.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    []
  );

  const handleImportNexusPanelFile = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setErrorBanner(null);
    try {
      const rawText = await file.text();
      const parsedJson: unknown = JSON.parse(rawText);
      let importedPanel: SimulationPanelDto;

      if (
        parsedJson &&
        typeof parsedJson === 'object' &&
        'schemaVersion' in parsedJson &&
        (parsedJson as { schemaVersion: unknown }).schemaVersion === 1 &&
        'panel' in parsedJson &&
        (parsedJson as { panel: unknown }).panel &&
        typeof (parsedJson as { panel: unknown }).panel === 'object'
      ) {
        importedPanel = (parsedJson as NexusSimulationPanelFileV1).panel;
      } else if (
        parsedJson &&
        typeof parsedJson === 'object' &&
        'widgets' in parsedJson &&
        Array.isArray((parsedJson as { widgets: unknown }).widgets)
      ) {
        importedPanel = parsedJson as SimulationPanelDto;
      } else {
        throw new Error(t('simWb.errInvalidJson'));
      }

      setSavingPanel(true);
      const newPanel: SimulationPanelDto = {
        id: createClientUid('pan'),
        name: importedPanel.name || 'Imported Panel',
        description: importedPanel.description || '',
        gridCols: importedPanel.gridCols || 24,
        rowHeightPx: importedPanel.rowHeightPx || 42,
        targetDatabaseId: importedPanel.targetDatabaseId ?? null,
        widgets: importedPanel.widgets || [],
        generators: importedPanel.generators || [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      if (cloudProjectContext) {
        await cloudProjectContext.onCreatePanel(newPanel);
      } else {
        simulationPanelStore.upsertPanelFromCloud(newPanel);
        projectStore.scheduleAutoSave();
      }

      const snap = serializePanelSnapshot(newPanel);
      setPanels((prev) => [...prev, newPanel]);
      setSavedSnapshotsById((prev) => ({ ...prev, [newPanel.id]: snap }));
      setActivePanelId(newPanel.id);
      setSelectedWidgetId(newPanel.widgets[0]?.id ?? null);
      setSimPaused(false);
      setWorkbenchMode('design');
      setViewState('workbench');
      syncPanelQueryInUrl(newPanel.id, 'design', true);
      runtimeBus.reset(
        collectPanelBindings(newPanel.widgets, newPanel.generators),
        loadedSchema
      );
    } catch (err: unknown) {
      setErrorBanner(
        err instanceof Error
          ? err.message
          : t('simWb.errImportFailed')
      );
    } finally {
      setSavingPanel(false);
    }
  };

  // 8. Multi-DBC Widget Manipulation & Group Container Helpers
  const handleAddWidgetToGroup = useCallback(
    (
      groupId: string,
      kind: SimulationWidgetKind,
      options?: {
        boundContext?: SignalBoundContextInput | null;
        preferredCell?: { col: number; row: number };
        selectCreated?: boolean;
      }
    ) => {
      if (!activePanel || !canMutate) return;
      const boundContext = options?.boundContext ?? null;
      const sourceEntry = boundContext?.db
        ? loadedDbEntries.find((e) => e.db.id === boundContext.db?.id)
        : null;
      const contextSchema = sourceEntry?.schema ?? loadedSchema;

      const baseWidget = createDefaultWidget(
        kind,
        activePanel.widgets,
        activePanel.gridCols,
        boundContext,
        contextSchema
      );

      const targetGroup =
        kind !== 'group'
          ? (activePanel.widgets.find(
              (w) => w.id === groupId && w.kind === 'group'
            ) ?? null)
          : null;

      if (!targetGroup) {
        mutateActivePanel((p) => ({
          ...p,
          widgets: [...p.widgets, baseWidget],
        }));
        setSelectedWidgetId(baseWidget.id);
        setSuppressAutoGroupTarget(false);
        return;
      }

      const { childLayout, updatedGroupLayout } = placeWidgetInsideGroup(
        targetGroup,
        activePanel.widgets,
        baseWidget.layout.w,
        baseWidget.layout.h,
        activePanel.gridCols,
        options?.preferredCell
      );

      const placedWidget: SimulationWidgetDto = {
        ...baseWidget,
        layout: childLayout,
      };

      mutateActivePanel((p) => ({
        ...p,
        widgets: [
          ...p.widgets.map((w) =>
            w.id === targetGroup.id ? { ...w, layout: updatedGroupLayout } : w
          ),
          placedWidget,
        ],
      }));

      if (options?.selectCreated !== false) {
        setSelectedWidgetId(placedWidget.id);
        setSuppressAutoGroupTarget(false);
      }
    },
    [activePanel, canMutate, loadedDbEntries, loadedSchema, mutateActivePanel]
  );

  const handleAddWidget = useCallback(
    (
      kind: SimulationWidgetKind,
      boundContext?: SignalBoundContextInput | null
    ) => {
      if (!activePanel || !canMutate) return;

      if (kind !== 'group' && activeTargetGroup) {
        handleAddWidgetToGroup(activeTargetGroup.id, kind, {
          boundContext,
          selectCreated: true,
        });
        return;
      }

      const sourceEntry = boundContext?.db
        ? loadedDbEntries.find((e) => e.db.id === boundContext.db?.id)
        : null;
      const contextSchema = sourceEntry?.schema ?? loadedSchema;

      const newWidget = createDefaultWidget(
        kind,
        activePanel.widgets,
        activePanel.gridCols,
        boundContext,
        contextSchema
      );
      mutateActivePanel((p) => ({
        ...p,
        widgets: [...p.widgets, newWidget],
      }));
      setSelectedWidgetId(newWidget.id);
      setSuppressAutoGroupTarget(false);
    },
    [
      activePanel,
      activeTargetGroup,
      canMutate,
      handleAddWidgetToGroup,
      loadedDbEntries,
      loadedSchema,
      mutateActivePanel,
    ]
  );

  const handleMoveWidgetIntoGroup = useCallback(
    (widgetId: string, groupId: string) => {
      if (!activePanel || !canMutate) return;
      mutateActivePanel((p) => {
        const moving = p.widgets.find(
          (w) => w.id === widgetId && w.kind !== 'group'
        );
        const targetGroup = p.widgets.find(
          (w) => w.id === groupId && w.kind === 'group'
        );
        if (!moving || !targetGroup) return p;

        const otherWidgets = p.widgets.filter((w) => w.id !== widgetId);
        const { childLayout, updatedGroupLayout } = placeWidgetInsideGroup(
          targetGroup,
          otherWidgets,
          moving.layout.w,
          moving.layout.h,
          p.gridCols
        );

        return {
          ...p,
          widgets: p.widgets.map((w) => {
            if (w.id === moving.id) {
              return { ...w, layout: childLayout };
            }
            if (w.id === targetGroup.id) {
              return { ...w, layout: updatedGroupLayout };
            }
            return w;
          }),
        };
      });
    },
    [activePanel, canMutate, mutateActivePanel]
  );

  const handleDropPayload = useCallback(
    (
      payload: PaletteDragPayload,
      cell: { col: number; row: number },
      hoveredGroupId: string | null
    ) => {
      if (!activePanel) return;
      if (hoveredGroupId && payload.kind !== 'group') {
        handleAddWidgetToGroup(hoveredGroupId, payload.kind, {
          boundContext: payload.boundContext,
          preferredCell: cell,
          selectCreated: true,
        });
        return;
      }

      const sourceEntry = payload.boundContext?.db
        ? loadedDbEntries.find((ent) => ent.db.id === payload.boundContext?.db?.id)
        : null;
      const contextSchema = sourceEntry?.schema ?? loadedSchema;

      const baseWidget = createDefaultWidget(
        payload.kind,
        activePanel.widgets,
        activePanel.gridCols,
        payload.boundContext,
        contextSchema
      );
      const dropCol = Math.max(
        0,
        Math.min(activePanel.gridCols - baseWidget.layout.w, cell.col)
      );
      const dropRow = Math.max(0, Math.min(399, cell.row));
      const droppedWidget: SimulationWidgetDto = {
        ...baseWidget,
        layout: {
          ...baseWidget.layout,
          col: dropCol,
          row: dropRow,
        },
      };

      mutateActivePanel((p) => ({
        ...p,
        widgets: [...p.widgets, droppedWidget],
      }));
      setSelectedWidgetId(droppedWidget.id);
      setSuppressAutoGroupTarget(false);
    },
    [
      activePanel,
      handleAddWidgetToGroup,
      loadedDbEntries,
      loadedSchema,
      mutateActivePanel,
    ]
  );

  const {
    handleDragOver: handleCanvasDragOver,
    handleDragLeave: handleCanvasDragLeave,
    handleDrop: handleCanvasDrop,
  } = useInstrumentGridDrop<SimulationWidgetDto, SimulationPanelDto>({
    containerRef: gridContainerRef,
    panel: activePanel,
    isDesignMode: workbenchMode === 'design',
    canMutate,
    setDragHoverGroupId,
    onDropPayload: handleDropPayload,
  });

  const handleBindSignalToSelected = useCallback(
    (ctx: SignalBoundContextInput) => {
      if (!selectedWidget || selectedWidget.kind === 'group' || !canMutate) {
        return;
      }
      const { msg, sig, db, busId } = ctx;
      const resolvedBusId =
        busId ??
        (db
          ? inferBusIdFromAssignment(db.busAssignment)
          : (selectedWidget.binding?.busId ?? 0));
      const dbMeta: SignalBindingDbMeta | undefined = db
        ? { databaseId: db.id, databaseName: db.name }
        : undefined;
      const sourceSchema =
        (db ? loadedDbEntries.find((e) => e.db.id === db.id)?.schema : undefined) ??
        loadedSchema;

      const nextBinding = signalSchemaToBinding(
        msg,
        sig,
        resolvedBusId,
        ACCENT_HEX_MAP[selectedWidget.accentColor],
        dbMeta
      );
      const enumOpts = enumTableToComboOptions(sig.enumTable);

      mutateActivePanel((p) => ({
        ...p,
        widgets: p.widgets.map((w) => {
          if (w.id !== selectedWidget.id) return w;
          const nextConfig = { ...w.config };

          if (w.kind === 'map') {
            if (isLongitudeSignalName(sig.name) && w.binding !== null) {
              nextConfig.lonBinding = {
                ...nextBinding,
                decimals: Math.max(nextBinding.decimals, 6),
                color: TRACE_PALETTE[1],
              };
              return { ...w, config: nextConfig };
            }

            const latBinding = {
              ...nextBinding,
              decimals: Math.max(nextBinding.decimals, 6),
            };
            if (sourceSchema) {
              const siblings = findGnssSiblingsInMessage(msg, sourceSchema);
              if (siblings.lon && !nextConfig.lonBinding) {
                const lonB = signalSchemaToBinding(
                  siblings.lon.msg,
                  siblings.lon.sig,
                  resolvedBusId,
                  TRACE_PALETTE[1],
                  dbMeta
                );
                nextConfig.lonBinding = {
                  ...lonB,
                  decimals: Math.max(lonB.decimals, 6),
                };
              }
              if (siblings.heading && !nextConfig.headingBinding) {
                nextConfig.headingBinding = signalSchemaToBinding(
                  siblings.heading.msg,
                  siblings.heading.sig,
                  resolvedBusId,
                  TRACE_PALETTE[2],
                  dbMeta
                );
              }
              if (siblings.speed && !nextConfig.speedBinding) {
                nextConfig.speedBinding = signalSchemaToBinding(
                  siblings.speed.msg,
                  siblings.speed.sig,
                  resolvedBusId,
                  TRACE_PALETTE[0],
                  dbMeta
                );
              }
            }
            return {
              ...w,
              title: `${msg.name} GNSS Map`,
              binding: latBinding,
              config: nextConfig,
            };
          }

          if (w.kind === 'gauge' || w.kind === 'bar' || w.kind === 'slider') {
            nextConfig.min = nextBinding.min;
            nextConfig.max = nextBinding.max;
          }
          if (Object.keys(sig.enumTable).length > 0) {
            nextConfig.enumMap = { ...sig.enumTable };
            if (enumOpts.length > 0) {
              nextConfig.options = enumOpts;
            }
          }
          return {
            ...w,
            title: sig.name,
            binding: nextBinding,
            config: nextConfig,
          };
        }),
      }));
    },
    [canMutate, loadedDbEntries, loadedSchema, mutateActivePanel, selectedWidget]
  );

  const handleUpdateWidget = useCallback(
    (
      widgetId: string,
      updater: (prev: SimulationWidgetDto) => SimulationWidgetDto
    ) => {
      mutateActivePanel((p) => ({
        ...p,
        widgets: p.widgets.map((w) => (w.id === widgetId ? updater(w) : w)),
      }));
    },
    [mutateActivePanel]
  );

  const handleDuplicateWidget = useCallback(
    (widgetId: string) => {
      if (!activePanel || !canMutate) return;
      const target = activePanel.widgets.find((w) => w.id === widgetId);
      if (!target) return;

      const { parentGroup, copyLayout, updatedGroupLayout } = planWidgetCopyLayout(
        target,
        activePanel.widgets,
        activePanel.gridCols
      );

      const copy: SimulationWidgetDto = {
        ...target,
        id: createClientUid(`w-${target.kind}`),
        title: `${target.title} (Copy)`,
        layout: copyLayout,
        binding: target.binding ? { ...target.binding } : null,
        config: {
          ...target.config,
          lonBinding: target.config.lonBinding
            ? { ...target.config.lonBinding }
            : target.config.lonBinding,
          headingBinding: target.config.headingBinding
            ? { ...target.config.headingBinding }
            : target.config.headingBinding,
          speedBinding: target.config.speedBinding
            ? { ...target.config.speedBinding }
            : target.config.speedBinding,
          extraBindings: target.config.extraBindings
            ? target.config.extraBindings.map((b) => ({ ...b }))
            : target.config.extraBindings,
          options: target.config.options
            ? target.config.options.map((o) => ({ ...o }))
            : target.config.options,
          enumMap: target.config.enumMap
            ? { ...target.config.enumMap }
            : target.config.enumMap,
        },
      };
      mutateActivePanel((p) => ({
        ...p,
        widgets: [
          ...p.widgets.map((w) =>
            parentGroup && updatedGroupLayout && w.id === parentGroup.id
              ? { ...w, layout: updatedGroupLayout }
              : w
          ),
          copy,
        ],
      }));
      setSelectedWidgetId(copy.id);
      setSuppressAutoGroupTarget(false);
    },
    [activePanel, canMutate, mutateActivePanel]
  );

  const handleDeleteWidget = useCallback(
    (widgetId: string) => {
      if (!canMutate) return;
      mutateActivePanel((p) => ({
        ...p,
        widgets: p.widgets.filter((w) => w.id !== widgetId),
      }));
      if (selectedWidgetId === widgetId) {
        setSelectedWidgetId(null);
      }
    },
    [canMutate, mutateActivePanel, selectedWidgetId]
  );

  const handlePopulateCurrentEmptyPanelFromDbc = () => {
    if (!activePanel || !canMutate) return;
    setGenerateModalState({ open: true, mode: 'populate_current' });
  };

  // No projects exist in org yet
  if (!effectiveProjectId && projects.length === 0) {
    return (
      <div className="min-h-full p-6">
        <div className="mx-auto max-w-2xl rounded-[2px] border border-hairline bg-surface p-8 text-center">
          <Gauge className="mx-auto h-6 w-6 text-focus" aria-hidden="true" />
          <h1 className="mt-3 font-mono text-sm font-bold uppercase tracking-wider text-ink">
            {t('simWb.noProject.title')}
          </h1>
          <p className="mt-2 text-xs text-muted">
            {t('simWb.noProject.desc')}
          </p>
          <button
            type="button"
            onClick={() => projectStore.setModalOpen(true)}
            className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-[2px] px-3.5 font-mono text-[11px] font-semibold uppercase text-white cursor-pointer"
            style={{ backgroundColor: 'var(--status-focus)' }}
          >
            <FolderGit2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t('simWb.noProject.btn')}
          </button>
        </div>
      </div>
    );
  }

  // Compute grid canvas height dynamically from lowest widget row
  const gridCols = activePanel?.gridCols ?? 24;
  const rowHeightPx = activePanel?.rowHeightPx ?? 42;

  const renderGenerateFromDbcModal = (): React.JSX.Element | null => {
    if (!generateModalState.open) return null;
    return (
      <SimulationGenerateFromDbcModal
        open={generateModalState.open}
        mode={generateModalState.mode}
        currentPanelName={activePanel?.name}
        databases={databases}
        loadedDbEntries={loadedDbEntries}
        loadingSchemas={loadingSchema}
        saving={savingPanel}
        onClose={() => setGenerateModalState({ open: false, mode: 'create_new' })}
        onConfirmGenerate={handleConfirmGenerateFromDbc}
      />
    );
  };

  const renderPanelCrudModal = (): React.JSX.Element | null => {
    if (panelModalMode === 'none') return null;
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{ backgroundColor: 'var(--bg-scrim)' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sim-panel-modal-title"
      >
        <div className="w-full max-w-md rounded-[2px] border border-strong bg-surface">
          <div className="flex h-10 items-center justify-between border-b border-hairline bg-elevated px-3.5">
            <h2
              id="sim-panel-modal-title"
              className="font-mono text-xs font-semibold uppercase tracking-wider text-ink"
            >
              {panelModalMode === 'create'
                ? t('simWb.modal.createTitle')
                : panelModalMode === 'rename'
                  ? t('simWb.modal.renameTitle')
                  : t('simWb.modal.deleteTitle')}
            </h2>
            <button
              type="button"
              onClick={() => {
                setPanelModalMode('none');
                setModalTargetPanelId(null);
              }}
              aria-label={t('simWb.modal.closeAria')}
              className="cursor-pointer rounded-[2px] p-1 text-muted hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {panelModalMode === 'delete' && modalTargetPanel ? (
            <div className="space-y-3 p-4 text-xs text-muted">
              <p>
                {t('simWb.modal.deleteConfirm', { name: modalTargetPanel.name })}
              </p>
              <div className="flex justify-end gap-2 border-t border-hairline pt-3">
                <button
                  type="button"
                  onClick={() => {
                    setPanelModalMode('none');
                    setModalTargetPanelId(null);
                  }}
                  className="h-[30px] cursor-pointer rounded-[2px] border border-hairline bg-elevated px-3.5 font-mono text-[12px] text-ink"
                >
                  {t('simWb.modal.cancel')}
                </button>
                <button
                  type="button"
                  disabled={savingPanel}
                  onClick={() => void handleDeleteTargetPanel()}
                  className="h-[30px] cursor-pointer rounded-[2px] px-4 font-mono text-[12px] font-semibold uppercase text-white disabled:opacity-50"
                  style={{ backgroundColor: 'var(--status-critical)' }}
                >
                  {savingPanel ? t('simWb.modal.deleting') : t('simWb.modal.deleteBtn')}
                </button>
              </div>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                if (panelModalMode === 'rename') {
                  void handleRenameTargetPanel(e);
                } else {
                  e.preventDefault();
                  void handleCreateBlankOrStarterPanel(
                    panelNameInput,
                    panelDescInput,
                    false,
                    enterAfterCreate
                  );
                }
              }}
              className="space-y-3.5 p-4 text-[12px]"
            >
              <label className="block space-y-1">
                <span className="font-mono text-[11.5px] font-semibold uppercase tracking-wider text-muted">
                  {t('simWb.modal.nameLabel')}
                </span>
                <input
                  type="text"
                  required
                  value={panelNameInput}
                  onChange={(e) => setPanelNameInput(e.target.value)}
                  placeholder={t('simWb.modal.namePlaceholder')}
                  className="h-[32px] w-full rounded-[2px] border border-hairline bg-canvas px-2.5 text-[12.5px] text-ink"
                />
              </label>

              <label className="block space-y-1">
                <span className="font-mono text-[11.5px] font-semibold uppercase tracking-wider text-muted">
                  {t('simWb.modal.descLabel')}
                </span>
                <input
                  type="text"
                  value={panelDescInput}
                  onChange={(e) => setPanelDescInput(e.target.value)}
                  placeholder={t('simWb.modal.descPlaceholder')}
                  className="h-[32px] w-full rounded-[2px] border border-hairline bg-canvas px-2.5 text-[12.5px] text-ink"
                />
              </label>

              {panelModalMode === 'create' && (
                <label className="flex cursor-pointer items-center gap-2 rounded-[2px] border border-hairline bg-canvas px-2.5 py-2 text-[12px] text-ink">
                  <input
                    type="checkbox"
                    checked={enterAfterCreate}
                    onChange={(e) => setEnterAfterCreate(e.target.checked)}
                    className="h-4 w-4 rounded-[2px] accent-[var(--status-focus)]"
                  />
                  <span>{t('simWb.modal.enterAfterCreate')}</span>
                </label>
              )}

              <div className="flex flex-wrap justify-end gap-2 border-t border-hairline pt-3">
                <button
                  type="button"
                  onClick={() => {
                    setPanelModalMode('none');
                    setModalTargetPanelId(null);
                  }}
                  className="h-[30px] cursor-pointer rounded-[2px] border border-hairline bg-elevated px-3.5 font-mono text-[12px] text-ink"
                >
                  {t('simWb.modal.cancel')}
                </button>
                {panelModalMode === 'create' &&
                  loadedDbEntries.length > 0 && (
                    <button
                      type="button"
                      disabled={savingPanel || !panelNameInput.trim()}
                      onClick={() =>
                        void handleCreateBlankOrStarterPanel(
                          panelNameInput,
                          panelDescInput,
                          true,
                          enterAfterCreate
                        )
                      }
                      className="h-[30px] cursor-pointer rounded-[2px] border border-strong bg-elevated px-3 font-mono text-[11.5px] font-semibold uppercase text-focus hover:bg-hover disabled:opacity-50"
                    >
                      {t('simWb.modal.generateFromDbcBtn')}
                    </button>
                  )}
                <button
                  type="submit"
                  disabled={savingPanel || !panelNameInput.trim()}
                  className="h-[30px] cursor-pointer rounded-[2px] px-4 font-mono text-[12px] font-semibold uppercase text-white disabled:opacity-50"
                  style={{ backgroundColor: 'var(--status-focus)' }}
                >
                  {savingPanel
                    ? t('simWb.modal.saving')
                    : panelModalMode === 'create'
                      ? t('simWb.modal.createBtn')
                      : t('simWb.modal.updateBtn')}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  };

  // Step 1 of 2: Panel Directory / List View ('list' by default unless ?panel=<id> is open)
  if (viewState === 'list') {
    return (
      <div className="flex min-h-[calc(100vh-2.75rem)] flex-col bg-canvas">
        <input
          ref={importFileInputRef}
          type="file"
          accept=".json,.nexuspanel.json"
          onChange={(e) => void handleImportNexusPanelFile(e)}
          className="hidden"
        />

        {errorBanner && (
          <div
            role="alert"
            className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2 font-mono text-xs"
            style={{
              backgroundColor: 'var(--status-critical-bg)',
              borderColor: 'var(--status-critical-border)',
              color: 'var(--status-critical)',
            }}
          >
            <span className="inline-flex items-center gap-2">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {errorBanner}
            </span>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="cursor-pointer p-0.5"
              aria-label="Hatayı kapat"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <SimulationPanelListView
          canMutate={canMutate}
          allowProjectSwitch={allowProjectSwitch}
          projects={projects}
          resolvedProject={resolvedProject}
          panels={panels}
          dirtyById={dirtyById}
          databases={databases}
          loadedDbEntries={loadedDbEntries}
          loadingPanels={loadingPanels}
          savingPanel={savingPanel}
          onSelectProjectSlug={handleSelectProjectSlug}
          onEnterPanel={handleEnterPanel}
          onOpenCreateModal={() => {
            setModalTargetPanelId(null);
            setPanelNameInput(`Instrument Panel ${panels.length + 1}`);
            setPanelDescInput('');
            setPanelModalMode('create');
          }}
          onOpenGenerateFromDbcModal={() =>
            setGenerateModalState({ open: true, mode: 'create_new' })
          }
          onNavigateToProject={onBack}
          onTriggerImportJson={() => importFileInputRef.current?.click()}
          onExportPanelJson={handleExportPanelJson}
          onRequestRenamePanel={(pan) => {
            setModalTargetPanelId(pan.id);
            setPanelNameInput(pan.name);
            setPanelDescInput(pan.description);
            setPanelModalMode('rename');
          }}
          onRequestDeletePanel={(pan) => {
            setModalTargetPanelId(pan.id);
            setPanelModalMode('delete');
          }}
          onSyncFromCloud={canSyncFromCloud ? handleTriggerSyncFromCloud : undefined}
          syncingFromCloud={isSyncingFromCloud}
        />

        {renderPanelCrudModal()}
        {renderGenerateFromDbcModal()}
      </div>
    );
  }

  // Step 2 of 2: Full-Screen Panel Workbench ('workbench')
  return (
    <div className="flex h-[calc(100vh-2.75rem)] min-h-[620px] flex-col bg-canvas">
      {/* Hidden file input for .nexuspanel.json import */}
      <input
        ref={importFileInputRef}
        type="file"
        accept=".json,.nexuspanel.json"
        onChange={(e) => void handleImportNexusPanelFile(e)}
        className="hidden"
      />

      {/* Hidden file input for .dbc / .kcd import */}
      <input
        ref={dbcFileInputRef}
        type="file"
        accept=".dbc,.kcd"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          try {
            const base64 = await fileToBase64(file);
            const parsed = await apiParseDatabaseSchema(file.name, base64);
            databaseStore.upsertDatabaseEntry({
              id: makeCatalogDbId(file.name),
              name: file.name.replace(/\.[^/.]+$/, ''),
              fileName: file.name,
              format: file.name.toLowerCase().endsWith('.kcd') ? 'kcd' : 'dbc',
              contentBase64: base64,
              sizeBytes: Math.round((base64.length * 3) / 4),
              uploadedAt: new Date().toISOString(),
              schema: parsed,
            });
          } catch (err) {
            setErrorBanner(
              err instanceof Error ? err.message : t('simWb.errLoadDbc')
            );
          }
        }}
        className="hidden"
      />

      {/* 1. Top Instrument Toolbar */}
      <div className="flex min-h-[42px] shrink-0 flex-wrap items-center justify-between gap-2.5 border-b border-hairline bg-surface px-3 py-1.5">
        {/* Left: Prominent Back to Panel List + Project Badge + Quick Panel Jump + CRUD */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleReturnToPanelList}
            className="inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[2px] border border-strong bg-elevated px-3 font-mono text-[12px] font-bold uppercase tracking-wider text-ink hover:border-focus hover:text-focus"
          >
            <ArrowLeft className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
            {t('simWb.toolbar.panelList')}
          </button>

          {resolvedProject && (
            <button
              type="button"
              onClick={() => {
                if (onBack) onBack();
                else if (onNavigateToTab) onNavigateToTab('rxtx');
              }}
              className="inline-flex h-[30px] items-center rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-[12px] font-semibold uppercase text-muted hover:border-strong hover:text-ink cursor-pointer"
              title={t('simWb.toolbar.goToProjectTitle', { name: resolvedProject.name })}
            >
              {resolvedProject.code}
            </button>
          )}

          <span className="px-0.5 text-subtle">/</span>

          {/* Quick Panel Jump Dropdown */}
          {panels.length > 0 && (
            <div className="inline-flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
              <select
                aria-label={t('simWb.toolbar.panelJumpAria')}
                value={activePanelId}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setActivePanelId(nextId);
                  setSelectedWidgetId(null);
                  syncPanelQueryInUrl(nextId, workbenchMode, false);
                }}
                className="h-[30px] max-w-[260px] rounded-[2px] border border-strong bg-elevated px-2.5 font-mono text-[12px] font-semibold text-ink"
              >
                {panels.map((pan) => (
                  <option key={pan.id} value={pan.id}>
                    {pan.name}
                    {dirtyById[pan.id] ? ' *' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {canMutate && (
            <>
              <button
                type="button"
                onClick={() => {
                  setModalTargetPanelId(null);
                  setEnterAfterCreate(true);
                  setPanelNameInput(`Instrument Panel ${panels.length + 1}`);
                  setPanelDescInput('');
                  setPanelModalMode('create');
                }}
                className="inline-flex h-[30px] cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-elevated px-2.5 font-mono text-[12px] font-semibold uppercase text-focus hover:border-strong"
              >
                <Plus className="h-3 w-3" aria-hidden="true" />
                {t('simWb.toolbar.newPanel')}
              </button>

              {activePanel && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setModalTargetPanelId(activePanel.id);
                      setPanelNameInput(activePanel.name);
                      setPanelDescInput(activePanel.description);
                      setPanelModalMode('rename');
                    }}
                    title={t('simWb.toolbar.renameTitle')}
                    className="inline-flex h-[30px] cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-[12px] text-muted hover:border-strong hover:text-ink"
                  >
                    <Pencil className="h-3 w-3" aria-hidden="true" />
                    {t('simWb.toolbar.rename')}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setModalTargetPanelId(activePanel.id);
                      setPanelModalMode('delete');
                    }}
                    title={t('simWb.toolbar.deleteTitle')}
                    className="inline-flex h-[30px] cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-[12px] text-muted hover:border-critical hover:text-critical"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>

                  <button
                    type="button"
                    disabled={savingPanel}
                    onClick={() => void handleSaveActivePanel()}
                    title={t('simWb.toolbar.saveTitle')}
                    className="inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[2px] border px-3 font-mono text-[12px] font-semibold uppercase transition-colors disabled:opacity-50"
                    style={
                      isActivePanelDirty
                        ? {
                            backgroundColor: 'var(--status-focus)',
                            borderColor: 'var(--status-focus)',
                            color: '#ffffff',
                          }
                        : {
                            backgroundColor: 'var(--bg-elevated)',
                            borderColor: 'var(--border-hairline)',
                            color: 'var(--text-ink)',
                          }
                    }
                  >
                    <Save className="h-3.5 w-3.5" aria-hidden="true" />
                    {savingPanel
                      ? t('simWb.toolbar.saving')
                      : isActivePanelDirty
                        ? t('simWb.toolbar.saveDirty')
                        : t('simWb.toolbar.saved')}
                  </button>

                  {canSyncFromCloud && (
                    <button
                      type="button"
                      disabled={isSyncingFromCloud}
                      onClick={() => void handleTriggerSyncFromCloud()}
                      title={t('simWb.toolbar.refreshTitle')}
                      className="inline-flex h-[30px] cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-[12px] uppercase text-ink hover:border-focus hover:text-focus disabled:opacity-50"
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 text-focus ${isSyncingFromCloud ? 'animate-spin' : ''}`}
                        aria-hidden="true"
                      />
                      <span>{t('simWb.toolbar.refresh')}</span>
                    </button>
                  )}
                </>
              )}
            </>
          )}

          {savedToast && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px] font-semibold text-nominal">
              <Check className="h-3 w-3" aria-hidden="true" />
              {t('simWb.toolbar.synced')}
            </span>
          )}
        </div>

        {/* Right: .nexuspanel.json Import/Export + [ DESIGN | RUN ] Switch */}
        <div className="flex flex-wrap items-center gap-2">
          {canMutate && (
            <button
              type="button"
              onClick={() => importFileInputRef.current?.click()}
              title={t('simWb.toolbar.importTitle')}
              className="inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-[12px] uppercase text-ink hover:border-strong"
            >
              <Upload className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
              {t('simWb.toolbar.import')}
            </button>
          )}

          {activePanel && (
            <button
              type="button"
              onClick={() => handleExportPanelJson(activePanel)}
              title={t('simWb.toolbar.exportTitle')}
              className="inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-[12px] uppercase text-ink hover:border-strong"
            >
              <Download className="h-3.5 w-3.5 text-nominal" aria-hidden="true" />
              .NEXUSPANEL.JSON
            </button>
          )}

          {/* Mode Switch: [ DESIGN ] vs [ RUN ] */}
          <div
            role="group"
            aria-label={t('simWb.toolbar.modeGroupAria')}
            className="inline-flex h-[30px] items-center rounded-[2px] border border-strong bg-canvas p-0.5 font-mono text-[12px] font-bold uppercase tracking-wider"
          >
            <button
              type="button"
              onClick={() => {
                setWorkbenchMode('design');
                if (activePanelId) {
                  syncPanelQueryInUrl(activePanelId, 'design', false);
                }
              }}
              aria-pressed={workbenchMode === 'design'}
              className={`inline-flex h-full cursor-pointer items-center gap-1 rounded-[2px] px-3 transition-colors ${
                workbenchMode === 'design'
                  ? 'bg-elevated text-ink'
                  : 'text-muted hover:text-ink'
              }`}
            >
              <Wrench className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
              {t('simWb.toolbar.modeDesign')}
            </button>
            <button
              type="button"
              onClick={() => {
                setSimPaused(false);
                setWorkbenchMode('run');
                if (activePanelId) {
                  syncPanelQueryInUrl(activePanelId, 'run', false);
                }
              }}
              aria-pressed={workbenchMode === 'run'}
              className={`inline-flex h-full cursor-pointer items-center gap-1 rounded-[2px] px-3 transition-colors ${
                workbenchMode === 'run'
                  ? 'text-white'
                  : 'text-muted hover:text-ink'
              }`}
              style={
                workbenchMode === 'run'
                  ? { backgroundColor: 'var(--status-nominal)' }
                  : undefined
              }
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              {t('simWb.toolbar.modeRun')}
            </button>
          </div>
        </div>
      </div>

      {/* 2. RUN Mode Operator Sub-Toolbar (Telemetry Source + 60 FPS Readout) */}
      {workbenchMode === 'run' && activePanel && (
        <div className="flex shrink-0 min-h-[38px] flex-wrap items-center justify-between gap-2.5 border-b border-hairline bg-elevated px-3 py-1 font-mono text-[11.5px] tabular-nums">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="font-semibold uppercase tracking-wider text-muted">
              {t('simWb.run.telemetrySource')}
            </span>

            <div className="inline-flex h-[28px] items-center rounded-[2px] border border-hairline bg-canvas p-0.5">
              <button
                type="button"
                onClick={() => setTelemetrySource('virtual')}
                aria-pressed={telemetrySource === 'virtual'}
                className={`inline-flex h-full cursor-pointer items-center gap-1.5 rounded-[2px] px-2.5 font-semibold uppercase ${
                  telemetrySource === 'virtual'
                    ? 'bg-surface text-focus'
                    : 'text-muted hover:text-ink'
                }`}
              >
                <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
                {t('simWb.run.sourceVirtual')}
              </button>
              <button
                type="button"
                onClick={() => setTelemetrySource('live_bridge')}
                aria-pressed={telemetrySource === 'live_bridge'}
                className={`inline-flex h-full cursor-pointer items-center gap-1.5 rounded-[2px] px-2.5 font-semibold uppercase ${
                  telemetrySource === 'live_bridge'
                    ? 'bg-surface text-nominal'
                    : 'text-muted hover:text-ink'
                }`}
              >
                <Radio className="h-3.5 w-3.5" aria-hidden="true" />
                {t('simWb.run.sourceLive')}
              </button>
            </div>

            {telemetrySource === 'virtual' ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSimPaused((prev) => !prev)}
                  className="inline-flex h-[28px] cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-surface px-2.5 text-ink hover:border-strong"
                >
                  {simPaused ? (
                    <>
                      <Play className="h-3.5 w-3.5 text-nominal" />
                      {t('simWb.run.resume')}
                    </>
                  ) : (
                    <>
                      <Pause className="h-3.5 w-3.5 text-warn" />
                      {t('simWb.run.freeze')}
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    runtimeBus.reset(allActiveBindings, loadedSchema)
                  }
                  className="inline-flex h-[28px] cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-surface px-2.5 text-muted hover:border-strong hover:text-ink"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('simWb.run.resetBus')}
                </button>
                <span className="text-muted">
                  {t('simWb.run.generatorsActive', {
                    active: activePanel.generators.filter((g) => g.enabled).length,
                  })}
                </span>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {connectedBuses.length > 0 ? (
                  <span className="inline-flex items-center gap-1.5 rounded-[2px] border border-hairline bg-surface px-2.5 py-1 text-[11px] text-ink font-mono tabular-nums">
                    <Radio className="h-3.5 w-3.5 text-focus animate-pulse" />
                    <span>
                      Bus {connectedBuses[0].busId}: {connectedBuses[0].channelName}
                    </span>
                    <span className="text-muted">· {t('simWb.run.fps', { fps: telemetryHeader.fpsRx })}</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-warn text-[11px] font-mono">
                    <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('simWb.run.noPhysicalBus')}
                  </span>
                )}

                <span
                  className="inline-flex items-center gap-1 rounded-[2px] border px-2 py-0.5 font-semibold uppercase text-[11px]"
                  style={{
                    backgroundColor: isLiveBusArmed
                      ? 'var(--status-nominal-bg)'
                      : 'var(--status-warn-bg)',
                    borderColor: isLiveBusArmed
                      ? 'var(--status-nominal-border)'
                      : 'var(--status-warn-border)',
                    color: isLiveBusArmed
                      ? 'var(--status-nominal)'
                      : 'var(--status-warn)',
                  }}
                >
                  <Lock className="h-3 w-3" aria-hidden="true" />
                  {isLiveBusArmed ? t('simWb.run.txArmed') : t('simWb.run.txLocked')}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="rounded-[2px] border border-hairline bg-surface px-2.5 py-1 font-semibold text-nominal text-[11.5px]">
              {t('simWb.run.raf', { fps: measuredFps })}
            </span>
          </div>
        </div>
      )}

      {/* Error Alert Banner */}
      {errorBanner && (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2 font-mono text-xs"
          style={{
            backgroundColor: 'var(--status-critical-bg)',
            borderColor: 'var(--status-critical-border)',
            color: 'var(--status-critical)',
          }}
        >
          <span className="inline-flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {errorBanner}
          </span>
          <button
            type="button"
            onClick={() => setErrorBanner(null)}
            className="cursor-pointer p-0.5"
            aria-label={t('simWb.modal.closeErrorAria')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* 3. Main 3-Pane Design / Full-Width Run Workspace */}
      {loadingPanels ? (
        <div className="flex flex-1 items-center justify-center font-mono text-xs text-muted">
          {t('simWb.canvas.loading')}
        </div>
      ) : panels.length === 0 || !activePanel ? (
        /* Guided Clean Empty State (Zero Mock Startup Data) */
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-xl rounded-[2px] border border-hairline bg-surface p-6">
            <div className="flex items-center gap-2 border-b border-hairline pb-3 font-mono text-xs font-bold uppercase tracking-wider text-ink">
              <Gauge className="h-4 w-4 text-focus" aria-hidden="true" />
              {t('simWb.canvas.emptyTitle')}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted">
              {t('simWb.canvas.emptyDesc')}
            </p>

            <div className="mt-5 flex flex-wrap gap-2.5">
              {canMutate && (
                <button
                  type="button"
                  disabled={savingPanel}
                  onClick={() =>
                    void handleCreateBlankOrStarterPanel(
                      'Primary Instrument Panel',
                      '',
                      false,
                      true
                    )
                  }
                  className="inline-flex h-[32px] cursor-pointer items-center gap-1.5 rounded-[2px] px-3.5 font-mono text-[12px] font-semibold uppercase text-white disabled:opacity-50"
                  style={{ backgroundColor: 'var(--status-focus)' }}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('simWb.canvas.createBlank')}
                </button>
              )}

              {canMutate &&
                loadedDbEntries.length > 0 && (
                  <button
                    type="button"
                    disabled={savingPanel}
                    onClick={() =>
                      setGenerateModalState({ open: true, mode: 'create_new' })
                    }
                    className="inline-flex h-[32px] cursor-pointer items-center gap-1.5 rounded-[2px] border border-strong bg-elevated px-3.5 font-mono text-[12px] font-semibold uppercase text-ink hover:bg-hover disabled:opacity-50"
                  >
                    <Database
                      className="h-3.5 w-3.5 text-nominal"
                      aria-hidden="true"
                    />
                    {t('simWb.canvas.generateFromDbc', { count: loadedDbEntries.length })}
                  </button>
                )}

              {canMutate && (
                <button
                  type="button"
                  onClick={() => importFileInputRef.current?.click()}
                  className="inline-flex h-[32px] cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-[12px] uppercase text-muted hover:border-strong hover:text-ink"
                >
                  <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('simWb.canvas.importJson')}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            {/* Left Sidebar (DESIGN Mode Only) */}
            {workbenchMode === 'design' && (
              <SimulationPaletteSidebar
                canMutate={canMutate}
                databases={databases}
                loadedDbEntries={loadedDbEntries}
                versionsByDbId={versionsByDbId}
                selectedDatabaseFilter={selectedDatabaseFilter}
                selectedVersionByDbId={selectedVersionByDbId}
                loadingSchema={loadingSchema}
                hasSelectedBindableWidget={
                  selectedWidget !== null && selectedWidget.kind !== 'group'
                }
                targetGroupTitle={activeTargetGroup?.title ?? null}
                onClearTargetGroup={() => setSuppressAutoGroupTarget(true)}
                onSelectDatabaseFilter={setSelectedDatabaseFilter}
                onSelectDatabaseVersion={handleSelectDatabaseVersion}
                onAddWidget={handleAddWidget}
                onBindSignalToSelected={handleBindSignalToSelected}
                onOpenUploadDbc={() => dbcFileInputRef.current?.click()}
              />
            )}

            {/* Center 24-Col Industrial Grid Canvas (shared InstrumentCanvasGrid) */}
            <InstrumentCanvasGrid<SimulationWidgetDto>
              widgets={activePanel.widgets}
              gridCols={gridCols}
              rowHeightPx={rowHeightPx}
              isDesignMode={workbenchMode === 'design'}
              canMutate={canMutate}
              selectedWidgetId={selectedWidgetId}
              dragHoverGroupId={dragHoverGroupId}
              containerRef={gridContainerRef}
              dragStateRef={dragStateRef}
              onSelectWidget={(id) => {
                setSelectedWidgetId(id);
                if (id !== null) setSuppressAutoGroupTarget(false);
              }}
              onDuplicateWidget={handleDuplicateWidget}
              onDeleteWidget={handleDeleteWidget}
              onDragOver={handleCanvasDragOver}
              onDragLeave={handleCanvasDragLeave}
              onDrop={handleCanvasDrop}
              getHeaderMeta={(widget) => ({
                badge:
                  widget.binding?.databaseName ??
                  widget.config.lonBinding?.databaseName ??
                  null,
                tag:
                  widget.binding?.messageKey ??
                  widget.config.lonBinding?.messageKey ??
                  null,
              })}
              emptyState={
                <div className="absolute inset-0 flex items-center justify-center p-6">
                  <div className="max-w-md rounded-[2px] border border-hairline bg-surface p-5 text-center">
                    <p className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                      {t('simWb.canvas.gridEmptyTitle')}
                    </p>
                    <p className="mt-1.5 text-xs text-muted">
                      {t('simWb.canvas.gridEmptyDesc')}
                    </p>
                    {canMutate &&
                      loadedSchema &&
                      loadedSchema.signals.length > 0 && (
                        <button
                          type="button"
                          onClick={handlePopulateCurrentEmptyPanelFromDbc}
                          className="mt-3.5 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[2px] border border-strong bg-elevated px-3 font-mono text-[10px] font-semibold uppercase text-focus hover:bg-hover"
                        >
                          <Database
                            className="h-3.5 w-3.5 text-nominal"
                            aria-hidden="true"
                          />
                          {t('simWb.canvas.populateDbc', { count: loadedDbEntries.length })}
                        </button>
                      )}
                  </div>
                </div>
              }
              renderBody={(widget, { groupChildCount }) => (
                <SimulationWidgetBody
                  widget={widget}
                  runtimeBus={runtimeBus}
                  isRunMode={workbenchMode === 'run'}
                  telemetrySource={telemetrySource}
                  activeSchema={loadedSchema}
                  allBindings={allActiveBindings}
                  isLiveBusArmed={isLiveBusArmed}
                  onLiveTransmitSignal={handleLiveTransmitSignal}
                  canMutate={canMutate}
                  groupChildCount={groupChildCount}
                  onQuickAddToGroup={(grpId, kind) =>
                    handleAddWidgetToGroup(grpId, kind, {
                      selectCreated: true,
                    })
                  }
                />
              )}
            />

            {/* Right Inspector + Waveform Generators Sidebar (DESIGN Mode Only) */}
            {workbenchMode === 'design' && (
              <SimulationInspectorSidebar
                canMutate={canMutate}
                gridCols={gridCols}
                selectedWidget={selectedWidget}
                allWidgets={activePanel.widgets}
                generators={activePanel.generators}
                databases={databases}
                loadedDbEntries={loadedDbEntries}
                schema={loadedSchema}
                onSelectWidget={(id) => {
                  setSelectedWidgetId(id);
                  setSuppressAutoGroupTarget(false);
                }}
                onAddWidgetToGroup={(grpId, kind) =>
                  handleAddWidgetToGroup(grpId, kind, { selectCreated: false })
                }
                onMoveWidgetIntoGroup={handleMoveWidgetIntoGroup}
                onUpdateWidget={handleUpdateWidget}
                onDuplicateWidget={handleDuplicateWidget}
                onDeleteWidget={handleDeleteWidget}
                onUpdateGenerators={(nextGens: SimulationGeneratorSpecDto[]) =>
                  mutateActivePanel((p) => ({ ...p, generators: nextGens }))
                }
              />
            )}
          </div>

          {/* Collapsible Virtual CAN / Live Mirror Frame Inspector (RUN Mode) */}
          {workbenchMode === 'run' && (
            <VirtualCanFrameInspector
              runtimeBus={runtimeBus}
              telemetrySource={telemetrySource}
              open={inspectorDockOpen}
              onToggleOpen={() => setInspectorDockOpen((prev) => !prev)}
            />
          )}
        </div>
      )}

      {renderPanelCrudModal()}
        {renderGenerateFromDbcModal()}
    </div>
  );
}
