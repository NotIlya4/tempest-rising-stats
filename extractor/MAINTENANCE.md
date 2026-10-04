# Maintaining the extractor

Read this before fixing the extractor after a game patch. It describes the
**chain of links** that leads from the game files to every number on the
site, how each link tends to break, and how to rediscover it. Asset names and
paths in this document are examples from the 2026-09-29 build — expect them to
move. The *shape* of the chain is what stays.

## Principles

1. **The game is the only source.** No wiki, no other site, no guesses. If the data does not
   say it, the output says `null` and records why — it never falls back to a
   rule of thumb. A plausible wrong number is worse than an honest gap.
2. **Prefer what the game uses to decide over what looks related.** Example:
   fire sockets on a weapon *look* like the projectile count, but the game
   spawns projectiles on animation events; sockets only say where they come
   from. The socket rule matched 55 weapons and silently broke 12.
3. **Find things by meaning, not by name.** Join assets by the references and
   identifiers the game itself uses (`AssetIdentifier` tags, `PawnClass`,
   `WeaponClass`, gameplay-event tags), never by file-name patterns.
4. **Verify against known values after every change** (see Golden references).

## The chain

```
exe ──► AES key ──► .utoc/.ucas container ──► packages
exe ──► type mappings (.usmap) ──► property values readable
exe ──► C++ constructors of Ted*DefinitionAsset ──► native class defaults (fields a definition does not store)
DefinitionCollection_*  ──► which definition assets apply in a mode, in which priority
Definition assets       ──► unit / structure / weapon numbers (joined by AssetIdentifier)
Unit def .PawnClass     ──► pawn blueprint ──► weapon → attack montage ──► hit events
DisplayName {TableId, Key} ──► string tables / .locres ──► names in every language
Asset .Icon (Texture2D ref) ──► texture ──► PNG
stats-mp.json + export ──► build-site-data.mjs ──► data/units.json, data/build-report.json, web/icons/
```

`npm run extract` (`extractor/extract.mjs`) runs every link in order. The site is built
only from the committed `data/units.json` and `web/icons/`.

### 1. AES key

- **What:** the IoStore container `Paks/pakchunk0-Windows.utoc/.ucas` is
  AES-256 encrypted. The extractor needs the key; the user supplies it via the
  `TR_AES_KEY` environment variable (or `--key`). How to obtain the key is
  deliberately out of scope of this repository — do not add instructions,
  tools or hints for it here.
- **Breaks when:** a patch changes the key. Symptom: CUE4Parse throws
  `InvalidAesKeyException`. `keycheck` tells whether a supplied key is valid
  for the installed build. A new key has to come from the user.
- Never commit the key, never print it in logs or reports.

### 2. Type mappings (.usmap)

- **What:** the game's packages use unversioned properties; without a mapping
  of class layouts, values are read at wrong offsets.
- **Breaks when:** any patch adds or reorders fields of a game class. Symptom:
  absurd values (a build time of `4.668E-42`, health of `0`), shifted fields,
  or CUE4Parse "failed to read property" errors. It does **not** always throw —
  it can silently produce nonsense, which is why the golden references exist.
- **Rediscover:** `usmapgen` rebuilds the mapping from the type tables the
  engine keeps inside the exe. An old `.usmap` can be passed as a fallback for
  types it cannot resolve.

### 3. Which definitions apply — `DefinitionCollection_*`

- **What:** the game decides which definition assets are active in a mode
  through `SmartDataCollection` assets in `DataAssets/Definitions/`. Each has
  `AssetSearchConfigs`: scan paths, exclude patterns, the asset base class
  (`TedEntityDefinitionAsset`, `TedWeaponDefinitionAsset`, …) and a
  `Priority`. Higher priority overrides lower for the same `AssetIdentifier`.
- Observed for multiplayer (`DefinitionCollection_Base_MP`):
  priority 0 `Definitions/Base` (excluding `VETI`) and `Definitions/MPOnly`,
  priority 1 `Definitions/DLC/VETI`, priority 2 `Definitions/Overrides/MP`.
- **Breaks when:** folders are reorganized or a new mode layer is added.
- **Rediscover:** read the collection assets and apply their rules instead of
  hard-coding folders. If a collection is renamed, find assets of class
  `SmartDataCollection` whose scan paths point into `Definitions`.

### 4. Definition assets

- **Join key:** `AssetIdentifier.TagName`, e.g. `Definition.GDF.Unit.Humvee`,
  `Definition.GDF.Weapon.Humvee_Gun`. Overrides share the identifier of the base
  definition they replace. The winning asset is used **as a whole**: a field it does
  not store has the **native class default** (link 4b), not the lower layer's value.
  Definitions have no template or parent asset: every export's archetype is the
  class default object, so an override is serialized against the class default, not
  against the base asset. Evidence: of 2559 numeric values stored in `Overrides/MP`,
  1740 equal the base asset's value (a delta against the base would have dropped
  them). So when an override leaves out what the base sets, the native default
  applies — e.g. Acolyte `AttackCooldown` (base 1.5, MP unset → 2.0), Demolitionist
  `MovementSpeed` (base 450, MP unset → 500), Enlightened `Health` (base 80, MP
  unset → 100): the designers set the class default value, which the cooker then
  omitted.
- **Unit / structure fields** (class `TedUnitDefinitionAsset` and relatives):
  `Health`, `Cost`, `ConstructionTime`, `PopulationCost`, `MovementSpeed`,
  `VisionRadius`, `RevealRadius`, six resistances (`GunResistance`,
  `RocketResistance`, `ExplosiveResistance`, `CannonResistance`,
  `FireResistance`, `SniperResistance` — fractions, ×100 for percent),
  `Weapons` (weapon blueprint classes), `PawnClass` (the pawn blueprint).
- **Weapon fields** (`TedWeaponDefinitionAsset`): `WeaponClass` (the weapon
  blueprint — joins to the unit's `Weapons` and to montage mapping),
  `DamageAmount` or `RadialDamageParams{BaseDamage, MinimumDamage, InnerRadius,
  OuterRadius}`, `DamageType` (a `BP_DT_*` class → damage type),
  `bDealsInstantDamage`, `AttackCooldown`, `AttackRange`, `ProjectileClass`,
  magazine: `AmmoCountMax`, `AmmoCountUse`, `AmmoRechargeTime`,
  `AmmoCountPerRecharge`, `bRechargeAmmoAutomatically`.
- **Units:** distances are centimetres (100 = 1 m), times are seconds.
- **Rediscover a renamed field:** export one unit you know from the game and
  search the JSON for a value you know (e.g. Sentinel health `260`). Search by
  value, not by name.

### 4b. Native class defaults (fields a definition does not store)

- **What:** cooked packages store only the properties that differ from the class
  default object (UE delta serialization; unversioned properties too). A field a
  definition does not store therefore has the value the C++ constructor of its
  class sets. Struct members work the same way: `RadialDamageParams` stored without
  `InnerRadius` has the constructor's `InnerRadius` (90), not 0.
- **Read from the exe** by `extractor/nativedefaults/nativedefaults.cs` →
  `out/native-defaults.json` (read-only, the exe is only read as bytes):
  1. The reflection tables (the ones `usmapgen` reads) give each property's byte
     offset; a bool property gives a `SetBit` function (`mov byte [rcx+off],1` or
     `or byte [rcx+off],mask`) that names its byte and mask.
  2. A class's `StaticClass` (its `…_NoRegister` function) calls
     `GetPrivateStaticClassBody`; recognized by the class name passed in `rdx`. Its
     10th argument, stack slot `rsp+0x48`, is `InternalConstructor<T>`; slot
     `rsp+0x20` is the object size. `InternalConstructor` tail-jumps to the C++
     constructor.
  3. The constructor is disassembled (Iced) and executed symbolically along its
     straight path: immediate/register/`.rdata`-constant stores to `this`, the call
     to the parent class's constructor (its result is the starting image), and the
     gameplay-tag idiom `FName(L"A.B")` → `RequestGameplayTag` → `AddTag` (e.g.
     `TargetingDomains` = Ground + Air). Stores behind a conditional branch are not
     trusted; a block after the `ret` that only initializes a static and jumps back
     is a detour, not a fork. Unread values are listed under `unknown` with why.
- **Verified** by `build-stats.mjs` (`lib/native-defaults.mjs`) on every run →
  `out/native-defaults-check.json`, summarized in `data/build-report.json`
  (`nativeDefaults`):
  - *engine check:* the reading must reproduce UE's own `FRadialDamageParams()`
    defaults inlined into the weapon constructor (`MinimumDamage` 0,
    `DamageFalloff` 1); if not, no native default is used at all;
  - *data check:* a native default can never be stored explicitly (the cooker would
    have dropped it), so every default is compared with every stored value of every
    exported definition asset of the same class. A default that collides is rejected
    and the value stays `null` with the reason. For the 2026-09-29 build: 271 class
    fields against 15125 stored values, 0 collisions. The check discriminates: units
    store `VisionRadius` 3000 sixty times but never 2000 (their default), structures
    store 2000 nineteen times but never 3000 (theirs); units store `PopulationCost` 0
    sixty-seven times but never 1; 211 weapons store `bDealsInstantDamage: false`,
    none `true`.
- **Defaults in use (2026-09-29 build):** entity `Health` 100 (structure 1000),
  `Cost` 100, `ConstructionTime` 2, `PopulationCost` 0 (unit 1), `VisionRadius`
  2000 (structure 3000, destructible 0), `IntelCost` 0, resistances 0, `Affiliation`
  `ETedFaction::GDF`; unit `MovementSpeed` 500; weapon `AttackCooldown` 2,
  `AttackRange` 2000, `DamageAmount` 10, `DamageKind` Point, `bDealsInstantDamage`
  true, `TargetingDomains` Ground + Air, `RadialDamageParams` {MinimumDamage 0,
  InnerRadius 90, OuterRadius 0, DamageFalloff 1}, `AmmoRechargeTime` 10,
  `AmmoCountPerRecharge` 1.
- **Where they go:** `build-stats.mjs` writes effective values (stored, else
  verified default) into `stats-mp.json` and lists each filled field under
  `defaults` (entities and weapons). `build-site-data.mjs` records every shown value
  filled that way in the report (`filled`, with its source) and marks the unit
  (`nativeDefaults`).
- **Not applicable, not unknown:** a field the class does not have at all (from the
  reflection data: `TedStructureDefinitionAsset` and `TedDestructibleDefinitionAsset`
  have no `MovementSpeed`) and the `Cost` / `ConstructionTime` of an entity no
  factory of the multiplayer set produces (`ProducedUnitsIds` /
  `ProducedStructuresIds`) and no upgrade turns into, when the definition does not
  store them (mines, crates, barrels, map buildings, bombers, spawned drones). These go
  to `notApplicable` (report and unit) and show as a plain "—".
- **Blueprints do not compete:** no exported pawn blueprint sets a movement speed
  (`MaxWalkSpeed`/`MaxSpeed`; the Ted movement components set only
  `MaxAcceleration`), a health or a vision value (`StartingHealth` exists only on
  construction sites), and weapon blueprints carry only `DefinitionId` back to the
  definition. The golden Sentinel speed 1500 is the definition's value.
- **Breaks when:**
  - an engine upgrade changes `GetPrivateStaticClassBody`'s parameters: the tool
    prints "GetPrivateStaticClassBody call not found" or picks a wrong function
    (then the engine check fails). Rediscover: `--dis <Class>` prints the
    constructor; look at the `StaticClass` function's call and the stack slots it
    fills;
  - the compiler emits the constructor differently (e.g. stores through another
    register, loops): more fields land in `unknown`, their values become `null`
    with a reason — never a guess;
  - a patch changes a default: nothing to do, the tool reads the new one; if the
    data check then reports collisions, the reading is wrong for that field (read the
    constructor with `--dis`).
- **Check after a patch:** the `nativeDefaults` section of the report (engine check
  passed, 0 collisions, no rejected fields), `npm test` (it pins a few defaults).

### 5. Hits per attack — attack montages

- **What:** how many times one attack deals damage is defined by the attack
  animation, not by the weapon definition.
  1. Unit definition `PawnClass` → pawn blueprint (`BP_*`), whose class default
     object (`Default__BP_..._C`) has `WeaponAnimMontageSets`: weapon blueprint
     class → `{ AnimMontage.Attack: [montages] }`. A weapon without its own
     entry uses `LocalAnimMontageSetData`. Values can be inherited from parent
     blueprints (`SuperStruct` chain, e.g. `Blueprints/*/BP_*Base`).
  2. The montage (`AM_*`) contains `AnimNotify_GameplayEvent` notifies whose
     `EventTag` is `Event.ShootProjectile` (spawns a projectile) or
     `Event.DealDamage` (applies damage directly).
  3. Projectile weapons (`bDealsInstantDamage: false`) deal damage per
     projectile → count `Event.ShootProjectile`. Instant-damage weapons use a
     cosmetic tracer projectile (`BP_Projectile_BulletTracer*`) → count
     `Event.DealDamage`.
- `PhysicalFireLocSocketNames` (with `bUseCurrentAnimAsIndex`) only chooses the
  muzzle for each event. Its count is not the projectile count.
- Magazine weapons fire one event per attack and cycle sockets: Porcupine has
  12 sockets, `AmmoCountMax 12`, `AmmoCountUse 1`, `AttackCooldown 0.3`, one
  `ShootProjectile` per montage.
- Infantry use the tags `AnimMontage.Attack.Standing` (counted) and
  `AnimMontage.Attack.Crawling` (recorded only).
- **Sections:** playback starts at the first `CompositeSections` entry and
  follows `NextSectionName` until `None`. Only events on that chain count.
  Events in a looping section (`Loop → Loop`, or Warden's
  `CoolDown → Shoot → CoolDown`) repeat for as long as code keeps the loop
  running, so there is no per-attack count: output `null`, flag
  `looping-section` (Queller 20mm, Gatling Turret, Flame Turret, Warden, Golem).
- **Exact class key:** `WeaponAnimMontageSets` is matched by the exact weapon
  class. Networked weapons are usually children of the base weapon class and
  have no entry, so they get the local set (Networked EYRIE →
  `…Shoot_AntiGround`). Whether native code also matches a parent class is
  unknown; `build-stats.mjs` checks the parent's entry and nulls the value
  (`parent-class-entry-differs`) if the counts would differ. None do today.
- **Open (native):** whether the next attack cuts off a montage whose counted
  events come after `AttackCooldown` (flag `event-after-cooldown`: Hammerhand
  Dual Miniguns, Constellation; Gorgon fires at 0.52 s with cooldown 0.5 and
  still works), and whether `AmmoCountUse` is spent per attack or per event
  (Dragonfly, Subjugator, Constellation).
- **Export:** `trdump json @definitions @pawns @montages`. `@pawns` follows
  every `PawnClass` and `WeaponClass` of the definitions; parent blueprints are
  exported automatically; `@montages` is exactly the `AnimMontage` objects the
  exported blueprints reference. Without them the value is `null` with a reason.
- **Breaks when:** event tags are renamed (search montages for
  `GameplayEvent` notifies and list distinct `EventTag`s), the mapping property
  is renamed (search a pawn CDO for montage object paths and see which property
  holds them), or montages move (resolve by the object paths in the blueprint,
  never by folder).

### 6. Names and localization

- Definitions carry `DisplayName` / `Description` as
  `{ TableId: "/Game/Tempest/UI/Texts/ST_Weapons.ST_Weapons", Key: "...",
  SourceString: "..." }`. The `TableId` + `Key` resolve to the string tables
  (`UI/Texts/ST_*`) and to the per-language `.locres` (namespace = table
  name without `ST_` in many cases, key = `Key`).
- UI terms (factions, damage types, tabs like «Постройки» / «Оборона») live in
  `InterfaceTexts`, `ST_Attacks`, `ST_PassiveAbilities`, `MenuScreenTexts`.
  `locres-terms.mjs` dumps all EN/RU pairs; the site's Russian dictionary
  (`web/lib/i18n.js`) cites the `.locres` key for each game term.
- Descriptions are often formats: `{ Format: {TableId, Key}, Arguments: [{Key, Value}] }`.
  `build-site-data.mjs` fills each `{Name}` from the `Arguments` of the same asset (a
  value can itself be a text reference); a placeholder without a stored value becomes "?"
  and is listed in `data/build-report.json` (`placeholders`). Never fill one from
  another source.

### 7. Icons

- **What:** every asset the UI shows with a picture has an `Icon` property, an object
  reference to a `Texture2D` (`/Game/Tempest/UI/Textures/...`), next to its name:
  definitions (`DisplayName`), passive abilities `PA_*` and status effects `SE_*`
  (`DisplayName`), doctrines `DD_*` / equipment / upgrades (`Title`), command
  blueprints `TedCmd_*` and support powers `TedPlayerCmd_*` (`Name` + `Icon` on the
  class default object; inherited from the parent blueprint when unset).
- **Join:** a unit definition's `SupportedCommands` lists its command blueprints; support
  powers are listed per faction in `DataAssets/SupportPowers/SupportPowersCollection`
  (`GDF_SupportCommands`, …). Passives and weapon effects are referenced from the unit
  and weapon definitions. `build-site-data.mjs` takes the icon of exactly the asset a
  record comes from — never by name, never by texture file name.
- **Chain:** `trdump json @definitions @commands` → `trdump png @icons` (decodes exactly
  the textures in `Icon` properties; ≤ 256 px kept, larger scaled to 128 px) →
  `node extractor/build-site-data.mjs` → `web/icons/` + the `icon` fields of `data/units.json`.
- **Breaks when:** the property is renamed (export a unit whose icon you know and search
  its JSON for a `Texture2D'` reference), commands move to another list (search a unit
  definition for `Blueprints/Commands/`), or a texture changes format and CUE4Parse cannot
  decode it (`trdump png` prints `FAIL <package>: <reason>` and continues).
- **Check after a patch:** the `icon` nulls in `data/build-report.json`; Detection
  (`PA_Detection` → `T_PassiveAbility_Detection`) must have an icon; `npm test` checks
  every referenced file is a PNG in `web/icons/` and nothing else is there.

### 8. Site data — `build-site-data.mjs`

- **What:** joins `stats-mp.json` with the raw export into `data/units.json`: damage per
  hit by `DamageKind`, damage type name and armor through the `BP_DT_*` blueprint
  (`RelevantResistAttribute` / `bIgnoresResistances`), effects (passive abilities),
  armor class (`EntityTypePassivieAbilityDefinition`), doctrines (doctrine trees →
  upgrade processors → gameplay-tag filters on unit, weapon and AoE ids), abilities
  (`SupportedCommands` in the `PawnSpecific` / `Upgrade` display sections), production
  lists, prerequisites (tags resolved through entities and `TedUpgrade` assets),
  English and Russian texts, icons. See [docs/DATA-SOURCES.md](../docs/DATA-SOURCES.md).
- **Every null has a reason** in `data/build-report.json`; the page shows it as a tooltip.
- **Breaks when:** a property it follows is renamed (the report suddenly fills with nulls
  for one field — search a known asset's JSON for the value), a display section or tag is
  renamed (abilities or doctrines disappear from units — compare counts in the report), a
  new definition type appears in the collection.
- **Check after a patch:** `npm test` (golden references and data invariants), the
  counts and `hitsUnknown` in the report, the diff of `data/units.json`.

## Golden references

Check these after every patch. They were confirmed in the game or by two
independent sources. If one changes, find out whether the game changed
(patch notes, in-game check) or the extractor broke — never "fix" the
reference to make the check pass.

| Entity | Expected (multiplayer) |
|---|---|
| Sentinel (`Definition.GDF.Unit.Humvee`) | health 260, cost 500, build 14 s, speed 1500, armor rifle 50 / rocket 25 / explosive 25 / cannon 0 / fire 50 / sniper 50 |
| Sentinel PG68 Minigun | 22 damage, cooldown 0.6, range 2600, instant damage, **1 hit** (`Event.DealDamage` ×1; 3 tracer `ShootProjectile`) |
| Havoc Twin-Pod MRL | 22 per rocket, cooldown 2.3, range 2500, `MinimumDamage` 10, radius 200, **4 hits** (`ShootProjectile` ×4) |
| Grenade Turret | 12 per grenade, inner radius 100, outer 600, cooldown 2.5, range 2800, **6 hits** (confirmed in game) |
| Dynasty Missile Trooper (`Definition.DYN.Unit.MissileTrooper`) | health **100** — not stored in its definition, comes from the native class default read from the exe (confirmed in game 2026-10-04) |
| Sentinel population | **1** — native class default (confirmed in game 2026-10-04) |
| Acolyte Energy Catalyst | interval **2.0 s**: the MP override leaves `AttackCooldown` unset, the base asset says 1.5. 2.0 in game confirms that overrides replace base assets entirely and unset fields take the native class default (confirmed in game 2026-10-04) |
| GDF Concrete Wall | **100 + 100**: `Cost` (native default 100, drained while building) + `ConstructionSiteUpfrontCost` 100 (foundation, paid on placement). Every GDF building with a `ConstructionSite` pays the foundation (confirmed in game) |
| Porcupine 227mm Rocket Battery | 100 per rocket, cooldown 0.3, range 3700, magazine 12, +4 per 12 s, **1 hit per attack** (confirmed in game: rockets at 0.3 s) |
| Hammerhand Anti-Tank Guns | 70 per shell, cooldown 2.6, **2 per attack** (no own entry → local set `AM_VH_DYN_CombatDropship_Shoot_Forward`, `ShootProjectile` ×2) |
| Hammerhand Dual Miniguns | own `WeaponAnimMontageSets` entry → `AM_VH_DYN_CombatDropship_Shoot_Sides`: 10 tracer `ShootProjectile`, 3 `DealDamage` → 3 (flag `event-after-cooldown`; extractor output, not confirmed in game) |
| Queller 20mm Rotary Cannon | `null`, `looping-section` (4 `DealDamage` per loop iteration; regression check, not confirmed in game) |

The rows marked in bold, plus Sentinel's numbers and Queller's `null`, are unit tests in
`tests/site-data.test.mjs` that run on the committed `data/units.json`.

## When something breaks — a procedure

1. Run the chain from the top; stop at the first link whose output looks wrong.
   Most patches break only links 1–2 (key, mappings) and the tools fix those.
2. Compare against the golden references, not against the previous output —
   balance patches legitimately change numbers.
3. For a renamed field or tag: export one well-known asset and search its JSON
   by a known value or by a known related asset path; then update the code to
   follow that reference.
4. Write down what changed and why in this file, with the build date.
5. If a value cannot be found in data, record it as unknown with the reason.
   Do not add a heuristic.

## Caveats (open)

- Native defaults are now read from the exe and verified (link 4b). What stays open
  is runtime behaviour the data cannot show: that the game applies the definition
  value unchanged (nothing in the blueprints competes with it, but code could scale
  it), and how channelled or looping weapons (Machinist Tempest Arc, Golem) use
  `AttackCooldown`.
- The radial falloff formula is the engine's standard `FRadialDamageParams`;
  the game's own `TedWeapon` could override it — only an in-game measurement
  can confirm.

## Change log

- 2026-09-29 build: AES key changed compared to earlier builds; usmap rebuilt
  (13 new fields in the stats class). Projectile counts moved from fire-socket
  counting to attack-montage events.
- 2026-10-04: the site switched to game data only. New link `build-site-data.mjs`
  (replaces `site-icons.mjs` and `site-strings.mjs`); damage type blueprints exported
  with `objrefs:DamageType@definitions`; a single montage section that loops to itself is
  now flagged `looping-section` (Golem). The wiki comparison in `build-stats.mjs` was
  removed together with the wiki pipeline.
- 2026-10-04: new link 4b, native class defaults read from the exe
  (`extractor/nativedefaults`) and verified against the data; unset fields are no
  longer unknown (population 131, speed 6 + 107 not applicable, sight 72, weapon
  targets 35, cost 4 + 29 not applicable, build time 27 not applicable, HP 13,
  interval 13 filled). The old statement that an override inherits missing fields
  from the lower layer was wrong (see link 4). `Affiliation` unset is GDF, which moved
  the four `DYN.*.StolenPlans` units (built by GDF) and the two fake minefields to GDF.
  New `stats.intelCost` (Intel, GDF's second resource) and `notApplicable`.
