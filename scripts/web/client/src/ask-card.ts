import { BASE_CSS, UI_CSS, h, refLink, shadow, streamTag } from './dom.ts';
import type { AskCard, AskResolveDetail } from './types.ts';

/** Older than this many days an ask is flagged, matching the Markdown page's 3 day threshold. */
export const STALE_DAYS = 3;

const CSS = `${BASE_CSS}${UI_CSS}
  article {
    background: var(--surface-1); border-radius: var(--radius-md); box-shadow: var(--shadow-1);
    padding: var(--space-4) var(--space-5) var(--space-5);
    transition: box-shadow var(--dur-fast) var(--ease-out), background-color var(--dur-base) var(--ease-out);
  }
  @media (hover: hover) { article:hover { box-shadow: var(--shadow-2); } }
  article:focus-within { box-shadow: var(--shadow-2); }
  article.answered { background: var(--surface-2); box-shadow: none; }
  @media (max-width: 480px) { article { padding: var(--space-4); } }

  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-3); margin: 0 0 var(--space-2); padding: 0; list-style: none; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-muted); }
  .meta .age { font-variant-numeric: tabular-nums; }
  .meta .stale { display: inline-flex; gap: 4px; align-items: center; padding: 0 8px; border-radius: var(--radius-pill); background: var(--warning-soft); color: var(--warning); font-weight: var(--weight-medium); }
  h3 { margin: 0; font-size: var(--text-lg); line-height: var(--leading-lg); font-weight: var(--weight-semibold); letter-spacing: -0.01em; max-width: 65ch; text-wrap: pretty; }
  h3:focus { outline: none; }
  .context { margin: var(--space-1) 0 0; color: var(--text-secondary); max-width: 70ch; text-wrap: pretty; }
  .links { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); margin: var(--space-2) 0 0; padding: 0; list-style: none; font-size: var(--text-sm); }

  .form { margin-top: var(--space-4); display: grid; gap: var(--space-2); }
  label { font-size: var(--text-sm); line-height: var(--leading-sm); font-weight: var(--weight-semibold); color: var(--text-secondary); }
  textarea {
    width: 100%; min-height: 72px; resize: vertical; font: inherit; color: var(--text-primary); background: var(--surface-page);
    border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3);
    transition: border-color var(--dur-fast) var(--ease-out);
  }
  textarea:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; border-color: var(--focus); }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-4); }
  .hint { font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-muted); }
  kbd { font-family: var(--font-mono); font-size: var(--text-xs); padding: 0 5px; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; background: var(--surface-1); color: var(--text-secondary); }
  .locked { margin: var(--space-3) 0 0; padding-top: var(--space-3); border-top: 1px solid var(--border); font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-muted); }

  .resolved { margin-top: var(--space-4); display: grid; gap: var(--space-1); animation: enter var(--dur-base) var(--ease-out); }
  .resolved:focus { outline: none; }
  .resolved .done { margin: 0; color: var(--text-primary); font-weight: var(--weight-semibold); }
  .resolved .unsaved { margin: 0; width: fit-content; padding: 2px var(--space-2); border-radius: var(--radius-sm); background: var(--warning-soft); color: var(--warning); font-size: var(--text-sm); line-height: var(--leading-sm); font-weight: var(--weight-medium); }
  .resolved button { justify-self: start; margin-top: var(--space-1); }
  .resolved blockquote { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); background: var(--surface-1); color: var(--text-primary); overflow-wrap: anywhere; }
  .resolved .note { margin: 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  @keyframes enter { from { opacity: 0; transform: translateY(4px); } }
`;

/** True on Apple platforms, where the submit shortcut is shown with the Command key. */
const APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * <ask-card>: one decision awaiting Jack. Set `.ask`. Done (or Ctrl/Cmd+Enter in the answer) fires `ask-resolve`
 * {id, answer} and swaps the form for a confirmation at once; nothing is sent anywhere.
 */
export class AskCardElement extends HTMLElement {
  #root: ShadowRoot;
  #ask: AskCard | null = null;
  #locked = false;
  #showStream = false;

  constructor() {
    super();
    this.#root = shadow(this, CSS);
  }

  get ask(): AskCard | null { return this.#ask; }
  set ask(a: AskCard | null) {
    this.#ask = a;
    this.#render();
  }

  /** True while the page shows sample data: the card says so and has no answer field or Done button. */
  get locked(): boolean { return this.#locked; }
  // The lock only leaves the controls out: whatever handles `ask-resolve` must check its data source itself.
  set locked(v: boolean) { this.#locked = v; this.#render(); }

  /** Name the card's stream (with a link to its tab), for views that mix streams. */
  get showStream(): boolean { return this.#showStream; }
  set showStream(v: boolean) { this.#showStream = v; this.#render(); }

  #render(): void {
    const a = this.#ask;
    if (!a) { this.#root.replaceChildren(); return; }
    const uid = `a-${a.id}`;
    const stale = a.ageDays > STALE_DAYS;
    const links = [...(a.links.note ? [a.links.note] : []), ...a.links.tracker, ...a.links.prs];
    const days = `${a.ageDays} ${a.ageDays === 1 ? 'day' : 'days'}`;
    const waiting = a.ageDays < 1 ? 'Asked today' : `Waiting ${days}`;
    const heading = h('h3', { id: `${uid}-h`, tabindex: '-1' }, a.needed);
    // Every card has a "Your answer" field and a Done button; tie each to its decision so a controls list tells them apart.
    const answer = h('textarea', { id: `${uid}-t`, rows: '3', 'aria-describedby': `${uid}-h ${uid}-k` });
    const done = h('button', { type: 'button', class: 'primary', 'aria-describedby': `${uid}-h` }, 'Done');
    // Sample data: no answer field at all, just the reason, so a locked board stays compact and nothing looks pressable.
    const form = this.#locked
      ? h('p', { class: 'locked' }, h('span', { 'aria-hidden': 'true' }, '○ '), 'Sample data: this ask cannot be answered here.')
      : h('div', { class: 'form' },
        h('label', { for: `${uid}-t` }, 'Your answer'),
        answer,
        h('div', { class: 'actions' }, done,
          h('span', { class: 'hint', id: `${uid}-k` }, h('kbd', {}, APPLE ? '⌘+Enter' : 'Ctrl+Enter'), ' also marks it done. Leave the answer empty to approve as asked.')));
    const article = h('article', { 'aria-labelledby': `${uid}-h` },
      h('ul', { class: 'meta', role: 'list', 'aria-label': 'Details' },
        this.#showStream ? h('li', {}, streamTag(a.stream)) : null,
        h('li', {}, h('span', { class: 'id' }, h('span', { class: 'vh' }, 'Ask '), a.id)),
        h('li', { class: 'age' }, stale
          ? h('span', { class: 'stale' }, h('span', { 'aria-hidden': 'true' }, '⚠︎'), `Waiting ${days} · stale`)
          : waiting)),
      heading,
      a.context ? h('p', { class: 'context' }, a.context) : null,
      links.length ? h('ul', { class: 'links', role: 'list', 'aria-label': 'Links' }, ...links.map((r) => h('li', {}, refLink(r)))) : null,
      form);

    const resolve = (): void => {
      if (this.#locked || !form.isConnected) return;
      const detail: AskResolveDetail = { id: a.id, answer: answer.value.trim() };
      this.dispatchEvent(new CustomEvent<AskResolveDetail>('ask-resolve', { detail, bubbles: true, composed: true }));
      // Honest optimistic feedback: the card settles at once, but says plainly that nothing reached the ledger, and offers
      // the answer for copying into the orchestrator chat. Focus moves here (no live region, so it is read once).
      const copy = detail.answer ? h('button', { type: 'button', class: 'secondary' }, 'Copy answer') : null;
      copy?.addEventListener('click', () => {
        navigator.clipboard?.writeText(detail.answer).then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Copy failed: select the text instead'; });
      });
      const status = h('div', { class: 'resolved', tabindex: '-1', 'aria-label': `Ask ${a.id} marked done on this page` },
        h('p', { class: 'done' }, 'Marked done on this page'),
        detail.answer ? h('blockquote', {}, detail.answer) : h('p', { class: 'note' }, 'No answer: approve as asked.'),
        h('p', { class: 'unsaved' }, h('span', { 'aria-hidden': 'true' }, '⚠\uFE0E '), 'Not saved: this page cannot write to the ledger yet. Tell the orchestrator in chat.'),
        copy);
      article.classList.add('answered');
      form.replaceWith(status);
      status.focus();
    };
    done.addEventListener('click', resolve);
    answer.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); resolve(); }
    });
    this.#root.replaceChildren(article);
  }
}

customElements.define('ask-card', AskCardElement);

declare global { interface HTMLElementTagNameMap { 'ask-card': AskCardElement } }
