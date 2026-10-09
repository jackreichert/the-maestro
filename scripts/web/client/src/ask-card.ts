import { BASE_CSS, UI_CSS, h, refLink, s, shadow, streamTag } from './dom.ts';
import { askAge } from './glance.ts';
import { createAnswerer } from './answer-api.ts';
import type { AnswerRequest } from './answer-api.ts';
import { askState } from './ask-state.ts';
import './md-fragment.ts';
import type { AskBusyDetail, AskCard, AskResolveDetail } from './types.ts';

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
  .context { display: block; margin: 0; color: var(--text-secondary); max-width: 70ch; text-wrap: pretty; overflow-wrap: anywhere; }
  .decide { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-1) var(--space-3); margin: var(--space-3) 0 0; max-width: 70ch; font-size: var(--text-sm); line-height: var(--leading-sm); }
  .decide dt { color: var(--text-muted); font-weight: var(--weight-medium); }
  .decide dd { margin: 0; color: var(--text-primary); overflow-wrap: anywhere; }
  .paste { margin: var(--space-3) 0 0; max-width: 70ch; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  .paste code { font-family: var(--font-mono); background: var(--surface-2); padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }
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
  .error[hidden], .saved-mark[hidden] { display: none; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); }
  button.quiet {
    font: inherit; font-size: var(--text-sm); line-height: var(--leading-sm); font-weight: var(--weight-medium); color: var(--text-secondary);
    min-height: 36px; padding: 0 var(--space-3); border: 0; border-radius: var(--radius-sm); background: none; cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  }
  @media (hover: hover) { button.quiet:hover { background: var(--surface-2); color: var(--text-primary); } }
  .saved-mark { margin-left: var(--space-2); font-size: var(--text-sm); font-weight: var(--weight-regular); color: var(--text-secondary); }
  :host([answered]:not([open])) button.ask-toggle { color: var(--text-secondary); }

  .resolved { margin-top: var(--space-4); display: grid; gap: var(--space-1); animation: enter var(--dur-base) var(--ease-out); }
  .resolved:focus { outline: none; }
  .resolved .done { margin: 0; color: var(--text-primary); font-weight: var(--weight-semibold); }
  .bar { display: inline-block; vertical-align: -4px; margin-right: var(--space-2); fill: var(--text-secondary); transform-origin: 50% 100%; }
  .bar.final { fill: var(--text-primary); }
  .done .bar { animation: bar-in var(--dur-base) var(--ease-out); }
  @keyframes bar-in { from { opacity: 0; transform: scaleY(0.6); } }
  .resolved-word { font-family: var(--font-serif); font-weight: var(--weight-regular); font-size: 1.04em; color: var(--text-secondary); }
  .saved-mark .bar { vertical-align: -3px; height: 14px; margin-right: 6px; }
  @media (forced-colors: active) { .bar { fill: CanvasText; } }
  .resolved .recorded { margin: 0; color: var(--text-secondary); font-size: var(--text-sm); line-height: var(--leading-sm); }
  .resolved blockquote { margin: 0; max-width: 70ch; padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text-primary); overflow-wrap: anywhere; white-space: pre-wrap; }
  .resolved blockquote.select { user-select: all; }
  @keyframes enter { from { opacity: 0; transform: translateY(4px); } }
`;

/** The ask's body: the writer's line breaks, lists and bare https or obsidian URLs (as links, within the link policy) kept. */
function context(text: string, id: string): HTMLElement {
  const frag = h('md-fragment', { class: 'context', id });
  frag.options = { autolink: true, breaks: true };
  frag.markdown = text;
  return frag;
}

/** What the ask recommends, how reversible it is, what silence does and by when, as a list of labelled lines; null when it carries none. */
function decisionFields(a: AskCard): HTMLElement | null {
  const rows: [string, string][] = [
    ...(a.recommend ? [['Recommend', a.recommend] as [string, string]] : []),
    ...(a.door ? [['Door', a.door === 'one-way' ? 'one-way (silence never decides it)' : 'two-way (reversible)'] as [string, string]] : []),
    ...(a.default ? [['If silent', a.default] as [string, string]] : []),
    ...(a.by ? [['Decide by', a.by] as [string, string]] : []),
    ...(a.class ? [['Class', a.class] as [string, string]] : []),
  ];
  return rows.length ? h('dl', { class: 'decide', 'aria-label': 'Decision details' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])) : null;
}

/** A final double barline (a thin line and a thick one): an ask answered and closed in the ledger. Decorative; the words say it. */
function finalBar(): SVGSVGElement {
  return s('svg', { class: 'bar final', viewBox: '0 0 8 18', width: '8', height: '18', 'aria-hidden': 'true', focusable: 'false' },
    s('rect', { x: '0.5', y: '0', width: '1.5', height: '18' }), s('rect', { x: '4', y: '0', width: '3.5', height: '18' }));
}

/**
 * <ask-card>: one decision awaiting Jack, drawn as a single row (id, decision, stream, age). Clicking the row, or Enter
 * or Space on the decision, opens the ask in place: its context, links and answer form. Saving an answer posts it to the server (answer-api.ts);
 * the ask then leaves the board on the next live update. Set `.ask`. The `open`
 * attribute reflects the state so the list around it can style an opened ask.
 */
export class AskCardElement extends HTMLElement {
  #root: ShadowRoot;
  #ask: AskCard | null = null;
  #locked = false;
  #showStream = false;
  #fold: (() => void) | null = null;

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
  // The lock only leaves the controls out: whatever handles `ask-resolve` (fired once an answer is saved) must check its data source itself.
  set locked(v: boolean) { this.#locked = v; this.#render(); }

  /** Name the card's stream (with a link to its tab), for views that mix streams. */
  get showStream(): boolean { return this.#showStream; }
  set showStream(v: boolean) { this.#showStream = v; this.#render(); }

  /** Fold the ask back to its row, keeping any draft; used when another ask in the same list opens. */
  fold(): void { this.#fold?.(); }

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
    // Every ask has a "Your answer" field and its buttons; tie each to its decision so a controls list tells them apart.
    const answer = h('textarea', { id: `${uid}-t`, rows: '3', 'aria-describedby': [`${uid}-h`, a.context ? `${uid}-c` : ''].filter(Boolean).join(' ') });
    answer.value = this.#locked ? '' : askState.draft(a.id);   // a redraw rebuilds the card; the half-typed answer comes back with it
    answer.addEventListener('input', () => askState.setDraft(a.id, answer.value));
    const describedByDecision = { type: 'button', 'aria-describedby': `${uid}-h` };
    const save = h('button', { ...describedByDecision, class: 'primary', id: `${uid}-save` }, 'Send answer');
    const take = a.recommend ? h('button', { ...describedByDecision, class: 'secondary', id: `${uid}-take` }, 'Take recommendation') : null;
    const skip = h('button', { ...describedByDecision, class: 'quiet', id: `${uid}-skip` }, 'Skip');
    const buttons = [save, ...(take ? [take] : []), skip];
    const NEEDS_ANSWER = 'Write an answer first: there is no approve-as-asked shortcut here.';
    const error = h('p', { class: 'error', id: `${uid}-e`, role: 'alert', hidden: true }, NEEDS_ANSWER);
    // Sample data: no answer field at all (the section head says why), so a locked board has nothing that looks pressable.
    const form = this.#locked ? null
      : h('div', { class: 'form' },
        h('label', { for: `${uid}-t` }, 'Your answer'),
        answer,
        error,
        h('div', { class: 'actions' }, ...buttons));
    const body = h('div', { class: 'body', id: `${uid}-b`, hidden: true },
      a.context ? context(a.context, `${uid}-c`) : null,
      a.paste ? h('p', { class: 'paste' }, 'Run this block, then answer with what it printed: ', h('code', {}, a.paste)) : null,
      decisionFields(a),
      stale ? h('p', { class: 'stale-note' }, `Waiting ${a.ageDays} days: past the ${STALE_DAYS} day mark.`) : null,
      links.length ? h('ul', { class: 'links', role: 'list', 'aria-label': 'Links' }, ...links.map((r) => h('li', {}, refLink(r)))) : null,
      form);
    const savedMark = h('span', { class: 'saved-mark', hidden: true }, finalBar(), 'saved');
    const row = h('div', { class: 'row' },
      h('span', { class: 'id' }, h('span', { class: 'vh' }, 'Ask '), a.id),
      h('h3', {}, toggle),
      this.#showStream ? h('span', { class: 'where' }, streamTag(a.stream)) : null,
      h('span', { class: `age${stale ? ' stale' : ''}` },
        // Stale is a glyph as well as the warning colour, so it survives forced colours and colour blindness.
        stale ? h('span', { class: 'stale-mark', 'aria-hidden': 'true' }, '⚠\uFE0E') : null,
        h('span', { class: 'vh' }, a.ageDays < 1 ? 'asked ' : 'waiting '), askAge(a.ageDays), stale ? h('span', { class: 'vh' }, ', stale') : null,
        h('span', { class: 'chev', 'aria-hidden': 'true' })));
    toggle.append(savedMark);
    const article = h('article', { 'aria-labelledby': `${uid}-h` }, row, body);

    let isOpen = false;
    const setOpen = (open: boolean, focusField: boolean): void => {
      isOpen = open;
      askState.setOpen(a.id, open);
      toggle.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
      this.toggleAttribute('open', open);
      // One answer form at a time: the list around this card folds the others (a restored open card on a redraw does not announce itself).
      if (open && focusField) this.dispatchEvent(new CustomEvent('ask-open', { bubbles: true, composed: true }));
      if (open && focusField && form?.isConnected) answer.focus();
    };
    this.#fold = () => { if (isOpen) setOpen(false, false); };
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

    // The settled card: what the ledger now holds, in a group that takes focus once. The ask leaves the board on the next live update.
    const showStatus = (text: string, focus = true): void => {
      const head = h('p', { class: 'done', id: `${uid}-s` }, finalBar(), 'Saved ', h('i', { class: 'resolved-word' }, 'resolved'));
      // A focused group reads only its name, so the quote and the sentence under it are tied to it as its description.
      const status = h('div', { class: 'resolved', id: `${uid}-r`, role: 'group', tabindex: '-1', 'aria-labelledby': `${uid}-s`, 'aria-describedby': `${uid}-q ${uid}-n` },
        head,
        h('blockquote', { id: `${uid}-q` }, text),
        h('p', { class: 'recorded', id: `${uid}-n` }, 'Recorded in the ledger. This ask leaves the board on the next update.'));
      form?.replaceWith(status);
      this.toggleAttribute('answered', true);
      savedMark.hidden = false;
      if (focus) status.focus();
    };
    const busy = (on: boolean): void => {
      for (const b of buttons) b.toggleAttribute('disabled', on);
      this.dispatchEvent(new CustomEvent<AskBusyDetail>('ask-busy', { detail: { busy: on }, bubbles: true, composed: true }));
    };
    const answerer = createAnswerer();
    const send = async (req: AnswerRequest): Promise<void> => {
      busy(true);   // the page holds redraws until the request has settled, or the card would be replaced mid-await
      const out = await answerer.send(req);
      if (out.ok) {
        // Once per answer, kept in askState so a rebuilt card cannot announce it again.
        if (askState.resolve(a.id, out.answer)) {
          this.dispatchEvent(new CustomEvent<AskResolveDetail>('ask-resolve', { detail: { id: a.id, answer: out.answer }, bubbles: true, composed: true }));
        }
        showStatus(out.answer);
      } else {
        showError(true, out.message);
      }
      busy(false);
      if (!out.ok && out.closed) for (const b of buttons) b.setAttribute('disabled', '');   // nothing to retry: the board drops it on the next update
    };
    const submit = (): void => {
      if (this.#locked || !form?.isConnected) return;
      const text = answer.value.trim();
      if (!text) { showError(true, NEEDS_ANSWER); answer.focus(); return; }
      void send({ id: a.id, mode: 'text', answer: text });
    };
    // The error is tied to the field both ways (aria-errormessage, and aria-describedby for screen readers that ignore
    // it) and is a live alert when it appears; typing clears it.
    const describedBy = answer.getAttribute('aria-describedby') ?? '';
    const showError = (on: boolean, message = NEEDS_ANSWER): void => {
      error.textContent = message;
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
    save.addEventListener('click', submit);
    take?.addEventListener('click', () => { void send({ id: a.id, mode: 'recommend' }); });
    skip.addEventListener('click', () => { void send({ id: a.id, mode: 'skip' }); });
    answer.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    });
    // Rebuilt by a live update: put back what the user had. A saved answer stays settled (no focus grab, the user did
    // not just act); a half-typed one reopens its ask so it is not hidden behind a folded row, unless another ask holds the one open form.
    const prior = this.#locked ? null : askState.resolvedAnswer(a.id);
    if (prior !== null) {
      answer.value = prior;
      setOpen(true, false);
      showStatus(prior, false);
    } else if (!this.#locked && answer.value !== '' && askState.mayReopenForDraft(a.id)) {
      setOpen(true, false);
    }
    if (askState.isOpen(a.id)) setOpen(true, false);   // unfolded before the redraw: still unfolded, without taking focus
    this.#root.replaceChildren(article);
  }
}

customElements.define('ask-card', AskCardElement);

declare global { interface HTMLElementTagNameMap { 'ask-card': AskCardElement } }
