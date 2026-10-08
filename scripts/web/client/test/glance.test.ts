// Run: node --test scripts/web/client/test/glance.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPO_RULE, ago, askAge, chatAnswer, clockTime, cueTitle, tempoWord, cueParts, scoped, freshness, longDate, oldestFirst, shortDate } from '../src/glance.ts';

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

test('scoped keeps every stream for null and one stream otherwise, and cueParts counts exactly what it returns', () => {
  const at = (stream: string): typeof row => ({ ...row, stream });
  const st = {
    asks: [{ stream: 'a' }, { stream: 'b' }, { stream: 'a' }] as never[],
    blocked: [at('b')], done: [{ ...at('a'), closedAt: '' }], working: [at('a'), at('b')],
  };
  assert.equal(scoped(st, null).asks.length, 3);
  const a = scoped(st, 'a');
  assert.deepEqual(cueParts(a).map((p) => p.n), [2, 0, 1, 1]);
  for (const stream of [null, 'a', 'b', 'none']) {
    const b = scoped(st, stream);
    assert.deepEqual(cueParts(b).map((p) => p.n), [b.asks.length, b.blocked.length, b.done.length, b.working.length]);
  }
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
  assert.equal(longDate('2026-02-30'), '', 'an impossible day is rejected, not rolled into March');
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

test('shortDate abbreviates weekday and month and rejects anything but YYYY-MM-DD', () => {
  assert.equal(shortDate('2026-10-06'), 'Tue 6 Oct');
  assert.equal(shortDate('2026-02-30'), '');
  assert.equal(shortDate('Oct 6'), '');
});

test('chatAnswer prefixes the ask id for the chat and refuses a blank answer (no approve-as-asked shortcut)', () => {
  assert.equal(chatAnswer('ab12', '  Yes, merge it.\n'), 'ab12: Yes, merge it.');
  assert.equal(chatAnswer('ab12', 'line one\nline two'), 'ab12: line one\nline two');
  assert.equal(chatAnswer('ab12', ''), null);
  assert.equal(chatAnswer('ab12', ' \n\t '), null);
});

test('cueTitle counts the asks that need you, and only those', () => {
  const cases: [number, string][] = [[0, 'Podium'], [1, '(1) Podium'], [2, '(2) Podium'], [45, '(45) Podium'], [-1, 'Podium'], [1.5, 'Podium'], [Number.NaN, 'Podium']];
  for (const [n, title] of cases) assert.equal(cueTitle(n), title, `cueTitle(${n})`);
});

test('tempoWord follows the stated rule on every boundary', () => {
  // [asks, blocked, working, word]
  const table: [number, number, number, string][] = [
    [0, 0, 0, 'Tacet'],
    [0, 0, 1, 'Adagio'], [0, 0, 9, 'Adagio'],
    [1, 0, 0, 'Andante'], [2, 0, 5, 'Andante'], [0, 2, 0, 'Andante'], [1, 1, 0, 'Andante'],
    [3, 0, 0, 'Allegro'], [1, 2, 0, 'Allegro'], [5, 0, 0, 'Allegro'], [3, 2, 0, 'Allegro'], [4, 1, 7, 'Allegro'],
    [6, 0, 0, 'Presto'], [4, 2, 0, 'Presto'], [0, 3, 0, 'Presto'], [1, 3, 0, 'Presto'], [0, 3, 4, 'Presto'], [40, 0, 0, 'Presto'],
  ];
  for (const [asks, blocked, working, word] of table) {
    assert.equal(tempoWord({ asks, blocked, working }).word, word, `asks ${asks}, blocked ${blocked}, working ${working}`);
  }
});

test('tempoWord tags Tacet as Latin and the rest as Italian, and the rule names every word in order', () => {
  assert.equal(tempoWord({ asks: 0, blocked: 0, working: 0 }).lang, 'la');
  assert.equal(tempoWord({ asks: 1, blocked: 0, working: 0 }).lang, 'it');
  assert.equal(TEMPO_RULE, 'Tempo reads how much is waiting on you: Tacet, nothing; Adagio, only work in flight; Andante, one or two; Allegro, three to five; Presto, six or more, or three blocked.');
  const at = ['Tacet', 'Adagio', 'Andante', 'Allegro', 'Presto'].map((w) => TEMPO_RULE.indexOf(w));
  assert.ok(at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])), 'each word appears, in order');
  assert.ok(!/[\u2014]|--/.test(TEMPO_RULE), 'no em dashes in copy');
});
