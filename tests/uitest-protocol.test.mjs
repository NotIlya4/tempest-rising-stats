/**
 * Parsing of uitest results. The module is small, but it is exactly what used to
 * silently truncate failure messages: a detail containing "|" was cut at the first
 * bar, and the message looked empty precisely when someone was reading it. So the
 * parser gets regular tests rather than "we'll look next time".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResultLines, formatFailure } from '../tools/result-lines.mjs';

test('reads ordinary passes and failures', () => {
  const { results, passed, failed } = parseResultLines([
    'PASS|table populated',
    'FAIL|dialog opened|no dialog',
    'SUMMARY|1|1',
  ].join('\n'));
  assert.equal(results.length, 2);
  assert.equal(results[0].passed, true);
  assert.equal(results[1].passed, false);
  assert.equal(results[1].name, 'dialog opened');
  assert.equal(results[1].detail, 'no dialog');
  assert.equal(passed, 1);
  assert.equal(failed, 1);
});

test('KEY: a detail containing "|" is not truncated', () => {
  const { results } = parseResultLines('FAIL|columns|columns: HP|Class|DPS|Interval, s\nSUMMARY|0|1');
  assert.equal(results[0].name, 'columns');
  assert.equal(results[0].detail, 'columns: HP|Class|DPS|Interval, s');
  assert.equal(results[0].detail.split('|').length, 4, 'all four pipes must be preserved');
});

test('a detail may start and end with a pipe', () => {
  assert.equal(parseResultLines('FAIL|name||at the edges|').results[0].detail, '|at the edges|');
});

test('a failure without a detail does not break parsing', () => {
  const { results, failed } = parseResultLines('FAIL|no detail at all\nSUMMARY|0|1');
  assert.equal(results[0].name, 'no detail at all');
  assert.equal(results[0].detail, '');
  assert.equal(failed, 1);
});

test('a check name may be long and contain spaces', () => {
  const long = 'columns ' + 'x'.repeat(200);
  assert.equal(parseResultLines('FAIL|' + long + '|detail').results[0].name, long);
});

test('empty input does not count as success', () => {
  const parsed = parseResultLines('');
  assert.deepEqual(parsed.results, []);
  assert.equal(parsed.summaryFound, false);
  assert.equal(parsed.passed, 0);
});

test('SUMMARY without result lines is a failure, not a silent zero', () => {
  const parsed = parseResultLines('SUMMARY|0|0');
  assert.equal(parsed.summaryFound, true);
  assert.deepEqual(parsed.results, []);
});

test('junk lines are ignored, not counted as failures', () => {
  const parsed = parseResultLines([
    '<!DOCTYPE html>',
    'PASS|good check',
    'Note: something from Chrome',
    'SUMMARY|1|0',
  ].join('\n'));
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.passed, 1);
});

test('totals come from SUMMARY, not from the number of lines', () => {
  // There may be fewer lines than passes if part of the output was cut at 300
  // characters, or more if the probe repeated something. SUMMARY is the truth.
  const parsed = parseResultLines('PASS|one\nSUMMARY|452|0');
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.passed, 452);
});

test('the report includes the whole detail', () => {
  const { results } = parseResultLines('FAIL|check|columns: HP, DPS\nSUMMARY|0|1');
  assert.equal(formatFailure(results[0]), 'FAIL: check — columns: HP, DPS');
});

test('the report shows pipes in the detail as dots, not as new columns', () => {
  const { results } = parseResultLines('FAIL|check|columns: HP|Class|DPS\nSUMMARY|0|1');
  assert.equal(formatFailure(results[0]), 'FAIL: check — columns: HP·Class·DPS');
});

test('a failure without a detail is printed without a tail', () => {
  const { results } = parseResultLines('FAIL|check\nSUMMARY|0|1');
  assert.equal(formatFailure(results[0]), 'FAIL: check');
});
