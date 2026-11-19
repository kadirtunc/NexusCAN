/** Pure form model of the "Save signal" dialog: text fields <-> `ReSignalDraftDto` (no React, no I/O). */
import type { ReByteOrder } from '../../types/re';
import type { ReSignalDraftDto, ReSignalValueType } from '../../types/reDraft';

export interface ReDraftForm {
  name: string;
  messageName: string;
  dlcBytes: string;
  startBit: string;
  bitLength: string;
  byteOrder: ReByteOrder;
  valueType: ReSignalValueType;
  factor: string;
  offset: string;
  min: string;
  max: string;
  unit: string;
  comment: string;
  valueTable: { value: string; label: string }[];
}

export type ReDraftFormField = 'dlcBytes' | 'startBit' | 'bitLength' | 'factor' | 'offset' | 'min' | 'max' | 'valueTable';

export function formFromDraft(d: ReSignalDraftDto): ReDraftForm {
  return {
    name: d.name,
    messageName: d.messageName ?? '',
    dlcBytes: String(d.dlcBytes),
    startBit: String(d.startBit),
    bitLength: String(d.bitLength),
    byteOrder: d.byteOrder,
    valueType: d.valueType,
    factor: String(d.factor),
    offset: String(d.offset),
    min: String(d.min),
    max: String(d.max),
    unit: d.unit,
    comment: d.comment,
    valueTable: d.valueTable.map((e) => ({ value: String(e.value), label: e.label })),
  };
}

function num(text: string): number {
  const t = text.trim().replace(',', '.');
  return t === '' ? Number.NaN : Number(t);
}

/** Form -> draft. `invalid` lists the fields that do not parse (the draft is null then). Semantics are the generator's job. */
export function draftFromForm(base: ReSignalDraftDto, f: ReDraftForm): { draft: ReSignalDraftDto | null; invalid: ReDraftFormField[] } {
  const invalid: ReDraftFormField[] = [];
  const int = (field: ReDraftFormField, text: string): number => {
    const n = num(text);
    if (!Number.isInteger(n)) invalid.push(field);
    return n;
  };
  const real = (field: ReDraftFormField, text: string): number => {
    const n = num(text);
    if (!Number.isFinite(n)) invalid.push(field);
    return n;
  };
  const dlcBytes = int('dlcBytes', f.dlcBytes);
  const startBit = int('startBit', f.startBit);
  const bitLength = int('bitLength', f.bitLength);
  const factor = real('factor', f.factor);
  const offset = real('offset', f.offset);
  const min = real('min', f.min);
  const max = real('max', f.max);
  const valueTable = f.valueTable.map((e) => ({ value: num(e.value), label: e.label }));
  if (valueTable.some((e) => !Number.isInteger(e.value))) invalid.push('valueTable');
  if (invalid.length > 0) return { draft: null, invalid };
  const msg = f.messageName.trim();
  return {
    invalid,
    draft: {
      ...base,
      messageName: msg === '' ? null : msg,
      dlcBytes,
      name: f.name.trim(),
      startBit,
      bitLength,
      byteOrder: f.byteOrder,
      valueType: f.valueType,
      factor,
      offset,
      min,
      max,
      unit: f.unit,
      comment: f.comment,
      provenance: { ...base.provenance },
      valueTable,
    },
  };
}

/** float32 / float64 force the bit length (32 / 64); other types keep the current one. */
export function lengthForValueType(vt: ReSignalValueType, current: string): string {
  return vt === 'float32' ? '32' : vt === 'float64' ? '64' : current;
}

/** `true` when the dialog fields differ from the draft it was opened with (discard guard). */
export function formChanged(base: ReSignalDraftDto, f: ReDraftForm): boolean {
  return JSON.stringify(formFromDraft(base)) !== JSON.stringify(f);
}
