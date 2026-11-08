import React, { useEffect, useRef, useState } from 'react';
import {
  Building2,
  Cloud,
  Download,
  FilePlus2,
  FolderOpen,
  FolderX,
  RefreshCw,
  Save,
  Trash2,
  Unlink,
  Upload,
  UploadCloud,
  X,
} from 'lucide-react';
import { useConnectionStore } from '../store/connectionStore';
import { useDatabaseStore } from '../store/databaseStore';
import { usePlotStore } from '../store/plotStore';
import {
  type NexusProjectFileV1,
  type QuickBarConnectionState,
  projectStore,
  useProjectStore,
} from '../store/projectStore';
import { cloudBridgeStore, useCloudBridgeStore } from '../store/cloudBridgeStore';
import { useTelemetryChrono } from '../store/telemetryStore';
import { useTransmitStore } from '../store/transmitStore';
import type { StatusBanner } from './TopBar';

interface ProjectModalProps {
  quickBarState: QuickBarConnectionState;
  onApplyQuickBar: (qb: QuickBarConnectionState) => void;
  onStatusMessage: (msg: StatusBanner) => void;
  onClose: () => void;
}

export const ProjectModal: React.FC<ProjectModalProps> = ({
  quickBarState,
  onApplyQuickBar,
  onStatusMessage,
  onClose,
}) => {
  const projState = useProjectStore();
  const dbState = useDatabaseStore();
  const connState = useConnectionStore();
  const txState = useTransmitStore();
  const plotState = usePlotStore();
  const chrono = useTelemetryChrono();
  const cloudState = useCloudBridgeStore();

  const [nameInput, setNameInput] = useState<string>(projState.currentName);
  const [notesInput, setNotesInput] = useState<string>(projState.notes);
  const [newProjectPushToCloud, setNewProjectPushToCloud] = useState<boolean>(false);
  const [selectedOrgId, setSelectedOrgId] = useState<string>(
    cloudState.selectedOrgId || cloudState.organizations[0]?.id || '',
  );
  const [cloudOrgFilter, setCloudOrgFilter] = useState<string>(
    cloudState.selectedOrgId || '',
  );
  const [busy, setBusy] = useState<boolean>(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void projectStore.refreshSavedProjects();
    if (Boolean(cloudState.sessionToken)) {
      void cloudBridgeStore.refreshProjects();
    }
  }, []);

  useEffect(() => {
    if (!selectedOrgId && (cloudState.selectedOrgId || cloudState.organizations[0]?.id)) {
      setSelectedOrgId(cloudState.selectedOrgId || cloudState.organizations[0]?.id || '');
    }
  }, [cloudState.selectedOrgId, cloudState.organizations, selectedOrgId]);

  const activeOrg =
    cloudState.organizations.find(
      (o) => o.id === (selectedOrgId || cloudState.selectedOrgId),
    ) ||
    cloudState.organizations[0] ||
    null;

  const filteredCloudProjects = cloudOrgFilter
    ? cloudState.projects.filter((p) => p.orgId === cloudOrgFilter)
    : cloudState.projects;

  // Capture Escape so closing ProjectModal does NOT fire global Panic Stop!
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.code === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const handleSave = async (): Promise<void> => {
    setBusy(true);
    try {
      const saved = await projectStore.saveCurrentProject(
        quickBarState,
        nameInput,
        notesInput,
      );
      onStatusMessage({
        kind: 'success',
        message: `Saved project "${saved.name}" (projects/${saved.fileStem}.nexusproj.json).`,
      });
    } catch (err) {
      onStatusMessage({
        kind: 'info',
        message: `Saved "${nameInput}" locally (${
          err instanceof Error ? err.message : String(err)
        }).`,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleOpenServerProject = async (fileStem: string): Promise<void> => {
    setBusy(true);
    try {
      const loaded = await projectStore.loadServerProjectByStem(
        fileStem,
        onApplyQuickBar,
      );
      setNameInput(loaded.name);
      setNotesInput(loaded.notes);
      onStatusMessage({
        kind: 'success',
        message: `Loaded project "${loaded.name}" (DB, Connections, TX List & Plotter restored).`,
      });
      onClose();

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
        message: `Failed to open project "${fileStem}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteServerProject = async (fileStem: string): Promise<void> => {
    setBusy(true);
    try {
      await projectStore.deleteServerProjectByStem(fileStem);
      onStatusMessage({
        kind: 'info',
        message: `Deleted saved project "${fileStem}".`,
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleExportDownload = (): void => {
    const snap = projectStore.buildProjectSnapshot(
      quickBarState,
      nameInput,
      notesInput,
    );
    const blob = new Blob([JSON.stringify(snap, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${snap.fileStem}.nexusproj.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    onStatusMessage({
      kind: 'success',
      message: `Exported "${snap.fileStem}.nexusproj.json" with embedded DBC/KCD, Connections & TX List.`,
    });
  };

  const handleImportFile = async (
    ev: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;

    setBusy(true);
    try {
      const rawText = await file.text();
      const parsed = JSON.parse(rawText) as NexusProjectFileV1;
      if (!parsed || parsed.version !== 1) {
        throw new Error('Invalid .nexusproj.json format (expected version: 1).');
      }
      const res = await projectStore.restoreProject(parsed, onApplyQuickBar);
      setNameInput(parsed.name);
      setNotesInput(parsed.notes ?? '');
      onStatusMessage({
        kind: 'success',
        message: `Imported project "${parsed.name}" (${res.reconnectedCount} bus(es) connected).`,
      });
      onClose();

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
        message: `Project import failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleNewProject = async (): Promise<void> => {
    setBusy(true);
    const targetName = nameInput.trim() || 'Untitled Project';
    try {
      await projectStore.createNewCleanProject(
        targetName,
        onApplyQuickBar,
      );
      setNameInput('Untitled Project');
      setNotesInput('');
      onClose();

      if (Boolean(cloudState.sessionToken) && newProjectPushToCloud) {
        try {
          const res = await cloudBridgeStore.pushActiveLocalProjectToCloud({
            mode: 'create_new',
            quickBarState,
            projectName: targetName,
            orgId: selectedOrgId || undefined,
          });
          onStatusMessage({
            kind: 'success',
            message: `"${targetName}" oluşturuldu ve NexusCANCloud'a pushlandı ([${res.project.code}] Rev #${res.revisionNumber}).`,
          });
        } catch (cloudErr) {
          onStatusMessage({
            kind: 'error',
            message: `"${targetName}" yerel oluşturuldu fakat Cloud'a pushlanamadı: ${
              cloudErr instanceof Error ? cloudErr.message : String(cloudErr)
            }`,
          });
        }
      } else {
        onStatusMessage({
          kind: 'info',
          message: 'Initialized clean workspace project.',
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCloseProject = async (): Promise<void> => {
    setBusy(true);
    try {
      const closedName = projState.currentName;
      await projectStore.closeCurrentProject(onApplyQuickBar);
      onStatusMessage({
        kind: 'info',
        message: `Closed project "${closedName}". Returned to Start Page.`,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const dbSummary =
    dbState.databases.length > 0
      ? `${dbState.databases.length} catalog file(s): ${dbState.databases
          .map((d) => d.fileName)
          .join(', ')} · ${dbState.busSchemas.size} bus binding(s)`
      : 'Catalog empty';

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--bg-panel)',
          borderColor: 'var(--border-strong)',
          color: 'var(--text-primary)',
        }}
        className="w-full max-w-[760px] border shadow-2xl flex flex-col max-h-[86vh]"
      >
        {/* Modal Header */}
        <div
          style={{
            backgroundColor: 'var(--bg-header)',
            borderBottom: '1px solid var(--border-strong)',
          }}
          className="h-[32px] px-3 flex items-center justify-between text-[12px] font-semibold"
        >
          <div className="flex items-center gap-2">
            <span>Project Manager</span>
            {Boolean(cloudState.sessionToken) && (
              <div className="flex items-center gap-1.5 text-[11px] font-normal">
                <span className="text-[var(--text-muted)]">|</span>
                <span className="text-slate-300 font-mono text-[10px]">
                  {cloudState.userFullName || cloudState.userEmail}
                </span>
                {activeOrg && (
                  <span className="px-1.5 py-0.5 rounded bg-sky-950/60 border border-sky-800/60 text-sky-300 font-mono text-[10px] flex items-center gap-1">
                    <Building2 className="w-2.5 h-2.5 text-sky-400 shrink-0" />
                    <span>{activeOrg.name}</span>
                    <span className="text-sky-400/70">[{activeOrg.myRole}]</span>
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3.5 space-y-3.5 text-[12px]">
          {/* Current Workspace Save Box */}
          <div
            style={{
              backgroundColor: 'var(--bg-row-alt)',
              borderColor: 'var(--border-strong)',
            }}
            className="p-3 border space-y-2.5"
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold">Current Active Project</span>
              <span className="font-mono text-[11px] text-[var(--text-muted)]">
                projects/{projState.currentFileStem}.nexusproj.json
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-0.5">
                  Project Name
                </label>
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="EV BMS Bench Setup"
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[26px] px-2 border text-[12px] focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-0.5">
                  Project Description / Notes
                </label>
                <input
                  type="text"
                  value={notesInput}
                  onChange={(e) => setNotesInput(e.target.value)}
                  placeholder="Bench harness v2, 500k/2M FD..."
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[26px] px-2 border text-[12px] focus:outline-none"
                />
              </div>
            </div>

            {/* Included State Summary */}
            <div className="grid grid-cols-2 gap-1.5 text-[11px] font-mono tabular-nums text-[var(--text-secondary)] pt-0.5">
              <div>
                • Databases: <strong className="font-sans text-[var(--text-primary)]">{dbSummary}</strong>
              </div>
              <div>
                • Connection Profiles: <strong className="text-[var(--text-primary)]">{connState.profiles.length}</strong>
              </div>
              <div>
                • Transmit List Entries: <strong className="text-[var(--text-primary)]">{txState.entries.length}</strong>
              </div>
              <div>
                • Plotter Signals / Trace Limit:{' '}
                <strong className="text-[var(--text-primary)]">
                  {plotState.series.length} sigs / {chrono.maxBufferRows.toLocaleString('en-US')} rows
                </strong>
              </div>
            </div>

            {/* NexusCANCloud Durumu & Push Section */}
            {Boolean(cloudState.sessionToken) && (
              <div
                style={{
                  backgroundColor: '#0B0F17',
                  borderColor: 'var(--border-strong)',
                }}
                className="p-2.5 border space-y-2 rounded-sm"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-[11px]">
                    <Cloud className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                    <span className="font-semibold text-slate-200">NexusCANCloud:</span>
                    <span className="font-mono text-emerald-400">Bağlı ({cloudState.cloudBaseUrl})</span>
                  </div>
                  {projState.cloudBinding ? (
                    <span className="px-1.5 py-0.5 rounded bg-sky-950/70 border border-sky-800/60 text-sky-300 font-mono text-[10px] tabular-nums">
                      Bağlı: [{projState.cloudBinding.projectCode}] Rev #{projState.cloudBinding.baseRevisionNumber ?? 1}
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded bg-amber-950/50 border border-amber-800/50 text-amber-300 font-mono text-[10px]">
                      Sadece Yerel — Cloud'a Pushlanmadı
                    </span>
                  )}
                </div>

                {/* Explicit Organization Row */}
                <div className="flex items-center justify-between text-[11px] pt-1 border-t border-slate-800/80">
                  <span className="text-slate-400 font-medium">Organizasyon:</span>
                  {projState.cloudBinding ? (
                    <div className="flex items-center gap-1.5 font-mono text-[11px] text-slate-200">
                      <Building2 className="w-3 h-3 text-sky-400 shrink-0" />
                      <span>
                        {projState.cloudBinding.orgName ||
                          cloudState.organizations.find(
                            (o) => o.id === projState.cloudBinding?.orgId,
                          )?.name ||
                          'Bilinmiyor'}
                      </span>
                      {projState.cloudBinding.orgSlug && (
                        <span className="text-slate-400">
                          (@{projState.cloudBinding.orgSlug})
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <Building2 className="w-3 h-3 text-sky-400 shrink-0" />
                      <select
                        value={selectedOrgId}
                        onChange={(e) => {
                          setSelectedOrgId(e.target.value);
                          cloudBridgeStore.selectOrganization(e.target.value);
                        }}
                        style={{
                          backgroundColor: '#0F1623',
                          borderColor: 'var(--border-strong)',
                          color: 'var(--text-primary)',
                        }}
                        className="h-[22px] px-1.5 border text-[11px] font-mono focus:outline-none"
                      >
                        {cloudState.organizations.map((org) => (
                          <option key={org.id} value={org.id}>
                            {org.name} (@{org.slug} · {org.myRole})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between pt-0.5">
                  {projState.cloudBinding ? (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            const res = await cloudBridgeStore.pushActiveLocalProjectToCloud({
                              mode: 'bound',
                              quickBarState,
                            });
                            onStatusMessage({
                              kind: 'success',
                              message: `"${res.project.name}" Cloud'a pushlandı ([${res.project.code}] Rev #${res.revisionNumber}).`,
                            });
                          } catch (err) {
                            onStatusMessage({
                              kind: 'error',
                              message: `Cloud push hatası: ${err instanceof Error ? err.message : String(err)}`,
                            });
                          } finally {
                            setBusy(false);
                          }
                        }}
                        className="h-[24px] px-2.5 border border-sky-500/60 bg-sky-950/40 text-sky-300 hover:bg-sky-900/50 text-[11px] font-semibold flex items-center gap-1 cursor-pointer rounded-sm"
                      >
                        <UploadCloud className="w-3 h-3 text-sky-400" />
                        <span>Cloud'a Pushla</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          projectStore.setCloudBinding(null, quickBarState);
                          onStatusMessage({
                            kind: 'info',
                            message: 'Cloud bağlantısı kaldırıldı. Proje sadece yerel olarak çalışacak.',
                          });
                        }}
                        className="h-[24px] px-2 border border-slate-700 hover:border-slate-500 text-slate-400 hover:text-slate-200 text-[11px] flex items-center gap-1 cursor-pointer rounded-sm"
                        title="Cloud projesiyle bağlantıyı kes (sadece yerelde tut)"
                      >
                        <Unlink className="w-3 h-3" />
                        <span>Bağlantıyı Kaldır (Sadece Yerel)</span>
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        cloudBridgeStore.openPushPrompt({
                          reason: 'manual',
                          projectName: projState.currentName,
                        });
                      }}
                      className="h-[24px] px-2.5 border border-amber-600/60 bg-amber-950/40 text-amber-300 hover:bg-amber-900/50 text-[11px] font-semibold flex items-center gap-1 cursor-pointer rounded-sm"
                    >
                      <UploadCloud className="w-3 h-3 text-amber-400" />
                      <span>Cloud'a Pushla…</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleNewProject()}
                    style={{
                      backgroundColor: 'var(--bg-panel)',
                      borderColor: 'var(--border-strong)',
                    }}
                    className="h-[25px] px-2.5 border flex items-center gap-1 text-[11px] hover:border-[var(--text-secondary)] cursor-pointer"
                  >
                    <FilePlus2 className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                    <span>New Project</span>
                  </button>

                  {Boolean(cloudState.sessionToken) && (
                    <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={newProjectPushToCloud}
                        onChange={(e) => setNewProjectPushToCloud(e.target.checked)}
                        className="h-3.5 w-3.5 rounded accent-sky-500 cursor-pointer"
                      />
                      <span>Yeni projeyi Cloud'a da pushla</span>
                    </label>
                  )}
                </div>

                <input
                  ref={importInputRef}
                  type="file"
                  accept=".json,.nexusproj.json"
                  onChange={(ev) => void handleImportFile(ev)}
                  className="hidden"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => importInputRef.current?.click()}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="h-[25px] px-2.5 border flex items-center gap-1 text-[11px] hover:border-[var(--text-secondary)] cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <span>Import...</span>
                </button>

                <button
                  type="button"
                  onClick={handleExportDownload}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="h-[25px] px-2.5 border flex items-center gap-1 text-[11px] hover:border-[var(--text-secondary)] cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <span>Export...</span>
                </button>

                {projState.hasActiveWorkspace && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleCloseProject()}
                    style={{
                      backgroundColor: 'var(--bg-panel)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-secondary)',
                    }}
                    className="h-[25px] px-2.5 border flex items-center gap-1 text-[11px] hover:text-red-400 hover:border-red-500/50 cursor-pointer"
                    title="Close Project & Return to Start Page"
                  >
                    <FolderX className="w-3.5 h-3.5 text-red-400" />
                    <span>Close Project</span>
                  </button>
                )}
              </div>

              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSave()}
                style={{
                  backgroundColor: 'rgba(63, 185, 128, 0.16)',
                  borderColor: 'rgba(63, 185, 128, 0.65)',
                  color: 'var(--text-primary)',
                }}
                className="h-[25px] px-3.5 border flex items-center gap-1.5 text-[11px] font-semibold hover:opacity-90 cursor-pointer"
              >
                <Save className="w-3.5 h-3.5 text-emerald-500" />
                <span>Save Project (Ctrl+S)</span>
              </button>
            </div>
          </div>

          {/* Saved Server Projects Table */}
          <div>
            <div className="text-[11px] font-semibold text-[var(--text-secondary)] mb-1">
              Saved Projects
            </div>
            <div style={{ borderColor: 'var(--border-strong)' }} className="border">
              <table className="pcan-grid pcan-grid-fixed font-mono tabular-nums">
                <colgroup>
                  <col />
                  <col style={{ width: '130px' }} />
                  <col style={{ width: '130px' }} />
                  <col style={{ width: '130px' }} />
                  <col style={{ width: '70px' }} />
                  <col style={{ width: '110px' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th className="font-sans">Project Name</th>
                    <th>File Stem</th>
                    <th>Organization</th>
                    <th>Updated</th>
                    <th className="text-right">Size</th>
                    <th className="font-sans">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {projState.savedProjects.length === 0 ? (
                    <tr>
                      <td colSpan={6}>
                        <div className="pcan-cell pcan-cell-center font-sans text-[var(--text-muted)]">
                          No saved projects
                        </div>
                      </td>
                    </tr>
                  ) : (
                    projState.savedProjects.map((item) => {
                      const isCurrent = projState.currentFileStem === item.fileStem;
                      let orgDisplay = '—';
                      let orgBadgeClass = 'text-[var(--text-muted)]';
                      if (isCurrent && projState.cloudBinding) {
                        orgDisplay =
                          projState.cloudBinding.orgName ||
                          projState.cloudBinding.orgSlug ||
                          'Cloud';
                        orgBadgeClass = 'text-sky-400 font-semibold';
                      } else {
                        const matchingCloud = cloudState.projects.find(
                          (p) =>
                            p.name.toLowerCase() === item.name.toLowerCase() ||
                            p.slug.toLowerCase() === item.fileStem.toLowerCase(),
                        );
                        if (matchingCloud) {
                          const matchingCloudOrg = cloudState.organizations.find(
                            (o) => o.id === matchingCloud.orgId,
                          );
                          orgDisplay = matchingCloudOrg?.name || matchingCloud.code;
                          orgBadgeClass = 'text-slate-300';
                        }
                      }

                      return (
                        <tr key={item.fileStem}>
                          <td>
                            <div className="pcan-cell font-sans font-semibold flex items-center gap-1.5">
                              <span className="truncate">{item.name}</span>
                              {isCurrent && (
                                <span className="px-1 py-0.2 rounded bg-emerald-950/70 border border-emerald-800/60 text-emerald-300 font-mono text-[9px]">
                                  Aktif
                                </span>
                              )}
                            </div>
                          </td>
                          <td>
                            <div className="pcan-cell text-[11px] text-[var(--text-secondary)]">
                              <span className="truncate">{item.fileStem}</span>
                            </div>
                          </td>
                          <td>
                            <div
                              className={`pcan-cell text-[11px] truncate ${orgBadgeClass}`}
                              title={orgDisplay}
                            >
                              {orgDisplay}
                            </div>
                          </td>
                          <td>
                            <div className="pcan-cell text-[11px] text-[var(--text-secondary)]">
                              <span className="truncate">
                                {item.updatedAt.replace('T', ' ').slice(0, 19)}
                              </span>
                            </div>
                          </td>
                          <td>
                            <div className="pcan-cell pcan-cell-right text-[11px]">
                              {(item.sizeBytes / 1024).toFixed(1)} KB
                            </div>
                          </td>
                          <td>
                            <div className="pcan-cell gap-1.5 font-sans">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void handleOpenServerProject(item.fileStem)}
                                style={{
                                  backgroundColor: 'var(--bg-toolbar)',
                                  borderColor: 'var(--border-strong)',
                                }}
                                className="h-[18px] px-2 border text-[10px] font-medium hover:border-[var(--text-secondary)] flex items-center gap-1 cursor-pointer"
                              >
                                <FolderOpen className="w-2.5 h-2.5 text-[var(--text-secondary)]" />
                                <span>Open</span>
                              </button>

                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  void handleDeleteServerProject(item.fileStem)
                                }
                                style={{
                                  backgroundColor: 'var(--bg-toolbar)',
                                  borderColor: 'var(--border-strong)',
                                }}
                                className="h-[18px] px-1.5 border text-[10px] text-[var(--text-secondary)] hover:text-red-400 cursor-pointer"
                                title="Delete project file"
                              >
                                <Trash2 className="w-2.5 h-2.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Cloud Projects (Organizasyon Projeleri) Section */}
          {Boolean(cloudState.sessionToken) && (
            <div>
              <div className="flex items-center justify-between text-[11px] font-semibold text-[var(--text-secondary)] mb-1">
                <div className="flex items-center gap-1.5">
                  <Cloud className="w-3.5 h-3.5 text-sky-400" />
                  <span>Cloud Projects (Organizasyon Projeleri)</span>
                  <span className="font-mono text-[10px] text-[var(--text-muted)]">
                    ({filteredCloudProjects.length} / {cloudState.projects.length})
                  </span>
                </div>

                <div className="flex items-center gap-2 font-normal">
                  <label className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)]">
                    <span>Organizasyon:</span>
                    <select
                      value={cloudOrgFilter}
                      onChange={(e) => setCloudOrgFilter(e.target.value)}
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor: 'var(--border-strong)',
                        color: 'var(--text-primary)',
                      }}
                      className="h-[22px] px-1.5 border text-[11px] font-mono focus:outline-none"
                    >
                      <option value="">Tüm Organizasyonlar</option>
                      {cloudState.organizations.map((org) => (
                        <option key={org.id} value={org.id}>
                          {org.name} ({org.myRole})
                        </option>
                      ))}
                    </select>
                  </label>

                  <button
                    type="button"
                    disabled={busy || cloudState.loadingProjects}
                    onClick={() => void cloudBridgeStore.refreshProjects()}
                    style={{
                      backgroundColor: 'var(--bg-toolbar)',
                      borderColor: 'var(--border-strong)',
                    }}
                    className="h-[22px] px-2 border text-[10px] hover:border-[var(--text-secondary)] flex items-center gap-1 cursor-pointer"
                    title="Cloud projelerini yenile"
                  >
                    <RefreshCw
                      className={`w-2.5 h-2.5 text-sky-400 ${
                        cloudState.loadingProjects ? 'animate-spin' : ''
                      }`}
                    />
                    <span>Yenile</span>
                  </button>
                </div>
              </div>

              <div
                style={{ borderColor: 'var(--border-strong)' }}
                className="border max-h-[180px] overflow-y-auto"
              >
                <table className="pcan-grid pcan-grid-fixed font-mono tabular-nums">
                  <colgroup>
                    <col />
                    <col style={{ width: '130px' }} />
                    <col style={{ width: '130px' }} />
                    <col style={{ width: '80px' }} />
                    <col style={{ width: '110px' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="font-sans">Project Name</th>
                      <th>Code / Rev</th>
                      <th>Organization</th>
                      <th>Protocol</th>
                      <th className="font-sans">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCloudProjects.length === 0 ? (
                      <tr>
                        <td colSpan={5}>
                          <div className="pcan-cell pcan-cell-center font-sans text-[var(--text-muted)] py-3">
                            {cloudOrgFilter
                              ? 'Bu organizasyonda kayıtlı Cloud projesi bulunamadı.'
                              : 'Cloud hesabınızda kayıtlı proje bulunamadı.'}
                          </div>
                        </td>
                      </tr>
                    ) : (
                      filteredCloudProjects.map((p) => {
                        const pOrg = cloudState.organizations.find(
                          (o) => o.id === p.orgId,
                        );
                        const isBound = projState.cloudBinding?.projectId === p.id;
                        return (
                          <tr key={p.id}>
                            <td>
                              <div className="pcan-cell font-sans font-semibold flex items-center gap-1.5">
                                <span className="truncate">{p.name}</span>
                                {isBound && (
                                  <span className="px-1 py-0.2 rounded bg-sky-950/70 border border-sky-800/60 text-sky-300 font-mono text-[9px]">
                                    Aktif Bağlı
                                  </span>
                                )}
                              </div>
                            </td>
                            <td>
                              <div className="pcan-cell text-[11px] text-sky-300">
                                [{p.code}]{' '}
                                {p.latestRevisionNumber
                                  ? `Rev #${p.latestRevisionNumber}`
                                  : 'Taslak'}
                              </div>
                            </td>
                            <td>
                              <div
                                className="pcan-cell text-[11px] text-[var(--text-secondary)] truncate"
                                title={pOrg?.name || p.orgId}
                              >
                                {pOrg?.name ?? p.orgId}
                              </div>
                            </td>
                            <td>
                              <div className="pcan-cell text-[11px] text-[var(--text-muted)]">
                                {p.defaultProtocol}
                              </div>
                            </td>
                            <td>
                              <div className="pcan-cell font-sans">
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={async () => {
                                    setBusy(true);
                                    try {
                                      await cloudBridgeStore.pullCloudWorkspaceToDesktop({
                                        projectId: p.id,
                                        onApplyQuickBar,
                                        navigateToTab: 'rxtx',
                                      });
                                      onStatusMessage({
                                        kind: 'success',
                                        message: `Cloud projesi "${p.name}" ([${p.code}]) masaüstüne çekildi ve çalışma alanına yüklendi.`,
                                      });
                                      onClose();
                                    } catch (err) {
                                      onStatusMessage({
                                        kind: 'error',
                                        message: `Cloud projesi çekilemedi: ${
                                          err instanceof Error ? err.message : String(err)
                                        }`,
                                      });
                                    } finally {
                                      setBusy(false);
                                    }
                                  }}
                                  style={{
                                    backgroundColor: 'rgba(56, 189, 248, 0.12)',
                                    borderColor: 'rgba(56, 189, 248, 0.45)',
                                    color: '#38BDF8',
                                  }}
                                  className="h-[20px] px-2 border text-[10px] font-semibold hover:opacity-90 flex items-center gap-1 cursor-pointer"
                                  title="Bu Cloud projesini indir, yerel çalışma alanı olarak aç ve bağla"
                                >
                                  <Download className="w-2.5 h-2.5" />
                                  <span>Pull & Open</span>
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
