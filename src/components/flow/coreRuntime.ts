/**
 * Graph-aware part of the core block pack (diag-workspace-v1 §8.1). Used by BOTH engines through
 * `RealFlowExecutor` (pure evaluation) and `FlowEngine.dispatchCore` (exec blocks), so the simulated
 * and the real engine run the very same code for variables, math, logic, convert, text and loops.
 */
import { t } from '../../i18n';
import type { FlowBlock } from './types';
import {
  convertValue,
  coerceValue,
  checkForRange,
  forRangeMessage,
  formatValue,
  hasPlaceholder,
  logicOp,
  mathOp,
  renderTemplate,
  type ConvertConfig,
  type CoreValue,
  type Endianness,
  type FlowScope,
  type ForRange,
} from './coreBlocks';
import { numeric, valueText } from './flowValues';

/** Reads data inputs of a block (implemented by `RealFlowExecutor`). */
export interface CoreReader {
  /** Value on a connected input port, `undefined` when the port is not connected. */
  optional(block: FlowBlock, portId: string, depth: number): Promise<unknown>;
}

/** Pure core blocks: evaluated lazily when read. */
export const CORE_PURE_BLOCKS: ReadonlySet<string> = new Set(['var_get', 'math', 'logic', 'convert', 'text_format']);

/** Exec blocks run by `FlowEngine.dispatchCore` identically in simulated and real mode. */
export const CORE_EXEC_BLOCKS: ReadonlySet<string> = new Set(['var_set', 'flow_for', 'flow_break', 'flow_continue', 'log']);

/** Default / maximum of `flow_while.max_iterations` (reaching the cap with a true condition is a run error). */
export const WHILE_DEFAULT_MAX = 10_000;
export const WHILE_MAX_LIMIT = 1_000_000;

/** Loop drivers (a `flow_break` / `flow_continue` acts on the nearest one). */
export const LOOP_BLOCKS: ReadonlySet<string> = new Set(['loop', 'flow_while', 'flow_for']);

export function cfgString(block: FlowBlock, key: string, fallback = ''): string {
  const v = block.config[key];
  return v === undefined || v === null ? fallback : String(v);
}

/** Dynamic input port ids of a `text_format` block (config `inputs: string[]`). */
export function formatInputs(block: FlowBlock): string[] {
  const raw = block.config['inputs'];
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

async function need(rd: CoreReader, block: FlowBlock, portId: string, depth: number): Promise<unknown> {
  const v = await rd.optional(block, portId, depth);
  if (v === undefined) throw new Error(t('diagReal.flow.noInput', { block: block.label, port: portId }));
  return v;
}

function scopeValue(scope: FlowScope, name: string, block: FlowBlock): CoreValue {
  const v = scope.vars.get(name);
  if (v === undefined) throw new Error(t('flowCore.err.varUnknown', { block: block.label, name }));
  return v;
}

/** Value of `{name}` for a template of `block`: extra names (e.g. `value`), then input ports, then variables. */
async function resolvePlaceholder(
  block: FlowBlock,
  name: string,
  rd: CoreReader,
  scope: FlowScope,
  depth: number,
  inputs: readonly string[],
): Promise<unknown> {
  if (inputs.includes(name)) {
    const v = await rd.optional(block, name, depth);
    if (v === undefined) throw new Error(t('flowCore.err.tplInputMissing', { block: block.label, name }));
    return v;
  }
  if (scope.vars.has(name)) return scope.vars.get(name);
  throw new Error(t('flowCore.err.tplUnknown', { block: block.label, name }));
}

/** Pre-resolves every placeholder (async) then renders synchronously. */
async function renderAsync(
  block: FlowBlock,
  template: string,
  rd: CoreReader,
  scope: FlowScope,
  depth: number,
  inputs: readonly string[],
  extra: ReadonlyMap<string, unknown>,
): Promise<string> {
  const cache = new Map<string, unknown>(extra);
  const names = new Set<string>();
  renderTemplate(template, (n) => {
    names.add(n);
    return '';
  });
  for (const n of names) {
    if (!cache.has(n)) cache.set(n, await resolvePlaceholder(block, n, rd, scope, depth, inputs));
  }
  return renderTemplate(template, (n) => cache.get(n));
}

/** Evaluates a pure core block (the value of its single data output). */
export async function evalCorePure(block: FlowBlock, rd: CoreReader, scope: FlowScope, depth: number): Promise<unknown> {
  const cfg = block.config;
  switch (block.type) {
    case 'var_get':
      return scopeValue(scope, cfgString(block, 'name'), block);

    case 'math': {
      const op = cfgString(block, 'op', 'add');
      const a = await need(rd, block, 'a_in', depth);
      const bIn = await rd.optional(block, 'b_in', depth);
      return mathOp(op, a, bIn !== undefined ? bIn : numeric(cfg['b'] ?? 0), block.label);
    }

    case 'logic': {
      const op = cfgString(block, 'op', 'and');
      const a = await need(rd, block, 'a_in', depth);
      const b = op === 'not' ? undefined : await need(rd, block, 'b_in', depth);
      return logicOp(op, a, b, block.label);
    }

    case 'convert': {
      const v = await need(rd, block, 'value_in', depth);
      const conv: ConvertConfig = {
        target: cfgString(block, 'target', 'number'),
        byteLength: Number(cfg['byteLength'] ?? 1),
        endianness: (cfgString(block, 'endianness', 'big') === 'little' ? 'little' : 'big') as Endianness,
      };
      return convertValue(v, conv, block.label);
    }

    case 'text_format':
      return renderAsync(block, cfgString(block, 'template'), rd, scope, depth, formatInputs(block), new Map());

    default:
      throw new Error(t('diagEng.unknownBlock', { type: block.type }));
  }
}

/** `var_set`: set (typed coercion) / add / sub (numeric increment). Returns a log message. */
export async function execVarSet(block: FlowBlock, rd: CoreReader, scope: FlowScope): Promise<string> {
  const name = cfgString(block, 'name');
  const type = scope.types.get(name);
  if (type === undefined) throw new Error(t('flowCore.err.varUnknown', { block: block.label, name }));
  const mode = cfgString(block, 'mode', 'set');
  const input = await rd.optional(block, 'value_in', 0);
  if (mode === 'add' || mode === 'sub') {
    if (type !== 'number') throw new Error(t('flowCore.err.varType', { block: block.label, name, type }));
    const amount = numeric(input !== undefined ? input : (block.config['amount'] ?? 1));
    if (!Number.isFinite(amount)) throw new Error(t('flowCore.err.mathNaN', { block: block.label, value: formatValue(input ?? block.config['amount']) }));
    const cur = scope.vars.get(name);
    const next = (typeof cur === 'number' ? cur : 0) + (mode === 'add' ? amount : -amount);
    if (!Number.isFinite(next)) throw new Error(t('flowCore.err.mathRange', { block: block.label }));
    scope.vars.set(name, next);
  } else {
    if (input === undefined) throw new Error(t('diagReal.flow.noInput', { block: block.label, port: 'value_in' }));
    scope.vars.set(name, coerceValue(input, type, block.label, 'value_in'));
  }
  return `${name} = ${formatValue(scope.vars.get(name))}`;
}

/** Text of a `log` block: `{name}` templates (variables, `{value}` = `value_in`); legacy append when no `{value}`. */
export async function renderLogMessage(block: FlowBlock, rd: CoreReader, scope: FlowScope): Promise<string> {
  const template = cfgString(block, 'message');
  const valueIn = await rd.optional(block, 'value_in', 0);
  const usesValue = hasPlaceholder(template, 'value');
  if (usesValue && valueIn === undefined) throw new Error(t('flowCore.err.logValue', { block: block.label }));
  const msg = await renderAsync(block, template, rd, scope, 0, [], usesValue ? new Map([['value', valueIn]]) : new Map());
  // Pre-core behaviour (byte-identical): a connected value is appended after the message.
  return valueIn === undefined || usesValue ? msg : `${msg}${msg ? ' ' : ''}${valueText(valueIn)}`;
}

/** Range of a `flow_for` block (config `from`, `to`, `step`); throws on invalid values. */
export function readForRange(block: FlowBlock): ForRange {
  const num = (k: string, d: number): number => {
    const raw = block.config[k];
    return raw === undefined || raw === null || raw === '' ? d : Number(raw);
  };
  const r: ForRange = { from: num('from', 1), to: num('to', 10), step: num('step', 1) };
  const err = checkForRange(r);
  if (err !== null) throw new Error(forRangeMessage(err, r, block.label));
  return r;
}
