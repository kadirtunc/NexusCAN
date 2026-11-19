/**
 * Diagnostics Workbench store (workbench-v1 §9.5). (Named `diagWorkbenchStore` because `workbenchStore.ts`
 * is the project-explorer dock state.) Holds: the library blocks that can be bound, the pinned-revision cache
 * (immutable revisions: cached forever), the latest run record per (ecuId, flowId), the single active run
 * handle, the review-gate request and the one-step undo of "update to latest". Binding CRUD itself lives in
 * `diagWorkspaceStore` (it is part of the project file).
 */
import { useSyncExternalStore } from 'react';
import type { EcuRecordV1, FlowBindingV1, FlowRefV1 } from '../types/diagWorkspace';
import type { FlowFileValue, FlowInterfaceV1 } from '../types/flowLibrary';
import type { RunFileRefV1, RunRecordV1 } from '../types/runRecord';
import { diagWorkspaceStore } from '../components/diagnostics/workspace/diagWorkspaceStore';
import { newId } from '../components/diagnostics/workspace/ecuDefaults';
import { flowRegistry } from '../components/flow/registry/flowRegistryStore';
import { computeContentHash, fromFlowBody } from '../components/flow/registry/flowBody';
import { migrateAll } from '../components/flow/flowMigrate';
import { deriveFlowInterface } from '../components/flow/flowInterface';
import { isCallType, readCallRef, refKey } from '../components/flow/callIndex';
import { RealFlowTransport, type FlowTransport } from '../components/flow/flowTransport';
import type { FlowDiagram } from '../components/flow/types';
import { isBindableInterface, reconcileBindingToRevision, type WbReconcileResult, type WbReviewItem } from '../components/diagnostics/workbench/workbenchModel';
import { startWorkbenchRun, type WbRunDeps, type WbRunHandle, type WbRunResult } from '../components/diagnostics/workbench/workbenchRunner';
import { ipcRunStoreClient, type RunStoreClient } from '../services/runStoreClient';
import { diagnosticsStore } from './diagnosticsStore';
import { projectStore } from './projectStore';
import { t } from '../i18n';

/** App version stamped into run records. */
export const APP_VERSION = '0.1.0';

export interface WbIfaceInfo {
  ref: FlowRefV1;
  name: string;
  body: FlowDiagram;
  iface: FlowInterfaceV1;
  contentHash: string;
}

export interface WbBindableBlock {
  flowId: string;
  name: string;
  latestRevision: number;
}

export interface WbReviewRequest {
  items: WbReviewItem[];
  ecu: EcuRecordV1;
  files: RunFileRefV1[];
}

export interface WbUpdatePlanEntry {
  before: FlowBindingV1;
  result: WbReconcileResult;
}

export interface WbUpdatePlan {
  vehicleId: string;
  flowId: string;
  name: string;
  fromRevision: number;
  toRevision: number;
  entries: WbUpdatePlanEntry[];
}

export interface WbState {
  /** Bumped whenever the revision cache grows (components re-read `getIface`). */
  ifaceVersion: number;
  bindable: WbBindableBlock[];
  /** Latest record per `recordKey(ecuId, flowId)`. */
  records: Record<string, RunRecordV1>;
  active: { bindingId: string; ecuId: string } | null;
  /** Last pre-run refusal message per binding id (cleared by the next run of that binding). */
  refusals: Record<string, string>;
  banner: { tone: 'warn' | 'critical'; message: string } | null;
  review: WbReviewRequest | null;
  undo: { vehicleId: string; bindings: FlowBindingV1[]; count: number } | null;
}

export const recordKey = (ecuId: string | null, flowId: string): string => `${ecuId ?? ''}|${flowId}`;

const DEVICE_KEY = 'nexuscan:deviceId:v1';

function deviceId(): string {
  try {
    const cur = localStorage.getItem(DEVICE_KEY);
    if (cur !== null && cur !== '') return cur;
    const fresh = newId();
    localStorage.setItem(DEVICE_KEY, fresh);
    return fresh;
  } catch {
    return 'unknown-device';
  }
}

let state: WbState = {
  ifaceVersion: 0,
  bindable: [],
  records: {},
  active: null,
  refusals: {},
  banner: null,
  review: null,
  undo: null,
};
const listeners = new Set<() => void>();
const ifaces = new Map<string, WbIfaceInfo>();
const loading = new Map<string, Promise<WbIfaceInfo | null>>();
let client: RunStoreClient = ipcRunStoreClient;
let handle: WbRunHandle | null = null;
let reviewResolve: ((ok: boolean) => void) | null = null;

function set(patch: Partial<WbState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Loads (and caches) one pinned revision + the callees it references, so the runner can read them synchronously. */
async function loadInfo(ref: FlowRefV1): Promise<WbIfaceInfo | null> {
  const key = refKey(ref);
  const hit = ifaces.get(key);
  if (hit) return hit;
  const pending = loading.get(key);
  if (pending) return pending;
  const p = (async (): Promise<WbIfaceInfo | null> => {
    try {
      const { body } = await flowRegistry.loadBody(ref.flowId, ref.revision);
      const diagram = migrateAll(fromFlowBody(body)).diagram;
      const info: WbIfaceInfo = { ref, name: body.name, body: diagram, iface: deriveFlowInterface(diagram), contentHash: await computeContentHash(body) };
      ifaces.set(key, info);
      set({ ifaceVersion: state.ifaceVersion + 1 });
      return info;
    } catch {
      return null;
    } finally {
      loading.delete(key);
    }
  })();
  loading.set(key, p);
  return p;
}

/** Preloads every callee reachable from `diagram` (cycle-safe). */
async function preloadCallees(diagram: FlowDiagram, seen: Set<string>): Promise<void> {
  for (const b of diagram.blocks) {
    if (!isCallType(b.type)) continue;
    const ref = readCallRef(b);
    if (!ref || seen.has(refKey(ref))) continue;
    seen.add(refKey(ref));
    const info = await loadInfo(ref);
    if (info) await preloadCallees(info.body, seen);
  }
}

/** Diagnostics session tab of an ECU that is connected (`null` = none). Demo mode never counts. */
export function connectedTabIdFor(ecuId: string): string | null {
  const st = diagnosticsStore.getState();
  if (st.mockMode) return null;
  return st.tabs.find((tab) => tab.ecuId === ecuId && tab.session.connected)?.id ?? null;
}

export const diagWorkbenchStore = {
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  getState(): WbState {
    return state;
  },

  /** Test seam: replaces the run store client. */
  setClient(c: RunStoreClient): void {
    client = c;
  },

  getIface(ref: FlowRefV1): WbIfaceInfo | undefined {
    return ifaces.get(refKey(ref));
  },
  ensureIface(ref: FlowRefV1): Promise<WbIfaceInfo | null> {
    return loadInfo(ref);
  },

  /** Library blocks (latest revision) whose interface has an `ecu` input. */
  async refreshBindable(): Promise<void> {
    await flowRegistry.init();
    const entries = flowRegistry.getSnapshot().entries.filter((e) => !e.deleted && e.kind === 'nexuscan.flow');
    const infos = await Promise.all(entries.map((e) => loadInfo({ flowId: e.id, revision: e.latestRevision })));
    const bindable: WbBindableBlock[] = [];
    entries.forEach((e, i) => {
      const info = infos[i];
      if (info && isBindableInterface(info.iface)) bindable.push({ flowId: e.id, name: e.name, latestRevision: e.latestRevision });
    });
    set({ bindable });
  },

  /** Latest records of the project (`cmd_run_latest`). */
  async loadLatest(): Promise<void> {
    const projectId = projectStore.getState().projectId;
    if (projectId === null) {
      set({ records: {} });
      return;
    }
    try {
      const list = await client.latest(projectId);
      const records: Record<string, RunRecordV1> = {};
      for (const r of list) records[recordKey(r.ecuId, r.flowId)] = r;
      set({ records });
    } catch (e) {
      set({ banner: { tone: 'warn', message: errText(e) } });
    }
  },

  setBanner(b: WbState['banner']): void {
    set({ banner: b });
  },

  // ── Update to latest ─────────────────────────────────────────────────────────

  /** Reconciles every binding of `flowId` that is pinned below its library latest revision. */
  async planUpdate(vehicleId: string, flowId: string, latestRevision: number): Promise<WbUpdatePlan | null> {
    const veh = diagWorkspaceStore.getState().vehicles.find((v) => v.id === vehicleId);
    const info = await loadInfo({ flowId, revision: latestRevision });
    if (!veh || !info) return null;
    const affected = veh.bindings.filter((b) => b.flowRef.flowId === flowId && b.flowRef.revision < latestRevision);
    if (affected.length === 0) return null;
    return {
      vehicleId,
      flowId,
      name: info.name,
      fromRevision: Math.min(...affected.map((b) => b.flowRef.revision)),
      toRevision: latestRevision,
      entries: affected.map((before) => ({ before, result: reconcileBindingToRevision(before, info.iface, latestRevision) })),
    };
  },

  /** Applies a plan in ONE commit; the previous bindings are kept for a single undo step. */
  applyUpdate(plan: WbUpdatePlan): void {
    const veh = diagWorkspaceStore.getState().vehicles.find((v) => v.id === plan.vehicleId);
    if (!veh) return;
    const next = new Map(plan.entries.map((e) => [e.before.id, e.result.binding] as const));
    const snapshot = veh.bindings.map((b) => ({ ...b }));
    diagWorkspaceStore.replaceBindings(plan.vehicleId, veh.bindings.map((b) => next.get(b.id) ?? b));
    set({ undo: { vehicleId: plan.vehicleId, bindings: snapshot, count: plan.entries.length } });
  },

  undoUpdate(): void {
    const u = state.undo;
    if (!u) return;
    diagWorkspaceStore.replaceBindings(u.vehicleId, u.bindings);
    set({ undo: null });
  },
  clearUndo(): void {
    if (state.undo) set({ undo: null });
  },

  // ── Review gate ──────────────────────────────────────────────────────────────

  answerReview(ok: boolean): void {
    const r = reviewResolve;
    reviewResolve = null;
    set({ review: null });
    r?.(ok);
  },

  // ── Running ──────────────────────────────────────────────────────────────────

  /** Starts one cell run. Resolves with the runner result; exactly one run can be active. */
  async run(binding: FlowBindingV1, ecu: EcuRecordV1, files: Record<string, FlowFileValue>): Promise<WbRunResult> {
    const projectId = projectStore.getState().projectId;
    const fail = (message: string): WbRunResult => {
      set({ refusals: { ...state.refusals, [binding.id]: message } });
      return { kind: 'refused', refusal: { code: 'invalid', message } };
    };
    if (handle !== null) return { kind: 'refused', refusal: { code: 'busy', message: t('workbench.refuse.busy') } };
    if (projectId === null) return fail(t('workbench.refuse.noProject'));
    if (diagnosticsStore.getState().mockMode) return fail(t('workbench.refuse.demo'));
    const refusals = { ...state.refusals };
    delete refusals[binding.id];
    set({ refusals, banner: null, active: { bindingId: binding.id, ecuId: ecu.id } });

    const deps: WbRunDeps = {
      loadRevision: async (ref) => {
        const info = await loadInfo(ref);
        if (!info) return null;
        await preloadCallees(info.body, new Set([refKey(ref)]));
        return { body: info.body, iface: info.iface, name: info.name, contentHash: info.contentHash };
      },
      loadCallee: (ref) => ifaces.get(refKey(ref))?.body ?? null,
      transportFor: (e): FlowTransport | null => {
        const tabId = connectedTabIdFor(e.id);
        return tabId === null ? null : new RealFlowTransport(tabId);
      },
      // `active` is set by this method for the run being started: only a DIFFERENT run counts as busy.
      isRunActive: () => handle !== null,
      confirmReview: (items, e, f) =>
        new Promise<boolean>((resolve) => {
          reviewResolve = resolve;
          set({ review: { items, ecu: e, files: f } });
        }),
      appendRecord: (rec) => client.append(rec),
      now: () => Date.now(),
      uuid: () => newId(),
      deviceId: deviceId(),
      appVersion: APP_VERSION,
      projectId,
      vehicleId: diagWorkspaceStore.getActiveVehicle()?.id ?? null,
    };
    const h = startWorkbenchRun(binding, ecu, files, deps);
    handle = h;
    let result: WbRunResult;
    try {
      result = await h.done;
    } finally {
      handle = null;
      if (reviewResolve) {
        // A dialog left open by a stopped run is closed with "declined".
        const r = reviewResolve;
        reviewResolve = null;
        r(false);
      }
    }
    if (result.kind === 'refused') {
      set({
        active: null,
        review: null,
        refusals: { ...state.refusals, [binding.id]: result.refusal.message },
        banner: result.refusal.code === 'stopped' ? null : { tone: 'warn', message: t('workbench.refused', { msg: result.refusal.message }) },
      });
    } else {
      set({
        active: null,
        review: null,
        records: { ...state.records, [recordKey(result.record.ecuId, result.record.flowId)]: result.record },
        banner: result.appendError !== null ? { tone: 'critical', message: t('workbench.appendError', { msg: result.appendError }) } : null,
      });
    }
    return result;
  },

  /** Workbench Stop (the global Panic Stop reaches the run through the tx-source registry on its own). */
  stop(): void {
    handle?.stop();
  },
};

export function useDiagWorkbench(): WbState {
  return useSyncExternalStore(diagWorkbenchStore.subscribe, diagWorkbenchStore.getState, diagWorkbenchStore.getState);
}
