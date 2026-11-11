import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { TxModeControl } from './TxModeControl';
import {
  Award,
  Boxes,
  Building2,
  Columns2,
  FilePlus2,
  FolderOpen,
  FolderX,
  Moon,
  OctagonAlert,
  PanelRight,
  Pause,
  Play,
  PlugZap,
  Plus,
  Radio,
  RotateCcw,
  Save,
  Square,
  Sun,
  Unplug,
  UploadCloud,
} from 'lucide-react';
import { apiControlTraceReplay, apiDisconnectAllBuses } from '../services/ipcClient';
import { cloudBridgeStore, useCloudBridgeHeader } from '../store/cloudBridgeStore';
import { experimentalStore, useExperimentalCloud } from '../store/experimentalStore';
import { databaseStore, useDatabaseStore, type ActiveDocumentTab } from '../store/databaseStore';
import {
  type QuickBarConnectionState,
  projectStore,
  useProjectStore,
} from '../store/projectStore';
import { telemetryStore, useTelemetryHeader } from '../store/telemetryStore';
import { traceSessionsStore, useTraceSessionsStore } from '../store/traceSessionsStore';
import { transmitStore } from '../store/transmitStore';
import { workbenchStore, useWorkbenchStore } from '../store/workbenchStore';
import { isToolpackEnabled } from '../types/toolpacks';
import type { DeviceDescriptorDto } from '../types/hal';

export interface StatusBanner {
  kind: 'info' | 'success' | 'error';
  message: string;
}

export interface BitrateProfile {
  id: string;
  label: string;
  detailLabel: string;
  bitrate: number;
  dataBitrate: number;
  enableFd: boolean;
}

export const BITRATE_PROFILES: readonly BitrateProfile[] = [
  {
    id: 'fd_500k_2m',
    label: '500k / 2M FD',
    detailLabel: 'Nominal 500 kbit/s, Data 2 Mbit/s',
    bitrate: 500_000,
    dataBitrate: 2_000_000,
    enableFd: true,
  },
  {
    id: 'fd_1m_4m',
    label: '1M / 4M FD',
    detailLabel: 'Nominal 1 Mbit/s, Data 4 Mbit/s',
    bitrate: 1_000_000,
    dataBitrate: 4_000_000,
    enableFd: true,
  },
  {
    id: 'can_500k',
    label: '500k CC',
    detailLabel: '500 kbit/s (Classical CAN)',
    bitrate: 500_000,
    dataBitrate: 500_000,
    enableFd: false,
  },
  {
    id: 'j1939_250k',
    label: '250k J1939',
    detailLabel: '250 kbit/s (SAE J1939)',
    bitrate: 250_000,
    dataBitrate: 250_000,
    enableFd: false,
  },
];

type MenuKey =
  | 'file'
  | 'connections'
  | 'databases'
  | 'transmit'
  | 'trace'
  | 'cloud'
  | 'view'
  | 'help';

interface TopBarProps {
  devices: readonly DeviceDescriptorDto[];
  onQuickSaveProject: () => Promise<void>;
  onPanicStop: () => Promise<void>;
  onClearWorkspace: () => Promise<void>;
  onStatusMessage: (msg: StatusBanner) => void;
  onApplyQuickBar?: (qb: QuickBarConnectionState) => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  onQuickSaveProject,
  onPanicStop,
  onClearWorkspace,
  onStatusMessage,
  onApplyQuickBar,
}) => {
  const { t, locale, setLocale } = useI18n();
  const header = useTelemetryHeader();
  const dbState = useDatabaseStore();
  const projState = useProjectStore();
  const cloudHeader = useCloudBridgeHeader();
  const cloudOn = useExperimentalCloud();
  const workbench = useWorkbenchStore();
  const traceState = useTraceSessionsStore();
  const activeTrace = traceSessionsStore.getSession(traceState.activeSessionId);

  const [openMenu, setOpenMenu] = useState<MenuKey | null>(null);

  const connectedBuses = header.buses.filter((b) => b.connected);
  const connectedBusCount = connectedBuses.length;
  const anyTxArmed = header.buses.some((b) => b.connected && b.txArmed);
  const isUrgentStop = anyTxArmed || header.txPanicLatched;
  const isStreaming =
    cloudHeader.status === 'streaming' ||
    cloudHeader.status === 'connecting_ws' ||
    cloudHeader.status === 'authenticating';
  const isSimEnabled = isToolpackEnabled(projState.enabledToolpacks, 'simulation_replay');

  // Outside click & Escape handler for desktop menus
  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (ev: MouseEvent): void => {
      const target = ev.target as HTMLElement | null;
      if (!target?.closest('[data-menubar-item]')) {
        setOpenMenu(null);
      }
    };
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        setOpenMenu(null);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [openMenu]);

  const handleDisconnectAll = async (): Promise<void> => {
    try {
      const count = await apiDisconnectAllBuses();
      telemetryStore.clearAllBuses();
      transmitStore.markAllPaused();
      onStatusMessage({
        kind: 'info',
        message: t('shell.topbar.allBusesDisconnected', { count }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('shell.topbar.disconnectError', {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  };

  const handleCloseProject = async (): Promise<void> => {
    const closedName = projState.currentName;
    await projectStore.closeCurrentProject(onApplyQuickBar);
    onStatusMessage({
      kind: 'info',
      message: t('shell.topbar.projectClosed', { name: closedName }),
    });
  };

  const handlePushActiveProject = async (): Promise<void> => {
    if (projState.cloudBinding) {
      try {
        const res = await cloudBridgeStore.pushActiveLocalProjectToCloud({ mode: 'bound' });
        onStatusMessage({
          kind: 'success',
          message: t('shell.topbar.cloudPushSuccess', {
            name: res.project.name,
            code: res.project.code,
            rev: res.revisionNumber,
          }),
        });
      } catch (err) {
        onStatusMessage({
          kind: 'error',
          message: t('shell.topbar.cloudPushError', {
            error: err instanceof Error ? err.message : String(err),
          }),
        });
      }
    } else {
      cloudBridgeStore.openPushPrompt({
        reason: 'manual',
        projectName: projState.currentName,
      });
    }
  };

  const handleToggleLiveStream = async (): Promise<void> => {
    if (isStreaming) {
      cloudBridgeStore.stopLiveStream();
      onStatusMessage({
        kind: 'info',
        message: t('shell.topbar.liveStreamStopped'),
      });
      return;
    }

    const state = cloudBridgeStore.getState();
    const targetProjId =
      state.selectedProjectId ||
      projState.cloudBinding?.projectId ||
      state.inspectedProjectId ||
      state.projects[0]?.id;

    if (!targetProjId) {
      databaseStore.setActiveDocTab('cloud');
      onStatusMessage({
        kind: 'info',
        message: t('shell.topbar.liveStreamSelectProject'),
      });
      return;
    }

    try {
      if (state.selectedProjectId === targetProjId && state.bridgeToken) {
        await cloudBridgeStore.resumeLiveStream();
      } else {
        await cloudBridgeStore.switchProject(targetProjId);
      }
      onStatusMessage({
        kind: 'success',
        message: t('shell.topbar.liveStreamStarted', { id: targetProjId }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('shell.topbar.liveStreamError', {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  };

  const handleToggleTraceRecording = (): void => {
    if (activeTrace.state === 'recording') {
      traceSessionsStore.stopRecording(activeTrace.id);
      onStatusMessage({
        kind: 'info',
        message: t('shell.topbar.traceRecordingStopped', {
          name: activeTrace.name,
          count: activeTrace.count.toLocaleString('en-US'),
        }),
      });
    } else {
      if (dbState.activeDocTab === 'rxtx' && !workbench.splitSecondaryTab) {
        workbenchStore.setSplitSecondaryTab('trace', activeTrace.id);
      } else if (dbState.activeDocTab !== 'trace' && !workbench.splitSecondaryTab) {
        databaseStore.setActiveDocTab('trace');
      }
      traceSessionsStore.startRecording(activeTrace.id);
      onStatusMessage({
        kind: 'success',
        message: t('shell.topbar.traceRecordingStarted', { name: activeTrace.name }),
      });
    }
  };

  const handleSpawnNewTraceSession = (): void => {
    const created = traceSessionsStore.spawnNewTraceSession({ autoStart: true });
    if (dbState.activeDocTab === 'rxtx' && !workbench.splitSecondaryTab) {
      workbenchStore.setSplitSecondaryTab('trace', created.id);
    } else if (dbState.activeDocTab !== 'trace' && !workbench.splitSecondaryTab) {
      databaseStore.setActiveDocTab('trace');
    }
    onStatusMessage({
      kind: 'success',
      message: t('shell.topbar.traceNewSessionStarted', { name: created.name }),
    });
  };

  const handleExportTrace = (format: 'trc' | 'asc' | 'csv'): void => {
    try {
      const fileName = traceSessionsStore.exportSessionToFile(activeTrace.id, format);
      onStatusMessage({
        kind: 'success',
        message: t('shell.topbar.traceExportSuccess', { name: fileName }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('shell.topbar.traceExportError', {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  };

  const topBarTraceFileInputRef = useRef<HTMLInputElement | null>(null);

  const handleOpenTraceFromFile = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const loaded = await traceSessionsStore.importTraceFileObject(file, true);
      onStatusMessage({
        kind: 'success',
        message: t('shell.topbar.traceFileOpened', {
          name: file.name,
          count: loaded.count.toLocaleString('en-US'),
        }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('shell.topbar.fileOpenError', {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  };

  const handleSaveActiveTraceToDisk = async (): Promise<void> => {
    try {
      const summary = await traceSessionsStore.saveSessionToDisk(activeTrace.id, 'trc');
      onStatusMessage({
        kind: 'success',
        message: t('shell.topbar.traceSavedToDisk', {
          name: summary.fileName,
          path: summary.filePath,
        }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('shell.topbar.traceSaveError', {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  };

  const handleToggleTraceReplay = async (): Promise<void> => {
    try {
      if (header.replay && header.replay.state !== 'idle') {
        await apiControlTraceReplay({ action: 'stop' });
        traceSessionsStore.setReplayingSessionId(null);
        onStatusMessage({ kind: 'info', message: t('shell.topbar.traceReplayStopped') });
      } else {
        databaseStore.setActiveDocTab('trace');
        await traceSessionsStore.startSessionReplay(activeTrace.id);
        onStatusMessage({
          kind: 'info',
          message: t('shell.topbar.traceReplaying', { name: activeTrace.name }),
        });
      }
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('shell.topbar.traceReplayError', {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  };

  return (
    <header className="shrink-0 select-none text-[12px] flex flex-col border-b border-[var(--border-strong)]">
      {/* Hidden file input for opening trace files from TopBar */}
      <input
        ref={topBarTraceFileInputRef}
        type="file"
        accept=".trc,.asc,.log,.csv,.blf"
        onChange={(e) => void handleOpenTraceFromFile(e)}
        className="hidden"
      />
      {/* ==================================================================== */}
      {/* ROW 1 (36px): ENDÜSTRİYEL KLASİK MASAÜSTÜ MENÜ ÇUBUĞU                */}
      {/* ==================================================================== */}
      <div
        style={{
          backgroundColor: 'var(--bg-header)',
          borderBottom: '1px solid var(--border-grid)',
        }}
        className="h-[36px] px-3 flex items-center justify-between gap-2"
      >
        {/* Left: Backend status + Logo + Project Title + Desktop Menus */}
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
              connectedBusCount > 0
                ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]'
                : header.transportConnected
                  ? 'bg-slate-400'
                  : 'bg-amber-500'
            }`}
            title={
              connectedBusCount > 0
                ? t('shell.topbar.busesOnlineTooltip', { count: connectedBusCount })
                : header.transportConnected
                  ? t('shell.topbar.backendReadyTooltip')
                  : t('shell.topbar.backendConnectingTooltip')
            }
          />
          <img
            src="/logo.png"
            alt="NexusCAN Logo"
            className="w-[18px] h-[18px] rounded-[2px] border border-[#0E7490]/60 shrink-0 mx-1"
            width={18}
            height={18}
          />
          <span className="font-bold tracking-tight text-[var(--text-primary)] text-[13px] truncate max-w-[220px] pr-2.5 border-r border-[var(--border-grid)]">
            {projState.currentName}
          </span>

          {/* Menus Container */}
          <nav className="flex items-center gap-1 text-[13px] font-sans">
            {/* 1. File Menu */}
            <div className="relative" data-menubar-item>
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === 'file' ? null : 'file')}
                className={`h-[30px] px-3 rounded-[3px] text-[13px] font-medium cursor-pointer transition-colors ${
                  openMenu === 'file'
                    ? 'bg-[var(--bg-row-selected)] text-[var(--text-primary)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-panel)]'
                }`}
              >
                {t('shell.menu.file')}
              </button>
              {openMenu === 'file' && (
                <div
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="absolute left-0 top-[34px] z-50 border shadow-2xl py-1.5 rounded-[3px] min-w-[240px] text-[12.5px]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      projectStore.setModalOpen(true);
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)] flex items-center justify-between"
                  >
                    <span>{t('shell.menu.file.new')}</span>
                    <span className="text-[11px] font-mono text-[var(--text-muted)]">Ctrl+N</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      projectStore.setModalOpen(true);
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)] flex items-center justify-between"
                  >
                    <span>{t('shell.menu.file.openManage')}</span>
                    <span className="text-[11px] font-mono text-[var(--text-muted)]">Ctrl+O</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      void onQuickSaveProject();
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)] flex items-center justify-between"
                  >
                    <span>{t('shell.menu.file.save')}</span>
                    <span className="text-[11px] font-mono text-[var(--text-muted)]">Ctrl+S</span>
                  </button>
                  <div className="my-1.5 border-t border-[var(--border-grid)]" />
                  <button
                    type="button"
                    disabled={!projState.hasActiveWorkspace}
                    onClick={() => {
                      setOpenMenu(null);
                      void handleCloseProject();
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-red-400 disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    {t('shell.menu.file.close')}
                  </button>
                </div>
              )}
            </div>

            {/* 2. Connections Menu */}
            <div className="relative" data-menubar-item>
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === 'connections' ? null : 'connections')}
                className={`h-[30px] px-3 rounded-[3px] text-[13px] font-medium cursor-pointer transition-colors ${
                  openMenu === 'connections'
                    ? 'bg-[var(--bg-row-selected)] text-[var(--text-primary)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-panel)]'
                }`}
              >
                {t('shell.menu.connections')}
              </button>
              {openMenu === 'connections' && (
                <div
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="absolute left-0 top-[34px] z-50 border shadow-2xl py-1.5 rounded-[3px] min-w-[260px] text-[12.5px]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      workbenchStore.setNewConnectionModalOpen(true);
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-emerald-400 font-medium"
                  >
                    {t('shell.menu.connections.add')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      databaseStore.setActiveDocTab('connections');
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)]"
                  >
                    {t('shell.menu.connections.setup')}
                  </button>
                  <div className="my-1.5 border-t border-[var(--border-grid)]" />
                  <button
                    type="button"
                    disabled={connectedBusCount === 0}
                    onClick={() => {
                      setOpenMenu(null);
                      void handleDisconnectAll();
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-red-400 disabled:opacity-40 disabled:hover:bg-transparent font-medium"
                  >
                    {t('shell.menu.connections.disconnectAll', { count: connectedBusCount })}
                  </button>
                </div>
              )}
            </div>

            {/* 3. DBC Studio Menu */}
            <div className="relative" data-menubar-item>
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === 'databases' ? null : 'databases')}
                className={`h-[30px] px-3 rounded-[3px] text-[13px] font-medium cursor-pointer transition-colors ${
                  openMenu === 'databases'
                    ? 'bg-[var(--bg-row-selected)] text-[var(--text-primary)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-panel)]'
                }`}
              >
                {t('shell.menu.dbcStudio')}
              </button>
              {openMenu === 'databases' && (
                <div
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="absolute left-0 top-[34px] z-50 border shadow-2xl py-1.5 rounded-[3px] min-w-[250px] text-[12.5px]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      databaseStore.setActiveDocTab('symbols');
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)]"
                  >
                    {t('shell.menu.dbcStudio.open')}
                  </button>
                  {cloudOn && (
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      databaseStore.setActiveDocTab('symbols');
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-sky-400"
                  >
                    {t('shell.menu.dbcStudio.pullCloud')}
                  </button>
                  )}
                </div>
              )}
            </div>

            {/* 4. Transmit Menu */}
            <div className="relative" data-menubar-item>
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === 'transmit' ? null : 'transmit')}
                className={`h-[30px] px-3 rounded-[3px] text-[13px] font-medium cursor-pointer transition-colors ${
                  openMenu === 'transmit'
                    ? 'bg-[var(--bg-row-selected)] text-[var(--text-primary)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-panel)]'
                }`}
              >
                {t('shell.menu.transmit')}
              </button>
              {openMenu === 'transmit' && (
                <div
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="absolute left-0 top-[34px] z-50 border shadow-2xl py-1.5 rounded-[3px] min-w-[280px] text-[12.5px]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      databaseStore.setActiveDocTab('rxtx');
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)]"
                  >
                    {t('shell.menu.transmit.rxtxView')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      databaseStore.setActiveDocTab('plotter');
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)]"
                  >
                    {t('shell.menu.transmit.plotterView')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      void onClearWorkspace();
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-secondary)] flex items-center justify-between"
                  >
                    <span>{t('shell.menu.transmit.clearCounters')}</span>
                    <span className="text-[11px] font-mono text-[var(--text-muted)]">Esc</span>
                  </button>
                  <div className="my-1.5 border-t border-[var(--border-grid)]" />
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      void onPanicStop();
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-red-500 font-semibold flex items-center justify-between"
                  >
                    <span>{t('shell.menu.transmit.panicStop')}</span>
                    <span className="text-[11px] font-mono">Ctrl+Shift+Space</span>
                  </button>
                </div>
              )}
            </div>

            {/* 5. Trace Menu */}
            <div className="relative" data-menubar-item>
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === 'trace' ? null : 'trace')}
                className={`h-[30px] px-3 rounded-[3px] text-[13px] font-medium cursor-pointer transition-colors ${
                  openMenu === 'trace'
                    ? 'bg-[var(--bg-row-selected)] text-[var(--text-primary)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-panel)]'
                }`}
              >
                {t('shell.menu.trace')}
              </button>
              {openMenu === 'trace' && (
                <div
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="absolute left-0 top-[34px] z-50 border shadow-2xl py-1.5 rounded-[3px] min-w-[290px] text-[12.5px]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      handleToggleTraceRecording();
                    }}
                    className={`w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] font-medium flex items-center justify-between ${
                      activeTrace.state === 'recording' ? 'text-red-400' : 'text-emerald-400'
                    }`}
                  >
                    <span>
                      {activeTrace.state === 'recording'
                        ? t('shell.menu.trace.stopRec', { name: activeTrace.name })
                        : t('shell.menu.trace.startRec', { name: activeTrace.name })}
                    </span>
                    <span className="text-[11px] font-mono text-[var(--text-muted)]">F5</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      handleSpawnNewTraceSession();
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-sky-400 font-medium flex items-center justify-between"
                  >
                    <span>{t('shell.menu.trace.spawnNew')}</span>
                    <span className="text-[11px] font-mono text-[var(--text-muted)]">Ctrl+Shift+T</span>
                  </button>

                  {activeTrace.state === 'recording' && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenu(null);
                        traceSessionsStore.pauseRecording(activeTrace.id);
                        onStatusMessage({
                          kind: 'info',
                          message: t('shell.topbar.traceRecordingStopped', {
                            name: activeTrace.name,
                            count: activeTrace.count.toLocaleString('en-US'),
                          }),
                        });
                      }}
                      className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-amber-400"
                    >
                      {t('shell.menu.trace.pauseRec')}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      traceSessionsStore.clearSession(activeTrace.id);
                      onStatusMessage({
                        kind: 'info',
                        message: `Trace arabelleği temizlendi (${activeTrace.name}).`,
                      });
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-secondary)]"
                  >
                    {t('shell.menu.trace.clearBuffer')}
                  </button>

                  <div className="my-1.5 border-t border-[var(--border-grid)]" />

                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      topBarTraceFileInputRef.current?.click();
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-amber-400 font-medium"
                  >
                    {t('shell.menu.trace.openFromFile')}
                  </button>

                  <button
                    type="button"
                    disabled={activeTrace.count === 0}
                    onClick={() => {
                      setOpenMenu(null);
                      void handleSaveActiveTraceToDisk();
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-emerald-400 font-medium disabled:opacity-40"
                  >
                    {t('shell.menu.trace.saveToDisk')}
                  </button>

                  <button
                    type="button"
                    disabled={activeTrace.count === 0 && (!header.replay || header.replay.state === 'idle')}
                    onClick={() => {
                      setOpenMenu(null);
                      void handleToggleTraceReplay();
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-cyan-400 font-medium disabled:opacity-40"
                  >
                    {header.replay && header.replay.state !== 'idle'
                      ? t('shell.menu.trace.stopReplay')
                      : t('shell.menu.trace.startReplay')}
                  </button>

                  <div className="my-1.5 border-t border-[var(--border-grid)]" />

                  <div className="px-3.5 py-1 text-[11px] font-mono text-[var(--text-muted)] uppercase">
                    {t('shell.menu.trace.exportHeader')}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      handleExportTrace('trc');
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)]"
                  >
                    {t('shell.menu.trace.exportTrc')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      handleExportTrace('asc');
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)]"
                  >
                    {t('shell.menu.trace.exportAsc')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      handleExportTrace('csv');
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)]"
                  >
                    {t('shell.menu.trace.exportCsv')}
                  </button>

                  <div className="my-1.5 border-t border-[var(--border-grid)]" />

                  <div className="px-3.5 py-1 text-[11px] font-mono text-[var(--text-muted)] uppercase flex items-center justify-between">
                    <span>{t('shell.menu.trace.sessionsHeader', { count: traceState.sessions.length })}</span>
                    {traceState.recordingCount > 0 && (
                      <span className="text-red-400 font-bold">{traceState.recordingCount} REC</span>
                    )}
                  </div>
                  {traceState.sessions.map((sess) => {
                    const isSelected = sess.id === activeTrace.id;
                    return (
                      <button
                        key={sess.id}
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          traceSessionsStore.setActiveSession(sess.id);
                          databaseStore.setActiveDocTab('trace');
                        }}
                        className={`w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] flex items-center justify-between ${
                          isSelected ? 'bg-[var(--bg-row-selected)] text-sky-400 font-semibold' : 'text-[var(--text-primary)]'
                        }`}
                      >
                        <span className="flex items-center gap-1.5 truncate">
                          <span
                            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                              sess.state === 'recording'
                                ? 'bg-red-500 animate-pulse'
                                : sess.state === 'paused'
                                  ? 'bg-amber-400'
                                  : 'bg-slate-500'
                            }`}
                          />
                          <span className="truncate">{sess.name}</span>
                          {isSelected && <span className="text-[11px] text-sky-400">{t('shell.menu.trace.active')}</span>}
                        </span>
                        <span className="font-mono text-[11px] text-[var(--text-muted)] tabular-nums pl-2">
                          {t('shell.menu.trace.framesCount', { count: sess.count.toLocaleString('en-US') })}
                        </span>
                      </button>
                    );
                  })}

                  <div className="my-1.5 border-t border-[var(--border-grid)]" />

                  <div
                    onClick={() => {
                      setOpenMenu(null);
                      void navigator.clipboard.writeText(traceState.tracesDir);
                      onStatusMessage({
                        kind: 'info',
                        message: t('shell.topbar.traceDirCopied', { path: traceState.tracesDir }),
                      });
                    }}
                    className="px-3.5 py-2 bg-[var(--bg-toolbar)] text-[11px] font-mono text-emerald-400 cursor-pointer hover:bg-[var(--bg-row-hover)] flex items-center justify-between"
                    title={t('shell.menu.trace.copyDirTooltip')}
                  >
                    <span className="truncate">📁 {traceState.tracesDir}</span>
                    <span className="text-[10px] text-[var(--text-muted)] shrink-0 ml-1">{t('shell.menu.trace.copyDir')}</span>
                  </div>
                </div>
              )}
            </div>

            {/* 6. Cloud Menu */}
            {cloudOn && (
            <div className="relative" data-menubar-item>
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === 'cloud' ? null : 'cloud')}
                className={`h-[30px] px-3 rounded-[3px] text-[13px] font-medium cursor-pointer transition-colors ${
                  openMenu === 'cloud'
                    ? 'bg-[var(--bg-row-selected)] text-[var(--text-primary)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-panel)]'
                }`}
              >
                {t('shell.menu.cloud')}
              </button>
              {openMenu === 'cloud' && (
                <div
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="absolute left-0 top-[34px] z-50 border shadow-2xl py-1.5 rounded-[3px] min-w-[280px] text-[12.5px]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      databaseStore.setActiveDocTab('cloud');
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)]"
                  >
                    {t('shell.menu.cloud.openWorkspace')}
                  </button>
                  {isSimEnabled && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenu(null);
                        databaseStore.setActiveDocTab('panels');
                      }}
                      className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-amber-400 font-medium"
                    >
                      {t('shell.menu.cloud.simWorkbench')}
                    </button>
                  )}
                  {cloudHeader.isAuthenticated ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          void handlePushActiveProject();
                        }}
                        className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-sky-400 font-medium"
                      >
                        {t('shell.menu.cloud.pushProject')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          void handleToggleLiveStream();
                        }}
                        className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-emerald-400 font-medium"
                      >
                        {isStreaming ? t('shell.menu.cloud.stopStream') : t('shell.menu.cloud.startStream')}
                      </button>
                      <div className="my-1.5 border-t border-[var(--border-grid)]" />
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          void cloudBridgeStore.disconnectAndLogout();
                          onStatusMessage({
                            kind: 'info',
                            message: t('shell.topbar.cloudSignedOut'),
                          });
                        }}
                        className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-red-400"
                      >
                        {t('shell.menu.cloud.signOut', { email: cloudHeader.userEmail })}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenu(null);
                        databaseStore.setActiveDocTab('cloud');
                      }}
                      className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-sky-400"
                    >
                      {t('shell.menu.cloud.signIn')}
                    </button>
                  )}
                </div>
              )}
            </div>
            )}

            {/* 7. View Menu */}
            <div className="relative" data-menubar-item>
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === 'view' ? null : 'view')}
                className={`h-[30px] px-3 rounded-[3px] text-[13px] font-medium cursor-pointer transition-colors ${
                  openMenu === 'view'
                    ? 'bg-[var(--bg-row-selected)] text-[var(--text-primary)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-panel)]'
                }`}
              >
                {t('shell.menu.view')}
              </button>
              {openMenu === 'view' && (
                <div
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="absolute left-0 top-[34px] z-50 border shadow-2xl py-1.5 rounded-[3px] min-w-[270px] text-[12.5px]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      workbenchStore.toggleDock();
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)] flex items-center justify-between"
                  >
                    <span>{workbench.dockOpen ? t('shell.menu.view.hideDock') : t('shell.menu.view.showDock')}</span>
                    <span className="text-[11px] font-mono text-[var(--text-muted)]">Ctrl+B</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      workbenchStore.toggleDockPosition();
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-secondary)]"
                  >
                    {workbench.dockPosition === 'right' ? t('shell.menu.view.moveDockLeft') : t('shell.menu.view.moveDockRight')}
                  </button>
                  <div className="my-1.5 border-t border-[var(--border-grid)]" />
                  <div className="px-3.5 py-1 text-[11px] font-mono text-[var(--text-muted)] uppercase">
                    {t('shell.menu.view.splitViewHeader')}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      workbenchStore.setSplitSecondaryTab(null);
                    }}
                    className={`w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] ${
                      workbench.splitSecondaryTab === null
                        ? 'text-sky-400 font-semibold'
                        : 'text-[var(--text-primary)]'
                    }`}
                  >
                    {t('shell.menu.view.splitOff')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      workbenchStore.setSplitSecondaryTab('trace');
                    }}
                    className={`w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] ${
                      workbench.splitSecondaryTab === 'trace'
                        ? 'text-sky-400 font-semibold'
                        : 'text-[var(--text-primary)]'
                    }`}
                  >
                    {t('shell.menu.view.splitTrace')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      workbenchStore.setSplitSecondaryTab('plotter');
                    }}
                    className={`w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] ${
                      workbench.splitSecondaryTab === 'plotter'
                        ? 'text-sky-400 font-semibold'
                        : 'text-[var(--text-primary)]'
                    }`}
                  >
                    {t('shell.menu.view.splitPlotter')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      workbenchStore.setSplitSecondaryTab('symbols');
                    }}
                    className={`w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] ${
                      workbench.splitSecondaryTab === 'symbols'
                        ? 'text-sky-400 font-semibold'
                        : 'text-[var(--text-primary)]'
                    }`}
                  >
                    {t('shell.menu.view.splitDbcStudio')}
                  </button>
                  {isSimEnabled && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenu(null);
                        workbenchStore.setSplitSecondaryTab('panels');
                      }}
                      className={`w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] ${
                        workbench.splitSecondaryTab === 'panels'
                          ? 'text-amber-400 font-semibold'
                          : 'text-[var(--text-primary)]'
                      }`}
                    >
                      {t('shell.menu.view.splitSimulation')}
                    </button>
                  )}
                  <div className="my-1.5 border-t border-[var(--border-grid)]" />
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      databaseStore.toggleTheme();
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)]"
                  >
                    {dbState.theme === 'dark' ? t('shell.menu.view.switchToLight') : t('shell.menu.view.switchToDark')}
                  </button>
                  <div className="my-1.5 border-t border-[var(--border-grid)]" />
                  <div className="px-3.5 py-1 text-[11px] font-mono text-[var(--text-muted)] uppercase">
                    {t('shell.menu.view.experimentalHeader')}
                  </div>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={cloudOn}
                    onClick={() => {
                      experimentalStore.setCloudEnabled(!cloudOn);
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)]"
                  >
                    <span className="flex items-center gap-2">
                      <span className="w-4 shrink-0 font-mono text-sky-400">{cloudOn ? '[x]' : '[ ]'}</span>
                      <span>{t('shell.menu.view.experimentalCloud')}</span>
                    </span>
                    <span className="block pl-6 pt-0.5 text-[11px] text-[var(--text-muted)] whitespace-normal max-w-[300px]">
                      {t('shell.menu.view.experimentalCloudNote')}
                    </span>
                  </button>
                </div>
              )}
            </div>

            {/* 8. Help / About Menu */}
            <div className="relative" data-menubar-item>
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === 'help' ? null : 'help')}
                className={`h-[30px] px-3 rounded-[3px] text-[13px] font-medium cursor-pointer transition-colors ${
                  openMenu === 'help'
                    ? 'bg-[var(--bg-row-selected)] text-[var(--text-primary)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-panel)]'
                }`}
              >
                {t('shell.menu.help')}
              </button>
              {openMenu === 'help' && (
                <div
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="absolute left-0 top-[34px] z-50 border shadow-2xl py-1.5 rounded-[3px] min-w-[270px] text-[12.5px]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      projectStore.setToolpacksModalOpen(true);
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)] flex items-center justify-between"
                  >
                    <span>{t('shell.menu.help.toolpacks')}</span>
                    <span className="font-mono text-[10.5px] px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800">
                      {projState.enabledToolpacks.length}/7
                    </span>
                  </button>
                  <div className="my-1.5 border-t border-[var(--border-grid)]" />
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      projectStore.setAcknowledgmentsModalOpen(true);
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)]"
                  >
                    {t('shell.menu.help.about')}
                  </button>
                </div>
              )}
            </div>
          </nav>
        </div>

        {/* Right Corner of Menu Bar: Fixed Organization & Cloud Identity & Language Switcher */}
        <div className="flex items-center gap-2 shrink-0 text-[12px] font-mono tabular-nums">
          {!cloudOn ? null : cloudHeader.isAuthenticated ? (
            <>
              {/* Organization Indicator / Selector */}
              {cloudHeader.organizations.length > 1 ? (
                <div
                  className="h-[28px] px-2.5 border flex items-center gap-1.5 shrink-0 rounded-[3px]"
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                  }}
                  title={t('shell.topbar.activeOrgTooltip', { name: cloudHeader.selectedOrgName || '—' })}
                >
                  <Building2 className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <select
                    value={cloudHeader.selectedOrgId ?? ''}
                    onChange={(e) => cloudBridgeStore.selectOrganization(e.target.value)}
                    className="bg-transparent border-0 outline-none text-[12px] font-mono cursor-pointer py-0 pr-0.5 max-w-[140px] truncate text-[var(--text-primary)]"
                  >
                    {cloudHeader.organizations.map((org) => (
                      <option key={org.id} value={org.id} className="bg-slate-900 text-slate-100">
                        {org.name} ({org.myRole})
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div
                  className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[12px] shrink-0 rounded-[3px]"
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-secondary)',
                  }}
                  title={t('shell.topbar.orgRoleTooltip', {
                    name: cloudHeader.selectedOrgName || t('shell.topbar.orgLoading'),
                    role: cloudHeader.selectedOrgRole || 'engineer',
                  })}
                >
                  <Building2 className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span className="truncate max-w-[130px] text-[var(--text-primary)] font-medium">
                    {cloudHeader.selectedOrgName || t('shell.topbar.orgLoading')}
                  </span>
                  {cloudHeader.selectedOrgRole && (
                    <span className="text-[11px] text-[var(--text-muted)]">
                      [{cloudHeader.selectedOrgRole}]
                    </span>
                  )}
                </div>
              )}

              {/* Live Telemetry / Bound Badge */}
              <button
                type="button"
                onClick={() => {
                  workbenchStore.setBottomTab('cloud');
                  workbenchStore.setDockOpen(true);
                }}
                style={{
                  backgroundColor: isStreaming
                    ? 'rgba(16, 185, 129, 0.15)'
                    : 'rgba(56, 189, 248, 0.12)',
                  borderColor: isStreaming ? '#10B981' : 'rgba(56, 189, 248, 0.45)',
                  color: isStreaming ? '#34D399' : '#38BDF8',
                }}
                className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[12px] font-semibold hover:opacity-90 cursor-pointer shrink-0 rounded-[3px]"
                title={t('shell.topbar.cloudBadgeTooltip')}
              >
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    isStreaming ? 'bg-emerald-400 animate-pulse' : 'bg-sky-400'
                  }`}
                />
                <span>
                  {isStreaming
                    ? `LIVE ${cloudHeader.targetHz}Hz`
                    : `☁ ${projState.cloudBinding?.projectCode ?? 'Cloud'}`}
                </span>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => databaseStore.setActiveDocTab('cloud')}
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-muted)',
              }}
              className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[12px] hover:text-[var(--text-primary)] cursor-pointer shrink-0 rounded-[3px]"
              title={t('shell.topbar.localModeBtnTooltip')}
            >
              <span className="w-2 h-2 rounded-full bg-slate-500 shrink-0" />
              <span>{t('shell.topbar.localModeBtn')}</span>
            </button>
          )}

          {/* Segmented Language Selector (TR | EN) */}
          <div
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
            }}
            className="h-[28px] border flex items-center p-0.5 rounded-[3px] shrink-0 font-mono text-[11px]"
            title={t('shell.lang.switchTitle')}
          >
            <button
              type="button"
              onClick={() => setLocale('tr')}
              style={{
                backgroundColor: locale === 'tr' ? 'var(--bg-row-selected)' : 'transparent',
                color: locale === 'tr' ? '#38BDF8' : 'var(--text-muted)',
              }}
              className={`h-full px-2 rounded-[2px] font-semibold cursor-pointer transition-colors ${
                locale === 'tr' ? 'border border-sky-500/50' : 'hover:text-[var(--text-primary)]'
              }`}
            >
              {t('shell.lang.tr')}
            </button>
            <button
              type="button"
              onClick={() => setLocale('en')}
              style={{
                backgroundColor: locale === 'en' ? 'var(--bg-row-selected)' : 'transparent',
                color: locale === 'en' ? '#38BDF8' : 'var(--text-muted)',
              }}
              className={`h-full px-2 rounded-[2px] font-semibold cursor-pointer transition-colors ${
                locale === 'en' ? 'border border-sky-500/50' : 'hover:text-[var(--text-primary)]'
              }`}
            >
              {t('shell.lang.en')}
            </button>
          </div>
        </div>
      </div>

      {/* ==================================================================== */}
      {/* ROW 2 (42px): KOMPAKT MÜHENDİSLİK ARAÇ ÇUBUĞU                         */}
      {/* ==================================================================== */}
      <div
        style={{
          backgroundColor: 'var(--bg-toolbar)',
        }}
        className="min-h-[42px] py-1 px-3 flex items-center justify-between gap-2 flex-wrap"
      >
        {/* Left: Engineering Icon Groups */}
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
          {/* GROUP 1: PROJECT ACTIONS */}
          <button
            type="button"
            onClick={() => projectStore.setModalOpen(true)}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[32px] w-[34px] border flex items-center justify-center hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)] cursor-pointer rounded-[3px]"
            title={t('shell.toolbar.newProjectTooltip')}
          >
            <FilePlus2 className="w-4 h-4 text-emerald-400" />
          </button>
          <button
            type="button"
            onClick={() => projectStore.setModalOpen(true)}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[32px] w-[34px] border flex items-center justify-center hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)] cursor-pointer rounded-[3px]"
            title={t('shell.toolbar.openProjectsTooltip')}
          >
            <FolderOpen className="w-4 h-4 text-amber-400" />
          </button>
          <button
            type="button"
            onClick={() => void onQuickSaveProject()}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[32px] w-[34px] border flex items-center justify-center hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)] cursor-pointer rounded-[3px]"
            title={t('shell.toolbar.saveProjectTooltip')}
          >
            <Save className="w-4 h-4 text-sky-400" />
          </button>
          {projState.hasActiveWorkspace && (
            <button
              type="button"
              onClick={() => void handleCloseProject()}
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-secondary)',
              }}
              className="h-[32px] w-[34px] border flex items-center justify-center hover:text-red-400 hover:border-red-500/50 cursor-pointer rounded-[3px]"
              title={t('shell.toolbar.closeProjectTooltip')}
            >
              <FolderX className="w-4 h-4 text-red-400" />
            </button>
          )}

          <div className="h-5 w-px bg-[var(--border-strong)] mx-1" />

          {/* GROUP 2: CAN HARDWARE & CLEAR */}
          <button
            type="button"
            onClick={() => workbenchStore.setNewConnectionModalOpen(true)}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[32px] px-2.5 border flex items-center gap-1.5 text-[12.5px] font-semibold hover:border-emerald-500 cursor-pointer rounded-[3px]"
            title={t('shell.toolbar.addConnectionTooltip')}
          >
            <Plus className="w-3.5 h-3.5 text-emerald-400" />
            <PlugZap className="w-4 h-4 text-emerald-400" />
          </button>
          <button
            type="button"
            disabled={connectedBusCount === 0}
            onClick={() => void handleDisconnectAll()}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: connectedBusCount === 0 ? 'var(--text-muted)' : '#F87171',
            }}
            className="h-[32px] w-[34px] border flex items-center justify-center hover:border-red-500 cursor-pointer rounded-[3px] disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('shell.toolbar.disconnectAllTooltip', { count: connectedBusCount })}
          >
            <Unplug className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => void onClearWorkspace()}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[32px] w-[34px] border flex items-center justify-center hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)] cursor-pointer rounded-[3px]"
            title={t('shell.toolbar.resetCountersTooltip')}
          >
            <RotateCcw className="w-4 h-4" />
          </button>

          <div className="h-5 w-px bg-[var(--border-strong)] mx-1" />

          {/* GROUP 2.5: TRACE RECORDING (Single Toggle & Multi-Trace Spawn) */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Button 1: Single Trace Start/Stop */}
            <button
              type="button"
              onClick={handleToggleTraceRecording}
              style={
                activeTrace.state === 'recording'
                  ? {
                      backgroundColor: 'rgba(239, 68, 68, 0.16)',
                      borderColor: '#EF4444',
                      color: '#FCA5A5',
                    }
                  : {
                      backgroundColor: 'var(--bg-panel)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }
              }
              className={`h-[32px] px-3 border flex items-center gap-2 text-[12.5px] font-semibold cursor-pointer rounded-[3px] transition-colors ${
                activeTrace.state === 'recording'
                  ? 'hover:bg-red-900/60 shadow-[0_0_8px_rgba(239,68,68,0.35)]'
                  : 'hover:border-red-500/80 hover:text-red-400'
              }`}
              title={
                activeTrace.state === 'recording'
                  ? t('shell.toolbar.stopRecordingTooltip', {
                      name: activeTrace.name,
                      count: activeTrace.count.toLocaleString('en-US'),
                    })
                  : t('shell.toolbar.startRecordingTooltip', { name: activeTrace.name })
              }
            >
              {activeTrace.state === 'recording' ? (
                <>
                  <Square className="w-3.5 h-3.5 fill-current text-red-400 shrink-0" />
                  <span className="font-semibold text-red-200">{t('shell.toolbar.stopRecording')}</span>
                  <span className="font-mono tabular-nums text-[11.5px] text-red-300 inline-flex items-center gap-0.5">
                    <span>· {activeTrace.name}</span>
                    <span>(</span>
                    <span className="inline-block min-w-[3.5ch] text-right font-mono tabular-nums">
                      {activeTrace.count.toLocaleString('en-US')}
                    </span>
                    <span>)</span>
                  </span>
                </>
              ) : (
                <>
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500 shrink-0 shadow-[0_0_6px_rgba(239,68,68,0.7)]" />
                  <span>{t('shell.toolbar.startRecording')}</span>
                  <span className="font-mono tabular-nums text-[11.5px] text-[var(--text-muted)] hidden sm:inline">
                    ({activeTrace.name})
                  </span>
                </>
              )}
            </button>

            {/* Button 2: Spawn Additional Trace Session */}
            <button
              type="button"
              onClick={handleSpawnNewTraceSession}
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              className="h-[32px] px-2.5 border flex items-center gap-1.5 text-[12.5px] font-medium hover:border-sky-500 hover:text-sky-400 cursor-pointer rounded-[3px]"
              title={t('shell.toolbar.spawnTraceTooltip')}
            >
              <Plus className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <span className="hidden sm:inline">{t('shell.toolbar.spawnTraceBtn')}</span>
            </button>

            {/* Multi-recording badge */}
            {traceState.recordingCount > 1 && (
              <span
                className="h-[32px] px-2.5 border border-red-500/70 bg-red-950/70 text-red-300 font-mono text-[11.5px] font-bold flex items-center gap-1.5 rounded-[3px] animate-pulse shrink-0"
                title={t('shell.toolbar.multiRecordingTooltip', { count: traceState.recordingCount })}
              >
                <span className="w-2 h-2 rounded-full bg-red-400" />
                <span>{traceState.recordingCount} REC</span>
              </span>
            )}

            {/* Live Replay Status & Controls Pill */}
            {header.replay && header.replay.state !== 'idle' && (
              <div className="flex items-center gap-2 px-2.5 h-[32px] bg-cyan-950/70 border border-cyan-500/60 rounded-[3px] text-[12.5px] shrink-0">
                <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse shrink-0 shadow-xs shadow-cyan-400/50" />
                <span className="font-bold text-cyan-300 uppercase text-[11.5px] truncate max-w-[130px]">
                  {t('shell.toolbar.replayStatus', { source: header.replay.sourceName || 'Trace' })}
                </span>
                <span className="font-mono tabular-nums text-[11.5px] text-cyan-200 inline-block w-[5ch] text-right">
                  {Math.round((header.replay.currentIndex / Math.max(1, header.replay.totalFrames)) * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void apiControlTraceReplay({
                      action: header.replay.state === 'playing' ? 'pause' : 'resume',
                    })
                  }
                  className="p-1 hover:text-cyan-200 text-cyan-400 cursor-pointer"
                  title={header.replay.state === 'playing' ? t('shell.toolbar.replayPause') : t('shell.toolbar.replayResume')}
                >
                  {header.replay.state === 'playing' ? (
                    <Pause className="w-3.5 h-3.5" />
                  ) : (
                    <Play className="w-3.5 h-3.5 fill-current" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void apiControlTraceReplay({ action: 'stop' });
                    traceSessionsStore.setReplayingSessionId(null);
                  }}
                  className="p-1 hover:text-red-300 text-red-400 cursor-pointer"
                  title={t('shell.toolbar.replayStop')}
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                </button>
              </div>
            )}
          </div>

          <div className="h-5 w-px bg-[var(--border-strong)] mx-1" />

          {/* GROUP 3: CLOUD & LIVE BRIDGE */}
          {cloudOn && cloudHeader.isAuthenticated && (
            <>
              <button
                type="button"
                disabled={cloudHeader.syncingWorkspace}
                onClick={() => void handlePushActiveProject()}
                style={{
                  backgroundColor: 'var(--bg-panel)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-secondary)',
                }}
                className="h-[32px] px-2.5 border flex items-center gap-1.5 text-[12.5px] hover:text-[var(--text-primary)] hover:border-sky-500 cursor-pointer rounded-[3px] disabled:opacity-50"
                title={t('shell.toolbar.pushCloudTooltip', { code: projState.cloudBinding?.projectCode ?? 'New' })}
              >
                <UploadCloud className="w-4 h-4 text-sky-400" />
                <span className="hidden sm:inline">
                  {cloudHeader.syncingWorkspace ? t('shell.toolbar.pushingBtn') : t('shell.toolbar.pushBtn')}
                </span>
              </button>

              <button
                type="button"
                onClick={() => void handleToggleLiveStream()}
                style={{
                  backgroundColor: isStreaming
                    ? 'rgba(239, 68, 68, 0.12)'
                    : 'rgba(16, 185, 129, 0.12)',
                  borderColor: isStreaming ? 'rgba(239, 68, 68, 0.45)' : 'rgba(16, 185, 129, 0.5)',
                  color: isStreaming ? '#F87171' : '#34D399',
                }}
                className="h-[32px] px-2.5 border flex items-center gap-1.5 text-[12.5px] font-semibold hover:opacity-90 cursor-pointer rounded-[3px]"
                title={isStreaming ? t('shell.toolbar.stopLiveStreamTooltip') : t('shell.toolbar.startLiveStreamTooltip')}
              >
                {isStreaming ? (
                  <>
                    <Square className="w-3.5 h-3.5 fill-current text-red-400" />
                    <span>{t('shell.toolbar.stopLiveStream')}</span>
                  </>
                ) : (
                  <>
                    <Radio className="w-3.5 h-3.5 text-emerald-400" />
                    <span>{t('shell.toolbar.startLiveStream')}</span>
                  </>
                )}
              </button>

              <div className="h-5 w-px bg-[var(--border-strong)] mx-1" />
            </>
          )}

          {/* GROUP 4: VIEW & SPLIT CONTROLS */}
          <div className="flex items-center gap-1.5 text-[12px] font-mono text-[var(--text-muted)]">
            <Columns2 className="w-4 h-4 text-[var(--text-secondary)]" />
            <span className="hidden md:inline">{t('shell.toolbar.splitLabel')}</span>
            <select
              value={workbench.splitSecondaryTab ?? ''}
              onChange={(e) =>
                workbenchStore.setSplitSecondaryTab(
                  e.target.value ? (e.target.value as ActiveDocumentTab) : null,
                )
              }
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              className="h-[32px] px-2 border text-[12px] font-mono cursor-pointer rounded-[3px] focus:outline-none"
              title={t('shell.toolbar.splitSelectTooltip')}
            >
              <option value="">{t('shell.toolbar.splitSinglePane')}</option>
              <option value="trace">+ {t('shell.tab.trace')}</option>
              <option value="plotter">+ {t('shell.tab.plotter')}</option>
              <option value="symbols">+ {t('shell.tab.dbcStudio')}</option>
              {isSimEnabled && <option value="panels">+ {t('shell.tab.panels')}</option>}
            </select>
          </div>

          <button
            type="button"
            onClick={() => databaseStore.toggleTheme()}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[32px] w-[34px] border flex items-center justify-center hover:text-[var(--text-primary)] cursor-pointer rounded-[3px]"
            title={dbState.theme === 'dark' ? t('shell.toolbar.themeLight') : t('shell.toolbar.themeDark')}
          >
            {dbState.theme === 'dark' ? (
              <Sun className="w-4 h-4 text-amber-400" />
            ) : (
              <Moon className="w-4 h-4 text-sky-400" />
            )}
          </button>

          <button
            type="button"
            onClick={() => workbenchStore.toggleDock()}
            style={{
              backgroundColor: workbench.dockOpen
                ? 'var(--bg-row-selected)'
                : 'var(--bg-panel)',
              borderColor: workbench.dockOpen
                ? 'var(--border-strong)'
                : 'var(--border-strong)',
              color: workbench.dockOpen ? '#38BDF8' : 'var(--text-secondary)',
            }}
            className="h-[32px] px-2.5 border flex items-center gap-1.5 text-[12.5px] font-medium hover:text-[var(--text-primary)] cursor-pointer rounded-[3px]"
            title={t('shell.toolbar.explorerDockTooltip')}
          >
            <PanelRight className="w-4 h-4" />
            <span className="hidden lg:inline text-[12px] font-mono">{t('shell.toolbar.explorerDockLabel')}</span>
          </button>

          <button
            type="button"
            onClick={() => projectStore.setToolpacksModalOpen(true)}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[32px] px-2.5 border flex items-center gap-1.5 text-[12.5px] font-medium hover:text-cyan-400 hover:border-cyan-500/50 cursor-pointer rounded-[3px]"
            title={t('shell.toolbar.toolpacksTooltip', { count: projState.enabledToolpacks.length })}
          >
            <Boxes className="w-4 h-4 text-cyan-400" />
            <span className="hidden xl:inline text-[12px] font-mono">{t('shell.toolbar.toolpacksLabel')}</span>
            <span className="px-1.5 py-0.5 rounded bg-cyan-950/70 border border-cyan-800/60 text-cyan-300 font-mono text-[11px]">
              {projState.enabledToolpacks.length}/7
            </span>
          </button>

          <button
            type="button"
            onClick={() => projectStore.setAcknowledgmentsModalOpen(true)}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[32px] w-[34px] border flex items-center justify-center hover:text-amber-300 hover:border-amber-500/50 cursor-pointer rounded-[3px]"
            title={t('shell.toolbar.aboutTooltip')}
          >
            <Award className="w-4 h-4 text-amber-400" />
          </button>
        </div>

        {/* Right Corner: Fixed Panic / Emergency Stop Safety Switch */}
        <div className="flex items-center gap-1.5 shrink-0">
          <TxModeControl />
          <button
            type="button"
            onClick={() => void onPanicStop()}
            style={
              isUrgentStop
                ? undefined
                : {
                    backgroundColor: 'rgba(185, 28, 28, 0.12)',
                    borderColor: 'rgba(185, 28, 28, 0.45)',
                    color: dbState.theme === 'dark' ? '#F87171' : '#B91C1C',
                  }
            }
            className={`h-[32px] px-3.5 border flex items-center gap-1.5 text-[12.5px] font-bold cursor-pointer rounded-[3px] ${
              isUrgentStop
                ? 'bg-red-700 hover:bg-red-600 text-white border-red-500'
                : 'hover:border-red-500'
            }`}
            title={t('shell.toolbar.panicStopTooltip')}
          >
            <OctagonAlert className="w-4 h-4" />
            <span className="font-mono tabular-nums text-[12.5px]">
              {header.txPanicLatched ? t('shell.toolbar.panicLatched') : t('shell.toolbar.stopAllTx')}
            </span>
          </button>
        </div>
      </div>
    </header>
  );
};
