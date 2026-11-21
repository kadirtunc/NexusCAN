import React, { useCallback, useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { getLocale, useI18n } from '../i18n';
import { apiOpenReleasePage } from '../services/ipcClient';
import { newerBuildAvailable, shouldShowNotice, updateStore, useUpdateStore } from '../store/updateStore';
import type { ReleaseInfoDto } from '../types/update';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

/** Opens a GitHub releases URL through the backend only (it rejects everything else). Failures are non-fatal. */
function openRelease(url?: string): void {
  apiOpenReleasePage(url).catch((e: unknown) => {
    console.debug('[update-check] open release page failed:', e);
  });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(getLocale() === 'en' ? 'en-GB' : 'tr-TR');
}

// ---------------------------------------------------------------------------
// Minimal markdown: `#` headings, `- ` bullets, `code`, **bold**, `|` table rows as mono <pre>.
// No HTML injection: everything is rendered as React text nodes.
// ---------------------------------------------------------------------------

export type MdBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; lines: string[] }
  | { kind: 'para'; text: string };

export function parseMarkdown(src: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const last = blocks[blocks.length - 1];
    if (trimmed.startsWith('|')) {
      if (last?.kind === 'table') last.lines.push(line);
      else blocks.push({ kind: 'table', lines: [line] });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      blocks.push({ kind: 'heading', level: h[1].length, text: h[2] });
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(trimmed);
    if (li) {
      if (last?.kind === 'list') last.items.push(li[1]);
      else blocks.push({ kind: 'list', items: [li[1]] });
      continue;
    }
    if (last?.kind === 'para') last.text += ` ${trimmed}`;
    else blocks.push({ kind: 'para', text: trimmed });
  }
  return blocks;
}

const Inline: React.FC<{ text: string }> = ({ text }) => (
  <>
    {text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((seg, i) => {
      if (seg.length > 2 && seg.startsWith('`') && seg.endsWith('`')) {
        return (
          <span key={i} className="font-mono tabular-nums text-focus">
            {seg.slice(1, -1)}
          </span>
        );
      }
      if (seg.length > 4 && seg.startsWith('**') && seg.endsWith('**')) {
        return (
          <strong key={i} className="font-bold text-primary">
            {seg.slice(2, -2)}
          </strong>
        );
      }
      return <React.Fragment key={i}>{seg}</React.Fragment>;
    })}
  </>
);

const Markdown: React.FC<{ source: string }> = ({ source }) => {
  const blocks = parseMarkdown(source);
  return (
    <div className="flex flex-col gap-1.5 text-[12px] leading-relaxed text-secondary break-words">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return (
              <div key={i} className="font-bold text-[12.5px] text-primary pt-1">
                <Inline text={b.text} />
              </div>
            );
          case 'list':
            return (
              <ul key={i} className="list-disc pl-4 flex flex-col gap-0.5">
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inline text={it} />
                  </li>
                ))}
              </ul>
            );
          case 'table':
            return (
              <pre
                key={i}
                style={{ borderColor: 'var(--border-grid)' }}
                className="border px-2 py-1 overflow-x-auto font-mono tabular-nums text-[11px] text-secondary"
              >
                {b.lines.join('\n')}
              </pre>
            );
          case 'para':
            return (
              <p key={i}>
                <Inline text={b.text} />
              </p>
            );
        }
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Notice card (bottom right)
// ---------------------------------------------------------------------------

const BTN =
  'h-[26px] px-2.5 border text-[12px] cursor-pointer rounded-[3px] hover:border-[var(--text-secondary)] disabled:opacity-50 disabled:cursor-default';

const NoticeCard: React.FC = () => {
  const { t } = useI18n();
  const { result } = useUpdateStore();
  const latest = result?.latest;
  if (!latest) return null;
  return (
    <div
      role="status"
      style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--status-focus-border)' }}
      className="fixed right-4 bottom-4 z-[850] w-[320px] border rounded-[3px] px-3 py-2.5 flex flex-col gap-2 text-[12px] text-primary"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-semibold leading-snug">
          {t('upd.card.title', { build: latest.build })}
        </span>
        <button
          type="button"
          onClick={() => updateStore.dismissNotice()}
          aria-label={t('upd.card.dismiss')}
          title={t('upd.card.dismiss')}
          className="shrink-0 w-[20px] h-[20px] flex items-center justify-center text-secondary hover:text-primary cursor-pointer"
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => updateStore.openDialog(false)}
          style={{ backgroundColor: 'var(--status-focus-bg)', borderColor: 'var(--status-focus-border)' }}
          className={`${BTN} text-focus`}
        >
          {t('upd.card.notes')}
        </button>
        <button
          type="button"
          onClick={() => openRelease()}
          style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-strong)' }}
          className={BTN}
        >
          {t('upd.card.releases')}
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Release notes dialog
// ---------------------------------------------------------------------------

const ReleaseEntry: React.FC<{ rel: ReleaseInfoDto }> = ({ rel }) => {
  const { t } = useI18n();
  return (
    <section
      style={{ borderColor: 'var(--border-grid)' }}
      className="border rounded-[3px] px-3 py-2 flex flex-col gap-1.5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-bold text-[12.5px] text-primary break-words min-w-0">
          {rel.name !== '' ? rel.name : rel.tag}
        </h3>
        <span className="shrink-0 font-mono tabular-nums text-[11px] text-muted">
          {t('upd.dialog.build', { build: rel.build })} · {formatDate(rel.publishedAt)}
        </span>
      </div>
      {rel.notesMarkdown.trim() === '' ? (
        <p className="text-muted">{t('upd.dialog.noNotes')}</p>
      ) : (
        <Markdown source={rel.notesMarkdown} />
      )}
      <div>
        <button
          type="button"
          onClick={() => openRelease(rel.htmlUrl)}
          style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-strong)' }}
          className={BTN}
        >
          {t('upd.dialog.openRelease')}
        </button>
      </div>
    </section>
  );
};

const DialogBody: React.FC = () => {
  const { t } = useI18n();
  const state = useUpdateStore();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const returnFocusRef = useRef<Element | null>(document.activeElement);
  const close = useCallback((): void => updateStore.closeDialog(), []);

  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const back = returnFocusRef.current;
    return () => {
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const root = rootRef.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const cur = document.activeElement;
    if (e.shiftKey && cur === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && cur === last) {
      e.preventDefault();
      first.focus();
    } else if (!root.contains(cur)) {
      e.preventDefault();
      first.focus();
    }
  };

  const { result } = state;
  const isDev = result !== null && result.currentBuild === null;
  const list: ReleaseInfoDto[] =
    result === null
      ? []
      : isDev
        ? result.latest !== null
          ? [result.latest]
          : []
        : result.updateAvailable
          ? result.newerReleases
          : [];
  const lastChecked =
    state.lastCheckedAtMs > 0 ? formatDate(new Date(state.lastCheckedAtMs).toISOString()) : t('upd.dialog.never');

  return (
    <div
      onMouseDown={close}
      className="fixed inset-0 z-[900] bg-[var(--bg-scrim)] flex items-center justify-center p-4 select-none"
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{
          backgroundColor: 'var(--bg-panel)',
          borderColor: 'var(--border-strong)',
          color: 'var(--text-primary)',
        }}
        className="w-full max-w-[680px] max-h-[88vh] border flex flex-col text-[12px] font-sans rounded-[3px]"
      >
        <div
          style={{ backgroundColor: 'var(--bg-header)', borderBottom: '1px solid var(--border-strong)' }}
          className="h-[40px] px-4 flex items-center justify-between shrink-0"
        >
          <span id={titleId} className="font-semibold text-[13px] tracking-wide">
            {t('upd.dialog.title')}
          </span>
          <button
            type="button"
            onClick={close}
            aria-label={t('upd.dialog.close')}
            className="w-[26px] h-[26px] flex items-center justify-center text-secondary hover:text-primary cursor-pointer"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-3 select-text">
          <div className="flex flex-col gap-1">
            {result !== null && (
              <div className="font-mono tabular-nums text-[12px] text-primary">
                {result.currentBuild === null
                  ? t('upd.dialog.currentDev', { version: result.currentVersion })
                  : t('upd.dialog.current', { version: result.currentVersion, build: result.currentBuild })}
              </div>
            )}
            <div className="font-mono tabular-nums text-[11px] text-muted">
              {t('upd.dialog.lastChecked', { when: lastChecked })}
            </div>
          </div>

          {state.error !== null && (
            <div
              role="alert"
              style={{ backgroundColor: 'var(--status-critical-bg)', borderColor: 'var(--status-critical-border)' }}
              className="border rounded-[3px] px-3 py-2 text-critical break-words"
            >
              {state.error}
            </div>
          )}

          {state.checking && <div className="text-secondary">{t('upd.dialog.checking')}</div>}

          {result === null && !state.checking && state.error === null && (
            <div className="text-muted">{t('upd.dialog.noData')}</div>
          )}

          {result !== null && (
            <>
              {isDev ? (
                <div className="text-secondary">{t('upd.dialog.devLatest')}</div>
              ) : result.updateAvailable ? (
                <div className="text-focus font-semibold">
                  {t('upd.dialog.available', { count: result.newerReleases.length })}
                </div>
              ) : (
                <div className="text-nominal font-semibold">{t('upd.dialog.upToDate')}</div>
              )}
              {list.length > 0 && (
                <h2 className="font-bold text-[12.5px]">
                  {isDev ? t('upd.dialog.latestHeading') : t('upd.dialog.newerHeading')}
                </h2>
              )}
              {list.map((rel) => (
                <ReleaseEntry key={rel.tag} rel={rel} />
              ))}
              {isDev && result.latest === null && <div className="text-muted">{t('upd.dialog.noReleases')}</div>}
              <p className="text-muted">{t('upd.dialog.manualDownload')}</p>
            </>
          )}
        </div>

        <div
          style={{ borderTop: '1px solid var(--border-strong)', backgroundColor: 'var(--bg-header)' }}
          className="shrink-0 px-4 py-2 flex items-center gap-3 flex-wrap"
        >
          <label className="flex items-center gap-1.5 cursor-pointer text-secondary mr-auto">
            <input
              type="checkbox"
              checked={state.autoCheck}
              onChange={(e) => updateStore.setAutoCheck(e.target.checked)}
              className="accent-[var(--status-focus)]"
            />
            <span>{t('upd.dialog.auto')}</span>
          </label>
          <button
            type="button"
            disabled={state.checking}
            onClick={() => void updateStore.runCheck(true)}
            style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-strong)' }}
            className={BTN}
          >
            {state.checking ? t('upd.dialog.checking') : t('upd.dialog.checkNow')}
          </button>
          <button
            type="button"
            onClick={() => openRelease()}
            style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--status-focus)', color: 'var(--status-focus)' }}
            className={BTN}
          >
            {t('upd.dialog.openReleases')}
          </button>
          <button
            type="button"
            onClick={close}
            style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-strong)' }}
            className={BTN}
          >
            {t('upd.dialog.close')}
          </button>
        </div>
      </div>
    </div>
  );
};

/** Mount once (App root): bottom-right notice card + release notes dialog. Notification only; never downloads. */
export const UpdateNotice: React.FC = () => {
  const state = useUpdateStore();
  return (
    <>
      {!state.dialogOpen && shouldShowNotice(state.result, state.dismissedBuild) && <NoticeCard />}
      {state.dialogOpen && <DialogBody />}
    </>
  );
};

/** Always-visible status-bar label: installed version, plus a "new update" hint when a newer release build is known. */
export const VersionStatus: React.FC = () => {
  const { t } = useI18n();
  const st = useUpdateStore();
  const v = st.appVersion;
  const newer = newerBuildAvailable(v, st.knownLatestBuild);
  const label =
    v === null ? t('upd.status.web') : v.build === null
      ? t('upd.status.dev', { version: v.version })
      : t('upd.status.version', { version: v.version, build: v.build });
  return (
    <span className="border-l border-[var(--border-grid)] pl-2.5 inline-flex items-center gap-1.5">
      {newer !== null && (
        <button
          type="button"
          onClick={() => updateStore.openDialog(false)}
          title={t('upd.status.tooltip')}
          className="h-[20px] px-2 rounded-xs border border-[var(--status-focus-border)] bg-[var(--status-focus-bg)] text-focus font-sans font-semibold text-[11px] cursor-pointer hover:brightness-125"
        >
          {t('upd.status.new', { build: newer })}
        </button>
      )}
      <button
        type="button"
        onClick={() => updateStore.openDialog(v !== null)}
        disabled={v === null}
        title={t('upd.status.tooltip')}
        className="font-mono tabular-nums text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer disabled:cursor-default disabled:hover:text-[var(--text-muted)]"
      >
        {label}
      </button>
    </span>
  );
};
