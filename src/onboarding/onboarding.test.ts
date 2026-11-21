/**
 * Dependency-free checks. Run: `npx esbuild src/onboarding/onboarding.test.ts --bundle --platform=node --format=esm | node --input-type=module`
 */
import { enDictionary, trDictionary } from '../i18n';
import { parsePersisted } from '../store/onboardingStore';
import { GUIDE_PAGES, guidePageForTab } from './registry';
import { inlineCodeToHtml } from './richText';
import { allMcpToolNames, MCP_TOOL_CATALOG } from './mcpToolCatalog';
import { GUIDE_PAGE_IDS } from './types';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const trKeys = Object.keys(trDictionary).filter((k) => k.startsWith('onb.')).sort();
const enKeys = Object.keys(enDictionary).filter((k) => k.startsWith('onb.')).sort();
assert(trKeys.length > 0 && trKeys.join() === enKeys.join(), 'TR/EN onb.* key sets equal');

for (const id of GUIDE_PAGE_IDS) {
  const def = GUIDE_PAGES[id];
  const keys = [
    def.titleKey,
    ...def.tour.flatMap((s) => [s.titleKey, s.bodyKey]),
    ...def.info.flatMap((i) => [i.headingKey, ...i.bodyKeys, ...(i.items ?? []).map((it) => it.descKey)]),
    ...def.tips,
  ];
  for (const k of keys) {
    assert(trDictionary[k] !== undefined && enDictionary[k].length > 0, `key present: ${k}`);
  }
  for (const a of def.keepInteractive) assert(a.length > 0, 'keepInteractive anchor');
  if (def.tour.length > 0) assert(def.tour.some((s) => s.anchor === 'topbar.panic'), 'tour covers Panic Stop');
}

for (const n of [1, 2, 3, 4, 5]) {
  for (const part of ['title', 'body']) {
    assert(trDictionary[`onb.start.step.${n}.${part}` as keyof typeof trDictionary] !== undefined, `start step ${n} ${part}`);
  }
}
assert(GUIDE_PAGES.start.tab === 'start', 'start def tab');

// MCP guide: overlay page (no tab, no tour), tool catalog integrity.
const mcpDef = GUIDE_PAGES.mcp;
assert(mcpDef.tab === null && mcpDef.tour.length === 0, 'mcp def: tab null, no tour');
assert(guidePageForTab('mcp') === null && guidePageForTab('null') === null, 'guidePageForTab never maps null tab');
for (const id of ['about', 'connect', 'safety', 'examples', 'trouble']) {
  assert(mcpDef.info.some((s) => s.id === id), `mcp section ${id}`);
}
for (const k of Object.keys(trDictionary).filter((x) => x.startsWith('onb.mcp.'))) {
  assert(trDictionary[k as keyof typeof trDictionary].length > 0 && enDictionary[k as keyof typeof enDictionary].length > 0, `mcp key non-empty: ${k}`);
}
const toolNames = allMcpToolNames();
assert(new Set(toolNames).size === toolNames.length, 'mcp catalog has no duplicate tool names');
assert(toolNames.every((n) => /^[a-z][a-z0-9_]*$/.test(n)), 'mcp tool names are snake_case');
assert(MCP_TOOL_CATALOG.length === 8, 'mcp catalog has 8 categories');
const itemCodes = mcpDef.info.flatMap((s) => (s.items ?? []).map((i) => i.code));
assert(itemCodes.join() === toolNames.join(), 'mcp info items mirror the catalog');
for (const cat of MCP_TOOL_CATALOG) {
  for (const tl of cat.tools) {
    assert(trDictionary[tl.descKey] !== undefined && enDictionary[tl.descKey].length > 0, `tool desc TR/EN: ${tl.name}`);
  }
}
assert(MCP_TOOL_CATALOG.flatMap((c) => c.tools).filter((x) => x.badge === 'confirm').length === 1, 'exactly one confirm tool');
assert(GUIDE_PAGES.start.info.some((i) => i.id === 'txSafety'), 'start has txSafety section');
assert(GUIDE_PAGES.start.tour.length >= 4 && GUIDE_PAGES.start.tour.length <= 6, 'start tour 4-6 steps');

const def = parsePersisted(null);
assert(def.seenPages.length === 0 && !def.txSafetyAcked, 'null -> default');
for (const bad of ['{', 'null', '42', '"x"', '[]', '{"schemaVersion":2}', '{"schemaVersion":1,"seenPages":"x"}']) {
  const r = parsePersisted(bad);
  assert(r.schemaVersion === 1 && r.seenPages.length === 0, `corrupt -> default: ${bad}`);
}
const ok = parsePersisted('{"schemaVersion":1,"seenPages":["rxtx","nope",3,"rxtx"],"txSafetyAcked":true}');
assert(ok.seenPages.length === 1 && ok.seenPages[0] === 'rxtx' && ok.txSafetyAcked, 'valid parse + filter');

assert(inlineCodeToHtml('a <b> `1&2`') === 'a &lt;b&gt; <code class="nx-code">1&amp;2</code>', 'html escape + code');
console.log('onboarding tests: PASS');
