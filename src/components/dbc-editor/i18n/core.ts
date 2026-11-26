import { useCallback, useSyncExternalStore } from 'react';
import {
  getLocale,
  interpolate,
  setLocale,
  subscribeLocale,
  toggleLocale,
  type Locale,
} from '../../../i18n/core';

export type CloudLocale = Locale;
export type TranslationParams = Record<string, string | number>;

export interface TranslationShard<K extends string> {
  readonly tr: Readonly<Record<K, string>>;
  readonly en: Readonly<Record<K, string>>;
}

const BCP47: Record<Locale, string> = { tr: 'tr-TR', en: 'en-US' };

export { getLocale, interpolate, setLocale, toggleLocale };

export function defineShard<const T extends Record<string, string>>(
  tr: T,
  en: Record<keyof T & string, string>,
): TranslationShard<keyof T & string> {
  return { tr, en };
}

export function translateShard<K extends string>(
  shard: TranslationShard<K>,
  locale: Locale,
  key: K,
  params?: TranslationParams,
): string {
  const raw = shard[locale]?.[key] ?? shard.tr[key] ?? key;
  return params ? interpolate(raw, params) : raw;
}

export function tShard<K extends string>(
  shard: TranslationShard<K>,
  key: K,
  params?: TranslationParams,
): string {
  return translateShard(shard, getLocale(), key, params);
}

export function formatLocaleDateTime(
  locale: Locale,
  value: string | number | Date,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return typeof value === 'string' && value.length > 0 ? value : '—';
  }
  try {
    return new Intl.DateTimeFormat(BCP47[locale], options).format(date);
  } catch {
    return date.toISOString();
  }
}

export function formatLocaleNumber(
  locale: Locale,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  try {
    return new Intl.NumberFormat(BCP47[locale], options).format(value);
  } catch {
    return String(value);
  }
}

export interface UseLocaleResult {
  locale: Locale;
  isTr: boolean;
  isEn: boolean;
  setLocale: (next: Locale) => void;
  toggleLocale: () => void;
  bcp47: string;
}

export interface UseShardI18nResult<K extends string> extends UseLocaleResult {
  t: (key: K, params?: TranslationParams) => string;
  formatDateTime: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
}

export function useShardI18n<K extends string>(shard: TranslationShard<K>): UseShardI18nResult<K> {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  const t = useCallback(
    (key: K, params?: TranslationParams): string => translateShard(shard, locale, key, params),
    [shard, locale],
  );
  const formatDateTime = useCallback(
    (value: string | number | Date, options?: Intl.DateTimeFormatOptions): string =>
      formatLocaleDateTime(locale, value, options),
    [locale],
  );
  const formatNumber = useCallback(
    (value: number, options?: Intl.NumberFormatOptions): string =>
      formatLocaleNumber(locale, value, options),
    [locale],
  );
  return {
    locale,
    isTr: locale === 'tr',
    isEn: locale === 'en',
    setLocale,
    toggleLocale,
    t,
    formatDateTime,
    formatNumber,
    bcp47: BCP47[locale],
  };
}
