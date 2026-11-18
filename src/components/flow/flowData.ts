/**
 * Pure byte builders of the UDS flow data blocks (`data_ascii`, `data_fingerprint`) and the ASCII
 * helpers of `data_compare` (`ascii_equals`, `bytes_not_equal`). No I/O, no clock reads (the
 * caller passes the Date), so they are unit-testable headless.
 */
import { t } from '../../i18n';

/** Text → ASCII bytes (0x20..0x7E plus control chars). Throws on characters above 0x7F. */
export function textToAscii(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c > 0x7f) throw new Error(t('udsFlow.err.notAscii', { ch }));
    out.push(c);
  }
  return out;
}

/** Pads (right) or truncates `bytes` to `len` (len <= 0 → unchanged). */
export function fitBytes(bytes: readonly number[], len: number, pad: number): number[] {
  if (!(len > 0)) return [...bytes];
  const out = bytes.slice(0, len);
  while (out.length < len) out.push(pad & 0xff);
  return out;
}

/** Packed BCD of 0..99 (e.g. 26 → 0x26). */
export function bcd(n: number): number {
  const v = Math.abs(Math.trunc(n)) % 100;
  return ((Math.floor(v / 10) & 0x0f) << 4) | (v % 10);
}

export interface FingerprintConfig {
  format: 'iso_f15a' | 'custom';
  serial: string;
  serialLen: number;
  pad: number;
  template: string;
}

/**
 * Repair-shop fingerprint record (programming date + tester serial), e.g. for DID 0xF15A.
 * - `iso_f15a`: `YY MM DD` (BCD) + tester serial ASCII padded / truncated to `serialLen` bytes.
 * - `custom`: template of hex bytes and tokens `{YY}{MM}{DD}{hh}{mm}` (BCD) and `{SERIAL:n}`.
 */
export function buildFingerprint(cfg: FingerprintConfig, now: Date): number[] {
  const serial = (n: number): number[] => fitBytes(textToAscii(cfg.serial), n, cfg.pad);
  const tokens: Record<string, number> = {
    YY: bcd(now.getFullYear() % 100),
    MM: bcd(now.getMonth() + 1),
    DD: bcd(now.getDate()),
    hh: bcd(now.getHours()),
    mm: bcd(now.getMinutes()),
  };
  if (cfg.format !== 'custom') {
    return [tokens.YY, tokens.MM, tokens.DD, ...serial(Math.max(0, Math.trunc(cfg.serialLen)))];
  }
  const out: number[] = [];
  const re = /\{(YY|MM|DD|hh|mm|SERIAL:(\d+))\}/g;
  let last = 0;
  const literal = (text: string): void => {
    const hex = text.replace(/[\s,]/g, '');
    if (hex.length === 0) return;
    if (!/^([0-9a-fA-F]{2})+$/.test(hex)) throw new Error(t('udsFlow.err.badTemplate', { part: text.trim() }));
    for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  };
  for (let m = re.exec(cfg.template); m !== null; m = re.exec(cfg.template)) {
    literal(cfg.template.slice(last, m.index));
    if (m[2] !== undefined) out.push(...serial(Number(m[2])));
    else out.push(tokens[m[1]]);
    last = m.index + m[0].length;
  }
  literal(cfg.template.slice(last));
  return out;
}

/** Bytes / string → comparable ASCII text (trailing 00 / 20 / FF padding and whitespace removed). */
export function asciiText(v: unknown): string {
  let s: string;
  if (v instanceof Uint8Array || (Array.isArray(v) && v.every((x) => typeof x === 'number'))) {
    const b = Array.from(v as ArrayLike<number>);
    let end = b.length;
    while (end > 0 && (b[end - 1] === 0x00 || b[end - 1] === 0x20 || b[end - 1] === 0xff)) end--;
    s = String.fromCharCode(...b.slice(0, end));
  } else {
    s = typeof v === 'string' ? v : String(v ?? '');
  }
  return s.trim();
}

/** Bytes / string (as ASCII) → byte list for a raw byte comparison. */
export function rawBytes(v: unknown): number[] {
  if (v instanceof Uint8Array) return Array.from(v);
  if (Array.isArray(v) && v.every((x) => typeof x === 'number')) return [...(v as number[])];
  return Array.from(typeof v === 'string' ? v : String(v ?? ''), (c) => c.charCodeAt(0) & 0xff);
}

/** True for `undefined`, an empty / blank string or an empty byte array. */
export function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  if (v instanceof Uint8Array || Array.isArray(v)) return v.length === 0;
  return false;
}
