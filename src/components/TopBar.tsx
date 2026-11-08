import React, { useState } from 'react';
import {
  Building2,
  Database,
  FilePlus2,
  FolderKanban,
  FolderX,
  Moon,
  OctagonAlert,
  PlugZap,
  Plus,
  Radio,
  RotateCcw,
  Save,
  Square,
  Sun,
  UploadCloud,
} from 'lucide-react';
import { apiDisconnectAllBuses } from '../services/ipcClient';
import { cloudBridgeStore, useCloudBridgeHeader } from '../store/cloudBridgeStore';
import { useConnectionStore } from '../store/connectionStore';
import { databaseStore, useDatabaseStore, type ActiveDocumentTab } from '../store/databaseStore';
import { usePlotStore } from '../store/plotStore';
import {
  type QuickBarConnectionState,
  projectStore,
  useProjectStore,
} from '../store/projectStore';
import { telemetryStore, useTelemetryHeader } from '../store/telemetryStore';
import { transmitStore } from '../store/transmitStore';
import type { DeviceDescriptorDto } from '../types/hal';
import { BusStateBadge } from './BusStateBadge';
import { NewConnectionModal } from './NewConnectionModal';

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

interface TopBarProps {
  devices: readonly DeviceDescriptorDto[];
  onQuickSaveProject: () => Promise<void>;
  onPanicStop: () => Promise<void>;
  onClearWorkspace: () => Promise<void>;
  onStatusMessage: (msg: StatusBanner) => void;
  onApplyQuickBar?: (qb: QuickBarConnectionState) => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  devices,
  onQuickSaveProject,
  onPanicStop,
  onClearWorkspace,
  onStatusMessage,
  onApplyQuickBar,
}) => {
  const header = useTelemetryHeader();
  const dbState = useDatabaseStore();
  const plotState = usePlotStore();
  const projState = useProjectStore();
  const connState = useConnectionStore();
  const cloudHeader = useCloudBridgeHeader();

  const [busyDisconnectAll, setBusyDisconnectAll] = useState<boolean>(false);
  const [newConnModalOpen, setNewConnModalOpen] = useState<boolean>(false);

  const connectedBuses = header.buses.filter((b) => b.connected);
  const connectedBusCount = connectedBuses.length;
  const anyTxArmed = header.buses.some((b) => b.connected && b.txArmed);
  const isUrgentStop = anyTxArmed || header.txPanicLatched;

  const handleDisconnectAll = async (): Promise<void> => {
    setBusyDisconnectAll(true);
    try {
      const count = await apiDisconnectAllBuses();
      telemetryStore.clearAllBuses();
      transmitStore.markAllPaused();
      onStatusMessage({
        kind: 'info',
        message: `Disconnected ${count} active CAN bus channel(s).`,
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: `Disconnect all error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyDisconnectAll(false);
    }
  };

  const handleCloseProject = async (): Promise<void> => {
    const closedName = projState.currentName;
    await projectStore.closeCurrentProject(onApplyQuickBar);
    onStatusMessage({
      kind: 'info',
      message: `Closed project "${closedName}". Returned to Start Page.`,
    });
  };

  const cloudTabLabel =
    cloudHeader.cloudCapturing
      ? 'Cloud (REC)'
      : cloudHeader.status === 'streaming'
        ? 'Cloud (LIVE)'
        : cloudHeader.remoteUpdateAvailableRev !== null
          ? `Cloud (↓#${cloudHeader.remoteUpdateAvailableRev})`
          : 'Cloud';

  const docTabs: readonly {
    id: ActiveDocumentTab;
    label: string;
  }[] = [
    { id: 'start', label: 'Start Page' },
    { id: 'rxtx', label: 'Receive / Transmit' },
    {
      id: 'connections',
      label:
        connectedBusCount > 0
          ? `Connections (${connectedBusCount})`
          : 'Connections',
    },
    {
      id: 'plotter',
      label:
        plotState.series.length > 0
          ? `Plotter (${plotState.series.length})`
          : 'Plotter',
    },
    { id: 'trace', label: 'Trace' },
    {
      id: 'symbols',
      label: dbState.databases.length > 0 ? `Databases (${dbState.databases.length})` : 'Databases',
    },
    { id: 'cloud', label: cloudTabLabel },
  ];

  return (
    <header className="shrink-0 select-none text-[12px]">
      {/* ==================================================================== */}
      {/* ROW 1 (34px): 5 BALANCED ENGINEERING INSTRUMENT MODULES              */}
      {/* ==================================================================== */}
      <div
        style={{
          backgroundColor: 'var(--bg-toolbar)',
          borderBottom: '1px solid var(--border-grid)',
        }}
        className="h-[34px] px-2 flex items-center justify-between gap-2"
      >
        <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto no-scrollbar">
          {/* MODULE 1: BRAND & PROJECT */}
          <div className="flex items-center gap-1.5 pr-1.5 border-r border-[var(--border-strong)] shrink-0">
            <span
              className={`w-2 h-2 rounded-full ${
                connectedBusCount > 0
                  ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]'
                  : header.transportConnected
                    ? 'bg-[var(--text-muted)]'
                    : 'bg-amber-500'
              }`}
              title={
                connectedBusCount > 0
                  ? `${connectedBusCount} Bus(es) Online`
                  : header.transportConnected
                    ? 'Ready (No Active Bus)'
                    : 'Connecting to Backend...'
              }
            />
            <img
              src="/logo.png"
              alt="NexusCAN Logo"
              className="w-[18px] h-[18px] rounded-[3px] border border-[#0E7490]/60 shrink-0"
              width={18}
              height={18}
            />
            <span className="font-semibold tracking-tight text-[var(--text-primary)]">
              NexusCAN
            </span>
          </div>

          <button
            type="button"
            onClick={() => projectStore.setModalOpen(true)}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[23px] px-2 border flex items-center gap-1.5 text-[11px] hover:border-[var(--text-secondary)] cursor-pointer shrink-0 max-w-[170px]"
            title="Project Manager (.nexusproj.json)"
          >
            <FolderKanban className="w-3 h-3 text-[var(--text-secondary)] shrink-0" />
            <span className="truncate font-medium">{projState.currentName}</span>
          </button>

          <button
            type="button"
            onClick={() => projectStore.setModalOpen(true)}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[23px] px-1.5 border flex items-center gap-1 text-[11px] hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)] cursor-pointer shrink-0"
            title="New Project Manager"
          >
            <FilePlus2 className="w-3 h-3" />
            <span>New</span>
          </button>

          <button
            type="button"
            onClick={() => void onQuickSaveProject()}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[23px] w-[23px] border flex items-center justify-center hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)] cursor-pointer shrink-0"
            title="Save Project (Ctrl+S)"
          >
            <Save className="w-3 h-3" />
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
              className="h-[23px] px-1.5 border flex items-center gap-1 text-[11px] hover:text-red-400 hover:border-red-500/50 cursor-pointer shrink-0"
              title="Close Project & Return to Start Page"
            >
              <FolderX className="w-3 h-3 text-red-400" />
              <span>Close</span>
            </button>
          )}

          {/* CLOUD & LIVE BRIDGE STATUS / CONTROLS */}
          {!cloudHeader.isAuthenticated ? (
            <button
              type="button"
              onClick={() => databaseStore.setActiveDocTab('cloud')}
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-muted)',
              }}
              className="h-[23px] px-2 border flex items-center gap-1.5 text-[11px] hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)] cursor-pointer shrink-0"
              title="NexusCANCloud oturumu kapalı. Giriş yapmak için tıklayın."
            >
              <span className="w-1.5 h-1.5 rounded-full bg-slate-500 shrink-0" />
              <span>Cloud: Çevrimdışı</span>
            </button>
          ) : (
            <div className="flex items-center gap-1 shrink-0">
              {/* User Organization Membership Indicator / Selector */}
              {cloudHeader.organizations.length > 1 ? (
                <div
                  className="h-[23px] px-1.5 border flex items-center gap-1 text-[11px] font-mono tabular-nums shrink-0"
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-secondary)',
                  }}
                  title={`Aktif Organizasyon: ${cloudHeader.selectedOrgName || 'Bilinmiyor'} (${cloudHeader.selectedOrgRole || 'üye'}) · Değiştirmek için seçin`}
                >
                  <Building2 className="w-3 h-3 text-sky-400 shrink-0" />
                  <select
                    value={cloudHeader.selectedOrgId ?? ''}
                    onChange={(e) => {
                      cloudBridgeStore.selectOrganization(e.target.value);
                    }}
                    style={{
                      backgroundColor: 'transparent',
                      color: 'var(--text-primary)',
                    }}
                    className="bg-transparent border-0 outline-none text-[11px] font-mono cursor-pointer py-0 pr-1 max-w-[130px] truncate"
                    title="Organizasyon Değiştir"
                  >
                    {cloudHeader.organizations.map((org) => (
                      <option key={org.id} value={org.id} className="bg-slate-900 text-slate-100">
                        {org.name} ({org.myRole})
                      </option>
                    ))}
                  </select>
                </div>
              ) : cloudHeader.organizations.length === 1 ? (
                <div
                  className="h-[23px] px-1.5 border flex items-center gap-1 text-[11px] font-mono tabular-nums shrink-0"
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-secondary)',
                  }}
                  title={`Kullanıcı Organizasyonu: ${cloudHeader.selectedOrgName} (${cloudHeader.selectedOrgRole ?? 'üye'})`}
                >
                  <Building2 className="w-3 h-3 text-sky-400 shrink-0" />
                  <span className="truncate max-w-[120px] text-[var(--text-primary)]">
                    {cloudHeader.selectedOrgName}
                  </span>
                  {cloudHeader.selectedOrgRole && (
                    <span className="text-[10px] text-[var(--text-muted)] font-mono">
                      [{cloudHeader.selectedOrgRole}]
                    </span>
                  )}
                </div>
              ) : (
                <div
                  className="h-[23px] px-1.5 border flex items-center gap-1 text-[11px] font-mono tabular-nums shrink-0 text-[var(--text-muted)]"
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                  }}
                  title="Organizasyonlar yükleniyor..."
                >
                  <Building2 className="w-3 h-3 text-slate-500 shrink-0" />
                  <span>Org: Yükleniyor…</span>
                </div>
              )}

              {/* Live Streaming State */}
              {cloudHeader.status === 'streaming' ||
              cloudHeader.status === 'connecting_ws' ||
              cloudHeader.status === 'authenticating' ? (
                <>
                  <button
                    type="button"
                    onClick={() => databaseStore.setActiveDocTab('cloud')}
                    style={{
                      backgroundColor: 'rgba(16, 185, 129, 0.15)',
                      borderColor: '#10B981',
                      color: '#34D399',
                    }}
                    className="h-[23px] px-2 border flex items-center gap-1.5 text-[11px] font-mono tabular-nums font-semibold hover:opacity-90 cursor-pointer shrink-0"
                    title={`Canlı Telemetri Yayını Aktif: ${cloudHeader.selectedProjectName || 'Cloud'} · ${cloudHeader.targetHz}Hz. Cloud sekmesine git.`}
                  >
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
                    <span>
                      LIVE · {cloudHeader.selectedProjectName ?? 'Cloud'} ({cloudHeader.targetHz}Hz)
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      cloudBridgeStore.stopLiveStream();
                      onStatusMessage({
                        kind: 'info',
                        message: 'Canlı telemetri yayını durduruldu.',
                      });
                    }}
                    style={{
                      backgroundColor: 'rgba(239, 68, 68, 0.12)',
                      borderColor: 'rgba(239, 68, 68, 0.45)',
                      color: '#F87171',
                    }}
                    className="h-[23px] px-1.5 border flex items-center gap-1 text-[11px] font-medium hover:opacity-90 cursor-pointer shrink-0"
                    title="Canlı telemetri yayınını durdur"
                  >
                    <Square className="w-2.5 h-2.5 fill-current" />
                    <span>Yayını Kapat</span>
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => databaseStore.setActiveDocTab('cloud')}
                    style={{
                      backgroundColor: 'rgba(56, 189, 248, 0.12)',
                      borderColor: 'rgba(56, 189, 248, 0.45)',
                      color: '#38BDF8',
                    }}
                    className="h-[23px] px-2 border flex items-center gap-1.5 text-[11px] font-mono tabular-nums hover:opacity-90 cursor-pointer shrink-0"
                    title="NexusCANCloud Oturumu Aktif. Cloud sekmesine git."
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0" />
                    <span>
                      {projState.cloudBinding
                        ? `Cloud · ${projState.cloudBinding.projectCode}`
                        : 'Cloud Bağlı'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
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
                          message:
                            'Canlı yayın başlatmak için önce bir Cloud projesi seçmelisiniz.',
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
                          message: `Canlı telemetri yayını başlatıldı (${targetProjId}).`,
                        });
                      } catch (err) {
                        onStatusMessage({
                          kind: 'error',
                          message: `Canlı yayın başlatılamadı: ${
                            err instanceof Error ? err.message : String(err)
                          }`,
                        });
                      }
                    }}
                    style={{
                      backgroundColor: 'rgba(16, 185, 129, 0.12)',
                      borderColor: 'rgba(16, 185, 129, 0.5)',
                      color: '#34D399',
                    }}
                    className="h-[23px] px-1.5 border flex items-center gap-1 text-[11px] font-medium hover:opacity-90 cursor-pointer shrink-0"
                    title="Canlı telemetri yayınını başlat (Live Bridge)"
                  >
                    <Radio className="w-3 h-3 text-emerald-400" />
                    <span>Canlı Yayın Başlat</span>
                  </button>
                </>
              )}

              {/* Local Project Cloud Push Button */}
              {projState.hasActiveWorkspace &&
                (projState.cloudBinding ? (
                  <button
                    type="button"
                    disabled={cloudHeader.syncingWorkspace}
                    onClick={async () => {
                      try {
                        const res = await cloudBridgeStore.pushActiveLocalProjectToCloud({
                          mode: 'bound',
                        });
                        onStatusMessage({
                          kind: 'success',
                          message: `"${res.project.name}" Cloud'a pushlandı ([${res.project.code}] Rev #${res.revisionNumber}).`,
                        });
                      } catch (err) {
                        onStatusMessage({
                          kind: 'error',
                          message: `Cloud push hatası: ${
                            err instanceof Error ? err.message : String(err)
                          }`,
                        });
                      }
                    }}
                    style={{
                      backgroundColor: 'var(--bg-panel)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-secondary)',
                    }}
                    className="h-[23px] px-2 border flex items-center gap-1 text-[11px] hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)] cursor-pointer shrink-0 font-medium disabled:opacity-50"
                    title={`Yerel projeyi bağlı Cloud projesine pushla ([${projState.cloudBinding.projectCode}])`}
                  >
                    <UploadCloud className="w-3 h-3 text-sky-400" />
                    <span>{cloudHeader.syncingWorkspace ? 'Pushing...' : 'Push'}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      cloudBridgeStore.openPushPrompt({
                        reason: 'manual',
                        projectName: projState.currentName,
                      })
                    }
                    style={{
                      backgroundColor: 'rgba(217, 119, 6, 0.12)',
                      borderColor: 'rgba(217, 119, 6, 0.5)',
                      color: '#FBBF24',
                    }}
                    className="h-[23px] px-2 border flex items-center gap-1 text-[11px] font-medium hover:opacity-90 cursor-pointer shrink-0"
                    title="Bu proje henüz Cloud ile eşleştirilmedi. Cloud'a pushlamak için tıklayın."
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                    <span>Yerel · Cloud'a Pushla…</span>
                  </button>
                ))}
            </div>
          )}

          <div className="h-4 w-[1px] bg-[var(--border-strong)] mx-0.5 shrink-0" />

          {/* MODULE 2: CONNECTION SETUP MODULE (DEDICATED SECTION) */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setNewConnModalOpen(true)}
              style={{
                backgroundColor: 'rgba(63, 185, 128, 0.12)',
                borderColor: 'rgba(63, 185, 128, 0.55)',
                color: 'var(--text-primary)',
              }}
              className="h-[23px] px-2.5 border flex items-center gap-1.5 text-[11px] font-semibold hover:opacity-90 cursor-pointer shrink-0"
              title="Add New CAN / CAN-FD Connection (Bus 1..8)"
            >
              <Plus className="w-3 h-3 text-emerald-500" />
              <span>+ New Connection...</span>
            </button>

            {connectedBusCount > 0 && (
              <button
                type="button"
                disabled={busyDisconnectAll}
                onClick={() => void handleDisconnectAll()}
                style={{
                  backgroundColor: 'var(--bg-panel)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-secondary)',
                }}
                className="h-[23px] px-2 border flex items-center gap-1 text-[11px] hover:text-red-400 hover:border-red-500/40 cursor-pointer shrink-0"
                title="Disconnect all online CAN buses"
              >
                <PlugZap className="w-3 h-3" />
                <span>Disconnect All</span>
              </button>
            )}
          </div>

          <div className="h-4 w-[1px] bg-[var(--border-strong)] mx-0.5 shrink-0" />

          {/* MODULE 3: DATABASE CATALOG (no global "active" database) */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => databaseStore.setActiveDocTab('symbols')}
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              className="h-[23px] px-2 border flex items-center gap-1.5 text-[11px] hover:border-[var(--text-secondary)] cursor-pointer shrink-0"
              title={`${dbState.databases.length} database(s) in catalog · ${dbState.busSchemas.size} bus(es) with bound databases`}
            >
              <Database className="w-3 h-3 text-[var(--text-secondary)]" />
              <span>Databases</span>
              <span className="font-mono tabular-nums text-[var(--text-muted)]">
                {dbState.databases.length} · {dbState.busSchemas.size} hat
              </span>
            </button>
          </div>

          <div className="h-4 w-[1px] bg-[var(--border-strong)] mx-0.5 shrink-0" />

          {/* MODULE 4: LIVE CAN BUS STATES & TELEMETRY STRIP */}
          <div className="flex items-center gap-1.5 shrink-0 font-mono tabular-nums text-[11px]">
            {connectedBuses.length === 0 ? (
              <span className="text-[var(--text-muted)] text-[11px] font-sans">
                All Buses Offline ({connState.profiles.length} configured)
              </span>
            ) : (
              connectedBuses.map((bus) => (
                <div
                  key={bus.busId}
                  className="flex items-center gap-1 bg-[var(--bg-panel)] px-1.5 py-0.5 border border-[var(--border-grid)]"
                  title={`${bus.channelName}: ${bus.busState} | Mode: ${bus.listenOnly ? 'Listen-Only' : bus.txArmed ? 'Active TX Armed' : 'TX Disarmed'} | TEC: ${bus.txErrorCount} | REC: ${bus.rxErrorCount}`}
                >
                  <span className="font-semibold text-[var(--text-secondary)]">B{bus.busId + 1}:</span>
                  <BusStateBadge
                    busState={bus.busState}
                    connected={bus.connected}
                    listenOnly={bus.listenOnly}
                    txArmed={bus.txArmed}
                    txErrorCount={bus.txErrorCount}
                    rxErrorCount={bus.rxErrorCount}
                    compact
                  />
                </div>
              ))
            )}
          </div>
        </div>

        {/* MODULE 5: WORKSPACE & SAFETY MODULE (RIGHT) */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => void onClearWorkspace()}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[23px] px-2 border flex items-center gap-1 text-[11px] hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)] cursor-pointer"
            title="Clear Receive list, Trace buffer & TX counters (Esc)"
          >
            <RotateCcw className="w-3 h-3 text-[var(--text-secondary)]" />
            <span className="hidden sm:inline">Clear (Esc)</span>
          </button>

          <button
            type="button"
            onClick={() => databaseStore.toggleTheme()}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[23px] w-[23px] border flex items-center justify-center hover:text-[var(--text-primary)] cursor-pointer"
            title={
              dbState.theme === 'dark'
                ? 'Switch to Light Instrument Theme'
                : 'Switch to Dark Instrument Theme'
            }
          >
            {dbState.theme === 'dark' ? (
              <Sun className="w-3.5 h-3.5" />
            ) : (
              <Moon className="w-3.5 h-3.5" />
            )}
          </button>

          <button
            type="button"
            onClick={() => void onPanicStop()}
            style={
              isUrgentStop
                ? undefined
                : {
                    backgroundColor: 'rgba(185, 28, 28, 0.10)',
                    borderColor: 'rgba(185, 28, 28, 0.42)',
                    color: dbState.theme === 'dark' ? '#E57373' : '#B91C1C',
                  }
            }
            className={`h-[23px] px-2.5 border flex items-center gap-1 text-[11px] font-semibold cursor-pointer ${
              isUrgentStop
                ? 'bg-red-700 hover:bg-red-600 text-white border-red-500 font-bold'
                : 'hover:border-red-500'
            }`}
            title="Emergency Stop All TX & Disarm Active Buses (Ctrl+Shift+Space)"
          >
            <OctagonAlert className="w-3 h-3" />
            <span>{header.txPanicLatched ? 'PANIC LATCHED' : 'Stop All TX'}</span>
          </button>
        </div>
      </div>

      {/* ==================================================================== */}
      {/* ROW 2 (26px): 6-TAB ENGINEERING DOCUMENT BAR                          */}
      {/* ==================================================================== */}
      <nav
        style={{
          backgroundColor: 'var(--bg-header)',
          borderBottom: '1px solid var(--border-strong)',
        }}
        className="h-[26px] px-2 flex items-end justify-between"
      >
        <div className="flex items-end h-full pt-1 gap-0.5 overflow-x-auto no-scrollbar">
          {docTabs.map((tab) => {
            const isActive =
              dbState.activeDocTab === tab.id ||
              (tab.id === 'cloud' && dbState.activeDocTab === 'panels');
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => databaseStore.setActiveDocTab(tab.id)}
                style={{
                  backgroundColor: isActive ? 'var(--bg-panel)' : 'transparent',
                  borderColor: isActive ? 'var(--border-strong)' : 'transparent',
                  color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                  borderBottomColor: isActive ? 'var(--bg-panel)' : 'transparent',
                }}
                className={`h-full px-3 text-[11px] font-mono tabular-nums border-t border-l border-r cursor-pointer shrink-0 ${
                  isActive
                    ? 'font-sans font-semibold'
                    : 'font-sans hover:text-[var(--text-primary)]'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {connectedBusCount > 0 && (
          <div className="hidden md:flex items-center pb-1 text-[11px] font-mono tabular-nums text-[var(--text-secondary)] shrink-0">
            <div className="inline-flex items-center justify-between w-[92px] px-2">
              <span className="text-[var(--text-muted)]">Rx</span>
              <span className="text-right text-[var(--text-primary)]">
                {Math.round(header.fpsRx).toLocaleString('en-US')}/s
              </span>
            </div>
            <div className="inline-flex items-center justify-between w-[92px] px-2 border-l border-[var(--border-grid)]">
              <span className="text-[var(--text-muted)]">Tx</span>
              <span className="text-right text-[var(--text-primary)]">
                {Math.round(header.fpsTx).toLocaleString('en-US')}/s
              </span>
            </div>
            <div className="inline-flex items-center justify-between w-[86px] pl-2 border-l border-[var(--border-grid)]">
              <span className="text-[var(--text-muted)]">Load</span>
              <span className="text-right text-[var(--text-primary)]">
                {header.estimatedBusLoadPct.toFixed(1)}%
              </span>
            </div>
          </div>
        )}
      </nav>

      {newConnModalOpen && (
        <NewConnectionModal
          devices={devices}
          onClose={() => setNewConnModalOpen(false)}
          onStatusMessage={onStatusMessage}
        />
      )}
    </header>
  );
};
