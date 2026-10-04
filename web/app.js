/**
 * app.js — UI. All the math lives in lib/calc.js; this file only renders.
 * A plain script, not a module: ES modules don't load over file:// (CORS).
 * Data comes from data.js (window.TR_DATA), calculations from lib/calc.global.js.
 */

const {
  pick, dps, timeToKill, hitDamage, unitWeaponStats, unitBurst, unitAoe, unitRange, unitInterval,
  baseDamageType, weaponArmorKey, ARMOR_KEYS, ARMOR_LABEL,
  sortNumber, sortRows,
} = globalThis.TRCalc;

const { t, lang: LANG, locale: LOCALE, RU: I18N_RU } = globalThis.TRI18n;

/**
 * A UI term that comes from the data as an English code word (faction, base
 * damage type, unit class, target domain), translated when the dictionary knows
 * it and shown as is otherwise. Only for display: sorting and math keep working
 * on raw values. The Russian wording is taken from the game's own localization.
 * Names and texts the game localizes itself (units, weapons, effects…) carry
 * their Russian in the data and do not go through the dictionary.
 */
const term = (value) => (value && Object.hasOwn(I18N_RU, value) ? t(value) : value);
const termList = (values) => (values ?? []).map(term).join(', ');

const DATA = window.TR_DATA;
if (!DATA) {
  document.body.innerHTML = '<div class="empty">' + globalThis.TRI18n.t('web/data.js not found — run npm run build') + '</div>';
  throw new Error('TR_DATA missing');
}

const UNITS = DATA.units;
/** Passive abilities (effects, auras, armor classes) and doctrines, keyed by asset name. */
const EFFECTS = DATA.effects ?? {};
const DOCTRINES = DATA.doctrines ?? {};
const UNIT_BY_ID = new Map(UNITS.map((u) => [u.id, u]));

/** The game's own Russian text in RU mode, English otherwise (or when the game has no Russian). */
const loc = (en, ru) => (LANG === 'ru' && ru) || en;
/** A {en, ru} text from the data. */
const locText = (text) => (text ? loc(text.en, text.ru) : null);

/** Display name: the game's Russian name in RU mode, the English one otherwise. */
const displayName = (unit) => loc(unit.name, unit.nameRu);
/** Show the English name as a second line only if it differs. */
const hasEnglishAside = (unit) => LANG === 'ru' && displayName(unit) !== unit.name;

/** Weapon name and full damage type ("Explosive - Penetrating") in the current language. */
const weaponName = (w) => loc(vKey(w.name), w.nameRu);
const weaponType = (w) => loc(vKey(w.type), w.typeRu);
/** Armor class shown in the table: the game's entity-type passive (Light Vehicle…), else the unit class. */
const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const classLabel = (u) => loc(u.armorType, u.armorTypeRu) ?? capitalize(term(u.unitClass));

/**
 * Why a value is missing: the generator records the reason for every null
 * (data/build-report.json). The page shows "—" or "?" with this as the tooltip.
 */
const missingTip = (reason) => t('Not in the game data.') + (reason ? '\n' + reason : '');
/**
 * A value that does not apply to this entity (the cost of a mine nobody builds, the speed of a
 * structure): also "—", but not unknown. The generator records why (unit.notApplicable).
 */
const naTip = (reason) => t('Does not apply.') + (reason ? '\n' + reason : '');
/** Tooltip for an absent unit stat: not applicable or not in the data. */
const absentTip = (u, field) => (u.notApplicable?.[field] ? naTip(u.notApplicable[field]) : missingTip(u.missing?.[field]));

/** Name cell: the Russian name as the main one, the English name small beneath it. */
function nameCell(unit) {
  const box = el('span', { className: 'name-cell' },
    el('span', { className: 'name-ru', textContent: displayName(unit) }));
  if (hasEnglishAside(unit)) {
    box.append(el('span', { className: 'name-en', textContent: unit.name }));
  }
  return box;
}

/** “<Russian name> (Porcupine MLRS)” — for headings and dropdowns. */
const nameInline = (unit) => (hasEnglishAside(unit) ? `${displayName(unit)} (${unit.name})` : displayName(unit));
const state = {
  showExtra: false,     // economy columns: credits, build time, pop. Hidden because
                        // when comparing units damage matters more, and economy is needed far less often.
  target: null,         // target for the arsenal DPS column; null = “compute against 0% armor”
  // The compare screen has its own target: there it is required, otherwise half
  // the rows can't be computed. Sharing one target with the arsenal made them drift apart.
  compareTarget: null,
  // Compare: how many units are compared and how their weapons were chosen.
  compare: defaultCompare(),
  sort: { key: 'name', dir: 1 },
  filters: { q: '', faction: '', classes: [], hideSecondary: true, effects: [] },
};

/**
 * The starting comparison: Havoc and Porcupine MLRS, both Dynasty rocket vehicles, by their
 * game identifiers; the first two armed units if a patch renames them.
 */
function defaultCompare() {
  const armed = (u) => (u.weapons ?? []).some((w) => !w.utility);
  const ids = ['DYN.Unit.RocketBuggy', 'DYN.Unit.PorcupineMissileLauncher'].filter((id) => UNITS.some((u) => u.id === id));
  for (const u of UNITS) if (ids.length < 2 && armed(u) && !ids.includes(u.id)) ids.push(u.id);
  return ids.map((unitId) => ({ unitId, slot: null }));
}

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  // dataset is a read-only property and Object.assign silently ignores it, so
  // data-* attributes are set by hand: el('tr', { data: { id: 'DYN.Unit.Havoc' } }).
  const { data, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (data) Object.assign(node.dataset, data);
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
};
const fmt = (value, digits = 1) =>
  value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits);
const signed = (value) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};
const vKey = (map) => (map && typeof map === 'object' ? map.mp : undefined);

// ───────────────────────────────────────────────────────────────────── search

/**
 * Russian search words for English terms. Names and texts are already in the index in
 * both languages (the game's own localization); these stems map Russian words to the
 * English terms a name or a damage type uses, so every inflected form of a word
 * (pushku, pushki, pushka — “cannon”) finds the same thing.
 */
const RU_SYNONYMS = {
  'пехот': 'infantry',
  'техник': 'vehicle',
  'машин': 'vehicle',
  'танк': 'tank',
  'авиац': 'aircraft',
  'самолёт': 'aircraft',
  'самолет': 'aircraft',
  'дрон': 'drone',
  'строител': 'structure',
  'постройк': 'structure',
  'оружи': 'weapon',
  'пушк': 'cannon',
  'пушечн': 'cannon',
  'ракет': 'rocket',
  'взрыв': 'explosive',
  'фугас': 'explosive',
  'огнемёт': 'fire',
  'огнемет': 'fire',
  'снайпер': 'sniper',
  'снайп': 'sniper',
  'зенитн': 'anti-air',
  'зенит': 'anti-air',
  'миномет': 'mortar',
  'артиллер': 'artillery',
  'башн': 'turret',
  'турел': 'turret',
  'доклад': 'factory',
  'завод': 'factory',
  'шахт': 'mine',
  'карьер': 'mine',
  'генератор': 'power',
  'энерг': 'power',
  'ремонт': 'repair',
  'медик': 'medic',
  'развед': 'scout',
  'камуфл': 'camouflage',
  'невидим': 'stealth',
  'династ': 'dynasty',
  'вети': 'veti',
};

/** Expands a query into a set of terms: the original plus English synonyms. */
function searchTerms(needle) {
  const terms = [needle];
  for (const [ru, en] of Object.entries(RU_SYNONYMS)) {
    if (needle.includes(ru)) terms.push(en);
  }
  return terms;
}

const asList = (value) => (Array.isArray(value) ? value : value ? [value] : []);

/** Every name of an effect key in both languages, for the search index. */
const effectWords = (key, table = EFFECTS) => [table[key]?.name?.en, table[key]?.name?.ru];

/** Text of a single weapon: names, damage type, targets, effects — in both languages. */
function weaponText(w) {
  return [
    vKey(w.name), w.nameRu, baseDamageType(w), vKey(w.type), w.typeRu,
    ...(w.effects ?? []).flatMap((k) => effectWords(k)),
    ...asList(vKey(w.targets)),
  ].filter(Boolean).join(' ').toLowerCase();
}

/**
 * Everything we search by, in one string: the name in English and Russian, the game
 * identifier, faction, class, effects and auras, doctrines, abilities, and the weapons.
 * Unit descriptions are not published, so they are not searchable either.
 *
 * Indexes are built once at load time, not on every keystroke.
 */
function unitSearchText(unit) {
  return [
    unit.name, unit.nameRu, unit.id, unit.faction, term(unit.faction),
    unit.armorType, unit.armorTypeRu, unit.unitClass, term(unit.unitClass),
    // Auras and doctrines make “who has a repair zone” searchable.
    ...(unit.unitEffects ?? []).flatMap((e) => effectWords(e.base)),
    ...(unit.doctrines ?? []).flatMap((k) => effectWords(k, DOCTRINES)),
    ...(unit.abilitiesDetails ?? []).flatMap((a) => [a.name, a.nameRu]),
    unit.isSuperweapon ? 'superweapon ' + t('Superweapons') : null,
    ...(unit.weapons ?? []).map(weaponText),
    // Lowercase the whole thing: names come capitalized, the query is always lowercase.
  ].filter(Boolean).join(' ').toLowerCase();
}

const UNIT_INDEX = new Map(UNITS.map((u) => [u.id, unitSearchText(u)]));

const matches = (unit, terms) => {
  const hay = UNIT_INDEX.get(unit.id) ?? '';
  return terms.some((t) => hay.includes(t));
};

// ──────────────────────────────────────────────────── unit search (combobox)

/**
 * A field with suggestions instead of a select with every unit. Searches the same index
 * as the main search, so English and Russian names, weapons and effects all work.
 *
 * @param {{mount: Element, value?: string, onChange: (id: string) => void,
 *          emptyLabel?: string, filter?: (u: object) => boolean}} config
 */
function unitPicker({ mount, value = '', onChange, emptyLabel = t('No target — 0% armor'), filter }) {
  const input = el('input', {
    className: 'picker-input',
    type: 'text',
    autocomplete: 'off',
    spellcheck: false,
    placeholder: t('Start typing a name…'),
  });
  const clear = el('button', { className: 'picker-clear', type: 'button', title: t('Clear'), textContent: '×' });
  const pop = el('div', { className: 'picker-pop' });
  pop.hidden = true;
  const wrap = el('div', { className: 'picker' }, input, clear, pop);
  mount.replaceChildren(wrap);

  let current = value;
  let highlighted = -1;

  const label = (u) => (hasEnglishAside(u) ? `${displayName(u)} · ${u.name}` : displayName(u));

  const show = () => {
    input.value = current ? label(UNITS.find((u) => u.id === current) ?? { name: current }) : '';
    clear.hidden = !current;
  };

  const draw = (query) => {
    const terms = query.trim() ? searchTerms(query.trim().toLowerCase()) : null;
    const found = UNITS.filter((u) => (!filter || filter(u)) && (!terms || matches(u, terms)));
    // With no query show only the first few; a list of every unit would be pointless.
    const list = (terms ? found : found.slice(0, 12)).slice(0, 60);
    pop.replaceChildren();
    if (!list.length) {
      pop.append(el('div', { className: 'picker-empty', textContent: t('Nothing found') }));
    }
    for (const u of list) {
      pop.append(el('div', {
        className: 'picker-item',
        data: { id: u.id },
        onclick: () => pick(u.id),
      },
        el('span', { className: 'p-name', textContent: displayName(u) }),
        hasEnglishAside(u) ? el('span', { className: 'p-en', textContent: u.name }) : null,
        el('span', { className: 'p-tag', textContent: [term(u.faction), classLabel(u)].filter(Boolean).join(' · ') })));
    }
    highlighted = -1;
  };

  const open = () => { draw(input.value === label(UNITS.find((u) => u.id === current) ?? { name: '' }) ? '' : input.value); pop.hidden = false; };
  const close = () => { pop.hidden = true; };

  const pick = (id) => {
    current = id;
    show();
    close();
    onChange(id);
  };

  input.addEventListener('focus', () => { input.select(); open(); });
  input.addEventListener('input', () => { draw(input.value); pop.hidden = false; });
  input.addEventListener('keydown', (event) => {
    const items = [...pop.querySelectorAll('.picker-item')];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (pop.hidden) { open(); return; }
      highlighted = event.key === 'ArrowDown'
        ? Math.min(highlighted + 1, items.length - 1)
        : Math.max(highlighted - 1, 0);
      items.forEach((n, i) => n.classList.toggle('on', i === highlighted));
      items[highlighted]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const node = items[highlighted] ?? items[0];
      // Nothing matched — restore the current selection, not the typed garbage.
      if (node) pick(node.dataset.id);
      else show();
    } else if (event.key === 'Escape') {
      close();
      show();
    }
  });
  input.addEventListener('blur', () => { setTimeout(close, 120); });
  clear.addEventListener('click', () => { pick(''); input.focus(); });

  show();
  return {
    element: wrap,
    get value() { return current; },
    set value(id) { current = id; show(); },
  };
}

// ─────────────────────────────────────────────────────────────── images

/**
 * Every picture comes from the game files: the Icon texture of each unit, effect, doctrine
 * and ability, copied into web/icons/ by extractor/build-site-data.mjs and named in the
 * data. There is no other source: an entity without a game icon gets a lettered placeholder.
 */
const ICON_DIR = 'icons/';
const iconSrc = (file) => (file ? ICON_DIR + file : null);

/** Small icon <img>; removed if the file fails to load. */
function iconImg(file, attrs = {}) {
  const img = el('img', { src: iconSrc(file), alt: '', loading: 'lazy', ...attrs });
  img.addEventListener('error', () => img.remove(), { once: true });
  return img;
}

/**
 * Armor cell: percentage and bar on one line, same markup for all
 * tables. The unit card used to have a <div> with the value and the bar under it,
 * so the cell took two lines — it didn't look like the other tables.
 */
function armorCell(value) {
  if (value === undefined) return '—';
  const node = el('span', { title: t('{v}% armor', { v: value }) });
  node.append(String(value), el('span', { className: 'armor-bar' }, el('i', { style: `width:${value}%` })));
  return node;
}

/**
 * Effect chips. An effect is a passive ability: what a weapon applies to its target
 * (Marking, Tempest Charge), or what a unit keeps around itself (an aura, a repair
 * zone). Doctrines use the same chip. Name, description and icon are the game's own;
 * the description (with its numbers filled from the same asset) is the tooltip.
 */
function effectChip(key, table = EFFECTS) {
  const info = table[key];
  if (!info) return null;
  const name = locText(info.name);
  const tip = [name, locText(info.desc)].filter(Boolean).join('\n');
  return el('span', { className: info.icon ? 'eff-chip' : 'eff-chip no-icon', title: tip, data: { key } },
    info.icon ? iconImg(info.icon) : null,
    el('span', { textContent: name }));
}

/**
 * List of chips, each ON ITS OWN LINE.
 *
 * Stacked, not inline: a weapon can have three effects, and inline they
 * stretched the name column so the table slid sideways. Stacked, the width is
 * one label and the height is exactly as many lines as there are values.
 * null when there are no values: an empty node would take up space in the header.
 */
function effectList(keys, table = EFFECTS) {
  const list = (keys ?? []).filter((k) => table[k]);
  if (!list.length) return null;
  return el('span', { className: 'eff-list' }, ...list.map((k) => effectChip(k, table)));
}

/** Weapon targets stacked: “ground” and “air” one under the other. */
function targetList(w) {
  const label = { ground: t('ground'), air: t('air') };
  const list = (vKey(w.targets) ?? []).map((x) => label[String(x).toLowerCase()]).filter(Boolean);
  if (!list.length) {
    return w.missing?.targets ? el('span', { className: 'unknown', title: missingTip(w.missing.targets), textContent: '—' }) : null;
  }
  return el('span', { className: 'tgt-list' }, ...list.map((target) => el('span', {
    className: 'tgt-chip', title: t('Can attack: {t}', { t: target }),
  }, target)));
}

/** The English name of an effect key: effects with the same name are one entry in the filter. */
const effectName = (key) => EFFECTS[key]?.name?.en ?? null;

/**
 * All of a unit's effects, by English name: its own auras plus the effects its
 * weapons apply. Deduplicated in order — the same effect on the unit and on its
 * gun is shown once.
 */
function unitEffectNames(unit) {
  const out = [];
  const add = (key) => { const n = effectName(key); if (n && !out.includes(n)) out.push(n); };
  for (const e of unit.unitEffects ?? []) add(e.base);
  for (const w of unit.weapons ?? []) {
    if (w.utility) continue;
    for (const k of w.effects ?? []) add(k);
  }
  return out;
}

/** Placeholder for entities without a game icon, or when the file fails to load. */
function picPlaceholder(unit, size) {
  const letter = (displayName(unit) ?? '?').replace(/[^A-Za-zА-Яа-я0-9]/g, '').charAt(0); // i18n-ok: Cyrillic letters for the initial
  return el('div', {
    className: `pic pic-empty pic-${size}`,
    textContent: letter,
    title: t('The game has no icon for “{name}”', { name: displayName(unit) }),
    style: unit.faction ? `color: var(--${unit.faction.toLowerCase()})` : '',
  });
}

/** The unit's game icon at the given size, or the lettered placeholder. */
function picture(unit, size = 36) {
  if (!unit.icon) return picPlaceholder(unit, size);
  const img = el('img', {
    className: `pic pic-${size}`, src: iconSrc(unit.icon), alt: displayName(unit), loading: 'lazy',
  });
  img.addEventListener('error', () => img.replaceWith(picPlaceholder(unit, size)), { once: true });
  return img;
}

/** The unit's icon for the table; the unit card shows the same icon large. */
function cellPicture(unit) {
  const box = el('span', { className: 'pic-box' });
  box.append(picture(unit, 36));
  return box;
}

// ────────────────────────────────────────────────────────── toggle

/**
 * “More info” toggle. The column set depends on state.showExtra, so
 * after toggling, the table and headers must be fully re-rendered.
 */
function initExtraToggle() {
  const btn = $('#toggleExtra');
  const sync = () => {
    btn.classList.toggle('on', state.showExtra);
    btn.setAttribute('aria-expanded', String(state.showExtra));
    btn.textContent = state.showExtra ? t('more info ▴') : t('more info ▾');
  };
  sync();
  btn.addEventListener('click', () => {
    state.showExtra = !state.showExtra;
    sync();
    renderArsenal();
  });
}


// ───────────────────────────────────────────────────────────────── table

// Each column's sort must return a PRIMITIVE (number or string), not a DOM node:
// a node in arithmetic gives NaN and sorting silently stops working. get is only
// for displaying the cell; it takes no part in sorting.
// The column set is built by a FUNCTION, not once at load time: some columns
  // are shown only under the “more info” toggle (state.showExtra). A constant
  // would be computed once, and the toggle would change the picture but not the columns.
  //
  // The column header does NOT mention the selected target: “DPS vs 0% armor” takes
  // as much room as the DPS itself, and the table spread out. What was computed
  // is written in the header tooltip — same place as for the other columns.
  // Colored columns: damage and DPS red, HP green. The value is wrapped in a
// span with a class because color is set on the cell, not the number: otherwise we'd
// need a separate branch in the display code of every cell.
const cellClass = (cls, text) => el('span', { className: cls, textContent: text });
// Cell class: 'num' for numbers plus the column's optional cellClass — used
// to mark damage and DPS red, HP green.
const cellClassOf = (col) => `${col.num ? 'num' : ''} ${col.cellClass ?? ''}`.trim();
const targetWord = () => (state.target ? t('vs “{name}”', { name: displayName(state.target) }) : t('vs 0% armor'));
/** A unit stat cell: the number, or "—" with the reason the game data does not give it. */
function statCell(u, field) {
  const v = vKey(u.stats[field]);
  if (v !== undefined) return signed(v);
  return el('span', { className: u.notApplicable?.[field] ? 'na' : 'unknown', title: absentTip(u, field), textContent: '—' });
}
/**
 * Credits of a GDF building are two payments: the foundation (paid when the
 * construction site is placed) and the main cost (drained while it builds).
 * Shown as “600 + 100”; sorted and compared by the total.
 */
const foundationOf = (u) => vKey(u.stats.foundationCost) ?? 0;
const creditsTotal = (u) => {
  const cost = vKey(u.stats.cost);
  return cost === undefined ? undefined : cost + foundationOf(u);
};
const creditsText = (u) => {
  const cost = vKey(u.stats.cost);
  const foundation = foundationOf(u);
  return foundation ? `${signed(cost ?? 0)} + ${signed(foundation)}` : signed(cost);
};
const creditsTip = (u) => (foundationOf(u)
  ? t('{cost} is drained while it builds, {foundation} is the foundation, paid when the site is placed', { cost: signed(vKey(u.stats.cost) ?? 0), foundation: signed(foundationOf(u)) })
  : '');
function creditsCell(u) {
  if (vKey(u.stats.cost) === undefined && !foundationOf(u)) return statCell(u, 'cost');
  return el('span', { title: creditsTip(u), textContent: creditsText(u) });
}

/** Intel cost cell: the number, or "—" when the entity costs credits only (IntelCost 0). */
function intelCell(u) {
  const v = vKey(u.stats.intelCost);
  if (v === 0) return el('span', { className: 'na', title: t('No Intel cost: paid in credits only'), textContent: '—' });
  return statCell(u, 'intelCost');
}
/** The tier column only exists when the data has tiers (the game files define none today). */
const HAS_TIER = UNITS.some((u) => u.tier != null);
  function unitColumns() {
    return [
  { key: 'pic', label: '', get: (u) => cellPicture(u), sort: () => 0 },
  { key: 'name', label: t('Name'), get: (u) => nameCell(u), sort: (u) => displayName(u).toLowerCase() },
  { key: 'faction', label: t('Faction'), get: (u) => el('span', { className: `f-${u.faction}`, textContent: term(u.faction) }), sort: (u) => u.faction },
  ...(HAS_TIER ? [{ key: 'tier', label: t('Tier'), num: true, get: (u) => (u.tier ? el('span', { className: `badge t${u.tier}`, textContent: u.tier }) : '—'), sort: (u) => sortNumber(u.tier) }] : []),
  { key: 'armorType', label: t('Class'), get: (u) => classLabel(u) ?? '—', sort: (u) => classLabel(u) ?? undefined },
  // Movement speed (MovementSpeed) — not to be confused with weapon.speed, which in the
  // data is the interval between attacks (AttackCooldown).
  { key: 'moveSpeed', label: t('Speed'), num: true, get: (u) => statCell(u, 'speed'), sort: (u) => sortNumber(vKey(u.stats.speed)) },
  { key: 'hp', label: 'HP', num: true, cellClass: 'hp-cell', get: (u) => statCell(u, 'hp'), sort: (u) => sortNumber(vKey(u.stats.hp)) },
  // Economy is hidden behind the toggle: when comparing units it gets in the way — what matters
  // is damage, while price and build time are needed far less often. One click brings it back.
  ...(state.showExtra ? [
    { key: 'cost', label: t('Credits'), num: true, get: (u) => creditsCell(u), sort: (u) => sortNumber(creditsTotal(u)) },
    // Intel: the second resource GDF pays with (IntelCost); "—" for credits-only entities.
    { key: 'intel', label: t('Intel'), num: true, get: (u) => intelCell(u), sort: (u) => sortNumber(vKey(u.stats.intelCost)) },
    { key: 'time', label: t('Build, s'), num: true, get: (u) => statCell(u, 'buildTime'), sort: (u) => sortNumber(vKey(u.stats.buildTime)) },
    { key: 'pop', label: t('Pop'), num: true, get: (u) => statCell(u, 'population'), sort: (u) => sortNumber(vKey(u.stats.population)) },
  ] : []),
  // DPS and “Damage/volley” are computed against the selected target, i.e. AFTER armor.
  // With no target they're computed against 0% armor. The difference between 45 and 22.5 for Pillager is
  // exactly the half armor against fire. The applied-target marker sits right in the
  // header: from the table alone you couldn't tell whether the numbers were reduced by armor.
  {
    key: 'dps',
    label: 'DPS',
    num: true,
    cellClass: 'dmg-cell',
    title: () => t('Damage per second {target}. Values are per weapon in the rows below; this column sorts by the unit’s best weapon.', { target: targetWord() }),
    headLabel: () => 'DPS',
    get: () => '',
    sort: (u) => sortNumber(unitWeaponStats(u, state.target).best),
  },
  {
    key: 'burst',
    label: t('Dmg/volley'),
    num: true,
    cellClass: 'dmg-cell',
    title: () => t('Damage of a full volley {target}. Values are per weapon in the rows below; this column sorts by the highest-DPS weapon.', { target: targetWord() }),
    headLabel: () => t('Dmg/volley'),
    get: () => '',
    sort: (u) => sortNumber(unitBurst(u, state.target)),
  },
  // The largest blast radius and the longest-range gun among the weapons: in weapon
  // mode each weapon's values are shown separately, here — a summary.
  // AoE, Range and Interval are properties of the WEAPON, not the unit, so in the unit
// row they're empty: the values are already in the sub-rows under each weapon.
// The columns stay because people sort by them: sort still folds
// all of the unit's weapons — AoE and Range take the maximum, Interval the weapon with
// the highest DPS, the same one as in the DPS column.
//
// This used to call unitAoe() and unitRange() WITHOUT the unit, and the functions returned
// null: the columns were empty in every row, and sorting by them did
// nothing. Now the unit is passed in, and sorting actually works.
{ key: 'aoe', label: 'AoE', num: true, title: () => t('Maximum across the unit’s weapons. Per-weapon values are in the rows below.'), get: () => '', sort: (u) => sortNumber(unitAoe(u)) },
{ key: 'range', label: t('Range'), num: true, title: () => t('Maximum across the unit’s weapons. Per-weapon values are in the rows below.'), get: () => '', sort: (u) => sortNumber(unitRange(u)) },
  // Firing interval of the main weapon: a unit has several, and in
  // the rows we show the same one as in DPS, otherwise the column would describe a different weapon.
  {
    key: 'interval',
    label: t('Interval, s'),
    num: true,
    title: () => t('Interval of the highest-DPS weapon — the same one shown in the DPS column. Per-weapon values are below.'),
    get: () => '',
    sort: (u) => sortNumber(unitInterval(u)),
  },
  // Effects and targets are weapon-data columns. In the unit row we show
  // its own auras and otherwise leave them empty: everything about a specific weapon
  // lives in the sub-rows under it, just like the damage numbers.
  {
    key: 'effects',
    label: t('Effects'),
    get: (u) => el('span', {}, effectList((u.unitEffects ?? []).map((e) => e.base))),
    sort: (u) => (u.unitEffects ?? []).length,
  },
  { key: 'targets', label: t('Targets'), get: () => '', sort: () => 0 },
  ...ARMOR_KEYS.map((key) => ({
    key: `armor_${key}`,
    label: term(ARMOR_LABEL[key]),
    num: true,
    get: (u) => armorCell(vKey(u.armor)?.[key]),
    sort: (u) => sortNumber(vKey(u.armor)?.[key]),
  })),
  ];
}

/** Arsenal target picker: keep a reference so it can be reset on sync. */
let arsenalTargetPicker = null;

/**
 * Brings the controls back in line with state.filters.
 *
 * The browser restores form field values on reload and when returning to
 * the tab WITHOUT firing change. Because of this the “Infantry” checkbox is lit while the filter
 * isn't applied: the page shows one thing and computes another. So the source
 * of truth is state, and the DOM is brought in line with it, not the other way round.
 */
function syncFilterControls({ rerender = true } = {}) {
  const box = (sel, value) => { const n = $(sel); if (n) n.value = value; };
  box('#q', state.filters.q);
  box('#fFaction', state.filters.faction);
  syncEffectFilter();
  if ($('#hideSecondary')) $('#hideSecondary').checked = state.filters.hideSecondary;
  for (const input of document.querySelectorAll('#fClass input')) {
    input.checked = state.filters.classes.includes(input.value);
  }
  if (arsenalTargetPicker) arsenalTargetPicker.value = state.target?.id ?? '';
  // Fields now match the state — the table must match it too, otherwise it
  // would remain rendered from something else.
  if (rerender) renderArsenal();
}

/** Brings the effect dropdown in line with state.filters; set by initEffectFilter. */
let syncEffectFilter = () => {};

/** Reset all arsenal filters. The target stays as it was. */
function resetFilters() {
  state.filters = { q: '', faction: '', classes: [], hideSecondary: true, effects: [] };
  syncEffectFilter();
  syncFilterControls();
  renderArsenal();
}

// ───────────────────────────────────────────────────────── effect filter

/**
 * All effects found in the database, by English name, with unit counts and a
 * representative key (for the localized name and the icon). Counted per unit, not
 * per weapon: Tempest Artillery has two weapons with Tempest Charge, and in the list it
 * must appear once.
 */
function effectIndex() {
  const counts = new Map();
  const keyOf = new Map();
  for (const u of UNITS) {
    for (const name of unitEffectNames(u)) counts.set(name, (counts.get(name) ?? 0) + 1);
    const keys = [...(u.unitEffects ?? []).map((e) => e.base), ...(u.weapons ?? []).filter((w) => !w.utility).flatMap((w) => w.effects ?? [])];
    for (const k of keys) if (effectName(k) && !keyOf.has(effectName(k))) keyOf.set(effectName(k), k);
  }
  const label = (name) => locText(EFFECTS[keyOf.get(name)]?.name) ?? name;
  return [...counts]
    .map(([name, count]) => ({ name, count, key: keyOf.get(name), label: label(name) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, LANG));
}

function initEffectFilter() {
  const box = $('#fEffect');
  const pop = $('#fEffectWrap');
  const search = $('#fEffectSearch');
  const btn = $('#toggleEffectFilter');
  const list = effectIndex();
  const byName = new Map(list.map((e) => [e.name, e]));

  const apply = () => {
    btn.textContent = state.filters.effects.length
      ? t('Effects: {n}', { n: state.filters.effects.length })
      : t('Effects');
    renderEffectChips();
    renderArsenal();
  };
  const toggle = (name, on) => {
    const set = new Set(state.filters.effects);
    if (on) set.add(name); else set.delete(name);
    // Keep the dropdown's order (most common first), not the click order.
    state.filters.effects = list.map((e) => e.name).filter((n) => set.has(n));
    for (const input of box.querySelectorAll('input')) input.checked = set.has(input.value);
    apply();
  };

  const draw = (needle = '') => {
    const q = needle.trim().toLowerCase();
    // Search both the shown (localized) name and the English one.
    const shown = list.filter((e) => !q || e.label.toLowerCase().includes(q) || e.name.toLowerCase().includes(q));
    box.replaceChildren(...shown.map((e) => {
      const input = el('input', { type: 'checkbox', value: e.name });
      input.checked = state.filters.effects.includes(e.name);
      input.addEventListener('change', () => toggle(e.name, input.checked));
      const icon = EFFECTS[e.key]?.icon;
      return el('label', { className: 'dropdown-item', title: t('{n} units', { n: e.count }) },
        input,
        icon ? iconImg(icon) : null,
        el('span', { textContent: e.label }),
        el('span', { className: 'count', textContent: String(e.count) }));
    }));
    if (!shown.length) box.replaceChildren(el('div', { className: 'dropdown-empty', textContent: t('Nothing found.') }));
  };

  /** Selected effects as chips next to the dropdown, each with its own ×. */
  function renderEffectChips() {
    $('#fEffectChips').replaceChildren(...state.filters.effects.map((name) => {
      const e = byName.get(name);
      const icon = EFFECTS[e?.key]?.icon;
      return el('span', { className: 'chip removable' },
        icon ? iconImg(icon) : null,
        el('span', { textContent: e?.label ?? name }),
        el('button', { type: 'button', title: t('Remove'), textContent: '×', onclick: () => toggle(name, false) }));
    }));
  }

  const open = (on) => {
    pop.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
    if (on) { search.value = ''; draw(); search.focus(); }
  };
  btn.addEventListener('click', () => open(pop.hidden));
  search.addEventListener('input', () => draw(search.value));
  // Close on a click outside and on Escape, like a native select.
  document.addEventListener('click', (event) => {
    if (!pop.hidden && !event.target.closest('#effectDropdown')) open(false);
  });
  pop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { open(false); btn.focus(); }
  });

  // resetFilters() and syncFilterControls() rewrite state.filters; they call this
  // to bring the button, the list and the chips back in line with it.
  syncEffectFilter = () => {
    for (const input of box.querySelectorAll('input')) input.checked = state.filters.effects.includes(input.value);
    btn.textContent = state.filters.effects.length ? t('Effects: {n}', { n: state.filters.effects.length }) : t('Effects');
    renderEffectChips();
  };
  draw();
  syncEffectFilter();
}

/**
 * Effect list for the card: the game's description of each effect is shown next to
 * its name rather than hidden in a tooltip. The point of the block is to understand
 * what the unit does without hovering over every chip.
 */
/**
 * One tile of the unit card: icon and title on top, the description under it,
 * an optional muted line (cost, cooldown) at the bottom. Tiles sit in a grid
 * that uses the card's width instead of one long column of text.
 */
function infoTile({ icon, title, text, meta }) {
  let iconNode;
  if (icon) {
    iconNode = el('img', { className: 'tile-icon', src: iconSrc(icon), alt: '', loading: 'lazy' });
    iconNode.addEventListener('error', () => iconNode.replaceWith(el('div', {
      className: 'tile-icon no-pic', textContent: '◆', title: t('Icon failed to load'),
    })), { once: true });
  } else {
    iconNode = el('div', { className: 'tile-icon no-pic', textContent: '◆' });
  }
  return el('div', { className: 'tile' },
    el('div', { className: 'tile-head' }, iconNode, el('div', { className: 'tile-title', textContent: title })),
    text ? el('div', { className: 'tile-text', textContent: text }) : null,
    meta ? el('div', { className: 'tile-meta', textContent: meta }) : null);
}

/**
 * What a command costs, in the game's resource names: “Credits 1500”, “Intel 5”.
 * A cost the game computes at runtime is shown as variable, not as a number.
 */
const RESOURCE_LABEL = {
  credits: () => t('Credits'),
  intel: () => t('Intel'),
  power: () => t('Power'),
  population: () => t('Population'),
  enlightened: () => t('Enlightened'),
};
function abilityCosts(ability) {
  return Object.entries(ability.costs ?? {}).map(([resource, v]) => `${RESOURCE_LABEL[resource]?.() ?? resource} ${v === 'variable' ? t('variable') : signed(v)}`);
}

const WIKI_SEARCH = 'https://tempestrising.wiki.gg/index.php?search=';

/** A titled group of tiles in the card: “Unit auras”, “Abilities”… */
function tileGroup(label, tiles) {
  const list = tiles.filter(Boolean);
  if (!list.length) return null;
  return el('section', { className: 'tile-group' },
    label ? el('h4', { textContent: label }) : null,
    el('div', { className: 'tile-grid' }, ...list));
}

/** Effect or doctrine tiles for the card, from the game's effect tables. */
function effectTiles(keys, table = EFFECTS) {
  return (keys ?? []).filter((k) => table[k]).map((k) => compactTile({
    icon: table[k].icon,
    title: locText(table[k].name),
    text: locText(table[k].desc),
  }));
}

/**
 * A compact tile — icon and name only. The description opens as a popover on
 * hover or keyboard focus: effects and doctrines are many, and their full text
 * made the card several screens long.
 */
function compactTile({ icon, title, text }) {
  const tile = infoTile({ icon, title });
  tile.classList.add('compact');
  if (text) {
    tile.tabIndex = 0;
    tile.append(el('div', { className: 'tile-pop', role: 'tooltip', textContent: text }));
  }
  return tile;
}


/**
 * Tooltip for DPS and “Damage/volley”: shows the unarmored number next to the number
 * against the target and names the armor explicitly. Without it the column silently changes meaning
 * when the target changes: Pillager does 45 against 0% armor and 22.5 against those with fire
 * armor of 50%. It's unclear where 22.5 came from if nothing is labeled.
 */
function damageHint(unit, label, againstTarget, raw) {
  if (!state.target) return t('{label} vs 0% armor: {v}', { label, v: raw() });
  const weapon = (unit.weapons ?? []).find((w) => !w.utility && baseDamageType(w));
  const key = weapon ? weaponArmorKey(weapon) : null;
  const armor = key ? vKey(state.target.armor)?.[key] : undefined;
  const cut = typeof armor === 'number' ? Math.round((100 - armor)) : null;
  return t('{label} vs “{name}”: {v}', { label, name: displayName(state.target), v: againstTarget() }) + '\n'
    + t('without armor: {v}', { v: raw() })
    + (weapon ? '\n' + t('damage type: {type}, target armor: {armor}%', { type: weaponType(weapon), armor: armor ?? '—' }) + (cut === null ? '' : t(' (lets {cut}% through)', { cut })) : '');
}

/**
 * Type chips, from the game's pawn type tags (PawnType.Unit.Infantry,
 * PawnType.Unit.Vehicle.Air, PawnType.Structure.Superweapon…) as the data's unitClass.
 * Mines, barrels and other destructibles belong to no chip.
 */
const CLASS_GROUPS = [
  { key: 'infantry', label: t('Infantry'), classes: ['infantry'] },
  { key: 'vehicles', label: t('Vehicles'), classes: ['vehicle'] },
  { key: 'aircraft', label: t('Aircraft'), classes: ['aircraft'] },
  { key: 'superweapon', label: t('Superweapons'), classes: ['superweapon'] },
  { key: 'structures', label: t('Buildings'), classes: ['structure'] },
];

/** A unit's type group for the chips, or null (destructibles, no pawn type). */
function classOf(unit) {
  return CLASS_GROUPS.find((g) => g.classes.includes(unit?.unitClass))?.key ?? null;
}

const PLAYABLE_FACTIONS = ['GDF', 'Dynasty', 'Veti'];

/**
 * Entities that are not part of a player's army, hidden by one switch. Every criterion
 * is the game's own data (see extractor/build-site-data.mjs):
 *   - economy: workers and harvesters (PlayerData.Entity.Tag.Worker, the harvester
 *     navigation filter, the refinery factory tab) and what only produces them;
 *   - not one of the three playable factions (civilian / neutral affiliation);
 *   - destructibles: mines, barrels, crates;
 *   - left out of the game's codex (bIgnoreForCodex): campaign leftovers, variants the
 *     game counts as another entity, construction helpers.
 * Planning a build needs none of them.
 */
const isSecondary = (unit) => Boolean(unit.economy)
  || !PLAYABLE_FACTIONS.includes(unit.faction)
  || unit.kind === 'destructible'
  || unit.inCodex === false;

/**
 * The active column set. A function, not a constant: the “more info” toggle changes
 * it at runtime, and a reference frozen at load time would ignore the toggle.
 */
function columns() {
  return unitColumns();
}

function filteredUnits() {
  const { q, faction, classes, hideSecondary } = state.filters;
  const needle = q.trim().toLowerCase();
  const terms = needle ? searchTerms(needle) : null;
  return UNITS.filter((u) => {
    if (hideSecondary && isSecondary(u)) return false;
    if (faction && u.faction !== faction) return false;
    if (classes.length && !classes.includes(classOf(u))) return false;
    // Filter by specific effects: ANY of the checked ones. Not “all at once” —
    // otherwise picking two effects would silently give an empty table where their
    // combination simply doesn't occur.
    if (state.filters.effects.length) {
      const mine = unitEffectNames(u);
      if (!state.filters.effects.some((e) => mine.includes(e))) return false;
    }
    if (!terms) return true;
    return matches(u, terms);
  });
}

function renderArsenal() {
  const cols = columns();
  const column = cols.find((c) => c.key === state.sort.key) ?? cols[0];
  // sortKey must return a primitive, otherwise the comparison degenerates into NaN.
  const rows = sortRows(filteredUnits(), column.sort, state.sort.dir);

  const table = $('#arsenalTable');
  table.replaceChildren();

  const thead = el('thead');
  const headRow = el('tr');
  for (const col of cols) {
    const isSorted = col.key === state.sort.key;
    // Header tooltip: damage is computed AFTER the target's armor, and this used to be
    // the only place that said so. It no longer fits in the header text
    // (which became just “DPS”), so it goes into title. The column's own tooltip,
    // if it has one, takes precedence over the generic one.
    const tip = col.title
      ? col.title()
      : col.headLabel
        ? t('Value after the selected target’s armor. Hover a cell to see the unarmored value.')
        : '';
    headRow.append(el('th', {
      className: `${col.num ? 'num' : ''} ${isSorted ? 'sorted' : ''} ${isSorted && state.sort.dir === 1 ? 'asc' : ''} ${col.headLabel ? 'armed' : ''}`.trim(),
      title: tip,
      textContent: col.headLabel ? col.headLabel() : col.label,
      onclick: col.key === 'pic' ? null : () => {
        if (state.sort.key === col.key) state.sort.dir *= -1;
        else state.sort = { key: col.key, dir: col.num ? -1 : 1 };
        renderArsenal();
      },
    }));
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = el('tbody');
  for (const row of rows) {
    tbody.append(...unitRow(row, cols));
  }
  table.append(tbody);

  const shown = rows.length;

  const total = UNITS.length;
  // Short counter in the filter row; what the numbers mean goes to the tooltip.
  const counter = $('#arsenalCount');
  counter.textContent = t('Showing {shown} of {total}', { shown, total });
  counter.title = t('DPS and damage use multiplayer stats')
    + (state.target ? t(' vs “{name}”', { name: displayName(state.target) }) : t(' (no target, no armor)'));
}

/**
 * Unit row. Returns an array: the main row and, if weapon display is
 * enabled, the sub-row with the weapons.
 */
function unitRow(unit, cols) {
  // data-id: lets the row be found in the DOM (tests, debugging, autoscroll).
  const tr = el('tr', { className: 'clickable', data: { id: unit.id }, onclick: () => openUnit(unit) });
  for (const col of cols) {
    if (col.key === 'pic') {
      tr.append(el('td', { className: 'pic-cell' }, cellPicture(unit)));
      continue;
    }
    if (col.key === 'name') {
      tr.append(el('td', {}, el('span', { className: 'name-row' }, nameCell(unit))));
      continue;
    }
    tr.append(el('td', { className: cellClassOf(col) }, col.get(unit)));
  }
  const lines = weaponSubRow(unit);
  if (!lines.length) return [tr];
  return [tr, ...lines.map((line) => weaponLineRow(unit, cols, line))];
}

/**
 * Hits per attack the game data does not give (a looping attack animation, no attack
 * animation at all…): the attack damage, DPS and everything derived are unknown, and
 * the page shows "?" with the reason instead of computing as if the attack hit once.
 */
const unknownHits = (w) => vKey(w.shots) === undefined && !w.utility;
const hitsTip = (w) => t('Hits per attack unknown: the game data does not give one number.') + (w.missing?.shots ? '\n' + w.missing.shots : '');
/**
 * Volley damage as “22×4 (88)”: damage per hit × hits, total in brackets. A
 * single-hit volley is just the number. The total may already include the
 * target's armor — the per-hit part is derived from it, so both agree.
 */
function volleyText(w, total) {
  if (total === null || total === undefined || !Number.isFinite(total)) return '—';
  const hits = vKey(w?.shots);
  if (!hits || hits <= 1) return signed(total);
  return `${signed(total / hits)}×${hits} (${signed(total)})`;
}

const unknownCell = (className, title) => el('td', { className: `${className} unknown`, title, textContent: '?' });

/**
 * The hit count exists but the attack animation does not settle it beyond
 * doubt. The number is shown, marked with ⚠ and the reason, never silently.
 */
const DOUBT_REASONS = {
  'event-after-cooldown': () => t('a hit in the attack animation lands after the next attack may already start, so the real count can be lower'),
  'crawling-differs': () => t('the crawling attack animation fires a different number of times'),
};
function doubtNote(w) {
  const flags = w.shotsDoubt ?? [];
  if (!flags.length) return null;
  const why = flags.map((f) => (DOUBT_REASONS[f] ? DOUBT_REASONS[f]() : f)).join('; ');
  return el('i', { className: 'warn-note', title: t('Hit count uncertain: {why}', { why }), textContent: '⚠' });
}

/**
 * A single weapon row — an ordinary table row with cells under the same
 * columns. Each number sits under its column, and cells irrelevant to a weapon are empty.
 */
function weaponLineRow(unit, cols, line) {
  const { w, dps: value, burst, winner } = line;
  const targets = vKey(w.targets) ?? [];
  // Weapon details that have no column of their own in the main table
  // go into the tooltip, not the text: it was text in the name cell that stretched
  // the column and pushed the whole table sideways.
  const detail = [
    weaponType(w),
    t('interval {v} s', { v: fmt(pick(w.speed), 2) }),
    vKey(w.ammo) ? t('ammo {v}', { v: signed(vKey(w.ammo)) }) : null,
    targets.length ? t('targets: {v}', { v: termList(targets) }) : null,
  ].filter(Boolean).join(' · ');
  const cells = cols.map((col) => {
    switch (col.key) {
      case 'name': {
        // Only the name stays in the name cell. Effects and targets have their own
        // columns: inline they stretched the cell to a third of the screen.
        const hint = [
          detail,
          winner ? t('The unit is sorted by this weapon') : null,
        ].filter(Boolean).join('\n');
        return el('td', { className: 'wsub-name', title: hint },
          el('b', { textContent: weaponName(w) ?? t('Slot {n}', { n: w.slot }) }), doubtNote(w),
          w.utility ? el('span', { className: 'badge util', title: t('Utility ability, deals no damage'), textContent: t('util.') }) : null);
      }
      case 'effects':
        return el('td', {}, effectList(w.effects));
      case 'targets':
        return el('td', {}, targetList(w));
      case 'dps':
        if (unknownHits(w)) return unknownCell('num dmg-cell', hitsTip(w));
        // damageHint reads only unit.weapons, so we pass in the single weapon.
        return el('td', {
          className: 'num dmg-cell',
          title: damageHint({ weapons: [w] }, 'DPS', () => fmt(value), () => fmt(dps(w, null))),
          textContent: fmt(value),
        });
      case 'burst':
        if (unknownHits(w)) return unknownCell('num dmg-cell', hitsTip(w));
        return el('td', {
          className: 'num dmg-cell',
          title: damageHint({ weapons: [w] }, t('Volley damage'),
            () => signed(burst ?? vKey(w.damagePerVolley)),
            () => signed(hitDamage(w, null)?.effective ?? vKey(w.damagePerVolley))),
          textContent: volleyText(w, burst ?? vKey(w.damagePerVolley)),
        });
      case 'aoe': {
        const radius = vKey(w.aoe);
        return el('td', { className: 'num', textContent: radius === undefined ? '—' : String(radius) });
      }
      case 'range':
        return el('td', { className: 'num', textContent: signed(vKey(w.range)) });
      // Damage type and interval of the weapon — in their own columns, not in the name text.
      // In the unit row these columns keep the armor class and the main weapon's interval.
      case 'armorType':
        return el('td', { textContent: weaponType(w) ?? '—' });
      case 'interval':
        return el('td', { className: 'num', textContent: w.utility ? '—' : fmt(pick(w.speed), 2) });
      case 'ammo': {
        // Magazine: size, and how it refills when the game stores that.
        const ammo = vKey(w.ammo);
        const recharge = vKey(w.recharge);
        const refill = !recharge ? ''
          : recharge.perRecharge !== undefined
            ? t(' (+{n}/{t}s)', { n: recharge.perRecharge, t: recharge.time })
            : t(' (reload {t}s)', { t: recharge.time });
        return el('td', { className: 'num', textContent: ammo ? `${ammo}${refill}` : '—' });
      }
      default:
        // Unit properties: no point repeating them in the weapon row, leave empty.
        return el('td', { className: col.num ? 'num' : '' });
    }
  });
  return el('tr', {
    className: `wsub-row${winner ? ' win' : ''}`,
    data: { for: unit.id, slot: String(w.slot) },
    title: winner ? t('The unit is sorted by this weapon') : '',
  }, cells);
}

/**
 * Weapon descriptions: name, its own DPS and volley, and a “winner” flag.
 * The winner is highlighted by what we actually sort by: sort by
 * damage/volley and the weapon with the biggest volley is highlighted, not the one with the highest DPS.
 */
function weaponSubRow(unit) {
  const armed = (unit.weapons ?? []).filter((w) => !w.utility);
  if (!armed.length) return [];
  const scored = armed.map((w) => ({
    w,
    dps: dps(w, state.target),
    burst: hitDamage(w, state.target)?.effective ?? null,
  }));
  // Highlight by exactly what we sort by. Otherwise, when sorting by
  // damage/volley, the wrong weapon would be highlighted.
  const metric = state.sort.key === 'burst' ? 'burst' : 'dps';
  const best = scored.reduce((a, b) => ((b[metric] ?? -1) > (a[metric] ?? -1) ? b : a), scored[0]);
  const sortShowsMetric = ['dps', 'burst'].includes(state.sort.key);
  return scored.map((line) => ({ ...line, winner: sortShowsMetric && best && best.w === line.w }));
}

// ──────────────────────────────────────────────────────── unit card

function openUnit(unit) {
  $('#dlgTitle').textContent = nameInline(unit);
  const body = $('#dlgBody');
  body.replaceChildren();

  const badges = el('div', { className: 'badge-row' },
    el('span', { className: `f-${unit.faction}`, textContent: term(unit.faction) }),
    unit.tier ? el('span', { className: `badge t${unit.tier}`, textContent: t('Tier {n}', { n: unit.tier }) }) : null,
    unit.isSuperweapon ? el('span', { className: 'badge', textContent: t('Superweapons') }) : null,
    unit.economy ? el('span', { className: 'badge', textContent: t('Economy') }) : null,
  );

  // The game's own icon is the card's picture.
  const hero = el('div', { className: 'pic-hero-wrap' });
  hero.append(el('div', { className: 'pic-box' }, picture(unit, 132)));
  const head = el('div', { className: 'unit-head' });
  const armorClass = EFFECTS[unit.armorClass];
  head.append(
    el('div', { className: 'unit-title' }, badges),
    el('p', { className: 'note', title: locText(armorClass?.desc) ?? '' }, [classLabel(unit), unit.armorType ? term(unit.unitClass) : null].filter(Boolean).join(' · ')),
  );
  hero.append(head);
  body.append(hero);

  // Key stats
  const stat = (k, value, sub, missing) => el('div', { className: 'stat', title: missing ? missingTip(missing) : '' },
    el('div', { className: 'k', textContent: k }),
    el('div', { className: 'v', textContent: value }),
    sub ? el('div', { className: 'sub', textContent: sub }) : null,
  );
  const statOf = (label, field, format = signed) => {
    const v = vKey(unit.stats[field]);
    return el('div', { className: 'stat', title: v === undefined ? absentTip(unit, field) : '' },
      el('div', { className: 'k', textContent: label }),
      el('div', { className: 'v', textContent: format(v) }));
  };
  const intel = vKey(unit.stats.intelCost);

  const dpsAll = unitWeaponStats(unit, state.target);
  body.append(el('div', { className: 'grid' },
    statOf('HP', 'hp'),
    stat('DPS', fmt(dpsAll.best), state.target ? t('vs “{name}”', { name: displayName(state.target) }) : t('no armor')),
    stat(t('Dmg/volley'), signed(unitBurst(unit, state.target))),
    foundationOf(unit)
      ? el('div', { className: 'stat', title: creditsTip(unit) },
        el('div', { className: 'k', textContent: t('Credits') }),
        el('div', { className: 'v', textContent: creditsText(unit) }),
        el('div', { className: 'sub', textContent: t('+ foundation') }))
      : statOf(t('Credits'), 'cost'),
    // only for entities that cost Intel (GDF's second resource)
    intel > 0 ? statOf(t('Intel'), 'intelCost') : null,
    statOf(t('Build'), 'buildTime', (v) => (v === undefined ? '—' : t('{v} s', { v: signed(v) }))),
    statOf(t('Pop'), 'population'),
    statOf(t('Speed'), 'speed'),
    statOf(t('Sight'), 'sight'),
  ));

  // Unit and structure descriptions are deliberately not published; the purpose of a unit
  // shows in its class, weapons, effects and abilities below.

  // Armor
  const armor = vKey(unit.armor);
  if (armor) {
    body.append(el('h3', { textContent: t('Armor') }));
    const table = el('table');
    const tr = el('tr');
    for (const key of ARMOR_KEYS) {
      tr.append(el('td', { className: 'num' }, armorCell(armor[key])));
    }
    table.append(el('thead', {}, el('tr', {}, ...ARMOR_KEYS.map((k) => el('th', { className: 'num', textContent: term(ARMOR_LABEL[k]) })))), el('tbody', {}, tr));
    // Container with scroll and border — like the weapons table.
    body.append(el('div', { className: 'table-wrap' }, table));
    body.append(el('p', { className: 'note', textContent: t('Percent reduction of incoming damage of that type. 100% is full immunity. Omni damage ignores armor.') }));
  }

  // Weapons
  body.append(el('h3', { textContent: t('Weapons') }));
  if (!(unit.weapons ?? []).length) {
    body.append(el('p', { className: 'note', textContent: t('This entity has no weapons in the game data.') }));
  } else {
    // The same table as the weapon rows of the arsenal: same columns, same order,
    // same cells (weaponLineRow), so the card and the table cannot drift apart.
    // Only the magazine is extra — it matters for rocket batteries.
    const main = new Map(unitColumns().map((c) => [c.key, c]));
    const cols = [
      { key: 'name', label: t('Weapons') },
      { key: 'armorType', label: t('Type') },
      ...['dps', 'burst', 'aoe', 'range', 'interval', 'effects', 'targets'].map((k) => main.get(k)).filter(Boolean),
      { key: 'ammo', label: t('Ammo'), num: true, title: () => t('Magazine size and how it refills') },
    ];
    const table = el('table', { className: 'card-weapons' },
      el('thead', {}, el('tr', {}, ...cols.map((c) => el('th', {
        className: c.num ? 'num' : '',
        title: c.title ? c.title() : '',
        textContent: c.headLabel ? c.headLabel() : c.label,
      })))),
      el('tbody', {}, ...unit.weapons.map((w) => weaponLineRow(unit, cols, {
        w, dps: dps(w, state.target), burst: hitDamage(w, state.target)?.effective ?? null, winner: false,
      }))));
    body.append(el('div', { className: 'table-wrap' }, table));
  }

  // Effects and auras. Split into three groups because they're different things:
  // the unit's own auras (what it keeps around itself), its weapons' effects (what
  // they apply to the target) and doctrines (what is researched and changes the unit).
  const ownEffects = (unit.unitEffects ?? []).map((e) => e.base);
  const weaponEffects = [];
  for (const w of unit.weapons ?? []) {
    if (w.utility) continue;
    for (const e of w.effects ?? []) if (!ownEffects.includes(e) && !weaponEffects.includes(e)) weaponEffects.push(e);
  }
  const effectsSection = () => {
    if (!ownEffects.length && !weaponEffects.length) return;
    body.append(el('h3', {
      textContent: t('Effects and auras'),
      title: t('Auras are always active around the unit, weapon effects are applied on hit. Doctrines are researched and change this unit, its weapons or its fields.'),
    }));
    body.append(
      tileGroup(t('Unit auras:'), effectTiles(ownEffects)) ?? '',
      tileGroup(t('Applied by weapons:'), effectTiles(weaponEffects)) ?? '',
    );
  };
  const doctrinesSection = () => {
    if (!(unit.doctrines ?? []).length) return;
    body.append(el('h3', { textContent: t('Doctrines') }));
    body.append(tileGroup(null, effectTiles(unit.doctrines, DOCTRINES)) ?? '');
  };

  // Abilities first: what the unit can do. Then its effects and auras, then doctrines.
  const abilities = unit.abilitiesDetails ?? [];
  if (abilities.length) {
    body.append(el('h3', { textContent: t('Abilities') }));
    body.append(tileGroup(null, abilities.map((ability) => infoTile({
      icon: ability.icon,
      title: loc(ability.name, ability.nameRu),
      text: ability.desc ? loc(ability.desc, ability.descRu) : null,
      meta: [
        ability.upgrade ? t('Upgrade') : null,
        ...abilityCosts(ability),
        ability.cooldown ? t('Cooldown: {v} s', { v: signed(ability.cooldown) }) : null,
      ].filter(Boolean).join(' · ') || null,
    }))));
  }
  effectsSection();
  doctrinesSection();

  // Production and requirements, from the factories' lists and the unit's prerequisites.
  const nameOfId = (id) => (UNIT_BY_ID.get(id) ? displayName(UNIT_BY_ID.get(id)) : id);
  const requirement = (r) => (r.upgrade ? t('{name} with “{upgrade}”', { name: nameOfId(r.id), upgrade: locText(r.upgrade) }) : nameOfId(r.id));
  const extras = [
    [t('Produced at'), (unit.producedBy ?? []).map(nameOfId)],
    [t('Requires'), (unit.requires ?? []).map((group) => group.map(requirement).join(t(' or ')))],
  ].filter(([, list]) => list.length);

  if (extras.length) {
    body.append(el('h3', { textContent: t('Other') }));
    body.append(el('dl', { className: 'facts' }, ...extras.flatMap(([label, list]) => [
      el('dt', { textContent: label }),
      el('dd', { textContent: list.join(' · ') }),
    ])));
  }

  // A link to the community wiki for prose and history. Search, not a page URL:
  // the game's names do not always match the wiki's page titles.
  body.append(el('p', { className: 'note dlg-links' }, el('a', {
    href: WIKI_SEARCH + encodeURIComponent(unit.name),
    target: '_blank',
    rel: 'noreferrer',
    textContent: t('“{name}” on the Tempest Rising Wiki ↗', { name: unit.name }),
  })));

  $('#unitDialog').showModal();
}

// ────────────────────────────────────────────────────────────── compare

// ──────────────────────────────────────────────────────────────── compare
/**
 * Units in the comparison: two by default, “+ unit” adds up to
 * MAX_COMPARE. Zero removes the unit entirely.
 */
const MAX_COMPARE = 5;
function initCompare() {
  // The default target is empty. Rationale: with no target there's nothing for armor to reduce, so all
  // “after armor” values — DPS vs target, damage vs target, TTK — stay
  // empty, and the comparison doesn't output a number computed against an arbitrary
  // unit. A default target used to be selected, and that silently made all
  // the “resisted” comparison figures computed.
  state.compareTarget = null;
  unitPicker({
    mount: $('#cmpTarget'),
    value: '',
    onChange: (id) => {
      state.compareTarget = id ? UNITS.find((u) => u.id === id) : null;
      renderCompare();
    },
  });
  $('#cmpAdd').addEventListener('click', addCompareUnit);
  $('#cmpReset').addEventListener('click', () => {
    state.compare = defaultCompare();
    renderCompare();
  });
  renderCompare();
}
/** Adds the next armed unit that is not compared yet (toolbar button and empty slots). */
function addCompareUnit() {
  if (state.compare.length >= MAX_COMPARE) return;
  const used = new Set(state.compare.map((c) => c.unitId));
  const next = UNITS.find((u) => !used.has(u.id) && !isSecondary(u) && (u.weapons ?? []).some((w) => !w.utility));
  if (!next) return;
  state.compare.push({ unitId: next.id, slot: null });
  renderCompare();
}
/**
 * Builds the comparison columns. Each unit has its own selected weapon; if no weapon
 * is chosen explicitly, take the best by DPS — otherwise the column would be empty.
 */
function compareColumns() {
  const target = state.compareTarget;
  return state.compare.map((entry) => {
    const unit = UNITS.find((u) => u.id === entry.unitId);
    const armed = (unit?.weapons ?? []).filter((w) => !w.utility);
    let weapon = armed.find((w) => String(w.slot) === String(entry.slot)) ?? null;
    if (!weapon && armed.length) {
      // Best by DPS against the selected opponent — a fair default.
      weapon = armed.reduce((a, b) => ((dps(b, target) ?? -1)
        > (dps(a, target) ?? -1) ? b : a), armed[0]);
      entry.slot = weapon.slot;
    }
    return { entry, unit, weapon, target };
  }).filter((c) => c.unit);
}
/** The unit's weapon list for the dropdown in its column. */
function weaponChoices(unit) {
  return (unit?.weapons ?? []).filter((w) => !w.utility).map((w) => el('option', {
    value: String(w.slot),
    textContent: `${weaponName(w) ?? t('Slot {n}', { n: w.slot })} · ${weaponType(w) ?? '?'}`,
  }));
}
function renderCompare() {
  const out = $('#cmpOut');
  out.replaceChildren();
  const cols = compareColumns();

  // The button is disabled at the limit: otherwise clicking it looks “broken”.
  const add = $('#cmpAdd');
  add.disabled = state.compare.length >= MAX_COMPARE;
  add.title = add.disabled
    ? t('At most {n} units — more would be unreadable', { n: MAX_COMPARE })
    : t('Add another unit to compare');

  if (!cols.length) {
    out.append(el('p', { className: 'note', textContent: t('Add a unit with the “+ unit” button.') }));
    return;
  }
  const target = state.compareTarget;
  const ghosts = Array.from({ length: Math.max(0, MAX_COMPARE - cols.length) });
  // ── header: unit and weapon picker in each column
  const headCells = [el('th', { textContent: '' })];
  for (const col of cols) {
    const unitSlot = el('div');
    unitPicker({
      mount: unitSlot,
      value: col.unit.id,
      // No weapon filter: the table has HP, price and build time, so
      // comparing two buildings also makes sense — the DPS will just be “—”.
      onChange: (id) => {
        col.entry.unitId = id;
        col.entry.slot = null;      // the previous unit's weapon doesn't fit here
        renderCompare();
      },
    });
    const weaponSelect = el('select', {}, weaponChoices(col.unit));
    weaponSelect.disabled = !col.weapon;
    if (col.weapon) weaponSelect.value = String(col.weapon.slot);
    weaponSelect.addEventListener('change', () => {
      col.entry.slot = weaponSelect.value;
      renderCompare();
    });
    const remove = el('button', {
      className: 'cmp-remove',
      title: t('Remove from comparison'),
      textContent: '×',
      onclick: () => {
        state.compare = state.compare.filter((c) => c !== col.entry);
        renderCompare();
      },
    });
    headCells.push(el('th', { className: 'col-unit' },
      el('div', { className: 'cmp-unit cmp-pick' }, cellPicture(col.unit), unitSlot, remove),
      el('div', { className: 'cmp-pick' }, weaponSelect)));
  }
/**
   * Metrics. better: 'max' — higher is better, 'min' — lower is better,
   * null — just a number without a verdict. Highlighting the best in each row is the whole point
   * of the comparison: you immediately see who wins on that parameter.
   *
   * Target behavior is exactly as in the main table, with no rules of its own:
   *   • target selected → computed AFTER its armor, labeled “⟂ Target”;
   *   • no target → computed against 0% armor, labeled “vs 0% armor”;
   *   • only TTK stays empty: without a target there's no HP, nothing to compute.
   * There are no separate “no armor” rows — that's the same case as clearing the target.
   */
  const tgt = (base) => base;
  // The same quantities as the arsenal table's columns, grouped; plus TTK and
  // credits per DPS, which only make sense when comparing.
  const ROWS = [
    { group: t('Damage') },
    { key: 'type', label: t('Damage type'), get: (c) => (c.weapon ? term(baseDamageType(c.weapon)) ?? '—' : '—') },
    { key: 'dps', label: () => tgt('DPS'), num: true, better: 'max', unknownHits: true, get: (c) => (c.weapon ? dps(c.weapon, target) : undefined), fmt: (v) => fmt(v, 1), hint: () => (target ? t('after target armor') : t('no target — computed vs 0% armor')) },
    { key: 'burst', label: () => tgt(t('Dmg/volley')), num: true, better: 'max', unknownHits: true, get: (c) => (c.weapon ? hitDamage(c.weapon, target)?.effective ?? undefined : undefined), fmt: (v, c) => (c?.weapon ? volleyText(c.weapon, v) : signed(v)), hint: () => (target ? t('target armor applied') : t('no target — computed vs 0% armor')) },
    { key: 'aoe', label: 'AoE', num: true, better: 'max', get: (c) => (c.weapon ? pick(c.weapon.aoe) : undefined), fmt: (v) => (v === undefined ? '—' : signed(v)) },
    { key: 'range', label: t('Range'), num: true, better: 'max', get: (c) => (c.weapon ? pick(c.weapon.range) : undefined), fmt: (v) => signed(v) },
    { key: 'interval', label: t('Interval, s'), num: true, better: 'min', get: (c) => (c.weapon ? pick(c.weapon.speed) : undefined), fmt: (v) => fmt(v, 2) },
    // TTK is the only row that requires a target: without its HP there's nothing to kill.
    { key: 'ttk', label: t('TTK, s'), num: true, better: 'min', get: (c) => (c.weapon && target ? timeToKill(c.weapon, target) : undefined), fmt: (v) => fmt(v, 1), hint: () => (target ? t('target HP: {hp}', { hp: signed(pick(target.stats.hp)) }) : t('needs a target: no one to compute TTK against')) },
    { key: 'ammo', label: t('Ammo'), num: true, get: (c) => (c.weapon ? pick(c.weapon.ammo) : undefined), fmt: (v) => signed(v), hint: () => t('unlimited') },
    { key: 'effects', label: t('Effects'), render: (c) => (c.weapon ? effectList(c.weapon.effects) : null) },
    { key: 'targets', label: t('Targets'), render: (c) => (c.weapon ? targetList(c.weapon) : null) },
    { group: t('Survivability') },
    { key: 'hp', label: 'HP', num: true, better: 'max', get: (c) => pick(c.unit.stats.hp), fmt: (v) => signed(v) },
    { key: 'moveSpeed', label: t('Speed'), num: true, better: 'max', get: (c) => pick(c.unit.stats.speed), fmt: (v) => signed(v) },
    { key: 'sight', label: t('Sight'), num: true, better: 'max', get: (c) => pick(c.unit.stats.sight), fmt: (v) => signed(v) },
    // Armor by damage type — the same six columns as in the arsenal.
    ...ARMOR_KEYS.map((k) => ({
      key: `armor_${k}`, label: term(ARMOR_LABEL[k]), num: true, better: 'max',
      get: (c) => pick(c.unit.armor)?.[k], fmt: (v) => `${signed(v)}%`,
    })),
    { group: t('Cost') },
    { key: 'cost', label: t('Credits'), num: true, better: 'min', get: (c) => creditsTotal(c.unit), fmt: (v, c) => (c?.unit ? creditsText(c.unit) : signed(v)), hint: () => t('per unit, not per weapon; GDF buildings: main cost + foundation') },
    { key: 'intel', label: t('Intel'), num: true, better: 'min', get: (c) => pick(c.unit.stats.intelCost), fmt: (v) => (v ? signed(v) : '—'), hint: () => t('Intel: the second resource; — when paid in credits only') },
    { key: 'buildTime', label: t('Build, s'), num: true, better: 'min', get: (c) => pick(c.unit.stats.buildTime), fmt: (v) => signed(v) },
    { key: 'pop', label: t('Population'), num: true, better: 'min', get: (c) => pick(c.unit.stats.population), fmt: (v) => signed(v) },
    { key: 'costPerDps', label: t('Credits per DPS'), num: true, better: 'min', unknownHits: true, get: (c) => {
      const d = c.weapon ? dps(c.weapon, target) : undefined;
      const cost = creditsTotal(c.unit);
      return d && d > 0 && cost ? cost / d : undefined;
    }, fmt: (v) => fmt(v, 1), hint: () => t('cost divided by weapon DPS') },
  ];
  const body = el('tbody');
  for (const row of ROWS) {
    if (row.group) {
      body.append(el('tr', { className: 'group' }, el('td', { colSpan: cols.length + ghosts.length + 1, textContent: row.group })));
      continue;
    }
    if (row.render) {
      const label = typeof row.label === 'function' ? row.label() : row.label;
      body.append(el('tr', {}, el('td', { className: 'metric' }, label),
        ...cols.map((c) => el('td', { className: 'val chips' }, row.render(c) ?? '—')),
        ...ghosts.map(() => el('td', { className: 'ghost' }))));
      continue;
    }
    const values = cols.map((c) => row.get(c));
    // Highlight only when there's something to compare: at least two numeric values.
    const numeric = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
    const comparable = row.better && numeric.length >= 2;
    let bestIdx = -1;
    let worstIdx = -1;
    if (comparable) {
      const best = row.better === 'max' ? Math.max(...numeric) : Math.min(...numeric);
      const worst = row.better === 'max' ? Math.min(...numeric) : Math.max(...numeric);
      // On a full tie no check mark is placed: nobody wins.
      if (best !== worst) {
        bestIdx = values.findIndex((v) => v === best);
        worstIdx = values.findIndex((v) => v === worst);
      }
    }
    // A metric's label may be a function: for resisted rows it names the target,
    // otherwise an empty target would yield a row that lacks meaning.
    const label = typeof row.label === 'function' ? row.label() : row.label;
    const tr = el('tr', {}, el('td', { className: 'metric', title: row.hint ? row.hint(cols[0]) ?? '' : '' }, label));
    values.forEach((value, i) => {
      // A number that needs the hit count is "?" when the game data does not give one.
      const weapon = cols[i].weapon;
      const unknown = row.unknownHits && weapon && unknownHits(weapon) && (value === undefined || value === null);
      const text = unknown ? '?'
        : value === undefined || value === null
          ? '—'
          : (row.fmt ? row.fmt(value, cols[i]) : String(value));
      tr.append(el('td', {
        className: 'val' + (i === bestIdx ? ' best' : '') + (i === worstIdx && cols.length > 2 ? ' worst' : '') + (unknown ? ' unknown' : ''),
        title: unknown ? hitsTip(weapon) : '',
        textContent: text,
      }));
    });
    tr.append(...ghosts.map(() => el('td', { className: 'ghost' })));
    body.append(tr);
  }
  const table = el('table', { className: 'cmp' },
    el('colgroup', {}, el('col', { className: 'metric-col' }), ...[...cols, ...ghosts].map(() => el('col', { className: 'unit-col' }))),
    el('thead', {}, el('tr', {}, headCells, ...ghosts.map(() => el('th', { className: 'col-ghost' },
      el('button', { className: 'cmp-add-slot', type: 'button', textContent: t('+ unit'), title: t('Add another unit to compare'), onclick: addCompareUnit }))))),
    body);
  out.append(table);
  // One status line in the toolbar instead of notes under the table.
  $('#cmpStatus').textContent = target
    ? t('Damage after the armor of “{name}”', { name: displayName(target) })
    : t('No target: damage vs 0% armor, TTK empty');
  $('#cmpStatus').title = t('Green — the best in a row. Damage and DPS use the selected weapon.');
  if (cols.length > 1 && cols.every((c) => !c.weapon)) {
    out.append(el('p', { className: 'note', textContent: t('The selected units are unarmed: nothing to compare.') }));
  }
}

// ─────────────────────────────────────────────────────────────────── init

function renderAll() {
  renderArsenal();
  renderCompare();
}

/** EN / RU switch. Changing the language reloads the page, see lib/i18n.js. */
function initLangSwitch() {
  const switcher = $('#langSwitch');
  for (const b of switcher.querySelectorAll('button')) b.classList.toggle('active', b.dataset.lang === LANG);
  switcher.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-lang]');
    if (button) globalThis.TRI18n.setLang(button.dataset.lang);
  });
}

/**
 * Footer: where the data and images come from — the game files — and who owns them.
 * The source code link appears only if the build knows it.
 */
function renderFooter() {
  const footer = $('#siteFooter');
  footer.replaceChildren(t('Data and images come from the Tempest Rising game files and belong to their respective owners. Fan project, not affiliated with the developers or publisher of Tempest Rising.'));
  const repo = globalThis.TR_CONFIG?.repoUrl;
  if (repo) footer.append(' · ', el('a', { href: repo, target: '_blank', rel: 'noreferrer', textContent: t('Source code') }));
}

function init() {
  globalThis.TRI18n.applyStatic();
  initLangSwitch();
  renderFooter();
  initExtraToggle();
  initEffectFilter();

  for (const [selector, key] of [['#q', 'q'], ['#fFaction', 'faction']]) {
    $(selector).addEventListener('input', (event) => {
      state.filters[key] = event.target.value;
      renderArsenal();
    });
  }

  /**
   * Type chips: several can be on at once; none on means all types. Groups
   * without entities are not shown.
   */
  const classBox = $('#fClass');
  const groups = CLASS_GROUPS.filter((group) => UNITS.some((u) => classOf(u) === group.key));
  classBox.replaceChildren(...groups.map((group) => {
    const input = el('input', { type: 'checkbox', value: group.key });
    input.addEventListener('change', () => {
      // querySelectorAll right here: a global all() would clash with
      // the helper of the same name declared by the UI autotest.
      state.filters.classes = [...document.querySelectorAll('#fClass input:checked')].map((i) => i.value);
      renderArsenal();
    });
    return el('label', { className: 'chip' }, input, el('span', { textContent: group.label }));
  }));
    $('#resetFilters').addEventListener('click', resetFilters);
  $('#hideSecondary').addEventListener('change', (e) => { state.filters.hideSecondary = e.target.checked; renderArsenal(); });

    // Target picker for the DPS column: a search, not a list of every unit.
    arsenalTargetPicker = unitPicker({
      mount: $('#fTarget'),
      value: state.target?.id ?? '',
      emptyLabel: t('DPS vs 0% armor'),
      onChange: (id) => {
        state.target = id ? UNITS.find((u) => u.id === id) : null;
        renderArsenal();
      },
    });


  $('#tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const panel of document.querySelectorAll('.panel')) panel.classList.toggle('active', panel.id === `panel-${tab.dataset.panel}`);
  });

  $('#dlgClose').addEventListener('click', () => $('#unitDialog').close());
  $('#unitDialog').addEventListener('click', (event) => {
    if (event.target === $('#unitDialog')) $('#unitDialog').close();
  });

  initCompare();
  syncFilterControls({ rerender: false });
  renderAll();

  // The browser restores form fields after load and when returning to the tab,
  // without firing change. Bring the controls back to the state, otherwise they
  // would show a filter that isn't applied.
  addEventListener('load', syncFilterControls);
  addEventListener('focus', syncFilterControls);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncFilterControls();
  });

  $('#srcInfo').textContent = t('{n} entities · {w} weapons · {date}', { n: UNITS.length, w: DATA.meta.armedWeapons, date: new Date(DATA.meta.generatedAt).toLocaleDateString(LOCALE) });
}

init();
