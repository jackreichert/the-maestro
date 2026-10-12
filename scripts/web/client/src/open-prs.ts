import { BASE_CSS, h, refLink, shadow } from './dom.ts';
import { ago, askAge, clockTime } from './glance.ts';
import type { OpenPrRow, OpenPrSide, OpenPrsRepo } from './types.ts';
import type { OpenPrsModel } from './open-prs-store.ts';

const CSS = `${BASE_CSS}
  :host { display: block; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-4); margin: 0 0 var(--space-5); }
  .fresh { margin: 0; color: var(--text-secondary); font-size: var(--text-sm); line-height: var(--leading-sm); font-variant-numeric: tabular-nums; }
  .warn { color: var(--warning); font-weight: var(--weight-semibold); }
  button.refresh {
    font: inherit; font-size: var(--text-sm); line-height: var(--leading-sm); font-weight: var(--weight-medium); color: var(--text-primary);
    min-height: 36px; padding: 0 var(--space-4); border: var(--hairline-strong); border-radius: var(--radius-sm); background: var(--surface-1); cursor: pointer;
  }
  @media (hover: hover) { button.refresh:hover { background: var(--surface-2); } }
  button.refresh[aria-disabled=true] { color: var(--text-muted); cursor: progress; }
  .state { margin: 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  .state.failed, .state.locked { color: var(--critical); }
  .state.done { color: var(--success); }
  h2.group { margin: var(--space-6) 0 var(--space-2); font-size: var(--text-xs); line-height: var(--leading-xs); font-weight: var(--weight-semibold); letter-spacing: var(--tracking-caps); text-transform: uppercase; color: var(--text-muted); }
  h3.repo { margin: var(--space-4) 0 var(--space-1); font-size: var(--text-md); line-height: var(--leading-md); font-weight: var(--weight-semibold); }
  h3.repo .n { color: var(--text-muted); font-weight: var(--weight-regular); font-variant-numeric: tabular-nums; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); line-height: var(--leading-sm); font-variant-numeric: tabular-nums; }
  th, td { padding: var(--space-2) var(--space-3) var(--space-2) 0; border-bottom: var(--hairline); text-align: left; vertical-align: top; }
  thead th { color: var(--text-muted); font-weight: var(--weight-medium); font-size: var(--text-xs); line-height: var(--leading-xs); border-top: var(--hairline); white-space: nowrap; }
  td.title { min-width: 16em; overflow-wrap: anywhere; }
  td.pr, td.age, td.pair { white-space: nowrap; }
  .side { display: block; }
  .side-label { color: var(--text-muted); }
  .missing { font-weight: var(--weight-semibold); }
  .bad { color: var(--critical); }
  .empty { margin: 0; color: var(--text-secondary); }
`;

const REVIEW: Record<OpenPrRow['review'], string> = { approved: 'Approved', 'changes-requested': 'Changes requested', none: 'No review' };
const MERGE: Record<OpenPrRow['mergeable'], string> = { mergeable: 'Mergeable', conflicting: 'Conflicts', unknown: 'Unknown' };

/**
 * <open-prs>: every open PR grouped by repo (team repos, then self-review repos), one table per repo, with a "PR data <time>" line
 * and a Refresh button. It draws what `model` says and calls `onRefresh` on a press; loading, polling and the guard against a second
 * press live in the store, so a page redraw never loses a refresh in flight. The button uses aria-disabled, so it keeps focus.
 */
export class OpenPrs extends HTMLElement {
  #root: ShadowRoot;
  #model: OpenPrsModel | null = null;
  #tz = '';
  #fresh = h('p', { class: 'fresh' });
  #state = h('p', { class: 'state', role: 'status' });
  #button = h('button', { type: 'button', class: 'refresh' }, 'Refresh');
  #body = h('div', {});
  onRefresh: () => void = () => {};

  constructor() {
    super();
    this.#root = shadow(this, CSS);
    this.#button.addEventListener('click', () => { if (this.#button.getAttribute('aria-disabled') !== 'true') this.onRefresh(); });
    this.#root.append(h('div', { class: 'bar' }, this.#button, this.#state, this.#fresh), this.#body);
  }

  set tz(v: string) { this.#tz = v; if (this.#model) this.#draw(); }
  set model(m: OpenPrsModel) { this.#model = m; if (this.isConnected) this.#draw(); }
  connectedCallback(): void { if (this.#model) this.#draw(); }

  #draw(): void {
    const m = this.#model;
    if (!m) return;
    const running = m.refresh.kind === 'running';
    this.#button.setAttribute('aria-disabled', String(running));
    this.#button.textContent = running ? 'Refreshing...' : 'Refresh';
    this.#state.className = `state ${m.refresh.kind}`;
    this.#state.textContent = { idle: '', running: 'Refreshing the PR data...', done: 'Refreshed.', failed: m.refresh.message ?? 'The refresh failed.', locked: m.refresh.message ?? 'Another refresh is already running.' }[m.refresh.kind];
    this.#drawFresh(m);
    this.#body.replaceChildren(...this.#content(m));
  }

  #drawFresh(m: OpenPrsModel): void {
    const d = m.data;
    if (!d) { this.#fresh.replaceChildren(m.loaded ? 'PR data is not available from this page.' : 'Loading PR data...'); return; }
    const at = d.prData.fetchedAt;
    const clock = at ? clockTime(at, this.#tz) : '';
    const age = at ? ago(at, d.generatedAt) : '';
    const text = at ? `PR data ${clock || at}${age ? ` (${age === 'just now' ? age : `${age} ago`})` : ''}` : 'PR data: none yet';
    const warn = d.prData.failure ? `GitHub could not be read (${d.prData.failure}); showing the last data.` : d.prData.stale || !at ? 'Stale. Press Refresh.' : '';
    this.#fresh.replaceChildren(text);
    if (warn) this.#fresh.append(h('span', { class: 'warn' }, ` ${warn}`));
  }

  #content(m: OpenPrsModel): Node[] {
    const d = m.data;
    if (!d) return [];
    if (d.total === 0) return [h('p', { class: 'empty' }, 'No open PRs.')];
    return d.groups.flatMap((g) => [
      h('h2', { class: 'group' }, `${g.label} (${g.count})`),
      ...g.repos.map((r) => this.#repo(r)),
    ]);
  }

  #repo(r: OpenPrsRepo): Node {
    const head = h('tr', {}, ...['PR', 'Title', 'Develop / staging', 'State', 'Review', 'Threads', 'Merge', 'Age', 'Ticket'].map((t) => h('th', { scope: 'col' }, t)));
    return h('section', {},
      h('h3', { class: 'repo' }, r.repo, ' ', h('span', { class: 'n' }, `(${r.count})`)),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, head), h('tbody', {}, ...r.prs.map((p) => this.#row(p))))));
  }

  #side(label: string, side: OpenPrSide | undefined): Node {
    return h('span', { class: 'side' }, h('span', { class: 'side-label' }, label), ' ', side ? refLink({ label: `#${side.number}`, url: side.url }) : h('span', { class: 'missing' }, 'none'));
  }

  #pair(p: OpenPrRow): Node {
    if (!p.sides) return h('td', {}, p.base);
    return h('td', { class: 'pair' }, this.#side('develop', p.sides.develop), this.#side('staging', p.sides.staging));
  }

  #row(p: OpenPrRow): Node {
    return h('tr', {},
      h('td', { class: 'pr' }, refLink({ label: `#${p.number}`, url: p.url })),
      h('td', { class: 'title' }, p.title),
      this.#pair(p),
      h('td', {}, p.isDraft ? 'Draft' : 'Ready'),
      h('td', {}, REVIEW[p.review]),
      h('td', { class: p.unresolved > 0 ? 'bad' : '' }, p.unresolved > 0 ? `${p.unresolved} open` : '0'),
      h('td', { class: p.mergeable === 'conflicting' ? 'bad' : '' }, MERGE[p.mergeable]),
      h('td', { class: 'age' }, p.ageDays === undefined ? '' : askAge(p.ageDays)),
      h('td', {}, p.ticket ? refLink(p.ticket) : ''));
  }
}

if (!customElements.get('open-prs')) customElements.define('open-prs', OpenPrs);
declare global { interface HTMLElementTagNameMap { 'open-prs': OpenPrs } }
