/**
 * Core block pack (diag-workspace-v1 §8.1): PURE evaluation functions shared by BOTH flow engines
 * (simulated and real) so their semantics cannot diverge: typed variables + coercion, math, logic,
 * convert, `{name}` text templates and the `flow_for` range rules.
 *
 * Rule: reads are pure, writes happen only on the exec path (`var_set`). Nothing here touches a
 * transport, a store or a clock.
 */
import { t } from '../../i18n';
import type { FlowVariableDeclV1, FlowVariableType } from '../../types/flowLibrary';
import { textToAscii } from './flowData';
import { asBytes, hexField, hexList, numeric, toBool } from './flowValues';

/** Runtime value of a variable / data port in the core pack. */
export type CoreValue = number | string | boolean | Uint8Array;

export const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
export const FOR_ITERATION_CAP = 100_000;

export const MATH_OPS = ['add', 'sub', 'mul', 'div', 'mod', 'min', 'max', 'abs', 'round', 'floor'] as const;
export type MathOp = (typeof MATH_OPS)[number];
export const MATH_UNARY: ReadonlySet<string> = new Set(['abs', 'round', 'floor']);

export const LOGIC_OPS = ['and', 'or', 'xor', 'not'] as const;
export type LogicOp = (typeof LOGIC_OPS)[number];

export const CONVERT_TARGETS = ['number', 'text', 'hex', 'bytes'] as const;
export type ConvertTarget = (typeof CONVERT_TARGETS)[number];

export type Endianness = 'big' | 'little';

export function isValidVarName(name: string): boolean {
  return VAR_NAME_RE.test(name);
}

// ─── Scope (one per call frame; Phase B pushes / pops frames by swapping `RunContext.scope`) ────────

export interface FlowScope {
  /** Declared type per variable (immutable for the frame). */
  readonly types: Map<string, FlowVariableType>;
  /** Current values. */
  readonly vars: Map<string, CoreValue>;
  /** Per-block run-local values (`flow_for` current index, keyed by block id). */
  readonly locals: Map<string, CoreValue>;
}

/** Fresh frame: every declared variable reset to its typed initial value. Throws on an invalid initial. */
export function createScope(decls: readonly FlowVariableDeclV1[] = []): FlowScope {
  const scope: FlowScope = { types: new Map(), vars: new Map(), locals: new Map() };
  for (const d of decls) {
    scope.types.set(d.name, d.type);
    scope.vars.set(d.name, parseInitial(d));
  }
  return scope;
}

// ─── Typed initial values & coercion ───────────────────────────────────────────────────────────────

function bad(code: string, message: string): Error {
  const e = new Error(message);
  e.name = code;
  return e;
}

/** Typed initial value of a declaration (`number`: decimal text, `bytes`: hex text, `bool`: "true" | "false"). */
export function parseInitial(decl: FlowVariableDeclV1): CoreValue {
  const raw = decl.initial;
  switch (decl.type) {
    case 'number': {
      const n = numeric(raw.trim());
      if (!Number.isFinite(n)) throw bad('decl_initial', t('flowCore.err.initial', { name: decl.name, type: decl.type, value: raw }));
      return n;
    }
    case 'bool': {
      const s = raw.trim().toLowerCase();
      if (s === 'true') return true;
      if (s === 'false') return false;
      throw bad('decl_initial', t('flowCore.err.initial', { name: decl.name, type: decl.type, value: raw }));
    }
    case 'bytes': {
      if (raw.trim() === '') return new Uint8Array(0);
      try {
        return Uint8Array.from(hexField(raw, decl.name));
      } catch {
        throw bad('decl_initial', t('flowCore.err.initial', { name: decl.name, type: decl.type, value: raw }));
      }
    }
    default:
      return raw;
  }
}

/** Display text of a value: bytes = spaced uppercase hex, numbers decimal, bool `true` / `false`. */
export function formatValue(v: unknown): string {
  const b = asBytes(v);
  if (b) return hexList(b);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v) ?? '';
}

/**
 * Implicit coercion to a declared variable type (`var_set` mode set). Lossless rules only:
 * number <- number | bool | numeric text | <=6 bytes (big-endian); text <- any (bytes as hex, use `convert` for ASCII);
 * bool <- bool | number | true/false/1/0 text | bytes; bytes <- bytes | hex text. Anything else throws.
 */
export function coerceValue(v: unknown, type: FlowVariableType, blockLabel: string, what: string): CoreValue {
  const fail = (): Error => bad('coerce', t('flowCore.err.coerce', { block: blockLabel, what, type, value: formatValue(v) }));
  switch (type) {
    case 'number': {
      const n = numeric(v);
      if (!Number.isFinite(n)) throw fail();
      return n;
    }
    case 'text':
      if (v === undefined || v === null) throw fail();
      return formatValue(v);
    case 'bool': {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === 'true' || s === '1') return true;
        if (s === 'false' || s === '0') return false;
        throw fail();
      }
      const b = asBytes(v);
      if (b) return toBool(b);
      throw fail();
    }
    case 'bytes': {
      const b = asBytes(v);
      if (b) return b;
      if (typeof v === 'string') {
        if (v.trim() === '') return new Uint8Array(0);
        try {
          return Uint8Array.from(hexField(v, what));
        } catch {
          throw fail();
        }
      }
      throw fail();
    }
  }
}

// ─── math / logic ──────────────────────────────────────────────────────────────────────────────────

function operand(v: unknown, blockLabel: string): number {
  const n = numeric(v);
  if (!Number.isFinite(n)) throw bad('math_nan', t('flowCore.err.mathNaN', { block: blockLabel, value: formatValue(v) }));
  return n;
}

/**
 * `math`: add sub mul div mod min max abs round floor (abs / round / floor are unary: `b` ignored).
 * Division / modulo by zero, non-numeric operands and non-finite results are run errors.
 * `mod` is the JS remainder (sign of the dividend); `round` rounds half toward +infinity.
 */
export function mathOp(op: string, a: unknown, b: unknown, blockLabel: string): number {
  if (!(MATH_OPS as readonly string[]).includes(op)) throw bad('op', t('flowCore.err.opUnknown', { block: blockLabel, op }));
  const x = operand(a, blockLabel);
  let r: number;
  if (MATH_UNARY.has(op)) {
    r = op === 'abs' ? Math.abs(x) : op === 'round' ? Math.round(x) : Math.floor(x);
  } else {
    const y = operand(b, blockLabel);
    switch (op) {
      case 'add': r = x + y; break;
      case 'sub': r = x - y; break;
      case 'mul': r = x * y; break;
      case 'div':
        if (y === 0) throw bad('math_div0', t('flowCore.err.mathDiv0', { block: blockLabel }));
        r = x / y;
        break;
      case 'mod':
        if (y === 0) throw bad('math_div0', t('flowCore.err.mathDiv0', { block: blockLabel }));
        r = x % y;
        break;
      case 'min': r = Math.min(x, y); break;
      default: r = Math.max(x, y); break;
    }
  }
  if (!Number.isFinite(r)) throw bad('math_range', t('flowCore.err.mathRange', { block: blockLabel }));
  return r;
}

/** `logic`: and or xor not (`b` unused for `not`). Operands use the engine's truthiness (`toBool`). */
export function logicOp(op: string, a: unknown, b: unknown, blockLabel: string): boolean {
  if (!(LOGIC_OPS as readonly string[]).includes(op)) throw bad('op', t('flowCore.err.opUnknown', { block: blockLabel, op }));
  const x = toBool(a);
  if (op === 'not') return !x;
  const y = toBool(b);
  switch (op) {
    case 'and': return x && y;
    case 'or': return x || y;
    default: return x !== y;
  }
}

// ─── convert ───────────────────────────────────────────────────────────────────────────────────────

export interface ConvertConfig {
  target: string;
  byteLength: number;
  endianness: Endianness;
}

/** Unsigned integer -> `len` bytes (exact for safe integers, no 32-bit bit-ops). */
export function numberToBytes(n: number, len: number, endianness: Endianness, blockLabel: string): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw bad('convert_int', t('flowCore.err.convertInt', { block: blockLabel, value: String(n) }));
  const out = new Uint8Array(len);
  let rest = n;
  for (let i = 0; i < len; i++) {
    out[endianness === 'big' ? len - 1 - i : i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  if (rest !== 0) throw bad('convert_fit', t('flowCore.err.convertFit', { block: blockLabel, value: String(n), n: len }));
  return out;
}

/** Bytes -> unsigned integer (at most 6 bytes: exact in a JS number). */
export function bytesToNumber(b: Uint8Array, endianness: Endianness, blockLabel: string): number {
  if (b.length === 0 || b.length > 6) throw bad('convert_long', t('flowCore.err.convertLong', { block: blockLabel, n: b.length }));
  const seq = endianness === 'big' ? Array.from(b) : Array.from(b).reverse();
  return seq.reduce((acc, x) => acc * 256 + x, 0);
}

function asciiBytesToText(b: Uint8Array): string {
  return Array.from(b, (x) => (x >= 0x20 && x <= 0x7e ? String.fromCharCode(x) : '.')).join('');
}

/**
 * `convert` to `number | text | hex | bytes`.
 * - number: number | bool | numeric text | bytes (endianness-aware, <=6 bytes)
 * - text: bytes -> ASCII (non-printable -> "."), number -> decimal, bool -> true/false
 * - hex: bytes -> spaced uppercase hex, number -> big-endian minimal hex, text -> ASCII bytes as hex
 * - bytes: number -> `byteLength` bytes (endianness-aware, must fit), text -> ASCII, bool -> 1 byte
 */
export function convertValue(v: unknown, cfg: ConvertConfig, blockLabel: string): CoreValue {
  const len = cfg.byteLength;
  if (!Number.isInteger(len) || len < 1 || len > 8) throw bad('convert_len', t('flowCore.err.convertLen', { block: blockLabel }));
  const endian: Endianness = cfg.endianness === 'little' ? 'little' : 'big';
  const bytes = asBytes(v);
  switch (cfg.target) {
    case 'number': {
      if (bytes) return bytesToNumber(bytes, endian, blockLabel);
      const n = numeric(v);
      if (!Number.isFinite(n)) throw bad('convert_nan', t('flowCore.err.mathNaN', { block: blockLabel, value: formatValue(v) }));
      return n;
    }
    case 'text':
      return bytes ? asciiBytesToText(bytes) : formatValue(v);
    case 'hex': {
      if (bytes) return hexList(bytes);
      if (typeof v === 'number') {
        if (!Number.isSafeInteger(v) || v < 0) throw bad('convert_int', t('flowCore.err.convertInt', { block: blockLabel, value: String(v) }));
        const digits = v.toString(16).toUpperCase();
        return hexList(hexField(digits, blockLabel));
      }
      if (typeof v === 'boolean') return v ? '01' : '00';
      return hexList(asciiOf(v, blockLabel));
    }
    case 'bytes': {
      if (bytes) return bytes;
      if (typeof v === 'number') return numberToBytes(v, len, endian, blockLabel);
      if (typeof v === 'boolean') return Uint8Array.of(v ? 1 : 0);
      return asciiOf(v, blockLabel);
    }
    default:
      throw bad('convert_target', t('flowCore.err.opUnknown', { block: blockLabel, op: cfg.target }));
  }
}

function asciiOf(v: unknown, blockLabel: string): Uint8Array {
  try {
    return Uint8Array.from(textToAscii(formatValue(v)));
  } catch (e) {
    throw bad('convert_ascii', `${blockLabel}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── `{name}` templates ────────────────────────────────────────────────────────────────────────────

export type TemplatePart = { kind: 'lit'; text: string } | { kind: 'ph'; name: string };

const PLACEHOLDER_RE = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/;

/**
 * Splits a template into literals and `{name}` placeholders. `{{` / `}}` are literal braces; a `{`
 * that does not start a well-formed `{identifier}` stays literal text (so JSON-ish messages are safe).
 */
export function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let lit = '';
  const flush = (): void => {
    if (lit !== '') parts.push({ kind: 'lit', text: lit });
    lit = '';
  };
  let i = 0;
  while (i < template.length) {
    const c = template[i];
    if (c === '{' && template[i + 1] === '{') {
      lit += '{';
      i += 2;
    } else if (c === '}' && template[i + 1] === '}') {
      lit += '}';
      i += 2;
    } else if (c === '{') {
      const m = PLACEHOLDER_RE.exec(template.slice(i));
      if (m) {
        flush();
        parts.push({ kind: 'ph', name: m[1] });
        i += m[0].length;
      } else {
        lit += c;
        i += 1;
      }
    } else {
      lit += c;
      i += 1;
    }
  }
  flush();
  return parts;
}

/** Distinct placeholder names in first-use order. */
export function templatePlaceholders(template: string): string[] {
  const seen: string[] = [];
  for (const p of parseTemplate(template)) if (p.kind === 'ph' && !seen.includes(p.name)) seen.push(p.name);
  return seen;
}

export function hasPlaceholder(template: string, name: string): boolean {
  return templatePlaceholders(template).includes(name);
}

/** Renders a template; `resolve` returns the value of a name (throws for unknown / unavailable names). */
export function renderTemplate(template: string, resolve: (name: string) => unknown): string {
  return parseTemplate(template)
    .map((p) => (p.kind === 'lit' ? p.text : formatValue(resolve(p.name))))
    .join('');
}

/** Replaces `{old}` with `{new}` (placeholders only; literals / escapes untouched). */
export function renamePlaceholder(template: string, oldName: string, newName: string): string {
  if (!hasPlaceholder(template, oldName)) return template;
  return parseTemplate(template)
    .map((p) => {
      if (p.kind === 'ph') return `{${p.name === oldName ? newName : p.name}}`;
      return p.text.replace(/\{/g, '{{').replace(/\}/g, '}}');
    })
    .join('');
}

// ─── flow_for range ────────────────────────────────────────────────────────────────────────────────

export interface ForRange {
  from: number;
  to: number;
  step: number;
}

export type ForRangeError = 'not_finite' | 'step_zero' | 'step_sign';

/** `step` must be non-zero and point from `from` towards `to` (`from === to` is a single iteration). */
export function checkForRange(r: ForRange): ForRangeError | null {
  if (!Number.isFinite(r.from) || !Number.isFinite(r.to) || !Number.isFinite(r.step)) return 'not_finite';
  if (r.step === 0) return 'step_zero';
  if ((r.step > 0 && r.from > r.to) || (r.step < 0 && r.from < r.to)) return 'step_sign';
  return null;
}

export function forRangeMessage(err: ForRangeError, r: ForRange, blockLabel: string): string {
  switch (err) {
    case 'not_finite': return t('flowCore.err.forNum', { block: blockLabel });
    case 'step_zero':  return t('flowCore.err.forStep0', { block: blockLabel });
    case 'step_sign':  return t('flowCore.err.forSign', { block: blockLabel, from: r.from, to: r.to, step: r.step });
  }
}

/** Value of iteration `n` (0-based) or `null` once the (inclusive) range is exhausted. */
export function forValueAt(r: ForRange, n: number): number | null {
  const v = r.from + n * r.step;
  const eps = Math.abs(r.step) * 1e-9;
  if (r.step > 0 ? v > r.to + eps : v < r.to - eps) return null;
  return v;
}
