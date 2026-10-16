import { BASE_CSS, UI_CSS, h, shadow } from './dom.ts';
import { TACET_CSS, tacet } from './score.ts';
import { ago, agoHours } from './glance.ts';
import { linkAttrs } from './link-policy.ts';
import { waiting } from './drafts-model.ts';
import type { DraftRow } from './drafts-model.ts';
import { pagePlan } from './others-paging.ts';
import { pager } from './pager.ts';
import { SUBTABS, classify } from './others-class.ts';
import type { SubTab } from './others-class.ts';
import type { OthersPrRow } from './types.ts';
import type { OthersPrsModel } from './others-prs-store.ts';
import type { OthersOp, OthersOutcome } from './others-api.ts';

/** What the row needs from the draft queue: the waiting review drafts, and a way to draw the existing queue for some of them. */
export interface OthersDrafts { rows: DraftRow[] | null; queue(match: (d: DraftRow) => boolean, empty: string, quiet: boolean, authorOf: (d: DraftRow) => string | undefined): Node }

/** What the row's buttons call: one write for one PR (see others-api.ts); null when it went through, else the words to show. The app reloads the list on success. */
export interface OthersActions { run(op: OthersOp, p: OthersPrRow): Promise<OthersOutcome> }

const CSS = `${BASE_CSS}${UI_CSS}${TACET_CSS}
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
  [role=tabpanel]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  li.pr:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .actions { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
  details.ignored { margin: var(--space-4) 0 0; }
  details.ignored summary { cursor: pointer; font-size: var(--text-sm); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
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
  /** The page each sub-tab is on (1-based). */
  #pages: Partial<Record<SubTab, number>> = {};
  #focusTab: SubTab | null = null;
  #focusPager: string | null = null;
  /** A draft id the page was asked to open (the Home cue's link): its PR's sub-tab is selected once and its card scrolled to and focused. */
  #focusDraft: string | null = null;
  #focusDone: string | null = null;
  #focusOpened: string | null = null;
  #actions: OthersActions | null = null;
  /** Whether the Ignored list is open, which PRs have a write in flight, and the words for the last refused one. */
  #showIgnored = false;
  readonly #busy = new Set<string>();
  readonly #notes = new Map<string, string>();
  /** Bumped when a write starts or ends, so the rows redraw (a write changes nothing the signature otherwise reads). */
  #ver = 0;
  readonly #status = h('p', { class: 'status', role: 'status' });
  /** A hidden live region that outlives every redraw (a live region that is removed and re-added is not reliably announced). */
  readonly #announce = h('p', { class: 'vh', role: 'status' });
  /** A second hidden live region for what a write did, so the page-range text redrawing over it does not swallow the announcement. */
  readonly #said = h('p', { class: 'vh', role: 'status', 'data-said': '' });
  readonly #view = h('div', { class: 'view' });

  constructor() { super(); this.#root = shadow(this, CSS); this.#root.append(this.#announce, this.#said, this.#view); }

  set model(m: OthersPrsModel | null) { this.#model = m; if (this.isConnected) this.#render(); }
  set focusDraft(id: string | null) { this.#focusDraft = id; this.#sig = ''; if (this.isConnected) this.#render(); }
  set actions(a: OthersActions) { this.#actions = a; }
  set drafts(d: OthersDrafts) { this.#drafts = d; if (this.isConnected) this.#render(); }
  connectedCallback(): void { this.#render(); }

  /** What the rows say: a change in it redraws them. */
  #signature(): string {
    const m = this.#model;
    const acts = (m?.data?.prs ?? []).filter((p) => p.ignored || p.reviewRequested).map((p) => `${key(p.repo, p.number)}:${p.ignored ?? ''}${p.reviewRequested ? 'r' : ''}`).join(',');
    return `${m?.loaded ? m.data?.generatedAt ?? 'none' : 'loading'}|${acts}|${this.#ver}|${this.#showIgnored ? 'i' : ''}|${(this.#drafts?.rows ?? []).filter(waiting).map((d) => d.id).sort().join(',')}|${this.#drafts ? 'q' : ''}|${this.#tab}|${this.#pages[this.#tab] ?? 0}|${this.#focusDraft ?? ''}`;
  }

  #render(): void {
    const m = this.#model;
    // Only a change in what the rows say redraws them: the draft cards inside follow the store on their own, so a keystroke-level or button-state change never rebuilds 340 rows under the person's focus.
    const sig = this.#signature();
    if (sig === this.#sig && this.#view.childElementCount > 0) return;
    this.#sig = sig;
    if (!m || !m.loaded) { this.#view.replaceChildren(h('p', { class: 'empty' }, 'Loading teammates\' PRs.')); return; }
    if (!m.data) { this.#view.replaceChildren(h('p', { class: 'empty' }, 'The list of teammates\' PRs is not available from this page.')); return; }
    this.#now = m.data.generatedAt;
    const d = m.data;
    const byPr = new Map<string, DraftRow[]>();
    for (const r of this.#drafts?.rows ?? []) byPr.set(key(r.repo, r.pr), [...(byPr.get(key(r.repo, r.pr)) ?? []), r]);
    const listed = new Set(d.prs.filter((p) => p.ignored !== 'ignored').map((p) => key(p.repo, p.number)));
    this.#openFocused(d.prs, byPr);
    const names = new Map(d.prs.map((p) => [key(p.repo, p.number), who(p)] as const));
    const authorOf = (x: DraftRow): string | undefined => x.author ?? names.get(key(x.repo, x.pr));
    const when = d.prData.fetchedAt ? `List read ${ago(d.prData.fetchedAt, d.generatedAt)} ago${d.prData.stale ? ' (older than expected)' : ''}.` : 'The list has not been read yet. It fills in when the next page refresh runs.';
    const hasOrphans = [...byPr].some(([k, rows]) => !listed.has(k) && rows.some(waiting));
    this.#view.replaceChildren(
      this.#statusLine(`${d.total} open ${d.total === 1 ? 'PR' : 'PRs'} by teammates. ${when}${d.prData.failure ? ` The last read failed (${d.prData.failure}); this is the last good list.` : ''}`, !!d.prData.failure),
      ...this.#waitingNote(d.prs, byPr),
      ...(d.prs.length ? this.#tabbed(d.prs, byPr) : [tacet('No teammate PR is open.', 'tacet')]),
      ...this.#ignoredList(d.prs),
      ...(this.#drafts ? [...(hasOrphans ? [h('h3', { class: 'orphans' }, 'Drafts on PRs not listed above')] : []), this.#drafts.queue((x) => !listed.has(key(x.repo, x.pr)), '', false, authorOf)] : []));
    this.#revealFocused();
    if (this.#focusTab) { this.#root.querySelector<HTMLElement>(`button.tab[data-tab="${this.#focusTab}"]`)?.focus(); this.#focusTab = null; }
    if (this.#focusPager) { this.#root.querySelector<HTMLElement>(`nav.pager [data-dir=${this.#focusPager}]`)?.focus(); this.#focusPager = null; }
  }

  /** Selects the sub-tab of the PR that holds the asked-for draft, once per draft, before the rows are drawn. */
  #openFocused(prs: OthersPrRow[], byPr: Map<string, DraftRow[]>): void {
    const id = this.#focusDraft;
    if (!id || this.#focusOpened === id) return;
    this.#focusOpened = id;
    const row = [...byPr.values()].flat().find((r) => r.id === id);
    const p = row ? prs.find((x) => x.repo === row.repo && x.number === row.pr) : undefined;
    if (p) { this.#tab = classify(p, (byPr.get(key(p.repo, p.number)) ?? []).some(waiting)).tab; this.#sig = this.#signature(); }
  }

  /** Scrolls to and focuses the asked-for draft's card (inside its PR row, or under "Drafts on PRs not listed above"), once. */
  #revealFocused(): void {
    const id = this.#focusDraft;
    if (!id || this.#focusDone === id) return;
    for (const q of this.#root.querySelectorAll('draft-queue')) {
      const card = q.shadowRoot?.querySelector<HTMLElement>(`li.draft[data-id="${id}"]`);
      if (!card) continue;
      card.setAttribute('tabindex', '-1');
      card.scrollIntoView?.({ block: 'center' });
      card.focus();
      this.#focusDone = id;
      return;
    }
  }

  /**
   * Five sub-tabs over the one list: each PR is in exactly one (see others-class.ts), the count is on every label, and Ready for approval opens first. Within a tab the
   * longest-waiting person leads, so the most blocked is at the top; rows that need you stay above the paging.
   */
  #tabbed(prs: OthersPrRow[], byPr: Map<string, DraftRow[]>): Node[] {
    const groups = new Map<SubTab, { p: OthersPrRow; reasons: string[] }[]>(SUBTABS.map((t) => [t.id, []] as const));
    for (const p of prs) { if (p.ignored === 'ignored') continue; const c = classify(p, (byPr.get(key(p.repo, p.number)) ?? []).some(waiting)); groups.get(c.tab)?.push({ p, reasons: c.reasons }); }
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
    const panel = h('div', { role: 'tabpanel', id: 'panel', 'aria-labelledby': `tab-${def.id}`, ...(rows.length ? {} : { tabindex: '0' }) }, ...(rows.length ? this.#list(def.id, rows, byPr) : [tacet(def.empty, 'tacet')]));
    return [tabs, panel];
  }

  /** When review drafts wait in a sub-tab other than the open one, say so and offer the jump to the one that holds the most (per `classify`: a stale PR keeps its draft in Stale). */
  #waitingNote(prs: OthersPrRow[], byPr: Map<string, DraftRow[]>): Node[] {
    const by = new Map<SubTab, number>();
    for (const p of prs) if (p.ignored !== 'ignored' && (byPr.get(key(p.repo, p.number)) ?? []).some(waiting)) { const t = classify(p, true).tab; by.set(t, (by.get(t) ?? 0) + 1); }
    const elsewhere = [...by].filter(([t]) => t !== this.#tab).sort((x, y) => y[1] - x[1]);
    const top = elsewhere[0];
    if (!top) return [];
    const [tab, n] = top;
    const label = SUBTABS.find((t) => t.id === tab)?.label ?? tab;
    const b = h('button', { type: 'button', class: 'secondary' }, `Show ${n === 1 ? 'it' : 'them'} (${label})`);
    b.addEventListener('click', () => this.#select(tab, true));
    return [h('p', { class: 'status', 'data-note': 'waiting-drafts' }, `${n} drafted ${n === 1 ? 'review waits' : 'reviews wait'} for your Approve in the ${label} tab. `, b)];
  }

  /** Runs one write for one PR: the button is off while it is in flight, a refusal is shown on the row, a success is announced. */
  #act(op: OthersOp, p: OthersPrRow): void {
    const k = key(p.repo, p.number);
    if (!this.#actions || this.#busy.has(k)) return;
    this.#busy.add(k);
    this.#notes.delete(k);
    this.#bump();
    void this.#actions.run(op, p).then((out) => {
      this.#busy.delete(k);
      if (out) this.#notes.set(k, out);
      else this.#said.textContent = op === 'ignore' ? `Ignored ${k}. It is under Ignored.` : op === 'unignore' ? `${k} is back in the list.` : `Review requested for ${k}.`;
      this.#bump();
    });
  }

  #bump(): void { this.#ver += 1; this.#sig = ''; if (this.isConnected) this.#render(); }

  /** "Ignored (n)": the PRs hidden at their current commit, each with Un-ignore. Closed until opened; a new push brings a PR back into the lists on its own. */
  #ignoredList(prs: OthersPrRow[]): Node[] {
    const hidden = prs.filter((p) => p.ignored === 'ignored');
    if (!hidden.length) return [];
    const det = h('details', { class: 'ignored', ...(this.#showIgnored ? { open: '' } : {}) },
      h('summary', {}, `Ignored (${hidden.length})`),
      h('ul', { class: 'prs', role: 'list', 'aria-label': 'Ignored teammate PRs' }, ...hidden.map((p) => {
        const k = key(p.repo, p.number);
        const link = linkAttrs(p.url);
        const b = h('button', { type: 'button', class: 'secondary', 'aria-label': `Un-ignore ${k}`, disabled: this.#busy.has(k) }, 'Un-ignore');
        b.addEventListener('click', () => this.#act('unignore', p));
        return h('li', { class: 'pr', 'data-pr': k, 'data-ignored': 'true' },
          h('h3', {}, link ? h('a', { ...link, class: 'ref' }, k) : h('span', { class: 'ref' }, k), h('span', { class: 'by' }, `by ${who(p)} `), p.title),
          h('div', { class: 'meta' }, h('span', {}, `Ignored at commit ${(p.headSha ?? '').slice(0, 7)}; a new push brings it back.`)),
          h('div', { class: 'actions' }, b),
          ...(this.#notes.has(k) ? [h('p', { class: 'status bad', role: 'status' }, this.#notes.get(k) as string)] : []));
      })));
    det.addEventListener('toggle', () => { this.#showIgnored = (det as HTMLDetailsElement).open; this.#sig = this.#signature(); });
    return [det];
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
   * The rows of one tab: those that need you (a waiting draft, a review asked of you) first and always, then the rest `PAGE_SIZE` to a page. The hidden live region
   * is kept across redraws and says the page and range, and the pager button that was pressed gets focus back after the redraw.
   */
  #list(tab: SubTab, items: { p: OthersPrRow; reasons: string[] }[], byPr: Map<string, DraftRow[]>): Node[] {
    const waitingOn = (x: { p: OthersPrRow }): boolean => x.p.youAsked || (byPr.get(key(x.p.repo, x.p.number)) ?? []).some(waiting);
    const plan = pagePlan(items, waitingOn, this.#pages[tab] ?? 1);
    this.#pages[tab] = plan.view.page;
    const label = SUBTABS.find((t) => t.id === tab)?.label ?? '';
    const ul = h('ul', { class: 'prs', role: 'list', 'aria-label': 'Open teammate PRs' }, ...plan.shown.map((x) => this.#row(x.p, byPr.get(key(x.p.repo, x.p.number)) ?? [], tab, x.reasons)));
    const said = `${plan.total} in ${label}${plan.view.pages > 1 ? `, page ${plan.view.page} of ${plan.view.pages}` : ''}`;
    if (this.#announce.textContent !== said) this.#announce.textContent = said;
    const nav = pager(plan.view, { label, key: `others:${tab}`, quiet: true, go: (page, dir) => {
      this.#pages[tab] = page;
      this.#focusPager = dir;
      this.#render();
    } });
    return [ul, ...(nav ? [nav.el] : [])];
  }

  /** One live region kept across redraws, its text set only when it changes, so a screen reader hears a change and not every redraw. */
  #statusLine(text: string, bad: boolean): HTMLElement {
    if (this.#status.textContent !== text) this.#status.textContent = text;
    this.#status.className = `status${bad ? ' bad' : ''}`;
    return this.#status;
  }

  /** Ignore on every row; on a hands-off row with no draft yet, Review anyway (or the note that one is already asked for). */
  #rowActions(p: OthersPrRow, hasDraft: boolean): Node {
    const ref = key(p.repo, p.number);
    const busy = this.#busy.has(ref);
    const ignore = h('button', { type: 'button', class: 'secondary', 'aria-label': `Ignore ${ref}`, disabled: busy || !p.headSha }, 'Ignore');
    ignore.addEventListener('click', () => this.#act('ignore', p));
    const anyway = p.handsOff && !hasDraft && !p.reviewRequested ? h('button', { type: 'button', class: 'secondary', 'aria-label': `Review ${ref} anyway`, disabled: busy }, 'Review anyway') : null;
    anyway?.addEventListener('click', () => this.#act('review-anyway', p));
    return h('div', { class: 'actions' }, ignore,
      ...(p.headSha ? [] : [h('span', { class: 'meta' }, 'Cannot be ignored until the list records its latest commit.')]),
      ...(anyway ? [anyway] : []),
      ...(p.handsOff && !hasDraft && p.reviewRequested ? [h('span', { class: 'chip good', 'data-note': 'review-requested' }, 'Review requested; the draft appears after the next review run')] : []));
  }

  #row(p: OthersPrRow, drafts: DraftRow[], tab: SubTab, reasons: string[]): HTMLElement {
    const ref = key(p.repo, p.number);
    const link = linkAttrs(p.url);
    const open = drafts.filter(waiting);
    const rv = REVIEW[p.review];
    const draftChip = open.length
      ? h('span', { class: 'chip good' }, h('span', { 'aria-hidden': 'true' }, '> '), `Draft ready${open.length > 1 ? ` (${open.length})` : ''}`)
      : h('span', { class: 'chip' }, 'No review yet');
    const asked = p.askedAt ? agoHours(p.askedAt, this.#now) : '';
    const updated = agoHours(p.updatedAt, this.#now);
    const opened = p.openedAt ? agoHours(p.openedAt, this.#now) : '';
    return h('li', { class: 'pr', 'data-pr': ref },
      h('h3', {}, link ? h('a', { ...link, class: 'ref' }, ref) : h('span', { class: 'ref' }, ref), h('span', { class: 'by' }, `by ${who(p)} `), p.title),
      h('div', { class: 'meta' },
        h('span', {}, `Into ${p.base || 'unknown'}`),
        h('span', {}, `Updated ${updated || 'at an unknown time'}${updated ? ' ago' : ''}`),
        ...(opened ? [h('span', {}, `Open ${opened}`)] : p.ageDays !== undefined ? [h('span', {}, `Open ${p.ageDays} d`)] : [])),
      h('div', { class: 'chips' },
        h('span', { class: `chip ${p.youAsked ? 'good' : ''}` }, p.youAsked ? 'You are a requested reviewer' : 'You are not a requested reviewer'),
        h('span', { class: `chip ${rv.tone}` }, h('span', { 'aria-hidden': 'true' }, `${rv.glyph} `), h('span', { class: 'vh' }, 'Review: '), rv.word),
        h('span', { class: `chip ${p.copilotThreads > 0 ? 'bad' : ''}` }, `Copilot threads open: ${p.copilotThreads}`),
        h('span', { class: 'chip' }, `Threads open: ${p.unresolved}`),
        ...(asked ? [h('span', { class: `chip ${tab === 'stale' ? 'warn' : ''}` }, tab === 'stale' ? `Last ask ${asked}${asked === 'just now' ? '' : ' ago'}` : `Waiting ${asked}`)] : []),
        ...(tab === 'stale' && p.staleWhy ? [h('span', { class: 'chip' }, p.staleWhy)] : []),
        ...(tab === 'not-ready' ? reasons.map((r) => h('span', { class: 'chip warn' }, h('span', { 'aria-hidden': 'true' }, '- '), r)) : []),
        ...(p.handsOff ? [h('span', { class: 'chip warn' }, h('span', { 'aria-hidden': 'true' }, '- '), 'Hands off: the repo owner\'s call')] : []),
        ...(p.ignored === 'new-commits' ? [h('span', { class: 'chip warn' }, h('span', { 'aria-hidden': 'true' }, '- '), 'New commits since you ignored')] : []),
        draftChip),
      ...(p.handsOff && !open.length ? [h('p', { class: 'meta', 'data-note': 'hands-off' }, p.handsOffWhy ?? 'This repo is the owner\'s call, so no review draft is made unless you ask for one.')] : []),
      this.#rowActions(p, open.length > 0),
      ...(this.#notes.has(ref) ? [h('p', { class: 'status bad', role: 'status' }, this.#notes.get(ref) as string)] : []),
      ...(open.length && this.#drafts ? [this.#drafts.queue((x) => x.repo === p.repo && x.pr === p.number, '', true, (x) => x.author ?? who(p))] : []));
  }
}

if (!customElements.get('others-prs')) customElements.define('others-prs', OthersPrs);
declare global { interface HTMLElementTagNameMap { 'others-prs': OthersPrs } }
