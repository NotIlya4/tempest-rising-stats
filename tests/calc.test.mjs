import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  pick,
  armorValue,
  armorMultiplier,
  baseDamageType,
  hitDamage,
  dps,
  sustainedDps,
  timeToKill,
  costPerSecond,
  unitWeaponStats,
  unitBurst,
  unitAoe,
  unitRange,
  unitInterval,
  effectiveHp,
  sortNumber,
  rowComparator,
  sortRows,
  weaponArmorKey,
} from '../web/lib/calc.js';
import { readFileSync } from 'node:fs';

// The real database — so we check against more than hand-written fixtures.
const { units } = JSON.parse(readFileSync(new URL('../data/units.json', import.meta.url), 'utf8'));

const Havoc = {
  id: 'Havoc',
  faction: 'Dynasty',
  stats: { hp: { mp: 290, sp: 250 }, cost: { mp: 350 }, buildTime: { mp: 12 } },
  armor: { mp: { rifle: 50, rocket: 25, explosive: 25, cannon: 0, fire: 50, sniper: 50 } },
  weapons: [{ slot: 1, name: { mp: 'Twin-Pod MRL' }, type: { mp: 'Rocket' }, damagePerVolley: { mp: 88 }, damage: { mp: 22 }, shots: { mp: 4 }, speed: { mp: 2.3, sp: 2.2 } }],
};

// Dynasty Guard: infantry, 0% armor vs Rifle
const Guard = {
  id: 'Dynasty Guard',
  stats: { hp: { mp: 300 } },
  armor: { mp: { rifle: 0, rocket: 75, explosive: 0, cannon: 75, fire: 0, sniper: 0 } },
  weapons: [],
};

// Regular infantry with full default armor
const RiotTrooper = {
  id: 'Riot Trooper',
  stats: { hp: { mp: 400 } },
  armor: { mp: { rifle: 25, rocket: 75, explosive: 0, cannon: 75, fire: 0, sniper: 0 } },
  weapons: [],
};

/** Comparison with tolerance — numbers like 88/2.3 aren't rounded by hand. */
const close = (actual, expected, eps = 1e-9, msg = '') =>
  assert.ok(Math.abs(actual - expected) < eps, `${msg} expected ~${expected}, got ${actual}`);

const Porcupine = {
  id: 'Porcupine',
  stats: { hp: { mp: 500 }, cost: { mp: 1000 }, buildTime: { mp: 30 } },
  armor: { mp: { rifle: 25, rocket: 0, explosive: 0, cannon: 0, fire: 0, sniper: 0 } },
  weapons: [
    {
      slot: 1,
      name: { mp: 'Cluster Barrage' },
      type: { mp: 'Rocket' },
      damagePerVolley: { mp: 100 },
      damage: { mp: 100 },
      speed: { mp: 0.3 },
      ammo: { mp: 12 },
      recharge: { mp: { time: 12, perRecharge: 4 } },
    },
  ],
};

describe('pick — variant selection with fallback', () => {
  test('takes the requested variant', () => {
  });
  test('falls back to mp if there is no sp', () => {
    assert.equal(pick({ mp: 1 }, 'st'), 1);
  });
  test('empty value — undefined', () => {
    assert.equal(pick({}), undefined);
    assert.equal(pick(undefined), undefined);
  });
  test('0 is not considered empty', () => {
  });
});

describe('armor', () => {
  test('armorValue by damage type', () => {
    assert.equal(armorValue(Guard, 'Rifle'), 0);
    assert.equal(armorValue(Guard, 'Rocket'), 75);
  });
  test('Omni ignores armor', () => {
    assert.equal(armorValue(Guard, 'Omni'), undefined);
    assert.equal(armorMultiplier(Guard, 'Omni'), 1);
  });
  test('multiplier: 0% armor = 1, 75% = 0.25', () => {
    assert.equal(armorMultiplier(Guard, 'Rifle'), 1);
    assert.equal(armorMultiplier(Guard, 'Rocket'), 0.25);
  });
  test('100% armor = full immunity', () => {
    const target = { armor: { mp: { rifle: 100 } } };
    assert.equal(armorMultiplier(target, 'Rifle'), 0);
  });
});

describe('damage type', () => {
  test('the qualifier is dropped', () => {
    assert.equal(baseDamageType({ type: { mp: 'Explosive - Penetrating' } }), 'Explosive');
    assert.equal(baseDamageType({ type: { mp: 'Cannon - Laser' } }), 'Cannon');
  });
  test('a simple type is left alone', () => {
    assert.equal(baseDamageType({ type: { mp: 'Rifle' } }), 'Rifle');
  });
});

describe('DPS', () => {
  test('50 damage x3 / 1.5s, 40% armor', () => {
    // 150 per attack -> 90 after armor -> DPS 60
    const weapon = { type: { mp: 'Rifle' }, damagePerVolley: { mp: 150 }, speed: { mp: 1.5 } };
    const target = { armor: { mp: { rifle: 40 } } };
    const hit = hitDamage(weapon, target);
    assert.equal(hit.raw, 150);
    close(hit.afterArmor, 90, 1e-9, '150 × 0.6');
    close(dps(weapon, target), 60);
  });

  test('Havoc vs Dynasty Guard: 88 per volley / 2.3s, Guard has 75% armor vs Rocket', () => {
    const value = dps(Havoc.weapons[0], Guard);
    close(value, (88 * 0.25) / 2.3, 1e-9, '88 × 0.25 / 2.3');
  });

  test('Havoc vs an unarmored wall — full damage', () => {
    const wall = { armor: { mp: { rifle: 0, rocket: 0, explosive: 0, cannon: 0, fire: 0, sniper: 0 } } };
    close(dps(Havoc.weapons[0], wall), 88 / 2.3);
  });

  test('with no target it is computed against 0% armor', () => {
    close(dps(Havoc.weapons[0], null), 88 / 2.3);
  });

  test('no speed — null, not Infinity', () => {
    assert.equal(dps({ damagePerVolley: { mp: 10 } }, Guard), null);
  });

  test('a weapon without a damage type is computed as against 0% armor', () => {
    // Type unknown → no armor to apply, compute without it
    close(dps({ damagePerVolley: { mp: 88 }, speed: { mp: 2.3 } }, Guard), 88 / 2.3);
  });
});

describe('unknown hit count', () => {
  test('without damagePerVolley there is no attack damage, even if per-hit damage is known', () => {
    // The game data gives no hit count for a looping attack animation: computing as if the
    // attack hit once would publish a plausible wrong number.
    const w = { type: { mp: 'Rifle' }, damage: { mp: 8 }, shots: {}, damagePerVolley: {}, speed: { mp: 0.5 } };
    assert.equal(hitDamage(w, null), null);
    assert.equal(dps(w, null), null);
    assert.equal(sustainedDps(w, null), null);
    assert.equal(timeToKill(w, Guard), null);
  });
});

describe('armor key from the game', () => {
  test('armorKey (the damage type resistance attribute) wins over the type name', () => {
    // A damage type named "Rifle" that ignores resistances (armorKey null) is not reduced.
    const ignoring = { type: { mp: 'Rifle' }, armorKey: null, damagePerVolley: { mp: 100 }, speed: { mp: 1 } };
    const target = { armor: { mp: { rifle: 50 } } };
    assert.equal(weaponArmorKey(ignoring), null);
    close(dps(ignoring, target), 100);
    close(dps({ ...ignoring, armorKey: 'rifle' }, target), 50);
  });
  test('without armorKey the damage type name decides', () => {
    assert.equal(weaponArmorKey({ type: { mp: 'Explosive - Penetrating' } }), 'explosive');
    assert.equal(weaponArmorKey({ type: { mp: 'Omni' } }), null);
  });
});

describe('time to kill', () => {
  test('Havoc vs Dynasty Guard', () => {
    // 300 hp / (88 × 0.25 / 2.3)
    close(timeToKill(Havoc.weapons[0], Guard), 300 / ((88 * 0.25) / 2.3));
  });
  test('target has no HP — null', () => {
    assert.equal(timeToKill(Havoc.weapons[0], { armor: { mp: {} } }), null);
  });
  test('0 DPS — null, not Infinity', () => {
    const invulnerable = { armor: { mp: { rifle: 100, rocket: 100, explosive: 100, cannon: 100, fire: 100, sniper: 100 } }, stats: { hp: { mp: 100 } } };
    assert.equal(timeToKill(Havoc.weapons[0], invulnerable), null);
  });
});

describe('sustained DPS with ammo', () => {
  test('Porcupine: 12 volleys in 3.6s, then a 36s reload (3 × 12s for 4 rounds each)', () => {
    // 12 × 100 = 1200 damage; 0% armor vs Rocket
    close(sustainedDps(Porcupine.weapons[0], { armor: { mp: { rocket: 0 } } }), 1200 / (12 * 0.3 + 36));
  });
  test('without ammo sustained = regular DPS', () => {
    assert.equal(sustainedDps(Havoc.weapons[0], Guard), dps(Havoc.weapons[0], Guard));
  });
  test('sustained is never greater than burst', () => {
    assert.ok(sustainedDps(Porcupine.weapons[0], null) < dps(Porcupine.weapons[0], null));
  });
});

describe('economy', () => {
  test('cost per second', () => {
    close(costPerSecond(Havoc), 350 / 12);
  });
  test('no build time — null', () => {
    assert.equal(costPerSecond({ stats: { cost: { mp: 100 } } }), null);
  });
  test('no price — null', () => {
    assert.equal(costPerSecond({ stats: { buildTime: { mp: 20 } } }), null);
  });
  test('price in mp: campaign numbers are not substituted', () => {
    const unit = { stats: { cost: { mp: 500, st: 400 }, buildTime: { mp: 20, st: 15 } } };
    close(costPerSecond(unit), 500 / 20);
  });
});

describe('unit summary', () => {
  test('best DPS and the sum across all combat slots', () => {
    const two = {
      ...Havoc,
      weapons: [Havoc.weapons[0], { slot: 2, name: { mp: 'Second' }, type: { mp: 'Rifle' }, damagePerVolley: { mp: 10 }, speed: { mp: 1 } }],
    };
    const stats = unitWeaponStats(two, Guard);
    assert.equal(stats.perWeapon.length, 2);
    assert.equal(stats.best, dps(two.weapons[1], Guard), 'the second slot, with no armor vs Rifle, hits harder');
    close(stats.total, dps(two.weapons[0], Guard) + dps(two.weapons[1], Guard));
  });
  test('utility slots are not counted', () => {
    const mixed = { ...Havoc, weapons: [Havoc.weapons[0], { slot: 2, name: { mp: 'Standoff Orders' }, utility: true }] };
    assert.equal(unitWeaponStats(mixed, Guard).perWeapon.length, 1);
  });
  test('a unit without weapons — zeros, not an exception', () => {
    const stats = unitWeaponStats(Guard, Guard);
    assert.equal(stats.best, null);
    assert.equal(stats.total, null);
  });
test('burst takes the main weapon\'s damage, not the sum', () => {
    // Regression. All weapons used to be summed: Demolitionist showed 470
    // (pile driver 300 + spark thrower 170), even though against a single target it deals 300.
    // The sum is damage “across all targets”, while the player chooses where to aim each weapon.
    const two = {
      ...Havoc,
      weapons: [Havoc.weapons[0], { slot: 2, name: { mp: 'Second' }, type: { mp: 'Rifle' }, damagePerVolley: { mp: 10 }, speed: { mp: 1 } }],
    };
    const perWeapon = unitWeaponStats(two, Guard, {}).perWeapon;
    const bestWeapon = perWeapon.reduce((a, b) => ((b.dps ?? -1) > (a.dps ?? -1) ? b : a));
    close(unitBurst(two, Guard, {}), hitDamage(bestWeapon.weapon, Guard).effective);
    const sum = hitDamage(two.weapons[0], Guard).effective + hitDamage(two.weapons[1], Guard).effective;
    assert.ok(unitBurst(two, Guard, {}) < sum, 'burst still sums the weapons');
  });

  test('burst for a single-weapon unit equals that weapon\'s damage', () => {
    close(unitBurst(Havoc, Guard, {}), hitDamage(Havoc.weapons[0], Guard).effective);
  });

  test('Demolitionist burst is not inflated by summing weapons', () => {
    const demo = units.find((u) => u.id === 'DYN.Unit.Demolitionist');
    const value = unitBurst(demo, null, {});
    assert.ok(value <= 300, `got ${value}, the sum would be 470`);
    assert.ok(value >= 250, `got ${value}, looks like the sum rather than the best weapon`);
  });
  test('EHP is higher with more armor', () => {
    const soft = { stats: { hp: { mp: 100 } }, armor: { mp: { rifle: 0 } } };
    const tough = { stats: { hp: { mp: 100 } }, armor: { mp: { rifle: 50 } } };
    assert.ok(effectiveHp(tough) > effectiveHp(soft));
  });
});

// ─────────────────────────────────────────────────────────── table sorting
//
// Regression: columns with graphics (armor, faction) returned a DOM node,
// a node in subtraction gives NaN, and Array.sort with NaN silently reordered nothing —
// the table looked “unsortable”. Numeric columns returned a formatted
// string and sorted lexicographically: 900 ended up after 1000.

describe('row sorting', () => {
  const rows = [
    { id: 'a', armor: { mp: { rocket: 80 } }, stats: { hp: { mp: 1000 } } },
    { id: 'b', armor: { mp: { rocket: 10 } }, stats: { hp: { mp: 150 } } },
    { id: 'c', stats: { hp: { mp: 900 } } },
    { id: 'd', armor: { mp: { rocket: 50 } }, stats: { hp: { mp: 2000 } } },
  ];
  const byId = (list) => list.map((u) => u.id);

  test('numbers sort numerically, not as strings', () => {
    assert.deepEqual(byId(sortRows(rows, (u) => sortNumber(u.stats?.hp?.mp))), ['b', 'c', 'a', 'd']);
  });

  test('numbers sort numerically in descending order too', () => {
    assert.deepEqual(byId(sortRows(rows, (u) => sortNumber(u.stats?.hp?.mp), -1)), ['d', 'a', 'c', 'b']);
  });

  test('a key function returning a DOM node no longer breaks sorting', () => {
    // This is exactly what the bug looked like: a node instead of a number.
    const node = (v) => ({ nodeType: 1, textContent: String(v) });
    const withNode = sortRows(rows, (u) => (u.armor ? node(u.armor.mp.rocket) : undefined));
    assert.equal(withNode.length, rows.length);
    assert.deepEqual(byId(sortRows(rows, (u) => sortNumber(u.armor?.mp?.rocket))), ['b', 'd', 'a', 'c']);
  });

  test('the armor column sorts descending without NaN', () => {
    // Regression for “rocket resistance”: the order must differ from the original.
    const desc = byId(sortRows(rows, (u) => sortNumber(u.armor?.mp?.rocket), -1));
    assert.deepEqual(desc, ['a', 'd', 'b', 'c']);
    assert.notDeepEqual(desc, byId(rows));
  });

  test('empty values go to the bottom in both directions and don\'t jump', () => {
    const asc = byId(sortRows(rows, (u) => sortNumber(u.armor?.mp?.rocket), 1));
    const desc = byId(sortRows(rows, (u) => sortNumber(u.armor?.mp?.rocket), -1));
    assert.equal(asc.at(-1), 'c', 'no armor — at the bottom when ascending');
    assert.equal(desc.at(-1), 'c', 'no armor — at the bottom when descending too');
  });

  test('sortNumber rejects junk: null, undefined, NaN, Infinity, strings', () => {
    for (const bad of [null, undefined, NaN, Infinity, -Infinity, '80', '', {}]) {
      assert.equal(sortNumber(bad), undefined, `${String(bad)} must not count as a number`);
    }
    assert.equal(sortNumber(0), 0, 'zero is a real value, not “empty”');
  });

  test('strings compare naturally, taking embedded numbers into account', () => {
    const tiers = [{ n: 'tier 10' }, { n: 'tier 2' }, { n: 'alpha' }];
    assert.deepEqual(tiers.sort(rowComparator((u) => u.n, 1)).map((u) => u.n), ['alpha', 'tier 2', 'tier 10']);
  });

  test('sorting does not mutate the original array', () => {
    const source = [...rows];
    sortRows(source, (u) => sortNumber(u.stats?.hp?.mp), -1);
    assert.deepEqual(byId(source), byId(rows));
  });

  test('equal values neither break the order nor crash the sort', () => {
    const same = [{ id: 'x', v: 5 }, { id: 'y', v: 5 }, { id: 'z', v: 5 }];
    assert.equal(sortRows(same, (u) => u.v).length, 3);
  });

  test('null is treated as a missing value, not as the string “null”', () => {
    // Regression: moveType can be null, and without ?? it sorted as “null”
    // between Tracked and Wheeled.
    const types = [{ t: 'Tracked' }, { t: null }, { t: 'Wheeled' }, { t: undefined }];
    const asc = sortRows(types, (u) => u.t ?? undefined).map((u) => u.t);
    assert.deepEqual(asc.slice(0, 2), ['Tracked', 'Wheeled']);
    assert.ok(!asc.includes('null'), 'the string “null” ended up in the result');
    assert.equal(asc.length, 4);
    // Both “empty” values at the bottom in either direction.
    assert.ok(asc.at(-1) === null || asc.at(-1) === undefined);
    const desc = sortRows(types, (u) => u.t ?? undefined, -1).map((u) => u.t);
    assert.ok(desc.at(-1) === null || desc.at(-1) === undefined, 'an empty value jumped to the top');
  });
});

describe('unitAoe — unit blast radius', () => {
  const g = (aoe) => ({ weapons: [{ slot: 1, utility: false, aoe }] });
  const multi = (...radii) => ({ weapons: radii.map((a, i) => ({ slot: i + 1, utility: false, aoe: a })) });

  test('takes the radius of the only combat weapon', () => {
    assert.equal(unitAoe(g({ mp: 200 }), {}), 200);
  });

  test('takes the maximum across weapons — the unit\'s “biggest volley”', () => {
    assert.equal(unitAoe(multi({ mp: 100 }, { mp: 500 }, { mp: 250 }), {}), 500);
  });

  test('zero radii don\'t prevent finding a non-zero one', () => {
    assert.equal(unitAoe(multi({ mp: 0 }, { mp: 260 }), {}), 260);
  });

  test('utility slots are ignored', () => {
    const u = { weapons: [{ slot: 1, utility: true, aoe: { mp: 999 } }, { slot: 2, utility: false, aoe: { mp: 120 } }] };
    assert.equal(unitAoe(u), 120, 'an ability without damage must not set the AoE');
  });

  test('no weapons or no radius — null, not 0', () => {
    assert.equal(unitAoe({ weapons: [] }), null);
    assert.equal(unitAoe({ weapons: [{ slot: 1, utility: false, aoe: {} }] }, {}), null);
    assert.equal(unitAoe(undefined), null);
  });

  test('0 is a genuine zero, not “no data”', () => {
    assert.equal(unitAoe(g({ mp: 0 }), {}), 0);
  });

  test('follows the variant: mp and sp may differ', () => {
    const u = g({ mp: 300, sp: 100 });
    assert.equal(unitAoe(u), 300);
  });

  test('on real data Porcupine MLRS has the biggest volley radius of 200', () => {
    const porcupine = units.find((u) => u.id === 'DYN.Unit.PorcupineMissileLauncher');
    assert.equal(unitAoe(porcupine), 200);
  });
});
describe('unitRange — unit range', () => {
  const g = (range) => ({ weapons: [{ slot: 1, utility: false, range }] });
  const multi = (...ranges) => ({ weapons: ranges.map((r, i) => ({ slot: i + 1, utility: false, range: r })) });

  test('takes the range of the only combat weapon', () => {
    assert.equal(unitRange(g({ mp: 1950 }), {}), 1950);
  });

  test('takes the maximum across weapons — the unit\'s longest shot', () => {
    assert.equal(unitRange(multi({ mp: 1200 }, { mp: 3700 }), {}), 3700);
  });

  test('utility slots are ignored', () => {
    const u = { weapons: [{ slot: 1, utility: true, range: { mp: 99999 } }, { slot: 2, utility: false, range: { mp: 800 } }] };
    assert.equal(unitRange(u), 800);
  });

  test('no weapons or no range — null, not 0', () => {
    assert.equal(unitRange({ weapons: [] }), null);
    assert.equal(unitRange({ weapons: [{ slot: 1, utility: false, range: {} }] }, {}), null);
    assert.equal(unitRange(undefined), null);
  });

  test('takes multiplayer', () => {
    const u = g({ mp: 1950, sp: 1700 });
    assert.equal(unitRange(u), 1950);
  });

  test('on real data Porcupine MLRS has a range of 3700', () => {
    const porcupine = units.find((u) => u.id === 'DYN.Unit.PorcupineMissileLauncher');
    assert.equal(unitRange(porcupine), 3700);
  });
});

describe('unitInterval — main weapon interval', () => {
  const g = (speed) => ({ weapons: [{ slot: 1, utility: false, speed }] });

  test('takes the interval of the only combat weapon', () => {
    assert.equal(unitInterval(g({ mp: 1.5 }), {}), 1.5);
  });

  test('takes multiplayer, not the sp variant', () => {
    assert.equal(unitInterval(g({ mp: 2, sp: 7 }), {}), 2);
  });

  // The key difference from unitAoe/unitRange: a maximum makes no sense here. For a unit with
  // a machine gun (0.5 s) and a mortar (4 s) the “maximum interval” is the interval of
  // the SLOWEST weapon, and the column would describe a different weapon than DPS.
  test('takes the weapon with the highest DPS, not the slowest one', () => {
    const u = {
      weapons: [
        { slot: 1, utility: false, speed: { mp: 0.5 }, damagePerVolley: { mp: 10 } },
        { slot: 2, utility: false, speed: { mp: 4 }, damagePerVolley: { mp: 400 } },
      ],
    };
    assert.equal(unitInterval(u, {}), 4, 'the mortar hits harder — so it is the one shown');
  });

  test('on equal DPS the higher damage wins — the same choice as in unitBurst', () => {
    const u = {
      weapons: [
        { slot: 1, utility: false, speed: { mp: 2 }, damagePerVolley: { mp: 20 } },
        { slot: 2, utility: false, speed: { mp: 3 }, damagePerVolley: { mp: 60 } },
      ],
    };
    assert.equal(unitInterval(u, {}), 3);
  });

  test('utility slots are ignored', () => {
    const u = { weapons: [{ slot: 1, utility: true, speed: { mp: 99 } }, { slot: 2, utility: false, speed: { mp: 1.25 } }] };
    assert.equal(unitInterval(u, {}), 1.25);
  });

  test('no weapons or no interval — null, not 0', () => {
    assert.equal(unitInterval({ weapons: [] }), null);
    assert.equal(unitInterval({ weapons: [{ slot: 1, utility: false, speed: {} }] }, {}), null);
    assert.equal(unitInterval(undefined), null);
  });

  test('0 is not an interval: a weapon without an interval has none', () => {
    assert.equal(unitInterval(g({ mp: 0 }), {}), null);
  });

  test('on real data Pillager has a 1 s interval (single weapon)', () => {
    const pillager = units.find((u) => u.id === 'DYN.Unit.Pillager');
    assert.equal(unitInterval(pillager), 1);
  });

  // Hammerhand is the telling case: two weapons with different intervals. From the game's
  // attack animations the Dual Miniguns deal 15 × 3 every 0.5 s (90 DPS) and the Anti-Tank
  // Guns 70 × 2 every 2.6 s (53.85 DPS). The column must show 0.5 — the interval of the
  // weapon that produces the row's DPS, not the slowest one.
  test('on real data Hammerhand has a 0.5 s interval — from the highest-DPS weapon', () => {
    const hammerhand = units.find((u) => u.id === 'DYN.Unit.CombatDropship');
    assert.equal(unitInterval(hammerhand), 0.5);
  });
});