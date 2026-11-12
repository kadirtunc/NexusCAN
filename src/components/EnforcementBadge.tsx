import React from 'react';
import { useI18n } from '../i18n';
import type { ListenOnlyEnforcementKind } from '../types/hal';

/** Per-bus Listen-Only enforcement badge: HW (nominal), SW (warning), VIRTUAL (neutral). */
export const EnforcementBadge: React.FC<{ kind: ListenOnlyEnforcementKind | null }> = ({ kind }) => {
  const { t } = useI18n();
  if (kind === null) return null;
  const cfg =
    kind === 'hardware'
      ? { text: t('sec.enf.hardware'), cls: 'text-emerald-400 border-emerald-600/60', tip: undefined }
      : kind === 'softwareOnly'
        ? { text: t('sec.enf.softwareOnly'), cls: 'text-amber-300 border-amber-500', tip: t('sec.enf.softwareTip') }
        : { text: t('sec.enf.virtual'), cls: 'text-slate-300 border-slate-600', tip: undefined };
  return (
    <span
      title={cfg.tip}
      className={`px-1.5 border text-[10.5px] font-bold font-mono tabular-nums whitespace-nowrap ${cfg.cls}`}
    >
      {cfg.text}
    </span>
  );
};
