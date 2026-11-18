import { useSyncExternalStore } from 'react';
import { invokeCmd } from '../services/ipcClient';
import { registerTxSource } from './txSources';
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
import { busyRetryFields, type BusyRetryOptions } from '../components/diagnostics/busyRetry';
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
  type DtcReportResultDto,
  type PassiveDiscoverySnapshotDto,
  type PhysicalSweepRequestDto,
  type PhysicalSweepResultDto,
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

/** Mirrors the backend `MAX_DIAG_TAPS` (one tap per concurrent UDS session). */
export const MAX_DIAG_TABS = 8;
const MAX_TAB_LABEL = 32;

/**
 * Everything that belongs to ONE ECU session. Lives inside a `DiagSessionTab`; the public
 * `DiagnosticsState` exposes the ACTIVE tab's copy flattened, so single-session consumers keep working.
 */
export interface DiagTabData {
  session: DiagSessionState;
  /** Last `DiagSessionInfoDto` from the backend (real mode only). */
  sessionInfo: DiagSessionInfoDto | null;
  connecting: boolean;
  storedDtcs: DtcEntryDto[];
  pendingDtcs: DtcEntryDto[];
  didValues: Map<number, DidValueEntry>;
  didErrors: Map<number, DiagUiError>;
  livePidValues: Map<number, LivePidValue>;
  /** Real mode: per-PID poll failures (value in `livePidValues` is then stale). */
  livePidErrors: Map<number, LivePidError>;
  /** Chronological (oldest first), bounded to MAX_CONVERSATION. Real: backend log; demo: local DEMO events. */
  conversation: ConversationEntry[];
  lastUds: UdsExchange | null;
  /** Chronological (oldest first), bounded to MAX_ISOTP_FRAMES. Real: backend tap; demo: DEMO frames. */
  isotpFrames: IsoTpFrameEntry[];
  /** Pending "Resend in Console" prefill (null = none). */
  consoleDraft: ConsoleDraft | null;
  isScanning: boolean;
  /** PID polling runs for the ACTIVE tab only; switching tabs stops it. */
  isPolling: boolean;
  lastError: DiagUiError | null;
  /** Last ReadDTCInformation report (any reportType) with the sub-function it answers. */
  dtcReport: { subFunction: number; result: DtcReportResultDto } | null;
  dtcReportBusy: boolean;
  /** Set when `connect` was refused because another tab owns the same addressing (that tab's id). */
  duplicateOfTabId: string | null;
}

export interface DiagSessionTab extends DiagTabData {
  id: string;
  /** User-editable; follows the addressing until the user renames it (`labelCustom`). */
  label: string;
  labelCustom: boolean;
  /** ECU registry record this tab was opened from ("Oturum Aç"); display only, never read back into the config. */
  ecuId: string | null;
}

/** Process-wide state (not per ECU). */
interface DiagGlobalState {
  /** DEMO mode: local synthetic data, no `cmd_diag_*` traffic. Default false. */
  mockMode: boolean;
  activePids: Set<number>;
  pidPollingMs: number;
  /** Last functional ECU discovery result (real: `cmd_diag_discover_ecus`; demo: DEMO-only synthetic). */
  discovery: EcuDiscoveryResultDto | null;
  discovering: boolean;
  /** Discovery errors are kept apart from `lastError`: a failed scan must never imply a lost UDS session. */
  discoveryError: DiagUiError | null;
  /** Last passive-discovery snapshot (real mode only; the scan runs in the backend, survives Panic / disarm). */
  passive: PassiveDiscoverySnapshotDto | null;
  passiveBusy: boolean;
  passiveError: DiagUiError | null;
  /** Physical sweep (ACTIVE, blocking). A Panic aborts it in the backend, which returns the partial result. */
  sweeping: boolean;
  sweepResult: PhysicalSweepResultDto | null;
  sweepError: DiagUiError | null;
}

interface RawState extends DiagGlobalState {
  tabs: DiagSessionTab[];
  activeTabId: string;
}

/** Public snapshot: global fields + the ACTIVE tab's fields flattened + the tab list. */
export interface DiagnosticsState extends DiagGlobalState, DiagTabData {
  tabs: DiagSessionTab[];
  activeTabId: string;
}

type TabPatch = Partial<Omit<DiagSessionTab, 'id'>>;

const DEFAULT_CONFIG: DiagSessionConfig = {
  requestId: 0x7e0,
  responseId: 0x7e8,
  busId: 0,
  isExtendedId: false,
  protocol: 'uds',
};

// ─── Tab construction / addressing ───────────────────────────────────────────

function toHex(n: number, width = 2): string {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

function newTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultTabLabel(c: DiagSessionConfig): string {
  return `Bus${c.busId + 1} ${toHex(c.requestId, 3)}→${toHex(c.responseId, 3)}`;
}

/** Backend session identity (the keys that make two sessions collide in `diag_session.rs`). */
export function addressingKey(c: DiagSessionConfig): string {
  return [
    c.busId,
    c.requestId,
    c.responseId,
    c.isExtendedId ? 1 : 0,
    c.addressFormat ?? 'normal',
    c.targetAddress ?? '',
    c.responseAddress ?? '',
  ].join('|');
}

function freshTabData(config: DiagSessionConfig): DiagTabData {
  return {
    session: {
      connected: false,
      config,
      udsSession: 'default',
      testerPresentActive: false,
      lastResponseMs: null,
    },
    sessionInfo: null,
    connecting: false,
    storedDtcs: [],
    pendingDtcs: [],
    didValues: new Map(),
    didErrors: new Map(),
    livePidValues: new Map(),
    livePidErrors: new Map(),
    conversation: [],
    lastUds: null,
    isotpFrames: [],
    consoleDraft: null,
    isScanning: false,
    isPolling: false,
    lastError: null,
    dtcReport: null,
    dtcReportBusy: false,
    duplicateOfTabId: null,
  };
}

function makeTab(config: DiagSessionConfig): DiagSessionTab {
  return { id: newTabId(), label: defaultTabLabel(config), labelCustom: false, ecuId: null, ...freshTabData(config) };
}

function makeInitialRaw(): RawState {
  const first = makeTab(DEFAULT_CONFIG);
  return {
    tabs: [first],
    activeTabId: first.id,
    mockMode: false,
    activePids: new Set(),
    pidPollingMs: 500,
    discovery: null,
    discovering: false,
    discoveryError: null,
    passive: null,
    passiveBusy: false,
    passiveError: null,
    sweeping: false,
    sweepResult: null,
    sweepError: null,
  };
}

// ─── Core state (tabs are the single source of truth; the public view is derived) ─────

let raw: RawState = makeInitialRaw();
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) {
    fn();
  }
}

function setRaw(next: RawState): void {
  raw = next;
  emit();
}

function setGlobal(partial: Partial<DiagGlobalState>): void {
  setRaw({ ...raw, ...partial });
}

function getTab(id: string): DiagSessionTab | undefined {
  return raw.tabs.find((tab) => tab.id === id);
}

function activeTabOf(state: RawState): DiagSessionTab {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];
}

/**
 * Writes into ONE tab by id (never "the active tab"): late async results of a tab the user has left
 * land in that tab; results for a closed tab are dropped (no-op).
 */
function updateTab(id: string, patch: TabPatch | ((tab: DiagSessionTab) => TabPatch)): void {
  const idx = raw.tabs.findIndex((tab) => tab.id === id);
  if (idx < 0) return;
  const cur = raw.tabs[idx];
  const p = typeof patch === 'function' ? patch(cur) : patch;
  const next: DiagSessionTab = { ...cur, ...p };
  if (!next.labelCustom && next.session.config !== cur.session.config) {
    next.label = defaultTabLabel(next.session.config);
  }
  const tabs = raw.tabs.slice();
  tabs[idx] = next;
  setRaw({ ...raw, tabs });
}

function patchSession(id: string, partial: Partial<DiagSessionState>): void {
  updateTab(id, (tab) => ({ session: { ...tab.session, ...partial } }));
}

let viewCache: { src: RawState; view: DiagnosticsState } | null = null;

function view(): DiagnosticsState {
  if (viewCache !== null && viewCache.src === raw) return viewCache.view;
  const active = activeTabOf(raw);
  const { id: _id, label: _label, labelCustom: _labelCustom, ecuId: _ecuId, ...data } = active;
  void _id;
  void _label;
  void _labelCustom;
  void _ecuId;
  const next: DiagnosticsState = { ...raw, ...data };
  viewCache = { src: raw, view: next };
  return next;
}

/** Active tab of a public snapshot (`state.tabs` always contains `state.activeTabId`). */
export function selectActiveTab(state: DiagnosticsState): DiagSessionTab {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];
}

/** Public snapshots always expose the active tab's session as `state.session`. */
export function selectSession(state: DiagnosticsState): DiagSessionState {
  return state.session;
}

// ─── Per-tab runtime (cursors / reassembler; not React state) ────────────────

interface TabRuntime {
  conversationCursor: number; // backend `sinceSeq`
  lastStoredSeq: number; // highest event seq of the current backend seq epoch
  /** Seq epoch: incremented when the backend session was reopened (seq restarts at 1). Joins use (epoch, seq). */
  seqEpoch: number;
  isotpCursor: number;
  isotpLastStored: number;
  isotpUnavailable: boolean; // backend command missing: stop asking until the next connect
  isotpReassembler: IsoTpReassembler;
}

const runtimes = new Map<string, TabRuntime>();

function rtOf(tabId: string): TabRuntime {
  let r = runtimes.get(tabId);
  if (!r) {
    r = {
      conversationCursor: 0,
      lastStoredSeq: 0,
      seqEpoch: 0,
      isotpCursor: 0,
      isotpLastStored: 0,
      isotpUnavailable: false,
      isotpReassembler: new IsoTpReassembler(),
    };
    runtimes.set(tabId, r);
  }
  return r;
}

function resetIsoTpTap(rt: TabRuntime): void {
  rt.isotpCursor = 0;
  rt.isotpLastStored = 0;
  rt.isotpUnavailable = false;
  rt.isotpReassembler.reset();
}

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

let passiveSnapshotInFlight = false;
let pollingIntervalId: ReturnType<typeof setInterval> | null = null;
let pollingTickCount = 0;
let mockSpeedAccum = 0;

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

function startPollingInternal(tabId: string): void {
  if (pollingIntervalId !== null) return;
  pollingTickCount = 0;
  mockSpeedAccum = 0;

  pollingIntervalId = setInterval(() => {
    const tab = getTab(tabId);
    if (!tab || !tab.isPolling) {
      stopPollingInternal();
      return;
    }

    pollingTickCount += 1;
    mockSpeedAccum = Math.min(120, mockSpeedAccum + (Math.random() - 0.3) * 3);
    if (mockSpeedAccum < 0) mockSpeedAccum = 0;

    const nextPidValues = new Map(tab.livePidValues);
    for (const pid of raw.activePids) {
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

    updateTab(tabId, { livePidValues: nextPidValues });
  }, raw.pidPollingMs);
}

function stopPollingInternal(): void {
  if (pollingIntervalId !== null) {
    clearInterval(pollingIntervalId);
    pollingIntervalId = null;
  }
}

// ─── Real OBD-II live PIDs (service 0x01 via `cmd_diag_send_uds`; strictly sequential) ─────

/** Bumped by Panic Stop: late results of in-flight discovery / DTC scans are dropped. */
let diagOpGen = 0;

let pidGen = 0;
let pidTimer: ReturnType<typeof setTimeout> | null = null;

function stopRealPidLoop(): void {
  pidGen += 1; // in-flight results of the old loop are dropped
  if (pidTimer !== null) {
    clearTimeout(pidTimer);
    pidTimer = null;
  }
}

/** Stops any PID polling (demo timer or real loop; only one runs, for the active tab) and clears `isPolling` everywhere. */
function haltPidPolling(): void {
  stopPollingInternal();
  stopRealPidLoop();
  if (raw.tabs.some((tab) => tab.isPolling)) {
    setRaw({ ...raw, tabs: raw.tabs.map((tab) => (tab.isPolling ? { ...tab, isPolling: false } : tab)) });
  }
}

function pidSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    pidTimer = setTimeout(() => {
      pidTimer = null;
      resolve();
    }, ms);
  });
}

function setPidError(tabId: string, pid: number, err: LivePidError): void {
  updateTab(tabId, (tab) => {
    const livePidErrors = new Map(tab.livePidErrors);
    livePidErrors.set(pid, err);
    return { livePidErrors };
  });
}

async function pollOnePid(tabId: string, pid: number, gen: number): Promise<void> {
  const def = PID_CATALOG.find((p) => p.pid === pid);
  const dto = dtoOf(tabId);
  if (!def || !dto) return;
  try {
    const r = await diagInvoke('cmd_diag_send_uds', {
      config: dto,
      sid: 0x01,
      subFunction: null,
      data: [pid],
      options: { addressing: 'physical', timeoutMs: null, origin: 'pids' },
    });
    if (gen !== pidGen) return;
    if (!r.positive) {
      setPidError(tabId, pid, { kind: 'nrc', nrc: r.nrc, nrcName: r.nrcName, atMs: Date.now() });
      return;
    }
    const rawBytes = r.raw;
    if (rawBytes.length < 2 + def.bytes || rawBytes[0] !== 0x41 || rawBytes[1] !== pid) {
      setPidError(tabId, pid, { kind: 'badResponse', atMs: Date.now() });
      return;
    }
    const physical = def.formula(rawBytes.slice(2, 2 + def.bytes));
    updateTab(tabId, (tab) => {
      const livePidValues = new Map(tab.livePidValues);
      livePidValues.set(pid, { pid, rawValue: Math.round(physical), physicalValue: physical, timestampMs: Date.now() });
      const livePidErrors = new Map(tab.livePidErrors);
      livePidErrors.delete(pid);
      return { livePidValues, livePidErrors };
    });
    touchResponse(tabId);
  } catch (err) {
    if (gen !== pidGen) return;
    const e = toDiagUiError(err);
    if (e.code === 'backend_missing' || SESSION_LOST_CODES.has(e.code)) {
      haltPidPolling();
      if (getTab(tabId)?.session.connected) markLost(tabId, e);
      else updateTab(tabId, { lastError: e });
      return;
    }
    setPidError(tabId, pid, { kind: 'transport', error: e, atMs: Date.now() });
  }
}

async function realPidLoop(tabId: string, gen: number): Promise<void> {
  while (gen === pidGen) {
    const roundStart = Date.now();
    for (const pid of Array.from(raw.activePids)) {
      if (gen !== pidGen) return;
      if (!raw.activePids.has(pid)) continue;
      await pollOnePid(tabId, pid, gen); // one request in flight at a time
    }
    if (gen !== pidGen) return;
    await pidSleep(Math.max(20, raw.pidPollingMs - (Date.now() - roundStart)));
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
    addressFormat: c.addressFormat ?? 'normal',
    targetAddress: c.targetAddress ?? null,
    responseAddress: c.responseAddress ?? null,
  };
}

/** Backend config of a SPECIFIC tab (null once the tab is closed). */
function dtoOf(tabId: string): DiagSessionConfigDto | null {
  const tab = getTab(tabId);
  return tab ? toDiagDto(tab.session.config) : null;
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

let demoSeq = 0;
let exchangeSeq = 0;

let viewRefs = 0;
let pollGen = 0;
let pollRunning = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

let entryUid = 0;
let consoleDraftNonce = 0;

function pushEntries(tabId: string, entries: ConversationEntry[]): void {
  if (entries.length === 0) return;
  updateTab(tabId, (tab) => {
    let conversation = tab.conversation.concat(entries);
    if (conversation.length > MAX_CONVERSATION) {
      conversation = conversation.slice(conversation.length - MAX_CONVERSATION);
    }
    return { conversation };
  });
}

function appendEvents(tabId: string, events: readonly ConversationEventDto[], gapBefore: boolean): void {
  const rt = rtOf(tabId);
  const fresh = events.filter((e) => e.seq > rt.lastStoredSeq);
  if (fresh.length === 0) return;
  const entries: ConversationEntry[] = [];
  if (gapBefore) entries.push({ uid: ++entryUid, epoch: rt.seqEpoch, event: null, note: 'gap' });
  for (const ev of fresh) {
    entries.push({ uid: ++entryUid, epoch: rt.seqEpoch, event: normalizeConversationEvent(ev), note: null });
  }
  rt.lastStoredSeq = fresh[fresh.length - 1].seq;
  pushEntries(tabId, entries);
}

/**
 * Backend session was reopened (Panic, config change, closed tap): its seq restarts at 1.
 * Keep the old log, add a note, restart the cursor.
 */
function resetSeqEpoch(tabId: string): void {
  const rt = rtOf(tabId);
  rt.conversationCursor = 0;
  rt.lastStoredSeq = 0;
  rt.seqEpoch += 1;
  pushEntries(tabId, [{ uid: ++entryUid, epoch: rt.seqEpoch, event: null, note: 'reopened' }]);
}

/** Returns false when the page belonged to a restarted seq epoch (caller re-fetches from 0). */
function applyConversationPage(tabId: string, page: ConversationPageDto): boolean {
  const rt = rtOf(tabId);
  if (page.lastSeq < rt.conversationCursor) {
    resetSeqEpoch(tabId);
    return false;
  }
  appendEvents(tabId, page.events, page.truncated);
  rt.conversationCursor = Math.max(rt.conversationCursor, page.lastSeq);
  return true;
}

/** DEMO-only synthetic event. Never called in real mode. */
function demoEvent(
  tabId: string,
  kind: ConversationEventKind,
  fields: Partial<Omit<ConversationEventDto, 'seq' | 'kind'>> = {},
): number {
  demoSeq += 1;
  appendEvents(
    tabId,
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
let isotpUid = 0;
const DEMO_PAD = 0xaa;

function demoFrameData(pci: readonly number[], payload: readonly number[]): number[] {
  const out = [...pci, ...payload];
  while (out.length < 8) out.push(DEMO_PAD);
  return out;
}

function demoPushFrame(
  tabId: string,
  dir: 'tx' | 'rx',
  kind: IsoTpFrameKind,
  data: number[],
  requestSeq: number,
  timestampUs: number,
): void {
  const tab = getTab(tabId);
  if (!tab) return;
  const cfg = tab.session.config;
  const rt = rtOf(tabId);
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
  pushIsoTpEntries(tabId, [isoTpEntryFromDto(dto, ++isotpUid, rt.seqEpoch, rt.isotpReassembler)]);
}

/** Request SF (tx) at `reqTsUs`; response as SF (rx) or FF + FC(CTS, BS=0, STmin=2 ms) + CF* ending at `rspTsUs`. */
function demoIsoTpExchange(
  tabId: string,
  requestSeq: number,
  request: readonly number[],
  response: readonly number[],
  reqTsUs: number,
  rspTsUs: number,
): void {
  demoPushFrame(tabId, 'tx', 'single', demoFrameData([request.length & 0x0f], request), requestSeq, reqTsUs + 120);
  if (response.length <= 7) {
    demoPushFrame(tabId, 'rx', 'single', demoFrameData([response.length & 0x0f], response), requestSeq, rspTsUs - 80);
    return;
  }
  const cfCount = Math.ceil((response.length - 6) / 7);
  const gapUs = 2_300; // above the demo STmin (2 ms)
  const ffTs = rspTsUs - 400 - cfCount * gapUs;
  demoPushFrame(
    tabId,
    'rx',
    'first',
    [0x10 | ((response.length >> 8) & 0x0f), response.length & 0xff, ...response.slice(0, 6)],
    requestSeq,
    ffTs,
  );
  demoPushFrame(tabId, 'tx', 'flowControl', demoFrameData([0x30, 0x00, 0x02], []), requestSeq, ffTs + 400);
  for (let i = 0; i < cfCount; i += 1) {
    const chunk = response.slice(6 + i * 7, 6 + (i + 1) * 7);
    demoPushFrame(
      tabId,
      'rx',
      'consecutive',
      demoFrameData([0x20 | ((i + 1) & 0x0f)], chunk),
      requestSeq,
      ffTs + 400 + (i + 1) * gapUs,
    );
  }
}

// ─── Session info / loss handling ─────────────────────────────────────────────

/** True when a poll/command loop is bound to this tab (polling + PID loops only ever serve the active tab). */
function isActiveTab(tabId: string): boolean {
  return raw.activeTabId === tabId;
}

function markSessionLost(tabId: string, err: DiagUiError): void {
  if (isActiveTab(tabId)) {
    stopConversationPolling();
    haltPidPolling();
  }
  updateTab(tabId, (tab) => ({
    session: { ...tab.session, connected: false, testerPresentActive: false },
    sessionInfo: null,
    isPolling: false,
    lastError: err,
  }));
}

/** Errors that are properties of the BUS (armed / panic / listen-only / gone), not of one ECU session. */
const BUS_WIDE_LOST_CODES: ReadonlySet<DiagUiError['code']> = new Set<DiagUiError['code']>([
  'panic_latched',
  'disarmed',
  'listen_only',
  'bus_not_connected',
]);

/** Marks the tab lost; for bus-wide causes every connected tab on the same bus is lost too. */
function markLost(tabId: string, err: DiagUiError): void {
  const origin = getTab(tabId);
  markSessionLost(tabId, err);
  if (!origin || !BUS_WIDE_LOST_CODES.has(err.code)) return;
  for (const other of raw.tabs) {
    if (other.id !== tabId && other.session.connected && other.session.config.busId === origin.session.config.busId) {
      markSessionLost(other.id, err);
    }
  }
}

/** `info.open` is deliberately NOT used for the connected state (backend may report false); errors decide. */
function applyInfo(tabId: string, info: DiagSessionInfoDto): void {
  if (info.lastSeq < rtOf(tabId).conversationCursor) resetSeqEpoch(tabId);
  updateTab(tabId, (tab) => ({
    sessionInfo: info,
    session: {
      ...tab.session,
      testerPresentActive: info.testerPresentEnabled,
      udsSession: mapActiveSession(info.activeSession) ?? tab.session.udsSession,
    },
  }));
}

async function refreshSessionInfo(tabId: string, gen?: number): Promise<void> {
  const tab = getTab(tabId);
  if (raw.mockMode || !tab || !tab.session.connected) return;
  const dto = toDiagDto(tab.session.config);
  const info = await diagInvoke('cmd_diag_session_info', { config: dto });
  if (gen !== undefined && gen !== pollGen) return;
  if (!getTab(tabId)?.session.connected) return;
  applyInfo(tabId, info);
}

/** After a user command: refresh session info in the background (poll loop reports real faults). */
function refreshSessionInfoSoon(tabId: string): void {
  void refreshSessionInfo(tabId).catch(() => undefined);
}

/** Central handler for a failed real command (result is pinned to `tabId`). */
function handleCommandError(tabId: string, err: unknown): DiagUiError {
  const e = toDiagUiError(err);
  updateTab(tabId, { lastError: e });
  if (SESSION_LOST_CODES.has(e.code) && getTab(tabId)?.session.connected && !raw.mockMode) {
    markLost(tabId, e);
  }
  return e;
}

function touchResponse(tabId: string): void {
  patchSession(tabId, { lastResponseMs: Date.now() });
}

// ─── Conversation polling (~4 Hz; ACTIVE tab only; only while connected AND a Diagnostics view is mounted) ──

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

/** Appends chronologically (oldest first) and trims the oldest rows beyond the cap. */
function pushIsoTpEntries(tabId: string, entries: IsoTpFrameEntry[]): void {
  if (entries.length === 0) return;
  updateTab(tabId, (tab) => {
    let isotpFrames = tab.isotpFrames.concat(entries);
    if (isotpFrames.length > MAX_ISOTP_FRAMES) isotpFrames = isotpFrames.slice(isotpFrames.length - MAX_ISOTP_FRAMES);
    return { isotpFrames };
  });
}

function applyIsoTpPage(tabId: string, page: IsoTpFramePageDto): void {
  const rt = rtOf(tabId);
  if (page.lastSeq < rt.isotpCursor) {
    // Backend session reopened (seq restarted at 1): keep the old rows, restart the cursor.
    rt.isotpCursor = 0;
    rt.isotpLastStored = 0;
    rt.isotpReassembler.reset();
    return;
  }
  if (page.truncated || page.dropped > 0) rt.isotpReassembler.reset(); // gap: partial multi-frame state is invalid
  const fresh: IsoTpFrameDto[] = page.frames
    .filter((f: IsoTpFrameDto) => f.seq > rt.isotpLastStored)
    .map(normalizeIsoTpFrame);
  if (fresh.length > 0) {
    const entries = fresh.map((f) => isoTpEntryFromDto(f, ++isotpUid, rt.seqEpoch, rt.isotpReassembler));
    rt.isotpLastStored = fresh[fresh.length - 1].seq;
    pushIsoTpEntries(tabId, entries);
  }
  rt.isotpCursor = Math.max(rt.isotpCursor, page.lastSeq);
}

async function pollIsoTp(tabId: string, gen: number): Promise<void> {
  const rt = rtOf(tabId);
  const dto = dtoOf(tabId);
  if (rt.isotpUnavailable || !dto) return;
  try {
    const page = await diagInvoke('cmd_diag_get_isotp_frames', {
      config: dto,
      sinceSeq: rt.isotpCursor,
      max: ISOTP_PAGE_MAX,
    });
    if (gen !== pollGen) return;
    applyIsoTpPage(tabId, page);
  } catch (err) {
    if (gen !== pollGen) return;
    // A missing / failing frame tap must never tear down the UDS session: just stop asking.
    if (toDiagUiError(err).code === 'backend_missing') rt.isotpUnavailable = true;
  }
}

async function pollLoop(tabId: string, gen: number): Promise<void> {
  let tick = 0;
  while (gen === pollGen) {
    let delay = POLL_INTERVAL_MS;
    const dto = dtoOf(tabId);
    if (!dto) return;
    try {
      const page = await diagInvoke('cmd_diag_get_conversation', {
        config: dto,
        sinceSeq: rtOf(tabId).conversationCursor,
        max: CONVERSATION_PAGE_MAX,
      });
      if (gen !== pollGen) return;
      if (!applyConversationPage(tabId, page)) continue; // seq restarted: re-fetch from 0 immediately
      await pollIsoTp(tabId, gen);
      if (gen !== pollGen) return;
      tick += 1;
      if (tick % INFO_REFRESH_EVERY_TICKS === 0) await refreshSessionInfo(tabId, gen);
    } catch (err) {
      if (gen !== pollGen) return;
      const e = toDiagUiError(err);
      if (e.code === 'backend_missing' || SESSION_LOST_CODES.has(e.code)) {
        markLost(tabId, e);
        return;
      }
      updateTab(tabId, { lastError: e });
      delay = POLL_ERROR_BACKOFF_MS;
    }
    if (gen !== pollGen) return;
    await pollSleep(delay);
  }
}

function startConversationPolling(tabId: string): void {
  if (pollRunning) return;
  pollRunning = true;
  pollGen += 1;
  void pollLoop(tabId, pollGen);
}

function stopConversationPolling(): void {
  pollRunning = false;
  pollGen += 1; // in-flight results of the old loop are dropped
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

/** One poll loop for the ACTIVE tab: re-evaluated on connect / disconnect / tab switch / view attach. */
function syncConversationPolling(): void {
  const tab = activeTabOf(raw);
  const want = !raw.mockMode && tab.session.connected && viewRefs > 0;
  if (!want) {
    stopConversationPolling();
    return;
  }
  startConversationPolling(tab.id);
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

// ─── Tab lifecycle helpers ───────────────────────────────────────────────────

function findDuplicate(selfId: string | null, config: DiagSessionConfig): DiagSessionTab | undefined {
  const key = addressingKey(config);
  return raw.tabs.find((tab) => tab.id !== selfId && addressingKey(tab.session.config) === key);
}

function activateTab(id: string): void {
  if (id === raw.activeTabId || !getTab(id)) return;
  // PID polling and the conversation poll serve the ACTIVE tab only: stop them before switching.
  haltPidPolling();
  stopConversationPolling();
  setRaw({ ...raw, activeTabId: id });
  syncConversationPolling();
}

/** Fire-and-forget backend close of a session whose tab is already gone / reset. */
function closeBackendSession(config: DiagSessionConfigDto): Promise<DiagUiError | null> {
  return diagInvoke('cmd_diag_close_session', { config })
    .then(() => null)
    .catch((err: unknown) => {
      const e = toDiagUiError(err);
      return e.code === 'session_closed' ? null : e;
    });
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
    return view();
  },

  /** Backend session config of a specific tab (the object every `cmd_diag_*` / `cmd_flash_*` receives); null once closed. */
  getTabConfigDto(tabId: string): DiagSessionConfigDto | null {
    return dtoOf(tabId);
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

  // ── Tabs ──

  /** Existing tab with identical backend addressing (excluding `excludeTabId`), if any. */
  findTabByAddressing(config: DiagSessionConfig, excludeTabId: string | null = null): DiagSessionTab | null {
    return findDuplicate(excludeTabId, config) ?? null;
  },

  /** Creates and activates a new (disconnected) tab; `null` at the `MAX_DIAG_TABS` limit. */
  addTab(partial: Partial<DiagSessionConfig> = {}): string | null {
    if (raw.tabs.length >= MAX_DIAG_TABS) return null;
    const tab = makeTab({ ...DEFAULT_CONFIG, ...partial });
    setRaw({ ...raw, tabs: [...raw.tabs, tab] });
    activateTab(tab.id);
    return tab.id;
  },

  /**
   * "Open session" from discovery: switches to a tab with identical addressing if one exists,
   * otherwise creates a new tab. `null` when a new tab was needed but the limit is reached.
   */
  openTabForConfig(partial: Partial<DiagSessionConfig>): string | null {
    const config: DiagSessionConfig = { ...DEFAULT_CONFIG, ...partial };
    const existing = findDuplicate(null, config);
    if (existing) {
      activateTab(existing.id);
      return existing.id;
    }
    return diagnosticsStore.addTab(partial);
  },

  setActiveTab(id: string): void {
    activateTab(id);
  },

  renameTab(id: string, label: string): void {
    const tab = getTab(id);
    if (!tab) return;
    const trimmed = label.trim().slice(0, MAX_TAB_LABEL);
    if (trimmed.length === 0) updateTab(id, { label: defaultTabLabel(tab.session.config), labelCustom: false });
    else updateTab(id, { label: trimmed, labelCustom: true });
  },

  /** Closes the tab and its backend session. Always leaves at least one (blank) tab. */
  async closeTab(id: string): Promise<void> {
    const tab = getTab(id);
    if (!tab) return;
    const wasActive = raw.activeTabId === id;
    const needClose = tab.session.connected && !raw.mockMode;
    const dto = toDiagDto(tab.session.config);
    const idx = raw.tabs.findIndex((x) => x.id === id);
    let tabs = raw.tabs.filter((x) => x.id !== id);
    if (tabs.length === 0) tabs = [makeTab(DEFAULT_CONFIG)];
    const nextActive = wasActive ? tabs[Math.min(idx, tabs.length - 1)].id : raw.activeTabId;
    if (wasActive) {
      haltPidPolling();
      stopConversationPolling();
    }
    runtimes.delete(id);
    setRaw({ ...raw, tabs, activeTabId: nextActive });
    if (wasActive) syncConversationPolling();
    if (needClose) {
      const e = await closeBackendSession(dto);
      if (e) updateTab(raw.activeTabId, { lastError: e });
    }
  },

  /** Connects the ACTIVE tab (refused when another tab owns the same addressing). */
  async connect(config: DiagSessionConfig): Promise<void> {
    const tabId = raw.activeTabId;
    const tab = getTab(tabId);
    if (!tab || tab.connecting || tab.session.connected) return;

    const dup = findDuplicate(tabId, config);
    if (dup) {
      updateTab(tabId, {
        session: { ...tab.session, config },
        lastError: { code: 'duplicate_session', message: dup.label },
        duplicateOfTabId: dup.id,
      });
      return;
    }

    if (raw.mockMode) {
      updateTab(tabId, {
        session: { connected: true, config, udsSession: 'default', testerPresentActive: false, lastResponseMs: Date.now() },
        isotpFrames: [],
        conversation: [],
        lastError: null,
        duplicateOfTabId: null,
      });
      return;
    }

    updateTab(tabId, { connecting: true, lastError: null, duplicateOfTabId: null, session: { ...tab.session, config } });
    try {
      const info = await diagInvoke('cmd_diag_open_session', { config: toDiagDto(config) });
      if (!getTab(tabId)) {
        // Tab was closed while connecting: do not leave an orphan backend session behind.
        void closeBackendSession(toDiagDto(config));
        return;
      }
      const rt = rtOf(tabId);
      rt.conversationCursor = info.lastSeq;
      rt.lastStoredSeq = info.lastSeq;
      resetIsoTpTap(rt);
      updateTab(tabId, {
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
      updateTab(tabId, { connecting: false, lastError: toDiagUiError(err) });
    }
  },

  /** Disconnects the given tab (default: the active one). */
  async disconnect(tabId: string = raw.activeTabId): Promise<void> {
    const tab = getTab(tabId);
    if (!tab) return;
    const wasMock = raw.mockMode;
    const wasConnected = tab.session.connected;
    const dto = toDiagDto(tab.session.config);
    if (isActiveTab(tabId)) {
      stopConversationPolling();
      haltPidPolling();
    }
    updateTab(tabId, (cur) => ({
      session: { ...cur.session, connected: false, testerPresentActive: false, lastResponseMs: null },
      sessionInfo: null,
      isPolling: false,
    }));
    if (wasMock || !wasConnected) return;
    const e = await closeBackendSession(dto);
    if (e) updateTab(tabId, { lastError: e });
  },

  setMockMode(v: boolean): void {
    if (v === raw.mockMode) return;
    haltPidPolling();
    stopConversationPolling();
    // Real sessions of the mode being left are closed in the backend; mock sessions have nothing to close.
    const toClose = raw.mockMode ? [] : raw.tabs.filter((tab) => tab.session.connected).map((tab) => toDiagDto(tab.session.config));
    runtimes.clear();
    const tabs = raw.tabs.map((tab) => ({
      id: tab.id,
      label: tab.label,
      labelCustom: tab.labelCustom,
      ecuId: tab.ecuId,
      ...freshTabData(tab.session.config),
    }));
    setRaw({ ...raw, tabs, mockMode: v, discovery: null, discoveryError: null });
    for (const dto of toClose) void closeBackendSession(dto);
  },

  /** Stores the (not yet connected) form values in the tab. Ignored while connected / connecting. */
  updateConfig(config: DiagSessionConfig, tabId: string = raw.activeTabId): void {
    const tab = getTab(tabId);
    if (!tab || tab.session.connected || tab.connecting) return;
    if (JSON.stringify(tab.session.config) === JSON.stringify(config)) return;
    // Hand-edited addressing no longer belongs to the registry ECU the tab was opened from.
    const ecuId = tab.ecuId !== null && addressingKey(config) !== addressingKey(tab.session.config) ? null : tab.ecuId;
    updateTab(tabId, { session: { ...tab.session, config }, duplicateOfTabId: null, ecuId });
  },

  /** Remembers which ECU registry record a tab was opened from (display only). */
  setTabEcu(tabId: string, ecuId: string | null): void {
    const tab = getTab(tabId);
    if (!tab || tab.ecuId === ecuId) return;
    updateTab(tabId, { ecuId });
  },

  clearError(): void {
    const tab = activeTabOf(raw);
    if (tab.lastError !== null || tab.duplicateOfTabId !== null) {
      updateTab(tab.id, { lastError: null, duplicateOfTabId: null });
    }
  },

  /** DiagnosticSessionControl (0x10). Real mode: session state comes back via `DiagSessionInfoDto`. */
  async setUdsSession(udsSession: DiagSessionState['udsSession']): Promise<void> {
    const tabId = raw.activeTabId;
    const subFn = udsSession === 'default' ? 0x01 : udsSession === 'extended' ? 0x03 : 0x02;
    if (raw.mockMode) patchSession(tabId, { udsSession });
    await sendUdsOn(tabId, 0x10, subFn, [], 'physical', 'session');
  },

  /** TesterPresent background keep-alive (`3E 80`). Real: `cmd_diag_set_tester_present`. */
  async setTesterPresent(active: boolean, intervalMs: number | null = null): Promise<void> {
    const tabId = raw.activeTabId;
    const tab = getTab(tabId);
    if (!tab || !tab.session.connected) {
      updateTab(tabId, { lastError: NOT_CONNECTED });
      return;
    }
    if (raw.mockMode) {
      patchSession(tabId, { testerPresentActive: active });
      demoEvent(tabId, 'keepalive_sent', { sid: 0x3e, bytes: [0x3e, 0x80], detail: active ? 'DEMO on' : 'DEMO off', origin: 'keepalive' });
      return;
    }
    try {
      const info = await diagInvoke('cmd_diag_set_tester_present', {
        config: toDiagDto(tab.session.config),
        enabled: active,
        intervalMs,
      });
      if (getTab(tabId)?.session.connected) applyInfo(tabId, info);
    } catch (err) {
      handleCommandError(tabId, err);
    }
  },

  /**
   * Strict, tab-pinned TesterPresent keep-alive (UDS flow `uds_tester_present_keepalive`). The
   * backend keep-alive sends `3E 80` PHYSICALLY to the tab's request id, only when the tester was
   * silent for one interval (any request restarts S3). Throws UdsTransportError on failure.
   * `intervalMs` is clamped to the backend range 100..60000. Demo mode only flips the HMI flag.
   */
  async setTesterPresentOn(tabId: string, active: boolean, intervalMs: number | null = null): Promise<void> {
    const tab = getTab(tabId);
    if (!tab || !tab.session.connected) {
      // Nothing to stop on a closed session; starting needs one.
      if (!active) return;
      throw new UdsTransportError('notConnected', formatDiagError(t, NOT_CONNECTED), NOT_CONNECTED);
    }
    const interval = intervalMs === null ? null : Math.min(60_000, Math.max(100, Math.round(intervalMs)));
    if (raw.mockMode) {
      patchSession(tabId, { testerPresentActive: active });
      demoEvent(tabId, 'keepalive_sent', { sid: 0x3e, bytes: [0x3e, 0x80], detail: active ? 'DEMO on' : 'DEMO off', origin: 'keepalive' });
      return;
    }
    try {
      const info = await diagInvoke('cmd_diag_set_tester_present', {
        config: toDiagDto(tab.session.config),
        enabled: active,
        intervalMs: interval,
      });
      if (getTab(tabId)?.session.connected) applyInfo(tabId, info);
    } catch (err) {
      throw err instanceof UdsTransportError ? err : strictError(tabId, err);
    }
  },

  /** Functional request id of a tab's session config (`null` = physical addressing only). */
  functionalIdOf(tabId: string): number | null {
    return getTab(tabId)?.session.config.functionalId ?? null;
  },

  /**
   * Functional ECU discovery. Needs an armed bus, NOT an open UDS session. Demo mode returns a
   * deterministic synthetic result (marked DEMO in the UI); real mode never fabricates data.
   */
  async discoverEcus(req: EcuDiscoveryRequestDto): Promise<EcuDiscoveryResultDto | null> {
    if (raw.discovering) return null;
    setGlobal({ discovering: true, discoveryError: null });
    if (raw.mockMode) {
      await new Promise<void>((r) => setTimeout(r, 400));
      const discovery = makeMockDiscovery(req);
      setGlobal({ discovering: false, discovery });
      return discovery;
    }
    const opGen = diagOpGen;
    try {
      const discovery = await diagInvoke('cmd_diag_discover_ecus', { request: req });
      if (opGen !== diagOpGen) return null;
      setGlobal({ discovering: false, discovery });
      return discovery;
    } catch (err) {
      if (opGen !== diagOpGen) return null;
      setGlobal({ discovering: false, discoveryError: toDiagUiError(err) });
      return null;
    }
  },

  clearDiscovery(): void {
    setGlobal({ discovery: null, discoveryError: null });
  },

  /**
   * Passive discovery (TX-free, Listen-Only safe). Real mode only: never fabricated. Errors are kept in
   * `passiveError`, apart from `lastError`: they never imply a lost UDS session.
   */
  async passiveStart(busId: number): Promise<void> {
    if (raw.mockMode || raw.passiveBusy) return;
    setGlobal({ passiveBusy: true, passiveError: null });
    try {
      const passive = await diagInvoke('cmd_diag_passive_discovery_start', { busId });
      setGlobal({ passiveBusy: false, passive });
    } catch (err) {
      setGlobal({ passiveBusy: false, passiveError: toDiagUiError(err) });
    }
  },

  async passiveStop(busId: number): Promise<void> {
    if (raw.mockMode || raw.passiveBusy) return;
    setGlobal({ passiveBusy: true, passiveError: null });
    try {
      const passive = await diagInvoke('cmd_diag_passive_discovery_stop', { busId });
      setGlobal({ passiveBusy: false, passive });
    } catch (err) {
      setGlobal({ passiveBusy: false, passiveError: toDiagUiError(err) });
    }
  },

  /** 1 Hz poll target. Never overlaps itself; silent on transient errors except the first (kept in state). */
  async passiveSnapshot(busId: number): Promise<void> {
    if (raw.mockMode || passiveSnapshotInFlight) return;
    passiveSnapshotInFlight = true;
    try {
      const passive = await diagInvoke('cmd_diag_passive_discovery_snapshot', { busId });
      setGlobal({ passive, passiveError: null });
    } catch (err) {
      setGlobal({ passiveError: toDiagUiError(err) });
    } finally {
      passiveSnapshotInFlight = false;
    }
  },

  clearPassive(): void {
    setGlobal({ passive: null, passiveError: null });
  },

  /**
   * ACTIVE physical sweep: blocks until done. Real mode only. Not dropped by Panic Stop on purpose: the
   * backend aborts and returns the partial result (`abortCode`), which the operator must see.
   */
  async runSweep(request: PhysicalSweepRequestDto): Promise<PhysicalSweepResultDto | null> {
    if (raw.mockMode || raw.sweeping) return null;
    setGlobal({ sweeping: true, sweepError: null, sweepResult: null });
    try {
      const sweepResult = await diagInvoke('cmd_diag_physical_sweep', { request });
      setGlobal({ sweeping: false, sweepResult });
      return sweepResult;
    } catch (err) {
      setGlobal({ sweeping: false, sweepError: toDiagUiError(err) });
      return null;
    }
  },

  clearSweep(): void {
    setGlobal({ sweepResult: null, sweepError: null });
  },

  /**
   * ReadDTCInformation (0x19) with any supported reportType on the open session (real mode only).
   * Errors go through `handleCommandError` exactly like `scanDtcs` (Listen-Only / disarmed / panic drop the
   * session state and show the localized banner).
   */
  async readDtcReport(
    subFunction: number,
    params: readonly number[],
    retry: BusyRetryOptions | null = null,
  ): Promise<DtcReportResultDto | null> {
    const tabId = raw.activeTabId;
    const tab = getTab(tabId);
    if (!tab || !tab.session.connected) {
      updateTab(tabId, { lastError: NOT_CONNECTED });
      return null;
    }
    if (raw.mockMode || tab.dtcReportBusy) return null;
    updateTab(tabId, { dtcReportBusy: true, lastError: null });
    const opGen = diagOpGen;
    try {
      const result = await diagInvoke('cmd_diag_read_dtc_report', {
        config: toDiagDto(tab.session.config),
        subFunction,
        params: [...params],
        options: { addressing: 'physical', timeoutMs: null, origin: 'dtc', ...busyRetryFields(retry) },
      });
      if (opGen !== diagOpGen) return null;
      updateTab(tabId, { dtcReportBusy: false, dtcReport: { subFunction, result } });
      touchResponse(tabId);
      refreshSessionInfoSoon(tabId);
      return result;
    } catch (err) {
      if (opGen !== diagOpGen) return null;
      updateTab(tabId, { dtcReportBusy: false });
      handleCommandError(tabId, err);
      return null;
    }
  },

  clearDtcReport(): void {
    updateTab(raw.activeTabId, { dtcReport: null });
  },

  async scanDtcs(): Promise<void> {
    const tabId = raw.activeTabId;
    const tab = getTab(tabId);
    if (!tab || !tab.session.connected) {
      updateTab(tabId, { lastError: NOT_CONNECTED });
      return;
    }
    updateTab(tabId, { isScanning: true, lastError: null });

    if (raw.mockMode) {
      const reqBytes = [0x19, 0x02, 0xff];
      const reqTs = Date.now() * 1000;
      const reqSeq = demoEvent(tabId, 'request', { sid: 0x19, bytes: reqBytes, origin: 'dtc', timestampUs: reqTs });
      await new Promise<void>((r) => setTimeout(r, 600));
      updateTab(tabId, (cur) => ({
        storedDtcs: MOCK_STORED_DTCS.filter((d) => d.isConfirmed),
        pendingDtcs: MOCK_STORED_DTCS.filter((d) => d.isPending),
        isScanning: false,
        session: { ...cur.session, lastResponseMs: Date.now() },
      }));
      const rspBytes = [0x59, 0x02, 0xff, 0x00, 0x01, 0x00, 0x0c, 0x00, 0x03, 0x00, 0x04];
      const rspTs = Date.now() * 1000;
      demoIsoTpExchange(tabId, reqSeq, reqBytes, rspBytes, reqTs, rspTs);
      demoEvent(tabId, 'response', {
        sid: 0x59,
        bytes: rspBytes,
        requestSeq: reqSeq,
        elapsedUs: rspTs - reqTs,
        origin: 'dtc',
        timestampUs: rspTs,
      });
      return;
    }

    const opGen = diagOpGen;
    try {
      const result = await diagInvoke('cmd_diag_read_stored_dtcs', {
        config: toDiagDto(tab.session.config),
        statusMask: null,
        origin: 'dtc',
      });
      if (opGen !== diagOpGen) return;
      updateTab(tabId, {
        storedDtcs: result.filter((d) => d.isConfirmed),
        pendingDtcs: result.filter((d) => d.isPending),
        isScanning: false,
      });
      touchResponse(tabId);
      refreshSessionInfoSoon(tabId);
    } catch (err) {
      if (opGen !== diagOpGen) return;
      updateTab(tabId, { isScanning: false });
      handleCommandError(tabId, err);
    }
  },

  /** ClearDiagnosticInformation (0x14, all groups) via raw UDS; lists are cleared only on a positive response. */
  async clearDtcs(): Promise<void> {
    const tabId = raw.activeTabId;
    const ex = await sendUdsOn(tabId, 0x14, null, [0xff, 0xff, 0xff], 'physical', 'dtc');
    if (!ex || !ex.response) return;
    if (ex.response.positive) {
      updateTab(tabId, { storedDtcs: [], pendingDtcs: [] });
    } else {
      updateTab(tabId, { lastError: { code: 'negative_response', message: nrcText(ex.response) } });
    }
  },

  togglePid(pid: number): void {
    const next = new Set(raw.activePids);
    if (next.has(pid)) next.delete(pid);
    else next.add(pid);
    setGlobal({ activePids: next });
  },

  setActivePids(pids: Set<number>): void {
    setGlobal({ activePids: pids });
  },

  setPidPollingMs(ms: number): void {
    const active = activeTabOf(raw);
    const restartDemo = active.isPolling && raw.mockMode;
    if (restartDemo) stopPollingInternal();
    setGlobal({ pidPollingMs: ms }); // real loop reads the interval each round
    if (restartDemo) startPollingInternal(active.id);
  },

  /** Demo: synthetic timer. Real: sequential OBD-II 0x01 round-robin on the active tab's open session. */
  startPolling(): void {
    const tab = activeTabOf(raw);
    if (tab.isPolling) return;
    if (raw.mockMode) {
      updateTab(tab.id, { isPolling: true });
      startPollingInternal(tab.id);
      return;
    }
    if (!tab.session.connected) {
      updateTab(tab.id, { lastError: NOT_CONNECTED });
      return;
    }
    stopRealPidLoop();
    updateTab(tab.id, { isPolling: true, livePidErrors: new Map() });
    void realPidLoop(tab.id, pidGen);
  },

  stopPolling(): void {
    haltPidPolling();
  },

  async readDid(did: number): Promise<void> {
    await readDidOn(raw.activeTabId, did);
  },

  async readAllDids(): Promise<void> {
    const tabId = raw.activeTabId; // the whole sweep stays on this tab even if the user switches
    for (const def of DID_CATALOG) {
      if (!getTab(tabId)?.session.connected) break;
      await readDidOn(tabId, def.did);
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
    retry: BusyRetryOptions | null = null,
  ): Promise<UdsExchange | null> {
    return sendUdsOn(raw.activeTabId, sid, subFn, data, addressing, origin, retry);
  },

  /**
   * Honest ReadDataByIdentifier: never falls back to demo data. Throws UdsTransportError.
   * Returns the DID data record ONLY (contract: `DidReadResultDto.raw` excludes 0x62 and the DID echo).
   * `tabId` pins the request to one session (default: the active tab at call time).
   */
  async readDidStrict(did: number, origin: DiagOrigin = 'other', tabId: string = raw.activeTabId): Promise<number[]> {
    const tab = getTab(tabId);
    if (!tab || !tab.session.connected || raw.mockMode) {
      throw new UdsTransportError('notConnected', formatDiagError(t, NOT_CONNECTED), NOT_CONNECTED);
    }
    try {
      const result = await diagInvoke('cmd_diag_read_did', { config: toDiagDto(tab.session.config), did, origin });
      if (!result || !Array.isArray(result.raw)) {
        throw new UdsTransportError('failed', 'Malformed cmd_diag_read_did response');
      }
      touchResponse(tabId);
      return result.raw;
    } catch (err) {
      throw err instanceof UdsTransportError ? err : strictError(tabId, err);
    }
  },

  /**
   * Honest raw UDS request for the UDS Panel. Never mocks. Throws UdsTransportError (including for
   * negative responses). Returns the positive response payload AFTER the SID echo (e.g. the data
   * record of `0x63` ReadMemoryByAddress); empty for suppressed responses.
   * Conversation logging is done by the backend; `options.record` is kept for API compatibility only;
   * `options.origin` tags the transaction (default 'other'); `options.tabId` pins one session.
   *
   * Per-request options (all optional, absent = the previous behaviour: physical, backend P2 timing,
   * no busy retry):
   * - `addressing: 'functional'` uses the tab config's `functionalId` (e.g. 0x7DF). Without one the
   *   call THROWS before anything is sent (never a silent physical fallback). Functional requests
   *   must fit one single frame; the backend returns the FIRST matching response (the first ECU to
   *   answer), and never applies a 0x21 busy retry (it would re-broadcast to every ECU).
   * - Suppressed positive response (SPR bit set in the sub-function byte by the caller): the backend
   *   listens for P2 only for a possible negative response; on silence it resolves with
   *   `suppressed: true, raw: []`, so this returns `[]`.
   * - `timeoutMs`: whole-exchange budget (e.g. 30000 for an erase routine), `null` = backend P2/P2*.
   * - `busyRetry`: NRC 0x21 busyRepeatRequest retries (physical only).
   */
  async sendUdsStrict(
    sid: number,
    data: readonly number[],
    options: {
      record: boolean;
      origin?: DiagOrigin;
      tabId?: string;
      addressing?: UdsAddressing;
      timeoutMs?: number | null;
      busyRetry?: BusyRetryOptions | null;
    } = { record: true },
  ): Promise<number[]> {
    const tabId = options.tabId ?? raw.activeTabId;
    const tab = getTab(tabId);
    if (!tab || !tab.session.connected || raw.mockMode) {
      throw new UdsTransportError('notConnected', formatDiagError(t, NOT_CONNECTED), NOT_CONNECTED);
    }
    const addressing: UdsAddressing = options.addressing ?? 'physical';
    if (addressing === 'functional' && (tab.session.config.functionalId ?? null) === null) {
      throw new UdsTransportError('failed', t('udsFlow.err.noFunctionalId'));
    }
    const timeoutMs = options.timeoutMs !== undefined && options.timeoutMs !== null && options.timeoutMs > 0
      ? Math.round(options.timeoutMs)
      : null;
    try {
      const r = await diagInvoke('cmd_diag_send_uds', {
        config: toDiagDto(tab.session.config),
        sid,
        subFunction: null,
        data: [...data],
        options: {
          addressing,
          timeoutMs,
          origin: options.origin ?? 'other',
          ...busyRetryFields(addressing === 'physical' ? (options.busyRetry ?? null) : null),
        },
      });
      if (!r || !Array.isArray(r.raw)) {
        throw new UdsTransportError('failed', 'Malformed cmd_diag_send_uds response');
      }
      touchResponse(tabId);
      if (!r.positive) {
        const diag: DiagUiError = { code: 'negative_response', message: nrcText(r) };
        throw new UdsTransportError('failed', formatDiagError(t, diag), diag);
      }
      return r.raw.slice(1);
    } catch (err) {
      throw err instanceof UdsTransportError ? err : strictError(tabId, err);
    }
  },

  clearConversation(): void {
    updateTab(raw.activeTabId, { conversation: [] });
  },

  /** Clears both the conversation log and the ISO-TP frame tap (Traffic Dock "Clear"). */
  clearTraffic(): void {
    const tabId = raw.activeTabId;
    rtOf(tabId).isotpReassembler.reset();
    updateTab(tabId, { conversation: [], isotpFrames: [] });
  },

  /** "Resend in Console": queue a composer prefill; `UdsConsole` applies it once (on mount or change). */
  setConsoleDraft(draft: Omit<ConsoleDraft, 'nonce'>): void {
    updateTab(raw.activeTabId, { consoleDraft: { ...draft, nonce: ++consoleDraftNonce } });
  },

  clearConsoleDraft(): void {
    const tab = activeTabOf(raw);
    if (tab.consoleDraft !== null) updateTab(tab.id, { consoleDraft: null });
  },

  clearIsoTpFrames(): void {
    const tabId = raw.activeTabId;
    rtOf(tabId).isotpReassembler.reset();
    updateTab(tabId, { isotpFrames: [] });
  },
};

// ─── Tab-pinned command implementations (capture `tabId` at call start, write back to THAT tab) ──

async function readDidOn(tabId: string, did: number): Promise<void> {
  const tab = getTab(tabId);
  if (!tab || !tab.session.connected) {
    updateTab(tabId, { lastError: NOT_CONNECTED });
    return;
  }

  if (raw.mockMode) {
    const reqBytes = [0x22, (did >> 8) & 0xff, did & 0xff];
    const reqTs = Date.now() * 1000;
    const reqSeq = demoEvent(tabId, 'request', { sid: 0x22, bytes: reqBytes, origin: 'did', timestampUs: reqTs });
    await new Promise<void>((r) => setTimeout(r, 80));
    const entry = makeMockDidValue(did);
    updateTab(tabId, (cur) => {
      const nextDidValues = new Map(cur.didValues);
      nextDidValues.set(did, entry);
      return { didValues: nextDidValues, session: { ...cur.session, lastResponseMs: Date.now() } };
    });
    const rspBytes = [0x62, (did >> 8) & 0xff, did & 0xff, ...entry.raw];
    const rspTs = Date.now() * 1000;
    demoIsoTpExchange(tabId, reqSeq, reqBytes, rspBytes, reqTs, rspTs);
    demoEvent(tabId, 'response', {
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
    const result = await diagInvoke('cmd_diag_read_did', { config: toDiagDto(tab.session.config), did, origin: 'did' });
    // Same decoder as the UDS Console (`interpretUdsResponse`): never trust a second, divergent decode.
    const entry: DidValueEntry = {
      did,
      raw: result.raw,
      decoded: decodeDidValue(did, result.raw),
      timestampMs: Date.now(),
    };
    updateTab(tabId, (cur) => {
      const nextDidValues = new Map(cur.didValues);
      nextDidValues.set(did, entry);
      const nextErrors = new Map(cur.didErrors);
      nextErrors.delete(did);
      return { didValues: nextDidValues, didErrors: nextErrors };
    });
    touchResponse(tabId);
  } catch (err) {
    const e = handleCommandError(tabId, err);
    updateTab(tabId, (cur) => {
      const nextErrors = new Map(cur.didErrors);
      nextErrors.set(did, e);
      return { didErrors: nextErrors };
    });
  }
}

async function sendUdsOn(
  tabId: string,
  sid: number,
  subFn: number | null,
  data: readonly number[],
  addressing: UdsAddressing,
  origin: DiagOrigin,
  retry: BusyRetryOptions | null = null,
): Promise<UdsExchange | null> {
  const tab = getTab(tabId);
  if (!tab || !tab.session.connected) {
    updateTab(tabId, { lastError: NOT_CONNECTED });
    return null;
  }
  const requestBytes = [sid, ...(subFn !== null ? [subFn] : []), ...data];

  if (raw.mockMode) {
    const reqTs = Date.now() * 1000;
    const reqSeq = demoEvent(tabId, 'request', { sid, bytes: requestBytes, addressing, origin, timestampUs: reqTs });
    await new Promise<void>((r) => setTimeout(r, 65));
    const responseSid = (sid + 0x40) & 0xff;
    const rawBytes = [responseSid, ...(subFn !== null ? [subFn & 0x7f] : []), 0x00];
    const rspTs = Date.now() * 1000;
    const response: UdsResponseDto = {
      raw: rawBytes,
      positive: true,
      suppressed: false,
      nrc: null,
      nrcName: null,
      responsePendingCount: 0,
      elapsedUs: rspTs - reqTs,
      transactionSeq: reqSeq,
    };
    demoIsoTpExchange(tabId, reqSeq, requestBytes, rawBytes, reqTs, rspTs);
    demoEvent(tabId, 'response', {
      sid: responseSid,
      bytes: rawBytes,
      requestSeq: reqSeq,
      elapsedUs: rspTs - reqTs,
      addressing,
      origin,
      timestampUs: rspTs,
    });
    const exchange: UdsExchange = { id: ++exchangeSeq, atMs: Date.now(), requestBytes, addressing, response, error: null };
    updateTab(tabId, (cur) => ({ lastUds: exchange, session: { ...cur.session, lastResponseMs: Date.now() } }));
    return exchange;
  }

  try {
    const response = await diagInvoke('cmd_diag_send_uds', {
      config: toDiagDto(tab.session.config),
      sid,
      subFunction: subFn,
      data: [...data],
      options: { addressing, timeoutMs: null, origin, ...busyRetryFields(retry) },
    });
    const exchange: UdsExchange = { id: ++exchangeSeq, atMs: Date.now(), requestBytes, addressing, response, error: null };
    updateTab(tabId, { lastUds: exchange, lastError: null });
    touchResponse(tabId);
    refreshSessionInfoSoon(tabId);
    return exchange;
  } catch (err) {
    const e = handleCommandError(tabId, err);
    const exchange: UdsExchange = { id: ++exchangeSeq, atMs: Date.now(), requestBytes, addressing, response: null, error: e };
    updateTab(tabId, { lastUds: exchange });
    return exchange;
  }
}

function strictError(tabId: string, err: unknown): UdsTransportError {
  const e = handleCommandError(tabId, err);
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
    () => selector(view()),
    () => selector(view()),
  );
}

/**
 * Panic Stop (TX source registry): halts OBD-II PID polling, abandons in-flight discovery / DTC
 * scans (their late results are dropped) and switches the TesterPresent keep-alive off on EVERY tab.
 * Synchronous; the backend calls to disable TesterPresent are fire-and-forget (the backend panic also
 * disarms). Sessions stay "connected" in the HMI: the next command reports `panic_latched` and
 * `markLost` then drops every tab on that bus.
 */
function stopDiagnosticsTx(): void {
  haltPidPolling();
  diagOpGen += 1;
  const stopTp: DiagSessionConfigDto[] = [];
  const tabs = raw.tabs.map((tab) => {
    const patch: Partial<DiagSessionTab> = {};
    if (tab.isScanning) patch.isScanning = false;
    if (tab.dtcReportBusy) patch.dtcReportBusy = false;
    if (tab.session.testerPresentActive) {
      patch.session = { ...tab.session, testerPresentActive: false };
      if (!raw.mockMode && tab.session.connected) stopTp.push(toDiagDto(tab.session.config));
    }
    return Object.keys(patch).length > 0 ? { ...tab, ...patch } : tab;
  });
  const changed = tabs.some((tab, i) => tab !== raw.tabs[i]);
  if (changed || raw.discovering) {
    setRaw({ ...raw, tabs, discovering: false });
  }
  for (const config of stopTp) {
    diagInvoke('cmd_diag_set_tester_present', { config, enabled: false, intervalMs: null }).catch(() => undefined);
  }
}

registerTxSource('diagnostics', stopDiagnosticsTx);
