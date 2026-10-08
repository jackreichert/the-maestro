import './stream-board.ts';
import './podium-chart.ts';
import './priority-list.ts';
import './md-fragment.ts';
import { h, s, shadow, streamTag } from './dom.ts';
import { BOARD_CSS, RESTS, askCards, askHint, itemRows, section } from './stream-board.ts';
import { describeSources, loadCharts, loadHome, loadLinkHosts, loadState } from './api.ts';
import { fragmentFor } from './contract.ts';
import { UpdateGate, askState } from './ask-state.ts';
import type { GateInput } from './ask-state.ts';
import { findByKey, focusKeyOf, openFolds, reopenFolds } from './keep-view.ts';
import type { FocusKey } from './keep-view.ts';
import { LiveUpdates, liveLabel } from './live.ts';
import type { LiveStatus } from './live.ts';
import { ageChart, modelMixChart, prMixChart, throughputChart } from './chart-data.ts';
import { TEMPO_LEAD, TEMPO_SCALE, cueParts, cueTitle, clockTime, freshness, longDate, shortDate, tempoWord } from './glance.ts';
import { OVERVIEW, formatFragment, nextTab, parseFragment, tabIds } from './tabs.ts';
import type { Source } from './api.ts';
import type { ChartKind } from './podium-chart.ts';
import type { ChartData } from './chart-math.ts';
import type { AskBusyDetail, ChartsData, PodiumState, StreamHome } from './types.ts';

interface Fresh { state: PodiumState; charts: ChartsData; dropped: number }

const CSS = `${BOARD_CSS}
  :host { --pad: var(--space-4); }
  @media (min-width: 640px) { :host { --pad: var(--space-5); } }
  @media (min-width: 1100px) { :host { --pad: var(--space-7); } }
  .wrap { max-width: 1360px; margin: 0 auto; padding-inline: var(--pad); }

  header { padding-block: var(--space-5) var(--space-4); }
  .top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2) var(--space-4); }
  .brand { display: flex; align-items: baseline; gap: var(--space-3); flex-wrap: wrap; }
  h1 { margin: 0; font-size: var(--text-md); line-height: var(--leading-md); font-weight: var(--weight-bold); letter-spacing: -0.01em; white-space: nowrap; }
  /* The baton wordmark: the stick is ink, and its tip takes the accent only while something needs you. */
  .baton { width: 20px; height: 20px; margin-right: 6px; vertical-align: -4px; color: var(--text-primary); overflow: visible; }
  .baton .stick { transform-box: view-box; transform-origin: 9.4px 22.6px; }
  .baton .tip { fill: var(--text-muted); }
  .baton .tip.on { fill: var(--accent); }
  @media (hover: hover) { h1:hover .baton .stick { animation: downbeat calc(var(--dur-base) * 1.6) var(--ease-out); } }
  @keyframes downbeat { 40% { transform: rotate(-8deg); } }
  .date { font-size: var(--text-sm); color: var(--text-secondary); }
  .date .short, .fresh .short-hide { display: inline; }
  .date .short { display: none; }
  @media (max-width: 480px) {
    .top { flex-wrap: nowrap; }
    .date .long, .fresh .short-hide { display: none; }
    .date .short { display: inline; }
    .scope { margin-top: var(--space-4); }
    [role=tabpanel] { padding-top: var(--space-5); }
  }
  .fresh {
    display: inline-flex; align-items: center; gap: var(--space-2); padding: 2px var(--space-3); border-radius: var(--radius-pill);
    background: var(--surface-1); box-shadow: var(--shadow-1); font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .link { font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-muted); }
  .link.offline { color: var(--critical); }
  .dot { width: 8px; height: 8px; border-radius: 50%; border: 2px solid var(--text-muted); }
  .fresh.live .dot { border-color: var(--success); background: var(--success); }
  .fresh.stale { background: var(--warning-soft); color: var(--warning); box-shadow: none; }
  .fresh.stale .dot { border-color: var(--warning); background: var(--warning); }
  .dot.tick { animation: tick calc(var(--dur-base) * 2.7) var(--ease-out); }
  @keyframes tick { 30% { opacity: 0.35; } }
  .scope { margin: var(--space-5) 0 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-muted); }
  .scope span { vertical-align: baseline; }
  button.tempo {
    font: italic var(--text-sm) / var(--leading-sm) var(--font-serif); letter-spacing: 0.01em; color: var(--text-secondary);
    background: none; border: 0; padding: 2px 4px; margin: -2px -4px; border-radius: 4px; cursor: pointer;
    text-decoration: underline dotted var(--border-strong); text-underline-offset: 0.25em;
    transition: color var(--dur-fast) var(--ease-out);
  }
  button.tempo i { font-style: italic; }
  @media (hover: hover) { button.tempo:hover { color: var(--text-primary); text-decoration-color: currentColor; } }
  .tempo-rule { margin: var(--space-2) 0 0; max-width: 62ch; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  .tempo-rule[hidden] { display: none; }
  .tempo-rule i { font-family: var(--font-serif); font-size: 1.04em; }
  .tempo-rule i.now { color: var(--text-primary); }
  .blk { color: var(--critical); font-size: var(--text-sm); }
  .source { margin: var(--space-2) 0 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-muted); }

  .cue { margin: var(--space-1) 0 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-5); padding: 0; list-style: none; font-size: var(--text-2xl); line-height: var(--leading-2xl); letter-spacing: -0.02em; }
  .cue li { display: inline-flex; align-items: baseline; gap: var(--space-2); white-space: nowrap; color: var(--text-secondary); }
  .cue .n { font-weight: var(--weight-bold); font-variant-numeric: tabular-nums; color: var(--text-primary); }
  .cue .zero, .cue .zero .n { color: var(--text-muted); font-weight: var(--weight-regular); }
  .cue .tone-accent:not(.zero) .n { color: var(--accent); }
  .cue .tone-critical:not(.zero) .n { color: var(--critical); }
  .cue .tone-success:not(.zero) .n { color: var(--success); }
  @media (max-width: 640px) { .cue { font-size: var(--text-xl); line-height: var(--leading-xl); gap: var(--space-1) var(--space-4); } }

  .tabbar { position: sticky; top: 0; z-index: 2; background: var(--surface-page); border-bottom: 1px solid var(--border); }
  [role=tablist] { display: flex; gap: var(--space-1); overflow-x: auto; scrollbar-width: none; padding-top: var(--space-2); }
  [role=tablist]::-webkit-scrollbar { display: none; }
  .more-end [role=tablist] { mask-image: linear-gradient(to right, black calc(100% - 56px), transparent); }
  .more-start [role=tablist] { mask-image: linear-gradient(to right, transparent, black 56px); }
  .more-start.more-end [role=tablist] { mask-image: linear-gradient(to right, transparent, black 56px, black calc(100% - 56px), transparent); }
  [role=tab] {
    position: relative; flex: none; display: inline-flex; align-items: center; gap: var(--space-2); min-height: 40px;
    padding: 0 var(--space-3); border: 0; border-radius: var(--radius-sm) var(--radius-sm) 0 0; background: none; cursor: pointer;
    font: inherit; font-size: var(--text-md); font-weight: var(--weight-medium); color: var(--text-secondary); white-space: nowrap;
    transition: color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out);
  }
  @media (hover: hover) { [role=tab]:hover { color: var(--text-primary); background: var(--surface-2); } }
  [role=tab]:focus-visible { outline-offset: -2px; }
  [role=tab][aria-selected=true] { color: var(--text-primary); font-weight: var(--weight-semibold); }
  [role=tab][aria-selected=true]::after { content: ''; position: absolute; left: var(--space-3); right: var(--space-3); bottom: -1px; height: 2px; border-radius: 2px; background: var(--accent); }
  .badge { min-width: 20px; min-height: 20px; padding: 0 6px; border-radius: var(--radius-pill); background: var(--accent-soft); color: var(--accent); font-size: var(--text-xs); line-height: 20px; font-weight: var(--weight-semibold); text-align: center; font-variant-numeric: tabular-nums; }

  @media (forced-colors: active) {
    [role=tab][aria-selected=true]::after { forced-color-adjust: none; background: Highlight; height: 4px; bottom: 0; }
    .fresh, .sk { border: 1px solid CanvasText; }
    .dot { forced-color-adjust: none; border-color: CanvasText; }
    .fresh.live .dot { background: CanvasText; }
    .baton .tip.on { fill: Highlight; }
  }
  [role=tabpanel] { padding-block: var(--space-6) var(--space-8); }
  /* The panel takes focus between the tabs and its content: a 2 px focus line under the tab bar, not a frame round the page. */
  [role=tabpanel]:focus-visible { outline: none; border-radius: 0; box-shadow: inset 0 2px 0 var(--focus); }
  @media (forced-colors: active) { [role=tabpanel]:focus-visible { outline: 2px solid CanvasText; outline-offset: -2px; } }


  .table-wrap { overflow-x: auto; }
  .table-wrap:focus-visible { outline-offset: 4px; }
  table.counts { width: 100%; border-collapse: collapse; font-size: var(--text-sm); line-height: var(--leading-sm); font-variant-numeric: tabular-nums; }
  table.counts th, table.counts td { padding: var(--space-2) var(--space-1); border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; }
  table.counts thead th { color: var(--text-muted); font-weight: var(--weight-medium); font-size: var(--text-xs); line-height: var(--leading-xs); border-top: 1px solid var(--border); white-space: normal; vertical-align: bottom; }
  table.counts th:first-child, table.counts td:first-child { text-align: left; padding-left: 0; }
  table.counts th:last-child, table.counts td:last-child { padding-right: 0; }
  table.counts tbody th { font-weight: var(--weight-medium); }
  table.counts .z { color: var(--text-muted); }

  .fine { margin: var(--space-7) 0 0; display: flex; justify-content: center; align-items: center; gap: var(--space-2); color: var(--text-muted); }
  .fine .barline { fill: var(--border-strong); }
  .fine i { font-family: var(--font-serif); font-size: var(--text-md); letter-spacing: 0.01em; }
  @media (forced-colors: active) { .fine .barline { fill: CanvasText; } }
  .wide { margin-top: var(--space-7); display: grid; gap: var(--space-6); }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 440px), 1fr)); gap: var(--space-4); }
  .charts podium-chart { background: var(--surface-1); border-radius: var(--radius-lg); box-shadow: var(--shadow-1); padding: var(--space-4) var(--space-4) var(--space-3); }

  [role=tabpanel] { animation: fade-in var(--dur-base) var(--ease-out); }
  [role=tab][aria-selected=true]::after { animation: grow var(--dur-base) var(--ease-out); transform-origin: center; }
  @keyframes fade-in { from { opacity: 0; } }
  @keyframes grow { from { transform: scaleX(0.4); opacity: 0; } }

  /* Placeholder blocks breathe in opacity (composited, no repaint per frame), not a moving gradient. */
  .sk { display: block; border-radius: var(--radius-sm); background: var(--surface-2); animation: breathe 1.6s var(--ease-in-out) infinite; }
  @keyframes breathe { 50% { opacity: 0.5; } }
  @media (prefers-reduced-motion: reduce) { .sk { animation: none; } }
  /* Offsets match the header's real metrics at rest (brand row, scope line, cue line, tab bar), so nothing jumps on load. */
  .sk-head { padding-block: 43px 0; }
  .sk-scope { display: block; margin-top: 47px; }
  .sk-scope + .staff { margin-top: 14px; }
  .sk-tabs { margin-top: 29px; border-bottom: 1px solid var(--border); padding-block: 15px; }
  .sk-tabs .wrap { display: flex; gap: var(--space-6); }
  .sk-panel { padding-block: var(--space-6); }
  .sk-rows { display: block; border-top: 1px solid var(--border); }
  .sk-row { display: flex; align-items: center; gap: var(--space-3); height: 41px; border-bottom: 1px solid var(--border); }
  .sk-hint { display: block; margin-top: -4px; }
  .sk-hint .sk-line { height: 8px; max-width: 90%; }
  .sk-id { width: 36px; height: 16px; flex: none; }
  .sk-line { height: 12px; }
  /* Five hairlines 6 px apart (the cue line's height) and a note head that glides along the middle space. */
  .staff { position: relative; display: block; height: 25px; width: min(560px, 90%); margin-top: var(--space-5); }
  .staff-line { position: absolute; left: 0; right: 0; height: 1px; background: var(--border-strong); opacity: 0.45; }
  .staff-line:nth-child(2) { top: 6px; }
  .staff-line:nth-child(3) { top: 12px; }
  .staff-line:nth-child(4) { top: 18px; }
  .staff-line:nth-child(5) { top: 24px; }
  .glide { position: absolute; inset: 0; animation: glide 1.6s var(--ease-in-out) infinite alternate; }
  .note { position: absolute; left: 0; top: 12.5px; width: 9px; height: 6px; border-radius: 50%; background: var(--text-muted); transform: rotate(-20deg); }
  @keyframes glide { to { transform: translateX(calc(100% - 9px)); } }
  @media (prefers-reduced-motion: reduce) { .glide { animation: none; } }
  @media (forced-colors: active) { .staff-line, .note { forced-color-adjust: none; background: CanvasText; } }
  .sk-stack { display: grid; gap: var(--space-4); align-content: start; }

  .problem { max-width: 60ch; margin: var(--space-8) auto; padding: var(--space-6); background: var(--surface-1); border-radius: var(--radius-lg); box-shadow: var(--shadow-1); }
  .problem h2 { margin: 0 0 var(--space-2); font-size: var(--text-lg); line-height: var(--leading-lg); }
  .problem h2::before { content: '⊘'; color: var(--critical); margin-right: var(--space-2); }
  .problem p { margin: 0 0 var(--space-4); color: var(--text-secondary); }
  .problem .detail { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--text-primary); background: var(--surface-2); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); overflow-wrap: anywhere; }
`;

/** How many asks the Overview lists before "Show all N": the oldest few, so Blocked and Shipped today stay above the fold. */
export const ASK_PREVIEW = 4;
/** On a phone each ask row takes two lines, so the preview is one shorter there. */
const ASK_PREVIEW_PHONE = 3;
const askPreview = (): number => (window.matchMedia('(max-width: 640px)').matches ? ASK_PREVIEW_PHONE : ASK_PREVIEW);

/** <podium-app>: header with the cue line, stream tabs plus Overview. The active tab lives in the URL fragment. */
export class PodiumApp extends HTMLElement {
  #root: ShadowRoot;
  #state: PodiumState | null = null;
  #charts: ChartsData | null = null;
  #sources: { state: Source; charts: Source } = { state: 'fixture', charts: 'fixture' };
  #dropped = 0;
  #active = OVERVIEW;
  #tick: number | undefined;
  #tabsObserver: ResizeObserver | null = null;
  #tempoOpen = false;
  // The last home base each stream tab got, so a redraw shows it at once while the fresh one loads.
  readonly #homes = new Map<string, StreamHome>();
  #liveUpdates: LiveUpdates<Fresh> | null = null;
  #liveStatus: LiveStatus | null = null;
  // Newer data is held while a press is in flight or an answer is being typed, and shown when that ends. Drafts and settled
  // cards live in askState, so the redraw that follows puts them back.
  readonly #gate = new UpdateGate<Fresh>();
  // A stream tag link (or Back) changed the fragment: switch tabs, start the new tab at the top, and put focus on its
  // tab so keyboard and screen reader users are not left on the destroyed link.
  readonly #onHash = (): void => {
    const id = parseFragment(location.hash, this.#ids());
    if (id === this.#active) return;
    this.#select(id, true);
    window.scrollTo({ top: 0 });
  };

  constructor() {
    super();
    this.#root = shadow(this, CSS);
  }

  connectedCallback(): void {
    window.addEventListener('hashchange', this.#onHash);
    this.addEventListener('focusin', this.#onFocusMove);
    this.addEventListener('focusout', this.#onFocusMove);
    this.addEventListener('input', this.#onFocusMove);
    this.addEventListener('pointerdown', this.#onPress);
    this.addEventListener('ask-busy', this.#onBusy);
    window.addEventListener('pointerup', this.#onRelease);
    window.addEventListener('pointercancel', this.#onRelease);
    this.#root.replaceChildren(skeleton());
    Promise.all([loadState(), loadCharts(), loadLinkHosts()]).then(([s, c]) => {
      if (!this.isConnected) return;   // removed while loading: start nothing that disconnectedCallback has already missed
      this.#state = s.data;
      this.#charts = c.data;
      this.#sources = { state: s.source, charts: c.source };
      this.#dropped = s.dropped + c.dropped;
      this.#active = parseFragment(location.hash, this.#ids());
      this.#safeRender();
      // The data is loaded once; re-say its age every minute so a page left open shows when it has gone stale.
      this.#tick = window.setInterval(() => this.#updateFreshness(), 60_000);
      if (this.#live) this.#startLive(s.data.seq);   // sample data has no server to follow
    }).catch((e: unknown) => {
      this.#root.replaceChildren(problem(`Can't reach the Podium server`, e, 'Start it with node scripts/journal.ts web (or npm run web:static for sample data), then reload.'));
    });
  }

  disconnectedCallback(): void {
    window.removeEventListener('hashchange', this.#onHash);
    this.removeEventListener('focusin', this.#onFocusMove);
    this.removeEventListener('focusout', this.#onFocusMove);
    this.removeEventListener('input', this.#onFocusMove);
    this.removeEventListener('pointerdown', this.#onPress);
    this.removeEventListener('ask-busy', this.#onBusy);
    window.removeEventListener('pointerup', this.#onRelease);
    window.removeEventListener('pointercancel', this.#onRelease);
    window.clearInterval(this.#tick);
    this.#liveUpdates?.stop();
    this.#liveUpdates = null;
    this.#tabsObserver?.disconnect();
  }

  /** Follow the server: the event stream, or polling when there is none. Only ever with data from a real server. */
  #startLive(seq: string): void {
    this.#liveUpdates = new LiveUpdates<Fresh>({
      open: () => (typeof EventSource === 'undefined' ? null : new EventSource('/api/events')),
      load: async () => {
        const [s, c] = await Promise.all([loadState(), loadCharts()]);
        return s.source === 'server' && c.source === 'server' ? { state: s.data, charts: c.data, dropped: s.dropped + c.dropped } : null;
      },
      seqOf: (f) => f.state.seq,
      apply: (f) => this.#adopt(f),
      onStatus: (st) => { this.#liveStatus = st; this.#updateLink(); },
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id as number),
    }, seq);
    this.#liveUpdates.start();
  }

  /** Show newer data, unless the user is mid-press or typing: a redraw then would swallow the click or the caret. */
  #adopt(f: Fresh): void {
    const now = this.#gate.offer(f);
    if (now) this.#show(now);
    else this.#updateLink();   // held: the label says an update is waiting
  }

  #show(f: Fresh): void {
    this.#state = f.state;
    this.#charts = f.charts;
    this.#dropped = f.dropped;
    askState.prune(f.state.asks.map((a) => a.id));
    if (!this.#ids().includes(this.#active)) this.#active = OVERVIEW;   // the stream behind the open tab is gone
    const focused = this.#focusKey();
    const folds = openFolds(this.#root);
    this.#safeRender();
    reopenFolds(this.#root, folds);   // the redraw closed every disclosure the reader had opened; open the same ones again
    if (focused) findByKey(this.#root, focused)?.focus?.();   // the redraw destroyed the element that had focus; put it back on its twin
  }

  /** A stable name for the control that has focus inside the page (tab, ask toggle, link), or null when focus is elsewhere. */
  #focusKey(): FocusKey | null {
    if (document.activeElement !== this) return null;
    let el: Element | null = this.#root.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el ? focusKeyOf(el) : null;
  }

  #release(input: GateInput): void {
    const held = this.#gate.set(input);
    if (held) this.#show(held);
  }

  // A press holds updates from pointerdown (before focus moves off a field) until the click has been delivered.
  readonly #onPress = (): void => { this.#gate.set({ pointer: true }); };
  // A card is mid-action (copying): hold until it says it is done, however long the browser takes to answer.
  readonly #onBusy = (e: Event): void => {
    if (e instanceof CustomEvent) this.#release({ busy: (e.detail as AskBusyDetail).busy });
  };
  readonly #onRelease = (): void => {
    setTimeout(() => this.#release({ pointer: false }), 0);   // the click fires after pointerup; let it run first
  };
  // Focus is mid-move during focusin/focusout; look once it has landed.
  readonly #onFocusMove = (): void => {
    setTimeout(() => this.#release({ typing: typingAnAnswer() }), 0);
  };

  #ids(): string[] { return tabIds(this.#state?.streams ?? []); }

  #select(id: string, focusTab: boolean): void {
    // Re-selecting the open tab only moves focus: a re-render would throw away a half-typed answer or a confirmation.
    if (id === this.#active) {
      if (focusTab) this.#root.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus();
      return;
    }
    this.#release({ busy: false });   // this render replaces any card still copying, and its busy=false would never arrive
    this.#active = id;
    if (location.hash !== formatFragment(id)) history.replaceState(null, '', formatFragment(id));
    this.#safeRender();
    if (focusTab) this.#root.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus();
  }

  /** Render, and show the failure instead of throwing uncaught from an event handler or a promise callback. */
  #safeRender(): void {
    try {
      this.#render();
    } catch (e) {
      this.#root.replaceChildren(problem('The board could not be drawn', e, 'The data loaded but part of it could not be shown. Reload to try again; if it keeps failing, the detail below says where.'));
    }
  }

  #render(): void {
    const st = this.#state;
    if (!st) return;
    const ids = this.#ids();
    const count = <T extends { stream: string }>(xs: T[], id: string): number => (id === OVERVIEW ? xs.length : xs.filter((x) => x.stream === id).length);
    const tabs = ids.map((id) => {
      const on = id === this.#active;
      const n = count(st.asks, id);
      const blocked = count(st.blocked, id);
      const tab = h('button', {
        type: 'button', role: 'tab', id: tabDomId(id), 'aria-selected': String(on), 'aria-controls': 'panel',
        tabindex: on ? '0' : '-1',
      }, id === OVERVIEW ? 'Overview' : id,
      n > 0 ? h('span', { class: 'badge' }, String(n), h('span', { class: 'vh' }, ' awaiting')) : null,
      blocked > 0 ? h('span', { class: 'blk' }, h('span', { 'aria-hidden': 'true' }, '⊘'), h('span', { class: 'vh' }, ` ${blocked} blocked`)) : null);
      tab.addEventListener('click', () => this.#select(id, true));
      tab.addEventListener('keydown', (e) => {
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;   // leave browser shortcuts such as Alt+Left alone
        const next = nextTab(e.key, ids, this.#active);
        if (next === null) return;
        e.preventDefault();
        this.#select(next, true);
      });
      return tab;
    });
    const panel = h('div', { role: 'tabpanel', id: 'panel', 'aria-labelledby': tabDomId(this.#active), tabindex: '0', class: 'wrap' },
      this.#active === OVERVIEW ? this.#overview(st) : this.#board(st, this.#active), fine());
    const tablist = h('div', { role: 'tablist', 'aria-label': 'Streams', class: 'wrap' }, ...tabs);
    // A nav landmark, so the tab bar is not stray content between the header and main (axe: region).
    const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Stream tabs' }, tablist);
    this.#root.replaceChildren(this.#header(st), tabbar, h('main', {}, panel));
    this.#watchTabOverflow(tabbar, tablist);
    showCue(this.#waiting(st));
  }

  /**
   * On a narrow screen the tabs scroll sideways. Keep the selected tab in view, and fade whichever edge has more tabs
   * past it, so it is visible that the row scrolls (the scrollbar itself is hidden).
   */
  #watchTabOverflow(tabbar: HTMLElement, tablist: HTMLElement): void {
    this.#tabsObserver?.disconnect();
    const selected = tablist.querySelector<HTMLElement>('[aria-selected=true]');
    const update = (): void => {
      const max = tablist.scrollWidth - tablist.clientWidth;
      tabbar.classList.toggle('more-start', max > 1 && tablist.scrollLeft > 1);
      tabbar.classList.toggle('more-end', max > 1 && tablist.scrollLeft < max - 1);
    };
    const reveal = (): void => {
      if (!selected) return;
      const pad = 48;   // clear of the faded edge
      const left = selected.offsetLeft - tablist.offsetLeft;
      const right = left + selected.offsetWidth;
      if (left - pad < tablist.scrollLeft) tablist.scrollLeft = Math.max(0, left - pad);
      else if (right + pad > tablist.scrollLeft + tablist.clientWidth) tablist.scrollLeft = right + pad - tablist.clientWidth;
    };
    tablist.addEventListener('scroll', update, { passive: true });
    this.#tabsObserver = new ResizeObserver(() => { reveal(); update(); });
    this.#tabsObserver.observe(tablist);
  }

  /** Asks that really need you: on sample data none do, so the tab title, favicon and baton tip never cue from a fixture. */
  #waiting(st: PodiumState): number { return this.#sources.state === 'server' ? st.asks.length : 0; }

  get #live(): boolean { return this.#sources.state === 'server' && this.#sources.charts === 'server'; }

  #header(st: PodiumState): HTMLElement {
    const note = this.#live && this.#dropped === 0 ? '' : describeSources(this.#sources.state, this.#sources.charts, this.#dropped, st.generatedAt);
    // The cue line follows the tab, so its counts always match the panel below it; the scope line says which.
    const stream = this.#active === OVERVIEW ? null : this.#active;
    const pick = <T extends { stream: string }>(xs: T[]): T[] => (stream === null ? xs : xs.filter((x) => x.stream === stream));
    const scope = stream === null ? 'All streams' : stream;
    const { tempo, rule } = this.#tempo({ asks: pick(st.asks).length, blocked: pick(st.blocked).length, working: pick(st.working).length });
    const cue = cueParts({ asks: pick(st.asks), blocked: pick(st.blocked), done: pick(st.done), working: pick(st.working) })
      .map((p) => h('li', { class: `tone-${p.tone}${p.n === 0 ? ' zero' : ''}` }, h('span', { class: 'n' }, String(p.n)), p.label));
    return h('header', { class: 'wrap' },
      h('div', { class: 'top' },
        h('div', { class: 'brand' }, h('h1', {}, baton(this.#waiting(st) > 0), 'Podium'), h('span', { class: 'date' }, h('span', { class: 'long' }, longDate(st.today)), h('span', { class: 'short' }, shortDate(st.today)))),
        h('div', { class: 'brand' }, this.#freshness(st), this.#link())),
      note ? h('p', { class: 'source' }, note) : null,
      h('p', { class: 'scope' }, h('span', { id: 'scope' }, scope), h('span', { 'aria-hidden': 'true' }, ' · '), tempo),
      h('ul', { class: 'cue', role: 'list', 'aria-labelledby': 'scope' }, ...cue),
      rule);
  }

  /** The tempo word for the scope's counts, as a button that opens the rule behind it in place (no tooltip, no modal). */
  #tempo(counts: { asks: number; blocked: number; working: number }): { tempo: HTMLElement; rule: HTMLElement } {
    const t = tempoWord(counts);
    // The rule, with each tempo word in the score's italic and the one in force now set in primary ink.
    const scale = TEMPO_SCALE.flatMap((x, i) => [i > 0 ? '; ' : '', h('i', { lang: x.lang, class: x.word === t.word ? 'now' : undefined }, x.word), `, ${x.meaning}`]);
    const rule = h('p', { class: 'tempo-rule', id: 'tempo-rule', hidden: !this.#tempoOpen }, TEMPO_LEAD, ...scale, '.');
    const tempo = h('button', { type: 'button', class: 'tempo', 'aria-expanded': String(this.#tempoOpen), 'aria-controls': 'tempo-rule' },
      h('i', { lang: t.lang }, t.word), h('span', { class: 'vh' }, ', what the tempo means'));
    tempo.addEventListener('click', () => {
      this.#tempoOpen = !this.#tempoOpen;
      tempo.setAttribute('aria-expanded', String(this.#tempoOpen));
      rule.hidden = !this.#tempoOpen;
    });
    return { tempo, rule };
  }

  /** The data-source pill: sample data, or live with its update time, flagged once the data is past STALE_MINUTES. */
  #freshness(st: PodiumState, tick = false): HTMLElement {
    const updated = clockTime(st.generatedAt, st.tz);
    const { age, stale } = freshness(st.generatedAt, Date.now());
    const live = this.#live;
    const text = !live ? `Sample data${updated ? ` · as of ${updated}` : ''}`
      : stale ? `Stale · updated ${updated}${age ? `, ${age} ago` : ''}. Reload for current data.`
        : null;
    // Live and fresh: "Live · updated 2:05 pm", with "updated" dropped on a phone so the pill shares the brand's line.
    const body: (Node | string)[] = text !== null ? [text] : updated ? ['Live · ', h('span', { class: 'short-hide' }, 'updated '), updated] : ['Live'];
    // The dot is a metronome: it ticks once each time this pill is redrawn while the data is fresh, and stops (warning
    // colour, no tick) once it is stale. Not a live region: a once-a-minute announcement would nag.
    const ticking = tick && live && !stale;
    return h('p', { class: `fresh${live ? (stale ? ' stale' : ' live') : ''}` },
      h('span', { class: `dot${ticking ? ' tick' : ''}`, 'aria-hidden': 'true' }), h('span', {}, ...body));
  }

  #updateFreshness(): void {
    const st = this.#state;
    const old = this.#root.querySelector('.fresh');
    if (st && old) old.replaceWith(this.#freshness(st, true));
  }

  /** Whether updates arrive by the live stream, by polling, or not at all; hidden for sample data and before the first answer. */
  #link(): HTMLElement {
    const st = this.#liveStatus;
    return h('span', { class: `link${st === 'offline' ? ' offline' : ''}`, role: 'status' }, liveLabel(st, this.#gate.held));
  }

  #updateLink(): void {
    const old = this.#root.querySelector('.link');
    if (old) old.replaceWith(this.#link());
  }

  #board(st: PodiumState, stream: string): Node {
    const board = h('stream-board', { stream });
    board.live = this.#sources.state === 'server';
    board.state = st;
    board.home = this.#homes.get(stream) ?? null;
    if (board.live) void this.#loadHome(stream, board);
    return board;
  }

  /** Fetch the stream's home base and hand it to the board that asked; a board redrawn in the meantime is a different element and is left alone. */
  async #loadHome(stream: string, board: HTMLElementTagNameMap['stream-board']): Promise<void> {
    const got = await loadHome(stream);
    if (!got) return;
    this.#homes.set(stream, got.data);
    if (board.isConnected) board.home = got.data;
  }

  #overview(st: PodiumState): Node {
    const ctx = { now: st.generatedAt, tz: st.tz, showStream: true, prs: st.prs };
    const pri = st.priorities;
    const editable = this.#sources.state === 'server';
    const stale = pri.state === 'stale' && pri.date !== st.today;
    const note = stale
      ? `Priorities are from ${longDate(pri.date) || pri.date}. ${editable ? `Add one to start today's list.` : `Set today's with journal.ts priorities set.`}`
      : 'No priorities set for today.';
    const priorities = h('priority-list');
    priorities.data = { items: pri.state === 'ok' ? pri.items : [], max: st.prioritiesMax, streams: st.streams, editable, note };
    const asks = askCards(st.asks, this.#sources.state === 'server', true, askPreview());
    const frag = fragmentFor(st.fragments, OVERVIEW);
    const md = frag ? h('md-fragment') : null;
    if (md && frag) md.markdown = frag;
    return h('div', {},
      h('div', { class: 'board' },
        h('div', { class: 'col' },
          section({ title: 'Needs you', n: st.asks.length, glyph: '●', tone: 'accent', empty: 'Nothing needs you right now.', rest: RESTS.asks, hint: askHint(this.#sources.state === 'server'), action: asks?.more }, asks?.list ?? null),
          section({ title: 'Blocked', n: st.blocked.length, glyph: '⊘', tone: 'critical', empty: 'Nothing is blocked.', rest: RESTS.blocked }, itemRows(st.blocked, ctx)),
          section({ title: 'Shipped today', n: st.done.length, glyph: '✓', tone: 'success', empty: 'Nothing shipped yet today.', rest: RESTS.shipped }, itemRows(st.done, ctx))),
        h('div', { class: 'col' },
          section({ title: `Today's priorities`, n: 0, tone: 'neutral', empty: note, quiet: true }, priorities),
          section({ title: 'In flight', n: st.working.length, tone: 'neutral', empty: 'Nothing in flight.', rest: RESTS.working, quiet: true }, itemRows(st.working, ctx)),
          section({ title: 'Streams', n: 0, tone: 'neutral', empty: 'No streams yet.', quiet: true }, this.#counts(st)))),
      h('div', { class: 'wide' },
        section({ title: 'Trends', n: 0, tone: 'neutral', empty: 'No chart data.', quiet: true }, this.#chartGrid()),
        md ? section({ title: 'Notes', n: 0, tone: 'neutral', empty: '', quiet: true }, md) : null));
  }

  #counts(st: PodiumState): Node | null {
    if (st.footer.length === 0) return null;
    const cell = (n: number): HTMLElement => h('td', { class: n === 0 ? 'z' : undefined }, String(n));
    // The table scrolls sideways on a narrow screen, so its wrapper is a focusable, named region: arrow keys can scroll it.
    return h('div', { class: 'table-wrap', role: 'region', tabindex: '0', 'aria-label': 'Counts per stream' }, h('table', { class: 'counts' }, h('caption', { class: 'vh' }, 'Counts per stream'),
      h('thead', {}, h('tr', {}, ...['Stream', 'Need you', 'Working', 'Queued', 'Blocked', 'Done'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, ...st.footer.map((f) => h('tr', {}, h('th', { scope: 'row' }, streamTag(f.stream)),
        ...[f.asks, f.working, f.queued, f.blocked, f.done].map(cell))))));
  }

  #chartGrid(): Node | null {
    const c = this.#charts;
    if (!c) return null;
    const mk = (kind: ChartKind, title: string, data: ChartData): HTMLElement => {
      const el = h('podium-chart', { kind, label: title });
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

/**
 * The end of the panel, as a score ends: Fine, then the final double barline (thin, then thick, read left to right), so
 * the foot of the page says there is nothing more below.
 */
function fine(): HTMLElement {
  return h('p', { class: 'fine' },
    h('i', { lang: 'it' }, 'Fine'),
    s('svg', { class: 'barline', viewBox: '0 0 10 20', width: '10', height: '20', 'aria-hidden': 'true', focusable: 'false' },
      s('rect', { x: '0', y: '0', width: '1.5', height: '20' }), s('rect', { x: '5', y: '0', width: '4', height: '20' })));
}

/**
 * The wordmark's baton, drawn with presentation attributes only (no style attribute, so the CSP holds). Its tip is a
 * tiny cue of its own: accent while asks need you, muted when none do. Decorative: the h1's text names the page.
 */
function baton(cue: boolean): SVGSVGElement {
  return s('svg', { class: 'baton', viewBox: '4 4 24 24', 'aria-hidden': 'true', focusable: 'false' },
    s('g', { class: 'stick' },
      s('path', { d: 'M7.9 21.3 23.5 7.5 24.5 8.5 10.7 24.1Z', fill: 'currentColor' }),
      s('ellipse', { cx: '9.4', cy: '22.6', rx: '4.4', ry: '2.5', transform: 'rotate(-45 9.4 22.6)', fill: 'currentColor' }),
      s('circle', { class: `tip${cue ? ' on' : ''}`, cx: '24', cy: '8', r: cue ? '3.4' : '1.8' })));
}

/**
 * Put the needs-you count where a glance at the browser's tab strip finds it: the title reads "(n) Podium", and the
 * favicon swaps to the one with an accent tip. Counts every stream, whichever tab is open.
 */
function showCue(asks: number): void {
  document.title = cueTitle(asks);
  const icon = document.querySelector<HTMLLinkElement>('link[rel=icon]');
  const href = asks > 0 ? '/favicon-cue.svg' : '/favicon.svg';
  if (icon && icon.getAttribute('href') !== href) icon.setAttribute('href', href);
}

/** True while the focused field (looked for through nested shadow roots) holds text: an answer being typed there. */
function typingAnAnswer(): boolean {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) && el.value !== '';
}

/** A DOM id for a tab: stream names are data and may hold spaces, which would split an IDREF list. */
function tabDomId(id: string): string {
  return `tab-${encodeURIComponent(id)}`;
}

/** The loading state: the page's own shape in placeholder blocks, announced once as loading. */
function skeleton(): HTMLElement {
  const line = (w: string): HTMLElement => {
    const el = h('span', { class: 'sk sk-line', 'aria-hidden': 'true' });
    el.style.width = w;
    return el;
  };
  // The live region goes in empty and is filled a moment later, so screen readers announce it.
  const said = h('span', { class: 'vh' });
  setTimeout(() => { said.textContent = 'Loading the board'; }, 50);
  // Rows like the board's own: an id chip and a line of text over a hairline, so the real rows land where these were.
  const rows = (widths: string[]): HTMLElement => h('span', { class: 'sk-rows' },
    ...widths.map((w) => h('span', { class: 'sk-row' }, h('span', { class: 'sk sk-id' }), line(w))));
  return h('div', { role: 'status' },
    said,
    h('div', { class: 'wrap sk-head', 'aria-hidden': 'true' }, line('150px'), h('span', { class: 'sk-scope' }, line('96px')), staff()),
    h('div', { class: 'sk-tabs', 'aria-hidden': 'true' }, h('div', { class: 'wrap' }, line('72px'), line('104px'), line('56px'))),
    h('div', { class: 'wrap sk-panel', 'aria-hidden': 'true' },
      h('div', { class: 'board' },
        h('div', { class: 'sk-stack' }, line('120px'), h('span', { class: 'sk-hint' }, line('340px')), rows(['62%', '48%', '55%', '40%']), line('96px'), rows(['44%'])),
        h('div', { class: 'sk-stack' }, line('110px'), rows(['80%', '66%', '72%'])))));
}

/** The cue line's placeholder: a five-line staff with one note head gliding along it while the board loads. */
function staff(): HTMLElement {
  return h('span', { class: 'staff', 'aria-hidden': 'true' },
    ...[0, 1, 2, 3, 4].map(() => h('span', { class: 'staff-line' })),
    h('span', { class: 'glide' }, h('span', { class: 'note' })));
}

/** The error state: what failed, what to do, the detail, and a way to retry. */
function problem(title: string, e: unknown, hint: string): HTMLElement {
  const reload = h('button', { type: 'button', class: 'primary' }, 'Reload');
  reload.addEventListener('click', () => location.reload());
  return h('main', {}, h('h1', { class: 'vh' }, 'Podium'), h('div', { class: 'problem', role: 'alert' },
    h('h2', {}, title), h('p', {}, hint),
    h('p', { class: 'detail' }, e instanceof Error ? e.message : 'unknown error'),
    reload));
}

customElements.define('podium-app', PodiumApp);
