import { BASE_CSS, UI_CSS, h, shadow } from './dom.ts';
import { linkAttrs } from './link-policy.ts';
import { unresolved, waiting } from './drafts-model.ts';
import type { DraftRow } from './drafts-model.ts';
import type { DraftsModel } from './drafts-store.ts';

/** What the card's buttons call; the app wires them to the store. */
export interface DraftActions {
  startEdit(id: string): void; startReject(id: string): void; cancel(id: string): void; setBuffer(id: string, text: string): void;
  saveEdit(id: string): void; approve(id: string): void; reject(id: string): void;
}

const CSS = `${BASE_CSS}${UI_CSS}
  :host { display: block; }
  section.pr { margin-top: var(--space-6); }
  section.pr h3 { margin: 0 0 var(--space-2); font-size: var(--text-md); font-weight: var(--weight-semibold); overflow-wrap: anywhere; }
  ul.drafts { list-style: none; margin: 0; padding: 0; border-top: var(--hairline); }
  li.draft { display: grid; gap: var(--space-2); padding: var(--space-4) 0; border-bottom: var(--hairline); min-width: 0; }
  .meta { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-3); align-items: center; font-size: var(--text-sm); color: var(--text-secondary); }
  .quote { margin: 0; padding-left: var(--space-3); border-left: 2px solid var(--border-strong); color: var(--text-secondary); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--text-md); line-height: var(--leading-md); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
  label { display: grid; gap: var(--space-1); font-size: var(--text-sm); color: var(--text-secondary); }
  textarea, input[type=text] { font: inherit; color: var(--text-primary); background: var(--surface-1); border: var(--hairline-strong); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); width: 100%; }
  textarea { min-height: 7em; resize: vertical; }
  .msg { margin: 0; font-size: var(--text-sm); color: var(--text-secondary); }
  .msg.bad { color: var(--critical); }
  .done { color: var(--text-muted); }
  .empty { margin: 0; padding: var(--space-3) 0; color: var(--text-muted); font-size: var(--text-sm); }
  details.finished { margin-top: var(--space-6); }
  details.finished summary { cursor: pointer; font-size: var(--text-sm); color: var(--text-secondary); }
`;

const SEVERITY: Record<DraftRow['severity'], { glyph: string; word: string; tone: string }> = {
  blocking: { glyph: '!', word: 'Blocking', tone: 'bad' },
  suggestion: { glyph: '~', word: 'Suggestion', tone: '' },
  reply: { glyph: '>', word: 'Reply', tone: '' },
};
const STATE_WORDS: Partial<Record<DraftRow['state'], string>> = {
  approved: 'Approved, posting', posting: 'Posting', posted: 'Posted', rejected: 'Rejected',
  uncertain: 'GitHub did not confirm this one. Check the PR before doing anything else.',
};

const groupKey = (d: DraftRow): string => `${d.repo}#${d.pr}`;

/**
 * <draft-queue>: drafted GitHub comments, grouped by PR, each with Approve, Edit and Reject. Nothing here posts: a press only asks the server,
 * and the server posts through its one approved path. `sources` picks which drafts this instance shows (the Others' PRs tab: review comments;
 * the PRs tab: replies). Posted and rejected drafts fold into a "Decided" list. Everything is set as text.
 */
export class DraftQueue extends HTMLElement {
  #root: ShadowRoot;
  #model: DraftsModel | null = null;
  #sources: ReadonlyArray<DraftRow['source']> = ['review', 'reply'];
  #actions: DraftActions | null = null;
  #empty = 'Nothing is waiting for your approval.';

  constructor() { super(); this.#root = shadow(this, CSS); }

  set model(m: DraftsModel | null) { this.#model = m; if (this.isConnected) this.#render(); }
  set sources(s: ReadonlyArray<DraftRow['source']>) { this.#sources = s; }
  set actions(a: DraftActions) { this.#actions = a; }
  set emptyText(t: string) { this.#empty = t; }
  connectedCallback(): void { this.#render(); }

  #render(): void {
    const m = this.#model;
    if (!m || !m.loaded) { this.#root.replaceChildren(h('p', { class: 'empty' }, 'Loading drafts.')); return; }
    if (!m.data) { this.#root.replaceChildren(h('p', { class: 'empty' }, 'The draft queue is not available from this page.')); return; }
    const mine = m.data.drafts.filter((d) => this.#sources.includes(d.source));
    const open = mine.filter(waiting);
    const decided = mine.filter((d) => !waiting(d));
    const groups = new Map<string, DraftRow[]>();
    for (const d of open) groups.set(groupKey(d), [...(groups.get(groupKey(d)) ?? []), d]);
    this.#root.replaceChildren(
      ...(groups.size === 0 ? [h('p', { class: 'empty' }, this.#empty)] : [...groups].map(([key, ds]) => this.#group(key, ds, m))),
      ...(decided.length ? [h('details', { class: 'finished' }, h('summary', {}, `Decided (${decided.length})`), h('ul', { class: 'drafts', role: 'list' }, ...decided.map((d) => this.#decided(d))))] : []));
  }

  #link(d: DraftRow, label: string): Node {
    const attrs = linkAttrs(d.prUrl);
    return attrs ? h('a', attrs, label) : document.createTextNode(label);
  }

  #group(key: string, ds: DraftRow[], m: DraftsModel): HTMLElement {
    return h('section', { class: 'pr', 'aria-label': key }, h('h3', {}, this.#link(ds[0] as DraftRow, key)), h('ul', { class: 'drafts', role: 'list' }, ...ds.map((d) => this.#card(d, m))));
  }

  #head(d: DraftRow): HTMLElement {
    const sev = SEVERITY[d.severity];
    return h('div', { class: 'meta' },
      h('span', { class: `chip ${sev.tone}` }, h('span', { 'aria-hidden': 'true' }, `${sev.glyph} `), sev.word),
      d.where ? h('code', {}, d.where) : null,
      d.replyTo ? h('span', {}, `answering ${d.replyTo}`) : null);
  }

  #decided(d: DraftRow): HTMLElement {
    return h('li', { class: 'draft done' }, this.#head(d),
      h('p', { class: 'body' }, d.text),
      h('p', { class: 'msg' }, `${STATE_WORDS[d.state] ?? d.state}${d.rejectReason ? `: ${d.rejectReason}` : ''}`, ' ', this.#postedLink(d)));
  }

  #postedLink(d: DraftRow): Node | null {
    const attrs = d.postedUrl ? linkAttrs(d.postedUrl) : null;
    return attrs ? h('a', attrs, 'View on GitHub') : null;
  }

  #card(d: DraftRow, m: DraftsModel): HTMLElement {
    const ui = m.ui[d.id] ?? { mode: 'view' as const, buffer: '', busy: false };
    const a = this.#actions;
    const what = `${groupKey(d)}${d.where ? ` ${d.where}` : ''}`;
    const btn = (cls: string, label: string, aria: string, on: () => void, off = ui.busy): HTMLButtonElement => {
      const b = h('button', { type: 'button', class: cls, 'aria-label': aria, disabled: off }, label);
      b.addEventListener('click', on);
      return b;
    };
    const live = h('p', { class: `msg${ui.message && !/^(Posted|Saved|Rejected)/.test(ui.message) ? ' bad' : ''}`, role: 'status', 'aria-live': 'polite' }, ui.message ?? (unresolved(d) ? (STATE_WORDS[d.state] ?? '') : d.state === 'failed' && d.error ? `GitHub refused the last attempt: ${d.error}. Nothing was posted.` : ''));
    let body: Node[];
    if (ui.mode === 'edit') {
      const ta = h('textarea', { 'aria-label': `Edit comment on ${what}`, maxlength: '4000' });
      ta.value = ui.buffer;
      ta.addEventListener('input', () => a?.setBuffer(d.id, ta.value));
      body = [h('label', {}, 'Your wording (posted exactly as written once you approve it)', ta),
        h('div', { class: 'actions' }, btn('primary', 'Save', `Save edit to comment on ${what}`, () => a?.saveEdit(d.id)), btn('secondary', 'Cancel', 'Cancel edit', () => a?.cancel(d.id)))];
    } else if (ui.mode === 'reject') {
      const input = h('input', { type: 'text', 'aria-label': `Why reject the comment on ${what}`, maxlength: '500' });
      input.value = ui.buffer;
      input.addEventListener('input', () => a?.setBuffer(d.id, input.value));
      body = [h('p', { class: 'body' }, d.text), h('label', {}, 'Why? (kept on record; nothing is posted)', input),
        h('div', { class: 'actions' }, btn('secondary', 'Reject', `Confirm reject of comment on ${what}`, () => a?.reject(d.id)), btn('secondary', 'Cancel', 'Cancel reject', () => a?.cancel(d.id)))];
    } else {
      body = [h('p', { class: 'body' }, d.text),
        h('div', { class: 'actions' },
          ...(unresolved(d) ? [] : [btn('primary', 'Approve', `Approve and post comment on ${what}`, () => a?.approve(d.id)), btn('secondary', 'Edit', `Edit comment on ${what}`, () => a?.startEdit(d.id))]),
          btn('secondary', 'Reject', `Reject comment on ${what}`, () => a?.startReject(d.id)))];
    }
    return h('li', { class: 'draft', 'data-id': d.id }, this.#head(d), d.context ? h('p', { class: 'quote' }, d.context) : null, ...body, live);
  }
}

customElements.define('draft-queue', DraftQueue);
declare global { interface HTMLElementTagNameMap { 'draft-queue': DraftQueue } }
