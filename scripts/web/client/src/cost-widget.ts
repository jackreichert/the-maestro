/** The cost widget on Home: today's token metrics against their 7-day median and limits, the model mix against its target, and the experiment registry. */
import { s, h } from './dom.ts';
import { linePath, linearScale } from './chart-math.ts';
import { empty, grow, part, secHead } from './home-sections.ts';
import type { CostData, CostExperiment, CostMetric } from './types.ts';

export const COST_CSS = `
  .cost-table { list-style: none; margin: 0; padding: 0; }
  .cost-line { display: grid; grid-template-columns: minmax(130px, 1fr) 5.5rem minmax(0, 1.2fr) 7rem 6.5rem; gap: 0 var(--space-3); align-items: center; padding-block: var(--space-2); border-bottom: var(--hairline); font-size: var(--text-sm); }
  .cost-line .v { text-align: right; font-variant-numeric: tabular-nums; font-weight: var(--weight-semibold); }
  .cost-line .vs, .cost-line .tg { color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .cost-line .chip { justify-self: start; padding: 2px var(--space-2); border-radius: var(--radius-sm); font-size: var(--text-xs); background: var(--surface-2); color: var(--text-secondary); }
  .cost-line .chip.bad { background: var(--critical-soft); color: var(--critical); }
  .cost-line .chip.good { background: var(--success-soft); color: var(--success); }
  .spark { width: 100%; height: 24px; display: block; }
  .spark .ln { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
  .spark .dot { fill: var(--accent); }
  .spark.bad .ln { stroke: var(--critical); } .spark.bad .dot { fill: var(--critical); }
  .cost-mix { margin-top: var(--space-4); display: grid; gap: var(--space-2); }
  .cost-mix .seg-bar { height: 10px; }
  .sg-opus { background: var(--series-1); } .sg-sonnet { background: var(--series-2); } .sg-haiku { background: var(--series-3); }
  .cost-mix-facts { margin: 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-6); font-size: var(--text-sm); color: var(--text-secondary); }
  .cost-reg { margin: var(--space-4) 0 0; padding: 0; list-style: none; display: grid; gap: var(--space-2); font-size: var(--text-sm); }
  .cost-reg li { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: baseline; }
  .cost-reg .id { font-family: var(--font-mono, monospace); color: var(--text-muted); }
  .cost-stale { margin: 0 0 var(--space-3); color: var(--warning); font-size: var(--text-sm); }
  @media (max-width: 720px) { .cost-line { grid-template-columns: 1fr auto; } .cost-line .spark-cell, .cost-line .tg { display: none; } }
  @media (forced-colors: active) { .spark .ln { stroke: CanvasText; } .spark .dot { fill: CanvasText; } .seg-bar span { forced-color-adjust: none; background: Highlight; outline: 1px solid CanvasText; } }
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

function metricLine(m: CostMetric, days: string[]): HTMLElement {
  const status = m.regression ? h('span', { class: 'chip bad' }, 'Regression') : m.status === 'MISS' ? h('span', { class: 'chip bad' }, 'Over target') : m.status === 'PASS' ? h('span', { class: 'chip good' }, 'On target') : h('span', { class: 'chip' }, 'No target');
  return h('li', { class: 'cost-line' },
    h('span', {}, m.name),
    h('span', { class: 'v' }, costValue(m.today, m.fmt)),
    h('span', { class: 'spark-cell' }, spark(m, days)),
    h('span', { class: 'vs' }, m.vs7 === null ? 'no 7-day median' : `${signed(m.vs7)} vs 7-day median`),
    h('span', { class: 'tg' }, limitText(m)),
    status);
}

function mixBlock(mix: NonNullable<CostData['mix']>): HTMLElement {
  const part3: [string, string, number | null][] = [['Opus', 'sg-opus', mix.opus], ['Sonnet', 'sg-sonnet', mix.sonnet], ['Haiku', 'sg-haiku', mix.haiku]];
  const pct = (n: number | null): string => (n === null ? 'n/a' : `${Math.round(n * 100)}%`);
  const opusOk = mix.opus !== null && mix.opus <= mix.opusMax;
  const haikuOk = mix.haiku !== null && mix.haiku >= mix.haikuMin;
  return h('div', { class: 'cost-mix' },
    h('h3', {}, 'Model mix, orchestrator read'),
    h('div', { class: 'seg-bar', role: 'img', 'aria-label': `Opus ${pct(mix.opus)}, Sonnet ${pct(mix.sonnet)}, Haiku ${pct(mix.haiku)}` }, ...part3.filter(([, , n]) => n !== null && n > 0).map(([, cls, n]) => grow(cls, n as number))),
    h('ul', { class: 'cost-mix-facts', role: 'list' },
      h('li', {}, `Opus ${pct(mix.opus)}, target at most ${pct(mix.opusMax)}: `, h('b', {}, opusOk ? 'met' : 'missed')),
      h('li', {}, `Sonnet ${pct(mix.sonnet)}`),
      h('li', {}, `Haiku ${pct(mix.haiku)}, target at least ${pct(mix.haikuMin)}: `, h('b', {}, haikuOk ? 'met' : 'missed'))));
}

const expLine = (e: CostExperiment): HTMLElement => h('li', {}, h('span', { class: 'id' }, e.id), h('span', { class: 'chip' }, e.status), h('span', {}, e.practice), e.result && e.result !== '-' ? h('span', { class: 'vs' }, e.result) : null);

/** The Cost section. Null when the server sent none (an old server): a page without the widget is complete. */
export function costSection(c: CostData | null): HTMLElement | null {
  if (!c) return null;
  if (c.state === 'empty') return part('cost-part', secHead('Cost', 0, 'Tokens per day against the 7-day median'), empty(c.reason ?? 'No token history yet.'));
  const aside = c.regressions.length ? `${c.date}: ${c.regressions.length} regressed (${c.regressions.join(', ')})` : `${c.date}: nothing regressed`;
  const exps = [...(c.today ? [c.today] : []), ...c.running.filter((r) => r.id !== c.today?.id), ...c.recent];
  return part('cost-part', secHead('Cost', 0, aside),
    c.stale ? h('p', { class: 'cost-stale', role: 'status' }, `The newest day in the token table is ${c.date}. Run token-metrics.ts --write to bring it up to date.`) : null,
    h('ul', { class: 'cost-table', role: 'list' }, ...c.metrics.map((m) => metricLine(m, c.days))),
    c.mix ? mixBlock(c.mix) : empty('The model mix is not available for this day.'),
    h('ul', { class: 'cost-reg', role: 'list', 'aria-label': 'Cost experiments' }, ...(exps.length ? exps.map(expLine) : [h('li', {}, 'No cost experiments yet.')])));
}
