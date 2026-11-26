import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { TxModeControl } from './TxModeControl';
import {
  Award,
  Boxes,
  Building2,
  Columns2,
  Ellipsis,
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
  RefreshCw,
  RotateCcw,
  Save,
  ScrollText,
  Square,
  Sun,
  Unplug,
  UploadCloud,
} from 'lucide-react';
import { apiControlTraceReplay, apiDisconnectAllBuses, isTauri } from '../services/ipcClient';
import { updateStore } from '../store/updateStore';
import { cloudBridgeStore, useCloudBridgeHeader } from '../store/cloudBridgeStore';
import { useExperimentalCloud } from '../store/experimentalStore';
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
import { mcpStore, useMcpStore } from '../store/mcpStore';
import { UI_SCALE_OPTIONS, uiScaleStore, useUiScale } from '../store/uiScaleStore';
import { onboardingStore } from '../store/onboardingStore';
import { guidePageForTab } from '../onboarding/registry';
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
  | 'help'
  | 'overflow';

const OVERFLOW_ITEM_CLS =
  'w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)] flex items-center gap-2 disabled:opacity-50';

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
  const guidePage = guidePageForTab(dbState.activeDocTab);
  const projState = useProjectStore();
  const cloudHeader = useCloudBridgeHeader();
  const cloudOn = useExperimentalCloud();
  const workbench = useWorkbenchStore();
  const mcp = useMcpStore();
  const traceState = useTraceSessionsStore();
  const activeTrace = traceSessionsStore.getSession(traceState.activeSessionId);

  const [openMenu, setOpenMenu] = useState<MenuKey | null>(null);
  const uiScale = useUiScale();

  useEffect(() => {
    uiScaleStore.init();
  }, []);

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
      const loaded = await traceSessionsStore.importTraceFileObject(file, false);
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
    <header className="@container shrink-0 min-w-0 select-none text-[12px] flex flex-col border-b border-[var(--border-strong)]">
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
        className="h-[36px] px-3 flex flex-nowrap items-center justify-between gap-2 min-w-0"
      >
        {/* Left: Backend status + Logo + Project Title + Desktop Menus */}
        <div className="flex flex-nowrap items-center gap-1.5 min-w-0 flex-1">
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
              connectedBusCount > 0
                ? 'bg-nominal'
                : header.transportConnected
                  ? 'bg-muted'
                  : 'bg-warn'
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
            className="w-[18px] h-[18px] rounded-[2px] border border-[var(--status-focus)]/60 shrink-0 mx-1"
            width={18}
            height={18}
          />
          <span className="font-bold tracking-tight text-[var(--text-primary)] text-[13px] truncate min-w-0 shrink max-w-[220px] @max-[1500px]:max-w-[140px] pr-2.5 border-r border-[var(--border-grid)]" title={projState.currentName}>
            {projState.currentName}
          </span>

          {/* Menus Container */}
          <nav className="flex flex-nowrap items-center gap-1 text-[13px] font-sans shrink-0 whitespace-nowrap">
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
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-critical disabled:opacity-40 disabled:hover:bg-transparent"
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
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-nominal font-medium"
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
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-critical disabled:opacity-40 disabled:hover:bg-transparent font-medium"
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
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-focus"
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
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-critical font-semibold flex items-center justify-between"
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
                      activeTrace.state === 'recording' ? 'text-critical' : 'text-nominal'
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
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-focus font-medium flex items-center justify-between"
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
                      className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-warn"
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
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-warn font-medium"
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
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-nominal font-medium disabled:opacity-40"
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
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-focus font-medium disabled:opacity-40"
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
                      <span className="text-critical font-bold">{traceState.recordingCount} REC</span>
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
                          isSelected ? 'bg-[var(--bg-row-selected)] text-focus font-semibold' : 'text-[var(--text-primary)]'
                        }`}
                      >
                        <span className="flex items-center gap-1.5 truncate">
                          <span
                            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                              sess.state === 'recording'
                                ? 'bg-critical animate-pulse'
                                : sess.state === 'paused'
                                  ? 'bg-warn'
                                  : 'bg-muted'
                            }`}
                          />
                          <span className="truncate">{sess.name}</span>
                          {isSelected && <span className="text-[11px] text-focus">{t('shell.menu.trace.active')}</span>}
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
                    className="px-3.5 py-2 bg-[var(--bg-toolbar)] text-[11px] font-mono text-nominal cursor-pointer hover:bg-[var(--bg-row-hover)] flex items-center justify-between"
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
                      className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-warn font-medium"
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
                        className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-focus font-medium"
                      >
                        {t('shell.menu.cloud.pushProject')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          void handleToggleLiveStream();
                        }}
                        className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-nominal font-medium"
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
                        className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-critical"
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
                      className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-focus"
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
                        ? 'text-focus font-semibold'
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
                        ? 'text-focus font-semibold'
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
                        ? 'text-focus font-semibold'
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
                        ? 'text-focus font-semibold'
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
                          ? 'text-warn font-semibold'
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
                    {t('shell.menu.view.uiScale')}
                  </div>
                  <div className="px-3.5 pb-1.5 pt-0.5 flex items-center gap-1" role="group" aria-label={t('shell.menu.view.uiScale')}>
                    {UI_SCALE_OPTIONS.map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => uiScaleStore.set(pct)}
                        aria-pressed={uiScale === pct}
                        className={`flex-1 h-[28px] border rounded-[3px] font-mono tabular-nums text-[12px] cursor-pointer ${
                          uiScale === pct
                            ? 'border-[var(--status-focus-border)] bg-[var(--bg-row-selected)] text-focus font-semibold'
                            : 'border-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                        }`}
                      >
                        {pct}%
                      </button>
                    ))}
                  </div>
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
                  {guidePage !== null && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenu(null);
                        onboardingStore.openDialog(guidePage.id);
                      }}
                      className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)]"
                    >
                      {t('onb.menu.thisPage')}
                    </button>
                  )}
                  <div className="my-1.5 border-t border-[var(--border-grid)]" />
                  {isTauri && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenu(null);
                        updateStore.openDialog(true);
                      }}
                      className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)]"
                    >
                      {t('upd.menu.check')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      updateStore.openChangelog();
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)]"
                  >
                    {t('upd.menu.changelog')}
                  </button>
                </div>
              )}
            </div>
          </nav>
        </div>

        {/* Right corner of the menu bar */}
        <div className="flex flex-nowrap items-center gap-2 shrink-0 text-[12px] font-mono tabular-nums">
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
                  <Building2 className="w-3.5 h-3.5 text-focus shrink-0" />
                  <select
                    value={cloudHeader.selectedOrgId ?? ''}
                    onChange={(e) => cloudBridgeStore.selectOrganization(e.target.value)}
                    className="bg-transparent border-0 outline-none text-[12px] font-mono cursor-pointer py-0 pr-0.5 max-w-[140px] @max-[1500px]:max-w-[90px] truncate text-[var(--text-primary)]"
                  >
                    {cloudHeader.organizations.map((org) => (
                      <option key={org.id} value={org.id} className="bg-panel text-primary">
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
                  <Building2 className="w-3.5 h-3.5 text-focus shrink-0" />
                  <span className="truncate max-w-[130px] @max-[1500px]:max-w-[80px] text-[var(--text-primary)] font-medium">
                    {cloudHeader.selectedOrgName || t('shell.topbar.orgLoading')}
                  </span>
                  {cloudHeader.selectedOrgRole && (
                    <span className="text-[11px] text-[var(--text-muted)] @max-[1500px]:hidden">
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
                    ? 'var(--status-nominal-bg)'
                    : 'var(--status-focus-bg)',
                  borderColor: isStreaming ? 'var(--status-nominal)' : 'var(--status-focus-border)',
                  color: isStreaming ? 'var(--status-nominal)' : 'var(--status-focus)',
                }}
                className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[12px] font-semibold hover:opacity-90 cursor-pointer shrink-0 rounded-[3px]"
                title={t('shell.topbar.cloudBadgeTooltip')}
                aria-label={t('shell.topbar.cloudBadgeTooltip')}
              >
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    isStreaming ? 'bg-nominal animate-pulse' : 'bg-focus'
                  }`}
                />
                <span className="@max-[1400px]:hidden">
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
              aria-label={t('shell.topbar.localModeBtnTooltip')}
            >
              <span className="w-2 h-2 rounded-full bg-muted shrink-0" />
              <span className="@max-[1400px]:hidden">{t('shell.topbar.localModeBtn')}</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => projectStore.setToolpacksModalOpen(true)}
            title={t('shell.toolbar.toolpacksTooltip', { count: projState.enabledToolpacks.length })}
            aria-label={t('shell.toolbar.toolpacksLabel')}
            className="h-[28px] shrink-0 px-2 border border-strong bg-panel flex items-center gap-1.5 rounded-[3px] text-[11px] hover:border-[var(--status-focus-border)] cursor-pointer"
          >
            <Boxes className="size-3.5 text-focus" />
            <span className="@max-[1100px]:hidden text-[var(--text-primary)]">{t('shell.toolbar.toolpacksLabel')}</span>
            <span className="text-focus">{projState.enabledToolpacks.length}/7</span>
          </button>

          <button
            type="button"
            onClick={() => mcpStore.setPanelOpen(true)}
            title={mcp.activity ?? (mcp.available ? t('mcp.statusbar.tooltip') : t('mcp.unavailable'))}
            aria-label={t('mcp.menu.item')}
            className="h-[28px] shrink-0 px-2 border border-strong bg-panel flex items-center gap-1.5 rounded-[3px] text-[11px] text-[var(--text-primary)] hover:border-[var(--status-focus-border)] cursor-pointer"
          >
            <span
              className={`size-1.5 rounded-full ${mcp.activity !== null ? 'bg-focus' : mcp.status?.running ? 'bg-nominal' : 'bg-muted'}`}
            />
            <span>{t('mcp.statusbar.label')}</span>
            {mcp.status?.running && <span className="@max-[1100px]:hidden text-nominal">:{mcp.status.port ?? ''} · {mcp.status.connectedClients}</span>}
          </button>

          <button
            type="button"
            onClick={() => projectStore.setAcknowledgmentsModalOpen(true)}
            title={t('shell.toolbar.aboutTooltip')}
            aria-label={t('modal.ack.title')}
            className="h-[28px] w-[28px] shrink-0 border border-strong bg-panel grid place-items-center rounded-[3px] text-warn hover:border-[var(--status-warn-border)] cursor-pointer"
          >
            <Award className="size-4" />
          </button>

          <select
            value={locale}
            onChange={(event) => setLocale(event.target.value === 'tr' ? 'tr' : 'en')}
            title={t('shell.lang.switchTitle')}
            aria-label={t('shell.lang.switchTitle')}
            className="h-[28px] shrink-0 px-1.5 border border-strong bg-panel rounded-[3px] text-[11px] text-[var(--text-primary)] cursor-pointer"
          >
            <option value="tr">{t('shell.lang.tr')}</option>
            <option value="en">{t('shell.lang.en')}</option>
          </select>

          <button
            type="button"
            onClick={() => databaseStore.toggleTheme()}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[28px] w-[28px] shrink-0 border flex items-center justify-center hover:border-[var(--text-secondary)] cursor-pointer rounded-[3px]"
            title={dbState.theme === 'dark' ? t('shell.toolbar.themeLight') : t('shell.toolbar.themeDark')}
            aria-label={dbState.theme === 'dark' ? t('shell.toolbar.themeLight') : t('shell.toolbar.themeDark')}
          >
            {dbState.theme === 'dark' ? (
              <Sun className="w-4 h-4 text-warn" />
            ) : (
              <Moon className="w-4 h-4 text-focus" />
            )}
          </button>
        </div>
      </div>

      {/* ==================================================================== */}
      {/* ROW 2 (42px): KOMPAKT MÜHENDİSLİK ARAÇ ÇUBUĞU                         */}
      {/* ==================================================================== */}
      <div
        style={{
          backgroundColor: 'var(--bg-toolbar)',
        }}
        className="h-[42px] px-3 flex flex-nowrap items-center justify-between gap-2 min-w-0"
      >
        {/* Left: Engineering Icon Groups */}
        <div className="flex flex-nowrap items-center gap-1.5 min-w-0 flex-1 overflow-hidden whitespace-nowrap [&>*]:shrink-0">
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
            <FilePlus2 className="w-4 h-4 text-nominal" />
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
            <FolderOpen className="w-4 h-4 text-warn" />
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
            <Save className="w-4 h-4 text-focus" />
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
              className="h-[32px] w-[34px] border flex items-center justify-center hover:text-critical hover:border-[var(--status-critical-border)] cursor-pointer rounded-[3px]"
              title={t('shell.toolbar.closeProjectTooltip')}
            >
              <FolderX className="w-4 h-4 text-critical" />
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
            className="h-[32px] px-2.5 border flex items-center gap-1.5 text-[12.5px] font-semibold hover:border-nominal cursor-pointer rounded-[3px]"
            title={t('shell.toolbar.addConnectionTooltip')}
          >
            <Plus className="w-3.5 h-3.5 text-nominal" />
            <PlugZap className="w-4 h-4 text-nominal" />
          </button>
          <button
            type="button"
            disabled={connectedBusCount === 0}
            onClick={() => void handleDisconnectAll()}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: connectedBusCount === 0 ? 'var(--text-muted)' : 'var(--status-critical)',
            }}
            className="h-[32px] w-[34px] border flex items-center justify-center hover:border-critical cursor-pointer rounded-[3px] disabled:opacity-40 disabled:cursor-not-allowed"
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
                      backgroundColor: 'var(--status-critical-bg)',
                      borderColor: 'var(--status-critical)',
                      color: 'var(--status-critical)',
                    }
                  : {
                      backgroundColor: 'var(--bg-panel)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }
              }
              className={`h-[32px] px-3 border flex items-center gap-2 text-[12.5px] font-semibold cursor-pointer rounded-[3px] transition-colors ${
                activeTrace.state === 'recording'
                  ? 'hover:bg-[var(--status-critical-bg)]'
                  : 'hover:border-[var(--status-critical-border)] hover:text-critical'
              }`}
              title={
                activeTrace.state === 'recording'
                  ? t('shell.toolbar.stopRecordingTooltip', {
                      name: activeTrace.name,
                      count: activeTrace.count.toLocaleString('en-US'),
                    })
                  : t('shell.toolbar.startRecordingTooltip', { name: activeTrace.name })
              }
              aria-label={t('shell.toolbar.startRecordingTooltip', { name: activeTrace.name })}
            >
              {activeTrace.state === 'recording' ? (
                <>
                  <Square className="w-3.5 h-3.5 fill-current text-critical shrink-0" />
                  <span className="font-semibold text-critical @max-[1500px]:hidden">{t('shell.toolbar.stopRecording')}</span>
                  <span className="font-mono tabular-nums text-[11.5px] text-critical inline-flex items-center gap-0.5">
                    <span className="@max-[2100px]:hidden">· {activeTrace.name}</span>
                    <span>(</span>
                    <span className="inline-block min-w-[3.5ch] text-right font-mono tabular-nums">
                      {activeTrace.count.toLocaleString('en-US')}
                    </span>
                    <span>)</span>
                  </span>
                </>
              ) : (
                <>
                  <span className="w-2.5 h-2.5 rounded-full bg-critical shrink-0" />
                  <span className="@max-[1500px]:hidden">{t('shell.toolbar.startRecording')}</span>
                  <span className="font-mono tabular-nums text-[11.5px] text-[var(--text-muted)] @max-[2100px]:hidden">
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
              className="h-[32px] px-2.5 border flex items-center gap-1.5 text-[12.5px] font-medium hover:border-focus hover:text-focus cursor-pointer rounded-[3px]"
              title={t('shell.toolbar.spawnTraceTooltip')}
              aria-label={t('shell.toolbar.spawnTraceTooltip')}
            >
              <Plus className="w-3.5 h-3.5 text-focus shrink-0" />
              <span className="@max-[2100px]:hidden">{t('shell.toolbar.spawnTraceBtn')}</span>
            </button>

            {/* Multi-recording badge */}
            {traceState.recordingCount > 1 && (
              <span
                className="h-[32px] px-2.5 border border-[var(--status-critical-border)] bg-[var(--status-critical-bg)] text-critical font-mono text-[11.5px] font-bold flex items-center gap-1.5 rounded-[3px] animate-pulse shrink-0"
                title={t('shell.toolbar.multiRecordingTooltip', { count: traceState.recordingCount })}
              >
                <span className="w-2 h-2 rounded-full bg-critical" />
                <span>{traceState.recordingCount} REC</span>
              </span>
            )}

            {/* Live Replay Status & Controls Pill */}
            {header.replay && header.replay.state !== 'idle' && (
              <div className="flex items-center gap-2 px-2.5 h-[32px] bg-[var(--status-focus-bg)] border border-[var(--status-focus-border)] rounded-[3px] text-[12.5px] shrink-0">
                <span className="w-2.5 h-2.5 rounded-full bg-focus animate-pulse shrink-0 shadow-xs" />
                <span className="font-bold text-focus uppercase text-[11.5px] truncate max-w-[130px]">
                  {t('shell.toolbar.replayStatus', { source: header.replay.sourceName || 'Trace' })}
                </span>
                <span className="font-mono tabular-nums text-[11.5px] text-focus inline-block w-[5ch] text-right">
                  {Math.round((header.replay.currentIndex / Math.max(1, header.replay.totalFrames)) * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void apiControlTraceReplay({
                      action: header.replay.state === 'playing' ? 'pause' : 'resume',
                    })
                  }
                  className="p-1 hover:text-focus text-focus cursor-pointer"
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
                  className="p-1 hover:text-critical text-critical cursor-pointer"
                  title={t('shell.toolbar.replayStop')}
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                </button>
              </div>
            )}
          </div>

          {/* TIER 3 (<1660px container): moves to the overflow menu */}
          <div className="flex flex-nowrap items-center gap-1.5 @max-[1660px]:hidden">
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
                className="h-[32px] px-2.5 border flex items-center gap-1.5 text-[12.5px] hover:text-[var(--text-primary)] hover:border-focus cursor-pointer rounded-[3px] disabled:opacity-50"
                title={t('shell.toolbar.pushCloudTooltip', { code: projState.cloudBinding?.projectCode ?? 'New' })}
              >
                <UploadCloud className="w-4 h-4 text-focus" />
                <span className="@max-[2100px]:hidden">
                  {cloudHeader.syncingWorkspace ? t('shell.toolbar.pushingBtn') : t('shell.toolbar.pushBtn')}
                </span>
              </button>

              <button
                type="button"
                onClick={() => void handleToggleLiveStream()}
                style={{
                  backgroundColor: isStreaming
                    ? 'var(--status-critical-bg)'
                    : 'var(--status-nominal-bg)',
                  borderColor: isStreaming ? 'var(--status-critical-border)' : 'var(--status-nominal-border)',
                  color: isStreaming ? 'var(--status-critical)' : 'var(--status-nominal)',
                }}
                className="h-[32px] px-2.5 border flex items-center gap-1.5 text-[12.5px] font-semibold hover:opacity-90 cursor-pointer rounded-[3px]"
                title={isStreaming ? t('shell.toolbar.stopLiveStreamTooltip') : t('shell.toolbar.startLiveStreamTooltip')}
              >
                {isStreaming ? (
                  <>
                    <Square className="w-3.5 h-3.5 fill-current text-critical" />
                    <span className="@max-[2100px]:hidden">{t('shell.toolbar.stopLiveStream')}</span>
                  </>
                ) : (
                  <>
                    <Radio className="w-3.5 h-3.5 text-nominal" />
                    <span className="@max-[2100px]:hidden">{t('shell.toolbar.startLiveStream')}</span>
                  </>
                )}
              </button>

              <div className="h-5 w-px bg-[var(--border-strong)] mx-1" />
            </>
          )}

          {/* GROUP 4: VIEW & SPLIT CONTROLS */}
          <div className="flex items-center gap-1.5 text-[12px] font-mono text-[var(--text-muted)]">
            <Columns2 className="w-4 h-4 text-[var(--text-secondary)]" />
            <span className="@max-[2100px]:hidden">{t('shell.toolbar.splitLabel')}</span>
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
            onClick={() => workbenchStore.toggleDock()}
            style={{
              backgroundColor: workbench.dockOpen
                ? 'var(--bg-row-selected)'
                : 'var(--bg-panel)',
              borderColor: workbench.dockOpen
                ? 'var(--border-strong)'
                : 'var(--border-strong)',
              color: workbench.dockOpen ? 'var(--status-focus)' : 'var(--text-secondary)',
            }}
            className="h-[32px] px-2.5 border flex items-center gap-1.5 text-[12.5px] font-medium hover:text-[var(--text-primary)] cursor-pointer rounded-[3px]"
            title={t('shell.toolbar.explorerDockTooltip')}
          >
            <PanelRight className="w-4 h-4" />
            <span className="@max-[2100px]:hidden text-[12px] font-mono">{t('shell.toolbar.explorerDockLabel')}</span>
          </button>

          </div>

        </div>

        {/* Right Corner: overflow menu + fixed Panic / Emergency Stop Safety Switch (never hidden) */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Overflow "..." menu: visible only when tier 2 is collapsed (<1900px container) */}
          <div className="relative hidden @max-[1900px]:block" data-menubar-item>
            <button
              type="button"
              onClick={() => setOpenMenu(openMenu === 'overflow' ? null : 'overflow')}
              style={{
                backgroundColor: openMenu === 'overflow' ? 'var(--bg-row-selected)' : 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-secondary)',
              }}
              className="relative h-[32px] w-[34px] border flex items-center justify-center hover:text-[var(--text-primary)] cursor-pointer rounded-[3px]"
              title={t('shell.toolbar.moreTooltip')}
              aria-label={t('shell.toolbar.moreTooltip')}
              aria-haspopup="menu"
              aria-expanded={openMenu === 'overflow'}
            >
              <Ellipsis className="w-4 h-4" />
            </button>
            {openMenu === 'overflow' && (
              <div
                role="menu"
                style={{
                  backgroundColor: 'var(--bg-panel)',
                  borderColor: 'var(--border-strong)',
                }}
                className="absolute right-0 top-[38px] z-50 border shadow-2xl py-1.5 rounded-[3px] min-w-[260px] text-[12.5px]"
              >
                {/* Tier 3 items (inline again at >=1660px) */}
                <div className="@min-[1660px]:hidden">
                  {cloudOn && cloudHeader.isAuthenticated && (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={cloudHeader.syncingWorkspace}
                        onClick={() => {
                          setOpenMenu(null);
                          void handlePushActiveProject();
                        }}
                        className={OVERFLOW_ITEM_CLS}
                      >
                        <UploadCloud className="w-4 h-4 text-focus" />
                        <span>{t('shell.toolbar.pushBtn')}</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setOpenMenu(null);
                          void handleToggleLiveStream();
                        }}
                        className={OVERFLOW_ITEM_CLS}
                      >
                        {isStreaming ? (
                          <Square className="w-4 h-4 fill-current text-critical" />
                        ) : (
                          <Radio className="w-4 h-4 text-nominal" />
                        )}
                        <span>
                          {isStreaming ? t('shell.toolbar.stopLiveStream') : t('shell.toolbar.startLiveStream')}
                        </span>
                      </button>
                    </>
                  )}
                  <div className="px-3.5 py-1 text-[11px] font-mono text-[var(--text-muted)] uppercase flex items-center gap-1.5">
                    <Columns2 className="w-3.5 h-3.5" />
                    <span>{t('shell.menu.view.splitViewHeader')}</span>
                  </div>
                  <div className="px-3.5 pb-1.5">
                    <select
                      value={workbench.splitSecondaryTab ?? ''}
                      onChange={(e) => {
                        workbenchStore.setSplitSecondaryTab(
                          e.target.value ? (e.target.value as ActiveDocumentTab) : null,
                        );
                        setOpenMenu(null);
                      }}
                      style={{
                        backgroundColor: 'var(--bg-panel)',
                        borderColor: 'var(--border-strong)',
                        color: 'var(--text-primary)',
                      }}
                      className="w-full h-[30px] px-2 border text-[12px] font-mono cursor-pointer rounded-[3px] focus:outline-none"
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
                    role="menuitem"
                    onClick={() => {
                      setOpenMenu(null);
                      workbenchStore.toggleDock();
                    }}
                    className={OVERFLOW_ITEM_CLS}
                  >
                    <PanelRight className="w-4 h-4" />
                    <span>{workbench.dockOpen ? t('shell.menu.view.hideDock') : t('shell.menu.view.showDock')}</span>
                  </button>
                  <div className="my-1.5 border-t border-[var(--border-grid)]" />
                </div>

                {isTauri && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenMenu(null);
                      updateStore.openDialog(true);
                    }}
                    className={OVERFLOW_ITEM_CLS}
                  >
                    <RefreshCw className="w-4 h-4 text-focus" />
                    <span>{t('upd.menu.check')}</span>
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpenMenu(null);
                    updateStore.openChangelog();
                  }}
                  className={OVERFLOW_ITEM_CLS}
                >
                  <ScrollText className="w-4 h-4 text-secondary" />
                  <span>{t('upd.menu.changelog')}</span>
                </button>
              </div>
            )}
          </div>
          <TxModeControl />
          <button
            type="button"
            data-tour="topbar.panic"
            onClick={() => void onPanicStop()}
            style={
              isUrgentStop
                ? undefined
                : {
                    backgroundColor: 'var(--status-critical-bg)',
                    borderColor: 'var(--status-critical-border)',
                    color: dbState.theme === 'dark' ? 'var(--status-critical)' : 'var(--status-critical)',
                  }
            }
            className={`h-[32px] px-3.5 border flex items-center gap-1.5 text-[12.5px] font-bold cursor-pointer rounded-[3px] ${
              isUrgentStop
                ? 'bg-critical hover:bg-critical/85 text-on-accent border-critical'
                : 'hover:border-critical'
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
