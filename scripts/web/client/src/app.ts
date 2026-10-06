import './stream-board.ts';
import './podium-chart.ts';
import './md-fragment.ts';
import { BASE_CSS, h, shadow } from './dom.ts';
import { loadCharts, loadState } from './api.ts';
import { ageChart, modelMixChart, prMixChart, throughputChart } from './chart-data.ts';
import { OVERVIEW, formatFragment, nextTab, parseFragment, tabIds } from './tabs.ts';
import type { Source } from './api.ts';
import type { ChartKind } from './podium-chart.ts';
import type { ChartData } from './chart-math.ts';
import type { ChartsData, PodiumState } from './types.ts';

const CSS = `${BASE_CSS}
  header { padding: 12px 16px 0; }
  h1 { margin: 0; font-size: 1.4rem; }
  .source { margin: 4px 0 0; font-size: 13px; color: var(--text-secondary); }
  [role=tablist] { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 16px 0; border-bottom: 1px solid var(--border); }
  [role=tab] { font: inherit; color: var(--text-primary); background: none; border: 1px solid transparent; border-bottom: 3px solid transparent; padding: 6px 12px; cursor: pointer; }
  [role=tab][aria-selected=true] { font-weight: 700; border-bottom-color: var(--accent); background: var(--surface-2); }
  [role=tabpanel] { padding: 16px; }
  h2 { font-size: 1.1rem; margin: 16px 0 8px; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 24px; }
  table { border-collapse: collapse; font-size: 14px; }
  th, td { border: 1px solid var(--border); padding: 4px 12px; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  .error { color: var(--bad); font-weight: 600; }
`;

/** <podium-app>: stream tabs plus Overview. The active tab lives in the URL fragment. */
export class PodiumApp extends HTMLElement {
  #root: ShadowRoot;
  #state: PodiumState | null = null;
  #charts: ChartsData | null = null;
  #source: Source = 'fixture';
  #active = OVERVIEW;
  readonly #onHash = (): void => { this.#select(parseFragment(location.hash, this.#ids()), false); };

  constructor() {
    super();
    this.#root = shadow(this, CSS);
  }

  connectedCallback(): void {
    window.addEventListener('hashchange', this.#onHash);
    this.#root.replaceChildren(h('p', { role: 'status' }, 'Loading…'));
    Promise.all([loadState(), loadCharts()]).then(([s, c]) => {
      this.#state = s.data;
      this.#charts = c.data;
      this.#source = s.source;
      this.#active = parseFragment(location.hash, this.#ids());
      this.#render();
    }).catch((e: unknown) => {
      this.#root.replaceChildren(h('p', { class: 'error', role: 'alert' }, `Could not load the Podium: ${e instanceof Error ? e.message : 'unknown error'}`));
    });
  }

  disconnectedCallback(): void { window.removeEventListener('hashchange', this.#onHash); }

  #ids(): string[] { return tabIds(this.#state?.streams ?? []); }

  #select(id: string, focusTab: boolean): void {
    if (id === this.#active && !focusTab) return;
    this.#active = id;
    if (location.hash !== formatFragment(id)) history.replaceState(null, '', formatFragment(id));
    this.#render();
    if (focusTab) this.#root.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus();
  }

  #render(): void {
    const st = this.#state;
    if (!st) return;
    const ids = this.#ids();
    const count = (id: string): number => st.asks.filter((a) => a.stream === id).length;
    const tabs = ids.map((id) => {
      const on = id === this.#active;
      const n = id === OVERVIEW ? st.asks.length : count(id);
      const tab = h('button', {
        type: 'button', role: 'tab', id: `tab-${id}`, 'aria-selected': String(on), 'aria-controls': 'panel',
        tabindex: on ? '0' : '-1',
      }, id === OVERVIEW ? 'Overview' : id, n > 0 ? ` (${n} awaiting)` : '');
      tab.addEventListener('click', () => this.#select(id, true));
      tab.addEventListener('keydown', (e) => {
        const next = nextTab(e.key, ids, this.#active);
        if (next === null) return;
        e.preventDefault();
        this.#select(next, true);
      });
      return tab;
    });
    const panel = h('div', { role: 'tabpanel', id: 'panel', 'aria-labelledby': `tab-${this.#active}`, tabindex: '0' },
      this.#active === OVERVIEW ? this.#overview(st) : this.#board(st, this.#active));
    this.#root.replaceChildren(
      h('header', {}, h('h1', {}, 'Podium'),
        h('p', { class: 'source', role: 'status' }, this.#source === 'fixture' ? 'Showing bundled sample data: no server answered.' : `Live. Updated ${st.generatedAt}.`)),
      h('div', { role: 'tablist', 'aria-label': 'Streams' }, ...tabs),
      panel);
  }

  #board(st: PodiumState, stream: string): Node {
    const board = h('stream-board', { stream });
    board.state = st;
    return board;
  }

  #overview(st: PodiumState): Node {
    const pri = st.priorities;
    const priorities = pri.state === 'ok'
      ? h('ol', {}, ...pri.items.map((i) => h('li', {}, i.text, i.stream ? ` [${i.stream}]` : '')))
      : h('p', {}, pri.state === 'stale' ? `Priorities are from ${pri.date}: stale.` : 'No priorities set for today.');
    const footer = h('table', {}, h('caption', { class: 'vh' }, 'Counts per stream'),
      h('thead', {}, h('tr', {}, ...['Stream', 'Awaiting', 'Working', 'Queued', 'Blocked', 'Done'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, ...st.footer.map((f) => h('tr', {}, h('th', { scope: 'row' }, f.stream),
        ...[f.asks, f.working, f.queued, f.blocked, f.done].map((n) => h('td', {}, String(n)))))));
    const frag = st.fragments?.[OVERVIEW];
    const md = frag ? h('md-fragment') : null;
    if (md && frag) md.markdown = frag;
    return h('div', {},
      h('h2', {}, `Today's priorities`), priorities,
      h('h2', {}, 'Counts'), footer,
      h('h2', {}, 'Charts'), this.#chartGrid(),
      md ? h('h2', {}, 'Notes') : null, md);
  }

  #chartGrid(): Node {
    const c = this.#charts;
    if (!c) return h('p', {}, 'No chart data.');
    const mk = (kind: ChartKind, title: string, data: ChartData): HTMLElement => {
      const el = h('podium-chart', { kind, title });
      el.data = data;
      return el;
    };
    return h('div', { class: 'charts' },
      mk('stacked', 'Done per day, by stream', throughputChart(c)),
      mk('bar', 'Open asks by age', ageChart(c)),
      mk('bar', 'Pull requests by CI state', prMixChart(c)),
      mk('share', c.modelMix.source === 'tokens' ? 'Model mix (tokens)' : 'Model mix (items by model)', modelMixChart(c)));
  }
}

customElements.define('podium-app', PodiumApp);
