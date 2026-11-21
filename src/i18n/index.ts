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
import { flowIfaceEn, flowIfaceTr } from './shards/flowInterface';
import { flowRegEn, flowRegTr } from './shards/flowRegistry';
import { hardwareNetdbEn, hardwareNetdbTr } from './shards/hardwareNetdb';
import { plotterModalsEn, plotterModalsTr } from './shards/plotterModals';
import { reEn, reTr } from './shards/re';
import { onboardingEn, onboardingTr } from './shards/onboarding';
import { onbConnectionsEn, onbConnectionsTr } from './shards/onbConnections';
import { onbTraceEn, onbTraceTr } from './shards/onbTrace';
import { onbPlotterEn, onbPlotterTr } from './shards/onbPlotter';
import { onbSymbolsEn, onbSymbolsTr } from './shards/onbSymbols';
import { onbPanelsEn, onbPanelsTr } from './shards/onbPanels';
import { onbCloudEn, onbCloudTr } from './shards/onbCloud';
import { onbMcpEn, onbMcpTr } from './shards/onbMcp';
import { rxtxTraceEn, rxtxTraceTr } from './shards/rxtxTrace';
import { securityEn, securityTr } from './shards/security';
import { shellEn, shellTr } from './shards/shell';
import { simInspectorPaletteEn, simInspectorPaletteTr } from './shards/simInspectorPalette';
import { simWidgetsCanvasEn, simWidgetsCanvasTr } from './shards/simWidgetsCanvas';
import { updatesEn, updatesTr } from './shards/updates';
import { workbenchEn, workbenchTr } from './shards/workbench';

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
  ...flowIfaceTr,
  ...diagWorkspaceTr,
  ...diagWorkspaceNoticeTr,
  ...securityTr,
  ...workbenchTr,
  ...reTr,
  ...onboardingTr,
  ...onbConnectionsTr,
  ...onbTraceTr,
  ...onbPlotterTr,
  ...onbSymbolsTr,
  ...onbPanelsTr,
  ...onbCloudTr,
  ...onbMcpTr,
  ...updatesTr,
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
  ...flowIfaceEn,
  ...diagWorkspaceEn,
  ...diagWorkspaceNoticeEn,
  ...securityEn,
  ...workbenchEn,
  ...reEn,
  ...onboardingEn,
  ...onbConnectionsEn,
  ...onbTraceEn,
  ...onbPlotterEn,
  ...onbSymbolsEn,
  ...onbPanelsEn,
  ...onbCloudEn,
  ...onbMcpEn,
  ...updatesEn,
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
