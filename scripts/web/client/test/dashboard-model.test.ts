// Run: node --test scripts/web/client/test/dashboard-model.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ASKS_HREF, LIST_ROWS, doneOn, donePerDay, inFlight, needsYou, prsWaiting, snapshotNote, streamColors } from '../src/dashboard-model.ts';
import { sanitizeCharts, sanitizeState } from '../src/contract.ts';
import type { ChartsData, PodiumState } from '../src/types.ts';

const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const state = (): PodiumState => structuredClone(sanitizeState(read('state.json'))!.state);
const charts = (): ChartsData => structuredClone(sanitizeCharts(read('charts.json'))!.data);

test('a stream keeps its colour by its place in the stream list, other is neutral, and the ninth stream folds into it', () => {
  const colour = streamColors(['a', 'other', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  assert.deepEqual(['a', 'b', 'c', 'h'].map(colour), ['c-1', 'c-2', 'c-3', 'c-8']);
  assert.equal(colour('other'), 'c-other');
  assert.equal(colour('i'), 'c-other');
  assert.equal(colour('not-a-stream'), 'c-other');
  assert.equal(streamColors(['b', 'a'])('a'), 'c-2', 'the slot follows state.streams, not the data or its rank');
});

test('needs you: oldest ask first, every row sends the reader to the asks on the Board, and the count carries its n', () => {
  const st = state();
  const m = needsYou(st, charts());
  assert.equal(m.n, st.asks.length);
  assert.equal(m.rows.length, st.asks.length);
  assert.ok(m.rows.every((r) => r.tab === ASKS_HREF && r.key && r.text));
  const ages = st.asks.map((a) => a.ageDays).sort((a, b) => b - a);
  assert.equal(m.rows[0].meta, ages[0] >= 1 ? `${ages[0]} d` : 'today');
  assert.equal(needsYou(st, null).buckets, null, 'no charts means the chart is missing, not zero');
});

test('PRs waiting: queue rows are oldest first with the bucket as their age, undated PRs are their own column, and the stale snapshot is named', () => {
  const st = state();
  const c = charts();
  const ref = (n: number, createdAt?: string) => ({ repo: 'acme/widgets', number: n, title: `t${n}`, url: `https://example.test/${n}`, stream: 'ops', ...(createdAt ? { createdAt } : {}) });
  c.prAge = { buckets: [{ label: 'under 1 d', inQueue: [ref(1)], other: [ref(4)] }, { label: '1-3 d', inQueue: [], other: [] }, { label: '3-7 d', inQueue: [ref(2), ref(3)], other: [] }, { label: 'over 7 d', inQueue: [], other: [] }], unknownAge: { inQueue: [ref(9), ref(10)], other: [ref(11)] }, drafts: 2 };
  st.prData = { fetchedAt: '2026-10-06T10:00:00Z', stale: true };
  st.generatedAt = '2026-10-06T15:30:00Z';
  const m = prsWaiting(st, c);
  assert.deepEqual(m.rows.map((r) => r.key), ['acme/widgets#3', 'acme/widgets#2', 'acme/widgets#1', 'acme/widgets#9', 'acme/widgets#10'], 'queue PRs oldest first, then the undated ones, which are listed too');
  assert.match(m.rows[0].meta, /3-7 d$/);
  assert.match(m.rows[3].meta, /no date$/);
  assert.deepEqual(m.columns?.map((x) => [x.label, x.inQueue.length + x.other.length]), [['under 1 d', 2], ['1-3 d', 0], ['3-7 d', 2], ['over 7 d', 0], ['no date', 3]]);
  assert.deepEqual(m.columns?.at(-1)?.inQueue.map((p) => p.number), [9, 10], 'undated PRs keep the review-queue split');
  assert.equal(m.n, 7);
  assert.equal(m.drafts, 2);
  assert.equal(m.stale, 'PR snapshot 5 h old');
  assert.ok(m.rows.every((r) => r.url?.startsWith('https://')), 'a PR row links to the PR itself');
});

test('the snapshot note is absent while fresh and says never fetched when there is no fetch time', () => {
  const st = state();
  st.prData = { fetchedAt: null, stale: false };
  assert.equal(snapshotNote(st), null);
  st.prData = { fetchedAt: null, stale: true };
  assert.equal(snapshotNote(st), 'PR snapshot has never been fetched');
});

test('in flight: bars are counts by stream, most first, ties in stream order, and each links to its stream tab', () => {
  const st = state();
  const w = (id: string, stream: string) => ({ id, stream, text: id, links: { tracker: [], prs: [] }, since: '2026-10-06T10:00:00Z' });
  st.streams = ['ops', 'dashboard', 'beta'];
  st.working = [w('a', 'beta'), w('b', 'ops'), w('c', 'dashboard'), w('d', 'beta')];
  const m = inFlight(st);
  assert.deepEqual(m.bars.map((b) => [b.stream, b.count, b.tab]), [['beta', 2, '#tab=beta'], ['ops', 1, '#tab=ops'], ['dashboard', 1, '#tab=stream%3Adashboard']]);
  assert.equal(m.n, 4);
  assert.equal(m.rows.length, 4);
});

test('done per day: the window, the streams in page order with other last, and a day opens to its items; ids the capped list lost are counted', () => {
  const st = state();
  const c = charts();
  st.streams = ['ops', 'acme-widgets'];
  c.throughput = [{ date: '2026-10-05', total: 1, byStream: { other: 1 }, ids: ['x1'] }, { date: '2026-10-06', total: 3, byStream: { 'acme-widgets': 1, ops: 2 }, ids: ['d1', 'd2', 'gone'] }];
  c.doneItems = [{ id: 'd1', stream: 'ops', text: 'one', finishedAt: '2026-10-06T10:00:00Z', ticket: { label: 'T-1', url: 'https://example.test/t1' } }, { id: 'd2', stream: 'acme-widgets', text: 'two', finishedAt: '2026-10-06T11:00:00Z' }];
  const m = donePerDay(st, c)!;
  assert.deepEqual(m.streams, ['ops', 'acme-widgets', 'other']);
  assert.equal(m.total, 4);
  const day = doneOn(m.days[1], c.doneItems);
  assert.deepEqual(day.rows.map((r) => [r.key, r.url ?? r.tab]), [['d1', 'https://example.test/t1'], ['d2', '#tab=acme-widgets']]);
  assert.equal(day.missing, 1);
  assert.equal(donePerDay(st, null), null);
});

test('LIST_ROWS is the five rows the design note allows', () => {
  assert.equal(LIST_ROWS, 5);
});
