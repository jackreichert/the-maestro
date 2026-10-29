/**
 * The Home tab, laid out as the concept's score: the streams (the score) first, then what needs acting on: the cues beside what is blocked and in flight,
 * then open asks by age, open PRs and the local review queue, and then the reporting views (the movements beside the coda,
 * the deck beside the cost). Draws what home-model works out.
 */
import { AMBIENCE_CSS } from './home-ambience.ts';
import { COST_CSS, costSections, tempoOf } from './cost-widget.ts';
import { h } from './dom.ts';
import { CONCEPT_CSS } from './home-concept.ts';
import { CUES_CSS, cuesSection, pickedStream } from './home-cues.ts';
import { DECK_CSS, deckSection, agesSection, prsSection } from './home-deck.ts';
import { HELD_CSS, codaSection, flightSection, heldSection } from './home-held.ts';
import { scoreTable } from './home-model.ts';
import { HOME_MOTION_CSS, takeEntrance } from './home-motion.ts';
import { MOVEMENTS_CSS, movementsSection } from './home-movements.ts';
import { STREAM_PAGE_CSS, homeUi } from './home-sections.ts';
import { SCORE_CSS, scoreSection } from './home-score.ts';
import { LOCAL_WIDGET_CSS, localReviewWidget } from './local-review-widget.ts';
import { STANDUP_CSS, standupWidget } from './standup-widget.ts';
import type { NeedsItem } from './needs-items.ts';
import type { ChartsData, CostData, EpicsData, LocalReview, PodiumState, ProjectsData } from './types.ts';

/** The projects payload loads after the board, so Home answers at once and fills in project names and notes when they come. */
export type ProjectsLoad = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; data: ProjectsData };
export interface HomeOptions {
  live: boolean;
  projects: ProjectsLoad;
  epics: EpicsData | null;
  cost?: CostData | null;
  /** The local review queue; null when the server gave none. */
  local?: LocalReview | null;
  /** PRs ready to merge and reviews waiting for an OK, listed in Cues after the asks. */
  needs?: NeedsItem[];
  /** Called when a board control (order, stream filter, show all) changes, so the caller redraws Home. */
  redraw: () => void;
}

export const HOME_TAB_CSS = `
  .home { padding-block: var(--space-2) 0; }
  .home-note { margin: 0; font-size: var(--text-sm); color: var(--text-secondary); }
  ${CONCEPT_CSS}
  ${SCORE_CSS}
  ${CUES_CSS}
  ${HELD_CSS}
  ${MOVEMENTS_CSS}
  ${LOCAL_WIDGET_CSS}
  ${STANDUP_CSS}
  ${DECK_CSS}
  ${COST_CSS}
  ${HOME_MOTION_CSS}
  ${AMBIENCE_CSS}
  ${STREAM_PAGE_CSS}
`;

export function homeTab(st: PodiumState, charts: ChartsData | null, opts: HomeOptions): HTMLElement {
  const projects = opts.projects.state === 'ok' ? opts.projects.data : null;
  const score = charts && charts.days.length > 0 && st.streams.length > 0 ? scoreTable(st, charts, projects) : null;
  const cost = costSections(opts.cost ?? null, tempoOf(charts));
  const deck = deckSection(st, charts, score);
  // Without a cost payload (an old server, sample data) the deck takes the row.
  if (!cost) deck.classList.replace('half', 'full');
  // Cost is split so no widget towers over its neighbour: the metrics beside the deck, then tempo, model mix and experiments as a row of thirds.
  const cues = cuesSection(st, opts.live, opts.redraw, opts.needs);
  const movements = movementsSection(opts.epics, projects?.links ?? []);
  const rehearsal = localReviewWidget(opts.local ?? null);
  const held = heldSection(st, opts.live);
  const flight = flightSection(st);
  const ages = agesSection(st);
  const prs = prsSection(st, charts);
  const coda = codaSection(st);
  // What needs acting on comes first (docs/design.md, "Placing a section"): cues, then open work, open PRs and what is blocked, then the views that only report.
  cues.classList.add('two-thirds');
  ages.classList.add('third');
  prs.classList.add('third');
  rehearsal.classList.add('third');
  movements.classList.add('two-thirds');
  coda.classList.add('third');
  return h('div', { class: takeEntrance() ? 'home grid enter' : 'home grid' },
    opts.projects.state === 'error' ? h('p', { class: 'home-note', role: 'alert' }, `Project names and notes could not be loaded (${opts.projects.message}). The rest of Home is current; reload to try again.`) : null,
    // The streams head the page, in today's priority order (the score ranks its rows by it).
    score ? scoreSection(score, pickedStream(st, opts.needs ?? [])) : h('p', { class: 'home-note', role: 'status' }, 'The 14-day score is missing: the charts data did not load.'),
    cues,
    h('div', { class: 'third side' }, held, flight),
    ages, prs, rehearsal,
    standupWidget(),
    movements, coda,
    deck, cost?.cost ?? null, ...(cost?.rest ?? []));
}
