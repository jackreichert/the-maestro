/** Strings: the score. One staff per stream for the last 14 chart days, a note per day (higher is busier, a rest is a quiet day). */
import { h, s, streamTag } from './dom.ts';
import { braceGlyph } from './home-glyphs.ts';
import { conceptSection, streamVar } from './home-concept.ts';
import type { Score, ScoreRow } from './home-model.ts';

export const SCORE_CSS = `
  .system { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: var(--space-2); }
  .brace { width: 14px; height: 100%; color: var(--ink); }
  .staves { position: relative; display: grid; gap: var(--space-1); }
  .staff-row { display: grid; grid-template-columns: minmax(96px, 128px) minmax(0, 1fr) 72px; grid-template-areas: "label staff total"; align-items: center; gap: var(--space-3); transition: opacity var(--dur-base) var(--ease-out); }
  .staff-row.dim .staff-svg { opacity: 0.45; }
  .staff-label { grid-area: label; display: grid; gap: 2px; min-width: 0; }
  .staff-label .nm { display: flex; align-items: center; gap: var(--space-2); font-family: var(--font-display); font-style: italic; font-size: var(--text-lg); line-height: var(--leading-lg); min-width: 0; }
  .staff-label .nm a { font-family: var(--font-display); font-style: italic; font-weight: var(--weight-regular); font-size: var(--text-lg); color: var(--text-primary); text-decoration: none; padding-block: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .staff-label .nm a:hover { text-decoration: underline; }
  .staff-label .state { font-size: var(--text-xs); line-height: var(--leading-xs); color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .staff-label .state.attention { color: var(--accent); }
  .staff-label .state.critical { color: var(--critical); }
  .staff-svg { grid-area: staff; display: block; width: 100%; height: auto; color: var(--ink); overflow: visible; }
  .staff-total { grid-area: total; display: grid; text-align: right; }
  .staff-total b { font-family: var(--font-mono); font-weight: var(--weight-medium); font-size: var(--text-md); font-variant-numeric: tabular-nums; }
  .staff-total span { font-size: var(--text-xs); color: var(--text-muted); }
  @media (max-width: 639px) {
    .staff-row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "label total" "staff staff"; gap: 0 var(--space-3); }
    .staff-total { display: flex; gap: var(--space-1); align-items: baseline; }
  }
  .staff-svg line.sl { stroke: var(--staff); stroke-width: 0.8; }
  .staff-svg .today-col { fill: var(--accent); fill-opacity: 0.1; }
  .staff-svg .bar { stroke: var(--ink); stroke-width: 1; }
  .staff-svg .ts { font-family: var(--font-display); font-size: 9px; fill: currentColor; }
  .staff-svg .note { color: var(--stream-color, var(--ink)); }
  .staff-svg .head { fill: currentColor; }
  .staff-svg .stem { stroke: currentColor; stroke-width: 1; }
  .staff-svg .rest { fill: var(--text-muted); }
  .days-axis { display: grid; grid-template-columns: minmax(96px, 128px) minmax(0, 1fr) 72px; gap: var(--space-3); margin: var(--space-2) 0 0 22px; font-size: var(--text-xs); line-height: var(--leading-xs); color: var(--text-muted); }
  .days-axis .ax { grid-column: 2; display: flex; justify-content: space-between; }
  .days-axis .now { color: var(--accent); font-weight: var(--weight-semibold); }
  @media (max-width: 639px) { .days-axis { grid-template-columns: minmax(0, 1fr); margin-left: 22px; } .days-axis .ax { grid-column: 1; } }
  .playhead { position: absolute; top: -4px; bottom: -4px; left: 0; width: 2px; background: var(--accent); border-radius: 1px; opacity: 0; pointer-events: none; }
  @media (forced-colors: active) {
    .staff-svg .today-col { forced-color-adjust: none; fill: Highlight; }
    .staff-svg .head, .staff-svg .rest { forced-color-adjust: none; fill: CanvasText; }
    .staff-svg .stem { stroke: CanvasText; }
    .playhead { background: Highlight; }
  }
`;

const W = 560;
const X0 = 22;
const STAFF_TOP = 10;
const LINE_GAP = 6;
/** Pitch 1 to 4 (from the score model, on a log scale) to a note head's y on the staff; a higher pitch sits higher. */
const pitchY = (p: number): number => Math.round(34 - Math.min(4, Math.max(1, p)) * 5.5);

/** One stream's staff: five lines, barlines at each week start, the time signature (a week is seven beats), a note or a rest per day, and today's column shaded. */
export function staffSvg(row: ScoreRow, score: Score): SVGElement {
  const n = Math.max(1, score.days.length);
  const step = (W - X0 - 10) / n;
  const noteX = (i: number): number => X0 + i * step + step / 2;
  const g: SVGElement[] = [];
  for (let k = 0; k < 5; k++) g.push(s('line', { class: 'sl', x1: '2', x2: String(W - 2), y1: String(STAFF_TOP + k * LINE_GAP), y2: String(STAFF_TOP + k * LINE_GAP) }));
  const today = score.days.findIndex((d) => d.today);
  if (today >= 0) g.push(s('rect', { class: 'today-col', x: String(X0 + today * step), y: '4', width: String(step), height: '36' }));
  g.push(s('line', { class: 'bar', x1: '2', x2: '2', y1: String(STAFF_TOP), y2: String(STAFF_TOP + 4 * LINE_GAP) }));
  score.days.forEach((d, i) => { if (d.weekStart) g.push(s('line', { class: 'bar', x1: String(X0 + i * step), x2: String(X0 + i * step), y1: String(STAFF_TOP), y2: String(STAFF_TOP + 4 * LINE_GAP) })); });
  g.push(s('line', { class: 'bar', x1: String(W - 6), x2: String(W - 6), y1: String(STAFF_TOP), y2: String(STAFF_TOP + 4 * LINE_GAP) }));
  g.push(s('rect', { x: String(W - 3.5), y: String(STAFF_TOP), width: '2.5', height: String(4 * LINE_GAP), fill: 'currentColor' }));
  // A week is seven days, so the fortnight reads as two measures of seven.
  g.push(s('text', { class: 'ts', x: '10', y: '21', 'text-anchor': 'middle' }, '7'), s('text', { class: 'ts', x: '10', y: '33', 'text-anchor': 'middle' }, '4'));
  row.pitches.forEach((p, i) => {
    const x = noteX(i);
    const bits: SVGElement[] = [];
    if (p === 0) bits.push(s('rect', { class: 'rest', x: String(x - 3.5), y: '19', width: '7', height: '3', rx: '0.5' }));
    else {
      const y = pitchY(p);
      const up = y >= 22;
      bits.push(
        s('ellipse', { class: 'head', cx: String(x), cy: String(y), rx: '4.4', ry: '3.1', transform: `rotate(-20 ${x} ${y})` }),
        up ? s('line', { class: 'stem', x1: String(x + 3.9), x2: String(x + 3.9), y1: String(y), y2: String(y - 17) }) : s('line', { class: 'stem', x1: String(x - 3.9), x2: String(x - 3.9), y1: String(y), y2: String(y + 17) }));
    }
    const note = s('g', { class: 'note' }, ...bits);
    note.style.setProperty('--i', String(i));
    g.push(note);
  });
  return s('svg', { class: 'staff-svg', viewBox: `0 -2 ${W} 48`, 'aria-hidden': 'true', focusable: 'false' }, ...g);
}

/** The visually hidden table that carries the same numbers for a screen reader, with the counts the staff leaves out. */
function scoreTable(score: Score): HTMLElement {
  return h('table', { class: 'vh' },
    h('caption', {}, 'Tasks finished per stream per day, last 14 days, with each stream\'s open counts'),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Stream'), ...score.days.map((d) => h('th', { scope: 'col' }, d.today ? `${d.date} (today)` : d.date)), h('th', { scope: 'col' }, 'State'), h('th', { scope: 'col' }, 'Open asks'), h('th', { scope: 'col' }, 'Queued'), h('th', { scope: 'col' }, 'Open PRs'))),
    h('tbody', {}, ...score.rows.map((r) => h('tr', {}, h('th', { scope: 'row' }, r.stream), ...r.days.map((c) => h('td', {}, String(c))), h('td', {}, r.state), h('td', {}, String(r.asks)), h('td', {}, String(r.queued)), h('td', {}, String(r.prs))))));
}

const TONE: Record<ScoreRow['state'], string> = { 'waiting on you': 'attention', blocked: 'critical', moving: '', quiet: '' };

function staffRow(r: ScoreRow, score: Score, selected: string | null): HTMLElement {
  const label = h('span', { class: 'staff-label' },
    h('span', { class: 'nm' }, streamTag(r.stream)),
    h('span', { class: `state ${TONE[r.state]}`.trim() }, r.state));
  return h('div', { class: `staff-row ${streamVar(r.stream)}${selected && selected !== r.stream ? ' dim' : ''}` },
    label, staffSvg(r, score), h('span', { class: 'staff-total' }, h('b', {}, String(r.total)), h('span', {}, 'items')));
}

/** An axis date as the concept sets it: weekday, day, month (Fri 2 Oct). */
const axisDate = (day: string): string => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(Date.parse(`${day}T12:00:00Z`)).replace(',', '');

/** Strings: the score. `selected` dims the other staves when the cues are narrowed to one stream. */
export function scoreSection(score: Score, selected: string | null): HTMLElement {
  const first = score.days[0];
  const week = score.days.find((d) => d.weekStart);
  const axis = [first ? axisDate(first.date) : '', week && week !== first ? axisDate(week.date) : '', 'Today'].filter(Boolean);
  return conceptSection('score', { instrument: 'Strings', title: 'The score', n: null, hint: 'One staff per stream, in its own colour. A higher note is a busier day; a rest is a quiet one. Today\'s column is shaded. Open a stream for its full board.' },
    h('div', { class: 'system' }, braceGlyph(), h('div', { class: 'staves' }, h('span', { class: 'playhead', 'aria-hidden': 'true' }), ...score.rows.map((r) => staffRow(r, score, selected)))),
    h('div', { class: 'days-axis', 'aria-hidden': 'true' }, h('span', { class: 'ax' }, ...axis.map((t) => h('span', { class: t === 'Today' ? 'now' : undefined }, t)))),
    scoreTable(score));
}
