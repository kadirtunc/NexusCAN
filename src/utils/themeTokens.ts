/**
 * theme-tokens-v1 — the ONLY way TS/canvas code may obtain a color.
 * Colors are defined exclusively in `src/index.css` under `[data-theme="dark"]` / `[data-theme="light"]`.
 * Canvas/WebGL code calls `readThemeColor('--series-1')` and re-reads on `subscribeThemeChange`.
 */
export type ThemeColorVar =
  | '--bg-app' | '--bg-panel' | '--bg-header' | '--bg-toolbar' | '--bg-strip' | '--bg-input'
  | '--bg-canvas' | '--bg-surface' | '--bg-elevated' | '--bg-hover' | '--bg-scrim'
  | '--bg-row-alt' | '--bg-row-hover' | '--bg-row-selected' | '--bg-changed'
  | '--border-grid' | '--border-strong' | '--border-hairline'
  | '--text-primary' | '--text-secondary' | '--text-muted' | '--text-ink' | '--text-subtle'
  | '--text-on-accent' | '--text-changed'
  | '--status-nominal' | '--status-focus' | '--status-warn' | '--status-critical'
  | '--status-nominal-bg' | '--status-focus-bg' | '--status-warn-bg' | '--status-critical-bg'
  | '--status-nominal-border' | '--status-focus-border' | '--status-warn-border' | '--status-critical-border'
  | '--canvas-grid' | '--canvas-axis' | '--canvas-crosshair'
  | '--series-1' | '--series-2' | '--series-3' | '--series-4'
  | '--series-5' | '--series-6' | '--series-7' | '--series-8';

export const SERIES_VARS: readonly ThemeColorVar[] = [
  '--series-1', '--series-2', '--series-3', '--series-4',
  '--series-5', '--series-6', '--series-7', '--series-8',
];

/** Resolved color string for a token; empty string outside the DOM (tests). */
export function readThemeColor(name: ThemeColorVar): string {
  if (typeof document === 'undefined') return '';
  return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Series color by index (wraps). */
export function seriesColor(index: number): string {
  const n = SERIES_VARS.length;
  return readThemeColor(SERIES_VARS[((index % n) + n) % n]);
}

/** Fires when `data-theme` on <html> changes. Returns unsubscribe. */
export function subscribeThemeChange(cb: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
}
