/** The stream home base, drawn: the epic strip, what is left, and what the files cannot tell. Text and counts come from home-text.ts. */
import { h, refLink } from './dom.ts';
import { awaitingLabel, barSegments, capRows, epicEnd, epicUnknownsLabel, noEpicLine, openCounts, progressSentence, quietNote, ticketNotes, unknownsHeading, verifiedSentence } from './home-text.ts';
import type { LeftGroups } from './home-text.ts';
import type { HomeEpic, HomeTicket, StreamHome } from './types.ts';

/** Epics shown before "n more epics"; the most recently active come first, as the server sends them. */
const EPIC_CAP = 3;
/** The id the unknowns disclosure carries, so an epic block can open it. */
const UNKNOWNS_ID = 'unknowns';

export const HOME_CSS = `
  .epics { display: grid; gap: var(--space-4); margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--border); }
  .epic { display: grid; gap: var(--space-1); padding: var(--space-3) 0; border-bottom: 1px solid var(--border); min-width: 0; }
  .epic h3 { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--space-3); margin: 0; font-size: var(--text-md); line-height: var(--leading-md); font-weight: var(--weight-medium); }
  .epic h3 .title { min-width: 0; overflow-wrap: anywhere; }
  .progress { margin: 0; font-size: var(--text-md); line-height: var(--leading-md); font-variant-numeric: tabular-nums; }
  .progress .also { color: var(--text-secondary); }
  /* Status bar: every segment repeats what the sentence above says, so it is hidden from assistive tech and from forced colours. */
  .bar-track { display: flex; gap: 2px; block-size: 8px; max-inline-size: 28rem; margin-block: var(--space-1); }
  .bar-track > span { min-inline-size: 4px; border-radius: 2px; }
  .bar-track .closed { background: var(--success); }
  .bar-track .progress-seg { background: var(--accent); }
  .bar-track .blocked { background: var(--critical); }
  .bar-track .todo { background: var(--surface-2); outline: 1px solid var(--border-strong); outline-offset: -1px; }
  @media (forced-colors: active) { .bar-track { display: none; } }
  .epic-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--space-3); margin: 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  .epic-meta .counts { font-variant-numeric: tabular-nums; }
  .epic-end { font-family: var(--font-serif); font-size: 1.04em; color: var(--text-secondary); }
  .teach { margin: 0; padding: var(--space-3) 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); color: var(--text-secondary); max-width: 70ch; }
  button.jump { all: unset; box-sizing: border-box; cursor: pointer; color: var(--accent); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 0.2em; min-block-size: 24px; display: inline-flex; align-items: center; border-radius: 4px; }
  button.jump:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

  .left-group { display: grid; gap: var(--space-1); margin-bottom: var(--space-4); }
  .left-group > h3 { margin: 0; font-size: var(--text-sm); line-height: var(--leading-sm); font-weight: var(--weight-semibold); color: var(--text-secondary); letter-spacing: 0.02em; }
  .left-group ul.rows { margin-top: var(--space-1); }
  .row-meta .quiet-note { color: var(--warning); }
  .truncated { margin: 0; font-size: var(--text-sm); color: var(--text-muted); }
  .clear { margin: 0; padding: var(--space-3) 0; border-top: 1px solid var(--border); color: var(--text-muted); font-size: var(--text-sm); line-height: var(--leading-sm); }

  details.fold { border-top: 1px solid var(--border); }
  details.fold > summary {
    cursor: pointer; padding: var(--space-3) 0; min-block-size: 24px; font-size: var(--text-sm); line-height: var(--leading-sm);
    font-weight: var(--weight-semibold); color: var(--text-secondary); letter-spacing: 0.02em;
  }
  details.fold > summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
  details.fold ul.rows { border-top: 0; }
  details.fold .fold-body { padding-bottom: var(--space-3); }
  ul.unknowns { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  ul.unknowns li { overflow-wrap: anywhere; max-width: 70ch; }
`;

/** One epic: id and title, its progress sentence (with the denominator), the bar, then next action, awaiting and unknowns. */
function epicBlock(e: HomeEpic, listed: boolean): HTMLElement {
  const verified = verifiedSentence(e);
  const counts = openCounts(e);
  const unknowns = epicUnknownsLabel(e.unknowns);
  const awaiting = awaitingLabel(e.awaiting);
  const quiet = quietNote(e.quietDays);
  const end = epicEnd(e);
  // The button only exists when the unknowns list does, so it can never be a live control that opens nothing.
  const jump = unknowns && listed ? h('button', { type: 'button', class: 'jump', 'aria-controls': UNKNOWNS_ID, 'aria-label': `${unknowns}, epic ${e.id}` }, unknowns) : null;
  jump?.addEventListener('click', () => {
    const fold = jump.getRootNode() instanceof ShadowRoot ? (jump.getRootNode() as ShadowRoot).getElementById(UNKNOWNS_ID) : null;
    if (!(fold instanceof HTMLDetailsElement)) return;
    fold.open = true;
    fold.querySelector('summary')?.focus();
  });
  return h('li', { class: 'epic' },
    h('h3', {}, h('span', { class: 'id' }, e.id), h('span', { class: 'title' }, refLink({ label: e.title, url: e.note.url }))),
    h('p', { class: 'progress' }, progressSentence(e), verified ? h('span', { class: 'also' }, ` · ${verified}`) : null,
      end === 'complete' ? h('span', {}, ' ', h('i', { class: 'epic-end', lang: 'it' }, 'Fine'), h('span', { class: 'vh' }, ' (complete)')) : end === 'unresolved' ? h('i', { class: 'epic-end' }, ' unresolved') : null),
    e.total > 0 ? h('div', { class: 'bar-track', 'aria-hidden': 'true' }, ...barSegments(e).map((s) => {
      const seg = h('span', { class: s.key === 'progress' ? 'progress-seg' : s.key });
      seg.style.flexGrow = String(s.n);
      return seg;
    })) : null,
    h('p', { class: 'epic-meta' },
      counts ? h('span', { class: 'counts' }, counts) : null,
      e.next ? h('span', {}, 'Next: ', h('span', { class: 'mono' }, e.next.id), ' ', refLink({ label: e.next.title, url: e.next.ref.url })) : null,
      awaiting ? h('span', {}, awaiting) : null,
      quiet ? h('span', {}, quiet) : null,
      jump ?? (unknowns ? h('span', {}, unknowns) : null)));
}

/** The epics of the stream, newest activity first, at most three shown; with none, one teaching line says how to get progress. */
export function epicStrip(home: StreamHome): HTMLElement {
  if (home.epics.length === 0) return h('p', { class: 'teach' }, noEpicLine(home));
  const { shown, rest } = capRows(home.epics, EPIC_CAP);
  const listed = home.unknowns.length > 0;
  return h('div', {},
    h('ul', { class: 'epics', role: 'list' }, ...shown.map((e) => epicBlock(e, listed))),
    rest.length ? h('details', { class: 'fold' }, h('summary', {}, `${rest.length} more ${rest.length === 1 ? 'epic' : 'epics'}`),
      h('ul', { class: 'epics', role: 'list' }, ...rest.map((e) => epicBlock(e, listed)))) : null);
}

/** A ticket as a row: id, its title (linked), its small facts, and up to three PR links under it. */
function ticketRows(ts: HomeTicket[]): HTMLElement {
  return h('ul', { class: 'rows', role: 'list' }, ...ts.map((t) => {
    const notes = ticketNotes(t);
    return h('li', {},
      h('span', { class: 'id' }, t.id),
      h('span', { class: 'row-text' }, refLink({ label: t.title, url: t.ref.url })),
      h('span', { class: 'row-meta' }, notes.join(' · ')),
      t.prs.length ? h('span', { class: 'row-sub' }, ...t.prs.map((p) => refLink(p)), t.prsMore ? h('span', {}, `${t.prsMore} more`) : null) : null);
  }));
}

/** A group of tickets under its heading: the first five, and a disclosure for the rest. Null when the group is empty. */
function leftGroup(title: string, ts: HomeTicket[], cap: number): HTMLElement | null {
  if (ts.length === 0) return null;
  const { shown, rest } = capRows(ts, cap);
  return h('div', { class: 'left-group' },
    h('h3', {}, `${title} (${ts.length})`),
    ticketRows(shown),
    rest.length ? h('details', { class: 'fold' }, h('summary', {}, `Show ${rest.length} more`), ticketRows(rest)) : null);
}

/** What is left, by group: In progress, Blocked, Not started. Null when nothing is open. */
export function leftBody(groups: LeftGroups): HTMLElement | null {
  if (groups.shown === 0) return null;
  const cap = Number.POSITIVE_INFINITY;
  return h('div', {},
    leftGroup('In progress', groups.inProgress, cap),
    leftGroup('Blocked', groups.blocked, 5),
    leftGroup('Not started', groups.notStarted, 5),
    groups.truncated > 0 ? h('p', { class: 'truncated' }, `${groups.truncated} more open ${groups.truncated === 1 ? 'ticket is' : 'tickets are'} not listed here.`) : null);
}

/** The unknowns as a collapsed disclosure carrying its count, or null when there are none. */
export function unknownsFold(home: StreamHome): HTMLElement | null {
  if (home.unknowns.length === 0) return null;
  return h('details', { class: 'fold', id: UNKNOWNS_ID },
    h('summary', {}, unknownsHeading(home.unknowns.length)),
    h('div', { class: 'fold-body' }, h('ul', { class: 'unknowns', role: 'list' }, ...home.unknowns.map((u) => h('li', {}, u.ref?.url ? refLink({ label: u.text, url: u.ref.url }) : u.text)))));
}
