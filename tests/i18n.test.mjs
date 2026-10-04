/**
 * Completeness of the Russian dictionary. The browser run (uitest, RU) only
 * catches strings that were actually rendered; a rare branch — the "cut"
 * badge, an empty table — could ship untranslated. This checks every key in
 * the source instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { unusedKeys } from '../tools/i18n-usage.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(join(ROOT, path), 'utf8');

/** Loads i18n.js the way the browser does and returns TRI18n. */
async function loadI18n({ defaultLang, stored = null } = {}) {
  const context = {
    ...(defaultLang ? { TR_CONFIG: { defaultLang } } : {}),
    localStorage: { getItem: () => stored, setItem() {} },
  };
  context.globalThis = context;
  vm.runInNewContext(await read('web/lib/i18n.js'), context);
  return context.TRI18n;
}

const unescape = (s) => s.replace(/\\'/g, "'").replace(/\\n/g, '\n');

test("every t('…') in app.js has a Russian translation", async () => {
  const { RU } = await loadI18n();
  const source = await read('web/app.js');
  const keys = [...source.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)].map((m) => unescape(m[1]));
  // WEAPON_HEAD holds [label, tooltip] pairs that are translated at render time.
  const head = source.match(/const WEAPON_HEAD = \[([\s\S]*?)\n {4}\];/)?.[1] ?? '';
  for (const m of head.matchAll(/'((?:[^'\\]|\\.)*)'/g)) if (m[1]) keys.push(unescape(m[1]));
  assert.ok(keys.length > 150, `suspiciously few keys: ${keys.length}`);
  const missing = [...new Set(keys)].filter((k) => !(k in RU));
  assert.deepEqual(missing, []);
});

test('every data-i18n string in index.html has a Russian translation', async () => {
  const { RU } = await loadI18n();
  const html = await read('web/index.html');
  // The whole opening tag first, then its text: the data-i18n marker is looked
  // up among the attributes separately, otherwise a trailing marker eats the
  // tag's closing ">".
  const texts = [...html.matchAll(/<[a-z0-9]+\b([^>]*)>([^<]*)(?=<)/g)]
    .filter((m) => /\sdata-i18n(\s|$)/.test(m[1]))
    .map((m) => m[2].trim())
    .filter(Boolean);
  const attrs = [...html.matchAll(/(title|placeholder|aria-label)="([^"]*)"[^>]*data-i18n-(?:title|placeholder|aria)/g)].map((m) => m[2]);
  const title = html.match(/<title>([^<]*)<\/title>/)[1];
  const missing = [...new Set([...texts, ...attrs, title])].filter((k) => !(k in RU));
  assert.ok(texts.length > 10, `too few data-i18n strings: ${texts.length}`);
  assert.deepEqual(missing, []);
});

test('source code has no Cyrillic outside the dictionary and search synonyms', async () => {
  // RU_SYNONYMS maps Russian search words to English terms — Russian by design.
  const source = (await read('web/app.js')).replace(/const RU_SYNONYMS = \{[\s\S]*?\n\};/, '');
  const offending = source.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /[А-Яа-яЁё]/.test(line) && !/i18n-ok/.test(line));
  assert.deepEqual(offending, []);
});

test('every dictionary key is used somewhere', async () => {
  // Dead translations pile up silently when UI parts are removed.
  // Prune with: node tools/i18n-usage.mjs --prune
  assert.deepEqual(await unusedKeys(), []);
});

test('the dictionary has no duplicate keys', async () => {
  // An object literal silently keeps the last of two equal keys, so a
  // duplicate would quietly override an earlier translation.
  const source = await read('web/lib/i18n.js');
  const start = source.indexOf('const RU = {');
  const body = source.slice(start, source.indexOf('\n  };', start));
  const keys = [...body.matchAll(/(?:\n\s+|, )'((?:[^'\\]|\\.)*)':/g)].map((m) => m[1]);
  assert.ok(keys.length > 150, `too few keys parsed: ${keys.length}`);
  assert.deepEqual(keys.filter((k, i) => keys.indexOf(k) !== i), []);
});

test('placeholders match between the key and the translation', async () => {
  const { RU } = await loadI18n();
  const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const broken = Object.entries(RU).filter(([en, ru]) => names(en).join() !== names(ru).join());
  assert.deepEqual(broken, []);
});

test('t() fills placeholders and respects the language', async () => {
  const en = await loadI18n({ defaultLang: 'en' });
  const ru = await loadI18n({ defaultLang: 'ru' });
  assert.equal(en.t('Tier {n}', { n: 2 }), 'Tier 2');
  assert.equal(ru.t('Tier {n}', { n: 2 }), 'Тир 2');
  assert.equal(en.locale, 'en-US');
  assert.equal(ru.locale, 'ru-RU');
});

test('without config.js the language defaults to English', async () => {
  assert.equal((await loadI18n()).lang, 'en');
});

test("the user's choice wins over the build default", async () => {
  assert.equal((await loadI18n({ defaultLang: 'ru', stored: 'en' })).lang, 'en');
});
