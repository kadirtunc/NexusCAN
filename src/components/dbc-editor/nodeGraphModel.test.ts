/**
 * Dependency-free checks for the node graph model. Run: `npm run test:nodegraph`.
 */
import type { DatabaseSchemaDto, MessageSchemaDto, SignalSchemaDto } from './contracts';
import {
  UNASSIGNED_NODE,
  buildNodeGraph,
  circularLayout,
  distanceToEdge,
  edgeControlPoint,
  edgeWidth,
  nodeTraffic,
  parseLayout,
  quadPoint,
  serializeLayout,
} from './nodeGraphModel';

let failed = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed += 1;
    console.error(`FAIL ${name}: got ${g} want ${w}`);
  }
}
function ok(name: string, cond: boolean): void {
  if (!cond) {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

let nextSig = 0;
function mk(
  arbId: number,
  name: string,
  transmitters: string[],
  sigs: { name: string; receivers: string[] }[],
  cycle: number | null = null
): { msg: MessageSchemaDto; sigs: SignalSchemaDto[] } {
  const signals = sigs.map(
    (s) =>
      ({
        signalId: nextSig++,
        messageKey: `STD:0x${arbId.toString(16)}`,
        name: s.name,
        receivers: s.receivers,
      }) as unknown as SignalSchemaDto
  );
  const msg = {
    messageKey: `STD:0x${arbId.toString(16)}`,
    arbId,
    isExtended: false,
    name,
    dlc: 8,
    transmitters,
    expectedCycleMs: cycle,
    signalIds: signals.map((s) => s.signalId),
  } as unknown as MessageSchemaDto;
  return { msg, sigs: signals };
}
function schema(ecus: string[], items: { msg: MessageSchemaDto; sigs: SignalSchemaDto[] }[]): DatabaseSchemaDto {
  return {
    ecus: ecus.map((name) => ({ name, comment: null, txMessageKeys: [], rxMessageKeys: [] })),
    messages: items.map((i) => i.msg),
    signals: items.flatMap((i) => i.sigs),
  } as unknown as DatabaseSchemaDto;
}

// simple A->B
{
  const g = buildNodeGraph(schema(['A', 'B'], [mk(0x100, 'M', ['A'], [{ name: 's', receivers: ['B'] }], 100)]), {
    includeUnassigned: true,
  });
  eq('simple edges', g.edges.map((e) => e.id), ['A->B']);
  eq('simple hasReverse', g.edges[0].hasReverse, false);
  eq('simple msg', g.edges[0].messages[0].cycleMs, 100);
  const a = g.nodes.find((n) => n.name === 'A');
  const b = g.nodes.find((n) => n.name === 'B');
  eq('A tx/rx', [a?.txCount, a?.rxCount], [1, 0]);
  eq('B tx/rx', [b?.txCount, b?.rxCount], [0, 1]);
}
// bidirectional
{
  const g = buildNodeGraph(
    schema(['A', 'B'], [
      mk(0x100, 'M1', ['A'], [{ name: 's', receivers: ['B'] }]),
      mk(0x101, 'M2', ['B'], [{ name: 't', receivers: ['A'] }]),
    ]),
    { includeUnassigned: false }
  );
  eq('bidir count', g.edges.length, 2);
  ok('bidir hasReverse both', g.edges.every((e) => e.hasReverse));
  const p = { x: 0, y: 0 };
  const q = { x: 100, y: 0 };
  const c1 = edgeControlPoint(p, q, true, 20);
  const c2 = edgeControlPoint(q, p, true, 20);
  ok('bidir distinct control points', c1.x !== c2.x || c1.y !== c2.y);
  ok('bidir opposite sides', c1.y * c2.y < 0);
  eq('no-reverse straight', edgeControlPoint(p, q, false, 20), { x: 50, y: 0 });
}
// 2 receivers
{
  const g = buildNodeGraph(
    schema(['A', 'B', 'C'], [mk(0x100, 'M', ['A'], [{ name: 's1', receivers: ['B'] }, { name: 's2', receivers: ['B', 'C'] }])]),
    { includeUnassigned: true }
  );
  eq('2rx edges', g.edges.map((e) => e.id), ['A->B', 'A->C']);
  eq('2rx signal names B', g.edges[0].messages[0].signalNames, ['s1', 's2']);
  eq('2rx signal names C', g.edges[1].messages[0].signalNames, ['s2']);
}
// Vector__XXX transmitter
{
  const g = buildNodeGraph(schema(['B'], [mk(0x100, 'M', ['Vector__XXX'], [{ name: 's', receivers: ['B'] }])]), {
    includeUnassigned: true,
  });
  eq('vxx source', g.edges.map((e) => e.id), [`${UNASSIGNED_NODE}->B`]);
  ok('vxx not real node', !g.nodes.some((n) => n.name === 'Vector__XXX'));
  const hidden = buildNodeGraph(schema(['B'], [mk(0x100, 'M', ['Vector__XXX'], [{ name: 's', receivers: ['B'] }])]), {
    includeUnassigned: false,
  });
  eq('vxx hidden edges', hidden.edges.length, 0);
  ok('vxx hidden node', !hidden.nodes.some((n) => n.isUnassigned));
}
// no receivers
{
  const g = buildNodeGraph(
    schema(['A'], [mk(0x100, 'M', ['A'], [{ name: 's', receivers: ['Vector__XXX'] }])]),
    { includeUnassigned: true }
  );
  eq('norx target', g.edges.map((e) => e.id), [`A->${UNASSIGNED_NODE}`]);
  eq('norx sigs', g.edges[0].messages[0].signalNames, ['s']);
}
// transmitter as receiver excluded; ECU without messages remains
{
  const g = buildNodeGraph(
    schema(['A', 'B', 'LONELY'], [mk(0x100, 'M', ['A'], [{ name: 's', receivers: ['A', 'B'] }])]),
    { includeUnassigned: true }
  );
  eq('self excluded', g.edges.map((e) => e.id), ['A->B']);
  ok('lonely node', g.nodes.some((n) => n.name === 'LONELY'));
}
// aggregation sorted by arbId
{
  const g = buildNodeGraph(
    schema(['A', 'B'], [
      mk(0x300, 'C', ['A'], [{ name: 's', receivers: ['B'] }]),
      mk(0x100, 'A', ['A'], [{ name: 's', receivers: ['B'] }]),
      mk(0x200, 'B', ['A'], [{ name: 's', receivers: ['B'] }]),
    ]),
    { includeUnassigned: false }
  );
  eq('agg sorted', g.edges[0].messages.map((m) => m.arbId), [0x100, 0x200, 0x300]);
}
// layout
{
  const names = ['Z', 'A', 'M', UNASSIGNED_NODE];
  const l1 = circularLayout(names);
  const l2 = circularLayout([...names].reverse());
  eq('layout deterministic', l1, l2);
  ok('layout in range', Object.values(l1).every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1));
  ok('layout first at top', Math.abs(l1.A.x - 0.5) < 1e-9 && Math.abs(l1.A.y - 0.1) < 1e-9);
  eq('layout unassigned centre', l1[UNASSIGNED_NODE], { x: 0.5, y: 0.5 });
}
// distanceToEdge
{
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };
  const c = edgeControlPoint(a, b, true, 40);
  const mid = quadPoint(a, c, b, 0.5);
  ok('dist ~0 on midpoint', distanceToEdge(mid, a, c, b) < 1e-9);
  ok('dist far', distanceToEdge({ x: 50, y: 100 }, a, c, b) > 50);
  ok('width range', edgeWidth(1) === 1 && edgeWidth(1000) === 5 && edgeWidth(4) > edgeWidth(2));
}
// parseLayout
{
  eq('parse null', parseLayout(null), {});
  eq('parse garbage', parseLayout('{not json'), {});
  eq('parse array', parseLayout('[1,2]'), {});
  eq('parse mixed', parseLayout('{"A":{"x":0.1,"y":0.2},"B":{"x":"q","y":1},"C":{"x":null,"y":1},"D":5}'), {
    A: { x: 0.1, y: 0.2 },
  });
  eq('roundtrip', parseLayout(serializeLayout({ A: { x: 0.25, y: 0.75 } })), { A: { x: 0.25, y: 0.75 } });
}

// nodeTraffic
{
  const g = buildNodeGraph(
    schema(['A', 'B', 'C', 'D', 'IDLE'], [
      mk(0x100, 'M1', ['B'], [{ name: 's1', receivers: ['A'] }]),
      mk(0x101, 'M2', ['C'], [{ name: 's2', receivers: ['A'] }]),
      mk(0x102, 'M3', ['A'], [{ name: 's3', receivers: ['D'] }]),
    ]),
    { includeUnassigned: false }
  );
  const tr = nodeTraffic(g, 'A');
  eq('traffic incoming peers', tr.incoming.map((x) => x.peer), ['B', 'C']);
  eq('traffic outgoing peers', tr.outgoing.map((x) => x.peer), ['D']);
  eq('traffic edge id', tr.outgoing[0].edgeId, 'A->D');
  const idle = nodeTraffic(g, 'IDLE');
  eq('traffic idle', [idle.incoming, idle.outgoing], [[], []]);
}

if (failed > 0) {
  throw new Error(`${failed} node graph check(s) failed`);
}
console.log('nodegraph: all checks passed');
