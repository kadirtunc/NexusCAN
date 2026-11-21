import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import changelogSource from '../../CHANGELOG.md?raw';
import { useI18n } from '../i18n';
import { updateStore, useUpdateStore } from '../store/updateStore';
import { Markdown } from './UpdateNotice';

/** Drops the file title / intro (everything before the first `## ` release heading). */
function releaseSections(src: string, unreleasedLabel: string): string {
  const start = src.search(/^## /m);
  const body = start >= 0 ? src.slice(start) : src;
  // Local / dev builds still carry the `[Unreleased]` heading; CI stamps the build number.
  return body.replace(/^## \[Unreleased\]\s*$/m, `## ${unreleasedLabel}`);
}

const ChangelogBody: React.FC = () => {
  const { t } = useI18n();
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<Element | null>(document.activeElement);

  useEffect(() => {
    rootRef.current?.focus();
    const back = returnFocusRef.current;
    return () => {
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      updateStore.closeChangelog();
      return;
    }
    if (e.key !== 'Tab' || rootRef.current === null) return;
    const focusables = rootRef.current.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])');
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[900] flex items-center justify-center p-6"
      style={{ backgroundColor: 'var(--bg-scrim)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) updateStore.closeChangelog();
      }}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-strong)' }}
        className="w-[min(760px,100%)] max-h-[85vh] border rounded-[2px] flex flex-col outline-none"
      >
        <div
          style={{ borderBottom: '1px solid var(--border-strong)', backgroundColor: 'var(--bg-header)' }}
          className="shrink-0 h-[40px] px-4 flex items-center justify-between"
        >
          <h2 id={titleId} className="text-[13px] font-bold text-primary">
            {t('upd.changelog.title')}
          </h2>
          <button
            type="button"
            onClick={() => updateStore.closeChangelog()}
            aria-label={t('upd.dialog.close')}
            title={t('upd.dialog.close')}
            className="w-[26px] h-[26px] flex items-center justify-center text-muted hover:text-primary cursor-pointer"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto px-4 py-3">
          <Markdown source={releaseSections(changelogSource, t('upd.changelog.unreleased'))} />
        </div>
      </div>
    </div>
  );
};

/** Help > Changelog: the bundled CHANGELOG.md (offline, also in browser mode). */
export const ChangelogDialog: React.FC = () => {
  const { changelogOpen } = useUpdateStore();
  return changelogOpen ? <ChangelogBody /> : null;
};
