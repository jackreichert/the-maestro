/**
 * The top of a stream tab: what done looks like for the stream, read from the files that say it (an epic's or a project's
 * "What done looks like"), with progress where it can be counted and a Fine mark when it is met. Nothing here is written by the
 * page: a stream with no definition says which file to add one to.
 */
import { h, refLink } from './dom.ts';
import { sectionHead } from './home-concept.ts';
import { pagedRows } from './pager.ts';
import type { DoneCriterion, DoneSource, StreamHome } from './types.ts';

export const DONE_PAGE = 5;

export const DONE_CSS = `
  .done-top { width: min(760px, 100%); margin-inline: auto; }
  .done-top .sec-head { justify-content: center; text-align: center; }
  .done-top .sec-title { justify-items: center; }
  .done-card { padding: var(--card-pad); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-1); }
  .done-cards { display: grid; gap: var(--space-4); }
  .done-cards > * { margin: 0; }
  .done-card .dc-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-3); }
  .done-card .dc-name { font-family: var(--font-mono); font-size: var(--text-sm); }
  .done-card .dc-kind { color: var(--text-muted); font-size: var(--text-xs); }
  .done-card .dc-count { margin-left: auto; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
  .done-card .dc-bar { height: 4px; margin: var(--space-2) 0 var(--space-3); border-radius: 2px; background: var(--surface-2); overflow: hidden; }
  .done-card .dc-bar > span { display: block; height: 100%; background: var(--accent); }
  .done-card.finished .dc-bar > span { background: var(--success, var(--accent)); }
  .done-card .dc-prose { margin: 0; font-size: var(--text-md); line-height: var(--leading-md); max-width: 62ch; }
  .done-card ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
  .done-card li { display: grid; grid-template-columns: 1.4em minmax(0, 1fr); gap: var(--space-2); font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  .done-card li .mk { color: var(--text-muted); text-align: center; }
  .done-card li.on { color: var(--text-primary); }
  .done-card li.on .mk { color: var(--accent); }
  .done-card .dc-more { margin: var(--space-2) 0 0; font-size: var(--text-xs); color: var(--text-muted); }
  .fine { font-family: var(--font-display); font-style: italic; font-size: var(--text-md); color: var(--text-primary); white-space: nowrap; }
  .fine .bar { font-style: normal; letter-spacing: -0.1em; }
  .done-empty { margin: 0 auto; max-width: 60ch; text-align: center; font-size: var(--text-sm); color: var(--text-muted); }
`;

const progressWords = (p: NonNullable<DoneSource['progress']>): string =>
  p.unit === 'checked' ? `${p.done} of ${p.total} checked` : `${p.done} of ${p.total} ${p.total === 1 ? 'ticket' : 'tickets'} closed`;

function criterion(c: DoneCriterion): HTMLElement {
  const mark = c.checked === null ? '•' : c.checked ? '✓' : '○';
  return h('li', { class: c.checked ? 'on' : '' }, h('span', { class: 'mk', 'aria-hidden': 'true' }, mark),
    h('span', {}, c.checked === null ? null : h('span', { class: 'vh' }, c.checked ? 'Done: ' : 'Open: '), c.text));
}

/** The filled part of a progress bar; the width is set on the element, so no inline style attribute is needed. */
function bar(pct: number): HTMLElement {
  const fill = h('span', {});
  fill.style.width = `${pct}%`;
  return fill;
}

function card(s: DoneSource): HTMLElement {
  const p = s.progress;
  const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  return h('div', { class: `done-card${s.finished ? ' finished' : ''}`, role: 'listitem' },
    h('div', { class: 'dc-head' },
      h('span', { class: 'dc-name' }, refLink({ label: s.name, ...(s.ref.url ? { url: s.ref.url } : {}) })),
      h('span', { class: 'dc-kind' }, s.kind === 'epic' ? 'epic' : 'project note'),
      s.finished ? h('span', { class: 'fine' }, h('i', { lang: 'it' }, 'Fine'), ' ', h('span', { class: 'bar', 'aria-hidden': 'true' }, '❙❙'), h('span', { class: 'vh' }, ', met')) : null,
      p ? h('span', { class: 'dc-count' }, progressWords(p)) : null),
    p ? h('div', { class: 'dc-bar', 'aria-hidden': 'true' }, bar(pct)) : null,
    s.prose ? h('p', { class: 'dc-prose' }, s.prose) : null,
    s.items.length ? h('ul', { role: 'list' }, ...s.items.map(criterion)) : null,
    s.more > 0 ? h('p', { class: 'dc-more' }, `${s.more} more not listed.`) : null);
}

/** The stream's definition of done: one card per written source, paged, or the file to add one to. */
export function doneTop(home: StreamHome): HTMLElement {
  const id = `done-${home.stream.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const { sources, fix } = home.done;
  const cards = sources.map(card);
  const more = pagedRows(cards, { key: `done:${home.stream}`, size: DONE_PAGE, label: 'What done looks like', noun: 'definitions' });
  return h('section', { class: 'section done-top', 'aria-labelledby': id },
    sectionHead({ instrument: 'Cadence', title: 'What done looks like', id, n: sources.length || null }),
    cards.length ? h('div', { class: 'done-cards', role: 'list', 'aria-label': 'Definitions of done' }, ...cards) : h('p', { class: 'done-empty' }, fix ?? 'Nothing says what done looks like for this stream.', ' ', h('i', { lang: 'la' }, 'tacet')),
    more);
}
