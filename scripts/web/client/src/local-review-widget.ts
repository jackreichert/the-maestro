/** Home's compact view of the local review queue: the count and the top few branches, each linking to the full list on the Open PRs tab. */
import { h } from './dom.ts';
import { ago } from './glance.ts';
import { verdictWords } from './local-review.ts';
import { OPEN_PRS, formatFragment } from './tabs.ts';
import type { LocalReview } from './types.ts';

/** Branches shown on Home; the rest are one link away. */
export const WIDGET_CAP = 3;

export const LOCAL_WIDGET_CSS = `
  .local-widget ul { list-style: none; margin: 0; padding: 0; border-top: var(--hairline); }
  .local-widget li { padding: var(--space-2) 0; border-bottom: var(--hairline); font-size: var(--text-sm); line-height: var(--leading-sm); min-width: 0; overflow-wrap: anywhere; }
  .local-widget li a { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--space-3); color: inherit; text-decoration: none; padding-block: 2px; }
  .local-widget li a:hover .br { text-decoration: underline; }
  .local-widget .repo { color: var(--text-muted); font-family: var(--font-mono); font-size: var(--text-xs); }
  .local-widget .vw { color: var(--text-secondary); }
  .local-widget .vw.warn { color: var(--warning); }
  .local-widget .vw.ok { color: var(--success); }
  .local-widget .all { margin: var(--space-2) 0 0; font-size: var(--text-sm); }
`;

/** Branches waiting in the whole queue (rows plus the ones the server left out), or 0 when the queue is unreadable. */
export const queueSize = (r: LocalReview | null): number => (r?.available ? r.units.length + r.more : 0);

/** The widget, or a one-line note when the queue is unavailable or empty. The count is the whole queue, not just the rows shown. */
export function localReviewWidget(r: LocalReview | null): HTMLElement {
  const total = queueSize(r);
  const head = h('div', { class: 'sec-head' }, h('h2', { id: 'local-widget-h' }, 'Waiting for local review', total > 0 ? h('span', { class: 'n' }, h('span', { class: 'vh' }, ', '), String(total)) : null));
  const to = formatFragment(OPEN_PRS);
  const wrap = (...body: (Node | null)[]): HTMLElement => h('section', { class: 'local-widget', 'aria-labelledby': 'local-widget-h' }, head, ...body);
  const note = (text: string): HTMLElement => wrap(h('p', { class: 'empty-line' }, text));
  if (!r) return note('The local review queue is not available from this page.');
  if (!r.available) return note(r.reason ?? 'The local review queue could not be read.');
  if (total === 0) return note('No local branch is waiting for review.');
  const rows = r.units.slice(0, WIDGET_CAP).map((u) => {
    const v = verdictWords(u);
    const age = ago(u.at, r.generatedAt);
    return h('li', {}, h('a', { href: to },
      h('span', { class: 'repo' }, u.repo), h('span', { class: 'mono br' }, u.branch),
      h('span', { class: `vw ${v.tone}` }, h('span', { 'aria-hidden': 'true' }, `${v.glyph} `), v.text),
      age ? h('span', { class: 'repo' }, age === 'just now' ? age : `${age} ago`) : null));
  });
  return wrap(
    h('ul', { role: 'list' }, ...rows),
    h('p', { class: 'all' }, h('a', { href: to }, total > rows.length ? `All ${total} on the Open PRs tab` : 'Open the list on the Open PRs tab')));
}
