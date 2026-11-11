/**
 * Shared, pure helpers for building a functional ECU discovery request. Used by the Session Setup
 * `EcuDiscoveryPanel` and the ECU Graph toolbar so both validate identically (no i18n here: callers
 * map the returned `error` codes to localized text).
 */
import { UDS_SERVICES } from '../../types/diagnostics';
import type { EcuDiscoveryRequestDto } from '../../types/udsClient';
import { parseHexBytes } from './diagFormat';

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

/** Functional requests are single-frame (classic 1..7, FD 1..62) and must not suppress the response. */
export function checkPdu(text: string, useFd: boolean): PduCheck {
  const parsed = parseHexBytes(text);
  if (!parsed.ok) return { ok: false, error: 'hex', token: parsed.token };
  const max = useFd ? 62 : 7;
  if (parsed.bytes.length < 1 || parsed.bytes.length > max) return { ok: false, error: 'length' };
  const svc = UDS_SERVICES.find((s) => s.sid === parsed.bytes[0]);
  if (svc?.hasSubFunction && parsed.bytes.length >= 2 && (parsed.bytes[1] & 0x80) !== 0) {
    return { ok: false, error: 'suppressed' };
  }
  return { ok: true, bytes: parsed.bytes };
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
}

export type DiscoveryFormField = 'functionalId' | 'window' | 'respId' | 'respMask' | 'pdu';

export type DiscoveryBuild =
  | { ok: true; request: EcuDiscoveryRequestDto }
  | { ok: false; field: DiscoveryFormField; pduError?: Exclude<PduCheck, { ok: true }> };

export function buildDiscoveryRequest(input: DiscoveryFormInput): DiscoveryBuild {
  const functionalId = parseId(input.funcInput);
  if (functionalId === null) return { ok: false, field: 'functionalId' };
  const pdu = checkPdu(input.pduInput, input.useFd);
  if (!pdu.ok) return { ok: false, field: 'pdu', pduError: pdu };
  const win = parseInt(input.windowInput, 10);
  if (!Number.isFinite(win) || win < 50 || win > 5000) return { ok: false, field: 'window' };
  let responseId: number | null = null;
  let responseMask: number | null = null;
  if ((input.respIdInput ?? '').trim().length > 0) {
    responseId = parseId(input.respIdInput ?? '');
    if (responseId === null) return { ok: false, field: 'respId' };
  }
  if ((input.respMaskInput ?? '').trim().length > 0) {
    responseMask = parseId(input.respMaskInput ?? '');
    if (responseMask === null) return { ok: false, field: 'respMask' };
  }
  return {
    ok: true,
    request: {
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
    },
  };
}
