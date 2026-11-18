/**
 * `{ecu.*}` references (diag-workspace-v1 §5). Pure. Closed path list - anything else is an error.
 *
 *   ecu.name | ecu.routines.<key> | ecu.security.level | ecu.security.levels.<key> | ecu.security.profileId
 *   ecu.flash.alfid | .dfi | .eraseAlfid | .maxBlockLen | ecu.flash.regions.<key>.start | .length
 *   ecu.ident.expectedHw | .expectedSparePart | .vinDid | .swDid | .hwDid | .sparePartDid | ecu.vars.<key>
 *
 * Every resolved value is a string (hex upper-case and zero-padded: routines / DIDs 4, levels / alfid / dfi 2,
 * region start / length 8; `maxBlockLen` decimal).
 */
import type { EcuRecordV1 } from '../../../types/diagWorkspace';

export interface EcuRefError {
  /** Location inside the config (`steps[2].rid`). Empty string = the config root. */
  path: string;
  /** The reference path without braces (`ecu.routines.erase`). */
  key: string;
  message: string;
}

export interface EcuRefResolution {
  config: Record<string, unknown>;
  errors: EcuRefError[];
}

const REF_RE = /\{ecu\.([^{}]*)\}/g;
const WHOLE_RE = /^\{ecu\.([^{}]*)\}$/;
const MAX_DEPTH = 64;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Unique `ecu.<path>` references (first-seen order) found in any string value of `config`. */
export function listEcuRefs(config: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (typeof v === 'string') {
      for (const m of v.matchAll(REF_RE)) seen.add(`ecu.${m[1]}`);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (isRecord(v)) {
      for (const k of Object.keys(v)) walk(v[k], depth + 1);
    }
  };
  walk(config, 0);
  return [...seen];
}

function hex(n: number, width: number): string {
  return Math.trunc(n).toString(16).toUpperCase().padStart(width, '0');
}

function hexText(s: string, width: number): string {
  return s.trim().toUpperCase().padStart(width, '0');
}

type Lookup = { ok: true; value: string } | { ok: false; message: string };
const fail = (message: string): Lookup => ({ ok: false, message });
const val = (value: string): Lookup => ({ ok: true, value });

/** Resolves ONE reference path (`ecu.routines.erase`) against `ecu`. */
export function lookupEcuRef(path: string, ecu: EcuRecordV1): Lookup {
  const p = path.split('.');
  if (p[0] !== 'ecu') return fail(`unknown reference "${path}"`);
  const [, a, b, c, d] = p;
  const n = p.length;
  if (n === 2 && a === 'name') return val(ecu.name);
  if (n === 3 && a === 'routines') {
    const r = ecu.routines.find((x) => x.key === b);
    return r ? val(hexText(r.rid, 4)) : fail(`ECU "${ecu.name}" has no routine "${b}"`);
  }
  if (a === 'security') {
    if (n === 3 && b === 'level') {
      const first = ecu.security.levels[0];
      return first ? val(hex(first.level, 2)) : fail(`ECU "${ecu.name}" has no security level`);
    }
    if (n === 4 && b === 'levels') {
      const l = ecu.security.levels.find((x) => x.key === c);
      return l ? val(hex(l.level, 2)) : fail(`ECU "${ecu.name}" has no security level "${c}"`);
    }
    if (n === 3 && b === 'profileId') return val(ecu.security.seedKeyProfileId ?? '');
    return fail(`unknown reference "${path}"`);
  }
  if (a === 'flash') {
    if (n === 3 && b === 'alfid') return val(hex(ecu.flash.alfid, 2));
    if (n === 3 && b === 'dfi') return val(hex(ecu.flash.dfi, 2));
    if (n === 3 && b === 'eraseAlfid') return val(hex(ecu.flash.eraseAlfid, 2));
    if (n === 3 && b === 'maxBlockLen') return val(String(ecu.flash.maxBlockLenOverride ?? 0));
    if (n === 5 && b === 'regions' && (d === 'start' || d === 'length')) {
      const r = ecu.flash.memoryRegions.find((x) => x.key === c);
      return r ? val(hex(d === 'start' ? r.start : r.length, 8)) : fail(`ECU "${ecu.name}" has no memory region "${c}"`);
    }
    return fail(`unknown reference "${path}"`);
  }
  if (a === 'ident' && n === 3) {
    const id = ecu.identification;
    switch (b) {
      case 'expectedHw': return val(id.expectedHw ?? '');
      case 'expectedSparePart': return val(id.expectedSparePart ?? '');
      case 'vinDid': return val(hexText(id.vinDid, 4));
      case 'swDid': return val(hexText(id.swDid, 4));
      case 'hwDid': return val(hexText(id.hwDid, 4));
      case 'sparePartDid': return val(hexText(id.sparePartDid, 4));
      default: return fail(`unknown reference "${path}"`);
    }
  }
  if (n === 3 && a === 'vars') {
    const v = ecu.vars.find((x) => x.key === b);
    return v ? val(v.value) : fail(`ECU "${ecu.name}" has no variable "${b}"`);
  }
  return fail(`unknown reference "${path}"`);
}

/**
 * Deep-copies `config` replacing every `{ecu.<path>}` (whole value or substring). Unresolvable references
 * are reported and left untouched in the copy; the input is never mutated. Object KEYS are not resolved.
 */
export function resolveEcuRefs(config: Record<string, unknown>, ecu: EcuRecordV1): EcuRefResolution {
  const errors: EcuRefError[] = [];
  const resolveString = (s: string, where: string): string => {
    const whole = WHOLE_RE.exec(s);
    if (whole) {
      const r = lookupEcuRef(`ecu.${whole[1]}`, ecu);
      if (r.ok) return r.value;
      errors.push({ path: where, key: `ecu.${whole[1]}`, message: r.message });
      return s;
    }
    return s.replace(REF_RE, (match: string, inner: string) => {
      const r = lookupEcuRef(`ecu.${inner}`, ecu);
      if (r.ok) return r.value;
      errors.push({ path: where, key: `ecu.${inner}`, message: r.message });
      return match;
    });
  };
  const walk = (v: unknown, where: string, depth: number): unknown => {
    if (depth > MAX_DEPTH) return v;
    if (typeof v === 'string') return resolveString(v, where);
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${where}[${i}]`, depth + 1));
    if (isRecord(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k], where === '' ? k : `${where}.${k}`, depth + 1);
      return out;
    }
    return v;
  };
  return { config: walk(config, '', 0) as Record<string, unknown>, errors };
}

/** JSON with recursively sorted object keys (stable under key order). `undefined` properties are dropped. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (isRecord(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        const x = v[k];
        if (x !== undefined) out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/** SHA-256 (lower-case hex) over the canonical JSON of the ECU record (for run records). */
export async function ecuSnapshotHash(ecu: EcuRecordV1): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(ecu));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
