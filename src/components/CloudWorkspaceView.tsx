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
  const cloudState = useCloudBridgeStore();
  const cloudHeader = useCloudBridgeHeader();
  const projState = useProjectStore();
  const dbState = useDatabaseStore();
  const simState = useSimulationPanelStore();

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
        message: 'NexusCANCloud oturumu başarıyla açıldı.',
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
        message: 'NexusCANCloud oturumu kapatıldı.',
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
        message: `Cloud projesi "${created.name}" başarıyla oluşturuldu.`,
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: `Proje oluşturulamadı: ${err instanceof Error ? err.message : String(err)}`,
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
        message: `"${inspectedProject.name}" masaüstüne aktarıldı (Saha Güvenliği: Listen-Only modunda açıldı).`,
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: `Masaüstüne çekme başarısız: ${err instanceof Error ? err.message : String(err)}`,
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
        message: `Çalışma alanı Cloud'a başarıyla gönderildi (Rev #${res.revisionNumber}).`,
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: `Cloud'a gönderme hatası: ${err instanceof Error ? err.message : String(err)}`,
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
            message: `Cloud Sync tamamlandı: [${target.code}] Proje ve güncel paneller buluttan eşitlendi.`,
          });
        } else if (activeModule === 'databases') {
          onStatusMessage({
            kind: 'success',
            message: `Cloud Sync tamamlandı: [${target.code}] Veritabanları buluttan eşitlendi.`,
          });
        } else if (activeModule === 'sync_diff' || activeModule === 'overview') {
          const revNum = cloudBridgeStore.getState().remoteRevisionNumber;
          onStatusMessage({
            kind: 'success',
            message: `Cloud Sync tamamlandı: [${target.code}] Çalışma alanı #${revNum ?? 'son'} eşitlendi.`,
          });
        } else {
          onStatusMessage({
            kind: 'success',
            message: `Cloud Sync tamamlandı: [${target.code}] Proje ve tüm alt modüller eşitlendi.`,
          });
        }
      } else {
        onStatusMessage({
          kind: 'success',
          message: `Cloud Sync tamamlandı: ${projects.length} proje listesi güncellendi.`,
        });
      }
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Cloud senkronizasyonu başarısız.',
      });
    } finally {
      setIsSyncingCloud(false);
    }
  }, [activeModule, isSyncingCloud, onStatusMessage]);

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
          message: `"${panel.name}" buluta kaydedildi.`,
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
          message: `"${created.name}" bulutta oluşturuldu.`,
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
          message: `Panel "${newName}" olarak adlandırıldı.`,
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
          message: 'Panel buluttan silindi.',
        });
      },
      onPullPanelToLocal: (panel: SimulationPanelDto) => {
        simulationPanelStore.upsertPanelFromCloud(panel);
        onStatusMessage({
          kind: 'success',
          message: `"${panel.name}" masaüstüne aktarıldı.`,
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
      message: `Canlı yayın durduruldu (${projName}). Cloud oturumu açık kalmaya devam ediyor.`,
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
        className="flex-1 min-h-0 flex items-center justify-center p-6 select-none"
      >
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
                  NexusCANCloud Oturumu Aç
                </span>
                <span className="text-[11px] text-[var(--text-secondary)]">
                  Mühendislik Düzeyi Canlı Telemetri & Çalışma Alanı
                </span>
              </div>
            </div>

            {authError && (
              <div className="p-2 border border-red-500/40 bg-red-950/20 text-red-400 text-[11px] font-medium rounded-[2px]">
                {authError}
              </div>
            )}

            <form onSubmit={(e) => void handleLoginSubmit(e)} className="space-y-3 text-[11px]">
              <div>
                <label className="block text-[10px] text-[var(--text-secondary)] mb-0.5">
                  Sunucu URL
                </label>
                <input
                  type="text"
                  value={authBaseUrl}
                  onChange={(e) => setAuthBaseUrl(e.target.value)}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="w-full h-[26px] px-2 border font-mono text-[11px] focus:outline-none"
                />
              </div>

              {isRegisterMode && (
                <div>
                  <label className="block text-[10px] text-[var(--text-secondary)] mb-0.5">
                    Ad Soyad
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
                    className="w-full h-[26px] px-2 border text-[11px] focus:outline-none"
                  />
                </div>
              )}

              <div>
                <label className="block text-[10px] text-[var(--text-secondary)] mb-0.5">
                  E-Posta
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
                  className="w-full h-[26px] px-2 border text-[11px] focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[10px] text-[var(--text-secondary)] mb-0.5">
                  Parola
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
                  className="w-full h-[26px] px-2 border text-[11px] focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={authBusy}
                style={{
                  backgroundColor: 'rgba(6, 182, 212, 0.18)',
                  borderColor: 'rgba(6, 182, 212, 0.65)',
                }}
                className="w-full h-[28px] border flex items-center justify-center gap-1.5 text-[11px] font-semibold text-cyan-300 hover:opacity-90 cursor-pointer disabled:opacity-50"
              >
                {authBusy ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Cloud className="w-3.5 h-3.5 text-cyan-400" />
                )}
                <span>
                  {authBusy
                    ? 'Bağlanıyor...'
                    : isRegisterMode
                      ? 'Hesap Oluştur ve Oturum Aç'
                      : 'Oturum Aç & Bağlan'}
                </span>
              </button>
            </form>

            <div className="pt-2 border-t border-[var(--border-strong)] flex items-center justify-between text-[11px] text-[var(--text-secondary)]">
              <span>{isRegisterMode ? 'Mevcut hesabınız var mı?' : 'Hesabınız yok mu?'}</span>
              <button
                type="button"
                onClick={() => {
                  setIsRegisterMode(!isRegisterMode);
                  setAuthError(null);
                }}
                className="text-cyan-400 hover:underline cursor-pointer font-medium"
              >
                {isRegisterMode ? 'Giriş Yap' : 'Kayıt Ol'}
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
                Bulut Telemetrisi & Paylaşımlı Paneller
              </span>
              <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                NexusCANCloud; masaüstü `.nexusproj.json` çalışma alanlarınızı,
                CAN bağlantı profillerinizi, TX mesaj şablonlarınızı ve etkileşimli
                simülasyon panellerinizi ekibinizle çift yönlü eşitler.
              </p>

              <div className="space-y-2 pt-1">
                <div className="flex items-center gap-2">
                  <LayoutGrid className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span>
                    <strong>Paylaşımlı Paneller:</strong> Sanal enstrüman ve simülasyon
                    panellerini bulutta saklayın ve doğrudan sekme içinden çalıştırın.
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Radio className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>
                    <strong>Canlı Telemetri:</strong> 20–60Hz hızla yerel CAN hattını
                    tarayıcıdaki ekibe canlı yayınlayın.
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Lock className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>
                    <strong>Saha Güvenliği:</strong> Çekilen projeler her zaman Listen-Only
                    modunda açılır, fiziksel hatta asla izinsiz paket basılmaz.
                  </span>
                </div>
              </div>
            </div>

            <div className="text-[10px] text-[var(--text-muted)] font-mono">
              Version 0.1.0 • Desktop Client
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
      {/* 1. TOP CLOUD STATUS TOOLBAR (34px)                                   */}
      {/* ==================================================================== */}
      <div
        style={{
          backgroundColor: 'var(--bg-toolbar)',
          borderBottom: '1px solid var(--border-strong)',
        }}
        className="h-[34px] px-3 flex items-center justify-between gap-2 shrink-0 text-[11px]"
      >
        {/* Left: Server Status & Organization Selector */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 font-semibold text-cyan-400 shrink-0">
            <Cloud className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">NexusCANCloud</span>
          </div>

          <div className="h-3 w-px bg-[var(--border-strong)] shrink-0" />

          {/* Org Selector */}
          <div className="flex items-center gap-1">
            <Building2 className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <select
              value={cloudState.selectedOrgId ?? ''}
              onChange={(e) => cloudBridgeStore.selectOrganization(e.target.value)}
              style={{
                backgroundColor: 'var(--bg-input)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              className="h-[22px] px-1.5 border text-[11px] cursor-pointer max-w-[150px] truncate focus:outline-none"
              title="Aktif Organizasyon"
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
            <div className="flex items-center gap-1 text-[10px] font-mono font-semibold px-2 py-0.5 border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 rounded-[2px] shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>LIVE • {cloudHeader.targetHz}Hz</span>
            </div>
          ) : (
            <div className="flex items-center gap-1 text-[10px] font-mono text-[var(--text-muted)] px-1.5 py-0.5 border border-[var(--border-strong)] rounded-[2px] shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
              <span>{isBridgeActive ? 'BAĞLANIYOR…' : 'OFFLINE'}</span>
            </div>
          )}
          {isBridgeActive ? (
            <button
              type="button"
              onClick={handleStopLiveStream}
              title="Canlı telemetri yayınını kapat (Cloud oturumu açık kalır)"
              className="h-[22px] px-2 border text-[10px] font-mono font-semibold cursor-pointer flex items-center gap-1 shrink-0 hover:opacity-90"
              style={{ borderColor: 'var(--status-critical)', color: 'var(--status-critical)' }}
            >
              <Square className="w-3 h-3" />
              YAYINI KAPAT
            </button>
          ) : (
            cloudState.selectedProjectId && (
              <button
                type="button"
                onClick={() => void cloudBridgeStore.resumeLiveStream()}
                title={`Canlı yayını ${cloudState.selectedProjectName ?? 'seçili projeye'} yeniden başlat`}
                className="h-[22px] px-2 border text-[10px] font-mono font-semibold cursor-pointer flex items-center gap-1 shrink-0 hover:opacity-90"
                style={{ borderColor: 'var(--status-nominal)', color: 'var(--status-nominal)' }}
              >
                <Play className="w-3 h-3" />
                YAYINI BAŞLAT
              </button>
            )
          )}
        </div>

        {/* Right: User / Rate / Web Link / Logout */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="hidden lg:flex items-center gap-1 text-[10px] font-mono text-[var(--text-secondary)]">
            <span>Hız:</span>
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
              className="h-[20px] px-1 border text-[10px] cursor-pointer focus:outline-none"
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
            className="h-[22px] px-2 border flex items-center gap-1 text-[10px] font-semibold text-cyan-400 hover:bg-cyan-500/20 cursor-pointer"
            title="WebCAN Canlı Görünümünü Aç"
          >
            <ExternalLink className="w-3 h-3" />
            <span className="hidden md:inline">Web Arayüzü ↗</span>
          </a>

          <button
            type="button"
            disabled={isSyncingCloud}
            onClick={() => void handleDeepCloudSync()}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
            }}
            className="h-[22px] px-2 border flex items-center gap-1.5 text-[10px] hover:border-cyan-500/50 hover:text-cyan-400 cursor-pointer disabled:opacity-50"
            title="Tüm Cloud projelerini ve seçili projeyi derinlemesine eşitle"
          >
            <RefreshCw className={`w-3 h-3 text-[var(--text-secondary)] ${isSyncingCloud ? 'animate-spin text-cyan-400' : ''}`} />
            <span className="font-semibold text-cyan-400">Cloud Sync</span>
            {lastSyncedAt && (
              <span className="hidden md:inline font-mono tabular-nums text-[9px] text-[var(--text-muted)]">
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
            className="hidden md:flex items-center gap-1.5 px-2 h-[22px] border text-[10px] font-mono tabular-nums text-slate-300 shrink-0"
            title={`Oturum: ${cloudState.userFullName || cloudState.userEmail}`}
          >
            <span className="truncate max-w-[120px] text-slate-200">
              {cloudState.userFullName || cloudState.userEmail}
            </span>
            {activeOrg && (
              <span className="px-1 py-0.2 rounded bg-cyan-950/70 border border-cyan-800/60 text-cyan-300 text-[9px] flex items-center gap-1">
                <Building2 className="w-2.5 h-2.5 text-cyan-400 shrink-0" />
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
            className="h-[22px] px-2 border flex items-center gap-1 text-[10px] text-red-400 hover:border-red-500 cursor-pointer"
            title="NexusCANCloud Oturumunu Kapat"
          >
            <LogOut className="w-3 h-3" />
            <span className="hidden sm:inline">Çıkış Yap</span>
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
              <span>Cloud Projeleri ({filteredProjects.length})</span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={isSyncingCloud}
                  onClick={() => void handleDeepCloudSync()}
                  className="text-[var(--text-muted)] hover:text-cyan-400 cursor-pointer flex items-center p-0.5 rounded-[2px]"
                  title="Projeleri ve Aktif Projeyi Eşitle"
                >
                  <RefreshCw className={`w-3 h-3 ${isSyncingCloud ? 'animate-spin text-cyan-400' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={() => setNewProjectOpen(!newProjectOpen)}
                  className="text-cyan-400 hover:underline cursor-pointer flex items-center gap-0.5 text-[10px]"
                >
                  <Plus className="w-3 h-3" />
                  <span>Yeni</span>
                </button>
              </div>
            </div>

            <div className="relative">
              <Search className="w-3 h-3 text-[var(--text-muted)] absolute left-2 top-1.5 pointer-events-none" />
              <input
                type="text"
                placeholder="Proje ara..."
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
                <span>+ Yeni Cloud Projesi</span>
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
                  Proje Adı
                </label>
                <input
                  type="text"
                  required
                  placeholder="EV Inverter Bench 01"
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
                    Proje Kodu
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
                    Protokol
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
                  <span>Mevcut yerel çalışma alanını şablon olarak yükle</span>
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
                {busyAction === 'create_project' ? 'Oluşturuluyor...' : 'Projeyi Oluştur'}
              </button>
            </form>
          )}

          {/* Project List */}
          <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-[var(--border-grid)]">
            {filteredProjects.length === 0 ? (
              <div className="p-4 text-center text-[10px] text-[var(--text-muted)] italic">
                Bulut projesi bulunamadı. "+ Yeni" ile oluşturabilirsiniz.
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
                            LIVE
                          </span>
                        )}
                        {isLinked && (
                          <span className="px-1 rounded-[2px] bg-cyan-500/20 text-cyan-400 font-bold text-[9px]">
                            LINKED
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
                Proje Seçilmedi
              </h3>
              <p className="text-[11px] text-[var(--text-secondary)] max-w-sm">
                İçine girip panellerini, canlı telemetri köprüsünü, veritabanlarını ve
                CAN ayarlarını yönetmek için sol listeden bir proje seçin.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {/* 30px Navigation Bar & Quick Actions */}
            <div
              style={{
                backgroundColor: 'var(--bg-toolbar)',
                borderBottom: '1px solid var(--border-strong)',
              }}
              className="h-[30px] px-3 flex items-center justify-between gap-2 shrink-0 text-[11px]"
            >
              {/* Breadcrumbs & Module Buttons */}
              <div className="flex items-center gap-1 min-w-0 overflow-x-auto no-scrollbar">
                <span className="font-mono text-[10px] font-bold text-cyan-400 shrink-0">
                  [{inspectedProject.code}]
                </span>
                <span className="font-semibold text-[var(--text-primary)] truncate max-w-[140px] shrink-0">
                  {inspectedProject.name}
                </span>
                {cloudState.remoteRevisionNumber !== null && (
                  <span className="font-mono text-[9px] text-[var(--text-muted)] shrink-0">
                    #Rev{cloudState.remoteRevisionNumber}
                  </span>
                )}

                <ChevronRight className="w-3 h-3 text-[var(--text-muted)] shrink-0" />

                {/* Module Selector Buttons */}
                <div className="flex items-center gap-0.5 shrink-0">
                  {[
                    { id: 'overview', label: 'Genel Bakış', icon: Grid },
                    { id: 'panels', label: `Paneller (${cloudPanels.length})`, icon: LayoutGrid },
                    { id: 'live_bridge', label: 'Canlı Köprü', icon: Radio },
                    { id: 'databases', label: 'Veritabanları', icon: Database },
                    { id: 'connections', label: 'Bağlantılar', icon: Cable },
                    { id: 'tx_plotter', label: 'TX & Plotter', icon: Send },
                    { id: 'sync_diff', label: 'Diff & Sync', icon: GitCompare },
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
                        className={`h-[22px] px-2 border flex items-center gap-1 rounded-[2px] cursor-pointer text-[10px] font-medium transition-colors ${
                          isActive ? 'border-cyan-500/50 text-cyan-300 font-semibold' : 'hover:text-[var(--text-primary)]'
                        }`}
                      >
                        <IconComp className="w-3 h-3 shrink-0" />
                        <span>{m.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  disabled={isSyncingCloud}
                  onClick={() => void handleDeepCloudSync()}
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="h-[22px] px-2 border flex items-center gap-1 text-[10px] text-[var(--text-secondary)] hover:text-cyan-400 hover:border-cyan-500/50 cursor-pointer disabled:opacity-50"
                  title="Bu projeyi ve altındaki tüm modülleri (Paneller, DB, vb.) Cloud'dan eşitle"
                >
                  <RefreshCw className={`w-3 h-3 ${isSyncingCloud ? 'animate-spin text-cyan-400' : ''}`} />
                  <span className="hidden sm:inline">Eşitle / Yenile</span>
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
                  className="h-[22px] px-2.5 border flex items-center gap-1 text-[10px] font-semibold text-cyan-400 hover:bg-cyan-500/20 cursor-pointer shrink-0 disabled:opacity-50"
                  title="Tüm Cloud projesini masaüstüne çek ve aç (Listen-Only güvenliğiyle)"
                >
                  <CloudDownload className="w-3 h-3" />
                  <span className="hidden sm:inline">Masaüstüne Çek & Aç</span>
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
                      {inspectedProject.description || 'Açıklama girilmemiş.'}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 font-mono text-[10px]">
                    <span className="text-[var(--text-muted)]">
                      Son Revizyon: <strong>#{cloudState.remoteRevisionNumber ?? 1}</strong>
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-[2px] font-bold ${
                        !diffReport.hasDifferences
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                      }`}
                    >
                      {!diffReport.hasDifferences ? 'Masaüstü ile Eşit' : 'Masaüstü ile Fark Var'}
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
                          Simülasyon Panelleri
                        </span>
                      </div>
                      <span className="font-mono text-[10px] px-1.5 py-0.2 bg-cyan-950/40 text-cyan-400 border border-cyan-500/30">
                        {cloudPanels.length} Panel
                      </span>
                    </div>

                    <p className="text-[11px] text-[var(--text-secondary)] line-clamp-2">
                      {cloudPanels.length > 0
                        ? cloudPanels.map((p) => p.name).join(', ')
                        : 'Kayıtlı enstrüman paneli yok. İçeri girip yeni panel oluşturabilirsiniz.'}
                    </p>

                    <div className="pt-2 border-t border-[var(--border-grid)] flex items-center justify-between text-[10px] text-cyan-400 font-semibold">
                      <span>Panelleri Aç & Çalıştır</span>
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
                          Canlı Telemetri Köprüsü
                        </span>
                      </div>
                      <span
                        className={`font-mono text-[10px] px-1.5 py-0.2 rounded-[2px] font-bold ${
                          isInspectedStreaming
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : 'bg-slate-700/30 text-[var(--text-muted)]'
                        }`}
                      >
                        {isInspectedStreaming ? 'CANLI YAYINDA' : 'PASİF'}
                      </span>
                    </div>

                    <p className="text-[11px] text-[var(--text-secondary)]">
                      {isInspectedStreaming
                        ? `${cloudState.sentSnapshotsCount} paket aktarıldı • RTT: ${cloudState.latencyMs}ms`
                        : 'Masaüstü CAN telemetrisini bu projeye 20–60Hz hızla yayınlayın.'}
                    </p>

                    <div className="pt-2 border-t border-[var(--border-grid)] flex items-center justify-between text-[10px] text-emerald-400 font-semibold">
                      <span>Yayın ve Kayıt Kontrolü</span>
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
                          Sembol Veritabanları
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-[var(--text-muted)]">
                        {(stagedWorkspace?.databases?.customFiles ?? []).length} Dosya
                      </span>
                    </div>

                    <p className="text-[11px] text-[var(--text-secondary)] line-clamp-2">
                      {stagedWorkspace?.databases?.usePresetDb ? 'Preset EV/BMS Aktif. ' : ''}
                      {(stagedWorkspace?.databases?.customFiles ?? []).length > 0
                        ? (stagedWorkspace?.databases?.customFiles ?? []).map((f) => f.fileName).join(', ')
                        : 'Gömülü DBC/KCD dosyası yok.'}
                    </p>

                    <div className="pt-2 border-t border-[var(--border-grid)] flex items-center justify-between text-[10px] text-cyan-400 font-semibold">
                      <span>DBC Dosyalarını Yönet</span>
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
                          CAN Bağlantıları
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-[var(--text-muted)]">
                        {(stagedWorkspace?.connections?.profiles ?? []).length} Profil
                      </span>
                    </div>

                    <p className="text-[11px] text-[var(--text-secondary)] line-clamp-2">
                      {(stagedWorkspace?.connections?.profiles ?? []).length > 0
                        ? (stagedWorkspace?.connections?.profiles ?? []).map((p) => p.name).join(', ')
                        : 'Kayıtlı bağlantı profili yok.'}
                    </p>

                    <div className="pt-2 border-t border-[var(--border-grid)] flex items-center justify-between text-[10px] text-cyan-400 font-semibold">
                      <span>Profilleri İncele & Düzenle</span>
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
                          TX & Plotter Ayarları
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-[var(--text-muted)]">
                        {(stagedWorkspace?.transmitList?.entries ?? []).length} TX
                      </span>
                    </div>

                    <p className="text-[11px] text-[var(--text-secondary)]">
                      {(stagedWorkspace?.transmitList?.entries ?? []).length} periyodik TX şablonu,{' '}
                      {(stagedWorkspace?.plotter?.watchedSignals ?? []).length} izlenen osiloskop sinyali.
                    </p>

                    <div className="pt-2 border-t border-[var(--border-grid)] flex items-center justify-between text-[10px] text-amber-400 font-semibold">
                      <span>Şablonları Düzenle</span>
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
                          Farklar & Senkronizasyon
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-[var(--text-muted)]">
                        6 Bölüm
                      </span>
                    </div>

                    <p className="text-[11px] text-[var(--text-secondary)]">
                      {diffReport.summaryText}
                    </p>

                    <div className="pt-2 border-t border-[var(--border-grid)] flex items-center justify-between text-[10px] text-emerald-400 font-semibold">
                      <span>Farkları İncele / Push / Pull</span>
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
                        Canlı Telemetri Köprüsü Durumu
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
                        ? `YAYINDA (${cloudState.targetHz} Hz)`
                        : 'BU PROJEYE YAYIN YAPILMIYOR'}
                    </span>
                  </div>

                  <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                    Masaüstünde bağlı SocketCAN, USB-CAN veya mock0 veriyolu çerçeveleri,
                    seçilen frekans kadansında NexusCANCloud sunucusuna güvenli salt-okunur
                    WebSocket akışıyla gönderilir.
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
                        <span>Canlı Yayını Bu Projeye Yönlendir & Başlat</span>
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
                          <span>Canlı Yayını Kapat</span>
                        </button>
                        <div className="flex items-center gap-2 font-mono text-[10px] tabular-nums text-emerald-400">
                          <span>Gönderilen Paketler: {cloudState.sentSnapshotsCount}</span>
                          <span>•</span>
                          <span>RTT Gecikme: {cloudState.latencyMs} ms</span>
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
                      <span>Tarayıcıda Canlı Görünüm ↗</span>
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
                    <strong>Salt-Okunur Saha Güvenliği (Listen-Only Mirror):</strong> NexusCANCloud
                    sunucusundan yerel masaüstü donanımına asla yetkisiz <code className="font-mono">TX</code> veya{' '}
                    <code className="font-mono">Arm Active Bus</code> komutu basılamaz.
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
                        CLOUD PROJE VERİTABANLARI ({cloudDbEntries.length})
                      </span>
                      {loadingCloudDbs && (
                        <span className="font-mono text-[10px] text-muted">YÜKLENİYOR...</span>
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
                            message: `${dbState.databases.length} yerel katalog dosyası Cloud çalışma alanına eklendi (kaydetmek için "Değişiklikleri Cloud'a Kaydet").`,
                          });
                        }}
                        disabled={!stagedWorkspace || dbState.databases.length === 0}
                        className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-[10px] font-semibold uppercase text-ink hover:border-strong disabled:opacity-50"
                      >
                        <CloudUpload className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
                        YEREL KATALOĞU PROJEYE EKLE ({dbState.databases.length})
                      </button>
                      <button
                        type="button"
                        disabled={busyAction === 'push'}
                        onClick={() => void handlePushToCloud()}
                        className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] px-3 font-mono text-[10px] font-semibold uppercase text-white disabled:opacity-50"
                        style={{ backgroundColor: 'var(--status-focus)' }}
                      >
                        Değişiklikleri Cloud&apos;a Kaydet
                      </button>
                    </div>
                  </div>

                  {cloudDbError && (
                    <div className="px-3.5 py-2 font-mono text-[10px]" style={{ color: 'var(--status-warn)' }}>
                      Cloud veritabanı kayıt defteri okunamadı: {cloudDbError}
                    </div>
                  )}

                  {cloudDbEntries.length === 0 ? (
                    <div className="px-4 py-8 text-center font-mono text-xs text-muted">
                      {loadingCloudDbs
                        ? 'VERİTABANLARI YÜKLENİYOR...'
                        : 'BU CLOUD PROJESİNDE HENÜZ .DBC / .KCD YOK.'}
                    </div>
                  ) : (
                    <table className="w-full border-collapse text-left text-xs">
                      <thead>
                        <tr className="border-b border-hairline bg-elevated font-mono text-[10px] uppercase tracking-wider text-muted">
                          <th className="py-2 px-3">FORMAT</th>
                          <th className="py-2 px-3">VERİTABANI & DOSYA</th>
                          <th className="py-2 px-3">HAT ATAMASI</th>
                          <th className="py-2 px-3 text-right">MSG / SİNYAL / ECU</th>
                          <th className="py-2 px-3 text-right">İŞLEMLER</th>
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
                                      ? 'Dosyayı masaüstü Databases kataloğuna ekle'
                                      : 'Ham dosya içeriği çalışma alanında yok'
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
                                      message: `"${rawFile.fileName}" masaüstü kataloğuna eklendi. Bağlantılar sekmesinden bir hatta bağlayabilirsiniz.`,
                                    });
                                  }}
                                  className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-elevated px-2 font-mono text-[10px] font-semibold text-ink hover:border-strong disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  <CloudDownload className="h-3 w-3 text-focus" aria-hidden="true" />
                                  {inLocalCatalog ? 'Katalogda' : 'Masaüstü Kataloğuna Ekle'}
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
                    ÇALIŞMA ALANINA GÖMÜLÜ DOSYALAR ({(stagedWorkspace?.databases?.customFiles ?? []).length})
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
                          aria-label={`${file.fileName} dosyasını çalışma alanından çıkar`}
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
                      Kayıtlı CAN / CAN-FD Bağlantı Profilleri (
                      {(stagedWorkspace?.connections?.profiles ?? []).length})
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
                      Değişiklikleri Cloud'a Kaydet
                    </button>
                  </div>

                  <table className="pcan-grid w-full text-[11px] font-mono tabular-nums">
                    <thead>
                      <tr>
                        <th className="font-sans">Bus</th>
                        <th className="font-sans">Profil Adı</th>
                        <th className="font-sans">Sürücü</th>
                        <th className="font-sans">Arayüz / Cihaz</th>
                        <th className="font-sans">Bitrate / FD</th>
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
                      TX Mesaj Şablonları ({(stagedWorkspace?.transmitList?.entries ?? []).length})
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
                      Değişiklikleri Cloud'a Kaydet
                    </button>
                  </div>

                  <table className="pcan-grid w-full text-[11px] font-mono tabular-nums">
                    <thead>
                      <tr>
                        <th className="font-sans">Bus</th>
                        <th className="font-sans">CAN ID</th>
                        <th className="font-sans">Sembol</th>
                        <th className="font-sans">DLC</th>
                        <th className="font-sans">Periyot (ms)</th>
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
                      {diffSubMode === 'diff' ? '6-Bölümlü Semantic Diff' : 'Ham JSON Editörü'}
                    </span>
                    <span className="font-mono text-[9px] text-[var(--text-muted)]">
                      Local: {localHash} • Staged: {stagedHash} • Cloud: {cloudHash}
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
                      Farklar (Diff)
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
                      Raw JSON
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
                                  {secDiff.status === 'identical' ? 'Eşit' : 'Farklı'}
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
                                    [Yereli Al]
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
                                    [Cloud'u Al]
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
                      placeholder="Commit mesajı girin..."
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
                      <span>Yerel Projeye Bağla</span>
                    </label>

                    <label className="flex items-center gap-1 cursor-pointer text-[10px] shrink-0">
                      <input
                        type="checkbox"
                        checked={forcePush}
                        onChange={(e) => setForcePush(e.target.checked)}
                      />
                      <span>Zorla Gönder (Force)</span>
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
                      <span>{busyAction === 'push' ? 'Gönderiliyor...' : 'Cloud\'a Gönder (Push)'}</span>
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
                      <span>Masaüstüne Çek (Pull)</span>
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
