/**
 * Inspector + node widgets of the `uds_flash_image` block: file picker (-> load), image summary
 * (segments / CRC32), live run progress, final report and structured error. All numerics are
 * `font-mono tabular-nums`; the bar is a plain width (no transition / animation).
 */
import React, { useRef } from 'react';
import { t, useI18n } from '../../i18n';
import { diagnosticsStore } from '../../store/diagnosticsStore';
import { formatAddress, formatCrc32, parseHexNumber } from '../../services/flashCodec';
import { clearImage, hexNrc, loadImageFromFile, usesBaseAddress } from './flashRun';
import { useFlashImage, useFlashRun, type FlashRunState, type FlashStage } from './flashRuntime';
import { flowStore } from './FlowStore';
import { DIAG_BTN_SM, DiagBadge, DIAG_SECTION_TITLE, type DiagTone } from '../diagnostics/diagUi';
import type { FlashErrorDto, FlashReportDto } from '../../types/flash';

const MONO = 'font-mono tabular-nums';

function fmtRate(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(2)} MiB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(1)} KiB/s`;
  return `${Math.round(bps)} B/s`;
}

function fmtSecs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function barColor(status: FlashRunState['status']): string {
  if (status === 'error') return 'var(--status-critical)';
  if (status === 'cancelled') return 'var(--status-warn)';
  if (status === 'done') return 'var(--status-nominal)';
  return 'var(--status-focus)';
}

const ProgressBar: React.FC<{ percent: number; status: FlashRunState['status']; height?: number }> = ({
  percent,
  status,
  height = 6,
}) => (
  <div
    className="w-full overflow-hidden border border-hairline bg-canvas"
    style={{ height }}
    role="progressbar"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(percent)}
  >
    <div style={{ width: `${percent}%`, height: '100%', background: barColor(status) }} />
  </div>
);

function statusTone(status: FlashRunState['status']): DiagTone {
  switch (status) {
    case 'running': return 'focus';
    case 'done': return 'nominal';
    case 'error': return 'critical';
    case 'cancelled': return 'warn';
    default: return 'neutral';
  }
}

/** "Erasing segment 1/2" / "Verifying segment 2/2" / "Downloading" (non-React `t`: callers subscribe via useI18n). */
function stageText(stage: FlashStage): string {
  if (stage.kind === 'download') return t('flash.stage.download');
  return t(stage.kind === 'erase' ? 'flash.stage.erase' : 'flash.stage.verify', { i: stage.index, n: stage.count });
}

// ─── Node mini progress (inside BlockNode) ─────────────────────────────────────

export const FlashNodeProgress: React.FC<{ blockId: string; zoom: number }> = ({ blockId, zoom }) => {
  useI18n();
  const run = useFlashRun(blockId);
  if (run.status === 'idle') return null;
  const percent = run.overall?.percent ?? 0;
  return (
    <div style={{ boxSizing: 'border-box', padding: `${3 * zoom}px ${8 * zoom}px`, background: 'var(--bg-canvas)', borderTop: '1px solid var(--border-hairline)' }}>
      <div style={{ height: 5 * zoom, border: '1px solid var(--border-hairline)', background: 'var(--bg-surface)', overflow: 'hidden' }}>
        <div style={{ width: `${percent}%`, height: '100%', background: barColor(run.status) }} />
      </div>
      <div className="font-mono tabular-nums" style={{ fontSize: 8.5 * zoom, color: 'var(--text-secondary)', marginTop: 2 * zoom, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {run.status === 'running' && run.stage !== null && run.stage.kind !== 'download'
          ? stageText(run.stage)
          : `${percent.toFixed(1)}% · ${run.progress ? `${run.progress.segmentIndex + 1}/${run.progress.segmentCount}` : '-'} · ${fmtRate(run.throughputBps)}`}
      </div>
    </div>
  );
};

// ─── Error / report ────────────────────────────────────────────────────────────

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-baseline justify-between gap-2">
    <span className="shrink-0 text-[11.5px] text-muted">{label}</span>
    <span className={`${MONO} min-w-0 truncate text-right text-[11.5px] text-ink`}>{children}</span>
  </div>
);

const ErrorView: React.FC<{ error: FlashErrorDto }> = ({ error }) => {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1 border border-critical bg-canvas px-2 py-1.5">
      <div className="flex items-center gap-2">
        <DiagBadge tone="critical">{t(`flash.err.kind.${error.kind}`)}</DiagBadge>
        <span className={`${MONO} text-[11px] text-muted`}>{t(`flash.phase.${error.phase}`)}</span>
      </div>
      {error.segmentIndex !== null && <Row label={t('flash.err.segment')}>{error.segmentIndex}</Row>}
      {error.address !== null && <Row label={t('flash.err.address')}>{formatAddress(error.address)}</Row>}
      {error.offset !== null && <Row label={t('flash.err.offset')}>{error.offset}</Row>}
      {error.blockCounter !== null && <Row label={t('flash.err.block')}>{error.blockCounter}</Row>}
      {error.lastNrc !== null && (
        <Row label="NRC">{`${hexNrc(error.lastNrc)}${error.lastNrcName ? ` ${error.lastNrcName}` : ''}`}</Row>
      )}
      {error.diagCode !== null && <Row label={t('flash.err.diag')}>{error.diagCode}</Row>}
      <Row label={t('flash.err.bytesDone')}>{error.bytesDone}</Row>
      <Row label={t('flash.err.segmentsDone')}>{error.segmentsCompleted}</Row>
      {error.message && <div className="break-words text-[11.5px] text-critical">{error.message}</div>}
    </div>
  );
};

const ReportView: React.FC<{ report: FlashReportDto }> = ({ report }) => {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1">
      <Row label={t('flash.rep.bytes')}>{report.totalBytes}</Row>
      <Row label={t('flash.rep.blocks')}>{report.totalBlocks}</Row>
      <Row label={t('flash.rep.retries')}>{report.totalRetries}</Row>
      <Row label={t('flash.rep.duration')}>{fmtSecs(report.durationMs)}</Row>
      <Row label={t('flash.run.throughput')}>{fmtRate(report.throughputBytesPerSec)}</Row>
      {report.segments.length > 0 && (
        <table className={`${MONO} mt-1 w-full border-collapse text-[11px]`}>
          <thead>
            <tr className="text-left text-subtle">
              <th className="py-0.5 pr-1 font-normal">#</th>
              <th className="py-0.5 pr-1 font-normal">{t('flash.sum.colAddress')}</th>
              <th className="py-0.5 pr-1 text-right font-normal">{t('flash.rep.colBlocks')}</th>
              <th className="py-0.5 text-right font-normal">{t('flash.rep.colBlockLen')}</th>
            </tr>
          </thead>
          <tbody>
            {report.segments.map((s) => (
              <tr key={s.index} className="border-t border-hairline text-ink">
                <td className="py-0.5 pr-1">{s.index}</td>
                <td className="py-0.5 pr-1">{formatAddress(s.address)}</td>
                <td className="py-0.5 pr-1 text-right">{s.blocks}</td>
                <td className="py-0.5 text-right">{s.blockLen}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

// ─── Run section ───────────────────────────────────────────────────────────────

export const FlashRunPanel: React.FC<{ blockId: string }> = ({ blockId }) => {
  const { t } = useI18n();
  const run = useFlashRun(blockId);
  if (run.status === 'idle') return null;
  const p = run.progress;
  const percent = run.overall?.percent ?? 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <DiagBadge tone={statusTone(run.status)}>{t(`flash.status.${run.status}`)}</DiagBadge>
        {run.mock && <DiagBadge tone="warn">{t('flash.demoBadge')}</DiagBadge>}
        <span className={`${MONO} ml-auto text-[12px] text-ink`}>{percent.toFixed(1)}%</span>
      </div>
      <ProgressBar percent={percent} status={run.status} />
      {run.stage !== null && (run.status === 'running' || run.status === 'error') && (
        <Row label={t('flash.run.stage')}>{stageText(run.stage)}</Row>
      )}
      {p !== null && run.status === 'running' && (
        <div className="flex flex-col gap-0.5">
          <Row label={t('flash.run.phase')}>{t(`flash.phase.${p.phase}`)}</Row>
          <Row label={t('flash.run.segment')}>{`${p.segmentIndex + 1} / ${p.segmentCount}`}</Row>
          <Row label={t('flash.run.address')}>{formatAddress(p.segmentAddress)}</Row>
          <Row label={t('flash.run.bytes')}>{`${run.overall?.done ?? 0} / ${run.overall?.total ?? 0}`}</Row>
          <Row label={t('flash.run.blockCounter')}>{p.blockCounter}</Row>
          <Row label={t('flash.run.retries')}>{p.retries}</Row>
          <Row label={t('flash.run.throughput')}>{fmtRate(run.throughputBps)}</Row>
          <Row label={t('flash.run.elapsed')}>{fmtSecs(run.elapsedMs)}</Row>
        </div>
      )}
      {run.status === 'done' && run.report !== null && <ReportView report={run.report} />}
      {run.error !== null && <ErrorView error={run.error} />}
      {run.error === null && run.errorText !== null && (
        <div className="break-words border border-critical bg-canvas px-2 py-1.5 text-[11.5px] text-critical">{run.errorText}</div>
      )}
    </div>
  );
};

// ─── Inspector: file + summary ─────────────────────────────────────────────────

export const FlashImagePanel: React.FC<{ blockId: string; config: Record<string, unknown> }> = ({ blockId, config }) => {
  const { t } = useI18n();
  const img = useFlashImage(blockId);
  const inputRef = useRef<HTMLInputElement>(null);
  const savedName = String(config['file_name'] ?? '');
  const handle = img.handle;
  const format = String(config['format'] ?? 'auto');
  const settingsChanged =
    handle !== null &&
    (img.loadedFormat !== format ||
      (usesBaseAddress(format, handle.fileName) && (parseHexNumber(config['base_address'] ?? '0') ?? 0) !== img.loadedBase));

  const pick = (file: File): void => {
    flowStore.updateBlockConfig(blockId, { file_name: file.name });
    void loadImageFromFile(blockId, file, { ...config, file_name: file.name }, diagnosticsStore.getState().mockMode);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={inputRef}
        type="file"
        accept=".hex,.ihex,.s19,.srec,.mot,.bin"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) pick(f);
          e.target.value = '';
        }}
        aria-label={t('flash.pick.choose')}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className={DIAG_BTN_SM} onClick={() => inputRef.current?.click()} disabled={img.loading}>
          {t('flash.pick.choose')}
        </button>
        {img.file !== null && (
          <button
            type="button"
            className={DIAG_BTN_SM}
            disabled={img.loading}
            onClick={() => void loadImageFromFile(blockId, img.file as File, config, diagnosticsStore.getState().mockMode)}
          >
            {t('flash.pick.reload')}
          </button>
        )}
        {(handle !== null || img.loadError !== null) && (
          <button type="button" className={DIAG_BTN_SM} onClick={() => clearImage(blockId)}>
            {t('flash.pick.clear')}
          </button>
        )}
      </div>

      <div className={`${MONO} truncate text-[11.5px] ${handle ? 'text-ink' : 'text-warn'}`} title={handle?.fileName ?? savedName}>
        {img.loading
          ? t('flash.pick.loading')
          : (handle?.fileName ?? (savedName ? t('flash.pick.repick', { file: savedName }) : t('flash.pick.none')))}
      </div>

      {img.loadError !== null && (
        <div className="break-words border border-critical bg-canvas px-2 py-1 text-[11.5px] text-critical">{img.loadError}</div>
      )}
      {settingsChanged && <div className="text-[11px] text-warn">{t('flash.pick.stale')}</div>}

      {handle !== null && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <div className={DIAG_SECTION_TITLE}>{t('flash.sum.title')}</div>
            <DiagBadge tone="neutral">{handle.format}</DiagBadge>
            {img.mock && <DiagBadge tone="warn" title={t('flash.pick.demoNote')}>{t('flash.demoBadge')}</DiagBadge>}
          </div>
          <table className={`${MONO} w-full border-collapse text-[11px]`}>
            <thead>
              <tr className="text-left text-subtle">
                <th className="py-0.5 pr-1 font-normal">{t('flash.sum.colAddress')}</th>
                <th className="py-0.5 pr-1 text-right font-normal">{t('flash.sum.colLength')}</th>
                <th className="py-0.5 text-right font-normal">CRC32</th>
              </tr>
            </thead>
            <tbody>
              {handle.summary.segments.map((s, i) => (
                <tr key={`${i}-${s.address}`} className="border-t border-hairline text-ink">
                  <td className="py-0.5 pr-1">{formatAddress(s.address)}</td>
                  <td className="py-0.5 pr-1 text-right">{s.length}</td>
                  <td className="py-0.5 text-right">{formatCrc32(s.crc32)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Row label={t('flash.sum.total')}>{`${handle.summary.totalBytes} B`}</Row>
          <Row label={t('flash.sum.totalCrc')}>{formatCrc32(handle.summary.crc32)}</Row>
          {img.mock && <div className="text-[11px] text-subtle">{t('flash.pick.demoNote')}</div>}
        </div>
      )}
    </div>
  );
};
