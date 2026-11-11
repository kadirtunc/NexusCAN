/** Persisted Traffic Dock preferences (localStorage, every access wrapped in try/catch). */
import { DIAG_ORIGINS, type DiagOrigin } from '../../../types/udsClient';
import { DEFAULT_FILTERS, type TrafficFilters } from './trafficFilters';
import type { TrafficOrder, TrafficViewMode } from './trafficModel';

export type DockState = 'pinned' | 'collapsed' | 'maximized';

export interface TrafficPrefs {
  dock: DockState;
  height: number;
  view: TrafficViewMode;
  order: TrafficOrder;
  detailOpen: boolean;
  filters: TrafficFilters;
}

export const DOCK_MIN_HEIGHT = 120;
export const DOCK_MAX_FRACTION = 0.7;

export const DEFAULT_PREFS: TrafficPrefs = {
  dock: 'pinned',
  height: 260,
  view: 'transactions',
  order: 'newestFirst',
  detailOpen: true,
  filters: DEFAULT_FILTERS,
};

const KEY = 'nexuscan.diag.trafficDock.v1';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function loadPrefs(): TrafficPrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return DEFAULT_PREFS;
    const f = isRecord(parsed.filters) ? parsed.filters : {};
    const origins: DiagOrigin[] = Array.isArray(f.origins)
      ? DIAG_ORIGINS.filter((o) => (f.origins as unknown[]).includes(o))
      : [...DIAG_ORIGINS];
    return {
      dock: parsed.dock === 'collapsed' || parsed.dock === 'maximized' ? parsed.dock : 'pinned',
      height: typeof parsed.height === 'number' && Number.isFinite(parsed.height)
        ? Math.max(DOCK_MIN_HEIGHT, parsed.height)
        : DEFAULT_PREFS.height,
      view: parsed.view === 'interleaved' || parsed.view === 'frames' ? parsed.view : 'transactions',
      order: parsed.order === 'oldestFirst' ? 'oldestFirst' : 'newestFirst',
      detailOpen: parsed.detailOpen !== false,
      filters: {
        origins,
        errorsOnly: f.errorsOnly === true,
        sid: typeof f.sid === 'string' ? f.sid.slice(0, 4) : '',
        search: typeof f.search === 'string' ? f.search.slice(0, 120) : '',
      },
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: TrafficPrefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable / quota: preferences are best-effort */
  }
}
