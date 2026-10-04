/**
 * build-public.mjs — builds the public GitHub Pages version into dist/.
 *
 *   node tools/build-public.mjs [--repo=https://github.com/<user>/<repo>]
 *
 * Takes the already built web/ (npm run build) and copies exactly what the
 * page needs: index.html, app.js, data.js, the browser scripts from lib/ and
 * the game icons (web/icons/, curated by extractor/build-site-data.mjs: only the
 * icons the data references). The only difference from the local version is
 * config.js: English is the default language.
 */

import { cp, mkdir, rm, writeFile, readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { configScript } from './site-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const DIST = join(ROOT, 'dist');

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const repoUrl = arg('repo') ?? process.env.TR_REPO_URL ?? null;

const exists = (path) => access(path).then(() => true, () => false);

for (const required of ['data.js', 'lib/calc.global.js']) {
  if (!(await exists(join(WEB, required)))) {
    console.error(`web/${required} is missing — run npm run build first.`);
    process.exit(1);
  }
}

await rm(DIST, { recursive: true, force: true });
await mkdir(join(DIST, 'lib'), { recursive: true });

for (const file of ['index.html', 'app.js', 'data.js', 'lib/calc.global.js', 'lib/i18n.js']) {
  await cp(join(WEB, file), join(DIST, file));
}
await writeFile(join(DIST, 'config.js'), configScript({ defaultLang: 'en', public: true, repoUrl }), 'utf8');
// Without .nojekyll Pages runs the site through Jekyll, which silently drops
// files and folders whose names start with an underscore.
await writeFile(join(DIST, '.nojekyll'), '', 'utf8');

// Icons from the game files: a committed folder holding only the icons the data uses,
// so it is copied whole.
let gameIconCount = 0;
if (await exists(join(WEB, 'icons'))) {
  await cp(join(WEB, 'icons'), join(DIST, 'icons'), { recursive: true });
  gameIconCount = (await readdir(join(DIST, 'icons'))).filter((f) => f.endsWith('.png')).length;
} else {
  console.log('No web/icons/ — the page will show lettered placeholders instead of icons.');
}

console.log(`dist/ is ready: ${gameIconCount} game icons, default language en${repoUrl ? `, repository ${repoUrl}` : ''}.`);
