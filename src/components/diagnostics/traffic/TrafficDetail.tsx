import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, RotateCcw } from 'lucide-react';
import { useI18n } from '../../../i18n';
import type { DiagSessionInfoDto } from '../../../types/udsClient';
import { UDS_SERVICES, type IsoTpFrameEntry } from '../../../types/diagnostics';
import { interpretUdsResponse } from '../../../services/udsDecode';
import { DIAG_BTN_SM, DIAG_LABEL, DiagBadge } from '../diagUi';
import { bytesToHex, formatElapsedMs, toHex } from '../diagFormat';
import { framePrimaryTs, sidName, txNrc, type Transaction } from './trafficModel';
import { analyzeTiming } from './trafficTiming';
import { FRAME_TONE, ORIGIN_KEY, STATUS_KEY, STATUS_TONE, formatDeltaUs } from './trafficUi';

export interface ResendDraft {
  sid: number;
  subFn: number | null;
  data: number[];
  addressing: 'physical' | 'functional';
}

/** Request PDU -> Console composer fields (null when the Console cannot represent the service). */
export function draftFromTx(tx: Transaction): ResendDraft | null {
  const bytes = tx.request?.bytes;
  if (!bytes || bytes.length === 0) return null;
  const svc = UDS_SERVICES.find((s) => s.sid === bytes[0]);
  if (!svc) return null;
  const hasSub = svc.hasSubFunction && bytes.length > 1;
  return {
    sid: bytes[0],
    subFn: hasSub ? bytes[1] : null,
    data: bytes.slice(hasSub ? 2 : 1),
    addressing: tx.addressing,
  };
}

const KV = 'flex items-baseline justify-between gap-2 font-mono text-[11.5px] tabular-nums';
const HEX_BOX = 'break-all rounded-[2px] border border-hairline bg-surface p-1.5 font-mono text-[11.5px] tabular-nums text-ink';

export const TrafficDetail: React.FC<{
  tx: Transaction | undefined;
  frame: IsoTpFrameEntry | undefined;
  sessionInfo: DiagSessionInfoDto | null;
  onResend: (draft: ResendDraft) => void;
}> = ({ tx, frame, sessionInfo, onResend }) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const p2Server = sessionInfo?.p2ServerMs ?? null;
  const margin = sessionInfo?.config.p2MarginMs ?? 100;
  const timing = useMemo(() => (tx ? analyzeTiming(tx, p2Server, margin) : null), [tx, p2Server, margin]);
  const interp = useMemo(
    () => (tx?.final && tx.final.kind === 'response' && tx.final.bytes.length > 0
      ? interpretUdsResponse(tx.request?.bytes ?? [], tx.final.bytes)
      : null),
    [tx],
  );

  if (!tx && !frame) {
    return <div className="p-3 font-mono text-[11.5px] text-subtle">{t('diagTraffic.d.select')}</div>;
  }

  if (!tx && frame) {
    return (
      <div className="space-y-2 overflow-y-auto p-3">
        <div className={DIAG_LABEL}>{t('diagTraffic.d.frameOnly')}</div>
        <div className={HEX_BOX}>{bytesToHex(frame.rawBytes)}</div>
        <div className="font-sans text-[12px] text-ink">{frame.description}</div>
        {frame.assembledPayload && (
          <>
            <div className={DIAG_LABEL}>{t('diagTraffic.d.assembled')}</div>
            <div className={HEX_BOX}>{bytesToHex(frame.assembledPayload)}</div>
          </>
        )}
        <DiagBadge tone="warn">{t('diagTraffic.unmatched')}</DiagBadge>
      </div>
    );
  }

  if (!tx) return null;
  const draft = draftFromTx(tx);
  const nrc = txNrc(tx);
  const reqHex = tx.request ? bytesToHex(tx.request.bytes) : '';
  const rspHex = tx.final ? bytesToHex(tx.final.bytes) : '';

  const copy = () => {
    const text = [reqHex && `REQ ${reqHex}`, rspHex && `RSP ${rspHex}`].filter(Boolean).join('\n');
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  const t0 = tx.startUs;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <DiagBadge tone={STATUS_TONE[tx.status]}>{t(STATUS_KEY[tx.status])}</DiagBadge>
        <DiagBadge tone="focus">{t(ORIGIN_KEY[tx.origin])}</DiagBadge>
        <span className="font-mono text-[11.5px] tabular-nums text-muted">
          #{tx.seq} · {tx.addressing === 'functional' ? 'FUNC' : 'PHYS'}
        </span>
      </div>
      {tx.sid !== null && <div className="font-mono text-[12px] text-ink">0x{toHex(tx.sid)} {sidName(tx.sid)}</div>}

      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={DIAG_BTN_SM} onClick={copy} disabled={!reqHex && !rspHex}>
          <Copy className="h-3 w-3" aria-hidden="true" />
          {copied ? t('diagTraffic.d.copied') : t('diagTraffic.d.copyHex')}
        </button>
        <button
          type="button"
          className={DIAG_BTN_SM}
          disabled={draft === null}
          title={draft === null ? (tx.request ? t('diagTraffic.d.resendUnsupported') : t('diagTraffic.d.noRequest')) : undefined}
          onClick={() => draft && onResend(draft)}
        >
          <RotateCcw className="h-3 w-3" aria-hidden="true" />
          {t('diagTraffic.d.resend')}
        </button>
      </div>

      <div>
        <div className={DIAG_LABEL}>{t('diagTraffic.d.request')}</div>
        <div className={HEX_BOX}>{reqHex || '—'}</div>
      </div>
      <div>
        <div className={DIAG_LABEL}>{t('diagTraffic.d.response')}</div>
        <div className={HEX_BOX}>{rspHex || '—'}</div>
        {nrc && (
          <div className="mt-1 font-mono text-[11.5px] font-semibold text-critical">
            NRC 0x{toHex(nrc.code)} {nrc.name ?? ''}
          </div>
        )}
        {tx.final?.detail && <div className="mt-1 font-sans text-[11.5px] text-muted">{tx.final.detail}</div>}
      </div>
      {interp && interp.kind !== 'unknown' && (
        <div className="rounded-[2px] border border-hairline bg-canvas px-2 py-1.5">
          <div className={DIAG_LABEL}>{t('diagTraffic.d.interp')}</div>
          <div className="break-all font-mono text-[11.5px] text-muted">{interp.title}</div>
          {interp.value !== null && (
            <div className="break-all font-mono text-[13px] font-semibold tabular-nums text-ink">{interp.value}</div>
          )}
        </div>
      )}

      {timing && (
        <div className="space-y-0.5 rounded-[2px] border border-hairline bg-canvas px-2 py-1.5">
          <div className={DIAG_LABEL}>{t('diagTraffic.d.timing')}</div>
          <div className={KV}>
            <span className="text-muted">{t('diagTraffic.d.elapsed')}</span>
            <span className="text-ink">{tx.elapsedUs !== null ? formatElapsedMs(tx.elapsedUs) : '—'}</span>
          </div>
          <div className={KV}>
            <span className="text-muted">{t('diagTraffic.d.pending')}</span>
            <span className={tx.pendingCount > 0 ? 'text-warn' : 'text-ink'}>{tx.pendingCount}</span>
          </div>
          <div className={KV}>
            <span className="text-muted">{t('diagTraffic.d.p2')}</span>
            <span className={timing.p2Violation ? 'font-semibold text-critical' : 'text-ink'}>
              {timing.p2MeasuredUs !== null ? formatElapsedMs(timing.p2MeasuredUs) : '—'}
            </span>
          </div>
          <div className={KV}>
            <span className="text-muted">{t('diagTraffic.d.p2Limit')}</span>
            <span className="text-ink">
              {timing.p2LimitUs !== null ? formatElapsedMs(timing.p2LimitUs) : t('diagTraffic.d.p2Unknown')}
            </span>
          </div>
          {timing.p2MeasuredUs !== null && timing.p2LimitUs !== null && (
            <DiagBadge tone={timing.p2Violation ? 'critical' : 'nominal'}>
              {timing.p2Violation ? t('diagTraffic.d.p2Violation') : t('diagTraffic.d.p2Ok')}
            </DiagBadge>
          )}
          {timing.p2Source && (
            <div className="font-sans text-[11px] text-subtle">
              {timing.p2Source === 'frames' ? t('diagTraffic.d.source.frames') : t('diagTraffic.d.source.events')}
            </div>
          )}
          {timing.flowControls.map((fc) => (
            <div key={fc.frameUid} className="mt-1 border-t border-hairline pt-1">
              <div className={KV}>
                <span className="text-muted">{t('diagTraffic.d.fc')} ({fc.direction.toUpperCase()})</span>
                <span className="text-ink">
                  {t('diagTraffic.d.bs')} {fc.bs} · {t('diagTraffic.d.stmin')} {formatDeltaUs(fc.stMinUs).slice(1)}
                </span>
              </div>
              <div className={KV}>
                <span className="text-muted">{t('diagTraffic.d.minCf')}</span>
                <span className={fc.violation ? 'font-semibold text-critical' : 'text-ink'}>
                  {fc.minCfGapUs !== null ? formatDeltaUs(fc.minCfGapUs).slice(1) : '—'} ({fc.cfCount} CF)
                </span>
              </div>
              {fc.violation && <DiagBadge tone="critical">{t('diagTraffic.d.stminViolation')}</DiagBadge>}
            </div>
          ))}
        </div>
      )}

      <div>
        <div className={DIAG_LABEL}>{t('diagTraffic.d.frames', { n: tx.frames.length })}</div>
        {tx.frames.length === 0 ? (
          <div className="font-sans text-[11.5px] text-subtle">{t('diagTraffic.d.noFrames')}</div>
        ) : (
          <div className="mt-1 space-y-px font-mono text-[11px] tabular-nums">
            {tx.frames.map((f) => (
              <div key={f.uid} className="flex items-center gap-1.5 border-b border-[color:var(--border-grid)] py-0.5">
                <span className="w-[72px] shrink-0 text-subtle">{formatDeltaUs(framePrimaryTs(f) - t0)}</span>
                <span className={f.direction === 'tx' ? 'w-[26px] shrink-0 text-focus' : 'w-[26px] shrink-0 text-nominal'}>
                  {f.direction === 'tx' ? 'TX' : 'RX'}
                </span>
                <DiagBadge tone={FRAME_TONE[f.frameType]}>{f.frameType}</DiagBadge>
                <span className="min-w-0 flex-1 truncate text-muted" title={bytesToHex(f.rawBytes)}>
                  {bytesToHex(f.rawBytes)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
