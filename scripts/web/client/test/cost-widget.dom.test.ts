// Run: node --test scripts/web/client/test/cost-widget.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, place } from './dom-harness.ts';
import { sanitizeCost } from '../src/contract.ts';
import type { CostData, CostMetric } from '../src/types.ts';

installDom();
const { costSection, costValue } = await import('../src/cost-widget.ts');

const series = (v: (number | null)[]): (number | null)[] => [...Array(14 - v.length).fill(null), ...v];
const metric = (o: Partial<CostMetric> & { name: string }): CostMetric => ({ fmt: 'n', today: 100, median7: 100, vs7: 0, regression: false, limit: null, dir: null, status: '-', series: series([100, 100]), ...o });
const data = (o: Partial<CostData> = {}): CostData => ({
  state: 'ok', date: '2026-10-12', stale: false, days: Array.from({ length: 14 }, (_, i) => `2026-09-${String(29 + i).padStart(2, '0')}`),
  metrics: [metric({ name: 'Read/turn', fmt: 'n', today: 312000, median7: 208000, vs7: 0.5, regression: true, limit: 200000, dir: 'max', status: 'MISS', series: series([180000, 200000, 312000]) }), metric({ name: 'Wakes/prompt', fmt: 'ratio', today: 0.3, limit: 0.5, dir: 'max', status: 'PASS' })],
  regressions: ['Read/turn'], mix: { opus: 0.57, sonnet: 0.34, haiku: 0.09, opusMax: 0.4, haikuMin: 0.15 },
  running: [], recent: [], today: null, ...o,
});
const draw = (c: CostData | null): HTMLElement | null => { const s = costSection(c); return s ? place(s).el : null; };
const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

test('a regression is named in words on its row and in the header, not by colour alone', () => {
  const el = draw(data())!;
  assert.match(text(el.querySelector('.sec-head')), /1 regressed \(Read\/turn\)/);
  const line = [...el.querySelectorAll('.cost-line')].find((l) => text(l).startsWith('Read/turn'))!;
  assert.match(text(line), /312\.0k.*\+50% vs 7-day median.*at most 200\.0k.*Regression/);
  assert.equal(line.querySelector('svg.spark.bad')?.getAttribute('role'), 'img');
  assert.match(line.querySelector('svg')?.getAttribute('aria-label') ?? '', /Read\/turn, last 14 days/);
});

test('the mix bar says whether each target is met, in text', () => {
  const el = draw(data())!;
  assert.match(text(el.querySelector('.cost-mix-facts')), /Opus 57%, target at most 40%: Target missed.*Haiku 9%, target at least 15%: Target missed/);
  assert.equal(el.querySelectorAll('.cost-mix .seg-bar span').length, 3);
  const met = draw(data({ mix: { opus: 0.3, sonnet: 0.5, haiku: 0.2, opusMax: 0.4, haikuMin: 0.15 } }))!;
  assert.match(text(met.querySelector('.cost-mix-facts')), /Opus 30%.*On target.*Haiku 20%.*On target/);
  const none = draw(data({ mix: { opus: null, sonnet: null, haiku: null, opusMax: 0.4, haikuMin: Number.NaN } }))!;
  assert.match(text(none.querySelector('.cost-mix-facts')), /Opus n\/a.*no data.*Haiku n\/a, target at least unset: no data/);
  assert.match(text(draw(data({ stale: true }))!.querySelector('.sec-head')), /No data since 2026-10-12; regression check not run/);
});

test('an empty state shows its reason, a stale one says how to refresh, and no payload draws no section', () => {
  assert.match(text(draw(data({ state: 'empty', reason: 'The token table has no day to show yet.', metrics: [], mix: null, date: null }))), /no day to show yet/);
  assert.match(text(draw(data({ stale: true })!)!.querySelector('[role=status]')), /newest day in the token table is 2026-10-12/);
  assert.equal(costSection(null), null);
});

test('experiments list today\'s proposal first, then running ones, then recent closed ones', () => {
  const e = (id: string, status: string) => ({ id, practice: `practice ${id}`, metric: 'm', threshold: 't', start: '2026-10-01', status, result: '-' });
  const el = draw(data({ today: e('cx-2026-10-13', 'proposed'), running: [e('B', 'running')], recent: [e('A', 'adopted')] }))!;
  assert.deepEqual([...el.querySelectorAll('.cost-reg li .id')].map((x) => x.textContent), ['cx-2026-10-13', 'B', 'A']);
});

test('a gap in the series breaks the line, and a lone day is a dot', () => {
  const el = draw(data({ metrics: [metric({ name: 'Turns', series: series([5, null, 7, 8]) })], regressions: [] }))!;
  assert.equal(el.querySelectorAll('svg path.ln').length, 1);
  assert.equal(el.querySelectorAll('svg circle.dot').length, 1);
});

test('costValue formats each unit, and a missing number is a dash', () => {
  assert.deepEqual([costValue(0.571, 'pct'), costValue(0.333, 'ratio'), costValue(1.5, 'usd'), costValue(1500, 'n'), costValue(2.5e6, 'n'), costValue(null, 'n')], ['57%', '0.33', '$1.50', '1.5k', '2.5M', '-']);
});

test('sanitizeCost drops a bad metric and a bad mix but keeps the rest, and refuses a body with no usable shape', () => {
  const good = JSON.parse(JSON.stringify(data()));
  const r = sanitizeCost({ ...good, metrics: [...good.metrics, { name: 'broken' }], mix: { opus: 'x' } });
  assert.equal(r?.dropped, 1);
  assert.equal(r?.data.metrics.length, 2);
  assert.equal(r?.data.mix, null);
  assert.equal(sanitizeCost({ state: 'weird' }), null);
  assert.equal(sanitizeCost(null), null);
});
