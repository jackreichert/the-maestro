/** What Home's sections share with a stream's tab: the reader's board choices, a stream's own large staff, and the panel of today's priorities for it. */
import { h } from './dom.ts';
import { splitStream } from './glance.ts';
import { conceptSection, streamVar } from './home-concept.ts';
import type { AskOrder } from './home-model.ts';
import { scoreTable } from './home-model.ts';
import { staffSvg } from './home-score.ts';
import { linkAttrs } from './link-policy.ts';
import type { ChartsData, HomeLink, PodiumState, ProjectsData } from './types.ts';

const LINK_KIND: Record<HomeLink['kind'], string> = { pin: 'pinned', context: 'context', library: 'library' };

/** What the reader picked on the board. Kept at module level so a live refresh redraws Home with the same sort, filter and reveal. */
export const homeUi: { order: AskOrder; stream: string | null; allAsks: boolean; allShipped: boolean } = { order: 'oldest', stream: null, allAsks: false, allShipped: false };

export const STREAM_PAGE_CSS = `
  .big-staff .staff-svg { width: 100%; }
  .big-staff .staff-wrap { max-width: 900px; }
  .tally { display: grid; grid-template-columns: repeat(14, minmax(0, 1fr)); margin: var(--space-2) calc(10 / 560 * 100%) 0 calc(22 / 560 * 100%); font-size: var(--text-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; text-align: center; }
  .today-panel h2 { margin: 0 0 var(--space-3); padding-bottom: var(--space-2); border-bottom: var(--hairline-strong); font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--text-secondary); }
  .today-panel p { margin: 0 0 var(--space-3); font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  .today-panel .rk { color: var(--text-muted); }
  .today-panel i { font-family: var(--font-display); font-size: 1.04em; }
  .library-none { margin: var(--space-4) 0 0; font-size: var(--text-xs); color: var(--text-muted); }
`;

/** One stream's last 14 days as a large staff with each day's count under it, for the stream tab. Null when there is no score to draw. */
export function streamScore(st: PodiumState, charts: ChartsData | null, stream: string): HTMLElement | null {
  if (!charts || charts.days.length === 0) return null;
  const score = scoreTable(st, charts, null);
  const row = score.rows.find((r) => r.stream === stream);
  if (!row) return null;
  const label = `${stream}, tasks finished per day: ${score.days.map((d, i) => `${d.date} ${row.days[i]}`).join(', ')}`;
  const svg = staffSvg(row, score);
  svg.removeAttribute('aria-hidden');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  return conceptSection(`big-staff ${streamVar(stream)}`, { instrument: 'Strings', title: 'Last 14 days', n: row.total, hint: 'Tasks finished per day. A higher note is a busier day.' },
    h('div', { class: 'staff-wrap' }, svg, h('div', { class: 'tally', 'aria-hidden': 'true' }, ...row.days.map((n) => h('span', {}, String(n))))));
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/** The right-hand panel of a stream tab: where today's priorities put this stream (or that none does), and its notes. */
export function todayPanel(priorities: { text: string; stream?: string }[], projects: ProjectsData | null, stream: string): HTMLElement {
  const ranked = priorities.flatMap((p, i) => { const s = splitStream(p); return s.stream === stream ? [{ rank: i + 1, text: s.text }] : []; });
  const li = (l: HomeLink): HTMLElement[] => { const a = linkAttrs(l.url); return a ? [h('li', {}, h('a', { ...a, title: LINK_KIND[l.kind] }, l.label))] : []; };
  const mine = (projects?.links ?? []).filter((l) => l.stream === stream);
  const notes = mine.filter((l) => l.kind !== 'library').flatMap(li);
  const library = mine.filter((l) => l.kind === 'library').flatMap(li);
  return h('section', { class: 'today-panel', 'aria-labelledby': 'today-h' },
    h('h2', { id: 'today-h' }, 'Today'),
    ...(ranked.length
      ? ranked.map((m) => h('p', {}, h('span', { class: 'rk' }, `Priority ${ROMAN[m.rank - 1] ?? m.rank} · `), m.text))
      : [h('p', {}, 'Not in today\'s priorities. ', h('i', { lang: 'la' }, 'tacet'))]),
    notes.length ? h('ul', { class: 'notes-row', role: 'list', 'aria-label': 'Notes' }, ...notes) : null,
    // Shown once the projects payload has loaded, so a stream is never called empty while the answer is still on its way.
    projects ? (library.length ? h('ul', { class: 'notes-row', role: 'list', 'aria-label': 'Library' }, h('li', {}, 'Library'), ...library) : h('p', { class: 'library-none' }, 'No library yet.')) : null);
}
