/** Fermata (what is blocked), Coda (what shipped today) and, under them, what is in flight. The side column beside the cues. */
import { h, refLink, streamTag } from './dom.ts';
import { withComments } from './blocked-rows.ts';
import { clockTime } from './glance.ts';
import { codaGlyph, fermataGlyph } from './home-glyphs.ts';
import { grow } from './home-bars.ts';
import { conceptSection, streamVar, tacet } from './home-concept.ts';
import { queuedByStream } from './home-model.ts';
import { newlyShipped } from './home-motion.ts';
import { pagedRows } from './pager.ts';
import { seriesClass } from './series.ts';
import { itemRows } from './stream-board.ts';
import type { RowContext } from './stream-board.ts';
import type { PodiumState } from './types.ts';

/** Shipped items on one page of the Coda list. */
export const SHIPPED_PAGE = 6;

export const HELD_CSS = `
  .side { display: grid; gap: var(--section-gap) var(--gutter); align-content: start; min-width: 0; }
  @media (min-width: 768px) and (max-width: 1099px) { .side { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .side ul.rows { border-top: 0; }
  .side ul.rows > li { padding: var(--space-3) 0; border-bottom: 0; border-top: var(--hairline); font-size: var(--text-md); }
  .side ul.rows > li:first-child { border-top: 0; padding-top: 0; }
  .side .row-sub .tag { font-family: var(--font-display); font-style: italic; font-weight: var(--weight-regular); font-size: var(--text-md); color: var(--text-secondary); }
  .side .gate { color: var(--warning); font-weight: var(--weight-medium); }
  .side .gate a { color: inherit; }
  .coda-rows { display: grid; }
  .crow { display: grid; gap: 2px; padding-block: var(--space-3); border-top: var(--hairline); }
  .crow:first-child { border-top: 0; padding-top: 0; }
  .crow[hidden] { display: none; }
  .crow-top { display: flex; align-items: baseline; gap: var(--space-3); }
  .crow-top .txt { flex: 1 1 0; min-width: 0; overflow-wrap: anywhere; }
  .crow-top .when { flex: none; font-family: var(--font-mono); font-size: var(--text-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .crow-sub { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-3); font-size: var(--text-sm); color: var(--text-muted); }
  .crow-sub .tag { font-family: var(--font-display); font-style: italic; font-weight: var(--weight-regular); font-size: var(--text-md); color: var(--text-secondary); }
  .status { display: inline-flex; gap: var(--space-1); align-items: baseline; font-size: var(--text-sm); font-weight: var(--weight-medium); white-space: nowrap; color: var(--success); }
  .crow.new { animation: arrive var(--dur-slow) var(--ease-spring) backwards; }
  @keyframes arrive { from { opacity: 0; translate: 0 -6px; scale: 0.98; } }
  .queue-line { margin: var(--space-3) 0 var(--space-2); font-size: var(--text-sm); color: var(--text-secondary); }
  .queue-line strong { color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .qbar { display: flex; height: 8px; border-radius: 2px; overflow: hidden; gap: 1px; margin-bottom: var(--space-3); }
  .qbar span { display: block; min-width: 3px; }
  ul.qlist { list-style: none; margin: 0; padding: 0; }
  ul.qlist li { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-3); padding-block: var(--space-1); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
`;

/** Mark an item's place in its list, for the entrance's stagger. */
const withIndex = <T extends HTMLElement>(el: T, i: number): T => { el.style.setProperty('--i', String(i)); return el; };

const ctxOf = (st: PodiumState): RowContext => ({ now: st.generatedAt, tz: st.tz, showStream: true, prs: st.prs });

/** Fermata: the blocked work, with each row's gate and (live) the box to comment on it or unblock it. */
export function heldSection(st: PodiumState, live: boolean): HTMLElement {
  const rows = st.blocked.length ? withComments(itemRows(st.blocked, ctxOf(st)), st.blocked, live) : null;
  return conceptSection('fermata', { instrument: 'Held', title: 'Fermata', plain: 'blocked', n: st.blocked.length || null, glyph: fermataGlyph() },
    rows ?? tacet('Nothing is blocked.', 'senza fermata'));
}

/** Coda: what shipped today, newest first. A row that arrived since the last draw lands with a small spring. */
export function codaSection(st: PodiumState): HTMLElement {
  const newest = [...st.done].sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt));
  const fresh = newlyShipped(newest.map((d) => d.id));
  const rows = newest.map((d, i) => withIndex(h('div', { class: `crow ${streamVar(d.stream)}${fresh.has(d.id) ? ' new' : ''}`, role: 'listitem' },
    h('div', { class: 'crow-top' }, h('span', { class: 'txt' }, d.text), h('span', { class: 'when' }, h('span', { class: 'vh' }, 'shipped '), clockTime(d.closedAt, st.tz))),
    h('div', { class: 'crow-sub' }, h('span', { class: 'status' }, h('span', { 'aria-hidden': 'true' }, '✓'), 'Shipped'), streamTag(d.stream), d.ticket ? refLink(d.ticket) : null)), i));
  const more = pagedRows(rows, { key: 'home-coda', size: SHIPPED_PAGE, label: 'Shipped today' });
  return conceptSection('coda', { instrument: 'Shipped today', title: 'Coda', plain: 'shipped today', n: newest.length || null, glyph: codaGlyph() },
    rows.length ? h('div', { class: 'coda-rows', role: 'list', 'aria-label': 'Shipped today, newest first' }, ...rows) : tacet('Nothing shipped yet today.', 'prima volta'), more);
}

/** In flight: the agents running now, and the queue waiting for a free lane. Not in the concept; the board has it, so it stays, in the concept's dress. */
export function flightSection(st: PodiumState): HTMLElement {
  const queued = queuedByStream(st.queued, st.streams);
  return conceptSection('flight', { instrument: 'Underway', title: 'In flight', n: st.working.length || null },
    st.working.length ? itemRows(st.working, ctxOf(st)) : tacet('No agent is running.', 'rest'),
    st.queued.length ? h('p', { class: 'queue-line' }, h('strong', {}, String(st.queued.length)), ' queued, waiting for a free lane') : null,
    st.queued.length ? h('div', { class: 'qbar', 'aria-hidden': 'true' }, ...queued.map((q) => grow(seriesClass(q.stream), q.n))) : null,
    st.queued.length ? h('ul', { class: 'qlist', role: 'list', 'aria-label': 'Queued by stream' }, ...queued.map((q) => h('li', {}, streamTag(q.stream), h('span', {}, String(q.n))))) : null);
}
