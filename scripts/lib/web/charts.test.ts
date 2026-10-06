// Run: node --test scripts/lib/web/charts.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitingAge, buildCharts, lastDays, modelMix, prMix, throughputByDay } from './charts.ts';
import type { LedgerItem } from '../ledger-core.ts';
import type { Pr } from '../status-page/render.ts';

const NOW = new Date('2026-10-06T15:00:00Z');
const TZ = 'America/New_York';
const item = (over: Partial<LedgerItem>): LedgerItem => ({ id: 'aa11', kind: 'wip', closedBy: null, state: 'wip', ...over });
const doneAt = (ts: string, over: Partial<LedgerItem> = {}): LedgerItem =>
  item({ date: ts.slice(0, 10), ts: '2026-10-01T10:00:00Z', stream: 'alpha', model: 'claude-opus-4', state: 'done', closedBy: { kind: 'done', ts, date: ts.slice(0, 10) }, ...over });
const pr = (over: Partial<Pr>): Pr => ({
  number: 1, title: 't', url: 'https://example.test/1', isDraft: false, baseRefName: 'develop', headRefName: 'feat/FAKE-1', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  reviewDecision: null, repo: 'org/acme-widgets', short: 'acme-widgets', owner: 'org', unresolved: 0, ci: 'SUCCESS', stream: 'alpha', ...over,
});

test('lastDays ends at the page day, not the UTC day, and counts back by calendar days', () => {
  const lateEvening = new Date('2026-10-07T02:30:00Z');
  assert.deepEqual(lastDays(lateEvening, TZ, 3), ['2026-10-04', '2026-10-05', '2026-10-06']);
  assert.deepEqual(lastDays(lateEvening, 'UTC', 2), ['2026-10-06', '2026-10-07']);
});

test('lastDays does not skip or repeat a day across a daylight-saving change', () => {
  assert.deepEqual(lastDays(new Date('2026-11-02T12:00:00Z'), TZ, 4), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
});

test('throughput buckets by the closing time in the page zone: 9 pm Eastern on the 5th is the 6th in UTC but still the 5th on the page', () => {
  const out = throughputByDay([doneAt('2026-10-06T01:00:00Z'), doneAt('2026-10-06T14:00:00Z', { stream: 'beta' }), doneAt('2026-10-06T14:30:00Z', { stream: undefined })], 2, TZ, NOW);
  assert.deepEqual(out, [
    { date: '2026-10-05', total: 1, byStream: { alpha: 1 } },
    { date: '2026-10-06', total: 2, byStream: { beta: 1, other: 1 } },
  ]);
});

test('throughput zero-fills quiet days, drops days outside the window, and ignores items that did not finish done', () => {
  const resolved = item({ state: 'resolved', closedBy: { kind: 'resolved', ts: '2026-10-06T14:00:00Z' } });
  const writtenDone = item({ state: 'done', ts: '2026-10-06T13:00:00Z', stream: 'alpha' });
  const old = doneAt('2026-09-01T14:00:00Z');
  const out = throughputByDay([resolved, writtenDone, old, item({})], 3, TZ, NOW);
  assert.deepEqual(out.map((d) => [d.date, d.total]), [['2026-10-04', 0], ['2026-10-05', 0], ['2026-10-06', 1]]);
});

test('awaiting age sorts open asks into under 1 d, 1-3 d, 3-7 d and over 7 d, falling back to the date when there is no time', () => {
  const ask = (id: string, ts: string | undefined, date: string): LedgerItem => item({ id, kind: 'question', ts, date });
  const out = awaitingAge([ask('a001', '2026-10-06T10:00:00Z', '2026-10-06'), ask('a002', '2026-10-04T10:00:00Z', '2026-10-04'), ask('a003', undefined, '2026-10-01'), ask('a004', '2026-09-20T00:00:00Z', '2026-09-20')], NOW);
  assert.deepEqual(out.map((b) => [b.label, b.count, b.ids]), [['under 1 d', 1, ['a001']], ['1-3 d', 1, ['a002']], ['3-7 d', 1, ['a003']], ['over 7 d', 1, ['a004']]]);
  assert.equal(awaitingAge([], NOW).every((b) => b.count === 0), true);
});

test('PR mix counts CI state overall and per stream, and the four Markdown totals', () => {
  const out = prMix([
    pr({ number: 1, isDraft: true }), pr({ number: 2, ci: 'FAILURE', mergeable: 'CONFLICTING', unresolved: 2 }),
    pr({ number: 3, ci: 'ERROR', stream: 'beta' }), pr({ number: 4, ci: 'EXPECTED', stream: 'beta' }), pr({ number: 5, ci: 'NONE', stream: 'beta' }), pr({ number: 6, ci: 'ODD' }),
  ]);
  assert.deepEqual(out.byState, { pass: 1, fail: 2, pending: 1, none: 1, odd: 1 });
  assert.deepEqual(out.byStream, { alpha: { pass: 1, fail: 1, odd: 1 }, beta: { fail: 1, pending: 1, none: 1 } });
  assert.deepEqual(out.totals, { open: 6, draft: 1, conflicting: 1, withThreads: 1, failingCi: 2 });
});

test('model mix counts items finished in the window by family, other for an unknown or missing model', () => {
  const out = modelMix([doneAt('2026-10-06T14:00:00Z', { model: 'claude-sonnet-5-5' }), doneAt('2026-10-05T14:00:00Z'), doneAt('2026-10-05T15:00:00Z', { model: undefined }), doneAt('2026-08-05T15:00:00Z')], 7, TZ, NOW);
  assert.deepEqual(out, { byFamily: { sonnet: 1, opus: 1, other: 1 }, source: 'ledger' });
});

test('buildCharts is the four reducers over one window and is a pure function of its input', () => {
  const input = { items: [doneAt('2026-10-06T14:00:00Z')], awaiting: [], prs: [pr({})], now: NOW, tz: TZ, days: 2 };
  const a = buildCharts(input);
  assert.deepEqual(a.days, ['2026-10-05', '2026-10-06']);
  assert.equal(a.throughput[1]?.total, 1);
  assert.equal(a.prMix.totals.open, 1);
  assert.deepEqual(buildCharts(input), a);
});
