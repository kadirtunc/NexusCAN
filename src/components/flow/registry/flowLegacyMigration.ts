/**
 * One-time migration of the pre-registry diagram list (`localStorage` `nexuscan:flow_diagrams:v1`) into the flow
 * library as `nexuscan.flow` revision 1 (origin `user`). The old key is never modified (backup). The marker
 * `nexuscan:flow_registry_migrated:v1` is set only when EVERY diagram was migrated; a partial failure is reported
 * and retried on the next start (already migrated diagrams are recognised through a legacy-id -> uuid map).
 */
import { parseFlowLibError, type FlowVariableDeclV1, type FlowVariableType } from '../../../types/flowLibrary';
import { LEGACY_FLOW_STORAGE_KEY } from '../FlowStore';
import type { FlowBlock, FlowConnection, FlowDiagram } from '../types';
import { migrateAll } from '../flowMigrate';
import { buildFlowFile, toFlowBody, type FlowMeta } from './flowBody';
import type { FlowLibClient } from './flowLibClient';

export const FLOW_REGISTRY_MIGRATED_KEY = 'nexuscan:flow_registry_migrated:v1';
export const FLOW_REGISTRY_MIGRATED_IDS_KEY = 'nexuscan:flow_registry_migrated_ids:v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LegacyMigrationReport {
  /** Marker was already set: nothing was done. */
  skipped: boolean;
  migrated: number;
  /** Diagrams recognised as migrated by an earlier (partial) run. */
  alreadyDone: number;
  failed: Array<{ name: string; message: string }>;
  /** Localized notes of the variable / start migration (per diagram). */
  notes: string[];
}

export interface LegacyMigrationDeps {
  now?: () => Date;
  uuid?: () => string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toDiagram(raw: unknown): FlowDiagram | null {
  if (!isObj(raw) || !Array.isArray(raw['blocks']) || !Array.isArray(raw['connections'])) return null;
  const blocks: FlowBlock[] = [];
  for (const b of raw['blocks']) {
    if (!isObj(b) || typeof b['id'] !== 'string' || typeof b['type'] !== 'string') return null;
    blocks.push({
      id: b['id'],
      type: b['type'],
      label: typeof b['label'] === 'string' ? b['label'] : b['type'],
      x: typeof b['x'] === 'number' ? b['x'] : 0,
      y: typeof b['y'] === 'number' ? b['y'] : 0,
      config: isObj(b['config']) ? b['config'] : {},
      status: 'idle',
      collapsed: b['collapsed'] === true,
    });
  }
  const connections: FlowConnection[] = [];
  for (const c of raw['connections']) {
    if (!isObj(c) || typeof c['id'] !== 'string' || typeof c['fromBlockId'] !== 'string' || typeof c['fromPortId'] !== 'string'
      || typeof c['toBlockId'] !== 'string' || typeof c['toPortId'] !== 'string') return null;
    connections.push({ id: c['id'], fromBlockId: c['fromBlockId'], fromPortId: c['fromPortId'], toBlockId: c['toBlockId'], toPortId: c['toPortId'] });
  }
  const variables: FlowVariableDeclV1[] = Array.isArray(raw['variables'])
    ? raw['variables'].filter(isObj).map((v) => ({
        name: String(v['name'] ?? ''),
        type: (v['type'] === 'text' || v['type'] === 'bool' || v['type'] === 'bytes' ? v['type'] : 'number') as FlowVariableType,
        initial: typeof v['initial'] === 'string' ? v['initial'] : '',
      }))
    : [];
  return {
    id: typeof raw['id'] === 'string' ? raw['id'] : '',
    name: typeof raw['name'] === 'string' && raw['name'].trim() !== '' ? raw['name'] : 'Flow',
    blocks,
    connections,
    variables,
  };
}

function readIdMap(storage: StorageLike): Record<string, string> {
  try {
    const v: unknown = JSON.parse(storage.getItem(FLOW_REGISTRY_MIGRATED_IDS_KEY) ?? '{}');
    if (!isObj(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, id] of Object.entries(v)) if (typeof id === 'string') out[k] = id;
    return out;
  } catch {
    return {};
  }
}

export async function migrateLegacyDiagrams(
  storage: StorageLike,
  client: FlowLibClient,
  deps: LegacyMigrationDeps = {},
): Promise<LegacyMigrationReport> {
  const report: LegacyMigrationReport = { skipped: false, migrated: 0, alreadyDone: 0, failed: [], notes: [] };
  if (storage.getItem(FLOW_REGISTRY_MIGRATED_KEY) !== null) return { ...report, skipped: true };
  const now = deps.now ?? ((): Date => new Date());
  const uuid = deps.uuid ?? ((): string => globalThis.crypto.randomUUID());

  let list: unknown[] = [];
  const rawText = storage.getItem(LEGACY_FLOW_STORAGE_KEY);
  if (rawText !== null) {
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (Array.isArray(parsed)) list = parsed;
      else report.failed.push({ name: LEGACY_FLOW_STORAGE_KEY, message: 'not a list' });
    } catch (e) {
      report.failed.push({ name: LEGACY_FLOW_STORAGE_KEY, message: e instanceof Error ? e.message : String(e) });
    }
  }

  const idMap = readIdMap(storage);
  for (let i = 0; i < list.length; i++) {
    const diagram = toDiagram(list[i]);
    const label = isObj(list[i]) && typeof (list[i] as Record<string, unknown>)['name'] === 'string'
      ? String((list[i] as Record<string, unknown>)['name'])
      : `#${i + 1}`;
    if (!diagram) {
      report.failed.push({ name: label, message: 'invalid diagram' });
      continue;
    }
    const legacyId = diagram.id !== '' ? diagram.id : `#${i}`;
    const alreadyMapped = idMap[legacyId] !== undefined;
    const id = idMap[legacyId] ?? uuid();
    if (!alreadyMapped) {
      // Reserve the uuid BEFORE saving so a crash between save and bookkeeping cannot create a duplicate.
      idMap[legacyId] = id;
      storage.setItem(FLOW_REGISTRY_MIGRATED_IDS_KEY, JSON.stringify(idMap));
    }
    try {
      const migrated = migrateAll({ ...diagram, id });
      for (const n of migrated.notes) report.notes.push(`${diagram.name}: ${n}`);
      const iso = now().toISOString();
      const meta: FlowMeta = {
        id, revision: 1, description: '', createdAt: iso, updatedAt: iso, author: null, origin: 'user', aiReviewed: true, tags: [],
      };
      const file = await buildFlowFile('nexuscan.flow', toFlowBody(migrated.diagram, meta));
      await client.save(JSON.stringify(file));
      report.migrated += 1;
    } catch (e) {
      if (parseFlowLibError(e)?.code === 'conflict') {
        // r1 of this uuid already exists: an earlier run saved it.
        report.alreadyDone += 1;
      } else {
        report.failed.push({ name: diagram.name, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  if (report.failed.length === 0) storage.setItem(FLOW_REGISTRY_MIGRATED_KEY, now().toISOString());
  return report;
}
