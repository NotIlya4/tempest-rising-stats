# Road to the public release

Tracker of tasks that must be done before the database can be published on GitHub Pages.
A `[x]` mark means done and verified (`npm run check` is green).

## 1. EN / RU localization

- [x] UI dictionary `web/lib/i18n.js`: all UI strings go through `t()`; the key is the English text, Russian is the `RU` dictionary
- [x] Static `index.html` markup via `data-i18n` / `data-i18n-title` / `data-i18n-placeholder`
- [x] Language switch in the header, the choice is remembered in `localStorage`
- [x] The default language is set by the build: local — `ru` (`web/config.js`), public — `en` (`dist/config.js`)
- [x] Unit names: English in EN; in RU — the game's Russian name with the English name below it
- [x] Search works in both locales (names, weapons, effects, abilities in English and Russian are in the index)
- [x] `<html lang>`, `<title>` and the date format change together with the language
- [x] Russian UI terms taken from the game's own localization where the game has them (factions, damage types, «Постройки», «Численность»…). Each entry names its `.locres` key in a comment
- [x] Data terms (faction, base damage type, unit class, target) are translated for display via `term()`; sorting and math keep raw values
- [x] Tests: `tests/i18n.test.mjs` — dictionary completeness, no duplicate keys, no unused keys, no Cyrillic in `app.js` outside the dictionary and search synonyms; `uitest` RU run — no untranslated strings; EN run — not a single Cyrillic letter on the page and in every unit card
- [x] All names and texts of units, weapons, damage types, effects, doctrines and abilities come in English and Russian from the game localization, carried in `data/units.json`; the UI dictionary holds only UI strings
- [x] Game descriptions with placeholders (`{CommsBoost}`…) are filled from the arguments stored in the same asset; a placeholder the asset does not fill is shown as "?" and listed in `data/build-report.json`
- [x] Unit roles and movement types (wiki wording with no game counterpart) are gone
- [x] Effect filter is a dropdown in the filter row with search, icons and counts; selected effects are removable chips

## 2. Public build and GitHub Pages

- [x] `npm run build:public` → `dist/` (page, scripts, game icons, `config.js` with `en`, `.nojekyll`)
- [x] `.github/workflows/pages.yml`: build from the committed data and icons, tests, deploy via `actions/deploy-pages`; no downloads
- [x] CI steps run on a clean copy of the repository: all tests pass, `dist/` builds
- [ ] GitHub repository: create, push, in Settings → Pages choose "GitHub Actions" — **needs the user's decision** (name, visibility)
- [x] Footer: data and images come from the game files and belong to their owners, fan project disclaimer, link to the sources (if the build knows the repository)
- [x] `<meta name="description">`, favicon
- [ ] Open Graph preview (image for links in messengers) — after the first deploy, needs an absolute URL
- [ ] Mobile width: rules added, but headless Chrome does not render a window narrower than ~500 px — check on a phone after deploy
- [x] `LICENSE`: MIT for the code; game data and images belong to their owners
- [ ] Before publishing: a fresh repository with a single commit (no previous history)

## 3. Documentation and tidy sources

- [x] `README.md` (EN): what it is, formulas, build, extraction, deploy, credits
- [x] `docs/DATA-SOURCES.md`: each game source → what data → which script → where it goes → in git or not
- [x] `Открыть базу.cmd` renamed to `open-local.cmd` (Latin file name, English comments and messages)
- [ ] The deleted `.opencode/skills/tempest-rising-data/SKILL.md` shows as deleted in the working copy — commit the deletion

## 4. Data from the game files

- [x] Research: the container can be read with the user-supplied AES key; type mappings rebuilt
- [x] Extraction: the multiplayer entity set resolved through `DefinitionCollection_Base_MP`
- [x] Decision: all data comes only from the game files; the wiki pipeline is removed from the repository (decided 2026-10-04)
- [x] Hits per attack from the attack montages (`Event.ShootProjectile` / `Event.DealDamage`), not from fire sockets; unknown when the montage gives no single number (looping sections, no attack montage) — shown as "?" with the reason
- [x] `extractor/`: the extraction toolkit as open-source code (key supplied by the user via `TR_AES_KEY` / `--key`; how to obtain it is not documented or published; no key, usmap, DLL or exports in git)
- [x] Switch the site to game data: `extractor/build-site-data.mjs` writes the committed `data/units.json` and `data/build-report.json` (every null with its reason) and the icons in `web/icons/`; `npm run extract` runs the whole chain
- [x] Wiki pipeline removed: fetch/parse scripts, overrides, third-party cross-check, wiki effect tables, wiki pictures, wiki tests, the wiki comparison in `build-stats.mjs`
- [x] Russian names and texts for everything the site shows, from `.locres`
- [x] Game icons are the only pictures; the unit card shows the unit's game icon large
- [x] Damage type and armor joined the way the game does it: the damage type's resistance attribute
- [x] Doctrines that change a unit, abilities (unit commands), where a unit is produced and what it requires — from the game's own references
- [x] Golden references from `extractor/MAINTENANCE.md` are unit tests (`tests/site-data.test.mjs`)
- [ ] Open native questions (listed in `extractor/README.md`): whether attacks cut off a montage longer than the cooldown, whether ammo is spent per attack or per hit (native defaults of unset fields are now read from the exe and verified: extractor/MAINTENANCE.md, link 4b)
- [x] Never publish the AES key, usmap or game assets — only derived numbers, UI strings and the small UI icons the site uses

## 5. Unified visual style

- [x] Tokens (`--radius`, `--font`, `--fs-*`) and one font for text and numbers (`tabular-nums` instead of Consolas)
- [x] Integers without `.0` ("1900", not "1900.0")
- [x] Comparison: group rows span the full width (bug `colspan` → `colSpan`)
- [x] Unit card: game icon, badges and class in one block, no inline styles
- [x] Simplified UI: only Arsenal and Compare tabs and the language switch
- [x] Filters in two rows: search, faction, target; type chips and one "Hide non-combat" switch (economy, non-playable factions, destructibles, entries the game keeps out of its codex), on by default
- [x] Table icons 36 px (game icons are 128 px)
- [x] Unused dictionary entries are detected by a test and pruned with `node tools/i18n-usage.mjs --prune`
- [x] Footer styled, links in the accent color
- [ ] Header on a narrow screen: check live (see section 2)

## 6. Technical odds and ends

- [x] The "no data.js" placeholder is translated and suggests `npm run build`
- [x] All images on Pages are local game icons from `web/icons/`
- [x] Damage modifiers that came from the wiki (prone, vulnerability…) are removed from `web/lib/calc.js`

## 7. Repository fully in English

- [x] Localization keys: English source in code, Russian as a dictionary
- [x] Comments in `tools/`, `web/`, `tests/`, `extractor/` — in English
- [x] Script console output, test names and uitest check names — in English (Russian remains only where tests compare against the Russian page)
- [x] This tracker — in English
- [x] `.gitignore`, `.gitattributes`, `.github/workflows/pages.yml` — comments in English
- [x] What legitimately stays Russian: the game's Russian texts in `data/units.json`, the RU dictionary, Russian search synonyms, Russian test inputs
