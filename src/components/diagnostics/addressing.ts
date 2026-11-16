/**
 * ISO 15765-2 address-format validation shared by the Session Setup, ECU discovery and physical sweep
 * forms. Pure (no React / i18n): callers map the returned codes to localized text. Mirrors
 * `crates/nexus-protocols/src/uds/addressing.rs` so the operator sees the backend's refusal BEFORE sending.
 */
import { ADDRESS_FORMATS, type AddressFormat } from '../../types/udsClient';

export interface AddressingInput {
  format: AddressFormat;
  /** Hex text of the target byte (N_TA for `extended`, N_AE for `mixed`). */
  target: string;
  /** Hex text of the response byte. */
  response: string;
}

export const DEFAULT_ADDRESSING: AddressingInput = { format: 'normal', target: '', response: '' };

export interface AddressingFields {
  addressFormat: AddressFormat;
  targetAddress: number | null;
  responseAddress: number | null;
}

export type AddressingError =
  | { field: 'target'; reason: 'required' | 'range' }
  | { field: 'response'; reason: 'required' | 'range' };

export type AddressingCheck = { ok: true; fields: AddressingFields } | ({ ok: false } & AddressingError);

export function isAddressFormat(v: unknown): v is AddressFormat {
  return ADDRESS_FORMATS.some((f) => f === v);
}

/** Does the format show a target byte / response byte input? */
export function usesTargetByte(f: AddressFormat): boolean {
  return f === 'extended' || f === 'mixed';
}

/** Address bytes before the PCI (reduces the single-frame payload by one). */
export function addressByteCount(f: AddressFormat): 0 | 1 {
  return usesTargetByte(f) ? 1 : 0;
}

/** "F1" / "0xF1" -> 0..255; `null` = empty, `'invalid'` = not a byte. */
export function parseByteField(text: string): number | null | 'invalid' {
  const clean = text.trim().replace(/^0x/i, '');
  if (clean.length === 0) return null;
  if (!/^[0-9a-fA-F]{1,2}$/.test(clean)) return 'invalid';
  return parseInt(clean, 16);
}

/**
 * `extended` needs target AND response; `mixed` needs target (response defaults to it on the backend);
 * `normal` / `normalFixed` ignore both (sent as `null`).
 */
export function checkAddressing(input: AddressingInput): AddressingCheck {
  const { format } = input;
  if (!usesTargetByte(format)) {
    return { ok: true, fields: { addressFormat: format, targetAddress: null, responseAddress: null } };
  }
  const target = parseByteField(input.target);
  if (target === 'invalid') return { ok: false, field: 'target', reason: 'range' };
  if (target === null) return { ok: false, field: 'target', reason: 'required' };
  const response = parseByteField(input.response);
  if (response === 'invalid') return { ok: false, field: 'response', reason: 'range' };
  if (response === null && format === 'extended') return { ok: false, field: 'response', reason: 'required' };
  return { ok: true, fields: { addressFormat: format, targetAddress: target, responseAddress: response } };
}

/** u8 clamp for values restored from storage / external sources (`null` for anything else). */
export function sanitizeByte(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(255, Math.max(0, Math.trunc(v)));
}

/** Sanitizes a stored address format + bytes (unknown format -> 'normal', bytes clamped to u8). */
export function sanitizeAddressing(raw: { addressFormat?: unknown; targetAddress?: unknown; responseAddress?: unknown }): AddressingFields {
  const addressFormat = isAddressFormat(raw.addressFormat) ? raw.addressFormat : 'normal';
  if (!usesTargetByte(addressFormat)) return { addressFormat, targetAddress: null, responseAddress: null };
  return { addressFormat, targetAddress: sanitizeByte(raw.targetAddress), responseAddress: sanitizeByte(raw.responseAddress) };
}

/** 29-bit id with PDU format `pf` (priority ignored; DP / EDP must be 0). */
export function isPfForm(id: number, pf: number): boolean {
  return id >= 0 && id <= 0x1fffffff && (id & 0x03ff0000) === pf << 16;
}

export type IdFormError = { error: 'needs29bit' } | { error: 'form'; id: number; pf: number; functional: boolean };

/**
 * Id-form rules: `normalFixed` -> 29-bit 0x18DA (physical) / 0x18DB (functional); `mixed` -> 11-bit ids, or
 * 29-bit 0x18CE (physical) / 0x18CD (functional). Returns `null` when everything is acceptable.
 */
export function checkIdForms(
  format: AddressFormat,
  extended: boolean,
  physical: readonly number[],
  functional: number | null,
): IdFormError | null {
  let pfs: [number, number] | null = null;
  if (format === 'normalFixed') {
    if (!extended) return { error: 'needs29bit' };
    pfs = [0xda, 0xdb];
  } else if (format === 'mixed' && extended) {
    pfs = [0xce, 0xcd];
  }
  if (pfs === null) return null;
  for (const id of physical) {
    if (!isPfForm(id, pfs[0])) return { error: 'form', id, pf: pfs[0], functional: false };
  }
  if (functional !== null && !isPfForm(functional, pfs[1])) {
    return { error: 'form', id: functional, pf: pfs[1], functional: true };
  }
  return null;
}
