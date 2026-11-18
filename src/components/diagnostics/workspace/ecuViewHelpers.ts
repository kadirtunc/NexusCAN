/** Small pure helpers shared by the ECU registry UI (hex / decimal text <-> number). */

/** Upper-case hex, zero padded to `width` (empty text for `null` / NaN). */
export function fmtHex(n: number | null, width = 2): string {
  if (n === null || !Number.isFinite(n)) return '';
  return n.toString(16).toUpperCase().padStart(width, '0');
}

/** `0x7E0` style label for lists. */
export function fmtId(n: number, ext: boolean): string {
  return `0x${fmtHex(n, ext ? 8 : 3)}`;
}

/** Strict hex text: optional `0x`, 1..`maxDigits` hex digits. Empty -> `null`, anything else invalid -> NaN. */
export function parseHexText(text: string, maxDigits = 8): number | null {
  const clean = text.trim().replace(/^0x/i, '');
  if (clean.length === 0) return null;
  if (clean.length > maxDigits || !/^[0-9a-fA-F]+$/.test(clean)) return Number.NaN;
  return parseInt(clean, 16);
}

/** Strict decimal text. Empty -> `null`, anything else invalid -> NaN. */
export function parseIntText(text: string): number | null {
  const clean = text.trim();
  if (clean.length === 0) return null;
  if (!/^-?\d{1,12}$/.test(clean)) return Number.NaN;
  return parseInt(clean, 10);
}

export function sameNumber(a: number | null, b: number | null): boolean {
  return Object.is(a, b);
}
