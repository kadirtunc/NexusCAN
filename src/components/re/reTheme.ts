/**
 * RE canvas theme: reads the app design tokens (src/index.css, `[data-theme]`) through getComputedStyle, with
 * dark-theme fallbacks (the ONLY raw colour literals allowed in src/components/re, guarded by a test). The result is
 * cached and invalidated when `data-theme` (or `class`) on <html> changes; `useReTheme()` re-renders consumers so
 * canvases redraw on a theme switch. Pure colour math (`mix`, `withAlpha`) and palette builders live here too.
 */
import { useSyncExternalStore } from 'react';
import type { ReFieldKind } from '../../types/re';

export interface ReTheme {
  bgCanvas: string;
  bgSurface: string;
  bgElevated: string;
  bgRowAlt: string;
  bgRowSelected: string;
  bgHover: string;
  borderHairline: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textSubtle: string;
  textInk: string;
  nominal: string;
  focus: string;
  warn: string;
  critical: string;
  grid: string;
  axis: string;
  crosshair: string;
}

const VARS: Readonly<Record<keyof ReTheme, readonly [string, string]>> = {
  bgCanvas: ['--bg-canvas', '#121417'],
  bgSurface: ['--bg-surface', '#16191e'],
  bgElevated: ['--bg-elevated', '#1b1f25'],
  bgRowAlt: ['--bg-row-alt', '#1A1D22'],
  bgRowSelected: ['--bg-row-selected', '#1F2D3D'],
  bgHover: ['--bg-hover', '#21262e'],
  borderHairline: ['--border-hairline', '#262b33'],
  borderStrong: ['--border-strong', '#313741'],
  textPrimary: ['--text-primary', '#D8DEE6'],
  textSecondary: ['--text-secondary', '#9099A6'],
  textMuted: ['--text-muted', '#636C78'],
  textSubtle: ['--text-subtle', '#5d6673'],
  textInk: ['--text-ink', '#dce2ea'],
  nominal: ['--status-nominal', '#2ea043'],
  focus: ['--status-focus', '#0e8ac8'],
  warn: ['--status-warn', '#d29922'],
  critical: ['--status-critical', '#e5534b'],
  grid: ['--canvas-grid', 'rgba(139, 148, 160, 0.12)'],
  axis: ['--canvas-axis', '#8b94a0'],
  crosshair: ['--canvas-crosshair', 'rgba(220, 226, 234, 0.45)'],
};

function readTheme(): ReTheme {
  const out = {} as Record<keyof ReTheme, string>;
  const styles = typeof document === 'undefined' ? null : window.getComputedStyle(document.documentElement);
  for (const key of Object.keys(VARS) as (keyof ReTheme)[]) {
    const [name, fallback] = VARS[key];
    const v = styles === null ? '' : styles.getPropertyValue(name).trim();
    out[key] = v === '' ? fallback : v;
  }
  return out;
}

let cache: ReTheme | null = null;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

/** Current theme (cached until the `data-theme` attribute changes). */
export function getReTheme(): ReTheme {
  cache ??= readTheme();
  return cache;
}

/** Drops the cache and notifies subscribers (called by the observer; exported for tests). */
export function invalidateReTheme(): void {
  cache = null;
  for (const l of listeners) l();
}

export function subscribeReTheme(l: () => void): () => void {
  listeners.add(l);
  if (observer === null && typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    observer = new MutationObserver(invalidateReTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && observer !== null) {
      observer.disconnect();
      observer = null;
    }
  };
}

export function useReTheme(): ReTheme {
  return useSyncExternalStore(subscribeReTheme, getReTheme, getReTheme);
}

// ---- colour math -----------------------------------------------------------------------------------------------

export type Rgba = readonly [number, number, number, number];

/** Parses `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r,g,b)` and `rgba(r,g,b,a)` (comma or space separated). */
export function parseColor(input: string): Rgba | null {
  const s = input.trim();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = [...h].map((c) => Number.parseInt(c + c, 16));
      return [r, g, b, a === undefined ? 1 : a / 255];
    }
    if (h.length === 6 || h.length === 8) {
      const n = (i: number): number => Number.parseInt(h.slice(i, i + 2), 16);
      return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
    }
    return null;
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m === null) return null;
  const parts = m[1].split(/[\s,/]+/).filter((x) => x !== '');
  if (parts.length < 3) return null;
  const nums = parts.map((p) => (p.endsWith('%') ? (Number.parseFloat(p) / 100) : Number.parseFloat(p)));
  if (nums.some((n) => Number.isNaN(n))) return null;
  const a = parts.length >= 4 ? nums[3] : 1;
  return [nums[0], nums[1], nums[2], a];
}

function fmt(c: Rgba): string {
  const r = Math.round(Math.max(0, Math.min(255, c[0])));
  const g = Math.round(Math.max(0, Math.min(255, c[1])));
  const b = Math.round(Math.max(0, Math.min(255, c[2])));
  return `rgba(${r},${g},${b},${Number(Math.max(0, Math.min(1, c[3])).toFixed(3))})`;
}

/** Linear mix a -> b (t = 0 gives a, t = 1 gives b). Unparseable inputs return `b`. */
export function mix(a: string, b: string, t: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (ca === null || cb === null) return b;
  const k = Math.max(0, Math.min(1, t));
  return fmt([ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k, ca[3] + (cb[3] - ca[3]) * k]);
}

/** Same colour with its alpha multiplied by `alpha`. */
export function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color);
  return c === null ? color : fmt([c[0], c[1], c[2], c[3] * alpha]);
}

// ---- palettes ------------------------------------------------------------------------------------------------------

const lutCache = new WeakMap<ReTheme, readonly string[]>();

/** 256-entry heat ramp in the app's "changed" green family: --bg-surface (low) -> --status-nominal (max). Index 0 = static. */
export function heatLut(theme: ReTheme): readonly string[] {
  let lut = lutCache.get(theme);
  if (lut === undefined) {
    lut = Array.from({ length: 256 }, (_, i) => (i === 0 ? theme.bgElevated : mix(theme.bgSurface, theme.nominal, 0.14 + 0.86 * (i / 255))));
    lutCache.set(theme, lut);
  }
  return lut;
}

/** Relative luminance 0..1 of a colour (sRGB, alpha ignored); unparseable -> 0. */
export function luminance(color: string): number {
  const c = parseColor(color);
  if (c === null) return 0;
  const lin = (v: number): number => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** Picks the better-contrast of `light` / `dark` against `bg` (WCAG contrast ratio). */
export function pickContrast(bg: string, light: string, dark: string): string {
  const lb = luminance(bg) + 0.05;
  const cl = Math.max(lb, luminance(light) + 0.05) / Math.min(lb, luminance(light) + 0.05);
  const cd = Math.max(lb, luminance(dark) + 0.05) / Math.min(lb, luminance(dark) + 0.05);
  return cl >= cd ? light : dark;
}

const glyphCache = new WeakMap<ReTheme, readonly string[]>();

/** Parallel to `heatLut`: glyph colour (readable on that heat fill). `textInk` (light) vs `bgCanvas` (dark). */
export function heatGlyphLut(theme: ReTheme): readonly string[] {
  let lut = glyphCache.get(theme);
  if (lut === undefined) {
    const heat = heatLut(theme);
    lut = heat.map((c) => pickContrast(c, theme.textInk, theme.bgCanvas));
    glyphCache.set(theme, lut);
  }
  return lut;
}

export function kindColors(theme: ReTheme): Record<ReFieldKind, string> {
  return {
    constant: theme.textSubtle,
    counter: theme.focus,
    checksum: theme.warn,
    flag: theme.critical,
    physical: theme.nominal,
    unknown: theme.textMuted,
  };
}

/** Candidate slot colours 1..4: nominal, warn, critical, ink. */
export function candidateColors(theme: ReTheme): readonly string[] {
  return [theme.nominal, theme.warn, theme.critical, theme.textInk];
}

export const RE_MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
