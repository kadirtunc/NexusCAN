/**
 * R2b "Save found signals to DBC" DTO mirror (planning/contracts/re-toolkit-v1.md §7.1). Rust serde camelCase.
 * Byte order reuses `ReByteOrder` from `./re` (`'intel' | 'motorola'`).
 */
import type { ReByteOrder } from './re';

export type ReSignalValueType = 'unsigned' | 'signed' | 'float32' | 'float64';

export interface ReSignalProvenanceDto {
  r: number | null;
  lagMs: number | null;
  reference: string | null;
  samples: number | null;
  createdAtMs: number;
}

export interface ReValueTableEntryDto {
  value: number;
  label: string;
}

export interface ReSignalDraftDto {
  /** uuid, UI identity */
  id: string;
  bus: number;
  arbId: number;
  isExtended: boolean;
  /** null -> existing message name if the loaded DB has this id, else `RE_<HEXID>` */
  messageName: string | null;
  dlcBytes: number;
  name: string;
  /** Intel = LSB, Motorola = MSB sawtooth (same as ReCandidateDto) */
  startBit: number;
  bitLength: number;
  byteOrder: ReByteOrder;
  valueType: ReSignalValueType;
  factor: number;
  offset: number;
  min: number;
  max: number;
  unit: string;
  comment: string;
  provenance: ReSignalProvenanceDto;
  valueTable: ReValueTableEntryDto[];
}

export interface ReDbcDiagnosticDto {
  severity: 'error' | 'warning';
  draftId: string | null;
  code: string;
  message: string;
}

export interface ReDbcGenerateResultDto {
  dbcText: string;
  diagnostics: ReDbcDiagnosticDto[];
  messages: number;
  signals: number;
}
