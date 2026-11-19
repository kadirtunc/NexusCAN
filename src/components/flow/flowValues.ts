/**
 * Value helpers shared by the real executor, the core block pack (`coreBlocks.ts` / `coreRuntime.ts`)
 * and both flow engines: byte / text / number coercions and the `data_compare` operators.
 * No I/O, no clock reads.
 */
import { t } from '../../i18n';
import type { FlowFileValue } from '../../types/flowLibrary';
import { asciiText, rawBytes } from './flowData';

export function hexB(b: number): string {
  return b.toString(16).padStart(2, '0').toUpperCase();
}

export function hexList(bytes: ArrayLike<number>): string {
  return Array.from(bytes).map(hexB).join(' ');
}

/** `{ name, bytes }` value of a `file` input (flow-interface-v2 §2). */
export function isFlowFileValue(v: unknown): v is FlowFileValue {
  if (typeof v !== 'object' || v === null || v instanceof Uint8Array || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o['name'] === 'string' && o['bytes'] instanceof Uint8Array;
}

export function asBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (isFlowFileValue(v)) return v.bytes;
  if (Array.isArray(v) && v.every((x): x is number => typeof x === 'number')) return Uint8Array.from(v);
  return null;
}

export function valueText(v: unknown): string {
  const b = asBytes(v);
  if (b) return hexList(b);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v) ?? '';
}

export function normText(v: unknown): string {
  const b = asBytes(v);
  if (b) return Array.from(b).map(hexB).join('');
  if (typeof v === 'string') return v.trim().replace(/^0x/i, '').replace(/\s+/g, '').toUpperCase();
  return String(v).toUpperCase();
}

/** Number of a value (decimal / 0x text, bool, up to 6 big-endian bytes); `NaN` when it is not numeric. */
export function numeric(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const b = asBytes(v);
  if (b) return b.length > 0 && b.length <= 6 ? b.reduce((acc, x) => acc * 256 + x, 0) : NaN;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  }
  return NaN;
}

export function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.trim().length > 0 && v.trim().toLowerCase() !== 'false' && v.trim() !== '0';
  const b = asBytes(v);
  return b ? b.some((x) => x !== 0) : false;
}

/** `data_compare` / `assert` operators. `gt lt ge le` are numeric-only (non-numeric operands throw). */
export function compareValues(op: string, a: unknown, b: unknown): boolean {
  const an = numeric(a);
  const bn = numeric(b);
  switch (op) {
    case 'eq':
      return Number.isFinite(an) && Number.isFinite(bn) ? an === bn : normText(a) === normText(b);
    case 'neq':
      return Number.isFinite(an) && Number.isFinite(bn) ? an !== bn : normText(a) !== normText(b);
    case 'contains':
      return normText(a).includes(normText(b));
    case 'ascii_equals':
      return asciiText(a) === asciiText(b);
    case 'bytes_not_equal':
      return hexList(rawBytes(a)) !== hexList(rawBytes(b));
    case 'gt':
    case 'lt':
    case 'ge':
    case 'le':
      if (!Number.isFinite(an) || !Number.isFinite(bn)) throw new Error(t('diagReal.flow.notNumeric'));
      if (op === 'gt') return an > bn;
      if (op === 'lt') return an < bn;
      if (op === 'ge') return an >= bn;
      return an <= bn;
    default:
      throw new Error(t('diagReal.flow.badOperator', { op }));
  }
}

/** "08 00 00 00" / "0x08000000" -> bytes; odd digit counts are left-padded; empty/invalid -> Error. */
export function hexField(raw: unknown, field: string): number[] {
  const s = String(raw ?? '').replace(/^\s*0x/i, '').replace(/[\s,]/g, '');
  if (s.length === 0 || !/^[0-9a-fA-F]+$/.test(s)) throw new Error(t('diagReal.flow.invalidHex', { field }));
  const even = s.length % 2 === 0 ? s : `0${s}`;
  return (even.match(/.{2}/g) ?? []).map((p) => parseInt(p, 16));
}
