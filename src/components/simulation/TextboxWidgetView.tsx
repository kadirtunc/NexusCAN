import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock } from 'lucide-react';
import { useI18n, type TranslationKey } from '../../i18n';
import type { SimulationTextFormat, SimulationTextMode } from '../../types/simulation';

export type TextboxValidation =
  | { ok: true }
  | { ok: false; errorKey: TranslationKey; params?: Record<string, number | string> };

export interface TextboxSendOutcome {
  tone: 'ok' | 'warn' | 'error';
  /** Already translated, short (shown under the widget for a few seconds). */
  message: string;
}

/** Data-source specific part of a textbox (numeric CAN signal, UDS DID, ...). */
export interface TextboxAdapter {
  validate: (text: string) => TextboxValidation;
  send: (text: string) => Promise<TextboxSendOutcome>;
  /** Confirmation dialog body (target + payload). */
  describe: (text: string) => readonly string[];
}

export interface TextboxViewProps {
  mode: SimulationTextMode;
  format: SimulationTextFormat;
  /** Formatted live value, `null` = no data yet. */
  liveDisplay: string | null;
  unit: string;
  /** Live value in editable representation (seed of readwrite editing). */
  editSeed: string;
  isRunMode: boolean;
  canEdit: boolean;
  lockedLabel: string | null;
  placeholder?: string;
  maxLength?: number;
  sendOnEnter: boolean;
  confirmBeforeSend: boolean;
  adapter: TextboxAdapter;
  accentHex: string;
}

const RESULT_VISIBLE_MS = 4000;

const OUTCOME_COLOR: Record<TextboxSendOutcome['tone'], string> = {
  ok: 'var(--status-nominal)',
  warn: 'var(--status-warn)',
  error: 'var(--status-critical)',
};

function ConfirmDialog({
  lines,
  onCancel,
  onConfirm,
}: {
  lines: readonly string[];
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-scrim)' }}
      role="dialog"
      aria-modal="true"
      aria-label={t('textbox.confirm.title')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="w-full max-w-md rounded-[2px] border border-strong bg-surface">
        <div className="flex h-10 items-center border-b border-hairline bg-elevated px-3.5 font-mono text-xs font-semibold uppercase tracking-wider text-ink">
          {t('textbox.confirm.title')}
        </div>
        <div className="space-y-1 p-4 font-mono text-[11px] tabular-nums text-ink">
          {lines.map((line, i) => (
            <div key={`${i}-${line}`} className="break-all">
              {line}
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-hairline p-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="h-[30px] cursor-pointer rounded-[2px] border border-hairline bg-elevated px-3.5 font-mono text-[12px] text-ink"
          >
            {t('textbox.confirm.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-[30px] cursor-pointer rounded-[2px] border px-4 font-mono text-[12px] font-semibold uppercase"
            style={{
              backgroundColor: 'var(--status-critical-bg)',
              borderColor: 'var(--status-critical-border)',
              color: 'var(--status-critical)',
            }}
          >
            {t('textbox.confirm.send')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function TextboxWidgetView({
  mode,
  format,
  liveDisplay,
  unit,
  editSeed,
  isRunMode,
  canEdit,
  lockedLabel,
  placeholder,
  maxLength,
  sendOnEnter,
  confirmBeforeSend,
  adapter,
  accentHex,
}: TextboxViewProps): React.JSX.Element {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<TextboxSendOutcome | null>(null);
  const mountedRef = useRef(true);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  // Leaving RUN mode discards any half-typed edit.
  useEffect(() => {
    if (!isRunMode) {
      setDraft(null);
      setError(null);
      setPendingConfirm(null);
    }
  }, [isRunMode]);

  const isEditable = mode !== 'display';
  const isReadWrite = mode === 'readwrite';
  const inputValue = draft ?? (isReadWrite ? editSeed : '');
  const dirty = isReadWrite ? draft !== null && draft !== editSeed : (draft ?? '').length > 0;

  const flash = useCallback((next: TextboxSendOutcome) => {
    setOutcome(next);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setOutcome(null);
    }, RESULT_VISIBLE_MS);
  }, []);

  const perform = useCallback(
    async (text: string) => {
      setSending(true);
      const result = await adapter.send(text);
      if (!mountedRef.current) return;
      setSending(false);
      flash(result);
      if (result.tone !== 'error' && isReadWrite) setDraft(null);
    },
    [adapter, flash, isReadWrite]
  );

  const submit = useCallback(() => {
    if (!canEdit || sending) return;
    const text = inputValue;
    const verdict = adapter.validate(text);
    if (!verdict.ok) {
      setError(t(verdict.errorKey, verdict.params));
      return;
    }
    setError(null);
    if (confirmBeforeSend) {
      setPendingConfirm(text);
      return;
    }
    void perform(text);
  }, [adapter, canEdit, confirmBeforeSend, inputValue, perform, sending, t]);

  const formatTag = t(`textbox.fmt.${format}`);

  return (
    <div className="flex h-full w-full min-h-0 flex-col justify-between gap-1 p-2.5 font-mono tabular-nums">
      {!isEditable ? (
        <div
          className="flex min-h-0 flex-1 items-center rounded-[2px] border border-hairline bg-canvas px-2.5 py-1.5"
          aria-live="off"
        >
          <span
            className="min-w-0 flex-1 truncate text-[15px] font-bold leading-tight text-ink"
            title={liveDisplay ?? undefined}
          >
            {liveDisplay ?? t('textbox.noData')}
          </span>
          {unit && liveDisplay !== null && (
            <span className="ml-2 shrink-0 rounded-[2px] border border-hairline bg-elevated px-1.5 py-0.5 text-[10px] font-semibold text-muted">
              {unit}
            </span>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center gap-1.5">
          <input
            type="text"
            spellCheck={false}
            autoComplete="off"
            readOnly={!canEdit || sending}
            disabled={!isRunMode}
            value={inputValue}
            maxLength={maxLength && maxLength > 0 ? maxLength : undefined}
            placeholder={placeholder}
            aria-invalid={error !== null}
            aria-label={placeholder ?? formatTag}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && sendOnEnter) {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setDraft(null);
                setError(null);
              }
            }}
            style={{
              borderColor: error
                ? 'var(--status-critical)'
                : dirty
                  ? accentHex
                  : 'var(--border-strong)',
            }}
            className="h-full min-h-[26px] min-w-0 flex-1 rounded-[2px] border bg-canvas px-2 text-[13px] font-semibold text-ink placeholder:text-subtle disabled:cursor-not-allowed disabled:opacity-65 read-only:cursor-not-allowed"
          />
          <button
            type="button"
            disabled={!canEdit || sending || !dirty}
            onClick={submit}
            className="h-[26px] shrink-0 cursor-pointer rounded-[2px] border border-strong bg-elevated px-2 text-[10px] font-bold uppercase tracking-wider text-focus hover:border-focus disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('textbox.send')}
          </button>
        </div>
      )}

      <div className="flex min-h-[14px] items-center justify-between gap-1.5 text-[9px] text-muted">
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          <span className="shrink-0 rounded-[2px] border border-hairline bg-canvas px-1 py-px uppercase text-subtle">
            {formatTag}
          </span>
          {isReadWrite && dirty && (
            <>
              <span className="shrink-0 font-bold uppercase text-warn">{t('textbox.dirty')}</span>
              <span className="min-w-0 truncate" title={liveDisplay ?? undefined}>
                {t('textbox.live')}: <strong className="text-ink">{liveDisplay ?? t('textbox.noData')}</strong>
              </span>
            </>
          )}
          {error && (
            <span className="min-w-0 truncate font-semibold" style={{ color: 'var(--status-critical)' }} role="alert">
              {error}
            </span>
          )}
          {!error && outcome && (
            <span className="min-w-0 truncate font-semibold" style={{ color: OUTCOME_COLOR[outcome.tone] }} title={outcome.message}>
              {outcome.message}
            </span>
          )}
          {!error && !outcome && !dirty && isEditable && isRunMode && (
            <span className="truncate text-subtle">{t('textbox.hint')}</span>
          )}
        </span>
        {lockedLabel && isEditable && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-[2px] border px-1.5 py-0.5 font-semibold uppercase"
            style={{
              backgroundColor: 'var(--status-nominal-bg)',
              borderColor: 'var(--status-nominal-border)',
              color: 'var(--status-nominal)',
            }}
          >
            <Lock className="h-2.5 w-2.5" aria-hidden="true" />
            {lockedLabel}
          </span>
        )}
      </div>

      {pendingConfirm !== null && (
        <ConfirmDialog
          lines={adapter.describe(pendingConfirm)}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => {
            const text = pendingConfirm;
            setPendingConfirm(null);
            void perform(text);
          }}
        />
      )}
    </div>
  );
}
