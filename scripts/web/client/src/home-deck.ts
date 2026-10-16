/** Percussion: the deck. Per day for 14 days, a dot above the line for each item shipped and a cross below it for each cue still open that was asked that day, in the stream's colour. Then the open-work gauges. */
import { h, s, streamTag } from './dom.ts';
import { drumRoll } from './home-ambience.ts';
import { fill, grow } from './home-bars.ts';
import { conceptSection, streamVar } from './home-concept.ts';
import { askAgeBars, prGauge } from './home-model.ts';
import type { CiKey, Score } from './home-model.ts';
import { OPEN_PRS, formatFragment } from './tabs.ts';
import type { ChartsData, PodiumState } from './types.ts';

export const DECK_CSS = `
  .perc-svg { display: block; width: 100%; height: auto; color: var(--ink); overflow: visible; }
  .perc-svg .line { stroke: var(--staff); stroke-width: 1; }
  .perc-svg .bar { stroke: var(--ink); stroke-width: 1; }
  /* Shape says what kind of hit it is (dot shipped, cross asked); colour says which stream it came from. */
  .perc-svg .hit { fill: var(--stream-color, var(--ink)); }
  .perc-svg .x { stroke: var(--stream-color, var(--ink)); stroke-width: 1.4; stroke-linecap: round; fill: none; }
  .perc-svg .col-hit { fill: transparent; }
  .perc-svg .col-bg { fill: var(--accent); opacity: 0; transition: opacity var(--dur-fast) var(--ease-out); }
  .perc-svg .day:hover .col-bg { opacity: 0.08; }
  .perc-svg .day.today .col-bg { opacity: 0.1; }
  .perc-svg .hit, .perc-svg .x { transition: opacity var(--dur-base) var(--ease-out); }
  .perc-svg.focusing .hit:not(.on), .perc-svg.focusing .x:not(.on) { opacity: 0.15; }
  .perc-streams { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); margin: var(--space-2) 0 0; padding: 0; list-style: none; font-size: var(--text-sm); color: var(--text-secondary); }
  .legend { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-5); margin: var(--space-4) 0 0; padding: 0; list-style: none; font-size: var(--text-sm); color: var(--text-secondary); }
  .legend .k { display: inline-flex; align-items: center; gap: var(--space-2); font-variant-numeric: tabular-nums; }
  .legend svg { width: 12px; height: 12px; }
  .legend b { font-family: var(--font-mono); font-weight: var(--weight-medium); color: var(--text-primary); }
  .weeks { display: flex; justify-content: space-between; margin-top: var(--space-1); font-size: var(--text-xs); color: var(--text-muted); }
  .enter .perc-svg .day { animation: fade-up var(--dur-base) var(--ease-out) backwards; animation-delay: calc(var(--i, 0) * var(--stagger)); }

  .bars { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr) 2.5rem; gap: var(--space-2) var(--space-3); align-items: center; margin: 0; padding: 0; list-style: none; font-size: var(--text-sm); }
  .bars li { display: contents; }
  .bars .track { height: 8px; border-radius: 2px; background: var(--surface-2); overflow: hidden; }
  .bars .fill { display: block; height: 100%; background: var(--accent); }
  .bars .stale .fill { background: var(--warning); }
  .bars .v { text-align: right; font-variant-numeric: tabular-nums; }
  .cibar { display: flex; height: 10px; border-radius: 2px; overflow: hidden; gap: 1px; background: var(--surface-2); }
  .cibar span { display: block; min-width: 3px; }
  .ci-pass { background: var(--success); } .ci-pending { background: var(--warning); } .ci-fail { background: var(--critical); } .ci-none { background: var(--text-muted); }
  .ci-legend { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); margin: var(--space-3) 0 0; padding: 0; list-style: none; font-size: var(--text-sm); color: var(--text-secondary); }
  .ci-legend li { display: inline-flex; align-items: center; gap: var(--space-2); font-variant-numeric: tabular-nums; }
  .ci-legend i { width: 8px; height: 8px; border-radius: 2px; }
  .facts3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); margin: var(--space-4) 0 0; }
  .facts3 div { font-size: var(--text-sm); color: var(--text-secondary); }
  .facts3 b { display: block; font-family: var(--font-display); font-size: var(--text-2xl); font-weight: var(--weight-regular); line-height: 1.1; color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .facts3 .warn b { color: var(--warning); }
  @media (forced-colors: active) {
    .perc-svg .hit { forced-color-adjust: none; fill: CanvasText; } .perc-svg .x { forced-color-adjust: none; stroke: CanvasText; }
    .bars .fill, .cibar span, .qbar span { forced-color-adjust: none; background: Highlight; outline: 1px solid CanvasText; }
  }
`;

/** One day of the deck: the streams of the items shipped that day and of the cues, still open, that were asked that day. */
export interface DeckDay { date: string; shipped: string[]; asked: string[] }

/** The calendar day of an instant, in the board's time zone, as YYYY-MM-DD; '' when the instant is not a date. */
export function dayIn(iso: string, tz: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms); } catch { return new Date(ms).toISOString().slice(0, 10); }
}

/**
 * The deck's data, all from the board: shipped per day per stream is the throughput the charts already carry, and asked per day is
 * the open cues bucketed by the day they were asked. (A cue answered since leaves the board, so past days show what is still waiting, not everything ever asked.)
 */
export function deckDays(st: PodiumState, charts: ChartsData, score: Score): DeckDay[] {
  const byDate = new Map(charts.throughput.map((t) => [t.date, t.byStream]));
  const asked = new Map<string, string[]>();
  for (const a of st.asks) {
    const day = dayIn(a.ts, st.tz);
    if (day) asked.set(day, [...(asked.get(day) ?? []), a.stream]);
  }
  const order = (xs: string[]): string[] => [...xs].sort((a, b) => st.streams.indexOf(a) - st.streams.indexOf(b));
  return score.days.map((d) => ({
    date: d.date,
    shipped: order(Object.entries(byDate.get(d.date) ?? {}).flatMap(([stream, n]) => Array.from({ length: n }, () => stream))),
    asked: order(asked.get(d.date) ?? []),
  }));
}

const W = 560;
const Y = 44;
const X0 = 14;

/** Percussion. Null when there is no score to hang it on (the charts did not load). */
export function deckSection(st: PodiumState, charts: ChartsData | null, score: Score | null): HTMLElement {
  if (!charts || !score || score.days.length === 0) {
    return conceptSection('perc half', { instrument: 'Percussion', title: 'The deck', plain: 'shipped and asked per day', n: null },
      h('p', { class: 'tacet', role: 'status' }, 'The daily deck is missing: the charts data did not load.'));
  }
  const days = deckDays(st, charts, score);
  const step = (W - X0 - 10) / days.length;
  const g: SVGElement[] = [
    s('line', { class: 'line', x1: '2', x2: String(W - 2), y1: String(Y), y2: String(Y) }),
    s('line', { class: 'bar', x1: '2', x2: '2', y1: '8', y2: '80' }),
    ...score.days.flatMap((d, i) => (d.weekStart ? [s('line', { class: 'bar', x1: String(X0 + i * step), x2: String(X0 + i * step), y1: '8', y2: '80' })] : [])),
    s('line', { class: 'bar', x1: String(W - 6), x2: String(W - 6), y1: '8', y2: '80' }),
    s('rect', { x: String(W - 3.5), y: '8', width: '2.5', height: '72', fill: 'currentColor' }),
  ];
  days.forEach((d, i) => {
    const x = X0 + i * step + step / 2;
    const today = score.days[i]?.today === true;
    const up = Math.min(5, 34 / Math.max(1, d.shipped.length));
    const down = Math.min(6, 32 / Math.max(1, d.asked.length));
    const kids: SVGElement[] = [
      s('title', {}, `${score.days[i]?.label ?? d.date}: ${d.shipped.length} shipped, ${d.asked.length} asked`),
      s('rect', { class: 'col-bg', x: String(x - step / 2 + 1), y: '6', width: String(step - 2), height: '76', rx: '2' }),
      ...d.shipped.map((stream, k) => s('circle', { class: `hit ${streamVar(stream)}`, 'data-s': stream, cx: String(x), cy: String(Y - 6 - k * up), r: '2.3' })),
      ...d.asked.map((stream, k) => { const y = Y + 7 + k * down; return s('path', { class: `x ${streamVar(stream)}`, 'data-s': stream, d: `M${x - 2.3} ${y - 2.3}L${x + 2.3} ${y + 2.3}M${x + 2.3} ${y - 2.3}L${x - 2.3} ${y + 2.3}` }); }),
      s('rect', { class: 'col-hit', x: String(x - step / 2), y: '0', width: String(step), height: '86' }),
    ];
    const day = s('g', { class: `day${today ? ' today' : ''}` }, ...kids);
    day.style.setProperty('--i', String(i));
    day.addEventListener('pointerenter', () => drumRoll(day));
    g.push(day);
  });
  const svg = s('svg', { class: 'perc-svg', viewBox: `0 0 ${W} 86`, 'aria-hidden': 'true', focusable: 'false' }, ...g);
  const focusStream = (stream: string | null): void => {
    svg.classList.toggle('focusing', stream !== null);
    svg.querySelectorAll('.hit, .x').forEach((el) => el.classList.toggle('on', el.getAttribute('data-s') === stream));
  };
  const streams = [...new Set(days.flatMap((d) => [...d.shipped, ...d.asked]))].sort((a, b) => st.streams.indexOf(a) - st.streams.indexOf(b));
  const names = h('ul', { class: 'perc-streams', role: 'list', 'aria-label': 'Streams on the deck' }, ...streams.map((stream) => {
    const tag = streamTag(stream);
    // Pointer and keyboard both: hovering or focusing a stream's name pushes the others back.
    for (const [on, off] of [['pointerenter', 'pointerleave'], ['focus', 'blur']] as const) {
      tag.addEventListener(on, () => focusStream(stream));
      tag.addEventListener(off, () => focusStream(null));
    }
    return h('li', {}, tag);
  }));
  const sum = (f: (d: DeckDay) => number): number => days.reduce((n, d) => n + f(d), 0);
  const label = (i: number): string => score.days[i]?.label ?? '';
  const mid = score.days.findIndex((d, i) => i > 0 && d.weekStart);
  return conceptSection('perc half', { instrument: 'Percussion', title: 'The deck', plain: 'shipped and asked per day', n: null, hint: 'Daily hits, last 14 days.' },
    svg,
    h('div', { class: 'weeks', 'aria-hidden': 'true' }, h('span', {}, label(0)), mid > 0 ? h('span', {}, label(mid)) : null, h('span', {}, 'Today')),
    h('ul', { class: 'legend', role: 'list' },
      h('li', { class: 'k' }, s('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' }, s('circle', { cx: '6', cy: '6', r: '4', fill: 'currentColor' })), 'Shipped (above the line)', h('b', {}, String(sum((d) => d.shipped.length)))),
      h('li', { class: 'k' }, s('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' }, s('path', { d: 'M2.5 2.5l7 7M9.5 2.5l-7 7', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' })), 'Asked, still open (below)', h('b', {}, String(sum((d) => d.asked.length))))),
    names,
    h('table', { class: 'vh' }, h('caption', {}, 'Items shipped and cues still open, by the day they were asked, last 14 days'),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Day'), h('th', { scope: 'col' }, 'Shipped'), h('th', { scope: 'col' }, 'Asked'))),
      h('tbody', {}, ...days.map((d, i) => h('tr', {}, h('th', { scope: 'row' }, label(i)), h('td', {}, String(d.shipped.length)), h('td', {}, String(d.asked.length)))))));
}

// ---- Open work: the two gauges the board had ----

const CI_LABEL: Record<CiKey, string> = { pass: 'Passing', pending: 'Pending', fail: 'Failing', none: 'No checks' };

/** Continuo, first part: open asks by age, the board's own gauge set in the concept's type. */
export function agesSection(st: PodiumState): HTMLElement {
  const bars = askAgeBars(st.asks);
  const top = Math.max(1, ...bars.map((b) => b.n));
  return conceptSection('continuo', { instrument: 'Continuo', title: 'Open asks by age', n: null, hint: 'Past 3 days is stale, shown in amber.' },
    h('ul', { class: 'bars', role: 'list' }, ...bars.map((b) => h('li', { class: b.stale ? 'stale' : undefined },
      h('span', {}, b.label), h('span', { class: 'track', 'aria-hidden': 'true' }, fill(b.n / top)), h('span', { class: 'v' }, String(b.n))))));
}

/** Continuo, second part: open PRs by CI state, with the review queue against its cap and where PRs are stuck. */
export function prsSection(st: PodiumState, charts: ChartsData | null): HTMLElement {
  const g = prGauge(st.prs, charts);
  const keys: CiKey[] = ['pass', 'pending', 'fail', 'none'];
  const over = g.queue !== null && g.queue.count > g.queue.cap;
  const fact = (n: number, text: string, warn = false): HTMLElement => h('div', { class: warn ? 'warn' : undefined }, h('b', {}, String(n)), text);
  return conceptSection('continuo', { instrument: 'Continuo', title: 'Open PRs', n: g.total, hint: h('span', {}, 'CI state across every stream. ', h('a', { href: formatFragment(OPEN_PRS) }, 'Open the PR board')) },
    h('div', { class: 'cibar', 'aria-hidden': 'true' }, ...keys.filter((k) => g.ci[k] > 0).map((k) => grow(`ci-${k}`, g.ci[k]))),
    h('ul', { class: 'ci-legend', role: 'list' }, ...keys.map((k) => h('li', {}, h('i', { class: `ci-${k}`, 'aria-hidden': 'true' }), `${CI_LABEL[k]} ${g.ci[k]}`))),
    h('div', { class: 'facts3' },
      g.queue ? fact(g.queue.count, ` in your review queue, cap ${g.queue.cap}`, over) : null,
      fact(g.threads, ' with open threads'), fact(g.conflicting, ' conflicting')));
}
