import React from 'react';
import { Compass, Info } from 'lucide-react';
import { useI18n } from '../i18n';
import { onboardingStore } from '../store/onboardingStore';
import { startPageTour } from './driverTour';
import type { GuidePageId } from './types';

/** Persistent page-header info button; opens the page guide dialog. */
export const GuideInfoButton: React.FC<{ pageId: GuidePageId; tourAnchor?: string }> = ({
  pageId,
  tourAnchor,
}) => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      data-tour={tourAnchor}
      onClick={() => onboardingStore.openDialog(pageId)}
      style={{
        backgroundColor: 'var(--bg-panel)',
        borderColor: 'var(--border-strong)',
        color: 'var(--text-secondary)',
      }}
      className="h-[28px] w-[28px] border flex items-center justify-center hover:text-[var(--text-primary)] cursor-pointer"
      title={t('onb.info.tooltip')}
      aria-label={t('onb.info.tooltip')}
    >
      <Info className="w-3.5 h-3.5" aria-hidden="true" />
    </button>
  );
};

/** Persistent "Start Tour" button; always visible regardless of strip dismissal. */
export const GuideTourButton: React.FC<{ pageId: GuidePageId }> = ({ pageId }) => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => startPageTour(pageId)}
      style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--status-focus)', color: 'var(--status-focus)' }}
      className="h-[28px] px-2.5 border flex items-center gap-1.5 hover:brightness-125 cursor-pointer"
      title={t('onb.dialog.startTour')}
    >
      <Compass className="w-3.5 h-3.5" aria-hidden="true" />
      <span>{t('onb.dialog.startTour')}</span>
    </button>
  );
};

/** Inline "Why?" link; opens the guide dialog directly at a section. Informational only. */
export const GuideWhyLink: React.FC<{ pageId: GuidePageId; sectionId: string }> = ({
  pageId,
  sectionId,
}) => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => onboardingStore.openDialog(pageId, sectionId)}
      title={t('onb.why.tooltip')}
      className="text-[11.5px] text-focus underline cursor-pointer hover:text-primary"
    >
      {t('onb.why.link')}
    </button>
  );
};
