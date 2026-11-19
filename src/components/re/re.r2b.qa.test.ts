/**
 * QA gate probes (written BEFORE implementation) for RE Toolkit R2b "Save found signals to DBC"
 * (planning/contracts/re-toolkit-v1.md §7.1, §7.4, §7.5 frontend items). Pure: no Tauri, no DOM, no stores.
 * Run: `npm run test:re-r2b-qa` (from the repo root).
 *
 * ============================================================================================
 * ASSUMPTION BLOCK (authoritative TS API)
 * ============================================================================================
 * `src/types/reDraft.ts` (exactly §7.1; byte order reuses `ReByteOrder` from `src/types/re.ts`):
 *   export type ReSignalValueType = 'unsigned' | 'signed' | 'float32' | 'float64';
 *   export interface ReSignalProvenanceDto { r: number | null; lagMs: number | null; reference: string | null;
 *     samples: number | null; createdAtMs: number }
 *   export interface ReValueTableEntryDto { value: number; label: string }
 *   export interface ReSignalDraftDto { id: string; bus: number; arbId: number; isExtended: boolean;
 *     messageName: string | null; dlcBytes: number; name: string; startBit: number; bitLength: number;
 *     byteOrder: ReByteOrder; valueType: ReSignalValueType; factor: number; offset: number; min: number; max: number;
 *     unit: string; comment: string; provenance: ReSignalProvenanceDto; valueTable: ReValueTableEntryDto[] }
 *   export interface ReDbcDiagnosticDto { severity: 'error' | 'warning'; draftId: string | null; code: string; message: string }
 *   export interface ReDbcGenerateResultDto { dbcText: string; diagnostics: ReDbcDiagnosticDto[]; messages: number; signals: number }
 *
 * `src/store/projectStore.ts`: `NexusProjectFileV1.reSignals?: ReSignalDraftDto[]` (additive, version stays 1).
 *
 * `src/components/re/reDraftSanitize.ts` (pure, never throws, never mutates input, returns fresh objects
 * with unknown keys stripped):
 *   export function sanitizeReDrafts(input: unknown): { drafts: ReSignalDraftDto[]; dropped: number };
 *   - input undefined / null              -> { drafts: [], dropped: 0 }
 *   - input not an array (object, string) -> { drafts: [], dropped: 1 }
 *   - entry dropped (+1) when structurally malformed: not an object; id not a non-empty string; bus not an integer
 *     0..255; arbId not an integer in 0..0x7FF (std) / 0..0x1FFFFFFF (ext); isExtended not boolean; dlcBytes not an
 *     integer 0..64; name not a string; startBit not an integer 0..511; bitLength not an integer 1..64; byteOrder /
 *     valueType not in the enum; factor / offset / min / max not finite numbers; messageName present but neither
 *     string nor null; unit / comment present but not strings; provenance present but malformed (r / lagMs /
 *     samples: finite number or null; reference: string or null; createdAtMs: finite number); valueTable present but
 *     not an array, or any entry not { value: integer, label: string }.
 *   - lenient defaults for MISSING optional fields: messageName -> null, unit -> '', comment -> '',
 *     valueTable -> [], provenance -> { r: null, lagMs: null, reference: null, samples: null, createdAtMs: 0 }
 *     (missing provenance sub-fields -> null / 0).
 *   - semantic problems are NOT the sanitizer's job (kept so the user can fix them; the generator reports them):
 *     invalid DBC identifier, factor 0, min > max, bits beyond dlcBytes, overlaps.
 *   - duplicate `id`: first occurrence kept, later ones dropped (+1 each).
 *
 * `src/components/re/reDraftModel.ts` (pure):
 *   export const RE_FOUND_DB_FILE_NAME = 'RE_found.dbc';
 *   export function reMessageName(arbId: number, isExtended: boolean): string;
 *     // std `RE_` + 3-digit uppercase hex, ext `RE_` + 8-digit uppercase hex (matches the Rust generator)
 *   export function defaultDraftName(messageName: string | null, arbId: number, isExtended: boolean,
 *     startBit: number): string;  // `${messageName ?? reMessageName(arbId, isExtended)}_sig${startBit}`
 *   export interface ReDraftPrefillInput {
 *     id: string; nowMs: number; target: ReTargetDto; dlcBytes: number;
 *     messageName: string | null;                  // message name in the loaded bus DB, if any
 *     row: ReCorrelationRowDto;
 *     observed: { min: number; max: number } | null; // observed physical range
 *     reference: { label: string; unit: string } | null; // e.g. { label: 'OBD 0x0D', unit: 'km/h' }
 *   }
 *   export function draftFromCorrelationRow(input: ReDraftPrefillInput): ReSignalDraftDto;
 *     // bit fields / factor / offset from row.candidate; draft.messageName = null (generator resolves);
 *     // name = defaultDraftName(...); min = Math.floor(observed.min), max = Math.ceil(observed.max)
 *     // (observed null or non-finite -> 0 / 0); unit = reference?.unit ?? ''; comment = '';
 *     // provenance = { r: row.r, lagMs: row.lagMs, reference: reference?.label ?? null, samples: row.samples,
 *     //   createdAtMs: nowMs }; valueTable = []
 *   export function reFoundDbRecord(dbcText: string): CustomDbFileRecord;
 *     // { fileName: RE_FOUND_DB_FILE_NAME, contentBase64: base64(UTF-8(dbcText)), sizeBytes: UTF-8 byte length }
 *   export function applyReFoundDb<T extends { fileName: string }>(catalog: readonly T[], entry: T): T[];
 *     // new array; every entry whose fileName.trim().toLowerCase() === 're_found.dbc' is removed and `entry`
 *     // takes the position of the first removed one (append if none); other entries kept by reference, in order;
 *     // input array never mutated; idempotent.
 * ============================================================================================
 */
import { sanitizeReDrafts } from './reDraftSanitize';
import {
  RE_FOUND_DB_FILE_NAME,
  applyReFoundDb,
  defaultDraftName,
  draftFromCorrelationRow,
  reFoundDbRecord,
  reMessageName,
} from './reDraftModel';
import type { ReSignalDraftDto } from '../../types/reDraft';
import type { ReCorrelationRowDto } from '../../types/re';
import type { NexusProjectFileV1 } from '../../store/projectStore';
import type { CustomDbFileRecord } from '../../store/databaseStore';

// ─── Probe harness ─────────────────────────────────────────────────────────────

let currentProbe = '';
const probeFailures = new Map<string, string[]>();
let totalChecks = 0;
const results: Array<{ name: string; ok: boolean }> = [];

function check(cond: boolean, msg: string, detail = ''): void {
  totalChecks += 1;
  if (cond) return;
  const list = probeFailures.get(currentProbe) ?? [];
  list.push(`${msg}${detail !== '' ? `\n      ${detail}` : ''}`);
  probeFailures.set(currentProbe, list);
}
/** JSON with object keys sorted, so key order produced by the implementation never matters. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) return val;
    const src = val as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = src[key];
    return out;
  });
}
function eqv(actual: unknown, expected: unknown, msg: string): void {
  const a = canon(actual);
  const e = canon(expected);
  check(a === e, msg, `expected: ${e}\n      actual:   ${a}`);
}
function probe(name: string, fn: () => void): void {
  currentProbe = name;
  probeFailures.set(name, []);
  try {
    fn();
  } catch (e) {
    check(false, 'probe threw', e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
  }
  const fails = probeFailures.get(name) ?? [];
  const ok = fails.length === 0;
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  for (const f of fails) console.log(`    - ${f}`);
}

interface NodeProcShim {
  exitCode?: number;
}
const proc = (globalThis as { process?: NodeProcShim }).process;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function validDraft(over: Partial<ReSignalDraftDto> = {}): ReSignalDraftDto {
  return {
    id: 'd-0001',
    bus: 0,
    arbId: 0x1a3,
    isExtended: false,
    messageName: null,
    dlcBytes: 8,
    name: 'RE_1A3_sig11',
    startBit: 11,
    bitLength: 12,
    byteOrder: 'motorola',
    valueType: 'signed',
    factor: 0.25,
    offset: -40,
    min: -100,
    max: 300,
    unit: 'km/h',
    comment: 'found "speed" \\ check',
    provenance: { r: 0.998, lagMs: 120, reference: 'OBD 0x0D', samples: 812, createdAtMs: 1763500000000 },
    valueTable: [
      { value: 0, label: 'Off' },
      { value: 1, label: 'On' },
    ],
    ...over,
  };
}

/** Plain JSON clone typed as unknown (what a project file read yields). */
function jsonClone(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v)) as unknown;
}

function withField(base: ReSignalDraftDto, key: string, value: unknown): Record<string, unknown> {
  const o = jsonClone(base) as Record<string, unknown>;
  o[key] = value;
  return o;
}

function withoutField(base: ReSignalDraftDto, key: string): Record<string, unknown> {
  const o = jsonClone(base) as Record<string, unknown>;
  delete o[key];
  return o;
}

function utf8FromBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ─── Probes ───────────────────────────────────────────────────────────────────

function main(): void {
  probe('sanitizer: missing / null / non-array input', () => {
    eqv(sanitizeReDrafts(undefined), { drafts: [], dropped: 0 }, 'undefined -> [] / 0');
    eqv(sanitizeReDrafts(null), { drafts: [], dropped: 0 }, 'null -> [] / 0');
    eqv(sanitizeReDrafts([]), { drafts: [], dropped: 0 }, '[] -> [] / 0');
    for (const bad of [{}, 'drafts', 42, true]) {
      const r = sanitizeReDrafts(bad);
      eqv(r.drafts, [], `${JSON.stringify(bad)} -> no drafts`);
      eqv(r.dropped, 1, `${JSON.stringify(bad)} -> dropped 1`);
    }
  });

  probe('sanitizer: valid draft passes unchanged (deep equal), fresh object', () => {
    const d = validDraft();
    const input: unknown = [jsonClone(d)];
    const before = JSON.stringify(input);
    const r = sanitizeReDrafts(input);
    eqv(r.dropped, 0, 'nothing dropped');
    eqv(r.drafts, [d], 'draft preserved exactly');
    eqv(JSON.stringify(input), before, 'input not mutated');
    const first = (input as unknown[])[0];
    check(r.drafts[0] !== first, 'output is a fresh object, not the input reference');
  });

  probe('sanitizer: drops structurally malformed entries and counts them', () => {
    const d = validDraft();
    const bad: Array<[string, unknown]> = [
      ['not an object (number)', 7],
      ['not an object (null)', null],
      ['not an object (array)', [1, 2]],
      ['id empty', withField(d, 'id', '')],
      ['id number', withField(d, 'id', 5)],
      ['bus 256', withField(d, 'bus', 256)],
      ['bus -1', withField(d, 'bus', -1)],
      ['bus 1.5', withField(d, 'bus', 1.5)],
      ['arbId > 0x7FF std', withField(d, 'arbId', 0x800)],
      ['arbId string', withField(d, 'arbId', '0x1A3')],
      ['isExtended string', withField(d, 'isExtended', 'false')],
      ['dlcBytes 65', withField(d, 'dlcBytes', 65)],
      ['name missing', withoutField(d, 'name')],
      ['name number', withField(d, 'name', 12)],
      ['startBit 512', withField(d, 'startBit', 512)],
      ['startBit missing', withoutField(d, 'startBit')],
      ['bitLength 0', withField(d, 'bitLength', 0)],
      ['bitLength 65', withField(d, 'bitLength', 65)],
      ['byteOrder bogus', withField(d, 'byteOrder', 'big')],
      ['valueType bogus', withField(d, 'valueType', 'float16')],
      ['factor null (NaN after JSON)', withField(d, 'factor', null)],
      ['offset string', withField(d, 'offset', '-40')],
      ['min missing', withoutField(d, 'min')],
      ['max null', withField(d, 'max', null)],
      ['messageName number', withField(d, 'messageName', 3)],
      ['unit number', withField(d, 'unit', 1)],
      ['comment object', withField(d, 'comment', {})],
      ['provenance string', withField(d, 'provenance', 'x')],
      ['provenance.r string', withField(d, 'provenance', { ...d.provenance, r: '0.9' })],
      ['provenance.createdAtMs missing-type', withField(d, 'provenance', { ...d.provenance, createdAtMs: 'now' })],
      ['valueTable object', withField(d, 'valueTable', { 0: 'Off' })],
      ['valueTable entry bad value', withField(d, 'valueTable', [{ value: 0.5, label: 'half' }])],
      ['valueTable entry bad label', withField(d, 'valueTable', [{ value: 1, label: 2 }])],
    ];
    for (const [label, entry] of bad) {
      const r = sanitizeReDrafts([entry]);
      check(r.drafts.length === 0 && r.dropped === 1, `${label} -> dropped`, JSON.stringify(r));
    }
    // mixed: 3 good + all bad -> 3 kept, count exact, order preserved
    const goods = [validDraft({ id: 'g1' }), validDraft({ id: 'g2', name: 'B' }), validDraft({ id: 'g3', name: 'C' })];
    const mixed: unknown[] = [goods[0], ...bad.map((b) => b[1]), goods[1], goods[2]];
    const r = sanitizeReDrafts(jsonClone(mixed));
    eqv(
      r.drafts.map((x) => x.id),
      ['g1', 'g2', 'g3'],
      'good drafts kept in order',
    );
    eqv(r.dropped, bad.length, 'dropped count = malformed entries');
  });

  probe('sanitizer: extended ids accept 29-bit range only when isExtended', () => {
    const ext = validDraft({ id: 'x', arbId: 0x1cffa0b1, isExtended: true });
    eqv(sanitizeReDrafts([ext]).drafts.length, 1, '29-bit ext kept');
    const tooBig = validDraft({ id: 'y', arbId: 0x20000000, isExtended: true });
    eqv(sanitizeReDrafts([tooBig]).dropped, 1, '> 29-bit dropped');
  });

  probe('sanitizer: lenient defaults for missing optional fields; unknown keys stripped', () => {
    const d = validDraft({ id: 'opt' });
    let o = withoutField(d, 'messageName');
    delete o.unit;
    delete o.comment;
    delete o.valueTable;
    delete o.provenance;
    o = { ...o, legacyJunk: 123 };
    const r = sanitizeReDrafts([o]);
    eqv(r.dropped, 0, 'not dropped');
    const got = r.drafts[0];
    check(got !== undefined, 'kept');
    if (got === undefined) return;
    eqv(got.messageName, null, 'messageName -> null');
    eqv(got.unit, '', 'unit -> ""');
    eqv(got.comment, '', 'comment -> ""');
    eqv(got.valueTable, [], 'valueTable -> []');
    eqv(got.provenance, { r: null, lagMs: null, reference: null, samples: null, createdAtMs: 0 }, 'provenance default');
    check(!Object.prototype.hasOwnProperty.call(got, 'legacyJunk'), 'unknown key stripped');
    const partialProv = withField(d, 'provenance', { r: 0.5, createdAtMs: 9 });
    eqv(
      sanitizeReDrafts([partialProv]).drafts[0]?.provenance,
      { r: 0.5, lagMs: null, reference: null, samples: null, createdAtMs: 9 },
      'missing provenance sub-fields -> null',
    );
  });

  probe('sanitizer: semantic problems kept for the user to fix (generator reports them)', () => {
    const odd = validDraft({ id: 'odd', name: '1 bad name', factor: 0, min: 10, max: 5, startBit: 60, bitLength: 16 });
    const r = sanitizeReDrafts([odd]);
    eqv(r.dropped, 0, 'not dropped');
    eqv(r.drafts, [odd], 'kept verbatim');
  });

  probe('sanitizer: duplicate ids -> first kept, later dropped', () => {
    const a = validDraft({ id: 'same', name: 'First' });
    const b = validDraft({ id: 'same', name: 'Second' });
    const c = validDraft({ id: 'other', name: 'Third' });
    const r = sanitizeReDrafts([a, b, c]);
    eqv(
      r.drafts.map((x) => x.name),
      ['First', 'Third'],
      'first occurrence wins',
    );
    eqv(r.dropped, 1, 'duplicate counted');
  });

  probe('project round-trip: JSON stringify/parse + sanitize preserves drafts', () => {
    const drafts: ReSignalDraftDto[] = [
      validDraft({ id: 'p1' }),
      validDraft({
        id: 'p2',
        arbId: 0x1cffa0b1,
        isExtended: true,
        messageName: 'BodyStatus',
        dlcBytes: 64,
        name: 'FdSig300',
        startBit: 300,
        bitLength: 32,
        byteOrder: 'intel',
        valueType: 'float32',
        factor: 1,
        offset: 0,
        unit: 'deg"C\\',
        comment: 'line1\nline2',
        provenance: { r: null, lagMs: null, reference: null, samples: null, createdAtMs: 1 },
        valueTable: [],
      }),
      validDraft({ id: 'p3', factor: 0.249998713, offset: -40.00012, min: -8231.123456789, max: 8150.987654321 }),
    ];
    const part: Pick<NexusProjectFileV1, 'reSignals'> = { reSignals: drafts };
    const text = JSON.stringify(part);
    const parsed = JSON.parse(text) as { reSignals?: unknown };
    const r = sanitizeReDrafts(parsed.reSignals);
    eqv(r.dropped, 0, 'nothing dropped');
    eqv(r.drafts, drafts, 'drafts identical after round-trip');
    check(r.drafts[2]?.factor === 0.249998713, 'factor exact (no rounding)');

    // older project without the key
    const legacy = JSON.parse(JSON.stringify({ version: 1, name: 'old' })) as { reSignals?: unknown };
    eqv(sanitizeReDrafts(legacy.reSignals), { drafts: [], dropped: 0 }, 'missing reSignals -> []');

    // NaN factor written by a buggy build serializes as null -> dropped with a count
    const nan = JSON.parse(JSON.stringify({ reSignals: [validDraft({ id: 'nan', factor: Number.NaN }), drafts[0]] })) as {
      reSignals?: unknown;
    };
    const rn = sanitizeReDrafts(nan.reSignals);
    eqv(rn.dropped, 1, 'NaN draft dropped');
    eqv(
      rn.drafts.map((x) => x.id),
      ['p1'],
      'the rest kept',
    );
  });

  probe('naming: reMessageName / defaultDraftName', () => {
    eqv(reMessageName(0x1a3, false), 'RE_1A3', 'std 0x1A3');
    eqv(reMessageName(0x00a, false), 'RE_00A', 'std padded to 3');
    eqv(reMessageName(0x7ff, false), 'RE_7FF', 'std max');
    eqv(reMessageName(0x1cffa0b1, true), 'RE_1CFFA0B1', 'ext');
    eqv(reMessageName(0x1a3, true), 'RE_000001A3', 'ext padded to 8');
    eqv(defaultDraftName(null, 0x1a3, false, 11), 'RE_1A3_sig11', 'no DB name');
    eqv(defaultDraftName('INV_MotorStatus', 0x101, false, 300), 'INV_MotorStatus_sig300', 'DB message name');
  });

  probe('prefill: draft from a correlation row', () => {
    const row: ReCorrelationRowDto = {
      candidate: { startBit: 7, bitLength: 16, byteOrder: 'motorola', valueType: 'unsigned', factor: 0.25, offset: -40 },
      r: 0.9991,
      r2: 0.9982,
      rmse: 0.12,
      samples: 812,
      lagMs: 120,
    };
    const d = draftFromCorrelationRow({
      id: 'new-1',
      nowMs: 1763500000123,
      target: { bus: 2, arbId: 0x1a3, isExtended: false },
      dlcBytes: 8,
      messageName: null,
      row,
      observed: { min: -12.3, max: 187.01 },
      reference: { label: 'OBD 0x0D', unit: 'km/h' },
    });
    const want: ReSignalDraftDto = {
      id: 'new-1',
      bus: 2,
      arbId: 0x1a3,
      isExtended: false,
      messageName: null,
      dlcBytes: 8,
      name: 'RE_1A3_sig7',
      startBit: 7,
      bitLength: 16,
      byteOrder: 'motorola',
      valueType: 'unsigned',
      factor: 0.25,
      offset: -40,
      min: -13,
      max: 188,
      unit: 'km/h',
      comment: '',
      provenance: { r: 0.9991, lagMs: 120, reference: 'OBD 0x0D', samples: 812, createdAtMs: 1763500000123 },
      valueTable: [],
    };
    eqv(d, want, 'prefilled draft');

    const named = draftFromCorrelationRow({
      id: 'new-2',
      nowMs: 5,
      target: { bus: 0, arbId: 0x1cffa0b1, isExtended: true },
      dlcBytes: 64,
      messageName: 'BodyStatus',
      row: { ...row, candidate: { ...row.candidate, startBit: 300, byteOrder: 'intel', valueType: 'signed' }, lagMs: -30 },
      observed: null,
      reference: null,
    });
    eqv(named.name, 'BodyStatus_sig300', 'DB message name used for the default signal name');
    eqv(named.messageName, null, 'messageName left null for the generator');
    eqv([named.min, named.max], [0, 0], 'no observation -> 0/0');
    eqv(named.unit, '', 'no reference -> empty unit');
    eqv(named.provenance.reference, null, 'no reference -> null');
    eqv(named.provenance.lagMs, -30, 'negative lag kept');
    eqv([named.isExtended, named.dlcBytes, named.valueType], [true, 64, 'signed'], 'target / candidate copied');

    const exact = draftFromCorrelationRow({
      id: 'new-3',
      nowMs: 0,
      target: { bus: 0, arbId: 0x10, isExtended: false },
      dlcBytes: 8,
      messageName: null,
      row,
      observed: { min: 0, max: 100 },
      reference: null,
    });
    eqv([exact.min, exact.max], [0, 100], 'integers stay as-is');
    const nonFinite = draftFromCorrelationRow({
      id: 'new-4',
      nowMs: 0,
      target: { bus: 0, arbId: 0x10, isExtended: false },
      dlcBytes: 8,
      messageName: null,
      row,
      observed: { min: Number.NEGATIVE_INFINITY, max: Number.NaN },
      reference: null,
    });
    eqv([nonFinite.min, nonFinite.max], [0, 0], 'non-finite observation -> 0/0');
    check(sanitizeReDrafts([d, named]).dropped === 0, 'prefilled drafts survive the sanitizer');
  });

  probe('Apply: reFoundDbRecord encodes UTF-8 base64 + size', () => {
    const text = 'VERSION "NexusCAN RE"\nCM_ SG_ 1 X "°C \\"q\\"" ;\n';
    const rec: CustomDbFileRecord = reFoundDbRecord(text);
    eqv(rec.fileName, RE_FOUND_DB_FILE_NAME, 'file name');
    eqv(RE_FOUND_DB_FILE_NAME, 'RE_found.dbc', 'constant');
    eqv(utf8FromBase64(rec.contentBase64), text, 'base64 decodes to the exact text');
    eqv(rec.sizeBytes, new TextEncoder().encode(text).length, 'sizeBytes = UTF-8 length');
  });

  probe('Apply: replaces previous RE_found.dbc, no duplicates, idempotent, user DBCs untouched', () => {
    interface Entry {
      fileName: string;
      contentBase64: string;
      tag: string;
    }
    const user1: Entry = { fileName: 'vehicle.dbc', contentBase64: 'AA==', tag: 'u1' };
    const user2: Entry = { fileName: 'bms.kcd', contentBase64: 'AQ==', tag: 'u2' };
    const oldRe: Entry = { fileName: 'RE_found.dbc', contentBase64: 'b2xk', tag: 'old' };
    const fresh: Entry = { fileName: 'RE_found.dbc', contentBase64: 'bmV3', tag: 'new' };

    const catalog: readonly Entry[] = Object.freeze([user1, oldRe, user2]);
    const once = applyReFoundDb(catalog, fresh);
    eqv(
      once.map((e) => e.tag),
      ['u1', 'new', 'u2'],
      'replaced in place',
    );
    check(once[0] === user1 && once[2] === user2, 'user entries kept by reference');
    eqv(
      catalog.map((e) => e.tag),
      ['u1', 'old', 'u2'],
      'input not mutated',
    );
    const twice = applyReFoundDb(once, fresh);
    eqv(twice, once, 'idempotent');
    eqv(twice.filter((e) => e.fileName === RE_FOUND_DB_FILE_NAME).length, 1, 'exactly one RE_found.dbc');

    const appended = applyReFoundDb([user1, user2], fresh);
    eqv(
      appended.map((e) => e.tag),
      ['u1', 'u2', 'new'],
      'appended when absent',
    );
    eqv(
      applyReFoundDb([], fresh).map((e) => e.tag),
      ['new'],
      'empty catalog',
    );

    const stale: Entry[] = [
      user1,
      { fileName: ' re_found.dbc ', contentBase64: '', tag: 'stale1' },
      user2,
      { fileName: 'RE_FOUND.DBC', contentBase64: '', tag: 'stale2' },
    ];
    eqv(
      applyReFoundDb(stale, fresh).map((e) => e.tag),
      ['u1', 'new', 'u2'],
      'case/space variants collapsed into one at the first position',
    );
    const lookalike: Entry = { fileName: 'RE_found_v2.dbc', contentBase64: '', tag: 'look' };
    eqv(
      applyReFoundDb([lookalike], fresh).map((e) => e.tag),
      ['look', 'new'],
      'similar user file names are not touched',
    );
  });

  const failed = results.filter((x) => !x.ok);
  console.log(`\nre.r2b.qa: ${results.length - failed.length}/${results.length} probes PASS (${totalChecks} checks)`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((x) => x.name).join(', ')}`);
    if (proc) proc.exitCode = 1;
  }
}

main();
