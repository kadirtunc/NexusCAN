/**
 * Explicit MOCK / DEMO value source for the UDS panel. Only used while the user has switched the
 * panel's MOCK toggle ON (default OFF); the panel shows a prominent MOCK / DEMO badge meanwhile.
 */
import type { UdsReadBinding } from '../../../types/uds';
import { sanitizeHex } from './udsBinding';

interface MockEntry {
  value: number;
  dynamic: boolean;
}

const MOCK_BY_ID: Readonly<Record<string, MockEntry>> = {
  F190: { value: 0, dynamic: false },
  F188: { value: 0, dynamic: false },
  F186: { value: 3, dynamic: false },
  F105: { value: 850, dynamic: true }, // Engine RPM
  F106: { value: 90, dynamic: true }, // Coolant temperature
  F107: { value: 42, dynamic: true }, // Vehicle speed
  F108: { value: 14.2, dynamic: true }, // Battery voltage
  F10A: { value: 25, dynamic: true }, // Intake air temperature
  '2201': { value: 1, dynamic: false }, // Fan relay
  '2202': { value: 0, dynamic: false }, // A/C relay
};

/** Physical demo value for a read binding (already scaled; bypasses payload decode). */
export function mockPhysicalValue(r: UdsReadBinding, nowMs: number): number {
  const id = sanitizeHex(r.service === 'read_did' ? r.did : r.address);
  const entry = MOCK_BY_ID[id];
  if (entry?.dynamic) {
    const range = (r.max - r.min) * 0.3;
    return Math.min(r.max, Math.max(r.min, entry.value + Math.sin(nowMs / 3000) * range));
  }
  if (entry) return entry.value;
  const seed = Number.parseInt(id || '0', 16);
  return r.min + (r.max - r.min) * (0.4 + Math.sin(nowMs / 4000 + seed) * 0.1);
}

const MOCK_ASCII: Readonly<Record<string, string>> = {
  F190: 'MOCKVIN0000000DEMO',
  F18C: 'MOCK-SN-000123',
  F187: 'MOCK-PN-4711',
  F188: 'SW-1.0.0-DEMO',
  F189: 'HW-A1',
  F191: 'HW-MOCK-02',
  F195: 'SW-DEMO-3.2',
};

/** Demo bytes of a textbox read (ASCII DIDs get a labelled demo string; others the scaled value). */
export function mockBytes(r: UdsReadBinding, textLen: number): Uint8Array {
  const id = sanitizeHex(r.service === 'read_did' ? r.did : r.address);
  const text = MOCK_ASCII[id] ?? String(Math.round(mockPhysicalValue(r, Date.now())));
  const bytes = Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
  if (textLen > 0) {
    const out = new Uint8Array(textLen);
    out.set(bytes.subarray(0, textLen));
    return out;
  }
  return bytes;
}
