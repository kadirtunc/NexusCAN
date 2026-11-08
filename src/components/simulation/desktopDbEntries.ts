import type { DatabaseSchemaDto } from '../../types/netdb';
import type { DatabaseVersionDto, NetworkDatabaseSummaryDto } from '../../types/simulation';
import type { SavedConnectionProfile } from '../../store/connectionStore';
import type { ProjectDatabaseEntry } from '../../store/databaseStore';
import type { LoadedSimulationDatabaseEntry } from './virtualCanPacking';

/**
 * Builders turning desktop catalog files / Cloud database rows into
 * `LoadedSimulationDatabaseEntry` items for the multi-DBC simulation workbench.
 */
export function makeDatabaseEntry(params: {
  id: string;
  name: string;
  fileName: string;
  schema: DatabaseSchemaDto;
  busId: number;
  busLabel: string;
  sizeBytes?: number;
  createdAt?: string;
}): LoadedSimulationDatabaseEntry {
  const fmt: 'dbc' | 'kcd' = params.fileName.toLowerCase().endsWith('.kcd') ? 'kcd' : 'dbc';
  const verId = `${params.id}::v1`;
  const version: DatabaseVersionDto = {
    id: verId,
    databaseId: params.id,
    projectId: 'local',
    versionLabel: params.schema.info.version || 'v1.0',
    versionNumber: 1,
    fileName: params.fileName,
    format: fmt,
    sha256Hash: '',
    sizeBytes: params.sizeBytes ?? 0,
    messageCount: params.schema.messages.length,
    signalCount: params.schema.signals.length,
    ecuCount: params.schema.ecus.length,
    releaseNotes: null,
    uploadedByName: 'Desktop',
    createdAt: params.createdAt ?? new Date().toISOString(),
  };
  const db: NetworkDatabaseSummaryDto = {
    id: params.id,
    projectId: 'local',
    name: params.name,
    slug: params.id.replace(/[^a-z0-9-]+/gi, '-').toLowerCase(),
    format: fmt,
    description: `${params.schema.messages.length} mesaj, ${params.schema.signals.length} sinyal`,
    busAssignment: params.busLabel,
    latestVersion: version,
    versionCount: 1,
  };
  return { db, version, schema: params.schema, inferredBusId: params.busId };
}

/**
 * Desktop catalog -> simulation entries. Bus assignment comes from the connection profiles
 * that bind each database (first bound bus wins; unbound databases default to CAN0).
 */
export function buildLocalCatalogEntries(
  catalog: readonly ProjectDatabaseEntry[],
  profiles: readonly SavedConnectionProfile[],
): LoadedSimulationDatabaseEntry[] {
  const out: LoadedSimulationDatabaseEntry[] = [];
  for (const entry of catalog) {
    if (!entry.schema) continue;
    const bound = profiles
      .filter((p) => p.databaseIds.includes(entry.id))
      .sort((x, y) => x.busId - y.busId);
    const primary = bound[0];
    const busId = primary?.busId ?? 0;
    const busLabel = primary
      ? `CAN${busId} · Bus ${busId + 1} (${primary.adapterChannel || primary.name})`
      : 'CAN0 · bağlantıya bağlı değil';
    out.push(
      makeDatabaseEntry({
        id: entry.id,
        name: entry.name,
        fileName: entry.fileName,
        schema: entry.schema,
        busId,
        busLabel,
        sizeBytes: entry.sizeBytes,
        createdAt: entry.uploadedAt,
      }),
    );
  }
  return out;
}

