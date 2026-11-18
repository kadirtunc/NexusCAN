/**
 * Flow Registry (diag-workspace-v1 §8 / §9): the user's flows and custom blocks as first-class, persistent,
 * versioned library items. Holds the library index, the OPEN DOCUMENTS (several at once) and the active one.
 *
 * Document model: the canvas store (`flowStore`) always edits the ACTIVE document; every other open document
 * keeps its diagram, undo stack and view here. Switching documents stashes / restores them, so undo is per
 * document. Phase B2 plugs call frames in without touching this model: a call block references a library item
 * (`FlowRefV1`) and the engine resolves the callee through `loadBody(id, revision)` into its own frame; the open
 * documents are never involved in a run of another flow.
 */
import { useSyncExternalStore } from 'react';
import { t } from '../../../i18n';
import {
  parseFlowLibError,
  type FlowLibEntryDto,
  type FlowLibKind,
  type FlowLibRevisionDto,
  type NxFlowBodyV1,
} from '../../../types/flowLibrary';
import { downloadTextFile, pickTextFile } from '../../diagnostics/workspace/fileIo';
import { flowStore } from '../FlowStore';
import { migrateAll } from '../flowMigrate';
import { CalleeCache, wouldCreateCycle } from '../callGraph';
import { callIndex, callType, isCallType, readCallRef } from '../callIndex';
import { buildExtraction } from '../extractBlock';
import { validateInterface } from '../flowInterface';
import { validateCore } from '../coreValidate';
import { FLOW_INPUT, FLOW_OUTPUT } from '../flowPorts';
import type { FlowBlock, FlowConnection, FlowDiagram, FlowTemplate } from '../types';
import { bodyMeta, buildFlowFile, contentCanon, fromFlowBody, parseFlowFile, toFlowBody, type FlowMeta } from './flowBody';
import { ipcFlowLibClient, type FlowLibClient } from './flowLibClient';
import { migrateLegacyDiagrams, type LegacyMigrationReport, type StorageLike } from './flowLegacyMigration';

export interface FlowDocView {
  zoom: number;
  panX: number;
  panY: number;
}

export interface FlowDocument {
  /** Tab key: the library id, or `<id>@r<N>` for a read-only historical revision. */
  key: string;
  id: string;
  kind: FlowLibKind;
  meta: FlowMeta;
  /** Latest saved revision this document is based on (0 = never saved). */
  baseRevision: number;
  dirty: boolean;
  readOnly: boolean;
  /** Revision shown by a read-only document. */
  viewRevision: number | null;
  /** Canonical content of the last saved / loaded state (dirty detection). */
  savedCanon: string;
  /** Stashed editor state; for the ACTIVE document the live state is in `flowStore`. */
  diagram: FlowDiagram;
  undoStack: FlowDiagram[];
  view: FlowDocView;
  notes: string[];
}

export interface FlowConflict {
  key: string;
  name: string;
  /** Latest revision in the library (`null` when unknown). */
  latestRevision: number | null;
}

export interface FlowRegistryState {
  entries: FlowLibEntryDto[];
  showDeleted: boolean;
  loading: boolean;
  error: string | null;
  docs: FlowDocument[];
  activeKey: string | null;
  conflict: FlowConflict | null;
  revisions: { id: string; list: FlowLibRevisionDto[] } | null;
  migration: LegacyMigrationReport | null;
  /** Breadcrumb of entered callees: the first entry is the flow the user entered from (`via` = call block id). */
  trail: Array<{ key: string; via: string | null }>;
  /** Document that started the active run (its canvas may be re-shown while the run is active). */
  runRootKey: string | null;
  repinReport: { label: string; from: number; to: number; dropped: string[] } | null;
  /** "Kullanıldığı yerler" result of one library item. */
  usages: { id: string; list: Array<{ id: string; name: string; kind: FlowLibKind; revisions: number[] }> } | null;
  /** One-off message (call insertion / extraction refused). */
  notice: string | null;
}

export type SaveResult = { ok: true; revision: number } | { ok: false; conflict: boolean; message: string };

export interface RegistryDeps {
  now?: () => Date;
  uuid?: () => string;
}

const EMPTY_DIAGRAM: FlowDiagram = { id: '', name: '', blocks: [], connections: [], variables: [] };

function errText(e: unknown): string {
  const p = parseFlowLibError(e);
  if (p) return `[${p.code}] ${p.message}`;
  return e instanceof Error ? e.message : String(e);
}

export class FlowRegistryStore {
  private state: FlowRegistryState = {
    entries: [],
    showDeleted: false,
    loading: false,
    error: null,
    docs: [],
    activeKey: null,
    conflict: null,
    revisions: null,
    migration: null,
    trail: [],
    runRootKey: null,
    repinReport: null,
    usages: null,
    notice: null,
  };
  /** Callee loader shared by the editor (call-block ports, insertion checks) and the engine's per-run caches. */
  readonly callees: CalleeCache;
  private readonly listeners = new Set<() => void>();
  private inited = false;
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(
    private readonly client: FlowLibClient,
    private readonly storage: StorageLike | null = null,
    deps: RegistryDeps = {},
  ) {
    this.now = deps.now ?? ((): Date => new Date());
    this.uuid = deps.uuid ?? ((): string => globalThis.crypto.randomUUID());
    this.callees = new CalleeCache((id, rev) => this.loadBody(id, rev));
  }

  getSnapshot = (): FlowRegistryState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(partial: Partial<FlowRegistryState>): void {
    this.state = { ...this.state, ...partial };
    for (const l of this.listeners) l();
  }

  private patchDoc(key: string, patch: Partial<FlowDocument>): void {
    this.set({ docs: this.state.docs.map((d) => (d.key === key ? { ...d, ...patch } : d)) });
  }

  getDoc(key: string | null): FlowDocument | undefined {
    return key === null ? undefined : this.state.docs.find((d) => d.key === key);
  }

  activeDoc(): FlowDocument | undefined {
    return this.getDoc(this.state.activeKey);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Starts the dirty watcher, runs the one-time localStorage migration and loads the library index. */
  async init(): Promise<void> {
    if (this.inited) return;
    this.inited = true;
    flowStore.subscribe(() => this.scheduleDirtyCheck());
    if (this.storage) {
      try {
        const report = await migrateLegacyDiagrams(this.storage, this.client, { now: this.now, uuid: this.uuid });
        if (!report.skipped) this.set({ migration: report });
      } catch (e) {
        this.set({ error: errText(e) });
      }
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.set({ loading: true });
    try {
      const entries = await this.client.list(this.state.showDeleted);
      callIndex.setLatest(entries);
      this.set({ entries, loading: false, error: null });
    } catch (e) {
      this.set({ loading: false, error: errText(e) });
    }
  }

  async setShowDeleted(v: boolean): Promise<void> {
    this.set({ showDeleted: v });
    await this.refresh();
  }

  dismissMigration(): void {
    this.set({ migration: null });
  }

  clearError(): void {
    this.set({ error: null });
  }

  // ── Dirty tracking ─────────────────────────────────────────────────────────

  private scheduleDirtyCheck(): void {
    if (this.dirtyTimer !== null) return;
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
      this.refreshDirty();
    }, 120);
  }

  private canonOf(diagram: FlowDiagram, meta: FlowMeta): string {
    return contentCanon(toFlowBody(diagram, { ...meta, revision: 0, updatedAt: '' }));
  }

  /** Recomputes the active document's dirty flag from the live canvas (runtime state does not count). */
  refreshDirty(): void {
    const doc = this.activeDoc();
    if (!doc || doc.readOnly) return;
    const live = flowStore.getSnapshot().diagram;
    const dirty = this.canonOf(live, doc.meta) !== doc.savedCanon;
    if (dirty !== doc.dirty) this.patchDoc(doc.key, { dirty });
  }

  /** Copies the live canvas state into the active document record. */
  private syncActive(): void {
    const doc = this.activeDoc();
    if (!doc) return;
    const s = flowStore.getSnapshot();
    this.patchDoc(doc.key, {
      diagram: s.diagram,
      undoStack: s.undoStack,
      view: { zoom: s.zoom, panX: s.panX, panY: s.panY },
    });
    this.refreshDirty();
  }

  // ── Documents (tabs) ───────────────────────────────────────────────────────

  /**
   * Makes a document the canvas content. While a run is active only read-only views (entered callees) and the
   * run's own document can be shown. Returns false when refused.
   */
  activate(key: string): boolean {
    if (this.state.activeKey === key) return true;
    const target = this.getDoc(key);
    if (!target) return false;
    const running = flowStore.getSnapshot().isRunning;
    if (running && !target.readOnly && key !== this.state.runRootKey) return false;
    this.syncActive();
    const d = this.getDoc(key);
    if (!d) return false;
    let trail = this.state.trail;
    let idx = trail.findIndex((x) => x.key === key);
    if (idx < 0) {
      trail = [{ key, via: null }];
      idx = 0;
    }
    const viewPath = idx > 0 ? trail.slice(1, idx + 1).map((x) => x.via).join('/') : '';
    flowStore.loadDocument(d.diagram, { undoStack: d.undoStack, ...d.view, readOnly: d.readOnly, notes: d.notes, viewPath, keepLog: running });
    this.set({ activeKey: key, trail });
    void this.primeCallees(d.diagram);
    return true;
  }

  private addDoc(doc: FlowDocument): void {
    const exists = this.state.docs.some((d) => d.key === doc.key);
    this.set({ docs: exists ? this.state.docs.map((d) => (d.key === doc.key ? doc : d)) : [...this.state.docs, doc] });
    if (this.state.activeKey === doc.key) {
      flowStore.loadDocument(doc.diagram, { undoStack: doc.undoStack, ...doc.view, readOnly: doc.readOnly, notes: doc.notes });
      void this.primeCallees(doc.diagram);
    } else {
      this.activate(doc.key);
    }
  }

  /** Closes a document (the caller confirms unsaved changes). The active canvas switches to a neighbour or empties. */
  close(key: string): boolean {
    const idx = this.state.docs.findIndex((d) => d.key === key);
    if (idx < 0) return true;
    const wasActive = this.state.activeKey === key;
    if (wasActive && flowStore.getSnapshot().isRunning && !this.state.docs[idx].readOnly) return false;
    const tIdx = this.state.trail.findIndex((x) => x.key === key);
    if (tIdx >= 0) this.set({ trail: this.state.trail.slice(0, tIdx) });
    if (wasActive) this.syncActive();
    const docs = this.state.docs.filter((d) => d.key !== key);
    if (!wasActive) {
      this.set({ docs });
      return true;
    }
    const next = docs[Math.min(idx, docs.length - 1)];
    this.set({ docs, activeKey: null });
    if (next) {
      flowStore.loadDocument(next.diagram, { undoStack: next.undoStack, ...next.view, readOnly: next.readOnly, notes: next.notes });
      this.set({ activeKey: next.key });
    } else {
      flowStore.loadDocument(EMPTY_DIAGRAM);
    }
    return true;
  }

  // ── Call blocks / nesting ──────────────────────────────────────────────────

  /** Loads the pinned callee interfaces of every call block of `diagram` (ports then derive; canvas re-renders). */
  async primeCallees(diagram: FlowDiagram): Promise<void> {
    let any = false;
    for (const b of diagram.blocks) {
      const ref = isCallType(b.type) ? readCallRef(b) : null;
      if (ref && !callIndex.get(ref)) {
        try {
          await this.callees.ensure(ref);
          any = true;
        } catch {
          // stays unresolved: shown as such, the run is refused
        }
      }
    }
    if (any) flowStore.bump();
  }

  clearNotice(): void {
    this.set({ notice: null });
  }

  /** Inserts a call block of a library item (flows and custom blocks), pinned to its latest revision. */
  async insertCall(id: string, x = 300, y = 200): Promise<boolean> {
    const doc = this.activeDoc();
    if (!doc || doc.readOnly) return false;
    const entry = this.state.entries.find((e) => e.id === id);
    const latest = entry?.latestRevision ?? callIndex.latestOf(id);
    if (latest === undefined) {
      this.set({ notice: t('flowNest.err.unknownItem') });
      return false;
    }
    const ref = { flowId: id, revision: latest };
    try {
      await this.callees.ensure(ref);
    } catch (e) {
      this.set({ notice: errText(e) });
      return false;
    }
    if (await wouldCreateCycle(doc.id, ref, this.callees)) {
      this.set({ notice: t('flowNest.err.wouldCycle', { name: entry?.name ?? id }) });
      return false;
    }
    flowStore.addCallBlock(ref, callIndex.get(ref)?.name ?? entry?.name ?? id, x, y);
    return true;
  }

  /** "Update to latest" of one call block (ports re-derived, incompatible connections dropped, one undo step). */
  async repin(blockId: string): Promise<boolean> {
    const block = flowStore.getSnapshot().diagram.blocks.find((b) => b.id === blockId);
    const ref = block ? readCallRef(block) : null;
    const latest = ref ? callIndex.latestOf(ref.flowId) : undefined;
    if (!block || !ref || latest === undefined || latest <= ref.revision) return false;
    try {
      const info = await this.callees.ensure({ flowId: ref.flowId, revision: latest });
      const dropped = flowStore.repinCall(blockId, info);
      this.set({ repinReport: { label: block.label, from: ref.revision, to: latest, dropped } });
      return true;
    } catch (e) {
      this.set({ notice: errText(e) });
      return false;
    }
  }

  dismissRepin(): void {
    this.set({ repinReport: null });
  }

  /** Flows / blocks (latest revision) that contain a call to `id`. */
  async whereUsed(id: string): Promise<void> {
    const list: Array<{ id: string; name: string; kind: FlowLibKind; revisions: number[] }> = [];
    for (const e of this.state.entries) {
      if (e.deleted || e.id === id) continue;
      try {
        const { body } = await this.loadBody(e.id, null);
        const revisions = body.blocks.filter((b) => b.type === callType(id)).map((b) => {
          const r = (b.config['ref'] as { revision?: unknown } | undefined)?.revision;
          return typeof r === 'number' ? r : 0;
        });
        if (revisions.length > 0) list.push({ id: e.id, name: e.name, kind: e.kind, revisions });
      } catch {
        // an unreadable item cannot be listed
      }
    }
    this.set({ usages: { id, list } });
  }

  closeUsages(): void {
    this.set({ usages: null });
  }

  /** Double-click on a call block: shows the callee at its pinned revision, read-only, one level down the trail. */
  async enterCall(blockId: string): Promise<boolean> {
    const block = flowStore.getSnapshot().diagram.blocks.find((b) => b.id === blockId);
    const ref = block ? readCallRef(block) : null;
    const from = this.state.activeKey;
    if (!ref || from === null) return false;
    const base = this.state.trail.findIndex((x) => x.key === from) >= 0
      ? this.state.trail.slice(0, this.state.trail.findIndex((x) => x.key === from) + 1)
      : [{ key: from, via: null }];
    const key = `${ref.flowId}@r${ref.revision}`;
    const prev = this.state.trail;
    this.set({ trail: [...base, { key, via: blockId }] });
    const opened = this.getDoc(key) ? this.activate(key) : await this.open(ref.flowId, ref.revision);
    if (!opened) this.set({ trail: prev });
    return opened;
  }

  /** Breadcrumb click: back up to trail entry `index` (deeper read-only views are closed). */
  goToTrail(index: number): void {
    const trail = this.state.trail;
    if (index < 0 || index >= trail.length) return;
    const deeper = trail.slice(index + 1);
    this.set({ trail: trail.slice(0, index + 1) });
    this.activate(trail[index].key);
    for (const d of deeper) if (this.getDoc(d.key)?.readOnly) this.close(d.key);
  }

  /** "Düzenle (son revizyon)": the callee's latest revision as a normal editable tab. */
  editLatest(flowId: string): Promise<boolean> {
    return this.open(flowId);
  }

  setRunRoot(key: string | null): void {
    this.set({ runRootKey: key });
  }

  /** "Custom Block yap": the selection becomes a new `nexuscan.block` r1 and is replaced by a call block (one undo step). */
  async extractSelection(name: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const doc = this.activeDoc();
    const clean = name.trim();
    if (!doc || doc.readOnly) return { ok: false, message: t('flowReg.err.readOnly') };
    if (clean === '') return { ok: false, message: t('flowReg.err.nameEmpty') };
    this.syncActive();
    const snap = flowStore.getSnapshot();
    const calleeId = this.uuid();
    const res = buildExtraction(snap.diagram, snap.selectedBlockIds, clean, calleeId, (p) => this.freshId(p));
    if (!res.ok) return res;
    const issues = [...validateInterface(res.callee), ...validateCore(res.callee)];
    if (issues.length > 0) return { ok: false, message: issues[0].message };
    try {
      const iso = this.now().toISOString();
      const meta: FlowMeta = { ...this.newMeta(calleeId, 'user'), revision: 1, createdAt: iso, updatedAt: iso };
      await this.client.save(JSON.stringify(await buildFlowFile('nexuscan.block', toFlowBody(res.callee, meta))));
      await this.callees.ensure({ flowId: calleeId, revision: 1 });
    } catch (e) {
      return { ok: false, message: errText(e) };
    }
    flowStore.applyDiagram(res.apply(1));
    this.refreshDirty();
    void this.refresh();
    return { ok: true };
  }

  // ── Creating ───────────────────────────────────────────────────────────────

  private newMeta(id: string, origin: FlowMeta['origin']): FlowMeta {
    const iso = this.now().toISOString();
    return { id, revision: 0, description: '', createdAt: iso, updatedAt: iso, author: null, origin, aiReviewed: true, tags: [] };
  }

  private freshId(prefix: string): string {
    return `${prefix}_${this.uuid().replace(/-/g, '').slice(0, 10)}`;
  }

  /** `flow_input` (+ for a block one `flow_output` "ok" wired to it). */
  private seedDiagram(kind: FlowLibKind, id: string, name: string): FlowDiagram {
    const input: FlowBlock = {
      id: this.freshId('in'), type: FLOW_INPUT, label: t('flowReg.blk.flowInput'), x: 80, y: 120,
      config: { inputs: [] }, status: 'idle', collapsed: false,
    };
    const blocks: FlowBlock[] = [input];
    const connections: FlowConnection[] = [];
    if (kind === 'nexuscan.block') {
      const out: FlowBlock = {
        id: this.freshId('out'), type: FLOW_OUTPUT, label: 'ok', x: 460, y: 120,
        config: { name: 'ok', outcome: 'ok', outputs: [] }, status: 'idle', collapsed: false,
      };
      blocks.push(out);
      connections.push({ id: this.freshId('c'), fromBlockId: input.id, fromPortId: 'start', toBlockId: out.id, toPortId: 'in' });
    }
    return { id, name, blocks, connections, variables: [] };
  }

  /** New, unsaved document (first save = revision 1). */
  newDocument(kind: FlowLibKind): string {
    const id = this.uuid();
    const name = t(kind === 'nexuscan.flow' ? 'flowReg.newFlowName' : 'flowReg.newBlockName');
    const meta = this.newMeta(id, 'user');
    const diagram = this.seedDiagram(kind, id, name);
    this.addDoc({
      key: id, id, kind, meta, baseRevision: 0, dirty: true, readOnly: false, viewRevision: null,
      savedCanon: '', diagram, undoStack: [], view: { zoom: 1, panX: 0, panY: 0 }, notes: [],
    });
    return id;
  }

  /** "New from template": the template is only a seed; the result is an independent, unsaved flow. */
  newFromTemplate(template: FlowTemplate): string {
    const id = this.uuid();
    const raw: FlowDiagram = {
      id,
      name: t(template.nameKey),
      blocks: template.diagram.blocks.map((b) => ({ ...b, config: JSON.parse(JSON.stringify(b.config)) as Record<string, unknown> })),
      connections: template.diagram.connections.map((c) => ({ ...c })),
      variables: (template.diagram.variables ?? []).map((v) => ({ ...v })),
    };
    const { diagram, notes } = migrateAll(raw);
    this.addDoc({
      key: id, id, kind: 'nexuscan.flow', meta: this.newMeta(id, 'template'), baseRevision: 0, dirty: true, readOnly: false,
      viewRevision: null, savedCanon: '', diagram, undoStack: [], view: { zoom: 1, panX: 0, panY: 0 }, notes,
    });
    return id;
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  /** Parsed library file of an item revision (`null` = latest). Used by `open` and by Phase B2 call frames. */
  async loadBody(id: string, revision: number | null): Promise<{ kind: FlowLibKind; body: NxFlowBodyV1 }> {
    const text = await this.client.load(id, revision);
    const parsed = parseFlowFile(text);
    if (!parsed.ok) throw new Error(`[flowlib:invalid] ${parsed.message}`);
    return { kind: parsed.file.kind, body: parsed.file.flow };
  }

  private docFromBody(kind: FlowLibKind, body: NxFlowBodyV1, readOnly: boolean): FlowDocument {
    const meta = bodyMeta(body);
    const stored = fromFlowBody(body);
    const migrated = migrateAll(stored);
    const key = readOnly ? `${body.id}@r${body.revision}` : body.id;
    const savedCanon = this.canonOf(stored, meta);
    return {
      key, id: body.id, kind, meta, baseRevision: body.revision,
      dirty: !readOnly && this.canonOf(migrated.diagram, meta) !== savedCanon,
      readOnly, viewRevision: readOnly ? body.revision : null, savedCanon,
      diagram: migrated.diagram, undoStack: [], view: { zoom: 1, panX: 0, panY: 0 }, notes: migrated.notes,
    };
  }

  async open(id: string, revision: number | null = null): Promise<boolean> {
    const key = revision === null ? id : `${id}@r${revision}`;
    if (this.getDoc(key)) return this.activate(key);
    try {
      const { kind, body } = await this.loadBody(id, revision);
      this.addDoc(this.docFromBody(kind, body, revision !== null));
      return true;
    } catch (e) {
      this.set({ error: errText(e) });
      return false;
    }
  }

  // ── Saving ─────────────────────────────────────────────────────────────────

  async save(key: string | null = this.state.activeKey): Promise<SaveResult> {
    if (key === this.state.activeKey) this.syncActive();
    const doc = this.getDoc(key);
    if (!doc) return { ok: false, conflict: false, message: 'no document' };
    if (doc.readOnly) return { ok: false, conflict: false, message: t('flowReg.err.readOnly') };
    if (doc.diagram.name.trim() === '') {
      const message = t('flowReg.err.nameEmpty');
      this.set({ error: message });
      return { ok: false, conflict: false, message };
    }
    const revision = doc.baseRevision + 1;
    const meta: FlowMeta = { ...doc.meta, id: doc.id, revision, updatedAt: this.now().toISOString() };
    const body = toFlowBody(doc.diagram, meta);
    try {
      const file = await buildFlowFile(doc.kind, body);
      const entry = await this.client.save(JSON.stringify(file));
      this.patchDoc(doc.key, {
        baseRevision: entry.latestRevision, meta: { ...meta, revision: entry.latestRevision },
        savedCanon: contentCanon(body), dirty: false,
      });
      this.set({ error: null });
      this.refreshDirty();
      void this.refresh();
      return { ok: true, revision: entry.latestRevision };
    } catch (e) {
      const p = parseFlowLibError(e);
      if (p?.code === 'conflict') {
        let latest: number | null = null;
        try {
          latest = (await this.client.list(true)).find((x) => x.id === doc.id)?.latestRevision ?? null;
        } catch {
          latest = null;
        }
        this.set({ conflict: { key: doc.key, name: doc.diagram.name, latestRevision: latest } });
        return { ok: false, conflict: true, message: p.message };
      }
      const message = errText(e);
      this.set({ error: message });
      return { ok: false, conflict: false, message };
    }
  }

  /** Conflict resolution "reload latest": discards the local edits of the document. */
  async resolveConflictReload(): Promise<void> {
    const c = this.state.conflict;
    if (!c) return;
    this.set({ conflict: null });
    const doc = this.getDoc(c.key);
    if (!doc) return;
    try {
      const { kind, body } = await this.loadBody(doc.id, null);
      const fresh = this.docFromBody(kind, body, false);
      const wasActive = this.state.activeKey === doc.key;
      this.set({ docs: this.state.docs.map((d) => (d.key === doc.key ? fresh : d)) });
      if (wasActive) flowStore.loadDocument(fresh.diagram, { notes: fresh.notes });
      void this.refresh();
    } catch (e) {
      this.set({ error: errText(e) });
    }
  }

  /** Conflict resolution "save as copy": the local state becomes a NEW library item; the original reloads the latest. */
  async resolveConflictSaveCopy(): Promise<void> {
    const c = this.state.conflict;
    if (!c) return;
    const doc = this.getDoc(c.key);
    if (!doc) {
      this.set({ conflict: null });
      return;
    }
    if (c.key === this.state.activeKey) this.syncActive();
    const src = this.getDoc(c.key) ?? doc;
    const id = this.uuid();
    const iso = this.now().toISOString();
    const meta: FlowMeta = { ...src.meta, id, revision: 1, createdAt: iso, updatedAt: iso, origin: 'user', aiReviewed: true };
    const copy: FlowDiagram = { ...src.diagram, id, name: `${src.diagram.name} ${t('flowReg.copySuffix')}` };
    try {
      const body = toFlowBody(copy, meta);
      await this.client.save(JSON.stringify(await buildFlowFile(src.kind, body)));
    } catch (e) {
      this.set({ error: errText(e) });
      return;
    }
    await this.resolveConflictReload();
    await this.open(id);
  }

  dismissConflict(): void {
    this.set({ conflict: null });
  }

  // ── Library actions ────────────────────────────────────────────────────────

  private async latestRevisionOf(id: string): Promise<number> {
    const all = await this.client.list(true);
    const e = all.find((x) => x.id === id);
    if (!e) throw new Error(`[flowlib:not_found] ${id}`);
    return e.latestRevision;
  }

  /** Saves `body` as the next revision of its own id (restore, rename of a closed item). */
  private async saveAsNext(kind: FlowLibKind, body: NxFlowBodyV1): Promise<FlowLibEntryDto> {
    const latest = await this.latestRevisionOf(body.id);
    const next: NxFlowBodyV1 = { ...body, revision: latest + 1, updatedAt: this.now().toISOString() };
    return this.client.save(JSON.stringify(await buildFlowFile(kind, next)));
  }

  /** Independent copy (new id, revision 1) of the latest saved revision; opens it. */
  async duplicate(id: string): Promise<boolean> {
    try {
      const { kind, body } = await this.loadBody(id, null);
      const iso = this.now().toISOString();
      const newId = this.uuid();
      const copy: NxFlowBodyV1 = {
        ...body, id: newId, revision: 1, name: `${body.name} ${t('flowReg.copySuffix')}`, createdAt: iso, updatedAt: iso, origin: 'user',
      };
      await this.client.save(JSON.stringify(await buildFlowFile(kind, copy)));
      await this.refresh();
      return await this.open(newId);
    } catch (e) {
      this.set({ error: errText(e) });
      return false;
    }
  }

  /**
   * Rename. An open document just changes its name (saved at once when it had no other unsaved edits);
   * a closed item gets a new revision with the new name.
   */
  async rename(id: string, name: string): Promise<boolean> {
    const clean = name.trim();
    if (clean === '') {
      this.set({ error: t('flowReg.err.nameEmpty') });
      return false;
    }
    const doc = this.getDoc(id);
    if (doc && !doc.readOnly) {
      this.syncActive();
      const before = this.getDoc(id) as FlowDocument;
      const wasClean = !before.dirty;
      this.patchDoc(id, { diagram: { ...before.diagram, name: clean } });
      if (this.state.activeKey === id) flowStore.setDiagramName(clean);
      this.refreshDirty();
      if (wasClean && before.baseRevision > 0) return (await this.save(id)).ok;
      return true;
    }
    try {
      const { kind, body } = await this.loadBody(id, null);
      await this.saveAsNext(kind, { ...body, name: clean });
      await this.refresh();
      return true;
    } catch (e) {
      this.set({ error: errText(e) });
      return false;
    }
  }

  /** Soft delete (the caller confirms); open tabs of the item are closed. */
  async remove(id: string): Promise<boolean> {
    try {
      await this.client.delete(id);
    } catch (e) {
      this.set({ error: errText(e) });
      return false;
    }
    for (const d of this.state.docs.filter((x) => x.id === id)) this.close(d.key);
    await this.refresh();
    return true;
  }

  /** Restore of a soft-deleted item = the next revision of its last body. */
  async restoreDeleted(id: string): Promise<boolean> {
    try {
      const { kind, body } = await this.loadBody(id, null);
      await this.saveAsNext(kind, body);
      await this.refresh();
      return true;
    } catch (e) {
      this.set({ error: errText(e) });
      return false;
    }
  }

  async loadRevisions(id: string): Promise<void> {
    try {
      this.set({ revisions: { id, list: await this.client.revisions(id) } });
    } catch (e) {
      this.set({ error: errText(e) });
    }
  }

  closeRevisions(): void {
    this.set({ revisions: null });
  }

  /** Opens a historical revision read-only. */
  openRevision(id: string, revision: number): Promise<boolean> {
    return this.open(id, revision);
  }

  /** "Restore as new revision": the chosen revision's content becomes latest + 1 (refused while the item has unsaved edits). */
  async restoreRevision(id: string, revision: number): Promise<boolean> {
    const open = this.getDoc(id);
    if (open?.dirty) {
      this.set({ error: t('flowReg.err.restoreDirty') });
      return false;
    }
    try {
      const { kind, body } = await this.loadBody(id, revision);
      await this.saveAsNext(kind, body);
      if (open) this.close(id);
      await this.refresh();
      await this.loadRevisions(id);
      return await this.open(id);
    } catch (e) {
      this.set({ error: errText(e) });
      return false;
    }
  }

  // ── Export / import ────────────────────────────────────────────────────────

  private async fileText(id: string): Promise<{ name: string; text: string }> {
    const doc = this.getDoc(id);
    if (doc && !doc.readOnly) {
      this.syncActive();
      const d = this.getDoc(id) as FlowDocument;
      const body = toFlowBody(d.diagram, { ...d.meta, revision: Math.max(d.baseRevision, 1), updatedAt: this.now().toISOString() });
      return { name: d.diagram.name, text: JSON.stringify(await buildFlowFile(d.kind, body), null, 2) };
    }
    const text = await this.client.load(id, null);
    const parsed = parseFlowFile(text);
    return { name: parsed.ok ? parsed.file.flow.name : id, text };
  }

  async exportItem(id: string): Promise<boolean> {
    try {
      const { name, text } = await this.fileText(id);
      const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'flow';
      downloadTextFile(`${safe}.nxflow.json`, text);
      return true;
    } catch (e) {
      this.set({ error: errText(e) });
      return false;
    }
  }

  /** Imports file text as a NEW library item (new id, revision 1, origin `import`) and opens it. */
  async importText(text: string): Promise<boolean> {
    const parsed = parseFlowFile(text);
    if (!parsed.ok) {
      this.set({ error: t('flowReg.err.importInvalid', { reason: parsed.message }) });
      return false;
    }
    const src = parsed.file.flow;
    const iso = this.now().toISOString();
    const body: NxFlowBodyV1 = {
      ...src,
      id: this.uuid(),
      revision: 1,
      createdAt: iso,
      updatedAt: iso,
      origin: 'import',
      aiReviewed: src.origin === 'ai' ? src.aiReviewed : true,
    };
    try {
      const migrated = migrateAll(fromFlowBody(body));
      const normalized = toFlowBody(migrated.diagram, bodyMeta(body));
      await this.client.save(JSON.stringify(await buildFlowFile(parsed.file.kind, normalized)));
      await this.refresh();
      return await this.open(body.id);
    } catch (e) {
      this.set({ error: errText(e) });
      return false;
    }
  }

  async importFromFile(): Promise<boolean> {
    try {
      const picked = await pickTextFile('.json,application/json');
      if (!picked) return false;
      return await this.importText(picked.text);
    } catch (e) {
      this.set({ error: errText(e) });
      return false;
    }
  }
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export const flowRegistry = new FlowRegistryStore(ipcFlowLibClient, browserStorage());

export function useFlowRegistry(): FlowRegistryState {
  return useSyncExternalStore(flowRegistry.subscribe, flowRegistry.getSnapshot);
}
