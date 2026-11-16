/**
 * `cmd_diag_*` UDS client IPC contract (D-003 v1).
 * Mirror of `crates/nexus-protocols/src/uds/dto.rs` — keep in sync.
 * Full contract: `planning/contracts/uds-client-d003-v1.md`.
 */

/** ISO 15765-2 address format (mirror of `AddressFormatDto`, camelCase on the wire). */
export type AddressFormat = 'normal' | 'normalFixed' | 'extended' | 'mixed';

export const ADDRESS_FORMATS: readonly AddressFormat[] = ['normal', 'normalFixed', 'extended', 'mixed'];

/** Superset of the existing HMI `DiagSessionConfig` (extra fields optional). */
export interface DiagSessionConfigDto {
  busId: number;
  requestId: number;
  responseId: number;
  isExtendedId: boolean;
  protocol?: string | null;
  /** Functional request id (e.g. 0x7DF). */
  functionalId?: number | null;
  useFd?: boolean;
  /** ISO-TP padding byte, `null` = no padding. Default 0xAA. */
  padding?: number | null;
  /** Added to ECU-reported P2 (ms). Default 100. */
  p2MarginMs?: number;
  /** Default 'normal'. */
  addressFormat?: AddressFormat;
  /** u8: N_TA (`extended`) / N_AE (`mixed`). */
  targetAddress?: number | null;
  /** u8: expected first byte of ECU frames (`extended` required, `mixed` defaults to target). */
  responseAddress?: number | null;
}

export type UdsAddressing = 'physical' | 'functional';

/** Who issued a diagnostic transaction (Diagnostics Traffic Dock filter / column). */
export type DiagOrigin = 'console' | 'did' | 'dtc' | 'pids' | 'panel' | 'flow' | 'session' | 'keepalive' | 'other';

export const DIAG_ORIGINS: readonly DiagOrigin[] = [
  'console', 'did', 'dtc', 'pids', 'panel', 'flow', 'session', 'keepalive', 'other',
];

export interface UdsRequestOptionsDto {
  addressing?: UdsAddressing | null;
  timeoutMs?: number | null;
  origin?: DiagOrigin | null;
  /** 0x21 busyRepeatRequest retries, 0..10 (null/0 = off). */
  busyRetryMax?: number | null;
  /** Delay before each retry, 10..5000 ms (backend default 50). */
  busyRetryDelayMs?: number | null;
}

/** A 0x7F negative response is a successful transport result with `positive = false`. */
export interface UdsResponseDto {
  /** Full response PDU, e.g. [0x62, 0xF1, 0x90, ...]; empty if suppressed. */
  raw: number[];
  positive: boolean;
  suppressed: boolean;
  nrc: number | null;
  nrcName: string | null;
  responsePendingCount: number;
  elapsedUs: number;
  transactionSeq: number;
  /** 0x21 retries made (0 = answered on the first attempt). Absent on an older backend. */
  busyRetryCount?: number;
}

export interface DidReadResultDto {
  did: number;
  /** Data record only (without 0x62 and the DID bytes). */
  raw: number[];
  decoded: string;
  transactionSeq: number;
}

export interface DtcEntryDto {
  /** e.g. "P0123-45" */
  code: string;
  raw: number;
  statusByte: number;
  isConfirmed: boolean;
  isPending: boolean;
  isMilOn: boolean;
  description?: string | null;
}

export type ConversationEventKind =
  | 'request'
  | 'response'
  | 'response_pending'
  | 'timeout'
  | 'tx_blocked'
  | 'transport_error'
  | 'stale_response_dropped'
  | 'keepalive_sent'
  | 'session_closed';

export interface ConversationEventDto {
  seq: number;
  timestampUs: number;
  kind: ConversationEventKind;
  addressing: UdsAddressing;
  sid: number | null;
  bytes: number[];
  requestSeq: number | null;
  elapsedUs: number | null;
  nrc: number | null;
  detail: string | null;
  origin: DiagOrigin;
  /** `request` events of a 0x21 retry: 1..=10. Null / absent for first attempts. */
  retryIndex?: number | null;
}

export interface ConversationPageDto {
  events: ConversationEventDto[];
  lastSeq: number;
  truncated: boolean;
}

export interface DiagSessionInfoDto {
  config: DiagSessionConfigDto;
  open: boolean;
  activeSession: number;
  unlockedLevel: number | null;
  testerPresentEnabled: boolean;
  testerPresentIntervalMs: number;
  p2ServerMs: number | null;
  p2StarServerMs: number | null;
  lastSeq: number;
}

export type DiagErrorCode =
  | 'invalid_input'
  | 'bus_not_connected'
  | 'listen_only'
  | 'disarmed'
  | 'panic_latched'
  | 'timeout_p2'
  | 'timeout_p2_star'
  | 'timeout_isotp'
  | 'isotp_error'
  | 'busy'
  | 'session_closed'
  | 'unexpected_response'
  | 'negative_response'
  | 'internal';

export interface DiagErrorDto {
  code: DiagErrorCode;
  message: string;
}

/** Functional-address ECU discovery (`cmd_diag_discover_ecus`). Needs an armed bus, NOT an open session. */
export interface EcuDiscoveryRequestDto {
  busId: number;
  isExtendedId: boolean;
  functionalId: number;
  /** Request PDU sent to the functional id (single frame, not suppressed). Default [0x3E, 0x00]. */
  requestPdu?: number[] | null;
  /** Listen window, default 300, 50..5000. */
  windowMs?: number | null;
  /** Response filter id (null: 11-bit 0x7E8 / 29-bit 0x18DAF100). */
  responseId?: number | null;
  /** Response filter mask (null: 11-bit 0x7F8 / 29-bit 0x1FFFFF00). */
  responseMask?: number | null;
  /** ISO-TP padding, default 0xAA. */
  padding?: number | null;
  useFd?: boolean;
  identify?: boolean;
  /** Replaces `responseId` / `responseMask` (mutually exclusive). 1..32 entries, `id & ~mask == 0`. */
  responseIdFilters?: IdFilterDto[] | null;
  /** How the physical request id is derived from a response id (null: backend default per id width). */
  requestIdRule?: RequestIdRuleDto | null;
  addressFormat?: AddressFormat;
  targetAddress?: number | null;
  responseAddress?: number | null;
}

/** CAN id acceptance filter: `(arbId & mask) == id`. */
export interface IdFilterDto {
  id: number;
  mask: number;
}

export type RequestIdRuleDto =
  | { kind: 'legislatedMinus8' }
  | { kind: 'offset'; delta: number }
  | { kind: 'normalFixedSwap' }
  | { kind: 'none' };

export interface DiscoveredEcuDto {
  responseId: number;
  requestId: number | null;
  isExtendedId: boolean;
  positive: boolean;
  nrc: number | null;
  nrcName: string | null;
  pending: boolean;
  raw: number[];
  multiFrame: boolean;
  firstResponseUs: number;
  responseCount: number;
  vin: string | null;
  serialNumber: string | null;
  partNumber: string | null;
  identifyError: string | null;
}

export interface EcuDiscoveryResultDto {
  requestBytes: number[];
  functionalId: number;
  isExtendedId: boolean;
  windowMs: number;
  txTimestampUs: number;
  ecus: DiscoveredEcuDto[];
  ignoredFrames: number;
  /** More distinct responders than the backend cap (surplus not listed). Absent on an older backend. */
  truncated?: boolean;
  droppedEcus?: number;
}

// ─── ReadDTCInformation (0x19) report-type reader (`cmd_diag_read_dtc_report`) ──

export interface DtcSnapshotIdDto {
  dtc: number;
  code: string;
  recordNumber: number;
}

export interface DtcSnapshotRecordDto {
  recordNumber: number;
  numberOfIdentifiers: number;
  firstDid: number | null;
  singleDidData: number[] | null;
  /** Bytes from `recordNumber` to the end of the PDU (DID lengths need ODX). */
  raw: number[];
}

export type ReadDtcReportDto =
  | {
      kind: 'count';
      subFunction: number;
      availabilityMask: number;
      formatIdentifier: number;
      formatName: string | null;
      count: number;
    }
  | { kind: 'list'; subFunction: number; availabilityMask: number; dtcs: DtcEntryDto[] }
  | { kind: 'snapshotIdentification'; records: DtcSnapshotIdDto[] }
  | { kind: 'snapshotRecord'; dtc: DtcEntryDto; record: DtcSnapshotRecordDto | null }
  | { kind: 'extData'; dtc: DtcEntryDto; firstRecordNumber: number | null; raw: number[] };

export interface DtcReportResultDto {
  response: UdsResponseDto;
  report: ReadDtcReportDto | null;
  reportError: string | null;
}

// ─── Passive discovery (Listen-Only safe, transmits nothing) ───────────────

export type PassiveConfidence = 'low' | 'medium' | 'high';

export interface PassiveEcuPairDto {
  busId: number;
  requestId: number;
  responseId: number;
  isExtendedId: boolean;
  evidenceCount: number;
  firstSeenUs: number;
  lastSeenUs: number;
  sidsSeen: number[];
  confidence: PassiveConfidence;
  flowControlSeen: boolean;
  functionalRequest: boolean;
}

export interface PassiveDiscoverySnapshotDto {
  busId: number;
  running: boolean;
  stopReason: string | null;
  startedAtUs: number;
  framesAnalyzed: number;
  framesDropped: number;
  pairs: PassiveEcuPairDto[];
  truncated: boolean;
  droppedPairs: number;
  maxPairs: number;
  evictedRequests: number;
}

// ─── Physical sweep (ACTIVE: armed, non-Listen-Only bus; blocks until done) ──

export interface IdRangeDto {
  start: number;
  end: number;
}

export interface PhysicalSweepRequestDto {
  busId: number;
  isExtendedId: boolean;
  requestIds?: number[] | null;
  requestIdRange?: IdRangeDto | null;
  /** Default 3E 00. */
  requestPdu?: number[] | null;
  /** Default 20, 5..1000. */
  gapMs?: number | null;
  /** Default 200, 0..5000. */
  tailMs?: number | null;
  responseId?: number | null;
  responseMask?: number | null;
  responseIdFilters?: IdFilterDto[] | null;
  requestIdRule?: RequestIdRuleDto | null;
  /** Default 0xAA. */
  padding?: number | null;
  useFd: boolean;
  addressFormat?: AddressFormat;
  targetAddress?: number | null;
  responseAddress?: number | null;
}

export interface SweepResponderDto {
  responseId: number;
  inFlightRequestId: number;
  latencyUs: number;
}

export interface PhysicalSweepResultDto {
  busId: number;
  isExtendedId: boolean;
  requestBytes: number[];
  gapMs: number;
  tailMs: number;
  total: number;
  sent: number;
  lastRequestId: number | null;
  completed: boolean;
  /** e.g. 'panic_latched' | 'disarmed' | 'bus_not_connected'. */
  abortCode: string | null;
  abortReason: string | null;
  txTimestampUs: number;
  ecus: DiscoveredEcuDto[];
  responders: SweepResponderDto[];
  ignoredFrames: number;
  truncated: boolean;
  droppedEcus: number;
}

export type IsoTpFrameKind = 'single' | 'first' | 'consecutive' | 'flowControl' | 'unknown';

/** One raw ISO-TP CAN frame seen by the diagnostic tap (`data` = whole CAN payload incl. PCI / padding). */
export interface IsoTpFrameDto {
  seq: number;
  timestampUs: number;
  canId: number;
  isExtended: boolean;
  direction: 'tx' | 'rx';
  fd: boolean;
  data: number[];
  kind: IsoTpFrameKind;
  /** Conversation seq of the Request (or KeepaliveSent) event this frame belongs to; null = outside any exchange. */
  requestSeq: number | null;
}

export interface IsoTpFramePageDto {
  frames: IsoTpFrameDto[];
  lastSeq: number;
  truncated: boolean;
  dropped: number;
}

/** Command names + argument shapes (Tauri `invoke` and bridge `POST /api/invoke/{cmd}`). */
export interface DiagCommandMap {
  cmd_diag_open_session: { args: { config: DiagSessionConfigDto }; result: DiagSessionInfoDto };
  cmd_diag_close_session: { args: { config: DiagSessionConfigDto }; result: null };
  cmd_diag_session_info: { args: { config: DiagSessionConfigDto }; result: DiagSessionInfoDto };
  cmd_diag_send_uds: {
    args: {
      config: DiagSessionConfigDto;
      sid: number;
      subFunction: number | null;
      data: number[];
      options?: UdsRequestOptionsDto | null;
    };
    result: UdsResponseDto;
  };
  cmd_diag_read_did: {
    args: { config: DiagSessionConfigDto; did: number; origin?: DiagOrigin | null };
    result: DidReadResultDto;
  };
  cmd_diag_read_stored_dtcs: {
    args: { config: DiagSessionConfigDto; statusMask?: number | null; origin?: DiagOrigin | null };
    result: DtcEntryDto[];
  };
  cmd_diag_set_tester_present: {
    args: { config: DiagSessionConfigDto; enabled: boolean; intervalMs?: number | null };
    result: DiagSessionInfoDto;
  };
  cmd_diag_get_conversation: {
    args: { config: DiagSessionConfigDto; sinceSeq: number; max?: number | null };
    result: ConversationPageDto;
  };
  cmd_diag_get_isotp_frames: {
    args: { config: DiagSessionConfigDto; sinceSeq: number; max?: number | null };
    result: IsoTpFramePageDto;
  };
  cmd_diag_discover_ecus: { args: { request: EcuDiscoveryRequestDto }; result: EcuDiscoveryResultDto };
  cmd_diag_read_dtc_report: {
    args: {
      config: DiagSessionConfigDto;
      subFunction: number;
      params: number[];
      options?: UdsRequestOptionsDto | null;
    };
    result: DtcReportResultDto;
  };
  cmd_diag_passive_discovery_start: { args: { busId: number }; result: PassiveDiscoverySnapshotDto };
  cmd_diag_passive_discovery_snapshot: { args: { busId: number }; result: PassiveDiscoverySnapshotDto };
  cmd_diag_passive_discovery_stop: { args: { busId: number }; result: PassiveDiscoverySnapshotDto };
  cmd_diag_physical_sweep: { args: { request: PhysicalSweepRequestDto }; result: PhysicalSweepResultDto };
}

const DIAG_ERROR_RE = /^\[diag:([a-z_0-9]+)\]\s*(.*)$/s;
const DIAG_ERROR_CODES: readonly DiagErrorCode[] = [
  'invalid_input', 'bus_not_connected', 'listen_only', 'disarmed', 'panic_latched',
  'timeout_p2', 'timeout_p2_star', 'timeout_isotp', 'isotp_error', 'busy',
  'session_closed', 'unexpected_response', 'negative_response', 'internal',
];

/** Errors arrive as strings `"[diag:<code>] <message>"`. */
export function parseDiagError(raw: unknown): DiagErrorDto | null {
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : null;
  if (text === null) return null;
  const m = DIAG_ERROR_RE.exec(text.trim());
  if (!m) return null;
  const code = DIAG_ERROR_CODES.find((c) => c === m[1]);
  return code ? { code, message: m[2] } : null;
}

/** Narrow runtime normalizer: an older backend omits `origin` -> 'other'. */
export function normalizeOrigin(value: unknown): DiagOrigin {
  return DIAG_ORIGINS.find((o) => o === value) ?? 'other';
}

/** Defensive read of a conversation event (`origin` may be missing until the new backend runs). */
export function normalizeConversationEvent(e: ConversationEventDto): ConversationEventDto {
  const raw: { origin?: unknown } = e;
  const origin = normalizeOrigin(raw.origin);
  return e.origin === origin ? e : { ...e, origin };
}

/** Defensive read of an ISO-TP frame (`requestSeq` may be missing until the new backend runs). */
export function normalizeIsoTpFrame(f: IsoTpFrameDto): IsoTpFrameDto {
  const raw: { requestSeq?: unknown } = f;
  const requestSeq = typeof raw.requestSeq === 'number' ? raw.requestSeq : null;
  return f.requestSeq === requestSeq ? f : { ...f, requestSeq };
}
