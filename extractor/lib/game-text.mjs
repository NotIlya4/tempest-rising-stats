/**
 * game-text.mjs — pure helpers shared by extractor/build-site-data.mjs and its tests.
 * No file access here, so they can be unit-tested without the game files.
 */

/**
 * Fills the `{Name}` placeholders of a game FText format string with the argument values
 * stored next to it in the same asset (`Description.Arguments`). A placeholder without a
 * value becomes "?" and is reported: the number lives in code or in another asset, and
 * the site must not invent one.
 *
 * @param {string|null} format   the localized format string
 * @param {Record<string, string>} values  argument name → already localized value
 * @returns {{ text: string|null, unresolved: string[] }}
 */
export function fillPlaceholders(format, values = {}) {
  if (format == null) return { text: null, unresolved: [] };
  const unresolved = [];
  const text = format.replace(/\{(\w+)\}/g, (whole, name) => {
    if (Object.hasOwn(values, name) && values[name] != null) return String(values[name]);
    if (!unresolved.includes(name)) unresolved.push(name);
    return '?';
  });
  return { text, unresolved };
}

/** Game text cleanup: CR/LF pairs from the string tables, trailing spaces in names. */
export function cleanText(s) {
  if (s == null) return null;
  const out = String(s).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return out || null;
}

/**
 * Gameplay-tag match as the game's definition filters use it: exact, or (bExactMatch
 * false) the tag itself or any child tag (`Definition.GDF.Unit` matches
 * `Definition.GDF.Unit.Humvee`).
 */
export function tagMatches(id, tag, exact) {
  if (!id || !tag) return false;
  if (id === tag) return true;
  return !exact && id.startsWith(tag + '.');
}

/**
 * Resistance attribute → the site's armor key. The same names are the resistance fields of
 * a unit definition and the `RelevantResistAttribute` of a damage type, which is how the
 * game joins a weapon's damage to the target's armor.
 */
export const RESIST_TO_ARMOR = {
  GunResistance: 'rifle',
  RocketResistance: 'rocket',
  ExplosiveResistance: 'explosive',
  CannonResistance: 'cannon',
  FireResistance: 'fire',
  SniperResistance: 'sniper',
};

/**
 * The broad class of an entity from its `PawnType.*` owned tag (the game's own pawn type).
 * Returns null when the definition has no pawn type tag.
 */
export function unitClassFromTags(tags = []) {
  // A definition can carry several pawn type tags (PawnType.Unit.Infantry plus
  // PawnType.Unit.Support): the most specific kind wins, whatever the tag order.
  const has = (prefix) => tags.some((t) => t === prefix || t.startsWith(prefix + '.'));
  if (has('PawnType.Unit.Infantry')) return 'infantry';
  if (has('PawnType.Unit.Vehicle.Air')) return 'aircraft';
  if (has('PawnType.Unit.Vehicle')) return 'vehicle';
  if (has('PawnType.Structure.Superweapon')) return 'superweapon';
  if (has('PawnType.Structure')) return 'structure';
  if (has('PawnType.Destructible')) return 'destructible';
  return null;
}
