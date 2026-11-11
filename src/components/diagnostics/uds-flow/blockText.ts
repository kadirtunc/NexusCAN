import { t, type TranslationKey } from '../../../i18n';
import type { BlockDef, LocalizedText } from './types';

/**
 * Resolve flow-editor display text with the active locale (non-React `t`).
 * Components that call these must already subscribe to the locale (`useI18n`)
 * so they re-render on language change.
 */
export function localizedText(item: LocalizedText): string {
  return item.labelKey ? t(item.labelKey) : (item.label ?? '');
}

export function blockLabel(def: BlockDef): string {
  return localizedText(def) || def.type;
}

export function blockDescription(def: BlockDef): string {
  return def.descriptionKey ? t(def.descriptionKey) : '';
}

export function fieldPlaceholder(field: { placeholder?: string; placeholderKey?: TranslationKey }): string | undefined {
  return field.placeholderKey ? t(field.placeholderKey) : field.placeholder;
}

/** Localized config defaults (resolved at block creation). */
export function resolveDefaultConfig(def: BlockDef): Record<string, unknown> {
  const out: Record<string, unknown> = { ...def.defaultConfig };
  if (def.defaultConfigKeys) {
    for (const [k, key] of Object.entries(def.defaultConfigKeys)) out[k] = t(key);
  }
  return out;
}
