import { useSyncExternalStore } from 'react';
import { invokeCmd } from '../services/ipcClient';
import { SESSION_LOST_CODES, formatDiagError, toDiagUiError } from '../services/diagErrors';
import { t } from '../i18n';
import type {
  DiagSessionConfig,
  DiagSessionState,
  DiagUiError,
  DidValueEntry,
  DtcEntryDto,
  IsoTpFrameEntry,
  LivePidError,
  LivePidValue,
  UdsExchange,
} from '../types/diagnostics';
import { DID_CATALOG, PID_CATALOG } from '../types/diagnostics';
import { decodeDidValue } from '../services/udsDecode';
import { IsoTpReassembler, isoTpEntryFromDto } from '../services/isoTpDecode';
import {
  normalizeConversationEvent,
  normalizeIsoTpFrame,
  type ConversationEventDto,
  type ConversationEventKind,
  type ConversationPageDto,
  type DiagCommandMap,
  type DiagOrigin,
  type DiagSessionConfigDto,
  type DiagSessionInfoDto,
  type DiscoveredEcuDto,
  type IsoTpFrameDto,
  type IsoTpFrameKind,
  type IsoTpFramePageDto,
  type EcuDiscoveryRequestDto,
  type EcuDiscoveryResultDto,
  type UdsAddressing,
  type UdsResponseDto,
} from '../types/udsClient';

/** One log row: a backend/demo event, or an info note (gap = truncated page, reopened = backend seq restarted). */
export interface ConversationEntry {
  uid: number;
  /** Seq epoch (bumped when the backend session was reopened and its seq restarted). */
  epoch: number;
  event: ConversationEventDto | null;
  note: 'gap' | 'reopened' | null;
}

/** "Resend in Console": prefill for the UDS Console composer (consumed once by `UdsConsole`). */
export interface ConsoleDraft {
  sid: number;
  subFn: number | null;
  data: number[];
  addressing: UdsAddressing;
  nonce: number;
}

interface DiagnosticsState {
  session: DiagSessionState;
  /** Last `DiagSessionInfoDto` from the backend (real mode only). */
  sessionInfo: DiagSessionInfoDto | null;
  connecting: boolean;
  /** DEMO mode: local synthetic data, no `cmd_diag_*` traffic. Default false. */
  mockMode: boolean;
  storedDtcs: DtcEntryDto[];
  pendingDtcs: DtcEntryDto[];
  didValues: Map<number, DidValueEntry>;
  didErrors: Map<number, DiagUiError>;
  livePidValues: Map<number, LivePidValue>;
  /** Real mode: per-PID poll failures (value in `livePidValues` is then stale). */
  livePidErrors: Map<number, LivePidError>;
  activePids: Set<number>;
  pidPollingMs: number;
  /** Chronological (oldest first), bounded to MAX_CONVERSATION. Real: backend log; demo: local DEMO events. */
  conversation: ConversationEntry[];
  lastUds: UdsExchange | null;
  /** Chronological (oldest first), bounded to MAX_ISOTP_FRAMES. Real: backend tap; demo: DEMO frames. */
  isotpFrames: IsoTpFrameEntry[];
  /** Pending "Resend in Console" prefill (null = none). */
  consoleDraft: ConsoleDraft | null;
  isScanning: boolean;
  isPolling: boolean;
  lastError: DiagUiError | null;
  /** Last functional ECU discovery result (real: `cmd_diag_discover_ecus`; demo: DEMO-only synthetic). */
  discovery: EcuDiscoveryResultDto | null;
  discovering: boolean;
  /** Discovery errors are kept apart from `lastError`: a failed scan must never imply a lost UDS session. */
  discoveryError: DiagUiError | null;
}

const DEFAULT_CONFIG: DiagSessionConfig = {
  requestId: 0x7e0,
  responseId: 0x7e8,
  busId: 0,
  isExtendedId: false,
  protocol: 'uds',
};

const INITIAL_STATE: DiagnosticsState = {
  session: {
    connected: false,
    config: DEFAULT_CONFIG,
    udsSession: 'default',
    testerPresentActive: false,
    lastResponseMs: null,
  },
  sessionInfo: null,
  connecting: false,
  mockMode: false,
  storedDtcs: [],
  pendingDtcs: [],
  didValues: new Map(),
  didErrors: new Map(),
  livePidValues: new Map(),
  livePidErrors: new Map(),
  activePids: new Set(),
  pidPollingMs: 500,
  conversation: [],
  lastUds: null,
  isotpFrames: [],
  consoleDraft: null,
  isScanning: false,
  isPolling: false,
  lastError: null,
  discovery: null,
  discovering: false,
  discoveryError: null,
};

const MOCK_STORED_DTCS: DtcEntryDto[] = [
  {
    code: 'P0100',
    raw: 0x000100,
    statusByte: 0x0c,
    isConfirmed: true,
    isPending: false,
    isMilOn: true,
    description: 'Mass Air Flow Sensor Circuit Malfunction',
  },
  {
    code: 'P0300',
    raw: 0x000300,
    statusByte: 0x04,
    isConfirmed: false,
    isPending: true,
    isMilOn: false,
    description: 'Random/Multiple Cylinder Misfire Detected',
  },
];

let pollingIntervalId: ReturnType<typeof setInterval> | null = null;
let pollingTickCount = 0;
let mockSpeedAccum = 0;

function toHex(n: number, width = 2): string {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

function makeMockDidValue(did: number): DidValueEntry {
  const ascii = (text: string): number[] => Array.from(text).map((c) => c.charCodeAt(0));
  let bytes: number[];
  switch (did) {
    case 0xf190:
      bytes = ascii('WVWZZZ1JZ3W386752');
      break;
    case 0xf186:
      bytes = [0x03];
      break;
    case 0xf188:
      bytes = ascii('SW_v2.3.1');
      break;
    default:
      bytes = [0x01, 0x02, 0x03, 0x04];
  }
  return { did, raw: bytes, decoded: decodeDidValue(did, bytes), timestampMs: Date.now() };
}

let currentState: DiagnosticsState = { ...INITIAL_STATE };
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) {
    fn();
  }
}

function setState(partial: Partial<DiagnosticsState>): void {
  currentState = { ...currentState, ...partial };
  emit();
}

function computeMockPidValue(pid: number, tick: number): number {
  const t = tick / 10;
  switch (pid) {
    case 0x0c:
      return Math.max(600, 850 + Math.sin(t / 5) * 400 + (Math.random() - 0.5) * 50);
    case 0x0d:
      return Math.min(120, Math.max(0, mockSpeedAccum));
    case 0x05:
      return 87 + (Math.random() - 0.5) * 2;
    case 0x11:
      return Math.max(0, Math.min(100, 15 + (Math.random() - 0.5) * 5));
    case 0x04:
      return Math.max(0, Math.min(100, 30 + Math.sin(t / 8) * 20 + (Math.random() - 0.5) * 5));
    case 0x0f:
      return 25 + (Math.random() - 0.5) * 3;
    case 0x10:
      return Math.max(0, 8 + Math.sin(t / 4) * 5 + (Math.random() - 0.5) * 1);
    case 0x2f:
      return 68 + (Math.random() - 0.5) * 1;
    case 0x33:
      return 101 + (Math.random() - 0.5) * 1;
    case 0x42:
      return 12.4 + (Math.random() - 0.5) * 0.2;
    case 0x46:
      return 22 + (Math.random() - 0.5) * 2;
    case 0x5c:
      return 95 + (Math.random() - 0.5) * 3;
    default:
      return Math.random() * 100;
  }
}

function startPollingInternal(): void {
  if (pollingIntervalId !== null) return;
  pollingTickCount = 0;
  mockSpeedAccum = 0;

  pollingIntervalId = setInterval(() => {
    if (!currentState.isPolling) {
      stopPollingInternal();
      return;
    }

    pollingTickCount += 1;
    mockSpeedAccum = Math.min(120, mockSpeedAccum + (Math.random() - 0.3) * 3);
    if (mockSpeedAccum < 0) mockSpeedAccum = 0;

    const nextPidValues = new Map(currentState.livePidValues);
    for (const pid of currentState.activePids) {
      const def = PID_CATALOG.find((p) => p.pid === pid);
      if (!def) continue;
      const physical = computeMockPidValue(pid, pollingTickCount);
      nextPidValues.set(pid, {
        pid,
        rawValue: Math.round(physical),
        physicalValue: physical,
        timestampMs: Date.now(),
      });
    }

    setState({ livePidValues: nextPidValues });
  }, currentState.pidPollingMs);
}

function stopPollingInternal(): void {
  if (pollingIntervalId !== null) {
    clearInterval(pollingIntervalId);
    pollingIntervalId = null;
  }
}

// ─── Real OBD-II live PIDs (service 0x01 via `cmd_diag_send_uds`; strictly sequential) ─────

let pidGen = 0;
let pidTimer: ReturnType<typeof setTimeout> | null = null;

function stopRealPidLoop(): void {
  pidGen += 1; // in-flight results of the old loop are dropped
  if (pidTimer !== null) {
    clearTimeout(pidTimer);
    pidTimer = null;
  }
}

/** Stops any PID polling (demo timer or real loop) and clears `isPolling`. */
function haltPidPolling(): void {
  stopPollingInternal();
  stopRealPidLoop();
  if (currentState.isPolling) setState({ isPolling: false });
}

function pidSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    pidTimer = setTimeout(() => {
      pidTimer = null;
      resolve();
    }, ms);
  });
}

function setPidError(pid: number, err: LivePidError): void {
  const livePidErrors = new Map(currentState.livePidErrors);
  livePidErrors.set(pid, err);
  setState({ livePidErrors });
}

async function pollOnePid(pid: number, gen: number): Promise<void> {
  const def = PID_CATALOG.find((p) => p.pid === pid);
  if (!def) return;
  try {
    const r = await diagInvoke('cmd_diag_send_uds', {
      config: currentDto(),
      sid: 0x01,
      subFunction: null,
      data: [pid],
      options: { addressing: 'physical', timeoutMs: null, origin: 'pids' },
    });
    if (gen !== pidGen) return;
    if (!r.positive) {
      setPidError(pid, { kind: 'nrc', nrc: r.nrc, nrcName: r.nrcName, atMs: Date.now() });
      return;
    }
    const raw = r.raw;
    if (raw.length < 2 + def.bytes || raw[0] !== 0x41 || raw[1] !== pid) {
      setPidError(pid, { kind: 'badResponse', atMs: Date.now() });
      return;
    }
    const physical = def.formula(raw.slice(2, 2 + def.bytes));
    const livePidValues = new Map(currentState.livePidValues);
    livePidValues.set(pid, { pid, rawValue: Math.round(physical), physicalValue: physical, timestampMs: Date.now() });
    const livePidErrors = new Map(currentState.livePidErrors);
    livePidErrors.delete(pid);
    setState({ livePidValues, livePidErrors });
    touchResponse();
  } catch (err) {
    if (gen !== pidGen) return;
    const e = toDiagUiError(err);
    if (e.code === 'backend_missing' || SESSION_LOST_CODES.has(e.code)) {
      haltPidPolling();
      if (currentState.session.connected) markSessionLost(e);
      else setState({ lastError: e });
      return;
    }
    setPidError(pid, { kind: 'transport', error: e, atMs: Date.now() });
  }
}

async function realPidLoop(gen: number): Promise<void> {
  while (gen === pidGen) {
    const roundStart = Date.now();
    for (const pid of Array.from(currentState.activePids)) {
      if (gen !== pidGen) return;
      if (!currentState.activePids.has(pid)) continue;
      await pollOnePid(pid, gen); // one request in flight at a time
    }
    if (gen !== pidGen) return;
    await pidSleep(Math.max(20, currentState.pidPollingMs - (Date.now() - roundStart)));
  }
}

// ─── Transport helpers (real mode: ONLY `cmd_diag_*`) ────────────────────────

export type UdsTransportErrorKind = 'notConnected' | 'backendMissing' | 'failed';

/** Thrown by the strict (never-mock) UDS helpers below. `message` is already localized. */
export class UdsTransportError extends Error {
  readonly kind: UdsTransportErrorKind;
  readonly diag: DiagUiError | null;
  constructor(kind: UdsTransportErrorKind, message: string, diag: DiagUiError | null = null) {
    super(message);
    this.name = 'UdsTransportError';
    this.kind = kind;
    this.diag = diag;
  }
}

function diagInvoke<K extends keyof DiagCommandMap>(
  cmd: K,
  args: DiagCommandMap[K]['args'],
): Promise<DiagCommandMap[K]['result']> {
  return invokeCmd<DiagCommandMap[K]['result']>(cmd, args as unknown as Record<string, unknown>);
}

/** Always send the full, explicit config so the backend session key is stable across calls. */
function toDiagDto(c: DiagSessionConfig): DiagSessionConfigDto {
  return {
    busId: c.busId,
    requestId: c.requestId,
    responseId: c.responseId,
    isExtendedId: c.isExtendedId,
    protocol: c.protocol,
    functionalId: c.functionalId ?? null,
    useFd: c.useFd ?? false,
    padding: c.padding === undefined ? 0xaa : c.padding,
    p2MarginMs: c.p2MarginMs ?? 100,
  };
}

function currentDto(): DiagSessionConfigDto {
  return toDiagDto(currentState.session.config);
}

function mapActiveSession(code: number): DiagSessionState['udsSession'] | null {
  if (code === 0x01) return 'default';
  if (code === 0x02) return 'programming';
  if (code === 0x03) return 'extended';
  return null;
}

const NOT_CONNECTED: DiagUiError = { code: 'not_connected', message: '' };

function nrcText(r: UdsResponseDto): string {
  const code = r.nrc === null ? '??' : `0x${toHex(r.nrc)}`;
  return r.nrcName ? `${r.nrcName} (${code})` : code;
}

// ─── Conversation log (real: polled from backend; demo: local DEMO events) ────

const MAX_CONVERSATION = 2000;
const POLL_INTERVAL_MS = 250; // ~4 Hz
const POLL_ERROR_BACKOFF_MS = 1000;
const INFO_REFRESH_EVERY_TICKS = 8; // ~2 s
const CONVERSATION_PAGE_MAX = 500;

let conversationCursor = 0; // backend `sinceSeq`
let demoSeq = 0;
let exchangeSeq = 0;

let viewRefs = 0;
let pollGen = 0;
let pollRunning = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

let entryUid = 0;
let consoleDraftNonce = 0;
let lastStoredSeq = 0; // highest event seq of the current backend seq epoch
/** Seq epoch: incremented when the backend session was reopened (seq restarts at 1). Joins use (epoch, seq). */
let seqEpoch = 0;

function pushEntries(entries: ConversationEntry[]): void {
  if (entries.length === 0) return;
  let conversation = currentState.conversation.concat(entries);
  if (conversation.length > MAX_CONVERSATION) {
    conversation = conversation.slice(conversation.length - MAX_CONVERSATION);
  }
  setState({ conversation });
}

function appendEvents(events: readonly ConversationEventDto[], gapBefore: boolean): void {
  const fresh = events.filter((e) => e.seq > lastStoredSeq);
  if (fresh.length === 0) return;
  const entries: ConversationEntry[] = [];
  if (gapBefore) entries.push({ uid: ++entryUid, epoch: seqEpoch, event: null, note: 'gap' });
  for (const raw of fresh) {
    entries.push({ uid: ++entryUid, epoch: seqEpoch, event: normalizeConversationEvent(raw), note: null });
  }
  lastStoredSeq = fresh[fresh.length - 1].seq;
  pushEntries(entries);
}

/**
 * Backend session was reopened (Panic, config change, closed tap): its seq restarts at 1.
 * Keep the old log, add a note, restart the cursor.
 */
function resetSeqEpoch(): void {
  conversationCursor = 0;
  lastStoredSeq = 0;
  seqEpoch += 1;
  pushEntries([{ uid: ++entryUid, epoch: seqEpoch, event: null, note: 'reopened' }]);
}

/** Returns false when the page belonged to a restarted seq epoch (caller re-fetches from 0). */
function applyConversationPage(page: ConversationPageDto): boolean {
  if (page.lastSeq < conversationCursor) {
    resetSeqEpoch();
    return false;
  }
  appendEvents(page.events, page.truncated);
  conversationCursor = Math.max(conversationCursor, page.lastSeq);
  return true;
}

/** DEMO-only synthetic event. Never called in real mode. */
function demoEvent(
  kind: ConversationEventKind,
  fields: Partial<Omit<ConversationEventDto, 'seq' | 'kind'>> = {},
): number {
  demoSeq += 1;
  appendEvents(
    [
      {
        seq: demoSeq,
        timestampUs: Date.now() * 1000,
        origin: 'other',
        kind,
        addressing: 'physical',
        sid: null,
        bytes: [],
        requestSeq: null,
        elapsedUs: null,
        nrc: null,
        detail: null,
        ...fields,
      },
    ],
    false,
  );
  return demoSeq;
}

/** DEMO-only synthetic ISO-TP tap frames for one demo exchange (SF, or FF + FC + CF*). Never used in real mode. */
let demoFrameSeq = 0;
const DEMO_PAD = 0xaa;

function demoFrameData(pci: readonly number[], payload: readonly number[]): number[] {
  const out = [...pci, ...payload];
  while (out.length < 8) out.push(DEMO_PAD);
  return out;
}

function demoPushFrame(
  dir: 'tx' | 'rx',
  kind: IsoTpFrameKind,
  data: number[],
  requestSeq: number,
  timestampUs: number,
): void {
  const cfg = currentState.session.config;
  const dto: IsoTpFrameDto = {
    seq: ++demoFrameSeq,
    timestampUs,
    canId: dir === 'tx' ? cfg.requestId : cfg.responseId,
    isExtended: cfg.isExtendedId,
    direction: dir,
    fd: false,
    data,
    kind,
    requestSeq,
  };
  pushIsoTpEntries([isoTpEntryFromDto(dto, ++isotpUid, seqEpoch, isotpReassembler)]);
}

/** Request SF (tx) at `reqTsUs`; response as SF (rx) or FF + FC(CTS, BS=0, STmin=2 ms) + CF* ending at `rspTsUs`. */
function demoIsoTpExchange(
  requestSeq: number,
  request: readonly number[],
  response: readonly number[],
  reqTsUs: number,
  rspTsUs: number,
): void {
  demoPushFrame('tx', 'single', demoFrameData([request.length & 0x0f], request), requestSeq, reqTsUs + 120);
  if (response.length <= 7) {
    demoPushFrame('rx', 'single', demoFrameData([response.length & 0x0f], response), requestSeq, rspTsUs - 80);
    return;
  }
  const cfCount = Math.ceil((response.length - 6) / 7);
  const gapUs = 2_300; // above the demo STmin (2 ms)
  const ffTs = rspTsUs - 400 - cfCount * gapUs;
  demoPushFrame(
    'rx',
    'first',
    [0x10 | ((response.length >> 8) & 0x0f), response.length & 0xff, ...response.slice(0, 6)],
    requestSeq,
    ffTs,
  );
  demoPushFrame('tx', 'flowControl', demoFrameData([0x30, 0x00, 0x02], []), requestSeq, ffTs + 400);
  for (let i = 0; i < cfCount; i += 1) {
    const chunk = response.slice(6 + i * 7, 6 + (i + 1) * 7);
    demoPushFrame(
      'rx',
      'consecutive',
      demoFrameData([0x20 | ((i + 1) & 0x0f)], chunk),
      requestSeq,
      ffTs + 400 + (i + 1) * gapUs,
    );
  }
}

// ─── Session info / loss handling ─────────────────────────────────────────────

function markSessionLost(err: DiagUiError): void {
  stopConversationPolling();
  haltPidPolling();
  setState({
    session: { ...currentState.session, connected: false, testerPresentActive: false },
    sessionInfo: null,
    lastError: err,
  });
}

/** `info.open` is deliberately NOT used for the connected state (backend may report false); errors decide. */
function applyInfo(info: DiagSessionInfoDto): void {
  if (info.lastSeq < conversationCursor) resetSeqEpoch();
  setState({
    sessionInfo: info,
    session: {
      ...currentState.session,
      testerPresentActive: info.testerPresentEnabled,
      udsSession: mapActiveSession(info.activeSession) ?? currentState.session.udsSession,
    },
  });
}

async function refreshSessionInfo(gen?: number): Promise<void> {
  if (currentState.mockMode || !currentState.session.connected) return;
  const info = await diagInvoke('cmd_diag_session_info', { config: currentDto() });
  if (gen !== undefined && gen !== pollGen) return;
  if (!currentState.session.connected) return;
  applyInfo(info);
}

/** After a user command: refresh session info in the background (poll loop reports real faults). */
function refreshSessionInfoSoon(): void {
  void refreshSessionInfo().catch(() => undefined);
}

/** Central handler for a failed real command. */
function handleCommandError(err: unknown): DiagUiError {
  const e = toDiagUiError(err);
  setState({ lastError: e });
  if (SESSION_LOST_CODES.has(e.code) && currentState.session.connected && !currentState.mockMode) {
    markSessionLost(e);
  }
  return e;
}

function touchResponse(): void {
  setState({ session: { ...currentState.session, lastResponseMs: Date.now() } });
}

// ─── Conversation polling (~4 Hz; only while connected AND a Diagnostics view is mounted) ──

function pollSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    pollTimer = setTimeout(() => {
      pollTimer = null;
      resolve();
    }, ms);
  });
}

// ─── ISO-TP frame tap (real: polled with the conversation; never fabricated) ───

const MAX_ISOTP_FRAMES = 4096;
const ISOTP_PAGE_MAX = 500;
let isotpCursor = 0;
let isotpLastStored = 0;
let isotpUid = 0;
let isotpUnavailable = false; // backend command missing: stop asking until the next connect
const isotpReassembler = new IsoTpReassembler();

function resetIsoTpTap(): void {
  isotpCursor = 0;
  isotpLastStored = 0;
  isotpUnavailable = false;
  isotpReassembler.reset();
}

/** Appends chronologically (oldest first) and trims the oldest rows beyond the cap. */
function pushIsoTpEntries(entries: IsoTpFrameEntry[]): void {
  if (entries.length === 0) return;
  let isotpFrames = currentState.isotpFrames.concat(entries);
  if (isotpFrames.length > MAX_ISOTP_FRAMES) isotpFrames = isotpFrames.slice(isotpFrames.length - MAX_ISOTP_FRAMES);
  setState({ isotpFrames });
}

function applyIsoTpPage(page: IsoTpFramePageDto): void {
  if (page.lastSeq < isotpCursor) {
    // Backend session reopened (seq restarted at 1): keep the old rows, restart the cursor.
    isotpCursor = 0;
    isotpLastStored = 0;
    isotpReassembler.reset();
    return;
  }
  if (page.truncated || page.dropped > 0) isotpReassembler.reset(); // gap: partial multi-frame state is invalid
  const fresh: IsoTpFrameDto[] = page.frames
    .filter((f: IsoTpFrameDto) => f.seq > isotpLastStored)
    .map(normalizeIsoTpFrame);
  if (fresh.length > 0) {
    const entries = fresh.map((f) => isoTpEntryFromDto(f, ++isotpUid, seqEpoch, isotpReassembler));
    isotpLastStored = fresh[fresh.length - 1].seq;
    pushIsoTpEntries(entries);
  }
  isotpCursor = Math.max(isotpCursor, page.lastSeq);
}

async function pollIsoTp(gen: number): Promise<void> {
  if (isotpUnavailable) return;
  try {
    const page = await diagInvoke('cmd_diag_get_isotp_frames', {
      config: currentDto(),
      sinceSeq: isotpCursor,
      max: ISOTP_PAGE_MAX,
    });
    if (gen !== pollGen) return;
    applyIsoTpPage(page);
  } catch (err) {
    if (gen !== pollGen) return;
    // A missing / failing frame tap must never tear down the UDS session: just stop asking.
    if (toDiagUiError(err).code === 'backend_missing') isotpUnavailable = true;
  }
}

async function pollLoop(gen: number): Promise<void> {
  let tick = 0;
  while (gen === pollGen) {
    let delay = POLL_INTERVAL_MS;
    try {
      const page = await diagInvoke('cmd_diag_get_conversation', {
        config: currentDto(),
        sinceSeq: conversationCursor,
        max: CONVERSATION_PAGE_MAX,
      });
      if (gen !== pollGen) return;
      if (!applyConversationPage(page)) continue; // seq restarted: re-fetch from 0 immediately
      await pollIsoTp(gen);
      if (gen !== pollGen) return;
      tick += 1;
      if (tick % INFO_REFRESH_EVERY_TICKS === 0) await refreshSessionInfo(gen);
    } catch (err) {
      if (gen !== pollGen) return;
      const e = toDiagUiError(err);
      if (e.code === 'backend_missing' || SESSION_LOST_CODES.has(e.code)) {
        markSessionLost(e);
        return;
      }
      setState({ lastError: e });
      delay = POLL_ERROR_BACKOFF_MS;
    }
    if (gen !== pollGen) return;
    await pollSleep(delay);
  }
}

function startConversationPolling(): void {
  if (pollRunning) return;
  pollRunning = true;
  pollGen += 1;
  void pollLoop(pollGen);
}

function stopConversationPolling(): void {
  pollRunning = false;
  pollGen += 1; // in-flight results of the old loop are dropped
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function syncConversationPolling(): void {
  const want = !currentState.mockMode && currentState.session.connected && viewRefs > 0;
  if (want) startConversationPolling();
  else stopConversationPolling();
}


// ─── ECU discovery (DEMO-only synthetic result) ──────────────────────────────

function makeMockDiscovery(req: EcuDiscoveryRequestDto): EcuDiscoveryResultDto {
  const requestBytes = req.requestPdu && req.requestPdu.length > 0 ? [...req.requestPdu] : [0x3e, 0x00];
  const reqSid = requestBytes[0];
  const positiveRaw: number[] = [(reqSid + 0x40) & 0xff, ...requestBytes.slice(1)];
  const ids: Array<{ resp: number; reqId: number }> = req.isExtendedId
    ? [
        { resp: 0x18daf100, reqId: 0x18da00f1 },
        { resp: 0x18daf110, reqId: 0x18da10f1 },
        { resp: 0x18daf11e, reqId: 0x18da1ef1 },
      ]
    : [
        { resp: 0x7e8, reqId: 0x7e0 },
        { resp: 0x7e9, reqId: 0x7e1 },
        { resp: 0x7eb, reqId: 0x7e3 },
      ];
  const ecus: DiscoveredEcuDto[] = ids.map((id, i) => {
    const negative = i === 2;
    return {
      responseId: id.resp,
      requestId: id.reqId,
      isExtendedId: req.isExtendedId,
      positive: !negative,
      nrc: negative ? 0x12 : null,
      nrcName: negative ? 'subFunctionNotSupported' : null,
      pending: false,
      raw: negative ? [0x7f, reqSid, 0x12] : positiveRaw,
      multiFrame: false,
      firstResponseUs: 1_200 + i * 850,
      responseCount: 1,
      vin: req.identify && !negative ? 'DEMO0ECUSIM000001' : null,
      serialNumber: req.identify && !negative ? `DEMO-SN-${1000 + i}` : null,
      partNumber: req.identify && !negative ? `DEMO-PN-${i + 1}` : null,
      identifyError: req.identify && negative ? 'NRC 0x31 requestOutOfRange (DEMO)' : null,
    };
  });
  return {
    requestBytes,
    functionalId: req.functionalId,
    isExtendedId: req.isExtendedId,
    windowMs: req.windowMs ?? 300,
    txTimestampUs: Date.now() * 1000,
    ecus,
    ignoredFrames: 2,
  };
}

// ─── Public store ─────────────────────────────────────────────────────────────

export const diagnosticsStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getState(): DiagnosticsState {
    return currentState;
  },

  /**
   * A Diagnostics view mounted: conversation polling may run while connected.
   * Returns the detach function (call on unmount).
   */
  attachView(): () => void {
    viewRefs += 1;
    syncConversationPolling();
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      viewRefs = Math.max(0, viewRefs - 1);
      syncConversationPolling();
    };
  },

  async connect(config: DiagSessionConfig): Promise<void> {
    if (currentState.connecting || currentState.session.connected) return;

    if (currentState.mockMode) {
      setState({
        session: { connected: true, config, udsSession: 'default', testerPresentActive: false, lastResponseMs: Date.now() },
        isotpFrames: [],
        conversation: [],
              lastError: null,
      });
      return;
    }

    setState({ connecting: true, lastError: null, session: { ...currentState.session, config } });
    try {
      const info = await diagInvoke('cmd_diag_open_session', { config: toDiagDto(config) });
      conversationCursor = info.lastSeq;
      lastStoredSeq = info.lastSeq;
      resetIsoTpTap();
      setState({
        connecting: false,
        session: {
          connected: true,
          config,
          udsSession: mapActiveSession(info.activeSession) ?? 'default',
          testerPresentActive: info.testerPresentEnabled,
          lastResponseMs: null,
        },
        sessionInfo: info,
        isotpFrames: [],
        livePidValues: new Map(),
        livePidErrors: new Map(),
        conversation: [],
              lastError: null,
      });
      syncConversationPolling();
    } catch (err) {
      setState({ connecting: false, lastError: toDiagUiError(err) });
    }
  },

  async disconnect(): Promise<void> {
    const wasMock = currentState.mockMode;
    const wasConnected = currentState.session.connected;
    const config = currentDto();
    stopConversationPolling();
    haltPidPolling();
    setState({
      session: { ...currentState.session, connected: false, testerPresentActive: false, lastResponseMs: null },
      sessionInfo: null,
      isPolling: false,
    });
    if (wasMock || !wasConnected) return;
    try {
      await diagInvoke('cmd_diag_close_session', { config });
    } catch (err) {
      const e = toDiagUiError(err);
      if (e.code !== 'session_closed') setState({ lastError: e });
    }
  },

  setMockMode(v: boolean): void {
    if (v === currentState.mockMode) return;
    if (currentState.session.connected) void diagnosticsStore.disconnect();
    haltPidPolling();
    conversationCursor = 0;
    lastStoredSeq = 0;
    resetIsoTpTap();
    setState({
      mockMode: v,
      sessionInfo: null,
      storedDtcs: [],
      pendingDtcs: [],
      didValues: new Map(),
      didErrors: new Map(),
      livePidValues: new Map(),
      livePidErrors: new Map(),
      isPolling: false,
      conversation: [],
          lastUds: null,
      isotpFrames: [],
      lastError: null,
      discovery: null,
      discoveryError: null,
    });
  },

  updateConfig(config: DiagSessionConfig): void {
    setState({ session: { ...currentState.session, config } });
  },

  clearError(): void {
    if (currentState.lastError !== null) setState({ lastError: null });
  },

  /** DiagnosticSessionControl (0x10). Real mode: session state comes back via `DiagSessionInfoDto`. */
  async setUdsSession(udsSession: DiagSessionState['udsSession']): Promise<void> {
    const subFn = udsSession === 'default' ? 0x01 : udsSession === 'extended' ? 0x03 : 0x02;
    if (currentState.mockMode) {
      setState({ session: { ...currentState.session, udsSession } });
    }
    await diagnosticsStore.sendUds(0x10, subFn, [], 'physical', 'session');
  },

  /** TesterPresent background keep-alive (`3E 80`). Real: `cmd_diag_set_tester_present`. */
  async setTesterPresent(active: boolean, intervalMs: number | null = null): Promise<void> {
    if (!currentState.session.connected) {
      setState({ lastError: NOT_CONNECTED });
      return;
    }
    if (currentState.mockMode) {
      setState({ session: { ...currentState.session, testerPresentActive: active } });
      demoEvent('keepalive_sent', { sid: 0x3e, bytes: [0x3e, 0x80], detail: active ? 'DEMO on' : 'DEMO off', origin: 'keepalive' });
      return;
    }
    try {
      const info = await diagInvoke('cmd_diag_set_tester_present', {
        config: currentDto(),
        enabled: active,
        intervalMs,
      });
      if (currentState.session.connected) applyInfo(info);
    } catch (err) {
      handleCommandError(err);
    }
  },

  /**
   * Functional ECU discovery. Needs an armed bus, NOT an open UDS session. Demo mode returns a
   * deterministic synthetic result (marked DEMO in the UI); real mode never fabricates data.
   */
  async discoverEcus(req: EcuDiscoveryRequestDto): Promise<EcuDiscoveryResultDto | null> {
    if (currentState.discovering) return null;
    setState({ discovering: true, discoveryError: null });
    if (currentState.mockMode) {
      await new Promise<void>((r) => setTimeout(r, 400));
      const discovery = makeMockDiscovery(req);
      setState({ discovering: false, discovery });
      return discovery;
    }
    try {
      const discovery = await diagInvoke('cmd_diag_discover_ecus', { request: req });
      setState({ discovering: false, discovery });
      return discovery;
    } catch (err) {
      setState({ discovering: false, discoveryError: toDiagUiError(err) });
      return null;
    }
  },

  clearDiscovery(): void {
    setState({ discovery: null, discoveryError: null });
  },

  async scanDtcs(): Promise<void> {
    if (!currentState.session.connected) {
      setState({ lastError: NOT_CONNECTED });
      return;
    }
    setState({ isScanning: true, lastError: null });

    if (currentState.mockMode) {
      const reqBytes = [0x19, 0x02, 0xff];
      const reqTs = Date.now() * 1000;
      const reqSeq = demoEvent('request', { sid: 0x19, bytes: reqBytes, origin: 'dtc', timestampUs: reqTs });
      await new Promise<void>((r) => setTimeout(r, 600));
      setState({
        storedDtcs: MOCK_STORED_DTCS.filter((d) => d.isConfirmed),
        pendingDtcs: MOCK_STORED_DTCS.filter((d) => d.isPending),
        isScanning: false,
        session: { ...currentState.session, lastResponseMs: Date.now() },
      });
      const rspBytes = [0x59, 0x02, 0xff, 0x00, 0x01, 0x00, 0x0c, 0x00, 0x03, 0x00, 0x04];
      const rspTs = Date.now() * 1000;
      demoIsoTpExchange(reqSeq, reqBytes, rspBytes, reqTs, rspTs);
      demoEvent('response', {
        sid: 0x59,
        bytes: rspBytes,
        requestSeq: reqSeq,
        elapsedUs: rspTs - reqTs,
        origin: 'dtc',
        timestampUs: rspTs,
      });
      return;
    }

    try {
      const result = await diagInvoke('cmd_diag_read_stored_dtcs', {
        config: currentDto(),
        statusMask: null,
        origin: 'dtc',
      });
      setState({
        storedDtcs: result.filter((d) => d.isConfirmed),
        pendingDtcs: result.filter((d) => d.isPending),
        isScanning: false,
      });
      touchResponse();
      refreshSessionInfoSoon();
    } catch (err) {
      setState({ isScanning: false });
      handleCommandError(err);
    }
  },

  /** ClearDiagnosticInformation (0x14, all groups) via raw UDS; lists are cleared only on a positive response. */
  async clearDtcs(): Promise<void> {
    const ex = await diagnosticsStore.sendUds(0x14, null, [0xff, 0xff, 0xff], 'physical', 'dtc');
    if (!ex || !ex.response) return;
    if (ex.response.positive) {
      setState({ storedDtcs: [], pendingDtcs: [] });
    } else {
      setState({ lastError: { code: 'negative_response', message: nrcText(ex.response) } });
    }
  },

  togglePid(pid: number): void {
    const next = new Set(currentState.activePids);
    if (next.has(pid)) next.delete(pid);
    else next.add(pid);
    setState({ activePids: next });
  },

  setActivePids(pids: Set<number>): void {
    setState({ activePids: pids });
  },

  setPidPollingMs(ms: number): void {
    const restartDemo = currentState.isPolling && currentState.mockMode;
    if (restartDemo) stopPollingInternal();
    setState({ pidPollingMs: ms }); // real loop reads the interval each round
    if (restartDemo) startPollingInternal();
  },

  /** Demo: synthetic timer. Real: sequential OBD-II 0x01 round-robin on the open session. */
  startPolling(): void {
    if (currentState.isPolling) return;
    if (currentState.mockMode) {
      setState({ isPolling: true });
      startPollingInternal();
      return;
    }
    if (!currentState.session.connected) {
      setState({ lastError: NOT_CONNECTED });
      return;
    }
    stopRealPidLoop();
    setState({ isPolling: true, livePidErrors: new Map() });
    void realPidLoop(pidGen);
  },

  stopPolling(): void {
    haltPidPolling();
    if (currentState.isPolling) setState({ isPolling: false });
  },

  async readDid(did: number): Promise<void> {
    if (!currentState.session.connected) {
      setState({ lastError: NOT_CONNECTED });
      return;
    }

    if (currentState.mockMode) {
      const reqBytes = [0x22, (did >> 8) & 0xff, did & 0xff];
      const reqTs = Date.now() * 1000;
      const reqSeq = demoEvent('request', { sid: 0x22, bytes: reqBytes, origin: 'did', timestampUs: reqTs });
      await new Promise<void>((r) => setTimeout(r, 80));
      const entry = makeMockDidValue(did);
      const nextDidValues = new Map(currentState.didValues);
      nextDidValues.set(did, entry);
      setState({ didValues: nextDidValues, session: { ...currentState.session, lastResponseMs: Date.now() } });
      const rspBytes = [0x62, (did >> 8) & 0xff, did & 0xff, ...entry.raw];
      const rspTs = Date.now() * 1000;
      demoIsoTpExchange(reqSeq, reqBytes, rspBytes, reqTs, rspTs);
      demoEvent('response', {
        sid: 0x62,
        bytes: rspBytes,
        requestSeq: reqSeq,
        elapsedUs: rspTs - reqTs,
        origin: 'did',
        timestampUs: rspTs,
      });
      return;
    }

    try {
      const result = await diagInvoke('cmd_diag_read_did', { config: currentDto(), did, origin: 'did' });
      // Same decoder as the UDS Console (`interpretUdsResponse`): never trust a second, divergent decode.
      const entry: DidValueEntry = {
        did,
        raw: result.raw,
        decoded: decodeDidValue(did, result.raw),
        timestampMs: Date.now(),
      };
      const nextDidValues = new Map(currentState.didValues);
      nextDidValues.set(did, entry);
      const nextErrors = new Map(currentState.didErrors);
      nextErrors.delete(did);
      setState({ didValues: nextDidValues, didErrors: nextErrors });
      touchResponse();
    } catch (err) {
      const e = handleCommandError(err);
      const nextErrors = new Map(currentState.didErrors);
      nextErrors.set(did, e);
      setState({ didErrors: nextErrors });
    }
  },

  async readAllDids(): Promise<void> {
    for (const def of DID_CATALOG) {
      if (!currentState.session.connected) break;
      await diagnosticsStore.readDid(def.did);
    }
  },

  /**
   * Raw UDS request (UDS console). Request PDU = `[sid] + [subFn if not null] + data`.
   * Returns the exchange (also stored in `lastUds`) or null when not connected.
   * `origin` tags the transaction for the Diagnostics Traffic Dock (default: the UDS Console).
   */
  async sendUds(
    sid: number,
    subFn: number | null,
    data: readonly number[],
    addressing: UdsAddressing = 'physical',
    origin: DiagOrigin = 'console',
  ): Promise<UdsExchange | null> {
    if (!currentState.session.connected) {
      setState({ lastError: NOT_CONNECTED });
      return null;
    }
    const requestBytes = [sid, ...(subFn !== null ? [subFn] : []), ...data];

    if (currentState.mockMode) {
      const reqTs = Date.now() * 1000;
      const reqSeq = demoEvent('request', { sid, bytes: requestBytes, addressing, origin, timestampUs: reqTs });
      await new Promise<void>((r) => setTimeout(r, 65));
      const responseSid = (sid + 0x40) & 0xff;
      const raw = [responseSid, ...(subFn !== null ? [subFn & 0x7f] : []), 0x00];
      const rspTs = Date.now() * 1000;
      const response: UdsResponseDto = {
        raw,
        positive: true,
        suppressed: false,
        nrc: null,
        nrcName: null,
        responsePendingCount: 0,
        elapsedUs: rspTs - reqTs,
        transactionSeq: reqSeq,
      };
      demoIsoTpExchange(reqSeq, requestBytes, raw, reqTs, rspTs);
      demoEvent('response', {
        sid: responseSid,
        bytes: raw,
        requestSeq: reqSeq,
        elapsedUs: rspTs - reqTs,
        addressing,
        origin,
        timestampUs: rspTs,
      });
      const exchange: UdsExchange = { id: ++exchangeSeq, atMs: Date.now(), requestBytes, addressing, response, error: null };
      setState({ lastUds: exchange, session: { ...currentState.session, lastResponseMs: Date.now() } });
      return exchange;
    }

    try {
      const response = await diagInvoke('cmd_diag_send_uds', {
        config: currentDto(),
        sid,
        subFunction: subFn,
        data: [...data],
        options: { addressing, timeoutMs: null, origin },
      });
      const exchange: UdsExchange = { id: ++exchangeSeq, atMs: Date.now(), requestBytes, addressing, response, error: null };
      setState({ lastUds: exchange, lastError: null });
      touchResponse();
      refreshSessionInfoSoon();
      return exchange;
    } catch (err) {
      const e = handleCommandError(err);
      const exchange: UdsExchange = { id: ++exchangeSeq, atMs: Date.now(), requestBytes, addressing, response: null, error: e };
      setState({ lastUds: exchange });
      return exchange;
    }
  },

  /**
   * Honest ReadDataByIdentifier: never falls back to demo data. Throws UdsTransportError.
   * Returns the DID data record ONLY (contract: `DidReadResultDto.raw` excludes 0x62 and the DID echo).
   */
  async readDidStrict(did: number, origin: DiagOrigin = 'other'): Promise<number[]> {
    if (!currentState.session.connected || currentState.mockMode) {
      throw new UdsTransportError('notConnected', formatDiagError(t, NOT_CONNECTED), NOT_CONNECTED);
    }
    try {
      const result = await diagInvoke('cmd_diag_read_did', { config: currentDto(), did, origin });
      if (!result || !Array.isArray(result.raw)) {
        throw new UdsTransportError('failed', 'Malformed cmd_diag_read_did response');
      }
      touchResponse();
      return result.raw;
    } catch (err) {
      throw err instanceof UdsTransportError ? err : strictError(err);
    }
  },

  /**
   * Honest raw UDS request for the UDS Panel. Never mocks. Throws UdsTransportError (including for
   * negative responses). Returns the positive response payload AFTER the SID echo (e.g. the data
   * record of `0x63` ReadMemoryByAddress); empty for suppressed responses.
   * Conversation logging is done by the backend; `options.record` is kept for API compatibility only;
   * `options.origin` tags the transaction (default 'other').
   */
  async sendUdsStrict(
    sid: number,
    data: readonly number[],
    options: { record: boolean; origin?: DiagOrigin } = { record: true },
  ): Promise<number[]> {
    if (!currentState.session.connected || currentState.mockMode) {
      throw new UdsTransportError('notConnected', formatDiagError(t, NOT_CONNECTED), NOT_CONNECTED);
    }
    try {
      const r = await diagInvoke('cmd_diag_send_uds', {
        config: currentDto(),
        sid,
        subFunction: null,
        data: [...data],
        options: { addressing: 'physical', timeoutMs: null, origin: options.origin ?? 'other' },
      });
      if (!r || !Array.isArray(r.raw)) {
        throw new UdsTransportError('failed', 'Malformed cmd_diag_send_uds response');
      }
      touchResponse();
      if (!r.positive) {
        const diag: DiagUiError = { code: 'negative_response', message: nrcText(r) };
        throw new UdsTransportError('failed', formatDiagError(t, diag), diag);
      }
      return r.raw.slice(1);
    } catch (err) {
      throw err instanceof UdsTransportError ? err : strictError(err);
    }
  },

  clearConversation(): void {
    setState({ conversation: [] });
  },

  /** Clears both the conversation log and the ISO-TP frame tap (Traffic Dock "Clear"). */
  clearTraffic(): void {
    isotpReassembler.reset();
    setState({ conversation: [], isotpFrames: [] });
  },

  /** "Resend in Console": queue a composer prefill; `UdsConsole` applies it once (on mount or change). */
  setConsoleDraft(draft: Omit<ConsoleDraft, 'nonce'>): void {
    setState({ consoleDraft: { ...draft, nonce: ++consoleDraftNonce } });
  },

  clearConsoleDraft(): void {
    if (currentState.consoleDraft !== null) setState({ consoleDraft: null });
  },

  clearIsoTpFrames(): void {
    isotpReassembler.reset();
    setState({ isotpFrames: [] });
  },
};

function strictError(err: unknown): UdsTransportError {
  const e = handleCommandError(err);
  const kind: UdsTransportErrorKind = e.code === 'backend_missing' ? 'backendMissing' : 'failed';
  return new UdsTransportError(kind, formatDiagError(t, e), e);
}

export function useDiagnosticsStore(): DiagnosticsState {
  return useSyncExternalStore(
    diagnosticsStore.subscribe,
    diagnosticsStore.getState,
    diagnosticsStore.getState,
  );
}

/** Selector subscription: re-renders only when the selected slice changes (reference equality). */
export function useDiagnosticsSelector<T>(selector: (state: DiagnosticsState) => T): T {
  return useSyncExternalStore(
    diagnosticsStore.subscribe,
    () => selector(currentState),
    () => selector(currentState),
  );
}
