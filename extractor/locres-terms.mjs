#!/usr/bin/env node
// Builds a bilingual map of the game's own UI strings from the exported .locres tables.
//
//   node extractor/locres-terms.mjs [--export <dir>] [--out <file>] [--langs en,ru] [--ns <regex>]
//
// --export  export folder written by trdump (default: extractor/out/export); reads
//           <export>/locres/<Game..>/<lang>/<Game..>.json  ({namespace: {key: text}})
// --out     output file (default: extractor/out/locres-terms.json)
// --langs   languages to include (default: en,ru); the first one is required for an entry
// --ns      only keep namespaces matching this regex (default: all)
//
// Output: { "<namespace>": { "<key>": { "en": "...", "ru": "..." } } }, keys sorted so the
// file diffs cleanly between game patches. Zero dependencies; Node 18+.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) o[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) o[a.slice(2)] = argv[++i];
    else o[a.slice(2)] = true;
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
const EXPORT = path.resolve(args.export ?? path.join(HERE, 'out', 'export'));
const OUT = path.resolve(args.out ?? path.join(HERE, 'out', 'locres-terms.json'));
const LANGS = String(args.langs ?? 'en,ru').split(',').map((s) => s.trim()).filter(Boolean);
const NS = args.ns ? new RegExp(args.ns) : null;
const LOC_ROOT = path.join(EXPORT, 'locres');

if (!fs.existsSync(LOC_ROOT)) {
  console.error(`missing ${LOC_ROOT}\nrun "trdump locres" first (see extractor/README.md) or pass --export <dir>`);
  process.exit(1);
}

// lang -> namespace -> key -> text, merged over all localization targets (Game, Game2, ...)
const byLang = Object.fromEntries(LANGS.map((l) => [l, {}]));
let conflicts = 0;
for (const target of fs.readdirSync(LOC_ROOT).sort()) {
  for (const lang of LANGS) {
    const p = path.join(LOC_ROOT, target, lang, `${target}.json`);
    if (!fs.existsSync(p)) continue;
    for (const [ns, entries] of Object.entries(JSON.parse(fs.readFileSync(p, 'utf8')))) {
      if (NS && !NS.test(ns)) continue;
      const dst = (byLang[lang][ns] ??= {});
      for (const [k, v] of Object.entries(entries)) {
        if (k in dst && dst[k] !== v) conflicts++;
        dst[k] = v; // later targets win, as when the game loads them in order
      }
    }
  }
}

const [primary, ...rest] = LANGS;
const out = {};
let count = 0;
const missing = Object.fromEntries(rest.map((l) => [l, 0]));
for (const ns of Object.keys(byLang[primary]).sort()) {
  const keys = Object.keys(byLang[primary][ns]).sort();
  if (!keys.length) continue;
  const o = (out[ns] = {});
  for (const k of keys) {
    const e = { [primary]: byLang[primary][ns][k] };
    for (const l of rest) {
      const v = byLang[l][ns]?.[k];
      if (v == null) missing[l]++;
      e[l] = v ?? null;
    }
    o[k] = e;
    count++;
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`${OUT}: ${Object.keys(out).length} namespaces, ${count} strings (${LANGS.join(', ')})`);
for (const l of rest) if (missing[l]) console.log(`  ${missing[l]} strings have no ${l} text`);
if (conflicts) console.log(`  ${conflicts} keys redefined across localization targets (last one kept)`);
