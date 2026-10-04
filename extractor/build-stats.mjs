#!/usr/bin/env node
// Builds flat stat tables from the CUE4Parse JSON exports produced by extractor/dump.
//
//   node extractor/build-stats.mjs [--export <dir>] [--out <dir>]
//
// --export  export folder written by trdump (default: extractor/out/export); must contain
//           json/ (@definitions, @texts, optionally @pawns) and locres/
// --out     where to write results (default: extractor/out)
// --native  native class defaults read from the exe by extractor/nativedefaults
//           (default: extractor/out/native-defaults.json)
//
// Output: stats-mp.json (multiplayer balance), stats-base.json (campaign base definitions),
// native-defaults-check.json (the native defaults and their verification against the data).
// A field a definition does not store has its class's C++ default (cooked packages omit values
// equal to it); those defaults come from native-defaults.json, are verified here and used, and
// every value filled that way is listed per entity/weapon in `defaults`.
// extractor/build-site-data.mjs turns stats-mp.json into the site's data/units.json.
// Zero dependencies; Node 18+.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeDefaults, effective, effectiveStruct, effectiveTags, hasProperty } from './lib/native-defaults.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) o[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) o[a.slice(2)] = argv[++i];
    else o[a.slice(2)] = true;
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
const EXPORT = path.resolve(args.export ?? path.join(HERE, 'out', 'export'));
const OUT = path.resolve(args.out ?? path.join(HERE, 'out'));
const NATIVE = path.resolve(args.native ?? path.join(HERE, 'out', 'native-defaults.json'));
const JSON_ROOT = path.join(EXPORT, 'json');
const LOC_ROOT = path.join(EXPORT, 'locres');
const DEF_DIR = 'Tempest/Content/Tempest/DataAssets/Definitions';

for (const p of [path.join(JSON_ROOT, DEF_DIR), LOC_ROOT]) {
  if (!fs.existsSync(p)) {
    console.error(`missing ${p}\nrun the dump first (see extractor/README.md) or pass --export <dir>`);
    process.exit(1);
  }
}
fs.mkdirSync(OUT, { recursive: true });

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out); else if (f.endsWith('.json')) out.push(p);
  }
  return out;
}

// ---------- localization: namespace -> key -> text, per language
const loc = { en: {}, ru: {} };
for (const g of fs.readdirSync(LOC_ROOT)) {
  for (const lang of ['en', 'ru']) {
    const p = path.join(LOC_ROOT, g, lang, `${g}.json`);
    if (!fs.existsSync(p)) continue;
    for (const [ns, entries] of Object.entries(read(p))) Object.assign(loc[lang][ns] ??= {}, entries);
  }
}
// string table asset path -> its namespace
const tableNs = {};
for (const p of walk(path.join(JSON_ROOT, 'Tempest/Content/Tempest/UI/Texts'))) {
  for (const e of read(p)) if (e.Type === 'StringTable') tableNs[e.Package] = e.StringTable?.TableNamespace ?? e.Name;
}
function text(t, lang) {
  if (!t || typeof t !== 'object') return null;
  let ns = t.Namespace ?? '';
  if (t.TableId) ns = tableNs[t.TableId.split('.')[0]] ?? t.TableId.split('.').pop();
  return loc[lang][ns]?.[t.Key] ?? (lang === 'en' ? t.SourceString ?? t.LocalizedString : null) ?? null;
}

// ---------- all definition assets
const defs = []; // {pkg, file, type, props}
for (const p of walk(path.join(JSON_ROOT, DEF_DIR))) {
  for (const e of read(p)) {
    if (!/DefinitionAsset$/.test(e.Type) || !e.Properties) continue;
    defs.push({ pkg: e.Package, file: path.relative(JSON_ROOT, p).replaceAll('\\', '/'), type: e.Type, props: e.Properties });
  }
}
// ---------- native class defaults: read from the exe, verified against every stored value
const nativeCheck = verifyNativeDefaults(fs.existsSync(NATIVE) ? read(NATIVE) : null, defs);
fs.writeFileSync(path.join(OUT, 'native-defaults-check.json'), JSON.stringify(nativeCheck, null, 1));
if (!nativeCheck.ok) console.log(`note: native defaults not used: ${nativeCheck.error}`);
else console.log(`native defaults: ${nativeCheck.totals.fields} class fields checked against ${nativeCheck.totals.storedValues} stored values, ${nativeCheck.totals.collisions} collisions${nativeCheck.totals.rejected.length ? ', rejected: ' + nativeCheck.totals.rejected.join(', ') : ''}`);

const ENTITY = new Set(['TedEntityDefinitionAsset', 'TedUnitDefinitionAsset', 'TedStructureDefinitionAsset', 'TedDestructibleDefinitionAsset']);
const classOk = (type, base) => base === 'TedEntityDefinitionAsset' ? ENTITY.has(type) : type === base;

// ---------- resolve a definition collection: the highest Priority wins per AssetIdentifier
function resolveCollection(name) {
  const coll = read(path.join(JSON_ROOT, DEF_DIR, `${name}.json`))[0].Properties;
  const byId = new Map();
  for (const cfg of coll.AssetSearchConfigs) {
    const base = cfg.AssetBaseClass?.ObjectName?.match(/'(.+)'/)?.[1];
    const scan = (cfg.AssetScanPaths ?? []).map((s) => s + '/');
    const excl = cfg.ExcludePatterns ?? [];
    for (const d of defs) {
      if (!classOk(d.type, base)) continue;
      if (!scan.some((s) => d.pkg.startsWith(s))) continue;
      if (excl.some((x) => d.pkg.includes(x))) continue;
      const id = d.props.AssetIdentifier?.TagName ?? d.pkg;
      const cur = byId.get(id);
      if (!cur || cfg.Priority >= cur.prio) byId.set(id, { prio: cfg.Priority, def: d });
    }
  }
  return [...byId.values()].map((x) => x.def);
}

// "/Game/A/B/BP_X.BP_X_C" or ".../BP_X.0" -> "/Game/A/B/BP_X"
const cls = (ref) => (ref?.ObjectPath ?? ref?.AssetPathName ?? '').replace(/\.\d+$/, '').split('.')[0];
const short = (ref) => (ref?.ObjectName ?? '').match(/'(.+?)(_C)?'$/)?.[1] ?? null;
const tagOf = (v) => v?.TagName ?? null;
const RES = { GunResistance: 'rifle', RocketResistance: 'rocket', ExplosiveResistance: 'explosive', FireResistance: 'fire', SniperResistance: 'sniper', CannonResistance: 'cannon' };

// ---------- hits per attack, from attack montages (dump presets @pawns, then @montages)
// Not a weapon-definition field. The pawn/structure blueprint (PawnClass of the definition) maps
// each weapon class to its attack AnimMontage(s): WeaponAnimMontageSets[weapon class], else the
// default LocalAnimMontageSetData; both keyed by gameplay tag (AnimMontage.Attack, or
// AnimMontage.Attack.Standing / .Crawling for infantry). The montage's Notifies fire
// AnimNotify_GameplayEvent with Event.ShootProjectile (spawns a projectile) or Event.DealDamage
// (applies the weapon damage directly). A weapon with bDealsInstantDamage === false does its
// damage through projectiles, so hits = ShootProjectile notifies; otherwise (unset = native
// default, instant) its projectiles are cosmetic tracers and hits = DealDamage notifies.
// Properties not set on a blueprint's CDO are inherited from the nearest parent blueprint that sets them.
const pkgFile = (pkg) => path.join(JSON_ROOT, pkg.replace(/^\/Game\//, 'Tempest/Content/') + '.json');
const objPkg = (ref) => (ref?.ObjectPath ?? '').replace(/\.\d+$/, '') || null;
const bpCache = new Map();
function loadBp(pkg) {
  if (bpCache.has(pkg)) return bpCache.get(pkg);
  const f = pkgFile(pkg);
  let r = null;
  if (fs.existsSync(f)) {
    const a = read(f);
    const cdo = a.find((e) => e.Name?.startsWith('Default__'));
    const bgc = a.find((e) => e.Type === 'BlueprintGeneratedClass');
    const sup = objPkg(bgc?.SuperStruct ?? bgc?.Super);
    r = { props: cdo?.Properties ?? {}, parent: sup?.startsWith('/Game/') ? sup : null };
  }
  bpCache.set(pkg, r);
  return r;
}
// nearest value of a CDO property up the blueprint chain: {value, from} | {missing: pkg} | {value: undefined}
function inherited(pawnPkg, prop) {
  for (let pkg = pawnPkg, guard = 0; pkg && guard < 16; guard++) {
    const bp = loadBp(pkg);
    if (!bp) return { missing: pkg };
    if (bp.props[prop] !== undefined) return { value: bp.props[prop], from: pkg };
    pkg = bp.parent;
  }
  return { value: undefined };
}
const montageCache = new Map();
function loadMontage(pkg) {
  if (montageCache.has(pkg)) return montageCache.get(pkg);
  const f = pkgFile(pkg);
  let r = null;
  if (fs.existsSync(f)) {
    const a = read(f);
    const m = a.find((e) => e.Type === 'AnimMontage');
    const byName = new Map(a.map((e) => [e.Name, e]));
    const P = m?.Properties ?? {};
    // sections in time order; a notify belongs to the section its trigger time falls in
    const sections = (P.CompositeSections ?? []).map((x) => ({ name: x.SectionName, next: x.NextSectionName, start: x.LinkValue ?? x.SegmentBeginTime ?? 0, events: {} }))
      .sort((x, y) => x.start - y.start);
    const events = {}; const times = {}; const uncertain = [];
    for (const n of P.Notifies ?? []) {
      const name = n.Notify?.ObjectName?.match(/:([^':]+)'$/)?.[1];
      const o = name && byName.get(name);
      const tag = o?.Properties?.EventTag?.TagName;
      if (!tag || !/GameplayEvent/.test(o.Type)) continue;
      events[tag] = (events[tag] ?? 0) + 1;
      (times[tag] ??= []).push(+(n.LinkValue ?? 0).toFixed(3));
      const sec = sections.filter((x) => x.start <= (n.LinkValue ?? 0) + 1e-6).pop();
      if (sec) sec.events[tag] = (sec.events[tag] ?? 0) + 1;
      if ((n.NotifyTriggerChance ?? 1) !== 1) uncertain.push(`${tag} TriggerChance ${n.NotifyTriggerChance}`);
      if (n.NotifyFilterType && n.NotifyFilterType !== 'ENotifyFilterType::NoFiltering') uncertain.push(`${tag} ${n.NotifyFilterType}`);
    }
    // Montage playback: start at the first section and follow NextSectionName until None (the
    // montage ends). Sections on a cycle (e.g. Loop -> Loop) repeat until code jumps out of them;
    // sections off the chain only play when code jumps to them.
    const secByName = new Map(sections.map((x) => [x.name, x]));
    const chain = [];
    for (let x = sections[0]; x && !chain.includes(x); x = secByName.get(x.next)) chain.push(x);
    const last = chain.at(-1), back = last && secByName.get(last.next);
    const looping = back && chain.includes(back) ? chain.slice(chain.indexOf(back)).map((x) => x.name) : [];
    const played = {};
    if (!sections.length) Object.assign(played, events);
    for (const x of chain) if (!looping.includes(x.name)) for (const [k, v] of Object.entries(x.events)) played[k] = (played[k] ?? 0) + v;
    const offChain = sections.filter((x) => !chain.includes(x) && Object.keys(x.events).length).map((x) => x.name);
    r = { montage: pkg.split('/').pop(), path: pkg, length: P.SequenceLength ?? null, events, times, played, sections, looping, offChain, uncertain };
  }
  montageCache.set(pkg, r);
  return r;
}
const ATTACK_TAGS = ['AnimMontage.Attack', 'AnimMontage.Attack.Standing'];
const attackSet = (data) => {
  for (const t of ATTACK_TAGS) {
    const e = (data?.Data ?? []).find((x) => x.Key?.TagName === t);
    if (e) return { tag: t, montages: (e.Value?.AnimMontages ?? []).map(objPkg).filter(Boolean),
      crawling: ((data.Data.find((x) => x.Key?.TagName === 'AnimMontage.Attack.Crawling')?.Value?.AnimMontages) ?? []).map(objPkg).filter(Boolean) };
  }
  return null;
};
let montagesExported = null;
function hitsPerAttack(pawnPkg, weaponPkg, instant, cooldown) {
  const out = (hits, src) => ({ hitsPerAttack: hits, hitsPerAttackSource: src });
  if (!pawnPkg) return out(null, { error: 'definition has no PawnClass' });
  if (!fs.existsSync(pkgFile(pawnPkg))) return out(null, { error: `pawn blueprint not exported: ${pawnPkg} (dump preset @pawns)` });
  const wams = inherited(pawnPkg, 'WeaponAnimMontageSets');
  const local = inherited(pawnPkg, 'LocalAnimMontageSetData');
  if (wams.missing || local.missing) return out(null, { error: `parent blueprint not exported: ${wams.missing ?? local.missing}` });
  const entryOf = (wpkg) => (wams.value ?? []).find((s) => cls({ ObjectPath: s.Key.match(/'(.+)'/)?.[1] }) === wpkg);
  const entry = entryOf(weaponPkg);
  // The map is keyed by class. Whether the game also matches a parent weapon class (Networked
  // weapons are often children of the base weapon) lives in native code, so record it if it matters.
  let ancestor = null;
  if (!entry) for (let p = loadBp(weaponPkg)?.parent, g = 0; p && g < 8 && !ancestor; p = loadBp(p)?.parent, g++) if (entryOf(p)) ancestor = { weaponClass: p, entry: entryOf(p) };
  let set = entry && attackSet(entry.Value), mapping = 'WeaponAnimMontageSets', from = wams.from;
  if (!set) { set = attackSet(local.value); mapping = 'LocalAnimMontageSetData'; from = local.from; }
  if (!set || !set.montages.length)
    return out(null, { error: entry ? 'weapon entry and local set have no attack montage' : 'no WeaponAnimMontageSets entry and no attack montage in LocalAnimMontageSetData' });
  const eventTag = instant === false ? 'Event.ShootProjectile' : 'Event.DealDamage';
  const base = { mapping, blueprint: from, tag: set.tag, event: eventTag, instantDamage: instant ?? 'unset (native default)' };
  const analyse = (list) => list.map((p) => loadMontage(p) ?? { montage: p.split('/').pop(), path: p, missing: true });
  const ms = analyse(set.montages);
  if (ms.some((m) => m.missing)) {
    montagesExported ??= false;
    return out(null, { ...base, error: 'montage not exported (dump preset @montages)', montages: ms.map((m) => m.path) });
  }
  montagesExported = true;
  const desc = (m) => ({ montage: m.montage, path: m.path, length: m.length, count: m.played[eventTag] ?? 0, events: m.events, eventTimes: m.times,
    // a single section that loops to itself still needs its section data: its events repeat
    ...(m.sections.length > 1 || m.looping.length ? { sections: m.sections.map((x) => ({ name: x.name, next: x.next, start: x.start, events: x.events })) } : {}),
    ...(m.looping.length ? { looping: m.looping } : {}), ...(m.offChain.length ? { offChain: m.offChain } : {}), ...(m.uncertain.length ? { uncertain: m.uncertain } : {}) });
  const variants = ms.map(desc);
  const counts = [...new Set(variants.map((v) => v.count))];
  const src = { ...base, montages: variants };
  const flags = [];
  if (counts.length > 1) flags.push('variants-differ');
  if (variants.some((v) => !v.events[eventTag])) flags.push(`no ${eventTag} notify`);
  if (variants.some((v) => v.uncertain)) flags.push('conditional notify');
  // a counted event later than AttackCooldown: whether the next attack waits for the montage or
  // cuts it off is decided in native code, so the count holds only if attacks do not overlap
  if (cooldown != null && variants.some((v) => (v.eventTimes[eventTag] ?? []).some((t) => t > cooldown))) flags.push('event-after-cooldown');
  // events inside a looping section repeat for as long as the attack keeps the loop running, so
  // the montage gives no per-attack count; events in sections off the playback chain need code to jump there
  const loopHits = variants.some((v) => v.sections?.some((x) => v.looping?.includes(x.name) && x.events[eventTag]));
  if (loopHits) flags.push('looping-section');
  if (variants.some((v) => v.sections?.some((x) => v.offChain?.includes(x.name) && x.events[eventTag]))) flags.push('event-in-off-chain-section');
  if (ancestor) {
    const aset = attackSet(ancestor.entry.Value);
    const am = aset ? analyse(aset.montages) : [];
    src.parentClassEntry = { weaponClass: ancestor.weaponClass, montages: am.map((m) => (m.missing ? { montage: m.montage, missing: true } : desc(m))) };
    if (am.some((m) => !m.missing && (m.played[eventTag] ?? 0) !== counts[0])) flags.push('parent-class-entry-differs');
  }
  if (set.crawling.length) {
    const cr = analyse(set.crawling);
    src.crawling = cr.map((m) => (m.missing ? { montage: m.montage, missing: true } : desc(m)));
    if (cr.some((m) => !m.missing && (m.played[eventTag] ?? 0) !== counts[0])) flags.push('crawling-differs');
  }
  if (flags.length) src.flags = flags;
  if (counts.length > 1) src.counts = counts;
  // null instead of a number whenever the montage does not give one unambiguous count
  const sure = counts.length === 1 && counts[0] > 0 && !loopHits && !flags.includes('parent-class-entry-differs');
  return out(sure ? counts[0] : null, src);
}
// fire sockets: informational only (WeaponAimDataSetup); they do NOT give the number of shots
function fireSockets(pawnPkg, weaponPkg) {
  if (!pawnPkg) return null;
  const s = inherited(pawnPkg, 'WeaponAimDataSetup');
  if (s.missing || !s.value) return null;
  const v = s.value.find((x) => cls({ ObjectPath: x.Key.match(/'(.+)'/)?.[1] }) === weaponPkg)?.Value;
  return v && v.bUseDefaultPhysicalFireLocSocketName === false ? v.PhysicalFireLocSocketNames ?? null : null;
}

const AMMO = ['AmmoCountMax', 'AmmoCountStart', 'AmmoCountUse', 'AmmoRechargeTime', 'AmmoCountPerRecharge', 'bRechargeAmmoAutomatically', 'AmmoRechargeCutoff'];

function buildTable(collName) {
  const list = resolveCollection(collName);
  const weaponsByClass = new Map();
  for (const d of list) if (d.type === 'TedWeaponDefinitionAsset') weaponsByClass.set(cls(d.props.WeaponClass), d);
  const weapon = (d) => {
    const p = d.props;
    // effective values: stored, else the verified native default (recorded in `defaults`)
    const defaults = {};
    const eff = (field) => { const r = effective(nativeCheck, d.type, p, field); if (r.source) defaults[field] = r.source; return r.value; };
    const effS = (field) => { const r = effectiveStruct(nativeCheck, d.type, p, field); for (const [k, v] of Object.entries(r.filled)) defaults[`${field}.${k}`] = v; return r; };
    const kind = eff('DamageKind')?.split('::')[1] ?? null;
    const radial = kind === 'Radial' ? effS('RadialDamageParams').value : p.RadialDamageParams ?? null;
    const cone = kind === 'Cone' ? effS('ConeDamageParams').value : p.ConeDamageParams ?? null;
    const hasAmmo = AMMO.some((k) => p[k] != null);
    const ammo = hasAmmo ? Object.fromEntries(AMMO.map((k) => [k, eff(k)])) : null;
    const tg = effectiveTags(nativeCheck, d.type, p, 'TargetingDomains'); if (tg.source) defaults.TargetingDomains = tg.source;
    return {
      id: tagOf(p.AssetIdentifier), asset: d.file,
      name: text(p.DisplayName, 'en'), nameRu: text(p.DisplayName, 'ru'),
      desc: text(p.Description, 'en'), descRu: text(p.Description, 'ru'),
      damageType: short(p.DamageType)?.replace(/^BP_DT_/, '') ?? null,
      damage: kind === 'Point' ? eff('DamageAmount') : p.DamageAmount ?? null, cooldown: eff('AttackCooldown'), range: eff('AttackRange'),
      guardRange: eff('GuardRange'), damageKind: kind,
      radial, cone,
      // magazine fields (only for weapons that set any): stored, else the native default
      ammo,
      instantDamage: eff('bDealsInstantDamage'),
      targets: tg.value?.map((t) => t.split('.').pop()) ?? null,
      effectsOnDamage: p.EffectsToApplyOnDamage?.map(short) ?? null,
      passives: p.PassivieAbilityDefinitions?.map(short) ?? null,
      fake: eff('bFakeWeapon') ?? false,
      defaults,
    };
  };
  const entities = [];
  for (const d of list) {
    if (!ENTITY.has(d.type)) continue;
    const p = d.props;
    const pawnClass = cls(p.PawnClass) || null;
    const defaults = {};
    const notApplicable = {};
    const eff = (field) => {
      // a field the class does not have at all (e.g. MovementSpeed on structures) is not applicable
      if (hasProperty(nativeCheck, d.type, field) === false) { notApplicable[field] = `${d.type} has no ${field} property`; return null; }
      const r = effective(nativeCheck, d.type, p, field); if (r.source) defaults[field] = r.source; return r.value;
    };
    const armor = {}; for (const [k, v] of Object.entries(RES)) armor[v] = Math.round((eff(k) ?? 0) * 100);
    entities.push({
      id: tagOf(p.AssetIdentifier), asset: d.file, class: d.type.replace(/^Ted|DefinitionAsset$/g, ''),
      faction: d.pkg.match(/\/(GDF|DYN|VETI|CIV|PACT|Neutral)\//i)?.[1] ?? null,
      name: text(p.DisplayName, 'en'), nameRu: text(p.DisplayName, 'ru'),
      affiliation: eff('Affiliation'),
      hp: eff('Health'), cost: eff('Cost'), intelCost: eff('IntelCost'), buildTime: eff('ConstructionTime'),
      // GDF builds through a construction site: ConstructionSiteUpfrontCost is paid on
      // placement (the foundation), Cost is drained while it builds. Only entities that
      // have a construction site pay it — a class default must not invent one for others.
      foundationCost: p.ConstructionSite ? eff('ConstructionSiteUpfrontCost') : null,
      population: eff('PopulationCost'), power: eff('Power'), speed: eff('MovementSpeed'),
      sight: eff('VisionRadius'), reveal: eff('RevealRadius'), intelKill: eff('KillIntelValue'),
      armor, tags: p.OwnedTags ?? [],
      // fields not stored in the definition, filled with the verified native default: field -> source
      defaults, notApplicable,
      weapons: (p.Weapons ?? []).map((w) => {
        const wd = weaponsByClass.get(cls(w));
        if (!wd) return { missing: short(w) };
        const wp = weapon(wd);
        return { ...wp, ...hitsPerAttack(pawnClass, cls(w), wp.instantDamage, wp.cooldown), fireSockets: fireSockets(pawnClass, cls(w)) };
      }),
      passives: [short(p.EntityTypePassivieAbilityDefinition), ...(p.PassivieAbilityDefinitions ?? []).map(short)].filter(Boolean),
      extra: Object.fromEntries(Object.entries(p).filter(([k, v]) => typeof v !== 'object' && !['Health', 'Cost', 'IntelCost', 'ConstructionSiteUpfrontCost', 'ConstructionTime', 'PopulationCost', 'Power', 'MovementSpeed', 'VisionRadius', 'RevealRadius', 'KillIntelValue', ...Object.keys(RES)].includes(k))),
    });
  }
  entities.sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''));
  return entities;
}

const mp = buildTable('DefinitionCollection_Base_MP');
const base = buildTable('DefinitionCollection_Base');
fs.writeFileSync(path.join(OUT, 'stats-mp.json'), JSON.stringify(mp, null, 1));
fs.writeFileSync(path.join(OUT, 'stats-base.json'), JSON.stringify(base, null, 1));
if (montagesExported === false) console.log('note: attack montages not exported (dump preset @montages after @pawns), hitsPerAttack left null');

console.log(`${path.join(OUT, 'stats-mp.json')}: ${mp.length} entities; stats-base.json: ${base.length}`);
