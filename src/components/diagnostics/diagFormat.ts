/** Pure formatting helpers shared by the Diagnostics tabs (no React). */

export function toHex(n: number, width = 2): string {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

export function bytesToHex(bytes: readonly number[]): string {
  return bytes.map((b) => toHex(b)).join(' ');
}

/** UDS diagnostic session id -> label (0x01 / 0x02 / 0x03 named, others hex). */
export function sessionLabel(code: number): string {
  if (code === 0x01) return 'DEFAULT';
  if (code === 0x02) return 'PROGRAMMING';
  if (code === 0x03) return 'EXTENDED';
  return `0x${toHex(code)}`;
}

/** Wall-clock µs since epoch are > 1e15 (anything after 2001); smaller values are a monotonic HAL clock. */
const EPOCH_US_THRESHOLD = 1e15;

export function isEpochUs(timestampUs: number): boolean {
  return timestampUs > EPOCH_US_THRESHOLD;
}

/** Epoch µs -> HH:MM:SS.mmm; monotonic µs -> `+S.mmm s` relative to `baseUs`. */
export function formatEventTime(timestampUs: number, baseUs: number): string {
  if (isEpochUs(timestampUs)) {
    const d = new Date(Math.floor(timestampUs / 1000));
    const p2 = (n: number) => n.toString().padStart(2, '0');
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${d.getMilliseconds().toString().padStart(3, '0')}`;
  }
  const rel = Math.max(0, timestampUs - baseUs) / 1000;
  return `+${(rel / 1000).toFixed(3)} s`;
}

export function formatElapsedMs(elapsedUs: number): string {
  const ms = elapsedUs / 1000;
  return `${ms < 10 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : ms.toFixed(0)} ms`;
}

export type HexParse = { ok: true; bytes: number[] } | { ok: false; token: string };

/** "F1 90", "F190", "0xF1,0x90" -> bytes. Rejects invalid / odd-length (>2 digit) tokens instead of silently dropping them. */
export function parseHexBytes(text: string): HexParse {
  const bytes: number[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    if (raw.length === 0) continue;
    const token = raw.replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]+$/.test(token)) return { ok: false, token: raw };
    if (token.length <= 2) {
      bytes.push(parseInt(token, 16));
    } else if (token.length % 2 === 0) {
      for (let i = 0; i < token.length; i += 2) bytes.push(parseInt(token.slice(i, i + 2), 16));
    } else {
      return { ok: false, token: raw };
    }
  }
  return { ok: true, bytes };
}
