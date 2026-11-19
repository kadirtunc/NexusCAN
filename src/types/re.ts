/** RE Toolkit R1 DTO mirror (planning/contracts/re-toolkit-v1.md §2.1-§2.3). Rust serde camelCase. */

export type RePhase = 'idle' | 'free' | 'baseline' | 'action';
export type ReSettablePhase = 'free' | 'baseline' | 'action';

export interface ReStatusDto {
  enabled: boolean;
  phase: RePhase;
  rows: number;
  overflowRows: number;
  framesIngested: number;
  startedAtUs: number | null;
  phaseStartedAtUs: number | null;
}

export interface ReMarkerDto {
  id: number;
  tsUs: number;
  label: string;
  phase: RePhase;
}

export interface ReRowDetailDto {
  bus: number;
  arbId: number;
  isExtended: boolean;
  dlcBytes: number;
  rxCount: number;
  /** dlcBytes*8 entries */
  toggles: number[];
  /** uppercase hex, 2 chars per byte, byte 0 first (amendment 11) */
  constantMask: string;
  baselineMask: string;
  actionMask: string;
  diffMask: string;
  /** Additive (backend R1): noise-mute mask = toggled in baseline OR window rate > 50 % of frames. */
  noisyMask?: string;
  firstUs: number;
  lastUs: number;
  historyLen: number;
}

export type ReFieldKind = 'constant' | 'counter' | 'checksum' | 'flag' | 'physical' | 'unknown';
export type ReChecksumAlgo = 'xor8' | 'sum8' | 'crc8_j1850' | 'crc8_h2f' | 'crc8_custom';

export interface ReFieldDto {
  /** Intel: LSB bit. Motorola: DBC MSB start bit (sawtooth numbering, amendment 8). */
  startBit: number;
  bitLength: number;
  byteOrder: 'intel' | 'motorola';
  kind: ReFieldKind;
  /** 0..1 */
  confidence: number;
  counterModulo?: number;
  counterStep?: number;
  checksumAlgo?: ReChecksumAlgo;
  /** Init value found by the 0x00/0xFF sweep (CRC xorout is always 0xFF). */
  checksumInit?: number;
  /** Covered byte indices, ascending ranges, e.g. "0-6" or "0-2,4-7" (amendment 7). */
  checksumCoverage?: string;
  min?: number;
  max?: number;
}

export interface ReClassificationDto {
  bus: number;
  arbId: number;
  isExtended: boolean;
  samples: number;
  /** dlcBytes*8 entries, 0..1 */
  bitEntropy: number[];
  fields: ReFieldDto[];
  periodMs: number | null;
  jitterMs: number | null;
}

export interface ReRowKey {
  bus: number;
  arbId: number;
  isExtended: boolean;
}

/** Decoded binary snapshot (contract §2.2). Row byte arrays are zero-copy views into the source buffer. */
export interface ReSnapshotRow {
  bus: number;
  extended: boolean;
  fd: boolean;
  hasDiff: boolean;
  isNew: boolean;
  dlcBytes: number;
  arbId: number;
  rxCount: number;
  /** dlcBytes*8, 0..255 */
  heat: Uint8Array;
  /** dlcBytes (bit k of byte i = bit i*8+k) */
  diff: Uint8Array;
  /** dlcBytes (1 = bit never changed) */
  constant: Uint8Array;
  /** dlcBytes: latest payload, byte 0 first (snapshot v2 "NRE2") */
  data: Uint8Array;
}

export interface ReSnapshot {
  seq: number;
  tsUs: number;
  phase: RePhase;
  full: boolean;
  rowCount: number;
  totalRows: number;
  rows: ReSnapshotRow[];
}

// ---------------------------------------------------------------------------------------------------------------
// R2a Signal Inspector DTO mirror (planning/contracts/re-toolkit-v1.md §6.2, §6.3). Rust serde camelCase.
// ---------------------------------------------------------------------------------------------------------------

export interface ReTargetDto {
  bus: number;
  arbId: number;
  isExtended: boolean;
}

export interface ReFocusTargetStatusDto extends ReTargetDto {
  samples: number;
  firstUs: number | null;
  lastUs: number | null;
  auto: boolean;
}

export interface ReFocusStatusDto {
  targets: ReFocusTargetStatusDto[];
}

export type ReByteOrder = 'intel' | 'motorola';
export type ReValueType = 'unsigned' | 'signed' | 'float32' | 'float64';

export interface ReCandidateDto {
  /** Intel: LSB bit. Motorola: DBC MSB start bit (sawtooth). */
  startBit: number;
  /** 1..=64 */
  bitLength: number;
  byteOrder: ReByteOrder;
  valueType: ReValueType;
  factor: number;
  offset: number;
}

export interface ReMarkerPointDto {
  markerId: number;
  value: number;
}

export type ReReferenceDto =
  | { kind: 'obd_pid'; pid: number; bus: number }
  | { kind: 'markers'; points: ReMarkerPointDto[] }
  | { kind: 'candidate'; target: ReTargetDto; candidate: ReCandidateDto };

export interface ReSearchDto {
  bitFrom: number;
  bitTo: number;
  /** [min, max] within 1..=32 */
  lengths: [number, number];
  byteOrders: ReByteOrder[];
  signed: boolean[];
}

export interface ReCorrelationRowDto {
  /** factor/offset = least-squares fit raw -> reference */
  candidate: ReCandidateDto;
  r: number;
  r2: number;
  rmse: number;
  samples: number;
  /** 10 ms grid, ±500. > 0 = the target changes BEFORE the reference (amendment R2a-2); r/fit are lag-0 values. */
  lagMs: number;
}

export interface ReCorrelationResultDto {
  rows: ReCorrelationRowDto[];
  evaluated: number;
  referenceSamples: number;
  elapsedMs: number;
  truncated: boolean;
}

export interface ReSeriesRequest {
  target: ReTargetDto;
  candidates: ReCandidateDto[];
  reference: ReReferenceDto | null;
  fromUs: number | null;
  toUs: number | null;
  maxPoints: number;
}

export interface ReCorrelateRequest {
  target: ReTargetDto;
  reference: ReReferenceDto;
  fromUs: number | null;
  toUs: number | null;
  search: ReSearchDto;
  topN: number;
}

export interface RePoints {
  /** microseconds since `ReSeries.fromUs` (u32 on the wire) */
  tUsRel: Float64Array;
  min: Float64Array;
  max: Float64Array;
}

export interface ReSeriesEntry {
  kind: 'candidate' | 'reference';
  index: number;
  points: RePoints;
}

/** Decoded `cmd_re_series` binary (contract §6.3). */
export interface ReSeries {
  seriesCount: number;
  pointsMax: number;
  fromUs: number;
  series: ReSeriesEntry[];
}
