/**
 * i18n-usage.mjs — which keys of the Russian dictionary the site actually uses.
 *
 *   node tools/i18n-usage.mjs           # list unused keys
 *   node tools/i18n-usage.mjs --prune   # remove them from web/lib/i18n.js
 *
 * Shared by tests/i18n.test.mjs and the prune command, so "used" means the
 * same thing in both. A key counts as used when it is:
 *   - a literal t('…') call in web/app.js (not any quoted string: apostrophes
 *     in comments would desync a naive quote scan);
 *   - a [label, tooltip] pair in WEAPON_HEAD (translated at render time);
 *   - static markup in index.html marked with data-i18n / data-i18n-* or <title>;
 *   - a data term shown through term(): faction, unit class, base damage type
 *     ("Explosive" of "Explosive - Penetrating"), weapon target, and the armor
 *     labels from web/lib/calc.js. Names and texts the game localizes itself
 *     (units, weapons, effects, full damage types…) carry their Russian in the
 *     data and never go through the dictionary.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(join(ROOT, path), 'utf8');
const unescape = (s) => s.replace(/\\'/g, "'").replace(/\\n/g, '\n');

/** The RU dictionary, loaded the way the browser loads i18n.js. */
export async function loadDictionary() {
  const context = { localStorage: { getItem: () => null, setItem() {} } };
  context.globalThis = context;
  vm.runInNewContext(await read('web/lib/i18n.js'), context);
  return context.TRI18n.RU;
}

/** Every key the site can ask the dictionary for. */
export async function usedKeys() {
  const used = new Set();
  const app = await read('web/app.js');
  for (const m of app.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) used.add(unescape(m[1]));
  const head = app.match(/const WEAPON_HEAD = \[([\s\S]*?)\n {4}\];/)?.[1] ?? '';
  for (const m of head.matchAll(/'((?:[^'\\]|\\.)*)'/g)) if (m[1]) used.add(unescape(m[1]));

  const html = await read('web/index.html');
  // (?=<): the next tag's "<" must not be consumed, or every other tag is skipped.
  for (const m of html.matchAll(/<[a-z0-9]+\b([^>]*)>([^<]*)(?=<)/g)) {
    if (/\sdata-i18n(\s|$)/.test(m[1]) && m[2].trim()) used.add(m[2].trim());
    for (const [attr, marker] of [['title', 'data-i18n-title'], ['placeholder', 'data-i18n-placeholder'], ['aria-label', 'data-i18n-aria']]) {
      if (!m[1].includes(marker)) continue;
      const value = new RegExp(`${attr}="([^"]*)"`).exec(m[1])?.[1];
      if (value) used.add(value);
    }
  }
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
  if (title) used.add(title);

  const calc = await read('web/lib/calc.js');
  const armorLabels = calc.match(/export const ARMOR_LABEL = \{([\s\S]*?)\};/)?.[1] ?? '';
  for (const m of armorLabels.matchAll(/:\s*'([^']+)'/g)) used.add(m[1]);

  const { units } = JSON.parse(await read('data/units.json'));
  for (const u of units) {
    for (const v of [u.faction, u.unitClass]) if (v) used.add(v);
    for (const w of u.weapons ?? []) {
      const base = typeof w.type?.mp === 'string' ? w.type.mp.split(/\s+-\s+/)[0].trim() : null;
      for (const v of [base, ...(w.targets?.mp ?? [])]) if (v) used.add(v);
    }
  }
  return used;
}

export async function unusedKeys() {
  const [dict, used] = await Promise.all([loadDictionary(), usedKeys()]);
  return Object.keys(dict).filter((k) => !used.has(k));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const unused = await unusedKeys();
  console.log(unused.length ? unused.join('\n') : 'No unused keys.');
  if (process.argv.includes('--prune') && unused.length) {
    let source = await read('web/lib/i18n.js');
    const esc = (k) => k.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const key of unused) {
      // One entry: indent, 'key':, optional line break, 'value', comma, optional trailing comment.
      const entry = new RegExp(`\\n {4}'${esc(key)}':\\s*'(?:[^'\\\\]|\\\\.)*',[^\\n]*`);
      if (!entry.test(source)) { console.error(`Could not remove: ${key}`); process.exitCode = 1; continue; }
      source = source.replace(entry, '');
    }
    await writeFile(join(ROOT, 'web/lib/i18n.js'), source);
    console.log(`Removed ${unused.length} keys.`);
  }
}
