#!/usr/bin/env node
/**
 * build-site-data.mjs — the site's data, built from the game files only.
 *
 *   node extractor/build-site-data.mjs [--export extractor/out/export] [--stats extractor/out/stats-mp.json]
 *                                      [--icons extractor/out/icons] [--data data] [--web-icons web/icons]
 *
 * Needs (see extractor/README.md, or simply `npm run extract`):
 *   trdump json @definitions @texts @pawns @montages @commands objrefs:DamageType@definitions
 *   trdump locres
 *   trdump png @icons
 *   node extractor/build-stats.mjs        stats-mp.json: the multiplayer entity set, weapons, hits per attack
 *
 * Writes (committed: CI cannot read the game):
 *   data/units.json         the entities the multiplayer definition collection activates, in the
 *                           schema web/app.js and web/lib/calc.js read, plus the effect and
 *                           doctrine tables they reference
 *   data/build-report.json  every value left null and why, every value filled from a native
 *                           class default (with its source and the verification), values that do
 *                           not apply (e.g. the cost of a mine nobody builds), unresolved text
 *                           placeholders, excluded entities, counts
 *   web/icons/*.png         exactly the icons the data references
 *
 * Rules (extractor/MAINTENANCE.md): the game is the only source; assets are joined by the
 * references the game itself uses (AssetIdentifier, object paths, gameplay tags); when the
 * data does not give a value the output is null and the reason is recorded. Unit and
 * structure description texts are never written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillPlaceholders, cleanText, tagMatches, RESIST_TO_ARMOR, unitClassFromTags } from './lib/game-text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : fallback;
};
const EXPORT = arg('export', path.join(HERE, 'out/export'));
const STATS = arg('stats', path.join(HERE, 'out/stats-mp.json'));
const ICONS = arg('icons', path.join(HERE, 'out/icons'));
const DATA = arg('data', path.join(ROOT, 'data'));
const WEB_ICONS = arg('web-icons', path.join(ROOT, 'web/icons'));
const JSON_ROOT = path.join(EXPORT, 'json');
const LOC_ROOT = path.join(EXPORT, 'locres');
const DEF_DIR = 'Tempest/Content/Tempest/DataAssets/Definitions';
const DOCTRINE_DIR = 'Tempest/Content/Tempest/DataAssets/Doctrine';
const NATIVE_CHECK = arg('native-check', path.join(HERE, 'out/native-defaults-check.json'));

for (const p of [path.join(JSON_ROOT, DEF_DIR), LOC_ROOT, STATS, path.join(ICONS, 'index.json')]) {
  if (!fs.existsSync(p)) {
    console.error(`missing ${p}\nrun the extraction chain first (npm run extract, see extractor/README.md)`);
    process.exit(1);
  }
}

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out); else if (f.name.endsWith('.json')) out.push(p);
  }
  return out;
}

// ─────────────────────────────────────────────────────────── report

const report = {
  nulls: [],          // { entity, field, reason }
  filled: [],         // { entity, field, value, source }: not stored in the definition, from the verified native default
  notApplicable: [],  // { entity, field, reason }: values the game never uses for this entity (shown as "—", not unknown)
  placeholders: [],   // { owner, field, lang, placeholders }
  excluded: [],       // { id, reason }
  missingRussian: [], // { owner, field }
  notes: [],          // { topic, detail }
};
const nul = (entity, field, reason) => report.nulls.push({ entity, field, reason });
const filled = (entity, field, value, source) => report.filled.push({ entity, field, value, source });
const notApplicable = (entity, field, reason) => report.notApplicable.push({ entity, field, reason });
const nativeCheck = fs.existsSync(NATIVE_CHECK) ? read(NATIVE_CHECK) : null;
const note = (topic, detail) => report.notes.push({ topic, detail });

// ─────────────────────────────────────────────────────────── localization

const loc = { en: {}, ru: {} };
for (const g of fs.readdirSync(LOC_ROOT)) {
  for (const lang of ['en', 'ru']) {
    const p = path.join(LOC_ROOT, g, lang, `${g}.json`);
    if (!fs.existsSync(p)) continue;
    for (const [ns, entries] of Object.entries(read(p))) Object.assign(loc[lang][ns] ??= {}, entries);
  }
}
// string table asset → its localization namespace
const tableNs = {};
for (const p of walk(path.join(JSON_ROOT, 'Tempest/Content/Tempest/UI/Texts'))) {
  for (const e of read(p)) if (e.Type === 'StringTable') tableNs[e.Package] = e.StringTable?.TableNamespace ?? e.Name;
}

/** One FText reference (no format arguments) in one language. */
function plainText(t, lang) {
  if (!t || typeof t !== 'object') return typeof t === 'string' ? t : null;
  if (t.CultureInvariantString != null) return t.CultureInvariantString;
  if (t.Key == null) return lang === 'en' ? t.SourceString ?? t.LocalizedString ?? null : null;
  let ns = t.Namespace ?? '';
  if (t.TableId) ns = tableNs[t.TableId.split('.')[0]] ?? t.TableId.split('.').pop();
  return loc[lang][ns]?.[t.Key] ?? (lang === 'en' ? t.SourceString ?? t.LocalizedString : null) ?? null;
}

/**
 * A game text in English and Russian. Format texts (`{ Format, Arguments }`) get their
 * placeholders filled from the arguments stored in the same asset; a placeholder without a
 * value is shown as "?" and recorded.
 */
function bilingual(t, owner, field) {
  const out = {};
  for (const lang of ['en', 'ru']) {
    let format = null;
    const values = {};
    if (t && typeof t === 'object' && t.Format) {
      format = plainText(t.Format, lang);
      for (const a of t.Arguments ?? []) values[a.Key] = typeof a.Value === 'object' ? plainText(a.Value, lang) : a.Value;
    } else {
      format = plainText(t, lang);
    }
    const { text, unresolved } = fillPlaceholders(cleanText(format), values);
    // One entry per asset text: the same command is shared by several units.
    if (unresolved.length && !report.placeholders.some((x) => x.owner === owner && x.field === field && x.lang === lang)) {
      report.placeholders.push({ owner, field, lang, placeholders: unresolved });
    }
    out[lang] = text;
  }
  if (out.en && !out.ru) report.missingRussian.push({ owner, field });
  return out;
}

// ─────────────────────────────────────────────────────────── packages

const pkgFile = (pkg) => path.join(JSON_ROOT, pkg.replace(/^\/Game\//, 'Tempest/Content/') + '.json');
/** "/Game/A/B.0", "/Game/A/B.B_C" → "/Game/A/B" */
const refPkg = (ref) => {
  const p = typeof ref === 'string' ? ref : ref?.ObjectPath ?? ref?.AssetPathName;
  return p ? p.replace(/\.\d+$/, '').split('.')[0] : null;
};
const shortName = (pkg) => (pkg ? pkg.split('/').pop() : null);
const pkgCache = new Map();
function loadPkg(pkg) {
  if (!pkg) return null;
  if (!pkgCache.has(pkg)) pkgCache.set(pkg, fs.existsSync(pkgFile(pkg)) ? read(pkgFile(pkg)) : null);
  return pkgCache.get(pkg);
}
/** A blueprint class default object value, inherited from the nearest parent blueprint that sets it. */
function cdoValue(pkg, prop) {
  for (let p = pkg, guard = 0; p && guard < 16; guard++) {
    const exps = loadPkg(p);
    if (!exps) return undefined;
    const cdo = exps.find((e) => (e.Name ?? '').startsWith('Default__'));
    if (cdo?.Properties?.[prop] !== undefined) return cdo.Properties[prop];
    const bgc = exps.find((e) => e.Type === 'BlueprintGeneratedClass');
    const sup = refPkg(bgc?.SuperStruct ?? bgc?.Super);
    p = sup?.startsWith('/Game/') ? sup : null;
  }
  return undefined;
}

// Every definition asset (all layers): package → AssetIdentifier, to follow object references
// such as Prerequisites, which point at a definition asset rather than at an identifier.
const idByPkg = new Map();
for (const p of walk(path.join(JSON_ROOT, DEF_DIR))) {
  for (const e of read(p)) {
    const id = e.Properties?.AssetIdentifier?.TagName;
    if (id && /DefinitionAsset$/.test(e.Type)) idByPkg.set(e.Package, id);
  }
}

// ─────────────────────────────────────────────────────────── icons

const iconIndex = read(path.join(ICONS, 'index.json'));
const iconRefs = []; // [object, key, texture]
const allTableObjects = []; // effect and doctrine records, which may be dropped before the icons are copied
/** Remembers which texture an object's icon is; file names are assigned once all are known. */
function setIcon(obj, key, iconRef, owner) {
  const tex = iconRef?.ObjectPath ? iconRef.ObjectPath.replace(/\.\d+$/, '') : null;
  obj[key] = null;
  if (!tex) { nul(owner, key, 'the asset has no Icon'); return; }
  // A texture the game itself names a placeholder is not a picture of the thing.
  if (/placeholder/i.test(shortName(tex))) { nul(owner, key, `the asset points at the placeholder texture ${shortName(tex)}`); return; }
  if (!iconIndex[tex] || !fs.existsSync(path.join(ICONS, iconIndex[tex].file))) {
    nul(owner, key, `texture ${tex} not exported (trdump png @icons)`);
    return;
  }
  iconRefs.push([obj, key, tex]);
}

// ─────────────────────────────────────────────────────────── shared tables

/** Passive abilities shown as effects and auras, keyed by asset name (PA_Marking). */
const effects = {};
function effectKey(ref, owner) {
  const pkg = refPkg(ref);
  if (!pkg) return null;
  const key = shortName(pkg);
  if (!(key in effects)) {
    const exps = loadPkg(pkg);
    const p = exps?.find((e) => e.Properties?.DisplayName || e.Properties?.AssetIdentifier)?.Properties;
    if (!p) {
      effects[key] = null;
      report.excluded.push({ id: key, reason: exps ? 'passive ability without properties' : `package not exported: ${pkg}` });
    } else {
      const name = bilingual(p.DisplayName, key, 'name');
      if (!name.en) {
        effects[key] = null;
        report.excluded.push({ id: key, reason: 'passive ability without a DisplayName: the game shows no name for it' });
      } else {
        effects[key] = { id: p.AssetIdentifier?.TagName ?? null, name, desc: bilingual(p.Description, key, 'desc') };
        allTableObjects.push(effects[key]);
        setIcon(effects[key], 'icon', p.Icon, key);
      }
    }
  }
  if (!effects[key]) note('effect-skipped', `${owner}: ${key}`);
  return effects[key] ? key : null;
}

// ─────────────────────────────────────────────────────────── damage types

const damageTypes = new Map();
function damageType(ref, owner) {
  const pkg = refPkg(ref);
  if (!pkg) return null;
  if (!damageTypes.has(pkg)) {
    if (!loadPkg(pkg)) {
      damageTypes.set(pkg, null);
      nul(owner, 'type', `damage type ${shortName(pkg)} not exported (trdump json objrefs:DamageType@definitions)`);
    } else {
      const name = bilingual(cdoValue(pkg, 'DisplayName'), shortName(pkg), 'name');
      const ignores = cdoValue(pkg, 'bIgnoresResistances') === true;
      const attr = cdoValue(pkg, 'RelevantResistAttribute')?.AttributeName ?? null;
      damageTypes.set(pkg, { asset: shortName(pkg), name, armor: ignores ? null : RESIST_TO_ARMOR[attr] ?? null, ignoresArmor: ignores, attribute: attr });
    }
  }
  return damageTypes.get(pkg);
}

// ─────────────────────────────────────────────────────────── entities

const stats = read(STATS);
const rawDef = (asset, id) => {
  const exps = read(path.join(JSON_ROOT, asset));
  return (exps.find((e) => e.Properties?.AssetIdentifier?.TagName === id) ?? exps[0]).Properties;
};

const FACTION_OF_AFFILIATION = { 'ETedFaction::GDF': 'GDF', 'ETedFaction::DYN': 'Dynasty', 'ETedFaction::Veti': 'Veti', 'ETedFaction::Civilian': 'Neutral' };
const FACTION_OF_ID = { GDF: 'GDF', DYN: 'Dynasty', VETI: 'Veti', CIV: 'Neutral', Neutral: 'Neutral' };
const KIND_OF_CLASS = { Unit: 'unit', Structure: 'structure', Destructible: 'destructible', Entity: null };

const entities = []; // { e, p, unit }
for (const e of stats) {
  const p = rawDef(e.asset, e.id);
  const owner = e.id;
  const name = bilingual(p.DisplayName, owner, 'name');
  if (!name.en) {
    report.excluded.push({ id: e.id, reason: 'no DisplayName: the game shows no name for it (construction sites, unused definitions)' });
    continue;
  }
  entities.push({ e, p, owner, name });
}
const entityById = new Map(entities.map((x) => [x.e.id, x]));

// Unit identifier on the site: the AssetIdentifier without the common "Definition." prefix.
const siteId = (id) => id.replace(/^Definition\./, '');

// ── economy: what the game marks as a worker or a harvester, and what only produces them
const isWorker = (x) => (x.p.OwnedTags ?? []).includes('PlayerData.Entity.Tag.Worker')
  || /TedNavFilter_Harvester/.test(x.p.DefaultNavFilterClass?.ObjectName ?? '')
  || x.p.FactoryTab?.TagName === 'PlayerData.FactoryType.PawnSpecific.Refinery';
const economy = new Set(entities.filter(isWorker).map((x) => x.e.id));
const pawnOf = new Map(entities.map((x) => [refPkg(x.p.PawnClass), x.e.id]));
for (let pass = 0; pass < 3; pass++) {
  for (const x of entities) {
    if (economy.has(x.e.id)) continue;
    const spawns = (x.p.ConstructionAutoSpawnUnits ?? []).map((r) => pawnOf.get(refPkg(r))).filter(Boolean);
    const produces = x.p.ProducedUnitsIds ?? [];
    if ((spawns.length && spawns.every((id) => economy.has(id))) || (produces.length && produces.every((id) => economy.has(id)))) economy.add(x.e.id);
  }
}

// ── produced by: the factories' own production lists
const producedBy = new Map();
for (const x of entities) {
  for (const id of [...(x.p.ProducedUnitsIds ?? []), ...(x.p.ProducedStructuresIds ?? [])]) {
    if (!producedBy.has(id)) producedBy.set(id, []);
    producedBy.get(id).push(siteId(x.e.id));
  }
}

// ── requirements: Prerequisites.Definitions (asset references) and .Tags. A tag is the
// AssetIdentifier of an entity, an entity's own tech tag (TechTag_OLD / OwnedTags), or a tag an
// upgrade adds (TedUpgrade AddedOwnedTags): the requirement is then the definition the upgrade
// turns the structure into (NewDefinitionId), or, without one, the structure whose upgrade
// command researches it.
const byTag = new Map();
const addTag = (tag, req) => {
  if (!tag) return;
  if (!byTag.has(tag)) byTag.set(tag, []);
  if (!byTag.get(tag).some((r) => r.id === req.id && r.upgrade?.en === req.upgrade?.en)) byTag.get(tag).push(req);
};
for (const x of entities) {
  addTag(x.e.id, { id: siteId(x.e.id) });
  for (const t of [x.p.TechTag_OLD?.TagName, ...(x.p.OwnedTags ?? [])]) addTag(t, { id: siteId(x.e.id) });
}
const upgrades = new Map(); // upgrade package → { newId, tags, title }
for (const p of walk(path.join(JSON_ROOT, 'Tempest/Content/Tempest/DataAssets/Upgrades'))) {
  for (const e of read(p).filter((x) => x.Type === 'TedUpgrade')) {
    const procs = (e.Properties?.UpgradeProcessors ?? []).filter(Boolean);
    upgrades.set(e.Package, {
      newId: procs.find((q) => q.NewDefinitionId)?.NewDefinitionId?.TagName ?? null,
      tags: procs.flatMap((q) => q.AddedOwnedTags ?? []),
      title: bilingual(e.Properties.Title, shortName(e.Package), 'name'),
    });
  }
}
for (const u of upgrades.values()) if (u.newId && entityById.has(u.newId)) for (const t of u.tags) addTag(t, { id: siteId(u.newId) });
for (const x of entities) {
  for (const r of x.p.SupportedCommands ?? []) {
    const pkg = refPkg(r);
    if (!pkg?.startsWith('/Game/') || !loadPkg(pkg)) continue;
    const up = upgrades.get(refPkg(cdoValue(pkg, 'ResearchedUpgrade')));
    if (up && !(up.newId && entityById.has(up.newId))) for (const t of up.tags) addTag(t, { id: siteId(x.e.id), upgrade: up.title });
  }
}
/**
 * Requirements as groups of alternatives: every group must be met, by any one of its
 * entries ({ id } or { id, upgrade }). Several entries appear when several entities provide
 * the required tag (an upgraded structure, or an MCV upgraded the same way).
 */
function requirements(x) {
  const pre = x.p.Prerequisites;
  if (!pre) return [];
  const out = [];
  const same = (a, b) => a.length === b.length && a.every((r, i) => r.id === b[i].id && r.upgrade?.en === b[i].upgrade?.en);
  const push = (group) => { if (group.length && !out.some((g) => same(g, group))) out.push(group); };
  for (const r of pre.Definitions ?? []) {
    const id = idByPkg.get(refPkg(r));
    if (id && entityById.has(id)) push([{ id: siteId(id) }]);
    else nul(x.owner, 'requires', `prerequisite ${shortName(refPkg(r))} is not an entity of the multiplayer set`);
  }
  for (const tag of pre.Tags ?? []) {
    const reqs = byTag.get(tag) ?? [];
    if (reqs.length) push(reqs);
    else nul(x.owner, 'requires', `nothing in the multiplayer set provides the prerequisite tag ${tag}`);
  }
  return out;
}

// ── abilities: the unit's own commands (SupportedCommands) the game shows in its unit-specific
// or upgrade section of the command card. Generic orders (move, stop…) are the Common section.
const SHOWN_SECTIONS = ['ETedCommandDisplaySection::PawnSpecific', 'ETedCommandDisplaySection::Upgrade'];
const unsectioned = new Set();
function abilities(x) {
  const out = [];
  for (const r of x.p.SupportedCommands ?? []) {
    const pkg = refPkg(r);
    if (!pkg?.startsWith('/Game/')) { note('native-command', `${x.e.id}: ${r.ObjectName} is a native class without blueprint data`); continue; }
    if (!loadPkg(pkg)) { nul(x.owner, 'abilities', `command ${shortName(pkg)} not exported (trdump json @commands)`); continue; }
    const section = cdoValue(pkg, 'DisplaySection');
    if (section === undefined) { unsectioned.add(shortName(pkg)); continue; }
    if (!SHOWN_SECTIONS.includes(section)) continue;
    const key = shortName(pkg);
    const name = bilingual(cdoValue(pkg, 'Name'), key, 'name');
    if (!name.en) { report.excluded.push({ id: `${x.e.id} / ${key}`, reason: 'command without a Name' }); continue; }
    const cooldown = cdoValue(pkg, 'CooldownDuration')?.FixedValue;
    // Every resource a command can cost. A value is either fixed ({FixedValue}) or
    // computed at runtime by a calculation class — then it is "variable", not a number.
    const costs = {};
    for (const [field, resource] of [['CreditCost', 'credits'], ['IntelCost', 'intel'], ['PowerCost', 'power'],
      ['PopulationCost', 'population'], ['GarrisonedEnlightenedCost', 'enlightened']]) {
      const v = cdoValue(pkg, field);
      if (v === undefined) continue;
      if (typeof v.FixedValue === 'number') { if (v.FixedValue !== 0) costs[resource] = v.FixedValue; }
      else if (/CalculationBased/.test(v.ValueType ?? '')) {
        costs[resource] = 'variable';
        note('variable-cost', `${x.e.id} / ${key}: ${field} is computed at runtime (${v.ValueType})`);
      }
    }
    const ability = {
      id: key, name: name.en, nameRu: name.ru, desc: null, descRu: null,
      cooldown: typeof cooldown === 'number' && cooldown > 0 ? cooldown : null,
      ...(Object.keys(costs).length ? { costs } : {}),
      upgrade: section === 'ETedCommandDisplaySection::Upgrade',
    };
    const desc = bilingual(cdoValue(pkg, 'Description'), key, 'desc');
    ability.desc = desc.en;
    ability.descRu = desc.ru;
    setIcon(ability, 'icon', cdoValue(pkg, 'Icon'), `${x.e.id} / ${key}`);
    out.push(ability);
  }
  return out;
}

// ── weapons
const ammoOf = (w) => (w.ammo?.AmmoCountMax > 0 ? w.ammo : null);
function weaponOf(x, w, slot) {
  const owner = `${x.e.id} / ${w.id}`;
  const p = rawDef(w.asset, w.id);
  const dt = damageType(p.DamageType, owner);
  // stats-mp.json carries the effective values: stored, else the verified native default
  // (w.defaults: definition field -> source)
  const kind = w.damageKind;
  const missing = {};
  const why = (field, reason) => { missing[field] = reason; nul(owner, field, reason); };
  const fromDefault = (field, defField, value) => {
    const src = w.defaults?.[defField];
    if (src && value != null) filled(owner, field, value, src);
    return src ?? null;
  };
  const radial = kind === 'Radial' ? w.radial ?? {} : null;
  const coneP = kind === 'Cone' ? w.cone ?? {} : null;

  // Damage per hit: the parameters the weapon's DamageKind selects (Point: DamageAmount).
  let damage = null;
  let damageSource = null;
  if (kind === 'Radial') { damage = radial.BaseDamage ?? null; damageSource = 'RadialDamageParams.BaseDamage'; }
  else if (kind === 'Cone') { damage = coneP.BaseDamage ?? null; damageSource = 'ConeDamageParams.BaseDamage'; }
  else { damage = w.damage ?? null; damageSource = 'DamageAmount'; }
  if (damage == null) why('damage', `${damageSource} is not set (DamageKind ${kind ?? 'unknown'})`);
  else fromDefault('damage', damageSource, damage);

  const hits = w.hitsPerAttack ?? null;
  if (hits == null) {
    const s = w.hitsPerAttackSource ?? {};
    why('shots', s.error ?? (s.flags?.length ? `attack montage gives no single count: ${s.flags.join(', ')}` : 'unknown'));
  }
  const fake = Boolean(w.fake);
  const utility = fake || !damage;
  const ammo = ammoOf(w);
  const targets = w.targets ? w.targets.map((t) => t.toLowerCase()) : null;
  if (!targets) why('targets', 'TargetingDomains is not set in the weapon definition and its native default is unavailable');
  else fromDefault('targets', 'TargetingDomains', targets);
  fromDefault('speed', 'AttackCooldown', w.cooldown);
  fromDefault('range', 'AttackRange', w.range);
  if (radial) {
    fromDefault('aoe', 'RadialDamageParams.OuterRadius', radial.OuterRadius);
    fromDefault('aoeInner', 'RadialDamageParams.InnerRadius', radial.InnerRadius);
    fromDefault('minDamage', 'RadialDamageParams.MinimumDamage', radial.MinimumDamage);
  }
  if (coneP) fromDefault('minDamage', 'ConeDamageParams.MinimumDamage', coneP.MinimumDamage);
  if (ammo) for (const k of ['AmmoCountUse', 'AmmoRechargeTime', 'AmmoCountPerRecharge']) fromDefault(`ammo.${k}`, k, ammo[k]);
  if (!dt) why('type', 'the weapon definition has no DamageType');

  const name = bilingual(p.DisplayName, owner, 'name');
  const weapon = {
    slot,
    id: siteId(w.id),
    name: { mp: name.en ?? null },
    nameRu: name.ru ?? null,
    type: dt?.name.en ? { mp: dt.name.en } : {},
    typeRu: dt?.name.ru ?? null,
    armorKey: dt ? dt.armor : null,
    damage: damage != null ? { mp: damage } : {},
    damageSource,
    shots: hits != null ? { mp: hits } : {},
    // A count was found, but the attack montage leaves room for doubt (e.g. a hit
    // lands after the next attack may already start). Kept, and shown as uncertain.
    ...(hits != null && w.hitsPerAttackSource?.flags?.length ? { shotsDoubt: w.hitsPerAttackSource.flags } : {}),
    damagePerVolley: damage != null && hits != null ? { mp: +(damage * hits).toFixed(4) } : {},
    speed: w.cooldown != null ? { mp: w.cooldown } : {},
    range: w.range != null ? { mp: w.range } : {},
    aoe: radial?.OuterRadius != null ? { mp: radial.OuterRadius } : {},
    aoeInner: radial?.InnerRadius ?? null,
    minDamage: (radial ?? coneP)?.MinimumDamage ?? null,
    cone: coneP ? { length: coneP.MaxLength ?? null, angle: coneP.Angle ?? null } : null,
    ammo: ammo ? { mp: ammo.AmmoCountMax } : {},
    ammoUse: ammo?.AmmoCountUse ?? null,
    recharge: ammo && ammo.AmmoRechargeTime ? { mp: { time: ammo.AmmoRechargeTime, ...(ammo.AmmoCountPerRecharge ? { perRecharge: ammo.AmmoCountPerRecharge } : {}) } } : {},
    targets: targets ? { mp: targets } : {},
    effects: (p.PassivieAbilityDefinitions ?? []).map((r) => effectKey(r, owner)).filter(Boolean),
    utility,
    ...(fake ? { fake: true } : {}),
    missing,
  };
  if (w.cooldown == null && !utility) why('speed', 'AttackCooldown is not set and its native default is unavailable');
  // which shown values come from a native class default rather than the definition
  const fromNative = Object.keys(w.defaults ?? {}).filter((k) => /^(DamageAmount|AttackCooldown|AttackRange|TargetingDomains|RadialDamageParams\.|ConeDamageParams\.|Ammo)/.test(k));
  if (fromNative.length) weapon.nativeDefaults = fromNative;
  if (!name.en) why('name', 'the weapon definition has no DisplayName');
  if (kind !== 'Radial' && w.radial?.OuterRadius != null) note('radial-params-unused', `${owner}: RadialDamageParams set but DamageKind is ${kind ?? 'unset'}, so no AoE is shown`);
  if (dt && damage != null && dt.armor == null && !dt.ignoresArmor) note('damage-type-without-armor', `${owner}: ${dt.asset} has neither a resistance attribute nor bIgnoresResistances`);
  return weapon;
}

// ── doctrines: every doctrine of the faction doctrine trees, and the definitions its
// upgrade processors (and the explicit queries of its extended descriptions) select
const doctrines = {};
const doctrineRules = []; // { key, type, tags, exact, blacklist, conditions }
const ENTITY_TYPES = ['TedUnitDefinitionAsset', 'TedStructureDefinitionAsset', 'TedDestructibleDefinitionAsset', 'TedEntityDefinitionAsset'];
let skippedProcessors = 0;
for (const f of walk(path.join(JSON_ROOT, DOCTRINE_DIR))) {
  for (const tree of read(f).filter((e) => e.Type === 'TedDoctrineTreeDefinition')) {
    for (const r of tree.Properties?.Doctrines ?? []) {
      const pkg = refPkg(r);
      const key = shortName(pkg);
      if (doctrines[key] !== undefined) continue;
      const d = loadPkg(pkg)?.find((e) => e.Type === 'TedDoctrineDefinition')?.Properties;
      if (!d) { report.excluded.push({ id: key, reason: `doctrine package not exported: ${pkg}` }); continue; }
      const name = bilingual(d.Title, key, 'name');
      if (!name.en) { report.excluded.push({ id: key, reason: 'doctrine without a Title' }); continue; }
      doctrines[key] = { name, desc: bilingual(d.Description, key, 'desc'), tier: d.DoctrineTier ?? null, tree: bilingual(tree.Properties.Title, shortName(tree.Package), 'name').en };
      allTableObjects.push(doctrines[key]);
      setIcon(doctrines[key], 'icon', d.Icon, key);
      (d.UpgradeProcessors ?? []).forEach((proc, i) => {
        const tags = proc.DefinitionIdsFilter?.AllowedTags ?? [];
        if (!tags.length || proc.Condition) { skippedProcessors++; if (proc.Condition) note('doctrine-condition', `${key} processor ${i}: custom Condition object, not evaluated`); return; }
        doctrineRules.push({
          key, where: `processor ${i}`,
          type: proc.DefinitionType?.ObjectName?.match(/'(.+)'/)?.[1] ?? null,
          tags, exact: proc.DefinitionIdsFilter?.bExactMatch === true,
          blacklist: proc.DefinitionIdsFilter?.BlacklistedTags ?? [],
          conditions: proc.Conditions?.PropertyConditions ?? [],
          any: /Any$/.test(proc.Conditions?.PropertyConditionsRequirements ?? ''),
        });
      });
      for (const ext of d.ExtendedDescriptions ?? []) {
        for (const q of ext.CustomDefinitionQueries ?? []) {
          for (const flt of q.Filters?.length ? q.Filters : [null]) {
            doctrineRules.push({
              key, where: 'extended description',
              type: flt?.DefinitionType?.ObjectName?.match(/'(.+)'/)?.[1] ?? null,
              tags: q.DefinitionIds ?? [], exact: q.bExactMatch === true, blacklist: [],
              conditions: flt?.DefinitionConditions?.PropertyConditions ?? [],
              any: /Any$/.test(flt?.DefinitionConditions?.PropertyConditionsRequirements ?? ''),
            });
          }
        }
      }
    }
  }
}
// AoE configs (comms fields, healing zones…): the doctrine conditions read their properties.
const aoeProps = new Map();
for (const p of walk(path.join(JSON_ROOT, 'Tempest/Content/Tempest/Blueprints/Ability/GameplayEffects/AoEConfigs'))) {
  for (const e of read(p)) if (e.Properties?.AssetIdentifier?.TagName) aoeProps.set(e.Properties.AssetIdentifier.TagName, e.Properties);
}
/** A doctrine property condition evaluated on a definition; undefined when it cannot be evaluated. */
function conditionHolds(cond, props) {
  const op = cond.ConditionOp ?? '';
  if (!/(ContainsAny|Equal)$/.test(op)) return undefined;
  const value = props[cond.PropertyData?.PropertyName];
  const wanted = cond.PropertyData?.ValueString ?? '';
  const paths = [...wanted.matchAll(/(\/Game\/[^'"\s)]+)/g)].map((m) => refPkg(m[1]));
  const tags = [...wanted.matchAll(/TagName="([^"]+)"/g)].map((m) => m[1]);
  const have = Array.isArray(value) ? value : value != null ? [value] : [];
  const key = (v) => (typeof v === 'string' ? (v.startsWith('/Game/') ? refPkg(v) : v) : refPkg(v) ?? v?.TagName);
  if (!paths.length && !tags.length) return undefined;
  const wantedKeys = [...paths, ...tags];
  if (/Equal$/.test(op)) return have.length === 1 && wantedKeys.includes(key(have[0]));
  return have.some((v) => wantedKeys.includes(key(v)));
}
function ruleMatches(rule, id, defType, props) {
  if (rule.type && rule.type !== defType && !(rule.type === 'TedEntityDefinitionAsset' && ENTITY_TYPES.includes(defType))) return false;
  if (!rule.tags.some((t) => tagMatches(id, t, rule.exact))) return false;
  if (rule.blacklist.some((t) => tagMatches(id, t, false))) return false;
  if (!rule.conditions.length) return true;
  const results = rule.conditions.map((c) => conditionHolds(c, props));
  if (results.includes(undefined)) { note('doctrine-condition', `${rule.key} ${rule.where}: condition operator not evaluated for ${id}`); return false; }
  return rule.any ? results.some(Boolean) : results.every(Boolean);
}
function doctrinesOf(x) {
  const out = new Set();
  for (const rule of doctrineRules) {
    if (ruleMatches(rule, x.e.id, `Ted${x.e.class}DefinitionAsset`, x.p)) { out.add(rule.key); continue; }
    for (const w of x.e.weapons.filter((w) => !w.missing)) {
      if (ruleMatches(rule, w.id, 'TedWeaponDefinitionAsset', rawDef(w.asset, w.id))) { out.add(rule.key); break; }
    }
    if (out.has(rule.key)) continue;
    // AoE configs (comms fields, healing zones…) belong to the entities that provide them.
    for (const aoe of x.p.ProvidedEffectsTags ?? []) {
      if (ruleMatches(rule, aoe, 'TedAoEConfigAsset', aoeProps.get(aoe) ?? {})) { out.add(rule.key); break; }
    }
  }
  return [...out].sort();
}

// ─────────────────────────────────────────────────────────── build

const units = [];
for (const x of entities) {
  const { e, p, owner, name } = x;
  const tags = p.OwnedTags ?? [];
  // Affiliation as stored, else the verified native default (ETedFaction::GDF). Consistent with
  // the data: the "stolen plans" Dynasty units GDF builds store none, while their GDF
  // counterparts that Dynasty builds store ETedFaction::DYN.
  const affiliation = e.affiliation ?? null;
  let faction = FACTION_OF_AFFILIATION[affiliation] ?? null;
  if (faction && e.defaults?.Affiliation) note('faction-from-native-default', `${e.id}: Affiliation not stored, native default ${affiliation}`);
  if (!faction) {
    faction = FACTION_OF_ID[e.id.split('.')[1]] ?? null;
    note('faction-from-identifier', `${e.id}: Affiliation ${affiliation ?? 'unknown'}, faction taken from the AssetIdentifier`);
  }
  if (!faction) nul(owner, 'faction', 'neither Affiliation nor the AssetIdentifier names a faction');
  const unitClass = unitClassFromTags(tags);
  if (!unitClass) nul(owner, 'unitClass', 'the definition has no PawnType tag');

  // Buildable: a factory of the multiplayer set lists it, or an upgrade turns a structure into it.
  // Otherwise its Cost / ConstructionTime are never charged (mines, crates, map buildings, spawns).
  const buildable = producedBy.has(e.id) || [...upgrades.values()].some((u) => u.newId === e.id);
  const nativeSources = {};
  const stat = (field, value, prop) => {
    const src = e.defaults?.[prop];
    const na = e.notApplicable?.[prop] ? `not applicable: ${e.notApplicable[prop]}`
      : src && (field === 'cost' || field === 'buildTime') && !buildable
        ? `not applicable: not buildable (no factory of the multiplayer set lists it in ProducedUnitsIds / ProducedStructuresIds and no upgrade turns into it); ${prop} is not stored in the definition`
        : null;
    if (na) { notApplicable(owner, `stats.${field}`, na); return {}; }
    if (value == null) { nul(owner, `stats.${field}`, `${prop} is not set in the definition and its native default is unavailable`); return {}; }
    if (src) { filled(owner, `stats.${field}`, value, src); nativeSources[field] = src; }
    return { mp: value };
  };
  // armor: resistances as stored, else the native default (0), from stats-mp.json
  const armor = { ...e.armor };

  // Armor class: the entity-type passive the game shows on the unit (Light Vehicle, Heavy Infantry…).
  const classKey = p.EntityTypePassivieAbilityDefinition ? effectKey(p.EntityTypePassivieAbilityDefinition, owner) : null;
  const armorClass = classKey ? effects[classKey].name : null;

  let slot = 0;
  const weapons = e.weapons.filter((w) => {
    if (w.missing) nul(owner, 'weapons', `weapon class ${w.missing} has no definition in the multiplayer set`);
    return !w.missing;
  }).map((w) => weaponOf(x, w, ++slot));

  const unit = {
    id: siteId(e.id),
    gameId: e.id,
    faction,
    kind: KIND_OF_CLASS[e.class] ?? (unitClass === 'structure' || unitClass === 'superweapon' ? 'structure' : unitClass === 'destructible' ? 'destructible' : 'unit'),
    unitClass,
    name: name.en,
    nameRu: name.ru,
    tier: null,
    armorType: armorClass?.en ?? null,
    armorTypeRu: armorClass?.ru ?? null,
    armorClass: classKey,
    isSuperweapon: unitClass === 'superweapon',
    economy: economy.has(e.id),
    inCodex: p.bIgnoreForCodex !== true,
    stats: {
      hp: stat('hp', e.hp, 'Health'),
      cost: stat('cost', e.cost, 'Cost'),
      // Intel, the second resource (GDF): IntelCost; 0 = paid in credits only
      intelCost: stat('intelCost', e.intelCost, 'IntelCost'),
      // GDF foundation: paid up front when the construction site is placed.
      ...(e.foundationCost > 0 ? { foundationCost: { mp: e.foundationCost } } : {}),
      buildTime: stat('buildTime', e.buildTime, 'ConstructionTime'),
      population: stat('population', e.population, 'PopulationCost'),
      speed: stat('speed', e.speed, 'MovementSpeed'),
      sight: stat('sight', e.sight, 'VisionRadius'),
      ...(e.power != null ? { power: { mp: e.power } } : {}),
      ...(e.intelKill != null ? { intelKill: { mp: e.intelKill } } : {}),
    },
    armor: { mp: armor },
    weapons,
    unitEffects: (p.PassivieAbilityDefinitions ?? []).map((r) => effectKey(r, owner)).filter(Boolean).map((k) => ({ base: k })),
    doctrines: doctrinesOf(x),
    abilitiesDetails: abilities(x),
    producedBy: producedBy.get(e.id) ?? [],
    requires: requirements(x),
  };
  setIcon(unit, 'icon', p.Icon, owner);
  // Reasons for the values the page shows as "—" or "?", keyed by field.
  unit.missing = Object.fromEntries(report.nulls.filter((n) => n.entity === owner && n.field.startsWith('stats.')).map((n) => [n.field.slice(6), n.reason]));
  // values that do not apply to this entity: shown as "—" without implying missing data
  const na = Object.fromEntries(report.notApplicable.filter((n) => n.entity === owner && n.field.startsWith('stats.')).map((n) => [n.field.slice(6), n.reason]));
  if (Object.keys(na).length) unit.notApplicable = na;
  // shown stats the definition does not store, taken from the native class default
  if (Object.keys(nativeSources).length) unit.nativeDefaults = Object.keys(nativeSources);
  units.push(unit);
}
nul('*', 'tier', 'the game files define no unit tier: availability comes from Prerequisites (shown as "Requires") and the factories\' production lists (shown as "Produced at")');

// Drop the effects nobody references any more (e.g. armor-class passives skipped above) and nulls.
for (const k of Object.keys(effects)) if (!effects[k]) delete effects[k];
for (const k of Object.keys(doctrines)) if (!units.some((u) => u.doctrines.includes(k))) delete doctrines[k];
// Icons only for what is still in the data.
const liveTables = new Set([...Object.values(effects), ...Object.values(doctrines)]);
const tableObjects = new Set([...allTableObjects]);
for (let i = iconRefs.length - 1; i >= 0; i--) if (tableObjects.has(iconRefs[i][0]) && !liveTables.has(iconRefs[i][0])) iconRefs.splice(i, 1);

units.sort((a, b) => a.faction.localeCompare(b.faction) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

// ─────────────────────────────────────────────────────────── icons → files

const used = [...new Set(iconRefs.map(([, , t]) => t))];
const baseCount = new Map();
for (const t of used) baseCount.set(shortName(t), (baseCount.get(shortName(t)) ?? 0) + 1);
const fileOf = (t) => (baseCount.get(shortName(t)) > 1 ? t.split('/').slice(-2).join('_') : shortName(t)) + '.png';
for (const [obj, key, tex] of iconRefs) obj[key] = fileOf(tex);
fs.mkdirSync(WEB_ICONS, { recursive: true });
const keep = new Set(used.map(fileOf));
for (const f of fs.readdirSync(WEB_ICONS)) if (f.endsWith('.png') && !keep.has(f)) fs.unlinkSync(path.join(WEB_ICONS, f));
let bytes = 0;
for (const t of used) {
  const dst = path.join(WEB_ICONS, fileOf(t));
  fs.copyFileSync(path.join(ICONS, iconIndex[t].file), dst);
  bytes += fs.statSync(dst).size;
}

// ─────────────────────────────────────────────────────────── write

const count = (list, key) => list.reduce((o, x) => ((o[key(x)] = (o[key(x)] ?? 0) + 1), o), {});
const allWeapons = units.flatMap((u) => u.weapons.map((w) => ({ u, w })));
const armed = allWeapons.filter(({ w }) => !w.utility);
const meta = {
  source: 'Tempest Rising game files (multiplayer definition collection DefinitionCollection_Base_MP), built by extractor/build-site-data.mjs',
  generatedAt: new Date().toISOString(),
  entities: units.length,
  armedWeapons: armed.length,
  icons: keep.size,
};
const doc = { meta, units, effects, doctrines };
fs.writeFileSync(path.join(DATA, 'units.json'), JSON.stringify(doc, null, 1) + '\n', 'utf8');

const nullHits = armed.filter(({ w }) => w.shots.mp == null);
const fullReport = {
  meta: { generatedAt: meta.generatedAt, source: meta.source },
  counts: {
    entities: units.length,
    byFaction: count(units, (u) => u.faction),
    byFactionKind: count(units, (u) => `${u.faction} ${u.kind}`),
    hiddenByDefault: units.filter((u) => u.economy || !u.inCodex || u.kind === 'destructible' || !['GDF', 'Dynasty', 'Veti'].includes(u.faction)).length,
    weapons: allWeapons.length,
    armedWeapons: armed.length,
    armedWeaponsWithoutHits: nullHits.length,
    effects: Object.keys(effects).length,
    doctrines: Object.keys(doctrines).length,
    abilities: units.reduce((s, u) => s + u.abilitiesDetails.length, 0),
    icons: keep.size,
    iconBytes: bytes,
    placeholders: report.placeholders.length,
    excluded: report.excluded.length,
    doctrineProcessorsWithoutTargets: skippedProcessors,
    nullsByField: count(report.nulls, (n) => n.field),
    filledByField: count(report.filled, (n) => n.field),
    notApplicableByField: count(report.notApplicable, (n) => n.field),
  },
  // Native class defaults: where the filled values come from and how they were verified.
  nativeDefaults: nativeCheck?.ok ? {
    method: 'Cooked packages store only the properties that differ from the class default object, so a field a definition does not store has the value the C++ constructor of its class sets. extractor/nativedefaults reads those constructors from the exe (reflection tables give each property\'s offset; StaticClass -> GetPrivateStaticClassBody -> InternalConstructor -> constructor; the constructor\'s stores to `this` are executed symbolically, conditional stores are not trusted).',
    verification: [
      `engine: ${nativeCheck.engineCheck.what} -> MinimumDamage ${nativeCheck.engineCheck.MinimumDamage}, DamageFalloff ${nativeCheck.engineCheck.DamageFalloff}: ${nativeCheck.engineCheck.passed ? 'passed' : 'FAILED'}`,
      `data: a native default can never be stored explicitly (the cooker drops values equal to it). ${nativeCheck.totals.fields} class fields checked against ${nativeCheck.totals.storedValues} stored values of every exported definition asset of the same class: ${nativeCheck.totals.collisions} collisions${nativeCheck.totals.rejected.length ? `; rejected: ${nativeCheck.totals.rejected.join(', ')}` : ''}`,
    ],
    exe: nativeCheck.exe,
    usedFields: Object.fromEntries(Object.entries(nativeCheck.classes).map(([cls, fields]) => [cls, Object.fromEntries(
      ['Health', 'Cost', 'IntelCost', 'ConstructionTime', 'PopulationCost', 'MovementSpeed', 'VisionRadius', 'Affiliation', 'AttackCooldown', 'AttackRange', 'DamageAmount', 'DamageKind', 'TargetingDomains', 'bDealsInstantDamage', 'RadialDamageParams', 'ConeDamageParams']
        .filter((f) => fields[f]).map((f) => [f, fields[f].struct ? Object.fromEntries(Object.entries(fields[f].struct).map(([k, v]) => [k, { value: v.value, storedIn: v.stored, collisions: v.collisions }])) : { value: fields[f].value, storedIn: fields[f].stored, of: fields[f].assets, collisions: fields[f].collisions }]))])),
  } : { error: nativeCheck?.error ?? 'out/native-defaults-check.json not found (run extractor/nativedefaults, then build-stats.mjs)' },
  hitsUnknown: nullHits.map(({ u, w }) => ({ unit: u.id, weapon: w.name.mp, reason: w.missing.shots })),
  commandsWithoutDisplaySection: [...unsectioned].sort(),
  ...report,
};
fs.writeFileSync(path.join(DATA, 'build-report.json'), JSON.stringify(fullReport, null, 1) + '\n', 'utf8');

console.log(`data/units.json: ${units.length} entities (${Object.entries(fullReport.counts.byFaction).map(([k, v]) => `${k} ${v}`).join(', ')}), ${armed.length} armed weapons`);
console.log(`hits per attack unknown for ${nullHits.length} armed weapons; ${report.placeholders.length} unresolved text placeholders; ${report.excluded.length} excluded`);
console.log(`effects ${Object.keys(effects).length}, doctrines ${Object.keys(doctrines).length}, web/icons ${keep.size} files (${(bytes / 1024).toFixed(0)} KB)`);
console.log('data/build-report.json: every null with its reason');
