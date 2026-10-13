// Run: node --test scripts/lib/suite-metrics.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertWithin, baselineFrom, firstLines, formatSummary, parseJestJson, parseJunit, readBaseline, summarize, timeProbe, unescapeXml, writeBaseline } from './suite-metrics.ts';
import type { TestRecord } from './suite-metrics.ts';

const NODE_JUNIT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testsuite name="grp" time="0.0012" tests="4" failures="1">
		<testcase name="inner ok" time="0.000242" classname="test" file="/repo/scripts/a.test.ts"/>
		<testcase name="inner bad" time="0.5" classname="test" file="/repo/scripts/a.test.ts" failure="Expected values to be strictly equal:&#10;&#10;1 !== 2&#10;">
			<failure type="testCodeFailure" message="Expected values to be strictly equal:&#10;&#10;1 !== 2">
Error [ERR_TEST_FAILURE]: stack with &lt;anonymous&gt; and a nested &lt;failure&gt; mention
    at x
			</failure>
		</testcase>
		<testcase name="sk" time="0.00004" classname="test" file="/repo/scripts/a.test.ts">
			<skipped type="skipped" message="true"/>
		</testcase>
		<testcase name="td" time="0.00003" classname="test" file="/repo/scripts/a.test.ts">
			<skipped type="todo" message="true"/>
		</testcase>
	</testsuite>
	<testcase name="top" time="2.5" classname="test" file="/repo/scripts/b.test.ts"/>
	<testcase name="top" time="0.1" classname="test" file="/repo/scripts/b.test.ts"/>
</testsuites>`;

const PYTEST_JUNIT = `<testsuites><testsuite name="pytest" tests="2"><testcase classname="tests.test_x.TestY" name="test_a" time="0.012"/><testcase classname="tests.test_x.TestY" name="test_b" time="1.5"><failure message="assert 1 == 2">def test_b():
&gt;       assert 1 == 2
E       assert 1 == 2</failure></testcase></testsuite></testsuites>`;

const rec = (id: string, ms: number, status: TestRecord['status'] = 'pass'): TestRecord => ({ id, file: 'f', name: id, ms, status });

test('parseJunit reads node output: ids, seconds to ms, statuses, relative file, suite nesting', () => {
  const r = parseJunit(NODE_JUNIT, '/repo');
  assert.deepEqual(r.map((t) => [t.id, t.status]), [
    ['scripts/a.test.ts > grp > inner ok', 'pass'], ['scripts/a.test.ts > grp > inner bad', 'fail'], ['scripts/a.test.ts > grp > sk', 'skip'],
    ['scripts/a.test.ts > grp > td', 'todo'], ['scripts/b.test.ts > top', 'pass'], ['scripts/b.test.ts > top #2', 'pass'],
  ]);
  assert.equal(r[4]?.ms, 2500);
  assert.ok(Math.abs((r[0]?.ms ?? 0) - 0.242) < 1e-9);
});

test('parseJunit takes the failure message first and does not stop at a tag-like word inside the body', () => {
  const bad = parseJunit(NODE_JUNIT, '/repo')[1] as TestRecord;
  assert.equal(bad.error, 'Expected values to be strictly equal:\n1 !== 2');
  assert.equal(parseJunit(NODE_JUNIT, '/repo').length, 6);
});

test('parseJunit survives a raw > inside a quoted attribute, as node writes a diff', () => {
  const xml = '<testsuites><testcase name="diffy" time="0.1" classname="test" file="/repo/a.test.ts" failure="+ a &gt; b&#10;  ]">\n<failure message="+ a > b&#10;  ]&quot;x&quot;">stack</failure></testcase><testcase name="after" time="0.2" file="/repo/a.test.ts"/></testsuites>';
  const r = parseJunit(xml, '/repo');
  assert.deepEqual(r.map((t) => [t.id, t.status]), [['a.test.ts > diffy', 'fail'], ['a.test.ts > after', 'pass']]);
  assert.equal(r[0]?.error, '+ a > b\n  ]"x"');
});

test('parseJunit reads pytest output: classname ids, failure body when the message is one line', () => {
  const r = parseJunit(PYTEST_JUNIT);
  assert.equal(r[0]?.id, 'tests.test_x.TestY::test_a');
  assert.equal(r[1]?.status, 'fail');
  assert.equal(r[1]?.error, 'assert 1 == 2');
  assert.equal(r[1]?.ms, 1500);
});

test('parseJestJson reads durations, statuses and failure messages without colour codes, and a file that failed to run', () => {
  const json = JSON.stringify({ testResults: [
    { name: '/repo/src/a.test.ts', status: 'failed', assertionResults: [
      { ancestorTitles: ['A'], title: 'works', status: 'passed', duration: 12 },
      { ancestorTitles: ['A'], title: 'breaks', status: 'failed', duration: 3000, failureMessages: ['\u001b[31mexpected 1\u001b[0m\n  at x'] },
      { ancestorTitles: [], title: 'later', status: 'todo', duration: null }] },
    { name: '/repo/src/b.test.ts', status: 'failed', message: 'Cannot find module x', assertionResults: [] },
  ] });
  const r = parseJestJson(json, '/repo');
  assert.deepEqual(r.map((t) => [t.id, t.status, t.ms]), [
    ['src/a.test.ts > A > works', 'pass', 12], ['src/a.test.ts > A > breaks', 'fail', 3000], ['src/a.test.ts > later', 'todo', 0], ['src/b.test.ts > (file failed to run)', 'fail', 0]]);
  assert.equal(r[1]?.error, 'expected 1\n  at x');
  assert.ok(!r[1]?.error?.includes('\u001b'));
  assert.equal(r[3]?.error, 'Cannot find module x');
});

test('summarize counts, lists the first failures only, and ranks the slowest', () => {
  const records = [rec('a', 10), rec('b', 300), rec('c', 20, 'fail'), rec('d', 1, 'skip'), rec('e', 5, 'todo'), rec('f', 40, 'fail'), rec('g', 100)];
  const s = summarize(records, null, { top: 2, maxFailures: 1 });
  assert.deepEqual(s.counts, { total: 7, pass: 3, fail: 2, skip: 1, todo: 1 });
  assert.equal(s.failuresTotal, 2);
  assert.deepEqual(s.failures.map((f) => f.id), ['c']);
  assert.deepEqual(s.slowest.map((t) => t.id), ['b', 'g']);
  assert.equal(s.testMs, 470);
});

test('regressions need the factor and the minimum delta; a new test and a faster one are not flagged', () => {
  const base = baselineFrom([rec('slow-now', 100), rec('tiny', 1), rec('same', 500), rec('faster', 900)], { runner: 'node', head: 'abc', branch: 'main' });
  const s = summarize([rec('slow-now', 450), rec('tiny', 5), rec('same', 600), rec('faster', 100), rec('brand-new', 9000)], base, { absMs: 5000 });
  assert.deepEqual(s.regressions?.map((r) => [r.id, r.baselineMs, r.ratio]), [['slow-now', 100, 4.5]]);
  assert.deepEqual(s.overThreshold.map((t) => t.id), ['brand-new']);
});

test('a missing baseline gives null regressions and a summary that says so, not an error', () => {
  const s = summarize([rec('a', 10)], null);
  assert.equal(s.regressions, null);
  assert.match(formatSummary(s, null), /regressions: no baseline/);
  assert.equal(readBaseline(join(mkdtempSync(join(tmpdir(), 'sm-')), 'none.json')), null);
});

test('the baseline keeps passing tests only and survives a write and read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-'));
  const path = join(dir, 'nested', 'b.json');
  writeBaseline(path, baselineFrom([rec('ok', 12.3456), rec('bad', 5, 'fail'), rec('sk', 1, 'skip')], { runner: 'node', head: 'abc123', branch: 'main', now: new Date('2026-10-13T00:00:00Z') }));
  const b = readBaseline(path);
  assert.deepEqual(b?.tests, { ok: 12.35 });
  assert.equal(b?.writtenAt, '2026-10-13T00:00:00.000Z');
});

test('formatSummary shows failures with their error lines, slowest, and the regression against the baseline run', () => {
  const base = baselineFrom([rec('x', 100)], { runner: 'node', head: 'abcdef123456', branch: 'main', now: new Date('2026-10-01T00:00:00Z') });
  const records: TestRecord[] = [{ ...rec('x', 1200), status: 'pass' }, { ...rec('boom', 3, 'fail'), error: 'line one\nline two' }];
  const text = formatSummary(summarize(records, base), base);
  assert.match(text, /failures \(1 of 1\):\n  FAIL boom\n       line one\n       line two/);
  assert.match(text, /1\.2s  x/);
  assert.match(text, /regressions vs baseline \(abcdef1234, 2026-10-01; over 2x and 100ms\): 1\n  100ms -> 1\.2s \(12\.0x\)  x/);
});

test('small helpers: entities, first lines, and the timing probe', () => {
  assert.equal(unescapeXml('a&lt;b&#10;&amp;&#x41;'), 'a<b\n&A');
  assert.equal(firstLines('\none\n\ntwo\nthree', 2), 'one\ntwo');
  assert.equal(firstLines('x'.repeat(300)).length, 200);
  assert.equal(timeProbe(() => 7).value, 7);
  assert.equal(assertWithin(1000, () => 'fine'), 'fine');
  assert.throws(() => assertWithin(-1, () => 0, 'p'), /p: took .*limit -1ms/);
});
