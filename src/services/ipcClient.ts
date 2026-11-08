import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  BusHealthDto,
  ChannelConfigDto,
  DbFileInputDto,
  DeviceDescriptorDto,
  DriverProbeReportDto,
  ProjectSummaryDto,
} from '../types/hal';
import type { DatabaseSchemaDto } from '../types/netdb';
import type {
  ChronologicalFrameDto,
  LoadedTraceFileDto,
  PanicStopResultDto,
  PeriodicTxJobDto,
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

/**
 * Dual-transport command invocation:
 * - Native Tauri v2 Desktop WebView: `@tauri-apps/api/core` `invoke<T>`
 * - Browser Port Mode (`http://localhost:5173`): HTTP POST to `nexus_bridge` `:14210`
 */
export async function invokeCmd<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauri) {
    return invoke<T>(cmd, args);
  }

  const bridgeHost = getBridgeHost();
  const response = await fetch(`http://${bridgeHost}:${BRIDGE_PORT}/api/invoke/${cmd}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? {}),
  });

  if (!response.ok) {
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
    throw new Error(errText);
  }

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

  const connectWebSocket = (): void => {
    if (disposed) return;
    clearReconnectTimer();

    const bridgeHost = getBridgeHost();
    try {
      const socket = new WebSocket(`ws://${bridgeHost}:${BRIDGE_PORT}/ws/telemetry`);
      ws = socket;

      socket.onopen = () => {
        if (disposed) {
          socket.close();
          return;
        }
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

      socket.onclose = () => {
        if (disposed) return;
        onStatus?.(false);
        ws = null;
        clearReconnectTimer();
        reconnectTimer = window.setTimeout(connectWebSocket, 1500);
      };
    } catch {
      onStatus?.(false);
      clearReconnectTimer();
      reconnectTimer = window.setTimeout(connectWebSocket, 1500);
    }
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
