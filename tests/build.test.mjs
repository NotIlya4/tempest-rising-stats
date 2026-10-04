import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { toGlobalScript, topLevelNames } from '../tools/calc-global.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('topLevelNames extracts top-level declarations', () => {
  assert.deepEqual(topLevelNames('const a = 1;\nfunction b() {}\nclass C {}'), ['a', 'b', 'C']);
  assert.deepEqual(topLevelNames('const a = 1;\nconst a = 2;'), ['a'], 'duplicates are collapsed');
  assert.deepEqual(topLevelNames('if (x) { const inner = 1; }'), [], 'nested declarations do not count');
});

test('toGlobalScript strips export and attaches everything to globalThis', () => {
  const script = toGlobalScript('export const A = 1;\nexport function b() { return A; }\n');
  assert.doesNotMatch(script, /^\s*export\b/m);
  assert.match(script, /globalThis\.TRCalc = \{ A, b \};/);

  const context = {};
  vm.runInNewContext(script, context);
  assert.equal(context.TRCalc.A, 1);
  assert.equal(context.TRCalc.b(), 1);
});

test('the transform throws on import instead of silently producing a broken script', () => {
  // Accepts both message languages while tools/calc-global.mjs is being translated.
  assert.throws(() => toGlobalScript("import x from './x.js';\nconst a = 1;"), /must not import/);
  assert.throws(() => toGlobalScript('// empty'), /No top-level/);
});

test('browser files are syntactically valid', async () => {
  // app.js and calc.global.js are classic scripts for <script src> with no
  // Node tests: the only guard against a typo is the browser smoke test, and it
  // fails late and vaguely. vm.Script catches syntax errors right away, no DOM.
  for (const file of ['web/app.js', 'web/lib/calc.global.js']) {
    const source = await readFile(join(ROOT, file), 'utf8');
    assert.doesNotThrow(() => new vm.Script(source, { filename: file }), `${file} does not parse`);
  }
  // Scripts in index.html must be classic, not module: modules do not load from file://.
  const html = await readFile(join(ROOT, 'web/index.html'), 'utf8');
  assert.doesNotMatch(html, /<script[^>]*type="module"/, 'ES modules do not load from file://');
  assert.match(html, /<script src="data\.js"><\/script>/);
  assert.match(html, /<script src="lib\/calc\.global\.js"><\/script>/);
  assert.match(html, /<script src="app\.js"><\/script>/);
  // Order matters: the calculator and data must come before the app.
  const order = ['data.js', 'lib/calc.global.js', 'app.js'].map((needle) => html.indexOf(needle));
  assert.ok(order[0] < order[1] && order[1] < order[2], `script order is broken: ${order}`);
});

test('every control in the header and filters is wired up in app.js', async () => {
  const html = await readFile(join(ROOT, 'web/index.html'), 'utf8');
  const app = await readFile(join(ROOT, 'web/app.js'), 'utf8');
  for (const id of ['langSwitch', 'q', 'fFaction', 'fTarget', 'fClass', 'hideSecondary', 'toggleEffectFilter', 'toggleExtra', 'resetFilters']) {
    assert.match(html, new RegExp(`id="${id}"`), `markup has no #${id}`);
    assert.match(app, new RegExp(`#${id}\\b`), `app.js does not handle #${id}`);
  }
});

test('removed UI parts stay removed', async () => {
  const html = await readFile(join(ROOT, 'web/index.html'), 'utf8');
  for (const id of ['picSwitch', 'modeSwitch', 'showWeapons', 'panel-quality', 'fKind']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`), `#${id} came back`);
  }
});

test("the page takes nothing from the wiki: only the card's search link, no web/img pictures", async () => {
  for (const file of ['web/index.html', 'web/app.js', 'web/lib/i18n.js', 'web/lib/calc.js']) {
    const source = await readFile(join(ROOT, file), 'utf8');
    const wikiRefs = source.match(/[^\s'"`]*wiki\.gg[^\s'"`]*/g) ?? [];
    assert.deepEqual(wikiRefs.filter((u) => u !== 'https://tempestrising.wiki.gg/index.php?search='), [],
      `${file} references the wiki beyond the card's search link`);
    assert.doesNotMatch(source, /Special:FilePath/, `${file} loads files from the wiki`);
    assert.doesNotMatch(source, /['"`]img\//, `${file} still loads pictures from web/img`);
  }
});

test('generated calc.global.js matches calc.js and actually loads', async () => {
  const source = await readFile(join(ROOT, 'web/lib/calc.js'), 'utf8');
  const built = await readFile(join(ROOT, 'web/lib/calc.global.js'), 'utf8');
  assert.equal(built, toGlobalScript(source), 'run npm run build: web/lib/calc.global.js is stale');

  // Evaluate in a sandbox exactly as a <script> would in the browser.
  const context = { globalThis: undefined };
  context.globalThis = context;
  vm.runInNewContext(built, context);
  const { TRCalc } = context;

  for (const name of ['dps', 'sustainedDps', 'timeToKill', 'pick', 'baseDamageType', 'weaponArmorKey', 'ARMOR_KEYS']) {
    assert.ok(TRCalc[name], `TRCalc.${name} is not exported`);
  }

  // Cross-check against the ES module on real weapons from the database.
  const { units } = JSON.parse(await readFile(join(ROOT, 'data/units.json'), 'utf8'));
  const havoc = units.find((u) => u.id === 'DYN.Unit.RocketBuggy');
  const guard = units.find((u) => u.id === 'DYN.Unit.DynastyGuard');
  const esm = await import('../web/lib/calc.js');
  for (const [key, args] of [
    ['dps', [havoc.weapons[0], guard]],
    ['sustainedDps', [havoc.weapons[0], guard]],
    ['timeToKill', [havoc.weapons[0], guard]],
    ['unitBurst', [havoc, guard]],
  ]) {
    assert.equal(context.TRCalc[key](...args), esm[key](...args),
      `${key} differs between the module and the global script`);
  }
});
