/**
 * In-app CAN frame clipboard + text line codec used by the Receive/Transmit view.
 *
 * Text format (one frame per line):
 *   `0x18FF50E5 X FD BRS 8 01 02 03 04 05 06 07 08`
 *   id hex | X (extended) or S (standard) | optional FD / CC | optional BRS | data length | data bytes hex
 */

export interface ClipboardFrame {
  busId: number | null;
  arbId: number;
  isExtended: boolean;
  isFd: boolean;
  isBrs: boolean;
  /** Payload length in bytes (not the DLC code). */
  len: number;
  bytes: number[];
  /** Optional symbolic name, in-app only (not part of the text line). */
  symbolName: string;
}

const FD_LENGTHS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];

export function isValidFdLength(len: number): boolean {
  return FD_LENGTHS.includes(len);
}

/** Smallest valid CAN-FD payload length that is >= len, or null when len > 64. */
export function nextValidFdLength(len: number): number | null {
  for (const l of FD_LENGTHS) {
    if (l >= len) return l;
  }
  return null;
}

export function formatFrameLine(f: ClipboardFrame): string {
  const idHex = (f.arbId >>> 0).toString(16).toUpperCase().padStart(f.isExtended ? 8 : 3, '0');
  const parts: string[] = [`0x${idHex}`, f.isExtended ? 'X' : 'S'];
  if (f.isFd) {
    parts.push('FD');
    if (f.isBrs) parts.push('BRS');
  }
  parts.push(String(f.len));
  for (let i = 0; i < f.len; i++) {
    parts.push((f.bytes[i] ?? 0).toString(16).toUpperCase().padStart(2, '0'));
  }
  return parts.join(' ');
}

/** Parses a frame line; returns null when invalid. Lenient on case and optional flags. */
export function parseFrameLine(text: string): ClipboardFrame | null {
  const line = text.trim();
  if (/\r|\n/.test(line)) return null;
  const tok = line.split(/\s+/);
  if (tok.length < 3) return null;

  const idTok = tok[0].replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{1,8}$/.test(idTok)) return null;
  const arbId = parseInt(idTok, 16);

  let i = 1;
  const kind = tok[i].toUpperCase();
  let isExtended: boolean;
  if (kind === 'X' || kind === 'EXT' || kind === 'E') isExtended = true;
  else if (kind === 'S' || kind === 'STD') isExtended = false;
  else return null;
  i += 1;

  let isFd = false;
  let isBrs = false;
  if (i < tok.length && (tok[i].toUpperCase() === 'FD' || tok[i].toUpperCase() === 'CC')) {
    isFd = tok[i].toUpperCase() === 'FD';
    i += 1;
  }
  if (i < tok.length && tok[i].toUpperCase() === 'BRS') {
    if (!isFd) return null;
    isBrs = true;
    i += 1;
  }

  if (i >= tok.length || !/^\d{1,2}$/.test(tok[i])) return null;
  const len = parseInt(tok[i], 10);
  i += 1;

  const dataToks = tok.slice(i);
  if (dataToks.length !== len) return null;
  const bytes: number[] = [];
  for (const d of dataToks) {
    if (!/^[0-9a-fA-F]{1,2}$/.test(d)) return null;
    bytes.push(parseInt(d, 16));
  }

  if (isExtended ? arbId > 0x1fffffff : arbId > 0x7ff) return null;
  if (isFd ? len > 64 : len > 8) return null;
  if (isFd && !isValidFdLength(len)) return null;

  return { busId: null, arbId, isExtended, isFd, isBrs, len, bytes, symbolName: '' };
}

export function formatFrameLines(frames: readonly ClipboardFrame[]): string {
  return frames.map(formatFrameLine).join('\n');
}

export function parseFrameLines(text: string): ClipboardFrame[] | null {
  const frames: ClipboardFrame[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const frame = parseFrameLine(line);
    if (!frame) return null;
    frames.push(frame);
  }
  return frames.length > 0 ? frames : null;
}

let clipboard = { frames: [] as readonly ClipboardFrame[], systemSynced: false };

export const frameClipboard = {
  get() {
    return clipboard;
  },
  set(frames: readonly ClipboardFrame[]): void {
    clipboard = { frames, systemSynced: false };
  },
  markSystemSynced(frames: readonly ClipboardFrame[]): void {
    if (clipboard.frames === frames) clipboard = { frames, systemSynced: true };
  },
};
