/**
 * ECU flashing IPC contract (team-lead fixed). Mirrors the Rust `serde` DTOs of
 * `crates/nexus-protocols/src/uds/flash/` (camelCase on the wire). Keep in sync, never extend
 * on the frontend side alone.
 */

export type FirmwareFormat = 'intelHex' | 'srec' | 'binary';

export interface FirmwareSegmentSummaryDto {
  address: number;
  length: number;
  crc32: number;
}

export interface FirmwareImageSummaryDto {
  segments: FirmwareSegmentSummaryDto[];
  totalBytes: number;
  crc32: number;
}

export interface FlashImageHandleDto {
  imageId: string;
  fileName: string;
  format: FirmwareFormat;
  summary: FirmwareImageSummaryDto;
}

/** Every field optional; `{}` is valid. */
export interface DownloadConfigDto {
  /** Default 0x00. */
  dataFormatIdentifier?: number;
  /** Default 0x44. */
  addressAndLengthFormatIdentifier?: number;
  maxBlockLenOverride?: number | null;
  /** Default 4095 (FD: 65535). */
  maxBlockLenCap?: number;
  transferTimeoutMs?: number | null;
  requestTimeoutMs?: number | null;
  /** Default 2, max 10. */
  retriesPerBlock?: number;
  mode?: 'download' | 'upload';
  transferExitParameter?: number[];
}

export type FlashPhase = 'requestDownload' | 'transfer' | 'exit' | 'done';

export interface FlashProgressDto {
  segmentIndex: number;
  segmentCount: number;
  segmentAddress: number;
  bytesDone: number;
  bytesTotal: number;
  blockCounter: number;
  retries: number;
  phase: FlashPhase;
}

export interface SegmentReportDto {
  index: number;
  address: number;
  bytes: number;
  blocks: number;
  retries: number;
  ecuMaxBlockLen: number;
  blockLen: number;
  durationMs: number;
  throughputBytesPerSec: number;
  exitResponse: number[];
}

export interface FlashReportDto {
  segments: SegmentReportDto[];
  totalBytes: number;
  totalBlocks: number;
  totalRetries: number;
  durationMs: number;
  throughputBytesPerSec: number;
}

export type FlashErrorKind =
  | 'invalidConfig'
  | 'invalidImage'
  | 'negativeResponse'
  | 'timeout'
  | 'transport'
  | 'counterMismatch'
  | 'malformedResponse'
  | 'cancelled';

export interface FlashErrorDto {
  kind: FlashErrorKind;
  phase: FlashPhase;
  segmentIndex: number | null;
  address: number | null;
  offset: number | null;
  blockCounter: number | null;
  lastNrc: number | null;
  lastNrcName: string | null;
  diagCode: string | null;
  bytesDone: number;
  segmentsCompleted: number;
  message: string;
}

/** `cmd_flash_load_image` arguments. `format: 'auto'` lets the backend sniff the file. */
export interface FlashLoadImageArgs {
  fileName: string;
  format: FirmwareFormat | 'auto';
  /** Binary only; 0 otherwise. */
  baseAddress: number;
  dataBase64: string;
}

export const FLASH_ERROR_KINDS: readonly FlashErrorKind[] = [
  'invalidConfig',
  'invalidImage',
  'negativeResponse',
  'timeout',
  'transport',
  'counterMismatch',
  'malformedResponse',
  'cancelled',
];

export const FLASH_PHASES: readonly FlashPhase[] = ['requestDownload', 'transfer', 'exit', 'done'];
