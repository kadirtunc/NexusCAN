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
import { useExperimentalCloud } from '../store/experimentalStore';
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
  const cloudOn = useExperimentalCloud();
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
    if (!cloudOn || !projState.cloudBinding?.projectId || !cloudHeader.isAuthenticated) return;
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
      className="fixed inset-0 z-50 bg-[var(--bg-scrim)] flex items-center justify-center p-4 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[840px] max-h-[88vh] border border-hairline bg-panel text-primary shadow-2xl flex flex-col text-[12px] font-sans"
      >
        {/* Header (38px) */}
        <div
          className="h-[38px] px-3.5 bg-canvas border-b border-hairline flex items-center justify-between shrink-0"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <Boxes className="w-4 h-4 text-focus shrink-0" />
            <span className="font-semibold text-[13px] text-primary tracking-wide">
              {t('modal.toolpacks.title')}
            </span>
            <span className="px-2 py-0.5 rounded bg-[var(--status-focus-bg)] border border-[var(--status-focus-border)] text-focus font-mono tabular-nums text-[11px] font-medium shrink-0">
              {t('modal.toolpacks.activeCount', { enabled: enabledCount, total: totalCount })}
            </span>
          </div>
          <button
            type="button"
            onClick={() => projectStore.setToolpacksModalOpen(false)}
            className="text-secondary hover:text-primary cursor-pointer p-1 transition-colors"
            title={t('modal.toolpacks.closeTitle')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Info Banner */}
        <div className="px-4 py-2.5 bg-canvas border-b border-hairline flex items-start gap-2 text-primary text-[11.5px] leading-relaxed shrink-0">
          <Info className="w-4 h-4 text-focus shrink-0 mt-0.5" />
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
                    ? 'bg-surface border-strong'
                    : 'bg-canvas border-hairline opacity-70 hover:opacity-90'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-semibold text-[13px] text-primary">
                        {pack.title}
                      </span>
                      <span className="px-1.5 py-0.2 rounded bg-elevated text-primary font-mono tabular-nums text-[10px] uppercase tracking-wider">
                        {pack.shortBadge}
                      </span>
                      <span className="px-1.5 py-0.2 rounded bg-elevated text-secondary text-[10px]">
                        {pack.category}
                      </span>

                      {/* Release Stage Badge */}
                      {pack.releaseStage === 'active' && (
                        <span className="px-1.5 py-0.2 rounded bg-[var(--status-nominal-bg)] border border-[var(--status-nominal-border)] text-nominal text-[10px] font-medium">
                          {t('modal.toolpacks.stageActive')}
                        </span>
                      )}
                      {pack.releaseStage === 'phase_2' && (
                        <span className="px-1.5 py-0.2 rounded bg-elevated border border-strong text-secondary text-[10px] font-medium">
                          {t('modal.toolpacks.stagePhase2')}
                        </span>
                      )}
                      {pack.releaseStage === 'phase_3' && (
                        <span className="px-1.5 py-0.2 rounded bg-elevated border border-strong text-secondary text-[10px] font-medium">
                          {t('modal.toolpacks.stagePhase3')}
                        </span>
                      )}
                    </div>

                    <p className="text-primary text-[11.5px] leading-relaxed mb-2">
                      {pack.description}
                    </p>

                    <div className="text-[11px] text-secondary mb-2">
                      <span className="text-muted font-medium">
                        {t('modal.toolpacks.targetAudienceLabel')}
                      </span>{' '}
                      {pack.targetAudience}
                    </div>

                    {/* Module tags */}
                    <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-hairline">
                      <span className="text-[10px] text-secondary font-medium mr-1">
                        {t('modal.toolpacks.clientModulesLabel')}
                      </span>
                      {pack.clientModules.map((mod) => (
                        <span
                          key={mod}
                          className="px-1.5 py-0.5 rounded bg-elevated text-primary font-mono text-[10px]"
                        >
                          {mod}
                        </span>
                      ))}
                      {cloudOn && pack.cloudModules.length > 0 && (
                        <>
                          <span className="text-[10px] text-focus font-medium ml-2 mr-1">
                            {t('modal.toolpacks.cloudModulesLabel')}
                          </span>
                          {pack.cloudModules.map((cMod) => (
                            <span
                              key={cMod}
                              className="px-1.5 py-0.5 rounded bg-[var(--status-focus-bg)] border border-[var(--status-focus-border)] text-focus font-mono text-[10px]"
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
                        className="flex items-center gap-1 px-2.5 py-1 rounded bg-elevated text-secondary text-[11px] font-medium cursor-not-allowed select-none"
                      >
                        <Lock className="w-3.5 h-3.5 text-secondary" />
                        <span>{t('modal.toolpacks.coreLockedLabel')}</span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleToggle(pack.id)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-[11px] font-medium transition-colors cursor-pointer ${
                          isEnabled
                            ? 'bg-nominal hover:opacity-90 text-on-accent'
                            : 'bg-elevated hover:bg-hover text-primary'
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
          className="px-4 py-2.5 bg-canvas border-t border-hairline flex items-center justify-between gap-3 shrink-0"
        >
          <div className="flex items-center gap-2 text-secondary text-[11.5px] min-w-0">
            {cloudOn && isCloudBound ? (
              <>
                <Cloud className="w-4 h-4 text-focus shrink-0" />
                <span className="truncate">
                  {t('modal.toolpacks.cloudBoundPrefix')}{' '}
                  <strong className="text-primary">{projState.currentName}</strong>
                </span>
                {syncFeedback && (
                  <span className="ml-2 px-1.5 py-0.5 rounded bg-elevated text-focus font-mono text-[10.5px]">
                    {syncFeedback}
                  </span>
                )}
              </>
            ) : (
              <span>{t('modal.toolpacks.localSaveNotice')}</span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {cloudOn && isCloudBound && cloudHeader.isAuthenticated && (
              <button
                type="button"
                onClick={handleSyncToCloud}
                disabled={cloudSyncing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-focus hover:opacity-90 text-on-accent font-medium text-[11.5px] cursor-pointer disabled:opacity-50 transition-colors"
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
              className="px-4 py-1.5 rounded bg-elevated hover:bg-hover text-primary font-medium text-[11.5px] cursor-pointer transition-colors"
            >
              {t('modal.toolpacks.btnDone')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
