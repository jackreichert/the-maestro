import { BASE_CSS, UI_CSS, h, shadow } from './dom.ts';
import { linkAttrs } from './link-policy.ts';
import { unresolved, waiting } from './drafts-model.ts';
import type { DraftRow } from './drafts-model.ts';
import type { DraftsModel } from './drafts-store.ts';

/** What the card's buttons call; the app wires them to the store. */
export interface DraftActions {
  startEdit(id: string): void; startReject(id: string): void; cancel(id: string): void; setBuffer(id: string, text: string): void; setComment(id: string, index: number, text: string): void;
  saveEdit(id: string): void; approve(id: string): void; reject(id: string): void;
}

const CSS = `${BASE_CSS}${UI_CSS}
  :host { display: block; }
  section.pr { margin-top: var(--space-6); }
  section.pr h3, section.pr h4 { margin: 0 0 var(--space-2); font-size: var(--text-md); font-weight: var(--weight-semibold); overflow-wrap: anywhere; }
  ul.drafts { list-style: none; margin: 0; padding: 0; border-top: var(--hairline); }
  li.draft { display: grid; gap: var(--space-2); padding: var(--space-4) 0; border-bottom: var(--hairline); min-width: 0; }
  .meta { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-3); align-items: center; font-size: var(--text-sm); color: var(--text-secondary); }
  .quote { margin: 0; padding-left: var(--space-3); border-left: 2px solid var(--border-strong); color: var(--text-secondary); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--text-md); line-height: var(--leading-md); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
  label { display: grid; gap: var(--space-1); font-size: var(--text-sm); color: var(--text-secondary); }
  textarea, input[type=text] { font: inherit; color: var(--text-primary); background: var(--surface-1); border: var(--hairline-strong); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); width: 100%; }
  textarea { min-height: 7em; resize: vertical; }
  ul.inline { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
  ul.inline li { padding-left: var(--space-3); border-left: 2px solid var(--border-strong); display: grid; gap: 2px; }
  .msg { margin: 0; font-size: var(--text-sm); color: var(--text-secondary); }
  .msg.bad { color: var(--critical); }
  .done { color: var(--text-muted); }
  .empty { margin: 0; padding: var(--space-3) 0; color: var(--text-muted); font-size: var(--text-sm); }
  section.summary { display: grid; gap: var(--space-2); padding: var(--space-3); border: var(--hairline); border-radius: var(--radius-sm); }
  section.summary dl { margin: 0; display: grid; gap: var(--space-2); }
  section.summary dt { font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--text-secondary); }
  section.summary dd { margin: 0; overflow-wrap: anywhere; font-size: var(--text-sm); line-height: var(--leading-md); }
  section.summary ul, section.summary ol { margin: 0; padding-left: var(--space-5); }
  details.finished { margin-top: var(--space-6); }
  details.finished summary { cursor: pointer; font-size: var(--text-sm); color: var(--text-secondary); }
`;

const SEVERITY: Record<DraftRow['severity'], { glyph: string; word: string; tone: string }> = {
  blocking: { glyph: '!', word: 'Blocking', tone: 'bad' },
  suggestion: { glyph: '~', word: 'Suggestion', tone: '' },
  reply: { glyph: '>', word: 'Reply', tone: '' },
  review: { glyph: '>', word: 'Review', tone: '' },
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
  #match: (d: DraftRow) => boolean = () => true;
  #quiet = false;
  #authorOf: (d: DraftRow) => string | undefined = (d) => d.author;

  constructor() { super(); this.#root = shadow(this, CSS); }

  set model(m: DraftsModel | null) { this.#model = m; if (this.isConnected) this.#render(); }
  set sources(s: ReadonlyArray<DraftRow['source']>) { this.#sources = s; }
  set actions(a: DraftActions) { this.#actions = a; }
  /** Which waiting drafts this instance shows (default all). Decided drafts are not filtered. */
  set match(f: (d: DraftRow) => boolean) { this.#match = f; }
  /** Leave out the Decided list: for a card shown inside a PR's own row. */
  /** Whose PR a card is on, as the person's name or login; the default is the draft's own `author`. */
  set authorOf(f: (d: DraftRow) => string | undefined) { this.#authorOf = f; }
  set quiet(q: boolean) { this.#quiet = q; }
  set emptyText(t: string) { this.#empty = t; }
  connectedCallback(): void { this.#render(); }

  #render(): void {
    const m = this.#model;
    if (!m || !m.loaded) { this.#root.replaceChildren(h('p', { class: 'empty' }, 'Loading drafts.')); return; }
    if (!m.data) { this.#root.replaceChildren(h('p', { class: 'empty' }, 'The draft queue is not available from this page.')); return; }
    const mine = m.data.drafts.filter((d) => this.#sources.includes(d.source));
    const open = mine.filter((d) => waiting(d) && this.#match(d));
    const decided = this.#quiet ? [] : mine.filter((d) => !waiting(d));
    const groups = new Map<string, DraftRow[]>();
    for (const d of open) groups.set(groupKey(d), [...(groups.get(groupKey(d)) ?? []), d]);
    this.#root.replaceChildren(
      ...(groups.size === 0 ? (this.#empty ? [h('p', { class: 'empty' }, this.#empty)] : []) : [...groups].map(([key, ds]) => this.#group(key, ds, m))),
      ...(decided.length ? [h('details', { class: 'finished' }, h('summary', {}, `Decided (${decided.length})`), h('ul', { class: 'drafts', role: 'list' }, ...decided.map((d) => this.#decided(d))))] : []));
  }

  #link(d: DraftRow, label: string): Node {
    const attrs = linkAttrs(d.prUrl);
    return attrs ? h('a', attrs, label) : document.createTextNode(label);
  }

  #group(key: string, ds: DraftRow[], m: DraftsModel): HTMLElement {
    // Inside a PR's own row (quiet) the row already names the PR, so the card's heading drops a level and nothing sits at the row's level.
    return h('section', { class: 'pr', 'aria-label': key }, h(this.#quiet ? 'h4' : 'h3', {}, this.#link(ds[0] as DraftRow, key), this.#by(ds[0] as DraftRow)), h('ul', { class: 'drafts', role: 'list' }, ...ds.map((d) => this.#card(d, m))));
  }

  /** " by <author>" beside repo#number, or nothing when nobody is known. */
  #by(d: DraftRow): Node {
    const who = this.#authorOf(d);
    return who ? document.createTextNode(` by ${who}`) : document.createDocumentFragment();
  }

  #head(d: DraftRow): HTMLElement {
    const sev = SEVERITY[d.severity];
    const blocks = d.review?.event === 'REQUEST_CHANGES';
    return h('div', { class: 'meta' },
      h('span', { class: `chip ${d.review ? (blocks ? 'bad' : 'good') : sev.tone}` }, h('span', { 'aria-hidden': 'true' }, `${d.review ? (blocks ? '!' : '+') : sev.glyph} `), d.review ? (blocks ? 'Review: request changes' : 'Review: approve') : sev.word),
      d.where ? h('code', {}, d.where) : null,
      d.replyTo ? h('span', {}, `answering ${d.replyTo}`) : null);
  }

  #decided(d: DraftRow): HTMLElement {
    return h('li', { class: 'draft done' }, h('p', { class: 'meta' }, this.#link(d, groupKey(d)), this.#by(d)), this.#head(d),
      h('p', { class: 'body' }, d.text), this.#inline(d),
      h('p', { class: 'msg' }, `${STATE_WORDS[d.state] ?? d.state}${d.rejectReason ? `: ${d.rejectReason}` : ''}`, ' ', this.#postedLink(d)));
  }

  /** A review's inline comments, each with its file:line and a word for blocking or suggestion. */
  #inline(d: DraftRow): Node {
    const cs = d.review?.comments ?? [];
    return cs.length ? h('ul', { class: 'inline', role: 'list', 'aria-label': 'Inline comments' }, ...cs.map((c) => h('li', {}, h('span', { class: 'meta' }, h('code', {}, `${c.path}:${c.line}`), h('span', { class: `chip ${c.severity === 'blocking' ? 'bad' : ''}` }, c.severity === 'blocking' ? 'Blocking' : 'Suggestion')), h('p', { class: 'body' }, c.text)))) : document.createDocumentFragment();
  }

  /**
   * The review's summary in six parts, always all six: what it does, core logic (links to the lines at the head commit), tests, ticket match,
   * suggestions (numbered, from the inline comments) and the compliment. A draft made before summaries says so instead of showing nothing.
   */
  #summary(d: DraftRow): Node {
    const r = d.review;
    if (!r) return document.createDocumentFragment();
    const c = r.context;
    const part = (title: string, ...body: Node[]): Node[] => [h('dt', {}, title), h('dd', {}, ...body)];
    if (!c) return h('section', { class: 'summary', 'aria-label': 'Review summary' }, h('p', { class: 'msg' }, 'No structured summary was recorded for this draft (it was made before summaries). The full text is below.'));
    const links = c.core.map((k) => { const a = linkAttrs(k.url); const code = h('code', {}, `${k.path}#L${k.start}-L${k.end}`); return h('li', {}, a ? h('a', a, k.label) : document.createTextNode(k.label), ' ', code); });
    const sugg = r.comments.map((x) => h('li', {}, `${x.severity === 'blocking' ? 'Blocking' : 'Non-blocking'}, `, h('code', {}, `${x.path}:${x.line}`), `: ${x.text.replace(/^(Blocking|Suggestion): /, '').replace(/\s+/g, ' ')}`));
    return h('section', { class: 'summary', 'aria-label': 'Review summary' }, h('dl', {},
      ...part('What it does', document.createTextNode(c.summary)),
      ...part('Core logic', links.length ? h('ul', { role: 'list' }, ...links) : document.createTextNode('No core logic links were recorded.')),
      ...part('Tests', document.createTextNode(c.tests)),
      ...part('Ticket match', document.createTextNode(c.ticket)),
      ...part('Suggestions', sugg.length ? h('ol', {}, ...sugg) : document.createTextNode('None.')),
      ...part('Compliment', document.createTextNode(r.compliment))));
  }

  /** The text under the summary: what follows the compliment when the text still carries it (the summary already shows the rest), else all of it. */
  #tail(d: DraftRow): string {
    const r = d.review;
    if (!r?.context) return d.text;
    const at = d.text.indexOf(r.compliment);
    return at >= 0 ? d.text.slice(at + r.compliment.length).trim() : d.text;
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
      const boxes = (d.review?.comments ?? []).map((c, i) => {
        const box = h('textarea', { 'aria-label': `Edit inline comment on ${c.path}:${c.line}` });
        box.value = ui.comments?.[i] ?? c.text;
        box.addEventListener('input', () => a?.setComment(d.id, i, box.value));
        return h('label', {}, `${c.path}:${c.line} (empty it to drop this comment)`, box);
      });
      body = [h('label', {}, 'Your wording (posted exactly as written once you approve it)', ta), ...boxes,
        h('div', { class: 'actions' }, btn('primary', 'Save', `Save edit to comment on ${what}`, () => a?.saveEdit(d.id)), btn('secondary', 'Cancel', 'Cancel edit', () => a?.cancel(d.id)))];
    } else if (ui.mode === 'reject') {
      const input = h('input', { type: 'text', 'aria-label': `Why reject the comment on ${what}`, maxlength: '500' });
      input.value = ui.buffer;
      input.addEventListener('input', () => a?.setBuffer(d.id, input.value));
      body = [h('p', { class: 'body' }, d.text), this.#inline(d), h('label', {}, 'Why? (kept on record; nothing is posted)', input),
        h('div', { class: 'actions' }, btn('secondary', 'Reject', `Confirm reject of comment on ${what}`, () => a?.reject(d.id)), btn('secondary', 'Cancel', 'Cancel reject', () => a?.cancel(d.id)))];
    } else {
      const tail = this.#tail(d);
      body = [this.#summary(d), ...(tail ? [h('p', { class: 'body' }, tail)] : []), this.#inline(d),
        h('div', { class: 'actions' },
          ...(unresolved(d) ? [] : [btn('primary', 'Approve', `Approve and post comment on ${what}`, () => a?.approve(d.id)), ...(d.state === 'approved' ? [] : [btn('secondary', 'Edit', `Edit comment on ${what}`, () => a?.startEdit(d.id))])]),
          btn('secondary', 'Reject', `Reject comment on ${what}`, () => a?.startReject(d.id)))];
    }
    return h('li', { class: 'draft', 'data-id': d.id }, this.#head(d), d.context ? h('p', { class: 'quote' }, d.context) : null, ...body, live);
  }
}

customElements.define('draft-queue', DraftQueue);
declare global { interface HTMLElementTagNameMap { 'draft-queue': DraftQueue } }
