/** Pure helpers for R2b (RE signal drafts -> DBC). No React, no stores, no I/O. Naming matches the Rust generator. */
import type { ReCandidateDto, ReCorrelationRowDto, ReSeries, ReTargetDto } from '../../types/re';
import type { ReSignalDraftDto } from '../../types/reDraft';
import type { CustomDbFileRecord } from '../../store/databaseStore';

export const RE_FOUND_DB_FILE_NAME = 'RE_found.dbc';

/** Auto message name: std `RE_` + 3-digit upper hex, extended `RE_` + 8-digit upper hex. */
export function reMessageName(arbId: number, isExtended: boolean): string {
  return `RE_${arbId.toString(16).toUpperCase().padStart(isExtended ? 8 : 3, '0')}`;
}

export function defaultDraftName(messageName: string | null, arbId: number, isExtended: boolean, startBit: number): string {
  return `${messageName ?? reMessageName(arbId, isExtended)}_sig${startBit}`;
}

export interface ReDraftPrefillInput {
  id: string;
  nowMs: number;
  target: ReTargetDto;
  dlcBytes: number;
  /** message name in the loaded bus DB, if any */
  messageName: string | null;
  row: ReCorrelationRowDto;
  /** observed physical range */
  observed: { min: number; max: number } | null;
  /** e.g. `{ label: 'OBD 0x0D', unit: 'km/h' }` */
  reference: { label: string; unit: string } | null;
}

export function draftFromCorrelationRow(input: ReDraftPrefillInput): ReSignalDraftDto {
  const { row, target, observed, reference } = input;
  const c = row.candidate;
  const finite = observed !== null && Number.isFinite(observed.min) && Number.isFinite(observed.max);
  return {
    id: input.id,
    bus: target.bus,
    arbId: target.arbId,
    isExtended: target.isExtended,
    messageName: null,
    dlcBytes: input.dlcBytes,
    name: defaultDraftName(input.messageName, target.arbId, target.isExtended, c.startBit),
    startBit: c.startBit,
    bitLength: c.bitLength,
    byteOrder: c.byteOrder,
    valueType: c.valueType,
    factor: c.factor,
    offset: c.offset,
    min: finite ? Math.floor(observed.min) + 0 : 0,
    max: finite ? Math.ceil(observed.max) + 0 : 0,
    unit: reference?.unit ?? '',
    comment: '',
    provenance: { r: row.r, lagMs: row.lagMs, reference: reference !== null && reference.label !== '' ? reference.label : null, samples: row.samples, createdAtMs: input.nowMs },
    valueTable: [],
  };
}

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function base64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function reFoundDbRecord(dbcText: string): CustomDbFileRecord {
  return {
    fileName: RE_FOUND_DB_FILE_NAME,
    contentBase64: utf8ToBase64(dbcText),
    sizeBytes: new TextEncoder().encode(dbcText).length,
  };
}

const isReFoundName = (fileName: string): boolean => fileName.trim().toLowerCase() === RE_FOUND_DB_FILE_NAME.toLowerCase();

/** Replace-or-append `entry` as the single RE_found.dbc (case/space-insensitive match, stale duplicates collapsed). */
export function applyReFoundDb<T extends { fileName: string }>(catalog: readonly T[], entry: T): T[] {
  const out: T[] = [];
  let placed = false;
  for (const e of catalog) {
    if (isReFoundName(e.fileName)) {
      if (!placed) {
        out.push(entry);
        placed = true;
      }
      continue;
    }
    out.push(e);
  }
  if (!placed) out.push(entry);
  return out;
}

/** `<stem>_re.dbc` for a merge output (never the original name). */
export function mergedFileName(original: string): string {
  const stem = original.replace(/\.[^/.]+$/, '');
  return `${stem === '' ? 'merged' : stem}_re.dbc`;
}

/** Observed physical range (min of mins, max of maxes) of one series entry, or null when empty / absent. */
export function seriesRange(series: ReSeries | null, kind: 'candidate' | 'reference', index: number): { min: number; max: number } | null {
  const e = series?.series.find((x) => x.kind === kind && x.index === index);
  if (e === undefined) return null;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  const n = e.points.tUsRel.length;
  for (let i = 0; i < n; i += 1) {
    const a = e.points.min[i];
    const b = e.points.max[i];
    if (Number.isFinite(a) && a < lo) lo = a;
    if (Number.isFinite(b) && b > hi) hi = b;
  }
  return lo <= hi ? { min: lo, max: hi } : null;
}

/**
 * Draft for a manually chosen candidate (no correlation row): same prefill, provenance without r / lag / samples
 * unless a matching correlation row is supplied. The candidate's own factor / offset / bits always win.
 */
export function draftFromCandidate(
  input: Omit<ReDraftPrefillInput, 'row'> & { candidate: ReCandidateDto; matchingRow: ReCorrelationRowDto | null },
): ReSignalDraftDto {
  const { candidate, matchingRow, ...rest } = input;
  const row: ReCorrelationRowDto = {
    candidate: { ...candidate },
    r: matchingRow?.r ?? 0,
    r2: matchingRow?.r2 ?? 0,
    rmse: matchingRow?.rmse ?? 0,
    samples: matchingRow?.samples ?? 0,
    lagMs: matchingRow?.lagMs ?? 0,
  };
  const d = draftFromCorrelationRow({ ...rest, row });
  if (matchingRow === null) d.provenance = { ...d.provenance, r: null, lagMs: null, samples: null };
  return d;
}

/** Diagnostics that belong to this draft (or to the whole generation), errors first. */
export function sortDiagnostics<T extends { severity: 'error' | 'warning' }>(diags: readonly T[]): T[] {
  return [...diags].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}
