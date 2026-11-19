/**
 * RE found-signal actions (re-toolkit-v1 §7.4): Apply to bus, Export .dbc, Merge into DBC. All DBC text comes from the
 * backend generator (`cmd_re_dbc_generate`); this module only wires it to the catalog / bus sync / save path.
 * Dependencies are injectable so the flows are unit-testable without Tauri. Functions never throw: they return a
 * result union and mirror failures into the Debug console (category `RE`).
 */
import type { DatabaseSchemaDto } from '../types/netdb';
import type { ReDbcDiagnosticDto, ReDbcGenerateResultDto, ReSignalDraftDto } from '../types/reDraft';
import { applyReFoundDb, base64ToUtf8, mergedFileName, reFoundDbRecord, RE_FOUND_DB_FILE_NAME } from '../components/re/reDraftModel';
import { makeCatalogDbId, type ProjectDatabaseEntry } from './databaseStore';
import type { ReLogger } from './reDebugLog';

export interface ReDraftActionDeps {
  generate(drafts: readonly ReSignalDraftDto[], base: { fileName: string; contentBase64: string } | null): Promise<ReDbcGenerateResultDto>;
  parseSchema(fileName: string, contentBase64: string): Promise<DatabaseSchemaDto>;
  getCatalog(): readonly ProjectDatabaseEntry[];
  setCatalog(entries: readonly ProjectDatabaseEntry[]): void;
  /** profiles bound to the bus: id + current database ids */
  getBusProfiles(bus: number): readonly { id: string; databaseIds: readonly string[] }[];
  setProfileDatabases(profileId: string, databaseIds: readonly string[]): void;
  syncBuses(): Promise<void>;
  markDirty(): void;
  saveFile(fileName: string, text: string): void;
  nowIso(): string;
  log: ReLogger;
}

export type ReActionFailure = { ok: false; error: string; diagnostics: ReDbcDiagnosticDto[] };

export interface ReGenerated {
  ok: true;
  result: ReDbcGenerateResultDto;
  warnings: ReDbcDiagnosticDto[];
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function hasErrors(diags: readonly ReDbcDiagnosticDto[]): boolean {
  return diags.some((d) => d.severity === 'error');
}

/** Runs the generator; failure when the backend errors, reports an `error` diagnostic, or returns empty text. */
export async function generateChecked(
  deps: ReDraftActionDeps,
  action: 're.dbc_generate' | 're.draft_apply' | 're.draft_export' | 're.draft_merge',
  drafts: readonly ReSignalDraftDto[],
  base: { fileName: string; contentBase64: string } | null,
): Promise<ReGenerated | ReActionFailure> {
  let result: ReDbcGenerateResultDto;
  try {
    result = await deps.generate(drafts, base);
  } catch (e) {
    deps.log.error(action, 'RE DBC generate failed', e, `drafts=${drafts.length} base=${base?.fileName ?? 'none'}`);
    return { ok: false, error: errMsg(e), diagnostics: [] };
  }
  if (hasErrors(result.diagnostics) || (result.dbcText === '' && drafts.length > 0)) {
    const first = result.diagnostics.find((d) => d.severity === 'error');
    const msg = first === undefined ? 'generator returned no output' : `${first.code}: ${first.message}`;
    deps.log.error(action, 'RE DBC generate reported errors', new Error(msg), `drafts=${drafts.length}`);
    return { ok: false, error: msg, diagnostics: result.diagnostics };
  }
  return { ok: true, result, warnings: result.diagnostics.filter((d) => d.severity === 'warning') };
}

export type ReApplyOutcome =
  | { ok: true; result: ReDbcGenerateResultDto; warnings: ReDbcDiagnosticDto[]; boundProfiles: number; schemaOk: boolean }
  | ReActionFailure;

/** Apply to bus: drafts of `bus` -> standalone text -> catalog `RE_found.dbc` (replace) -> bind to the bus profiles -> sync. */
export async function applyDraftsToBus(deps: ReDraftActionDeps, drafts: readonly ReSignalDraftDto[], bus: number): Promise<ReApplyOutcome> {
  const mine = drafts.filter((d) => d.bus === bus);
  if (mine.length === 0) return { ok: false, error: 'no drafts for this bus', diagnostics: [] };
  const gen = await generateChecked(deps, 're.draft_apply', mine, null);
  if (!gen.ok) return gen;

  const rec = reFoundDbRecord(gen.result.dbcText);
  let schema: DatabaseSchemaDto | null = null;
  try {
    schema = await deps.parseSchema(rec.fileName, rec.contentBase64);
  } catch (e) {
    deps.log.error('re.draft_apply', 'RE_found.dbc schema parse failed', e);
  }
  const entry: ProjectDatabaseEntry = {
    id: makeCatalogDbId(RE_FOUND_DB_FILE_NAME),
    name: RE_FOUND_DB_FILE_NAME.replace(/\.[^/.]+$/, ''),
    fileName: rec.fileName,
    format: 'dbc',
    contentBase64: rec.contentBase64,
    sizeBytes: rec.sizeBytes ?? 0,
    uploadedAt: deps.nowIso(),
    schema,
  };
  deps.setCatalog(applyReFoundDb(deps.getCatalog(), entry));

  let bound = 0;
  for (const p of deps.getBusProfiles(bus)) {
    if (!p.databaseIds.includes(entry.id)) deps.setProfileDatabases(p.id, [...p.databaseIds, entry.id]);
    bound += 1;
  }
  try {
    await deps.syncBuses();
  } catch (e) {
    deps.log.error('re.draft_apply', 'bus database sync failed', e, `bus=${bus}`);
  }
  deps.markDirty();
  return { ok: true, result: gen.result, warnings: gen.warnings, boundProfiles: bound, schemaOk: schema !== null };
}

export type ReExportOutcome = { ok: true; fileName: string; result: ReDbcGenerateResultDto; warnings: ReDbcDiagnosticDto[] } | ReActionFailure;

/** Export .dbc: standalone text of `drafts` -> save-file path. */
export async function exportDrafts(deps: ReDraftActionDeps, drafts: readonly ReSignalDraftDto[], fileName = RE_FOUND_DB_FILE_NAME): Promise<ReExportOutcome> {
  if (drafts.length === 0) return { ok: false, error: 'no drafts', diagnostics: [] };
  const gen = await generateChecked(deps, 're.draft_export', drafts, null);
  if (!gen.ok) return gen;
  deps.saveFile(fileName, gen.result.dbcText);
  return { ok: true, fileName, result: gen.result, warnings: gen.warnings };
}

export interface ReMergePlan {
  ok: true;
  /** NEW file name, never the original */
  fileName: string;
  result: ReDbcGenerateResultDto;
  /** `base_lossy` etc. shown to the user before saving */
  warnings: ReDbcDiagnosticDto[];
}

/** Merge step 1: generate with the catalog DB's original content as base (nothing saved yet). */
export async function planMerge(deps: ReDraftActionDeps, drafts: readonly ReSignalDraftDto[], dbId: string): Promise<ReMergePlan | ReActionFailure> {
  const src = deps.getCatalog().find((d) => d.id === dbId);
  if (src === undefined || src.contentBase64.length === 0) {
    return { ok: false, error: 'original DBC content is not available', diagnostics: [] };
  }
  if (drafts.length === 0) return { ok: false, error: 'no drafts', diagnostics: [] };
  const gen = await generateChecked(deps, 're.draft_merge', drafts, { fileName: src.fileName, contentBase64: src.contentBase64 });
  if (!gen.ok) return gen;
  return { ok: true, fileName: mergedFileName(src.fileName), result: gen.result, warnings: gen.warnings };
}

/** Merge step 2: save under the planned (new) name. Refuses a name equal to the original. */
export function saveMerge(deps: ReDraftActionDeps, plan: ReMergePlan, originalFileName: string): { ok: true } | { ok: false; error: string } {
  if (plan.fileName.trim().toLowerCase() === originalFileName.trim().toLowerCase()) {
    return { ok: false, error: 'refusing to overwrite the original file' };
  }
  deps.saveFile(plan.fileName, plan.result.dbcText);
  return { ok: true };
}

/** Utility for UI hints: decodes catalog text for preview (UTF-8). */
export function catalogText(entry: Pick<ProjectDatabaseEntry, 'contentBase64'>): string {
  return base64ToUtf8(entry.contentBase64);
}
