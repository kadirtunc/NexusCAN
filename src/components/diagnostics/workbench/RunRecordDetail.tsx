/** Run record detail (workbench-v1 §2 Results): outcome, params, files, outputs, log excerpt. */
import React from 'react';
import { useI18n } from '../../../i18n';
import type { RunRecordV1 } from '../../../types/runRecord';
import { DiagBadge, DIAG_BTN, type DiagTone } from '../diagUi';
import { ModalShell } from '../../flow/ModalShell';
import { cellView } from './workbenchModel';

const CHIP_TONE: Record<'none' | 'ok' | 'warn' | 'critical', DiagTone> = { none: 'neutral', ok: 'nominal', warn: 'warn', critical: 'critical' };

function KeyValues({ data, empty }: { data: Record<string, string | number | boolean | null>; empty: string }): React.ReactElement {
  const keys = Object.keys(data);
  if (keys.length === 0) return <div className="font-mono text-[12px] text-subtle">{empty}</div>;
  return (
    <dl className="grid grid-cols-[minmax(80px,auto)_1fr] gap-x-3 gap-y-0.5 font-mono text-[12px] tabular-nums">
      {keys.map((k) => (
        <React.Fragment key={k}>
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-all text-ink">{String(data[k])}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export function fmtTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const RunRecordDetail: React.FC<{ record: RunRecordV1; onClose: () => void }> = ({ record: r, onClose }) => {
  const { t } = useI18n();
  const view = cellView(r);
  const none = t('workbench.detail.none');
  return (
    <ModalShell title={`${t('workbench.detail.title')} · ${r.ecuName ?? ''}`} onClose={onClose} width={640}>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <DiagBadge tone={CHIP_TONE[view.chip]}>{r.outcome}</DiagBadge>
          {view.text !== '' && <span className="font-mono text-[12px] text-ink">{view.text}</span>}
        </div>
        <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-0.5 font-mono text-[12px] tabular-nums">
          <dt className="text-muted">{t('workbench.detail.flow')}</dt>
          <dd className="text-ink">{r.flowName} · r{r.flowRevision}</dd>
          <dt className="text-muted">{t('workbench.detail.output')}</dt>
          <dd className="text-ink">{r.outputName ?? none}</dd>
          <dt className="text-muted">{t('workbench.detail.started')}</dt>
          <dd className="text-ink">{fmtTimestamp(r.startedAt)}</dd>
          <dt className="text-muted">{t('workbench.detail.duration')}</dt>
          <dd className="text-ink">{r.durationMs} ms</dd>
          <dt className="text-muted">{t('workbench.detail.runId')}</dt>
          <dd className="break-all text-subtle">{r.runId}</dd>
          {r.errorMessage !== null && (
            <>
              <dt className="text-muted">{t('workbench.detail.error')}</dt>
              <dd className="text-critical">{r.nrc !== null ? `NRC 0x${r.nrc.toString(16).toUpperCase().padStart(2, '0')} · ` : ''}{r.errorMessage}</dd>
            </>
          )}
        </dl>
        <section>
          <h3 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted">{t('workbench.detail.params')}</h3>
          <KeyValues data={r.params} empty={none} />
        </section>
        <section>
          <h3 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted">{t('workbench.detail.files')}</h3>
          {r.files.length === 0 ? (
            <div className="font-mono text-[12px] text-subtle">{none}</div>
          ) : (
            <ul className="flex flex-col gap-0.5 font-mono text-[12px] tabular-nums">
              {r.files.map((f) => (
                <li key={f.key} className="text-ink">{f.key}: {f.name} · {f.size} B · CRC-32 {f.crc32}</li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted">{t('workbench.detail.outputs')}</h3>
          <KeyValues data={r.outputs} empty={none} />
        </section>
        <section className="min-h-0">
          <h3 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted">{t('workbench.detail.log')}</h3>
          <pre className="max-h-[220px] overflow-auto border border-hairline bg-canvas p-2 font-mono text-[11.5px] leading-snug tabular-nums text-muted">
            {r.logExcerpt.length === 0 ? none : r.logExcerpt.join('\n')}
          </pre>
        </section>
      </div>
      <div className="flex shrink-0 justify-end border-t border-hairline p-3">
        <button type="button" onClick={onClose} className={DIAG_BTN}>{t('workbench.detail.close')}</button>
      </div>
    </ModalShell>
  );
};
