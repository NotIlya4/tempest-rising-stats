/**
 * i18n.js — interface localization, EN / RU.
 *
 * The translation key is the English text itself, so app.js reads like the
 * page it renders. Russian lives in the RU dictionary below.
 * Placeholders use {name}: t('Showing {shown} of {total}', { shown, total }).
 *
 * Language resolution: the user's explicit choice (localStorage) → the build's
 * default (window.TR_CONFIG.defaultLang: local build — ru, public build — en)
 * → en. Switching the language reloads the page: half of the interface is
 * built once on load (filters, pickers), and re-rendering each piece is a lot
 * of code for something people do once.
 *
 * A classic script, not a module: browsers refuse to load modules from file://.
 */
(function () {
  const STORAGE_KEY = 'tr-lang';
  const LANGS = ['en', 'ru'];

  const RU = {
    // ── header and tabs
    'Tempest Rising — unit stats database': 'Tempest Rising — база статов',
    'loading…': 'загрузка…',
    'Arsenal': 'Арсенал',
    'Compare': 'Сравнение',
    'Weapons': 'Оружие',
    'Interface language': 'Язык интерфейса',
    '{n} entities · {w} weapons · {date}': '{n} сущностей · {w} оружий · {date}',

    // ── arsenal filters
    'Target': 'Цель',
    'Unit type, several can be on; none means all': 'Тип юнита, можно выбрать несколько; ничего не выбрано — все типы',
    'Hide non-combat': 'Скрыть небоевое',
    'Damage after the armor of “{name}”': 'Урон после брони «{name}»',
    'No target: damage vs 0% armor, TTK empty': 'Без цели: урон по 0% брони, TTK пуст',
    'Green — the best in a row. Damage and DPS use the selected weapon.': 'Зелёным — лучший в строке. Урон и DPS считаются по выбранному стволу.',
    'Magazine size and how it refills': 'Размер обоймы и как она пополняется',
    'Doctrines': 'Доктрины',             // InterfaceTexts/BuildingGrid_ModeTabs_Doctrines
    '“{name}” on the Tempest Rising Wiki ↗': '«{name}» на Tempest Rising Wiki ↗',
    'Power': 'Энергия',                 // InterfaceTexts/PlayerData_Resource_Power_Name
    'Enlightened': 'Просветленный',     // InterfaceTexts/PlayerData_Resource_Enlightened_Name
    'variable': 'зависит от условий',
    '{cost} is drained while it builds, {foundation} is the foundation, paid when the site is placed':
      '{cost} списывается по ходу строительства, {foundation} — фундамент, платится сразу при размещении площадки',
    '+ foundation': '+ фундамент',
    'per unit, not per weapon; GDF buildings: main cost + foundation': 'за юнита, не за ствол; здания ГСО: основная цена + фундамент',
    'Showing {shown} of {total}': 'Показано {shown} из {total}',
    'DPS and damage use multiplayer stats': 'DPS и урон считаются по мультиплееру',
    'Hit count uncertain: {why}': 'Число попаданий под вопросом: {why}',
    'a hit in the attack animation lands after the next attack may already start, so the real count can be lower':
      'одно попадание в анимации атаки приходится на момент, когда уже может начаться следующая атака, поэтому на деле их может быть меньше',
    'the crawling attack animation fires a different number of times': 'анимация атаки ползком стреляет другое число раз',
    'Effects: {n}': 'Эффекты: {n}',
    'Remove': 'Убрать',
    'Units that apply any of the selected effects with a weapon or carry them as an aura':
      'Юниты, которые накладывают оружием или держат аурой любой из выбранных эффектов',
    'Hides the economy (harvesters, refineries), neutral and civilian map objects, mines and barrels, and what the game leaves out of its codex (campaign leftovers and variants)':
      'Скрывает экономику (харвестеры, переработчики), нейтральные и гражданские объекты карты, мины и бочки, а также то, чего нет в кодексе игры (остатки кампании и варианты)',
    'Search by name, weapon, effect…': 'Поиск по названию, оружию, эффекту…',
    'All factions': 'Все фракции',
    'find effect…': 'найти эффект…',
    'Show economy columns: credits, Intel, build time, population':
      'Показать колонки экономики: кредиты, разведданные, стройка, популяция',
    'more info ▾': 'доп. информация ▾',
    'more info ▴': 'доп. информация ▴',
    'Clear all arsenal filters': 'Снять все фильтры арсенала',
    'reset filters': 'сбросить фильтры',
    'Infantry': 'Пехота',
    'Vehicles': 'Техника',
    'Aircraft': 'Авиация',
    'Superweapons': 'Супероружие',
    'Buildings': 'Постройки',
    'Other': 'Прочее',
    '{n} units': '{n} юнитов',
    'Nothing found.': 'Ничего не найдено.',

    // ── unit picker
    'No target — 0% armor': 'Без цели — считаем по 0% брони',
    'DPS vs 0% armor': 'DPS против 0% брони',
    'Start typing a name…': 'Начните вводить название…',
    'Clear': 'Очистить',
    'Nothing found': 'Ничего не найдено',

    // ── pictures and effects
    '{v}% armor': '{v}% брони',
    'ground': 'земля',
    'air': 'воздух',
    'Can attack: {t}': 'Может стрелять: {t}',
    'The game has no icon for “{name}”': 'В игре нет иконки для «{name}»',
    'Not in the game data.': 'В данных игры этого значения нет.',
    'Does not apply.': 'Не применяется.',
    'No Intel cost: paid in credits only': 'Без разведданных: оплата только кредитами',
    'Intel: the second resource; — when paid in credits only': 'Разведданные: второй ресурс; — если оплата только кредитами',
    'Hits per attack unknown: the game data does not give one number.':
      'Число попаданий за атаку неизвестно: данные игры не дают одного числа.',

    // ── columns
    'Name': 'Название',
    'Faction': 'Фракция',
    'Tier': 'Тир',
    'Class': 'Класс',
    'Speed': 'Скорость',
    'Credits': 'Кредиты',
    'Build, s': 'Строительство, с',
    'Pop': 'Числ.',
    'Dmg/volley': 'Урон/залп',
    'Range': 'Дальность',
    'Interval, s': 'Интервал, с',
    'Effects': 'Эффекты',
    'Targets': 'Цели',
    'Damage type': 'Тип урона',
    'TTK, s': 'TTK, с',
    'Ammo': 'Боеприпасы',
    'Credits per DPS': 'Кредитов на DPS',
    'Slot {n}': 'Слот {n}',
    'vs “{name}”': 'против «{name}»',
    'vs 0% armor': 'по 0% брони',
    'Damage per second {target}. Values are per weapon in the rows below; this column sorts by the unit’s best weapon.':
      'Урон в секунду {target}. Значения — по стволам в строках ниже, тут сортировка по лучшему стволу юнита.',
    'Damage of a full volley {target}. Values are per weapon in the rows below; this column sorts by the highest-DPS weapon.':
      'Урон за весь залп {target}. Значения — по стволам в строках ниже, тут сортировка по стволу с наибольшим DPS.',
    'Maximum across the unit’s weapons. Per-weapon values are in the rows below.':
      'Максимум по стволам юнита. Сами значения — в строках ниже, по одному на ствол.',
    'Interval of the highest-DPS weapon — the same one shown in the DPS column. Per-weapon values are below.':
      'Интервал ствола с наибольшим DPS — того же, что посчитан в колонке DPS. По стволам — в строках ниже.',
    'Value after the selected target’s armor. Hover a cell to see the unarmored value.':
      'Число после брони выбранной цели. Наведи на ячейку — покажет, сколько было без брони.',

    // ── table rows
    ' vs “{name}”': ' против «{name}»',
    ' (no target, no armor)': ' (без брони и цели)',
    'interval {v} s': 'интервал {v} с',
    'ammo {v}': 'боезапас {v}',
    'targets: {v}': 'цели: {v}',
    'The unit is sorted by this weapon': 'Именно этим стволом юнит посчитан в сортировке',
    '{label} vs 0% armor: {v}': '{label} по 0% брони: {v}',
    '{label} vs “{name}”: {v}': '{label} против «{name}»: {v}',
    'without armor: {v}': 'без брони: {v}',
    'damage type: {type}, target armor: {armor}%': 'тип урона: {type}, броня цели: {armor}%',
    ' (lets {cut}% through)': ' (срезает {cut}%)',
    'Volley damage': 'Урон за залп',

    // ── unit card
    'Close': 'Закрыть',
    'Tier {n}': 'Тир {n}',
    'no armor': 'без брони',
    'Build': 'Строительство',
    '{v} s': '{v} с',
    'Sight': 'Обзор',
    'Armor': 'Броня',
    'Percent reduction of incoming damage of that type. 100% is full immunity. Omni damage ignores armor.':
      'Процент снижения входящего урона соответствующего типа. 100% — полный иммунитет. Тип Омни броню игнорирует.',
    'This entity has no weapons in the game data.': 'В данных игры у этой сущности нет оружия.',
    'Economy': 'Экономика',
    'Auras are always active around the unit, weapon effects are applied on hit. Doctrines are researched and change this unit, its weapons or its fields.':
      'Ауры работают постоянно вокруг юнита, эффекты оружия накладываются при попадании. Доктрины исследуются и меняют этого юнита, его оружие или его поля.',
    'Upgrade': 'Улучшение',
    'Cooldown: {v} s': 'Перезарядка: {v} с', // Cooldown → Перезарядка (game localization)
    '{name} with “{upgrade}”': '{name} с «{upgrade}»',
    ' or ': ' или ',
    'Type': 'Тип',
    'Utility ability, deals no damage': 'Служебная способность, урона не наносит',
    'util.': 'служ.',
    ' (reload {t}s)': ' (перезарядка {t}с)',
    ' (+{n}/{t}s)': ' (+{n}/{t}с)',
    'Effects and auras': 'Эффекты и ауры',
    'Unit auras:': 'Ауры юнита:',
    'Applied by weapons:': 'Накладывают оружием:',
    'Abilities': 'Способности',
    'Icon failed to load': 'Иконка не загрузилась',
    'Produced at': 'Производится',
    'Requires': 'Требуется',

    // ── compare
    'Target for DPS and TTK': 'Цель для расчёта DPS и TTK',
    'Add another unit to compare': 'Добавить ещё одного юнита к сравнению',
    '+ unit': '+ юнит',
    'reset': 'сброс',
    'At most {n} units — more would be unreadable': 'Больше {n} юнитов не сравнить — таблица станет нечитаемой',
    'Add a unit with the “+ unit” button.': 'Добавь юнита кнопкой «+ юнит».',
    'Remove from comparison': 'Убрать из сравнения',
    'Damage': 'Урон',
    'target armor applied': 'броня цели учтена',
    'no target — computed vs 0% armor': 'цель не выбрана — считается по 0% брони',
    'after target armor': 'после брони цели',
    'target HP: {hp}': 'HP цели: {hp}',
    'needs a target: no one to compute TTK against': 'нужна цель: без неё не у кого считать TTK',
    'Cost': 'Цена',
    'cost divided by weapon DPS': 'цена, делённая на DPS ствола',
    'Population': 'Численность',
    'Survivability': 'Живучесть',
    'unlimited': 'нет ограничения',
    'The selected units are unarmed: nothing to compare.': 'Выбранные юниты без оружия: сравнивать нечего.',

    // ── data quality

    // ── game terms: Russian taken from the game's own localization (.locres)
    'GDF': 'ГСО',                       // MenuScreenTexts/Abbreviation_GDF
    'Dynasty': 'Династия',              // InterfaceTexts/BuildingGrid_Prerequisites_FactionName_Dynasty
    'Intel': 'Разведданные',            // InterfaceTexts/PlayerData_Resource_Intel_Name
    'Veti': 'Вети',                     // MenuScreenTexts/Campaign_VETI
    'Neutral': 'Нейтральные',           // PlayerColors_Attitude_Neutral
    'Rifle': 'Стрелковое',              // ST_Attacks/DamageType_Gun
    'Rocket': 'Ракета',                 // ST_Attacks/DamageType_Rocket
    'Explosive': 'Взрывчатка',          // ST_Attacks/DamageType_Explosive
    'Cannon': 'Пушка',                  // ST_Attacks/DamageType_Cannon
    'Fire': 'Огонь',                    // ST_Attacks/DamageType_Fire
    'Sniper': 'Снайпер',                // ST_Attacks/DamageType_Sniper
    'Omni': 'Омни',                     // ST_Attacks/DamageType_Omni
    'infantry': 'пехота',               // InterfaceTexts/Pawntype_Infantry
    'vehicle': 'техника',
    'aircraft': 'авиация',
    'structure': 'постройка',
    'superweapon': 'супероружие',
    'destructible': 'разрушаемый объект',

    // ── terms that are the same in both languages: listed so the test does not flag them as missing
    'web/data.js not found — run npm run build': 'Не найден web/data.js — запусти npm run build',

    // ── public build
    'Data and images come from the Tempest Rising game files and belong to their respective owners. Fan project, not affiliated with the developers or publisher of Tempest Rising.':
      'Данные и изображения взяты из файлов игры Tempest Rising и принадлежат их правообладателям. Фан-проект, не связан с разработчиками и издателем Tempest Rising.',
    'Source code': 'Исходный код',
  };

  const readStored = () => {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return LANGS.includes(value) ? value : null;
    } catch {
      return null;
    }
  };

  const config = globalThis.TR_CONFIG ?? {};
  const lang = readStored() ?? (LANGS.includes(config.defaultLang) ? config.defaultLang : 'en');

  // Untranslated strings do not break anything: they fall back to English and
  // are collected here. The UI test fails if this set is not empty.
  const missing = new Set();

  const fill = (text, params) => (params
    ? text.replace(/\{(\w+)\}/g, (whole, key) => (key in params ? String(params[key]) : whole))
    : text);

  function t(key, params) {
    if (lang === 'en') return fill(key, params);
    const ru = RU[key];
    if (ru === undefined) missing.add(key);
    return fill(ru ?? key, params);
  }

  function setLang(next) {
    if (!LANGS.includes(next) || next === lang) return;
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private window: the choice is not remembered */ }
    location.reload();
  }

  /**
   * Static markup in index.html: data-i18n translates textContent,
   * data-i18n-title / data-i18n-placeholder / data-i18n-aria translate those
   * attributes. The marker has no value: the current (English) text is the key.
   */
  function applyStatic(root = document) {
    for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.textContent.trim());
    for (const [marker, attr] of [['i18nTitle', 'title'], ['i18nPlaceholder', 'placeholder'], ['i18nAria', 'aria-label']]) {
      const selector = `[data-${marker.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`;
      for (const node of root.querySelectorAll(selector)) node.setAttribute(attr, t(node.getAttribute(attr) ?? ''));
    }
    document.documentElement.lang = lang;
    document.title = t(document.title);
  }

  globalThis.TRI18n = {
    lang,
    langs: LANGS,
    locale: lang === 'ru' ? 'ru-RU' : 'en-US',
    isPublic: Boolean(config.public),
    t,
    setLang,
    applyStatic,
    missing,
    RU,
  };
})();
