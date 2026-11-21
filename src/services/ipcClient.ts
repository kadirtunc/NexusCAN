import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  AppendDebugEventInputDto,
  BusHealthDto,
  ChannelConfigDto,
  DbFileInputDto,
  DebugEventBatchDto,
  DebugEventDto,
  DebugWindowStateDto,
  DeviceDescriptorDto,
  DriverProbeReportDto,
  HardwareWatchEventDto,
  ProjectSummaryDto,
} from '../types/hal';
import { t } from '../i18n';
import type { DatabaseSchemaDto } from '../types/netdb';
import type { AppVersionDto, OpenReleasePageArgs, UpdateCheckDto } from '../types/update';
import type { FlowLibCommandMap, FlowLibEntryDto, FlowLibRevisionDto } from '../types/flowLibrary';
import type { ComputeKeyResultDto, KeyProviderSpecDto, SeedKeyProfileDto } from '../types/seedkey';
import type {
  ChronologicalFrameDto,
  LoadedTraceFileDto,
  PanicStopResultDto,
  PeriodicTxJobDto,
  ResetSessionResultDto,
  StartTraceReplayArgsDto,
  TelemetrySnapshotDto,
  TraceFileSummaryDto,
  TraceReplayControlArgsDto,
  TraceReplayStatusDto,
  TraceStorageInfoDto,
  TxTransmitResultDto,
} from '../types/telemetry';

export const BRIDGE_PORT = 14210;

export const isTauri: boolean =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function getBridgeHost(): string {
  if (typeof window !== 'undefined' && window.location.hostname) {
    return window.location.hostname;
  }
  return '127.0.0.1';
}

interface BridgeErrorPayload {
  error?: string;
  message?: string;
}

// ─── Browser-mode bridge authentication ──────────────────────────────────────
// The local bridge requires `Authorization: Bearer <token>` on every `/api/invoke/*` request and an
// `{"type":"auth","token":…}` first WebSocket message. The Vite dev server (same origin, loopback
// only) hands the token out from `/__nexus/bridge-token`. Tauri desktop uses IPC and skips all this.
// The token is never placed in a URL and never logged.

const BRIDGE_TOKEN_ENDPOINT = '/__nexus/bridge-token';

let cachedBridgeToken: string | null = null;
let tokenInFlight: Promise<string> | null = null;

function isTokenPayload(value: unknown): value is { token: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { token?: unknown }).token === 'string' &&
    (value as { token: string }).token.length > 0
  );
}

async function requestBridgeToken(): Promise<string> {
  let response: Response;
  try {
    response = await fetch(BRIDGE_TOKEN_ENDPOINT, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    throw new Error(t('bridge.tokenMissing'));
  }
  if (!response.ok) throw new Error(t('bridge.tokenMissing'));
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(t('bridge.tokenMissing'));
  }
  if (!isTokenPayload(payload)) throw new Error(t('bridge.tokenMissing'));
  return payload.token;
}

/** Lazily fetches and caches the bridge token; `force` drops the cache (after a 401). */
export function getBridgeToken(force = false): Promise<string> {
  if (!force && cachedBridgeToken !== null) return Promise.resolve(cachedBridgeToken);
  if (tokenInFlight !== null) return tokenInFlight;
  if (force) cachedBridgeToken = null;
  const pending = requestBridgeToken()
    .then((token) => {
      cachedBridgeToken = token;
      return token;
    })
    .finally(() => {
      tokenInFlight = null;
    });
  tokenInFlight = pending;
  return pending;
}

async function postBridge(
  cmd: string,
  args: Record<string, unknown> | undefined,
  token: string,
): Promise<Response> {
  return fetch(`http://${getBridgeHost()}:${BRIDGE_PORT}/api/invoke/${cmd}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(args ?? {}),
  });
}

async function bridgeErrorText(response: Response): Promise<string> {
  let errText = `${response.status} ${response.statusText}`;
  try {
    const payload = (await response.json()) as BridgeErrorPayload;
    if (typeof payload.error === 'string' && payload.error.length > 0) {
      errText = payload.error;
    } else if (typeof payload.message === 'string' && payload.message.length > 0) {
      errText = payload.message;
    }
  } catch {
    const rawText = await response.text().catch(() => '');
    if (rawText.trim().length > 0) {
      errText = rawText.trim();
    }
  }
  return errText;
}

/**
 * Browser-bridge command whose success body is raw bytes (`application/octet-stream`, e.g. `cmd_re_series`).
 * Same bearer token + refetch-once-on-401 rule as `invokeCmd`. Browser mode only (Tauri uses `invoke` directly).
 */
export async function invokeCmdRaw(cmd: string, args?: Record<string, unknown>): Promise<ArrayBuffer> {
  let response = await postBridge(cmd, args, await getBridgeToken());
  if (response.status === 401) {
    response = await postBridge(cmd, args, await getBridgeToken(true));
  }
  if (!response.ok) throw new Error(await bridgeErrorText(response));
  return response.arrayBuffer();
}

/**
 * Dual-transport command invocation:
 * - Native Tauri v2 Desktop WebView: `@tauri-apps/api/core` `invoke<T>`
 * - Browser Port Mode (`http://127.0.0.1:5173`): authenticated HTTP POST to `nexus_bridge` `:14210`
 */
export async function invokeCmd<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauri) {
    return invoke<T>(cmd, args);
  }

  let response = await postBridge(cmd, args, await getBridgeToken());
  if (response.status === 401) {
    // Token rotated (bridge restarted): refetch once and retry once.
    response = await postBridge(cmd, args, await getBridgeToken(true));
  }

  if (!response.ok) throw new Error(await bridgeErrorText(response));

  const text = await response.text();
  if (text.trim().length === 0) {
    return null as T;
  }
  return JSON.parse(text) as T;
}

/**
 * Dual-transport 60Hz Telemetry Subscription:
 * - Native Tauri v2: `new Channel<TelemetrySnapshotDto>()` via `cmd_subscribe_telemetry`
 * - Browser Port Mode: `ws://${bridgeHost}:14210/ws/telemetry` with 1.5s clean auto-reconnect
 * - Coalesces snapshots via `requestAnimationFrame` so React renders strictly at <= 60 FPS.
 */
export function subscribeTelemetry(
  onSnapshot: (snap: TelemetrySnapshotDto) => void,
  onStatus?: (connected: boolean) => void,
): () => void {
  let disposed = false;
  let rafId: number | null = null;
  let pendingSnapshot: TelemetrySnapshotDto | null = null;
  let pendingChrono: ChronologicalFrameDto[] = [];
  let pendingSinceMs = 0;
  let lastFlushMs = 0;

  const flushNow = (): void => {
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (disposed || pendingSnapshot === null) {
      pendingChrono = [];
      pendingSinceMs = 0;
      return;
    }
    const latest =
      pendingChrono.length > 0 &&
      pendingChrono.length !== pendingSnapshot.recentChronological.length
        ? {
            ...pendingSnapshot,
            recentChronological: pendingChrono,
          }
        : pendingSnapshot;
    pendingSnapshot = null;
    pendingChrono = [];
    pendingSinceMs = 0;
    lastFlushMs = performance.now();
    onSnapshot(latest);
  };

  const scheduleFlush = (snap: TelemetrySnapshotDto): void => {
    if (disposed) return;
    const now = performance.now();

    if (snap.recentChronological.length > 0) {
      if (pendingChrono.length === 0) {
        pendingChrono = [...snap.recentChronological];
      } else {
        pendingChrono.push(...snap.recentChronological);
        if (pendingChrono.length > 2048) {
          pendingChrono = pendingChrono.slice(pendingChrono.length - 2048);
        }
      }
    }

    pendingSnapshot = snap;
    if (pendingSinceMs === 0) {
      pendingSinceMs = now;
    }

    const isHidden =
      typeof document !== 'undefined' && document.visibilityState === 'hidden';

    // CRITICAL LIVE-STREAM INVARIANT:
    // Browsers suspend `requestAnimationFrame` in background tabs AND occluded windows!
    // Flush directly from network/IPC I/O callbacks when hidden or if rAF stalls >= 24ms
    // so Cloud Live Bridge, Trace recording, and Plotter rings NEVER freeze!
    if (isHidden) {
      if (now - lastFlushMs >= 15) {
        flushNow();
      }
      return;
    }

    if (now - pendingSinceMs >= 24) {
      flushNow();
      return;
    }

    if (rafId === null) {
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        flushNow();
      });
    }
  };

  const onVisibilityChange = (): void => {
    if (!disposed && pendingSnapshot !== null) {
      flushNow();
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  const cleanupFlushState = (): void => {
    disposed = true;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    pendingSnapshot = null;
    pendingChrono = [];
    pendingSinceMs = 0;
  };

  if (isTauri) {
    const ch = new Channel<TelemetrySnapshotDto>();
    ch.onmessage = (snap: TelemetrySnapshotDto) => {
      onStatus?.(true);
      scheduleFlush(snap);
    };
    void invoke('cmd_subscribe_telemetry', { onSnapshot: ch })
      .then(() => {
        if (!disposed) {
          onStatus?.(true);
        }
      })
      .catch(() => {
        if (!disposed) {
          onStatus?.(false);
        }
      });

    return () => {
      cleanupFlushState();
    };
  }

  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  let warnedAuth = false;

  const scheduleReconnect = (): void => {
    clearReconnectTimer();
    reconnectTimer = window.setTimeout(connectWebSocket, 1500);
  };

  const openSocket = (token: string): void => {
    if (disposed) return;
    const bridgeHost = getBridgeHost();
    try {
      const socket = new WebSocket(`ws://${bridgeHost}:${BRIDGE_PORT}/ws/telemetry`);
      ws = socket;
      let authenticated = false;

      socket.onopen = () => {
        if (disposed) {
          socket.close();
          return;
        }
        // First message MUST be the auth frame (bridge closes with 4401 after 3 s otherwise).
        socket.send(JSON.stringify({ type: 'auth', token }));
        authenticated = true;
        onStatus?.(true);
      };

      socket.onmessage = (ev: MessageEvent) => {
        if (disposed || typeof ev.data !== 'string') return;
        try {
          const parsed = JSON.parse(ev.data) as TelemetrySnapshotDto;
          scheduleFlush(parsed);
        } catch {
          // Ignore malformed transient frames
        }
      };

      socket.onerror = () => {
        if (!disposed) {
          onStatus?.(false);
        }
      };

      socket.onclose = (ev: CloseEvent) => {
        if (disposed) return;
        onStatus?.(false);
        ws = null;
        if (ev.code === 4401 || !authenticated) {
          // Stale token (bridge restarted): drop the cache so the next attempt refetches.
          cachedBridgeToken = null;
        }
        scheduleReconnect();
      };
    } catch {
      onStatus?.(false);
      scheduleReconnect();
    }
  };

  const connectWebSocket = (): void => {
    if (disposed) return;
    clearReconnectTimer();
    getBridgeToken()
      .then(openSocket)
      .catch((e: unknown) => {
        if (disposed) return;
        onStatus?.(false);
        if (!warnedAuth) {
          warnedAuth = true;
          console.warn(e instanceof Error ? e.message : t('bridge.tokenMissing'));
        }
        scheduleReconnect();
      });
  };

  connectWebSocket();

  return () => {
    cleanupFlushState();
    clearReconnectTimer();
    if (ws !== null) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // Ignore close errors
      }
      ws = null;
    }
  };
}

// ============================================================================
// Typed Wrappers for Backend Commands
// ============================================================================

export function apiListDevices(): Promise<DeviceDescriptorDto[]> {
  return invokeCmd<DeviceDescriptorDto[]>('cmd_list_devices', {});
}

export function apiProbeDrivers(): Promise<DriverProbeReportDto> {
  return invokeCmd<DriverProbeReportDto>('cmd_probe_drivers', {});
}

export function apiConnectBus(
  deviceId: string,
  config: ChannelConfigDto,
): Promise<BusHealthDto> {
  return invokeCmd<BusHealthDto>('cmd_connect_bus', { deviceId, config });
}

export function apiDisconnectBus(busId: number): Promise<null> {
  return invokeCmd<null>('cmd_disconnect_bus', { busId });
}

export function apiDisconnectAllBuses(): Promise<number> {
  return invokeCmd<number>('cmd_disconnect_all_buses', {});
}

export function apiArmActiveBus(busId: number, armed: boolean): Promise<BusHealthDto> {
  return invokeCmd<BusHealthDto>('cmd_arm_active_bus', { busId, armed });
}

export function apiSetBusMode(
  busId: number,
  listenOnly: boolean,
  armTx: boolean,
): Promise<BusHealthDto> {
  return invokeCmd<BusHealthDto>('cmd_set_bus_mode', { busId, listenOnly, armTx });
}

export function apiPanicStopTx(): Promise<PanicStopResultDto> {
  return invokeCmd<PanicStopResultDto>('cmd_panic_stop_tx', {});
}

/** Errors from arming while the panic latch is set start with this prefix. */
export const PANIC_LATCHED_PREFIX = 'PANIC_LATCHED:';
/** Disarm succeeded (bus is passive) but a driver write may still be in flight. */
export const TX_IN_FLIGHT_TIMEOUT_PREFIX = 'TX_IN_FLIGHT_TIMEOUT:';

export function isTxInFlightTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return msg.includes(TX_IN_FLIGHT_TIMEOUT_PREFIX);
}

/** Connect/re-open failed because hardware Listen-Only was required but unavailable. */
export const HW_LISTEN_ONLY_UNAVAILABLE_PREFIX = 'HW_LISTEN_ONLY_UNAVAILABLE:';

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : '';
}

export function isHwListenOnlyUnavailableError(err: unknown): boolean {
  return errorMessageOf(err).includes(HW_LISTEN_ONLY_UNAVAILABLE_PREFIX);
}

/** Backend hint text following the `HW_LISTEN_ONLY_UNAVAILABLE:` prefix ('' when absent). */
export function hwListenOnlyHint(err: unknown): string {
  const msg = errorMessageOf(err);
  const i = msg.indexOf(HW_LISTEN_ONLY_UNAVAILABLE_PREFIX);
  return i < 0 ? '' : msg.slice(i + HW_LISTEN_ONLY_UNAVAILABLE_PREFIX.length).trim();
}

/** 1-based, comma-separated bus labels (matches the "Bus N" display used across the UI). */
export function formatInFlightBuses(buses: readonly number[] | undefined): string {
  return (buses ?? []).map((b) => String(b + 1)).join(', ');
}

export function isPanicLatchedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return msg.includes(PANIC_LATCHED_PREFIX);
}

/** Explicit operator action: clears the global panic latch (does not arm anything). */
export function apiClearPanicLatch(): Promise<null> {
  return invokeCmd<null>('cmd_clear_panic_latch', {});
}

/** Cold-start reset: stops jobs, disarms + disconnects buses WITHOUT latching panic; clears the latch. */
export function apiResetSession(): Promise<ResetSessionResultDto> {
  return invokeCmd<ResetSessionResultDto>('cmd_reset_session', {});
}

/**
 * Session reset that never latches Panic. Falls back to the legacy panic+disconnect pair ONLY when
 * the backend does not know `cmd_reset_session` (older build).
 */
export async function resetSessionCompat(): Promise<number[]> {
  try {
    const res = await apiResetSession();
    return res.inFlightTimeoutBuses ?? [];
  } catch (err) {
    if (!isUnknownCommandError(err)) return [];
    const res = await apiPanicStopTx().catch(() => null);
    await apiDisconnectAllBuses().catch(() => 0);
    return res?.inFlightTimeoutBuses ?? [];
  }
}

/** True when the backend rejects a command name (older backend build). */
export function isUnknownCommandError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('unknown nexuscan ipc command') ||
    msg.includes('unknown command') ||
    (msg.includes('command') && msg.includes('not found'))
  );
}

export function apiResetTelemetry(): Promise<void> {
  return invokeCmd<void>('cmd_reset_telemetry', {});
}

export function apiLoadPresetDatabases(): Promise<DatabaseSchemaDto> {
  return invokeCmd<DatabaseSchemaDto>('cmd_load_preset_databases', {});
}

export function apiClearDatabase(): Promise<void> {
  return invokeCmd<void>('cmd_clear_database', {});
}

export function apiGetCurrentSchema(): Promise<DatabaseSchemaDto | null> {
  return invokeCmd<DatabaseSchemaDto | null>('cmd_get_current_schema', {});
}

export function apiLoadDatabaseContent(
  fileName: string,
  contentBase64: string,
  appendToExisting: boolean,
): Promise<DatabaseSchemaDto> {
  return invokeCmd<DatabaseSchemaDto>('cmd_load_database_content', {
    fileName,
    contentBase64,
    appendToExisting,
  });
}

export function apiParseDatabaseSchema(
  fileName: string,
  contentBase64: string,
): Promise<DatabaseSchemaDto> {
  return invokeCmd<DatabaseSchemaDto>('cmd_parse_database_schema', {
    fileName,
    contentBase64,
  });
}

export function apiSeedKeyComputeAdhoc(
  provider: KeyProviderSpecDto,
  level: number,
  seedHex: string,
): Promise<ComputeKeyResultDto> {
  return invokeCmd<ComputeKeyResultDto>('cmd_seedkey_compute_adhoc', { provider, level, seedHex });
}

export function apiSeedKeyListProfiles(): Promise<SeedKeyProfileDto[]> {
  return invokeCmd<SeedKeyProfileDto[]>('cmd_seedkey_list_profiles', {});
}

export function apiGetPresetDatabaseFiles(): Promise<DbFileInputDto[]> {
  return invokeCmd<DbFileInputDto[]>('cmd_get_preset_database_files', {});
}

export function apiSetBusDatabases(
  busId: number,
  files: DbFileInputDto[],
): Promise<DatabaseSchemaDto | null> {
  return invokeCmd<DatabaseSchemaDto | null>('cmd_set_bus_databases', {
    busId,
    files,
  });
}

export function apiTransmitSignalFrame(params: {
  busId: number;
  arbId: number;
  isExtended: boolean;
  signalValues: [number, number][];
  periodicMs: number | null;
  jobLabel: string | null;
}): Promise<TxTransmitResultDto> {
  return invokeCmd<TxTransmitResultDto>('cmd_transmit_signal_frame', {
    busId: params.busId,
    arbId: params.arbId,
    isExtended: params.isExtended,
    signalValues: params.signalValues,
    periodicMs: params.periodicMs,
    jobLabel: params.jobLabel,
  });
}

export function apiTransmitRawFrame(params: {
  busId: number;
  arbId: number;
  isExtended: boolean;
  isFd: boolean;
  isBrs: boolean;
  data: number[];
  periodicMs: number | null;
  jobLabel: string | null;
}): Promise<TxTransmitResultDto> {
  return invokeCmd<TxTransmitResultDto>('cmd_transmit_raw_frame', {
    busId: params.busId,
    arbId: params.arbId,
    isExtended: params.isExtended,
    isFd: params.isFd,
    isBrs: params.isBrs,
    data: params.data,
    periodicMs: params.periodicMs,
    jobLabel: params.jobLabel,
  });
}

export function apiStopPeriodicTx(jobId: number): Promise<null> {
  return invokeCmd<null>('cmd_stop_periodic_tx', { jobId });
}

export function apiListPeriodicTx(): Promise<PeriodicTxJobDto[]> {
  return invokeCmd<PeriodicTxJobDto[]>('cmd_list_periodic_tx', {});
}

// ============================================================================
// Workspace Project Persistence Commands (`projects/<fileStem>.nexusproj.json`)
// ============================================================================

export function apiListProjects(): Promise<ProjectSummaryDto[]> {
  return invokeCmd<ProjectSummaryDto[]>('cmd_list_projects', {});
}

export function apiSaveProject(
  fileStem: string,
  projectJson: string,
): Promise<ProjectSummaryDto> {
  return invokeCmd<ProjectSummaryDto>('cmd_save_project', {
    fileStem,
    projectJson,
  });
}

export function apiLoadProject(fileStem: string): Promise<string> {
  return invokeCmd<string>('cmd_load_project', { fileStem });
}

export function apiDeleteProject(fileStem: string): Promise<void> {
  return invokeCmd<void>('cmd_delete_project', { fileStem });
}

// ============================================================================
// Workspace Trace Persistence & Time-Controlled Replay Commands (`traces/`)
// ============================================================================

export function apiListTraces(): Promise<TraceStorageInfoDto> {
  return invokeCmd<TraceStorageInfoDto>('cmd_list_traces', {});
}

export function apiSaveTraceFile(
  fileName: string,
  content: string,
  contentBase64?: string,
): Promise<TraceFileSummaryDto> {
  const payload =
    contentBase64 !== undefined && contentBase64 !== null && contentBase64 !== ''
      ? { fileName, content: '', contentBase64 }
      : { fileName, content };
  return invokeCmd<TraceFileSummaryDto>('cmd_save_trace_file', payload);
}

export function apiLoadTraceFile(fileName: string): Promise<LoadedTraceFileDto> {
  return invokeCmd<LoadedTraceFileDto>('cmd_load_trace_file', { fileName });
}

export function apiDeleteTraceFile(fileName: string): Promise<void> {
  return invokeCmd<void>('cmd_delete_trace_file', { fileName });
}

export function apiParseTraceContent(
  fileName: string,
  content: string,
  contentBase64?: string,
): Promise<LoadedTraceFileDto> {
  const payload =
    contentBase64 !== undefined && contentBase64 !== null && contentBase64 !== ''
      ? { fileName, content: '', contentBase64 }
      : { fileName, content };
  return invokeCmd<LoadedTraceFileDto>('cmd_parse_trace_content', payload);
}

export function apiExportTraceBlf(
  fileName: string,
  frames: ChronologicalFrameDto[],
): Promise<string> {
  return invokeCmd<string>('cmd_export_trace_blf', { fileName, frames });
}

export function apiStartTraceReplay(
  args: StartTraceReplayArgsDto,
): Promise<TraceReplayStatusDto> {
  return invokeCmd<TraceReplayStatusDto>('cmd_start_trace_replay', { args });
}

export function apiControlTraceReplay(
  args: TraceReplayControlArgsDto,
): Promise<TraceReplayStatusDto> {
  return invokeCmd<TraceReplayStatusDto>('cmd_control_trace_replay', { args });
}

/**
 * Real-time hardware hotplug and topology change subscription.
 * In Tauri runtime: creates a Channel<HardwareWatchEventDto> and invokes 'cmd_subscribe_hardware_changes'.
 * In browser bridge fallback: polls apiListDevices() + apiProbeDrivers() every 3500ms when visible
 * and fires onEvent whenever topology changes.
 * Returns unsubscribe cleanup function.
 */
export function subscribeHardwareChanges(
  onEvent: (ev: HardwareWatchEventDto) => void,
): () => void {
  let disposed = false;

  if (isTauri) {
    const onEventChan = new Channel<HardwareWatchEventDto>();
    onEventChan.onmessage = (ev: HardwareWatchEventDto) => {
      if (!disposed) {
        onEvent(ev);
      }
    };
    void invoke('cmd_subscribe_hardware_changes', { onEvent: onEventChan }).catch((err) => {
      console.warn('[ipcClient] cmd_subscribe_hardware_changes warning or unsupported:', err);
    });

    return () => {
      disposed = true;
    };
  }

  // Non-Tauri fallback: poll every 3500ms
  let lastFingerprint = '';
  const poll = async (): Promise<void> => {
    if (disposed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    try {
      const [devices, report] = await Promise.all([apiListDevices(), apiProbeDrivers()]);
      if (disposed) return;
      const fp = JSON.stringify({
        devs: devices.map((d) => d.deviceId),
        usb: (report.usbDevices ?? []).map((u) => `${u.vidPid}-${u.suggestedChannel}-${u.locationInfo ?? ''}`),
        ports: report.serialPorts.map((s) => s.portName),
      });
      if (fp !== lastFingerprint) {
        lastFingerprint = fp;
        onEvent({
          reason: 'topology_poll',
          timestampMs: Date.now(),
          devices,
          report,
        });
      }
    } catch {
      // Ignore polling errors
    }
  };

  const timer = window.setInterval(() => {
    void poll();
  }, 3500);

  return () => {
    disposed = true;
    window.clearInterval(timer);
  };
}

// ============================================================================
// Global & Multi-Window Tear-Off Debug & Audit Console Commands
// ============================================================================

let fallbackDebugSeq = 1;
const debugWindowSyncChannel: BroadcastChannel | null =
  typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('nexuscan:debug-window-sync')
    : null;

export function subscribeDebugEvents(
  onBatch: (batch: DebugEventBatchDto) => void,
): () => void {
  let disposed = false;

  if (isTauri) {
    const onBatchChan = new Channel<DebugEventBatchDto>();
    onBatchChan.onmessage = (batch: DebugEventBatchDto) => {
      if (!disposed) {
        onBatch(batch);
      }
    };
    void invoke('cmd_subscribe_debug_events', { onBatch: onBatchChan }).catch((err) => {
      console.warn('[ipcClient] cmd_subscribe_debug_events error or unsupported:', err);
    });

    return () => {
      disposed = true;
    };
  }

  // Non-Tauri fallback: listen on BroadcastChannel for window state sync in pure mock/browser mode
  const handleBcMessage = (event: MessageEvent<DebugEventBatchDto>): void => {
    if (!disposed && event.data) {
      onBatch(event.data);
    }
  };

  if (debugWindowSyncChannel) {
    debugWindowSyncChannel.addEventListener('message', handleBcMessage);
  }

  // 1) Initial snapshot via bridge command
  void invokeCmd<{ subscribed: boolean; wsPath: string; initial: DebugEventBatchDto }>(
    'cmd_subscribe_debug_events',
    {},
  )
    .then((res) => {
      if (!disposed && res?.initial) {
        onBatch(res.initial);
      }
    })
    .catch(() => {
      // Fallback initial window state if command not yet implemented or offline
      if (!disposed) {
        onBatch({
          kind: 'snapshot',
          events: [],
          totalBuffered: 0,
          windowState: {
            detachedOpen: false,
            alwaysOnTop: false,
            reDockRequested: false,
            sessionLogPath: null,
          },
        });
      }
    });

  // 2) Open authenticated WebSocket to /ws/debug with auto-reconnect
  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = (): void => {
    clearReconnectTimer();
    if (!disposed) {
      reconnectTimer = window.setTimeout(connectDebugWebSocket, 1500);
    }
  };

  const openDebugSocket = (token: string): void => {
    if (disposed) return;
    const bridgeHost = getBridgeHost();
    try {
      const socket = new WebSocket(`ws://${bridgeHost}:${BRIDGE_PORT}/ws/debug`);
      ws = socket;
      let authenticated = false;

      socket.onopen = () => {
        if (disposed) {
          socket.close();
          return;
        }
        socket.send(JSON.stringify({ type: 'auth', token }));
        authenticated = true;
      };

      socket.onmessage = (ev: MessageEvent) => {
        if (disposed || typeof ev.data !== 'string') return;
        try {
          const parsed = JSON.parse(ev.data) as DebugEventBatchDto;
          onBatch(parsed);
        } catch {
          // Ignore malformed transient frames
        }
      };

      socket.onerror = () => {
        // Will trigger onclose and reconnect
      };

      socket.onclose = (ev: CloseEvent) => {
        if (disposed) return;
        ws = null;
        if (ev.code === 4401 || !authenticated) {
          cachedBridgeToken = null;
        }
        scheduleReconnect();
      };
    } catch {
      scheduleReconnect();
    }
  };

  const connectDebugWebSocket = (): void => {
    if (disposed) return;
    clearReconnectTimer();
    getBridgeToken()
      .then(openDebugSocket)
      .catch(() => {
        scheduleReconnect();
      });
  };

  connectDebugWebSocket();

  return () => {
    disposed = true;
    clearReconnectTimer();
    if (debugWindowSyncChannel) {
      debugWindowSyncChannel.removeEventListener('message', handleBcMessage);
    }
    if (ws !== null) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // Ignore close error
      }
      ws = null;
    }
  };
}

export async function apiAppendDebugEvent(
  input: AppendDebugEventInputDto,
): Promise<DebugEventDto> {
  try {
    return await invokeCmd<DebugEventDto>('cmd_append_debug_event', { input });
  } catch {
    // Non-Tauri local fallback when bridge is unavailable
    const now = Date.now();
    const fallbackEv: DebugEventDto = {
      seq: fallbackDebugSeq++,
      timestampMs: now,
      monotonicUs: now * 1000,
      severity: input.severity,
      category: input.category,
      source: input.source ?? 'ui',
      busId: input.busId ?? null,
      action: input.action,
      title: input.title,
      details: input.details ?? null,
      repeatCount: 1,
    };
    if (debugWindowSyncChannel) {
      debugWindowSyncChannel.postMessage({
        kind: 'append',
        events: [fallbackEv],
        totalBuffered: 1,
      } satisfies DebugEventBatchDto);
    }
    return fallbackEv;
  }
}

export async function apiClearDebugEvents(): Promise<void> {
  try {
    await invokeCmd<void>('cmd_clear_debug_events', {});
  } catch {
    if (debugWindowSyncChannel) {
      debugWindowSyncChannel.postMessage({
        kind: 'cleared',
        events: [],
        totalBuffered: 0,
      } satisfies DebugEventBatchDto);
    }
  }
}

export async function apiExportDebugEvents(
  format: 'jsonl' | 'log' | 'csv',
): Promise<string> {
  return invokeCmd<string>('cmd_export_debug_events', { format });
}

export async function apiSetDebugWindowOpen(
  open: boolean,
  alwaysOnTop?: boolean | null,
  redock?: boolean | null,
): Promise<DebugWindowStateDto> {
  if (isTauri) {
    return invokeCmd<DebugWindowStateDto>('cmd_set_debug_window_open', {
      open,
      alwaysOnTop: alwaysOnTop ?? null,
      redock: redock ?? null,
    });
  }

  // Non-Tauri browser fallback: open a popup/tab
  if (open && typeof window !== 'undefined') {
    window.open(
      '/?window=debug-console',
      'NexusCAN_DebugConsole',
      'width=1140,height=640,resizable=yes,scrollbars=yes',
    );
  }

  const state: DebugWindowStateDto = {
    detachedOpen: open,
    alwaysOnTop: Boolean(alwaysOnTop),
    reDockRequested: Boolean(redock),
    sessionLogPath: null,
  };

  if (debugWindowSyncChannel) {
    debugWindowSyncChannel.postMessage({
      kind: 'windowState',
      events: [],
      totalBuffered: 0,
      windowState: state,
    } satisfies DebugEventBatchDto);
  }

  return state;
}

// ─── Flow library (diag-workspace-v1 §9; same commands over Tauri IPC and the browser bridge) ───────────────

/** Typed call of a flow library command; errors are `"[flowlib:<code>] <message>"` (`parseFlowLibError`). */
function flowLibCall<K extends keyof FlowLibCommandMap>(cmd: K, args: FlowLibCommandMap[K]['args']): Promise<FlowLibCommandMap[K]['result']> {
  return invokeCmd<FlowLibCommandMap[K]['result']>(cmd, args);
}

export function apiFlowLibList(includeDeleted: boolean): Promise<FlowLibEntryDto[]> {
  return flowLibCall('cmd_flowlib_list', { includeDeleted });
}

export function apiFlowLibRevisions(id: string): Promise<FlowLibRevisionDto[]> {
  return flowLibCall('cmd_flowlib_revisions', { id });
}

/** File JSON of a revision (`null` = latest). */
export function apiFlowLibLoad(id: string, revision: number | null): Promise<string> {
  return flowLibCall('cmd_flowlib_load', { id, revision });
}

/** Saves the next revision (`revision` must be latest + 1, else `[flowlib:conflict]`). */
export function apiFlowLibSave(fileJson: string): Promise<FlowLibEntryDto> {
  return flowLibCall('cmd_flowlib_save', { fileJson });
}

/** Soft delete (revisions stay loadable). */
export async function apiFlowLibDelete(id: string): Promise<void> {
  await flowLibCall('cmd_flowlib_delete', { id });
}

// ============================================================================
// Update check (notification only; no auto-download). Desktop (Tauri) only:
// browser mode is silently disabled (callers gate on `isTauri`).
// ============================================================================

export const UPDATES_UNSUPPORTED = 'updates-unsupported';

export function apiGetAppVersion(): Promise<AppVersionDto> {
  if (!isTauri) return Promise.reject(new Error(UPDATES_UNSUPPORTED));
  return invoke<AppVersionDto>('cmd_get_app_version');
}

export function apiCheckForUpdate(): Promise<UpdateCheckDto> {
  if (!isTauri) return Promise.reject(new Error(UPDATES_UNSUPPORTED));
  return invoke<UpdateCheckDto>('cmd_check_for_update');
}

/** `url` omitted opens the Releases page; the backend rejects anything outside the repo's releases URL. */
export function apiOpenReleasePage(url?: string): Promise<void> {
  if (!isTauri) return Promise.reject(new Error(UPDATES_UNSUPPORTED));
  const args: OpenReleasePageArgs = url === undefined ? {} : { url };
  return invoke<void>('cmd_open_release_page', { ...args });
}
