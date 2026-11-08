import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Building2,
  Clock,
  Cloud,
  Cpu,
  Database,
  FilePlus2,
  FolderOpen,
  LineChart,
  Radio,
  Sliders,
  Trash2,
  Zap,
} from 'lucide-react';
import { databaseStore } from '../store/databaseStore';
import {
  type NexusProjectFileV1,
  type QuickBarConnectionState,
  projectStore,
  readCachedLastActiveProject,
  useProjectStore,
} from '../store/projectStore';
import {
  cloudBridgeStore,
  suggestCloudProjectCode,
  useCloudBridgeStore,
} from '../store/cloudBridgeStore';
import type { DeviceDescriptorDto } from '../types/hal';
import { StartHeroShowcase } from './StartHeroShowcase';
import type { StatusBanner } from './TopBar';

interface StartPageViewProps {
  devices: readonly DeviceDescriptorDto[];
  onRefreshDevices: () => Promise<void>;
  onStatusMessage: (msg: StatusBanner) => void;
  quickBarState: QuickBarConnectionState;
  onApplyQuickBar: (qb: QuickBarConnectionState) => void;
}

interface FeatureCard {
  title: string;
  badge: 'Active' | 'Upcoming';
  description: string;
  icon: React.ReactNode;
}

const CAPABILITIES: readonly FeatureCard[] = [
  {
    title: 'Multi-Bus CAN & CAN-FD',
    badge: 'Active',
    description: 'Hardware abstraction for SocketCAN, SLCAN, PCAN, Kvaser, gs_usb and virtual mock buses.',
    icon: <Cpu className="w-4 h-4 text-emerald-400" />,
  },
  {
    title: 'Symbolic .dbc & .kcd Matrix',
    badge: 'Active',
    description: 'Zero-copy codec for Intel/Motorola bit sawtooth, cascaded multiplexers and J1939 SPNs.',
    icon: <Database className="w-4 h-4 text-emerald-400" />,
  },
  {
    title: '60 FPS Oscilloscope & Trace',
    badge: 'Active',
    description: 'High-frequency signal plotting, dual cursors, multi-Y scaling and 100k chronological buffer.',
    icon: <LineChart className="w-4 h-4 text-emerald-400" />,
  },
  {
    title: 'Black-Box Logger & Replay',
    badge: 'Upcoming',
    description: 'Time-accurate hardware playback and recording for Vector .blf, .asc and ASAM .mf4 files.',
    icon: <Clock className="w-4 h-4 text-sky-400" />,
  },
  {
    title: 'Diagnostics: UDS & J1939',
    badge: 'Upcoming',
    description: 'ISO-TP multi-frame transport, UDS DID read/write, DTC fault viewer and SAE J1939 BAM decoder.',
    icon: <Activity className="w-4 h-4 text-amber-400" />,
  },
  {
    title: 'Node Simulation & Scripting',
    badge: 'Upcoming',
    description: 'Automated test sequences, restbus simulation, CAPL/Python bridge and virtual ECU emulation.',
    icon: <Sliders className="w-4 h-4 text-purple-400" />,
  },
];

export const StartPageView: React.FC<StartPageViewProps> = ({
  onStatusMessage,
  onApplyQuickBar,
  quickBarState,
}) => {
  const projState = useProjectStore();
  const cloudState = useCloudBridgeStore();

  const [cachedRecent, setCachedRecent] = useState<NexusProjectFileV1 | null>(null);
  const [newProjectName, setNewProjectName] = useState<string>('Vehicle Bench 01');
  const [newProjectCode, setNewProjectCode] = useState<string>('VEH-BENCH-01');
  const [newProjectProtocol, setNewProjectProtocol] = useState<'CAN' | 'CAN_FD' | 'J1939'>('CAN_FD');
  const [newProjectOrgId, setNewProjectOrgId] = useState<string>('');
  const [codeEdited, setCodeEdited] = useState<boolean>(false);
  const [pushToCloudChoice, setPushToCloudChoice] = useState<boolean>(false);
  const [showNewInput, setShowNewInput] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void projectStore.refreshSavedProjects();
    const cached = readCachedLastActiveProject();
    setCachedRecent(cached);
  }, []);

  useEffect(() => {
    if (!newProjectOrgId && (cloudState.selectedOrgId || cloudState.organizations[0]?.id)) {
      setNewProjectOrgId(cloudState.selectedOrgId || cloudState.organizations[0]?.id || '');
    }
  }, [cloudState.selectedOrgId, cloudState.organizations, newProjectOrgId]);

  const activeOrg =
    cloudState.organizations.find(
      (o) => o.id === (cloudState.selectedOrgId || newProjectOrgId),
    ) ||
    cloudState.organizations[0] ||
    null;

  const handleNameChange = (val: string): void => {
    setNewProjectName(val);
    if (!codeEdited) {
      setNewProjectCode(suggestCloudProjectCode(val));
    }
  };

  const handleCreateNewProject = async (name: string): Promise<void> => {
    setBusy(true);
    try {
      await projectStore.createNewCleanProject(name, onApplyQuickBar);
      databaseStore.setActiveDocTab('rxtx');

      if (Boolean(cloudState.sessionToken) && pushToCloudChoice) {
        try {
          const res = await cloudBridgeStore.pushActiveLocalProjectToCloud({
            mode: 'create_new',
            quickBarState,
            orgId: newProjectOrgId || undefined,
            projectName: name,
            projectCode: newProjectCode.trim().toUpperCase(),
            defaultProtocol: newProjectProtocol,
          });
          onStatusMessage({
            kind: 'success',
            message: `"${name}" yerel projesi oluşturuldu ve NexusCANCloud'a pushlandı ([${res.project.code}] Rev #${res.revisionNumber}).`,
          });
          return;
        } catch (cloudErr) {
          onStatusMessage({
            kind: 'error',
            message: `"${name}" yerel oluşturuldu fakat Cloud'a pushlanamadı: ${
              cloudErr instanceof Error ? cloudErr.message : String(cloudErr)
            }`,
          });
          return;
        }
      }

      onStatusMessage({
        kind: 'success',
        message: `Created clean project "${name}". Connect an interface below to begin.`,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleResumeRecent = async (): Promise<void> => {
    if (!cachedRecent) return;
    setBusy(true);
    try {
      const res = await projectStore.restoreProject(cachedRecent, onApplyQuickBar);
      databaseStore.setActiveDocTab('rxtx');
      onStatusMessage({
        kind: 'success',
        message: `Resumed "${cachedRecent.name}" (${res.reconnectedCount} bus(es) online).`,
      });

      const cloud = cloudBridgeStore.getState();
      if (Boolean(cloud.sessionToken) && !cachedRecent.cloudBinding?.projectId) {
        cloudBridgeStore.openPushPrompt({
          reason: 'opened_project',
          projectName: cachedRecent.name,
        });
      }
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleImportFile = async (
    ev: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;

    setBusy(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as NexusProjectFileV1;
      if (!parsed || parsed.version !== 1) {
        throw new Error('Invalid .nexusproj.json project file.');
      }
      const res = await projectStore.restoreProject(parsed, onApplyQuickBar);
      databaseStore.setActiveDocTab('rxtx');
      onStatusMessage({
        kind: 'success',
        message: `Opened "${parsed.name}" (${res.reconnectedCount} bus(es) connected).`,
      });

      const cloud = cloudBridgeStore.getState();
      if (Boolean(cloud.sessionToken) && !parsed.cloudBinding?.projectId) {
        cloudBridgeStore.openPushPrompt({
          reason: 'opened_project',
          projectName: parsed.name,
        });
      }
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: `Open project failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleOpenSaved = async (fileStem: string): Promise<void> => {
    setBusy(true);
    try {
      const loaded = await projectStore.loadServerProjectByStem(fileStem, onApplyQuickBar);
      databaseStore.setActiveDocTab('rxtx');
      onStatusMessage({
        kind: 'success',
        message: `Opened "${loaded.name}".`,
      });

      const cloud = cloudBridgeStore.getState();
      if (Boolean(cloud.sessionToken) && !loaded.cloudBinding?.projectId) {
        cloudBridgeStore.openPushPrompt({
          reason: 'opened_project',
          projectName: loaded.name,
        });
      }
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: `Open failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteSaved = async (fileStem: string): Promise<void> => {
    try {
      await projectStore.deleteServerProjectByStem(fileStem);
      onStatusMessage({
        kind: 'info',
        message: `Removed saved project "${fileStem}".`,
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  return (
    <div
      style={{ backgroundColor: 'var(--bg-app)' }}
      className="flex flex-1 min-h-0 overflow-y-auto select-none p-6"
    >
      <div className="w-full max-w-[940px] mx-auto flex flex-col gap-6 my-auto">
        {/* ================================================================ */}
        {/* 1. CINEMATIC INDUSTRIAL HERO SHOWCASE (4 LIVE CONCEPTS)          */}
        {/* ================================================================ */}
        <StartHeroShowcase />

        {/* ================================================================ */}
        {/* 2. MAIN 2-COLUMN START WORKSPACE & RECENT PROJECTS               */}
        {/* ================================================================ */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* LEFT: Quick Start Actions */}
          <div
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
            }}
            className="p-4 border flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Zap className="w-4 h-4 text-emerald-400" />
                <h2 className="text-[13px] font-bold text-[var(--text-primary)]">
                  Start Workspace
                </h2>
              </div>

              <div className="space-y-2.5">
                {/* New Project Button / Inline Name Input */}
                {!showNewInput ? (
                  <button
                    type="button"
                    onClick={() => setShowNewInput(true)}
                    style={{
                      backgroundColor: 'rgba(63, 185, 128, 0.12)',
                      borderColor: 'rgba(63, 185, 128, 0.55)',
                      color: 'var(--text-primary)',
                    }}
                    className="w-full h-[36px] px-3.5 border flex items-center justify-between font-semibold text-[12px] hover:opacity-90 cursor-pointer rounded-sm"
                  >
                    <div className="flex items-center gap-2">
                      <FilePlus2 className="w-4 h-4 text-emerald-400" />
                      <span>New Project...</span>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-emerald-400" />
                  </button>
                ) : (
                  <div
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                    }}
                    className="p-2.5 border space-y-2 rounded-sm"
                  >
                    {/* Cloud connection strip when authenticated */}
                    {Boolean(cloudState.sessionToken) && (
                      <div className="flex items-center justify-between px-2 py-1 bg-emerald-950/40 border border-emerald-800/50 rounded-sm text-[11px] font-mono tabular-nums text-emerald-300">
                        <div className="flex items-center gap-1.5 truncate">
                          <Cloud className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                          <span className="truncate">
                            NexusCANCloud Bağlı · {cloudState.userEmail || cloudState.cloudBaseUrl}
                          </span>
                        </div>
                        {activeOrg && (
                          <div className="flex items-center gap-1 text-[10px] text-emerald-200/90 font-mono shrink-0 ml-2">
                            <Building2 className="w-2.5 h-2.5 text-emerald-400 shrink-0" />
                            <span>{activeOrg.name}</span>
                            <span className="text-emerald-400/70">[{activeOrg.myRole}]</span>
                          </div>
                        )}
                      </div>
                    )}

                    <div>
                      <label className="block text-[11px] text-[var(--text-secondary)] font-medium mb-0.5">
                        Project Name:
                      </label>
                      <input
                        type="text"
                        autoFocus
                        value={newProjectName}
                        onChange={(e) => handleNameChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            void handleCreateNewProject(newProjectName);
                          } else if (e.key === 'Escape') {
                            setShowNewInput(false);
                          }
                        }}
                        style={{
                          backgroundColor: 'var(--bg-panel)',
                          borderColor: 'var(--border-strong)',
                          color: 'var(--text-primary)',
                        }}
                        className="w-full h-[26px] px-2 border text-[12px] font-sans focus:outline-none focus:border-emerald-500"
                      />
                    </div>

                    {/* Segmented Choice for Cloud Push when logged in */}
                    {Boolean(cloudState.sessionToken) && (
                      <div className="space-y-1.5 pt-0.5">
                        <div className="flex border border-slate-800 rounded bg-[#0B0F17] p-0.5 text-[11px]">
                          <button
                            type="button"
                            onClick={() => setPushToCloudChoice(false)}
                            className={`flex-1 h-[22px] rounded-sm font-medium cursor-pointer transition-colors ${
                              !pushToCloudChoice
                                ? 'bg-slate-700 text-white font-semibold shadow-sm'
                                : 'text-slate-400 hover:text-white'
                            }`}
                          >
                            Sadece Yerel
                          </button>
                          <button
                            type="button"
                            onClick={() => setPushToCloudChoice(true)}
                            className={`flex-1 h-[22px] rounded-sm font-medium cursor-pointer transition-colors ${
                              pushToCloudChoice
                                ? 'bg-sky-600 text-white font-semibold shadow-sm'
                                : 'text-slate-400 hover:text-white'
                            }`}
                          >
                            Cloud'a Pushla
                          </button>
                        </div>

                        {pushToCloudChoice && (
                          <div className="space-y-1.5 p-2 bg-[#0B0F17] border border-slate-800 rounded-sm">
                            {cloudState.organizations.length > 1 ? (
                              <div>
                                <label className="block text-[10px] text-slate-400 mb-0.5">
                                  Organizasyon:
                                </label>
                                <select
                                  value={newProjectOrgId}
                                  onChange={(e) => {
                                    setNewProjectOrgId(e.target.value);
                                    cloudBridgeStore.selectOrganization(e.target.value);
                                  }}
                                  className="w-full h-[22px] px-1.5 border border-slate-700 bg-slate-900 text-slate-100 text-[11px]"
                                >
                                  {cloudState.organizations.map((org) => (
                                    <option key={org.id} value={org.id}>
                                      {org.name} ({org.myRole})
                                    </option>
                                  ))}
                                </select>
                              </div>
                            ) : cloudState.organizations.length === 1 ? (
                              <div>
                                <label className="block text-[10px] text-slate-400 mb-0.5">
                                  Organizasyon:
                                </label>
                                <div className="w-full h-[22px] px-1.5 border border-slate-700 bg-slate-900 text-slate-200 text-[11px] font-mono flex items-center justify-between">
                                  <span>{cloudState.organizations[0].name}</span>
                                  <span className="text-sky-400 text-[10px]">
                                    [@{cloudState.organizations[0].slug} · {cloudState.organizations[0].myRole}]
                                  </span>
                                </div>
                              </div>
                            ) : null}

                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="block text-[10px] text-slate-400 mb-0.5">
                                  Proje Kodu:
                                </label>
                                <input
                                  type="text"
                                  maxLength={16}
                                  value={newProjectCode}
                                  onChange={(e) => {
                                    setCodeEdited(true);
                                    setNewProjectCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''));
                                  }}
                                  className="w-full h-[22px] px-1.5 border border-slate-700 bg-slate-900 text-sky-300 font-mono tabular-nums uppercase text-[11px]"
                                />
                              </div>
                              <div>
                                <label className="block text-[10px] text-slate-400 mb-0.5">
                                  Protokol:
                                </label>
                                <select
                                  value={newProjectProtocol}
                                  onChange={(e) =>
                                    setNewProjectProtocol(
                                      e.target.value as 'CAN' | 'CAN_FD' | 'J1939',
                                    )
                                  }
                                  className="w-full h-[22px] px-1.5 border border-slate-700 bg-slate-900 text-slate-100 font-mono text-[11px]"
                                >
                                  <option value="CAN_FD">CAN-FD</option>
                                  <option value="CAN">Klasik CAN</option>
                                  <option value="J1939">SAE J1939</option>
                                </select>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-1.5 pt-0.5">
                      <button
                        type="button"
                        onClick={() => setShowNewInput(false)}
                        className="h-[22px] px-2 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleCreateNewProject(newProjectName)}
                        style={{
                          backgroundColor: pushToCloudChoice
                            ? 'rgba(56, 189, 248, 0.25)'
                            : 'rgba(63, 185, 128, 0.18)',
                          borderColor: pushToCloudChoice
                            ? '#38BDF8'
                            : 'rgba(63, 185, 128, 0.65)',
                          color: 'var(--text-primary)',
                        }}
                        className="h-[22px] px-3 border text-[11px] font-semibold cursor-pointer hover:opacity-90"
                      >
                        {pushToCloudChoice ? 'Create & Push' : 'Create'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Open Project (.nexusproj.json) */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,.nexusproj.json"
                  onChange={(ev) => void handleImportFile(ev)}
                  className="hidden"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => fileInputRef.current?.click()}
                  style={{
                    backgroundColor: 'var(--bg-toolbar)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[36px] px-3.5 border flex items-center justify-between text-[12px] font-medium hover:border-[var(--text-secondary)] cursor-pointer rounded-sm"
                >
                  <div className="flex items-center gap-2">
                    <FolderOpen className="w-4 h-4 text-[var(--text-secondary)]" />
                    <span>Open Project File...</span>
                  </div>
                  <span className="text-[11px] font-mono text-[var(--text-muted)]">.nexusproj.json</span>
                </button>

                {/* Resume Recent */}
                {cachedRecent && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleResumeRecent()}
                    style={{
                      backgroundColor: 'rgba(56, 139, 253, 0.10)',
                      borderColor: 'rgba(56, 139, 253, 0.35)',
                      color: '#6CB6FF',
                    }}
                    className="w-full h-[36px] px-3.5 border flex items-center justify-between text-[12px] font-medium hover:opacity-90 cursor-pointer rounded-sm"
                  >
                    <div className="flex items-center gap-2 truncate">
                      <Radio className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      <span className="truncate">Resume Recent: <strong>{cachedRecent.name}</strong></span>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 shrink-0" />
                  </button>
                )}
              </div>
            </div>

            <div className="text-[11px] text-[var(--text-muted)] pt-4 font-sans">
              Clean start starts with zero active CAN frames or bus locks.
            </div>
          </div>

          {/* RIGHT: Saved Projects List */}
          <div
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
            }}
            className="p-4 border flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-[var(--text-secondary)]" />
                  <h2 className="text-[13px] font-bold text-[var(--text-primary)]">
                    Saved Projects ({projState.savedProjects.length})
                  </h2>
                </div>
              </div>

              <div className="space-y-1.5 max-h-[170px] overflow-y-auto pr-1">
                {projState.savedProjects.length === 0 ? (
                  <div className="py-8 text-center text-[11px] text-[var(--text-muted)] font-sans border border-dashed border-[var(--border-grid)] rounded-sm">
                    No saved projects yet.
                    <div className="text-[10px] mt-0.5">Use "New Project" to configure and save your workspace.</div>
                  </div>
                ) : (
                  projState.savedProjects.map((item) => (
                    <div
                      key={item.fileStem}
                      onClick={() => void handleOpenSaved(item.fileStem)}
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor: 'var(--border-grid)',
                      }}
                      className="px-2.5 py-1.5 border flex items-center justify-between text-[11px] hover:border-sky-500/50 cursor-pointer group rounded-sm"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-[var(--text-primary)] truncate font-sans">
                          {item.name}
                        </div>
                        <div className="text-[10px] text-[var(--text-muted)] font-mono tabular-nums">
                          {item.updatedAt.slice(0, 10)} · {(item.sizeBytes / 1024).toFixed(1)} KB
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 ml-2">
                        <span className="text-[10px] text-sky-400 group-hover:underline font-medium">Open</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDeleteSaved(item.fileStem);
                          }}
                          className="opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-red-400 p-0.5 cursor-pointer transition-opacity"
                          title="Delete saved project"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="text-[11px] text-[var(--text-muted)] pt-3 font-sans">
              Projects store symbol databases, connection settings and trace limits.
            </div>
          </div>
        </section>

        {/* ================================================================ */}
        {/* 3. CAPABILITIES & MODULAR ROADMAP                                */}
        {/* ================================================================ */}
        <section
          style={{
            backgroundColor: 'var(--bg-panel)',
            borderColor: 'var(--border-strong)',
          }}
          className="p-4 border space-y-3"
        >
          <div className="flex items-center justify-between border-b border-[var(--border-grid)] pb-2">
            <span className="text-[12px] font-bold text-[var(--text-primary)] tracking-tight">
              Platform Architecture & Capabilities
            </span>
            <span className="text-[10px] font-mono text-[var(--text-muted)]">
              Industrial High-Frequency Stack
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {CAPABILITIES.map((cap) => (
              <div
                key={cap.title}
                style={{
                  backgroundColor: 'var(--bg-input)',
                  borderColor: 'var(--border-grid)',
                }}
                className="p-2.5 border rounded-sm flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <div className="flex items-center gap-1.5">
                      {cap.icon}
                      <span className="text-[11px] font-semibold text-[var(--text-primary)]">
                        {cap.title}
                      </span>
                    </div>
                    <span
                      className={`text-[9px] font-mono font-bold px-1 py-0.5 rounded-xs ${
                        cap.badge === 'Active'
                          ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                          : 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
                      }`}
                    >
                      {cap.badge}
                    </span>
                  </div>
                  <p className="text-[10px] text-[var(--text-secondary)] font-sans leading-relaxed">
                    {cap.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
