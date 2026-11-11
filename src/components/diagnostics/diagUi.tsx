import React from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../../i18n';
import { formatDiagError } from '../../services/diagErrors';
import type { DiagUiError } from '../../types/diagnostics';

/**
 * Diagnostics tab shared primitives.
 *
 * Every class below is a 1:1 transcription of the patterns used by
 * SimulationWorkbenchView / ReceiveTransmitView / DatabaseExplorer so the
 * Diagnostics tab is visually indistinguishable from the rest of the app:
 *  - 2px corner radius, 1px hairline borders, no shadows / gradients
 *  - toolbar: h-10 on bg-elevated, controls h-[30px] mono 12px uppercase
 *  - status colours come exclusively from the --status-* token family
 */

export type DiagTone = 'nominal' | 'focus' | 'warn' | 'critical' | 'neutral';

// ─── Layout ───────────────────────────────────────────────────────────────────

export const DIAG_TOOLBAR =
  'flex h-10 shrink-0 items-center gap-2 border-b border-hairline bg-elevated px-3.5';

export const DIAG_SUBBAR =
  'flex h-8 shrink-0 items-center gap-2 border-b border-hairline bg-elevated px-3';

export const DIAG_PANEL = 'rounded-[2px] border border-hairline bg-surface';

export const DIAG_SECTION_TITLE =
  'font-mono text-[11.5px] font-semibold uppercase tracking-wider text-muted';

export const DIAG_TITLE = 'font-mono text-xs font-semibold uppercase tracking-wider text-ink';

export const DIAG_DIVIDER = 'h-5 w-px shrink-0 bg-hairline';

// ─── Controls ─────────────────────────────────────────────────────────────────

const BTN_BASE =
  'inline-flex h-[30px] shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 rounded-[2px] border px-3 font-mono text-[12px] font-semibold uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50';

export const DIAG_BTN = `${BTN_BASE} border-hairline bg-elevated text-ink hover:border-focus hover:text-focus`;

export const DIAG_BTN_GHOST = `${BTN_BASE} border-hairline bg-canvas text-muted hover:border-strong hover:text-ink`;

export const DIAG_BTN_PRIMARY = `${BTN_BASE} border-focus bg-focus text-white hover:opacity-90`;

export const DIAG_BTN_DANGER = `${BTN_BASE} border-hairline bg-elevated text-critical hover:border-critical`;

export const DIAG_BTN_WARN = `${BTN_BASE} border-[color:var(--status-warn-border)] bg-[var(--status-warn-bg)] text-warn hover:border-warn`;

export const DIAG_BTN_ACTIVE = `${BTN_BASE} border-focus bg-[var(--status-focus-bg)] text-focus`;

export const DIAG_BTN_SM =
  'inline-flex h-[24px] shrink-0 cursor-pointer select-none items-center justify-center gap-1 rounded-[2px] border border-hairline bg-canvas px-2 font-mono text-[11px] font-semibold uppercase text-muted transition-colors hover:border-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50';

export const DIAG_BTN_SM_ACTIVE =
  'inline-flex h-[24px] shrink-0 cursor-pointer select-none items-center justify-center gap-1 rounded-[2px] border border-focus bg-[var(--status-focus-bg)] px-2 font-mono text-[11px] font-semibold uppercase text-focus transition-colors disabled:cursor-not-allowed disabled:opacity-50';

export const DIAG_INPUT =
  'h-[30px] w-full rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-[12.5px] tabular-nums text-ink outline-none placeholder:text-subtle focus:border-focus disabled:cursor-not-allowed disabled:opacity-50';

export const DIAG_SELECT = `${DIAG_INPUT} cursor-pointer appearance-none pr-7`;

export const DIAG_LABEL = DIAG_SECTION_TITLE;

export const DIAG_CHECKBOX = 'h-3.5 w-3.5 cursor-pointer accent-[var(--status-focus)]';

// ─── Tables (.pcan-grid) ──────────────────────────────────────────────────────

export const DIAG_GRID = 'pcan-grid pcan-grid-fixed font-mono tabular-nums text-[12px]';

export const DIAG_ROW_HOVER = 'hover:bg-[var(--bg-row-hover)]';

// ─── Status colours ───────────────────────────────────────────────────────────

const BADGE_TONE: Record<DiagTone, string> = {
  nominal: 'border-[color:var(--status-nominal-border)] bg-[var(--status-nominal-bg)] text-nominal',
  focus: 'border-[color:var(--status-focus-border)] bg-[var(--status-focus-bg)] text-focus',
  warn: 'border-[color:var(--status-warn-border)] bg-[var(--status-warn-bg)] text-warn',
  critical: 'border-[color:var(--status-critical-border)] bg-[var(--status-critical-bg)] text-critical',
  neutral: 'border-hairline bg-transparent text-muted',
};

export const DIAG_TEXT_TONE: Record<DiagTone, string> = {
  nominal: 'text-nominal',
  focus: 'text-focus',
  warn: 'text-warn',
  critical: 'text-critical',
  neutral: 'text-muted',
};

export const DIAG_ROW_TONE: Record<DiagTone, string> = {
  nominal: 'bg-[var(--status-nominal-bg)]',
  focus: 'bg-[var(--status-focus-bg)]',
  warn: 'bg-[var(--status-warn-bg)]',
  critical: 'bg-[var(--status-critical-bg)]',
  neutral: '',
};

const DOT_TONE: Record<DiagTone, string> = {
  nominal: 'bg-nominal',
  focus: 'bg-focus',
  warn: 'bg-warn',
  critical: 'bg-critical',
  neutral: 'bg-subtle',
};

export function diagBadgeClass(tone: DiagTone): string {
  return `inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[2px] border px-1.5 font-mono text-[11px] font-semibold uppercase leading-none tabular-nums ${BADGE_TONE[tone]}`;
}

/** Toggle / segmented button that takes its tone from the status family when active. */
export function diagToneButtonClass(tone: DiagTone, active: boolean, size: 'md' | 'sm' = 'md'): string {
  const dims = size === 'md' ? 'h-[30px] px-3 text-[12px]' : 'h-[24px] px-2 text-[11px]';
  const state = active
    ? BADGE_TONE[tone]
    : 'border-hairline bg-canvas text-muted hover:border-strong hover:text-ink';
  return `inline-flex ${dims} shrink-0 cursor-pointer select-none items-center justify-center gap-1 rounded-[2px] border font-mono font-semibold uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${state}`;
}

// ─── Components ───────────────────────────────────────────────────────────────

export const DiagBadge: React.FC<{
  tone?: DiagTone;
  title?: string;
  children: React.ReactNode;
}> = ({ tone = 'neutral', title, children }) => (
  <span className={diagBadgeClass(tone)} title={title}>
    {children}
  </span>
);

/** Functional status dot. `pulse` reuses the project's opacity-only keyframe. */
export const DiagDot: React.FC<{ tone?: DiagTone; pulse?: boolean; title?: string }> = ({
  tone = 'neutral',
  pulse = false,
  title,
}) => (
  <span
    className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT_TONE[tone]} ${pulse ? 'nexus-pulse-slow' : ''}`}
    title={title}
    aria-hidden="true"
  />
);

export const DiagEmptyState: React.FC<{
  icon?: React.ReactNode;
  title: string;
  hint?: string;
}> = ({ icon, title, hint }) => (
  <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2 px-4 text-center">
    {icon}
    <p className="font-mono text-[12px] font-semibold uppercase tracking-wider text-muted">{title}</p>
    {hint && <p className="text-[12px] text-subtle">{hint}</p>}
  </div>
);

/** Inline status notice (warn / critical / nominal) used for "not connected" style banners. */
export const DiagNotice: React.FC<{
  tone: Exclude<DiagTone, 'neutral'>;
  icon?: React.ReactNode;
  children: React.ReactNode;
}> = ({ tone, icon, children }) => (
  <div
    className={`flex items-center gap-2.5 rounded-[2px] border px-3 py-2 text-[12px] ${BADGE_TONE[tone]}`}
    role="status"
  >
    {icon}
    <div className="min-w-0 flex-1">{children}</div>
  </div>
);

/** Select with the app's chevron affordance. */
export const DiagSelectWrap: React.FC<{ children: React.ReactNode; chevron: React.ReactNode }> = ({
  children,
  chevron,
}) => (
  <div className="relative">
    {children}
    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted">{chevron}</span>
  </div>
);

/** Visible marker for synthetic (locally generated) data. Rendered only while `mockMode` is on. */
export const DiagDemoBadge: React.FC = () => {
  const { t } = useI18n();
  return (
    <DiagBadge tone="warn" title={t('diagReal.demo.title')}>
      DEMO
    </DiagBadge>
  );
};

/** Localized `[diag:<code>]` error banner (critical, dismissible). */
export const DiagErrorNotice: React.FC<{ error: DiagUiError; onDismiss?: () => void }> = ({
  error,
  onDismiss,
}) => {
  const { t } = useI18n();
  return (
    <DiagNotice tone="critical">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 break-words">{formatDiagError(t, error)}</span>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className={DIAG_BTN_SM}
            title={t('diagReal.error.dismiss')}
            aria-label={t('diagReal.error.dismiss')}
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
      </div>
    </DiagNotice>
  );
};
