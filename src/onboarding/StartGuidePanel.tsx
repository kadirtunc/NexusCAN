import React, { useSyncExternalStore } from 'react';
import { ArrowRight, Check, ChevronDown, Circle, Compass, Info, X } from 'lucide-react';
import { useI18n, type TranslationKey } from '../i18n';
import { connectionStore } from '../store/connectionStore';
import { databaseStore, type ActiveDocumentTab } from '../store/databaseStore';
import { onboardingStore, useOnboardingStore } from '../store/onboardingStore';
import { projectStore } from '../store/projectStore';
import { simulationPanelStore } from '../store/simulationPanelStore';
import { startPageTour } from './driverTour';
import type { GuidePageId } from './types';

type Subscribe = (listener: () => void) => () => void;

/** Boolean-derived subscription: re-renders only when the derived flag flips. */
function useFlag(subscribe: Subscribe, read: () => boolean): boolean {
  return useSyncExternalStore(subscribe, read, read);
}

const readProject = (): boolean => projectStore.getState().hasActiveWorkspace;
const readConnection = (): boolean => connectionStore.getState().profiles.length > 0;
const readDatabase = (): boolean => databaseStore.getState().databases.length > 0;
const readPanels = (): boolean =>
  simulationPanelStore.getState().panels.some((p) => p.widgets.length > 0);

interface StepDef {
  n: 1 | 2 | 3 | 4 | 5;
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  goTab: ActiveDocumentTab | null;
  detailPage: GuidePageId;
  detailSection: string;
  done: boolean;
}

const EXTRA_TABS: readonly { tab: ActiveDocumentTab; labelKey: TranslationKey }[] = [
  { tab: 'trace', labelKey: 'shell.tab.trace' },
  { tab: 'plotter', labelKey: 'shell.tab.plotter' },
  { tab: 'diagnostics', labelKey: 'shell.tab.diagnostics' },
  { tab: 're', labelKey: 're.tab.title' },
];

const BTN =
  'h-[24px] px-2 border text-[11.5px] flex items-center gap-1 cursor-pointer rounded-[2px] hover:border-[var(--text-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]';

/**
 * Persistent (non-dismissible) first-use guide on the Workspace tab. Step status is derived live from the
 * project / connection / database / simulation stores; step 3 completes when the TX safety text is acknowledged.
 * Purely informational: never arms a bus, never transmits.
 */
export const StartGuidePanel: React.FC = () => {
  const { t } = useI18n();
  const onb = useOnboardingStore();
  const projectDone = useFlag(projectStore.subscribe, readProject);
  const connDone = useFlag(connectionStore.subscribe, readConnection);
  const dbDone = useFlag(databaseStore.subscribe, readDatabase);
  const panelDone = useFlag(simulationPanelStore.subscribe, readPanels);

  const steps: readonly StepDef[] = [
    { n: 1, titleKey: 'onb.start.step.1.title', bodyKey: 'onb.start.step.1.body', goTab: null, detailPage: 'start', detailSection: 'step1', done: projectDone },
    { n: 2, titleKey: 'onb.start.step.2.title', bodyKey: 'onb.start.step.2.body', goTab: 'connections', detailPage: 'start', detailSection: 'step2', done: connDone },
    { n: 3, titleKey: 'onb.start.step.3.title', bodyKey: 'onb.start.step.3.body', goTab: 'rxtx', detailPage: 'rxtx', detailSection: 'txSafety', done: onb.txSafetyAcked },
    { n: 4, titleKey: 'onb.start.step.4.title', bodyKey: 'onb.start.step.4.body', goTab: 'symbols', detailPage: 'start', detailSection: 'step4', done: dbDone },
    { n: 5, titleKey: 'onb.start.step.5.title', bodyKey: 'onb.start.step.5.body', goTab: 'panels', detailPage: 'start', detailSection: 'step5', done: panelDone },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (onb.startPanelHidden) {
    // Collapsed state: panel closed with X, but Start Tour and re-open stay on Workspace.
    return (
      <div
        data-tour="start.panel"
        style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-strong)' }}
        className="shrink-0 border rounded-[2px] h-[38px] px-3 flex items-center gap-2"
      >
        <span className="text-[12px] font-bold text-[var(--text-primary)] truncate">{t('onb.start.heading')}</span>
        <span className="font-mono tabular-nums text-[11px] text-[var(--text-muted)] shrink-0">
          {t('onb.start.progress', { done: doneCount, total: steps.length })}
        </span>
        <div data-tour="start.guide-buttons" className="ml-auto flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => startPageTour('start')}
            style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--status-focus)', color: 'var(--status-focus)' }}
            className="h-[26px] px-2.5 border text-[12px] flex items-center gap-1.5 cursor-pointer rounded-[2px] hover:brightness-125"
          >
            <Compass className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('onb.dialog.startTour')}</span>
          </button>
          <button
            type="button"
            onClick={() => onboardingStore.setStartPanelHidden(false)}
            style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }}
            className="h-[26px] px-2.5 border text-[12px] flex items-center gap-1.5 cursor-pointer rounded-[2px] hover:text-[var(--text-primary)]"
          >
            <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('onb.start.expandPanel')}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <section
      data-tour="start.panel"
      aria-label={t('onb.start.heading')}
      style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-strong)' }}
      className="shrink-0 border rounded-[2px] p-3 flex flex-col gap-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-grid)] pb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-[13px] font-bold text-[var(--text-primary)] tracking-tight">
              {t('onb.start.heading')}
            </h2>
            <span className="font-mono tabular-nums text-[11px] text-[var(--text-muted)]">
              {t('onb.start.progress', { done: doneCount, total: steps.length })}
            </span>
          </div>
          <p className="text-[11.5px] text-[var(--text-secondary)] mt-0.5">{t('onb.start.subtitle')}</p>
        </div>
        <div data-tour="start.guide-buttons" className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => startPageTour('start')}
            style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--status-focus)', color: 'var(--status-focus)' }}
            className="h-[28px] px-2.5 border text-[12px] flex items-center gap-1.5 cursor-pointer rounded-[2px] hover:brightness-125"
          >
            <Compass className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('onb.dialog.startTour')}</span>
          </button>
          <button
            type="button"
            onClick={() => onboardingStore.openDialog('start')}
            title={t('onb.info.tooltip')}
            aria-label={t('onb.info.tooltip')}
            style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }}
            className="h-[28px] w-[28px] border flex items-center justify-center cursor-pointer rounded-[2px] hover:text-[var(--text-primary)]"
          >
            <Info className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onboardingStore.setStartPanelHidden(true)}
            title={t('onb.start.hidePanel')}
            aria-label={t('onb.start.hidePanel')}
            style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }}
            className="h-[28px] w-[28px] border flex items-center justify-center cursor-pointer rounded-[2px] hover:text-[var(--text-primary)]"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5 gap-2 list-none m-0 p-0">
        {steps.map((s) => (
          <li
            key={s.n}
            data-tour={`start.step.${s.n}`}
            style={{
              backgroundColor: 'var(--bg-input)',
              borderColor: s.done ? 'var(--status-nominal)' : 'var(--border-grid)',
            }}
            className="min-w-0 border rounded-[2px] p-2.5 flex flex-col gap-1.5"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono tabular-nums text-[12px] font-bold w-[20px] h-[20px] shrink-0 flex items-center justify-center border border-[var(--border-strong)] text-[var(--text-primary)]">
                {s.n}
              </span>
              <h3 className="text-[12px] font-semibold text-[var(--text-primary)] truncate flex-1 min-w-0">
                {t(s.titleKey)}
              </h3>
            </div>
            <p className="text-[11.5px] leading-snug text-[var(--text-secondary)] break-words flex-1">
              {t(s.bodyKey)}
            </p>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span
                className={`flex items-center gap-1 text-[11px] font-mono mr-auto ${
                  s.done ? 'text-nominal' : 'text-[var(--text-muted)]'
                }`}
              >
                {s.done ? (
                  <Check className="w-3 h-3" aria-hidden="true" />
                ) : (
                  <Circle className="w-3 h-3" aria-hidden="true" />
                )}
                {s.done ? t('onb.start.status.done') : t('onb.start.status.pending')}
              </span>
              {s.goTab !== null && (
                <button
                  type="button"
                  onClick={() => databaseStore.setActiveDocTab(s.goTab as ActiveDocumentTab)}
                  style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-strong)' }}
                  className={BTN}
                >
                  <span>{t('onb.start.btn.go')}</span>
                  <ArrowRight className="w-3 h-3" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                onClick={() => onboardingStore.openDialog(s.detailPage, s.detailSection)}
                style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-strong)' }}
                className={BTN}
              >
                {t('onb.start.btn.detail')}
              </button>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)]">
        <span className="mr-1">{t('onb.start.more.heading')}:</span>
        {EXTRA_TABS.map((e) => (
          <button
            key={e.tab}
            type="button"
            onClick={() => databaseStore.setActiveDocTab(e.tab)}
            style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-strong)' }}
            className={BTN}
          >
            <span>{t(e.labelKey)}</span>
            <ArrowRight className="w-3 h-3" aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
};
