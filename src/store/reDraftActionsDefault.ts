/** Real wiring of `ReDraftActionDeps` (Tauri/bridge generator, databaseStore, connectionStore, bus sync, file save). */
import { reDbcGenerate } from '../services/reClient';
import { apiParseDatabaseSchema } from '../services/ipcClient';
import { syncAllBusDatabasesWithBackend } from '../utils/busDatabaseSync';
import { downloadTextFile } from '../components/diagnostics/workspace/fileIo';
import { databaseStore } from './databaseStore';
import { connectionStore } from './connectionStore';
import { projectStore } from './projectStore';
import { reDebugLogger } from './reDebugLog';
import type { ReDraftActionDeps } from './reDraftActions';

export const defaultReDraftActionDeps: ReDraftActionDeps = {
  generate: reDbcGenerate,
  parseSchema: apiParseDatabaseSchema,
  getCatalog: () => databaseStore.getState().databases,
  setCatalog: (entries) => databaseStore.setDatabasesCatalog(entries),
  getBusProfiles: (bus) =>
    connectionStore
      .getState()
      .profiles.filter((p) => p.busId === bus)
      .map((p) => ({ id: p.id, databaseIds: p.databaseIds })),
  setProfileDatabases: (id, ids) => connectionStore.setProfileDatabases(id, ids),
  // force: the bus signature only hashes the payload length, a regenerated RE_found.dbc can keep the same length
  syncBuses: () => syncAllBusDatabasesWithBackend({ force: true }),
  markDirty: () => projectStore.markDirty(),
  saveFile: (fileName, text) => downloadTextFile(fileName, text, 'text/plain;charset=utf-8'),
  nowIso: () => new Date().toISOString(),
  log: reDebugLogger,
};
