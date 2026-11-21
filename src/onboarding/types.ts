import type { TranslationKey } from '../i18n';
import type { ActiveDocumentTab } from '../store/databaseStore';

/**
 * Single source of truth for guided pages. Adding a page = append its id here, add a
 * `GuidePageDef` to `registry.ts`, add `onb.*` i18n keys and `data-tour` anchors. No component changes.
 */
export const GUIDE_PAGE_IDS = ['rxtx', 'start', 'connections', 'trace', 'plotter', 'symbols', 'panels', 'cloud', 'mcp'] as const;
export type GuidePageId = (typeof GUIDE_PAGE_IDS)[number];

export function isGuidePageId(v: unknown): v is GuidePageId {
  return typeof v === 'string' && (GUIDE_PAGE_IDS as readonly string[]).includes(v);
}

export interface GuideTourStep {
  /** Value of the `data-tour` attribute. Steps whose anchor is not in the DOM are skipped. */
  anchor: string;
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
}

/** One row of a compact reference table (tool names, keyboard shortcuts, ...). `code` is never translated. */
export interface GuideInfoItem {
  code: string;
  descKey: TranslationKey;
  badge?: 'readOnly' | 'confirm';
}

export interface GuideInfoSection {
  /** Stable id used for deep links (e.g. the "Why?" link opens `txSafety`). */
  id: string;
  headingKey: TranslationKey;
  bodyKeys: readonly TranslationKey[];
  /** Optional reference table rendered after the body; sections with items get a filter box. */
  items?: readonly GuideInfoItem[];
}

export interface GuidePageDef {
  id: GuidePageId;
  /** Document tab the page lives on; `null` for overlay panels (tour never switches tabs, no tab mapping). */
  tab: ActiveDocumentTab | null;
  titleKey: TranslationKey;
  tour: readonly GuideTourStep[];
  info: readonly GuideInfoSection[];
  tips: readonly TranslationKey[];
  /** `data-tour` anchors whose elements must stay clickable during the tour (safety controls). */
  keepInteractive: readonly string[];
}

export interface GuideDialogRequest {
  pageId: GuidePageId;
  /** Section id to scroll to / highlight on open. */
  sectionId: string | null;
}
