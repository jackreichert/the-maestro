import { BASE_CSS, h, refLink, shadow } from './dom.ts';
import { rollupFacts } from './home-text.ts';
import type { EpicLine } from './types.ts';

const CSS = `${BASE_CSS}
  :host { display: block; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: grid; gap: 0; padding: 2px 0; font-size: var(--text-sm); line-height: var(--leading-sm); min-width: 0; }
  .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--space-2); overflow-wrap: anywhere; }
  .id { color: var(--text-muted); font-family: var(--font-mono); font-size: var(--text-xs); }
  /* A long next-ticket title shows two lines and an ellipsis; the whole text is the paragraph's title and stays in the page for assistive tech. */
  .clamp { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
  .facts, .next { margin: 0; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
`;

/**
 * <epic-lines>: the open epics under a priority (or the unfiled ones), one block each: id and linked title, the progress sentence
 * with its denominator, what is blocked, the next ticket and the PRs that name the epic. Everything is text or a checked link.
 */
export class EpicLines extends HTMLElement {
  #root: ShadowRoot;
  #epics: EpicLine[] = [];

  constructor() {
    super();
    this.#root = shadow(this, CSS);
  }

  set epics(e: EpicLine[]) { this.#epics = e; if (this.isConnected) this.#render(); }

  connectedCallback(): void { this.#render(); }

  #render(): void {
    this.#root.replaceChildren(h('ul', { role: 'list' }, ...this.#epics.map((e) => {
      const facts = rollupFacts(e);
      return h('li', {},
        h('span', { class: 'head' }, h('span', { class: 'id' }, e.id), refLink({ label: e.title, url: e.note.url })),
        h('p', { class: 'facts' }, facts.join(' · ')),
        e.next ? h('p', { class: 'next clamp', title: `Next: ${e.next.id} ${e.next.title}` }, 'Next: ', h('span', { class: 'mono' }, e.next.id), ' ', refLink({ label: e.next.title, url: e.next.ref.url })) : null,
        e.prs.length ? h('p', { class: 'next' }, e.prs.length === 1 && !e.prsMore ? 'PR: ' : 'PRs: ', ...e.prs.flatMap((p, i) => [i ? ' ' : '', refLink(p)]), e.prsMore ? ` and ${e.prsMore} more` : '') : null);
    })));
  }
}

customElements.define('epic-lines', EpicLines);

declare global { interface HTMLElementTagNameMap { 'epic-lines': EpicLines } }
