import React from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../i18n';
import { onboardingStore, useOnboardingStore } from '../store/onboardingStore';
import { startPageTour } from './driverTour';
import type { GuidePageId } from './types';

interface GuideStripProps {
  pageId: GuidePageId;
}

/** First-visit dismissible strip. Generic: driven by the page id. Never opens a dialog automatically. */
export const GuideStrip: React.FC<GuideStripProps> = ({ pageId }) => {
  const { t } = useI18n();
  const state = useOnboardingStore();
  if (state.seenPages.includes(pageId)) return null;

  const btn =
    'h-[24px] px-2.5 border text-[11.5px] cursor-pointer rounded-[3px] hover:border-[var(--text-secondary)]';
  return (
    <div
      role="note"
      style={{ backgroundColor: 'var(--bg-toolbar)', borderBottom: '1px solid var(--border-strong)' }}
      className="shrink-0 min-h-[32px] py-1 px-3 flex items-center gap-2 text-[12px] text-[var(--text-secondary)]"
    >
      <span className="flex-1 min-w-0">{t('onb.strip.text')}</span>
      <button
        type="button"
        onClick={() => startPageTour(pageId)}
        style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--status-focus)', color: 'var(--status-focus)' }}
        className={btn}
      >
        {t('onb.dialog.startTour')}
      </button>
      <button
        type="button"
        onClick={() => onboardingStore.openDialog(pageId)}
        style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-strong)' }}
        className={btn}
      >
        {t('onb.strip.info')}
      </button>
      <button
        type="button"
        onClick={() => onboardingStore.markSeen(pageId)}
        aria-label={t('onb.btn.close')}
        title={t('onb.btn.close')}
        className="w-[24px] h-[24px] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
      >
        <X className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </div>
  );
};
