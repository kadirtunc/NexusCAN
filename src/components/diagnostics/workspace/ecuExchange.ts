/**
 * `.nexusecu.json` export / import (diag-workspace-v1 §7). Pure: file I/O lives in `fileIo.ts`.
 *
 * Export: one ECU (ungrouped in the file), one group with its ECUs, or a whole vehicle. Bindings are never exported.
 * Import: STRICT (any malformed entry rejects the whole file, unlike project load), ids are regenerated,
 * clashing group / ECU names get a " (2)" suffix, a `seedKeyProfileId` unknown locally is cleared and reported.
 */
import type {
  DiagVehicleV1,
  EcuGroupV1,
  EcuRecordV1,
  NexusEcuFileV1,
} from '../../../types/diagWorkspace';
import { sanitizeGroupsAndEcus, isRecord } from './diagnosticsSanitize';
import { cloneRecord, newId, nowIso, uniqueName } from './ecuDefaults';

export type EcuExportSelection =
  | { kind: 'ecu'; ecuId: string }
  | { kind: 'group'; groupId: string }
  | { kind: 'vehicle' };

export const ECU_FILE_EXTENSION = '.nexusecu.json';

/** Builds the export document; `null` when the selection does not exist in `vehicle`. */
export function buildEcuFile(vehicle: DiagVehicleV1, sel: EcuExportSelection, exportedAt: string = nowIso()): NexusEcuFileV1 | null {
  let groups: EcuGroupV1[] = [];
  let ecus: EcuRecordV1[] = [];
  if (sel.kind === 'ecu') {
    const e = vehicle.ecus.find((x) => x.id === sel.ecuId);
    if (!e) return null;
    ecus = [{ ...cloneRecord(e), groupId: null }];
  } else if (sel.kind === 'group') {
    const g = vehicle.groups.find((x) => x.id === sel.groupId);
    if (!g) return null;
    groups = [cloneRecord(g)];
    ecus = vehicle.ecus.filter((e) => e.groupId === g.id).map((e) => cloneRecord(e));
  } else {
    groups = vehicle.groups.map((g) => cloneRecord(g));
    ecus = vehicle.ecus.map((e) => cloneRecord(e));
  }
  return { schemaVersion: 1, kind: 'nexuscan.ecus', exportedAt, groups, ecus };
}

export function serializeEcuFile(file: NexusEcuFileV1): string {
  return JSON.stringify(file, null, 2);
}

/** Suggested download name for a selection. */
export function ecuFileName(vehicle: DiagVehicleV1, sel: EcuExportSelection): string {
  let base = vehicle.name;
  if (sel.kind === 'ecu') base = vehicle.ecus.find((e) => e.id === sel.ecuId)?.name ?? 'ecu';
  else if (sel.kind === 'group') base = vehicle.groups.find((g) => g.id === sel.groupId)?.name ?? 'group';
  const stem = base.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return `${stem.length > 0 ? stem : 'ecus'}${ECU_FILE_EXTENSION}`;
}

export interface EcuImportReport {
  /** Names (after renaming) of imported groups / ECUs that received a " (n)" suffix. */
  renamedGroups: string[];
  renamedEcus: string[];
  /** Profiles that do not exist locally and were cleared. */
  clearedSeedKeyProfiles: { ecuName: string; profileId: string }[];
}

export type EcuImportResult =
  | { ok: true; groups: EcuGroupV1[]; ecus: EcuRecordV1[]; report: EcuImportReport }
  | { ok: false; error: string; problems: string[] };

/**
 * Validates and prepares an import into `target` (does not modify it). The caller appends the result with
 * `diagWorkspaceStore.appendImported`.
 */
export function prepareEcuImport(
  raw: unknown,
  target: DiagVehicleV1,
  knownSeedKeyProfileIds: ReadonlySet<string>,
): EcuImportResult {
  const bad = (error: string, problems: string[] = [error]): EcuImportResult => ({ ok: false, error, problems });
  if (!isRecord(raw)) return bad('not a JSON object');
  if (raw['kind'] !== 'nexuscan.ecus') return bad('not a NexusCAN ECU file (kind)');
  if (raw['schemaVersion'] !== 1) return bad('unsupported schemaVersion');
  if (!Array.isArray(raw['ecus']) || (raw['groups'] !== undefined && !Array.isArray(raw['groups']))) {
    return bad('groups / ecus must be arrays');
  }
  const problems: string[] = [];
  const parsed = sanitizeGroupsAndEcus(raw['groups'], raw['ecus'], 'file', problems);
  if (problems.length > 0) return bad(problems[0], problems);
  if (parsed.ecus.length === 0) return bad('file contains no ECUs');

  const now = nowIso();
  const report: EcuImportReport = { renamedGroups: [], renamedEcus: [], clearedSeedKeyProfiles: [] };

  const takenGroups = target.groups.map((g) => g.name);
  const maxGroupOrder = target.groups.reduce((m, g) => Math.max(m, g.order), -1);
  const groupIdMap = new Map<string, string>();
  const groups: EcuGroupV1[] = parsed.groups
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((g, i) => {
      const name = uniqueName(g.name, takenGroups);
      if (name !== g.name.trim()) report.renamedGroups.push(name);
      takenGroups.push(name);
      const id = newId();
      groupIdMap.set(g.id, id);
      return { id, name, color: g.color, order: maxGroupOrder + 1 + i };
    });

  const takenEcus = target.ecus.map((e) => e.name);
  const nextOrder = new Map<string | null, number>();
  const orderFor = (groupId: string | null): number => {
    if (!nextOrder.has(groupId)) {
      let max = -1;
      for (const e of target.ecus) if (e.groupId === groupId && e.order > max) max = e.order;
      nextOrder.set(groupId, max + 1);
    }
    const n = nextOrder.get(groupId) ?? 0;
    nextOrder.set(groupId, n + 1);
    return n;
  };

  const ecus: EcuRecordV1[] = parsed.ecus.map((e) => {
    const name = uniqueName(e.name, takenEcus);
    if (name !== e.name.trim()) report.renamedEcus.push(name);
    takenEcus.push(name);
    const groupId = e.groupId === null ? null : (groupIdMap.get(e.groupId) ?? null);
    let profile = e.security.seedKeyProfileId;
    if (profile !== null && !knownSeedKeyProfileIds.has(profile)) {
      report.clearedSeedKeyProfiles.push({ ecuName: name, profileId: profile });
      profile = null;
    }
    return {
      ...cloneRecord(e),
      id: newId(),
      name,
      groupId,
      order: orderFor(groupId),
      source: 'import',
      security: { ...cloneRecord(e.security), seedKeyProfileId: profile },
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
  });

  return { ok: true, groups, ecus, report };
}
