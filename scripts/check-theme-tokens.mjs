#!/usr/bin/env node
// theme-tokens-v1 gate. Colors may only be defined in src/index.css ([data-theme="dark"|"light"]).
// Everywhere else: CSS variables / token utility classes only.
//   node scripts/check-theme-tokens.mjs                 -> ratchet check vs scripts/theme-baseline.json
//   node scripts/check-theme-tokens.mjs --strict        -> fail on ANY violation (final target)
//   node scripts/check-theme-tokens.mjs --file <path>   -> list violations of one file (line:col)
//   node scripts/check-theme-tokens.mjs --update-baseline (team-lead only; counts may only go DOWN)
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const BASELINE = join(ROOT, 'scripts', 'theme-baseline.json');
const EXEMPT = new Set(['src/index.css']); // the single source of truth for color values

const HUES =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black';
const PREFIX =
  'bg|text|border|border-[trblxy]|from|to|via|ring|ring-offset|shadow|fill|stroke|accent|outline|divide|placeholder|caret|decoration';
const RULES = [
  { id: 'tailwind-palette', re: new RegExp(`(?<![\\w-])(?:[a-z0-9-]+:)*(?:${PREFIX})-(?:${HUES})(?:-\\d{2,3})?(?:\\/\\d{1,3})?(?![\\w-])`, 'g') },
  { id: 'hex-literal', re: /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g },
  { id: 'rgb-hsl-literal', re: /\b(?:rgba?|hsla?)\(\s*\d/g },
];
const ALLOW_MARK = 'theme-allow:'; // same-line escape hatch, must carry a reason; reviewed by team-lead

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

function scan(file) {
  const hits = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (line.includes(ALLOW_MARK)) return;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    for (const { id, re } of RULES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) hits.push({ line: i + 1, col: m.index + 1, rule: id, text: m[0] });
    }
  });
  return hits;
}

const args = process.argv.slice(2);
const files = walk(SRC, []).map((f) => relative(ROOT, f)).filter((f) => !EXEMPT.has(f)).sort();

if (args[0] === '--file') {
  const f = args[1];
  for (const h of scan(join(ROOT, f))) console.log(`${f}:${h.line}:${h.col}  ${h.rule}  ${h.text}`);
  process.exit(0);
}

const counts = {};
let total = 0;
for (const f of files) {
  const n = scan(join(ROOT, f)).length;
  if (n > 0) { counts[f] = n; total += n; }
}

if (args.includes('--update-baseline')) {
  writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n');
  console.log(`theme baseline written: ${Object.keys(counts).length} files, ${total} violations`);
  process.exit(0);
}

if (args.includes('--strict')) {
  if (total > 0) {
    for (const [f, n] of Object.entries(counts)) console.log(`${n}\t${f}`);
    console.log(`THEME STRICT FAIL: ${total} hardcoded colors`);
    process.exit(1);
  }
  console.log('THEME STRICT PASS: 0 hardcoded colors');
  process.exit(0);
}

const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
let fail = false;
for (const [f, n] of Object.entries(counts)) {
  const allowed = base[f] ?? 0;
  if (n > allowed) { fail = true; console.log(`THEME FAIL ${f}: ${n} > baseline ${allowed} (run --file ${f})`); }
}
const baseTotal = Object.values(base).reduce((a, b) => a + b, 0);
console.log(`theme tokens: ${total} remaining (baseline ${baseTotal}) ${fail ? 'FAIL' : 'PASS'}`);
process.exit(fail ? 1 : 0);
