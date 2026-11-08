import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2,
  Cable,
  ChevronRight,
  Cloud,
  CloudDownload,
  CloudUpload,
  Database,
  ExternalLink,
  FolderGit2,
  GitCompare,
  Grid,
  LayoutGrid,
  Lock,
  LogOut,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import {
  type CloudBridgeTargetHz,
  cloudBridgeStore,
  normalizeCloudBaseUrl,
  useCloudBridgeHeader,
  useCloudBridgeStore,
} from '../store/cloudBridgeStore';
import { databaseStore, makeCatalogDbId, useDatabaseStore } from '../store/databaseStore';
import {
  type NexusProjectFileV1,
  type QuickBarConnectionState,
  projectStore,
  useProjectStore,
} from '../store/projectStore';
import { isToolpackEnabled } from '../types/toolpacks';
import {
  simulationPanelStore,
  useSimulationPanelStore,
} from '../store/simulationPanelStore';
import type {
  SimulationPanelDto,
} from '../types/simulation';
import {
  type WorkspaceSectionKey,
  computeWorkspaceDiff,
  computeWorkspaceSemanticHash,
  mergeWorkspaceSections,
  validateAndNormalizeWorkspaceJson,
} from '../utils/workspaceDiff';
import type { StatusBanner } from './TopBar';
import { SimulationWorkbenchView } from './simulation/SimulationWorkbenchView';
import { makeDatabaseEntry } from './simulation/desktopDbEntries';
import {
  inferBusIdFromAssignment,
  type LoadedSimulationDatabaseEntry,
} from './simulation/virtualCanPacking';
import { apiParseDatabaseSchema } from '../services/ipcClient';
import { useI18n } from '../i18n';

interface CloudWorkspaceViewProps {
  quickBarState: QuickBarConnectionState;
  onApplyQuickBar: (qb: QuickBarConnectionState) => void;
  onStatusMessage: (msg: StatusBanner) => void;
}

export type CloudProjectModule =
  | 'overview'
  | 'panels'
  | 'live_bridge'
  | 'databases'
  | 'connections'
  | 'tx_plotter'
  | 'sync_diff';

const TARGET_HZ_OPTIONS: readonly CloudBridgeTargetHz[] = [10, 15, 20, 30, 60];


export const CloudWorkspaceView: React.FC<CloudWorkspaceViewProps> = ({
  quickBarState,
  onApplyQuickBar,
  onStatusMessage,
}) => {
  const { t } = useI18n();
  const cloudState = useCloudBridgeStore();
  const cloudHeader = useCloudBridgeHeader();
  const projState = useProjectStore();
  const dbState = useDatabaseStore();
  const simState = useSimulationPanelStore();
  const isSimEnabled = isToolpackEnabled(projState.enabledToolpacks, 'simulation_replay');

  // Local active workspace snapshot
  const localProject = useMemo(() => {
    if (!projState.hasActiveWorkspace) return null;
    return projectStore.buildProjectSnapshot(quickBarState);
  }, [projState.hasActiveWorkspace, quickBarState, dbState, simState.configRev]);

  // Selected Cloud Project Module
  const [activeModule, setActiveModule] = useState<CloudProjectModule>('overview');

  // Staged Workspace (The working copy of remote project)
  const [stagedWorkspace, setStagedWorkspace] = useState<NexusProjectFileV1 | null>(null);

  // Active cloud panels list
  const [cloudPanels, setCloudPanels] = useState<SimulationPanelDto[]>([]);

  // Diff & Sync state
  const [diffSubMode, setDiffSubMode] = useState<'diff' | 'json'>('diff');
  const [sectionPicks, setSectionPicks] = useState<Record<WorkspaceSectionKey, 'local' | 'cloud'>>({
    metadata: 'local',
    databases: 'local',
    connections: 'local',
    transmitList: 'local',
    plotter: 'local',
    simulationPanels: 'local',
  });
  const [rawJsonText, setRawJsonText] = useState<string>('');
  const [rawJsonError, setRawJsonError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState<string>('');
  const [bindLocalOnPush, setBindLocalOnPush] = useState<boolean>(true);
  const [forcePush, setForcePush] = useState<boolean>(false);

  // New Cloud Project inline dialog state
  const [newProjectOpen, setNewProjectOpen] = useState<boolean>(false);
  const [newProjectName, setNewProjectName] = useState<string>('');
  const [newProjectCode, setNewProjectCode] = useState<string>('CAN');
  const [newProjectProto, setNewProjectProto] = useState<'CAN' | 'CAN_FD' | 'J1939'>('CAN_FD');
  const [newProjectDesc, setNewProjectDesc] = useState<string>('');
  const [newProjectUseLocal, setNewProjectUseLocal] = useState<boolean>(true);

  // Project search filter
  const [projectSearch, setProjectSearch] = useState<string>('');
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Auth form state (when logged out)
  const [authEmail, setAuthEmail] = useState<string>('');
  const [authPassword, setAuthPassword] = useState<string>('');
  const [authFullName, setAuthFullName] = useState<string>('');
  const [authBaseUrl, setAuthBaseUrl] = useState<string>(cloudState.cloudBaseUrl);
  const [isRegisterMode, setIsRegisterMode] = useState<boolean>(false);
  const [authBusy, setAuthBusy] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [isSyncingCloud, setIsSyncingCloud] = useState<boolean>(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [cloudSyncNonce, setCloudSyncNonce] = useState<number>(0);

  // Cloud project multi-DBC catalog (explicitly chosen per panel; never a hidden "active DBC")
  const [cloudDbEntries, setCloudDbEntries] = useState<LoadedSimulationDatabaseEntry[]>([]);
  const [loadingCloudDbs, setLoadingCloudDbs] = useState<boolean>(false);
  const [cloudDbError, setCloudDbError] = useState<string | null>(null);

  const isLoggedIn = Boolean(cloudState.sessionToken);

  // Inspected project
  const inspectedProject = useMemo(() => {
    if (!cloudState.inspectedProjectId) return null;
    return cloudState.projects.find((p) => p.id === cloudState.inspectedProjectId) ?? null;
  }, [cloudState.inspectedProjectId, cloudState.projects]);

  // Sync staged workspace whenever remote workspace changes
  useEffect(() => {
    if (cloudState.remoteWorkspace) {
      setStagedWorkspace(cloudState.remoteWorkspace);
      setRawJsonText(JSON.stringify(cloudState.remoteWorkspace, null, 2));
      setRawJsonError(null);
    }
  }, [cloudState.remoteWorkspace]);

  // Auto-fetch panels whenever inspected project changes
  useEffect(() => {
    if (cloudState.inspectedProjectId && cloudState.sessionToken) {
      void cloudBridgeStore
        .fetchCloudPanels(cloudState.inspectedProjectId)
        .then((panels) => {
          setCloudPanels(panels);
        })
        .catch(() => {
          if (cloudState.remoteWorkspace?.simulationPanels) {
            setCloudPanels(cloudState.remoteWorkspace.simulationPanels);
          }
        });
    }
  }, [cloudState.inspectedProjectId, cloudState.remoteWorkspace?.simulationPanels, cloudState.sessionToken]);

  // Load every database of the inspected Cloud project (+ workspace customFiles not yet in the catalog)
  const workspaceCustomFiles = cloudState.remoteWorkspace?.databases?.customFiles;
  useEffect(() => {
    const projId = cloudState.inspectedProjectId;
    if (!projId || !cloudState.sessionToken) {
      setCloudDbEntries([]);
      return;
    }
    let cancelled = false;
    setLoadingCloudDbs(true);
    setCloudDbError(null);
    void (async () => {
      const entries: LoadedSimulationDatabaseEntry[] = [];
      try {
        const listRes = await cloudBridgeStore.fetchCloudProjectDatabases(projId);
        const perDb = await Promise.all(
          listRes.databases.map(async (db) => {
            try {
              const one = await cloudBridgeStore.fetchCloudProjectDatabases(projId, {
                databaseId: db.id,
                versionId: db.latestVersion.id,
              });
              return { db, schema: one.activeSchema };
            } catch {
              return { db, schema: null };
            }
          }),
        );
        for (const item of perDb) {
          if (!item.schema) continue;
          entries.push({
            db: item.db,
            version: item.db.latestVersion,
            schema: item.schema,
            inferredBusId: inferBusIdFromAssignment(item.db.busAssignment),
          });
        }
      } catch (err) {
        if (!cancelled) {
          setCloudDbError(err instanceof Error ? err.message : String(err));
        }
      }
      // Workspace-embedded files that the Cloud DB registry does not list yet
      const knownFiles = new Set(
        entries.map((e) => e.version.fileName.trim().toLowerCase()),
      );
      for (const cf of workspaceCustomFiles ?? []) {
        const key = cf.fileName.trim().toLowerCase();
        if (knownFiles.has(key) || cf.contentBase64.length === 0) continue;
        try {
          const schema = await apiParseDatabaseSchema(cf.fileName, cf.contentBase64);
          entries.push(
            makeDatabaseEntry({
              id: `ws:${key}`,
              name: cf.fileName.replace(/\.[^/.]+$/, ''),
              fileName: cf.fileName,
              schema,
              busId: 0,
              busLabel: 'CAN0 · workspace',
              sizeBytes: cf.sizeBytes,
            }),
          );
          knownFiles.add(key);
        } catch {
          // Skip unparsable embedded file
        }
      }
      if (!cancelled) {
        setCloudDbEntries(entries);
        setLoadingCloudDbs(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cloudState.inspectedProjectId, cloudState.sessionToken, cloudSyncNonce, workspaceCustomFiles]);

  // Active Organization
  const activeOrg = useMemo(() => {
    return (
      cloudState.organizations.find((o) => o.id === cloudState.selectedOrgId) ||
      cloudState.organizations[0] ||
      null
    );
  }, [cloudState.organizations, cloudState.selectedOrgId]);

  // Filtered project list
  const filteredProjects = useMemo(() => {
    let list = cloudState.projects;
    if (cloudState.selectedOrgId) {
      list = list.filter((p) => p.orgId === cloudState.selectedOrgId);
    }
    if (projectSearch.trim()) {
      const q = projectSearch.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.code.toLowerCase().includes(q) ||
          p.slug.toLowerCase().includes(q),
      );
    }
    return list;
  }, [cloudState.projects, cloudState.selectedOrgId, projectSearch]);

  // Semantic Diff Report
  const diffReport = useMemo(
    () => computeWorkspaceDiff(localProject, cloudState.remoteWorkspace),
    [localProject, cloudState.remoteWorkspace],
  );

  const localHash = useMemo(() => computeWorkspaceSemanticHash(localProject), [localProject]);
  const cloudHash = useMemo(
    () => computeWorkspaceSemanticHash(cloudState.remoteWorkspace),
    [cloudState.remoteWorkspace],
  );
  const stagedHash = useMemo(
    () => computeWorkspaceSemanticHash(stagedWorkspace),
    [stagedWorkspace],
  );

  // Handle section pick change (merges into staged workspace)
  const handleToggleSectionPick = useCallback(
    (key: WorkspaceSectionKey, side: 'local' | 'cloud'): void => {
      if (!localProject || !cloudState.remoteWorkspace) return;
      const nextPicks = { ...sectionPicks, [key]: side };
      setSectionPicks(nextPicks);
      const merged = mergeWorkspaceSections(
        cloudState.remoteWorkspace,
        localProject,
        cloudState.remoteWorkspace,
        nextPicks,
      );
      setStagedWorkspace(merged);
      setRawJsonText(JSON.stringify(merged, null, 2));
      setRawJsonError(null);
    },
    [localProject, cloudState.remoteWorkspace, sectionPicks],
  );

  // ==========================================================================
  // Auth Handlers (Login / Register / Logout)
  // ==========================================================================

  const handleLoginSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      if (isRegisterMode) {
        await cloudBridgeStore.registerAndConnect({
          cloudUrlInput: authBaseUrl,
          fullName: authFullName,
          email: authEmail,
          password: authPassword,
        });
      } else {
        await cloudBridgeStore.loginAndConnect(authBaseUrl, authEmail, authPassword);
      }
      onStatusMessage({
        kind: 'success',
        message: t('cloud.auth.loginSuccess'),
      });
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = async (): Promise<void> => {
    try {
      await cloudBridgeStore.disconnectAndLogout();
      setStagedWorkspace(null);
      setCloudPanels([]);
      setActiveModule('overview');
      onStatusMessage({
        kind: 'info',
        message: t('cloud.auth.logoutSuccess'),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // ==========================================================================
  // Project Selection & Creation
  // ==========================================================================

  const handleSelectProject = async (projId: string): Promise<void> => {
    await cloudBridgeStore.setInspectedProject(projId);
    try {
      const panels = await cloudBridgeStore.fetchCloudPanels(projId);
      setCloudPanels(panels);
    } catch {
      // Best effort
    }
  };

  const handleCreateNewProjectSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!newProjectName.trim()) return;

    setBusyAction('create_project');
    try {
      const initialWorkspace = newProjectUseLocal && localProject ? localProject : undefined;
      const orgId =
        cloudState.selectedOrgId ||
        cloudState.organizations[0]?.id ||
        'default-org';
      const created = await cloudBridgeStore.createCloudProject({
        orgId,
        name: newProjectName.trim(),
        code: newProjectCode.trim().toUpperCase() || 'CAN',
        defaultProtocol: newProjectProto,
        description: newProjectDesc.trim(),
        initialWorkspace,
      });

      setNewProjectOpen(false);
      setNewProjectName('');
      setNewProjectDesc('');
      setActiveModule('overview');
      onStatusMessage({
        kind: 'success',
        message: t('cloud.status.projectCreated', { name: created.name }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('cloud.status.projectCreateFailed', { error: err instanceof Error ? err.message : String(err) }),
      });
    } finally {
      setBusyAction(null);
    }
  };

  // ==========================================================================
  // Pull to Desktop (Safety Invariant: Listen-Only Mirror)
  // ==========================================================================

  const handlePullToDesktop = async (): Promise<void> => {
    if (!inspectedProject) return;
    setBusyAction('pull');
    try {
      await cloudBridgeStore.pullCloudWorkspaceToDesktop({
        workspace: stagedWorkspace ?? undefined,
        projectId: inspectedProject.id,
        revisionNumber: cloudState.remoteRevisionNumber ?? undefined,
        onApplyQuickBar,
        navigateToTab: 'rxtx',
      });
      onStatusMessage({
        kind: 'success',
        message: t('cloud.status.pullSuccess', { name: inspectedProject.name }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('cloud.status.pullFailed', { error: err instanceof Error ? err.message : String(err) }),
      });
    } finally {
      setBusyAction(null);
    }
  };

  // ==========================================================================
  // Push Staged Workspace to Cloud
  // ==========================================================================

  const handlePushToCloud = async (overrideWorkspace?: NexusProjectFileV1): Promise<void> => {
    if (!inspectedProject) return;
    const wsToSend = overrideWorkspace ?? stagedWorkspace;
    if (!wsToSend) return;

    setBusyAction('push');
    try {
      const res = await cloudBridgeStore.pushWorkspacePayloadToCloud({
        projectId: inspectedProject.id,
        workspace: {
          ...wsToSend,
          simulationPanels: cloudPanels,
        },
        commitMessage: commitMessage.trim() || undefined,
        baseRevisionNumber: forcePush ? null : cloudState.remoteRevisionNumber,
        force: forcePush,
        bindLocalIfActive: bindLocalOnPush,
        quickBarState,
      });

      setCommitMessage('');
      setForcePush(false);
      onStatusMessage({
        kind: 'success',
        message: t('cloud.status.pushSuccess', { rev: res.revisionNumber }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('cloud.status.pushFailed', { error: err instanceof Error ? err.message : String(err) }),
      });
    } finally {
      setBusyAction(null);
    }
  };

  // ==========================================================================
  // Deep Cloud Sync (Synchronizes Project Tree, Remote Workspace & Panels)
  // ==========================================================================

  const handleDeepCloudSync = useCallback(async (): Promise<void> => {
    if (isSyncingCloud) return;
    setIsSyncingCloud(true);
    try {
      const projects = await cloudBridgeStore.refreshProjects();
      const targetProjId = cloudBridgeStore.getState().inspectedProjectId;
      if (targetProjId && cloudBridgeStore.getState().sessionToken) {
        const [wsResult, panelsResult] = await Promise.allSettled([
          cloudBridgeStore.fetchRemoteWorkspace(targetProjId),
          cloudBridgeStore.fetchCloudPanels(targetProjId),
        ]);
        if (panelsResult.status === 'fulfilled') {
          setCloudPanels(panelsResult.value);
        } else if (wsResult.status === 'fulfilled' && wsResult.value.workspace.simulationPanels) {
          setCloudPanels(wsResult.value.workspace.simulationPanels);
        }
      }
      const now = new Date();
      const timeStr = [
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
      ].join(':');
      setLastSyncedAt(timeStr);
      setCloudSyncNonce((n) => n + 1);

      const target = cloudBridgeStore.getState().projects.find((p) => p.id === targetProjId);
      if (target) {
        if (activeModule === 'panels') {
          onStatusMessage({
            kind: 'success',
            message: t('cloud.status.syncPanels', { code: target.code }),
          });
        } else if (activeModule === 'databases') {
          onStatusMessage({
            kind: 'success',
            message: t('cloud.status.syncDatabases', { code: target.code }),
          });
        } else if (activeModule === 'sync_diff' || activeModule === 'overview') {
          const revNum = cloudBridgeStore.getState().remoteRevisionNumber;
          onStatusMessage({
            kind: 'success',
            message: t('cloud.status.syncWorkspace', { code: target.code, rev: revNum ?? 'last' }),
          });
        } else {
          onStatusMessage({
            kind: 'success',
            message: t('cloud.status.syncAllModules', { code: target.code }),
          });
        }
      } else {
        onStatusMessage({
          kind: 'success',
          message: t('cloud.status.syncProjects', { count: projects.length }),
        });
      }
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: err instanceof Error ? err.message : t('cloud.status.syncFailed'),
      });
    } finally {
      setIsSyncingCloud(false);
    }
  }, [activeModule, isSyncingCloud, onStatusMessage, t]);

  // Stable Memoized Cloud Project Context for SimulationWorkbenchView
  const simulationCloudContext = useMemo(() => {
    if (!inspectedProject) return null;
    return {
      project: {
        id: inspectedProject.id,
        orgId: inspectedProject.orgId,
        name: inspectedProject.name,
        slug: inspectedProject.slug,
        code: inspectedProject.code,
        description: inspectedProject.description || '',
        vehiclePlatform: inspectedProject.vehiclePlatform || 'CAN_PLATFORM',
        defaultProtocol: inspectedProject.defaultProtocol,
        databaseCount: 1,
        activeVersionLabel: 'v1.0',
        sessionCount: 1,
        onlineDeviceCount: 1,
        updatedAt: inspectedProject.updatedAt || new Date().toISOString(),
      },
      panels: cloudPanels,
      schema: null,
      databases: cloudDbEntries,
      loadingDatabases: loadingCloudDbs,
      syncNonce: cloudSyncNonce,
      onSyncFromCloud: handleDeepCloudSync,
      syncingFromCloud: isSyncingCloud,
      onSavePanel: async (panel: SimulationPanelDto) => {
        await cloudBridgeStore.updateCloudPanel(
          panel.id,
          panel,
          inspectedProject.id,
        );
        setCloudPanels((prev) =>
          prev.map((p) => (p.id === panel.id ? panel : p))
        );
        onStatusMessage({
          kind: 'success',
          message: t('cloud.status.panelSaved', { name: panel.name }),
        });
      },
      onCreatePanel: async (panel: SimulationPanelDto) => {
        const created = await cloudBridgeStore.createCloudPanel(
          panel,
          inspectedProject.id,
        );
        setCloudPanels((prev) => [...prev, created]);
        onStatusMessage({
          kind: 'success',
          message: t('cloud.status.panelCreated', { name: created.name }),
        });
      },
      onRequestRenamePanel: async (panel: SimulationPanelDto, newName: string) => {
        const updated = { ...panel, name: newName };
        await cloudBridgeStore.updateCloudPanel(
          panel.id,
          updated,
          inspectedProject.id,
        );
        setCloudPanels((prev) =>
          prev.map((p) => (p.id === panel.id ? updated : p))
        );
        onStatusMessage({
          kind: 'success',
          message: t('cloud.status.panelRenamed', { name: newName }),
        });
      },
      onDeletePanel: async (panelId: string) => {
        await cloudBridgeStore.deleteCloudPanel(
          panelId,
          inspectedProject.id,
        );
        setCloudPanels((prev) => prev.filter((p) => p.id !== panelId));
        onStatusMessage({
          kind: 'info',
          message: t('cloud.status.panelDeleted'),
        });
      },
      onPullPanelToLocal: (panel: SimulationPanelDto) => {
        simulationPanelStore.upsertPanelFromCloud(panel);
        onStatusMessage({
          kind: 'success',
          message: t('cloud.status.panelPulled', { name: panel.name }),
        });
      },
    };
  }, [
    inspectedProject,
    cloudPanels,
    cloudDbEntries,
    loadingCloudDbs,
    cloudSyncNonce,
    handleDeepCloudSync,
    isSyncingCloud,
    onStatusMessage,
    t,
  ]);

  // URL to direct Live WebCAN stream
  const liveCloudStreamUrl = cloudState.streamId
    ? `${normalizeCloudBaseUrl(cloudState.cloudBaseUrl)}/live/${encodeURIComponent(cloudState.streamId)}`
    : `${normalizeCloudBaseUrl(cloudState.cloudBaseUrl)}/live`;

  const isBridgeActive =
    cloudState.status === 'streaming' ||
    cloudState.status === 'connecting_ws' ||
    cloudState.status === 'authenticating';
  const isInspectedStreaming =
    isBridgeActive &&
    inspectedProject !== null &&
    inspectedProject.id === cloudState.selectedProjectId;

  const handleStopLiveStream = (): void => {
    const projName = cloudState.selectedProjectName ?? 'Cloud projesi';
    cloudBridgeStore.stopLiveStream();
    onStatusMessage({
      kind: 'info',
      message: t('cloud.status.streamStopped', { name: projName }),
    });
  };

  // ==========================================================================
  // RENDER: NOT LOGGED IN VIEW
  // ==========================================================================
  if (!isLoggedIn) {
    return (
      <div
        style={{
          backgroundColor: 'var(--bg-canvas)',
          color: 'var(--text-primary)',
        }}
        className="flex-1 min-h-0 flex flex-col items-center justify-center p-6 select-none overflow-y-auto"
      >
        {/* Offline Simulation Access Banner */}
        {simState.panels.length > 0 && isSimEnabled && (
          <div className="w-full max-w-[760px] mb-3 p-3 rounded-[2px] border border-cyan-500/40 bg-cyan-950/20 flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex items-center gap-2 text-[12px] text-cyan-300">
              <LayoutGrid className="w-4 h-4 text-cyan-400 shrink-0" />
              <span>
                {t('cloud.offlineBanner.notice', { count: simState.panels.length })}
              </span>
            </div>
            <button
              type="button"
              onClick={() => databaseStore.setActiveDocTab('panels')}
              className="h-[30px] px-3 rounded-[2px] border border-cyan-500/60 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-200 text-[12px] font-semibold flex items-center gap-1.5 cursor-pointer"
            >
              <span>{t('cloud.offlineBanner.btn')}</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div
          style={{
            backgroundColor: 'var(--bg-panel)',
            borderColor: 'var(--border-strong)',
          }}
          className="w-full max-w-[760px] border shadow-2xl grid grid-cols-1 md:grid-cols-2 rounded-[2px] overflow-hidden"
        >
          {/* Left: Auth Form */}
          <div className="p-6 space-y-4 border-r border-[var(--border-strong)]">
            <div className="flex items-center gap-2">
              <Cloud className="w-5 h-5 text-cyan-400" />
              <div>
                <span className="font-semibold text-[14px] text-[var(--text-primary)] block">
                  {t('cloud.auth.title')}
                </span>
                <span className="text-[12px] text-[var(--text-secondary)]">
                  {t('cloud.auth.subtitle')}
                </span>
              </div>
            </div>

            {authError && (
              <div className="p-2.5 border border-red-500/40 bg-red-950/20 text-red-400 text-[12px] font-medium rounded-[2px]">
                {authError}
              </div>
            )}

            <form onSubmit={(e) => void handleLoginSubmit(e)} className="space-y-3.5 text-[12px]">
              <div>
                <label className="block text-[11.5px] font-medium text-[var(--text-secondary)] mb-1">
                  {t('cloud.auth.serverUrl')}
                </label>
                <input
                  type="text"
                  value={authBaseUrl}
                  onChange={(e) => setAuthBaseUrl(e.target.value)}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="w-full h-[30px] px-2.5 border font-mono text-[12px] focus:outline-none"
                />
              </div>

              {isRegisterMode && (
                <div>
                  <label className="block text-[11.5px] font-medium text-[var(--text-secondary)] mb-1">
                    {t('cloud.auth.fullName')}
                  </label>
                  <input
                    type="text"
                    required
                    value={authFullName}
                    onChange={(e) => setAuthFullName(e.target.value)}
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                    }}
                    className="w-full h-[30px] px-2.5 border text-[12px] focus:outline-none"
                  />
                </div>
              )}

              <div>
                <label className="block text-[11.5px] font-medium text-[var(--text-secondary)] mb-1">
                  {t('cloud.auth.email')}
                </label>
                <input
                  type="email"
                  required
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="w-full h-[30px] px-2.5 border text-[12px] focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11.5px] font-medium text-[var(--text-secondary)] mb-1">
                  {t('cloud.auth.password')}
                </label>
                <input
                  type="password"
                  required
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="w-full h-[30px] px-2.5 border text-[12px] focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={authBusy}
                style={{
                  backgroundColor: 'rgba(6, 182, 212, 0.18)',
                  borderColor: 'rgba(6, 182, 212, 0.65)',
                }}
                className="w-full h-[32px] border flex items-center justify-center gap-1.5 text-[12px] font-semibold text-cyan-300 hover:opacity-90 cursor-pointer disabled:opacity-50"
              >
                {authBusy ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Cloud className="w-3.5 h-3.5 text-cyan-400" />
                )}
                <span>
                  {authBusy
                    ? t('cloud.auth.connecting')
                    : isRegisterMode
                      ? t('cloud.auth.registerAndLogin')
                      : t('cloud.auth.loginAndConnect')}
                </span>
              </button>
            </form>

            <div className="pt-2.5 border-t border-[var(--border-strong)] flex items-center justify-between text-[12px] text-[var(--text-secondary)]">
              <span>{isRegisterMode ? t('cloud.auth.haveAccount') : t('cloud.auth.noAccount')}</span>
              <button
                type="button"
                onClick={() => {
                  setIsRegisterMode(!isRegisterMode);
                  setAuthError(null);
                }}
                className="text-cyan-400 hover:underline cursor-pointer font-medium"
              >
                {isRegisterMode ? t('cloud.auth.switchLogin') : t('cloud.auth.switchRegister')}
              </button>
            </div>
          </div>

          {/* Right: Cloud Highlights */}
          <div
            style={{ backgroundColor: 'var(--bg-row-alt)' }}
            className="p-6 flex flex-col justify-between text-[11px] space-y-4"
          >
            <div className="space-y-3">
              <span className="font-semibold text-[13px] text-cyan-400 block">
                {t('cloud.auth.sideTitle')}
              </span>
              <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                {t('cloud.auth.sideDesc')}
              </p>

              <div className="space-y-2 pt-1">
                <div className="flex items-center gap-2">
                  <LayoutGrid className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span>
                    <strong>{t('cloud.auth.sideSharedPanels')}:</strong> {t('cloud.auth.sideSharedPanelsDesc')}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Radio className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>
                    <strong>{t('cloud.auth.sideLiveTelemetry')}:</strong> {t('cloud.auth.sideLiveTelemetryDesc')}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Lock className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>
                    <strong>{t('cloud.auth.sideFieldSafety')}:</strong> {t('cloud.auth.sideFieldSafetyDesc')}
                  </span>
                </div>
              </div>
            </div>

            <div className="text-[10px] text-[var(--text-muted)] font-mono">
              {t('cloud.auth.versionLabel')}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ==========================================================================
  // RENDER: LOGGED IN DRILL-DOWN CLOUD WORKSPACE
  // ==========================================================================
  return (
    <div
      style={{
        backgroundColor: 'var(--bg-canvas)',
        color: 'var(--text-primary)',
      }}
      className="flex-1 min-h-0 flex flex-col select-none overflow-hidden"
    >
      {/* ==================================================================== */}
      {/* 1. TOP CLOUD STATUS TOOLBAR (40px)                                   */}
      {/* ==================================================================== */}
      <div
        style={{
          backgroundColor: 'var(--bg-toolbar)',
          borderBottom: '1px solid var(--border-strong)',
        }}
        className="min-h-[40px] px-3 py-1 flex flex-wrap items-center justify-between gap-2.5 shrink-0 text-[12px]"
      >
        {/* Left: Server Status & Organization Selector */}
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 font-semibold text-cyan-400 shrink-0">
            <Cloud className="w-4 h-4" />
            <span className="hidden sm:inline">NexusCANCloud</span>
          </div>

          <div className="h-4 w-px bg-[var(--border-strong)] shrink-0" />

          {/* Org Selector */}
          <div className="flex items-center gap-1.5">
            <Building2 className="w-4 h-4 text-cyan-400 shrink-0" />
            <select
              value={cloudState.selectedOrgId ?? ''}
              onChange={(e) => cloudBridgeStore.selectOrganization(e.target.value)}
              style={{
                backgroundColor: 'var(--bg-input)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              className="h-[28px] px-2 border text-[12px] cursor-pointer max-w-[170px] truncate focus:outline-none"
              title={t('cloud.toolbar.activeOrgTitle')}
            >
              {cloudState.organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name} ({org.myRole})
                </option>
              ))}
            </select>
          </div>

          {/* Live Status Pill */}
          {cloudHeader.status === 'streaming' ? (
            <div className="flex items-center gap-1 text-[11px] font-mono font-semibold px-2 py-0.5 border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 rounded-[2px] shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>{t('cloud.toolbar.livePill', { hz: cloudHeader.targetHz })}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1 text-[11px] font-mono text-[var(--text-muted)] px-2 py-0.5 border border-[var(--border-strong)] rounded-[2px] shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
              <span>{isBridgeActive ? t('cloud.toolbar.connecting') : t('cloud.toolbar.offline')}</span>
            </div>
          )}
          {isBridgeActive ? (
            <button
              type="button"
              onClick={handleStopLiveStream}
              title={t('cloud.toolbar.stopStreamTitle')}
              className="h-[28px] px-2.5 border text-[11px] font-mono font-semibold cursor-pointer flex items-center gap-1.5 shrink-0 hover:opacity-90"
              style={{ borderColor: 'var(--status-critical)', color: 'var(--status-critical)' }}
            >
              <Square className="w-3.5 h-3.5" />
              {t('cloud.toolbar.stopStream')}
            </button>
          ) : (
            cloudState.selectedProjectId && (
              <button
                type="button"
                onClick={() => void cloudBridgeStore.resumeLiveStream()}
                title={t('cloud.toolbar.startStreamTitle', { name: cloudState.selectedProjectName ?? '' })}
                className="h-[28px] px-2.5 border text-[11px] font-mono font-semibold cursor-pointer flex items-center gap-1.5 shrink-0 hover:opacity-90"
                style={{ borderColor: 'var(--status-nominal)', color: 'var(--status-nominal)' }}
              >
                <Play className="w-3.5 h-3.5" />
                {t('cloud.toolbar.startStream')}
              </button>
            )
          )}
        </div>

        {/* Right: User / Rate / Web Link / Logout */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <div className="hidden lg:flex items-center gap-1.5 text-[11px] font-mono text-[var(--text-secondary)]">
            <span>{t('cloud.toolbar.rate')}</span>
            <select
              value={cloudState.desiredHz}
              onChange={(e) =>
                cloudBridgeStore.setDesiredHz(Number(e.target.value) as CloudBridgeTargetHz)
              }
              style={{
                backgroundColor: 'var(--bg-input)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              className="h-[26px] px-1.5 border text-[11px] cursor-pointer focus:outline-none"
            >
              {TARGET_HZ_OPTIONS.map((hz) => (
                <option key={hz} value={hz}>
                  {hz} Hz
                </option>
              ))}
            </select>
          </div>

          <a
            href={liveCloudStreamUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              backgroundColor: 'rgba(6, 182, 212, 0.10)',
              borderColor: 'rgba(6, 182, 212, 0.40)',
            }}
            className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[11.5px] font-semibold text-cyan-400 hover:bg-cyan-500/20 cursor-pointer"
            title={t('cloud.toolbar.webInterfaceTitle')}
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span className="hidden md:inline">{t('cloud.toolbar.webInterface')}</span>
          </a>

          <button
            type="button"
            disabled={isSyncingCloud}
            onClick={() => void handleDeepCloudSync()}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
            }}
            className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[11.5px] hover:border-cyan-500/50 hover:text-cyan-400 cursor-pointer disabled:opacity-50"
            title={t('cloud.toolbar.cloudSyncTitle')}
          >
            <RefreshCw className={`w-3.5 h-3.5 text-[var(--text-secondary)] ${isSyncingCloud ? 'animate-spin text-cyan-400' : ''}`} />
            <span className="font-semibold text-cyan-400">{t('cloud.toolbar.cloudSync')}</span>
            {lastSyncedAt && (
              <span className="hidden md:inline font-mono tabular-nums text-[10px] text-[var(--text-muted)]">
                {lastSyncedAt}
              </span>
            )}
          </button>

          {/* User + Org Pill */}
          <div
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
            }}
            className="hidden md:flex items-center gap-1.5 px-2.5 h-[28px] border text-[11px] font-mono tabular-nums text-slate-300 shrink-0"
            title={t('cloud.toolbar.sessionTooltip', { user: cloudState.userFullName || cloudState.userEmail })}
          >
            <span className="truncate max-w-[130px] text-slate-200">
              {cloudState.userFullName || cloudState.userEmail}
            </span>
            {activeOrg && (
              <span className="px-1.5 py-0.5 rounded bg-cyan-950/70 border border-cyan-800/60 text-cyan-300 text-[10px] flex items-center gap-1">
                <Building2 className="w-3 h-3 text-cyan-400 shrink-0" />
                <span>{activeOrg.name}</span>
                <span className="text-cyan-400/70">[{activeOrg.myRole}]</span>
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={() => void handleLogout()}
            style={{
              backgroundColor: 'rgba(239, 68, 68, 0.10)',
              borderColor: 'rgba(239, 68, 68, 0.40)',
            }}
            className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[11.5px] text-red-400 hover:border-red-500 cursor-pointer"
            title={t('cloud.toolbar.logoutTitle')}
          >
            <LogOut className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{t('cloud.toolbar.logout')}</span>
          </button>
        </div>
      </div>

      {/* ==================================================================== */}
      {/* 2. BODY: LEFT PROJECT LIST (250px) + RIGHT DRILL-DOWN HUB           */}
      {/* ==================================================================== */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* ================================================================== */}
        {/* LEFT COLUMN (250px): Projeler & Yeni Proje Ekle                    */}
        {/* ================================================================== */}
        <div
          style={{
            backgroundColor: 'var(--bg-panel)',
            borderRight: '1px solid var(--border-strong)',
          }}
          className="w-[250px] flex flex-col shrink-0 text-[11px] overflow-hidden"
        >
          {/* Header & Filter */}
          <div
            style={{
              backgroundColor: 'var(--bg-header)',
              borderBottom: '1px solid var(--border-grid)',
            }}
            className="p-2 space-y-1.5 shrink-0"
          >
            <div className="flex items-center justify-between text-[11px] font-semibold text-[var(--text-secondary)]">
              <span>{t('cloud.projects.title', { count: filteredProjects.length })}</span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={isSyncingCloud}
                  onClick={() => void handleDeepCloudSync()}
                  className="text-[var(--text-muted)] hover:text-cyan-400 cursor-pointer flex items-center p-0.5 rounded-[2px]"
                  title={t('cloud.projects.syncTooltip')}
                >
                  <RefreshCw className={`w-3 h-3 ${isSyncingCloud ? 'animate-spin text-cyan-400' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={() => setNewProjectOpen(!newProjectOpen)}
                  className="text-cyan-400 hover:underline cursor-pointer flex items-center gap-0.5 text-[10px]"
                >
                  <Plus className="w-3 h-3" />
                  <span>{t('cloud.projects.newBtn')}</span>
                </button>
              </div>
            </div>

            <div className="relative">
              <Search className="w-3 h-3 text-[var(--text-muted)] absolute left-2 top-1.5 pointer-events-none" />
              <input
                type="text"
                placeholder={t('cloud.projects.searchPlaceholder')}
                value={projectSearch}
                onChange={(e) => setProjectSearch(e.target.value)}
                style={{
                  backgroundColor: 'var(--bg-input)',
                  borderColor: 'var(--border-strong)',
                }}
                className="w-full h-[22px] pl-6 pr-1.5 border text-[10px] focus:outline-none"
              />
            </div>
          </div>

          {/* New Project Inline Form */}
          {newProjectOpen && (
            <form
              onSubmit={(e) => void handleCreateNewProjectSubmit(e)}
              style={{
                backgroundColor: 'var(--bg-row-alt)',
                borderBottom: '1px solid var(--border-strong)',
              }}
              className="p-2 space-y-2 shrink-0 text-[10px]"
            >
              <div className="font-semibold text-cyan-400 flex items-center justify-between">
                <span>{t('cloud.projects.newProjectTitle')}</span>
                <button
                  type="button"
                  onClick={() => setNewProjectOpen(false)}
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>

              <div>
                <label className="block text-[9px] text-[var(--text-muted)] mb-0.5">
                  {t('cloud.projects.nameLabel')}
                </label>
                <input
                  type="text"
                  required
                  placeholder={t('cloud.projects.namePlaceholder')}
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="w-full h-[22px] px-1.5 border focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <label className="block text-[9px] text-[var(--text-muted)] mb-0.5">
                    {t('cloud.projects.codeLabel')}
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={12}
                    value={newProjectCode}
                    onChange={(e) => setNewProjectCode(e.target.value.toUpperCase())}
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                    }}
                    className="w-full h-[22px] px-1.5 border font-mono uppercase focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[9px] text-[var(--text-muted)] mb-0.5">
                    {t('cloud.projects.protoLabel')}
                  </label>
                  <select
                    value={newProjectProto}
                    onChange={(e) =>
                      setNewProjectProto(e.target.value as 'CAN' | 'CAN_FD' | 'J1939')
                    }
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                    }}
                    className="w-full h-[22px] px-1 border cursor-pointer"
                  >
                    <option value="CAN_FD">CAN-FD</option>
                    <option value="CAN">Classical CAN</option>
                    <option value="J1939">SAE J1939</option>
                  </select>
                </div>
              </div>

              {localProject && (
                <label className="flex items-center gap-1.5 cursor-pointer pt-0.5">
                  <input
                    type="checkbox"
                    checked={newProjectUseLocal}
                    onChange={(e) => setNewProjectUseLocal(e.target.checked)}
                  />
                  <span>{t('cloud.projects.useLocalTemplate')}</span>
                </label>
              )}

              <button
                type="submit"
                disabled={busyAction === 'create_project'}
                style={{
                  backgroundColor: 'rgba(6, 182, 212, 0.18)',
                  borderColor: 'rgba(6, 182, 212, 0.65)',
                }}
                className="w-full h-[24px] border flex items-center justify-center font-semibold text-cyan-300 hover:opacity-90 cursor-pointer disabled:opacity-50"
              >
                {busyAction === 'create_project' ? t('cloud.projects.creating') : t('cloud.projects.createBtn')}
              </button>
            </form>
          )}

          {/* Project List */}
          <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-[var(--border-grid)]">
            {filteredProjects.length === 0 ? (
              <div className="p-4 text-center text-[10px] text-[var(--text-muted)] italic">
                {t('cloud.projects.emptyList')}
              </div>
            ) : (
              filteredProjects.map((p) => {
                const isInspected = p.id === cloudState.inspectedProjectId;
                const isStreaming = isBridgeActive && p.id === cloudState.selectedProjectId;
                const isLinked = projState.cloudBinding?.projectId === p.id;
                const hasPendingRemote =
                  cloudState.remoteUpdateAvailableRev !== null &&
                  p.id === cloudState.inspectedProjectId;

                return (
                  <div
                    key={p.id}
                    onClick={() => void handleSelectProject(p.id)}
                    style={{
                      backgroundColor: isInspected
                        ? 'var(--bg-row-selected, rgba(14, 116, 144, 0.15))'
                        : undefined,
                    }}
                    className={`p-2.5 cursor-pointer hover:bg-[var(--bg-row-hover,rgba(255,255,255,0.03))] space-y-1 transition-colors ${
                      isInspected ? 'border-l-2 border-cyan-400' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-semibold truncate text-[var(--text-primary)]">
                        {p.name}
                      </span>
                      <span className="font-mono text-[9px] px-1 py-0.2 rounded-[2px] bg-[var(--border-strong)] text-[var(--text-secondary)] shrink-0">
                        {p.code}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-1 text-[10px] text-[var(--text-muted)]">
                      <span>{p.defaultProtocol}</span>
                      <div className="flex items-center gap-1 font-mono">
                        {p.latestRevisionNumber !== null && <span>Rev #{p.latestRevisionNumber}</span>}
                        {isStreaming && (
                          <span className="px-1 rounded-[2px] bg-emerald-500/20 text-emerald-400 font-bold text-[9px]">
                            {t('cloud.projects.badgeLive')}
                          </span>
                        )}
                        {isLinked && (
                          <span className="px-1 rounded-[2px] bg-cyan-500/20 text-cyan-400 font-bold text-[9px]">
                            {t('cloud.projects.badgeLinked')}
                          </span>
                        )}
                        {hasPendingRemote && (
                          <span className="px-1 rounded-[2px] bg-amber-500/20 text-amber-400 font-bold text-[9px]">
                            ↓#{cloudState.remoteUpdateAvailableRev}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ================================================================== */}
        {/* RIGHT AREA: BREADCRUMB BAR (30px) + SELECTED MODULE VIEW           */}
        {/* ================================================================== */}
        {!inspectedProject ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3 select-none">
            <FolderGit2 className="w-10 h-10 text-cyan-400/50" />
            <div className="space-y-1">
              <h3 className="font-semibold text-[14px] text-[var(--text-primary)]">
                {t('cloud.noProject.title')}
              </h3>
              <p className="text-[11px] text-[var(--text-secondary)] max-w-sm">
                {t('cloud.noProject.desc')}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {/* 40px Navigation Bar & Quick Actions */}
            <div
              style={{
                backgroundColor: 'var(--bg-toolbar)',
                borderBottom: '1px solid var(--border-strong)',
              }}
              className="min-h-[40px] px-3 py-1 flex flex-wrap items-center justify-between gap-2.5 shrink-0 text-[12px]"
            >
              {/* Breadcrumbs & Module Buttons */}
              <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                <span className="font-mono text-[11px] font-bold text-cyan-400 shrink-0">
                  [{inspectedProject.code}]
                </span>
                <span className="font-semibold text-[var(--text-primary)] truncate max-w-[160px] shrink-0">
                  {inspectedProject.name}
                </span>
                {cloudState.remoteRevisionNumber !== null && (
                  <span className="font-mono text-[10px] text-[var(--text-muted)] shrink-0">
                    #Rev{cloudState.remoteRevisionNumber}
                  </span>
                )}

                <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />

                {/* Module Selector Buttons */}
                <div className="flex flex-wrap items-center gap-1 shrink-0">
                  {[
                    { id: 'overview' as const, label: t('cloud.module.overview'), icon: Grid },
                    ...(isSimEnabled
                      ? [
                          {
                            id: 'panels' as const,
                            label: t('cloud.module.panels', { count: cloudPanels.length }),
                            icon: LayoutGrid,
                          },
                        ]
                      : []),
                    { id: 'live_bridge' as const, label: t('cloud.module.liveBridge'), icon: Radio },
                    { id: 'databases' as const, label: t('cloud.module.databases'), icon: Database },
                    { id: 'connections' as const, label: t('cloud.module.connections'), icon: Cable },
                    { id: 'tx_plotter' as const, label: t('cloud.module.txPlotter'), icon: Send },
                    { id: 'sync_diff' as const, label: t('cloud.module.syncDiff'), icon: GitCompare },
                  ].map((m) => {
                    const isActive = activeModule === m.id;
                    const IconComp = m.icon;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          setActiveModule(m.id as CloudProjectModule);
                          if (m.id === 'panels' && inspectedProject && cloudState.sessionToken) {
                            void cloudBridgeStore
                              .fetchCloudPanels(inspectedProject.id)
                              .then((p) => setCloudPanels(p))
                              .catch(() => undefined);
                          }
                        }}
                        style={{
                          backgroundColor: isActive ? 'var(--bg-panel)' : 'transparent',
                          borderColor: isActive ? 'var(--border-strong)' : 'transparent',
                          color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                        }}
                        className={`h-[28px] px-2.5 border flex items-center gap-1.5 rounded-[2px] cursor-pointer text-[12px] font-medium transition-colors ${
                          isActive ? 'border-cyan-500/50 text-cyan-300 font-semibold' : 'hover:text-[var(--text-primary)]'
                        }`}
                      >
                        <IconComp className="w-3.5 h-3.5 shrink-0" />
                        <span>{m.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={isSyncingCloud}
                  onClick={() => void handleDeepCloudSync()}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)] hover:text-cyan-400 hover:border-cyan-500/50 cursor-pointer disabled:opacity-50"
                  title={t('cloud.toolbar.refreshBtnTitle')}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isSyncingCloud ? 'animate-spin text-cyan-400' : ''}`} />
                  <span className="hidden sm:inline">{t('cloud.toolbar.refreshBtn')}</span>
                </button>

                {/* Quick Action: Pull to Desktop */}
                <button
                  type="button"
                  disabled={busyAction === 'pull'}
                  onClick={() => void handlePullToDesktop()}
                  style={{
                    backgroundColor: 'rgba(6, 182, 212, 0.12)',
                    borderColor: 'rgba(6, 182, 212, 0.45)',
                  }}
                  className="h-[28px] px-3 border flex items-center gap-1.5 text-[12px] font-semibold text-cyan-400 hover:bg-cyan-500/20 cursor-pointer shrink-0 disabled:opacity-50"
                  title={t('cloud.toolbar.pullBtnTitle')}
                >
                  <CloudDownload className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{t('cloud.toolbar.pullBtn')}</span>
                </button>
              </div>
            </div>

            {/* ============================================================== */}
            {/* MODULE 0: OVERVIEW (6 Clickable Cards Drill-Down Hub)           */}
            {/* ============================================================== */}
            {activeModule === 'overview' && (
              <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
                {/* Project Overview Strip */}
                <div
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="p-3 border flex flex-wrap items-center justify-between gap-3 text-[11px]"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-[var(--text-primary)]">
                        {inspectedProject.name}
                      </span>
                      <span className="font-mono text-[10px] px-1.5 py-0.2 bg-[var(--border-strong)] text-[var(--text-secondary)] rounded-[2px]">
                        {inspectedProject.code}
                      </span>
                      <span className="font-mono text-[10px] text-cyan-400 font-bold">
                        {inspectedProject.defaultProtocol}
                      </span>
                    </div>
                    <span className="text-[10px] text-[var(--text-secondary)]">
                      {inspectedProject.description || t('cloud.overview.noDesc')}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 font-mono text-[10px]">
                    <span className="text-[var(--text-muted)]">
                      {t('cloud.overview.lastRev')} <strong>#{cloudState.remoteRevisionNumber ?? 1}</strong>
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-[2px] font-bold ${
                        !diffReport.hasDifferences
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                      }`}
                    >
                      {!diffReport.hasDifferences ? t('cloud.overview.diffIdentical') : t('cloud.overview.diffDifferent')}
                    </span>
                  </div>
                </div>

                {/* 2x3 Grid of 6 Drill-Down Engineering Cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {/* Card 1: Simülasyon Panelleri */}
                  <div
                    onClick={() => setActiveModule('panels')}
                    style={{
                      backgroundColor: 'var(--bg-panel)',
                      borderColor: 'var(--border-strong)',
                    }}
                    className="p-3.5 border hover:border-cyan-400 transition-all cursor-pointer flex flex-col justify-between space-y-2 group rounded-[2px]"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <LayoutGrid className="w-4 h-4 text-cyan-400" />
                        <span className="font-semibold text-[12px] group-hover:text-cyan-300">
                          {t('cloud.card.panels.title')}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] px-1.5 py-0.2 bg-cyan-950/40 text-cyan-400 border border-cyan-500/30">
                        {t('cloud.card.panels.badge', { count: cloudPanels.length })}
                      </span>
                    </div>

                    <p className="text-[11px] text-[var(--text-secondary)] line-clamp-2">
                      {cloudPanels.length > 0
                        ? cloudPanels.map((p) => p.name).join(', ')
                        : t('cloud.card.panels.empty')}
                    </p>

                    <div className="pt-2 border-t border-[var(--border-grid)] flex items-center justify-between text-[10px] text-cyan-400 font-semibold">
                      <span>{t('cloud.card.panels.action')}</span>
                      <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                    </div>
                  </div>

                  {/* Card 2: Canlı Köprü & Kayıt */}
                  <div
                    onClick={() => setActiveModule('live_bridge')}
                    style={{
                      backgroundColor: 'var(--bg-panel)',
                      borderColor: isInspectedStreaming
                        ? 'rgba(16, 185, 129, 0.6)'
                        : 'var(--border-strong)',
                    }}
                    className="p-3.5 border hover:border-emerald-400 transition-all cursor-pointer flex flex-col justify-between space-y-2 group rounded-[2px]"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Radio
                          className={`w-4 h-4 ${
                            isInspectedStreaming ? 'text-emerald-400' : 'text-[var(--text-muted)]'
                          }`}
                        />
                        <span className="font-semibold text-[12px] group-hover:text-emerald-300">
                          {t('cloud.card.bridge.title')}
                        </span>
                      </div>
                      <span
                        className={`font-mono text-[10px] px-1.5 py-0.2 rounded-[2px] font-bold ${
                          isInspectedStreaming
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : 'bg-slate-700/30 text-[var(--text-muted)]'
                        }`}
                      >
                        {isInspectedStreaming ? t('cloud.card.bridge.streaming') : t('cloud.card.bridge.passive')}
                      </span>
                    </div>

                    <p className="text-[11px] text-[var(--text-secondary)]">
                      {isInspectedStreaming
                        ? t('cloud.card.bridge.streamingDesc', {
                            count: cloudState.sentSnapshotsCount,
                            latency: cloudState.latencyMs,
                          })
                        : t('cloud.card.bridge.passiveDesc')}
                    </p>

                    <div className="pt-2 border-t border-[var(--border-grid)] flex items-center justify-between text-[10px] text-emerald-400 font-semibold">
                      <span>{t('cloud.card.bridge.action')}</span>
                      <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                    </div>
                  </div>

                  {/* Card 3: Veritabanları */}
                  <div
                    onClick={() => setActiveModule('databases')}
                    style={{
                      backgroundColor: 'var(--bg-panel)',
                      borderColor: 'var(--border-strong)',
                    }}
                    className="p-3.5 border hover:border-cyan-400 transition-all cursor-pointer flex flex-col justify-between space-y-2 group rounded-[2px]"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Database className="w-4 h-4 text-cyan-400" />
                        <span className="font-semibold text-[12px] group-hover:text-cyan-300">
                          {t('cloud.card.db.title')}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-[var(--text-muted)]">
                        {t('cloud.card.db.filesCount', {
                          count: (stagedWorkspace?.databases?.customFiles ?? []).length,
                        })}
                      </span>
                    </div>

                    <p className="text-[11px] text-[var(--text-secondary)] line-clamp-2">
                      {stagedWorkspace?.databases?.usePresetDb ? t('cloud.card.db.presetActive') : ''}
                      {(stagedWorkspace?.databases?.customFiles ?? []).length > 0
                        ? (stagedWorkspace?.databases?.customFiles ?? []).map((f) => f.fileName).join(', ')
                        : t('cloud.card.db.noFiles')}
                    </p>

                    <div className="pt-2 border-t border-[var(--border-grid)] flex items-center justify-between text-[10px] text-cyan-400 font-semibold">
                      <span>{t('cloud.card.db.action')}</span>
                      <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                    </div>
                  </div>

                  {/* Card 4: Bağlantı Profilleri */}
                  <div
                    onClick={() => setActiveModule('connections')}
                    style={{
                      backgroundColor: 'var(--bg-panel)',
                      borderColor: 'var(--border-strong)',
                    }}
                    className="p-3.5 border hover:border-cyan-400 transition-all cursor-pointer flex flex-col justify-between space-y-2 group rounded-[2px]"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Cable className="w-4 h-4 text-cyan-400" />
                        <span className="font-semibold text-[12px] group-hover:text-cyan-300">
                          {t('cloud.card.conn.title')}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-[var(--text-muted)]">
                        {t('cloud.card.conn.profilesCount', {
                          count: (stagedWorkspace?.connections?.profiles ?? []).length,
                        })}
                      </span>
                    </div>

                    <p className="text-[11px] text-[var(--text-secondary)] line-clamp-2">
                      {(stagedWorkspace?.connections?.profiles ?? []).length > 0
                        ? (stagedWorkspace?.connections?.profiles ?? []).map((p) => p.name).join(', ')
                        : t('cloud.card.conn.noProfiles')}
                    </p>

                    <div className="pt-2 border-t border-[var(--border-grid)] flex items-center justify-between text-[10px] text-cyan-400 font-semibold">
                      <span>{t('cloud.card.conn.action')}</span>
                      <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                    </div>
                  </div>

                  {/* Card 5: TX & Plotter */}
                  <div
                    onClick={() => setActiveModule('tx_plotter')}
                    style={{
                      backgroundColor: 'var(--bg-panel)',
                      borderColor: 'var(--border-strong)',
                    }}
                    className="p-3.5 border hover:border-amber-400 transition-all cursor-pointer flex flex-col justify-between space-y-2 group rounded-[2px]"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Send className="w-4 h-4 text-amber-400" />
                        <span className="font-semibold text-[12px] group-hover:text-amber-300">
                          {t('cloud.card.tx.title')}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-[var(--text-muted)]">
                        {t('cloud.card.tx.badge', {
                          count: (stagedWorkspace?.transmitList?.entries ?? []).length,
                        })}
                      </span>
                    </div>

                    <p className="text-[11px] text-[var(--text-secondary)]">
                      {t('cloud.card.tx.desc', {
                        txCount: (stagedWorkspace?.transmitList?.entries ?? []).length,
                        plotCount: (stagedWorkspace?.plotter?.watchedSignals ?? []).length,
                      })}
                    </p>

                    <div className="pt-2 border-t border-[var(--border-grid)] flex items-center justify-between text-[10px] text-amber-400 font-semibold">
                      <span>{t('cloud.card.tx.action')}</span>
                      <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                    </div>
                  </div>

                  {/* Card 6: Diff & Sync */}
                  <div
                    onClick={() => setActiveModule('sync_diff')}
                    style={{
                      backgroundColor: 'var(--bg-panel)',
                      borderColor: 'var(--border-strong)',
                    }}
                    className="p-3.5 border hover:border-emerald-400 transition-all cursor-pointer flex flex-col justify-between space-y-2 group rounded-[2px]"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <GitCompare className="w-4 h-4 text-emerald-400" />
                        <span className="font-semibold text-[12px] group-hover:text-emerald-300">
                          {t('cloud.card.diff.title')}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-[var(--text-muted)]">
                        {t('cloud.card.diff.badge')}
                      </span>
                    </div>

                    <p className="text-[11px] text-[var(--text-secondary)]">
                      {diffReport.summaryText}
                    </p>

                    <div className="pt-2 border-t border-[var(--border-grid)] flex items-center justify-between text-[10px] text-emerald-400 font-semibold">
                      <span>{t('cloud.card.diff.action')}</span>
                      <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ============================================================== */}
            {/* MODULE 1: PANELS (1:1 Unified Simulation Workbench in Cloud)  */}
            {/* ============================================================== */}
            {activeModule === 'panels' && simulationCloudContext && (
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <SimulationWorkbenchView cloudProjectContext={simulationCloudContext} />
              </div>
            )}

            {/* ============================================================== */}
            {/* MODULE 2: LIVE TELEMETRY BRIDGE & CLOUD RECORDING              */}
            {/* ============================================================== */}
            {activeModule === 'live_bridge' && (
              <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3.5 text-[11px]">
                {/* Streaming Status Card */}
                <div
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: isInspectedStreaming
                      ? 'rgba(16, 185, 129, 0.65)'
                      : 'var(--border-strong)',
                  }}
                  className="p-4 border space-y-3 rounded-[2px]"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Radio
                        className={`w-4 h-4 ${
                          isInspectedStreaming ? 'text-emerald-400' : 'text-[var(--text-muted)]'
                        }`}
                      />
                      <span className="font-semibold text-[13px] text-[var(--text-primary)]">
                        {t('cloud.live.statusTitle')}
                      </span>
                    </div>

                    <span
                      className={`font-mono text-[10px] px-2 py-0.5 rounded-[2px] font-bold ${
                        isInspectedStreaming
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                          : 'bg-slate-700/20 text-[var(--text-muted)]'
                      }`}
                    >
                      {isInspectedStreaming
                        ? t('cloud.live.badgeActive', { hz: cloudState.targetHz })
                        : t('cloud.live.badgeInactive')}
                    </span>
                  </div>

                  <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                    {t('cloud.live.desc')}
                  </p>

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {!isInspectedStreaming ? (
                      <button
                        type="button"
                        onClick={() => void cloudBridgeStore.switchProject(inspectedProject.id)}
                        style={{
                          backgroundColor: 'rgba(16, 185, 129, 0.18)',
                          borderColor: 'rgba(16, 185, 129, 0.65)',
                        }}
                        className="h-[26px] px-3 border font-semibold text-emerald-300 hover:opacity-90 cursor-pointer flex items-center gap-1.5"
                      >
                        <Play className="w-3.5 h-3.5" />
                        <span>{t('cloud.live.startBtn')}</span>
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={handleStopLiveStream}
                          className="h-[26px] px-3 border font-semibold cursor-pointer flex items-center gap-1.5 hover:opacity-90"
                          style={{ borderColor: 'var(--status-critical)', color: 'var(--status-critical)' }}
                        >
                          <Square className="w-3.5 h-3.5" />
                          <span>{t('cloud.live.stopBtn')}</span>
                        </button>
                        <div className="flex items-center gap-2 font-mono text-[10px] tabular-nums text-emerald-400">
                          <span>{t('cloud.live.sentPackets', { count: cloudState.sentSnapshotsCount })}</span>
                          <span>•</span>
                          <span>{t('cloud.live.rttLatency', { latency: cloudState.latencyMs })}</span>
                        </div>
                      </>
                    )}

                    <a
                      href={liveCloudStreamUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="h-[26px] px-3 border border-cyan-500/40 text-cyan-400 flex items-center gap-1 text-[11px] font-semibold hover:bg-cyan-500/10 cursor-pointer"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>{t('cloud.live.browserLive')}</span>
                    </a>
                  </div>
                </div>

                {/* Read-Only Safety Strip */}
                <div
                  style={{
                    backgroundColor: 'rgba(14, 116, 144, 0.08)',
                    borderColor: 'rgba(14, 116, 144, 0.40)',
                  }}
                  className="p-3 border flex items-center gap-2.5 text-[11px]"
                >
                  <Lock className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span>
                    {t('cloud.live.safetyBanner')}
                  </span>
                </div>
              </div>
            )}

            {/* ============================================================== */}
            {/* MODULE 3: DATABASES (.dbc / .kcd in Cloud Project)             */}
            {/* ============================================================== */}
            {activeModule === 'databases' && (
              <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3.5 text-[11px]">
                <section className="rounded-[2px] border border-hairline bg-surface">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline bg-elevated px-3.5 py-2">
                    <div className="flex items-center gap-2">
                      <Database className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
                      <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-ink">
                        {t('cloud.db.title', { count: cloudDbEntries.length })}
                      </span>
                      {loadingCloudDbs && (
                        <span className="font-mono text-[10px] text-muted">{t('cloud.db.loading')}</span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          if (!stagedWorkspace) return;
                          const existing = stagedWorkspace.databases.customFiles;
                          const byName = new Map(
                            existing.map((f) => [f.fileName.trim().toLowerCase(), f]),
                          );
                          for (const d of dbState.databases) {
                            byName.set(d.fileName.trim().toLowerCase(), {
                              fileName: d.fileName,
                              contentBase64: d.contentBase64,
                              sizeBytes: d.sizeBytes,
                            });
                          }
                          setStagedWorkspace({
                            ...stagedWorkspace,
                            databases: {
                              ...stagedWorkspace.databases,
                              usePresetDb: false,
                              customFiles: Array.from(byName.values()),
                            },
                          });
                          onStatusMessage({
                            kind: 'success',
                            message: t('cloud.status.dbsAddedToStaged', { count: dbState.databases.length }),
                          });
                        }}
                        disabled={!stagedWorkspace || dbState.databases.length === 0}
                        className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-[10px] font-semibold uppercase text-ink hover:border-strong disabled:opacity-50"
                      >
                        <CloudUpload className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
                        {t('cloud.db.addLocalCatalog', { count: dbState.databases.length })}
                      </button>
                      <button
                        type="button"
                        disabled={busyAction === 'push'}
                        onClick={() => void handlePushToCloud()}
                        className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] px-3 font-mono text-[10px] font-semibold uppercase text-white disabled:opacity-50"
                        style={{ backgroundColor: 'var(--status-focus)' }}
                      >
                        {t('cloud.db.saveChanges')}
                      </button>
                    </div>
                  </div>

                  {cloudDbError && (
                    <div className="px-3.5 py-2 font-mono text-[10px]" style={{ color: 'var(--status-warn)' }}>
                      {t('cloud.db.registryError', { error: cloudDbError })}
                    </div>
                  )}

                  {cloudDbEntries.length === 0 ? (
                    <div className="px-4 py-8 text-center font-mono text-xs text-muted">
                      {loadingCloudDbs
                        ? t('cloud.db.loadingLong')
                        : t('cloud.db.empty')}
                    </div>
                  ) : (
                    <table className="w-full border-collapse text-left text-xs">
                      <thead>
                        <tr className="border-b border-hairline bg-elevated font-mono text-[10px] uppercase tracking-wider text-muted">
                          <th className="py-2 px-3">{t('cloud.db.thFormat')}</th>
                          <th className="py-2 px-3">{t('cloud.db.thDbFile')}</th>
                          <th className="py-2 px-3">{t('cloud.db.thBusAssign')}</th>
                          <th className="py-2 px-3 text-right">{t('cloud.db.thStats')}</th>
                          <th className="py-2 px-3 text-right">{t('cloud.db.thActions')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-hairline">
                        {cloudDbEntries.map((entry) => {
                          const fileKey = entry.version.fileName.trim().toLowerCase();
                          const rawFile = (stagedWorkspace?.databases?.customFiles ?? []).find(
                            (f) => f.fileName.trim().toLowerCase() === fileKey,
                          );
                          const inLocalCatalog = dbState.databases.some(
                            (d) => d.fileName.trim().toLowerCase() === fileKey,
                          );
                          return (
                            <tr key={entry.db.id} className="hover:bg-hover/60">
                              <td className="py-2 px-3">
                                <span className="rounded-[2px] border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-focus">
                                  .{entry.db.format}
                                </span>
                              </td>
                              <td className="py-2 px-3">
                                <div className="font-semibold text-ink">{entry.db.name}</div>
                                <div className="font-mono text-[10px] text-muted">
                                  {entry.version.fileName} · {entry.version.versionLabel}
                                </div>
                              </td>
                              <td className="py-2 px-3 font-mono tabular-nums text-muted">
                                {entry.db.busAssignment}
                              </td>
                              <td className="py-2 px-3 text-right font-mono tabular-nums text-ink">
                                {entry.schema.messages.length} / {entry.schema.signals.length} /{' '}
                                {entry.schema.ecus.length}
                              </td>
                              <td className="py-2 px-3 text-right">
                                <button
                                  type="button"
                                  disabled={!rawFile || inLocalCatalog}
                                  title={
                                    rawFile
                                      ? t('cloud.db.addTooltip')
                                      : t('cloud.db.noContentTooltip')
                                  }
                                  onClick={() => {
                                    if (!rawFile) return;
                                    databaseStore.upsertDatabaseEntry({
                                      id: makeCatalogDbId(rawFile.fileName),
                                      name: rawFile.fileName.replace(/\.[^/.]+$/, ''),
                                      fileName: rawFile.fileName,
                                      format: entry.db.format,
                                      contentBase64: rawFile.contentBase64,
                                      sizeBytes:
                                        rawFile.sizeBytes ??
                                        Math.round((rawFile.contentBase64.length * 3) / 4),
                                      uploadedAt: new Date().toISOString(),
                                      schema: entry.schema,
                                    });
                                    onStatusMessage({
                                      kind: 'success',
                                      message: t('cloud.status.dbAddedToDesktop', { name: rawFile.fileName }),
                                    });
                                  }}
                                  className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-elevated px-2 font-mono text-[10px] font-semibold text-ink hover:border-strong disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  <CloudDownload className="h-3 w-3 text-focus" aria-hidden="true" />
                                  {inLocalCatalog ? t('cloud.db.inCatalog') : t('cloud.db.addToCatalog')}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </section>

                {/* Staged workspace-embedded files (synced via .nexusproj.json) */}
                <section className="rounded-[2px] border border-hairline bg-surface">
                  <div className="border-b border-hairline bg-elevated px-3.5 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-ink">
                    {t('cloud.db.embeddedFiles', { count: (stagedWorkspace?.databases?.customFiles ?? []).length })}
                  </div>
                  <div className="divide-y divide-hairline">
                    {(stagedWorkspace?.databases?.customFiles ?? []).map((file, idx) => (
                      <div
                        key={`${file.fileName}-${idx}`}
                        className="flex items-center justify-between px-3.5 py-1.5 font-mono text-[11px]"
                      >
                        <span className="text-ink">{file.fileName}</span>
                        <span className="ml-auto mr-3 tabular-nums text-muted">
                          {((file.sizeBytes ?? (file.contentBase64.length * 3) / 4) / 1024).toFixed(1)} KB
                        </span>
                        <button
                          type="button"
                          aria-label={t('cloud.db.removeEmbeddedAria', { file: file.fileName })}
                          onClick={() => {
                            if (!stagedWorkspace) return;
                            const remaining = stagedWorkspace.databases.customFiles.filter(
                              (_, i) => i !== idx,
                            );
                            setStagedWorkspace({
                              ...stagedWorkspace,
                              databases: { ...stagedWorkspace.databases, customFiles: remaining },
                            });
                          }}
                          className="cursor-pointer"
                          style={{ color: 'var(--status-critical)' }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {/* ============================================================== */}
            {/* MODULE 4: CONNECTIONS PROFILES                                 */}
            {/* ============================================================== */}
            {activeModule === 'connections' && (
              <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3.5 text-[11px]">
                <div
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="p-3 border space-y-3 rounded-[2px]"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[13px] text-[var(--text-primary)]">
                      {t('cloud.conn.title', { count: (stagedWorkspace?.connections?.profiles ?? []).length })}
                    </span>
                    <button
                      type="button"
                      disabled={busyAction === 'push'}
                      onClick={() => void handlePushToCloud()}
                      style={{
                        backgroundColor: 'rgba(6, 182, 212, 0.18)',
                        borderColor: 'rgba(6, 182, 212, 0.60)',
                      }}
                      className="h-[24px] px-2.5 border font-semibold text-cyan-300 hover:opacity-90 cursor-pointer disabled:opacity-50"
                    >
                      {t('cloud.conn.saveChanges')}
                    </button>
                  </div>

                  <table className="pcan-grid w-full text-[11px] font-mono tabular-nums">
                    <thead>
                      <tr>
                        <th className="font-sans">{t('cloud.conn.thBus')}</th>
                        <th className="font-sans">{t('cloud.conn.thName')}</th>
                        <th className="font-sans">{t('cloud.conn.thDriver')}</th>
                        <th className="font-sans">{t('cloud.conn.thDevice')}</th>
                        <th className="font-sans">{t('cloud.conn.thBitrate')}</th>
                        <th className="font-sans" style={{ width: '40px' }} />
                      </tr>
                    </thead>
                    <tbody>
                      {(stagedWorkspace?.connections?.profiles ?? []).map((prof, idx) => (
                        <tr key={prof.id || idx}>
                          <td>Bus {prof.busId + 1}</td>
                          <td className="font-sans font-medium text-[var(--text-primary)]">
                            {prof.name}
                          </td>
                          <td>{prof.driverFamily}</td>
                          <td>{prof.deviceId || prof.adapterChannel}</td>
                          <td>
                            {prof.bitrate / 1000}k
                            {prof.enableFd ? ` / ${prof.dataBitrate / 1000000}M FD` : ' CC'}
                          </td>
                          <td>
                            <button
                              type="button"
                              onClick={() => {
                                if (!stagedWorkspace) return;
                                const rem = stagedWorkspace.connections.profiles.filter(
                                  (_, i) => i !== idx,
                                );
                                setStagedWorkspace({
                                  ...stagedWorkspace,
                                  connections: { ...stagedWorkspace.connections, profiles: rem },
                                });
                              }}
                              className="text-red-400 hover:text-red-300"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ============================================================== */}
            {/* MODULE 5: TX & PLOTTER CONFIGURATION                           */}
            {/* ============================================================== */}
            {activeModule === 'tx_plotter' && (
              <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3.5 text-[11px]">
                <div
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="p-3 border space-y-3 rounded-[2px]"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[13px] text-[var(--text-primary)]">
                      {t('cloud.tx.title', { count: (stagedWorkspace?.transmitList?.entries ?? []).length })}
                    </span>
                    <button
                      type="button"
                      disabled={busyAction === 'push'}
                      onClick={() => void handlePushToCloud()}
                      style={{
                        backgroundColor: 'rgba(6, 182, 212, 0.18)',
                        borderColor: 'rgba(6, 182, 212, 0.60)',
                      }}
                      className="h-[24px] px-2.5 border font-semibold text-cyan-300 hover:opacity-90 cursor-pointer disabled:opacity-50"
                    >
                      {t('cloud.tx.saveChanges')}
                    </button>
                  </div>

                  <table className="pcan-grid w-full text-[11px] font-mono tabular-nums">
                    <thead>
                      <tr>
                        <th className="font-sans">{t('cloud.tx.thBus')}</th>
                        <th className="font-sans">{t('cloud.tx.thCanId')}</th>
                        <th className="font-sans">{t('cloud.tx.thSymbol')}</th>
                        <th className="font-sans">{t('cloud.tx.thDlc')}</th>
                        <th className="font-sans">{t('cloud.tx.thCycle')}</th>
                        <th className="font-sans" style={{ width: '40px' }} />
                      </tr>
                    </thead>
                    <tbody>
                      {(stagedWorkspace?.transmitList?.entries ?? []).map((e, idx) => (
                        <tr key={e.id || idx}>
                          <td>Bus {e.busId + 1}</td>
                          <td className="text-cyan-400">
                            0x{e.arbId.toString(16).toUpperCase()}
                          </td>
                          <td className="font-sans">{e.symbolName}</td>
                          <td>{e.dlc}</td>
                          <td>{e.cycleTimeMs} ms</td>
                          <td>
                            <button
                              type="button"
                              onClick={() => {
                                if (!stagedWorkspace) return;
                                const rem = stagedWorkspace.transmitList.entries.filter(
                                  (_, i) => i !== idx,
                                );
                                setStagedWorkspace({
                                  ...stagedWorkspace,
                                  transmitList: { entries: rem },
                                });
                              }}
                              className="text-red-400 hover:text-red-300"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ============================================================== */}
            {/* MODULE 6: DIFF, PUSH & PULL & RAW JSON                         */}
            {/* ============================================================== */}
            {activeModule === 'sync_diff' && (
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                {/* Diff Sub-Header */}
                <div
                  style={{
                    backgroundColor: 'var(--bg-header)',
                    borderBottom: '1px solid var(--border-grid)',
                  }}
                  className="h-[28px] px-3 flex items-center justify-between text-[11px] shrink-0"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-[var(--text-secondary)]">
                      {diffSubMode === 'diff' ? t('cloud.diff.diffTitle') : t('cloud.diff.rawJsonTitle')}
                    </span>
                    <span className="font-mono text-[9px] text-[var(--text-muted)]">
                      {t('cloud.diff.hashes', { local: localHash, staged: stagedHash, cloud: cloudHash })}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 font-mono text-[10px]">
                    <button
                      type="button"
                      onClick={() => setDiffSubMode('diff')}
                      className={`px-2 py-0.5 border cursor-pointer ${
                        diffSubMode === 'diff'
                          ? 'border-cyan-500/50 text-cyan-400 bg-cyan-950/20'
                          : 'border-transparent text-[var(--text-secondary)]'
                      }`}
                    >
                      {t('cloud.diff.tabDiff')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDiffSubMode('json')}
                      className={`px-2 py-0.5 border cursor-pointer ${
                        diffSubMode === 'json'
                          ? 'border-cyan-500/50 text-cyan-400 bg-cyan-950/20'
                          : 'border-transparent text-[var(--text-secondary)]'
                      }`}
                    >
                      {t('cloud.diff.tabJson')}
                    </button>
                  </div>
                </div>

                {/* Diff Table or JSON Editor */}
                <div className="flex-1 min-h-0 overflow-y-auto p-3">
                  {diffSubMode === 'diff' ? (
                    <div className="space-y-3">
                      {(
                        Object.entries(diffReport.sections) as [
                          WorkspaceSectionKey,
                          (typeof diffReport.sections)[WorkspaceSectionKey],
                        ][]
                      ).map(([secKey, secDiff]) => {
                        const pick = sectionPicks[secKey];
                        return (
                          <div
                            key={secKey}
                            style={{
                              backgroundColor: 'var(--bg-panel)',
                              borderColor: 'var(--border-strong)',
                            }}
                            className="border rounded-[2px] overflow-hidden"
                          >
                            <div className="px-2.5 py-1.5 bg-[var(--bg-header)] border-b border-[var(--border-strong)] flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-[11px]">{secDiff.title}</span>
                                <span
                                  className={`px-1.5 py-0.2 font-mono text-[9px] font-bold uppercase rounded-[2px] ${
                                    secDiff.status === 'identical'
                                      ? 'bg-emerald-500/20 text-emerald-400'
                                      : 'bg-amber-500/20 text-amber-400'
                                  }`}
                                >
                                  {secDiff.status === 'identical' ? t('cloud.diff.identical') : t('cloud.diff.different')}
                                </span>
                              </div>

                              {secDiff.status !== 'identical' && (
                                <div className="flex items-center gap-1 font-mono text-[9px]">
                                  <button
                                    type="button"
                                    onClick={() => handleToggleSectionPick(secKey, 'local')}
                                    className={`px-1.5 py-0.5 border cursor-pointer ${
                                      pick === 'local'
                                        ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300 font-bold'
                                        : 'border-[var(--border-strong)] text-[var(--text-muted)]'
                                    }`}
                                  >
                                    {t('cloud.diff.pickLocal')}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleToggleSectionPick(secKey, 'cloud')}
                                    className={`px-1.5 py-0.5 border cursor-pointer ${
                                      pick === 'cloud'
                                        ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300 font-bold'
                                        : 'border-[var(--border-strong)] text-[var(--text-muted)]'
                                    }`}
                                  >
                                    {t('cloud.diff.pickCloud')}
                                  </button>
                                </div>
                              )}
                            </div>

                            <table className="pcan-grid w-full text-[10px] font-mono tabular-nums">
                              <tbody>
                                {secDiff.rows.map((row, rIdx) => (
                                  <tr
                                    key={rIdx}
                                    className={
                                      row.changeKind !== 'identical' ? 'bg-amber-500/5' : undefined
                                    }
                                  >
                                    <td className="w-[180px] font-sans font-medium text-[var(--text-secondary)]">
                                      {row.label}
                                    </td>
                                    <td>{row.localSummary}</td>
                                    <td>{row.cloudSummary}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <textarea
                      value={rawJsonText}
                      onChange={(e) => {
                        setRawJsonText(e.target.value);
                        try {
                          const parsed = JSON.parse(e.target.value);
                          const norm = validateAndNormalizeWorkspaceJson(parsed);
                          if (norm.ok) {
                            setStagedWorkspace(norm.project);
                            setRawJsonError(null);
                          } else {
                            setRawJsonError(norm.error);
                          }
                        } catch (err) {
                          setRawJsonError(err instanceof Error ? err.message : 'Invalid JSON');
                        }
                      }}
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor: rawJsonError ? '#EF4444' : 'var(--border-strong)',
                        color: 'var(--text-primary)',
                      }}
                      className="w-full h-full p-2.5 font-mono text-[11px] border focus:outline-none resize-none"
                    />
                  )}
                </div>

                {/* Diff Action Bar */}
                <div
                  style={{
                    backgroundColor: 'var(--bg-toolbar)',
                    borderTop: '1px solid var(--border-strong)',
                  }}
                  className="p-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] shrink-0"
                >
                  <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                    <input
                      type="text"
                      placeholder={t('cloud.diff.commitPlaceholder')}
                      value={commitMessage}
                      onChange={(e) => setCommitMessage(e.target.value)}
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor: 'var(--border-strong)',
                      }}
                      className="flex-1 h-[24px] px-2 border text-[11px] focus:outline-none"
                    />

                    <label className="flex items-center gap-1 cursor-pointer text-[10px] shrink-0">
                      <input
                        type="checkbox"
                        checked={bindLocalOnPush}
                        onChange={(e) => setBindLocalOnPush(e.target.checked)}
                      />
                      <span>{t('cloud.diff.bindLocal')}</span>
                    </label>

                    <label className="flex items-center gap-1 cursor-pointer text-[10px] shrink-0">
                      <input
                        type="checkbox"
                        checked={forcePush}
                        onChange={(e) => setForcePush(e.target.checked)}
                      />
                      <span>{t('cloud.diff.forcePush')}</span>
                    </label>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={busyAction === 'push'}
                      onClick={() => void handlePushToCloud()}
                      style={{
                        backgroundColor: 'rgba(6, 182, 212, 0.18)',
                        borderColor: 'rgba(6, 182, 212, 0.65)',
                      }}
                      className="h-[26px] px-3 border font-semibold text-cyan-300 hover:opacity-90 cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <CloudUpload className="w-3.5 h-3.5" />
                      <span>{busyAction === 'push' ? t('cloud.diff.pushing') : t('cloud.diff.pushBtn')}</span>
                    </button>

                    <button
                      type="button"
                      disabled={busyAction === 'pull'}
                      onClick={() => void handlePullToDesktop()}
                      style={{
                        backgroundColor: 'rgba(16, 185, 129, 0.15)',
                        borderColor: 'rgba(16, 185, 129, 0.55)',
                      }}
                      className="h-[26px] px-3 border font-semibold text-emerald-300 hover:opacity-90 cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <CloudDownload className="w-3.5 h-3.5" />
                      <span>{t('cloud.diff.pullBtn')}</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
