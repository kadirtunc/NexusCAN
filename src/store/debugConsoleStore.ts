import { useSyncExternalStore } from 'react';
import type {
  AppendDebugEventInputDto,
  DebugEventBatchDto,
  DebugEventDto,
  DebugWindowStateDto,
} from '../types/hal';
import {
  apiAppendDebugEvent,
  apiClearDebugEvents,
  apiSetDebugWindowOpen,
  subscribeDebugEvents,
} from '../services/ipcClient';

export type DebugDockLayout = 'bottom' | 'right' | 'floating';

export interface FloatingRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DebugConsoleState {
  events: readonly DebugEventDto[];
  dockOpen: boolean;
  dockLayout: DebugDockLayout;
  bottomHeightPx: number;
  rightWidthPx: number;
  floatingRect: FloatingRect;
  detachedOpen: boolean;
  alwaysOnTop: boolean;
  sessionLogPath: string | null;
  unreadWarnCount: number;
  unreadErrorCount: number;
}

const MAX_DEBUG_EVENTS = 5_000;
const STORAGE_PREFIX = 'nexuscan:debugConsole';

function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, val));
}

function loadPersistedLayout(): {
  dockOpen: boolean;
  dockLayout: DebugDockLayout;
  bottomHeightPx: number;
  rightWidthPx: number;
  floatingRect: FloatingRect;
} {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {
      dockOpen: false,
      dockLayout: 'bottom',
      bottomHeightPx: 240,
      rightWidthPx: 440,
      floatingRect: { x: 120, y: 120, w: 720, h: 420 },
    };
  }

  try {
    const rawOpen = localStorage.getItem(`${STORAGE_PREFIX}:dockOpen`);
    const rawLayout = localStorage.getItem(`${STORAGE_PREFIX}:dockLayout`);
    const rawHeight = localStorage.getItem(`${STORAGE_PREFIX}:bottomHeight`);
    const rawWidth = localStorage.getItem(`${STORAGE_PREFIX}:rightWidth`);
    const rawFloating = localStorage.getItem(`${STORAGE_PREFIX}:floatingRect`);

    const dockLayout: DebugDockLayout =
      rawLayout === 'right' || rawLayout === 'floating' ? rawLayout : 'bottom';
    const bottomHeightPx = clamp(rawHeight ? Number(rawHeight) : 240, 160, 580);
    const rightWidthPx = clamp(rawWidth ? Number(rawWidth) : 440, 280, 760);

    let floatingRect: FloatingRect = { x: 120, y: 120, w: 720, h: 420 };
    if (rawFloating) {
      try {
        const parsed = JSON.parse(rawFloating) as Partial<FloatingRect>;
        if (
          typeof parsed.x === 'number' &&
          typeof parsed.y === 'number' &&
          typeof parsed.w === 'number' &&
          typeof parsed.h === 'number'
        ) {
          floatingRect = {
            x: Math.max(0, parsed.x),
            y: Math.max(0, parsed.y),
            w: clamp(parsed.w, 400, 1200),
            h: clamp(parsed.h, 240, 800),
          };
        }
      } catch {
        // use fallback
      }
    }

    return {
      dockOpen: rawOpen === 'true',
      dockLayout,
      bottomHeightPx,
      rightWidthPx,
      floatingRect,
    };
  } catch {
    return {
      dockOpen: false,
      dockLayout: 'bottom',
      bottomHeightPx: 240,
      rightWidthPx: 440,
      floatingRect: { x: 120, y: 120, w: 720, h: 420 },
    };
  }
}

const initialLayout = loadPersistedLayout();

let currentState: DebugConsoleState = {
  events: [],
  dockOpen: initialLayout.dockOpen,
  dockLayout: initialLayout.dockLayout,
  bottomHeightPx: initialLayout.bottomHeightPx,
  rightWidthPx: initialLayout.rightWidthPx,
  floatingRect: initialLayout.floatingRect,
  detachedOpen: false,
  alwaysOnTop: false,
  sessionLogPath: null,
  unreadWarnCount: 0,
  unreadErrorCount: 0,
};

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function persistItem(key: string, value: string): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.setItem(`${STORAGE_PREFIX}:${key}`, value);
    }
  } catch {
    // ignore quota/security exceptions
  }
}

export const debugConsoleStore = {
  getState(): DebugConsoleState {
    return currentState;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  setDockOpen(open: boolean): void {
    if (currentState.dockOpen === open) return;
    currentState = {
      ...currentState,
      dockOpen: open,
      unreadWarnCount: open ? 0 : currentState.unreadWarnCount,
      unreadErrorCount: open ? 0 : currentState.unreadErrorCount,
    };
    persistItem('dockOpen', String(open));
    notify();
  },

  toggleDockOpen(): void {
    if (currentState.detachedOpen) {
      void apiSetDebugWindowOpen(true).catch(() => {});
      return;
    }
    debugConsoleStore.setDockOpen(!currentState.dockOpen);
  },

  setDockLayout(layout: DebugDockLayout): void {
    if (currentState.dockLayout === layout) return;
    currentState = {
      ...currentState,
      dockLayout: layout,
    };
    persistItem('dockLayout', layout);
    notify();
  },

  setBottomHeight(heightPx: number): void {
    const clamped = clamp(heightPx, 160, 580);
    if (currentState.bottomHeightPx === clamped) return;
    currentState = {
      ...currentState,
      bottomHeightPx: clamped,
    };
    persistItem('bottomHeight', String(clamped));
    notify();
  },

  setRightWidth(widthPx: number): void {
    const clamped = clamp(widthPx, 280, 760);
    if (currentState.rightWidthPx === clamped) return;
    currentState = {
      ...currentState,
      rightWidthPx: clamped,
    };
    persistItem('rightWidth', String(clamped));
    notify();
  },

  setFloatingRect(rect: FloatingRect): void {
    const validated: FloatingRect = {
      x: Math.max(0, rect.x),
      y: Math.max(0, rect.y),
      w: clamp(rect.w, 400, 1400),
      h: clamp(rect.h, 240, 900),
    };
    currentState = {
      ...currentState,
      floatingRect: validated,
    };
    persistItem('floatingRect', JSON.stringify(validated));
    notify();
  },

  setAlwaysOnTop(val: boolean): void {
    currentState = {
      ...currentState,
      alwaysOnTop: val,
    };
    notify();
  },

  clearEvents(): void {
    currentState = {
      ...currentState,
      events: [],
      unreadWarnCount: 0,
      unreadErrorCount: 0,
    };
    notify();
    void apiClearDebugEvents().catch(() => {});
  },

  handleBatch(batch: DebugEventBatchDto): void {
    let nextEvents = currentState.events;
    let nextWarns = currentState.unreadWarnCount;
    let nextErrors = currentState.unreadErrorCount;
    const isPanelVisible = currentState.dockOpen || currentState.detachedOpen;

    if (batch.kind === 'cleared') {
      nextEvents = [];
      nextWarns = 0;
      nextErrors = 0;
    } else if (batch.kind === 'snapshot') {
      nextEvents = batch.events.slice(-MAX_DEBUG_EVENTS);
    } else if (batch.kind === 'append' && batch.events.length > 0) {
      // Coalescing in-place or appending
      const mapBySeq = new Map<number, number>();
      for (let i = 0; i < currentState.events.length; i++) {
        mapBySeq.set(currentState.events[i].seq, i);
      }

      const merged = [...currentState.events];
      for (const ev of batch.events) {
        const existingIdx = mapBySeq.get(ev.seq);
        if (existingIdx !== undefined) {
          merged[existingIdx] = ev;
        } else {
          merged.push(ev);
          mapBySeq.set(ev.seq, merged.length - 1);
          if (!isPanelVisible) {
            if (ev.severity === 'warn') {
              nextWarns += 1;
            } else if (ev.severity === 'error' || ev.severity === 'safety') {
              nextErrors += 1;
            }
          }
        }
      }

      if (merged.length > MAX_DEBUG_EVENTS) {
        nextEvents = merged.slice(-MAX_DEBUG_EVENTS);
      } else {
        nextEvents = merged;
      }
    }

    const nextWinState: DebugWindowStateDto = batch.windowState ?? {
      detachedOpen: currentState.detachedOpen,
      alwaysOnTop: currentState.alwaysOnTop,
      reDockRequested: false,
      sessionLogPath: currentState.sessionLogPath,
    };

    let nextDockOpen = currentState.dockOpen;
    if (
      batch.kind === 'windowState' &&
      nextWinState.reDockRequested &&
      !nextWinState.detachedOpen
    ) {
      nextDockOpen = true;
      persistItem('dockOpen', 'true');
    }

    currentState = {
      ...currentState,
      events: nextEvents,
      detachedOpen: nextWinState.detachedOpen,
      alwaysOnTop: nextWinState.alwaysOnTop,
      sessionLogPath: nextWinState.sessionLogPath ?? currentState.sessionLogPath,
      dockOpen: nextDockOpen,
      unreadWarnCount: isPanelVisible ? 0 : nextWarns,
      unreadErrorCount: isPanelVisible ? 0 : nextErrors,
    };
    notify();
  },
};

export function useDebugConsoleStore(): DebugConsoleState {
  return useSyncExternalStore(
    debugConsoleStore.subscribe,
    debugConsoleStore.getState,
    debugConsoleStore.getState,
  );
}

/** Fire-and-forget UI action logger avoiding double-logging backend-handled actions. */
export function logUiDebugEvent(input: AppendDebugEventInputDto): void {
  void apiAppendDebugEvent({
    ...input,
    source: input.source ?? 'ui',
  }).catch(() => {});
}

// Global subscription bootstrap with reference-counted cleanup for React StrictMode / HMR
let activeSubscriberCount = 0;
let activeUnsub: (() => void) | null = null;

export function initDebugConsoleSubscription(): () => void {
  activeSubscriberCount += 1;
  if (activeSubscriberCount === 1 || activeUnsub === null) {
    activeUnsub = subscribeDebugEvents((batch) => {
      debugConsoleStore.handleBatch(batch);
    });
  }

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    activeSubscriberCount = Math.max(0, activeSubscriberCount - 1);
    if (activeSubscriberCount === 0) {
      activeUnsub?.();
      activeUnsub = null;
    }
  };
}
