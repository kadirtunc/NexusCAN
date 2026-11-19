/**
 * Pure IPC-boundary argument sanitisers for `cmd_re_*` (defence in depth). Rust DTO fields typed u8/u16/u32/u64 reject
 * JSON floats (`invalid type: floating point ..., expected u64`), so every integer field is rounded here and
 * NaN / infinite / negative / out-of-range values are rejected client-side with a `[re:invalid]` error (same token the
 * backend uses, so `parseReError` maps it identically). f64 fields (factor, offset, marker value) are NEVER touched.
 */
import type {
  ReCandidateDto,
  ReCorrelateRequest,
  ReReferenceDto,
  ReRowKey,
  ReSearchDto,
  ReSeriesRequest,
  ReTargetDto,
} from '../types/re';

export const RE_U8_MAX = 0xff;
export const RE_U16_MAX = 0xffff;
export const RE_U32_MAX = 0xffff_ffff;
/** u64 cannot be represented exactly in a JS number beyond 2^53 - 1. */
export const RE_U64_MAX = Number.MAX_SAFE_INTEGER;

export class ReArgError extends Error {
  constructor(field: string, value: unknown, why: string) {
    super(`[re:invalid] ${field} ${why} (got ${String(value)})`);
    this.name = 'ReArgError';
  }
}

/** Rounds a finite unsigned integer argument; throws `[re:invalid]` for NaN/Inf/negative/over `max`. */
export function reUint(field: string, v: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ReArgError(field, v, 'must be a finite number');
  const r = Math.round(v);
  if (r < 0) throw new ReArgError(field, v, 'must not be negative');
  if (r > max) throw new ReArgError(field, v, `must be <= ${max}`);
  return r === 0 ? 0 : r; // normalise -0
}

/** `null`/`undefined` pass through as `null` (Rust `Option<u64>` = None). */
export function reOptUint(field: string, v: number | null | undefined, max: number): number | null {
  return v === null || v === undefined ? null : reUint(field, v, max);
}

export function reTarget(t: ReTargetDto, field = 'target'): ReTargetDto {
  return { ...t, bus: reUint(`${field}.bus`, t.bus, RE_U8_MAX), arbId: reUint(`${field}.arbId`, t.arbId, RE_U32_MAX) };
}

export function reCandidate(c: ReCandidateDto, field = 'candidate'): ReCandidateDto {
  return {
    ...c,
    startBit: reUint(`${field}.startBit`, c.startBit, RE_U16_MAX),
    bitLength: reUint(`${field}.bitLength`, c.bitLength, RE_U16_MAX),
    // factor / offset are f64 in Rust: untouched
  };
}

export function reReference(r: ReReferenceDto | null): ReReferenceDto | null {
  if (r === null) return null;
  switch (r.kind) {
    case 'obd_pid':
      return { ...r, pid: reUint('reference.pid', r.pid, RE_U8_MAX), bus: reUint('reference.bus', r.bus, RE_U8_MAX) };
    case 'markers':
      return { ...r, points: r.points.map((p, i) => ({ ...p, markerId: reUint(`reference.points[${i}].markerId`, p.markerId, RE_U32_MAX) })) };
    case 'candidate':
      return { ...r, target: reTarget(r.target, 'reference.target'), candidate: reCandidate(r.candidate, 'reference.candidate') };
  }
}

export function reSearch(s: ReSearchDto): ReSearchDto {
  return {
    ...s,
    bitFrom: reUint('search.bitFrom', s.bitFrom, RE_U16_MAX),
    bitTo: reUint('search.bitTo', s.bitTo, RE_U16_MAX),
    lengths: [reUint('search.lengths[0]', s.lengths[0], RE_U16_MAX), reUint('search.lengths[1]', s.lengths[1], RE_U16_MAX)],
  };
}

export function reRowKey(k: ReRowKey): ReRowKey {
  return { ...k, bus: reUint('bus', k.bus, RE_U8_MAX), arbId: reUint('arbId', k.arbId, RE_U32_MAX) };
}

export function reBuses(buses: number[] | null): number[] | null {
  return buses === null ? null : buses.map((b, i) => reUint(`buses[${i}]`, b, RE_U8_MAX));
}

export function reSeriesRequest(req: ReSeriesRequest): ReSeriesRequest {
  return {
    target: reTarget(req.target),
    candidates: req.candidates.map((c, i) => reCandidate(c, `candidates[${i}]`)),
    reference: reReference(req.reference),
    fromUs: reOptUint('fromUs', req.fromUs, RE_U64_MAX),
    toUs: reOptUint('toUs', req.toUs, RE_U64_MAX),
    maxPoints: reUint('maxPoints', req.maxPoints, RE_U16_MAX),
  };
}

export function reCorrelateRequest(req: ReCorrelateRequest): ReCorrelateRequest {
  const ref = reReference(req.reference);
  if (ref === null) throw new ReArgError('reference', null, 'is required');
  return {
    target: reTarget(req.target),
    reference: ref,
    fromUs: reOptUint('fromUs', req.fromUs, RE_U64_MAX),
    toUs: reOptUint('toUs', req.toUs, RE_U64_MAX),
    search: reSearch(req.search),
    topN: reUint('topN', req.topN, RE_U8_MAX),
  };
}
