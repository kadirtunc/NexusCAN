/** Shown when the active vehicle has no ECU (or there is no vehicle): "register first, then operate". */
import React from 'react';
import { Cpu, FlaskConical, Plus, Radar } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { DIAG_BTN, DIAG_BTN_PRIMARY, DIAG_PANEL } from '../diagUi';

export const EcuEmptyState: React.FC<{
  onAddEcu: () => void;
  onFindEcu: () => void;
  onSimulate: () => void;
}> = ({ onAddEcu, onFindEcu, onSimulate }) => {
  const { t } = useI18n();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className={`${DIAG_PANEL} flex w-full max-w-[560px] flex-col items-center gap-4 px-8 py-8 text-center`}>
        <Cpu className="h-8 w-8 text-muted" aria-hidden="true" />
        <div>
          <h2 className="font-mono text-[13px] font-semibold uppercase tracking-wider text-ink">{t('diagWs.empty.title')}</h2>
          <p className="mt-1.5 text-[12.5px] text-muted">{t('diagWs.empty.hint')}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button type="button" onClick={onAddEcu} className={DIAG_BTN_PRIMARY}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('diagWs.empty.add')}
          </button>
          <button type="button" onClick={onFindEcu} className={DIAG_BTN} title={t('diagWs.empty.findHint')}>
            <Radar className="h-3.5 w-3.5" aria-hidden="true" />
            {t('diagWs.empty.find')}
          </button>
          <button type="button" onClick={onSimulate} className={DIAG_BTN} title={t('diagWs.empty.simulateHint')}>
            <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
            {t('diagWs.empty.simulate')}
          </button>
        </div>
      </div>
    </div>
  );
};
