import type { BusHealthDto } from './hal';

export type CycleHealthKind = 'nominal' | 'jitterWarning' | 'timeout' | 'unconfigured';

export interface LiveSignalDto {
  signalId: number;
  rawInt: number;
  physicalValue: number;
  activeInLastFrame: boolean;
  outOfRange: boolean;
  ageMs: number;
}

export interface FrameTelemetryDto {
  busId: number;
  messageKey: string;
  arbId: number;
  isExtended: boolean;
  isFd: boolean;
  isBrs: boolean;
  isTx: boolean;
  hasHwTimestamp: boolean;
  dlc: number;
  rawBytes: number[];
  changedBytesLo: number; // Bits 0..31 (bytes 0..31 changed in last 300ms)
  changedBytesHi: number; // Bits 32..63 (bytes 32..63 changed in last 300ms)
  lastTimestampUs: number;
  cycleMs: number;
  frequencyHz: number;
  cycleHealth: CycleHealthKind;
  rxCount: number;
  activeMuxSwitches: Record<string, number>;
  signals: LiveSignalDto[];
}

export interface ChronologicalFrameDto {
  timestampUs: number;
  busId: number;
  messageKey: string;
  arbId: number;
  isExtended: boolean;
  isFd: boolean;
  isTx: boolean;
  dlc: number;
  rawBytes: number[];
}

export interface TelemetrySnapshotDto {
  seq: number;
  timestampUs: number;
  fpsRx: number;
  fpsTx: number;
  estimatedBusLoadPct: number;
  totalFramesRx: number;
  totalFramesTx: number;
  droppedFrames: number;
  activeIdsCount: number;
  decodedSignalsCount: number;
  txPanicLatched: boolean;
  buses: BusHealthDto[];
  frames: FrameTelemetryDto[];
  recentChronological: ChronologicalFrameDto[];
}

export interface PanicStopResultDto {
  stoppedPeriodicJobs: number;
  disarmedBuses: number;
  timestampUs: number;
}

export interface TxTransmitResultDto {
  jobId: number | null;
  encodedDlc: number;
  encodedBytes: number[];
  clampedSignals: number[];
}

export interface PeriodicTxJobDto {
  jobId: number;
  label: string;
  busId: number;
  messageKey: string;
  arbId: number;
  isExtended: boolean;
  isFd: boolean;
  dlc: number;
  rawBytes: number[];
  intervalMs: number;
  sentCount: number;
}
