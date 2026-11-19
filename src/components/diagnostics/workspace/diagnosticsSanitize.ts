/**
 * Shape sanitizer for `NexusProjectFileV1.diagnostics` and `.nexusecu.json` (diag-workspace-v1 §3 / §7).
 * Project files are untrusted input: this module NEVER throws. Valid vehicles / groups / ECUs are kept,
 * malformed entries are dropped with a problem message. Semantic rules (ranges, collisions) are NOT checked
 * here - that is `ecuValidation.ts` (a record with a bad value is kept so the user can fix it).
 */
import {
  DIAG_PROTOCOLS,
  ECU_GROUP_COLORS,
  EMPTY_DIAGNOSTICS,
  type DiagProtocol,
  type DiagVehicleV1,
  type DiagnosticsProjectV1,
  type EcuAddressingV1,
  type EcuDidFormat,
  type EcuDidV1,
  type EcuFlashParamsV1,
  type EcuGroupColor,
  type EcuGroupV1,
  type EcuIdentificationV1,
  type EcuMemoryRegionV1,
  type EcuRecordV1,
  type EcuRoutineV1,
  type EcuSecurityLevelV1,
  type EcuSecurityV1,
  type EcuSource,
  type EcuTimingV1,
  type EcuVarV1,
  type FlowBindingParamValue,
  type FileExpectV1,
  type FlowBindingV1,
} from '../../../types/diagWorkspace';
import { ADDRESS_FORMATS, type AddressFormat } from '../../../types/udsClient';
import {
  defaultAddressing,
  defaultFlash,
  defaultIdentification,
  defaultTiming,
  nowIso,
} from './ecuDefaults';
import { normalizeFileExpect } from './ecuValidation';

export const MAX_VEHICLES = 64;
export const MAX_GROUPS = 128;
export const MAX_ECUS = 512;
export const MAX_BINDINGS = 4096;
export const MAX_LEVELS = 32;
export const MAX_ROUTINES = 64;
export const MAX_REGIONS = 64;
export const MAX_DIDS = 256;
export const MAX_VARS = 128;
const MAX_STR = 512;
const MAX_NOTES = 65536;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const EDID_FORMATS: readonly EcuDidFormat[] = ['ascii', 'hex', 'uint', 'int', 'bcd'];
const SOURCES: readonly EcuSource[] = ['manual', 'discovery', 'import'];

type Rec = Record<string, unknown>;

export function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback: string, max = MAX_STR): string {
  return typeof v === 'string' ? v.slice(0, max) : fallback;
}

function nonEmptyStr(v: unknown, max = MAX_STR): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.slice(0, max) : null;
}

function int(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

function nullableInt(v: unknown, fallback: number | null): number | null {
  if (v === null) return null;
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

function nullableStr(v: unknown): string | null {
  return typeof v === 'string' ? v.slice(0, MAX_STR) : null;
}

function iso(v: unknown): string {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : nowIso();
}

function revision(v: unknown): number {
  const n = int(v, 1);
  return n >= 1 ? n : 1;
}

/** Collection of `max` entries; a non-array is reported, an overlong array truncated. */
function list(v: unknown, max: number, where: string, problems: string[]): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    problems.push(`${where}: expected an array`);
    return [];
  }
  if (v.length > max) {
    problems.push(`${where}: ${v.length} entries, only the first ${max} kept`);
    return v.slice(0, max);
  }
  return v;
}

function sub(v: unknown, where: string, problems: string[]): Rec {
  if (v === undefined || v === null) return {};
  if (!isRecord(v)) {
    problems.push(`${where}: expected an object, defaults used`);
    return {};
  }
  return v;
}

// ── ECU sub-records ──────────────────────────────────────────────────────────

function sanitizeAddressingBlock(raw: Rec, where: string, problems: string[]): EcuAddressingV1 | null {
  const d = defaultAddressing();
  const req = raw['requestId'];
  const resp = raw['responseId'];
  if (typeof req !== 'number' || !Number.isFinite(req) || typeof resp !== 'number' || !Number.isFinite(resp)) {
    problems.push(`${where}.addressing: requestId / responseId must be numbers`);
    return null;
  }
  const fmt = ADDRESS_FORMATS.find((f) => f === raw['addressFormat']);
  const addressFormat: AddressFormat = fmt ?? d.addressFormat;
  if (raw['addressFormat'] !== undefined && fmt === undefined) {
    problems.push(`${where}.addressing.addressFormat: unknown value, 'normal' used`);
  }
  return {
    requestId: Math.trunc(req),
    responseId: Math.trunc(resp),
    isExtendedId: raw['isExtendedId'] === true,
    functionalId: nullableInt(raw['functionalId'], null),
    addressFormat,
    targetAddress: nullableInt(raw['targetAddress'], null),
    responseAddress: nullableInt(raw['responseAddress'], null),
    padding: raw['padding'] === undefined ? d.padding : nullableInt(raw['padding'], d.padding),
    useFd: raw['useFd'] === true,
  };
}

function sanitizeTiming(raw: Rec): EcuTimingV1 {
  const d = defaultTiming();
  return { p2MarginMs: int(raw['p2MarginMs'], d.p2MarginMs), keepaliveIntervalMs: int(raw['keepaliveIntervalMs'], d.keepaliveIntervalMs) };
}

function sanitizeSecurity(raw: Rec, where: string, problems: string[]): EcuSecurityV1 {
  const levels: EcuSecurityLevelV1[] = [];
  list(raw['levels'], MAX_LEVELS, `${where}.security.levels`, problems).forEach((l, i) => {
    if (!isRecord(l) || typeof l['key'] !== 'string' || typeof l['level'] !== 'number' || !Number.isFinite(l['level'])) {
      problems.push(`${where}.security.levels[${i}]: dropped (malformed)`);
      return;
    }
    levels.push({ key: l['key'].slice(0, 64), label: str(l['label'], ''), level: Math.trunc(l['level']) });
  });
  const pid = raw['seedKeyProfileId'];
  return { seedKeyProfileId: typeof pid === 'string' && pid.length > 0 ? pid.slice(0, 128) : null, levels };
}

function sanitizeRoutines(v: unknown, where: string, problems: string[]): EcuRoutineV1[] {
  const out: EcuRoutineV1[] = [];
  list(v, MAX_ROUTINES, `${where}.routines`, problems).forEach((r, i) => {
    if (!isRecord(r) || typeof r['key'] !== 'string' || typeof r['rid'] !== 'string') {
      problems.push(`${where}.routines[${i}]: dropped (malformed)`);
      return;
    }
    out.push({ key: r['key'].slice(0, 64), label: str(r['label'], ''), rid: r['rid'].slice(0, 16) });
  });
  return out;
}

function sanitizeFlash(raw: Rec, where: string, problems: string[]): EcuFlashParamsV1 {
  const d = defaultFlash();
  const regions: EcuMemoryRegionV1[] = [];
  list(raw['memoryRegions'], MAX_REGIONS, `${where}.flash.memoryRegions`, problems).forEach((r, i) => {
    if (
      !isRecord(r) ||
      typeof r['key'] !== 'string' ||
      typeof r['start'] !== 'number' || !Number.isFinite(r['start']) ||
      typeof r['length'] !== 'number' || !Number.isFinite(r['length'])
    ) {
      problems.push(`${where}.flash.memoryRegions[${i}]: dropped (malformed)`);
      return;
    }
    regions.push({ key: r['key'].slice(0, 64), label: str(r['label'], ''), start: Math.trunc(r['start']), length: Math.trunc(r['length']) });
  });
  return {
    alfid: int(raw['alfid'], d.alfid),
    dfi: int(raw['dfi'], d.dfi),
    maxBlockLenOverride: nullableInt(raw['maxBlockLenOverride'], null),
    eraseAlfid: int(raw['eraseAlfid'], d.eraseAlfid),
    memoryRegions: regions,
  };
}

function sanitizeIdent(raw: Rec): EcuIdentificationV1 {
  const d = defaultIdentification();
  return {
    expectedHw: nullableStr(raw['expectedHw']),
    expectedSparePart: nullableStr(raw['expectedSparePart']),
    vinDid: str(raw['vinDid'], d.vinDid, 16),
    swDid: str(raw['swDid'], d.swDid, 16),
    hwDid: str(raw['hwDid'], d.hwDid, 16),
    sparePartDid: str(raw['sparePartDid'], d.sparePartDid, 16),
  };
}

function sanitizeDids(v: unknown, where: string, problems: string[]): EcuDidV1[] {
  const out: EcuDidV1[] = [];
  list(v, MAX_DIDS, `${where}.dids`, problems).forEach((e, i) => {
    if (!isRecord(e) || typeof e['did'] !== 'string') {
      problems.push(`${where}.dids[${i}]: dropped (malformed)`);
      return;
    }
    const format = EDID_FORMATS.find((f) => f === e['format']) ?? 'hex';
    out.push({ did: e['did'].slice(0, 16), name: str(e['name'], ''), format });
  });
  return out;
}

function sanitizeVars(v: unknown, where: string, problems: string[]): EcuVarV1[] {
  const out: EcuVarV1[] = [];
  list(v, MAX_VARS, `${where}.vars`, problems).forEach((e, i) => {
    if (!isRecord(e) || typeof e['key'] !== 'string') {
      problems.push(`${where}.vars[${i}]: dropped (malformed)`);
      return;
    }
    out.push({ key: e['key'].slice(0, 64), value: str(e['value'], '', 4096) });
  });
  return out;
}

/** One ECU record, or `null` (reason appended to `problems`). `groupIds` = valid group ids of its vehicle / file. */
export function sanitizeEcu(raw: unknown, where: string, groupIds: ReadonlySet<string>, problems: string[]): EcuRecordV1 | null {
  if (!isRecord(raw)) {
    problems.push(`${where}: dropped (not an object)`);
    return null;
  }
  const id = nonEmptyStr(raw['id'], 128);
  const name = nonEmptyStr(raw['name'], 128);
  if (id === null || name === null) {
    problems.push(`${where}: dropped (id / name missing)`);
    return null;
  }
  const protocol = DIAG_PROTOCOLS.find((p): p is DiagProtocol => p === raw['protocol']);
  if (protocol === undefined) {
    problems.push(`${where} "${name}": dropped (unknown protocol)`);
    return null;
  }
  if (!isRecord(raw['addressing'])) {
    problems.push(`${where} "${name}": dropped (addressing missing)`);
    return null;
  }
  const addressing = sanitizeAddressingBlock(raw['addressing'], `${where} "${name}"`, problems);
  if (addressing === null) return null;
  const w = `${where} "${name}"`;
  const groupId = typeof raw['groupId'] === 'string' && groupIds.has(raw['groupId']) ? raw['groupId'] : null;
  if (typeof raw['groupId'] === 'string' && groupId === null) {
    problems.push(`${w}: unknown group, moved to ungrouped`);
  }
  const profile = raw['connectionProfileId'];
  return {
    id,
    name,
    groupId,
    order: int(raw['order'], 0),
    notes: str(raw['notes'], '', MAX_NOTES),
    source: SOURCES.find((s) => s === raw['source']) ?? 'manual',
    protocol,
    connectionProfileId: typeof profile === 'string' && profile.length > 0 ? profile.slice(0, 128) : null,
    addressing,
    timing: sanitizeTiming(sub(raw['timing'], `${w}.timing`, problems)),
    security: sanitizeSecurity(sub(raw['security'], `${w}.security`, problems), w, problems),
    routines: sanitizeRoutines(raw['routines'], w, problems),
    flash: sanitizeFlash(sub(raw['flash'], `${w}.flash`, problems), w, problems),
    identification: sanitizeIdent(sub(raw['identification'], `${w}.identification`, problems)),
    dids: sanitizeDids(raw['dids'], w, problems),
    vars: sanitizeVars(raw['vars'], w, problems),
    revision: revision(raw['revision']),
    createdAt: iso(raw['createdAt']),
    updatedAt: iso(raw['updatedAt']),
  };
}

export function sanitizeGroup(raw: unknown, where: string, problems: string[]): EcuGroupV1 | null {
  if (!isRecord(raw)) {
    problems.push(`${where}: dropped (not an object)`);
    return null;
  }
  const id = nonEmptyStr(raw['id'], 128);
  const name = nonEmptyStr(raw['name'], 128);
  if (id === null || name === null) {
    problems.push(`${where}: dropped (id / name missing)`);
    return null;
  }
  const color: EcuGroupColor = ECU_GROUP_COLORS.find((c) => c === raw['color']) ?? 'slate';
  return { id, name, color, order: int(raw['order'], 0) };
}

/** Collections of groups / ECUs with duplicate-id removal (first wins). */
export function sanitizeGroupsAndEcus(
  rawGroups: unknown,
  rawEcus: unknown,
  where: string,
  problems: string[],
): { groups: EcuGroupV1[]; ecus: EcuRecordV1[] } {
  const groups: EcuGroupV1[] = [];
  const gIds = new Set<string>();
  list(rawGroups, MAX_GROUPS, `${where}.groups`, problems).forEach((g, i) => {
    const grp = sanitizeGroup(g, `${where}.groups[${i}]`, problems);
    if (grp === null) return;
    if (gIds.has(grp.id)) {
      problems.push(`${where}.groups[${i}]: dropped (duplicate id)`);
      return;
    }
    gIds.add(grp.id);
    groups.push(grp);
  });
  const ecus: EcuRecordV1[] = [];
  const eIds = new Set<string>();
  list(rawEcus, MAX_ECUS, `${where}.ecus`, problems).forEach((e, i) => {
    const ecu = sanitizeEcu(e, `${where}.ecus[${i}]`, gIds, problems);
    if (ecu === null) return;
    if (eIds.has(ecu.id)) {
      problems.push(`${where}.ecus[${i}] "${ecu.name}": dropped (duplicate id)`);
      return;
    }
    eIds.add(ecu.id);
    ecus.push(ecu);
  });
  return { groups, ecus };
}

// ── Bindings / vehicles / project ────────────────────────────────────────────

function sanitizeBinding(raw: unknown, where: string, ecuIds: ReadonlySet<string>, problems: string[]): FlowBindingV1 | null {
  if (!isRecord(raw)) {
    problems.push(`${where}: dropped (not an object)`);
    return null;
  }
  const id = nonEmptyStr(raw['id'], 128);
  const ecuId = nonEmptyStr(raw['ecuId'], 128);
  const ref = raw['flowRef'];
  if (id === null || ecuId === null || !isRecord(ref) || typeof ref['flowId'] !== 'string' || typeof ref['revision'] !== 'number') {
    problems.push(`${where}: dropped (malformed)`);
    return null;
  }
  if (!ecuIds.has(ecuId)) {
    problems.push(`${where}: dropped (ECU not found)`);
    return null;
  }
  const params: Record<string, FlowBindingParamValue> = Object.create(null) as Record<string, FlowBindingParamValue>;
  if (isRecord(raw['params'])) {
    for (const key of Object.keys(raw['params'])) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      const v = raw['params'][key];
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params[key] = v;
    }
  }
  const out: FlowBindingV1 = {
    id,
    ecuId,
    flowRef: { flowId: ref['flowId'].slice(0, 128), revision: Math.trunc(ref['revision']) },
    label: typeof raw['label'] === 'string' ? raw['label'].slice(0, 128) : null,
    params: { ...params },
    order: int(raw['order'], 0),
  };
  const fe = raw['fileExpect'];
  if (fe !== undefined) {
    if (!isRecord(fe)) {
      problems.push(`${where}.fileExpect: dropped (not an object)`);
    } else {
      const expect: Record<string, FileExpectV1> = {};
      for (const key of Object.keys(fe)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        const entry = normalizeFileExpect(fe[key]);
        if (entry === null) problems.push(`${where}.fileExpect.${key}: dropped (malformed file name / CRC-32)`);
        else expect[key] = entry;
      }
      if (Object.keys(expect).length > 0) out.fileExpect = expect;
    }
  }
  return out;
}

function sanitizeVehicle(raw: unknown, where: string, problems: string[]): DiagVehicleV1 | null {
  if (!isRecord(raw)) {
    problems.push(`${where}: dropped (not an object)`);
    return null;
  }
  const id = nonEmptyStr(raw['id'], 128);
  const name = nonEmptyStr(raw['name'], 128);
  if (id === null || name === null) {
    problems.push(`${where}: dropped (id / name missing)`);
    return null;
  }
  const w = `${where} "${name}"`;
  const { groups, ecus } = sanitizeGroupsAndEcus(raw['groups'], raw['ecus'], w, problems);
  const ecuIds = new Set(ecus.map((e) => e.id));
  const bindings: FlowBindingV1[] = [];
  const bIds = new Set<string>();
  list(raw['bindings'], MAX_BINDINGS, `${w}.bindings`, problems).forEach((b, i) => {
    const bind = sanitizeBinding(b, `${w}.bindings[${i}]`, ecuIds, problems);
    if (bind === null || bIds.has(bind.id)) return;
    bIds.add(bind.id);
    bindings.push(bind);
  });
  return {
    id,
    name,
    notes: str(raw['notes'], '', MAX_NOTES),
    groups,
    ecus,
    bindings,
    revision: revision(raw['revision']),
    createdAt: iso(raw['createdAt']),
    updatedAt: iso(raw['updatedAt']),
  };
}

/**
 * Normalizes the `diagnostics` block of a project file. Missing (`undefined` / `null`) -> empty, no problem.
 * Anything else that is not a valid block -> empty + problem. Never throws.
 */
export function sanitizeDiagnostics(raw: unknown): { value: DiagnosticsProjectV1; problems: string[] } {
  const problems: string[] = [];
  const empty = (): DiagnosticsProjectV1 => ({ ...EMPTY_DIAGNOSTICS, vehicles: [] });
  if (raw === undefined || raw === null) return { value: empty(), problems };
  if (!isRecord(raw)) {
    problems.push('diagnostics: not an object, registry ignored');
    return { value: empty(), problems };
  }
  if (raw['schemaVersion'] !== 1) {
    problems.push('diagnostics: unsupported schemaVersion, registry ignored');
    return { value: empty(), problems };
  }
  const vehicles: DiagVehicleV1[] = [];
  const ids = new Set<string>();
  list(raw['vehicles'], MAX_VEHICLES, 'diagnostics.vehicles', problems).forEach((v, i) => {
    const veh = sanitizeVehicle(v, `diagnostics.vehicles[${i}]`, problems);
    if (veh === null) return;
    if (ids.has(veh.id)) {
      problems.push(`diagnostics.vehicles[${i}] "${veh.name}": dropped (duplicate id)`);
      return;
    }
    ids.add(veh.id);
    vehicles.push(veh);
  });
  const active = typeof raw['activeVehicleId'] === 'string' && ids.has(raw['activeVehicleId']) ? raw['activeVehicleId'] : null;
  return {
    value: { schemaVersion: 1, vehicles, activeVehicleId: active ?? (vehicles.length > 0 ? vehicles[0].id : null) },
    problems,
  };
}
