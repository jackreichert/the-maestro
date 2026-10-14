// Run: node --test scripts/lib/cost-experiment.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impact, mixGap, selectTarget, startStatus } from './cost-experiment.ts';
import type { Comparison } from '../token-metrics.ts';

const c = (name: string, o: Partial<Comparison> = {}): Comparison => ({ name, today: 1, median7: 1, baseline: 1, vs7: 0, vsBase: 0, fmt: 'n', cost: true, limit: NaN, dir: undefined, trend: false, status: '-', regression: false, ...o });
/** A regressed token-total metric (material move 1000) with a median big enough to rank, moving by `vs7` of it. */
const reg = (name: string, vs7: number, o: Partial<Comparison> = {}): Comparison => c(name, { regression: true, vs7, median7: 10000, today: 10000 * (1 + vs7), ...o });
const opus = (today: number): Comparison => c('Opus share (read)', { today, limit: 0.4, dir: 'max', fmt: 'pct' });
const haiku = (today: number): Comparison => c('Haiku share (read)', { today, limit: 0.15, dir: 'min', fmt: 'pct' });

test('the regression with the most impact wins, whichever direction a regression runs', () => {
  const p = selectTarget([reg('Read/turn', 0.31), c('Haiku share (read)', { regression: true, vs7: -0.62, median7: 0.5, today: 0.19, limit: 0.15, dir: 'min', fmt: 'pct' }), reg('Wakes/prompt', 0.25, { fmt: 'ratio', median7: 2, today: 2.5 })]);
  assert.equal(p.basis, 'regression');
  assert.equal(p.metric, 'Haiku share (read)');
  assert.deepEqual(p.regressions.map((r) => r.name), ['Haiku share (read)', 'Read/turn', 'Wakes/prompt']);
});

test('a tiny median cannot top the list: +1492% on a base of 37 loses to a +21% move in real volume', () => {
  const blowup = c('Expiry rewrites', { regression: true, vs7: 14.92, median7: 37, today: 589 });
  const real = reg('Avg report', 0.21);
  assert.ok(Number.isNaN(impact(blowup)), 'its median is under one material move');
  const p = selectTarget([blowup, real]);
  assert.equal(p.metric, 'Avg report');
  assert.deepEqual(p.regressions.map((r) => r.name), ['Avg report']);
  assert.equal(selectTarget([blowup, opus(0.5), haiku(0.2)]).basis, 'mix', 'with only the blowup regressed the mix is the fallback');
});

test('a small absolute move on a healthy median is under the floor even past 20%', () => {
  assert.ok(Number.isNaN(impact(reg('Read/turn', 0.25, { median7: 2000, today: 2500 }))));
});

test('impact ranks by absolute move in material units, and the percentage only breaks a tie', () => {
  const big = reg('Avg report', 0.2, { median7: 100000, today: 120000 });
  const pctier = reg('Read/turn', 0.9, { median7: 10000, today: 19000 });
  assert.equal(selectTarget([pctier, big]).metric, 'Avg report', '20 material moves beat 9 despite a lower percentage');
  const a = reg('Read/turn', 0.3, { median7: 10000, today: 13000 });
  const b = reg('Avg report', 0.5, { median7: 6000, today: 9000 });
  assert.equal(impact(a), impact(b));
  assert.equal(selectTarget([a, b]).metric, 'Avg report', 'equal impact: the larger percentage wins');
});

test('a regression beats a worse mix miss: the mix is only the fallback', () => {
  const p = selectTarget([reg('Avg report', 0.21), opus(0.9), haiku(0)]);
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
