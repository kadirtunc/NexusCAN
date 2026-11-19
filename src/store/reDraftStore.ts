/**
 * RE signal draft store (re-toolkit-v1 R2b). In-memory list of `ReSignalDraftDto` kept in sync with the project file
 * (`NexusProjectFileV1.reSignals`): `load()` replaces the list silently (project open), every user edit notifies the
 * `onMutation` listeners (projectStore.markDirty). No imports from projectStore (it imports this module).
 */
import { useSyncExternalStore } from 'react';
import type { ReSignalDraftDto } from '../types/reDraft';

export interface ReDraftState {
  drafts: readonly ReSignalDraftDto[];
  /** multi-select (ids) in the Found Signals panel */
  selected: ReadonlySet<string>;
  /** draft being edited / created in the dialog (null = closed) */
  editing: ReSignalDraftDto | null;
  /** true when `editing` is not yet in `drafts` */
  editingIsNew: boolean;
}

export interface ReDraftStore {
  getState(): ReDraftState;
  subscribe(l: () => void): () => void;
  /** project-open path: replaces the list without firing mutation listeners */
  load(drafts: readonly ReSignalDraftDto[]): void;
  /** project close / new project */
  reset(): void;
  upsert(draft: ReSignalDraftDto): void;
  remove(ids: readonly string[]): void;
  toggleSelected(id: string, on: boolean): void;
  setSelected(ids: readonly string[]): void;
  openEditor(draft: ReSignalDraftDto): void;
  closeEditor(): void;
  onMutation(fn: () => void): () => void;
}

const EMPTY: ReadonlySet<string> = new Set<string>();

export function createReDraftStore(): ReDraftStore {
  let state: ReDraftState = { drafts: [], selected: EMPTY, editing: null, editingIsNew: false };
  const listeners = new Set<() => void>();
  const mutationListeners = new Set<() => void>();
  const set = (patch: Partial<ReDraftState>): void => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };
  const mutated = (): void => {
    for (const fn of mutationListeners) fn();
  };

  return {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    load(drafts) {
      set({ drafts: [...drafts], selected: EMPTY, editing: null, editingIsNew: false });
    },
    reset() {
      set({ drafts: [], selected: EMPTY, editing: null, editingIsNew: false });
    },
    upsert(draft) {
      const i = state.drafts.findIndex((d) => d.id === draft.id);
      const drafts = i >= 0 ? state.drafts.map((d, k) => (k === i ? draft : d)) : [...state.drafts, draft];
      set({ drafts });
      mutated();
    },
    remove(ids) {
      if (ids.length === 0) return;
      const gone = new Set(ids);
      const drafts = state.drafts.filter((d) => !gone.has(d.id));
      if (drafts.length === state.drafts.length) return;
      const selected = new Set([...state.selected].filter((id) => !gone.has(id)));
      set({ drafts, selected });
      mutated();
    },
    toggleSelected(id, on) {
      const selected = new Set(state.selected);
      if (on) selected.add(id);
      else selected.delete(id);
      set({ selected });
    },
    setSelected(ids) {
      set({ selected: new Set(ids) });
    },
    openEditor(draft) {
      set({ editing: draft, editingIsNew: !state.drafts.some((d) => d.id === draft.id) });
    },
    closeEditor() {
      set({ editing: null, editingIsNew: false });
    },
    onMutation(fn) {
      mutationListeners.add(fn);
      return () => {
        mutationListeners.delete(fn);
      };
    },
  };
}

export const reDraftStore: ReDraftStore = createReDraftStore();

export function useReDraftState(): ReDraftState {
  return useSyncExternalStore(reDraftStore.subscribe, reDraftStore.getState, reDraftStore.getState);
}

/** Collision-resistant id for new drafts (uuid when available). */
export function newReDraftId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID !== undefined) return c.randomUUID();
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
