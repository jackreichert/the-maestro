import './stream-board.ts';
import './podium-chart.ts';
import './priority-list.ts';
import './local-review.ts';
import './open-prs.ts';
import { h, s, shadow } from './dom.ts';
import { BOARD_CSS, section } from './stream-board.ts';
import { describeSources, loadCharts, loadEpics, loadHome, loadLinkHosts, loadLocalReview, loadOpenPrs, loadProjects, loadRefreshStatus, loadState } from './api.ts';
import { UpdateGate, askState } from './ask-state.ts';
import type { GateInput } from './ask-state.ts';
import { findByKey, focusKeyOf, foldStates, keepAcross, restoreFolds } from './keep-view.ts';
import type { FocusKey } from './keep-view.ts';
import { LiveUpdates, liveLabel } from './live.ts';
import type { LiveStatus } from './live.ts';
import { TEMPO_LEAD, TEMPO_SCALE, cueParts, cueTitle, clockTime, freshness, longDate, scoped, shortDate, tempoWord } from './glance.ts';
import { DASHBOARD, OPEN_PRS, formatFragment, isAllStreams, tabStream, tileId, nextTab, parseFilter, parseFragment, tabIds } from './tabs.ts';
import { OpenPrsStore } from './open-prs-store.ts';
import { createPoster } from './write-token.ts';
import { HOME_TAB_CSS, homeTab } from './home-tab.ts';
import type { ProjectsLoad } from './home-tab.ts';
import { filteredView } from './filter-view.ts';
import type { CueKey } from './tabs.ts';
import type { Source } from './api.ts';
import type { AskBusyDetail, ChartsData, EpicsData, LocalReview, PodiumState, StreamHome } from './types.ts';

interface Fresh { state: PodiumState; charts: ChartsData; epics: EpicsData | null; local: LocalReview | null; projects: ProjectsLoad; dropped: number }

const CSS = `${BOARD_CSS}${HOME_TAB_CSS}
  .wrap { max-width: var(--grid-max); margin: 0 auto; padding-inline: var(--page-pad); }

  /* Off screen until it has focus, then the first thing on the page; fixed so no layout moves. */
  .skip { position: fixed; inset-block-start: -100px; inset-inline-start: var(--space-3); z-index: 10; padding: var(--space-2) var(--space-4); border-radius: var(--radius-sm); background: var(--accent); color: var(--on-accent); font-weight: var(--weight-semibold); text-decoration: none; }
  .skip:focus-visible { inset-block-start: var(--space-3); outline: 2px solid var(--focus); outline-offset: 2px; }

  header.topbar { position: sticky; top: 0; z-index: 20; background: var(--material-bar); -webkit-backdrop-filter: var(--material-blur); backdrop-filter: var(--material-blur); border-bottom: var(--hairline); }
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { header.topbar { background: var(--surface-page); } }
  header.topbar .bar { display: flex; align-items: center; gap: var(--space-5); min-height: 60px; }
  h1.wordmark { margin: 0; display: inline-flex; align-items: center; gap: var(--space-2); flex: none; font-family: var(--font-display); font-size: 1.75rem; line-height: 1; font-weight: var(--weight-regular); letter-spacing: -0.01em; white-space: nowrap; }
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
    background: none; border: 0; padding: 2px 4px; margin: -2px -4px; border-radius: var(--radius-xs); cursor: pointer;
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

  /* The headline count line is set in the display face: large numerals read first, words recede. One weight, so the
     count is marked by ink, not bold. A display size on the text line height keeps the header's measured height. */
  .cue { margin: var(--space-4) 0 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-4); padding: 0; list-style: none; font-family: var(--font-display); font-size: clamp(2.25rem, 4.4vw, 3.75rem); line-height: 1.08; letter-spacing: -0.02em; color: var(--text-muted); }
  .cue li { display: inline-flex; align-items: baseline; gap: var(--space-2); white-space: nowrap; color: var(--text-secondary); }
  button.tile {
    font: inherit; letter-spacing: inherit; color: inherit; background: none; border: 0; cursor: pointer;
    display: inline-flex; align-items: baseline; gap: var(--space-2); white-space: nowrap;
    padding: 0 var(--space-2); margin: 0 calc(-1 * var(--space-2)); border-radius: var(--radius-sm);
    transition: background-color var(--dur-fast) var(--ease-out);
  }
  @media (hover: hover) { button.tile:hover { background: var(--accent-soft); } }
  button.tile[aria-pressed=true] { background: var(--accent-soft); text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 0.2em; }
  .filter-bar { margin: 0 0 var(--space-4); display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  .cue .n { font-weight: var(--weight-regular); font-variant-numeric: tabular-nums; color: var(--text-primary); }
  .cue .zero, .cue .zero .n { color: var(--text-muted); font-weight: var(--weight-regular); }
  .cue .tone-accent:not(.zero) .n { color: var(--accent); }
  .cue .tone-critical:not(.zero) .n { color: var(--critical); }
  .cue .tone-success:not(.zero) .n { color: var(--success); }
  @media (max-width: 640px) { .cue { font-size: var(--text-2xl); line-height: var(--leading-xl); gap: var(--space-1) var(--space-4); } }

  .tabbar { flex: 1; min-width: 0; background: none; border: 0; }
  [role=tablist] { display: flex; align-items: center; gap: 2px; overflow-x: auto; scrollbar-width: none; }
  [role=tablist]::-webkit-scrollbar { display: none; }
  .more-end [role=tablist] { mask-image: linear-gradient(to right, black calc(100% - 56px), transparent); }
  .more-start [role=tablist] { mask-image: linear-gradient(to right, transparent, black 56px); }
  .more-start.more-end [role=tablist] { mask-image: linear-gradient(to right, transparent, black 56px, black calc(100% - 56px), transparent); }
  [role=tab] {
    position: relative; flex: none; display: inline-flex; align-items: center; gap: var(--space-2); min-height: 36px;
    padding: 0 var(--space-3); border: 0; border-radius: var(--radius-sm); background: none; cursor: pointer;
    font: inherit; font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-secondary); white-space: nowrap;
    transition: color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out);
  }
  @media (hover: hover) { [role=tab]:hover { color: var(--text-primary); background: var(--surface-2); } }
  [role=tab]:focus-visible { outline-offset: 2px; }
  [role=tab][aria-selected=true] { color: var(--text-primary); background: var(--surface-1); box-shadow: var(--shadow-1); }
  .nav-sep { width: 1px; height: 20px; background: var(--border); margin: 0 var(--space-2); flex: none; }
  .stream-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .s1 { background: var(--series-1); } .s2 { background: var(--series-2); } .s3 { background: var(--series-3); } .s4 { background: var(--series-4); }
  .s5 { background: var(--series-5); } .s6 { background: var(--series-6); } .s7 { background: var(--series-7); } .s8 { background: var(--series-8); }
  .so { background: var(--series-other); }
  .count { font-size: var(--text-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
  [role=tab][aria-selected=true] .count { color: var(--text-secondary); }
  .badge { min-width: 20px; min-height: 20px; padding: 0 6px; border-radius: var(--radius-pill); background: var(--accent-soft); color: var(--accent); font-size: var(--text-xs); line-height: 20px; font-weight: var(--weight-semibold); text-align: center; font-variant-numeric: tabular-nums; }
  .cue-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 400px); gap: var(--space-6) var(--space-7); align-items: start; padding-bottom: var(--space-6); border-bottom: var(--hairline); margin-bottom: var(--space-7); }
  .lede { margin: var(--space-4) 0 0; max-width: 62ch; font-size: var(--text-lg); line-height: var(--leading-lg); color: var(--text-secondary); }
  .lede strong { color: var(--text-primary); font-weight: var(--weight-semibold); }
  .stream-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2) var(--space-4); margin: 0 0 var(--space-3); }
  .stream-title h2 { margin: 0; display: inline-flex; align-items: center; gap: var(--space-3); font-size: var(--text-xl); font-weight: var(--weight-semibold); letter-spacing: -0.012em; }
  .stream-title .mark { width: 12px; height: 12px; border-radius: 3px; }
  .score { margin: 0 0 var(--space-7); }
  .score-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); padding-bottom: var(--space-3); border-bottom: var(--hairline); margin-bottom: var(--space-2); }
  .score-head h2 { margin: 0; font-size: var(--text-lg); font-weight: var(--weight-semibold); }
  .score-head span { font-size: var(--text-sm); color: var(--text-muted); }
  .score-row { display: grid; grid-template-columns: 168px minmax(0, 1fr); gap: var(--space-4); align-items: center; min-height: 52px; border-bottom: var(--hairline); }
  .score-name { display: inline-flex; align-items: center; gap: var(--space-2); font-weight: var(--weight-semibold); }
  .score-name i { width: 8px; height: 8px; border-radius: 2px; }
  .score-staff { display: grid; grid-template-columns: repeat(14, minmax(0, 1fr)); height: 36px; }
  .score-cell { position: relative; }
  .score-note { position: absolute; left: 50%; width: 9px; height: 7px; border-radius: 50%; transform: translateX(-50%) rotate(-20deg); }
  .score-note.p0 { bottom: 2px; } .score-note.p1 { bottom: 8px; } .score-note.p2 { bottom: 14px; } .score-note.p3 { bottom: 22px; } .score-note.p4 { bottom: 28px; }
  .score-rest { position: absolute; left: 50%; top: 12px; width: 8px; height: 3px; background: var(--text-muted); transform: translateX(-50%); opacity: 0.55; }
  @media (max-width: 900px) { .cue-grid { grid-template-columns: minmax(0, 1fr); } header.topbar .bar { gap: var(--space-3); } }

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
  table.counts th, table.counts td { padding: var(--space-2) var(--space-1); border-bottom: var(--hairline); text-align: right; white-space: nowrap; }
  table.counts thead th { color: var(--text-muted); font-weight: var(--weight-medium); font-size: var(--text-xs); line-height: var(--leading-xs); border-top: var(--hairline); white-space: normal; vertical-align: bottom; }
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
  .sk { display: block; border-radius: var(--radius-sm); background: var(--surface-2); animation: breathe var(--dur-breathe) var(--ease-in-out) infinite; }
  @keyframes breathe { 50% { opacity: 0.5; } }
  @media (prefers-reduced-motion: reduce) { .sk { animation: none; } }
  /* Offsets match the header's real metrics at rest (brand row, scope line, cue line, tab bar), so nothing jumps on load. */
  .sk-head { padding-block: 43px 0; }
  .sk-scope { display: block; margin-top: 47px; }
  .sk-scope + .staff { margin-top: 14px; }
  .sk-tabs { margin-top: 29px; border-bottom: var(--hairline); padding-block: 15px; }
  .sk-tabs .wrap { display: flex; gap: var(--space-6); }
  .sk-panel { padding-block: var(--space-6); }
  .sk-rows { display: block; border-top: var(--hairline); }
  .sk-row { display: flex; align-items: center; gap: var(--space-3); height: 41px; border-bottom: var(--hairline); }
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
  .glide { position: absolute; inset: 0; animation: glide var(--dur-breathe) var(--ease-in-out) infinite alternate; }
  .note { position: absolute; left: 0; top: 12.5px; width: 9px; height: 6px; border-radius: 50%; background: var(--text-muted); transform: rotate(-20deg); }
  @keyframes glide { to { transform: translateX(calc(100% - 9px)); } }
  @media (prefers-reduced-motion: reduce) { .glide { animation: none; } }
  @media (forced-colors: active) { .staff-line, .note { forced-color-adjust: none; background: CanvasText; } }
  .sk-stack { display: grid; gap: var(--space-4); align-content: start; }

  .problem { max-width: 60ch; margin: var(--space-8) auto; padding: var(--space-6); background: var(--surface-1); border-radius: var(--radius-lg); box-shadow: var(--shadow-1); }
  .problem h2 { margin: 0 0 var(--space-2); font-size: var(--text-lg); line-height: var(--leading-lg); }
  .problem h2::before { content: var(--glyph-critical); color: var(--critical); margin-right: var(--space-2); }
  .problem p { margin: 0 0 var(--space-4); color: var(--text-secondary); }
  .problem .detail { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--text-primary); background: var(--surface-2); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); overflow-wrap: anywhere; }
`;

/** <podium-app>: header with the cue line, Home, then one tab per stream. The active tab lives in the URL fragment. */
export class PodiumApp extends HTMLElement {
  #root: ShadowRoot;
  #state: PodiumState | null = null;
  #charts: ChartsData | null = null;
  // Open epics for the Board's rollups; null when the server gave none (sample data, an old server), which draws no epic lines.
  #epics: EpicsData | null = null;
  // The local review queue; null when the server gave none, which the panel says in words.
  #local: LocalReview | null = null;
  #sources: { state: Source; charts: Source } = { state: 'fixture', charts: 'fixture' };
  #dropped = 0;
  #active = DASHBOARD;
  // Home's project rows load after the board, so the page answers at once and the rows fill in.
  #projects: ProjectsLoad = { state: 'loading' };
  // The summary tile pressed, if any: the board shows only that bucket. It lives in the fragment beside the tab.
  #filter: CueKey | null = null;
  #tick: number | undefined;
  #tabsObserver: ResizeObserver | null = null;
  #tempoOpen = false;
  // The last home base each stream tab got, so a redraw shows it at once while the fresh one loads.
  readonly #homes = new Map<string, StreamHome>();
  // The Open PRs tab's table and refresh state live here, not in its element, so a live redraw does not lose a refresh in flight.
  readonly #poster = createPoster((u, i) => fetch(u, i));
  readonly #prs = new OpenPrsStore({
    load: loadOpenPrs,
    status: loadRefreshStatus,
    post: async () => (await this.#poster.post('/api/prs/refresh', {}))?.status ?? null,
    delay: (ms) => new Promise((ok) => { setTimeout(ok, ms); }),
  });
  #liveUpdates: LiveUpdates<Fresh> | null = null;
  #liveStatus: LiveStatus | null = null;
  // Newer data is held while a press is in flight or an answer is being typed, and shown when that ends. Drafts and settled
  // cards live in askState, so the redraw that follows puts them back.
  readonly #gate = new UpdateGate<Fresh>();
  // A stream tag link (or Back) changed the fragment: switch tabs, start the new tab at the top, and put focus on its
  // tab so keyboard and screen reader users are not left on the destroyed link.
  readonly #onHash = (): void => {
    const id = parseFragment(location.hash, this.#ids());
    const filter = parseFilter(location.hash);
    if (id === this.#active && filter === this.#filter) return;
    if (id === this.#active) { this.#setFilter(filter, null); return; }   // only the filter moved: stay where the reader is
    this.#filter = filter;
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
    Promise.all([loadState(), loadCharts(), loadEpics(), loadLocalReview(), loadLinkHosts()]).then(([s, c, e, lr]) => {
      if (!this.isConnected) return;   // removed while loading: start nothing that disconnectedCallback has already missed
      this.#state = s.data;
      this.#charts = c.data;
      this.#epics = s.source === 'server' ? e : null;
      this.#local = s.source === 'server' ? lr : null;
      this.#sources = { state: s.source, charts: c.source };
      this.#dropped = s.dropped + c.dropped;
      this.#active = parseFragment(location.hash, this.#ids());
      this.#filter = parseFilter(location.hash);
      this.#safeRender();
      // The data is loaded once; re-say its age every minute so a page left open shows when it has gone stale.
      this.#tick = window.setInterval(() => this.#updateFreshness(), 60_000);
      if (this.#live) this.#startLive(s.data.seq);   // sample data has no server to follow
      void projectsLoad(this.#live).then((p) => {
        if (!this.isConnected || this.#projects.state === 'ok') return;   // a live update got there first
        this.#projects = p;
        // Typing an answer holds the redraw; the next render (any tab switch or live update) shows the rows.
        if (this.#active === DASHBOARD && !this.#filter && !typingAnAnswer()) {
          const folds = foldStates(this.#root);
          keepAcross(this.#root, () => this.#safeRender());
          restoreFolds(this.#root, folds);
        }
      });
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
        const [s, c, e, lr, p] = await Promise.all([loadState(), loadCharts(), loadEpics(), loadLocalReview(), projectsLoad(true)]);
        return s.source === 'server' && c.source === 'server' ? { state: s.data, charts: c.data, epics: e, local: lr, projects: p, dropped: s.dropped + c.dropped } : null;
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
    this.#epics = f.epics;
    this.#local = f.local;
    this.#projects = f.projects;
    this.#dropped = f.dropped;
    askState.prune(f.state.asks.map((a) => a.id));
    if (!this.#ids().includes(this.#active)) this.#active = DASHBOARD;   // the stream behind the open tab is gone
    const focused = this.#focusKey();
    const folds = foldStates(this.#root);
    this.#safeRender();
    restoreFolds(this.#root, folds);   // the redraw reset every disclosure to its default; put each back as the reader left it
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
  // A card is mid-action (saving an answer): hold until it says it is done, however long the browser takes to answer.
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
    this.#release({ busy: false });   // this render replaces any card still saving, and its busy=false would never arrive
    this.#active = id;
    this.#writeFragment(id);
    this.#safeRender();
    if (focusTab) this.#root.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus();
  }

  #writeFragment(id: string): void {
    const next = formatFragment(id, this.#filter);
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  /** Show only one tile's items, or everything for null. A redraw destroys the tile, so focus goes back to `refocus`'s tile. */
  #setFilter(key: CueKey | null, refocus: CueKey | null): void {
    if (key === this.#filter) return;
    this.#release({ busy: false });   // this render replaces any card still saving
    this.#filter = key;
    this.#writeFragment(this.#active);
    this.#safeRender();
    if (refocus) this.#root.querySelector<HTMLElement>(`button.tile[data-key="${refocus}"]`)?.focus();
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
    const count = <T extends { stream: string }>(xs: T[], id: string): number => (isAllStreams(id) ? xs.length : xs.filter((x) => x.stream === tabStream(id)).length);
    const tabs = ids.flatMap((id, i) => {
      const on = id === this.#active;
      const stream = tabStream(id);
      const n = id === DASHBOARD || id === OPEN_PRS ? 0 : count(st.asks, id);
      const prs = id === OPEN_PRS ? st.prs.length : 0;
      const label = id === DASHBOARD ? 'Home' : id === OPEN_PRS ? 'Open PRs' : stream ?? id;
      const tab = h('button', {
        type: 'button', role: 'tab', id: tabDomId(id), 'aria-selected': String(on), 'aria-controls': 'panel',
        tabindex: on ? '0' : '-1',
      },
      stream ? h('span', { class: `stream-dot ${seriesClass(stream)}`, 'aria-hidden': 'true' }) : null,
      label,
      prs > 0 ? h('span', { class: 'count' }, String(prs)) : null,
      n > 0 ? h('span', { class: 'count' }, String(n), h('span', { class: 'vh' }, ' awaiting')) : null);
      tab.addEventListener('click', () => this.#select(id, true));
      tab.addEventListener('keydown', (e) => {
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;   // leave browser shortcuts such as Alt+Left alone
        const next = nextTab(e.key, ids, this.#active);
        if (next === null) return;
        e.preventDefault();
        this.#select(next, true);
      });
      const sep = i === 1 ? h('span', { class: 'nav-sep', 'aria-hidden': 'true' }) : null;
      return [tab, sep];
    });
    const stream = tabStream(this.#active);
    const panel = h('div', { role: 'tabpanel', id: 'panel', 'aria-labelledby': tabDomId(this.#active), tabindex: '0', class: 'wrap page' },
      this.#active === OPEN_PRS ? null : this.#pageHead(st, stream),
      this.#filter ? this.#filtered(st, this.#filter) : this.#active === DASHBOARD ? this.#home(st) : this.#active === OPEN_PRS ? this.#openPrs(st) : this.#board(st, stream ?? ''),
      fine());
    const tablist = h('div', { role: 'tablist', 'aria-label': 'Podium' }, ...tabs);
    const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Podium' }, tablist);
    this.#root.replaceChildren(this.#skipLink(panel), this.#topbar(st, tabbar), h('main', {}, panel));
    this.#watchTabOverflow(tabbar, tablist);
    showCue(this.#waiting(st));
  }

  /**
   * The first tab stop: jumps past the header and tab bar to the open panel. A fragment link cannot reach into a shadow
   * root (and the fragment holds the active tab), so the click moves focus itself and leaves the URL alone.
   */
  #skipLink(panel: HTMLElement): HTMLElement {
    const skip = h('a', { class: 'skip', href: `#${panel.id}` }, 'Skip to the board');
    skip.addEventListener('click', (e) => { e.preventDefault(); panel.focus(); });
    return skip;
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

  #topbar(st: PodiumState, nav: HTMLElement): HTMLElement {
    const note = this.#live && this.#dropped === 0 ? '' : describeSources(this.#sources.state, this.#sources.charts, this.#dropped, st.generatedAt);
    return h('header', { class: 'topbar' },
      h('div', { class: 'wrap bar' },
        h('h1', { class: 'wordmark' }, baton(this.#waiting(st) > 0), 'Podium'),
        nav,
        this.#freshness(st),
        this.#link()),
      note ? h('p', { class: 'source wrap' }, note) : null);
  }

  /** The cue line for Home and a stream tab. Open PRs draws its own. Counts follow the open tab. */
  #pageHead(st: PodiumState, stream: string | null): HTMLElement {
    const scope = stream === null ? 'All streams' : stream;
    const buckets = scoped(st, stream);
    const { tempo, rule } = this.#tempo({ asks: buckets.asks.length, blocked: buckets.blocked.length, working: buckets.working.length });
    const parts = cueParts(buckets);
    const cue = parts.map((p) => {
      const tile = h('button', { type: 'button', class: 'tile', id: tileId(p.key), 'data-key': p.key, 'aria-pressed': String(p.key === this.#filter) },
        h('span', { class: 'n' }, String(p.n)), ' ', p.label);
      tile.addEventListener('click', () => this.#setFilter(p.key === this.#filter ? null : p.key, p.key));
      return h('li', { class: `tone-${p.tone}${p.n === 0 ? ' zero' : ''}` }, tile);
    });
    const oldest = Math.max(0, ...buckets.asks.map((a) => a.ageDays));
    const stale = buckets.asks.filter((a) => a.ageDays > 3).length;
    const oneWay = buckets.asks.filter((a) => a.door === 'one-way').length;
    const queued = st.queued.filter((q) => stream === null || q.stream === stream).length;
    const lead = h('div', {},
      stream ? h('div', { class: 'stream-title' }, h('h2', {}, h('span', { class: `mark ${seriesClass(stream)}`, 'aria-hidden': 'true' }), stream)) : null,
      h('p', { class: 'scope' }, h('span', { id: 'scope' }, scope), h('span', { 'aria-hidden': 'true' }, ' · '), tempo, h('span', { class: 'date' }, ` · ${longDate(st.today) || shortDate(st.today)}`)),
      h('ul', { class: 'cue', role: 'list', 'aria-labelledby': 'scope' }, ...cue),
      rule,
      buckets.asks.length ? h('p', { class: 'lede' }, 'The oldest ask has waited ', h('strong', {}, `${oldest} ${oldest === 1 ? 'day' : 'days'}`), stale ? `, and ${stale} ${stale === 1 ? 'is' : 'are'} past the 3 day mark` : '', '. ', oneWay ? `${oneWay} ${oneWay === 1 ? 'is a one-way door' : 'are one-way doors'}. ` : '', `${queued} ${queued === 1 ? 'task is' : 'tasks are'} queued behind your answers.`) : null);
    if (stream !== null || this.#filter) return lead;
    return h('section', { class: 'cue-grid' }, lead, this.#priorities(st));
  }

  #priorities(st: PodiumState): HTMLElement {
    const pri = st.priorities;
    const editable = this.#sources.state === 'server';
    const stale = pri.state === 'stale' && pri.date !== st.today;
    const note = stale
      ? `Priorities are from ${longDate(pri.date) || pri.date}. ${editable ? 'Add one to start today\'s list.' : 'Set today\'s with journal.ts priorities set.'}`
      : 'No priorities set for today.';
    const priorities = h('priority-list');
    priorities.data = { items: pri.state === 'ok' ? pri.items : [], max: st.prioritiesMax, streams: st.streams, editable, note, epics: this.#epics ? Object.fromEntries(this.#epics.streams.map((g) => [g.stream, g.epics])) : {} };
    return priorities;
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
    const prAt = st.prData.fetchedAt ? clockTime(st.prData.fetchedAt, st.tz) : '';
    const text = !live ? `Sample data${updated ? ` · as of ${updated}` : ''}`
      : stale ? `Stale · updated ${updated}${age ? `, ${age} ago` : ''}. Reload for current data.`
        : null;
    const body: (Node | string)[] = text !== null
      ? [text]
      : [updated ? `Updated ${updated}` : 'Updated', h('span', { class: 'short-hide' }, prAt ? ` · PR data ${prAt}` : ' · PR data unavailable')];
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

  /** The pressed tile's bucket for the open tab, from the same scoped buckets the tile counts. */
  #filtered(st: PodiumState, key: CueKey): Node {
    const stream = tabStream(this.#active);
    const label = cueParts(scoped(st, stream)).find((p) => p.key === key)?.label ?? key;
    return filteredView(scoped(st, stream), key, label, {
      live: this.#sources.state === 'server',
      ctx: { now: st.generatedAt, tz: st.tz, showStream: stream === null, prs: st.prs },
      clear: () => this.#setFilter(null, key),
    });
  }

  /** The Open PRs tab. Its data comes from the page's own store; a live update redraws the table in place and never starts a refresh. */
  #openPrs(st: PodiumState): Node {
    const el = h('open-prs');
    el.tz = st.tz;
    el.model = this.#prs.model;
    el.onRefresh = () => { void this.#prs.refresh(); };
    const unsubscribe = this.#prs.subscribe(() => {
      if (!el.isConnected) { unsubscribe(); return; }
      el.model = this.#prs.model;
    });
    if (this.#sources.state === 'server') void this.#prs.load();   // each draw asks again, so the tab never shows older data than the cache holds
    return el;
  }

  /** The landing tab (its id stays `dashboard`, so old links keep working). Asks answer in place; everything else links on. */
  #home(st: PodiumState): Node {
    const localList = h('local-review');
    localList.review = this.#local;
    return h('div', { class: 'home-plus' },
      scoreBoard(st, this.#charts),
      homeTab(st, this.#charts, { live: this.#sources.state === 'server', projects: this.#projects }),
      section({ title: 'Waiting for local review', n: this.#local?.units.length ?? 0, tone: 'neutral', empty: 'No local branch is waiting for review.', quiet: true }, localList));
  }
}

const NAMED_SERIES: Record<string, string> = { TeamSelect: 's1', Bayada: 's2', Security: 's3', Options: 's4', Maestro: 's5', ADLs: 's6', Mithril: 's7', other: 'so' };
const SERIES = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];

/** A stable series slot for a stream, matching the design's known names and hashing the rest. */
function seriesClass(name: string): string {
  const named = NAMED_SERIES[name];
  if (named) return named;
  let n = 0;
  for (const c of name) n = (n * 33 + c.charCodeAt(0)) >>> 0;
  return SERIES[n % SERIES.length] ?? 's1';
}

/** One staff per stream for the last 14 chart days. Pitch is a few steps, not a computed pixel, so no inline style is needed. */
function scoreBoard(st: PodiumState, charts: ChartsData | null): HTMLElement | null {
  if (!charts?.throughput.length || st.streams.length === 0) return null;
  const days = charts.days.slice(-14);
  if (!days.length) return null;
  const byDate = new Map(charts.throughput.map((t) => [t.date, t.byStream]));
  const value = (stream: string, day: string): number => byDate.get(day)?.[stream] ?? 0;
  const max = Math.max(1, ...st.streams.flatMap((s) => days.map((d) => value(s, d))));
  const pitch = (n: number): string => (n <= 0 ? '' : `p${Math.min(4, Math.round((n / max) * 4))}`);
  const rows = st.streams.map((stream) => h('div', { class: 'score-row' },
    h('span', { class: 'score-name' }, h('i', { class: seriesClass(stream), 'aria-hidden': 'true' }), stream),
    h('span', { class: 'score-staff', role: 'img', 'aria-label': `${stream}: ${days.map((d) => `${d} ${value(stream, d)}`).join(', ')}` },
      ...days.map((d) => {
        const n = value(stream, d);
        return h('span', { class: 'score-cell' }, n ? h('span', { class: `score-note ${pitch(n)} ${seriesClass(stream)}` }) : h('span', { class: 'score-rest' }));
      }))));
  return h('section', { class: 'score', 'aria-label': 'Streams, last 14 days' },
    h('div', { class: 'score-head' }, h('h2', {}, 'Streams, last 14 days'), h('span', {}, 'Higher notes mean more finished that day.')),
    ...rows);
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

/** The projects payload as Home's load state: a failure is shown in the sections that need it, never thrown, and on a live page never replaced by sample data. */
function projectsLoad(live: boolean): Promise<ProjectsLoad> {
  return loadProjects(live).then((p): ProjectsLoad => ({ state: 'ok', data: p.data }), (e: unknown): ProjectsLoad => ({ state: 'error', message: e instanceof Error ? e.message : 'unknown error' }));
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
