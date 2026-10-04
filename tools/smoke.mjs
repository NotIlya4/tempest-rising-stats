/**
 * smoke.mjs — loads web/index.html in headless Chrome over file://
 * and checks that the page actually rendered, with no console errors.
 *
 * Needed because "the file opened" and "the file works" are different things:
 * an ES module silently fails to load from file:// and the page stays empty.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = pathToFileURL(join(ROOT, 'web/index.html')).href;

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

async function findBrowser() {
  const { access } = await import('node:fs/promises');
  for (const path of CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  return null;
}

const browser = await findBrowser();
if (!browser) {
  console.log('Chrome/Edge not found, smoke test skipped.');
  process.exit(0);
}

const profile = await mkdtemp(join(tmpdir(), 'tr-smoke-'));
let failed = false;

try {
  const { stdout, stderr } = await run(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    // On file:// Chrome hides error details ("Script error." with no line).
    // This flag makes file:// a normal origin for scripts, so errors are visible.
    '--allow-file-access-from-files',
    '--enable-logging=stderr',
    '--log-level=0',
    '--virtual-time-budget=10000',
    `--user-data-dir=${profile}`,
    '--dump-dom',
    PAGE,
  ], { maxBuffer: 64 * 1024 * 1024 });

  // Chrome writes JS errors to stderr as "Uncaught" / "SyntaxError".
  const jsErrors = stderr
    .split(/\r?\n/)
    .filter((line) => /Uncaught|SyntaxError|ReferenceError|TypeError is not|is not defined|CONSOLE.*\berror\b/i.test(line));
  if (jsErrors.length) {
    failed = true;
    console.log('JS errors:');
    for (const line of jsErrors) console.log(`  ${line.trim()}`);
  }

  // The entity count is not hardcoded: the data changes with every game patch,
  // and a fixed number here would break the check on every update.
  const all = JSON.parse(await readFile(join(ROOT, 'data/units.json'), 'utf8')).units;
  // "Hide non-combat" is on by default. Same criteria as isSecondary() in app.js:
  // economy, not a playable faction, destructibles, left out of the game's codex.
  const visibleUnits = all.filter((u) => !u.economy && ['GDF', 'Dynasty', 'Veti'].includes(u.faction)
    && u.kind !== 'destructible' && u.inCodex !== false);
  const total = visibleUnits.length;

  const checks = [
    // Regexes do not end with ">": <tr> also has data-id, and a string like
    // `<tr class="clickable">` stopped matching once that attribute was added.
    // The Russian literals below are page text (the page renders in Russian by default).
    ['page rendered', /<tr class="clickable"/],
    ['rows have data-id', /<tr class="clickable" data-id="[^"]+"/],
    ['entity counter', new RegExp(`\\b${all.length} сущностей`)],
    // "Показано N из M" (Shown N of M): N is after filtering, M is the database total.
    // Different numbers are correct here: they show how many entities the filter hides.
    ['table populated', new RegExp(`Показано ${total} из ${all.length}`)],
    ['DPS column computed', />(\d+\.\d)<\/td>/],
    ['language switch', /id="langSwitch"/],
    ['classic script instead of module', /<script src="lib\/calc\.global\.js"><\/script>/],
  ];
  for (const [name, pattern] of checks) {
    if (!pattern.test(stdout)) {
      failed = true;
      console.log(`FAIL: ${name}: not found ${pattern}`);
    }
  }

  // Table rows = entities, plus 30 rows of the comparison matrix.
  const rows = (stdout.match(/<tr class="clickable"/g) ?? []).length;
  if (rows < total) {
    failed = true;
    console.log(`FAIL: table has ${rows} clickable rows, expected >= ${total}`);
  }

  // Pictures: only the game icons in web/icons/, every one of them on disk.
  const refs = [...stdout.matchAll(/src="([^"]+\.(?:png|jpe?g|webp))"/g)].map((m) => m[1]);
  const foreign = refs.filter((src) => !src.startsWith('icons/'));
  let missingFiles = 0;
  for (const src of new Set(refs.filter((r) => r.startsWith('icons/')))) {
    try { await access(join(ROOT, 'web', src)); } catch { missingFiles++; }
  }
  console.log(`Game icons on the page: ${refs.length - foreign.length}, other pictures: ${foreign.length}, missing files: ${missingFiles}`);
  if (refs.length === 0) {
    failed = true;
    console.log('FAIL: no icons on the page, check web/icons and npm run build');
  }
  if (foreign.length) {
    failed = true;
    console.log(`FAIL: pictures from outside web/icons: ${foreign.slice(0, 3).join(', ')}`);
  }
  if (missingFiles) {
    failed = true;
    console.log(`FAIL: ${missingFiles} icons referenced by the page are not in web/icons`);
  }

  console.log(`Browser: ${browser}`);
  console.log(failed ? 'SMOKE FAILED' : 'SMOKE OK — file:// works, no JS errors');
} finally {
  await rm(profile, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
