/**
 * RE Toolkit R2c "Value Scan" DTO mirror (planning/contracts/re-toolkit-v1.md §8, amendments §8.6). Rust serde
 * camelCase. `ReByteOrder` / `ReValueType` / `ReTargetDto` / `ReFieldKind` are reused from `./re`.
 */
import type { ReByteOrder, ReFieldKind, ReTargetDto, ReValueType } from './re';

/** `physical` = exact physical value (matched under scale presets). */
export type ReScanKind = 'exact' | 'physical' | 'range' | 'unknown';
export type ReScanAlignment = 'any' | 'nibble' | 'byte';
/** `samples` 1..=64 (lower median of the last N samples). */
export type ReScanReadMode = { kind: 'latest' } | { kind: 'median'; samples: number };

export interface ReScalePresetDto {
  factor: number;
  offset: number;
}

export interface ReScanOptionsDto {
  lengths: number[];
  byteOrders: ReByteOrder[];
  signed: boolean[];
  float32: boolean;
  include64: boolean;
  alignment: ReScanAlignment;
  excludeCounterChecksum: boolean;
  excludeConstant: boolean;
  /** null = all buses */
  buses: number[] | null;
  /** null = all IDs */
  ids: ReTargetDto[] | null;
  readMode: ReScanReadMode;
}

export interface ReScanFirstSpec {
  kind: ReScanKind;
  value: number | null;
  tolerance: number | null;
  range: [number, number] | null;
  /** range only: interpret `range` as physical (preset matching) */
  physical: boolean;
  /** null = standard 66-preset grid */
  presets: ReScalePresetDto[] | null;
  userPresets: ReScalePresetDto[];
  options: ReScanOptionsDto;
}

export type ReScanOpKind =
  | 'changed'
  | 'unchanged'
  | 'increased'
  | 'decreased'
  | 'either'
  | 'increasedBy'
  | 'decreasedBy'
  | 'exact'
  | 'range'
  | 'stable';

export interface ReScanNextOp {
  op: ReScanOpKind;
  value: number | null;
  tolerance: number | null;
  range: [number, number] | null;
  stableMs: number | null;
  physical: boolean;
  presets: ReScalePresetDto[] | null;
}

export type ReScanSort = 'id' | 'changes' | 'width';

export interface ReScanStatusDto {
  active: boolean;
  scanId: number;
  step: number;
  candidates: number;
  /** candidate count after every step, first scan included */
  history: number[];
  truncated: boolean;
  elapsedMs: number;
  undoDepth: number;
  /** only meaningful after a `stable` scan, else null */
  historyCovered: boolean | null;
}

export interface ReScanCandidateDto {
  bus: number;
  arbId: number;
  isExtended: boolean;
  startBit: number;
  bitLength: number;
  byteOrder: ReByteOrder;
  valueType: ReValueType;
}

export interface ReScanResultRowDto {
  candidate: ReScanCandidateDto;
  preset: ReScalePresetDto | null;
  currentRaw: number | null;
  currentPhysical: number | null;
  previousRaw: number | null;
  changeCount: number;
  kindHint: ReFieldKind | null;
  containedCount: number;
  contained: ReScanCandidateDto[];
}

export interface ReScanResultsDto {
  scanId: number;
  step: number;
  /** rows after grouping */
  total: number;
  /** candidates before grouping */
  candidates: number;
  offset: number;
  rows: ReScanResultRowDto[];
}
