/**
 * ECU registry validation (diag-workspace-v1 §6). Pure: no React, no store. Messages are produced through
 * the injected translate function (translation keys `diagWs.val.*`), every issue is field-addressed.
 *
 * Field paths: `name`, `groupId`, `addressing.requestId`, `security.levels[2].level`,
 * `flash.memoryRegions[0].start`, `routines[1].rid`, `dids[0].did`, `vars[3].key`, ...
 */
import { REGISTRY_KEY_RE, type DiagVehicleV1, type EcuRecordV1 } from '../../../types/diagWorkspace';
import type { DiagWsKey } from '../../../i18n/shards/diagWorkspace';
import { checkAddressing, checkIdForms, usesTargetByte } from '../addressing';
import { MAX_EXT_ID, MAX_STD_ID } from '../sessionValidation';

export type ValidationTranslate = (key: DiagWsKey, params?: Record<string, string | number>) => string;

export interface EcuIssue {
  ecuId: string;
  field: string;
  /** Stable machine code (`range11`, `collisionRequest`, `regionOverlap`, ...). */
  code: string;
  message: string;
}

export interface GroupIssue {
  groupId: string;
  field: 'name';
  code: string;
  message: string;
}

export interface EcuValidationContext {
  /** The OTHER ECUs of the vehicle (the validated one is excluded by the caller or by id). */
  others: readonly EcuRecordV1[];
  groupIds: ReadonlySet<string>;
}

export interface VehicleValidation {
  ecu: Map<string, EcuIssue[]>;
  groups: GroupIssue[];
  /** Number of ECUs with at least one issue + number of group issues. */
  errorCount: number;
}

export const MAX_U32_EXCLUSIVE = 0x1_0000_0000;
const DID_RE = /^[0-9A-Fa-f]{4}$/;
const SECURITY_LEVEL_MAX = 0x7d;

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function isU8(v: unknown): v is number {
  return isInt(v) && v >= 0 && v <= 0xff;
}

function hex(n: number, width = 2): string {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

function normName(s: string): string {
  return s.trim().toLowerCase();
}

/** Bus-collision key part: byte addresses only count for formats that carry one. */
function addrKey(ecu: EcuRecordV1, id: number, address: number | null): string {
  const a = ecu.addressing;
  const addr = usesTargetByte(a.addressFormat) ? (address === null ? '' : String(address)) : '';
  return `${ecu.connectionProfileId ?? ''}|${a.isExtendedId ? 1 : 0}|${a.addressFormat}|${id}|${addr}`;
}

export function requestCollisionKey(ecu: EcuRecordV1): string {
  return addrKey(ecu, ecu.addressing.requestId, ecu.addressing.targetAddress);
}

export function responseCollisionKey(ecu: EcuRecordV1): string {
  return addrKey(ecu, ecu.addressing.responseId, ecu.addressing.responseAddress);
}

export function validateEcu(ecu: EcuRecordV1, ctx: EcuValidationContext, tr: ValidationTranslate): EcuIssue[] {
  const issues: EcuIssue[] = [];
  const add = (field: string, code: string, key: DiagWsKey, params?: Record<string, string | number>): void => {
    issues.push({ ecuId: ecu.id, field, code, message: tr(key, params) });
  };
  const others = ctx.others.filter((o) => o.id !== ecu.id);

  // ── Name / group ──
  if (ecu.name.trim().length === 0) {
    add('name', 'nameEmpty', 'diagWs.val.nameEmpty');
  } else if (others.some((o) => normName(o.name) === normName(ecu.name))) {
    add('name', 'nameDuplicate', 'diagWs.val.nameDuplicate');
  }
  if (ecu.groupId !== null && !ctx.groupIds.has(ecu.groupId)) {
    add('groupId', 'groupMissing', 'diagWs.val.groupMissing');
  }

  // ── Addressing ──
  const a = ecu.addressing;
  const max = a.isExtendedId ? MAX_EXT_ID : MAX_STD_ID;
  const rangeKey: DiagWsKey = a.isExtendedId ? 'diagWs.val.range29' : 'diagWs.val.range11';
  const rangeCode = a.isExtendedId ? 'range29' : 'range11';
  const reqOk = isInt(a.requestId) && a.requestId >= 0 && a.requestId <= max;
  const respOk = isInt(a.responseId) && a.responseId >= 0 && a.responseId <= max;
  if (!reqOk) add('addressing.requestId', rangeCode, rangeKey, { field: 'Request ID' });
  if (!respOk) add('addressing.responseId', rangeCode, rangeKey, { field: 'Response ID' });
  if (reqOk && respOk && a.requestId === a.responseId) {
    add('addressing.responseId', 'sameIds', 'diagWs.val.sameIds');
  }
  const funcOk = a.functionalId === null || (isInt(a.functionalId) && a.functionalId >= 0 && a.functionalId <= max);
  if (!funcOk) add('addressing.functionalId', rangeCode, rangeKey, { field: 'Functional ID' });

  const tgtBad = a.targetAddress !== null && !isU8(a.targetAddress);
  const rspBad = a.responseAddress !== null && !isU8(a.responseAddress);
  if (usesTargetByte(a.addressFormat)) {
    if (tgtBad) add('addressing.targetAddress', 'u8', 'diagWs.val.u8', { field: 'Target address' });
    if (rspBad) add('addressing.responseAddress', 'u8', 'diagWs.val.u8', { field: 'Response address' });
    if (!tgtBad && !rspBad) {
      const chk = checkAddressing({
        format: a.addressFormat,
        target: a.targetAddress === null ? '' : hex(a.targetAddress),
        response: a.responseAddress === null ? '' : hex(a.responseAddress),
      });
      if (!chk.ok) {
        const field = chk.field === 'target' ? 'addressing.targetAddress' : 'addressing.responseAddress';
        add(field, chk.reason === 'required' ? 'addrRequired' : 'u8', chk.reason === 'required' ? 'diagWs.val.addrRequired' : 'diagWs.val.u8', {
          field: chk.field === 'target' ? 'Target address' : 'Response address',
          format: a.addressFormat,
        });
      }
    }
  }
  if (reqOk && respOk && funcOk) {
    const form = checkIdForms(a.addressFormat, a.isExtendedId, [a.requestId, a.responseId], a.functionalId);
    if (form !== null) {
      if (form.error === 'needs29bit') {
        add('addressing.isExtendedId', 'needs29bit', 'diagWs.val.needs29bit', { format: a.addressFormat });
      } else {
        const field = form.functional
          ? 'addressing.functionalId'
          : form.id === a.requestId
            ? 'addressing.requestId'
            : 'addressing.responseId';
        add(field, 'idForm', 'diagWs.val.idForm', { id: hex(form.id, 8), pf: hex(form.pf), format: a.addressFormat });
      }
    }
  }
  if (a.padding !== null && !isU8(a.padding)) add('addressing.padding', 'u8', 'diagWs.val.u8', { field: 'Padding' });

  // ── Bus collisions ──
  if (reqOk) {
    const myReq = requestCollisionKey(ecu);
    const hit = others.find((o) => requestCollisionKey(o) === myReq);
    if (hit) add('addressing.requestId', 'collisionRequest', 'diagWs.val.collisionRequest', { name: hit.name });
  }
  if (respOk) {
    const myResp = responseCollisionKey(ecu);
    const hit = others.find((o) => responseCollisionKey(o) === myResp);
    if (hit) add('addressing.responseId', 'collisionResponse', 'diagWs.val.collisionResponse', { name: hit.name });
  }

  // ── Timing ──
  if (!isInt(ecu.timing.p2MarginMs) || ecu.timing.p2MarginMs < 0 || ecu.timing.p2MarginMs > 60_000) {
    add('timing.p2MarginMs', 'p2Margin', 'diagWs.val.p2Margin');
  }
  if (!isInt(ecu.timing.keepaliveIntervalMs) || ecu.timing.keepaliveIntervalMs < 100 || ecu.timing.keepaliveIntervalMs > 60_000) {
    add('timing.keepaliveIntervalMs', 'keepalive', 'diagWs.val.keepalive');
  }

  // ── Security levels ──
  const lvlSeen = new Map<number, number>();
  const lvlKeys = new Set<string>();
  ecu.security.levels.forEach((l, i) => {
    const base = `security.levels[${i}]`;
    if (!REGISTRY_KEY_RE.test(l.key)) add(`${base}.key`, 'keyFormat', 'diagWs.val.keyFormat');
    else if (lvlKeys.has(l.key)) add(`${base}.key`, 'keyDuplicate', 'diagWs.val.keyDuplicate', { key: l.key });
    lvlKeys.add(l.key);
    if (!isInt(l.level) || l.level < 0x01 || l.level > SECURITY_LEVEL_MAX || l.level % 2 === 0) {
      add(`${base}.level`, 'levelRange', 'diagWs.val.levelRange');
    } else if (lvlSeen.has(l.level)) {
      add(`${base}.level`, 'levelDuplicate', 'diagWs.val.levelDuplicate', { level: hex(l.level) });
    }
    if (isInt(l.level)) lvlSeen.set(l.level, i);
  });

  // ── Routines ──
  const rKeys = new Set<string>();
  ecu.routines.forEach((r, i) => {
    if (!REGISTRY_KEY_RE.test(r.key)) add(`routines[${i}].key`, 'keyFormat', 'diagWs.val.keyFormat');
    else if (rKeys.has(r.key)) add(`routines[${i}].key`, 'keyDuplicate', 'diagWs.val.keyDuplicate', { key: r.key });
    rKeys.add(r.key);
    if (!DID_RE.test(r.rid)) add(`routines[${i}].rid`, 'hex4', 'diagWs.val.hex4', { field: 'RID' });
  });

  // ── Flash ──
  const f = ecu.flash;
  if (!isU8(f.dfi)) add('flash.dfi', 'u8', 'diagWs.val.u8', { field: 'DFI' });
  const alfidCheck = (field: 'flash.alfid' | 'flash.eraseAlfid', value: number, label: string): void => {
    if (!isU8(value)) {
      add(field, 'u8', 'diagWs.val.u8', { field: label });
      return;
    }
    const lenN = value >> 4;
    const addrN = value & 0x0f;
    if (lenN < 1 || lenN > 4 || addrN < 1 || addrN > 4) add(field, 'alfidNibble', 'diagWs.val.alfidNibble', { field: label });
  };
  alfidCheck('flash.alfid', f.alfid, 'ALFID');
  alfidCheck('flash.eraseAlfid', f.eraseAlfid, 'Erase ALFID');
  if (f.maxBlockLenOverride !== null && (!isInt(f.maxBlockLenOverride) || f.maxBlockLenOverride < 3)) {
    add('flash.maxBlockLenOverride', 'maxBlockLen', 'diagWs.val.maxBlockLen');
  }
  const regKeys = new Set<string>();
  const usable: { i: number; start: number; end: number }[] = [];
  f.memoryRegions.forEach((r, i) => {
    const base = `flash.memoryRegions[${i}]`;
    if (!REGISTRY_KEY_RE.test(r.key)) add(`${base}.key`, 'keyFormat', 'diagWs.val.keyFormat');
    else if (regKeys.has(r.key)) add(`${base}.key`, 'keyDuplicate', 'diagWs.val.keyDuplicate', { key: r.key });
    regKeys.add(r.key);
    const startOk = isInt(r.start) && r.start >= 0 && r.start < MAX_U32_EXCLUSIVE;
    const lenOk = isInt(r.length) && r.length > 0;
    if (!startOk) add(`${base}.start`, 'u32', 'diagWs.val.u32', { field: 'Start' });
    if (!lenOk) add(`${base}.length`, 'lengthPositive', 'diagWs.val.lengthPositive');
    if (startOk && lenOk) {
      if (r.start + r.length > MAX_U32_EXCLUSIVE) add(`${base}.length`, 'regionEnd', 'diagWs.val.regionEnd');
      else usable.push({ i, start: r.start, end: r.start + r.length });
    }
  });
  usable.sort((x, y) => x.start - y.start || x.i - y.i);
  for (let k = 1; k < usable.length; k += 1) {
    const prev = usable[k - 1];
    const cur = usable[k];
    if (cur.start < prev.end) {
      add(`flash.memoryRegions[${cur.i}].start`, 'regionOverlap', 'diagWs.val.regionOverlap', {
        other: f.memoryRegions[prev.i].key,
      });
    }
  }

  // ── Identification DIDs ──
  const ident = ecu.identification;
  (['vinDid', 'swDid', 'hwDid', 'sparePartDid'] as const).forEach((k) => {
    if (!DID_RE.test(ident[k])) add(`identification.${k}`, 'hex4', 'diagWs.val.hex4', { field: 'DID' });
  });

  // ── DIDs / vars ──
  ecu.dids.forEach((d, i) => {
    if (!DID_RE.test(d.did)) add(`dids[${i}].did`, 'hex4', 'diagWs.val.hex4', { field: 'DID' });
  });
  const vKeys = new Set<string>();
  ecu.vars.forEach((v, i) => {
    if (!REGISTRY_KEY_RE.test(v.key)) add(`vars[${i}].key`, 'keyFormat', 'diagWs.val.keyFormat');
    else if (vKeys.has(v.key)) add(`vars[${i}].key`, 'keyDuplicate', 'diagWs.val.keyDuplicate', { key: v.key });
    vKeys.add(v.key);
  });

  return issues;
}

export function validateGroups(vehicle: DiagVehicleV1, tr: ValidationTranslate): GroupIssue[] {
  const out: GroupIssue[] = [];
  const seen = new Set<string>();
  for (const g of vehicle.groups) {
    const n = normName(g.name);
    if (n.length === 0) {
      out.push({ groupId: g.id, field: 'name', code: 'nameEmpty', message: tr('diagWs.val.nameEmpty') });
    } else if (seen.has(n)) {
      out.push({ groupId: g.id, field: 'name', code: 'nameDuplicate', message: tr('diagWs.val.groupNameDuplicate') });
    }
    seen.add(n);
  }
  return out;
}

export function validateVehicle(vehicle: DiagVehicleV1, tr: ValidationTranslate): VehicleValidation {
  const groupIds = new Set(vehicle.groups.map((g) => g.id));
  const ecu = new Map<string, EcuIssue[]>();
  let errorCount = 0;
  for (const e of vehicle.ecus) {
    const issues = validateEcu(e, { others: vehicle.ecus, groupIds }, tr);
    if (issues.length > 0) {
      ecu.set(e.id, issues);
      errorCount += 1;
    }
  }
  const groups = validateGroups(vehicle, tr);
  return { ecu, groups, errorCount: errorCount + groups.length };
}

/** First issue of exactly `field` (for inline display under an input). */
export function issueFor(issues: readonly EcuIssue[], field: string): EcuIssue | undefined {
  return issues.find((i) => i.field === field);
}
