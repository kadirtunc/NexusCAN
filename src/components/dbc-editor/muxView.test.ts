/**
 * Dependency-free checks for the mux view helpers. Run: `npm run test:muxview`.
 */
import type { SignalSchemaDto } from './contracts';
import {
  areMuxExclusive,
  buildMuxSwitchTree,
  defaultMuxSelection,
  isSignalVisibleOnPage,
  selectionRevealingSignal,
  visibleSwitchNodes,
  type MuxSelection,
} from './muxView';

let failed = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed += 1;
    console.error(`FAIL ${name}: got ${g} want ${w}`);
  }
}

function sig(
  id: number,
  name: string,
  role: SignalSchemaDto['muxRole'],
  sw: number | null = null,
  ranges: [number, number][] = [],
  enumTable: Record<string, string> = {}
): SignalSchemaDto {
  return {
    signalId: id,
    messageKey: 'STD:0x100',
    name,
    longName: null,
    startBit: id * 8,
    bitLength: 8,
    byteOrder: 'littleEndian',
    valueType: 'unsigned',
    factor: 1,
    offset: 0,
    min: 0,
    max: 255,
    unit: '',
    receivers: [],
    comment: null,
    muxRole: role,
    switchSignalId: sw,
    muxRanges: ranges,
    enumTable,
    initialValue: null,
  };
}
const mapOf = (s: SignalSchemaDto[]): Map<number, SignalSchemaDto> => new Map(s.map((x) => [x.signalId, x]));
const vis = (s: SignalSchemaDto[], sel: MuxSelection): string[] => {
  const m = mapOf(s);
  return s.filter((x) => isSignalVisibleOnPage(x, sel, m)).map((x) => x.name);
};

// Simple: M + m0 / m1 / static
const simple = [
  sig(0, 'M', 'masterSwitch', null, [], { '0': 'IDLE', '1': 'DRIVE', '5': 'SPARE' }),
  sig(1, 'A0', 'multiplexed', 0, [[0, 0]]),
  sig(2, 'A1', 'multiplexed', 0, [[1, 1]]),
  sig(3, 'S', 'static'),
];
const simpleMap = mapOf(simple);
const simpleTree = buildMuxSwitchTree(simple);
eq('simple tree len', simpleTree.length, 1);
eq('simple parent', simpleTree[0].parentSwitchId, null);
eq('simple pages', simpleTree[0].pages.map((p) => [p.value, p.label, p.hasSignals]), [
  [0, '0 · IDLE', true],
  [1, '1 · DRIVE', true],
  [5, '5 · SPARE', false],
]);
const simpleSel = defaultMuxSelection(simpleTree);
eq('simple default', [...simpleSel], [[0, 0]]);
eq('simple vis page0', vis(simple, simpleSel), ['M', 'A0', 'S']);
eq('simple vis page1', vis(simple, new Map([[0, 1]])), ['M', 'A1', 'S']);
eq('simple vis all', vis(simple, new Map([[0, 'all' as const]])), ['M', 'A0', 'A1', 'S']);
eq('no switches', buildMuxSwitchTree([sig(0, 'X', 'static')]), []);

// Exclusivity (section 9.8)
eq('m0 vs m1 exclusive', areMuxExclusive(simple[1], simple[2], simpleMap), true);
eq('switch vs child not exclusive', areMuxExclusive(simple[0], simple[1], simpleMap), false);
eq('static vs mux not exclusive', areMuxExclusive(simple[3], simple[1], simpleMap), false);
eq('same page not exclusive', areMuxExclusive(simple[1], simple[1], simpleMap), false);
{
  const two = [...simple, sig(4, 'A0b', 'multiplexed', 0, [[0, 0]])];
  eq('same page siblings not exclusive', areMuxExclusive(two[1], two[4], mapOf(two)), false);
}

// Cascaded: M -> m2M (page 2) -> children on sub pages 0/1
const casc = [
  sig(0, 'Mode', 'masterSwitch', null, [], { '2': 'CHARGING' }),
  sig(1, 'SubMode', 'multiplexed', 0, [[2, 2]]),
  sig(2, 'C0', 'multiplexed', 1, [[0, 0]]),
  sig(3, 'C1', 'multiplexed', 1, [[1, 1]]),
  sig(4, 'P0', 'multiplexed', 0, [[0, 0]]),
  sig(5, 'Stat', 'static'),
];
const cm = mapOf(casc);
const ct = buildMuxSwitchTree(casc);
eq('casc tree order', ct.map((n) => n.switchId), [0, 1]);
eq('casc parent', [ct[1].parentSwitchId, ct[1].parentRanges], [0, [[2, 2]]]);
eq('casc master pages', ct[0].pages.map((p) => p.label), ['0', '2 · CHARGING']);
eq('casc sub pages', ct[1].pages.map((p) => p.value), [0, 1]);
eq('casc m2M is switch + multiplexed', casc[1].muxRole, 'multiplexed');
const cs0 = defaultMuxSelection(ct); // Mode=0, SubMode=0
eq('casc visible nodes page0', visibleSwitchNodes(ct, cs0, cm).map((n) => n.switchId), [0]);
eq('casc vis page0', vis(casc, cs0), ['Mode', 'P0', 'Stat']);
const cs2 = new Map<number, number | 'all'>([[0, 2], [1, 1]]);
eq('casc visible nodes page2', visibleSwitchNodes(ct, cs2, cm).map((n) => n.switchId), [0, 1]);
eq('casc vis page2/1', vis(casc, cs2), ['Mode', 'SubMode', 'C1', 'Stat']);
eq('casc vis Mode=all Sub=1', vis(casc, new Map<number, number | 'all'>([[0, 'all'], [1, 1]])), [
  'Mode', 'SubMode', 'C1', 'P0', 'Stat',
].sort((a, b) => casc.findIndex((s) => s.name === a) - casc.findIndex((s) => s.name === b)));
eq('casc visible nodes Mode=all', visibleSwitchNodes(ct, new Map<number, number | 'all'>([[0, 'all'], [1, 0]]), cm).map((n) => n.switchId), [0, 1]);
// Cascaded exclusivity
eq('casc C0/C1 exclusive', areMuxExclusive(casc[2], casc[3], cm), true);
eq('casc C0/P0 exclusive (Mode 2 vs 0)', areMuxExclusive(casc[2], casc[4], cm), true);
eq('casc SubMode/P0 exclusive', areMuxExclusive(casc[1], casc[4], cm), true);
eq('casc SubMode vs its child not exclusive', areMuxExclusive(casc[1], casc[2], cm), false);
eq('casc Mode vs grandchild not exclusive', areMuxExclusive(casc[0], casc[2], cm), false);
// Reveal grandchild
const rev = selectionRevealingSignal(casc[3], cs0, cm);
eq('reveal grandchild', [...rev], [[0, 2], [1, 1]]);
eq('reveal keeps all', [...selectionRevealingSignal(casc[3], new Map([[0, 'all' as const], [1, 'all' as const]]), cm)], [[0, 'all'], [1, 'all']]);
eq('reveal static unchanged', [...selectionRevealingSignal(casc[5], cs0, cm)], [...cs0]);
eq('reveal does not mutate input', [...cs0], [[0, 0], [1, 0]]);

// SG_MUL_VAL_ ranges 0-3, 10-15
const mv = [
  sig(0, 'M', 'masterSwitch'),
  sig(1, 'R', 'multiplexed', 0, [[0, 3], [10, 15]]),
];
const mvt = buildMuxSwitchTree(mv);
eq('mulval pages', mvt[0].pages.map((p) => p.value), [0, 1, 2, 3, 10, 11, 12, 13, 14, 15]);
eq('mulval vis 12', vis(mv, new Map([[0, 12]])), ['M', 'R']);
eq('mulval vis 5', vis(mv, new Map([[0, 5]])), ['M']);
eq('mulval reveal', [...selectionRevealingSignal(mv[1], new Map([[0, 5]]), mapOf(mv))], [[0, 0]]);
eq('mulval exclusive vs other range', areMuxExclusive(mv[1], sig(2, 'Q', 'multiplexed', 0, [[4, 9]]), mapOf([...mv, sig(2, 'Q', 'multiplexed', 0, [[4, 9]])])), true);
eq('mulval overlapping ranges not exclusive', areMuxExclusive(mv[1], sig(2, 'Q', 'multiplexed', 0, [[3, 4]]), mapOf([...mv, sig(2, 'Q', 'multiplexed', 0, [[3, 4]])])), false);

// Page explosion guard (> 256 values)
const big = [sig(0, 'M', 'masterSwitch'), sig(1, 'B', 'multiplexed', 0, [[0, 1000]])];
const bt = buildMuxSwitchTree(big);
eq('big guard pages', bt[0].pages.map((p) => [p.value, p.label]), [[0, '0…1000'], [1000, '1000']]);
const edge = [sig(0, 'M', 'masterSwitch'), sig(1, 'B', 'multiplexed', 0, [[0, 255]])];
eq('256 values expanded', buildMuxSwitchTree(edge)[0].pages.length, 256);

// Cycle guard: a <-> b must terminate
const cyc = [sig(0, 'A', 'multiplexed', 1, [[0, 0]]), sig(1, 'B', 'multiplexed', 0, [[0, 0]])];
const cycMap = mapOf(cyc);
const cycTree = buildMuxSwitchTree(cyc);
eq('cycle tree terminates', cycTree.length, 2);
eq('cycle visible terminates', typeof isSignalVisibleOnPage(cyc[0], defaultMuxSelection(cycTree), cycMap), 'boolean');
eq('cycle exclusive terminates', typeof areMuxExclusive(cyc[0], cyc[1], cycMap), 'boolean');
eq('cycle reveal terminates', selectionRevealingSignal(cyc[0], new Map(), cycMap) instanceof Map, true);
// Self reference
const self = [sig(0, 'S', 'multiplexed', 0, [[0, 0]])];
eq('self ref terminates', typeof isSignalVisibleOnPage(self[0], new Map(), mapOf(self)), 'boolean');

// Dangling switch reference: treated as visible, no node
const dangling = [sig(0, 'D', 'multiplexed', 99, [[1, 1]])];
eq('dangling no tree', buildMuxSwitchTree(dangling), []);
eq('dangling visible', isSignalVisibleOnPage(dangling[0], new Map(), mapOf(dangling)), true);

if (failed > 0) {
  throw new Error(`${failed} muxView check(s) failed`);
}
console.log('muxView: all checks passed');
