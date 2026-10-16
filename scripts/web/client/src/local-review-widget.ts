/** Rehearsal: Home's compact view of the local review queue. The count and the top few branches, each with a button to the full list on the Open PRs tab. */
import { h } from './dom.ts';
import { ago } from './glance.ts';
import { conceptSection, tacet } from './home-concept.ts';
import { verdictWords } from './local-review.ts';
import { OPEN_PRS, formatFragment } from './tabs.ts';
import type { LocalReview } from './types.ts';

/** Branches shown on Home; the rest are one link away. */
export const WIDGET_CAP = 3;

export const LOCAL_WIDGET_CSS = `
  .rh-list { display: grid; margin: 0; padding: 0; list-style: none; }
  .rh { display: flex; align-items: center; gap: var(--space-3); padding-block: var(--space-3); border-top: var(--hairline); min-width: 0; }
  .rh:first-child { border-top: 0; padding-top: 0; }
  .rh-body { flex: 1 1 0; min-width: 0; display: grid; gap: 2px; }
  .rh-body .br { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rh-body .sub { display: flex; flex-wrap: wrap; gap: 0 var(--space-3); font-size: var(--text-sm); color: var(--text-muted); }
  .rh-body .vw { color: var(--text-secondary); }
  .rh-body .vw.warn { color: var(--warning); }
  .rh-body .vw.ok { color: var(--success); }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); min-height: 36px; padding: 0 var(--space-4); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: transparent; color: var(--text-primary); font: inherit; font-size: var(--text-sm); font-weight: var(--weight-medium); line-height: 1; text-decoration: none; white-space: nowrap; cursor: pointer; transition: background-color var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out); }
  .btn:active { transform: scale(0.97); }
  @media (hover: hover) { .btn:hover { background: var(--surface-2); } }
  .rh-all { margin: var(--space-3) 0 0; font-size: var(--text-sm); }
`;

/** Branches waiting in the whole queue (rows plus the ones the server left out), or 0 when the queue is unreadable. */
export const queueSize = (r: LocalReview | null): number => (r?.available ? r.units.length + r.more : 0);

/** The widget, or a one-line note when the queue is unavailable or empty. The count is the whole queue, not just the rows shown. */
export function localReviewWidget(r: LocalReview | null): HTMLElement {
  const total = queueSize(r);
  const section = (...body: (Node | null)[]): HTMLElement => conceptSection('rehearsal', { instrument: 'Rehearsal', title: 'Waiting for local review', n: total || null }, ...body);
  const note = (text: string): HTMLElement => section(tacet(text, 'tacet'));
  if (!r) return note('The local review queue is not available from this page.');
  if (!r.available) return note(r.reason ?? 'The local review queue could not be read.');
  if (total === 0) return note('No local branch is waiting for review.');
  const to = formatFragment(OPEN_PRS);
  const rows = r.units.slice(0, WIDGET_CAP).map((u) => {
    const v = verdictWords(u);
    const age = ago(u.at, r.generatedAt);
    return h('li', { class: 'rh' },
      h('div', { class: 'rh-body' },
        h('span', { class: 'br', title: u.branch }, u.branch),
        h('span', { class: 'sub' }, h('span', {}, u.repo), h('span', { class: `vw ${v.tone}` }, h('span', { 'aria-hidden': 'true' }, `${v.glyph} `), v.text), age ? h('span', {}, `ready ${age === 'just now' ? age : `${age} ago`}`) : null)),
      h('a', { class: 'btn', href: to, 'aria-label': `Review ${u.branch}; opens the Open PRs tab` }, 'Review'));
  });
  return section(
    h('ul', { class: 'rh-list', role: 'list' }, ...rows),
    h('p', { class: 'rh-all' }, h('a', { href: to }, total > rows.length ? `All ${total} on the Open PRs tab` : 'Open the list on the Open PRs tab')));
}
