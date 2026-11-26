import { useSyncExternalStore } from 'react';
import type { UiNotifyLevel } from '../types/mcp';

export const MCP_TOAST_TTL_MS = 5000;
const MAX_TOASTS = 4;

export interface McpToast {
  id: number;
  level: UiNotifyLevel;
  text: string;
}

export interface McpConfirmRequest {
  id: number;
  title: string;
  message: string;
  confirmLabel: string | null;
}

export interface McpOverlayState {
  toasts: readonly McpToast[];
  confirm: McpConfirmRequest | null;
}

let state: McpOverlayState = { toasts: [], confirm: null };
let nextId = 1;
let confirmResolver: ((v: boolean) => void) | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<McpOverlayState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export const mcpUiOverlayStore = {
  getState: (): McpOverlayState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  pushToast(level: UiNotifyLevel, text: string): void {
    const id = nextId++;
    set({ toasts: [...state.toasts, { id, level, text }].slice(-MAX_TOASTS) });
    globalThis.setTimeout(() => mcpUiOverlayStore.dismissToast(id), MCP_TOAST_TTL_MS);
  },
  dismissToast(id: number): void {
    if (!state.toasts.some((t) => t.id === id)) return;
    set({ toasts: state.toasts.filter((t) => t.id !== id) });
  },
  /** Opens the Yes/No dialog; a previous pending dialog is resolved as `false`. */
  askConfirm(title: string, message: string, confirmLabel: string | null, timeoutMs?: number): Promise<boolean> {
    if (confirmResolver) confirmResolver(false);
    return new Promise<boolean>((resolve) => {
      confirmResolver = resolve;
      const id = nextId++;
      set({ confirm: { id, title, message, confirmLabel } });
      if (timeoutMs !== undefined) {
        globalThis.setTimeout(() => mcpUiOverlayStore.answerConfirm(false, id), timeoutMs);
      }
    });
  },
  answerConfirm(confirmed: boolean, id?: number): void {
    if (id !== undefined && state.confirm?.id !== id) return;
    const r = confirmResolver;
    confirmResolver = null;
    set({ confirm: null });
    if (r) r(confirmed);
  },
};

export function useMcpUiOverlay(): McpOverlayState {
  return useSyncExternalStore(mcpUiOverlayStore.subscribe, mcpUiOverlayStore.getState, mcpUiOverlayStore.getState);
}
