import { BASE_CSS, UI_CSS, h, shadow } from './dom.ts';
import { ago } from './glance.ts';
import { linkAttrs } from './link-policy.ts';
import { waiting } from './drafts-model.ts';
import type { DraftRow } from './drafts-model.ts';
import { PAGE_SIZE, pagePlan } from './others-paging.ts';
import { SUBTABS, classify } from './others-class.ts';
import type { SubTab } from './others-class.ts';
import type { OthersPrRow } from './types.ts';
import type { OthersPrsModel } from './others-prs-store.ts';

/** What the row needs from the draft queue: the waiting review drafts, and a way to draw the existing queue for some of them. */
export interface OthersDrafts { rows: DraftRow[] | null; queue(match: (d: DraftRow) => boolean, empty: string, quiet: boolean, authorOf: (d: DraftRow) => string | undefined): Node }

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
  .tabs { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0 0 var(--space-4); border-bottom: var(--hairline); }
  button.tab { font: inherit; font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-secondary); min-height: 32px; padding: 0 var(--space-3); border: 0; border-bottom: 2px solid transparent; background: none; cursor: pointer; font-variant-numeric: tabular-nums; }
  button.tab.muted { font-weight: var(--weight-regular); }
  button.tab[aria-selected="true"] { color: var(--text-primary); border-bottom-color: var(--accent); }
  button.tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .pager { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); margin: var(--space-4) 0; }
  .count-line { margin: 0; font-size: var(--text-sm); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
  button.more-prs { font: inherit; font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-primary); min-height: 32px; padding: 0 var(--space-3); border: var(--hairline-strong); border-radius: var(--radius-sm); background: var(--surface-1); cursor: pointer; }
  @media (hover: hover) { button.more-prs:hover { background: var(--surface-2); } }
  [role=tabpanel]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  li.pr:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  h3.orphans { margin: var(--space-6) 0 var(--space-2); font-size: var(--text-md); font-weight: var(--weight-semibold); }
`;

const key = (repo: string, n: number): string => `${repo}#${n}`;
/** The author's name where GitHub gave one, else the login. */
const who = (p: OthersPrRow): string => p.authorName ? `${p.authorName} (${p.author})` : p.author;
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
  #sig = '';
  #tab: SubTab = 'ready';
  #pages: Partial<Record<SubTab, number>> = {};
  #focusTab: SubTab | null = null;
  #focusKey: string | null = null;
  #focusRow: HTMLElement | null = null;
  readonly #status = h('p', { class: 'status', role: 'status' });
  /** The visible count, and a hidden live region that outlives every redraw (a live region that is removed and re-added is not reliably announced). */
  readonly #count = h('p', { class: 'count-line' });
  readonly #announce = h('p', { class: 'vh', role: 'status' });
  readonly #view = h('div', { class: 'view' });

  constructor() { super(); this.#root = shadow(this, CSS); this.#root.append(this.#announce, this.#view); }

  set model(m: OthersPrsModel | null) { this.#model = m; if (this.isConnected) this.#render(); }
  set drafts(d: OthersDrafts) { this.#drafts = d; if (this.isConnected) this.#render(); }
  connectedCallback(): void { this.#render(); }

  #render(): void {
    const m = this.#model;
    // Only a change in what the rows say redraws them: the draft cards inside follow the store on their own, so a keystroke-level or button-state change never rebuilds 340 rows under the person's focus.
    const sig = `${m?.loaded ? m.data?.generatedAt ?? 'none' : 'loading'}|${(this.#drafts?.rows ?? []).filter(waiting).map((d) => d.id).sort().join(',')}|${this.#drafts ? 'q' : ''}|${this.#tab}|${this.#pages[this.#tab] ?? 0}`;
    if (sig === this.#sig && this.#view.childElementCount > 0) return;
    this.#sig = sig;
    if (!m || !m.loaded) { this.#view.replaceChildren(h('p', { class: 'empty' }, 'Loading teammates\' PRs.')); return; }
    if (!m.data) { this.#view.replaceChildren(h('p', { class: 'empty' }, 'The list of teammates\' PRs is not available from this page.')); return; }
    this.#now = m.data.generatedAt;
    const d = m.data;
    const byPr = new Map<string, DraftRow[]>();
    for (const r of this.#drafts?.rows ?? []) byPr.set(key(r.repo, r.pr), [...(byPr.get(key(r.repo, r.pr)) ?? []), r]);
    const listed = new Set(d.prs.map((p) => key(p.repo, p.number)));
    const names = new Map(d.prs.map((p) => [key(p.repo, p.number), who(p)] as const));
    const authorOf = (x: DraftRow): string | undefined => x.author ?? names.get(key(x.repo, x.pr));
    const when = d.prData.fetchedAt ? `List read ${ago(d.prData.fetchedAt, d.generatedAt)} ago${d.prData.stale ? ' (older than expected)' : ''}.` : 'The list has not been read yet. It fills in when the next page refresh runs.';
    const hasOrphans = [...byPr].some(([k, rows]) => !listed.has(k) && rows.some(waiting));
    this.#view.replaceChildren(
      this.#statusLine(`${d.total} open ${d.total === 1 ? 'PR' : 'PRs'} by teammates. ${when}${d.prData.failure ? ` The last read failed (${d.prData.failure}); this is the last good list.` : ''}`, !!d.prData.failure),
      ...(d.prs.length ? this.#tabbed(d.prs, byPr) : [h('p', { class: 'empty' }, 'No teammate PR is open.')]),
      ...(this.#drafts ? [...(hasOrphans ? [h('h3', { class: 'orphans' }, 'Drafts on PRs not listed above')] : []), this.#drafts.queue((x) => !listed.has(key(x.repo, x.pr)), '', false, authorOf)] : []));
    if (this.#focusTab) { this.#root.querySelector<HTMLElement>(`button.tab[data-tab="${this.#focusTab}"]`)?.focus(); this.#focusTab = null; }
    if (this.#focusRow) { this.#focusRow.setAttribute('tabindex', '-1'); this.#focusRow.focus(); this.#focusRow = null; }
  }

  /**
   * Five sub-tabs over the one list: each PR is in exactly one (see others-class.ts), the count is on every label, and Ready for approval opens first. Within a tab the
   * longest-waiting person leads, so the most blocked is at the top; rows that need you stay above the paging.
   */
  #tabbed(prs: OthersPrRow[], byPr: Map<string, DraftRow[]>): Node[] {
    const groups = new Map<SubTab, { p: OthersPrRow; reasons: string[] }[]>(SUBTABS.map((t) => [t.id, []] as const));
    for (const p of prs) { const c = classify(p, (byPr.get(key(p.repo, p.number)) ?? []).some(waiting)); groups.get(c.tab)?.push({ p, reasons: c.reasons }); }
    const since = (x: { p: OthersPrRow }): number => { const t = Date.parse(x.p.askedAt ?? ''); return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY; };
    for (const g of groups.values()) g.sort((a, b) => { const x = since(a); const y = since(b); return x === y ? 0 : x < y ? -1 : 1; });
    const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Teammate PRs by state' }, ...SUBTABS.map((t) => {
      const on = t.id === this.#tab;
      const b = h('button', { type: 'button', role: 'tab', id: `tab-${t.id}`, 'data-tab': t.id, 'aria-selected': on ? 'true' : 'false', 'aria-controls': 'panel', tabindex: on ? '0' : '-1', class: `tab${t.id === 'stale' ? ' muted' : ''}` }, `${t.label} (${groups.get(t.id)?.length ?? 0})`);
      b.addEventListener('click', () => this.#select(t.id, true));
      b.addEventListener('keydown', (e) => this.#arrow(e as KeyboardEvent));
      return b;
    }));
    const def = SUBTABS.find((t) => t.id === this.#tab) ?? SUBTABS[0]!;
    const rows = groups.get(def.id) ?? [];
    const panel = h('div', { role: 'tabpanel', id: 'panel', 'aria-labelledby': `tab-${def.id}`, ...(rows.length ? {} : { tabindex: '0' }) }, ...(rows.length ? this.#list(def.id, rows, byPr) : [h('p', { class: 'empty' }, def.empty)]));
    return [tabs, panel];
  }

  #select(id: SubTab, focus = false): void {
    if (id === this.#tab) return;
    this.#tab = id;
    if (focus) this.#focusTab = id;
    this.#render();
  }

  /** Arrow keys, Home and End move between tabs and select as they go (the tablist pattern). */
  #arrow(e: KeyboardEvent): void {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const at = SUBTABS.findIndex((t) => t.id === this.#tab);
    const to = e.key === 'ArrowRight' ? (at + 1) % SUBTABS.length : e.key === 'ArrowLeft' ? (at + SUBTABS.length - 1) % SUBTABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? SUBTABS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    this.#select(SUBTABS[to]!.id, true);
  }

  /**
   * The rows of one tab: those that need you (a waiting draft, a review asked of you) first and always, then the rest 25 at a time. The count line is one live
   * region kept across redraws, and Load more moves focus to the first row it added, so a keyboard user lands where the new rows begin.
   */
  #list(tab: SubTab, items: { p: OthersPrRow; reasons: string[] }[], byPr: Map<string, DraftRow[]>): Node[] {
    const waitingOn = (x: { p: OthersPrRow }): boolean => x.p.youAsked || (byPr.get(key(x.p.repo, x.p.number)) ?? []).some(waiting);
    const pages = this.#pages[tab] ?? 0;
    const plan = pagePlan(items, waitingOn, pages);
    const ul = h('ul', { class: 'prs', role: 'list', 'aria-label': 'Open teammate PRs' }, ...plan.shown.map((x) => this.#row(x.p, byPr.get(key(x.p.repo, x.p.number)) ?? [], tab, x.reasons)));
    const text = `Showing ${plan.shown.length} of ${plan.total}`;
    if (this.#count.textContent !== text) this.#count.textContent = text;
    const said = `${text} in ${SUBTABS.find((t) => t.id === tab)?.label ?? ''}`;
    if (this.#announce.textContent !== said) this.#announce.textContent = said;
    const more = plan.hidden > 0 ? h('button', { type: 'button', class: 'more-prs' }, `Load more (${Math.min(PAGE_SIZE, plan.hidden)} of ${plan.hidden} left)`) : null;
    more?.addEventListener('click', () => {
      const at = plan.shown.length;
      this.#pages[tab] = pages + 1;
      const next = pagePlan(items, waitingOn, pages + 1).shown[at];
      this.#focusKey = next ? key(next.p.repo, next.p.number) : null;
      this.#render();
    });
    this.#focusRow = this.#focusKey ? [...ul.querySelectorAll<HTMLElement>('li.pr')].find((li) => li.getAttribute('data-pr') === this.#focusKey) ?? null : null;
    this.#focusKey = null;
    return [ul, h('div', { class: 'pager' }, this.#count, ...(more ? [more] : []))];
  }

  /** One live region kept across redraws, its text set only when it changes, so a screen reader hears a change and not every redraw. */
  #statusLine(text: string, bad: boolean): HTMLElement {
    if (this.#status.textContent !== text) this.#status.textContent = text;
    this.#status.className = `status${bad ? ' bad' : ''}`;
    return this.#status;
  }

  #row(p: OthersPrRow, drafts: DraftRow[], tab: SubTab, reasons: string[]): HTMLElement {
    const ref = key(p.repo, p.number);
    const link = linkAttrs(p.url);
    const open = drafts.filter(waiting);
    const rv = REVIEW[p.review];
    const draftChip = open.length
      ? h('span', { class: 'chip good' }, h('span', { 'aria-hidden': 'true' }, '> '), `Draft ready${open.length > 1 ? ` (${open.length})` : ''}`)
      : h('span', { class: 'chip' }, 'No draft yet');
    return h('li', { class: 'pr', 'data-pr': ref },
      h('h3', {}, link ? h('a', { ...link, class: 'ref' }, ref) : h('span', { class: 'ref' }, ref), h('span', { class: 'by' }, `by ${who(p)} `), p.title),
      h('div', { class: 'meta' },
        h('span', {}, `Into ${p.base || 'unknown'}`),
        h('span', {}, `Updated ${ago(p.updatedAt, this.#now) || 'at an unknown time'}${ago(p.updatedAt, this.#now) ? ' ago' : ''}`),
        ...(p.ageDays !== undefined ? [h('span', {}, `Open ${p.ageDays} d`)] : [])),
      h('div', { class: 'chips' },
        h('span', { class: `chip ${p.youAsked ? 'good' : ''}` }, p.youAsked ? 'You are a requested reviewer' : 'You are not a requested reviewer'),
        h('span', { class: `chip ${rv.tone}` }, h('span', { 'aria-hidden': 'true' }, `${rv.glyph} `), h('span', { class: 'vh' }, 'Review: '), rv.word),
        h('span', { class: `chip ${p.copilotThreads > 0 ? 'bad' : ''}` }, `Copilot threads open: ${p.copilotThreads}`),
        h('span', { class: 'chip' }, `Threads open: ${p.unresolved}`),
        ...(p.askedAt ? [h('span', { class: `chip ${tab === 'stale' ? 'warn' : ''}` }, tab === 'stale' ? `Last ask ${ago(p.askedAt, this.#now)}${ago(p.askedAt, this.#now) === 'just now' ? '' : ' ago'}` : `Waiting ${ago(p.askedAt, this.#now)}`)] : []),
        ...(tab === 'stale' && p.staleWhy ? [h('span', { class: 'chip' }, p.staleWhy)] : []),
        ...(tab === 'not-ready' ? reasons.map((r) => h('span', { class: 'chip warn' }, h('span', { 'aria-hidden': 'true' }, '- '), r)) : []),
        ...(p.handsOff ? [h('span', { class: 'chip warn' }, h('span', { 'aria-hidden': 'true' }, '- '), 'Hands off: the repo owner\'s call')] : []),
        draftChip),
      ...(open.length && this.#drafts ? [this.#drafts.queue((x) => x.repo === p.repo && x.pr === p.number, '', true, (x) => x.author ?? who(p))] : []));
  }
}

if (!customElements.get('others-prs')) customElements.define('others-prs', OthersPrs);
declare global { interface HTMLElementTagNameMap { 'others-prs': OthersPrs } }
