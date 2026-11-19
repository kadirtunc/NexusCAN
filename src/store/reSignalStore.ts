/**
 * RE Signal Inspector store (re-toolkit-v1 R2a, in-memory only; persistence arrives with R2b). Holds the focused
 * target, up to 4 colour-coded candidates + 1 reference, the decoded series cache and the correlation state.
 * Series are polled at 5 Hz ONLY while the inspector is visible AND "follow live" is on; every response carries a
 * request sequence id so a slow/stale answer can never overwrite a newer one (nor survive a target change).
 */
import { useSyncExternalStore } from 'react';
import * as client from '../services/reClient';
import { reStore } from './reStore';
import { fmtReBits, fmtReTarget, fmtReWindow, NOOP_RE_LOGGER, reDebugLogger, type ReLogger } from './reDebugLog';
import {
  alignedView,
  alignedWindow,
  candidateFromField,
  parseReError,
  seriesStartUs,
  RE_MAX_CANDIDATES,
  sameCandidateBits,
} from '../components/re/reSignalModel';
import type {
  ReCandidateDto,
  ReCorrelateRequest,
  ReCorrelationResultDto,
  ReCorrelationRowDto,
  ReFocusStatusDto,
  ReReferenceDto,
  ReSearchDto,
  ReSeries,
  ReSeriesRequest,
  ReTargetDto,
} from '../types/re';

export const RE_SERIES_POLL_MS = 200; // 5 Hz
export const RE_SERIES_MAX_POINTS = 1024;
export const RE_DEFAULT_SPAN_US = 30_000_000;
export const RE_MIN_SPAN_US = 200_000;
export const RE_MAX_SPAN_US = 600_000_000;

export interface ReCandidateEntry {
  id: number;
  /** colour slot 0..3 (stable while the entry lives); the colour itself comes from the live theme (`candidateColors`) */
  slot: number;
  unit: string;
  /** preview entries come from "Plot" in the correlation table and are replaced by the next preview */
  preview: boolean;
  dto: ReCandidateDto;
}

export type ReCorrelationStatus = 'idle' | 'running' | 'done' | 'error';

export interface ReCorrelationState {
  status: ReCorrelationStatus;
  result: ReCorrelationResultDto | null;
  errorCode: string | null;
  error: string | null;
}

export interface ReSignalState {
  demo: boolean;
  target: ReTargetDto | null;
  candidates: ReCandidateEntry[];
  activeId: number | null;
  reference: ReReferenceDto | null;
  referenceLabel: string;
  series: ReSeries | null;
  /** id of the request whose answer is in `series` */
  seriesSeq: number;
  seriesError: string | null;
  seriesErrorCode: string | null;
  followLive: boolean;
  spanUs: number;
  /** plot time origin: RE capture start, else the first sample seen for this target (null until data arrives) */
  originUs: number | null;
  /** absolute view window used when `followLive` is off */
  view: { t0Us: number; t1Us: number } | null;
  visible: boolean;
  correlation: ReCorrelationState;
  notice: string | null;
}

export interface ReSignalApi {
  readonly demo: boolean;
  focusSet(targets: ReTargetDto[]): Promise<ReFocusStatusDto>;
  series(req: ReSeriesRequest): Promise<ReSeries>;
  correlate(req: ReCorrelateRequest): Promise<ReCorrelationResultDto>;
  /** latest bus/frame time in µs on the series clock (0 = unknown) */
  nowUs(): number;
  /** RE capture start (µs, series clock) = plot time origin; null when unknown (first sample is used then) */
  originUs(): number | null;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
}

export const defaultReSignalApi: ReSignalApi = {
  get demo(): boolean {
    return client.getReSource() === 'demo';
  },
  focusSet: client.reFocusSet,
  series: client.reSeries,
  correlate: client.reCorrelate,
  nowUs: () => reStore.getState().lastTsUs,
  originUs: () => reStore.getState().status?.startedAtUs ?? null,
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (id) => window.clearInterval(id),
};

export function targetKey(t: ReTargetDto | null): string {
  return t === null ? '' : `${t.bus}:${t.isExtended ? 'x' : 's'}:${t.arbId}`;
}

const IDLE_CORRELATION: ReCorrelationState = { status: 'idle', result: null, errorCode: null, error: null };

export interface ReSignalStore {
  getState(): ReSignalState;
  subscribe(l: () => void): () => void;
  setTarget(t: ReTargetDto | null): Promise<void>;
  addCandidate(dto: ReCandidateDto, opts?: { unit?: string; preview?: boolean }): number | null;
  addCandidateFromField(f: Pick<ReCandidateDto, 'startBit' | 'bitLength' | 'byteOrder'>): number | null;
  updateCandidate(id: number, patch: Partial<ReCandidateDto>): void;
  setCandidateUnit(id: number, unit: string): void;
  removeCandidate(id: number): void;
  setActive(id: number | null): void;
  setReference(ref: ReReferenceDto | null, label?: string): void;
  setVisible(v: boolean): void;
  setFollow(v: boolean): void;
  setSpan(us: number): void;
  setView(t0Us: number, t1Us: number): void;
  refresh(): Promise<void>;
  runCorrelation(search: ReSearchDto, topN: number): Promise<void>;
  plotRow(row: ReCorrelationRowDto): void;
  useRowAsCandidate(row: ReCorrelationRowDto): number | null;
  clearNotice(): void;
  /** Source (live/demo) switched: drop target/candidates/reference/series/correlation and stop polling. */
  resetForSource(): void;
}

export function createReSignalStore(api: ReSignalApi, logger: ReLogger = NOOP_RE_LOGGER): ReSignalStore {
  const listeners = new Set<() => void>();
  let nextId = 1;
  let seriesReq = 0;
  let corrReq = 0;
  let inFlight = false;
  let pending = false;
  let timer: number | null = null;

  let state: ReSignalState = {
    demo: api.demo,
    target: null,
    candidates: [],
    activeId: null,
    reference: null,
    referenceLabel: '',
    series: null,
    seriesSeq: 0,
    seriesError: null,
    seriesErrorCode: null,
    followLive: true,
    spanUs: RE_DEFAULT_SPAN_US,
    originUs: null,
    view: null,
    visible: false,
    correlation: IDLE_CORRELATION,
    notice: null,
  };

  const set = (patch: Partial<ReSignalState>): void => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };

  const hasWork = (): boolean => state.target !== null && (state.candidates.length > 0 || state.reference !== null);
  const shouldPoll = (): boolean => state.visible && state.followLive && hasWork();

  const syncPolling = (): void => {
    if (shouldPoll()) {
      if (timer === null) {
        timer = api.setInterval(() => {
          if (!shouldPoll()) {
            syncPolling();
            return;
          }
          if (!inFlight) void store.refresh();
        }, RE_SERIES_POLL_MS);
      }
    } else if (timer !== null) {
      api.clearInterval(timer);
      timer = null;
    }
  };

  const windowArgs = (): { fromUs: number | null; toUs: number | null } => {
    if (state.followLive) {
      const now = api.nowUs();
      if (now <= 0) return { fromUs: null, toUs: null };
      const w = alignedWindow(now, state.spanUs, RE_SERIES_MAX_POINTS, api.originUs() ?? state.originUs);
      return { fromUs: w.fromUs, toUs: w.toUs };
    }
    if (state.view === null) return { fromUs: null, toUs: null };
    const v = alignedView(state.view.t0Us, state.view.t1Us, RE_SERIES_MAX_POINTS);
    return { fromUs: v.fromUs, toUs: v.toUs };
  };

  /** Coalesces bursts (pan/zoom drags, typing): at most one request in flight, one trailing refresh. */
  const requestRefresh = (): void => {
    if (inFlight) pending = true;
    else void store.refresh();
  };

  /** state changed in a way that needs fresh data: restart polling bookkeeping and fetch once (when visible). */
  const changed = (patch: Partial<ReSignalState>): void => {
    set(patch);
    syncPolling();
    if (state.visible && hasWork()) requestRefresh();
    else if (!hasWork()) set({ series: null });
  };

  const store: ReSignalStore = {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },

    async setTarget(t) {
      if (targetKey(t) === targetKey(state.target)) return;
      seriesReq += 1;
      corrReq += 1;
      inFlight = false;
      pending = false;
      set({
        target: t,
        candidates: [],
        activeId: null,
        reference: null,
        referenceLabel: '',
        series: null,
        seriesError: null,
        seriesErrorCode: null,
        originUs: null,
        view: null,
        correlation: IDLE_CORRELATION,
        notice: null,
      });
      syncPolling();
      if (t === null) return;
      try {
        await api.focusSet([t]);
      } catch (e) {
        const p = parseReError(e);
        set({ seriesError: p.message, seriesErrorCode: p.code });
        logger.error('re.focus_set', 'RE focus set failed', e, fmtReTarget(t));
      }
    },

    resetForSource() {
      seriesReq += 1;
      corrReq += 1;
      inFlight = false;
      pending = false;
      set({
        demo: api.demo,
        target: null,
        candidates: [],
        activeId: null,
        reference: null,
        referenceLabel: '',
        series: null,
        seriesSeq: 0,
        seriesError: null,
        seriesErrorCode: null,
        originUs: null,
        view: null,
        correlation: IDLE_CORRELATION,
        notice: null,
      });
      syncPolling();
    },

    addCandidate(dto, opts) {
      let list = state.candidates;
      if (opts?.preview === true) list = list.filter((c) => !c.preview);
      else if (list.length >= RE_MAX_CANDIDATES) list = list.filter((c) => !c.preview); // a preview never blocks an explicit add
      const used = new Set(list.map((c) => c.slot));
      let slot: number | null = null;
      for (let s = 0; s < RE_MAX_CANDIDATES; s += 1) {
        if (!used.has(s)) {
          slot = s;
          break;
        }
      }
      if (slot === null) {
        set({ notice: 'max' });
        return null;
      }
      const entry: ReCandidateEntry = {
        id: nextId,
        slot,
        unit: opts?.unit ?? '',
        preview: opts?.preview === true,
        dto: { ...dto },
      };
      nextId += 1;
      const candidates = [...list, entry].sort((a, b) => a.slot - b.slot);
      changed({ candidates, activeId: entry.id, notice: null });
      return entry.id;
    },

    addCandidateFromField(f) {
      return store.addCandidate(candidateFromField(f));
    },

    updateCandidate(id, patch) {
      const candidates = state.candidates.map((c) => (c.id === id ? { ...c, preview: false, dto: { ...c.dto, ...patch } } : c));
      changed({ candidates });
    },

    setCandidateUnit(id, unit) {
      set({ candidates: state.candidates.map((c) => (c.id === id ? { ...c, unit } : c)) });
    },

    removeCandidate(id) {
      const candidates = state.candidates.filter((c) => c.id !== id);
      const activeId = state.activeId === id ? (candidates[0]?.id ?? null) : state.activeId;
      changed({ candidates, activeId, notice: null });
    },

    setActive(id) {
      set({ activeId: id });
    },

    setReference(ref, label) {
      changed({ reference: ref, referenceLabel: ref === null ? '' : (label ?? ''), seriesError: null, seriesErrorCode: null });
    },

    setVisible(v) {
      if (state.visible === v) return;
      set({ visible: v });
      syncPolling();
      if (v && hasWork()) requestRefresh();
    },

    setFollow(v) {
      if (state.followLive === v) return;
      let view = state.view;
      if (!v && view === null && state.series !== null) {
        // freeze exactly what is on screen now
        let end = state.series.fromUs;
        for (const s of state.series.series) {
          const n = s.points.tUsRel.length;
          if (n > 0) end = Math.max(end, state.series.fromUs + s.points.tUsRel[n - 1]);
        }
        view = { t0Us: Math.max(0, end - state.spanUs), t1Us: end };
      }
      changed({ followLive: v, view });
    },

    setSpan(us) {
      const spanUs = Math.max(RE_MIN_SPAN_US, Math.min(RE_MAX_SPAN_US, Math.round(us)));
      if (state.followLive || state.view === null) {
        changed({ spanUs });
      } else {
        const mid = (state.view.t0Us + state.view.t1Us) / 2;
        changed({ spanUs, view: { t0Us: Math.max(0, mid - spanUs / 2), t1Us: mid + spanUs / 2 } });
      }
    },

    setView(t0Us, t1Us) {
      const span = Math.max(RE_MIN_SPAN_US, Math.min(RE_MAX_SPAN_US, t1Us - t0Us));
      const a = Math.max(0, t0Us);
      changed({ followLive: false, view: { t0Us: a, t1Us: a + span }, spanUs: span });
    },

    async refresh() {
      const target = state.target;
      if (target === null || !hasWork()) return;
      seriesReq += 1;
      const mine = seriesReq;
      const { fromUs, toUs } = windowArgs();
      const req: ReSeriesRequest = {
        target,
        candidates: state.candidates.map((c) => c.dto),
        reference: state.reference,
        fromUs,
        toUs,
        maxPoints: RE_SERIES_MAX_POINTS,
      };
      inFlight = true;
      try {
        const s = await api.series(req);
        if (mine !== seriesReq) return; // stale: a newer request (or a target change) superseded this one
        const first = seriesStartUs(s);
        const originUs = api.originUs() ?? (state.originUs === null ? first : first === null ? state.originUs : Math.min(state.originUs, first));
        set({ series: s, seriesSeq: mine, seriesError: null, seriesErrorCode: null, originUs });
      } catch (e) {
        if (mine !== seriesReq) return;
        const p = parseReError(e);
        set({ seriesError: p.message, seriesErrorCode: p.code });
        logger.error(
          're.series',
          'RE series request failed',
          e,
          `${fmtReTarget(target)} candidates=[${req.candidates.map(fmtReBits).join('; ')}] ${fmtReWindow(fromUs, toUs, req.maxPoints)}`,
        );
      } finally {
        if (mine === seriesReq) {
          inFlight = false;
          if (pending) {
            pending = false;
            void store.refresh();
          }
        }
      }
    },

    async runCorrelation(search, topN) {
      const target = state.target;
      const reference = state.reference;
      if (target === null) return;
      if (reference === null) {
        set({ correlation: { status: 'error', result: null, errorCode: 'no_reference', error: 'no reference selected' } });
        logger.error('re.correlate', 'RE correlation failed', '[re:no_reference] no reference selected', fmtReTarget(target));
        return;
      }
      corrReq += 1;
      const mine = corrReq;
      set({ correlation: { status: 'running', result: state.correlation.result, errorCode: null, error: null } });
      const w = windowArgs();
      const creq: ReCorrelateRequest = {
        target,
        reference,
        fromUs: state.followLive ? null : w.fromUs,
        toUs: state.followLive ? null : w.toUs,
        search,
        topN: Math.max(1, Math.min(50, Math.round(topN))),
      };
      try {
        const result = await api.correlate(creq);
        if (mine !== corrReq) return;
        set({ correlation: { status: 'done', result, errorCode: null, error: null } });
      } catch (e) {
        if (mine !== corrReq) return;
        const p = parseReError(e);
        set({ correlation: { status: 'error', result: null, errorCode: p.code, error: p.message } });
        logger.error(
          're.correlate',
          'RE correlation failed',
          e,
          `${fmtReTarget(target)} search=bits[${search.bitFrom}..${search.bitTo}] len[${search.lengths[0]}..${search.lengths[1]}] topN=${creq.topN} ${fmtReWindow(creq.fromUs, creq.toUs)}`,
        );
      }
    },

    plotRow(row) {
      void store.addCandidate(row.candidate, { preview: true });
    },

    useRowAsCandidate(row) {
      const existing = state.candidates.find((c) => c.preview && sameCandidateBits(c.dto, row.candidate));
      if (existing !== undefined) {
        changed({
          candidates: state.candidates.map((c) => (c.id === existing.id ? { ...c, preview: false, dto: { ...row.candidate } } : c)),
          activeId: existing.id,
        });
        return existing.id;
      }
      return store.addCandidate(row.candidate);
    },

    clearNotice() {
      set({ notice: null });
    },
  };
  return store;
}

export const reSignalStore: ReSignalStore = createReSignalStore(defaultReSignalApi, reDebugLogger);
reStore.onSourceChange(() => reSignalStore.resetForSource());

export function useReSignalState(): ReSignalState {
  return useSyncExternalStore(reSignalStore.subscribe, reSignalStore.getState, reSignalStore.getState);
}
