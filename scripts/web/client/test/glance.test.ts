// Run: node --test scripts/web/client/test/glance.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, askAge, clockTime, cueParts, freshness, longDate, oldestFirst } from '../src/glance.ts';

const row = { id: 'x', stream: 's', text: 't', links: { tracker: [], prs: [] }, since: '' };

test('cueParts counts asks, blocked, done and working in that order, with singular and plural wording', () => {
  const one = cueParts({ asks: [{} as never], blocked: [], done: [{ ...row, closedAt: '' }, { ...row, closedAt: '' }], working: [row] });
  assert.deepEqual(one.map((p) => [p.key, p.n, p.label]), [
    ['asks', 1, 'needs you'], ['blocked', 0, 'blocked'], ['done', 2, 'shipped today'], ['working', 1, 'in flight'],
  ]);
  assert.equal(cueParts({ asks: [], blocked: [], done: [], working: [] })[0].label, 'need you');
});

test('cueParts gives each part a tone so colour is never the only signal (the words carry it too)', () => {
  assert.deepEqual(cueParts({ asks: [], blocked: [], done: [], working: [] }).map((p) => p.tone), ['accent', 'critical', 'success', 'neutral']);
});

test('ago is compact and floors to the unit', () => {
  const now = '2026-10-06T14:05:00Z';
  assert.equal(ago('2026-10-06T14:04:31Z', now), 'just now');
  assert.equal(ago('2026-10-06T13:27:00Z', now), '38 min');
  assert.equal(ago('2026-10-06T11:00:00Z', now), '3 h');
  assert.equal(ago('2026-10-03T10:00:00Z', now), '3 d');
});

test('ago treats a future start as just now and an unreadable time as unknown', () => {
  assert.equal(ago('2026-10-07T00:00:00Z', '2026-10-06T00:00:00Z'), 'just now');
  assert.equal(ago('not a time', '2026-10-06T00:00:00Z'), '');
  assert.equal(ago('2026-10-06T00:00:00Z', ''), '');
});

test('clockTime shows the time in the given zone with a lower-case meridiem', () => {
  assert.equal(clockTime('2026-10-06T14:05:00Z', 'America/New_York'), '10:05 am');
  assert.equal(clockTime('2026-10-06T18:30:00Z', 'UTC'), '6:30 pm');
});

test('clockTime falls back to the local zone for a bad zone and is empty for a bad time', () => {
  assert.match(clockTime('2026-10-06T14:05:00Z', 'Not/AZone'), /^\d{1,2}:\d{2} [ap]m$/);
  assert.equal(clockTime('', 'UTC'), '');
});

test('longDate names the weekday and month and rejects anything but YYYY-MM-DD', () => {
  assert.equal(longDate('2026-10-06'), 'Tuesday 6 October');
  assert.equal(longDate('2026-13-45'), '');
  assert.equal(longDate('06/10/2026'), '');
});

test('freshness flags data older than 15 minutes and gives its age', () => {
  const at = '2026-10-06T14:00:00Z';
  assert.deepEqual(freshness(at, Date.parse('2026-10-06T14:15:00Z')), { age: '15 min', stale: false });
  assert.deepEqual(freshness(at, Date.parse('2026-10-06T14:16:00Z')), { age: '16 min', stale: true });
  assert.deepEqual(freshness(at, Date.parse('2026-10-06T17:00:00Z')), { age: '3 h', stale: true });
});

test('freshness never calls unreadable data stale', () => {
  assert.deepEqual(freshness('', Date.parse('2026-10-06T14:00:00Z')), { age: '', stale: false });
  assert.deepEqual(freshness('2026-10-06T14:00:00Z', Number.NaN), { age: '', stale: false });
});

test('askAge reads today under one day, then whole days', () => {
  const cases: [number, string][] = [[0, 'today'], [0.9, 'today'], [1, '1 d'], [1.6, '1 d'], [5, '5 d'], [-2, 'today'], [Number.NaN, 'today']];
  for (const [days, text] of cases) assert.equal(askAge(days), text, `askAge(${days})`);
});

test('oldestFirst puts the longest wait first, breaks ties by the earlier ask, and keeps input order last', () => {
  const ask = (id: string, ageDays: number, ts: string) => ({ id, ageDays, ts });
  const input = [ask('new', 0, '2026-10-06T10:00:00Z'), ask('old', 5, '2026-10-01T09:00:00Z'), ask('mid-late', 2, '2026-10-04T12:00:00Z'),
    ask('mid-early', 2, '2026-10-04T08:00:00Z'), ask('tie-a', 1, 'bad time'), ask('tie-b', 1, 'bad time')];
  assert.deepEqual(oldestFirst(input).map((a) => a.id), ['old', 'mid-early', 'mid-late', 'tie-a', 'tie-b', 'new']);
  assert.equal(input[0].id, 'new', 'the input is not reordered');
});
