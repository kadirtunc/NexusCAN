import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from './i18n';
import { CloudWorkspaceView } from './components/CloudWorkspaceView';
import { SimulationWorkbenchView } from './components/simulation/SimulationWorkbenchView';
import { CloudPushPromptModal } from './components/CloudPushPromptModal';
import { ContextMenu, openContextMenu, showContextMenu, type ContextMenuItem } from './components/ContextMenu';
import { ConnectionsView } from './components/ConnectionsView';
import { NewConnectionModal } from './components/NewConnectionModal';
import { PlotterView } from './components/PlotterView';
import { ProjectExplorerDock } from './components/ProjectExplorerDock';
import { ProjectModal } from './components/ProjectModal';
import { BottomConnectionsDock } from './components/BottomConnectionsDock';
import { GuideInfoDialog } from './onboarding/GuideInfoDialog';
import { ChangelogDialog } from './components/ChangelogDialog';
import { UpdateNotice, VersionStatus } from './components/UpdateNotice';
import { updateStore } from './store/updateStore';
import { ReceiveTransmitView } from './components/ReceiveTransmitView';
import { StartPageView } from './components/StartPageView';
import { SymbolsLayoutView } from './components/SymbolsLayoutView';
import { ToolpacksModal } from './components/ToolpacksModal';
import { AcknowledgmentsModal } from './components/AcknowledgmentsModal';
import { McpServerPanel } from './components/McpServerPanel';
import { McpUiOverlay } from './components/McpUiOverlay';
import { attachMcpUiBridge } from './services/mcpUiBridge';
import { mcpStore } from './store/mcpStore';
import { DiagnosticsView } from './components/diagnostics/DiagnosticsView';
import { type StatusBanner, TopBar } from './components/TopBar';
import { TraceView } from './components/TraceView';
import { openTraceWindow, type TraceWindowHandle } from './services/traceWindow';
import {
  apiClearDatabase,
  apiListDevices,
  resetSessionCompat,
  apiResetTelemetry,
  apiSetBusMode,
  subscribeHardwareChanges,
  subscribeTelemetry,
} from './services/ipcClient';
import { connectionStore, useConnectionStore } from './store/connectionStore';
import { cloudBridgeStore, useCloudBridgeHeader } from './store/cloudBridgeStore';
import { isExperimentalCloudEnabled, useExperimentalCloud } from './store/experimentalStore';
import { databaseStore, useDatabaseStore, type ActiveDocumentTab } from './store/databaseStore';
import { ReSnifferView } from './components/re/ReSnifferView';
import { plotStore, usePlotStore } from './store/plotStore';
import { useSimulationPanelStore } from './store/simulationPanelStore';
import {
  type QuickBarConnectionState,
  projectStore,
  useProjectStore,
} from './store/projectStore';
import { isToolpackEnabled } from './types/toolpacks';
import { telemetryStore, useTelemetryHeader, useTelemetryIndicators } from './store/telemetryStore';
import { transmitStore, useTransmitStore } from './store/transmitStore';
import { ImportedProjectNotice } from './components/ImportedProjectNotice';
import { panicInFlightBuses, performPanicStop } from './store/panicStop';
import { workbenchStore, useWorkbenchStore } from './store/workbenchStore';
import { traceSessionsStore, useTraceSessionsStore } from './store/traceSessionsStore';
import { DebugConsolePanel } from './components/DebugConsolePanel';
import {
  debugConsoleStore,
  useDebugConsoleStore,
  initDebugConsoleSubscription,
} from './store/debugConsoleStore';
import type { DeviceDescriptorDto } from './types/hal';
import { installBusDatabaseAutoSync } from './utils/busDatabaseSync';
import { Compass, Plus, X } from 'lucide-react';
import { TabStripScroller } from './components/TabStripScroller';
import { FlowPromptHost } from './components/flow/FlowPromptHost';

const QUICK_NAVIGATION_ENABLED = false;

export const App: React.FC = () => {
  const { t } = useI18n();
  useEffect(installBusDatabaseAutoSync, []);
  const dbState = useDatabaseStore();
  const header = useTelemetryHeader();
  const { fpsRx, estimatedBusLoadPct } = useTelemetryIndicators();
  const projState = useProjectStore();
  const connState = useConnectionStore();
  const txState = useTransmitStore();
  const plotState = usePlotStore();
  const simState = useSimulationPanelStore();
  const cloudHeader = useCloudBridgeHeader();
  const cloudOn = useExperimentalCloud();
  const workbench = useWorkbenchStore();
  const traceState = useTraceSessionsStore();
  const debugConsole = useDebugConsoleStore();

  const [devices, setDevices] = useState<readonly DeviceDescriptorDto[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [mockFpsPreset, setMockFpsPreset] = useState<number | null>(null);
  const [bitrateProfileId, setBitrateProfileId] = useState<string>('fd_500k_2m');
  const [listenOnly, setListenOnly] = useState<boolean>(true);
  const [, setBusyBusAction] = useState<boolean>(false);

  const [statusBanner, setStatusBanner] = useState<StatusBanner | null>(null);
  const [panicCounter, setPanicCounter] = useState<number>(0);

  const detachedTraceWindows = useRef(new Map<string, TraceWindowHandle>());
  const [detachedTraceIds, setDetachedTraceIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const windows = detachedTraceWindows.current;
    return () => { for (const traceWindow of windows.values()) traceWindow.close(); };
  }, []);

  const handleOpenTraceWindow = async (sessionId: string): Promise<void> => {
    const windows = detachedTraceWindows.current;
    const existing = windows.get(sessionId);
    if (existing) {
      existing.focus();
      return;
    }

    let handle: TraceWindowHandle | undefined;
    try {
      handle = openTraceWindow(sessionId, () => {
        if (windows.get(sessionId) !== handle) return;
        windows.delete(sessionId);
        setDetachedTraceIds((previous) => {
          const next = new Set(previous);
          next.delete(sessionId);
          return next;
        });
      });
      windows.set(sessionId, handle);
      await handle.ready;
      if (windows.get(sessionId) === handle) {
        setDetachedTraceIds((previous) => new Set(previous).add(sessionId));
      }
    } catch (error) {
      if (windows.get(sessionId) === handle) windows.delete(sessionId);
      setStatusBanner({
        kind: 'error',
        message: t('trace.window.openFailed', { error: error instanceof Error ? error.message : String(error) }),
      });
    }
  };

  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const [isDraggingSplit, setIsDraggingSplit] = useState<boolean>(false);

  const connectedBuses = header.buses.filter((b) => b.connected);
  const connectedBusCount = connectedBuses.length;
  const hasLiveBus = header.transportConnected && connectedBusCount > 0;

  const quickBarState: QuickBarConnectionState = useMemo(
    () => ({
      selectedDeviceId,
      bitrateProfileId,
      mockFpsPreset,
      listenOnly,
    }),
    [selectedDeviceId, bitrateProfileId, mockFpsPreset, listenOnly],
  );

  const applyQuickBarState = useCallback((qb: QuickBarConnectionState): void => {
    if (qb.selectedDeviceId) {
      setSelectedDeviceId(qb.selectedDeviceId);
    }
    if (qb.bitrateProfileId) {
      setBitrateProfileId(qb.bitrateProfileId);
    }
    setMockFpsPreset(qb.mockFpsPreset ?? null);
    setListenOnly(qb.listenOnly ?? true);
  }, []);

  const refreshDevices = useCallback(async (): Promise<void> => {
    try {
      const list = await apiListDevices();
      setDevices(list);
    } catch {
      // Backend bridge may still be starting
    }
  }, []);

  // Update notification: automatic check 5 s after startup (silent on failure; notification only).
  useEffect(() => updateStore.startAutoCheck(), []);

  useEffect(() => {
    if (devices.length === 0) return;
    if (!selectedDeviceId || !devices.some((d) => d.deviceId === selectedDeviceId)) {
      const socketcanDev = devices.find((d) => d.driverId === 'socketcan');
      const nonMockDev = devices.find(
        (d) =>
          !d.driverId.toLowerCase().includes('mock') &&
          !d.channelName.toLowerCase().includes('mock'),
      );
      setSelectedDeviceId((socketcanDev ?? nonMockDev ?? devices[0]).deviceId);
    }
  }, [devices, selectedDeviceId]);

  const coldStartDoneRef = useRef<boolean>(false);
  const coldStartCompletedRef = useRef<boolean>(false);
  const prevCloudOnRef = useRef<boolean>(false);

  useEffect(() => {
    if (!coldStartDoneRef.current) {
      coldStartDoneRef.current = true;
      void (async () => {
        const restored = await projectStore.restoreActiveSessionOnReload(applyQuickBarState);
        if (!restored) {
          // Fresh start: reset WITHOUT latching panic (legacy fallback inside).
          await resetSessionCompat();
          // Profiles are project-scoped: with no workspace restored, drop any stale profiles
          // left in localStorage by an earlier build/session so the app opens with zero buses.
          connectionStore.resetToDefaults();
          await apiClearDatabase().catch(() => undefined);
          await apiResetTelemetry().catch(() => undefined);
          telemetryStore.clearAllBuses();
          telemetryStore.clearAllTelemetry();
          databaseStore.clearAll();
          transmitStore.clearAll();
        }
        await Promise.all([refreshDevices(), projectStore.refreshSavedProjects()]);
        coldStartCompletedRef.current = true;
        if (isExperimentalCloudEnabled()) {
          cloudBridgeStore.initializeLifecycle();
        }
      })();
    } else if (coldStartCompletedRef.current && isExperimentalCloudEnabled()) {
      // Idempotent guard: re-initializes if cloudBridgeStore was hot-reloaded via Vite HMR
      cloudBridgeStore.initializeLifecycle();
    }

    const unsubscribe = subscribeTelemetry(
      (snap) => {
        telemetryStore.ingestSnapshot(snap);
      },
      (connected) => {
        telemetryStore.setTransportStatus(connected);
      },
    );

    const unsubHw = subscribeHardwareChanges((ev) => {
      setDevices(ev.devices);
      connectionStore.setProbeReport(ev.report);
    });

    return () => {
      unsubscribe();
      unsubHw();
    };
  }, [applyQuickBarState, refreshDevices]);

  // MCP server status: single refresh at startup (polling only while running / panel open).
  useEffect(() => {
    void mcpStore.refresh();
    void attachMcpUiBridge(); // Tauri only; no-op in browser mode
  }, []);

  // Dedicated debug console subscription: empty dependency array prevents re-subscription churn
  useEffect(() => {
    const unsubDebug = initDebugConsoleSubscription();
    return () => {
      unsubDebug();
    };
  }, []);

  const busesSummary = useMemo(
    () =>
      header.buses
        .map((b) => `${b.busId}:${b.connected}:${b.listenOnly}`)
        .join(','),
    [header.buses],
  );

  useEffect(() => {
    if (!projState.hasActiveWorkspace) return;
    projectStore.scheduleAutoSave(quickBarState);
  }, [
    projState.hasActiveWorkspace,
    projState.enabledToolpacks,
    quickBarState,
    dbState.usePresetDb,
    dbState.customDbFiles,
    dbState.activeDocTab,
    dbState.theme,
    dbState.expandedRxKeys,
    connState.profiles,
    txState.configRevision,
    plotState.series,
    plotState.layoutMode,
    plotState.configRev,
    simState.configRev,
    busesSummary,
  ]);

  const handleSwitchToActiveTx = useCallback(
    async (targetBusId?: number): Promise<void> => {
      const activeBus =
        targetBusId !== undefined
          ? connectedBuses.find((b) => b.busId === targetBusId)
          : connectedBuses[0];

      if (!activeBus) {
        const busNum = targetBusId !== undefined ? targetBusId + 1 : 1;
        setStatusBanner({
          kind: 'error',
          message: t('shell.app.busOffline', { busNum }),
        });
        return;
      }

      setBusyBusAction(true);
      try {
        const armedHealth = await apiSetBusMode(activeBus.busId, false, true);
        telemetryStore.upsertBusHealth(armedHealth);

        const conn = connectionStore.getState();
        const matchingProf = conn.profiles.find(
          (p) => p.busId === activeBus.busId && p.deviceId === armedHealth.deviceId,
        );
        if (matchingProf) {
          connectionStore.upsertProfile({ ...matchingProf, listenOnly: false });
        }

        setStatusBanner({
          kind: 'success',
          message: t('shell.app.activeTxArmed', {
            busNum: activeBus.busId + 1,
            channel: armedHealth.channelName,
          }),
        });
      } catch (err) {
        setStatusBanner({
          kind: 'error',
          message: t('shell.app.activeTxFailed', {
            error: err instanceof Error ? err.message : String(err),
          }),
        });
      } finally {
        setBusyBusAction(false);
      }
    },
    [connectedBuses, t],
  );

  const handleQuickSaveProject = useCallback(async (): Promise<void> => {
    try {
      const saved = await projectStore.saveCurrentProject(quickBarState);
      setStatusBanner({
        kind: 'success',
        message: t('shell.app.projectSaved', {
          name: saved.name,
          fileStem: saved.fileStem,
        }),
      });
    } catch (err) {
      setStatusBanner({
        kind: 'info',
        message: t('shell.app.projectCachedLocally', {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  }, [quickBarState, t]);

  const handlePanicStop = useCallback(async (): Promise<void> => {
    setPanicCounter((c) => c + 1);
    try {
      const res = await performPanicStop();
      const stuck = panicInFlightBuses(res);
      // Persistent (status bar keeps the message until replaced): the adapter may still be transmitting.
      setStatusBanner({
        kind: 'error',
        message:
          stuck !== null
            ? t('sec.panic.inFlightTimeout', { buses: stuck })
            : t('shell.app.panicStopSuccess', {
                stopped: res.stoppedPeriodicJobs,
                disarmed: res.disarmedBuses,
              }),
      });
    } catch (err) {
      setStatusBanner({
        kind: 'error',
        message: t('shell.app.panicStopError', {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  }, [t]);

  const handleClearWorkspace = useCallback(async (): Promise<void> => {
    await apiResetTelemetry().catch(() => undefined);
    telemetryStore.clearAllTelemetry();
    transmitStore.resetCounters();
    traceSessionsStore.clearSession(traceState.activeSessionId);
    const isPlotterActive = databaseStore.getState().activeDocTab === 'plotter';
    if (isPlotterActive) {
      plotStore.clearBuffers();
    }
    setStatusBanner({
      kind: 'info',
      message: isPlotterActive
        ? t('shell.app.clearedAllBuffers')
        : t('shell.app.clearedTraceBuffers'),
    });
  }, [traceState.activeSessionId, t]);

  // Split view dragging handler
  const handleSplitMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault();
    setIsDraggingSplit(true);
  };

  useEffect(() => {
    if (!isDraggingSplit) return;
    const onMouseMove = (ev: MouseEvent): void => {
      if (!splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      workbenchStore.setSplitLeftRatioPct(pct);
    };
    const onMouseUp = (): void => {
      setIsDraggingSplit(false);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDraggingSplit]);

  // Global Shortcuts: Ctrl+S (Quick Save), Ctrl+B (Toggle Dock), Ctrl+Shift+T (New Trace), Esc (Clear / Reset), Ctrl+Shift+Space (Panic Stop TX)
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent): void => {
      if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === 's') {
        ev.preventDefault();
        void handleQuickSaveProject();
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === 'b') {
        ev.preventDefault();
        workbenchStore.toggleDock();
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === 't') {
        ev.preventDefault();
        const created = traceSessionsStore.spawnNewTraceSession({ autoStart: true });
        databaseStore.setActiveDocTab('trace');
        setStatusBanner({
          kind: 'success',
          message: t('shell.app.traceSessionSpawned', { name: created.name }),
        });
        return;
      }
      if (ev.ctrlKey && ev.shiftKey && ev.code === 'Space') {
        ev.preventDefault();
        void handlePanicStop();
        return;
      }
      if (
        (ev.ctrlKey || ev.metaKey) &&
        (ev.key === '`' || (ev.shiftKey && ev.key.toLowerCase() === 'd'))
      ) {
        ev.preventDefault();
        debugConsoleStore.toggleDockOpen();
        return;
      }
      if (
        ev.code === 'Escape' &&
        !projState.modalOpen &&
        !workbenchStore.getState().newConnectionModalOpen
      ) {
        const tag = (ev.target as HTMLElement | null)?.tagName;
        if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
          ev.preventDefault();
          void handleClearWorkspace();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    handleQuickSaveProject,
    handlePanicStop,
    handleClearWorkspace,
    projState.modalOpen,
  ]);

  const isSimEnabled = isToolpackEnabled(projState.enabledToolpacks, 'simulation_replay');
  const isDiagEnabled = isToolpackEnabled(projState.enabledToolpacks, 'automotive_diagnostics');
  const navItems: ContextMenuItem[] = [];
  const addNavItem = (tab: ActiveDocumentTab, label: string): void => {
    navItems.push({
      label,
      run: () => databaseStore.setActiveDocTab(tab),
      disabled: dbState.activeDocTab === tab,
    });
  };
  addNavItem('start', t('shell.tab.workspace'));
  addNavItem('rxtx', t('shell.tab.rxtx'));
  addNavItem('trace', t('shell.tab.trace'));
  addNavItem('plotter', t('shell.tab.plotter'));
  addNavItem('symbols', t('shell.tab.dbcStudio'));
  addNavItem('connections', t('shell.tab.connections'));
  if (isSimEnabled) addNavItem('panels', t('shell.tab.panels'));
  if (isDiagEnabled) addNavItem('diagnostics', t('shell.tab.diagnostics'));
  addNavItem('re', t('re.tab.title'));
  if (cloudOn) addNavItem('cloud', t('shell.tab.cloud'));

  const openQuickNavigation = (event: React.MouseEvent<HTMLElement>): void => {
    event.preventDefault();
    const anchor = event.currentTarget;
    const rect = anchor.getBoundingClientRect();
    showContextMenu({
      x: event.clientX || rect.left,
      y: event.clientY || rect.bottom,
      anchor,
      items: navItems,
      navigation: true,
    });
  };


  useEffect(() => {
    if (!isSimEnabled && dbState.activeDocTab === 'panels') {
      databaseStore.setActiveDocTab('rxtx');
    }
  }, [isSimEnabled, dbState.activeDocTab]);

  useEffect(() => {
    if (!isDiagEnabled && dbState.activeDocTab === 'diagnostics') {
      databaseStore.setActiveDocTab('rxtx');
    }
  }, [isDiagEnabled, dbState.activeDocTab]);

  // NexusCloud is experimental (default OFF). Enabling it after cold start
  // initializes the bridge lifecycle; disabling it stops any live stream and
  // moves every cloud-only view back to a local one.
  useEffect(() => {
    if (cloudOn) {
      prevCloudOnRef.current = true;
      if (coldStartCompletedRef.current) {
        cloudBridgeStore.initializeLifecycle();
      }
      return;
    }
    if (prevCloudOnRef.current) {
      cloudBridgeStore.stopLiveStream();
    }
    prevCloudOnRef.current = false;
    if (dbState.activeDocTab === 'cloud') {
      databaseStore.setActiveDocTab('start');
    }
    if (workbenchStore.getState().bottomTab === 'cloud') {
      workbenchStore.setBottomTab('watch');
    }
    if (workbench.splitSecondaryTab === 'cloud') {
      workbenchStore.setSplitSecondaryTab(null);
    }
  }, [cloudOn, dbState.activeDocTab, workbench.splitSecondaryTab]);

  const cloudTabLabel =
    cloudHeader.cloudCapturing
      ? `${t('shell.tab.cloud')} (REC)`
      : cloudHeader.status === 'streaming'
        ? `${t('shell.tab.cloud')} (LIVE)`
        : cloudHeader.remoteUpdateAvailableRev !== null
          ? `${t('shell.tab.cloud')} (↓#${cloudHeader.remoteUpdateAvailableRev})`
          : t('shell.tab.cloud');

  const renderDocPane = (
    tab: ActiveDocumentTab,
    overrideTraceSessionId?: string | null,
  ): React.ReactNode => {
    switch (tab) {
      case 'start':
        return (
          <StartPageView
            devices={devices}
            onRefreshDevices={refreshDevices}
            onStatusMessage={setStatusBanner}
            quickBarState={quickBarState}
            onApplyQuickBar={applyQuickBarState}
          />
        );
      case 'rxtx':
        return (
          <ReceiveTransmitView
            devices={devices}
            bitrateProfileId={bitrateProfileId}
            mockFpsPreset={mockFpsPreset}
            statusBanner={statusBanner}
            onStatusMessage={setStatusBanner}
            onSwitchToActiveTx={handleSwitchToActiveTx}
            panicCounter={panicCounter}
          />
        );
      case 'connections':
        return (
          <ConnectionsView
            devices={devices}
            onRefreshDevices={refreshDevices}
            onStatusMessage={setStatusBanner}
          />
        );
      case 'plotter':
        return <PlotterView />;
      case 'trace': {
        const sessionId = overrideTraceSessionId ?? traceState.activeSessionId;
        if (detachedTraceIds.has(sessionId)) {
          return (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[12px] text-[var(--text-secondary)]">
              <div>{t('trace.window.detached')}</div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => detachedTraceWindows.current.get(sessionId)?.focus()}
                  className="h-[28px] px-2 border border-strong bg-panel text-[var(--text-primary)] cursor-pointer"
                >
                  {t('trace.window.focus')}
                </button>
                <button
                  type="button"
                  onClick={() => detachedTraceWindows.current.get(sessionId)?.close()}
                  className="h-[28px] px-2 border border-strong bg-panel text-[var(--text-primary)] cursor-pointer"
                >
                  {t('trace.window.dock')}
                </button>
              </div>
            </div>
          );
        }
        return <TraceView sessionId={sessionId} onStatusMessage={setStatusBanner} />;
      }
      case 'symbols':
        return <SymbolsLayoutView />;
      case 'panels':
        return (
          <SimulationWorkbenchView
            onNavigateToTab={(t) => databaseStore.setActiveDocTab(t as ActiveDocumentTab)}
          />
        );
      case 'cloud':
        if (!cloudOn) return null;
        return (
          <CloudWorkspaceView
            quickBarState={quickBarState}
            onApplyQuickBar={applyQuickBarState}
            onStatusMessage={setStatusBanner}
          />
        );
      case 'diagnostics':
        return <DiagnosticsView />;
      case 're':
        return <ReSnifferView />;
      default:
        return null;
    }
  };

  const isSplitActive =
    workbench.splitSecondaryTab !== null &&
    workbench.splitSecondaryTab !== dbState.activeDocTab;

  const secondaryTabOptionLabel = (tab: ActiveDocumentTab): string => {
    switch (tab) {
      case 'trace':
        return t('shell.tab.trace');
      case 'plotter':
        return t('shell.tab.plotter');
      case 'symbols':
        return t('shell.tab.dbcStudio');
      case 'connections':
        return t('shell.tab.connections');
      case 'rxtx':
        return t('shell.tab.rxtx');
      case 'panels':
        return t('shell.tab.panels');
      case 'cloud':
        return t('shell.tab.cloud');
      case 'diagnostics':
        return t('shell.tab.diagnostics');
      case 're':
        return t('re.tab.title');
      case 'start':
        return t('shell.tab.workspace');
    }
  };

  const handleBottomResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = debugConsoleStore.getState().bottomHeightPx;
    const onMove = (moveEv: MouseEvent) => {
      const delta = startY - moveEv.clientY;
      debugConsoleStore.setBottomHeight(startH + delta);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const handleRightResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = debugConsoleStore.getState().rightWidthPx;
    const onMove = (moveEv: MouseEvent) => {
      const delta = startX - moveEv.clientX;
      debugConsoleStore.setRightWidth(startW + delta);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const handleFloatingDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const currentRect = debugConsoleStore.getState().floatingRect;
    const onMove = (moveEv: MouseEvent) => {
      const deltaX = moveEv.clientX - startX;
      const deltaY = moveEv.clientY - startY;
      debugConsoleStore.setFloatingRect({
        ...currentRect,
        x: Math.max(0, currentRect.x + deltaX),
        y: Math.max(0, currentRect.y + deltaY),
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  return (
    <div
      style={{ backgroundColor: 'var(--bg-app)', color: 'var(--text-primary)' }}
      className="h-screen w-screen flex flex-col overflow-hidden"
    >
      <TopBar
        devices={devices}
        onQuickSaveProject={handleQuickSaveProject}
        onPanicStop={handlePanicStop}
        onClearWorkspace={handleClearWorkspace}
        onStatusMessage={setStatusBanner}
        onApplyQuickBar={applyQuickBarState}
      />
      <ImportedProjectNotice />

      {/* Main Body: Center Tabbed / Split Workspace + Side ProjectExplorerDock */}
      <div className="flex-1 min-h-0 flex flex-row overflow-hidden select-none">
        {/* Left-docked ProjectExplorerDock */}
        {workbench.dockOpen && workbench.dockPosition === 'left' && (
          <aside
            style={{ width: `${workbench.dockWidthPx}px` }}
            className="shrink-0 h-full flex flex-col border-r border-[var(--border-strong)] overflow-hidden"
          >
            <ProjectExplorerDock
              devices={devices}
              quickBarState={quickBarState}
              onApplyQuickBar={applyQuickBarState}
              onQuickSaveProject={handleQuickSaveProject}
              onStatusMessage={setStatusBanner}
            />
          </aside>
        )}

        {/* Center Work Column */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
          {/* 1. Document Tab Bar (40px) */}
          <nav
            onContextMenu={(event) => openContextMenu(event, navItems)}
            onMouseDown={QUICK_NAVIGATION_ENABLED ? (event) => {
              if (event.button === 1 && event.target instanceof Element && !event.target.closest('button, a')) {
                event.preventDefault();
              }
            } : undefined}
            onAuxClick={QUICK_NAVIGATION_ENABLED ? (event) => {
              if (event.button === 1 && event.target instanceof Element && !event.target.closest('button, a')) {
                openQuickNavigation(event);
              }
            } : undefined}
            style={{
              backgroundColor: 'var(--bg-header)',
              borderBottom: '1px solid var(--border-strong)',
            }}
            className="h-[40px] px-2.5 flex flex-nowrap items-end justify-between gap-2 shrink-0 min-w-0"
          >
            <TabStripScroller
              activeKey={`${dbState.activeDocTab}:${traceState.activeSessionId}`}
              leftTitle={t('shell.tabs.scrollLeft')}
              rightTitle={t('shell.tabs.scrollRight')}
            >
              {/* 1. Workspace */}
              <button
                type="button"
                onClick={() => databaseStore.setActiveDocTab('start')}
                data-tab-active={dbState.activeDocTab === 'start' ? 'true' : undefined}
                style={{
                  backgroundColor: dbState.activeDocTab === 'start' ? 'var(--bg-panel)' : 'transparent',
                  borderColor: dbState.activeDocTab === 'start' ? 'var(--border-strong)' : 'transparent',
                  color: dbState.activeDocTab === 'start' ? 'var(--text-primary)' : 'var(--text-secondary)',
                  borderBottomColor: dbState.activeDocTab === 'start' ? 'var(--bg-panel)' : 'transparent',
                }}
                className={`h-full px-3.5 xl:px-4 text-[13px] font-sans border-t border-l border-r cursor-pointer shrink-0 rounded-t-[3px] transition-colors ${
                  dbState.activeDocTab === 'start' ? 'font-semibold' : 'hover:text-[var(--text-primary)]'
                }`}
              >
                {t('shell.tab.workspace')}
              </button>

              {/* 2. Receive / Transmit */}
              <button
                type="button"
                onClick={() => databaseStore.setActiveDocTab('rxtx')}
                data-tab-active={dbState.activeDocTab === 'rxtx' ? 'true' : undefined}
                style={{
                  backgroundColor: dbState.activeDocTab === 'rxtx' ? 'var(--bg-panel)' : 'transparent',
                  borderColor: dbState.activeDocTab === 'rxtx' ? 'var(--border-strong)' : 'transparent',
                  color: dbState.activeDocTab === 'rxtx' ? 'var(--text-primary)' : 'var(--text-secondary)',
                  borderBottomColor: dbState.activeDocTab === 'rxtx' ? 'var(--bg-panel)' : 'transparent',
                }}
                className={`h-full px-3.5 xl:px-4 text-[13px] font-sans border-t border-l border-r cursor-pointer shrink-0 rounded-t-[3px] transition-colors ${
                  dbState.activeDocTab === 'rxtx' ? 'font-semibold' : 'hover:text-[var(--text-primary)]'
                }`}
              >
                {t('shell.tab.rxtx')}
              </button>

              {/* 3. DYNAMIC MULTI-TRACE TABS */}
              {traceState.sessions.map((sess) => {
                const isActive =
                  dbState.activeDocTab === 'trace' && traceState.activeSessionId === sess.id;
                return (
                  <div
                    key={sess.id}
                    data-tab-active={isActive ? 'true' : undefined}
                    onContextMenu={(event) => openContextMenu(event, [
                      {
                        label: t(detachedTraceIds.has(sess.id) ? 'trace.window.focus' : 'trace.window.open'),
                        run: () => void handleOpenTraceWindow(sess.id),
                      },
                      ...(detachedTraceIds.has(sess.id) ? [{
                        label: t('trace.window.dock'),
                        run: () => detachedTraceWindows.current.get(sess.id)?.close(),
                      }] : []),
                    ])}
                    onClick={() => {
                      traceSessionsStore.setActiveSession(sess.id);
                      databaseStore.setActiveDocTab('trace');
                    }}
                    style={{
                      backgroundColor: isActive ? 'var(--bg-panel)' : 'transparent',
                      borderColor: isActive ? 'var(--border-strong)' : 'transparent',
                      color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                      borderBottomColor: isActive ? 'var(--bg-panel)' : 'transparent',
                    }}
                    className={`h-full px-3 text-[13px] border-t border-l border-r cursor-pointer shrink-0 rounded-t-[3px] transition-colors flex items-center gap-1.5 ${
                      isActive ? 'font-sans font-semibold' : 'font-sans hover:text-[var(--text-primary)]'
                    }`}
                  >
                    <span
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                        sess.state === 'recording'
                          ? 'bg-critical animate-pulse'
                          : sess.state === 'paused'
                            ? 'bg-warn'
                            : 'bg-muted'
                      }`}
                      title={
                        sess.state === 'recording'
                          ? t('shell.trace.stateRecording')
                          : sess.state === 'paused'
                            ? t('shell.trace.statePaused')
                            : t('shell.trace.stateStopped')
                      }
                    />
                    <span>{sess.name}</span>
                    {sess.count > 0 && (
                      <span className="font-mono tabular-nums text-[11.5px] text-[var(--text-muted)]">
                        ({sess.count.toLocaleString('en-US')})
                      </span>
                    )}
                    {traceState.sessions.length > 1 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          traceSessionsStore.closeSession(sess.id);
                        }}
                        className="w-4 h-4 rounded flex items-center justify-center hover:bg-[var(--status-critical-bg)] hover:text-critical text-[var(--text-muted)] ml-1 text-[12px]"
                        title={t('shell.trace.closeSessionTooltip', { name: sess.name })}
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}

              {/* 4. Plotter */}
              <button
                type="button"
                onClick={() => databaseStore.setActiveDocTab('plotter')}
                data-tab-active={dbState.activeDocTab === 'plotter' ? 'true' : undefined}
                style={{
                  backgroundColor: dbState.activeDocTab === 'plotter' ? 'var(--bg-panel)' : 'transparent',
                  borderColor: dbState.activeDocTab === 'plotter' ? 'var(--border-strong)' : 'transparent',
                  color: dbState.activeDocTab === 'plotter' ? 'var(--text-primary)' : 'var(--text-secondary)',
                  borderBottomColor: dbState.activeDocTab === 'plotter' ? 'var(--bg-panel)' : 'transparent',
                }}
                className={`h-full px-3.5 xl:px-4 text-[13px] font-sans border-t border-l border-r cursor-pointer shrink-0 rounded-t-[3px] transition-colors ${
                  dbState.activeDocTab === 'plotter' ? 'font-semibold' : 'hover:text-[var(--text-primary)]'
                }`}
              >
                {plotState.series.length > 0 ? `${t('shell.tab.plotter')} (${plotState.series.length})` : t('shell.tab.plotter')}
              </button>

              {/* 5. DBC Studio */}
              <button
                type="button"
                onClick={() => databaseStore.setActiveDocTab('symbols')}
                data-tab-active={dbState.activeDocTab === 'symbols' ? 'true' : undefined}
                style={{
                  backgroundColor: dbState.activeDocTab === 'symbols' ? 'var(--bg-panel)' : 'transparent',
                  borderColor: dbState.activeDocTab === 'symbols' ? 'var(--border-strong)' : 'transparent',
                  color: dbState.activeDocTab === 'symbols' ? 'var(--text-primary)' : 'var(--text-secondary)',
                  borderBottomColor: dbState.activeDocTab === 'symbols' ? 'var(--bg-panel)' : 'transparent',
                }}
                className={`h-full px-3.5 xl:px-4 text-[13px] font-sans border-t border-l border-r cursor-pointer shrink-0 rounded-t-[3px] transition-colors ${
                  dbState.activeDocTab === 'symbols' ? 'font-semibold' : 'hover:text-[var(--text-primary)]'
                }`}
              >
                {dbState.databases.length > 0 ? `${t('shell.tab.dbcStudio')} (${dbState.databases.length})` : t('shell.tab.dbcStudio')}
              </button>

              {/* 6. Connections */}
              <button
                type="button"
                onClick={() => databaseStore.setActiveDocTab('connections')}
                data-tab-active={dbState.activeDocTab === 'connections' ? 'true' : undefined}
                style={{
                  backgroundColor: dbState.activeDocTab === 'connections' ? 'var(--bg-panel)' : 'transparent',
                  borderColor: dbState.activeDocTab === 'connections' ? 'var(--border-strong)' : 'transparent',
                  color: dbState.activeDocTab === 'connections' ? 'var(--text-primary)' : 'var(--text-secondary)',
                  borderBottomColor: dbState.activeDocTab === 'connections' ? 'var(--bg-panel)' : 'transparent',
                }}
                className={`h-full px-3.5 xl:px-4 text-[13px] font-sans border-t border-l border-r cursor-pointer shrink-0 rounded-t-[3px] transition-colors ${
                  dbState.activeDocTab === 'connections' ? 'font-semibold' : 'hover:text-[var(--text-primary)]'
                }`}
              >
                {connectedBusCount > 0 ? `${t('shell.tab.connections')} (${connectedBusCount})` : t('shell.tab.connections')}
              </button>

              {/* 7. Simülasyon (Local Panels) */}
              {isSimEnabled && (
                <button
                  type="button"
                  onClick={() => databaseStore.setActiveDocTab('panels')}
                  data-tab-active={dbState.activeDocTab === 'panels' ? 'true' : undefined}
                  style={{
                    backgroundColor: dbState.activeDocTab === 'panels' ? 'var(--bg-panel)' : 'transparent',
                    borderColor: dbState.activeDocTab === 'panels' ? 'var(--border-strong)' : 'transparent',
                    color: dbState.activeDocTab === 'panels' ? 'var(--status-warn)' : 'var(--text-secondary)',
                    borderBottomColor: dbState.activeDocTab === 'panels' ? 'var(--bg-panel)' : 'transparent',
                  }}
                  className={`h-full px-3.5 xl:px-4 text-[13px] font-sans border-t border-l border-r cursor-pointer shrink-0 rounded-t-[3px] transition-colors ${
                    dbState.activeDocTab === 'panels' ? 'font-semibold' : 'hover:text-[var(--text-primary)]'
                  }`}
                >
                  {simState.panels.length > 0 ? `${t('shell.tab.panels')} (${simState.panels.length})` : t('shell.tab.panels')}
                </button>
              )}

              {/* 8. Diagnostics (automotive_diagnostics toolpack guard) */}
              {isDiagEnabled && (
                <button
                  type="button"
                  onClick={() => databaseStore.setActiveDocTab('diagnostics')}
                  data-tab-active={dbState.activeDocTab === 'diagnostics' ? 'true' : undefined}
                  style={{
                    backgroundColor: dbState.activeDocTab === 'diagnostics' ? 'var(--bg-panel)' : 'transparent',
                    borderColor: dbState.activeDocTab === 'diagnostics' ? 'var(--border-strong)' : 'transparent',
                    color: dbState.activeDocTab === 'diagnostics' ? 'var(--status-focus)' : 'var(--text-secondary)',
                    borderBottomColor: dbState.activeDocTab === 'diagnostics' ? 'var(--bg-panel)' : 'transparent',
                  }}
                  className={`h-full px-3.5 xl:px-4 text-[13px] font-sans border-t border-l border-r cursor-pointer shrink-0 rounded-t-[3px] transition-colors ${
                    dbState.activeDocTab === 'diagnostics' ? 'font-semibold' : 'hover:text-[var(--text-primary)]'
                  }`}
                >
                  {t('shell.tab.diagnostics')}
                </button>
              )}

              {/* 8b. Reverse Engineering (passive sniffer, always available) */}
              <button
                type="button"
                onClick={() => databaseStore.setActiveDocTab('re')}
                data-tab-active={dbState.activeDocTab === 're' ? 'true' : undefined}
                style={{
                  backgroundColor: dbState.activeDocTab === 're' ? 'var(--bg-panel)' : 'transparent',
                  borderColor: dbState.activeDocTab === 're' ? 'var(--border-strong)' : 'transparent',
                  color: dbState.activeDocTab === 're' ? 'var(--status-nominal)' : 'var(--text-secondary)',
                  borderBottomColor: dbState.activeDocTab === 're' ? 'var(--bg-panel)' : 'transparent',
                }}
                className={`h-full px-3.5 xl:px-4 text-[13px] font-sans border-t border-l border-r cursor-pointer shrink-0 rounded-t-[3px] transition-colors ${
                  dbState.activeDocTab === 're' ? 'font-semibold' : 'hover:text-[var(--text-primary)]'
                }`}
              >
                {t('re.tab.title')}
              </button>

              {/* 9. Cloud (experimental, default OFF) */}
              {cloudOn && (
              <button
                type="button"
                onClick={() => databaseStore.setActiveDocTab('cloud')}
                data-tab-active={dbState.activeDocTab === 'cloud' ? 'true' : undefined}
                style={{
                  backgroundColor: dbState.activeDocTab === 'cloud' ? 'var(--bg-panel)' : 'transparent',
                  borderColor: dbState.activeDocTab === 'cloud' ? 'var(--border-strong)' : 'transparent',
                  color: dbState.activeDocTab === 'cloud' ? 'var(--text-primary)' : 'var(--text-secondary)',
                  borderBottomColor: dbState.activeDocTab === 'cloud' ? 'var(--bg-panel)' : 'transparent',
                }}
                className={`h-full px-3.5 xl:px-4 text-[13px] font-sans border-t border-l border-r cursor-pointer shrink-0 rounded-t-[3px] transition-colors ${
                  dbState.activeDocTab === 'cloud' ? 'font-semibold' : 'hover:text-[var(--text-primary)]'
                }`}
              >
                {cloudTabLabel}
              </button>
              )}
            </TabStripScroller>

            {/* Right side: Split Indicator + Telemetry FPS */}
            <div className="flex items-center gap-2 pb-1 shrink-0">
              {QUICK_NAVIGATION_ENABLED && (
                <button
                  type="button"
                  aria-label={t('context.navigate')}
                  aria-haspopup="menu"
                  title={t('context.navigateHint')}
                  onClick={openQuickNavigation}
                  onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
                  onAuxClick={(event) => { if (event.button === 1) openQuickNavigation(event); }}
                  className="h-[26px] w-[28px] grid place-items-center border border-strong bg-panel text-[var(--text-secondary)] hover:bg-[var(--bg-row-hover)] cursor-pointer"
                >
                  <Compass className="size-4" />
                </button>
              )}
              {isSplitActive && (
                <button
                  type="button"
                  onClick={() => workbenchStore.setSplitSecondaryTab(null)}
                  style={{
                    backgroundColor: 'var(--status-focus-bg)',
                    borderColor: 'var(--status-focus-border)',
                    color: 'var(--status-focus)',
                  }}
                  className="h-[26px] px-2.5 border text-[12px] font-mono flex items-center gap-1.5 hover:opacity-90 cursor-pointer rounded-[3px]"
                  title={t('shell.app.closeSplitTooltip')}
                >
                  <span>{t('shell.app.splitWith', { name: secondaryTabOptionLabel(workbench.splitSecondaryTab!) })}</span>
                  <X className="w-3.5 h-3.5" />
                </button>
              )}

              <div className="hidden lg:flex items-center text-[12px] font-mono tabular-nums text-[var(--text-secondary)] shrink-0">
                <div className="inline-flex items-center gap-1 px-2">
                  <span className="text-[var(--text-muted)]">{t('shell.app.telemetryRx')}</span>
                  <span className="inline-block w-[9ch] text-right font-mono tabular-nums text-[var(--text-primary)]">
                    {Math.round(hasLiveBus ? fpsRx : 0).toLocaleString('en-US')}/s
                  </span>
                </div>
                <div className="inline-flex items-center gap-1 px-2 border-l border-[var(--border-grid)]">
                  <span className="text-[var(--text-muted)]">{t('shell.app.telemetryTx')}</span>
                  <span className="inline-block w-[9ch] text-right font-mono tabular-nums text-[var(--text-primary)]">
                    {Math.round(hasLiveBus ? header.fpsTx : 0).toLocaleString('en-US')}/s
                  </span>
                </div>
                <div className="inline-flex items-center gap-1 pl-2 border-l border-[var(--border-grid)]">
                  <span className="text-[var(--text-muted)]">{t('shell.app.busLoad')}</span>
                  <span className="inline-block w-[6ch] text-right font-mono tabular-nums text-[var(--text-primary)]">
                    {(hasLiveBus ? estimatedBusLoadPct : 0).toFixed(1)}%
                  </span>
                </div>
              </div>
            </div>
          </nav>

          {/* 2. Main Work Scene (Single Pane or Side-by-Side Split View) */}
          <main
            ref={splitContainerRef}
            className="flex-1 min-h-0 flex flex-row overflow-hidden relative"
          >
            {!isSplitActive ? (
              <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
                {renderDocPane(dbState.activeDocTab)}
              </div>
            ) : (
              <>
                {/* Left Primary Pane */}
                <div
                  style={{ width: `${workbench.splitLeftRatioPct}%` }}
                  className="min-w-0 min-h-0 flex flex-col overflow-hidden"
                >
                  {renderDocPane(dbState.activeDocTab)}
                </div>

                {/* Draggable Vertical Splitter Bar */}
                <div
                  onMouseDown={handleSplitMouseDown}
                  className="w-[5px] shrink-0 bg-[var(--border-strong)] hover:bg-focus active:bg-focus cursor-col-resize transition-colors z-20 flex items-center justify-center"
                  title={t('shell.app.splitterResizeTooltip')}
                >
                  <div className="w-[1px] h-6 bg-[var(--text-muted)]" />
                </div>

                {/* Right Secondary Pane */}
                <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden border-l border-[var(--border-strong)]">
                  {/* Secondary Header (32px) */}
                  <div
                    style={{
                      backgroundColor: 'var(--bg-toolbar)',
                      borderBottom: '1px solid var(--border-strong)',
                    }}
                    className="h-[32px] px-2.5 flex items-center justify-between text-[12px] font-mono select-none shrink-0"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-focus font-semibold uppercase text-[11px] tracking-wide">{t('shell.app.splitPaneLabel')}</span>
                      <select
                        value={workbench.splitSecondaryTab ?? ''}
                        onChange={(e) =>
                          workbenchStore.setSplitSecondaryTab(
                            e.target.value ? (e.target.value as ActiveDocumentTab) : null,
                            workbench.splitSecondaryTraceId,
                          )
                        }
                        style={{
                          backgroundColor: 'var(--bg-panel)',
                          borderColor: 'var(--border-strong)',
                          color: 'var(--text-primary)',
                        }}
                        className="h-[24px] px-2 border text-[11.5px] font-mono cursor-pointer rounded-[3px]"
                      >
                        <option value="trace">{t('shell.tab.trace')}</option>
                        <option value="plotter">{t('shell.tab.plotter')}</option>
                        <option value="symbols">{t('shell.tab.dbcStudio')}</option>
                        <option value="rxtx">{t('shell.tab.rxtx')}</option>
                        <option value="connections">{t('shell.tab.connections')}</option>
                        {isSimEnabled && <option value="panels">{t('shell.tab.panels')}</option>}
                        {isDiagEnabled && <option value="diagnostics">{t('shell.tab.diagnostics')}</option>}
                        {cloudOn && <option value="cloud">{t('shell.tab.cloud')}</option>}
                      </select>

                      {workbench.splitSecondaryTab === 'trace' && (
                        <>
                          <span className="text-[var(--text-muted)]">|</span>
                          <span className="text-[var(--text-secondary)] text-[11.5px]">{t('shell.app.secondaryTraceLabel')}</span>
                          <select
                            value={workbench.splitSecondaryTraceId ?? traceState.activeSessionId}
                            onChange={(e) =>
                              workbenchStore.setSplitSecondaryTab('trace', e.target.value)
                            }
                            style={{
                              backgroundColor: 'var(--bg-panel)',
                              borderColor: 'var(--border-strong)',
                              color: 'var(--text-primary)',
                            }}
                            className="h-[24px] px-2 border text-[11.5px] font-mono cursor-pointer rounded-[3px] max-w-[180px] truncate"
                          >
                            {traceState.sessions.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name} ({s.state === 'recording' ? 'REC' : `${s.count} k`})
                              </option>
                            ))}
                          </select>

                          <button
                            type="button"
                            onClick={() => {
                              const created = traceSessionsStore.spawnNewTraceSession({ autoStart: true });
                              workbenchStore.setSplitSecondaryTab('trace', created.id);
                              setStatusBanner({
                                kind: 'success',
                                message: t('shell.app.secondaryTraceStarted', { name: created.name }),
                              });
                            }}
                            className="h-[24px] px-2 border border-dashed border-[var(--status-focus-border)] text-focus hover:bg-[var(--status-focus-bg)] text-[11px] font-mono flex items-center gap-1 rounded-[3px] cursor-pointer"
                            title={t('shell.app.secondaryNewTraceTooltip')}
                          >
                            <Plus className="w-3 h-3" />
                            <span>{t('shell.app.secondaryNewTrace')}</span>
                          </button>
                        </>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => workbenchStore.setSplitSecondaryTab(null)}
                      className="h-[24px] w-[24px] flex items-center justify-center text-[var(--text-muted)] hover:text-critical cursor-pointer rounded-[3px]"
                      title={t('shell.app.closeSplitTooltip')}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                    {renderDocPane(workbench.splitSecondaryTab!, workbench.splitSecondaryTraceId)}
                  </div>
                </div>
              </>
            )}
          </main>

          {/* 3. Global Connections Dock (single instance, visible in every view; shrink-0 so <main> keeps flex-1 min-h-0) */}
          <div className="shrink-0 flex flex-col min-w-0">
            <BottomConnectionsDock
              devices={devices}
              statusBanner={statusBanner}
              onStatusMessage={setStatusBanner}
            />
          </div>
        </div>

        {/* Right-docked ProjectExplorerDock */}
        {workbench.dockOpen && workbench.dockPosition === 'right' && (
          <aside
            style={{ width: `${workbench.dockWidthPx}px` }}
            className="shrink-0 h-full flex flex-col border-l border-[var(--border-strong)] overflow-hidden"
          >
            <ProjectExplorerDock
              devices={devices}
              quickBarState={quickBarState}
              onApplyQuickBar={applyQuickBarState}
              onQuickSaveProject={handleQuickSaveProject}
              onStatusMessage={setStatusBanner}
            />
          </aside>
        )}

        {/* Right-docked DebugConsolePanel */}
        {debugConsole.dockOpen && !debugConsole.detachedOpen && debugConsole.dockLayout === 'right' && (
          <aside
            style={{ width: `${debugConsole.rightWidthPx}px`, minWidth: '280px', maxWidth: '60vw' }}
            className="shrink-0 h-full flex flex-col border-l border-[var(--border-strong)] relative overflow-hidden bg-canvas"
          >
            <div
              onMouseDown={handleRightResizeStart}
              className="w-1 cursor-col-resize hover:bg-[var(--status-focus-bg)] bg-[var(--border-strong)] transition-colors shrink-0 select-none absolute left-0 top-0 bottom-0 z-20"
              title="Resize Debug Console"
            />
            <div className="flex-1 min-h-0 min-w-0 pl-1 flex flex-col overflow-hidden">
              <DebugConsolePanel />
            </div>
          </aside>
        )}
      </div>

      {/* Bottom-docked DebugConsolePanel */}
      {debugConsole.dockOpen && !debugConsole.detachedOpen && debugConsole.dockLayout === 'bottom' && (
        <div
          style={{ height: `${debugConsole.bottomHeightPx}px`, maxHeight: '60vh' }}
          className="shrink-0 flex flex-col border-t border-[var(--border-strong)] relative overflow-hidden bg-canvas"
        >
          <div
            onMouseDown={handleBottomResizeStart}
            className="h-1 cursor-row-resize hover:bg-[var(--status-focus-bg)] bg-[var(--border-strong)] transition-colors shrink-0 select-none z-20"
            title="Resize Debug Console"
          />
          <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
            <DebugConsolePanel />
          </div>
        </div>
      )}

      {/* Floating DebugConsolePanel */}
      {debugConsole.dockOpen && !debugConsole.detachedOpen && debugConsole.dockLayout === 'floating' && (
        <div
          style={{
            position: 'fixed',
            left: `min(${debugConsole.floatingRect.x}px, calc(100vw - 320px))`,
            top: `min(${debugConsole.floatingRect.y}px, calc(100vh - 120px))`,
            width: `min(${debugConsole.floatingRect.w}px, 100vw)`,
            height: `min(${debugConsole.floatingRect.h}px, calc(100vh - 60px))`,
            zIndex: 40,
          }}
          className="border border-strong shadow-2xl rounded-xs overflow-hidden flex flex-col bg-canvas"
        >
          <div
            onMouseDown={handleFloatingDragStart}
            className="h-4 bg-panel border-b border-hairline cursor-move flex items-center justify-between px-2 shrink-0 select-none"
            title="Drag to reposition Debug Console"
          >
            <span className="text-[10px] text-secondary font-mono tracking-wider font-semibold">DEBUG &amp; AUDIT CONSOLE</span>
            <span className="text-[10px] text-muted font-mono">⠿</span>
          </div>
          <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
            <DebugConsolePanel />
          </div>
        </div>
      )}

      {/* 3. Global Single Status Bar (28px, full window width) */}
      <footer
        style={{
          backgroundColor: 'var(--bg-toolbar)',
          borderTop: '1px solid var(--border-strong)',
          color: 'var(--text-secondary)',
        }}
        className="shrink-0 h-[28px] px-3 flex items-center justify-between text-[12px] font-mono tabular-nums select-none"
      >
        <div className="flex items-center gap-2 min-w-0 truncate font-sans">
          <span
            className={`truncate ${
              statusBanner?.kind === 'error'
                ? 'text-critical font-semibold'
                : statusBanner?.kind === 'success'
                  ? 'text-nominal'
                  : 'text-[var(--text-muted)]'
            }`}
          >
            {statusBanner ? statusBanner.message : t('shell.status.ready')}
          </span>
        </div>

        <div className="flex items-center gap-3 shrink-0 text-[var(--text-muted)] text-[11.5px]">
          {/* Debug Console Status Pill */}
          <button
            type="button"
            onClick={() => debugConsoleStore.toggleDockOpen()}
            className={`h-[20px] px-2 rounded-xs border text-[11px] font-mono flex items-center gap-1.5 cursor-pointer transition-colors ${
              debugConsole.detachedOpen
                ? 'bg-[var(--status-focus-bg)] border-[var(--status-focus-border)] text-focus font-semibold'
                : debugConsole.dockOpen
                  ? 'bg-elevated border-strong text-primary'
                  : 'bg-transparent border-strong text-secondary hover:text-primary hover:border-strong'
            }`}
            title={t('debug.console.statusTooltip')}
          >
            <span className="text-focus font-bold">&gt;_</span>
            <span>{t('debug.console.statusBtn')}</span>
            {debugConsole.detachedOpen ? (
              <span className="text-[10px] text-focus font-sans">↗ {t('debug.console.undockedBadge')}</span>
            ) : (
              <>
                {debugConsole.unreadErrorCount > 0 && (
                  <span className="px-1 py-0.2 rounded-xs bg-[var(--status-critical-bg)] border border-[var(--status-critical-border)] text-critical text-[9.5px] font-bold">
                    {debugConsole.unreadErrorCount}
                  </span>
                )}
                {debugConsole.unreadWarnCount > 0 && (
                  <span className="px-1 py-0.2 rounded-xs bg-[var(--status-warn-bg)] border border-[var(--status-warn-border)] text-warn text-[9.5px] font-bold">
                    {debugConsole.unreadWarnCount}
                  </span>
                )}
              </>
            )}
          </button>
          <span className="font-sans">
            {cloudOn && cloudHeader.isAuthenticated
              ? projState.cloudBinding
                ? t('shell.status.cloudBound', { code: projState.cloudBinding.projectCode })
                : t('shell.status.cloudConnected')
              : t('shell.status.localMode')}
          </span>
          <span className="border-l border-[var(--border-grid)] pl-2.5">
            {t('shell.status.canBusesOnline', { count: header.buses.filter((b) => b.connected).length })}
          </span>
          <span className="border-l border-[var(--border-grid)] pl-2.5 inline-flex items-center gap-1">
            <span>{t('shell.status.rxTotal')}</span>
            <span className="inline-block min-w-[9ch] text-right font-mono tabular-nums text-[var(--text-primary)]">
              {header.totalFramesRx.toLocaleString('en-US')}
            </span>
          </span>
          <span className="border-l border-[var(--border-grid)] pl-2.5 inline-flex items-center gap-1">
            <span>{t('shell.status.txTotal')}</span>
            <span className="inline-block min-w-[9ch] text-right font-mono tabular-nums text-[var(--text-primary)]">
              {header.totalFramesTx.toLocaleString('en-US')}
            </span>
          </span>
          <VersionStatus />
        </div>
      </footer>

      {projState.modalOpen && (
        <ProjectModal
          quickBarState={quickBarState}
          onApplyQuickBar={applyQuickBarState}
          onStatusMessage={setStatusBanner}
          onClose={() => projectStore.setModalOpen(false)}
        />
      )}

      {workbench.newConnectionModalOpen && (
        <NewConnectionModal
          devices={devices}
          onClose={() => workbenchStore.setNewConnectionModalOpen(false)}
          onStatusMessage={setStatusBanner}
        />
      )}

      {cloudOn && (
        <CloudPushPromptModal
          quickBarState={quickBarState}
          onStatusMessage={setStatusBanner}
        />
      )}

      <ToolpacksModal
        quickBarState={quickBarState}
        onStatusMessage={setStatusBanner}
      />

      <AcknowledgmentsModal />
      <GuideInfoDialog />
      <UpdateNotice />
      <ChangelogDialog />
      <McpServerPanel />
      <McpUiOverlay onPanicStop={handlePanicStop} />
      <ContextMenu />

      {/* Operator prompts of any flow run (Flow Editor / Diagnostics Workbench): one host for every tab. */}
      <FlowPromptHost />
    </div>
  );
};

export default App;
