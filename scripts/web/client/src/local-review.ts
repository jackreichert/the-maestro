import { BASE_CSS, h, shadow } from './dom.ts';
import { ago } from './glance.ts';
import type { LocalReview, LocalUnit } from './types.ts';

const CSS = `${BASE_CSS}
  :host { display: block; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: grid; gap: 2px; padding: var(--space-1) 0; font-size: var(--text-sm); line-height: var(--leading-sm); min-width: 0; }
  .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--space-2); overflow-wrap: anywhere; }
  .repo { color: var(--text-muted); font-family: var(--font-mono); font-size: var(--text-xs); }
  .facts, .cmd, .note, .empty { margin: 0; color: var(--text-secondary); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .cmd code { user-select: all; }
  .verdict { font-weight: var(--weight-semibold); }
  .verdict.ok { color: var(--success); }
  .verdict.warn { color: var(--warning); }
  .note { font-size: var(--text-xs); color: var(--text-muted); }
`;

/** The words of a unit's verdict and a glyph class; the words carry the meaning, the glyph and colour only echo it. */
export function verdictWords(u: LocalUnit): { glyph: string; text: string; tone: 'ok' | 'warn' | 'none' } {
  switch (u.verdict.state) {
    case 'ship-it': return { glyph: '✓', text: 'SHIP IT for this commit', tone: 'ok' };
    case 'needs-work': return { glyph: '⚠', text: 'NEEDS WORK', tone: 'warn' };
    case 'stale': return { glyph: '⚠', text: 'Reviewed an earlier commit; review again', tone: 'warn' };
    case 'none': return { glyph: '○', text: 'Not reviewed yet', tone: 'none' };
  }
}

/**
 * <local-review>: branches that hold commits nobody has pushed, each with its commits ahead, the last commit, the re-review verdict
 * for its exact head and the command that opens its diff. An unreadable queue says why. Everything is text; there are no links.
 */
export class LocalReviewList extends HTMLElement {
  #root: ShadowRoot;
  #review: LocalReview | null = null;

  constructor() {
    super();
    this.#root = shadow(this, CSS);
  }

  set review(r: LocalReview | null) { this.#review = r; if (this.isConnected) this.#render(); }

  connectedCallback(): void { this.#render(); }

  #render(): void {
    const r = this.#review;
    if (!r) { this.#root.replaceChildren(h('p', { class: 'empty' }, 'The local review queue is not available from this page.')); return; }
    if (!r.available) { this.#root.replaceChildren(h('p', { class: 'empty' }, r.reason ?? 'The local review queue could not be read.')); return; }
    if (r.units.length === 0) { this.#root.replaceChildren(h('p', { class: 'empty' }, 'No local branches are waiting for review.')); return; }
    this.#root.replaceChildren(
      h('ul', { role: 'list' }, ...r.units.map((u) => {
        const v = verdictWords(u);
        const age = ago(u.at, r.generatedAt);
        return h('li', {},
          h('span', { class: 'head' }, h('span', { class: 'repo' }, u.repo), h('span', { class: 'mono' }, u.branch)),
          h('p', { class: 'facts' }, `${u.ahead} ${u.ahead === 1 ? 'commit' : 'commits'} not pushed${age ? `, last commit ${age === 'just now' ? age : `${age} ago`}` : ''}: ${u.subject}`),
          h('p', { class: 'facts' }, h('span', { class: `verdict ${v.tone}` }, h('span', { 'aria-hidden': 'true' }, `${v.glyph} `), v.text)),
          h('p', { class: 'cmd' }, 'Diff: ', h('code', {}, u.command)));
      })),
      ...(r.more > 0 ? [h('p', { class: 'note' }, `and ${r.more} more`)] : []),
      ...r.notes.map((n) => h('p', { class: 'note' }, n)));
  }
}

customElements.define('local-review', LocalReviewList);

declare global { interface HTMLElementTagNameMap { 'local-review': LocalReviewList } }
