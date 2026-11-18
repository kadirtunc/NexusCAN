/**
 * Pure helpers of the ECU flashing frontend (no Tauri / React / store imports, so they run under
 * the esbuild-driven `npm run test:flash`): chunked base64, `[flash]` / `[firmware]` error
 * parsing, progress normalisation and hex field parsing.
 */
import {
  FLASH_ERROR_KINDS,
  FLASH_PHASES,
  type FirmwareFormat,
  type FirmwareImageSummaryDto,
  type FlashErrorDto,
  type FlashErrorKind,
  type FlashPhase,
  type FlashProgressDto,
} from '../types/flash';

// ─── Base64 ────────────────────────────────────────────────────────────────────

/** Multiple of 3 so every chunk encodes without `=` padding and the pieces concatenate verbatim. */
const B64_CHUNK = 0x6000;

/**
 * Base64 of a (multi-MB) byte array. `String.fromCharCode(...bytes)` over the whole array overflows
 * the call stack, so the input is converted in 24 KiB slices.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + B64_CHUNK, bytes.length));
    parts.push(btoa(String.fromCharCode(...slice)));
  }
  return parts.join('');
}

// ─── Error parsing ─────────────────────────────────────────────────────────────

export const FLASH_ERROR_PREFIX = '[flash] ';
export const FIRMWARE_ERROR_PREFIX = '[firmware] ';

function rawMessage(e: unknown): string | null {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeFlashError(o: Record<string, unknown>): FlashErrorDto | null {
  const kind = FLASH_ERROR_KINDS.find((k): k is FlashErrorKind => k === o['kind']);
  if (kind === undefined) return null;
  const phase = FLASH_PHASES.find((p): p is FlashPhase => p === o['phase']) ?? 'transfer';
  return {
    kind,
    phase,
    segmentIndex: numOrNull(o['segmentIndex']),
    address: numOrNull(o['address']),
    offset: numOrNull(o['offset']),
    blockCounter: numOrNull(o['blockCounter']),
    lastNrc: numOrNull(o['lastNrc']),
    lastNrcName: strOrNull(o['lastNrcName']),
    diagCode: strOrNull(o['diagCode']),
    bytesDone: numOrNull(o['bytesDone']) ?? 0,
    segmentsCompleted: numOrNull(o['segmentsCompleted']) ?? 0,
    message: strOrNull(o['message']) ?? '',
  };
}

/**
 * Parses the rejection of `cmd_flash_download`: a JSON `FlashErrorDto` prefixed with `"[flash] "`.
 * Tolerates Error objects (browser bridge), prefix-less JSON, an already-decoded object and wrapper
 * text before the prefix. Returns `null` for anything else (plain strings, other commands' errors).
 */
export function parseFlashError(e: unknown): FlashErrorDto | null {
  if (isRecord(e) && !(e instanceof Error)) return normalizeFlashError(e);
  const msg = rawMessage(e);
  if (msg === null) return null;
  const at = msg.indexOf(FLASH_ERROR_PREFIX);
  const body = (at >= 0 ? msg.slice(at + FLASH_ERROR_PREFIX.length) : msg).trim();
  if (!body.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? normalizeFlashError(parsed) : null;
  } catch {
    return null;
  }
}

/** Message of a `"[firmware] ..."` rejection of `cmd_flash_load_image` (prefix stripped); `null` otherwise. */
export function parseFirmwareError(e: unknown): string | null {
  const msg = rawMessage(e);
  if (msg === null) return null;
  const at = msg.indexOf(FIRMWARE_ERROR_PREFIX);
  return at >= 0 ? msg.slice(at + FIRMWARE_ERROR_PREFIX.length).trim() : null;
}

// ─── Progress ──────────────────────────────────────────────────────────────────

export interface OverallProgress {
  done: number;
  total: number;
  /** 0..100, one decimal. */
  percent: number;
}

/**
 * The contract does not say whether `bytesDone / bytesTotal` is per segment or per image. When the
 * image summary is known the two readings are told apart by `bytesTotal`: equal to the image total
 * means overall, equal to the current segment length means per-segment (re-based onto the image).
 * Anything else is shown as reported.
 */
export function overallProgress(p: FlashProgressDto, summary: FirmwareImageSummaryDto | null): OverallProgress {
  let done = p.bytesDone;
  let total = p.bytesTotal;
  if (summary !== null && summary.totalBytes > 0 && p.bytesTotal !== summary.totalBytes) {
    const seg = summary.segments[p.segmentIndex];
    if (seg !== undefined && seg.length === p.bytesTotal) {
      const before = summary.segments.slice(0, p.segmentIndex).reduce((a, s) => a + s.length, 0);
      done = before + p.bytesDone;
      total = summary.totalBytes;
    }
  }
  if (p.phase === 'done') done = total;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 1000) / 10) : 0;
  return { done, total, percent };
}

// ─── Fields ────────────────────────────────────────────────────────────────────

/** `"0x08000000"` / `"08000000"` -> number; empty or invalid (or above 2^53) -> `null`. */
export function parseHexNumber(raw: unknown): number | null {
  const s = String(raw ?? '').trim().replace(/^0x/i, '');
  if (s.length === 0 || s.length > 13 || !/^[0-9a-fA-F]+$/.test(s)) return null;
  const n = parseInt(s, 16);
  return Number.isSafeInteger(n) ? n : null;
}

/** Fixed-width upper-case hex without prefix. */
export function hexFixed(n: number, width: number): string {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

export function formatAddress(n: number): string {
  return `0x${hexFixed(n, n > 0xffffffff ? 16 : 8)}`;
}

export function formatCrc32(n: number): string {
  return `0x${hexFixed(n >>> 0, 8)}`;
}

/** Firmware format of a file name by extension; `null` when unknown (backend sniffing decides). */
export function formatFromFileName(fileName: string): FirmwareFormat | null {
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case 'hex':
    case 'ihex':
      return 'intelHex';
    case 'srec':
    case 's19':
    case 's28':
    case 's37':
    case 'mot':
      return 'srec';
    case 'bin':
      return 'binary';
    default:
      return null;
  }
}

/**
 * Format sent to `cmd_flash_load_image`: an explicit choice wins; `auto` resolves `.bin` to `binary`
 * (a raw dump has nothing to sniff and needs the base address) and leaves the rest to the backend.
 */
export function resolveLoadFormat(selected: string, fileName: string): FirmwareFormat | 'auto' {
  if (selected === 'intelHex' || selected === 'srec' || selected === 'binary') return selected;
  return formatFromFileName(fileName) === 'binary' ? 'binary' : 'auto';
}
