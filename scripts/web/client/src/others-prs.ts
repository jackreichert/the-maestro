import { BASE_CSS, UI_CSS, h, shadow } from './dom.ts';
import { ago } from './glance.ts';
import { linkAttrs } from './link-policy.ts';
import { waiting } from './drafts-model.ts';
import type { DraftRow } from './drafts-model.ts';
import type { OthersPrRow } from './types.ts';
import type { OthersPrsModel } from './others-prs-store.ts';

/** What the row needs from the draft queue: the waiting review drafts, and a way to draw the existing queue for some of them. */
export interface OthersDrafts { rows: DraftRow[] | null; queue(match: (d: DraftRow) => boolean, empty: string, quiet: boolean): Node }

const CSS = `${BASE_CSS}${UI_CSS}
  :host { display: block; }
  .status { margin: 0 0 var(--space-4); font-size: var(--text-sm); color: var(--text-secondary); }
  .status.bad { color: var(--critical); }
  ul.prs { list-style: none; margin: 0; padding: 0; border-top: var(--hairline); }
  li.pr { display: grid; gap: var(--space-2); padding: var(--space-4) 0; border-bottom: var(--hairline); min-width: 0; }
  li.pr h3 { margin: 0; font-size: var(--text-md); font-weight: var(--weight-semibold); overflow-wrap: anywhere; }
  li.pr h3 .ref { margin-right: var(--space-2); font-family: var(--font-mono); font-weight: var(--weight-regular); }
  .meta { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); font-size: var(--text-sm); color: var(--text-secondary); }
  .chips { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  h3.orphans { margin: var(--space-6) 0 var(--space-2); font-size: var(--text-md); font-weight: var(--weight-semibold); }
`;

const key = (repo: string, n: number): string => `${repo}#${n}`;
const REVIEW: Record<OthersPrRow['review'], { glyph: string; word: string; tone: string }> = {
  'review-required': { glyph: '?', word: 'Review required', tone: '' },
  approved: { glyph: '+', word: 'Approved', tone: 'good' },
  'changes-requested': { glyph: '!', word: 'Changes requested', tone: 'bad' },
};

/**
 * <others-prs>: every open teammate PR, newest activity first, each with the facts a reviewer scans (who, where, how old, whether you were asked,
 * review state, threads) and its review-draft status. A PR with a waiting draft shows the existing draft card (Approve, Edit, Reject) under its row;
 * nothing here posts. Drafts on a PR that is no longer listed keep their cards below, so no draft is ever hidden. Everything is set as text.
 */
export class OthersPrs extends HTMLElement {
  #root: ShadowRoot;
  #model: OthersPrsModel | null = null;
  #drafts: OthersDrafts | null = null;
  #now = '';

  constructor() { super(); this.#root = shadow(this, CSS); }

  set model(m: OthersPrsModel | null) { this.#model = m; if (this.isConnected) this.#render(); }
  set drafts(d: OthersDrafts) { this.#drafts = d; if (this.isConnected) this.#render(); }
  connectedCallback(): void { this.#render(); }

  #render(): void {
    const m = this.#model;
    if (!m || !m.loaded) { this.#root.replaceChildren(h('p', { class: 'empty' }, 'Loading teammates\' PRs.')); return; }
    if (!m.data) { this.#root.replaceChildren(h('p', { class: 'empty' }, 'The list of teammates\' PRs is not available from this page.')); return; }
    this.#now = m.data.generatedAt;
    const d = m.data;
    const byPr = new Map<string, DraftRow[]>();
    for (const r of this.#drafts?.rows ?? []) byPr.set(key(r.repo, r.pr), [...(byPr.get(key(r.repo, r.pr)) ?? []), r]);
    const listed = new Set(d.prs.map((p) => key(p.repo, p.number)));
    const when = d.prData.fetchedAt ? `List read ${ago(d.prData.fetchedAt, d.generatedAt)} ago${d.prData.stale ? ' (older than expected)' : ''}.` : 'The list has not been read yet. It fills in when the next page refresh runs.';
    const hasOrphans = [...byPr].some(([k, rows]) => !listed.has(k) && rows.some(waiting));
    this.#root.replaceChildren(
      h('p', { class: `status${d.prData.failure ? ' bad' : ''}`, role: 'status' }, `${d.total} open ${d.total === 1 ? 'PR' : 'PRs'} by teammates. ${when}`, d.prData.failure ? ` The last read failed (${d.prData.failure}); this is the last good list.` : ''),
      d.prs.length ? h('ul', { class: 'prs', role: 'list', 'aria-label': 'Open teammate PRs' }, ...d.prs.map((p) => this.#row(p, byPr.get(key(p.repo, p.number)) ?? []))) : h('p', { class: 'empty' }, 'No teammate PR is open.'),
      ...(this.#drafts ? [...(hasOrphans ? [h('h3', { class: 'orphans' }, 'Drafts on PRs not listed above')] : []), this.#drafts.queue((x) => !listed.has(key(x.repo, x.pr)), '', false)] : []));
  }

  #row(p: OthersPrRow, drafts: DraftRow[]): HTMLElement {
    const ref = key(p.repo, p.number);
    const link = linkAttrs(p.url);
    const open = drafts.filter(waiting);
    const rv = REVIEW[p.review];
    const draftChip = open.length
      ? h('span', { class: 'chip good' }, h('span', { 'aria-hidden': 'true' }, '> '), `Draft ready${open.length > 1 ? ` (${open.length})` : ''}`)
      : h('span', { class: 'chip' }, 'No draft yet');
    return h('li', { class: 'pr', 'data-pr': ref },
      h('h3', {}, link ? h('a', { ...link, class: 'ref', 'aria-label': `${ref}, open on GitHub` }, ref) : h('span', { class: 'ref' }, ref), p.title),
      h('div', { class: 'meta' },
        h('span', {}, `Author ${p.author}`), h('span', {}, `Into ${p.base || 'unknown'}`),
        h('span', {}, `Updated ${ago(p.updatedAt, this.#now) || 'at an unknown time'}${ago(p.updatedAt, this.#now) ? ' ago' : ''}`),
        ...(p.ageDays !== undefined ? [h('span', {}, `Open ${p.ageDays} d`)] : [])),
      h('div', { class: 'chips' },
        h('span', { class: `chip ${p.youAsked ? 'good' : ''}` }, p.youAsked ? 'You are a requested reviewer' : 'You are not a requested reviewer'),
        h('span', { class: `chip ${rv.tone}` }, h('span', { 'aria-hidden': 'true' }, `${rv.glyph} `), rv.word),
        h('span', { class: `chip ${p.copilotThreads > 0 ? 'bad' : ''}` }, `Copilot threads open: ${p.copilotThreads}`),
        h('span', { class: 'chip' }, `Threads open: ${p.unresolved}`),
        draftChip),
      ...(open.length && this.#drafts ? [this.#drafts.queue((x) => x.repo === p.repo && x.pr === p.number, '', true)] : []));
  }
}

if (!customElements.get('others-prs')) customElements.define('others-prs', OthersPrs);
declare global { interface HTMLElementTagNameMap { 'others-prs': OthersPrs } }
