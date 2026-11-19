/**
 * RE Toolkit store (re-toolkit-v1 R1). 10 Hz snapshots are merged into a keyed row map (dirty snapshots update the
 * rows they carry, a `full` snapshot replaces everything). Row byte arrays are copied out of the snapshot buffer so
 * a stale buffer is never retained. The map itself is mutated in place; subscribers are notified with a new state
 * object whose `rowsVersion` increments, and views derive filtered lists with `selectVisibleRows` (memoised).
 */
import { useSyncExternalStore } from 'react';
import * as client from '../services/reClient';
import { ReCodecError } from '../services/reSnapshotCodec';
import { DEFAULT_RE_DISPLAY, defaultDisplayStorage, loadReDisplay, saveReDisplay, type ReDisplay, type ReDisplayStorage } from './reDisplay';
import { NOOP_RE_LOGGER, reDebugLogger, type ReLogAction, type ReLogger } from './reDebugLog';
import type {
  ReMarkerDto,
  RePhase,
  ReRowKey,
  ReSettablePhase,
  ReSnapshot,
  ReSnapshotRow,
  ReStatusDto,
} from '../types/re';

/** Heat (log-scaled window toggle count) at or above which a bit is treated as noisy by the UI mute filter. */
export const RE_NOISE_HEAT = 200;

export interface ReRowView {
  key: string;
  bus: number;
  extended: boolean;
  fd: boolean;
  hasDiff: boolean;
  dlcBytes: number;
  arbId: number;
  rxCount: number;
  heat: Uint8Array;
  diff: Uint8Array;
  constant: Uint8Array;
  /** latest payload (copied), byte 0 first */
  data: Uint8Array;
  /** payload from the previous update of this row (== data for a new row), for changed-byte highlighting */
  prevData: Uint8Array;
  /** snapshot seq at which this row was last updated */
  updatedSeq: number;
}

export interface ReFilters {
  onlyDiff: boolean;
  muteNoisy: boolean;
  hideConstant: boolean;
  search: string;
  bus: number | null;
}

export interface ReState {
  status: ReStatusDto | null;
  /** true when the client is the synthetic demo backend */
  demo: boolean;
  phase: RePhase;
  rowsVersion: number;
  totalRows: number;
  lastSeq: number;
  lastTsUs: number;
  filters: ReFilters;
  display: ReDisplay;
  selected: ReRowKey | null;
  markers: ReMarkerDto[];
  error: string | null;
  busy: boolean;
}

export function reRowKey(bus: number, extended: boolean, arbId: number): string {
  return `${bus}:${extended ? 'x' : 's'}:${arbId}`;
}

export const DEFAULT_RE_FILTERS: ReFilters = {
  onlyDiff: false,
  muteNoisy: false,
  hideConstant: false,
  search: '',
  bus: null,
};

function bitSet(mask: Uint8Array, bit: number): boolean {
  return ((mask[bit >> 3] >> (bit & 7)) & 1) === 1;
}

export function isNoisyBit(row: ReRowView, bit: number): boolean {
  return row.heat[bit] >= RE_NOISE_HEAT && !bitSet(row.diff, bit);
}

/** Row has no non-constant bit at all. */
export function isAllConstant(row: ReRowView): boolean {
  for (let i = 0; i < row.dlcBytes; i += 1) if (row.constant[i] !== 0xff) return false;
  return true;
}

function allActiveBitsNoisy(row: ReRowView): boolean {
  let any = false;
  for (let bit = 0; bit < row.dlcBytes * 8; bit += 1) {
    if (bitSet(row.constant, bit)) continue;
    any = true;
    if (!isNoisyBit(row, bit)) return false;
  }
  return any;
}

function matchesSearch(row: ReRowView, search: string): boolean {
  const s = search.trim().toLowerCase().replace(/^0x/, '');
  if (s === '') return true;
  return row.arbId.toString(16).includes(s) || row.arbId.toString(10).includes(s);
}

/** Pure filter + stable sort (bus, standard before extended, arbId). */
export function filterRows(rows: Iterable<ReRowView>, f: ReFilters): ReRowView[] {
  const out: ReRowView[] = [];
  for (const r of rows) {
    if (f.bus !== null && r.bus !== f.bus) continue;
    if (!matchesSearch(r, f.search)) continue;
    if (f.onlyDiff && !r.hasDiff) continue;
    if (f.hideConstant && isAllConstant(r)) continue;
    if (f.muteNoisy && !r.hasDiff && allActiveBitsNoisy(r)) continue;
    out.push(r);
  }
  out.sort((a, b) => a.bus - b.bus || Number(a.extended) - Number(b.extended) || a.arbId - b.arbId);
  return out;
}

function toView(r: ReSnapshotRow, seq: number, old: ReRowView | undefined): ReRowView {
  const data = r.data.slice();
  return {
    key: reRowKey(r.bus, r.extended, r.arbId),
    bus: r.bus,
    extended: r.extended,
    fd: r.fd,
    hasDiff: r.hasDiff,
    dlcBytes: r.dlcBytes,
    arbId: r.arbId,
    rxCount: r.rxCount,
    heat: r.heat.slice(),
    diff: r.diff.slice(),
    constant: r.constant.slice(),
    data,
    prevData: old !== undefined && old.data.length === data.length ? old.data : data,
    updatedSeq: seq,
  };
}

export interface ReClientApi {
  /** true when this client is the synthetic demo backend (may change at runtime for the default client) */
  readonly demo: boolean;
  start(buses: number[] | null): Promise<ReStatusDto>;
  stop(): Promise<ReStatusDto>;
  reset(): Promise<ReStatusDto>;
  setPhase(phase: ReSettablePhase): Promise<ReStatusDto>;
  mark(label: string): Promise<ReMarkerDto>;
  markers(): Promise<ReMarkerDto[]>;
  subscribe(onSnapshot: (snap: ReSnapshot) => void, onError?: (err: Error) => void): Promise<() => void>;
}

export const defaultReClient: ReClientApi = {
  get demo(): boolean {
    return client.getReSource() === 'demo';
  },
  start: client.reStart,
  stop: client.reStop,
  reset: client.reReset,
  setPhase: client.reSetPhase,
  mark: client.reMark,
  markers: client.reMarkers,
  subscribe: client.subscribeRe,
};

/** Source switching seam: persisted source + the client for a source (tests inject fakes). */
export interface ReSourceController {
  get(): client.ReSource;
  set(src: client.ReSource): void;
  apiFor(src: client.ReSource): ReClientApi;
}

export const defaultReSourceController: ReSourceController = {
  get: client.getReSource,
  set: client.setReSource,
  apiFor: () => defaultReClient,
};

export interface ReStore {
  getState(): ReState;
  subscribe(l: () => void): () => void;
  getRows(): ReadonlyMap<string, ReRowView>;
  applySnapshot(snap: ReSnapshot): void;
  attach(): Promise<void>;
  detach(): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  reset(): Promise<void>;
  setPhase(phase: ReSettablePhase): Promise<void>;
  mark(label: string): Promise<void>;
  refreshMarkers(): Promise<void>;
  setFilters(patch: Partial<ReFilters>): void;
  setDisplay(patch: Partial<ReDisplay>): void;
  select(key: ReRowKey | null): void;
  /** Switches live/demo: stops the session (best effort), clears rows/markers/selection, re-attaches. */
  setSource(src: client.ReSource): Promise<void>;
  /** Called after every completed source switch (dependent stores reset themselves). */
  onSourceChange(l: () => void): () => void;
}

export function createReStore(
  initialApi: ReClientApi,
  sourceCtl: ReSourceController | null = null,
  logger: ReLogger = NOOP_RE_LOGGER,
  displayStorage: ReDisplayStorage | null = null,
): ReStore {
  let api = initialApi;
  const sourceListeners = new Set<() => void>();
  const rows = new Map<string, ReRowView>();
  const listeners = new Set<() => void>();
  let unsub: (() => void) | null = null;
  let attachCount = 0;
  let attaching: Promise<void> | null = null;

  let state: ReState = {
    status: null,
    demo: api.demo,
    phase: 'idle',
    rowsVersion: 0,
    totalRows: 0,
    lastSeq: 0,
    lastTsUs: 0,
    filters: DEFAULT_RE_FILTERS,
    display: displayStorage === null ? DEFAULT_RE_DISPLAY : loadReDisplay(displayStorage),
    selected: null,
    markers: [],
    error: null,
    busy: false,
  };

  const set = (patch: Partial<ReState>): void => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };

  const fail = (e: unknown, action: ReLogAction, title: string, ctx?: string): void => {
    set({ error: e instanceof Error ? e.message : String(e), busy: false });
    logger.error(action, title, e, ctx);
  };

  const applyStatus = (s: ReStatusDto): void => {
    set({ status: s, phase: s.phase, error: null, busy: false });
  };

  const run = async (action: ReLogAction, title: string, fn: () => Promise<ReStatusDto>, ctx?: string): Promise<void> => {
    set({ busy: true });
    try {
      applyStatus(await fn());
    } catch (e) {
      fail(e, action, title, ctx);
    }
  };

  /** Drops any old subscription (stops local delivery) and subscribes anew; backend replies with a full resync. */
  const subscribeFresh = (): Promise<void> => {
    if (unsub !== null) {
      unsub();
      unsub = null;
    }
    const p = api
      .subscribe(
        (snap) => store.applySnapshot(snap),
        (err) => {
          set({ error: err.message });
          // codec failures are decode errors; everything else reaching onError is a transport (WS/Channel) problem
          if (err instanceof ReCodecError) logger.error('re.snapshot_decode', 'RE snapshot decode failed', err);
          else logger.error('re.ws', 'RE snapshot stream error', err);
        },
      )
      .then((u) => {
        if (attachCount === 0) u();
        else unsub = u;
      })
      .catch((e: unknown) => fail(e, 're.subscribe', 'RE subscribe failed'))
      .finally(() => {
        if (attaching === p) attaching = null;
      });
    attaching = p;
    return p;
  };

  const store: ReStore = {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getRows: () => rows,

    applySnapshot(snap) {
      if (snap.full) rows.clear();
      for (const r of snap.rows) {
        const key = reRowKey(r.bus, r.extended, r.arbId);
        // After a full resync `rows` was cleared: prevData == data for every row (nothing to compare against).
        const v = toView(r, snap.seq, rows.get(key));
        rows.set(v.key, v);
      }
      const status = state.status === null ? null : { ...state.status, phase: snap.phase, rows: snap.totalRows };
      set({
        status,
        phase: snap.phase,
        rowsVersion: state.rowsVersion + 1,
        totalRows: snap.totalRows,
        lastSeq: snap.seq,
        lastTsUs: snap.tsUs,
      });
    },

    async attach() {
      attachCount += 1;
      if (unsub !== null) return;
      if (attaching !== null) return attaching;
      return subscribeFresh();
    },

    detach() {
      attachCount = Math.max(0, attachCount - 1);
      if (attachCount === 0 && unsub !== null) {
        unsub();
        unsub = null;
      }
    },

    async start() {
      logger.info('re.start', 'RE capture start requested', `source=${api.demo ? 'demo' : 'live'}`);
      await run('re.start', 'RE start failed', () => api.start(null), 'buses=all');
      // The backend ends the stream on stop: after a successful start always subscribe fresh.
      if (state.status?.enabled === true && attachCount > 0) {
        if (attaching !== null) await attaching;
        await subscribeFresh();
      }
    },
    async stop() {
      logger.info('re.stop', 'RE capture stop requested');
      await run('re.stop', 'RE stop failed', () => api.stop());
      // Backend sent a final snapshot and closed the subscription; keep delivery until it is replaced on start.
    },
    async reset() {
      logger.info('re.reset', 'RE capture reset requested');
      await run('re.reset', 'RE reset failed', () => api.reset());
      rows.clear();
      set({ rowsVersion: state.rowsVersion + 1, totalRows: 0, markers: [], selected: null });
    },
    setPhase: (phase) => run('re.phase', 'RE set phase failed', () => api.setPhase(phase), `phase=${phase}`),

    async mark(label) {
      try {
        const m = await api.mark(label);
        const markers = [...state.markers, m];
        set({ markers: markers.length > 1024 ? markers.slice(markers.length - 1024) : markers, error: null });
      } catch (e) {
        fail(e, 're.mark', 'RE marker failed', `label=${JSON.stringify(label.slice(0, 64))}`);
      }
    },

    async refreshMarkers() {
      try {
        set({ markers: await api.markers() });
      } catch (e) {
        fail(e, 're.markers', 'RE marker list failed');
      }
    },

    setFilters(patch) {
      set({ filters: { ...state.filters, ...patch } });
    },
    setDisplay(patch) {
      const display = { ...state.display, ...patch };
      saveReDisplay(display, displayStorage);
      set({ display });
    },
    select(key) {
      set({ selected: key });
    },

    async setSource(src) {
      if (sourceCtl === null || src === sourceCtl.get()) return;
      // Stop delivery and the old session (best effort), then swap the client and drop all state of the old source.
      if (unsub !== null) {
        unsub();
        unsub = null;
      }
      attaching = null;
      try {
        await api.stop();
      } catch (e) {
        // backend may be unreachable; irrelevant for the switch, but visible in the Debug console
        logger.error('re.stop', 'RE stop failed during source switch', e, `from=${sourceCtl.get()} to=${src}`);
      }
      logger.info('re.source', `RE source switched to ${src}`, `from=${sourceCtl.get()}`);
      sourceCtl.set(src);
      api = sourceCtl.apiFor(src);
      rows.clear();
      set({
        demo: api.demo,
        status: null,
        phase: 'idle',
        rowsVersion: state.rowsVersion + 1,
        totalRows: 0,
        lastSeq: 0,
        lastTsUs: 0,
        selected: null,
        markers: [],
        error: null,
        busy: false,
      });
      for (const l of sourceListeners) l();
      if (attachCount > 0) await subscribeFresh();
    },
    onSourceChange(l) {
      sourceListeners.add(l);
      return () => {
        sourceListeners.delete(l);
      };
    },
  };
  return store;
}

export const reStore: ReStore = createReStore(defaultReClient, defaultReSourceController, reDebugLogger, defaultDisplayStorage());

export function useReState(): ReState {
  return useSyncExternalStore(reStore.subscribe, reStore.getState, reStore.getState);
}

let memoVersion = -1;
let memoFilters: ReFilters | null = null;
let memoOut: ReRowView[] = [];

/** Filtered rows, memoised on (rowsVersion, filters identity). */
export function selectVisibleRows(s: ReState): ReRowView[] {
  if (memoVersion !== s.rowsVersion || memoFilters !== s.filters) {
    memoOut = filterRows(reStore.getRows().values(), s.filters);
    memoVersion = s.rowsVersion;
    memoFilters = s.filters;
  }
  return memoOut;
}
