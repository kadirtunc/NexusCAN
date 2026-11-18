/**
 * Headless tests of the ECU registry (diag-workspace-v1 A1): sanitizer, validation, `{ecu.*}` resolver,
 * snapshot hash, store semantics, `.nexusecu.json` round trip, project persistence helpers.
 * Run: `npm run test:diagws` (esbuild bundle -> node; throws on the first failure).
 */
import type { DiagVehicleV1, EcuRecordV1, NexusEcuFileV1 } from '../../../types/diagWorkspace';
import { EMPTY_DIAGNOSTICS } from '../../../types/diagWorkspace';
import { sanitizeProject } from '../../../utils/projectSanitize';
import { sanitizeDiagnostics } from './diagnosticsSanitize';
import { diagWorkspaceStore } from './diagWorkspaceStore';
import { newEcuRecord, newVehicle, uniqueName } from './ecuDefaults';
import { buildEcuFile, prepareEcuImport, serializeEcuFile } from './ecuExchange';
import { canonicalJson, ecuSnapshotHash, listEcuRefs, resolveEcuRefs } from './ecuRefs';
import { validateEcu, validateVehicle, type EcuIssue, type ValidationTranslate } from './ecuValidation';

let passed = 0;
function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  passed += 1;
}
function eq<T>(actual: T, expected: T, msg: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

/** Identity translator: the message is the key (+ params) so tests assert on keys. */
const tr: ValidationTranslate = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);

function mk(name: string, patch: Parameters<typeof newEcuRecord>[0] = {}): EcuRecordV1 {
  return newEcuRecord({ name, ...patch });
}
function codes(issues: readonly EcuIssue[]): string[] {
  return issues.map((i) => `${i.field}:${i.code}`);
}
function has(issues: readonly EcuIssue[], field: string, code: string): boolean {
  return issues.some((i) => i.field === field && i.code === code);
}
function check(ecu: EcuRecordV1, others: EcuRecordV1[] = [], groupIds: string[] = []): EcuIssue[] {
  return validateEcu(ecu, { others, groupIds: new Set(groupIds) }, tr);
}

// ── defaults ────────────────────────────────────────────────────────────────
function testDefaults(): void {
  const e = newEcuRecord({ name: 'ECM' });
  ok(e.protocol === 'uds_can' && e.source === 'manual', 'default protocol / source');
  ok(e.addressing.requestId === 0x7e0 && e.addressing.responseId === 0x7e8, 'default ids');
  ok(e.addressing.addressFormat === 'normal' && e.addressing.padding === 0xaa, 'default format / padding');
  ok(e.timing.p2MarginMs === 100 && e.timing.keepaliveIntervalMs === 2000, 'default timing');
  ok(e.flash.alfid === 0x44 && e.flash.dfi === 0 && e.flash.eraseAlfid === 0x44, 'default flash');
  eq([e.identification.vinDid, e.identification.swDid, e.identification.hwDid, e.identification.sparePartDid], ['F190', 'F189', 'F191', 'F187'], 'default DIDs');
  ok(e.routines.length === 0 && e.dids.length === 0 && e.vars.length === 0 && e.security.levels.length === 0, 'empty collections');
  ok(check(e).length === 0, 'default ECU is valid');
  const e2 = newEcuRecord({ name: 'X', addressing: { requestId: 0x701 }, flash: { alfid: 0x24 } });
  ok(e2.addressing.requestId === 0x701 && e2.addressing.responseId === 0x7e8 && e2.flash.alfid === 0x24 && e2.flash.dfi === 0, 'partial overrides merge');
  eq([uniqueName('A', ['a']), uniqueName('A', ['A', 'A (2)']), uniqueName('B', ['a'])], ['A (2)', 'A (3)', 'B'], 'uniqueName');
}

// ── sanitizeDiagnostics ─────────────────────────────────────────────────────
function validVehicleJson(): DiagVehicleV1 {
  const v = newVehicle('Car');
  const g = { id: 'g1', name: 'Powertrain', color: 'amber' as const, order: 0 };
  const e = mk('ECM', { groupId: 'g1' });
  v.groups.push(g);
  v.ecus.push(e);
  v.bindings.push({ id: 'b1', ecuId: e.id, flowRef: { flowId: 'f', revision: 1 }, label: null, params: { a: 1, b: 'x', c: true }, order: 0 });
  return v;
}

function testSanitize(): void {
  const missing = sanitizeDiagnostics(undefined);
  eq(missing.value, { ...EMPTY_DIAGNOSTICS, vehicles: [] }, 'missing -> empty');
  ok(missing.problems.length === 0, 'missing has no problem');
  ok(missing.value !== EMPTY_DIAGNOSTICS, 'missing returns a fresh object');

  for (const garbage of ['x', 5, [], true, { schemaVersion: 2 }]) {
    const r = sanitizeDiagnostics(garbage);
    ok(r.value.vehicles.length === 0 && r.problems.length === 1, `garbage ${JSON.stringify(garbage)} -> empty + 1 problem`);
  }

  const v = validVehicleJson();
  const good = sanitizeDiagnostics({ schemaVersion: 1, vehicles: [v], activeVehicleId: v.id });
  ok(good.problems.length === 0, `valid has no problems (${good.problems.join('; ')})`);
  eq(good.value.vehicles[0], v, 'valid vehicle round-trips unchanged');
  ok(good.value.activeVehicleId === v.id, 'active vehicle kept');

  // partially invalid: bad vehicle, bad ECU, duplicate id, bad group ref, bad binding, bad enum
  const goodEcu = mk('Good');
  const bad = {
    schemaVersion: 1,
    activeVehicleId: 'nope',
    vehicles: [
      42,
      { id: 'v-no-name' },
      {
        ...v,
        id: 'v2',
        name: 'Second',
        ecus: [
          goodEcu,
          { ...goodEcu, id: 'dup-name-ok', name: 'Dup' },
          { ...goodEcu, id: 'no-addr', name: 'NoAddr', addressing: 'x' },
          { ...goodEcu, id: 'bad-proto', name: 'BadProto', protocol: 'lin' },
          { ...goodEcu, id: goodEcu.id, name: 'SameId' },
          { ...goodEcu, id: 'orphan', name: 'Orphan', groupId: 'ghost' },
          null,
        ],
        bindings: [
          { id: 'ok', ecuId: goodEcu.id, flowRef: { flowId: 'f', revision: 2 }, label: 'L', params: { p: 1, q: { no: 1 } }, order: 1 },
          { id: 'dead', ecuId: 'missing', flowRef: { flowId: 'f', revision: 2 }, label: null, params: {}, order: 2 },
          { id: 'bad' },
        ],
      },
      { ...v, id: 'v2', name: 'Dup id' },
    ],
  };
  const part = sanitizeDiagnostics(bad);
  ok(part.value.vehicles.length === 1 && part.value.vehicles[0].id === 'v2', 'only the valid vehicle is kept');
  const kept = part.value.vehicles[0];
  eq(kept.ecus.map((e) => e.name), ['Good', 'Dup', 'Orphan'], 'valid ECUs kept, malformed dropped');
  ok(kept.ecus[2].groupId === null, 'unknown group -> ungrouped');
  eq(kept.bindings.map((b) => b.id), ['ok'], 'orphan / malformed bindings dropped');
  eq(kept.bindings[0].params, { p: 1 }, 'non-primitive binding params dropped');
  ok(part.value.activeVehicleId === 'v2', 'invalid active id falls back to the first vehicle');
  ok(part.problems.length >= 7, `problem messages reported (${part.problems.length})`);

  // forgiving details
  const lenient = sanitizeDiagnostics({
    schemaVersion: 1,
    vehicles: [{ id: 'v', name: 'V', ecus: [{ id: 'e', name: 'E', protocol: 'uds_can', addressing: { requestId: 1, responseId: 2, addressFormat: 'bogus' }, timing: 'nope', routines: [{ key: 'a' }, { key: 'k', rid: 'FF00' }] }] }],
  });
  const le = lenient.value.vehicles[0].ecus[0];
  ok(le.addressing.addressFormat === 'normal' && le.timing.p2MarginMs === 100, 'bad sub-fields fall back to defaults');
  ok(le.routines.length === 1 && le.routines[0].rid === 'FF00', 'malformed routine dropped');
  ok(lenient.problems.length >= 3, 'lenient problems reported');
  ok(lenient.value.vehicles[0].revision === 1, 'missing revision -> 1');

  // prototype pollution keys never become params
  const polluted = sanitizeDiagnostics(JSON.parse('{"schemaVersion":1,"vehicles":[{"id":"v","name":"V","ecus":[{"id":"e","name":"E","protocol":"uds_can","addressing":{"requestId":1,"responseId":2}}],"bindings":[{"id":"b","ecuId":"e","flowRef":{"flowId":"f","revision":1},"params":{"__proto__":"x","ok":1}}]}]}'));
  eq(Object.keys(polluted.value.vehicles[0].bindings[0].params), ['ok'], '__proto__ param dropped');
}

// ── project persistence (pure part) ─────────────────────────────────────────
function testProjectSanitize(): void {
  const base = { version: 1, name: 'P', notes: 'n', databases: { customFiles: [] }, connections: { profiles: [] }, transmitList: { entries: [] } };
  const none = sanitizeProject(base, 'own');
  ok(none.projectIdGenerated && typeof none.project.projectId === 'string' && none.project.projectId.length >= 8, 'missing projectId -> generated uuid');
  eq(none.project.diagnostics, { ...EMPTY_DIAGNOSTICS, vehicles: [] }, 'missing diagnostics -> EMPTY_DIAGNOSTICS');
  ok(none.diagnosticsProblems.length === 0, 'missing diagnostics is not a problem');

  const withId = sanitizeProject({ ...base, projectId: 'abcd1234-aaaa', diagnostics: { schemaVersion: 1, vehicles: [validVehicleJson()], activeVehicleId: null } }, 'external');
  ok(!withId.projectIdGenerated && withId.project.projectId === 'abcd1234-aaaa', 'existing projectId kept');
  ok(withId.project.diagnostics?.vehicles.length === 1, 'diagnostics kept');

  const junk = sanitizeProject({ ...base, notes: 'keep me', projectId: 5, diagnostics: 'garbage' }, 'external');
  ok(junk.projectIdGenerated, 'invalid projectId regenerated');
  ok(junk.diagnosticsProblems.length === 1, 'invalid diagnostics reported');
  ok(junk.project.notes === 'keep me' && junk.project.diagnostics?.vehicles.length === 0, 'rest of the project survives garbage diagnostics');
}

// ── validation ──────────────────────────────────────────────────────────────
function testValidation(): void {
  const base = (): EcuRecordV1 => mk('A');
  ok(has(check({ ...base(), name: '  ' }), 'name', 'nameEmpty'), 'empty name');
  ok(has(check(mk('a'), [mk('A ')]), 'name', 'nameDuplicate'), 'name duplicate (trim + case-insensitive)');
  ok(has(check({ ...base(), groupId: 'g' }), 'groupId', 'groupMissing'), 'group must exist');
  ok(check({ ...base(), groupId: 'g' }, [], ['g']).length === 0, 'existing group ok');

  const addr = (p: Partial<EcuRecordV1['addressing']>): EcuIssue[] => check({ ...base(), addressing: { ...base().addressing, ...p } });
  ok(has(addr({ requestId: 0x800 }), 'addressing.requestId', 'range11'), '11-bit request range');
  ok(addr({ requestId: 0x7ff, responseId: 0x7fe }).length === 0, '11-bit max ok');
  ok(has(addr({ isExtendedId: true, requestId: 0x20000000 }), 'addressing.requestId', 'range29'), '29-bit range');
  ok(addr({ isExtendedId: true, requestId: 0x1fffffff, responseId: 0x18daf110 }).length === 0, '29-bit max ok');
  ok(has(addr({ requestId: -1 }), 'addressing.requestId', 'range11'), 'negative id');
  ok(has(addr({ requestId: Number.NaN }), 'addressing.requestId', 'range11'), 'NaN id');
  ok(has(addr({ requestId: 0x123, responseId: 0x123 }), 'addressing.responseId', 'sameIds'), 'request != response');
  ok(has(addr({ functionalId: 0x800 }), 'addressing.functionalId', 'range11'), 'functional id range');
  ok(has(addr({ padding: 256 }), 'addressing.padding', 'u8'), 'padding u8');
  ok(addr({ padding: null }).length === 0, 'null padding ok');

  // address format rules (shared with sessionValidation / addressing.ts)
  ok(has(addr({ addressFormat: 'extended', targetAddress: null, responseAddress: null }), 'addressing.targetAddress', 'addrRequired'), 'extended needs target');
  ok(has(addr({ addressFormat: 'extended', targetAddress: 0x10, responseAddress: null }), 'addressing.responseAddress', 'addrRequired'), 'extended needs response');
  ok(addr({ addressFormat: 'mixed', targetAddress: 0x10, responseAddress: null }).length === 0, 'mixed: response optional');
  ok(has(addr({ addressFormat: 'extended', targetAddress: 300, responseAddress: 1 }), 'addressing.targetAddress', 'u8'), 'target u8');
  ok(has(addr({ addressFormat: 'normalFixed' }), 'addressing.isExtendedId', 'needs29bit'), 'normalFixed needs 29-bit');
  ok(has(addr({ addressFormat: 'normalFixed', isExtendedId: true, requestId: 0x18da10f1, responseId: 0x18daf110, functionalId: 0x18db33f1 }), 'addressing.functionalId', 'idForm') === false, 'normalFixed valid ids ok');
  ok(has(addr({ addressFormat: 'normalFixed', isExtendedId: true, requestId: 0x1234567, responseId: 0x18daf110 }), 'addressing.requestId', 'idForm'), 'normalFixed id form');

  // collisions
  const a = mk('A', { addressing: { requestId: 0x7e0, responseId: 0x7e8 } });
  const dupReq = mk('B', { addressing: { requestId: 0x7e0, responseId: 0x7e9 } });
  const dupResp = mk('C', { addressing: { requestId: 0x7e1, responseId: 0x7e8 } });
  ok(has(check(dupReq, [a]), 'addressing.requestId', 'collisionRequest'), 'request collision');
  ok(has(check(dupResp, [a]), 'addressing.responseId', 'collisionResponse'), 'response collision');
  ok(check(mk('D', { addressing: { requestId: 0x7e2, responseId: 0x7ea } }), [a]).length === 0, 'no collision');
  ok(has(check({ ...dupReq, connectionProfileId: 'p1' }, [{ ...a, connectionProfileId: 'p1' }]), 'addressing.requestId', 'collisionRequest'), 'same profile collides');
  ok(!has(check({ ...dupReq, connectionProfileId: 'p2' }, [{ ...a, connectionProfileId: 'p1' }]), 'addressing.requestId', 'collisionRequest'), 'different profiles do not collide');
  ok(has(check({ ...dupReq, connectionProfileId: null }, [{ ...a, connectionProfileId: null }]), 'addressing.requestId', 'collisionRequest'), 'two null profiles compare as same bus');
  ok(!has(check({ ...dupReq, addressing: { ...dupReq.addressing, addressFormat: 'mixed', targetAddress: 1 } }, [a]), 'addressing.requestId', 'collisionRequest'), 'different address format does not collide');
  // isExtendedId is part of the key: 11-bit 0x123 vs 29-bit 0x123 on the same profile = OK; same width = collision
  const w11 = mk('W11', { connectionProfileId: 'p1', addressing: { requestId: 0x123, responseId: 0x124, isExtendedId: false } });
  const w29 = mk('W29', { connectionProfileId: 'p1', addressing: { requestId: 0x123, responseId: 0x124, isExtendedId: true } });
  ok(check(w29, [w11]).length === 0, '11-bit vs 29-bit same ids, same profile = no collision (request and response)');
  ok(has(check({ ...w29, name: 'W29b' }, [w29, ]).concat(check({ ...w29, id: 'other', name: 'W29b' }, [w29])), 'addressing.requestId', 'collisionRequest'), 'same width = request collision');
  ok(has(check({ ...w11, id: 'o2', name: 'W11b' }, [w11]), 'addressing.responseId', 'collisionResponse'), 'same width = response collision');

  // extended addressing: same requestId with different targetAddress = OK, same = collision
  const ext = (name: string, target: number): EcuRecordV1 =>
    mk(name, { addressing: { requestId: 0x600, responseId: 0x601, addressFormat: 'extended', targetAddress: target, responseAddress: 0xf1 } });
  ok(!has(check(ext('X2', 0x20), [ext('X1', 0x10)]), 'addressing.requestId', 'collisionRequest'), 'extended: same requestId, different target = OK');
  ok(has(check(ext('X2', 0x10), [ext('X1', 0x10)]), 'addressing.requestId', 'collisionRequest'), 'extended: same requestId + target = collision');
  ok(has(check(ext('X2', 0x20), [ext('X1', 0x10)]), 'addressing.responseId', 'collisionResponse'), 'extended: same responseId + responseAddress = collision');
  ok(!has(check(mk('S', { id: a.id, addressing: { ...a.addressing } }), [a]), 'addressing.requestId', 'collisionRequest'), 'an ECU never collides with itself');

  // timing
  ok(has(check({ ...base(), timing: { p2MarginMs: -1, keepaliveIntervalMs: 2000 } }), 'timing.p2MarginMs', 'p2Margin'), 'p2 margin');
  ok(has(check({ ...base(), timing: { p2MarginMs: 100, keepaliveIntervalMs: 50 } }), 'timing.keepaliveIntervalMs', 'keepalive'), 'keepalive');

  // security levels
  const lv = (levels: { key: string; label: string; level: number }[]): EcuIssue[] => check({ ...base(), security: { seedKeyProfileId: null, levels } });
  ok(lv([{ key: 'prog', label: '', level: 0x11 }, { key: 'ext', label: '', level: 0x03 }]).length === 0, 'valid levels');
  ok(has(lv([{ key: 'a', label: '', level: 0x02 }]), 'security.levels[0].level', 'levelRange'), 'even level');
  ok(has(lv([{ key: 'a', label: '', level: 0x7f }]), 'security.levels[0].level', 'levelRange'), 'level > 0x7D');
  ok(has(lv([{ key: 'a', label: '', level: 0x7d }]), 'security.levels[0].level', 'levelRange') === false, '0x7D ok');
  ok(has(lv([{ key: 'a', label: '', level: 0 }]), 'security.levels[0].level', 'levelRange'), 'level 0');
  ok(has(lv([{ key: 'a', label: '', level: 1 }, { key: 'b', label: '', level: 1 }]), 'security.levels[1].level', 'levelDuplicate'), 'level unique');
  ok(has(lv([{ key: 'a', label: '', level: 1 }, { key: 'a', label: '', level: 3 }]), 'security.levels[1].key', 'keyDuplicate'), 'level key unique');
  ok(has(lv([{ key: '1a', label: '', level: 1 }]), 'security.levels[0].key', 'keyFormat'), 'level key format');

  // routines
  const rt = (routines: { key: string; label: string; rid: string }[]): EcuIssue[] => check({ ...base(), routines });
  ok(rt([{ key: 'erase', label: '', rid: 'FF00' }, { key: 'chk', label: '', rid: 'ff01' }]).length === 0, 'valid routines (any hex case)');
  ok(has(rt([{ key: 'erase', label: '', rid: 'FF0' }]), 'routines[0].rid', 'hex4'), 'RID exactly 4 hex (short)');
  ok(has(rt([{ key: 'erase', label: '', rid: 'FF000' }]), 'routines[0].rid', 'hex4'), 'RID exactly 4 hex (long)');
  ok(has(rt([{ key: 'erase', label: '', rid: 'GG00' }]), 'routines[0].rid', 'hex4'), 'RID hex digits');
  ok(has(rt([{ key: 'e', label: '', rid: 'FF00' }, { key: 'e', label: '', rid: 'FF01' }]), 'routines[1].key', 'keyDuplicate'), 'routine key unique');
  ok(has(rt([{ key: 'a-b', label: '', rid: 'FF00' }]), 'routines[0].key', 'keyFormat'), 'routine key format');
  ok(has(rt([{ key: 'x'.repeat(33), label: '', rid: 'FF00' }]), 'routines[0].key', 'keyFormat'), 'routine key max 32');

  // flash
  const fl = (p: Partial<EcuRecordV1['flash']>): EcuIssue[] => check({ ...base(), flash: { ...base().flash, ...p } });
  ok(fl({ alfid: 0x24, eraseAlfid: 0x41 }).length === 0, 'alfid nibbles 1..4');
  ok(has(fl({ alfid: 0x05 }), 'flash.alfid', 'alfidNibble'), 'alfid address nibble 0');
  ok(has(fl({ alfid: 0x54 }), 'flash.alfid', 'alfidNibble'), 'alfid length nibble 5');
  ok(has(fl({ eraseAlfid: 0x40 }), 'flash.eraseAlfid', 'alfidNibble'), 'erase alfid nibble');
  ok(has(fl({ alfid: 0x144 }), 'flash.alfid', 'u8'), 'alfid u8');
  ok(has(fl({ dfi: 256 }), 'flash.dfi', 'u8'), 'dfi u8');
  ok(has(fl({ maxBlockLenOverride: 2 }), 'flash.maxBlockLenOverride', 'maxBlockLen'), 'maxBlockLen >= 3');
  ok(fl({ maxBlockLenOverride: 3 }).length === 0, 'maxBlockLen 3 ok');
  const reg = (key: string, start: number, length: number) => ({ key, label: '', start, length });
  ok(fl({ memoryRegions: [reg('a', 0, 0x1000), reg('b', 0x1000, 0x1000)] }).length === 0, 'adjacent regions ok');
  ok(has(fl({ memoryRegions: [reg('a', 0, 0x1000), reg('b', 0xfff, 0x10)] }), 'flash.memoryRegions[1].start', 'regionOverlap'), 'overlap detected');
  ok(has(fl({ memoryRegions: [reg('a', 0x2000, 0x1000), reg('b', 0x1800, 0x1000)] }), 'flash.memoryRegions[0].start', 'regionOverlap'), 'overlap detected (unsorted input)');
  ok(has(fl({ memoryRegions: [reg('a', 0, 0)] }), 'flash.memoryRegions[0].length', 'lengthPositive'), 'length > 0');
  ok(has(fl({ memoryRegions: [reg('a', 0xfffffff0, 0x20)] }), 'flash.memoryRegions[0].length', 'regionEnd'), 'start + length <= 2^32');
  ok(fl({ memoryRegions: [reg('a', 0xfffffff0, 0x10)] }).length === 0, 'start + length == 2^32 ok');
  ok(has(fl({ memoryRegions: [reg('a', 0x1_0000_0000, 1)] }), 'flash.memoryRegions[0].start', 'u32'), 'start u32');
  ok(has(fl({ memoryRegions: [reg('a', 0, 1), reg('a', 5, 1)] }), 'flash.memoryRegions[1].key', 'keyDuplicate'), 'region key unique');

  // identification / dids / vars
  ok(has(check({ ...base(), identification: { ...base().identification, vinDid: 'F19' } }), 'identification.vinDid', 'hex4'), 'ident DID hex4');
  ok(has(check({ ...base(), dids: [{ did: 'F1900', name: '', format: 'hex' }] }), 'dids[0].did', 'hex4'), 'DID hex4');
  ok(has(check({ ...base(), vars: [{ key: 'a', value: '' }, { key: 'a', value: '' }] }), 'vars[1].key', 'keyDuplicate'), 'var key unique');
  ok(has(check({ ...base(), vars: [{ key: '_a', value: '' }] }), 'vars[0].key', 'keyFormat'), 'var key format');

  // vehicle level
  const veh = newVehicle('V');
  veh.groups.push({ id: 'g1', name: 'Pt', color: 'amber', order: 0 }, { id: 'g2', name: ' pt ', color: 'red', order: 1 });
  veh.ecus.push(mk('A'), mk('B', { addressing: { requestId: 0x7e1, responseId: 0x7e9 } }), mk('C'));
  const vv = validateVehicle(veh, tr);
  ok(vv.groups.length === 1 && vv.groups[0].groupId === 'g2', 'group name unique (trim + case-insensitive)');
  ok(vv.ecu.size === 2 && !vv.ecu.has(veh.ecus[1].id), 'collision flagged on both colliding ECUs only');
  ok(vv.errorCount === 3, 'error count');
  ok(codes(vv.ecu.get(veh.ecus[0].id) ?? []).includes('addressing.requestId:collisionRequest'), 'collision on first ECU');
  ok(validateVehicle(newVehicle('E'), tr).errorCount === 0, 'empty vehicle valid');
}

// ── {ecu.*} resolver ────────────────────────────────────────────────────────
function resolverEcu(): EcuRecordV1 {
  return mk('Engine ECU', {
    security: { seedKeyProfileId: 'prof-1', levels: [{ key: 'programming', label: 'Programming', level: 0x11 }, { key: 'extended', label: '', level: 0x03 }] },
    routines: [{ key: 'erase', label: '', rid: 'ff00' }, { key: 'check', label: '', rid: '1' }],
    flash: { alfid: 0x24, dfi: 0x0a, maxBlockLenOverride: 2048, eraseAlfid: 0x44, memoryRegions: [{ key: 'app', label: '', start: 0x8000, length: 0x1f000 }] },
    identification: { expectedHw: 'HW-1', expectedSparePart: null, vinDid: 'f190', swDid: 'F189', hwDid: 'F191', sparePartDid: 'F187' },
    vars: [{ key: 'greeting', value: 'hello world' }],
  });
}

function testResolver(): void {
  const e = resolverEcu();
  const one = (path: string): { v: unknown; n: number } => {
    const r = resolveEcuRefs({ x: `{${path}}` }, e);
    return { v: r.config['x'], n: r.errors.length };
  };
  const cases: [string, string][] = [
    ['ecu.name', 'Engine ECU'],
    ['ecu.routines.erase', 'FF00'],
    ['ecu.routines.check', '0001'],
    ['ecu.security.level', '11'],
    ['ecu.security.levels.extended', '03'],
    ['ecu.security.levels.programming', '11'],
    ['ecu.security.profileId', 'prof-1'],
    ['ecu.flash.alfid', '24'],
    ['ecu.flash.dfi', '0A'],
    ['ecu.flash.eraseAlfid', '44'],
    ['ecu.flash.maxBlockLen', '2048'],
    ['ecu.flash.regions.app.start', '00008000'],
    ['ecu.flash.regions.app.length', '0001F000'],
    ['ecu.ident.expectedHw', 'HW-1'],
    ['ecu.ident.expectedSparePart', ''],
    ['ecu.ident.vinDid', 'F190'],
    ['ecu.ident.swDid', 'F189'],
    ['ecu.ident.hwDid', 'F191'],
    ['ecu.ident.sparePartDid', 'F187'],
    ['ecu.vars.greeting', 'hello world'],
  ];
  for (const [path, want] of cases) {
    const r = one(path);
    ok(r.v === want && r.n === 0, `resolve {${path}} -> "${want}" (got ${JSON.stringify(r.v)}, ${r.n} errors)`);
  }

  // defaults when null / missing optional values
  const bare = mk('Bare');
  ok(resolveEcuRefs({ a: '{ecu.flash.maxBlockLen}', b: '{ecu.security.profileId}' }, bare).config['a'] === '0', 'maxBlockLen 0 when null');
  ok(resolveEcuRefs({ b: '{ecu.security.profileId}' }, bare).config['b'] === '', 'profileId "" when null');

  // substring, multiple, nested objects / arrays, non-strings untouched
  const cfg = {
    msg: 'ERASE={ecu.routines.erase} LVL={ecu.security.level}/{ecu.security.level}',
    nested: { deep: [{ rid: '{ecu.routines.check}' }, 7, true, null, ['x {ecu.name} y']] },
    num: 5,
    flag: false,
    plain: 'no refs {here}',
  };
  const before = JSON.stringify(cfg);
  const res = resolveEcuRefs(cfg, e);
  ok(res.errors.length === 0, 'nested resolve has no errors');
  ok(res.config['msg'] === 'ERASE=FF00 LVL=11/11', 'substring + repeated refs');
  const nested = res.config['nested'] as { deep: unknown[] };
  eq(nested.deep, [{ rid: '0001' }, 7, true, null, ['x Engine ECU y']], 'nested arrays / objects');
  ok(res.config['num'] === 5 && res.config['flag'] === false && res.config['plain'] === 'no refs {here}', 'non-ref values untouched');
  ok(JSON.stringify(cfg) === before, 'input config is not mutated');

  // errors: unknown path, missing key, error paths
  const bad = resolveEcuRefs({ a: '{ecu.bogus}', b: { c: ['{ecu.routines.nope}', 'ok {ecu.flash.regions.zzz.start}'] }, d: '{ecu.routines}', e: '{ecu.security.levels}', f: '{ecu.flash.regions.app.end}', g: '{ecu.}', h: '{ecu.name.x}', i: '{ecu.vars.nope}' }, e);
  eq(bad.errors.map((x) => x.key), ['ecu.bogus', 'ecu.routines.nope', 'ecu.flash.regions.zzz.start', 'ecu.routines', 'ecu.security.levels', 'ecu.flash.regions.app.end', 'ecu.', 'ecu.name.x', 'ecu.vars.nope'], 'unknown paths and missing keys are errors');
  eq(bad.errors.slice(0, 3).map((x) => x.path), ['a', 'b.c[0]', 'b.c[1]'], 'error paths');
  ok(bad.config['a'] === '{ecu.bogus}', 'unresolved reference is left in place');
  ok(resolveEcuRefs({ l: '{ecu.security.level}' }, bare).errors.length === 1, 'no levels -> {ecu.security.level} is an error');
  ok(resolveEcuRefs({ k: '{ecu.routines.__proto__}' }, e).errors.length === 1, 'prototype key is just a missing key');

  // list
  eq(listEcuRefs(cfg), ['ecu.routines.erase', 'ecu.security.level', 'ecu.routines.check', 'ecu.name'], 'listEcuRefs (unique, first-seen)');
  eq(listEcuRefs({ a: 1, b: ['x'] }), [], 'listEcuRefs none');
}

async function testHash(): Promise<void> {
  const e = resolverEcu();
  const h1 = await ecuSnapshotHash(e);
  ok(/^[0-9a-f]{64}$/.test(h1), 'sha-256 hex');
  // same content, different key order at every level
  const reordered = JSON.parse(JSON.stringify(e)) as Record<string, unknown>;
  const flipped: Record<string, unknown> = {};
  for (const k of Object.keys(reordered).reverse()) flipped[k] = reordered[k];
  const addr = flipped['addressing'] as Record<string, unknown>;
  const addrFlipped: Record<string, unknown> = {};
  for (const k of Object.keys(addr).reverse()) addrFlipped[k] = addr[k];
  flipped['addressing'] = addrFlipped;
  ok(JSON.stringify(flipped) !== JSON.stringify(e), 'test setup: key order really differs');
  ok((await ecuSnapshotHash(flipped as unknown as EcuRecordV1)) === h1, 'hash stable under key order');
  ok((await ecuSnapshotHash({ ...e, name: 'Other' })) !== h1, 'hash changes with content');
  ok(canonicalJson({ b: 1, a: { d: 1, c: [{ z: 1, y: 2 }] } }) === '{"a":{"c":[{"y":2,"z":1}],"d":1},"b":1}', 'canonical json sorts recursively');
  // known vector
  const empty = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('{}'));
  ok(Array.from(new Uint8Array(empty), (b) => b.toString(16).padStart(2, '0')).join('') === '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', 'sha-256 sanity');
}

// ── store ───────────────────────────────────────────────────────────────────
function testStore(): void {
  diagWorkspaceStore.reset();
  let mutations = 0;
  const off = diagWorkspaceStore.onMutation(() => { mutations += 1; });

  const vr = diagWorkspaceStore.createVehicle(' Car A ');
  ok(vr.ok, 'create vehicle');
  if (!vr.ok) return;
  const vid = vr.value;
  ok(diagWorkspaceStore.getState().activeVehicleId === vid, 'new vehicle becomes active');
  ok(diagWorkspaceStore.createVehicle('car a').ok && diagWorkspaceStore.getState().vehicles[1].name === 'car a (2)', 'duplicate vehicle name gets a suffix');
  ok(!diagWorkspaceStore.renameVehicle(vid, 'CAR A (2)').ok, 'rename to a clashing name refused');
  ok(diagWorkspaceStore.renameVehicle(vid, 'Car B').ok, 'rename vehicle');
  ok(!diagWorkspaceStore.renameVehicle(vid, '  ').ok, 'empty vehicle name refused');
  diagWorkspaceStore.selectVehicle(vid);

  const rev0 = diagWorkspaceStore.getState().vehicles[0].revision;
  const g1 = diagWorkspaceStore.createGroup(vid, 'Powertrain', 'amber');
  const g2 = diagWorkspaceStore.createGroup(vid, 'Body', 'cyan');
  ok(g1.ok && g2.ok, 'create groups');
  if (!g1.ok || !g2.ok) return;
  ok(!diagWorkspaceStore.createGroup(vid, ' powertrain ').ok, 'group names unique per vehicle');
  ok(diagWorkspaceStore.getActiveVehicle()?.revision === rev0 + 2, 'every mutation bumps the vehicle revision');

  const e1 = diagWorkspaceStore.createEcu(vid, { name: 'ECM', groupId: g1.value });
  const e2 = diagWorkspaceStore.createEcu(vid, { name: 'TCM', groupId: g1.value, addressing: { requestId: 0x7e1, responseId: 0x7e9 } });
  const e3 = diagWorkspaceStore.createEcu(vid, { name: 'BCM', groupId: null, addressing: { requestId: 0x7e2, responseId: 0x7ea } });
  ok(e1.ok && e2.ok && e3.ok, 'create ECUs');
  if (!e1.ok || !e2.ok || !e3.ok) return;
  const ecuOf = (id: string): EcuRecordV1 => {
    const f = diagWorkspaceStore.findEcu(id);
    if (!f) throw new Error('ecu missing');
    return f.ecu;
  };
  ok(ecuOf(e1.value).order === 0 && ecuOf(e2.value).order === 1, 'ECU order appended per group');

  // update bumps ECU + vehicle revision / updatedAt, keeps id / createdAt
  const beforeV = diagWorkspaceStore.getActiveVehicle()!.revision;
  const draft = { ...ecuOf(e1.value), name: 'ECM2', notes: 'x' };
  ok(diagWorkspaceStore.updateEcu(vid, draft).ok, 'update ECU');
  const upd = ecuOf(e1.value);
  ok(upd.name === 'ECM2' && upd.revision === 2 && upd.id === e1.value, 'ECU revision bumped');
  ok(diagWorkspaceStore.getActiveVehicle()!.revision === beforeV + 1, 'vehicle revision bumped by ECU update');
  ok(ecuOf(e2.value).revision === 1, 'other ECUs untouched');

  // duplicate
  const dup = diagWorkspaceStore.duplicateEcu(vid, e1.value);
  ok(dup.ok && ecuOf(dup.ok ? dup.value : '').name === 'ECM2 (2)' && ecuOf(dup.ok ? dup.value : '').id !== e1.value, 'duplicate: new id + suffixed name');

  // reorder / move
  ok(diagWorkspaceStore.reorderEcu(vid, e2.value, 0).ok, 'reorder ECU');
  ok(ecuOf(e2.value).order === 0 && ecuOf(e1.value).order === 1, 'ECU reorder renumbers the group');
  ok(diagWorkspaceStore.moveEcuToGroup(vid, e3.value, g2.value).ok && ecuOf(e3.value).groupId === g2.value, 'move ECU to group');
  ok(!diagWorkspaceStore.moveEcuToGroup(vid, e3.value, 'ghost').ok, 'move to unknown group refused');
  ok(diagWorkspaceStore.reorderGroup(vid, g2.value, 0).ok, 'reorder group');
  eq(diagWorkspaceStore.getActiveVehicle()!.groups.map((g) => [g.name, g.order]), [['Body', 0], ['Powertrain', 1]], 'group reorder renumbers');
  ok(diagWorkspaceStore.recolorGroup(vid, g1.value, 'violet').ok && diagWorkspaceStore.getActiveVehicle()!.groups.find((g) => g.id === g1.value)?.color === 'violet', 'recolor group');
  ok(diagWorkspaceStore.renameGroup(vid, g1.value, 'PT').ok && !diagWorkspaceStore.renameGroup(vid, g1.value, 'body').ok, 'rename group (unique)');

  // group delete: needs empty OR explicit moveEcusTo
  const snapshotBefore = diagWorkspaceStore.getState();
  const refused = diagWorkspaceStore.deleteGroup(vid, g1.value);
  ok(!refused.ok && refused.reason === 'not_empty' && diagWorkspaceStore.getState() === snapshotBefore, 'non-empty group delete refused, state untouched');
  ok(!diagWorkspaceStore.deleteGroup(vid, g1.value, 'ghost').ok, 'delete + move to unknown group refused');
  ok(diagWorkspaceStore.deleteGroup(vid, g1.value, g2.value).ok, 'delete group moving ECUs to another group');
  ok(ecuOf(e1.value).groupId === g2.value && ecuOf(e2.value).groupId === g2.value, 'members moved');
  const orders = diagWorkspaceStore.getActiveVehicle()!.ecus.filter((e) => e.groupId === g2.value).map((e) => e.order).sort();
  eq(orders, [...new Set(orders)], 'moved ECUs keep unique order values');
  ok(diagWorkspaceStore.deleteGroup(vid, g2.value, null).ok, 'delete group moving ECUs to ungrouped');
  ok(diagWorkspaceStore.getActiveVehicle()!.ecus.every((e) => e.groupId === null), 'all ungrouped');
  const g3 = diagWorkspaceStore.createGroup(vid, 'Empty');
  ok(g3.ok && diagWorkspaceStore.deleteGroup(vid, g3.ok ? g3.value : '').ok, 'empty group deletes without moveEcusTo');

  // bindings die with their ECU
  const b = diagWorkspaceStore.addBinding(vid, { ecuId: e1.value, flowRef: { flowId: 'f1', revision: 1 }, label: null, params: {} });
  ok(b.ok, 'binding stored');
  diagWorkspaceStore.addBinding(vid, { ecuId: e2.value, flowRef: { flowId: 'f1', revision: 1 }, label: 'L', params: {} });
  ok(diagWorkspaceStore.bindingsOfEcu(vid, e1.value).length === 1, 'bindingsOfEcu');
  const del = diagWorkspaceStore.deleteEcu(vid, e1.value);
  ok(del.ok && del.value === 1, 'deleteEcu reports removed bindings');
  ok(diagWorkspaceStore.getActiveVehicle()!.bindings.length === 1 && diagWorkspaceStore.findEcu(e1.value) === null, 'ECU and its bindings removed');

  // delete vehicle falls back to another active vehicle
  ok(diagWorkspaceStore.deleteVehicle(vid).ok, 'delete vehicle');
  ok(diagWorkspaceStore.getState().vehicles.length === 1 && diagWorkspaceStore.getState().activeVehicleId === diagWorkspaceStore.getState().vehicles[0].id, 'active vehicle falls back');

  ok(mutations > 20, `mutation hook fired for every user mutation (${mutations})`);
  const m = mutations;
  diagWorkspaceStore.load({ schemaVersion: 1, vehicles: [], activeVehicleId: null });
  diagWorkspaceStore.reset();
  ok(mutations === m, 'load / reset do not fire the mutation hook (no dirty on project load)');
  off();
}

// ── export -> import ────────────────────────────────────────────────────────
function testExchange(): void {
  const src = newVehicle('Src');
  src.groups.push({ id: 'ga', name: 'Powertrain', color: 'amber', order: 0 }, { id: 'gb', name: 'Body', color: 'cyan', order: 1 });
  const ecm = mk('ECM', { groupId: 'ga', order: 0, security: { seedKeyProfileId: 'gone-profile', levels: [{ key: 'prog', label: 'Programming', level: 0x11 }] }, routines: [{ key: 'erase', label: 'Erase', rid: 'FF00' }] });
  const tcm = mk('TCM', { groupId: 'ga', order: 1, addressing: { requestId: 0x7e1, responseId: 0x7e9 }, security: { seedKeyProfileId: 'kept-profile', levels: [] } });
  const bcm = mk('BCM', { groupId: 'gb', order: 0, addressing: { requestId: 0x7e2, responseId: 0x7ea } });
  const loose = mk('Loose', { groupId: null, order: 0, addressing: { requestId: 0x7e3, responseId: 0x7eb } });
  src.ecus.push(ecm, tcm, bcm, loose);
  src.bindings.push({ id: 'b', ecuId: ecm.id, flowRef: { flowId: 'f', revision: 1 }, label: null, params: {}, order: 0 });

  // whole vehicle
  const file = buildEcuFile(src, { kind: 'vehicle' }, '2026-11-18T00:00:00.000Z');
  ok(file !== null && file.kind === 'nexuscan.ecus' && file.schemaVersion === 1 && file.ecus.length === 4 && file.groups.length === 2, 'vehicle export shape');
  ok(!serializeEcuFile(file as NexusEcuFileV1).includes('"bindings"'), 'bindings are not exported');
  const grp = buildEcuFile(src, { kind: 'group', groupId: 'ga' });
  ok(grp !== null && grp.groups.length === 1 && grp.ecus.length === 2, 'group export = group + its ECUs');
  const one = buildEcuFile(src, { kind: 'ecu', ecuId: bcm.id });
  ok(one !== null && one.groups.length === 0 && one.ecus.length === 1 && one.ecus[0].groupId === null, 'single ECU export is ungrouped');
  ok(buildEcuFile(src, { kind: 'ecu', ecuId: 'nope' }) === null, 'unknown selection -> null');

  // round trip into an EMPTY vehicle: ids regenerated, no suffixes, structure preserved
  const text = serializeEcuFile(file as NexusEcuFileV1);
  const parsed: unknown = JSON.parse(text);
  const target = newVehicle('Dst');
  const known = new Set(['kept-profile']);
  const res = prepareEcuImport(parsed, target, known);
  ok(res.ok, 'import accepted');
  if (!res.ok) return;
  ok(res.ecus.length === 4 && res.groups.length === 2, 'all records imported');
  const srcIds = new Set([...src.ecus.map((e) => e.id), ...src.groups.map((g) => g.id)]);
  ok([...res.ecus, ...res.groups].every((x) => !srcIds.has(x.id)), 'ids regenerated');
  ok(new Set([...res.ecus, ...res.groups].map((x) => x.id)).size === 6, 'new ids unique');
  ok(res.report.renamedEcus.length === 0 && res.report.renamedGroups.length === 0, 'no suffix without clashes');
  const byName = (n: string): EcuRecordV1 => res.ecus.find((e) => e.name === n)!;
  const gName = (id: string | null): string | undefined => res.groups.find((g) => g.id === id)?.name;
  eq([gName(byName('ECM').groupId), gName(byName('TCM').groupId), gName(byName('BCM').groupId), byName('Loose').groupId], ['Powertrain', 'Powertrain', 'Body', null], 'group membership remapped');
  ok(res.ecus.every((e) => e.source === 'import' && e.revision === 1), 'source=import, revision 1');
  eq(byName('ECM').routines, ecm.routines, 'record content preserved');
  eq(byName('ECM').addressing, ecm.addressing, 'addressing preserved');
  ok(byName('ECM').security.seedKeyProfileId === null, 'unknown seedKeyProfileId cleared');
  ok(byName('TCM').security.seedKeyProfileId === 'kept-profile', 'known seedKeyProfileId kept');
  eq(res.report.clearedSeedKeyProfiles, [{ ecuName: 'ECM', profileId: 'gone-profile' }], 'cleared profile reported');
  eq(res.groups.map((g) => g.color), ['amber', 'cyan'], 'group colors preserved');
  ok(res.ecus.filter((e) => e.groupId === res.groups[0].id).map((e) => e.order).join() === '0,1', 'ECU order preserved within group');

  // name clashes (against the target AND within the file), repeated import
  const dst2 = newVehicle('Dst2');
  dst2.groups.push({ id: 'x', name: 'powertrain', color: 'red', order: 4 });
  dst2.ecus.push(mk('ecm', { addressing: { requestId: 0x100, responseId: 0x101 }, groupId: 'x', order: 7 }));
  const res2 = prepareEcuImport(parsed, dst2, known);
  ok(res2.ok, 'import into populated vehicle');
  if (!res2.ok) return;
  ok(res2.groups.map((g) => g.name).join() === 'Powertrain (2),Body', 'clashing group gets " (2)"');
  ok(res2.ecus.map((e) => e.name).join() === 'ECM (2),TCM,BCM,Loose', 'clashing ECU gets " (2)"');
  ok(res2.groups[0].order === 5, 'imported groups are appended after existing orders');
  ok(res2.ecus.find((e) => e.groupId === null)?.order === 0, 'ungrouped order starts at the first free slot');
  const merged = { ...dst2, groups: [...dst2.groups, ...res2.groups], ecus: [...dst2.ecus, ...res2.ecus] };
  const res3 = prepareEcuImport(parsed, merged, known);
  ok(res3.ok && res3.ecus[0].name === 'ECM (3)' && res3.groups[0].name === 'Powertrain (3)', 'second import continues the numbering');
  ok(prepareEcuImport(parsed, target, new Set()).ok && (() => { const r = prepareEcuImport(parsed, target, new Set()); return r.ok && r.report.clearedSeedKeyProfiles.length === 2; })(), 'empty profile list clears every reference');

  // strict rejection
  const reject = (raw: unknown, why: string): void => ok(!prepareEcuImport(raw, target, known).ok, `rejects ${why}`);
  reject('x', 'non-object');
  reject({ ...(parsed as object), kind: 'other' }, 'wrong kind');
  reject({ ...(parsed as object), schemaVersion: 2 }, 'wrong schemaVersion');
  reject({ ...(parsed as object), ecus: 'x' }, 'ecus not an array');
  reject({ ...(parsed as object), ecus: [] }, 'no ECUs');
  reject({ ...(parsed as object), ecus: [...(file as NexusEcuFileV1).ecus, { id: 'bad' }] }, 'a malformed ECU entry');
  reject({ ...(parsed as object), ecus: [{ ...(file as NexusEcuFileV1).ecus[0], protocol: 'lin' }] }, 'unknown protocol');
  reject({ ...(parsed as object), ecus: [{ ...(file as NexusEcuFileV1).ecus[0], groupId: 'ghost-group' }] }, 'dangling group reference');
  ok(prepareEcuImport(parsed, target, known).ok, 'the same file is still fine after the rejections (no shared state)');
}

async function main(): Promise<void> {
  testDefaults();
  testSanitize();
  testProjectSanitize();
  testValidation();
  testResolver();
  await testHash();
  testStore();
  testExchange();
  console.log(`diagWorkspace.test: ${passed} checks passed`);
}

await main();
