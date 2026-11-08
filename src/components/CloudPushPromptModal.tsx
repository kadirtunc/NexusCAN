import React, { useEffect, useState } from 'react';
import {
  cloudBridgeStore,
  suggestCloudProjectCode,
  useCloudBridgeHeader,
  useCloudBridgeStore,
} from '../store/cloudBridgeStore';
import {
  type QuickBarConnectionState,
  useProjectStore,
} from '../store/projectStore';
import {
  Cloud,
  X,
  PlusCircle,
  Link2,
  AlertCircle,
  Loader2,
  Check,
} from 'lucide-react';
import { useI18n } from '../i18n';

export interface CloudPushPromptModalProps {
  quickBarState?: QuickBarConnectionState;
  onStatusMessage?: (banner: {
    kind: 'info' | 'success' | 'error';
    message: string;
  }) => void;
}

export const CloudPushPromptModal: React.FC<CloudPushPromptModalProps> = ({
  quickBarState,
  onStatusMessage,
}) => {
  const { t } = useI18n();
  const cloudHeader = useCloudBridgeHeader();
  const cloudState = useCloudBridgeStore();
  const projState = useProjectStore();

  const ctx = cloudState.pushPromptContext;

  const [activeMode, setActiveMode] = useState<'create_new' | 'link_existing'>(
    'create_new',
  );
  const [selectedOrgId, setSelectedOrgId] = useState<string>('');
  const [projectNameInput, setProjectNameInput] = useState<string>('');
  const [projectCodeInput, setProjectCodeInput] = useState<string>('');
  const [codeManuallyEdited, setCodeManuallyEdited] = useState<boolean>(false);
  const [defaultProtocol, setDefaultProtocol] = useState<
    'CAN' | 'CAN_FD' | 'J1939'
  >('CAN_FD');
  const [commitMessageInput, setCommitMessageInput] = useState<string>('');
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Initialize or reset form state whenever prompt context opens
  useEffect(() => {
    if (!ctx) return;

    const initialName =
      ctx.projectName.trim() || projState.currentName.trim() || t('cloud.prompt.defaultProjectName');
    setProjectNameInput(initialName);
    setProjectCodeInput(suggestCloudProjectCode(initialName));
    setCodeManuallyEdited(false);
    setDefaultProtocol('CAN_FD');
    setErrorMessage(null);

    const initialCommit =
      ctx.reason === 'opened_project'
        ? t('cloud.prompt.commitInitialOpened', { name: initialName })
        : ctx.reason === 'new_project'
          ? t('cloud.prompt.commitInitialNew', { name: initialName })
          : t('cloud.prompt.commitInitialManual', { name: initialName });
    setCommitMessageInput(initialCommit);

    const initialOrgId =
      cloudState.selectedOrgId || cloudState.organizations[0]?.id || '';
    setSelectedOrgId(initialOrgId);

    // If project already has a matching cloud binding, preselect link_existing mode
    const boundId = projState.cloudBinding?.projectId;
    const matchingProject = boundId
      ? cloudState.projects.find((p) => p.id === boundId)
      : undefined;

    if (matchingProject) {
      setActiveMode('link_existing');
      setSelectedProjectId(matchingProject.id);
    } else if (cloudState.projects.length > 0 && activeMode === 'link_existing') {
      setSelectedProjectId(cloudState.projects[0].id);
    } else {
      setActiveMode('create_new');
      if (cloudState.projects.length > 0) {
        setSelectedProjectId(cloudState.projects[0].id);
      }
    }
  }, [ctx, cloudState.organizations, cloudState.projects, cloudState.selectedOrgId, projState.cloudBinding, projState.currentName, t]);

  // Clean keyboard handling: Escape closes modal without firing global shortcuts
  useEffect(() => {
    if (!ctx || !cloudHeader.isAuthenticated) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cloudBridgeStore.closePushPrompt();
        onStatusMessage?.({
          kind: 'info',
          message: t('cloud.prompt.cancelStatus'),
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [ctx, cloudHeader.isAuthenticated, onStatusMessage, t]);

  if (!cloudHeader.hasPushPrompt || !cloudHeader.isAuthenticated || !ctx) {
    return null;
  }

  const handleNameChange = (newName: string) => {
    setProjectNameInput(newName);
    if (!codeManuallyEdited) {
      setProjectCodeInput(suggestCloudProjectCode(newName));
    }
  };

  const handleCodeChange = (newCode: string) => {
    setCodeManuallyEdited(true);
    setProjectCodeInput(newCode.toUpperCase().replace(/[^A-Z0-9-]/g, ''));
  };

  const handleCancelKeepLocal = () => {
    cloudBridgeStore.closePushPrompt();
    onStatusMessage?.({
      kind: 'info',
      message: t('cloud.prompt.cancelStatus'),
    });
  };

  const handlePushToCloud = async () => {
    if (activeMode === 'create_new') {
      if (!projectNameInput.trim()) {
        setErrorMessage(t('cloud.prompt.nameRequired'));
        return;
      }
      if (!projectCodeInput.trim()) {
        setErrorMessage(t('cloud.prompt.codeRequired'));
        return;
      }
    } else if (activeMode === 'link_existing') {
      if (!selectedProjectId) {
        setErrorMessage(t('cloud.prompt.projectSelectRequired'));
        return;
      }
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await cloudBridgeStore.pushActiveLocalProjectToCloud({
        mode: activeMode,
        quickBarState,
        orgId: activeMode === 'create_new' ? selectedOrgId || undefined : undefined,
        projectName: projectNameInput.trim(),
        projectCode: projectCodeInput.trim().toUpperCase(),
        defaultProtocol,
        commitMessage: commitMessageInput.trim() || undefined,
        targetProjectId: activeMode === 'link_existing' ? selectedProjectId : undefined,
      });

      cloudBridgeStore.closePushPrompt();
      onStatusMessage?.({
        kind: 'success',
        message: t('cloud.prompt.pushSuccess', {
          name: res.project.name,
          code: res.project.code,
          rev: res.revisionNumber,
        }),
      });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const reasonDescription = (() => {
    switch (ctx.reason) {
      case 'opened_project':
        return t('cloud.prompt.reasonOpened', { name: ctx.projectName });
      case 'new_project':
        return t('cloud.prompt.reasonNew', { name: ctx.projectName });
      case 'manual':
      default:
        return t('cloud.prompt.reasonManual', { name: ctx.projectName });
    }
  })();

  return (
    <div
      onClick={handleCancelKeepLocal}
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: '#0F1623',
          borderColor: '#1E293B',
          color: '#F1F5F9',
        }}
        className="w-full max-w-[580px] border shadow-2xl flex flex-col text-[12px] font-sans"
      >
        {/* Header */}
        <div
          style={{
            backgroundColor: '#0B0F17',
            borderBottom: '1px solid #1E293B',
          }}
          className="h-[36px] px-3.5 flex items-center justify-between"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Cloud className="w-4 h-4 text-sky-400 shrink-0" />
            <span className="font-semibold text-[13px] text-slate-100 truncate">
              {t('cloud.prompt.title')}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-emerald-950/70 border border-emerald-700/60 text-emerald-300 font-mono tabular-nums text-[10px] shrink-0">
              {cloudState.cloudBaseUrl} · {cloudState.userEmail || t('cloud.prompt.loggedIn')}
            </span>
          </div>
          <button
            type="button"
            onClick={handleCancelKeepLocal}
            className="text-slate-400 hover:text-slate-200 cursor-pointer p-1"
            title={t('cloud.prompt.closeTitle')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-4 space-y-4">
          {/* Context Explanation */}
          <div
            style={{
              backgroundColor: '#0B0F17',
              borderColor: '#1E293B',
            }}
            className="p-3 border text-[12px] text-slate-300 leading-relaxed"
          >
            {reasonDescription}
          </div>

          {/* Mode Tabs */}
          <div className="flex border border-slate-800 bg-[#0B0F17] p-0.5 rounded-sm">
            <button
              type="button"
              onClick={() => setActiveMode('create_new')}
              className={`flex-1 h-[28px] px-2.5 flex items-center justify-center gap-1.5 text-[11px] font-medium cursor-pointer transition-colors ${
                activeMode === 'create_new'
                  ? 'bg-slate-800 text-slate-100 font-semibold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <PlusCircle className="w-3.5 h-3.5 text-emerald-400" />
              <span>{t('cloud.prompt.tabCreate')}</span>
            </button>
            <button
              type="button"
              disabled={cloudState.projects.length === 0}
              onClick={() => setActiveMode('link_existing')}
              title={
                cloudState.projects.length === 0
                  ? t('cloud.prompt.tabLinkDisabledTooltip')
                  : undefined
              }
              className={`flex-1 h-[28px] px-2.5 flex items-center justify-center gap-1.5 text-[11px] font-medium cursor-pointer transition-colors ${
                activeMode === 'link_existing'
                  ? 'bg-slate-800 text-slate-100 font-semibold shadow-sm'
                  : cloudState.projects.length === 0
                    ? 'text-slate-600 cursor-not-allowed'
                    : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Link2 className="w-3.5 h-3.5 text-sky-400" />
              <span>{t('cloud.prompt.tabLink')}</span>
            </button>
          </div>

          {/* Form Content */}
          {activeMode === 'create_new' ? (
            <div className="space-y-3 pt-1">
              {/* Organization Selector */}
              {cloudState.organizations.length > 1 ? (
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    {t('cloud.prompt.orgLabel')}
                  </label>
                  <select
                    value={selectedOrgId}
                    onChange={(e) => setSelectedOrgId(e.target.value)}
                    style={{
                      backgroundColor: '#0B0F17',
                      borderColor: '#1E293B',
                      color: '#F1F5F9',
                    }}
                    className="w-full h-[28px] px-2 border text-[12px] focus:outline-none focus:border-sky-500"
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
                  <label className="block text-[11px] text-slate-400 mb-1">
                    {t('cloud.prompt.orgLabel')}
                  </label>
                  <div
                    style={{
                      backgroundColor: '#0B0F17',
                      borderColor: '#1E293B',
                      color: '#F1F5F9',
                    }}
                    className="w-full h-[28px] px-2 border text-[12px] flex items-center justify-between font-mono text-[11px]"
                  >
                    <span className="text-slate-200">
                      {cloudState.organizations[0].name}
                    </span>
                    <span className="text-sky-400">
                      (@{cloudState.organizations[0].slug} · {cloudState.organizations[0].myRole})
                    </span>
                  </div>
                </div>
              ) : null}

              {/* Project Name and Code */}
              <div className="grid grid-cols-3 gap-2.5">
                <div className="col-span-2">
                  <label className="block text-[11px] text-slate-400 mb-1">
                    {t('cloud.prompt.nameLabel')}
                  </label>
                  <input
                    type="text"
                    value={projectNameInput}
                    onChange={(e) => handleNameChange(e.target.value)}
                    placeholder={t('cloud.prompt.namePlaceholder')}
                    style={{
                      backgroundColor: '#0B0F17',
                      borderColor: '#1E293B',
                      color: '#F1F5F9',
                    }}
                    className="w-full h-[28px] px-2 border text-[12px] focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    {t('cloud.prompt.codeLabel')}
                  </label>
                  <input
                    type="text"
                    maxLength={16}
                    value={projectCodeInput}
                    onChange={(e) => handleCodeChange(e.target.value)}
                    placeholder={t('cloud.prompt.codePlaceholder')}
                    style={{
                      backgroundColor: '#0B0F17',
                      borderColor: '#1E293B',
                      color: '#38BDF8',
                    }}
                    className="w-full h-[28px] px-2 border text-[12px] font-mono tabular-nums uppercase focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

              {/* Protocol Selector */}
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  {t('cloud.prompt.protoLabel')}
                </label>
                <div className="flex gap-2">
                  {(['CAN_FD', 'CAN', 'J1939'] as const).map((proto) => (
                    <button
                      key={proto}
                      type="button"
                      onClick={() => setDefaultProtocol(proto)}
                      style={{
                        backgroundColor:
                          defaultProtocol === proto
                            ? 'rgba(56, 189, 248, 0.15)'
                            : '#0B0F17',
                        borderColor:
                          defaultProtocol === proto ? '#38BDF8' : '#1E293B',
                        color:
                          defaultProtocol === proto ? '#38BDF8' : '#94A3B8',
                      }}
                      className="flex-1 h-[26px] px-2 border font-mono tabular-nums text-[11px] font-semibold cursor-pointer"
                    >
                      {proto === 'CAN_FD'
                        ? t('cloud.prompt.protoCanFd')
                        : proto === 'CAN'
                          ? t('cloud.prompt.protoCan')
                          : t('cloud.prompt.protoJ1939')}
                    </button>
                  ))}
                </div>
              </div>

              {/* Commit Note */}
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  {t('cloud.prompt.commitLabel')}
                </label>
                <input
                  type="text"
                  value={commitMessageInput}
                  onChange={(e) => setCommitMessageInput(e.target.value)}
                  placeholder={t('cloud.prompt.commitPlaceholder')}
                  style={{
                    backgroundColor: '#0B0F17',
                    borderColor: '#1E293B',
                    color: '#F1F5F9',
                  }}
                  className="w-full h-[28px] px-2 border text-[12px] focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-3 pt-1">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  {t('cloud.prompt.selectTargetLabel')}
                </label>
                <select
                  value={selectedProjectId}
                  onChange={(e) => setSelectedProjectId(e.target.value)}
                  style={{
                    backgroundColor: '#0B0F17',
                    borderColor: '#1E293B',
                    color: '#F1F5F9',
                  }}
                  className="w-full h-[30px] px-2 border font-mono tabular-nums text-[12px] focus:outline-none focus:border-sky-500"
                >
                  {cloudState.projects.map((proj) => {
                    const org = cloudState.organizations.find(
                      (o) => o.id === proj.orgId,
                    );
                    const orgPrefix = org ? `[${org.name}] ` : '';
                    return (
                      <option key={proj.id} value={proj.id}>
                        {orgPrefix}[{proj.code}] {proj.name} (Rev #{proj.latestRevisionNumber ?? 1})
                      </option>
                    );
                  })}
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  {t('cloud.prompt.commitExistingLabel')}
                </label>
                <input
                  type="text"
                  value={commitMessageInput}
                  onChange={(e) => setCommitMessageInput(e.target.value)}
                  placeholder={t('cloud.prompt.commitExistingPlaceholder')}
                  style={{
                    backgroundColor: '#0B0F17',
                    borderColor: '#1E293B',
                    color: '#F1F5F9',
                  }}
                  className="w-full h-[28px] px-2 border text-[12px] focus:outline-none focus:border-sky-500"
                />
              </div>

              <div className="text-[11px] text-amber-400/90 bg-amber-950/20 border border-amber-900/40 p-2 leading-relaxed">
                {t('cloud.prompt.overwriteWarning')}
              </div>
            </div>
          )}

          {/* Error Banner */}
          {errorMessage && (
            <div className="p-2.5 bg-red-950/30 border border-red-800/60 text-red-300 text-[11px] flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div
          style={{
            backgroundColor: '#0B0F17',
            borderTop: '1px solid #1E293B',
          }}
          className="h-[46px] px-4 flex items-center justify-between"
        >
          <button
            type="button"
            disabled={isSubmitting}
            onClick={handleCancelKeepLocal}
            style={{
              backgroundColor: '#1E293B',
              borderColor: '#334155',
              color: '#CBD5E1',
            }}
            className="h-[28px] px-3 border text-[11px] font-medium hover:text-slate-100 hover:border-slate-500 cursor-pointer disabled:opacity-50"
          >
            {t('cloud.prompt.keepLocalBtn')}
          </button>

          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => void handlePushToCloud()}
            style={{
              backgroundColor: 'rgba(56, 189, 248, 0.18)',
              borderColor: '#38BDF8',
              color: '#F8FAFC',
            }}
            className="h-[28px] px-4 border text-[11px] font-semibold flex items-center gap-1.5 hover:bg-sky-500/25 cursor-pointer disabled:opacity-50"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
                <span>{t('cloud.prompt.submitting')}</span>
              </>
            ) : (
              <>
                <Check className="w-3.5 h-3.5 text-sky-400" />
                <span>{t('cloud.prompt.submitBtn')}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
