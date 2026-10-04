#!/usr/bin/env node
/**
 * extract.mjs — the whole chain from an installed game to the site's committed data.
 * `npm run extract`
 *
 *   1. trdump (C#, CUE4Parse): file list, JSON exports, localization, icon textures
 *   2. nativedefaults (C#):    C++ class defaults of the definition classes, read from the exe
 *                              → out/native-defaults.json (fields a definition does not store)
 *   3. build-stats.mjs:        multiplayer entity set, weapons, hits per attack, native defaults
 *                              verified and applied → out/stats-mp.json
 *   4. locres-terms.mjs:       EN/RU pairs of every game string → out/locres-terms.json
 *                              (reference for the UI dictionary in web/lib/i18n.js)
 *   5. build-site-data.mjs:    data/units.json, data/build-report.json, web/icons/
 *
 * Needs a copy of the game (found in the Steam libraries, or --game / TR_GAME_DIR), the
 * game's AES key in TR_AES_KEY, the .NET SDK 10 and the type mappings extractor/out/Tempest.usmap
 * (extractor/usmapgen, see extractor/README.md). Read-only on the game folder.
 *
 *   node extractor/extract.mjs [--skip-dump] [--game <dir>]
 *
 * --skip-dump  reuse extractor/out/export and extractor/out/icons, run steps 2–5 only
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'out');
const argv = process.argv.slice(2);
const skipDump = argv.includes('--skip-dump');
const gameArg = argv.includes('--game') ? ['--game', argv[argv.indexOf('--game') + 1]] : [];

function run(label, cmd, args) {
  console.log(`\n── ${label}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false });
  if (r.error || r.status !== 0) {
    console.error(`\n${label} failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}`);
    process.exit(1);
  }
}

if (!skipDump) {
  // The key is passed to trdump through the environment only; it is never printed.
  if (!process.env.TR_AES_KEY && !fs.existsSync(path.join(OUT, 'aes-key.txt'))) {
    console.error('No AES key: set TR_AES_KEY (see extractor/README.md, Requirements).');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(OUT, 'Tempest.usmap')) && !process.env.TR_USMAP) {
    console.error('No type mappings: build extractor/out/Tempest.usmap with extractor/usmapgen first (see extractor/README.md).');
    process.exit(1);
  }
  run('build trdump', 'dotnet', ['build', path.join(HERE, 'dump'), '-c', 'Release', '--nologo', '-v', 'q']);
  const trdump = (...args) => run(`trdump ${args[0]}`, 'dotnet', [path.join(HERE, 'dump/bin/Release/net10.0/trdump.dll'), ...args, ...gameArg]);
  trdump('list');
  // Definitions first: the other presets follow their references. Damage types carry the
  // localized damage type name and the resistance attribute a weapon's damage is checked against.
  trdump('json', '@definitions', '@texts', '@pawns', '@montages', '@commands', 'objrefs:DamageType@definitions');
  trdump('locres');
  trdump('png', '@icons');
}

// Read-only on the exe: the constructors are disassembled from the file, never executed.
run('nativedefaults', 'dotnet', ['run', path.join(HERE, 'nativedefaults/nativedefaults.cs'), '--', ...gameArg]);
run('build-stats', process.execPath, [path.join(HERE, 'build-stats.mjs')]);
run('locres-terms', process.execPath, [path.join(HERE, 'locres-terms.mjs')]);
run('build-site-data', process.execPath, [path.join(HERE, 'build-site-data.mjs')]);
console.log('\nDone. Review the diff of data/units.json and data/build-report.json, then npm run check.');
