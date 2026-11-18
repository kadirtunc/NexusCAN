import { useSyncExternalStore } from 'react';
import { logUiDebugEvent } from './debugConsoleStore';
import type { DatabaseSchemaDto } from '../types/netdb';
import type {
  ChronologicalFrameDto,
  FrameTelemetryDto,
  LiveSignalDto,
  TelemetrySnapshotDto,
} from '../types/telemetry';
import { connectionStore } from './connectionStore';
import { type ActiveDocumentTab, databaseStore } from './databaseStore';
import { type NexusProjectFileV1, type QuickBarConnectionState, projectStore } from './projectStore';
import { telemetryStore } from './telemetryStore';
import type {
  DatabaseVersionDto,
  NetworkDatabaseSummaryDto,
  SimulationPanelDto,
} from '../types/simulation';
import {
  type CloudProjectBindingV1,
  computeWorkspaceSemanticHash,
  sanitizeCloudWorkspaceForLocalApply,
  validateAndNormalizeWorkspaceJson,
} from '../utils/workspaceDiff';
import {
  type EngineeringToolpackId,
  normalizeEnabledToolpacks,
} from '../types/toolpacks';

export type CloudBridgeStatus =
  | 'disconnected'
  | 'authenticating'
  | 'connecting_ws'
  | 'streaming'
  | 'error';

export type CloudBridgeTargetHz = 2 | 10 | 15 | 20 | 30 | 60;

export type CloudOrgRole = 'owner' | 'admin' | 'engineer' | 'viewer';

export interface CloudOrganizationItem {
  id: string;
  name: string;
  slug: string;
  myRole: CloudOrgRole;
}

export interface CloudProjectItem {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  code: string;
  defaultProtocol: 'CAN' | 'CAN_FD' | 'J1939';
  description?: string;
  vehiclePlatform?: string;
  latestRevisionNumber?: number | null;
  updatedAt?: string | null;
  hasWorkspace?: boolean;
}

export interface PullableCloudDatabaseItem {
  key: string;
  source: 'managed' | 'workspace';
  databaseId?: string;
  versionId?: string;
  name: string;
  fileName: string;
  format: 'dbc' | 'kcd';
  sizeBytes: number;
  messageCount: number | null;
  signalCount: number | null;
  embeddedBase64?: string;
}

export interface CloudPushPromptContext {
  reason: 'opened_project' | 'new_project' | 'manual';
  projectName: string;
}

export function suggestCloudProjectCode(projectName: string): string {
  if (!projectName || !projectName.trim()) {
    return 'NXC-01';
  }
  const normalized = projectName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/İ/g, 'I');

  const words = normalized
    .replace(/[^A-Z0-9]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    return 'NXC-01';
  }

  let code = words
    .map((w) => (words.length > 1 && w.length > 5 && !/^\d+$/.test(w) ? w.slice(0, 3) : w))
    .join('-');

  code = code.replace(/[^A-Z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');

  if (code.length > 16) {
    code = code.slice(0, 16).replace(/-+$/, '');
  }

  return code.length >= 2 ? code : 'NXC-01';
}

export function toCloudCompatibleWorkspace(
  rawSnapshot: NexusProjectFileV1,
): NexusProjectFileV1 {
  let mappedTab: ActiveDocumentTab = rawSnapshot.workspace.activeDocTab;
  if (mappedTab === 'start') {
    mappedTab = 'rxtx';
  } else if ((mappedTab as string) === 'panels') {
    mappedTab = 'cloud';
  }

  const traceMaxBufferRows = Math.max(
    100,
    rawSnapshot.workspace.traceMaxBufferRows ?? 100,
  );

  const mappedPlotter = rawSnapshot.plotter
    ? {
        ...rawSnapshot.plotter,
        layoutMode:
          rawSnapshot.plotter.layoutMode === 'compactSplit'
            ? ('split' as const)
            : rawSnapshot.plotter.layoutMode,
      }
    : rawSnapshot.plotter;

  return {
    ...rawSnapshot,
    plotter: mappedPlotter,
    workspace: {
      ...rawSnapshot.workspace,
      activeDocTab: mappedTab,
      traceMaxBufferRows,
      enabledToolpacks: normalizeEnabledToolpacks(rawSnapshot.workspace.enabledToolpacks),
    },
  };
}

export interface CloudBridgeHeaderSlice {
  modalOpen: boolean;
  status: CloudBridgeStatus;
  cloudCapturing: boolean;
  targetHz: CloudBridgeTargetHz;
  selectedProjectName: string | null;
  streamId: string | null;
  cloudBaseUrl: string;
  errorMessage: string | null;
  remoteUpdateAvailableRev: number | null;
  hasConflict: boolean;
  isAuthenticated: boolean;
  userEmail: string;
  userFullName: string;
  syncingWorkspace: boolean;
  hasPushPrompt: boolean;
  organizations: readonly CloudOrganizationItem[];
  selectedOrgId: string | null;
  selectedOrgName: string | null;
  selectedOrgSlug: string | null;
  selectedOrgRole: CloudOrgRole | null;
}

export interface CloudBridgeStoreState {
  modalOpen: boolean;
  status: CloudBridgeStatus;
  errorMessage: string | null;
  pushPromptContext: CloudPushPromptContext | null;

  // Persisted session & connection settings
  cloudBaseUrl: string;
  autoConnect: boolean;
  userEmail: string;
  userFullName: string;
  sessionToken: string | null;
  organizations: readonly CloudOrganizationItem[];
  projects: readonly CloudProjectItem[];
  selectedOrgId: string | null;
  selectedProjectId: string | null;
  selectedProjectName: string | null;
  selectedProjectSlug: string | null;
  bridgeToken: string | null;
  deviceId: string | null;
  deviceName: string | null;
  streamId: string | null;

  // Live streaming & Read-Only Cloud state
  desiredHz: CloudBridgeTargetHz;
  targetHz: CloudBridgeTargetHz;
  rateControlReason: string | null;
  cloudCapturing: boolean;
  activeCaptureSessionId: string | null;
  activeCaptureSessionName: string | null;
  capturedFramesCount: number;
  sentSnapshotsCount: number;
  latencyMs: number;
  schemaSyncedName: string | null;
  schemaAckStatus: 'idle' | 'synced' | 'known' | 'upload_required';

  // Workspace (.nexusproj.json) sync & Cloud Workspace Tab state
  syncingWorkspace: boolean;
  lastWorkspaceSyncAt: string | null;
  lastWorkspaceRevisionNumber: number | null;

  inspectedProjectId: string | null;
  loadingProjects: boolean;
  loadingRemoteWorkspace: boolean;
  remoteWorkspace: NexusProjectFileV1 | null;
  remoteRevisionNumber: number | null;
  remoteRevisionMeta: {
    revisionNumber: number;
    commitMessage: string | null;
    updatedAt: string | null;
    updatedBy: string | null;
    contentSha256: string | null;
  } | null;
  remoteUpdateAvailableRev: number | null;
  conflictState: {
    remoteRevisionNumber: number | null;
    message: string;
  } | null;
}

interface PersistedCloudSessionV1 {
  version: 1;
  cloudBaseUrl: string;
  autoConnect: boolean;
  userEmail: string;
  userFullName: string;
  sessionToken: string | null;
  organizations: CloudOrganizationItem[];
  projects: CloudProjectItem[];
  selectedOrgId: string | null;
  selectedProjectId: string | null;
  selectedProjectName: string | null;
  selectedProjectSlug: string | null;
  bridgeToken: string | null;
  deviceId: string | null;
  deviceName: string | null;
  streamId: string | null;
  desiredHz: CloudBridgeTargetHz;
}

const STORAGE_KEY = 'nexuscan:cloudBridgeSession:v1';
const DEFAULT_CLOUD_URL = 'http://localhost:3000';
const MAX_WS_BUFFERED_BYTES = 512_000;
const HEARTBEAT_INTERVAL_MS = 2_000;
const STANDBY_IDLE_SNAPSHOT_THRESHOLD_MS = 1_500;
const COUNTER_NOTIFY_THROTTLE_MS = 250;

const VALID_TARGET_HZ = new Set<number>([2, 10, 15, 20, 30, 60]);

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export function normalizeCloudBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return DEFAULT_CLOUD_URL;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  // Cloud is experimental; scheme-less input defaults to TLS.
  return `https://${trimmed}`;
}

function buildBridgeWebSocketUrl(
  cloudBaseUrl: string,
  bridgeToken: string,
  streamId: string,
): string {
  const normalized = normalizeCloudBaseUrl(cloudBaseUrl);
  const wsOrigin = normalized.replace(/^http/i, 'ws');
  const params = new URLSearchParams({
    token: bridgeToken,
    streamId,
  });
  return `${wsOrigin}/api/bridge/ws?${params.toString()}`;
}

function resolveHostOs(): string {
  if (typeof navigator === 'undefined') {
    return 'Desktop';
  }
  const ua = navigator.userAgent || '';
  if (ua.includes('Windows')) return 'Windows Desktop';
  if (ua.includes('Linux')) return 'Linux Workstation';
  if (ua.includes('Mac')) return 'macOS Workstation';
  return navigator.platform || 'Desktop';
}

function resolveHostname(): string {
  if (typeof window === 'undefined') {
    return 'workstation';
  }
  return window.location.hostname || 'workstation';
}

function resolveAdapterSummary(): string {
  const header = telemetryStore.getHeaderSlice();
  const activeBus = header.buses.find((b) => b.connected);
  if (activeBus && activeBus.channelName.trim().length > 0) {
    return `${activeBus.channelName}${activeBus.listenOnly ? ' (Listen-Only)' : ''}`;
  }
  const firstProfile = connectionStore.getState().profiles[0];
  if (firstProfile) {
    return `${firstProfile.name} (Listen-Only Mirror)`;
  }
  return 'NexusCAN Live Listen-Only Bridge';
}

function loadPersistedSession(): Partial<PersistedCloudSessionV1> {
  if (typeof window === 'undefined') {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed) || parsed.version !== 1) {
      return {};
    }
    return {
      cloudBaseUrl:
        typeof parsed.cloudBaseUrl === 'string'
          ? normalizeCloudBaseUrl(parsed.cloudBaseUrl)
          : DEFAULT_CLOUD_URL,
      autoConnect: Boolean(parsed.autoConnect),
      userEmail: typeof parsed.userEmail === 'string' ? parsed.userEmail : '',
      userFullName: typeof parsed.userFullName === 'string' ? parsed.userFullName : '',
      sessionToken: typeof parsed.sessionToken === 'string' ? parsed.sessionToken : null,
      organizations: Array.isArray(parsed.organizations)
        ? (parsed.organizations as CloudOrganizationItem[])
        : [],
      projects: Array.isArray(parsed.projects)
        ? (parsed.projects as CloudProjectItem[])
        : [],
      selectedOrgId: typeof parsed.selectedOrgId === 'string' ? parsed.selectedOrgId : null,
      selectedProjectId:
        typeof parsed.selectedProjectId === 'string' ? parsed.selectedProjectId : null,
      selectedProjectName:
        typeof parsed.selectedProjectName === 'string' ? parsed.selectedProjectName : null,
      selectedProjectSlug:
        typeof parsed.selectedProjectSlug === 'string' ? parsed.selectedProjectSlug : null,
      bridgeToken: typeof parsed.bridgeToken === 'string' ? parsed.bridgeToken : null,
      deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : null,
      deviceName: typeof parsed.deviceName === 'string' ? parsed.deviceName : null,
      streamId: typeof parsed.streamId === 'string' ? parsed.streamId : null,
      desiredHz:
        typeof parsed.desiredHz === 'number' && VALID_TARGET_HZ.has(parsed.desiredHz)
          ? (parsed.desiredHz as CloudBridgeTargetHz)
          : 20,
    };
  } catch {
    return {};
  }
}

const persisted = loadPersistedSession();

let currentState: CloudBridgeStoreState = {
  modalOpen: false,
  status: 'disconnected',
  errorMessage: null,
  pushPromptContext: null,

  cloudBaseUrl: persisted.cloudBaseUrl ?? DEFAULT_CLOUD_URL,
  autoConnect: persisted.autoConnect ?? false,
  userEmail: persisted.userEmail ?? '',
  userFullName: persisted.userFullName ?? '',
  sessionToken: persisted.sessionToken ?? null,
  organizations: persisted.organizations ?? [],
  projects: persisted.projects ?? [],
  selectedOrgId: persisted.selectedOrgId ?? null,
  selectedProjectId: persisted.selectedProjectId ?? null,
  selectedProjectName: persisted.selectedProjectName ?? null,
  selectedProjectSlug: persisted.selectedProjectSlug ?? null,
  bridgeToken: persisted.bridgeToken ?? null,
  deviceId: persisted.deviceId ?? null,
  deviceName: persisted.deviceName ?? null,
  streamId: persisted.streamId ?? null,

  desiredHz: persisted.desiredHz ?? 20,
  targetHz: persisted.desiredHz ?? 20,
  rateControlReason: null,
  cloudCapturing: false,
  activeCaptureSessionId: null,
  activeCaptureSessionName: null,
  capturedFramesCount: 0,
  sentSnapshotsCount: 0,
  latencyMs: 0,
  schemaSyncedName: null,
  schemaAckStatus: 'idle',

  syncingWorkspace: false,
  lastWorkspaceSyncAt: null,
  lastWorkspaceRevisionNumber: null,

  inspectedProjectId: persisted.selectedProjectId ?? null,
  loadingProjects: false,
  loadingRemoteWorkspace: false,
  remoteWorkspace: null,
  remoteRevisionNumber: null,
  remoteRevisionMeta: null,
  remoteUpdateAvailableRev: null,
  conflictState: null,
};

function resolveSelectedOrg(state: CloudBridgeStoreState): {
  orgName: string | null;
  orgSlug: string | null;
  orgRole: CloudOrgRole | null;
} {
  const org =
    state.organizations.find((o) => o.id === state.selectedOrgId) ??
    state.organizations[0] ??
    null;
  return {
    orgName: org?.name ?? null,
    orgSlug: org?.slug ?? null,
    orgRole: org?.myRole ?? null,
  };
}

const initialOrg = resolveSelectedOrg(currentState);

let headerSlice: CloudBridgeHeaderSlice = {
  modalOpen: currentState.modalOpen,
  status: currentState.status,
  cloudCapturing: currentState.cloudCapturing,
  targetHz: currentState.targetHz,
  selectedProjectName: currentState.selectedProjectName,
  streamId: currentState.streamId,
  cloudBaseUrl: currentState.cloudBaseUrl,
  errorMessage: currentState.errorMessage,
  remoteUpdateAvailableRev: currentState.remoteUpdateAvailableRev,
  hasConflict: false,
  isAuthenticated: Boolean(currentState.sessionToken),
  userEmail: currentState.userEmail,
  userFullName: currentState.userFullName,
  syncingWorkspace: currentState.syncingWorkspace,
  hasPushPrompt: Boolean(currentState.pushPromptContext),
  organizations: currentState.organizations,
  selectedOrgId: currentState.selectedOrgId,
  selectedOrgName: initialOrg.orgName,
  selectedOrgSlug: initialOrg.orgSlug,
  selectedOrgRole: initialOrg.orgRole,
};

const fullListeners = new Set<() => void>();
const headerListeners = new Set<() => void>();

let activeWs: WebSocket | null = null;
let shouldMaintainConnection = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let counterNotifyTimer: ReturnType<typeof setTimeout> | null = null;
let lastLiveSnapshotSentAtPerfMs = 0;
let syntheticSeqCounter = 1;
let storesBound = false;
let lifecycleInitialized = false;
let prevConnectedBusCount = 0;
let recoveryProvisionAttempted = false;

function persistCurrentSession(): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: PersistedCloudSessionV1 = {
      version: 1,
      cloudBaseUrl: currentState.cloudBaseUrl,
      autoConnect: currentState.autoConnect,
      userEmail: currentState.userEmail,
      userFullName: currentState.userFullName,
      sessionToken: currentState.sessionToken,
      organizations: [...currentState.organizations],
      projects: [...currentState.projects],
      selectedOrgId: currentState.selectedOrgId,
      selectedProjectId: currentState.selectedProjectId,
      selectedProjectName: currentState.selectedProjectName,
      selectedProjectSlug: currentState.selectedProjectSlug,
      bridgeToken: currentState.bridgeToken,
      deviceId: currentState.deviceId,
      deviceName: currentState.deviceName,
      streamId: currentState.streamId,
      desiredHz: currentState.desiredHz,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage quota errors
  }
}

function syncHeaderSliceAndNotify(): void {
  const hasConflict = Boolean(currentState.conflictState);
  const isAuthenticated = Boolean(currentState.sessionToken);
  const hasPushPrompt = Boolean(currentState.pushPromptContext);
  const { orgName, orgSlug, orgRole } = resolveSelectedOrg(currentState);

  const changed =
    headerSlice.modalOpen !== currentState.modalOpen ||
    headerSlice.status !== currentState.status ||
    headerSlice.cloudCapturing !== currentState.cloudCapturing ||
    headerSlice.targetHz !== currentState.targetHz ||
    headerSlice.selectedProjectName !== currentState.selectedProjectName ||
    headerSlice.streamId !== currentState.streamId ||
    headerSlice.cloudBaseUrl !== currentState.cloudBaseUrl ||
    headerSlice.errorMessage !== currentState.errorMessage ||
    headerSlice.remoteUpdateAvailableRev !== currentState.remoteUpdateAvailableRev ||
    headerSlice.hasConflict !== hasConflict ||
    headerSlice.isAuthenticated !== isAuthenticated ||
    headerSlice.userEmail !== currentState.userEmail ||
    headerSlice.userFullName !== currentState.userFullName ||
    headerSlice.syncingWorkspace !== currentState.syncingWorkspace ||
    headerSlice.hasPushPrompt !== hasPushPrompt ||
    headerSlice.selectedOrgId !== currentState.selectedOrgId ||
    headerSlice.organizations !== currentState.organizations ||
    headerSlice.selectedOrgName !== orgName ||
    headerSlice.selectedOrgSlug !== orgSlug ||
    headerSlice.selectedOrgRole !== orgRole;

  if (!changed) return;

  headerSlice = {
    modalOpen: currentState.modalOpen,
    status: currentState.status,
    cloudCapturing: currentState.cloudCapturing,
    targetHz: currentState.targetHz,
    selectedProjectName: currentState.selectedProjectName,
    streamId: currentState.streamId,
    cloudBaseUrl: currentState.cloudBaseUrl,
    errorMessage: currentState.errorMessage,
    remoteUpdateAvailableRev: currentState.remoteUpdateAvailableRev,
    hasConflict,
    isAuthenticated,
    userEmail: currentState.userEmail,
    userFullName: currentState.userFullName,
    syncingWorkspace: currentState.syncingWorkspace,
    hasPushPrompt,
    organizations: currentState.organizations,
    selectedOrgId: currentState.selectedOrgId,
    selectedOrgName: orgName,
    selectedOrgSlug: orgSlug,
    selectedOrgRole: orgRole,
  };
  for (const fn of headerListeners) {
    fn();
  }
}

function emitFullChange(): void {
  syncHeaderSliceAndNotify();
  for (const fn of fullListeners) {
    fn();
  }
}

function scheduleThrottledCounterEmit(): void {
  if (fullListeners.size === 0) {
    return;
  }
  if (counterNotifyTimer !== null) {
    return;
  }
  counterNotifyTimer = setTimeout(() => {
    counterNotifyTimer = null;
    currentState = { ...currentState };
    for (const fn of fullListeners) {
      fn();
    }
  }, COUNTER_NOTIFY_THROTTLE_MS);
}

function clearTimers(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (counterNotifyTimer !== null) {
    clearTimeout(counterNotifyTimer);
    counterNotifyTimer = null;
  }
}

function closeActiveSocketCleanly(reason = 'CLIENT_DISCONNECT'): void {
  const ws = activeWs;
  activeWs = null;
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, reason);
      }
    } catch {
      // Ignore close error
    }
  }
}

/**
 * Builds a valid `TelemetrySnapshotDto` representing the live or standby desktop state
 * so `NexusCANCloud` immediately displays the session, bus health, FPS, and signals
 * even before `mock0` or a physical CAN adapter is connected.
 */
function buildStandbyOrCurrentSnapshot(): TelemetrySnapshotDto {
  const latestRaw = telemetryStore.getLatestRawSnapshot();
  const header = telemetryStore.getHeaderSlice();
  const framesSlice = telemetryStore.getFramesSlice();
  const connectedBuses = header.buses.filter((b) => b.connected);

  if (connectedBuses.length > 0 && latestRaw) {
    return {
      ...latestRaw,
      frames: coalesceFramesForCloudSnapshot(latestRaw.frames),
    };
  }

  const seq = header.seq > 0 ? header.seq : syntheticSeqCounter++;
  const nowUs = Math.max(0, Math.round(performance.now() * 1_000));

  return {
    seq,
    timestampUs: header.timestampUs > 0 ? header.timestampUs : nowUs,
    fpsRx: connectedBuses.length > 0 ? Math.max(0, header.fpsRx) : 0,
    fpsTx: connectedBuses.length > 0 ? Math.max(0, header.fpsTx) : 0,
    estimatedBusLoadPct:
      connectedBuses.length > 0
        ? Math.min(100, Math.max(0, header.estimatedBusLoadPct))
        : 0,
    totalFramesRx: Math.max(0, header.totalFramesRx),
    totalFramesTx: Math.max(0, header.totalFramesTx),
    droppedFrames: Math.max(0, header.droppedFrames),
    activeIdsCount:
      connectedBuses.length > 0 ? Math.max(0, header.activeIdsCount) : framesSlice.frames.length,
    decodedSignalsCount:
      connectedBuses.length > 0 ? Math.max(0, header.decodedSignalsCount) : 0,
    txPanicLatched: header.txPanicLatched,
    buses: [...header.buses],
    frames: connectedBuses.length > 0 ? [...framesSlice.frames] : [],
    recentChronological: [],
  };
}

function sendJsonOverWs(payload: Record<string, unknown>): boolean {
  const ws = activeWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  if (ws.bufferedAmount >= MAX_WS_BUFFERED_BYTES) {
    // Drop outbound frame rather than ever backpressuring local 60 FPS NexusCAN UI
    return false;
  }
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function pushSchemaUpdateToCloud(schema: DatabaseSchemaDto | null): void {
  const sent = sendJsonOverWs({
    type: 'BRIDGE_SCHEMA_UPDATE',
    schema,
    activeDbName: schema ? schema.info.name : 'Unassigned',
  });
  if (sent) {
    currentState = {
      ...currentState,
      schemaSyncedName: schema ? schema.info.name : null,
      schemaAckStatus: schema ? 'synced' : 'idle',
    };
    emitFullChange();
  }
}

const MAX_PENDING_CLOUD_CHRONO = 320;
let pendingOutboundChrono: ChronologicalFrameDto[] = [];
let lastPingSentPerfMs = 0;

/**
 * Coalesces multi-row multiplexed frames (e.g. `STD:0x105` pages `m0..m3`) into a single
 * authoritative `FrameTelemetryDto` per `messageKey` for `NexusCANCloud`:
 * - Guarantees `frameByKey[messageKey]` always displays the newest mux frame (`lastTimestampUs`),
 * - Prevents duplicate mux-switch `signalId` samples from pushing 4 conflicting values at the
 *   same `tSec` into Cloud's live oscilloscope,
 * - Preserves Retained Mux State across all inactive mux pages (`activeInLastFrame: false`).
 */
function coalesceFramesForCloudSnapshot(
  frames: readonly FrameTelemetryDto[],
): FrameTelemetryDto[] {
  if (frames.length <= 1) {
    return [...frames];
  }

  // Fast path: check if any duplicate messageKey exists
  const seenKeys = new Set<string>();
  let hasDuplicateKey = false;
  for (let i = 0; i < frames.length; i++) {
    const mk = frames[i].messageKey;
    if (seenKeys.has(mk)) {
      hasDuplicateKey = true;
      break;
    }
    seenKeys.add(mk);
  }
  if (!hasDuplicateKey) {
    return [...frames];
  }

  const groups = new Map<string, FrameTelemetryDto[]>();
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const existing = groups.get(f.messageKey);
    if (existing) {
      existing.push(f);
    } else {
      groups.set(f.messageKey, [f]);
    }
  }

  const out: FrameTelemetryDto[] = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      out.push(list[0]);
      continue;
    }

    // Sort oldest -> newest so newest mux page wins rawBytes, lastTimestampUs, activeMuxSwitches, and switch signals
    const sorted = [...list].sort((a, b) => a.lastTimestampUs - b.lastTimestampUs);
    const newest = sorted[sorted.length - 1];
    let totalRxCount = 0;
    const mergedSignals = new Map<number, LiveSignalDto>();

    for (let i = 0; i < sorted.length; i++) {
      const row = sorted[i];
      totalRxCount += row.rxCount;
      const isNewestRow = i === sorted.length - 1;
      for (let j = 0; j < row.signals.length; j++) {
        const sig = row.signals[j];
        mergedSignals.set(
          sig.signalId,
          isNewestRow
            ? sig
            : {
                ...sig,
                activeInLastFrame: false,
              },
        );
      }
    }

    out.push({
      ...newest,
      rxCount: totalRxCount,
      signals: Array.from(mergedSignals.values()),
    });
  }

  return out;
}

function handleOutboundSnapshot(snap: TelemetrySnapshotDto, isLiveStreamTick: boolean): void {
  const ws = activeWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    pendingOutboundChrono = [];
    return;
  }

  const nowPerf = performance.now();

  // Background-tab immune heartbeat: piggyback 2s RTT PING on incoming native I/O wakeups
  if (isLiveStreamTick && nowPerf - lastPingSentPerfMs >= HEARTBEAT_INTERVAL_MS) {
    lastPingSentPerfMs = nowPerf;
    sendJsonOverWs({
      type: 'PING',
      timestampMs: Date.now(),
      latencyMs: currentState.latencyMs,
    });
  }

  if (snap.recentChronological.length > 0) {
    if (pendingOutboundChrono.length === 0) {
      pendingOutboundChrono = [...snap.recentChronological];
    } else {
      pendingOutboundChrono.push(...snap.recentChronological);
    }
    if (pendingOutboundChrono.length > MAX_PENDING_CLOUD_CHRONO) {
      pendingOutboundChrono = pendingOutboundChrono.slice(
        pendingOutboundChrono.length - MAX_PENDING_CLOUD_CHRONO,
      );
    }
  }

  if (isLiveStreamTick) {
    const effectiveHz = currentState.targetHz;
    const minIntervalMs = 1_000 / effectiveHz;
    if (nowPerf - lastLiveSnapshotSentAtPerfMs < minIntervalMs - 1.5) {
      return;
    }
  }

  if (ws.bufferedAmount >= MAX_WS_BUFFERED_BYTES) {
    return;
  }

  const outboundSnap: TelemetrySnapshotDto = {
    ...snap,
    frames: coalesceFramesForCloudSnapshot(snap.frames),
    recentChronological: pendingOutboundChrono,
  };
  pendingOutboundChrono = [];

  try {
    ws.send(
      JSON.stringify({
        type: 'TELEMETRY_SNAPSHOT',
        snapshot: outboundSnap,
      }),
    );
    if (isLiveStreamTick) {
      lastLiveSnapshotSentAtPerfMs = nowPerf;
    }
    currentState.sentSnapshotsCount += 1;
    scheduleThrottledCounterEmit();
  } catch {
    // Handled by ws.onclose reconnect loop
  }
}

const storeUnsubscribers: Array<() => void> = [];

function bindLocalStoresOnce(): void {
  if (storesBound) return;
  storesBound = true;

  storeUnsubscribers.push(
    telemetryStore.subscribeRawSnapshots((snap) => {
      handleOutboundSnapshot(snap, true);
    }),
  );

  storeUnsubscribers.push(
    telemetryStore.subscribeHeader(() => {
      const connectedCount = telemetryStore
        .getHeaderSlice()
        .buses.filter((b) => b.connected).length;
      if (connectedCount !== prevConnectedBusCount) {
        prevConnectedBusCount = connectedCount;
        if (activeWs && activeWs.readyState === WebSocket.OPEN && connectedCount === 0) {
          // Immediately notify NexusCANCloud when buses disconnect locally
          handleOutboundSnapshot(buildStandbyOrCurrentSnapshot(), false);
        }
      }
    }),
  );

  storeUnsubscribers.push(
    databaseStore.subscribeSchemaChanges((schema) => {
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        pushSchemaUpdateToCloud(schema);
      }
    }),
  );
}

async function fetchCloudJson<T>(
  url: string,
  init: RequestInit,
): Promise<{ status: number; ok: boolean; data: T | null; errorMessage: string | null }> {
  const res = await fetch(url, {
    cache: 'no-store',
    ...init,
    mode: 'cors',
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  const errMsg =
    !res.ok && isPlainObject(parsed) && typeof parsed.message === 'string'
      ? parsed.message
      : !res.ok
        ? `HTTP ${res.status} (${res.statusText || 'Request failed'})`
        : null;

  return {
    status: res.status,
    ok: res.ok,
    data: (parsed as T) ?? null,
    errorMessage: errMsg,
  };
}

interface ProvisionedBridgeResult {
  bridgeToken: string;
  deviceId: string;
  deviceName: string;
  streamId: string;
  project: CloudProjectItem;
}

async function provisionBridgeSession(params: {
  baseUrl: string;
  sessionToken: string;
  userFullName: string;
  project: CloudProjectItem;
}): Promise<ProvisionedBridgeResult> {
  const deviceLabel = `NexusCAN Live — ${params.userFullName || 'Engineer'}`.slice(0, 96);
  const hostname = resolveHostname();
  const hostOs = resolveHostOs();
  const adapterSummary = resolveAdapterSummary();
  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${params.sessionToken}`,
  };

  // Primary endpoint: POST /api/bridge/connect-session
  const connectRes = await fetchCloudJson<Record<string, unknown>>(
    `${params.baseUrl}/api/bridge/connect-session`,
    {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        projectId: params.project.id,
        deviceName: deviceLabel,
        hostname,
        hostOs,
        nexusCanVersion: '0.1.0',
        adapterSummary,
      }),
    },
  );

  if (connectRes.ok && connectRes.data) {
    const body = connectRes.data;
    const rawBridgeToken =
      typeof body.bridgeToken === 'string'
        ? body.bridgeToken
        : typeof body.tokenOnce === 'string'
          ? body.tokenOnce
          : typeof body.token === 'string'
            ? body.token
            : null;
    const devObj = isPlainObject(body.device) ? body.device : null;
    const devId = devObj && typeof devObj.id === 'string' ? devObj.id : null;
    const devName = devObj && typeof devObj.name === 'string' ? devObj.name : deviceLabel;
    const resolvedStreamId =
      typeof body.streamId === 'string' && body.streamId.length > 0
        ? body.streamId
        : devId;

    if (rawBridgeToken && devId && resolvedStreamId) {
      return {
        bridgeToken: rawBridgeToken,
        deviceId: devId,
        deviceName: devName,
        streamId: resolvedStreamId,
        project: params.project,
      };
    }
  }

  // Fallback endpoint: POST /api/orgs/[orgId]/devices/tokens
  const fallbackRes = await fetchCloudJson<Record<string, unknown>>(
    `${params.baseUrl}/api/orgs/${encodeURIComponent(params.project.orgId)}/devices/tokens`,
    {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        projectId: params.project.id,
        name: deviceLabel,
        hostname,
        hostOs,
        adapterSummary,
      }),
    },
  );

  if (!fallbackRes.ok || !fallbackRes.data) {
    throw new Error(
      fallbackRes.errorMessage ??
        connectRes.errorMessage ??
        'Failed to provision NexusCANCloud bridge token.',
    );
  }

  const fbData = fallbackRes.data;
  const tokenOnce = typeof fbData.tokenOnce === 'string' ? fbData.tokenOnce : null;
  const fbDevice = isPlainObject(fbData.device) ? fbData.device : null;
  const fbDeviceId = fbDevice && typeof fbDevice.id === 'string' ? fbDevice.id : null;
  const fbDeviceName =
    fbDevice && typeof fbDevice.name === 'string' ? fbDevice.name : deviceLabel;

  if (!tokenOnce || !fbDeviceId) {
    throw new Error('Cloud server returned an incomplete bridge device token payload.');
  }

  return {
    bridgeToken: tokenOnce,
    deviceId: fbDeviceId,
    deviceName: fbDeviceName,
    streamId: fbDeviceId,
    project: params.project,
  };
}

function scheduleReconnect(): void {
  if (!shouldMaintainConnection) return;
  if (reconnectTimer !== null) return;

  const delayMs = Math.min(15_000, 1_000 * 2 ** Math.min(reconnectAttempt, 4));
  reconnectAttempt += 1;

  currentState = {
    ...currentState,
    status: 'connecting_ws',
  };
  emitFullChange();

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (shouldMaintainConnection) {
      openBridgeSocket();
    }
  }, delayMs);
}

/**
 * STRICT READ-ONLY CLOUD INBOUND HANDLER:
 * Only accepts passive observation / handshake / rate-control / capture-status / ping-pong frames.
 * NEVER triggers local CAN TX or Arm Active Bus under any circumstance.
 */
function handleCloudInboundMessage(rawText: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return;
  }
  if (!isPlainObject(parsed) || typeof parsed.type !== 'string') {
    return;
  }

  switch (parsed.type) {
    case 'SCHEMA_ACK': {
      const ackStatus =
        parsed.status === 'known'
          ? 'known'
          : parsed.status === 'upload_required'
            ? 'upload_required'
            : 'synced';
      currentState = {
        ...currentState,
        schemaAckStatus: ackStatus,
      };
      emitFullChange();
      break;
    }
    case 'RATE_CONTROL': {
      if (typeof parsed.targetHz === 'number' && VALID_TARGET_HZ.has(parsed.targetHz)) {
        currentState = {
          ...currentState,
          targetHz: parsed.targetHz as CloudBridgeTargetHz,
          rateControlReason: typeof parsed.reason === 'string' ? parsed.reason : null,
        };
        emitFullChange();
      }
      break;
    }
    case 'CAPTURE_STATUS': {
      currentState = {
        ...currentState,
        cloudCapturing: Boolean(parsed.capturing),
        activeCaptureSessionId:
          typeof parsed.activeSessionId === 'string' ? parsed.activeSessionId : null,
        activeCaptureSessionName:
          typeof parsed.activeSessionName === 'string' ? parsed.activeSessionName : null,
        capturedFramesCount:
          typeof parsed.capturedFramesCount === 'number' ? parsed.capturedFramesCount : 0,
      };
      emitFullChange();
      break;
    }
    case 'PONG': {
      if (typeof parsed.timestampMs === 'number') {
        currentState.latencyMs = Math.max(0, Date.now() - parsed.timestampMs);
        scheduleThrottledCounterEmit();
      }
      break;
    }
    case 'PING': {
      const ts = typeof parsed.timestampMs === 'number' ? parsed.timestampMs : Date.now();
      sendJsonOverWs({ type: 'PONG', timestampMs: ts });
      break;
    }
    case 'BRIDGE_ERROR': {
      const errMsg =
        typeof parsed.message === 'string' ? parsed.message : 'Cloud bridge warning';
      currentState = {
        ...currentState,
        errorMessage: errMsg,
      };
      emitFullChange();
      break;
    }
    case 'WORKSPACE_UPDATED':
    case 'PROJECT_WORKSPACE_UPDATED': {
      const pId = typeof parsed.projectId === 'string' ? parsed.projectId : null;
      const rev = typeof parsed.revisionNumber === 'number' ? parsed.revisionNumber : null;
      if (pId && rev !== null) {
        currentState = {
          ...currentState,
          projects: currentState.projects.map((p) =>
            p.id === pId ? { ...p, latestRevisionNumber: rev, hasWorkspace: true } : p,
          ),
        };
        if (pId === currentState.selectedProjectId || pId === currentState.inspectedProjectId) {
          currentState = {
            ...currentState,
            remoteUpdateAvailableRev: rev,
          };
          if (currentState.inspectedProjectId === pId) {
            void cloudBridgeStore.fetchRemoteWorkspace(pId).catch(() => undefined);
          }
        }
        emitFullChange();
      }
      break;
    }
    case 'PROJECTS_CHANGED':
    case 'PROJECT_CREATED':
    case 'PROJECT_UPDATED': {
      void cloudBridgeStore.refreshProjects().catch(() => undefined);
      break;
    }
    default: {
      // Strictly ignore any unknown or actuation message types (Read-Only Cloud Safety)
      break;
    }
  }
}

function openBridgeSocket(): void {
  bindLocalStoresOnce();
  closeActiveSocketCleanly('RECONNECTING');

  const { cloudBaseUrl, bridgeToken, deviceId, selectedProjectId, streamId } = currentState;
  if (!bridgeToken || !deviceId || !selectedProjectId || !streamId) {
    currentState = {
      ...currentState,
      status: 'disconnected',
    };
    emitFullChange();
    return;
  }

  currentState = {
    ...currentState,
    status: 'connecting_ws',
    errorMessage: null,
  };
  emitFullChange();

  let ws: WebSocket;
  try {
    const wsUrl = buildBridgeWebSocketUrl(cloudBaseUrl, bridgeToken, streamId);
    ws = new WebSocket(wsUrl);
  } catch (err) {
    currentState = {
      ...currentState,
      status: 'error',
      errorMessage: err instanceof Error ? err.message : 'Invalid Cloud WebSocket URL',
    };
    emitFullChange();
    scheduleReconnect();
    return;
  }

  activeWs = ws;

  ws.onopen = () => {
    if (activeWs !== ws) return;
    reconnectAttempt = 0;
    recoveryProvisionAttempted = false;

    const currentSchema = databaseStore.getPrimaryLiveSchema();
    currentState = {
      ...currentState,
      status: 'streaming',
      errorMessage: null,
      targetHz: currentState.desiredHz,
      schemaSyncedName: currentSchema ? currentSchema.info.name : null,
      schemaAckStatus: currentSchema ? 'synced' : 'idle',
    };
    emitFullChange();

    // 1. Plane 1: Send BRIDGE_HELLO
    sendJsonOverWs({
      type: 'BRIDGE_HELLO',
      deviceId,
      projectId: selectedProjectId,
      appVersion: '0.1.0',
      hostOs: resolveHostOs(),
      targetHz: currentState.desiredHz,
      schemaSha256: null,
      activeDbName: currentSchema ? currentSchema.info.name : null,
    });

    // 2. Plane 1: Immediately synchronize loaded .dbc/.kcd schema if present
    if (currentSchema) {
      sendJsonOverWs({
        type: 'BRIDGE_SCHEMA_UPDATE',
        schema: currentSchema,
        activeDbName: currentSchema.info.name,
      });
    }

    // 3. Plane 2: Immediate initial snapshot + RTT ping so NexusCANCloud displays active session within < 50ms
    handleOutboundSnapshot(buildStandbyOrCurrentSnapshot(), false);
    sendJsonOverWs({
      type: 'PING',
      timestampMs: Date.now(),
    });

    // 4. Lightweight 2s heartbeat & standby telemetry pulse when local CAN buses are idle
    heartbeatTimer = setInterval(() => {
      if (activeWs !== ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      sendJsonOverWs({
        type: 'PING',
        timestampMs: Date.now(),
        latencyMs: currentState.latencyMs,
      });

      if (performance.now() - lastLiveSnapshotSentAtPerfMs >= STANDBY_IDLE_SNAPSHOT_THRESHOLD_MS) {
        handleOutboundSnapshot(buildStandbyOrCurrentSnapshot(), false);
      }
    }, HEARTBEAT_INTERVAL_MS);
  };

  ws.onmessage = (ev: MessageEvent) => {
    if (activeWs !== ws) return;
    if (typeof ev.data === 'string') {
      handleCloudInboundMessage(ev.data);
    }
  };

  ws.onerror = () => {
    // Detailed lifecycle handled in ws.onclose
  };

  ws.onclose = (ev: CloseEvent) => {
    if (activeWs !== ws) return;
    activeWs = null;
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    currentState = {
      ...currentState,
      cloudCapturing: false,
      activeCaptureSessionId: null,
      activeCaptureSessionName: null,
    };

    if (!shouldMaintainConnection) {
      currentState = {
        ...currentState,
        status: 'disconnected',
      };
      emitFullChange();
      return;
    }

    // If token was invalidated/revoked (4001/4003) or HTTP upgrade rejected while we still hold a sessionToken, attempt one automatic re-provision
    if (
      (ev.code === 4001 || ev.code === 4003 || ev.code === 1006) &&
      !recoveryProvisionAttempted &&
      currentState.sessionToken &&
      currentState.selectedProjectId
    ) {
      const targetProj = currentState.projects.find(
        (p) => p.id === currentState.selectedProjectId,
      );
      if (targetProj) {
        recoveryProvisionAttempted = true;
        void provisionBridgeSession({
          baseUrl: currentState.cloudBaseUrl,
          sessionToken: currentState.sessionToken,
          userFullName: currentState.userFullName,
          project: targetProj,
        })
          .then((provisioned) => {
            if (!shouldMaintainConnection) return;
            currentState = {
              ...currentState,
              bridgeToken: provisioned.bridgeToken,
              deviceId: provisioned.deviceId,
              deviceName: provisioned.deviceName,
              streamId: provisioned.streamId,
            };
            persistCurrentSession();
            openBridgeSocket();
          })
          .catch(() => {
            if (!shouldMaintainConnection) return;
            if (ev.code === 4001 || ev.code === 4003) {
              shouldMaintainConnection = false;
              currentState = {
                ...currentState,
                status: 'error',
                autoConnect: false,
                errorMessage:
                  'Bulut köprü anahtarı iptal edildi veya oturum süresi doldu. Lütfen tekrar giriş yapın.',
              };
              persistCurrentSession();
              emitFullChange();
            } else {
              scheduleReconnect();
            }
          });
        return;
      }
    }

    if (ev.code === 4001 || ev.code === 4003) {
      shouldMaintainConnection = false;
      currentState = {
        ...currentState,
        status: 'error',
        autoConnect: false,
        errorMessage:
          ev.reason || 'Bulut köprü yetkisi reddedildi (4003). Lütfen tekrar giriş yapın.',
      };
      persistCurrentSession();
      emitFullChange();
      return;
    }

    if (ev.code === 4009) {
      // Superseded by another tab/session for the same streamId
      shouldMaintainConnection = false;
      currentState = {
        ...currentState,
        status: 'disconnected',
        errorMessage: 'Bu yayın başka bir NexusCAN penceresi tarafından devralındı.',
      };
      emitFullChange();
      return;
    }

    scheduleReconnect();
  };
}

async function connectAndStartStreamingFromAuthPayload(params: {
  baseUrl: string;
  email: string;
  authData: Record<string, unknown>;
  preferredProjectId?: string;
}): Promise<void> {
  const { baseUrl, email, authData, preferredProjectId } = params;

  const sessionToken =
    typeof authData.token === 'string' && authData.token.length > 0
      ? authData.token
      : null;
  const userObj = isPlainObject(authData.user) ? authData.user : null;
  const userFullName =
    userObj && typeof userObj.fullName === 'string'
      ? userObj.fullName
      : email.split('@')[0] || 'Engineer';

  if (!sessionToken) {
    throw new Error('Bulut sunucusundan oturum anahtarı (Bearer token) alınamadı.');
  }

  const orgsRaw = Array.isArray(authData.organizations)
    ? authData.organizations
    : [];
  let organizations: CloudOrganizationItem[] = orgsRaw
    .filter(isPlainObject)
    .map((o) => {
      const roleStr = typeof o.myRole === 'string' ? o.myRole : '';
      const myRole: CloudOrgRole =
        roleStr === 'owner' ||
        roleStr === 'admin' ||
        roleStr === 'engineer' ||
        roleStr === 'viewer'
          ? roleStr
          : 'engineer';
      return {
        id: String(o.id ?? ''),
        name: String(o.name ?? 'Organization'),
        slug: String(o.slug ?? 'org'),
        myRole,
      };
    })
    .filter((o) => o.id.length > 0);

  // Auto-bootstrap a default organization if the user account has none yet
  if (organizations.length === 0) {
    const defaultOrgName = `${userFullName} Engineering`.slice(0, 80);
    const slugBase = userFullName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    const suffix =
      Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 6) || 'team';
    const defaultOrgSlug = `${slugBase || 'nexuscan'}-${suffix}`.slice(0, 60);

    const createdOrgRes = await fetchCloudJson<Record<string, unknown>>(
      `${baseUrl}/api/orgs`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          name: defaultOrgName,
          slug: defaultOrgSlug,
        }),
      },
    );

    if (
      createdOrgRes.ok &&
      createdOrgRes.data &&
      isPlainObject(createdOrgRes.data.organization)
    ) {
      const o = createdOrgRes.data.organization;
      if (typeof o.id === 'string' && o.id.length > 0) {
        organizations = [
          {
            id: o.id,
            name: String(o.name ?? defaultOrgName),
            slug: String(o.slug ?? defaultOrgSlug),
            myRole: 'owner',
          },
        ];
      }
    }
  }

  // Fetch available projects across user's organizations
  const projectsRes = await fetchCloudJson<Record<string, unknown>>(
    `${baseUrl}/api/projects`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    },
  );

  let projects: CloudProjectItem[] = [];
  if (projectsRes.ok && projectsRes.data && Array.isArray(projectsRes.data.projects)) {
    projects = projectsRes.data.projects
      .filter(isPlainObject)
      .map((p) => {
        const protoStr = typeof p.defaultProtocol === 'string' ? p.defaultProtocol : '';
        const defaultProtocol: 'CAN' | 'CAN_FD' | 'J1939' =
          protoStr === 'CAN' || protoStr === 'CAN_FD' || protoStr === 'J1939'
            ? protoStr
            : 'CAN_FD';
        return {
          id: String(p.id ?? ''),
          orgId: String(p.orgId ?? ''),
          name: String(p.name ?? 'Cloud Project'),
          slug: String(p.slug ?? 'project'),
          code: String(p.code ?? 'CAN'),
          defaultProtocol,
          description: typeof p.description === 'string' ? p.description : undefined,
          vehiclePlatform: typeof p.vehiclePlatform === 'string' ? p.vehiclePlatform : undefined,
          latestRevisionNumber:
            typeof p.latestRevisionNumber === 'number' ? p.latestRevisionNumber : null,
          updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : null,
          hasWorkspace: Boolean(p.hasWorkspace),
        };
      })
      .filter((p) => p.id.length > 0 && p.orgId.length > 0);
  }

  // Auto-create a default project if the organization has none yet
  if (projects.length === 0 && organizations[0]) {
    const createdProjRes = await fetchCloudJson<Record<string, unknown>>(
      `${baseUrl}/api/projects`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          orgId: organizations[0].id,
          name: 'NexusCAN Live Bench',
          code: 'NXC-LIVE',
          description: 'Auto-created live telemetry project from NexusCAN Desktop',
          vehiclePlatform: 'CAN / CAN-FD Bench',
          defaultProtocol: 'CAN_FD',
        }),
      },
    );
    if (
      createdProjRes.ok &&
      createdProjRes.data &&
      isPlainObject(createdProjRes.data.project)
    ) {
      const p = createdProjRes.data.project;
      projects = [
        {
          id: String(p.id ?? ''),
          orgId: String(p.orgId ?? organizations[0].id),
          name: String(p.name ?? 'NexusCAN Live Bench'),
          slug: String(p.slug ?? 'nexuscan-live-bench'),
          code: String(p.code ?? 'NXC-LIVE'),
          defaultProtocol: 'CAN_FD',
        },
      ];
    }
  }

  const targetProject =
    (preferredProjectId ? projects.find((p) => p.id === preferredProjectId) : undefined) ??
    (currentState.selectedProjectId
      ? projects.find((p) => p.id === currentState.selectedProjectId)
      : undefined) ??
    projects[0];

  if (!targetProject) {
    throw new Error(
      'Hesabınıza bağlı erişilebilir bir bulut projesi bulunamadı.',
    );
  }

  // Provision bridge token (`nxc_tok_...`) & device identity
  const provisioned = await provisionBridgeSession({
    baseUrl,
    sessionToken,
    userFullName,
    project: targetProject,
  });

  currentState = {
    ...currentState,
    cloudBaseUrl: baseUrl,
    autoConnect: true,
    userEmail: email,
    userFullName,
    sessionToken,
    organizations,
    projects,
    selectedOrgId: targetProject.orgId,
    selectedProjectId: targetProject.id,
    selectedProjectName: targetProject.name,
    selectedProjectSlug: targetProject.slug,
    bridgeToken: provisioned.bridgeToken,
    deviceId: provisioned.deviceId,
    deviceName: provisioned.deviceName,
    streamId: provisioned.streamId,
    sentSnapshotsCount: 0,
    latencyMs: 0,
    errorMessage: null,
  };
  persistCurrentSession();
  emitFullChange();

  // Open real-time WebSocket stream immediately
  shouldMaintainConnection = true;
  reconnectAttempt = 0;
  openBridgeSocket();
}

export const cloudBridgeStore = {
  subscribe(listener: () => void): () => void {
    fullListeners.add(listener);
    return () => {
      fullListeners.delete(listener);
    };
  },

  getState(): CloudBridgeStoreState {
    return currentState;
  },

  subscribeHeader(listener: () => void): () => void {
    headerListeners.add(listener);
    return () => {
      headerListeners.delete(listener);
    };
  },

  getHeaderSlice(): CloudBridgeHeaderSlice {
    return headerSlice;
  },

  setModalOpen(open: boolean): void {
    if (currentState.modalOpen === open) return;
    currentState = {
      ...currentState,
      modalOpen: open,
    };
    emitFullChange();
  },

  openPushPrompt(ctx: CloudPushPromptContext): void {
    currentState = {
      ...currentState,
      pushPromptContext: ctx,
    };
    emitFullChange();
  },

  closePushPrompt(): void {
    if (!currentState.pushPromptContext) return;
    currentState = {
      ...currentState,
      pushPromptContext: null,
    };
    emitFullChange();
  },

  setDesiredHz(hz: CloudBridgeTargetHz): void {
    currentState = {
      ...currentState,
      desiredHz: hz,
      targetHz: hz,
    };
    persistCurrentSession();
    emitFullChange();
  },

  /**
   * Called once after `App.tsx` finishes startup initialization.
   * Restores live cloud streaming automatically if `autoConnect` was active before reload.
   */
  initializeLifecycle(): void {
    bindLocalStoresOnce();
    if (lifecycleInitialized) return;
    lifecycleInitialized = true;

    if (currentState.sessionToken) {
      void cloudBridgeStore.refreshSessionAndOrganizations().catch(() => undefined);
      void cloudBridgeStore.refreshProjects();
    }

    if (
      currentState.autoConnect &&
      currentState.sessionToken &&
      currentState.bridgeToken &&
      currentState.deviceId &&
      currentState.selectedProjectId &&
      currentState.streamId
    ) {
      shouldMaintainConnection = true;
      reconnectAttempt = 0;
      openBridgeSocket();
    }
  },

  /**
   * Authenticates with `NexusCANCloud`, fetches user organizations & projects,
   * provisions a dedicated Read-Only bridge device token (`nxc_tok_...`), and starts
   * real-time WebSocket telemetry & `.dbc`/`.kcd` schema streaming.
   */
  async loginAndConnect(
    cloudUrlInput: string,
    emailInput: string,
    passwordInput: string,
    preferredProjectId?: string,
  ): Promise<void> {
    bindLocalStoresOnce();
    shouldMaintainConnection = false;
    clearTimers();
    closeActiveSocketCleanly('NEW_LOGIN');

    const baseUrl = normalizeCloudBaseUrl(cloudUrlInput);
    const email = emailInput.trim();

    currentState = {
      ...currentState,
      cloudBaseUrl: baseUrl,
      userEmail: email,
      status: 'authenticating',
      errorMessage: null,
    };
    emitFullChange();

    try {
      const loginRes = await fetchCloudJson<Record<string, unknown>>(
        `${baseUrl}/api/auth/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: passwordInput }),
        },
      );

      if (!loginRes.ok || !loginRes.data) {
        throw new Error(
          loginRes.errorMessage ?? 'Kullanıcı adı veya parola doğrulanamadı.',
        );
      }

      await connectAndStartStreamingFromAuthPayload({
        baseUrl,
        email,
        authData: loginRes.data,
        preferredProjectId,
      });
    } catch (err) {
      const msg =
        err instanceof TypeError
          ? `NexusCANCloud sunucusuna (${baseUrl}) ulaşılamadı. Sunucunun çalıştığından emin olun.`
          : err instanceof Error
            ? err.message
            : String(err);

      currentState = {
        ...currentState,
        status: 'error',
        errorMessage: msg,
      };
      emitFullChange();
      throw new Error(msg);
    }
  },

  /**
   * Registers a brand-new `NexusCANCloud` account via `POST /api/auth/register`
   * and immediately provisions and connects the Read-Only live telemetry bridge.
   */
  async registerAndConnect(params: {
    cloudUrlInput: string;
    fullName: string;
    email: string;
    password: string;
    organizationName?: string;
    preferredProjectId?: string;
  }): Promise<void> {
    bindLocalStoresOnce();
    shouldMaintainConnection = false;
    clearTimers();
    closeActiveSocketCleanly('NEW_REGISTER');

    const baseUrl = normalizeCloudBaseUrl(params.cloudUrlInput);
    const email = params.email.trim();
    const fullName = params.fullName.trim();
    const organizationName = params.organizationName?.trim() ?? '';

    currentState = {
      ...currentState,
      cloudBaseUrl: baseUrl,
      userEmail: email,
      status: 'authenticating',
      errorMessage: null,
    };
    emitFullChange();

    try {
      const payload: Record<string, string> = {
        fullName,
        email,
        password: params.password,
      };
      if (organizationName.length >= 2) {
        payload.organizationName = organizationName;
      }

      const registerRes = await fetchCloudJson<Record<string, unknown>>(
        `${baseUrl}/api/auth/register`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );

      if (!registerRes.ok || !registerRes.data) {
        throw new Error(
          registerRes.errorMessage ?? 'Yeni bulut hesabı oluşturulamadı.',
        );
      }

      await connectAndStartStreamingFromAuthPayload({
        baseUrl,
        email,
        authData: registerRes.data,
        preferredProjectId: params.preferredProjectId,
      });
    } catch (err) {
      const msg =
        err instanceof TypeError
          ? `NexusCANCloud sunucusuna (${baseUrl}) ulaşılamadı. Sunucunun çalıştığından emin olun.`
          : err instanceof Error
            ? err.message
            : String(err);

      currentState = {
        ...currentState,
        status: 'error',
        errorMessage: msg,
      };
      emitFullChange();
      throw new Error(msg);
    }
  },

  /**
   * Switches the active cloud organization/project and re-routes the live WebSocket stream.
   */
  async switchProject(projectId: string): Promise<void> {
    const targetProject = currentState.projects.find((p) => p.id === projectId);
    const sessionToken = currentState.sessionToken;
    if (!targetProject || !sessionToken) {
      return;
    }

    shouldMaintainConnection = false;
    clearTimers();
    closeActiveSocketCleanly('SWITCHING_PROJECT');

    currentState = {
      ...currentState,
      status: 'authenticating',
      selectedOrgId: targetProject.orgId,
      selectedProjectId: targetProject.id,
      selectedProjectName: targetProject.name,
      selectedProjectSlug: targetProject.slug,
      inspectedProjectId: targetProject.id,
      errorMessage: null,
    };
    emitFullChange();

    try {
      const provisioned = await provisionBridgeSession({
        baseUrl: currentState.cloudBaseUrl,
        sessionToken,
        userFullName: currentState.userFullName,
        project: targetProject,
      });

      currentState = {
        ...currentState,
        autoConnect: true,
        bridgeToken: provisioned.bridgeToken,
        deviceId: provisioned.deviceId,
        deviceName: provisioned.deviceName,
        streamId: provisioned.streamId,
        sentSnapshotsCount: 0,
        errorMessage: null,
      };
      persistCurrentSession();
      emitFullChange();

      shouldMaintainConnection = true;
      reconnectAttempt = 0;
      openBridgeSocket();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      currentState = {
        ...currentState,
        status: 'error',
        errorMessage: msg,
      };
      emitFullChange();
      throw new Error(msg);
    }
  },

  async setInspectedProject(projectId: string | null): Promise<void> {
    if (currentState.inspectedProjectId === projectId && projectId !== null) {
      if (currentState.sessionToken) {
        await cloudBridgeStore.fetchRemoteWorkspace(projectId).catch(() => undefined);
      }
      return;
    }

    currentState = {
      ...currentState,
      inspectedProjectId: projectId,
      conflictState: null,
      remoteUpdateAvailableRev: null,
    };
    emitFullChange();

    if (projectId && currentState.sessionToken) {
      await cloudBridgeStore.fetchRemoteWorkspace(projectId).catch(() => undefined);
    }
  },

  selectOrganization(orgId: string): void {
    const trimmed = orgId.trim();
    if (!trimmed) {
      currentState = {
        ...currentState,
        selectedOrgId: null,
      };
      persistCurrentSession();
      emitFullChange();
      return;
    }

    const org = currentState.organizations.find((o) => o.id === trimmed);
    if (!org) {
      return;
    }

    let inspectedProjectId = currentState.inspectedProjectId;
    if (inspectedProjectId) {
      const curProj = currentState.projects.find((p) => p.id === inspectedProjectId);
      if (curProj && curProj.orgId !== org.id) {
        const firstProjInOrg = currentState.projects.find((p) => p.orgId === org.id);
        inspectedProjectId = firstProjInOrg ? firstProjInOrg.id : null;
      }
    } else {
      const firstProjInOrg = currentState.projects.find((p) => p.orgId === org.id);
      inspectedProjectId = firstProjInOrg ? firstProjInOrg.id : null;
    }

    currentState = {
      ...currentState,
      selectedOrgId: org.id,
      inspectedProjectId,
    };
    persistCurrentSession();
    emitFullChange();
  },

  async refreshSessionAndOrganizations(): Promise<CloudOrganizationItem[]> {
    const { sessionToken, cloudBaseUrl } = currentState;
    if (!sessionToken) {
      return [...currentState.organizations];
    }

    try {
      const res = await fetchCloudJson<Record<string, unknown>>(
        `${cloudBaseUrl}/api/auth/session`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        },
      );

      if (res.ok && res.data) {
        let updatedOrgs: CloudOrganizationItem[] = [];
        if (Array.isArray(res.data.organizations)) {
          updatedOrgs = res.data.organizations
            .filter(isPlainObject)
            .map((o) => {
              const roleStr = typeof o.myRole === 'string' ? o.myRole : '';
              const myRole: CloudOrgRole =
                roleStr === 'owner' ||
                roleStr === 'admin' ||
                roleStr === 'engineer' ||
                roleStr === 'viewer'
                  ? roleStr
                  : 'engineer';
              return {
                id: String(o.id ?? ''),
                name: String(o.name ?? 'Organization'),
                slug: String(o.slug ?? 'org'),
                myRole,
              };
            })
            .filter((o) => o.id.length > 0);
        }

        const userObj = isPlainObject(res.data.user) ? res.data.user : null;
        const userEmail =
          userObj && typeof userObj.email === 'string' && userObj.email.length > 0
            ? userObj.email
            : currentState.userEmail;
        const userFullName =
          userObj && typeof userObj.fullName === 'string' && userObj.fullName.length > 0
            ? userObj.fullName
            : currentState.userFullName;

        let selectedOrgId = currentState.selectedOrgId;
        if (!selectedOrgId || !updatedOrgs.some((o) => o.id === selectedOrgId)) {
          selectedOrgId = updatedOrgs[0]?.id ?? null;
        }

        currentState = {
          ...currentState,
          organizations: updatedOrgs,
          selectedOrgId,
          userEmail,
          userFullName,
        };
        persistCurrentSession();
        emitFullChange();
        return updatedOrgs;
      }
    } catch {
      // Ignore network errors on session refresh
    }
    return [...currentState.organizations];
  },

  async refreshProjects(): Promise<CloudProjectItem[]> {
    const { sessionToken, cloudBaseUrl } = currentState;
    if (!sessionToken) {
      return [...currentState.projects];
    }

    await cloudBridgeStore.refreshSessionAndOrganizations().catch(() => []);

    currentState = {
      ...currentState,
      loadingProjects: true,
    };
    emitFullChange();

    try {
      const res = await fetchCloudJson<Record<string, unknown>>(
        `${cloudBaseUrl}/api/projects`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        },
      );

      let updatedProjects: CloudProjectItem[] = [];
      if (res.ok && res.data && Array.isArray(res.data.projects)) {
        updatedProjects = res.data.projects
          .filter(isPlainObject)
          .map((p) => {
            const protoStr = typeof p.defaultProtocol === 'string' ? p.defaultProtocol : '';
            const defaultProtocol: 'CAN' | 'CAN_FD' | 'J1939' =
              protoStr === 'CAN' || protoStr === 'CAN_FD' || protoStr === 'J1939'
                ? protoStr
                : 'CAN_FD';
            return {
              id: String(p.id ?? ''),
              orgId: String(p.orgId ?? ''),
              name: String(p.name ?? 'Cloud Project'),
              slug: String(p.slug ?? 'project'),
              code: String(p.code ?? 'CAN'),
              defaultProtocol,
              description: typeof p.description === 'string' ? p.description : undefined,
              vehiclePlatform: typeof p.vehiclePlatform === 'string' ? p.vehiclePlatform : undefined,
              latestRevisionNumber:
                typeof p.latestRevisionNumber === 'number' ? p.latestRevisionNumber : null,
              updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : null,
              hasWorkspace: Boolean(p.hasWorkspace),
            };
          })
          .filter((p) => p.id.length > 0 && p.orgId.length > 0);
      }

      currentState = {
        ...currentState,
        projects: updatedProjects,
        loadingProjects: false,
      };
      persistCurrentSession();
      emitFullChange();
      return updatedProjects;
    } catch {
      currentState = {
        ...currentState,
        loadingProjects: false,
      };
      emitFullChange();
      return [...currentState.projects];
    }
  },

  async createCloudProject(params: {
    orgId: string;
    name: string;
    code: string;
    defaultProtocol: 'CAN' | 'CAN_FD' | 'J1939';
    description?: string;
    vehiclePlatform?: string;
    initialWorkspace?: NexusProjectFileV1;
    bindLocalIfActive?: boolean;
    quickBarState?: QuickBarConnectionState;
  }): Promise<CloudProjectItem> {
    const { sessionToken, cloudBaseUrl } = currentState;
    if (!sessionToken) {
      throw new Error('Proje oluşturmak için önce bulut oturumu açmalısınız.');
    }

    const trimmedName = params.name.trim();
    if (trimmedName.length < 2) {
      throw new Error('Proje adı en az 2 karakter olmalıdır.');
    }

    let cleanCode = params.code.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (cleanCode.length < 2) {
      cleanCode = suggestCloudProjectCode(trimmedName);
    }
    if (cleanCode.length > 24) {
      cleanCode = cleanCode.slice(0, 24);
    }

    const payload: Record<string, unknown> = {
      orgId: params.orgId,
      name: trimmedName,
      code: cleanCode,
      defaultProtocol: params.defaultProtocol,
      description: params.description?.trim(),
      vehiclePlatform: params.vehiclePlatform?.trim(),
    };

    const res = await fetchCloudJson<Record<string, unknown>>(
      `${cloudBaseUrl}/api/projects`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify(payload),
      },
    );

    if (!res.ok || !res.data || !isPlainObject(res.data.project)) {
      throw new Error(res.errorMessage ?? 'Bulut projesi oluşturulamadı.');
    }

    const rawP = res.data.project;
    const protoStr = typeof rawP.defaultProtocol === 'string' ? rawP.defaultProtocol : '';
    const defaultProtocol: 'CAN' | 'CAN_FD' | 'J1939' =
      protoStr === 'CAN' || protoStr === 'CAN_FD' || protoStr === 'J1939'
        ? protoStr
        : params.defaultProtocol;

    const createdProject: CloudProjectItem = {
      id: String(rawP.id ?? ''),
      orgId: String(rawP.orgId ?? params.orgId),
      name: String(rawP.name ?? trimmedName),
      slug: String(rawP.slug ?? trimmedName.toLowerCase().replace(/[^a-z0-9]/g, '-')),
      code: String(rawP.code ?? cleanCode),
      defaultProtocol,
      description: params.description,
      vehiclePlatform: params.vehiclePlatform,
      latestRevisionNumber: 1,
      updatedAt: new Date().toISOString(),
      hasWorkspace: Boolean(params.initialWorkspace),
    };

    // Immediately prepend/add createdProject into currentState.projects BEFORE calling pushWorkspacePayloadToCloud!
    const existingIndex = currentState.projects.findIndex((p) => p.id === createdProject.id);
    const updatedProjects =
      existingIndex >= 0
        ? currentState.projects.map((p, idx) => (idx === existingIndex ? createdProject : p))
        : [createdProject, ...currentState.projects];

    currentState = {
      ...currentState,
      projects: updatedProjects,
    };
    persistCurrentSession();
    emitFullChange();

    if (params.initialWorkspace) {
      try {
        const sanitizedWs = toCloudCompatibleWorkspace(params.initialWorkspace);
        await cloudBridgeStore.pushWorkspacePayloadToCloud({
          projectId: createdProject.id,
          workspace: sanitizedWs,
          commitMessage: `İlk şablon oluşturuldu (${createdProject.name})`,
          baseRevisionNumber: null,
          force: true,
          bindLocalIfActive: params.bindLocalIfActive,
          quickBarState: params.quickBarState,
        });
      } catch {
        // Workspace save is best effort on creation
      }
    } else if (params.bindLocalIfActive) {
      const matchingOrg = currentState.organizations.find(
        (o) => o.id === createdProject.orgId,
      );
      const binding: CloudProjectBindingV1 = {
        cloudBaseUrl,
        orgId: createdProject.orgId,
        orgName: matchingOrg?.name,
        orgSlug: matchingOrg?.slug,
        projectId: createdProject.id,
        projectName: createdProject.name,
        projectSlug: createdProject.slug,
        projectCode: createdProject.code,
        baseRevisionNumber: 1,
        lastSyncedAt: new Date().toISOString(),
        lastSyncedHash: computeWorkspaceSemanticHash(
          projectStore.buildProjectSnapshot(params.quickBarState),
        ),
      };
      projectStore.setCloudBinding(binding, params.quickBarState);
    }

    await cloudBridgeStore.refreshProjects();
    await cloudBridgeStore.setInspectedProject(createdProject.id);

    return createdProject;
  },

  async pushActiveLocalProjectToCloud(params: {
    mode: 'bound' | 'create_new' | 'link_existing';
    quickBarState?: QuickBarConnectionState;
    targetProjectId?: string;
    orgId?: string;
    projectName?: string;
    projectCode?: string;
    defaultProtocol?: 'CAN' | 'CAN_FD' | 'J1939';
    description?: string;
    commitMessage?: string;
    force?: boolean;
  }): Promise<{ project: CloudProjectItem; revisionNumber: number }> {
    const rawSnapshot = projectStore.buildProjectSnapshot(params.quickBarState);
    const snapshot = toCloudCompatibleWorkspace(rawSnapshot);

    if (params.mode === 'create_new') {
      const orgId =
        params.orgId ||
        currentState.selectedOrgId ||
        currentState.organizations[0]?.id;
      if (!orgId) {
        throw new Error(
          'Proje oluşturmak için bir organizasyon bulunamadı. Lütfen oturumunuzu ve organizasyon yetkilerinizi kontrol edin.',
        );
      }
      const projName =
        params.projectName?.trim() ||
        projectStore.getState().currentName.trim() ||
        'Yeni Proje';
      const projCode =
        params.projectCode?.trim() || suggestCloudProjectCode(projName);
      const defaultProtocol = params.defaultProtocol ?? 'CAN_FD';

      const createdProject = await cloudBridgeStore.createCloudProject({
        orgId,
        name: projName,
        code: projCode,
        defaultProtocol,
        description: params.description,
        initialWorkspace: snapshot,
        bindLocalIfActive: true,
        quickBarState: params.quickBarState,
      });

      return {
        project: createdProject,
        revisionNumber: currentState.lastWorkspaceRevisionNumber ?? 1,
      };
    }

    let targetId: string | undefined;
    if (params.mode === 'bound') {
      targetId =
        projectStore.getState().cloudBinding?.projectId ?? params.targetProjectId;
    } else {
      targetId = params.targetProjectId;
    }

    if (!targetId) {
      throw new Error(
        params.mode === 'bound'
          ? 'Bu yerel proje henüz bir bulut projesine bağlanmamış.'
          : 'Bağlanacak bir bulut projesi seçilmelidir.',
      );
    }

    let targetProject = currentState.projects.find((p) => p.id === targetId);
    if (!targetProject) {
      await cloudBridgeStore.refreshProjects();
      targetProject = currentState.projects.find((p) => p.id === targetId);
    }
    if (!targetProject) {
      throw new Error(`Seçilen bulut projesi bulunamadı (ID: ${targetId}).`);
    }

    const baseRev = params.force
      ? null
      : params.mode === 'bound'
        ? (projectStore.getState().cloudBinding?.baseRevisionNumber ?? null)
        : null;
    const force = params.force ?? (params.mode === 'link_existing');

    const { revisionNumber } =
      await cloudBridgeStore.pushWorkspacePayloadToCloud({
        projectId: targetId,
        workspace: snapshot,
        commitMessage: params.commitMessage,
        baseRevisionNumber: baseRev,
        force,
        bindLocalIfActive: true,
        quickBarState: params.quickBarState,
      });

    await cloudBridgeStore.setInspectedProject(targetId);

    return {
      project: targetProject,
      revisionNumber,
    };
  },

  async listPullableCloudDatabases(
    projectId: string,
  ): Promise<PullableCloudDatabaseItem[]> {
    const { sessionToken, cloudBaseUrl } = currentState;
    if (!sessionToken || !projectId) {
      return [];
    }

    const items: PullableCloudDatabaseItem[] = [];
    const seenFileNames = new Set<string>();

    // 1. Fetch managed databases from /api/projects/:id/databases
    try {
      const res = await fetchCloudJson<{
        databases?: NetworkDatabaseSummaryDto[];
      }>(
        `${cloudBaseUrl}/api/projects/${encodeURIComponent(projectId)}/databases`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        },
      );

      if (res.ok && res.data && Array.isArray(res.data.databases)) {
        for (const db of res.data.databases) {
          const latest = db.latestVersion;
          const fileName = latest?.fileName || `${db.slug}.${db.format}`;
          const lowerName = fileName.toLowerCase();
          seenFileNames.add(lowerName);

          items.push({
            key: `managed:${db.id}`,
            source: 'managed',
            databaseId: db.id,
            versionId: latest?.id,
            name: db.name || fileName,
            fileName,
            format: db.format === 'kcd' ? 'kcd' : 'dbc',
            sizeBytes: latest?.sizeBytes ?? 0,
            messageCount: latest?.messageCount ?? null,
            signalCount: latest?.signalCount ?? null,
          });
        }
      }
    } catch {
      // Best-effort
    }

    // 2. Fetch workspace databases from /api/projects/:id/workspace
    try {
      const wsRes = await fetchCloudJson<{
        workspaceFile?: NexusProjectFileV1;
        workspace?: NexusProjectFileV1;
      }>(
        `${cloudBaseUrl}/api/projects/${encodeURIComponent(projectId)}/workspace`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        },
      );

      const ws =
        wsRes.ok && wsRes.data
          ? (wsRes.data.workspaceFile ?? wsRes.data.workspace)
          : undefined;
      const customFiles = ws?.databases?.customFiles;

      if (Array.isArray(customFiles)) {
        for (const file of customFiles) {
          if (
            !file ||
            typeof file.fileName !== 'string' ||
            typeof file.contentBase64 !== 'string'
          ) {
            continue;
          }
          const lowerName = file.fileName.toLowerCase();
          if (seenFileNames.has(lowerName)) {
            continue;
          }
          seenFileNames.add(lowerName);

          const isKcd = lowerName.endsWith('.kcd');
          const sizeBytes =
            file.sizeBytes ?? Math.floor((file.contentBase64.length * 3) / 4);

          items.push({
            key: `ws:${lowerName}`,
            source: 'workspace',
            name: file.fileName,
            fileName: file.fileName,
            format: isKcd ? 'kcd' : 'dbc',
            sizeBytes,
            messageCount: null,
            signalCount: null,
            embeddedBase64: file.contentBase64,
          });
        }
      }
    } catch {
      // Best-effort
    }

    return items;
  },

  async downloadCloudDatabaseBase64(
    projectId: string,
    item: PullableCloudDatabaseItem,
  ): Promise<{ fileName: string; contentBase64: string }> {
    const { sessionToken, cloudBaseUrl } = currentState;

    if (item.source === 'workspace' && item.embeddedBase64) {
      return {
        fileName: item.fileName,
        contentBase64: item.embeddedBase64,
      };
    }

    if (item.source === 'managed' && item.databaseId) {
      if (!sessionToken) {
        throw new Error('Bulut veritabanını indirmek için oturum açmalısınız.');
      }

      const res = await fetchCloudJson<{
        databaseId?: string;
        fileName?: string;
        contentBase64?: string;
      }>(
        `${cloudBaseUrl}/api/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(item.databaseId)}/download?format=json`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        },
      );

      if (!res.ok || !res.data || typeof res.data.contentBase64 !== 'string') {
        throw new Error(res.errorMessage ?? `${item.fileName} indirilemedi.`);
      }

      return {
        fileName: res.data.fileName || item.fileName,
        contentBase64: res.data.contentBase64,
      };
    }

    if (item.embeddedBase64) {
      return {
        fileName: item.fileName,
        contentBase64: item.embeddedBase64,
      };
    }

    throw new Error(`Veritabanı içeriği bulunamadı: ${item.fileName}`);
  },

  async fetchProjectToolpacks(projectId?: string): Promise<EngineeringToolpackId[]> {
    const { sessionToken, cloudBaseUrl } = currentState;
    const targetId = projectId ?? currentState.inspectedProjectId ?? currentState.selectedProjectId;
    if (!sessionToken || !targetId) {
      throw new Error('Proje paketlerini çekmek için oturum açılmalı ve proje seçilmelidir.');
    }

    const res = await fetchCloudJson<{ enabledToolpacks?: unknown }>(
      `${cloudBaseUrl}/api/projects/${encodeURIComponent(targetId)}/toolpacks`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      },
    );

    if (!res.ok || !res.data) {
      throw new Error(res.errorMessage ?? 'Proje mühendislik paketleri alınamadı.');
    }

    const rawList = Array.isArray(res.data.enabledToolpacks)
      ? (res.data.enabledToolpacks as readonly string[])
      : undefined;
    return normalizeEnabledToolpacks(rawList);
  },

  async updateProjectToolpacksOnCloud(
    enabledToolpacks: readonly (EngineeringToolpackId | string)[],
    projectId?: string,
  ): Promise<{ enabledToolpacks: EngineeringToolpackId[]; revisionNumber?: number }> {
    const { sessionToken, cloudBaseUrl } = currentState;
    const targetId = projectId ?? currentState.inspectedProjectId ?? currentState.selectedProjectId;
    if (!sessionToken || !targetId) {
      throw new Error('Proje paketlerini bulutta güncellemek için oturum açılmalı ve proje seçilmelidir.');
    }

    const normalized = normalizeEnabledToolpacks(enabledToolpacks);

    const res = await fetchCloudJson<{
      enabledToolpacks?: unknown;
      revisionNumber?: number;
    }>(
      `${cloudBaseUrl}/api/projects/${encodeURIComponent(targetId)}/toolpacks`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabledToolpacks: normalized }),
      },
    );

    if (!res.ok || !res.data) {
      throw new Error(res.errorMessage ?? 'Proje mühendislik paketleri bulutta güncellenemedi.');
    }

    const returnedList = Array.isArray(res.data.enabledToolpacks)
      ? (res.data.enabledToolpacks as readonly string[])
      : normalized;

    return {
      enabledToolpacks: normalizeEnabledToolpacks(returnedList),
      revisionNumber:
        typeof res.data.revisionNumber === 'number' ? res.data.revisionNumber : undefined,
    };
  },

  async fetchRemoteWorkspace(
    projectId?: string,
  ): Promise<{ workspace: NexusProjectFileV1; revisionNumber: number }> {
    const { sessionToken, cloudBaseUrl } = currentState;
    const targetId = projectId ?? currentState.inspectedProjectId ?? currentState.selectedProjectId;
    if (!sessionToken || !targetId) {
      throw new Error('Uzak çalışma alanını indirmek için proje seçilmelidir.');
    }

    currentState = {
      ...currentState,
      loadingRemoteWorkspace: true,
      errorMessage: null,
    };
    emitFullChange();

    try {
      const res = await fetchCloudJson<Record<string, unknown>>(
        `${cloudBaseUrl}/api/projects/${encodeURIComponent(targetId)}/workspace`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        },
      );

      const targetProject = currentState.projects.find((p) => p.id === targetId);
      const fallbackName = targetProject?.name ?? 'Cloud Project';

      let workspace: NexusProjectFileV1;
      let revisionNumber = 1;
      let revisionMeta: CloudBridgeStoreState['remoteRevisionMeta'] = null;

      if (res.ok && res.data) {
        const rawWorkspace =
          res.data.workspaceFile ?? res.data.workspace ?? res.data.snapshot ?? res.data;

        const norm = validateAndNormalizeWorkspaceJson(rawWorkspace, fallbackName);
        if (norm.ok) {
          workspace = norm.project;
        } else {
          const emptyNorm = validateAndNormalizeWorkspaceJson({}, fallbackName);
          workspace = emptyNorm.ok ? emptyNorm.project : ({} as NexusProjectFileV1);
        }

        const revObj = isPlainObject(res.data.revision) ? res.data.revision : null;
        if (revObj && typeof revObj.revisionNumber === 'number') {
          revisionNumber = revObj.revisionNumber;
          revisionMeta = {
            revisionNumber,
            commitMessage: typeof revObj.commitMessage === 'string' ? revObj.commitMessage : null,
            updatedAt: typeof revObj.updatedAt === 'string' ? revObj.updatedAt : null,
            updatedBy: typeof revObj.updatedBy === 'string' ? revObj.updatedBy : null,
            contentSha256: typeof revObj.contentSha256 === 'string' ? revObj.contentSha256 : null,
          };
        } else if (typeof res.data.revisionNumber === 'number') {
          revisionNumber = res.data.revisionNumber;
        }
      } else {
        const emptyNorm = validateAndNormalizeWorkspaceJson({}, fallbackName);
        workspace = emptyNorm.ok ? emptyNorm.project : ({} as NexusProjectFileV1);
      }

      currentState = {
        ...currentState,
        loadingRemoteWorkspace: false,
        remoteWorkspace: workspace,
        remoteRevisionNumber: revisionNumber,
        remoteRevisionMeta: revisionMeta,
        conflictState: null,
        remoteUpdateAvailableRev:
          currentState.remoteUpdateAvailableRev === revisionNumber
            ? null
            : currentState.remoteUpdateAvailableRev,
      };
      emitFullChange();

      return { workspace, revisionNumber };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      currentState = {
        ...currentState,
        loadingRemoteWorkspace: false,
        errorMessage: msg,
      };
      emitFullChange();
      throw new Error(msg);
    }
  },

  async pushWorkspacePayloadToCloud(params: {
    projectId?: string;
    workspace: NexusProjectFileV1;
    commitMessage?: string;
    baseRevisionNumber?: number | null;
    force?: boolean;
    bindLocalIfActive?: boolean;
    quickBarState?: QuickBarConnectionState;
  }): Promise<{ revisionNumber: number }> {
    const { sessionToken, cloudBaseUrl } = currentState;
    const targetId =
      params.projectId ?? currentState.inspectedProjectId ?? currentState.selectedProjectId;
    if (!sessionToken || !targetId) {
      throw new Error('Çalışma alanını göndermek için bulut oturumu ve proje seçilmelidir.');
    }

    currentState = {
      ...currentState,
      syncingWorkspace: true,
      errorMessage: null,
    };
    emitFullChange();

    try {
      const targetProject = currentState.projects.find((p) => p.id === targetId);
      const effectiveMessage =
        params.commitMessage && params.commitMessage.trim().length > 0
          ? params.commitMessage.trim()
          : `NexusCAN Güncellemesi (${params.workspace.name})`;

      const schema = databaseStore.getPrimaryLiveSchema();

      const bodyPayload = {
        commitMessage: effectiveMessage,
        baseRevisionNumber: params.baseRevisionNumber ?? null,
        force: Boolean(params.force),
        linkedDbcVersionLabel: schema?.info.version ?? null,
        workspaceFile: params.workspace,
      };

      const res = await fetchCloudJson<Record<string, unknown>>(
        `${cloudBaseUrl}/api/projects/${encodeURIComponent(targetId)}/workspace`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify(bodyPayload),
        },
      );

      if (res.status === 409) {
        const revObj = isPlainObject(res.data?.revision) ? res.data?.revision : null;
        const remoteRev =
          revObj && typeof revObj.revisionNumber === 'number'
            ? revObj.revisionNumber
            : typeof res.data?.remoteRevisionNumber === 'number'
              ? res.data.remoteRevisionNumber
              : null;

        currentState = {
          ...currentState,
          syncingWorkspace: false,
          conflictState: {
            remoteRevisionNumber: remoteRev,
            message:
              res.errorMessage ??
              'Sunucuda daha yeni bir revizyon mevcut (409 Conflict). Önce çekin veya zorla yazın.',
          },
          remoteUpdateAvailableRev: remoteRev,
        };
        emitFullChange();
        throw new Error(
          res.errorMessage ?? 'Sunucuda daha yeni bir revizyon mevcut (409 Conflict).',
        );
      }

      if (!res.ok || !res.data) {
        throw new Error(res.errorMessage ?? 'Çalışma alanı buluta gönderilemedi.');
      }

      const revObj = isPlainObject(res.data.revision) ? res.data.revision : null;
      const revisionNumber =
        revObj && typeof revObj.revisionNumber === 'number' ? revObj.revisionNumber : 1;

      currentState = {
        ...currentState,
        syncingWorkspace: false,
        remoteWorkspace: params.workspace,
        remoteRevisionNumber: revisionNumber,
        lastWorkspaceSyncAt: new Date().toISOString(),
        lastWorkspaceRevisionNumber: revisionNumber,
        conflictState: null,
        remoteUpdateAvailableRev: null,
        projects: currentState.projects.map((p) =>
          p.id === targetId ? { ...p, latestRevisionNumber: revisionNumber, hasWorkspace: true } : p,
        ),
      };

      if (params.bindLocalIfActive && targetProject) {
        const matchingOrg = currentState.organizations.find(
          (o) => o.id === targetProject.orgId,
        );
        const binding: CloudProjectBindingV1 = {
          cloudBaseUrl,
          orgId: targetProject.orgId,
          orgName: matchingOrg?.name,
          orgSlug: matchingOrg?.slug,
          projectId: targetProject.id,
          projectName: targetProject.name,
          projectSlug: targetProject.slug,
          projectCode: targetProject.code,
          baseRevisionNumber: revisionNumber,
          lastSyncedAt: new Date().toISOString(),
          lastSyncedHash: computeWorkspaceSemanticHash(params.workspace),
        };
        projectStore.setCloudBinding(binding, params.quickBarState);
      }

      emitFullChange();
      return { revisionNumber };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      currentState = {
        ...currentState,
        syncingWorkspace: false,
        errorMessage: msg,
      };
      emitFullChange();
      throw err;
    }
  },

  async pullCloudWorkspaceToDesktop(params: {
    workspace?: NexusProjectFileV1;
    projectId?: string;
    revisionNumber?: number;
    onApplyQuickBar?: (qb: QuickBarConnectionState) => void;
    navigateToTab?: ActiveDocumentTab;
  }): Promise<NexusProjectFileV1> {
    const targetId =
      params.projectId ?? currentState.inspectedProjectId ?? currentState.selectedProjectId;
    if (!targetId) {
      throw new Error('Masaüstüne çekilecek Cloud projesi seçilmedi.');
    }

    const targetProject = currentState.projects.find((p) => p.id === targetId);
    if (!targetProject) {
      throw new Error('Seçili proje listesinde bulunamadı.');
    }

    let sourceWorkspace = params.workspace ?? currentState.remoteWorkspace;
    let revNum = params.revisionNumber ?? currentState.remoteRevisionNumber ?? 1;

    if (!sourceWorkspace) {
      const fetched = await cloudBridgeStore.fetchRemoteWorkspace(targetId);
      sourceWorkspace = fetched.workspace;
      revNum = fetched.revisionNumber;
    }

    const matchingOrg = currentState.organizations.find(
      (o) => o.id === targetProject.orgId,
    );
    const binding: CloudProjectBindingV1 = {
      cloudBaseUrl: currentState.cloudBaseUrl,
      orgId: targetProject.orgId,
      orgName: matchingOrg?.name,
      orgSlug: matchingOrg?.slug,
      projectId: targetProject.id,
      projectName: targetProject.name,
      projectSlug: targetProject.slug,
      projectCode: targetProject.code,
      baseRevisionNumber: revNum,
      lastSyncedAt: new Date().toISOString(),
      lastSyncedHash: computeWorkspaceSemanticHash(sourceWorkspace),
    };

    const sanitized = sanitizeCloudWorkspaceForLocalApply(sourceWorkspace, binding);

    await projectStore.restoreProject(sanitized, params.onApplyQuickBar, { isReload: false });

    if (params.navigateToTab) {
      databaseStore.setActiveDocTab(params.navigateToTab);
    }

    return sanitized;
  },

  /**
   * Pushes the current `.nexusproj.json` workspace (embedded DBC/KCD, connection profiles,
   * disarmed TX templates, plotter signals & layout) to the active `NexusCANCloud` project.
   */
  async syncWorkspaceToCloud(
    quickBarState: QuickBarConnectionState,
    commitMessage?: string,
  ): Promise<{ revisionNumber: number }> {
    const rawSnapshot = projectStore.buildProjectSnapshot(quickBarState);
    const safeDocTab =
      rawSnapshot.workspace.activeDocTab === 'start'
        ? 'rxtx'
        : rawSnapshot.workspace.activeDocTab;

    const cloudCompatibleWorkspace = {
      ...rawSnapshot,
      workspace: {
        ...rawSnapshot.workspace,
        traceMaxBufferRows: Math.max(100, rawSnapshot.workspace.traceMaxBufferRows),
        activeDocTab: safeDocTab,
      },
    };

    return cloudBridgeStore.pushWorkspacePayloadToCloud({
      projectId: currentState.selectedProjectId ?? undefined,
      workspace: cloudCompatibleWorkspace,
      commitMessage,
      bindLocalIfActive: true,
      quickBarState,
    });
  },

  async fetchCloudPanels(projectId?: string): Promise<SimulationPanelDto[]> {
    const sessionToken = currentState.sessionToken;
    const targetId =
      projectId ?? currentState.selectedProjectId ?? currentState.inspectedProjectId;
    if (!sessionToken || !targetId) {
      throw new Error('Oturum açılmadı veya Cloud projesi seçilmedi.');
    }
    const res = await fetchCloudJson<{ panels: SimulationPanelDto[] } | SimulationPanelDto[]>(
      `${currentState.cloudBaseUrl}/api/projects/${encodeURIComponent(targetId)}/panels`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      },
    );
    if (!res.ok || !res.data) {
      throw new Error(res.errorMessage ?? 'Buluttan paneller çekilemedi.');
    }
    if (Array.isArray(res.data)) {
      return res.data;
    }
    return res.data.panels ?? [];
  },

  /**
   * `GET /api/projects/:projectId/databases[?databaseId=&versionId=]`
   * Returns the Cloud project's multi-database catalog plus the compiled schema of the
   * requested (or first) database. Call once per database id to collect every schema.
   */
  async fetchCloudProjectDatabases(
    projectId: string,
    opts?: { databaseId?: string; versionId?: string },
  ): Promise<{
    databases: NetworkDatabaseSummaryDto[];
    versions: DatabaseVersionDto[];
    activeSchema: DatabaseSchemaDto | null;
  }> {
    const sessionToken = currentState.sessionToken;
    if (!sessionToken || !projectId) {
      throw new Error('Oturum açılmadı veya Cloud projesi seçilmedi.');
    }
    const qs = new URLSearchParams();
    if (opts?.databaseId) qs.set('databaseId', opts.databaseId);
    if (opts?.versionId) qs.set('versionId', opts.versionId);
    const suffix = qs.toString().length > 0 ? `?${qs.toString()}` : '';
    const res = await fetchCloudJson<{
      databases?: NetworkDatabaseSummaryDto[];
      versions?: DatabaseVersionDto[];
      activeSchema?: DatabaseSchemaDto | null;
    }>(
      `${currentState.cloudBaseUrl}/api/projects/${encodeURIComponent(projectId)}/databases${suffix}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${sessionToken}` },
      },
    );
    if (!res.ok || !res.data) {
      throw new Error(res.errorMessage ?? 'Cloud veritabanları çekilemedi.');
    }
    return {
      databases: Array.isArray(res.data.databases) ? res.data.databases : [],
      versions: Array.isArray(res.data.versions) ? res.data.versions : [],
      activeSchema: res.data.activeSchema ?? null,
    };
  },

  async createCloudPanel(
    panel: SimulationPanelDto,
    projectId?: string,
  ): Promise<SimulationPanelDto> {
    const sessionToken = currentState.sessionToken;
    const targetId =
      projectId ?? currentState.selectedProjectId ?? currentState.inspectedProjectId;
    if (!sessionToken || !targetId) {
      throw new Error('Oturum açılmadı veya Cloud projesi seçilmedi.');
    }
    const res = await fetchCloudJson<{ panel: SimulationPanelDto } | SimulationPanelDto>(
      `${currentState.cloudBaseUrl}/api/projects/${encodeURIComponent(targetId)}/panels`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify(panel),
      },
    );
    if (!res.ok || !res.data) {
      throw new Error(res.errorMessage ?? 'Panel bulutta oluşturulamadı.');
    }
    return 'panel' in res.data ? res.data.panel : res.data;
  },

  async updateCloudPanel(
    panelId: string,
    panel: Partial<SimulationPanelDto>,
    projectId?: string,
  ): Promise<SimulationPanelDto> {
    const sessionToken = currentState.sessionToken;
    const targetId =
      projectId ?? currentState.selectedProjectId ?? currentState.inspectedProjectId;
    if (!sessionToken || !targetId) {
      throw new Error('Oturum açılmadı veya Cloud projesi seçilmedi.');
    }
    const res = await fetchCloudJson<{ panel: SimulationPanelDto } | SimulationPanelDto>(
      `${currentState.cloudBaseUrl}/api/projects/${encodeURIComponent(targetId)}/panels/${encodeURIComponent(panelId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify(panel),
      },
    );
    if (!res.ok || !res.data) {
      throw new Error(res.errorMessage ?? 'Panel güncellenemedi.');
    }
    return 'panel' in res.data ? res.data.panel : res.data;
  },

  async deleteCloudPanel(panelId: string, projectId?: string): Promise<void> {
    const sessionToken = currentState.sessionToken;
    const targetId =
      projectId ?? currentState.selectedProjectId ?? currentState.inspectedProjectId;
    if (!sessionToken || !targetId) {
      throw new Error('Oturum açılmadı veya Cloud projesi seçilmedi.');
    }
    const res = await fetchCloudJson<unknown>(
      `${currentState.cloudBaseUrl}/api/projects/${encodeURIComponent(targetId)}/panels/${encodeURIComponent(panelId)}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      },
    );
    if (!res.ok) {
      throw new Error(res.errorMessage ?? 'Panel silinemedi.');
    }
  },

  /**
   * Stops the live telemetry WebSocket stream WITHOUT logging out: the Cloud session,
   * project list and provisioned bridge token are kept so the stream can be resumed later.
   * Disables `autoConnect` so a page reload does not silently restart streaming.
   */
  stopLiveStream(): void {
    shouldMaintainConnection = false;
    clearTimers();
    closeActiveSocketCleanly('USER_STOP_STREAM');
    currentState = {
      ...currentState,
      status: 'disconnected',
      autoConnect: false,
      latencyMs: 0,
      errorMessage: null,
    };
    persistCurrentSession();
    emitFullChange();
  },

  /** Resumes live streaming to the currently selected Cloud project (re-provisions if needed). */
  async resumeLiveStream(): Promise<void> {
    const projId = currentState.selectedProjectId;
    if (!currentState.sessionToken || !projId) return;
    if (currentState.bridgeToken && currentState.deviceId && currentState.streamId) {
      currentState = { ...currentState, autoConnect: true, errorMessage: null };
      persistCurrentSession();
      emitFullChange();
      shouldMaintainConnection = true;
      reconnectAttempt = 0;
      openBridgeSocket();
      return;
    }
    await cloudBridgeStore.switchProject(projId);
  },

  /**
   * Cleanly closes the WebSocket bridge and clears stored cloud credentials.
   */
  async disconnectAndLogout(): Promise<void> {
    shouldMaintainConnection = false;
    clearTimers();
    closeActiveSocketCleanly('USER_LOGOUT');

    const prevBaseUrl = currentState.cloudBaseUrl;
    const prevToken = currentState.sessionToken;

    currentState = {
      ...currentState,
      status: 'disconnected',
      autoConnect: false,
      sessionToken: null,
      bridgeToken: null,
      deviceId: null,
      deviceName: null,
      streamId: null,
      cloudCapturing: false,
      activeCaptureSessionId: null,
      activeCaptureSessionName: null,
      capturedFramesCount: 0,
      sentSnapshotsCount: 0,
      latencyMs: 0,
      schemaSyncedName: null,
      schemaAckStatus: 'idle',
      errorMessage: null,
      pushPromptContext: null,
    };
    persistCurrentSession();
    emitFullChange();
    logUiDebugEvent({
      severity: 'info',
      category: 'WORKBENCH',
      action: 'cloud.disconnected',
      title: 'Cloud Bridge Disconnected',
    });

    if (prevToken) {
      void fetch(`${prevBaseUrl}/api/auth/logout`, {
        method: 'POST',
        mode: 'cors',
        headers: {
          Authorization: `Bearer ${prevToken}`,
        },
      }).catch(() => undefined);
    }
  },
};

export function useCloudBridgeStore(): CloudBridgeStoreState {
  return useSyncExternalStore(
    cloudBridgeStore.subscribe,
    cloudBridgeStore.getState,
    cloudBridgeStore.getState,
  );
}

export function useCloudBridgeHeader(): CloudBridgeHeaderSlice {
  return useSyncExternalStore(
    cloudBridgeStore.subscribeHeader,
    cloudBridgeStore.getHeaderSlice,
    cloudBridgeStore.getHeaderSlice,
  );
}

interface ViteHotContext {
  readonly data: Record<string, unknown>;
  dispose(cb: (data: Record<string, unknown>) => void): void;
}

const viteHot = (import.meta as unknown as { hot?: ViteHotContext }).hot;

if (viteHot) {
  const prevWasInitialized = Boolean(viteHot.data?.wasInitialized);

  viteHot.dispose((data: Record<string, unknown>) => {
    data.wasInitialized = lifecycleInitialized;
    shouldMaintainConnection = false;
    clearTimers();
    closeActiveSocketCleanly('HMR_RELOAD');
    while (storeUnsubscribers.length > 0) {
      const unsub = storeUnsubscribers.pop();
      unsub?.();
    }
    storesBound = false;
  });

  if (prevWasInitialized) {
    queueMicrotask(() => {
      cloudBridgeStore.initializeLifecycle();
    });
  }
}
