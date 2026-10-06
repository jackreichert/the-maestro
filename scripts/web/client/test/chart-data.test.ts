// Run: node --test scripts/web/client/test/chart-data.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ageChart, modelMixChart, prMixChart, throughputChart } from '../src/chart-data.ts';
import { limitSeries } from '../src/chart-math.ts';
import { isCharts, isState } from '../src/api.ts';
import type { ChartsData } from '../src/types.ts';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const charts = fixture('charts.json') as ChartsData;

test('the bundled fixtures satisfy the contract guards the client applies at runtime', () => {
  assert.ok(isState(fixture('state.json')));
  assert.ok(isCharts(charts));
  assert.ok(!isState({ streams: [] }));
  assert.ok(!isState(null));
  const { priorities: _p, ...noPriorities } = fixture('state.json') as Record<string, unknown>;
  assert.ok(!isState(noPriorities), 'a state without priorities would throw at render time');
  assert.ok(!isState({ ...(fixture('state.json') as object), working: undefined }));
  assert.ok(!isCharts('x'));
});

test('throughputChart has one label per day and one aligned series per stream, zero-filled', () => {
  const c = throughputChart(charts);
  assert.deepEqual(c.labels, ['10-02', '10-03', '10-04', '10-05', '10-06']);
  assert.deepEqual(c.series.map((x) => x.name), ['acme-widgets', 'ops', 'other']);
  assert.deepEqual(c.series[0].values, [2, 1, 0, 2, 1]);
  assert.deepEqual(c.series[2].values, [0, 0, 0, 1, 0]);
});

test('ageChart, prMixChart and modelMixChart carry the counts through', () => {
  assert.deepEqual(ageChart(charts).series[0].values, [1, 1, 1, 0]);
  assert.deepEqual(prMixChart(charts).labels, ['FAILURE', 'PENDING', 'SUCCESS']);
  const m = modelMixChart(charts);
  assert.deepEqual(m.labels, ['Items']);
  assert.deepEqual(m.series.map((x) => [x.name, x.values[0]]), [['haiku', 2], ['opus', 3], ['sonnet', 5]]);
  assert.deepEqual(modelMixChart({ ...charts, modelMix: { byFamily: {}, source: 'tokens' } }).labels, ['Tokens']);
});

test('limitSeries leaves eight or fewer alone and folds the rest into one Other series that keeps the totals', () => {
  const labels = ['a', 'b'];
  const mk = (n: number) => ({ labels, series: Array.from({ length: n }, (_, i) => ({ name: `s${i}`, values: [i + 1, 1] })) });
  assert.equal(limitSeries(mk(8)).series.length, 8);
  const folded = limitSeries(mk(11));
  assert.equal(folded.series.length, 8);
  assert.equal(folded.series[7].name, 'Other');
  const sum = (d: ReturnType<typeof mk>) => d.series.reduce((t, x) => t + x.values[0] + x.values[1], 0);
  assert.equal(sum(folded), sum(mk(11)));
});
