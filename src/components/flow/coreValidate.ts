/**
 * Static validation of the core block pack (diag-workspace-v1 §8.1): declarations, variable
 * references, `{name}` templates, loop control placement, `flow_for` ranges and required inputs.
 * Pure and localized; consumed by the engines (pre-run refusal) and the inspector (error display).
 */
import { t } from '../../i18n';
import type { FlowDiagram } from './types';
import { getBlockDefFor } from './blockDefs';
import {
  checkForRange,
  CONVERT_TARGETS,
  forRangeMessage,
  isValidVarName,
  LOGIC_OPS,
  MATH_OPS,
  parseInitial,
  templatePlaceholders,
} from './coreBlocks';
import { cfgString, formatInputs, LOOP_BLOCKS, WHILE_DEFAULT_MAX, WHILE_MAX_LIMIT } from './coreRuntime';
import { resolveGotoTarget } from './flowTerminals';

export type CoreIssueCode =
  | 'decl_name'
  | 'decl_dup'
  | 'decl_initial'
  | 'var_unknown'
  | 'var_type'
  | 'fmt_unknown'
  | 'fmt_input_name'
  | 'fmt_input_dup'
  | 'log_value'
  | 'for_range'
  | 'while_range'
  | 'loop_outside'
  | 'legacy_var'
  | 'input_missing'
  | 'convert_len'
  | 'op_unknown';

export interface CoreIssue {
  /** Offending block id; `''` for a flow-level (variable declaration) issue. */
  blockId: string;
  code: CoreIssueCode;
  /** Localized, shown in the run log and the inspector. */
  message: string;
}

/** Block ids reachable on an exec path that starts at the `body_out` of a loop driver. */
export function loopBodyReachable(diagram: FlowDiagram): Set<string> {
  const portIsExec = (blockId: string, portId: string): boolean => {
    const b = diagram.blocks.find((x) => x.id === blockId);
    const def = b ? getBlockDefFor(b) : undefined;
    return def?.ports.find((p) => p.id === portId)?.type === 'exec';
  };
  const out = new Map<string, string[]>();
  const push = (from: string, to: string): void => {
    const list = out.get(from);
    if (list) list.push(to);
    else out.set(from, [to]);
  };
  for (const c of diagram.connections) {
    if (portIsExec(c.fromBlockId, c.fromPortId)) push(c.fromBlockId, c.toBlockId);
  }
  for (const b of diagram.blocks) {
    if (b.type === 'flow_goto') {
      const target = resolveGotoTarget(diagram, b);
      if (target) push(b.id, target.id);
    }
  }
  const loopTypes = diagram.blocks.filter((b) => LOOP_BLOCKS.has(b.type));
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const l of loopTypes) {
    for (const c of diagram.connections) {
      if (c.fromBlockId === l.id && c.fromPortId === 'body_out') stack.push(c.toBlockId);
    }
  }
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const n of out.get(id) ?? []) stack.push(n);
  }
  return seen;
}

export function validateCore(diagram: FlowDiagram): CoreIssue[] {
  const issues: CoreIssue[] = [];
  const decls = diagram.variables ?? [];
  const declared = new Set(decls.map((d) => d.name));
  const wired = (blockId: string, portId: string): boolean =>
    diagram.connections.some((c) => c.toBlockId === blockId && c.toPortId === portId);

  // Declarations
  const seenNames = new Set<string>();
  for (const d of decls) {
    if (!isValidVarName(d.name)) {
      issues.push({ blockId: '', code: 'decl_name', message: t('flowCore.val.declName', { name: d.name }) });
    } else if (seenNames.has(d.name)) {
      issues.push({ blockId: '', code: 'decl_dup', message: t('flowCore.val.declDup', { name: d.name }) });
    }
    seenNames.add(d.name);
    try {
      parseInitial(d);
    } catch (e) {
      issues.push({ blockId: '', code: 'decl_initial', message: e instanceof Error ? e.message : String(e) });
    }
  }

  const inLoopBody = loopBodyReachable(diagram);

  for (const b of diagram.blocks) {
    const label = b.label;
    const add = (code: CoreIssueCode, message: string): void => {
      issues.push({ blockId: b.id, code, message });
    };
    switch (b.type) {
      case 'data_var':
        add('legacy_var', t('flowCore.val.legacyVar', { block: label }));
        break;

      case 'var_get': {
        const name = cfgString(b, 'name');
        if (!declared.has(name)) add('var_unknown', t('flowCore.err.varUnknown', { block: label, name }));
        break;
      }

      case 'var_set': {
        const name = cfgString(b, 'name');
        const mode = cfgString(b, 'mode', 'set');
        const decl = decls.find((d) => d.name === name);
        if (!decl) add('var_unknown', t('flowCore.err.varUnknown', { block: label, name }));
        else if ((mode === 'add' || mode === 'sub') && decl.type !== 'number') {
          add('var_type', t('flowCore.err.varType', { block: label, name, type: decl.type }));
        }
        if (mode === 'set' && !wired(b.id, 'value_in')) {
          add('input_missing', t('diagReal.flow.noInput', { block: label, port: 'value_in' }));
        }
        break;
      }

      case 'math': {
        const op = cfgString(b, 'op', 'add');
        if (!(MATH_OPS as readonly string[]).includes(op)) add('op_unknown', t('flowCore.err.opUnknown', { block: label, op }));
        if (!wired(b.id, 'a_in')) add('input_missing', t('diagReal.flow.noInput', { block: label, port: 'a_in' }));
        break;
      }

      case 'logic': {
        const op = cfgString(b, 'op', 'and');
        if (!(LOGIC_OPS as readonly string[]).includes(op)) add('op_unknown', t('flowCore.err.opUnknown', { block: label, op }));
        if (!wired(b.id, 'a_in')) add('input_missing', t('diagReal.flow.noInput', { block: label, port: 'a_in' }));
        if (op !== 'not' && !wired(b.id, 'b_in')) add('input_missing', t('diagReal.flow.noInput', { block: label, port: 'b_in' }));
        break;
      }

      case 'convert': {
        const target = cfgString(b, 'target', 'number');
        if (!(CONVERT_TARGETS as readonly string[]).includes(target)) add('op_unknown', t('flowCore.err.opUnknown', { block: label, op: target }));
        const len = Number(b.config['byteLength'] ?? 1);
        if (!Number.isInteger(len) || len < 1 || len > 8) add('convert_len', t('flowCore.err.convertLen', { block: label }));
        if (!wired(b.id, 'value_in')) add('input_missing', t('diagReal.flow.noInput', { block: label, port: 'value_in' }));
        break;
      }

      case 'text_format': {
        const inputs = formatInputs(b);
        const seenIn = new Set<string>();
        for (const n of inputs) {
          if (!isValidVarName(n)) add('fmt_input_name', t('flowCore.val.inputName', { block: label, name: n }));
          else if (seenIn.has(n)) add('fmt_input_dup', t('flowCore.val.inputDup', { block: label, name: n }));
          seenIn.add(n);
        }
        for (const name of templatePlaceholders(cfgString(b, 'template'))) {
          if (!seenIn.has(name) && !declared.has(name)) add('fmt_unknown', t('flowCore.err.tplUnknown', { block: label, name }));
        }
        break;
      }

      case 'log': {
        for (const name of templatePlaceholders(cfgString(b, 'message'))) {
          if (name === 'value') {
            if (!wired(b.id, 'value_in')) add('log_value', t('flowCore.err.logValue', { block: label }));
          } else if (!declared.has(name)) {
            add('fmt_unknown', t('flowCore.err.tplUnknown', { block: label, name }));
          }
        }
        break;
      }

      case 'flow_for': {
        const num = (k: string, d: number): number => {
          const raw = b.config[k];
          return raw === undefined || raw === null || raw === '' ? d : Number(raw);
        };
        const r = { from: num('from', 1), to: num('to', 10), step: num('step', 1) };
        const err = checkForRange(r);
        if (err !== null) add('for_range', forRangeMessage(err, r, label));
        break;
      }

      case 'flow_while': {
        const raw = b.config['max_iterations'];
        const n = raw === undefined || raw === null || raw === '' ? WHILE_DEFAULT_MAX : Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > WHILE_MAX_LIMIT) add('while_range', t('flowCore.err.whileRange', { block: label, max: WHILE_MAX_LIMIT }));
        break;
      }

      case 'flow_break':
      case 'flow_continue':
        if (!inLoopBody.has(b.id)) add('loop_outside', t('flowCore.err.loopOutside', { block: label }));
        break;

      default:
        break;
    }
  }
  return issues;
}
