/**
 * The committed site data (data/units.json), generated from the game files by
 * extractor/build-site-data.mjs, checked against the golden references of
 * extractor/MAINTENANCE.md. These values were confirmed in the game or by two
 * independent sources: if one changes, find out whether the game changed or the
 * extractor broke — never edit the reference to make the test pass.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fillPlaceholders, cleanText, tagMatches, unitClassFromTags } from '../extractor/lib/game-text.mjs';
import { dps } from '../web/lib/calc.js';

const doc = JSON.parse(readFileSync(new URL('../data/units.json', import.meta.url), 'utf8'));
const report = JSON.parse(readFileSync(new URL('../data/build-report.json', import.meta.url), 'utf8'));
const { units } = doc;
const unit = (id) => {
  const u = units.find((x) => x.id === id);
  assert.ok(u, `${id} is missing from data/units.json`);
  return u;
};
const weapon = (id, name) => {
  const w = unit(id).weapons.find((x) => x.name.mp === name);
  assert.ok(w, `${id} has no weapon "${name}"`);
  return w;
};

describe('golden references (extractor/MAINTENANCE.md)', () => {
  test('Acolyte Energy Catalyst: interval 2.0 s — MP override replaces the base asset (1.5), the class default applies (confirmed in game)', () => {
    assert.equal(weapon('VETI.Unit.Acolyte', 'Energy Catalyst').speed.mp, 2);
  });

  test('Sentinel: population 1 from the native class default (confirmed in game)', () => {
    assert.equal(unit('GDF.Unit.Humvee').stats.population.mp, 1);
  });

  test('GDF buildings: main cost plus a 100 foundation; Dynasty has no foundation (confirmed in game)', () => {
    const wall = unit('GDF.Structure.ConcreteWall');
    assert.equal(wall.stats.cost.mp, 100);
    assert.equal(wall.stats.foundationCost.mp, 100);
    const barracks = unit('GDF.Structure.Barracks');
    assert.equal(barracks.stats.cost.mp, 600);
    assert.equal(barracks.stats.foundationCost.mp, 100);
    const foundations = doc.units.filter((u) => u.stats.foundationCost);
    assert.ok(foundations.length > 0 && foundations.every((u) => u.faction === 'GDF'), 'only GDF builds through construction sites');
  });

  test('Dynasty Missile Trooper: health 100 from the native class default (confirmed in game)', () => {
    // Its definition does not store Health; 100 is the constructor default read from the exe.
    assert.equal(unit('DYN.Unit.MissileTrooper').stats.hp.mp, 100);
  });

  test('Sentinel: health 260, cost 500, build 14 s, speed 1500, armor', () => {
    const s = unit('GDF.Unit.Humvee');
    assert.equal(s.name, 'Sentinel');
    assert.equal(s.stats.hp.mp, 260);
    assert.equal(s.stats.cost.mp, 500);
    assert.equal(s.stats.buildTime.mp, 14);
    assert.equal(s.stats.speed.mp, 1500);
    assert.deepEqual(s.armor.mp, { rifle: 50, rocket: 25, explosive: 25, cannon: 0, fire: 50, sniper: 50 });
  });

  test('Sentinel PG68 Minigun: 22 damage, 0.6 s, range 2600, 1 hit', () => {
    const w = weapon('GDF.Unit.Humvee', 'PG68 Minigun');
    assert.equal(w.damage.mp, 22);
    assert.equal(w.speed.mp, 0.6);
    assert.equal(w.range.mp, 2600);
    assert.equal(w.shots.mp, 1);
    assert.equal(w.damagePerVolley.mp, 22);
    assert.equal(w.type.mp, 'Rifle');
  });

  test('Havoc Twin-Pod MRL: 22 × 4 hits, 2.3 s, range 2500, radius 200', () => {
    const w = weapon('DYN.Unit.RocketBuggy', 'Twin-Pod MRL');
    assert.equal(w.damage.mp, 22);
    assert.equal(w.shots.mp, 4);
    assert.equal(w.damagePerVolley.mp, 88);
    assert.equal(w.speed.mp, 2.3);
    assert.equal(w.range.mp, 2500);
    assert.equal(w.aoe.mp, 200);
    assert.equal(w.minDamage, 10);
  });

  test('Grenade Turret: 12 × 6 hits, inner radius 100, outer 600, 2.5 s, range 2800', () => {
    const w = weapon('GDF.Structure.GrenadeTurret', 'HE Grenade Battery');
    assert.equal(w.damage.mp, 12);
    assert.equal(w.shots.mp, 6);
    assert.equal(w.damagePerVolley.mp, 72);
    assert.equal(w.aoe.mp, 600);
    assert.equal(w.aoeInner, 100);
    assert.equal(w.speed.mp, 2.5);
    assert.equal(w.range.mp, 2800);
  });

  test('Porcupine 227mm Rocket Battery: 100, 1 hit, 0.3 s, range 3700, magazine 12, +4 per 12 s', () => {
    const w = weapon('DYN.Unit.PorcupineMissileLauncher', '227mm Rocket Battery');
    assert.equal(w.damage.mp, 100);
    assert.equal(w.shots.mp, 1);
    assert.equal(w.speed.mp, 0.3);
    assert.equal(w.range.mp, 3700);
    assert.equal(w.ammo.mp, 12);
    assert.deepEqual(w.recharge.mp, { time: 12, perRecharge: 4 });
  });

  test('Hammerhand Anti-Tank Guns: 70 × 2 hits, 2.6 s', () => {
    const w = weapon('DYN.Unit.CombatDropship', 'Anti-Tank Guns');
    assert.equal(w.damage.mp, 70);
    assert.equal(w.shots.mp, 2);
    assert.equal(w.damagePerVolley.mp, 140);
    assert.equal(w.speed.mp, 2.6);
  });

  test('Queller 20mm Rotary Cannon: hits unknown (looping attack animation), so no DPS', () => {
    const w = weapon('GDF.Unit.Queller', '20mm Rotary Cannon');
    assert.deepEqual(w.shots, {});
    assert.deepEqual(w.damagePerVolley, {});
    assert.match(w.missing.shots, /looping-section/);
    assert.equal(dps(w, null), null, 'an unknown hit count must not be computed as one hit');
  });
});

describe('what the site publishes', () => {
  test('ability costs carry every resource the command costs', () => {
    const upgrade = doc.units.flatMap((u) => u.abilitiesDetails ?? []).find((a) => a.name === 'Upgrade To Infirmary');
    assert.ok(upgrade, 'Upgrade To Infirmary not found');
    assert.deepEqual(upgrade.costs, { credits: 600, power: 20 });
    const variable = doc.units.flatMap((u) => u.abilitiesDetails ?? []).filter((a) => Object.values(a.costs ?? {}).includes('variable'));
    assert.ok(variable.length > 0, 'runtime-computed costs are marked variable, not dropped');
  });

  test('a doubtful hit count is published as doubtful, not as a plain number', () => {
    // Hammerhand's miniguns: 3 DealDamage events, the third one after the 0.5 s
    // cooldown. The number stays, but it must carry the reason it is uncertain.
    const units = doc.units.filter((u) => u.name === 'Hammerhand');
    const miniguns = units.flatMap((u) => u.weapons).find((w) => w.name.mp === 'Dual Miniguns');
    assert.ok(miniguns, 'Hammerhand Dual Miniguns not found');
    assert.deepEqual(miniguns.shotsDoubt, ['event-after-cooldown']);
  });

  test('no unit or structure has a description field', () => {
    const withText = units.filter((u) => 'description' in u || 'desc' in u || 'descRu' in u);
    assert.deepEqual(withText.map((u) => u.id), []);
  });

  test('no wiki leftovers in the data', () => {
    const text = JSON.stringify(doc);
    assert.doesNotMatch(text, /wiki/i);
    for (const u of units) {
      for (const key of ['page', 'pageId', 'verifiedPatch', 'translations', 'nameTranslit', 'role', 'iconInGame', 'isCut', 'moveType']) {
        assert.ok(!(key in u), `${u.id} still has ${key}`);
      }
    }
  });

  test('ids are the game\'s AssetIdentifiers and unique', () => {
    const ids = units.map((u) => u.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const u of units) assert.equal(`Definition.${u.id}`, u.gameId);
  });

  test('three playable factions plus neutral entities', () => {
    const factions = new Set(units.map((u) => u.faction));
    assert.deepEqual([...factions].sort(), ['Dynasty', 'GDF', 'Neutral', 'Veti']);
    for (const f of ['GDF', 'Dynasty', 'Veti']) {
      assert.ok(units.filter((u) => u.faction === f && u.kind === 'unit').length > 20, `${f} units`);
    }
  });

  test('every unit has English and Russian names from the game', () => {
    for (const u of units) assert.ok(u.name, `${u.id}: no name`);
    const withRu = units.filter((u) => u.nameRu);
    assert.ok(withRu.length > units.length * 0.95, `Russian names: ${withRu.length} of ${units.length}`);
  });

  test('a missing number is absent, never 0 or 1 in its place, and its reason is recorded', () => {
    for (const u of units) {
      for (const [field, value] of Object.entries(u.stats)) {
        if (value.mp === undefined) assert.ok(u.missing?.[field] ?? u.notApplicable?.[field], `${u.id}.${field}: no reason`);
      }
      for (const w of u.weapons) {
        if (!w.utility && w.shots.mp === undefined) {
          assert.ok(w.missing?.shots, `${u.id} / ${w.name.mp}: hits unknown without a reason`);
          assert.equal(w.damagePerVolley.mp, undefined, `${u.id} / ${w.name.mp}: volley damage without a hit count`);
        }
        if (w.damage.mp !== undefined && w.shots.mp !== undefined) {
          assert.ok(Math.abs(w.damagePerVolley.mp - w.damage.mp * w.shots.mp) < 1e-6, `${u.id} / ${w.name.mp}`);
        }
      }
    }
  });

  test('the build report lists the unknown hit counts and the tier decision', () => {
    assert.equal(report.counts.armedWeaponsWithoutHits, report.hitsUnknown.length);
    assert.ok(report.nulls.some((n) => n.field === 'tier'), 'tier: no recorded reason');
    assert.equal(report.counts.entities, units.length);
  });

  test('effects, doctrines and abilities referenced by units exist and have names', () => {
    for (const u of units) {
      for (const k of [...u.unitEffects.map((e) => e.base), ...u.weapons.flatMap((w) => w.effects)]) {
        assert.ok(doc.effects[k]?.name?.en, `${u.id}: effect ${k}`);
      }
      for (const k of u.doctrines) assert.ok(doc.doctrines[k]?.name?.en, `${u.id}: doctrine ${k}`);
      for (const a of u.abilitiesDetails) assert.ok(a.name, `${u.id}: ability without a name`);
      for (const group of u.requires) for (const r of group) assert.ok(units.some((x) => x.id === r.id), `${u.id}: requires ${r.id}`);
      for (const id of u.producedBy) assert.ok(units.some((x) => x.id === id), `${u.id}: produced by ${id}`);
    }
  });

  test('Sentinel has its game abilities with Russian text and cooldown', () => {
    const marking = unit('GDF.Unit.Humvee').abilitiesDetails.find((a) => a.id === 'TedCmd_Humvee_MarkingMode');
    assert.equal(marking.name, 'Marking Projectiles');
    assert.ok(marking.nameRu && /[А-Яа-я]/.test(marking.nameRu));
    assert.equal(marking.cooldown, 15);
  });

  test('effect descriptions take their numbers from the asset (Comms Field: 30%)', () => {
    const comms = Object.values(doc.effects).find((e) => e.id === 'Definition.PassiveAbility.Comms');
    assert.match(comms.desc.en, /30%/);
    assert.doesNotMatch(comms.desc.en, /\{\w+\}/);
  });
});

describe('native class defaults (values the definitions do not store)', () => {
  // A field a definition does not store has the C++ constructor value of its class; the
  // extractor reads it from the exe and verifies it against every stored value (see
  // extractor/MAINTENANCE.md, "Native class defaults").
  test('the exe reading passed the engine check and collides with no stored value', () => {
    assert.match(report.nativeDefaults.verification[0], /MinimumDamage 0, DamageFalloff 1: passed/);
    assert.match(report.nativeDefaults.verification[1], / 0 collisions/);
    const u = report.nativeDefaults.usedFields;
    assert.equal(u.TedUnitDefinitionAsset.PopulationCost.value, 1);
    assert.equal(u.TedUnitDefinitionAsset.MovementSpeed.value, 500);
    assert.equal(u.TedStructureDefinitionAsset.Health.value, 1000);
    assert.equal(u.TedWeaponDefinitionAsset.AttackCooldown.value, 2);
    assert.equal(u.TedWeaponDefinitionAsset.bDealsInstantDamage.value, true);
    assert.equal(u.TedWeaponDefinitionAsset.DamageKind.value, 'EDamageKind::Point');
  });

  test('filled values: Missile Trooper HP, Sentinel population, Demolitionist speed', () => {
    const mt = unit('DYN.Unit.MissileTrooper');
    assert.equal(mt.stats.hp.mp, 100);
    assert.ok(mt.nativeDefaults.includes('hp'));
    const s = unit('GDF.Unit.Humvee');
    assert.equal(s.stats.population.mp, 1);
    assert.ok(s.nativeDefaults.includes('population'));
    assert.equal(unit('DYN.Unit.Demolitionist').stats.speed.mp, 500);
    // every filled value is in the report with its source
    const f = report.filled.find((x) => x.entity === 'Definition.DYN.Unit.MissileTrooper' && x.field === 'stats.hp');
    assert.match(f.source, /TedUnitDefinitionAsset constructor in the exe sets Health = 100/);
  });

  test('filled weapon values: Acolyte Energy Catalyst interval 2 s, targets ground and air', () => {
    const w = weapon('VETI.Unit.Acolyte', 'Energy Catalyst');
    assert.equal(w.speed.mp, 2);
    assert.deepEqual(w.targets.mp, ['ground', 'air']);
    assert.ok(w.nativeDefaults.includes('AttackCooldown'));
    // Havoc stores RadialDamageParams without InnerRadius: the struct default is 90, not 0
    assert.equal(weapon('DYN.Unit.RocketBuggy', 'Twin-Pod MRL').aoeInner, 90);
  });

  test('not applicable is not unknown: a mine has no cost, a structure no speed', () => {
    const mine = unit('GDF.Destructible.ATMine');
    assert.equal(mine.stats.cost.mp, undefined);
    assert.match(mine.notApplicable.cost, /not buildable/);
    assert.equal(mine.missing.cost, undefined);
    const wall = unit('GDF.Structure.ConcreteWall');
    assert.equal(wall.stats.cost.mp, 100, 'buildable, Cost not stored: native default');
    assert.match(wall.notApplicable.speed, /no MovementSpeed property/);
    const basic = /^stats\.(hp|cost|buildTime|population|speed|sight|intelCost)$/;
    assert.deepEqual(report.nulls.filter((n) => basic.test(n.field)), [], 'no unknown basic stats left');
  });

  test('Intel-priced entity: Comms Officer costs 0 credits and 20 Intel', () => {
    const c = unit('GDF.Unit.CommsOfficer');
    assert.equal(c.stats.cost.mp, 0);
    assert.equal(c.stats.intelCost.mp, 20);
    assert.equal(unit('GDF.Unit.Humvee').stats.intelCost.mp, 0, 'credits only: IntelCost native default 0');
  });
});

describe('generator helpers', () => {
  test('fillPlaceholders fills known values and marks unknown ones with "?"', () => {
    assert.deepEqual(fillPlaceholders('+{A}% for {B} s', { A: '30' }), { text: '+30% for ? s', unresolved: ['B'] });
    assert.deepEqual(fillPlaceholders('no placeholders', {}), { text: 'no placeholders', unresolved: [] });
    assert.deepEqual(fillPlaceholders(null), { text: null, unresolved: [] });
  });

  test('cleanText normalizes line breaks and trims names', () => {
    assert.equal(cleanText('Civilian '), 'Civilian');
    assert.equal(cleanText('a \r\nb'), 'a\nb');
    assert.equal(cleanText('   '), null);
  });

  test('tagMatches follows gameplay-tag rules', () => {
    assert.ok(tagMatches('Definition.GDF.Unit.Humvee', 'Definition.GDF.Unit.Humvee', true));
    assert.ok(tagMatches('Definition.GDF.Unit.Humvee', 'Definition.GDF.Unit', false));
    assert.ok(!tagMatches('Definition.GDF.Unit.Humvee', 'Definition.GDF.Unit', true));
    assert.ok(!tagMatches('Definition.GDF.UnitX', 'Definition.GDF.Unit', false), 'a prefix is not a parent tag');
  });

  test('unitClassFromTags prefers the most specific pawn type', () => {
    assert.equal(unitClassFromTags(['PawnType.Unit.Support', 'PawnType.Unit.Infantry']), 'infantry');
    assert.equal(unitClassFromTags(['PawnType.Unit.Vehicle.Air']), 'aircraft');
    assert.equal(unitClassFromTags(['PawnType.Unit.Vehicle.Heavy']), 'vehicle');
    assert.equal(unitClassFromTags(['PawnType.Structure.Superweapon']), 'superweapon');
    assert.equal(unitClassFromTags(['PawnType.Structure.Defensive.Tower']), 'structure');
    assert.equal(unitClassFromTags(['Status.Uncrushable']), null);
  });
});
