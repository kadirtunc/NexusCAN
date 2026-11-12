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
  isBrs?: boolean;
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
  replay?: TraceReplayStatusDto;
}

export type TraceReplayStateKind = 'idle' | 'playing' | 'paused' | 'completed';
export type TraceReplayFilterMode = 'all' | 'include' | 'exclude';
export type TraceReplayDirectionFilter = 'all' | 'rx' | 'tx';

export interface TraceFileSummaryDto {
  fileName: string;
  filePath: string;
  format: 'trc' | 'asc' | 'log' | 'csv' | 'blf' | string;
  sizeBytes: number;
  /** 0 when `statsKnown === false` (not parsed yet); never display as a real count. */
  frameCount: number;
  /** 0 when `statsKnown === false`; never use as a real duration. */
  durationUs: number;
  /**
   * `false` when `cmd_list_traces` did not parse the file body (frameCount/durationUs are
   * placeholders). Save/load/parse results always report `true`. Older backends may omit
   * the field: treat `undefined` as `true`.
   */
  statsKnown?: boolean;
  updatedAt: string;
}

export interface TraceStorageInfoDto {
  tracesDir: string;
  files: TraceFileSummaryDto[];
}

export interface LoadedTraceFileDto {
  summary: TraceFileSummaryDto;
  frames: ChronologicalFrameDto[];
}

export interface TraceReplayStatusDto {
  state: TraceReplayStateKind;
  sourceName: string;
  currentIndex: number;
  totalFrames: number;
  elapsedUs: number;
  durationUs: number;
  speedFactor: number;
  loopPlayback: boolean;
  busOverride: number | null;
  transmitToHardware: boolean;
  filterMode: TraceReplayFilterMode;
  filterKeys: string[];
  directionFilter: TraceReplayDirectionFilter;
  dispatchedFrames: number;
  filteredOutFrames: number;
  hwTxFrames: number;
}

export interface StartTraceReplayArgsDto {
  sourceName: string;
  fileName?: string | null;
  content?: string | null;
  contentBase64?: string | null;
  frames?: ChronologicalFrameDto[] | null;
  speedFactor: number;
  loopPlayback: boolean;
  busOverride?: number | null;
  transmitToHardware?: boolean;
  resetTelemetryFirst?: boolean;
  filterMode?: TraceReplayFilterMode;
  filterKeys?: string[];
  directionFilter?: TraceReplayDirectionFilter;
}

export interface TraceReplayControlArgsDto {
  action: 'pause' | 'resume' | 'stop' | 'seek' | 'configure';
  seekUs?: number;
  speedFactor?: number;
  loopPlayback?: boolean;
  updateBusOverride?: boolean;
  busOverride?: number | null;
  transmitToHardware?: boolean;
  filterMode?: TraceReplayFilterMode;
  updateFilterKeys?: boolean;
  filterKeys?: string[];
  directionFilter?: TraceReplayDirectionFilter;
}

export interface PanicStopResultDto {
  stoppedPeriodicJobs: number;
  disarmedBuses: number;
  timestampUs: number;
  /** Buses whose driver write did not finish within 250 ms (latch is set anyway). Absent on older backends. */
  inFlightTimeoutBuses?: number[];
}

/** `cmd_reset_session`: cold-start reset. Does NOT latch panic; clears the latch. */
export interface ResetSessionResultDto {
  stoppedPeriodicJobs: number;
  disarmedBuses: number;
  disconnectedBuses: number;
  /** Same semantics as `PanicStopResultDto.inFlightTimeoutBuses`. Absent on older backends. */
  inFlightTimeoutBuses?: number[];
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
