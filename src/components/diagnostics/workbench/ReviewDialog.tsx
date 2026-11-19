/** Review gate (workbench-v1 §5.2): lists the flash / erase / write blocks of a run before anything is transmitted. */
import React from 'react';
import { useI18n } from '../../../i18n';
import type { WbReviewRequest } from '../../../store/diagWorkbenchStore';
import { DIAG_BTN, DIAG_BTN_DANGER } from '../diagUi';
import { ModalShell } from '../../flow/ModalShell';
import { fmtId } from '../workspace/ecuViewHelpers';

export const ReviewDialog: React.FC<{ request: WbReviewRequest; onAnswer: (ok: boolean) => void }> = ({ request, onAnswer }) => {
  const { t } = useI18n();
  const { ecu, items, files } = request;
  const a = ecu.addressing;
  return (
    <ModalShell title={t('workbench.review.title')} onClose={() => onAnswer(false)} width={560}>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5">
        <div className="border border-critical bg-canvas px-2 py-1.5 text-[12px] leading-snug text-critical" role="alert">{t('workbench.review.warn')}</div>
        <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 font-mono text-[12px] tabular-nums">
          <dt className="text-muted">{t('workbench.review.ecu')}</dt>
          <dd className="text-ink">{ecu.name}</dd>
          <dt className="text-muted">{t('workbench.review.addressing')}</dt>
          <dd className="text-ink">
            REQ {fmtId(a.requestId, a.isExtendedId)} / RSP {fmtId(a.responseId, a.isExtendedId)} · {a.addressFormat}{a.useFd ? ' · FD' : ''}
          </dd>
          {files.map((f) => (
            <React.Fragment key={f.key}>
              <dt className="text-muted">{t('workbench.review.firmware')}</dt>
              <dd className="text-ink">{f.name} · {f.size} B · CRC-32 {f.crc32}</dd>
            </React.Fragment>
          ))}
        </dl>
        <ul className="flex flex-col gap-1">
          {items.map((it, i) => (
            <li key={i} className="flex items-center gap-2 border border-hairline bg-canvas px-2 py-1 font-mono text-[12px]">
              <span className="min-w-0 flex-1 truncate text-ink" title={it.path}>{it.path}</span>
              <span className="shrink-0 text-[11px] text-subtle">{it.blockType}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex shrink-0 justify-end gap-2 border-t border-hairline p-3">
        <button type="button" onClick={() => onAnswer(false)} className={DIAG_BTN} autoFocus>{t('workbench.review.cancel')}</button>
        <button type="button" onClick={() => onAnswer(true)} className={DIAG_BTN_DANGER}>{t('workbench.review.confirm')}</button>
      </div>
    </ModalShell>
  );
};
