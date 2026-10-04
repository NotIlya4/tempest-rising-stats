# Data sources

Every number, name, text and picture on the site comes from the Tempest Rising
game files. There is no other source: nothing is typed in by hand, nothing is
taken from wikis or other sites, and when the game data does not give a value
the site shows "—" or "?" with the reason instead of a guess.

## Overview

| # | Game data | What the site takes | Script | Output | In git |
|---|-----------|---------------------|--------|--------|--------|
| 1 | Definition assets of the multiplayer collection `DefinitionCollection_Base_MP` | Entities, health, cost, Intel cost, build time, population, speed, sight, resistances, weapons (damage, interval, range, radius, magazine, targets) | `trdump json @definitions` → `extractor/build-stats.mjs` | `extractor/out/stats-mp.json` | no |
| 1b | C++ constructors of the definition classes in the game exe (read, never run) | The value of every field a definition does not store (native class default), verified against the data | `extractor/nativedefaults` → `extractor/build-stats.mjs` | `extractor/out/native-defaults.json`, `native-defaults-check.json` | no |
| 2 | Pawn blueprints and attack montages | Hits per attack (`Event.ShootProjectile` / `Event.DealDamage` notifies of the attack animation) | `trdump json @pawns @montages` → `extractor/build-stats.mjs` | `extractor/out/stats-mp.json` | no |
| 3 | Damage type blueprints `BP_DT_*` | Localized damage type name and the resistance it is checked against | `trdump json objrefs:DamageType@definitions` | `extractor/out/export/` | no |
| 4 | Passive abilities, doctrines, doctrine trees, upgrades, AoE configs | Effects and auras, armor class, doctrines that change each unit, requirements granted by upgrades | `trdump json @definitions` | `extractor/out/export/` | no |
| 5 | Command blueprints (`SupportedCommands`) | Abilities: name, description, icon, cooldown, cost | `trdump json @commands` | `extractor/out/export/` | no |
| 6 | Localization (`.locres`) and string tables | English and Russian names and texts | `trdump locres`, `trdump json @texts` | `extractor/out/export/locres/` | no |
| 7 | `Icon` textures of definitions, passives, doctrines and commands | Unit, effect, doctrine and ability icons (at most 256 px; larger ones scaled to 128 px) | `trdump png @icons` | `extractor/out/icons/` | no |
| — | All of the above | The site's data | `extractor/build-site-data.mjs` | `data/units.json`, `data/build-report.json`, `web/icons/` | **yes** (CI cannot read the game) |

`npm run extract` (`extractor/extract.mjs`) runs the whole chain. `web/data.js`
(what the page loads) is built from `data/units.json` by
`tools/build-web-data.mjs` (`npm run build`).

## Which entities

Exactly the entities the multiplayer definition collection activates: its
`AssetSearchConfigs` layer `Definitions/Base` (without VETI), `MPOnly`,
`DLC/VETI` and `Overrides/MP`, joined by `AssetIdentifier`, higher priority
wins. Entities without a display name (construction sites, an unused grenade
definition) are left out and listed in `data/build-report.json`. Unit ids on
the site are the game's `AssetIdentifier` without the `Definition.` prefix,
e.g. `GDF.Unit.Humvee` for the Sentinel.

Faction is the definition's `Affiliation` (GDF, DYN → Dynasty, Veti,
Civilian → Neutral). Where `Affiliation` is not stored, it is the native
default `ETedFaction::GDF` (all GDF definitions, and the Dynasty units GDF
builds with "stolen plans", whose GDF counterparts built by Dynasty store
`DYN`); every such case is noted in the report.

## Fields a definition does not store

The game's cooked data omits every value equal to the class default, so an
unset field has the value the C++ constructor of its class gives it. These
native defaults are read from the game exe (`extractor/nativedefaults`) and
verified against every value the definitions do store before any is used
(see [extractor/MAINTENANCE.md](../extractor/MAINTENANCE.md), link 4b).
Every shown value filled this way is listed in `data/build-report.json`
(`filled`, with its source). Values that do not apply (a structure's speed,
the cost of a mine nobody builds) are listed under `notApplicable` and shown
as "—" without implying missing data.

## How each value is joined

- **Weapons:** a unit's `Weapons` lists weapon blueprint classes; the weapon
  definition is the one whose `WeaponClass` is that blueprint.
- **Damage per hit:** the parameters the weapon's `DamageKind` selects:
  `RadialDamageParams.BaseDamage` for Radial, `ConeDamageParams.BaseDamage`
  for Cone, `DamageAmount` otherwise (an unset kind is the native default
  `Point`). Radius = `RadialDamageParams.OuterRadius` (inner radius and minimum
  damage are kept too; unset members are the native defaults, e.g. inner
  radius 90).
- **Hits per attack:** counted in the attack montage the pawn blueprint maps
  to the weapon (see [extractor/README.md](../extractor/README.md#hits-per-attack)).
  When the montage gives no single number (looping section, no attack
  montage, no damage event), it stays unknown: damage per volley, DPS and TTK
  are shown as "?" with the reason, never computed as one hit.
- **Damage type and armor:** the weapon's `DamageType` blueprint gives the
  localized name and its `RelevantResistAttribute` (or `bIgnoresResistances`),
  which is the target resistance the damage is checked against.
- **Magazine:** `AmmoCountMax`, `AmmoRechargeTime`, `AmmoCountPerRecharge`
  (unset: native defaults 10 s and 1).
- **Targets:** `TargetingDomains` (ground / air); not set → the native default,
  ground and air.
- **Cost:** `Cost` (credits) and `IntelCost` (Intel, GDF's second resource; 0
  for entities paid in credits only).
- **Effects:** the passive abilities of the unit (`PassivieAbilityDefinitions`)
  and of each weapon; the unit's `EntityTypePassivieAbilityDefinition` is its
  armor class (Light Vehicle, Heavy Infantry…).
- **Doctrines:** every doctrine in the factions' doctrine trees whose upgrade
  processors (or the explicit queries of its extended descriptions) select the
  unit, one of its weapons, or an AoE config it provides, using the game's
  gameplay-tag matching. Processors with a custom condition object are not
  evaluated and are listed in the report.
- **Abilities:** the unit's `SupportedCommands` that the game shows in the
  unit-specific or upgrade section of the command card, with their name,
  description, icon, cooldown and credit cost.
- **Produced at / Requires:** the factories' `ProducedUnitsIds` /
  `ProducedStructuresIds`, and the unit's `Prerequisites` (definition
  references, and tags resolved to the entity that carries them or that an
  upgrade adds them to).
- **Tier:** the game files define no unit tier; the field is null and the
  table has no tier column.
- **Texts:** `DisplayName` / `Description` / `Title` / `Name` references are
  resolved in the English and Russian `.locres`. Placeholders such as
  `{CommsBoost}` are filled from the `Arguments` stored in the same asset; a
  placeholder without a stored value is shown as "?" and listed in the report.
  Unit and structure descriptions are never published.

## Hidden by default

The "Hide non-combat" switch hides, by the game's own data: the economy
(`PlayerData.Entity.Tag.Worker`, the harvester navigation filter, the refinery
factory tab, and what only produces those), entities outside the three
playable factions, destructibles (mines, barrels, crates), and entities the
game leaves out of its codex (`bIgnoreForCodex`: campaign leftovers, variants
the game counts as another unit, construction helpers).

## Icons

Each icon is the `Icon` texture of the asset it belongs to — the unit
definition, the passive ability, the doctrine, the command. Textures the game
itself names a placeholder are not used. `web/icons/` holds exactly the icons
`data/units.json` references; `npm test` checks every one is a valid PNG.

## Refreshing the data

```sh
npm run extract  # needs the game and TR_AES_KEY, see extractor/README.md
npm run check    # build + unit tests + smoke test + UI tests
```

Review the diff of `data/units.json` and `data/build-report.json` before
committing: it is exactly the list of what changed in the game.
