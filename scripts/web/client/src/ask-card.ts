import { BASE_CSS, UI_CSS, h, refLink, s, shadow, streamTag } from './dom.ts';
import { askAge, chatAnswer } from './glance.ts';
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
  @media (forced-colors: active) { :host([open]) article { outline: 1px solid CanvasText; } }

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
  .stale-mark { margin-right: 3px; font-size: 0.92em; }
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
  textarea[aria-invalid=true] { border-color: var(--critical); }
  .error { margin: 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--critical); }
  .error[hidden], .copied[hidden] { display: none; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); }
  button.quiet {
    font: inherit; font-size: var(--text-sm); line-height: var(--leading-sm); font-weight: var(--weight-medium); color: var(--text-secondary);
    min-height: 36px; padding: 0 var(--space-3); border: 0; border-radius: var(--radius-sm); background: none; cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  }
  @media (hover: hover) { button.quiet:hover { background: var(--surface-2); color: var(--text-primary); } }
  .copied { margin-left: var(--space-2); font-size: var(--text-sm); font-weight: var(--weight-regular); color: var(--text-secondary); }
  :host([answered]:not([open])) button.ask-toggle { color: var(--text-secondary); }

  .resolved { margin-top: var(--space-4); display: grid; gap: var(--space-1); animation: enter var(--dur-base) var(--ease-out); }
  .resolved:focus { outline: none; }
  .resolved .done { margin: 0; color: var(--text-primary); font-weight: var(--weight-semibold); }
  .bar { display: inline-block; vertical-align: -4px; margin-right: var(--space-2); fill: var(--text-secondary); transform-origin: 50% 100%; }
  .done .bar { animation: bar-in var(--dur-base) var(--ease-out); }
  @keyframes bar-in { from { opacity: 0; transform: scaleY(0.6); } }
  .unresolved { font-family: var(--font-serif); font-weight: var(--weight-regular); font-size: 1.04em; color: var(--text-secondary); }
  .copied .bar { vertical-align: -3px; height: 14px; margin-right: 6px; }
  @media (forced-colors: active) { .bar { fill: CanvasText; } }
  .resolved .unsaved { margin: 0; width: fit-content; padding: 2px var(--space-2); border-radius: var(--radius-sm); background: var(--warning-soft); color: var(--warning); font-size: var(--text-sm); line-height: var(--leading-sm); font-weight: var(--weight-medium); }
  .resolved .actions { margin-top: var(--space-2); }
  .resolved blockquote { margin: 0; max-width: 70ch; padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text-primary); overflow-wrap: anywhere; white-space: pre-wrap; }
  .resolved blockquote.select { user-select: all; }
  @keyframes enter { from { opacity: 0; transform: translateY(4px); } }
`;

/** A single thin barline: an ask answered on this page but not yet resolved in the ledger. Decorative; the words say it. */
function barline(): SVGSVGElement {
  return s('svg', { class: 'bar', viewBox: '0 0 4 18', width: '4', height: '18', 'aria-hidden': 'true', focusable: 'false' },
    s('rect', { x: '1.25', y: '0', width: '1.5', height: '18' }));
}

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

  /** True while the page shows sample data: an opened ask has no answer field or copy button. */
  get locked(): boolean { return this.#locked; }
  // The lock only leaves the controls out: whatever handles `ask-resolve` (fired once an answer is copied) must check its data source itself.
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
    // Every ask has a "Your answer" field and a copy button; tie each to its decision so a controls list tells them apart.
    const answer = h('textarea', { id: `${uid}-t`, rows: '3', 'aria-describedby': [`${uid}-h`, a.context ? `${uid}-c` : ''].filter(Boolean).join(' ') });
    const copy = h('button', { type: 'button', class: 'secondary', 'aria-describedby': `${uid}-h` }, 'Copy answer for chat');
    const error = h('p', { class: 'error', id: `${uid}-e`, role: 'alert', hidden: true }, 'Write an answer first: there is no approve-as-asked shortcut here.');
    // Sample data: no answer field at all (the section head says why), so a locked board has nothing that looks pressable.
    const form = this.#locked ? null
      : h('div', { class: 'form' },
        h('label', { for: `${uid}-t` }, 'Your answer'),
        answer,
        error,
        h('div', { class: 'actions' }, copy));
    const body = h('div', { class: 'body', id: `${uid}-b`, hidden: true },
      a.context ? h('p', { class: 'context', id: `${uid}-c` }, a.context) : null,
      stale ? h('p', { class: 'stale-note' }, `Waiting ${a.ageDays} days: past the ${STALE_DAYS} day mark.`) : null,
      links.length ? h('ul', { class: 'links', role: 'list', 'aria-label': 'Links' }, ...links.map((r) => h('li', {}, refLink(r)))) : null,
      form);
    const copied = h('span', { class: 'copied', hidden: true }, barline(), 'copied');
    const row = h('div', { class: 'row' },
      h('span', { class: 'id' }, h('span', { class: 'vh' }, 'Ask '), a.id),
      h('h3', {}, toggle),
      this.#showStream ? h('span', { class: 'where' }, streamTag(a.stream)) : null,
      h('span', { class: `age${stale ? ' stale' : ''}` },
        // Stale is a glyph as well as the warning colour, so it survives forced colours and colour blindness.
        stale ? h('span', { class: 'stale-mark', 'aria-hidden': 'true' }, '⚠\uFE0E') : null,
        h('span', { class: 'vh' }, a.ageDays < 1 ? 'asked ' : 'waiting '), askAge(a.ageDays), stale ? h('span', { class: 'vh' }, ', stale') : null,
        h('span', { class: 'chev', 'aria-hidden': 'true' })));
    toggle.append(copied);
    const article = h('article', { 'aria-labelledby': `${uid}-h` }, row, body);

    let isOpen = false;
    const setOpen = (open: boolean, focusField: boolean): void => {
      isOpen = open;
      toggle.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
      this.toggleAttribute('open', open);
      if (open && focusField && form?.isConnected) answer.focus();
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

    // The page cannot write to the ledger yet, so answering is copying: the clipboard gets "<id>: <answer>" for the
    // orchestrator chat, and the ask says plainly that nothing was saved. Focus moves to that status (read once, no live region).
    const showStatus = (text: string, ok: boolean): void => {
      // Copied, not saved: a single barline and unresolved. When the page can write, this becomes a final double barline
      // and resolved; until then the music does not claim a resolution that has not happened. A failed copy gets no music.
      const head = h('p', { class: 'done', id: `${uid}-s` }, ...(ok
        ? [barline(), 'Copied for chat ', h('i', { class: 'unresolved' }, 'unresolved')]
        : ['Could not copy']));
      const again = h('button', { type: 'button', class: 'secondary' }, ok ? 'Copy again' : 'Try again');
      const edit = h('button', { type: 'button', class: 'quiet' }, 'Edit answer');
      // A focused group reads only its name, so the quote and the not-saved sentence are tied to it as its description.
      const status = h('div', { class: 'resolved', role: 'group', tabindex: '-1', 'aria-labelledby': `${uid}-s`, 'aria-describedby': `${uid}-q ${uid}-n` },
        head,
        h('blockquote', { class: ok ? undefined : 'select', id: `${uid}-q` }, text),
        h('p', { class: 'unsaved', id: `${uid}-n` }, ok
          ? 'Not saved: paste it into the orchestrator chat. This page cannot write to the ledger yet.'
          : 'Select the answer above and copy it by hand. This page cannot write to the ledger yet.'),
        h('div', { class: 'actions' }, again, edit));
      again.addEventListener('click', () => { void send(text); });
      edit.addEventListener('click', () => { announced = false; status.replaceWith(form ?? ''); this.toggleAttribute('answered', false); copied.hidden = true; answer.focus(); });
      (form?.isConnected ? form : body.querySelector('.resolved'))?.replaceWith(status);
      this.toggleAttribute('answered', ok);
      copied.hidden = !ok;
      status.focus();
    };
    let announced = false;
    const send = async (text: string): Promise<void> => {
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch { ok = false; }
      // Once per answer: Copy again re-copies the same text and must not look like a second decision to a future writer.
      if (ok && !announced) {
        announced = true;
        this.dispatchEvent(new CustomEvent<AskResolveDetail>('ask-resolve', { detail: { id: a.id, answer: answer.value.trim() }, bubbles: true, composed: true }));
      }
      showStatus(text, ok);
    };
    const submit = (): void => {
      if (this.#locked || !form?.isConnected) return;
      const text = chatAnswer(a.id, answer.value);
      showError(text === null);
      if (text === null) { answer.focus(); return; }
      void send(text);
    };
    // The error is tied to the field both ways (aria-errormessage, and aria-describedby for screen readers that ignore
    // it) and is a live alert when it appears; typing clears it.
    const describedBy = answer.getAttribute('aria-describedby') ?? '';
    const showError = (on: boolean): void => {
      error.hidden = !on;
      answer.toggleAttribute('aria-invalid', on);
      if (on) {
        answer.setAttribute('aria-invalid', 'true');
        answer.setAttribute('aria-errormessage', error.id);
        answer.setAttribute('aria-describedby', `${describedBy} ${error.id}`.trim());
      } else {
        answer.removeAttribute('aria-errormessage');
        answer.setAttribute('aria-describedby', describedBy);
      }
    };
    answer.addEventListener('input', () => { if (!error.hidden) showError(false); });
    copy.addEventListener('click', submit);
    answer.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    });
    this.#root.replaceChildren(article);
  }
}

customElements.define('ask-card', AskCardElement);

declare global { interface HTMLElementTagNameMap { 'ask-card': AskCardElement } }
