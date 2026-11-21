import React, { useState } from 'react';
import { useI18n } from '../i18n';
import { projectStore, useProjectStore } from '../store/projectStore';

/** Shown after opening an external project file: nothing connects until the operator says so. */
export const ImportedProjectNotice: React.FC = () => {
  const { t } = useI18n();
  const proj = useProjectStore();
  const [busy, setBusy] = useState(false);
  const notice = proj.importNotice;
  if (notice === null) return null;
  const count = notice.profileIds.length;
  const problems = notice.diagnosticsProblems;
  const reDropped = notice.reDraftsDropped;
  if (count === 0 && notice.cloudBinding === null && problems.length === 0 && reDropped === 0) return null;

  const btn =
    'h-[24px] px-2 border text-[11px] font-bold cursor-pointer rounded-[3px] disabled:opacity-40';
  return (
    <div
      role="alert"
      className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-[var(--status-warn-border)] bg-[var(--status-warn-bg)] text-warn text-[11.5px]"
    >
      {count > 0 && (
        <>
          <span className="font-mono tabular-nums">{t('sec.import.notice', { count })}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void projectStore.connectImportedProfiles().finally(() => setBusy(false));
            }}
            className={`${btn} border-[var(--status-nominal-border)] text-nominal`}
          >
            {t('sec.import.connect')}
          </button>
        </>
      )}
      {notice.cloudBinding !== null && (
        <>
          <span>{t('sec.import.cloudNotice')}</span>
          <button
            type="button"
            onClick={() => projectStore.adoptImportedCloudBinding()}
            className={`${btn} border-[var(--status-warn-border)] text-warn`}
          >
            {t('sec.import.cloudAdopt')}
          </button>
        </>
      )}
      {problems.length > 0 && (
        <span className="font-mono tabular-nums" title={problems.join('\n')}>
          {t('diagWs.import.problems', { count: problems.length })}
        </span>
      )}
      {reDropped > 0 && <span className="font-mono tabular-nums">{t('re.draft.import.dropped', { count: reDropped })}</span>}
      <button
        type="button"
        onClick={() => projectStore.dismissImportNotice()}
        className={`${btn} border-strong text-secondary`}
      >
        {t('sec.import.dismiss')}
      </button>
    </div>
  );
};
