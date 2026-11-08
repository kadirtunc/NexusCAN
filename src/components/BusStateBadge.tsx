import React from 'react';
import type { BusHealthDto } from '../types/hal';

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
        dotClass: 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]',
        textClass: 'text-emerald-400 font-semibold',
        borderClass: 'border-emerald-500/40',
        bgClass: 'bg-emerald-500/10',
      };
    case 'warning':
      return {
        label: 'ERR-WARN',
        dotClass: 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)]',
        textClass: 'text-amber-400 font-semibold',
        borderClass: 'border-amber-500/40',
        bgClass: 'bg-amber-500/10',
      };
    case 'passive':
      return {
        label: 'ERR-PASSIVE',
        dotClass: 'bg-orange-500 shadow-[0_0_6px_rgba(249,115,22,0.5)]',
        textClass: 'text-orange-400 font-semibold',
        borderClass: 'border-orange-500/40',
        bgClass: 'bg-orange-500/10',
      };
    case 'busoff':
    case 'bus-off':
      return {
        label: 'BUS-OFF',
        dotClass: 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.7)] animate-pulse',
        textClass: 'text-red-400 font-bold',
        borderClass: 'border-red-500/60',
        bgClass: 'bg-red-500/15',
      };
    default:
      return {
        label: busState.toUpperCase(),
        dotClass: 'bg-sky-400',
        textClass: 'text-sky-300 font-medium',
        borderClass: 'border-sky-500/40',
        bgClass: 'bg-sky-500/10',
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
  const { label, dotClass, textClass, borderClass, bgClass } = formatBusStateLabel(
    busState,
    connected,
  );

  const modeText =
    listenOnly !== undefined
      ? listenOnly
        ? 'Listen-Only'
        : txArmed
          ? 'Active TX Armed'
          : 'TX Disarmed'
      : undefined;

  const tooltipParts = [`State: ${label}`];
  if (modeText) tooltipParts.push(`Mode: ${modeText}`);
  if (connected) {
    tooltipParts.push(`TEC: ${txErrorCount} | REC: ${rxErrorCount}`);
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
