import type { FlowBlock, FlowDiagram } from './types';

/**
 * Wireless jump points ("Goto / From"): a `flow_goto` block continues the run at the `flow_terminal`
 * block whose BLOCK ID is stored in `config.target_terminal_id` (never its name, so renaming a
 * terminal never breaks a goto). Pure helpers, shared by the engine, the canvas and the inspector.
 */

export const TERMINAL_TYPE = 'flow_terminal';
export const GOTO_TYPE = 'flow_goto';

export type TerminalColor = 'amber' | 'red' | 'orange' | 'cyan' | 'violet' | 'emerald';

export const TERMINAL_COLORS: readonly TerminalColor[] = ['amber', 'red', 'orange', 'cyan', 'violet', 'emerald'];

/** Static colour map (design tokens where one exists). Consumed by zoom-scaled inline styles. */
export const TERMINAL_COLOR_CSS: Readonly<Record<TerminalColor, string>> = {
  amber: 'var(--status-warn)',
  red: 'var(--status-critical)',
  cyan: 'var(--status-focus)',
  emerald: 'var(--status-nominal)',
  orange: '#e07b39',
  violet: '#8b6fd6',
};

export function isTerminalColor(v: unknown): v is TerminalColor {
  return typeof v === 'string' && (TERMINAL_COLORS as readonly string[]).includes(v);
}

export function terminalColor(block: FlowBlock): TerminalColor {
  const c = block.config['color'];
  return isTerminalColor(c) ? c : 'amber';
}

export function terminalName(block: FlowBlock): string {
  return String(block.config['name'] ?? '').trim();
}

export function gotoTargetId(block: FlowBlock): string {
  return String(block.config['target_terminal_id'] ?? '');
}

/** Compact "pill" blocks (no body, no port label rows). */
export function isCompactBlock(type: string): boolean {
  return type === TERMINAL_TYPE || type === GOTO_TYPE;
}

export function listTerminals(diagram: FlowDiagram): FlowBlock[] {
  return diagram.blocks.filter((b) => b.type === TERMINAL_TYPE);
}

/** Goto blocks that target the given terminal block id. */
export function terminalReferences(diagram: FlowDiagram, terminalId: string): FlowBlock[] {
  return diagram.blocks.filter((b) => b.type === GOTO_TYPE && gotoTargetId(b) === terminalId);
}

/** The terminal block a goto points to, or null when the id is empty / missing / not a terminal. */
export function resolveGotoTarget(diagram: FlowDiagram, gotoBlock: FlowBlock): FlowBlock | null {
  const id = gotoTargetId(gotoBlock);
  if (id === '') return null;
  const target = diagram.blocks.find((b) => b.id === id);
  return target !== undefined && target.type === TERMINAL_TYPE ? target : null;
}

export type TerminalIssueKind = 'goto_no_target' | 'goto_bad_target' | 'name_empty' | 'name_duplicate' | 'goto_loop';

export interface TerminalIssue {
  kind: TerminalIssueKind;
  /** Offending block (goto or terminal). */
  blockId: string;
  /** Terminal name involved (when known). */
  name: string;
}

/**
 * Pre-run validation: every goto resolves to an existing terminal, terminal names are non-empty and
 * unique (case-insensitive, trimmed), and no goto <-> terminal cycle exists without another block in
 * between (a terminal's `exec_out` leading, through gotos only, back to a goto of the same cycle).
 */
export function validateTerminals(diagram: FlowDiagram): TerminalIssue[] {
  const issues: TerminalIssue[] = [];
  const terminals = listTerminals(diagram);

  const seen = new Map<string, string>();
  for (const tb of terminals) {
    const name = terminalName(tb);
    if (name === '') {
      issues.push({ kind: 'name_empty', blockId: tb.id, name });
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) issues.push({ kind: 'name_duplicate', blockId: tb.id, name });
    else seen.set(key, tb.id);
  }

  for (const g of diagram.blocks) {
    if (g.type !== GOTO_TYPE) continue;
    if (gotoTargetId(g) === '') issues.push({ kind: 'goto_no_target', blockId: g.id, name: '' });
    else if (resolveGotoTarget(diagram, g) === null) issues.push({ kind: 'goto_bad_target', blockId: g.id, name: '' });
  }

  // Tight loops: terminal --exec_out--> goto --(jump)--> terminal ... (gotos only in between).
  const nextTerminals = (tb: FlowBlock): Array<{ goto: FlowBlock; target: FlowBlock }> => {
    const out: Array<{ goto: FlowBlock; target: FlowBlock }> = [];
    for (const c of diagram.connections) {
      if (c.fromBlockId !== tb.id || c.fromPortId !== 'exec_out') continue;
      const g = diagram.blocks.find((b) => b.id === c.toBlockId);
      if (g === undefined || g.type !== GOTO_TYPE) continue;
      const target = resolveGotoTarget(diagram, g);
      if (target !== null) out.push({ goto: g, target });
    }
    return out;
  };
  const state = new Map<string, 1 | 2>(); // 1 = on the DFS path, 2 = done
  const reported = new Set<string>();
  const visit = (tb: FlowBlock): void => {
    state.set(tb.id, 1);
    for (const { goto, target } of nextTerminals(tb)) {
      const s = state.get(target.id);
      if (s === 1) {
        if (!reported.has(goto.id)) {
          reported.add(goto.id);
          issues.push({ kind: 'goto_loop', blockId: goto.id, name: terminalName(target) });
        }
      } else if (s === undefined) visit(target);
    }
    state.set(tb.id, 2);
  };
  for (const tb of terminals) if (!state.has(tb.id)) visit(tb);

  return issues;
}
