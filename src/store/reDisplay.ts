/**
 * RE sniffer display options (independent of row filters): bit glyphs, byte value line (hex/dec), heat colouring.
 * Persisted in localStorage `nexus.re.display`; missing / corrupt / partially invalid storage falls back to defaults
 * field by field. Pure module (no React, no DOM) - the geometry helper is shared by the canvas and unit tests.
 */
export type ReByteFormat = 'hex' | 'dec';

export interface ReDisplay {
  /** `0`/`1` glyphs inside the cells */
  showBits: boolean;
  /** byte value line under each byte group */
  showHex: boolean;
  byteFormat: ReByteFormat;
  /** heat colouring (off = one neutral fill) */
  showHeat: boolean;
}

export const RE_DISPLAY_STORAGE_KEY = 'nexus.re.display';

export const DEFAULT_RE_DISPLAY: ReDisplay = { showBits: true, showHex: true, byteFormat: 'hex', showHeat: true };

export type ReDisplayStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function defaultDisplayStorage(): ReDisplayStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function parseReDisplay(raw: string | null): ReDisplay {
  if (raw === null) return DEFAULT_RE_DISPLAY;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return DEFAULT_RE_DISPLAY;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return DEFAULT_RE_DISPLAY;
  const o = v as Record<string, unknown>;
  const bool = (x: unknown, d: boolean): boolean => (typeof x === 'boolean' ? x : d);
  return {
    showBits: bool(o.showBits, DEFAULT_RE_DISPLAY.showBits),
    showHex: bool(o.showHex, DEFAULT_RE_DISPLAY.showHex),
    byteFormat: o.byteFormat === 'dec' ? 'dec' : 'hex',
    showHeat: bool(o.showHeat, DEFAULT_RE_DISPLAY.showHeat),
  };
}

export function loadReDisplay(storage: ReDisplayStorage | null = defaultDisplayStorage()): ReDisplay {
  try {
    return parseReDisplay(storage?.getItem(RE_DISPLAY_STORAGE_KEY) ?? null);
  } catch {
    return DEFAULT_RE_DISPLAY;
  }
}

export function saveReDisplay(d: ReDisplay, storage: ReDisplayStorage | null = defaultDisplayStorage()): void {
  try {
    storage?.setItem(RE_DISPLAY_STORAGE_KEY, JSON.stringify(d));
  } catch {
    /* non-persistent */
  }
}

export interface ReLayout {
  rowH: number;
  headerH: number;
  pitch: number;
  cellW: number;
  cellH: number;
  byteW: number;
  /** bit glyphs (and bit index labels in the header) */
  bits: boolean;
  /** byte value line under each byte group */
  hexLine: boolean;
  /** y offset of the cell top inside a row */
  cellTop: number;
}

export const RE_BYTE_GAP = 6;
export const RE_HEX_LINE_H = 14;
const ROW_PAD = 6;

/** Row/header geometry per display combination. Neither bits nor values = the old compact layout. */
export function reLayout(d: Pick<ReDisplay, 'showBits' | 'showHex'>): ReLayout {
  const bits = d.showBits;
  const hexLine = d.showHex;
  const pitch = bits ? 13 : 10;
  const cellW = bits ? 12 : 9;
  const cellH = bits ? 17 : 14;
  const rowH = cellH + ROW_PAD + (hexLine ? RE_HEX_LINE_H : 0);
  const cellTop = Math.floor((rowH - cellH - (hexLine ? RE_HEX_LINE_H : 0)) / 2);
  return { rowH, headerH: bits ? 36 : 22, pitch, cellW, cellH, byteW: 8 * pitch + RE_BYTE_GAP, bits, hexLine, cellTop };
}

/** Byte value text for the value line. */
export function formatByteValue(v: number, fmt: ReByteFormat): string {
  return fmt === 'dec' ? String(v).padStart(3, '0') : v.toString(16).toUpperCase().padStart(2, '0');
}
