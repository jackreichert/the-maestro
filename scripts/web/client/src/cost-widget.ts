/**
 * Brass: today's token metrics against their 7-day median, each as a dynamic mark (pp to ff) with a hairpin, the metronome for the
 * daily limit, the model mix against its target, and the experiment registry.
 */
import { s, h } from './dom.ts';
import { linePath, linearScale } from './chart-math.ts';
import { tickTock } from './home-ambience.ts';
import { grow } from './home-bars.ts';
import { conceptSection, tacet } from './home-concept.ts';
import { dynamicFor, hairpin } from './home-glyphs.ts';
import type { CostData, CostExperiment, CostMetric } from './types.ts';

export const COST_CSS = `
  .dyn-list { display: grid; margin: 0; padding: 0; list-style: none; }
  .dyn { display: grid; grid-template-columns: minmax(0, 1fr) 72px 56px 64px; align-items: center; gap: var(--space-3); padding-block: var(--space-3); border-top: var(--hairline); }
  .dyn:first-child { border-top: 0; padding-top: 0; }
  .dyn-name { display: grid; gap: 2px; min-width: 0; }
  .dyn-name strong { font-weight: var(--weight-medium); }
  .dyn-name .v { margin-left: var(--space-1); font-family: var(--font-mono); font-size: var(--text-md); color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .dyn-sub { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--space-2); font-size: var(--text-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .dyn-sub .chip { padding: 1px var(--space-2); border-radius: var(--radius-sm); font-size: var(--text-xs); background: var(--surface-2); color: var(--text-secondary); }
  .dyn-sub .chip.bad { background: var(--critical-soft); color: var(--critical); }
  .dyn-sub .chip.good { background: var(--success-soft); color: var(--success); }
  .dyn-mark { font-family: var(--font-display); font-style: italic; font-size: var(--text-2xl); line-height: 1; text-align: center; letter-spacing: 0.02em; }
  .dyn-mark > span[aria-hidden] { display: inline-block; }
  .dyn-mark.none { color: var(--text-muted); font-style: normal; }
  .hairpin { width: 64px; height: 18px; color: var(--text-secondary); }
  .hairpin path { fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; }
  .spark { width: 100%; height: 24px; display: block; }
  .spark .ln { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
  .spark .dot { fill: var(--accent); }
  .spark.bad .ln { stroke: var(--critical); } .spark.bad .dot { fill: var(--critical); }
  @media (hover: hover) and (prefers-reduced-motion: no-preference) {
    .dyn .dyn-mark > span[aria-hidden] { transition: transform var(--dur-base) var(--ease-spring); }
    .dyn:hover .dyn-mark > span[aria-hidden] { transform: scale(1.18) rotate(-4deg); }
  }
  @media (max-width: 560px) { .dyn { grid-template-columns: minmax(0, 1fr) 48px 64px; } .dyn .spark-cell { display: none; } }

  .metro-wrap { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: var(--space-5); align-items: center; margin-top: var(--space-5); }
  .metro { width: 96px; height: 112px; color: var(--ink); }
  .metro .body { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linejoin: round; }
  .metro .tick { stroke: var(--staff); stroke-width: 1; }
  .metro .tick.lit { stroke: var(--accent); transition: stroke var(--dur-fast) var(--ease-out); }
  /* The pendulum swings from its rest at the left to its reading as the section appears; its resting angle is set from the data. */
  .metro .pend { transform-box: view-box; transform-origin: 48px 92px; animation: swing 900ms var(--ease-spring) backwards; }
  @keyframes swing { from { transform: rotate(-42deg); } }
  @media (prefers-reduced-motion: reduce) { .metro .pend { animation: none; } }
  .metro .pend line { stroke: currentColor; stroke-width: 1.5; }
  .metro .pend rect { fill: var(--accent); }
  .metro-read { display: grid; gap: var(--space-1); }
  .metro-read .big { margin: 0; font-family: var(--font-display); font-size: var(--text-2xl); line-height: 1; font-variant-numeric: tabular-nums; }
  .metro-read span { font-size: var(--text-sm); color: var(--text-secondary); }

  .mix { margin-top: var(--space-5); display: grid; gap: var(--space-2); --mix-1: var(--text-primary); --mix-2: color-mix(in srgb, var(--text-primary) 50%, transparent); --mix-3: color-mix(in srgb, var(--text-primary) 22%, transparent); }
  .mix h3 { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-medium); }
  /* Series colours mean "stream" everywhere else on the page, so models get an ink ramp instead: darkest is the most expensive. The target mark is the accent, so it reads against all three. */
  .mix-bar { position: relative; display: flex; height: 10px; gap: 2px; }
  .mix-bar span { display: block; min-width: 3px; height: 100%; border-radius: 2px; }
  .mix-bar .m-opus { background: var(--mix-1); } .mix-bar .m-sonnet { background: var(--mix-2); } .mix-bar .m-haiku { background: var(--mix-3); }
  .mix-bar .mix-target { position: absolute; top: -4px; bottom: -4px; width: 2px; min-width: 2px; height: auto; background: var(--accent); border-radius: 1px; box-shadow: 0 0 0 1.5px var(--surface-page); }
  .mix-legend { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); margin: 0; padding: 0; list-style: none; font-size: var(--text-sm); color: var(--text-secondary); }
  .mix-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; vertical-align: 1px; }
  .mix-legend .m-opus { background: var(--mix-1); } .mix-legend .m-sonnet { background: var(--mix-2); } .mix-legend .m-haiku { background: var(--mix-3); }
  .cost-mix-facts { margin: 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-5); font-size: var(--text-sm); color: var(--text-secondary); }
  .exp-h { margin: var(--space-5) 0 0; font-size: var(--text-sm); font-weight: var(--weight-medium); }
  .cost-reg { margin: var(--space-2) 0 0; padding: 0; list-style: none; display: grid; gap: var(--space-2); font-size: var(--text-sm); }
  .cost-reg li { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: baseline; border-top: var(--hairline); padding-top: var(--space-2); }
  .cost-reg .id { font-family: var(--font-mono); color: var(--text-muted); }
  .cost-reg .chip { padding: 1px var(--space-2); border-radius: var(--radius-sm); font-size: var(--text-xs); background: var(--surface-2); color: var(--text-secondary); }
  .cost-reg .chip.good { background: var(--success-soft); color: var(--success); }
  .cost-reg .vs { color: var(--text-muted); margin-left: auto; }
  .cost-stale { margin: 0 0 var(--space-3); color: var(--warning); font-size: var(--text-sm); }
  @media (forced-colors: active) { .spark .ln { stroke: CanvasText; } .spark .dot { fill: CanvasText; } .mix-bar span, .mix-legend i { forced-color-adjust: none; background: CanvasText; } .metro .pend rect { forced-color-adjust: none; fill: Highlight; } }
`;

/** A value in the unit the metric uses: a whole percentage, a ratio to two places, dollars, or a compact count (1.2k, 3.4M). */
export function costValue(n: number | null, fmt: CostMetric['fmt']): string {
  if (n === null) return '-';
  if (fmt === 'pct') return `${Math.round(n * 100)}%`;
  if (fmt === 'ratio') return n.toFixed(2);
  if (fmt === 'usd') return `$${n.toFixed(2)}`;
  const a = Math.abs(n);
  return a >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
}

const signed = (p: number): string => `${p >= 0 ? '+' : ''}${Math.round(p * 100)}%`;

/** Runs of consecutive days that have a value, as `[x, y]` points in a 100 by 24 box; a missing day breaks the line. */
function runs(series: (number | null)[]): [number, number][][] {
  const have = series.filter((v): v is number => v !== null);
  const y = linearScale([Math.min(0, ...have), Math.max(...have, 1e-9)], [22, 2]);
  const x = linearScale([0, Math.max(series.length - 1, 1)], [1, 99]);
  const out: [number, number][][] = [];
  series.forEach((v, i) => {
    if (v === null) { out.push([]); return; }
    if (!out.length) out.push([]);
    out[out.length - 1]?.push([x(i), y(v)]);
  });
  return out.filter((r) => r.length);
}

function spark(m: CostMetric, days: string[]): SVGElement {
  const label = `${m.name}, last ${days.length} days: ${m.series.map((v, i) => `${days[i] ?? ''} ${costValue(v, m.fmt)}`).join(', ')}`;
  const marks = runs(m.series).map((r) => (r.length > 1 ? s('path', { class: 'ln', d: linePath(r) }) : s('circle', { class: 'dot', cx: String(r[0]?.[0] ?? 0), cy: String(r[0]?.[1] ?? 0), r: '1.8' })));
  return s('svg', { class: `spark${m.regression ? ' bad' : ''}`, viewBox: '0 0 100 24', preserveAspectRatio: 'none', role: 'img', 'aria-label': label }, ...marks);
}

function limitText(m: CostMetric): string {
  return m.limit === null || m.dir === null ? '' : `${m.dir === 'max' ? 'at most' : 'at least'} ${costValue(m.limit, m.fmt)}`;
}

/** One metric as a dynamic: its value, how far from its 7-day median, the target, and a mark from pp to ff for today over the median. */
function dynamic(m: CostMetric, days: string[]): HTMLElement {
  const status = m.regression ? h('span', { class: 'chip bad' }, 'Regression') : m.status === 'MISS' ? h('span', { class: 'chip bad' }, 'Target missed') : m.status === 'PASS' ? h('span', { class: 'chip good' }, 'On target') : h('span', { class: 'chip' }, 'No target');
  const ratio = m.vs7 === null ? null : 1 + m.vs7;
  const d = ratio === null ? null : dynamicFor(ratio);
  const limit = limitText(m);
  return h('li', { class: 'dyn' },
    h('div', { class: 'dyn-name' },
      h('strong', {}, m.name, h('span', { class: 'v' }, costValue(m.today, m.fmt))),
      h('span', { class: 'dyn-sub' }, h('span', {}, m.vs7 === null ? 'no 7-day median' : `median ${costValue(m.median7, m.fmt)} · ${signed(m.vs7)} vs 7-day median`), limit ? h('span', {}, limit) : null, status)),
    h('span', { class: 'spark-cell' }, spark(m, days)),
    h('span', { class: `dyn-mark${d ? '' : ' none'}`, title: d?.gloss }, h('span', { 'aria-hidden': 'true' }, d ? d.mark : '·'), h('span', { class: 'vh' }, d ? d.gloss : 'no dynamic: no 7-day median')),
    ratio === null ? h('span', {}) : hairpin(ratio));
}

const REST = -42;
const SPAN = 84;

/** The metronome: the first metric held to a maximum, today as a share of that limit. The pendulum rests at the left until there is a limit to read. */
function metronome(c: CostData): HTMLElement {
  const m = c.metrics.find((x) => x.dir === 'max' && x.limit !== null && x.limit > 0 && x.today !== null);
  const ratio = m && m.today !== null && m.limit !== null ? m.today / m.limit : null;
  const angle = REST + Math.min(1, Math.max(0, ratio ?? 0)) * SPAN;
  const ticks = Array.from({ length: 9 }, (_, k) => {
    const a = ((REST + k * 10.5) * Math.PI) / 180;
    return s('line', { class: 'tick', x1: String(48 + Math.sin(a) * 58), y1: String(92 - Math.cos(a) * 58), x2: String(48 + Math.sin(a) * 64), y2: String(92 - Math.cos(a) * 64) });
  });
  const pend = s('g', { class: 'pend' }, s('line', { x1: '48', y1: '92', x2: '48', y2: '30' }), s('rect', { x: '43', y: '46', width: '10', height: '7', rx: '1.5' }));
  pend.dataset['angle'] = String(angle);
  pend.style.transform = `rotate(${angle}deg)`;
  const svg = s('svg', { class: 'metro', viewBox: '0 0 96 112', 'aria-hidden': 'true', focusable: 'false' }, ...ticks, s('path', { class: 'body', d: 'M34 8 H62 L86 106 H10 Z' }), pend, s('circle', { cx: '48', cy: '92', r: '3', fill: 'currentColor' }));
  svg.addEventListener('pointerenter', () => tickTock(pend, ticks, angle));
  return h('div', { class: 'metro-wrap' }, svg,
    h('div', { class: 'metro-read' },
      ...(m && ratio !== null && m.limit !== null
        ? [h('p', { class: 'big' }, `${Math.round(ratio * 100)}%`, ' of the limit'), h('span', {}, `${m.name}: ${costValue(m.today, m.fmt)} of at most ${costValue(m.limit, m.fmt)}. The pendulum swings right as the day fills.`)]
        : [h('p', { class: 'big' }, 'No limit set'), h('span', {}, 'No metric has a daily maximum yet, so the pendulum rests at the left.')])));
}

function mixBlock(mix: NonNullable<CostData['mix']>): HTMLElement {
  const parts: [string, string, number | null][] = [['Opus', 'm-opus', mix.opus], ['Sonnet', 'm-sonnet', mix.sonnet], ['Haiku', 'm-haiku', mix.haiku]];
  const pct = (n: number | null): string => (n === null ? 'n/a' : `${Math.round(n * 100)}%`);
  const verdict = (share: number | null, target: number, max: boolean): string => (share === null ? 'no data' : !Number.isFinite(target) ? 'no target' : (max ? share <= target : share >= target) ? 'On target' : 'Target missed');
  const tg = (n: number): string => (Number.isFinite(n) ? pct(n) : 'unset');
  const bar = h('div', { class: 'mix-bar', role: 'img', 'aria-label': `Model mix: Opus ${pct(mix.opus)}, Sonnet ${pct(mix.sonnet)}, Haiku ${pct(mix.haiku)}. Opus target at most ${tg(mix.opusMax)}.` },
    ...parts.filter(([, , n]) => n !== null && n > 0).map(([, cls, n]) => grow(cls, n as number)));
  if (Number.isFinite(mix.opusMax)) {
    const mark = h('span', { class: 'mix-target', title: 'Opus target' });
    mark.style.left = `calc(${Math.min(1, Math.max(0, mix.opusMax)) * 100}% - 1px)`;
    bar.append(mark);
  }
  return h('div', { class: 'mix' },
    h('h3', {}, 'Model mix'),
    bar,
    h('ul', { class: 'mix-legend', role: 'list', 'aria-hidden': 'true' }, ...parts.map(([name, cls, n]) => h('li', {}, h('i', { class: cls }), `${name} ${pct(n)}`))),
    h('ul', { class: 'cost-mix-facts', role: 'list' },
      h('li', {}, `Opus ${pct(mix.opus)}, target at most ${tg(mix.opusMax)}: `, h('b', {}, verdict(mix.opus, mix.opusMax, true))),
      h('li', {}, `Sonnet ${pct(mix.sonnet)}`),
      h('li', {}, `Haiku ${pct(mix.haiku)}, target at least ${tg(mix.haikuMin)}: `, h('b', {}, verdict(mix.haiku, mix.haikuMin, false)))));
}

const expLine = (e: CostExperiment, lead = false): HTMLElement => h('li', {}, lead ? h('span', { class: 'chip good' }, 'Today') : null, h('span', { class: 'id' }, e.id), h('span', { class: 'chip' }, e.status), h('span', {}, e.practice), e.result && e.result !== '-' ? h('span', { class: 'vs' }, e.result) : null);

/** The Cost section. Null when the server sent none (an old server): a page without the widget is complete. */
export function costSection(c: CostData | null): HTMLElement | null {
  if (!c) return null;
  if (c.state === 'empty') return conceptSection('brass half', { instrument: 'Brass', title: 'Cost', n: null, hint: 'Tokens per day against the 7-day median' }, tacet(c.reason ?? 'No token history yet.', 'tacet'));
  const aside = c.regressions.length ? `${c.date}: ${c.regressions.length} regressed (${c.regressions.join(', ')})` : `${c.date}: nothing regressed`;
  const head = c.stale ? `No data since ${c.date}; regression check not run for today` : aside;
  const exps = [...(c.today ? [c.today] : []), ...c.running.filter((r) => r.id !== c.today?.id), ...c.recent];
  return conceptSection('brass half', { instrument: 'Brass', title: 'Cost', n: null, hint: head },
    c.stale ? h('p', { class: 'cost-stale', role: 'status' }, `The newest day in the token table is ${c.date}. Run token-metrics.ts --write to bring it up to date.`) : null,
    h('ul', { class: 'dyn-list', role: 'list', 'aria-label': 'Cost metrics, today against the 7-day median' }, ...c.metrics.map((m) => dynamic(m, c.days))),
    metronome(c),
    c.mix ? mixBlock(c.mix) : tacet('The model mix is not available for this day.', 'tacet'),
    h('h3', { class: 'exp-h' }, 'Experiments'),
    h('ul', { class: 'cost-reg', role: 'list', 'aria-label': 'Cost experiments' }, ...(exps.length ? exps.map((e) => expLine(e, e.id === c.today?.id)) : []), ...(c.today ? [] : [h('li', {}, 'No experiment proposed today.')])));
}
