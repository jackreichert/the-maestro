// Run: node --test scripts/web/client/test/home-model.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGE_LABELS, ageChart, askAgeBars, doneSpans, epicCards, orderAsks, prGauge, queuedByStream, rowFacts, rowOrder, scoreTable, streamState, weeksChart } from '../src/home-model.ts';
import { sanitizeCharts, sanitizeProjects, sanitizeState } from '../src/contract.ts';
import type { ChartsData, PodiumState, ProjectRow, ProjectsData } from '../src/types.ts';

const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const state = (): PodiumState => structuredClone(sanitizeState(read('state.json'))!.state);
const charts = (): ChartsData => structuredClone(sanitizeCharts(read('charts.json'))!.data);
const projects = (): ProjectsData => structuredClone(sanitizeProjects(read('projects.json'))!.data);
const row = (o: Partial<ProjectRow>): ProjectRow => ({
  stream: 's', projects: [], status: null, rank: null, asks: 0, inflight: 0, blocked: 0, prs: 0, oldestOpenDays: null, lastShipped: null, shippedWeek: 0, state: 'quiet', ...o,
});

test('the sample projects payload passes its contract whole', () => {
  const got = sanitizeProjects(read('projects.json'));
  assert.ok(got);
  assert.equal(got.dropped, 0);
  assert.equal(got.data.rows.length, 2);
});

test('the contract drops a bad row and counts it, and refuses a body with no rows', () => {
  const body = read('projects.json') as Record<string, unknown[]>;
  body.rows.push({ stream: 'x', state: 'thriving' });
  body.links.push({ label: 'no url', kind: 'pin', stream: 'x' });
  const got = sanitizeProjects(body);
  assert.deepEqual([got?.data.rows.length, got?.data.links.length, got?.dropped], [2, 3, 2]);
  assert.equal(sanitizeProjects({ generatedAt: 'x', today: 'y' }), null);
});

test('ageChart: asks and open work share the server buckets, and every open item is counted once', () => {
  const st = state();
  const { data, undated } = ageChart(st);
  assert.deepEqual(data.labels, [...AGE_LABELS]);
  const [asks, work] = data.series.map((s) => s.values.reduce((a, b) => a + b, 0));
  assert.equal(asks, st.asks.length);
  assert.equal(work + undated, st.working.length + st.blocked.length);
  st.working[0].since = 'not a date';
  assert.equal(ageChart(st).undated, 1, 'work with no readable start is counted, not guessed');
});

test('weeksChart: one column per period, one series per stream in page order, absent counts are zero', () => {
  const c = weeksChart(projects(), ['ops', 'acme-widgets', 'other']);
  assert.equal(c.labels.length, 8);
  assert.equal(c.labels[0], '08-12');
  assert.deepEqual(c.series.map((s) => s.name), ['ops', 'acme-widgets', 'other']);
  assert.equal(c.series[0].values[2], 0);
  assert.deepEqual(weeksChart({ ...projects(), weeks: [] }, []), { labels: [], series: [] });
});

test('doneSpans: today and the week, grouped by stream; ids the capped list lacks are counted', () => {
  const d = doneSpans(charts(), ['acme-widgets', 'ops']);
  assert.equal(d.today.n, 2);
  assert.deepEqual(d.today.groups.map((g) => [g.stream, g.n, g.items.length]), [['acme-widgets', 1, 1], ['ops', 1, 1]]);
  assert.deepEqual(d.week.groups.map((g) => [g.stream, g.n]), [['acme-widgets', 6], ['ops', 3], ['other', 1]], 'week counts come from the day totals, not the capped item list');
  const weekIds = charts().throughput.slice(-7).flatMap((x) => x.ids).length;
  assert.equal(d.week.n, weekIds);
  for (const span of [d.today, d.week]) assert.equal(span.groups.reduce((t, g) => t + g.n, 0), span.n, 'the header n and the group counts are the same total');
  assert.equal(d.missing, weekIds - d.week.groups.reduce((t, g) => t + g.items.length, 0));
  const none = doneSpans({ ...charts(), throughput: [], doneItems: [] }, []);
  assert.deepEqual([none.today.n, none.week.n, none.missing], [0, 0, 0]);
});

test('rowFacts: counts with their nouns, zeros left out, and when it last shipped', () => {
  assert.deepEqual(rowFacts(row({ asks: 1, inflight: 2, prs: 1, oldestOpenDays: 0, shippedWeek: 3 })), ['1 ask', '2 in flight', '1 open PR', 'oldest open under 1 d', '3 shipped this week']);
  assert.deepEqual(rowFacts(row({ lastShipped: '2026-09-20' })), ['last shipped 09-20']);
  assert.deepEqual(rowFacts(row({})), ['nothing shipped in 8 weeks']);
});

test('rowOrder: waiting on you, then blocked, moving, quiet; ties by priority rank, then page order', () => {
  const rows = [row({ stream: 'q' }), row({ stream: 'm2', state: 'moving' }), row({ stream: 'm1', state: 'moving', rank: 1 }), row({ stream: 'w', state: 'waiting on you' }), row({ stream: 'b', state: 'blocked' })];
  assert.deepEqual(rowOrder(rows).map((r) => r.stream), ['w', 'b', 'm1', 'm2', 'q']);
});

test('scoreTable: last 14 days, a rest for zero, higher pitch for busier days, counts from the state, project names when loaded', () => {
  const st = state();
  const c = charts();
  const s = scoreTable(st, c, projects());
  assert.ok(s.days.length <= 14 && s.days.length > 0);
  assert.equal(s.rows.length, st.streams.length);
  for (const r of s.rows) {
    assert.equal(r.days.length, s.days.length);
    r.days.forEach((n, i) => assert.equal(r.pitches[i] === 0, n === 0, 'pitch 0 is a rest, and only a rest'));
    assert.ok(r.pitches.every((p) => p >= 0 && p <= 4));
    assert.equal(r.total, r.days.reduce((a, b) => a + b, 0));
    assert.equal(r.asks, st.asks.filter((a) => a.stream === r.stream).length);
  }
  assert.equal(s.days.filter((d) => d.today).length <= 1, true);
  assert.deepEqual(scoreTable(st, c, null).rows.map((r) => r.projects), s.rows.map(() => []), 'no names until the projects load');
});

test('streamState: asks first, then blocked, then movement, else quiet', () => {
  assert.equal(streamState(1, 1, 1, 1), 'waiting on you');
  assert.equal(streamState(0, 1, 1, 1), 'blocked');
  assert.equal(streamState(0, 0, 1, 0), 'moving');
  assert.equal(streamState(0, 0, 0, 2), 'moving');
  assert.equal(streamState(0, 0, 0, 0), 'quiet');
});

test('orderAsks: oldest first, or one-way doors first with oldest first inside each group', () => {
  const a = [{ id: 'a', ageDays: 1, ts: '2026-10-12', door: 'one-way' }, { id: 'b', ageDays: 5, ts: '2026-10-08', door: 'two-way' }, { id: 'c', ageDays: 3, ts: '2026-10-10', door: 'one-way' }];
  assert.deepEqual(orderAsks(a, 'oldest').map((x) => x.id), ['b', 'c', 'a']);
  assert.deepEqual(orderAsks(a, 'oneway').map((x) => x.id), ['c', 'a', 'b']);
});

test('askAgeBars: four buckets, the last two flagged stale', () => {
  const bars = askAgeBars([{ ageDays: 0 }, { ageDays: 2 }, { ageDays: 5 }, { ageDays: 9 }, { ageDays: 10 }]);
  assert.deepEqual(bars.map((b) => b.n), [1, 1, 1, 2]);
  assert.deepEqual(bars.map((b) => b.stale), [false, false, true, true]);
  assert.deepEqual(bars.map((b) => b.label), [...AGE_LABELS]);
});

test('prGauge: CI states are counted whatever their case, and threads and conflicts from the PRs', () => {
  const prs = [
    { ci: 'SUCCESS', unresolved: 0, mergeable: 'MERGEABLE' }, { ci: 'pass', unresolved: 2, mergeable: 'CONFLICTING' },
    { ci: 'FAILURE', unresolved: 0, mergeable: 'UNKNOWN' }, { ci: 'pending', unresolved: 0, mergeable: 'MERGEABLE' }, { ci: '', unresolved: 0, mergeable: 'MERGEABLE' },
  ] as unknown as PodiumState['prs'];
  const g = prGauge(prs, null);
  assert.deepEqual(g.ci, { pass: 2, pending: 1, fail: 1, none: 1 });
  assert.equal(g.total, 5);
  assert.equal(g.threads, 1);
  assert.equal(g.conflicting, 1);
  assert.equal(g.queue, null);
});

test('epicCards: one per epic with segments in reading order; none without epics', () => {
  assert.deepEqual(epicCards(null), []);
  const line = { id: 'e-1', title: 't', note: { label: 'n', url: 'x' }, status: 'open', total: 10, closed: 4, inProgress: 1, blocked: 2, notStarted: 3, awaiting: 0, quietDays: null, prs: [] };
  const cards = epicCards({ streams: [{ stream: 'ops', epics: [line] }], unfiled: [line] } as unknown as Parameters<typeof epicCards>[0]);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0]!.segments.map((s) => [s.key, s.n]), [['closed', 4], ['progress', 1], ['blocked', 2], ['open', 3]]);
  assert.equal(cards[1]!.stream, 'unfiled');
});

test('queuedByStream: most queued first, ties in stream order', () => {
  const q = [{ stream: 'b' }, { stream: 'a' }, { stream: 'b' }, { stream: 'c' }];
  assert.deepEqual(queuedByStream(q, ['c', 'a', 'b']), [{ stream: 'b', n: 2 }, { stream: 'c', n: 1 }, { stream: 'a', n: 1 }]);
});
