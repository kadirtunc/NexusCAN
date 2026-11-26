/**
 * Desktop host adapter for the DBC editor: IPC validation (Rust parser) + `databaseStore` persistence.
 * Replaces the Cloud API client / Cloud store. Never mutates the store except in the two save functions.
 */
import { apiParseDatabaseSchema } from '../../services/ipcClient';
import {
  databaseStore,
  makeCatalogDbId,
  type ProjectDatabaseEntry,
} from '../../store/databaseStore';
import { syncAllBusDatabasesWithBackend } from '../../utils/busDatabaseSync';
import type { DatabaseSchemaDto } from './contracts';

export interface EditorDatabaseSource {
  databaseId: string;
  name: string;
  fileName: string;
  format: 'dbc' | 'kcd';
  /** Decoded (UTF-8) content of the stored file (KCD XML for `.kcd` sources). */
  dbcText: string;
  schema: DatabaseSchemaDto;
}

const BASE64_CHUNK = 0x8000;

function utf8ToBase64(text: string): { base64: string; byteLength: number } {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return { base64: btoa(binary), byteLength: bytes.length };
}

function base64ToUtf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function findEntry(databaseId: string): ProjectDatabaseEntry {
  const entry = databaseStore
    .getState()
    .databases.find((d) => d.id === databaseId);
  if (!entry) throw new Error(`Database not found: ${databaseId}`);
  return entry;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export async function loadEditorDatabase(
  databaseId: string,
): Promise<EditorDatabaseSource> {
  const entry = findEntry(databaseId);
  const schema =
    entry.schema ??
    (await apiParseDatabaseSchema(entry.fileName, entry.contentBase64));
  return {
    databaseId: entry.id,
    name: entry.name,
    fileName: entry.fileName,
    format: entry.format,
    dbcText: base64ToUtf8(entry.contentBase64),
    schema,
  };
}

/** Validation = Rust parser via `cmd_parse_database_schema`; never mutates the store. */
export async function validateDbcText(
  fileName: string,
  dbcText: string,
): Promise<
  { ok: true; schema: DatabaseSchemaDto } | { ok: false; error: string }
> {
  try {
    const schema = await apiParseDatabaseSchema(
      fileName,
      utf8ToBase64(dbcText).base64,
    );
    return { ok: true, schema };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

async function persistEntry(
  entry: ProjectDatabaseEntry,
  rebindBuses: boolean,
): Promise<ProjectDatabaseEntry> {
  databaseStore.upsertDatabaseEntry(entry);
  if (rebindBuses) {
    try {
      await syncAllBusDatabasesWithBackend({ force: true });
    } catch (err: unknown) {
      console.warn('[dbc-editor] bus database re-bind failed:', err);
    }
  }
  return entry;
}

async function buildEntry(
  id: string,
  name: string,
  fileName: string,
  dbcText: string,
): Promise<ProjectDatabaseEntry> {
  const { base64, byteLength } = utf8ToBase64(dbcText);
  // Rust parser is the safety net: refuse to persist text it cannot compile.
  const schema = await apiParseDatabaseSchema(fileName, base64);
  return {
    id,
    name,
    fileName,
    format: 'dbc',
    contentBase64: base64,
    sizeBytes: byteLength,
    uploadedAt: new Date().toISOString(),
    schema,
  };
}

/**
 * SAVE (overwrite): same id. A `.kcd` source is never overwritten with DBC text -> it is a Save As
 * to `<name>.dbc` (must not collide with a different existing entry).
 */
export async function saveDatabaseOverwrite(
  databaseId: string,
  dbcText: string,
): Promise<ProjectDatabaseEntry> {
  const current = findEntry(databaseId);
  if (current.format === 'kcd') {
    return saveDatabaseAs(`${current.name}.dbc`, dbcText);
  }
  const entry = await buildEntry(
    current.id,
    current.name,
    current.fileName,
    dbcText,
  );
  return persistEntry(entry, true);
}

/**
 * SAVE AS: new `<name>.dbc`; id = `makeCatalogDbId(fileName)`.
 * Refuses to silently replace an existing entry unless it is `options.allowOverwriteId`.
 */
export async function saveDatabaseAs(
  fileName: string,
  dbcText: string,
  options?: { allowOverwriteId?: string },
): Promise<ProjectDatabaseEntry> {
  const trimmed = fileName.trim();
  if (!trimmed || /[\\/:*?"<>|]/.test(trimmed)) {
    throw new Error(`Invalid file name: ${fileName}`);
  }
  const stem = trimmed.replace(/\.(dbc|kcd)$/i, '');
  if (!stem) throw new Error(`Invalid file name: ${fileName}`);
  const finalName = `${stem}.dbc`;
  const id = makeCatalogDbId(finalName);
  const existing = databaseStore
    .getState()
    .databases.find((d) => d.id === id);
  if (existing && existing.id !== options?.allowOverwriteId) {
    throw new Error(`A database named ${finalName} already exists.`);
  }
  const entry = await buildEntry(id, stem, finalName, dbcText);
  return persistEntry(entry, existing !== undefined);
}
