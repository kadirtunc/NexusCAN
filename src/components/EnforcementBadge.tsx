import React from 'react';
import { useI18n } from '../i18n';
import type { ListenOnlyEnforcementKind } from '../types/hal';

/** Per-bus Listen-Only enforcement badge: HW (nominal), SW (warning), VIRTUAL (neutral). */
export const EnforcementBadge: React.FC<{ kind: ListenOnlyEnforcementKind | null }> = ({ kind }) => {
  const { t } = useI18n();
  if (kind === null) return null;
  const cfg =
    kind === 'hardware'
      ? { text: t('sec.enf.hardware'), cls: 'text-nominal border-[var(--status-nominal-border)]', tip: undefined }
      : kind === 'softwareOnly'
        ? { text: t('sec.enf.softwareOnly'), cls: 'text-warn border-[var(--status-warn-border)]', tip: t('sec.enf.softwareTip') }
        : { text: t('sec.enf.virtual'), cls: 'text-secondary border-strong', tip: undefined };
  return (
    <span
      title={cfg.tip}
      className={`px-1.5 border text-[10.5px] font-bold font-mono tabular-nums whitespace-nowrap shrink-0 ${cfg.cls}`}
    >
      {cfg.text}
    </span>
  );
};
