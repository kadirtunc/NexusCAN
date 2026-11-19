/** RE Toolkit R2b frontend tests: form model, draft store, series range, apply / export / merge flows with fake deps. Run: `npm run test:re-r2b`. */
import { createReDraftStore } from '../../store/reDraftStore';
import {
  applyDraftsToBus, exportDrafts, hasErrors, planMerge, saveMerge, type ReDraftActionDeps,
} from '../../store/reDraftActions';
import { makeCatalogDbId, type ProjectDatabaseEntry } from '../../store/databaseStore';
import { NOOP_RE_LOGGER, createReLogger } from '../../store/reDebugLog';
import { draftFromForm, formFromDraft, lengthForValueType } from './reDraftForm';
import { base64ToUtf8, draftFromCandidate, mergedFileName, RE_FOUND_DB_FILE_NAME, seriesRange } from './reDraftModel';
import type { ReDbcGenerateResultDto, ReSignalDraftDto } from '../../types/reDraft';
import type { ReSeries } from '../../types/re';
import type { DatabaseSchemaDto } from '../../types/netdb';

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function mk(over: Partial<ReSignalDraftDto> = {}): ReSignalDraftDto {
  return {
    id: 'a', bus: 0, arbId: 0x1a3, isExtended: false, messageName: null, dlcBytes: 8, name: 'RE_1A3_sig7', startBit: 7,
    bitLength: 16, byteOrder: 'motorola', valueType: 'unsigned', factor: 0.25, offset: -40, min: 0, max: 100, unit: 'km/h',
    comment: '', provenance: { r: 0.99, lagMs: 10, reference: 'OBD 0x0D', samples: 5, createdAtMs: 1 }, valueTable: [], ...over,
  };
}

// ---- form model
{
  const d = mk({ valueTable: [{ value: 1, label: 'On' }] });
  const f = formFromDraft(d);
  const back = draftFromForm(d, f);
  check('form round-trip', JSON.stringify(back.draft) === JSON.stringify(d));
  const bad = draftFromForm(d, { ...f, factor: 'abc', startBit: '1.5', valueTable: [{ value: 'x', label: '' }] });
  check('form invalid fields reported', bad.draft === null && bad.invalid.join() === 'startBit,factor,valueTable', bad.invalid.join());
  const comma = draftFromForm(d, { ...f, factor: '0,5', messageName: '  Msg ' });
  check('decimal comma + message trim', comma.draft?.factor === 0.5 && comma.draft.messageName === 'Msg');
  check('empty message name -> null', draftFromForm(d, { ...f, messageName: ' ' }).draft?.messageName === null);
  check('float forces length', lengthForValueType('float32', '12') === '32' && lengthForValueType('float64', '12') === '64' && lengthForValueType('signed', '12') === '12');
}

// ---- store
{
  const s = createReDraftStore();
  let muts = 0;
  s.onMutation(() => { muts += 1; });
  s.load([mk({ id: 'a' }), mk({ id: 'b', name: 'B' })]);
  check('load is silent (no dirty)', muts === 0 && s.getState().drafts.length === 2);
  s.upsert(mk({ id: 'a', name: 'A2' }));
  check('upsert replaces + dirty', muts === 1 && s.getState().drafts[0].name === 'A2' && s.getState().drafts.length === 2);
  s.upsert(mk({ id: 'c', name: 'C' }));
  check('upsert appends', s.getState().drafts.length === 3 && muts === 2);
  s.setSelected(['a', 'c']);
  s.remove(['a']);
  check('remove drops draft + selection', s.getState().drafts.map((d) => d.id).join() === 'b,c' && [...s.getState().selected].join() === 'c' && muts === 3);
  s.remove(['zzz']);
  check('remove unknown id is a no-op', muts === 3);
  s.openEditor(mk({ id: 'new' }));
  check('editor new flag', s.getState().editingIsNew);
  s.openEditor(mk({ id: 'b' }));
  check('editor existing flag', !s.getState().editingIsNew);
  s.closeEditor();
  s.reset();
  check('reset clears', s.getState().drafts.length === 0 && muts === 3);
}

// ---- series range / candidate prefill
{
  const series: ReSeries = {
    seriesCount: 2, pointsMax: 3, fromUs: 0,
    series: [
      { kind: 'candidate', index: 0, points: { tUsRel: new Float64Array([0, 1, 2]), min: new Float64Array([5, -2.5, 3]), max: new Float64Array([6, 0, 9.5]) } },
      { kind: 'reference', index: 0, points: { tUsRel: new Float64Array(0), min: new Float64Array(0), max: new Float64Array(0) } },
    ],
  };
  const r = seriesRange(series, 'candidate', 0);
  check('series range', r?.min === -2.5 && r.max === 9.5);
  check('empty / missing series -> null', seriesRange(series, 'reference', 0) === null && seriesRange(null, 'candidate', 0) === null && seriesRange(series, 'candidate', 3) === null);
  const cand = { startBit: 7, bitLength: 16, byteOrder: 'motorola' as const, valueType: 'unsigned' as const, factor: 0.5, offset: 1 };
  const d = draftFromCandidate({ id: 'x', nowMs: 9, target: { bus: 1, arbId: 0x10, isExtended: false }, dlcBytes: 8, messageName: 'M', candidate: cand, matchingRow: null, observed: r, reference: { label: '', unit: 'V' } });
  check('manual candidate: no r/lag/samples, no empty reference', d.provenance.r === null && d.provenance.lagMs === null && d.provenance.samples === null && d.provenance.reference === null);
  check('manual candidate: name/range/unit', d.name === 'M_sig7' && d.min === -3 && d.max === 10 && d.unit === 'V' && d.factor === 0.5);
  const m = draftFromCandidate({ id: 'y', nowMs: 9, target: { bus: 1, arbId: 0x10, isExtended: false }, dlcBytes: 8, messageName: null, candidate: cand, matchingRow: { candidate: cand, r: 0.97, r2: 0.9, rmse: 1, samples: 40, lagMs: -20 }, observed: null, reference: { label: 'OBD 0x0C', unit: 'rpm' } });
  check('matching row provenance kept', m.provenance.r === 0.97 && m.provenance.lagMs === -20 && m.provenance.samples === 40 && m.provenance.reference === 'OBD 0x0C');
  check('mergedFileName', mergedFileName('vehicle.dbc') === 'vehicle_re.dbc' && mergedFileName('a.b.kcd') === 'a.b_re.dbc' && mergedFileName('.dbc') === 'merged_re.dbc');
}

// ---- action flows with fake deps
interface Fake {
  deps: ReDraftActionDeps;
  catalog: ProjectDatabaseEntry[];
  profiles: { id: string; busId: number; databaseIds: string[] }[];
  saved: { fileName: string; text: string }[];
  calls: { drafts: number; base: string | null }[];
  syncs: number;
  dirty: number;
  logged: string[];
}
function fake(gen: (drafts: readonly ReSignalDraftDto[], base: { fileName: string; contentBase64: string } | null) => ReDbcGenerateResultDto): Fake {
  const f: Fake = {
    catalog: [], profiles: [{ id: 'p0', busId: 0, databaseIds: ['db:vehicle.dbc'] }, { id: 'p1', busId: 1, databaseIds: [] }],
    saved: [], calls: [], syncs: 0, dirty: 0, logged: [], deps: undefined as unknown as ReDraftActionDeps,
  };
  const log = createReLogger({ emit: (e) => { f.logged.push(`${e.category}:${e.action}`); }, nowMs: () => 0 });
  f.deps = {
    generate: async (d, b) => { f.calls.push({ drafts: d.length, base: b?.fileName ?? null }); return gen(d, b); },
    parseSchema: async () => ({ messages: [] } as unknown as DatabaseSchemaDto),
    getCatalog: () => f.catalog,
    setCatalog: (e) => { f.catalog = [...e]; },
    getBusProfiles: (bus) => f.profiles.filter((p) => p.busId === bus),
    setProfileDatabases: (id, ids) => { const p = f.profiles.find((x) => x.id === id); if (p) p.databaseIds = [...ids]; },
    syncBuses: async () => { f.syncs += 1; },
    markDirty: () => { f.dirty += 1; },
    saveFile: (fileName, text) => { f.saved.push({ fileName, text }); },
    nowIso: () => '2026-01-01T00:00:00Z',
    log,
  };
  return f;
}
const okGen = (text: string) => (): ReDbcGenerateResultDto => ({ dbcText: text, diagnostics: [], messages: 1, signals: 1 });
const user = (fileName: string, content: string): ProjectDatabaseEntry => ({
  id: makeCatalogDbId(fileName), name: fileName, fileName, format: 'dbc', contentBase64: btoa(content), sizeBytes: content.length, uploadedAt: '', schema: null,
});

async function flows(): Promise<void> {
  // apply: replaces, no duplicates, user DBCs stay, binds both times, forces sync
  {
    const f = fake(okGen('VERSION "x"\n'));
    f.catalog = [user('vehicle.dbc', 'U')];
    const drafts = [mk({ id: '1' }), mk({ id: '2', bus: 1 })];
    const o1 = await applyDraftsToBus(f.deps, drafts, 0);
    check('apply ok', o1.ok && o1.boundProfiles === 1);
    check('apply only drafts of the bus', f.calls[0].drafts === 1 && f.calls[0].base === null);
    check('apply keeps user DB + appends RE_found', f.catalog.map((e) => e.fileName).join() === `vehicle.dbc,${RE_FOUND_DB_FILE_NAME}`);
    check('apply content = generator text', base64ToUtf8(f.catalog[1].contentBase64) === 'VERSION "x"\n' && f.catalog[1].schema !== null);
    check('apply binds bus profile once', f.profiles[0].databaseIds.join() === 'db:vehicle.dbc,db:re_found.dbc' && f.syncs === 1 && f.dirty === 1);
    await applyDraftsToBus(f.deps, drafts, 0);
    check('re-apply: still one RE_found, one binding', f.catalog.filter((e) => e.fileName === RE_FOUND_DB_FILE_NAME).length === 1 && f.profiles[0].databaseIds.length === 2 && f.syncs === 2);
    const o3 = await applyDraftsToBus(f.deps, drafts, 1);
    check('apply bus 1 replaces catalog entry, binds p1', o3.ok && f.catalog.length === 2 && f.profiles[1].databaseIds.join() === 'db:re_found.dbc');
    const none = await applyDraftsToBus(f.deps, drafts, 5);
    check('apply bus without drafts fails', !none.ok);
  }
  // apply: no profile -> catalog only, reported
  {
    const f = fake(okGen('T'));
    f.profiles = [];
    const o = await applyDraftsToBus(f.deps, [mk()], 0);
    check('apply without profile: ok but unbound', o.ok && o.boundProfiles === 0 && f.catalog.length === 1);
  }
  // apply: generator error diagnostic -> nothing touched
  {
    const f = fake(() => ({ dbcText: '', diagnostics: [{ severity: 'error', draftId: 'a', code: 'overlap', message: 'x' }], messages: 0, signals: 0 }));
    f.catalog = [user('vehicle.dbc', 'U')];
    const o = await applyDraftsToBus(f.deps, [mk()], 0);
    check('apply blocked by error diag', !o.ok && f.catalog.length === 1 && f.syncs === 0 && f.dirty === 0);
    check('error diag mirrored to Debug console RE', f.logged.includes('RE:re.draft_apply'));
    check('hasErrors', hasErrors([{ severity: 'error', draftId: null, code: 'c', message: '' }]) && !hasErrors([{ severity: 'warning', draftId: null, code: 'c', message: '' }]));
  }
  // backend rejects ([re:invalid]) -> failure + RE log, no throw
  {
    const f = fake(() => { throw new Error('[re:invalid] drafts[0] bad'); });
    const o = await exportDrafts(f.deps, [mk()]);
    check('backend error: no throw, RE log', !o.ok && o.error.includes('[re:invalid]') && f.logged.includes('RE:re.draft_export') && f.saved.length === 0);
  }
  // export: text equals generator output
  {
    const f = fake(okGen('EXPORT-TEXT'));
    const o = await exportDrafts(f.deps, [mk()]);
    check('export saves generator text under RE_found.dbc', o.ok && f.saved.length === 1 && f.saved[0].text === 'EXPORT-TEXT' && f.saved[0].fileName === RE_FOUND_DB_FILE_NAME);
    check('export of nothing refused', !(await exportDrafts(f.deps, [])).ok);
  }
  // merge: base passed, warnings surfaced, NEW file, never the original name
  {
    const f = fake(() => ({ dbcText: 'MERGED', diagnostics: [{ severity: 'warning', draftId: null, code: 'base_lossy', message: 'lossy' }], messages: 1, signals: 1 }));
    f.catalog = [user('vehicle.dbc', 'ORIG'), { ...user('empty.dbc', ''), contentBase64: '' }];
    const plan = await planMerge(f.deps, [mk()], 'db:vehicle.dbc');
    check('merge plan ok with base_lossy warning', plan.ok && plan.fileName === 'vehicle_re.dbc' && plan.warnings[0]?.code === 'base_lossy' && f.calls[0].base === 'vehicle.dbc');
    check('plan alone saves nothing', f.saved.length === 0);
    if (plan.ok) {
      check('save merge writes new file', saveMerge(f.deps, plan, 'vehicle.dbc').ok && f.saved[0].fileName === 'vehicle_re.dbc' && f.saved[0].text === 'MERGED');
      check('save refuses original name', !saveMerge(f.deps, { ...plan, fileName: 'Vehicle.DBC' }, 'vehicle.dbc').ok && f.saved.length === 1);
    }
    check('merge without original content refused', !(await planMerge(f.deps, [mk()], 'db:empty.dbc')).ok && !(await planMerge(f.deps, [mk()], 'db:nope.dbc')).ok);
  }
  void NOOP_RE_LOGGER;
}

void flows().then(() => {
  console.log(`re.r2b: ${checks - failures}/${checks} checks PASS`);
  if (failures > 0) (globalThis as { process?: { exitCode?: number } }).process!.exitCode = 1;
});
