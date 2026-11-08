import React, { useEffect, useState } from 'react';
import {
  Boxes,
  Check,
  Cloud,
  CloudUpload,
  Info,
  Loader2,
  Lock,
  X,
} from 'lucide-react';
import {
  type EngineeringToolpackDefinitionDto,
  type EngineeringToolpackId,
  getLocalizedToolpackCatalog,
  isToolpackEnabled,
} from '../types/toolpacks';
import {
  type QuickBarConnectionState,
  projectStore,
  useProjectStore,
} from '../store/projectStore';
import { cloudBridgeStore, useCloudBridgeHeader } from '../store/cloudBridgeStore';
import { useI18n } from '../i18n';

export interface ToolpacksModalProps {
  quickBarState?: QuickBarConnectionState;
  onStatusMessage?: (banner: {
    kind: 'info' | 'success' | 'error';
    message: string;
  }) => void;
}

export const ToolpacksModal: React.FC<ToolpacksModalProps> = ({
  quickBarState,
  onStatusMessage,
}) => {
  const { t, locale } = useI18n();
  const projState = useProjectStore();
  const cloudHeader = useCloudBridgeHeader();
  const [cloudSyncing, setCloudSyncing] = useState<boolean>(false);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (!projState.toolpacksModalOpen) {
      setSyncFeedback(null);
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        projectStore.setToolpacksModalOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [projState.toolpacksModalOpen]);

  if (!projState.toolpacksModalOpen) {
    return null;
  }

  const catalog = getLocalizedToolpackCatalog(locale);
  const enabledCount = projState.enabledToolpacks.length;
  const totalCount = catalog.length;
  const isCloudBound = Boolean(projState.cloudBinding?.projectId);

  const handleToggle = (id: EngineeringToolpackId) => {
    projectStore.toggleToolpack(id, quickBarState);
  };

  const handleSyncToCloud = async () => {
    if (!projState.cloudBinding?.projectId || !cloudHeader.isAuthenticated) return;
    setCloudSyncing(true);
    setSyncFeedback(null);
    try {
      const res = await cloudBridgeStore.updateProjectToolpacksOnCloud(
        projState.enabledToolpacks,
        projState.cloudBinding.projectId,
      );
      const msg = t('modal.toolpacks.syncSuccess', { rev: res.revisionNumber ?? 1 });
      setSyncFeedback(msg);
      onStatusMessage?.({ kind: 'success', message: msg });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const fullMsg = t('modal.toolpacks.syncError', { error: errMsg });
      setSyncFeedback(fullMsg);
      onStatusMessage?.({ kind: 'error', message: errMsg });
    } finally {
      setCloudSyncing(false);
    }
  };

  return (
    <div
      onClick={() => projectStore.setToolpacksModalOpen(false)}
      className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: '#0F1623',
          borderColor: '#1E293B',
          color: '#F1F5F9',
        }}
        className="w-full max-w-[840px] max-h-[88vh] border shadow-2xl flex flex-col text-[12px] font-sans"
      >
        {/* Header (38px) */}
        <div
          style={{
            backgroundColor: '#0B0F17',
            borderBottom: '1px solid #1E293B',
          }}
          className="h-[38px] px-3.5 flex items-center justify-between shrink-0"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <Boxes className="w-4 h-4 text-cyan-400 shrink-0" />
            <span className="font-semibold text-[13px] text-slate-100 tracking-wide">
              {t('modal.toolpacks.title')}
            </span>
            <span className="px-2 py-0.5 rounded bg-cyan-950/70 border border-cyan-700/60 text-cyan-300 font-mono tabular-nums text-[11px] font-medium shrink-0">
              {t('modal.toolpacks.activeCount', { enabled: enabledCount, total: totalCount })}
            </span>
          </div>
          <button
            type="button"
            onClick={() => projectStore.setToolpacksModalOpen(false)}
            className="text-slate-400 hover:text-slate-200 cursor-pointer p-1 transition-colors"
            title={t('modal.toolpacks.closeTitle')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Info Banner */}
        <div className="px-4 py-2.5 bg-slate-950/60 border-b border-slate-800/80 flex items-start gap-2 text-slate-300 text-[11.5px] leading-relaxed shrink-0">
          <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
          <div>{t('modal.toolpacks.infoBanner')}</div>
        </div>

        {/* Scrollable Toolpacks List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {catalog.map((pack: EngineeringToolpackDefinitionDto) => {
            const isEnabled = isToolpackEnabled(projState.enabledToolpacks, pack.id);
            const isCore = pack.alwaysEnabled;

            return (
              <div
                key={pack.id}
                className={`p-3.5 border transition-colors ${
                  isEnabled
                    ? 'bg-slate-900/90 border-slate-700'
                    : 'bg-slate-950/40 border-slate-800/60 opacity-70 hover:opacity-90'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-semibold text-[13px] text-slate-100">
                        {pack.title}
                      </span>
                      <span className="px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 font-mono tabular-nums text-[10px] uppercase tracking-wider">
                        {pack.shortBadge}
                      </span>
                      <span className="px-1.5 py-0.2 rounded bg-slate-800/80 text-slate-400 text-[10px]">
                        {pack.category}
                      </span>

                      {/* Release Stage Badge */}
                      {pack.releaseStage === 'active' && (
                        <span className="px-1.5 py-0.2 rounded bg-emerald-950/70 border border-emerald-700/60 text-emerald-300 text-[10px] font-medium">
                          {t('modal.toolpacks.stageActive')}
                        </span>
                      )}
                      {pack.releaseStage === 'phase_2' && (
                        <span className="px-1.5 py-0.2 rounded bg-amber-950/70 border border-amber-700/60 text-amber-300 text-[10px] font-medium">
                          {t('modal.toolpacks.stagePhase2')}
                        </span>
                      )}
                      {pack.releaseStage === 'phase_3' && (
                        <span className="px-1.5 py-0.2 rounded bg-indigo-950/70 border border-indigo-700/60 text-indigo-300 text-[10px] font-medium">
                          {t('modal.toolpacks.stagePhase3')}
                        </span>
                      )}
                    </div>

                    <p className="text-slate-300 text-[11.5px] leading-relaxed mb-2">
                      {pack.description}
                    </p>

                    <div className="text-[11px] text-slate-400 mb-2">
                      <span className="text-slate-500 font-medium">
                        {t('modal.toolpacks.targetAudienceLabel')}
                      </span>{' '}
                      {pack.targetAudience}
                    </div>

                    {/* Module tags */}
                    <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-slate-800/60">
                      <span className="text-[10px] text-slate-400 font-medium mr-1">
                        {t('modal.toolpacks.clientModulesLabel')}
                      </span>
                      {pack.clientModules.map((mod) => (
                        <span
                          key={mod}
                          className="px-1.5 py-0.5 rounded bg-slate-800/90 text-slate-300 font-mono text-[10px]"
                        >
                          {mod}
                        </span>
                      ))}
                      {pack.cloudModules.length > 0 && (
                        <>
                          <span className="text-[10px] text-sky-400 font-medium ml-2 mr-1">
                            {t('modal.toolpacks.cloudModulesLabel')}
                          </span>
                          {pack.cloudModules.map((cMod) => (
                            <span
                              key={cMod}
                              className="px-1.5 py-0.5 rounded bg-sky-950/50 border border-sky-800/40 text-sky-300 font-mono text-[10px]"
                            >
                              {cMod}
                            </span>
                          ))}
                        </>
                      )}
                    </div>
                  </div>

                  {/* Switch / Toggle Button */}
                  <div className="shrink-0 pt-0.5">
                    {isCore ? (
                      <div
                        title={t('modal.toolpacks.coreLockedTitle')}
                        className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 text-slate-400 text-[11px] font-medium cursor-not-allowed select-none"
                      >
                        <Lock className="w-3.5 h-3.5 text-slate-400" />
                        <span>{t('modal.toolpacks.coreLockedLabel')}</span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleToggle(pack.id)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-[11px] font-medium transition-colors cursor-pointer ${
                          isEnabled
                            ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                            : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                        }`}
                      >
                        {isEnabled ? (
                          <>
                            <Check className="w-3.5 h-3.5" />
                            <span>{t('modal.toolpacks.toggleOn')}</span>
                          </>
                        ) : (
                          <span>{t('modal.toolpacks.toggleOff')}</span>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer (46px) */}
        <div
          style={{
            backgroundColor: '#0B0F17',
            borderTop: '1px solid #1E293B',
          }}
          className="px-4 py-2.5 flex items-center justify-between gap-3 shrink-0"
        >
          <div className="flex items-center gap-2 text-slate-400 text-[11.5px] min-w-0">
            {isCloudBound ? (
              <>
                <Cloud className="w-4 h-4 text-sky-400 shrink-0" />
                <span className="truncate">
                  {t('modal.toolpacks.cloudBoundPrefix')}{' '}
                  <strong className="text-slate-200">{projState.currentName}</strong>
                </span>
                {syncFeedback && (
                  <span className="ml-2 px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300 font-mono text-[10.5px]">
                    {syncFeedback}
                  </span>
                )}
              </>
            ) : (
              <span>{t('modal.toolpacks.localSaveNotice')}</span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isCloudBound && cloudHeader.isAuthenticated && (
              <button
                type="button"
                onClick={handleSyncToCloud}
                disabled={cloudSyncing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white font-medium text-[11.5px] cursor-pointer disabled:opacity-50 transition-colors"
                title={t('modal.toolpacks.syncButtonTitle')}
              >
                {cloudSyncing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <CloudUpload className="w-3.5 h-3.5" />
                )}
                <span>{t('modal.toolpacks.syncButton')}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => projectStore.setToolpacksModalOpen(false)}
              className="px-4 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-[11.5px] cursor-pointer transition-colors"
            >
              {t('modal.toolpacks.btnDone')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
