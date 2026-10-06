import { BASE_CSS, h, refLink, shadow } from './dom.ts';
import type { AskCard, AskResolveDetail } from './types.ts';

/** Older than this many days an ask is flagged, matching the Markdown page's 3 day threshold. */
export const STALE_DAYS = 3;

const CSS = `${BASE_CSS}
  article { border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; background: var(--surface-2); }
  h3 { margin: 0 0 4px; font-size: 1rem; }
  h3:focus { outline: none; }
  .context { margin: 0 0 8px; color: var(--text-secondary); }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0 0 8px; padding: 0; list-style: none; font-size: 13px; color: var(--text-secondary); }
  .stale { color: var(--warn); font-weight: 600; }
  label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 4px; }
  textarea { width: 100%; box-sizing: border-box; min-height: 64px; font: inherit; color: var(--text-primary); background: var(--surface-1); border: 1px solid var(--border); border-radius: 4px; padding: 6px; }
  button { margin-top: 8px; font: inherit; padding: 6px 16px; border-radius: 4px; border: 1px solid var(--accent); background: var(--accent); color: var(--surface-1); cursor: pointer; }
  button[disabled] { opacity: .6; cursor: default; }
  .status { margin: 8px 0 0; font-weight: 600; }
  .status:focus { outline: none; }
`;

/** <ask-card>: one decision awaiting Jack. Set `.ask`. Done fires `ask-resolve` {id, answer}; nothing is sent anywhere. */
export class AskCardElement extends HTMLElement {
  #root: ShadowRoot;
  #ask: AskCard | null = null;

  constructor() {
    super();
    this.#root = shadow(this, CSS);
  }

  get ask(): AskCard | null { return this.#ask; }
  set ask(a: AskCard | null) {
    this.#ask = a;
    this.#render();
  }

  #render(): void {
    const a = this.#ask;
    if (!a) { this.#root.replaceChildren(); return; }
    const uid = `a-${a.id}`;
    const stale = a.ageDays > STALE_DAYS;
    const links = [...(a.links.note ? [a.links.note] : []), ...a.links.tracker, ...a.links.prs];
    const heading = h('h3', { id: `${uid}-h`, tabindex: '-1' }, a.needed);
    const answer = h('textarea', { id: `${uid}-t`, rows: '3' });
    const status = h('p', { class: 'status', role: 'status', tabindex: '-1' });
    const done = h('button', { type: 'button' }, 'Done');
    done.addEventListener('click', () => {
      const detail: AskResolveDetail = { id: a.id, answer: answer.value.trim() };
      this.dispatchEvent(new CustomEvent<AskResolveDetail>('ask-resolve', { detail, bubbles: true, composed: true }));
      done.disabled = true;
      answer.disabled = true;
      status.textContent = 'Marked done. Not saved yet: this page cannot write to the ledger.';
      status.focus();
    });
    const meta = h('ul', { class: 'meta', 'aria-label': 'Details' },
      h('li', {}, `Ask ${a.id}`),
      h('li', { class: stale ? 'stale' : undefined }, `${stale ? '⚠ Waiting over ' + STALE_DAYS + ' days: ' : 'Waiting '}${a.ageDays} ${a.ageDays === 1 ? 'day' : 'days'}`),
      ...links.map((r) => h('li', {}, refLink(r))));
    this.#root.replaceChildren(h('article', { 'aria-labelledby': `${uid}-h` },
      heading,
      a.context ? h('p', { class: 'context' }, a.context) : null,
      meta,
      h('label', { for: `${uid}-t` }, 'Your answer'),
      answer, done, status));
  }
}

customElements.define('ask-card', AskCardElement);

declare global { interface HTMLElementTagNameMap { 'ask-card': AskCardElement } }
