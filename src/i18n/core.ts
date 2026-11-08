export type Locale = 'tr' | 'en';

export const SUPPORTED_LOCALES: readonly Locale[] = ['tr', 'en'] as const;

const LOCALE_STORAGE_KEY = 'nexuscan:locale:v1';

function detectInitialLocale(): Locale {
  if (typeof window === 'undefined') {
    return 'tr';
  }
  try {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved === 'tr' || saved === 'en') {
      return saved;
    }
  } catch {
    // Ignore storage read errors in restricted webviews
  }
  return 'tr';
}

let currentLocale: Locale = detectInitialLocale();

if (typeof document !== 'undefined') {
  document.documentElement.lang = currentLocale;
}

const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(next: Locale): void {
  if (next === currentLocale) {
    return;
  }
  currentLocale = next;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next;
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Ignore storage write errors
    }
  }
  for (const listener of listeners) {
    listener();
  }
}

export function toggleLocale(): void {
  setLocale(currentLocale === 'tr' ? 'en' : 'tr');
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const val = params[key];
    return val !== undefined ? String(val) : match;
  });
}
