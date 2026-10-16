/** Movements: the open epics. Each measure is a task and a filled note is a task done; a finished epic ends on the final double bar. */
import { h, refLink, streamTag } from './dom.ts';
import { linkAttrs } from './link-policy.ts';
import { conceptSection, streamVar, tacet } from './home-concept.ts';
import { epicCards } from './home-model.ts';
import type { EpicCard } from './home-model.ts';
import type { EpicsData, HomeLink } from './types.ts';

/** Measures drawn for one epic. A bigger epic is drawn at this width, each measure standing for several tasks; the words under it give the real counts. */
export const MEASURE_CAP = 24;

export const MOVEMENTS_CSS = `
  .mvts { display: grid; margin: 0; padding: 0; list-style: none; }
  .mvt { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: var(--space-1) var(--space-4); padding-block: var(--space-4); border-top: var(--hairline); }
  .mvt:first-child { border-top: 0; padding-top: 0; }
  .roman { font-family: var(--font-display); font-size: var(--text-2xl); line-height: 1; color: var(--text-secondary); }
  .mvt-body { display: grid; gap: var(--space-2); min-width: 0; }
  .mvt-top { display: flex; align-items: baseline; gap: var(--space-1) var(--space-3); flex-wrap: wrap; margin: 0; }
  .mvt-top strong { font-weight: var(--weight-semibold); }
  .mvt-top .id { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-muted); }
  .mvt-top .tag { font-family: var(--font-display); font-style: italic; font-weight: var(--weight-regular); font-size: var(--text-md); color: var(--text-secondary); }
  .measures { display: flex; align-items: stretch; height: 18px; border-left: 1px solid var(--ink); }
  .measures span { flex: 1 1 0; border-right: 1px solid var(--ink); position: relative; }
  .measures span::before { content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 1px; background: var(--staff); }
  .measures span.f::after, .measures span.p::after, .measures span.b::after { content: ""; position: absolute; left: 50%; top: 50%; width: 9px; height: 7px; margin: -3.5px 0 0 -4.5px; border-radius: 50%; transform: rotate(-20deg) scale(0); animation: fill var(--dur-base) var(--ease-spring) forwards; animation-delay: calc(var(--i, 0) * var(--stagger) + 120ms); }
  .measures span.f::after { background: var(--stream-color, var(--accent)); }
  .measures span.p::after { border: 1.5px solid var(--stream-color, var(--accent)); background: var(--surface-page); }
  .measures span.b::after { background: var(--critical); }
  .measures.fine { border-right: 3px solid var(--ink); }
  @keyframes fill { to { transform: rotate(-20deg) scale(1); } }
  .mvt-meta { margin: 0; font-size: var(--text-sm); color: var(--text-muted); }
  .mvt-meta .bl { color: var(--critical); font-weight: var(--weight-medium); }
  .mvt-meta .it { font-family: var(--font-display); font-style: italic; font-size: var(--text-md); }
  .mvt-next { margin: 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .notes-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: var(--space-4) 0 0; padding: 0; list-style: none; font-size: var(--text-xs); color: var(--text-muted); }
  .notes-row a { display: inline-block; padding: 2px var(--space-2); border-radius: var(--radius-sm); background: var(--surface-2); font-family: var(--font-mono); color: var(--text-primary); text-decoration: none; }
  .notes-row a:hover { text-decoration: underline; }
  @media (forced-colors: active) { .measures span.f::after, .measures span.p::after, .measures span.b::after { forced-color-adjust: none; background: CanvasText; } .measures span.p::after { background: Canvas; border: 1.5px solid CanvasText; } }
`;

const NUMERALS: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
/** An upper-case roman numeral, for movement numbers. */
export function roman(n: number): string {
  let out = '';
  let left = Math.max(1, Math.floor(n));
  for (const [v, r] of NUMERALS) while (left >= v) { out += r; left -= v; }
  return out;
}

/** The measures of one epic: `kinds[i]` is how measure i is marked. Scaled to MEASURE_CAP when the epic has more tasks than that. */
export function measureKinds(c: EpicCard['line']): ('f' | 'p' | 'b' | '')[] {
  const total = Math.max(0, c.total);
  const n = Math.min(total, MEASURE_CAP);
  if (n === 0) return [];
  const scale = (k: number): number => (total <= MEASURE_CAP ? k : Math.round((k / total) * n));
  const done = scale(c.closed);
  const prog = scale(c.inProgress);
  const blocked = scale(c.blocked);
  return Array.from({ length: n }, (_, i) => (i < done ? 'f' : i < done + prog ? 'p' : i < done + prog + blocked ? 'b' : ''));
}

function movement(c: EpicCard, n: number): HTMLElement {
  const { line } = c;
  const complete = line.total > 0 && line.closed === line.total;
  const pct = line.total > 0 ? Math.round((line.closed / line.total) * 100) : 0;
  const words = `${line.closed} of ${line.total} tasks done${line.inProgress ? `, ${line.inProgress} in progress` : ''}${line.blocked ? `, ${line.blocked} blocked` : ''}`;
  const measures = h('div', { class: `measures${complete ? ' fine' : ''}`, role: 'img', 'aria-label': words },
    ...measureKinds(line).map((k, i) => {
      const m = h('span', { class: k || undefined });
      m.style.setProperty('--i', String(Math.min(i, 12)));
      return m;
    }));
  const row = h('li', { class: `mvt ${streamVar(c.stream)}` },
    h('span', { class: 'roman', 'aria-hidden': 'true' }, roman(n)),
    h('div', { class: 'mvt-body' },
      h('p', { class: 'mvt-top' }, h('span', { class: 'vh' }, `Movement ${roman(n)}: `), h('strong', {}, refLink({ label: line.title, url: line.note.url })), h('span', { class: 'id' }, line.id), c.stream === 'unfiled' ? null : streamTag(c.stream)),
      measures,
      h('p', { class: 'mvt-meta' }, complete
        ? h('span', {}, h('span', { class: 'status' }, h('span', { 'aria-hidden': 'true' }, '✓'), 'Complete'), ' · ', h('i', { class: 'it', lang: 'it' }, 'Fine'))
        : h('span', {}, `${line.closed} of ${line.total} tasks · ${pct}%`, line.blocked > 0 ? h('span', { class: 'bl' }, ` · ${line.blocked} blocked`) : null)),
      line.next ? h('p', { class: 'mvt-next' }, 'Next ', refLink({ label: line.next.id, url: line.next.ref.url }), ' ', line.next.title) : null));
  row.style.setProperty('--i', String(n - 1));
  return row;
}

const LINK_KIND: Record<HomeLink['kind'], string> = { pin: 'pinned', context: 'context', library: 'library' };

/** Movements: one measure line per open epic, with the project notes under them. */
export function movementsSection(e: EpicsData | null, links: HomeLink[]): HTMLElement {
  const cards = epicCards(e);
  const notes = links.flatMap((l) => { const a = linkAttrs(l.url); return a ? [h('li', {}, h('a', { ...a, title: `${l.stream}, ${LINK_KIND[l.kind]}` }, l.label))] : []; });
  return conceptSection('movements', { instrument: 'Movements', title: 'Epics', n: cards.length || null, hint: 'Each measure is a task; a filled note is a task done, a hollow one is in progress.' },
    cards.length ? h('ol', { class: 'mvts', 'aria-label': 'Open epics' }, ...cards.map((c, i) => movement(c, i + 1))) : tacet('No open epics.', 'tacet'),
    notes.length ? h('ul', { class: 'notes-row', role: 'list', 'aria-label': 'Project notes' }, h('li', {}, 'Project notes'), ...notes) : null);
}
