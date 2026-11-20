import { useSyncExternalStore } from 'react';
import type { McpServerStatusDto, McpUiActionEntry } from '../types/mcp';
import { isTauri } from '../services/ipcClient';
import { apiMcpStart, apiMcpStatus, apiMcpStop } from '../services/mcpClient';

export const MCP_DEFAULT_PORT = 17800;
export const MCP_MIN_PORT = 1024;
export const MCP_MAX_PORT = 65535;
export const MCP_POLL_INTERVAL_MS = 2000;
export const MCP_UI_ACTION_LIMIT = 10;
export const MCP_ACTIVITY_MS = 3000;

export interface McpState {
  /** false in browser mode (cmd_mcp_* exist only in the Tauri desktop app). */
  available: boolean;
  status: McpServerStatusDto | null;
  busy: boolean;
  error: string | null;
  panelOpen: boolean;
  /** Last Claude UI actions, newest first (max MCP_UI_ACTION_LIMIT). */
  uiActions: readonly McpUiActionEntry[];
  /** Short-lived status-bar label ("Claude → Plotter"), null when idle. */
  activity: string | null;
}

export interface McpApi {
  start(port: number | null): Promise<McpServerStatusDto>;
  stop(): Promise<McpServerStatusDto>;
  status(): Promise<McpServerStatusDto>;
}

export interface McpTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

/** Returns an integer port in 1024..65535, or null when invalid. */
export function parseMcpPort(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= MCP_MIN_PORT && n <= MCP_MAX_PORT ? n : null;
}

export function buildClaudeCodeCommand(endpointUrl: string, token: string): string {
  return `claude mcp add --transport http nexuscan ${endpointUrl} --header "Authorization: Bearer ${token}"`;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

const defaultApi: McpApi = { start: apiMcpStart, stop: apiMcpStop, status: apiMcpStatus };
const defaultTimers: McpTimers = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createMcpStore(
  api: McpApi = defaultApi,
  timers: McpTimers = defaultTimers,
  available: boolean = isTauri,
) {
  let state: McpState = { available, status: null, busy: false, error: null, panelOpen: false,
    uiActions: [],
    activity: null,
  };
  let actionSeq = 0;
  let activityHandle: unknown = null;
  const listeners = new Set<() => void>();
  let pollHandle: unknown = null;
  let polling = false;

  function set(patch: Partial<McpState>): void {
    state = { ...state, ...patch };
    syncPolling();
    listeners.forEach((l) => l());
  }

  /** Poll only while the server runs or the panel is open. */
  function syncPolling(): void {
    const want = available && (state.panelOpen || state.status?.running === true);
    if (want && pollHandle === null) {
      pollHandle = timers.setInterval(() => {
        void store.refresh();
      }, MCP_POLL_INTERVAL_MS);
    } else if (!want && pollHandle !== null) {
      timers.clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  const store = {
    getState: (): McpState => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isPolling: (): boolean => pollHandle !== null,
    /** Records a handled Claude UI request: list entry + short status-bar label. */
    recordUiAction(entry: { kind: string; summary: string; label: string; ok: boolean; atMs?: number }): void {
      actionSeq += 1;
      const item: McpUiActionEntry = {
        seq: actionSeq,
        atMs: entry.atMs ?? Date.now(),
        kind: entry.kind,
        summary: entry.summary,
        ok: entry.ok,
      };
      set({
        uiActions: [item, ...state.uiActions].slice(0, MCP_UI_ACTION_LIMIT),
        activity: entry.label,
      });
      if (timers.setTimeout && timers.clearTimeout) {
        if (activityHandle !== null) timers.clearTimeout(activityHandle);
        activityHandle = timers.setTimeout(() => {
          activityHandle = null;
          set({ activity: null });
        }, MCP_ACTIVITY_MS);
      }
    },
    setPanelOpen(open: boolean): void {
      if (state.panelOpen === open) return;
      set({ panelOpen: open });
      if (open && available) void store.refresh();
    },
    async refresh(): Promise<void> {
      if (!available || polling || state.busy) return;
      polling = true;
      try {
        const status = await api.status();
        set({ status });
      } catch (err) {
        set({ error: errText(err) });
      } finally {
        polling = false;
      }
    },
    async start(port?: number | null): Promise<void> {
      if (!available || state.busy) return;
      set({ busy: true, error: null });
      try {
        const status = await api.start(port ?? null);
        set({ status, busy: false });
      } catch (err) {
        set({ busy: false, error: errText(err) });
      }
    },
    async stop(): Promise<void> {
      if (!available || state.busy) return;
      set({ busy: true, error: null });
      try {
        const status = await api.stop();
        set({ status, busy: false });
      } catch (err) {
        set({ busy: false, error: errText(err) });
      }
    },
  };
  return store;
}

export const mcpStore = createMcpStore();

export function useMcpStore(): McpState {
  return useSyncExternalStore(mcpStore.subscribe, mcpStore.getState, mcpStore.getState);
}
