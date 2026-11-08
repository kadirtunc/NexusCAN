import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Boxes,
  Building2,
  Cloud,
  Download,
  FilePlus2,
  FolderOpen,
  LayoutGrid,
  LogIn,
  Radio,
  RefreshCw,
  Trash2,
  UploadCloud,
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
import type { StatusBanner } from './TopBar';
import { useI18n } from '../i18n';

interface StartPageViewProps {
  devices: readonly DeviceDescriptorDto[];
  onRefreshDevices: () => Promise<void>;
  onStatusMessage: (msg: StatusBanner) => void;
  quickBarState: QuickBarConnectionState;
  onApplyQuickBar: (qb: QuickBarConnectionState) => void;
}

export const StartPageView: React.FC<StartPageViewProps> = ({
  onStatusMessage,
  onApplyQuickBar,
  quickBarState,
}) => {
  const { t, locale, setLocale } = useI18n();
  const projState = useProjectStore();
  const cloudState = useCloudBridgeStore();

  const [cachedRecent, setCachedRecent] = useState<NexusProjectFileV1 | null>(null);
  const [newProjectName, setNewProjectName] = useState<string>('Vehicle Bench 01');
  const [newProjectCode, setNewProjectCode] = useState<string>('VEH-BENCH-01');
  const [newProjectProtocol, setNewProjectProtocol] = useState<'CAN' | 'CAN_FD' | 'J1939'>('CAN_FD');
  const [newProjectOrgId, setNewProjectOrgId] = useState<string>('');
  const [codeEdited, setCodeEdited] = useState<boolean>(false);
  const [createMode, setCreateMode] = useState<'local' | 'cloud'>('local');
  const [busy, setBusy] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void projectStore.refreshSavedProjects();
    const cached = readCachedLastActiveProject();
    setCachedRecent(cached);
    if (Boolean(cloudState.sessionToken)) {
      void cloudBridgeStore.refreshProjects();
    }
  }, [cloudState.sessionToken]);

  useEffect(() => {
    if (!newProjectOrgId && (cloudState.selectedOrgId || cloudState.organizations[0]?.id)) {
      setNewProjectOrgId(cloudState.selectedOrgId || cloudState.organizations[0]?.id || '');
    }
  }, [cloudState.selectedOrgId, cloudState.organizations, newProjectOrgId]);

  const activeOrg = useMemo(() => {
    return (
      cloudState.organizations.find(
        (o) => o.id === (cloudState.selectedOrgId || newProjectOrgId),
      ) ||
      cloudState.organizations[0] ||
      null
    );
  }, [cloudState.organizations, cloudState.selectedOrgId, newProjectOrgId]);

  const filteredCloudProjects = useMemo(() => {
    if (cloudState.selectedOrgId) {
      return cloudState.projects.filter((p) => p.orgId === cloudState.selectedOrgId);
    }
    return cloudState.projects;
  }, [cloudState.projects, cloudState.selectedOrgId]);

  const handleNameChange = (val: string): void => {
    setNewProjectName(val);
    if (!codeEdited) {
      setNewProjectCode(suggestCloudProjectCode(val));
    }
  };

  const handleCreateNewProject = async (): Promise<void> => {
    const targetName = newProjectName.trim() || 'Untitled Project';
    setBusy(true);
    try {
      await projectStore.createNewCleanProject(targetName, onApplyQuickBar);
      databaseStore.setActiveDocTab('rxtx');

      if (Boolean(cloudState.sessionToken) && createMode === 'cloud') {
        try {
          const res = await cloudBridgeStore.pushActiveLocalProjectToCloud({
            mode: 'create_new',
            quickBarState,
            orgId: newProjectOrgId || undefined,
            projectName: targetName,
            projectCode: newProjectCode.trim().toUpperCase(),
            defaultProtocol: newProjectProtocol,
          });
          onStatusMessage({
            kind: 'success',
            message: t('shell.start.projectCreatedAndPushed', { name: targetName, code: res.project.code, rev: res.revisionNumber }),
          });
          return;
        } catch (cloudErr) {
          onStatusMessage({
            kind: 'error',
            message: t('shell.start.projectCreatedPushFailed', {
              name: targetName,
              error: cloudErr instanceof Error ? cloudErr.message : String(cloudErr),
            }),
          });
          return;
        }
      }

      onStatusMessage({
        kind: 'success',
        message: t('shell.start.localProjectCreated', { name: targetName }),
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
        message: t('shell.start.recentResumed', { name: cachedRecent.name, count: res.reconnectedCount }),
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
        message: t('shell.start.resumeFailed', { error: err instanceof Error ? err.message : String(err) }),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleImportFile = async (ev: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;

    setBusy(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as NexusProjectFileV1;
      if (!parsed || parsed.version !== 1) {
        throw new Error('Geçersiz .nexusproj.json dosya formatı.');
      }
      const res = await projectStore.restoreProject(parsed, onApplyQuickBar);
      databaseStore.setActiveDocTab('rxtx');
      onStatusMessage({
        kind: 'success',
        message: t('shell.start.fileProjectOpened', { name: parsed.name, count: res.reconnectedCount }),
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
        message: t('shell.start.openProjectFailed', { error: err instanceof Error ? err.message : String(err) }),
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
        message: t('shell.start.savedProjectOpened', { name: loaded.name }),
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
        message: t('shell.start.openProjectFailed', { error: err instanceof Error ? err.message : String(err) }),
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
        message: t('shell.start.savedProjectDeleted', { fileStem }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('shell.start.deleteFailed', { error: err instanceof Error ? err.message : String(err) }),
      });
    }
  };

  const handlePullCloudProject = async (projectId: string, projectName: string, projectCode: string): Promise<void> => {
    setBusy(true);
    try {
      await cloudBridgeStore.pullCloudWorkspaceToDesktop({
        projectId,
        onApplyQuickBar,
        navigateToTab: 'rxtx',
      });
      onStatusMessage({
        kind: 'success',
        message: t('shell.start.cloudProjectPulled', { name: projectName, code: projectCode }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('shell.start.cloudPullFailed', { error: err instanceof Error ? err.message : String(err) }),
      });
    } finally {
      setBusy(false);
    }
  };

  const langToggle = (
    <div
      style={{ backgroundColor: 'var(--bg-toolbar)', borderColor: 'var(--border-strong)' }}
      className="h-[30px] border flex items-center p-0.5 rounded-[2px] shrink-0 font-mono text-[11px]"
      title={t('shell.lang.switchTitle')}
    >
      <button
        type="button"
        onClick={() => setLocale('tr')}
        className={`h-full px-2 rounded-[2px] font-semibold cursor-pointer transition-colors ${
          locale === 'tr' ? 'bg-sky-600 text-white font-bold' : 'text-slate-400 hover:text-white'
        }`}
      >
        {t('shell.lang.tr')}
      </button>
      <button
        type="button"
        onClick={() => setLocale('en')}
        className={`h-full px-2 rounded-[2px] font-semibold cursor-pointer transition-colors ${
          locale === 'en' ? 'bg-sky-600 text-white font-bold' : 'text-slate-400 hover:text-white'
        }`}
      >
        {t('shell.lang.en')}
      </button>
    </div>
  );

  return (
    <div
      style={{ backgroundColor: 'var(--bg-app)' }}
      className="flex flex-1 min-h-0 flex-col overflow-y-auto select-none p-4 gap-4"
    >
      {/* ==================================================================== */}
      {/* 1. TOP ORGANIZATION & ACCOUNT COMMAND STRIP                          */}
      {/* ==================================================================== */}
      <div
        style={{
          backgroundColor: 'var(--bg-panel)',
          borderColor: 'var(--border-strong)',
        }}
        className="p-3 border rounded-[2px] flex flex-wrap items-center justify-between gap-3 shrink-0 min-h-[46px]"
      >
        {Boolean(cloudState.sessionToken) ? (
          <>
            <div className="flex items-center gap-3.5 flex-wrap">
              {/* Organization Selector */}
              <div className="flex items-center gap-2 font-mono text-[12px]">
                <Building2 className="w-4 h-4 text-sky-400 shrink-0" />
                <span className="text-[var(--text-secondary)] font-sans">{t('shell.start.orgLabel')}</span>
                {cloudState.organizations.length > 1 ? (
                  <select
                    value={cloudState.selectedOrgId ?? ''}
                    onChange={(e) => cloudBridgeStore.selectOrganization(e.target.value)}
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="h-[30px] px-2.5 border text-[12px] font-mono cursor-pointer rounded-[2px] focus:outline-none"
                  >
                    {cloudState.organizations.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name} ({org.myRole})
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="font-semibold text-slate-100">
                    {activeOrg?.name ?? t('shell.start.personalOrg')}
                    {activeOrg?.myRole && (
                      <span className="text-sky-400 text-[11px] ml-1">[{activeOrg.myRole}]</span>
                    )}
                  </span>
                )}
              </div>

              <div className="h-5 w-px bg-[var(--border-strong)]" />

              {/* Account details */}
              <div className="flex items-center gap-2 text-[12px] font-mono text-emerald-400">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>{cloudState.userFullName || cloudState.userEmail}</span>
              </div>
            </div>

            <div className="flex items-center gap-2.5 flex-wrap">
              <button
                type="button"
                onClick={() => databaseStore.setActiveDocTab('panels')}
                style={{
                  backgroundColor: 'rgba(6, 182, 212, 0.12)',
                  borderColor: 'rgba(6, 182, 212, 0.45)',
                  color: '#22d3ee',
                }}
                className="h-[30px] px-3 border text-[12px] font-semibold flex items-center gap-1.5 hover:opacity-90 cursor-pointer rounded-[2px]"
                title={t('shell.start.simPanelsTooltip')}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                <span>{t('shell.start.simPanelsBtn')}</span>
              </button>

              <button
                type="button"
                onClick={() => projectStore.setToolpacksModalOpen(true)}
                style={{
                  backgroundColor: 'var(--bg-toolbar)',
                  borderColor: 'var(--border-strong)',
                }}
                className="h-[30px] px-3 border text-[12px] hover:border-cyan-500 text-[var(--text-secondary)] hover:text-cyan-400 flex items-center gap-1.5 cursor-pointer rounded-[2px]"
                title={t('shell.start.toolpacksTooltip')}
              >
                <Boxes className="w-3.5 h-3.5 text-cyan-400" />
                <span>{t('shell.start.toolpacksBtn', { count: projState.enabledToolpacks.length })}</span>
              </button>

              <button
                type="button"
                disabled={busy || cloudState.loadingProjects}
                onClick={() => void cloudBridgeStore.refreshProjects()}
                style={{
                  backgroundColor: 'var(--bg-toolbar)',
                  borderColor: 'var(--border-strong)',
                }}
                className="h-[30px] px-3 border text-[12px] hover:border-sky-500 text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center gap-1.5 cursor-pointer rounded-[2px]"
                title={t('shell.start.refreshTooltip')}
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 text-sky-400 ${
                    cloudState.loadingProjects ? 'animate-spin' : ''
                  }`}
                />
                <span>{t('shell.start.refreshBtn')}</span>
              </button>

              {langToggle}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
              <span className="w-2 h-2 rounded-full bg-slate-500" />
              <span className="font-semibold text-[var(--text-primary)]">{t('shell.start.localWorkMode')}</span>
              <span className="text-[var(--text-muted)]">{t('shell.start.cloudSignedOutNotice')}</span>
            </div>

            <div className="flex items-center gap-2.5 flex-wrap">
              <button
                type="button"
                onClick={() => databaseStore.setActiveDocTab('panels')}
                style={{
                  backgroundColor: 'rgba(6, 182, 212, 0.12)',
                  borderColor: 'rgba(6, 182, 212, 0.45)',
                  color: '#22d3ee',
                }}
                className="h-[30px] px-3 border text-[12px] font-semibold flex items-center gap-1.5 hover:opacity-90 cursor-pointer rounded-[2px]"
                title={t('shell.start.simPanelsTooltip')}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                <span>{t('shell.start.simPanelsBtn')}</span>
              </button>

              <button
                type="button"
                onClick={() => projectStore.setToolpacksModalOpen(true)}
                style={{
                  backgroundColor: 'var(--bg-toolbar)',
                  borderColor: 'var(--border-strong)',
                }}
                className="h-[30px] px-3 border text-[12px] hover:border-cyan-500 text-[var(--text-secondary)] hover:text-cyan-400 flex items-center gap-1.5 cursor-pointer rounded-[2px]"
                title={t('shell.start.toolpacksTooltip')}
              >
                <Boxes className="w-3.5 h-3.5 text-cyan-400" />
                <span>{t('shell.start.toolpacksBtn', { count: projState.enabledToolpacks.length })}</span>
              </button>

              <button
                type="button"
                onClick={() => databaseStore.setActiveDocTab('cloud')}
                style={{
                  backgroundColor: 'rgba(56, 189, 248, 0.12)',
                  borderColor: 'rgba(56, 189, 248, 0.45)',
                  color: '#38BDF8',
                }}
                className="h-[30px] px-3.5 border text-[12px] font-semibold flex items-center gap-1.5 hover:opacity-90 cursor-pointer rounded-[2px]"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span>{t('shell.start.cloudSignInBtn')}</span>
              </button>

              {langToggle}
            </div>
          </>
        )}
      </div>

      {/* ==================================================================== */}
      {/* 2. THREE-COLUMN INDUSTRIAL COMMAND GRID                              */}
      {/* ==================================================================== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1 min-h-0">
        {/* COLUMN 1: YENİ PROJE OLUŞTUR & HIZLI BAŞLAT */}
        <div
          style={{
            backgroundColor: 'var(--bg-panel)',
            borderColor: 'var(--border-strong)',
          }}
          className="p-4 border rounded-[2px] flex flex-col justify-between"
        >
          <div className="space-y-3.5">
            <div className="flex items-center justify-between border-b border-[var(--border-grid)] pb-2.5">
              <div className="flex items-center gap-2">
                <FilePlus2 className="w-4 h-4 text-emerald-400" />
                <h2 className="text-[13px] font-bold text-[var(--text-primary)] tracking-tight">
                  {t('shell.start.newProjectTitle')}
                </h2>
              </div>
              <Zap className="w-4 h-4 text-emerald-400/80" />
            </div>

            {/* Mode Segmented Button (Yerel vs Cloud) */}
            {Boolean(cloudState.sessionToken) && (
              <div className="flex border border-slate-800 rounded bg-[#0B0F17] p-0.5 text-[12px]">
                <button
                  type="button"
                  onClick={() => setCreateMode('local')}
                  className={`flex-1 h-[28px] rounded-[2px] font-medium cursor-pointer transition-colors ${
                    createMode === 'local'
                      ? 'bg-slate-700 text-white font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {t('shell.start.modeLocal')}
                </button>
                <button
                  type="button"
                  onClick={() => setCreateMode('cloud')}
                  className={`flex-1 h-[28px] rounded-[2px] font-medium cursor-pointer transition-colors ${
                    createMode === 'cloud'
                      ? 'bg-sky-600 text-white font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {t('shell.start.modeCloud')}
                </button>
              </div>
            )}

            {/* Inputs */}
            <div className="space-y-2.5">
              <div>
                <label className="block text-[12px] text-[var(--text-secondary)] font-medium mb-1">
                  {t('shell.start.projectNameLabel')}
                </label>
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="EV BMS Bench Setup"
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[32px] px-3 border text-[12.5px] focus:outline-none focus:border-sky-500 rounded-[2px]"
                />
              </div>

              {createMode === 'cloud' && Boolean(cloudState.sessionToken) && (
                <>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-[11.5px] text-[var(--text-secondary)] mb-1 font-medium">
                        {t('shell.start.projectCodeLabel')}
                      </label>
                      <input
                        type="text"
                        maxLength={16}
                        value={newProjectCode}
                        onChange={(e) => {
                          setCodeEdited(true);
                          setNewProjectCode(
                            e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''),
                          );
                        }}
                        className="w-full h-[32px] px-2.5 border border-slate-700 bg-slate-900 text-sky-300 font-mono tabular-nums uppercase text-[12px] rounded-[2px]"
                      />
                    </div>

                    <div>
                      <label className="block text-[11.5px] text-[var(--text-secondary)] mb-1 font-medium">
                        {t('shell.start.protocolLabel')}
                      </label>
                      <select
                        value={newProjectProtocol}
                        onChange={(e) =>
                          setNewProjectProtocol(
                            e.target.value as 'CAN' | 'CAN_FD' | 'J1939',
                          )
                        }
                        className="w-full h-[32px] px-2.5 border border-slate-700 bg-slate-900 text-slate-100 font-mono text-[12px] rounded-[2px]"
                      >
                        <option value="CAN_FD">CAN-FD</option>
                        <option value="CAN">Klasik CAN</option>
                        <option value="J1939">SAE J1939</option>
                      </select>
                    </div>
                  </div>

                  {cloudState.organizations.length > 1 && (
                    <div>
                      <label className="block text-[11.5px] text-[var(--text-secondary)] mb-1 font-medium">
                        {t('shell.start.projectOrgLabel')}
                      </label>
                      <select
                        value={newProjectOrgId}
                        onChange={(e) => setNewProjectOrgId(e.target.value)}
                        className="w-full h-[32px] px-2.5 border border-slate-700 bg-slate-900 text-slate-100 text-[12px] rounded-[2px]"
                      >
                        {cloudState.organizations.map((org) => (
                          <option key={org.id} value={org.id}>
                            {org.name} ({org.myRole})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </>
              )}

              <button
                type="button"
                disabled={busy}
                onClick={() => void handleCreateNewProject()}
                style={{
                  backgroundColor:
                    createMode === 'cloud'
                      ? 'rgba(56, 189, 248, 0.20)'
                      : 'rgba(63, 185, 128, 0.20)',
                  borderColor:
                    createMode === 'cloud'
                      ? '#38BDF8'
                      : 'rgba(63, 185, 128, 0.65)',
                  color: 'var(--text-primary)',
                }}
                className="w-full h-[34px] border flex items-center justify-center gap-2 font-semibold text-[12.5px] hover:opacity-90 cursor-pointer rounded-[2px] mt-2.5"
              >
                {createMode === 'cloud' ? (
                  <>
                    <UploadCloud className="w-4 h-4 text-sky-400" />
                    <span>{t('shell.start.createAndPushBtn')}</span>
                  </>
                ) : (
                  <>
                    <FilePlus2 className="w-4 h-4 text-emerald-400" />
                    <span>{t('shell.start.createAndStartBtn')}</span>
                  </>
                )}
              </button>
            </div>

            {/* Quick Resume & File Import Section */}
            <div className="pt-3.5 border-t border-[var(--border-grid)] space-y-2.5">
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
                }}
                className="w-full h-[34px] px-3.5 border flex items-center justify-between text-[12px] font-medium hover:border-[var(--text-secondary)] cursor-pointer rounded-[2px]"
              >
                <div className="flex items-center gap-2">
                  <FolderOpen className="w-4 h-4 text-[var(--text-secondary)]" />
                  <span>{t('shell.start.openFromFileBtn')}</span>
                </div>
              </button>

              {cachedRecent && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleResumeRecent()}
                  style={{
                    backgroundColor: 'rgba(56, 139, 253, 0.10)',
                    borderColor: 'rgba(56, 139, 253, 0.40)',
                    color: '#6CB6FF',
                  }}
                  className="w-full h-[34px] px-3.5 border flex items-center justify-between text-[12px] hover:opacity-90 cursor-pointer rounded-[2px]"
                >
                  <div className="flex items-center gap-2 truncate">
                    <Radio className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                    <span className="truncate">
                      {t('shell.start.recentSession')} <strong>{cachedRecent.name}</strong>
                    </span>
                  </div>
                  <span className="text-[11px] text-sky-400 shrink-0 font-mono">{t('shell.start.resumeBtn')}</span>
                </button>
              )}
            </div>
          </div>

          <div className="text-[11px] text-[var(--text-muted)] pt-3 font-mono">
            {t('shell.start.col1Footer')}
          </div>
        </div>

        {/* COLUMN 2: ORGANİZASYON CLOUD PROJELERİ */}
        <div
          style={{
            backgroundColor: 'var(--bg-panel)',
            borderColor: 'var(--border-strong)',
          }}
          className="p-4 border rounded-[2px] flex flex-col justify-between"
        >
          <div className="flex flex-col min-h-0 flex-1">
            <div className="flex items-center justify-between border-b border-[var(--border-grid)] pb-2.5 mb-2.5">
              <div className="flex items-center gap-2">
                <Cloud className="w-4 h-4 text-sky-400" />
                <h2 className="text-[13px] font-bold text-[var(--text-primary)] tracking-tight">
                  {t('shell.start.cloudProjectsTitle')}
                </h2>
              </div>
              <span className="font-mono text-[11px] text-[var(--text-muted)] tabular-nums">
                {t('shell.start.projectCount', { count: filteredCloudProjects.length })}
              </span>
            </div>

            {Boolean(cloudState.sessionToken) ? (
              <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
                {filteredCloudProjects.length === 0 ? (
                  <div className="py-12 text-center text-[12px] text-[var(--text-muted)] border border-dashed border-[var(--border-grid)] rounded-[2px]">
                    {t('shell.start.noCloudProjects')}
                    <div className="text-[11px] mt-1 text-slate-500">
                      {t('shell.start.noCloudProjectsHint')}
                    </div>
                  </div>
                ) : (
                  filteredCloudProjects.map((p) => {
                    const pOrg = cloudState.organizations.find((o) => o.id === p.orgId);
                    const isBound = projState.cloudBinding?.projectId === p.id;
                    return (
                      <div
                        key={p.id}
                        style={{
                          backgroundColor: 'var(--bg-input)',
                          borderColor: isBound ? '#0284C7' : 'var(--border-grid)',
                        }}
                        className={`p-2.5 border rounded-[2px] flex items-center justify-between gap-2 hover:border-sky-500/60 transition-colors ${
                          isBound ? 'bg-sky-950/20' : ''
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-[12px] text-[var(--text-primary)] truncate">
                              {p.name}
                            </span>
                            {isBound && (
                              <span className="px-1.5 py-0.5 rounded bg-sky-950 border border-sky-800 text-sky-300 font-mono text-[10.5px] shrink-0">
                                {t('shell.start.badgeActive')}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-[var(--text-muted)] font-mono tabular-nums flex items-center gap-1.5 mt-0.5">
                            <span className="text-sky-400 font-semibold">[{p.code}]</span>
                            <span>· Rev #{p.latestRevisionNumber ?? 1}</span>
                            <span>· {p.defaultProtocol}</span>
                            {pOrg && <span className="truncate">· {pOrg.name}</span>}
                          </div>
                        </div>

                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handlePullCloudProject(p.id, p.name, p.code)}
                          style={{
                            backgroundColor: 'rgba(56, 189, 248, 0.12)',
                            borderColor: 'rgba(56, 189, 248, 0.45)',
                            color: '#38BDF8',
                          }}
                          className="h-[26px] px-2.5 border text-[11px] font-semibold flex items-center gap-1 cursor-pointer hover:opacity-90 rounded-[2px] shrink-0"
                          title={t('shell.start.pullAndOpenTooltip')}
                        >
                          <Download className="w-3 h-3" />
                          <span>{t('shell.start.pullAndOpen')}</span>
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            ) : (
              <div className="py-14 text-center text-[12px] text-[var(--text-muted)] border border-dashed border-[var(--border-grid)] rounded-[2px]">
                {t('shell.start.mustSignInForCloud')}
                <div className="mt-2.5">
                  <button
                    type="button"
                    onClick={() => databaseStore.setActiveDocTab('cloud')}
                    className="text-sky-400 hover:underline text-[12px] font-medium cursor-pointer"
                  >
                    {t('shell.start.goToCloudSignIn')}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="text-[11px] text-[var(--text-muted)] pt-3 font-mono">
            {t('shell.start.col2Footer')}
          </div>
        </div>

        {/* COLUMN 3: YEREL KAYITLI PROJELER */}
        <div
          style={{
            backgroundColor: 'var(--bg-panel)',
            borderColor: 'var(--border-strong)',
          }}
          className="p-4 border rounded-[2px] flex flex-col justify-between"
        >
          <div className="flex flex-col min-h-0 flex-1">
            <div className="flex items-center justify-between border-b border-[var(--border-grid)] pb-2.5 mb-2.5">
              <div className="flex items-center gap-2">
                <FolderOpen className="w-4 h-4 text-[var(--text-secondary)]" />
                <h2 className="text-[13px] font-bold text-[var(--text-primary)] tracking-tight">
                  {t('shell.start.savedProjectsTitle')}
                </h2>
              </div>
              <span className="font-mono text-[11px] text-[var(--text-muted)] tabular-nums">
                {t('shell.start.projectCount', { count: projState.savedProjects.length })}
              </span>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
              {projState.savedProjects.length === 0 ? (
                <div className="py-12 text-center text-[12px] text-[var(--text-muted)] border border-dashed border-[var(--border-grid)] rounded-[2px]">
                  {t('shell.start.noSavedProjects')}
                  <div className="text-[11px] mt-1 text-slate-500">
                    {t('shell.start.noSavedProjectsHint')}
                  </div>
                </div>
              ) : (
                projState.savedProjects.map((item) => {
                  const isCurrent = projState.currentFileStem === item.fileStem;
                  return (
                    <div
                      key={item.fileStem}
                      onClick={() => void handleOpenSaved(item.fileStem)}
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor: isCurrent ? '#10B981' : 'var(--border-grid)',
                      }}
                      className="p-2.5 border rounded-[2px] flex items-center justify-between gap-2 hover:border-sky-500/60 cursor-pointer group transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-[12px] text-[var(--text-primary)] truncate font-sans">
                            {item.name}
                          </span>
                          {isCurrent && (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-950 border border-emerald-800 text-emerald-300 font-mono text-[10.5px] shrink-0">
                              {t('shell.start.badgeActive')}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-[var(--text-muted)] font-mono tabular-nums mt-0.5">
                          {item.updatedAt.slice(0, 10)} · {(item.sizeBytes / 1024).toFixed(1)} KB
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[11.5px] text-sky-400 group-hover:underline font-medium">
                          {t('shell.start.openBtn')}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDeleteSaved(item.fileStem);
                          }}
                          className="opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-red-400 p-1 cursor-pointer transition-opacity"
                          title={t('shell.start.deleteProjectTooltip')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="text-[11px] text-[var(--text-muted)] pt-3 font-mono">
            {t('shell.start.col3Footer')}
          </div>
        </div>
      </div>
    </div>
  );
};
