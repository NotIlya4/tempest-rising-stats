/**
 * Parses the lines that the uitest.mjs probe returns from the browser via --dump-dom.
 *
 * Line format: PASS|<name> or FAIL|<name>|<detail>, plus a SUMMARY|<ok>|<fail> line.
 * All of it sits in one <pre>, so the "|" separator was chosen for simplicity.
 *
 * KEY POINT: a detail may itself contain "|". Tests used to join column values
 * with join('|'), and a naive line.split('|') silently truncated such a detail
 * at the first bar: the failure message looked empty, and diagnostics vanished
 * exactly when they were needed. So the line is cut EXACTLY twice: after 'FAIL'
 * and after the name. Everything else is the detail, pipes included.
 */

const PASS = 'PASS|';
const FAIL = 'FAIL|';
const SUMMARY = 'SUMMARY|';

/** Cuts off the head once; returns the rest as is, "|" included. */
function cutOnce(rest) {
  const i = rest.indexOf('|');
  return i < 0 ? { head: rest, tail: '' } : { head: rest.slice(0, i), tail: rest.slice(i + 1) };
}

export function parseResultLines(text) {
  const lines = String(text).split('\n');
  const results = [];
  let summary = null;

  for (const line of lines) {
    if (line.startsWith(SUMMARY)) {
      // SUMMARY|<ok>|<fail>: exactly two pipes, a plain split is fine here.
      const [ok, fail] = line.slice(SUMMARY.length).split('|');
      summary = { passed: Number(ok), failed: Number(fail) };
      continue;
    }
    if (line.startsWith(FAIL)) {
      const { head, tail } = cutOnce(line.slice(FAIL.length));
      results.push({ passed: false, name: head, detail: tail });
      continue;
    }
    if (line.startsWith(PASS)) {
      results.push({ passed: true, name: line.slice(PASS.length), detail: '' });
    }
  }

  return {
    results,
    summaryFound: summary !== null,
    passed: summary?.passed ?? 0,
    failed: summary?.failed ?? 0,
  };
}

/** SUMMARY is parsed above, a separate function is no longer needed. */

/** Readable text for the report: pipes in the detail become "·" to avoid confusion. */
export function formatFailure(f) {
  return `FAIL: ${f.name}${f.detail ? ' — ' + f.detail.split('|').join('·') : ''}`;
}