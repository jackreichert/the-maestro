import { BASE_CSS, UI_CSS, h, refLink, shadow, streamTag } from './dom.ts';
import { askAge } from './glance.ts';
import type { AskCard, AskResolveDetail } from './types.ts';

/** Older than this many days an ask is flagged, matching the Markdown page's 3 day threshold. */
export const STALE_DAYS = 3;

const CSS = `${BASE_CSS}${UI_CSS}
  :host { border-bottom: 1px solid var(--border); container-type: inline-size; }
  :host([open]) { border-bottom-color: transparent; }
  article {
    display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; column-gap: var(--space-3);
    margin-inline: calc(-1 * var(--space-3)); border-radius: var(--radius-md);
    transition: background-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
  }
  :host([open]) article { background: var(--surface-1); box-shadow: var(--shadow-1); margin-block: var(--space-2); }

  /* The row: id, the decision (the disclosure button), stream and age. The whole row is the click target. */
  .row {
    grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: baseline; row-gap: 2px;
    padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-out);
  }
  @media (hover: hover) { :host(:not([open])) .row:hover { background: var(--surface-1); } }
  h3 { margin: 0; min-width: 0; font-size: var(--text-md); line-height: var(--leading-md); font-weight: var(--weight-medium); letter-spacing: -0.005em; }
  button.ask-toggle {
    all: unset; box-sizing: border-box; display: block; width: 100%; min-height: 24px; cursor: pointer; color: var(--text-primary);
    overflow-wrap: anywhere; text-wrap: pretty; border-radius: 4px;
  }
  button.ask-toggle:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
  .where { font-size: var(--text-sm); line-height: var(--leading-sm); white-space: nowrap; }
  .age { font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; min-width: 3.5em; }
  .age.stale { color: var(--warning); font-weight: var(--weight-medium); }
  .chev {
    display: inline-block; width: 6px; height: 6px; margin-left: var(--space-2); border: solid var(--text-muted); border-width: 0 1.5px 1.5px 0;
    transform: translateY(-2px) rotate(45deg); transition: transform var(--dur-base) var(--ease-out);
  }
  :host([open]) .chev { transform: translateY(1px) rotate(225deg); }
  @container (max-width: 520px) {
    article { grid-template-columns: auto minmax(0, 1fr) auto; }
    .where { grid-column: 2; grid-row: 2; }
    .age { grid-column: 3; grid-row: 1; }
    .body { grid-column: 1 / -1; padding-left: var(--space-3); }
  }

  /* The opened ask: context, links, then the answer form, indented to the decision's left edge. */
  .body { grid-column: 2 / -1; padding: 0 var(--space-3) var(--space-4) 0; }
  .body[hidden] { display: none; }
  .context { margin: 0; color: var(--text-secondary); max-width: 70ch; text-wrap: pretty; }
  .stale-note { margin: var(--space-1) 0 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--warning); }
  .links { display: flex; flex-wrap: wrap; gap: 0 var(--space-3); margin: var(--space-2) 0 0; padding: 0; list-style: none; font-size: var(--text-sm); line-height: var(--leading-sm); }

  .form { margin-top: var(--space-4); display: grid; gap: var(--space-2); max-width: 70ch; }
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

  .resolved { margin-top: var(--space-4); display: grid; gap: var(--space-1); animation: enter var(--dur-base) var(--ease-out); }
  .resolved:focus { outline: none; }
  .resolved .done { margin: 0; color: var(--text-primary); font-weight: var(--weight-semibold); }
  .resolved .unsaved { margin: 0; width: fit-content; padding: 2px var(--space-2); border-radius: var(--radius-sm); background: var(--warning-soft); color: var(--warning); font-size: var(--text-sm); line-height: var(--leading-sm); font-weight: var(--weight-medium); }
  .resolved button { justify-self: start; margin-top: var(--space-1); }
  .resolved blockquote { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text-primary); overflow-wrap: anywhere; }
  .note { margin: var(--space-3) 0 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-muted); }
  .resolved .note { margin: 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  @keyframes enter { from { opacity: 0; transform: translateY(4px); } }
`;

/** True on Apple platforms, where the submit shortcut is shown with the Command key. */
const APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * <ask-card>: one decision awaiting Jack, drawn as a single row (id, decision, stream, age). Clicking the row, or Enter
 * or Space on the decision, opens the ask in place: its context, links and answer form. Set `.ask`. The `open`
 * attribute reflects the state so the list around it can style an opened ask.
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

  /** True while the page shows sample data: an opened ask has no answer field or Done button. */
  get locked(): boolean { return this.#locked; }
  // The lock only leaves the controls out: whatever handles `ask-resolve` must check its data source itself.
  set locked(v: boolean) { this.#locked = v; this.#render(); }

  /** Name the card's stream (with a link to its tab), for views that mix streams. */
  get showStream(): boolean { return this.#showStream; }
  set showStream(v: boolean) { this.#showStream = v; this.#render(); }

  /** Move focus to the ask's decision (its disclosure button). */
  focusToggle(): void { this.#root.querySelector<HTMLElement>('button.ask-toggle')?.focus(); }

  #render(): void {
    const a = this.#ask;
    this.removeAttribute('open');
    if (!a) { this.#root.replaceChildren(); return; }
    const uid = `a-${a.id}`;
    const stale = a.ageDays > STALE_DAYS;
    const links = [...(a.links.note ? [a.links.note] : []), ...a.links.tracker, ...a.links.prs];
    const toggle = h('button', { type: 'button', class: 'ask-toggle', id: `${uid}-h`, 'aria-expanded': 'false', 'aria-controls': `${uid}-b` }, a.needed);
    // Every ask has a "Your answer" field and a Done button; tie each to its decision so a controls list tells them apart.
    const answer = h('textarea', { id: `${uid}-t`, rows: '3', 'aria-describedby': [`${uid}-h`, a.context ? `${uid}-c` : '', `${uid}-k`].filter(Boolean).join(' ') });
    const done = h('button', { type: 'button', class: 'primary', 'aria-describedby': `${uid}-h` }, 'Done');
    // Sample data: no answer field at all, just the reason, so a locked board stays compact and nothing looks pressable.
    const form = this.#locked
      ? h('p', { class: 'note' }, 'Sample data: this ask cannot be answered here.')
      : h('div', { class: 'form' },
        h('label', { for: `${uid}-t` }, 'Your answer'),
        answer,
        h('div', { class: 'actions' }, done,
          h('span', { class: 'hint', id: `${uid}-k` }, h('kbd', {}, APPLE ? '⌘+Enter' : 'Ctrl+Enter'), ' also marks it done. Leave the answer empty to approve as asked.')));
    const body = h('div', { class: 'body', id: `${uid}-b`, hidden: true },
      a.context ? h('p', { class: 'context', id: `${uid}-c` }, a.context) : null,
      stale ? h('p', { class: 'stale-note' }, `Waiting ${a.ageDays} days: past the ${STALE_DAYS} day mark.`) : null,
      links.length ? h('ul', { class: 'links', role: 'list', 'aria-label': 'Links' }, ...links.map((r) => h('li', {}, refLink(r)))) : null,
      form);
    const row = h('div', { class: 'row' },
      h('span', { class: 'id' }, h('span', { class: 'vh' }, 'Ask '), a.id),
      h('h3', {}, toggle),
      this.#showStream ? h('span', { class: 'where' }, streamTag(a.stream)) : null,
      h('span', { class: `age${stale ? ' stale' : ''}` },
        h('span', { class: 'vh' }, a.ageDays < 1 ? 'asked ' : 'waiting '), askAge(a.ageDays), stale ? h('span', { class: 'vh' }, ', stale') : null,
        h('span', { class: 'chev', 'aria-hidden': 'true' })));
    const article = h('article', { 'aria-labelledby': `${uid}-h` }, row, body);

    let isOpen = false;
    const setOpen = (open: boolean, focusField: boolean): void => {
      isOpen = open;
      toggle.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
      this.toggleAttribute('open', open);
      if (open && focusField && answer.isConnected) answer.focus();
    };
    toggle.addEventListener('click', () => setOpen(!isOpen, true));
    // The rest of the row opens it too, except the controls inside it (the stream link keeps its own job).
    row.addEventListener('click', (e) => {
      if (e.target instanceof Element && e.target.closest('a, button')) return;
      setOpen(!isOpen, true);
    });
    // Escape in the answer folds the ask back to its row and returns focus to the decision; the text stays.
    answer.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false, false); toggle.focus(); }
    });

    const resolve = (): void => {
      if (this.#locked || !form.isConnected) return;
      const detail: AskResolveDetail = { id: a.id, answer: answer.value.trim() };
      this.dispatchEvent(new CustomEvent<AskResolveDetail>('ask-resolve', { detail, bubbles: true, composed: true }));
      // Honest optimistic feedback: the ask settles at once, but says plainly that nothing reached the ledger, and offers
      // the answer for copying into the orchestrator chat. Focus moves here (no live region, so it is read once).
      const copy = detail.answer ? h('button', { type: 'button', class: 'secondary' }, 'Copy answer') : null;
      copy?.addEventListener('click', () => {
        navigator.clipboard?.writeText(detail.answer).then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Copy failed: select the text instead'; });
      });
      const status = h('div', { class: 'resolved', tabindex: '-1', 'aria-label': `Ask ${a.id} marked done on this page` },
        h('p', { class: 'done' }, 'Marked done on this page'),
        detail.answer ? h('blockquote', {}, detail.answer) : h('p', { class: 'note' }, 'No answer: approve as asked.'),
        h('p', { class: 'unsaved' }, h('span', { 'aria-hidden': 'true' }, '⚠︎ '), 'Not saved: this page cannot write to the ledger yet. Tell the orchestrator in chat.'),
        copy);
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
