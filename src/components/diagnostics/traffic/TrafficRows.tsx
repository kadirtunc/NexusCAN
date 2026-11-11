import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useI18n, type TranslationKey } from '../../../i18n';
import type { ConversationEventDto, ConversationEventKind } from '../../../types/udsClient';
import type { IsoTpFrameEntry } from '../../../types/diagnostics';
import { DIAG_TEXT_TONE, DiagBadge, type DiagTone } from '../diagUi';
import { bytesToHex, formatElapsedMs, formatEventTime, toHex } from '../diagFormat';
import { sidName, txBrief, txNrc, type NoteItem, type Transaction, type TrafficEvent } from './trafficModel';
import {
  EV_COLS,
  FRAME_NAME_KEY,
  FRAME_TONE,
  ORIGIN_KEY,
  ROW_H,
  STATUS_KEY,
  STATUS_TONE,
  TX_COLS,
  formatDeltaUs,
} from './trafficUi';

type TFn = ReturnType<typeof useI18n>['t'];

const SHOWN_BYTES = 12;

const KIND_KEY: Record<ConversationEventKind, TranslationKey> = {
  request: 'diagReal.kind.request',
  response: 'diagReal.kind.response',
  response_pending: 'diagReal.kind.response_pending',
  timeout: 'diagReal.kind.timeout',
  tx_blocked: 'diagReal.kind.tx_blocked',
  transport_error: 'diagReal.kind.transport_error',
  stale_response_dropped: 'diagReal.kind.stale_response_dropped',
  keepalive_sent: 'diagReal.kind.keepalive_sent',
  session_closed: 'diagReal.kind.session_closed',
};

function eventTone(e: ConversationEventDto): DiagTone {
  switch (e.kind) {
    case 'request':
      return 'focus';
    case 'response':
      return e.nrc !== null ? 'critical' : 'nominal';
    case 'response_pending':
    case 'stale_response_dropped':
    case 'session_closed':
      return 'warn';
    case 'timeout':
    case 'tx_blocked':
    case 'transport_error':
      return 'critical';
    case 'keepalive_sent':
      return 'neutral';
  }
}

function hexShort(bytes: readonly number[]): string {
  if (bytes.length <= SHOWN_BYTES) return bytesToHex(bytes);
  return `${bytesToHex(bytes.slice(0, SHOWN_BYTES))} …+${bytes.length - SHOWN_BYTES}`;
}

const CELL = 'truncate px-2 leading-[24px]';

function rowClass(selected: boolean, tone: DiagTone, edge: string): string {
  const bg = selected
    ? 'bg-[var(--status-focus-bg)]'
    : tone === 'critical'
      ? 'bg-[var(--status-critical-bg)]'
      : 'hover:bg-[var(--bg-row-hover)]';
  return `grid cursor-pointer select-none border-b border-[color:var(--border-grid)] font-mono text-[11.5px] tabular-nums ${edge} ${bg}`;
}

const rowStyle = (cols: string): React.CSSProperties => ({ gridTemplateColumns: cols, height: ROW_H });

// ─── Transactions mode ────────────────────────────────────────────────────────────────────────

function responseText(tx: Transaction, t: TFn): string {
  const nrc = txNrc(tx);
  switch (tx.status) {
    case 'nrc':
      return `NRC 0x${toHex(nrc?.code ?? 0)} ${nrc?.name ?? ''}`.trim();
    case 'timeout':
      return t('diagTraffic.timeoutText');
    case 'tx_blocked':
    case 'transport_error':
    case 'closed':
    case 'dropped':
      return tx.final?.detail ?? t(STATUS_KEY[tx.status]);
    case 'ok':
      return tx.final ? hexShort(tx.final.bytes) : '';
    case 'pending':
      return '…';
    default:
      return '—';
  }
}

export const TxRowView = React.memo(function TxRowView({
  tx,
  expanded,
  selected,
  baseUs,
  onSelect,
  onToggle,
}: {
  tx: Transaction;
  expanded: boolean;
  selected: boolean;
  baseUs: number;
  onSelect: (key: string) => void;
  onToggle: (txKey: string) => void;
}) {
  const { t } = useI18n();
  const tone = STATUS_TONE[tx.status];
  const reqBytes = tx.request?.bytes ?? [];
  const brief = txBrief(tx);
  const hasFrames = tx.frames.length > 0;
  return (
    <div
      role="row"
      className={rowClass(selected, tone, 'border-l-2 border-l-transparent')}
      style={rowStyle(TX_COLS)}
      onClick={() => onSelect(`t:${tx.key}`)}
    >
      <div className={`${CELL} text-muted`}>{formatEventTime(tx.startUs, baseUs)}</div>
      <div className="flex items-center gap-0.5 px-1 text-subtle">
        {hasFrames ? (
          <button
            type="button"
            className="flex h-[20px] w-[16px] cursor-pointer items-center justify-center text-muted hover:text-ink"
            aria-label={expanded ? t('diagTraffic.dock.collapse') : t('diagTraffic.dock.expand')}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(tx.key);
            }}
          >
            {expanded ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
          </button>
        ) : (
          <span className="w-[16px]" />
        )}
        <span className="truncate">{tx.seq}</span>
      </div>
      <div className="flex items-center px-2">
        <DiagBadge tone={tx.origin === 'keepalive' ? 'neutral' : 'focus'}>{t(ORIGIN_KEY[tx.origin])}</DiagBadge>
      </div>
      <div className={`${CELL} text-subtle`}>{tx.addressing === 'functional' ? 'FUNC' : 'PHYS'}</div>
      <div className={`${CELL} text-ink`} title={tx.sid === null ? '' : sidName(tx.sid)}>
        {tx.sid === null ? '—' : `${toHex(tx.sid)} ${sidName(tx.sid)}`}
      </div>
      <div className={`${CELL} text-muted`} title={bytesToHex(reqBytes)}>
        {reqBytes.length > 0 ? hexShort(reqBytes) : '—'}
      </div>
      <div
        className={`${CELL} ${tone === 'critical' ? 'text-critical' : 'text-muted'}`}
        title={tx.final ? bytesToHex(tx.final.bytes) : ''}
      >
        {responseText(tx, t)}
      </div>
      <div className={`${CELL} font-sans text-ink`} title={brief}>
        {brief}
      </div>
      <div className={`${CELL} text-right text-muted`}>{tx.elapsedUs !== null ? formatElapsedMs(tx.elapsedUs) : ''}</div>
      <div className="flex items-center gap-1 px-2">
        <DiagBadge tone={tone}>{t(STATUS_KEY[tx.status])}</DiagBadge>
        {tx.pendingCount > 0 && (
          <span className="text-warn" title="NRC 0x78 responsePending">
            {t('diagTraffic.pendingN', { n: tx.pendingCount })}
          </span>
        )}
      </div>
    </div>
  );
});

// ─── Frame cells (shared by child rows, interleaved and frames modes) ─────────────────────────

function frameId(f: IsoTpFrameEntry): string {
  return `0x${toHex(f.canId, f.isExtended ? 8 : 3)}`;
}

function DirCell({ f }: { f: IsoTpFrameEntry }) {
  const tx = f.direction === 'tx';
  return (
    <div className={`${CELL} font-semibold ${f.direction === undefined ? 'text-subtle' : tx ? 'text-focus' : 'text-nominal'}`}>
      {f.direction === undefined ? '—' : tx ? 'TX↑' : 'RX↓'}
    </div>
  );
}

export const TxFrameRowView = React.memo(function TxFrameRowView({
  frame,
  tx,
  dtUs,
  selected,
  onSelect,
}: {
  frame: IsoTpFrameEntry;
  tx: Transaction;
  dtUs: number;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      role="row"
      className={rowClass(selected, 'neutral', 'border-l-2 border-l-[color:var(--border-strong)] bg-[var(--bg-panel)]')}
      style={rowStyle(TX_COLS)}
      onClick={() => onSelect(`t:${tx.key}`)}
    >
      <div className={`${CELL} text-subtle`}>{formatDeltaUs(dtUs)}</div>
      <div className={`${CELL} text-subtle`}>└</div>
      <DirCell f={frame} />
      <div className="flex items-center px-1">
        <DiagBadge tone={FRAME_TONE[frame.frameType]} title={t(FRAME_NAME_KEY[frame.frameType])}>
          {frame.frameType}
        </DiagBadge>
      </div>
      <div className={`${CELL} text-ink`}>{frameId(frame)}</div>
      <div className={`${CELL} text-muted`} title={bytesToHex(frame.rawBytes)}>
        {hexShort(frame.rawBytes)}
      </div>
      <div className={`${CELL} col-span-2 font-sans text-ink`} title={frame.description}>
        {frame.description}
        {frame.assembledPayload ? ` → ${hexShort(frame.assembledPayload)}` : ''}
      </div>
      <div />
      <div />
    </div>
  );
});

export const NoteRowView = React.memo(function NoteRowView({ note }: { note: NoteItem }) {
  const { t } = useI18n();
  return (
    <div
      role="row"
      className="flex items-center border-b border-[color:var(--border-grid)] px-3 font-sans text-[11.5px] text-warn"
      style={{ height: ROW_H }}
    >
      {note.note === 'reopened' ? t('diagReal.log.reopened') : t('diagReal.log.gap')}
    </div>
  );
});

// ─── Interleaved / frames modes ───────────────────────────────────────────────────────────────

export const EventRowView = React.memo(function EventRowView({
  item,
  tx,
  selected,
  baseUs,
  onSelect,
}: {
  item: TrafficEvent;
  tx: Transaction | undefined;
  selected: boolean;
  baseUs: number;
  onSelect: (key: string) => void;
}) {
  const { t } = useI18n();
  const e = item.event;
  const tone = eventTone(e);
  const parts: string[] = [];
  if (e.requestSeq !== null) parts.push(t('diagReal.log.replyTo', { seq: e.requestSeq }));
  if (e.nrc !== null) parts.push(`NRC 0x${toHex(e.nrc)}`);
  if (e.detail) parts.push(e.detail);
  const detail = parts.join(' · ');
  return (
    <div
      role="row"
      className={rowClass(selected, tone, 'border-l-2 border-l-[color:var(--status-focus)]')}
      style={rowStyle(EV_COLS)}
      onClick={() => onSelect(`e:${item.uid}`)}
    >
      <div className="flex items-center px-1">
        <DiagBadge tone="focus">{t('diagTraffic.evt')}</DiagBadge>
      </div>
      <div className={`${CELL} text-muted`}>{formatEventTime(e.timestampUs, baseUs)}</div>
      <div className={`${CELL} text-subtle`}>{e.seq}</div>
      <div className={`${CELL} text-muted`}>{t(ORIGIN_KEY[e.origin])}</div>
      <div className={`${CELL} text-subtle`}>{e.addressing === 'functional' ? 'FUNC' : 'PHYS'}</div>
      <div className={`${CELL} text-ink`} title={tx?.sid === null || tx === undefined ? '' : sidName(tx.sid)}>
        {e.sid === null ? '—' : `0x${toHex(e.sid)}`}
      </div>
      <div className={`${CELL} font-semibold ${DIAG_TEXT_TONE[tone]}`}>{t(KIND_KEY[e.kind])}</div>
      <div className={`${CELL} text-muted`} title={bytesToHex(e.bytes)}>
        {hexShort(e.bytes)}
      </div>
      <div className={`${CELL} font-sans text-ink`} title={detail}>
        {detail}
      </div>
      <div className={`${CELL} text-right text-muted`}>{e.elapsedUs !== null ? formatElapsedMs(e.elapsedUs) : ''}</div>
    </div>
  );
});

export const FrameRowView = React.memo(function FrameRowView({
  frame,
  tx,
  unmatched,
  selected,
  baseUs,
  onSelect,
}: {
  frame: IsoTpFrameEntry;
  tx: Transaction | undefined;
  unmatched: boolean;
  selected: boolean;
  baseUs: number;
  onSelect: (key: string) => void;
}) {
  const { t } = useI18n();
  const ts = frame.timestampUs ?? frame.timestampMs * 1000;
  const dt = tx ? formatDeltaUs(ts - tx.startUs) : '';
  return (
    <div
      role="row"
      className={rowClass(selected, 'neutral', 'border-l-2 border-l-transparent')}
      style={rowStyle(EV_COLS)}
      onClick={() => onSelect(`f:${frame.uid}`)}
    >
      <div className="flex items-center px-1">
        <DiagBadge tone="neutral">{t('diagTraffic.frm')}</DiagBadge>
      </div>
      <div className={`${CELL} text-muted`}>{formatEventTime(ts, baseUs)}</div>
      <div className={`${CELL} text-subtle`}>{frame.seq}</div>
      <div className="flex items-center px-2">
        {unmatched ? (
          <DiagBadge tone="warn" title={t('diagTraffic.unmatchedTitle')}>
            {t('diagTraffic.unmatched')}
          </DiagBadge>
        ) : (
          <span className="truncate text-muted">{tx ? t(ORIGIN_KEY[tx.origin]) : `#${frame.requestSeq ?? ''}`}</span>
        )}
      </div>
      <DirCell f={frame} />
      <div className={`${CELL} text-ink`}>{frameId(frame)}</div>
      <div className="flex items-center px-2">
        <DiagBadge tone={FRAME_TONE[frame.frameType]} title={t(FRAME_NAME_KEY[frame.frameType])}>
          {frame.frameType}
        </DiagBadge>
      </div>
      <div className={`${CELL} text-muted`} title={bytesToHex(frame.rawBytes)}>
        {hexShort(frame.rawBytes)}
      </div>
      <div className={`${CELL} font-sans text-ink`} title={frame.description}>
        {frame.description}
        {frame.assembledPayload ? ` → ${t('diagTraffic.d.assembled')}: ${hexShort(frame.assembledPayload)}` : ''}
      </div>
      <div className={`${CELL} text-right text-subtle`}>{dt}</div>
    </div>
  );
});
