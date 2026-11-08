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
  Copy,
  Cpu,
  Database,
  Download,
  FolderGit2,
  Gauge,
  GripHorizontal,
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
import { simulationPanelStore } from '../../store/simulationPanelStore';
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
import { buildLocalCatalogEntries, makeDatabaseEntry } from './desktopDbEntries';
import { VirtualCanFrameInspector } from './VirtualCanFrameInspector';
import {
  ACCENT_HEX_MAP,
  SIM_PALETTE_DRAG_MIME,
  TRACE_PALETTE,
  collectPanelBindings,
  createClientUid,
  createDefaultWidget,
  enumTableToComboOptions,
  findContainingGroup,
  findGnssSiblingsInMessage,
  findNextFreeGridSlot,
  inferBusIdFromAssignment,
  isLongitudeSignalName,
  isWidgetInsideGroup,
  mergeDatabaseSchemas,
  parsePaletteDragPayload,
  placeWidgetInsideGroup,
  signalSchemaToBinding,
  type LoadedSimulationDatabaseEntry,
  type SignalBindingDbMeta,
  type SignalBoundContextInput,
} from './virtualCanPacking';

interface DragGroupChildOffset {
  id: string;
  origCol: number;
  origRow: number;
  w: number;
  h: number;
}

interface DragInteractionState {
  mode: 'move' | 'resize';
  widgetId: string;
  widgetKind: SimulationWidgetKind;
  startClientX: number;
  startClientY: number;
  origCol: number;
  origRow: number;
  origW: number;
  origH: number;
  childOffsets: readonly DragGroupChildOffset[];
}

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
  const projState = useProjectStore();
  const cloudState = useCloudBridgeStore();
  const telemetryHeader = useTelemetryHeader();
  const dbcFileInputRef = useRef<HTMLInputElement | null>(null);

  const connectedBuses = useMemo(
    () => telemetryHeader.buses.filter((b) => b.connected),
    [telemetryHeader.buses]
  );
  const isLiveBusArmed = useMemo(() => {
    const active = connectedBuses[0];
    return Boolean(
      active && !active.listenOnly && active.txArmed && !telemetryHeader.txPanicLatched
    );
  }, [connectedBuses, telemetryHeader.txPanicLatched]);

  const resolvedProject = useMemo<CloudProjectDto>(() => {
    if (cloudProjectContext) return cloudProjectContext.project;
    const cb = projState.cloudBinding;
    return {
      id: projectId ?? cb?.projectId ?? 'desktop',
      orgId: cb?.orgId ?? 'local',
      name: projState.currentName || projState.currentFileStem || 'Yerel Çalışma Alanı',
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
  const [dragHoverGroupId, setDragHoverGroupId] = useState<string | null>(null);
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
  const dragStateRef = useRef<DragInteractionState | null>(null);
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

  const groupChildCountById = useMemo<Record<string, number>>(() => {
    if (!activePanel) return {};
    const counts: Record<string, number> = {};
    for (const w of activePanel.widgets) {
      if (w.kind === 'group') {
        counts[w.id] = activePanel.widgets.filter((cand) =>
          isWidgetInsideGroup(cand, w)
        ).length;
      }
    }
    return counts;
  }, [activePanel]);

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
        loadedPanels = [...simulationPanelStore.getState().panels];
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
  }, [cloudProjectContext, contextPanels, effectiveProjectId, syncNonce]);

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
      if (!isLiveBusArmed) return;
      const schema = databaseStore.getBusSchema(binding.busId || 0);
      const sigId = schema?.signals.find(
        (s) => s.messageKey === binding.messageKey && s.name === binding.signalName
      )?.signalId;
      if (sigId === undefined) return;

      void apiTransmitSignalFrame({
        busId: binding.busId || 0,
        arbId: binding.arbId,
        isExtended: binding.isExtended,
        signalValues: [[sigId, value]],
        periodicMs: txCycleMs && txCycleMs > 0 ? txCycleMs : null,
        jobLabel: `SimPanel::${binding.signalName}`,
      }).catch((err) => {
        console.warn('[SimulationWorkbench] Live TX failed:', err);
      });
    },
    [isLiveBusArmed]
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

  // Ctrl+S / Cmd+S + Design Keyboard Shortcuts (Delete / Arrow Nudging)
  useEffect(() => {
    if (viewState !== 'workbench') {
      return;
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSaveActivePanel();
        return;
      }

      if (workbenchMode !== 'design' || !selectedWidgetId || !canMutate) {
        return;
      }

      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        mutateActivePanel((p) => ({
          ...p,
          widgets: p.widgets.filter((w) => w.id !== selectedWidgetId),
        }));
        setSelectedWidgetId(null);
        return;
      }

      if (
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight' ||
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown'
      ) {
        e.preventDefault();
        const dCol = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        const dRow = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
        mutateActivePanel((p) => {
          const target = p.widgets.find((w) => w.id === selectedWidgetId);
          if (!target) return p;

          if (!e.shiftKey && !e.altKey && target.kind === 'group') {
            const nextGroupCol = Math.max(
              0,
              Math.min(p.gridCols - target.layout.w, target.layout.col + dCol)
            );
            const nextGroupRow = Math.max(
              0,
              Math.min(399, target.layout.row + dRow)
            );
            const actualDeltaCol = nextGroupCol - target.layout.col;
            const actualDeltaRow = nextGroupRow - target.layout.row;
            if (actualDeltaCol === 0 && actualDeltaRow === 0) {
              return p;
            }
            const childIds = new Set(
              p.widgets
                .filter((cand) => isWidgetInsideGroup(cand, target))
                .map((cand) => cand.id)
            );
            return {
              ...p,
              widgets: p.widgets.map((w) => {
                if (w.id === target.id) {
                  return {
                    ...w,
                    layout: {
                      ...w.layout,
                      col: nextGroupCol,
                      row: nextGroupRow,
                    },
                  };
                }
                if (childIds.has(w.id)) {
                  const childNextCol = Math.max(
                    0,
                    Math.min(
                      p.gridCols - w.layout.w,
                      w.layout.col + actualDeltaCol
                    )
                  );
                  const childNextRow = Math.max(
                    0,
                    Math.min(399, w.layout.row + actualDeltaRow)
                  );
                  return {
                    ...w,
                    layout: {
                      ...w.layout,
                      col: childNextCol,
                      row: childNextRow,
                    },
                  };
                }
                return w;
              }),
            };
          }

          return {
            ...p,
            widgets: p.widgets.map((w) => {
              if (w.id !== selectedWidgetId) return w;
              if (e.shiftKey) {
                const nextW = Math.max(
                  1,
                  Math.min(p.gridCols - w.layout.col, w.layout.w + dCol)
                );
                const nextH = Math.max(1, Math.min(48, w.layout.h + dRow));
                return {
                  ...w,
                  layout: { ...w.layout, w: nextW, h: nextH },
                };
              }
              const nextCol = Math.max(
                0,
                Math.min(p.gridCols - w.layout.w, w.layout.col + dCol)
              );
              const nextRow = Math.max(0, Math.min(399, w.layout.row + dRow));
              return {
                ...w,
                layout: { ...w.layout, col: nextCol, row: nextRow },
              };
            }),
          };
        });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    canMutate,
    handleSaveActivePanel,
    mutateActivePanel,
    selectedWidgetId,
    viewState,
    workbenchMode,
  ]);

  // 5. Pointer Drag-to-Move & Corner Drag-to-Resize on 24-Col Grid
  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const drag = dragStateRef.current;
      const container = gridContainerRef.current;
      if (!drag || !container || !activePanel) return;

      const rect = container.getBoundingClientRect();
      const colWidth = Math.max(16, rect.width / activePanel.gridCols);
      const rowHeight = activePanel.rowHeightPx;

      const deltaCols = Math.round((e.clientX - drag.startClientX) / colWidth);
      const deltaRows = Math.round((e.clientY - drag.startClientY) / rowHeight);

      if (drag.mode === 'move') {
        const nextCol = Math.max(
          0,
          Math.min(activePanel.gridCols - drag.origW, drag.origCol + deltaCols)
        );
        const nextRow = Math.max(0, Math.min(399, drag.origRow + deltaRows));

        if (drag.widgetKind === 'group') {
          setDragHoverGroupId((prev) => (prev === null ? prev : null));
          const actualDeltaCol = nextCol - drag.origCol;
          const actualDeltaRow = nextRow - drag.origRow;
          const childOffsetById = new Map<string, DragGroupChildOffset>();
          for (const childOff of drag.childOffsets) {
            childOffsetById.set(childOff.id, childOff);
          }

          mutateActivePanel((p) => ({
            ...p,
            widgets: p.widgets.map((w) => {
              if (w.id === drag.widgetId) {
                if (nextCol === w.layout.col && nextRow === w.layout.row) {
                  return w;
                }
                return {
                  ...w,
                  layout: { ...w.layout, col: nextCol, row: nextRow },
                };
              }
              const childOff = childOffsetById.get(w.id);
              if (childOff) {
                const targetChildCol = e.altKey
                  ? childOff.origCol
                  : Math.max(
                      0,
                      Math.min(
                        p.gridCols - childOff.w,
                        childOff.origCol + actualDeltaCol
                      )
                    );
                const targetChildRow = e.altKey
                  ? childOff.origRow
                  : Math.max(
                      0,
                      Math.min(399, childOff.origRow + actualDeltaRow)
                    );
                if (
                  targetChildCol === w.layout.col &&
                  targetChildRow === w.layout.row
                ) {
                  return w;
                }
                return {
                  ...w,
                  layout: {
                    ...w.layout,
                    col: targetChildCol,
                    row: targetChildRow,
                  },
                };
              }
              return w;
            }),
          }));
          return;
        }

        const hoveredGroup = findContainingGroup(
          { col: nextCol, row: nextRow, w: drag.origW, h: drag.origH },
          activePanel.widgets
        );
        const nextHoverId = hoveredGroup?.id ?? null;
        setDragHoverGroupId((prev) =>
          prev === nextHoverId ? prev : nextHoverId
        );

        mutateActivePanel((p) => ({
          ...p,
          widgets: p.widgets.map((w) => {
            if (w.id !== drag.widgetId) return w;
            if (nextCol === w.layout.col && nextRow === w.layout.row) {
              return w;
            }
            return {
              ...w,
              layout: { ...w.layout, col: nextCol, row: nextRow },
            };
          }),
        }));
        return;
      }

      mutateActivePanel((p) => ({
        ...p,
        widgets: p.widgets.map((w) => {
          if (w.id !== drag.widgetId) return w;
          const nextW = Math.max(
            1,
            Math.min(p.gridCols - drag.origCol, drag.origW + deltaCols)
          );
          const nextH = Math.max(1, Math.min(48, drag.origH + deltaRows));
          if (nextW === w.layout.w && nextH === w.layout.h) {
            return w;
          }
          return {
            ...w,
            layout: { ...w.layout, w: nextW, h: nextH },
          };
        }),
      }));
    };

    const onPointerUp = () => {
      const finishedDrag = dragStateRef.current;
      dragStateRef.current = null;
      setDragHoverGroupId(null);

      if (
        finishedDrag &&
        finishedDrag.mode === 'move' &&
        finishedDrag.widgetKind !== 'group'
      ) {
        mutateActivePanel((p) => {
          const moved = p.widgets.find((w) => w.id === finishedDrag.widgetId);
          if (!moved || moved.kind === 'group') return p;
          const containingGroup = findContainingGroup(moved.layout, p.widgets);
          if (!containingGroup) return p;

          const adjustedCol = Math.max(
            containingGroup.layout.col,
            Math.min(p.gridCols - moved.layout.w, moved.layout.col)
          );
          const adjustedRow =
            moved.layout.row <= containingGroup.layout.row
              ? Math.min(399, containingGroup.layout.row + 1)
              : moved.layout.row;

          const maxAllowedGroupW = Math.max(
            1,
            Math.min(24, p.gridCols - containingGroup.layout.col)
          );
          const neededGroupW =
            adjustedCol + moved.layout.w - containingGroup.layout.col;
          const nextGroupW = Math.min(
            maxAllowedGroupW,
            Math.max(containingGroup.layout.w, neededGroupW)
          );
          const neededGroupH =
            adjustedRow + moved.layout.h - containingGroup.layout.row;
          const nextGroupH = Math.min(
            48,
            Math.max(2, containingGroup.layout.h, neededGroupH)
          );

          if (
            adjustedCol === moved.layout.col &&
            adjustedRow === moved.layout.row &&
            nextGroupW === containingGroup.layout.w &&
            nextGroupH === containingGroup.layout.h
          ) {
            return p;
          }

          return {
            ...p,
            widgets: p.widgets.map((w) => {
              if (w.id === moved.id) {
                return {
                  ...w,
                  layout: { ...w.layout, col: adjustedCol, row: adjustedRow },
                };
              }
              if (w.id === containingGroup.id) {
                return {
                  ...w,
                  layout: { ...w.layout, w: nextGroupW, h: nextGroupH },
                };
              }
              return w;
            }),
          };
        });
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [activePanel, mutateActivePanel]);

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
        err instanceof Error ? err.message : 'Yeni panel oluşturulamadı.'
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
        err instanceof Error ? err.message : 'Panel yeniden adlandırılamadı.'
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
      setErrorBanner(err instanceof Error ? err.message : 'Panel silinemedi.');
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
        throw new Error(
          'Geçersiz .nexuspanel.json formatı (schemaVersion: 1 veya SimulationPanelDto bekleniyor).'
        );
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
          : '.nexuspanel.json içe aktarma başarısız.'
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

  const resolveGridCellFromClientPoint = useCallback(
    (clientX: number, clientY: number): { col: number; row: number } | null => {
      const container = gridContainerRef.current;
      if (!container || !activePanel) return null;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const colWidth = rect.width / activePanel.gridCols;
      const relX = clientX - rect.left;
      const relY = clientY - rect.top;
      const col = Math.max(
        0,
        Math.min(activePanel.gridCols - 1, Math.floor(relX / colWidth))
      );
      const row = Math.max(
        0,
        Math.min(399, Math.floor(relY / activePanel.rowHeightPx))
      );
      return { col, row };
    },
    [activePanel]
  );

  const handleCanvasDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (workbenchMode !== 'design' || !canMutate || !activePanel) return;
      if (!Array.from(e.dataTransfer.types).includes(SIM_PALETTE_DRAG_MIME)) {
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';

      const cell = resolveGridCellFromClientPoint(e.clientX, e.clientY);
      const hoveredGroup = cell
        ? findContainingGroup(
            { col: cell.col, row: cell.row, w: 1, h: 1 },
            activePanel.widgets
          )
        : null;
      const nextId = hoveredGroup?.id ?? null;
      setDragHoverGroupId((prev) => (prev === nextId ? prev : nextId));
    },
    [activePanel, canMutate, resolveGridCellFromClientPoint, workbenchMode]
  );

  const handleCanvasDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const related = e.relatedTarget as Node | null;
      if (!related || !e.currentTarget.contains(related)) {
        setDragHoverGroupId(null);
      }
    },
    []
  );

  const handleCanvasDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (workbenchMode !== 'design' || !canMutate || !activePanel) return;
      const raw = e.dataTransfer.getData(SIM_PALETTE_DRAG_MIME);
      setDragHoverGroupId(null);
      if (!raw) return;
      e.preventDefault();

      const payload = parsePaletteDragPayload(raw);
      if (!payload) return;

      const cell = resolveGridCellFromClientPoint(e.clientX, e.clientY) ?? {
        col: 0,
        row: 0,
      };
      const hoveredGroup =
        payload.kind !== 'group'
          ? findContainingGroup(
              { col: cell.col, row: cell.row, w: 1, h: 1 },
              activePanel.widgets
            )
          : null;

      if (hoveredGroup && payload.kind !== 'group') {
        handleAddWidgetToGroup(hoveredGroup.id, payload.kind, {
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
      canMutate,
      handleAddWidgetToGroup,
      loadedDbEntries,
      loadedSchema,
      mutateActivePanel,
      resolveGridCellFromClientPoint,
      workbenchMode,
    ]
  );

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

      const parentGroup =
        target.kind !== 'group'
          ? findContainingGroup(target.layout, activePanel.widgets)
          : null;

      let copyLayout = target.layout;
      let updatedGroupLayout = parentGroup?.layout ?? null;

      if (parentGroup) {
        const placed = placeWidgetInsideGroup(
          parentGroup,
          activePanel.widgets,
          target.layout.w,
          target.layout.h,
          activePanel.gridCols
        );
        copyLayout = placed.childLayout;
        updatedGroupLayout = placed.updatedGroupLayout;
      } else {
        copyLayout = findNextFreeGridSlot(
          activePanel.widgets,
          target.layout.w,
          target.layout.h,
          activePanel.gridCols
        );
      }

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
            INSTRUMENT PANELS & VIRTUAL SIMULATION
          </h1>
          <p className="mt-2 text-xs text-muted">
            Sanal gösterge paneli ve simülasyon tezgahını açmak için önce bir mühendislik projesi oluşturun.
          </p>
          <button
            type="button"
            onClick={() => projectStore.setModalOpen(true)}
            className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-[2px] px-3.5 font-mono text-[11px] font-semibold uppercase text-white cursor-pointer"
            style={{ backgroundColor: 'var(--status-focus)' }}
          >
            <FolderGit2 className="h-3.5 w-3.5" aria-hidden="true" />
            PROJELERE GİT
          </button>
        </div>
      </div>
    );
  }

  // Compute grid canvas height dynamically from lowest widget row
  const gridCols = activePanel?.gridCols ?? 24;
  const rowHeightPx = activePanel?.rowHeightPx ?? 42;
  const maxOccupiedRow = activePanel
    ? activePanel.widgets.reduce(
        (maxR, w) => Math.max(maxR, w.layout.row + w.layout.h),
        14
      )
    : 14;
  const canvasRows = workbenchMode === 'design' ? maxOccupiedRow + 6 : maxOccupiedRow + 1;
  const canvasMinHeightPx = Math.max(540, canvasRows * rowHeightPx);

  // Render group frames below display/stimulus widgets so inner widgets remain interactive
  const orderedWidgets = activePanel
    ? [...activePanel.widgets].sort((a, b) => {
        if (a.kind === 'group' && b.kind !== 'group') return -1;
        if (a.kind !== 'group' && b.kind === 'group') return 1;
        return 0;
      })
    : [];

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
                ? 'YENİ SİMÜLASYON PANELİ OLUŞTUR'
                : panelModalMode === 'rename'
                  ? 'PANELİ YENİDEN ADLANDIR'
                  : 'PANELİ SİL'}
            </h2>
            <button
              type="button"
              onClick={() => {
                setPanelModalMode('none');
                setModalTargetPanelId(null);
              }}
              aria-label="Kapat"
              className="cursor-pointer rounded-[2px] p-1 text-muted hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {panelModalMode === 'delete' && modalTargetPanel ? (
            <div className="space-y-3 p-4 text-xs text-muted">
              <p>
                <strong className="text-ink">{modalTargetPanel.name}</strong>{' '}
                paneli kalıcı olarak silinecek ve{' '}
                <span className="font-mono text-ink">.nexusproj.json</span>{' '}
                çalışma alanından kaldırılacaktır.
              </p>
              <div className="flex justify-end gap-2 border-t border-hairline pt-3">
                <button
                  type="button"
                  onClick={() => {
                    setPanelModalMode('none');
                    setModalTargetPanelId(null);
                  }}
                  className="h-7 cursor-pointer rounded-[2px] border border-hairline bg-elevated px-3 font-mono text-[11px] text-ink"
                >
                  İPTAL
                </button>
                <button
                  type="button"
                  disabled={savingPanel}
                  onClick={() => void handleDeleteTargetPanel()}
                  className="h-7 cursor-pointer rounded-[2px] px-3.5 font-mono text-[11px] font-semibold uppercase text-white disabled:opacity-50"
                  style={{ backgroundColor: 'var(--status-critical)' }}
                >
                  {savingPanel ? 'SİLİNİYOR...' : 'PANELİ SİL'}
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
              className="space-y-3 p-4"
            >
              <label className="block space-y-1">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted">
                  PANEL ADI
                </span>
                <input
                  type="text"
                  required
                  value={panelNameInput}
                  onChange={(e) => setPanelNameInput(e.target.value)}
                  placeholder="Powertrain & GNSS Bench Deck"
                  className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-2.5 text-xs text-ink"
                />
              </label>

              <label className="block space-y-1">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted">
                  AÇIKLAMA (OPSİYONEL)
                </span>
                <input
                  type="text"
                  value={panelDescInput}
                  onChange={(e) => setPanelDescInput(e.target.value)}
                  placeholder="24-sütunlu operatör göstergeleri, OSM haritası ve sanal kontroller"
                  className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-2.5 text-xs text-ink"
                />
              </label>

              {panelModalMode === 'create' && (
                <label className="flex cursor-pointer items-center gap-2 rounded-[2px] border border-hairline bg-canvas px-2.5 py-2 text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={enterAfterCreate}
                    onChange={(e) => setEnterAfterCreate(e.target.checked)}
                    className="h-3.5 w-3.5 rounded-[2px] accent-[var(--status-focus)]"
                  />
                  <span>Oluşturduktan sonra doğrudan panel tezgahına gir</span>
                </label>
              )}

              <div className="flex flex-wrap justify-end gap-2 border-t border-hairline pt-3">
                <button
                  type="button"
                  onClick={() => {
                    setPanelModalMode('none');
                    setModalTargetPanelId(null);
                  }}
                  className="h-7 cursor-pointer rounded-[2px] border border-hairline bg-elevated px-3 font-mono text-[11px] text-ink"
                >
                  İPTAL
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
                      className="h-7 cursor-pointer rounded-[2px] border border-strong bg-elevated px-3 font-mono text-[10px] font-semibold uppercase text-focus hover:bg-hover disabled:opacity-50"
                    >
                      DBC&apos;DEN TASLAK OLUŞTUR...
                    </button>
                  )}
                <button
                  type="submit"
                  disabled={savingPanel || !panelNameInput.trim()}
                  className="h-7 cursor-pointer rounded-[2px] px-3.5 font-mono text-[11px] font-semibold uppercase text-white disabled:opacity-50"
                  style={{ backgroundColor: 'var(--status-focus)' }}
                >
                  {savingPanel
                    ? 'KAYDEDİLİYOR...'
                    : panelModalMode === 'create'
                      ? 'OLUŞTUR'
                      : 'GÜNCELLE'}
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
              err instanceof Error ? err.message : 'DBC yüklenemedi.'
            );
          }
        }}
        className="hidden"
      />

      {/* 1. Top Instrument Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-hairline bg-surface px-3 py-2">
        {/* Left: Prominent Back to Panel List + Project Badge + Quick Panel Jump + CRUD */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={handleReturnToPanelList}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-strong bg-elevated px-2.5 font-mono text-[10px] font-bold uppercase tracking-wider text-ink hover:border-focus hover:text-focus"
          >
            <ArrowLeft className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
            PANEL LİSTESİ
          </button>

          {resolvedProject && (
            <button
              type="button"
              onClick={() => {
                if (onBack) onBack();
                else if (onNavigateToTab) onNavigateToTab('rxtx');
              }}
              className="inline-flex h-7 items-center rounded-[2px] border border-hairline bg-canvas px-2 font-mono text-[10px] font-semibold uppercase text-muted hover:border-strong hover:text-ink cursor-pointer"
              title={`${resolvedProject.name} sayfasına git`}
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
                aria-label="Hızlı panel geçişi"
                value={activePanelId}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setActivePanelId(nextId);
                  setSelectedWidgetId(null);
                  syncPanelQueryInUrl(nextId, workbenchMode, false);
                }}
                className="h-7 max-w-[240px] rounded-[2px] border border-strong bg-elevated px-2 font-mono text-[11px] font-semibold text-ink"
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
                className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-elevated px-2 font-mono text-[10px] font-semibold uppercase text-focus hover:border-strong"
              >
                <Plus className="h-3 w-3" aria-hidden="true" />
                NEW PANEL
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
                    title="Paneli yeniden adlandır"
                    className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-canvas px-2 font-mono text-[10px] text-muted hover:border-strong hover:text-ink"
                  >
                    <Pencil className="h-3 w-3" aria-hidden="true" />
                    RENAME
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setModalTargetPanelId(activePanel.id);
                      setPanelModalMode('delete');
                    }}
                    title="Paneli sil"
                    className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-canvas px-2 font-mono text-[10px] text-muted hover:border-critical hover:text-critical"
                  >
                    <Trash2 className="h-3 w-3" aria-hidden="true" />
                  </button>

                  <button
                    type="button"
                    disabled={savingPanel}
                    onClick={() => void handleSaveActivePanel()}
                    title="Paneli kaydet ve .nexusproj.json ile senkronize et (Ctrl+S)"
                    className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border px-2.5 font-mono text-[10px] font-semibold uppercase transition-colors disabled:opacity-50"
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
                    <Save className="h-3 w-3" aria-hidden="true" />
                    {savingPanel
                      ? 'SAVING...'
                      : isActivePanelDirty
                        ? 'SAVE PANEL *'
                        : 'SAVED'}
                  </button>

                  {canSyncFromCloud && (
                    <button
                      type="button"
                      disabled={isSyncingFromCloud}
                      onClick={() => void handleTriggerSyncFromCloud()}
                      title="Bu paneli ve kardeş panelleri Cloud'dan yeniden yükle / eşitle"
                      className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-canvas px-2 font-mono text-[10px] uppercase text-ink hover:border-focus hover:text-focus disabled:opacity-50"
                    >
                      <RefreshCw
                        className={`h-3 w-3 text-focus ${isSyncingFromCloud ? 'animate-spin' : ''}`}
                        aria-hidden="true"
                      />
                      <span>YENİLE</span>
                    </button>
                  )}
                </>
              )}
            </>
          )}

          {savedToast && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] font-semibold text-nominal">
              <Check className="h-3 w-3" aria-hidden="true" />
              SYNCED (.NEXUSPROJ.JSON)
            </span>
          )}
        </div>

        {/* Right: .nexuspanel.json Import/Export + [ DESIGN | RUN ] Switch */}
        <div className="flex flex-wrap items-center gap-1.5">
          {canMutate && (
            <button
              type="button"
              onClick={() => importFileInputRef.current?.click()}
              title=".nexuspanel.json dosyası içe aktar"
              className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-canvas px-2 font-mono text-[10px] uppercase text-ink hover:border-strong"
            >
              <Upload className="h-3 w-3 text-focus" aria-hidden="true" />
              IMPORT
            </button>
          )}

          {activePanel && (
            <button
              type="button"
              onClick={() => handleExportPanelJson(activePanel)}
              title=".nexuspanel.json dosyası dışa aktar"
              className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-canvas px-2 font-mono text-[10px] uppercase text-ink hover:border-strong"
            >
              <Download className="h-3 w-3 text-nominal" aria-hidden="true" />
              .NEXUSPANEL.JSON
            </button>
          )}

          {/* Mode Switch: [ DESIGN ] vs [ RUN ] */}
          <div
            role="group"
            aria-label="Çalışma Modu"
            className="inline-flex h-7 items-center rounded-[2px] border border-strong bg-canvas p-0.5 font-mono text-[10px] font-bold uppercase tracking-wider"
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
              className={`inline-flex h-full cursor-pointer items-center gap-1 rounded-[2px] px-2.5 transition-colors ${
                workbenchMode === 'design'
                  ? 'bg-elevated text-ink'
                  : 'text-muted hover:text-ink'
              }`}
            >
              <Wrench className="h-3 w-3 text-focus" aria-hidden="true" />
              [ DESIGN ]
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
              className={`inline-flex h-full cursor-pointer items-center gap-1 rounded-[2px] px-2.5 transition-colors ${
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
              <Play className="h-3 w-3" aria-hidden="true" />
              [ RUN ]
            </button>
          </div>
        </div>
      </div>

      {/* 2. RUN Mode Operator Sub-Toolbar (Telemetry Source + 60 FPS Readout) */}
      {workbenchMode === 'run' && activePanel && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-hairline bg-elevated px-3 py-1.5 font-mono text-[10px] tabular-nums">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold uppercase tracking-wider text-muted">
              TELEMETRY SOURCE:
            </span>

            <div className="inline-flex h-6 items-center rounded-[2px] border border-hairline bg-canvas p-0.5">
              <button
                type="button"
                onClick={() => setTelemetrySource('virtual')}
                aria-pressed={telemetrySource === 'virtual'}
                className={`inline-flex h-full cursor-pointer items-center gap-1.5 rounded-[2px] px-2 font-semibold uppercase ${
                  telemetrySource === 'virtual'
                    ? 'bg-surface text-focus'
                    : 'text-muted hover:text-ink'
                }`}
              >
                <Cpu className="h-3 w-3" aria-hidden="true" />
                VIRTUAL BUS (LOCAL SIM)
              </button>
              <button
                type="button"
                onClick={() => setTelemetrySource('live_bridge')}
                aria-pressed={telemetrySource === 'live_bridge'}
                className={`inline-flex h-full cursor-pointer items-center gap-1.5 rounded-[2px] px-2 font-semibold uppercase ${
                  telemetrySource === 'live_bridge'
                    ? 'bg-surface text-nominal'
                    : 'text-muted hover:text-ink'
                }`}
              >
                <Radio className="h-3 w-3" aria-hidden="true" />
                LIVE BRIDGE (READ-ONLY)
              </button>
            </div>

            {telemetrySource === 'virtual' ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setSimPaused((prev) => !prev)}
                  className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-2 text-ink hover:border-strong"
                >
                  {simPaused ? (
                    <>
                      <Play className="h-3 w-3 text-nominal" />
                      RESUME
                    </>
                  ) : (
                    <>
                      <Pause className="h-3 w-3 text-warn" />
                      FREEZE
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    runtimeBus.reset(allActiveBindings, loadedSchema)
                  }
                  className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-2 text-muted hover:border-strong hover:text-ink"
                >
                  <RotateCcw className="h-3 w-3" />
                  RESET BUS
                </button>
                <span className="text-muted">
                  GENERATORS:{' '}
                  <strong className="text-ink">
                    {activePanel.generators.filter((g) => g.enabled).length}
                  </strong>{' '}
                  ACTIVE
                </span>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {connectedBuses.length > 0 ? (
                  <span className="inline-flex items-center gap-1.5 rounded-[2px] border border-hairline bg-surface px-2 py-0.5 text-[10px] text-ink font-mono tabular-nums">
                    <Radio className="h-3 w-3 text-focus animate-pulse" />
                    <span>
                      Bus {connectedBuses[0].busId}: {connectedBuses[0].channelName}
                    </span>
                    <span className="text-muted">· {telemetryHeader.fpsRx} fps</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-warn text-[10px] font-mono">
                    <WifiOff className="h-3 w-3" aria-hidden="true" />
                    NO PHYSICAL CAN BUS CONNECTED
                  </span>
                )}

                <span
                  className="inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 font-semibold uppercase text-[10px]"
                  style={{
                    backgroundColor: isLiveBusArmed
                      ? 'var(--status-nominal-bg)'
                      : 'var(--status-warning-bg)',
                    borderColor: isLiveBusArmed
                      ? 'var(--status-nominal-border)'
                      : 'var(--status-warning-border)',
                    color: isLiveBusArmed
                      ? 'var(--status-nominal)'
                      : 'var(--status-warning)',
                  }}
                >
                  <Lock className="h-2.5 w-2.5" aria-hidden="true" />
                  {isLiveBusArmed ? 'ACTIVE TX ARMED' : 'LISTEN-ONLY // TX LOCKED'}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="rounded-[2px] border border-hairline bg-surface px-2 py-0.5 font-semibold text-nominal">
              {measuredFps} FPS rAF
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
            aria-label="Hatayı kapat"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* 3. Main 3-Pane Design / Full-Width Run Workspace */}
      {loadingPanels ? (
        <div className="flex flex-1 items-center justify-center font-mono text-xs text-muted">
          LOADING INSTRUMENT PANELS...
        </div>
      ) : panels.length === 0 || !activePanel ? (
        /* Guided Clean Empty State (Zero Mock Startup Data) */
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-xl rounded-[2px] border border-hairline bg-surface p-6">
            <div className="flex items-center gap-2 border-b border-hairline pb-3 font-mono text-xs font-bold uppercase tracking-wider text-ink">
              <Gauge className="h-4 w-4 text-focus" aria-hidden="true" />
              NO SIMULATION PANELS CONFIGURED YET
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted">
              Bu projede henüz kayıtlı bir sanal enstrüman veya simülasyon paneli bulunmuyor. Oluşturacağınız tüm paneller otomatik olarak{' '}
              <span className="font-mono text-ink">.nexusproj.json</span> ile senkronize edilir ve masaüstü{' '}
              <span className="font-mono text-ink">NexusCAN</span> istemcisinde birebir açılır.
            </p>

            <div className="mt-5 flex flex-wrap gap-2">
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
                  className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[2px] px-3.5 font-mono text-[11px] font-semibold uppercase text-white disabled:opacity-50"
                  style={{ backgroundColor: 'var(--status-focus)' }}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  CREATE BLANK 24-COL PANEL
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
                    className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[2px] border border-strong bg-elevated px-3.5 font-mono text-[11px] font-semibold uppercase text-ink hover:bg-hover disabled:opacity-50"
                  >
                    <Database
                      className="h-3.5 w-3.5 text-nominal"
                      aria-hidden="true"
                    />
                    DBC&apos;DEN TASLAK OLUŞTUR... ({loadedDbEntries.length} VERİTABANI)
                  </button>
                )}

              {canMutate && (
                <button
                  type="button"
                  onClick={() => importFileInputRef.current?.click()}
                  className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-[11px] uppercase text-muted hover:border-strong hover:text-ink"
                >
                  <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                  IMPORT .NEXUSPANEL.JSON
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

            {/* Center 24-Col Industrial Grid Canvas */}
            <div
              className="min-h-0 flex-1 overflow-auto p-3"
              onClick={(e) => {
                if (e.target === e.currentTarget && workbenchMode === 'design') {
                  setSelectedWidgetId(null);
                }
              }}
            >
              <div
                ref={gridContainerRef}
                onDragOver={handleCanvasDragOver}
                onDragLeave={handleCanvasDragLeave}
                onDrop={handleCanvasDrop}
                onClick={(e) => {
                  if (
                    e.target === e.currentTarget &&
                    workbenchMode === 'design'
                  ) {
                    setSelectedWidgetId(null);
                  }
                }}
                style={{
                  minHeight: `${canvasMinHeightPx}px`,
                  ...(workbenchMode === 'design'
                    ? {
                        backgroundImage:
                          'linear-gradient(to right, var(--canvas-grid) 1px, transparent 1px), linear-gradient(to bottom, var(--canvas-grid) 1px, transparent 1px)',
                        backgroundSize: `calc(100% / ${gridCols}) ${rowHeightPx}px`,
                      }
                    : {}),
                }}
                className={`relative w-full min-w-[720px] rounded-[2px] ${
                  workbenchMode === 'design'
                    ? 'border border-hairline bg-canvas'
                    : 'bg-canvas'
                }`}
              >
                {/* Empty Panel Guided Action inside 24-Col Grid */}
                {activePanel.widgets.length === 0 && (
                  <div className="absolute inset-0 flex items-center justify-center p-6">
                    <div className="max-w-md rounded-[2px] border border-hairline bg-surface p-5 text-center">
                      <p className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                        EMPTY 24-COLUMN INSTRUMENT GRID
                      </p>
                      <p className="mt-1.5 text-xs text-muted">
                        Sol paletten gösterge, OSM/GNSS haritası, 60 FPS osiloskop veya sanal kontrol ekleyebilir; ya da yüklü .dbc şemasından başlangıç panelini tek tıkla üretebilirsiniz.
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
                            DBC&apos;DEN TASLAK DOLDUR... ({loadedDbEntries.length} VERİTABANI)
                          </button>
                        )}
                    </div>
                  </div>
                )}

                {/* Positioned Widgets */}
                {orderedWidgets.map((widget) => {
                  const isSelected =
                    workbenchMode === 'design' &&
                    selectedWidgetId === widget.id;
                  const isGroup = widget.kind === 'group';
                  const isDragHoverTarget =
                    workbenchMode === 'design' &&
                    isGroup &&
                    dragHoverGroupId === widget.id;
                  const groupChildCount = isGroup
                    ? (groupChildCountById[widget.id] ?? 0)
                    : 0;
                  const leftPct = (widget.layout.col / gridCols) * 100;
                  const widthPct = (widget.layout.w / gridCols) * 100;
                  const topPx = widget.layout.row * rowHeightPx;
                  const heightPx = widget.layout.h * rowHeightPx;
                  const accentHex = ACCENT_HEX_MAP[widget.accentColor];
                  const headerDbName =
                    widget.binding?.databaseName ??
                    widget.config.lonBinding?.databaseName ??
                    null;
                  const headerMsgKey =
                    widget.binding?.messageKey ??
                    widget.config.lonBinding?.messageKey ??
                    null;

                  return (
                    <div
                      key={widget.id}
                      style={{
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        top: `${topPx}px`,
                        height: `${heightPx}px`,
                        zIndex: isGroup
                          ? isSelected || isDragHoverTarget
                            ? 5
                            : 1
                          : isSelected
                            ? 30
                            : 10,
                      }}
                      className={`absolute p-[3px] ${
                        isGroup && workbenchMode === 'run'
                          ? 'pointer-events-none'
                          : 'pointer-events-auto'
                      }`}
                    >
                      <div
                        onClick={(e) => {
                          if (workbenchMode === 'design') {
                            e.stopPropagation();
                            setSelectedWidgetId(widget.id);
                            setSuppressAutoGroupTarget(false);
                          }
                        }}
                        style={{
                          borderColor:
                            isDragHoverTarget || isSelected
                              ? 'var(--status-focus)'
                              : isGroup
                                ? 'var(--border-strong)'
                                : 'var(--border-hairline)',
                        }}
                        className={`flex h-full w-full flex-col overflow-hidden rounded-[2px] border ${
                          isGroup ? 'bg-surface/35' : 'bg-surface'
                        }`}
                      >
                        {/* Crisp Instrument Header Bar */}
                        <div
                          onPointerDown={(e) => {
                            if (workbenchMode !== 'design' || !canMutate) return;
                            if ((e.target as HTMLElement).closest('button')) {
                              return;
                            }
                            e.preventDefault();
                            e.stopPropagation();
                            setSelectedWidgetId(widget.id);
                            setSuppressAutoGroupTarget(false);
                            const childOffsets: DragGroupChildOffset[] =
                              widget.kind === 'group'
                                ? activePanel.widgets
                                    .filter((child) =>
                                      isWidgetInsideGroup(child, widget)
                                    )
                                    .map((child) => ({
                                      id: child.id,
                                      origCol: child.layout.col,
                                      origRow: child.layout.row,
                                      w: child.layout.w,
                                      h: child.layout.h,
                                    }))
                                : [];
                            dragStateRef.current = {
                              mode: 'move',
                              widgetId: widget.id,
                              widgetKind: widget.kind,
                              startClientX: e.clientX,
                              startClientY: e.clientY,
                              origCol: widget.layout.col,
                              origRow: widget.layout.row,
                              origW: widget.layout.w,
                              origH: widget.layout.h,
                              childOffsets,
                            };
                          }}
                          className={`pointer-events-auto flex h-6 shrink-0 select-none items-center justify-between gap-1.5 border-b border-hairline bg-elevated px-2 font-mono text-[10px] tabular-nums ${
                            workbenchMode === 'design' && canMutate
                              ? 'cursor-move'
                              : ''
                          }`}
                        >
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span
                              className="h-2 w-1 shrink-0 rounded-[1px]"
                              style={{ backgroundColor: accentHex }}
                              aria-hidden="true"
                            />
                            {workbenchMode === 'design' && canMutate && (
                              <GripHorizontal
                                className="h-3 w-3 shrink-0 text-subtle"
                                aria-hidden="true"
                              />
                            )}
                            <span className="truncate font-semibold uppercase tracking-wider text-ink">
                              {widget.title}
                            </span>
                            {isGroup && widget.config.subtitle && (
                              <span className="hidden truncate text-[9px] text-muted sm:inline">
                                // {widget.config.subtitle}
                              </span>
                            )}
                          </div>

                          <div className="flex shrink-0 items-center gap-1">
                            {workbenchMode === 'design' ? (
                              <>
                                {isDragHoverTarget && (
                                  <span
                                    className="rounded-[2px] border bg-canvas px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-focus"
                                    style={{
                                      borderColor: 'var(--status-focus)',
                                    }}
                                  >
                                    [+ GRUBA BIRAK]
                                  </span>
                                )}
                                {isGroup && (
                                  <span className="rounded-[2px] border border-hairline bg-canvas px-1 py-0.5 font-mono text-[9px] font-semibold tabular-nums text-muted">
                                    [{groupChildCount} ÖĞE]
                                  </span>
                                )}
                                {headerDbName && (
                                  <span className="hidden max-w-[74px] truncate rounded-[1px] border border-hairline bg-canvas px-1 text-[8px] text-muted xl:inline">
                                    {headerDbName}
                                  </span>
                                )}
                                <span className="text-[9px] text-subtle">
                                  {widget.layout.col},{widget.layout.row}{' '}
                                  {widget.layout.w}×{widget.layout.h}
                                </span>
                                {isSelected && canMutate && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleDuplicateWidget(widget.id);
                                      }}
                                      title="Widget kopyala"
                                      aria-label="Widget kopyala"
                                      className="cursor-pointer rounded-[2px] p-0.5 text-muted hover:bg-surface hover:text-ink"
                                    >
                                      <Copy className="h-2.5 w-2.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleDeleteWidget(widget.id);
                                      }}
                                      title="Widget sil"
                                      aria-label="Widget sil"
                                      className="cursor-pointer rounded-[2px] p-0.5 text-muted hover:bg-surface hover:text-critical"
                                    >
                                      <Trash2 className="h-2.5 w-2.5" />
                                    </button>
                                  </>
                                )}
                              </>
                            ) : (
                              headerMsgKey && (
                                <span className="max-w-[130px] truncate text-[9px] text-subtle">
                                  {headerDbName ? `[${headerDbName}] ` : ''}
                                  {headerMsgKey}
                                </span>
                              )
                            )}
                          </div>
                        </div>

                        {/* Widget Instrument Body */}
                        <div className="relative min-h-0 flex-1">
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
                        </div>

                        {/* Bottom-Right Machined Resize Handle (DESIGN Mode) */}
                        {workbenchMode === 'design' && canMutate && (
                          <div
                            onPointerDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setSelectedWidgetId(widget.id);
                              setSuppressAutoGroupTarget(false);
                              dragStateRef.current = {
                                mode: 'resize',
                                widgetId: widget.id,
                                widgetKind: widget.kind,
                                startClientX: e.clientX,
                                startClientY: e.clientY,
                                origCol: widget.layout.col,
                                origRow: widget.layout.row,
                                origW: widget.layout.w,
                                origH: widget.layout.h,
                                childOffsets: [],
                              };
                            }}
                            title="Boyutlandırmak için sürükleyin (w, h)"
                            className="pointer-events-auto absolute right-[3px] bottom-[3px] z-20 flex h-3.5 w-3.5 cursor-se-resize items-end justify-end border-t border-l border-strong bg-elevated p-0.5 hover:border-focus"
                          >
                            <span
                              className="h-1.5 w-1.5 border-r border-b border-ink"
                              aria-hidden="true"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

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
