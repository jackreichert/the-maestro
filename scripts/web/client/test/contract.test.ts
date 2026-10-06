// Run: node --test scripts/web/client/test/contract.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fragmentFor, sanitizeCharts, sanitizeState } from '../src/contract.ts';
import { describeSources } from '../src/api.ts';

const fixture = (name: string): Record<string, any> => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const state = (): Record<string, any> => fixture('state.json');

test('the bundled fixtures pass the rules with nothing dropped', () => {
  const got = sanitizeState(fixture('state.json'));
  assert.equal(got?.dropped, 0);
  assert.equal(got?.state.asks.length, 3);
  assert.equal(got?.state.prs.length, 3);
  assert.equal(sanitizeCharts(fixture('charts.json'))?.data.throughput.length, 5);
});

test('a payload with no usable shape is refused', () => {
  for (const x of [null, undefined, 'x', 3, [], {}, { streams: 'a' }, { streams: [1] }]) assert.equal(sanitizeState(x), null, JSON.stringify(x));
  for (const x of [null, 'x', 3, []]) assert.equal(sanitizeCharts(x), null);
});

test('rows missing a required string are dropped and the rest of the payload survives', () => {
  const total = state().prs.length;
  for (const field of ['id', 'stream', 'needed', 'context', 'date', 'ts']) {
    const bad = state();
    bad.asks[0][field] = 7;
    const got = sanitizeState(bad);
    assert.equal(got?.state.asks.length, 2, field);
    assert.equal(got?.dropped, 1, field);
    assert.equal(got?.state.prs.length, total);
  }
});

test('a PR without ci, with a non-numeric number or non-string flags is dropped', () => {
  for (const [field, value] of [['ci', undefined], ['number', '12'], ['flags', 'x'], ['url', null], ['isDraft', 'no']] as const) {
    const bad = state();
    bad.prs[0][field] = value;
    assert.equal(sanitizeState(bad)?.state.prs.length, 2, field);
  }
});

test('link lists must be arrays of {label, url?} with string fields', () => {
  const cases = [{ tracker: 'x', prs: [] }, { tracker: [], prs: [{ url: 'https://a.test' }] }, { tracker: [{ label: 'a', url: 5 }], prs: [] }, { tracker: [null], prs: [] }, null, { prs: [], tracker: [], note: { label: 3 } }];
  for (const links of cases) {
    const bad = state();
    bad.asks[1].links = links;
    assert.equal(sanitizeState(bad)?.state.asks.length, 2, JSON.stringify(links));
  }
});

test('work rows need id, stream, text and links; blocked gate must be a string when present', () => {
  const bad = state();
  bad.working[0].text = undefined;
  bad.blocked[0].gate = 5;
  const got = sanitizeState(bad);
  assert.equal(got?.state.working.length, 1);
  assert.equal(got?.state.blocked.length, 0);
});

test('fragments keep only string values; a non-object fragments is dropped', () => {
  const bad = state();
  bad.fragments = { overview: 'ok', ops: { x: 1 }, n: 3 };
  assert.deepEqual(sanitizeState(bad)?.state.fragments, { overview: 'ok' });
  bad.fragments = 'x';
  assert.equal(sanitizeState(bad)?.state.fragments, undefined);
});

test('priorities that fail the rules become missing rather than throwing later', () => {
  for (const p of [undefined, null, 'x', { state: 'ok' }, { state: 'weird' }]) {
    const bad = state();
    bad.priorities = p;
    assert.deepEqual(sanitizeState(bad)?.state.priorities, { state: 'missing' }, JSON.stringify(p));
  }
  const odd = state();
  odd.priorities.items.push({ text: 4 });
  assert.equal((sanitizeState(odd)?.state.priorities as { items: unknown[] }).items.length, 3);
});

test('a missing prData or a bad footer row does not take the page down', () => {
  const bad = state();
  delete bad.prData;
  bad.footer[0].asks = 'two';
  const got = sanitizeState(bad);
  assert.deepEqual(got?.state.prData, { fetchedAt: null, stale: true });
  assert.equal(got?.state.footer.length, 2);
});

test('a prototype-key payload cannot change the result shape', () => {
  const bad = JSON.parse('{"streams":["a"],"__proto__":{"asks":[{"id":"x"}]},"fragments":{"__proto__":"s"}}');
  const got = sanitizeState(bad);
  assert.equal(got?.state.asks.length, 0);
  assert.equal(({} as Record<string, unknown>).asks, undefined);
});

test('charts: null prMix or modelMix become empty, bad rows are dropped, a bad source falls back to ledger', () => {
  const c = fixture('charts.json');
  const got = sanitizeCharts({ ...c, prMix: null, modelMix: null, throughput: [...c.throughput, { date: 1 }], ageBuckets: [{ label: 'x', count: 'a', ids: [] }] });
  assert.deepEqual(got?.data.prMix, { byState: {}, byStream: {} });
  assert.deepEqual(got?.data.modelMix, { byFamily: {}, source: 'ledger' });
  assert.equal(got?.data.throughput.length, 5);
  assert.equal(got?.data.ageBuckets.length, 0);
  assert.equal(sanitizeCharts({ ...c, modelMix: { byFamily: { a: 1 }, source: 'tokens' } })?.data.modelMix.source, 'tokens');
  assert.deepEqual(sanitizeCharts({ ...c, prMix: { byState: { a: 'x' }, byStream: { s: 1 } } })?.data.prMix, { byState: {}, byStream: {} });
});

test('charts: every dropped row, day entry and mix table is counted', () => {
  const c = fixture('charts.json');
  assert.equal(sanitizeCharts(c)?.dropped, 0);
  const bad = { ...c, days: [...c.days, 7], throughput: [...c.throughput, { date: 1 }], ageBuckets: [{ label: 'x', count: 'a', ids: [] }],
    prMix: { byState: { a: 'x' }, byStream: { s: 1 } }, modelMix: null };
  assert.equal(sanitizeCharts(bad)?.dropped, 1 + 1 + 1 + 2 + 1);
});

test('state: dropped priority items and non-string fragments are counted', () => {
  const s = state();
  s.priorities = { state: 'ok', date: '2026-10-06', items: [{ text: 'a' }, { text: 3 }, 'x'] };
  s.fragments = { ops: 'ok', bad: 1 };
  const got = sanitizeState(s);
  assert.equal(got?.dropped, 3);
  assert.equal(got?.state.priorities.state === 'ok' && got.state.priorities.items.length, 1);
});

test('fragmentFor finds own keys only: stream names like constructor or __proto__ get nothing', () => {
  const got = sanitizeState({ ...state(), fragments: { ops: 'note', __proto__x: 'y' } })?.state.fragments;
  assert.equal(fragmentFor(got, 'ops'), 'note');
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) assert.equal(fragmentFor(got, name), undefined, name);
  assert.equal(fragmentFor(undefined, 'ops'), undefined);
  const own = sanitizeState({ ...state(), fragments: JSON.parse('{"constructor":"mine","__proto__":"p"}') })?.state.fragments;
  assert.equal(fragmentFor(own, 'constructor'), 'mine');
  assert.equal(fragmentFor(own, '__proto__'), 'p');
});

test('describeSources says Live only when both endpoints are live, and names which one is sample data', () => {
  assert.equal(describeSources('server', 'server', 0, 'T'), 'Live. Updated T.');
  assert.match(describeSources('fixture', 'server', 0, 'T'), /sample data for state:/);
  assert.match(describeSources('server', 'fixture', 0, 'T'), /sample data for charts:/);
  assert.match(describeSources('fixture', 'fixture', 0, 'T'), /for state and charts:/);
  assert.ok(!describeSources('fixture', 'server', 0, 'T').includes('Live'));
  assert.match(describeSources('server', 'server', 2, 'T'), /2 malformed rows were skipped/);
  assert.match(describeSources('server', 'server', 1, 'T'), /1 malformed row was skipped/);
});
