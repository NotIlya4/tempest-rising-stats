// Native class defaults of the definition classes (read from the exe by extractor/nativedefaults)
// and their verification against the game data. Pure functions, used by build-stats.mjs and
// build-site-data.mjs.
//
// Why they are needed: cooked packages store only the properties that differ from the class
// default object, so a field a definition does not store has the C++ constructor's value.
// Why they can be trusted: for the same reason, a constructor value must never appear as an
// explicitly stored value in an asset of that class. Every default is checked against every
// stored value of every exported definition asset of its class; a default that collides is
// rejected (and with it the value stays unknown). The reading method itself is checked against
// UE's documented FRadialDamageParams defaults (MinimumDamage 0, DamageFalloff 1).

const f32 = (x) => Math.fround(x);
const sameNumber = (a, b) => f32(a) === f32(b) || Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
const tagsOf = (v) => (Array.isArray(v) ? v : v?.GameplayTags ?? []).map((t) => (typeof t === 'string' ? t : t?.TagName)).filter(Boolean);

/** Whether a stored value equals a native default (scalars, enums, bools, tags, tag containers). */
export function sameValue(stored, def) {
  if (def && typeof def === 'object' && Array.isArray(def.tags)) {
    const a = new Set(tagsOf(stored)); const b = new Set(def.tags);
    return a.size === b.size && [...a].every((t) => b.has(t));
  }
  if (def && typeof def === 'object' && 'tag' in def) return (stored?.TagName ?? null) === def.tag;
  if (typeof def === 'number' && typeof stored === 'number') return sameNumber(stored, def);
  return stored === def;
}

const isStruct = (d) => d && typeof d === 'object' && !Array.isArray(d.tags) && !('tag' in d);

/**
 * Checks every default of every class against the stored values of all definition assets of
 * exactly that class (defs: [{ type, props }]).
 * Returns { ok, engineCheck, classes: { cls: { field: { value, stored, collisions, verified } |
 * { struct: { sub: {...} } } } }, totals }.
 */
export function verifyNativeDefaults(doc, defs) {
  const out = { ok: false, source: doc?.source ?? null, exe: doc?.exe ?? null, engineCheck: null, classes: {}, properties: {}, totals: { fields: 0, storedValues: 0, collisions: 0, rejected: [] } };
  if (!doc?.classes) { out.error = 'native-defaults.json not found (run extractor/nativedefaults)'; return out; }
  // The method must reproduce UE's own FRadialDamageParams() defaults, inlined into the weapon
  // definition constructor: MinimumDamage 0, DamageFalloff 1.
  const radial = doc.classes.TedWeaponDefinitionAsset?.defaults?.RadialDamageParams;
  out.engineCheck = { what: 'FRadialDamageParams defaults inside TedWeaponDefinitionAsset (UE: MinimumDamage 0, DamageFalloff 1)', MinimumDamage: radial?.MinimumDamage ?? null, DamageFalloff: radial?.DamageFalloff ?? null };
  out.engineCheck.passed = radial?.MinimumDamage === 0 && radial?.DamageFalloff === 1;
  if (!out.engineCheck.passed) { out.error = 'engine check failed: the exe reading does not reproduce FRadialDamageParams defaults; native defaults not used'; return out; }
  for (const [cls, c] of Object.entries(doc.classes)) {
    out.properties[cls] = Object.keys(c.properties ?? {});
    const assets = defs.filter((d) => d.type === cls).map((d) => d.props);
    if (!assets.length) continue;
    const res = (out.classes[cls] = {});
    const check = (value, storedList) => {
      const stored = storedList.filter((v) => v !== undefined);
      const collisions = stored.filter((v) => sameValue(v, value)).length;
      out.totals.fields++; out.totals.storedValues += stored.length; out.totals.collisions += collisions;
      return { value, assets: storedList.length, stored: stored.length, collisions, verified: collisions === 0 };
    };
    for (const [field, value] of Object.entries(c.defaults ?? {})) {
      if (isStruct(value)) {
        res[field] = { struct: {} };
        for (const [sub, v] of Object.entries(value)) {
          res[field].struct[sub] = check(v, assets.map((p) => (p[field] && typeof p[field] === 'object' ? p[field][sub] : undefined)));
          if (!res[field].struct[sub].verified) out.totals.rejected.push(`${cls}.${field}.${sub}`);
        }
      } else {
        res[field] = check(value, assets.map((p) => p[field]));
        if (!res[field].verified) out.totals.rejected.push(`${cls}.${field}`);
      }
    }
  }
  out.ok = true;
  return out;
}

const SRC = (cls, field, value) => `native default: not stored in the definition; the ${cls} constructor in the exe sets ${field} = ${JSON.stringify(value?.tags ?? value?.tag ?? value)} (verified, see nativeDefaults)`;

/** The verified native default of cls.field (sub = struct member): { value, source } or { reason }. */
export function nativeDefault(check, cls, field, sub) {
  if (!check?.ok) return { reason: `${field} is not set in the definition and the native default is unavailable (${check?.error ?? 'no native-defaults check'})` };
  const c = check.classes[cls]?.[field];
  const e = sub ? c?.struct?.[sub] : c;
  const name = sub ? `${field}.${sub}` : field;
  if (!e) return { reason: `${name} is not set in the definition and the ${cls} constructor value could not be read from the exe` };
  if (!e.verified) return { reason: `${name} is not set in the definition; the ${cls} constructor value ${JSON.stringify(e.value)} was rejected: ${e.collisions} assets store it explicitly` };
  return { value: e.value, source: SRC(cls, name, e.value) };
}

/** Whether a class has a property at all (from the exe's reflection data); null when unknown. */
export function hasProperty(check, cls, field) {
  const list = check?.properties?.[cls];
  return list ? list.includes(field) : null;
}

/**
 * Effective value of a top-level field: stored, else the verified native default.
 * Returns { value, source } where source is null for stored values; value null + reason when unknown.
 */
export function effective(check, cls, props, field) {
  if (props[field] !== undefined) return { value: props[field], source: null };
  const d = nativeDefault(check, cls, field);
  return 'value' in d ? { value: d.value, source: d.source } : { value: null, source: null, reason: d.reason };
}

/** Effective struct: stored members, the missing ones from the verified native default. */
export function effectiveStruct(check, cls, props, field) {
  const stored = props[field] && typeof props[field] === 'object' ? props[field] : {};
  const def = check?.classes?.[cls]?.[field]?.struct ?? {};
  const value = { ...stored }; const filled = {}; const unknown = {};
  for (const sub of Object.keys(def)) {
    if (value[sub] !== undefined) continue;
    const d = nativeDefault(check, cls, field, sub);
    if ('value' in d) { value[sub] = d.value; filled[sub] = d.source; } else unknown[sub] = d.reason;
  }
  return { value, filled, unknown, stored: props[field] !== undefined };
}

/** Tag container as a plain list of tag names (stored, else the native default). */
export function effectiveTags(check, cls, props, field) {
  if (props[field] !== undefined) return { value: tagsOf(props[field]), source: null };
  const d = nativeDefault(check, cls, field);
  return 'value' in d ? { value: d.value.tags, source: d.source } : { value: null, source: null, reason: d.reason };
}
