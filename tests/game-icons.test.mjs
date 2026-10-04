// Icons from the game files: every icon data/units.json names (units, effects, doctrines,
// abilities) must be a real PNG in web/icons/, and web/icons/ must hold nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const doc = JSON.parse(await readFile(join(ROOT, 'data/units.json'), 'utf8'));
const unitIcons = doc.units.map((u) => u.icon).filter(Boolean);
const effectIcons = Object.values(doc.effects).map((e) => e.icon).filter(Boolean);
const doctrineIcons = Object.values(doc.doctrines).map((d) => d.icon).filter(Boolean);
const abilityIcons = doc.units.flatMap((u) => u.abilitiesDetails.map((a) => a.icon)).filter(Boolean);
const referenced = new Set([...unitIcons, ...effectIcons, ...doctrineIcons, ...abilityIcons]);

test('the data has game icons of every kind', () => {
  assert.ok(unitIcons.length > doc.units.length * 0.95, `units with an icon: ${unitIcons.length} of ${doc.units.length}`);
  assert.ok(effectIcons.length > 50, `effects with an icon: ${effectIcons.length}`);
  assert.ok(doctrineIcons.length > 30, `doctrines with an icon: ${doctrineIcons.length}`);
  assert.ok(abilityIcons.length > 100, `abilities with an icon: ${abilityIcons.length}`);
});

test('every referenced icon is a valid PNG of at most 256 px in web/icons/', async () => {
  for (const file of referenced) {
    assert.match(file, /^[\w.-]+\.png$/, `unexpected file name ${file}`);
    const buf = await readFile(join(ROOT, 'web/icons', file));
    assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), `${file}: not a PNG`);
    // IHDR right after the signature: width and height, big-endian
    assert.equal(buf.subarray(12, 16).toString('latin1'), 'IHDR', `${file}: no IHDR`);
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    assert.ok(w > 0 && h > 0 && w <= 256 && h <= 256, `${file}: ${w}x${h}`);
  }
});

test('unit icons are at least 128 px, large enough for the unit card', async () => {
  for (const file of new Set(unitIcons)) {
    const buf = await readFile(join(ROOT, 'web/icons', file));
    assert.ok(Math.max(buf.readUInt32BE(16), buf.readUInt32BE(20)) >= 128, file);
  }
});

test('web/icons/ holds only the icons the data uses', async () => {
  const onDisk = (await readdir(join(ROOT, 'web/icons'))).filter((f) => f.endsWith('.png'));
  assert.deepEqual(onDisk.filter((f) => !referenced.has(f)), [], 'files not referenced by data/units.json');
});

test('Detection has its game icon', () => {
  const detection = Object.values(doc.effects).find((e) => e.id === 'Definition.PassiveAbility.Detection');
  assert.equal(detection?.icon, 'T_PassiveAbility_Detection.png');
});
