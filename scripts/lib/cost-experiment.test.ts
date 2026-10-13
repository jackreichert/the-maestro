// Run: node --test scripts/lib/cost-experiment.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mixGap, selectTarget, startStatus } from './cost-experiment.ts';
import type { Comparison } from '../token-metrics.ts';

const c = (name: string, o: Partial<Comparison> = {}): Comparison => ({ name, today: 1, median7: 1, baseline: 1, vs7: 0, vsBase: 0, fmt: 'n', cost: true, limit: NaN, dir: undefined, trend: false, status: '-', regression: false, ...o });
const opus = (today: number): Comparison => c('Opus share (read)', { today, limit: 0.4, dir: 'max', fmt: 'pct' });
const haiku = (today: number): Comparison => c('Haiku share (read)', { today, limit: 0.15, dir: 'min', fmt: 'pct' });

test('the largest regression wins, whichever direction a regression runs', () => {
  const p = selectTarget([c('Read/turn', { regression: true, vs7: 0.31 }), c('Haiku share (read)', { regression: true, vs7: -0.62, today: 0.05, limit: 0.15, dir: 'min' }), c('Wakes/prompt', { regression: true, vs7: 0.25 })]);
  assert.equal(p.basis, 'regression');
  assert.equal(p.metric, 'Haiku share (read)');
  assert.deepEqual(p.regressions.map((r) => r.name), ['Haiku share (read)', 'Read/turn', 'Wakes/prompt']);
});

test('a regression beats a worse mix miss: the mix is only the fallback', () => {
  const p = selectTarget([c('Avg report', { regression: true, vs7: 0.21 }), opus(0.9), haiku(0)]);
  assert.equal(p.metric, 'Avg report');
});

test('with nothing regressed the mix metric furthest past its target is picked', () => {
  const p = selectTarget([c('Read/turn'), opus(0.52), haiku(0.12)]);
  assert.equal(p.basis, 'mix');
  assert.equal(p.metric, 'Opus share (read)');
  assert.ok(Math.abs((p.gap ?? 0) - 0.3) < 1e-9, 'Opus is 30% past its limit; Haiku is 20% short');
  const h = selectTarget([opus(0.45), haiku(0.03)]);
  assert.equal(h.metric, 'Haiku share (read)');
});

test('when both mix targets are met the one with the smallest margin is picked', () => {
  const p = selectTarget([opus(0.2), haiku(0.16)]);
  assert.equal(p.metric, 'Haiku share (read)');
  assert.ok((p.gap ?? 1) < 0);
  assert.match(p.reason, /smallest margin/);
});

test('a metric with no number is never picked, and no data at all is basis none', () => {
  assert.equal(selectTarget([opus(NaN), haiku(0.1)]).metric, 'Haiku share (read)');
  const none = selectTarget([c('Read/turn', { today: NaN }), opus(NaN), haiku(NaN)]);
  assert.deepEqual([none.basis, none.metric], ['none', null]);
  assert.equal(selectTarget([]).basis, 'none');
});

test('a regression with no median to compare against (NaN) is not a candidate', () => {
  assert.equal(selectTarget([c('Read/turn', { regression: true, vs7: NaN }), opus(0.5), haiku(0.2)]).basis, 'mix');
});

test('mixGap is a fraction of the target and positive for a miss in either direction', () => {
  assert.ok(Math.abs(mixGap(opus(0.6)) - 0.5) < 1e-9);
  assert.ok(Math.abs(mixGap(haiku(0.075)) - 0.5) < 1e-9);
  assert.ok(Number.isNaN(mixGap(c('x'))));
});

test('an approved habit starts running; anything else, or nothing, starts proposed', () => {
  assert.equal(startStatus('capped-reports'), 'running');
  assert.equal(startStatus('a new idea'), 'proposed');
  assert.equal(startStatus('constructor'), 'proposed');
  assert.equal(startStatus(undefined), 'proposed');
});
