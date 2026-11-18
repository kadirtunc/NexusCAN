/**
 * Diagnostics workspace store: the project's `diagnostics` block (vehicles -> groups -> ECU records).
 * It is the SINGLE source written into the project file (`projectStore.buildProjectSnapshot`) and is
 * replaced on project load (`load`, no dirty). Every mutation bumps `revision` / `updatedAt` of the
 * changed ECU(s) and its vehicle, then notifies the mutation listeners (`projectStore` marks the
 * project dirty + schedules the auto-save). Pure module-level store: no React import except the hooks.
 */
import { useSyncExternalStore } from 'react';
import {
  EMPTY_DIAGNOSTICS,
  type DiagVehicleV1,
  type DiagnosticsProjectV1,
  type EcuGroupColor,
  type EcuGroupV1,
  type EcuRecordV1,
  type FlowBindingV1,
} from '../../../types/diagWorkspace';
import { cloneRecord, newEcuRecord, newId, newVehicle, nowIso, uniqueName, type EcuRecordInit } from './ecuDefaults';

export type StoreResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' | 'empty_name' | 'duplicate_name' | 'not_empty' | 'group_not_found' };

const ok = <T>(value: T): StoreResult<T> => ({ ok: true, value });
const err = (reason: Extract<StoreResult, { ok: false }>['reason']): StoreResult<never> => ({ ok: false, reason });

function emptyState(): DiagnosticsProjectV1 {
  return { ...EMPTY_DIAGNOSTICS, vehicles: [] };
}

let state: DiagnosticsProjectV1 = emptyState();
const listeners = new Set<() => void>();
const mutationListeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Commit a user mutation: replaces the state, notifies subscribers and persistence hooks. */
function commit(next: DiagnosticsProjectV1): void {
  state = next;
  emit();
  for (const fn of mutationListeners) fn();
}

function normName(s: string): string {
  return s.trim().toLowerCase();
}

function findVehicle(id: string): DiagVehicleV1 | undefined {
  return state.vehicles.find((v) => v.id === id);
}

/** Replaces one vehicle; bumps its revision / updatedAt. */
function withVehicle(id: string, fn: (v: DiagVehicleV1, now: string) => DiagVehicleV1): StoreResult<DiagVehicleV1> {
  const cur = findVehicle(id);
  if (!cur) return err('not_found');
  const now = nowIso();
  const mapped = fn(cur, now);
  const next: DiagVehicleV1 = { ...mapped, revision: cur.revision + 1, updatedAt: now };
  commit({ ...state, vehicles: state.vehicles.map((v) => (v.id === id ? next : v)) });
  return ok(next);
}

function bumpEcu(e: EcuRecordV1, now: string, patch: Partial<EcuRecordV1> = {}): EcuRecordV1 {
  return { ...e, ...patch, revision: e.revision + 1, updatedAt: now };
}

/** Next `order` value at the end of one group's ECU list (`groupId` null = ungrouped). */
function nextEcuOrder(v: DiagVehicleV1, groupId: string | null): number {
  let max = -1;
  for (const e of v.ecus) if (e.groupId === groupId && e.order > max) max = e.order;
  return max + 1;
}

function ecusOfGroupSorted(v: DiagVehicleV1, groupId: string | null): EcuRecordV1[] {
  return v.ecus.filter((e) => e.groupId === groupId).sort((a, b) => a.order - b.order);
}

export const diagWorkspaceStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** Persistence hook: called after every USER mutation (not after `load` / `reset`). */
  onMutation(listener: () => void): () => void {
    mutationListeners.add(listener);
    return () => {
      mutationListeners.delete(listener);
    };
  },

  getState(): DiagnosticsProjectV1 {
    return state;
  },

  /** Project load: replaces the whole state without marking the project dirty. */
  load(diagnostics: DiagnosticsProjectV1): void {
    state = diagnostics;
    emit();
  },

  /** New / closed project. */
  reset(): void {
    state = emptyState();
    emit();
  },

  getActiveVehicle(): DiagVehicleV1 | null {
    return state.vehicles.find((v) => v.id === state.activeVehicleId) ?? null;
  },

  findEcu(ecuId: string): { vehicle: DiagVehicleV1; ecu: EcuRecordV1 } | null {
    for (const vehicle of state.vehicles) {
      const ecu = vehicle.ecus.find((e) => e.id === ecuId);
      if (ecu) return { vehicle, ecu };
    }
    return null;
  },

  // ── Vehicles ──

  createVehicle(name: string): StoreResult<string> {
    const trimmed = name.trim();
    if (trimmed.length === 0) return err('empty_name');
    const finalName = uniqueName(trimmed, state.vehicles.map((v) => v.name));
    const v = newVehicle(finalName);
    commit({ ...state, vehicles: [...state.vehicles, v], activeVehicleId: v.id });
    return ok(v.id);
  },

  renameVehicle(id: string, name: string): StoreResult {
    const trimmed = name.trim();
    if (trimmed.length === 0) return err('empty_name');
    if (state.vehicles.some((v) => v.id !== id && normName(v.name) === normName(trimmed))) return err('duplicate_name');
    const r = withVehicle(id, (v) => ({ ...v, name: trimmed }));
    return r.ok ? ok(undefined) : r;
  },

  setVehicleNotes(id: string, notes: string): StoreResult {
    const r = withVehicle(id, (v) => ({ ...v, notes }));
    return r.ok ? ok(undefined) : r;
  },

  /** Removes the vehicle with all its groups, ECUs and bindings (the UI confirms first). */
  deleteVehicle(id: string): StoreResult {
    if (!findVehicle(id)) return err('not_found');
    const vehicles = state.vehicles.filter((v) => v.id !== id);
    const activeVehicleId =
      state.activeVehicleId === id ? (vehicles.length > 0 ? vehicles[0].id : null) : state.activeVehicleId;
    commit({ ...state, vehicles, activeVehicleId });
    return ok(undefined);
  },

  /** Selection is persisted (`activeVehicleId`) but is not a document change: no revision bump. */
  selectVehicle(id: string): StoreResult {
    if (!findVehicle(id)) return err('not_found');
    if (state.activeVehicleId === id) return ok(undefined);
    commit({ ...state, activeVehicleId: id });
    return ok(undefined);
  },

  // ── Groups ──

  createGroup(vehicleId: string, name: string, color: EcuGroupColor = 'slate'): StoreResult<string> {
    const trimmed = name.trim();
    if (trimmed.length === 0) return err('empty_name');
    const veh = findVehicle(vehicleId);
    if (!veh) return err('not_found');
    if (veh.groups.some((g) => normName(g.name) === normName(trimmed))) return err('duplicate_name');
    const group: EcuGroupV1 = {
      id: newId(),
      name: trimmed,
      color,
      order: veh.groups.reduce((m, g) => Math.max(m, g.order), -1) + 1,
    };
    const r = withVehicle(vehicleId, (v) => ({ ...v, groups: [...v.groups, group] }));
    return r.ok ? ok(group.id) : r;
  },

  renameGroup(vehicleId: string, groupId: string, name: string): StoreResult {
    const trimmed = name.trim();
    if (trimmed.length === 0) return err('empty_name');
    const veh = findVehicle(vehicleId);
    if (!veh || !veh.groups.some((g) => g.id === groupId)) return err('not_found');
    if (veh.groups.some((g) => g.id !== groupId && normName(g.name) === normName(trimmed))) return err('duplicate_name');
    const r = withVehicle(vehicleId, (v) => ({ ...v, groups: v.groups.map((g) => (g.id === groupId ? { ...g, name: trimmed } : g)) }));
    return r.ok ? ok(undefined) : r;
  },

  recolorGroup(vehicleId: string, groupId: string, color: EcuGroupColor): StoreResult {
    const veh = findVehicle(vehicleId);
    if (!veh || !veh.groups.some((g) => g.id === groupId)) return err('not_found');
    const r = withVehicle(vehicleId, (v) => ({ ...v, groups: v.groups.map((g) => (g.id === groupId ? { ...g, color } : g)) }));
    return r.ok ? ok(undefined) : r;
  },

  /** Moves the group to `newIndex` (0-based) and renumbers `order` 0..n-1. */
  reorderGroup(vehicleId: string, groupId: string, newIndex: number): StoreResult {
    const veh = findVehicle(vehicleId);
    if (!veh || !veh.groups.some((g) => g.id === groupId)) return err('not_found');
    const r = withVehicle(vehicleId, (v) => {
      const sorted = [...v.groups].sort((a, b) => a.order - b.order);
      const from = sorted.findIndex((g) => g.id === groupId);
      const [item] = sorted.splice(from, 1);
      sorted.splice(Math.max(0, Math.min(sorted.length, newIndex)), 0, item);
      return { ...v, groups: sorted.map((g, i) => ({ ...g, order: i })) };
    });
    return r.ok ? ok(undefined) : r;
  },

  /**
   * Deletes a group. A non-empty group needs an explicit `moveEcusTo` (`null` = ungrouped,
   * a group id = that group); `undefined` + members => `not_empty`, nothing changes.
   */
  deleteGroup(vehicleId: string, groupId: string, moveEcusTo?: string | null): StoreResult {
    const veh = findVehicle(vehicleId);
    if (!veh || !veh.groups.some((g) => g.id === groupId)) return err('not_found');
    const members = veh.ecus.filter((e) => e.groupId === groupId);
    if (members.length > 0) {
      if (moveEcusTo === undefined) return err('not_empty');
      if (moveEcusTo !== null && (moveEcusTo === groupId || !veh.groups.some((g) => g.id === moveEcusTo))) {
        return err('group_not_found');
      }
    }
    const r = withVehicle(vehicleId, (v, now) => {
      let order = nextEcuOrder({ ...v, ecus: v.ecus.filter((e) => e.groupId !== groupId) }, moveEcusTo ?? null);
      const ecus = v.ecus.map((e) => {
        if (e.groupId !== groupId) return e;
        return bumpEcu(e, now, { groupId: moveEcusTo ?? null, order: order++ });
      });
      return { ...v, groups: v.groups.filter((g) => g.id !== groupId), ecus };
    });
    return r.ok ? ok(undefined) : r;
  },

  // ── ECUs ──

  /** Adds an ECU (appended to its group). Semantic validation is the caller's job (`ecuValidation`). */
  createEcu(vehicleId: string, init: EcuRecordInit): StoreResult<string> {
    const veh = findVehicle(vehicleId);
    if (!veh) return err('not_found');
    const groupId = init.groupId !== undefined && veh.groups.some((g) => g.id === init.groupId) ? init.groupId : null;
    const ecu = newEcuRecord({ ...init, groupId, order: nextEcuOrder(veh, groupId) });
    const r = withVehicle(vehicleId, (v) => ({ ...v, ecus: [...v.ecus, ecu] }));
    return r.ok ? ok(ecu.id) : r;
  },

  /** Replaces the editable content of an ECU with `draft` (id / createdAt / order / revision are kept / bumped). */
  updateEcu(vehicleId: string, draft: EcuRecordV1): StoreResult {
    const veh = findVehicle(vehicleId);
    const cur = veh?.ecus.find((e) => e.id === draft.id);
    if (!veh || !cur) return err('not_found');
    const groupId = draft.groupId !== null && veh.groups.some((g) => g.id === draft.groupId) ? draft.groupId : null;
    const order = groupId === cur.groupId ? cur.order : nextEcuOrder(veh, groupId);
    const r = withVehicle(vehicleId, (v, now) => ({
      ...v,
      ecus: v.ecus.map((e) =>
        e.id === draft.id
          ? bumpEcu({ ...cloneRecord(draft), id: cur.id, createdAt: cur.createdAt, revision: cur.revision }, now, { groupId, order })
          : e,
      ),
    }));
    return r.ok ? ok(undefined) : r;
  },

  /** Copy with a new id, a unique name ("X (2)"), revision 1, source `manual`, appended to the same group. */
  duplicateEcu(vehicleId: string, ecuId: string): StoreResult<string> {
    const veh = findVehicle(vehicleId);
    const src = veh?.ecus.find((e) => e.id === ecuId);
    if (!veh || !src) return err('not_found');
    const copy = newEcuRecord({
      ...cloneRecord(src),
      id: newId(),
      name: uniqueName(src.name, veh.ecus.map((e) => e.name)),
      order: nextEcuOrder(veh, src.groupId),
      source: 'manual',
      revision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const r = withVehicle(vehicleId, (v) => ({ ...v, ecus: [...v.ecus, copy] }));
    return r.ok ? ok(copy.id) : r;
  },

  /** Bindings that deleting this ECU would remove (the UI lists them in its confirmation). */
  bindingsOfEcu(vehicleId: string, ecuId: string): FlowBindingV1[] {
    return findVehicle(vehicleId)?.bindings.filter((b) => b.ecuId === ecuId) ?? [];
  },

  /** Removes the ECU AND its bindings. Returns the number of removed bindings. */
  deleteEcu(vehicleId: string, ecuId: string): StoreResult<number> {
    const veh = findVehicle(vehicleId);
    if (!veh || !veh.ecus.some((e) => e.id === ecuId)) return err('not_found');
    const removed = veh.bindings.filter((b) => b.ecuId === ecuId).length;
    const r = withVehicle(vehicleId, (v) => ({
      ...v,
      ecus: v.ecus.filter((e) => e.id !== ecuId),
      bindings: v.bindings.filter((b) => b.ecuId !== ecuId),
    }));
    return r.ok ? ok(removed) : r;
  },

  /** Moves the ECU to another group (`null` = ungrouped), appended at its end. */
  moveEcuToGroup(vehicleId: string, ecuId: string, groupId: string | null): StoreResult {
    const veh = findVehicle(vehicleId);
    const cur = veh?.ecus.find((e) => e.id === ecuId);
    if (!veh || !cur) return err('not_found');
    if (groupId !== null && !veh.groups.some((g) => g.id === groupId)) return err('group_not_found');
    if (cur.groupId === groupId) return ok(undefined);
    const r = withVehicle(vehicleId, (v, now) => ({
      ...v,
      ecus: v.ecus.map((e) => (e.id === ecuId ? bumpEcu(e, now, { groupId, order: nextEcuOrder(v, groupId) }) : e)),
    }));
    return r.ok ? ok(undefined) : r;
  },

  /** Moves the ECU to `newIndex` inside its own group and renumbers that group's `order` 0..n-1. */
  reorderEcu(vehicleId: string, ecuId: string, newIndex: number): StoreResult {
    const veh = findVehicle(vehicleId);
    const cur = veh?.ecus.find((e) => e.id === ecuId);
    if (!veh || !cur) return err('not_found');
    const r = withVehicle(vehicleId, (v, now) => {
      const sorted = ecusOfGroupSorted(v, cur.groupId);
      const from = sorted.findIndex((e) => e.id === ecuId);
      const [item] = sorted.splice(from, 1);
      sorted.splice(Math.max(0, Math.min(sorted.length, newIndex)), 0, item);
      const orders = new Map(sorted.map((e, i) => [e.id, i] as const));
      return {
        ...v,
        ecus: v.ecus.map((e) => {
          const o = orders.get(e.id);
          if (o === undefined || o === e.order) return e;
          return bumpEcu(e, now, { order: o });
        }),
      };
    });
    return r.ok ? ok(undefined) : r;
  },

  /** Appends imported groups + ECUs (already re-id'd / de-clashed by `ecuExchange`). */
  appendImported(vehicleId: string, groups: readonly EcuGroupV1[], ecus: readonly EcuRecordV1[]): StoreResult {
    const r = withVehicle(vehicleId, (v) => ({ ...v, groups: [...v.groups, ...groups], ecus: [...v.ecus, ...ecus] }));
    return r.ok ? ok(undefined) : r;
  },

  // ── Bindings (stored only in A1, no UI) ──

  addBinding(vehicleId: string, binding: Omit<FlowBindingV1, 'id' | 'order'>): StoreResult<string> {
    const veh = findVehicle(vehicleId);
    if (!veh) return err('not_found');
    if (!veh.ecus.some((e) => e.id === binding.ecuId)) return err('not_found');
    const b: FlowBindingV1 = {
      ...binding,
      id: newId(),
      order: veh.bindings.reduce((m, x) => Math.max(m, x.order), -1) + 1,
    };
    const r = withVehicle(vehicleId, (v) => ({ ...v, bindings: [...v.bindings, b] }));
    return r.ok ? ok(b.id) : r;
  },

  removeBinding(vehicleId: string, bindingId: string): StoreResult {
    const veh = findVehicle(vehicleId);
    if (!veh || !veh.bindings.some((b) => b.id === bindingId)) return err('not_found');
    const r = withVehicle(vehicleId, (v) => ({ ...v, bindings: v.bindings.filter((b) => b.id !== bindingId) }));
    return r.ok ? ok(undefined) : r;
  },
};

export function useDiagWorkspace(): DiagnosticsProjectV1 {
  return useSyncExternalStore(diagWorkspaceStore.subscribe, diagWorkspaceStore.getState, diagWorkspaceStore.getState);
}

/** Active vehicle of a state snapshot (`null` when none). */
export function selectActiveVehicle(s: DiagnosticsProjectV1): DiagVehicleV1 | null {
  return s.vehicles.find((v) => v.id === s.activeVehicleId) ?? null;
}

/** Display name of a registry ECU (`null` when `ecuId` is null or the record no longer exists). */
export function useEcuName(ecuId: string | null): string | null {
  const get = (): string | null => (ecuId === null ? null : (diagWorkspaceStore.findEcu(ecuId)?.ecu.name ?? null));
  return useSyncExternalStore(diagWorkspaceStore.subscribe, get, get);
}
