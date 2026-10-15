/** The Home tab, top to bottom: the score (a staff per stream), the board (asks, blocked, in flight), the deck (shipped today and gauges), epics and project notes. Draws what home-model works out. */
import { h } from './dom.ts';
import { COST_CSS, costSection } from './cost-widget.ts';
import { scoreTable } from './home-model.ts';
import { HOME_MOTION_CSS, takeEntrance } from './home-motion.ts';
import { HOME_SECTIONS_CSS, boardSection, deckSection, epicsSection, scoreSection } from './home-sections.ts';
import type { NeedsItem } from './needs-items.ts';
import type { ChartsData, CostData, EpicsData, PodiumState, ProjectsData } from './types.ts';

/** The projects payload loads after the board, so Home answers at once and fills in project names and notes when they come. */
export type ProjectsLoad = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; data: ProjectsData };
export interface HomeOptions {
  live: boolean;
  projects: ProjectsLoad;
  epics: EpicsData | null;
  cost?: CostData | null;
  /** PRs ready to merge and reviews waiting for an OK, listed in Needs you after the asks. */
  needs?: NeedsItem[];
  /** Called when a board control (order, stream filter, show all) changes, so the caller redraws Home. */
  redraw: () => void;
}

export const HOME_TAB_CSS = `
  .home { display: grid; gap: var(--space-8, 4rem); padding-block: var(--space-2) var(--space-6); }
  .home-note { margin: var(--space-2) 0 0; font-size: var(--text-sm); color: var(--text-secondary); }
  ${HOME_SECTIONS_CSS}
  ${COST_CSS}
  ${HOME_MOTION_CSS}
`;

export function homeTab(st: PodiumState, charts: ChartsData | null, opts: HomeOptions): HTMLElement {
  const projects = opts.projects.state === 'ok' ? opts.projects.data : null;
  const score = charts && charts.days.length > 0 && st.streams.length > 0 ? scoreSection(scoreTable(st, charts, projects)) : null;
  return h('div', { class: takeEntrance() ? 'home enter' : 'home' },
    score ?? h('p', { class: 'home-note', role: 'status' }, 'The 14-day score is missing: the charts data did not load.'),
    opts.projects.state === 'error' ? h('p', { class: 'home-note', role: 'alert' }, `Project names and notes could not be loaded (${opts.projects.message}). The rest of Home is current; reload to try again.`) : null,
    boardSection(st, opts.live, opts.redraw, opts.needs),
    deckSection(st, charts, opts.redraw),
    costSection(opts.cost ?? null),
    epicsSection(opts.epics, projects?.links ?? []));
}
