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
import type { ChartsData, CostData, CostExperiment, CostMetric } from './types.ts';

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
  .cost-stale { margin: 0 0 var(--space-3); color: var(--text-secondary); font-size: var(--text-sm); }
  /* Stale: the numbers are kept, but quiet. The accent goes to muted ink and the ink ramp flattens, so nothing reads as a live gauge. */
  .brass.stale { --accent: var(--text-muted); --critical: var(--text-secondary); --critical-soft: var(--surface-2); --success: var(--text-secondary); --success-soft: var(--surface-2); }
  .brass.stale .dyn-mark { color: var(--text-secondary); }
  .gauge { display: grid; gap: var(--space-2); }
  .gauge h3 { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-medium); }
  .gauges { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-5); margin-top: var(--space-5); }
  .tempo-wrap { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: var(--space-5); align-items: center; }
  .tempo-read { display: grid; gap: var(--space-1); }
  .tempo-read .big { margin: 0; font-family: var(--font-display); font-size: var(--text-2xl); line-height: 1; font-variant-numeric: tabular-nums; }
  .tempo-read span { font-size: var(--text-sm); color: var(--text-secondary); }
  .tempo-read .dynmark { font-family: var(--font-display); font-style: italic; font-size: var(--text-xl); margin-right: var(--space-2); color: var(--text-primary); }
  .metro-read .plain { font-size: var(--text-md); color: var(--text-primary); }
  .donut-wrap { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: var(--space-5); align-items: center; }
  .donut { width: 120px; height: 120px; }
  .donut circle.track { fill: none; stroke: var(--surface-2); stroke-width: 14; }
  .donut circle.arc { fill: none; stroke-width: 14; }
  .donut .a-opus { stroke: var(--mix-1); } .donut .a-sonnet { stroke: var(--mix-2); } .donut .a-haiku { stroke: var(--mix-3); }
  .donut line.goal { stroke: var(--accent); stroke-width: 3; stroke-linecap: round; }
  .donut text { fill: var(--text-primary); font-family: var(--font-display); text-anchor: middle; }
  .donut .c1 { font-size: 15px; } .donut .c2 { font-size: 9px; fill: var(--text-secondary); }
  .donut-says { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; font-size: var(--text-sm); color: var(--text-secondary); }
  .donut-says b { color: var(--text-primary); font-weight: var(--weight-medium); }
  .donut-date { margin: 0; font-size: var(--text-xs); color: var(--text-muted); }
  @media (max-width: 560px) { .tempo-wrap, .metro-wrap { grid-template-columns: 72px minmax(0, 1fr); } .donut-wrap { grid-template-columns: 96px minmax(0, 1fr); } .donut { width: 96px; height: 96px; } }
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

/** Plain names for the metrics a reader sees spelled out; any other metric keeps its own name. */
const PLAIN: Record<string, string> = { 'Read/turn': 'Tokens read per turn' };
const plainName = (name: string): string => PLAIN[name] ?? name;

/** A pendulum at `angle` degrees on a metronome body; hovering ticks it. Shared by the limit gauge and the day's tempo. */
function pendulum(angle: number): SVGElement {
  const ticks = Array.from({ length: 9 }, (_, k) => {
    const a = ((REST + k * 10.5) * Math.PI) / 180;
    return s('line', { class: 'tick', x1: String(48 + Math.sin(a) * 58), y1: String(92 - Math.cos(a) * 58), x2: String(48 + Math.sin(a) * 64), y2: String(92 - Math.cos(a) * 64) });
  });
  const pend = s('g', { class: 'pend' }, s('line', { x1: '48', y1: '92', x2: '48', y2: '30' }), s('rect', { x: '43', y: '46', width: '10', height: '7', rx: '1.5' }));
  pend.dataset['angle'] = String(angle);
  pend.style.transform = `rotate(${angle}deg)`;
  const svg = s('svg', { class: 'metro', viewBox: '0 0 96 112', 'aria-hidden': 'true', focusable: 'false' }, ...ticks, s('path', { class: 'body', d: 'M34 8 H62 L86 106 H10 Z' }), pend, s('circle', { cx: '48', cy: '92', r: '3', fill: 'currentColor' }));
  svg.addEventListener('pointerenter', () => tickTock(pend, ticks, angle));
  return svg;
}

/**
 * The limit gauge: the first metric held to a maximum, said in words ("Tokens read per turn: 417k, limit 200k"). The pendulum shows today as a share of
 * the limit, and rests at the left when the measurement is not fresh or there is no limit, so a stale number never reads as a live gauge.
 */
function metronome(c: CostData): HTMLElement {
  const m = c.metrics.find((x) => x.dir === 'max' && x.limit !== null && x.limit > 0 && x.today !== null);
  const ratio = m && m.today !== null && m.limit !== null ? m.today / m.limit : null;
  const live = !c.stale && ratio !== null;
  const angle = REST + Math.min(1, Math.max(0, live ? ratio : 0)) * SPAN;
  const said = m && m.today !== null && m.limit !== null ? `${plainName(m.name)}: ${costValue(m.today, m.fmt)}, limit ${costValue(m.limit, m.fmt)}` : '';
  return h('div', { class: 'metro-wrap' }, pendulum(angle),
    h('div', { class: 'metro-read' },
      ...(m && ratio !== null
        ? [h('p', { class: 'plain' }, said),
          h('span', {}, c.stale ? `Last measured ${c.date}. No fresh measurement, so the pendulum rests.` : `${Math.round(ratio * 100)}% of the limit${ratio > 1 ? ', over it' : ''}. The pendulum swings right as the day fills.`)]
        : [h('p', { class: 'plain' }, 'No limit set'), h('span', {}, 'No metric has a daily maximum yet, so the pendulum rests at the left.')])));
}

/** What the day's tempo counts: finished work items per day from the charts, today against the median of the seven days before. */
export interface Tempo { today: number; median: number; date: string }

/** The day's tempo from the charts, or null when there are fewer than three earlier days to take a median of. */
export function tempoOf(charts: ChartsData | null): Tempo | null {
  const rows = charts?.throughput ?? [];
  const today = rows.at(-1);
  const before = rows.slice(-8, -1).map((r) => r.total).sort((x, y) => x - y);
  if (!today || before.length < 3) return null;
  const mid = Math.floor(before.length / 2);
  const median = before.length % 2 ? (before[mid] as number) : (((before[mid - 1] as number) + (before[mid] as number)) / 2);
  return { today: today.total, median, date: today.date };
}

/**
 * The day's tempo, the pendulum's positive use: work shipped today against the 7-day median. It swings right as the day fills (centre is a typical
 * day, full right is twice that) and carries a dynamics mark from pp to ff. Merged PRs are not counted separately; this counts finished work items.
 */
function tempo(t: Tempo | null): HTMLElement {
  if (!t) return h('div', { class: 'tempo-wrap' }, pendulum(REST), h('div', { class: 'tempo-read' }, h('p', { class: 'big' }, 'No tempo yet'), h('span', {}, 'Fewer than three earlier days of shipped work, so there is no median to compare today with.')));
  const ratio = t.median > 0 ? t.today / t.median : null;
  const d = ratio === null ? null : dynamicFor(ratio);
  const angle = REST + Math.min(1, ratio === null ? 0 : ratio / 2) * SPAN;
  return h('div', { class: 'tempo-wrap' }, pendulum(angle),
    h('div', { class: 'tempo-read' },
      h('p', { class: 'big' }, d ? h('span', { class: 'dynmark', 'aria-hidden': 'true' }, d.mark) : null, `${t.today} shipped today`),
      h('span', {}, d ? `${d.gloss}. The 7-day median is ${costValue(t.median, 'n')} a day.` : `No work shipped on a typical day yet, so there is no mark. The 7-day median is ${costValue(t.median, 'n')} a day.`),
      h('span', {}, 'Counts finished work items; merged PRs are not counted separately.')));
}

/** A small heading over one gauge. */
const gauge = (title: string, body: HTMLElement): HTMLElement => h('div', { class: 'gauge' }, h('h3', {}, title), body);

const TAU = Math.PI * 2;
const RING = 44;

/** The model mix as a ring: Opus, Sonnet, Haiku in an ink ramp from the top, with each goal as a tick on the ring and in words under it. */
function mixBlock(mix: NonNullable<CostData['mix']>, date: string | null, stale: boolean): HTMLElement {
  const parts: [string, string, number | null][] = [['Opus', 'opus', mix.opus], ['Sonnet', 'sonnet', mix.sonnet], ['Haiku', 'haiku', mix.haiku]];
  const pct = (n: number | null): string => (n === null ? 'n/a' : `${Math.round(n * 100)}%`);
  const verdict = (share: number | null, target: number, max: boolean): string => (share === null ? 'no data' : !Number.isFinite(target) ? 'no goal' : (max ? share <= target : share >= target) ? 'On target' : 'Target missed');
  const tg = (n: number): string => (Number.isFinite(n) ? pct(n) : 'unset');
  const C = TAU * RING;
  let at = 0;
  const arcs = parts.flatMap(([, cls, n]) => {
    if (n === null || n <= 0) return [];
    const len = Math.min(n, 1 - at) * C;
    const arc = s('circle', { class: `arc a-${cls}`, cx: '60', cy: '60', r: String(RING), 'stroke-dasharray': `${len} ${C - len}`, 'stroke-dashoffset': String(-at * C), transform: 'rotate(-90 60 60)' });
    at += n;
    return [arc];
  });
  const tick = (frac: number): SVGElement => {
    const a = frac * TAU;
    return s('line', { class: 'goal', x1: String(60 + Math.sin(a) * (RING - 12)), y1: String(60 - Math.cos(a) * (RING - 12)), x2: String(60 + Math.sin(a) * (RING + 12)), y2: String(60 - Math.cos(a) * (RING + 12)) });
  };
  const goals = [...(Number.isFinite(mix.opusMax) ? [tick(Math.min(1, Math.max(0, mix.opusMax)))] : []), ...(Number.isFinite(mix.haikuMin) ? [tick(Math.min(1, Math.max(0, 1 - mix.haikuMin)))] : [])];
  const label = `Model mix: Opus ${pct(mix.opus)}, Sonnet ${pct(mix.sonnet)}, Haiku ${pct(mix.haiku)}. Goals: Opus at most ${tg(mix.opusMax)}, Haiku at least ${tg(mix.haikuMin)}.`;
  const ring = s('svg', { class: 'donut', viewBox: '0 0 120 120', role: 'img', 'aria-label': label },
    s('circle', { class: 'track', cx: '60', cy: '60', r: String(RING) }), ...arcs, ...goals,
    s('text', { class: 'c1', x: '60', y: '60' }, `Opus ${pct(mix.opus)}`),
    s('text', { class: 'c2', x: '60', y: '74' }, Number.isFinite(mix.opusMax) ? `goal \u2264${tg(mix.opusMax)}` : 'no goal'));
  return h('div', { class: 'mix' },
    h('h3', {}, 'Model mix'),
    h('div', { class: 'donut-wrap' }, ring,
      h('div', {},
        h('ul', { class: 'mix-legend', role: 'list', 'aria-hidden': 'true' }, ...parts.map(([name, cls, n]) => h('li', {}, h('i', { class: `m-${cls}` }), `${name} ${pct(n)}`))),
        h('ul', { class: 'cost-mix-facts', role: 'list' },
          h('li', {}, `Opus ${pct(mix.opus)}, goal at most ${tg(mix.opusMax)}: `, h('b', {}, verdict(mix.opus, mix.opusMax, true))),
          h('li', {}, `Sonnet ${pct(mix.sonnet)}`),
          h('li', {}, `Haiku ${pct(mix.haiku)}, goal at least ${tg(mix.haikuMin)}: `, h('b', {}, verdict(mix.haiku, mix.haikuMin, false)))),
        date ? h('p', { class: 'donut-date' }, stale ? `Last measured ${date}; not today's mix.` : `Measured for ${date}.`) : null)));
}

const expLine = (e: CostExperiment, lead = false): HTMLElement => h('li', {}, lead ? h('span', { class: 'chip good' }, 'Today') : null, h('span', { class: 'id' }, e.id), h('span', { class: 'chip' }, e.status), h('span', {}, e.practice), e.result && e.result !== '-' ? h('span', { class: 'vs' }, e.result) : null);

/** The Cost section. Null when the server sent none (an old server): a page without the widget is complete. */
export function costSection(c: CostData | null, tempoData: Tempo | null = null): HTMLElement | null {
  if (!c) return null;
  if (c.state === 'empty') return conceptSection('brass half', { instrument: 'Brass', title: 'Cost', n: null, hint: 'Tokens per day against the 7-day median' }, tacet(c.reason ?? 'No token history yet.', 'tacet'));
  const aside = c.regressions.length ? `${c.date}: ${c.regressions.length} regressed (${c.regressions.join(', ')})` : `${c.date}: nothing regressed`;
  const head = c.stale ? `Last measured ${c.date}; no fresh measurement` : aside;
  const exps = [...(c.today ? [c.today] : []), ...c.running.filter((r) => r.id !== c.today?.id), ...c.recent];
  return conceptSection(`brass half${c.stale ? ' stale' : ''}`, { instrument: 'Brass', title: 'Cost', n: null, hint: head },
    c.stale ? h('p', { class: 'cost-stale', role: 'status' }, `Last measured ${c.date}. There is no fresh measurement, so the numbers below are from that day, not today. Run token-metrics.ts --write to bring them up to date.`) : null,
    h('ul', { class: 'dyn-list', role: 'list', 'aria-label': 'Cost metrics, today against the 7-day median' }, ...c.metrics.map((m) => dynamic(m, c.days))),
    h('div', { class: 'gauges' }, gauge("Day's tempo", tempo(tempoData)), gauge('Daily limit', metronome(c)), c.mix ? mixBlock(c.mix, c.date, c.stale) : tacet('The model mix is not available for this day.', 'tacet')),
    h('h3', { class: 'exp-h' }, 'Experiments'),
    h('ul', { class: 'cost-reg', role: 'list', 'aria-label': 'Cost experiments' }, ...(exps.length ? exps.map((e) => expLine(e, e.id === c.today?.id)) : []), ...(c.today ? [] : [h('li', {}, 'No experiment proposed today.')])));
}
