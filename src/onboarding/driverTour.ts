import { driver, type DriveStep } from 'driver.js';
import 'driver.js/dist/driver.css';
import './driverTheme.css';
import { t as tr } from '../i18n';
import { databaseStore } from '../store/databaseStore';
import { onboardingStore } from '../store/onboardingStore';
import { GUIDE_PAGES } from './registry';
import { inlineCodeToHtml } from './richText';
import type { GuidePageId, GuideTourStep } from './types';

function selectorFor(anchor: string): string {
  return `[data-tour="${anchor}"]`;
}

function toDriveStep(step: GuideTourStep): DriveStep {
  return {
    element: selectorFor(step.anchor),
    popover: {
      title: inlineCodeToHtml(tr(step.titleKey)),
      description: inlineCodeToHtml(tr(step.bodyKey)),
      side: step.side,
      align: step.align,
    },
  };
}

let active: { destroy: () => void } | null = null;

/** Starts the page tour. Safe to call repeatedly; missing anchors are skipped. Never touches TX. */
export function startPageTour(id: GuidePageId): void {
  const def = GUIDE_PAGES[id];
  active?.destroy();
  active = null;

  const present = def.tour.filter((s) => document.querySelector(selectorFor(s.anchor)) !== null);
  if (present.length === 0) return;
  onboardingStore.markSeen(id);

  const keepSelectors = def.keepInteractive.map(selectorFor);
  const drv = driver({
    animate: false,
    smoothScroll: false,
    allowClose: true,
    showProgress: true,
    overlayOpacity: 0.6,
    popoverClass: 'nx-tour',
    stagePadding: 4,
    stageRadius: 0,
    nextBtnText: tr('onb.btn.next'),
    prevBtnText: tr('onb.btn.prev'),
    doneBtnText: tr('onb.btn.done'),
    closeBtnLabel: tr('onb.btn.close'),
    progressText: tr('onb.progress'),
    // Safety controls (Panic Stop) stay above the overlay and clickable (driver raises them to z 10001
    // while the popover itself is 1e9; overlay is below both).
    allowedElements: () => keepSelectors.flatMap((s) => Array.from(document.querySelectorAll(s))),
    steps: present.map(toDriveStep),
    onPopoverRender: (popover) => {
      popover.wrapper.setAttribute('aria-live', 'polite');
    },
    onDestroyed: () => {
      active = null;
    },
  });
  active = drv;
  drv.drive();
}

/** Switches to the page's tab if needed, then starts the tour after the DOM committed. */
export function startPageTourOnTab(id: GuidePageId): void {
  const def = GUIDE_PAGES[id];
  if (def.tab !== null && databaseStore.getState().activeDocTab !== def.tab) {
    databaseStore.setActiveDocTab(def.tab);
    globalThis.setTimeout(() => startPageTour(id), 120);
    return;
  }
  startPageTour(id);
}
