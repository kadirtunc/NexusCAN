/** Editor chrome of nested flows: breadcrumb path bar, "Custom Block yap" dialog, notices. */
import React, { useState } from 'react';
import { Box, ChevronRight, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import { DIAG_BTN, DIAG_BTN_PRIMARY, DIAG_BTN_SM } from '../diagnostics/diagUi';
import { ModalShell } from './ModalShell';
import { useFlowStore } from './FlowStore';
import { flowRegistry, useFlowRegistry } from './registry/flowRegistryStore';
import { docTitle } from './registry/FlowDocTabs';

/** Breadcrumb of entered callees (`Flash ECU › Unlock › Send Key`); a crumb click goes up. */
export const FlowTrailBar: React.FC = () => {
  const { t } = useI18n();
  const { trail, docs, activeKey } = useFlowRegistry();
  const { diagram } = useFlowStore();
  const idx = trail.findIndex((x) => x.key === activeKey);
  if (trail.length < 2 || idx < 0) return null;
  const active = docs.find((d) => d.key === activeKey);
  return (
    <div className="flex h-7 shrink-0 items-center gap-1 overflow-x-auto border-b border-hairline bg-surface px-3.5" aria-label={t('flowNest.trail')}>
      <Box className="h-3 w-3 shrink-0 text-warn" aria-hidden="true" />
      {trail.map((c, i) => {
        const d = docs.find((x) => x.key === c.key);
        const title = d ? docTitle(d, d.key === activeKey ? diagram.name : null) : c.key;
        return (
          <React.Fragment key={`${c.key}:${i}`}>
            {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-subtle" aria-hidden="true" />}
            <button
              type="button"
              disabled={i === idx}
              onClick={() => flowRegistry.goToTrail(i)}
              className={`shrink-0 whitespace-nowrap font-mono text-[11.5px] ${i === idx ? 'font-semibold text-ink' : 'cursor-pointer text-muted hover:text-focus'}`}
            >
              {title}
            </button>
          </React.Fragment>
        );
      })}
      <span className="flex-1" />
      {active && active.readOnly && (
        <button type="button" className={DIAG_BTN_SM} onClick={() => void flowRegistry.editLatest(active.id)}>
          {t('flowNest.editLatest')}
        </button>
      )}
    </div>
  );
};

/** "Custom Block yap": asks for a name, then extracts the selection. */
export const ExtractDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <ModalShell title={t('flowNest.extract.title')} onClose={onClose} width={440}>
      <form
        className="flex flex-col gap-3 p-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void flowRegistry.extractSelection(name).then((r) => {
            setBusy(false);
            if (r.ok) onClose();
            else setError(r.message);
          });
        }}
      >
        <div className="text-[12px] leading-snug text-muted">{t('flowNest.extract.hint')}</div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('flowNest.extract.name')}
          className="h-[30px] w-full rounded-[2px] border border-hairline bg-canvas px-2.5 text-[12.5px] text-ink outline-none focus:border-focus"
        />
        {error && <div className="border border-critical bg-canvas px-2 py-1.5 text-[11.5px] leading-snug text-critical" role="alert">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={DIAG_BTN} onClick={onClose}>{t('diagReal.flow.promptCancel')}</button>
          <button type="submit" className={DIAG_BTN_PRIMARY} disabled={busy || name.trim() === ''}>{t('flowNest.extract.make')}</button>
        </div>
      </form>
    </ModalShell>
  );
};

/** One-off notices: insertion refused, "update to latest" report (what was dropped). */
export const FlowNotices: React.FC = () => {
  const { t } = useI18n();
  const { notice, repinReport } = useFlowRegistry();
  if (!notice && !repinReport) return null;
  return (
    <div className="flex flex-col border-b border-hairline">
      {notice && (
        <div className="flex items-start gap-2 border-b border-critical bg-canvas px-3.5 py-1.5 text-[12px] text-critical" role="alert">
          <span className="min-w-0 flex-1 break-words">{notice}</span>
          <button type="button" onClick={() => flowRegistry.clearNotice()} aria-label={t('flowReg.close')} className="shrink-0 cursor-pointer"><X className="h-3 w-3" aria-hidden="true" /></button>
        </div>
      )}
      {repinReport && (
        <div className="flex items-start gap-2 bg-canvas px-3.5 py-1.5 text-[12px] text-muted">
          <div className="min-w-0 flex-1">
            <span className="font-mono tabular-nums text-ink">{repinReport.label} r{repinReport.from} → r{repinReport.to}</span>
            {repinReport.dropped.length === 0
              ? <span className="ml-2">{t('flowNest.repin.none')}</span>
              : <div className="mt-0.5 text-warn">{t('flowNest.repin.dropped', { n: repinReport.dropped.length })}: {repinReport.dropped.join(', ')}</div>}
          </div>
          <button type="button" onClick={() => flowRegistry.dismissRepin()} aria-label={t('flowReg.close')} className="shrink-0 cursor-pointer"><X className="h-3 w-3" aria-hidden="true" /></button>
        </div>
      )}
    </div>
  );
};
