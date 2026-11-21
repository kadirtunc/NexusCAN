import React from 'react';
import type { BusHealthDto } from '../types/hal';
import { useI18n } from '../i18n';

export interface BusStateBadgeProps {
  busState?: BusHealthDto['busState'] | 'offline' | string;
  connected?: boolean;
  listenOnly?: boolean;
  txArmed?: boolean;
  txErrorCount?: number;
  rxErrorCount?: number;
  showTecRec?: boolean;
  compact?: boolean;
  className?: string;
}

export function formatBusStateLabel(
  busState?: string,
  connected = true,
): { label: string; dotClass: string; textClass: string; borderClass: string; bgClass: string } {
  if (!connected || busState === 'disconnected' || busState === 'offline' || !busState) {
    return {
      label: 'OFFLINE',
      dotClass: 'bg-[var(--text-muted)]',
      textClass: 'text-[var(--text-muted)]',
      borderClass: 'border-[var(--border-grid)]',
      bgClass: 'bg-transparent',
    };
  }

  const normalized = busState.toLowerCase();
  switch (normalized) {
    case 'active':
      return {
        label: 'ERR-ACTIVE',
        dotClass: 'bg-nominal shadow-[0_0_6px_rgba(16,185,129,0.5)]',
        textClass: 'text-nominal font-semibold',
        borderClass: 'border-[var(--status-nominal-border)]',
        bgClass: 'bg-[var(--status-nominal-bg)]',
      };
    case 'warning':
      return {
        label: 'ERR-WARN',
        dotClass: 'bg-warn shadow-[0_0_6px_rgba(251,191,36,0.5)]',
        textClass: 'text-warn font-semibold',
        borderClass: 'border-[var(--status-warn-border)]',
        bgClass: 'bg-[var(--status-warn-bg)]',
      };
    case 'passive':
      return {
        label: 'ERR-PASSIVE',
        dotClass: 'bg-warn shadow-[0_0_6px_rgba(249,115,22,0.5)]',
        textClass: 'text-warn font-semibold',
        borderClass: 'border-[var(--status-warn-border)]',
        bgClass: 'bg-[var(--status-warn-bg)]',
      };
    case 'busoff':
    case 'bus-off':
      return {
        label: 'BUS-OFF',
        dotClass: 'bg-critical shadow-[0_0_6px_rgba(239,68,68,0.7)] animate-pulse',
        textClass: 'text-critical font-bold',
        borderClass: 'border-[var(--status-critical-border)]',
        bgClass: 'bg-[var(--status-critical-bg)]',
      };
    default:
      return {
        label: busState.toUpperCase(),
        dotClass: 'bg-focus',
        textClass: 'text-focus font-medium',
        borderClass: 'border-[var(--status-focus-border)]',
        bgClass: 'bg-[var(--status-focus-bg)]',
      };
  }
}

export const BusStateBadge: React.FC<BusStateBadgeProps> = ({
  busState,
  connected = true,
  listenOnly,
  txArmed,
  txErrorCount = 0,
  rxErrorCount = 0,
  showTecRec = false,
  compact = false,
  className = '',
}) => {
  const { t } = useI18n();

  const { label, dotClass, textClass, borderClass, bgClass } = formatBusStateLabel(
    busState,
    connected,
  );

  const modeText =
    listenOnly !== undefined
      ? listenOnly
        ? t('rxtx.busBadge.listenOnly')
        : txArmed
          ? t('rxtx.busBadge.txArmed')
          : t('rxtx.busBadge.txDisarmed')
      : undefined;

  const tooltipParts = [t('rxtx.busBadge.tooltipState', { state: label })];
  if (modeText) tooltipParts.push(t('rxtx.busBadge.tooltipMode', { mode: modeText }));
  if (connected) {
    tooltipParts.push(
      t('rxtx.busBadge.tooltipErrors', { tec: txErrorCount, rec: rxErrorCount }),
    );
  }

  return (
    <span
      title={tooltipParts.join(' | ')}
      className={`inline-flex items-center gap-1.5 font-mono tabular-nums border px-1.5 py-0.5 rounded-sm select-none ${borderClass} ${bgClass} ${textClass} ${className}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
      <span className="text-[10px] tracking-wide leading-none">{label}</span>
      {showTecRec && connected && (
        <span className="text-[9px] text-[var(--text-secondary)] font-normal border-l border-[var(--border-grid)] pl-1 leading-none">
          {txErrorCount}/{rxErrorCount}
        </span>
      )}
      {!compact && modeText && (
        <span className="text-[9px] text-[var(--text-secondary)] font-normal border-l border-[var(--border-grid)] pl-1 leading-none">
          {listenOnly ? 'LO' : txArmed ? 'TX' : 'DIS'}
        </span>
      )}
    </span>
  );
};
