/**
 * probe.mjs — one-off diagnostics of image rendering in the real
 * index.html: copies the page, appends a probe script at the end, loads
 * the copy in headless Chrome and prints what happened.
 *
 * Needed because app.js lives only in the browser and has no unit tests:
 * you can look at the page by eye, or do it this way. Run: node tools/probe.mjs
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const PROBE = join(WEB, '_probe.html');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const script = `
  const out = [];
  const q = (s) => document.querySelectorAll(s);
  const one = (s) => document.querySelector(s);
  // Wait until the browser actually decodes the images: otherwise "failed to load"
  // shows nonsense, since the image simply has not loaded yet.
  const settle = () => new Promise((r) => {
    const imgs = [...q('img.pic')];
    if (!imgs.length) return setTimeout(r, 50);
    const left = imgs.filter((i) => !i.complete);
    if (!left.length) return setTimeout(r, 50);
    let done = 0;
    const tick = () => (++done >= left.length ? setTimeout(r, 50) : undefined);
    for (const i of left) {
      i.addEventListener('load', tick, { once: true });
      i.addEventListener('error', tick, { once: true });
    }
    setTimeout(r, 4000);
  });
  const report = (label) => {
    const imgs = [...q('#arsenalTable img.pic')];
    const bad = imgs.filter((i) => !i.complete || i.naturalWidth === 0);
    const w = imgs.map((i) => Math.round(i.getBoundingClientRect().width)).filter(Boolean);
    out.push(label + ': ' + imgs.length + ' images, width ' + (w.length ? Math.min(...w) + '–' + Math.max(...w) : '—') + 'px, failed to load ' + bad.length +
      (bad.length ? ' -> ' + bad.slice(0, 3).map((i) => i.src.split('/').pop()).join(', ') : ''));
  };
  (async () => {
  try {
    const rows = q('#arsenalTable tbody tr');
    // Only the rows the table shows: non-combat entities are hidden by default.
    const noIcon = filteredUnits().filter((u) => !u.icon).length;
    out.push('game icons: ' + [...q('#arsenalTable img.pic')].filter((i) => i.getAttribute('src').startsWith('icons/')).length);
    out.push('table rows: ' + rows.length);
    out.push('placeholders: ' + q('#arsenalTable .pic-empty').length + ', units without an image in data: ' + noIcon +
      (q('#arsenalTable .pic-empty').length === noIcon ? ' (match)' : ' (MISMATCH)'));
    await settle();
    report('icons');
    out.push('all src are local game icons: ' + [...q('#arsenalTable img.pic')].every((i) => i.src.startsWith('file:') && i.getAttribute('src').startsWith('icons/')));

    rows[0].click();
    const hero = one('#dlgBody .pic-132');
    await settle();
    out.push('card: open=' + one('#unitDialog').open + ', hero ' + (hero ? Math.round(hero.getBoundingClientRect().width) + 'px' : 'NONE') +
      ', images in card ' + q('#dlgBody img.pic').length + ', failed to load ' + [...q('#dlgBody img.pic')].filter((i) => !i.complete || i.naturalWidth === 0).length);
    one('#unitDialog').close();

    one('#tabs button[data-panel="compare"]').click();
    await settle();
    out.push('compare panel: ' + (one('#panel-compare').classList.contains('active') ? 'open' : 'NOT open') + ', rows: ' + q('#cmpOut tbody tr').length);
    one('#tabs button[data-panel="arsenal"]').click();
  } catch (e) {
    out.push('CRASHED: ' + e.message + ' | ' + String(e.stack || '').split('\\n')[1]);
  }
  const pre = document.createElement('pre');
  pre.id = 'probe';
  pre.textContent = out.join('\\n');
  document.body.append(pre);
  })();
`;

const html = await readFile(join(WEB, 'index.html'), 'utf8');
await writeFile(PROBE, html.replace('</body>', `<script>window.addEventListener('error',(e)=>{const p=document.getElementById('probe')||document.createElement('pre');p.id='probe';p.textContent='JS ERROR: '+e.message+' @ '+e.filename+':'+e.lineno;document.body.append(p);});</script>\n<script>${script}</script>\n</body>`), 'utf8');

const browser = CHROME.find(Boolean);
const profile = await mkdtemp(join(tmpdir(), 'tr-probe-'));
let out = '';
try {
  const { stdout } = await run(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--virtual-time-budget=20000',
    `--user-data-dir=${profile}`,
    '--dump-dom', pathToFileURL(PROBE).href,
  ], { maxBuffer: 32 * 1024 * 1024 });
  out = stdout;
} finally {
  await rm(PROBE, { force: true });
  await rm(profile, { recursive: true, force: true });
}

const match = out.match(/<pre id="probe">([\s\S]*?)<\/pre>/);
console.log(match ? match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : 'probe did not run');
