/**
 * Pure validation of the diagnostic session addressing form (request / response CAN id).
 * No React, no i18n: the setup form maps the result codes to localized text.
 */

export type IdFieldError = 'badHex' | 'range11' | 'range29';

export const MAX_STD_ID = 0x7ff;
export const MAX_EXT_ID = 0x1fffffff;

/** Strict hex id: optional `0x`, hex digits only, at most 8 digits. `null` when unparseable. */
export function parseStrictHexId(input: string): number | null {
  const clean = input.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{1,8}$/.test(clean)) return null;
  return parseInt(clean, 16);
}

export function checkIdField(input: string, isExtended: boolean): { value: number | null; error: IdFieldError | null } {
  const value = parseStrictHexId(input);
  if (value === null) return { value: null, error: 'badHex' };
  if (isExtended ? value > MAX_EXT_ID : value > MAX_STD_ID) {
    return { value, error: isExtended ? 'range29' : 'range11' };
  }
  return { value, error: null };
}

export interface SessionIdValidation {
  requestValue: number | null;
  responseValue: number | null;
  requestError: IdFieldError | null;
  responseError: IdFieldError | null;
  /** Request id equals response id (both valid). */
  sameIds: boolean;
  /** Any hard error: Connect must be disabled. */
  hasError: boolean;
}

export function validateSessionIds(requestInput: string, responseInput: string, isExtended: boolean): SessionIdValidation {
  const req = checkIdField(requestInput, isExtended);
  const resp = checkIdField(responseInput, isExtended);
  const sameIds =
    req.error === null && resp.error === null && req.value !== null && req.value === resp.value;
  return {
    requestValue: req.value,
    responseValue: resp.value,
    requestError: req.error,
    responseError: resp.error,
    sameIds,
    hasError: req.error !== null || resp.error !== null || sameIds,
  };
}

/** Classic 11-bit OBD-II / UDS physical pair: request 0x7E0..0x7E7 answers on request + 8. */
export function suggestResponseId(request: number | null, isExtended: boolean): number | null {
  if (request === null || isExtended) return null;
  return request >= 0x7e0 && request <= 0x7e7 ? request + 8 : null;
}
