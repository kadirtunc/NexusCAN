import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  ArrowLeftRight,
  Boxes,
  Building2,
  ChevronDown,
  ChevronRight,
  Cloud,
  Copy,
  Database,
  Disc,
  Eye,
  FolderKanban,
  FolderOpen,
  LineChart,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plug,
  Plus,
  Radio,
  Save,
  Settings2,
  Sliders,
  Square,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import type { DeviceDescriptorDto } from '../types/hal';
import type { SignalSchemaDto } from '../types/netdb';
import type { QuickBarConnectionState } from '../store/projectStore';
import type { StatusBanner } from './TopBar';
import {
  workbenchStore,
  useWorkbenchStore,
} from '../store/workbenchStore';
import { projectStore, useProjectStore } from '../store/projectStore';
import { isToolpackEnabled } from '../types/toolpacks';
import {
  cloudBridgeStore,
  useCloudBridgeHeader,
  type CloudBridgeTargetHz,
} from '../store/cloudBridgeStore';
import { useExperimentalCloud } from '../store/experimentalStore';
import {
  connectionStore,
  useConnectionStore,
  clampBusId,
  buildChannelConfigForProfile,
  type SavedConnectionProfile,
} from '../store/connectionStore';
import {
  databaseStore,
  useDatabaseStore,
  makeCatalogDbId,
  type ProjectDatabaseEntry,
} from '../store/databaseStore';
import {
  telemetryStore,
  useTelemetryHeader,
  useTelemetryFrames,
} from '../store/telemetryStore';
import {
  traceSessionsStore,
  useTraceSessionsStore,
} from '../store/traceSessionsStore';
import { plotStore } from '../store/plotStore';
import { useSimulationPanelStore } from '../store/simulationPanelStore';
import {
  ensureMockPresetDatabasesLoaded,
  syncAllBusDatabasesWithBackend,
} from '../utils/busDatabaseSync';
import {
  apiConnectBus,
  apiDisconnectBus,
  apiSetBusMode,
  apiParseDatabaseSchema,
} from '../services/ipcClient';
import { useI18n } from '../i18n';

export interface ProjectExplorerDockProps {
  devices: readonly DeviceDescriptorDto[];
  quickBarState: QuickBarConnectionState;
  onApplyQuickBar: (qb: QuickBarConnectionState) => void;
  onQuickSaveProject: () => Promise<void>;
  onStatusMessage: (msg: StatusBanner) => void;
}

export const ProjectExplorerDock: React.FC<ProjectExplorerDockProps> = ({
  devices: _devices,
  quickBarState,
  onApplyQuickBar,
  onQuickSaveProject,
  onStatusMessage,
}) => {
  const { t } = useI18n();
  const workbench = useWorkbenchStore();
  const projState = useProjectStore();
  const connState = useConnectionStore();
  const dbState = useDatabaseStore();
  const simPanels = useSimulationPanelStore();
  const header = useTelemetryHeader();
  const framesSlice = useTelemetryFrames();
  const cloudHeader = useCloudBridgeHeader();
  const cloudOn = useExperimentalCloud();
  const traceState = useTraceSessionsStore();

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Tree expanded state
  const [treeExpanded, setTreeExpanded] = useState({
    project: true,
    connections: true,
    databases: true,
    traces: true,
    panels: true,
    signals: false,
  });

  const [sigFilter, setSigFilter] = useState('');
  const [editingProjectName, setEditingProjectName] = useState(projState.currentName);

  // Sync editing project name when active project name changes
  useEffect(() => {
    setEditingProjectName(projState.currentName);
  }, [projState.currentName]);

  // Handle pointer drag for dock resizing
  const handleResizePointerDown = (e: React.PointerEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = workbench.dockWidthPx;
    const pos = workbench.dockPosition;

    const onPointerMove = (ev: PointerEvent): void => {
      const delta = pos === 'right' ? startX - ev.clientX : ev.clientX - startX;
      workbenchStore.setDockWidthPx(startWidth + delta);
    };

    const onPointerUp = (): void => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // Local file upload for DBC/KCD
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const reader = new FileReader();
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result;
          if (typeof result === 'string') {
            const base64 = result.includes(',') ? result.split(',')[1] : result;
            resolve(base64);
          } else {
            reject(new Error('Dosya okunamadı.'));
          }
        };
        reader.onerror = () => reject(reader.error ?? new Error('Dosya okunamadı.'));
        reader.readAsDataURL(file);
      });

      const schema = await apiParseDatabaseSchema(file.name, contentBase64);
      const dbId = makeCatalogDbId(file.name);
      const entry: ProjectDatabaseEntry = {
        id: dbId,
        name: file.name.replace(/\.[^/.]+$/, ''),
        fileName: file.name,
        format: file.name.toLowerCase().endsWith('.kcd') ? 'kcd' : 'dbc',
        contentBase64,
        sizeBytes: file.size,
        uploadedAt: new Date().toISOString(),
        schema,
      };
      databaseStore.upsertDatabaseEntry(entry);
      workbenchStore.setSelection({ kind: 'database', databaseId: dbId });
      onStatusMessage({
        kind: 'success',
        message: t('shell.dock.dbLoaded', { name: file.name }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('shell.dock.dbLoadError', { error: err instanceof Error ? err.message : String(err) }),
      });
    }
  };

  // Connect or disconnect profile
  const handleToggleProfileOnline = async (prof: SavedConnectionProfile): Promise<void> => {
    const isOnline = header.buses.some((b) => b.busId === prof.busId && b.connected);
    if (isOnline) {
      try {
        await apiDisconnectBus(prof.busId);
        telemetryStore.removeBusHealth(prof.busId);
        onStatusMessage({
          kind: 'info',
          message: t('shell.dock.busDisconnected', { slot: prof.busId + 1, name: prof.name }),
        });
      } catch (err) {
        onStatusMessage({
          kind: 'error',
          message: t('shell.dock.busStopError', { slot: prof.busId + 1, error: err instanceof Error ? err.message : String(err) }),
        });
      }
    } else {
      try {
        if (prof.driverFamily === 'mock') {
          await ensureMockPresetDatabasesLoaded();
        }
        const { deviceId, config } = buildChannelConfigForProfile(prof);
        const health = await apiConnectBus(deviceId, config);
        telemetryStore.upsertBusHealth(health);
        await syncAllBusDatabasesWithBackend();
        onStatusMessage({
          kind: 'success',
          message: t('shell.dock.busConnected', { slot: prof.busId + 1, name: prof.name, family: prof.driverFamily.toUpperCase() }),
        });
      } catch (err) {
        onStatusMessage({
          kind: 'error',
          message: t('shell.dock.busConnectError', { slot: prof.busId + 1, error: err instanceof Error ? err.message : String(err) }),
        });
      }
    }
  };

  // Toggle listen-only mode on profile
  const handleToggleListenOnly = async (prof: SavedConnectionProfile): Promise<void> => {
    const isOnline = header.buses.some((b) => b.busId === prof.busId && b.connected);
    const busHealth = header.buses.find((b) => b.busId === prof.busId);
    const curListenOnly = isOnline ? (busHealth?.listenOnly ?? prof.listenOnly) : prof.listenOnly;
    const nextListenOnly = !curListenOnly;

    connectionStore.upsertProfile({ ...prof, listenOnly: nextListenOnly });
    if (isOnline) {
      try {
        const updated = await apiSetBusMode(prof.busId, nextListenOnly, !nextListenOnly);
        telemetryStore.upsertBusHealth(updated);
        onStatusMessage({
          kind: 'info',
          message: t('shell.dock.busModeChanged', { slot: prof.busId + 1, mode: nextListenOnly ? t('shell.dock.listenOnlyActive') : t('shell.dock.listenOnlyDisabled') }),
        });
      } catch (err) {
        onStatusMessage({
          kind: 'error',
          message: t('shell.dock.busModeError', { error: err instanceof Error ? err.message : String(err) }),
        });
      }
    }
  };

  // Collect and filter signals from all bound bus schemas
  const allBoundSignals = useMemo(() => {
    const list: { busId: number; schema: SignalSchemaDto }[] = [];
    for (const [busId, lookup] of dbState.busSchemas) {
      for (const sig of lookup.schema.signals) {
        list.push({ busId, schema: sig });
      }
    }
    return list;
  }, [dbState.busSchemas]);

  const filteredSignals = useMemo(() => {
    const q = sigFilter.trim().toLowerCase();
    if (!q) return allBoundSignals.slice(0, 80);
    return allBoundSignals
      .filter(
        (item) =>
          item.schema.name.toLowerCase().includes(q) ||
          `bus ${item.busId + 1}`.includes(q),
      )
      .slice(0, 80);
  }, [allBoundSignals, sigFilter]);

  // Connected buses count
  const connectedCount = header.buses.filter((b) => b.connected).length;

  // ==========================================================================
  // 1. COLLAPSED RAIL MODE
  // ==========================================================================
  if (!workbench.dockOpen) {
    const isRight = workbench.dockPosition === 'right';
    return (
      <aside
        style={{
          backgroundColor: 'var(--bg-toolbar)',
          borderColor: 'var(--border-strong)',
        }}
        className={`w-[28px] shrink-0 flex flex-col items-center justify-between py-2 select-none z-20 ${
          isRight ? 'border-l' : 'border-r'
        }`}
      >
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => workbenchStore.setDockOpen(true)}
            style={{ color: 'var(--text-secondary)' }}
            className="w-6 h-6 flex items-center justify-center hover:text-[var(--text-primary)] hover:bg-[var(--bg-panel)] rounded-xs cursor-pointer transition-colors"
            title={isRight ? t('shell.dock.openTooltipRight') : t('shell.dock.openTooltipLeft')}
          >
            {isRight ? <PanelRightOpen className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
          </button>

          <button
            type="button"
            onClick={() => workbenchStore.setDockOpen(true)}
            className="flex items-center justify-center cursor-pointer mt-4 py-2"
            title={t('shell.dock.openDock')}
          >
            <span
              style={{
                writingMode: 'vertical-rl',
                transform: 'rotate(180deg)',
                color: 'var(--text-secondary)',
              }}
              className="text-[11px] font-semibold tracking-wider uppercase hover:text-[var(--text-primary)] transition-colors whitespace-nowrap"
            >
              {t('shell.dock.title')}
            </span>
          </button>
        </div>

        <div className="flex flex-col items-center gap-2">
          {workbench.watchSignals.length > 0 && (
            <button
              type="button"
              onClick={() => {
                workbenchStore.setBottomTab('watch');
                workbenchStore.setDockOpen(true);
              }}
              className="w-5 h-5 flex items-center justify-center rounded-full bg-sky-500/20 text-sky-400 text-[10px] font-mono font-bold cursor-pointer hover:bg-sky-500/30"
              title={t('shell.dock.watchCountTooltip', { count: workbench.watchSignals.length })}
            >
              {workbench.watchSignals.length}
            </button>
          )}

          {cloudOn && (
          <div
            className={`w-2 h-2 rounded-full ${
              cloudHeader.status === 'streaming'
                ? 'bg-emerald-400 shadow-xs shadow-emerald-400/50'
                : cloudHeader.isAuthenticated
                  ? 'bg-sky-400'
                  : 'bg-slate-600'
            }`}
            title={`Cloud: ${cloudHeader.status}`}
          />
          )}
        </div>
      </aside>
    );
  }

  // ==========================================================================
  // 2. EXPANDED COLUMN MODE
  // ==========================================================================
  const isRight = workbench.dockPosition === 'right';

  return (
    <aside
      style={{
        width: `${workbench.dockWidthPx}px`,
        backgroundColor: 'var(--bg-panel)',
        borderColor: 'var(--border-strong)',
      }}
      className={`relative h-full flex flex-col shrink-0 overflow-hidden select-none z-20 ${
        isRight ? 'border-l' : 'border-r'
      }`}
    >
      {/* 4px Pointer Resize Handle on the inner edge */}
      <div
        onPointerDown={handleResizePointerDown}
        style={{ cursor: 'col-resize' }}
        className={`absolute top-0 bottom-0 w-[4px] z-30 hover:bg-[#58A6FF]/50 transition-colors ${
          isRight ? 'left-0' : 'right-0'
        }`}
        title={t('shell.dock.resizeTooltip')}
      />

      {/* Hidden file input for DBC/KCD upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".dbc,.kcd,.xml"
        onChange={(e) => void handleFileUpload(e)}
        className="hidden"
      />

      {/* ================================================================== */}
      {/* KATMAN 1: PROJECT MANAGER TREE VIEW (~42% height)                 */}
      {/* ================================================================== */}
      <section className="flex flex-col h-[42%] min-h-[140px] border-b border-[var(--border-strong)] overflow-hidden">
        {/* Header Toolbar (34px) */}
        <div
          style={{
            backgroundColor: 'var(--bg-header)',
            borderBottom: '1px solid var(--border-grid)',
          }}
          className="h-[34px] px-2.5 flex items-center justify-between shrink-0 text-[12.5px]"
        >
          <div className="flex items-center gap-1.5 font-bold uppercase tracking-wider text-[var(--text-primary)]">
            <FolderKanban className="w-4 h-4 text-sky-400" />
            <span>{t('shell.dock.title')}</span>
          </div>

          <div className="flex items-center gap-1 text-[var(--text-secondary)]">
            <button
              type="button"
              onClick={() => workbenchStore.setNewConnectionModalOpen(true)}
              className="p-1 hover:text-[var(--text-primary)] hover:bg-[var(--bg-toolbar)] rounded-xs cursor-pointer"
              title={t('shell.dock.addBusTooltip')}
            >
              <Plus className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-1 hover:text-[var(--text-primary)] hover:bg-[var(--bg-toolbar)] rounded-xs cursor-pointer"
              title={t('shell.dock.loadDbTooltip')}
            >
              <Database className="w-3.5 h-3.5 text-amber-400" />
            </button>

            <button
              type="button"
              onClick={() => projectStore.setModalOpen(true)}
              className="p-1 hover:text-[var(--text-primary)] hover:bg-[var(--bg-toolbar)] rounded-xs cursor-pointer"
              title={t('shell.dock.manageProjectsTooltip')}
            >
              <FolderOpen className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => workbenchStore.toggleDockPosition()}
              className="p-1 hover:text-[var(--text-primary)] hover:bg-[var(--bg-toolbar)] rounded-xs cursor-pointer"
              title={isRight ? t('shell.dock.moveDockLeft') : t('shell.dock.moveDockRight')}
            >
              <ArrowLeftRight className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => workbenchStore.setDockOpen(false)}
              className="p-1 hover:text-[var(--text-primary)] hover:bg-[var(--bg-toolbar)] rounded-xs cursor-pointer"
              title={t('shell.dock.collapseDock')}
            >
              {isRight ? <PanelRightClose className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Organization Identity Bar (28px, experimental cloud only) */}
        {cloudOn && (
        <div
          style={{
            backgroundColor: 'var(--bg-toolbar)',
            borderBottom: '1px solid var(--border-grid)',
          }}
          className="h-[28px] px-2.5 flex items-center justify-between shrink-0 text-[11.5px]"
        >
          {cloudHeader.isAuthenticated ? (
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <Building2 className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              {cloudHeader.organizations.length > 1 ? (
                <select
                  value={cloudHeader.selectedOrgId ?? ''}
                  onChange={(e) => cloudBridgeStore.selectOrganization(e.target.value)}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="h-[22px] px-1.5 border text-[11px] rounded-xs truncate max-w-[170px]"
                >
                  {cloudHeader.organizations.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name} ({org.myRole})
                    </option>
                  ))}
                </select>
              ) : (
                <div className="flex items-center gap-1 min-w-0 truncate">
                  <span className="font-medium text-[var(--text-primary)] truncate">
                    {cloudHeader.selectedOrgName || 'Organization'}
                  </span>
                  {cloudHeader.selectedOrgRole && (
                    <span className="text-[10px] font-mono text-[var(--text-muted)] bg-[var(--bg-panel)] px-1 py-0.2 border border-[var(--border-grid)] rounded-xs shrink-0">
                      {cloudHeader.selectedOrgRole}
                    </span>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between w-full">
              <span className="text-[var(--text-muted)] flex items-center gap-1 truncate text-[11px]">
                <Cloud className="w-3.5 h-3.5 shrink-0" />
                <span>{t('shell.dock.localWorkspace')}</span>
              </span>
              <button
                type="button"
                onClick={() => databaseStore.setActiveDocTab('cloud')}
                className="text-[11px] text-sky-400 hover:underline cursor-pointer shrink-0 font-medium"
              >
                {t('shell.dock.signIn')}
              </button>
            </div>
          )}
        </div>
        )}

        {/* Hierarchical Tree View */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-1 font-sans text-[11px]">
          {/* Node 1: Project Root */}
          <div>
            <div
              onClick={() => workbenchStore.setSelection({ kind: 'project' })}
              className={`flex items-center justify-between px-2 h-[28px] rounded-xs cursor-pointer text-[12px] hover:bg-[var(--bg-row-hover)] ${
                workbench.selection.kind === 'project' ? 'bg-[var(--bg-row-selected)] text-sky-400 font-semibold' : 'text-[var(--text-primary)]'
              }`}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setTreeExpanded((prev) => ({ ...prev, project: !prev.project }));
                  }}
                  className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  {treeExpanded.project ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                </button>
                <FolderKanban className="w-4 h-4 text-amber-400 shrink-0" />
                <span className="truncate">{projState.currentName}</span>
              </div>
              <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">
                {cloudOn ? (projState.cloudBinding ? projState.cloudBinding.projectCode : t('shell.dock.unboundLocal')) : ''}
              </span>
            </div>

            {treeExpanded.project && (
              <div className="pl-3.5 border-l border-[var(--border-grid)] ml-2.5 mt-0.5 space-y-0.5">
                {/* Branch 1: Connections */}
                <div>
                  <div
                    onClick={() => setTreeExpanded((prev) => ({ ...prev, connections: !prev.connections }))}
                    className="flex items-center justify-between px-2 h-[28px] rounded-xs cursor-pointer text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-row-hover)]"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      {treeExpanded.connections ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      <Plug className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>{t('shell.dock.connections')}</span>
                      <span className="text-[11px] font-mono text-[var(--text-muted)]">({connState.profiles.length})</span>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        workbenchStore.setNewConnectionModalOpen(true);
                      }}
                      className="p-1 text-[var(--text-muted)] hover:text-emerald-400 cursor-pointer"
                      title={t('shell.dock.addBusTooltip')}
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {treeExpanded.connections && (
                    <div className="pl-3.5 border-l border-[var(--border-grid)] ml-2.5 space-y-0.5">
                      {connState.profiles.length === 0 ? (
                        <div className="px-2 py-1 text-[11px] text-[var(--text-muted)] italic">
                          {t('shell.dock.noConnections')}
                        </div>
                      ) : (
                        connState.profiles.map((p) => {
                          const isOnline = header.buses.some((b) => b.busId === p.busId && b.connected);
                          const isSelected =
                            workbench.selection.kind === 'connection' && workbench.selection.profileId === p.id;
                          return (
                            <div
                              key={p.id}
                              onClick={() => {
                                workbenchStore.setSelection({ kind: 'connection', profileId: p.id });
                                connectionStore.selectProfile(p.id);
                              }}
                              onDoubleClick={() => databaseStore.setActiveDocTab('connections')}
                              className={`flex items-center justify-between px-2 h-[28px] rounded-xs cursor-pointer text-[12px] hover:bg-[var(--bg-row-hover)] ${
                                isSelected ? 'bg-[var(--bg-row-selected)] text-sky-400 font-medium' : 'text-[var(--text-primary)]'
                              }`}
                            >
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span
                                  className={`w-2 h-2 rounded-full shrink-0 ${
                                    isOnline ? 'bg-emerald-400 shadow-xs shadow-emerald-400/50' : 'bg-slate-600'
                                  }`}
                                />
                                <span className="truncate">Bus {p.busId + 1} · {p.name}</span>
                              </div>
                              <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0 ml-1">
                                {p.databaseIds?.length ?? 0} DB
                              </span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>

                {/* Branch 2: DBC Studio */}
                <div>
                  <div
                    onClick={() => setTreeExpanded((prev) => ({ ...prev, databases: !prev.databases }))}
                    className="flex items-center justify-between px-2 h-[28px] rounded-xs cursor-pointer text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-row-hover)]"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      {treeExpanded.databases ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      <Database className="w-4 h-4 text-amber-400 shrink-0" />
                      <span>{t('shell.dock.databases')}</span>
                      <span className="text-[11px] font-mono text-[var(--text-muted)]">({dbState.databases.length})</span>
                    </div>
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          fileInputRef.current?.click();
                        }}
                        className="p-1 text-[var(--text-muted)] hover:text-amber-400 cursor-pointer"
                        title={t('shell.dock.loadDbTooltip')}
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {treeExpanded.databases && (
                    <div className="pl-3.5 border-l border-[var(--border-grid)] ml-2.5 space-y-0.5">
                      {dbState.databases.length === 0 ? (
                        <div className="px-2 py-1 text-[11px] text-[var(--text-muted)] italic">
                          {t('shell.dock.noDatabases')}
                        </div>
                      ) : (
                        dbState.databases.map((db) => {
                          const isSelected =
                            workbench.selection.kind === 'database' && workbench.selection.databaseId === db.id;
                          return (
                            <div
                              key={db.id}
                              onClick={() => {
                                workbenchStore.setSelection({ kind: 'database', databaseId: db.id });
                                databaseStore.setInspectedDatabaseId(db.id);
                              }}
                              onDoubleClick={() => databaseStore.setActiveDocTab('symbols')}
                              className={`flex items-center justify-between px-2 h-[28px] rounded-xs cursor-pointer text-[12px] hover:bg-[var(--bg-row-hover)] ${
                                isSelected ? 'bg-[var(--bg-row-selected)] text-sky-400 font-medium' : 'text-[var(--text-primary)]'
                              }`}
                            >
                              <div className="flex items-center gap-1.5 min-w-0">
                                <Database className="w-3.5 h-3.5 text-amber-400/80 shrink-0" />
                                <span className="truncate">{db.fileName}</span>
                              </div>
                              <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0 ml-1">
                                {db.schema?.messages.length ?? 0}m
                              </span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>

                {/* Branch: Traces */}
                <div>
                  <div
                    onClick={() => setTreeExpanded((prev) => ({ ...prev, traces: !prev.traces }))}
                    className="flex items-center justify-between px-2 h-[28px] rounded-xs cursor-pointer text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-row-hover)]"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      {treeExpanded.traces ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      <Disc className="w-4 h-4 text-rose-400 shrink-0" />
                      <span>{t('shell.dock.traces')}</span>
                      <span className="text-[11px] font-mono text-[var(--text-muted)]">({traceState.sessions.length})</span>
                    </div>
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          const s = traceSessionsStore.spawnNewTraceSession({ autoStart: true });
                          workbenchStore.setSelection({ kind: 'trace', sessionId: s.id });
                          databaseStore.setActiveDocTab('trace');
                          onStatusMessage({
                            kind: 'info',
                            message: t('shell.dock.traceSpawned', { name: s.name }),
                          });
                        }}
                        className="p-1 text-[var(--text-muted)] hover:text-rose-400 cursor-pointer"
                        title={t('shell.dock.spawnTraceTooltip')}
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {treeExpanded.traces && (
                    <div className="pl-3.5 border-l border-[var(--border-grid)] ml-2.5 space-y-0.5">
                      {/* Traces Directory Path Box */}
                      <div className="px-2 py-1 mb-1 bg-[var(--bg-toolbar)]/60 border border-[var(--border-grid)] rounded-xs flex items-center justify-between text-[11px] font-mono text-[var(--text-muted)]">
                        <span className="truncate" title={traceState.tracesDir}>📁 {traceState.tracesDir}</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void navigator.clipboard.writeText(traceState.tracesDir);
                            onStatusMessage({ kind: 'info', message: t('shell.dock.traceDirCopied', { path: traceState.tracesDir }) });
                          }}
                          className="p-1 hover:text-sky-400 cursor-pointer shrink-0 ml-1"
                          title={t('shell.dock.copyTracesDir')}
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                      </div>

                      {traceState.sessions.map((s) => {
                        const isSelected =
                          workbench.selection.kind === 'trace' && workbench.selection.sessionId === s.id;
                        return (
                          <div
                            key={s.id}
                            onClick={() => {
                              workbenchStore.setSelection({ kind: 'trace', sessionId: s.id });
                              traceSessionsStore.setActiveSession(s.id);
                            }}
                            onDoubleClick={() => databaseStore.setActiveDocTab('trace')}
                            className={`flex items-center justify-between px-2 h-[28px] rounded-xs cursor-pointer text-[12px] hover:bg-[var(--bg-row-hover)] ${
                              isSelected ? 'bg-[var(--bg-row-selected)] text-sky-400 font-medium' : 'text-[var(--text-primary)]'
                            }`}
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span
                                className={`w-2 h-2 rounded-full shrink-0 ${
                                  s.state === 'recording'
                                    ? 'bg-rose-500 animate-pulse shadow-xs shadow-rose-500/50'
                                    : s.state === 'paused'
                                      ? 'bg-amber-400'
                                      : 'bg-slate-500'
                                }`}
                                title={`Durum: ${s.state}`}
                              />
                              <span className="truncate">{s.name}</span>
                            </div>

                            <div className="flex items-center gap-1 shrink-0 ml-1">
                              <span className="text-[11px] font-mono tabular-nums text-[var(--text-muted)]">
                                {s.count.toLocaleString('en-US')}
                              </span>

                              {s.count > 0 && s.state !== 'recording' && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void traceSessionsStore.startSessionReplay(s.id);
                                    databaseStore.setActiveDocTab('trace');
                                    onStatusMessage({ kind: 'info', message: t('shell.dock.traceReplaying', { name: s.name }) });
                                  }}
                                  className="p-1 text-[var(--text-muted)] hover:text-cyan-400 cursor-pointer"
                                  title={t('shell.dock.replaySessionTooltip')}
                                >
                                  <Play className="w-3 h-3 fill-current text-cyan-400" />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}

                      {/* Saved Files on Disk (traces/) */}
                      <div className="pt-1.5 mt-1 border-t border-[var(--border-grid)]">
                        <div className="flex items-center justify-between px-1.5 text-[11px] font-semibold text-[var(--text-secondary)] uppercase">
                          <span className="flex items-center gap-1.5">
                            <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
                            <span>{t('shell.dock.savedDiskRecordings')}</span>
                          </span>
                          <span className="font-mono text-[10px] text-[var(--text-muted)]">
                            ({traceState.savedFiles.length})
                          </span>
                        </div>

                        <div className="mt-1 space-y-0.5">
                          {traceState.savedFiles.length === 0 ? (
                            <div className="px-2 py-1 text-[11px] text-[var(--text-muted)] italic">
                              {t('shell.dock.noSavedFiles')}
                            </div>
                          ) : (
                            traceState.savedFiles.map((f) => (
                              <div
                                key={f.fileName}
                                className="flex items-center justify-between px-2 h-[28px] rounded-xs hover:bg-[var(--bg-row-hover)] text-[12px] group"
                              >
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span
                                    className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-xs uppercase ${
                                      f.format.toLowerCase() === 'blf'
                                        ? 'bg-purple-500/25 text-purple-300 border border-purple-500/30'
                                        : 'bg-amber-500/20 text-amber-300'
                                    }`}
                                  >
                                    {f.format}
                                  </span>
                                  <span className="truncate font-sans" title={f.fileName}>
                                    {f.fileName}
                                  </span>
                                </div>

                                <div className="flex items-center gap-1 shrink-0 ml-1">
                                  <span
                                    className="text-[11px] font-mono tabular-nums text-[var(--text-muted)]"
                                    title={f.statsKnown === false ? t('shell.dock.traceStatsUnknownHint') : undefined}
                                  >
                                    {f.statsKnown === false
                                      ? t('shell.dock.traceStatsUnknown')
                                      : `${f.frameCount.toLocaleString('en-US')} ${t('shell.dock.traceFramesUnit')} · ${(f.durationUs / 1_000_000).toFixed(1)}s`}
                                  </span>

                                  <button
                                    type="button"
                                    onClick={() => {
                                      void traceSessionsStore.openSavedTraceFile(f.fileName);
                                      onStatusMessage({ kind: 'info', message: t('shell.dock.traceOpened', { name: f.fileName }) });
                                    }}
                                    className="p-1 hover:text-sky-400 text-[var(--text-muted)] cursor-pointer"
                                    title={t('shell.dock.openInTraceTab')}
                                  >
                                    <FolderOpen className="w-3.5 h-3.5" />
                                  </button>

                                  <button
                                    type="button"
                                    onClick={() => {
                                      void traceSessionsStore.openSavedTraceFile(f.fileName).then(() => {
                                        void traceSessionsStore.startSavedFileReplay(f.fileName);
                                        onStatusMessage({ kind: 'info', message: t('shell.dock.traceReplaying', { name: f.fileName }) });
                                      });
                                    }}
                                    className="p-1 hover:text-cyan-400 text-[var(--text-muted)] cursor-pointer"
                                    title={t('shell.dock.startReplay')}
                                  >
                                    <Play className="w-3.5 h-3.5 fill-current text-cyan-400" />
                                  </button>

                                  <button
                                    type="button"
                                    onClick={() => {
                                      void traceSessionsStore.deleteSavedTraceFile(f.fileName);
                                      onStatusMessage({ kind: 'info', message: t('shell.dock.traceDeleted', { name: f.fileName }) });
                                    }}
                                    className="p-1 hover:text-red-400 text-[var(--text-muted)] cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                                    title={t('shell.dock.deleteFromDisk')}
                                  >
                                    <Trash2 className="w-3.5 h-3.5 text-red-400" />
                                  </button>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Branch 3: Simulation Panels (conditionally shown based on toolpack) */}
                {isToolpackEnabled(projState.enabledToolpacks, 'simulation_replay') && (
                  <div>
                    <div
                      onClick={() => setTreeExpanded((prev) => ({ ...prev, panels: !prev.panels }))}
                      className="flex items-center justify-between px-2 h-[28px] rounded-xs cursor-pointer text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-row-hover)]"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        {treeExpanded.panels ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        <Sliders className="w-4 h-4 text-purple-400 shrink-0" />
                        <span>{t('shell.dock.simPanels')}</span>
                        <span className="text-[11px] font-mono text-[var(--text-muted)]">({simPanels.panels.length})</span>
                      </div>
                    </div>

                    {treeExpanded.panels && (
                      <div className="pl-3.5 border-l border-[var(--border-grid)] ml-2.5 space-y-0.5">
                        {simPanels.panels.length === 0 ? (
                          <div className="px-2 py-1 text-[11px] text-[var(--text-muted)] italic">
                            {t('shell.dock.noPanels')}
                          </div>
                        ) : (
                          simPanels.panels.map((p) => {
                            const isSelected =
                              workbench.selection.kind === 'panel' && workbench.selection.panelId === p.id;
                            return (
                              <div
                                key={p.id}
                                onClick={() => workbenchStore.setSelection({ kind: 'panel', panelId: p.id })}
                                onDoubleClick={() => databaseStore.setActiveDocTab('panels')}
                                className={`flex items-center justify-between px-2 h-[28px] rounded-xs cursor-pointer text-[12px] hover:bg-[var(--bg-row-hover)] ${
                                  isSelected ? 'bg-[var(--bg-row-selected)] text-amber-400 font-medium' : 'text-[var(--text-primary)]'
                                }`}
                              >
                                <span className="truncate">{p.name}</span>
                                <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0 ml-1">
                                  {p.widgets?.length ?? 0}w
                                </span>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Branch 4: Bound Signals */}
                <div>
                  <div
                    onClick={() => setTreeExpanded((prev) => ({ ...prev, signals: !prev.signals }))}
                    className="flex items-center justify-between px-2 h-[28px] rounded-xs cursor-pointer text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-row-hover)]"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      {treeExpanded.signals ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      <Radio className="w-4 h-4 text-cyan-400 shrink-0" />
                      <span>{t('shell.dock.signals')}</span>
                      <span className="text-[11px] font-mono text-[var(--text-muted)]">({allBoundSignals.length})</span>
                    </div>
                  </div>

                  {treeExpanded.signals && (
                    <div className="pl-3.5 border-l border-[var(--border-grid)] ml-2.5 space-y-1 mt-0.5">
                      <div className="relative flex items-center pr-1">
                        <input
                          type="text"
                          value={sigFilter}
                          onChange={(e) => setSigFilter(e.target.value)}
                          placeholder={t('shell.dock.searchSignalsPlaceholder')}
                          style={{
                            backgroundColor: 'var(--bg-input)',
                            borderColor: 'var(--border-strong)',
                            color: 'var(--text-primary)',
                          }}
                          className="h-[26px] w-full px-2 text-[11.5px] border rounded-xs focus:outline-none"
                        />
                        {sigFilter && (
                          <button
                            type="button"
                            onClick={() => setSigFilter('')}
                            className="absolute right-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </div>

                      <div className="space-y-0.5 max-h-[160px] overflow-y-auto">
                        {filteredSignals.length === 0 ? (
                          <div className="px-2 py-1 text-[11px] text-[var(--text-muted)] italic">
                            {t('shell.dock.noSignalsFound')}
                          </div>
                        ) : (
                          filteredSignals.map(({ busId, schema }) => {
                            const isSelected =
                              workbench.selection.kind === 'signal' &&
                              workbench.selection.busId === busId &&
                              workbench.selection.signalId === schema.signalId;
                            const isWatched = workbench.watchSignals.some(
                              (w) => w.key === `${busId}:${schema.signalId}`,
                            );

                            return (
                              <div
                                key={`${busId}:${schema.signalId}`}
                                onClick={() =>
                                  workbenchStore.setSelection({
                                    kind: 'signal',
                                    busId,
                                    signalId: schema.signalId,
                                  })
                                }
                                className={`group flex items-center justify-between px-2 h-[28px] rounded-xs cursor-pointer text-[12px] hover:bg-[var(--bg-row-hover)] ${
                                  isSelected ? 'bg-[var(--bg-row-selected)] text-sky-400 font-medium' : 'text-[var(--text-primary)]'
                                }`}
                              >
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span className="text-[var(--text-muted)] font-mono text-[10px]">~</span>
                                  <span className="truncate" title={schema.comment ?? schema.name}>
                                    {schema.name}
                                  </span>
                                  <span className="text-[11px] font-mono text-[var(--text-muted)]">
                                    [B{busId + 1}]
                                  </span>
                                </div>

                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      workbenchStore.toggleWatchSignal({
                                        key: `${busId}:${schema.signalId}`,
                                        busId,
                                        signalId: schema.signalId,
                                        name: schema.name,
                                        unit: schema.unit || '',
                                        min: schema.min,
                                        max: schema.max,
                                      });
                                    }}
                                    className={`p-1 rounded-xs cursor-pointer ${
                                      isWatched ? 'text-sky-400 opacity-100' : 'text-[var(--text-muted)] hover:text-sky-400'
                                    }`}
                                    title={isWatched ? t('shell.dock.unwatchTooltip') : t('shell.dock.watchTooltip')}
                                  >
                                    <Eye className="w-2.5 h-2.5" />
                                  </button>

                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      plotStore.toggleSignal(busId, schema);
                                    }}
                                    className="p-0.5 text-[var(--text-muted)] hover:text-emerald-400 rounded-xs cursor-pointer"
                                    title={t('shell.dock.togglePlotterTooltip')}
                                  >
                                    <LineChart className="w-2.5 h-2.5" />
                                  </button>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Branch 5: Engineering Toolpacks */}
                <div
                  onClick={() => projectStore.setToolpacksModalOpen(true)}
                  className="flex items-center justify-between px-2 h-[28px] rounded-xs cursor-pointer text-[12px] text-[var(--text-secondary)] hover:text-cyan-400 hover:bg-[var(--bg-row-hover)]"
                  title={t('shell.toolbar.toolpacksTooltip', { count: projState.enabledToolpacks.length })}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Boxes className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span>{t('shell.dock.toolpacks')}</span>
                  </div>
                  <span className="px-1.5 py-0.5 rounded bg-cyan-950/70 border border-cyan-800/60 text-cyan-300 font-mono text-[11px] shrink-0">
                    {projState.enabledToolpacks.length}/7
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* KATMAN 2: PROPERTIES INSPECTOR GRID (~34% height)                 */}
      {/* ================================================================== */}
      <section className="flex flex-col h-[34%] min-h-[120px] border-b border-[var(--border-strong)] overflow-hidden">
        {/* Properties Header (34px) */}
        <div
          style={{
            backgroundColor: 'var(--bg-header)',
            borderBottom: '1px solid var(--border-grid)',
          }}
          className="h-[34px] px-2.5 flex items-center justify-between shrink-0 text-[12.5px]"
        >
          <div className="flex items-center gap-1.5 font-bold uppercase tracking-wider text-[var(--text-primary)]">
            <Settings2 className="w-4 h-4 text-cyan-400" />
            <span>{t('shell.dock.properties')}</span>
          </div>

          <span className="text-[11px] font-mono text-[var(--text-secondary)] truncate max-w-[150px]">
            {workbench.selection.kind === 'project' && t('shell.dock.propProject')}
            {workbench.selection.kind === 'connection' && t('shell.dock.propConnection')}
            {workbench.selection.kind === 'database' && t('shell.dock.propDatabase')}
            {workbench.selection.kind === 'trace' && t('shell.dock.propTrace')}
            {workbench.selection.kind === 'signal' && t('shell.dock.propSignal')}
            {workbench.selection.kind === 'panel' && t('shell.dock.propPanel')}
          </span>
        </div>

        {/* 2-Column Property Grid */}
        <div className="flex-1 min-h-0 overflow-y-auto p-2 font-sans text-[12px] space-y-1.5">
          {/* SELECTION: PROJECT */}
          {workbench.selection.kind === 'project' && (
            <div className="space-y-1.5">
              <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                <span className="text-[var(--text-secondary)]">{t('shell.dock.propName')}</span>
                <input
                  type="text"
                  value={editingProjectName}
                  onChange={(e) => setEditingProjectName(e.target.value)}
                  onBlur={() => {
                    if (editingProjectName.trim().length >= 2 && editingProjectName !== projState.currentName) {
                      projectStore.setProjectMetadata(editingProjectName);
                      void onQuickSaveProject();
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="h-[26px] px-2 border text-[12px] rounded-xs focus:outline-none"
                />
              </div>

              {cloudOn && (
              <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                <span className="text-[var(--text-secondary)]">{t('shell.dock.propOrg')}</span>
                <span className="font-mono text-[11px] text-[var(--text-primary)] truncate">
                  {cloudHeader.isAuthenticated
                    ? `${cloudHeader.selectedOrgName || 'Org'} [${cloudHeader.selectedOrgRole || 'engineer'}]`
                    : 'Local / Offline'}
                </span>
              </div>
              )}

              {cloudOn && (
              <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                <span className="text-[var(--text-secondary)]">{t('shell.dock.propCloudBinding')}</span>
                <span className="font-mono text-[11px] text-[var(--text-primary)] truncate">
                  {projState.cloudBinding
                    ? `${projState.cloudBinding.projectCode} (Rev #${projState.cloudBinding.baseRevisionNumber ?? 1})`
                    : t('shell.dock.unboundLocal')}
                </span>
              </div>
              )}

              <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                <span className="text-[var(--text-secondary)]">{t('shell.dock.propTopology')}</span>
                <span className="font-mono text-[11px] text-[var(--text-primary)]">
                  {connState.profiles.length} Bus ({connectedCount} online) · {dbState.databases.length} DB
                </span>
              </div>

              {/* Action Buttons */}
              <div className="pt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => void onQuickSaveProject()}
                  style={{
                    backgroundColor: 'var(--bg-toolbar)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="h-[28px] px-2.5 border text-[12px] font-semibold flex items-center gap-1 hover:border-sky-500 cursor-pointer rounded-xs"
                >
                  <Save className="w-3.5 h-3.5 text-sky-400" />
                  <span>{t('shell.dock.saveProject')}</span>
                </button>

                <button
                  type="button"
                  onClick={() => projectStore.setModalOpen(true)}
                  style={{
                    backgroundColor: 'var(--bg-toolbar)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-secondary)',
                  }}
                  className="h-[28px] px-2.5 border text-[12px] hover:text-[var(--text-primary)] cursor-pointer rounded-xs"
                >
                  {t('shell.dock.manageProjects')}
                </button>

                {cloudOn && cloudHeader.isAuthenticated && (
                  <button
                    type="button"
                    onClick={() => {
                      if (projState.cloudBinding) {
                        void cloudBridgeStore.pushActiveLocalProjectToCloud({
                          mode: 'bound',
                          quickBarState,
                        });
                      } else {
                        cloudBridgeStore.openPushPrompt({
                          reason: 'manual',
                          projectName: projState.currentName,
                        });
                      }
                    }}
                    style={{
                      backgroundColor: 'rgba(56, 139, 253, 0.12)',
                      borderColor: 'rgba(56, 139, 253, 0.40)',
                      color: '#58A6FF',
                    }}
                    className="h-[28px] px-2.5 border text-[12px] font-semibold flex items-center gap-1 hover:opacity-90 cursor-pointer rounded-xs"
                  >
                    <UploadCloud className="w-3.5 h-3.5" />
                    <span>{t('shell.dock.pushToCloud')}</span>
                  </button>
                )}

                {projState.hasActiveWorkspace && (
                  <button
                    type="button"
                    onClick={() => void projectStore.closeCurrentProject(onApplyQuickBar)}
                    style={{
                      backgroundColor: 'rgba(239, 68, 68, 0.10)',
                      borderColor: 'rgba(239, 68, 68, 0.35)',
                      color: '#F87171',
                    }}
                    className="h-[28px] px-2.5 border text-[12px] font-semibold hover:border-red-500 cursor-pointer ml-auto rounded-xs"
                  >
                    {t('shell.dock.closeProject')}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* SELECTION: CONNECTION */}
          {workbench.selection.kind === 'connection' && (() => {
            const profileId = workbench.selection.profileId;
            const prof = connState.profiles.find((p) => p.id === profileId) ?? connState.profiles[0];
            if (!prof) {
              return (
                <div className="text-[var(--text-muted)] p-2 italic text-center">
                  {t('shell.dock.noProfileSelected')}
                </div>
              );
            }

            const isOnline = header.buses.some((b) => b.busId === prof.busId && b.connected);
            const busHealth = header.buses.find((b) => b.busId === prof.busId);
            const isListenOnly = isOnline ? (busHealth?.listenOnly ?? prof.listenOnly) : prof.listenOnly;

            return (
              <div className="space-y-1.5">
                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.propEnabled')}</span>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isOnline}
                      onChange={() => void handleToggleProfileOnline(prof)}
                      className="accent-emerald-500 cursor-pointer"
                    />
                    <span className={`text-[10px] font-mono font-semibold ${isOnline ? 'text-emerald-400' : 'text-[var(--text-muted)]'}`}>
                      {isOnline ? t('shell.dock.onlineConnected') : t('shell.dock.offline')}
                    </span>
                  </label>
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.propName')}</span>
                  <input
                    type="text"
                    value={prof.name}
                    onChange={(e) => connectionStore.upsertProfile({ ...prof, name: e.target.value })}
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="h-[26px] px-2 border text-[12px] rounded-xs focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.busSlot')}</span>
                  <input
                    type="number"
                    min={1}
                    max={256}
                    value={prof.busId + 1}
                    onChange={(e) =>
                      connectionStore.upsertProfile({
                        ...prof,
                        busId: clampBusId(Number(e.target.value) - 1),
                      })
                    }
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="h-[26px] w-20 px-2 border text-[12px] font-mono tabular-nums rounded-xs focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.hardware')}</span>
                  <span className="font-mono text-[11px] text-[var(--text-primary)] truncate" title={prof.deviceId}>
                    {prof.driverFamily.toUpperCase()} · {prof.adapterChannel || prof.deviceId}
                  </span>
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.bitRate')}</span>
                  <span className="font-mono text-[11px] text-[var(--text-primary)]">
                    {Math.round(prof.bitrate / 1000)}k{prof.enableFd ? ` / ${Math.round(prof.dataBitrate / 1_000_000)}M FD` : ' CC'}
                  </span>
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.listenOnly')}</span>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isListenOnly}
                      onChange={() => void handleToggleListenOnly(prof)}
                      className="accent-amber-500 cursor-pointer"
                    />
                    <span className="text-[11px] text-[var(--text-muted)]">
                      {isListenOnly ? t('shell.dock.listenOnlyActive') : t('shell.dock.listenOnlyDisabled')}
                    </span>
                  </label>
                </div>

                {/* Databases Binding */}
                <div className="py-1 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)] block mb-1">{t('shell.dock.boundDatabases')}</span>
                  <div className="space-y-1 pl-1">
                    {dbState.databases.length === 0 ? (
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="text-[11px] text-sky-400 hover:underline flex items-center gap-1 cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>{t('shell.dock.uploadDbcKcd')}</span>
                      </button>
                    ) : (
                      dbState.databases.map((db) => {
                        const isBound = prof.databaseIds?.includes(db.id) ?? false;
                        return (
                          <label key={db.id} className="flex items-center gap-1.5 text-[11.5px] cursor-pointer">
                            <input
                              type="checkbox"
                              checked={isBound}
                              onChange={(e) => {
                                const nextIds = e.target.checked
                                  ? [...(prof.databaseIds || []), db.id]
                                  : (prof.databaseIds || []).filter((id) => id !== db.id);
                                connectionStore.upsertProfile({ ...prof, databaseIds: nextIds });
                                void syncAllBusDatabasesWithBackend();
                              }}
                              className="accent-sky-500 cursor-pointer"
                            />
                            <span className="truncate">{db.fileName}</span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="pt-1">
                  <button
                    type="button"
                    onClick={() => databaseStore.setActiveDocTab('connections')}
                    style={{
                      backgroundColor: 'var(--bg-toolbar)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-secondary)',
                    }}
                    className="h-[28px] px-3 border text-[12px] hover:text-[var(--text-primary)] cursor-pointer rounded-xs"
                  >
                    {t('shell.dock.detailedHardwareSettings')}
                  </button>
                </div>
              </div>
            );
          })()}

          {/* SELECTION: DATABASE */}
          {workbench.selection.kind === 'database' && (() => {
            const databaseId = workbench.selection.databaseId;
            const db = dbState.databases.find((d) => d.id === databaseId) ?? dbState.databases[0];
            if (!db) {
              return (
                <div className="text-[var(--text-muted)] p-2 italic text-center">
                  {t('shell.dock.noDbSelected')}
                </div>
              );
            }

            return (
              <div className="space-y-1.5">
                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.propFile')}</span>
                  <span className="font-mono text-[10px] text-[var(--text-primary)] truncate" title={db.fileName}>
                    {db.fileName}
                  </span>
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.propFormat')}</span>
                  <span className="font-mono text-[10px] text-amber-400 font-bold uppercase">
                    {db.format}
                  </span>
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.propMessagesSigs')}</span>
                  <span className="font-mono text-[10px] text-[var(--text-primary)]">
                    {db.schema?.messages.length ?? 0} m / {db.schema?.signals.length ?? 0} sig
                  </span>
                </div>

                {/* Bound Buses Checkboxes */}
                <div className="py-1 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)] block mb-1">{t('shell.dock.boundToBuses')}</span>
                  <div className="space-y-1 pl-1">
                    {connState.profiles.length === 0 ? (
                      <span className="text-[10px] text-[var(--text-muted)] italic">{t('shell.dock.noDefinedConnections')}</span>
                    ) : (
                      connState.profiles.map((p) => {
                        const isBound = p.databaseIds?.includes(db.id) ?? false;
                        return (
                          <label key={p.id} className="flex items-center gap-1.5 text-[11px] cursor-pointer">
                            <input
                              type="checkbox"
                              checked={isBound}
                              onChange={(e) => {
                                const nextIds = e.target.checked
                                  ? [...(p.databaseIds || []), db.id]
                                  : (p.databaseIds || []).filter((id) => id !== db.id);
                                connectionStore.upsertProfile({ ...p, databaseIds: nextIds });
                                void syncAllBusDatabasesWithBackend();
                              }}
                              className="accent-sky-500 cursor-pointer"
                            />
                            <span className="truncate">Bus {p.busId + 1} · {p.name}</span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="pt-1 flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      databaseStore.setInspectedDatabaseId(db.id);
                      databaseStore.setActiveDocTab('symbols');
                    }}
                    style={{
                      backgroundColor: 'var(--bg-toolbar)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="h-[28px] px-2.5 border text-[12px] hover:border-sky-500 cursor-pointer rounded-xs"
                  >
                    {t('shell.dock.symbolBitMatrix')}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      databaseStore.removeDatabaseEntry(db.id);
                      void syncAllBusDatabasesWithBackend();
                      onStatusMessage({
                        kind: 'info',
                        message: t('shell.dock.dbRemoved', { name: db.fileName }),
                      });
                    }}
                    style={{
                      backgroundColor: 'rgba(239, 68, 68, 0.10)',
                      borderColor: 'rgba(239, 68, 68, 0.35)',
                      color: '#F87171',
                    }}
                    className="h-[28px] px-2.5 border text-[12px] hover:border-red-500 cursor-pointer ml-auto rounded-xs"
                  >
                    {t('shell.dock.deleteFromCatalog')}
                  </button>
                </div>
              </div>
            );
          })()}

          {/* SELECTION: TRACE */}
          {workbench.selection.kind === 'trace' && (() => {
            const sessionId = workbench.selection.sessionId;
            const sess = traceSessionsStore.getSession(sessionId);
            if (!sess) {
              return (
                <div className="text-[var(--text-muted)] p-2 italic text-center">
                  {t('shell.dock.noTraceSession')}
                </div>
              );
            }

            return (
              <div className="space-y-1.5">
                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.propName')}</span>
                  <input
                    type="text"
                    value={sess.name}
                    onChange={(e) => traceSessionsStore.renameSession(sess.id, e.target.value)}
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="h-[26px] px-2 border text-[12px] rounded-xs focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.propFile')}</span>
                  <span className="font-mono text-[10px] text-[var(--text-primary)] truncate" title={sess.fileName}>
                    {sess.fileName}
                  </span>
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.propLocation')}</span>
                  <span
                    className="font-mono text-[10px] text-emerald-400 truncate flex items-center justify-between"
                    title={sess.savedFilePath || `${traceState.tracesDir}/${sess.fileName}`}
                  >
                    <span className="truncate">
                      {sess.savedFilePath ? `📁 ${sess.savedFilePath}` : t('shell.dock.notSaved')}
                    </span>
                    {sess.savedFilePath && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          const filePath = sess.savedFilePath ?? '';
                          void navigator.clipboard.writeText(filePath);
                          onStatusMessage({ kind: 'info', message: t('shell.dock.filePathCopied', { path: filePath }) });
                        }}
                        className="hover:text-emerald-300 p-0.5 shrink-0 ml-1 cursor-pointer"
                        title={t('shell.dock.copyPath')}
                      >
                        <Copy className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </span>
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.propState')}</span>
                  <div className="flex items-center justify-between">
                    <span
                      className={`text-[10px] font-semibold uppercase flex items-center gap-1 ${
                        sess.state === 'recording'
                          ? 'text-rose-400'
                          : sess.state === 'paused'
                            ? 'text-amber-400'
                            : 'text-slate-400'
                      }`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full ${
                          sess.state === 'recording'
                            ? 'bg-rose-500 animate-pulse'
                            : sess.state === 'paused'
                              ? 'bg-amber-400'
                              : 'bg-slate-500'
                        }`}
                      />
                      {sess.state}
                    </span>
                    <div className="flex items-center gap-1">
                      {sess.state !== 'recording' ? (
                        <button
                          type="button"
                          onClick={() => traceSessionsStore.startRecording(sess.id, false)}
                          className="h-[18px] px-1.5 text-[9px] bg-rose-500/20 text-rose-300 border border-rose-500/40 rounded-xs hover:bg-rose-500/30 cursor-pointer"
                        >
                          {t('shell.dock.btnStart')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => traceSessionsStore.pauseRecording(sess.id)}
                          className="h-[18px] px-1.5 text-[9px] bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-xs hover:bg-amber-500/30 cursor-pointer"
                        >
                          {t('shell.dock.btnPause')}
                        </button>
                      )}
                      {sess.state !== 'stopped' && (
                        <button
                          type="button"
                          onClick={() => traceSessionsStore.stopRecording(sess.id)}
                          className="h-[18px] px-1.5 text-[9px] bg-slate-700 text-slate-300 border border-slate-600 rounded-xs hover:bg-slate-600 cursor-pointer"
                        >
                          {t('shell.dock.btnStop')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.busFilter')}</span>
                  <select
                    value={sess.busFilter ?? 'ALL'}
                    onChange={(e) =>
                      traceSessionsStore.setSessionBusFilter(
                        sess.id,
                        e.target.value === 'ALL' ? null : Number(e.target.value),
                      )
                    }
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="h-[20px] px-1 border text-[10px] rounded-xs focus:outline-none"
                  >
                    <option value="ALL">{t('shell.dock.allBuses')}</option>
                    {Array.from(
                      new Set<number>([
                        0,
                        1,
                        2,
                        3,
                        4,
                        5,
                        6,
                        7,
                        ...connState.profiles.map((p) => p.busId),
                        ...header.buses.map((b) => b.busId),
                        ...(sess.busFilter !== null ? [sess.busFilter] : []),
                      ]),
                    )
                      .sort((a, b) => a - b)
                      .map((i) => (
                        <option key={i} value={i}>
                          Bus {i + 1}
                        </option>
                      ))}
                  </select>
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.propFrames')}</span>
                  <span className="font-mono tabular-nums text-[10px] text-[var(--text-primary)]">
                    {sess.count.toLocaleString('en-US')} buffer ({sess.rxCaptured.toLocaleString('en-US')} Rx /{' '}
                    {sess.txCaptured.toLocaleString('en-US')} Tx)
                  </span>
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.propMaxBuffer')}</span>
                  <span className="font-mono tabular-nums text-[10px] text-[var(--text-primary)]">
                    {sess.maxBufferRows.toLocaleString('en-US')} rows
                  </span>
                </div>

                {/* Actions */}
                <div className="pt-2 flex flex-wrap gap-1">
                  <button
                    type="button"
                    disabled={sess.count === 0}
                    onClick={() => {
                      void traceSessionsStore.saveSessionToDisk(sess.id, 'trc').then((summary) => {
                        onStatusMessage({
                          kind: 'success',
                          message: t('shell.dock.traceSaved', { name: summary.fileName }),
                        });
                      });
                    }}
                    style={{
                      backgroundColor: 'var(--bg-toolbar)',
                      borderColor: sess.savedFilePath && !sess.dirtySinceSave ? '#10B981' : 'var(--border-strong)',
                      color: sess.savedFilePath && !sess.dirtySinceSave ? '#34D399' : 'var(--text-primary)',
                    }}
                    className="h-[28px] px-2.5 border text-[12px] rounded-xs disabled:opacity-40 cursor-pointer hover:border-emerald-500 font-medium"
                    title={t('shell.dock.saveToDiskTooltip')}
                  >
                    {t('shell.dock.saveToDisk')}
                  </button>

                  <button
                    type="button"
                    disabled={sess.count === 0}
                    onClick={() => {
                      void traceSessionsStore.startSessionReplay(sess.id).then(() => {
                        databaseStore.setActiveDocTab('trace');
                        onStatusMessage({ kind: 'info', message: t('shell.dock.traceReplaying', { name: sess.name }) });
                      });
                    }}
                    style={{
                      backgroundColor: 'rgba(6, 182, 212, 0.15)',
                      borderColor: '#06B6D4',
                      color: '#22D3EE',
                    }}
                    className="h-[28px] px-2.5 border text-[12px] rounded-xs disabled:opacity-40 cursor-pointer hover:opacity-90 font-semibold flex items-center gap-1.5"
                    title={t('shell.dock.replaySessionTooltip')}
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Replay</span>
                  </button>

                  <button
                    type="button"
                    disabled={sess.count === 0}
                    onClick={() => {
                      const saved = traceSessionsStore.exportSessionToFile(sess.id, 'trc');
                      onStatusMessage({ kind: 'info', message: t('shell.dock.traceDownloaded', { name: saved }) });
                    }}
                    style={{
                      backgroundColor: 'var(--bg-toolbar)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="h-[28px] px-2 border text-[12px] rounded-xs disabled:opacity-40 cursor-pointer hover:border-sky-500"
                    title={t('shell.dock.exportTrcTooltip')}
                  >
                    💾 .trc
                  </button>
                  <button
                    type="button"
                    disabled={sess.count === 0}
                    onClick={() => {
                      const saved = traceSessionsStore.exportSessionToFile(sess.id, 'asc');
                      onStatusMessage({ kind: 'info', message: t('shell.dock.traceDownloaded', { name: saved }) });
                    }}
                    style={{
                      backgroundColor: 'var(--bg-toolbar)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="h-[28px] px-2 border text-[12px] rounded-xs disabled:opacity-40 cursor-pointer hover:border-sky-500"
                    title={t('shell.dock.exportAscTooltip')}
                  >
                    💾 .asc
                  </button>
                  <button
                    type="button"
                    disabled={sess.count === 0}
                    onClick={() => {
                      const saved = traceSessionsStore.exportSessionToFile(sess.id, 'csv');
                      onStatusMessage({ kind: 'info', message: t('shell.dock.traceDownloaded', { name: saved }) });
                    }}
                    style={{
                      backgroundColor: 'var(--bg-toolbar)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="h-[28px] px-2 border text-[12px] rounded-xs disabled:opacity-40 cursor-pointer hover:border-sky-500"
                    title={t('shell.dock.exportCsvTooltip')}
                  >
                    💾 .csv
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      workbenchStore.setSplitSecondaryTab('trace', sess.id);
                      onStatusMessage({ kind: 'info', message: t('shell.dock.traceSplitOpened', { name: sess.name }) });
                    }}
                    style={{
                      backgroundColor: 'var(--bg-toolbar)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-secondary)',
                    }}
                    className="h-[28px] px-2.5 border text-[12px] rounded-xs hover:text-[var(--text-primary)] cursor-pointer"
                    title={t('shell.dock.openInSplitTooltip')}
                  >
                    {t('shell.dock.openInSplit')}
                  </button>

                  {traceState.sessions.length > 1 && (
                    <button
                      type="button"
                      onClick={() => {
                        traceSessionsStore.closeSession(sess.id);
                        workbenchStore.setSelection({ kind: 'project' });
                        onStatusMessage({ kind: 'info', message: t('shell.dock.traceSessionClosed', { name: sess.name }) });
                      }}
                      style={{
                        backgroundColor: 'rgba(239, 68, 68, 0.10)',
                        borderColor: 'rgba(239, 68, 68, 0.35)',
                        color: '#F87171',
                      }}
                      className="h-[28px] px-2.5 border text-[12px] rounded-xs hover:border-red-500 cursor-pointer ml-auto"
                      title={t('shell.dock.closeSessionTooltip')}
                    >
                      {t('shell.dock.closeSession')}
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

          {/* SELECTION: SIGNAL */}
          {workbench.selection.kind === 'signal' && (() => {
            const { busId, signalId } = workbench.selection;
            const busSignals = databaseStore.getBusSignals(busId);
            const sig = busSignals[signalId];
            if (!sig) {
              return (
                <div className="text-[var(--text-muted)] p-2 italic text-center">
                  {t('shell.dock.noSignalSchema')}
                </div>
              );
            }

            const isWatched = workbench.watchSignals.some(
              (w) => w.key === `${busId}:${signalId}`,
            );

            return (
              <div className="space-y-1.5">
                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.propSignal')}</span>
                  <span className="font-semibold text-[var(--text-primary)] truncate" title={sig.name}>
                    {sig.name}
                  </span>
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">Bus</span>
                  <span className="font-mono text-[10px] text-[var(--text-primary)]">
                    Bus {busId + 1}
                  </span>
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.propSignalBits')}</span>
                  <span className="font-mono text-[10px] text-[var(--text-primary)]">
                    Start {sig.startBit} · Len {sig.bitLength} ({sig.byteOrder})
                  </span>
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.propSignalScale')}</span>
                  <span className="font-mono text-[10px] text-[var(--text-primary)]">
                    Factor {sig.factor} · Offset {sig.offset}
                  </span>
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.propSignalRange')}</span>
                  <span className="font-mono text-[10px] text-[var(--text-primary)]">
                    [{sig.min} .. {sig.max}] {sig.unit || ''}
                  </span>
                </div>

                <div className="pt-2 flex gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      workbenchStore.toggleWatchSignal({
                        key: `${busId}:${signalId}`,
                        busId,
                        signalId,
                        name: sig.name,
                        unit: sig.unit || '',
                        min: sig.min,
                        max: sig.max,
                      })
                    }
                    style={{
                      backgroundColor: isWatched ? 'rgba(56, 139, 253, 0.15)' : 'var(--bg-toolbar)',
                      borderColor: isWatched ? 'rgba(56, 139, 253, 0.50)' : 'var(--border-strong)',
                      color: isWatched ? '#58A6FF' : 'var(--text-primary)',
                    }}
                    className="h-[28px] px-2.5 border text-[12px] font-semibold flex items-center gap-1.5 cursor-pointer rounded-xs"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>{isWatched ? t('shell.dock.unwatchTooltip') : t('shell.dock.watchTooltip')}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      plotStore.toggleSignal(busId, sig);
                      databaseStore.setActiveDocTab('plotter');
                    }}
                    style={{
                      backgroundColor: 'var(--bg-toolbar)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="h-[28px] px-2.5 border text-[12px] flex items-center gap-1.5 hover:border-emerald-500 cursor-pointer rounded-xs"
                  >
                    <LineChart className="w-3.5 h-3.5 text-emerald-400" />
                    <span>{t('shell.dock.plotInPlotter')}</span>
                  </button>
                </div>
              </div>
            );
          })()}

          {/* SELECTION: PANEL */}
          {workbench.selection.kind === 'panel' && (() => {
            const panelId = workbench.selection.panelId;
            const panel = simPanels.panels.find((p) => p.id === panelId);
            if (!panel) {
              return (
                <div className="text-[var(--text-muted)] p-2 italic text-center">
                  {t('shell.dock.noPanelFound')}
                </div>
              );
            }

            return (
              <div className="space-y-1.5">
                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.propName')}</span>
                  <span className="font-semibold text-[var(--text-primary)] truncate">{panel.name}</span>
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.propDescription')}</span>
                  <span className="font-mono text-[10px] text-[var(--text-primary)] truncate">
                    {panel.description || '—'}
                  </span>
                </div>

                <div className="grid grid-cols-[85px_1fr] items-center gap-1.5 py-0.5 border-b border-[var(--border-grid)]">
                  <span className="text-[var(--text-secondary)]">{t('shell.dock.propWidgets')}</span>
                  <span className="font-mono text-[10px] text-[var(--text-primary)]">
                    {panel.widgets?.length ?? 0} widget
                  </span>
                </div>

                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => databaseStore.setActiveDocTab('panels')}
                    style={{
                      backgroundColor: 'var(--bg-toolbar)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="h-[28px] px-3 border text-[12px] font-medium hover:border-amber-500 hover:text-amber-400 cursor-pointer rounded-xs"
                  >
                    {t('shell.dock.openSimPanels')}
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      </section>

      {/* ================================================================== */}
      {/* KATMAN 3: WATCH & CLOUD LIVE TABS (~24% height)                   */}
      {/* ================================================================== */}
      <section className="flex flex-col flex-1 min-h-[110px] overflow-hidden">
        {/* Tab Headers (34px) */}
        <div
          style={{
            backgroundColor: 'var(--bg-toolbar)',
            borderBottom: '1px solid var(--border-grid)',
          }}
          className="h-[34px] flex items-center shrink-0 text-[12.5px] px-1"
        >
          <button
            type="button"
            onClick={() => workbenchStore.setBottomTab('watch')}
            style={{
              borderBottom: workbench.bottomTab === 'watch' ? '2px solid #58A6FF' : '2px solid transparent',
              color: workbench.bottomTab === 'watch' ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
            className="h-full px-3 font-medium flex items-center gap-1.5 cursor-pointer hover:text-[var(--text-primary)] transition-colors"
          >
            <Eye className="w-3.5 h-3.5 text-sky-400" />
            <span>{t('shell.dock.tabWatch')}</span>
            <span className="text-[11px] font-mono text-[var(--text-muted)]">
              ({workbench.watchSignals.length + 1})
            </span>
          </button>

          {cloudOn && (
          <button
            type="button"
            onClick={() => workbenchStore.setBottomTab('cloud')}
            style={{
              borderBottom: workbench.bottomTab === 'cloud' ? '2px solid #58A6FF' : '2px solid transparent',
              color: workbench.bottomTab === 'cloud' ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
            className="h-full px-3 font-medium flex items-center gap-1.5 cursor-pointer hover:text-[var(--text-primary)] transition-colors"
          >
            <Cloud className="w-3.5 h-3.5 text-emerald-400" />
            <span>{t('shell.dock.tabCloudLive')}</span>
            {cloudHeader.status === 'streaming' && (
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse ml-0.5" />
            )}
          </button>
          )}
        </div>

        {/* Tab Body */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {(workbench.bottomTab === 'watch' || !cloudOn) && (
            <div className="p-1 font-mono tabular-nums text-[11px]">
              {/* Header row */}
              <div className="grid grid-cols-[40%_30%_30%] px-1.5 py-0.5 text-[10px] font-sans text-[var(--text-muted)] uppercase border-b border-[var(--border-grid)]">
                <span>{t('shell.dock.watchColName')}</span>
                <span className="text-right pr-2">{t('shell.dock.watchColValue')}</span>
                <span className="text-right">{t('shell.dock.watchColMeter')}</span>
              </div>

              {/* Fixed Row: Bus Load */}
              <div className="grid grid-cols-[40%_30%_30%] items-center px-2 h-[28px] border-b border-[var(--border-grid)] hover:bg-[var(--bg-row-hover)] text-[12px]">
                <span className="font-sans text-[var(--text-primary)] truncate" title="Connection Bus Load">
                  {t('shell.dock.watchBusLoad')}
                </span>
                <span className="text-right pr-2 text-[var(--text-primary)] font-semibold font-mono tabular-nums">
                  {header.estimatedBusLoadPct.toFixed(1)} %
                </span>
                <div className="w-full bg-slate-800 h-2.5 rounded-xs overflow-hidden">
                  <div
                    style={{
                      width: `${Math.min(100, Math.max(0, header.estimatedBusLoadPct))}%`,
                      backgroundColor:
                        header.estimatedBusLoadPct > 85
                          ? '#EF4444'
                          : header.estimatedBusLoadPct > 70
                            ? '#F59E0B'
                            : '#10B981',
                    }}
                    className="h-full transition-all duration-300"
                  />
                </div>
              </div>

              {/* Watched Signals */}
              {workbench.watchSignals.map((w) => {
                // Find signal value in latest frames
                let liveVal: number | null = null;
                for (let i = 0; i < framesSlice.frames.length; i++) {
                  const f = framesSlice.frames[i];
                  if (f.busId === w.busId) {
                    const s = f.signals.find((sig) => sig.signalId === w.signalId);
                    if (s) {
                      liveVal = s.physicalValue;
                      break;
                    }
                  }
                }

                const span = w.max - w.min;
                const pct =
                  liveVal !== null && span > 0
                    ? Math.min(100, Math.max(0, ((liveVal - w.min) / span) * 100))
                    : 0;

                return (
                  <div
                    key={w.key}
                    className="group grid grid-cols-[40%_30%_30%] items-center px-2 h-[28px] border-b border-[var(--border-grid)] hover:bg-[var(--bg-row-hover)] text-[12px]"
                  >
                    <div className="flex items-center gap-1 min-w-0 pr-1">
                      <span className="font-sans truncate text-[var(--text-primary)]" title={w.name}>
                        {w.name}
                      </span>
                    </div>

                    <div className="text-right pr-2 truncate">
                      {liveVal !== null ? (
                        <span className="text-sky-400 font-semibold">
                          {Number.isInteger(liveVal) ? liveVal : liveVal.toFixed(2)}
                          {w.unit ? ` ${w.unit}` : ''}
                        </span>
                      ) : (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </div>

                    <div className="flex items-center gap-1">
                      <div className="w-full bg-slate-800 h-2 rounded-xs overflow-hidden">
                        <div
                          style={{ width: `${pct}%`, backgroundColor: '#38BDF8' }}
                          className="h-full transition-all duration-200"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => workbenchStore.removeWatchSignal(w.key)}
                        className="opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-red-400 cursor-pointer shrink-0"
                        title={t('shell.dock.removeWatch')}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}

              {workbench.watchSignals.length === 0 && (
                <div className="p-3 text-[10px] text-[var(--text-muted)] text-center font-sans">
                  {t('shell.dock.watchEmptyHint')}
                </div>
              )}
            </div>
          )}

          {cloudOn && workbench.bottomTab === 'cloud' && (
            <div className="p-2 font-sans text-[11px] space-y-2">
              {!cloudHeader.isAuthenticated ? (
                <div className="space-y-2 text-center p-2">
                  <div className="flex items-center justify-center gap-1.5 text-sky-400 font-bold">
                    <Cloud className="w-4 h-4" />
                    <span>{t('shell.dock.cloudOffline')}</span>
                  </div>
                  <p className="text-[10px] text-[var(--text-secondary)] leading-relaxed">
                    {t('shell.dock.cloudOfflineDesc')}
                  </p>
                  <button
                    type="button"
                    onClick={() => databaseStore.setActiveDocTab('cloud')}
                    style={{
                      backgroundColor: 'rgba(56, 139, 253, 0.15)',
                      borderColor: 'rgba(56, 139, 253, 0.45)',
                      color: '#58A6FF',
                    }}
                    className="h-[28px] px-3.5 border font-semibold text-[12px] rounded-xs cursor-pointer hover:opacity-90"
                  >
                    {t('shell.dock.openCloudSession')}
                  </button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between py-0.5 border-b border-[var(--border-grid)]">
                    <span className="text-[10px] text-[var(--text-primary)] truncate font-mono">
                      👤 {cloudHeader.userEmail}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        void cloudBridgeStore.disconnectAndLogout();
                        onStatusMessage({
                          kind: 'info',
                          message: t('shell.dock.cloudLoggedOut'),
                        });
                      }}
                      className="text-[10px] text-red-400 hover:underline flex items-center gap-1 cursor-pointer shrink-0"
                    >
                      <LogOut className="w-3 h-3" />
                      <span>{t('shell.dock.cloudSignOut')}</span>
                    </button>
                  </div>

                  <div className="flex items-center justify-between text-[10px] py-0.5 border-b border-[var(--border-grid)]">
                    <span className="text-[var(--text-secondary)]">{t('shell.dock.targetProject')}</span>
                    <span className="font-semibold text-[var(--text-primary)] truncate max-w-[130px]">
                      {cloudHeader.selectedProjectName || t('shell.dock.noProjectSelected')}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-[10px] py-0.5 border-b border-[var(--border-grid)]">
                    <span className="text-[var(--text-secondary)]">{t('shell.dock.streamRate')}</span>
                    <select
                      value={cloudHeader.targetHz}
                      onChange={(e) =>
                        cloudBridgeStore.setDesiredHz(
                          Number(e.target.value) as CloudBridgeTargetHz,
                        )
                      }
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor: 'var(--border-strong)',
                        color: 'var(--text-primary)',
                      }}
                      className="h-[20px] px-1 border font-mono text-[10px] rounded-xs"
                    >
                      <option value={10}>10 Hz</option>
                      <option value={15}>15 Hz</option>
                      <option value={20}>20 Hz</option>
                      <option value={30}>30 Hz</option>
                      <option value={60}>60 Hz</option>
                    </select>
                  </div>

                  <div className="pt-1">
                    {cloudHeader.status === 'streaming' ? (
                      <button
                        type="button"
                        onClick={() => cloudBridgeStore.stopLiveStream()}
                        style={{
                          backgroundColor: 'rgba(239, 68, 68, 0.15)',
                          borderColor: 'rgba(239, 68, 68, 0.50)',
                          color: '#F87171',
                        }}
                        className="w-full h-[24px] border font-semibold text-[11px] flex items-center justify-center gap-1.5 hover:opacity-90 cursor-pointer"
                      >
                        <Square className="w-3 h-3" />
                        <span>{t('shell.dock.stopLiveStreamBtn')}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await cloudBridgeStore.resumeLiveStream();
                          } catch (e) {
                            onStatusMessage({
                              kind: 'error',
                              message: t('shell.dock.streamStartError', { error: e instanceof Error ? e.message : String(e) }),
                            });
                          }
                        }}
                        style={{
                          backgroundColor: 'rgba(16, 185, 129, 0.15)',
                          borderColor: 'rgba(16, 185, 129, 0.50)',
                          color: '#34D399',
                        }}
                        className="w-full h-[24px] border font-semibold text-[11px] flex items-center justify-center gap-1.5 hover:opacity-90 cursor-pointer"
                      >
                        <Play className="w-3 h-3" />
                        <span>{t('shell.dock.startLiveStreamBtn')}</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </aside>
  );
};
