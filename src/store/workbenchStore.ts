import { useSyncExternalStore } from 'react';
import type { ActiveDocumentTab } from '../utils/workspaceDb';

export type ExplorerSelection =
  | { kind: 'project' }
  | { kind: 'connection'; profileId: string }
  | { kind: 'database'; databaseId: string }
  | { kind: 'trace'; sessionId: string }
  | { kind: 'panel'; panelId: string }
  | { kind: 'signal'; busId: number; signalId: number };

export type RightBottomTab = 'watch' | 'cloud';
export type DockPosition = 'right' | 'left';

export interface WatchSignalItem {
  key: string; // `${busId}:${signalId}`
  busId: number;
  signalId: number;
  name: string;
  unit: string;
  min: number;
  max: number;
}

export interface WorkbenchState {
  dockOpen: boolean;
  dockPosition: DockPosition;
  dockWidthPx: number;
  selection: ExplorerSelection;
  bottomTab: RightBottomTab;
  splitSecondaryTab: ActiveDocumentTab | null;
  splitSecondaryTraceId: string | null;
  splitLeftRatioPct: number;
  bottomConnectionsCollapsed: boolean;
  watchSignals: readonly WatchSignalItem[];
  newConnectionModalOpen: boolean;
}

const STORAGE_KEY = 'nexuscan:workbenchLayout:v1';

interface PersistedWorkbenchLayout {
  dockOpen?: boolean;
  dockPosition?: DockPosition;
  dockWidthPx?: number;
  bottomTab?: RightBottomTab;
  splitSecondaryTab?: ActiveDocumentTab | null;
  splitLeftRatioPct?: number;
  bottomConnectionsCollapsed?: boolean;
  watchSignals?: WatchSignalItem[];
}

function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, val));
}

function loadInitialState(): WorkbenchState {
  const defaults: WorkbenchState = {
    dockOpen: typeof window !== 'undefined' ? window.innerWidth >= 1100 : true,
    dockPosition: 'right',
    dockWidthPx: 328,
    selection: { kind: 'project' },
    bottomTab: 'watch',
    splitSecondaryTab: null,
    splitSecondaryTraceId: null,
    splitLeftRatioPct: 56,
    bottomConnectionsCollapsed: false,
    watchSignals: [],
    newConnectionModalOpen: false,
  };

  if (typeof window === 'undefined') return defaults;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as PersistedWorkbenchLayout;
    return {
      ...defaults,
      dockOpen: typeof parsed.dockOpen === 'boolean' ? parsed.dockOpen : defaults.dockOpen,
      dockPosition:
        parsed.dockPosition === 'left' || parsed.dockPosition === 'right'
          ? parsed.dockPosition
          : 'right',
      dockWidthPx:
        typeof parsed.dockWidthPx === 'number'
          ? clamp(Math.round(parsed.dockWidthPx), 260, 520)
          : defaults.dockWidthPx,
      bottomTab:
        parsed.bottomTab === 'watch' || parsed.bottomTab === 'cloud'
          ? parsed.bottomTab
          : 'watch',
      splitSecondaryTab: parsed.splitSecondaryTab ?? null,
      splitLeftRatioPct:
        typeof parsed.splitLeftRatioPct === 'number'
          ? clamp(parsed.splitLeftRatioPct, 28, 72)
          : defaults.splitLeftRatioPct,
      bottomConnectionsCollapsed: Boolean(parsed.bottomConnectionsCollapsed),
      watchSignals: Array.isArray(parsed.watchSignals) ? parsed.watchSignals : [],
    };
  } catch {
    return defaults;
  }
}

let state: WorkbenchState = loadInitialState();
const listeners = new Set<() => void>();

function persistLayout(): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: PersistedWorkbenchLayout = {
      dockOpen: state.dockOpen,
      dockPosition: state.dockPosition,
      dockWidthPx: state.dockWidthPx,
      bottomTab: state.bottomTab,
      splitSecondaryTab: state.splitSecondaryTab,
      splitLeftRatioPct: state.splitLeftRatioPct,
      bottomConnectionsCollapsed: state.bottomConnectionsCollapsed,
      watchSignals: [...state.watchSignals],
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage quota errors
  }
}

function setState(next: WorkbenchState, shouldPersist = true): void {
  state = next;
  if (shouldPersist) {
    persistLayout();
  }
  for (const l of listeners) {
    l();
  }
}

export const workbenchStore = {
  getState(): WorkbenchState {
    return state;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  setDockOpen(open: boolean): void {
    setState({ ...state, dockOpen: open });
  },

  toggleDock(): void {
    setState({ ...state, dockOpen: !state.dockOpen });
  },

  setDockPosition(pos: DockPosition): void {
    setState({ ...state, dockPosition: pos });
  },

  toggleDockPosition(): void {
    setState({
      ...state,
      dockPosition: state.dockPosition === 'right' ? 'left' : 'right',
    });
  },

  setDockWidthPx(widthPx: number): void {
    setState({ ...state, dockWidthPx: clamp(Math.round(widthPx), 260, 520) });
  },

  setSelection(selection: ExplorerSelection): void {
    setState({ ...state, selection, dockOpen: true }, false);
  },

  setBottomTab(tab: RightBottomTab): void {
    setState({ ...state, bottomTab: tab });
  },

  setSplitSecondaryTab(
    tab: ActiveDocumentTab | null,
    traceSessionId: string | null = null,
  ): void {
    setState({
      ...state,
      splitSecondaryTab: tab,
      splitSecondaryTraceId: tab === 'trace' ? traceSessionId : null,
    });
  },

  setSplitLeftRatioPct(pct: number): void {
    setState({ ...state, splitLeftRatioPct: clamp(pct, 28, 72) });
  },

  setBottomConnectionsCollapsed(collapsed: boolean): void {
    setState({ ...state, bottomConnectionsCollapsed: collapsed });
  },

  toggleBottomConnectionsCollapsed(): void {
    setState({
      ...state,
      bottomConnectionsCollapsed: !state.bottomConnectionsCollapsed,
    });
  },

  setNewConnectionModalOpen(open: boolean): void {
    setState({ ...state, newConnectionModalOpen: open }, false);
  },

  addWatchSignal(item: WatchSignalItem): void {
    if (state.watchSignals.some((w) => w.key === item.key)) {
      setState({ ...state, bottomTab: 'watch', dockOpen: true });
      return;
    }
    setState({
      ...state,
      watchSignals: [...state.watchSignals, item],
      bottomTab: 'watch',
      dockOpen: true,
    });
  },

  toggleWatchSignal(item: WatchSignalItem): void {
    const exists = state.watchSignals.some((w) => w.key === item.key);
    if (exists) {
      setState({
        ...state,
        watchSignals: state.watchSignals.filter((w) => w.key !== item.key),
      });
    } else {
      setState({
        ...state,
        watchSignals: [...state.watchSignals, item],
        bottomTab: 'watch',
        dockOpen: true,
      });
    }
  },

  removeWatchSignal(key: string): void {
    setState({
      ...state,
      watchSignals: state.watchSignals.filter((w) => w.key !== key),
    });
  },
};

export function useWorkbenchStore(): WorkbenchState {
  return useSyncExternalStore(
    workbenchStore.subscribe,
    workbenchStore.getState,
    workbenchStore.getState,
  );
}
