/**
 * RE Value Scan store (re-toolkit-v1 §8.4). Two layers:
 *  - pure UI state machine (`ReScanUiState`, `reScanReducer`, `hotkeyNextOp`, `canUndo`): no DOM, no storage;
 *  - `createReScanStore(api, logger)`: injectable store (form, paging, sort, results, 2 Hz visible-row refresh).
 * Importing this module never touches DOM / localStorage / Tauri; the app singleton lives in `reScanStoreDefault.ts`.
 */
import { buildFirstSpec, buildNextOp, defaultScanForm, RE_SCAN_MAX_RESULTS, scanCandidateKey, type ReScanForm } from '../components/re/reScanModel';
import { NOOP_RE_LOGGER, type ReLogger } from './reDebugLog';
import type {
  ReScanFirstSpec,
  ReScanNextOp,
  ReScanResultRowDto,
  ReScanResultsDto,
  ReScanSort,
  ReScanStatusDto,
} from '../types/reScan';

// ---- pure UI state machine ------------------------------------------------------------------------------------

export interface ReScanUiState {
  status: ReScanStatusDto | null;
  lastOp: ReScanNextOp | null;
  busy: boolean;
  error: string | null;
}

export function initialReScanUiState(): ReScanUiState {
  return { status: null, lastOp: null, busy: false, error: null };
}

export type ReScanUiAction =
  | { type: 'begin' }
  | { type: 'firstDone'; status: ReScanStatusDto }
  | { type: 'nextDone'; status: ReScanStatusDto; op: ReScanNextOp }
  | { type: 'undoDone'; status: ReScanStatusDto }
  | { type: 'resetDone'; status: ReScanStatusDto }
  | { type: 'failed'; message: string };

export function reScanReducer(s: ReScanUiState, a: ReScanUiAction): ReScanUiState {
  switch (a.type) {
    case 'begin':
      return { ...s, busy: true, error: null };
    case 'firstDone':
    case 'undoDone':
    case 'resetDone':
      return { ...s, status: a.status, busy: false, error: null };
    case 'nextDone':
      return { status: a.status, lastOp: a.op, busy: false, error: null };
    case 'failed':
      return { ...s, busy: false, error: a.message };
  }
}

/** Enter = Next Scan with the last op: only while a scan is active and nothing is running. */
export function hotkeyNextOp(s: ReScanUiState): ReScanNextOp | null {
  return s.status?.active === true && !s.busy ? s.lastOp : null;
}

export function canUndo(s: ReScanUiState): boolean {
  return s.status !== null && s.status.active && s.status.undoDepth > 0 && !s.busy;
}

// ---- store ----------------------------------------------------------------------------------------------------

export interface ReScanApi {
  first(spec: ReScanFirstSpec): Promise<ReScanStatusDto>;
  next(op: ReScanNextOp): Promise<ReScanStatusDto>;
  undo(): Promise<ReScanStatusDto>;
  reset(): Promise<ReScanStatusDto>;
  status(): Promise<ReScanStatusDto>;
  results(offset: number, limit: number, sort: ReScanSort): Promise<ReScanResultsDto>;
}

export const RE_SCAN_DEFAULT_PAGE_SIZE = 100;

export interface ReScanStoreState {
  ui: ReScanUiState;
  form: ReScanForm;
  offset: number;
  limit: number;
  sort: ReScanSort;
  results: ReScanResultsDto | null;
  /** last results / refresh failure (separate from `ui.error`, which belongs to scan operations) */
  resultsError: string | null;
}

export interface ReScanStore {
  getState(): ReScanStoreState;
  subscribe(l: () => void): () => void;
  setForm(patch: Partial<ReScanForm>): void;
  first(knownBuses: readonly number[]): Promise<void>;
  /** Next Scan with the form's op. */
  next(): Promise<void>;
  /** Next Scan with an explicit op (hotkey repeat, tests). */
  nextWith(op: ReScanNextOp): Promise<void>;
  /** Enter hotkey: repeats the last op (no-op when `hotkeyNextOp` is null). */
  repeatLast(): Promise<void>;
  undo(): Promise<void>;
  reset(): Promise<void>;
  refreshStatus(): Promise<void>;
  setSort(sort: ReScanSort): Promise<void>;
  setLimit(limit: number): Promise<void>;
  setOffset(offset: number): Promise<void>;
  reloadResults(): Promise<void>;
  /** Live refresh of rows `[first, first + count)` of the current page (2 Hz, visible rows only). */
  refreshVisible(first: number, count: number): Promise<void>;
  /** RE analyzer reset / source switch: drop everything of the old scan (form stays). */
  invalidate(): void;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(RE_SCAN_MAX_RESULTS, Math.round(Number.isFinite(limit) ? limit : RE_SCAN_DEFAULT_PAGE_SIZE)));
}

export function createReScanStore(api: ReScanApi, logger: ReLogger = NOOP_RE_LOGGER): ReScanStore {
  let state: ReScanStoreState = {
    ui: initialReScanUiState(),
    form: defaultScanForm(),
    offset: 0,
    limit: RE_SCAN_DEFAULT_PAGE_SIZE,
    sort: 'id',
    results: null,
    resultsError: null,
  };
  const listeners = new Set<() => void>();
  let resultsSeq = 0;
  let visibleInFlight = false;

  const set = (patch: Partial<ReScanStoreState>): void => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };
  const dispatch = (a: ReScanUiAction): void => set({ ui: reScanReducer(state.ui, a) });

  const loadPage = async (offset: number): Promise<void> => {
    if (state.ui.status?.active !== true) {
      resultsSeq += 1;
      set({ results: null, offset: 0, resultsError: null });
      return;
    }
    const mine = ++resultsSeq;
    try {
      const res = await api.results(offset, state.limit, state.sort);
      if (mine !== resultsSeq) return;
      set({ results: res, offset: res.offset, resultsError: null });
    } catch (e) {
      if (mine !== resultsSeq) return;
      set({ resultsError: msg(e) });
      logger.error('re.scan_results', 'RE scan results failed', e, `offset=${offset} limit=${state.limit} sort=${state.sort}`);
    }
  };

  /** begin -> call -> done/failed; on success the first results page is (re)loaded. */
  const run = async (
    title: string,
    action: 're.scan_first' | 're.scan_next' | 're.scan_undo' | 're.scan_reset',
    call: () => Promise<ReScanStatusDto>,
    done: (status: ReScanStatusDto) => ReScanUiAction,
    ctx: string,
  ): Promise<void> => {
    if (state.ui.busy) return;
    dispatch({ type: 'begin' });
    let status: ReScanStatusDto;
    try {
      status = await call();
    } catch (e) {
      dispatch({ type: 'failed', message: msg(e) });
      logger.error(action, title, e, ctx);
      return;
    }
    dispatch(done(status));
    await loadPage(0);
  };

  const store: ReScanStore = {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    setForm(patch) {
      set({ form: { ...state.form, ...patch } });
    },

    first(knownBuses) {
      const spec = buildFirstSpec(state.form, knownBuses);
      return run('RE first scan failed', 're.scan_first', () => api.first(spec), (status) => ({ type: 'firstDone', status }), `kind=${spec.kind}`);
    },
    next() {
      return store.nextWith(buildNextOp(state.form));
    },
    nextWith(op) {
      return run('RE next scan failed', 're.scan_next', () => api.next(op), (status) => ({ type: 'nextDone', status, op }), `op=${op.op}`);
    },
    repeatLast() {
      const op = hotkeyNextOp(state.ui);
      return op === null ? Promise.resolve() : store.nextWith(op);
    },
    undo() {
      if (!canUndo(state.ui)) return Promise.resolve();
      return run('RE scan undo failed', 're.scan_undo', () => api.undo(), (status) => ({ type: 'undoDone', status }), '');
    },
    reset() {
      return run('RE scan reset failed', 're.scan_reset', () => api.reset(), (status) => ({ type: 'resetDone', status }), '');
    },

    async refreshStatus() {
      try {
        const status = await api.status();
        set({ ui: { ...state.ui, status } });
        if (state.results !== null && (!status.active || state.results.scanId !== status.scanId || state.results.step !== status.step)) {
          await loadPage(state.offset);
        }
      } catch (e) {
        set({ resultsError: msg(e) });
        logger.error('re.scan_status', 'RE scan status failed', e);
      }
    },

    async setSort(sort) {
      if (sort === state.sort) return;
      set({ sort, offset: 0 });
      await loadPage(0);
    },
    async setLimit(limit) {
      const next = clampLimit(limit);
      if (next === state.limit) return;
      set({ limit: next, offset: 0 });
      await loadPage(0);
    },
    async setOffset(offset) {
      await loadPage(Math.max(0, Math.round(offset)));
    },
    reloadResults: () => loadPage(state.offset),

    async refreshVisible(first, count) {
      const cur = state.results;
      if (cur === null || visibleInFlight || state.ui.status?.active !== true || count <= 0) return;
      visibleInFlight = true;
      const seqAtStart = resultsSeq;
      try {
        const n = Math.min(RE_SCAN_MAX_RESULTS, count);
        const res = await api.results(cur.offset + first, n, state.sort);
        const now = state.results;
        if (now === null || seqAtStart !== resultsSeq || now.scanId !== res.scanId || now.step !== res.step) return;
        const byKey = new Map<string, ReScanResultRowDto>();
        for (const r of res.rows) byKey.set(scanCandidateKey(r.candidate), r);
        const rows = now.rows.map((r) => byKey.get(scanCandidateKey(r.candidate)) ?? r);
        set({ results: { ...now, rows, total: res.total, candidates: res.candidates }, resultsError: null });
      } catch (e) {
        set({ resultsError: msg(e) });
        logger.error('re.scan_results', 'RE scan live refresh failed', e, `first=${first} count=${count}`);
        if (msg(e).includes('[re:no_scan]')) void store.refreshStatus(); // analyzer reset invalidated the scan
      } finally {
        visibleInFlight = false;
      }
    },

    invalidate() {
      resultsSeq += 1;
      set({ ui: { ...initialReScanUiState(), lastOp: state.ui.lastOp }, results: null, offset: 0, resultsError: null });
    },
  };
  return store;
}
