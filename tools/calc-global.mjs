/**
 * calc-global.mjs — turns the calc.js ES module into a classic script.
 *
 * Why: when index.html is opened by double-click, the browser uses the file://
 * origin, and Chrome/Edge refuse to load ES modules from file:// because of CORS
 * ("Access to script at 'file://…' from origin 'null' has been blocked").
 * A plain <script> works with file://. So for the UI we generate
 * calc.global.js once, which puts everything into globalThis.TRCalc.
 *
 * The transform is deliberately dumb: strip `export ` from declaration lines and
 * collect the list of names. No bundlers, minifiers or magic.
 */

// Regexes are created inside functions: objects with the g flag share
// lastIndex state, and a single forgotten reset silently breaks the next call.
const declRe = () => /^(?:export\s+)?(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm;
const exportPrefixRe = () => /^export\s+(const|let|var|function|async function|class)\s+/gm;
const exportListRe = () => /^export\s*\{[^}]*\}\s*;?\s*$/gm;
const importLineRe = () => /^[ \t]*import\s+[^;]*;?[ \t]*$/gm;
const leftoverRe = () => /^[ \t]*(import|export)\b/m;

/** Names declared at the top level, in order of appearance. */
export function topLevelNames(source) {
  const names = [];
  for (const match of source.matchAll(declRe())) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/** @returns {string} a ready classic script for <script src=…>. */
export function toGlobalScript(source) {
  if (importLineRe().test(source)) {
    throw new Error('calc.js must not import anything — the transform cannot handle it');
  }

  const names = topLevelNames(source);
  if (!names.length) throw new Error('No top-level declarations found');

  const body = source
    .replace(exportListRe(), '')
    .replace(exportPrefixRe(), '$1 ');

  if (leftoverRe().test(body)) {
    throw new Error('import/export left after the transform — check the source format');
  }

  return [
    '/* GENERATED from web/lib/calc.js by tools/build-web-data.mjs — do not edit. */',
    '(function () {',
    "'use strict';",
    body,
    `globalThis.TRCalc = { ${names.join(', ')} };`,
    '})();',
    '',
  ].join('\n');
}
