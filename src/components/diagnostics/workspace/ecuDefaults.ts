/**
 * Defaults + constructors for the ECU registry records (diag-workspace-v1 §4). Pure: no React, no i18n.
 */
import type {
  EcuAddressingV1,
  EcuFlashParamsV1,
  EcuIdentificationV1,
  EcuRecordV1,
  EcuSecurityV1,
  EcuTimingV1,
  DiagVehicleV1,
} from '../../../types/diagWorkspace';

export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const r = (): string => Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  return `${r()}-${r().slice(0, 4)}-4${r().slice(0, 3)}-a${r().slice(0, 3)}-${r()}${r().slice(0, 4)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function defaultAddressing(): EcuAddressingV1 {
  return {
    requestId: 0x7e0,
    responseId: 0x7e8,
    isExtendedId: false,
    functionalId: null,
    addressFormat: 'normal',
    targetAddress: null,
    responseAddress: null,
    padding: 0xaa,
    useFd: false,
  };
}

export function defaultTiming(): EcuTimingV1 {
  return { p2MarginMs: 100, keepaliveIntervalMs: 2000 };
}

export function defaultSecurity(): EcuSecurityV1 {
  return { seedKeyProfileId: null, levels: [] };
}

export function defaultFlash(): EcuFlashParamsV1 {
  return { alfid: 0x44, dfi: 0x00, maxBlockLenOverride: null, eraseAlfid: 0x44, memoryRegions: [] };
}

export function defaultIdentification(): EcuIdentificationV1 {
  return {
    expectedHw: null,
    expectedSparePart: null,
    vinDid: 'F190',
    swDid: 'F189',
    hwDid: 'F191',
    sparePartDid: 'F187',
  };
}

export type EcuRecordInit = Partial<
  Omit<EcuRecordV1, 'addressing' | 'timing' | 'security' | 'flash' | 'identification'>
> & {
  addressing?: Partial<EcuAddressingV1>;
  timing?: Partial<EcuTimingV1>;
  security?: Partial<EcuSecurityV1>;
  flash?: Partial<EcuFlashParamsV1>;
  identification?: Partial<EcuIdentificationV1>;
};

/** New ECU record with contract defaults; every field of `partial` overrides its default. */
export function newEcuRecord(partial: EcuRecordInit = {}): EcuRecordV1 {
  const now = nowIso();
  return {
    id: partial.id ?? newId(),
    name: partial.name ?? '',
    groupId: partial.groupId ?? null,
    order: partial.order ?? 0,
    notes: partial.notes ?? '',
    source: partial.source ?? 'manual',
    protocol: partial.protocol ?? 'uds_can',
    connectionProfileId: partial.connectionProfileId ?? null,
    addressing: { ...defaultAddressing(), ...partial.addressing },
    timing: { ...defaultTiming(), ...partial.timing },
    security: { ...defaultSecurity(), ...partial.security },
    routines: partial.routines ?? [],
    flash: { ...defaultFlash(), ...partial.flash },
    identification: { ...defaultIdentification(), ...partial.identification },
    dids: partial.dids ?? [],
    vars: partial.vars ?? [],
    revision: partial.revision ?? 1,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
}

export function newVehicle(name: string): DiagVehicleV1 {
  const now = nowIso();
  return {
    id: newId(),
    name,
    notes: '',
    groups: [],
    ecus: [],
    bindings: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/** Deep copy of plain JSON-like registry data (records contain no functions / dates / cycles). */
export function cloneRecord<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** `base`, or `base (2)`, `base (3)` ... the first not present (trim + case-insensitive) in `taken`. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set<string>();
  for (const n of taken) set.add(n.trim().toLowerCase());
  const root = base.trim();
  if (!set.has(root.toLowerCase())) return root;
  for (let i = 2; i < 10_000; i += 1) {
    const cand = `${root} (${i})`;
    if (!set.has(cand.toLowerCase())) return cand;
  }
  return `${root} (${newId().slice(0, 6)})`;
}
