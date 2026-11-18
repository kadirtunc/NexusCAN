import { useCallback, useSyncExternalStore } from 'react';
import {
  getLocale,
  interpolate,
  type Locale,
  setLocale,
  subscribeLocale,
  SUPPORTED_LOCALES,
  toggleLocale,
} from './core';
import { cloudSimWorkbenchEn, cloudSimWorkbenchTr } from './shards/cloudSimWorkbench';
import { diagnosticsEn, diagnosticsTr } from './shards/diagnostics';
import { diagWorkspaceEn, diagWorkspaceNoticeEn, diagWorkspaceNoticeTr, diagWorkspaceTr } from './shards/diagWorkspace';
import { flowCoreEn, flowCoreTr } from './shards/flowCore';
import { flowRegEn, flowRegTr } from './shards/flowRegistry';
import { hardwareNetdbEn, hardwareNetdbTr } from './shards/hardwareNetdb';
import { plotterModalsEn, plotterModalsTr } from './shards/plotterModals';
import { rxtxTraceEn, rxtxTraceTr } from './shards/rxtxTrace';
import { securityEn, securityTr } from './shards/security';
import { shellEn, shellTr } from './shards/shell';
import { simInspectorPaletteEn, simInspectorPaletteTr } from './shards/simInspectorPalette';
import { simWidgetsCanvasEn, simWidgetsCanvasTr } from './shards/simWidgetsCanvas';

export type { Locale };
export { getLocale, setLocale, subscribeLocale, SUPPORTED_LOCALES, toggleLocale };

export const trDictionary = {
  ...shellTr,
  ...rxtxTraceTr,
  ...plotterModalsTr,
  ...hardwareNetdbTr,
  ...cloudSimWorkbenchTr,
  ...simInspectorPaletteTr,
  ...simWidgetsCanvasTr,
  ...diagnosticsTr,
  ...flowCoreTr,
  ...flowRegTr,
  ...diagWorkspaceTr,
  ...diagWorkspaceNoticeTr,
  ...securityTr,
} as const;

export type TranslationKey = keyof typeof trDictionary;

export const enDictionary: Record<TranslationKey, string> = {
  ...shellEn,
  ...rxtxTraceEn,
  ...plotterModalsEn,
  ...hardwareNetdbEn,
  ...cloudSimWorkbenchEn,
  ...simInspectorPaletteEn,
  ...simWidgetsCanvasEn,
  ...diagnosticsEn,
  ...flowCoreEn,
  ...flowRegEn,
  ...diagWorkspaceEn,
  ...diagWorkspaceNoticeEn,
  ...securityEn,
};

export function translateForLocale(
  locale: Locale,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  const dict = locale === 'en' ? enDictionary : trDictionary;
  const raw = dict[key] ?? trDictionary[key] ?? key;
  return params ? interpolate(raw, params) : raw;
}

export function t(
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  return translateForLocale(getLocale(), key, params);
}

export interface UseI18nResult {
  locale: Locale;
  isTr: boolean;
  isEn: boolean;
  setLocale: (next: Locale) => void;
  toggleLocale: () => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export function useI18n(): UseI18nResult {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  const translate = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>): string =>
      translateForLocale(locale, key, params),
    [locale],
  );

  return {
    locale,
    isTr: locale === 'tr',
    isEn: locale === 'en',
    setLocale,
    toggleLocale,
    t: translate,
  };
}
