// Run: node --test scripts/web/client/test/home-model.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGE_LABELS, ageChart, doneSpans, rowFacts, rowOrder, weeksChart } from '../src/home-model.ts';
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

test('doneSpans: today and the week, grouped by stream with a link to its tab; ids the capped list lacks are counted', () => {
  const d = doneSpans(charts(), ['acme-widgets', 'ops']);
  assert.equal(d.today.n, 2);
  assert.deepEqual(d.today.groups.map((g) => [g.stream, g.n, g.items.length]), [['acme-widgets', 1, 1], ['ops', 1, 1]]);
  assert.deepEqual(d.week.groups.map((g) => [g.stream, g.n]), [['acme-widgets', 6], ['ops', 3], ['other', 1]], 'week counts come from the day totals, not the capped item list');
  assert.match(d.today.groups[0].tab, /^#/);
  const weekIds = charts().throughput.slice(-7).flatMap((x) => x.ids).length;
  assert.equal(d.week.n, weekIds);
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
