import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CloudWorkspaceView } from './components/CloudWorkspaceView';
import { CloudPushPromptModal } from './components/CloudPushPromptModal';
import { ConnectionsView } from './components/ConnectionsView';
import { PlotterView } from './components/PlotterView';
import { ProjectModal } from './components/ProjectModal';
import { ReceiveTransmitView } from './components/ReceiveTransmitView';
import { StartPageView } from './components/StartPageView';
import { SymbolsLayoutView } from './components/SymbolsLayoutView';
import { type StatusBanner, TopBar } from './components/TopBar';
import { TraceView } from './components/TraceView';
import {
  apiClearDatabase,
  apiDisconnectAllBuses,
  apiListDevices,
  apiPanicStopTx,
  apiResetTelemetry,
  apiSetBusMode,
  subscribeTelemetry,
} from './services/ipcClient';
import { connectionStore, useConnectionStore } from './store/connectionStore';
import { cloudBridgeStore } from './store/cloudBridgeStore';
import { databaseStore, useDatabaseStore } from './store/databaseStore';
import { plotStore, usePlotStore } from './store/plotStore';
import { simulationPanelStore, useSimulationPanelStore } from './store/simulationPanelStore';
import {
  type QuickBarConnectionState,
  projectStore,
  useProjectStore,
} from './store/projectStore';
import { telemetryStore, useTelemetryHeader } from './store/telemetryStore';
import { transmitStore, useTransmitStore } from './store/transmitStore';
import type { DeviceDescriptorDto } from './types/hal';
import { installBusDatabaseAutoSync } from './utils/busDatabaseSync';

installBusDatabaseAutoSync();

export const App: React.FC = () => {
  const dbState = useDatabaseStore();
  const header = useTelemetryHeader();
  const projState = useProjectStore();
  const connState = useConnectionStore();
  const txState = useTransmitStore();
  const plotState = usePlotStore();
  const simState = useSimulationPanelStore();

  const [devices, setDevices] = useState<readonly DeviceDescriptorDto[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [mockFpsPreset, setMockFpsPreset] = useState<number | null>(null);
  const [bitrateProfileId, setBitrateProfileId] = useState<string>('fd_500k_2m');
  const [listenOnly, setListenOnly] = useState<boolean>(true);
  const [, setBusyBusAction] = useState<boolean>(false);

  const [statusBanner, setStatusBanner] = useState<StatusBanner | null>(null);
  const [panicCounter, setPanicCounter] = useState<number>(0);

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

  useEffect(() => {
    if (!coldStartDoneRef.current) {
      coldStartDoneRef.current = true;
      void (async () => {
        // Attempt to restore active project session on reload (F5 / Ctrl+R)
        const restored = await projectStore.restoreActiveSessionOnReload(applyQuickBarState);
        if (!restored) {
          // Cold start cleanup: Only when there is no active project to restore!
          await apiPanicStopTx().catch(() => null);
          await apiDisconnectAllBuses().catch(() => 0);
          await apiClearDatabase().catch(() => undefined);
          await apiResetTelemetry().catch(() => undefined);
          telemetryStore.clearAllBuses();
          telemetryStore.clearAllTelemetry();
          databaseStore.clearAll();
          transmitStore.clearAll();
        }
        await Promise.all([refreshDevices(), projectStore.refreshSavedProjects()]);
        cloudBridgeStore.initializeLifecycle();
      })();
    }

    const unsubscribe = subscribeTelemetry(
      (snap) => {
        telemetryStore.ingestSnapshot(snap);
      },
      (connected) => {
        telemetryStore.setTransportStatus(connected);
      },
    );

    return () => {
      unsubscribe();
    };
  }, [applyQuickBarState, refreshDevices]);

  // Auto-save active workspace when database, connections, TX list, plotter, or bus states change
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

  // Switches an already-connected bus into Active TX Armed mode atomically without reconnecting or device swapping
  const handleSwitchToActiveTx = useCallback(
    async (targetBusId?: number): Promise<void> => {
      const connectedBuses = header.buses.filter((b) => b.connected);
      const activeBus =
        targetBusId !== undefined
          ? connectedBuses.find((b) => b.busId === targetBusId)
          : connectedBuses[0];

      if (!activeBus) {
        const busNum = targetBusId !== undefined ? targetBusId + 1 : 1;
        setStatusBanner({
          kind: 'error',
          message: `Bus ${busNum} is offline. Connect your CAN interface first before enabling Active TX.`,
        });
        return;
      }

      setBusyBusAction(true);
      try {
        const armedHealth = await apiSetBusMode(activeBus.busId, false, true);
        telemetryStore.upsertBusHealth(armedHealth);

        // Update corresponding saved profile listenOnly flag if present
        const conn = connectionStore.getState();
        const matchingProf = conn.profiles.find(
          (p) => p.busId === activeBus.busId && p.deviceId === armedHealth.deviceId,
        );
        if (matchingProf) {
          connectionStore.upsertProfile({ ...matchingProf, listenOnly: false });
        }

        setStatusBanner({
          kind: 'success',
          message: `Active TX Armed on Bus ${activeBus.busId + 1} (${armedHealth.channelName}). Active CAN mode enabled.`,
        });
      } catch (err) {
        setStatusBanner({
          kind: 'error',
          message: `Enable Active TX failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setBusyBusAction(false);
      }
    },
    [header.buses],
  );

  const handleQuickSaveProject = useCallback(async (): Promise<void> => {
    try {
      const saved = await projectStore.saveCurrentProject(quickBarState);
      setStatusBanner({
        kind: 'success',
        message: `Saved project "${saved.name}" (${saved.fileStem}.nexusproj.json).`,
      });
    } catch (err) {
      setStatusBanner({
        kind: 'info',
        message: `Project cached locally (${err instanceof Error ? err.message : String(err)}).`,
      });
    }
  }, [quickBarState]);

  const handlePanicStop = useCallback(async (): Promise<void> => {
    telemetryStore.markPanicLatched();
    transmitStore.markAllPaused();
    simulationPanelStore.stopAllPeriodicStimulusJobs();
    setPanicCounter((c) => c + 1);
    try {
      const res = await apiPanicStopTx();
      setStatusBanner({
        kind: 'error',
        message: `PANIC STOP: Stopped ${res.stoppedPeriodicJobs} periodic job(s), disarmed ${res.disarmedBuses} bus(es).`,
      });
    } catch (err) {
      setStatusBanner({
        kind: 'error',
        message: `PANIC STOP error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, []);

  const handleClearWorkspace = useCallback(async (): Promise<void> => {
    await apiResetTelemetry().catch(() => undefined);
    telemetryStore.clearAllTelemetry();
    transmitStore.resetCounters();
    const isPlotterActive = databaseStore.getState().activeDocTab === 'plotter';
    if (isPlotterActive) {
      plotStore.clearBuffers();
    }
    setStatusBanner({
      kind: 'info',
      message: isPlotterActive
        ? 'Cleared Receive, Trace, Plotter buffers & frame counters (Esc).'
        : 'Cleared Receive, Trace & frame counters (Esc).',
    });
  }, []);

  // Global Shortcuts: Ctrl+S (Quick Save), Esc (Clear / Reset), Ctrl+Shift+Space (Panic Stop TX)
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent): void => {
      if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === 's') {
        ev.preventDefault();
        void handleQuickSaveProject();
        return;
      }
      if (ev.ctrlKey && ev.shiftKey && ev.code === 'Space') {
        ev.preventDefault();
        void handlePanicStop();
        return;
      }
      if (ev.code === 'Escape' && !projState.modalOpen) {
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

      {/* Full-Width Engineering Document Workspace */}
      <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {dbState.activeDocTab === 'start' && (
          <StartPageView
            devices={devices}
            onRefreshDevices={refreshDevices}
            onStatusMessage={setStatusBanner}
            quickBarState={quickBarState}
            onApplyQuickBar={applyQuickBarState}
          />
        )}
        {dbState.activeDocTab === 'rxtx' && (
          <ReceiveTransmitView
            devices={devices}
            bitrateProfileId={bitrateProfileId}
            mockFpsPreset={mockFpsPreset}
            statusBanner={statusBanner}
            onStatusMessage={setStatusBanner}
            onSwitchToActiveTx={handleSwitchToActiveTx}
            panicCounter={panicCounter}
          />
        )}
        {dbState.activeDocTab === 'connections' && (
          <ConnectionsView
            devices={devices}
            onRefreshDevices={refreshDevices}
            onStatusMessage={setStatusBanner}
          />
        )}
        {dbState.activeDocTab === 'plotter' && <PlotterView />}
        {dbState.activeDocTab === 'trace' && <TraceView />}
        {dbState.activeDocTab === 'symbols' && <SymbolsLayoutView />}
        {(dbState.activeDocTab === 'cloud' || dbState.activeDocTab === 'panels') && (
          <CloudWorkspaceView
            quickBarState={quickBarState}
            onApplyQuickBar={applyQuickBarState}
            onStatusMessage={setStatusBanner}
          />
        )}
      </main>

      {/* Compact 22px Status Strip for Secondary Tabs (start, rxtx, panels and cloud render their own rich toolbars/footers) */}
      {dbState.activeDocTab !== 'rxtx' &&
        dbState.activeDocTab !== 'start' &&
        dbState.activeDocTab !== 'panels' &&
        dbState.activeDocTab !== 'cloud' && (
        <div
          style={{
            backgroundColor: 'var(--bg-toolbar)',
            borderTop: '1px solid var(--border-strong)',
            color: 'var(--text-secondary)',
          }}
          className="shrink-0 h-[22px] px-2 flex items-center justify-between text-[11px] font-mono tabular-nums select-none"
        >
          <span
            className={`truncate font-sans ${
              statusBanner?.kind === 'error'
                ? 'text-red-500 font-semibold'
                : statusBanner?.kind === 'success'
                  ? 'text-emerald-500'
                  : 'text-[var(--text-muted)]'
            }`}
          >
            {statusBanner ? statusBanner.message : 'Ready'}
          </span>

          <div className="flex items-center gap-3 shrink-0 text-[var(--text-muted)]">
            <span>
              Buses: {header.buses.filter((b) => b.connected).length}
            </span>
            <span>Project: {projState.currentName}</span>
          </div>
        </div>
      )}

      {projState.modalOpen && (
        <ProjectModal
          quickBarState={quickBarState}
          onApplyQuickBar={applyQuickBarState}
          onStatusMessage={setStatusBanner}
          onClose={() => projectStore.setModalOpen(false)}
        />
      )}

      <CloudPushPromptModal
        quickBarState={quickBarState}
        onStatusMessage={setStatusBanner}
      />
    </div>
  );
};

export default App;
