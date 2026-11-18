/**
 * ECU Graph store: nodes found by functional discovery, their layout, and the per-node UDS quick
 * actions. Pure logic lives in `components/diagnostics/ecu-graph/graphModel.ts`.
 *
 * Honesty rules: nodes only ever come from real discovery responses (real mode) or the explicit DEMO
 * synthetic discovery (demo mode). Real and demo graphs are stored under different keys, so the demo
 * never pollutes a real graph. Identification / DTC results come from real UDS responses only.
 */
import { useSyncExternalStore } from 'react';
import { t } from '../i18n';
import { formatDiagError } from '../services/diagErrors';
import { decodeDidValue } from '../services/udsDecode';
import type { DiagSessionConfig, UdsSessionType } from '../types/diagnostics';
import type { DiscoveredEcuDto, EcuDiscoveryRequestDto, EcuDiscoveryResultDto } from '../types/udsClient';
import { ecusToResults } from '../components/diagnostics/passiveDiscovery';
import {
  applyDidValues,
  deserializeNodes,
  graphStorageKey,
  IDENT_DID_FIRST,
  IDENT_DID_LAST,
  mergeDiscovery,
  type MergeOptions,
  nodeKey,
  relayout,
  serializeNodes,
  type GraphDidValue,
  type GraphNode,
  type GraphPos,
} from '../components/diagnostics/ecu-graph/graphModel';
import { diagnosticsStore, UdsTransportError } from './diagnosticsStore';
import { registerTxSource } from './txSources';

export interface GraphViewport {
  /** Screen position (CSS px) of the world origin (the tester node). */
  x: number;
  y: number;
  zoom: number;
}

export interface LastScanSummary {
  atMs: number;
  busId: number;
  count: number;
  added: number;
  ignoredFrames: number;
  windowMs: number;
  functionalId: number;
  requestBytes: number[];
  demo: boolean;
}

export type GraphAction = 'connect' | 'identify' | 'dtc' | 'session';

export interface EcuGraphState {
  demo: boolean;
  busId: number;
  nodes: GraphNode[];
  selectedKey: string | null;
  lastScan: LastScanSummary | null;
  /** Per-node action in flight (`null` = idle). */
  busy: { key: string; action: GraphAction } | null;
  /** Last error text per node (localized, from a real response / transport condition). */
  nodeErrors: Record<string, string>;
}

let state: EcuGraphState = {
  demo: false,
  busId: 0,
  nodes: [],
  selectedKey: null,
  lastScan: null,
  busy: null,
  nodeErrors: {},
};
const listeners = new Set<() => void>();
const viewports = new Map<string, GraphViewport>();
let loadedScope: string | null = null;

function scopeId(demo: boolean, busId: number): string {
  return graphStorageKey(demo, busId);
}

function emit(): void {
  for (const l of listeners) l();
}

function set(partial: Partial<EcuGraphState>): void {
  state = { ...state, ...partial };
  emit();
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function persist(): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(scopeId(state.demo, state.busId), serializeNodes(state.nodes));
  } catch {
    /* quota / private mode: the graph simply stays in memory */
  }
}

function loadNodes(demo: boolean, busId: number): GraphNode[] {
  const s = storage();
  if (!s) return [];
  try {
    return deserializeNodes(s.getItem(scopeId(demo, busId)), busId);
  } catch {
    return [];
  }
}

function setNodes(nodes: GraphNode[], extra: Partial<EcuGraphState> = {}): void {
  set({ nodes, ...extra });
  persist();
}

function patchNode(key: string, fn: (n: GraphNode) => GraphNode): void {
  let changed = false;
  const nodes = state.nodes.map((n) => {
    if (n.key !== key) return n;
    changed = true;
    return fn(n);
  });
  if (changed) setNodes(nodes);
}

function setNodeError(key: string, message: string | null): void {
  const next = { ...state.nodeErrors };
  if (message === null) delete next[key];
  else next[key] = message;
  set({ nodeErrors: next });
}

function findNode(key: string): GraphNode | null {
  return state.nodes.find((n) => n.key === key) ?? null;
}

/** Key of the node the Diagnostics session is currently connected to (`null` = no session). */
export function activeNodeKey(): string | null {
  const { session } = diagnosticsStore.getState();
  if (!session.connected) return null;
  return nodeKey(session.config.busId, session.config.isExtendedId, session.config.responseId);
}

function isActive(key: string): boolean {
  return activeNodeKey() === key;
}

async function readIdentificationDid(did: number): Promise<{ text: string } | { error: string; abort: boolean; timeout: boolean }> {
  if (diagnosticsStore.getState().mockMode) {
    await diagnosticsStore.readDid(did);
    const entry = diagnosticsStore.getState().didValues.get(did);
    return entry ? { text: entry.decoded } : { error: t('ecuGraph.err.noDemoValue'), abort: false, timeout: false };
  }
  try {
    const raw = await diagnosticsStore.readDidStrict(did, 'did');
    return { text: decodeDidValue(did, raw) };
  } catch (err) {
    if (err instanceof UdsTransportError) {
      const code = err.diag?.code;
      return {
        error: err.message,
        abort: err.kind !== 'failed' || code === 'session_closed' || code === 'bus_not_connected',
        timeout: code === 'timeout_p2' || code === 'timeout_p2_star' || code === 'timeout_isotp',
      };
    }
    return { error: String(err), abort: false, timeout: false };
  }
}

/** Bumped by Panic Stop: the sequential identification-DID read loop stops at the next DID. */
let identAbortGen = 0;
registerTxSource('ecu-graph-identify', () => {
  identAbortGen += 1;
});

export const ecuGraphStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getState(): EcuGraphState {
    return state;
  },

  /** Loads the persisted graph of (demo|real, bus). No-op when the scope did not change. */
  setScope(demo: boolean, busId: number): void {
    const id = scopeId(demo, busId);
    if (loadedScope === id) return;
    loadedScope = id;
    set({
      demo,
      busId,
      nodes: loadNodes(demo, busId),
      selectedKey: null,
      lastScan: null,
      busy: null,
      nodeErrors: {},
    });
  },

  getViewport(): GraphViewport | null {
    return viewports.get(scopeId(state.demo, state.busId)) ?? null;
  },

  /** Not reactive on purpose: pan / zoom must not re-render React. */
  saveViewport(v: GraphViewport): void {
    viewports.set(scopeId(state.demo, state.busId), v);
  },

  select(key: string | null): void {
    if (key !== state.selectedKey) set({ selectedKey: key });
  },

  /** Drag end: stores the position and pins the node (never auto-moved again). */
  moveNode(key: string, pos: GraphPos): void {
    patchNode(key, (n) => ({ ...n, pos: { x: Math.round(pos.x), y: Math.round(pos.y) }, pinned: true }));
  },

  unpinNode(key: string): void {
    patchNode(key, (n) => ({ ...n, pinned: false }));
  },

  removeNode(key: string): void {
    const nodeErrors = { ...state.nodeErrors };
    delete nodeErrors[key];
    setNodes(
      state.nodes.filter((n) => n.key !== key),
      { selectedKey: state.selectedKey === key ? null : state.selectedKey, nodeErrors },
    );
  },

  clearGraph(): void {
    setNodes([], { selectedKey: null, lastScan: null, nodeErrors: {} });
  },

  /** `all = false`: only unpinned nodes are re-arranged. */
  relayout(all: boolean): void {
    setNodes(relayout(state.nodes, all));
  },

  /** Merges a discovery result (does NOT start a scan). */
  mergeScan(result: EcuDiscoveryResultDto, busId: number, nowMs: number = Date.now()): void {
    const before = new Set(state.nodes.map((n) => n.key));
    const nodes = mergeDiscovery(state.nodes, result, busId, nowMs);
    const added = nodes.filter((n) => !before.has(n.key)).length;
    setNodes(nodes, {
      lastScan: {
        atMs: nowMs,
        busId,
        count: result.ecus.length,
        added,
        ignoredFrames: result.ignoredFrames,
        windowMs: result.windowMs,
        functionalId: result.functionalId,
        requestBytes: result.requestBytes,
        demo: state.demo,
      },
    });
  },

  /**
   * Adds ECUs found by something other than a functional scan (physical sweep, passive pairs) through the
   * same `mergeDiscovery` path. Nodes are never removed or moved, unrelated nodes are not flagged unseen and
   * the "last scan" summary is left alone. Returns how many NEW nodes were created.
   */
  addEcus(ecus: readonly DiscoveredEcuDto[], busId: number, options: MergeOptions = {}, nowMs: number = Date.now()): number {
    ecuGraphStore.setScope(diagnosticsStore.getState().mockMode, busId);
    const before = new Set(state.nodes.map((n) => n.key));
    let nodes = state.nodes;
    for (const result of ecusToResults(ecus)) {
      nodes = mergeDiscovery(nodes, result, busId, nowMs, { markUnseen: false, ...options });
    }
    setNodes(nodes);
    return nodes.filter((n) => !before.has(n.key)).length;
  },

  /**
   * Runs a functional discovery through the existing `diagnosticsStore.discoverEcus` and merges the
   * answer. Returns false when the scan failed (the error is in `diagnosticsStore` `discoveryError`).
   */
  async scan(req: EcuDiscoveryRequestDto): Promise<boolean> {
    ecuGraphStore.setScope(diagnosticsStore.getState().mockMode, req.busId);
    const result = await diagnosticsStore.discoverEcus(req);
    if (result === null) return false;
    // The scope may have changed while the scan was in flight: never merge into a different graph.
    if (state.busId !== req.busId || state.demo !== diagnosticsStore.getState().mockMode) return false;
    ecuGraphStore.mergeScan(result, req.busId);
    return true;
  },

  /**
   * Makes this ECU the Diagnostics session target: closes a session to another ECU, then connects with a
   * config built from the node (padding / FD / P2 margin are kept from the current config).
   */
  async makeActive(key: string, functionalId: number | null): Promise<boolean> {
    const node = findNode(key);
    if (!node) return false;
    if (node.requestId === null) {
      setNodeError(key, t('ecuGraph.err.noRequestId'));
      return false;
    }
    if (state.busy !== null || diagnosticsStore.getState().connecting) return false;
    if (isActive(key)) return true;
    setNodeError(key, null);
    set({ busy: { key, action: 'connect' } });
    try {
      // Another session tab already owns this ECU: switch to it instead of re-addressing this tab.
      const owner = diagnosticsStore.findTabByAddressing({
        ...diagnosticsStore.getState().session.config,
        requestId: node.requestId,
        responseId: node.responseId,
        busId: node.busId,
        isExtendedId: node.isExtendedId,
      });
      if (owner) {
        diagnosticsStore.setActiveTab(owner.id);
        if (isActive(key)) return true;
      }
      if (diagnosticsStore.getState().session.connected) await diagnosticsStore.disconnect();
      const current = diagnosticsStore.getState().session.config;
      const config: DiagSessionConfig = {
        ...current,
        requestId: node.requestId,
        responseId: node.responseId,
        busId: node.busId,
        isExtendedId: node.isExtendedId,
        protocol: 'uds',
        functionalId,
      };
      diagnosticsStore.clearError();
      await diagnosticsStore.connect(config);
      if (!isActive(key)) {
        const err = diagnosticsStore.getState().lastError;
        setNodeError(key, err ? formatDiagError(t, err) : t('ecuGraph.err.connectFailed'));
        return false;
      }
      return true;
    } finally {
      set({ busy: null });
    }
  },

  /**
   * Reads identification DIDs F186..F19F from the ACTIVE ECU (one real request per DID) and folds the
   * answers into the node identity. DIDs the ECU rejects (NRC) are skipped; a lost session aborts.
   */
  async readIdentification(key: string): Promise<void> {
    if (!findNode(key) || state.busy !== null) return;
    if (!isActive(key)) {
      setNodeError(key, t('ecuGraph.err.makeActiveFirst'));
      return;
    }
    setNodeError(key, null);
    set({ busy: { key, action: 'identify' } });
    const values: GraphDidValue[] = [];
    let rejected = 0;
    let lastError: string | null = null;
    let timeouts = 0;
    const gen = identAbortGen;
    try {
      for (let did = IDENT_DID_FIRST; did <= IDENT_DID_LAST; did++) {
        if (gen !== identAbortGen) break;
        if (!isActive(key)) {
          lastError = t('ecuGraph.err.sessionLost');
          break;
        }
        const r = await readIdentificationDid(did);
        if ('text' in r) {
          values.push({ did, text: r.text });
          timeouts = 0;
        } else {
          rejected += 1;
          lastError = r.error;
          timeouts = r.timeout ? timeouts + 1 : 0;
          if (r.abort || timeouts >= 2) break;
        }
      }
    } finally {
      if (values.length > 0) patchNode(key, (n) => applyDidValues(n, values));
      if (values.length === 0 && lastError !== null) setNodeError(key, lastError);
      else if (rejected > 0) setNodeError(key, null);
      set({ busy: null });
    }
  },

  /** Reads the stored DTCs of the ACTIVE ECU and records the confirmed count on the node. */
  async readDtcs(key: string): Promise<void> {
    if (!findNode(key) || state.busy !== null) return;
    if (!isActive(key)) {
      setNodeError(key, t('ecuGraph.err.makeActiveFirst'));
      return;
    }
    setNodeError(key, null);
    set({ busy: { key, action: 'dtc' } });
    try {
      diagnosticsStore.clearError();
      await diagnosticsStore.scanDtcs();
      const after = diagnosticsStore.getState();
      if (after.lastError !== null) {
        setNodeError(key, formatDiagError(t, after.lastError));
      } else if (isActive(key)) {
        const codes = new Set<string>();
        for (const d of after.storedDtcs) codes.add(d.code);
        patchNode(key, (n) => ({ ...n, dtcCount: codes.size }));
      }
    } finally {
      set({ busy: null });
    }
  },

  /** DiagnosticSessionControl on the ACTIVE ECU; the node records the session only on a positive response. */
  async setSession(key: string, session: Extract<UdsSessionType, 'default' | 'extended'>): Promise<void> {
    if (!findNode(key) || state.busy !== null) return;
    if (!isActive(key)) {
      setNodeError(key, t('ecuGraph.err.makeActiveFirst'));
      return;
    }
    setNodeError(key, null);
    set({ busy: { key, action: 'session' } });
    try {
      const prevId = diagnosticsStore.getState().lastUds?.id ?? 0;
      await diagnosticsStore.setUdsSession(session);
      const ex = diagnosticsStore.getState().lastUds;
      if (!ex || ex.id === prevId) return;
      if (ex.error) setNodeError(key, formatDiagError(t, ex.error));
      else if (ex.response && !ex.response.positive) {
        setNodeError(key, t('ecuGraph.err.nrc', { nrc: ex.response.nrcName ?? '?' }));
      } else if (ex.response?.positive) {
        patchNode(key, (n) => ({ ...n, lastSession: session }));
      }
    } finally {
      set({ busy: null });
    }
  },

  clearNodeError(key: string): void {
    setNodeError(key, null);
  },
};

export function useEcuGraphStore(): EcuGraphState {
  return useSyncExternalStore(ecuGraphStore.subscribe, ecuGraphStore.getState, ecuGraphStore.getState);
}
