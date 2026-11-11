/**
 * Single source of truth for presenting UDS responses (UDS Console, conversation log, DID Inspector,
 * diagnosticsStore). Pure, no React, no i18n: output is technical text (service/DID/NRC names, hex).
 */
import { DID_CATALOG, PID_CATALOG, UDS_SERVICES } from '../types/diagnostics';

function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

function hexBytes(bytes: readonly number[]): string {
  return bytes.map(hex2).join(' ');
}

const DIAG_SESSION_NAMES: Readonly<Record<number, string>> = { 1: 'Default', 2: 'Programming', 3: 'Extended' };

/** ISO 14229 session id -> name; unknown ids -> `0xNN`. */
export function udsSessionName(code: number): string {
  return DIAG_SESSION_NAMES[code] ?? `0x${hex2(code)}`;
}

const NRC_NAMES: Readonly<Record<number, string>> = {
  0x10: 'generalReject',
  0x11: 'serviceNotSupported',
  0x12: 'subFunctionNotSupported',
  0x13: 'incorrectMessageLengthOrInvalidFormat',
  0x14: 'responseTooLong',
  0x21: 'busyRepeatRequest',
  0x22: 'conditionsNotCorrect',
  0x24: 'requestSequenceError',
  0x25: 'noResponseFromSubnetComponent',
  0x26: 'failurePreventsExecutionOfRequestedAction',
  0x31: 'requestOutOfRange',
  0x33: 'securityAccessDenied',
  0x35: 'invalidKey',
  0x36: 'exceededNumberOfAttempts',
  0x37: 'requiredTimeDelayNotExpired',
  0x70: 'uploadDownloadNotAccepted',
  0x71: 'transferDataSuspended',
  0x72: 'generalProgrammingFailure',
  0x73: 'wrongBlockSequenceCounter',
  0x78: 'requestCorrectlyReceivedResponsePending',
  0x7e: 'subFunctionNotSupportedInActiveSession',
  0x7f: 'serviceNotSupportedInActiveSession',
};

/** NRC code -> ISO 14229 name, or `null` when not in the table. */
export function udsNrcName(nrc: number): string | null {
  return NRC_NAMES[nrc] ?? null;
}

/** OBD-II (SAE J1979) service 0x01 label; not a UDS service. Shared with the traffic dock. */
export const OBD_MODE01_NAME = 'OBD-II Mode 01 (Current Data)';

function serviceName(sid: number): string {
  if (sid === 0x01) return OBD_MODE01_NAME;
  return UDS_SERVICES.find((s) => s.sid === sid)?.name ?? `0x${hex2(sid)}`;
}

/** DID -> catalog name (`VIN`, `ECUSerialNumber`, ...) or `null`. */
export function didName(did: number): string | null {
  return DID_CATALOG.find((d) => d.did === did)?.name ?? null;
}

export function formatDid(did: number): string {
  return `0x${did.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Exact TS port of the backend `DidReadResultDto.decoded` rule: trailing 0x00 / 0xFF / 0x20 are
 * trimmed; if everything that remains is printable ASCII (0x20..0x7E) the trimmed text is returned,
 * otherwise the WHOLE record as upper-case hex without separators.
 * Deviation: a non-empty record that trims to nothing (all 00/FF/20) yields the hex form, never "".
 */
export function decodeDidRecord(bytes: readonly number[]): string {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x00 || bytes[end - 1] === 0xff || bytes[end - 1] === 0x20)) end -= 1;
  const trimmed = bytes.slice(0, end);
  const printable = trimmed.length > 0 && trimmed.every((b) => b >= 0x20 && b <= 0x7e);
  if (printable) return String.fromCharCode(...trimmed);
  return bytes.map(hex2).join('');
}

/** `decodeDidRecord` plus the one DID-specific rule: F186 ActiveDiagnosticSession -> session name. */
/** Date DIDs of ISO 14229-1 Annex C. The standard does not fix their byte layout; BCD is common. */
const DATE_DIDS: ReadonlySet<number> = new Set([0xf18b, 0xf199, 0xf19b, 0xf19d]);

function bcdByte(b: number): number | null {
  const hi = b >> 4;
  const lo = b & 0x0f;
  return hi > 9 || lo > 9 ? null : hi * 10 + lo;
}

/**
 * BCD date: `YY MM DD` (3 bytes, 20YY) or `YYYY MM DD` (4 bytes). Returns null when the record is
 * not a plausible BCD date, so the caller falls back to the generic ASCII/hex rule.
 */
export function decodeBcdDate(bytes: readonly number[]): string | null {
  if (bytes.length !== 3 && bytes.length !== 4) return null;
  const v = bytes.map(bcdByte);
  if (v.some((x) => x === null)) return null;
  const n = v as number[];
  const year = n.length === 3 ? 2000 + n[0] : n[0] * 100 + n[1];
  const month = n[n.length - 2];
  const day = n[n.length - 1];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const p2 = (x: number) => String(x).padStart(2, '0');
  return `${year}-${p2(month)}-${p2(day)} (BCD)`;
}

export function decodeDidValue(did: number, bytes: readonly number[]): string {
  if (did === 0xf186 && bytes.length === 1) return udsSessionName(bytes[0]);
  if (DATE_DIDS.has(did)) {
    const date = decodeBcdDate(bytes);
    if (date !== null) return date;
  }
  return decodeDidRecord(bytes);
}

export type UdsInterpretationKind =
  | 'did'
  | 'obd'
  | 'session'
  | 'securitySeed'
  | 'securityKey'
  | 'dtc'
  | 'testerPresent'
  | 'ack'
  | 'negative'
  | 'malformed'
  | 'unknown';

export interface UdsInterpretation {
  kind: UdsInterpretationKind;
  /** Headline, e.g. `0xF190 VIN`, `DiagnosticSessionControl: Extended`, `NRC 0x31 requestOutOfRange`. */
  title: string;
  /** Decoded payload when there is one (DID value, seed/key hex, P2 timing), else `null`. */
  value: string | null;
  /** One-line summary for dense tables, e.g. `VIN=WNX0…017`. */
  brief: string;
}

function shorten(text: string, max = 12): string {
  if (text.length <= max) return text;
  return `${text.slice(0, 4)}…${text.slice(-3)}`;
}

const DTC_COUNT_SUBS: ReadonlySet<number> = new Set([0x01, 0x07, 0x11, 0x12]);
const DTC_LIST_SUBS: ReadonlySet<number> = new Set([0x02, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x13, 0x15]);

function malformed(raw: readonly number[]): UdsInterpretation {
  return { kind: 'malformed', title: `Short response (${raw.length} B)`, value: null, brief: hexBytes(raw) };
}

/**
 * Interpret a complete UDS response PDU (`raw[0]` = response SID or 0x7F). `request` is optional
 * context (the request PDU, may be empty). Unknown services return kind `unknown` (hex only).
 */
export function interpretUdsResponse(request: readonly number[], response: readonly number[]): UdsInterpretation {
  if (response.length === 0) return { kind: 'unknown', title: '—', value: null, brief: '' };
  const sid = response[0];

  if (sid === 0x7f) {
    if (response.length < 3) return malformed(response);
    const rejected = response[1];
    const nrc = response[2];
    const name = udsNrcName(nrc);
    const svc = serviceName(rejected);
    const title = `${svc}: NRC 0x${hex2(nrc)}${name ? ` ${name}` : ''}`;
    return { kind: 'negative', title, value: null, brief: `NRC 0x${hex2(nrc)}${name ? ` ${name}` : ''}` };
  }

  switch (sid) {
    case 0x62: {
      if (response.length < 3) return malformed(response);
      const did = (response[1] << 8) | response[2];
      const record = response.slice(3);
      const name = didName(did);
      const multi = request.length > 3 && request[0] === 0x22;
      if (multi) {
        return {
          kind: 'did',
          title: `ReadDataByIdentifier (${Math.floor((request.length - 1) / 2)} DIDs)`,
          value: null,
          brief: `${formatDid(did)}… ${record.length} B`,
        };
      }
      const value = decodeDidValue(did, record);
      return {
        kind: 'did',
        title: `${formatDid(did)} ${name ?? ''}`.trim(),
        value,
        brief: `${name ?? formatDid(did)}=${shorten(value)}`,
      };
    }
    case 0x50: {
      if (response.length < 2) return malformed(response);
      const name = udsSessionName(response[1]);
      let value: string | null = null;
      if (response.length >= 6) {
        const p2 = (response[2] << 8) | response[3];
        const p2Star = ((response[4] << 8) | response[5]) * 10;
        value = `P2=${p2} ms, P2*=${p2Star} ms`;
      }
      return {
        kind: 'session',
        title: `DiagnosticSessionControl: ${name}`,
        value,
        brief: value ? `${name} · ${value}` : name,
      };
    }
    case 0x67: {
      if (response.length < 2) return malformed(response);
      const sub = response[1] & 0x7f;
      const data = response.slice(2);
      if (sub % 2 === 1) {
        const allZero = data.length > 0 && data.every((b) => b === 0);
        const value = data.length > 0 ? hexBytes(data) : null;
        return {
          kind: 'securitySeed',
          title: `SecurityAccess seed (level 0x${hex2(sub)})${allZero ? ' - already unlocked' : ''}`,
          value,
          brief: `seed=${value ?? '—'}`,
        };
      }
      return {
        kind: 'securityKey',
        title: `SecurityAccess key accepted (level 0x${hex2(sub - 1)})`,
        value: null,
        brief: `key OK (level 0x${hex2(sub - 1)})`,
      };
    }
    case 0x59: {
      if (response.length < 2) return malformed(response);
      const sub = response[1] & 0x7f;
      let count: number | null = null;
      if (DTC_COUNT_SUBS.has(sub) && response.length >= 6) count = (response[4] << 8) | response[5];
      else if (DTC_LIST_SUBS.has(sub) && response.length >= 3) count = Math.floor((response.length - 3) / 4);
      const value = count === null ? null : `${count} DTC`;
      return {
        kind: 'dtc',
        title: `ReadDTCInformation 0x${hex2(sub)}${value ? `: ${value}` : ''}`,
        value,
        brief: value ? `sub 0x${hex2(sub)} · ${value}` : `sub 0x${hex2(sub)}`,
      };
    }
    case 0x7e:
      return { kind: 'testerPresent', title: 'TesterPresent OK', value: null, brief: 'TesterPresent OK' };
    case 0x51: {
      const sub = response.length >= 2 ? response[1] & 0x7f : null;
      const text = sub === null ? 'ECUReset OK' : `ECUReset OK (type 0x${hex2(sub)})`;
      return { kind: 'ack', title: text, value: null, brief: text };
    }
    case 0x54:
      return { kind: 'ack', title: 'ClearDiagnosticInformation OK', value: null, brief: 'DTC cleared' };
    case 0x68: {
      const sub = response.length >= 2 ? response[1] & 0x7f : null;
      const text = sub === null ? 'CommunicationControl OK' : `CommunicationControl OK (0x${hex2(sub)})`;
      return { kind: 'ack', title: text, value: null, brief: text };
    }
    case 0xc5: {
      const sub = response.length >= 2 ? response[1] & 0x7f : null;
      const text = sub === null ? 'ControlDTCSetting OK' : `ControlDTCSetting OK (${sub === 1 ? 'ON' : sub === 2 ? 'OFF' : `0x${hex2(sub)}`})`;
      return { kind: 'ack', title: text, value: null, brief: text };
    }
    case 0x6e: {
      if (response.length < 3) return malformed(response);
      const did = (response[1] << 8) | response[2];
      const text = `WriteDataByIdentifier OK (${formatDid(did)}${didName(did) ? ` ${didName(did)}` : ''})`;
      return { kind: 'ack', title: text, value: null, brief: text };
    }
    case 0x71: {
      if (response.length < 4) return malformed(response);
      const sub = response[1] & 0x7f;
      const rid = (response[2] << 8) | response[3];
      const subText = sub === 1 ? 'start' : sub === 2 ? 'stop' : sub === 3 ? 'results' : `0x${hex2(sub)}`;
      const extra = response.slice(4);
      const text = `RoutineControl ${subText} 0x${rid.toString(16).toUpperCase().padStart(4, '0')} OK`;
      return {
        kind: 'ack',
        title: text,
        value: extra.length > 0 ? hexBytes(extra) : null,
        brief: extra.length > 0 ? `${text} · ${extra.length} B` : text,
      };
    }
    case 0x41: {
      // OBD-II Mode 01 positive response `41 <pid> <data…>` (SAE J1979, not UDS).
      if (response.length < 2) return malformed(response);
      const pid = response[1];
      const def = PID_CATALOG.find((p) => p.pid === pid);
      const pidHex = hex2(pid);
      if (!def) {
        const data = response.slice(2);
        return { kind: 'obd', title: `OBD-II Mode 01 · PID 0x${pidHex}`, value: hexBytes(data), brief: `PID ${pidHex} = ${hexBytes(data)}` };
      }
      if (response.length < 2 + def.bytes) return malformed(response);
      const text = `${def.formatValue(def.formula(response.slice(2, 2 + def.bytes)))} ${def.unit}`.trim();
      return {
        kind: 'obd',
        title: `OBD-II Mode 01 · PID 0x${pidHex} ${def.name}`,
        value: text,
        brief: `PID ${pidHex} ${def.name} = ${text}`,
      };
    }
    default:
      return { kind: 'unknown', title: `Response 0x${hex2(sid)}`, value: null, brief: '' };
  }
}

/** SAE J2012 DTC from the 3 raw bytes, e.g. `[0x01, 0x00, 0x09]` -> `P0100-09`. */
export function formatDtc3(b0: number, b1: number, b2: number): string {
  const letter = 'PCBU'[(b0 >> 6) & 0x03];
  const digit = (b0 >> 4) & 0x03;
  return `${letter}${digit}${(b0 & 0x0f).toString(16).toUpperCase()}${hex2(b1)}-${hex2(b2)}`;
}

/** ReadDTCInformation (0x59) sub-functions that return a DTC-and-status list (4 bytes per record from index 3). */
export const DTC_RECORD_SUBFUNCTIONS: ReadonlySet<number> = new Set([
  0x02, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x13, 0x15,
]);
/** ReadDTCInformation sub-functions that return only a count (u16 at index 4). */
export const DTC_COUNT_SUBFUNCTIONS: ReadonlySet<number> = DTC_COUNT_SUBS;
