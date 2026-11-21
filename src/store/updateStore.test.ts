/**
 * Dependency-free checks. Run: `npx esbuild src/store/updateStore.test.ts --bundle --platform=node --format=esm | node --input-type=module`
 */
import { enDictionary, trDictionary } from '../i18n';
import { parseMarkdown } from '../components/UpdateNotice';
import type { UpdateCheckDto } from '../types/update';
import { AUTO_CHECK_INTERVAL_MS, newerBuildAvailable, parsePersisted, shouldAutoCheck, shouldShowNotice } from './updateStore';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

// parse: defaults, corrupt, partial, wrong types
const D = { autoCheck: true, lastCheckedAtMs: 0, dismissedBuild: null, knownLatestBuild: null };
assert(JSON.stringify(parsePersisted(null)) === JSON.stringify(D), 'null -> defaults');
assert(JSON.stringify(parsePersisted('{not json')) === JSON.stringify(D), 'corrupt -> defaults');
assert(JSON.stringify(parsePersisted('42')) === JSON.stringify(D), 'scalar -> defaults');
assert(JSON.stringify(parsePersisted('[1]')) === JSON.stringify(D), 'array -> defaults');
const ok = parsePersisted('{"autoCheck":false,"lastCheckedAtMs":1700000000000,"dismissedBuild":19}');
assert(!ok.autoCheck && ok.lastCheckedAtMs === 1700000000000 && ok.dismissedBuild === 19, 'valid roundtrip');
const bad = parsePersisted('{"autoCheck":"yes","lastCheckedAtMs":-5,"dismissedBuild":1.5}');
assert(bad.autoCheck && bad.lastCheckedAtMs === 0 && bad.dismissedBuild === null, 'bad field types -> field defaults');

// 24 h rule
const NOW = 1_800_000_000_000;
const base = { autoCheck: true, lastCheckedAtMs: 0, dismissedBuild: null, knownLatestBuild: null };
assert(shouldAutoCheck(base, NOW), 'never checked -> check');
assert(!shouldAutoCheck({ ...base, lastCheckedAtMs: NOW - 1000 }, NOW), 'fresh -> no check');
assert(!shouldAutoCheck({ ...base, lastCheckedAtMs: NOW - AUTO_CHECK_INTERVAL_MS }, NOW), 'exactly 24h -> no check');
assert(shouldAutoCheck({ ...base, lastCheckedAtMs: NOW - AUTO_CHECK_INTERVAL_MS - 1 }, NOW), '>24h -> check');
assert(shouldAutoCheck({ ...base, lastCheckedAtMs: NOW + 5000 }, NOW), 'future timestamp -> check');
assert(!shouldAutoCheck({ ...base, autoCheck: false }, NOW), 'autoCheck off -> never');

// status-bar hint
assert(newerBuildAvailable(null, 19) === null, 'browser mode -> no hint');
assert(newerBuildAvailable({ version: '0.1.0', build: null }, 19) === null, 'dev build -> no hint');
assert(newerBuildAvailable({ version: '0.1.0', build: 18 }, null) === null, 'never checked -> no hint');
assert(newerBuildAvailable({ version: '0.1.0', build: 18 }, 18) === null, 'same build -> no hint');
assert(newerBuildAvailable({ version: '0.1.0', build: 18 }, 19) === 19, 'newer build -> hint');
const persisted = parsePersisted('{"knownLatestBuild":21}');
assert(persisted.knownLatestBuild === 21, 'knownLatestBuild persisted');
assert(parsePersisted('{"knownLatestBuild":"x"}').knownLatestBuild === null, 'bad knownLatestBuild -> null');

// dismissedBuild rule
const rel = (build: number) => ({
  tag: `v0.1.0-build.${build}`, name: `b${build}`, version: '0.1.0', build,
  publishedAt: '2026-11-21T10:00:00Z', notesMarkdown: '', htmlUrl: 'https://github.com/kadirtunc/NexusCAN/releases/tag/x',
});
const dto = (cur: number | null, latest: number | null, avail: boolean): UpdateCheckDto => ({
  currentVersion: '0.1.0', currentBuild: cur, updateAvailable: avail,
  latest: latest === null ? null : rel(latest), newerReleases: latest === null ? [] : [rel(latest)],
  releasesPageUrl: 'https://github.com/kadirtunc/NexusCAN/releases',
});
assert(!shouldShowNotice(null, null), 'no result -> hidden');
assert(shouldShowNotice(dto(18, 19, true), null), 'newer, not dismissed -> shown');
assert(!shouldShowNotice(dto(18, 19, true), 19), 'dismissed same build -> hidden');
assert(shouldShowNotice(dto(18, 20, true), 19), 'newer than dismissed -> shown again');
assert(!shouldShowNotice(dto(18, 19, false), null), 'no update -> hidden');
assert(!shouldShowNotice(dto(null, 19, true), null), 'dev build -> never shown');
assert(!shouldShowNotice(dto(18, null, true), null), 'no latest -> hidden');

// markdown
const md = parseMarkdown('# Title\n- a\n- b\n\n| x | y |\n|---|---|\ntext **b** `c`\nmore');
assert(md.map((b) => b.kind).join() === 'heading,list,table,para', 'markdown block kinds');
assert(md[1].kind === 'list' && md[1].items.length === 2, 'list items');
assert(md[2].kind === 'table' && md[2].lines.length === 2, 'table lines');
assert(md[3].kind === 'para' && md[3].text === 'text **b** `c` more', 'paragraph join');

// i18n parity
const keys = (d: Record<string, string>) => Object.keys(d).filter((k) => k.startsWith('upd.')).sort().join();
assert(keys(trDictionary).length > 0 && keys(trDictionary) === keys(enDictionary), 'TR/EN upd.* key sets equal');
for (const k of Object.keys(enDictionary).filter((x) => x.startsWith('upd.'))) {
  assert((enDictionary as Record<string, string>)[k].length > 0, `non-empty: ${k}`);
}

console.log('updateStore tests PASS');
