/** Shared display maps for the Traffic Dock (no React). */
import type { TranslationKey } from '../../../i18n';
import type { DiagOrigin } from '../../../types/udsClient';
import type { IsoTpFrameType } from '../../../types/diagnostics';
import type { DiagTone } from '../diagUi';
import type { TxStatus } from './trafficModel';

export const ROW_H = 24;

export const ORIGIN_KEY: Record<DiagOrigin, TranslationKey> = {
  console: 'diagTraffic.origin.console',
  did: 'diagTraffic.origin.did',
  dtc: 'diagTraffic.origin.dtc',
  pids: 'diagTraffic.origin.pids',
  panel: 'diagTraffic.origin.panel',
  flow: 'diagTraffic.origin.flow',
  session: 'diagTraffic.origin.session',
  keepalive: 'diagTraffic.origin.keepalive',
  other: 'diagTraffic.origin.other',
};

export const STATUS_KEY: Record<TxStatus, TranslationKey> = {
  pending: 'diagTraffic.status.pending',
  ok: 'diagTraffic.status.ok',
  nrc: 'diagTraffic.status.nrc',
  timeout: 'diagTraffic.status.timeout',
  tx_blocked: 'diagTraffic.status.tx_blocked',
  transport_error: 'diagTraffic.status.transport_error',
  suppressed: 'diagTraffic.status.suppressed',
  keepalive: 'diagTraffic.status.keepalive',
  closed: 'diagTraffic.status.closed',
  dropped: 'diagTraffic.status.dropped',
};

export const STATUS_TONE: Record<TxStatus, DiagTone> = {
  pending: 'warn',
  ok: 'nominal',
  nrc: 'critical',
  timeout: 'critical',
  tx_blocked: 'critical',
  transport_error: 'critical',
  suppressed: 'neutral',
  keepalive: 'neutral',
  closed: 'warn',
  dropped: 'warn',
};

export const FRAME_TONE: Record<IsoTpFrameType, DiagTone> = {
  SF: 'nominal',
  FF: 'focus',
  CF: 'neutral',
  FC: 'warn',
  UNK: 'neutral',
};

export const FRAME_NAME_KEY: Record<IsoTpFrameType, TranslationKey> = {
  SF: 'diagHmi.isotp.ft.sf',
  FF: 'diagHmi.isotp.ft.ff',
  CF: 'diagHmi.isotp.ft.cf',
  FC: 'diagHmi.isotp.ft.fc',
  UNK: 'diagHmi.isotp.ft.unk',
};

/** Δt in µs -> `+1.234 ms` / `+123 µs`. */
export function formatDeltaUs(us: number): string {
  const sign = us < 0 ? '-' : '+';
  const abs = Math.abs(us);
  if (abs < 1000) return `${sign}${Math.round(abs)} µs`;
  const ms = abs / 1000;
  return `${sign}${ms < 100 ? ms.toFixed(2) : ms.toFixed(1)} ms`;
}

export const TX_COLS = '92px 52px 78px 46px 150px 190px 210px minmax(150px,1fr) 72px 112px';
export const TX_MIN_W = 92 + 52 + 78 + 46 + 150 + 190 + 210 + 150 + 72 + 112;
export const EV_COLS = '40px 92px 52px 78px 46px 110px 126px 230px minmax(150px,1fr) 80px';
export const EV_MIN_W = 40 + 92 + 52 + 78 + 46 + 110 + 126 + 230 + 150 + 80;
