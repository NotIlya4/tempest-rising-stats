/**
 * calc.js — calculations. Pure functions, no DOM and no network; they work the same
 * in Node (tests) and in the browser (UI).
 *
 * The game's resistances are fractions of incoming damage of a type (the site stores
 * them ×100), so:
 *   DMG = Damage × (100 − Armor) / 100
 *   DPS = Damage × HitsPerAttack / AttackCooldown × (100 − Armor) / 100
 *
 * In the data the damage of one attack is already folded (damagePerVolley =
 * damage × hits per attack, see extractor/build-site-data.mjs). When the game data
 * does not give the number of hits, damagePerVolley is absent and every derived
 * number is null — never computed as if the attack hit once.
 *
 * Values are multiplayer only (the {mp: …} wrapper); a missing value is shown as
 * “—” or “?”, not replaced with a guess.
 */

export const DAMAGE_TYPES = ['Rifle', 'Rocket', 'Explosive', 'Cannon', 'Fire', 'Sniper', 'Omni'];
export const ARMOR_KEYS = ['rifle', 'rocket', 'explosive', 'cannon', 'fire', 'sniper'];

/** Damage type → armor key. Omni has no armor entry; it ignores armor. */
export const TYPE_TO_ARMOR = {
  Rifle: 'rifle',
  Rocket: 'rocket',
  Explosive: 'explosive',
  Cannon: 'cannon',
  Fire: 'fire',
  Sniper: 'sniper',
};

export const ARMOR_LABEL = {
  rifle: 'Rifle',
  rocket: 'Rocket',
  explosive: 'Explosive',
  cannon: 'Cannon',
  fire: 'Fire',
  sniper: 'Sniper',
};

// ────────────────────────────────────────────────────────────── access

/** Field value in multiplayer; undefined when the game data does not give it. */
export function pick(map) {
  return map ? map.mp : undefined;
}

/** Target armor for a damage type, 0..100. undefined if unknown. */
export function armorValue(target, damageType) {
  if (!target) return undefined;
  const key = TYPE_TO_ARMOR[damageType];
  if (!key) return undefined; // Omni
  const armor = pick(target.armor);
  if (!armor) return undefined;
  return armor[key];
}

/** Damage pass-through multiplier for armor: 1 = no armor, 0 = full immunity. */
export function armorMultiplier(target, damageType) {
  const armor = armorValue(target, damageType);
  if (armor === undefined) return 1;
  return Math.max(0, (100 - armor) / 100);
}

/** Base damage type: 'Explosive - Penetrating' → 'Explosive'. */
export function baseDamageType(weapon) {
  const full = pick(weapon?.type);
  return typeof full === 'string' ? full.split(/\s+-\s+/)[0].trim() : full;
}

/**
 * The armor key that applies to a weapon's damage. The game joins them through the damage
 * type's resistance attribute, which the data carries as armorKey (null: the damage type
 * ignores resistances, like Omni). Without armorKey the damage type name decides.
 */
export function weaponArmorKey(weapon) {
  if (weapon && Object.hasOwn(weapon, 'armorKey')) return weapon.armorKey ?? null;
  return TYPE_TO_ARMOR[baseDamageType(weapon)] ?? null;
}

/** Damage pass-through multiplier of a target's armor against a weapon. */
export function weaponArmorMultiplier(weapon, target) {
  const key = weaponArmorKey(weapon);
  const armor = key ? pick(target?.armor)?.[key] : undefined;
  if (typeof armor !== 'number') return 1;
  return Math.max(0, (100 - armor) / 100);
}

// ──────────────────────────────────────────────────────────── metrics

/**
 * Damage of one attack (all its hits) after the target's armor.
 * null when the damage of an attack is unknown (no damage or no hit count in the data).
 * @returns {{raw:number, effective:number, afterArmor:number, type:string}|null}
 */
export function hitDamage(weapon, target) {
  const raw = pick(weapon?.damagePerVolley);
  if (raw === undefined) return null;

  const type = baseDamageType(weapon);
  const afterArmor = raw * weaponArmorMultiplier(weapon, target);
  return { raw, afterArmor, effective: afterArmor, type };
}

/**
 * DPS — damage per second. Ignores ammo (this is “raw” DPS).
 * @returns {number|null}
 */
export function dps(weapon, target) {
  const hit = hitDamage(weapon, target);
  if (!hit) return null;
  const speed = pick(weapon?.speed);
  if (!speed) return null;
  return hit.effective / speed;
}

/**
 * Sustained DPS — accounting for ammo and reload.
 *
 * The magazine fields are the game's (AmmoCountMax, AmmoRechargeTime, AmmoCountPerRecharge).
 * ASSUMPTION (how the native code recharges is not in the data): with an empty magazine
 * the weapon waits AmmoRechargeTime and gains AmmoCountPerRecharge rounds until the
 * magazine is full; without AmmoCountPerRecharge a full refill takes AmmoRechargeTime.
 * Whether AmmoCountUse is spent per attack or per hit is native too; one per attack here.
 */
export function sustainedDps(weapon, target) {
  const burst = dps(weapon, target);
  if (burst === null) return null;

  const ammo = pick(weapon?.ammo);
  const speed = pick(weapon?.speed);
  if (!ammo || !speed || ammo <= 1) return burst;

  const recharge = pick(weapon?.recharge);
  if (!recharge) return burst;

  const perRecharge = recharge.perRecharge;
  const refillSeconds = perRecharge ? Math.ceil(ammo / perRecharge) * recharge.time : recharge.time;
  const fireSeconds = ammo * speed;
  // Damage per magazine = damage per volley × number of volleys in the magazine
  const perVolley = pick(weapon.damagePerVolley);
  const magazineDamage = perVolley * ammo * weaponArmorMultiplier(weapon, target);

  return magazineDamage / (fireSeconds + refillSeconds);
}

/** Time to kill the target, in seconds. */
export function timeToKill(weapon, target) {
  const value = dps(weapon, target);
  if (value === null || value <= 0) return null;
  const hp = pick(target?.stats?.hp);
  if (hp === undefined) return null;
  return hp / value;
}

/** Cost of one copy per second of production. */
export function costPerSecond(unit) {
  const cost = pick(unit?.stats?.cost);
  const time = pick(unit?.stats?.buildTime);
  if (cost === undefined || !time) return null;
  return cost / time;
}

/**
 * The main summary metric for the table: DPS across all combat slots.
 * Returns the best DPS and the sum — the sum is useful for “how much damage
 * per second this unit has in total”.
 */
export function unitWeaponStats(unit, target) {
  const armed = (unit.weapons ?? []).filter((w) => !w.utility);
  const perWeapon = armed.map((w) => ({
    weapon: w,
    name: pick(w.name) ?? `Slot ${w.slot}`,
    dps: dps(w, target),
    sustained: sustainedDps(w, target),
    ttk: timeToKill(w, target),
  }));
  const values = perWeapon.map((x) => x.dps).filter((x) => typeof x === 'number');
  return {
    perWeapon,
    best: values.length ? Math.max(...values) : null,
    total: values.length ? values.reduce((a, b) => a + b, 0) : null,
  };
}

/**
 * Damage per volley of the MAIN weapon — the same one as in the DPS column.
 *
 * Summing over weapons is wrong: in combat they almost never hit the same target
 * at once, and the player chooses where to aim each specific weapon. The sum for
 * Demolitionist gave 470 (pile driver 300 + spark thrower 170), even though against a single target it
 * deals 300. Both numbers in a table row must describe the same weapon,
 * otherwise they contradict each other.
 */
export function unitBurst(unit, target) {
  const armed = (unit?.weapons ?? []).filter((w) => !w.utility);
  const hits = armed
    .map((w) => ({
      dps: dps(w, target),
      effective: hitDamage(w, target)?.effective ?? null,
    }))
    .filter((x) => x.effective !== null);
  if (!hits.length) return null;
  // The main weapon is the one with the highest DPS. On equal DPS take the higher damage;
  // if no weapon has an interval — simply the higher damage.
  const primary = hits.reduce((a, b) => {
    const dpsDiff = (b.dps ?? -1) - (a.dps ?? -1);
    if (dpsDiff !== 0) return dpsDiff > 0 ? b : a;
    return b.effective > a.effective ? b : a;
  }, hits[0]);
  return primary.effective;
}

/**
 * Firing interval of the MAIN weapon — the same one as in the DPS
 * and “Damage/volley” columns.
 *
 * Taking the maximum over weapons, as unitAoe and unitRange do, doesn't work here: a
 * machine gun has a 0.5 s interval, a mortar 4 s, and the “maximum interval” would mean
 * “the slowest weapon”, which says nothing. So the weapon is chosen
 * exactly as in unitBurst — by highest DPS, ties broken by higher damage.
 */
export function unitInterval(unit) {
  const armed = (unit?.weapons ?? []).filter((w) => !w.utility);
  const hits = armed
    .map((w) => ({
      dps: dps(w, null),
      damage: pick(w.damagePerVolley) ?? pick(w.damage) ?? 0,
      speed: pick(w.speed),
    }))
    .filter((x) => typeof x.speed === 'number' && x.speed > 0);
  if (!hits.length) return null;
  const primary = hits.reduce((a, b) => {
    const diff = (b.dps ?? -1) - (a.dps ?? -1);
    if (diff !== 0) return diff > 0 ? b : a;
    return b.damage > a.damage ? b : a;
  }, hits[0]);
  return primary.speed;
}

/**
 * The largest blast radius among combat slots — the unit's “biggest volley”.
 * Needed for the table column where one row is a unit, while it has several
 * weapons. Utility abilities have no radius and are not counted.
 * null — no weapon with AoE.
 */
export function unitAoe(unit) {
  return unitMaxOverWeapons(unit, (w) => pick(w.aoe));
}

/**
 * The longest range among combat slots. Computed the same way as unitAoe:
 * a table row is a unit, and it has several weapons, so we show
 * the best. null — no weapons, or none has range filled in.
 */
export function unitRange(unit) {
  return unitMaxOverWeapons(unit, (w) => pick(w.range));
}

/** Shared helper: maximum of a numeric field across combat slots. */
function unitMaxOverWeapons(unit, read) {
  const values = (unit?.weapons ?? [])
    .filter((w) => !w.utility)
    .map(read)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  return values.length ? Math.max(...values) : null;
}

/** EHP — effective HP: how many times more damage must be dealt than at 0% armor. */
export function effectiveHp(unit) {
  const armor = pick(unit?.armor) ?? {};
  const values = ARMOR_KEYS.map((k) => armor[k]).filter((v) => typeof v === 'number');
  if (!values.length) return null;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return (pick(unit?.stats?.hp) ?? 0) * (1 / (1 - avg / 100));
}

// ───────────────────────────────────────────────────────── table sorting

/** Primitive for sorting: anything non-numeric (no data, 0/0, no weapon) → undefined. */
export function sortNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Comparator for arsenal rows. The key comes from the column's separate sort function:
 * a browser column can return a DOM node (a span with the armor bar), and if
 * that's passed here the result is NaN and sorting silently does nothing.
 *
 * @param {(unit: object) => number|string|undefined} key
 * @param {1|-1} dir
 */
export function rowComparator(key, dir = 1) {
  return (a, b) => {
    // null is treated as a missing value: otherwise “null” as a string
    // lands between “Tracked” and “Wheeled” and breaks sorting by movement type.
    const av = key(a) ?? undefined;
    const bv = key(b) ?? undefined;
    // Rows without a value always go to the bottom, in either direction: otherwise they “jump”.
    if (av === undefined) return bv === undefined ? 0 : 1;
    if (bv === undefined) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv), 'ru', { numeric: true }) * dir;
  };
}

/** Sorts a copy of the array by column. Whether it mutates the original doesn't matter. */
export function sortRows(rows, key, dir = 1) {
  return [...rows].sort(rowComparator(key, dir));
}
