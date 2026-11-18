/**
 * Headless tests of the wireless Terminal / Goto blocks: validation (pure helpers) and run behaviour
 * on the engine (DEMO structural path, shared with the real executor via REAL_STRUCTURAL).
 * Run: `npm run test:terminals` (esbuild bundle -> node; throws on the first failure).
 */
import { FlowEngine } from './FlowEngine';
import { flowStore } from './FlowStore';
import { resolveGotoTarget, terminalName, terminalReferences, validateTerminals } from './flowTerminals';
import type { FlowTransport } from './flowTransport';
import type { FlowBlock, FlowConnection, FlowDiagram } from './types';

let passed = 0;
function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  passed += 1;
}

let seq = 0;
function blk(type: string, label: string, config: Record<string, unknown> = {}): FlowBlock {
  return { id: `b${++seq}`, type, label, x: seq * 10, y: 0, config, status: 'idle', collapsed: false };
}
function wire(from: FlowBlock, fromPort: string, to: FlowBlock, toPort = 'exec_in'): FlowConnection {
  return { id: `c${++seq}`, fromBlockId: from.id, fromPortId: fromPort, toBlockId: to.id, toPortId: toPort };
}
function dia(blocks: FlowBlock[], connections: FlowConnection[]): FlowDiagram {
  return { id: 'd', name: 'd', blocks, connections };
}

/** start -> logA -> goto(T) ; T -> logT -> end ; `skipped` is an unwired log that must never run */
function sample(): { d: FlowDiagram; term: FlowBlock; go: FlowBlock; logT: FlowBlock; skipped: FlowBlock } {
  const start = blk('start', 'Start');
  const logA = blk('log', 'LogA', { message: 'A' });
  const skipped = blk('log', 'Skipped', { message: 'S' });
  const term = blk('flow_terminal', 'T', { name: 'SAFE ABORT', color: 'amber' });
  const go = blk('flow_goto', 'Goto', {});
  go.config = { target_terminal_id: term.id };
  const logT = blk('log', 'LogT', { message: 'T' });
  const end = blk('end', 'End');
  const d = dia(
    [start, logA, skipped, term, go, logT, end],
    [wire(start, 'exec_out', logA), wire(logA, 'exec_out', go), wire(term, 'exec_out', logT), wire(logT, 'exec_out', end)],
  );
  return { d, term, go, logT, skipped };
}

function load(d: FlowDiagram): void {
  flowStore.loadTemplate({ id: 'x', nameKey: 'diagTpl.ecuFlasher.name', descriptionKey: 'diagTpl.ecuFlasher.desc', category: 't', icon: '', diagram: { blocks: d.blocks, connections: d.connections } });
}
const demoTransport = { demo: true } as unknown as FlowTransport;
async function run(d: FlowDiagram): Promise<string> {
  load(d);
  await new FlowEngine().run({ transport: demoTransport });
  return flowStore.getSnapshot().runLog.map((e) => e.message).join('\n');
}
const status = (id: string): string => flowStore.getSnapshot().diagram.blocks.find((b) => b.id === id)?.status ?? '?';

async function main(): Promise<void> {
  // 1. goto jumps to the terminal and continues; nothing after the goto's (non-existent) output runs
  {
    const { d, term, go, logT, skipped } = sample();
    ok(validateTerminals(d).length === 0, 'sample validates');
    ok(resolveGotoTarget(d, go)?.id === term.id, 'goto resolves to terminal');
    ok(terminalReferences(d, term.id).length === 1, 'terminal has 1 reference');
    const log = await run(d);
    ok(status(term.id) === 'success', 'terminal executed');
    ok(status(logT.id) === 'success', 'chain continues after the terminal');
    ok(status(skipped.id) === 'idle', 'unwired block never runs');
    ok(log.includes('→ SAFE ABORT (from: LogA)') || log.includes('→ SAFE ABORT (kaynak: LogA)'), 'jump logged with source block label');
  }

  // 2. missing target: validation fails, nothing executes
  {
    const { d, go } = sample();
    go.config = { target_terminal_id: 'nope' };
    ok(validateTerminals(d).some((i) => i.kind === 'goto_bad_target' && i.blockId === go.id), 'bad target flagged');
    go.config = { target_terminal_id: '' };
    ok(validateTerminals(d).some((i) => i.kind === 'goto_no_target'), 'empty target flagged');
    await run(d);
    ok(status(d.blocks[0].id) === 'idle' && flowStore.getSnapshot().runLog.some((e) => e.level === 'error'), 'run refused, no block executed');
    ok(flowStore.getSnapshot().isRunning === false, 'run state reset');
  }

  // 2b. target id pointing at a non-terminal block is invalid too
  {
    const { d, go, logT } = sample();
    go.config = { target_terminal_id: logT.id };
    ok(validateTerminals(d).some((i) => i.kind === 'goto_bad_target'), 'non-terminal target flagged');
  }

  // 3. duplicate / empty names
  {
    const { d, term } = sample();
    const t2 = blk('flow_terminal', 'T2', { name: '  safe abort ', color: 'red' });
    d.blocks.push(t2);
    ok(validateTerminals(d).some((i) => i.kind === 'name_duplicate' && i.blockId === t2.id), 'duplicate name (case-insensitive, trimmed)');
    t2.config = { name: '   ', color: 'red' };
    ok(validateTerminals(d).some((i) => i.kind === 'name_empty' && i.blockId === t2.id), 'empty name');
    ok(term.id !== t2.id, 'sanity');
  }

  // 4. tight goto <-> terminal loop
  {
    const t1 = blk('flow_terminal', 'T1', { name: 'ONE', color: 'amber' });
    const g1 = blk('flow_goto', 'G1', {});
    const t2 = blk('flow_terminal', 'T2', { name: 'TWO', color: 'red' });
    const g2 = blk('flow_goto', 'G2', {});
    g1.config = { target_terminal_id: t2.id };
    g2.config = { target_terminal_id: t1.id };
    const d = dia([t1, g1, t2, g2], [wire(t1, 'exec_out', g1), wire(t2, 'exec_out', g2)]);
    ok(validateTerminals(d).some((i) => i.kind === 'goto_loop'), 'terminal<->goto cycle rejected');
    // self loop: T -> G -> T
    const t3 = blk('flow_terminal', 'T3', { name: 'THREE', color: 'amber' });
    const g3 = blk('flow_goto', 'G3', {});
    g3.config = { target_terminal_id: t3.id };
    ok(validateTerminals(dia([t3, g3], [wire(t3, 'exec_out', g3)])).some((i) => i.kind === 'goto_loop'), 'self cycle rejected');
    // A block in between makes it a legal (user-designed) loop
    const lg = blk('log', 'L', { message: 'x' });
    const g4 = blk('flow_goto', 'G4', {});
    const t4 = blk('flow_terminal', 'T4', { name: 'FOUR', color: 'amber' });
    g4.config = { target_terminal_id: t4.id };
    ok(!validateTerminals(dia([t4, lg, g4], [wire(t4, 'exec_out', lg), wire(lg, 'exec_out', g4)])).some((i) => i.kind === 'goto_loop'), 'loop through a real block is allowed');
  }

  // 5. renaming a terminal keeps gotos resolving (id based)
  {
    const { d, term, go } = sample();
    load(d);
    flowStore.updateBlockConfig(term.id, { name: 'RENAMED', color: 'cyan' });
    const cur = flowStore.getSnapshot().diagram;
    const goNow = cur.blocks.find((b) => b.id === go.id);
    const target = goNow ? resolveGotoTarget(cur, goNow) : null;
    ok(target !== null && terminalName(target) === 'RENAMED', 'goto resolves after rename');
    ok(validateTerminals(cur).length === 0, 'still valid after rename');
    await new FlowEngine().run({ transport: demoTransport });
    ok(status(term.id) === 'success', 'run follows the renamed terminal');
  }

  console.log(`flowTerminals.test: ${passed} checks passed`);
}

await main();
