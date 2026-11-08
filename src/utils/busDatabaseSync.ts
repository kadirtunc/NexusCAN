import { databaseStore, makeCatalogDbId, type ProjectDatabaseEntry } from '../store/databaseStore';
import { connectionStore } from '../store/connectionStore';
import { apiGetPresetDatabaseFiles, apiParseDatabaseSchema, apiSetBusDatabases } from '../services/ipcClient';
import type { DbFileInputDto } from '../types/hal';
import { transmitStore } from '../store/transmitStore';
import { plotStore } from '../store/plotStore';

export async function ensureMockPresetDatabasesLoaded(): Promise<string[]> {
  try {
    const files = await apiGetPresetDatabaseFiles();
    const catalog = databaseStore.getState().databases;
    const ids: string[] = [];

    for (const f of files) {
      const id = makeCatalogDbId(f.fileName);
      ids.push(id);

      const existing = catalog.find((d) => d.id === id);
      if (!existing) {
        try {
          const schema = await apiParseDatabaseSchema(f.fileName, f.contentBase64);
          const entry: ProjectDatabaseEntry = {
            id,
            name: f.fileName.replace(/\.[^/.]+$/, ''),
            fileName: f.fileName,
            format: f.fileName.toLowerCase().endsWith('.kcd') ? 'kcd' : 'dbc',
            contentBase64: f.contentBase64,
            sizeBytes: Math.round((f.contentBase64.length * 3) / 4),
            uploadedAt: new Date().toISOString(),
            schema,
          };
          databaseStore.upsertDatabaseEntry(entry);
        } catch (err) {
          console.warn(`[busDatabaseSync] Failed to parse preset ${f.fileName}:`, err);
        }
      }
    }
    return ids;
  } catch (err) {
    console.warn('[busDatabaseSync] Failed to fetch preset database files:', err);
    return ['db:sample_vehicle.dbc', 'db:sample_bms.kcd'];
  }
}

const MAX_DESKTOP_BUSES = 8;

/** Per-bus signature of the bound files (ids + payload length) used to skip redundant backend calls. */
function computeBusSignature(busId: number): string {
  const profile = connectionStore.getState().profiles.find((p) => p.busId === busId);
  if (!profile || !Array.isArray(profile.databaseIds) || profile.databaseIds.length === 0) {
    return '';
  }
  const catalog = databaseStore.getState().databases;
  const parts: string[] = [];
  for (const id of profile.databaseIds) {
    const entry = catalog.find((d) => d.id === id);
    if (entry) parts.push(`${entry.id}#${entry.contentBase64.length}`);
  }
  return parts.join('|');
}

function collectBusFiles(busId: number): DbFileInputDto[] {
  const profile = connectionStore.getState().profiles.find((p) => p.busId === busId);
  if (!profile || !Array.isArray(profile.databaseIds)) return [];
  const catalog = databaseStore.getState().databases;
  const files: DbFileInputDto[] = [];
  for (const id of profile.databaseIds) {
    const entry = catalog.find((d) => d.id === id);
    if (entry && entry.contentBase64.length > 0) {
      files.push({ fileName: entry.fileName, contentBase64: entry.contentBase64 });
    }
  }
  return files;
}

const appliedSignatures = new Map<number, string>();
let inFlight: Promise<void> | null = null;
let rerunRequested = false;
let forceNext = false;

async function runSyncPass(force: boolean): Promise<void> {
  let changed = false;
  for (let busId = 0; busId < MAX_DESKTOP_BUSES; busId++) {
    const sig = computeBusSignature(busId);
    if (!force && appliedSignatures.get(busId) === sig) continue;
    changed = true;
    try {
      const schema = await apiSetBusDatabases(busId, collectBusFiles(busId));
      databaseStore.setBusSchema(busId, schema);
      appliedSignatures.set(busId, sig);
    } catch (err) {
      console.warn(`[busDatabaseSync] Bus ${busId + 1} database binding failed:`, err);
      databaseStore.setBusSchema(busId, null);
      appliedSignatures.delete(busId);
    }
  }
  if (changed) {
    // Re-resolve symbolic TX rows and plotted signals against the freshly bound per-bus schemas
    const resolver = (busId: number) => databaseStore.getBusSchema(busId);
    transmitStore.hydrateWithSchema(resolver);
    plotStore.rebindWithSchema(resolver);
  }
}

/**
 * Synchronizes the databases bound to each connection profile (busId 0..7) with the Rust HAL
 * (`cmd_set_bus_databases`) and mirrors the compiled per-bus schema into `databaseStore.busSchemas`.
 * Calls are serialized: overlapping requests coalesce into one trailing pass (last state wins).
 */
export function syncAllBusDatabasesWithBackend(options?: { force?: boolean }): Promise<void> {
  if (options?.force) forceNext = true;
  if (inFlight) {
    rerunRequested = true;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      do {
        rerunRequested = false;
        const force = forceNext;
        forceNext = false;
        await runSyncPass(force);
      } while (rerunRequested);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

let autoSyncInstalled = false;
let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-binds bus databases automatically whenever the catalog or any profile's `databaseIds` change
 * (debounced 120 ms). Idempotent.
 */
export function installBusDatabaseAutoSync(): void {
  if (autoSyncInstalled) return;
  autoSyncInstalled = true;
  let lastKey = '';
  const check = (): void => {
    let key = '';
    for (let busId = 0; busId < MAX_DESKTOP_BUSES; busId++) {
      key += `${busId}:${computeBusSignature(busId)};`;
    }
    if (key === lastKey) return;
    lastKey = key;
    if (autoSyncTimer !== null) clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(() => {
      autoSyncTimer = null;
      void syncAllBusDatabasesWithBackend();
    }, 120);
  };
  connectionStore.subscribe(check);
  databaseStore.subscribe(check);
}
