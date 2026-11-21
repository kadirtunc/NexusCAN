import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../i18n';
import { onboardingStore, useOnboardingStore } from '../store/onboardingStore';
import { GUIDE_PAGES } from './registry';
import { startPageTourOnTab } from './driverTour';
import { splitInlineCode } from './richText';
import type { GuideInfoItem, GuidePageDef } from './types';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

const RichText: React.FC<{ text: string }> = ({ text }) => (
  <>
    {splitInlineCode(text).map((seg, i) =>
      seg.code ? (
        <span key={i} className="font-mono tabular-nums text-focus">
          {seg.text}
        </span>
      ) : (
        <React.Fragment key={i}>{seg.text}</React.Fragment>
      ),
    )}
  </>
);

const BADGE_CLASS: Record<NonNullable<GuideInfoItem['badge']>, string> = {
  readOnly: 'border-[var(--status-nominal-border)] text-nominal',
  confirm: 'border-[var(--status-warn-border)] text-warn',
};

/** Compact reference table (code column + description) with a filter box; reusable for tools, shortcuts, ... */
const ItemsTable: React.FC<{ items: readonly GuideInfoItem[] }> = ({ items }) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () => (q === '' ? items : items.filter((it) => it.code.toLowerCase().includes(q) || t(it.descKey).toLowerCase().includes(q))),
    [items, q, t],
  );
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('onb.dialog.filter.placeholder')}
          aria-label={t('onb.dialog.filter.placeholder')}
          style={{ backgroundColor: 'var(--bg-row-signal)', borderColor: 'var(--border-grid)' }}
          className="flex-1 min-w-0 h-[24px] px-2 border text-[11.5px] text-[var(--text-primary)]"
        />
        <span className="shrink-0 font-mono tabular-nums text-[11px] text-[var(--text-muted)]">
          {rows.length} / {items.length} {t('onb.dialog.filter.count')}
        </span>
      </div>
      <dl style={{ borderColor: 'var(--border-grid)' }} className="border text-[11.5px]">
        {rows.length === 0 && <div className="px-2 py-1.5 text-[var(--text-muted)]">{t('onb.dialog.filter.empty')}</div>}
        {rows.map((it) => (
          <div
            key={it.code}
            style={{ borderColor: 'var(--border-grid)' }}
            className="px-2 py-1 flex gap-3 items-baseline border-b last:border-b-0"
          >
            <dt className="shrink-0 w-[168px] font-mono tabular-nums text-focus break-all">{it.code}</dt>
            <dd className="flex-1 min-w-0 leading-snug text-[var(--text-secondary)]">
              {it.badge !== undefined && (
                <span
                  className={`mr-1.5 px-1 border rounded-[2px] font-mono text-[10px] uppercase align-middle ${BADGE_CLASS[it.badge]}`}
                >
                  {t(`onb.dialog.badge.${it.badge}` as const)}
                </span>
              )}
              <RichText text={t(it.descKey)} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
};

interface DialogBodyProps {
  def: GuidePageDef;
  sectionId: string | null;
}

const DialogBody: React.FC<DialogBodyProps> = ({ def, sectionId }) => {
  const { t } = useI18n();
  const state = useOnboardingStore();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const returnFocusRef = useRef<Element | null>(document.activeElement);

  const close = useCallback((): void => onboardingStore.closeDialog(), []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const target = sectionId ? root.querySelector<HTMLElement>(`[data-section="${sectionId}"]`) : null;
    if (target) target.scrollIntoView({ block: 'start' });
    const first = root.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const back = returnFocusRef.current;
    return () => {
      if (back instanceof HTMLElement) back.focus();
    };
  }, [sectionId]);

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

  const btn =
    'h-[28px] px-3 border text-[12px] cursor-pointer rounded-[3px] hover:border-[var(--text-secondary)]';

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
            {t(def.titleKey)}
          </span>
          <button
            type="button"
            onClick={close}
            aria-label={t('onb.btn.close')}
            className="w-[26px] h-[26px] flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-4 select-text">
          {def.info.map((sec) => (
            <section
              key={sec.id}
              data-section={sec.id}
              style={
                sec.id === sectionId
                  ? { borderLeft: '2px solid var(--status-focus)', paddingLeft: '10px' }
                  : { borderLeft: '2px solid transparent', paddingLeft: '10px' }
              }
              className="flex flex-col gap-1.5"
            >
              <h3 className="font-bold text-[12.5px]">{t(sec.headingKey)}</h3>
              {sec.bodyKeys.map((k) => (
                <p key={k} className="leading-relaxed text-[var(--text-secondary)] break-words">
                  <RichText text={t(k)} />
                </p>
              ))}
              {sec.items !== undefined && sec.items.length > 0 && <ItemsTable items={sec.items} />}
              {sec.id === 'txSafety' && (
                <div className="pt-1">
                  {state.txSafetyAcked ? (
                    <span className="text-nominal text-[11.5px]">{t('onb.dialog.acked')}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onboardingStore.ackTxSafety()}
                      style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-strong)' }}
                      className={btn}
                    >
                      {t('onb.dialog.ack')}
                    </button>
                  )}
                </div>
              )}
            </section>
          ))}

          <section className="flex flex-col gap-1.5" style={{ paddingLeft: '12px' }}>
            <h3 className="font-bold text-[12.5px]">{t('onb.dialog.tipsHeading')}</h3>
            <ul className="list-disc pl-4 flex flex-col gap-1 text-[var(--text-secondary)]">
              {def.tips.map((k) => (
                <li key={k} className="leading-relaxed">
                  <RichText text={t(k)} />
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div
          style={{ borderTop: '1px solid var(--border-strong)', backgroundColor: 'var(--bg-header)' }}
          className="shrink-0 px-4 py-2 flex items-center justify-end gap-2"
        >
          {def.id === 'start' && state.startPanelHidden && (
            <button
              type="button"
              onClick={() => onboardingStore.setStartPanelHidden(false)}
              style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-strong)' }}
              className={btn}
            >
              {t('onb.start.showPanel')}
            </button>
          )}
          {def.tour.length > 0 && (
            <button
              type="button"
              onClick={() => {
                close();
                startPageTourOnTab(def.id);
              }}
              style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--status-focus)', color: 'var(--status-focus)' }}
              className={btn}
            >
              {t('onb.dialog.startTour')}
            </button>
          )}
          <button
            type="button"
            onClick={close}
            style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-strong)' }}
            className={btn}
          >
            {t('onb.btn.close')}
          </button>
        </div>
      </div>
    </div>
  );
};

/** Mount once (App root). Renders the info dialog for whichever page def the store requests. */
export const GuideInfoDialog: React.FC = () => {
  const { dialog } = useOnboardingStore();
  if (dialog === null) return null;
  return <DialogBody key={dialog.pageId} def={GUIDE_PAGES[dialog.pageId]} sectionId={dialog.sectionId} />;
};
