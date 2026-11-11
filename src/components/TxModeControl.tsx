import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useI18n } from '../i18n';
import { disarmAllBuses, setBusTxArmed } from '../store/busTxControl';
import { databaseStore } from '../store/databaseStore';
import { useTelemetryHeader } from '../store/telemetryStore';
import type { BusHealthDto } from '../types/hal';

type AggregateKind = 'noBus' | 'passive' | 'active' | 'locked';

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Global TX mode indicator + control (TopBar right corner). Always visible. Arming requires an
 * explicit in-popover confirmation; disarming is immediate. Panic Stop remains a separate button.
 */
export const TxModeControl: React.FC = () => {
  const { t } = useI18n();
  const header = useTelemetryHeader();
  const [open, setOpen] = useState(false);
  const [confirmBus, setConfirmBus] = useState<number | null>(null);
  const [pending, setPending] = useState<ReadonlySet<number>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<number, string>>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popId = useId();

  const connected = header.buses.filter((b) => b.connected);
  const armedCount = connected.filter((b) => b.txArmed).length;
  const total = connected.length;
  const kind: AggregateKind =
    header.txPanicLatched && armedCount === 0
      ? 'locked'
      : total === 0
        ? 'noBus'
        : armedCount > 0
          ? 'active'
          : 'passive';

  const close = useCallback((): void => {
    setOpen(false);
    setConfirmBus(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        close();
        btnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const setPendingFor = (busId: number, on: boolean): void => {
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(busId);
      else next.delete(busId);
      return next;
    });
  };

  const applyMode = async (busId: number, armed: boolean): Promise<void> => {
    setPendingFor(busId, true);
    setErrors((prev) => {
      const { [busId]: _drop, ...rest } = prev;
      return rest;
    });
    try {
      await setBusTxArmed(busId, armed);
    } catch (err) {
      setErrors((prev) => ({ ...prev, [busId]: errText(err) }));
    } finally {
      setPendingFor(busId, false);
      setConfirmBus(null);
    }
  };

  const onDisarmAll = async (): Promise<void> => {
    const ids = connected.filter((b) => b.txArmed).map((b) => b.busId);
    ids.forEach((id) => setPendingFor(id, true));
    try {
      await disarmAllBuses();
      setErrors({});
    } catch (err) {
      setErrors((prev) => ({ ...prev, [ids[0] ?? 0]: errText(err) }));
    } finally {
      ids.forEach((id) => setPendingFor(id, false));
    }
  };

  const label =
    kind === 'noBus'
      ? t('shell.tx.noBus')
      : kind === 'locked'
        ? t('shell.tx.locked')
        : kind === 'active'
          ? t('shell.tx.active', { armed: armedCount, total })
          : t('shell.tx.passive');

  const tone =
    kind === 'active'
      ? { bg: 'rgba(245, 158, 11, 0.9)', border: '#fbbf24', color: '#111827' }
      : kind === 'locked'
        ? { bg: 'rgba(185, 28, 28, 0.25)', border: '#ef4444', color: '#fca5a5' }
        : kind === 'passive'
          ? { bg: 'rgba(16, 185, 129, 0.14)', border: 'rgba(16, 185, 129, 0.6)', color: '#34d399' }
          : { bg: 'var(--bg-panel)', border: 'var(--border-strong)', color: 'var(--text-secondary)' };

  const busLabel = (b: BusHealthDto): string =>
    t('shell.tx.busLine', { bus: b.busId + 1, channel: b.channelName });

  const modeBadge = (b: BusHealthDto): { text: string; cls: string } =>
    b.txArmed
      ? { text: t('shell.tx.mode.active'), cls: 'bg-amber-500 text-slate-900 border-amber-300' }
      : b.listenOnly
        ? { text: t('shell.tx.mode.listenOnly'), cls: 'text-emerald-400 border-emerald-600/60' }
        : { text: t('shell.tx.mode.passive'), cls: 'text-slate-300 border-slate-600' };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        style={{ backgroundColor: tone.bg, borderColor: tone.border, color: tone.color }}
        className="h-[32px] min-w-[150px] px-2.5 border flex items-center justify-center gap-1.5 text-[12px] font-bold font-mono tabular-nums cursor-pointer rounded-[3px] whitespace-nowrap"
        title={t('shell.tx.tooltip')}
      >
        {kind === 'active' || kind === 'locked' ? (
          <ShieldAlert className="w-4 h-4" aria-hidden="true" />
        ) : (
          <ShieldCheck className="w-4 h-4" aria-hidden="true" />
        )}
        <span>{label}</span>
      </button>

      {open && (
        <div
          id={popId}
          role="dialog"
          aria-label={t('shell.tx.title')}
          style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-strong)' }}
          className="absolute right-0 top-[36px] z-50 w-[400px] border rounded-[3px] shadow-lg p-2.5 text-[12px] text-[var(--text-primary)]"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="font-bold uppercase tracking-wide text-[11px] text-[var(--text-secondary)]">
              {t('shell.tx.title')}
            </span>
            {armedCount > 0 && (
              <button
                type="button"
                onClick={() => void onDisarmAll()}
                className="h-[24px] px-2 border border-amber-500 text-amber-300 text-[11px] font-bold cursor-pointer rounded-[3px]"
              >
                {t('shell.tx.disarmAll')}
              </button>
            )}
          </div>

          {header.txPanicLatched && (
            <div className="mb-2 px-2 py-1.5 border border-red-500/60 bg-red-900/20 text-red-300 text-[11.5px]">
              {t('shell.tx.lockedHint')}
            </div>
          )}

          {total === 0 ? (
            <div className="flex flex-col gap-2">
              <div className="text-[var(--text-secondary)]">{t('shell.tx.noBusHint')}</div>
              <button
                type="button"
                autoFocus
                onClick={() => {
                  databaseStore.setActiveDocTab('connections');
                  close();
                }}
                className="h-[26px] px-2 self-start border border-[var(--border-strong)] text-[11.5px] cursor-pointer rounded-[3px]"
              >
                {t('shell.tx.openConnections')}
              </button>
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {connected.map((b) => {
                const badge = modeBadge(b);
                const isPending = pending.has(b.busId);
                const confirming = confirmBus === b.busId && !b.txArmed;
                return (
                  <li
                    key={b.busId}
                    className="border border-[var(--border-strong)] rounded-[3px] p-2 flex flex-col gap-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono tabular-nums font-bold truncate flex-1">
                        {busLabel(b)}
                      </span>
                      <span
                        className={`px-1.5 border text-[10.5px] font-bold font-mono tabular-nums ${badge.cls}`}
                      >
                        {badge.text}
                      </span>
                      <span className="font-mono tabular-nums text-[10.5px] text-[var(--text-secondary)] min-w-[56px] text-right">
                        {b.busState}
                      </span>
                      {isPending ? (
                        <Loader2
                          className="w-4 h-4 animate-spin text-amber-400"
                          aria-label={t('shell.tx.pending')}
                        />
                      ) : b.txArmed ? (
                        <button
                          type="button"
                          onClick={() => void applyMode(b.busId, false)}
                          className="h-[24px] px-2 border border-emerald-600 text-emerald-300 text-[11px] font-bold cursor-pointer rounded-[3px]"
                        >
                          {t('shell.tx.disarm')}
                        </button>
                      ) : (
                        !confirming && (
                          <button
                            type="button"
                            onClick={() => setConfirmBus(b.busId)}
                            className="h-[24px] px-2 border border-amber-500 text-amber-300 text-[11px] font-bold cursor-pointer rounded-[3px]"
                          >
                            {t('shell.tx.arm')}
                          </button>
                        )
                      )}
                    </div>
                    {confirming && !isPending && (
                      <div className="border border-amber-500/70 bg-amber-900/20 p-2 flex flex-col gap-1.5">
                        <div className="text-amber-200 text-[11.5px]">
                          {t('shell.tx.confirmText', { bus: b.busId + 1 })}
                        </div>
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            autoFocus
                            onClick={() => void applyMode(b.busId, true)}
                            className="h-[24px] px-2 bg-amber-500 text-slate-900 text-[11px] font-bold cursor-pointer rounded-[3px]"
                          >
                            {t('shell.tx.confirm', { bus: b.busId + 1 })}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmBus(null)}
                            className="h-[24px] px-2 border border-[var(--border-strong)] text-[11px] cursor-pointer rounded-[3px]"
                          >
                            {t('shell.tx.cancel')}
                          </button>
                        </div>
                      </div>
                    )}
                    {errors[b.busId] !== undefined && (
                      <div role="alert" className="text-red-400 text-[11px] font-mono break-words">
                        {t('shell.tx.error', { err: errors[b.busId] })}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
