/**
 * Pure editing helpers of the flow's variable declarations (rename propagates to every reference).
 * References: `var_get` / `var_set` `config.name`, `{name}` placeholders of `text_format.template`
 * (unless a same-named input port shadows the variable) and of `log.message`.
 */
import type { FlowVariableDeclV1 } from '../../types/flowLibrary';
import type { FlowBlock, FlowDiagram } from './types';
import { hasPlaceholder, isValidVarName, renamePlaceholder } from './coreBlocks';
import { cfgString, formatInputs } from './coreRuntime';

/** Blocks that reference variable `name`. */
export function variableReferences(diagram: FlowDiagram, name: string): FlowBlock[] {
  return diagram.blocks.filter((b) => {
    switch (b.type) {
      case 'var_get':
      case 'var_set':
        return cfgString(b, 'name') === name;
      case 'text_format':
        return !formatInputs(b).includes(name) && hasPlaceholder(cfgString(b, 'template'), name);
      case 'log':
        return hasPlaceholder(cfgString(b, 'message'), name);
      default:
        return false;
    }
  });
}

/** New diagram with every reference to `oldName` pointing at `newName`. Declarations are not touched. */
export function renameVariableRefs(diagram: FlowDiagram, oldName: string, newName: string): FlowDiagram {
  const refs = new Set(variableReferences(diagram, oldName).map((b) => b.id));
  if (refs.size === 0) return diagram;
  return {
    ...diagram,
    blocks: diagram.blocks.map((b) => {
      if (!refs.has(b.id)) return b;
      switch (b.type) {
        case 'var_get':
        case 'var_set':
          return { ...b, config: { ...b.config, name: newName } };
        case 'text_format':
          return { ...b, config: { ...b.config, template: renamePlaceholder(cfgString(b, 'template'), oldName, newName) } };
        case 'log':
          return { ...b, config: { ...b.config, message: renamePlaceholder(cfgString(b, 'message'), oldName, newName) } };
        default:
          return b;
      }
    }),
  };
}

/** Unused identifier `v1`, `v2`, ... */
export function nextVariableName(decls: readonly FlowVariableDeclV1[]): string {
  let n = 1;
  while (decls.some((d) => d.name === `v${n}`)) n += 1;
  return `v${n}`;
}

/** Whether `name` is usable as the (new) name of variable `current` (valid and unique). */
export function canUseVariableName(decls: readonly FlowVariableDeclV1[], current: string | null, name: string): boolean {
  return isValidVarName(name) && !decls.some((d) => d.name === name && d.name !== current);
}

/** Default initial text for a type. */
export function defaultInitial(type: FlowVariableDeclV1['type']): string {
  switch (type) {
    case 'number': return '0';
    case 'bool': return 'false';
    default: return '';
  }
}
