# Tempest Rising — unit stats database

A searchable table of every unit and structure in Tempest Rising multiplayer:
HP, armor by damage type, weapons, and the numbers the game never shows —
**DPS, damage per volley, time-to-kill, credits per DPS**.

**Open the site: https://notilya4.github.io/tempest-rising-stats/**

- **Arsenal** — every unit and structure of GDF, Dynasty and Veti, each with
  its weapons listed under it. Sort by any column, filter by faction, unit type
  or effect, pick a target to see damage after its armor. Economy, neutral map
  objects and entries the game keeps out of its codex are hidden by one switch.
- **Compare** — up to five units side by side, each with its own weapon,
  against a common target. The best value in each row is marked.
- **Unit card** — the game icon, stats, armor, weapons, effects and auras,
  the doctrines that change the unit, its abilities, where it is produced and
  what it requires.

English and Russian interface; every name and ability or effect text is the
game's own localization. Works offline: open `web/index.html` directly, no
server needed.

## How the numbers are computed

```
damage per volley = damage per hit × hits per attack
DPS               = damage per volley / attack interval × (100 − armor) / 100
TTK               = target HP / DPS
```

Armor is the target's resistance to the weapon's damage type (Rifle, Rocket,
Explosive, Cannon, Fire, Sniper); Omni ignores armor. Multiplayer values only.

## Data

All data comes from the game files only. `extractor/` reads an installed copy
of the game (read-only) and `extractor/build-site-data.mjs` writes
`data/units.json`, the file the site is built from, plus
`data/build-report.json`, which lists every value the game data does not give
and why. The page shows such values as "—" or "?" with the reason in a
tooltip; nothing is filled in by hand or guessed. Fields a definition does not
store take the class default compiled into the game exe, read from it and
verified against the data (each such value is listed in the report with its
source); values that do not apply, such as the cost of a mine nobody builds,
show as "—" with the reason. See
[docs/DATA-SOURCES.md](docs/DATA-SOURCES.md) for every source and
[extractor/README.md](extractor/README.md) for how the extraction works.

`data/units.json` and the icons in `web/icons/` are committed: building the
site does not need the game.

## Building locally

Requires Node.js 18+. No dependencies.

```sh
npm run build    # data/units.json → web/data.js
npm run check    # build + unit tests + smoke test + headless-browser UI tests (needs Chrome or Edge)
```

Then open `web/index.html`. The local build defaults to Russian; the public
build (`npm run build:public` → `dist/`) defaults to English. The language
switch in the header overrides either and is remembered.

## Refreshing the data after a game patch

```sh
npm run extract  # game files → data/units.json, data/build-report.json, web/icons/
npm run check
```

`npm run extract` needs a copy of the game, the .NET SDK 10 and the game's AES
key in the `TR_AES_KEY` environment variable; see
[extractor/README.md](extractor/README.md) for the requirements and
[extractor/MAINTENANCE.md](extractor/MAINTENANCE.md) for what to check after a
patch. No keys, type mappings or exported game files are ever committed.
Review the diff of `data/units.json` and `data/build-report.json` before
committing: it is exactly what changed in the game.

## Deployment

`.github/workflows/pages.yml` builds `dist/` from the committed data and icons,
runs the tests and publishes it to GitHub Pages on every push to `main`.
Generated files (`web/data.js`, `dist/`) are not committed.

## Project layout

```
data/        units.json (site data) and build-report.json, generated from the game files
extractor/   game-file extraction: C# exporter on CUE4Parse + Node scripts, extract.mjs runs the chain
tools/       build, smoke and UI test scripts
web/         the page: index.html, app.js, lib/calc.js (all math), lib/i18n.js, icons/
tests/       node --test unit tests
docs/        data sources, release checklist
```

## Credits and license

- Code: [MIT](LICENSE).
- Data and images come from the Tempest Rising game files. Tempest Rising, its
  data, names, texts and images are property of their respective owners.
  This is a fan project, not affiliated with the developers or publisher.
