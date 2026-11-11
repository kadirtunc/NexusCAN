/**
 * `cmd_diag_*` UDS client IPC contract (D-003 v1).
 * Mirror of `crates/nexus-protocols/src/uds/dto.rs` — keep in sync.
 * Full contract: `planning/contracts/uds-client-d003-v1.md`.
 */

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
}

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
