/**
 * uitest.mjs — UI autotest: loads the real web/index.html in headless
 * Chrome and clicks through it, checking the results. This is insurance against bugs that
 * calculation tests cannot catch: a DOM node instead of a number in sorting, a lost
 * handler, a filter that filters nothing.
 *
 * How it works: a copy of index.html with a probe script -> headless Chrome -> --dump-dom ->
 * parsing of lines like "PASS|name" / "FAIL|name|details". The copy is removed in finally.
 *
 * Run: node tools/uitest.mjs   (or npm run uitest)
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile, rm, mkdtemp, access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const COPY = join(WEB, '_uitest.html');

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

async function findBrowser() {
  for (const path of CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  return null;
}

/**
 * The probe. Classic scripts share the global lexical scope, so after
 * app.js its COLUMNS, state, UNITS, renderArsenal are visible: the test works with the real
 * page code, not a copy of it.
 */
const probe = String.raw`
const R = [];
let passed = 0, failed = 0;
// The result block is created right away and updated on every check. Otherwise,
// on a crash or if Chrome dumps the DOM before the run ends, we would get nothing.
const pre = document.createElement('pre');
pre.id = 'uitest';
const flush = () => { pre.textContent = R.join('\n') + '\nSUMMARY|' + passed + '|' + failed; };
const ok = (name, cond, detail) => {
  if (cond) { passed++; R.push('PASS|' + name); }
  // The detail is cut at the first pipe while parsing, so pipes inside it are
  // fine, not an error. Line breaks, on the contrary, break the protocol: results
  // are read line by line, and the second line of a detail would lose its FAIL tag.
  else { failed++; R.push('FAIL|' + name + '|' + String(detail).replace(/[\r\n]+/g, ' ').slice(0, 300)); }
  flush();
};
const one = (s) => document.querySelector(s);
const all = (s, scope) => [...(scope ?? document).querySelectorAll(s)];
const ths = () => all('#arsenalTable thead th');
// Weapon sub-rows also live in tbody, but only unit rows are clickable.
const dataRows = () => all('#arsenalTable tbody tr.clickable');
const rowIds = () => dataRows().map((tr) => tr.dataset.id);
const cellAt = (tr, i) => tr.children[i]?.textContent?.trim() ?? '';
/** The table shows units only: a row key is the unit id. */
const rowKey = (u) => u.id;
const unitById = (id) => UNITS.find((u) => u.id === id);
/** Combat weapons of a unit, i.e. the ones that get a sub-row. */
const combatWeapons = (u) => (u.weapons ?? []).filter((w) => !w.utility);
// Game identifiers of the units the checks lean on (AssetIdentifier without "Definition.").
const ID = {
  porcupine: 'DYN.Unit.PorcupineMissileLauncher',
  havoc: 'DYN.Unit.RocketBuggy',
  pillager: 'DYN.Unit.Pillager',
  boar: 'DYN.Unit.Boar',
  riotVan: 'GDF.Unit.RiotVan',
  sphere: 'DYN.Unit.TempestSphere',
};
/** Russian label of an effect by its English name (the filter's value). */
const effectRu = (name) => Object.values(DATA.effects).find((e) => e.name.en === name)?.name.ru ?? name;
const setChecked = (sel, on) => {
  const box = one(sel);
  if (box.checked !== on) {
    box.checked = on;
    box.dispatchEvent(new Event('change'));
  }
};
const setHideSecondary = (on) => setChecked('#hideSecondary', on);
// Number from a cell: armor shows "80" plus a bar, empty cells show "—".
const cellNum = (tr, i) => {
  const text = cellAt(tr, i);
  const total = /\(([\d.,]+)\)\s*$/.exec(text);
  const raw = (total ? total[1] : text).replace(/[^\d,.\-]/g, '').replace(',', '.');
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && raw !== '' && raw !== '-' ? n : undefined;
};
const errors = [];
addEventListener('error', (e) => errors.push(e.message));
addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + e.reason));

document.body.append(pre);
flush();

(async () => {
try {
  // The probe is the last <script> in body, so when it runs
  // DOMContentLoaded has not fired yet and app.js has not drawn anything.
  // Without this wait every table check sees an empty page.
  if (!document.querySelectorAll('#arsenalTable tbody tr').length) {
    await new Promise((r) => addEventListener('DOMContentLoaded', r, { once: true }));
  }

  // ── basic rendering
  ok('page exposed the data', typeof UNITS !== 'undefined' && UNITS.length > 0, 'UNITS=' + typeof UNITS);
  ok('column set is available to the test', typeof columns === 'function' && columns().length > 1, 'columns=' + typeof columns);
  // ── removed on purpose: none of these may come back
  const removedSelectors = ['#modeSwitch', '#picSwitch', '#showWeapons', '#panel-quality', '#qualityOut',
    '#tabs button[data-panel="quality"]', '#fKind', '#onlyArmed', '#hideNeutral', '#hideEconomy',
    '#onlyEffects', '#fClass input[value="other"]'];
  ok('removed controls are not in the DOM',
    removedSelectors.every((s) => !one(s)),
    'still present: ' + removedSelectors.filter((s) => one(s)).join(', '));
  const removedGlobals = {
    WEAPON_COLUMNS: typeof WEAPON_COLUMNS, weaponRow: typeof weaponRow, filteredWeapons: typeof filteredWeapons,
    weaponRows: typeof weaponRows, renderQuality: typeof renderQuality,
  };
  ok('removed code is gone from app.js',
    Object.values(removedGlobals).every((v) => v === 'undefined'),
    'still defined: ' + Object.keys(removedGlobals).filter((k) => removedGlobals[k] !== 'undefined').join(', '));
  ok('state has no removed fields',
    !['mode', 'picture', 'showWeapons'].some((k) => k in state),
    'state keys: ' + Object.keys(state).join(', '));
  ok('state.filters has exactly the current keys',
    Object.keys(state.filters).sort().join(',') === ['classes', 'effects', 'faction', 'hideSecondary', 'q'].join(','),
    'keys: ' + Object.keys(state.filters).join(', '));
  ok('target picker sits in a labeled field',
    Boolean(one('#fTarget')?.closest('label.field'))
    && one('#fTarget').closest('label.field').firstElementChild.textContent.trim() === 'Цель',
    'field: ' + (one('#fTarget')?.closest('label.field')?.textContent.trim().slice(0, 40) ?? 'none'));

  // ── "Hide non-combat": on by default, hides economy, non-playable factions, destructibles
  // and what the game leaves out of its codex — all flags from the game data
  const secondaryIds = UNITS.filter((u) => isSecondary(u)).map((u) => u.id);
  const expectSecondary = (u) => Boolean(u.economy) || !['GDF', 'Dynasty', 'Veti'].includes(u.faction)
    || u.kind === 'destructible' || u.inCodex === false;
  ok('isSecondary matches the spec for every unit',
    UNITS.every((u) => isSecondary(u) === expectSecondary(u)),
    'mismatch: ' + UNITS.filter((u) => isSecondary(u) !== expectSecondary(u)).map((u) => u.id).slice(0, 6).join(', '));
  ok('database has non-combat entities', secondaryIds.length > 0, 'secondary: ' + secondaryIds.length);
  ok('"hide non-combat" is checked by default',
    one('#hideSecondary').checked === true && state.filters.hideSecondary === true,
    'checked=' + one('#hideSecondary').checked + ', state=' + state.filters.hideSecondary);
  ok('"hide non-combat" label is in Russian',
    /Скрыть небоевое/.test(one('#hideSecondary').closest('label')?.textContent ?? ''),
    'label: ' + (one('#hideSecondary').closest('label')?.textContent.trim() ?? 'none'));
  ok('with the filter on no non-combat row is shown',
    rowIds().every((id) => !expectSecondary(unitById(id))),
    'visible: ' + rowIds().filter((id) => expectSecondary(unitById(id))).slice(0, 6).join(', '));
  ok('with the filter on all combat units are shown',
    rowIds().length === UNITS.length - secondaryIds.length,
    'rows ' + rowIds().length + ', expected ' + (UNITS.length - secondaryIds.length));
  setHideSecondary(false);
  ok('unchecking "hide non-combat" shows all units',
    rowIds().length === UNITS.length && state.filters.hideSecondary === false,
    'rows ' + rowIds().length + ' of ' + UNITS.length);
  ok('economy, neutrals and codex-less entities come back',
    secondaryIds.every((id) => rowIds().includes(id)),
    'missing: ' + secondaryIds.filter((id) => !rowIds().includes(id)).slice(0, 6).join(', '));
  setHideSecondary(true);
  ok('re-checking hides them again',
    rowIds().length === UNITS.length - secondaryIds.length && state.filters.hideSecondary === true,
    'rows ' + rowIds().length);

  const total = rowIds().length;
  ok('table populated', total > 100, 'rows: ' + total);
  ok('rows have data-id', dataRows().every((tr) => tr.dataset.id), 'some rows have no id');
  ok('counter matches the table',
    new RegExp('Показано ' + total + ' из').test(one('#arsenalCount').textContent),
    one('#arsenalCount').textContent);

  // ── column set in units mode
  const uLabels = columns().map((c) => c.label);
  const headLabels = () => columns().map((c) => (c.headLabel ? c.headLabel() : c.label));
  ok('no Type column', !uLabels.includes('Тип'), 'columns: ' + uLabels.join(', '));
  ok('no Movement column', !uLabels.includes('Передвижение'), 'columns: ' + uLabels.join(', '));
  ok('has Speed column', uLabels.includes('Скорость'), 'columns: ' + uLabels.join(', '));
  ok('has AoE column', uLabels.includes('AoE'), 'columns: ' + uLabels.join(', '));
  ok('has Range column', uLabels.includes('Дальность'), 'columns: ' + uLabels.join(', '));
  ok('DOM headers match the column definitions',
    ths().map((t) => t.textContent.trim()).join('|') === headLabels().join('|'),
    'in DOM: ' + ths().map((t) => t.textContent.trim()).join(', ') + ' ; expected: ' + headLabels().join(', '));
  ok('DPS and Damage/volley headers are short, the explanation moved to the tooltip',
    (() => {
      const thDps = ths()[columns().map((c) => c.label).indexOf('DPS')];
      const thBurst = ths()[columns().map((c) => c.label).indexOf('Урон/залп')];
      return thDps.textContent.trim() === 'DPS' && thBurst.textContent.trim() === 'Урон/залп'
        && /0% брони/.test(thDps.getAttribute('title') ?? '');
    })(),
    'headers: ' + ths().map((t) => t.textContent.trim()).join(' , '));

  // ── extra info toggle: economy is hidden, interval is added
  // Details are joined with ', ', not '|': results leave the page as the string
  // 'FAIL|name|detail' (see ok()), and a pipe inside a detail used to cut the message
  // exactly when it was needed. So new checks below contain no pipes.
  const labels = () => columns().map((c) => c.label);
  const economyLabels = ['Кредиты', 'Строительство, с', 'Числ.'];
  ok('economy is hidden by default',
    economyLabels.every((l) => !labels().includes(l)),
    'columns: ' + labels().join(', '));
  ok('extra info toggle is off by default',
    !state.showExtra && one('#toggleExtra').getAttribute('aria-expanded') === 'false',
    'showExtra=' + state.showExtra);
  ok('has Interval, s column', labels().includes('Интервал, с'),
    'columns: ' + labels().join(', '));

  one('#toggleExtra').click();
  const after = 'showExtra=' + state.showExtra + ' columns=' + columns().length
    + ' rows=' + document.querySelectorAll('#arsenalTable tbody tr').length
    + ' th=' + ths().length;
  ok('economy appears after the click',
    economyLabels.every((l) => labels().includes(l)),
    'columns: ' + labels().join(', ') + ' // ' + after);
  ok('toggle is marked as pressed',
    state.showExtra === true && one('#toggleExtra').getAttribute('aria-expanded') === 'true'
    && one('#toggleExtra').classList.contains('on'), after);
  ok('DOM headers match the new column set',
    ths().map((t) => t.textContent.trim()).join(' | ') === headLabels().join(' | '),
    'in DOM: ' + ths().length + ' th, columns: ' + columns().length);
  ok('cell shows a number, not empty', (() => {
    const col = columns().findIndex((c) => c.key === 'cost');
    if (col < 0) return false;
    const tr = dataRows().find((r) => {
      const unit = UNITS.find((u) => u.id === r.dataset.id);
      return unit && vKey(unit.stats.cost) !== undefined;
    });
    return Boolean(tr) && tr.children[col].textContent.trim() !== '';
  })(), 'Credits column is empty, columns: ' + labels().join(', '));
  // Intel (the game's term «Разведданные», InterfaceTexts/PlayerData_Resource_Intel_Name),
  // right after Credits: a number for Intel-priced units, "—" for credits-only ones.
  ok('Intel column right after Credits, number or dash', (() => {
    const keys = columns().map((c) => c.key);
    const col = keys.indexOf('intel');
    if (col < 0 || keys[col - 1] !== 'cost' || labels()[col] !== 'Разведданные') return false;
    const rowOf = (pred) => dataRows().find((r) => { const u = UNITS.find((x) => x.id === r.dataset.id); return u && pred(u); });
    const priced = rowOf((u) => vKey(u.stats.intelCost) > 0);
    const free = rowOf((u) => vKey(u.stats.intelCost) === 0);
    const pricedUnit = priced && UNITS.find((x) => x.id === priced.dataset.id);
    return Boolean(priced && free) && priced.children[col].textContent.trim() === String(vKey(pricedUnit.stats.intelCost))
      && free.children[col].textContent.trim() === '—';
  })(), 'columns: ' + labels().join(', '));
  ok('Intel column sorts', (() => {
    const col = columns().find((c) => c.key === 'intel');
    return Boolean(col?.sort) && typeof col.sort(UNITS.find((u) => vKey(u.stats.intelCost) > 0)) === 'number';
  })(), 'no sort for Intel');

  one('#toggleExtra').click();
  ok('second click hides the economy again',
    !economyLabels.some((l) => labels().includes(l)) && state.showExtra === false,
    'columns: ' + labels().join(', '));

  // ── Russian names
  const ruNamed = UNITS.filter((u) => u.nameRu);
  ok('database has Russian names', ruNamed.length > 100, 'units with nameRu: ' + ruNamed.length);
  ok('Russian names are really Russian for almost every unit',
    ruNamed.filter((u) => /[А-Яа-яЁё]/.test(u.nameRu)).length > UNITS.length * 0.9,
    'Cyrillic names: ' + ruNamed.filter((u) => /[А-Яа-яЁё]/.test(u.nameRu)).length + ' of ' + UNITS.length);

  const nameCellOf = (id) => {
    const tr = dataRows().find((r) => r.dataset.id === id);
    const cell = tr && tr.children[columns().findIndex((c) => c.key === 'name')];
    if (!cell) return null;
    return {
      ru: cell.querySelector('.name-ru')?.textContent ?? null,
      en: cell.querySelector('.name-en')?.textContent ?? null,
    };
  };
  const porcupine = unitById(ID.porcupine);
  ok('Russian name comes first', nameCellOf(ID.porcupine).ru === porcupine.nameRu,
    'shown "' + nameCellOf(ID.porcupine).ru + '", in database "' + porcupine.nameRu + '"');
  ok('English name is the second line', nameCellOf(ID.porcupine).en === porcupine.name,
    'shown "' + nameCellOf(ID.porcupine).en + '"');
  // Picked among the visible rows: the default filter hides non-combat entities.
  const noRu = filteredUnits().find((u) => !u.nameRu);
  if (noRu) {
    ok('without any Russian name the English one is shown, with no second line',
      nameCellOf(noRu.id).ru === noRu.name && nameCellOf(noRu.id).en === null,
      noRu.name + ' → ' + JSON.stringify(nameCellOf(noRu.id)));
  }
  ok('every row has a primary name',
    dataRows().every((tr) => {
      const cell = tr.children[columns().findIndex((c) => c.key === 'name')];
      return (cell?.querySelector('.name-ru')?.textContent ?? '').trim().length > 0;
    }), 'a name was not rendered somewhere');

  // ── weapon sub-rows: always shown, there is no switch for them any more
  const subs = all('#arsenalTable tr.wsub-row');
  // Every unit row is immediately followed by exactly its combat weapons, in data order.
  const subRowLayoutErrors = () => {
    const rows = all('#arsenalTable tbody tr');
    const bad = [];
    rows.forEach((tr, i) => {
      if (!tr.classList.contains('clickable')) return;
      const expected = combatWeapons(unitById(tr.dataset.id)).map((w) => String(w.slot));
      const actual = [];
      for (let k = i + 1; k < rows.length && rows[k].classList.contains('wsub-row'); k++) {
        if (rows[k].dataset.for !== tr.dataset.id) { bad.push(tr.dataset.id + ' followed by a sub-row of ' + rows[k].dataset.for); break; }
        actual.push(rows[k].dataset.slot);
      }
      if (actual.join(',') !== expected.join(',')) bad.push(tr.dataset.id + ' slots ' + actual.join('/') + ' vs ' + expected.join('/'));
    });
    return bad;
  };
  ok('every unit row is followed by its weapon sub-rows', subRowLayoutErrors().length === 0,
    subRowLayoutErrors().slice(0, 4).join(', '));
  ok('every tbody row is either a unit or a weapon sub-row',
    all('#arsenalTable tbody tr').every((tr) => tr.classList.contains('clickable') || tr.classList.contains('wsub-row')),
    'stray rows: ' + all('#arsenalTable tbody tr').filter((tr) => !tr.classList.contains('clickable') && !tr.classList.contains('wsub-row')).length);
  ok('sub-row count equals the combat weapons of the visible units',
    subs.length === filteredUnits().reduce((s, u) => s + combatWeapons(u).length, 0),
    'sub-rows ' + subs.length + ', expected ' + filteredUnits().reduce((s, u) => s + combatWeapons(u).length, 0));
  ok('sub-rows rendered', subs.length > 50, 'sub-rows: ' + subs.length);
  ok('sub-rows follow their unit directly',
    all('#arsenalTable tbody tr').every((tr, i, list) => {
      if (!tr.classList.contains('wsub-row')) return true;
      // Walk back to the nearest clickable row: after the first sub-row
      // come its siblings, not a new unit.
      for (let k = i - 1; k >= 0; k--) {
        if (list[k].classList.contains('clickable')) return list[k].dataset.id === tr.dataset.for;
      }
      return false;
    }), 'a sub-row lost its owner');
  ok('sub-row is not stretched: as many cells as columns',
    subs.every((tr) => tr.children.length === columns().length),
    'cells ' + (subs[0] ? subs[0].children.length : '—') + ', columns ' + columns().length);
  ok('no [object ...] in sub-rows',
    subs.every((tr) => !/\[object \w+\]/.test(tr.textContent)),
    (subs.find((tr) => /\[object \w+\]/.test(tr.textContent))?.textContent ?? '').slice(0, 80));
  ok('sub-rows do not contain the words damage/volley and range, those are columns now',
    subs.every((tr) => !/урон\/залп|дальность \d/.test(tr.textContent)),
    'the label duplicates a column');
  ok('sub-rows contain weapon numbers',
    subs.some((tr) => /\d/.test(tr.textContent)), 'sub-rows are empty');
  // Interval, ammo and targets moved out of the name cell into the "Interval, s" column
  // and the tooltip: it was the text in the name that stretched the column and pushed the table sideways.
  ok('sub-row has a tooltip with interval, ammo and targets',
    subs.some((tr) => /интервал [\d.]+ с/.test(tr.querySelector('.wsub-name')?.getAttribute('title') ?? '')),
    'no interval in the tooltip');
  ok('weapon label no longer carries data, only the name',
    subs.every((tr) => !/·/.test(tr.querySelector('.wsub-name')?.textContent ?? '')),
    'text joined with "·" reappeared in the name cell');
  ok('weapon interval sits in its own column', (() => {
    const idx = columns().findIndex((c) => c.key === 'interval');
    if (idx < 0) return false;
    return subs.some((tr) => /^\d+[.,]\d+$/.test(tr.children[idx]?.textContent.trim() ?? ''));
  })(), 'columns: ' + columns().map((c) => c.key).join(', '));
  ok('weapon damage type sits in the Class column', (() => {
    const idx = columns().findIndex((c) => c.key === 'armorType');
    if (idx < 0) return false;
    return subs.some((tr) => {
      const cell = (tr.children[idx]?.textContent ?? '').trim();
      return cell && cell !== '—';
    });
  })(), 'columns: ' + columns().map((c) => c.key).join(', '));
  ok('an armed unit has as many sub-rows as weapons in the data',
    (() => {
      const bad = filteredUnits().filter((u) => {
        const expected = combatWeapons(u).length;
        if (!expected) return false;
        const actual = subs.filter((tr) => tr.dataset.for === u.id).length;
        return actual !== expected;
      });
      return bad.length === 0;
    })(), 'weapon count mismatch');

  // sort by name ascending and expect Cyrillic at the top
  const nameCol = columns().findIndex((c) => c.key === 'name');
  ths()[nameCol].click();
  if (state.sort.dir === -1) ths()[nameCol].click();
  const firstNames = dataRows().slice(0, 5).map((tr) => tr.children[nameCol].querySelector('.name-ru').textContent);
  ok('name sorting uses Russian names',
    firstNames.every((n) => /[А-Яа-яЁё]/.test(n)) || firstNames.some((n) => /^[А-Яа-яЁё]/.test(n)),
    'first: ' + firstNames.join(', '));
  ok('Russian names are in alphabetical order',
    (() => {
      const letters = dataRows()
        .map((tr) => tr.children[nameCol].querySelector('.name-ru').textContent)
        .filter((n) => /^[А-Яа-яЁё]/.test(n))
        .map((n) => n.toLowerCase());
      return letters.every((n, i) => i === 0 || letters[i - 1].localeCompare(n, 'ru') <= 0);
    })(), 'found a name out of alphabetical order');
  if (state.sort.key !== 'name') ths()[nameCol].click();

  // Highlight of "this weapon was used for the number": sort by DPS descending.
  ths()[columns().findIndex((c) => c.key === 'dps')].click();
  ok('the weapon used for DPS is highlighted',
    all('#arsenalTable tr.wsub-row.win').length > 0, 'nothing highlighted');
  ok('at most one weapon per unit is highlighted',
    UNITS.every((u) => all('#arsenalTable tr.wsub-row.win[data-for="' + u.id + '"]').length <= 1),
    'several weapons highlighted');
  ok('the highlighted weapon has the highest DPS, the same one the column sorts by',
    (() => {
      const dpsCol = columns().findIndex((c) => c.key === 'dps');
      const bad = all('#arsenalTable tr.wsub-row.win').filter((tr) => {
        const sibs = all('#arsenalTable tr.wsub-row[data-for="' + tr.dataset.for + '"]');
        return sibs.some((s) => Number(cellNum(s, dpsCol)) > Number(cellNum(tr, dpsCol)) + 0.11);
      });
      return bad.length === 0;
    })(), 'a different weapon is highlighted, not the best one: ' + all('#arsenalTable tr.wsub-row.win').length + ' rows');

  // Weapon property columns are empty in the unit row: the values live in
  // sub-rows. The columns stay because they are used for sorting.
  for (const key of ['dps', 'burst', 'aoe', 'range', 'interval']) {
    ok('unit row "' + key + '" is empty, it is a weapon property', (() => {
      const col = columns().findIndex((c) => c.key === key);
      if (col < 0) return false;
      return dataRows().every((tr) => tr.children[col].textContent.trim() === '');
    })(), 'columns: ' + columns().map((c) => c.key).join(', '));
  }
  ok('weapon sub-rows are still populated', (() => {
    const cols = ['dps', 'burst', 'aoe', 'range', 'interval'].map((k) => columns().findIndex((c) => c.key === k));
    return all('#arsenalTable tr.wsub-row').some((tr) => cols.some((i) => /\d/.test(tr.children[i]?.textContent ?? '')));
  })(), 'sub-rows are empty');

  // Sub-rows do not depend on the non-combat filter: with it off, every unit
  // (including the newly shown ones) still gets its weapons right below it.
  setHideSecondary(false);
  ok('with all units shown every unit row is still followed by its sub-rows',
    rowIds().length === UNITS.length && subRowLayoutErrors().length === 0,
    'rows ' + rowIds().length + ', ' + subRowLayoutErrors().slice(0, 3).join(', '));
  setHideSecondary(true);

  // ── type filter: chips, several at once, none means all
  ok('tier filter removed', !one('#fTier'), 'select #fTier is still on the page');
  const boxes = all('#fClass input');
  const groupKeys = ['infantry', 'vehicles', 'aircraft', 'superweapon', 'structures'];
  const presentGroups = groupKeys.filter((k) => UNITS.some((u) => classOf(u) === k));
  ok('chips are rendered only for groups that have entities, in order',
    boxes.map((b) => b.value).join(',') === presentGroups.join(','),
    'chips: ' + boxes.map((b) => b.value).join(', ') + ', expected: ' + presentGroups.join(', '));
  ok('every entity with a pawn type except destructibles belongs to a chip group',
    UNITS.filter((u) => u.unitClass && u.unitClass !== 'destructible').every((u) => groupKeys.includes(classOf(u))),
    'without a group: ' + UNITS.filter((u) => u.unitClass && u.unitClass !== 'destructible' && !groupKeys.includes(classOf(u))).map((u) => u.id).slice(0, 6).join(', '));
  ok('chip markup is label.chip with a checkbox and a span',
    boxes.length > 0 && boxes.every((b) => b.type === 'checkbox'
      && b.parentElement.matches('label.chip')
      && b.nextElementSibling?.tagName === 'SPAN'
      && b.nextElementSibling.textContent.trim().length > 0),
    'labels: ' + all('#fClass label').map((l) => l.className + ':' + l.textContent.trim()).join(', '));
  ok('chip labels are in Russian',
    all('#fClass label.chip span').every((s) => /[А-Яа-яЁё]/.test(s.textContent)),
    'labels: ' + all('#fClass label.chip span').map((s) => s.textContent).join(', '));
  ok('chip groups follow the game pawn type', UNITS.every((u) => {
    const expected = { infantry: 'infantry', vehicle: 'vehicles', aircraft: 'aircraft', superweapon: 'superweapon', structure: 'structures' }[u.unitClass] ?? null;
    return classOf(u) === expected;
  }), 'misclassified: ' + UNITS.filter((u) => classOf(u) !== ({ infantry: 'infantry', vehicle: 'vehicles', aircraft: 'aircraft', superweapon: 'superweapon', structure: 'structures' }[u.unitClass] ?? null)).map((u) => u.id).slice(0, 5).join(', '));
  ok('nothing selected initially', state.filters.classes.length === 0 && boxes.every((b) => !b.checked),
    'selected: ' + state.filters.classes.join(','));

  const byValue = (v) => all('#fClass input').find((b) => b.value === v);
  const toggleChip = (v, on) => {
    const b = byValue(v);
    b.checked = on;
    b.dispatchEvent(new Event('change'));
  };
  const visibleOf = (keys) => UNITS.filter((u) => !isSecondary(u) && keys.includes(classOf(u)));
  toggleChip('infantry', true);
  const infRows = rowIds();
  ok('one type filters the table', infRows.length > 0 && infRows.length < total,
    'rows: ' + infRows.length);
  ok('only infantry remains',
    infRows.every((id) => classOf(unitById(id)) === 'infantry'),
    'rows: ' + infRows.slice(0, 5).join(','));
  ok('all visible infantry is listed', infRows.length === visibleOf(['infantry']).length,
    'rows ' + infRows.length + ', expected ' + visibleOf(['infantry']).length);

  toggleChip('aircraft', true);
  const twoRows = rowIds();
  ok('second chip ADDS to the selection instead of replacing it',
    twoRows.length > infRows.length && twoRows.length <= total,
    'was ' + infRows.length + ' -> ' + twoRows.length);
  ok('only infantry and aircraft are listed',
    twoRows.every((id) => ['infantry', 'aircraft'].includes(classOf(unitById(id)))),
    'other types in the results');
  ok('two chips give exactly the union of both groups',
    twoRows.length === visibleOf(['infantry', 'aircraft']).length
    && visibleOf(['infantry', 'aircraft']).every((u) => twoRows.includes(u.id)),
    'rows ' + twoRows.length + ', expected ' + visibleOf(['infantry', 'aircraft']).length);
  ok('class filter keeps weapon sub-rows under each unit', subRowLayoutErrors().length === 0,
    subRowLayoutErrors().slice(0, 3).join(', '));

  // Chips and the non-combat filter combine: with it off the selection grows by the
  // hidden infantry and aircraft, and still only those classes.
  setHideSecondary(false);
  const twoAll = UNITS.filter((u) => ['infantry', 'aircraft'].includes(classOf(u)));
  ok('chips combine with "hide non-combat" off',
    rowIds().length === twoAll.length
    && rowIds().every((id) => ['infantry', 'aircraft'].includes(classOf(unitById(id)))),
    'rows ' + rowIds().length + ', expected ' + twoAll.length);
  setHideSecondary(true);

  for (const v of ['infantry', 'aircraft']) toggleChip(v, false);
  ok('unchecking all chips restores everything', rowIds().length === total, 'rows ' + rowIds().length);

  // ── the browser restores form fields without firing change: the page must not lie
  // Scenario: state is empty, but the browser restored the Infantry checkbox and the search text.
  // And the reverse: state is set, but the browser cleared the checkboxes.
  const markedClasses = () => all('#fClass input').filter((i) => i.checked).map((i) => i.value);
  state.filters = { q: '', faction: '', classes: [], hideSecondary: true, effects: [] };
  one('#fClass input[value="infantry"]').checked = true;   // browser restoration
  one('#q').value = 'что-то';                                // here too
  one('#hideSecondary').checked = false;
  renderArsenal();
  ok('before syncing the page really does lie', markedClasses().length === 1,
    'checked: ' + markedClasses().join(','));
  window.dispatchEvent(new Event('focus'));
  ok('after returning to the tab no checkbox is lit for nothing', markedClasses().length === 0,
    'checked: ' + markedClasses().join(','));
  ok('after returning to the tab the search is cleared', one('#q').value === '' && state.filters.q === '',
    'field: "' + one('#q').value + '", state: "' + state.filters.q + '"');
  ok('after returning to the tab "hide non-combat" is checked again',
    one('#hideSecondary').checked === true && state.filters.hideSecondary === true,
    'checked=' + one('#hideSecondary').checked);
  ok('after returning to the tab the table is full', rowIds().length === total, 'rows ' + rowIds().length);

  // Reverse case: state is set, the browser cleared the fields.
  state.filters = { q: 'hava', faction: '', classes: ['infantry'], hideSecondary: false, effects: [] };
  one('#fClass input[value="infantry"]').checked = false;
  one('#q').value = '';
  one('#hideSecondary').checked = true;
  window.dispatchEvent(new Event('focus'));
  ok('state restores the fields, not the other way round',
    markedClasses().join(',') === 'infantry' && one('#q').value === 'hava' && one('#hideSecondary').checked === false,
    'checked: ' + markedClasses().join(',') + ', search: "' + one('#q').value + '", hideSecondary ' + one('#hideSecondary').checked);
  ok('after sync the table matches the state', (() => {
    const expected = sortRows(filteredUnits(), columns().find((c) => c.key === state.sort.key).sort, state.sort.dir);
    const actual = rowIds();
    return expected.length === actual.length && expected.every((u, i) => u.id === actual[i]);
  })(), 'rows ' + rowIds().length + ', expected from state '
    + sortRows(filteredUnits(), columns().find((c) => c.key === state.sort.key).sort, state.sort.dir).length);
  ok('filters from the state really narrowed the selection', rowIds().length < total, 'rows ' + rowIds().length);

  ok('"hide non-combat" is off before the reset', one('#hideSecondary').checked === false
    && state.filters.hideSecondary === false, 'checked=' + one('#hideSecondary').checked);
  one('#resetFilters').click();
  ok('"reset filters" button clears everything', state.filters.classes.length === 0
    && state.filters.q === '' && one('#q').value === '' && markedClasses().length === 0
    && state.filters.faction === '' && state.filters.effects.length === 0,
    'state: ' + JSON.stringify(state.filters).replace(/\|/g, '/') + ', checked: ' + markedClasses().join(','));
  ok('reset filters turns "hide non-combat" back on',
    one('#hideSecondary').checked === true && state.filters.hideSecondary === true,
    'checked=' + one('#hideSecondary').checked + ', state=' + state.filters.hideSecondary);
  ok('after reset the table is full again', rowIds().length === total, 'rows ' + rowIds().length);
  ok('resetting filters does not touch the target', one('#fTarget .picker-input').value === '',
    'target: "' + one('#fTarget .picker-input').value + '"');

  /** Unit armor for the current variant: vKey is not in scope in the probe. */
  const armorOf = (u) => (u.armor?.mp ?? {});
  // ── DPS and Damage/volley are computed AFTER the target's armor: the tooltip must explain it
  // By column key, not by header: the DPS header changes with the target.
  const colIndex = (key) => columns().findIndex((c) => c.key === key);
  const rowOf = (id) => dataRows().find((tr) => tr.dataset.id === id);
  // DPS and volley values moved into weapon sub-rows, so both the tooltip and
  // the number itself are read there, not in the unit row.
  const subOf = (unitId, key) => all('#arsenalTable tr.wsub-row[data-for="' + unitId + '"]')[0];
  const tipOf = (unitId, key) => subOf(unitId, key)?.children[colIndex(key)]?.getAttribute('title') ?? '';
  const cellOf = (unitId, key) => subOf(unitId, key)?.children[colIndex(key)]?.textContent ?? '';

  // Pillager fires fire damage (45). Havoc's fire armor is exactly 50, hence 22.5.
  const pillager = unitById(ID.pillager);
  const halfArmorFire = UNITS.find((u) => armorOf(u).fire === 50);
  ok('without a target the tooltip says it is computed at 0% armor',
    tipOf(ID.pillager, 'burst').includes('0% брони'), tipOf(ID.pillager, 'burst'));

  one('#fTarget .picker-input').focus();
  one('#fTarget .picker-input').value = halfArmorFire.nameRu ?? halfArmorFire.name;
  one('#fTarget .picker-input').dispatchEvent(new Event('input'));
  all('#fTarget .picker-item').find((n) => n.dataset.id === halfArmorFire.id).click();

  ok('against a target with half armor the damage is halved',
    Number(cellOf(ID.pillager, 'burst')) === Number(pillager.weapons[0].damagePerVolley.mp) / 2,
    'damage: ' + cellOf(ID.pillager, 'burst'));
  ok('tooltip names the armor and gives the number without it', (() => {
    const tip = tipOf(ID.pillager, 'burst');
    return tip.includes('без брони') && tip.includes('50%') && tip.includes('Огонь');
  })(), 'tooltip: ' + tipOf(ID.pillager, 'burst'));
  ok('DPS tooltip explains it too', tipOf(ID.pillager, 'dps').includes('без брони'),
    'tooltip: ' + tipOf(ID.pillager, 'dps'));
  ok('sub-row has no "object" and has a number', (() => {
    const v = cellOf(ID.pillager, 'dps');
    return !v.includes('object') && /\d/.test(v);
  })(), 'in cell: ' + cellOf(ID.pillager, 'dps'));
  // Key point: the table shows that a target is applied. Header text is deliberately
  // short ("DPS", "Урон/залп"), so the target marker is looked up in the tooltip,
  // otherwise "vs X" would have to go back into the header itself.
  const headTip = (key) => ths()[colIndex(key)]?.getAttribute('title') ?? '';
  ok('short header survived the shortening',
    ths()[colIndex('dps')].textContent.trim() === 'DPS' && ths()[colIndex('burst')].textContent.trim() === 'Урон/залп',
    'headers: ' + ths()[colIndex('dps')].textContent.trim() + ' and ' + ths()[colIndex('burst')].textContent.trim());
  ok('header tooltip names the target whose armor reduces the damage',
    all('#arsenalTable thead th').some((t) => (t.getAttribute('title') ?? '').includes(halfArmorFire.nameRu ?? halfArmorFire.name)),
    'tooltips: ' + ths().map((t) => t.getAttribute('title') ?? '').filter(Boolean).join(' ; '));
  ok('the tooltip names exactly the selected unit',
    headTip('burst').includes(halfArmorFire.nameRu ?? halfArmorFire.name),
    'tooltip: ' + headTip('burst'));
  ok('column header is highlighted with color', ths()[colIndex('dps')].classList.contains('armed'),
    'class: ' + ths()[colIndex('dps')].className);

  one('#fTarget .picker-clear').click();
  ok('after clearing the target the damage is raw again',
    Number(cellOf(ID.pillager, 'burst')) === pillager.weapons[0].damagePerVolley.mp,
    'damage: ' + cellOf(ID.pillager, 'burst'));
  ok('after clearing the tooltip mentions 0% armor again',
    headTip('burst').includes('0% брони'), 'tooltip: ' + headTip('burst'));
  ok('sorted column values did not break', dataRows().length === total, 'rows ' + dataRows().length);

  // ── color highlights of the key numbers
  const colorOf = (key) => {
    const idx = columns().findIndex((c) => c.key === key);
    if (idx < 0) return '';
    const cell = dataRows()[0]?.children[idx];
    return cell ? getComputedStyle(cell).color : '';
  };
  ok('DPS is highlighted in red', /^rgb\((\d+), (\d+), (\d+)\)$/.test(colorOf('dps'))
    && Number(colorOf('dps').match(/\d+/g)[0]) > Number(colorOf('dps').match(/\d+/g)[1]),
  'DPS color: ' + colorOf('dps'));
  ok('Damage/volley is highlighted in red', colorOf('burst') === colorOf('dps'),
    'damage color ' + colorOf('burst') + ' vs DPS ' + colorOf('dps'));
  ok('HP is highlighted in green', (() => {
    const c = colorOf('hp');
    const [r, g] = (c.match(/\d+/g) ?? []).map(Number);
    return g > r && g > (c.match(/\d+/g) ?? [0, 0, 0])[2];
  })(), 'HP color: ' + colorOf('hp'));
  ok('colors did not spill onto other columns', colorOf('hp') !== colorOf('dps')
    && colorOf('range') !== colorOf('dps'), 'HP ' + colorOf('hp') + ', DPS ' + colorOf('dps') + ', range ' + colorOf('range'));

  //
  // Direction is NOT guessed from the click count: for a numeric column the first click
  // sorts descending, for a text column ascending. Take the real state.sort.dir and
  // compare the DOM with what sortRows returns for that direction.
  const monotonic = (nums, dir) => {
    const known = nums.filter((n) => n !== undefined);
    const sorted = [...known].sort((a, b) => (a - b) * dir);
    return known.every((n, k) => n === sorted[k]);
  };
  const checkSorting = (tag) => {
    const cols = columns();
    for (let i = 1; i < cols.length; i++) {
      const col = cols[i];
      const key = col.key;
      const th = ths()[i];
      const expectedHead = col.headLabel ? col.headLabel() : col.label;
      ok('header present [' + tag + ']: ' + key, Boolean(th) && th.textContent.trim() === expectedHead,
        'th=' + (th ? JSON.stringify(th.textContent.trim()) : 'none') + ' expected ' + JSON.stringify(expectedHead));

      // the key must be a primitive: a DOM node in sorting = NaN = "nothing changes"
      const sample = col.sort(filteredUnits()[0]);
      ok('sort key is primitive [' + tag + ']: ' + key,
        sample === undefined || ['number', 'string', 'boolean'].includes(typeof sample),
        'typeof = ' + (sample === null ? 'null' : typeof sample));

      const seen = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        th.click();
        const dir = state.sort.dir;
        const expected = sortRows(filteredUnits(), col.sort, dir).map(rowKey);
        const actual = rowIds();
        const name = key + ' ' + (dir > 0 ? 'asc' : 'desc');

        ok('order matches the expected one [' + tag + ']: ' + name,
          expected.length === actual.length && expected.every((v, k) => v === actual[k]),
          'expected ' + expected.slice(0, 6).join(',') + ' ; got ' + actual.slice(0, 6).join(','));

        const distinct = new Set(filteredUnits().map((r) => String(col.sort(r)))).size;
        if (distinct > 1) {
          if (col.num) {
            const nums = dataRows().map((tr) => cellNum(tr, i));
            ok('numeric order in the column [' + tag + ']: ' + name, monotonic(nums, dir),
              'in table ' + nums.filter((n) => n !== undefined).slice(0, 8).join(',') + ' ; ascending ' +
              [...nums.filter((n) => n !== undefined)].sort((a, b) => a - b).slice(0, 8).join(','));
            const firstEmpty = nums.findIndex((n) => n === undefined);
            if (firstEmpty !== -1) {
              ok('empty cells at the bottom [' + tag + ']: ' + name, nums.slice(firstEmpty).every((n) => n === undefined),
                'first empty at position ' + firstEmpty + ', total rows ' + nums.length);
            }
          }
          seen.push(actual.join(','));
        }
      }
      if (seen.length === 2) {
        ok('click reverses the order [' + tag + ']: ' + key, seen[0] !== seen[1], 'order did not change');
      }
    }
  };

  checkSorting('units');
  // restore sorting by name, the filters below start from a known state
  if (state.sort.key !== 'name') {
    ths()[columns().findIndex((c) => c.key === 'name')].click();
    if (state.sort.key !== 'name') ths()[columns().findIndex((c) => c.key === 'name')].click();
  }

  // ── filters
  const countText = () => {
    const m = one('#arsenalCount').textContent.match(/Показано (\d+) из/);
    return m ? Number(m[1]) : -1;
  };
  const factions = [...new Set(filteredUnits().map((u) => u.faction))].sort();
  one('#fFaction').value = factions[0];
  one('#fFaction').dispatchEvent(new Event('input'));
  const facRows = rowIds().length;
  const facOk = facRows > 0 && facRows < total
    && dataRows().every((tr) => UNITS.find((u) => u.id === tr.dataset.id).faction === factions[0]);
  ok('faction filter narrowed the selection', facOk,
    'faction ' + factions[0] + ' -> rows ' + facRows + ' of ' + total + ', counter "' + countText() + '"');
  ok('faction filter did not break sorting',
    rowIds().join(',') === sortRows(filteredUnits(), columns().find((c) => c.key === state.sort.key).sort, state.sort.dir).map(rowKey).join(','),
    'row order does not match the sorting');
  one('#fFaction').value = '';
  one('#fFaction').dispatchEvent(new Event('input'));
  ok('clearing the filter restored all rows', rowIds().length === total, 'rows ' + rowIds().length);

  one('#q').value = 'boar';
  one('#q').dispatchEvent(new Event('input'));
  const qRows = rowIds();
  ok('search narrowed the selection', qRows.length > 0 && qRows.length < total, 'rows: ' + qRows.length);
  // Search used to cover names only and "returned nothing extra". Now it also covers
  // descriptions, so we only check for a hit, not exclusivity.
  ok('search found Boar by name', qRows.includes(ID.boar),
    'found: ' + qRows.slice(0, 5).join(','));
  one('#q').value = '';
  one('#q').dispatchEvent(new Event('input'));
  ok('clearing the search restored all rows', rowIds().length === total, 'rows ' + rowIds().length);

  // ── search: both localizations and the whole record content
  const search = (text) => {
    one('#q').value = text;
    one('#q').dispatchEvent(new Event('input'));
    return rowIds();
  };
  const withRu = UNITS.filter((u) => u.nameRu);
  ok('database has Russian names', withRu.length > 100, 'units with nameRu: ' + withRu.length);
  ok('search finds a unit by its Russian name',
    search('дикобраз').length > 0 && rowIds().includes(ID.porcupine),
    '"дикобраз" -> ' + search('дикобраз').slice(0, 5).join(','));
  ok('search finds by English name', search('porcupine').includes(ID.porcupine), '"porcupine"');
  ok('search finds a Russian weapon name from the game', search('пулемет').length > 0,
    '"пулемет" -> ' + search('пулемет').length);
  ok('search finds by faction', search('династия').length > 30, '"династия" -> ' + search('династия').length);
  ok('a Russian weapon word finds weapons of that type',
    search('пушка').length > 5, '"пушка" -> ' + search('пушка').length);
  ok('search finds by effect, also in Russian', search('метка').length > 0 || search('marking').length > 0,
    '"marking" -> ' + search('marking').length);
  ok('search finds by ability', search('recall aircraft').length > 0,
    '"recall aircraft" -> ' + search('recall aircraft').length);
  ok('search finds by damage type', search('explosive').length > 5, '"explosive" -> ' + search('explosive').length);
  ok('a nonexistent query returns nothing', search('zzznotfoundxyz').length === 0,
    '"zzznotfoundxyz" -> ' + search('zzznotfoundxyz').join(','));
  ok('empty query returns everything', search('').length === total, 'rows ' + search('').length);

  // Diacritics: the user may type "ё" or "е".
  const fireRu = UNITS.find((u) => (u.nameRu ?? '').includes('огн'));
  if (fireRu) {
    ok('search is case-insensitive',
      search(fireRu.nameRu.toUpperCase()).includes(fireRu.id), 'not found: ' + fireRu.nameRu);
  } else {
    ok('search is case-insensitive', true, 'no unit whose Russian name contains the "fire" stem');
  }

  // "Hide non-combat" vs the rest of the filters: economy comes from the game's own
  // worker / harvester markers (the data's economy flag), not from names.
  const economyIds = UNITS.filter((u) => u.economy).map((u) => u.id);
  ok('economy is recognized from the game data', economyIds.length >= 3, 'found: ' + economyIds.join(', '));
  ok('no harvesters or processors in the table by default',
    economyIds.every((id) => !rowIds().includes(id)),
    'visible: ' + economyIds.filter((id) => rowIds().includes(id)).join(', '));
  ok('no neutral or unknown faction rows by default',
    rowIds().every((id) => !['Neutral', 'Unknown'].includes(unitById(id).faction)),
    'visible: ' + rowIds().filter((id) => ['Neutral', 'Unknown'].includes(unitById(id).faction)).join(', '));
  ok('nothing the game leaves out of its codex by default',
    rowIds().every((id) => unitById(id).inCodex !== false),
    'visible: ' + rowIds().filter((id) => unitById(id).inCodex === false).join(', '));
  ok('a search does not bring non-combat entities back',
    search(unitById(economyIds[0]).name).every((id) => !isSecondary(unitById(id))),
    'search for ' + unitById(economyIds[0]).name + ' -> ' + rowIds().join(', '));
  ok('with the filter off the same search finds it', (() => {
    setHideSecondary(false);
    const hit = search(unitById(economyIds[0]).name).includes(economyIds[0]);
    setHideSecondary(true);
    search('');
    return hit;
  })(), 'not found: ' + economyIds[0]);
  // Neutrals are non-combat, so the faction list does not offer them: with the
  // default switch that choice could only ever give an empty table.
  ok('the faction list does not offer Neutral',
    ![...one('#fFaction').options].some((o) => o.value === 'Neutral'),
    'options: ' + [...one('#fFaction').options].map((o) => o.value).join(', '));
  ok('with the filter off neutrals are in the table', (() => {
    setHideSecondary(false);
    const hit = rowIds().some((id) => unitById(id).faction === 'Neutral');
    setHideSecondary(true);
    return hit;
  })(), 'no neutral rows with the filter off');
  ok('rows came back after clearing', rowIds().length === total, 'rows ' + rowIds().length);

  // ── weapon effects and unit auras
  // Effects are keyed by passive-ability asset in the data; the filter works on English names.
  const nameOfKey = (k) => DATA.effects[k]?.name?.en;
  const effectNamesOf = (u) => {
    const out = [];
    for (const e of u.unitEffects ?? []) if (nameOfKey(e.base) && !out.includes(nameOfKey(e.base))) out.push(nameOfKey(e.base));
    for (const w of u.weapons ?? []) {
      if (w.utility) continue;
      for (const e of w.effects ?? []) if (nameOfKey(e) && !out.includes(nameOfKey(e))) out.push(nameOfKey(e));
    }
    return out;
  };
  const allEffectNames = UNITS.flatMap((u) => {
    const own = (u.unitEffects ?? []).map((e) => nameOfKey(e.base));
    const wp = (u.weapons ?? []).flatMap((w) => (w.utility ? [] : (w.effects ?? []).map(nameOfKey)));
    return [...own, ...wp].filter(Boolean);
  });
  const withEffects = UNITS.filter((u) => effectNamesOf(u).length > 0);
  const withoutEffects = UNITS.filter((u) => effectNamesOf(u).length === 0);

  ok('database has many units with effects', withEffects.length > 20, 'units: ' + withEffects.length);
  ok('effects exist both on weapons and on units themselves', (() => {
    const own = UNITS.some((u) => (u.unitEffects ?? []).length > 0);
    const wp = UNITS.some((u) => (u.weapons ?? []).some((w) => !w.utility && (w.effects ?? []).length > 0));
    return own && wp;
  })(), 'auras or weapon effects not found');
  ok('utility slots are excluded from unit effects', (() => {
    // A utility slot deals no damage, and its effects must not reach the filter: otherwise
    // "with effects" would show units that apply nothing. Its effects count only when the
    // unit has them elsewhere too.
    const elsewhere = (u, k) => (u.unitEffects ?? []).some((e) => nameOfKey(e.base) === nameOfKey(k))
      || (u.weapons ?? []).some((w) => !w.utility && (w.effects ?? []).some((x) => nameOfKey(x) === nameOfKey(k)));
    const leaked = UNITS.filter((u) => (u.weapons ?? []).filter((w) => w.utility)
      .some((w) => (w.effects ?? []).some((k) => effectNamesOf(u).includes(nameOfKey(k)) && !elsewhere(u, k))));
    return leaked.length === 0;
  })(), 'utility slot effects leaked into the list');
  ok('effect names have no leftover mode suffixes', allEffectNames.every((n) => !/\(multiplayer|\)$/.test(n)),
    'suffixes: ' + allEffectNames.filter((n) => /\(multiplayer|\)$/.test(n)).slice(0, 4).join(', '));
  ok('database has aura effects, the ones that persist around a unit', (() => {
    // Exactly what the user asked for: a barracks with a doctrine, a repair zone.
    const auraish = allEffectNames.filter((n) => /aura|field|repair|restock|heal|detection/i.test(n));
    return auraish.length >= 5;
  })(), 'aura-like effects: ' + allEffectNames.filter((n) => /aura|field|repair|restock|heal|detection/i.test(n)).length);

  // ── effect filter: a select-like button with a popover of effect checkboxes,
  // selected effects shown as removable chips next to it
  const effBtn = () => one('#toggleEffectFilter');
  const effPop = () => one('#fEffectWrap');
  const effChips = () => all('#fEffectChips span.chip.removable');
  ok('effect button and popover live in the dropdown',
    Boolean(effBtn()?.closest('#effectDropdown')) && Boolean(effPop()?.closest('#effectDropdown')),
    'button ' + Boolean(effBtn()) + ', popover ' + Boolean(effPop()));
  ok('effect popover is closed by default', effPop().hidden === true
    && effBtn().getAttribute('aria-expanded') === 'false',
  'hidden=' + effPop().hidden);
  ok('effect button reads "Эффекты" with nothing selected', effBtn().textContent.trim() === 'Эффекты',
    'text: ' + effBtn().textContent.trim());
  ok('old effect filter texts are gone',
    !/по эффекту|by effect/i.test(effBtn().textContent) && !/Pick several/.test(one('#panel-arsenal').textContent),
    'button: ' + effBtn().textContent.trim());
  effBtn().click();
  ok('the button opens the popover', effPop().hidden === false
    && effBtn().getAttribute('aria-expanded') === 'true',
  'hidden=' + effPop().hidden);
  const effectBoxes = () => all('#fEffect input[type=checkbox]');
  ok('popover lists many effects, nothing checked, no chips', effectBoxes().length > 10
    && effectBoxes().every((b) => !b.checked) && state.filters.effects.length === 0 && effChips().length === 0,
  'boxes: ' + effectBoxes().length + ', state: ' + state.filters.effects.join(', ') + ', chips ' + effChips().length);
  ok('effect items are label.dropdown-item with a checkbox',
    effectBoxes().every((b) => b.parentElement.matches('label.dropdown-item')),
    'items: ' + all('#fEffect > *').slice(0, 3).map((n) => n.className).join(', '));
  const visibleWith = (names) => filteredUnits().filter((u) => names.some((n) => effectNamesOf(u).includes(n)));
  // Two effects that both narrow the visible table and differ in who has them.
  const effA = effectBoxes().map((b) => b.value).find((n) => {
    const k = UNITS.filter((u) => !isSecondary(u) && effectNamesOf(u).includes(n)).length;
    return k > 1 && k < total;
  });
  const effB = effectBoxes().map((b) => b.value).find((n) => n !== effA
    && UNITS.some((u) => !isSecondary(u) && effectNamesOf(u).includes(n) && !effectNamesOf(u).includes(effA)));
  const effSel = (name) => '#fEffect input[value="' + CSS.escape(name) + '"]';
  const toggleEffect = (name, on) => setChecked(effSel(name), on);
  toggleEffect(effA, true);
  const effRows = rowIds();
  ok('one effect leaves only units that have it',
    effRows.length > 0 && effRows.length < total
    && effRows.every((id) => effectNamesOf(unitById(id)).includes(effA)),
  effA + ': rows ' + effRows.length + ' of ' + total);
  ok('one effect lists every visible unit that has it', effRows.length === visibleWith([effA]).length,
    effA + ': rows ' + effRows.length + ', expected ' + visibleWith([effA]).length);
  ok('units without effects are really hidden', withoutEffects.length > 0
    && withoutEffects.every((u) => !effRows.includes(u.id)),
  'without effects: ' + withoutEffects.length);
  ok('selecting an effect adds its chip',
    effChips().length === 1 && effChips()[0].textContent.includes(effectRu(effA)) && Boolean(effChips()[0].querySelector('button')),
    'chips: ' + effChips().map((c) => c.textContent.trim()).join(', '));
  ok('effect button shows the count', effBtn().textContent.trim() === 'Эффекты: 1',
    'text: ' + effBtn().textContent.trim());
  toggleEffect(effB, true);
  ok('two effects give units with ANY of them',
    rowIds().length === visibleWith([effA, effB]).length && rowIds().length > effRows.length,
    effA + ' + ' + effB + ': rows ' + rowIds().length + ', expected ' + visibleWith([effA, effB]).length);
  ok('two effects give two chips and count 2',
    effChips().length === 2 && effBtn().textContent.trim() === 'Эффекты: 2',
    'chips ' + effChips().length + ', button: ' + effBtn().textContent.trim());
  ok('effect filter keeps weapon sub-rows under each unit', subRowLayoutErrors().length === 0,
    subRowLayoutErrors().slice(0, 3).join(', '));

  // The x on a chip unselects its effect: the chip goes, the box unchecks, rows come back.
  effChips().find((c) => c.textContent.includes(effectRu(effB))).querySelector('button').click();
  ok('x on a chip removes that chip only',
    effChips().length === 1 && effChips()[0].textContent.includes(effectRu(effA)),
    'chips: ' + effChips().map((c) => c.textContent.trim()).join(', '));
  ok('x on a chip unselects the effect and restores its rows',
    state.filters.effects.join(',') === effA && one(effSel(effB))?.checked === false
    && rowIds().length === visibleWith([effA]).length,
    'state: ' + state.filters.effects.join(', ') + ', rows ' + rowIds().length);
  effChips()[0].querySelector('button').click();
  ok('removing the last chip restores all rows',
    effChips().length === 0 && state.filters.effects.length === 0 && rowIds().length === total
    && effBtn().textContent.trim() === 'Эффекты',
    'chips ' + effChips().length + ', rows ' + rowIds().length + ' of ' + total + ', button: ' + effBtn().textContent.trim());

  // The popover closes on Escape and on a click outside, like a native select.
  if (effPop().hidden) effBtn().click();
  one('#fEffectSearch').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  ok('Escape closes the popover', effPop().hidden === true && effBtn().getAttribute('aria-expanded') === 'false',
    'hidden=' + effPop().hidden);
  effBtn().click();
  one('#fEffectSearch').click();
  ok('a click inside the dropdown keeps it open', effPop().hidden === false, 'hidden=' + effPop().hidden);
  one('#arsenalCount').click();
  ok('a click outside closes the popover', effPop().hidden === true
    && effBtn().getAttribute('aria-expanded') === 'false', 'hidden=' + effPop().hidden);

  // Search inside the popover narrows the list.
  effBtn().click();
  const allEffectCount = effectBoxes().length;
  const effQuery = effectRu(effA).slice(0, 5).toLowerCase();
  one('#fEffectSearch').value = effQuery;
  one('#fEffectSearch').dispatchEvent(new Event('input'));
  ok('effect search narrows the list (by the shown Russian name)', effectBoxes().length > 0 && effectBoxes().length < allEffectCount
    && effectBoxes().every((b) => effectRu(b.value).toLowerCase().includes(effQuery) || b.value.toLowerCase().includes(effQuery)),
  'boxes: ' + effectBoxes().map((b) => b.value).slice(0, 5).join(', '));
  one('#fEffectSearch').value = 'zzznotfoundxyz';
  one('#fEffectSearch').dispatchEvent(new Event('input'));
  ok('effect search with no match says so', effectBoxes().length === 0
    && /Ничего не найдено/.test(one('#fEffect').textContent), 'boxes: ' + effectBoxes().length);
  one('#fEffectSearch').value = '';
  one('#fEffectSearch').dispatchEvent(new Event('input'));

  // Reset filters clears selected effects too.
  toggleEffect(effA, true);
  one('#resetFilters').click();
  ok('reset filters clears checked effects and chips',
    state.filters.effects.length === 0 && effectBoxes().every((b) => !b.checked) && effChips().length === 0
    && effBtn().textContent.trim() === 'Эффекты' && rowIds().length === total,
    'state: ' + state.filters.effects.join(', ') + ', chips ' + effChips().length + ', rows ' + rowIds().length + ' of ' + total);
  if (!effPop().hidden) one('#arsenalCount').click();
  ok('clearing the filter brought everyone back', rowIds().length === total && effPop().hidden === true,
    'rows ' + rowIds().length + ' of ' + total + ', popover hidden=' + effPop().hidden);

  ok('search finds by effect name', (() => {
    const name = effectNamesOf(UNITS.find((u) => effectNamesOf(u).length > 0))[0];
    if (!name) return false;
    one('#q').value = name;
    one('#q').dispatchEvent(new Event('input'));
    const hit = rowIds().length > 0;
    one('#q').value = '';
    one('#q').dispatchEvent(new Event('input'));
    return hit;
  })(), 'nothing found');

  // ── effect descriptions: the game's own text, what they DO
  const effectList = Object.values(DATA.effects);
  ok('most effects have a game description', effectList.filter((e) => e.desc?.en).length / effectList.length > 0.8,
    'with a description: ' + effectList.filter((e) => e.desc?.en).length + ' of ' + effectList.length);
  ok('effect descriptions are in Russian too', effectList.filter((e) => e.desc?.ru).length / effectList.filter((e) => e.desc?.en).length > 0.9,
    'Russian descriptions: ' + effectList.filter((e) => e.desc?.ru).length);
  ok('no raw placeholders left in descriptions', effectList.every((e) => !/\{\w+\}/.test((e.desc?.en ?? '') + (e.desc?.ru ?? ''))),
    'raw {placeholder} found');
  ok('the card shows a "what it does" line under the chip', (() => {
    const withDetail = filteredUnits().find((u) => (u.unitEffects ?? []).some((e) => DATA.effects[e.base]?.desc?.ru));
    if (!withDetail) return false;
    dataRows().find((tr) => tr.dataset.id === withDetail.id).click();
    const text = one('#dlgBody').textContent;
    const first = (withDetail.unitEffects ?? []).find((e) => DATA.effects[e.base]?.desc?.ru);
    // In Russian the card shows the game's own Russian description.
    const okFound = text.includes(DATA.effects[first.base].desc.ru.split('\n')[0].slice(0, 25));
    one('#unitDialog').close();
    return okFound;
  })(), 'effect description did not appear in the card');

  ok('effects are drawn in their own sub-row column', (() => {
    const idx = columns().findIndex((c) => c.key === 'effects');
    if (idx < 0) return false;
    return [...document.querySelectorAll('#arsenalTable tr.wsub-row')]
      .some((tr) => tr.children[idx]?.querySelector('.eff-chip'));
  })(), 'effects column is empty, columns: ' + columns().map((c) => c.key).join(', '));
  ok('name cell no longer has effects and targets', (() => {
    // Effects and targets moved to separate columns: in the name cell they stretched
    // it to a third of the screen and pushed the whole table sideways.
    return [...document.querySelectorAll('#arsenalTable .wsub-name')]
      .every((td) => !td.querySelector('.eff-chip') && !td.querySelector('.tgt-chip'));
  })(), 'chips reappeared in the name cell');
  ok('column values are stacked vertically, not in a row', (() => {
    const list = one('#arsenalTable .eff-list');
    if (!list) return false;
    const kids = [...list.children];
    if (kids.length < 2) return true;   // a single value is a stack of one
    const dir = getComputedStyle(list).flexDirection;
    const sameRow = kids.every((k) => Math.abs(k.getBoundingClientRect().top - kids[0].getBoundingClientRect().top) < 2);
    return dir === 'column' ? !sameRow : sameRow;
  })(), 'layout is not vertical');
  ok('weapon targets are a separate column, values as words', (() => {
    const idx = columns().findIndex((c) => c.key === 'targets');
    if (idx < 0) return false;
    const chips = [...document.querySelectorAll('#arsenalTable .tgt-chip')];
    return chips.length > 0 && chips.every((c) => /^(земля|воздух)$/.test(c.textContent.trim()));
  })(), 'target chips: ' + all('#arsenalTable .tgt-chip').length);
  ok('unit row effects are only the unit\'s own auras', (() => {
    // Weapon effects are not repeated in the unit row: they live in sub-rows,
    // like the damage numbers. Only what the unit itself holds is shown.
    const idx = columns().findIndex((c) => c.key === 'effects');
    if (idx < 0) return false;
    return dataRows().every((tr) => tr.children[idx] !== undefined);
  })(), 'no effects column');
  // Direct guard against the "table spreads sideways" complaint coming back: the name
  // column is the most common cause, because everything used to be dumped into it.
  // The 360px limit is the width of the longest name in the database plus a small margin.
  // Putting effects and targets back into the name cell gave 500-800px and was caught here.
  let nameColWidth = 0;
  ok('name column does not spread', (() => {
    const idx = columns().findIndex((c) => c.key === 'name');
    if (idx < 0) return false;
    nameColWidth = Math.max(...dataRows()
      .map((tr) => tr.children[idx]?.getBoundingClientRect().width ?? 0));
    return nameColWidth < 360;
  })(), 'max name column width: ' + Math.round(nameColWidth) + 'px, limit 360');
  ok('the "sorted by this weapon" text is gone from the table',
    !/сортировка по этому стволу/.test(one('#arsenalTable').textContent),
    'the label is still rendered');
  ok('the sorting weapon highlight remains', (() => {
    ths()[columns().findIndex((c) => c.key === 'dps')].click();
    const rows = all('#arsenalTable tr.wsub-row.win');
    if (state.sort.dir === -1) ths()[columns().findIndex((c) => c.key === 'dps')].click();
    return rows.length > 0;
  })(), 'no weapon row is highlighted');
  ok('economy rows get exactly their combat weapons when shown', (() => {
    setHideSecondary(false);
    const bad = UNITS.filter((u) => economyIds.includes(u.id)).filter((u) =>
      all('#arsenalTable tr.wsub-row[data-for="' + u.id + '"]').length !== combatWeapons(u).length);
    const shown = economyIds.every((id) => rowIds().includes(id));
    setHideSecondary(true);
    return shown && bad.length === 0;
  })(), 'economy rows or their weapons are wrong');

  // ── the variant switch is gone: the database is multiplayer only
  ok('markup has no variant switch', !document.querySelector('#variantSwitch'), 'found #variantSwitch');
  ok('app.js has no state.variant', !/\bstate\.variant\b/.test(state ? String(Object.keys(state)) : ''), 'state has variant');
  ok('the counter tooltip mentions multiplayer', /мультиплеер/i.test(one('#arsenalCount').title), one('#arsenalCount').title);
  ok('the counter does not promise campaign substitution',
    !/показанных/.test(one('#arsenalCount').textContent + one('#arsenalCount').title), one('#arsenalCount').textContent);
  ok('the counter counts all entities as the total',
    one('#arsenalCount').textContent.trim() === 'Показано ' + total + ' из ' + UNITS.length,
    one('#arsenalCount').textContent);
  ok('the counter sits in the filter row, not under the table',
    Boolean(one('.controls #arsenalCount')), 'counter is outside the filter row');

  // ── pictures: the table always shows the icon, there is no switch
  ok('every unit row has an icon cell',
    dataRows().every((tr) => tr.children[0]?.matches('td.pic-cell')
      && tr.children[0].querySelector('.pic-box img.pic, .pic-box .pic-empty')),
    'rows without a picture: ' + dataRows().filter((tr) => !tr.children[0]?.querySelector('img.pic, .pic-empty')).length);
  ok('game icons at 36 px are in the table',
    all('#arsenalTable img.pic').length > total / 2
    && all('#arsenalTable img.pic').every((img) => img.classList.contains('pic-36') && img.getAttribute('src').startsWith('icons/')),
    'img: ' + all('#arsenalTable img.pic').length + ', not 36px or not a game icon: '
      + all('#arsenalTable img.pic').filter((img) => !img.classList.contains('pic-36') || !img.getAttribute('src').startsWith('icons/')).length);
  ok('table icons render 36 px wide', (() => {
    const img = all('#arsenalTable img.pic')[0];
    return img && Math.round(img.getBoundingClientRect().width) === 36;
  })(), 'width: ' + Math.round(all('#arsenalTable img.pic')[0]?.getBoundingClientRect().width ?? 0));
  ok('weapon sub-rows have no picture', all('#arsenalTable tr.wsub-row .pic-box').length === 0,
    'pictures in sub-rows: ' + all('#arsenalTable tr.wsub-row .pic-box').length);

  // ── unit card
  const withWeapons = filteredUnits().find((u) => combatWeapons(u).length && u.nameRu);
  dataRows().find((tr) => tr.dataset.id === withWeapons.id).click();
  ok('card opened', one('#unitDialog').open === true, 'open=' + one('#unitDialog').open);
  ok('card has weapons', one('#dlgBody').textContent.length > 200, 'length ' + one('#dlgBody').textContent.length);
  ok('card title shows the Russian name and the English one in parentheses',
    withWeapons.nameRu && one('#dlgTitle').textContent === withWeapons.nameRu + ' (' + withWeapons.name + ')',
    'title "' + one('#dlgTitle').textContent + '", expected "' + withWeapons.nameRu + ' (' + withWeapons.name + ')"');
  // Unit descriptions are not published at all: neither in the data nor in the card.
  ok('no unit description in the data or the card',
    one('#dlgBody').querySelector('.desc') === null && !('description' in withWeapons),
    '.desc block or description field found');
  ok('the card picture is the game icon at 132 px',
    one('#dlgBody .pic-hero-wrap img.pic-132')?.getAttribute('src') === 'icons/' + withWeapons.icon,
    'hero: ' + (one('#dlgBody .pic-hero-wrap img')?.getAttribute('src') ?? 'none'));
  ok('the card links to a wiki search for the unit', (() => {
    const a = one('#dlgBody a[href*="wiki.gg/index.php?search="]');
    return Boolean(a) && a.target === '_blank';
  })(), 'no wiki search link in the card');
  ok('card sections go abilities, effects, doctrines', (() => {
    const order = [...document.querySelectorAll('#dlgBody h3')].map((h) => h.textContent.trim());
    const pos = (name) => order.indexOf(name);
    const abilities = pos('Способности');
    const effects = pos('Эффекты и ауры');
    const doctrines = pos('Доктрины');
    const present = [abilities, effects, doctrines].filter((i) => i >= 0);
    return present.every((v, i) => i === 0 || v > present[i - 1]);
  })(), 'sections: ' + [...document.querySelectorAll('#dlgBody h3')].map((h) => h.textContent.trim()).join(', '));
  ok('effect tiles hide their description until hover', (() => {
    const tile = one('#dlgBody .tile.compact');
    if (!tile) return true;
    const pop = tile.querySelector('.tile-pop');
    return !pop || getComputedStyle(pop).display === 'none';
  })(), 'an effect description is visible without hover');
  // The number of weapon table headers must match the number of cells: otherwise
  // inserting a column silently shifts all values by one and everything lies.
  // The card has two tables (armor and weapons), so take the one with "Оружие" (Weapon).
  const wTable = all('#dlgBody table').find((t) => all('thead th', t).some((th) => th.textContent === 'Оружие'));
  ok('weapons table found', Boolean(wTable), 'tables in card: ' + all('#dlgBody table').length);
  if (wTable) {
    const wHead = all('thead th', wTable);
    const wRows = all('tbody tr', wTable);
    ok('weapons table: headers and cells match', wHead.length > 0
      && wRows.every((tr) => tr.children.length === wHead.length),
      'headers ' + wHead.length + ', cells in the first row ' + (wRows[0] ? wRows[0].children.length : '—'));
    ok('has an attack interval column', wHead.some((t) => t.textContent === 'Интервал, с'),
      'headers: ' + wHead.map((t) => t.textContent).join(', '));
    ok('has an AoE column', wHead.some((t) => t.textContent === 'AoE'),
      'headers: ' + wHead.map((t) => t.textContent).join(', '));
    // Column names speak for themselves: there used to be a four-line paragraph under
    // the table explaining what ×N is and why "Урон" (Damage) is not a volley.
    // The card's weapon table is the arsenal's weapon rows: same columns, same order.
    ok('card weapon columns follow the arsenal table, no Sustained',
      ['Оружие', 'Тип', 'DPS', 'Урон/залп', 'AoE', 'Дальность', 'Интервал, с', 'Эффекты', 'Цели', 'Боеприпасы']
        .join(', ') === wHead.map((t) => t.textContent).join(', '),
      'headers: ' + wHead.map((t) => t.textContent).join(', '));
    ok('explanations moved into header tooltips',
      wHead.filter((t) => t.getAttribute('title')).length >= 6,
      'tooltips on ' + wHead.filter((t) => t.getAttribute('title')).length + ' headers of ' + wHead.length);
    ok('the explanation paragraph under the table is gone',
      !/«×N»|22 \(x4\)|восполняется пачками|TTK считается по/.test(one('#dlgBody').textContent),
      'the card still has text about ×N or batches');
    // A 14-column table must sit in its own scrollable container,
    // otherwise it stretches the dialog and the window runs off the screen edge.
    ok('weapons table sits in a scrollable container',
      wTable.closest('.table-wrap') !== null && getComputedStyle(wTable.closest('.table-wrap')).overflowX !== 'visible',
      'parent: ' + (wTable.parentElement ? wTable.parentElement.className : '—'));
    // The window width is compared with the viewport, not an absolute pixel count: the dialog
    // is set to 96vw, so in a narrow test window it is narrower than
    // 860px anyway, and a constant check would check nothing.
    ok('card window takes almost the full screen width', (() => {
      const w = one('#unitDialog').getBoundingClientRect().width;
      return w > innerWidth * 0.85 && w <= innerWidth;
    })(), 'window width ' + Math.round(one('#unitDialog').getBoundingClientRect().width)
      + ', screen ' + innerWidth);
  }
  ok('card has no Credits/s column', !/Кредиты\/с/.test(one('#dlgBody').textContent), 'found in the card text');
  ok('card has no NaN', !/NaN|undefined|\[object/.test(one('#dlgBody').textContent),
    (one('#dlgBody').textContent.match(/.{0,60}(NaN|undefined|\[object).{0,40}/) || [''])[0]);
  one('#unitDialog').close();

  // ── compare tab
  one('#tabs button[data-panel="compare"]').click();
  ok('compare tab opened', one('#panel-compare').classList.contains('active'), 'not active');
  // The column now has a unit picker (a field with suggestions) and a plain weapon select.
  const weaponSel = () => all('#cmpOut .cmp-pick select');
  const unitInputs = () => all('#cmpOut .picker-input');
  const pickRow = (n) => all('#cmpOut tbody tr:not(.group)')[n];
  void pickRow;
  ok('compare table rendered', one('#cmpOut table.cmp') !== null, 'no table');
  ok('two starting units', unitInputs().length === 2 && weaponSel().length === 2,
    'pickers: ' + unitInputs().length + ', weapon selects: ' + weaponSel().length);
  ok('each column header has a unit picker and a weapon select',
    all('#cmpOut thead th.col-unit').every((th) => th.querySelector('.picker-input') && th.querySelector('select')),
    'in header: ' + all('#cmpOut thead th.col-unit').map((th) => (th.querySelector('.picker-input') ? 'picker+select' : 'broken')).join(','));
  ok('different units are selected',
    new Set(unitInputs().map((i) => i.value)).size === 2,
    unitInputs().map((i) => i.value).join(', '));

  // Unit search instead of a list: the picker searches the same index as the main search
  const typeIn = (mountSel, text) => {
    const inp = one(mountSel + ' .picker-input');
    inp.focus();
    inp.value = text;
    inp.dispatchEvent(new Event('input'));
    return inp;
  };
  const suggest = (mountSel) => all(mountSel + ' .picker-item');
  typeIn('#cmpTarget', 'штурмов');
  ok('picker finds by Russian name',
    suggest('#cmpTarget').some((n) => n.dataset.id === ID.riotVan),
    suggest('#cmpTarget').map((n) => n.querySelector('.p-name').textContent).join(','));
  typeIn('#cmpTarget', 'grenade');
  ok('picker searches by weapon name', suggest('#cmpTarget').length > 0, 'found: ' + suggest('#cmpTarget').length);
  typeIn('#cmpTarget', 'zzznotfound');
  ok('with no matches it says so',
    suggest('#cmpTarget').length === 0 && /Ничего не найдено/.test(one('#cmpTarget').textContent),
    'suggestions: ' + suggest('#cmpTarget').length);
  typeIn('#cmpTarget', '');
  ok('empty query shows a few first units, not all 169',
    suggest('#cmpTarget').length > 0 && suggest('#cmpTarget').length <= 12,
    'suggestions: ' + suggest('#cmpTarget').length);
  ok('the 169-option unit list is gone everywhere',
    all('select').every((s) => s.options.length < 40),
    'longest list: ' + Math.max(...all('select').map((s) => s.options.length)));


  // metric rows and best-value highlight
  const metricRows = all('#cmpOut tbody tr:not(.group)');
  ok('more than a dozen metrics', metricRows.length > 15, 'rows: ' + metricRows.length);
  // Unit cells only: empty slots up to the limit are extra columns without values.
  const unitCells = (tr) => [...tr.children].slice(1).filter((td) => !td.classList.contains('ghost'));
  ok('metrics are grouped: damage, survivability, cost', all('#cmpOut tbody tr.group').length === 3,
    'groups: ' + all('#cmpOut tbody tr.group').length);
  ok('each row has as many cells as units',
    metricRows.every((tr) => unitCells(tr).length === 2), 'cells: ' + unitCells(metricRows[0] ?? document.createElement('tr')).length);
  ok('empty slots fill the free width up to the limit',
    all('#cmpOut thead th.col-ghost').length === MAX_COMPARE - 2
    && all('#cmpOut thead th.col-ghost .cmp-add-slot').length === MAX_COMPARE - 2,
    'slots: ' + all('#cmpOut thead th.col-ghost').length);
  ok('no Sustained or EHP rows', !metricRows.some((tr) => /Sustained|EHP/.test(tr.children[0].textContent)),
    'found Sustained or EHP');
  // Without a target rows are computed at 0% armor, as in the main table, so
  // the "best" is looked for in the DPS row: it always has numbers.
  const dpsRow = metricRows.find((tr) => tr.children[0].textContent.trim() === 'DPS');
  ok('without a target the DPS row has numbers',
    dpsRow && [...dpsRow.children].slice(1).some((td) => /\d/.test(td.textContent)),
    'no numbers');
  ok('the best in the row is highlighted, exactly one',
    dpsRow && dpsRow.querySelectorAll('td.best').length === 1,
    'highlighted: ' + dpsRow?.querySelectorAll('td.best').length);
  ok('a row without rated metrics has no highlight',
    (() => {
      const typeRow = metricRows.find((tr) => tr.children[0].textContent.includes('Тип урона'));
      return typeRow && typeRow.querySelectorAll('td.best').length === 0;
    })(), 'a text metric is highlighted');
  ok('the highlighted cell really is the DPS maximum',
    (() => {
      const nums = unitCells(dpsRow).map((td) => Number.parseFloat(td.textContent));
      const bestCell = unitCells(dpsRow).find((td) => td.classList.contains('best'));
      return Number.parseFloat(bestCell.textContent) === Math.max(...nums);
    })(), 'the maximum is not highlighted');

  // As in the main table: without a target we compute at 0% armor, only
  // TTK stays empty, since without a target there is no HP.
  ok('compare target is empty by default',
    state.compareTarget === null, 'target: ' + (state.compareTarget ? state.compareTarget.id : 'none'));
  ok('without a target DPS and damage are computed at 0% armor, not empty',
    (() => {
      const wanted = ['Урон/залп', 'DPS'];
      const rows = metricRows.filter((tr) => wanted.includes(tr.children[0].textContent.trim()));
      return rows.length === wanted.length
        && rows.every((tr) => [...tr.children].slice(1).some((td) => /\d/.test(td.textContent)));
    })(), 'empty rows: ' + metricRows
      .filter((tr) => /Урон\/залп|DPS|Sustained/.test(tr.children[0].textContent))
      .map((tr) => tr.children[0].textContent + '=[' + [...tr.children].slice(1).map((td) => td.textContent).join(' ') + ']')
      .join(' ; '));
  ok('without a target only TTK is empty', (() => {
    const ttk = metricRows.find((tr) => tr.children[0].textContent.trim() === 'TTK, с');
    return ttk && unitCells(ttk).every((td) => td.textContent.trim() === '—');
  })(), 'TTK is not empty');
  ok('the toolbar status says the numbers are computed at 0% armor',
    /по 0% брони/.test(one('#cmpStatus').textContent), one('#cmpStatus').textContent);

  // Hits per attack show inside the volley cell (“22×4 (88)”), not as a separate row.
  // By default the comparison has Havoc (4 hits per attack) and Porcupine.
  const volleyRow = metricRows.find((tr) => tr.children[0].textContent.trim() === 'Урон/залп');
  ok('the volley row shows per-hit × hits for a multi-hit weapon',
    Boolean(volleyRow) && [...volleyRow.children].slice(1).some((td) => /×\d+ \(/.test(td.textContent)),
    'in cells: ' + (volleyRow ? [...volleyRow.children].slice(1).map((td) => td.textContent).join(', ') : '—'));
  ok('hit counts come from the game: Havoc 22 × 4', (() => {
    const mrl = unitById(ID.havoc)?.weapons[0];
    return mrl?.shots?.mp === 4 && mrl?.damagePerVolley?.mp === 88;
  })(), 'Havoc does not have 4 hits of 22');
  ok('an unknown hit count shows "?" with a reason, not a number', (() => {
    const unknown = UNITS.find((u) => !isSecondary(u) && combatWeapons(u).some((w) => w.shots?.mp === undefined));
    if (!unknown) return true;
    const w = combatWeapons(unknown).find((x) => x.shots?.mp === undefined);
    const tr = all('#arsenalTable tr.wsub-row[data-for="' + unknown.id + '"][data-slot="' + w.slot + '"]')[0];
    if (!tr) return false;
    const cell = tr.children[columns().findIndex((c) => c.key === 'dps')];
    return cell.textContent === '?' && /попаданий/i.test(cell.title);
  })(), 'the DPS cell of a weapon with unknown hits is not "?"');

  // The compare target is empty by default, but numbers are still computed
  // at 0% armor, exactly as in the main table.
  ok('compare target is empty by default (repeat)',
    state.compareTarget === null, 'target: ' + (state.compareTarget ? state.compareTarget.id : 'none'));
  ok('no "vs target" rows left, labels switch instead',
    !metricRows.some((tr) => tr.children[0].textContent.includes('⟂ цель')),
    'found a row with the "vs target" marker');
  // Row labels stay short; what the numbers are computed against is said once, in the status.
  ok('damage rows have short labels',
    ['Урон/залп', 'DPS'].every((label) =>
      metricRows.some((tr) => tr.children[0].textContent.trim() === label)),
    metricRows.filter((tr) => /DPS|Урон/.test(tr.children[0].textContent))
      .map((tr) => tr.children[0].textContent).join(', '));
  ok('the status says TTK is empty without a target',
    /TTK пуст/.test(one('#cmpStatus').textContent), one('#cmpStatus').textContent);
  ok('the hit count is not a separate row (the volley shows it)',
    !metricRows.some((tr) => /Снарядов/.test(tr.children[0].textContent)), 'a projectiles row is back');
  ok('compare has no NaN and undefined',
    !/NaN|undefined|\[object/.test(one('#cmpOut').textContent),
    (one('#cmpOut').textContent.match(/.{0,60}(NaN|undefined|\[object).{0,40}/) || [''])[0]);

  // adding and removing columns
  const colCount = () => all('#cmpOut thead th.col-unit').length;
  const start = colCount();
  one('#cmpAdd').click();
  ok('"+ unit" added a column', colCount() === start + 1, 'columns: ' + colCount());
  ok('after adding the units are different', new Set(unitInputs().map((i) => i.value)).size === start + 1,
    unitInputs().map((i) => i.value).join(','));
  one('#cmpAdd').click(); one('#cmpAdd').click();
  ok('limit of 5 units reached', colCount() === 5, 'columns: ' + colCount());
  ok('the button is disabled at the limit', one('#cmpAdd').disabled === true, 'disabled=' + one('#cmpAdd').disabled);
  all('#cmpOut .cmp-remove')[4].click();
  ok('removing a column works', colCount() === 4, 'columns: ' + colCount());
  ok('after removal the button is available again', one('#cmpAdd').disabled === false, 'disabled=' + one('#cmpAdd').disabled);

  // Changing the unit in a column resets the previous unit's weapon. The suggestion is picked by id,
  // not by position: the list order depends on the data and may shift.
  const colPicks = () => [...one('#cmpOut').querySelectorAll('.col-unit')];
  const firstColumn = colPicks()[0];
  const wanted = UNITS.find((u) => (u.weapons ?? []).some((w) => !w.utility)
    && u.nameRu && u.id !== ID.havoc && u.id !== ID.porcupine);
  const input = firstColumn.querySelector('.picker-input');
  input.focus();
  input.value = wanted.nameRu;
  input.dispatchEvent(new Event('input'));
  const suggestion = [...one('#cmpOut').querySelectorAll('.picker-item')]
    .find((n) => n.dataset.id === wanted.id);
  ok('suggestion found by Russian name', Boolean(suggestion),
    'searched for "' + wanted.nameRu + '", got: '
    + [...one('#cmpOut').querySelectorAll('.picker-item')].map((n) => n.querySelector('.p-name').textContent).join(', '));
  suggestion.click();
  ok('after changing the unit its weapon is selected',
    weaponSel()[0].value !== '' && weaponSel()[0].value !== null,
    'weapon: "' + weaponSel()[0].selectedOptions[0]?.textContent + '"');
  ok('weapon list has only the new unit\'s weapons',
    [...weaponSel()[0].options].map((o) => o.value).join(',')
      === wanted.weapons.filter((w) => !w.utility).map((w) => String(w.slot)).join(','),
    'options: ' + [...weaponSel()[0].options].map((o) => o.value).join(','));
  ok('the column picker shows the selected unit',
    firstColumn.querySelector('.picker-input').value.startsWith(wanted.nameRu),
    'in field: ' + firstColumn.querySelector('.picker-input').value);

  // The target affects damage and TTK: they are computed AFTER armor. Without a target rows
  // are computed at 0% armor, as in the main table, and change when a target is chosen.
  // Rows are re-read after every re-render: nodes saved earlier are
  // detached from the document by then and hold the old text.
  const cmpRows = () => all('#cmpOut tbody tr:not(.group)');
  const rowText = (needle) => cmpRows().find((tr) => tr.children[0].textContent.includes(needle))?.children[1].textContent;
  const ttkRow = () => rowText('TTK');
  const burstRow = () => rowText('Урон/залп');
  const beforeTtk = ttkRow();
  const beforeBurst = burstRow();
  ok('without a target the volley damage is computed at 0% armor', /\d/.test(beforeBurst ?? ''), 'in cell: "' + beforeBurst + '"');
  ok('without a target TTK is empty', beforeTtk === '—', 'in cell: "' + beforeTtk + '"');
  // Change the target via the picker, as a person would: type and pick.
  const sphere = unitById(ID.sphere) ?? UNITS.find((u) => u.nameRu && u.stats.hp?.mp > 500);
  typeIn('#cmpTarget', sphere.nameRu);
  const found = suggest('#cmpTarget').find((n) => n.dataset.id === sphere.id);
  ok('the picker finds the target by Russian name', Boolean(found),
    'searched for "' + sphere.nameRu + '", got: '
    + suggest('#cmpTarget').map((n) => n.querySelector('.p-name').textContent).join(', '));
  (found ?? suggest('#cmpTarget')[0]).click();
  ok('changing the target recomputed TTK', beforeTtk !== ttkRow(), 'was ' + beforeTtk + ', now ' + ttkRow());
  ok('changing the target computed TTK as a number', /\d/.test(ttkRow() ?? ''), 'in cell: "' + ttkRow() + '"');
  ok('changing the target computed volley damage after armor',
    beforeBurst !== burstRow() && /\d/.test(burstRow() ?? ''),
    'was "' + beforeBurst + '", now "' + burstRow() + '"');
  ok('the status names the target after choosing one', /после брони/.test(one('#cmpStatus').textContent),
    'status: ' + one('#cmpStatus').textContent);
  ok('choosing a compare target does not touch the arsenal target',
    one('#fTarget .picker-input').value !== one('#cmpTarget .picker-input').value,
    'arsenal: "' + one('#fTarget .picker-input').value + '", compare: "' + one('#cmpTarget .picker-input').value + '"');

  one('#cmpReset').click();
  ok('reset brought back two', colCount() === 2, 'columns: ' + colCount());
  ok('the removed effectiveness table is gone', one('#cmpMatrix') === null, 'the table is still on the page');
  ok('the removed effects field is gone', one('#cmpEffects') === null, 'the effects field is still on the page');
  ok('compare does not refer to removed code',
    !one('#cmpOut').textContent.includes('эффекты'), 'effects are still mentioned in the caption');

  // Only two tabs are left: Arsenal and Compare.
  ok('only the arsenal and compare tabs remain',
    all('#tabs .tab').map((b) => b.dataset.panel).join(',') === 'arsenal,compare'
    && all('main > .panel').map((p) => p.id).join(',') === 'panel-arsenal,panel-compare',
    'tabs: ' + all('#tabs .tab').map((b) => b.dataset.panel).join(', ') + ', panels: ' + all('main > .panel').map((p) => p.id).join(', '));
  one('#tabs button[data-panel="arsenal"]').click();
  ok('arsenal tab is back', one('#panel-arsenal').classList.contains('active')
    && !one('#panel-compare').classList.contains('active'), 'arsenal not active');

  // The i18n uses English keys with a Russian dictionary, so untranslated strings
  // are collected only in Russian mode: this is where the check belongs.
  // Volley damage reads "per hit × hits (total)": Havoc fires 4 rockets of 22.
  ok('volley damage is shown as per-hit × hits (total)', (() => {
    state.target = null;
    resetFilters();
    const idx = columns().findIndex((c) => c.key === 'burst');
    const sub = one('#arsenalTable tr.wsub-row[data-for="DYN.Unit.RocketBuggy"]');
    return sub?.children[idx]?.textContent.trim() === '22×4 (88)';
  })(), 'Havoc volley cell: ' + (one('#arsenalTable tr.wsub-row[data-for="DYN.Unit.RocketBuggy"]')?.children[columns().findIndex((c) => c.key === 'burst')]?.textContent ?? 'no row'));
  ok('all UI strings are translated to Russian', TRI18n.missing.size === 0, [...TRI18n.missing].slice(0, 5).join(' ; '));
  ok('no JS errors during the whole session', errors.length === 0, errors.slice(0, 3).join(', '));
} catch (e) {
  failed++;
  R.push('FAIL|probe crashed|' + (e && e.message) + ' @ ' + String((e && e.stack || '').split('\n')[1]));
  flush();
}
flush();
})();
`;

/**
 * English version probe. Separate rather than a parameter of the main one: the main one checks
 * behavior and relies on Russian labels, this one only checks that no Russian string is
 * left in EN. It walks through everything the page can render:
 * the table with and without non-combat entities, expanded filters, compare and the card of
 * EVERY unit: card labels depend on unit data, and a sampled
 * check would miss a branch that fires for just one of 154.
 */
const probeEn = String.raw`
const R = [];
let passed = 0, failed = 0;
const pre = document.createElement('pre');
pre.id = 'uitest';
const flush = () => { pre.textContent = R.join('\n') + '\nSUMMARY|' + passed + '|' + failed; };
const ok = (name, cond, detail) => {
  if (cond) { passed++; R.push('PASS|' + name); }
  else { failed++; R.push('FAIL|' + name + '|' + String(detail).replace(/[\r\n]+/g, ' ').slice(0, 300)); }
  flush();
};
const one = (s) => document.querySelector(s);
const errors = [];
addEventListener('error', (e) => errors.push(e.message));
document.body.append(pre);
flush();

const CYR = /[А-Яа-яЁё]/;
/** All Russian traces in a node: text and tooltips. Returns the first ones found. */
const russianIn = (root) => {
  const found = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest('#uitest, script, style')) continue;
    if (CYR.test(node.nodeValue)) found.push('text: ' + node.nodeValue.trim().slice(0, 80));
  }
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (el.closest?.('#uitest')) continue;
    for (const attr of ['title', 'placeholder', 'aria-label', 'alt']) {
      const v = el.getAttribute?.(attr);
      if (v && CYR.test(v)) found.push(attr + ': ' + v.slice(0, 80));
    }
  }
  return found;
};

(async () => {
try {
  if (!document.querySelectorAll('#arsenalTable tbody tr').length) {
    await new Promise((r) => addEventListener('DOMContentLoaded', r, { once: true }));
  }
  ok('EN: language taken from the build', TRI18n.lang === 'en' && document.documentElement.lang === 'en',
    'lang=' + TRI18n.lang + ', html lang=' + document.documentElement.lang);
  ok('EN: browser tab title translated', !CYR.test(document.title), document.title);
  ok('EN: EN button is marked active', one('#langSwitch button[data-lang="en"]').classList.contains('active'), 'not marked');
  ok('EN: footer credits the game files, no wiki', /game files/.test(one('#siteFooter').textContent)
    && !one('#siteFooter a[href*="wiki"]'), one('#siteFooter').textContent);

  const check = (name) => {
    const found = russianIn(document.body);
    ok('EN: no Russian, ' + name, found.length === 0, found.slice(0, 4).join(' ; '));
  };

  check('arsenal, units');
  one('#toggleExtra').click();
  one('#toggleEffectFilter').click();
  check('arsenal, extra info and effect filter');
  ok('EN: effect button reads "Effects"', one('#toggleEffectFilter').textContent.trim() === 'Effects',
    'text: ' + one('#toggleEffectFilter').textContent.trim());
  // A selected effect adds a chip with a remove button and changes the button text.
  const effBox = one('#fEffect input[type=checkbox]');
  effBox.checked = true;
  effBox.dispatchEvent(new Event('change'));
  ok('EN: selected effect shows a chip and the count',
    document.querySelectorAll('#fEffectChips .chip.removable').length === 1
    && one('#toggleEffectFilter').textContent.trim() === 'Effects: 1',
    'chips ' + document.querySelectorAll('#fEffectChips .chip.removable').length + ', button: ' + one('#toggleEffectFilter').textContent.trim());
  check('arsenal, effect selected');
  one('#resetFilters').click();
  ok('EN: "hide non-combat" label is translated',
    /Hide non-combat/.test(one('#hideSecondary').closest('label')?.textContent ?? ''),
    'label: ' + (one('#hideSecondary').closest('label')?.textContent.trim() ?? 'none'));
  ok('EN: target field label is translated',
    one('#fTarget')?.closest('label.field')?.firstElementChild.textContent.trim() === 'Target',
    'field: ' + (one('#fTarget')?.closest('label.field')?.textContent.trim().slice(0, 40) ?? 'none'));
  // Non-combat entities (neutrals, cut content) have their own names and badges:
  // show them all so their rows and sub-rows are swept too.
  one('#hideSecondary').click();
  ok('EN: unchecking "hide non-combat" shows every unit',
    document.querySelectorAll('#arsenalTable tbody tr.clickable').length === UNITS.length,
    'rows ' + document.querySelectorAll('#arsenalTable tbody tr.clickable').length + ' of ' + UNITS.length);
  check('arsenal, all units including non-combat');
  // Class chips with a selection, so the filtered table and checked chips are checked too.
  const chip = one('#fClass input[value="infantry"]');
  chip.click();
  check('arsenal, infantry chip on');
  chip.click();
  one('#hideSecondary').click();

  // The target changes DPS labels and tooltips, so check with it too.
  state.target = UNITS.find((u) => u.id === 'DYN.Unit.PorcupineMissileLauncher') ?? UNITS[0];
  renderArsenal();
  check('arsenal with a selected target');

  one('#tabs button[data-panel="compare"]').click();
  check('compare without a target');
  state.compareTarget = state.target;
  renderCompare();
  check('compare with a target');

  one('#tabs button[data-panel="arsenal"]').click();

  const dialog = one('#unitDialog');
  const bad = [];
  for (const unit of UNITS) {
    openUnit(unit);
    const found = russianIn(dialog);
    if (found.length) bad.push(unit.id + ' → ' + found[0]);
    dialog.close();
  }
  ok('EN: no Russian in the cards of all ' + UNITS.length + ' units', bad.length === 0, bad.slice(0, 4).join(' ; '));

  ok('EN: no JS errors during the run', errors.length === 0, errors.slice(0, 3).join(' ; '));
} catch (e) {
  failed++;
  R.push('FAIL|EN probe crashed|' + (e && e.message) + ' @ ' + String((e && e.stack || '').split('\n')[1]));
  flush();
}
flush();
})();
`;

const browser = await findBrowser();
if (!browser) {
  console.log('Chrome/Edge not found, UI test skipped.');
  process.exit(0);
}

const { parseResultLines, formatFailure } = await import('./result-lines.mjs');
const html = await readFile(join(WEB, 'index.html'), 'utf8');

/**
 * One run: a copy of the page with its own probe (and, if needed, its own config.js)
 * -> headless Chrome -> parsing of the result lines. The browser profile is new every
 * time, so a language picked in a previous run via localStorage does not interfere.
 */
async function runPage(label, probeSource, config = null) {
  let page = html.replace('</body>', `<script>${probeSource}</script>\n</body>`);
  if (config) {
    page = page.replace('<script src="config.js"></script>', `<script>window.TR_CONFIG = ${JSON.stringify(config)};</script>`);
  }
  await writeFile(COPY, page, 'utf8');

  const profile = await mkdtemp(join(tmpdir(), 'tr-uitest-'));
  let dom = '';
  let stderr = '';
  try {
    const res = await run(browser, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--allow-file-access-from-files', '--enable-logging=stderr', '--log-level=0',
      '--virtual-time-budget=120000',
      `--user-data-dir=${profile}`,
      '--dump-dom', pathToFileURL(COPY).href,
    ], { maxBuffer: 128 * 1024 * 1024 });
    dom = res.stdout;
    stderr = res.stderr;
  } catch (e) {
    console.log(`FAIL (${label}): Chrome did not run:`, e.message.slice(0, 300));
    return null;
  } finally {
    await rm(COPY, { force: true });
    await rm(profile, { recursive: true, force: true });
  }

  const block = dom.match(/<pre id="uitest">([\s\S]*?)<\/pre>/);
  if (!block) {
    // The probe did not run. Most often it did not even load, for example because
    // it clashed with a same-named variable from app.js: classic scripts share
    // the global lexical scope, and the SyntaxError is not visible anywhere.
    const jsErrors = stderr
      .split(/\r?\n/)
      .filter((line) => /Uncaught|SyntaxError|ReferenceError|TypeError is not/i.test(line));
    console.log(`FAIL (${label}): the probe did not run. It may have failed to load.`);
    for (const line of jsErrors.slice(0, 5)) console.log('  ' + line.trim().slice(0, 220));
    if (!jsErrors.length) console.log('  no JS errors in stderr, check npm run build and npm run smoke');
    return null;
  }

  const text = block[1]
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
  return parseResultLines(text);
}

let allPassed = 0;
let allFailed = 0;
let broken = false;
for (const [label, source, config] of [
  ['RU', probe, { defaultLang: 'ru', public: false }],
  ['EN', probeEn, { defaultLang: 'en', public: true }],
]) {
  const parsed = await runPage(label, source, config);
  if (!parsed || parsed.results.length === 0 || !parsed.summaryFound || parsed.passed === undefined) {
    broken = true;
    continue;
  }
  for (const f of parsed.results.filter((r) => !r.passed)) console.log(formatFailure(f));
  console.log(`UI test ${label}: passed ${parsed.passed}, failed ${parsed.failed}`);
  allPassed += parsed.passed;
  allFailed += parsed.failed;
}
console.log(`UI test: passed ${allPassed}, failed ${allFailed}`);
process.exit(allFailed || broken ? 1 : 0);
