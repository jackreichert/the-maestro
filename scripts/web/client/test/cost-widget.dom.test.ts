// Run: node --test scripts/web/client/test/cost-widget.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, place } from './dom-harness.ts';
import { sanitizeCost } from '../src/contract.ts';
import type { CostData, CostMetric } from '../src/types.ts';

installDom();
const { costSections, costValue, tempoOf } = await import('../src/cost-widget.ts');

/** Every Cost widget in one container, so a test can look across them as the page would. */
const costSection = (c: CostData | null, t: Parameters<typeof costSections>[1] = null): HTMLElement | null => {
  const s = costSections(c, t);
  if (!s) return null;
  const box = document.createElement('div');
  box.append(s.cost, ...s.rest);
  return box;
};

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
  const line = [...el.querySelectorAll('.dyn')].find((l) => text(l).startsWith('Read/turn'))!;
  assert.match(text(line), /312\.0k.*median 208\.0k · \+50% vs 7-day median.*at most 200\.0k.*Regression/);
  // Today over the median is a dynamic mark (ff: well above typical) with its gloss in words, and a hairpin that opens.
  assert.match(text(line.querySelector('.dyn-mark')), /fortissimo: well above typical/);
  assert.equal(line.querySelector('.dyn-mark > span[aria-hidden]')?.textContent, 'ff');
  assert.ok(line.querySelector('svg.hairpin path'));
  assert.equal(line.querySelector('svg.spark.bad')?.getAttribute('role'), 'img');
  assert.match(line.querySelector('svg')?.getAttribute('aria-label') ?? '', /Read\/turn, last 14 days/);
});

test('the model mix ring says in words whether each goal is met', () => {
  const el = draw(data())!;
  assert.match(text(el.querySelector('.cost-mix-facts')), /Opus 57%, goal at most 40%: Target missed.*Haiku 9%, goal at least 15%: Target missed/);
  assert.equal(el.querySelectorAll('.donut circle.arc').length, 3);
  assert.equal(el.querySelectorAll('.donut line.goal').length, 2, 'both goals are ticks on the ring');
  assert.match(el.querySelector('.donut')?.getAttribute('aria-label') ?? '', /Opus 57%.*Goals: Opus at most 40%, Haiku at least 15%/);
  assert.match(text(el.querySelector('.donut .c1')) + text(el.querySelector('.donut .c2')), /Opus 57%goal \u226440%/);
  const met = draw(data({ mix: { opus: 0.3, sonnet: 0.5, haiku: 0.2, opusMax: 0.4, haikuMin: 0.15 } }))!;
  assert.match(text(met.querySelector('.cost-mix-facts')), /Opus 30%.*On target.*Haiku 20%.*On target/);
  const none = draw(data({ mix: { opus: null, sonnet: null, haiku: null, opusMax: 0.4, haikuMin: Number.NaN } }))!;
  assert.match(text(none.querySelector('.cost-mix-facts')), /Opus n\/a.*no data.*Haiku n\/a, goal at least unset: no data/);
});

test('an empty state shows its reason, a stale one says how to refresh, and no payload draws no section', () => {
  assert.match(text(draw(data({ state: 'empty', reason: 'The token table has no day to show yet.', metrics: [], mix: null, date: null }))), /no day to show yet/);
  assert.match(text(draw(data({ stale: true })!)!.querySelector('[role=status]')), /Last measured 2026-10-12\. There is no fresh measurement/);
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

test('the metronome reads today against the first daily maximum, and rests with a note when no metric has one', () => {
  const el = draw(data())!;
  const read = text(el.querySelector('.metro-read'));
  assert.match(read, /Tokens read per turn: 312\.0k, limit 200\.0k/);
  assert.match(read, /156% of the limit, over it/);
  assert.equal(el.querySelector<SVGElement>('.metro-wrap .metro .pend')!.dataset['angle'], '42', 'pinned at the right end, not past it');
  const none = draw(data({ metrics: [metric({ name: 'Turns' })], regressions: [] }))!;
  assert.match(text(none.querySelector('.metro-read')), /No limit set/);
  assert.equal(none.querySelector<SVGElement>('.metro-wrap .metro .pend')!.dataset['angle'], '-42');
});

test('a metric with no 7-day median has no dynamic mark, and says so in words', () => {
  const el = draw(data({ metrics: [metric({ name: 'Turns', vs7: null, median7: null })], regressions: [] }))!;
  const line = el.querySelector('.dyn')!;
  assert.match(text(line), /no 7-day median/);
  assert.equal(line.querySelector('svg.hairpin'), null);
  assert.match(text(line.querySelector('.dyn-mark')), /no dynamic/);
});

test('a stale measurement says when it was last measured, is muted, and never swings the pendulum', () => {
  const el = draw(data({ stale: true, date: '2026-09-30' }))!;
  assert.ok(el.firstElementChild!.classList.contains('stale'), 'the section is muted');
  assert.match(text(el.querySelector('.sec-head')), /Last measured 2026-09-30; no fresh measurement/);
  const read = text(el.querySelector('.metro-read'));
  assert.match(read, /Tokens read per turn: 312\.0k, limit 200\.0k/);
  assert.match(read, /Last measured 2026-09-30\. No fresh measurement/);
  assert.doesNotMatch(read, /% of the limit/, 'no live-looking percentage');
  assert.equal(el.querySelector<SVGElement>('.metro-wrap .metro .pend')!.dataset['angle'], '-42', 'rests at the left');
  assert.match(text(el.querySelector('.donut-date')), /Last measured 2026-09-30; not today's mix/);
});

test('a fresh measurement labels the day the mix is for', () => {
  assert.match(text(draw(data())!.querySelector('.donut-date')), /Measured for 2026-10-12/);
});

const days = (totals: number[]) => totals.map((total, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, total, byStream: {}, ids: [] }));
const chartsOf = (totals: number[]) => ({ throughput: days(totals) }) as never;

test('the day\'s tempo is today against the median of the seven days before, and null with fewer than three', () => {
  assert.deepEqual(tempoOf(chartsOf([10, 20, 30, 40, 50, 60, 70, 35])), { today: 35, median: 40, date: '2026-10-08' });
  assert.deepEqual(tempoOf(chartsOf([4, 6, 8, 10])), { today: 10, median: 6, date: '2026-10-04' });
  assert.equal(tempoOf(chartsOf([1, 2, 3])), null);
  assert.equal(tempoOf(null), null);
});

test('the tempo pendulum swings right as the day fills, with a dynamics mark and an honest note on what is counted', () => {
  const at = (today: number): { angle: string; text: string } => {
    const s = costSection(data(), { today, median: 20, date: '2026-10-12' })!;
    place(s);
    return { angle: s.querySelector<SVGElement>('.tempo-wrap .metro .pend')!.dataset['angle'] ?? '', text: text(s.querySelector('.tempo-read')) };
  };
  const quiet = at(5);
  const typical = at(20);
  const busy = at(40);
  assert.ok(Number(quiet.angle) < Number(typical.angle) && Number(typical.angle) < Number(busy.angle) + 1);
  assert.equal(typical.angle, '0', 'a typical day is the centre');
  assert.equal(busy.angle, '42', 'twice the median is full right');
  assert.match(quiet.text, /5 shipped today.*pianissimo/);
  assert.match(busy.text, /40 shipped today.*fortissimo/);
  assert.match(busy.text, /merged PRs are not counted separately/);
});

test('no median means no mark and the pendulum at rest, said in words', () => {
  const s = costSection(data(), null)!;
  assert.match(text(s.querySelector('.tempo-read')), /No tempo yet/);
  assert.equal(s.querySelector<SVGElement>('.tempo-wrap .metro .pend')!.dataset['angle'], '-42');
});

test('a tempo for another day is labelled with its date and rests the pendulum, never "today"', () => {
  const s = costSection(data(), { today: 40, median: 20, date: '2026-10-11' })!;
  place(s);
  assert.match(text(s.querySelector('.tempo-read')), /40 shipped on 2026-10-11/);
  assert.doesNotMatch(text(s.querySelector('.tempo-read')), /shipped today/);
  assert.equal(s.querySelector<SVGElement>('.tempo-wrap .metro .pend')!.dataset['angle'], '-42');
  const stale = costSection(data({ stale: true, date: '2026-09-30' }), { today: 40, median: 20, date: '2026-09-30' })!;
  assert.doesNotMatch(text(stale.querySelector('.tempo-read')), /shipped today/, 'a stale reading is never "today"');
});

test('ring shares that add up to more than a whole never draw a negative arc', () => {
  const el = draw(data({ mix: { opus: 0.6, sonnet: 0.5, haiku: 0.3, opusMax: 0.4, haikuMin: 0.15 } }))!;
  const lens = [...el.querySelectorAll('.donut .arc')].map((a) => a.getAttribute('stroke-dasharray') ?? '');
  assert.equal(lens.length, 2, 'the arc that starts past the full circle is dropped');
  for (const l of lens) assert.ok(l.split(' ').every((n) => Number(n) >= 0), l);
});

test('a stale limit line carries its date in the primary text', () => {
  assert.match(text(draw(data({ stale: true, date: '2026-09-30' }))!.querySelector('.metro-read .plain')), /measured 2026-09-30/);
});

test('Cost is split into separate widgets, each with its own heading, and none of them is the whole thing', () => {
  const s = costSections(data({ today: null }), null)!;
  const titles = [s.cost, ...s.rest].map((w) => text(w.querySelector('h2')));
  assert.deepEqual(titles, ['Cost', 'Tempo', 'Model mix', 'Experiments']);
  assert.ok(s.cost.querySelector('.dyn') && !s.cost.querySelector('.donut, .metro, .cost-reg'), 'Cost keeps only the metrics');
  assert.ok(s.rest[0]!.querySelector('.tempo-wrap') && s.rest[0]!.querySelector('.metro-wrap'), 'Tempo holds the tempo and the daily limit');
  assert.ok(s.rest[1]!.querySelector('.donut') && s.rest[2]!.querySelector('.cost-reg'));
  assert.deepEqual(s.rest.map((w) => w.classList.contains('third')), [true, true, true]);
});

test('with no measurement only the Cost widget is drawn, and a stale reading mutes every widget', () => {
  assert.equal(costSections(data({ state: 'empty', reason: 'none', metrics: [], mix: null, date: null }))!.rest.length, 0);
  const stale = costSections(data({ stale: true }))!;
  assert.ok([stale.cost, ...stale.rest].every((w) => w.classList.contains('stale')));
});
