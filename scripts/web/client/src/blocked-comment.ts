import { BASE_CSS, UI_CSS, h, shadow } from './dom.ts';
import { createCommenter } from './blocked-api.ts';
import type { CommentOutcome, CommentRequest } from './blocked-api.ts';
import type { AskBusyDetail } from './types.ts';

const CSS = `${BASE_CSS}${UI_CSS}
  :host { display: block; grid-column: 1 / -1; padding-top: var(--space-1); }
  button.toggle {
    font: inherit; font-size: var(--text-sm); line-height: var(--leading-sm); font-weight: var(--weight-medium); color: var(--text-secondary);
    min-height: 32px; padding: 0 var(--space-2); border: 0; border-radius: var(--radius-sm); background: none; cursor: pointer;
  }
  button.toggle:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  @media (hover: hover) { button.toggle:hover { background: var(--surface-2); color: var(--text-primary); } }
  .form { margin-top: var(--space-2); display: grid; gap: var(--space-2); max-width: 70ch; }
  .form[hidden] { display: none; }
  label { font-size: var(--text-sm); line-height: var(--leading-sm); font-weight: var(--weight-semibold); color: var(--text-secondary); }
  textarea {
    width: 100%; min-height: 64px; resize: vertical; font: inherit; color: var(--text-primary); background: var(--surface-page);
    border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3);
  }
  textarea:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; border-color: var(--focus); }
  textarea[aria-invalid=true] { border-color: var(--critical); }
  .hint { margin: 0; font-size: var(--text-xs); line-height: var(--leading-xs); color: var(--text-muted); }
  .error { margin: 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--critical); }
  .error[hidden] { display: none; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); }
  .live { margin: 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  .live:empty { display: none; }
  .result { margin-top: var(--space-2); display: grid; gap: var(--space-1); max-width: 70ch; font-size: var(--text-sm); line-height: var(--leading-sm); }
  .result:focus { outline: none; }
  .result .done { margin: 0; font-weight: var(--weight-semibold); color: var(--text-primary); }
  .result blockquote { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text-primary); overflow-wrap: anywhere; }
  .result .recorded { margin: 0; color: var(--text-secondary); }
`;

/** What the page remembers across a redraw, keyed by item id: whether the box is open, the half-typed comment, and an unblock already sent. */
const memory = { open: new Set<string>(), drafts: new Map<string, string>(), unblocked: new Map<string, string>() };
/** Forget all of it; for tests, which share one module. */
export function forgetBlockedComments(): void { memory.open.clear(); memory.drafts.clear(); memory.unblocked.clear(); }

const EMPTY = 'Write a comment first.';

/**
 * <blocked-comment>: a comment box on one blocked item, behind a "Comment" disclosure. "Unblock" sends the comment and queues the item;
 * "Comment only" records it and leaves the item blocked. Set `.item` (id and text). `locked` (sample data) draws nothing, because there is no server
 * to save to. While a request is in flight it fires `ask-busy` so the page holds its redraws, as an ask card does. `commenter` can be replaced in tests.
 */
export class BlockedCommentElement extends HTMLElement {
  #root: ShadowRoot;
  #item: { id: string; text: string } | null = null;
  #locked = false;
  commenter: { send(req: CommentRequest): Promise<CommentOutcome> } = createCommenter();

  constructor() {
    super();
    this.#root = shadow(this, CSS);
  }

  get item(): { id: string; text: string } | null { return this.#item; }
  set item(v: { id: string; text: string } | null) { this.#item = v; this.#render(); }

  get locked(): boolean { return this.#locked; }
  set locked(v: boolean) { this.#locked = v; this.#render(); }

  #render(): void {
    const item = this.#item;
    if (!item || this.#locked) { this.#root.replaceChildren(); return; }
    const uid = `bc-${item.id}`;
    const toggle = h('button', { type: 'button', class: 'toggle', 'aria-expanded': 'false', 'aria-controls': `${uid}-f`, 'aria-label': `Comment on blocked item ${item.id}` }, 'Comment');
    const field = h('textarea', { id: `${uid}-t`, rows: '2', 'aria-describedby': `${uid}-h` });
    field.value = memory.drafts.get(item.id) ?? '';
    const hint = h('p', { class: 'hint', id: `${uid}-h` }, 'Unblock queues the item with your comment on it. Comment only keeps it blocked. Ctrl or Cmd Enter unblocks.');
    const error = h('p', { class: 'error', id: `${uid}-e`, role: 'alert', hidden: true }, EMPTY);
    const live = h('p', { class: 'live', role: 'status' });
    const both = { type: 'button', 'aria-describedby': `${uid}-h` };
    const unblock = h('button', { ...both, class: 'primary' }, 'Unblock');
    const only = h('button', { ...both, class: 'secondary' }, 'Comment only');
    const form = h('div', { class: 'form', id: `${uid}-f`, hidden: true },
      h('label', { for: `${uid}-t` }, `Comment on ${item.id}: what unblocks it`),
      field, hint, error, h('div', { class: 'actions' }, unblock, only), live);

    const setOpen = (open: boolean): void => {
      toggle.setAttribute('aria-expanded', String(open));
      form.hidden = !open;
      if (open) memory.open.add(item.id); else memory.open.delete(item.id);
    };
    toggle.addEventListener('click', () => { const open = form.hasAttribute('hidden'); setOpen(open); if (open) field.focus(); });

    const describedBy = field.getAttribute('aria-describedby') ?? '';
    const showError = (on: boolean, message = EMPTY): void => {
      error.textContent = message;
      error.hidden = !on;
      if (on) {
        field.setAttribute('aria-invalid', 'true');
        field.setAttribute('aria-errormessage', error.id);
        field.setAttribute('aria-describedby', `${describedBy} ${error.id}`);
      } else {
        field.removeAttribute('aria-invalid');
        field.removeAttribute('aria-errormessage');
        field.setAttribute('aria-describedby', describedBy);
      }
    };
    field.addEventListener('input', () => {
      if (field.value === '') memory.drafts.delete(item.id); else memory.drafts.set(item.id, field.value);
      if (!error.hidden) showError(false);
    });

    const busy = (on: boolean): void => {
      unblock.toggleAttribute('disabled', on);
      only.toggleAttribute('disabled', on);
      this.dispatchEvent(new CustomEvent<AskBusyDetail>('ask-busy', { detail: { busy: on }, bubbles: true, composed: true }));
    };
    const settled = (comment: string, focus: boolean): void => {
      const head = h('p', { class: 'done', id: `${uid}-d` }, 'Unblocked. Queued with your comment.');
      const result = h('div', { class: 'result', role: 'status', tabindex: '-1', 'aria-labelledby': `${uid}-d`, 'aria-describedby': `${uid}-q` },
        head, h('blockquote', { id: `${uid}-q` }, comment),
        h('p', { class: 'recorded' }, 'Recorded in the ledger. It leaves Blocked on the next update and the next free agent picks it up.'));
      form.replaceWith(result);
      toggle.hidden = true;
      if (focus) result.focus();
    };
    let pending = false;
    const send = async (mode: CommentRequest['mode']): Promise<void> => {
      if (pending) return;   // a second press or keystroke while the first is in flight sends nothing
      const comment = field.value.trim();
      if (!comment) { showError(true); field.focus(); return; }
      pending = true;
      busy(true);
      const out = await this.commenter.send({ id: item.id, mode, comment });
      pending = false;
      if (out.ok && mode === 'unblock') {
        memory.unblocked.set(item.id, out.comment);
        memory.drafts.delete(item.id);
        settled(out.comment, true);
      } else if (out.ok) {
        memory.drafts.delete(item.id);
        field.value = '';
        live.textContent = out.same ? `Comment already saved: ${out.comment}` : `Comment saved: ${out.comment}. The item is still blocked.`;
      } else {
        showError(true, out.message);
        live.textContent = '';
      }
      busy(false);
      if (!out.ok && out.closed) { unblock.setAttribute('disabled', ''); only.setAttribute('disabled', ''); }
    };
    unblock.addEventListener('click', () => { void send('unblock'); });
    only.addEventListener('click', () => { void send('comment'); });
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send('unblock'); }
      else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); toggle.focus(); }
    });

    this.#root.replaceChildren(h('div', { class: 'box' }, toggle, form));   // in the tree before any state is restored, so `settled` can swap the form out
    const prior = memory.unblocked.get(item.id);
    if (prior !== undefined) settled(prior, false);   // rebuilt by a live update before the item left Blocked: stay settled, take no focus
    else if (memory.open.has(item.id) || field.value !== '') setOpen(true);
  }
}

customElements.define('blocked-comment', BlockedCommentElement);

declare global { interface HTMLElementTagNameMap { 'blocked-comment': BlockedCommentElement } }
