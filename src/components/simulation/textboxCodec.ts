/**
 * Pure text <-> bytes helpers of the shared `textbox` instrument (Simulation + UDS panels).
 */
import type { TranslationKey } from '../../i18n';
import type { SimulationWidgetConfigDto } from '../../types/simulation';

export const TEXTBOX_MAX_BYTES = 4000;

export type TextboxCodecErrorKey = Extract<
  TranslationKey,
  | 'textbox.err.empty'
  | 'textbox.err.invalidNumber'
  | 'textbox.err.invalidHex'
  | 'textbox.err.oddHex'
  | 'textbox.err.invalidChar'
  | 'textbox.err.tooLong'
  | 'textbox.err.tooShort'
>;

export type CodecResult<T> =
  | { ok: true; value: T }
  | { ok: false; errorKey: TextboxCodecErrorKey; params?: Record<string, number> };

/** Bytes -> text. Non-printable characters become `·`; trailing 0x00 / 0xFF padding is trimmed. */
export function decodeAscii(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x00 || bytes[end - 1] === 0xff)) end -= 1;
  let out = '';
  for (let i = 0; i < end; i += 1) {
    const b = bytes[i] ?? 0;
    out += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '·';
  }
  return out;
}

export function formatHexBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

export function parseHexBytes(text: string): CodecResult<Uint8Array> {
  const clean = text.replace(/0x/gi, '').replace(/[\s,:-]/g, '');
  if (clean.length === 0) return { ok: false, errorKey: 'textbox.err.empty' };
  if (!/^[0-9a-fA-F]+$/.test(clean)) return { ok: false, errorKey: 'textbox.err.invalidHex' };
  if (clean.length % 2 !== 0) return { ok: false, errorKey: 'textbox.err.oddHex' };
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return { ok: true, value: out };
}

export function asciiToBytes(text: string): CodecResult<Uint8Array> {
  if (text.length === 0) return { ok: false, errorKey: 'textbox.err.empty' };
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    // 0xB7 `·` is the display placeholder of non-printable bytes: never send it back by accident.
    if (code > 0xff || code === 0xb7) return { ok: false, errorKey: 'textbox.err.invalidChar' };
    out[i] = code;
  }
  return { ok: true, value: out };
}

export function parseDecimalNumber(text: string): CodecResult<number> {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed.length === 0) return { ok: false, errorKey: 'textbox.err.empty' };
  const n = Number(trimmed);
  return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, errorKey: 'textbox.err.invalidNumber' };
}

/** Integer in hex (`1F`, `0x1F`). */
export function parseHexInteger(text: string): CodecResult<number> {
  const clean = text.trim().replace(/^0x/i, '').replace(/\s/g, '');
  if (clean.length === 0) return { ok: false, errorKey: 'textbox.err.empty' };
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length > 12) {
    return { ok: false, errorKey: 'textbox.err.invalidHex' };
  }
  return { ok: true, value: Number.parseInt(clean, 16) };
}

/**
 * Applies `maxLength` / `fixedLength` / `padByte`:
 * - longer than fixedLength -> rejected;
 * - shorter than fixedLength -> padded with `padByte` (default 0x00); negative padByte = reject.
 */
export function applyLengthRules(
  bytes: Uint8Array,
  config: Pick<SimulationWidgetConfigDto, 'maxLength' | 'fixedLength' | 'padByte'>
): CodecResult<Uint8Array> {
  const maxLen = config.maxLength && config.maxLength > 0 ? config.maxLength : TEXTBOX_MAX_BYTES;
  if (bytes.length > maxLen) {
    return { ok: false, errorKey: 'textbox.err.tooLong', params: { max: maxLen } };
  }
  const fixed = config.fixedLength && config.fixedLength > 0 ? config.fixedLength : 0;
  if (fixed === 0) return { ok: true, value: bytes };
  if (bytes.length > fixed) {
    return { ok: false, errorKey: 'textbox.err.tooLong', params: { max: fixed } };
  }
  if (bytes.length === fixed) return { ok: true, value: bytes };
  const pad = config.padByte ?? 0x00;
  if (pad < 0 || pad > 0xff) {
    return { ok: false, errorKey: 'textbox.err.tooShort', params: { min: fixed } };
  }
  const out = new Uint8Array(fixed);
  out.set(bytes);
  out.fill(pad, bytes.length);
  return { ok: true, value: out };
}

/** Text typed by the user -> final byte payload for ascii / hex formats. */
export function textToBytes(
  text: string,
  format: 'ascii' | 'hex',
  config: Pick<SimulationWidgetConfigDto, 'maxLength' | 'fixedLength' | 'padByte'>
): CodecResult<Uint8Array> {
  const parsed = format === 'ascii' ? asciiToBytes(text) : parseHexBytes(text);
  if (!parsed.ok) return parsed;
  return applyLengthRules(parsed.value, config);
}
