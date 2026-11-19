import React, { useEffect } from 'react';
import {
  Award,
  BookOpen,
  Code2,
  Heart,
  Scale,
  X,
} from 'lucide-react';
import { projectStore, useProjectStore } from '../store/projectStore';
import { useI18n } from '../i18n';

export const AcknowledgmentsModal: React.FC = () => {
  const { t } = useI18n();
  const projState = useProjectStore();

  useEffect(() => {
    if (!projState.acknowledgmentsModalOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        projectStore.setAcknowledgmentsModalOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [projState.acknowledgmentsModalOpen]);

  if (!projState.acknowledgmentsModalOpen) {
    return null;
  }

  return (
    <div
      onClick={() => projectStore.setAcknowledgmentsModalOpen(false)}
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--bg-panel)',
          borderColor: 'var(--border-strong)',
          color: 'var(--text-primary)',
        }}
        className="w-full max-w-[800px] max-h-[88vh] border shadow-2xl flex flex-col text-[12px] font-sans"
      >
        {/* Header (40px) */}
        <div
          style={{
            backgroundColor: 'var(--bg-header)',
            borderBottom: '1px solid var(--border-strong)',
          }}
          className="h-[40px] px-4 flex items-center justify-between shrink-0"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <Award className="w-4 h-4 text-amber-400 shrink-0" />
            <span className="font-semibold text-[13px] text-[var(--text-primary)] tracking-wide">
              {t('modal.ack.title')}
            </span>
            <span className="px-2 py-0.5 rounded border border-[var(--border-strong)] bg-[var(--bg-toolbar)] text-[var(--text-secondary)] font-mono tabular-nums text-[11px] shrink-0">
              {t('modal.ack.versionBadge')}
            </span>
          </div>
          <button
            type="button"
            onClick={() => projectStore.setAcknowledgmentsModalOpen(false)}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer p-1"
            title={t('modal.ack.closeTitle')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-[var(--text-secondary)] text-[12px] leading-relaxed">
          {/* Mission intro */}
          <div className="p-3.5 bg-[var(--bg-row-signal)] border border-[var(--border-grid)] flex items-start gap-3">
            <Heart className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-[var(--text-primary)] mb-1">
                {t('modal.ack.introHeading')}
              </p>
              <p className="text-[11.5px] text-[var(--text-secondary)]">
                {t('modal.ack.introBody')}
              </p>
            </div>
          </div>

          {/* Section 1: CAN Pioneers */}
          <div>
            <div className="flex items-center gap-2 mb-2 pb-1 border-b border-[var(--border-grid)]">
              <BookOpen className="w-4 h-4 text-cyan-400" />
              <h3 className="font-semibold text-[13px] text-[var(--text-primary)] uppercase tracking-wide">
                {t('modal.ack.sec1Heading')}
              </h3>
            </div>
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11.5px]">
              <li className="p-2.5 bg-[var(--bg-row-signal)] border border-[var(--border-grid)]">
                <div className="font-medium text-[var(--text-primary)]">Linux SocketCAN & can-utils</div>
                <div className="text-[var(--text-muted)] text-[10.5px]">
                  {t('modal.ack.socketcanDesc')}
                </div>
              </li>
              <li className="p-2.5 bg-[var(--bg-row-signal)] border border-[var(--border-grid)]">
                <div className="font-medium text-[var(--text-primary)]">SavvyCAN (MIT)</div>
                <div className="text-[var(--text-muted)] text-[10.5px]">
                  {t('modal.ack.savvycanDesc')}
                </div>
              </li>
              <li className="p-2.5 bg-[var(--bg-row-signal)] border border-[var(--border-grid)]">
                <div className="font-medium text-[var(--text-primary)]">cantools & canmatrix (MIT / BSD)</div>
                <div className="text-[var(--text-muted)] text-[10.5px]">
                  {t('modal.ack.cantoolsDesc')}
                </div>
              </li>
              <li className="p-2.5 bg-[var(--bg-row-signal)] border border-[var(--border-grid)]">
                <div className="font-medium text-[var(--text-primary)]">Kayak (.kcd - LGPLv3)</div>
                <div className="text-[var(--text-muted)] text-[10.5px]">
                  {t('modal.ack.kayakDesc')}
                </div>
              </li>
              <li className="p-2.5 bg-[var(--bg-row-signal)] border border-[var(--border-grid)]">
                <div className="font-medium text-[var(--text-primary)]">PlotJuggler (MPL-2.0)</div>
                <div className="text-[var(--text-muted)] text-[10.5px]">
                  {t('modal.ack.plotjugglerDesc')}
                </div>
              </li>
              <li className="p-2.5 bg-[var(--bg-row-signal)] border border-[var(--border-grid)]">
                <div className="font-medium text-[var(--text-primary)]">Candlelight / gs_usb</div>
                <div className="text-[var(--text-muted)] text-[10.5px]">
                  {t('modal.ack.candlelightDesc')}
                </div>
              </li>
            </ul>
          </div>

          {/* Section 2: Rust Core Engine */}
          <div>
            <div className="flex items-center gap-2 mb-2 pb-1 border-b border-[var(--border-grid)]">
              <Code2 className="w-4 h-4 text-emerald-400" />
              <h3 className="font-semibold text-[13px] text-[var(--text-primary)] uppercase tracking-wide">
                {t('modal.ack.sec2Heading')}
              </h3>
            </div>
            <div className="p-3 bg-[var(--bg-row-signal)] border border-[var(--border-grid)] text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
              <p className="mb-1.5">
                {t('modal.ack.sec2Body')}
              </p>
            </div>
          </div>

          {/* Section 3: Web & UI Stack */}
          <div>
            <div className="flex items-center gap-2 mb-2 pb-1 border-b border-[var(--border-grid)]">
              <Scale className="w-4 h-4 text-sky-400" />
              <h3 className="font-semibold text-[13px] text-[var(--text-primary)] uppercase tracking-wide">
                {t('modal.ack.sec3Heading')}
              </h3>
            </div>
            <div className="p-3 bg-[var(--bg-row-signal)] border border-[var(--border-grid)] text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
              <p>
                {t('modal.ack.sec3Body')}
              </p>
            </div>
          </div>
        </div>

        {/* Footer (42px) */}
        <div
          style={{
            backgroundColor: 'var(--bg-header)',
            borderTop: '1px solid var(--border-strong)',
          }}
          className="h-[42px] px-4 flex items-center justify-between shrink-0"
        >
          <div className="text-[11px] text-[var(--text-secondary)] font-mono tabular-nums">
            {t('modal.ack.copyright')}
          </div>
          <button
            type="button"
            onClick={() => projectStore.setAcknowledgmentsModalOpen(false)}
            className="px-4 py-1.5 rounded border border-[var(--border-strong)] bg-[var(--bg-toolbar)] hover:bg-[var(--bg-row-hover)] text-[var(--text-primary)] font-medium text-[11.5px] cursor-pointer"
          >
            {t('modal.ack.btnClose')}
          </button>
        </div>
      </div>
    </div>
  );
};
