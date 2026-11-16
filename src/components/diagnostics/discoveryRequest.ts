/**
 * Shared, pure helpers for building a functional ECU discovery request. Used by the Session Setup
 * `EcuDiscoveryPanel` and the ECU Graph toolbar so both validate identically (no i18n here: callers
 * map the returned `error` codes to localized text).
 */
import { UDS_SERVICES } from '../../types/diagnostics';
import type {
  EcuDiscoveryRequestDto,
  IdFilterDto,
  PhysicalSweepRequestDto,
  RequestIdRuleDto,
} from '../../types/udsClient';
import { parseHexBytes } from './diagFormat';
import {
  addressByteCount,
  checkAddressing,
  checkIdForms,
  DEFAULT_ADDRESSING,
  type AddressingError,
  type AddressingInput,
  type IdFormError,
} from './addressing';

export const DEFAULT_DISCOVERY_PDU = '3E 00';
export const DEFAULT_FUNC_11 = 0x7df;
export const DEFAULT_FUNC_29 = 0x18db33f1;
export const DEFAULT_WINDOW_MS = 300;

export function idHex(id: number, extended: boolean): string {
  return '0x' + id.toString(16).toUpperCase().padStart(extended ? 8 : 3, '0');
}

export function defaultFunctionalId(extended: boolean): number {
  return extended ? DEFAULT_FUNC_29 : DEFAULT_FUNC_11;
}

export function parseId(text: string): number | null {
  const clean = text.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{1,8}$/.test(clean)) return null;
  return parseInt(clean, 16);
}

export type PduCheck =
  | { ok: true; bytes: number[] }
  | { ok: false; error: 'hex' | 'length' | 'suppressed'; token?: string };

/** Functional requests are single-frame (classic 1..7, FD 1..62; one less with an address byte) and must not suppress the response. */
export function checkPdu(text: string, useFd: boolean, addrBytes: 0 | 1 = 0): PduCheck {
  const parsed = parseHexBytes(text);
  if (!parsed.ok) return { ok: false, error: 'hex', token: parsed.token };
  const max = (useFd ? 62 : 7) - addrBytes;
  if (parsed.bytes.length < 1 || parsed.bytes.length > max) return { ok: false, error: 'length' };
  const svc = UDS_SERVICES.find((s) => s.sid === parsed.bytes[0]);
  if (svc?.hasSubFunction && parsed.bytes.length >= 2 && (parsed.bytes[1] & 0x80) !== 0) {
    return { ok: false, error: 'suppressed' };
  }
  return { ok: true, bytes: parsed.bytes };
}

// ─── OEM range: response filters + request-id rule ─────────────────────────

export const MAX_RESPONSE_FILTERS = 32;
export const MAX_SWEEP_IDS = 256;

/** One editable filter row (hex text). */
export interface FilterRowInput {
  id: string;
  mask: string;
}

export type RuleKind = 'default' | 'legislatedMinus8' | 'offset' | 'normalFixedSwap' | 'none';

export interface RuleInput {
  kind: RuleKind;
  /** Decimal (or `0x` hex, optionally signed) text; only used for `offset`. */
  delta: string;
}

export const DEFAULT_RULE_INPUT: RuleInput = { kind: 'default', delta: '-8' };

/** 'obd' = backend defaults (legislated 0x7E8..0x7EF), 'custom' = the OEM range editor is in effect. */
export type RangePreset = 'obd' | 'custom';

export interface OemRangeInput {
  preset: RangePreset;
  filters: FilterRowInput[];
  rule: RuleInput;
  addressing: AddressingInput;
}

export const DEFAULT_OEM_RANGE: OemRangeInput = {
  preset: 'obd',
  filters: [],
  rule: DEFAULT_RULE_INPUT,
  addressing: DEFAULT_ADDRESSING,
};

export type FilterError =
  | { reason: 'count' }
  | { reason: 'hex' | 'range' | 'mask' | 'outsideMask'; row: number };

export function fullIdMask(extended: boolean): number {
  return extended ? 0x1fffffff : 0x7ff;
}

/** `(arbId & mask) === id`, all values within 29 bit (so plain int32 ops are safe). */
export function idFilterMatches(f: IdFilterDto, arbId: number): boolean {
  return (arbId & f.mask) === f.id;
}

/** 1..32 rows, each `id`/`mask` hex within the id width, mask != 0 and `id & ~mask == 0`. */
export function checkFilters(
  rows: readonly FilterRowInput[],
  extended: boolean,
): { ok: true; filters: IdFilterDto[] } | ({ ok: false } & FilterError) {
  if (rows.length < 1 || rows.length > MAX_RESPONSE_FILTERS) return { ok: false, reason: 'count' };
  const full = fullIdMask(extended);
  const filters: IdFilterDto[] = [];
  for (let i = 0; i < rows.length; i++) {
    const id = parseId(rows[i].id);
    const mask = parseId(rows[i].mask);
    if (id === null || mask === null) return { ok: false, reason: 'hex', row: i };
    if (mask === 0) return { ok: false, reason: 'mask', row: i };
    if (mask > full || id > full) return { ok: false, reason: 'range', row: i };
    if ((id & ~mask) !== 0) return { ok: false, reason: 'outsideMask', row: i };
    filters.push({ id, mask });
  }
  return { ok: true, filters };
}

/** Parses a signed decimal / `0x` hex i32 (no whitespace tolerance beyond trim). */
export function parseDelta(text: string): number | null {
  const t = text.trim();
  const m = /^([+-]?)(0x[0-9a-fA-F]+|\d+)$/.exec(t);
  if (!m) return null;
  const v = parseInt(m[2], m[2].toLowerCase().startsWith('0x') ? 16 : 10);
  const n = m[1] === '-' ? -v : v;
  return Number.isSafeInteger(n) && n >= -0x80000000 && n <= 0x7fffffff ? n : null;
}

/** `null` = let the backend pick its width-dependent default; `'delta'` = invalid offset. */
export function buildRule(input: RuleInput): RequestIdRuleDto | null | 'delta' {
  switch (input.kind) {
    case 'default':
      return null;
    case 'legislatedMinus8':
      return { kind: 'legislatedMinus8' };
    case 'normalFixedSwap':
      return { kind: 'normalFixedSwap' };
    case 'none':
      return { kind: 'none' };
    case 'offset': {
      const delta = parseDelta(input.delta);
      return delta === null || delta === 0 ? 'delta' : { kind: 'offset', delta };
    }
  }
}

/** Backend default response filter when none is given (29-bit mixed answers on 0x18CE). */
export function defaultResponseFilter(extended: boolean, mixed: boolean): IdFilterDto {
  if (!extended) return { id: 0x7e8, mask: 0x7f8 };
  return mixed ? { id: 0x18cef100, mask: 0x1fffff00 } : { id: 0x18daf100, mask: 0x1fffff00 };
}

export type OemBuild =
  | {
      ok: true;
      responseIdFilters: IdFilterDto[] | null;
      requestIdRule: RequestIdRuleDto | null;
      addressing: { addressFormat: PhysicalSweepRequestDto['addressFormat']; targetAddress: number | null; responseAddress: number | null };
    }
  | { ok: false; field: 'filters'; filter: FilterError }
  | { ok: false; field: 'rule' }
  | { ok: false; field: 'addressing'; addr: AddressingError };

/** Shared by discovery and sweep: filters (custom preset only), rule and addressing. */
export function buildOemRange(oem: OemRangeInput, extended: boolean): OemBuild {
  const addr = checkAddressing(oem.addressing);
  if (!addr.ok) return { ok: false, field: 'addressing', addr: { field: addr.field, reason: addr.reason } };
  let responseIdFilters: IdFilterDto[] | null = null;
  let requestIdRule: RequestIdRuleDto | null = null;
  if (oem.preset === 'custom') {
    const f = checkFilters(oem.filters, extended);
    if (!f.ok) {
      return { ok: false, field: 'filters', filter: f.reason === 'count' ? { reason: 'count' } : { reason: f.reason, row: f.row } };
    }
    responseIdFilters = f.filters;
    const rule = buildRule(oem.rule);
    if (rule === 'delta') return { ok: false, field: 'rule' };
    requestIdRule = rule;
  }
  return { ok: true, responseIdFilters, requestIdRule, addressing: addr.fields };
}

export interface DiscoveryFormInput {
  busId: number;
  isExtended: boolean;
  useFd: boolean;
  padding: number | null;
  identify: boolean;
  funcInput: string;
  pduInput: string;
  windowInput: string;
  respIdInput?: string;
  respMaskInput?: string;
  /** OEM range editor (filters / rule / addressing). Absent = legacy behaviour (backend defaults). */
  oem?: OemRangeInput;
}

export type DiscoveryFormField =
  | 'functionalId'
  | 'window'
  | 'respId'
  | 'respMask'
  | 'pdu'
  | 'filters'
  | 'rule'
  | 'addressing'
  | 'idForm'
  | 'exclusive'
  | 'functionalInFilter';

export type DiscoveryBuild =
  | { ok: true; request: EcuDiscoveryRequestDto }
  | {
      ok: false;
      field: DiscoveryFormField;
      pduError?: Exclude<PduCheck, { ok: true }>;
      filter?: FilterError;
      addr?: AddressingError;
      idForm?: IdFormError;
    };

export function buildDiscoveryRequest(input: DiscoveryFormInput): DiscoveryBuild {
  const oem = input.oem ?? DEFAULT_OEM_RANGE;
  const oemBuilt = buildOemRange(oem, input.isExtended);
  if (!oemBuilt.ok) {
    if (oemBuilt.field === 'filters') return { ok: false, field: 'filters', filter: oemBuilt.filter };
    if (oemBuilt.field === 'rule') return { ok: false, field: 'rule' };
    return { ok: false, field: 'addressing', addr: oemBuilt.addr };
  }
  const addrBytes = addressByteCount(oemBuilt.addressing.addressFormat ?? 'normal');
  const functionalId = parseId(input.funcInput);
  if (functionalId === null) return { ok: false, field: 'functionalId' };
  const idForm = checkIdForms(oemBuilt.addressing.addressFormat ?? 'normal', input.isExtended, [], functionalId);
  if (idForm) return { ok: false, field: 'idForm', idForm };
  const pdu = checkPdu(input.pduInput, input.useFd, addrBytes);
  if (!pdu.ok) return { ok: false, field: 'pdu', pduError: pdu };
  const win = parseInt(input.windowInput, 10);
  if (!Number.isFinite(win) || win < 50 || win > 5000) return { ok: false, field: 'window' };
  let responseId: number | null = null;
  let responseMask: number | null = null;
  const respIdText = (input.respIdInput ?? '').trim();
  const respMaskText = (input.respMaskInput ?? '').trim();
  if (respIdText.length > 0) {
    responseId = parseId(respIdText);
    if (responseId === null) return { ok: false, field: 'respId' };
  }
  if (respMaskText.length > 0) {
    responseMask = parseId(respMaskText);
    if (responseMask === null) return { ok: false, field: 'respMask' };
  }
  // `responseIdFilters` and the legacy responseId / responseMask are mutually exclusive.
  if (oemBuilt.responseIdFilters !== null) {
    if (responseId !== null || responseMask !== null) return { ok: false, field: 'exclusive' };
    if (oemBuilt.responseIdFilters.some((f) => idFilterMatches(f, functionalId))) {
      return { ok: false, field: 'functionalInFilter' };
    }
  }
  const request: EcuDiscoveryRequestDto = {
    busId: input.busId,
    isExtendedId: input.isExtended,
    functionalId,
    requestPdu: pdu.bytes,
    windowMs: win,
    responseId,
    responseMask,
    padding: input.padding,
    useFd: input.useFd,
    identify: input.identify,
  };
  // Additive fields are only sent when the operator used them (keeps the legacy payload byte-identical).
  if (oemBuilt.responseIdFilters !== null) request.responseIdFilters = oemBuilt.responseIdFilters;
  if (oemBuilt.requestIdRule !== null) request.requestIdRule = oemBuilt.requestIdRule;
  if (oemBuilt.addressing.addressFormat !== 'normal') {
    request.addressFormat = oemBuilt.addressing.addressFormat;
    request.targetAddress = oemBuilt.addressing.targetAddress;
    request.responseAddress = oemBuilt.addressing.responseAddress;
  }
  return { ok: true, request };
}

// ─── Physical sweep ──────────────────────────────────────────────────────────

export const DEFAULT_SWEEP_GAP_MS = 20;
export const DEFAULT_SWEEP_TAIL_MS = 200;

export type SweepIdMode = 'range' | 'list';

export interface SweepFormInput {
  busId: number;
  isExtended: boolean;
  useFd: boolean;
  padding: number | null;
  mode: SweepIdMode;
  startInput: string;
  endInput: string;
  listInput: string;
  pduInput: string;
  gapInput: string;
  tailInput: string;
  oem: OemRangeInput;
}

export type SweepFormField =
  | 'range'
  | 'rangeOrder'
  | 'idList'
  | 'idDuplicate'
  | 'idCount'
  | 'idWidth'
  | 'gap'
  | 'tail'
  | 'pdu'
  | 'filters'
  | 'rule'
  | 'addressing'
  | 'extendedRefused'
  | 'idForm'
  | 'idInFilter';

export type SweepBuild =
  | {
      ok: true;
      request: PhysicalSweepRequestDto;
      total: number;
      /** `total x gap + tail`. */
      estimatedMs: number;
    }
  | {
      ok: false;
      field: SweepFormField;
      pduError?: Exclude<PduCheck, { ok: true }>;
      filter?: FilterError;
      addr?: AddressingError;
      idForm?: IdFormError;
      /** Offending id (`idDuplicate` / `idInFilter` / `idWidth`). */
      id?: number;
      count?: number;
    };

function parseIntInRange(text: string, fallback: number, min: number, max: number): number | null {
  const t = text.trim();
  if (t.length === 0) return fallback;
  if (!/^\d+$/.test(t)) return null;
  const n = parseInt(t, 10);
  return n >= min && n <= max ? n : null;
}

/** Pure sweep request builder; mirrors the backend plan checks so the confirm dialog can be exact. */
export function buildSweepRequest(input: SweepFormInput): SweepBuild {
  const ext = input.isExtended;
  const full = fullIdMask(ext);
  const oem = buildOemRange(input.oem, ext);
  if (!oem.ok) {
    if (oem.field === 'filters') return { ok: false, field: 'filters', filter: oem.filter };
    if (oem.field === 'rule') return { ok: false, field: 'rule' };
    return { ok: false, field: 'addressing', addr: oem.addr };
  }
  const format = oem.addressing.addressFormat ?? 'normal';
  if (format === 'extended') return { ok: false, field: 'extendedRefused' };

  let ids: number[];
  let requestIds: number[] | null = null;
  let requestIdRange: { start: number; end: number } | null = null;
  if (input.mode === 'range') {
    const start = parseId(input.startInput);
    const end = parseId(input.endInput);
    if (start === null || end === null) return { ok: false, field: 'range' };
    if (end < start) return { ok: false, field: 'rangeOrder' };
    const n = end - start + 1;
    if (n > MAX_SWEEP_IDS) return { ok: false, field: 'idCount', count: n };
    ids = Array.from({ length: n }, (_, i) => start + i);
    requestIdRange = { start, end };
  } else {
    ids = [];
    for (const tok of input.listInput.split(/[\s,;]+/)) {
      if (tok.length === 0) continue;
      const id = parseId(tok);
      if (id === null) return { ok: false, field: 'idList' };
      ids.push(id);
    }
    if (ids.length === 0) return { ok: false, field: 'idList' };
    if (ids.length > MAX_SWEEP_IDS) return { ok: false, field: 'idCount', count: ids.length };
    const seen = new Set<number>();
    for (const id of ids) {
      if (seen.has(id)) return { ok: false, field: 'idDuplicate', id };
      seen.add(id);
    }
    requestIds = ids;
  }
  const tooWide = ids.find((id) => id > full);
  if (tooWide !== undefined) return { ok: false, field: 'idWidth', id: tooWide };

  const idForm = checkIdForms(format, ext, ids, null);
  if (idForm) return { ok: false, field: 'idForm', idForm };

  const pdu = checkPdu(input.pduInput, input.useFd, addressByteCount(format));
  if (!pdu.ok) return { ok: false, field: 'pdu', pduError: pdu };
  const gap = parseIntInRange(input.gapInput, DEFAULT_SWEEP_GAP_MS, 5, 1000);
  if (gap === null) return { ok: false, field: 'gap' };
  const tail = parseIntInRange(input.tailInput, DEFAULT_SWEEP_TAIL_MS, 0, 5000);
  if (tail === null) return { ok: false, field: 'tail' };

  // Requests and responses must use distinct ids (effective filters = custom list or backend default).
  const effective = oem.responseIdFilters ?? [defaultResponseFilter(ext, format === 'mixed')];
  const clash = ids.find((id) => effective.some((f) => idFilterMatches(f, id)));
  if (clash !== undefined) return { ok: false, field: 'idInFilter', id: clash };

  const request: PhysicalSweepRequestDto = {
    busId: input.busId,
    isExtendedId: ext,
    requestIds,
    requestIdRange,
    requestPdu: pdu.bytes,
    gapMs: gap,
    tailMs: tail,
    padding: input.padding,
    useFd: input.useFd,
  };
  if (oem.responseIdFilters !== null) request.responseIdFilters = oem.responseIdFilters;
  if (oem.requestIdRule !== null) request.requestIdRule = oem.requestIdRule;
  if (format !== 'normal') {
    request.addressFormat = format;
    request.targetAddress = oem.addressing.targetAddress;
    request.responseAddress = oem.addressing.responseAddress;
  }
  return { ok: true, request, total: ids.length, estimatedMs: ids.length * gap + tail };
}
