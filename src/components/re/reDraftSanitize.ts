/**
 * Structural sanitizer for persisted RE signal drafts (`NexusProjectFileV1.reSignals`). Pure, never throws, never
 * mutates its input; returns fresh objects with unknown keys stripped. Only structural breakage drops an entry
 * (counted in `dropped`); semantic problems (bad DBC identifier, factor 0, overlaps...) are kept so the user can fix
 * them and the generator reports them.
 */
import type { ReByteOrder } from '../../types/re';
import type {
  ReSignalDraftDto,
  ReSignalProvenanceDto,
  ReSignalValueType,
  ReValueTableEntryDto,
} from '../../types/reDraft';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isInt(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}
function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const BYTE_ORDERS: readonly ReByteOrder[] = ['intel', 'motorola'];
const VALUE_TYPES: readonly ReSignalValueType[] = ['unsigned', 'signed', 'float32', 'float64'];

function numOrNull(o: Record<string, unknown>, key: string): number | null | undefined {
  const v = o[key];
  if (v === undefined || v === null) return null;
  return isFiniteNum(v) ? v : undefined;
}

function sanitizeProvenance(v: unknown): ReSignalProvenanceDto | null {
  if (v === undefined) return { r: null, lagMs: null, reference: null, samples: null, createdAtMs: 0 };
  if (!isRecord(v)) return null;
  const r = numOrNull(v, 'r');
  const lagMs = numOrNull(v, 'lagMs');
  const samples = numOrNull(v, 'samples');
  if (r === undefined || lagMs === undefined || samples === undefined) return null;
  const ref = v['reference'];
  if (ref !== undefined && ref !== null && typeof ref !== 'string') return null;
  const created = v['createdAtMs'];
  if (created !== undefined && !isFiniteNum(created)) return null;
  return { r, lagMs, reference: typeof ref === 'string' ? ref : null, samples, createdAtMs: created ?? 0 };
}

function sanitizeValueTable(v: unknown): ReValueTableEntryDto[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const out: ReValueTableEntryDto[] = [];
  for (const e of v as unknown[]) {
    if (!isRecord(e)) return null;
    const value = e['value'];
    const label = e['label'];
    if (typeof value !== 'number' || !Number.isInteger(value) || typeof label !== 'string') return null;
    out.push({ value, label });
  }
  return out;
}

/** One entry -> draft, or `null` when structurally malformed. */
export function sanitizeReDraft(raw: unknown): ReSignalDraftDto | null {
  if (!isRecord(raw)) return null;
  const { id, bus, arbId, isExtended, dlcBytes, name, startBit, bitLength, byteOrder, valueType } = raw;
  if (typeof id !== 'string' || id === '') return null;
  if (!isInt(bus, 0, 255)) return null;
  if (typeof isExtended !== 'boolean') return null;
  if (!isInt(arbId, 0, isExtended ? 0x1fff_ffff : 0x7ff)) return null;
  if (!isInt(dlcBytes, 0, 64)) return null;
  if (typeof name !== 'string') return null;
  if (!isInt(startBit, 0, 511)) return null;
  if (!isInt(bitLength, 1, 64)) return null;
  if (typeof byteOrder !== 'string' || !BYTE_ORDERS.includes(byteOrder as ReByteOrder)) return null;
  if (typeof valueType !== 'string' || !VALUE_TYPES.includes(valueType as ReSignalValueType)) return null;
  const { factor, offset, min, max } = raw;
  if (!isFiniteNum(factor) || !isFiniteNum(offset) || !isFiniteNum(min) || !isFiniteNum(max)) return null;
  const messageName = raw['messageName'];
  if (messageName !== undefined && messageName !== null && typeof messageName !== 'string') return null;
  const unit = raw['unit'];
  if (unit !== undefined && typeof unit !== 'string') return null;
  const comment = raw['comment'];
  if (comment !== undefined && typeof comment !== 'string') return null;
  const provenance = sanitizeProvenance(raw['provenance']);
  if (provenance === null) return null;
  const valueTable = sanitizeValueTable(raw['valueTable']);
  if (valueTable === null) return null;
  return {
    id,
    bus,
    arbId,
    isExtended,
    messageName: typeof messageName === 'string' ? messageName : null,
    dlcBytes,
    name,
    startBit,
    bitLength,
    byteOrder: byteOrder as ReByteOrder,
    valueType: valueType as ReSignalValueType,
    factor,
    offset,
    min,
    max,
    unit: unit ?? '',
    comment: comment ?? '',
    provenance,
    valueTable,
  };
}

export function sanitizeReDrafts(input: unknown): { drafts: ReSignalDraftDto[]; dropped: number } {
  if (input === undefined || input === null) return { drafts: [], dropped: 0 };
  if (!Array.isArray(input)) return { drafts: [], dropped: 1 };
  const drafts: ReSignalDraftDto[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of input as unknown[]) {
    const d = sanitizeReDraft(raw);
    if (d === null || seen.has(d.id)) {
      dropped += 1;
      continue;
    }
    seen.add(d.id);
    drafts.push(d);
  }
  return { drafts, dropped };
}
