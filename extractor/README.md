# extractor: unit stats straight from the game files

Tools that read an installed copy of **Tempest Rising** (Unreal Engine 5.4, IoStore
containers) and turn the game's own data assets into the site's data: unit, structure and
weapon definitions, the multiplayer balance overrides, hits per attack (from the attack
animations), effects, doctrines, abilities, the localized texts and the UI icons.

Before fixing anything after a game patch, read [MAINTENANCE.md](MAINTENANCE.md): it
describes the chain of links from the game files to every number, how each link breaks
and how to rediscover it.

## Why

The game files are the site's only data source:

- **Exact current balance.** Every multiplayer override is read the same way the game
  reads it.
- **Hits per attack.** These are not in the weapon definitions at all (see below).
- **Localization.** The game's own names and texts in English and Russian, so labels
  match the game exactly.

The rule for everything here: **all data comes from the game files, no heuristics.** When
the data does not give a value, the output is `null` with the reason recorded
(`data/build-report.json`), and the site shows "—" or "?" with that reason.

## Legal and ethics

- The tools only **read** files of a copy you own. They never modify, patch or launch the
  game, never write into the game folder (`trdump` refuses to), and never inject into or
  attach to a running process.
- This repository **ships no keys and no game assets**: no AES key, no `.usmap`, no
  Oodle DLL, no exported files. All intermediate outputs go to `extractor/out/`, which is
  git-ignored.
- What the site publishes is **derived data only**: numbers (HP, damage, ranges, costs…)
  and short game texts such as unit, weapon, effect and ability names and the ability,
  effect and doctrine descriptions. No models, audio, code, and no unit or structure
  description texts. The one exception, by project decision: the small UI icons the site
  shows (unit, effect, doctrine and ability icons, at most 256 px, unit icons 128 px),
  copied to `web/icons/` by `build-site-data.mjs` — only the ones the data references. No
  other texture is committed.

## Requirements

- Windows with Tempest Rising installed (Steam). Other stores should work with `--game`.
- The game's **AES key**. Extraction requires it; you supply it via the `TR_AES_KEY`
  environment variable or `--key 0x…`. Never commit the key and never paste it into
  issues or logs.
- **.NET SDK 10** (tested with 10.0.401). The single-file tools use `dotnet run file.cs`,
  which needs SDK 10. `trdump` targets `net10.0` and uses the
  [CUE4Parse](https://github.com/FabianFG/CUE4Parse) NuGet package (1.2.2.202610).
- **Node.js 18+** for the `.mjs` scripts (no npm packages needed).
- Internet access once: NuGet restore, and CUE4Parse downloads the Oodle decompression
  DLL on first run into `extractor/out/oodle/`.

## Layout

| Path | What it does | Output |
|---|---|---|
| `extract.mjs` | Runs the whole chain below (`npm run extract`; `--skip-dump` reuses the export) | everything below |
| `keycheck/keycheck.cs` | Validates the key you supplied against the installed build | console only |
| `usmapgen/usmapgen.cs` | Builds the `.usmap` property mappings from the reflection tables in the exe | `out/Tempest.usmap` |
| `nativedefaults/nativedefaults.cs` | Reads the C++ class defaults of the definition classes from the exe (fields a definition does not store) | `out/native-defaults.json` |
| `lib/native-defaults.mjs` | Verifies those defaults against the data and gives effective values (used by `build-stats.mjs` and `build-site-data.mjs`) | `out/native-defaults-check.json` |
| `dump/` (`trdump`) | CUE4Parse-based exporter: file list, JSON exports, localization, icon textures as PNG | `out/export/`, `out/icons/` |
| `build-stats.mjs` | Resolves the multiplayer entity set, its weapons and hits per attack | `out/stats-mp.json`, `out/stats-base.json` |
| `locres-terms.mjs` | Bilingual map of every game string (reference for the UI dictionary in `web/lib/i18n.js`) | `out/locres-terms.json` |
| `build-site-data.mjs` | The site's data: entities, weapons, effects, doctrines, abilities, requirements, texts, icons | `data/units.json`, `data/build-report.json`, `web/icons/` |
| `lib/game-text.mjs` | Pure helpers of `build-site-data.mjs` (placeholders, tag matching, pawn types), unit-tested | — |

### Common options

- **Game folder:** `--game <dir>`, or env `TR_GAME_DIR`. Without either, the tools look in
  every Steam library listed in `Steam/steamapps/libraryfolders.vdf`. The value can be the
  game root, its `Tempest/` folder or `Tempest/Content/Paks`.
- **AES key:** `--key 0x…`, or env `TR_AES_KEY`.
- **Mappings:** `--usmap <file>`, or env `TR_USMAP`. The default is `extractor/out/Tempest.usmap`.

Default paths are resolved relative to `extractor/`, so the tools can be run from any
working directory.

## After a game patch

Every step takes seconds, except NuGet restore the first time. Run them from the repo root.

### 1. Key

A patch can change the key. Check the one you have:

```sh
dotnet run extractor/keycheck/keycheck.cs            # uses --key or TR_AES_KEY
```

If it is reported invalid, you need the key for the new build; see Requirements.

### 2. Mappings (`.usmap`)

The containers use unversioned serialization, so property layouts must come from a
`.usmap`. A stale usmap does not fail loudly: values shift into the wrong fields (for
example `ConstructionTime = 4.668E-42`). Regenerate it after every patch:

```sh
dotnet run extractor/usmapgen/usmapgen.cs -- [--fallback <older community .usmap>]
```

`usmapgen` reads the `FClassParams` / `FStructParams` / `FEnumParams` / `FPropertyParams`
tables that Unreal Header Tool compiles into the exe. It keeps property order the same as
`ConstructFProperties`.

For the 2026-09-29 build it found 5821 classes, 5486 structs and 2251 enums, with 0
unresolved type references. About 1500 engine and plugin types are not in these tables.
`--fallback` copies them from an older usmap, and with it the output was byte-identical to
the usmap used for the reference export. The game's own `Ted*DefinitionAsset` classes all
come from the exe, so they are always current.

`--diff Class1,Class2` prints added and removed fields compared with the fallback. By
default it compares `TedEntityDefinitionAsset` and `TedUnitDefinitionAsset`.

### 3. Extract

```sh
npm run extract
```

which is, step by step:

```sh
cd extractor/dump && dotnet build -c Release && cd ../..
T="dotnet extractor/dump/bin/Release/net10.0/trdump.dll"
$T list                                       # out/export/filelist.txt (~57 700 entries)
$T json @definitions @texts @pawns @montages @commands objrefs:DamageType@definitions
$T locres                                     # out/export/locres/<Game..>/<lang>/<Game..>.json
$T png @icons                                 # out/icons/<path>.png + out/icons/index.json (~570 textures)
dotnet run extractor/nativedefaults/nativedefaults.cs   # out/native-defaults.json (reads the exe)
node extractor/build-stats.mjs                # out/stats-mp.json, out/stats-base.json, out/native-defaults-check.json
node extractor/locres-terms.mjs               # out/locres-terms.json
node extractor/build-site-data.mjs            # data/units.json, data/build-report.json, web/icons/
```

Then `npm run check`, compare against the golden references in
[MAINTENANCE.md](MAINTENANCE.md), and review the diff of `data/units.json` and
`data/build-report.json`.

Presets:

| Preset | What it exports |
|---|---|
| `@definitions` | `Tempest/Content/Tempest/DataAssets/`: definitions, passive abilities, upgrades, doctrines… (skips input, achievements, profanity, map markers) |
| `@texts` | `Tempest/Content/Tempest/UI/Texts/` string tables, used to map text references to namespaces |
| `@pawns` | Every `PawnClass` and `WeaponClass` referenced by the exported definitions, plus all `{GDF,DYN,VETI,VETI_DLC,CIV}/{Vehicles,Infantry,Structures,Aircraft}/BP_*`. Needs `@definitions` first (same run or earlier) |
| `@montages` | Exactly the `AnimMontage` assets referenced by the exported blueprints (500 for the 2026-09-29 build). Needs `@pawns` first |
| `@commands` | Command blueprints: every class in the `SupportedCommands` lists of the exported definitions (`TedCmd_*`, unit and structure abilities) and in the per-faction `*_SupportCommands` lists of `SupportPowersCollection` (`TedPlayerCmd_*`, support powers). Needs `@definitions` first |
| `@icons` (for `png`) | Every texture in an `Icon` property of the exported definitions and command blueprints. Needs `@definitions` and `@commands` first |

`objrefs:DamageType@definitions` exports the damage type blueprints (`BP_DT_*`) the weapon
definitions reference: their localized name and the resistance attribute damage is
checked against.

Patterns are expanded and exported in order, so one run with all presets works. Parent
blueprints (`BlueprintGeneratedClass` `Super` under `/Game/`) of every exported package
are exported automatically, because a child class default object stores only the values it
overrides.

You can also pass any package path, `re:<regex>` (matched against the `.uasset` path),
`refs:<Class>@blueprints` (every `<Class>'…'` object referenced by exported blueprints),
`softrefs:<Property>@definitions` (every soft class path in that property of the exported
definitions) or `objrefs:<Property>@definitions` (every object or soft reference anywhere
inside that property, single or in an array; sources `@definitions`, `@blueprints`,
`@commands`). For example:

```sh
$T json "re:^Tempest/Content/Tempest/(GDF|DYN|VETI)/(Vehicles|Infantry|Structures|Aircraft)/BP_[^/]*\.uasset$"
```

Do not export the whole game: it takes hours and you do not need it. `raw <regex>` copies
raw package bytes and is for debugging only.

## Outputs

**`stats-mp.json`** holds the entities resolved through `DefinitionCollection_Base_MP`,
which is the multiplayer balance (225 for the 2026-09-29 build). Each entity has:

- `id`, `asset`, `class`, `faction` (folder) and `affiliation`;
- `name` and `nameRu` (no description texts);
- `hp`, `cost`, `intelCost`, `buildTime`, `population`, `power`, `speed`, `sight`,
  `reveal` and `intelKill`;
- `armor`, as resistance × 100 per damage type;
- `defaults`: every field above that the definition does not store and that was filled
  with the verified native class default (field → source; see "Native class defaults");
- `notApplicable`: fields the class does not have (`MovementSpeed` on structures);
- `tags`, `passives` and `extra` (the remaining scalar fields);
- `weapons[]`.

All values are effective values: stored in the definition, else the native default.

Each weapon has:

- `name`, `nameRu`, `desc` and `descRu` (the short weapon description; not published);
- `damageType`, `damage`, `cooldown`, `range` and `guardRange`;
- `radial` and `cone`;
- `ammo`: the magazine fields (`AmmoCountMax`, `AmmoCountStart`, `AmmoCountUse`,
  `AmmoRechargeTime`, `AmmoCountPerRecharge`, `bRechargeAmmoAutomatically`,
  `AmmoRechargeCutoff`; unset ones from the native default), or `null` when the
  definition sets none of them;
- `instantDamage`: `bDealsInstantDamage` (native default `true`);
- `defaults`: the weapon fields filled with the native default (field → source);
- `targets`, `effectsOnDamage` and `passives`;
- `hitsPerAttack` and `hitsPerAttackSource` (see below);
- `fireSockets`: the weapon's `PhysicalFireLocSocketNames` on the pawn, informational
  only. It is **not** a shot count.

Units: centimetres and seconds, and armor = fraction × 100.

**`stats-base.json`** has the same shape for `DefinitionCollection_Base` (campaign
definitions without overrides).

**`locres-terms.json`** has the form
`{ "<namespace>": { "<key>": { "en": "…", "ru": "…" } } }`, with every table merged across
the `Game`…`Game5` localization targets. For the 2026-09-29 build that is 56 namespaces
and 8655 strings, 20 of them without Russian text.

**`data/units.json`** (committed) is what the site reads: `{ meta, units, effects,
doctrines }`. Each unit carries `id` (the `AssetIdentifier` without `Definition.`),
`faction`, `kind`, `unitClass` (from the `PawnType.*` tag), names in English and Russian,
`armorType` (the entity-type passive), `stats` and `armor` (`{mp: …}`), `weapons` with
damage per hit, hits per attack (`shots`), damage per volley, interval (`speed`), range,
radius, magazine, targets and effects, `unitEffects`, `doctrines`, `abilitiesDetails`,
`producedBy`, `requires`, `icon`, the flags `economy` and `inCodex`, `nativeDefaults` (shown
stats filled from the native class default), `notApplicable` (values that do not apply,
with the reason), and `missing`: the
reason for every value that is absent. `effects` and `doctrines` hold names,
descriptions and icons keyed by asset name. How each value is joined is described in
[docs/DATA-SOURCES.md](../docs/DATA-SOURCES.md).

**`data/build-report.json`** (committed) lists every null with its reason, the weapons
whose hits per attack are unknown, unresolved text placeholders, excluded entities, notes
on assumptions (for example the faction of definitions without `Affiliation`) and counts.

### How the game assembles the multiplayer data set

`DefinitionCollection_Base_MP` combines several folders with different priorities:

| Source | Priority |
|---|---|
| `Base/` (without VETI) | 0 |
| `MPOnly` | 0 |
| `DLC/VETI` | 1 |
| `Overrides/MP` | 2 |

Definitions are matched by `AssetIdentifier` (for example
`Definition.GDF.Unit.Humvee`), and the higher priority wins. An override is a full copy of
the definition, not a delta. A unit's `Weapons[]` points to `BP_*_Weapon_*_C` classes, and
the weapon definition is the one whose `WeaponClass` points back to the same blueprint.

A field that is missing from an asset means the C++ default, not 0, because cooked
packages omit values equal to the class default (an override too: it is serialized
against the class default, not against the base asset). Those defaults are read from the
exe, see below.

## Native class defaults

`nativedefaults/nativedefaults.cs` reads the constructors of the `Ted*DefinitionAsset`
classes from the exe (statically, the exe is never run or modified) and writes
`out/native-defaults.json`:

```sh
dotnet run extractor/nativedefaults/nativedefaults.cs -- [--game <dir> | --exe <file>] [--dis <Class>]
```

Property offsets come from the same reflection tables `usmapgen` reads; the constructor is
found through `StaticClass` → `GetPrivateStaticClassBody` → `InternalConstructor<T>`, and its
stores to `this` are executed symbolically (only the straight path; conditional stores are
not trusted). `--dis` prints a class's constructor.

`build-stats.mjs` verifies them on every run (`out/native-defaults-check.json`) before using
any: the reading must reproduce UE's `FRadialDamageParams` defaults (MinimumDamage 0,
DamageFalloff 1), and no default may equal a value some definition of the same class stores
(the cooker would have dropped it). For the 2026-09-29 build: 271 class fields, 15125
stored values, 0 collisions. A rejected or unreadable default leaves the value `null` with
the reason. Every shown value filled this way is listed in `data/build-report.json`
(`filled`, with its source); the verification is summarized there under `nativeDefaults`.
Details, the defaults in use and how this link breaks: MAINTENANCE.md, link 4b.

Values that do not apply are not unknown: a structure has no `MovementSpeed` property, and
an entity no factory produces (mines, crates, map buildings, bombers) is never charged its
`Cost` / `ConstructionTime` when the definition does not store them. These are listed in
`notApplicable` and shown as "—".

## Icons

The game's UI icons are plain `Texture2D` assets that the data assets point at:

1. **Asset → texture.** Every asset the UI shows with a picture has an `Icon` property (a
   `Texture2D` object reference) next to its name: unit and structure definitions
   (`DisplayName`), passive abilities `PassiveAbilities/PA_*` (`DisplayName`), doctrines
   `Doctrine/*/DD_*` (`Title`), and command blueprints `Blueprints/Commands/TedCmd_*`
   (`Name` and `Icon` on the class default object, inherited from the parent blueprint
   when not set).
2. **Texture → PNG.** `trdump png @icons` decodes each referenced texture with
   CUE4Parse-Conversion (SkiaSharp) into `out/icons/<path>.png`. Textures up to 256 px
   keep their size; larger ones (unit and structure icons are 282 px) are scaled so the
   longer side is 128 px. `out/icons/index.json` lists every texture with its source size
   and pixel format.
3. **Data → file.** `build-site-data.mjs` takes the icon of exactly the asset each record
   comes from (the unit's definition, the passive ability, the doctrine, the command) —
   no name matching — and copies the used PNGs to `web/icons/<TextureName>.png` (the
   folder name is prefixed only when two textures share a name). A texture the game names
   a placeholder (`T_Portrait_Placeholder`, on the Bridge) is not used; the report lists
   every record without an icon.

## Hits per attack

How many times one attack deals damage is **not a field of the weapon definition**. The
game spawns projectiles and applies damage on animation events, so the count comes from
the weapon's attack montage:

1. **Weapon → montage.** The definition's `PawnClass` is the unit or structure blueprint.
   Its class default object (`Default__BP_…_C`) has `WeaponAnimMontageSets`: weapon
   blueprint class → `{ Data: [ { Key: AnimMontage.Attack, Value: { AnimMontages: […] } } ] }`.
   A weapon without its own entry uses `LocalAnimMontageSetData` (same shape). Infantry use
   the tags `AnimMontage.Attack.Standing` (counted) and `AnimMontage.Attack.Crawling`
   (recorded, flagged when it differs). A property not set on a blueprint is taken from
   the nearest parent blueprint that sets it. The weapon definition's `WeaponClass` is the
   join key. Example, Hammerhand (`BP_DYN_Vehicle_CombatDropship`): the Dual Miniguns have
   their own entry `AM_VH_DYN_CombatDropship_Shoot_Sides`; the Anti-Tank Guns have none and
   use the local set `AM_VH_DYN_CombatDropship_Shoot_Forward`.
2. **Montage → events.** The montage's `Notifies` reference `AnimNotify_GameplayEvent`
   objects whose `EventTag` is `Event.ShootProjectile` (spawns a projectile) or
   `Event.DealDamage` (applies the weapon damage directly).
3. **Which event counts.** Projectile weapons (Grenade Turret, Havoc, …) set
   `bDealsInstantDamage: false` explicitly and deal damage per projectile, so `hitsPerAttack` =
   number of `Event.ShootProjectile`. Weapons that leave it unset deal instant damage and
   use a cosmetic projectile such as `BP_Projectile_BulletTracer_C`, so `hitsPerAttack` =
   number of `Event.DealDamage`.
4. **Montage sections.** Playback starts at the first section and follows
   `NextSectionName` until `None`. Only events in the sections on that chain are counted.
   Events in a looping section (one that leads back to itself or to an earlier section,
   including a single section that loops to itself) repeat for as long as the attack keeps
   the loop running, so the montage gives no per-attack count and `hitsPerAttack` is `null`.

Fire sockets (`PhysicalFireLocSocketNames` in `WeaponAimDataSetup`) only choose the muzzle
for each event. Their count is not the number of shots: the old socket-count rule was
wrong for 12 weapons, for example Porcupine (12 sockets, but one rocket per 0.3 s attack
from a 12-round magazine).

`hitsPerAttackSource` records how the value was obtained: `mapping`
(`WeaponAnimMontageSets` or `LocalAnimMontageSetData`), `blueprint` (where the mapping was
found in the parent chain), `tag`, `event` (the event counted), `instantDamage`, and per
montage its `count`, all `events`, `eventTimes`, `length` and, when it has several or a
looping one, `sections`. When the value is `null`, `error` or `flags` says why. Flags:

| Flag | Meaning | `hitsPerAttack` |
|---|---|---|
| `looping-section` | counted events sit in a looping section | `null` |
| `no Event.… notify` | the montage has no event of the counted kind (melee via `Event.CustomBPEvent`, designators, fake weapons) | `null` |
| `variants-differ` | several montages (random variants) with different counts; all in `counts` | `null` |
| `parent-class-entry-differs` | no entry for the weapon class, but its parent weapon class has one with a different count | `null` |
| `event-after-cooldown` | a counted event comes later than `AttackCooldown` | kept |
| `crawling-differs` | the infantry crawling montage has a different count | kept |
| `event-in-off-chain-section` | counted events in a section only reached by a code jump | kept |
| `conditional notify` | `NotifyTriggerChance` < 1 or a notify filter | kept |

On the site, a weapon with `null` hits shows "?" for hits, damage per volley, DPS and TTK,
with the reason as the tooltip.

### Verified

Confirmed in the game or by two independent sources (the golden references in
[MAINTENANCE.md](MAINTENANCE.md), checked by `tests/site-data.test.mjs`):

| Unit | Weapon | Montage | Events | `hitsPerAttack` |
|---|---|---|---|---|
| Grenade Turret | HE Grenade Battery (projectile) | `AM_BD_GDF_Turret_Grenade_Attack` | 6 ShootProjectile | 6 |
| Havoc | Twin-Pod MRL (projectile) | `AM_VH_DYN_RocketBuggy_Shoot` | 4 ShootProjectile | 4 |
| Porcupine MLRS | 227mm Rocket Battery (projectile; magazine 12, use 1, +4 per 12 s, cooldown 0.3) | `AM_VH_DYN_Porcupine_Shoot` | 1 ShootProjectile | 1 |
| Sentinel | PG68 Minigun (instant) | `AM_VH_GDF_Humvee_Attack` | 3 ShootProjectile (tracers), 1 DealDamage | 1 |

For the 2026-10-04 extraction: 118 armed weapons in the published set, hits per attack
unknown for 11 of them (looping sections: Queller and its variant, Gatling Turret, Flame
Turret, Warden, Golem; no damage event: Riot Stun Baton; no attack montage: Marking Mine,
Vine Defender and its turret, Empowered Enlightened).

### Caveats

- **Native defaults.** An unset `bDealsInstantDamage` is `true` and an unset `DamageKind`
  is `Point` (single target, `DamageAmount`): both read from the weapon definition's
  constructor in the exe and verified (no definition stores `true` or `Point`; see
  "Native class defaults"). This used to be an inference from the data and matches it.
- **Exact class match.** `WeaponAnimMontageSets` is looked up by the exact weapon class.
  Whether the native code also accepts a parent class is unknown. "Networked" weapons
  are often children of the base weapon class (for example
  `BP_GDF_Weapon_Peacekeeper_AntiAir_Networked` → `…_AntiAir`), and usually have no entry
  of their own, so they use the local set (Networked EYRIE → `…PeaceKeeper_Shoot_AntiGround`).
  In every current case the parent's entry gives the same count; the
  `parent-class-entry-differs` flag catches a future difference.
- **Attacks overlapping the montage.** Whether the next attack waits for the montage or
  cuts it off is native. It matters where counted events come later than
  `AttackCooldown` (`event-after-cooldown`): Hammerhand Dual Miniguns (DealDamage at 0.15,
  0.37 and 0.62 s, cooldown 0.5) and Constellation (0.07, 0.47, 0.90 s, cooldown 0.7).
  Gorgon fires its one event at about 0.52 s with cooldown 0.5 and still works, which
  suggests attacks are not cut off, but this is not proven.
- **Magazine accounting.** Whether `AmmoCountUse` is spent per attack or per event is
  native. It matters for magazine weapons with several events per attack: Dragonfly
  (4 per attack, magazine 20), Subjugator (4, magazine 12), Constellation (3, magazine 12).
- **Looping montages** (Queller 20mm Rotary Cannon, Gatling Turret, Anti-Personnel Flame
  Turret, Warden, Golem): the number of loop iterations per attack is decided in code, so
  these stay `null`. Their per-section counts are in `hitsPerAttackSource`.
- **No montage mapping:** Marking Mine, Vine Defender, Empowered Enlightened and the fake
  weapons have no attack montage at all.

## Status

| Verified | Not verified |
|---|---|
| All C# tools compile with .NET SDK 10.0.401. | Whether skirmish against the AI uses `DefinitionCollection_Base__MP_SPVariant` instead of `_Base_MP`. |
| Native class defaults read from the exe: engine check passed, 0 collisions with 15125 stored values. | That the game applies those values unchanged at runtime (spot checks: MAINTENANCE.md, link 4b). |
| `usmapgen` with the old usmap as `--fallback` reproduces the reference usmap byte for byte. | Non-Steam installs. |
| `npm run extract` reproduces the golden references (Sentinel: hp 260, cost 500, PG68 Minigun 22 damage, range 2600, cooldown 0.6, 1 hit; see MAINTENANCE.md). | The hits-per-attack caveats listed above. |
| Hits per attack for the four reference weapons above. | |
