import React, { useEffect } from 'react';
import { Activity, ChevronDown, Play, Square, Wifi } from 'lucide-react';
import { useI18n } from '../../i18n';
import { toHex } from './diagFormat';
import { diagnosticsStore, useDiagnosticsStore } from '../../store/diagnosticsStore';
import { PID_CATALOG, type LivePidError } from '../../types/diagnostics';
import { formatDiagError } from '../../services/diagErrors';
import {
  DIAG_BTN,
  DIAG_BTN_PRIMARY,
  DIAG_BTN_SM,
  DIAG_CHECKBOX,
  DIAG_PANEL,
  DIAG_ROW_HOVER,
  DIAG_SECTION_TITLE,
  DIAG_SELECT,
  DiagBadge,
  DiagDemoBadge,
  DiagEmptyState,
  DiagSelectWrap,
} from './diagUi';

/** `0x7E0`; 29-bit IDs are padded to 8 hex digits. */
function fmtCanId(id: number, extended: boolean): string {
  return `0x${id.toString(16).toUpperCase().padStart(extended ? 8 : 3, '0')}`;
}

const POLLING_OPTIONS = [250, 500, 1000, 2000] as const;

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 1000) return `${diff}ms`;
  return `${(diff / 1000).toFixed(1)}s`;
}

interface GaugeCardProps {
  pid: number;
}

const GaugeCard: React.FC<GaugeCardProps> = ({ pid }) => {
  const { t } = useI18n();
  const state = useDiagnosticsStore();
  const def = PID_CATALOG.find((p) => p.pid === pid);
  const liveVal = state.livePidValues.get(pid);
  const pidError: LivePidError | undefined = state.livePidErrors.get(pid);
  const stale = pidError !== undefined && liveVal !== undefined;
  const errorText = pidError
    ? pidError.kind === 'nrc'
      ? `NRC${pidError.nrc !== null ? ` 0x${toHex(pidError.nrc)}` : ''}${pidError.nrcName ? ` ${pidError.nrcName}` : ''}`
      : pidError.kind === 'badResponse'
        ? t('diagReal.pid.badResponse')
        : formatDiagError(t, pidError.error)
    : null;

  if (!def) return null;

  const physical = liveVal?.physicalValue ?? null;
  const pct =
    physical !== null
      ? Math.max(0, Math.min(100, ((physical - def.min) / (def.max - def.min)) * 100))
      : 0;

  return (
    <div className={`${DIAG_PANEL} flex min-w-0 flex-col gap-1.5 p-3`}>
      {/* PID name */}
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[11.5px] font-semibold uppercase tracking-wider text-muted">
          {def.name}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-subtle">
          PID 0x{def.pid.toString(16).toUpperCase().padStart(2, '0')}
        </span>
      </div>

      {/* Value */}
      <div className="flex items-baseline gap-1">
        <span className={`font-mono text-[26px] font-bold leading-none tabular-nums ${stale ? 'text-subtle' : 'text-ink'}`}>
          {physical !== null ? def.formatValue(physical) : '—'}
        </span>
        <span className="font-mono text-[12px] text-muted">{def.unit}</span>
        {stale && <DiagBadge tone="warn">{t('diagReal.pid.stale')}</DiagBadge>}
      </div>
      {errorText && (
        <div className="truncate font-mono text-[11px] text-critical" title={errorText}>
          {errorText}
        </div>
      )}

      {/* Progress bar */}
      <div className="h-1.5 overflow-hidden rounded-[1px] bg-canvas">
        <div className={`h-full ${stale ? 'bg-subtle' : 'bg-focus'}`} style={{ width: `${pct}%` }} />
      </div>

      {/* Min / Max + timestamp */}
      <div className="flex items-center justify-between font-mono text-[11px] tabular-nums text-subtle">
        <span>
          {def.min} – {def.max} {def.unit}
        </span>
        {liveVal && <span>{timeAgo(liveVal.timestampMs)}</span>}
      </div>
    </div>
  );
};

export const LivePidGauges: React.FC = () => {
  const { t } = useI18n();
  const state = useDiagnosticsStore();
  const { session, activePids, pidPollingMs, isPolling } = state;
  const connected = session.connected;

  // Leaving the tab (or the Diagnostics view) always stops polling: no hidden bus traffic.
  useEffect(() => () => diagnosticsStore.stopPolling(), []);

  function handleTogglePid(pid: number) {
    diagnosticsStore.togglePid(pid);
  }

  function handleSelectAll() {
    diagnosticsStore.setActivePids(new Set(PID_CATALOG.map((p) => p.pid)));
  }

  function handleClearAll() {
    diagnosticsStore.setActivePids(new Set());
  }

  function handleTogglePolling() {
    if (isPolling) {
      diagnosticsStore.stopPolling();
    } else {
      diagnosticsStore.startPolling();
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-canvas">
      {/* Not connected overlay */}
      {!connected && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center"
          style={{ backgroundColor: 'var(--bg-scrim)' }}
        >
          <div className={`${DIAG_PANEL} px-8 py-5`}>
            <DiagEmptyState
              icon={<Wifi className="h-6 w-6 text-warn" aria-hidden="true" />}
              title={t('diag.error.notConnected')}
            />
          </div>
        </div>
      )}

      {/* Left panel - PID selector */}
      <div className="flex w-[220px] min-w-[220px] shrink-0 flex-col overflow-hidden border-r border-hairline bg-surface">
        {/* Header */}
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline bg-elevated px-3">
          <Activity className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
          <span className={DIAG_SECTION_TITLE}>{t('diagHmi.pid.selection')}</span>
          {state.mockMode && <DiagDemoBadge />}
        </div>

        {/* Select All / Clear All */}
        <div className="flex shrink-0 gap-1 border-b border-hairline p-2">
          <button type="button" onClick={handleSelectAll} className={`${DIAG_BTN_SM} flex-1`}>
            {t('diag.pid.selectAll')}
          </button>
          <button type="button" onClick={handleClearAll} className={`${DIAG_BTN_SM} flex-1`}>
            {t('diag.pid.clearAll')}
          </button>
        </div>

        {/* PID list */}
        <div className="flex-1 overflow-y-auto">
          {PID_CATALOG.map((def) => {
            const active = activePids.has(def.pid);
            return (
              <label
                key={def.pid}
                className={`flex h-[30px] cursor-pointer items-center gap-2 border-b border-hairline px-3 ${DIAG_ROW_HOVER}`}
              >
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => handleTogglePid(def.pid)}
                  className={DIAG_CHECKBOX}
                />
                <span className="w-7 shrink-0 font-mono text-[11.5px] tabular-nums text-focus">
                  {def.pid.toString(16).toUpperCase().padStart(2, '0')}
                </span>
                <span className={`truncate text-[12px] ${active ? 'text-ink' : 'text-muted'}`}>{def.name}</span>
              </label>
            );
          })}
        </div>

        {/* Polling controls */}
        <div className="shrink-0 space-y-2 border-t border-hairline bg-elevated p-2">
          <div className="flex items-center gap-2">
            <span className={DIAG_SECTION_TITLE}>{t('diag.pid.interval')}</span>
            <div className="flex-1">
              <DiagSelectWrap chevron={<ChevronDown className="h-3 w-3" aria-hidden="true" />}>
                <select
                  value={pidPollingMs}
                  onChange={(e) => diagnosticsStore.setPidPollingMs(Number(e.target.value))}
                  className={`${DIAG_SELECT} !h-[26px] text-[12px]`}
                >
                  {POLLING_OPTIONS.map((ms) => (
                    <option key={ms} value={ms}>
                      {ms}ms
                    </option>
                  ))}
                </select>
              </DiagSelectWrap>
            </div>
          </div>

          <button
            type="button"
            onClick={handleTogglePolling}
            disabled={!connected || activePids.size === 0}
            className={`${isPolling ? DIAG_BTN : DIAG_BTN_PRIMARY} w-full`}
          >
            {isPolling ? (
              <>
                <Square className="h-3 w-3" aria-hidden="true" />
                {t('diag.pid.stop')}
              </>
            ) : (
              <>
                <Play className="h-3 w-3" aria-hidden="true" />
                {t('diag.pid.start')}
              </>
            )}
          </button>
        </div>
      </div>

      {/* Right panel - Gauges */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline bg-elevated px-3">
          <span className={DIAG_SECTION_TITLE}>{t('diag.pid.title')}</span>
          <DiagBadge tone="focus" title={t('diag.pid.protocolNote')}>
            {t('diag.pid.protocolBadge')}
          </DiagBadge>
          {!state.mockMode && (
            <span className="font-mono tabular-nums text-[12px] text-muted" title={t('diag.pid.protocolNote')}>
              {`TX ${fmtCanId(session.config.requestId, session.config.isExtendedId)} → RX ${fmtCanId(session.config.responseId, session.config.isExtendedId)} · phys`}
            </span>
          )}
          <span className="ml-auto min-w-0 truncate text-[11px] text-muted">{t('diag.pid.protocolNote')}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {activePids.size === 0 ? (
          <DiagEmptyState title={t('diag.pid.noSelection')} />
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
            {Array.from(activePids).map((pid) => (
              <GaugeCard key={pid} pid={pid} />
            ))}
          </div>
        )}
        </div>
      </div>
    </div>
  );
};
