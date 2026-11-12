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
  if (count === 0 && notice.cloudBinding === null) return null;

  const btn =
    'h-[24px] px-2 border text-[11px] font-bold cursor-pointer rounded-[3px] disabled:opacity-40';
  return (
    <div
      role="alert"
      className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-amber-500/70 bg-amber-900/20 text-amber-200 text-[11.5px]"
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
            className={`${btn} border-emerald-500 text-emerald-300`}
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
            className={`${btn} border-amber-400 text-amber-200`}
          >
            {t('sec.import.cloudAdopt')}
          </button>
        </>
      )}
      <button
        type="button"
        onClick={() => projectStore.dismissImportNotice()}
        className={`${btn} border-slate-500 text-slate-300`}
      >
        {t('sec.import.dismiss')}
      </button>
    </div>
  );
};
