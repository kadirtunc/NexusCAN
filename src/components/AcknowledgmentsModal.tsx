import React, { useEffect } from 'react';
import {
  Award,
  BookOpen,
  Code2,
  Heart,
  Scale,
  ShieldCheck,
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
      className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: '#0F1623',
          borderColor: '#1E293B',
          color: '#F1F5F9',
        }}
        className="w-full max-w-[800px] max-h-[88vh] border shadow-2xl flex flex-col text-[12px] font-sans"
      >
        {/* Header (40px) */}
        <div
          style={{
            backgroundColor: '#0B0F17',
            borderBottom: '1px solid #1E293B',
          }}
          className="h-[40px] px-4 flex items-center justify-between shrink-0"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <Award className="w-4 h-4 text-amber-400 shrink-0" />
            <span className="font-semibold text-[13px] text-slate-100 tracking-wide">
              {t('modal.ack.title')}
            </span>
            <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono tabular-nums text-[11px] shrink-0">
              {t('modal.ack.versionBadge')}
            </span>
          </div>
          <button
            type="button"
            onClick={() => projectStore.setAcknowledgmentsModalOpen(false)}
            className="text-slate-400 hover:text-slate-200 cursor-pointer p-1 transition-colors"
            title={t('modal.ack.closeTitle')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-slate-300 text-[12px] leading-relaxed">
          {/* Mission intro */}
          <div className="p-3.5 bg-slate-950/70 border border-slate-800 flex items-start gap-3">
            <Heart className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-slate-100 mb-1">
                {t('modal.ack.introHeading')}
              </p>
              <p className="text-[11.5px] text-slate-300">
                {t('modal.ack.introBody')}
              </p>
            </div>
          </div>

          {/* Section 1: CAN Pioneers */}
          <div>
            <div className="flex items-center gap-2 mb-2 pb-1 border-b border-slate-800">
              <BookOpen className="w-4 h-4 text-cyan-400" />
              <h3 className="font-semibold text-[13px] text-slate-100 uppercase tracking-wide">
                {t('modal.ack.sec1Heading')}
              </h3>
            </div>
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11.5px]">
              <li className="p-2.5 bg-slate-900/60 border border-slate-800/80">
                <div className="font-medium text-slate-200">Linux SocketCAN & can-utils</div>
                <div className="text-slate-400 text-[10.5px]">
                  {t('modal.ack.socketcanDesc')}
                </div>
              </li>
              <li className="p-2.5 bg-slate-900/60 border border-slate-800/80">
                <div className="font-medium text-slate-200">SavvyCAN (MIT)</div>
                <div className="text-slate-400 text-[10.5px]">
                  {t('modal.ack.savvycanDesc')}
                </div>
              </li>
              <li className="p-2.5 bg-slate-900/60 border border-slate-800/80">
                <div className="font-medium text-slate-200">cantools & canmatrix (MIT / BSD)</div>
                <div className="text-slate-400 text-[10.5px]">
                  {t('modal.ack.cantoolsDesc')}
                </div>
              </li>
              <li className="p-2.5 bg-slate-900/60 border border-slate-800/80">
                <div className="font-medium text-slate-200">Kayak (.kcd - LGPLv3)</div>
                <div className="text-slate-400 text-[10.5px]">
                  {t('modal.ack.kayakDesc')}
                </div>
              </li>
              <li className="p-2.5 bg-slate-900/60 border border-slate-800/80">
                <div className="font-medium text-slate-200">PlotJuggler (MPL-2.0)</div>
                <div className="text-slate-400 text-[10.5px]">
                  {t('modal.ack.plotjugglerDesc')}
                </div>
              </li>
              <li className="p-2.5 bg-slate-900/60 border border-slate-800/80">
                <div className="font-medium text-slate-200">Candlelight / gs_usb</div>
                <div className="text-slate-400 text-[10.5px]">
                  {t('modal.ack.candlelightDesc')}
                </div>
              </li>
            </ul>
          </div>

          {/* Section 2: Rust Core Engine */}
          <div>
            <div className="flex items-center gap-2 mb-2 pb-1 border-b border-slate-800">
              <Code2 className="w-4 h-4 text-emerald-400" />
              <h3 className="font-semibold text-[13px] text-slate-100 uppercase tracking-wide">
                {t('modal.ack.sec2Heading')}
              </h3>
            </div>
            <div className="p-3 bg-slate-900/60 border border-slate-800/80 text-[11.5px] leading-relaxed text-slate-300">
              <p className="mb-1.5">
                {t('modal.ack.sec2Body')}
              </p>
            </div>
          </div>

          {/* Section 3: Web & UI Stack */}
          <div>
            <div className="flex items-center gap-2 mb-2 pb-1 border-b border-slate-800">
              <Scale className="w-4 h-4 text-sky-400" />
              <h3 className="font-semibold text-[13px] text-slate-100 uppercase tracking-wide">
                {t('modal.ack.sec3Heading')}
              </h3>
            </div>
            <div className="p-3 bg-slate-900/60 border border-slate-800/80 text-[11.5px] leading-relaxed text-slate-300">
              <p>
                {t('modal.ack.sec3Body')}
              </p>
            </div>
          </div>

          {/* Section 4: Trademark Notice */}
          <div className="p-3.5 bg-slate-950 border border-slate-800/90 rounded">
            <div className="flex items-center gap-2 mb-1 text-slate-200 font-semibold text-[12px]">
              <ShieldCheck className="w-4 h-4 text-cyan-400 shrink-0" />
              <span>{t('modal.ack.trademarkHeading')}</span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              {t('modal.ack.trademarkP1')}
            </p>
            <p className="text-[11px] text-slate-400 leading-relaxed mt-1">
              {t('modal.ack.trademarkP2')}
            </p>
          </div>
        </div>

        {/* Footer (42px) */}
        <div
          style={{
            backgroundColor: '#0B0F17',
            borderTop: '1px solid #1E293B',
          }}
          className="h-[42px] px-4 flex items-center justify-between shrink-0"
        >
          <div className="text-[11px] text-slate-400 font-mono">
            {t('modal.ack.copyright')}
          </div>
          <button
            type="button"
            onClick={() => projectStore.setAcknowledgmentsModalOpen(false)}
            className="px-4 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-[11.5px] cursor-pointer transition-colors"
          >
            {t('modal.ack.btnClose')}
          </button>
        </div>
      </div>
    </div>
  );
};
