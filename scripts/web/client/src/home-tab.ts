/** The Home tab: what needs you, every project's status, what got done, the trend charts and the important links. Draws what home-model works out. */
import { h, refLink, streamTag } from './dom.ts';
import { askCards, askHint, section } from './stream-board.ts';
import { clockTime } from './glance.ts';
import { linkAttrs } from './link-policy.ts';
import { STATE_TONE, ageChart, doneSpans, rowFacts, rowOrder, weeksChart } from './home-model.ts';
import type { DoneSpan } from './home-model.ts';
import type { ChartData } from './chart-math.ts';
import type { ChartKind } from './podium-chart.ts';
import type { ChartsData, HomeLink, PodiumState, ProjectRow, ProjectsData } from './types.ts';

/** The projects payload loads after the board, so Home answers at once and fills its rows in when they come. */
export type ProjectsLoad = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; data: ProjectsData };
export interface HomeOptions { live: boolean; projects: ProjectsLoad }

/** Asks shown before "Show all N": enough to act on, few enough that the project rows stay above the fold. */
const ASK_CAP = 3;
const LINK_KIND: Record<HomeLink['kind'], string> = { pin: 'pinned', context: 'context', library: 'library' };

export const HOME_TAB_CSS = `
  .home { display: grid; gap: var(--space-7); padding-block: var(--space-2) var(--space-6); }
  .asof { font-size: var(--text-xs); line-height: var(--leading-xs); color: var(--text-muted); margin: var(--space-1) 0 0; }
  .home-grid { display: grid; gap: var(--space-7) var(--gutter); align-items: start; }
  @media (min-width: 1024px) {
    .home-grid { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); grid-template-areas: "needs done" "projects done" "charts charts" "links links"; }
    .a-needs { grid-area: needs; } .a-projects { grid-area: projects; } .a-done { grid-area: done; } .a-charts { grid-area: charts; } .a-links { grid-area: links; }
  }
  ul.projects, ul.done, ul.links { list-style: none; margin: 0; padding: 0; border-top: var(--hairline); }
  ul.projects > li { display: grid; gap: var(--space-1); padding-block: var(--space-4); border-bottom: var(--hairline); }
  .proj-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-3); }
  .proj-name { font-size: var(--text-lg); line-height: var(--leading-lg); font-weight: var(--weight-semibold); }
  .state { font-size: var(--text-sm); color: var(--text-secondary); white-space: nowrap; }
  .state::before { margin-inline-end: var(--space-1); }
  .state.attention::before { content: var(--glyph-attention); color: var(--accent); }
  .state.critical::before { content: var(--glyph-critical); color: var(--critical); }
  .state.success::before { content: var(--glyph-success); color: var(--success); }
  .state.quiet::before { content: "–"; color: var(--text-muted); }
  .rank { font-size: var(--text-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .proj-status { margin: 0; font-size: var(--text-md); line-height: var(--leading-md); color: var(--text-primary); }
  .facts { margin: 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
  .done-span + .done-span { margin-top: var(--space-5); }
  .done-span h3 { margin: 0 0 var(--space-2); font-size: var(--text-sm); font-weight: var(--weight-semibold); letter-spacing: var(--tracking-caps); text-transform: uppercase; color: var(--text-secondary); }
  ul.done > li { display: grid; gap: var(--space-1); padding-block: var(--space-3); border-bottom: var(--hairline); }
  ul.done ul { list-style: none; margin: 0; padding: 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  ul.done ul li + li { margin-top: var(--space-1); }
  ul.week > li { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
  .week-n { font-size: var(--text-sm); font-variant-numeric: tabular-nums; color: var(--text-secondary); }
  .home-charts { display: grid; gap: var(--space-6) var(--gutter); }
  @media (min-width: 768px) { .home-charts { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .home-charts figure { margin: 0; }
  .home-charts figcaption { margin-top: var(--space-2); font-size: var(--text-xs); line-height: var(--leading-xs); color: var(--text-muted); }
  ul.links { display: grid; gap: 0 var(--gutter); }
  @media (min-width: 768px) { ul.links { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  ul.links > li { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--space-1) var(--space-3); padding-block: var(--space-3); border-bottom: var(--hairline); }
  .kind { font-size: var(--text-xs); color: var(--text-muted); }
  .home-note { margin: var(--space-2) 0 0; font-size: var(--text-sm); color: var(--text-secondary); }
  .loading { margin: 0; color: var(--text-secondary); font-size: var(--text-sm); }
`;

export function homeTab(st: PodiumState, charts: ChartsData | null, opts: HomeOptions): HTMLElement {
  const done = charts ? doneSpans(charts, st.streams) : null;
  const asks = askCards(st.asks, opts.live, true, ASK_CAP);
  return h('div', { class: 'home' },
    h('div', { class: 'home-grid' },
      h('div', { class: 'a-needs' }, section({ title: 'Needs you', n: st.asks.length, glyph: '●', tone: 'accent', empty: 'Nothing needs you right now.', hint: askHint(opts.live), action: asks?.more }, asks?.list ?? null)),
      h('div', { class: 'a-projects' }, section({ title: 'Projects', n: opts.projects.state === 'ok' ? opts.projects.data.rows.length : 0, tone: 'neutral', empty: 'No projects on the board yet.', quiet: true }, projectRows(opts.projects, st.tz))),
      h('div', { class: 'a-done' }, section({ title: 'What we got done', n: 0, tone: 'neutral', empty: done ? 'Nothing finished this week yet.' : 'Done counts are missing: the charts data did not load.', quiet: true }, done && done.week.n > 0 ? doneBody(done.today, done.week, done.missing, asOf(st.generatedAt, st.tz)) : null)),
      h('div', { class: 'a-charts' }, section({ title: 'Trends', n: 0, tone: 'neutral', empty: '', quiet: true }, chartsBody(st, opts.projects))),
      h('div', { class: 'a-links' }, section({ title: 'Important links', n: 0, tone: 'neutral', empty: 'No links yet. Pin one to a stream, or give a project a CONTEXT note.', quiet: true }, linksBody(opts.projects)))));
}

const asOf = (iso: string, tz: string): HTMLElement => h('p', { class: 'asof' }, `As of ${clockTime(iso, tz) || iso}`);

/** Loading and error say so in one line, inside the section that waits on them; the rest of Home is already current. */
function pending(p: ProjectsLoad, what: string): HTMLElement | null {
  if (p.state === 'loading') return h('p', { class: 'loading', role: 'status' }, `Loading ${what}…`);
  if (p.state === 'error') return h('p', { class: 'loading', role: 'alert' }, `${what[0]?.toUpperCase()}${what.slice(1)} could not be loaded (${p.message}). The rest of Home is current; reload to try again.`);
  return null;
}

function projectRows(p: ProjectsLoad, tz: string): HTMLElement | null {
  if (p.state !== 'ok') return pending(p, 'project status');
  if (p.data.rows.length === 0) return null;
  return h('div', {}, h('ul', { class: 'projects' }, ...rowOrder(p.data.rows).map(projectRow)), asOf(p.data.generatedAt, tz));
}

function projectRow(r: ProjectRow): HTMLElement {
  return h('li', {},
    h('div', { class: 'proj-head' },
      h('span', { class: 'proj-name' }, streamTag(r.stream)),
      h('span', { class: `state ${STATE_TONE[r.state]}` }, r.state),
      r.rank !== null ? h('span', { class: 'rank' }, `priority ${r.rank} today`) : null),
    r.status ? h('p', { class: 'proj-status' }, r.status.text) : null,
    h('p', { class: 'facts' }, rowFacts(r).join(' · ')));
}

function doneBody(today: DoneSpan, week: DoneSpan, missing: number, read: HTMLElement): HTMLElement {
  const todayList = today.groups.length
    ? h('ul', { class: 'done' }, ...today.groups.map((g) => h('li', {}, streamTag(g.stream), h('ul', {}, ...g.items.map((i) => h('li', {}, i.text, i.ticket ? ' ' : null, i.ticket ? refLink(i.ticket) : null))))))
    : h('p', { class: 'loading' }, 'Nothing finished yet today.');
  return h('div', {},
    h('div', { class: 'done-span' }, h('h3', {}, `Today · ${today.n}`), todayList),
    h('div', { class: 'done-span' }, h('h3', {}, `This week · ${week.n}`),
      h('ul', { class: 'done week' }, ...week.groups.map((g) => h('li', {}, streamTag(g.stream), h('span', { class: 'week-n' }, `${g.n} done`))))),
    missing > 0 ? h('p', { class: 'home-note' }, `${missing} finished this week ${missing === 1 ? 'is' : 'are'} counted but not listed by name: the server keeps only the newest.`) : null,
    read);
}

function chartsBody(st: PodiumState, p: ProjectsLoad): HTMLElement {
  const age = ageChart(st);
  const sum = (d: ChartData): number => d.series.reduce((t, s) => t + s.values.reduce((a, b) => a + b, 0), 0);
  const weeks = p.state === 'ok' ? weeksChart(p.data, st.streams) : null;
  return h('div', { class: 'home-charts' },
    weeks ? figure('stacked', 'Done per week, by stream', weeks, `n = ${sum(weeks)} finished over ${weeks.labels.length} seven-day periods ending today; each column starts on its date.`, asOf(p.state === 'ok' ? p.data.generatedAt : st.generatedAt, st.tz))
      : pending(p, 'the weekly chart') ?? h('p', {}, ''),
    figure('stacked', 'Open items by age', age.data, `n = ${sum(age.data)} open: ${st.asks.length} asks and ${st.working.length + st.blocked.length - age.undated} in flight or blocked${age.undated ? `; ${age.undated} with no start date left out` : ''}.`, asOf(st.generatedAt, st.tz)));
}

function figure(kind: ChartKind, title: string, data: ChartData, caption: string, read: HTMLElement): HTMLElement {
  const chart = h('podium-chart', { kind, label: title });
  chart.data = data;
  return h('figure', {}, chart, h('figcaption', {}, caption), read);
}

function linksBody(p: ProjectsLoad): HTMLElement | null {
  if (p.state !== 'ok') return pending(p, 'links');
  const items = p.data.links.flatMap((l) => {
    const attrs = linkAttrs(l.url);
    return attrs ? [h('li', {}, h('a', attrs, l.label), h('span', { class: 'kind' }, `${l.stream}, ${LINK_KIND[l.kind]}`))] : [];
  });
  return items.length ? h('ul', { class: 'links' }, ...items) : null;
}
